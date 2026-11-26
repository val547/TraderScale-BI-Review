import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const source = dashboard.match(/<script data-source="reports\.js">([\s\S]*?)<\/script>/)?.[1] || '';

assert.ok(source, 'Reports catalogue module must exist.');

const reportRows = [...source.matchAll(/\{ id: '([^']+)', title: '([^']+)'[\s\S]*?page: '([^']+)'/g)]
  .map(([, id, title, page]) => ({ id, title, page }));

assert.ok(reportRows.length >= 14, 'The full specialist report catalogue must remain present.');
assert.ok(reportRows.some((row) => row.id === 'rebuy' && row.title === 'Average rebuy time' && row.page === 'rebuy'),
  'Average rebuy time must remain mapped to its complete report screen.');
assert.match(source, /const source=coverage\(report,ctx\),enabled=true/,
  'Every supplied report card must stay clickable even when its live source currently has no rows.');
assert.match(source, /if \(action === 'reports-open'\)[\s\S]*return \{ navigate: report\.page \}/,
  'Clicking a report card must navigate to the mapped report screen.');
assert.doesNotMatch(source, /enabled=source\.state==='live'/,
  'Source readiness must not disable a supplied report screen.');

assert.match(dashboard, /completed=rows\.filter\(row=>row\.rebuySeconds!=null\)/,
  'Average rebuy time must include only completed breach-to-rebuy cycles.');
assert.match(dashboard, /values=completed\.map\(row=>row\.rebuyDays\),avg=values\.length\?values\.reduce\(\(a,b\)=>a\+b,0\)\/values\.length:null,med=median\(values\)/,
  'Average and median rebuy time must use exact elapsed days from completed cycles, never open breaches or zero placeholders.');
assert.match(dashboard, /history = \{ purchases: livePurchases, events: events, rows: candidates, accounts: liveAccounts, asOf: asOf \}/,
  'Live rebuy history must retain historical breaches until the reporting cohort is selected.');
assert.match(dashboard, /var matching = h\.rows\.filter[\s\S]{0,900}matching\.forEach\(function \(row\) \{ if \(!latest\[row\.customerId\]/,
  'The reporting period and dimensions must be applied before selecting one latest breach per customer.');
assert.doesNotMatch(dashboard, /Select the latest breach across the complete customer portfolio BEFORE applying cohort filters/,
  'A later breach outside the reporting period must not erase a valid historical cohort record.');

const allowedPagesMatch = dashboard.match(/const allowedPages=\[([^\]]+)\]/);
assert.ok(allowedPagesMatch, 'The application page allow-list must exist.');
const allowedPages = new Set([...allowedPagesMatch[1].matchAll(/'([^']+)'/g)].map(([, page]) => page));
for (const report of reportRows) {
  assert.ok(allowedPages.has(report.page), `${report.title} must point to an allowed application page.`);
}

console.log(`reports navigation: ${reportRows.length} supplied report cards are openable`);

const pipelineSource = dashboard.match(/<script data-source="pipeline\.js">([\s\S]*?)<\/script>/)?.[1];
assert.ok(pipelineSource, 'Payout readiness must be available to Owner overview.');
const testWindow = {};
new Function('window', pipelineSource)(testWindow);
const funded = {
  id: 'funded-known', status: 'Active', stage: 'Funded', programme: 'Speedy',
  payoutAccrued: 100, profitDays: 3, realizedPnl: 100, consistency: 10,
  initialBalance: 50000, rewardShare: 0.8, openedAt: '2026-11-01',
};
const { funded: accounts, readyCount, blockedCount } = testWindow.BIPipeline.getSummary({
  data: { asOf: '2026-11-26', accountRules: {}, accounts: [
    funded,
    { ...funded, id: 'funded-missing', openedAt: undefined },
    { ...funded, id: 'funded-invalid', openedAt: '2026-11-31' },
  ] },
  local: {}, filters: {},
});
assert.equal(readyCount, 1);
assert.equal(blockedCount, 2);
for (const row of accounts.slice(1)) {
  assert.equal(row.earliestDate, null);
  assert.equal(row.waitDaysRemaining, null);
  assert.ok(row.blockers.includes('Opening date unavailable'));
}
