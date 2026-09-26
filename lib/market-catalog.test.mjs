import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  parseCatalogPage, parsePackageDetail, parseDownloadCount, parsePublishedDate,
  marketListUrl, marketListCacheKey, marketBaseUrl, npmRegistryUrl,
  readMarketCache, writeMarketCache, MARKET_LIST_TTL_MS, MARKET_DETAIL_TTL_MS,
} = await jiti.import("./market-catalog.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

before(() => { db.exec("DELETE FROM market_cache"); });
after(() => { installDatabaseForTests(null); });

// Markup copied from pi.dev/packages so the parser is tested against the shape
// the site actually serves (attribute order included).
const LIST_HTML = `
<div class="content-grid content-grid--two packages-grid">
<article class="surface-panel content-card" data-package-card="true" data-package-name="pi-mcp-adapter" data-package-search="pi-mcp-adapter mcp adapter" data-package-types="extension" data-package-downloads="1037931" data-package-date="1790147591556" data-package-sort-name="pi-mcp-adapter">
<div class="packages-card-body">
<h3 class="packages-name"><a href="/packages/pi-mcp-adapter" data-package-link="true" data-package-path="/packages/pi-mcp-adapter">pi-mcp-adapter</a></h3>
<p class="packages-desc">MCP (Model Context Protocol) adapter extension for Pi coding agent</p>
<div class="packages-meta"><span>nicopreme</span><span>1M/mo</span><span>2d ago</span></div>
<div class="packages-badges"><span class="meta-chip packages-badge" data-type="extension">extension</span></div>
<div class="packages-links" aria-label="Links for pi-mcp-adapter">
<a href="https://www.npmjs.com/package/pi-mcp-adapter" target="_blank" rel="noopener">npm</a>
<a href="https://github.com/nicobailon/pi-mcp-adapter" target="_blank" rel="noopener">repo</a>
</div></div></article>
<article class="surface-panel content-card" data-package-card="true" data-package-name="@scope/pi-thing" data-package-search="thing" data-package-types="skill prompt" data-package-downloads="0" data-package-date="" data-package-sort-name="@scope/pi-thing">
<p class="packages-desc">A skill with <code>inline code</code> in the description</p>
<div class="packages-meta"><span>someone</span></div>
<div class="packages-badges"><span class="meta-chip packages-badge" data-type="skill">skill</span></div>
</article>
<article class="surface-panel content-card" data-package-card="true" data-package-name="pi-from-search" data-package-search="search" data-package-downloads="5" data-package-date="1700000000000">
<p class="packages-desc">Search result without a types attribute</p>
<div class="packages-badges">
<span class="meta-chip packages-badge" data-type="extension">extension</span>
<span class="meta-chip packages-badge" data-type="theme">theme</span>
<span class="meta-chip packages-badge" data-type="package">package</span>
</div>
</article>
</div>`;

const DETAIL_HTML = `
<div class="packages-install packages-install--detail">
<code><span class="prefix">$</span> pi install npm:pi-subagents</code>
<button type="button" data-copy="true" data-copy-text="pi install npm:pi-subagents" data-copy-label="Copy" class="button">Copy</button>
</div>
<dl class="definition-grid detail-grid">
<dt>Package</dt><dd><code>pi-subagents</code></dd>
<dt>Version</dt><dd><code>0.71.0</code></dd>
<dt>Published</dt><dd>Sep 23, 2026</dd>
<dt>Downloads</dt><dd>459.5K/mo · 132.8K/wk</dd>
<dt>Author</dt><dd>nicopreme</dd>
<dt>License</dt><dd>MIT</dd>
<dt>Types</dt><dd>extension, skill, prompt</dd>
<dt>Size</dt><dd>10.6 MB</dd>
<dt>Dependencies</dt><dd>5 dependencies · 4 peers</dd>
</dl>
<section class="surface-panel content-card notice-card packages-security-card">
<h2 class="content-card-title">Security note</h2>
<div class="content-card-body"><p>Pi packages can execute code and influence agent behavior. Review the source before installing third-party packages.</p></div>
</section>
<a href="https://www.npmjs.com/package/pi-subagents">npm</a>
<a href="https://github.com/nicopreme/pi-subagents">repo</a>
<p class="packages-desc">Pi extension for single-agent delegation and scripted multi-agent workflows</p>`;

test("parses catalog cards including scoped names and multi-type entries", () => {
  const items = parseCatalogPage(LIST_HTML);
  assert.equal(items.length, 3);

  assert.deepEqual(items[0], {
    name: "pi-mcp-adapter",
    description: "MCP (Model Context Protocol) adapter extension for Pi coding agent",
    types: ["extension"],
    downloads: 1037931,
    publishedAt: 1790147591556,
    author: "nicopreme",
    downloadsText: "1M/mo",
    publishedText: "2d ago",
    npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
    repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
  });

  assert.equal(items[1].name, "@scope/pi-thing");
  assert.deepEqual(items[1].types, ["skill", "prompt"]);
  assert.deepEqual(items[2].types, ["extension", "theme"], "search cards carry badges instead of the attribute");
  assert.equal(items[1].publishedAt, null, "an empty date attribute is not epoch zero");
  assert.equal(items[1].downloads, 0);
  assert.equal(items[1].description, "A skill with inline code in the description");
  assert.equal(items[1].downloadsText, null);
});

test("an empty catalog or foreign markup yields an empty list, not a throw", () => {
  assert.deepEqual(parseCatalogPage(""), []);
  assert.deepEqual(parseCatalogPage("<html><body>maintenance</body></html>"), []);
  assert.deepEqual(parseCatalogPage("<article>no attributes</article>"), []);
});

test("parses the detail metadata grid", () => {
  const detail = parsePackageDetail("pi-subagents", DETAIL_HTML);
  assert.equal(detail.version, "0.71.0");
  assert.equal(detail.installCommand, "pi install npm:pi-subagents");
  assert.equal(detail.license, "MIT");
  assert.equal(detail.size, "10.6 MB");
  assert.equal(detail.dependencies, "5 dependencies · 4 peers");
  assert.deepEqual(detail.types, ["extension", "skill", "prompt"]);
  assert.equal(detail.author, "nicopreme");
  assert.equal(detail.downloads, 459_500);
  assert.equal(detail.publishedAt, Date.parse("Sep 23, 2026"));
  assert.match(detail.securityNote, /can execute code/);
  assert.equal(detail.repoUrl, "https://github.com/nicopreme/pi-subagents");
  assert.equal(detail.description, "Pi extension for single-agent delegation and scripted multi-agent workflows");
  assert.match(detail.pageUrl, /\/packages\/pi-subagents$/);
});

test("a missing grid leaves every optional field null", () => {
  const detail = parsePackageDetail("mystery", "<html></html>");
  assert.equal(detail.version, null);
  assert.equal(detail.installCommand, null);
  assert.equal(detail.license, null);
  assert.equal(detail.securityNote, null);
  assert.deepEqual(detail.types, []);
  assert.equal(detail.downloads, 0);
});

test("formats the count and date the way the cards show them", () => {
  assert.equal(parseDownloadCount("1M/mo"), 1_000_000);
  assert.equal(parseDownloadCount("459.5K/mo · 132.8K/wk"), 459_500);
  assert.equal(parseDownloadCount("2.5B/mo"), 2_500_000_000);
  assert.equal(parseDownloadCount("123/mo"), 123);
  assert.equal(parseDownloadCount(null), 0);
  assert.equal(parseDownloadCount("no numbers"), 0);
  assert.equal(parsePublishedDate("Sep 23, 2026"), Date.parse("Sep 23, 2026"));
  assert.equal(parsePublishedDate(""), null);
  assert.equal(parsePublishedDate(null), null);
});

test("builds list URLs with only the parameters the site understands", () => {
  const url = marketListUrl({ query: "sub agents", type: "extension", sort: "recent", page: 3 }, "https://pi.dev");
  const params = new URLSearchParams(url.split("?")[1]);
  assert.equal(params.get("name"), "sub agents");
  assert.equal(params.get("type"), "extension");
  assert.equal(params.get("sort"), "recent");
  assert.equal(params.get("page"), "3");

  const plain = new URLSearchParams(marketListUrl({}, "https://pi.dev").split("?")[1]);
  assert.equal(plain.get("sort"), "downloads");
  assert.equal(plain.get("page"), null);
  assert.equal(plain.get("name"), null);

  // An unknown type is dropped instead of being forwarded to the site.
  const bogus = new URLSearchParams(marketListUrl({ type: "malware" }, "https://pi.dev").split("?")[1]);
  assert.equal(bogus.get("type"), null);
});

test("cache keys separate queries without leaking case or order", () => {
  assert.equal(
    marketListCacheKey({ query: "  PonyTail ", type: "theme", sort: "name", page: 2 }),
    marketListCacheKey({ query: "ponytail", type: "theme", sort: "name", page: 2 }),
  );
  assert.notEqual(marketListCacheKey({ query: "a" }), marketListCacheKey({ query: "b" }));
  assert.notEqual(marketListCacheKey({ page: 1 }), marketListCacheKey({ page: 2 }));
  assert.equal(marketListCacheKey({ page: 0 }), marketListCacheKey({ page: 1 }));
});

test("cache rows expire and survive a failed refresh as stale data", () => {
  const now = 1_000_000;
  writeMarketCache("list:downloads:::1", [{ name: "x" }], { db, now, ttlMs: MARKET_LIST_TTL_MS });

  const fresh = readMarketCache("list:downloads:::1", { db, now: now + 1_000 });
  assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.value, [{ name: "x" }]);

  const expired = readMarketCache("list:downloads:::1", { db, now: now + MARKET_LIST_TTL_MS + 1 });
  assert.equal(expired.stale, true);

  writeMarketCache("package:x", { name: "x" }, { db, now, ttlMs: MARKET_DETAIL_TTL_MS });
  assert.equal(readMarketCache("package:x", { db, now }).stale, false);
  assert.equal(readMarketCache("missing", { db, now }), null);

  db.prepare("INSERT INTO market_cache (source, cache_key, payload, fetched_at, expires_at) VALUES ('pi.dev','broken','{oops',0,0)").run();
  assert.equal(readMarketCache("broken", { db, now }), null);
});

test("base URLs and registry follow the environment", () => {
  assert.equal(marketBaseUrl({}), "https://pi.dev");
  assert.equal(marketBaseUrl({ PI_WEB_MARKET_BASE_URL: "https://mirror.example/pi/" }), "https://mirror.example/pi");
  assert.equal(npmRegistryUrl({}), "https://registry.npmjs.org");
  assert.equal(npmRegistryUrl({ PI_WEB_NPM_REGISTRY: "https://registry.npmmirror.com/" }), "https://registry.npmmirror.com");
});
