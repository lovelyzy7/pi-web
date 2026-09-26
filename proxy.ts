import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { retryAfterSeconds } from "@/lib/auth-throttle";
import { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } from "@/lib/auth-throttle-store";
import { isAccountConfigured, readAccount, readTotpState, validateWebSession } from "@/lib/auth-store";
import { apiTokenAllowsMethod, verifyApiToken } from "@/lib/api-tokens";
import { getDatabase, type PiWebDatabase } from "@/lib/db";
import {
  buildContentSecurityPolicy,
  createNonce,
  cspMode,
  hstsValue,
  isTrustworthyOrigin,
} from "@/lib/security-headers";
import { verifyPasswordHashSync } from "@/lib/password-hash";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

/**
 * The request gate.
 *
 * Two mutually exclusive modes:
 *
 * - **Environment password** (`PI_WEB_PASSWORD`): the original behaviour. The
 *   cookie is an HMAC of the password, so no database is involved and a
 *   read-only agent directory still serves the app.
 * - **Account mode**: an account row exists in the SQLite database. The cookie
 *   is a random token stored as a digest, which makes per-device sign-out and
 *   "sign out everywhere" possible.
 *
 * Neither mode runs scrypt on an ordinary request. Password verification happens
 * in `/api/web-auth` (login), `/api/web-auth/init` (first run), and the password
 * change route; the proxy only looks a token up by primary key.
 *
 * API clients authenticate with `Bearer pi_pat_…` tokens. HTTP Basic still works
 * for compatibility, but only while two-factor authentication is off: Basic
 * cannot carry a TOTP code, so letting it through would make enabling the second
 * factor meaningless.
 */

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

function redirectToLogin(request: NextRequest): NextResponse {
  const loginUrl = new URL("/login", request.url);
  if (request.nextUrl.search) {
    loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  }
  return NextResponse.redirect(loginUrl);
}

function redirectToInit(request: NextRequest): NextResponse {
  const initUrl = new URL("/init", request.url);
  if (request.nextUrl.pathname !== "/") initUrl.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(initUrl);
}

function unauthorizedApi(message = "Authentication required"): NextResponse {
  return new NextResponse(message, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
    },
  });
}

function setupRequiredApi(): NextResponse {
  return NextResponse.json(
    { error: "setup_required", initUrl: "/init" },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Successful Basic verifications are cached, because HTTP Basic credentials
 * arrive on *every* request and scrypt costs ~120 ms. The cache key includes the
 * password-change timestamp, so a new password invalidates it immediately.
 */
interface BasicAuthCacheEntry {
  digest: string;
  passwordChangedAt: number | null;
  verifiedAt: number;
}

declare global {
  var __piWebBasicAuthCache: BasicAuthCacheEntry | undefined;
}

const BASIC_AUTH_CACHE_TTL_MS = 5 * 60_000;

function matchesBasicAuthorization(
  authorization: string | null,
  db: PiWebDatabase,
  now: number = Date.now(),
): boolean {
  if (!authorization) return false;
  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return false;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return false;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return false;
  }

  const separator = credentials.indexOf(":");
  if (separator === -1) return false;
  const username = credentials.slice(0, separator);
  const password = credentials.slice(separator + 1);
  if (username !== "pi") return false;

  const account = readAccount(db);
  if (!account?.passwordHash) return false;
  if (account.totpEnabled) return false;

  const digest = createHash("sha256").update(password, "utf8").digest("hex");
  const cached = globalThis.__piWebBasicAuthCache;
  if (cached && cached.digest === digest
    && cached.passwordChangedAt === account.passwordChangedAt
    && now - cached.verifiedAt < BASIC_AUTH_CACHE_TTL_MS) {
    return true;
  }

  if (!verifyPasswordHashSync(password, account.passwordHash)) return false;
  globalThis.__piWebBasicAuthCache = {
    digest,
    passwordChangedAt: account.passwordChangedAt,
    verifiedAt: now,
  };
  return true;
}

/** The original `PI_WEB_PASSWORD` behaviour, unchanged apart from persisted counters. */
function proxyWithEnvironmentPassword(
  request: NextRequest,
  isApiRequest: boolean,
  password: string,
): NextResponse {
  const path = request.nextUrl.pathname;
  const authenticatedSession = isValidWebSessionToken(
    request.cookies.get(PI_WEB_SESSION_COOKIE)?.value,
    password,
  );
  let authenticated = authenticatedSession;

  const authorization = isApiRequest ? request.headers.get("authorization") : null;
  if (!authenticated && authorization && /^Basic\s/i.test(authorization)) {
    // Every Basic header is a password guess, so it shares the login form's
    // throttle; otherwise any API path (or GET /api/web-auth) answers guesses
    // at full speed. While blocked even the right password is refused, or the
    // answer would leak. A success does not reset the counter: Basic clients
    // authenticate on every request, and each reset would hand an interleaved
    // guesser a fresh short block.
    const retryAfterMs = getAuthRetryAfterMs("login");
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
    authenticated = isValidBasicAuthorization(authorization, password);
    if (!authenticated) recordAuthFailure("login");
  }

  if (path === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (path === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) return redirectToLogin(request);
    return unauthorizedApi();
  }

  return NextResponse.next();
}

/** Account mode: tokens live in the database and can be revoked individually. */
function proxyWithAccount(request: NextRequest, isApiRequest: boolean, db: PiWebDatabase): NextResponse {
  const path = request.nextUrl.pathname;
  const configured = isAccountConfigured(db);

  if (!configured) {
    // First run: /init and the two endpoints that create the account are the
    // only reachable surfaces, and the setup code inside them gates the write.
    if (path === "/init" || path === "/api/web-auth/init" || path === "/api/web-auth") {
      return NextResponse.next();
    }
    if (path === "/login") return NextResponse.redirect(new URL("/init", request.url));
    if (!isApiRequest) return redirectToInit(request);
    return setupRequiredApi();
  }

  if (path === "/init") return NextResponse.redirect(new URL("/", request.url));
  if (path === "/api/web-auth" || path === "/api/web-auth/init") return NextResponse.next();

  if (isApiRequest) {
    const authorization = request.headers.get("authorization");
    if (authorization && /^Bearer\s/i.test(authorization)) {
      const presented = authorization.replace(/^Bearer\s+/i, "").trim();
      const validation = verifyApiToken(presented, { db });
      if (validation.ok && apiTokenAllowsMethod(validation.token.scopes, request.method)) {
        return NextResponse.next();
      }
      return NextResponse.json(
        { error: validation.ok ? "insufficient_scope" : "invalid_token" },
        { status: validation.ok ? 403 : 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (authorization && /^Basic\s/i.test(authorization)) {
      const retryAfterMs = getAuthRetryAfterMs("login");
      if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
      if (matchesBasicAuthorization(authorization, db)) {
        recordAuthSuccess("login");
        return NextResponse.next();
      }
      recordAuthFailure("login");
    }
  }

  const token = request.cookies.get(PI_WEB_SESSION_COOKIE)?.value;
  if (validateWebSession(token, { db }).ok) return NextResponse.next();

  if (path === "/login") return NextResponse.next();
  if (!isApiRequest) return redirectToLogin(request);
  if (readTotpState(db).enabled) {
    return NextResponse.json(
      {
        error: "token_required",
        message: "HTTP Basic is disabled while two-factor authentication is on. Create an API token in /user.",
      },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  return unauthorizedApi();
}

/**
 * Security headers for whatever the gate decided to return.
 *
 * The nonce is also handed to the app on the request, because that is how Next
 * stamps its own inline scripts and how the root layout finds it for the theme
 * script. Only an allowed request gets that treatment: redirects and JSON
 * responses carry no markup.
 */
function applySecurityHeaders(
  request: NextRequest,
  response: NextResponse,
  nonce: string,
): NextResponse {
  const mode = cspMode();
  const policy = mode === "off" ? null : buildContentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV !== "production",
    connectExtra: process.env.NODE_ENV === "production"
      ? []
      : [`ws://${request.headers.get("host") ?? "127.0.0.1"}`],
  });

  let hardened = response;
  if (response.headers.get("x-middleware-next") === "1") {
    const forwarded = new Headers(request.headers);
    forwarded.set("x-nonce", nonce);
    // The sign-in and first-run pages are never themed: they are the way back in
    // when a theme misbehaves, so the layout must not link its stylesheet there
    // (the request would be unauthenticated, fail, and the loader guard would
    // disable the theme as if it were broken).
    if (isUnthemedPage(request.nextUrl.pathname)) forwarded.set("x-pi-theme", "off");
    if (policy) forwarded.set("Content-Security-Policy", policy);
    hardened = NextResponse.next({ request: { headers: forwarded } });
    for (const [key, value] of response.headers) hardened.headers.set(key, value);
  }

  hardened.headers.set("x-nonce", nonce);
  if (policy) {
    hardened.headers.set(
      mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
      policy,
    );
  }
  if (request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https") {
    hardened.headers.set("Strict-Transport-Security", hstsValue());
  }
  if (isTrustworthyOrigin(request)) {
    hardened.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  }
  return hardened;
}

export function proxy(request: NextRequest) {
  const nonce = createNonce();
  return applySecurityHeaders(request, dispatchProxy(request), nonce);
}

/** Pages that always render with the built-in palettes. */
function isUnthemedPage(pathname: string): boolean {
  return pathname === "/login" || pathname === "/init";
}

function dispatchProxy(request: NextRequest): NextResponse {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (isWebPasswordEnabled(password)) {
    return proxyWithEnvironmentPassword(request, isApiRequest, password);
  }

  let db: PiWebDatabase;
  try {
    db = getDatabase();
  } catch (error) {
    // Fail closed: without the account database there is no way to tell an
    // authenticated request from an anonymous one. Serving the app anyway was
    // the old "no password configured" behaviour and would silently drop the
    // authentication the operator asked for.
    console.error(
      "[pi-web] Cannot open the Pi Web database, refusing requests: "
      + (error instanceof Error ? error.message : String(error)),
    );
    if (!isApiRequest) {
      return new NextResponse(
        "Pi Web cannot open its database. Check that the agent directory is writable.",
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  return proxyWithAccount(request, isApiRequest, db);
}

export const config = {
  matcher: ["/", "/login", "/init", "/user", "/market", "/updates", "/api/:path*"],
};
