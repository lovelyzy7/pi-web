import fs from "node:fs";
import path from "node:path";

/**
 * The highest ancestor of `target` that does not exist.
 *
 * Reports *which* level is missing, not just that a path is unusable: for a
 * container that mounted only part of a tree, the answer is the mount point
 * (`/srv`), which is what the operator has to add. Returns null when the target
 * itself exists.
 *
 * This lives outside `app/api/files/[...path]/route.ts` on purpose: Next's route
 * type check rejects any export a route file does not use as a handler, so a
 * helper must not be exported from there (`next build` fails, while `tsc
 * --noEmit` alone cannot see it).
 */
export function nearestMissingRoot(target: string): string | null {
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved)) return null;
  // Walk up while the parent is missing, so the answer is the highest level
  // that has to be created or mounted — not its first existing parent.
  let current = resolved;
  for (let depth = 0; depth < 64; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current || fs.existsSync(parent)) return current;
    current = parent;
  }
  return current;
}
