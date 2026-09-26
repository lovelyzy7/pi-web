import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDatabase, type PiWebDatabase } from "./db";
import { nodeCliInvocation } from "./node-cli";
import { npmRegistryUrl } from "./npm-registry";

/**
 * The pi agent from the point of view of the Updates section.
 *
 * There are two different things that both get called "pi agent":
 *
 * - The **runtime**: the `@earendil-works/pi-coding-agent` SDK this server runs
 *   sessions with, pinned by the app's own dependencies. It is deliberately not
 *   hot-swapped from the panel — a newer SDK can change session formats and
 *   prompts (pi 0.86 did), so it updates together with the app itself.
 * - The **CLI**: the `pi` command used from a terminal. On a Docker host the
 *   container cannot touch the host, so the panel installs/updates the CLI
 *   **inside the server's data directory** (`~/.pi/agent/pi-cli`, which is the
 *   mounted volume and survives recreates), plus a best-effort symlink into
 *   /usr/local/bin. On a non-container install the server *is* the host, so the
 *   same action updates the host's CLI.
 */

export const PI_LATEST_SUBJECT = "pi-agent:latest";
export const PI_CLI_VERSION_SUBJECT = "pi-agent:cli-version";
export const PI_LATEST_TTL_MS = 6 * 60 * 60 * 1000;
export const PI_CLI_VERSION_TTL_MS = 30 * 60 * 1000;
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type Run = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<RunResult>;

/** execFile, promisified and never routed through a shell. */
export function defaultRun(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const message = error.killed
          ? `The command took longer than ${Math.round(timeoutMs / 1000)}s: ${[command, ...args].join(" ")}`
          : String(stderr || error.message);
        reject(Object.assign(new Error(message), { cause: error }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Where this panel installs the CLI. On a mount this persists across recreates. */
export function piCliDataDir(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-cli");
}

export interface PiCliCandidate {
  via: "path" | "bundled" | "data-dir";
  path: string;
}

/**
 * Where a `pi` executable may live, in the order the panel reports them: the
 * PATH (the host on a non-container install, the container otherwise), the CLI
 * bundled with the app, then the data-directory install this feature manages.
 */
export function piCliCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  agentDir: string = getAgentDir(),
  appDir: string = process.cwd(),
): PiCliCandidate[] {
  const name = process.platform === "win32" ? "pi.cmd" : "pi";
  const candidates: PiCliCandidate[] = [];
  for (const dir of (environment.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push({ via: "path", path: join(dir, name) });
  }
  candidates.push({ via: "bundled", path: join(appDir, "node_modules", ".bin", name) });
  candidates.push({ via: "data-dir", path: join(piCliDataDir(agentDir), "node_modules", ".bin", name) });
  return candidates;
}

/**
 * The SDK version this server runs sessions with.
 *
 * Read from disk by path, like next.config.ts does: the package's `exports`
 * map does not expose `./package.json` to `require.resolve`, so resolving it
 * the normal way would throw for no reason.
 */
export function runtimePiVersion(appDir: string = process.cwd()): string {
  try {
    const manifest = JSON.parse(readFileSync(join(appDir, "node_modules", PI_PACKAGE, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function readCliVersion(
  executable: string,
  run: Run = defaultRun,
  exists: (path: string) => boolean = existsSync,
): Promise<string | null> {
  if (!exists(executable)) return null;
  try {
    const { stdout } = await run(executable, ["--version"], { timeoutMs: 30_000 });
    const version = stdout.split("\n")[0]?.trim();
    return version && /^[0-9]/.test(version) ? version : null;
  } catch {
    return null;
  }
}

export interface PiCliDetection {
  via: "path" | "bundled" | "data-dir" | null;
  path: string | null;
  version: string | null;
}

export async function detectPiCli(options: {
  run?: Run;
  exists?: (path: string) => boolean;
  agentDir?: string;
  appDir?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): Promise<PiCliDetection> {
  const exists = options.exists ?? existsSync;
  for (const candidate of piCliCandidates(options.environment, options.agentDir, options.appDir)) {
    const version = await readCliVersion(candidate.path, options.run, exists);
    if (version !== null) return { via: candidate.via, path: candidate.path, version };
  }
  return { via: null, path: null, version: null };
}

interface PiLatestRow {
  payload: string;
  checked_at: number;
  expires_at: number;
}

/** The latest published SDK version, cached so opening the panel is instant. */
export async function fetchPiLatestVersion(options: {
  registry?: string;
  fetchImpl?: typeof fetch;
  force?: boolean;
  db?: PiWebDatabase;
  now?: number;
  environment?: NodeJS.ProcessEnv;
} = {}): Promise<{ version: string; checkedAt: number; fromCache: boolean } | null> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const registry = options.registry ?? npmRegistryUrl(options.environment);

  const row = db.prepare("SELECT payload, checked_at, expires_at FROM update_checks WHERE subject = ?")
    .get(PI_LATEST_SUBJECT) as PiLatestRow | undefined;
  if (row && row.expires_at > now && !options.force) {
    try {
      const parsed = JSON.parse(row.payload) as { version: string };
      return { version: parsed.version, checkedAt: row.checked_at, fromCache: true };
    } catch {
      // Fall through to the network.
    }
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${registry}/@earendil-works%2fpi-coding-agent/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { version?: unknown };
    const version = typeof body.version === "string" && body.version.trim() ? body.version.trim() : null;
    if (!version) throw new Error("No version in the registry response");
    db.prepare(`
      INSERT INTO update_checks (subject, payload, checked_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET
        payload = excluded.payload, checked_at = excluded.checked_at, expires_at = excluded.expires_at
    `).run(PI_LATEST_SUBJECT, JSON.stringify({ version }), now, now + PI_LATEST_TTL_MS);
    return { version, checkedAt: now, fromCache: false };
  } catch {
    // A stale answer beats a spinner: reuse the cache whatever its age.
    if (row) {
      try {
        const parsed = JSON.parse(row.payload) as { version: string };
        return { version: parsed.version, checkedAt: row.checked_at, fromCache: true };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export interface PiCliInstallResult {
  ok: boolean;
  /** The installed executable. */
  path?: string;
  version?: string | null;
  message?: string;
}

/**
 * Installs/updates the `pi` CLI into `~/.pi/agent/pi-cli`.
 *
 * The data directory is the mounted volume in Docker, so the CLI survives
 * container recreates; a best-effort symlink puts it on PATH for `docker exec`.
 */
export async function installPiCli(options: {
  agentDir?: string;
  registry?: string;
  run?: Run;
  environment?: NodeJS.ProcessEnv;
  /** Where the PATH symlink goes; injectable so tests never touch /usr/local. */
  linkDir?: string;
  /** Invocation builder, injectable for tests. */
  buildInvocation?: (args: string[]) => { command: string; args: string[] };
} = {}): Promise<PiCliInstallResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const dir = piCliDataDir(agentDir);
  const registry = options.registry ?? npmRegistryUrl(options.environment);
  const run = options.run ?? defaultRun;

  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const buildInvocation = options.buildInvocation
    ?? ((args: string[]) => nodeCliInvocation("npm", args));
  const invocation = buildInvocation([
    "install",
    "--prefix",
    dir,
    "--no-audit",
    "--no-fund",
    `--registry=${registry}`,
    `${PI_PACKAGE}@latest`,
  ]);

  try {
    await run(invocation.command, invocation.args, { timeoutMs: 300_000 });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const executable = join(dir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  if (!existsSync(executable)) {
    return { ok: false, message: "The install finished, but no pi executable appeared." };
  }

  // Best effort: make it runnable as `pi` on this server (the container user
  // runs as root; a plain host user cannot write /usr/local/bin and simply
  // gets the real path shown in the panel instead).
  if (process.platform !== "win32" && options.linkDir !== null) {
    const linkDir = options.linkDir ?? "/usr/local/bin";
    const link = join(linkDir, "pi");
    try {
      mkdirSync(linkDir, { recursive: true });
      if (existsSync(link)) unlinkSync(link);
      symlinkSync(executable, link);
    } catch {
      // ignore — the panel reports the real path either way
    }
  }

  const version = await readCliVersion(executable, run);
  return { ok: true, path: executable, version };
}

export interface PiAgentStatus {
  runtime: { version: string; latest: string | null; newer: boolean; checkedAt: number | null };
  cli: PiCliDetection;
  installTarget: string;
}

export async function getPiAgentStatus(options: {
  forceLatest?: boolean;
  fetchImpl?: typeof fetch;
  run?: Run;
  agentDir?: string;
  db?: PiWebDatabase;
  environment?: NodeJS.ProcessEnv;
} = {}): Promise<PiAgentStatus> {
  const runtimeVersion = runtimePiVersion(process.cwd());
  const latest = await fetchPiLatestVersion({
    force: options.forceLatest,
    fetchImpl: options.fetchImpl,
    db: options.db,
    environment: options.environment,
  });
  const cli = await detectPiCli({ run: options.run, agentDir: options.agentDir, environment: options.environment });
  return {
    runtime: {
      version: runtimeVersion,
      latest: latest?.version ?? null,
      newer: latest !== null && latest.version !== runtimeVersion && latest.version !== "unknown",
      checkedAt: latest?.checkedAt ?? null,
    },
    cli,
    installTarget: piCliDataDir(options.agentDir),
  };
}
