// pmix.js
// Stage 2: Product mix (Pmix), normalized as % of covers, DOW-weighted over
// a trailing window so a slow Tuesday doesn't skew what should be a stable
// Friday number.
//
// Sourced via gotabAdapter.js's fetchItemizedGoTabRange — NOT your existing
// fetchGoTabRange, which collapses item-level detail (see gotabAdapter.js
// header for why). Covers are approximated as tab count until a real
// guest-count field is confirmed available from GoTab.

import { readJSON, writeJSON } from './storage.js';
import { fetchItemizedGoTabRange } from './gotabAdapter.js';

const PMIX_KEY = 'ppc_pmix_weekly';
const TRAILING_WEEKS = 6;

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// How much a given day-of-week's data should count toward forecasting *that
// same* day-of-week. Same-DOW gets full weight; adjacent days get partial
// weight so the sample isn't razor-thin on lower-volume days.
export function dowWeight(targetDow, sampleDow) {
  if (targetDow === sampleDow) return 1.0;
  const diff = Math.min(Math.abs(targetDow - sampleDow), 7 - Math.abs(targetDow - sampleDow));
  if (diff === 1) return 0.25;
  return 0.05;
}

// checks: array of { date, dayOfWeek(0-6), coverCount, lineItems: [{menuItemId, qty, revenueCents}] }
export function computePmixWeekly(checks) {
  const byMenuItemByDow = {};
  const totalCoversByDow = {};

  for (const check of checks) {
    const dow = check.dayOfWeek;
    totalCoversByDow[dow] = (totalCoversByDow[dow] || 0) + check.coverCount;

    for (const line of check.lineItems) {
      if (!byMenuItemByDow[line.menuItemId]) byMenuItemByDow[line.menuItemId] = {};
      if (!byMenuItemByDow[line.menuItemId][dow]) {
        byMenuItemByDow[line.menuItemId][dow] = { qty: 0, revenueCents: 0 };
      }
      byMenuItemByDow[line.menuItemId][dow].qty += line.qty;
      byMenuItemByDow[line.menuItemId][dow].revenueCents += line.revenueCents;
    }
  }

  const results = [];
  for (const menuItemId of Object.keys(byMenuItemByDow)) {
    for (let targetDow = 0; targetDow < 7; targetDow++) {
      let weightedQty = 0;
      let weightedCovers = 0;
      let revenueCents = 0;

      for (let sampleDow = 0; sampleDow < 7; sampleDow++) {
        const w = dowWeight(targetDow, sampleDow);
        const dayData = byMenuItemByDow[menuItemId][sampleDow];
        if (dayData) {
          weightedQty += dayData.qty * w;
          revenueCents += dayData.revenueCents * w;
        }
        if (totalCoversByDow[sampleDow]) {
          weightedCovers += totalCoversByDow[sampleDow] * w;
        }
      }

      if (weightedCovers === 0) continue;

      results.push({
        menu_item_id: menuItemId,
        day_of_week: targetDow,
        day_name: DOW_NAMES[targetDow],
        pct_of_covers: weightedQty / weightedCovers,
        revenue_per_item_cents: weightedQty > 0 ? revenueCents / weightedQty : 0,
      });
    }
  }
  return results;
}

// deps: { getGoTabToken, goTabQuery, fetchWithRetry, GOTAB_LOCATION_UUID } — from app.locals
export async function recalculatePmix(deps) {
  const checks = await fetchItemizedGoTabRange(deps, TRAILING_WEEKS);
  const pmix = computePmixWeekly(checks);

  writeJSON(PMIX_KEY, {
    as_of_week: new Date().toISOString().slice(0, 10),
    trailing_weeks: TRAILING_WEEKS,
    covers_source: 'tab_count_approximation', // flip to 'guest_count' once GoTab field confirmed
    rows: pmix,
  });

  return pmix;
}

export function getCachedPmix() {
  return readJSON(PMIX_KEY, {
    as_of_week: null,
    trailing_weeks: TRAILING_WEEKS,
    covers_source: null,
    rows: [],
  });
}
