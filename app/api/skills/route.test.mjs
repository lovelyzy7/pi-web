import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "pi-web-skills-cwd-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const { installDatabaseForTests, openDatabase } = await jiti.import("@/lib/db.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access.ts");
installDatabaseForTests(openDatabase(":memory:"));

const project = join(home, "project");
before(() => {
  assert.ok(process.env.PI_CODING_AGENT_DIR.startsWith(home));
  mkdirSync(project, { recursive: true });
});
after(() => {
  installDatabaseForTests(null);
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
});

/** The settings section that reported "Access denied" in a container. */
test("a project directory that is not on this machine no longer refuses the list", async () => {
  const missing = join(home, "host-only-project");
  const response = await route.GET(new Request(`http://localhost/api/skills?cwd=${encodeURIComponent(missing)}`));
  const body = await response.json();

  assert.equal(response.status, 200, "the global skills stay reachable");
  assert.deepEqual(body.cwdNotice, { requested: missing, reason: "missing" });
  assert.ok(Array.isArray(body.skills));
  assert.equal(body.error, undefined);
});

test("an allowed project directory is used as asked, with no notice", async () => {
  allowFileRoot(project);
  const response = await route.GET(new Request(`http://localhost/api/skills?cwd=${encodeURIComponent(project)}`));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.cwdNotice, undefined);
  assert.ok(Array.isArray(body.skills));
});

test("a readable directory that is not allowed is still refused", async () => {
  const outside = join(home, "outside");
  mkdirSync(outside, { recursive: true });
  const response = await route.GET(new Request(`http://localhost/api/skills?cwd=${encodeURIComponent(outside)}`));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Access denied");
});

test("without a cwd the request is still rejected", async () => {
  const response = await route.GET(new Request("http://localhost/api/skills"));
  assert.equal(response.status, 400);
});
