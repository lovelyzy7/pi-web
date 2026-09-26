import { createHash, randomBytes } from "node:crypto";
import { getDatabase, type PiWebDatabase } from "./db";

/**
 * Bearer tokens for API clients.
 *
 * They exist because HTTP Basic cannot carry a second factor: once TOTP is
 * enabled, Basic is refused and a token is the way to drive the API. Only the
 * SHA-256 of a token is stored, the plaintext is shown once, and every token
 * carries a scope so a read-only integration cannot start agent runs.
 */

export const API_TOKEN_PREFIX = "pi_pat_";
export const API_TOKEN_SCOPES = ["read", "full"] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/** A busy client must not rewrite `last_used_at` on every request. */
export const API_TOKEN_TOUCH_INTERVAL_MS = 60_000;

export interface ApiTokenRecord {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiTokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

interface ApiTokenRow {
  id: number;
  name: string;
  prefix: string;
  token_hash: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

function parseScopes(raw: string): ApiTokenScope[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((scope): scope is ApiTokenScope =>
      typeof scope === "string" && (API_TOKEN_SCOPES as readonly string[]).includes(scope));
  } catch {
    return [];
  }
}

function toRecord(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function tokenHashFor(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function normalizeScopes(input: unknown): ApiTokenScope[] {
  if (!Array.isArray(input)) return ["full"];
  const scopes = input.filter((scope): scope is ApiTokenScope =>
    typeof scope === "string" && (API_TOKEN_SCOPES as readonly string[]).includes(scope));
  return scopes.length > 0 ? [...new Set(scopes)] : ["full"];
}

export interface CreateApiTokenOptions {
  name: string;
  scopes?: unknown;
  expiresAt?: number | null;
  db?: PiWebDatabase;
  now?: number;
}

export function createApiToken(options: CreateApiTokenOptions): { token: string; record: ApiTokenRecord } {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const token = `${API_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const prefix = token.slice(0, API_TOKEN_PREFIX.length + 8);
  const scopes = normalizeScopes(options.scopes);

  const result = db.prepare(`
    INSERT INTO api_tokens (name, prefix, token_hash, scopes, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(options.name, prefix, tokenHashFor(token), JSON.stringify(scopes), now, options.expiresAt ?? null);

  const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(result.lastInsertRowid) as ApiTokenRow;
  return { token, record: toRecord(row) };
}

export type ApiTokenValidation =
  | { ok: true; token: ApiTokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" };

export function verifyApiToken(
  token: string | null | undefined,
  options: { db?: PiWebDatabase; now?: number; touch?: boolean } = {},
): ApiTokenValidation {
  if (!token || !token.startsWith(API_TOKEN_PREFIX)) return { ok: false, reason: "unknown" };
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();

  const row = db.prepare("SELECT * FROM api_tokens WHERE token_hash = ?").get(tokenHashFor(token)) as
    | ApiTokenRow
    | undefined;
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
  if (row.expires_at !== null && row.expires_at <= now) return { ok: false, reason: "expired" };

  if (options.touch !== false && (row.last_used_at === null || now - row.last_used_at >= API_TOKEN_TOUCH_INTERVAL_MS)) {
    db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now, row.id);
    row.last_used_at = now;
  }

  return { ok: true, token: toRecord(row) };
}

export function listApiTokens(db: PiWebDatabase = getDatabase()): ApiTokenRecord[] {
  const rows = db.prepare("SELECT * FROM api_tokens ORDER BY created_at DESC").all() as ApiTokenRow[];
  return rows.map(toRecord);
}

export function revokeApiToken(
  id: number,
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): boolean {
  const result = db.prepare(
    "UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).run(now, id);
  return result.changes > 0;
}

/** Read-only tokens may only read; `full` may do anything the session may. */
export function apiTokenAllowsMethod(scopes: readonly ApiTokenScope[], method: string): boolean {
  const normalized = method.toUpperCase();
  if (normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS") return true;
  return scopes.includes("full");
}

export function pruneApiTokens(db: PiWebDatabase = getDatabase(), now: number = Date.now()): number {
  const result = db.prepare(`
    DELETE FROM api_tokens
    WHERE (expires_at IS NOT NULL AND expires_at < ?)
       OR (revoked_at IS NOT NULL AND revoked_at < ?)
  `).run(now, now - 90 * 24 * 60 * 60 * 1000);
  return result.changes;
}
