import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const {
  createApiToken, verifyApiToken, listApiTokens, revokeApiToken, pruneApiTokens,
  apiTokenAllowsMethod, normalizeScopes, tokenHashFor, API_TOKEN_PREFIX, API_TOKEN_TOUCH_INTERVAL_MS,
} = await jiti.import("./api-tokens.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

before(() => { db.exec("DELETE FROM api_tokens"); });
after(() => { installDatabaseForTests(null); });

test("creates a token whose plaintext is never stored", () => {
  const { token, record } = createApiToken({ name: "ci", db, now: 1_000 });
  assert.match(token, /^pi_pat_[A-Za-z0-9_-]{32}$/);
  assert.equal(record.name, "ci");
  assert.deepEqual(record.scopes, ["full"]);
  assert.equal(record.prefix, token.slice(0, API_TOKEN_PREFIX.length + 8));
  assert.equal(record.lastUsedAt, null);
  assert.ok(record.prefix.length < token.length, "the prefix is only a display hint");

  const stored = db.prepare("SELECT token_hash FROM api_tokens WHERE id = ?").get(record.id).token_hash;
  assert.equal(stored, tokenHashFor(token));
  assert.ok(!stored.includes(token));
  assert.ok(!JSON.stringify(listApiTokens(db)).includes(token));
});

test("verifies a live token and records first use", () => {
  const { token, record } = createApiToken({ name: "scripts", db, now: 2_000 });
  const now = 10_000 + API_TOKEN_TOUCH_INTERVAL_MS;

  const accepted = verifyApiToken(token, { db, now });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.token.id, record.id);
  assert.equal(listApiTokens(db).find((item) => item.id === record.id).lastUsedAt, now);
});

test("does not rewrite last_used_at on every request", () => {
  const { token, record } = createApiToken({ name: "busy", db, now: 5_000 });
  const first = 20_000;
  verifyApiToken(token, { db, now: first });
  verifyApiToken(token, { db, now: first + 1_000 });
  assert.equal(listApiTokens(db).find((item) => item.id === record.id).lastUsedAt, first);
  verifyApiToken(token, { db, now: first + API_TOKEN_TOUCH_INTERVAL_MS });
  assert.equal(
    listApiTokens(db).find((item) => item.id === record.id).lastUsedAt,
    first + API_TOKEN_TOUCH_INTERVAL_MS,
  );
});

test("rejects unknown, revoked, and expired tokens with a reason", () => {
  assert.deepEqual(verifyApiToken(null, { db }), { ok: false, reason: "unknown" });
  assert.deepEqual(verifyApiToken("pi_pat_nope", { db }), { ok: false, reason: "unknown" });
  assert.deepEqual(verifyApiToken("not-a-token", { db }), { ok: false, reason: "unknown" });

  const revoked = createApiToken({ name: "revoked", db, now: 1 }).record;
  revokeApiToken(revoked.id, db, 2);
  const revokedToken = listApiTokens(db).find((item) => item.id === revoked.id);
  assert.ok(revokedToken.revokedAt !== null);
  assert.equal(revokeApiToken(revoked.id, db, 3), false, "revoking twice is a no-op");

  const expiring = createApiToken({ name: "expiring", db, now: 1_000, expiresAt: 2_000 });
  assert.deepEqual(
    verifyApiToken(expiring.token, { db, now: 2_001 }),
    { ok: false, reason: "expired" },
  );
});

test("scopes decide whether a token may write", () => {
  assert.deepEqual(normalizeScopes(undefined), ["full"]);
  assert.deepEqual(normalizeScopes([]), ["full"]);
  assert.deepEqual(normalizeScopes(["read"]), ["read"]);
  assert.deepEqual(normalizeScopes(["read", "read", "nonsense"]), ["read"]);

  const read = createApiToken({ name: "reader", db, scopes: ["read"] }).record;
  const full = createApiToken({ name: "writer", db, scopes: ["full"] }).record;
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(apiTokenAllowsMethod(read.scopes, method), true, method);
    assert.equal(apiTokenAllowsMethod(full.scopes, method), true, method);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(apiTokenAllowsMethod(read.scopes, method), false, method);
    assert.equal(apiTokenAllowsMethod(full.scopes, method), true, method);
  }
});

test("pruning drops long-dead rows and keeps live ones", () => {
  const live = createApiToken({ name: "live", db, now: 1_000_000 }).record;
  const dayMs = 24 * 60 * 60 * 1000;
  const removed = pruneApiTokens(db, 1_000_000 + 91 * dayMs);
  assert.ok(removed >= 1);
  assert.ok(listApiTokens(db).some((item) => item.id === live.id));
});

test("tokens are independent of each other", () => {
  const first = createApiToken({ name: "one", db });
  const second = createApiToken({ name: "two", db });
  assert.notEqual(first.token, second.token);
  revokeApiToken(first.record.id, db);
  assert.equal(verifyApiToken(first.token, { db }).ok, false);
  assert.equal(verifyApiToken(second.token, { db }).ok, true);
});
