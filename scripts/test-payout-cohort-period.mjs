import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const connector = readFileSync(new URL('../public/dashboard/production-connector.js', import.meta.url), 'utf8');
const snapshot = readFileSync(new URL('../lib/bi-snapshot.ts', import.meta.url), 'utf8');
const moduleSource = dashboard.match(/<script data-source="payout-history\.js">([\s\S]*?)<\/script>/)?.[1] || '';
const cohortSource = dashboard.match(/<script data-source="payout-cohorts\.js">([\s\S]*?)<\/script>/)?.[1] || '';

assert.ok(moduleSource, 'Payout history module must exist.');
assert.ok(cohortSource, 'Payout cohort-month module must exist.');
assert.match(moduleSource, /function firstPurchaseIndex\(source,asOf\)/,
  'Payout filtering must build a verified first-purchase index.');
assert.match(moduleSource, /row\.componentType==='payout'.*row\.customerId/,
  'Affiliate payout attribution must use released payout components, not assume No affiliate.');
assert.doesNotMatch(moduleSource, /unique\(data\.affiliatePnl\)/,
  'Released Affiliate P&L components have no generic id and must not be discarded by payout-row deduplication.');
assert.match(snapshot, /affiliateAttributionSource: "Released Affiliate P&L payout allocation"/,
  'The production snapshot must ship reconciled payout affiliate attribution to the browser.');
assert.match(snapshot, /rpt_affiliate_payout_allocation/,
  'Payout affiliate attribution must use the released payout-to-origin allocation view.');
assert.match(snapshot, /affiliatePayoutAllocations\.get\(text\(row\.payout_id\)\)/,
  'The released allocation must join directly to the stable payout id.');
assert.match(snapshot, /affiliateAttributionSource: affiliateId \? "Released payout-to-origin allocation"/,
  'Direct payout-to-origin attribution must retain explicit provenance.');
assert.match(snapshot, /!row\.approvedAt \|\| !row\.warehouseCustomerId \|\| row\.affiliateId/,
  'The legacy money reconciliation must not overwrite a direct released payout allocation.');
assert.match(snapshot, /Math\.abs\(paymentGroup\.amount - componentGroup\.amount\) > 0\.01/,
  'Server-side payout attribution must reconcile grouped money before assigning an affiliate.');
assert.match(moduleSource, /row\.warehouseCustomerId\|\|row\.customerId/,
  'Affiliate payout attribution must reconcile the warehouse customer identity used by the released P&L view.');
assert.match(moduleSource, /row\.affiliate==='none'\|\|!knownAttribution\(row\.affiliate\)/,
  'No-affiliate defaults must still be eligible for released P&L reconciliation.');
assert.match(moduleSource, /releasedAffiliate=clean\(p\.affiliateAttributionSource\)&&clean\(p\.affiliateId\)/,
  'Browser payout rows must preserve the released affiliate attribution shipped by the live snapshot.');
assert.match(moduleSource, /affiliateId=releasedAffiliate\?clean\(p\.affiliateId\):/,
  'A linked order must not overwrite the reconciled payout affiliate supplied by the server.');
assert.match(moduleSource, /affiliateName:clean\(p\.affiliateName\)\|\|/,
  'Affiliate grouping must preserve the released partner name even when the local profile map is incomplete.');
assert.match(moduleSource, /\(data\.affiliatePnl\|\|\[\]\)\.length/,
  'Payout ledger cache must invalidate when released Affiliate P&L rows arrive after the first render.');
assert.match(moduleSource, /cached\.revision===cacheRevision/,
  'Payout ledger cache must not preserve the pre-live no-affiliate ledger.');
assert.match(moduleSource, /Math\.abs\(paymentAmount-componentAmount\)>\.01/,
  'Affiliate payout attribution must reconcile component money before assigning a partner.');
assert.match(moduleSource, /affiliateIds\.length===1/,
  'Ambiguous multi-affiliate payout allocations must remain unassigned.');
assert.match(moduleSource, /production&&ctx\.data\.productionPayoutHistorySource/,
  'Production Payouts must use the live snapshot source directly, never the hidden demo period state.');
assert.match(moduleSource, /inRange=\(p,r\)=>p\.firstPurchaseDate>=r\[0\]&&p\.firstPurchaseDate<=r\[1\]/,
  'The top reporting period must select customers by first successful purchase date.');
assert.doesNotMatch(moduleSource, /inRange=\(p,r\)=>p\.paidDate>=r\[0\]/,
  'Payout settlement date must not control acquisition-cohort membership.');
assert.match(moduleSource, /dated\.filter\(o=>o\.firstPurchaseDate>=range\[0\]&&o\.firstPurchaseDate<=range\[1\]\)/,
  'Revenue must use the same acquisition cohort.');
assert.match(moduleSource, /p\.firstPurchaseDate>=windows\.current\[0\]&&p\.firstPurchaseDate<=windows\.current\[1\]/,
  'Rejected outcomes must use the same acquisition cohort.');
assert.match(moduleSource, /current:\[windows\.current\[0\],windows\.asOf\]/,
  'Selected cohort activity must remain observable through the warehouse snapshot.');
assert.match(moduleSource, /const point=map\.get\(monthly\?p\.paidDate\.slice\(0,7\):p\.paidDate\);if\(point\)point\.rows\.push\(p\)/,
  'An out-of-window payout event must not abort the full page refresh.');
assert.match(moduleSource, /const point=map\.get\(monthly\?o\.date\.slice\(0,7\):o\.date\);if\(point\)point\.orders\.push\(o\)/,
  'An out-of-window revenue event must not abort the full page refresh.');
assert.match(moduleSource, /Customers are selected by their first successful challenge purchase date\./,
  'The visible page must state the acquisition-cohort basis clearly.');
assert.match(connector, /\.production-mode \.ph-date-controls\{display:none!important\}/,
  'Production must show only the global reporting-period control.');
assert.match(connector, /notifyProductionReady\(\);/,
  'Applying a global date must refresh the live report directly.');
assert.match(connector, /data\.productionPayoutHistorySource = source/,
  'The live snapshot must publish one production payout source for every section of the page.');
assert.match(dashboard, /refreshProduction:refreshProductionData/,
  'The dashboard must expose a direct production refresh hook.');
assert.match(dashboard, /setTimeout\(refreshProductionData,0\)/,
  'The dashboard must recover when the live snapshot arrives before its listeners are installed.');
assert.match(cohortSource, /const payments=payout\.current\.map\(payment=>/,
  'Cohort month must consume the exact same selected payout rows as the page KPIs.');
assert.match(cohortSource, /firstPurchases\(payout\.source,payout\.ledger\.rows,payout\.windows\.asOf\)/,
  'First purchase month must use all available purchase and payout history.');
assert.match(cohortSource, /const total=rowTotals\(payments\)/,
  'Cohort totals must be calculated from the exact selected payout rows.');
assert.match(cohortSource, /total\.payments===payout\.totals\.payments&&Math\.abs\(total\.amount-payout\.totals\.amount\)<\.01/,
  'Cohort count and value must reconcile to the top payout KPIs.');
assert.match(cohortSource, /render:cohortRender/,
  'Cohort month copy and exports must describe the first-purchase acquisition filter.');
assert.match(moduleSource, /The payout date does not decide cohort membership\./,
  'The calculation drawer must explain that first purchase controls cohort membership.');
assert.doesNotMatch(cohortSource, /FictionalDemo/,
  'Live payout cohort exports must never be labelled as fictional or demo data.');

console.log('payout reporting period: acquisition-cohort filtering passed');
