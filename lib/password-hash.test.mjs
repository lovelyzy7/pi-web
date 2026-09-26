import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  hashPassword,
  verifyPasswordHash,
  verifyPasswordHashSync,
  parsePasswordHash,
  SCRYPT_PARAMETERS,
} = await jiti.import("./password-hash.ts");

// Cheap parameters keep the suite fast; parsing is parameter-driven, so a hash
// written with production parameters still verifies against the same code path.
const TEST_PARAMETERS = { N: 1024, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

test("hashes verify against their own password only", async () => {
  const stored = await hashPassword("correct horse battery staple", TEST_PARAMETERS);
  assert.equal(await verifyPasswordHash("correct horse battery staple", stored), true);
  assert.equal(await verifyPasswordHash("correct horse battery stapl", stored), false);
  assert.equal(await verifyPasswordHash("", stored), false);
  assert.equal(verifyPasswordHashSync("correct horse battery staple", stored), true);
  assert.equal(verifyPasswordHashSync("nope", stored), false);
});

test("each hash carries a fresh salt", async () => {
  const first = await hashPassword("same password", TEST_PARAMETERS);
  const second = await hashPassword("same password", TEST_PARAMETERS);
  assert.notEqual(first, second);
  assert.equal(await verifyPasswordHash("same password", first), true);
  assert.equal(await verifyPasswordHash("same password", second), true);
});

test("stores the cost parameters in the hash", async () => {
  const stored = await hashPassword("secret", TEST_PARAMETERS);
  assert.match(stored, /^scrypt\$N=1024,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.deepEqual(parsePasswordHash(stored)?.parameters, { N: 1024, r: 8, p: 1 });
  assert.ok(SCRYPT_PARAMETERS.N > 1024);
});

test("supports non-ASCII passwords", async () => {
  const stored = await hashPassword("口令-测试-🔐", TEST_PARAMETERS);
  assert.equal(await verifyPasswordHash("口令-测试-🔐", stored), true);
  assert.equal(await verifyPasswordHash("口令-测试", stored), false);
});

test("rejects malformed or alien hash records without throwing", async () => {
  for (const stored of [
    null, undefined, "", "scrypt", "bcrypt$1$2$3", "scrypt$N=1024,r=8,p=1$onlythree",
    "scrypt$N=1024,r=8,p=1$a$b", "scrypt$N=0,r=8,p=1$c2FsdA$aGFzaA",
    "scrypt$N=1024,r=8$c2FsdA$aGFzaA", "scrypt$N=1024,r=8,p=1$!!!!$aGFzaA",
  ]) {
    assert.equal(await verifyPasswordHash("secret", stored), false, `accepted ${String(stored)}`);
    assert.equal(verifyPasswordHashSync("secret", stored), false, `accepted ${String(stored)}`);
  }
});

test("rejects a non-canonical base64url salt", async () => {
  const stored = await hashPassword("secret", TEST_PARAMETERS);
  const tampered = stored.replace(/\$([A-Za-z0-9_-]+)\$/, "$c2FsdA==$");
  assert.equal(await verifyPasswordHash("secret", tampered), false);
});
