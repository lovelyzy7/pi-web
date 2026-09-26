import { THEME_DEFAULT_STYLE, THEME_MANIFEST_FILE, THEME_SCOPE_SELECTOR, THEME_VARIANT_STYLE } from "./theme-source.ts";

/**
 * Theme manifest and stylesheet validation.
 *
 * A theme is data, not code: a manifest plus CSS that may only override the
 * documented variables inside the theme scope. Everything a theme could use to
 * escape that shape — external URLs, unscoped selectors, `@import` — is rejected
 * here, before anything reaches the browser.
 */

/** Colours a theme may override. Everything else stays under Pi Web's control. */
export const THEMEABLE_VARIABLES = [
  "--bg",
  "--bg-panel",
  "--bg-hover",
  "--bg-selected",
  "--bg-subtle",
  "--border",
  "--text",
  "--text-muted",
  "--text-dim",
  "--accent",
  "--accent-hover",
  "--accent-contrast",
  "--user-bg",
  "--assistant-bg",
  "--tool-bg",
  "--danger",
  "--success",
  "--warning",
  "--info",
  "--terminal-bg",
  "--terminal-fg",
  "--terminal-cursor",
  "--qr-bg",
] as const;

/**
 * Variables that describe the user's own layout choices. A theme that sets them
 * would silently override the chat appearance sliders.
 */
export const RESERVED_VARIABLES = [
  "--chat-content-max-width",
  "--chat-content-font-size",
  "--sidebar-width",
  "--right-panel-width",
  "--chat-font-size-offset",
  "--font-mono",
  "--font-noto-mono",
] as const;

export const THEMEABLE_VARIABLE_SET = new Set<string>(THEMEABLE_VARIABLES);
export const RESERVED_VARIABLE_SET = new Set<string>(RESERVED_VARIABLES);

export const THEME_SCHEMA_VERSION = 1;
export const MAX_THEME_CSS_BYTES = 512 * 1024;
export const MAX_THEME_ASSET_BYTES = 2 * 1024 * 1024;

export interface ThemeManifest {
  schema: number;
  id: string;
  name: string;
  version: string;
  author: string;
  description: Record<string, string>;
  base: "light" | "dark";
  piWeb: string | null;
  homepage: string | null;
  license: string | null;
  styles: string[];
  /** Mode → stylesheet, e.g. `{ light: "theme.light.css", dark: "theme.dark.css" }`. */
  variants: Record<string, string>;
  assets: string[];
  declaredVariables: string[];
}

export interface ThemeValidationIssue {
  level: "error" | "warning";
  message: string;
  /**
   * Stable identifier for issues a caller may want to drop once it has the whole
   * picture — a theme whose base file only holds shared rules is fine as long as
   * one of its variants overrides variables.
   */
  code?: "no-variables";
}

export interface ThemeValidationResult {
  manifest: ThemeManifest | null;
  issues: ThemeValidationIssue[];
  /** Variables the stylesheet actually assigns, in first-seen order. */
  overriddenVariables: string[];
  scopeViolations: string[];
  externalUrls: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function asDescription(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, text]) => typeof text === "string" && text.trim().length > 0)
    .map(([locale, text]) => [locale, (text as string).trim()]);
  return Object.fromEntries(entries);
}

/** Parse and sanity-check a manifest. Structural problems are errors. */
export function parseThemeManifest(raw: unknown): { manifest: ThemeManifest | null; issues: ThemeValidationIssue[] } {
  const issues: ThemeValidationIssue[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { manifest: null, issues: [{ level: "error", message: "theme.json must be a JSON object." }] };
  }
  const input = raw as Record<string, unknown>;

  const schema = Number(input.schema ?? 0);
  if (!Number.isSafeInteger(schema) || schema < 1) {
    issues.push({ level: "error", message: "theme.json needs a positive integer `schema`." });
  } else if (schema > THEME_SCHEMA_VERSION) {
    issues.push({
      level: "error",
      message: `This theme targets schema ${schema}, but this build understands ${THEME_SCHEMA_VERSION}.`,
    });
  }

  const id = asString(input.id);
  if (!id || !ID_PATTERN.test(id)) {
    issues.push({ level: "error", message: "`id` must be lowercase letters, digits, and dashes (max 41 characters)." });
  }

  const name = asString(input.name) ?? id;
  if (!name) issues.push({ level: "error", message: "`name` is required." });

  const version = asString(input.version);
  if (version && !VERSION_PATTERN.test(version)) {
    issues.push({ level: "warning", message: "`version` should look like 1.2.3." });
  }

  const base = input.base === "light" || input.base === "dark" ? input.base : null;
  if (!base) {
    issues.push({ level: "error", message: "`base` must be \"light\" or \"dark\" — it decides the built-in palette the theme starts from." });
  }

  const styles = asStringArray(input.styles);
  const effectiveStyles = styles.length > 0 ? styles : [THEME_DEFAULT_STYLE];
  if (effectiveStyles.some((style) => style !== THEME_DEFAULT_STYLE && !style.startsWith("assets/"))) {
    issues.push({ level: "error", message: "`styles` may only reference theme.css or files under assets/." });
  }

  const variants: Record<string, string> = {};
  const rawVariants = input.variants;
  if (rawVariants !== undefined) {
    if (typeof rawVariants !== "object" || rawVariants === null || Array.isArray(rawVariants)) {
      issues.push({ level: "error", message: "`variants` must be an object mapping a mode to a stylesheet." });
    } else {
      for (const [mode, file] of Object.entries(rawVariants as Record<string, unknown>)) {
        const value = asString(file);
        if (!/^(light|dark|[a-z0-9-]{1,20})$/.test(mode) || !value || !(value === THEME_DEFAULT_STYLE || THEME_VARIANT_STYLE.test(value))) {
          issues.push({
            level: "error",
            message: `Variant "${mode}" must map to theme.<name>.css (got ${JSON.stringify(file)}).`,
          });
          continue;
        }
        variants[mode] = value;
      }
    }
  }

  const manifest: ThemeManifest | null = issues.some((issue) => issue.level === "error") ? null : {
    schema: schema || THEME_SCHEMA_VERSION,
    id: id as string,
    name: name as string,
    version: version ?? "0.0.0",
    author: asString(input.author) ?? "unknown",
    description: asDescription(input.description),
    base: base as "light" | "dark",
    piWeb: asString(input.piWeb),
    homepage: asString(input.homepage),
    license: asString(input.license),
    styles: effectiveStyles,
    variants,
    assets: asStringArray(input.assets).filter((asset) => asset.startsWith("assets/")),
    declaredVariables: asStringArray(input.variables).filter((variable) => variable.startsWith("--")),
  };

  return { manifest, issues };
}

/** `>=0.9 <1.0` style ranges, evaluated against the running Pi Web version. */
export function satisfiesPiWeb(range: string | null | undefined, currentVersion: string): boolean {
  const trimmed = range?.trim();
  if (!trimmed) return true;

  const current = /^(\d+)\.(\d+)\.(\d+)/.exec(currentVersion);
  if (!current) return true;
  const currentParts = [Number(current[1]), Number(current[2]), Number(current[3])];

  const compare = (a: number[], b: number[]): number => {
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  };

  // Space-separated comparators, all of which must hold.
  for (const comparator of trimmed.split(/\s+/).filter(Boolean)) {
    const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparator);
    if (!match) continue;
    const [, operator = "=", major, minor = "0", patch = "0"] = match;
    const target = [Number(major), Number(minor), Number(patch)];
    const ordering = compare(currentParts, target);

    // Caret and tilde follow semver: `^0.9.0` stops before 0.10.0, because a
    // 0.x minor bump is treated as breaking.
    const caretUpper = target[0] > 0
      ? [target[0] + 1, 0, 0]
      : target[1] > 0 ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1];
    const tildeUpper = [target[0], target[1] + 1, 0];

    const ok = operator === "^"
      ? ordering >= 0 && compare(currentParts, caretUpper) < 0
      : operator === "~"
        ? ordering >= 0 && compare(currentParts, tildeUpper) < 0
        : operator === ">=" ? ordering >= 0
          : operator === "<=" ? ordering <= 0
            : operator === ">" ? ordering > 0
              : operator === "<" ? ordering < 0
                : ordering === 0;
    if (!ok) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Stylesheet validation                                                       */
/* -------------------------------------------------------------------------- */

interface CssRule {
  selector: string;
  body: string;
}

const ALLOWED_AT_RULES = new Set(["media", "supports", "layer", "container", "keyframes", "-webkit-keyframes"]);

/** Strips comments so brace counting and selector checks see only real syntax. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Walks top-level blocks, returning rules and at-rule bodies. */
function walkBlocks(css: string): { rules: CssRule[]; atRules: { name: string; body: string }[]; malformed: boolean } {
  const rules: CssRule[] = [];
  const atRules: { name: string; body: string }[] = [];
  let index = 0;
  let malformed = false;

  while (index < css.length) {
    const nextBrace = css.indexOf("{", index);
    const nextSemicolon = css.indexOf(";", index);
    if (nextBrace === -1 && nextSemicolon === -1) break;
    if (nextBrace === -1 || (nextSemicolon !== -1 && nextSemicolon < nextBrace)) {
      // A statement without a block, e.g. `@import url(...)` or `@charset`.
      const statement = css.slice(index, nextSemicolon).trim();
      if (/^@/i.test(statement)) atRules.push({ name: statement.split(/[\s(]/, 1)[0].toLowerCase(), body: statement });
      else malformed = true;
      index = nextSemicolon + 1;
      continue;
    }

    const selector = css.slice(index, nextBrace).trim();
    let depth = 1;
    let cursor = nextBrace + 1;
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === "{") depth += 1;
      else if (css[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) {
      malformed = true;
      break;
    }
    const body = css.slice(nextBrace + 1, cursor - 1);
    if (selector.startsWith("@")) atRules.push({ name: selector.split(/[\s(]/, 1)[0].toLowerCase(), body });
    else rules.push({ selector, body });
    index = cursor;
  }

  return { rules, atRules, malformed };
}

function selectorIsScoped(selector: string): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .every((part) => part.startsWith(THEME_SCOPE_SELECTOR));
}

function externalUrls(css: string): string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const value = match[2].trim();
    if (/^data:/i.test(value) || value.startsWith("#") || value.startsWith("assets/") || value.startsWith("/assets/")) continue;
    if (/^var\(/i.test(value)) continue;
    found.push(value);
  }
  return found;
}

/**
 * Validates a theme stylesheet: scoped selectors, no imports, no external
 * resources, and only documented variables. Returns issues rather than throwing
 * so the UI can show a report before anything is applied.
 */
export function validateThemeCss(
  css: string,
  options: { manifest?: ThemeManifest | null } = {},
): ThemeValidationResult {
  const issues: ThemeValidationIssue[] = [];
  const scopeViolations: string[] = [];
  const result: ThemeValidationResult = {
    manifest: options.manifest ?? null,
    issues,
    overriddenVariables: [],
    scopeViolations,
    externalUrls: [],
  };

  if (css.length > MAX_THEME_CSS_BYTES) {
    issues.push({ level: "error", message: `theme.css is larger than ${Math.round(MAX_THEME_CSS_BYTES / 1024)} KiB.` });
    return result;
  }

  const clean = stripComments(css);
  const { rules, atRules, malformed } = walkBlocks(clean);
  if (malformed) issues.push({ level: "error", message: "theme.css has unbalanced braces or a stray statement." });

  for (const atRule of atRules) {
    const name = atRule.name.replace(/^@/, "");
    if (name === "import") {
      issues.push({ level: "error", message: "@import is not allowed: themes must be self-contained." });
      continue;
    }
    if (name === "charset" || name === "layer") continue;
    if (!ALLOWED_AT_RULES.has(name)) {
      issues.push({ level: "error", message: `At-rule @${name} is not allowed in a theme.` });
      continue;
    }
    if (name === "media" || name === "supports" || name === "container") {
      const inner = walkBlocks(atRule.body);
      for (const rule of inner.rules) {
        if (!selectorIsScoped(rule.selector)) scopeViolations.push(rule.selector.trim().slice(0, 120));
      }
    }
  }

  for (const rule of rules) {
    if (!selectorIsScoped(rule.selector)) scopeViolations.push(rule.selector.trim().slice(0, 120));
  }
  if (scopeViolations.length > 0) {
    issues.push({
      level: "error",
      message: `Every selector must start with ${THEME_SCOPE_SELECTOR}. Offending selectors: ${scopeViolations.slice(0, 3).join(" | ")}`,
    });
  }

  const externals = externalUrls(clean);
  result.externalUrls = externals;
  if (externals.length > 0) {
    issues.push({
      level: "error",
      message: `Theme files may not reference external URLs; bundle them under assets/ instead. Found: ${externals.slice(0, 3).join(", ")}`,
    });
  }

  if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(clean)) {
    issues.push({ level: "error", message: "The stylesheet contains a construct that is not allowed in a theme." });
  }

  const declared = [...clean.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1]);
  const unique = [...new Set(declared)];
  result.overriddenVariables = unique.filter((name) => THEMEABLE_VARIABLE_SET.has(name));

  const reserved = unique.filter((name) => RESERVED_VARIABLE_SET.has(name));
  if (reserved.length > 0) {
    issues.push({
      level: "warning",
      message: `These variables belong to the user's own settings and will be ignored at runtime: ${reserved.join(", ")}`,
    });
  }
  const unknown = unique.filter((name) => !THEMEABLE_VARIABLE_SET.has(name) && !RESERVED_VARIABLE_SET.has(name));
  if (unknown.length > 0) {
    issues.push({ level: "warning", message: `Unknown variables (ignored by Pi Web): ${unknown.slice(0, 6).join(", ")}` });
  }
  if (result.overriddenVariables.length === 0 && issues.every((issue) => issue.level !== "error")) {
    issues.push({
      level: "warning",
      code: "no-variables",
      message: "The stylesheet does not override any of the documented theme variables.",
    });
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Contrast                                                                    */
/* -------------------------------------------------------------------------- */

export function parseHexColor(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two `#rrggbb` colours, or null when unparsable. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (!fg || !bg) return null;
  const [lighter, darker] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Reads `--name: value` pairs out of a stylesheet, first definition winning. */
export function readThemeVariables(css: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of stripComments(css).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi)) {
    if (!values.has(match[1])) values.set(match[1], match[2].trim());
  }
  return values;
}

/**
 * Compares `--text` against `--bg` (and the accent against its contrast colour)
 * when the theme defines them, and reports anything below WCAG AA.
 */
export function checkThemeContrast(css: string): ThemeValidationIssue[] {
  const issues: ThemeValidationIssue[] = [];
  const values = readThemeVariables(css);
  const pairs: [string, string, string][] = [
    ["--text", "--bg", "Body text"],
    ["--text-muted", "--bg", "Muted text"],
    ["--accent-contrast", "--accent", "Accent button label"],
  ];

  for (const [foreground, background, label] of pairs) {
    const fg = values.get(foreground);
    const bg = values.get(background);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio !== null && ratio < 4.5) {
      issues.push({
        level: "warning",
        message: `${label} (${foreground} on ${background}) has a contrast ratio of ${ratio.toFixed(1)}:1, below the WCAG AA minimum of 4.5:1.`,
      });
    }
  }
  return issues;
}

export { THEME_MANIFEST_FILE, THEME_DEFAULT_STYLE };
