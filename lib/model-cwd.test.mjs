import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { modelCwdNoticeMessage, resolveModelCwd } = await jiti.import("./model-cwd.ts");

/** A tiny filesystem: `directories` exist, `files` exist but are not directories. */
function probe(directories, { files = [], allowed = directories } = {}) {
  const exists = (path) => directories.includes(path) || files.includes(path);
  return {
    exists,
    isDirectory: (path) => directories.includes(path),
    isAllowed: (path) => allowed.includes(path),
    candidates: ["/roots/a", "/roots/b", "/opt/pi-web"],
    ...(directories.includes("/roots/a") ? {} : {}),
  };
}

test("uses the requested directory when it is there and readable", () => {
  const resolution = resolveModelCwd("/roots/a", probe(["/roots/a", "/roots/b"]));
  assert.deepEqual(resolution, { cwd: "/roots/a", notice: null });
});

test("no request falls back to the first usable candidate", () => {
  assert.deepEqual(resolveModelCwd(null, probe(["/roots/b"])), { cwd: "/roots/b", notice: null });
  assert.deepEqual(resolveModelCwd("", probe(["/opt/pi-web"])), { cwd: "/opt/pi-web", notice: null });
});

test("a directory that is gone falls back and reports itself as missing", () => {
  // The container case: the browser remembers /home/me/project from a session
  // file, but only the data directory exists inside the image.
  const resolution = resolveModelCwd("/home/me/project", probe(["/roots/b", "/opt/pi-web"]));
  assert.equal(resolution.cwd, "/roots/b");
  assert.deepEqual(resolution.notice, {
    requested: "/home/me/project",
    used: "/roots/b",
    reason: "missing",
  });
  assert.match(modelCwdNoticeMessage(resolution.notice), /does not exist: \/home\/me\/project/);
});

test("a path that exists but is a file is reported separately", () => {
  const resolution = resolveModelCwd("/roots/a/theme.css", probe(["/opt/pi-web"], { files: ["/roots/a/theme.css"] }));
  assert.equal(resolution.notice?.reason, "not_a_directory");
  assert.equal(resolution.cwd, "/opt/pi-web");
});

test("a directory outside the readable roots still degrades instead of failing", () => {
  // The caller only offers allowed roots as candidates, so the fallback is usable.
  const resolution = resolveModelCwd("/roots/a", {
    exists: (path) => ["/roots/a", "/opt/pi-web"].includes(path),
    isDirectory: (path) => ["/roots/a", "/opt/pi-web"].includes(path),
    isAllowed: (path) => path === "/opt/pi-web",
    candidates: ["/opt/pi-web"],
  });
  assert.equal(resolution.cwd, "/opt/pi-web");
  assert.equal(resolution.notice?.reason, "not_allowed");
  assert.match(modelCwdNoticeMessage(resolution.notice ?? { requested: "", used: "", reason: "not_allowed" }), /not readable/);
});

test("the requested directory wins over a later candidate even when both exist", () => {
  const resolution = resolveModelCwd("/roots/b", probe(["/roots/a", "/roots/b"]));
  assert.equal(resolution.cwd, "/roots/b");
  assert.equal(resolution.notice, null);
});

test("when no candidate exists it still returns the caller's last resort", () => {
  // Defensive: the message must never be built from an undefined path, and the
  // caller always puts an existing directory (process.cwd()) last.
  const resolution = resolveModelCwd("/gone", probe([]));
  assert.equal(resolution.cwd, "/opt/pi-web");
  assert.equal(resolution.notice?.used, "/opt/pi-web");
});
