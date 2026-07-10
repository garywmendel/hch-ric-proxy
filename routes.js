// routes.js
// Mount in server.js with:
//   import ppcRoutes from './routes.js';
//   app.use('/api/ppc', ppcRoutes);
//
// This route file expects the following to be set on app.locals BEFORE
// mounting (see server.js wiring snippet in README):
//   app.locals.getGoTabToken       — your existing function
//   app.locals.goTabQuery          — your existing function
//   app.locals.fetchWithRetry      — your existing function
//   app.locals.GOTAB_LOCATION_UUID — your existing constant
//
// MarginEdge recipe sync is NOT wired here — see marginEdgeRecipes.js header,
// that integration doesn't exist yet and needs vendor/docs confirmation first.

import express from 'express';
import * as skuConfig from './skuConfig.js';
import { generateReport, getLatestReport, updateLine, proposeAutoShave, lockReport } from './report.js';
import { getCachedForecast, generateAndCacheForecast, dailyCoversFromChecks } from './demandForecast.js';
import { getCachedPmix, recalculatePmix } from './pmix.js';
import { fetchItemizedGoTabRange } from './gotabAdapter.js';
import {
  syncProducts,
  getCachedProducts,
  syncVendors,
  getCachedVendors,
  syncAllVendorItems,
  getCachedVendorItems,
  suggestSkuConfigEntries,
} from './marginEdgeProducts.js';

const router = express.Router();

// ---- Config endpoints ----

router.get('/config/sku', (req, res) => {
  res.json(skuConfig.getAllSkuConfig());
});

router.post('/config/sku', (req, res) => {
  try {
    res.json(skuConfig.upsertSkuConfig(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/config/sku/bulk', (req, res) => {
  try {
    res.json(skuConfig.bulkUpsertSkuConfig(req.body.entries || []));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/config/class-defaults', (req, res) => {
  res.json(skuConfig.getClassDefaults());
});

router.post('/config/class-defaults', (req, res) => {
  try {
    res.json(skuConfig.setClassDefaults(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Report generation ----

function buildDateWindow(days, startDate = null) {
  const out = [];
  const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    out.push({ date: d.toISOString().slice(0, 10), day_of_week: d.getDay() });
  }
  return out;
}

router.post('/generate', async (req, res) => {
  try {
    const {
      report_type = 'weekly',
      budget_target = null,
      cost_per_purchase_unit = {},
      start_date = null,
    } = req.body;
    const days = report_type === 'look_ahead_2wk' ? 14 : 7;

    const forecastCache = getCachedForecast();
    if (!forecastCache.rows || forecastCache.rows.length === 0) {
      return res.status(409).json({ error: 'No demand forecast available. Run /forecast/recalculate first.' });
    }

    const dateWindow = buildDateWindow(days, start_date);
    const forecastDays = dateWindow.map((d) => {
      const match = forecastCache.rows.find((r) => r.date === d.date);
      return match || { ...d, covers_low: 0, covers_expected: 0, covers_high: 0, reason_flags: [] };
    });

    const report = generateReport({
      reportType: report_type,
      forecastDays,
      budgetTarget: budget_target,
      costPerPurchaseUnit: cost_per_purchase_unit,
    });

    res.json(report);
  } catch (err) {
    console.error('[ppc/generate] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/latest', (req, res) => {
  const reportType = req.query.report_type || 'weekly';
  const report = getLatestReport(reportType);
  if (!report) return res.status(404).json({ error: 'No report generated yet' });
  res.json(report);
});

router.patch('/:report_id/line/:sku_id', (req, res) => {
  try {
    const reportType = req.body.report_type || req.query.report_type || 'weekly';
    res.json(updateLine(reportType, req.params.sku_id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:report_id/auto-shave', (req, res) => {
  try {
    const { target_spend, report_type = 'weekly' } = req.body;
    res.json(proposeAutoShave(report_type, target_spend));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:report_id/lock', (req, res) => {
  try {
    const reportType = req.body.report_type || req.query.report_type || 'weekly';
    res.json(lockReport(reportType));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Upstream sync/recalculation triggers ----

router.post('/pmix/recalculate', async (req, res) => {
  try {
    const deps = {
      getGoTabToken: req.app.locals.getGoTabToken,
      goTabQuery: req.app.locals.goTabQuery,
      fetchWithRetry: req.app.locals.fetchWithRetry,
      GOTAB_LOCATION_UUID: req.app.locals.GOTAB_LOCATION_UUID,
    };
    if (!deps.getGoTabToken || !deps.goTabQuery || !deps.fetchWithRetry || !deps.GOTAB_LOCATION_UUID) {
      return res.status(501).json({
        error: 'GoTab dependencies not wired into app.locals yet (getGoTabToken, goTabQuery, fetchWithRetry, GOTAB_LOCATION_UUID).',
      });
    }
    const pmix = await recalculatePmix(deps);
    res.json(pmix);
  } catch (err) {
    console.error('[ppc/pmix/recalculate] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Convenience endpoint: pulls itemized GoTab data once and uses it for BOTH
// pmix recalculation and demand forecast covers, so you're not hitting
// GoTab's API twice for the same underlying data.
router.post('/forecast/recalculate-from-gotab', async (req, res) => {
  try {
    const deps = {
      getGoTabToken: req.app.locals.getGoTabToken,
      goTabQuery: req.app.locals.goTabQuery,
      fetchWithRetry: req.app.locals.fetchWithRetry,
      GOTAB_LOCATION_UUID: req.app.locals.GOTAB_LOCATION_UUID,
    };
    if (!deps.getGoTabToken || !deps.goTabQuery || !deps.fetchWithRetry || !deps.GOTAB_LOCATION_UUID) {
      return res.status(501).json({ error: 'GoTab dependencies not wired into app.locals yet.' });
    }

    const { days = 7, start_date = null, anomalies = [] } = req.body;
    const checks = await fetchItemizedGoTabRange(deps, 6); // 6 trailing weeks for baseline
    const dailyCovers = dailyCoversFromChecks(checks);

    const dateWindow = buildDateWindow(days, start_date);
    const forecast = await generateAndCacheForecast(dailyCovers, dateWindow, anomalies);
    res.json(forecast);
  } catch (err) {
    console.error('[ppc/forecast/recalculate-from-gotab] error', err);
    res.status(500).json({ error: err.message });
  }
});

// Manual-trigger variant — supply daily_covers yourself (useful for testing
// the forecast math against known numbers before GoTab wiring is confirmed).
router.post('/forecast/recalculate', async (req, res) => {
  try {
    const { daily_covers, dates_to_forecast, anomalies } = req.body;
    if (!daily_covers || !dates_to_forecast) {
      return res.status(400).json({
        error: 'daily_covers and dates_to_forecast required in body, OR use /forecast/recalculate-from-gotab instead.',
      });
    }
    const forecast = await generateAndCacheForecast(daily_covers, dates_to_forecast, anomalies || []);
    res.json(forecast);
  } catch (err) {
    console.error('[ppc/forecast/recalculate] error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- MarginEdge products/vendors sync (confirmed-real endpoints) ----
// Requires app.locals.fetchWithRetry, app.locals.MARGINEDGE_API_KEY,
// app.locals.MARGINEDGE_TENANT_ID — see README wiring section.

function meDeps(req) {
  return {
    fetchWithRetry: req.app.locals.fetchWithRetry,
    MARGINEDGE_API_KEY: req.app.locals.MARGINEDGE_API_KEY,
    MARGINEDGE_TENANT_ID: req.app.locals.MARGINEDGE_TENANT_ID,
  };
}

function meDepsMissing(deps) {
  return !deps.fetchWithRetry || !deps.MARGINEDGE_API_KEY || !deps.MARGINEDGE_TENANT_ID;
}

router.post('/marginedge/sync-products', async (req, res) => {
  try {
    const deps = meDeps(req);
    if (meDepsMissing(deps)) {
      return res.status(501).json({ error: 'MarginEdge deps not wired into app.locals yet.' });
    }
    res.json(await syncProducts(deps));
  } catch (err) {
    console.error('[ppc/marginedge/sync-products] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/marginedge/products', (req, res) => {
  res.json(getCachedProducts());
});

router.post('/marginedge/sync-vendors', async (req, res) => {
  try {
    const deps = meDeps(req);
    if (meDepsMissing(deps)) {
      return res.status(501).json({ error: 'MarginEdge deps not wired into app.locals yet.' });
    }
    res.json(await syncVendors(deps));
  } catch (err) {
    console.error('[ppc/marginedge/sync-vendors] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/marginedge/vendors', (req, res) => {
  res.json(getCachedVendors());
});

router.post('/marginedge/sync-vendor-items', async (req, res) => {
  try {
    const deps = meDeps(req);
    if (meDepsMissing(deps)) {
      return res.status(501).json({ error: 'MarginEdge deps not wired into app.locals yet.' });
    }
    res.json(await syncAllVendorItems(deps));
  } catch (err) {
    console.error('[ppc/marginedge/sync-vendor-items] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/marginedge/vendor-items', (req, res) => {
  res.json(getCachedVendorItems());
});

// Preview-only suggested sku_config entries built from synced product/vendor
// data — does NOT write to sku_config. Review and POST the ones you want via
// /config/sku/bulk.
router.get('/marginedge/suggest-sku-config', (req, res) => {
  try {
    res.json(suggestSkuConfigEntries());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
