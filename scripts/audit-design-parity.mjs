import fs from 'node:fs';
import path from 'node:path';

const [originalArg, currentArg = 'public/dashboard/index.html'] = process.argv.slice(2);
if (!originalArg) {
  console.error('Usage: node scripts/audit-design-parity.mjs <original.html> [current.html]');
  process.exit(1);
}

const originalPath = path.resolve(originalArg);
const currentPath = path.resolve(currentArg);

function modules(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const result = new Map();
  const pattern = /<(style|script)\b[^>]*data-source="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  for (const match of html.matchAll(pattern)) {
    const [, kind, name, source] = match;
    result.set(`${kind}:${name}`, source.replace(/\r\n/g, '\n').trim());
  }
  return result;
}

function similarity(left, right) {
  if (left === right) return 1;
  const leftLines = new Set(left.split('\n').map(line => line.trim()).filter(Boolean));
  const rightLines = new Set(right.split('\n').map(line => line.trim()).filter(Boolean));
  const intersection = [...leftLines].filter(line => rightLines.has(line)).length;
  return intersection / Math.max(1, new Set([...leftLines, ...rightLines]).size);
}

const original = modules(originalPath);
const current = modules(currentPath);
const keys = [...new Set([...original.keys(), ...current.keys()])].sort();

const rows = keys.map(key => {
  const left = original.get(key);
  const right = current.get(key);
  if (left == null) return { module: key, status: 'current-only', similarity: 0 };
  if (right == null) return { module: key, status: 'missing', similarity: 0 };
  const score = similarity(left, right);
  return {
    module: key,
    status: score === 1 ? 'identical' : 'changed',
    similarity: Number((score * 100).toFixed(1)),
    originalBytes: Buffer.byteLength(left),
    currentBytes: Buffer.byteLength(right),
  };
});

console.table(rows.filter(row => row.status !== 'identical'));
console.log(JSON.stringify({
  original: originalPath,
  current: currentPath,
  identical: rows.filter(row => row.status === 'identical').length,
  changed: rows.filter(row => row.status === 'changed').length,
  missing: rows.filter(row => row.status === 'missing').map(row => row.module),
  currentOnly: rows.filter(row => row.status === 'current-only').map(row => row.module),
}, null, 2));
