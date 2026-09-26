import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isThemeSourceError, parseThemeSource } from "@/lib/theme-source";
import {
  THEME_PREVIEW_COOKIE,
  THEME_PREVIEW_TTL_SECONDS,
  isLocalThemeAllowed,
  isThemeResolutionError,
  resolveTheme,
} from "@/lib/theme-store";

export const dynamic = "force-dynamic";

/**
 * The origin the *client* used.
 *
 * `request.url` inside a route handler is built by the Next server and reports
 * the address it bound to (`http://0.0.0.0:30141` when it listens on all
 * interfaces). Redirecting there would move the browser to a host it holds no
 * cookie for — the session cookie is host-scoped — and it would bypass a reverse
 * proxy's external name entirely. The Host header is the address the browser
 * actually asked for.
 */
function clientOrigin(request: NextRequest): string {
  const host = request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProto || new URL(request.url).protocol.replace(":", "");
  return host ? `${protocol}://${host}` : new URL(request.url).origin;
}

function redirectHome(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/", clientOrigin(request)));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Says why a preview could not render.
 *
 * Redirecting first and letting the browser find out that a stylesheet is
 * missing means the operator lands on a normal-looking app with no explanation
 * — the preview "did not take effect". Resolving the theme here keeps the
 * reason in the tab that was just opened.
 */
function previewFailure(message: string, status: number): NextResponse {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Theme preview failed</title>
</head>
<body style="font: 14px/1.6 system-ui, -apple-system, sans-serif; max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; color: #1a1a1a">
<h1 style="font-size: 1.05rem">Theme preview failed</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back to Pi Web</a></p>
</body>
</html>`;
  return new NextResponse(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Previews a theme in the real interface.
 *
 * The panel's "Try it" swaps the stylesheet on the current page; this route is
 * for the honest check — a real navigation where the server renders the theme.
 * The source lives in a short-lived cookie, so nothing is applied and a reload
 * always follows the same code path as an applied theme.
 *
 * `?off=1` clears it again.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return new NextResponse("Untrusted API request", { status: 403 });
  }

  const secure = new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";

  if (request.nextUrl.searchParams.get("off") === "1") {
    const response = redirectHome(request);
    response.cookies.set({
      name: THEME_PREVIEW_COOKIE,
      value: "",
      // Readable by the page: the loader guard clears a preview that fails to
      // load, and a preview source is not a secret.
      httpOnly: false,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: 0,
    });
    return response;
  }

  const source = request.nextUrl.searchParams.get("source") ?? "";
  const parsed = parseThemeSource(source);
  if (isThemeSourceError(parsed)) {
    return new NextResponse(parsed.message, { status: 400 });
  }
  if (parsed.kind === "local" && !await isLocalThemeAllowed(parsed.localPath as string)) {
    return new NextResponse("Local theme path is not allowed", { status: 403 });
  }

  // Resolve before redirecting: a theme that cannot be read must say so here
  // rather than render an unthemed page with no explanation.
  let resolved: Awaited<ReturnType<typeof resolveTheme>>;
  try {
    resolved = await resolveTheme(parsed, { db: previewDatabase() });
  } catch (error) {
    return previewFailure(error instanceof Error ? error.message : String(error), 502);
  }
  if (isThemeResolutionError(resolved)) {
    return previewFailure(resolved.message, resolved.error === "unreachable" ? 502 : 400);
  }

  const response = redirectHome(request);
  response.cookies.set({
    name: THEME_PREVIEW_COOKIE,
    value: parsed.source,
    // Readable by the page: the loader guard clears a preview whose stylesheet
    // fails, so a broken preview cannot stick around across reloads.
    httpOnly: false,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: THEME_PREVIEW_TTL_SECONDS,
  });
  return response;
}

/** A database is only needed to cache remote theme files, never for local ones. */
function previewDatabase() {
  try {
    return getDatabase();
  } catch {
    return undefined;
  }
}
