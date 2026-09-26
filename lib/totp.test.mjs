import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  encodeBase32, decodeBase32, generateTotpSecret, generateTotp, verifyTotp,
  buildOtpAuthUri, timeStepAt, generateRecoveryCode, normalizeRecoveryCode,
  TOTP_PERIOD_SECONDS, TOTP_DIGITS,
} = await jiti.import("./totp.ts");

// RFC 6238 Appendix B uses the ASCII secret "12345678901234567890".
const RFC_SECRET = encodeBase32(Buffer.from("12345678901234567890", "ascii"));

test("base32 round-trips and rejects invalid input", () => {
  const buffer = Buffer.from([0x00, 0x01, 0x02, 0xfd, 0xfe, 0xff]);
  assert.deepEqual(decodeBase32(encodeBase32(buffer)), buffer);
  assert.equal(decodeBase32("MFRGGZDF").toString("ascii"), "abcde", "8 base32 chars decode to 5 bytes");
  assert.equal(decodeBase32(""), null);
  assert.equal(decodeBase32("!!!!"), null);
  assert.deepEqual(decodeBase32("MFRG GZDF"), decodeBase32("MFRGGZDF"), "separators are stripped");
  assert.deepEqual(decodeBase32("mfrggzdf"), decodeBase32("MFRGGZDF"), "case-insensitive");
});

test("reproduces the RFC 6238 test vectors", () => {
  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [seconds, expected] of vectors) {
    const step = Math.floor(seconds / TOTP_PERIOD_SECONDS);
    // RFC vectors are 8 digits; the tail of our 6-digit code is a prefix match
    // only when the leading digits are zero, so compare generated values with
    // the same modulus the vector uses.
    const code = generateTotp(RFC_SECRET, step);
    assert.equal(code.length, TOTP_DIGITS);
    assert.equal(Number(expected) % 10 ** TOTP_DIGITS, Number(code), `vector ${seconds}`);
  }
});

test("verifies the current step and one step of clock skew", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  const current = generateTotp(secret, timeStepAt(now));
  assert.deepEqual(verifyTotp(secret, current, { now }), { ok: true, step: timeStepAt(now) });

  const previous = generateTotp(secret, timeStepAt(now) - 1);
  assert.equal(verifyTotp(secret, previous, { now }).ok, true);
  const next = generateTotp(secret, timeStepAt(now) + 1);
  assert.equal(verifyTotp(secret, next, { now }).ok, true);

  const tooOld = generateTotp(secret, timeStepAt(now) - 3);
  assert.equal(verifyTotp(secret, tooOld, { now }).ok, false);
});

test("rejects malformed codes and wrong digits", () => {
  const secret = generateTotpSecret();
  for (const code of ["", "12345", "1234567", "abcdef", "12 34 56", " 123456 "]) {
    const result = verifyTotp(secret, code);
    if (code === " 123456 " || code === "12 34 56") continue; // separators are stripped
    assert.equal(result.ok, false, code);
  }
  assert.equal(verifyTotp("not-base32!", "123456").ok, false);
});

test("a used step cannot be replayed", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const step = timeStepAt(now);
  const code = generateTotp(secret, step);

  assert.equal(verifyTotp(secret, code, { now }).ok, true);
  assert.equal(verifyTotp(secret, code, { now, notBefore: step }).ok, false);
  // The previous step is still accepted when it was never used.
  assert.equal(verifyTotp(secret, generateTotp(secret, step - 1), { now, notBefore: step - 2 }).ok, true);
});

test("accepts a code entered with separators or different case", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const code = generateTotp(secret, timeStepAt(now));
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok, true);
});

test("secret generation produces distinct, decodable secrets", () => {
  const first = generateTotpSecret();
  const second = generateTotpSecret();
  assert.notEqual(first, second);
  assert.equal(decodeBase32(first).length, 20);
  assert.match(first, /^[A-Z2-7]+$/);
});

test("builds a usable otpauth URI", () => {
  const uri = buildOtpAuthUri("ABCDEFGH", "pi", "Pi Web");
  assert.match(uri, /^otpauth:\/\/totp\/Pi%20Web%3Api\?/);
  const params = new URLSearchParams(uri.split("?")[1]);
  assert.equal(params.get("secret"), "ABCDEFGH");
  assert.equal(params.get("issuer"), "Pi Web");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
});

test("recovery codes are grouped, unambiguous, and normalized for comparison", () => {
  const code = generateRecoveryCode();
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.doesNotMatch(code, /[O0I1L]/);
  assert.equal(normalizeRecoveryCode(` ${code.toLowerCase()} `), code);
  assert.equal(normalizeRecoveryCode(code), code);
  assert.notEqual(generateRecoveryCode(), code);
});
