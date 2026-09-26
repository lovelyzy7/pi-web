import { NextRequest } from "next/server";
import {
  isAccountConfigured,
  listWebSessions,
  recordAuthEvent,
  revokeWebSession,
  sessionIdForToken,
} from "@/lib/auth-store";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled, PI_WEB_SESSION_COOKIE } from "@/lib/web-auth";
import { noStore } from "@/lib/user-api";

export const dynamic = "force-dynamic";

/** Signs one device out. Revoking the caller's own session is allowed. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const { id } = await params;
  if (!/^[a-f0-9]{64}$/.test(id)) {
    return noStore({ error: "invalid_session_id" }, 400);
  }

  const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
  const currentSessionId = token ? sessionIdForToken(token) : null;
  const known = listWebSessions({ db, includeInactive: true, currentSessionId })
    .some((session) => session.id === id);
  if (!known) return noStore({ error: "unknown_session" }, 404);

  revokeWebSession(id, "signed-out-by-user", db);
  recordAuthEvent({
    kind: "logout",
    result: "ok",
    detail: { sessionId: id, self: id === currentSessionId },
  }, db);

  return noStore({ ok: true, self: id === currentSessionId });
}
