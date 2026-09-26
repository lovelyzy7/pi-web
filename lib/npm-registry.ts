/**
 * The npm registry to talk to.
 *
 * Configurable because update checks and the marketplace are exactly the
 * features that break behind the Great Firewall, and a mirror is a one-line
 * environment variable instead of a patched build.
 */
export const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export function npmRegistryUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PI_WEB_NPM_REGISTRY?.trim();
  return (configured || NPM_REGISTRY_URL).replace(/\/+$/, "");
}
