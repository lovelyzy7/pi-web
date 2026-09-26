import { NextRequest, NextResponse } from "next/server";
import {
  createWebSession,
  isAccountConfigured,
  readAccount,
  readTotpState,
  recordAuthEvent,
  recordLogin,
  revokeWebSession,
  sessionIdForToken,
  validateWebSession,
  verifyAccountPassword,
  PI_WEB_ACCOUNT_USERNAME,
} from "@/lib/auth-store";
import { createAuthChallenge, verifyAuthChallenge } from "@/lib/auth-challenge";
import { verifyTotpForLogin } from "@/lib/totp-service";
import { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } from "@/lib/auth-throttle-store";
import { retryAfterSeconds } from "@/lib/auth-throttle";
import { getDatabase } from "@/lib/db";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createWebSessionToken,
  isValidBasicAuthorization,
  isValidWebPassword,
  isValidWebSessionToken,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE,
} from "@/lib/web-auth";

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

function tooManyAttempts(retryAfterMs: number): NextResponse {
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

function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
}

function setSessionCookie(response: NextResponse, request: Request, token: string): void {
  response.cookies.set({
    name: PI_WEB_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: PI_WEB_SESSION_MAX_AGE,
  });
}

function requestContext(request: Request): { ip: string | null; userAgent: string | null } {
  // Informational only: the value comes from a header the client can forge, so
  // it is displayed as a hint and never used for an access decision.
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return {
    ip: forwarded && forwarded.length > 0 ? forwarded.slice(0, 64) : null,
    userAgent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  };
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  const noStore = { headers: { "Cache-Control": "no-store" } };

  if (isWebPasswordEnabled(password)) {
    const authenticated = isValidBasicAuthorization(request.headers.get("authorization"), password)
      || isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password);
    return NextResponse.json(
      {
        enabled: true,
        configured: true,
        source: "environment",
        authenticated,
        username: PI_WEB_ACCOUNT_USERNAME,
      },
      noStore,
    );
  }

  const db = getDatabase();
  const account = readAccount(db);
  const configured = isAccountConfigured(db);
  const session = validateWebSession(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, {
    db,
    touch: false,
  });

  return NextResponse.json(
    {
      enabled: configured,
      configured,
      source: configured ? "account" : "none",
      authenticated: session.ok,
      username: account?.username ?? PI_WEB_ACCOUNT_USERNAME,
      displayName: account?.displayName ?? "",
      totpEnabled: readTotpState(db).enabled,
    },
    noStore,
  );
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const body = await request.json().catch(() => null) as { password?: unknown } | null;
  const password = process.env.PI_WEB_PASSWORD;

  if (isWebPasswordEnabled(password)) {
    const retryAfterMs = getAuthRetryAfterMs("login");
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);

    if (!body || typeof body.password !== "string" || !isValidWebPassword(body.password, password)) {
      const delayMs = recordAuthFailure("login");
      console.warn(`[web-auth] Password authentication failed; next attempt blocked for ${delayMs}ms`);
      return NextResponse.json(
        { error: "Invalid password", retryAfterMs: delayMs },
        { status: 401, headers: { "Retry-After": String(retryAfterSeconds(delayMs)) } },
      );
    }

    recordAuthSuccess("login");
    const response = NextResponse.json({ ok: true });
    setSessionCookie(response, request, createWebSessionToken(password));
    return response;
  }

  const db = getDatabase();
  if (!isAccountConfigured(db)) {
    return NextResponse.json(
      { error: "setup_required", initUrl: "/init" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }

  const context = requestContext(request);
  const account = readAccount(db);

  // Second step: a challenge proves the password has already been accepted, so
  // only the code (or a recovery code) has to be checked here.
  if (typeof (body as { challenge?: unknown } | null)?.challenge === "string") {
    const totpRetryAfterMs = getAuthRetryAfterMs("totp", db);
    if (totpRetryAfterMs > 0) return tooManyAttempts(totpRetryAfterMs);
    if (!verifyAuthChallenge((body as { challenge: string }).challenge, db)) {
      return NextResponse.json(
        { error: "challenge_expired", message: "Start over and enter the password again." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const code = typeof (body as { code?: unknown }).code === "string" ? (body as { code: string }).code : "";
    const verification = verifyTotpForLogin(code, db);
    if (!verification.ok) {
      const delayMs = recordAuthFailure("totp", db);
      recordAuthEvent({
        kind: "totp",
        result: "fail",
        username: account?.username ?? PI_WEB_ACCOUNT_USERNAME,
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { reason: verification.reason },
      }, db);
      return NextResponse.json(
        { error: "invalid_code", retryAfterMs: delayMs },
        { status: 401, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfterSeconds(delayMs)) } },
      );
    }

    recordAuthSuccess("totp", db);
    const totpSession = createWebSession({
      db,
      authMethod: verification.method === "recovery-code" ? "recovery_code" : "totp",
      ip: context.ip,
      userAgent: context.userAgent,
    });
    recordLogin(db);
    recordAuthEvent({
      kind: "totp",
      result: "ok",
      username: account?.username ?? PI_WEB_ACCOUNT_USERNAME,
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { method: verification.method, remainingRecoveryCodes: verification.remainingRecoveryCodes },
    }, db);

    const totpResponse = NextResponse.json({
      ok: true,
      method: verification.method,
      remainingRecoveryCodes: verification.remainingRecoveryCodes,
    });
    setSessionCookie(totpResponse, request, totpSession.token);
    return totpResponse;
  }

  const retryAfterMs = getAuthRetryAfterMs("login", db);
  if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);

  const suppliedPassword = typeof body?.password === "string" ? body.password : null;
  const accepted = suppliedPassword !== null && await verifyAccountPassword(suppliedPassword, db);

  if (!accepted) {
    const delayMs = recordAuthFailure("login", db);
    recordAuthEvent({
      kind: "login",
      result: "fail",
      username: readAccount(db)?.username ?? PI_WEB_ACCOUNT_USERNAME,
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { reason: "invalid-password" },
    }, db);
    console.warn(`[web-auth] Password authentication failed; next attempt blocked for ${delayMs}ms`);
    return NextResponse.json(
      { error: "Invalid password", retryAfterMs: delayMs },
      { status: 401, headers: { "Retry-After": String(retryAfterSeconds(delayMs)) } },
    );
  }

  recordAuthSuccess("login", db);

  if (readTotpState(db).enabled) {
    const challenge = createAuthChallenge(db);
    recordAuthEvent({
      kind: "login",
      result: "ok",
      username: account?.username ?? PI_WEB_ACCOUNT_USERNAME,
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { step: "password", totpRequired: true },
    }, db);
    if (!challenge) {
      return NextResponse.json(
        { error: "totp_unavailable", message: "The stored TOTP secret cannot be read." },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(
      { ok: false, totpRequired: true, challenge },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  recordLogin(db);
  const session = createWebSession({
    db,
    authMethod: "password",
    ip: context.ip,
    userAgent: context.userAgent,
  });
  recordAuthEvent({
    kind: "login",
    result: "ok",
    username: account?.username ?? PI_WEB_ACCOUNT_USERNAME,
    ip: context.ip,
    userAgent: context.userAgent,
  }, db);

  const response = NextResponse.json({ ok: true });
  setSessionCookie(response, request, session.token);
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const response = NextResponse.json({ ok: true });
  if (!isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
    if (token) {
      const db = getDatabase();
      revokeWebSession(sessionIdForToken(token), "logout", db);
      recordAuthEvent({ kind: "logout", result: "ok", ...requestContext(request) }, db);
    }
  }
  clearSessionCookie(response, request);
  return response;
}
