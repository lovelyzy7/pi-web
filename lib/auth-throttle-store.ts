import { getDatabase, type PiWebDatabase } from "./db";
import {
  createAuthThrottleState,
  expireIfStale,
  nextFailureState,
  remainingBlockMs,
  type AuthThrottleState,
} from "./auth-throttle";
/**
 * Persistent authentication throttling.
 *
 * Counters used to live on `globalThis`, which meant a restart cleared a running
 * lockout. They now live in `auth_throttle`, keyed by scope, so login, /init, and
 * (later) TOTP attempts each carry their own backoff while sharing the same
 * curve from `lib/auth-throttle.ts`.
 *
 * When no database can be opened — the environment-password mode still has to
 * work on a machine where the agent directory is not writable — the counters
 * fall back to process memory. Throttling is defense in depth; refusing to boot
 * over it would trade a real availability bug for a hypothetical one.
 */

export type AuthThrottleScope = "login" | "init" | "totp";

interface ThrottleRow {
  scope: string;
  failures: number;
  last_failure_at: number;
  blocked_until: number;
}

declare global {
  var __piWebThrottleFallback: Map<string, AuthThrottleState> | undefined;
  var __piWebThrottleFallbackWarned: boolean | undefined;
}

function fallbackStore(): Map<string, AuthThrottleState> {
  return globalThis.__piWebThrottleFallback ??= new Map();
}

function toState(row: ThrottleRow | undefined): AuthThrottleState {
  if (!row) return createAuthThrottleState();
  return {
    failures: row.failures,
    lastFailureAt: row.last_failure_at,
    blockedUntil: row.blocked_until,
  };
}

function warnFallbackOnce(error: unknown): void {
  if (globalThis.__piWebThrottleFallbackWarned) return;
  globalThis.__piWebThrottleFallbackWarned = true;
  console.warn(
    "[pi-web] Authentication throttling fell back to process memory: "
    + (error instanceof Error ? error.message : String(error)),
  );
}

/** `null` means "use process memory" and is decided once per call. */
function resolveDatabase(db: PiWebDatabase | undefined): PiWebDatabase | null {
  if (db) return db;
  try {
    return getDatabase();
  } catch (error) {
    warnFallbackOnce(error);
    return null;
  }
}

/**
 * Runs `action` against the database, falling back to process memory when the
 * database is missing *or* the query fails. Throttling is defense in depth; a
 * broken counter must not take authentication down with it.
 */
function withDatabase<T>(
  db: PiWebDatabase | undefined,
  action: (database: PiWebDatabase) => T,
  inMemory: () => T,
): T {
  const resolved = resolveDatabase(db);
  if (!resolved) return inMemory();
  try {
    return action(resolved);
  } catch (error) {
    warnFallbackOnce(error);
    return inMemory();
  }
}

function readState(
  scope: AuthThrottleScope,
  db: PiWebDatabase | null,
): AuthThrottleState {
  if (!db) return fallbackStore().get(scope) ?? createAuthThrottleState();
  const row = db.prepare("SELECT * FROM auth_throttle WHERE scope = ?").get(scope) as
    | ThrottleRow
    | undefined;
  return toState(row);
}

function writeState(scope: AuthThrottleScope, state: AuthThrottleState, db: PiWebDatabase | null): void {
  if (!db) {
    fallbackStore().set(scope, state);
    return;
  }
  db.prepare(`
    INSERT INTO auth_throttle (scope, failures, last_failure_at, blocked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      failures = excluded.failures,
      last_failure_at = excluded.last_failure_at,
      blocked_until = excluded.blocked_until
  `).run(scope, state.failures, state.lastFailureAt, state.blockedUntil);
}

export function getAuthRetryAfterMs(
  scope: AuthThrottleScope = "login",
  db?: PiWebDatabase,
  now: number = Date.now(),
): number {
  return withDatabase(
    db,
    (database) => remainingBlockMs(readState(scope, database), now),
    () => remainingBlockMs(readState(scope, null), now),
  );
}

/** Records a failed attempt and returns the delay now imposed on the next one. */
export function recordAuthFailure(
  scope: AuthThrottleScope = "login",
  db?: PiWebDatabase,
  now: number = Date.now(),
): number {
  const record = (database: PiWebDatabase | null) => {
    const state = nextFailureState(readState(scope, database), now);
    writeState(scope, state, database);
    return state.blockedUntil - now;
  };
  return withDatabase(db, (database) => record(database), () => record(null));
}

export function recordAuthSuccess(
  scope: AuthThrottleScope = "login",
  db?: PiWebDatabase,
): void {
  const clear = (database: PiWebDatabase | null) =>
    writeState(scope, createAuthThrottleState(), database);
  withDatabase(db, (database) => clear(database), () => clear(null));
}

/** Reads a counter for display without advancing it. */
export function readAuthThrottle(
  scope: AuthThrottleScope = "login",
  db?: PiWebDatabase,
  now: number = Date.now(),
): AuthThrottleState & { retryAfterMs: number } {
  const state = expireIfStale(
    withDatabase(db, (database) => readState(scope, database), () => readState(scope, null)),
    now,
  );
  return { ...state, retryAfterMs: Math.max(0, state.blockedUntil - now) };
}

/** Clears one scope, or every scope when called without arguments (tests). */
export function resetAuthThrottle(
  scope: AuthThrottleScope | null = null,
  db?: PiWebDatabase,
): void {
  fallbackStore().clear();
  const resolved = resolveDatabase(db);
  if (!resolved) return;
  if (scope) {
    resolved.prepare("DELETE FROM auth_throttle WHERE scope = ?").run(scope);
    return;
  }
  resolved.prepare("DELETE FROM auth_throttle").run();
}
