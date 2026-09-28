// agentRicRoutes.js
// Mount alongside the other route modules:
//   import agentRicRoutes from './agentRicRoutes.js';
//   app.use('/api/agent-ric', agentRicRoutes);
//
// Needs these added to app.locals (in addition to what's already wired
// for PPC/insights — getGoTabToken, goTabQuery, fetchWithRetry,
// GOTAB_LOCATION_UUID, normalizeGoTab, nextDay, fetch7Shifts):
//   app.locals.fetchTripleSeat = fetchTripleSeat;
//   app.locals.fetchMailchimp  = fetchMailchimp;
//   app.locals.fetchYelp       = fetchYelp;
//
// Nothing in this file can send email. sendRecapEmail (weeklyRecap.js)
// requires deps.sendGmail, which is intentionally not wired here yet —
// see that file's header for what's needed before it can.

import express from 'express';
import { captureSnapshot, getSnapshot, getRecentSnapshots, getSnapshotIndex } from './dailySnapshot.js';
import {
  generateDraft,
  getDraft,
  updateDraft,
  approveDraft,
  sendRecapEmail,
} from './weeklyRecap.js';

const router = express.Router();

function snapshotDeps(req) {
  return {
    getGoTabToken: req.app.locals.getGoTabToken,
    goTabQuery: req.app.locals.goTabQuery,
    fetchWithRetry: req.app.locals.fetchWithRetry,
    GOTAB_LOCATION_UUID: req.app.locals.GOTAB_LOCATION_UUID,
    normalizeGoTab: req.app.locals.normalizeGoTab,
    nextDay: req.app.locals.nextDay,
    fetch7Shifts: req.app.locals.fetch7Shifts,
    fetchTripleSeat: req.app.locals.fetchTripleSeat,
    fetchMailchimp: req.app.locals.fetchMailchimp,
    fetchYelp: req.app.locals.fetchYelp,
  };
}

// ---- Daily snapshots ----

// Manual/backfill trigger — body: { date?: "YYYY-MM-DD" }, defaults to
// "yesterday" in ET (the normal nightly behavior). Useful for testing
// before the 2am scheduler has had a chance to run, or for backfilling
// a specific day.
router.post('/snapshot/capture', async (req, res) => {
  try {
    const deps = snapshotDeps(req);
    const snapshot = await captureSnapshot(deps, req.body?.date);
    res.json(snapshot);
  } catch (err) {
    console.error('[agent-ric/snapshot/capture] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/snapshot/index', (req, res) => {
  res.json({ dates: getSnapshotIndex() });
});

router.get('/snapshot/recent', (req, res) => {
  const days = parseInt(req.query.days, 10) || 7;
  res.json({ days_requested: days, snapshots: getRecentSnapshots(days) });
});

router.get('/snapshot/:date', (req, res) => {
  const snapshot = getSnapshot(req.params.date);
  if (!snapshot) return res.status(404).json({ error: `No snapshot for ${req.params.date}.` });
  res.json(snapshot);
});

// ---- Weekly recap draft ----

// body: { days?: number } — defaults to 7. Overwrites whatever draft is
// currently pending (there's only ever one active draft at a time).
router.post('/weekly-recap/generate', (req, res) => {
  try {
    const days = req.body?.days || 7;
    res.json(generateDraft(days));
  } catch (err) {
    console.error('[agent-ric/weekly-recap/generate] error', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/weekly-recap/draft', (req, res) => {
  const draft = getDraft();
  if (!draft) return res.status(404).json({ error: 'No draft yet — call /weekly-recap/generate first.' });
  res.json(draft);
});

// Edit the draft before approving — body can include any of: subject,
// recipients (array of email strings), body_text.
router.patch('/weekly-recap/draft', (req, res) => {
  try {
    res.json(updateDraft(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Marks the draft approved. Does NOT send — sending is still a separate
// explicit call to /weekly-recap/send.
router.post('/weekly-recap/approve', (req, res) => {
  try {
    res.json(approveDraft());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Will currently always fail with a clear explanation — Gmail send isn't
// wired up yet (needs the gmail.send OAuth scope added and re-auth). See
// weeklyRecap.js's sendRecapEmail for exactly what's missing.
router.post('/weekly-recap/send', async (req, res) => {
  try {
    const deps = { sendGmail: req.app.locals.sendGmail };
    res.json(await sendRecapEmail(deps));
  } catch (err) {
    res.status(501).json({ error: err.message });
  }
});

export default router;
