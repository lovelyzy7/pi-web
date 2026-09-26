import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { buildContentSecurityPolicy, createNonce, cspMode, hstsValue, isTrustworthyOrigin } =
  await jiti.import("./security-headers.ts");
const nextConfig = await jiti.import("../next.config.ts");

test("the Next config applies the constant headers to every path", async () => {
  const rules = await nextConfig.default.headers();
  const all = rules.find((rule) => rule.source === "/:path*");
  assert.ok(all, "a /:path* rule must exist");

  const map = Object.fromEntries(all.headers.map((header) => [header.key, header.value]));
  assert.equal(map["X-Content-Type-Options"], "nosniff");
  assert.equal(map["X-Frame-Options"], "DENY");
  assert.equal(map["Referrer-Policy"], "same-origin");
  assert.match(map["Permissions-Policy"], /camera=\(\)/);
  assert.match(map["Permissions-Policy"], /microphone=\(\)/);
  // The config is required at startup from the compiled copy, so it must not
  // import sources that the runtime image does not ship.
  const configSource = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  assert.doesNotMatch(configSource, /^import .*lib\/security-headers/m);
});

test("CSP defaults to report-only and can be turned off or enforced", () => {
  assert.equal(cspMode({}), "report-only");
  assert.equal(cspMode({ PI_WEB_CSP: "enforce" }), "enforce");
  assert.equal(cspMode({ PI_WEB_CSP: "ENFORCE" }), "enforce");
  assert.equal(cspMode({ PI_WEB_CSP: "off" }), "off");
  assert.equal(cspMode({ PI_WEB_CSP: "report-only" }), "report-only");
  assert.equal(cspMode({ PI_WEB_CSP: "nonsense" }), "report-only");
});

test("the policy keeps the app working and blocks the dangerous defaults", () => {
  const nonce = "abc123";
  const policy = buildContentSecurityPolicy({ nonce });
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`));
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'self'/);
  // Inline styles are how xterm, KaTeX and the markdown renderer work.
  assert.match(policy, /style-src 'self' 'unsafe-inline'/);
  // Remote images still render inside conversations.
  assert.match(policy, /img-src 'self' data: blob: https:/);
  assert.doesNotMatch(policy, /unsafe-eval/);
});

test("development allows the HMR runtime and its websocket", () => {
  const policy = buildContentSecurityPolicy({
    nonce: "n",
    development: true,
    connectExtra: ["ws://127.0.0.1:30141"],
  });
  assert.match(policy, /'unsafe-eval'/);
  assert.match(policy, /connect-src 'self' ws:\/\/127\.0\.0\.1:30141/);
});

test("nonces are unique and base64", () => {
  const first = createNonce();
  const second = createNonce();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.ok(first.length >= 20);
});

test("COOP is only emitted on trustworthy origins", () => {
  const request = (url, headers = {}) => ({
    url,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  });
  assert.equal(isTrustworthyOrigin(request("https://pi.example.com/")), true);
  assert.equal(isTrustworthyOrigin(request("http://pi.example.com/", { "x-forwarded-proto": "https" })), true);
  assert.equal(isTrustworthyOrigin(request("http://127.0.0.1:30141/")), true);
  assert.equal(isTrustworthyOrigin(request("http://localhost:30141/")), true);
  assert.equal(isTrustworthyOrigin(request("http://172.30.113.75:30141/")), false);
  assert.equal(isTrustworthyOrigin(request("http://192.168.1.20:30141/")), false);
});

test("HSTS is a long-lived inclusive policy", () => {
  assert.equal(hstsValue(), "max-age=31536000; includeSubDomains");
  assert.match(hstsValue(60), /max-age=60/);
});
