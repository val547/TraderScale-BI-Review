import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/dashboard/index.html", import.meta.url), "utf8");
const match = html.match(/<script data-source="affiliate-growth\.js">([\s\S]*?)<\/script>/);
assert.ok(match, "affiliate-growth.js inline module must exist");

const testWindow = {
  BIProductionConnector: {
    state: { mode: "production" },
    dateRange: () => ["2026-10-01", "2026-10-31"],
  },
  BIRiskRadarData: null,
};
new Function("window", match[1])(testWindow);

const affiliates = Array.from({ length: 79 }, (_, index) => ({
  id: `affiliate-${index + 1}`,
  name: `Affiliate ${index + 1}`,
  trafficType: "fast-track",
}));
const orders = affiliates.flatMap((affiliate, index) => [
  { id: `current-${index}`, date: "2026-10-10", status: "completed", grossSales: 100, discount: 0, netSales: 100,
    affiliateId: affiliate.id, affiliateTrafficType: "fast-track", customerId: `customer-${index}`, country: "US", programme: "Speedy", accountSize: 100000, channel: "Affiliate" },
  { id: `prior-${index}`, date: "2026-09-10", status: "completed", grossSales: 90, discount: 0, netSales: 90,
    affiliateId: affiliate.id, affiliateTrafficType: "fast-track", customerId: `customer-${index}`, country: "US", programme: "Speedy", accountSize: 100000, channel: "Affiliate" },
]);
const affiliatePnl = affiliates.flatMap((affiliate, index) => [
  ["2026-10-10", "revenue", 100, "current"], ["2026-10-10", "commission", 10, "current"], ["2026-10-20", "payout", 5, "current"],
  ["2026-09-10", "revenue", 90, "prior"], ["2026-09-10", "commission", 9, "prior"], ["2026-09-20", "payout", 4, "prior"],
].map(([date, componentType, amount, period]) => ({
  date, componentType, amount, amountKnown: true, allocationBucket: "attributed", affiliateId: affiliate.id,
  storeId: "store", orderId: `${period}-${index}`, customerId: `customer-${index}`, customerType: "new",
  country: "US", programme: "Speedy", accountSize: 100000,
})));

const context = {
  data: { affiliates, orders, affiliatePnl, accounts: [], asOf: "2026-10-31", productionQuality: { affiliatePnlReady: true } },
  filters: { programme: "all", size: "all", country: "all", channel: "all" },
  local: { affgrowthSignal: "all", affgrowthDimension: "partner", affgrowthMetric: "profit", affgrowthSort: "profit" },
};

const all = testWindow.BIAffiliateGrowth.getReport(context);
assert.equal(all.partners.length, 79, "all 79 partners must be built");
assert.equal(all.rows.length, 79, "All signals must retain all partners");
assert.equal(all.pageRows.length, 10, "the detailed table must be paginated");
assert.equal(all.chartRows.length, 10, "the P&L comparison must paginate partners by ten");
assert.equal(all.chartPageCount, 8, "79 partners must be available across eight P&L comparison pages");
assert.ok(all.partners.every((row) => row.current.commissions === 10), "every partner must have recognized commission");
assert.equal(all.totals.commissions, 790, "portfolio commission must reconcile across all partners");

context.local.affgrowthSignal = "scale";
const scaleOnly = testWindow.BIAffiliateGrowth.getReport(context);
assert.equal(scaleOnly.rows.length, 0, "the signal dropdown may filter the detailed table");
assert.equal(scaleOnly.chartRows.length, 10, "the signal dropdown must not filter the P&L comparison");

console.log("affiliate growth regression: 79 partners, commission reconciliation and independent chart filter passed");
