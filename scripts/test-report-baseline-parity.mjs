import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const current = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const baselinePath = process.env.TRADERSCALE_BASELINE_HTML ||
  'C:/Users/User/Downloads/Telegram Desktop/TraderScale-BI-Review-Demo.html';

const modules = [
  'client-profit.js', 'retention-queue.js', 'owner-value.js', 'rebuy.js',
  'updates.js', 'payout-history.js', 'risk-rules.js', 'profitable-risk.js',
  'payout-patterns.js', 'payout-consistency.js', 'affiliate-growth.js',
  'pricing-analysis.js', 'economics.js', 'reports.js',
];

const requiredReports = [
  'client-profit', 'journey', 'ltv', 'rebuy', 'updates', 'paid-marketing',
  'payout-history', 'risk-radar', 'profitable-risk', 'payout-patterns',
  'consistency', 'affiliates', 'pricing', 'profitability',
];

function block(source, name) {
  const start = source.indexOf(`<script data-source="${name}">`);
  assert.notEqual(start, -1, `${name} must remain in the dashboard.`);
  const end = source.indexOf('</script>', start);
  assert.notEqual(end, -1, `${name} must have a closing script tag.`);
  return source.slice(start, end);
}

function values(source, pattern) {
  return new Set([...source.matchAll(pattern)].map((match) => match[1].trim()).filter(Boolean));
}

const reportsSource = block(current, 'reports.js');
for (const id of requiredReports) {
  assert.match(reportsSource, new RegExp(`\\{ id: '${id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}'`),
    `${id} must remain in the supplied report catalogue.`);
}

if (!existsSync(baselinePath)) {
  console.log('report baseline parity: reference HTML not present; catalogue manifest passed');
  process.exit(0);
}

const baseline = readFileSync(baselinePath, 'utf8');
for (const name of modules) {
  const before = block(baseline, name);
  const after = block(current, name);
  const baselineHeadings = values(before, /<h[123][^>]*>([^<+'"]+)/g);
  const currentHeadings = values(after, /<h[123][^>]*>([^<+'"]+)/g);
  const baselineActions = values(before, /data-action="([^"]+)"/g);
  const currentActions = values(after, /data-action="([^"]+)"/g);
  const baselineControls = values(before, /data-[a-z-]+-control="([^"]+)"/g);
  const currentControls = values(after, /data-[a-z-]+-control="([^"]+)"/g);

  for (const heading of baselineHeadings) assert.ok(currentHeadings.has(heading), `${name} lost heading: ${heading}`);
  for (const action of baselineActions) assert.ok(currentActions.has(action), `${name} lost action: ${action}`);
  for (const control of baselineControls) assert.ok(currentControls.has(control), `${name} lost control: ${control}`);
}

console.log(`report baseline parity: ${modules.length} report modules preserve supplied headings, actions and controls`);
