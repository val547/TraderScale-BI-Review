import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const connector = readFileSync(new URL("../public/dashboard/production-connector.js", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/dashboard/index.html", import.meta.url), "utf8");

assert.match(connector, /var defaultRange = presetRange\('this-month'\)/,
  "the live reporting period must initialize to the current month");
assert.match(connector, /state\.dateAllTime = false/,
  "the live reporting period must not initialize to all time");
assert.match(connector, /preset\[0\] === activePreset/,
  "the current-month preset must be visibly selected");

assert.match(dashboard, /const defaults=\{dimension:'programme',search:'',sort:'amount',affiliate:'all',trafficType:'all',preset:'mtd'\}/,
  "Payouts must default to month to date");
assert.match(dashboard, /defaults=presetRange\(source\.asOf,'mtd'\)/,
  "Customer lifetime value must default to month to date");
assert.match(dashboard, /preset:valid\?\(l\.econMonthlyPreset\|\|'custom'\):'current-month'/,
  "monthly cohort reports must default to the current acquisition month");
assert.doesNotMatch(dashboard, /filters\.period='90d'/,
  "opening Account Analytics must not replace the current-month period");

console.log("current-month defaults: live pages and independent reports passed");
