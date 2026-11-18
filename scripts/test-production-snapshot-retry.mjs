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
assert.match(dashboard, /production-connector\.js\?v=20261118-retry-live-ui2/,
  'The dashboard must bypass cached connector builds after the retry fix.');

console.log('production snapshot retry: Railway warmup recovery passed');
