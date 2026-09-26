import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const home = mkdtempSync(join(tmpdir(), "pi-web-theme-preview-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");
process.env.PI_WEB_THEME_ROOTS = join(home, "themes");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
mkdirSync(process.env.PI_WEB_THEME_ROOTS, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const route = await jiti.import("./route.ts");
const { installDatabaseForTests, openDatabase } = await jiti.import("@/lib/db.ts");
installDatabaseForTests(openDatabase(":memory:"));

before(() => {
  assert.ok(process.env.PI_CODING_AGENT_DIR.startsWith(home));
});

beforeEach(() => {
  rmSync(join(process.env.PI_WEB_THEME_ROOTS, "broken"), { recursive: true, force: true });
});

after(() => {
  installDatabaseForTests(null);
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_WEB_THEME_ROOTS;
  rmSync(home, { recursive: true, force: true });
});

function writeTheme(name, css) {
  const directory = join(process.env.PI_WEB_THEME_ROOTS, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "theme.json"), JSON.stringify({
    schema: 1, id: name, name, version: "1.0.0", author: "tester", base: "dark",
    variables: ["--bg"], styles: ["theme.css"],
  }));
  writeFileSync(join(directory, "theme.css"), css);
  return directory;
}

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", "Sec-Fetch-Site": "same-origin", ...headers },
  });
}

test("a valid source is remembered in a cookie and the browser is sent home", async () => {
  const directory = writeTheme("valid", 'html[data-pi-theme="custom"] { --bg: #101010; }\n');
  const response = await route.GET(request(`/api/themes/preview?source=${encodeURIComponent(`local:${directory}`)}`));

  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/");
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /pi-web-theme-preview=/);
  // The guard has to be able to clear it from the page.
  assert.doesNotMatch(cookie, /HttpOnly/i);
  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /Path=\//);
});

test("a theme that cannot be read fails in the tab instead of redirecting", async () => {
  const directory = writeTheme("broken", ":root { --bg: #101010; }\n");
  const response = await route.GET(request(`/api/themes/preview?source=${encodeURIComponent(`local:${directory}`)}`));

  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const body = await response.text();
  assert.match(body, /Theme preview failed/);
  assert.match(body, /html\[data-pi-theme=&quot;custom&quot;\]|html/);
  // Nothing was remembered, so the interface stays exactly as it was.
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a missing directory is reported as unreachable", async () => {
  const response = await route.GET(request(`/api/themes/preview?source=${encodeURIComponent(`local:${join(home, "gone")}`)}`));
  assert.equal(response.status, 403, "a path outside the readable roots never resolves");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a source outside the readable roots is refused", async () => {
  const response = await route.GET(request(`/api/themes/preview?source=${encodeURIComponent("local:/etc")}`));
  assert.equal(response.status, 403);
  assert.match(await response.text(), /not allowed/i);
});

test("off=1 clears the cookie", async () => {
  const response = await route.GET(request("/api/themes/preview?off=1"));
  assert.equal(response.status, 307);
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /pi-web-theme-preview=;/);
  assert.match(cookie, /Max-Age=0/);
});

test("a cross-site request is rejected", async () => {
  const directory = writeTheme("valid", 'html[data-pi-theme="custom"] { --bg: #101010; }\n');
  const response = await route.GET(
    new NextRequest(`http://localhost/api/themes/preview?source=${encodeURIComponent(`local:${directory}`)}`, {
      headers: { Host: "localhost", Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" },
    }),
  );
  assert.equal(response.status, 403);
});
