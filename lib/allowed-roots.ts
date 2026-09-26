import { existsSync } from "node:fs";
import { getDatabase, getDefaultDatabasePath } from "./db";
import { toSlashPath } from "./paths";

// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

/**
 * Allowed roots are internal bookkeeping keys that are never displayed, so they
 * are stored slash-normalized for consistent Set membership. Correctness does
 * not depend on it — isPathWithinRoots() re-normalizes whatever it is given.
 */
export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

declare global {
  var __piAdditionalAllowedRootsLoaded: boolean | undefined;
}

/**
 * Reads the persisted roots once per process. Lazy on purpose: importing this
 * module must not open the database (the file-access helpers are used by tests
 * and by routes that never touch it).
 */
function withExistingDatabase<T>(action: (db: ReturnType<typeof getDatabase>) => T): T | null {
  // Never *create* the database here: this module is reached by the file-access
  // path, which read-only routes and tests use without wanting a database. In
  // production the proxy has already opened it on the first request.
  const db = globalThis.__piWebDatabase
    ?? (existsSync(getDefaultDatabasePath()) ? getDatabase() : null);
  if (!db) return null;
  return action(db);
}

function loadPersistedRoots(): void {
  if (globalThis.__piAdditionalAllowedRootsLoaded) return;
  globalThis.__piAdditionalAllowedRootsLoaded = true;
  try {
    const rows = withExistingDatabase((db) =>
      db.prepare("SELECT path FROM allowed_roots").all() as { path: string }[]) ?? [];
    if (rows.length === 0) return;
    const roots = getAdditionalAllowedRoots();
    for (const row of rows) roots.add(row.path);
  } catch {
    // No database (or an unreadable one): the in-memory set still works.
  }
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = new Set();
  }
  loadPersistedRoots();
  return globalThis.__piAdditionalAllowedRoots;
}

/**
 * Approves a root for the file browser and the theme sources. The database write
 * is best-effort: the in-memory set is what this process needs, and losing the
 * row only means the operator approves it again after a restart.
 */
export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
  try {
    withExistingDatabase((db) => {
      db.prepare("INSERT OR IGNORE INTO allowed_roots (path, created_at) VALUES (?, ?)")
        .run(normalizedRoot, Date.now());
    });
  } catch {
    // Best-effort persistence.
  }
}
