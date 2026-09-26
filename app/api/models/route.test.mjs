import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "pi-web-models-cwd-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const { installDatabaseForTests, openDatabase } = await jiti.import("@/lib/db.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");
installDatabaseForTests(openDatabase(":memory:"));

before(() => assert.ok(process.env.PI_CODING_AGENT_DIR.startsWith(home)));

after(() => {
  installDatabaseForTests(null);
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
});

/** A host path this machine has never had — the mounted-agent-directory case. */
const MISSING = join(home, "host-only-project");
const PROJECT = join(home, "project");
mkdirSync(PROJECT, { recursive: true });

test("a project directory this machine cannot see does not break the model list", async () => {
  // Exactly the container case: the sidebar shows a session whose cwd only
  // exists on the host, so the browser asks for /api/models?cwd=<that path>.
  assert.equal(existsSync(MISSING), false, "this test needs a path that does not exist");

  const response = await route.GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(MISSING)}`));
  const body = await response.json();

  assert.equal(response.status, 200, "the listing loads anyway");
  assert.equal(body.cwdNotice?.requested, MISSING);
  assert.equal(body.cwdNotice?.reason, "missing");
  assert.ok(body.cwdNotice?.used && existsSync(body.cwdNotice.used), "the fallback is a real directory");
  assert.equal(body.cwd, body.cwdNotice.used);
  // No model error: the composer stays usable.
  assert.equal(body.modelError, undefined);
});

test("a usable directory is used as asked, with no notice", async () => {
  allowFileRoot(PROJECT);
  const response = await route.GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(PROJECT)}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.cwdNotice, undefined);
  assert.equal(body.cwd, PROJECT);
});

test("a readable directory that is not allowed is still reported, not served", async () => {
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  const response = await route.GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(outside)}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.cwdNotice?.requested, outside);
  assert.equal(body.cwdNotice?.reason, "not_allowed");
});

test("a file instead of a directory is reported as such", async () => {
  const file = join(home, "not-a-directory.txt");
  await (await import("node:fs/promises")).writeFile(file, "x");
  const response = await route.GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(file)}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.cwdNotice?.reason, "not_a_directory");
});

test("no cwd parameter still works", async () => {
  const response = await route.GET(new Request("http://localhost/api/models"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.ok(body.modelList === undefined || Array.isArray(body.modelList));
});

