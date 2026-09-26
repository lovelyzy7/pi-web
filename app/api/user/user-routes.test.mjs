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
const profileRoute = await jiti.import("./route.ts");
const passwordRoute = await jiti.import("./password/route.ts");
const sessionsRoute = await jiti.import("./sessions/route.ts");
const sessionRoute = await jiti.import("./sessions/[id]/route.ts");
const auditRoute = await jiti.import("./audit/route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const {
  createAccount, createWebSession, isAccountConfigured, listAuthEvents, listWebSessions,
  readAccount, recordAuthEvent, sessionIdForToken, validateWebSession,
} = await jiti.import("../../../lib/auth-store.ts");
const { resetAuthThrottle } = await jiti.import("../../../lib/auth-throttle-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

beforeEach(async () => {
  resetAuthThrottle(null, db);
  delete globalThis.__piWebBasicAuthCache;
  db.exec("DELETE FROM web_sessions; DELETE FROM auth_events; DELETE FROM account;");
});

after(() => {
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
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

function cookieFor(token) {
  return { Cookie: `pi_web_session=${token}` };
}

async function setUpAccount() {
  await createAccount("a-long-enough-password", { db });
  const session = createWebSession({ db, authMethod: "password" });
  return session;
}

test("reports environment mode and refuses account writes while PI_WEB_PASSWORD is set", async () => {
  process.env.PI_WEB_PASSWORD = "environment-password";
  try {
    const profile = await profileRoute.GET(request("/api/user"));
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).mode, "environment");

    const sessions = await sessionsRoute.GET(request("/api/user/sessions"));
    assert.equal((await sessions.json()).mode, "environment");

    const audit = await auditRoute.GET(request("/api/user/audit"));
    assert.equal((await audit.json()).mode, "environment");

    const change = await passwordRoute.PUT(request("/api/user/password", "PUT", {
      currentPassword: "environment-password",
      newPassword: "a-long-enough-password",
    }));
    assert.equal(change.status, 409);
    assert.equal((await change.json()).error, "environment_password");
  } finally {
    delete process.env.PI_WEB_PASSWORD;
  }
});

test("requires an account before reporting anything", async () => {
  const response = await profileRoute.GET(request("/api/user"));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "setup_required");
});

test("returns the account overview and the current session", async () => {
  const session = await setUpAccount();
  const response = await profileRoute.GET(request("/api/user", "GET", undefined, cookieFor(session.token)));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.mode, "account");
  assert.equal(body.username, "pi");
  assert.equal(body.configured, true);
  assert.equal(body.session.id, session.sessionId);
  assert.equal(body.session.authMethod, "password");
  assert.ok(body.sessionMaxAgeMs > 0);
});

test("changes the password, signs out other devices, and hands back a fresh session", async () => {
  const first = await setUpAccount();
  const second = createWebSession({ db, authMethod: "basic" });

  const weak = await passwordRoute.PUT(request("/api/user/password", "PUT", {
    currentPassword: "a-long-enough-password",
    newPassword: "short",
  }, cookieFor(first.token)));
  assert.equal(weak.status, 400);
  assert.equal((await weak.json()).error, "weak_password");

  const wrong = await passwordRoute.PUT(request("/api/user/password", "PUT", {
    currentPassword: "not-the-password",
    newPassword: "another-long-password",
  }, cookieFor(first.token)));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "invalid_password");

  resetAuthThrottle(null, db);
  const changed = await passwordRoute.PUT(request("/api/user/password", "PUT", {
    currentPassword: "a-long-enough-password",
    newPassword: "another-long-password",
  }, cookieFor(first.token)));
  assert.equal(changed.status, 200);
  const body = await changed.json();
  assert.equal(body.ok, true);
  assert.ok(body.signedOutSessions >= 2);

  const newCookie = changed.headers.get("set-cookie");
  assert.match(newCookie, /^pi_web_session=pws_/);
  const newToken = newCookie.split(";", 1)[0].split("=")[1];
  assert.equal(validateWebSession(newToken, { db }).ok, true);
  // Both layers fire: the epoch bump makes every existing cookie stale, and the
  // revoked rows are what the device list shows.
  assert.ok(readAccount(db).sessionEpoch >= 2);
  assert.equal(validateWebSession(first.token, { db }).reason, "revoked");
  assert.equal(validateWebSession(second.token, { db }).reason, "revoked");

  const events = listAuthEvents({ kind: "password", limit: 10 }, db);
  assert.equal(events[0].result, "ok");
  assert.equal(events[1].result, "fail");
});

test("lists devices and can sign out one or all of the others", async () => {
  const current = await setUpAccount();
  const other = createWebSession({ db, authMethod: "basic", ip: "203.0.113.9" });

  const listed = await sessionsRoute.GET(request("/api/user/sessions", "GET", undefined, cookieFor(current.token)));
  const listBody = await listed.json();
  assert.equal(listBody.sessions.length, 2);
  assert.equal(listBody.sessions.find((session) => session.current).id, current.sessionId);
  assert.equal(listBody.sessions.find((session) => !session.current).ip, "203.0.113.9");

  const invalid = await sessionRoute.DELETE(
    request(`/api/user/sessions/not-a-digest`, "DELETE", undefined, cookieFor(current.token)),
    { params: Promise.resolve({ id: "not-a-digest" }) },
  );
  assert.equal(invalid.status, 400);

  const unknown = await sessionRoute.DELETE(
    request(`/api/user/sessions/${"a".repeat(64)}`, "DELETE", undefined, cookieFor(current.token)),
    { params: Promise.resolve({ id: "a".repeat(64) }) },
  );
  assert.equal(unknown.status, 404);

  const revoked = await sessionRoute.DELETE(
    request(`/api/user/sessions/${other.sessionId}`, "DELETE", undefined, cookieFor(current.token)),
    { params: Promise.resolve({ id: other.sessionId }) },
  );
  assert.deepEqual(await revoked.json(), { ok: true, self: false });
  assert.equal(validateWebSession(other.token, { db }).ok, false);

  const extra = createWebSession({ db });
  const all = await sessionsRoute.DELETE(request("/api/user/sessions", "DELETE", undefined, cookieFor(current.token)));
  const allBody = await all.json();
  assert.equal(allBody.ok, true);
  assert.ok(allBody.revoked >= 1);
  assert.equal(validateWebSession(extra.token, { db }).ok, false);
  assert.equal(validateWebSession(current.token, { db }).ok, true);
});

test("revoking your own session is allowed and reports self", async () => {
  const current = await setUpAccount();
  const response = await sessionRoute.DELETE(
    request(`/api/user/sessions/${current.sessionId}`, "DELETE", undefined, cookieFor(current.token)),
    { params: Promise.resolve({ id: current.sessionId }) },
  );
  assert.deepEqual(await response.json(), { ok: true, self: true });
  assert.equal(validateWebSession(current.token, { db }).reason, "revoked");
});

test("audit reads are paged and filtered", async () => {
  await setUpAccount();
  for (let index = 0; index < 5; index += 1) {
    recordAuthEvent({ kind: index % 2 === 0 ? "login" : "logout", result: "ok", ip: "127.0.0.1" }, db);
  }

  const all = await (await auditRoute.GET(request("/api/user/audit?limit=3"))).json();
  assert.equal(all.mode, "account");
  assert.equal(all.events.length, 3);

  const filtered = await (await auditRoute.GET(request("/api/user/audit?kind=login"))).json();
  assert.ok(filtered.events.length > 0);
  assert.ok(filtered.events.every((event) => event.kind === "login"));

  const ignored = await (await auditRoute.GET(request("/api/user/audit?kind=not-a-kind"))).json();
  assert.ok(ignored.events.length > 0);
});

test("every user route rejects an untrusted host", async () => {
  await setUpAccount();
  for (const call of [
    () => profileRoute.GET(request("/api/user", "GET", undefined, { Host: "evil.example" })),
    () => sessionsRoute.GET(request("/api/user/sessions", "GET", undefined, { Host: "evil.example" })),
    () => auditRoute.GET(request("/api/user/audit", "GET", undefined, { Host: "evil.example" })),
  ]) {
    assert.equal((await call()).status, 403);
  }
});

test("session ids are digests, never the cookie value", async () => {
  const session = await setUpAccount();
  assert.equal(session.sessionId, sessionIdForToken(session.token));
  const stored = listWebSessions({ db, includeInactive: true });
  assert.equal(stored.length, 1);
  assert.equal(isAccountConfigured(db), true);
});
