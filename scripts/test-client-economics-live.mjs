import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const snapshot = readFileSync(new URL('../lib/bi-snapshot.ts', import.meta.url), 'utf8');
const connector = readFileSync(new URL('../public/dashboard/production-connector.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');

assert.match(snapshot, /COALESCE\(cc\.commerce_customer_key, p\.customer_id\) AS commerce_customer_key/, 'Payouts must resolve to the canonical commerce customer key.');
assert.match(snapshot, /customerId: text\(row\.commerce_customer_key, text\(row\.customer_id\)\)/, 'Payout rows must expose that canonical key.');
assert.match(dashboard, /String\(row\.status\)\.toLowerCase\(\)==='approved'/, 'Client lifetime profit must use approved payouts.');
assert.match(connector, /row\.componentType === 'payout'/, 'Order economics must include released trader-payout components.');
assert.match(connector, /Number\(row\.netRevenue\).*pnl\.commission - pnl\.payout/, 'Contribution must deduct commissions and trader payouts once.');
assert.match(snapshot, /withdrawableReady: !withdrawableResult\.error,/, 'A missing run manifest must not hide valid account-level withdrawable results.');
assert.match(snapshot, /consistency_percentage/, 'Account analytics consistency must be available as a live fallback.');
assert.match(dashboard, /'profitable-risk':!!quality\.withdrawableReady\|\|!!quality\.riskFindingsReady&&!!quality\.tradesReady/, 'Profitable-risk coverage must accept live trade and detector evidence.');
assert.match(dashboard, /'payout-patterns':!!quality\.withdrawableReady\|\|Array\.isArray\(ctx\.data\.payouts\)/, 'Payout exposure must accept live approved-payout records.');

function loadModule(name, testWindow) {
  const marker = '<script data-source="' + name + '.js">';
  const start = dashboard.indexOf(marker);
  assert.notEqual(start, -1);
  new Function('window', dashboard.slice(start + marker.length, dashboard.indexOf('</script>', start)))(testWindow);
}

const testWindow = { BIProductionConnector: { inDateRange: () => true } };
loadModule('economics', testWindow);
loadModule('account-analytics', testWindow);

const ui = { money: value => '$' + value, number: String, escape: String };
const filters = { programme: 'all', size: 'all', country: 'all', channel: 'all' };
const accounts = [
  { id: 'A', programme: 'Speedy', accountSize: 50000 },
  { id: 'B', programme: 'Speedy', accountSize: 100000 },
  { id: 'C', programme: 'Two Step', accountSize: 50000 },
].map(account => ({ ...account, stage: 'Funded', status: 'Active' }));

const ledger = accounts.flatMap((account, index) => [
  ['revenue', 200 + index * 100], ['commission', 25], ['payout', 40],
].map(([componentType, amount]) => ({ ...account, storeId: 'store', orderId: account.id, date: '2026-11-18', componentType, amount })));
const economics = testWindow.BIEconomics;
const context = {
  ui, filters, local: {},
  data: { accounts, programmes: ['Speedy', 'Two Step'], productionQuality: { affiliatePnlReady: true }, affiliatePnl: ledger },
};
const originalTotals = economics.getProfitability(context).totals;
assert.equal(economics.getProfitability(context).rows.find(row => row.id === 'Speedy').sizes.length, 0);
economics.onAction('econ-toggle-programme', { dataset: { value: 'Speedy' } }, context);
const expandedEconomics = economics.getProfitability(context);
const speedy = expandedEconomics.rows.find(row => row.id === 'Speedy');
assert.deepEqual(speedy.sizes.map(row => [row.id, row.netSales, row.profit]), [['100000', 300, 235], ['50000', 200, 135]]);
assert.deepEqual(expandedEconomics.totals, originalTotals);
assert.equal(speedy.sizes.reduce((profit, row) => profit + row.profit, 0), speedy.profit);
economics.onAction('econ-sort', { dataset: { value: 'profit' } }, context);
assert.deepEqual(economics.getProfitability(context).rows.find(row => row.id === 'Speedy').sizes.map(row => row.id), ['50000', '100000']);
assert.equal(economics.onAction('econ-detail', { dataset: { kind: 'programme', id: 'Speedy' } }, { ...context, filters: { ...filters } }).rerender, true);

const analytics = testWindow.BIAccountAnalytics;
const accountContext = { ...context, local: {}, filters: { ...filters } };
const accountReport = analytics.getReport(accountContext);
assert.equal(accountReport.counts.live, 3);
assert.deepEqual(accountReport.breakdown.find(group => group.key === 'Speedy').sizes.map(group => [group.key, group.counts.live]), [[50000, 1], [100000, 1]]);
analytics.onAction('account-analytics-programme-toggle', { dataset: { value: 'Speedy' } }, accountContext);
assert.deepEqual(analytics.getReport(accountContext).state.expandedProgrammes, ['Speedy']);
analytics.onAction('account-analytics-scope', { dataset: { dimension: 'size', value: '50000', programme: 'Speedy' } }, accountContext);
const scopedAccounts = analytics.getReport(accountContext);
assert.deepEqual(scopedAccounts.rows.map(row => row.id), ['A']);
assert.equal(scopedAccounts.counts.live, 3, 'The account list scope must not change overview totals.');
assert.deepEqual(accountContext.filters, filters, 'The nested group opens a scoped list without replacing the main filters.');
analytics.onAction('account-analytics-clear', { dataset: {} }, accountContext);
assert.equal(analytics.getReport(accountContext).rows.length, 3);


const hierarchyContext={
  ...accountContext,local:{},
  data:{...accountContext.data,accounts:[
    {...accounts[0],programme:'Speedy · 50K · MT4',programmeFamily:'Speedy',platform:'MT4'},
    {...accounts[0],id:'A5',programme:'Speedy · 50K · MT5',programmeFamily:'Speedy',platform:'MT5'},
    {...accounts[1],programme:'Speedy · 100K · MT5'},
    {...accounts[2],programme:'Pro · 50K · MT5',programmeFamily:'Pro',platform:'MT5'},
    {...accounts[0],id:'A-unknown',programmeFamily:'Speedy',accountSize:null}
  ]}
};
const hierarchy=analytics.getReport(hierarchyContext);
assert.deepEqual(hierarchy.breakdown.map(group=>[group.key,group.counts.live]),[['Speedy',4],['Pro',1]]);
const sizes=hierarchy.breakdown[0].sizes;
assert.deepEqual(sizes.map(group=>group.key),[50000,100000,null]);
assert.deepEqual(sizes[0].platforms.map(group=>[group.key,group.counts.live]),[['MT4',1],['MT5',1]]);
assert.equal(sizes[1].platforms[0].key,'MT5');
assert.equal(sizes[2].platforms[0].key,'Platform not recorded');
analytics.onAction('account-analytics-scope',{dataset:{dimension:'programme',value:'Speedy'}},hierarchyContext);
assert.equal(analytics.getReport(hierarchyContext).rows.length,4);
analytics.onAction('account-analytics-scope',{dataset:{dimension:'platform',programme:'Speedy',size:'50000',value:'MT5'}},hierarchyContext);
assert.deepEqual(analytics.getReport(hierarchyContext).rows.map(row=>row.id),['A5']);
assert.deepEqual(analytics.exportRows(hierarchyContext).map(row=>row.AccountId),['A5']);
assert.deepEqual(hierarchyContext.filters,filters);

console.log('Live client economics checks passed.');
