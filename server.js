// GoTab Proxy Server for Hill Country Hospitality — RIC v1
// Deploy on Railway. Set env vars: GOTAB_ID, GOTAB_SECRET, GOTAB_LOCATION_UUID

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

const GOTAB_ID           = process.env.GOTAB_ID;
const GOTAB_SECRET       = process.env.GOTAB_SECRET;
const GOTAB_LOCATION_UUID = process.env.GOTAB_LOCATION_UUID;
const GOTAB_AUTH_URL     = "https://gotab.io/api/oauth/token";
const GOTAB_GRAPH_URL    = "https://gotab.io/api/v2/graph";

app.use(cors());
app.use(express.json());

// ── Auth: exchange client credentials for Bearer token ──────────────────────
async function getBearerToken() {
  const res = await fetch(GOTAB_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_access_id:     GOTAB_ID,
      api_access_secret: GOTAB_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`GoTab auth failed: ${res.status}`);
  const data = await res.json();
  return data.token;
}

// ── GraphQL query: today's tabs for the location ─────────────────────────────
function buildQuery(locationUuid, fiscalDay) {
  return {
    query: `
      query($locationUuid: String, $fiscalDay: Date) {
        locations: locationsList(condition: { locationUuid: $locationUuid }) {
          tabs: tabsList(
            filter: {
              created: { greaterThan: $fiscalDay }
              ordersPlaced: { greaterThan: 0 }
            }
          ) {
            tabId
            tabMode
            tax
            total
            subtotal
            tippedSubtotal
            balanceDue
            autogratDue
            numGuests
            opened
            closed
            status
            items: itemsList(filter: { ordered: { equalTo: true } }) {
              name
              subtotal
              subtotalInitial
              quantity
              quantityInitial
              comped
              adjustments {
                adjustmentType
                adjustmentReason
                unitPrice
                quantity
              }
              accountingStream {
                name
                reportingGroup
              }
            }
            payments: paymentsList {
              amount
              tipAmount
              comp
              subtotal
            }
          }
        }
      }
    `,
    variables: {
      locationUuid,
      fiscalDay: fiscalDay + "T00:00:00Z",
    },
  };
}

// ── Normalize raw GoTab tabs into RIC-shaped object ───────────────────────────
function normalize(tabs) {
  let net_sales     = 0;
  let tax_total     = 0;
  let covers        = 0;
  let bar_sales     = 0;
  let voids         = 0;
  let comps         = 0;
  let tip_total     = 0;
  let tab_count     = 0;

  for (const tab of tabs) {
    // Only count closed/paid tabs in revenue
    if (tab.status === "CLOSED" || tab.balanceDue === 0) {
      net_sales  += tab.subtotal    || 0;
      tax_total  += tab.tax         || 0;
      tip_total  += tab.tippedSubtotal || 0;
      covers     += tab.numGuests   || 1;
      tab_count  += 1;

      for (const item of tab.items || []) {
        // Bar sales — items in Bar accounting stream
        const stream = item.accountingStream?.reportingGroup?.toLowerCase() || "";
        if (stream.includes("bar") || stream.includes("beverage") || stream.includes("drink")) {
          bar_sales += item.subtotal || 0;
        }

        // Comps
        if (item.comped) {
          comps += item.subtotalInitial || 0;
        }

        // Voids — quantity reduced via adjustment
        for (const adj of item.adjustments || []) {
          if (adj.adjustmentType === "VOID" || adj.adjustmentReason === "VOID") {
            voids += Math.abs((adj.unitPrice || 0) * (adj.quantity || 1));
          }
        }
      }
    }
  }

  // Convert cents → dollars if GoTab returns cents (check: total > 1000x plausible)
  const scale = net_sales > 500000 ? 100 : 1;

  net_sales  = +(net_sales  / scale).toFixed(2);
  bar_sales  = +(bar_sales  / scale).toFixed(2);
  voids      = +(voids      / scale).toFixed(2);
  comps      = +(comps      / scale).toFixed(2);
  tax_total  = +(tax_total  / scale).toFixed(2);
  tip_total  = +(tip_total  / scale).toFixed(2);

  const avg_check = covers > 0 ? +(net_sales / covers).toFixed(2) : 0;

  return {
    net_sales,
    covers,
    avg_check,
    tab_count,
    bar_sales,
    voids,
    comps,
    tax_total,
    tip_total,
    open_tabs: tabs.filter(t => t.status !== "CLOSED" && t.balanceDue > 0).length,
    data_as_of: new Date().toISOString(),
  };
}

// ── Route: GET /api/gotab ─────────────────────────────────────────────────────
app.get("/api/gotab", async (req, res) => {
  try {
    // Default to today; allow ?date=YYYY-MM-DD override
    const date = req.query.date || new Date().toISOString().split("T")[0];

    const token = await getBearerToken();

    const gqlRes = await fetch(GOTAB_GRAPH_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(buildQuery(GOTAB_LOCATION_UUID, date)),
    });

    if (!gqlRes.ok) throw new Error(`GoTab GraphQL error: ${gqlRes.status}`);

    const gqlData = await gqlRes.json();

    if (gqlData.errors) {
      console.error("GoTab GraphQL errors:", gqlData.errors);
      throw new Error(gqlData.errors[0]?.message || "GraphQL error");
    }

    const tabs = gqlData?.data?.locations?.[0]?.tabs || [];
    const normalized = normalize(tabs);

    res.json({ ok: true, source: "gotab_live", date, ...normalized });

  } catch (err) {
    console.error("GoTab proxy error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, service: "hch-ric-proxy" }));

app.listen(PORT, () => console.log(`RIC proxy running on port ${PORT}`));
