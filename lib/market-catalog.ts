import { getDatabase, type PiWebDatabase } from "./db";
import { npmRegistryUrl } from "./npm-registry";

/**
 * The package catalog behind the marketplace page.
 *
 * pi.dev publishes one server-rendered catalog of everything installable with
 * `pi install npm:…`. There is no JSON API (`/api/*` answers "API routes are
 * reserved for future features"), so this module reads the markup the page
 * already renders: the list page exposes `data-package-*` attributes on each
 * card, and the detail page a `definition-grid` of metadata. Parsing HTML is a
 * liability, so it is confined here, every field is optional, and the result is
 * cached in `market_cache` — a catalog page is the same for everyone and does
 * not need to be fetched twice.
 *
 * README text comes from the npm registry instead: it is markdown, which the
 * app already renders, while pi.dev ships it as sanitized HTML.
 */

export const PI_DEV_BASE_URL = "https://pi.dev";
export const MARKET_LIST_TTL_MS = 6 * 60 * 60 * 1000;
export const MARKET_DETAIL_TTL_MS = 24 * 60 * 60 * 1000;
export const MARKET_FETCH_TIMEOUT_MS = 12_000;

export const MARKET_TYPES = ["extension", "skill", "theme", "prompt"] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

export interface MarketPackage {
  name: string;
  description: string;
  types: string[];
  downloads: number;
  /** Epoch milliseconds; pi.dev publishes `data-package-date` in ms already. */
  publishedAt: number | null;
  author: string | null;
  npmUrl: string | null;
  repoUrl: string | null;
  /** "1.2M/mo" as shown on the card, when the number alone is not enough. */
  downloadsText: string | null;
  publishedText: string | null;
}

export interface MarketPackageDetail extends MarketPackage {
  version: string | null;
  installCommand: string | null;
  license: string | null;
  size: string | null;
  dependencies: string | null;
  securityNote: string | null;
  readme: string | null;
  pageUrl: string;
}

export interface MarketPageResult {
  items: MarketPackage[];
  page: number;
  hasMore: boolean;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
}

export interface MarketPackageResult {
  item: MarketPackageDetail;
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
}

export function marketBaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PI_WEB_MARKET_BASE_URL?.trim();
  return (configured || PI_DEV_BASE_URL).replace(/\/+$/, "");
}

export { npmRegistryUrl } from "./npm-registry";

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? decodeEntities(match[1]) : null;
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function elementText(html: string, className: string, tag = "p"): string | null {
  const match = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</${tag}>`).exec(html);
  return match ? stripTags(match[1]) : null;
}

/** "459.5K/mo · 132.8K/wk" → 459500, from the first (per-month) figure. */
export function parseDownloadCount(text: string | null | undefined): number {
  const match = /([\d.]+)\s*([KMB])?\s*\/\s*(mo|month)?/i.exec(text ?? "");
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const scale = match[2] ? { K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase() as "K" | "M" | "B"] : 1;
  return Math.round(value * scale);
}

/** "Sep 23, 2026" → epoch milliseconds, or null when the format is unknown. */
export function parsePublishedDate(text: string | null | undefined): number | null {
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Cards carry everything the list needs, so a list page never needs details. */
export function parseCatalogPage(html: string): MarketPackage[] {
  const cards = html.match(/<article[^>]*data-package-card="true"[^>]*>[\s\S]*?<\/article>/g) ?? [];
  const items: MarketPackage[] = [];

  for (const card of cards) {
    const tag = card.slice(0, card.indexOf(">") + 1);
    const name = attribute(tag, "data-package-name");
    if (!name) continue;

    const downloads = Number(attribute(tag, "data-package-downloads") ?? "0");
    const date = Number(attribute(tag, "data-package-date") ?? "");
    // Search results render the type badge without the `data-package-types`
    // attribute, so fall back to the chips when the attribute is empty.
    // The site badges a package whose manifest declares nothing as `package`,
    // which is not an installable resource type — keep the list honest.
    const badges = [...card.matchAll(/data-type="([a-z]+)"/g)]
      .map((match) => match[1])
      .filter((value) => (MARKET_TYPES as readonly string[]).includes(value));
    const attributeTypes = (attribute(tag, "data-package-types") ?? "").split(/\s+/).filter(Boolean);
    const meta = card.match(/<div class="packages-meta">([\s\S]*?)<\/div>/);
    const metaSpans = meta ? [...meta[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => stripTags(m[1])) : [];
    const npmUrl = /<a href="(https:\/\/www\.npmjs\.com\/package\/[^"]*)"/.exec(card)?.[1] ?? null;
    const repoUrl = /<a href="(https:\/\/github\.com\/[^"]*)"/.exec(card)?.[1] ?? null;

    items.push({
      name,
      description: elementText(card, "packages-desc") ?? "",
      types: attributeTypes.length > 0 ? attributeTypes : [...new Set(badges)],
      downloads: Number.isFinite(downloads) ? downloads : 0,
      publishedAt: Number.isFinite(date) && date > 0 ? date : null,
      author: metaSpans[0] ?? null,
      downloadsText: metaSpans[1] ?? null,
      publishedText: metaSpans[2] ?? null,
      npmUrl,
      repoUrl,
    });
  }

  return items;
}

function definitionGrid(html: string): Map<string, string> {
  const grid = /<dl class="[^"]*definition-grid[^"]*"[^>]*>([\s\S]*?)<\/dl>/.exec(html)?.[1] ?? "";
  const entries = new Map<string, string>();
  const pattern = /<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g;
  for (const match of grid.matchAll(pattern)) {
    entries.set(stripTags(match[1]).toLowerCase(), stripTags(match[2]));
  }
  return entries;
}

export function parsePackageDetail(name: string, html: string): Omit<MarketPackageDetail, "readme"> {
  const grid = definitionGrid(html);
  const installCommand = /data-copy-text="([^"]*pi install[^"]*)"/.exec(html)?.[1] ?? null;
  const securityNote = /<section class="surface-panel content-card notice-card packages-security-card">([\s\S]*?)<\/section>/.exec(html);
  const description = elementText(html, "packages-desc");
  const downloadsText = grid.get("downloads") ?? null;
  const publishedText = grid.get("published") ?? null;

  return {
    name,
    description: description ?? "",
    types: (grid.get("types") ?? "").split(",").map((type) => type.trim()).filter(Boolean),
    downloads: parseDownloadCount(downloadsText),
    publishedAt: parsePublishedDate(publishedText),
    author: grid.get("author") ?? null,
    npmUrl: /<a href="(https:\/\/www\.npmjs\.com\/package\/[^"]*)"/.exec(html)?.[1] ?? null,
    repoUrl: /<a href="(https:\/\/github\.com\/[^"]*)"/.exec(html)?.[1] ?? null,
    downloadsText,
    publishedText,
    version: grid.get("version") ?? null,
    installCommand: installCommand ? decodeEntities(installCommand) : null,
    license: grid.get("license") ?? null,
    size: grid.get("size") ?? null,
    dependencies: grid.get("dependencies") ?? null,
    securityNote: securityNote ? stripTags(securityNote[1]) || null : null,
    pageUrl: `${marketBaseUrl()}/packages/${encodeURIComponent(name)}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

export interface CachedPayload<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
}

export function readMarketCache<T>(
  key: string,
  options: { source?: string; db?: PiWebDatabase; now?: number; ttlMs?: number } = {},
): CachedPayload<T> | null {
  const db = options.db ?? getDatabase();
  const row = db.prepare("SELECT payload, fetched_at, expires_at FROM market_cache WHERE source = ? AND cache_key = ?")
    .get(options.source ?? "pi.dev", key) as { payload: string; fetched_at: number; expires_at: number } | undefined;
  if (!row) return null;
  try {
    return {
      value: JSON.parse(row.payload) as T,
      fetchedAt: row.fetched_at,
      stale: typeof options.now === "number" ? row.expires_at <= options.now : false,
    };
  } catch {
    return null;
  }
}

export function writeMarketCache(
  key: string,
  value: unknown,
  options: { source?: string; db?: PiWebDatabase; now?: number; ttlMs: number },
): void {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  db.prepare(`
    INSERT INTO market_cache (source, cache_key, payload, fetched_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, cache_key) DO UPDATE SET
      payload = excluded.payload,
      fetched_at = excluded.fetched_at,
      expires_at = excluded.expires_at
  `).run(options.source ?? "pi.dev", key, JSON.stringify(value), now, now + options.ttlMs);
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/json",
        "User-Agent": "pi-web-marketplace",
      },
      signal: AbortSignal.timeout(MARKET_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export interface MarketQuery {
  query?: string;
  type?: string;
  sort?: "downloads" | "recent" | "name";
  page?: number;
}

export function marketListCacheKey(query: MarketQuery): string {
  const sort = query.sort ?? "downloads";
  return `list:${sort}:${query.type ?? ""}:${(query.query ?? "").trim().toLowerCase()}:${Math.max(1, query.page ?? 1)}`;
}

export function marketListUrl(query: MarketQuery, base = marketBaseUrl()): string {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set("name", query.query.trim());
  if (query.type && (MARKET_TYPES as readonly string[]).includes(query.type)) params.set("type", query.type);
  params.set("sort", query.sort ?? "downloads");
  const page = Math.max(1, query.page ?? 1);
  if (page > 1) params.set("page", String(page));
  return `${base}/packages?${params.toString()}`;
}

/**
 * A cached page wins over a fetch when it is still fresh; when the network is
 * down the stale copy is returned with `stale: true` so the UI can say where the
 * data came from instead of showing an empty marketplace.
 */
export async function fetchMarketPage(
  query: MarketQuery,
  options: { db?: PiWebDatabase; now?: number; ttlMs?: number } = {},
): Promise<MarketPageResult> {
  const now = options.now ?? Date.now();
  const key = marketListCacheKey(query);
  const cached = readMarketCache<MarketPackage[]>(key, { db: options.db, now });

  if (cached && !cached.stale) {
    return { items: cached.value, page: Math.max(1, query.page ?? 1), hasMore: cached.value.length >= 50, fetchedAt: cached.fetchedAt, fromCache: true, stale: false };
  }

  const html = await fetchText(marketListUrl(query, marketBaseUrl()));
  if (html) {
    const items = parseCatalogPage(html);
    writeMarketCache(key, items, { db: options.db, now, ttlMs: options.ttlMs ?? MARKET_LIST_TTL_MS });
    return { items, page: Math.max(1, query.page ?? 1), hasMore: items.length >= 50, fetchedAt: now, fromCache: false, stale: false };
  }

  if (cached) {
    return { items: cached.value, page: Math.max(1, query.page ?? 1), hasMore: cached.value.length >= 50, fetchedAt: cached.fetchedAt, fromCache: true, stale: true };
  }
  return { items: [], page: Math.max(1, query.page ?? 1), hasMore: false, fetchedAt: now, fromCache: false, stale: false };
}

/** npm's registry serves the README as markdown, which the app renders natively. */
export async function fetchNpmReadme(name: string, registry = npmRegistryUrl()): Promise<string | null> {
  const body = await fetchText(`${registry}/${encodeURIComponent(name).replace("%40", "@")}`);
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { readme?: unknown };
    return typeof parsed.readme === "string" && parsed.readme.trim().length > 0 ? parsed.readme : null;
  } catch {
    return null;
  }
}

export async function fetchMarketPackage(
  name: string,
  options: { db?: PiWebDatabase; now?: number; ttlMs?: number; registry?: string } = {},
): Promise<MarketPackageResult | null> {
  const trimmed = name.trim();
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(trimmed)) return null;

  const now = options.now ?? Date.now();
  const key = `package:${trimmed}`;
  const cached = readMarketCache<MarketPackageDetail>(key, { db: options.db, now });
  if (cached && !cached.stale) {
    return { item: cached.value, fetchedAt: cached.fetchedAt, fromCache: true, stale: false };
  }

  const html = await fetchText(`${marketBaseUrl()}/packages/${encodeURIComponent(trimmed)}`);
  if (html) {
    const parsed = parsePackageDetail(trimmed, html);
    const readme = await fetchNpmReadme(trimmed, options.registry ?? npmRegistryUrl());
    const item: MarketPackageDetail = { ...parsed, readme };
    writeMarketCache(key, item, { db: options.db, now, ttlMs: options.ttlMs ?? MARKET_DETAIL_TTL_MS });
    return { item, fetchedAt: now, fromCache: false, stale: false };
  }

  if (cached) return { item: cached.value, fetchedAt: cached.fetchedAt, fromCache: true, stale: true };
  return null;
}
