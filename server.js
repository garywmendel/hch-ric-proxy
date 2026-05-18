// Hill Country Hospitality — RIC Proxy Server v3.1
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Credentials ───────────────────────────────────────────────────────────────
const GOTAB_ID             = process.env.GOTAB_ID;
const GOTAB_SECRET         = process.env.GOTAB_SECRET;
const GOTAB_LOCATION_UUID  = process.env.GOTAB_LOCATION_UUID;
const SHIFTS_TOKEN         = process.env.SHIFTS_TOKEN;
const SHIFTS_COMPANY_GUID  = process.env.SHIFTS_COMPANY_GUID;
const SHIFTS_COMPANY_ID    = process.env.SHIFTS_COMPANY_ID;
const SHIFTS_LOCATION_ID   = process.env.SHIFTS_LOCATION_ID;
const MARGINEDGE_API_KEY   = process.env.MARGINEDGE_API_KEY;
const MARGINEDGE_TENANT_ID = process.env.MARGINEDGE_TENANT_ID;
const QB_CLIENT_ID         = process.env.QB_CLIENT_ID;
const QB_CLIENT_SECRET     = process.env.QB_CLIENT_SECRET;
const QB_REDIRECT_URI      = "https://ric.up.railway.app/auth/quickbooks/callback";
const QB_SCOPES            = "com.intuit.quickbooks.accounting";

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization"] }));
app.options("*", cors());
app.use(express.json());

// ── Time helpers (Eastern) ────────────────────────────────────────────────────
const toET  = (d = new Date()) => new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
const today = () => {
  const e = toET();
  return `${e.getFullYear()}-${String(e.getMonth()+1).padStart(2,"0")}-${String(e.getDate()).padStart(2,"0")}`;
};
const nowET = () => toET().toISOString().replace("T"," ").slice(0,19) + " ET";

// ── Retry helper ──────────────────────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, retries = 1, delayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || attempt === retries) return res;
      const retryable = [429, 500, 502, 503, 504].includes(res.status);
      if (!retryable) return res;
      console.warn(`Retrying ${url} after status ${res.status} (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, delayMs));
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`Retrying ${url} after error: ${err.message} (attempt ${attempt + 1})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── QuickBooks token state (in-memory) ────────────────────────────────────────
let qbState = {
  accessToken:    null,
  refreshToken:   process.env.QB_REFRESH_TOKEN || null,
  realmId:        process.env.QB_REALM_ID       || null,
  tokenExpiresAt: 0,   // unix ms
  lastSyncTime:   null, // for CDC
  companyInfo:    null, // QBO plan/feature info
};

// ── QuickBooks OAuth helpers ──────────────────────────────────────────────────
async function qbRefreshAccessToken() {
  if (!qbState.refreshToken) throw new Error("No QB refresh token — run OAuth flow first");
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
  const res = await fetchWithRetry("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type":  "application/x-www-form-urlencoded",
      "Accept":        "application/json",
    },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: qbState.refreshToken,
    }),
  });
  const intuitTid = res.headers?.get("intuit_tid") || "unknown";
  if (!res.ok) {
    const body = await res.text();
    console.error(`QB token refresh failed | intuit_tid: ${intuitTid} | status: ${res.status} | body: ${body}`);
    throw new Error(`QB token refresh failed: ${res.status} | intuit_tid: ${intuitTid}`);
  }
  const data = await res.json();
  qbState.accessToken    = data.access_token;
  qbState.refreshToken   = data.refresh_token;
  qbState.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000; // 60s buffer
  console.log(`QB access token refreshed | intuit_tid: ${intuitTid} | expires_in: ${data.expires_in}s`);
  return qbState.accessToken;
}

async function getQBToken() {
  if (qbState.accessToken && Date.now() < qbState.tokenExpiresAt) {
    return qbState.accessToken;
  }
  return qbRefreshAccessToken();
}

async function qbGet(endpoint) {
  const token   = await getQBToken();
  const realmId = qbState.realmId;
  if (!realmId) throw new Error("QB Realm ID not set — run OAuth flow first");
  const url = `https://quickbooks.api.intuit.com/v3/company/${realmId}/${endpoint}&minorversion=65`;
  const res = await fetchWithRetry(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept":        "application/json",
    },
  });
  const intuitTid = res.headers?.get("intuit_tid") || "unknown";
  if (!res.ok) {
    const body = await res.text();
    console.error(`QB API error | intuit_tid: ${intuitTid} | status: ${res.status} | endpoint: ${endpoint}`);
    throw new Error(`QB API error: ${res.status} | intuit_tid: ${intuitTid}`);
  }
  console.log(`QB API success | intuit_tid: ${intuitTid} | endpoint: ${endpoint}`);
  return res.json();
}

// ── QuickBooks feature detection ──────────────────────────────────────────────
async function qbGetCompanyInfo() {
  try {
    const data = await qbGet("companyinfo/" + qbState.realmId + "?");
    qbState.companyInfo = data?.CompanyInfo || null;
    return qbState.companyInfo;
  } catch (e) {
    console.warn("QB companyinfo fetch failed:", e.message);
    return null;
  }
}

// ── QuickBooks P&L fetch ──────────────────────────────────────────────────────
async function fetchQuickBooks(startDate, endDate) {
  // P&L report — covers all income and expense accounts
  const [plData, cdcData] = await Promise.allSettled([
    qbGet(`reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=Accrual&`),
    qbState.lastSyncTime
      ? qbGet(`cdc?entities=Invoice,Bill,JournalEntry,Payment,Purchase&changedSince=${qbState.lastSyncTime}&`)
      : Promise.resolve(null),
  ]);

  qbState.lastSyncTime = new Date().toISOString();

  const pl = plData.status === "fulfilled" ? plData.value : null;
  const cdc = cdcData.status === "fulfilled" ? cdcData.value : null;

  if (!pl) throw new Error("QB P&L report unavailable");

  // Parse P&L report rows into account buckets
  const accounts = {};
  function parseRows(rows) {
    if (!rows) return;
    for (const row of rows) {
      if (row.type === "Section" && row.Rows) parseRows(row.Rows.Row);
      if (row.type === "Data" && row.ColData) {
        const name   = row.ColData[0]?.value || "";
        const amount = parseFloat(row.ColData[1]?.value || 0);
        if (name && amount) accounts[name] = amount;
      }
    }
  }
  parseRows(pl.Rows?.Row);

  // Extract key accounts matching Hill Country chart of accounts
  const get = (...keys) => {
    for (const k of keys) {
      for (const [name, val] of Object.entries(accounts)) {
        if (name.toLowerCase().includes(k.toLowerCase())) return val;
      }
    }
    return null;
  };

  return {
    // Labor related (5300)
    payroll_fica:      get("FICA", "5315-1"),
    payroll_sui:       get("SUI",  "5315-2"),
    payroll_fui:       get("FUI",  "5315-3"),
    payroll_mta:       get("MTA",  "5315-4"),
    health_insurance:  get("Health", "Dental", "5320"),
    workers_comp:      get("Workers Comp", "5325"),
    // Controllable expenses (6000)
    cleaning_supplies: get("Cleaning Supplies", "6115"),
    restaurant_supplies: get("Restaurant Supplies", "6125"),
    laundry:           get("Laundry", "Linen", "6135"),
    smallwares:        get("Smallwares", "6150"),
    wood_supplies:     get("Wood", "6175"),
    cc_fees:           get("Credit Card", "Processing", "6205"),
    payroll_processing:get("Payroll Processing", "6525"),
    postage:           get("Postage", "6603"),
    // Totals
    total_labor_related: get("Total Labor Related", "5300"),
    total_controllable:  get("Total Controllable", "7000"),
    net_operating_income:get("Net Operating Income", "Net Income"),
    // Raw accounts for extensibility
    raw_accounts: accounts,
    cdc_entities: cdc ? Object.keys(cdc.CDCResponse?.[0]?.QueryResponse || {}) : [],
    company_info: qbState.companyInfo,
    data_as_of:   nowET(),
  };
}

// ── GoTab auth ────────────────────────────────────────────────────────────────
async function getGoTabToken() {
  const res = await fetchWithRetry("https://gotab.io/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_access_id: GOTAB_ID, api_access_secret: GOTAB_SECRET }),
  });
  if (!res.ok) throw new Error(`GoTab auth failed: ${res.status}`);
  return (await res.json()).token;
}

// ── GoTab GraphQL query ───────────────────────────────────────────────────────
function goTabQuery(locationUuid, fiscalDay) {
  return {
    query: `
      query($locationUuid: String, $tabCreationDate: Datetime) {
        locations: locationsList(condition: { locationUuid: $locationUuid }) {
          name locationUuid
          tabs: tabsList(filter: { created: { greaterThan: $tabCreationDate } ordersPlaced: { greaterThan: 0 } }) {
            name tabMode tax total subtotal tippedSubtotal balanceDue autogratDue href
            items: itemsList(filter: { ordered: { equalTo: true } }) {
              name subtotal subtotalInitial quantity quantityInitial comped voided fee discount
              accountingStream { name reportingGroup }
              adjustments: adjustments { adjustmentReason adjustmentType quantity unitPrice deltaTax deltaAutograt deltaAutogratTax }
            }
          }
        }
      }`,
    variables: { locationUuid, tabCreationDate: fiscalDay + "T00:00:00Z" },
  };
}

// ── GoTab normalize ───────────────────────────────────────────────────────────
function normalizeGoTab(tabs) {
  let net_sales = 0, tax_total = 0, bar_sales = 0, catering_sales = 0;
  let voids = 0, comps = 0, tip_total = 0, tab_count = 0, deferred_revenue = 0;

  const BAR_STREAMS = [
    "Sales, Liquor:", "Sales, Beer:", "Sales, Non-Alcoholic Beverage:", "Sales, Wine:",
    "Sales, Banquet Liquor:", "Sales, Banquet Beer:", "Sales, Banquet Wine:", "Sales, Banquet N/A Beverage:",
  ];
  const CATERING_STREAMS = [
    "Sales, Catering Food:", "Sales, Banquet Food:", "Sales, Banquet Admin Fee:", "Sales, Transport Fee:",
  ];
  const EXCLUDE_GROUPS = ["DEFERRED_REVENUE", "PROCESSORS", "EXPENSE"];

  for (const tab of tabs) {
    const tabTax   = tab.tax         || 0;
    const tabTotal = tab.total       || 0;
    const tabSub   = tab.subtotal    || 0;
    const tabAuto  = tab.autogratDue || 0;
    tax_total += tabTax;
    const tabTip = tabTotal - tabSub - tabTax - tabAuto;
    if (tabTip > 0) tip_total += tabTip;
    tab_count += 1;

    for (const item of tab.items || []) {
      const g   = item.accountingStream?.reportingGroup || "";
      const n   = item.accountingStream?.name           || "";
      const amt = item.subtotal || 0;
      if (EXCLUDE_GROUPS.includes(g)) { if (g === "DEFERRED_REVENUE") deferred_revenue += amt; continue; }
      if (n.startsWith("Discounts and Comps")) { comps += Math.abs(amt); continue; }
      if (item.voided || g === "VOID")          { voids += Math.abs(amt); continue; }
      net_sales += amt;
      if (BAR_STREAMS.some(b => n.startsWith(b)))           bar_sales      += amt;
      else if (CATERING_STREAMS.some(b => n.startsWith(b))) catering_sales += amt;
    }
  }

  return {
    net_sales:        +(net_sales        / 100).toFixed(2),
    tab_count,
    bar_sales:        +(bar_sales        / 100).toFixed(2),
    catering_sales:   +(catering_sales   / 100).toFixed(2),
    voids:            +(voids            / 100).toFixed(2),
    comps:            +(comps            / 100).toFixed(2),
    tax_total:        +(tax_total        / 100).toFixed(2),
    tip_total:        +(tip_total        / 100).toFixed(2),
    deferred_revenue: +(deferred_revenue / 100).toFixed(2),
    data_as_of:       nowET(),
  };
}

// ── 7Shifts ───────────────────────────────────────────────────────────────────
async function fetch7Shifts(date) {
  const headers = {
    "Authorization": `Bearer ${SHIFTS_TOKEN}`,
    "Content-Type":  "application/json",
    ...(SHIFTS_COMPANY_GUID ? { "x-company-guid": SHIFTS_COMPANY_GUID } : {}),
  };
  const base = `https://api.7shifts.com/v2/company/${SHIFTS_COMPANY_ID}`;
  const [sRes, pRes] = await Promise.all([
    fetchWithRetry(`${base}/shifts?location_id=${SHIFTS_LOCATION_ID}&start=${date}T00:00:00&end=${date}T23:59:59&limit=200`, { headers }),
    fetchWithRetry(`${base}/time_punches?location_id=${SHIFTS_LOCATION_ID}&clocked_in_gte=${date}T00:00:00&clocked_in_lte=${date}T23:59:59&limit=200`, { headers }),
  ]);
  if (!sRes.ok) throw new Error(`7Shifts shifts failed: ${sRes.status}`);
  if (!pRes.ok) throw new Error(`7Shifts punches failed: ${pRes.status}`);

  const shifts  = (await sRes.json()).data || [];
  const punches = (await pRes.json()).data || [];

  let scheduled_hours = 0, actual_hours = 0, labor_cost = 0, overtime_hours = 0, no_shows = 0;
  for (const s of shifts) scheduled_hours += (new Date(s.end) - new Date(s.start)) / 3600000;
  for (const p of punches) {
    if (p.clocked_in && p.clocked_out) {
      const hrs = (new Date(p.clocked_out) - new Date(p.clocked_in)) / 3600000;
      actual_hours += hrs;
      if (p.wage_cents) labor_cost += (hrs * p.wage_cents) / 100;
      if (hrs > 8) overtime_hours += hrs - 8;
    }
  }
  const punchedIds = new Set(punches.map(p => p.user_id));
  for (const s of shifts) if (s.user_id && !punchedIds.has(s.user_id)) no_shows++;

  return {
    scheduled_hours: +scheduled_hours.toFixed(1),
    actual_hours:    +actual_hours.toFixed(1),
    labor_cost:      +labor_cost.toFixed(2),
    labor_pct:       null,
    overtime_hours:  +overtime_hours.toFixed(1),
    no_shows,
    shift_count:     shifts.length,
    punch_count:     punches.length,
    data_as_of:      nowET(),
  };
}

// ── MarginEdge ────────────────────────────────────────────────────────────────
function bucketCogs(cogs, cat, amt) {
  const c = (cat || "").toLowerCase();
  if      (c.includes("meat")||c.includes("protein")||c.includes("bbq")||c.includes("poultry")||c.includes("seafood")||c.includes("fish")) { cogs.meat    += amt; cogs.food += amt; }
  else if (c.includes("produce")||c.includes("vegetable")||c.includes("fruit"))                                                             { cogs.produce += amt; cogs.food += amt; }
  else if (c.includes("dairy")||c.includes("egg")||c.includes("cheese"))                                                                    { cogs.dairy   += amt; cogs.food += amt; }
  else if (c.includes("grocery")||c.includes("dry")||c.includes("pantry")||c.includes("baked")||c.includes("bread")||c.includes("bakery"))  { cogs.grocery += amt; cogs.food += amt; }
  else if (c.includes("liquor")||c.includes("spirit")||c.includes("cocktail"))                                                              { cogs.liquor  += amt; }
  else if (c.includes("beer")||c.includes("draft")||c.includes("brew"))                                                                     { cogs.beer    += amt; }
  else if (c.includes("wine"))                                                                                                               { cogs.wine    += amt; }
  else if (c.includes("non-alc")||c.includes("na bev")||c.includes("beverage")||c.includes("soda")||c.includes("juice")||c.includes("water")){ cogs.na_bev += amt; }
  else if (c.includes("paper")||c.includes("packaging")||c.includes("to-go")||c.includes("disposable"))                                    { cogs.paper   += amt; }
  else if (c.includes("supply")||c.includes("supplies")||c.includes("cleaning")||c.includes("chemical")||c.includes("janitorial"))          { cogs.supplies += amt; }
  else                                                                                                                                        { cogs.other   += amt; }
}

async function fetchMarginEdge(date) {
  const headers = { "X-Api-Key": MARGINEDGE_API_KEY, "Accept": "application/json" };
  const base    = "https://api.marginedge.com/public";
  const rid     = MARGINEDGE_TENANT_ID;

  const ordersRes = await fetchWithRetry(
    `${base}/orders?restaurantUnitId=${rid}&startDate=${date}&endDate=${date}&orderStatus=CLOSED`,
    { headers }
  );
  if (!ordersRes.ok) throw new Error(`MarginEdge orders failed: ${ordersRes.status}`);

  const ordersJson = await ordersRes.json();
  const orders     = ordersJson.orders || ordersJson.data || (Array.isArray(ordersJson) ? ordersJson : []);

  const cogs = { food:0,meat:0,produce:0,dairy:0,grocery:0,liquor:0,beer:0,wine:0,na_bev:0,paper:0,supplies:0,other:0,total:0 };
  const invoice_count = orders.length;

  const detailFetches = orders.slice(0, 20).map(o =>
    fetchWithRetry(`${base}/orders/${o.orderId}?restaurantUnitId=${rid}`, { headers })
      .then(r => r.ok ? r.json() : null).catch(() => null)
  );
  const details = await Promise.all(detailFetches);

  for (let i = 0; i < details.length; i++) {
    const detail = details[i];
    const order  = orders[i];
    if (!detail) { const amt=parseFloat(order.orderTotal||0); if(amt){cogs.total+=amt;cogs.other+=amt;} continue; }
    const lines = detail.lineItems || detail.line_items || detail.items || detail.orderItems || [];
    if (lines.length === 0) {
      const amt = parseFloat(detail.orderTotal || order.orderTotal || 0);
      if (amt) { cogs.total += amt; bucketCogs(cogs, detail.vendorName || order.vendorName || "", amt); }
      continue;
    }
    for (const line of lines) {
      const cat = line.category || line.categoryName || line.category_name || line.categoryType || "";
      const amt = parseFloat(line.extendedCost||line.extended_cost||line.amount||line.total||line.cost||line.lineTotal||0);
      if (!amt) continue;
      cogs.total += amt;
      bucketCogs(cogs, cat, amt);
    }
  }

  for (const key of Object.keys(cogs)) cogs[key] = +cogs[key].toFixed(2);

  return { invoice_count, pending_invoices: 0, cogs, food_cost_pct: null, total_cogs_pct: null, data_as_of: nowET() };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// ── QuickBooks OAuth: Step 1 — redirect to Intuit ─────────────────────────────
app.get("/auth/quickbooks", (req, res) => {
  if (!QB_CLIENT_ID) return res.status(500).send("QB_CLIENT_ID not set in Railway environment variables.");
  const state = Math.random().toString(36).slice(2);
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id",     QB_CLIENT_ID);
  url.searchParams.set("redirect_uri",  QB_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         QB_SCOPES);
  url.searchParams.set("state",         state);
  console.log("QB OAuth: redirecting to Intuit authorization page");
  res.redirect(url.toString());
});

// ── QuickBooks OAuth: Step 2 — handle callback ────────────────────────────────
app.get("/auth/quickbooks/callback", async (req, res) => {
  const { code, realmId, state, error } = req.query;

  if (error) {
    console.error("QB OAuth error:", error);
    return res.send(`<h2>QuickBooks Authorization Failed</h2><p>${error}</p>`);
  }

  if (!code || !realmId) {
    return res.status(400).send("<h2>Missing code or realmId from Intuit</h2>");
  }

  try {
    // Exchange authorization code for tokens
    const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetchWithRetry("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${creds}`,
        "Content-Type":  "application/x-www-form-urlencoded",
        "Accept":        "application/json",
      },
      body: new URLSearchParams({
        grant_type:   "authorization_code",
        code,
        redirect_uri: QB_REDIRECT_URI,
      }),
    });

    const intuitTid = tokenRes.headers?.get("intuit_tid") || "unknown";

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error(`QB token exchange failed | intuit_tid: ${intuitTid} | ${tokenRes.status} | ${body}`);
      return res.status(500).send(`<h2>Token exchange failed</h2><p>Status: ${tokenRes.status}</p><p>intuit_tid: ${intuitTid}</p><pre>${body}</pre>`);
    }

    const tokens = await tokenRes.json();
    console.log(`QB OAuth success | intuit_tid: ${intuitTid} | realmId: ${realmId}`);

    // Store in memory
    qbState.accessToken    = tokens.access_token;
    qbState.refreshToken   = tokens.refresh_token;
    qbState.realmId        = realmId;
    qbState.tokenExpiresAt = Date.now() + (tokens.expires_in - 60) * 1000;

    // Fetch company info for feature detection
    await qbGetCompanyInfo();

    // Display credentials for Railway
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>QuickBooks Connected — RIC</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#f5f5f3;color:#1a1a18}
    h1{color:#1D9E75;margin-bottom:8px}
    p{color:#6b6b67;margin-bottom:24px;line-height:1.6}
    .card{background:#fff;border-radius:12px;padding:20px 24px;margin-bottom:16px;border:0.5px solid rgba(0,0,0,0.1)}
    .label{font-size:11px;font-weight:600;color:#6b6b67;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px}
    .value{font-family:"SF Mono","Fira Code",monospace;font-size:12px;background:#f5f5f3;padding:10px 12px;border-radius:8px;word-break:break-all;line-height:1.6;border:0.5px solid rgba(0,0,0,0.1)}
    .warn{background:#faeeda;color:#633806;padding:12px 16px;border-radius:8px;font-size:13px;margin-top:24px;line-height:1.6}
    .step{background:#e1f5ee;color:#085041;padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:12px;line-height:1.6}
    strong{font-weight:600}
  </style>
</head>
<body>
  <h1>✓ QuickBooks Connected</h1>
  <p>Authorization successful. Copy these three values into Railway environment variables, then redeploy.</p>

  <div class="step">Step 1 — Add these to Railway → hch-ric-proxy → Variables</div>

  <div class="card">
    <div class="label">QB_REALM_ID</div>
    <div class="value">${realmId}</div>
  </div>

  <div class="card">
    <div class="label">QB_REFRESH_TOKEN</div>
    <div class="value">${tokens.refresh_token}</div>
  </div>

  <div class="card">
    <div class="label">QB_CLIENT_ID (confirm)</div>
    <div class="value">${QB_CLIENT_ID}</div>
  </div>

  <div class="card">
    <div class="label">QB_CLIENT_SECRET (confirm)</div>
    <div class="value">${QB_CLIENT_SECRET}</div>
  </div>

  ${qbState.companyInfo ? `
  <div class="card">
    <div class="label">Company Info</div>
    <div class="value">
      ${qbState.companyInfo.CompanyName || ""}<br>
      Plan: ${qbState.companyInfo.NameValue?.find(n=>n.Name==="QBOSubscriptionType")?.Value || "unknown"}<br>
      intuit_tid: ${intuitTid}
    </div>
  </div>` : ""}

  <div class="step">Step 2 — Once Railway is redeployed, test with:<br><strong>curl https://ric.up.railway.app/api/quickbooks</strong></div>

  <div class="warn">⚠️ This page contains your production credentials. Close this tab after copying the values into Railway. Rotate your Client Secret after setup is complete.</div>
</body>
</html>`);
  } catch (err) {
    console.error("QB OAuth callback error:", err.message);
    res.status(500).send(`<h2>OAuth callback error</h2><pre>${err.message}</pre>`);
  }
});

// ── QuickBooks only ───────────────────────────────────────────────────────────
app.get("/api/quickbooks", async (req, res) => {
  try {
    if (!qbState.refreshToken) {
      return res.status(401).json({ ok: false, error: "QuickBooks not authorized — visit /auth/quickbooks to connect" });
    }
    const startDate = req.query.start || today();
    const endDate   = req.query.end   || today();
    const data = await fetchQuickBooks(startDate, endDate);
    res.json({ ok: true, source: "quickbooks_live", start: startDate, end: endDate, ...data });
  } catch (err) {
    console.error("QuickBooks error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GoTab streams diagnostic ──────────────────────────────────────────────────
app.get("/api/gotab/streams", async (req, res) => {
  try {
    const date  = req.query.date || today();
    const token = await getGoTabToken();
    const gqlRes = await fetchWithRetry("https://gotab.io/api/v2/graph", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(goTabQuery(GOTAB_LOCATION_UUID, date)),
    });
    const gqlData = await gqlRes.json();
    const tabs = gqlData?.data?.locations?.[0]?.tabs || [];
    const streams = {};
    for (const tab of tabs) {
      for (const item of tab.items || []) {
        const g = item.accountingStream?.reportingGroup || "NONE";
        const n = item.accountingStream?.name || "NONE";
        const key = `${g} | ${n}`;
        if (!streams[key]) streams[key] = { reportingGroup: g, name: n, count: 0, subtotal_cents: 0 };
        streams[key].count++;
        streams[key].subtotal_cents += item.subtotal || 0;
      }
    }
    res.json({ total_tabs: tabs.length, streams: Object.values(streams).sort((a,b) => b.subtotal_cents - a.subtotal_cents) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GoTab only ────────────────────────────────────────────────────────────────
app.get("/api/gotab", async (req, res) => {
  try {
    const date  = req.query.date || today();
    const token = await getGoTabToken();
    const gqlRes = await fetchWithRetry("https://gotab.io/api/v2/graph", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(goTabQuery(GOTAB_LOCATION_UUID, date)),
    });
    if (!gqlRes.ok) throw new Error(`GoTab GraphQL error: ${gqlRes.status}`);
    const gqlData = await gqlRes.json();
    if (gqlData.errors) throw new Error(gqlData.errors[0]?.message || "GraphQL error");
    const tabs = gqlData?.data?.locations?.[0]?.tabs || [];
    res.json({ ok: true, source: "gotab_live", date, ...normalizeGoTab(tabs) });
  } catch (err) {
    console.error("GoTab error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 7Shifts only ──────────────────────────────────────────────────────────────
app.get("/api/7shifts", async (req, res) => {
  try {
    const date = req.query.date || today();
    const data = await fetch7Shifts(date);
    res.json({ ok: true, source: "7shifts_live", date, ...data });
  } catch (err) {
    console.error("7Shifts error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── MarginEdge only ───────────────────────────────────────────────────────────
app.get("/api/marginedge", async (req, res) => {
  try {
    const date = req.query.date || today();
    const data = await fetchMarginEdge(date);
    res.json({ ok: true, source: "marginedge_live", date, ...data });
  } catch (err) {
    console.error("MarginEdge error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Combined ──────────────────────────────────────────────────────────────────
app.get("/api/ric", async (req, res) => {
  const date   = req.query.date || today();
  const result = { date, sources: {} };

  try {
    const token  = await getGoTabToken();
    const gqlRes = await fetchWithRetry("https://gotab.io/api/v2/graph", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(goTabQuery(GOTAB_LOCATION_UUID, date)),
    });
    const gqlData = await gqlRes.json();
    const tabs = gqlData?.data?.locations?.[0]?.tabs || [];
    result.gotab = normalizeGoTab(tabs);
    result.sources.gotab = "live";
  } catch (e) {
    console.error("GoTab failed:", e.message);
    result.gotab = null;
    result.sources.gotab = `error: ${e.message}`;
  }

  try {
    const shifts = await fetch7Shifts(date);
    if (result.gotab?.net_sales && shifts.labor_cost)
      shifts.labor_pct = +((shifts.labor_cost / result.gotab.net_sales) * 100).toFixed(1);
    result["7shifts"] = shifts;
    result.sources["7shifts"] = "live";
  } catch (e) {
    console.error("7Shifts failed:", e.message);
    result["7shifts"] = null;
    result.sources["7shifts"] = `error: ${e.message}`;
  }

  try {
    const me = await fetchMarginEdge(date);
    if (result.gotab?.net_sales) {
      if (me.cogs?.food)  me.food_cost_pct  = +((me.cogs.food  / result.gotab.net_sales) * 100).toFixed(1);
      if (me.cogs?.total) me.total_cogs_pct = +((me.cogs.total / result.gotab.net_sales) * 100).toFixed(1);
    }
    result.marginedge = me;
    result.sources.marginedge = "live";
  } catch (e) {
    console.error("MarginEdge failed:", e.message);
    result.marginedge = null;
    result.sources.marginedge = `error: ${e.message}`;
  }

  try {
    if (qbState.refreshToken && qbState.realmId) {
      const qb = await fetchQuickBooks(date, date);
      result.quickbooks = qb;
      result.sources.quickbooks = "live";
    }
  } catch (e) {
    console.error("QuickBooks failed:", e.message);
    result.quickbooks = null;
    result.sources.quickbooks = `error: ${e.message}`;
  }

  res.json({ ok: true, ...result });
});

// ── Claude proxy (non-streaming) ──────────────────────────────────────────────
app.post("/api/claude", async (req, res) => {
  try {
    const body = { ...req.body, stream: false };
    const upstream = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    res.json(data);
  } catch(err) {
    console.error("Claude proxy error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── QB status ─────────────────────────────────────────────────────────────────
app.get("/api/quickbooks/status", (_req, res) => {
  res.json({
    ok:            true,
    authorized:    !!qbState.refreshToken,
    realmId:       qbState.realmId || null,
    tokenValid:    Date.now() < qbState.tokenExpiresAt,
    tokenExpiresAt:qbState.tokenExpiresAt ? new Date(qbState.tokenExpiresAt).toISOString() : null,
    lastSyncTime:  qbState.lastSyncTime,
    companyName:   qbState.companyInfo?.CompanyName || null,
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, service: "hch-ric-proxy", version: "3.1" }));

// ── Serve RIC app ─────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(join(__dirname, "index.html"));
});

app.listen(PORT, () => console.log(`RIC proxy v3.1 running on port ${PORT}`));
