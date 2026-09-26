import { NextRequest, NextResponse } from "next/server";
import {
  createAccount,
  createWebSession,
  isAccountConfigured,
  recordAuthEvent,
  recordLogin,
  PI_WEB_ACCOUNT_USERNAME,
} from "@/lib/auth-store";
import { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } from "@/lib/auth-throttle-store";
import { retryAfterSeconds } from "@/lib/auth-throttle";
import { getDatabase } from "@/lib/db";
import { clearSetupCode, getSetupCode, verifySetupCode } from "@/lib/init-setup";
import { checkPasswordStrength, PASSWORD_MIN_LENGTH, PASSWORD_PASSPHRASE_LENGTH } from "@/lib/password-policy";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled, PI_WEB_SESSION_COOKIE, PI_WEB_SESSION_MAX_AGE } from "@/lib/web-auth";

/**
 * First-run account creation.
 *
 * Reachable only while no account exists, and gated by the one-time setup code
 * from the server log (or `PI_WEB_INIT_TOKEN`). See `lib/init-setup.ts` for why
 * the code exists and why nothing short of it is accepted.
 */

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function requestContext(request: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return {
    ip: forwarded && forwarded.length > 0 ? forwarded.slice(0, 64) : null,
    userAgent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  };
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }

  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({
      required: false,
      reason: "environment",
      username: PI_WEB_ACCOUNT_USERNAME,
    });
  }

  const db = getDatabase();
  const configured = isAccountConfigured(db);
  if (!configured) {
    // Touch the generator so the code is in the log before the user is asked for it.
    getSetupCode();
  }

  return noStore({
    required: !configured,
    reason: configured ? "configured" : "first-run",
    username: PI_WEB_ACCOUNT_USERNAME,
    // Always required while first-run; the UI hides the field when it is false.
    setupCodeRequired: !configured,
    passwordPolicy: {
      minLength: PASSWORD_MIN_LENGTH,
      passphraseLength: PASSWORD_PASSPHRASE_LENGTH,
    },
    sessionMaxAgeSeconds: PI_WEB_SESSION_MAX_AGE,
  });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (!hasJsonContentType(request)) {
    return noStore({ error: "Content-Type must be application/json" }, 415);
  }

  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return noStore({ error: "environment_password", message: "Authentication is managed by PI_WEB_PASSWORD." }, 409);
  }

  const db = getDatabase();
  if (isAccountConfigured(db)) {
    return noStore({ error: "already_configured", loginUrl: "/login" }, 409);
  }

  const retryAfterMs = getAuthRetryAfterMs("init", db);
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

  const body = await request.json().catch(() => null) as
    | { password?: unknown; setupCode?: unknown }
    | null;
  const context = requestContext(request);

  // Rotate (and log) an expired code before comparing, so a submission that
  // arrives after the ten-minute window leaves a fresh code in the log instead
  // of only failing.
  getSetupCode();

  if (!verifySetupCode(body?.setupCode)) {
    const delayMs = recordAuthFailure("init", db);
    recordAuthEvent({
      kind: "setup",
      result: "fail",
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { reason: "invalid-setup-code" },
    }, db);
    return NextResponse.json(
      { error: "invalid_setup_code", retryAfterMs: delayMs, setupCodeRequired: true },
      { status: 401, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds(delayMs)) } },
    );
  }

  if (typeof body?.password !== "string") {
    return noStore({ error: "invalid_request", message: "A password is required." }, 400);
  }

  const strength = checkPasswordStrength(body.password, { username: PI_WEB_ACCOUNT_USERNAME });
  if (!strength.ok) {
    recordAuthEvent({
      kind: "setup",
      result: "fail",
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { reason: `weak-password:${strength.reason}` },
    }, db);
    return noStore({ error: "weak_password", reason: strength.reason }, 400);
  }

  await createAccount(body.password, { db });
  clearSetupCode();
  recordAuthSuccess("init", db);
  recordLogin(db);
  const session = createWebSession({
    db,
    authMethod: "password",
    ip: context.ip,
    userAgent: context.userAgent,
  });
  recordAuthEvent({
    kind: "setup",
    result: "ok",
    username: PI_WEB_ACCOUNT_USERNAME,
    ip: context.ip,
    userAgent: context.userAgent,
  }, db);

  const response = noStore({ ok: true, username: PI_WEB_ACCOUNT_USERNAME });
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
