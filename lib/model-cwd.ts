/**
 * Chooses the directory `/api/models` loads its project settings from.
 *
 * The requested cwd comes from the browser: it is the selected project, which
 * in turn comes from a session file. That path may not exist on the machine
 * answering the request — the common case is a container started with the host's
 * `~/.pi/agent` mounted, where sessions remember paths like
 * `/home/me/project` that the image never sees. Failing the whole request then
 * turns into "Model error: Directory does not exist: …" in the composer and no
 * model list at all, which hides a broken *mount* behind a broken *model*.
 *
 * So a stale path degrades instead of failing: the model list loads from a
 * directory that does exist, and the response carries a notice the UI shows.
 * Starting an agent in that session still refuses — a run needs a real working
 * directory — but that error is reported as `cwd_missing`, not as a model fault.
 */

export type ModelCwdReason = "missing" | "not_a_directory" | "not_allowed";

export interface ModelCwdNotice {
  /** The directory the browser asked for. */
  requested: string;
  /** The directory the model list was actually loaded from. */
  used: string;
  reason: ModelCwdReason;
}

export interface ModelCwdResolution {
  cwd: string;
  notice: ModelCwdNotice | null;
}

export interface ModelCwdProbe {
  /** True when the path exists. */
  exists: (path: string) => boolean;
  /** True when the path exists and is a directory. */
  isDirectory: (path: string) => boolean;
  /** True when the file-access rules allow the path. */
  isAllowed: (path: string) => boolean;
  /** Roots that may be used as a fallback, in preference order. */
  candidates: string[];
}

function firstDirectory(probe: ModelCwdProbe, paths: Iterable<string>): string | null {
  for (const path of paths) {
    if (path && probe.isDirectory(path)) return path;
  }
  return null;
}

/**
 * @returns the cwd to load from, plus a notice when it is not the requested one.
 */
export function resolveModelCwd(requested: string | null, probe: ModelCwdProbe): ModelCwdResolution {
  // Candidates are in preference order and the caller puts a path that always
  // exists (the process working directory) last, so "none of them exists" still
  // ends on something loadable rather than on another missing directory.
  const fallback = firstDirectory(probe, probe.candidates) ?? probe.candidates.at(-1) ?? "";

  if (!requested) return { cwd: fallback, notice: null };
  if (probe.isDirectory(requested)) {
    return probe.isAllowed(requested)
      ? { cwd: requested, notice: null }
      : { cwd: fallback, notice: { requested, used: fallback, reason: "not_allowed" } };
  }

  return {
    cwd: fallback,
    notice: {
      requested,
      used: fallback,
      reason: probe.exists(requested) ? "not_a_directory" : "missing",
    },
  };
}

/** The human-readable half of a notice, for logs and non-UI callers. */
export function modelCwdNoticeMessage(notice: ModelCwdNotice): string {
  if (notice.reason === "not_a_directory") {
    return `Not a directory: ${notice.requested} (using ${notice.used})`;
  }
  if (notice.reason === "not_allowed") {
    return `Directory is not readable by Pi Web: ${notice.requested} (using ${notice.used})`;
  }
  return `Directory does not exist: ${notice.requested} (using ${notice.used})`;
}
