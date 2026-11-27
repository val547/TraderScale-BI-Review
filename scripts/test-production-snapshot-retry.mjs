import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const connector = readFileSync(new URL('../public/dashboard/production-connector.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');

assert.match(connector, /function loadSnapshotOnce\(\)/,
  'The authenticated snapshot request must remain isolated from retry orchestration.');
assert.match(connector, /retryDelays = \[0, 1500, 3000, 6000, 12000, 24000, 30000\]/,
  'Production startup must retry while Railway warms the daily BigQuery snapshot.');
assert.match(connector, /return await loadSnapshotOnce\(\)/,
  'A successful retry must immediately continue production startup.');
assert.match(connector, /throw lastError \|\| new Error\('Live snapshot request failed\.'\)/,
  'The no-live-data state must appear only after all retries fail.');
assert.match(connector, /function notifyProductionReady\(\) \{\s+setTimeout\(function \(\) \{/,
  'UI refresh must not turn an already loaded snapshot into a source failure.');
assert.match(dashboard, /production-connector\.js\?v=20261127-awaiting-payment/,
  'The dashboard must bypass cached connector builds after the retry fix.');

console.log('production snapshot retry: Railway warmup recovery passed');

const { readFileSync: readSource } = await import('node:fs');
const paymentsConnector = readSource(new URL('../public/dashboard/production-connector.js', import.meta.url), 'utf8');
const awaitingSource = paymentsConnector.match(/  function accountAwaitingPayments\(data, quality\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(awaitingSource, 'Accounts must use verified current payout status');
const awaitingPayments = new Function(awaitingSource + '\nreturn accountAwaitingPayments;')();
const payout = (id, accountId, overrides = {}) => ({
  id, accountId, status: 'Approved', sourceStatus: 'approved', payoutType: 'trader',
  payoutCurrency: 'USD', approvedAt: '2026-11-25', approvedShare: 345, ...overrides,
});
const pending = (accountId, pendingPayoutId) => ({ accountId, pendingPayoutId, pendingPayout: 345 });
const payload = {
  withdrawable: { accounts: [pending('confirmed','1'),pending('review','3'),pending('differentAccount','4'),pending('currency','5')] },
  payouts: [payout('1','confirmed'),payout('1','confirmed'),payout('2','historical'),
    payout('3','review',{status:'Under review',sourceStatus:'submitted'}),
    payout('4','wrongAccount'),payout('5','currency',{payoutCurrency:'GBP'}),
    payout('6','partner',{payoutType:'affiliate'}),payout('7','settled',{status:'Paid',sourceStatus:'paid'})],
};
assert.deepEqual([...awaitingPayments(payload, {withdrawableReady:true})],
  [['confirmed',345],['historical',null],['wrongAccount',null],['currency',null]]);
assert.equal(awaitingPayments(payload, {withdrawableReady:false}),null);
assert.equal(awaitingPayments({...payload,payouts:[{status:'Approved'}]}, {withdrawableReady:true}),null);
