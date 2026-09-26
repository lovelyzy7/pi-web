import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { deploymentInfo } from "@/lib/app-update-service";
import { getPiAgentStatus, installPiCli, PI_PACKAGE } from "@/lib/pi-agent";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * The pi agent: the runtime SDK sessions use, and the `pi` CLI on this server.
 *
 * GET           → versions, where the CLI lives, and what a Docker host has to
 *                 run by itself (`?check=1` forces a fresh "latest" lookup)
 * POST          → { action: "install" | "update" } installs/updates the CLI
 *                 into the data directory (~/.pi/agent/pi-cli), which is the
 *                 mounted volume in a Docker deployment and the host itself in
 *                 every other one.
 *
 * The runtime SDK is deliberately not swapped from here: it updates together
 * with the application (see the app update section).
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }

  const status = await getPiAgentStatus({
    forceLatest: request.nextUrl.searchParams.get("check") === "1",
    db: getDatabase(),
  });
  const deployment = deploymentInfo();
  return noStore({
    ...status,
    deployment: { mode: deployment.mode },
    hostCommand: deployment.mode === "docker" ? `npm install -g ${PI_PACKAGE}@latest` : null,
  });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (!hasJsonContentType(request)) {
    return noStore({ error: "Content-Type must be application/json" }, 415);
  }

  const body = await request.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== "install" && body?.action !== "update") {
    return noStore({ error: "unknown_action", message: 'Use "install" or "update".' }, 400);
  }

  const result = await installPiCli({});
  if (!result.ok) {
    return noStore({ error: "install_failed", message: result.message }, 500);
  }
  return noStore({ ok: true, path: result.path, version: result.version });
}
