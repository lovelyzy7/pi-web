import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const cn = await readFile(new URL("Dockerfile", root), "utf8");
const global = await readFile(new URL("Dockerfile.global", root), "utf8");

/** The lines the two variants are allowed to differ on. */
const MIRROR_ARG = /^ARG (NODE_MIRROR|NPM_REGISTRY|PIP_INDEX|APT_MIRROR)=/;

/**
 * Comments and the mirror defaults are the only differences: everything that
 * decides what the image contains must be identical, or the two builds drift
 * apart and only one of them keeps working.
 */
function normalize(source) {
  return source
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => (MIRROR_ARG.test(line) ? `${line.split("=")[0]}=<mirror>` : line))
    .join("\n")
    .trim();
}

function mirrorDefaults(source) {
  return Object.fromEntries(
    source
      .split("\n")
      .filter((line) => MIRROR_ARG.test(line))
      .map((line) => {
        const [key, ...rest] = line.slice("ARG ".length).split("=");
        return [key, rest.join("=")];
      }),
  );
}

test("the two Dockerfiles differ only in their mirror defaults", () => {
  assert.equal(normalize(cn), normalize(global), "Dockerfile and Dockerfile.global must stay in step");
  assert.notEqual(cn, global, "they are separate files");
});

test("the China build points at Chinese mirrors", () => {
  const mirrors = mirrorDefaults(cn);
  assert.match(mirrors.NODE_MIRROR, /npmmirror\.com/);
  assert.match(mirrors.NPM_REGISTRY, /npmmirror\.com/);
  assert.match(mirrors.PIP_INDEX, /(tuna|aliyun|ustc|douban)/);
  assert.match(mirrors.APT_MIRROR, /(aliyun|tencentyun|cloud\.aliyuncs|ustc|tuna)/);
});

test("the global build uses upstream sources and no Chinese mirror", () => {
  const mirrors = mirrorDefaults(global);
  assert.equal(mirrors.NODE_MIRROR, "https://nodejs.org/dist");
  assert.equal(mirrors.NPM_REGISTRY, "https://registry.npmjs.org");
  assert.equal(mirrors.PIP_INDEX, "https://pypi.org/simple");
  // Empty keeps the archive.ubuntu.com entries the base image ships.
  assert.equal(mirrors.APT_MIRROR, "");
  for (const value of Object.values(mirrors)) {
    assert.doesNotMatch(value, /npmmirror|aliyun|tencentyun|tuna/, `${value} must not be a China mirror`);
  }
});

test("an empty apt mirror keeps the upstream sources instead of rewriting them", () => {
  // The rewrite must be conditional, otherwise the global build would point
  // archive.ubuntu.com at a mirror that was never configured.
  assert.match(cn, /if \[ -n "\$\{mirror\}" \]; then/);
  assert.match(cn, /else\s+\\\n\s+echo "\[pi-web\] apt mirror: upstream/);
});

test("low-memory machines get a raised, overridable heap cap for the build", () => {
  // The reported failure: a build worker hits a ~490 MB V8 heap on a small VPS.
  // The cap is builder-scoped (never the runtime) and sits directly on the
  // build step so npm ci and the runtime keep their default heap.
  for (const [name, source] of [["Dockerfile", cn], ["Dockerfile.global", global]]) {
    assert.match(source, /ARG NEXT_BUILD_MAX_OLD_SPACE=2048/, name);
    assert.match(source, /ENV NODE_OPTIONS="--max-old-space-size=\$\{NEXT_BUILD_MAX_OLD_SPACE\}"/, name);
    const build = source.indexOf("RUN npm run build");
    const env = source.indexOf("NODE_OPTIONS=");
    assert.ok(env > -1 && env < build, `${name}: the heap cap precedes the build step`);
    assert.ok(build < source.indexOf("# Drop dev dependencies") || build > -1, `${name} still builds once`);
  }
});

test("next.config trades memory for worker count on small machines", async () => {
  const nextConfig = await readFile(new URL("next.config.ts", root), "utf8");
  assert.match(nextConfig, /memoryBasedWorkersCount: true/);
  assert.match(nextConfig, /webpackMemoryOptimizations: true/);
  assert.match(nextConfig, /NEXT_BUILD_MAX_OLD_SPACE, default 2048 MB/, "the config explains the Dockerfile ARG");
});

test("the pi CLI that ships with the app is linked onto PATH", () => {
  // The CLI is already in node_modules; without this link `docker exec … pi`
  // answers "command not found" because npm's .bin is not on the image PATH.
  for (const [name, source] of [["Dockerfile", cn], ["Dockerfile.global", global]]) {
    assert.match(source, /RUN ln -sf \/opt\/pi-web\/node_modules\/\.bin\/pi \/usr\/local\/bin\/pi/);
    assert.match(source, /timeout 60 pi --version/);
    // The link has to come after node_modules is copied into the runtime stage.
    const copied = source.indexOf("COPY --from=builder /opt/pi-web/node_modules");
    const linked = source.indexOf("ln -sf /opt/pi-web/node_modules/.bin/pi");
    assert.ok(copied > -1 && linked > copied, `${name}: the link follows the copy`);
  }
});

test("the build detects the VPS architecture", () => {
  const archBlock = cn.slice(cn.indexOf("detected_arch="), cn.indexOf("tarball=\"node-v"));
  assert.match(archBlock, /dpkg --print-architecture/);
  assert.match(archBlock, /amd64\) node_arch=x64/);
  assert.match(archBlock, /arm64\) node_arch=arm64/);
  assert.match(archBlock, /armhf\) node_arch=armv7l/);
  assert.match(archBlock, /unsupported architecture:/);
  // An explicit override exists for anything the mapping does not cover, and the
  // chosen pair is printed so the build log says what was detected.
  assert.match(cn, /ARG NODE_ARCH=/);
  assert.match(archBlock, /echo "\[pi-web\] architecture: \$\{detected_arch\} -> /);
  // The tarball follows the detected arch rather than a hardcoded one.
  assert.match(cn, /tarball="node-v\$\{NODE_VERSION\}-linux-\$\{node_arch\}\.tar\.xz"/);
  assert.doesNotMatch(cn, /node-v\$\{NODE_VERSION\}-linux-x64/);
});
