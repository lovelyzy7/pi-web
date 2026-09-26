import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const directory = mkdtempSync(join(tmpdir(), "pi-web-totp-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const { createAccount, countUnusedRecoveryCodes, readAccount } = await jiti.import("./auth-store.ts");
const {
  startTotpEnrollment, confirmTotpEnrollment, verifyTotpForLogin, regenerateRecoveryCodes,
  turnOffTotp, readTotpSummary, RECOVERY_CODE_COUNT,
} = await jiti.import("./totp-service.ts");
const { generateTotp, timeStepAt, encodeBase32 } = await jiti.import("./totp.ts");
const { openSecret, readOrCreateSecretKey, sealSecret, getDefaultSecretKeyPath } = await jiti.import("./secret-box.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

before(async () => { await createAccount("a-long-enough-password", { db, now: 1_000 }); });
beforeEach(() => { turnOffTotp(db); });
after(() => {
  installDatabaseForTests(null);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(directory, { recursive: true, force: true });
});

test("seals and opens the seed, and refuses a foreign key", () => {
  const key = readOrCreateSecretKey();
  const sealed = sealSecret("JBSWY3DPEHPK3PXP", key);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(openSecret(sealed, key), "JBSWY3DPEHPK3PXP");
  assert.throws(() => openSecret(sealed, Buffer.alloc(32, 7)));
  assert.throws(() => openSecret("v2.nope.nope.nope", key));
  // The key file is created once and reused.
  assert.deepEqual(readOrCreateSecretKey(), key);
  assert.ok(getDefaultSecretKeyPath().endsWith(join("pi-web", "secret.key")));
});

test("enrollment stores a pending secret and returns a QR without enabling TOTP", async () => {
  const enrollment = await startTotpEnrollment(db);
  assert.ok(enrollment);
  assert.match(enrollment.secret, /^[A-Z2-7]{32}$/);
  assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\//);
  assert.match(enrollment.qrSvg, /^<svg/);

  const summary = readTotpSummary(db);
  assert.equal(summary.enabled, false);
  assert.equal(summary.pending, true);

  // The seed is stored sealed, never in the clear.
  const stored = db.prepare("SELECT totp_secret_enc FROM account WHERE id = 1").get().totp_secret_enc;
  assert.ok(!stored.includes(enrollment.secret));
  assert.equal(openSecret(stored, readOrCreateSecretKey()), enrollment.secret);
});

test("a wrong confirmation code leaves TOTP disabled", async () => {
  const enrollment = await startTotpEnrollment(db);
  const wrongOne = generateTotp(enrollment.secret, timeStepAt(Date.now()) + 5);
  const result = confirmTotpEnrollment(wrongOne, db);
  assert.deepEqual(result, { ok: false, reason: "invalid-code" });
  assert.equal(readTotpSummary(db).enabled, false);
});

test("confirming issues recovery codes exactly once and enables the second factor", async () => {
  const enrollment = await startTotpEnrollment(db);
  const code = generateTotp(enrollment.secret, timeStepAt(Date.now()));
  const confirmed = confirmTotpEnrollment(code, db);

  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.recoveryCodes.length, RECOVERY_CODE_COUNT);
  assert.equal(countUnusedRecoveryCodes(db), RECOVERY_CODE_COUNT);
  assert.equal(readTotpSummary(db).enabled, true);

  // A second confirmation with the same code is rejected (replay guard).
  const replay = confirmTotpEnrollment(code, db);
  assert.equal(replay.ok, false);
});

test("login accepts a code once and rejects the replay", async () => {
  const enrollment = await startTotpEnrollment(db);
  const now = Date.now();
  const step = timeStepAt(now);
  confirmTotpEnrollment(generateTotp(enrollment.secret, step), db, now);

  const accepted = verifyTotpForLogin(generateTotp(enrollment.secret, step + 1), db, now + 30_000);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.method, "totp");
  assert.equal(accepted.remainingRecoveryCodes, RECOVERY_CODE_COUNT);

  assert.deepEqual(
    verifyTotpForLogin(generateTotp(enrollment.secret, step + 1), db, now + 30_000),
    { ok: false, reason: "invalid-code" },
    "the same step cannot be used twice",
  );
});

test("a recovery code signs in, is consumed, and reports the remaining count", async () => {
  const enrollment = await startTotpEnrollment(db);
  const confirmed = confirmTotpEnrollment(generateTotp(enrollment.secret, timeStepAt(Date.now())), db);
  const [first, second] = confirmed.recoveryCodes;

  const used = verifyTotpForLogin(first.toLowerCase(), db);
  assert.equal(used.ok, true);
  assert.equal(used.method, "recovery-code");
  assert.equal(used.remainingRecoveryCodes, RECOVERY_CODE_COUNT - 1);

  const again = verifyTotpForLogin(first, db);
  assert.deepEqual(again, { ok: false, reason: "invalid-code" });

  assert.equal(verifyTotpForLogin(second, db).ok, true);
  assert.equal(countUnusedRecoveryCodes(db), RECOVERY_CODE_COUNT - 2);
});

test("regenerating replaces every recovery code", async () => {
  const enrollment = await startTotpEnrollment(db);
  const first = confirmTotpEnrollment(generateTotp(enrollment.secret, timeStepAt(Date.now())), db);

  const replacement = regenerateRecoveryCodes(db);
  assert.equal(replacement.length, RECOVERY_CODE_COUNT);
  assert.equal(verifyTotpForLogin(first.recoveryCodes[0], db).ok, false);
  assert.equal(verifyTotpForLogin(replacement[0], db).ok, true);

  turnOffTotp(db);
  assert.equal(regenerateRecoveryCodes(db), null);
});

test("turning the second factor off clears the seed, the guard, and the codes", async () => {
  const enrollment = await startTotpEnrollment(db);
  confirmTotpEnrollment(generateTotp(enrollment.secret, timeStepAt(Date.now())), db);
  assert.equal(readAccount(db).totpEnabled, true);

  turnOffTotp(db);
  const summary = readTotpSummary(db);
  assert.equal(summary.enabled, false);
  assert.equal(summary.pending, false);
  assert.equal(summary.remainingRecoveryCodes, 0);
  assert.equal(readAccount(db).totpEnabled, false);
  assert.equal(readAccount(db).totpLastStep, null);
  assert.deepEqual(verifyTotpForLogin("123456", db), { ok: false, reason: "not-enabled" });
});

test("verification is refused while TOTP is not enabled", () => {
  assert.deepEqual(verifyTotpForLogin("123456", db), { ok: false, reason: "not-enabled" });
});

test("a seed sealed with another key fails closed instead of crashing", async () => {
  const enrollment = await startTotpEnrollment(db);
  confirmTotpEnrollment(generateTotp(enrollment.secret, timeStepAt(Date.now())), db);

  // Simulate restoring the database without its key file.
  const foreign = sealSecret(encodeBase32(Buffer.from("some-other-secret!!")), Buffer.alloc(32, 3));
  db.prepare("UPDATE account SET totp_secret_enc = ? WHERE id = 1").run(foreign);

  const result = verifyTotpForLogin("123456", db);
  assert.deepEqual(result, { ok: false, reason: "seed-unreadable" });
});
