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
    source: 'quickbooks_auto',
    period_start: start,
    period_end: end,
    net_sales: netSales,
    cogs_total: cogsTotal,
    cogs_pct: +((cogsTotal / netSales) * 100).toFixed(2),
    labor_total: laborTotal,
    labor_pct: +((laborTotal / netSales) * 100).toFixed(2),
    prime_cost_pct: qb.prime_cost_pct ||
