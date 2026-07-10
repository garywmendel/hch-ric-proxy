// report.js
// Orchestration layer: combines demand forecast + pmix + recipe/yield +
// sku config + inventory into the ppc_report structure "RIC Says..." renders.

import { readJSON, writeJSON } from './storage.js';
import * as skuConfig from './skuConfig.js';
import { getCachedRecipeBom, usageForMenuItem } from './marginEdgeRecipes.js';
import { getCachedPmix } from './pmix.js';
import { onHandFor } from './inventorySnapshot.js';

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Latest report is kept PER report type (e.g. "weekly", "look_ahead_2wk", and
// later per-manager report slugs), not a single global slot — so one report
// generation can't silently replace another's stored state, even though
// "RIC Says..." only ever displays one at a time by design.
function reportKey(reportType) {
  return `ppc_report_latest__${reportType}`;
}

function uid() {
  return `ppc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function toPurchaseUnits(usageQtyRecipeUnits, skuCfg) {
  if (!skuCfg || !skuCfg.unit_conversion_factor) return usageQtyRecipeUnits;
  return usageQtyRecipeUnits / skuCfg.unit_conversion_factor;
}

function aggregateUsageBySku(forecastDays, pmixRows, recipeBomRows) {
  const usage = {};

  const addUsage = (skuId, recipeUnit, qty, band) => {
    if (!usage[skuId]) {
      usage[skuId] = { low: 0, expected: 0, high: 0, recipe_unit: recipeUnit };
    }
    usage[skuId][band] += qty;
  };

  for (const day of forecastDays) {
    const dowPmix = pmixRows.filter((p) => p.day_of_week === day.day_of_week);

    for (const band of ['low', 'expected', 'high']) {
      const covers = day[`covers_${band}`];
      for (const pmixRow of dowPmix) {
        const forecastedItemQty = covers * pmixRow.pct_of_covers;
        const ingredientRows = usageForMenuItem(recipeBomRows, pmixRow.menu_item_id, forecastedItemQty);
        for (const ing of ingredientRows) {
          addUsage(ing.sku_id, ing.recipe_unit, ing.usage_qty, band);
        }
      }
    }
  }

  return usage;
}

function dueDayInfo(skuCfg, windowStartDow) {
  const orderDays = skuCfg.order_days || [];
  const startName = DOW_NAMES[windowStartDow];
  return { order_days: orderDays, due_today: orderDays.includes(startName) };
}

// datesToForecast: [{date, day_of_week}] — any window, past or future.
export function generateReport({ reportType, forecastDays, budgetTarget = null, costPerPurchaseUnit = {} }) {
  const pmixCache = getCachedPmix();
  const recipeBomCache = getCachedRecipeBom();

  const usageBySku = aggregateUsageBySku(forecastDays, pmixCache.rows, recipeBomCache.rows);
  const windowStartDow = forecastDays[0] ? forecastDays[0].day_of_week : new Date().getDay();

  const lines = [];
  let totalProjectedSpend = 0;

  for (const skuId of Object.keys(usageBySku)) {
    const skuCfg = skuConfig.getSkuConfig(skuId);
    if (!skuCfg) {
      lines.push({
        sku_id: skuId,
        name: skuId,
        class: 'unconfigured',
        warning: 'No sku_config entry found — par, order days, and flex % unavailable.',
        forecasted_usage: usageBySku[skuId],
      });
      continue;
    }

    const usage = usageBySku[skuId];
    const flexPct = skuConfig.effectiveFlexPct(skuCfg);
    const { order_days, due_today } = dueDayInfo(skuCfg, windowStartDow);
    const onHand = onHandFor(skuId);

    const usagePurchaseUnits = {
      low: toPurchaseUnits(usage.low, skuCfg),
      expected: toPurchaseUnits(usage.expected, skuCfg),
      high: toPurchaseUnits(usage.high, skuCfg),
    };

    const parBuffer = skuCfg.par_level || 0;
    const onHandOffset = onHand.available ? onHand.qty_on_hand : 0;
    const suggestedOrderQty = Math.max(usagePurchaseUnits.expected + parBuffer - onHandOffset, 0);

    const estCost = (costPerPurchaseUnit[skuId] || 0) * suggestedOrderQty;
    totalProjectedSpend += estCost;

    lines.push({
      sku_id: skuId,
      name: skuCfg.name,
      class: skuCfg.class,
      par: skuCfg.par_level,
      on_hand: onHand.qty_on_hand,
      on_hand_as_of: onHand.as_of,
      on_hand_available: onHand.available,
      forecasted_usage_low: usagePurchaseUnits.low,
      forecasted_usage_expected: usagePurchaseUnits.expected,
      forecasted_usage_high: usagePurchaseUnits.high,
      suggested_order_qty: suggestedOrderQty,
      purchase_unit: skuCfg.purchase_unit,
      flex_pct: flexPct,
      order_days,
      due_today,
      est_cost: estCost,
      demand_flags: [],
    });
  }

  const report = {
    report_id: uid(),
    report_type: reportType,
    date_range: {
      start: forecastDays[0]?.date || null,
      end: forecastDays[forecastDays.length - 1]?.date || null,
    },
    generated_at: new Date().toISOString(),
    inventory_as_of: lines.find((l) => l.on_hand_as_of)?.on_hand_as_of || null,
    confidence_band: 'expected',
    budget_target: budgetTarget,
    lines,
    total_projected_spend: totalProjectedSpend,
    locked: false,
  };

  writeJSON(reportKey(reportType), report);
  return report;
}

export function getLatestReport(reportType) {
  return readJSON(reportKey(reportType), null);
}

export function updateLine(reportType, skuId, patch) {
  const report = getLatestReport(reportType);
  if (!report) throw new Error('No report to update');
  if (report.locked) throw new Error('Report is locked; cannot edit');

  const line = report.lines.find((l) => l.sku_id === skuId);
  if (!line) throw new Error(`SKU ${skuId} not found in report`);

  Object.assign(line, patch);
  report.total_projected_spend = report.lines.reduce((sum, l) => sum + (l.est_cost || 0), 0);
  writeJSON(reportKey(reportType), report);
  return report;
}

export function proposeAutoShave(reportType, targetSpend) {
  const report = getLatestReport(reportType);
  if (!report) throw new Error('No report to shave');

  const overage = report.total_projected_spend - targetSpend;
  if (overage <= 0) return { overage: 0, proposed_cuts: [] };

  const eligible = report.lines.filter((l) => l.flex_pct > 0 && l.est_cost > 0);
  const totalWeight = eligible.reduce((s, l) => s + l.flex_pct * l.est_cost, 0);

  const proposedCuts = eligible.map((l) => {
    const weight = (l.flex_pct * l.est_cost) / totalWeight;
    const rawCut = overage * weight;
    const maxCut = l.est_cost * (l.flex_pct / 100);
    const cutAmount = Math.min(rawCut, maxCut);
    const cutQtyUnits = l.suggested_order_qty * (cutAmount / l.est_cost);

    return {
      sku_id: l.sku_id,
      name: l.name,
      current_qty: l.suggested_order_qty,
      proposed_qty: Math.max(l.suggested_order_qty - cutQtyUnits, 0),
      cut_amount_dollars: cutAmount,
      flex_pct: l.flex_pct,
    };
  });

  return { overage, proposed_cuts: proposedCuts };
}

export function lockReport(reportType) {
  const report = getLatestReport(reportType);
  if (!report) throw new Error('No report to lock');
  report.locked = true;
  report.locked_at = new Date().toISOString();
  writeJSON(reportKey(reportType), report);
  return report;
}

export { aggregateUsageBySku };
