import assert from "node:assert/strict";
import test, { before, after, beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const {
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  readAuthThrottle,
  resetAuthThrottle,
} = await jiti.import("./auth-throttle-store.ts");
const { AUTH_THROTTLE_RESET_AFTER_MS } = await jiti.import("./auth-throttle.ts");

let db;

before(() => { db = openDatabase(":memory:"); installDatabaseForTests(db); });
after(() => { installDatabaseForTests(null); db?.close(); });
beforeEach(() => { resetAuthThrottle(null, db); });

test("counters survive a restart because they are rows, not process state", () => {
  recordAuthFailure("login", db, 0);
  recordAuthFailure("login", db, 1_000);
  // A "restart" is just a new read: nothing is cached in this module.
  assert.equal(getAuthRetryAfterMs("login", db, 1_500), 1_500);
  assert.equal(readAuthThrottle("login", db, 1_500).failures, 2);
});

test("scopes are independent", () => {
  recordAuthFailure("init", db, 0);
  assert.equal(getAuthRetryAfterMs("login", db, 0), 0);
  assert.equal(getAuthRetryAfterMs("init", db, 0), 1_000);
});

test("a success clears the block and the failure count", () => {
  recordAuthFailure("login", db, 0);
  recordAuthFailure("login", db, 1_000);
  recordAuthSuccess("login", db);
  assert.equal(getAuthRetryAfterMs("login", db, 1_001), 0);
  assert.equal(recordAuthFailure("login", db, 1_001), 1_000);
});

test("an idle counter resets after the documented window", () => {
  recordAuthFailure("login", db, 0);
  recordAuthFailure("login", db, 1_000);
  const later = 1_000 + AUTH_THROTTLE_RESET_AFTER_MS;
  assert.equal(getAuthRetryAfterMs("login", db, later), 0);
  assert.equal(readAuthThrottle("login", db, later).failures, 0);
});

test("reset clears every scope", () => {
  recordAuthFailure("login", db, 0);
  recordAuthFailure("totp", db, 0);
  resetAuthThrottle(null, db);
  assert.equal(getAuthRetryAfterMs("login", db, 0), 0);
  assert.equal(getAuthRetryAfterMs("totp", db, 0), 0);
});
