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
const { GET, POST, DELETE } = await jiti.import("./route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const { createAccount, listAuthEvents, listWebSessions } = await jiti.import("../../../lib/auth-store.ts");
const { resetAuthThrottle } = await jiti.import("../../../lib/auth-throttle-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

beforeEach(async () => {
  resetAuthThrottle(null, db);
  db.exec("DELETE FROM web_sessions; DELETE FROM auth_events; DELETE FROM account;");
});

after(() => {
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  installDatabaseForTests(null);
});

function request(method, body, headers = {}) {
  return new NextRequest("http://localhost/api/web-auth", {
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

test("reports the first-run state before an account exists", async () => {
  const body = await (await GET(request("GET"))).json();
  assert.equal(body.enabled, false);
  assert.equal(body.configured, false);
  assert.equal(body.source, "none");
  assert.equal(body.authenticated, false);
  assert.equal(body.username, "pi");
});

test("refuses to log in before the account exists", async () => {
  const response = await POST(request("POST", { password: "any-long-password" }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "setup_required");
});

test("logs in with the account password and remembers the device", async () => {
  await createAccount("a-long-enough-password", { db });

  const failure = await POST(request("POST", { password: "wrong" }));
  assert.equal(failure.status, 401);

  resetAuthThrottle(null, db);
  const response = await POST(request("POST", { password: "a-long-enough-password" }, {
    "X-Forwarded-For": "203.0.113.7, 10.0.0.1",
    "User-Agent": "TestBrowser/1.0",
  }));
  assert.equal(response.status, 200);

  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=pws_/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);

  const session = listWebSessions({ db, includeInactive: true })[0];
  assert.equal(session.authMethod, "password");
  assert.equal(session.ip, "203.0.113.7");
  assert.equal(session.userAgent, "TestBrowser/1.0");

  const events = listAuthEvents({ limit: 10 }, db);
  assert.equal(events[0].kind, "login");
  assert.equal(events[0].result, "ok");
  assert.equal(events[1].result, "fail");

  const status = await GET(request("GET", undefined, { Cookie: cookie.split(";", 1)[0] }));
  const body = await status.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.source, "account");
  assert.equal(body.configured, true);
});

test("a secure request gets a Secure cookie", async () => {
  await createAccount("a-long-enough-password", { db });
  const response = await POST(new NextRequest("https://localhost/api/web-auth", {
    method: "POST",
    headers: {
      Host: "localhost",
      Origin: "https://localhost",
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Proto": "https",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: "a-long-enough-password" }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Secure/i);
});

test("logout revokes the session row, not just the cookie", async () => {
  await createAccount("a-long-enough-password", { db });
  const login = await POST(request("POST", { password: "a-long-enough-password" }));
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  const response = await DELETE(request("DELETE", undefined, { Cookie: cookie }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);

  const status = await GET(request("GET", undefined, { Cookie: cookie }));
  assert.equal((await status.json()).authenticated, false);
  const session = listWebSessions({ db, includeInactive: true })[0];
  assert.equal(session.revokedReason, "logout");
});

test("login is throttled across the process, not per connection", async () => {
  await createAccount("a-long-enough-password", { db });
  assert.equal((await POST(request("POST", { password: "wrong" }))).status, 401);

  const blocked = await POST(request("POST", { password: "a-long-enough-password" }));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
});

test("rejects cross-origin login attempts", async () => {
  await createAccount("a-long-enough-password", { db });
  const response = await POST(request("POST", { password: "a-long-enough-password" }, {
    Origin: "https://attacker.example",
    "Sec-Fetch-Site": "cross-site",
  }));
  assert.equal(response.status, 403);
});
