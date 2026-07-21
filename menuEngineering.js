// menuEngineering.js
// Classic Stars/Plowhorses/Puzzles/Dogs menu engineering matrix.
//
// CONFIRMED (as of the 4-file MarginEdge export review): Menu Items, Bar
// Items, and Prepared Items are all the SAME flat cost-summary shape (Name,
// Type, On Inventory, Cost, Menu Price, Net Profit, Cost %, ...) — no
// ingredient/recipe/yield detail in any of them. This closes the door on
// recipe/BOM data existing in ANY MarginEdge export path — confirmed a
// third time. These three files feed MENU ENGINEERING (cost side) only,
// not PPC's recipe/yield stage, which remains blocked.
//
// A FOURTH file — Menu Analysis — is structurally different and more
// valuable: it has Item Type, Menu Item, Avg. Cost, Items Sold, Menu Item
// Cost, Modifier Cost, Total Cost, Menu Item Revenue, Modifier Revenue,
// Total Revenue, Avg. Profit, Theoretical Cost — i.e. MarginEdge has
// ALREADY resolved real sales velocity + actual cost + theoretical cost
// per item internally. This is a better source for the matrix than
// deriving velocity from GoTab, since it needs no name crosswalk at all —
// MarginEdge did that matching itself. Preferred when available; GoTab
// velocity + the 3 cost CSVs remain the fallback path.

import { readJSON, writeJSON } from './storage.js';
import { fetchItemizedGoTabRange } from './gotabAdapter.js';

const MENU_COSTS_KEY = 'ric_menu_item_costs';         // accumulates Menu/Bar/Prepared Items
const MENU_ANALYSIS_KEY = 'ric_menu_analysis_cache';   // Menu Analysis (preferred source)
const MENU_ALIASES_KEY = 'ric_menu_item_aliases';      // manual GoTab-name -> ME-name overrides (fallback path only)
const VELOCITY_CACHE_KEY = 'ric_menu_velocity_cache';  // GoTab-derived velocity (fallback path only)

// ---- CSV parsing (shared) ----

// Dependency-free CSV parser handling quoted fields (commas/quotes inside
// names) — MarginEdge exports quote every field, and some names contain
// literal quote characters (e.g. 9" pie sizes).
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
  if (str == null || str === '') return null;
  const n = parseFloat(String(str).replace(/[%,]/g, ''));
  return isNaN(n) ? null : n;
}

function parseNum(str) {
  if (str == null || str === '') return null;
  const n = parseFloat(String(str).replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

// ---- Cost catalog import (Menu Items / Bar Items / Prepared Items) ----
// All three share this shape. Calling this once per file ACCUMULATES into
// one catalog (upsert by name) rather than overwriting — so importing
// Menu Items, then Bar Items, then Prepared Items builds one full catalog
// instead of each call wiping the last.

export function importMenuItemCostsCSV(csvText, source = 'menu_items') {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { imported: 0, source, total_items: getCachedMenuCosts().items.length };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    name: header.indexOf('name'),
    type: header.indexOf('type'),
    cost: header.indexOf('cost'),
    menuPrice: header.indexOf('menu price'),
    netProfit: header.indexOf('net profit'),
    costPct: header.indexOf('cost - %') >= 0 ? header.indexOf('cost - %') : header.indexOf('cost %'),
  };
  if (idx.name === -1) throw new Error('CSV missing expected "Name" column — confirm this is a MarginEdge cost-summary export (Menu/Bar/Prepared Items).');

  const newItems = rows.slice(1).map((r) => ({
    name: r[idx.name]?.trim(),
    type: idx.type >= 0 ? r[idx.type]?.trim() : null,
    cost: idx.cost >= 0 ? parseMoney(r[idx.cost]) : null,
    menu_price: idx.menuPrice >= 0 ? parseMoney(r[idx.menuPrice]) : null,
    net_profit: idx.netProfit >= 0 ? parseMoney(r[idx.netProfit]) : null,
    cost_pct: idx.costPct >= 0 ? parsePercent(r[idx.costPct]) : null,
    source,
  })).filter((i) => i.name);

  const cache = getCachedMenuCosts();
  const byName = {};
  for (const existing of cache.items) byName[existing.name] = existing;
  for (const item of newItems) byName[item.name] = item; // upsert — latest import for a name wins
  const merged = Object.values(byName);

  const sourcesImported = { ...(cache.sources_imported || {}), [source]: new Date().toISOString() };
  writeJSON(MENU_COSTS_KEY, { imported_at: new Date().toISOString(), sources_imported: sourcesImported, items: merged });
  return { imported: newItems.length, source, total_items: merged.length, sources_imported: sourcesImported };
}

export function getCachedMenuCosts() {
  return readJSON(MENU_COSTS_KEY, { imported_at: null, sources_imported: {}, items: [] });
}

// ---- Menu Analysis import (preferred source — real velocity + theoretical cost) ----

export function importMenuAnalysisCSV(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length === 0) return { imported: 0, items: [] };

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {
    itemType: header.indexOf('item type'),
    menuItem: header.indexOf('menu item'),
    avgCost: header.indexOf('avg. cost'),
    itemsSold: header.indexOf('items sold'),
    menuItemCost: header.indexOf('menu item cost'),
    modifierCost: header.indexOf('modifier cost'),
    totalCost: header.indexOf('total cost'),
    menuItemRevenue: header.indexOf('menu item revenue'),
    modifierRevenue: header.indexOf('modifier revenue'),
    totalRevenue: header.indexOf('total revenue'),
    avgProfit: header.indexOf('avg. profit'),
    theoreticalCost: header.indexOf('theoretical cost'),
  };
  if (idx.menuItem === -1) throw new Error('CSV missing expected "Menu Item" column — confirm this is a MarginEdge Menu Analysis export.');

  const items = rows.slice(1).map((r) => ({
    item_type: idx.itemType >= 0 ? r[idx.itemType]?.trim() : null,
    name: r[idx.menuItem]?.trim(),
    avg_cost: idx.avgCost >= 0 ? parseNum(r[idx.avgCost]) : null,
    items_sold: idx.itemsSold >= 0 ? parseNum(r[idx.itemsSold]) : null,
    menu_item_cost: idx.menuItemCost >= 0 ? parseNum(r[idx.menuItemCost]) : null,
    modifier_cost: idx.modifierCost >= 0 ? parseNum(r[idx.modifierCost]) : null,
    total_cost: idx.totalCost >= 0 ? parseNum(r[idx.totalCost]) : null,
    menu_item_revenue: idx.menuItemRevenue >= 0 ? parseNum(r[idx.menuItemRevenue]) : null,
    modifier_revenue: idx.modifierRevenue >= 0 ? parseNum(r[idx.modifierRevenue]) : null,
    total_revenue: idx.totalRevenue >= 0 ? parseNum(r[idx.totalRevenue]) : null,
    avg_profit: idx.avgProfit >= 0 ? parseNum(r[idx.avgProfit]) : null,
    // NOTE: this field is a decimal ratio (e.g. 0.286), NOT a percent string
    // like the cost-summary files — confirmed by cross-checking Cornbread's
    // 0.286 here against its 28.6% Cost % in the Menu Items export.
    theoretical_cost_ratio: idx.theoreticalCost >= 0 ? parseNum(r[idx.theoreticalCost]) : null,
  })).filter((i) => i.name);

  writeJSON(MENU_ANALYSIS_KEY, { imported_at: new Date().toISOString(), items });
  return { imported: items.length, items };
}

export function getCachedMenuAnalysis() {
  return readJSON(MENU_ANALYSIS_KEY, { imported_at: null, items: [] });
}

// ---- Manual name aliasing (fallback path only — GoTab name -> ME name) ----

export function getAliases() {
  return readJSON(MENU_ALIASES_KEY, {});
}

export function setAlias(gotabName, meName) {
  const aliases = getAliases();
  aliases[gotabName] = meName;
  writeJSON(MENU_ALIASES_KEY, aliases);
  return aliases;
}

// ---- Velocity from GoTab (fallback path only, used if Menu Analysis isn't imported) ----

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

export async function recalculateVelocity(deps, weeks = 4) {
  const checks = await fetchItemizedGoTabRange(deps, weeks);
  const velocity = aggregateVelocity(checks);
  writeJSON(VELOCITY_CACHE_KEY, { as_of: new Date().toISOString(), window_weeks: weeks, velocity });
  return velocity;
}

export function getCachedVelocity() {
  return readJSON(VELOCITY_CACHE_KEY, { as_of: null, window_weeks: null, velocity: {} });
}

// ---- Shared classification (median-split quadrants) ----

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function classify(matched, meta) {
  if (matched.length === 0) {
    return { matrix: [], ...meta, note: 'No items available to classify.' };
  }
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
    ...meta,
  };
}

// ---- The matrix itself ----

export function buildMenuEngineeringMatrix() {
  const analysisCache = getCachedMenuAnalysis();

  // PREFERRED PATH: MarginEdge's own Menu Analysis already resolves
  // velocity + actual cost + theoretical cost per item — no crosswalk
  // needed at all, since MarginEdge did the item matching internally.
  // CONFIRMED against a real export: MarginEdge's Menu Analysis report for
  // this account returns only 1 row (not a sample truncation — genuinely
  // all it exports). A 1-item "matrix" is useless, so only prefer this
  // source if it actually has enough items to be meaningful; otherwise
  // fall back to the richer GoTab velocity + accumulated cost catalog,
  // which will have your full menu.
  const MIN_ANALYSIS_ITEMS_TO_PREFER = 10;
  if (analysisCache.items.length >= MIN_ANALYSIS_ITEMS_TO_PREFER) {
    const matched = analysisCache.items
      .filter((i) => i.items_sold != null && i.total_revenue > 0)
      .map((i) => ({
        name: i.name,
        item_type: i.item_type,
        units_sold: i.items_sold,
        revenue: i.total_revenue,
        cost: i.total_cost,
        theoretical_cost_pct: i.theoretical_cost_ratio != null ? +(i.theoretical_cost_ratio * 100).toFixed(1) : null,
        margin_pct: i.total_revenue > 0 ? +(((i.total_revenue - (i.total_cost || 0)) / i.total_revenue) * 100).toFixed(1) : null,
      }));

    return classify(matched, {
      source: 'marginedge_menu_analysis',
      analysis_imported_at: analysisCache.imported_at,
    });
  }

  // FALLBACK PATH: GoTab-derived velocity matched against the accumulated
  // Menu/Bar/Prepared Items cost catalog by name (or manual alias).
  const costCache = getCachedMenuCosts();
  const velocityCache = getCachedVelocity();
  const aliases = getAliases();

  if (costCache.items.length === 0) {
    throw new Error('No menu cost data imported yet, and no Menu Analysis file imported either — call importMenuItemCostsCSV or importMenuAnalysisCSV first.');
  }
  if (Object.keys(velocityCache.velocity).length === 0) {
    throw new Error('No velocity data yet — call recalculateVelocity first (or import a Menu Analysis CSV instead, which includes velocity already).');
  }

  const velocityByName = { ...velocityCache.velocity };
  const matched = [];
  const unmatchedCostItems = [];
  const unmatchedGotabItems = new Set(Object.keys(velocityByName));

  for (const costItem of costCache.items) {
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

  return classify(matched, {
    source: 'gotab_velocity_plus_cost_catalog',
    unmatched_cost_items: unmatchedCostItems,
    unmatched_gotab_items: Array.from(unmatchedGotabItems),
    velocity_window_weeks: velocityCache.window_weeks,
    costs_imported_at: costCache.imported_at,
  });
}
