// dailySnapshot.js
// Captures a compact daily snapshot of RIC's key numbers and persists it,
// so the weekly recap (and any future trend feature) has real history to
// read back — server.js itself has NO persistence today; every endpoint
// recomputes live, per request, with nothing surviving past the response.
//
// Captured once per business day, intended to run automatically ~2am ET
// (after close, covering the day that just ended) via
// scheduleNightlySnapshot(). Also callable on demand for backfill/testing.
//
// deps required: { getGoTabToken, goTabQuery, fetchWithRetry,
//   GOTAB_LOCATION_UUID, normalizeGoTab, nextDay, fetch7Shifts,
//   fetchTripleSeat, fetchMailchimp, fetchYelp } — all already exist in
// server.js; fetchTripleSeat/fetchMailchimp/fetchYelp need adding to
// app.locals alongside the existing GoTab/7Shifts wiring.

import { readJSON, writeJSON } from './storage.js';
import { getCachedBaseline } from './primeCostTrend.js';

const SNAPSHOT_KEY_PREFIX = 'ric_daily_snapshot_';
const SNAPSHOT_INDEX_KEY = 'ric_daily_snapshot_index';

function snapshotKey(dateStr) {
  return `${SNAPSHOT_KEY_PREFIX}${dateStr}`;
}

function addToIndex(dateStr) {
  const index = readJSON(SNAPSHOT_INDEX_KEY, []);
  if (!index.includes(dateStr)) {
    index.push(dateStr);
    index.sort();
    writeJSON(SNAPSHOT_INDEX_KEY, index);
  }
}

export function getSnapshotIndex() {
  return readJSON(SNAPSHOT_INDEX_KEY, []);
}

export function getSnapshot(dateStr) {
  return readJSON(snapshotKey(dateStr), null);
}

// Returns whatever snapshots exist for the last N calendar days (missing
// days are simply omitted, not padded with nulls — callers should treat a
// short list as "less history available yet", not an error).
export function getRecentSnapshots(days = 7) {
  const dates = [];
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates
    .map((d) => getSnapshot(d))
    .filter((s) => s != null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// deps: see file header. Captures dateStr (defaults to "yesterday" in ET,
// i.e. the most recently completed business day at the time this normally
// runs, ~2am ET).
export async function captureSnapshot(deps, dateStr) {
  const targetDate = dateStr || defaultTargetDate();

  const [goTabResult, shiftsResult, tsResult, mcResult, yelpResult] = await Promise.allSettled([
    deps.getGoTabToken()
      .then((token) => deps.fetchWithRetry('https://gotab.io/api/v2/graph', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(deps.goTabQuery(deps.GOTAB_LOCATION_UUID, targetDate, deps.nextDay(targetDate))),
      }))
      .then((r) => r.json())
      .then((d) => deps.normalizeGoTab(d?.data?.locations?.[0]?.tabs || [])),
    deps.fetch7Shifts(targetDate),
    deps.fetchTripleSeat ? deps.fetchTripleSeat() : Promise.reject(new Error('fetchTripleSeat not wired')),
    deps.fetchMailchimp ? deps.fetchMailchimp() : Promise.reject(new Error('fetchMailchimp not wired')),
    deps.fetchYelp ? deps.fetchYelp() : Promise.reject(new Error('fetchYelp not wired')),
  ]);

  const netSales = goTabResult.status === 'fulfilled' ? goTabResult.value.net_sales : null;
  const laborCost = shiftsResult.status === 'fulfilled' ? shiftsResult.value.total_labor_cost : null;

  const baseline = getCachedBaseline();
  let primeCostPct = null;
  let cogsEstimated = null;
  if (netSales != null && laborCost != null && baseline) {
    cogsEstimated = +((netSales * baseline.cogs_pct) / 100).toFixed(2);
    primeCostPct = netSales > 0 ? +(((cogsEstimated + laborCost) / netSales) * 100).toFixed(1) : null;
  }

  const snapshot = {
    date: targetDate,
    net_sales: netSales,
    labor_cost: laborCost,
    cogs_estimated: cogsEstimated,
    prime_cost_pct: primeCostPct,
    prime_cost_baseline_source: baseline?.source || null,
    tripleseat: tsResult.status === 'fulfilled' ? {
      confirmed_revenue: tsResult.value.confirmed_revenue,
      tentative_revenue: tsResult.value.tentative_revenue,
      total_pipeline: tsResult.value.total_pipeline,
      open_leads: tsResult.value.open_leads,
      event_count_upcoming: tsResult.value.event_count_upcoming,
    } : null,
    mailchimp: mcResult.status === 'fulfilled' ? {
      open_rate_30d: mcResult.value.open_rate_30d,
      net_list_growth_30d: mcResult.value.net_list_growth_30d,
    } : null,
    yelp: yelpResult.status === 'fulfilled' ? {
      rating: yelpResult.value.rating,
      review_count: yelpResult.value.review_count,
    } : null,
    sources_failed: [goTabResult, shiftsResult, tsResult, mcResult, yelpResult]
      .map((r, i) => (r.status === 'rejected' ? ['gotab', '7shifts', 'tripleseat', 'mailchimp', 'yelp'][i] : null))
      .filter(Boolean),
    captured_at: new Date().toISOString(),
  };

  writeJSON(snapshotKey(targetDate), snapshot);
  addToIndex(targetDate);
  return snapshot;
}

// "Yesterday" in US Eastern time — this runs after midnight ET, capturing
// the business day that just closed.
function defaultTargetDate() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  nowET.setDate(nowET.getDate() - 1);
  return nowET.toISOString().slice(0, 10);
}

// In-process nightly scheduler — checks every 15 minutes whether it's
// ~2am ET and today's snapshot hasn't been captured yet. No external cron
// needed; this runs as long as the server process is running (which is
// always, since it's a live web service). Deliberately simple over
// precise: a 15-minute check window means capture happens sometime in the
// 2:00–2:15am ET range, which is fine for this purpose.
export function scheduleNightlySnapshot(deps, { checkIntervalMs = 15 * 60 * 1000 } = {}) {
  async function tick() {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const hour = nowET.getHours();
      if (hour !== 2) return; // only fire in the 2am ET window

      const yesterday = defaultTargetDate();
      if (getSnapshot(yesterday)) return; // already captured today

      console.log(`[dailySnapshot] capturing snapshot for ${yesterday}`);
      await captureSnapshot(deps, yesterday);
      console.log(`[dailySnapshot] snapshot captured for ${yesterday}`);
    } catch (err) {
      console.error('[dailySnapshot] nightly capture failed:', err.message);
    }
  }

  tick(); // in case the server restarts right in the 2am window
  return setInterval(tick, checkIntervalMs);
}
