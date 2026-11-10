import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const snapshotSource = readFileSync(new URL('../lib/bi-snapshot.ts', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../public/dashboard/index.html', import.meta.url), 'utf8');

assert.match(
  snapshotSource,
  /COALESCE\(d\.registered_at, a\.created_at\) AS registered_at/,
  'Customer Journey must prefer the canonical commerce registration timestamp.',
);
assert.doesNotMatch(
  snapshotSource,
  /IF\(d\.warehouse_customer_id IS NOT NULL, a\.created_at, d\.registered_at\) AS registered_at/,
  'A nullable Axcera timestamp must not replace a known commerce registration timestamp.',
);
assert.match(
  dashboardSource,
  /connector\.inDateRange\(row\.registeredAt\)/,
  'Customer Journey must apply the selected reporting period to the resolved registration timestamp.',
);

console.log('Customer Journey source regression checks passed.');
