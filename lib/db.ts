import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DATABASE_MIGRATIONS, LATEST_DATABASE_VERSION } from "./db-schema";

export type PiWebDatabase = Database.Database;

declare global {
  // Kept on globalThis because Next.js hot reload re-evaluates modules, and a
  // second connection would fight the first over the WAL lock during development.
  var __piWebDatabase: PiWebDatabase | undefined;
}

const BUSY_TIMEOUT_MS = 5_000;

/**
 * `~/.pi/agent/pi-web/pi-web.db`, or the same place under
 * `PI_CODING_AGENT_DIR`. Inside the agent directory on purpose: everything Pi
 * Web needs to survive a container rebuild lives under one mounted volume.
 */
export function getDefaultDatabasePath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-web", "pi-web.db");
}

function applyPragmas(db: PiWebDatabase): void {
  // WAL lets the proxy's read connection and a route handler's write overlap
  // without "database is locked"; the busy timeout covers the rest.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

export function migrateDatabase(db: PiWebDatabase): number {
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (current > LATEST_DATABASE_VERSION) {
    throw new Error(
      `Pi Web database schema version ${current} is newer than this build supports (${LATEST_DATABASE_VERSION}). `
      + "Upgrade Pi Web or restore a backup.",
    );
  }

  for (const migration of DATABASE_MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }

  return Number(db.pragma("user_version", { simple: true }) ?? 0);
}

/** Opens (creating if needed) a Pi Web database at an explicit path. */
export function openDatabase(filePath: string): PiWebDatabase {
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    applyPragmas(db);
    migrateDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** The process-wide connection, opened on first use. */
export function getDatabase(): PiWebDatabase {
  if (!globalThis.__piWebDatabase) {
    globalThis.__piWebDatabase = openDatabase(getDefaultDatabasePath());
  }
  return globalThis.__piWebDatabase;
}

/**
 * Points the process-wide connection at another file (tests only). Passing
 * `null` closes the current connection and forgets it.
 */
export function setDatabaseForTests(filePath: string | null): PiWebDatabase | null {
  if (globalThis.__piWebDatabase) {
    globalThis.__piWebDatabase.close();
    globalThis.__piWebDatabase = undefined;
  }
  if (filePath === null) return null;
  return getDatabase();
}

/** Overrides the process-wide connection with an already-open database. */
export function installDatabaseForTests(db: PiWebDatabase | null): void {
  if (globalThis.__piWebDatabase && globalThis.__piWebDatabase !== db) {
    globalThis.__piWebDatabase.close();
  }
  globalThis.__piWebDatabase = db ?? undefined;
}
