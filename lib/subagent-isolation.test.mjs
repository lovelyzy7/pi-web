import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const exec = promisify(execFile);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { addWorktree, removeWorktree } = await jiti.import("./worktree.ts");

// Approving a new worktree root persists it. Without this the test would write
// its temporary directories into the operator's real pi-web.db.
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
installDatabaseForTests(openDatabase(":memory:"));
process.on("exit", () => installDatabaseForTests(null));

async function git(cwd, ...args) {
  await exec("git", ["-C", cwd, ...args]);
}

test("isolated worktrees are unique, write-safe, and cleaned without deleting dirty work", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-web-agent-isolation-"));
  try {
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Pi Web Test");
    await writeFile(join(repo, "README.md"), "parent\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-qm", "initial");

    const first = await addWorktree(repo, "pi-web-test-one");
    const second = await addWorktree(repo, "pi-web-test-two");
    assert.notEqual(first.path, second.path);
    await writeFile(join(first.path, "child.txt"), "child\n");
    await assert.rejects(stat(join(repo, "child.txt")));

    await assert.rejects(removeWorktree(repo, first.path), /modified|untracked|dirty/i);
    await removeWorktree(repo, first.path, true);
    await removeWorktree(repo, second.path);
    await assert.rejects(stat(first.path));
    await assert.rejects(stat(second.path));
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "parent\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("worktree isolation rejects non-git directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-agent-non-git-"));
  try {
    await assert.rejects(addWorktree(cwd, "agent"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
