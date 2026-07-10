// skuConfig.js
// Stage 5 config: par levels, order cadence, flex %, class defaults.
// Manually-maintained layer — changes rarely, edited by GM/Angelo.

import { readJSON, writeJSON } from './storage.js';

const SKU_CONFIG_KEY = 'ppc_sku_config';
const CLASS_DEFAULTS_KEY = 'ppc_class_defaults';

// Seed defaults — adjust to match Hill Country's real class taxonomy.
// flex_pct_default = how much of suggested order qty is safe to shave
// without real stockout risk.
const DEFAULT_CLASS_DEFAULTS = [
  { class: 'protein_fresh', flex_pct_default: 5 },
  { class: 'protein_frozen', flex_pct_default: 10 },
  { class: 'produce', flex_pct_default: 10 },
  { class: 'dairy', flex_pct_default: 8 },
  { class: 'dry_goods', flex_pct_default: 25 },
  { class: 'paper_packaging', flex_pct_default: 30 },
  { class: 'beverage', flex_pct_default: 15 },
];

export function getClassDefaults() {
  return readJSON(CLASS_DEFAULTS_KEY, DEFAULT_CLASS_DEFAULTS);
}

export function setClassDefaults(defaults) {
  writeJSON(CLASS_DEFAULTS_KEY, defaults);
  return defaults;
}

export function getClassDefault(className) {
  const defaults = getClassDefaults();
  const match = defaults.find((d) => d.class === className);
  return match ? match.flex_pct_default : 10; // conservative fallback
}

// sku_config shape:
// {
//   sku_id, name, class, purchase_unit, recipe_unit,
//   unit_conversion_factor, par_level, order_days: [],
//   lead_time_days, flex_pct_override: null|number, vendor_id: null|string
// }

export function getAllSkuConfig() {
  return readJSON(SKU_CONFIG_KEY, []);
}

export function getSkuConfig(skuId) {
  return getAllSkuConfig().find((s) => s.sku_id === skuId) || null;
}

export function upsertSkuConfig(entry) {
  const all = getAllSkuConfig();
  const idx = all.findIndex((s) => s.sku_id === entry.sku_id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...entry };
  } else {
    all.push(entry);
  }
  writeJSON(SKU_CONFIG_KEY, all);
  return all;
}

export function bulkUpsertSkuConfig(entries) {
  const all = getAllSkuConfig();
  const byId = new Map(all.map((s) => [s.sku_id, s]));
  for (const entry of entries) {
    byId.set(entry.sku_id, { ...(byId.get(entry.sku_id) || {}), ...entry });
  }
  const merged = Array.from(byId.values());
  writeJSON(SKU_CONFIG_KEY, merged);
  return merged;
}

// Effective flex % = per-SKU override if set, else the SKU's class default.
export function effectiveFlexPct(skuConfigEntry) {
  if (skuConfigEntry.flex_pct_override != null) return skuConfigEntry.flex_pct_override;
  return getClassDefault(skuConfigEntry.class);
}

// Is this SKU due for an order on a given day-of-week? e.g. "Mon","Wed","Fri"
export function isDueOnDay(skuConfigEntry, dayAbbrev) {
  return (skuConfigEntry.order_days || []).includes(dayAbbrev);
}
