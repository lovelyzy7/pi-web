import { statSync } from "node:fs";
import { resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";

/**
 * Decides whether a project directory named by the browser may be used.
 *
 * The distinction matters for the settings sections that read both a global and
 * a project scope (skills, plugins, project trust). In a container started with
 * the host's `~/.pi/agent` mounted, the selected project is a host path that does
 * not exist there; refusing the whole request with `403 Access denied` hides the
 * global lists for no reason. A *missing* directory therefore degrades to the
 * global scope while an existing directory outside the readable roots is still
 * refused — that one is a real authorization failure.
 */

export type ProjectCwdStatus = "ok" | "missing" | "not_a_directory" | "not_allowed" | "none";

export interface ProjectCwdResolution {
  status: ProjectCwdStatus;
  /** The directory to use, or null when only the global scope applies. */
  cwd: string | null;
  /** What the browser asked for, for the notice shown in the UI. */
  requested: string | null;
}

export async function resolveProjectCwd(
  requested: string | null | undefined,
  options: { allowedRoots?: Set<string> } = {},
): Promise<ProjectCwdResolution> {
  const trimmed = requested?.trim();
  if (!trimmed) return { status: "none", cwd: null, requested: null };
  const cwd = resolve(trimmed);

  const stats = statSync(cwd, { throwIfNoEntry: false });
  if (!stats) return { status: "missing", cwd: null, requested: cwd };
  if (!stats.isDirectory()) return { status: "not_a_directory", cwd: null, requested: cwd };

  const allowedRoots = options.allowedRoots ?? (await getAllowedFileRoots());
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { status: "not_allowed", cwd: null, requested: cwd };
  }
  return { status: "ok", cwd, requested: cwd };
}

/** The `cwdNotice` a degraded response carries, or nothing when the cwd was fine. */
export function projectCwdNotice(resolution: ProjectCwdResolution): { requested: string; reason: string } | null {
  if (resolution.status === "ok" || resolution.status === "none") return null;
  return { requested: resolution.requested ?? "", reason: resolution.status };
}

/** The HTTP status a refusal deserves; `null` means "carry on with global scope". */
export function projectCwdRefusalStatus(status: ProjectCwdStatus): number | null {
  return status === "not_allowed" ? 403 : null;
}
