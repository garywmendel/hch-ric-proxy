// ============================================================================
// RIC — Restaurant Intelligence Controller
// Hill Country BBQ NY  ·  Proxy server (Node.js / Express)
//
// Live adapters: GoTab, QuickBooks, MarginEdge, Mailchimp, TripleSeat
// Mock adapters: 7Shifts, OpenTable, Marqii, GA4, DoorDash, Microsoft 365
//
// Deploy: Railway  ·  Domain: ric.up.railway.app
// ============================================================================

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ============================================================================
// Utilities
// ============================================================================

const round1 = n => Math.round(Number(n || 0) * 10) / 10;
const round2 = n => Math.round(Number(n || 0) * 100) / 100;

const addDays = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};

const today = () => new Date().toISOString().slice(0, 10);

const safe = async (label, fn) => {
  try {
    const data = await fn();
    return { status: 'live', system: label, data };
  } catch (err) {
    console.error(`[${label}] failed:`, err.message);
    return { status: 'error', system: label, error: err.message, data: null };
  }
};

// ============================================================================
// Mock data — for the 6 not-yet-live sources
// ============================================================================

const MOCK = {
  '7shifts':  { scheduled_hours: 184, actual_hours: 191, labor_cost: 5730, labor_pct: 26.8, overtime_hours: 14, no_shows: 1 },
  opentable:  { reservations: 87, covers: 198, no_shows: 6, peak_time: '7:30 PM', waitlist: 12 },
  marqii:     { avg_rating: 4.6, new_reviews: 8, positive: 6, negative: 1, response_rate: 88 },
  ga4:        { sessions: 1840, users: 1210, online_orders: 43, conversion_rate: 2.3 },
  doordash:   { orders: 68, delivery_revenue: 1820, avg_order_value: 26.76, cancelled: 2, avg_rating: 4.7 },
  m365:       { unread_emails: 7, flagged_items: 2, meetings_today: 3 },
};

// ============================================================================
// Adapter 1 — GoTab (POS, GraphQL)
// ============================================================================

const GOTAB_GQL = 'https://gotab.io/api/graphql';
const GOTAB_LOCATION_ID = 'b_CS2Ut2nHzyjRhZX_690wSH';

const GOTAB_QUERY = `
  query DailyAggregates($locationId: ID!, $start: DateTime!, $end: DateTime!) {
    location(id: $locationId) {
      accountingStreams(start: $start, end: $end) {
        name
        category
        amountCents
      }
      orderStats(start: $start, end: $end) {
        tabCount
        coverCount
      }
    }
  }
`;

async function fetchGoTab({ date = today() } = {}) {
  const start = `${date}T00:00:00Z`;
  const end   = `${date}T23:59:59Z`;

  const res = await fetch(GOTAB_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GOTAB_TOKEN}`,
    },
    body: JSON.stringify({ query: GOTAB_QUERY, variables: { locationId: GOTAB_LOCATION_ID, start, end } }),
  });

  if (!res.ok) throw new Error(`GoTab HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GoTab GQL: ${JSON.stringify(json.errors)}`);

  const loc     = json.data.location;
  const streams = loc.accountingStreams || [];
  const stats   = loc.orderStats || {};

  const sum = pred => streams.filter(pred).reduce((s, x) => s + (x.amountCents || 0), 0) / 100;

  const net_sales        = sum(s => s.category === 'NET_SALES' && s.name !== 'Bar');
  const bar_sales        = sum(s => s.category === 'NET_SALES' && s.name === 'Bar');
  const catering_sales   = sum(s => s.name === 'Catering');
  const comps            = sum(s => s.category === 'COMP');
  const voids            = sum(s => s.category === 'VOID');
  const tax_total        = sum(s => s.category === 'TAX');
  const tip_total        = sum(s => s.category === 'TIP');
  const deferred_revenue = sum(s => s.category === 'DEFERRED');

  const covers     = stats.coverCount ?? stats.tabCount ?? 0;
  const grossSales = net_sales + comps + voids;

  return {
    // existing
    net_sales, bar_sales, catering_sales,
    comps, voids, tax_total, tip_total, deferred_revenue,
    // new
    covers,
    ppa:           covers > 0     ? round2(net_sales / covers)            : 0,
    bar_mix_pct:   net_sales > 0  ? round2((bar_sales / net_sales) * 100) : 0,
    comp_void_pct: grossSales > 0 ? round2(((comps + voids) / grossSales) * 100) : 0,
  };
}

// ============================================================================
// Adapter 2 — QuickBooks Online (P&L report)
// ============================================================================

const QB_BASE = 'https://quickbooks.api.intuit.com';

// Walk QB report tree recursively, return total amount for any group/account
// whose label matches any of the provided needles (case-insensitive substring).
function qbFindAmount(node, needles) {
  if (!node) return 0;
  const n = needles.map(x => x.toLowerCase());
  const rows = node.Rows?.Row || (Array.isArray(node) ? node : []);
  let total = 0;

  for (const row of rows) {
    const headerName = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
    if (n.some(x => headerName.includes(x))) {
      const sum = row.Summary?.ColData?.slice(-1)[0]?.value;
      if (sum != null) total += Number(sum) || 0;
      continue;
    }

    const leafName = (row.ColData?.[0]?.value || '').toLowerCase();
    if (row.ColData && n.some(x => leafName.includes(x))) {
      const amt = row.ColData.slice(-1)[0]?.value;
      total += Number(amt) || 0;
      continue;
    }

    if (row.Rows) total += qbFindAmount(row, needles);
  }

  return total;
}

async function qbAccessToken() {
  // OAuth refresh — exchanges refresh_token for an access_token each call.
  // For higher volume, cache in memory with TTL (~55 min) keyed by realm.
  const refresh = process.env.QB_REFRESH_TOKEN;
  const id      = process.env.QB_CLIENT_ID;
  const secret  = process.env.QB_CLIENT_SECRET;
  const auth    = Buffer.from(`${id}:${secret}`).toString('base64');

  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${refresh}`,
  });

  if (!res.ok) throw new Error(`QB token ${res.status}: ${await res.text()}`);
  const json = await res.json();

  // If Intuit rotated the refresh token, persist via Railway GraphQL API.
  if (json.refresh_token && json.refresh_token !== refresh) {
    await persistQBRefreshToken(json.refresh_token).catch(e =>
      console.error('[qb] refresh-token persist failed:', e.message)
    );
  }

  return json.access_token;
}

async function persistQBRefreshToken(newToken) {
  // Use Railway's account API to update the QB_REFRESH_TOKEN env var.
  // Requires RAILWAY_API_TOKEN, RAILWAY_PROJECT_ID, RAILWAY_SERVICE_ID, RAILWAY_ENV_ID.
  if (!process.env.RAILWAY_API_TOKEN) return;

  const mutation = `
    mutation($input: VariableUpsertInput!) {
      variableUpsert(input: $input)
    }
  `;

  await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RAILWAY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        input: {
          projectId:     process.env.RAILWAY_PROJECT_ID,
          serviceId:     process.env.RAILWAY_SERVICE_ID,
          environmentId: process.env.RAILWAY_ENV_ID,
          name:          'QB_REFRESH_TOKEN',
          value:         newToken,
        },
      },
    }),
  });
}

async function fetchQuickBooks({ startDate, endDate } = {}) {
  const t = endDate ? new Date(endDate) : new Date();
  const start = startDate || `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`;
  const end   = endDate   || today();

  const accessToken = await qbAccessToken();
  const realmId     = process.env.QB_REALM_ID;

  const url =
    `${QB_BASE}/v3/company/${realmId}/reports/ProfitAndLoss` +
    `?start_date=${start}&end_date=${end}&summarize_column_by=Total&minorversion=70`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`QuickBooks ${res.status}: ${await res.text()}`);
  const report = await res.json();

  const total_revenue      = qbFindAmount(report, ['total income', 'income']);
  const cogs               = qbFindAmount(report, ['total cost of goods sold', 'cost of goods sold']);
  const gross_profit       = total_revenue - cogs;
  const operating_expenses = qbFindAmount(report, ['total expenses', 'expenses']);
  const net_income         = qbFindAmount(report, ['net income']) || (gross_profit - operating_expenses);

  const labor    = qbFindAmount(report, ['payroll expenses', 'contract labor', 'wages']);
  const rent     = qbFindAmount(report, ['rent']);
  const utils    = qbFindAmount(report, ['utilities']);
  const insur    = qbFindAmount(report, ['insurance']);
  const interest = qbFindAmount(report, ['interest expense']);
  const tax      = qbFindAmount(report, ['income tax']);
  const depr     = qbFindAmount(report, ['depreciation', 'amortization']);

  return {
    // existing
    total_revenue,
    cogs,
    gross_profit,
    operating_expenses,
    net_income,
    period: { start, end },
    // new
    labor_expense:      labor,
    prime_cost_pct:     total_revenue > 0 ? round2(((cogs + labor) / total_revenue) * 100) : 0,
    occupancy_cost_pct: total_revenue > 0 ? round2(((rent + utils + insur) / total_revenue) * 100) : 0,
    ebitda:             net_income + interest + tax + depr,
    ebitda_margin:      total_revenue > 0 ? round2(((net_income + interest + tax + depr) / total_revenue) * 100) : 0,
  };
}

// ============================================================================
// Adapter 3 — MarginEdge (food cost)
// ============================================================================

const ME_BASE = 'https://api.marginedge.com';

async function meFetch(path, params = {}) {
  const url = new URL(`${ME_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${process.env.MARGINEDGE_API_KEY}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`MarginEdge ${path} ${res.status}`);
  return res.json();
}

function meSumCategory(usage, needles) {
  if (!usage?.items) return 0;
  const n = needles.map(x => x.toLowerCase());
  return usage.items
    .filter(i => n.some(x => (i.category || '').toLowerCase().includes(x)))
    .reduce((s, i) => s + Number(i.amount || 0), 0);
}

async function fetchMarginEdge({ startDate, endDate } = {}) {
  const t = endDate ? new Date(endDate) : new Date();
  const start = startDate || `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-01`;
  const end   = endDate   || today();

  const [usage, inventory, variance] = await Promise.all([
    meFetch('/api/v2/usage', { start_date: start, end_date: end }),
    meFetch('/api/v2/inventory/current').catch(() => null),
    meFetch('/api/v2/reports/usage-variance', { start_date: start, end_date: end }).catch(() => null),
  ]);

  const categories = {
    meat:   meSumCategory(usage, ['meat', 'protein']),
    liquor: meSumCategory(usage, ['liquor', 'spirits']),
    wine:   meSumCategory(usage, ['wine']),
    beer:   meSumCategory(usage, ['beer']),
    other:  meSumCategory(usage, ['other', 'paper', 'supplies']),
  };
  const food_cost = Object.values(categories).reduce((s, v) => s + v, 0);

  const inventory_on_hand = inventory ? Number(inventory.total_value || 0) : 0;
  const days      = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
  const dailyCogs = food_cost / days;
  const days_on_hand = dailyCogs > 0 ? round1(inventory_on_hand / dailyCogs) : 0;

  const theo_actual_variance_pct = variance ? round2(Number(variance.total_variance_pct || 0)) : 0;

  return {
    food_cost,
    categories,
    period: { start, end },
    // new
    inventory_on_hand,
    days_on_hand,
    theo_actual_variance_pct,
  };
}

// ============================================================================
// Adapter 4 — Mailchimp (marketing)
// ============================================================================

async function mcFetch(path) {
  const base = `https://${process.env.MAILCHIMP_DC}.api.mailchimp.com/3.0`;
  const res  = await fetch(`${base}${path}`, {
    headers: { 'Authorization': `Bearer ${process.env.MAILCHIMP_API_KEY}`, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`Mailchimp ${path} ${res.status}`);
  return res.json();
}

async function fetchMailchimp() {
  const LIST_ID = process.env.MAILCHIMP_LIST_ID;

  const [campaigns, list] = await Promise.all([
    mcFetch(`/campaigns?status=sent&count=1&sort_field=send_time&sort_dir=DESC&list_id=${LIST_ID}`),
    mcFetch(`/lists/${LIST_ID}`),
  ]);

  const latest  = campaigns.campaigns?.[0];
  const report  = latest ? await mcFetch(`/reports/${latest.id}`) : null;

  const emails_sent   = report?.emails_sent ?? 0;
  const opens_unique  = report?.opens?.unique_opens  ?? 0;
  const clicks_unique = report?.clicks?.unique_clicks ?? 0;
  const unsubscribed  = report?.unsubscribed ?? 0;
  const open_rate     = report?.opens?.open_rate   ? round2(report.opens.open_rate * 100)   : 0;
  const click_rate    = report?.clicks?.click_rate ? round2(report.clicks.click_rate * 100) : 0;

  return {
    // existing
    emails_sent,
    open_rate,
    click_rate,
    last_campaign: latest?.settings?.subject_line || null,
    // new
    list_size:        list?.stats?.member_count ?? 0,
    unsubscribe_rate: emails_sent > 0  ? round2((unsubscribed / emails_sent)  * 100) : 0,
    ctor:             opens_unique > 0 ? round2((clicks_unique / opens_unique) * 100) : 0,
  };
}

// ============================================================================
// Adapter 5 — TripleSeat (events)
// ============================================================================

async function tsFetch(path, params = {}) {
  const url = new URL(`https://api.tripleseat.com/v1${path}`);
  url.searchParams.set('api_key', process.env.TRIPLESEAT_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`TripleSeat ${path} ${res.status}`);
  return res.json();
}

const tsSumRev = arr =>
  (arr.events || []).reduce(
    (s, e) => s + Number(e.total_event_revenue ?? e.estimated_total ?? 0),
    0
  );

async function fetchTripleSeat() {
  const t      = today();
  const back30 = addDays(t, -30);
  const fwd30  = addDays(t, 30);
  const fwd60  = addDays(t, 60);
  const fwd90  = addDays(t, 90);

  const [todayEvents, leads, pipe30, pipe60, pipe90, bookings30] = await Promise.all([
    tsFetch('/events.json', { start_date: t,      end_date: t }),
    tsFetch('/leads.json',  { start_date: back30, end_date: t }),
    tsFetch('/events.json', { start_date: t,      end_date: fwd30, status: 'definite' }),
    tsFetch('/events.json', { start_date: t,      end_date: fwd60, status: 'definite' }),
    tsFetch('/events.json', { start_date: t,      end_date: fwd90, status: 'definite' }),
    tsFetch('/events.json', { booked_start_date: back30, booked_end_date: t, status: 'definite' }),
  ]);

  const todayList    = todayEvents.events || [];
  const bookingCount = (bookings30.events || []).length;
  const bookingRev   = tsSumRev(bookings30);
  const leadCount    = (leads.leads || []).length;

  return {
    // existing
    events_today:  todayList.length,
    event_revenue: todayList.reduce((s, e) => s + Number(e.total_event_revenue || 0), 0),
    leads_active:  leadCount,
    // new
    booked_pipeline_30:  tsSumRev(pipe30),
    booked_pipeline_60:  tsSumRev(pipe60),
    booked_pipeline_90:  tsSumRev(pipe90),
    avg_event_value:     bookingCount > 0 ? round2(bookingRev / bookingCount)       : 0,
    lead_to_booking_pct: leadCount    > 0 ? round2((bookingCount / leadCount) * 100) : 0,
  };
}

// ============================================================================
// COGS reconciliation — QB authoritative total, MarginEdge category mix only
// ============================================================================

function reconcileCogs(qb, me) {
  const qbTotal = Number(qb?.cogs ?? 0);

  if (qbTotal === 0) {
    return {
      total: 0,
      categories: {},
      sources: { total: 'QuickBooks', breakdown: 'n/a' },
      reconciliation: null,
    };
  }

  const meCats  = me?.categories ?? {};
  const meTotal = Object.values(meCats).reduce((s, v) => s + Number(v || 0), 0);

  if (meTotal === 0) {
    return {
      total: qbTotal,
      categories: { uncategorized: qbTotal },
      sources: { total: 'QuickBooks', breakdown: 'n/a (MarginEdge empty)' },
      reconciliation: null,
    };
  }

  // Scale MarginEdge category mix to QB total
  const categories = {};
  for (const [k, raw] of Object.entries(meCats)) {
    const pct = Number(raw || 0) / meTotal;
    categories[k] = round2(pct * qbTotal);
  }

  // Push rounding drift into the largest category so the sum equals QB exactly
  const summed = Object.values(categories).reduce((s, v) => s + v, 0);
  const drift  = round2(qbTotal - summed);
  if (drift !== 0) {
    const largest = Object.entries(categories).sort((a, b) => b[1] - a[1])[0][0];
    categories[largest] = round2(categories[largest] + drift);
  }

  return {
    total: qbTotal,
    categories,
    sources: { total: 'QuickBooks', breakdown: 'MarginEdge (mix %)' },
    reconciliation: {
      qb_total:  qbTotal,
      me_total:  round2(meTotal),
      delta:     round2(meTotal - qbTotal),
      delta_pct: round2(((meTotal - qbTotal) / qbTotal) * 100),
    },
  };
}

// ============================================================================
// Orchestrator — GET /api/ric
// ============================================================================

app.get('/api/ric', async (_req, res) => {
  const [gotab, quickbooks, marginedge, mailchimp, tripleseat] = await Promise.all([
    safe('gotab',      fetchGoTab),
    safe('quickbooks', fetchQuickBooks),
    safe('marginedge', fetchMarginEdge),
    safe('mailchimp',  fetchMailchimp),
    safe('tripleseat', fetchTripleSeat),
  ]);

  const cogs = reconcileCogs(quickbooks.data, marginedge.data);

  res.json({
    generated_at: new Date().toISOString(),
    sources: {
      gotab,
      quickbooks,
      marginedge,
      mailchimp,
      tripleseat,
      '7shifts':  { status: 'mock', system: '7shifts',  data: MOCK['7shifts']  },
      opentable:  { status: 'mock', system: 'opentable', data: MOCK.opentable  },
      marqii:     { status: 'mock', system: 'marqii',    data: MOCK.marqii     },
      ga4:        { status: 'mock', system: 'ga4',       data: MOCK.ga4        },
      doordash:   { status: 'mock', system: 'doordash',  data: MOCK.doordash   },
      m365:       { status: 'mock', system: 'm365',      data: MOCK.m365       },
    },
    cogs,
  });
});

// ============================================================================
// Claude proxy — POST /api/claude (non-streaming)
// ============================================================================

app.post('/api/claude', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-api-key':        process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:       'claude-sonnet-4-5',
        max_tokens:  4000,
        ...req.body,
      }),
    });

    const json = await r.json();
    res.status(r.status).json(json);
  } catch (err) {
    console.error('[claude] proxy failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Health + boot
// ============================================================================

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`[RIC] listening on :${PORT}`);
});
