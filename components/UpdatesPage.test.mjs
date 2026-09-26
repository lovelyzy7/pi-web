import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");

const pageSource = await readFile(new URL("./UpdatesPage.tsx", import.meta.url), "utf8");
const routeSource = await readFile(new URL("../app/api/updates/pi/route.ts", import.meta.url), "utf8");
const libSource = await readFile(new URL("../lib/pi-agent.ts", import.meta.url), "utf8");

test("the updates section manages the pi agent next to the runtime", () => {
  // The panel asks the new route and can force a fresh "latest" lookup.
  assert.match(pageSource, /\/api\/updates\/pi\$\{check \? "\?check=1" : ""\}/);
  assert.match(pageSource, /void loadPi\(true\)/);
  // Install when there is no CLI, update when there is one.
  assert.match(pageSource, /action: piAgent\?\.cli\?\.path \? "update" : "install"/);
  assert.match(pageSource, /t\("updates\.piCliInstall"\)/);
  assert.match(pageSource, /t\("updates\.piCliUpdate"\)/);
  assert.match(pageSource, /t\("updates\.piCliUpToDate"\)/);
  // The Docker host gets the command the container cannot run for it.
  assert.match(pageSource, /updates\.piHostNote/);
  assert.match(pageSource, /hostCommand/);
});

test("the route installs into the data directory and never touches the runtime", () => {
  assert.match(routeSource, /installPiCli\(\{\}\)/);
  assert.match(routeSource, /getPiAgentStatus\(/);
  assert.match(routeSource, /deploymentInfo\(\)/);
  // The runtime SDK is pinned by the app: the panel explains, the code enforces.
  assert.match(libSource, /it updates together with the app itself/);
  assert.match(libSource, /piCliDataDir/);
  assert.match(libSource, /pi-cli/);
  // No helper exports: route files may only export handlers.
  assert.doesNotMatch(routeSource, /export (function|const) (?!(GET|POST|dynamic))/);
});

test("every updates.pi* key exists in all locales", () => {
  const used = [...pageSource.matchAll(/\bt\("(updates\.pi[A-Za-z]+)"/g)].map((m) => m[1]);
  used.push("updates.piInstalledAt", "updates.piNewer");
  const unique = [...new Set(used)];
  assert.ok(unique.length >= 10, `expected the pi keys, found ${unique.join(", ")}`);
  for (const locale of getSupportedLocales()) {
    for (const key of unique) {
      assert.equal(typeof getLocalePlugin(locale).messages[key], "string", `${locale} is missing ${key}`);
      assert.notEqual(getLocalePlugin(locale).messages[key], "", `${locale}.${key} is empty`);
    }
  }
});
