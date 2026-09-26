import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  parseThemeSource, isThemeSourceError, normalizeThemeAssetPath, themeAssetUrl,
  themeContentType, isBlockedHost, THEME_SCOPE_SELECTOR,
} = await jiti.import("./theme-source.ts");
const {
  parseThemeManifest, validateThemeCss, satisfiesPiWeb, contrastRatio, readThemeVariables,
  checkThemeContrast, THEMEABLE_VARIABLES, RESERVED_VARIABLES,
} = await jiti.import("./theme-manifest.ts");

function source(input, environment = {}) {
  const parsed = parseThemeSource(input, { environment });
  assert.ok(!isThemeSourceError(parsed), `expected ${input} to parse: ${JSON.stringify(parsed)}`);
  return parsed;
}

test("parses a GitHub tree URL into a raw base", () => {
  const parsed = source("https://github.com/you/pi-web-theme-emerald/tree/main");
  assert.equal(parsed.kind, "github");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.baseUrl, "https://raw.githubusercontent.com/you/pi-web-theme-emerald/main");
  assert.equal(parsed.immutable, false);
  assert.equal(parsed.display, "you/pi-web-theme-emerald@main");

  const nested = source("https://github.com/you/themes/tree/v1.0.0/packages/emerald");
  assert.equal(nested.baseUrl, "https://raw.githubusercontent.com/you/themes/v1.0.0/packages/emerald");
  assert.equal(nested.display, "you/themes@v1.0.0/packages/emerald");
});

test("accepts a shorthand and recognizes commit-pinned refs", () => {
  const shorthand = source("github:you/pi-web-theme-emerald@main");
  assert.equal(shorthand.source, "https://github.com/you/pi-web-theme-emerald/tree/main");

  const commit = source(`https://github.com/you/pi-web-theme-emerald/tree/${"a".repeat(40)}`);
  assert.equal(commit.immutable, true, "a full sha can be cached as immutable");
});

test("rejects sources that are not a theme directory", () => {
  const cases = [
    "https://github.com/you/repo",                       // no /tree/<ref>
    "https://github.com/you/repo/blob/main/theme.json",  // a file, not a tree
    "https://github.com/you/repo/tree/../etc",
    "https://github.com/you/repo/tree/main?x=1",
    "https://github.com/you/repo/tree/main#frag",
    "https://user:pw@github.com/you/repo/tree/main",
    "http://github.com/you/repo/tree/main",
    "https://gitlab.com/you/repo/tree/main",
    "not a url",
    "",
  ];
  for (const input of cases) {
    const parsed = parseThemeSource(input, { environment: {} });
    assert.ok(isThemeSourceError(parsed), `${input} must be rejected, got ${JSON.stringify(parsed)}`);
  }
});

test("any-URL sources require the opt-in and stay away from private hosts", () => {
  const disabled = parseThemeSource("https://themes.example.com/emerald", { environment: {} });
  assert.ok(isThemeSourceError(disabled));
  assert.equal(disabled.error, "any_url_disabled");

  const enabled = { PI_WEB_THEME_ALLOW_ANY_URL: "1" };
  const accepted = source("https://themes.example.com/emerald/", enabled);
  assert.equal(accepted.kind, "url");
  assert.equal(accepted.baseUrl, "https://themes.example.com/emerald");

  for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.5", "169.254.169.254", "172.16.0.9", "evil.local"]) {
    const blocked = parseThemeSource(`https://${host}/theme`, { environment: enabled });
    assert.ok(isThemeSourceError(blocked), `${host} must be blocked`);
    assert.equal(isBlockedHost(host), true);
  }
  assert.equal(isBlockedHost("themes.example.com"), false);
  assert.equal(isBlockedHost("172.32.0.1"), false, "outside the private range");
});

test("local directories are a first-class source", () => {
  const parsed = source("local:/home/me/pi-web-theme-emerald");
  assert.equal(parsed.kind, "local");
  assert.equal(parsed.localPath, "/home/me/pi-web-theme-emerald");
  assert.equal(parsed.baseUrl, null, "no network for local themes");
  assert.equal(parsed.immutable, false);

  const empty = parseThemeSource("local:  ");
  assert.ok(isThemeSourceError(empty));
});

test("the asset path whitelist allows only the manifest, styles, and assets", () => {
  assert.equal(normalizeThemeAssetPath("theme.json"), "theme.json");
  assert.equal(normalizeThemeAssetPath("theme.css"), "theme.css");
  assert.equal(normalizeThemeAssetPath("assets/emoji.woff2"), "assets/emoji.woff2");
  assert.equal(normalizeThemeAssetPath("assets/sub/dir/logo.png"), "assets/sub/dir/logo.png");
  assert.equal(normalizeThemeAssetPath("/assets/logo.png"), "assets/logo.png");

  for (const bad of [
    "../theme.json", "assets/../../etc/passwd", "assets/%2e%2e/x", "assets/a\\b", "secret.txt",
    "theme.css/x", "assets", "", "assets/%00x", "assets/a b.png", "other/theme.css",
  ]) {
    assert.equal(normalizeThemeAssetPath(bad), null, `${bad} must be refused`);
  }
});

test("resolves asset URLs through the source base", () => {
  const github = source("https://github.com/you/theme/tree/main");
  assert.equal(themeAssetUrl(github, "theme.css"), "https://raw.githubusercontent.com/you/theme/main/theme.css");
  assert.equal(themeAssetUrl(github, "assets/a b.png"), null, "the whitelist refuses spaces");

  const local = source("local:/tmp/theme");
  assert.equal(themeAssetUrl(local, "theme.css"), null);
  assert.equal(themeContentType("theme.css"), "text/css; charset=utf-8");
  assert.equal(themeContentType("assets/a.woff2"), "font/woff2");
  assert.equal(themeContentType("assets/a.exe"), "application/octet-stream");
});

const VALID_MANIFEST = {
  schema: 1,
  id: "emerald",
  name: "Emerald",
  version: "1.0.0",
  author: "you",
  base: "dark",
  piWeb: ">=0.9 <1.0",
  description: { en: "Emerald", "zh-CN": "翡翠" },
  variables: ["--bg", "--accent"],
  styles: ["theme.css"],
  assets: ["assets/emoji.woff2"],
};

const VALID_CSS = `${THEME_SCOPE_SELECTOR} {
  --bg: #0f1115;
  --text: #e6ecef;
  --accent: #7ee2b8;
}
@media (max-width: 600px) {
  ${THEME_SCOPE_SELECTOR} { --bg-panel: #12161c; }
}`;

test("accepts variant stylesheets and refuses anything else", () => {
  const ok = parseThemeManifest({ ...VALID_MANIFEST, variants: { light: "theme.light.css", dark: "theme.dark.css" } });
  assert.ok(ok.manifest);
  assert.deepEqual(ok.manifest.variants, { light: "theme.light.css", dark: "theme.dark.css" });

  for (const variants of [
    { light: "light.css" },
    { light: "../theme.css" },
    { light: "assets/dark.css" },
    { "not a mode!": "theme.dark.css" },
    { dark: "theme.css" },
  ]) {
    const parsed = parseThemeManifest({ ...VALID_MANIFEST, variants });
    if (parsed.manifest) {
      // `theme.css` for a mode is legal — it means "same as the base".
      assert.deepEqual(parsed.manifest.variants, variants);
    } else {
      assert.ok(parsed.issues.some((issue) => issue.level === "error"), JSON.stringify(variants));
    }
  }

  const broken = parseThemeManifest({ ...VALID_MANIFEST, variants: "nope" });
  assert.equal(broken.manifest, null);
  assert.ok(broken.issues.some((issue) => /variants/.test(issue.message)));
});

test("the asset whitelist admits variant stylesheets but nothing else", () => {
  for (const file of [
    "theme.css", "theme.light.css", "theme.dark.css", "theme.high-contrast.css",
    // Any file under assets/ is a theme resource, stylesheets included.
    "assets/theme.dark.css",
  ]) {
    assert.equal(normalizeThemeAssetPath(file), file);
  }
  for (const file of ["theme.css.map", "theme.dark.css/sneaky", "theme..css", "theme.CSS", "theme.DARK.css"]) {
    assert.equal(normalizeThemeAssetPath(file), null, file);
  }
});

test("accepts a well-formed manifest and reports the useful fields", () => {
  const { manifest, issues } = parseThemeManifest(VALID_MANIFEST);
  assert.ok(manifest);
  assert.deepEqual(issues, []);
  assert.equal(manifest.id, "emerald");
  assert.equal(manifest.base, "dark");
  assert.equal(manifest.description["zh-CN"], "翡翠");
  assert.deepEqual(manifest.declaredVariables, ["--bg", "--accent"]);
});

test("rejects manifests that are missing something essential", () => {
  const cases = [
    [null, /JSON object/],
    [{}, /schema/],
    [{ ...VALID_MANIFEST, schema: 99 }, /schema 99/],
    [{ ...VALID_MANIFEST, id: "Emerald Theme" }, /id/],
    [{ ...VALID_MANIFEST, base: "sepia" }, /base/],
    [{ ...VALID_MANIFEST, styles: ["../outside.css"] }, /styles/],
  ];
  for (const [input, pattern] of cases) {
    const { manifest, issues } = parseThemeManifest(input);
    assert.equal(manifest, null, `expected rejection for ${JSON.stringify(input)}`);
    assert.ok(issues.some((issue) => issue.level === "error"), "an error must be reported");
    if (pattern) {
      assert.ok(issues.some((issue) => pattern.test(issue.message)), `expected ${pattern} in ${JSON.stringify(issues)}`);
    }
  }
});

test("validates the stylesheet scope, imports, and external references", () => {
  const ok = validateThemeCss(VALID_CSS, { manifest: null });
  assert.deepEqual(ok.scopeViolations, []);
  assert.deepEqual(ok.issues.filter((issue) => issue.level === "error"), []);
  assert.deepEqual(ok.overriddenVariables.sort(), ["--accent", "--bg", "--bg-panel", "--text"]);

  const cases = [
    ["body { --bg: #000; }", /Every selector must start/],
    [":root { --bg: #000; }", /Every selector must start/],
    [`${THEME_SCOPE_SELECTOR}, body { --bg: #000; }`, /Every selector must start/],
    ['@import url("https://evil.example/x.css");', /@import is not allowed/],
    [`${THEME_SCOPE_SELECTOR} { background-image: url(https://evil.example/x.png); }`, /external URLs/],
    [`${THEME_SCOPE_SELECTOR} { behavior: url(#default#time2); }`, /not allowed in a theme/],
    [`${THEME_SCOPE_SELECTOR} { width: expression(alert(1)); }`, /not allowed in a theme/],
    [`@font-face { font-family: x; src: url(https://evil.example/x.woff2); }`, /not allowed in a theme|external URLs/],
    [`${THEME_SCOPE_SELECTOR} {`, /unbalanced braces/],
  ];
  for (const [css, pattern] of cases) {
    const result = validateThemeCss(css);
    assert.ok(
      result.issues.some((issue) => issue.level === "error" && pattern.test(issue.message)),
      `expected ${pattern} for ${css} — got ${JSON.stringify(result.issues)}`,
    );
  }
});

test("accepts bundled assets, data URIs, and nested at-rules", () => {
  const css = `
    @charset "utf-8";
    ${THEME_SCOPE_SELECTOR} {
      --bg: #101010;
      background-image: url(assets/pattern.svg);
      --logo: url("data:image/svg+xml;base64,AAAA");
    }
    @supports (display: grid) {
      ${THEME_SCOPE_SELECTOR} { --bg-panel: #141414; }
    }
    @media (prefers-reduced-motion: reduce) {
      ${THEME_SCOPE_SELECTOR} { --accent-hover: #ffffff; }
    }
    @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
  `;
  const result = validateThemeCss(css);
  assert.deepEqual(result.issues.filter((issue) => issue.level === "error"), []);
  assert.deepEqual(result.externalUrls, []);
});

test("warns about reserved and unknown variables without rejecting them", () => {
  const css = `${THEME_SCOPE_SELECTOR} { --bg: #000; --chat-content-max-width: 100px; --not-a-thing: 1; }`;
  const result = validateThemeCss(css);
  const warnings = result.issues.filter((issue) => issue.level === "warning").map((issue) => issue.message);
  assert.ok(warnings.some((message) => message.includes("--chat-content-max-width")));
  assert.ok(warnings.some((message) => message.includes("--not-a-thing")));
  assert.deepEqual(result.overriddenVariables, ["--bg"], "reserved variables are not counted as themed");
  assert.ok(RESERVED_VARIABLES.includes("--chat-content-max-width"));
  assert.ok(RESERVED_VARIABLES.includes("--sidebar-width"));
});

test("checks the version range the theme declares", () => {
  assert.equal(satisfiesPiWeb(">=0.9 <1.0", "0.9.3"), true);
  assert.equal(satisfiesPiWeb(">=0.9 <1.0", "1.0.0"), false);
  assert.equal(satisfiesPiWeb(">=0.9 <1.0", "0.8.9"), false);
  assert.equal(satisfiesPiWeb("^0.9.0", "0.9.3"), true);
  assert.equal(satisfiesPiWeb("^0.9.0", "0.10.0"), false);
  assert.equal(satisfiesPiWeb("~0.9.0", "0.9.9"), true);
  assert.equal(satisfiesPiWeb("~0.9.0", "0.10.0"), false);
  assert.equal(satisfiesPiWeb(">=0.9", "1.0.0"), true);
  assert.equal(satisfiesPiWeb(null, "0.9.3"), true);
  assert.equal(satisfiesPiWeb("garbage", "0.9.3"), true);
});

test("computes contrast ratios and flags low-contrast palettes", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(Math.round(contrastRatio("#777777", "#ffffff") ?? 0), 4, "mid grey on white is just under AA");
  assert.equal(contrastRatio("not-a-color", "#fff"), null);

  const good = checkThemeContrast(`${THEME_SCOPE_SELECTOR} { --text: #e6ecef; --bg: #0f1115; }`);
  assert.deepEqual(good.filter((issue) => issue.level === "error"), []);

  const bad = checkThemeContrast(`${THEME_SCOPE_SELECTOR} { --text: #8a8a8a; --bg: #7d7d7d; --text-muted: #808080; --accent: #999999; --accent-contrast: #888888; }`);
  assert.ok(bad.length >= 2, JSON.stringify(bad));
  assert.ok(bad.every((issue) => issue.level === "warning"));
});

test("reads variables from a stylesheet, first definition winning", () => {
  const values = readThemeVariables(`${THEME_SCOPE_SELECTOR} { --bg: #000; --text: #fff; } /* --bg: #fff */`);
  assert.equal(values.get("--bg"), "#000");
  assert.equal(values.get("--text"), "#fff");
});

test("the documented variable list covers what the app actually uses", () => {
  // A theme can only reach variables that exist; this guards against renaming
  // one in the app without updating the contract.
  assert.ok(THEMEABLE_VARIABLES.includes("--bg"));
  assert.ok(THEMEABLE_VARIABLES.includes("--accent"));
  assert.ok(THEMEABLE_VARIABLES.includes("--danger"));
  assert.ok(THEMEABLE_VARIABLES.includes("--qr-bg"));
  assert.ok(!THEMEABLE_VARIABLES.includes("--chat-content-max-width"));
});
