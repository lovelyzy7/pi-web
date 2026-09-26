import { NextRequest, NextResponse } from "next/server";
import {
  changeAccountPassword,
  createWebSession,
  isAccountConfigured,
  readAccount,
  recordAuthEvent,
  revokeAllWebSessions,
  PI_WEB_ACCOUNT_USERNAME,
} from "@/lib/auth-store";
import { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } from "@/lib/auth-throttle-store";
import { retryAfterSeconds } from "@/lib/auth-throttle";
import { getDatabase } from "@/lib/db";
import { checkPasswordStrength } from "@/lib/password-policy";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled, PI_WEB_SESSION_COOKIE, PI_WEB_SESSION_MAX_AGE } from "@/lib/web-auth";
import { noStore, requestContext, isSecureRequest } from "@/lib/user-api";

export const dynamic = "force-dynamic";

/**
 * Changes the account password.
 *
 * A wrong current password shares the login throttle: this endpoint verifies the
 * same secret, so leaving it unmetered would be a way around the login limit.
 * On success every session — including this one — is revoked by the epoch bump
 * inside `changeAccountPassword`, and this browser is handed a fresh session.
 */
export async function PUT(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (!hasJsonContentType(request)) {
    return noStore({ error: "Content-Type must be application/json" }, 415);
  }
  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({
      error: "environment_password",
      message: "The password is managed by PI_WEB_PASSWORD and cannot be changed here.",
    }, 409);
  }

  const db = getDatabase();
  if (!isAccountConfigured(db)) {
    return noStore({ error: "setup_required", initUrl: "/init" }, 409);
  }

  const body = await request.json().catch(() => null) as
    | { currentPassword?: unknown; newPassword?: unknown }
    | null;
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  const context = requestContext(request);

  // Policy first: it is cheap and rejects before any scrypt work happens.
  const strength = checkPasswordStrength(newPassword, { username: PI_WEB_ACCOUNT_USERNAME });
  if (!strength.ok) {
    return noStore({ error: "weak_password", reason: strength.reason }, 400);
  }

  const retryAfterMs = getAuthRetryAfterMs("login", db);
  if (retryAfterMs > 0) {
    return NextResponse.json(
      { error: "Too many failed attempts", retryAfterMs },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(retryAfterSeconds(retryAfterMs)),
        },
      },
    );
  }

  const result = await changeAccountPassword(currentPassword, newPassword, db);
  if (!result.ok) {
    if (result.reason === "invalid-password") {
      const delayMs = recordAuthFailure("login", db);
      recordAuthEvent({
        kind: "password",
        result: "fail",
        username: readAccount(db)?.username ?? PI_WEB_ACCOUNT_USERNAME,
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { reason: "invalid-password" },
      }, db);
      return NextResponse.json(
        { error: "invalid_password", retryAfterMs: delayMs },
        { status: 401, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds(delayMs)) } },
      );
    }
    return noStore({ error: result.reason ?? "failed" }, 400);
  }

  recordAuthSuccess("login", db);
  const signedOutSessions = revokeAllWebSessions("password-change", { db });
  const session = createWebSession({
    db,
    authMethod: "password",
    ip: context.ip,
    userAgent: context.userAgent,
  });
  recordAuthEvent({
    kind: "password",
    result: "ok",
    username: readAccount(db)?.username ?? PI_WEB_ACCOUNT_USERNAME,
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { signedOutSessions },
  }, db);

  const response = noStore({ ok: true, signedOutSessions });
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: session.token,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
  return response;
}
