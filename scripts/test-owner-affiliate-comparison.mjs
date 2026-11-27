import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/dashboard/index.html", import.meta.url), "utf8");
const match = html.match(/<script data-source="owner-affiliates\.js">([\s\S]*?)<\/script>/);
assert.ok(match, "Owner affiliate performance module must exist");

const state = { mode: "production", dateStart: "2026-11-01", dateEnd: "2026-11-26", dateAllTime: false };
const window = { BIProductionConnector: { state } };
new Function("window", match[1])(window);

const affiliate = { id: "partner", name: "Test Partner", trafficType: "fast-track" };
const order = (date, netSales, country = "US") => ({
  id: date + country, date, netSales, country, commission: netSales / 10,
  affiliateId: affiliate.id, customerId: "customer", programme: "Speedy", accountSize: 50000,
});
const ctx = {
  data: {
    asOf: "2026-11-26",
    affiliates: [affiliate],
    orders: [
      order("2026-09-01", 1), order("2026-10-01", 40), order("2026-10-26", 60),
      order("2026-10-26", 1000, "GB"), order("2026-10-31", 900), order("2026-11-26", 150),
    ],
  },
  filters: { country: "US" }, local: {},
  ui: { escape: String, money: (value) => "$" + value, icon: () => "", number: String },
};
const report = window.BIOwnerAffiliates;
const november = report.getReport(ctx);
assert.deepEqual(november.windows.current, ["2026-11-01", "2026-11-26"]);
assert.deepEqual(november.windows.prior, ["2026-10-01", "2026-10-26"]);
assert.equal(november.performers[0].currentValue, 150);
assert.equal(november.performers[0].previousValue, 100);
assert.equal(november.performers[0].delta, 50);
assert.equal(november.decliners.length, 0);
assert.match(report.render(ctx), /1–26 Nov 2026 vs 1–26 Oct 2026/);
const detail = report.onAction("owner-aff-detail", { dataset: { id: affiliate.id } }, ctx).detail;
assert.match(detail.html, /1–26 Oct 2026/);
const [csv] = report.exportRows(ctx);
assert.deepEqual([csv.prior_start, csv.prior_end, csv.previous], ["2026-10-01", "2026-10-26", 100]);

ctx.local.ownerAffMetric = "profit";
assert.equal(report.getReport(ctx).performers[0].previousValue, 90);

Object.assign(state, { dateStart: "2026-10-08", dateEnd: "2026-10-15" });
assert.deepEqual(report.getReport(ctx).windows.prior, ["2026-09-08", "2026-09-15"]);

Object.assign(state, { dateStart: "2026-10-01", dateEnd: "2026-10-31" });
assert.deepEqual(report.getReport(ctx).windows.prior, ["2026-09-01", "2026-09-30"]);

Object.assign(state, { dateStart: "2026-10-31", dateEnd: "2026-10-31" });
assert.equal(report.getReport(ctx).windows.comparable, false, "October 31 has no matching September date");
assert.equal(report.getReport(ctx).totals.previous, null);
assert.doesNotMatch(report.render(ctx), /all available history/i);

Object.assign(state, { dateAllTime: true });
assert.equal(report.getReport(ctx).windows.comparable, false);
assert.match(report.render(ctx), /all available history/i);

console.log("Owner affiliate performance uses the same calendar dates last month for rankings, details and export.");
