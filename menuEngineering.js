// menuEngineering.js
// Classic Stars/Plowhorses/Puzzles/Dogs menu engineering matrix.
//
// VELOCITY (units sold, revenue) — real, live, from GoTab via the same
// itemized adapter built for PPC's Pmix. No new integration needed.
//
// COST/MARGIN — MarginEdge's public API has no menu-item cost/price
// endpoint (confirmed against the official endpoint list). This data only
// exists in MarginEdge's "Menu Items"/"Prepared Items" CSV export (Cost,
// Menu Price, Net Profit, Cost %). Since menu prices/costs change
// infrequently, a periodic manual CSV import is the right call here rather
// than waiting on an API that doesn't exist — same reasoning as the
// recipe-file decision.
//
// CROSSWALK: GoTab item names and MarginEdge menu item names may not match
// exactly (different naming conventions). Matching is attempted by exact
// name first; unmatched items are surfaced for manual mapping rather than
// silently dropped.

import { readJSON, writeJSON } from './storage.js';
import { fetchItemizedGoTabRange } from './gotabAdapter.js';

const MENU_COSTS_KEY = 'ric_menu_item_costs';
const MENU_ALIASES_KEY = 'ric_menu_item_aliases'; // manual GoTab-name -> ME-name overrides
const VELOCITY_CACHE_KEY = 'ric_menu_velocity_cache';

// ---- Cost import (from MarginEdge's CSV export) ----

// Very small, dependency-free CSV parser sufficient for MarginEdge's export
// shape: Name, Type, On Inventory, Cost, Menu Price, Net Profit, Cost %, ...
// Handles quoted fields (commas/quotes inside names) since some menu item
// names contain commas.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field.length || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && r.some((c) => c.trim() !== ''));
}

function parseMoney(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[$,]/g, ''));
  return isNaN(n) ? null : n;
}

function parsePercent(str) {
  if (str == null) return null;
  const n = parseFloat(String(str).replace(/[%,]/g, ''));
  return isNaN(n) ? null : n;
}

// Expects the MarginEdge "Menu Items" export shape:
// Name, Type, On Inventory, Cost, Menu Price, Net Profit, Cost %, Visibility, ...
export function importMenuItemCostsCSV(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { imported: 0, items: [] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    name: header.indexOf('name'),
    type: header.indexOf('type'),
    cost: header.indexOf('cost'),
    menuPrice: header.indexOf('menu price'),
    netProfit: header.indexOf('net profit'),
    costPct: header.indexOf('cost %'),
  };
  if (idx.name === -1) throw new Error('CSV missing expected "Name" column — confirm this is a MarginEdge Menu Items export.');

  const items = rows.slice(1).map((r) => ({
    name: r[idx.name]?.trim(),
    type: idx.type >= 0 ? r[idx.type]?.trim() : null,
    cost: idx.cost >= 0 ? parseMoney(r[idx.cost]) : null,
    menu_price: idx.menuPrice >= 0 ? parseMoney(r[idx.menuPrice]) : null,
    net_profit: idx.netProfit >= 0 ? parseMoney(r[idx.netProfit]) : null,
    cost_pct: idx.costPct >= 0 ? parsePercent(r[idx.costPct]) : null,
  })).filter((i) => i.name);

  writeJSON(MENU_COSTS_KEY, { imported_at: new Date().toISOString(), items });
  return { imported: items.length, items };
}

export function getCachedMenuCosts() {
  return readJSON(MENU_COSTS_KEY, { imported_at: null, items: [] });
}

// ---- Manual name aliasing (GoTab name -> MarginEdge name) ----

export function getAliases() {
  return readJSON(MENU_ALIASES_KEY, {});
}

export function setAlias(gotabName, meName) {
  const aliases = getAliases();
  aliases[gotabName] = meName;
  writeJSON(MENU_ALIASES_KEY, aliases);
  return aliases;
}

// ---- Velocity (real, live, from GoTab) ----

// Aggregates raw itemized checks into total units + revenue per item over
// the whole window — NOT day-of-week-weighted like pmix.js (that's built
// for forecasting; this is a look-back total for classification).
function aggregateVelocity(checks) {
  const byItem = {};
  for (const check of checks) {
    for (const line of check.lineItems) {
      if (!byItem[line.menuItemId]) byItem[line.menuItemId] = { qty: 0, revenueCents: 0 };
      byItem[line.menuItemId].qty += line.qty;
      byItem[line.menuItemId].revenueCents += line.revenueCents;
    }
  }
  return byItem;
}

// deps: same shape as pmix.js/gotabAdapter.js — { getGoTabToken, goTabQuery, fetchWithRetry, GOTAB_LOCATION_UUID }
export async function recalculateVelocity(deps, weeks = 4) {
  const checks = await fetchItemizedGoTabRange(deps, weeks);
  const velocity = aggregateVelocity(checks);
  writeJSON(VELOCITY_CACHE_KEY, {
    as_of: new Date().toISOString(),
    window_weeks: weeks,
    velocity,
  });
  return velocity;
}

export function getCachedVelocity() {
  return readJSON(VELOCITY_CACHE_KEY, { as_of: null, window_weeks: null, velocity: {} });
}

// ---- The matrix itself ----

// Classifies each matched item into one of the four classic menu-engineering
// quadrants using median splits (not fixed thresholds) — this self-adjusts
// to Hill Country's actual menu mix rather than an arbitrary cutoff.
export function buildMenuEngineeringMatrix() {
  const costCache = getCachedMenuCosts();
  const velocityCache = getCachedVelocity();
  const aliases = getAliases();

  if (costCache.items.length === 0) {
    throw new Error('No menu cost data imported yet — call importMenuItemCostsCSV first.');
  }
  if (Object.keys(velocityCache.velocity).length === 0) {
    throw new Error('No velocity data yet — call recalculateVelocity first.');
  }

  const velocityByName = {};
  for (const [gotabName, data] of Object.entries(velocityCache.velocity)) {
    velocityByName[gotabName] = data;
  }

  const matched = [];
  const unmatchedCostItems = [];
  const unmatchedGotabItems = new Set(Object.keys(velocityByName));

  for (const costItem of costCache.items) {
    // Try: alias override -> exact name match -> no match
    const aliasTarget = Object.entries(aliases).find(([, meName]) => meName === costItem.name)?.[0];
    const gotabName = aliasTarget || (velocityByName[costItem.name] ? costItem.name : null);

    if (!gotabName || !velocityByName[gotabName]) {
      unmatchedCostItems.push(costItem.name);
      continue;
    }

    unmatchedGotabItems.delete(gotabName);
    const v = velocityByName[gotabName];
    const marginPct = costItem.menu_price > 0
      ? +(((costItem.menu_price - (costItem.cost || 0)) / costItem.menu_price) * 100).toFixed(1)
      : null;

    matched.push({
      name: costItem.name,
      gotab_name: gotabName,
      units_sold: v.qty,
      revenue: +(v.revenueCents / 100).toFixed(2),
      cost: costItem.cost,
      menu_price: costItem.menu_price,
      margin_pct: marginPct,
    });
  }

  if (matched.length === 0) {
    return {
      matrix: [],
      unmatched_cost_items: unmatchedCostItems,
      unmatched_gotab_items: Array.from(unmatchedGotabItems),
      note: 'No items matched between MarginEdge cost data and GoTab sales data — check name aliases via setAlias().',
    };
  }

  const median = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const medianVelocity = median(matched.map((m) => m.units_sold));
  const medianMargin = median(matched.filter((m) => m.margin_pct != null).map((m) => m.margin_pct));

  const classified = matched.map((m) => {
    const highVelocity = m.units_sold >= medianVelocity;
    const highMargin = m.margin_pct != null ? m.margin_pct >= medianMargin : null;
    let quadrant = 'unclassified';
    if (highMargin != null) {
      if (highVelocity && highMargin) quadrant = 'star';
      else if (highVelocity && !highMargin) quadrant = 'plowhorse';
      else if (!highVelocity && highMargin) quadrant = 'puzzle';
      else quadrant = 'dog';
    }
    return { ...m, quadrant };
  });

  return {
    matrix: classified.sort((a, b) => b.revenue - a.revenue),
    median_velocity: medianVelocity,
    median_margin_pct: medianMargin,
    unmatched_cost_items: unmatchedCostItems,
    unmatched_gotab_items: Array.from(unmatchedGotabItems),
    velocity_window_weeks: velocityCache.window_weeks,
    costs_imported_at: costCache.imported_at,
  };
}
