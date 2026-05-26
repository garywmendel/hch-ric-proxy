// Hill Country Hospitality — RIC Proxy Server v3.7
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
const MC_API_KEY           = process.env.MAILCHIMP_API_KEY;
const MC_SERVER            = process.env.MAILCHIMP_SERVER;
const MC_AUDIENCE_ID       = process.env.MAILCHIMP_AUDIENCE_ID;
const TS_CLIENT_ID         = process.env.TRIPLESEAT_CLIENT_ID;
const TS_CLIENT_SECRET     = process.env.TRIPLESEAT_CLIENT_SECRET;
const TS_REDIRECT_URI      = "https://ric.up.railway.app/auth/tripleseat/callback";
const RAILWAY_API_TOKEN      = process.env.RAILWAY_API_TOKEN;
const RAILWAY_PROJECT_ID     = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_SERVICE_ID     = process.env.RAILWAY_SERVICE_ID;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID;

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
      if (![429,500,502,503,504].includes(res.status)) return res;
      console.warn(`Retrying ${url} after ${res.status} (attempt ${attempt+1})`);
      await new Promise(r => setTimeout(r, delayMs));
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`Retrying ${url} after error: ${err.message}`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── Railway variable persistence ──────────────────────────────────────────────
async function persistRailwayVars(variables) {
  if (!RAILWAY_API_TOKEN || !RAILWAY_PROJECT_ID || !RAILWAY_SERVICE_ID || !RAILWAY_ENVIRONMENT_ID) {
    console.warn("Railway credentials not fully set — variables will not persist across restarts");
    return;
  }
  const mutation = `
    mutation upsertVariables($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;
  try {
    const res = await fetch("https://backboard.railway.app/graphql/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RAILWAY_API_TOKEN}` },
      body: JSON.stringify({ query: mutation, variables: { input: {
        projectId: RAILWAY_PROJECT_ID, serviceId: RAILWAY_SERVICE_ID,
        environmentId: RAILWAY_ENVIRONMENT_ID, variables,
      }}}),
    });
    const data = await res.json();
    if (data.errors) console.error("Railway persist failed:", JSON.stringify(data.errors));
    else console.log("Railway vars persisted:", Object.keys(variables).join(", "));
  } catch (err) {
    console.error("Railway persist error:", err.message);
  }
}

async function persistQBRefreshToken(newToken) {
  return persistRailwayVars({ QB_REFRESH_TOKEN: newToken });
}

// ── QuickBooks token state ────────────────────────────────────────────────────
let qbState = {
  accessToken:    null,
  refreshToken:   process.env.QB_REFRESH_TOKEN || null,
  realmId:        process.env.QB_REALM_ID       || null,
  tokenExpiresAt: 0,
  lastSyncTime:   null,
};

async function qbRefreshAccessToken() {
  if (!qbState.refreshToken) throw new Error("No QB refresh token — visit /auth/quickbooks");
  const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
  const res = await fetchWithRetry("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: qbState.refreshToken }),
  });
  const intuitTid = res.headers?.get("intuit_tid") || "unknown";
  if (!res.ok) {
    const body = await res.text();
    console.error(`QB token refresh failed | intuit_tid: ${intuitTid} | ${res.status} | ${body}`);
    throw new Error(`QB token refresh failed: ${res.status} | intuit_tid: ${intuitTid}`);
  }
  const data = await res.json();
  qbState.accessToken    = data.access_token;
  qbState.refreshToken   = data.refresh_token;
  qbState.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log(`QB token refreshed | intuit_tid: ${intuitTid}`);
  persistQBRefreshToken(data.refresh_token).catch(err => console.error("Background token persist failed:", err.message));
  return qbState.accessToken;
}

async function getQBToken() {
  if (qbState.accessToken && Date.now() < qbState.tokenExpiresAt) return qbState.accessToken;
  return qbRefreshAccessToken();
}

async function qbGet(endpoint) {
  const token = await getQBToken();
  if (!qbState.realmId) throw new Error("QB Realm ID not set");
  const url = `https://quickbooks.api.intuit.com/v3/company/${qbState.realmId}/${endpoint}&minorversion=65`;
  const res = await fetchWithRetry(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
  const intuitTid = res.headers?.get("intuit_tid") || "unknown";
  if (!res.ok) {
    const body = await res.text();
    console.error(`QB API error | intuit_tid: ${intuitTid} | ${res.status} | ${endpoint}`);
    throw new Error(`QB API error: ${res.status} | intuit_tid: ${intuitTid}`);
  }
  console.log(`QB API ok | intuit_tid: ${intuitTid} | ${endpoint.split("?")[0]}`);
  return res.json();
}

// ── QuickBooks P&L parser ─────────────────────────────────────────────────────
function parseQBRows(rows, accounts = {}) {
  if (!rows) return accounts;
  for (const row of rows) {
    if (row.type === "Section" && row.Rows) parseQBRows(row.Rows.Row, accounts);
    if (row.type === "Data" && row.ColData) {
      const name   = row.ColData[0]?.value || "";
      const amount = parseFloat(row.ColData[1]?.value || 0);
      if (name && !isNaN(amount) && amount !== 0) accounts[name] = amount;
    }
  }
  return accounts;
}

function acct(raw, ...keys) {
  for (const k of keys) {
    for (const [name, val] of Object.entries(raw)) { if (name.startsWith(k)) return val; }
    const kl = k.toLowerCase();
    for (const [name, val] of Object.entries(raw)) { if (name.toLowerCase().includes(kl)) return val; }
  }
  return null;
}

function sum(...vals) { return vals.reduce((a, v) => a + (v || 0), 0); }

async function fetchQuickBooks(startDate, endDate) {
  const [plRes, cdcRes] = await Promise.allSettled([
    qbGet(`reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=Accrual&`),
    qbState.lastSyncTime ? qbGet(`cdc?entities=Invoice,Bill,JournalEntry,Payment,Purchase&changedSince=${qbState.lastSyncTime}&`) : Promise.resolve(null),
  ]);
  qbState.lastSyncTime = new Date().toISOString();
  if (plRes.status === "rejected") throw new Error("QB P&L unavailable: " + plRes.reason);
  const raw = parseQBRows(plRes.value?.Rows?.Row);
  const cdc = cdcRes.status === "fulfilled" ? cdcRes.value : null;

  const income = {
    food_sales: acct(raw,"4105"), liquor_sales: acct(raw,"4110"), beer_sales: acct(raw,"4115"),
    wine_sales: acct(raw,"4120"), na_bev_sales: acct(raw,"4125"), retail_sales: acct(raw,"4130"),
    misc_sales: acct(raw,"4140"), banquet_admin: acct(raw,"4145"), ticket_sales: acct(raw,"4150"),
    catering_food: acct(raw,"4155"), catering_na_bev: acct(raw,"4156"), banquet_na_bev: acct(raw,"4193"),
    banquet_food: acct(raw,"4194"), banquet_liquor: acct(raw,"4196"), banquet_beer: acct(raw,"4197"),
    banquet_wine: acct(raw,"4198"), transport_fee: acct(raw,"4200"), discounts_comps: acct(raw,"4500"),
  };
  income.total_sales = sum(
    income.food_sales, income.liquor_sales, income.beer_sales, income.wine_sales,
    income.na_bev_sales, income.retail_sales, income.misc_sales, income.banquet_admin,
    income.ticket_sales, income.catering_food, income.catering_na_bev, income.banquet_na_bev,
    income.banquet_food, income.banquet_liquor, income.banquet_beer, income.banquet_wine,
    income.transport_fee, income.discounts_comps
  );

  const cogs = {
    meat: acct(raw,"5101"), produce: acct(raw,"5103"), grocery: acct(raw,"5104"),
    bakery: acct(raw,"5105"), dairy: acct(raw,"5106"), bar_grocery: acct(raw,"5111"),
    liquor: acct(raw,"5110"), beer: acct(raw,"5115"), wine: acct(raw,"5120"),
    na_bev: acct(raw,"5125"), packaging: acct(raw,"5135"),
  };
  cogs.food  = sum(cogs.meat, cogs.produce, cogs.grocery, cogs.bakery, cogs.dairy);
  cogs.total = sum(cogs.food, cogs.bar_grocery, cogs.liquor, cogs.beer, cogs.wine, cogs.na_bev, cogs.packaging);

  const foh = { bartender: acct(raw,"5205-1"), bar_back: acct(raw,"5205-2"), busser: acct(raw,"5205-3"), host: acct(raw,"5205-7"), server: acct(raw,"5205-8"), training: acct(raw,"5205-9") };
  foh.total = sum(foh.bartender, foh.bar_back, foh.busser, foh.host, foh.server, foh.training);

  const boh = { prep: acct(raw,"5210-1"), dishwasher_porter: acct(raw,"5210-2"), line_cook: acct(raw,"5210-3"), chef: acct(raw,"5210-5"), sous_chef: acct(raw,"5210-6") };
  boh.total = sum(boh.prep, boh.dishwasher_porter, boh.line_cook, boh.chef, boh.sous_chef);

  const mgmt = { admin: acct(raw,"5215"), manager_salary: acct(raw,"5220-2"), labor_other: acct(raw,"5230") };
  mgmt.total = sum(mgmt.admin, mgmt.manager_salary, mgmt.labor_other);
  const direct_labor = sum(foh.total, boh.total, mgmt.total);

  const labor_related = {
    commission: acct(raw,"5310"), payroll_fica: acct(raw,"5315-1"), payroll_sui: acct(raw,"5315-2"),
    payroll_fui: acct(raw,"5315-3"), payroll_mta: acct(raw,"5315-4"), health_insurance: acct(raw,"5320"),
    workers_comp: acct(raw,"5325"), disability_ins: acct(raw,"5330"), epli_insurance: acct(raw,"5350"),
  };
  labor_related.total = sum(
    labor_related.commission, labor_related.payroll_fica, labor_related.payroll_sui,
    labor_related.payroll_fui, labor_related.payroll_mta, labor_related.health_insurance,
    labor_related.workers_comp, labor_related.disability_ins, labor_related.epli_insurance
  );
  const total_labor = sum(direct_labor, labor_related.total);

  const direct_ops = {
    cash_over_under: acct(raw,"6105"), equipment_lease: acct(raw,"6110"),
    cleaning_supplies: acct(raw,"6115"), restaurant_supplies: acct(raw,"6125"),
    laundry: acct(raw,"6135"), smallwares: acct(raw,"6150"), wood_supplies: acct(raw,"6175"),
    delivery_expense: acct(raw,"6180"), catering_rental: acct(raw,"6185"), music_dj: acct(raw,"6305"),
  };
  direct_ops.total = sum(
    direct_ops.cash_over_under, direct_ops.equipment_lease, direct_ops.cleaning_supplies,
    direct_ops.restaurant_supplies, direct_ops.laundry, direct_ops.smallwares,
    direct_ops.wood_supplies, direct_ops.delivery_expense, direct_ops.catering_rental, direct_ops.music_dj
  );

  const transaction_expenses = {
    cc_fees: acct(raw,"6205"), reservation_system: acct(raw,"6210"),
    third_party_commissions: acct(raw,"6215"), late_fees: acct(raw,"6220"), chargeback: acct(raw,"6615"),
  };
  transaction_expenses.total = sum(
    transaction_expenses.cc_fees, transaction_expenses.reservation_system,
    transaction_expenses.third_party_commissions, transaction_expenses.late_fees, transaction_expenses.chargeback
  );

  const marketing = {
    marketing_advertising: acct(raw,"6250"), marketing_pr: acct(raw,"6255"),
    advertising_promotions: acct(raw,"6260"), stationary_printing: acct(raw,"6580"),
  };
  marketing.total = sum(marketing.marketing_advertising, marketing.marketing_pr, marketing.advertising_promotions, marketing.stationary_printing);

  const ga_expenses = {
    research_development: acct(raw,"6450"), accounting_bookkeeping: acct(raw,"6505"),
    recruiting: acct(raw,"6512"), legal: acct(raw,"6520"), payroll_processing: acct(raw,"6525"),
    computer_software_it: acct(raw,"6535"), dues_subscriptions: acct(raw,"6550"),
    bank_charges: acct(raw,"6560"), license_permits: acct(raw,"6570"), office_supplies: acct(raw,"6575"),
    postage: acct(raw,"6585","6603"), liability_insurance: acct(raw,"6590"),
    penalties_settlements: acct(raw,"6600"), phone_internet: acct(raw,"6605"),
  };
  ga_expenses.total = sum(
    ga_expenses.research_development, ga_expenses.accounting_bookkeeping, ga_expenses.recruiting,
    ga_expenses.legal, ga_expenses.payroll_processing, ga_expenses.computer_software_it,
    ga_expenses.dues_subscriptions, ga_expenses.bank_charges, ga_expenses.license_permits,
    ga_expenses.office_supplies, ga_expenses.postage, ga_expenses.liability_insurance,
    ga_expenses.penalties_settlements, ga_expenses.phone_internet
  );

  const travel_meals = { travel_transport: acct(raw,"6705"), meals_entertainment: acct(raw,"6710"), parking: acct(raw,"6720") };
  travel_meals.total = sum(travel_meals.travel_transport, travel_meals.meals_entertainment, travel_meals.parking);

  const repair_maintenance = { equipment: acct(raw,"6810"), pest_control: acct(raw,"6820"), fire_control: acct(raw,"6825"), facility_supplies: acct(raw,"6835") };
  repair_maintenance.total = sum(repair_maintenance.equipment, repair_maintenance.pest_control, repair_maintenance.fire_control, repair_maintenance.facility_supplies);

  const total_controllable  = sum(direct_ops.total, transaction_expenses.total, marketing.total, ga_expenses.total, travel_meals.total, repair_maintenance.total);

  const property_expenses = {
    rent_lease: acct(raw,"7105"), common_area_maint: acct(raw,"7111"), property_re_tax: acct(raw,"7115"),
    property_insurance: acct(raw,"7120"), utility_electricity: acct(raw,"7125"), utility_gas: acct(raw,"7130"),
    utility_trash: acct(raw,"7135"), utility_water_sewage: acct(raw,"7140"),
  };
  property_expenses.total = sum(
    property_expenses.rent_lease, property_expenses.common_area_maint, property_expenses.property_re_tax,
    property_expenses.property_insurance, property_expenses.utility_electricity, property_expenses.utility_gas,
    property_expenses.utility_trash, property_expenses.utility_water_sewage
  );

  const other_expenses = { other_income_expense: acct(raw,"8130"), corporate_overhead: acct(raw,"8510") };
  other_expenses.total = sum(other_expenses.other_income_expense, other_expenses.corporate_overhead);

  const total_non_controllable = sum(property_expenses.total, other_expenses.total);
  const total_expenses         = sum(total_labor, total_controllable, total_non_controllable);
  const gross_profit           = sum(income.total_sales, -cogs.total);
  const net_operating_income   = sum(income.total_sales, -cogs.total, -total_expenses);
  const pct = (n) => income.total_sales > 0 ? +((n / income.total_sales) * 100).toFixed(1) : null;

  return {
    income, cogs,
    food_cost_pct: pct(cogs.food), total_cogs_pct: pct(cogs.total),
    liquor_cost_pct: pct(cogs.liquor), beer_cost_pct: pct(cogs.beer),
    wine_cost_pct: pct(cogs.wine), na_bev_cost_pct: pct(cogs.na_bev),
    gross_profit, gross_profit_pct: pct(gross_profit),
    foh, boh, mgmt, direct_labor,
    foh_labor_pct: pct(foh.total), boh_labor_pct: pct(boh.total), mgmt_labor_pct: pct(mgmt.total),
    labor_related, total_labor, total_labor_pct: pct(total_labor),
    direct_ops, transaction_expenses, marketing, ga_expenses, travel_meals, repair_maintenance,
    total_controllable, total_controllable_pct: pct(total_controllable),
    property_expenses, other_expenses,
    total_non_controllable, total_non_controllable_pct: pct(total_non_controllable),
    total_expenses, net_operating_income, net_operating_income_pct: pct(net_operating_income),
    prime_cost: sum(cogs.total, total_labor), prime_cost_pct: pct(sum(cogs.total, total_labor)),
    cdc_entities: cdc ? Object.keys(cdc.CDCResponse?.[0]?.QueryResponse || {}) : [],
    raw_accounts: raw, data_as_of: nowET(),
  };
}

// ── Mailchimp ─────────────────────────────────────────────────────────────────
async function fetchMailchimp() {
  if (!MC_API_KEY || !MC_SERVER || !MC_AUDIENCE_ID) throw new Error("Mailchimp credentials not configured");
  const base    = `https://${MC_SERVER}.api.mailchimp.com/3.0`;
  const auth    = "Basic " + Buffer.from(`anystring:${MC_API_KEY}`).toString("base64");
  const headers = { "Authorization": auth, "Content-Type": "application/json" };

  const [listRes, campaignsRes, activityRes] = await Promise.all([
    fetchWithRetry(`${base}/lists/${MC_AUDIENCE_ID}?fields=id,name,stats,date_created`, { headers }),
    fetchWithRetry(`${base}/campaigns?list_id=${MC_AUDIENCE_ID}&status=sent&count=5&sort_field=send_time&sort_dir=DESC&fields=campaigns.id,campaigns.settings.subject_line,campaigns.send_time,campaigns.emails_sent,campaigns.report_summary`, { headers }),
    fetchWithRetry(`${base}/lists/${MC_AUDIENCE_ID}/activity?fields=activity.day,activity.emails_sent,activity.unique_opens,activity.recipient_clicks,activity.subs,activity.unsubs&count=30`, { headers }),
  ]);

  if (!listRes.ok) throw new Error(`Mailchimp list failed: ${listRes.status}`);
  const list      = await listRes.json();
  const campaigns = campaignsRes.ok ? await campaignsRes.json() : { campaigns: [] };
  const activity  = activityRes.ok  ? await activityRes.json()  : { activity: [] };
  const stats     = list.stats || {};

  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  let emails_sent_30d=0,opens_30d=0,clicks_30d=0,subs_30d=0,unsubs_30d=0;
  for (const day of activity.activity || []) {
    if (new Date(day.day) >= thirtyDaysAgo) {
      emails_sent_30d += day.emails_sent || 0; opens_30d += day.unique_opens || 0;
      clicks_30d += day.recipient_clicks || 0; subs_30d += day.subs || 0; unsubs_30d += day.unsubs || 0;
    }
  }
  const toPercent = (v) => v != null ? +(v * 100).toFixed(1) : null;
  return {
    audience_name: list.name, total_subscribers: stats.member_count || 0,
    open_rate_avg: toPercent(stats.open_rate), click_rate_avg: toPercent(stats.click_rate),
    unsubscribe_rate: toPercent(stats.unsubscribe_rate),
    emails_sent_30d, opens_30d, clicks_30d, subs_30d, unsubs_30d,
    open_rate_30d: emails_sent_30d > 0 ? +((opens_30d/emails_sent_30d)*100).toFixed(1) : null,
    click_rate_30d: emails_sent_30d > 0 ? +((clicks_30d/emails_sent_30d)*100).toFixed(1) : null,
    net_list_growth_30d: subs_30d - unsubs_30d,
    recent_campaigns: (campaigns.campaigns || []).map(c => ({
      subject: c.settings?.subject_line || "—", send_time: c.send_time, emails_sent: c.emails_sent || 0,
      open_rate: c.report_summary?.open_rate != null ? +(c.report_summary.open_rate*100).toFixed(1) : null,
      click_rate: c.report_summary?.click_rate != null ? +(c.report_summary.click_rate*100).toFixed(1) : null,
      opens: c.report_summary?.unique_opens || 0, clicks: c.report_summary?.subscriber_clicks || 0,
    })),
    data_as_of: nowET(),
  };
}

// ── TripleSeat ────────────────────────────────────────────────────────────────
let tsState = {
  accessToken:    process.env.TRIPLESEAT_ACCESS_TOKEN  || null,
  refreshToken:   process.env.TRIPLESEAT_REFRESH_TOKEN || null,
  tokenExpiresAt: 0,
};

// Cache TripleSeat data — refresh once per hour max (events don't change minute to minute)
let tsCache = { data: null, fetchedAt: 0 };
const TS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function tsRefreshAccessToken() {
  if (!tsState.refreshToken) throw new Error("No TripleSeat refresh token — visit /auth/tripleseat");
  const res = await fetchWithRetry("https://api.tripleseat.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: tsState.refreshToken,
      client_id:     TS_CLIENT_ID,
      client_secret: TS_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TripleSeat token refresh failed: ${res.status} | ${body}`);
  }
  const data = await res.json();
  tsState.accessToken    = data.access_token;
  tsState.refreshToken   = data.refresh_token || tsState.refreshToken;
  tsState.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  console.log("TripleSeat token refreshed");
  // Persist to Railway
  await persistRailwayVars({
    TRIPLESEAT_ACCESS_TOKEN:  data.access_token,
    TRIPLESEAT_REFRESH_TOKEN: data.refresh_token || tsState.refreshToken,
  });
  return tsState.accessToken;
}

async function getTSToken() {
  if (!tsState.accessToken && !tsState.refreshToken) throw new Error("TripleSeat not authorized — visit /auth/tripleseat");
  if (tsState.accessToken && Date.now() < tsState.tokenExpiresAt) return tsState.accessToken;
  return tsRefreshAccessToken();
}

async function fetchTripleSeat() {
  // Return cached data if fresh
  if (tsCache.data && (Date.now() - tsCache.fetchedAt) < TS_CACHE_TTL) {
    console.log("TripleSeat: returning cached data");
    return tsCache.data;
  }

  const token = await getTSToken();
  const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
  const base = "https://api.tripleseat.com/v1";

  const fmtDate = (d) => {
    const dt = new Date(d+"T12:00:00");
    return `${String(dt.getMonth()+1).padStart(2,"0")}/${String(dt.getDate()).padStart(2,"0")}/${dt.getFullYear()}`;
  };

  const thirtyDaysOut = new Date(); thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const endFmt  = fmtDate(thirtyDaysOut.toISOString().slice(0,10));
  const pastFmt = fmtDate(thirtyDaysAgo.toISOString().slice(0,10));

  // Fetch page 1 to get total_pages, bookings, and leads all in parallel
  const [firstEventsRes, bookingsRes, leadsRes] = await Promise.all([
    fetchWithRetry(`${base}/events.json?per_page=50`, { headers }),
    fetchWithRetry(`${base}/bookings.json?per_page=50&start_date=${pastFmt}&end_date=${endFmt}`, { headers }),
    fetchWithRetry(`${base}/leads.json?per_page=50&start_date=${pastFmt}&end_date=${endFmt}`, { headers }),
  ]);

  if (!firstEventsRes.ok) throw new Error(`TripleSeat events failed: ${firstEventsRes.status}`);
  const firstEventsJson = await firstEventsRes.json();
  const totalPages = firstEventsJson.total_pages || 1;

  // Fetch last page for upcoming events (in parallel with nothing — already have bookings/leads)
  let lastEventsJson = firstEventsJson;
  if (totalPages > 1) {
    const lastEventsRes = await fetchWithRetry(`${base}/events.json?per_page=50&page=${totalPages}`, { headers });
    if (lastEventsRes.ok) lastEventsJson = await lastEventsRes.json();
  }

  const bookingsJson = bookingsRes.ok ? await bookingsRes.json() : {};
  const leadsJson    = leadsRes.ok   ? await leadsRes.json()    : {};
  const eventsJson   = lastEventsJson;

  // TripleSeat wraps all responses in {total_pages, results: [...]}
  const allEvents   = (eventsJson.results   || []);
  const bookings    = (bookingsJson.results  || []);
  const leads       = (leadsJson.results     || []);

  // Filter to upcoming NY events only, sorted ascending by date
  const todayISO = today();
  const events = allEvents
    .filter(e => {
      const dateStr = e.event_date_iso8601 || e.start_date || "";
      return dateStr >= todayISO;
    })
    .sort((a,b) => (a.event_date_iso8601||a.start_date||"").localeCompare(b.event_date_iso8601||b.start_date||""));

  // Upcoming events summary
  const upcomingEvents = events.slice(0, 10).map(e => ({
    name:          e.name || "—",
    date:          e.event_date_iso8601 || e.start_date || "—",
    guest_count:   e.guest_count || e.guests || 0,
    total_revenue: parseFloat(e.total_revenue || e.actual_revenue || 0),
    status:        e.status || "—",
    location:      typeof e.location === "object" ? (e.location?.name || "—") : (e.location || "—"),
  }));

  // Revenue pipeline from bookings — TripleSeat statuses: DEFINITE, TENTATIVE, CLOSED, CLOSED-LOST
  let confirmed_revenue=0, tentative_revenue=0, total_pipeline=0;
  let confirmed_count=0, tentative_count=0;
  for (const b of bookings) {
    const rev = parseFloat(b.total_grand_total || b.total_actual_amount || b.total_event_grand_total || 0);
    const status = (b.status || "").toUpperCase();
    if (status === "CLOSED-LOST" || status === "CLOSED") continue; // exclude closed/lost
    total_pipeline += rev;
    if (status === "DEFINITE") {
      confirmed_revenue += rev; confirmed_count++;
    } else {
      tentative_revenue += rev; tentative_count++;
    }
  }

  // Leads summary — exclude converted leads
  const open_leads = leads.filter(l => !l.converted_at && !l.deleted_at).length;
  const total_lead_value = leads.filter(l => !l.converted_at && !l.deleted_at)
    .reduce((s,l) => s + parseFloat(l.estimated_revenue || l.total_revenue || 0), 0);

  const result = {
    upcoming_events:      upcomingEvents,
    event_count_upcoming: events.length,
    booking_count:        bookings.length,
    confirmed_revenue:    +confirmed_revenue.toFixed(2),
    tentative_revenue:    +tentative_revenue.toFixed(2),
    total_pipeline:       +total_pipeline.toFixed(2),
    confirmed_count,
    tentative_count,
    open_leads,
    total_lead_value:     +total_lead_value.toFixed(2),
    data_as_of:           nowET(),
  };

  tsCache = { data: result, fetchedAt: Date.now() };
  console.log(`TripleSeat: fetched live data, pipeline=$${result.total_pipeline}, events=${result.event_count_upcoming}`);
  return result;
}
async function getGoTabToken() {
  const res = await fetchWithRetry("https://gotab.io/api/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_access_id: GOTAB_ID, api_access_secret: GOTAB_SECRET }),
  });
  if (!res.ok) throw new Error(`GoTab auth failed: ${res.status}`);
  return (await res.json()).token;
}

function goTabQuery(locationUuid, fiscalDay) {
  return {
    query: `query($locationUuid: String, $tabCreationDate: Datetime) {
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

function normalizeGoTab(tabs) {
  let net_sales=0,tax_total=0,bar_sales=0,catering_sales=0,voids=0,comps=0,tip_total=0,tab_count=0,deferred_revenue=0;
  const BAR=["Sales, Liquor:","Sales, Beer:","Sales, Non-Alcoholic Beverage:","Sales, Wine:","Sales, Banquet Liquor:","Sales, Banquet Beer:","Sales, Banquet Wine:","Sales, Banquet N/A Beverage:"];
  const CAT=["Sales, Catering Food:","Sales, Banquet Food:","Sales, Banquet Admin Fee:","Sales, Transport Fee:"];
  const EX=["DEFERRED_REVENUE","PROCESSORS","EXPENSE"];
  for (const tab of tabs) {
    const tt=tab.tax||0,tto=tab.total||0,ts=tab.subtotal||0,ta=tab.autogratDue||0;
    tax_total+=tt; const tip=tto-ts-tt-ta; if(tip>0) tip_total+=tip; tab_count++;
    for (const item of tab.items||[]) {
      const g=item.accountingStream?.reportingGroup||"",n=item.accountingStream?.name||"",a=item.subtotal||0;
      if(EX.includes(g)){if(g==="DEFERRED_REVENUE") deferred_revenue+=a;continue;}
      if(n.startsWith("Discounts and Comps")){comps+=Math.abs(a);continue;}
      if(item.voided||g==="VOID"){voids+=Math.abs(a);continue;}
      net_sales+=a;
      if(BAR.some(b=>n.startsWith(b))) bar_sales+=a;
      else if(CAT.some(b=>n.startsWith(b))) catering_sales+=a;
    }
  }
  return {
    net_sales:+(net_sales/100).toFixed(2), tab_count,
    bar_sales:+(bar_sales/100).toFixed(2), catering_sales:+(catering_sales/100).toFixed(2),
    voids:+(voids/100).toFixed(2), comps:+(comps/100).toFixed(2),
    tax_total:+(tax_total/100).toFixed(2), tip_total:+(tip_total/100).toFixed(2),
    deferred_revenue:+(deferred_revenue/100).toFixed(2), data_as_of:nowET(),
  };
}

// ── 7Shifts ───────────────────────────────────────────────────────────────────
async function fetch7Shifts(date) {
  const headers = {
    "Authorization": `Bearer ${SHIFTS_TOKEN}`, "Content-Type": "application/json",
    ...(SHIFTS_COMPANY_GUID ? {"x-company-guid": SHIFTS_COMPANY_GUID} : {}),
  };
  const base = `https://api.7shifts.com/v2/company/${SHIFTS_COMPANY_ID}`;
  const [sRes,pRes] = await Promise.all([
    fetchWithRetry(`${base}/shifts?location_id=${SHIFTS_LOCATION_ID}&start=${date}T00:00:00&end=${date}T23:59:59&limit=200`, {headers}),
    fetchWithRetry(`${base}/time_punches?location_id=${SHIFTS_LOCATION_ID}&clocked_in_gte=${date}T00:00:00&clocked_in_lte=${date}T23:59:59&limit=200`, {headers}),
  ]);
  if (!sRes.ok) throw new Error(`7Shifts shifts failed: ${sRes.status}`);
  if (!pRes.ok) throw new Error(`7Shifts punches failed: ${pRes.status}`);
  const shifts=(await sRes.json()).data||[], punches=(await pRes.json()).data||[];
  let sh=0,ah=0,lc=0,oh=0,ns=0;
  for (const s of shifts) sh+=(new Date(s.end)-new Date(s.start))/3600000;
  for (const p of punches) { if(p.clocked_in&&p.clocked_out){const h=(new Date(p.clocked_out)-new Date(p.clocked_in))/3600000;ah+=h;if(p.wage_cents) lc+=(h*p.wage_cents)/100;if(h>8) oh+=h-8;}}
  const pi=new Set(punches.map(p=>p.user_id));
  for (const s of shifts) if(s.user_id&&!pi.has(s.user_id)) ns++;
  return {scheduled_hours:+sh.toFixed(1),actual_hours:+ah.toFixed(1),labor_cost:+lc.toFixed(2),labor_pct:null,overtime_hours:+oh.toFixed(1),no_shows:ns,shift_count:shifts.length,punch_count:punches.length,data_as_of:nowET()};
}

// ── MarginEdge ────────────────────────────────────────────────────────────────
function bucketCogs(cogs,cat,amt){
  const c=(cat||"").toLowerCase();
  if(c.includes("meat")||c.includes("protein")||c.includes("bbq")||c.includes("poultry")||c.includes("seafood")||c.includes("fish")||c.includes("brisket")||c.includes("chicken")||c.includes("pork")||c.includes("beef")||c.includes("sausage")||c.includes("lamb")||c.includes("turkey")){cogs.meat+=amt;cogs.food+=amt;}
  else if(c.includes("produce")||c.includes("vegetable")||c.includes("fruit")||c.includes("lettuce")||c.includes("tomato")||c.includes("onion")||c.includes("pepper")||c.includes("herb")){cogs.produce+=amt;cogs.food+=amt;}
  else if(c.includes("dairy")||c.includes("egg")||c.includes("cheese")||c.includes("butter")||c.includes("cream")||c.includes("milk")){cogs.dairy+=amt;cogs.food+=amt;}
  else if(c.includes("grocery")||c.includes("dry")||c.includes("pantry")||c.includes("baked")||c.includes("bread")||c.includes("bakery")||c.includes("flour")||c.includes("sugar")||c.includes("oil")||c.includes("sauce")||c.includes("spice")||c.includes("condiment")){cogs.grocery+=amt;cogs.food+=amt;}
  else if(c.includes("vodka")||c.includes("whiskey")||c.includes("whisky")||c.includes("bourbon")||c.includes("tequila")||c.includes("gin")||c.includes("rum")||c.includes("scotch")||c.includes("brandy")||c.includes("cognac")||c.includes("triple sec")||c.includes("liqueur")||c.includes("spirit")||c.includes("liquor")||c.includes("cocktail")||c.includes("mezcal")||c.includes("pf")){cogs.liquor+=amt;}
  else if(c.includes("beer")||c.includes("draft")||c.includes("brew")||c.includes("ale")||c.includes("lager")||c.includes("ipa")||c.includes("stout")||c.includes("porter")||c.includes("cider")){cogs.beer+=amt;}
  else if(c.includes("wine")||c.includes("chardonnay")||c.includes("cabernet")||c.includes("merlot")||c.includes("pinot")||c.includes("sauvignon")||c.includes("riesling")||c.includes("prosecco")||c.includes("champagne")||c.includes("brut")||c.includes("rose")||c.includes("rosé")||c.includes("blanc")||c.includes("noir")){cogs.wine+=amt;}
  else if(c.includes("non-alc")||c.includes("na bev")||c.includes("beverage")||c.includes("soda")||c.includes("juice")||c.includes("water")||c.includes("coffee")||c.includes("tea")||c.includes("energy")||c.includes("sparkling")){cogs.na_bev+=amt;}
  else if(c.includes("paper")||c.includes("packaging")||c.includes("to-go")||c.includes("disposable")||c.includes("napkin")||c.includes("container")||c.includes("bag")||c.includes("wrap")||c.includes("foil")){cogs.paper+=amt;}
  else if(c.includes("supply")||c.includes("supplies")||c.includes("cleaning")||c.includes("chemical")||c.includes("sanitizer")||c.includes("detergent")){cogs.supplies+=amt;}
  else{cogs.other+=amt;}
}

async function fetchMarginEdge(date) {
  const headers = {"X-Api-Key": MARGINEDGE_API_KEY, "Accept": "application/json"};
  const base = "https://api.marginedge.com/public", rid = MARGINEDGE_TENANT_ID;
  const ordersRes = await fetchWithRetry(`${base}/orders?restaurantUnitId=${rid}&startDate=${date}&endDate=${date}&orderStatus=CLOSED`, {headers});
  if (!ordersRes.ok) throw new Error(`MarginEdge orders failed: ${ordersRes.status}`);
  const ordersJson = await ordersRes.json();
  const orders = ordersJson.orders||ordersJson.data||(Array.isArray(ordersJson)?ordersJson:[]);
  const cogs = {food:0,meat:0,produce:0,dairy:0,grocery:0,liquor:0,beer:0,wine:0,na_bev:0,paper:0,supplies:0,other:0,total:0};
  const details = await Promise.all(orders.slice(0,10).map(o=>
    Promise.race([
      fetchWithRetry(`${base}/orders/${o.orderId}?restaurantUnitId=${rid}`,{headers}).then(r=>r.ok?r.json():null).catch(()=>null),
      new Promise(r=>setTimeout(()=>r(null),5000)), // 5s timeout per order detail
    ])
  ));
  for (let i=0;i<details.length;i++) {
    const d=details[i],o=orders[i];
    if (!d){const a=parseFloat(o.orderTotal||0);if(a){cogs.total+=a;cogs.other+=a;}continue;}
    const lines=d.lineItems||d.line_items||d.items||d.orderItems||[];
    if (!lines.length){const a=parseFloat(d.orderTotal||o.orderTotal||0);if(a){cogs.total+=a;bucketCogs(cogs,d.vendorName||o.vendorName||"",a);}continue;}
    for (const l of lines){const cat=l.category||l.categoryName||l.category_name||l.categoryType||l.vendorItemName||l.vendorItemCode||"";const a=parseFloat(l.linePrice||l.extendedCost||l.extended_cost||l.amount||l.total||l.cost||l.lineTotal||0);if(!a) continue;cogs.total+=a;bucketCogs(cogs,cat,a);}
  }
  for (const k of Object.keys(cogs)) cogs[k]=+cogs[k].toFixed(2);
  return {invoice_count:orders.length,pending_invoices:0,cogs,food_cost_pct:null,total_cogs_pct:null,data_as_of:nowET()};
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/auth/quickbooks",(req,res)=>{
  if (!QB_CLIENT_ID) return res.status(500).send("QB_CLIENT_ID not set.");
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("client_id",QB_CLIENT_ID); url.searchParams.set("redirect_uri",QB_REDIRECT_URI);
  url.searchParams.set("response_type","code"); url.searchParams.set("scope",QB_SCOPES);
  url.searchParams.set("state",Math.random().toString(36).slice(2));
  res.redirect(url.toString());
});

app.get("/auth/quickbooks/callback",async(req,res)=>{
  const{code,realmId,error}=req.query;
  if (error) return res.send(`<h2>QB Auth Failed</h2><p>${error}</p>`);
  if (!code||!realmId) return res.status(400).send("<h2>Missing code or realmId</h2>");
  try {
    const creds = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetchWithRetry("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",{method:"POST",headers:{"Authorization":`Basic ${creds}`,"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:QB_REDIRECT_URI})});
    if (!tokenRes.ok){const body=await tokenRes.text();return res.status(500).send(`<h2>Token exchange failed</h2><pre>${body}</pre>`);}
    const tokens = await tokenRes.json();
    qbState.accessToken=tokens.access_token; qbState.refreshToken=tokens.refresh_token;
    qbState.realmId=realmId; qbState.tokenExpiresAt=Date.now()+(tokens.expires_in-60)*1000;
    await persistQBRefreshToken(tokens.refresh_token);
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>QB Connected</title><style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#f5f5f3}h1{color:#1D9E75}.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:0.5px solid rgba(0,0,0,0.1)}.label{font-size:11px;font-weight:600;color:#6b6b67;text-transform:uppercase;margin-bottom:6px}.value{font-family:monospace;font-size:12px;background:#f5f5f3;padding:10px;border-radius:8px;word-break:break-all}.step{background:#e1f5ee;color:#085041;padding:12px;border-radius:8px;font-size:13px}.warn{background:#faeeda;color:#633806;padding:12px;border-radius:8px;font-size:13px;margin-top:16px}</style></head><body><h1>✓ QuickBooks Connected</h1><p>Token automatically saved to Railway.</p><div class="card"><div class="label">QB_REALM_ID</div><div class="value">${realmId}</div></div><div class="card"><div class="label">QB_REFRESH_TOKEN</div><div class="value">${tokens.refresh_token}</div></div><div class="step">✓ Token persisted. Verify: <strong>curl https://ric.up.railway.app/api/quickbooks/status</strong></div><div class="warn">⚠️ Close this tab. Token rotates automatically.</div></body></html>`);
  } catch(err){res.status(500).send(`<h2>Callback error</h2><pre>${err.message}</pre>`);}
});

app.get("/auth/tripleseat",(req,res)=>{
  if (!TS_CLIENT_ID) return res.status(500).send("TRIPLESEAT_CLIENT_ID not set.");
  const url = new URL("https://login.tripleseat.com/oauth2/authorize");
  url.searchParams.set("client_id",    TS_CLIENT_ID);
  url.searchParams.set("redirect_uri", TS_REDIRECT_URI);
  url.searchParams.set("response_type","code");
  url.searchParams.set("scope",        "read");
  url.searchParams.set("state",        Math.random().toString(36).slice(2));
  res.redirect(url.toString());
});

app.get("/auth/tripleseat/callback",async(req,res)=>{
  const{code,error}=req.query;
  if (error) return res.send(`<h2>TripleSeat Auth Failed</h2><p>${error}</p>`);
  if (!code) return res.status(400).send("<h2>Missing code</h2>");
  try {
    const tokenRes = await fetchWithRetry("https://api.tripleseat.com/oauth2/token",{
      method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        grant_type:"authorization_code", code,
        client_id:TS_CLIENT_ID, client_secret:TS_CLIENT_SECRET,
        redirect_uri:TS_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok){const body=await tokenRes.text();return res.status(500).send(`<h2>TS Token exchange failed</h2><pre>${body}</pre>`);}
    const tokens = await tokenRes.json();
    tsState.accessToken    = tokens.access_token;
    tsState.refreshToken   = tokens.refresh_token;
    tsState.tokenExpiresAt = Date.now() + (tokens.expires_in - 60) * 1000;
    await persistRailwayVars({
      TRIPLESEAT_ACCESS_TOKEN:  tokens.access_token,
      TRIPLESEAT_REFRESH_TOKEN: tokens.refresh_token,
    });
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>TripleSeat Connected</title>
<style>body{font-family:-apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;background:#f5f5f3}
h1{color:#1D9E75}.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:0.5px solid rgba(0,0,0,0.1)}
.label{font-size:11px;font-weight:600;color:#6b6b67;text-transform:uppercase;margin-bottom:6px}
.value{font-family:monospace;font-size:12px;background:#f5f5f3;padding:10px;border-radius:8px;word-break:break-all}
.step{background:#e1f5ee;color:#085041;padding:12px;border-radius:8px;font-size:13px}</style></head>
<body><h1>✓ TripleSeat Connected</h1><p>Tokens saved automatically to Railway.</p>
<div class="card"><div class="label">Access Token</div><div class="value">${tokens.access_token}</div></div>
<div class="card"><div class="label">Refresh Token</div><div class="value">${tokens.refresh_token}</div></div>
<div class="step">Test: <strong>curl https://ric.up.railway.app/api/tripleseat</strong></div>
</body></html>`);
  } catch(err){res.status(500).send(`<h2>TS Callback error</h2><pre>${err.message}</pre>`);}
});

app.get("/api/tripleseat",async(req,res)=>{
  try {
    if (!tsState.accessToken&&!tsState.refreshToken) return res.status(401).json({ok:false,error:"Not authorized — visit /auth/tripleseat"});
    res.json({ok:true,source:"tripleseat_live",...await fetchTripleSeat()});
  } catch(err){console.error("TripleSeat error:",err.message);res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/quickbooks/status",(_req,res)=>{
  res.json({ok:true,authorized:!!qbState.refreshToken,realmId:qbState.realmId||null,
    tokenValid:Date.now()<qbState.tokenExpiresAt,
    tokenExpiresAt:qbState.tokenExpiresAt?new Date(qbState.tokenExpiresAt).toISOString():null,
    lastSyncTime:qbState.lastSyncTime,
    railwayPersistenceEnabled:!!(RAILWAY_API_TOKEN&&RAILWAY_PROJECT_ID&&RAILWAY_SERVICE_ID&&RAILWAY_ENVIRONMENT_ID)});
});

app.get("/api/quickbooks",async(req,res)=>{
  try {
    if (!qbState.refreshToken) return res.status(401).json({ok:false,error:"Not authorized — visit /auth/quickbooks"});
    const start=req.query.start||today(), end=req.query.end||today();
    res.json({ok:true,source:"quickbooks_live",start,end,...await fetchQuickBooks(start,end)});
  } catch(err){console.error("QB error:",err.message);res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/mailchimp",async(req,res)=>{
  try{res.json({ok:true,source:"mailchimp_live",...await fetchMailchimp()});}
  catch(err){console.error("Mailchimp error:",err.message);res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/gotab/streams",async(req,res)=>{
  try {
    const date=req.query.date||today(), token=await getGoTabToken();
    const gqlRes=await fetchWithRetry("https://gotab.io/api/v2/graph",{method:"POST",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(goTabQuery(GOTAB_LOCATION_UUID,date))});
    const gqlData=await gqlRes.json(), tabs=gqlData?.data?.locations?.[0]?.tabs||[], streams={};
    for (const tab of tabs) for (const item of tab.items||[]){
      const g=item.accountingStream?.reportingGroup||"NONE",n=item.accountingStream?.name||"NONE",key=`${g} | ${n}`;
      if(!streams[key]) streams[key]={reportingGroup:g,name:n,count:0,subtotal_cents:0};
      streams[key].count++; streams[key].subtotal_cents+=item.subtotal||0;
    }
    res.json({total_tabs:tabs.length,streams:Object.values(streams).sort((a,b)=>b.subtotal_cents-a.subtotal_cents)});
  } catch(err){res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/gotab",async(req,res)=>{
  try {
    const date=req.query.date||today(), token=await getGoTabToken();
    const gqlRes=await fetchWithRetry("https://gotab.io/api/v2/graph",{method:"POST",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(goTabQuery(GOTAB_LOCATION_UUID,date))});
    if (!gqlRes.ok) throw new Error(`GoTab GraphQL error: ${gqlRes.status}`);
    const gqlData=await gqlRes.json();
    if (gqlData.errors) throw new Error(gqlData.errors[0]?.message||"GraphQL error");
    res.json({ok:true,source:"gotab_live",date,...normalizeGoTab(gqlData?.data?.locations?.[0]?.tabs||[])});
  } catch(err){console.error("GoTab error:",err.message);res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/7shifts",async(req,res)=>{
  try{res.json({ok:true,source:"7shifts_live",date:req.query.date||today(),...await fetch7Shifts(req.query.date||today())});}
  catch(err){console.error("7Shifts error:",err.message);res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/marginedge",async(req,res)=>{
  try{res.json({ok:true,source:"marginedge_live",date:req.query.date||today(),...await fetchMarginEdge(req.query.date||today())});}
  catch(err){console.error("MarginEdge error:",err.message);res.status(500).json({ok:false,error:err.message});}
});

app.get("/api/ric",async(req,res)=>{
  const date=req.query.date||today(), result={date,sources:{}};

  // Fetch all sources in parallel
  const [goTabResult, meResult, qbResult, mcResult] = await Promise.allSettled([
    // GoTab
    getGoTabToken().then(token=>fetchWithRetry("https://gotab.io/api/v2/graph",{method:"POST",headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(goTabQuery(GOTAB_LOCATION_UUID,date))})).then(r=>r.json()).then(d=>normalizeGoTab(d?.data?.locations?.[0]?.tabs||[])),
    // MarginEdge
    fetchMarginEdge(date),
    // QuickBooks
    (qbState.refreshToken&&qbState.realmId)?fetchQuickBooks(date,date):Promise.reject(new Error("QB not authorized")),
    // Mailchimp
    fetchMailchimp(),
  ]);

  // GoTab
  if(goTabResult.status==="fulfilled"){result.gotab=goTabResult.value;result.sources.gotab="live";}
  else{console.error("GoTab failed:",goTabResult.reason?.message);result.gotab=null;result.sources.gotab=`error: ${goTabResult.reason?.message}`;}

  // 7Shifts (always errors currently — keep fast)
  result["7shifts"]=null;result.sources["7shifts"]="error: JWT not supported";

  // MarginEdge
  if(meResult.status==="fulfilled"){
    const me=meResult.value;
    if(result.gotab?.net_sales){
      if(me.cogs?.food)  me.food_cost_pct=+((me.cogs.food/result.gotab.net_sales)*100).toFixed(1);
      if(me.cogs?.total) me.total_cogs_pct=+((me.cogs.total/result.gotab.net_sales)*100).toFixed(1);
    }
    result.marginedge=me;result.sources.marginedge="live";
  } else {console.error("MarginEdge failed:",meResult.reason?.message);result.marginedge=null;result.sources.marginedge=`error: ${meResult.reason?.message}`;}

  // QuickBooks
  if(qbResult.status==="fulfilled"){
    result.sources.quickbooks="live";
    const qb=qbResult.value;
    const hasRevenue=(qb.income?.total_sales||0)>0;
    const hasLabor=(qb.total_labor||0)>0;
    const hasSignificantExpenses=(qb.total_controllable||0)>1000;
    if(hasRevenue||hasLabor||hasSignificantExpenses){
      if(result.gotab?.net_sales&&qb.total_labor) qb.total_labor_pct=+((qb.total_labor/result.gotab.net_sales)*100).toFixed(1);
      result.quickbooks=qb;
    } else {result.quickbooks=null;console.log("QB excluded — sparse data");}
  } else {console.error("QB failed:",qbResult.reason?.message);result.quickbooks=null;result.sources.quickbooks=`error: ${qbResult.reason?.message}`;}

  // Mailchimp
  if(mcResult.status==="fulfilled"){result.mailchimp=mcResult.value;result.sources.mailchimp="live";}
  else{console.error("Mailchimp failed:",mcResult.reason?.message);result.mailchimp=null;result.sources.mailchimp=`error: ${mcResult.reason?.message}`;}

  // TripleSeat — use cache only, never block /api/ric
  if(tsState.accessToken||tsState.refreshToken){
    if(tsCache.data){result.tripleseat=tsCache.data;result.sources.tripleseat="live";}
    else{fetchTripleSeat().catch(e=>console.error("TS background warm failed:",e.message));result.tripleseat=null;result.sources.tripleseat="warming";}
  }

  res.json({ok:true,...result});
});

app.post("/api/claude",async(req,res)=>{
  try{
    res.setHeader("Connection","keep-alive");
    const upstream=await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
      body:JSON.stringify({...req.body,stream:false}),
      signal:AbortSignal.timeout(55000), // 55s timeout — just under Railway's 60s limit
    });
    if(!upstream.ok){
      const err=await upstream.text();
      return res.status(upstream.status).json({ok:false,error:err});
    }
    const data=await upstream.json();
    res.json(data);
  }catch(err){
    console.error("Claude proxy error:",err.message);
    res.status(500).json({ok:false,error:err.message});
  }
});

app.get("/health",(_req,res)=>res.json({
  ok:true,service:"hch-ric-proxy",version:"3.9",
  railwayPersistence:!!(RAILWAY_API_TOKEN&&RAILWAY_PROJECT_ID&&RAILWAY_SERVICE_ID&&RAILWAY_ENVIRONMENT_ID),
}));

app.get("/",(_req,res)=>{
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate");
  res.sendFile(join(__dirname,"index.html"));
});

app.listen(PORT,()=>console.log(`RIC proxy v3.7 running on port ${PORT}`));
