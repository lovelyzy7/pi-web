import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { npmRegistryUrl } from "./npm-registry";
import { isNewerStableVersion } from "./app-update";

/**
 * In-container self update.
 *
 * The published `@agegr/pi-web` package already contains the built `.next`, so
 * "updating" is a fresh `npm install` into a versioned directory plus switching a
 * `current` symlink — no compiler, no GitHub, no image rebuild. The container's
 * entrypoint follows that symlink, so the change takes effect on the next start.
 *
 * This is off by default (`PI_WEB_ALLOW_SELF_UPDATE=1`) because it lets the
 * server replace its own code. Three things are checked before anything is
 * written: the target is a stable version, the package still supports this Node
 * major, and the install itself succeeds in a directory that is only linked into
 * place afterwards. The previous release stays on disk for a manual rollback.
 */

export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface SelfUpdatePlan {
  currentVersion: string;
  targetVersion: string;
  releasesDirectory: string;
  targetDirectory: string;
  currentLink: string;
  requiredNode: string | null;
  nodeCompatible: boolean;
  registry: string;
  /** Set when the plan cannot be executed, with the reason to show the operator. */
  blockedReason?: string;
}

export function defaultReleasesDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.PI_WEB_RELEASES_DIR?.trim() || "/opt/pi-web-releases";
}

/** `>=22.19.0` / `^22.0.0` / `22.x` → the numeric floor, or null for a range we ignore. */
export function parseNodeFloor(range: string | null | undefined): [number, number, number] | null {
  if (!range) return null;
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function satisfiesNode(range: string | null | undefined, version: string): boolean {
  const floor = parseNodeFloor(range);
  if (!floor) return true;
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!current) return false;
  const parts = [Number(current[1]), Number(current[2]), Number(current[3])];
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] > floor[index]) return true;
    if (parts[index] < floor[index]) return false;
  }
  return true;
}

interface RegistryVersion {
  version: string;
  engines?: { node?: string };
}

async function fetchRegistryVersion(
  version: string | "latest",
  registry: string,
): Promise<RegistryVersion | null> {
  try {
    const response = await fetch(`${registry}/@agegr%2Fpi-web/${version}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown; engines?: { node?: unknown } };
    if (typeof body.version !== "string" || !RELEASE_VERSION_PATTERN.test(body.version)) return null;
    return {
      version: body.version,
      engines: typeof body.engines?.node === "string" ? { node: body.engines.node } : undefined,
    };
  } catch {
    return null;
  }
}

export interface PlanOptions {
  target?: string;
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  currentVersion?: string;
}

export async function planSelfUpdate(options: PlanOptions = {}): Promise<SelfUpdatePlan | null> {
  const environment = options.environment ?? process.env;
  const registry = npmRegistryUrl(environment);
  const releasesDirectory = defaultReleasesDirectory(environment);
  const currentVersion = options.currentVersion ?? environment.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

  const requested = options.target?.trim() ?? "latest";
  if (requested !== "latest" && !RELEASE_VERSION_PATTERN.test(requested)) return null;

  const published = await fetchRegistryVersion(requested === "latest" ? "latest" : requested, registry);
  if (!published) return null;

  const targetDirectory = join(releasesDirectory, published.version);
  const requiredNode = published.engines?.node ?? null;
  const nodeCompatible = satisfiesNode(requiredNode, options.nodeVersion ?? process.version);

  const blockedReason = nodeCompatible
    ? undefined
    : `Pi Web ${published.version} requires Node ${requiredNode}; this container runs ${options.nodeVersion ?? process.version}. Rebuild the image with a newer Node.`;

  return {
    currentVersion,
    targetVersion: published.version,
    releasesDirectory,
    targetDirectory,
    currentLink: join(releasesDirectory, "current"),
    requiredNode,
    nodeCompatible,
    registry,
    blockedReason,
  };
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  output: string;
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      // Keep the tail: a failed npm install prints the reason last.
      output = (output + chunk.toString()).slice(-8_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `${output}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: output.trim() });
    });
  });
}

export interface SelfUpdateResult {
  ok: boolean;
  version?: string;
  path?: string;
  restartRequired?: boolean;
  message?: string;
  output?: string;
}

/** Already-installed releases, newest first, for the rollback list in the UI. */
export function listInstalledReleases(directory = defaultReleasesDirectory()): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RELEASE_VERSION_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => (isNewerStableVersion(left, right) ? -1 : 1));
  } catch {
    return [];
  }
}

/**
 * Installs the planned version and points `current` at it. Only the final symlink
 * swap is destructive, and it happens after the install has already succeeded, so
 * a failed download leaves the running version untouched.
 */
export async function applySelfUpdate(plan: SelfUpdatePlan): Promise<SelfUpdateResult> {
  if (plan.blockedReason) return { ok: false, message: plan.blockedReason };

  try {
    mkdirSync(plan.releasesDirectory, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      message: `Cannot create ${plan.releasesDirectory}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!existsSync(join(plan.targetDirectory, "package.json"))) {
    rmSync(plan.targetDirectory, { recursive: true, force: true });
    const install = await run("npm", [
      "install",
      "--prefix", plan.targetDirectory,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--registry", plan.registry,
      `@agegr/pi-web@${plan.targetVersion}`,
    ]);
    if (!install.ok) {
      rmSync(plan.targetDirectory, { recursive: true, force: true });
      return {
        ok: false,
        message: `npm install failed (exit ${install.code ?? "signal"})`,
        output: install.output,
      };
    }
  }

  const installed = join(plan.targetDirectory, "node_modules", "@agegr", "pi-web");
  if (!existsSync(join(installed, "package.json"))) {
    return { ok: false, message: "The installed package is missing its entry point." };
  }

  try {
    rmSync(plan.currentLink, { recursive: true, force: true });
    symlinkSync(installed, plan.currentLink, "dir");
  } catch (error) {
    return {
      ok: false,
      message: `Installed ${plan.targetVersion}, but could not switch the current release: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, version: plan.targetVersion, path: installed, restartRequired: true };
}

/**
 * Drops the `current` link, so the next start uses the build baked into the image.
 * The released directories stay on disk and can be switched back to.
 */
export function switchToImageBuild(directory = defaultReleasesDirectory()): { ok: boolean; message?: string } {
  const link = join(directory, "current");
  try {
    rmSync(link, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** True when a self-updated release is what the entrypoint would start. */
export function hasCurrentRelease(directory = defaultReleasesDirectory()): boolean {
  return existsSync(join(directory, "current", "package.json"));
}

/** Points `current` back at a release that is already on disk. */
export function rollbackTo(version: string, directory = defaultReleasesDirectory()): SelfUpdateResult {
  if (!RELEASE_VERSION_PATTERN.test(version)) return { ok: false, message: "Not a release version." };
  const installed = join(directory, version, "node_modules", "@agegr", "pi-web");
  if (!existsSync(join(installed, "package.json"))) {
    return { ok: false, message: `Release ${version} is not installed.` };
  }
  try {
    const link = join(directory, "current");
    rmSync(link, { recursive: true, force: true });
    symlinkSync(installed, link, "dir");
    return { ok: true, version, path: installed, restartRequired: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Removes every release except the newest few; keeps a rollback target. */
export function pruneReleases(directory = defaultReleasesDirectory(), keep = 3): string[] {
  const removed: string[] = [];
  for (const version of listInstalledReleases(directory).slice(keep)) {
    try {
      rmSync(join(directory, version), { recursive: true, force: true });
      removed.push(version);
    } catch {
      // A release that cannot be removed is only wasted disk space.
    }
  }
  return removed;
}
