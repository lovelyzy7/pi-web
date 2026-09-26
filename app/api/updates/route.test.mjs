import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
delete process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const updatesRoute = await jiti.import("../updates/route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("../../../lib/db.ts");
const { createAccount } = await jiti.import("../../../lib/auth-store.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

beforeEach(async () => {
  db.exec("DELETE FROM market_cache; DELETE FROM update_checks; DELETE FROM account;");
  await createAccount("a-long-enough-password", { db });
});

after(() => {
  if (originalPassword !== undefined) process.env.PI_WEB_PASSWORD = originalPassword;
  installDatabaseForTests(null);
});

function request(path, method = "GET", body, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("the updates payload reports the runtime, the deployment, and skips plugin checks by default", async () => {
  const response = await updatesRoute.GET(request("/api/updates"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(typeof body.app.currentVersion === "string");
  assert.ok(typeof body.runtime.piVersion === "string");
  assert.ok(typeof body.runtime.nodeVersion === "string");
  assert.ok(["docker", "npm", "source"].includes(body.deployment.mode));
  assert.equal(body.plugins.checked, false, "plugin checks cost one npm view each");
  assert.ok(Array.isArray(body.deployment.instructions));
});

test("a forced check records its result, and a later read serves the cache", async () => {
  // The forced path deliberately ignores PI_WEB_SKIP_VERSION_CHECK — the operator
  // asked — so this test only asserts the caching behaviour, not the network.
  const previous = process.env.PI_WEB_SKIP_VERSION_CHECK;
  process.env.PI_WEB_SKIP_VERSION_CHECK = "1";
  try {
    const checked = await (await updatesRoute.GET(request("/api/updates?check=1"))).json();
    assert.equal(typeof checked.app.latestVersion, "string");
    assert.equal(typeof checked.app.checkedAt, "number");

    const stored = db.prepare("SELECT subject, expires_at FROM update_checks").all();
    assert.deepEqual(stored.map((row) => row.subject), ["pi-web"]);

    // The plain read now answers from that row, and the automatic check being
    // disabled is visible to the UI.
    const cached = await (await updatesRoute.GET(request("/api/updates"))).json();
    assert.equal(cached.app.fromCache, true);
    assert.equal(cached.app.autoCheckDisabled, true, "the UI banner needs to know checks are off");
    assert.equal(typeof cached.app.latestVersion, "string");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_SKIP_VERSION_CHECK;
    else process.env.PI_WEB_SKIP_VERSION_CHECK = previous;
  }
});

test("self-update stays refused until the operator opts in", async () => {
  const previous = process.env.PI_WEB_ALLOW_SELF_UPDATE;
  delete process.env.PI_WEB_ALLOW_SELF_UPDATE;
  try {
    const response = await updatesRoute.POST(request("/api/updates", "POST", { action: "self-update" }));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "self_update_disabled");
    assert.ok(Array.isArray(body.instructions));
  } finally {
    if (previous !== undefined) process.env.PI_WEB_ALLOW_SELF_UPDATE = previous;
  }
});

test("rollback refuses a version that is not a release on disk", async () => {
  const response = await updatesRoute.POST(request("/api/updates", "POST", { action: "rollback", version: "../../etc" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "rollback_failed");

  const missing = await updatesRoute.POST(request("/api/updates", "POST", { action: "rollback", version: "9.9.9" }));
  assert.equal(missing.status, 400);
});

test("the image build can be selected again", async () => {
  const response = await updatesRoute.POST(request("/api/updates", "POST", { action: "use-image-build" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.restartRequired, true);
});

test("unknown actions are refused", async () => {
  const response = await updatesRoute.POST(request("/api/updates", "POST", { action: "drop-database" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unknown_action");
});
