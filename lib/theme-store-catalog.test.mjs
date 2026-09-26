import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  parseThemeStore, storeEntrySource, validateStoreUrl, isStoreUrlError,
  fetchThemeStore, writeStoredStoreUrl, readStoredStoreUrl, configuredStoreUrl,
  THEME_STORE_TTL_MS, MAX_STORE_THEMES,
} = await jiti.import("./theme-store-catalog.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);
after(() => { installDatabaseForTests(null); });
beforeEach(() => {
  db.exec("DELETE FROM app_settings; DELETE FROM market_cache");
  delete process.env.PI_WEB_THEME_STORE_URL;
});

// The CF-Server-Monitor store shape, which this parser accepts unchanged.
const STORE = {
  schema: 1,
  themes: [
    {
      id: "emerald",
      title: "Emerald",
      cover: "https://raw.githubusercontent.com/Tokinx/theme-emerald/main/docs/preview.png",
      tags: ["Emerald", "Earth"],
      description: { "zh-CN": "翡翠配色。", en: "An emerald theme." },
      url: "https://github.com/Tokinx/cf-server-monitor-theme-emerald",
      branch: "build",
      author: "Tokinx",
    },
    { id: "tree", title: "Tree ref", url: "https://github.com/you/repo/tree/v1.2.0/themes/tree", author: "you" },
    { id: "local", title: "Local dev", url: "local:/tmp/my-theme", author: "you" },
    { id: "bad", title: "GitLab theme", url: "https://gitlab.com/you/theme" },
    { id: "notitle", url: "https://github.com/you/theme" },
  ],
};

test("parses a store manifest and normalizes every usable entry", () => {
  const { themes, issues } = parseThemeStore(STORE);
  assert.equal(themes.length, 3, JSON.stringify(themes));
  assert.equal(themes[0].source, "https://github.com/Tokinx/cf-server-monitor-theme-emerald/tree/build");
  assert.equal(themes[0].author, "Tokinx");
  assert.deepEqual(themes[0].tags, ["Emerald", "Earth"]);
  assert.equal(themes[0].description.en, "An emerald theme.");
  assert.match(themes[0].coverUrl, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.equal(themes[1].source, "https://github.com/you/repo/tree/v1.2.0/themes/tree");
  assert.equal(themes[2].source, "local:/tmp/my-theme");
  assert.ok(issues.some((issue) => issue.includes("GitLab")));
  assert.ok(issues.some((issue) => issue.includes("title or url")));
});

test("accepts a bare array and refuses anything else", () => {
  assert.equal(parseThemeStore([{ title: "x", url: "local:/x" }]).themes.length, 1);
  assert.deepEqual(parseThemeStore(null).themes, []);
  assert.deepEqual(parseThemeStore({ schema: 1 }).themes, []);
  assert.deepEqual(parseThemeStore("nope").issues.length, 1);
});

test("caps the number of entries it will render", () => {
  const many = { themes: Array.from({ length: MAX_STORE_THEMES + 10 }, (_, index) => ({
    title: `t${index}`, url: `local:/t${index}`,
  })) };
  const { themes, issues } = parseThemeStore(many);
  assert.equal(themes.length, MAX_STORE_THEMES);
  assert.ok(issues.some((issue) => issue.includes(String(MAX_STORE_THEMES))));
});

test("derives sources from repo URLs, tree URLs, and branches", () => {
  assert.equal(storeEntrySource("https://github.com/o/r"), "https://github.com/o/r/tree/main");
  assert.equal(storeEntrySource("https://github.com/o/r", "dev"), "https://github.com/o/r/tree/dev");
  assert.equal(storeEntrySource("https://github.com/o/r/tree/abc123/sub"), "https://github.com/o/r/tree/abc123/sub");
  assert.equal(storeEntrySource("local:/tmp/x"), "local:/tmp/x");
  assert.equal(storeEntrySource("https://gitlab.com/o/r"), null);
  assert.equal(storeEntrySource("ftp://github.com/o/r"), null);
  assert.equal(storeEntrySource("https://github.com/o"), null);
  assert.equal(storeEntrySource("https://github.com/o/r", "../etc"), null);
});

test("validates the store URL before it is fetched", () => {
  assert.equal(validateStoreUrl("https://example.com/themes.json"), "https://example.com/themes.json");
  for (const [url, reason] of [
    ["", /required/],
    ["not a url", /valid URL/],
    ["http://example.com/x.json", /https/],
    ["https://user:pw@example.com/x.json", /credentials/],
    ["https://localhost/x.json", /public host/],
    ["https://127.0.0.1/x.json", /public host/],
    ["https://169.254.169.254/latest/meta-data", /public host/],
  ]) {
    const result = validateStoreUrl(url);
    assert.ok(isStoreUrlError(result), `${url} must be refused`);
    assert.match(result.message, reason);
  }
});

test("the store URL comes from the environment or the stored setting", () => {
  assert.equal(configuredStoreUrl(db, {}), null);
  writeStoredStoreUrl("https://example.com/themes.json", db);
  assert.equal(configuredStoreUrl(db, {}), "https://example.com/themes.json");
  assert.equal(readStoredStoreUrl(db), "https://example.com/themes.json");
  assert.equal(
    configuredStoreUrl(db, { PI_WEB_THEME_STORE_URL: "https://env.example/x.json" }),
    "https://env.example/x.json",
    "the environment wins",
  );
  writeStoredStoreUrl(null, db);
  assert.equal(readStoredStoreUrl(db), null);
});

test("an unconfigured store reports itself instead of failing", async () => {
  const result = await fetchThemeStore({ db, environment: {} });
  assert.equal(result.configured, false);
  assert.deepEqual(result.themes, []);
});

test("a stored manifest is cached and reused inside the TTL", async () => {
  const payload = { schema: 1, themes: [{ title: "Emerald", url: "https://github.com/o/r" }] };
  const now = 1_000_000;
  // Seed the cache the way a successful fetch would.
  db.prepare(`
    INSERT INTO market_cache (source, cache_key, payload, fetched_at, expires_at)
    VALUES ('theme-store', ?, ?, ?, ?)
  `).run("https://example.com/themes.json", JSON.stringify(parseThemeStore(payload)), now, now + THEME_STORE_TTL_MS);
  writeStoredStoreUrl("https://example.com/themes.json", db);

  const fresh = await fetchThemeStore({ db, now: now + 1000 });
  assert.equal(fresh.fromCache, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.themes.length, 1);
  assert.equal(fresh.themes[0].source, "https://github.com/o/r/tree/main");

  // An unreachable store still yields the cached list, marked as stale.
  const stale = await fetchThemeStore({ db, now: now + THEME_STORE_TTL_MS + 1 });
  assert.equal(stale.themes.length, 1, "a stale copy beats an empty store");
  assert.equal(stale.stale, true);
  assert.ok(stale.error);
});

test("a bad stored URL is reported without a network call", async () => {
  writeStoredStoreUrl("https://127.0.0.1/themes.json", db);
  const result = await fetchThemeStore({ db, environment: {} });
  assert.equal(result.configured, true);
  assert.deepEqual(result.themes, []);
  assert.match(result.error, /public host/);
});

test("carries a declared version and leaves it null when the store omits it", () => {
  const { themes } = parseThemeStore({
    themes: [
      { title: "Versioned", url: "https://github.com/o/r", version: "2.1.0" },
      { title: "Unversioned", url: "https://github.com/o/r2" },
      { title: "Blank", url: "https://github.com/o/r3", version: "   " },
    ],
  });
  assert.equal(themes[0].version, "2.1.0");
  assert.equal(themes[1].version, null);
  assert.equal(themes[2].version, null);
});
