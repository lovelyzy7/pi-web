import { readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed, normalizeSlashes } from "./file-access";
import { getDatabase, type PiWebDatabase } from "./db";
import {
  THEME_DEFAULT_STYLE,
  THEME_MANIFEST_FILE,
  type ThemeManifest,
  type ThemeValidationIssue,
  type ThemeValidationResult,
  checkThemeContrast,
  parseThemeManifest,
  satisfiesPiWeb,
  validateThemeCss,
} from "./theme-manifest";
import {
  type ThemeSource,
  THEME_ASSET_CONTENT_TYPES,
  themeAssetUrl,
  themeContentType,
} from "./theme-source";

/**
 * Theme storage: fetch, validate, cache, and serve.
 *
 * Parsed results and file bodies live in `market_cache`, so a restart does not
 * refetch and an offline instance still serves the applied theme. Commit-pinned
 * sources are cached as immutable, branches and plain URLs for an hour, and local
 * directories are read from disk every time (that is what makes them useful while
 * developing a theme).
 */

export const ACTIVE_THEME_SETTING = "theme:active";
export const THEME_BRANCH_TTL_MS = 60 * 60 * 1000;
export const THEME_COMMIT_TTL_MS = 24 * 60 * 60 * 1000;
export const THEME_FETCH_TIMEOUT_MS = 10_000;

export interface ActiveTheme {
  source: string;
  display: string;
  manifest: ThemeManifest;
  /** Commit sha when the source was pinned, otherwise the branch name. */
  ref: string;
  appliedAt: number;
}

export interface ResolvedTheme {
  source: ThemeSource;
  manifest: ThemeManifest;
  css: string;
  issues: ThemeValidationIssue[];
  validation: ThemeValidationResult;
  fromCache: boolean;
  stale: boolean;
}

export interface ThemeFile {
  body: string;
  contentType: string;
  fromCache: boolean;
}

function cacheKey(source: ThemeSource, path: string): string {
  return `${source.source}::${path}`;
}

interface CacheRow {
  payload: string;
  fetched_at: number;
  expires_at: number;
}

function readCache(db: PiWebDatabase, source: ThemeSource, path: string): CacheRow | null {
  const row = db.prepare("SELECT payload, fetched_at, expires_at FROM market_cache WHERE source = 'theme' AND cache_key = ?")
    .get(cacheKey(source, path)) as CacheRow | undefined;
  return row ?? null;
}

function writeCache(db: PiWebDatabase, source: ThemeSource, path: string, body: string, now: number, ttlMs: number): void {
  db.prepare(`
    INSERT INTO market_cache (source, cache_key, payload, fetched_at, expires_at)
    VALUES ('theme', ?, ?, ?, ?)
    ON CONFLICT(source, cache_key) DO UPDATE SET
      payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at
  `).run(cacheKey(source, path), body, now, now + ttlMs);
}

/** Local themes are read straight from disk so `npm run dev` sees edits. */
function readLocalFile(source: ThemeSource, path: string): string {
  const root = normalize(source.localPath ?? "");
  const target = normalize(join(root, path));
  if (!target.startsWith(root)) throw new Error("Theme path escapes its directory.");
  return readFileSync(target, "utf8");
}

async function fetchRemoteFile(source: ThemeSource, path: string): Promise<string | null> {
  const url = themeAssetUrl(source, path);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      headers: { Accept: "*/*", "User-Agent": "pi-web-theme" },
      redirect: "follow",
      signal: AbortSignal.timeout(THEME_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    const body = await response.text();
    const limit = path.endsWith(".css") ? 512 * 1024 : 2 * 1024 * 1024;
    if (declared > limit || body.length > limit) return null;
    return body;
  } catch {
    return null;
  }
}

export interface ThemeFileSource {
  body: string;
  fromCache: boolean;
}

/** Reads one file of a theme, honouring the cache policy of its source kind. */
export async function readThemeFile(
  source: ThemeSource,
  path: string,
  options: { db?: PiWebDatabase; now?: number; refresh?: boolean } = {},
): Promise<ThemeFileSource | null> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();

  if (source.kind === "local") {
    try {
      return { body: readLocalFile(source, path), fromCache: false };
    } catch {
      return null;
    }
  }

  const cached = options.refresh ? null : readCache(db, source, path);
  if (cached && cached.expires_at > now) return { body: cached.payload, fromCache: true };

  const body = await fetchRemoteFile(source, path);
  if (body === null) {
    // Serving a stale copy beats an unusable theme when the network is down.
    return cached ? { body: cached.payload, fromCache: true } : null;
  }

  writeCache(db, source, path, body, now, source.immutable ? THEME_COMMIT_TTL_MS : THEME_BRANCH_TTL_MS);
  return { body, fromCache: false };
}

export interface ThemeResolutionError {
  error: "unreachable" | "invalid_manifest" | "invalid_css" | "incompatible";
  message: string;
  issues: ThemeValidationIssue[];
}

export function isThemeResolutionError(value: ResolvedTheme | ThemeResolutionError): value is ThemeResolutionError {
  return (value as ThemeResolutionError).error !== undefined;
}

/**
 * Fetches, parses, and validates a theme. Nothing is persisted here: `POST
 * /api/themes` decides whether the result is good enough to apply.
 */
export async function resolveTheme(
  source: ThemeSource,
  options: {
    db?: PiWebDatabase;
    now?: number;
    refresh?: boolean;
    currentVersion?: string;
  } = {},
): Promise<ResolvedTheme | ThemeResolutionError> {
  const manifestFile = await readThemeFile(source, THEME_MANIFEST_FILE, options);
  if (!manifestFile) {
    return {
      error: "unreachable",
      message: `Could not read ${THEME_MANIFEST_FILE} from ${source.display}. Check the source and that the ref exists.`,
      issues: [],
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(manifestFile.body);
  } catch {
    return { error: "invalid_manifest", message: "theme.json is not valid JSON.", issues: [] };
  }

  const parsed = parseThemeManifest(parsedJson);
  if (!parsed.manifest) {
    return { error: "invalid_manifest", message: "theme.json is missing required fields.", issues: parsed.issues };
  }

  const stylePath = parsed.manifest.styles[0] ?? THEME_DEFAULT_STYLE;
  const cssFile = await readThemeFile(source, stylePath, options);
  if (!cssFile) {
    return {
      error: "unreachable",
      message: `Could not read ${stylePath} from ${source.display}.`,
      issues: parsed.issues,
    };
  }

  const validation = validateThemeCss(cssFile.body, { manifest: parsed.manifest });
  const issues = [...parsed.issues, ...validation.issues, ...checkThemeContrast(cssFile.body)];

  // A declared variant is part of the theme: it must exist and pass the same
  // checks, or the theme is refused rather than half-applied in one mode.
  for (const [mode, file] of Object.entries(parsed.manifest.variants)) {
    const variant = await readThemeFile(source, file, options);
    if (!variant) {
      issues.push({ level: "error", message: `Variant "${mode}" (${file}) could not be read.` });
      continue;
    }
    const variantValidation = validateThemeCss(variant.body, { manifest: parsed.manifest });
    issues.push(...variantValidation.issues, ...checkThemeContrast(variant.body));
    for (const variable of variantValidation.overriddenVariables) {
      if (!validation.overriddenVariables.includes(variable)) validation.overriddenVariables.push(variable);
    }
  }

  // The base stylesheet may hold only shared rules (cursors, textures) while the
  // variants carry the palettes, so the "overrides nothing" note is dropped once
  // the theme as a whole overrides something.
  const reported = validation.overriddenVariables.length > 0
    ? issues.filter((issue) => issue.code !== "no-variables")
    : issues;
  const errors = reported.filter((issue) => issue.level === "error");
  if (errors.length > 0) {
    return { error: "invalid_css", message: errors[0].message, issues: reported };
  }

  const currentVersion = options.currentVersion ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
  if (!satisfiesPiWeb(parsed.manifest.piWeb, currentVersion)) {
    issues.push({
      level: "warning",
      message: `This theme targets Pi Web ${parsed.manifest.piWeb}, but this build is ${currentVersion}.`,
    });
  }

  return {
    source,
    manifest: parsed.manifest,
    css: cssFile.body,
    issues: reported,
    validation,
    fromCache: manifestFile.fromCache && cssFile.fromCache,
    stale: false,
  };
}

/**
 * Where a local theme may live.
 *
 * A directory theme is read straight from disk, so it has to sit somewhere the
 * operator already trusts: inside a browsable root (a project, a session cwd) or
 * in `~/.pi/agent/themes`, which is inside the mounted data directory and is the
 * documented place to drop one. `..` never escapes: the whitelist in
 * `normalizeThemeAssetPath` and the root check both run first.
 */
export async function isLocalThemeAllowed(
  path: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const roots = await getAllowedFileRoots();
  if (isExistingFilePathAllowed(path, roots)) return true;

  const extra = new Set<string>([normalizeSlashes(join(getAgentDir(), "themes"))]);
  for (const configured of (environment.PI_WEB_THEME_ROOTS ?? "").split(",")) {
    const trimmed = configured.trim();
    if (trimmed) extra.add(normalizeSlashes(trimmed));
  }
  return isExistingFilePathAllowed(path, extra);
}

/* -------------------------------------------------------------------------- */
/* Active theme                                                                */
/* -------------------------------------------------------------------------- */

interface ActiveThemeRow {
  value: string;
}

export function readActiveTheme(db: PiWebDatabase = getDatabase()): ActiveTheme | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(ACTIVE_THEME_SETTING) as
    | ActiveThemeRow
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as ActiveTheme;
    if (!parsed?.source || !parsed.manifest?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeActiveTheme(active: ActiveTheme, db: PiWebDatabase = getDatabase()): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(ACTIVE_THEME_SETTING, JSON.stringify(active), Date.now());
}

export function clearActiveTheme(db: PiWebDatabase = getDatabase()): void {
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(ACTIVE_THEME_SETTING);
}

/**
 * Reads the applied theme's stylesheet for the document head. Returns null when
 * nothing is applied, when the source has gone missing, or when the database is
 * unavailable — the app then simply renders with its built-in palette.
 */
export async function readActiveThemeCss(db: PiWebDatabase = getDatabase()): Promise<{
  active: ActiveTheme;
  css: string;
} | null> {
  const active = readActiveTheme(db);
  if (!active) return null;

  const { parseThemeSource, isThemeSourceError } = await import("./theme-source");
  const parsed = parseThemeSource(active.source);
  if (isThemeSourceError(parsed)) return null;

  const file = await readThemeFile(parsed, THEME_DEFAULT_STYLE, { db });
  if (!file) return null;
  return { active, css: file.body };
}

/** The cookie that points the real UI at a theme without applying it. */
// Defined in `lib/theme-safety.ts`, which client components may import.
export { THEME_PREVIEW_COOKIE, THEME_PREVIEW_TTL_SECONDS } from "./theme-safety";

/**
 * Resolves a preview source into the same shape as an applied theme, so the
 * layout can render it identically. Returns null when the source is invalid,
 * not allowed, or unreadable — a broken preview must never blank the app.
 */
export async function resolvePreviewTheme(
  sourceInput: string | null | undefined,
  options: { db?: PiWebDatabase } = {},
): Promise<ActiveTheme | null> {
  if (!sourceInput) return null;
  const db = options.db ?? getDatabase();
  try {
    const { isThemeSourceError, parseThemeSource } = await import("./theme-source");
    const parsed = parseThemeSource(sourceInput);
    if (isThemeSourceError(parsed)) return null;
    if (parsed.kind === "local" && !await isLocalThemeAllowed(parsed.localPath as string)) return null;

    const resolved = await resolveTheme(parsed, { db });
    if (isThemeResolutionError(resolved)) return null;
    return {
      source: resolved.source.source,
      display: resolved.source.display,
      manifest: resolved.manifest,
      ref: resolved.source.ref ?? "local",
      appliedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Asset serving                                                               */
/* -------------------------------------------------------------------------- */

const THEME_CONTENT_TYPES = THEME_ASSET_CONTENT_TYPES;

/**
 * Serves one theme file to the browser. Only whitelisted paths reach the
 * network, and the caller (the route) enforces that the source is the applied
 * one unless it is explicitly previewing.
 */
export async function serveThemeFile(
  source: ThemeSource,
  path: string,
  options: { db?: PiWebDatabase; refresh?: boolean } = {},
): Promise<ThemeFile | null> {
  const file = await readThemeFile(source, path, options);
  if (!file) return null;
  const contentType = THEME_CONTENT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? themeContentType(path);
  return { body: file.body, contentType, fromCache: file.fromCache };
}

export function themeContentTypeFor(path: string): string {
  return themeContentType(path);
}

/**
 * Reads just the `version` from a theme's manifest, cached like any other theme
 * file. Used by the store list, which needs a version per entry but not a full
 * validation for each one.
 */
export async function readThemeVersion(
  source: ThemeSource,
  options: { db?: PiWebDatabase; now?: number; refresh?: boolean } = {},
): Promise<string | null> {
  const file = await readThemeFile(source, THEME_MANIFEST_FILE, options);
  if (!file) return null;
  try {
    const parsed = JSON.parse(file.body) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0";
  } catch {
    return null;
  }
}

/** Resolves versions for a list of sources, a few at a time. */
export async function resolveThemeVersions(
  sources: { source: string; version: string | null }[],
  options: { db?: PiWebDatabase; refresh?: boolean } = {},
): Promise<Record<string, string | null>> {
  const { isThemeSourceError, parseThemeSource } = await import("./theme-source");
  const result: Record<string, string | null> = {};
  const pending = sources.filter((entry) => {
    if (entry.version) {
      result[entry.source] = entry.version;
      return false;
    }
    return true;
  });

  let index = 0;
  const worker = async () => {
    while (index < pending.length) {
      const entry = pending[index++];
      const parsed = parseThemeSource(entry.source);
      result[entry.source] = isThemeSourceError(parsed)
        ? null
        : await readThemeVersion(parsed, options).catch(() => null);
    }
  };
  // Four at a time: enough to fill the panel quickly, gentle on the registry.
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  return result;
}

export function themeFileMtime(source: ThemeSource, path: string): number | null {
  if (source.kind !== "local" || !source.localPath) return null;
  try {
    return statSync(join(normalize(source.localPath), path)).mtimeMs;
  } catch {
    return null;
  }
}
