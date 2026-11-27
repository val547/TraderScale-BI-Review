import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/dashboard/index.html", import.meta.url), "utf8");
const source = html.match(/<script data-source="owner-affiliates\.js">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source);
const window = { BIProductionConnector: { state: { mode: "production", dateStart: "2026-11-01", dateEnd: "2026-11-26" } } };
new Function("window", source)(window);
const report = window.BIOwnerAffiliates;
const partners = ["grows","falls","payout-only"].map(id => ({ id, name:id, trafficType:"fast-track" }));
const order = (id, date, netSales) => ({ id:id+date, affiliateId:id, date, netSales, country:"US" });
const cost = (id, date, componentType, amount, extra) => ({
  affiliateId:id, date, componentType, amount, amountKnown:true, allocationBucket:"attributed", country:"US", ...extra,
});
const ctx = {
  data: {
    demo:false, asOf:"2026-11-26", affiliates:partners, productionQuality:{affiliatePnlReady:true},
    orders:[order("grows","2026-09-02",10),order("grows","2026-10-01",500),
      order("falls","2026-10-26",250),order("grows","2026-11-26",800),order("falls","2026-11-10",150)],
    affiliatePnl:[
      cost("grows","2026-11-26","commission",31.25),
      cost("grows","2026-11-25","payout",120),
      cost("grows","2026-11-25","payout",1000,{ country:"GB" }),
      cost("grows","2026-10-25","payout",900),
      cost("grows","2026-11-25","commission",999,{ allocationBucket:"unattributed" }),
      cost("falls","2026-11-10","commission",null,{ amountKnown:false }),
      cost("payout-only","2026-11-02","payout",45),
    ],
  },
  filters:{country:"US"}, local:{},
  ui:{escape:String, money:v=>"$"+v, number:String, icon:()=>""},
};
assert.match(report.render(ctx), /data-value="performers">Top 10 performers<\/button>/);
assert.match(report.render(ctx), /data-value="decliners">Top 10 decliners<\/button>/);
for (const value of ["performers","decliners"]) {
  Object.assign(ctx.local,{ownerAffType:"fast-track",ownerAffPnlView:value,ownerAffPnlType:"traditional",ownerAffPnlPage:5});
  assert.deepEqual(report.onAction("owner-aff-pnl-open",{dataset:{value}},ctx), {navigate:"affiliate-pnl"});
  assert.deepEqual(ctx.local,{ownerAffType:"fast-track",ownerAffPnlView:"all",ownerAffPnlType:"all",ownerAffPnlPage:0});
  assert.equal(report.exportPnl(ctx).length,3);
}
report.onAction("owner-aff-pnl-view",{dataset:{value:"performers"}},ctx);
assert.match(report.renderPnl(ctx), /Commission earned/);
assert.match(report.renderPnl(ctx), /Trader payouts/);
const grows = report.exportPnl(ctx)[0];
assert.deepEqual([grows.affiliate,grows.orders,grows.net_sales_usd,grows.commission_earned_usd,grows.trader_payouts_usd,grows.pnl_usd],
  ["grows",1,800,31.25,120,648.75]);
report.onAction("owner-aff-pnl-view",{dataset:{value:"decliners"}},ctx);
assert.match(report.renderPnl(ctx), /vs 1–26 Oct 2026/);
const [falls] = report.exportPnl(ctx);
assert.equal(falls.affiliate,"falls");
assert.equal(falls.change_usd,-100);
assert.equal(falls.commission_earned_usd,null);
assert.equal(falls.pnl_usd,null);
report.onAction("owner-aff-pnl-view",{dataset:{value:"all"}},ctx);
const payoutOnly = report.exportPnl(ctx).find(row=>row.affiliate==="payout-only");
assert.deepEqual([payoutOnly.orders,payoutOnly.trader_payouts_usd,payoutOnly.pnl_usd],[0,45,-45]);
ctx.data.productionQuality.affiliatePnlReady = false;
assert.equal(report.exportPnl(ctx)[0].trader_payouts_usd,null);
ctx.data.demo = true;
assert.deepEqual(report.exportPnl(ctx),[]);
console.log("Affiliate P&L ranks, live commission, payouts, scope and CSV passed.");
