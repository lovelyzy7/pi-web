import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { getLocalePlugin, getSupportedLocales } = await jiti.import("../lib/i18n/registry.ts");
const { parseProviderError, providerErrorKindKey } = await jiti.import("../lib/provider-error.ts");
const messageView = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const filesRoute = await readFile(new URL("../app/api/files/[...path]/route.ts", import.meta.url), "utf8");
const missingPathLib = await readFile(new URL("../lib/missing-path.ts", import.meta.url), "utf8");
const explorerSource = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

const REPORTED = 'Error: 402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"},"request_id":"06f9981737dff7a00fbe9a3bbcd1a23d"}';

test("every provider failure kind has a translation in every locale", () => {
  const kinds = [
    "insufficient_balance", "invalid_credentials", "rate_limited", "model_not_found",
    "context_length", "content_filtered", "provider_unavailable", "unknown",
  ];
  for (const locale of getSupportedLocales()) {
    const messages = getLocalePlugin(locale).messages;
    for (const key of ["chat.providerErrorTitle", "chat.providerErrorStatus", "chat.providerErrorDetails", "chat.providerErrorRequestId"]) {
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
    }
    for (const kind of kinds) {
      const key = providerErrorKindKey(kind);
      assert.equal(typeof messages[key], "string", `${locale} is missing ${key}`);
    }
  }
});

test("the reported failure is what the card renders", () => {
  const error = parseProviderError(REPORTED);
  assert.ok(error);
  assert.equal(error.kind, "insufficient_balance");
  assert.equal(error.status, 402);
  assert.equal(error.requestId, "06f9981737dff7a00fbe9a3bbcd1a23d");
  assert.match(error.message, /insufficient balance/);
});

test("the transcript and the notices both use the parser", () => {
  // A provider failure is stored as ordinary text; rendering it raw is what made
  // the reported bubble unreadable.
  assert.match(messageView, /parseProviderError\(block\.text\)/);
  assert.match(messageView, /<ProviderErrorCard error=\{providerError\} \/>/);
  assert.match(messageView, /providerErrorKindKey\(error\.kind\)/);
  // The raw text stays one disclosure away.
  assert.match(messageView, /<summary>\{t\("chat\.providerErrorDetails"\)\}<\/summary>/);
  // Notices and startup errors go through the same wording.
  assert.match(hookSource, /providerErrorNotice\(e instanceof Error \? e\.message : String\(e\)\)/);
  assert.match(hookSource, /export function providerErrorNotice/);
});

test("a missing project directory is explained in the file browser and the API", () => {
  assert.match(filesRoute, /code: "cwd_missing",\s*\n\s*path: filePath,/);
  assert.match(filesRoute, /missingRoot,/);
  assert.doesNotMatch(filesRoute, /export function nearestMissingRoot/, "route files may only export handlers");
  assert.match(missingPathLib, /export function nearestMissingRoot/);
  assert.match(explorerSource, /class CwdMissingError extends Error/);
  assert.match(explorerSource, /data\.code === "cwd_missing" && data\.path/);
  assert.match(explorerSource, /t\("files\.cwdMissing", \{ path: error\.slice\("cwd_missing:"\.length\) \}\)/);
});
