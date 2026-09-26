import { existsSync } from "node:fs";
import { getDatabase, type PiWebDatabase } from "./db";
import { getPiWebReleaseUrl, isNewerStableVersion } from "./app-update";
import { npmRegistryUrl } from "./npm-registry";

/**
 * Update checks for Pi Web itself.
 *
 * The result used to live in `globalThis`, so every restart re-queried npm and a
 * page load could wait on the network. It is a row in `update_checks` now: one
 * check per TTL, served from disk afterwards, and a manual "check now" that skips
 * the TTL on purpose.
 */

export const UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_FETCH_TIMEOUT_MS = 8_000;
const SUBJECT = "pi-web";

export type DeploymentMode = "docker" | "npm" | "source";

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  checkedAt: number;
  fromCache: boolean;
  /** True when `PI_WEB_SKIP_VERSION_CHECK=1` and the caller did not force a check. */
  disabled: boolean;
  /** True whenever automatic checks are switched off, cache or not. */
  autoCheckDisabled: boolean;
  registry: string;
  error?: string;
}

declare global {
  var __piWebAppUpdateInFlight: Promise<AppUpdateStatus> | undefined;
}

function currentVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
}

interface CacheRow {
  payload: string;
  checked_at: number;
  expires_at: number;
}

function readCache(db: PiWebDatabase): { status: AppUpdateStatus; expiresAt: number } | null {
  const row = db.prepare("SELECT payload, checked_at, expires_at FROM update_checks WHERE subject = ?")
    .get(SUBJECT) as CacheRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as AppUpdateStatus;
    return { status: { ...parsed, fromCache: true }, expiresAt: row.expires_at };
  } catch {
    return null;
  }
}

function writeCache(status: AppUpdateStatus, db: PiWebDatabase, expiresAt: number): void {
  db.prepare(`
    INSERT INTO update_checks (subject, payload, checked_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET
      payload = excluded.payload, checked_at = excluded.checked_at, expires_at = excluded.expires_at
  `).run(SUBJECT, JSON.stringify(status), status.checkedAt, expiresAt);
}

async function fetchLatest(registry: string): Promise<{ version: string; releaseUrl: string }> {
  const response = await fetch(`${registry}/@agegr%2Fpi-web/latest`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`registry returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const version = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiWebReleaseUrl(version);
  if (!releaseUrl) throw new Error("registry returned an invalid version");
  return { version, releaseUrl };
}

export interface AppUpdateOptions {
  force?: boolean;
  db?: PiWebDatabase;
  now?: number;
  environment?: NodeJS.ProcessEnv;
}

export async function getAppUpdateStatus(options: AppUpdateOptions = {}): Promise<AppUpdateStatus> {
  const db = options.db ?? getDatabase();
  const now = options.now ?? Date.now();
  const environment = options.environment ?? process.env;
  const registry = npmRegistryUrl(environment);
  const current = currentVersion();
  const skip = environment.PI_WEB_SKIP_VERSION_CHECK === "1";

  const cached = readCache(db);
  if (cached && !options.force && cached.expiresAt > now) {
    return { ...cached.status, autoCheckDisabled: skip };
  }

  if (skip && !options.force) {
    return {
      currentVersion: current,
      latestVersion: current,
      updateAvailable: false,
      releaseUrl: "",
      checkedAt: cached?.status.checkedAt ?? 0,
      fromCache: Boolean(cached),
      disabled: true,
      autoCheckDisabled: true,
      registry,
    };
  }

  // Concurrent callers (two tabs, or the banner and the updates page) share one
  // request instead of racing over the same cache row.
  const inFlight = globalThis.__piWebAppUpdateInFlight ??= (async () => {
    try {
      const latest = await fetchLatest(registry);
      const status: AppUpdateStatus = {
        currentVersion: current,
        latestVersion: latest.version,
        updateAvailable: isNewerStableVersion(latest.version, current),
        releaseUrl: latest.releaseUrl,
        checkedAt: now,
        fromCache: false,
        disabled: false,
        autoCheckDisabled: skip,
        registry,
      };
      writeCache(status, db, now + UPDATE_CHECK_TTL_MS);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed check keeps the previous answer and records when it was taken,
      // so the page can say "checked N hours ago" instead of claiming an error.
      const status: AppUpdateStatus = cached
        ? { ...cached.status, checkedAt: cached.status.checkedAt, fromCache: true, autoCheckDisabled: skip, error: message }
        : {
            currentVersion: current,
            latestVersion: current,
            updateAvailable: false,
            releaseUrl: "",
            checkedAt: now,
            fromCache: false,
            disabled: false,
            autoCheckDisabled: skip,
            registry,
            error: message,
          };
      writeCache(status, db, now + 60 * 60 * 1000);
      return status;
    } finally {
      globalThis.__piWebAppUpdateInFlight = undefined;
    }
  })();

  return inFlight;
}

/**
 * How this build is deployed, which decides what an update actually looks like.
 * `/.dockerenv` is created by Docker; the argv check distinguishes a global npm
 * install from a checkout.
 */
export function deploymentMode(
  environment: NodeJS.ProcessEnv = process.env,
  entry = process.argv[1] ?? "",
  hasDockerMarker = existsSync("/.dockerenv"),
): DeploymentMode {
  const configured = environment.PI_WEB_DEPLOYMENT?.trim().toLowerCase();
  if (configured === "docker" || configured === "npm" || configured === "source") return configured;
  if (hasDockerMarker) return "docker";
  return /node_modules[\\/]@agegr[\\/]pi-web/.test(entry) ? "npm" : "source";
}

export interface DeploymentInfo {
  mode: DeploymentMode;
  /** True when the running build can replace itself in place. */
  selfUpdateAvailable: boolean;
  selfUpdateEnabled: boolean;
  releasesDirectory: string;
  instructions: string[];
}

export function deploymentInfo(options: {
  environment?: NodeJS.ProcessEnv;
  entry?: string;
  hasDockerMarker?: boolean;
} = {}): DeploymentInfo {
  const environment = options.environment ?? process.env;
  const mode = deploymentMode(environment, options.entry, options.hasDockerMarker);
  const selfUpdateEnabled = environment.PI_WEB_ALLOW_SELF_UPDATE === "1";

  const instructions = mode === "docker"
    ? [
        "# on the host: rebuild and recreate the container",
        "cd <pi-web checkout> && git pull",
        "docker build -t pi-web:latest .",
        "docker rm -f pi-web && docker run -d --name pi-web --restart unless-stopped \\",
        "  --network 1panel-network -v /root/.pi/agent:/root/.pi/agent pi-web:latest",
      ]
    : mode === "npm"
      ? ["npm install -g @agegr/pi-web@latest", "# then restart the pi-web process"]
      : ["git pull", "npm ci", "npm run build", "# then restart the pi-web process"];

  return {
    mode,
    selfUpdateAvailable: mode !== "npm",
    selfUpdateEnabled,
    releasesDirectory: environment.PI_WEB_RELEASES_DIR?.trim() || "/opt/pi-web-releases",
    instructions,
  };
}
