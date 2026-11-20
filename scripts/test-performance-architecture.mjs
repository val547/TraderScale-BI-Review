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
assert.match(connector, /CORE_DATASETS = \[[\s\S]{0,300}'accounts'[\s\S]{0,300}'riskFindings'/,
  'The unchanged core contract must be transferred as independently cached datasets.');
assert.match(connector, /Promise\.all\(CORE_DATASETS\.map/,
  'Independent live datasets must download in parallel before the dashboard is exposed.');
assert.match(connector, /partitioned\(\)\.catch\(direct\)/,
  'The exact monolithic core snapshot must remain the fallback if partitioned transfer fails.');
assert.match(connector, /navigator\.sendBeacon\('\/api\/performance'/,
  'Production boot must report anonymous phase timings for evidence-based optimization.');
assert.match(connector, /function recordRenderTiming\(sample\)/,
  'Production tab changes must report bounded anonymous render timings.');
assert.doesNotMatch(connector, /window\.dispatchEvent\(new HashChangeEvent\('hashchange'\)\)/,
  'Applying one live snapshot must not synchronously render the same page twice.');
assert.match(dashboard, /recordRenderTiming\(\{page,totalMs:elapsed/,
  'Every completed page render must expose compute, DOM and presentation phases.');
assert.match(connector, /OPTIONAL_ENDPOINTS = \{[\s\S]*marketing:[\s\S]*rebuy:/,
  'Marketing and rebuy datasets must load independently when their reports are opened.');
assert.match(connector, /function showOptionalLoader\(page\)/,
  'Lazy report navigation must expose a visible loader instead of appearing unresponsive.');
assert.match(connector, /showOptionalLoader\(targetPage\);[\s\S]{0,900}requestAnimationFrame\(hideOptionalLoader\)/,
  'The lazy report loader must remain visible until the requested report has rendered.');
assert.match(connector, /window\.BIData\.productionRebuy = \[\]/,
  'A failed optional rebuy request must never reveal embedded demonstration rows.');
assert.match(snapshot, /export function snapshotView/,
  'The server must expose allow-listed snapshot projections.');
assert.match(snapshot, /marketing: null, rebuy: \[\]/,
  'The core snapshot must omit optional report payloads.');

assert.match(dashboard, /if\(!cacheHit\)\{const metricsStarted=performance\.now\(\),pageMetrics=D\.getMetrics\(filters\)/,
  'Global metrics must be calculated only on a page-cache miss.');
assert.match(dashboard, /const riskCaseIndex=new Map\(\),riskCaseOrder=new Map\(\)/,
  'Risk cases must be indexed once instead of rescanning the full ledger for every account.');
assert.match(dashboard, /const cases=casesFor\(account\)/,
  'Account priority calculations must use the order-preserving risk-case index.');
assert.match(dashboard, /pageHtmlCache\.size>=36/,
  'The page cache must retain a complete navigation pass.');

assert.match(server, /createGzip/,
  'Large static dashboard assets must support streaming gzip.');
assert.match(server, /useGzip = compressible/,
  'Static gzip must be negotiated rather than applied to binary assets.');
assert.match(server, /const ready = Boolean\(snapshotCache\)/,
  'Railway readiness must wait for the daily snapshot instead of routing users to a cold instance.');
assert.match(server, /ready \? 200 : 503/,
  'A cold deployment must remain unavailable to the load balancer until live data is ready.');
assert.match(server, /setTimeout\(warmSnapshotUntilReady, 15_000\)/,
  'Failed warehouse warmups must retry without exposing a broken application instance.');
assert.match(server, /max-age=3600, stale-while-revalidate=86400, stale-if-error=604800/,
  'Authenticated browsers must reuse the exact live snapshot while a daily refresh or deployment warms in the background.');
assert.match(server, /for \(const view of \[[\s\S]{0,300}"core"[\s\S]{0,300}"riskFindings"/,
  'Every browser-facing snapshot variant must be serialized and compressed during warmup.');
assert.match(server, /coreBytes: snapshotCache\?\.variants\.get\("core"\)/,
  'Readiness diagnostics must expose the prepared core transfer size without exposing business data.');
assert.match(server, /datasetBytes: Object\.fromEntries/,
  'Readiness diagnostics must expose per-dataset transfer sizes for evidence-based page splitting.');
assert.match(server, /brotliCompressSync/,
  'The unchanged live snapshot must be precompressed with Brotli during warmup.');
assert.match(server, /acceptedEncoding\.includes\("br"\)/,
  'Modern browsers must receive the smaller Brotli representation without changing the data contract.');
assert.match(server, /url\.pathname === "\/api\/performance"/,
  'The authenticated server must accept bounded anonymous browser timing samples.');

console.log('performance architecture: transferable snapshot, lazy competitor data, cached metrics and static gzip passed');
