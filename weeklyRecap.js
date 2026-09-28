// weeklyRecap.js
// Builds the Agent RIC weekly recap draft from persisted daily snapshots
// (dailySnapshot.js) — never sends anything itself. Every draft sits as
// pending_approval until a human explicitly approves it; this file has no
// code path that sends email on its own.
//
// Only summarizes numbers RIC actually has real feeds for (GoTab net
// sales, 7Shifts labor, the Prime Cost Trend blend, TripleSeat pipeline,
// Mailchimp, Yelp). Deliberately does NOT invent a "Watch List" section —
// that would need a real backing data source that doesn't exist yet.
//
// deps required for generateDraft(): none directly (reads only from
// storage via dailySnapshot.js). deps required for sendRecapEmail(): a
// working Gmail-send capability, which does not exist yet — see the
// error it throws for what's needed.

import { readJSON, writeJSON } from './storage.js';
import { getRecentSnapshots } from './dailySnapshot.js';

const DRAFT_KEY = 'ric_weekly_recap_draft';

export const DEFAULT_RECIPIENTS = [
  'gary@skypie.com',
  'marc@hillcountry.com',
  'angelo@hillcountry.com',
  'ACampos@hillcountry.com',
  'TShewchand@hillcountry.com',
];

function fmtMoney(n) {
  if (n == null) return 'n/a';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtPct(n) {
  if (n == null) return 'n/a';
  return `${n.toFixed(1)}%`;
}

function average(nums) {
  const vals = nums.filter((n) => n != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Builds the recap content from whatever snapshots exist for the last 7
// calendar days. Does not require exactly 7 — flags it plainly if fewer
// are available (e.g. right after this feature is first deployed, or
// around the Oct 1 reopening when the prior week was mostly shutdown).
export function buildRecapContent(days = 7) {
  const snapshots = getRecentSnapshots(days);
  const daysAvailable = snapshots.length;

  const revenueDays = snapshots.filter((s) => s.net_sales != null);
  const totalRevenue = revenueDays.reduce((a, s) => a + s.net_sales, 0);
  const avgDailyRevenue = revenueDays.length ? totalRevenue / revenueDays.length : null;

  const avgPrimeCostPct = average(snapshots.map((s) => s.prime_cost_pct));

  const firstTs = snapshots.find((s) => s.tripleseat)?.tripleseat || null;
  const lastTs = [...snapshots].reverse().find((s) => s.tripleseat)?.tripleseat || null;
  const pipelineDelta = (firstTs && lastTs)
    ? +(lastTs.total_pipeline - firstTs.total_pipeline).toFixed(2)
    : null;

  const latestMailchimp = [...snapshots].reverse().find((s) => s.mailchimp)?.mailchimp || null;
  const latestYelp = [...snapshots].reverse().find((s) => s.yelp)?.yelp || null;

  const bullets = [];

  if (daysAvailable < days) {
    bullets.push(
      `Note: only ${daysAvailable} of the last ${days} days have snapshot data available ` +
      `(this feature just started collecting history, or some days had no data captured) — ` +
      `figures below reflect ${daysAvailable} day(s), not a full week.`
    );
  }

  bullets.push(
    revenueDays.length
      ? `Revenue: ${fmtMoney(totalRevenue)} total over ${revenueDays.length} day(s), averaging ${fmtMoney(avgDailyRevenue)}/day.`
      : `Revenue: no data available for this period.`
  );

  bullets.push(
    avgPrimeCostPct != null
      ? `Prime cost: averaging ${fmtPct(avgPrimeCostPct)} over the period (COGS estimated from the Prime Cost Trend baseline, labor is actual).`
      : `Prime cost: no data available for this period.`
  );

  if (pipelineDelta != null) {
    const dir = pipelineDelta >= 0 ? 'up' : 'down';
    bullets.push(`Events pipeline (TripleSeat): total pipeline value ${dir} ${fmtMoney(Math.abs(pipelineDelta))} over the period, now at ${fmtMoney(lastTs.total_pipeline)} (${lastTs.open_leads} open leads).`);
  } else {
    bullets.push(`Events pipeline: no TripleSeat data available for this period.`);
  }

  if (latestMailchimp) {
    bullets.push(`Email: 30-day open rate ${fmtPct(latestMailchimp.open_rate_30d)}, net list growth ${latestMailchimp.net_list_growth_30d >= 0 ? '+' : ''}${latestMailchimp.net_list_growth_30d ?? 'n/a'} over the last 30 days.`);
  }

  if (latestYelp) {
    bullets.push(`Yelp: ${latestYelp.rating} stars across ${latestYelp.review_count} reviews.`);
  }

  return {
    period_days_requested: days,
    period_days_available: daysAvailable,
    period_start: snapshots[0]?.date || null,
    period_end: snapshots[snapshots.length - 1]?.date || null,
    bullets,
  };
}

export function generateDraft(days = 7) {
  const content = buildRecapContent(days);

  const subject = content.period_start && content.period_end
    ? `Hill Country Weekly Recap — ${content.period_start} to ${content.period_end}`
    : `Hill Country Weekly Recap`;

  const bodyText = [
    `Weekly Recap — ${content.period_start || '?'} to ${content.period_end || '?'}`,
    '',
    ...content.bullets.map((b) => `• ${b}`),
    '',
    '— Generated by Agent RIC. Review and edit before sending.',
  ].join('\n');

  const draft = {
    status: 'pending_approval',
    generated_at: new Date().toISOString(),
    subject,
    recipients: [...DEFAULT_RECIPIENTS],
    body_text: bodyText,
    bullets: content.bullets,
    period_start: content.period_start,
    period_end: content.period_end,
    period_days_available: content.period_days_available,
    edited: false,
    approved_at: null,
    sent_at: null,
  };

  writeJSON(DRAFT_KEY, draft);
  return draft;
}

export function getDraft() {
  return readJSON(DRAFT_KEY, null);
}

// Lets the recipient list, subject, or body be edited before send —
// re-saves with edited: true so it's clear in the record that a human
// changed the auto-generated content.
export function updateDraft(patch) {
  const draft = getDraft();
  if (!draft) throw new Error('No draft exists yet — call generateDraft first.');
  if (draft.status === 'sent') throw new Error('This draft was already sent — generate a new one instead of editing a sent draft.');

  const updated = {
    ...draft,
    ...('subject' in patch ? { subject: patch.subject } : {}),
    ...('recipients' in patch ? { recipients: patch.recipients } : {}),
    ...('body_text' in patch ? { body_text: patch.body_text } : {}),
    edited: true,
  };

  writeJSON(DRAFT_KEY, updated);
  return updated;
}

// Explicit human approval step — required before sendRecapEmail will do
// anything. Approving does NOT send; it only marks the draft ready, so
// the actual send is still a separate, deliberate action.
export function approveDraft() {
  const draft = getDraft();
  if (!draft) throw new Error('No draft exists yet — call generateDraft first.');
  if (draft.status === 'sent') throw new Error('This draft was already sent.');

  const updated = { ...draft, status: 'approved', approved_at: new Date().toISOString() };
  writeJSON(DRAFT_KEY, updated);
  return updated;
}

// deps: { sendGmail } — sendGmail(deps, { to: [...], subject, body }) must
// be implemented against a Gmail API client authorized with the
// gmail.send scope. That does NOT exist yet: the existing Google OAuth
// client is scoped to drive.readonly only (see server.js /auth/google-drive).
// Adding gmail.send requires widening that scope and re-authorizing (the
// existing refresh token won't cover the new scope) — a deliberate step
// to take with sign-off before wiring this live, not something to do
// silently. Until then this throws rather than pretending to send.
export async function sendRecapEmail(deps) {
  const draft = getDraft();
  if (!draft) throw new Error('No draft exists yet — call generateDraft first.');
  if (draft.status !== 'approved') throw new Error(`Draft must be approved before sending (current status: ${draft.status}).`);
  if (draft.sent_at) throw new Error('This draft was already sent.');

  if (!deps.sendGmail) {
    throw new Error(
      'Gmail send is not wired up yet. The Google OAuth client is currently scoped to ' +
      'drive.readonly only — sending mail needs the gmail.send scope added and the ' +
      'account re-authorized at /auth/google-drive (the existing refresh token does not ' +
      'cover gmail.send). This is a deliberate step to confirm before enabling, not ' +
      'something to turn on silently.'
    );
  }

  await deps.sendGmail({ to: draft.recipients, subject: draft.subject, body: draft.body_text });

  const updated = { ...draft, status: 'sent', sent_at: new Date().toISOString() };
  writeJSON(DRAFT_KEY, updated);
  return updated;
}

// In-process weekly scheduler — checks every 15 minutes whether it's
// Monday, ~6am ET, and no draft has been generated yet today. Generates
// automatically; sending still always requires a separate human approval
// + send action (see approveDraft/sendRecapEmail above).
export function scheduleWeeklyDraft({ checkIntervalMs = 15 * 60 * 1000 } = {}) {
  let lastGeneratedDate = null;

  function tick() {
    try {
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const isMonday = nowET.getDay() === 1;
      const hour = nowET.getHours();
      const todayStr = nowET.toISOString().slice(0, 10);

      if (!isMonday || hour !== 6) return;
      if (lastGeneratedDate === todayStr) return;

      console.log('[weeklyRecap] generating Monday draft');
      generateDraft(7);
      lastGeneratedDate = todayStr;
      console.log('[weeklyRecap] draft generated and pending approval');
    } catch (err) {
      console.error('[weeklyRecap] scheduled generation failed:', err.message);
    }
  }

  tick(); // in case the server restarts right in the Monday 6am window
  return setInterval(tick, checkIntervalMs);
}
