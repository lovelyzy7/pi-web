/**
 * Third-party theme sources.
 *
 * A theme lives in a git repository (or a local directory while developing) and
 * is served through this server, never straight from the network: the app's CSP
 * allows styles from `'self'` only, the browser must not contact third parties
 * at all, and a proxied copy can be validated, size-capped, and cached.
 *
 * The GitHub parsing and its path whitelist mirror CF-Server-Monitor's
 * `normalizeThemeUrl`/`parseThemeUrl`: `https`, `github.com`, no credentials, no
 * query, no fragment, and every path segment restricted to `[A-Za-z0-9._-]`
 * without `.`/`..`.
 */

/**
 * Every selector in a theme stylesheet must start with this.
 *
 * The theme is a *layer* over a built-in palette: `<html>` carries
 * `data-theme="dark"` (or light/…) for the base and `data-pi-theme="custom"` for
 * the theme. The `html` prefix is not decoration — it raises specificity above
 * the `[data-theme="…"]` palette blocks, so the result does not depend on which
 * stylesheet the browser happens to load last.
 */
export const THEME_SCOPE_SELECTOR = 'html[data-pi-theme="custom"]';
export const THEME_ATTRIBUTE = "data-pi-theme";
export const THEME_ATTRIBUTE_VALUE = "custom";
export const THEME_MANIFEST_FILE = "theme.json";
export const THEME_DEFAULT_STYLE = "theme.css";
/** `theme.dark.css`, `theme.light.css`, `theme.<name>.css`. */
export const THEME_VARIANT_STYLE = /^theme\.[a-z0-9-]{1,20}\.css$/;

export type ThemeSourceKind = "github" | "local" | "url";

export interface ThemeSource {
  kind: ThemeSourceKind;
  /** Normalized source string, used as a key and shown to the operator. */
  source: string;
  /** Human readable origin for logs and the audit trail. */
  display: string;
  /** Branch, tag, or commit; a 40-hex ref is cached as immutable. */
  ref: string | null;
  /** Base URL for `github` and `url` kinds, without a trailing slash. */
  baseUrl: string | null;
  /** Absolute directory for the `local` kind. */
  localPath: string | null;
  immutable: boolean;
}

export interface ThemeSourceError {
  error: "invalid_source" | "unsupported_scheme" | "any_url_disabled" | "blocked_host";
  message: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const COMMIT_REF = /^[a-f0-9]{40}$/i;

export function isCommitRef(ref: string): boolean {
  return COMMIT_REF.test(ref);
}

/** Hosts that would turn the proxy into an SSRF gadget. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return false;
}

function validateSegments(segments: string[]): string[] | null {
  if (segments.some((segment) => !SEGMENT.test(segment) || segment === "." || segment === "..")) return null;
  return segments;
}

/** `github:owner/repo@ref[/sub]` shorthand. */
function parseGithubShorthand(source: string): string | null {
  const match = /^github:([^/@\s]+)\/([^/@\s]+)(?:@([^/\s]+)(\/[^\s]*)?)?$/.exec(source);
  if (!match) return null;
  const [, owner, repo, ref, sub = ""] = match;
  if (!ref) return null;
  return `https://github.com/${owner}/${repo}/tree/${ref}${sub}`;
}

export function parseThemeSource(
  input: string,
  options: { environment?: NodeJS.ProcessEnv } = {},
): ThemeSource | ThemeSourceError {
  const environment = options.environment ?? process.env;
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "invalid_source", message: "A theme source is required." };

  if (raw.startsWith("local:")) {
    const localPath = raw.slice("local:".length).trim();
    if (!localPath) return { error: "invalid_source", message: "A directory path is required." };
    return {
      kind: "local",
      source: `local:${localPath}`,
      display: localPath,
      ref: null,
      baseUrl: null,
      localPath,
      immutable: false,
    };
  }

  const normalized = raw.startsWith("github:") ? parseGithubShorthand(raw) : raw;
  if (!normalized) {
    return { error: "invalid_source", message: "Use github:owner/repo@ref, a GitHub tree URL, local:/path, or an https URL." };
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return { error: "invalid_source", message: "That is not a valid URL." };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { error: "invalid_source", message: "The source URL must not carry credentials, a query, or a fragment." };
  }

  const segments = validateSegments(url.pathname.split("/").filter(Boolean));
  if (!segments) {
    return { error: "invalid_source", message: "The path contains a segment that is not allowed." };
  }

  if (url.hostname === "github.com") {
    if (url.protocol !== "https:") {
      return { error: "invalid_source", message: "GitHub sources must use https." };
    }
    // https://github.com/<owner>/<repo>/tree/<ref>[/sub/path]
    const [owner, repo, marker, ref, ...subPath] = segments;
    // A subdirectory may legitimately be called "tree"; the marker check above
    // is what distinguishes a tree URL from a blob URL.
    if (!owner || !repo || marker !== "tree" || !ref) {
      return {
        error: "invalid_source",
        message: "Use https://github.com/<owner>/<repo>/tree/<branch-or-commit>[/sub/dir].",
      };
    }
    const rawPath = [owner, repo, ref, ...subPath].map(encodeURIComponent).join("/");
    return {
      kind: "github",
      source: `https://github.com/${[owner, repo, "tree", ref, ...subPath].join("/")}`,
      display: `${owner}/${repo}@${ref}${subPath.length ? `/${subPath.join("/")}` : ""}`,
      ref,
      baseUrl: `https://raw.githubusercontent.com/${rawPath}`,
      localPath: null,
      immutable: isCommitRef(ref),
    };
  }

  if (environment.PI_WEB_THEME_ALLOW_ANY_URL !== "1") {
    return {
      error: "any_url_disabled",
      message: "Only GitHub sources and local directories are allowed. Set PI_WEB_THEME_ALLOW_ANY_URL=1 to accept any https URL.",
    };
  }
  if (url.protocol !== "https:") {
    return { error: "unsupported_scheme", message: "Only https theme URLs are allowed." };
  }
  if (isBlockedHost(url.hostname)) {
    return { error: "blocked_host", message: `${url.hostname} is not a public host.` };
  }

  const basePath = segments.map(encodeURIComponent).join("/");
  return {
    kind: "url",
    source: `https://${url.host}${url.pathname.replace(/\/+$/, "")}`,
    display: url.host,
    ref: null,
    baseUrl: `https://${url.host}/${basePath}`,
    localPath: null,
    immutable: false,
  };
}

export function isThemeSourceError(value: ThemeSource | ThemeSourceError): value is ThemeSourceError {
  return (value as ThemeSourceError).error !== undefined;
}

/** Path whitelist for proxied files: the manifest, stylesheets, and `assets/`. */
export function normalizeThemeAssetPath(path: string): string | null {
  const raw = String(path ?? "").trim().replace(/^\/+/, "");
  if (!raw || raw.length > 200) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.includes("..")) return null;
  const segments = decoded.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (!segments.every((segment) => /^[A-Za-z0-9._-]+$/.test(segment))) return null;

  const [first] = segments;
  if (first === THEME_MANIFEST_FILE || first === THEME_DEFAULT_STYLE || THEME_VARIANT_STYLE.test(first)) {
    return segments.length === 1 ? first : null;
  }
  if (first !== "assets" || segments.length < 2) return null;
  return segments.join("/");
}

export function themeAssetUrl(source: ThemeSource, path: string): string | null {
  const normalized = normalizeThemeAssetPath(path);
  if (!normalized || !source.baseUrl) return null;
  return `${source.baseUrl}/${normalized.split("/").map(encodeURIComponent).join("/")}`;
}

export const THEME_ASSET_CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

export function themeContentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return THEME_ASSET_CONTENT_TYPES[extension] ?? "application/octet-stream";
}
