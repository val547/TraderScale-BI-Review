import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../public/dashboard/snapshot-worker.js', import.meta.url), 'utf8');
const connector = readFileSync(new URL('../public/dashboard/production-connector.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../railway-server.ts', import.meta.url), 'utf8');
const snapshot = readFileSync(new URL('../lib/bi-snapshot.ts', import.meta.url), 'utf8');

assert.match(worker, /response\.arrayBuffer\(\)/,
  'The snapshot worker must transfer bytes instead of creating a second parsed warehouse object.');
assert.match(worker, /postMessage\([^\n]+, \[buffer\]\)/,
  'The snapshot ArrayBuffer must use the transferable list.');
assert.doesNotMatch(worker, /JSON\.parse/,
  'The worker must not parse and structured-clone the full snapshot.');

assert.match(connector, /function loadCompetitorData\(\)/,
  'Competitor history must have an explicit lazy loader.');
assert.match(connector, /location\.hash\.slice\(1\) === 'competitors'/,
  'Competitor history must load only for the competitor screen.');
assert.doesNotMatch(connector, /setTimeout\(async function \(\) \{[\s\S]{0,800}fetch\(COMPETITOR_ENDPOINT/,
  'The competitor baseline must not be fetched during every dashboard boot.');
assert.match(connector, /SNAPSHOT_ENDPOINT = '\/api\/bi\/snapshot\?view=core'/,
  'Initial dashboard boot must request the core snapshot rather than optional report datasets.');
assert.match(connector, /OPTIONAL_ENDPOINTS = \{[\s\S]*marketing:[\s\S]*rebuy:/,
  'Marketing and rebuy datasets must load independently when their reports are opened.');
assert.match(snapshot, /export function snapshotView/,
  'The server must expose allow-listed snapshot projections.');
assert.match(snapshot, /marketing: null, rebuy: \[\]/,
  'The core snapshot must omit optional report payloads.');

assert.match(dashboard, /if\(!cacheHit\)\{const metricsStarted=performance\.now\(\),pageMetrics=D\.getMetrics\(filters\)/,
  'Global metrics must be calculated only on a page-cache miss.');
assert.match(dashboard, /pageHtmlCache\.size>=36/,
  'The page cache must retain a complete navigation pass.');

assert.match(server, /createGzip/,
  'Large static dashboard assets must support streaming gzip.');
assert.match(server, /useGzip = compressible/,
  'Static gzip must be negotiated rather than applied to binary assets.');

console.log('performance architecture: transferable snapshot, lazy competitor data, cached metrics and static gzip passed');
