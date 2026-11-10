import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const sourcesPath = path.join(root, "public", "dashboard", "data", "competitor-sources.json");
const outputPath = path.join(root, "public", "dashboard", "data", "competitor-monitor.json");
const scheduled = process.argv.includes("--scheduled");
const browserFallbackEnabled = process.env.COMPETITOR_BROWSER_FALLBACK === "1";
const execFileAsync = promisify(execFile);
const requestCache = new Map();
const now = new Date();
const checkedAt = now.toISOString();

if (scheduled) {
  const kyivHour = Number(new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", hour12: false, timeZone: "Europe/Kyiv",
  }).format(now));
  if (kyivHour !== 8) {
    console.log(`Skipping duplicate UTC schedule; Kyiv hour is ${kyivHour}.`);
    process.exit(0);
  }
}

const sourceDocument = JSON.parse(await readFile(sourcesPath, "utf8"));
let previous = null;
try { previous = JSON.parse(await readFile(outputPath, "utf8")); } catch {}

function decode(value) {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function normalize(html) {
  return decode(html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/data-cf-modified-[a-f0-9-]+/gi, " ")
    .replace(/\d+\s*Days?\s*:\s*\d+\s*Hr\s*:\s*\d+\s*Min\s*:\s*\d+\s*Sec/gi, " ")
    .replace(/\s+/g, " ").trim()).slice(0, 12000);
}

function pageTitle(html, fallback) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return normalize(match?.[1] || "") || fallback;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pageKind(url, label = "") {
  const value = `${url} ${label}`.toLowerCase();
  if (/payout|withdraw|reward/.test(value)) return "Payout terms";
  if (/rule|objective|prohibited|trading-condition/.test(value)) return "Trading Rules";
  if (/term|legal|condition|agreement|policy/.test(value)) return "Terms & Conditions";
  if (/faq|help|knowledge|support/.test(value)) return "FAQ";
  if (/price|pricing|plan|challenge|account|program/.test(value)) return "Pricing & Plans";
  return "Homepage";
}

function categoryFor(kind) {
  if (kind === "Trading Rules") return "rules";
  if (kind === "Terms & Conditions") return "legal";
  if (kind === "Payout terms") return "payouts";
  if (kind === "Pricing & Plans") return "pricing";
  if (kind === "FAQ") return "products";
  return "navigation";
}

function extractCandidates(html, baseUrl) {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./, "");
  const candidates = [];
  const expression = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = expression.exec(html))) {
    try {
      const url = new URL(match[1], base);
      const host = url.hostname.replace(/^www\./, "");
      if (url.protocol !== "https:" || (host !== baseHost && !host.endsWith(`.${baseHost}`))) continue;
      if (/(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|auth|checkout|portal|dashboard)(\/|$)/i.test(url.pathname)) continue;
      url.hash = ""; url.search = "";
      const label = normalize(match[2]).slice(0, 120);
      const kind = pageKind(url.href, label);
      if (kind === "Homepage") continue;
      if (!candidates.some(item => item.kind === kind)) candidates.push({ kind, url: url.href });
    } catch {}
  }
  return candidates.slice(0, 5);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function retryDelay(response) {
  const header = response.headers.get("retry-after");
  if (!header) return 5000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 1000), 15000);
  const date = new Date(header).getTime();
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 1000), 15000) : 5000;
}

function protectionPage(html) {
  return /just a moment|please wait|shopshield|optimizing your request|verify you are human|checking your browser|access denied|captcha|attention required|cloudflare ray id|performance\s*&\s*security by cloudflare|ray id[:\s]|security checkpoint|vercel\s*\||проверяет[^.]{0,80}не бот|проверяем ваш браузер|контрольная точка безопасности|ожидание ответа/i.test(normalize(html).slice(0, 2500));
}

async function browserHtml(url) {
  if (!browserFallbackEnabled) return null;
  const commands = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const command of commands) {
    try {
      const { stdout } = await execFileAsync(command, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--virtual-time-budget=10000", "--dump-dom", url], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      if (stdout && !protectionPage(stdout)) return { html: stdout, finalUrl: url, via: "browser" };
    } catch {}
  }
  return null;
}

async function fetchHtmlUncached(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        redirect: "follow", signal: controller.signal,
        headers: { "user-agent": "TraderScale-Competitor-Monitor/1.0 (+https://traderscale.com; official public-page change monitoring)", accept: "text/html,application/xhtml+xml" },
      });
      if (response.status === 429 && attempt === 0) {
        await wait(retryDelay(response));
        continue;
      }
      if ([403, 429].includes(response.status)) {
        const rendered = await browserHtml(url);
        if (rendered) return rendered;
        throw new Error(response.status === 403 ? "Official site blocked automated access (HTTP 403); manual browser review required" : "Official site rate limit remained active (HTTP 429); retry in a later check");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
      const html = await response.text();
      if (protectionPage(html)) {
        const rendered = await browserHtml(url);
        if (rendered) return rendered;
        throw new Error("Official site protection page detected; manual browser review required");
      }
      return { html, finalUrl: response.url, via: "http" };
    }
    throw new Error("Official site rate limit remained active (HTTP 429); retry in a later check");
  } finally { clearTimeout(timeout); }
}

async function fetchHtml(url) {
  const key = new URL(url).href;
  if (!requestCache.has(key)) requestCache.set(key, fetchHtmlUncached(key));
  return requestCache.get(key);
}

async function inspectPage(kind, url) {
  try {
    const response = await fetchHtml(url);
    const text = normalize(response.html);
    if (text.length < 40) throw new Error("No readable public content");
    return { kind, title: pageTitle(response.html, kind), url: response.finalUrl, status: "ok", transport: response.via || "http", hash: hash(text), text };
  } catch (error) {
    return { kind, title: kind, url, status: "failed", summary: error instanceof Error ? error.message : String(error) };
  }
}

function snippet(text, at) {
  const words = String(text || "").split(/\s+/);
  return words.slice(Math.max(0, at - 18), Math.min(words.length, at + 34)).join(" ").slice(0, 420);
}

function difference(before, after) {
  const left = String(before || "").split(/\s+/), right = String(after || "").split(/\s+/);
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  return { before: snippet(before, index), after: snippet(after, index) };
}

async function inspectFirm(source, oldFirm) {
  if (!source.verified || !source.url) {
    return { id: source.id, name: source.name, url: null, verified: false, enabled: false, lastStatus: "pending", pageCount: 0, lastSummary: "Website not verified", snapshots: [] };
  }
  const homepage = await inspectPage("Homepage", source.url);
  let pages = [homepage];
  if (homepage.status === "ok") {
    try {
      const raw = await fetchHtml(source.url);
      const candidates = extractCandidates(raw.html, raw.finalUrl);
      const inspected = await Promise.all(candidates.map(item => inspectPage(item.kind, item.url)));
      pages = [homepage, ...inspected];
    } catch {}
  }
  const oldPages = new Map((oldFirm?.snapshots || []).map(page => [page.kind, page]));
  const changes = [];
  for (const page of pages) {
    if (page.status !== "ok") continue;
    const oldPage = oldPages.get(page.kind);
    if (!oldPage?.hash || oldPage.hash === page.hash) continue;
    const diff = difference(oldPage.text, page.text);
    const oldCore = String(oldPage.text || "").replace(String(oldPage.title || ""), "").trim();
    const newCore = String(page.text || "").replace(String(page.title || ""), "").trim();
    const stripDynamic = value => value.replace(/\d+\s*Days?\s*:\s*\d+\s*Hr\s*:\s*\d+\s*Min\s*:\s*\d+\s*Sec/gi, " ").replace(/\s+/g, " ").trim();
    if (stripDynamic(oldCore) === stripDynamic(newCore) || /data-cf-modified-/i.test(`${diff.before} ${diff.after}`)) continue;
    const withoutNumbers = value => value.replace(/[\d.,:%$€£¥]+/g, "#").replace(/\s+/g, " ").trim();
    const numericOnly = withoutNumbers(oldCore) === withoutNumbers(newCore);
    const promotional = /\b(?:sale|promo|discount|coupon|code|off|start now)\b|\$\d+\w*\s+for\s+only/i.test(`${diff.before} ${diff.after}`);
    changes.push({
      id: `${source.id}-${page.kind.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${checkedAt.slice(0, 10)}`,
      category: numericOnly ? "cosmetic" : promotional ? "pricing" : categoryFor(page.kind), importance: numericOnly ? "low" : promotional ? "medium" : ["Trading Rules", "Terms & Conditions", "Payout terms"].includes(page.kind) ? "high" : "medium",
      title: numericOnly ? `${page.kind} live counters changed` : promotional ? "Public promotional content changed" : `${page.kind} content changed`, before: diff.before || "Previous public content is no longer present.",
      after: diff.after || "New public content was added.",
      impact: "Review the official source page and assess whether the public offer, rules or customer communication changed.",
      substantive: !numericOnly, urls: [page.url],
    });
  }
  const ok = pages.filter(page => page.status === "ok").length;
  const failed = pages.length - ok;
  const hasPrevious = (oldFirm?.snapshots || []).some(page => page.status === "ok");
  const substantiveChanges = changes.filter(change => change.substantive !== false);
  const status = !ok ? "failed" : failed ? "partial" : !hasPrevious ? "baseline" : substantiveChanges.length ? "changed" : changes.length ? "cosmetic" : "unchanged";
  return {
    id: source.id, name: source.name, url: source.url, verified: true, enabled: true,
    lastCheckedAt: checkedAt, lastSuccessfulAt: ok ? checkedAt : oldFirm?.lastSuccessfulAt || null,
    lastStatus: status, pageCount: pages.length,
    lastSummary: status === "baseline" ? "Official-site baseline saved." : status === "changed" ? `${substantiveChanges.length} substantive public content change${substantiveChanges.length === 1 ? "" : "s"} detected.` : status === "cosmetic" ? "Only dynamic counters or cosmetic public content changed." : status === "unchanged" ? "No normalized public content change detected." : status === "partial" ? `${failed} page check${failed === 1 ? "" : "s"} failed; successful pages were retained.` : "Official website could not be read.",
    snapshots: pages, changes,
  };
}

const previousFirms = new Map((previous?.competitors || []).map(firm => [firm.id, firm]));
const inspected = [];
const queue = [...sourceDocument.sources];
const worker = async () => {
  while (queue.length) {
    const source = queue.shift();
    const firm = await inspectFirm(source, previousFirms.get(source.id));
    inspected.push(firm);
    console.log(`${firm.name}: ${firm.lastStatus}`);
  }
};
await Promise.all(Array.from({ length: 2 }, worker));
inspected.sort((a, b) => sourceDocument.sources.findIndex(item => item.id === a.id) - sourceDocument.sources.findIndex(item => item.id === b.id));

const runId = `official-${checkedAt.replace(/[:.]/g, "-")}`;
const checks = inspected.filter(firm => firm.verified).map(firm => ({
  id: `${runId}-${firm.id}`, runId, competitorId: firm.id, checkedAt,
  baselineAt: previousFirms.get(firm.id)?.lastSuccessfulAt || null, status: firm.lastStatus,
  summary: firm.lastSummary, reason: firm.lastStatus === "failed" || firm.lastStatus === "partial" ? firm.snapshots.filter(page => page.status !== "ok").map(page => `${page.kind}: ${page.summary}`).join("; ") : "",
  actionNeeded: firm.lastStatus === "failed" || firm.lastStatus === "partial" ? "Review the official site manually; failed pages did not replace the last successful baseline." : "",
  pages: firm.snapshots.map(page => {
    const record = { ...page, fingerprint: page.hash };
    delete record.text;
    delete record.hash;
    return record;
  }), changes: firm.changes,
}));
const run = {
  id: runId, startedAt: checkedAt, finishedAt: new Date().toISOString(), status: "completed", source: "Official public websites",
  checkedCount: checks.length, changedCount: checks.filter(item => item.status === "changed").length,
  unchangedCount: checks.filter(item => item.status === "unchanged").length,
  failedCount: checks.filter(item => ["failed", "partial"].includes(item.status)).length,
  baselineCount: checks.filter(item => item.status === "baseline").length,
  cosmeticCount: checks.reduce((total, item) => total + item.changes.filter(change => change.substantive === false).length, 0),
};
const reportDate = checkedAt.slice(0, 10);
const priorRuns = (previous?.runs || []).filter(item => String(item.startedAt || "").slice(0, 10) !== reportDate);
const priorChecks = (previous?.checks || []).filter(item => String(item.checkedAt || "").slice(0, 10) !== reportDate);
const output = {
  schemaVersion: 1, mode: "official-sites", generatedAt: checkedAt,
  schedule: { status: "active", timezone: "Europe/Kyiv", label: "Every day at 08:00" },
  competitors: inspected,
  runs: [run, ...priorRuns].slice(0, 31),
  checks: [...checks, ...priorChecks].slice(0, 1800),
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Saved ${checks.length} official-site checks to ${outputPath}`);
