/**
 * The one escape hatch that works even when the app is unusable.
 *
 * A theme that hides the interface or breaks contrast cannot be switched off from
 * inside that interface, so the choice is kept in a cookie the server reads while
 * rendering: `/api/themes/asset` is then skipped entirely and the built-in palette
 * comes back. The guard component sets it when the stylesheet fails to load, and
 * `?theme=off` sets it from a URL.
 */
export const THEME_SAFETY_COOKIE = "pi-web-theme-off";

/**
 * The theme a browser is previewing in the real interface.
 *
 * It lives here rather than in `lib/theme-store.ts` because the loader guard —
 * a client component — has to clear it, and the store is server-only code. The
 * value is a theme source (`github:…`, `local:…`, `https:…`), not a secret, so
 * it is deliberately readable from the page.
 */
export const THEME_PREVIEW_COOKIE = "pi-web-theme-preview";

/** How long a preview lasts before it is forgotten. */
export const THEME_PREVIEW_TTL_SECONDS = 60 * 60;

export function isThemeDisabledCookie(value: string | undefined): boolean {
  return value === "1";
}

/** Reads `?theme=off` from a query string. */
export function requestsThemeOff(search: string): boolean {
  const value = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("theme");
  return value === "off" || value === "0";
}
