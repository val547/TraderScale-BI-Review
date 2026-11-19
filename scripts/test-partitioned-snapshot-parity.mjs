import assert from 'node:assert/strict';
import { snapshotView } from '../lib/bi-snapshot.ts';

const names = [
  'accounts', 'payouts', 'orders', 'profitability', 'affiliates', 'affiliatePnl',
  'customers', 'withdrawable', 'riskFindings'
];
const snapshot = {
  schemaVersion: 1,
  mode: 'production',
  asOf: '2026-11-19',
  currency: 'USD',
  quality: { partial: false, marker: 'same-object-contract' },
  data: Object.fromEntries([
    ...names.map((name, index) => [name, name === 'withdrawable'
      ? { accounts: [{ id: index }], run: { id: index } }
      : [{ id: index, marker: `${name}-row` }]]),
    ['marketing', { channels: [{ id: 'optional' }] }],
    ['rebuy', [{ id: 'optional' }]],
  ]),
};

const core = snapshotView(snapshot, 'core');
const assembled = {
  schemaVersion: core.schemaVersion,
  mode: core.mode,
  asOf: core.asOf,
  currency: core.currency,
  quality: core.quality,
  data: { marketing: null, rebuy: [] },
};
for (const name of names) {
  const part = snapshotView(snapshot, name);
  assembled.data[name] = part.data[name];
}

assert.deepEqual(assembled, core,
  'Parallel dataset responses must reconstruct the exact core snapshot contract before applySnapshot runs.');
console.log('partitioned snapshot parity: exact core contract reconstructed from parallel datasets');
