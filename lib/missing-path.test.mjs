import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { nearestMissingRoot } = await jiti.import("./missing-path.ts");

const home = mkdtempSync(join(tmpdir(), "pi-web-missing-"));
const project = join(home, "srv", "project");
mkdirSync(project, { recursive: true });
writeFileSync(join(home, "file.txt"), "x");

test("an existing path has nothing missing", () => {
  assert.equal(nearestMissingRoot(project), null);
  assert.equal(nearestMissingRoot(join(home, "file.txt")), null);
});

test("reports the highest level that does not exist", () => {
  // One level gone: the path itself.
  assert.equal(nearestMissingRoot(join(home, "srv", "gone")), join(home, "srv", "gone"));
  // A whole mounted tree gone: the mount point is the actionable answer.
  const unplugged = join(home, "unmounted", "project", "src");
  assert.equal(nearestMissingRoot(unplugged), join(home, "unmounted"));
});

test("stops at the filesystem root instead of looping", () => {
  assert.equal(nearestMissingRoot("/"), null);
});

// Runs after the tests: a top-level cleanup would delete the fixture before
// they execute (node evaluates the whole module first).
after(() => rmSync(home, { recursive: true, force: true }));
