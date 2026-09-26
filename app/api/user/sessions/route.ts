import { NextRequest } from "next/server";
import {
  isAccountConfigured,
  listWebSessions,
  recordAuthEvent,
  revokeAllWebSessions,
  sessionIdForToken,
} from "@/lib/auth-store";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled, PI_WEB_SESSION_COOKIE } from "@/lib/web-auth";
import { noStore, requestContext } from "@/lib/user-api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({ mode: "environment", sessions: [] });
  }

  const db = getDatabase();
  if (!isAccountConfigured(db)) {
    return noStore({ error: "setup_required", initUrl: "/init" }, 409);
  }

  const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
  const currentSessionId = token ? sessionIdForToken(token) : null;
  return noStore({
    mode: "account",
    sessions: listWebSessions({ currentSessionId, db }).map((session) => ({
      id: session.id,
      current: session.current,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      authMethod: session.authMethod,
      ip: session.ip,
      userAgent: session.userAgent,
    })),
  });
}

/** Signs every other device out, keeping this browser signed in. */
export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({ error: "environment_password" }, 409);
  }

  const db = getDatabase();
  if (!isAccountConfigured(db)) {
    return noStore({ error: "setup_required", initUrl: "/init" }, 409);
  }

  const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
  const currentSessionId = token ? sessionIdForToken(token) : null;
  const revoked = revokeAllWebSessions("signed-out-elsewhere", { keepSessionId: currentSessionId, db });
  recordAuthEvent({
    kind: "logout",
    result: "ok",
    ip: requestContext(request).ip,
    userAgent: requestContext(request).userAgent,
    detail: { scope: "all-other-devices", revoked },
  }, db);

  return noStore({ ok: true, revoked });
}
