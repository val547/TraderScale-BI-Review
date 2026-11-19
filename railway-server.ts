import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { brotliCompressSync, constants as zlibConstants, createGzip, gzipSync } from "node:zlib";
import { affiliateSnapshotDiagnostics, buildSnapshot, snapshotView } from "./lib/bi-snapshot.ts";

const port = Number(process.env.PORT || 3000);
const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const accessEmail = (process.env.BI_ACCESS_EMAIL || "").trim().toLowerCase();
const accessPassword = process.env.BI_ACCESS_PASSWORD || "";
const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const releaseId = process.env.RAILWAY_GIT_COMMIT_SHA || "local";
const allowedGoogleEmails = (process.env.BI_ALLOWED_GOOGLE_EMAILS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const googleOAuthConfigured = Boolean(googleClientId && googleClientSecret && appBaseUrl);
const dashboardRoot = fileURLToPath(new URL("./public/dashboard/", import.meta.url));
const sessionValue = createHash("sha256").update(`traderscale-bi:${accessEmail}:${accessPassword}`).digest("hex");
const cookieName = "traderscale_bi_session";
const oauthStateCookie = "traderscale_google_oauth_state";
const snapshotFreshMs = 24 * 60 * 60_000;
const snapshotStaleMs = 7 * 24 * 60 * 60_000;
type SnapshotCache = {
  freshUntil: number;
  staleUntil: number;
  generatedAt: number;
  value: unknown;
  gzip: Buffer;
  etag: string;
  brotli: Buffer;
  variants: Map<string, { value: unknown; gzip: Buffer; brotli: Buffer; etag: string }>;
};
let snapshotCache: SnapshotCache | null = null;
let snapshotRefresh: Promise<SnapshotCache> | null = null;
let snapshotWarmupError = "";
let lastClientPerformance: Record<string, number | string> | null = null;
const snapshotWarmupStartedAt = Date.now();

if (!serviceAccountJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is required.");
if (!/^\S+@\S+\.\S+$/.test(accessEmail)) throw new Error("BI_ACCESS_EMAIL must be a valid email address.");
if (accessPassword.length < 16) throw new Error("BI_ACCESS_PASSWORD must contain at least 16 characters.");
if ((googleClientId || googleClientSecret || appBaseUrl) && !googleOAuthConfigured) {
  throw new Error("GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and APP_BASE_URL must be configured together.");
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function securityHeaders() {
  return {
    "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function send(response: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { ...securityHeaders(), "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function refreshSnapshot() {
  if (snapshotRefresh) return snapshotRefresh;
  snapshotRefresh = (async () => {
    const value = await buildSnapshot(serviceAccountJson);
    const generatedAt = Date.now();
    const gzip = gzipSync(JSON.stringify(value), { level: 6 });
    const brotli = brotliCompressSync(JSON.stringify(value), {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
    });
    const variants = new Map<string, { value: unknown; gzip: Buffer; brotli: Buffer; etag: string }>();
    for (const view of [
      "core", "marketing", "rebuy", "accounts", "payouts", "orders", "profitability",
      "affiliates", "affiliatePnl", "customers", "withdrawable", "riskFindings",
    ]) {
      const variantValue = snapshotView(value, view);
      const serialized = JSON.stringify(variantValue);
      const variantGzip = gzipSync(serialized, { level: 6 });
      const variantBrotli = brotliCompressSync(serialized, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
      });
      variants.set(view, {
        value: variantValue,
        gzip: variantGzip,
        brotli: variantBrotli,
        etag: `"${createHash("sha256").update(variantGzip).digest("base64url")}"`,
      });
    }
    const cache = {
      freshUntil: generatedAt + snapshotFreshMs,
      staleUntil: generatedAt + snapshotStaleMs,
      generatedAt,
      value,
      gzip,
      brotli,
      etag: `"${createHash("sha256").update(gzip).digest("base64url")}"`,
      variants,
    } satisfies SnapshotCache;
    snapshotCache = cache;
    return cache;
  })().finally(() => {
    snapshotRefresh = null;
  });
  return snapshotRefresh;
}

async function currentSnapshot() {
  const now = Date.now();
  if (snapshotCache && snapshotCache.freshUntil > now) return snapshotCache;
  if (snapshotCache && snapshotCache.staleUntil > now) {
    void refreshSnapshot().catch((error) => {
      console.error("Background BI snapshot refresh failed", error instanceof Error ? error.message : "Unknown error");
    });
    return snapshotCache;
  }
  return refreshSnapshot();
}

function warmSnapshotUntilReady() {
  void refreshSnapshot().then(() => {
    snapshotWarmupError = "";
  }).catch((error) => {
    snapshotWarmupError = error instanceof Error ? error.message : "Unknown error";
    console.error("Initial BI snapshot warmup failed", snapshotWarmupError);
    setTimeout(warmSnapshotUntilReady, 15_000);
  });
}

function sendSnapshot(request: IncomingMessage, response: ServerResponse, cache: SnapshotCache, view: string | null = null) {
  var value = cache.value;
  var gzip = cache.gzip;
  var brotli = cache.brotli;
  var etag = cache.etag;
  if (view && view !== "full") {
    var variant = cache.variants.get(view);
    if (!variant) {
      value = snapshotView(cache.value, view);
      gzip = gzipSync(JSON.stringify(value), { level: 6 });
      brotli = brotliCompressSync(JSON.stringify(value), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
      });
      etag = `"${createHash("sha256").update(gzip).digest("base64url")}"`;
      variant = { value, gzip, brotli, etag };
      cache.variants.set(view, variant);
    }
    value = variant.value;
    gzip = variant.gzip;
    brotli = variant.brotli;
    etag = variant.etag;
  }
  const commonHeaders = {
    ...securityHeaders(),
    "content-type": "application/json; charset=utf-8",
    // The warehouse result is still generated once per day in memory, but the
    // browser must revalidate its ETag so a deployment cannot keep an older
    // snapshot schema or attribution mapping for another 24 hours.
    // The warehouse refresh cadence is daily. Keep an authenticated browser
    // copy hot for one hour and allow it to be shown immediately while a new
    // deployment or daily refresh revalidates in the background.
    "cache-control": "private, max-age=3600, stale-while-revalidate=86400, stale-if-error=604800",
    etag,
    vary: "accept-encoding",
    "x-snapshot-age": String(Math.max(0, Math.floor((Date.now() - cache.generatedAt) / 1000))),
  };
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, commonHeaders);
    response.end();
    return;
  }
  const acceptedEncoding = String(request.headers["accept-encoding"] || "");
  if (acceptedEncoding.includes("br")) {
    response.writeHead(200, {
      ...commonHeaders,
      "content-encoding": "br",
      "content-length": String(brotli.byteLength),
    });
    response.end(brotli);
    return;
  }
  if (acceptedEncoding.includes("gzip")) {
    response.writeHead(200, {
      ...commonHeaders,
      "content-encoding": "gzip",
      "content-length": String(gzip.byteLength),
    });
    response.end(gzip);
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(200, { ...commonHeaders, "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}

function cookies(request: IncomingMessage) {
  return Object.fromEntries((request.headers.cookie || "").split(";").map((item) => {
    const [key, ...rest] = item.trim().split("=");
    return [key, decodeURIComponent(rest.join("="))];
  }).filter(([key]) => key));
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticated(request: IncomingMessage) {
  return safeEqual(cookies(request)[cookieName] || "", sessionValue);
}

function googleEmailAllowed(email: string) {
  if (safeEqual(email, accessEmail)) return true;
  return allowedGoogleEmails.some((allowed) => safeEqual(email, allowed));
}

function loginPage(message = "") {
  const note = message ? `<p class="error">${message}</p>` : "";
  const googleButton = googleOAuthConfigured
    ? '<a class="google" href="/auth/google"><span>G</span> Continue with Google</a><div class="divider"><span>or</span></div>'
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TraderScale BI</title><style>body{margin:0;background:#f4f7fa;color:#1c2a38;font:14px Inter,Arial,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(360px,calc(100vw - 40px));background:#fff;border:1px solid #dfe7ee;border-radius:12px;padding:30px;box-shadow:0 18px 50px #28435d14}h1{font-size:22px;margin:0 0 8px}p{color:#6b7c8c;line-height:1.5}.error{color:#b42318}label{display:block;font-size:12px;font-weight:600;margin:18px 0 7px}input{box-sizing:border-box;width:100%;height:42px;border:1px solid #cbd6df;border-radius:7px;padding:0 12px}button,.google{box-sizing:border-box;width:100%;height:42px;margin-top:18px;border:0;border-radius:7px;background:#162f46;color:#fff;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;text-decoration:none}.google{background:#fff;color:#334155;border:1px solid #cbd6df}.google span{font-size:18px;color:#4285f4;margin-right:10px}.divider{display:flex;align-items:center;gap:10px;color:#94a3b8;font-size:11px;margin:18px 0 0}.divider:before,.divider:after{content:"";height:1px;background:#e2e8f0;flex:1}</style></head><body><form class="card" method="post" action="/login"><h1>TraderScale BI</h1><p>Sign in with your authorised TraderScale work email.</p>${note}${googleButton}<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in</button></form></body></html>`;
}

function googleRedirectUri() {
  return `${appBaseUrl}/auth/google/callback`;
}

async function googleIdentity(code: string) {
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenResponse.json() as { id_token?: string; error_description?: string };
  if (!tokenResponse.ok || !tokens.id_token) throw new Error(tokens.error_description || "Google token exchange failed.");
  const identityResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`);
  const identity = await identityResponse.json() as { aud?: string; email?: string; email_verified?: string };
  if (!identityResponse.ok || identity.aud !== googleClientId || identity.email_verified !== "true") {
    throw new Error("Google identity verification failed.");
  }
  return (identity.email || "").trim().toLowerCase();
}

async function readBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error("Request body too large.");
  }
  return body;
}

function staticPath(pathname: string) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/dashboard\/?/, "").replace(/^\//, "");
  const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(dashboardRoot, safe);
  return full.startsWith(dashboardRoot) ? full : "";
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    const ready = Boolean(snapshotCache);
    send(response, ready ? 200 : 503, JSON.stringify({
      ok: ready,
      status: ready ? "ready" : "warming",
      warmupSeconds: Math.max(0, Math.floor((Date.now() - snapshotWarmupStartedAt) / 1000)),
      retrying: Boolean(snapshotWarmupError),
      release: releaseId,
      coreBytes: snapshotCache?.variants.get("core")?.gzip.byteLength ?? 0,
      coreBrotliBytes: snapshotCache?.variants.get("core")?.brotli.byteLength ?? 0,
      fullBytes: snapshotCache?.gzip.byteLength ?? 0,
      datasetBytes: Object.fromEntries([
        "accounts", "payouts", "orders", "profitability", "affiliates", "affiliatePnl",
        "customers", "marketing", "withdrawable", "riskFindings", "rebuy",
      ].map((view) => [view, snapshotCache?.variants.get(view)?.gzip.byteLength ?? 0])),
      clientPerformance: lastClientPerformance,
    }), "application/json; charset=utf-8");
    return;
  }

  if (url.pathname === "/login" && request.method === "GET") {
    send(response, 200, loginPage(), "text/html; charset=utf-8");
    return;
  }

  if (url.pathname === "/auth/google" && request.method === "GET" && googleOAuthConfigured) {
    const state = randomBytes(24).toString("hex");
    const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorize.search = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: googleRedirectUri(),
      response_type: "code",
      scope: "openid email profile",
      state,
      hl: "en",
      prompt: "select_account",
    }).toString();
    response.writeHead(303, {
      ...securityHeaders(),
      location: authorize.toString(),
      "set-cookie": `${oauthStateCookie}=${state}; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    });
    response.end();
    return;
  }

  if (url.pathname === "/auth/google/callback" && request.method === "GET" && googleOAuthConfigured) {
    const expectedState = cookies(request)[oauthStateCookie] || "";
    const returnedState = url.searchParams.get("state") || "";
    const code = url.searchParams.get("code") || "";
    try {
      if (!expectedState || !safeEqual(expectedState, returnedState) || !code) throw new Error("Invalid Google OAuth callback.");
      const email = await googleIdentity(code);
      if (!googleEmailAllowed(email)) {
        send(response, 403, loginPage("This work email is not on the access list."), "text/html; charset=utf-8");
        return;
      }
      response.writeHead(303, {
        ...securityHeaders(),
        location: "/",
        "set-cookie": [
          `${cookieName}=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
          `${oauthStateCookie}=; Path=/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        ],
      });
      response.end();
    } catch (error) {
      console.error("Google login failed", error instanceof Error ? error.message : "Unknown error");
      send(response, 401, loginPage("Google sign-in failed. Please try again."), "text/html; charset=utf-8");
    }
    return;
  }

  if (url.pathname === "/login" && request.method === "POST") {
    const form = new URLSearchParams(await readBody(request));
    const email = (form.get("email") || "").trim().toLowerCase();
    if (!safeEqual(email, accessEmail) || !safeEqual(form.get("password") || "", accessPassword)) {
      send(response, 401, loginPage("Incorrect email or password."), "text/html; charset=utf-8");
      return;
    }
    response.writeHead(303, {
      ...securityHeaders(),
      location: "/",
      "set-cookie": `${cookieName}=${sessionValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
    });
    response.end();
    return;
  }

  if (!authenticated(request)) {
    if (url.pathname.startsWith("/api/")) {
      send(response, 401, JSON.stringify({ error: "Authentication required." }), "application/json; charset=utf-8");
    } else {
      response.writeHead(303, { ...securityHeaders(), location: "/login" });
      response.end();
    }
    return;
  }

  if (url.pathname === "/api/performance" && request.method === "POST") {
    try {
      const input = JSON.parse(await readBody(request)) as Record<string, unknown>;
      const metric = (key: string) => Math.max(0, Math.min(300_000, Number(input[key]) || 0));
      lastClientPerformance = {
        release: releaseId,
        recordedAt: new Date().toISOString(),
        transport: input.transport === "partitioned" ? "partitioned" : "fallback",
        bootToSnapshotMs: metric("bootToSnapshotMs"),
        applyMs: metric("applyMs"),
        firstRenderMs: metric("firstRenderMs"),
        totalMs: metric("totalMs"),
      };
      send(response, 204, "");
    } catch {
      send(response, 400, JSON.stringify({ error: "Invalid performance sample." }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname === "/api/bi/snapshot" && request.method === "GET") {
    try {
      const cache = await currentSnapshot();
      if (url.searchParams.get("view") === "meta") {
        const value = cache.value as { schemaVersion?: number; mode?: string; asOf?: string; currency?: string; quality?: unknown };
        send(response, 200, JSON.stringify({
          schemaVersion: value.schemaVersion,
          mode: value.mode,
          asOf: value.asOf,
          currency: value.currency,
          quality: value.quality,
          revision: cache.etag,
          generatedAt: new Date(cache.generatedAt).toISOString(),
          refreshCadence: "daily",
        }), "application/json; charset=utf-8");
      } else if (url.searchParams.get("view") === "affiliate-diagnostics") {
        send(response, 200, JSON.stringify(affiliateSnapshotDiagnostics(cache.value)), "application/json; charset=utf-8");
      } else {
        sendSnapshot(request, response, cache, url.searchParams.get("view"));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown error";
      console.error("BI snapshot failed", detail);
      send(response, 503, JSON.stringify({ error: "Production data is temporarily unavailable.", detail }), "application/json; charset=utf-8");
    }
    return;
  }

  const file = staticPath(url.pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    send(response, 404, "Not found");
    return;
  }
  const extension = extname(file).toLowerCase();
  const compressible = new Set([".css", ".html", ".js", ".json", ".svg"]).has(extension);
  const useGzip = compressible && String(request.headers["accept-encoding"] || "").includes("gzip");
  response.writeHead(200, {
    ...securityHeaders(),
    "content-type": mimeTypes[extension] || "application/octet-stream",
    "cache-control": file.endsWith("index.html") || file.endsWith("production-connector.js")
      ? "no-store"
      : "private, max-age=300",
    ...(useGzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
  });
  if (useGzip) {
    try {
      await pipeline(createReadStream(file), createGzip({ level: 6 }), response);
    } catch (error) {
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    }
  } else {
    createReadStream(file).pipe(response);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`TraderScale BI listening on port ${port}`);
  warmSnapshotUntilReady();
});
