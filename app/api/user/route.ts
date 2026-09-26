import { NextRequest } from "next/server";
import { isAccountConfigured, readAccount, validateWebSession } from "@/lib/auth-store";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { idleSessionTtlMs } from "@/lib/auth-store";
import { isWebPasswordEnabled, PI_WEB_SESSION_COOKIE } from "@/lib/web-auth";
import { noStore } from "@/lib/user-api";

export const dynamic = "force-dynamic";

/**
 * The account overview behind the /user page.
 *
 * In environment-password mode there is no account row, so this reports the
 * mode and leaves everything else to the environment.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }

  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({
      mode: "environment",
      username: "pi",
      displayName: "",
      configured: true,
      session: null,
    });
  }

  const db = getDatabase();
  const account = readAccount(db);
  if (!isAccountConfigured(db) || !account) {
    return noStore({ error: "setup_required", initUrl: "/init" }, 409);
  }

  const session = validateWebSession(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, {
    db,
    touch: false,
  });

  return noStore({
    mode: "account",
    username: account.username,
    displayName: account.displayName,
    configured: true,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    passwordChangedAt: account.passwordChangedAt,
    lastLoginAt: account.lastLoginAt,
    totpEnabled: account.totpEnabled,
    sessionMaxAgeMs: idleSessionTtlMs(),
    session: session.ok && session.session
      ? {
          id: session.session.id,
          createdAt: session.session.createdAt,
          lastSeenAt: session.session.lastSeenAt,
          expiresAt: session.session.expiresAt,
          absoluteExpiresAt: session.session.absoluteExpiresAt,
          authMethod: session.session.authMethod,
          ip: session.session.ip,
          userAgent: session.session.userAgent,
        }
      : null,
  });
}
