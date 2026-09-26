import assert from "node:assert/strict";
import test from "node:test";

const {
  AUTH_THROTTLE_MAX_DELAY_MS,
  AUTH_THROTTLE_RESET_AFTER_MS,
  backoffDelayMs,
  createAuthThrottleState,
  expireIfStale,
  nextFailureState,
  remainingBlockMs,
  retryAfterSeconds,
} = await import("./auth-throttle.ts");

test("allows attempts until the first failure", () => {
  assert.equal(remainingBlockMs(createAuthThrottleState(), 1_000), 0);
});

test("doubles the delay on each failure and caps at the maximum", () => {
  let state = createAuthThrottleState();
  let now = 0;
  const delays = [];
  for (let i = 0; i < 8; i += 1) {
    state = nextFailureState(state, now);
    delays.push(state.blockedUntil - now);
    now += delays[delays.length - 1];
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.ok(AUTH_THROTTLE_RESET_AFTER_MS > AUTH_THROTTLE_MAX_DELAY_MS, "waiting out a block must not reset the counter");
  assert.equal(backoffDelayMs(100), AUTH_THROTTLE_MAX_DELAY_MS);
  assert.equal(backoffDelayMs(0), 0);
});

test("reports the remaining block time and lifts it when it expires", () => {
  let state = createAuthThrottleState();
  state = nextFailureState(state, 10_000);
  state = nextFailureState(state, 11_000);
  assert.equal(remainingBlockMs(state, 11_500), 1_500);
  assert.equal(remainingBlockMs(state, 13_000), 0);
  assert.equal(state.failures, 2, "an expired block keeps the failure count for backoff");
});

test("forgets failures once they are older than the reset window", () => {
  let state = createAuthThrottleState();
  state = nextFailureState(state, 0);
  state = nextFailureState(state, 1_000);
  const later = 1_000 + AUTH_THROTTLE_RESET_AFTER_MS;
  assert.deepEqual(expireIfStale(state, later), createAuthThrottleState());
  const restarted = nextFailureState(state, later);
  assert.equal(restarted.blockedUntil - later, 1_000, "backoff restarts from the base delay");
});

test("Retry-After rounds up to whole seconds and is at least one", () => {
  assert.equal(retryAfterSeconds(1), 1);
  assert.equal(retryAfterSeconds(1_000), 1);
  assert.equal(retryAfterSeconds(1_001), 2);
  assert.equal(retryAfterSeconds(60_000), 60);
});
