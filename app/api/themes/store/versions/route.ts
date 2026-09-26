import { NextRequest, NextResponse } from "next/server";
import { isNewerStableVersion } from "@/lib/app-update";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveThemeVersions } from "@/lib/theme-store";
import { fetchThemeStore } from "@/lib/theme-store-catalog";

export const dynamic = "force-dynamic";

/**
 * Versions for the store's entries.
 *
 * Kept off the store request itself: resolving a version means fetching a
 * `theme.json` per entry (four at a time, cached for a day), and the list should
 * render immediately. The panel calls this afterwards and shows a version per
 * card, plus an update hint when the applied theme's own version is older.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const db = getDatabase();
  const store = await fetchThemeStore({ db });
  const versions = await resolveThemeVersions(
    store.themes.map((theme) => ({ source: theme.source, version: theme.version })),
    { db, refresh: request.nextUrl.searchParams.get("refresh") === "1" },
  );

  const applied = readAppliedTheme(db);
  const newer = Object.entries(versions)
    .filter(([, version]) => version !== null)
    .filter(([source, version]) => applied?.source === source && isNewerStableVersion(version as string, applied.version))
    .map(([source]) => source);

  return NextResponse.json(
    { versions, newer },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function readAppliedTheme(db: ReturnType<typeof getDatabase>): { source: string; version: string } | null {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'theme:active'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.value) as { source?: unknown; manifest?: { version?: unknown } };
    if (typeof parsed.source !== "string") return null;
    return {
      source: parsed.source,
      version: typeof parsed.manifest?.version === "string" ? parsed.manifest.version : "0.0.0",
    };
  } catch {
    return null;
  }
}
