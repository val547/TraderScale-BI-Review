import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const window = { BIWarehouseReports: { missing: () => '<p>Warehouse source unavailable</p>' } };
const names = ['customer-growth-data', 'product-migration', 'growth-concentration', 'free-coupon-campaign', 'challenge-outcomes', 'affiliate-value'];
for (const name of names) {
  const marker = '<script data-source="' + name + '.js">';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, name);
  const body = html.slice(start + marker.length, html.indexOf('</script>', start));
  assert.doesNotMatch(body, /demoCheckouts|sampleChance|const RETAINERS|fictional_demo:true/i, name);
  new Function('window', body)(window);
}
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
for (const [, attrs, body] of scripts) {
  if (body.trim() && !attrs.includes('application/json')) new vm.Script(body, { filename: attrs || 'inline' });
}

function checkout(id, customerId, purchasedAt, options = {}) {
  return { id, customerId, purchasedAt, date: purchasedAt.slice(0, 10), programme: 'Speedy', programmeFamily: 'Speedy',
    accountSize: 50000, country: 'US', checkoutTotal: 100, checkoutSubtotal: 100, checkoutDiscount: 0,
    refunded: 0, status: 'completed', netRevenue: 100, netRevenueEligible: true, propPurchase: true, couponCodes: [], ...options };
}
const orders = [
  checkout('z-first', 'buyer', '2026-07-01T01:00:00Z', { attemptEvidence: {
    attempt_id: 'attempt-1', plan_steps: '1-Step', start_login: '125', funded_on: '2026-07-08', breached_at: '2026-07-22',
  } }),
  checkout('a-second', 'buyer', '2026-07-01T22:00:00Z', { programme: 'Two Step', programmeFamily: 'Two Step', accountSize: 100000 }),
  checkout('free', 'lead', '2026-07-05T10:00:00Z', { checkoutTotal: 0, checkoutDiscount: 100, netRevenue: 0, couponCodes: ['NW5K'] }),
  checkout('paid', 'lead', '2026-07-06T10:00:00Z', { netRevenue: 75 }),
  checkout('multi', 'ambiguous', '2026-07-07T10:00:00Z', { checkoutTotal: 0, checkoutDiscount: 100, netRevenue: 0, couponCodes: ['TS5K','NW5K'] }),
  checkout('addon', 'buyer', '2026-07-08T10:00:00Z', { propPurchase: false, netRevenue: 20 }),
];
const data = {
  demo: false, asOf: '2026-11-26',
  productionQuality: { revenueReady: true, checkoutCouponsReady: true, affiliatesReady: true, challengeAttemptsReady: true },
  productionCheckoutOrders: orders,
  orders: [{ id: 'z-first', affiliateId: 'partner-1', commission: 5, payoutCost: 2, liveCostCoverage: true }],
  accounts: [{ id: 'account-1', login: '125' }],
  payouts: [{ status: 'Paid', orderId: 'z-first', amount: 50, paidAt: '2026-07-15' }],
  affiliates: [{ id: 'partner-1', name: 'Partner' }],
  customers: [{ id: 'buyer', name: 'Buyer' }, { id: 'lead', name: 'Lead' }],
};
const ui = { escape: value => String(value ?? ''), number: String, money: value => '$' + value,
  percent: String, icon: () => '', badge: label => label, metric: ({label,value}) => '<div>' + label + ': ' + value + '</div>' };
const ctx = local => ({ data, local, ui });

const migration = window.BIProductMigration.getReport(ctx({}));
assert.equal(migration.returned.find(row => row.id === 'buyer').next.id, 'a-second');
assert.equal(migration.returned.find(row => row.id === 'buyer').days, 21 / 24);
assert.equal(migration.changed, 1);

const concentration = window.BIGrowthConcentration.getReport(ctx({ growthConcentrationPeriod: 'all' }));
assert.equal(concentration.total.sales, 27500);
assert.equal(concentration.top.id, 'partner-1');
assert.equal(concentration.total.contribution, null, 'Incomplete direct costs must not silently become zero.');

const campaign = window.BIFreeCouponCampaign.getReport(ctx({}));
assert.equal(campaign.rows.length, 1, 'Ambiguous first coupons must not enter either campaign.');
assert.equal(campaign.rows[0].lag, 86400000);
assert.equal(campaign.rows[0].ltv, 7500);

const challenges = window.BIChallengeOutcomes.getReport(ctx({}));
assert.equal(challenges.counts.started, 1);
assert.equal(challenges.counts.funded, 1);
assert.equal(challenges.counts.payout, 1);
assert.equal(challenges.counts.breached, 1);

const affiliate = window.BIAffiliateValue.getReport(ctx({}));
assert.equal(affiliate.selected.averageLtv, 20000);
assert.equal(affiliate.selected.payback, null);
assert.equal(affiliate.selected.complete, false);

for (const [module, pattern] of [
  [window.BIProductMigration, /class="gr-page pm-page"/],
  [window.BIGrowthConcentration, /class="gr-page gc-page"/],
  [window.BIFreeCouponCampaign, /class="nw-page"/],
  [window.BIChallengeOutcomes, /co-funnel/],
  [window.BIAffiliateValue, /class="av-page"/],
]) {
  assert.match(module.render(ctx({})), pattern);
  assert.doesNotMatch(JSON.stringify(module.exportRows(ctx({}))), /fictional_demo/);
  assert.match(module.render({ data: { demo: false }, local: {}, ui }), /Warehouse source unavailable/);
}

if (process.env.TRADERSCALE_HANDOFF_HTML) {
  const baseline = readFileSync(process.env.TRADERSCALE_HANDOFF_HTML, 'utf8');
  const block = (text, tag, filename) => {
    const marker = '<' + tag + ' data-source="' + filename + '">';
    const start = text.indexOf(marker);
    assert.notEqual(start, -1, filename);
    return text.slice(start, text.indexOf('</' + tag + '>', start)).replace(/\r\n/g, '\n');
  };
  for (const name of ['challenge-outcomes', 'free-coupon-campaign', 'affiliate-value', 'customer-growth-reports']) {
    assert.equal(block(html, 'style', name + '.css'), block(baseline, 'style', name + '.css'), name + ' supplied CSS');
  }
  for (const name of [...names.slice(1), 'rebuy', 'payout-history', 'affiliate-growth', 'account-analytics', 'economics']) {
    const reference = block(baseline, 'script', name + '.js');
    const current = block(html, 'script', name + '.js');
    for (const pattern of [/<h[123][^>]*>([^<+'"]+)/g, /data-action="([a-z][a-z0-9-]+)"/g, /data-[a-z-]+-control="([a-z][a-z0-9-]+)"/g]) {
      const values = source => new Set([...source.matchAll(pattern)].map(([, value]) => value.trim()));
      const actual = values(current);
      for (const expected of values(reference)) {
        if (expected && expected !== 'Fictional data' && expected !== 'Fictional history') {
          assert.ok(actual.has(expected), name + ' preserves ' + expected);
        }
      }
    }
  }
  const ids = source => [...block(source, 'script', 'reports.js').matchAll(/\{ id: '([^']+)', title: '[^']+'.*?page: '[^']+'/g)].map(([, id]) => id);
  assert.deepEqual(ids(html), ids(baseline), 'The report catalogue preserves the supplied order.');
}

console.log('Handoff report rendering, canonical cohorts, exports and data-coverage checks passed.');
