import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  getSetupCode, verifySetupCode, clearSetupCode,
  INIT_CODE_LENGTH, INIT_CODE_TTL_MS,
} = await jiti.import("./init-setup.ts");

afterEach(() => {
  clearSetupCode();
  delete process.env.PI_WEB_INIT_TOKEN;
});

test("generates a code of the documented shape and reuses it inside the window", () => {
  const code = getSetupCode(1_000);
  assert.equal(code.length, INIT_CODE_LENGTH);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
  assert.equal(getSetupCode(1_000 + INIT_CODE_TTL_MS - 1), code);
});

test("rotates once the window expires", () => {
  const first = getSetupCode(0);
  let next = first;
  for (let attempt = 0; attempt < 20 && next === first; attempt += 1) {
    next = getSetupCode(INIT_CODE_TTL_MS);
  }
  assert.notEqual(next, first);
});

test("accepts the current code regardless of case and separators", () => {
  const code = getSetupCode(5_000);
  assert.equal(verifySetupCode(code, 5_000), true);
  assert.equal(verifySetupCode(code.toLowerCase(), 5_000), true);
  assert.equal(verifySetupCode(` ${code.slice(0, 4)}-${code.slice(4)} `, 5_000), true);
});

test("rejects wrong, missing, stale, and malformed codes", () => {
  const code = getSetupCode(5_000);
  const wrong = code === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA";
  assert.equal(verifySetupCode(wrong, 5_000), false);
  assert.equal(verifySetupCode(undefined, 5_000), false);
  assert.equal(verifySetupCode(12345678, 5_000), false);
  assert.equal(verifySetupCode("", 5_000), false);
  assert.equal(verifySetupCode(code, 5_000 + INIT_CODE_TTL_MS), false);
  // Nothing was generated yet in this process for this window.
  clearSetupCode();
  assert.equal(verifySetupCode(code, 6_000), false);
});

test("PI_WEB_INIT_TOKEN pins the code and ignores the generated one", () => {
  process.env.PI_WEB_INIT_TOKEN = "fixed-token";
  assert.equal(getSetupCode(1_000), "fixed-token");
  assert.equal(verifySetupCode("fixed-token", 1_000), true);
  assert.equal(verifySetupCode("FIXED-TOKEN", 1_000), true);
  assert.equal(verifySetupCode("something-else", 1_000), false);
});
