// Hill Country Hospitality — RIC Proxy Server v2.7
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

const GOTAB_ID            = process.env.GOTAB_ID;
const GOTAB_SECRET        = process.env.GOTAB_SECRET;
const GOTAB_LOCATION_UUID = process.env.GOTAB_LOCATION_UUID;
const SHIFTS_TOKEN        = process.env.SHIFTS_TOKEN;
const SHIFTS_COMPANY_GUID = process.env.SHIFTS_COMPANY_GUID;
const SHIFTS_COMPANY_ID   = process.env.SHIFTS_COMPANY_ID;
const SHIFTS_LOCATION_ID  = process.env.SHIFTS_LOCATION_ID;

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

      if (n.startsWith("Discounts and Comps")) {
        comps += Math.abs(amt);
        continue;
      }

      if (item.voided || g === "VOID") {
        voids += Math.abs(amt);
        continue;
      }

      net_sales += amt;

      if (BAR_STREAMS.some(b => n.startsWith(b))) {
        bar_sales += amt;
      } else if (CATERING_STREAMS.some(b => n.startsWith(b))) {
        catering_sales += amt;
      }
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
    "Authorization":  `Bearer ${SHIFTS_TOKEN}`,
    "x-company-guid": SHIFTS_COMPANY_GUID,
    "Content-Type":   "application/json",
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

// ── Routes ────────────────────────────────────────────────────────────────────

// Diagnostic: all accounting streams sorted by revenue
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

// Combined
app.get("/api/ric", async (req, res) => {
  const date = req.query.date || today();
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
    console.error("GoTab failed in /api/ric:", e.message);
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
    console.error("7Shifts failed in /api/ric:", e.message);
    result["7shifts"] = null;
    result.sources["7shifts"] = `error: ${e.message}`;
  }
  res.json({ ok: true, ...result });
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
app.get("/health", (_req, res) => res.json({ ok: true, service: "hch-ric-proxy", version: "2.7" }));

// Serve RIC app
app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));

app.listen(PORT, () => console.log(`RIC proxy v2.7 running on port ${PORT}`));
