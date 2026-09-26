import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const settingsSource = await readFile(new URL("./ThemeSettings.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/themes/local/route.ts", import.meta.url), "utf8");
const guardSource = await readFile(new URL("./ThemeLoaderGuard.tsx", import.meta.url), "utf8");
const layoutSource = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const previewRouteSource = await readFile(new URL("../app/api/themes/preview/route.ts", import.meta.url), "utf8");
const safetySource = await readFile(new URL("../lib/theme-safety.ts", import.meta.url), "utf8");
const settingsCss = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");
const messages = Object.fromEntries(
  getSupportedLocales().map((locale) => [locale, getLocalePlugin(locale).messages]),
);

/** Every literal `t("…")` key the component uses. */
function usedKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(match[1]);
  return keys;
}

test("the theme section scans local directories through the cwd it was given", () => {
  // The panel passes the selected project down, and the scan passes it on.
  assert.match(settingsSource, /export function ThemeSettings\(\{ cwd = null \}/);
  assert.match(settingsSource, /\/api\/themes\/local\$\{query\}/);
  assert.match(settingsSource, /cwd \? `\?cwd=\$\{encodeURIComponent\(cwd\)\}` : ""/);
  assert.match(settingsSource, /\[cwd\]/);
});

test("the theme section can import, replace and remove local themes", () => {
  assert.match(settingsSource, /action: "import", source: requested, overwrite/);
  assert.match(settingsSource, /action: "remove", source: entry\.source/);
  // A taken theme id is the one error worth acting on, so it gets its own button.
  assert.match(settingsSource, /payload\.error === "exists"[\s\S]{0,200}setOverwriteSource\(requested\)/);
  assert.match(settingsSource, /importTheme\(overwriteSource, true\)/);
  // Removal is destructive and only offered for the managed copy.
  assert.match(settingsSource, /window\.confirm\(t\("theme\.localRemoveConfirm"/);
  assert.match(settingsSource, /\{entry\.managed\s*\?[\s\S]{0,400}theme\.localRemove/);
  // Discovered themes are offered for apply and for the real-interface preview,
  // which is what makes the list useful rather than decorative.
  assert.match(settingsSource, /onClick=\{\(\) => void check\(true, entry\.source\)\}/);
  assert.match(settingsSource, /onClick=\{\(\) => previewInApp\(entry\.source\)\}/);
});

test("every theme.local key the UI asks for exists in all three locales", () => {
  const keys = [...usedKeys(settingsSource)].filter((key) => key.startsWith("theme.local"));
  assert.ok(keys.length >= 10, `expected the local-theme keys, found ${keys.join(", ")}`);

  // Dynamic labels go through localOriginKey, so collect those separately.
  assert.match(settingsSource, /localOriginKey\(entry\.origin\)/);
  keys.push("theme.localManaged", "theme.localConfigured", "theme.localProject");

  for (const locale of Object.keys(messages)) {
    for (const key of keys) {
      assert.equal(typeof messages[locale][key], "string", `${locale} is missing ${key}`);
      assert.notEqual(messages[locale][key], "", `${locale}.${key} is empty`);
    }
  }
});

test("the local theme routes stay behind the shared request and path checks", () => {
  assert.match(routeSource, /isApiRequestAllowed\(request\)/);
  assert.match(routeSource, /hasJsonContentType\(request\)/);
  // Import must validate before copying: the library, not the route, owns that.
  assert.match(routeSource, /importLocalTheme\(source, \{/);
  assert.match(routeSource, /removeManagedTheme\(source\)/);
  assert.match(routeSource, /Cache-Control": "no-store"/);
});

/* ------------------------------------------------ preview in the app -- */

test("a preview link is tagged so a failure cannot switch themes off", () => {
  // The server marks the stylesheet: "active" for the applied theme, "preview"
  // for a preview. Losing a preview is not a reason to lose the applied theme.
  assert.match(layoutSource, /data-pi-theme=\{previewTheme \? "preview" : "active"\}/);

  assert.match(guardSource, /const isPreview = link\.dataset\.piTheme === "preview"/);
  assert.match(guardSource, /if \(isPreview \|\| link\.dataset\.piTheme === "preview"\) dropPreview\(\)/);
  assert.match(guardSource, /else disableAppliedTheme\(\)/);
  // Only the applied theme may set the safety cookie.
  assert.match(guardSource, /disableAppliedTheme[\s\S]*?\$\{THEME_SAFETY_COOKIE\}=1/);
  assert.doesNotMatch(guardSource, /dropPreview[\s\S]{0,400}THEME_SAFETY_COOKIE=/);

  // A preview that cannot load is forgotten, so the next render is clean.
  assert.match(guardSource, /\$\{THEME_PREVIEW_COOKIE\}=;/);
  assert.match(guardSource, /Max-Age=0/);
  // Which requires the cookie to be readable from the page.
  const previewCookieFlags = previewRouteSource.match(/httpOnly: false/g) ?? [];
  assert.equal(previewCookieFlags.length, 2, "both the set and the clear path are page-readable");
  assert.match(safetySource, /export const THEME_PREVIEW_COOKIE = "pi-web-theme-preview"/);
});

test("the preview route resolves the theme before redirecting", () => {
  // Redirecting first is what made a failed preview look like "it did nothing":
  // the operator landed on an unthemed page with no explanation.
  assert.match(previewRouteSource, /if \(isThemeResolutionError\(resolved\)\)/);
  assert.match(previewRouteSource, /return previewFailure\(resolved\.message/);
  assert.match(previewRouteSource, /isThemeResolutionError[\s\S]*?redirectHome\(request\)/);
});

test("the theme section offers a way back from the escape hatch", () => {
  const keys = ["theme.disabledOnDevice", "theme.enableOnDevice"];
  for (const key of keys) {
    for (const locale of Object.keys(messages)) {
      assert.equal(typeof messages[locale][key], "string", `${locale} is missing ${key}`);
    }
  }
  assert.match(settingsSource, /const \[themesOff, setThemesOff\] = useState\(false\)/);
  assert.match(settingsSource, /const enableThemesOnDevice = \(\) => \{/);
  // Clearing the cookie has to include an expiry, or the old value survives.
  assert.match(settingsSource, /\$\{THEME_SAFETY_COOKIE\}=; Path=\/; Max-Age=0/);
  assert.match(settingsSource, /themesOff && \(/);
  assert.match(settingsSource, /t\("theme.enableOnDevice"\)/);
  // The safety cookie is read from the document, not from a server prop.
  assert.match(settingsSource, /document\.cookie\.split\("; "\)/);
});

/* ------------------------------------------------------------ layout -- */

test("the theme page follows the CF-Server-Monitor structure", () => {
  // Warning strip → current-theme bar → source card → one card grid.
  const order = ["theme-warning", "theme-toolbar", "theme-custom", "theme-grid"]
    .map((name) => settingsSource.indexOf(`className="${name}"`));
  assert.ok(order.every((index) => index > -1), "every block is rendered");
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i - 1] < order[i], "blocks appear in the source project's order");
  }

  // The card rules are the ones that keep rows aligned: a 16:9 cover, a flex
  // column body, the spacer, and an equal-width wrapping action row.
  for (const rule of ["\.theme-grid \{", "\.theme-card \{", "\.theme-cover-wrap \{", "\.theme-info \{", "\.theme-space \{", "\.theme-actions \{"]) {
    assert.match(settingsCss, new RegExp(rule), `settings.css defines ${rule}`);
  }
  assert.match(settingsCss, /\.theme-cover-wrap \{[\s\S]{0,160}aspect-ratio: 16 \/ 9/);
  assert.match(settingsCss, /\.theme-space \{[\s\S]{0,80}flex: 1/);
  assert.match(settingsCss, /\.theme-actions > \.config-button,[\s\S]{0,40}\.theme-actions > \.theme-view-link \{[\s\S]{0,60}flex: 1 1 88px/);
  // A store card offers the entry's page, so every card has three actions and
  // the rows line up across a mixed row.
  assert.match(settingsSource, /className="market-link theme-view-link"/);
  // Long paths must wrap instead of widening a card.
  assert.match(settingsCss, /\.theme-path \{[\s\S]{0,220}overflow-wrap: anywhere/);

  // Cards without a cover still fill the same box.
  assert.match(settingsSource, /function ThemeCardCover\(/);
  assert.match(settingsSource, /className=\{`theme-cover-fallback theme-cover-fallback-\$\{base\}`\}/);

  // Narrow panels stack like the source project, and the grid needs no
  // per-breakpoint column rules.
  assert.match(settingsCss, /@container settings-panel \(max-width: 700px\) \{[\s\S]{0,260}flex-direction: column/);
  assert.match(settingsCss, /repeat\(auto-fill, minmax\(320px, 1fr\)\)/);
});

test("the built-in palette picker stays in the theme page", () => {
  assert.match(settingsSource, /THEME_OPTIONS\.map/);
  assert.match(settingsSource, /setThemePreference\(option\.id\)/);
  assert.match(settingsSource, /role="radiogroup"/);
});

test("the layout keys exist in every locale", () => {
  const keys = [
    "theme.warningTitle", "theme.warningDesc", "theme.customSourceTitle", "theme.noDescription",
    "theme.baseLight", "theme.baseDark", "theme.variantsCount", "theme.appearanceHint",
    "theme.sourceHint", "theme.reportHeading", "theme.probeRoots",
    "theme.previewInAppShort", "theme.view",
  ];
  for (const locale of Object.keys(messages)) {
    for (const key of keys) {
      assert.equal(typeof messages[locale][key], "string", `${locale} is missing ${key}`);
      assert.notEqual(messages[locale][key], "", `${locale}.${key} is empty`);
    }
  }
});
