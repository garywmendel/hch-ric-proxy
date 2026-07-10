// inventorySnapshot.js
// Stage 5 input: on-hand quantities used to offset forecasted usage.
//
// *** BLOCKED / STUBBED ***
// Awaiting confirmation on where ending inventory counts live (most likely
// MarginEdge counts) and how fresh they are relative to order day. Until
// confirmed, this returns null on_hand for every SKU so the report can still
// run end-to-end — order qty math falls back to (forecasted usage + par
// buffer) with no on-hand offset.

import { readJSON } from './storage.js';

const SNAPSHOT_KEY = 'ppc_inventory_snapshot';

export function getCachedSnapshot() {
  return readJSON(SNAPSHOT_KEY, { as_of: null, rows: [] });
}

// Once the source is confirmed, replace this with a real fetch, normalized
// to: [{ sku_id, qty_on_hand, unit }]
export async function syncInventorySnapshot(/* inventoryClient */) {
  throw new Error(
    'inventorySnapshot: source not yet configured. Awaiting confirmation of ' +
    'where ending inventory counts are captured before wiring this up.'
  );
}

export function onHandFor(skuId) {
  const snapshot = getCachedSnapshot();
  const row = snapshot.rows.find((r) => r.sku_id === skuId);
  return {
    qty_on_hand: row ? row.qty_on_hand : null,
    as_of: snapshot.as_of,
    available: !!row,
  };
}
