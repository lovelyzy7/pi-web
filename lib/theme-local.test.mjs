import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });

let home;
before(async () => {
  home = await mkdtemp(join(tmpdir(), "pi-web-theme-local-"));
  // Point every module that reads the agent directory at the temp home before
  // importing them: nothing here may touch the operator's real data directory.
  process.env.PI_CODING_AGENT_DIR = join(home, "agent");
  mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
});

after(() => {
  installDatabaseForTests(null);
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_WEB_THEME_ROOTS;
  rmSync(home, { recursive: true, force: true });
});

const {
  getManagedThemesDir,
  importLocalTheme,
  removeManagedTheme,
  scanLocalThemes,
  themeScanRoots,
  THEME_IMPORT_MAX_BYTES,
} = await jiti.import("./theme-local.ts");
const { normalizeSlashes } = await jiti.import("./file-access.ts");

// `importLocalTheme` falls back to the live database; an in-memory one keeps the
// operator's real pi-web.db out of the test, including its WAL checkpoint.
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
installDatabaseForTests(openDatabase(":memory:"));

/**
 * Resolved lazily: the agent directory is only known once `PI_CODING_AGENT_DIR`
 * points at the temp home, and resolving it at module scope would aim the test
 * at the operator's real data directory.
 */
function managedDir() {
  const directory = getManagedThemesDir();
  assert.ok(directory.startsWith(home), `refusing to use ${directory}: it is outside the temp home`);
  return directory;
}

function writeTheme(directory, manifest = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "theme.json"),
    JSON.stringify(
      {
        schema: 1,
        id: "sample",
        name: "Sample",
        version: "1.2.3",
        author: "tester",
        base: "dark",
        variables: ["--bg"],
        styles: ["theme.css"],
        ...manifest,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(directory, "theme.css"), 'html[data-pi-theme="custom"] {\n  --bg: #101010;\n}\n');
  return directory;
}

beforeEach(() => {
  delete process.env.PI_WEB_THEME_ROOTS;
  rmSync(managedDir(), { recursive: true, force: true });
});

/* ------------------------------------------------------------------ scan -- */

test("scans the managed, configured and project directories", async () => {
  const configured = join(home, "configured");
  const project = join(home, "project");
  writeTheme(join(managedDir(), "managed-one"), { id: "managed-one", name: "Managed" });
  writeTheme(join(configured, "configured-one"), { id: "configured-one", name: "Configured", version: "2.0.0" });
  writeTheme(join(project, "themes", "project-one"), { id: "project-one", name: "Project" });
  writeTheme(join(project, ".pi", "themes", "project-two"), { id: "project-two", name: "Project two" });
  process.env.PI_WEB_THEME_ROOTS = configured;

  const scan = await scanLocalThemes({ cwd: project, allowedRoots: new Set([normalizeSlashes(project)]) });
  const byName = Object.fromEntries(scan.themes.map((entry) => [entry.name, entry]));

  assert.deepEqual(Object.keys(byName).sort(), ["Configured", "Managed", "Project", "Project two"]);
  assert.equal(byName.Managed.origin, "managed");
  assert.equal(byName.Managed.managed, true);
  assert.equal(byName.Configured.origin, "configured");
  assert.equal(byName.Configured.version, "2.0.0");
  assert.equal(byName.Project.origin, "project");
  assert.equal(byName.Project.managed, false);
  assert.equal(byName.Project.source, `local:${join(project, "themes", "project-one")}`);
  assert.equal(byName["Project two"].author, "tester");

  // Every root is reported so the panel can show what was looked at.
  const origins = scan.roots.map((root) => root.origin);
  assert.ok(origins.includes("managed") && origins.includes("configured") && origins.includes("project"));
  assert.equal(scan.roots.filter((root) => !root.exists).length, 0);
});

test("skips bookkeeping directories, unreadable manifests and unallowed projects", async () => {
  writeTheme(join(managedDir(), "real"), { id: "real", name: "Real" });
  writeTheme(join(managedDir(), "_template"), { id: "template", name: "Template" });
  writeTheme(join(managedDir(), ".hidden"), { id: "hidden", name: "Hidden" });
  mkdirSync(join(managedDir(), "no-manifest"), { recursive: true });
  mkdirSync(join(managedDir(), "broken"), { recursive: true });
  writeFileSync(join(managedDir(), "broken", "theme.json"), "{ not json");

  const project = join(home, "outside-project");
  writeTheme(join(project, "themes", "secret"), { id: "secret", name: "Secret" });

  const scan = await scanLocalThemes({ cwd: project, allowedRoots: new Set() });
  assert.deepEqual(scan.themes.map((entry) => entry.name), ["Real"]);
});

test("a project folder is replaced by an empty string when cwd is absent", () => {
  const roots = themeScanRoots({ cwd: null, environment: {} });
  assert.deepEqual(roots.map((root) => root.origin), ["managed"]);
});

/* ---------------------------------------------------------------- import -- */

test("imports a validated theme into the managed directory", async () => {
  const source = writeTheme(join(home, "source-glacier"), { id: "glacier", name: "Glacier", version: "0.4.0" });
  writeFileSync(join(source, "extra.css"), "html[data-pi-theme=custom] {}\n");
  process.env.PI_WEB_THEME_ROOTS = source;

  const result = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(result.source, `local:${join(managedDir(), "glacier")}`);
  assert.equal(result.entry.name, "Glacier");
  assert.equal(result.entry.managed, true);
  assert.ok(existsSync(join(managedDir(), "glacier", "theme.css")));
  assert.ok(existsSync(join(managedDir(), "glacier", "extra.css")));
  // The original stays untouched.
  assert.ok(existsSync(join(source, "theme.css")));
});

test("refuses a theme the server cannot validate, and copies nothing", async () => {
  const source = join(home, "invalid-theme");
  writeTheme(source, { id: "invalid", name: "Invalid" });
  // Unscoped rules are an error: only `html[data-pi-theme="custom"]` may be styled.
  writeFileSync(join(source, "theme.css"), ":root { --bg: #000; }\nbody { color: red; }\n");
  process.env.PI_WEB_THEME_ROOTS = source;

  const result = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(result.error, "invalid_theme");
  assert.equal(existsSync(join(managedDir(), "invalid")), false);
});

test("refuses a directory outside the roots Pi Web may read theme files from", async () => {
  const source = writeTheme(join(home, "untrusted"), { id: "untrusted", name: "Untrusted" });
  const result = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(result.error, "blocked_path");
  assert.equal(existsSync(join(managedDir(), "untrusted")), false);
});

test("refuses a missing directory and a missing manifest", async () => {
  process.env.PI_WEB_THEME_ROOTS = home;
  const missing = await importLocalTheme(join(home, "nope"), { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(missing.error, "not_found");

  mkdirSync(join(home, "manifest-less"), { recursive: true });
  const noManifest = await importLocalTheme(join(home, "manifest-less"), { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(noManifest.error, "not_found");
});

test("refuses a theme with a symbolic link", async () => {
  const source = writeTheme(join(home, "symlinked"), { id: "symlinked", name: "Symlinked" });
  mkdirSync(join(home, "elsewhere"), { recursive: true });
  writeFileSync(join(home, "elsewhere", "outside.css"), "html[data-pi-theme=custom] {}\n");
  symlinkSync(join(home, "elsewhere", "outside.css"), join(source, "linked.css"));
  process.env.PI_WEB_THEME_ROOTS = source;

  const result = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(result.error, "failed");
  assert.match(result.message, /symbolic link/);
  assert.equal(existsSync(join(managedDir(), "symlinked")), false);
});

test("reports an existing import and replaces it only when asked", async () => {
  const source = writeTheme(join(home, "repeatable"), { id: "repeatable", name: "First", version: "1.0.0" });
  process.env.PI_WEB_THEME_ROOTS = source;
  const first = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.ok(!("error" in first));

  const again = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(again.error, "exists");

  // A changed copy replaces the managed one, which is how an update arrives.
  writeTheme(source, { id: "repeatable", name: "Second", version: "2.0.0" });
  const replaced = await importLocalTheme(source, { overwrite: true, agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.ok(!("error" in replaced));
  assert.equal(replaced.entry.name, "Second");
  const manifest = JSON.parse(readFileSync(join(managedDir(), "repeatable", "theme.json"), "utf8"));
  assert.equal(manifest.version, "2.0.0");
});

test("importing the managed copy itself is reported, not copied onto itself", async () => {
  const source = writeTheme(join(managedDir(), "already-managed"), { id: "already-managed", name: "Already" });
  const result = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(result.error, "exists");
  assert.match(result.message, /managed copy/);
});

test("refuses a theme larger than the import limit", async () => {
  const source = writeTheme(join(home, "huge"), { id: "huge", name: "Huge" });
  mkdirSync(join(source, "assets"), { recursive: true });
  // A sparse file keeps the test cheap: only its length matters here.
  writeFileSync(join(source, "assets", "big.bin"), Buffer.alloc(THEME_IMPORT_MAX_BYTES + 1));
  process.env.PI_WEB_THEME_ROOTS = source;

  const result = await importLocalTheme(source, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(result.error, "too_large");
  assert.equal(existsSync(join(managedDir(), "huge")), false);
});

/* ---------------------------------------------------------------- remove -- */

test("removes only a managed theme", async () => {
  const managed = writeTheme(join(managedDir(), "disposable"), { id: "disposable", name: "Disposable" });
  const removed = removeManagedTheme(`local:${managed}`, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(removed.ok, true);
  assert.equal(existsSync(managed), false);

  const project = writeTheme(join(home, "project-theme"), { id: "project-theme", name: "Project theme" });
  const refused = removeManagedTheme(`local:${project}`, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(refused.error, "blocked_path");
  assert.ok(existsSync(project));

  const nested = join(managedDir(), "parent", "child");
  writeTheme(nested, { id: "child", name: "Child" });
  const tooDeep = removeManagedTheme(`local:${nested}`, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(tooDeep.error, "blocked_path");
  assert.ok(existsSync(nested));

  const gone = removeManagedTheme(`local:${join(managedDir(), "absent")}`, { agentDir: process.env.PI_CODING_AGENT_DIR });
  assert.equal(gone.error, "not_found");
});
