import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for the single Pi Web account.
 *
 * scrypt is in Node itself, so no native dependency is added for the one thing
 * that must not be hand-rolled. It is deliberately slow: verification happens
 * only on login, password change, and initialization — never on an ordinary
 * request, which is why the proxy authenticates random session tokens instead
 * (see docs/adr/0006-pi-web-database.md).
 */

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

export const SCRYPT_PARAMETERS: ScryptParameters = {
  N: 32_768,
  r: 8,
  p: 1,
  // 128 * N * r is ~33.5 MB; Node's 32 MB default would reject the default cost.
  maxmem: 64 * 1024 * 1024,
};

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = "scrypt";

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function decodeBase64Url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    // Re-encoding must round-trip, or the value was not canonical base64url.
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function formatParameters(parameters: ScryptParameters): string {
  return `N=${parameters.N},r=${parameters.r},p=${parameters.p}`;
}

/** Parse `scrypt$N=..,r=..,p=..$salt$hash`; returns null for anything else. */
export function parsePasswordHash(stored: string | null | undefined): {
  parameters: Pick<ScryptParameters, "N" | "r" | "p">;
  salt: Buffer;
  hash: Buffer;
} | null {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;

  const match = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1]);
  if (!match) return null;
  const parameters = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!Number.isSafeInteger(parameters.N) || parameters.N < 1024
    || !Number.isSafeInteger(parameters.r) || parameters.r < 1
    || !Number.isSafeInteger(parameters.p) || parameters.p < 1) {
    return null;
  }

  const salt = decodeBase64Url(parts[2]);
  const hash = decodeBase64Url(parts[3]);
  if (!salt || !hash || hash.length === 0) return null;

  return { parameters, salt, hash };
}

export async function hashPassword(
  password: string,
  parameters: ScryptParameters = SCRYPT_PARAMETERS,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: parameters.maxmem,
    }, (error, key) => (error ? reject(error) : resolve(key as Buffer)));
  });
  return `${PREFIX}$${formatParameters(parameters)}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`;
}

function matches(derived: Buffer, expected: Buffer): boolean {
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export async function verifyPasswordHash(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;

  try {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, parsed.salt, parsed.hash.length, {
        N: parsed.parameters.N,
        r: parsed.parameters.r,
        p: parsed.parameters.p,
        maxmem: SCRYPT_PARAMETERS.maxmem,
      }, (error, key) => (error ? reject(error) : resolve(key as Buffer)));
    });
    return matches(derived, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * Blocking twin used by the proxy, which is synchronous. Only reached for
 * HTTP Basic credentials, and a successful verification is cached there for
 * minutes, so the event loop pays this once per client rather than per request.
 */
export function verifyPasswordHashSync(
  password: string,
  stored: string | null | undefined,
): boolean {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;

  try {
    const derived = scryptSync(password, parsed.salt, parsed.hash.length, {
      N: parsed.parameters.N,
      r: parsed.parameters.r,
      p: parsed.parameters.p,
      maxmem: SCRYPT_PARAMETERS.maxmem,
    });
    return matches(derived, parsed.hash);
  } catch {
    return false;
  }
}
