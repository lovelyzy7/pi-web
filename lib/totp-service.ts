import { createHash } from "node:crypto";
import { getDatabase, type PiWebDatabase } from "./db";
import {
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  disableTotp,
  enableTotp,
  isAccountConfigured,
  readAccount,
  readSealedTotpSecret,
  readTotpState,
  replaceRecoveryCodes,
  setPendingTotpSecret,
  setTotpLastStep,
} from "./auth-store";
import { openSecret, readOrCreateSecretKey, sealSecret } from "./secret-box";
import {
  buildOtpAuthUri,
  generateRecoveryCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  verifyTotp,
} from "./totp";

/**
 * Two-factor enrollment and verification.
 *
 * Routes stay thin: this module owns the sequence (pending secret → confirm →
 * recovery codes) and the two things that must never leak — the seed, which is
 * encrypted at rest, and the recovery codes, of which only hashes are stored.
 */

export const RECOVERY_CODE_COUNT = 10;

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
  qrSvg: string;
}

function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code), "utf8").digest("hex");
}

function openSeed(db: PiWebDatabase): string | null {
  const sealed = readSealedTotpSecret(db);
  if (!sealed) return null;
  try {
    return openSecret(sealed, readOrCreateSecretKey());
  } catch (error) {
    // A restored database without its key cannot produce valid codes. Failing
    // closed with an explanation beats silently accepting a wrong code.
    console.error(
      "[pi-web] Cannot decrypt the stored TOTP secret: "
      + (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

async function renderQrSvg(uri: string): Promise<string> {
  const { toString } = await import("qrcode");
  return toString(uri, { type: "svg", margin: 1, width: 220, errorCorrectionLevel: "M" });
}

export function newRecoveryCodeHashes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

/** Starts (or restarts) enrollment: stores a fresh pending seed and renders its QR. */
export async function startTotpEnrollment(
  db: PiWebDatabase = getDatabase(),
): Promise<TotpEnrollment | null> {
  const account = readAccount(db);
  if (!account || !isAccountConfigured(db)) return null;

  const secret = generateTotpSecret();
  setPendingTotpSecret(sealSecret(secret, readOrCreateSecretKey()), db);
  const otpauthUri = buildOtpAuthUri(secret, account.username);
  return { secret, otpauthUri, qrSvg: await renderQrSvg(otpauthUri) };
}

export interface TotpConfirmation {
  ok: boolean;
  reason?: "not-configured" | "no-pending-secret" | "invalid-code";
  recoveryCodes?: string[];
}

/** Confirms a pending enrollment and returns the recovery codes exactly once. */
export function confirmTotpEnrollment(
  code: string,
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): TotpConfirmation {
  if (!isAccountConfigured(db)) return { ok: false, reason: "not-configured" };
  const seed = openSeed(db);
  if (!seed) return { ok: false, reason: "no-pending-secret" };

  // The same replay guard as sign-in: a code typed twice must not enroll twice.
  const verification = verifyTotp(seed, code, { now, notBefore: readTotpState(db).lastStep });
  if (!verification.ok) return { ok: false, reason: "invalid-code" };

  const { codes, hashes } = newRecoveryCodeHashes();
  enableTotp(db, now);
  replaceRecoveryCodes(hashes, db, now);
  if (verification.step != null) setTotpLastStep(verification.step, db);
  return { ok: true, recoveryCodes: codes };
}

export type TotpLoginResult =
  | { ok: true; method: "totp" | "recovery-code"; remainingRecoveryCodes: number }
  | { ok: false; reason: "not-enabled" | "invalid-code" | "seed-unreadable" };

/**
 * Verifies the second factor at sign-in. A recovery code is accepted in the
 * same field; it is consumed, and the last one being used is reported back so
 * the UI can warn before the account is locked out of its second factor.
 */
export function verifyTotpForLogin(
  code: string,
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): TotpLoginResult {
  const account = readAccount(db);
  if (!account?.totpEnabled) return { ok: false, reason: "not-enabled" };

  const seed = openSeed(db);
  if (!seed) return { ok: false, reason: "seed-unreadable" };

  const verification = verifyTotp(seed, code, { now, notBefore: account.totpLastStep });
  if (verification.ok) {
    if (verification.step != null) setTotpLastStep(verification.step, db);
    return { ok: true, method: "totp", remainingRecoveryCodes: countUnusedRecoveryCodes(db) };
  }

  const recovery = consumeRecoveryCode(hashRecoveryCode(code), db, now);
  if (recovery.ok) {
    return { ok: true, method: "recovery-code", remainingRecoveryCodes: recovery.remaining };
  }

  return { ok: false, reason: "invalid-code" };
}

/** Replaces every recovery code; the previous set stops working immediately. */
export function regenerateRecoveryCodes(
  db: PiWebDatabase = getDatabase(),
  now: number = Date.now(),
): string[] | null {
  if (!readAccount(db)?.totpEnabled) return null;
  const { codes, hashes } = newRecoveryCodeHashes();
  replaceRecoveryCodes(hashes, db, now);
  return codes;
}

export function turnOffTotp(db: PiWebDatabase = getDatabase(), now: number = Date.now()): void {
  disableTotp(db, now);
}

/** Where the enrollment secret currently stands, for the account page. */
export function readTotpSummary(db: PiWebDatabase = getDatabase()): {
  enabled: boolean;
  pending: boolean;
  confirmedAt: number | null;
  remainingRecoveryCodes: number;
} {
  const state = readTotpState(db);
  return {
    enabled: state.enabled,
    pending: state.pending,
    confirmedAt: state.confirmedAt,
    remainingRecoveryCodes: countUnusedRecoveryCodes(db),
  };
}
