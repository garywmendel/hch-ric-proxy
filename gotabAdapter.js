// gotabAdapter.js
//
// Your existing `fetchGoTabRange` / `normalizeGoTab` collapse every tab's line
// items into a handful of aggregate buckets (net_sales, bar_sales, etc.) —
// that's right for the daily briefing, but Pmix needs per-menu-item detail
// (which item, how many sold, what revenue), which those functions discard.
//
// This adapter re-uses your existing token + GraphQL query functions
// (injected via deps, wired from server.js's app.locals — see routes.js)
// but keeps item-level detail instead of collapsing it, producing the
// `checks` shape pmix.js's computePmixWeekly() expects:
//   { date, dayOfWeek, coverCount, lineItems: [{ menuItemId, qty, revenueCents }] }
//
// *** OPEN ITEM: covers ***
// Your GoTab GraphQL query (goTabQuery) does not currently select a guest
// count / party size field — only tabMode, tax, total, subtotal, etc. Until
// that's confirmed available (or added to the query), this uses TAB COUNT
// as a stand-in for covers. That's an approximation — a tab isn't necessarily
// one cover — flagged here rather than silently treated as accurate. If GoTab
// exposes a real guest count field, swap `coverCount: tabs.length` below for
// the real sum.
//
// Same exclusion rules as your existing normalizeGoTab: voided items, comps,
// and DEFERRED_REVENUE/PROCESSORS/EXPENSE reporting groups are skipped so
// Pmix isn't polluted by non-menu-item lines.

const EXCLUDED_GROUPS = ['DEFERRED_REVENUE', 'PROCESSORS', 'EXPENSE'];

// goTabQuery requires an explicit end-date bound (fixed as part of an
// earlier bug where its absence caused 4x-inflated 7-day aggregates) —
// this local helper matches the same nextDay logic used everywhere else
// in the codebase, so this file doesn't depend on it being separately
// injected via deps.
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function normalizeTabsToLineItems(tabs) {
  const lineItems = [];
  for (const tab of tabs) {
    for (const item of tab.items || []) {
      const group = item.accountingStream?.reportingGroup || '';
      const name = item.accountingStream?.name || '';
      if (EXCLUDED_GROUPS.includes(group)) continue;
      if (name.startsWith('Discounts and Comps')) continue;
      if (item.voided || group === 'VOID') continue;

      lineItems.push({
        menuItemId: item.name, // no numeric menu item id available — using item name as the identifier
        // GoTab's GraphQL API returns quantity as a STRING, not a number.
        // Without converting it, aggregateVelocity's `+=` silently does
        // STRING CONCATENATION instead of addition (0 + "1" → "01", then
        // "01" + "1" → "011", compounding across every day in the range) —
        // confirmed against real output where qty values were long digit
        // strings instead of real sums. Number() fixes this at the source.
        qty: Number(item.quantity) || 0,
        revenueCents: Number(item.subtotal) || 0,
      });
    }
  }
  return lineItems;
}

// deps: { getGoTabToken, goTabQuery, fetchWithRetry, GOTAB_LOCATION_UUID }
// (all injected from server.js via app.locals — see routes.js wiring)
export async function fetchItemizedGoTabDay(deps, dateStr) {
  const token = await deps.getGoTabToken();
  const res = await deps.fetchWithRetry('https://gotab.io/api/v2/graph', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(deps.goTabQuery(deps.GOTAB_LOCATION_UUID, dateStr, nextDay(dateStr))),
  });
  if (!res.ok) throw new Error(`GoTab itemized fetch failed for ${dateStr}: ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GoTab GraphQL error');

  const tabs = data?.data?.locations?.[0]?.tabs || [];
  const lineItems = normalizeTabsToLineItems(tabs);
  const d = new Date(`${dateStr}T12:00:00`);

  return {
    date: dateStr,
    dayOfWeek: d.getDay(),
    coverCount: tabs.length, // approximation — see note above
    lineItems,
  };
}

// Pulls N trailing weeks of itemized daily data for Pmix calculation.
export async function fetchItemizedGoTabRange(deps, weeks = 6) {
  const days = weeks * 7;
  const dates = [];
  const start = new Date();
  start.setDate(start.getDate() - days);
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const results = await Promise.allSettled(dates.map((date) => fetchItemizedGoTabDay(deps, date)));
  const checks = [];
  for (const r of results) {
    if (r.status === 'fulfilled') checks.push(r.value);
    else console.error('[gotabAdapter] day fetch failed:', r.reason?.message);
  }
  return checks;
}
