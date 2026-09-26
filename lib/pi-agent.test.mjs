import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

const home = mkdtempSync(join(tmpdir(), "pi-web-pi-agent-"));
process.env.PI_CODING_AGENT_DIR = join(home, "agent");

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const {
  defaultRun,
  detectPiCli,
  fetchPiLatestVersion,
  getPiAgentStatus,
  installPiCli,
  piCliCandidates,
  piCliDataDir,
  readCliVersion,
  runtimePiVersion,
} = await jiti.import("./pi-agent.ts");
const { openDatabase, installDatabaseForTests } = await jiti.import("./db.ts");
const db = openDatabase(":memory:");
installDatabaseForTests(db);

const FAKE_PI = join(home, "bin", "pi");
const FAKE_APP_PI = join(home, "app", "node_modules", ".bin", "pi");
const FAKE_DATA_PI = join(piCliDataDir(), "node_modules", ".bin", "pi");

before(() => {
  for (const path of [FAKE_PI, FAKE_APP_PI, FAKE_DATA_PI]) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "fake pi executable");
  }
});

after(() => {
  installDatabaseForTests(null);
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
});

const fakeRun = (version) => async (command, args, options) => {
  assert.ok(Array.isArray(args), "spawned with argv, never through a shell");
  if (args.includes("--version")) return { stdout: `${version}\n`, stderr: "" };
  return { stdout: "", stderr: "" };
};

test("candidates cover PATH, the bundled CLI and the data-directory install", () => {
  const env = { PATH: ["/one", "/two"].join(delimiter) };
  const candidates = piCliCandidates(env, process.env.PI_CODING_AGENT_DIR, join(home, "app"));
  assert.deepEqual(candidates.map((c) => c.via), ["path", "path", "bundled", "data-dir"]);
  assert.equal(candidates[0].path, join("/one", "pi"));
  assert.equal(candidates[2].path, join(home, "app", "node_modules", ".bin", "pi"));
  assert.equal(candidates[3].path, join(process.env.PI_CODING_AGENT_DIR, "pi-cli", "node_modules", ".bin", "pi"));
});

test("reads a version from the first executable that answers", async () => {
  const exists = (path) => path === FAKE_PI;
  const run = fakeRun("0.88.0");
  assert.equal(await readCliVersion(FAKE_PI, run, exists), "0.88.0");
  assert.equal(await readCliVersion(FAKE_PI, run, () => false), null);

  const detection = await detectPiCli({ run, exists, agentDir: process.env.PI_CODING_AGENT_DIR, environment: { PATH: join(home, "bin") } });
  assert.deepEqual(detection, { via: "path", path: FAKE_PI, version: "0.88.0" });

  const missing = await detectPiCli({ run, exists: () => false, environment: { PATH: "" } });
  assert.deepEqual(missing, { via: null, path: null, version: null });
});

test("a CLI that cannot answer is reported as not installed", async () => {
  const exists = (path) => path === FAKE_APP_PI;
  const detection = await detectPiCli({
    run: async () => { throw new Error("crash"); },
    exists,
    appDir: join(home, "app"),
    environment: { PATH: "/nonexistent" },
  });
  assert.equal(detection.path, null);
});

test("the runtime version is the SDK this server bundles", () => {
  const version = runtimePiVersion(process.cwd());
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(runtimePiVersion("/does/not/exist"), "unknown");
});

test("the latest version is cached and only re-fetched when asked", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const first = await fetchPiLatestVersion({ fetchImpl, db, now: Date.now() });
  assert.equal(first.version, "9.9.9");
  assert.equal(first.fromCache, false);

  const cached = await fetchPiLatestVersion({ fetchImpl, db, now: Date.now() + 1000 });
  assert.equal(cached.version, "9.9.9");
  assert.equal(cached.fromCache, true);
  assert.equal(calls, 1, "the network is not hit again");

  // A failed re-check reuses the cache instead of failing the panel.
  const stale = await fetchPiLatestVersion({ fetchImpl: async () => { throw new Error("offline"); }, db, force: true, now: Date.now() });
  assert.equal(stale.version, "9.9.9");
  assert.equal(stale.fromCache, true);
});

test("installing builds the exact npm invocation and reports the result", async () => {
  const captured = [];
  const run = async (command, args) => {
    captured.push({ command, args });
    return { stdout: "", stderr: "" };
  };
  // Make the install "work": the executable has to exist afterwards.
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "pi-cli", "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "pi-cli", "node_modules", ".bin", "pi"), "fake");

  const result = await installPiCli({
    agentDir: process.env.PI_CODING_AGENT_DIR,
    registry: "https://registry.example",
    run,
    linkDir: join(home, "links"),
    buildInvocation: (args) => ({ command: "npm-cli", args }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, null, "a fake executable cannot answer --version");
  assert.equal(captured.length, 2, "install + version probe");
  assert.equal(captured[0].command, "npm-cli");
  assert.deepEqual(captured[0].args, [
    "install",
    "--prefix",
    join(process.env.PI_CODING_AGENT_DIR, "pi-cli"),
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.example",
    "@earendil-works/pi-coding-agent@latest",
  ]);
  // The symlink landed in the injectable directory, not /usr/local/bin.
  assert.ok(existsSync(join(home, "links", "pi")));
});

test("a failing install reports the failure instead of pretending", async () => {
  const result = await installPiCli({
    agentDir: process.env.PI_CODING_AGENT_DIR,
    run: async () => { throw new Error("registry down"); },
    linkDir: join(home, "links"),
    buildInvocation: (args) => ({ command: "npm-cli", args }),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /registry down/);
});

test("getPiAgentStatus puts it together, runtime latest included", async () => {
  const status = await getPiAgentStatus({
    fetchImpl: async () => new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 }),
    db,
    run: fakeRun("0.87.1"),
    agentDir: process.env.PI_CODING_AGENT_DIR,
    environment: { PATH: join(home, "bin") },
  });
  assert.match(status.runtime.version, /^\d+\.\d+\.\d+$/);
  assert.equal(status.runtime.latest, "9.9.9");
  assert.equal(status.runtime.newer, true);
  assert.equal(status.cli.via, "path");
  assert.equal(status.cli.version, "0.87.1");
  assert.ok(status.installTarget.endsWith("pi-cli"));
});

test("defaultRun reports timeouts in words, not as a bare signal", async () => {
  // A command that sleeps past its timeout: execFile kills it with SIGTERM.
  const slow = join(home, "slow.sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 5\n");
  const run = await import("node:child_process").then(({ execFile }) => new Promise((resolve, reject) => {
    execFile("chmod", ["+x", slow], (error) => (error ? reject(error) : resolve()));
  }));
  await run;
  const error = await defaultRun(slow, [], { timeoutMs: 500 }).then(
    () => null,
    (cause) => cause,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /longer than 0s|longer than 1s/);
});
