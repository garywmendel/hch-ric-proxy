// marginEdgeProducts.js
//
// Uses CONFIRMED, real MarginEdge public API endpoints (per the official
// endpoint table — no more guessing):
//   GET /products
//   GET /vendors
//   GET /vendors/:vendorId/vendorItems
//   GET /vendors/:vendorId/vendorItems/:vendorItemCode/packaging
//
// This does NOT solve stage 3 (recipe/yield) — that's confirmed unavailable
// via API (see marginEdgeRecipes.js). What this DOES solve: the SKU→vendor
// mapping question that's been open since the Vendor Order Sheet discussion,
// and gives real product IDs + packaging/unit data to seed sku_config with,
// instead of hand-typing everything.

import { readJSON, writeJSON } from './storage.js';

const PRODUCTS_KEY = 'ppc_me_products';
const VENDORS_KEY = 'ppc_me_vendors';
const VENDOR_ITEMS_KEY = 'ppc_me_vendor_items';

const BASE = 'https://api.marginedge.com/public';

function headers(apiKey) {
  return { 'X-Api-Key': apiKey, Accept: 'application/json' };
}

// Runs fn over items with at most `limit` concurrent in-flight calls, rather
// than firing everything at once (Promise.all on a large array). This is
// what caused the 429s: fetching packaging for every vendor item in a
// vendor simultaneously overwhelmed MarginEdge's rate limit.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// deps: { fetchWithRetry, MARGINEDGE_API_KEY, MARGINEDGE_TENANT_ID }
// resourceKeys: possible key names MarginEdge might nest results under for
// this specific endpoint (e.g. "products", "vendors") — checked before the
// generic items/data fallback, since your working fetchMarginEdge orders
// call confirms MarginEdge nests results under a resource-named key.
//
// Pagination: CONFIRMED cursor-based via a `nextPage` token in the response
// (not page/pageSize — verified via debug-products-raw, which showed the
// server ignoring page/pageSize params entirely and returning a `nextPage`
// cursor instead). Each response's `nextPage` value gets passed back as a
// query param on the next request; absence of `nextPage` means done.
async function paginatedGet(deps, path, resourceKeys = []) {
  const results = [];
  let cursor = null;
  let guard = 0;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const cursorParam = cursor ? `&nextPage=${encodeURIComponent(cursor)}` : '';
    const url = `${BASE}${path}${sep}restaurantUnitId=${deps.MARGINEDGE_TENANT_ID}${cursorParam}`;
    const res = await deps.fetchWithRetry(url, { headers: headers(deps.MARGINEDGE_API_KEY) }, 3, 1500);
    if (!res.ok) throw new Error(`MarginEdge ${path} failed: ${res.status}`);
    const json = await res.json();

    let items = null;
    for (const key of resourceKeys) {
      if (Array.isArray(json[key])) { items = json[key]; break; }
    }
    if (!items) items = json.items || json.data || json.content || json.results || (Array.isArray(json) ? json : null);

    if (!items) {
      console.error(`[marginEdgeProducts] ${path}: no known result key found. Top-level keys:`, Object.keys(json));
      items = [];
    }

    results.push(...items);
    cursor = json.nextPage || null;
    guard++;

    if (!cursor || items.length === 0 || guard > 200) break;
  }
  return results;
}

export async function syncProducts(deps) {
  const products = await paginatedGet(deps, '/products', ['products']);
  writeJSON(PRODUCTS_KEY, { synced_at: new Date().toISOString(), rows: products });
  return products;
}

export function getCachedProducts() {
  return readJSON(PRODUCTS_KEY, { synced_at: null, rows: [] });
}

export async function syncVendors(deps) {
  const vendors = await paginatedGet(deps, '/vendors', ['vendors']);
  writeJSON(VENDORS_KEY, { synced_at: new Date().toISOString(), rows: vendors });
  return vendors;
}

export function getCachedVendors() {
  return readJSON(VENDORS_KEY, { synced_at: null, rows: [] });
}

// Vendor items + packaging, per vendor. This is what answers "which vendor
// sells this product, in what package size" — the SKU→vendor mapping.
export async function syncVendorItemsForVendor(deps, vendorId) {
  const items = await paginatedGet(deps, `/vendors/${vendorId}/vendorItems`, ['vendorItems']);

  // Packaging is a separate call per vendor item. Throttled to 3 concurrent
  // requests — firing all of them at once (Promise.all on the full list)
  // is what caused the 429 rate-limit errors on vendors with many items.
  // Items with no vendorItemCode can't be looked up (malformed URL would
  // silently fail into empty packaging) — skip them explicitly instead.
  const withPackaging = await mapWithConcurrency(items, 3, async (item) => {
    if (!item.vendorItemCode) {
      return { ...item, packaging: [], packaging_skipped_reason: 'no vendorItemCode' };
    }
    try {
      const packaging = await paginatedGet(
        deps,
        `/vendors/${vendorId}/vendorItems/${item.vendorItemCode}/packaging`,
        ['packagings']
      );
      return { ...item, packaging };
    } catch (err) {
      console.error(`[marginEdgeProducts] packaging fetch failed for ${item.vendorItemCode}:`, err.message);
      return { ...item, packaging: [], packaging_error: err.message };
    }
  });

  const cache = readJSON(VENDOR_ITEMS_KEY, { synced_at: null, byVendor: {} });
  cache.byVendor[vendorId] = withPackaging;
  cache.synced_at = new Date().toISOString();
  writeJSON(VENDOR_ITEMS_KEY, cache);
  return withPackaging;
}

// Convenience: sync vendor items for ALL known vendors in one call.
export async function syncAllVendorItems(deps) {
  const vendors = getCachedVendors().rows;
  if (vendors.length === 0) {
    throw new Error('No cached vendors — call syncVendors first.');
  }
  const results = {};
  for (const vendor of vendors) {
    const vendorId = vendor.vendorId || vendor.id;
    results[vendorId] = await syncVendorItemsForVendor(deps, vendorId);
    await new Promise((r) => setTimeout(r, 300)); // small buffer between vendors
  }
  return results;
}

export function getCachedVendorItems() {
  return readJSON(VENDOR_ITEMS_KEY, { synced_at: null, byVendor: {} });
}

// Proposes sku_config entries from synced product + vendor item data —
// PREVIEW ONLY, does not write to sku_config directly. Class, par level,
// order days, and flex % still need human judgment, so this returns
// suggestions for review rather than auto-applying.
//
// Join key: companyConceptProductId, confirmed present on both /products
// and vendorItems responses. (Not vendorItemCode — that field only exists
// on the vendor-item side, products don't have it.)
export function suggestSkuConfigEntries() {
  const products = getCachedProducts().rows;
  const vendorItemsCache = getCachedVendorItems().byVendor;

  const vendorItemsByProductId = {};
  for (const vendorId of Object.keys(vendorItemsCache)) {
    for (const vi of vendorItemsCache[vendorId]) {
      const pid = vi.companyConceptProductId;
      if (!pid) continue;
      if (!vendorItemsByProductId[pid]) vendorItemsByProductId[pid] = [];
      vendorItemsByProductId[pid].push({ ...vi, vendorId });
    }
  }

  return products.map((p) => {
    const pid = p.companyConceptProductId;
    const matches = vendorItemsByProductId[pid] || [];
    const primary = matches[0] || null; // first known vendor for this product, if any
    const packagingUnit = primary?.packaging?.[0]?.unit || null;
    const packagingQty = primary?.packaging?.[0]?.quantity || null;

    return {
      sku_id: pid,
      name: p.productName,
      reported_unit: p.reportByUnit || null, // direct from product data, often usable as-is
      suggested_purchase_unit: packagingUnit || p.reportByUnit || null,
      suggested_conversion_hint: packagingQty
        ? `Confirm: 1 ${packagingUnit} = ${packagingQty} recipe units`
        : 'No vendor packaging data found — reportByUnit may suffice, confirm manually',
      vendor_id: primary?.vendorId || null,
      vendor_options_count: matches.length, // >1 means multiple vendors sell this product
      needs_review: {
        class: true, // no signal for this yet — human call
        par_level: true,
        order_days: true,
        flex_pct_override: true,
      },
    };
  });
}
