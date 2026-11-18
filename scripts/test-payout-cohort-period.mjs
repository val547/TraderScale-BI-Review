import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const moduleSource = dashboard.match(/<script data-source="payout-history\.js">([\s\S]*?)<\/script>/)?.[1] || '';

assert.ok(moduleSource, 'Payout history module must exist.');
assert.match(moduleSource, /function firstPurchaseIndex\(source,asOf\)/,
  'Payout filtering must build a verified first-purchase index.');
assert.match(moduleSource, /inRange=\(p,r\)=>p\.firstPurchaseDate>=r\[0\]&&p\.firstPurchaseDate<=r\[1\]/,
  'Payouts must enter the selected period by first purchase date.');
assert.doesNotMatch(moduleSource, /inRange=\(p,r\)=>p\.paidDate>=r\[0\]/,
  'Payout settlement date must not control cohort membership.');
assert.match(moduleSource, /dated\.filter\(o=>o\.firstPurchaseDate>=range\[0\]&&o\.firstPurchaseDate<=range\[1\]\)/,
  'Revenue must use the same acquisition cohort.');
assert.match(moduleSource, /p\.firstPurchaseDate>=windows\.current\[0\]&&p\.firstPurchaseDate<=windows\.current\[1\]/,
  'Rejected outcomes must use the same acquisition cohort.');
assert.match(moduleSource, /current:\[windows\.current\[0\],windows\.asOf\]/,
  'Selected cohort activity must remain observable through the warehouse snapshot.');
assert.match(moduleSource, /The payout date does not decide whether that customer is included\./,
  'The visible calculation rules must describe the cohort basis clearly.');

console.log('payout cohort period: first-purchase filtering passed');
