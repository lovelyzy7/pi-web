import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const {
  isAccountConfigured, createAccount, readAccount, verifyAccountPassword, changeAccountPassword,
  createWebSession, validateWebSession, revokeWebSession, revokeAllWebSessions, listWebSessions,
  pruneWebSessions, recordAuthEvent, listAuthEvents, pruneAuthEvents, recordLogin,
  readAppSetting, writeAppSetting, sessionIdForToken, idleSessionTtlMs,
  DEFAULT_SESSION_IDLE_TTL_MS,
} = await jiti.import("./auth-store.ts");

let db;

before(() => {
  db = openDatabase(":memory:");
  installDatabaseForTests(db);
});

after(() => {
  installDatabaseForTests(null);
  db?.close();
});

test("starts unconfigured and flips once an account exists", async () => {
  assert.equal(isAccountConfigured(db), false);
  assert.equal(readAccount(db), null);

  await createAccount("a-long-enough-password", { db, now: 1_000 });
  assert.equal(isAccountConfigured(db), true);

  const account = readAccount(db);
  assert.equal(account.username, "pi");
  assert.equal(account.sessionEpoch, 1);
  assert.equal(account.passwordChangedAt, 1_000);
  assert.equal(account.lastLoginAt, null);
  assert.equal(await verifyAccountPassword("a-long-enough-password", db), true);
  assert.equal(await verifyAccountPassword("wrong-password", db), false);
});

test("changing the password bumps the epoch and rejects bad input", async () => {
  const wrong = await changeAccountPassword("not-the-password", "another-long-password", db);
  assert.deepEqual(wrong, { ok: false, reason: "invalid-password" });

  const same = await changeAccountPassword("a-long-enough-password", "a-long-enough-password", db);
  assert.deepEqual(same, { ok: false, reason: "same-password" });

  const ok = await changeAccountPassword("a-long-enough-password", "another-long-password", db);
  assert.deepEqual(ok, { ok: true });
  assert.equal(readAccount(db).sessionEpoch, 2);
  assert.equal(await verifyAccountPassword("another-long-password", db), true);
  assert.equal(await verifyAccountPassword("a-long-enough-password", db), false);
});

test("session tokens are stored as digests, never as the token itself", () => {
  const session = createWebSession({ db, now: 5_000, ip: "10.0.0.5", userAgent: "Test/1.0" });
  assert.match(session.token, /^pws_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(session.sessionId, session.token);
  assert.equal(session.sessionId, sessionIdForToken(session.token));

  const stored = db.prepare("SELECT id FROM web_sessions").all().map((row) => row.id);
  assert.ok(stored.includes(session.sessionId));
  assert.ok(!stored.some((id) => id.includes(session.token)));
});

test("validates live sessions and reports why a session failed", () => {
  const now = 1_000_000;
  const live = createWebSession({ db, now, idleTtlMs: 60_000, absoluteTtlMs: 120_000 });

  const accepted = validateWebSession(live.token, { db, now: now + 1_000 });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.reason, "ok");
  assert.equal(accepted.session.ip, null);

  assert.equal(validateWebSession(undefined, { db, now }).reason, "unknown");
  assert.equal(validateWebSession("pws_not-a-real-token", { db, now }).reason, "unknown");
  assert.equal(
    validateWebSession(live.token, { db, now: now + 120_001 }).reason,
    "expired",
  );

  revokeWebSession(live.sessionId, "test", db, now);
  assert.equal(validateWebSession(live.token, { db, now: now + 1 }).reason, "revoked");
});

test("an epoch bump invalidates sessions that were not explicitly revoked", () => {
  const now = 2_000_000;
  const session = createWebSession({ db, now });
  db.prepare("UPDATE account SET session_epoch = session_epoch + 1 WHERE id = 1").run();
  assert.equal(validateWebSession(session.token, { db, now: now + 1 }).reason, "epoch");
});

test("the sliding idle window extends an active session but not past the absolute cap", () => {
  const now = 3_000_000;
  const session = createWebSession({ db, now, idleTtlMs: 10 * 60_000, absoluteTtlMs: 60 * 60_000 });

  // The touch interval throttles writes, so jump far enough to trigger one.
  const later = now + 6 * 60_000;
  assert.equal(validateWebSession(session.token, { db, now: later }).ok, true);
  const row = db.prepare("SELECT expires_at, last_seen_at FROM web_sessions WHERE id = ?")
    .get(session.sessionId);
  assert.equal(row.last_seen_at, later);
  assert.equal(row.expires_at, later + 10 * 60_000);

  // A session that already lapsed cannot be revived by a touch.
  const lapsed = createWebSession({ db, now: now + 10_000_000, idleTtlMs: 60_000 });
  assert.equal(
    validateWebSession(lapsed.token, { db, now: now + 10_000_000 + 60_001 }).reason,
    "expired",
  );

  // Absolute lifetime still ends the session.
  assert.equal(validateWebSession(session.token, { db, now: now + 60 * 60_000 + 1 }).reason, "expired");
});

test("a session created before the account exists fails closed", () => {
  const fresh = openDatabase(":memory:");
  try {
    const now = 4_000_000;
    const session = createWebSession({ db: fresh, now });
    assert.equal(isAccountConfigured(fresh), false);
    assert.equal(validateWebSession(session.token, { db: fresh, now }).reason, "not-configured");
  } finally {
    fresh.close();
  }
});

test("revoking all sessions keeps exactly the caller's session alive", () => {
  const now = 5_000_000;
  const current = createWebSession({ db, now, authMethod: "password" });
  const other = createWebSession({ db, now: now + 1, authMethod: "basic" });

  const revoked = revokeAllWebSessions("password-change", { keepSessionId: current.sessionId, db, now });
  assert.ok(revoked >= 1);
  assert.equal(validateWebSession(current.token, { db, now: now + 10 }).ok, true);
  assert.equal(validateWebSession(other.token, { db, now: now + 10 }).reason, "revoked");

  const listed = listWebSessions({ currentSessionId: current.sessionId, db, now: now + 10 });
  assert.equal(listed.find((session) => session.current)?.id, current.sessionId);
  assert.ok(!listed.some((session) => session.id === other.sessionId));
});

test("prunes expired rows and keeps the live ones", () => {
  const now = 6_000_000;
  const live = createWebSession({ db, now, idleTtlMs: 60_000, absoluteTtlMs: 60_000 });
  const removed = pruneWebSessions(db, now + 60_001);
  assert.ok(removed >= 1);
  const remaining = db.prepare("SELECT id FROM web_sessions WHERE id = ?").get(live.sessionId);
  assert.equal(remaining, undefined);
});

test("records, lists, and prunes audit events", () => {
  const before = listAuthEvents({ limit: 200 }, db).length;
  recordAuthEvent({ kind: "login", result: "fail", ip: "203.0.113.9", detail: { reason: "bad-password" } }, db, 1);
  recordAuthEvent({ kind: "login", result: "ok", username: "pi", ip: "203.0.113.9" }, db, 2);

  const events = listAuthEvents({ limit: 2 }, db);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, "login");
  assert.equal(events[0].result, "ok");
  assert.equal(events[1].detail, JSON.stringify({ reason: "bad-password" }));
  assert.ok(listAuthEvents({ limit: 50 }, db).length >= before);

  const byKind = listAuthEvents({ kind: "login", limit: 200 }, db);
  assert.ok(byKind.every((event) => event.kind === "login"));

  pruneAuthEvents(db, 1);
  assert.equal(listAuthEvents({ limit: 200 }, db).length, 1);
});

test("keeps a login timestamp on the account", async () => {
  await recordLogin(db, 42_000);
  assert.equal(readAccount(db).lastLoginAt, 42_000);
});

test("application settings round-trip and survive unreadable values", () => {
  assert.equal(readAppSetting("market.ttl", db), undefined);
  writeAppSetting("market.ttl", { list: 6, detail: 24 }, db);
  assert.deepEqual(readAppSetting("market.ttl", db), { list: 6, detail: 24 });

  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('broken', '{oops', 1)").run();
  assert.equal(readAppSetting("broken", db), undefined);
});

test("idle session TTL honors the environment override", () => {
  assert.equal(idleSessionTtlMs({}), DEFAULT_SESSION_IDLE_TTL_MS);
  assert.equal(idleSessionTtlMs({ PI_WEB_SESSION_TTL_MS: "60000" }), 60_000);
  assert.equal(idleSessionTtlMs({ PI_WEB_SESSION_TTL_MS: "0" }), DEFAULT_SESSION_IDLE_TTL_MS);
  assert.equal(idleSessionTtlMs({ PI_WEB_SESSION_TTL_MS: "nope" }), DEFAULT_SESSION_IDLE_TTL_MS);
  assert.equal(idleSessionTtlMs({ PI_WEB_SESSION_TTL_MS: `${2 ** 53}` }), DEFAULT_SESSION_IDLE_TTL_MS);
});
