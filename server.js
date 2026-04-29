// Hill Country Hospitality — RIC Proxy Server v2.2
// Sources: GoTab (live), 7Shifts (live), all others mocked
// Deploy on Railway. Set env vars below.

import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// ── Env vars (set in Railway → Variables) ────────────────────────────────────
const GOTAB_ID            = process.env.GOTAB_ID;
const GOTAB_SECRET        = process.env.GOTAB_SECRET;
const GOTAB_LOCATION_UUID = process.env.GOTAB_LOCATION_UUID;

const SHIFTS_TOKEN        = process.env.SHIFTS_TOKEN;
const SHIFTS_COMPANY_GUID = process.env.SHIFTS_COMPANY_GUID;
const SHIFTS_COMPANY_ID   = process.env.SHIFTS_COMPANY_ID;
const SHIFTS_LOCATION_ID  = process.env.SHIFTS_LOCATION_ID;

app.use(cors({
  origin: "*",
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.options("*", cors());
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().split("T")[0];

// ── GoTab: auth ──────────────────────────────────────────────────────────────
async function getGoTabToken() {
  const res = await fetch("https://gotab.io/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_access_id:     GOTAB_ID,
      api_access_secret: GOTAB_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`GoTab auth failed: ${res.status}`);
  const d = await res.json();
  return d.token;
}

// ── GoTab: GraphQL query ─────────────────────────────────────────────────────
function goTabQuery(locationUuid, fiscalDay) {
  return {
    query: `
      query($locationUuid: String, $tabCreationDate: Datetime) {
        locations: locationsList(condition: { locationUuid: $locationUuid }) {
          name
          locationUuid
          tabs: tabsList(
            filter: {
              created: { greaterThan: $tabCreationDate }
              ordersPlaced: { greaterThan: 0 }
            }
          ) {
            name tabMode tax total subtotal tippedSubtotal
            balanceDue autogratDue href
            items: itemsList(filter: { ordered: { equalTo: true } }) {
              name subtotal subtotalInitial quantity quantityInitial
              comped voided fee discount
              adjustments: adjustments {
                adjustmentReason adjustmentType quantity unitPrice
                deltaTax deltaAutograt deltaAutogratTax
              }
            }
          }
        }
      }`,
    variables: { locationUuid, tabCreationDate: fiscalDay + "T00:00:00Z" },
  };
}

// ── GoTab: normalize ─────────────────────────────────────────────────────────
function normalizeGoTab(tabs) {
  let net_sales = 0, tax_total = 0, bar_sales = 0;
  let voids = 0, comps = 0, tip_total = 0, tab_count = 0;

  for (const tab of tabs) {
    net_sales += tab.subtotal || 0;
    tax_total += tab.tax     || 0;
    tip_total += tab.tippedSubtotal || 0;
    tab_count += 1;
    for (con
