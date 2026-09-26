/**
 * The notice a settings section shows when the selected project directory is
 * not on this machine — a container started with the host's sessions but
 * without that project mounted.
 *
 * It is a *notice*, not an error: the global scope (agent directory, installed
 * packages) is still listed, and every reader of the field keeps working. The
 * wording lives in `settings.cwdNotice` so the skills and plugins sections say
 * the same thing, and `reason` stays machine-readable for logs and tests.
 */
export interface CwdNotice {
  /** The directory the browser asked for. */
  requested: string;
  /** `missing` | `not_a_directory` | `not_allowed` — see `lib/project-cwd.ts`. */
  reason: string;
}
