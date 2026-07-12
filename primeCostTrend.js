// primeCostTrend.js
// A daily-resolution prime cost trend, reconciling three sources with
// different real granularities instead of pretending they're all equally
// precise:
//   - Labor cost: REAL, daily (7Shifts already reports actual $ per day)
//   - Net sales: REAL, daily (GoTab, using the corrected date-bounded query)
//   - COGS: ESTIMATED, daily — QuickBooks only closes COGS monthly, and
//     MarginEdge's daily figure is unreliable due to invoice lag. This
//     applies the last FULLY CLOSED month's QB COGS % to each day's real
//     GoTab revenue. This is explicitly an estimate, not an actual, and
//     every output row says so — the goal is a directionally useful daily
//     trend line between month-end closes, not a false-precision number.
//
// deps required: { getGoTabToken, goTabQuery, fetchWithRetry,
//   GOTAB_LOCATION_UUID, fetch7Shifts, fetchQuickBooks, normalizeGoTab,
//   nextDay } — all of these already exist in server.js; fetch7Shifts and
// fetchQuickBooks need to be added to app.locals alongside the existing
// GoTab wiring (see README note).

import { readJSON, writeJSON } from './storage.js';

const BASELINE_KEY = 'ric_prime_cost_baseline';
const TREND_CACHE_KEY = 'ric_prime_cost_trend';

// Finds the most recently fully-closed calendar month (i.e., not the
// current in-progress month) and pulls QB's authoritative COGS %/labor %
// for it, to use as the estimation baseline.
function lastClosedMonthRange() {
  const now = new Date();
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDayOfPrevMonth = new Date(firstOfThisMonth.getTime() - 1);
  const firstDayOfPrevMonth = new Date(lastDayOfPrevMonth.getFullYear(), lastDayOfPrevMonth.getMonth(), 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { start: fmt(firstDayOfPrevMonth), end: fmt(lastDayOfPrevMonth) };
}

// deps: { fetchQuickBooks }
export async function refreshBaseline(deps) {
  const { start, end } = lastClosedMonthRange();
  const qb = await deps.fetchQuickBooks(start, end);

  const netSales = qb.income?.total_sales || 0;
  const cogsTotal = qb.cogs?.total || 0;
  const laborTotal = qb.total_labor || 0;

  if (netSales <= 0) {
    throw new Error(`No QuickBooks net sales found for baseline period ${start} to ${end} — cannot compute a COGS % baseline.`);
  }

  const baseline = {
    period_start: start,
    period_end: end,
    net_sales: netSales,
    cogs_total: cogsTotal,
    cogs_pct: +((cogsTotal / netSales) * 100).toFixed(2),
    labor_total: laborTotal,
    labor_pct: +((laborTotal / netSales) * 100).toFixed(2),
    prime_cost_pct: qb.prime_cost_pct || null,
    refreshed_at: new Date().toISOString(),
  };

  writeJSON(BASELINE_KEY, baseline);
  return baseline;
}

export function getCachedBaseline() {
  return readJSON(BASELINE_KEY, null);
}

// Fetches one day's real net sales (GoTab) — reuses the corrected
// date-bounded query, single day only (not the 7-day aggregate).
// deps: { getGoTabToken, goTabQuery, fetchWithRetry, GOTAB_LOCATION_UUID, normalizeGoTab, nextDay }
async function fetchDailyNetSales(deps, dateStr) {
  const token = await deps.getGoTabToken();
  const res = await deps.fetchWithRetry('https://gotab.io/api/v2/graph', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(deps.goTabQuery(deps.GOTAB_LOCATION_UUID, dateStr, deps.nextDay(dateStr))),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors) return null;
  const normalized = deps.normalizeGoTab(data?.data?.locations?.[0]?.tabs || []);
  return normalized.net_sales;
}

// deps: everything above + { fetch7Shifts }
export async function computeDailyPrimeCostTrend(deps, days = 14) {
  const baseline = getCachedBaseline();
  if (!baseline) {
    throw new Error('No baseline yet — call refreshBaseline first (needs last closed month from QuickBooks).');
  }

  const dates = [];
  const start = new Date();
  start.setDate(start.getDate() - days);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const rows = await Promise.all(dates.map(async (dateStr) => {
    const [netSales, shiftsData] = await Promise.allSettled([
      fetchDailyNetSales(deps, dateStr),
      deps.fetch7Shifts(dateStr),
    ]);

    const realNetSales = netSales.status === 'fulfilled' ? netSales.value : null;
    const realLaborCost = shiftsData.status === 'fulfilled' ? shiftsData.value?.total_labor_cost : null;

    if (realNetSales == null || realLaborCost == null) {
      return { date: dateStr, available: false };
    }

    const estimatedCogs = +((realNetSales * baseline.cogs_pct) / 100).toFixed(2);
    const primeCostDollars = +(estimatedCogs + realLaborCost).toFixed(2);
    const primeCostPct = realNetSales > 0 ? +((primeCostDollars / realNetSales) * 100).toFixed(1) : null;
    const laborPct = realNetSales > 0 ? +((realLaborCost / realNetSales) * 100).toFixed(1) : null;

    return {
      date: dateStr,
      available: true,
      net_sales: realNetSales,                 // ACTUAL
      labor_cost: realLaborCost,                // ACTUAL
      labor_pct: laborPct,                      // ACTUAL (derived from two actuals)
      cogs_estimated: estimatedCogs,            // ESTIMATED — see baseline.cogs_pct
      cogs_pct_baseline_used: baseline.cogs_pct, // the rate applied, for transparency
      prime_cost_estimated: primeCostDollars,   // partially estimated
      prime_cost_pct: primeCostPct,             // partially estimated
    };
  }));

  const result = {
    generated_at: new Date().toISOString(),
    baseline_period: `${baseline.period_start} to ${baseline.period_end}`,
    baseline_cogs_pct: baseline.cogs_pct,
    baseline_note: 'COGS %/$ in this trend are ESTIMATES using the last closed month\'s QuickBooks COGS rate applied to each day\'s real GoTab revenue. Labor is 100% actual (7Shifts). Replace with real COGS once available at daily granularity.',
    days: rows,
  };

  writeJSON(TREND_CACHE_KEY, result);
  return result;
}

export function getCachedTrend() {
  return readJSON(TREND_CACHE_KEY, { generated_at: null, days: [] });
}
