import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  getManagedThemesDir,
  importLocalTheme,
  removeManagedTheme,
  scanLocalThemes,
  themeLocalError,
} from "@/lib/theme-local";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const STATUS_BY_ERROR: Record<string, number> = {
  blocked_path: 403,
  not_found: 404,
  invalid_theme: 400,
  too_large: 413,
  exists: 409,
  failed: 500,
};

/**
 * Local themes: the ones this server can already see, and importing one.
 *
 * GET  ?cwd=…  → themes found in the managed directory, `PI_WEB_THEME_ROOTS`,
 *                and the selected project's `themes/` folder
 * POST         → { action: "import", source, overwrite? } copies a validated
 *                theme into ~/.pi/agent/themes
 *                { action: "remove", source } deletes that managed copy
 *
 * Applying a theme stays on `/api/themes`, so an import never changes what is
 * on screen by itself.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }

  const cwd = request.nextUrl.searchParams.get("cwd");
  const scan = await scanLocalThemes({ cwd });
  return noStore({ ...scan, importDir: getManagedThemesDir() });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }
  if (!hasJsonContentType(request)) {
    return noStore({ error: "Content-Type must be application/json" }, 415);
  }

  const body = await request.json().catch(() => null) as
    | { action?: unknown; source?: unknown; overwrite?: unknown }
    | null;
  const source = typeof body?.source === "string" ? body.source.trim() : "";
  if (!source) {
    return noStore(themeLocalError("not_found", "A directory is required."), 400);
  }

  if (body?.action === "remove") {
    const removed = removeManagedTheme(source);
    if ("error" in removed) {
      return noStore(removed, STATUS_BY_ERROR[removed.error] ?? 500);
    }
    return noStore({ ok: true, removed: removed.directory });
  }

  if (body?.action !== "import") {
    return noStore({ error: "unknown_action", message: 'Use "import" or "remove".' }, 400);
  }

  const imported = await importLocalTheme(source, {
    overwrite: body?.overwrite === true,
    db: getDatabase(),
  });
  if ("error" in imported) {
    return noStore(imported, STATUS_BY_ERROR[imported.error] ?? 500);
  }
  return noStore({ ok: true, source: imported.source, directory: imported.directory, entry: imported.entry });
}
