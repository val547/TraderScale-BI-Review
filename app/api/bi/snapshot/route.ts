import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { affiliateSnapshotDiagnostics, buildSnapshot, snapshotView } from "../../../../lib/bi-snapshot";

export const dynamic = "force-dynamic";

let cachedSnapshot: { expiresAt: number; generatedAt: number; revision: string; value: unknown } | null = null;

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
      const generatedAt = Date.now();
      cachedSnapshot = { expiresAt: generatedAt + 24 * 60 * 60 * 1000, generatedAt, revision: `daily-${generatedAt}`, value };
    }
    const view = new URL(request.url).searchParams.get("view");
    if (view === "meta") {
      const value = cachedSnapshot.value as { schemaVersion?: number; mode?: string; asOf?: string; currency?: string; quality?: unknown };
      return json({ schemaVersion: value.schemaVersion, mode: value.mode, asOf: value.asOf, currency: value.currency,
        quality: value.quality, revision: cachedSnapshot.revision, generatedAt: new Date(cachedSnapshot.generatedAt).toISOString(), refreshCadence: "daily" });
    }
    return json(view === "affiliate-diagnostics" ? affiliateSnapshotDiagnostics(cachedSnapshot.value) : snapshotView(cachedSnapshot.value, view));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    console.error("BI snapshot failed", detail);
    return json({ error: "Production data is temporarily unavailable.", detail }, 503);
  }
}
