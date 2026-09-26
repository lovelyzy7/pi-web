import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isThemeSourceError, parseThemeSource, THEME_DEFAULT_STYLE } from "@/lib/theme-source";
import { allowFileRoot } from "@/lib/file-access";
import {
  clearActiveTheme,
  isLocalThemeAllowed,
  isThemeResolutionError,
  readActiveTheme,
  resolveTheme,
  writeActiveTheme,
} from "@/lib/theme-store";
import { RESERVED_VARIABLES, THEMEABLE_VARIABLES } from "@/lib/theme-manifest";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Third-party themes.
 *
 * GET    → what is applied now, plus the variable contract a theme may use
 * POST   → validate (and apply, unless `preview` is set) a source
 * DELETE → back to the built-in palettes
 *
 * The stylesheet itself is served by `/api/themes/asset`, same-origin, so the
 * CSP does not have to trust a third-party host.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }

  const db = getDatabase();
  const active = readActiveTheme(db);

  return noStore({
    active: active
      ? {
          source: active.source,
          display: active.display,
          ref: active.ref,
          appliedAt: active.appliedAt,
          manifest: active.manifest,
          cssUrl: `/api/themes/asset/${THEME_DEFAULT_STYLE}`,
        }
      : null,
    themeableVariables: THEMEABLE_VARIABLES,
    reservedVariables: RESERVED_VARIABLES,
  });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (!hasJsonContentType(request)) {
    return noStore({ error: "Content-Type must be application/json" }, 415);
  }

  const body = await request.json().catch(() => null) as
    | { source?: unknown; preview?: unknown; refresh?: unknown; allowLocal?: unknown }
    | null;
  const sourceInput = typeof body?.source === "string" ? body.source : "";
  const preview = body?.preview === true;

  const parsed = parseThemeSource(sourceInput);
  if (isThemeSourceError(parsed)) {
    return noStore({ error: parsed.error, message: parsed.message }, 400);
  }

  const db = getDatabase();
  const localPath = parsed.kind === "local" ? parsed.localPath as string : null;
  if (localPath && !await isLocalThemeAllowed(localPath)) {
    // The operator can approve the directory explicitly (`allowLocal`), the same
    // decision the directory picker makes for a project. Everything else stays
    // refused, so an API caller cannot read arbitrary directories.
    if (body?.allowLocal !== true) {
      return noStore({
        error: "blocked_path",
        message: "A local theme must live inside a browsable project, in ~/.pi/agent/themes, or in a directory you approve.",
      }, 403);
    }
    allowFileRoot(localPath);
  }

  const resolved = await resolveTheme(parsed, { db, refresh: body?.refresh === true });
  if (isThemeResolutionError(resolved)) {
    return noStore(
      { error: resolved.error, message: resolved.message, issues: resolved.issues },
      resolved.error === "unreachable" ? 502 : 400,
    );
  }

  if (!preview) {
    writeActiveTheme({
      source: resolved.source.source,
      display: resolved.source.display,
      manifest: resolved.manifest,
      ref: resolved.source.ref ?? "local",
      appliedAt: Date.now(),
    }, db);
  }

  return noStore({
    ok: true,
    applied: !preview,
    manifest: resolved.manifest,
    issues: resolved.issues,
    overriddenVariables: resolved.validation.overriddenVariables,
    cssUrl: `/api/themes/asset/${THEME_DEFAULT_STYLE}${preview ? `?preview=1&source=${encodeURIComponent(resolved.source.source)}` : ""}`,
  });
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  clearActiveTheme(getDatabase());
  return noStore({ ok: true, active: null });
}
