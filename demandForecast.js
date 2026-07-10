// demandForecast.js
// Stage 1: Demand forecast (covers), interim version using GoTab historicals
// since OpenTable integration is on hold. Swappable seam — once OpenTable is
// live, only the covers-fetching source changes; stages 2-5 don't change shape.
//
// Covers source: same tab-count approximation used in pmix.js, for
// consistency (a tab isn't necessarily one cover — see gotabAdapter.js note).
// Once OpenTable is live, or a real GoTab guest-count field is confirmed,
// swap the source function below.

import { readJSON, writeJSON } from './storage.js';

const FORECAST_KEY = 'ppc_demand_forecast';
const BASELINE_WEEKS = 8;
const TREND_WEEKS = 3;

// dailyCovers: [{ date, dayOfWeek(0-6), covers }]
export function buildDowBaseline(dailyCovers) {
  const byDow = {};
  for (const d of dailyCovers) {
    if (!byDow[d.dayOfWeek]) byDow[d.dayOfWeek] = [];
    byDow[d.dayOfWeek].push({ date: d.date, covers: d.covers });
  }
  const baseline = {};
  for (const dow of Object.keys(byDow)) {
    const entries = byDow[dow].slice(-BASELINE_WEEKS);
    const avg = entries.reduce((s, e) => s + e.covers, 0) / entries.length;
    baseline[dow] = avg;
  }
  return baseline;
}

export function buildTrendMultiplier(dailyCovers) {
  const byDow = {};
  for (const d of dailyCovers) {
    if (!byDow[d.dayOfWeek]) byDow[d.dayOfWeek] = [];
    byDow[d.dayOfWeek].push({ date: d.date, covers: d.covers });
  }
  const trend = {};
  for (const dow of Object.keys(byDow)) {
    const entries = byDow[dow];
    const baselineEntries = entries.slice(-BASELINE_WEEKS);
    const recentEntries = entries.slice(-TREND_WEEKS);
    const baselineAvg = baselineEntries.reduce((s, e) => s + e.covers, 0) / baselineEntries.length;
    const recentAvg = recentEntries.reduce((s, e) => s + e.covers, 0) / recentEntries.length;
    trend[dow] = baselineAvg > 0 ? recentAvg / baselineAvg : 1;
  }
  return trend;
}

function applyAnomalies(forecastByDate, anomalies) {
  for (const a of anomalies) {
    const entry = forecastByDate[a.date];
    if (!entry) continue;
    entry.covers_expected += a.coversDelta || 0;
    entry.covers_high += Math.max(a.coversDelta || 0, 0);
    entry.reason_flags = entry.reason_flags || [];
    entry.reason_flags.push({ type: a.type, note: a.note });
  }
  return forecastByDate;
}

function bandWidthFor(trendMultiplier) {
  const disagreement = Math.abs(trendMultiplier - 1);
  const base = 0.08;
  return Math.min(base + disagreement, 0.35);
}

export function buildForecast(dailyCovers, datesToForecast, anomalies = []) {
  const baseline = buildDowBaseline(dailyCovers);
  const trend = buildTrendMultiplier(dailyCovers);

  const forecastByDate = {};
  for (const { date, dayOfWeek } of datesToForecast) {
    const base = baseline[dayOfWeek] || 0;
    const trendMult = trend[dayOfWeek] || 1;
    const expected = base * trendMult;
    const width = bandWidthFor(trendMult);

    forecastByDate[date] = {
      date,
      day_of_week: dayOfWeek,
      covers_low: Math.round(expected * (1 - width)),
      covers_expected: Math.round(expected),
      covers_high: Math.round(expected * (1 + width)),
      reason_flags: [],
    };
  }

  applyAnomalies(forecastByDate, anomalies);
  return Object.values(forecastByDate);
}

export async function generateAndCacheForecast(dailyCovers, datesToForecast, anomalies) {
  const forecast = buildForecast(dailyCovers, datesToForecast, anomalies);
  writeJSON(FORECAST_KEY, {
    generated_at: new Date().toISOString(),
    source: 'gotab_tab_count_approximation', // swap to 'opentable_informed' once integrated
    rows: forecast,
  });
  return forecast;
}

export function getCachedForecast() {
  return readJSON(FORECAST_KEY, { generated_at: null, source: null, rows: [] });
}

// Builds dailyCovers input from itemized GoTab checks (reuses gotabAdapter
// output rather than requiring a separate fetch) — one check per tab-day
// already gives us coverCount per date; this just reduces to the shape
// buildDowBaseline/buildTrendMultiplier expect.
export function dailyCoversFromChecks(checks) {
  return checks.map((c) => ({ date: c.date, dayOfWeek: c.dayOfWeek, covers: c.coverCount }));
}
