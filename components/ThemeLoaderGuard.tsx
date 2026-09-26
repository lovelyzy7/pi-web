"use client";

import { useEffect } from "react";
import { THEME_PREVIEW_COOKIE, THEME_SAFETY_COOKIE, requestsThemeOff } from "@/lib/theme-safety";

/**
 * Keeps a broken theme from locking the operator out.
 *
 * Two failure modes are covered: the stylesheet never loads (a 404, a dead
 * source, or a proxy error) and the operator asks for the built-in look
 * explicitly. Both remove the theme from the document immediately; the applied
 * theme also sets the safety cookie so the next render does not include it
 * either.
 *
 * A *preview* failure is deliberately different. Only the preview is dropped and
 * its cookie is cleared, because the applied theme is fine — letting a preview
 * that cannot load switch themes off for 24 hours is how "preview in the app"
 * looked broken even after the source was fixed again.
 */
export function ThemeLoaderGuard() {
  useEffect(() => {
    const disableAppliedTheme = () => {
      try {
        document.cookie = `${THEME_SAFETY_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax`;
      } catch {
        // Cookies can be blocked; removing the link still fixes this page.
      }
      document.querySelectorAll("link[data-pi-theme]").forEach((node) => node.remove());
      delete document.documentElement.dataset.piTheme;
    };

    /** Drops a preview that cannot render, keeping the applied theme in place. */
    const dropPreview = () => {
      document.querySelectorAll('link[data-pi-theme="preview"], link[data-pi-theme-variant]')
        .forEach((node) => node.remove());
      try {
        document.cookie = `${THEME_PREVIEW_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
      } catch {
        // Same as above: the in-page state is already cleaned up.
      }
    };

    if (requestsThemeOff(window.location.search)) {
      disableAppliedTheme();
      // Drop the flag from the URL before reloading so a later bookmark does not
      // switch themes off again.
      const url = new URL(window.location.href);
      url.searchParams.delete("theme");
      window.history.replaceState(null, "", url.toString());
      window.location.reload();
      return;
    }

    const link = document.querySelector<HTMLLinkElement>("link[data-pi-theme]");
    if (!link) return;
    const isPreview = link.dataset.piTheme === "preview";
    link.addEventListener("error", () => {
      if (isPreview || link.dataset.piTheme === "preview") dropPreview();
      else disableAppliedTheme();
    }, { once: true });

    // A variant stylesheet failing only costs that mode; the base sheet still
    // applies, so it never disables anything.
    for (const variant of document.querySelectorAll<HTMLLinkElement>("link[data-pi-theme-variant]")) {
      variant.addEventListener("error", () => variant.remove(), { once: true });
    }
  }, []);

  return null;
}
