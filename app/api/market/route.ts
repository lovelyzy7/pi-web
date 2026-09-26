import { NextRequest } from "next/server";
import { fetchMarketPackage, fetchMarketPage, MARKET_TYPES } from "@/lib/market-catalog";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function noStore(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const SORTS = new Set(["downloads", "recent", "name"]);

function parseInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * The marketplace catalog.
 *
 * `?package=<name>` returns one package with its README; anything else returns a
 * page of the catalog. Installation is not here: the marketplace installs
 * through `/api/plugins`, which already owns the package manager, project trust,
 * and the settings file.
 */
export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return noStore({ error: "Untrusted API request" }, 403);
  }

  const name = request.nextUrl.searchParams.get("package");
  if (name) {
    const result = await fetchMarketPackage(name);
    if (!result) {
      return noStore({ error: "package_not_found", message: "pi.dev has no such package." }, 404);
    }
    return noStore(result);
  }

  const rawType = request.nextUrl.searchParams.get("type");
  const type = rawType && (MARKET_TYPES as readonly string[]).includes(rawType) ? rawType : "";
  const rawSort = request.nextUrl.searchParams.get("sort");

  const result = await fetchMarketPage({
    query: request.nextUrl.searchParams.get("q") ?? "",
    type,
    sort: rawSort && SORTS.has(rawSort) ? (rawSort as "downloads" | "recent" | "name") : "downloads",
    page: parseInteger(request.nextUrl.searchParams.get("page"), 1, 1, 200),
  });

  return noStore({ ...result, baseUrl: "https://pi.dev/packages" });
}
