import { NextRequest } from "next/server";
import { isAccountConfigured, listAuthEvents, pruneAuthEvents } from "@/lib/auth-store";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled } from "@/lib/web-auth";
import { noStore } from "@/lib/user-api";

export const dynamic = "force-dynamic";

const ALLOWED_KINDS = new Set(["setup", "login", "logout", "password", "totp", "token", "throttle"]);

function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({ mode: "environment", events: [] });
  }

  const db = getDatabase();
  if (!isAccountConfigured(db)) {
    return noStore({ error: "setup_required", initUrl: "/init" }, 409);
  }

  const limit = parseInteger(request.nextUrl.searchParams.get("limit"), 50, 1, 200);
  const offset = parseInteger(request.nextUrl.searchParams.get("offset"), 0, 0, 100_000);
  const rawKind = request.nextUrl.searchParams.get("kind");
  const kind = rawKind && ALLOWED_KINDS.has(rawKind) ? rawKind : undefined;

  // Housekeeping rides along with reads: the audit log is bounded, and this is
  // the only route that can see it grow.
  pruneAuthEvents(db);

  return noStore({
    mode: "account",
    events: listAuthEvents({ limit, offset, kind }, db),
  });
}
