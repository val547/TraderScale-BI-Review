import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { affiliateSnapshotDiagnostics, buildSnapshot } from "../../../../lib/bi-snapshot";

export const dynamic = "force-dynamic";

let cachedSnapshot: { expiresAt: number; value: unknown } | null = null;

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "private, max-age=0, s-maxage=300",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request) {
  const requestHeaders = await headers();
  if (!requestHeaders.get("oai-authenticated-user-id")) {
    return json({ error: "Authentication required." }, 401);
  }
  try {
    if (!cachedSnapshot || cachedSnapshot.expiresAt <= Date.now()) {
      const value = await buildSnapshot(env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "");
      cachedSnapshot = { expiresAt: Date.now() + 5 * 60 * 1000, value };
    }
    return json(new URL(request.url).searchParams.get("view") === "affiliate-diagnostics"
      ? affiliateSnapshotDiagnostics(cachedSnapshot.value)
      : cachedSnapshot.value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    console.error("BI snapshot failed", detail);
    return json({ error: "Production data is temporarily unavailable.", detail }, 503);
  }
}
