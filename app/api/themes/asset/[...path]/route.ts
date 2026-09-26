import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isThemeSourceError, normalizeThemeAssetPath, parseThemeSource } from "@/lib/theme-source";
import {
  isLocalThemeAllowed,
  readActiveTheme,
  serveThemeFile,
  THEME_BRANCH_TTL_MS,
  THEME_COMMIT_TTL_MS,
} from "@/lib/theme-store";

export const dynamic = "force-dynamic";

/**
 * Serves one file of the applied theme (or of a preview source), addressed by
 * path rather than by query parameter.
 *
 * The path shape matters: a theme's stylesheet may reference `url(assets/x.png)`,
 * and relative URLs resolve against the request path. With `…/asset/theme.css`
 * that becomes `…/asset/assets/x.png`, which this route serves; with a
 * `?path=theme.css` URL it would resolve to `…/assets/x.png` and miss the route
 * entirely. Same-origin all the way, so the CSP keeps `style-src 'self'` and the
 * browser never contacts the theme's host.
 *
 * Only `theme.json`, stylesheets, and `assets/…` are reachable.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!isApiRequestAllowed(request)) {
    return new NextResponse("Untrusted API request", { status: 403 });
  }

  const { path: segments } = await params;
  const requested = segments.map((segment) => decodeURIComponent(segment)).join("/");
  const path = normalizeThemeAssetPath(requested);
  if (!path) return new NextResponse("Unsupported theme file", { status: 400 });

  const preview = request.nextUrl.searchParams.get("preview") === "1";
  const previewSource = request.nextUrl.searchParams.get("source");
  const db = getDatabase();

  let sourceInput: string | null;
  if (preview) {
    if (!previewSource) return new NextResponse("A preview source is required", { status: 400 });
    sourceInput = previewSource;
  } else {
    sourceInput = readActiveTheme(db)?.source ?? null;
  }
  if (!sourceInput) return new NextResponse("No theme is applied", { status: 404 });

  const parsed = parseThemeSource(sourceInput);
  if (isThemeSourceError(parsed)) return new NextResponse(parsed.message, { status: 400 });
  if (parsed.kind === "local" && !await isLocalThemeAllowed(parsed.localPath as string)) {
    return new NextResponse("Local theme path is not allowed", { status: 403 });
  }

  const file = await serveThemeFile(parsed, path, {
    db,
    refresh: request.nextUrl.searchParams.get("refresh") === "1",
  });
  if (!file) return new NextResponse("Theme file not found", { status: 404 });

  // A commit-pinned theme can never change; a branch may, so it gets a short TTL;
  // a local directory is re-read on every request while a theme is developed.
  const cacheControl = preview || parsed.kind === "local"
    ? "no-store"
    : parsed.immutable
      ? `private, max-age=${Math.floor(THEME_COMMIT_TTL_MS / 1000)}, immutable`
      : `private, max-age=${Math.floor(THEME_BRANCH_TTL_MS / 1000)}`;

  return new NextResponse(file.body, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": cacheControl,
    },
  });
}
