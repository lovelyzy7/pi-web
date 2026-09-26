import { getDatabase, type PiWebDatabase } from "./db";
import { isBlockedHost, isThemeSourceError, parseThemeSource } from "./theme-source";

/**
 * The theme store: a JSON manifest listing third-party themes.
 *
 * The shape is deliberately the one CF-Server-Monitor's store already uses
 * (`{ schema, themes: [{ id, title, author, tags, description, url, branch,
 * cover }] }`), so an existing store works unchanged. `version` is an optional
 * extension: a store that does not carry one still gets versions, read from each
 * theme's own `theme.json` by `resolveThemeVersions()`. The manifest is fetched by
 * the server and cached — the browser neither sees a CORS error nor leaks a
 * request to GitHub — and every entry is turned into a normal theme source, which
 * means the store cannot bypass the source validation applied to a hand-typed URL.
 */

export const THEME_STORE_SETTING = "theme:store";
export const THEME_STORE_TTL_MS = 5 * 60 * 1000;
export const THEME_STORE_FETCH_TIMEOUT_MS = 10_000;
export const MAX_STORE_THEMES = 200;

export interface StoreTheme {
  id: string;
  title: string;
  author: string;
  tags: string[];
  description: Record<string, string>;
  /** Declared by the store; filled in from the theme's own manifest on demand. */
  version: string | null;
  /** Normalized Pi Web theme source (`github:…`, a tree URL, or `local:…`). */
  source: string;
  coverUrl: string | null;
  /** The entry's own page (the `url` in the manifest), for a "view" link. */
  homepageUrl: string | null;
}

export interface ThemeStoreResult {
  configured: boolean;
  url: string | null;
  themes: StoreTheme[];
  fetchedAt: number;
  fromCache: boolean;
  stale: boolean;
  error?: string;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function descriptionValue(value: unknown): Record<string, string> {
  if (typeof value === "string" && value.trim()) return { en: value.trim() };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, text]) => typeof text === "string" && text.trim().length > 0)
      .map(([locale, text]) => [locale, (text as string).trim()]),
  );
}

/**
 * Turns a store entry into a theme source. A repository URL plus `branch` is the
 * modern store format; a full tree URL is accepted as well, and a commit ref wins
 * because it is reproducible.
 */
export function storeEntrySource(url: string, branch?: string | null): string | null {
  const trimmed = url.trim();
  if (trimmed.startsWith("local:")) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const [owner, repo] = segments;

  // Already a tree URL: hand it over untouched so commits and subdirectories work.
  if (segments[2] === "tree" && segments[3]) return `https://github.com/${segments.join("/")}`;

  const ref = stringValue(branch) ?? "main";
  if (!/^[A-Za-z0-9._-]+$/.test(ref)) return null;
  return `https://github.com/${owner}/${repo}/tree/${ref}`;
}

/** Parses a store manifest, dropping entries that cannot become a valid source. */
export function parseThemeStore(raw: unknown): { themes: StoreTheme[]; issues: string[] } {
  const issues: string[] = [];
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === "object" && raw !== null && Array.isArray((raw as { themes?: unknown }).themes)
      ? (raw as { themes: unknown[] }).themes
      : null);

  if (!list) return { themes: [], issues: ["The store manifest must be an object with a `themes` array."] };
  if (list.length > MAX_STORE_THEMES) issues.push(`Only the first ${MAX_STORE_THEMES} entries are shown.`);

  const themes: StoreTheme[] = [];
  for (const entry of list.slice(0, MAX_STORE_THEMES)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const url = stringValue(record.url ?? record.source);
    const title = stringValue(record.title ?? record.name);
    if (!url || !title) {
      issues.push(`Skipped an entry without a title or url.`);
      continue;
    }

    const source = storeEntrySource(url, stringValue(record.branch));
    if (!source) {
      issues.push(`Skipped "${title}": only GitHub repositories or local directories are supported.`);
      continue;
    }
    const parsed = parseThemeSource(source);
    if (isThemeSourceError(parsed)) {
      issues.push(`Skipped "${title}": ${parsed.message}`);
      continue;
    }

    const cover = stringValue(record.cover);
    // The entry's own page: shown as a link, never fetched by the browser.
    const homepageCandidate = stringValue(record.url);
    const homepage = homepageCandidate && /^https?:\/\//i.test(homepageCandidate) ? homepageCandidate : null;
    themes.push({
      id: stringValue(record.id) ?? parsed.display,
      title,
      author: stringValue(record.author) ?? "unknown",
      tags: Array.isArray(record.tags)
        ? record.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).slice(0, 6)
        : [],
      description: descriptionValue(record.description),
      version: stringValue(record.version),
      source: parsed.source,
      coverUrl: cover && !isBlockedHost(new URL(cover).hostname) ? cover : null,
      homepageUrl: homepage && !isBlockedHost(new URL(homepage).hostname) ? homepage : null,
    });
  }

  return { themes, issues };
}

export function readStoredStoreUrl(db: PiWebDatabase = getDatabase()): string | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(THEME_STORE_SETTING) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const value: unknown = JSON.parse(row.value);
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function writeStoredStoreUrl(url: string | null, db: PiWebDatabase = getDatabase()): void {
  if (!url) {
    db.prepare("DELETE FROM app_settings WHERE key = ?").run(THEME_STORE_SETTING);
    return;
  }
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(THEME_STORE_SETTING, JSON.stringify(url), Date.now());
}

export interface StoreUrlError {
  error: "invalid_store_url";
  message: string;
}

/** Only https on a public host: the store manifest is fetched by the server. */
export function validateStoreUrl(input: string): string | StoreUrlError {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return { error: "invalid_store_url", message: "A store URL is required." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { error: "invalid_store_url", message: "That is not a valid URL." };
  }
  if (url.protocol !== "https:") return { error: "invalid_store_url", message: "The store URL must use https." };
  if (url.username || url.password) return { error: "invalid_store_url", message: "The store URL must not carry credentials." };
  if (isBlockedHost(url.hostname)) return { error: "invalid_store_url", message: `${url.hostname} is not a public host.` };
  return url.toString();
}

export function isStoreUrlError(value: string | StoreUrlError): value is StoreUrlError {
  return typeof value !== "string";
}

export function configuredStoreUrl(
  db: PiWebDatabase = getDatabase(),
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnvironment = environment.PI_WEB_THEME_STORE_URL?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    return readStoredStoreUrl(db);
  } catch {
    return null;
  }
}

interface CacheRow {
  payload: string;
  fetched_at: number;
  expires_at: number;
}

/** Fetches and caches the store manifest; a stale copy beats an empty list. */
export async function fetchThemeStore(options: {
  db?: PiWebDatabase;
  now?: number;
  refresh?: boolean;
  environment?: NodeJS.ProcessEnv;
} = {}): Promise<ThemeStoreResult> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const url = configuredStoreUrl(db, options.environment ?? process.env);
  if (!url) {
    return { configured: false, url: null, themes: [], fetchedAt: now, fromCache: false, stale: false };
  }

  const validated = validateStoreUrl(url);
  if (isStoreUrlError(validated)) {
    return {
      configured: true,
      url,
      themes: [],
      fetchedAt: now,
      fromCache: false,
      stale: false,
      error: validated.message,
    };
  }

  const row = db.prepare("SELECT payload, fetched_at, expires_at FROM market_cache WHERE source = 'theme-store' AND cache_key = ?")
    .get(validated) as CacheRow | undefined;
  const cached = row && !options.refresh ? row : null;
  if (cached && cached.expires_at > now) {
    const parsed = safeParse(cached.payload);
    return { configured: true, url: validated, themes: parsed?.themes ?? [], fetchedAt: cached.fetched_at, fromCache: true, stale: false };
  }

  try {
    const response = await fetch(validated, {
      headers: { Accept: "application/json", "User-Agent": "pi-web-theme-store" },
      signal: AbortSignal.timeout(THEME_STORE_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseThemeStore(await response.json());
    db.prepare(`
      INSERT INTO market_cache (source, cache_key, payload, fetched_at, expires_at)
      VALUES ('theme-store', ?, ?, ?, ?)
      ON CONFLICT(source, cache_key) DO UPDATE SET
        payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
    `).run(validated, JSON.stringify(parsed), now, now + THEME_STORE_TTL_MS);
    return { configured: true, url: validated, themes: parsed.themes, fetchedAt: now, fromCache: false, stale: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cached) {
      const parsed = safeParse(cached.payload);
      return { configured: true, url: validated, themes: parsed?.themes ?? [], fetchedAt: cached.fetched_at, fromCache: true, stale: true, error: message };
    }
    return { configured: true, url: validated, themes: [], fetchedAt: now, fromCache: false, stale: false, error: message };
  }
}

function safeParse(payload: string): { themes: StoreTheme[] } | null {
  try {
    return JSON.parse(payload) as { themes: StoreTheme[] };
  } catch {
    return null;
  }
}
