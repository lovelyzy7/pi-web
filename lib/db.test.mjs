import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { openDatabase, migrateDatabase, getDefaultDatabasePath, installDatabaseForTests } =
  await jiti.import("./db.ts");
const { DATABASE_MIGRATIONS, LATEST_DATABASE_VERSION } = await jiti.import("./db-schema.ts");

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-db-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  installDatabaseForTests(null);
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test("migrates a new database to the latest version and is idempotent", () => {
  const db = openDatabase(":memory:");
  try {
    assert.equal(Number(db.pragma("user_version", { simple: true })), LATEST_DATABASE_VERSION);
    assert.equal(migrateDatabase(db), LATEST_DATABASE_VERSION);
    assert.equal(migrateDatabase(db), LATEST_DATABASE_VERSION);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const expected of [
      "account", "allowed_roots", "api_tokens", "app_settings", "auth_events",
      "auth_throttle", "job_logs", "jobs", "market_cache", "push_state",
      "update_checks", "web_sessions",
    ]) {
      assert.ok(tables.includes(expected), `missing table ${expected}`);
    }
  } finally {
    db.close();
  }
});

test("refuses a database written by a newer build instead of corrupting it", () => {
  const db = openDatabase(":memory:");
  db.pragma(`user_version = ${LATEST_DATABASE_VERSION + 1}`);
  assert.throws(() => migrateDatabase(db), /newer than this build supports/);
  db.close();
});

test("applies WAL and foreign keys to file databases", () => {
  const file = join(temporaryDirectory(), "pi-web.db");
  const db = openDatabase(file);
  try {
    assert.equal(String(db.pragma("journal_mode", { simple: true })).toLowerCase(), "wal");
    assert.equal(Number(db.pragma("foreign_keys", { simple: true })), 1);
  } finally {
    db.close();
  }
});

test("the account table keeps exactly one row", () => {
  const db = openDatabase(":memory:");
  try {
    const insert = db.prepare(
      "INSERT INTO account (id, username, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    insert.run(1, "pi", 1, 1);
    assert.throws(() => insert.run(2, "other", 1, 1));
  } finally {
    db.close();
  }
});

test("migrating an already-current database changes nothing", () => {
  const db = openDatabase(":memory:");
  try {
    assert.equal(migrateDatabase(db), LATEST_DATABASE_VERSION);
  } finally {
    db.close();
  }
});

test("default path sits inside the agent directory", () => {
  assert.equal(getDefaultDatabasePath("/tmp/agent"), join("/tmp/agent", "pi-web", "pi-web.db"));
});

test("every migration declares a unique, increasing version", () => {
  const versions = DATABASE_MIGRATIONS.map((migration) => migration.version);
  assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b));
  assert.equal(Math.max(...versions), LATEST_DATABASE_VERSION);
});

test("refuses to open a path that exists as a directory", () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "note.txt"), "x");
  assert.throws(() => openDatabase(directory));
});
