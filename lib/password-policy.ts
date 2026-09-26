/**
 * Password rules for the single Pi Web account.
 *
 * The rules stay deliberately simple: this is not a password strength meter,
 * and a long passphrase of one character class is stronger than a short mixed
 * one. Length buys permission; anything under 16 characters must additionally
 * use two character classes so an eight-character dictionary word cannot pass.
 */

export const PASSWORD_MIN_LENGTH = 10;
/** Bound the input before feeding it to scrypt. */
export const PASSWORD_MAX_LENGTH = 200;
/** Long enough to stand on its own, regardless of character classes. */
export const PASSWORD_PASSPHRASE_LENGTH = 16;

export type PasswordRejection =
  | "too-short"
  | "too-long"
  | "repeated"
  | "common"
  | "contains-username"
  | "needs-more-variety";

export interface PasswordCheckResult {
  ok: boolean;
  reason?: PasswordRejection;
}

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "p@ssw0rd", "passwords",
  "1234567890", "12345678901", "123456789012", "qwertyuiop", "qwerty12345",
  "letmein123", "iloveyou123", "adminadmin", "administrator", "piwepiweb",
  "changeme123", "welcome123", "abc12345678", "1qaz2wsx3edc", "zaq12wsxcde3",
]);

function countCharacterClasses(password: string): number {
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/\d/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;
  return classes;
}

function isRepetitive(password: string): boolean {
  const trimmed = password.trim();
  if (trimmed.length === 0) return true;
  if (/^(.)\1+$/u.test(trimmed)) return true;
  return trimmed.length >= 6 && new Set(trimmed).size === 1;
}

export function checkPasswordStrength(
  password: string,
  options: { username?: string } = {},
): PasswordCheckResult {
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "too-short" };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, reason: "too-long" };
  if (isRepetitive(password)) return { ok: false, reason: "repeated" };

  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) return { ok: false, reason: "common" };

  // Minimum length 3 on purpose: the built-in account is named "pi", and
  // rejecting every password that contains "pi" would reject most passphrases.
  const username = options.username?.trim().toLowerCase();
  if (username && username.length >= 3 && lowered.includes(username)) {
    return { ok: false, reason: "contains-username" };
  }

  if (password.length < PASSWORD_PASSPHRASE_LENGTH && countCharacterClasses(password) < 2) {
    return { ok: false, reason: "needs-more-variety" };
  }

  return { ok: true };
}
