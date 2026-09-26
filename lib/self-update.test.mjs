import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const {
  satisfiesNode, parseNodeFloor, defaultReleasesDirectory, listInstalledReleases,
  rollbackTo, pruneReleases, switchToImageBuild, hasCurrentRelease, RELEASE_VERSION_PATTERN,
} = await jiti.import("./self-update.ts");
const { deploymentMode, deploymentInfo } = await jiti.import("./app-update-service.ts");

const root = mkdtempSync(join(tmpdir(), "pi-web-selfupdate-"));
after(() => rmSync(root, { recursive: true, force: true }));

function installRelease(directory, version) {
  const packageDir = join(directory, version, "node_modules", "@agegr", "pi-web");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version }));
}

test("compares Node versions against an engines range", () => {
  assert.deepEqual(parseNodeFloor(">=22.19.0"), [22, 19, 0]);
  assert.deepEqual(parseNodeFloor("^22.0.0"), [22, 0, 0]);
  assert.equal(parseNodeFloor(null), null);
  assert.equal(parseNodeFloor("latest"), null);

  assert.equal(satisfiesNode(">=22.19.0", "v22.19.0"), true);
  assert.equal(satisfiesNode(">=22.19.0", "v22.20.1"), true);
  assert.equal(satisfiesNode(">=22.19.0", "v22.18.0"), false);
  assert.equal(satisfiesNode(">=22.19.0", "v21.9.9"), false);
  assert.equal(satisfiesNode(undefined, "v18.0.0"), true, "no requirement cannot block an update");
  assert.equal(satisfiesNode("garbage", "v18.0.0"), true);
});

test("lists installed releases newest first and ignores foreign files", () => {
  const directory = join(root, "releases-list");
  for (const version of ["0.9.3", "0.10.0", "0.9.11"]) installRelease(directory, version);
  mkdirSync(join(directory, "not-a-version"), { recursive: true });
  writeFileSync(join(directory, "current"), "");

  assert.deepEqual(listInstalledReleases(directory), ["0.10.0", "0.9.11", "0.9.3"]);
  assert.deepEqual(listInstalledReleases(join(root, "missing")), []);
});

test("rollback points current at an installed release and refuses anything else", () => {
  const directory = join(root, "releases-rollback");
  installRelease(directory, "0.9.3");
  installRelease(directory, "0.10.0");

  assert.equal(rollbackTo("0.9.3", directory).ok, true);
  assert.equal(rollbackTo("0.9.3", directory).version, "0.9.3");
  assert.equal(rollbackTo("../../etc", directory).ok, false);
  assert.equal(rollbackTo("1.2.3", directory).ok, false, "not installed");
  assert.equal(rollbackTo("main", directory).ok, false);
});

test("pruning keeps the newest releases for rollback", () => {
  const directory = join(root, "releases-prune");
  for (const version of ["0.9.1", "0.9.2", "0.9.3", "0.10.0"]) installRelease(directory, version);

  assert.deepEqual(pruneReleases(directory, 2), ["0.9.2", "0.9.1"]);
  assert.deepEqual(listInstalledReleases(directory), ["0.10.0", "0.9.3"]);
  assert.deepEqual(pruneReleases(directory, 5), []);
});

test("the image build can be restored after a self-update", () => {
  const directory = join(root, "releases-image");
  installRelease(directory, "1.0.0");
  assert.equal(hasCurrentRelease(directory), false);

  assert.equal(rollbackTo("1.0.0", directory).ok, true);
  assert.equal(hasCurrentRelease(directory), true);

  assert.equal(switchToImageBuild(directory).ok, true);
  assert.equal(hasCurrentRelease(directory), false);
  // The release stays on disk, so switching back is still possible.
  assert.deepEqual(listInstalledReleases(directory), ["1.0.0"]);
  assert.equal(switchToImageBuild(join(root, "missing-dir")).ok, true, "removing an absent link is a no-op");
});

test("release versions must be stable triples", () => {
  for (const version of ["0.9.3", "10.0.1"]) assert.equal(RELEASE_VERSION_PATTERN.test(version), true, version);
  for (const version of ["0.9", "1.0.0-beta.1", "latest", "=1.0.0", "../x"]) {
    assert.equal(RELEASE_VERSION_PATTERN.test(version), false, version);
  }
});

test("detects how the server was deployed", () => {
  assert.equal(deploymentMode({}, "/usr/local/bin/pi-web", true), "docker");
  assert.equal(deploymentMode({}, "/usr/local/lib/node_modules/@agegr/pi-web/bin/pi-web.js", false), "npm");
  assert.equal(deploymentMode({}, "/home/me/pi-web/bin/pi-web.js", false), "source");
  assert.equal(deploymentMode({ PI_WEB_DEPLOYMENT: "source" }, "", true), "source");
  assert.equal(deploymentMode({ PI_WEB_DEPLOYMENT: "nonsense" }, "/home/me/pi-web/bin/pi-web.js", false), "source");
});

test("deployment info carries the instructions for each mode and the self-update switch", () => {
  const docker = deploymentInfo({ environment: {}, hasDockerMarker: true });
  assert.equal(docker.mode, "docker");
  assert.equal(docker.selfUpdateEnabled, false);
  assert.ok(docker.instructions.some((line) => line.includes("docker build")));

  const enabled = deploymentInfo({ environment: { PI_WEB_ALLOW_SELF_UPDATE: "1" }, hasDockerMarker: true });
  assert.equal(enabled.selfUpdateEnabled, true);
  assert.equal(enabled.selfUpdateAvailable, true);
  assert.match(enabled.releasesDirectory, /pi-web-releases/);

  const source = deploymentInfo({ environment: {}, entry: "/home/me/pi-web/bin/pi-web.js" });
  assert.equal(source.mode, "source");
  assert.ok(source.instructions.some((line) => line.includes("npm run build")));

  const npm = deploymentInfo({ environment: {}, entry: "/usr/lib/node_modules/@agegr/pi-web/bin/pi-web.js" });
  assert.equal(npm.mode, "npm");
  assert.equal(npm.selfUpdateAvailable, false, "a global npm install is updated by npm, not by this server");
});

test("the releases directory follows the environment", () => {
  assert.equal(defaultReleasesDirectory({ PI_WEB_RELEASES_DIR: "/srv/releases/" }), "/srv/releases/");
  assert.equal(defaultReleasesDirectory({}), "/opt/pi-web-releases");
});
