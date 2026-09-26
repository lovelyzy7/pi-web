import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const originalInitToken = process.env.PI_WEB_INIT_TOKEN;
delete process.env.PI_WEB_PASSWORD;
process.env.PI_WEB_INIT_TOKEN = "TEST-TOKEN";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../../lib/db.ts");
const { isAccountConfigured, listAuthEvents, listWebSessions, validateWebSession } =
  await jiti.import("../../../../lib/auth-store.ts");
const { resetAuthThrottle } = await jiti.import("../../../../lib/auth-throttle-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

beforeEach(() => {
  resetAuthThrottle(null, db);
  db.exec("DELETE FROM web_sessions; DELETE FROM auth_events; DELETE FROM account;");
});

after(() => {
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  if (originalInitToken === undefined) delete process.env.PI_WEB_INIT_TOKEN;
  else process.env.PI_WEB_INIT_TOKEN = originalInitToken;
  installDatabaseForTests(null);
});

function request(method, body, headers = {}) {
  return new NextRequest("http://localhost/api/web-auth/init", {
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

test("reports that setup is required before an account exists", async () => {
  const body = await (await GET(request("GET"))).json();
  assert.equal(body.required, true);
  assert.equal(body.reason, "first-run");
  assert.equal(body.username, "pi");
  assert.equal(body.passwordPolicy.minLength, 10);
  assert.equal(body.sessionMaxAgeSeconds, 30 * 24 * 60 * 60);
});

test("rejects a missing or wrong setup code", async () => {
  const missing = await POST(request("POST", { password: "a-long-enough-password" }));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error, "invalid_setup_code");

  // A failed code counts toward the init throttle, so even the right code is
  // refused until the block lifts.
  const blocked = await POST(request("POST", { password: "a-long-enough-password", setupCode: "TEST-TOKEN" }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");

  resetAuthThrottle("init", db);
  const wrong = await POST(request("POST", { password: "a-long-enough-password", setupCode: "WRONG-CODE" }));
  assert.equal(wrong.status, 401);

  const events = listAuthEvents({ limit: 10 }, db);
  assert.ok(events.some((event) => event.result === "fail" && event.kind === "setup"));
  assert.equal(isAccountConfigured(db), false);
});

test("rejects a weak password before creating anything", async () => {
  const response = await POST(request("POST", { password: "short", setupCode: "test-token" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "weak_password", reason: "too-short" });
  assert.equal(isAccountConfigured(db), false);

  const repeated = await POST(request("POST", { password: "aaaaaaaaaaaaaa", setupCode: "test-token" }));
  assert.equal(repeated.status, 400);
  assert.equal((await repeated.json()).reason, "repeated");
});

test("creates the account, signs the browser in, and closes the endpoint", async () => {
  const response = await POST(request("POST", {
    password: "a-long-enough-password",
    setupCode: "test-token",
    // The code is compared case-insensitively.
  }, { "X-Forwarded-For": "203.0.113.5", "User-Agent": "SetupBrowser/1.0" }));

  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=pws_/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);

  assert.equal(isAccountConfigured(db), true);
  const token = cookie.split(";", 1)[0].split("=")[1];
  assert.equal(validateWebSession(token, { db }).ok, true);

  const session = listWebSessions({ db, includeInactive: true })[0];
  assert.equal(session.ip, "203.0.113.5");
  assert.equal(session.userAgent, "SetupBrowser/1.0");

  const events = listAuthEvents({ limit: 5 }, db);
  assert.equal(events[0].kind, "setup");
  assert.equal(events[0].result, "ok");

  // Idempotence guards: the endpoint is closed, and the status endpoint says so.
  assert.equal((await POST(request("POST", { password: "another-long-password", setupCode: "test-token" }))).status, 409);
  const status = await (await GET(request("GET"))).json();
  assert.equal(status.required, false);
  assert.equal(status.reason, "configured");
  assert.equal(status.setupCodeRequired, false);
});

test("setup is refused entirely while PI_WEB_PASSWORD is set", async () => {
  process.env.PI_WEB_PASSWORD = "environment-password";
  try {
    const status = await (await GET(request("GET"))).json();
    assert.deepEqual(status, { required: false, reason: "environment", username: "pi" });

    const response = await POST(request("POST", { password: "a-long-enough-password" }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "environment_password");
    assert.equal(isAccountConfigured(db), false);
  } finally {
    delete process.env.PI_WEB_PASSWORD;
  }
});

test("rejects cross-origin setup attempts", async () => {
  const response = await POST(request("POST", { password: "a-long-enough-password", setupCode: "test-token" }, {
    Origin: "https://attacker.example",
    "Sec-Fetch-Site": "cross-site",
  }));
  assert.equal(response.status, 403);
});
