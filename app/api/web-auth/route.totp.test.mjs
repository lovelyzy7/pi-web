import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const directory = mkdtempSync(join(tmpdir(), "pi-web-login-totp-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPassword = process.env.PI_WEB_PASSWORD;
process.env.PI_CODING_AGENT_DIR = directory;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST, GET } = await jiti.import("./route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const { createAccount, listAuthEvents, listWebSessions, validateWebSession } =
  await jiti.import("../../../lib/auth-store.ts");
const { startTotpEnrollment, confirmTotpEnrollment } = await jiti.import("../../../lib/totp-service.ts");
const { generateTotp, timeStepAt } = await jiti.import("../../../lib/totp.ts");
const { resetAuthThrottle } = await jiti.import("../../../lib/auth-throttle-store.ts");

const PASSWORD = "a-long-enough-password";
const db = openDatabase(":memory:");
installDatabaseForTests(db);

let secret;
let recoveryCodes;

beforeEach(async () => {
  resetAuthThrottle(null, db);
  db.exec("DELETE FROM web_sessions; DELETE FROM auth_events; DELETE FROM recovery_codes; DELETE FROM account;");
  await createAccount(PASSWORD, { db });
  const enrollment = await startTotpEnrollment(db);
  secret = enrollment.secret;
  recoveryCodes = confirmTotpEnrollment(generateTotp(secret, timeStepAt(Date.now())), db).recoveryCodes;
});

after(() => {
  installDatabaseForTests(null);
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  rmSync(directory, { recursive: true, force: true });
});

function request(body) {
  return new NextRequest("http://localhost/api/web-auth", {
    method: "POST",
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("the password step stops before a session when a second factor is enrolled", async () => {
  const response = await POST(request({ password: PASSWORD }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.totpRequired, true);
  assert.match(body.challenge, /^pi_chal_/);
  assert.equal(response.headers.has("set-cookie"), false, "no session before the code is checked");

  const status = await (await GET(new NextRequest("http://localhost/api/web-auth", {
    headers: { Host: "localhost" },
  }))).json();
  assert.equal(status.authenticated, false);
  assert.equal(status.totpEnabled, true);
});

test("a wrong code is refused, a right one creates the session", async () => {
  const challenge = (await (await POST(request({ password: PASSWORD }))).json()).challenge;

  const wrong = await POST(request({ challenge, code: "000000" }));
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "invalid_code");
  assert.equal(wrong.headers.has("set-cookie"), false);

  // The failure blocks the next attempt, so the operator has to wait it out.
  const blocked = await POST(request({ challenge, code: generateTotp(secret, timeStepAt(Date.now()) + 1) }));
  assert.equal(blocked.status, 429);

  resetAuthThrottle(null, db);
  const accepted = await POST(request({ challenge, code: generateTotp(secret, timeStepAt(Date.now()) + 1) }));
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.ok, true);
  assert.equal(body.method, "totp");

  const cookie = accepted.headers.get("set-cookie");
  assert.match(cookie, /^pi_web_session=pws_/);
  const token = cookie.split(";", 1)[0].split("=")[1];
  assert.equal(validateWebSession(token, { db }).ok, true);
  assert.equal(listWebSessions({ db, includeInactive: true })[0].authMethod, "totp");

  const events = listAuthEvents({ kind: "totp", limit: 5 }, db);
  assert.equal(events[0].result, "ok");
  assert.equal(events[1].result, "fail");
});

test("the same code cannot be replayed through a second challenge", async () => {
  // One step ahead: inside the accepted ±1 window, and newer than the step the
  // enrollment itself consumed.
  const step = timeStepAt(Date.now()) + 1;
  const first = (await (await POST(request({ password: PASSWORD }))).json()).challenge;
  assert.equal((await POST(request({ challenge: first, code: generateTotp(secret, step) }))).status, 200);

  resetAuthThrottle(null, db);
  const second = (await (await POST(request({ password: PASSWORD }))).json()).challenge;
  const replay = await POST(request({ challenge: second, code: generateTotp(secret, step) }));
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "invalid_code");
});

test("a recovery code signs in and is consumed", async () => {
  const challenge = (await (await POST(request({ password: PASSWORD }))).json()).challenge;
  const response = await POST(request({ challenge, code: recoveryCodes[0] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.method, "recovery-code");
  assert.equal(body.remainingRecoveryCodes, recoveryCodes.length - 1);
  assert.equal(listWebSessions({ db, includeInactive: true })[0].authMethod, "recovery_code");

  resetAuthThrottle(null, db);
  const again = (await (await POST(request({ password: PASSWORD }))).json()).challenge;
  assert.equal((await POST(request({ challenge: again, code: recoveryCodes[0] }))).status, 401);
});

test("a missing, malformed, or foreign challenge is refused", async () => {
  for (const challenge of ["", "pi_chal_nope", "pi_chal_v1.9999999999.abc.def", "not-a-challenge"]) {
    const response = await POST(request({ challenge, code: generateTotp(secret, timeStepAt(Date.now())) }));
    assert.equal(response.status, 401, challenge);
  }
});

test("without a second factor the password alone still creates a session", async () => {
  const { turnOffTotp } = await jiti.import("../../../lib/totp-service.ts");
  turnOffTotp(db);
  const response = await POST(request({ password: PASSWORD }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.match(response.headers.get("set-cookie"), /^pi_web_session=pws_/);
  assert.equal(listWebSessions({ db, includeInactive: true })[0].authMethod, "password");
});
