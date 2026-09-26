import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isAccountConfigured, readAccount } from "./auth-store";
import { getDatabase, type PiWebDatabase } from "./db";

/**
 * Short-lived proof that the password step succeeded.
 *
 * Enabling a second factor must not mean holding the password in the browser
 * between the two steps, and it must not mean creating a session before the code
 * is verified. The challenge is a signed, expiring value instead: its HMAC key
 * is the stored password hash, so changing the password or bumping the session
 * epoch invalidates every outstanding challenge without extra state.
 */

export const AUTH_CHALLENGE_PREFIX = "pi_chal_";
export const AUTH_CHALLENGE_TTL_MS = 5 * 60_000;

function challengeKey(db: PiWebDatabase): string | null {
  const account = readAccount(db);
  if (!account?.passwordHash || !isAccountConfigured(db)) return null;
  return `${account.passwordHash}:${account.sessionEpoch}`;
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(`pi-web-totp-challenge:${payload}`, "utf8").digest("base64url");
}

export function createAuthChallenge(
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): string | null {
  const key = challengeKey(db);
  if (!key) return null;
  const payload = `v1.${Math.floor(now / 1000) + Math.floor(AUTH_CHALLENGE_TTL_MS / 1000)}.${randomBytes(16).toString("base64url")}`;
  return `${AUTH_CHALLENGE_PREFIX}${payload}.${sign(payload, key)}`;
}

export function verifyAuthChallenge(
  token: unknown,
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): boolean {
  if (typeof token !== "string" || !token.startsWith(AUTH_CHALLENGE_PREFIX)) return false;
  const key = challengeKey(db);
  if (!key) return false;

  const remainder = token.slice(AUTH_CHALLENGE_PREFIX.length);
  const separator = remainder.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = remainder.slice(0, separator);
  const signature = remainder.slice(separator + 1);

  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(now / 1000)) return false;

  const actual = Buffer.from(signature, "utf8");
  const expected = Buffer.from(sign(payload, key), "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
