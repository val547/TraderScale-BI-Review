import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const connector = readFileSync(new URL('../public/dashboard/production-connector.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');

assert.match(connector, /\(data\.riskFindings \|\| \[\]\).*isoDate\(row\.findingAt\)/, 'Calendar bounds must include risk evidence dates.');
assert.doesNotMatch(connector, /currentOnlyPages = new Set\(\[[^\]]*'risk-radar'/, 'Risk Radar must not be locked to the current-snapshot date control.');
assert.match(connector, /datedPages = new Set\(\[[^\]]*'risk-radar'/, 'Risk Radar must use the reporting-period picker.');
assert.match(dashboard, /connector\.inDateRange\(row\.findingAt\)/, 'Risk findings must be filtered by evidence timestamp.');
assert.match(dashboard, /String\(b\.findingAt\|\|''\)\.localeCompare\(String\(a\.findingAt\|\|''\)\)/, 'Risk evidence must sort newest first.');

console.log('Risk evidence period and ordering checks passed.');
