import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/db";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isBlockedHost } from "@/lib/theme-source";

export const dynamic = "force-dynamic";

const MAX_COVER_BYTES = 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * Proxies a store cover image.
 *
 * Covers point at the theme's repository, and fetching them here keeps the
 * browser from contacting GitHub for a preview thumbnail (the app's CSP allows
 * `https:` images, so this is about privacy and offline caching rather than
 * policy). Everything is fetched server-side with the same host restrictions as a
 * theme source.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) return new NextResponse("Untrusted API request", { status: 403 });

  const raw = request.nextUrl.searchParams.get("url") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new NextResponse("Invalid cover URL", { status: 400 });
  }
  if (url.protocol !== "https:" || url.username || url.password || isBlockedHost(url.hostname)) {
    return new NextResponse("Blocked cover URL", { status: 403 });
  }
  const extension = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  if (!IMAGE_TYPES[extension]) return new NextResponse("Unsupported cover type", { status: 415 });

  const db = getDatabase();
  const key = url.toString();
  const row = db.prepare("SELECT payload, expires_at FROM market_cache WHERE source = 'theme-cover' AND cache_key = ?")
    .get(key) as { payload: string; expires_at: number } | undefined;
  if (row && row.expires_at > Date.now()) {
    return new NextResponse(Buffer.from(row.payload, "base64"), {
      headers: {
        "Content-Type": IMAGE_TYPES[extension],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400",
      },
    });
  }

  try {
    const response = await fetch(key, {
      headers: { Accept: "image/*", "User-Agent": "pi-web-theme-store" },
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) return new NextResponse("Cover not found", { status: 404 });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_COVER_BYTES) return new NextResponse("Cover too large", { status: 413 });

    db.prepare(`
      INSERT INTO market_cache (source, cache_key, payload, fetched_at, expires_at)
      VALUES ('theme-cover', ?, ?, ?, ?)
      ON CONFLICT(source, cache_key) DO UPDATE SET
        payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    `).run(key, buffer.toString("base64"), Date.now(), Date.now() + 24 * 60 * 60 * 1000);

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": IMAGE_TYPES[extension],
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new NextResponse("Cover unavailable", { status: 502 });
  }
}
