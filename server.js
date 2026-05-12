// Hill Country Hospitality — RIC Proxy Server v2.9
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const GOTAB_ID              = process.env.GOTAB_ID;
const GOTAB_SECRET          = process.env.GOTAB_SECRET;
const GOTAB_LOCATION_UUID   = process.env.GOTAB_LOCATION_UUID;
const SHIFTS_TOKEN          = process.env.SHIFTS_TOKEN;
const SHIFTS_COMPANY_GUID   = process.env.SHIFTS_COMPANY_GUID;
const SHIFTS_COMPANY_ID     = process.env.SHIFTS_COMPANY_ID;
const SHIFTS_LOCATION_ID    = process.env.SHIFTS_LOCATION_ID;
const MARGINEDGE_API_KEY    = process.env.MARGINEDGE_API_KEY;
const MARGINEDGE_TENANT_ID  = process.env.MARGINEDGE_TENANT_ID;

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

// ── GoTab auth ────────────────────────────────────────────────────────────────
async function getGoTabToken() {
  const res = await fetch("https://gotab.io/api/oauth/token", {
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
    "Sales, Liquor:",
    "Sales, Beer:",
    "Sales, Non-Alcoholic Beverage:",
    "Sales, Wine:",
    "Sales, Banquet Liquor:",
    "Sales, Banquet Beer:",
    "Sales, Banquet Wine:",
    "Sales, Banquet N/A Beverage:",
  ];
  const CATERING_STREAMS = [
    "Sales, Catering Food:",
    "Sales, Banquet Food:",
    "Sales, Banquet Admin Fee:",
    "Sales, Transport Fee:",
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

      if (EXCLUDE_GROUPS.includes(g)) {
        if (g === "DEFERRED_REVENUE") deferred_revenue += amt;
        continue;
      }
      if (n.startsWith("Discounts and Comps")) { comps += Math.abs(amt); continue; }
      if (item.voided || g === "VOID")          { voids += Math.abs(amt); continue; }

      net_sales += amt;
      if (BAR_STREAMS.some(b => n.startsWith(b)))      bar_sales      += amt;
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
    fetch(`${base}/shifts?location_id=${SHIFTS_LOCATION_ID}&start=${date}T00:00:00&end=${date}T23:59:59&limit=200`, { headers }),
    fetch(`${base}/time_punches?location_id=${SHIFTS_LOCATION_ID}&clocked_in_gte=${date}T00:00:00&clocked_in_lte=${date}T23:59:59&limit=200`, { headers }),
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
async function fetchMarginEdge(date) {
  const headers = {
    "x-api-key":    MARGINEDGE_API_KEY,
    "Content-Type": "application/json",
    "Accept":       "application/json",
  };
  const base   = `https://api.marginedge.com/public/v1`;
  const tenant = MARGINEDGE_TENANT_ID;

  // Fetch invoices (COGS) and P&L in parallel; P&L may not exist — fail softly
  const [invoiceRes, plRes] = await Promise.allSettled([
    fetch(`${base}/restaurants/${tenant}/invoices?startDate=${date}&endDate=${date}&limit=200`, { headers }),
    fetch(`${base}/restaurants/${tenant}/pnl?startDate=${date}&endDate=${date}`, { headers }),
  ]);

  if (invoiceRes.status === "rejected" || !invoiceRes.value.ok) {
    const status = invoiceRes.value?.status || "network error";
    throw new Error(`MarginEdge invoices failed: ${status}`);
  }

  const invoiceJson = await invoiceRes.value.json();
  const invoices    = invoiceJson.data || invoiceJson.invoices || (Array.isArray(invoiceJson) ? invoiceJson : []);

  // Aggregate COGS by category
  const cogs = { food: 0, meat: 0, produce: 0, dairy: 0, grocery: 0,
                 liquor: 0, beer: 0, wine: 0, na_bev: 0,
                 paper: 0, supplies: 0, other: 0, total: 0 };

  let pending_invoices = 0;
  let invoice_count    = 0;

  for (const inv of invoices) {
    invoice_count++;
    if ((inv.status || "").toLowerCase().includes("pending")) pending_invoices++;

    for (const line of inv.lineItems || inv.line_items || inv.lines || []) {
      const cat = (line.category || line.categoryName || line.category_name || "").toLowerCase();
      const amt = parseFloat(line.amount || line.total || line.cost || line.extended_cost || 0);
      if (!amt) continue;

      cogs.total += amt;

      if      (cat.includes("meat") || cat.includes("protein") || cat.includes("bbq") || cat.includes("poultry") || cat.includes("seafood")) { cogs.meat    += amt; cogs.food += amt; }
      else if (cat.includes("produce") || cat.includes("vegetable") || cat.includes("fruit"))                                                  { cogs.produce += amt; cogs.food += amt; }
      else if (cat.includes("dairy") || cat.includes("egg"))                                                                                   { cogs.dairy   += amt; cogs.food += amt; }
      else if (cat.includes("grocery") || cat.includes("dry") || cat.includes("pantry") || cat.includes("baked") || cat.includes("bread"))     { cogs.grocery += amt; cogs.food += amt; }
      else if (cat.includes("liquor") || cat.includes("spirit") || cat.includes("cocktail"))                                                   { cogs.liquor  += amt; }
      else if (cat.includes("beer"))                                                                                                            { cogs.beer    += amt; }
      else if (cat.includes("wine"))                                                                                                            { cogs.wine    += amt; }
      else if (cat.includes("non-alc") || cat.includes("na bev") || cat.includes("beverage") || cat.includes("soda") || cat.includes("juice")) { cogs.na_bev  += amt; }
      else if (cat.includes("paper") || cat.includes("packaging") || cat.includes("to-go") || cat.includes("disposable"))                      { cogs.paper   += amt; }
      else if (cat.includes("supply") || cat.includes("supplies") || cat.includes("cleaning") || cat.includes("chemical"))                     { cogs.supplies += amt; }
      else                                                                                                                                       { cogs.other   += amt; }
    }
  }

  for (const key of Object.keys(cogs)) cogs[key] = +cogs[key].toFixed(2);

  // P&L — optional, fail softly
  let pnl = null;
  if (plRes.status === "fulfilled" && plRes.value.ok) {
    try { pnl = await plRes.value.json(); } catch (_) {}
  }

  return {
    invoice_count,
    pending_invoices,
    cogs,
    food_cost_pct:   null, // populated in /api/ric when net_sales is known
    total_cogs_pct:  null,
    pnl,
    data_as_of:      nowET(),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Diagnostic: all GoTab accounting streams sorted by revenue
app.get("/api/gotab/streams", async (req, res) => {
  try {
    const date  = req.query.date || today();
    const token = await getGoTabToken();
    const gqlRes = await fetch("https://gotab.io/api/v2/graph", {
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

// GoTab only
app.get("/api/gotab", async (req, res) => {
  try {
    const date  = req.query.date || today();
    const token = await getGoTabToken();
    const gqlRes = await fetch("https://gotab.io/api/v2/graph", {
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

// 7Shifts only
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

// MarginEdge only
// MarginEdge diagnostic
app.get("/api/marginedge/auth", async (req, res) => {
  const key    = MARGINEDGE_API_KEY;
  const tenant = MARGINEDGE_TENANT_ID;
  const url    = `https://api.marginedge.com/public/v1/restaurants/${tenant}/invoices`;
  const results = {};

  const attempts = [
    { label: "x-api-key",          headers: { "x-api-key": key } },
    { label: "Authorization Bearer", headers: { "Authorization": `Bearer ${key}` } },
    { label: "Authorization Basic", headers: { "Authorization": `Basic ${Buffer.from(key).toString("base64")}` } },
    { label: "api-key",             headers: { "api-key": key } },
    { label: "X-Auth-Token",        headers: { "X-Auth-Token": key } },
    { label: "token",               headers: { "token": key } },
  ];

  for (const { label, headers } of attempts) {
    try {
      const r = await fetch(url, { headers: { ...headers, "Accept": "application/json" } });
      const body = await r.text();
      results[label] = { status: r.status, body: body.slice(0, 200) };
    } catch (e) {
      results[label] = { error: e.message };
    }
  }

  res.json(results);
});

  res.json(results);
});

// Claude proxy (non-streaming)
app.post("/api/claude", async (req, res) => {
  try {
    const body = { ...req.body, stream: false };
    console.log("Calling Anthropic API...");
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    console.log("Anthropic status:", upstream.status);
    console.log("Anthropic response:", JSON.stringify(data).slice(0, 300));
    res.json(data);
  } catch(err) {
    console.error("Claude proxy error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "hch-ric-proxy", version: "2.9" }));

// Serve RIC app
app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(join(__dirname, "index.html"));
});

app.listen(PORT, () => console.log(`RIC proxy v2.9 running on port ${PORT}`));
