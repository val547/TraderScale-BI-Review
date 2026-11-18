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

const allowedPagesMatch = dashboard.match(/const allowedPages=\[([^\]]+)\]/);
assert.ok(allowedPagesMatch, 'The application page allow-list must exist.');
const allowedPages = new Set([...allowedPagesMatch[1].matchAll(/'([^']+)'/g)].map(([, page]) => page));
for (const report of reportRows) {
  assert.ok(allowedPages.has(report.page), `${report.title} must point to an allowed application page.`);
}

console.log(`reports navigation: ${reportRows.length} supplied report cards are openable`);
