import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = join(process.cwd(), "bin", "pi-web-theme.js");

async function check(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("accepts the shipped template", async () => {
  const result = await check(["check", "themes/_template"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /No problems found/);
  assert.match(result.stdout, /Overrides 15 theme variable/);
});

test("reports an unscoped stylesheet as an error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-cli-"));
  try {
    writeFileSync(join(directory, "theme.json"), JSON.stringify({
      schema: 1, id: "broken", name: "Broken", base: "dark",
    }));
    writeFileSync(join(directory, "theme.css"), "body { --bg: #000; }");

    const result = await check(["check", directory]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /error: Every selector must start/);

    const json = await check(["check", directory, "--json"]);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.errors.length, 1);
    assert.equal(report.manifest.id, "broken");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checks declared variant stylesheets as part of the theme", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-cli-"));
  try {
    writeFileSync(join(directory, "theme.json"), JSON.stringify({
      schema: 1, id: "variants", name: "Variants", base: "light",
      variants: { dark: "theme.dark.css" },
    }));
    writeFileSync(join(directory, "theme.css"), 'html[data-pi-theme="custom"] { --bg: #fff; }');

    const missing = await check(["check", directory]);
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /Missing stylesheet: theme\.dark\.css/);

    writeFileSync(join(directory, "theme.dark.css"), 'html[data-pi-theme="custom"] { --bg: #0e0d0a; }');
    const ok = await check(["check", directory]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /Overrides 1 theme variable/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports a missing manifest or stylesheet without crashing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-cli-"));
  try {
    const missingManifest = await check(["check", directory]);
    assert.equal(missingManifest.code, 1);
    assert.match(missingManifest.stderr, /No theme\.json/);

    writeFileSync(join(directory, "theme.json"), JSON.stringify({ schema: 1, id: "x", name: "X", base: "light" }));
    const missingCss = await check(["check", directory]);
    assert.equal(missingCss.code, 1);
    assert.match(missingCss.stdout, /Missing stylesheet/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prints usage for --help and refuses unknown commands", async () => {
  const help = await check(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: pi-web-theme check/);

  const unknown = await check(["validate"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown command/);
});
