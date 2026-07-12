// insightsRoutes.js
// Mount alongside the PPC routes:
//   import insightsRoutes from './insightsRoutes.js';
//   app.use('/api/insights', insightsRoutes);
//
// Reuses the same app.locals wiring as the PPC module (getGoTabToken,
// goTabQuery, fetchWithRetry, GOTAB_LOCATION_UUID) plus two ADDITIONAL
// items that need adding to app.locals for primeCostTrend to work:
//   app.locals.fetch7Shifts = fetch7Shifts;
//   app.locals.fetchQuickBooks = fetchQuickBooks;
//   app.locals.normalizeGoTab = normalizeGoTab;
//   app.locals.nextDay = nextDay;   // the helper added in the GoTab range fix

import express from 'express';
import {
  importMenuItemCostsCSV,
  getCachedMenuCosts,
  getAliases,
  setAlias,
  recalculateVelocity,
  getCachedVelocity,
  buildMenuEngineeringMatrix,
} from './menuEngineering.js';
import {
  refreshBaseline,
  getCachedBaseline,
  computeDailyPrimeCostTrend,
  getCachedTrend,
} from './primeCostTrend.js';

const router = express.Router();

function gotabDeps(req) {
  return {
    getGoTabToken: req.app.locals.getGoTabToken,
    goTabQuery: req.app.locals.goTabQuery,
    fetchWithRetry: req.app.locals.fetchWithRetry,
    GOTAB_LOCATION_UUID: req.app.locals.GOTAB_LOCATION_UUID,
  };
}
function gotabDepsMissing(deps) {
  return !deps.getGoTabToken || !deps.goTabQuery || !deps.fetchWithRetry || !deps.GOTAB_LOCATION_UUID;
}

// ---- Menu Engineering ----

// Upload a MarginEdge "Menu Items" (or "Prepared Items") CSV export as raw
// text in the request body (Content-Type: text/plain or send as JSON
// { csv: "..." } — this accepts either).
router.post('/menu-engineering/import-costs', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  try {
    const csvText = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (!csvText) return res.status(400).json({ error: 'No CSV content received in request body.' });
    res.json(importMenuItemCostsCSV(csvText));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/menu-engineering/costs', (req, res) => {
  res.json(getCachedMenuCosts());
});

router.get('/menu-engineering/aliases', (req, res) => {
  res.json(getAliases());
});

router.post('/menu-engineering/aliases', (req, res) => {
  try {
    const { gotab_name, me_name } = req.body;
    if (!gotab_name || !me_name) return res.status(400).json({ error: 'gotab_name and me_name required' });
    res.json(setAlias(gotab_name, me_name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/menu-engineering/recalculate-velocity', async (req, res) => {
  try {
    const deps = gotabDeps(req);
    if (gotabDepsMissing(deps)) return res.status(501).json({ error: 'GoTab deps not wired into app.locals yet.' });
    const weeks = req.body?.weeks || 4;
    res.json(await recalculateVelocity(deps, weeks));
  } catch (err) {
    console.error('[insights/menu-engineering/recalculate-velocity] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/menu-engineering/velocity', (req, res) => {
  res.json(getCachedVelocity());
});

router.get('/menu-engineering/matrix', (req, res) => {
  try {
    res.json(buildMenuEngineeringMatrix());
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// ---- Prime Cost Trend ----

router.post('/prime-cost/refresh-baseline', async (req, res) => {
  try {
    const fetchQuickBooks = req.app.locals.fetchQuickBooks;
    if (!fetchQuickBooks) return res.status(501).json({ error: 'fetchQuickBooks not wired into app.locals yet.' });
    res.json(await refreshBaseline({ fetchQuickBooks }));
  } catch (err) {
    console.error('[insights/prime-cost/refresh-baseline] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/prime-cost/baseline', (req, res) => {
  const baseline = getCachedBaseline();
  if (!baseline) return res.status(404).json({ error: 'No baseline yet — call /prime-cost/refresh-baseline first.' });
  res.json(baseline);
});

router.post('/prime-cost/recalculate-trend', async (req, res) => {
  try {
    const deps = {
      ...gotabDeps(req),
      normalizeGoTab: req.app.locals.normalizeGoTab,
      nextDay: req.app.locals.nextDay,
      fetch7Shifts: req.app.locals.fetch7Shifts,
    };
    if (gotabDepsMissing(deps) || !deps.normalizeGoTab || !deps.nextDay || !deps.fetch7Shifts) {
      return res.status(501).json({ error: 'Required deps not wired into app.locals yet (normalizeGoTab, nextDay, fetch7Shifts, plus the usual GoTab deps).' });
    }
    const days = req.body?.days || 14;
    res.json(await computeDailyPrimeCostTrend(deps, days));
  } catch (err) {
    console.error('[insights/prime-cost/recalculate-trend] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/prime-cost/trend', (req, res) => {
  res.json(getCachedTrend());
});

export default router;
