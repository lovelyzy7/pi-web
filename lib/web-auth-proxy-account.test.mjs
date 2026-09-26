import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const { createAccount, createWebSession, revokeWebSession } = await jiti.import("./auth-store.ts");
const { resetAuthThrottle } = await jiti.import("./auth-throttle-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

before(async () => {
  await createAccount("first-run-password", { db, now: 1_000 });
});

beforeEach(() => {
  resetAuthThrottle(null, db);
  delete globalThis.__piWebBasicAuthCache;
});

after(() => {
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  installDatabaseForTests(null);
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a configured account sends /init home and anonymous pages to the login page", () => {
  assert.equal(proxy(request("/init")).status, 307);
  assert.equal(proxy(request("/init")).headers.get("location"), "http://localhost/");

  const page = proxy(request("/user?tab=devices"));
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("location"), "http://localhost/login?next=%2Fuser%3Ftab%3Ddevices");
});

test("anonymous API requests get 401 with a challenge, not a redirect", () => {
  const response = proxy(request("/api/sessions"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Basic realm="Pi Web", charset="UTF-8"');
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a session cookie issued by the account store is accepted", () => {
  const session = createWebSession({ db, authMethod: "password" });
  const accepted = proxy(request("/", { Cookie: `pi_web_session=${session.token}` }));
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("x-middleware-next"), "1");
});

test("a revoked session falls back to the login page", () => {
  const session = createWebSession({ db, authMethod: "password" });
  revokeWebSession(session.sessionId, "test", db);

  assert.equal(proxy(request("/", { Cookie: `pi_web_session=${session.token}` })).status, 307);
  assert.equal(proxy(request("/api/sessions", { Cookie: `pi_web_session=${session.token}` })).status, 401);
});

test("an unknown or malformed cookie never authenticates", () => {
  for (const token of ["", "pws_nope", "not-a-token", "a".repeat(64)]) {
    assert.equal(proxy(request("/api/sessions", { Cookie: `pi_web_session=${token}` })).status, 401, token);
  }
});

test("HTTP Basic works against the account password and is throttled on failure", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("first-run-password") })).status, 200);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("wrong-password") })).status, 401);

  // The failure now blocks even the correct password, exactly like the login form.
  const blocked = proxy(request("/api/sessions", { Authorization: basic("first-run-password") }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
});

test("a verified Basic credential is cached instead of re-running scrypt", () => {
  const authorization = basic("first-run-password");
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  const cached = globalThis.__piWebBasicAuthCache;
  assert.ok(cached, "a successful verification must be remembered");
  assert.match(cached.digest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(cached).includes("first-run-password"));
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
});

test("Basic is ignored for pages and for non-Basic schemes", () => {
  assert.equal(proxy(request("/", { Authorization: basic("first-run-password") })).status, 307);
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
});

test("sign-in and first-run pages are marked as unthemed for the layout", () => {
  for (const path of ["/login", "/init"]) {
    const response = proxy(request(path));
    // `/init` redirects once configured, so assert on the header the layout reads.
    if (response.headers.get("x-middleware-next") === "1") {
      const forwarded = response.headers.get("x-middleware-request-x-pi-theme")
        ?? response.headers.get("x-pi-theme");
      assert.equal(forwarded, "off", path);
    }
  }
  const themed = proxy(request("/"));
  assert.notEqual(themed.headers.get("x-middleware-request-x-pi-theme"), "off");
});

test("the login and status endpoints stay reachable while configured", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

test("authentication endpoints skip the session check so /init can create one", () => {
  assert.equal(proxy(request("/api/web-auth/init")).status, 200);
});

test("untrusted hosts are rejected before any credential is examined", () => {
  const response = proxy(new NextRequest("http://evil.example/api/sessions", {
    headers: { Host: "evil.example", Authorization: basic("first-run-password") },
  }));
  assert.equal(response.status, 403);
});
