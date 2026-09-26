import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const directory = mkdtempSync(join(tmpdir(), "pi-web-totp-routes-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPassword = process.env.PI_WEB_PASSWORD;
process.env.PI_CODING_AGENT_DIR = directory;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const totpRoute = await jiti.import("./totp/route.ts");
const tokensRoute = await jiti.import("./tokens/route.ts");
const tokenRoute = await jiti.import("./tokens/[id]/route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const { createAccount, createWebSession, listAuthEvents } = await jiti.import("../../../lib/auth-store.ts");
const { listApiTokens, verifyApiToken } = await jiti.import("../../../lib/api-tokens.ts");
const { generateTotp, timeStepAt } = await jiti.import("../../../lib/totp.ts");
const { resetAuthThrottle } = await jiti.import("../../../lib/auth-throttle-store.ts");

const PASSWORD = "a-long-enough-password";
const db = openDatabase(":memory:");
installDatabaseForTests(db);

let session;

beforeEach(async () => {
  resetAuthThrottle(null, db);
  db.exec("DELETE FROM web_sessions; DELETE FROM auth_events; DELETE FROM api_tokens; DELETE FROM recovery_codes; DELETE FROM account;");
  await createAccount(PASSWORD, { db });
  session = createWebSession({ db, authMethod: "password" });
});

after(() => {
  installDatabaseForTests(null);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  rmSync(directory, { recursive: true, force: true });
});

function request(path, method, body, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      Cookie: `pi_web_session=${session.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function enroll() {
  const setup = await totpRoute.POST(request("/api/user/totp", "POST", { password: PASSWORD }));
  assert.equal(setup.status, 200, await setup.clone().text());
  const enrollment = await setup.json();
  const confirmed = await totpRoute.PUT(request("/api/user/totp", "PUT", {
    code: generateTotp(enrollment.secret, timeStepAt(Date.now())),
  }));
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const body = await confirmed.json();
  return { secret: enrollment.secret, qrSvg: enrollment.qrSvg, otpauthUri: enrollment.otpauthUri, recoveryCodes: body.recoveryCodes };
}

test("enrollment requires the password and returns a QR without enabling anything", async () => {
  const denied = await totpRoute.POST(request("/api/user/totp", "POST", { password: "wrong" }));
  assert.equal(denied.status, 401);
  assert.equal((await totpRoute.GET(request("/api/user/totp", "GET"))).status, 200);

  resetAuthThrottle(null, db);
  const state = await (await totpRoute.GET(request("/api/user/totp", "GET"))).json();
  assert.equal(state.enabled, false);
  assert.equal(state.pending, false);

  const setup = await totpRoute.POST(request("/api/user/totp", "POST", { password: PASSWORD }));
  const body = await setup.json();
  assert.match(body.secret, /^[A-Z2-7]{32}$/);
  assert.match(body.qrSvg, /^<svg/);
  assert.match(body.otpauthUri, /^otpauth:\/\/totp\//);

  const pending = await (await totpRoute.GET(request("/api/user/totp", "GET"))).json();
  assert.equal(pending.enabled, false);
  assert.equal(pending.pending, true);
});

test("confirming enables TOTP, returns recovery codes once, and signs other devices out", async () => {
  const other = createWebSession({ db, authMethod: "password" });
  const enrollment = await enroll();

  assert.equal(enrollment.recoveryCodes.length, 10);
  const state = await (await totpRoute.GET(request("/api/user/totp", "GET"))).json();
  assert.equal(state.enabled, true);
  assert.equal(state.remainingRecoveryCodes, 10);

  const { validateWebSession } = await jiti.import("../../../lib/auth-store.ts");
  assert.equal(validateWebSession(session.token, { db }).ok, true, "the enrolling browser stays signed in");
  assert.equal(validateWebSession(other.token, { db }).reason, "revoked");

  const events = listAuthEvents({ kind: "totp", limit: 5 }, db);
  assert.equal(events[0].result, "ok");
  assert.equal(JSON.parse(events[0].detail).action, "enabled");
});

test("a wrong code cannot enable TOTP", async () => {
  await totpRoute.POST(request("/api/user/totp", "POST", { password: PASSWORD }));
  const response = await totpRoute.PUT(request("/api/user/totp", "PUT", { code: "000000" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid-code");
});

test("disabling needs both the password and a valid code", async () => {
  const enrollment = await enroll();

  const noCode = await totpRoute.DELETE(request("/api/user/totp", "DELETE", { password: PASSWORD }));
  assert.equal(noCode.status, 401);

  const wrongPassword = await totpRoute.DELETE(request("/api/user/totp", "DELETE", {
    password: "nope",
    code: enrollment.recoveryCodes[0],
  }));
  assert.equal(wrongPassword.status, 401);

  resetAuthThrottle(null, db);
  const disabled = await totpRoute.DELETE(request("/api/user/totp", "DELETE", {
    password: PASSWORD,
    code: enrollment.recoveryCodes[0],
  }));
  assert.equal(disabled.status, 200);

  const state = await (await totpRoute.GET(request("/api/user/totp", "GET"))).json();
  assert.equal(state.enabled, false);
  assert.equal(state.remainingRecoveryCodes, 0);
});

test("recovery codes can be regenerated and the old set stops working", async () => {
  const enrollment = await enroll();

  const response = await totpRoute.PATCH(request("/api/user/totp", "PATCH", { password: PASSWORD }));
  assert.equal(response.status, 200);
  const replacement = (await response.json()).recoveryCodes;
  assert.equal(replacement.length, 10);
  assert.notDeepEqual(replacement, enrollment.recoveryCodes);

  const state = await (await totpRoute.GET(request("/api/user/totp", "GET"))).json();
  assert.equal(state.remainingRecoveryCodes, 10);

  const withoutPassword = await totpRoute.PATCH(request("/api/user/totp", "PATCH", {}));
  assert.equal(withoutPassword.status, 401);
});

test("tokens are created with a password and listed without their secrets", async () => {
  const denied = await tokensRoute.POST(request("/api/user/tokens", "POST", { name: "ci", password: "wrong" }));
  assert.equal(denied.status, 401);

  resetAuthThrottle(null, db);
  const created = await tokensRoute.POST(request("/api/user/tokens", "POST", {
    name: "ci",
    scopes: ["read"],
    expiresInDays: 30,
    password: PASSWORD,
  }));
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.match(body.token, /^pi_pat_/);
  assert.deepEqual(body.record.scopes, ["read"]);
  assert.equal(verifyApiToken(body.token, { db }).ok, true);

  const listed = await (await tokensRoute.GET(request("/api/user/tokens", "GET"))).json();
  assert.equal(listed.tokens.length, 1);
  assert.equal(listed.tokens[0].name, "ci");
  assert.ok(!JSON.stringify(listed).includes(body.token), "the secret is never listed");

  const events = listAuthEvents({ kind: "token", limit: 5 }, db);
  assert.equal(JSON.parse(events[0].detail).action, "created");
});

test("a token can be revoked, and unknown ids are refused", async () => {
  const created = await (await tokensRoute.POST(request("/api/user/tokens", "POST", {
    name: "temp",
    password: PASSWORD,
  }))).json();

  const unknown = await tokenRoute.DELETE(
    request("/api/user/tokens/9999", "DELETE"),
    { params: Promise.resolve({ id: "9999" }) },
  );
  assert.equal(unknown.status, 404);

  const invalid = await tokenRoute.DELETE(
    request("/api/user/tokens/abc", "DELETE"),
    { params: Promise.resolve({ id: "abc" }) },
  );
  assert.equal(invalid.status, 400);

  const revoked = await tokenRoute.DELETE(
    request(`/api/user/tokens/${created.record.id}`, "DELETE"),
    { params: Promise.resolve({ id: String(created.record.id) }) },
  );
  assert.equal(revoked.status, 200);
  assert.equal(verifyApiToken(created.token, { db }).ok, false);
  assert.ok(listApiTokens(db)[0].revokedAt !== null);
});

test("both routes refuse to act in environment-password mode", async () => {
  process.env.PI_WEB_PASSWORD = "environment-password";
  try {
    const totp = await totpRoute.GET(request("/api/user/totp", "GET"));
    assert.equal(totp.status, 409);
    assert.equal((await totp.json()).error, "environment_password");

    const tokens = await tokensRoute.POST(request("/api/user/tokens", "POST", { name: "x", password: "y" }));
    assert.equal(tokens.status, 409);
  } finally {
    delete process.env.PI_WEB_PASSWORD;
  }
});

test("both routes refuse an untrusted host", async () => {
  const totp = await totpRoute.GET(request("/api/user/totp", "GET", undefined, { Host: "evil.example" }));
  assert.equal(totp.status, 403);
  const tokens = await tokensRoute.GET(request("/api/user/tokens", "GET", undefined, { Host: "evil.example" }));
  assert.equal(tokens.status, 403);
});
