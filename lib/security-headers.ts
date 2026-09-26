import { randomBytes } from "node:crypto";

/**
 * Response security headers.
 *
 * The constant headers ride on `next.config.ts`, which covers every path
 * including the ones the proxy does not match. The two that need a request
 * (`CSP` with a per-response nonce, and `HSTS` only when the connection really is
 * HTTPS) are applied in `proxy.ts`.
 */

export type CspMode = "off" | "report-only" | "enforce";

/**
 * Browsers only honour `Cross-Origin-Opener-Policy` on trustworthy origins
 * (HTTPS, or loopback). Sending it over plain HTTP to a LAN address produces a
 * console warning and no protection, so the proxy asks this first.
 */
export function isTrustworthyOrigin(request: {
  url: string;
  headers: { get(name: string): string | null };
}): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  let protocol = forwardedProto ?? "";
  let hostname = "";
  try {
    const parsed = new URL(request.url);
    protocol = protocol || parsed.protocol.replace(":", "");
    hostname = parsed.hostname;
  } catch {
    return false;
  }
  if (protocol === "https") return true;
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare.endsWith(".localhost");
}

/**
 * `report-only` is the default on purpose: the app injects an inline theme
 * script and Next injects inline hydration data, so a wrong policy would break a
 * working installation on upgrade. Operators can watch the console, then set
 * `PI_WEB_CSP=enforce`.
 */
export function cspMode(environment: NodeJS.ProcessEnv = process.env): CspMode {
  const configured = environment.PI_WEB_CSP?.trim().toLowerCase();
  if (configured === "off" || configured === "enforce" || configured === "report-only") {
    return configured;
  }
  return "report-only";
}

export function createNonce(): string {
  return randomBytes(16).toString("base64");
}

export interface CspOptions {
  nonce: string;
  /** Development needs `unsafe-eval` for the Turbopack HMR runtime. */
  development?: boolean;
  /** Extra websocket origins for HMR, e.g. `ws://127.0.0.1:30141`. */
  connectExtra?: string[];
}

/**
 * Next reads the nonce back out of this header and stamps it onto the scripts it
 * generates, so `'strict-dynamic'` can stay in place without listing every chunk.
 */
export function buildContentSecurityPolicy(options: CspOptions): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${options.nonce}'`,
    "'strict-dynamic'",
    ...(options.development ? ["'unsafe-eval'"] : []),
  ];
  const connectSrc = ["'self'", ...(options.connectExtra ?? [])];
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    // Styles are injected by the framework and by xterm/markdown rendering.
    "style-src 'self' 'unsafe-inline'",
    // Remote images appear in conversations (markdown links, screenshots pasted
    // into a message); images cannot execute script, so allowing https here is
    // the difference between a working chat and a broken one.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    `connect-src ${connectSrc.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}

export function hstsValue(maxAgeSeconds = 31_536_000): string {
  return `max-age=${maxAgeSeconds}; includeSubDomains`;
}
