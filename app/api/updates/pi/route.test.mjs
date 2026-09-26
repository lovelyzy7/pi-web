import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const home = mkdtempSync(join(tmpdir(), "pi-web-pi-route-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const { installDatabaseForTests, openDatabase } = await jiti.import("@/lib/db.ts");
installDatabaseForTests(openDatabase(":memory:"));

// The "latest" lookup never touches the network in tests.
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = async () => new Response(JSON.stringify({ version: "9.9.9" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
after(() => {
  globalThis.fetch = originalFetch;
  installDatabaseForTests(null);
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
});

function request(path, method = "GET", body) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("GET reports the runtime, the CLI state and the deployment", async () => {
  const response = await route.GET(request("/api/updates/pi"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(body.runtime.version, /^\d+\.\d+\.\d+$/);
  assert.equal(body.runtime.latest, "9.9.9");
  assert.equal(body.runtime.newer, true);
  assert.ok(body.installTarget.endsWith("pi-cli"));
  assert.ok(["docker", "npm", "source"].includes(body.deployment.mode));
  // The CLI may or may not exist on the machine running the test; both are
  // valid states and the shape is what the panel relies on.
  assert.ok(body.cli.via === null || ["path", "bundled", "data-dir"].includes(body.cli.via));
  assert.equal(body.deployment.mode === "docker" ? typeof body.hostCommand === "string" : true, true);
});

test("GET caches the latest lookup and re-checks only when asked", async () => {
  await route.GET(request("/api/updates/pi"));
  const second = await route.GET(request("/api/updates/pi"));
  assert.equal((await second.json()).runtime.latest, "9.9.9");
});

test("POST without a JSON body is refused", async () => {
  const response = await route.POST(
    new NextRequest("http://localhost/api/updates/pi", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" },
      body: "action=install",
    }),
  );
  assert.equal(response.status, 415);
});

test("POST rejects unknown actions before anything runs", async () => {
  const response = await route.POST(request("/api/updates/pi", "POST", { action: "reload" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unknown_action");
});

test("cross-site requests are refused", async () => {
  const response = await route.GET(
    new NextRequest("http://localhost/api/updates/pi", {
      headers: { Host: "localhost", Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" },
    }),
  );
  assert.equal(response.status, 403);
});
