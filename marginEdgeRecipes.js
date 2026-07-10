// marginEdgeRecipes.js
// Stage 3: Recipe BOM + yield.
//
// *** BLOCKED — bigger gap than initially assumed ***
// Your existing `fetchMarginEdge(date)` only pulls purchase/invoice line
// items and buckets them into COGS categories by keyword-matching the
// vendor/category string (see `bucketCogs` in server.js: "meat", "produce",
// "dairy", etc.). There is no recipe, BOM, or yield endpoint currently wired
// into RIC anywhere — this isn't a matter of adapting an existing client,
// it's new integration work.
//
// Before this module can do anything real, we need to confirm:
//   1. Does MarginEdge's public API actually expose a recipes/BOM endpoint
//      for your account tier? (Check https://api.marginedge.com/public docs,
//      or ask your MarginEdge rep — the invoice/order endpoints you're
//      already using don't imply recipe data is available on the same plan.)
//   2. If it exists, what's the actual response shape — ingredient qty,
//      unit, yield %, keyed to which item identifier?
//
// Until that's answered, this file is a placeholder with the intended
// interface, NOT a working integration. Do not wire this into routes.js
// as if it's functional.

import { readJSON, writeJSON } from './storage.js';

const RECIPE_BOM_KEY = 'ppc_recipe_bom';

export async function fetchMarginEdgeRecipesRaw(/* meApiKey, meTenantId */) {
  throw new Error(
    'marginEdgeRecipes: no confirmed recipes/BOM endpoint exists in the ' +
    'current MarginEdge integration. See file header — this needs API docs ' +
    'or vendor confirmation before it can be implemented for real.'
  );
}

// Intended shape once a real endpoint is confirmed — adjust to match
// whatever MarginEdge actually returns:
// { menu_item_id, sku_id, qty_per_item, recipe_unit, yield_pct }
export function normalizeRecipeBom(rawRecipes) {
  const rows = [];
  for (const recipe of rawRecipes) {
    const menuItemId = recipe.menuItemId || recipe.menu_item_id;
    const ingredients = recipe.ingredients || [];
    for (const ing of ingredients) {
      rows.push({
        menu_item_id: menuItemId,
        sku_id: ing.skuId || ing.sku_id,
        qty_per_item: Number(ing.qty),
        recipe_unit: ing.unit,
        yield_pct: ing.yieldPct != null ? Number(ing.yieldPct) : 100,
      });
    }
  }
  return rows;
}

export async function syncRecipeBom(meCreds) {
  const raw = await fetchMarginEdgeRecipesRaw(meCreds);
  const normalized = normalizeRecipeBom(raw);
  writeJSON(RECIPE_BOM_KEY, { synced_at: new Date().toISOString(), rows: normalized });
  return normalized;
}

export function getCachedRecipeBom() {
  return readJSON(RECIPE_BOM_KEY, { synced_at: null, rows: [] });
}

// Theoretical usage in recipe units for a single menu item's forecasted sales count.
export function usageForMenuItem(recipeBomRows, menuItemId, forecastedQty) {
  const rows = recipeBomRows.filter((r) => r.menu_item_id === menuItemId);
  return rows.map((r) => ({
    sku_id: r.sku_id,
    recipe_unit: r.recipe_unit,
    usage_qty: (r.qty_per_item * forecastedQty) / (r.yield_pct / 100),
  }));
}
