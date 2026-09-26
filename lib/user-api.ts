import { NextResponse } from "next/server";
import {
  isAccountConfigured,
  readAccount,
  recordAuthEvent,
  verifyAccountPassword,
  PI_WEB_ACCOUNT_USERNAME,
} from "./auth-store";
import { getAuthRetryAfterMs, recordAuthFailure } from "./auth-throttle-store";
import { retryAfterSeconds } from "./auth-throttle";
import { getDatabase, type PiWebDatabase } from "./db";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";
import { isWebPasswordEnabled } from "./web-auth";

/**
 * Shared plumbing for the account routes (`/api/user/*`).
 *
 * Every one of them is reachable only in account mode, over a trusted host, and
 * security-sensitive writes confirm the password first. Keeping that here means
 * a new route cannot forget one of the three.
 */

export function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function tooManyAttempts(retryAfterMs: number): NextResponse {
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

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

/** IP and user agent for the audit log; the IP is a hint, never a decision. */
export function requestContext(request: Request): { ip: string | null; userAgent: string | null } {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  return {
    ip: forwarded && forwarded.length > 0 ? forwarded.slice(0, 64) : null,
    userAgent: request.headers.get("user-agent")?.slice(0, 256) ?? null,
  };
}

export type AccountModeResult =
  | { ok: true; db: PiWebDatabase }
  | { ok: false; response: NextResponse };

/** Untrusted host → 403, environment password → 409, no account → 409. */
export function requireAccountMode(request: Request): AccountModeResult {
  if (!isApiRequestAllowed(request)) {
    return { ok: false, response: noStore({ error: "Untrusted API request" }, 403) };
  }
  if (isWebPasswordEnabled(process.env.PI_WEB_PASSWORD)) {
    return {
      ok: false,
      response: noStore({
        error: "environment_password",
        message: "This installation authenticates with PI_WEB_PASSWORD; account settings are unavailable.",
      }, 409),
    };
  }

  const db = getDatabase();
  if (!isAccountConfigured(db)) {
    return { ok: false, response: noStore({ error: "setup_required", initUrl: "/init" }, 409) };
  }
  return { ok: true, db };
}

export function requireJsonBody(request: Request): NextResponse | null {
  return hasJsonContentType(request)
    ? null
    : noStore({ error: "Content-Type must be application/json" }, 415);
}

export function unauthorized(message = "Authentication required"): NextResponse {
  return NextResponse.json(
    { error: "unauthorized", message },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    },
  );
}

/**
 * Confirms the current password before a security-sensitive change.
 *
 * Shares the `login` throttle with sign-in: this is the same secret, so leaving
 * it unmetered would be a way around the login limit. Returns `null` when the
 * password checks out.
 */
export async function requirePassword(
  password: unknown,
  db: PiWebDatabase,
  options: { /** Audit label for the failure, e.g. "totp-disable". */ action: string; request: Request },
): Promise<NextResponse | null> {
  const context = requestContext(options.request);
  const recordFailure = (reason: string) => {
    recordAuthEvent({
      kind: "password",
      result: "fail",
      username: readAccount(db)?.username ?? PI_WEB_ACCOUNT_USERNAME,
      ip: context.ip,
      userAgent: context.userAgent,
      detail: { reason, action: options.action },
    }, db);
  };

  if (typeof password !== "string" || password.length === 0) {
    recordFailure("missing-password");
    return unauthorized("The current password is required.");
  }

  const retryAfterMs = getAuthRetryAfterMs("login", db);
  if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);

  if (!await verifyAccountPassword(password, db)) {
    recordAuthFailure("login", db);
    recordFailure("invalid-password");
    return unauthorized("The current password is incorrect.");
  }
  return null;
}
