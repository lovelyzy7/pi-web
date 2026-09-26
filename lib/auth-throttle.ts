/**
 * Backoff math for password authentication failures.
 *
 * Pi Web serves a single operator behind a reverse proxy, so there is no client
 * address to key on (`x-forwarded-for` is spoofable and absent for direct
 * connections). Every failure feeds one shared counter per scope and briefly
 * blocks further attempts there. The only "other user" affected by a block is
 * the operator, and a bounded delay is acceptable for them while it caps brute
 * force at roughly one guess per minute.
 *
 * The counters themselves live in the database (`lib/auth-throttle-store.ts`)
 * so that restarting the server cannot hand a guesser a fresh burst. This module
 * stays pure so the curve is testable on its own.
 */

export const AUTH_THROTTLE_BASE_DELAY_MS = 1_000;
export const AUTH_THROTTLE_MAX_DELAY_MS = 60_000;

/**
 * Idle time after the last failure before the counter is forgotten. It must be
 * longer than the maximum delay, otherwise waiting out one block would restart
 * the backoff from the base delay and hand an attacker a fresh burst of guesses.
 */
export const AUTH_THROTTLE_RESET_AFTER_MS = 5 * 60_000;

export interface AuthThrottleState {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

export function createAuthThrottleState(): AuthThrottleState {
  return { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
}

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 31);
  return Math.min(AUTH_THROTTLE_BASE_DELAY_MS * 2 ** exponent, AUTH_THROTTLE_MAX_DELAY_MS);
}

/** A counter idle for longer than the reset window counts as cleared. */
export function expireIfStale(state: AuthThrottleState, now: number): AuthThrottleState {
  if (state.failures > 0 && now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS) {
    return createAuthThrottleState();
  }
  return state;
}

/** Milliseconds the caller must still wait before another attempt is accepted. */
export function remainingBlockMs(state: AuthThrottleState, now: number): number {
  return Math.max(0, expireIfStale(state, now).blockedUntil - now);
}

/** Records a failed attempt and returns the delay now imposed on the next one. */
export function nextFailureState(state: AuthThrottleState, now: number): AuthThrottleState {
  const current = expireIfStale(state, now);
  const failures = current.failures + 1;
  return { failures, lastFailureAt: now, blockedUntil: now + backoffDelayMs(failures) };
}

/** Whole seconds for the `Retry-After` header; never less than 1 while blocked. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
