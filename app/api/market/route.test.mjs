import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const marketRoute = await jiti.import("./route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const { writeMarketCache } = await jiti.import("../../../lib/market-catalog.ts");
const { createAccount } = await jiti.import("../../../lib/auth-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

beforeEach(async () => {
  db.exec("DELETE FROM market_cache; DELETE FROM update_checks; DELETE FROM account;");
  await createAccount("a-long-enough-password", { db });
});

after(() => {
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  installDatabaseForTests(null);
});

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

test("the catalog is served from the cache and never hits the network in tests", async () => {
  const now = Date.now();
  writeMarketCache("list:downloads:::1", [{
    name: "pi-subagents",
    description: "delegation",
    types: ["extension"],
    downloads: 10,
    publishedAt: now,
    author: "nicopreme",
    npmUrl: null,
    repoUrl: null,
    downloadsText: "10/mo",
    publishedText: null,
  }], { db, now, ttlMs: 60 * 60 * 1000 });

  const response = await marketRoute.GET(request("/api/market"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].name, "pi-subagents");
  assert.equal(body.fromCache, true);
  assert.equal(body.stale, false);
  assert.equal(body.baseUrl, "https://pi.dev/packages");
});

test("an uncached query with no network answers an empty page instead of failing", async () => {
  // No cache entry and no reachable pi.dev: fetchText times out or fails, and the
  // route must still answer with a valid, empty page.
  const response = await marketRoute.GET(request("/api/market?q=nothing-cached&page=2"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.items, []);
  assert.equal(body.page, 2);
  assert.equal(body.hasMore, false);
});

test("a package detail that is not cached reports 404 rather than a network error", async () => {
  const response = await marketRoute.GET(request("/api/market?package=@scope/does-not-exist"));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "package_not_found");
});

test("rejects an untrusted host", async () => {
  assert.equal((await marketRoute.GET(request("/api/market", "GET", undefined, { Host: "evil.example" }))).status, 403);
});
