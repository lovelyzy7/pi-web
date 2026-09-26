"use client";

import { useEffect } from "react";
import { useTheme } from "@/hooks/useTheme";
import { THEME_DEFAULT_STYLE } from "@/lib/theme-source";

/**
 * Applies a theme's per-mode stylesheet.
 *
 * A theme renders its base mode server-side, so the first paint is already
 * correct; the variant for the mode the user actually resolved (light or dark)
 * is attached here, and swapped when the mode changes. Only the link element is
 * touched — the stylesheets stay same-origin through `/api/themes/asset`.
 */
export function ThemeVariantLink({
  variants,
  preview,
}: {
  variants: Record<string, string>;
  /** Set when the theme is being previewed, so the variant asks for it too. */
  preview?: string | null;
}) {
  const { theme } = useTheme();
  const mode = theme === "dark" || theme === "pine" ? "dark" : "light";
  const file = variants[mode] ?? (mode === "dark" ? variants.light : variants.dark) ?? THEME_DEFAULT_STYLE;
  const query = preview ? `?preview=1&source=${encodeURIComponent(preview)}` : "";

  useEffect(() => {
    const existing = document.querySelector<HTMLLinkElement>("link[data-pi-theme-variant]");
    if (file === THEME_DEFAULT_STYLE) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.piThemeVariant === file) return;
    const link = existing ?? document.createElement("link");
    link.rel = "stylesheet";
    link.href = `/api/themes/asset/${file}${query}`;
    link.dataset.piThemeVariant = file;
    if (!existing) document.head.appendChild(link);
  }, [file, query]);

  return null;
}
