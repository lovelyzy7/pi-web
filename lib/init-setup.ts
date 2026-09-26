import { randomInt, timingSafeEqual } from "node:crypto";

/**
 * One-time setup code that gates `/init`.
 *
 * Before an account exists, `/init` is the only unauthenticated write endpoint,
 * so on a VPS a stranger who reaches the port first could otherwise claim the
 * installation. The code is printed to the server log (visible via
 * `docker logs pi-web`), rotates every ten minutes, and dies for good once the
 * account is created.
 *
 * There is deliberately no "trusted source" exemption. Next.js injects
 * `x-forwarded-for` itself, but it passes a client-supplied value through
 * unchanged, and route handlers have no reliable socket address, so a request
 * cannot be proven to come from loopback — an attacker who can reach the port
 * could send `Host: 127.0.0.1` and claim to be local. Operators who cannot read
 * the log pin the code with `PI_WEB_INIT_TOKEN` instead, which makes scripted
 * first-run setup possible without weakening the gate.
 */

export const INIT_CODE_TTL_MS = 10 * 60_000;
export const INIT_CODE_LENGTH = 8;

/** Unambiguous alphabet: no O/0, I/1/L. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

interface SetupCodeState {
  code: string;
  issuedAt: number;
}

declare global {
  var __piWebSetupCode: SetupCodeState | undefined;
}

function generateCode(): string {
  let code = "";
  for (let index = 0; index < INIT_CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function configuredToken(environment: NodeJS.ProcessEnv = process.env): string | null {
  const token = environment.PI_WEB_INIT_TOKEN;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

/**
 * The current setup code, rotating (and logging) when the window expires. The
 * log line is what makes the code discoverable; it is emitted once per rotation.
 */
declare global {
  var __piWebPinnedInitTokenLogged: boolean | undefined;
}

export function getSetupCode(now: number = Date.now()): string {
  const pinned = configuredToken();
  if (pinned) {
    if (!globalThis.__piWebPinnedInitTokenLogged) {
      globalThis.__piWebPinnedInitTokenLogged = true;
      console.log("[pi-web] First-run setup code is pinned by PI_WEB_INIT_TOKEN.");
    }
    return pinned;
  }

  const current = globalThis.__piWebSetupCode;
  if (current && now - current.issuedAt < INIT_CODE_TTL_MS) return current.code;

  const state: SetupCodeState = { code: generateCode(), issuedAt: now };
  globalThis.__piWebSetupCode = state;
  console.log(
    `[pi-web] First-run setup code: ${state.code} — open /init and enter it within `
    + `${Math.round(INIT_CODE_TTL_MS / 60_000)} minutes.`
    + " Set PI_WEB_INIT_TOKEN to pin a code instead.",
  );
  return state.code;
}

function constantTimeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Case-insensitive, whitespace-tolerant comparison against the current code. */
export function verifySetupCode(
  supplied: unknown,
  now: number = Date.now(),
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof supplied !== "string") return false;
  const normalized = normalizeCode(supplied);
  if (normalized.length === 0) return false;

  const pinned = configuredToken(environment);
  if (pinned) return constantTimeEquals(normalized, normalizeCode(pinned));

  const current = globalThis.__piWebSetupCode;
  if (!current || now - current.issuedAt >= INIT_CODE_TTL_MS) return false;
  return constantTimeEquals(normalized, current.code);
}

/** Forgets the generated code; called once the account exists. */
export function clearSetupCode(): void {
  globalThis.__piWebSetupCode = undefined;
}
