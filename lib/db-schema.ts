/**
 * SQLite schema for Pi Web's own data.
 *
 * Pi owns the files under the agent directory — session transcripts, model
 * configuration, provider credentials, project trust — and other runtimes (the
 * pi CLI and TUI) read and rewrite them. Those stay files. This database holds
 * only state that belongs to Pi Web itself: the account, login sessions, audit
 * events, throttling counters, and the caches behind the panels. See
 * docs/adr/0006-pi-web-database.md.
 */

export interface DatabaseMigration {
  version: number;
  statements: readonly string[];
}

/**
 * Migrations run in order and each one is applied inside a transaction, so a
 * failure leaves `user_version` at the last completed step. Never edit a
 * released migration: append a new one.
 */
export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    statements: [
      // The single account. `id = 1` is a constraint, not a convention: Pi Web
      // serves one operator, and a second row would be unreachable state.
      `CREATE TABLE account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT,
        password_changed_at INTEGER,
        totp_secret_enc TEXT,
        totp_enabled INTEGER NOT NULL DEFAULT 0,
        totp_confirmed_at INTEGER,
        session_epoch INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_login_at INTEGER
      )`,

      // A row exists for every issued cookie. `id` is the SHA-256 of the token,
      // so a database leak cannot be replayed as a login. `epoch` is compared
      // against the account's `session_epoch`; bumping that column revokes every
      // session at once without touching rows.
      `CREATE TABLE web_sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        idle_ttl_ms INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER,
        revoked_reason TEXT,
        auth_method TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      )`,
      `CREATE INDEX web_sessions_expires ON web_sessions(expires_at)`,

      // Append-only security log surfaced in the account page.
      `CREATE TABLE auth_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        result TEXT NOT NULL,
        username TEXT,
        ip TEXT,
        user_agent TEXT,
        detail TEXT
      )`,
      `CREATE INDEX auth_events_ts ON auth_events(ts DESC)`,

      // One row per scope ("login", "init", "totp"). Persisted so a restart
      // cannot clear a running lockout.
      `CREATE TABLE auth_throttle (
        scope TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        last_failure_at INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0
      )`,

      // Server-side preferences that must not live in a browser profile.
      `CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,

      // Roots added through /api/cwd/validate and friends. Previously in-memory,
      // which silently dropped an operator-approved root on every restart.
      `CREATE TABLE allowed_roots (
        path TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,

      `CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER,
        revoked_at INTEGER,
        ip_last TEXT
      )`,

      `CREATE TABLE update_checks (
        subject TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        checked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,

      `CREATE TABLE market_cache (
        source TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        etag TEXT,
        payload TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (source, cache_key)
      )`,

      // Long-running installs and update passes. The log is split into rows so
      // an SSE client can replay from a sequence number.
      `CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        exit_code INTEGER
      )`,
      `CREATE TABLE job_logs (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (job_id, seq)
      )`,

      // Web push keys and subscriptions, moved off ~/.pi/agent/web-push.json.
      `CREATE TABLE push_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        vapid_public TEXT NOT NULL,
        vapid_private TEXT NOT NULL,
        subscriptions TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      // Replay guard for TOTP: the last time step that produced an accepted
      // code, so a code observed once cannot be used again inside its window.
      `ALTER TABLE account ADD COLUMN totp_last_step INTEGER`,

      // Recovery codes for the second factor. Only hashes are stored; the
      // plaintext is shown once at enrollment.
      `CREATE TABLE recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      )`,
    ],
  },
];

export const LATEST_DATABASE_VERSION = DATABASE_MIGRATIONS.reduce(
  (latest, migration) => Math.max(latest, migration.version),
  0,
);
