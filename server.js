// Hill Country Hospitality — RIC Proxy Server v3.0
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const GOTAB_ID             = process.env.GOTAB_ID;
const GOTAB_SECRET         = process.env.GOTAB_SECRET;
const GOTAB_LOCATION_UUID  = process.env.GOTAB_LOCATION_UUID;
const SHIFTS_TOKEN         = process.env.SHIFTS_TOKEN;
const SHIFTS_COMPANY_GUID  = process.env.SHIFTS_COMPANY_GUID;
const SHIFTS_COMPANY_ID    = process.env.SHIFTS_COMPANY_ID;
const SHIFTS_LOCATION_ID   = process.env.SHIFTS_LOCATION_ID;
const MARGINEDGE_API_KEY   = process.env.MARGINEDGE_API_KEY;
const MARGINEDGE_TENANT_ID = process.env.MARGINEDGE_TENANT_ID; // 683280536

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
function bucketCogs(cogs, cat, amt) {
  const c = (cat || "").toLowerCase();
  if      (c.includes("meat") || c.includes("protein") || c.includes("bbq") || c.includes("poultry") || c.includes("seafood") || c.includes("fish")) { cogs.meat    += amt; cogs.food += amt; }
  else if (c.includes("produce") || c.includes("vegetable") || c.includes("fruit"))                                                                    { cogs.produce += amt; cogs.food += amt; }
  else if (c.includes("dairy") || c.includes("egg") || c.includes("cheese"))                                                                           { cogs.dairy   += amt; cogs.food += amt; }
  else if (c.includes("grocery") || c.includes("dry") || c.includes("pantry") || c.includes("baked") || c.includes("bread") || c.includes("bakery"))  { cogs.grocery += amt; cogs.food += amt; }
  else if (c.includes("liquor") || c.includes("spirit") || c.includes("spirits") || c.includes("cocktail"))                                            { cogs.liquor  += amt; }
  else if (c.includes("beer") || c.includes("draft") || c.includes("brew"))                                                                            { cogs.beer    += amt; }
  else if (c.includes("wine"))                                                                                                                          { cogs.wine    += amt; }
  else if (c.includes("non-alc") || c.includes("na bev") || c.includes("beverage") || c.includes("soda") || c.includes("juice") || c.includes("water")){ cogs.na_bev  += amt; }
  else if (c.includes("paper") || c.includes("packaging") || c.includes("to-go") || c.includes("disposable"))                                         { cogs.paper   += amt; }
  else if (c.includes("supply") || c.includes("supplies") || c.includes("cleaning") || c.includes("chemical") || c.includes("janitorial"))             { cogs.supplies += amt; }
  else                                                                                                                                                   { cogs.other   += amt; }
}

async function fetchMarginEdge(date) {
  const headers = { "X-Api-Key": MARGINEDGE_API_KEY, "Accept": "application/json" };
  const base    = "https://api.marginedge.com/public";
  const rid     = MARGINEDGE_TENANT_ID;

  const ordersRes = await fetch(
    `${base}/orders?restaurantUnitId=${rid}&startDate=${date}&endDate=${date}&orderStatus=CLOSED`,
    { headers }
  );
  if (!ordersRes.ok) throw new Error(`MarginEdge orders failed: ${ordersRes.status}`);

  const ordersJson = await ordersRes.json();
  const orders     = ordersJson.orders || ordersJson.data || (Array.isArray(ordersJson) ? ordersJson : []);

  const cogs = { food: 0, meat: 0, produce: 0, dairy: 0, grocery: 0,
                 liquor: 0, beer: 0, wine: 0, na_bev: 0,
                 paper: 0, supplies: 0, other: 0, total: 0 };

  const invoice_count = orders.length;

  // Fetch order detail for each order to get line items + categories (cap at 20)
  const detailFetches = orders.slice(0, 20).map(o =>
    fetch(`${base}/orders/${o.orderId}?restaurantUnitId=${rid}`, { headers })
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  );
  const details = await Promise.all(detailFetches);

  for (let i = 0; i < details.length; i++) {
    const detail = details[i];
    const order  = orders[i];

    if (!detail) {
      const amt = parseFloat(order.orderTotal || 0);
      if (amt) { cogs.total += amt; cogs.other += amt; }
      continue;
    }

    const lines = detail.lineItems || detail.line_items || detail.items || detail.orderItems || [];

    if (lines.length === 0) {
      const amt = parseFloat(detail.orderTotal || order.orderTotal || 0);
      if (amt) { cogs.total += amt; bucketCogs(cogs, detail.vendorName || order.vendorName || "", amt); }
      continue;
    }

    for (const line of lines) {
      const cat = line.category || line.categoryName || line.category_name || line.categoryType || "";
      const amt = parseFloat(line.extendedCost || line.extended_cost || line.amount || line.total || line.cost || line.lineTotal || 0);
      if (!amt) continue;
      cogs.total += amt;
      bucketCogs(cogs, cat, amt);
    }
  }

  for (const key of Object.keys(cogs)) cogs[key] = +cogs[key].toFixed(2);

  return {
    invoice_count,
    pending_invoices: 0,
    cogs,
    food_cost_pct:  null,
    total_cogs_pct: null,
    data_as_of:     nowET(),
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

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

app.get("/api/ric", async (req, res) => {
  const date   = req.query.date || today();
  const result = { date, sources: {} };

  try {
    const token  = await getGoTabToken();
    const gqlRes = await fetch("https://gotab.io/api/v2/graph", {
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

  res.json({ ok: true, ...result });
});

app.post("/api/claude", async (req, res) => {
  try {
    const body = { ...req.body, stream: false };
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
    res.json(data);
  } catch(err) {
    console.error("Claude proxy error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "hch-ric-proxy", version: "3.0" }));

app.get("/", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.sendFile(join(__dirname, "index.html"));
});

app.listen(PORT, () => console.log(`RIC proxy v3.0 running on port ${PORT}`));
