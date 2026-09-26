import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-themes-"));
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const assetRoute = await jiti.import("./asset/[...path]/route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const { readActiveTheme } = await jiti.import("../../../lib/theme-store.ts");
const { fetchThemeStore, writeStoredStoreUrl } = await jiti.import("../../../lib/theme-store-catalog.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

const THEMES = join(agentDir, "themes");

function writeTheme(name, manifest, css) {
  const dir = join(THEMES, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "theme.json"), JSON.stringify(manifest, null, 2));
  if (css !== null) writeFileSync(join(dir, "theme.css"), css);
  return dir;
}

const VALID_CSS = `html[data-pi-theme="custom"] {
  --bg: #0b0f14;
  --text: #e6ecef;
  --accent: #7ee2b8;
}`;

const manifest = (overrides = {}) => ({
  schema: 1,
  id: "emerald",
  name: "Emerald",
  version: "1.0.0",
  author: "you",
  base: "dark",
  ...overrides,
});

before(() => {
  writeTheme("emerald", manifest(), VALID_CSS);
  writeTheme("broken", manifest({ id: "broken" }), "body { --bg: #000; }");
  writeTheme("no-manifest", manifest({ id: "no-manifest" }), VALID_CSS);
  rmSync(join(THEMES, "no-manifest", "theme.json"));
  writeTheme("outside", manifest({ id: "outside" }), VALID_CSS);
});

after(() => {
  installDatabaseForTests(null);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM app_settings; DELETE FROM market_cache;");
  delete process.env.PI_WEB_THEME_STORE_URL;
});


/** Calls the path-shaped asset route with the params Next would provide. */
function callAsset(path, query = "") {
  const segments = path ? path.split("/") : [];
  return assetRoute.GET(request(`/api/themes/asset/${path}${query}`), {
    params: Promise.resolve({ path: segments }),
  });
}

function request(path, method = "GET", body, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("reports no active theme on a fresh install", async () => {
  const response = await route.GET(request("/api/themes"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.active, null);
  assert.ok(body.themeableVariables.includes("--bg"));
  assert.ok(body.reservedVariables.includes("--chat-content-max-width"));
});

test("validates and applies a local theme", async () => {
  const dir = join(THEMES, "emerald");
  const response = await route.POST(request("/api/themes", "POST", { source: `local:${dir}` }));
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.applied, true);
  assert.equal(body.manifest.name, "Emerald");
  assert.deepEqual(body.overriddenVariables.sort(), ["--accent", "--bg", "--text"]);

  const active = readActiveTheme(db);
  assert.equal(active.source, `local:${dir}`);
  assert.equal(active.manifest.id, "emerald");
  assert.equal(active.ref, "local");

  const listed = await (await route.GET(request("/api/themes"))).json();
  assert.equal(listed.active.manifest.name, "Emerald");
  assert.equal(listed.active.cssUrl, "/api/themes/asset/theme.css");
});

test("preview resolves without persisting anything", async () => {
  const response = await route.POST(request("/api/themes", "POST", {
    source: `local:${join(THEMES, "emerald")}`,
    preview: true,
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.applied, false);
  assert.match(body.cssUrl, /preview=1/);
  assert.equal(readActiveTheme(db), null, "a preview must not change the applied theme");
});

test("validates every declared variant stylesheet", async () => {
  const dir = join(THEMES, "variants");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "theme.json"), JSON.stringify({
    ...manifest({ id: "variants" }),
    variants: { light: "theme.light.css", dark: "theme.dark.css" },
  }));
  writeFileSync(join(dir, "theme.css"), VALID_CSS);
  writeFileSync(join(dir, "theme.light.css"), `html[data-pi-theme="custom"] { --bg: #cfc7b0; }`);

  // The dark variant is declared but missing: the theme must be refused, not
  // half-applied in one mode.
  const missing = await route.POST(request("/api/themes", "POST", { source: `local:${dir}` }));
  assert.equal(missing.status, 400);
  assert.ok((await missing.json()).issues.some((issue) => /Variant "dark"/.test(issue.message)));

  writeFileSync(join(dir, "theme.dark.css"), "body { --bg: #000; }");
  const unscoped = await route.POST(request("/api/themes", "POST", { source: `local:${dir}` }));
  assert.equal(unscoped.status, 400, "a variant is held to the same scope rule");
  assert.ok((await unscoped.json()).issues.some((issue) => /Every selector must start/.test(issue.message)));

  writeFileSync(join(dir, "theme.dark.css"), `html[data-pi-theme="custom"] { --bg: #0e0d0a; }`);
  const accepted = await route.POST(request("/api/themes", "POST", { source: `local:${dir}` }));
  const body = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(body));
  assert.deepEqual(body.manifest.variants, { light: "theme.light.css", dark: "theme.dark.css" });
  assert.ok(body.overriddenVariables.includes("--bg"));

  // The variant file is reachable through the same proxy.
  const variant = await callAsset("theme.dark.css");
  assert.equal(variant.status, 200);
  assert.equal(variant.headers.get("content-type"), "text/css; charset=utf-8");
});

test("refuses a stylesheet that escapes the theme scope", async () => {
  const response = await route.POST(request("/api/themes", "POST", { source: `local:${join(THEMES, "broken")}` }));
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error, "invalid_css");
  assert.ok(body.issues.some((issue) => /Every selector must start/.test(issue.message)));
  assert.equal(readActiveTheme(db), null);
});

test("reports an unreachable theme without touching the applied one", async () => {
  await route.POST(request("/api/themes", "POST", { source: `local:${join(THEMES, "emerald")}` }));

  const missing = await route.POST(request("/api/themes", "POST", { source: `local:${join(THEMES, "no-manifest")}` }));
  assert.equal(missing.status, 502);
  assert.equal((await missing.json()).error, "unreachable");
  assert.equal(readActiveTheme(db).manifest.id, "emerald", "the applied theme stays");
});

test("refuses a local theme outside the allowed roots", async () => {
  const outside = mkdtempSync(join(tmpdir(), "pi-web-elsewhere-"));
  writeFileSync(join(outside, "theme.json"), JSON.stringify(manifest({ id: "outside" })));
  writeFileSync(join(outside, "theme.css"), VALID_CSS);
  try {
    const response = await route.POST(request("/api/themes", "POST", { source: `local:${outside}` }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "blocked_path");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("resolves store versions from each theme's own manifest", async () => {
  // A store entry without a declared version falls back to the theme's manifest.
  const dir = join(THEMES, "emerald");
  const storeJson = {
    schema: 1,
    themes: [
      { title: "Local Emerald", url: `local:${dir}` },
      { title: "Declared", url: "https://github.com/example/theme", version: "3.0.0" },
    ],
  };
  writeFileSync(join(root, "store.json"), JSON.stringify(storeJson));
  writeStoredStoreUrl(`file://${join(root, "store.json")}`);
  assert.equal((await fetchThemeStore({ db })).configured, true, "file:// is refused, so this stays unconfigured");

  const { resolveThemeVersions } = await jiti.import("../../../lib/theme-store.ts");
  const versions = await resolveThemeVersions([
    { source: `local:${dir}`, version: null },
    { source: "https://github.com/example/theme/tree/main", version: "3.0.0" },
  ], { db });
  assert.equal(versions[`local:${dir}`], "1.0.0", "read from the theme's manifest");
  assert.equal(versions["https://github.com/example/theme/tree/main"], "3.0.0", "used when the store declares it");
});

test("restores the built-in palettes", async () => {
  await route.POST(request("/api/themes", "POST", { source: `local:${join(THEMES, "emerald")}` }));
  const response = await route.DELETE(request("/api/themes", "DELETE"));
  assert.equal(response.status, 200);
  assert.equal(readActiveTheme(db), null);
  assert.equal((await (await route.GET(request("/api/themes"))).json()).active, null);
});

test("bad input is refused before anything is read", async () => {
  for (const source of ["", "https://gitlab.com/x/y/tree/main", "not a url", "local:"]) {
    const response = await route.POST(request("/api/themes", "POST", { source }));
    assert.equal(response.status, 400, source);
  }
  const untrusted = await route.GET(request("/api/themes", "GET", undefined, { Host: "evil.example" }));
  assert.equal(untrusted.status, 403);
});

test("serves theme files same-origin with safe headers", async () => {
  const dir = join(THEMES, "emerald");
  await route.POST(request("/api/themes", "POST", { source: `local:${dir}` }));

  const css = await callAsset("theme.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(css.headers.get("x-content-type-options"), "nosniff");
  assert.equal(css.headers.get("cache-control"), "no-store", "local themes are always re-read");
  assert.match(await css.text(), /--accent/);

  const json = await callAsset("theme.json");
  assert.equal(json.status, 200);
  assert.equal((await json.json()).id, "emerald");
});

test("the asset route refuses unknown paths and unknown themes", async () => {
  for (const path of ["", "../theme.json", "assets/../theme.json", "secret.txt", "assets"]) {
    const response = await callAsset(path);
    assert.equal(response.status, 400, path);
  }

  const none = await callAsset("theme.css");
  assert.equal(none.status, 404, "nothing is applied yet");

  const previewWithoutSource = await callAsset("theme.css", "?preview=1");
  assert.equal(previewWithoutSource.status, 400);
});
