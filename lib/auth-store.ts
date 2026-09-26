import { createHash, randomBytes } from "node:crypto";
import { getDatabase, type PiWebDatabase } from "./db";
import { hashPassword, verifyPasswordHash } from "./password-hash";

/**
 * Account, login-session, and audit persistence.
 *
 * Everything here is synchronous except password hashing, and that split is the
 * point: the request-time path looks a random token up by primary key, while
 * scrypt runs only when a password is actually checked.
 */

/** The single account name. HTTP Basic compatibility depends on this spelling. */
export const PI_WEB_ACCOUNT_USERNAME = "pi";

export const SESSION_TOKEN_PREFIX = "pws_";
/** Sliding idle lifetime: a session unused for this long is over. */
export const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Hard cap that no amount of activity extends. */
export const DEFAULT_SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** A busy tab must not rewrite `last_seen_at` on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type AuthMethod =
  | "password"
  | "totp"
  | "recovery_code"
  | "basic"
  | "api_token";

export interface AccountRecord {
  username: string;
  displayName: string;
  passwordHash: string | null;
  passwordChangedAt: number | null;
  totpEnabled: boolean;
  totpLastStep: number | null;
  sessionEpoch: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export interface WebSessionRecord {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  idleTtlMs: number;
  revokedAt: number | null;
  revokedReason: string | null;
  authMethod: string;
  epoch: number;
  ip: string | null;
  userAgent: string | null;
}

export type SessionValidationReason =
  | "ok"
  | "unknown"
  | "revoked"
  | "expired"
  | "epoch"
  | "not-configured";

export interface SessionValidation {
  ok: boolean;
  reason: SessionValidationReason;
  session?: WebSessionRecord;
}

export type AuthEventKind =
  | "setup"
  | "login"
  | "logout"
  | "password"
  | "totp"
  | "token"
  | "throttle";

export interface AuthEventInput {
  kind: AuthEventKind;
  result: "ok" | "fail" | "blocked";
  username?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: unknown;
}

export interface AuthEventRecord {
  id: number;
  ts: number;
  kind: string;
  result: string;
  username: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

export interface WebSessionSummary extends WebSessionRecord {
  current: boolean;
}

interface AccountRow {
  username: string;
  display_name: string;
  password_hash: string | null;
  password_changed_at: number | null;
  totp_enabled: number;
  totp_last_step: number | null;
  session_epoch: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

interface SessionRow {
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  absolute_expires_at: number;
  idle_ttl_ms: number;
  revoked_at: number | null;
  revoked_reason: string | null;
  auth_method: string;
  epoch: number;
  ip: string | null;
  user_agent: string | null;
}

function toAccount(row: AccountRow): AccountRecord {
  return {
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    passwordChangedAt: row.password_changed_at,
    totpEnabled: row.totp_enabled === 1,
    totpLastStep: row.totp_last_step,
    sessionEpoch: row.session_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function toSession(row: SessionRow): WebSessionRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleTtlMs: row.idle_ttl_ms,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    authMethod: row.auth_method,
    epoch: row.epoch,
    ip: row.ip,
    userAgent: row.user_agent,
  };
}

export function sessionIdForToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function idleSessionTtlMs(environment: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(environment.PI_WEB_SESSION_TTL_MS);
  if (Number.isSafeInteger(configured) && configured > 0) return configured;
  return DEFAULT_SESSION_IDLE_TTL_MS;
}

/** True once an account with a password exists — the switch between /init and /login. */
export function isAccountConfigured(db: PiWebDatabase = getDatabase()): boolean {
  const row = db.prepare("SELECT password_hash FROM account WHERE id = 1")
    .get() as { password_hash: string | null } | undefined;
  return Boolean(row?.password_hash);
}

export function readAccount(db: PiWebDatabase = getDatabase()): AccountRecord | null {
  const row = db.prepare("SELECT * FROM account WHERE id = 1").get() as AccountRow | undefined;
  return row ? toAccount(row) : null;
}

export async function createAccount(
  password: string,
  options: { username?: string; displayName?: string; now?: number; db?: PiWebDatabase } = {},
): Promise<void> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const username = options.username ?? PI_WEB_ACCOUNT_USERNAME;
  const passwordHash = await hashPassword(password);

  db.prepare(`
    INSERT INTO account (id, username, display_name, password_hash, password_changed_at,
                         session_epoch, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      password_hash = excluded.password_hash,
      password_changed_at = excluded.password_changed_at,
      session_epoch = account.session_epoch + 1,
      updated_at = excluded.updated_at
  `).run(username, options.displayName ?? "", passwordHash, now, now, now);
}

export async function verifyAccountPassword(
  password: string,
  db: PiWebDatabase = getDatabase(),
): Promise<boolean> {
  const account = readAccount(db);
  if (!account?.passwordHash) return false;
  return verifyPasswordHash(password, account.passwordHash);
}

export interface ChangePasswordResult {
  ok: boolean;
  reason?: "not-configured" | "invalid-password" | "same-password";
}

/**
 * Replaces the password and bumps `session_epoch`, which invalidates every
 * existing cookie — including the caller's. The route issues a fresh session
 * afterwards so the browser that made the change stays signed in while every
 * other device is signed out.
 */
export async function changeAccountPassword(
  currentPassword: string,
  newPassword: string,
  db: PiWebDatabase = getDatabase(),
): Promise<ChangePasswordResult> {
  const account = readAccount(db);
  if (!account?.passwordHash) return { ok: false, reason: "not-configured" };
  if (!await verifyPasswordHash(currentPassword, account.passwordHash)) {
    return { ok: false, reason: "invalid-password" };
  }
  if (await verifyPasswordHash(newPassword, account.passwordHash)) {
    return { ok: false, reason: "same-password" };
  }

  const now = Date.now();
  const passwordHash = await hashPassword(newPassword);
  db.prepare(`
    UPDATE account
    SET password_hash = ?, password_changed_at = ?, updated_at = ?,
        session_epoch = session_epoch + 1
    WHERE id = 1
  `).run(passwordHash, now, now);
  return { ok: true };
}

export function recordLogin(db: PiWebDatabase = getDatabase(), now: number = Date.now()): void {
  db.prepare("UPDATE account SET last_login_at = ?, updated_at = ? WHERE id = 1").run(now, now);
}

export interface CreateSessionOptions {
  authMethod?: AuthMethod;
  ip?: string | null;
  userAgent?: string | null;
  now?: number;
  idleTtlMs?: number;
  absoluteTtlMs?: number;
  db?: PiWebDatabase;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: number;
  absoluteExpiresAt: number;
}

export function createWebSession(options: CreateSessionOptions = {}): CreatedSession {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const account = readAccount(db);
  const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const sessionId = sessionIdForToken(token);
  const idleTtlMs = options.idleTtlMs ?? idleSessionTtlMs();
  const absoluteTtlMs = options.absoluteTtlMs ?? DEFAULT_SESSION_ABSOLUTE_TTL_MS;
  const expiresAt = now + idleTtlMs;
  const absoluteExpiresAt = now + absoluteTtlMs;

  db.prepare(`
    INSERT INTO web_sessions (id, created_at, last_seen_at, expires_at, absolute_expires_at,
                              idle_ttl_ms, auth_method, epoch, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    now,
    now,
    expiresAt,
    absoluteExpiresAt,
    idleTtlMs,
    options.authMethod ?? "password",
    account?.sessionEpoch ?? 1,
    options.ip ?? null,
    options.userAgent ?? null,
  );

  return { token, sessionId, expiresAt, absoluteExpiresAt };
}

interface SessionValidationRow extends SessionRow {
  account_epoch: number | null;
}

export function validateWebSession(
  token: string | undefined | null,
  options: { now?: number; touch?: boolean; db?: PiWebDatabase } = {},
): SessionValidation {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  if (!token || !token.startsWith(SESSION_TOKEN_PREFIX)) return { ok: false, reason: "unknown" };

  const row = db.prepare(`
    SELECT s.*, (SELECT session_epoch FROM account WHERE id = 1) AS account_epoch
    FROM web_sessions s WHERE s.id = ?
  `).get(sessionIdForToken(token)) as SessionValidationRow | undefined;

  if (!row) return { ok: false, reason: "unknown" };
  const session = toSession(row);
  if (row.account_epoch === null) return { ok: false, reason: "not-configured" };
  if (session.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (session.epoch !== row.account_epoch) return { ok: false, reason: "epoch" };
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) {
    return { ok: false, reason: "expired", session };
  }

  if (options.touch !== false && now - session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
    const idleTtlMs = session.idleTtlMs > 0 ? session.idleTtlMs : idleSessionTtlMs();
    const expiresAt = Math.min(now + idleTtlMs, session.absoluteExpiresAt);
    db.prepare("UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?")
      .run(now, expiresAt, session.id);
    session.lastSeenAt = now;
    session.expiresAt = expiresAt;
  }

  return { ok: true, reason: "ok", session };
}

export function revokeWebSession(
  sessionId: string,
  reason = "revoked",
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): void {
  db.prepare("UPDATE web_sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL")
    .run(now, reason, sessionId);
}

/**
 * Signs every device out. Bumping the epoch also covers sessions this process
 * has not seen yet; the `revoked_at` update keeps the device list honest.
 */
export function revokeAllWebSessions(
  reason = "revoked-all",
  options: { keepSessionId?: string | null; db?: PiWebDatabase; now?: number } = {},
): number {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const keep = options.keepSessionId ?? null;

  return db.transaction(() => {
    db.prepare("UPDATE account SET session_epoch = session_epoch + 1, updated_at = ? WHERE id = 1")
      .run(now);
    const nextEpoch = Number(
      (db.prepare("SELECT session_epoch AS epoch FROM account WHERE id = 1").get() as { epoch: number } | undefined)?.epoch ?? 1,
    );

    const revoked = keep
      ? db.prepare(`
          UPDATE web_sessions SET revoked_at = ?, revoked_reason = ?
          WHERE revoked_at IS NULL AND id != ?
        `).run(now, reason, keep)
      : db.prepare(`
          UPDATE web_sessions SET revoked_at = ?, revoked_reason = ? WHERE revoked_at IS NULL
        `).run(now, reason);

    // The caller's own session is kept, but it must carry the new epoch or the
    // next request would reject it as stale.
    if (keep) db.prepare("UPDATE web_sessions SET epoch = ? WHERE id = ?").run(nextEpoch, keep);

    return revoked.changes;
  })();
}

export function listWebSessions(
  options: {
    currentSessionId?: string | null;
    db?: PiWebDatabase;
    includeInactive?: boolean;
    now?: number;
  } = {},
): WebSessionSummary[] {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const rows = db.prepare("SELECT * FROM web_sessions ORDER BY last_seen_at DESC").all() as SessionRow[];
  return rows
    .filter((row) => options.includeInactive
      || (row.revoked_at === null && row.absolute_expires_at > now && row.expires_at > now))
    .map((row) => ({ ...toSession(row), current: row.id === options.currentSessionId }));
}

export function pruneWebSessions(
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): number {
  const result = db.prepare(`
    DELETE FROM web_sessions
    WHERE absolute_expires_at < ?
       OR (revoked_at IS NOT NULL AND revoked_at < ?)
  `).run(now, now - DEFAULT_SESSION_IDLE_TTL_MS);
  return result.changes;
}

export function recordAuthEvent(
  event: AuthEventInput,
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): void {
  db.prepare(`
    INSERT INTO auth_events (ts, kind, result, username, ip, user_agent, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    now,
    event.kind,
    event.result,
    event.username ?? null,
    event.ip ?? null,
    event.userAgent ?? null,
    event.detail === undefined ? null : JSON.stringify(event.detail),
  );
}

export function listAuthEvents(
  options: { limit?: number; offset?: number; kind?: string } = {},
  db: PiWebDatabase = getDatabase(),
): AuthEventRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = options.kind
    ? db.prepare(`
        SELECT * FROM auth_events WHERE kind = ? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?
      `).all(options.kind, limit, offset)
    : db.prepare("SELECT * FROM auth_events ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset);

  return (rows as Array<{
    id: number; ts: number; kind: string; result: string;
    username: string | null; ip: string | null; user_agent: string | null; detail: string | null;
  }>).map((row) => ({
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    result: row.result,
    username: row.username,
    ip: row.ip,
    userAgent: row.user_agent,
    detail: row.detail,
  }));
}

/** Keeps the audit log bounded without dropping the recent history. */
export function pruneAuthEvents(
  db: PiWebDatabase = getDatabase(),
  maxRows = 5_000,
): number {
  const result = db.prepare(`
    DELETE FROM auth_events
    WHERE id <= (SELECT MAX(id) FROM auth_events) - ?
  `).run(maxRows);
  return result.changes;
}

export interface TotpState {
  enabled: boolean;
  /** A secret exists but has not been confirmed with a code yet. */
  pending: boolean;
  confirmedAt: number | null;
  lastStep: number | null;
}

export function readTotpState(db: PiWebDatabase = getDatabase()): TotpState {
  const row = db.prepare(
    "SELECT totp_enabled, totp_secret_enc, totp_confirmed_at, totp_last_step FROM account WHERE id = 1",
  ).get() as {
    totp_enabled: number;
    totp_secret_enc: string | null;
    totp_confirmed_at: number | null;
    totp_last_step: number | null;
  } | undefined;

  if (!row) return { enabled: false, pending: false, confirmedAt: null, lastStep: null };
  return {
    enabled: row.totp_enabled === 1 && row.totp_secret_enc !== null,
    pending: row.totp_enabled !== 1 && row.totp_secret_enc !== null,
    confirmedAt: row.totp_confirmed_at,
    lastStep: row.totp_last_step,
  };
}

/** Stores the sealed (encrypted) seed while enrollment is still unconfirmed. */
export function setPendingTotpSecret(sealedSecret: string, db: PiWebDatabase = getDatabase()): void {
  db.prepare(`
    UPDATE account
    SET totp_secret_enc = ?, totp_enabled = 0, totp_confirmed_at = NULL, totp_last_step = NULL,
        updated_at = ?
    WHERE id = 1
  `).run(sealedSecret, Date.now());
}

export function readSealedTotpSecret(db: PiWebDatabase = getDatabase()): string | null {
  const row = db.prepare("SELECT totp_secret_enc FROM account WHERE id = 1").get() as
    | { totp_secret_enc: string | null }
    | undefined;
  return row?.totp_secret_enc ?? null;
}

export function enableTotp(db: PiWebDatabase = getDatabase(), now: number = Date.now()): void {
  db.prepare(
    "UPDATE account SET totp_enabled = 1, totp_confirmed_at = ?, updated_at = ? WHERE id = 1",
  ).run(now, now);
}

/** Clears the seed, the replay guard, and every recovery code. */
export function disableTotp(db: PiWebDatabase = getDatabase(), now: number = Date.now()): void {
  db.transaction(() => {
    db.prepare(`
      UPDATE account
      SET totp_secret_enc = NULL, totp_enabled = 0, totp_confirmed_at = NULL,
          totp_last_step = NULL, updated_at = ?
      WHERE id = 1
    `).run(now);
    db.prepare("DELETE FROM recovery_codes").run();
  })();
}

/** Records the accepted step so the same code cannot be replayed. */
export function setTotpLastStep(step: number, db: PiWebDatabase = getDatabase()): void {
  db.prepare("UPDATE account SET totp_last_step = ? WHERE id = 1").run(step);
}

export function replaceRecoveryCodes(
  codeHashes: readonly string[],
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): void {
  db.transaction(() => {
    db.prepare("DELETE FROM recovery_codes").run();
    const insert = db.prepare("INSERT INTO recovery_codes (code_hash, created_at) VALUES (?, ?)");
    for (const hash of codeHashes) insert.run(hash, now);
  })();
}

/** Consumes a recovery code; returns the number of codes left unused. */
export function consumeRecoveryCode(
  codeHash: string,
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): { ok: boolean; remaining: number } {
  return db.transaction(() => {
    const updated = db.prepare(
      "UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
    ).run(now, codeHash);
    const remaining = (db.prepare(
      "SELECT COUNT(*) AS count FROM recovery_codes WHERE used_at IS NULL",
    ).get() as { count: number }).count;
    return { ok: updated.changes > 0, remaining };
  })();
}

export function countUnusedRecoveryCodes(db: PiWebDatabase = getDatabase()): number {
  return (db.prepare(
    "SELECT COUNT(*) AS count FROM recovery_codes WHERE used_at IS NULL",
  ).get() as { count: number }).count;
}

/** Reads a stored preference, or `undefined` when absent or unreadable. */
export function readAppSetting(key: string, db: PiWebDatabase = getDatabase()): unknown {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

export function writeAppSetting(key: string, value: unknown, db: PiWebDatabase = getDatabase()): void {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value ?? null), Date.now());
}
