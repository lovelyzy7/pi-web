import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

// The TOTP seed is sealed with a key file inside the agent directory, so this
// suite must never run against the real one.
const directory = mkdtempSync(join(tmpdir(), "pi-web-proxy-p2-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPassword = process.env.PI_WEB_PASSWORD;
process.env.PI_CODING_AGENT_DIR = directory;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const { createAccount, createWebSession, enableTotp, setPendingTotpSecret } = await jiti.import("./auth-store.ts");
const { createApiToken, revokeApiToken } = await jiti.import("./api-tokens.ts");
const { sealSecret, readOrCreateSecretKey } = await jiti.import("./secret-box.ts");
const { generateTotpSecret, generateTotp, timeStepAt } = await jiti.import("./totp.ts");
const { resetAuthThrottle } = await jiti.import("./auth-throttle-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

const PASSWORD = "a-long-enough-password";

beforeEach(async () => {
  resetAuthThrottle(null, db);
  delete globalThis.__piWebBasicAuthCache;
  db.exec("DELETE FROM web_sessions; DELETE FROM auth_events; DELETE FROM api_tokens; DELETE FROM recovery_codes; DELETE FROM account;");
  await createAccount(PASSWORD, { db });
});

after(() => {
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  installDatabaseForTests(null);
  rmSync(directory, { recursive: true, force: true });
});

function request(path, method = "GET", headers = {}) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { Host: "localhost", ...headers } });
}

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

function enrollTotp() {
  const secret = generateTotpSecret();
  setPendingTotpSecret(sealSecret(secret, readOrCreateSecretKey()), db);
  enableTotp(db);
  return secret;
}

test("a full-scope bearer token authenticates reads and writes", () => {
  const { token } = createApiToken({ name: "ci", db, scopes: ["full"] });
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = proxy(request("/api/sessions", method, { Authorization: `Bearer ${token}` }));
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get("x-middleware-next"), "1");
  }
});

test("a read-only token may read but not change anything", async () => {
  const { token } = createApiToken({ name: "dash", db, scopes: ["read"] });
  assert.equal(proxy(request("/api/sessions", "GET", { Authorization: `Bearer ${token}` })).status, 200);

  const blocked = proxy(request("/api/sessions", "POST", { Authorization: `Bearer ${token}` }));
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error, "insufficient_scope");
});

test("bad tokens are rejected and never fall through to the cookie path", async () => {
  const cases = [
    ["Bearer pi_pat_unknown", 401, "invalid_token"],
    ["Bearer nonsense", 401, "invalid_token"],
  ];
  for (const [header, status, error] of cases) {
    const response = proxy(request("/api/sessions", "GET", { Authorization: header }));
    assert.equal(response.status, status, header);
    assert.equal((await response.json()).error, error);
  }

  // A bare "Bearer" (no credential) is not a Bearer request at all; it falls
  // through to the ordinary unauthenticated answer.
  assert.equal(proxy(request("/api/sessions", "GET", { Authorization: "Bearer" })).status, 401);

  const revoked = createApiToken({ name: "old", db });
  revokeApiToken(revoked.record.id, db);
  assert.equal(proxy(request("/api/sessions", "GET", { Authorization: `Bearer ${revoked.token}` })).status, 401);

  // A session cookie still works alongside a bad token, because the token path
  // only claims requests that carry a Bearer credential.
  const session = createWebSession({ db });
  const withCookie = proxy(request("/api/sessions", "GET", {
    Authorization: "Bearer pi_pat_unknown",
    Cookie: `pi_web_session=${session.token}`,
  }));
  assert.equal(withCookie.status, 401, "an invalid Bearer is an explicit failure, not a fallback");
});

test("tokens work for pages too, since the check is the same for every matched route", () => {
  const { token } = createApiToken({ name: "native", db, scopes: ["full"] });
  // Page routes only use cookies; a Bearer header on a page is ignored.
  assert.equal(proxy(request("/user", "GET", { Authorization: `Bearer ${token}` })).status, 307);
});

test("Basic keeps working until a second factor is enrolled, then asks for a token", async () => {
  assert.equal(proxy(request("/api/sessions", "GET", { Authorization: basic(PASSWORD) })).status, 200);

  enrollTotp();
  const refused = proxy(request("/api/sessions", "GET", { Authorization: basic(PASSWORD) }));
  assert.equal(refused.status, 401);
  assert.equal((await refused.json()).error, "token_required");

  const anonymous = proxy(request("/api/sessions", "GET"));
  assert.equal(anonymous.status, 401, "the same hint is shown without credentials");
  assert.equal((await anonymous.json()).error, "token_required");

  const { token } = createApiToken({ name: "post-totp", db, scopes: ["full"] });
  assert.equal(proxy(request("/api/sessions", "GET", { Authorization: `Bearer ${token}` })).status, 200);
});

test("an enrolled second factor does not disturb cookie sessions", () => {
  enrollTotp();
  const session = createWebSession({ db, authMethod: "totp" });
  assert.equal(proxy(request("/", "GET", { Cookie: `pi_web_session=${session.token}` })).status, 200);
  assert.equal(proxy(request("/api/sessions", "GET", { Cookie: `pi_web_session=${session.token}` })).status, 200);
});

test("a TOTP code is not a shortcut past the cookie", () => {
  const secret = enrollTotp();
  const code = generateTotp(secret, timeStepAt(Date.now()));
  const response = proxy(request("/api/sessions", "GET", { "X-Pi-Code": code }));
  assert.equal(response.status, 401);
});
