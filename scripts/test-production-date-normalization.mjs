import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../public/dashboard/production-connector.js", import.meta.url), "utf8");
const match = source.match(/function isoDate\(value\) \{([\s\S]*?)\n  \}/);
assert.ok(match, "production date normalizer must exist");
const isoDate = new Function(`return function isoDate(value) {${match[1]}\n}`)();

assert.equal(isoDate("2026-10-14"), "2026-10-14");
assert.equal(isoDate("2026-10-14T18:42:01.123Z"), "2026-10-14");
assert.equal(isoDate("2026-10-14 18:42:01+00"), "2026-10-14");
assert.equal(isoDate("2026-02-30T00:00:00Z"), "");
assert.equal(isoDate("not-a-date"), "");

console.log("production date normalization: DATE, TIMESTAMP and DATETIME inputs passed");
