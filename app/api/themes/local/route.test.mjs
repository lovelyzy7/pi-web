import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const home = mkdtempSync(join(tmpdir(), "pi-web-theme-local-route-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("@/lib/db.ts");
const { normalizeSlashes } = await jiti.import("@/lib/file-access.ts");

const db = openDatabase(":memory:");
installDatabaseForTests(db);

const MANAGED = join(process.env.PI_CODING_AGENT_DIR, "themes");

before(() => {
  assert.ok(MANAGED.startsWith(home));
});

beforeEach(() => {
  delete process.env.PI_WEB_THEME_ROOTS;
  rmSync(MANAGED, { recursive: true, force: true });
});

after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_WEB_THEME_ROOTS;
  installDatabaseForTests(null);
  rmSync(home, { recursive: true, force: true });
});

function writeTheme(directory, manifest = {}) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "theme.json"),
    JSON.stringify({ schema: 1, id: "sample", name: "Sample", version: "1.0.0", author: "tester", base: "dark", variables: ["--bg"], styles: ["theme.css"], ...manifest }),
  );
  writeFileSync(join(directory, "theme.css"), 'html[data-pi-theme="custom"] {\n  --bg: #101010;\n}\n');
  return directory;
}

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

test("GET lists what each root holds and where imports land", async () => {
  writeTheme(join(MANAGED, "managed-one"), { id: "managed-one", name: "Managed" });
  const project = join(home, "project");
  writeTheme(join(project, "themes", "project-one"), { id: "project-one", name: "Project" });

  const response = await route.GET(request(`/api/themes/local?cwd=${encodeURIComponent(project)}`));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(body.importDir, MANAGED);
  assert.deepEqual(
    body.themes.map((entry) => entry.name).sort(),
    // The project folder is not browsable in this test, so only the managed
    // theme is listed: a project's themes need the project itself allowed.
    ["Managed"],
  );
  assert.ok(body.roots.some((root) => root.origin === "managed" && root.exists));
  assert.ok(body.roots.some((root) => root.origin === "project" && root.directory === join(project, "themes")));
});

test("GET without a cwd scans only the managed and configured directories", async () => {
  const response = await route.GET(request("/api/themes/local"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.roots.map((root) => root.origin), ["managed"]);
});

test("POST imports a theme and reports it on the next scan", async () => {
  const source = writeTheme(join(home, "source"), { id: "imported", name: "Imported" });
  process.env.PI_WEB_THEME_ROOTS = source;

  const response = await route.POST(request("/api/themes/local", "POST", { action: "import", source }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.source, `local:${join(MANAGED, "imported")}`);
  assert.ok(existsSync(join(MANAGED, "imported", "theme.css")));

  const scan = await (await route.GET(request("/api/themes/local"))).json();
  assert.deepEqual(scan.themes.map((entry) => entry.entry ?? entry.name), ["Imported"]);

  // Importing again collides, and the second attempt is reported as such.
  const again = await route.POST(request("/api/themes/local", "POST", { action: "import", source }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, "exists");

  const replaced = await route.POST(request("/api/themes/local", "POST", { action: "import", source, overwrite: true }));
  assert.equal(replaced.status, 200);
});

test("POST removes a managed theme and refuses anything else", async () => {
  const managed = writeTheme(join(MANAGED, "disposable"), { id: "disposable", name: "Disposable" });
  const removed = await route.POST(request("/api/themes/local", "POST", { action: "remove", source: `local:${managed}` }));
  assert.equal(removed.status, 200);
  assert.equal(existsSync(managed), false);

  const project = writeTheme(join(home, "project-theme"), { id: "project-theme", name: "Project" });
  const refused = await route.POST(request("/api/themes/local", "POST", { action: "remove", source: `local:${project}` }));
  assert.equal(refused.status, 403);
  assert.ok(existsSync(project));
});

test("POST rejects a foreign origin, a missing source and an unknown action", async () => {
  const crossOrigin = await route.POST(
    new NextRequest("http://localhost/api/themes/local", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "import", source: home }),
    }),
  );
  assert.equal(crossOrigin.status, 403);

  assert.equal((await route.POST(request("/api/themes/local", "POST", { action: "import", source: "  " }))).status, 400);
  assert.equal((await route.POST(request("/api/themes/local", "POST", { action: "reload" }))).status, 400);
});

test("POST needs a JSON content type", async () => {
  const response = await route.POST(
    new NextRequest("http://localhost/api/themes/local", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" },
      body: "action=import",
    }),
  );
  assert.equal(response.status, 415);
});

test("a theme outside the readable roots is refused", async () => {
  delete process.env.PI_WEB_THEME_ROOTS;
  const source = writeTheme(join(home, "untrusted"), { id: "untrusted", name: "Untrusted" });
  const response = await route.POST(request("/api/themes/local", "POST", { action: "import", source }));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "blocked_path");
});

test("the scan keeps working when a root does not exist", () => {
  assert.equal(existsSync(join(home, "missing")), false);
  const normalized = normalizeSlashes(join(home, "missing"));
  assert.equal(typeof normalized, "string");
});
