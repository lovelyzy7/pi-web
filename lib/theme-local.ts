import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDatabase, type PiWebDatabase } from "./db";
import { getAllowedFileRoots, isExistingFilePathAllowed, normalizeSlashes } from "./file-access";
import { isThemeSourceError, parseThemeSource, THEME_MANIFEST_FILE, type ThemeSource } from "./theme-source";
import { isLocalThemeAllowed, isThemeResolutionError, resolveTheme } from "./theme-store";

/**
 * Local themes: finding them, and importing one into the managed directory.
 *
 * A theme may live anywhere the operator already trusts — the managed
 * `~/.pi/agent/themes/` inside the data directory, a directory listed in
 * `PI_WEB_THEME_ROOTS`, or a `themes/` folder belonging to a project. Scanning
 * saves typing `local:/abs/path`; importing copies a theme into the managed
 * directory so it survives moving or deleting the directory it came from.
 */

export const THEME_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

export type LocalThemeOrigin = "managed" | "configured" | "project";

export interface LocalThemeEntry {
  /** Pi Web theme source, ready to apply (`local:/abs/path`). */
  source: string;
  directory: string;
  origin: LocalThemeOrigin;
  name: string;
  id: string;
  version: string;
  author: string;
  base: "light" | "dark";
  /** Per-locale description from the manifest, shown on the card. */
  description: Record<string, string>;
  homepage: string | null;
  /** Variant stylesheets the manifest declares (`light`/`dark`/…). */
  variants: string[];
  /** True when this directory already is the managed copy. */
  managed: boolean;
}

export interface LocalThemeScanResult {
  roots: { directory: string; origin: LocalThemeOrigin; exists: boolean }[];
  themes: LocalThemeEntry[];
}

export function getManagedThemesDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "themes");
}

/** `_template`, `.git` and similar bookkeeping are not themes. */
function isThemeDirectoryName(name: string): boolean {
  return !name.startsWith("_") && !name.startsWith(".");
}

function configuredRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  return (environment.PI_WEB_THEME_ROOTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * The directories that are searched, in the order they are shown.
 *
 * `cwd` is optional: the settings panel knows the selected project, and a
 * project may carry its own themes next to the code it belongs to.
 */
export function themeScanRoots(
  options: { cwd?: string | null; agentDir?: string; environment?: NodeJS.ProcessEnv } = {},
): { directory: string; origin: LocalThemeOrigin }[] {
  const roots: { directory: string; origin: LocalThemeOrigin }[] = [
    { directory: getManagedThemesDir(options.agentDir), origin: "managed" },
  ];
  for (const configured of configuredRoots(options.environment)) {
    roots.push({ directory: resolve(configured), origin: "configured" });
  }
  const cwd = options.cwd?.trim();
  if (cwd) {
    roots.push({ directory: join(resolve(cwd), "themes"), origin: "project" });
    roots.push({ directory: join(resolve(cwd), ".pi", "themes"), origin: "project" });
  }

  // Deduplicate by resolved path: a configured root may be the managed dir.
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = normalizeSlashes(resolve(root.directory)).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ScanOptions {
  cwd?: string | null;
  agentDir?: string;
  environment?: NodeJS.ProcessEnv;
  /** Precomputed allowed roots; project folders are only read inside them. */
  allowedRoots?: Set<string>;
}

export async function scanLocalThemes(options: ScanOptions = {}): Promise<LocalThemeScanResult> {
  const managedDir = resolve(getManagedThemesDir(options.agentDir));
  const allowedRoots = options.allowedRoots ?? (await getAllowedFileRoots());
  const roots = themeScanRoots(options);
  const themes: LocalThemeEntry[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    if (!existsSync(root.directory) || !statSync(root.directory).isDirectory()) continue;
    // The managed directory and configured roots are trusted by construction;
    // a project folder is only read when the caller may browse that project.
    if (root.origin === "project" && !isExistingFilePathAllowed(root.directory, allowedRoots)) continue;

    for (const entry of readdirSync(root.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isThemeDirectoryName(entry.name)) continue;
      const directory = join(root.directory, entry.name);
      if (!existsSync(join(directory, THEME_MANIFEST_FILE))) continue;

      const key = normalizeSlashes(resolve(directory)).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const summary = readThemeSummary(directory);
      if (!summary) continue;
      themes.push({
        source: `local:${directory}`,
        directory,
        origin: root.origin,
        managed: normalize(resolve(directory, "..")).toLowerCase() === normalize(managedDir).toLowerCase(),
        ...summary,
      });
    }
  }

  return {
    roots: roots.map((root) => ({ ...root, exists: existsSync(root.directory) })),
    themes,
  };
}

interface ThemeSummary {
  name: string;
  id: string;
  version: string;
  author: string;
  base: "light" | "dark";
  description: Record<string, string>;
  homepage: string | null;
  variants: string[];
}

/** A cheap read for the list: `resolveTheme` runs the full validation later. */
function readThemeSummary(directory: string): ThemeSummary | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(join(directory, THEME_MANIFEST_FILE), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text = (value: unknown): string => (typeof value === "string" && value.trim() ? value.trim() : "");
  // The card shows the same fields as a store entry, so the description and the
  // variant count come from the manifest rather than being invented client-side.
  const description: Record<string, string> = {};
  if (typeof parsed.description === "object" && parsed.description !== null) {
    for (const [locale, value] of Object.entries(parsed.description as Record<string, unknown>)) {
      const line = text(value);
      if (line) description[locale] = line;
    }
  }
  return {
    name: text(parsed.name) || directory.split(sep).pop() || "theme",
    id: text(parsed.id),
    version: text(parsed.version) || "0.0.0",
    author: text(parsed.author) || "unknown",
    base: parsed.base === "dark" ? "dark" : "light",
    description,
    homepage: text(parsed.homepage) || null,
    variants: typeof parsed.variants === "object" && parsed.variants !== null
      ? Object.keys(parsed.variants as Record<string, unknown>)
      : [],
  };
}

/** Refuses symlinks: an import must not pull in whatever a link points at. */
function assertNoSymlinks(directory: string): void {
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (lstatSync(target).isSymbolicLink()) {
        throw new Error(`The theme contains a symbolic link (${target}); an import must be self-contained.`);
      }
      if (entry.isDirectory()) stack.push(target);
    }
  }
}

function directorySize(directory: string): number {
  let total = 0;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) total += statSync(target).size;
    }
  }
  return total;
}

export interface ThemeImportSuccess {
  source: string;
  directory: string;
  entry: LocalThemeEntry;
}

export interface ThemeLocalError {
  error: "blocked_path" | "not_found" | "invalid_theme" | "too_large" | "exists" | "failed";
  message: string;
}

export type ImportResult = ThemeImportSuccess | ThemeLocalError;

export function isThemeLocalError(value: ImportResult | { ok: true } | { ok: false }): value is ThemeLocalError {
  return (value as ThemeLocalError).error !== undefined;
}

export function themeLocalError(error: ThemeLocalError["error"], message: string): ThemeLocalError {
  return { error, message };
}

/**
 * Copies a validated local theme into `~/.pi/agent/themes/<id>`.
 *
 * Validation happens before anything is copied, so an import cannot install a
 * theme the server would later refuse to apply. The managed copy is what the
 * operator applies and what survives deleting the directory it came from.
 */
export async function importLocalTheme(
  sourceInput: string,
  options: { overwrite?: boolean; agentDir?: string; db?: PiWebDatabase } = {},
): Promise<ImportResult> {
  const raw = sourceInput.trim();
  const parsed = parseThemeSource(raw.startsWith("local:") ? raw : `local:${raw}`);
  if (isThemeSourceError(parsed) || parsed.kind !== "local" || !parsed.localPath) {
    return themeLocalError("not_found", "Give an absolute directory that contains a theme.json.");
  }

  const directory = resolve(parsed.localPath);
  if (!existsSync(join(directory, THEME_MANIFEST_FILE))) {
    return themeLocalError("not_found", `${directory} has no ${THEME_MANIFEST_FILE}.`);
  }
  if (!(await isLocalThemeAllowed(directory))) {
    return themeLocalError("blocked_path", "That directory is not one Pi Web may read themes from.");
  }

  const resolved = await resolveTheme(parsed, { db: options.db ?? getDatabase() });
  if (isThemeResolutionError(resolved)) {
    return themeLocalError("invalid_theme", resolved.message);
  }

  let size: number;
  try {
    size = directorySize(directory);
  } catch {
    return themeLocalError("failed", "Could not read the theme directory.");
  }
  if (size > THEME_IMPORT_MAX_BYTES) {
    return themeLocalError(
      "too_large",
      `The theme is larger than ${Math.round(THEME_IMPORT_MAX_BYTES / (1024 * 1024))} MiB.`,
    );
  }

  const managedDir = getManagedThemesDir(options.agentDir);
  const target = join(managedDir, resolved.manifest.id);
  if (normalize(resolve(target)).toLowerCase() === normalize(directory).toLowerCase()) {
    return themeLocalError("exists", "This directory already is the managed copy.");
  }
  if (existsSync(target)) {
    if (!options.overwrite) {
      return themeLocalError("exists", `${target} already exists. Import again to replace it.`);
    }
    rmSync(target, { recursive: true, force: true });
  }

  try {
    assertNoSymlinks(directory);
    mkdirSync(managedDir, { recursive: true });
    cpSync(directory, target, { recursive: true, force: true, errorOnExist: false });
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    return themeLocalError("failed", error instanceof Error ? error.message : String(error));
  }

  const source = `local:${target}`;
  return {
    source,
    directory: target,
    entry: {
      source,
      directory: target,
      origin: "managed",
      managed: true,
      name: resolved.manifest.name,
      id: resolved.manifest.id,
      version: resolved.manifest.version,
      author: resolved.manifest.author,
      base: resolved.manifest.base,
      description: resolved.manifest.description ?? {},
      homepage: resolved.manifest.homepage ?? null,
      variants: Object.keys(resolved.manifest.variants ?? {}),
    },
  };
}

/**
 * Removes an imported theme. Only a directory directly inside the managed
 * themes directory can be removed, so a hand-written project theme is never
 * deleted by the panel.
 */
export function removeManagedTheme(
  sourceInput: string,
  options: { agentDir?: string } = {},
): { ok: true; directory: string } | ThemeLocalError {
  const raw = sourceInput.trim();
  const parsed = parseThemeSource(raw.startsWith("local:") ? raw : `local:${raw}`);
  if (isThemeSourceError(parsed) || parsed.kind !== "local" || !parsed.localPath) {
    return themeLocalError("not_found", "Not a local theme.");
  }

  const managedDir = resolve(getManagedThemesDir(options.agentDir));
  const directory = resolve(parsed.localPath);
  if (resolve(directory, "..") !== managedDir || directory === managedDir) {
    return themeLocalError(
      "blocked_path",
      `Only themes imported into ${managedDir} can be removed here.`,
    );
  }
  if (!existsSync(directory)) {
    return themeLocalError("not_found", `${directory} no longer exists.`);
  }

  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    return themeLocalError("failed", error instanceof Error ? error.message : String(error));
  }
  return { ok: true, directory };
}

export type { ThemeSource };
