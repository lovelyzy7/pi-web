import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  fetchThemeStore,
  isStoreUrlError,
  validateStoreUrl,
  writeStoredStoreUrl,
} from "@/lib/theme-store-catalog";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * The theme store the panel browses.
 *
 * GET  → the cached manifest (with `?refresh=1` to bypass the TTL)
 * POST → remember a store URL (`PI_WEB_THEME_STORE_URL` still wins when set)
 * DELETE → forget the stored URL
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return noStore({ error: "Untrusted API request" }, 403);
  const store = await fetchThemeStore({
    db: getDatabase(),
    refresh: request.nextUrl.searchParams.get("refresh") === "1",
  });
  return noStore({ ...store, envDefault: Boolean(process.env.PI_WEB_THEME_STORE_URL?.trim()) });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return noStore({ error: "Untrusted API request" }, 403);
  if (!hasJsonContentType(request)) return noStore({ error: "Content-Type must be application/json" }, 415);

  const body = await request.json().catch(() => null) as { url?: unknown } | null;
  const validated = validateStoreUrl(typeof body?.url === "string" ? body.url : "");
  if (isStoreUrlError(validated)) return noStore({ error: validated.error, message: validated.message }, 400);

  const db = getDatabase();
  writeStoredStoreUrl(validated, db);
  const store = await fetchThemeStore({ db, refresh: true });
  return noStore({ ...store, envDefault: Boolean(process.env.PI_WEB_THEME_STORE_URL?.trim()) });
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return noStore({ error: "Untrusted API request" }, 403);
  const db = getDatabase();
  writeStoredStoreUrl(null, db);
  return noStore(await fetchThemeStore({ db, refresh: true }));
}
