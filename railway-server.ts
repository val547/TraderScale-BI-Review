import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "./lib/bi-snapshot.ts";

const port = Number(process.env.PORT || 3000);
const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const accessEmail = (process.env.BI_ACCESS_EMAIL || "").trim().toLowerCase();
const accessPassword = process.env.BI_ACCESS_PASSWORD || "";
const googleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const googleClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const appBaseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
const allowedGoogleEmails = (process.env.BI_ALLOWED_GOOGLE_EMAILS || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const googleOAuthConfigured = Boolean(googleClientId && googleClientSecret && appBaseUrl);
const dashboardRoot = fileURLToPath(new URL("./public/dashboard/", import.meta.url));
const sessionValue = createHash("sha256").update(`traderscale-bi:${accessEmail}:${accessPassword}`).digest("hex");
const cookieName = "traderscale_bi_session";
const oauthStateCookie = "traderscale_google_oauth_state";
let snapshotCache: { expiresAt: number; value: unknown } | null = null;

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
    send(response, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
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
      login_hint: accessEmail,
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

  if (url.pathname === "/api/bi/snapshot" && request.method === "GET") {
    try {
      if (!snapshotCache || snapshotCache.expiresAt <= Date.now()) {
        snapshotCache = { expiresAt: Date.now() + 300_000, value: await buildSnapshot(serviceAccountJson) };
      }
      response.writeHead(200, { ...securityHeaders(), "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=0" });
      response.end(JSON.stringify(snapshotCache.value));
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
  response.writeHead(200, {
    ...securityHeaders(),
    "content-type": mimeTypes[extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-store" : "private, max-age=300",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`TraderScale BI listening on port ${port}`);
});
