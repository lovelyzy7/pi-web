import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { parseProviderError, providerErrorKindKey } = await jiti.import("./provider-error.ts");

// The text this feature was reported with, verbatim.
const REPORTED = 'Error: 402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"},"request_id":"06f9981737dff7a00fbe9a3bbcd1a23d"}';

test("recognises the reported insufficient-balance failure", () => {
  const error = parseProviderError(REPORTED);
  assert.ok(error);
  assert.equal(error.status, 402);
  assert.equal(error.code, "insufficient_balance_error");
  assert.equal(error.message, "insufficient balance (1008)");
  assert.equal(error.requestId, "06f9981737dff7a00fbe9a3bbcd1a23d");
  assert.equal(error.kind, "insufficient_balance");
  assert.equal(error.raw, REPORTED);
  assert.equal(providerErrorKindKey(error.kind), "chat.providerError.insufficient_balance");
});

test("classifies other provider failures by code or status", () => {
  const cases = [
    ['Error: 401 {"error":{"type":"invalid_api_key","message":"bad key"}}', "invalid_credentials"],
    ['Error: 429 {"error":{"type":"rate_limit_error","message":"slow down"},"request_id":"r1"}', "rate_limited"],
    ['Error: 404 {"error":{"type":"model_not_found","message":"no such model"}}', "model_not_found"],
    ['Error: 400 {"error":{"type":"context_length_exceeded","message":"too long"}}', "context_length"],
    ['Error: 503 {"error":{"type":"overloaded_error","message":"busy"}}', "provider_unavailable"],
    ['Error: 418 {"error":{"type":"teapot"}}', "unknown"],
    // Status-only shapes, and the fallback when the body is not JSON.
    ["Error: 502 Bad Gateway", "provider_unavailable"],
    ['Error: 500 {"error":{"message":"boom"},"request_id":"r2"}', "provider_unavailable"],
  ];
  for (const [text, kind] of cases) {
    assert.equal(parseProviderError(text)?.kind, kind, text);
  }
});

test("plain status text without a body still yields a usable error", () => {
  const error = parseProviderError("Error: 429");
  assert.equal(error?.status, 429);
  assert.equal(error?.kind, "rate_limited");
  assert.equal(error?.message, "");
});

test("leaves ordinary text alone", () => {
  for (const text of [
    "",
    "Everything is fine",
    "Error: something broke",
    "502 Bad Gateway",           // no status keyword and no JSON
    "TypeError: x is not a function",
    "the model answered 402 rupees",
  ]) {
    assert.equal(parseProviderError(text), null, text);
  }
});

test("does not mistake an assistant answer that merely mentions a status", () => {
  const text = "The provider replied 402 to my request, here is the body: {\"error\":{\"type\":\"x\"}}";
  assert.equal(parseProviderError(text), null);
});

test("reads a bare JSON error body when a status is attached", () => {
  const error = parseProviderError('402 {"error":{"type":"insufficient_quota","message":"no credits"},"requestId":"abc"}');
  assert.equal(error?.kind, "insufficient_balance");
  assert.equal(error?.requestId, "abc");
});
