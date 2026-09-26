import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "pi-web-project-cwd-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { projectCwdNotice, projectCwdRefusalStatus, resolveProjectCwd } = await jiti.import("./project-cwd.ts");

const project = join(home, "project");
const file = join(home, "file.txt");
before(() => {
  mkdirSync(project, { recursive: true });
  writeFileSync(file, "x");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("an existing, allowed directory is used", async () => {
  const resolved = await resolveProjectCwd(project, { allowedRoots: new Set([project]) });
  assert.deepEqual(resolved, { status: "ok", cwd: project, requested: project });
  assert.equal(projectCwdNotice(resolved), null);
  assert.equal(projectCwdRefusalStatus(resolved.status), null);
});

test("no directory means global scope", async () => {
  assert.deepEqual(await resolveProjectCwd(null), { status: "none", cwd: null, requested: null });
  assert.deepEqual(await resolveProjectCwd("   "), { status: "none", cwd: null, requested: null });
  assert.equal(projectCwdRefusalStatus("none"), null);
});

test("a directory that is not on this machine degrades instead of refusing", async () => {
  // The container case behind "Access denied" in the skills and plugins sections.
  const missing = join(home, "host-only");
  const resolved = await resolveProjectCwd(missing);
  assert.equal(resolved.status, "missing");
  assert.equal(resolved.cwd, null);
  assert.equal(projectCwdRefusalStatus(resolved.status), null, "no 403: the global scope still loads");
  assert.deepEqual(projectCwdNotice(resolved), { requested: missing, reason: "missing" });
});

test("a file path is reported as not a directory", async () => {
  const resolved = await resolveProjectCwd(file);
  assert.equal(resolved.status, "not_a_directory");
  assert.equal(projectCwdRefusalStatus(resolved.status), null);
});

test("an existing directory outside the readable roots is still refused", async () => {
  const resolved = await resolveProjectCwd(project, { allowedRoots: new Set([join(home, "elsewhere")]) });
  assert.equal(resolved.status, "not_allowed");
  assert.equal(projectCwdRefusalStatus(resolved.status), 403, "this is a real authorization failure");
  assert.deepEqual(projectCwdNotice(resolved), { requested: project, reason: "not_allowed" });
});

test("a relative path is resolved before it is checked", async () => {
  const resolved = await resolveProjectCwd(join(process.cwd(), "package.json"), {
    allowedRoots: new Set([process.cwd()]),
  });
  assert.equal(resolved.status, "not_a_directory");
  assert.equal(resolved.requested, join(process.cwd(), "package.json"));
});
