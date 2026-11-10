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

console.log('Live client economics checks passed.');
