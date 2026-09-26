import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) for the single Pi Web account.
 *
 * Hand-rolled on purpose: it is 40 lines over `node:crypto`'s HMAC, and the
 * alternative is another dependency guarding the one secret that must not be
 * wrong. The vectors in the test file come from RFC 6238 Appendix B.
 */

/** Authenticator apps default to 30 seconds and six digits. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** ±1 step tolerates a clock skew of half a minute without widening the window much. */
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(buffer: Buffer): string {
  let output = "";
  let bits = 0;
  let value = 0;
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(input: string): Buffer | null {
  const normalized = input.toUpperCase().replace(/[\s=-]/g, "");
  if (normalized.length === 0) return null;

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** New shared secret, base32 encoded the way authenticator apps expect it. */
export function generateTotpSecret(bytes: number = TOTP_SECRET_BYTES): string {
  return encodeBase32(randomBytes(bytes));
}

export function timeStepAt(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function generateTotp(secretBase32: string, counter: number): string | null {
  const secret = decodeBase32(secretBase32);
  if (!secret || secret.length === 0) return null;
  return hotp(secret, counter);
}

export interface TotpVerification {
  ok: boolean;
  /** The accepted time step; callers refuse to accept the same step twice. */
  step?: number;
}

/**
 * Verifies a code against the current step and its neighbours. `notBefore`
 * rejects a step that was already used, which is what stops a code read over a
 * shoulder from being replayed inside its own 30-second window.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { now?: number; window?: number; notBefore?: number | null } = {},
): TotpVerification {
  const normalized = code.replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return { ok: false };

  const step = timeStepAt(options.now);
  const window = options.window ?? TOTP_WINDOW_STEPS;
  for (let offset = -window; offset <= window; offset += 1) {
    const candidateStep = step + offset;
    if (options.notBefore != null && candidateStep <= options.notBefore) continue;
    const expected = generateTotp(secretBase32, candidateStep);
    if (!expected) return { ok: false };
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
      return { ok: true, step: candidateStep };
    }
  }
  return { ok: false };
}

/** `otpauth://` URI for authenticator apps and QR rendering. */
export function buildOtpAuthUri(
  secretBase32: string,
  accountName: string,
  issuer = "Pi Web",
): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery code; unambiguous alphabet, grouped for transcription. */
export function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(10);
  let raw = "";
  for (const byte of bytes) raw += alphabet[byte % alphabet.length];
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s]/g, "");
}
