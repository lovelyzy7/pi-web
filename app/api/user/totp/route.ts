import { NextRequest, NextResponse } from "next/server";
import { readAccount, recordAuthEvent, revokeAllWebSessions, sessionIdForToken } from "@/lib/auth-store";
import { recordAuthSuccess } from "@/lib/auth-throttle-store";
import {
  confirmTotpEnrollment,
  readTotpSummary,
  regenerateRecoveryCodes,
  startTotpEnrollment,
  turnOffTotp,
} from "@/lib/totp-service";
import {
  noStore,
  requestContext,
  requireAccountMode,
  requireJsonBody,
  requirePassword,
} from "@/lib/user-api";
import { PI_WEB_SESSION_COOKIE } from "@/lib/web-auth";

export const dynamic = "force-dynamic";

/**
 * Two-factor authentication for the account page.
 *
 * GET    → current state (enabled / pending / recovery codes left)
 * POST   → start enrollment with a password, returning the secret and its QR
 * PUT    → confirm the enrollment with a code, returning recovery codes once
 * DELETE → switch the second factor off (password + code)
 */

export async function GET(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;

  return noStore({
    mode: "account",
    ...readTotpSummary(mode.db),
  });
}

export async function POST(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;
  const contentTypeError = requireJsonBody(request);
  if (contentTypeError) return contentTypeError;

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const passwordError = await requirePassword(body?.password, mode.db, {
    action: "totp-setup",
    request,
  });
  if (passwordError) return passwordError;

  const enrollment = await startTotpEnrollment(mode.db);
  if (!enrollment) return noStore({ error: "not_configured" }, 409);

  const context = requestContext(request);
  recordAuthEvent({
    kind: "totp",
    result: "ok",
    username: readAccount(mode.db)?.username ?? "pi",
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { action: "enrollment-started" },
  }, mode.db);

  return noStore({ ok: true, ...enrollment });
}

export async function PUT(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;
  const contentTypeError = requireJsonBody(request);
  if (contentTypeError) return contentTypeError;

  const body = await request.json().catch(() => null) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const result = confirmTotpEnrollment(code, mode.db);
  const context = requestContext(request);

  if (!result.ok) {
    recordAuthEvent({
      kind: "totp",
      result: "fail",
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { action: "enrollment-confirm", reason: result.reason },
    }, mode.db);
    return noStore({ error: result.reason ?? "invalid_code" }, 400);
  }

  // Sessions created before the second factor existed are weaker than the
  // account is now; sign the other devices out and keep this one.
  const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
  const signedOutSessions = revokeAllWebSessions("totp-enabled", {
    keepSessionId: token ? sessionIdForToken(token) : null,
    db: mode.db,
  });
  recordAuthSuccess("login", mode.db);
  recordAuthEvent({
    kind: "totp",
    result: "ok",
    username: readAccount(mode.db)?.username ?? "pi",
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { action: "enabled", signedOutSessions },
  }, mode.db);

  return noStore({
    ok: true,
    recoveryCodes: result.recoveryCodes,
    signedOutSessions,
  });
}

export async function DELETE(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;
  const contentTypeError = requireJsonBody(request);
  if (contentTypeError) return contentTypeError;

  const body = await request.json().catch(() => null) as
    | { password?: unknown; code?: unknown }
    | null;
  const passwordError = await requirePassword(body?.password, mode.db, {
    action: "totp-disable",
    request,
  });
  if (passwordError) return passwordError;

  const { verifyTotpForLogin } = await import("@/lib/totp-service");
  const verification = verifyTotpForLogin(
    typeof body?.code === "string" ? body.code : "",
    mode.db,
  );
  if (!verification.ok) {
    const context = requestContext(request);
    recordAuthEvent({
      kind: "totp",
      result: "fail",
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { action: "disable", reason: verification.reason },
    }, mode.db);
    return NextResponse.json(
      { error: "invalid_code" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  turnOffTotp(mode.db);
  const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
  const signedOutSessions = revokeAllWebSessions("totp-disabled", {
    keepSessionId: token ? sessionIdForToken(token) : null,
    db: mode.db,
  });
  const context = requestContext(request);
  recordAuthEvent({
    kind: "totp",
    result: "ok",
    username: readAccount(mode.db)?.username ?? "pi",
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { action: "disabled", signedOutSessions },
  }, mode.db);

  return noStore({ ok: true, signedOutSessions });
}

/** Regenerates the recovery-code set; the previous codes stop working at once. */
export async function PATCH(request: NextRequest) {
  const mode = requireAccountMode(request);
  if (!mode.ok) return mode.response;
  const contentTypeError = requireJsonBody(request);
  if (contentTypeError) return contentTypeError;

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const passwordError = await requirePassword(body?.password, mode.db, {
    action: "recovery-codes",
    request,
  });
  if (passwordError) return passwordError;

  const codes = regenerateRecoveryCodes(mode.db);
  if (!codes) return noStore({ error: "totp_not_enabled" }, 409);

  const context = requestContext(request);
  recordAuthEvent({
    kind: "totp",
    result: "ok",
    username: readAccount(mode.db)?.username ?? "pi",
    ip: context.ip,
    userAgent: context.userAgent,
    detail: { action: "recovery-codes-regenerated" },
  }, mode.db);

  return noStore({ ok: true, recoveryCodes: codes });
}
