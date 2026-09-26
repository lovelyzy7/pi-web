import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  checkPasswordStrength,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_PASSPHRASE_LENGTH,
} = await jiti.import("./password-policy.ts");

test("accepts passphrases and mixed passwords", () => {
  for (const password of [
    "correct horse battery staple",
    "Tr0ub4dor&3xample",
    "为了安全-this-is-long",
  ]) {
    assert.deepEqual(checkPasswordStrength(password), { ok: true }, password);
  }
});

test("requires the minimum length", () => {
  assert.equal(checkPasswordStrength("Short1").reason, "too-short");
  assert.equal(checkPasswordStrength("a".repeat(PASSWORD_MIN_LENGTH - 1)).reason, "too-short");
  assert.ok(PASSWORD_MIN_LENGTH >= 10);
});

test("requires two character classes below the passphrase length", () => {
  assert.equal(checkPasswordStrength("abcdefghij").reason, "needs-more-variety");
  assert.equal(checkPasswordStrength("abcdefghij").ok, false);
  assert.equal(checkPasswordStrength("abcdefghij1").ok, true);
  assert.ok(PASSWORD_PASSPHRASE_LENGTH > PASSWORD_MIN_LENGTH);
  // A long single-class passphrase is allowed on purpose.
  assert.equal(checkPasswordStrength("averylongsingleclasspassphrase").ok, true);
});

test("rejects common passwords regardless of length", () => {
  assert.equal(checkPasswordStrength("password123").reason, "common");
  assert.equal(checkPasswordStrength("PASSWORD123").reason, "common");
});

test("rejects repeated and pathological input", () => {
  assert.equal(checkPasswordStrength("a".repeat(20)).reason, "repeated");
  assert.equal(checkPasswordStrength("          ").reason, "repeated");
  assert.equal(checkPasswordStrength("x".repeat(PASSWORD_MAX_LENGTH + 1)).reason, "too-long");
});

test("rejects passwords containing the account name", () => {
  assert.equal(
    checkPasswordStrength("piadmin-Login-2026", { username: "piadmin" }).reason,
    "contains-username",
  );
  assert.equal(checkPasswordStrength("pi-Web-Login-2026", { username: "piadmin" }).ok, true);
  // The built-in account is named "pi", which is too short to reject on.
  assert.equal(checkPasswordStrength("pi-Web-Login-2026", { username: "pi" }).ok, true);
});
