# Pi Web in a full Ubuntu image, built from source.
#
# This is the **China mirror build** (apt / Node / npm / pip all point at
# Chinese mirrors). On a VPS outside China use `Dockerfile.global`, which is the
# same file with upstream sources — the two are kept identical otherwise (see
# lib/dockerfile-variants.test.mjs).
#
# The target architecture is detected from the image platform (`amd64`, `arm64`,
# `armhf`), so the same file builds on x86_64 and ARM VPS alike; the base image
# and the Node tarball follow it.
#
# These files only **build** the image — they never log into a registry and
# never push or upload the image anywhere. Moving it between machines is a
# manual `docker save` / `docker load` outside this file.
#
# Build (command line, no registry required):
#   docker build -t pi-web:latest .
#   docker build -f Dockerfile.global -t pi-web:latest .   # 海外版
#   docker build --build-arg APT_MIRROR= -t pi-web:latest . # 用官方 apt 源
# Install inside a 1Panel network (no published port; the panel's OpenResty
# container proxies to http://pi-web:30141):
#   docker run -d --name pi-web --restart unless-stopped \
#     --network 1panel-network \
#     -v /root/.pi/agent:/root/.pi/agent \
#     -v /srv:/srv \
#     -e PI_WEB_ALLOWED_HOSTS=pi.example.com \
#     -e TZ=Asia/Shanghai \
#     pi-web:latest
#
# See docs/docker.md for the volume rules (project paths must stay identical),
# the Nginx directives, and how to build on a machine without GitHub access.

# syntax=docker/dockerfile:1

ARG UBUNTU_IMAGE=ubuntu:24.04
ARG NODE_VERSION=22.19.0
# Mirror defaults. `Dockerfile.global` overrides exactly these four, so an empty
# value must mean "keep the upstream source" everywhere below.
ARG NODE_MIRROR=https://npmmirror.com/mirrors/node
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple
# Mirrors per cloud: Tencent Cloud uses http://mirrors.tencentyun.com/ubuntu/,
# Alibaba Cloud ECS uses http://mirrors.cloud.aliyuncs.com/ubuntu/ (both free,
# internal traffic). The public mirror below works anywhere in China; empty
# keeps the archive.ubuntu.com entries from the base image.
ARG APT_MIRROR=mirrors.aliyun.com

# ---------------------------------------------------------------------------
# Builder: full toolchain, Chinese package mirrors, cache mounts so a rebuild
# after a source change does not re-download the world.
# ---------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS builder
ARG APT_MIRROR
ARG NODE_VERSION
ARG NODE_MIRROR
ARG NPM_REGISTRY

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive NEXT_TELEMETRY_DISABLED=1

# The base image ships no ca-certificates, so an https mirror would fail its own
# TLS check before the package that trusts it can be installed. apt verifies
# package signatures with GPG either way; use http for the mirror itself.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    mirror="${APT_MIRROR#*://}" \
 && if [ -n "${mirror}" ]; then \
      echo "[pi-web] apt mirror: ${mirror}"; \
      sed -i -E "s|URIs: https?://[a-z.]*ubuntu\\.com/ubuntu/?|URIs: http://${mirror}/ubuntu/|" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    else \
      echo "[pi-web] apt mirror: upstream (archive.ubuntu.com)"; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils build-essential python3 pkg-config \
 && rm -rf /var/lib/apt/lists/*

# Node from the mirror, verified against the mirror's SHASUMS256.txt. Set
# NODE_SHA256 to pin a hash when building somewhere that cannot be trusted.
#
# The VPS architecture decides which Node tarball is used. `dpkg
# --print-architecture` reports the platform the image was built for, which is
# what `docker build` and `--platform` set; NODE_ARCH only exists for the rare
# case where that mapping has to be overridden by hand.
ARG NODE_SHA256=
ARG NODE_ARCH=
RUN --mount=type=cache,target=/tmp/node-download \
    set -euo pipefail; \
    detected_arch="$(dpkg --print-architecture)"; \
    node_arch="${NODE_ARCH:-}"; \
    if [ -z "${node_arch}" ]; then \
      case "${detected_arch}" in \
        amd64) node_arch=x64 ;; \
        arm64) node_arch=arm64 ;; \
        armhf) node_arch=armv7l ;; \
        *) echo "unsupported architecture: ${detected_arch} (supported: amd64->x64, arm64->arm64, armhf->armv7l; override with --build-arg NODE_ARCH=<x64|arm64|armv7l>)" >&2; exit 1 ;; \
      esac; \
    fi; \
    echo "[pi-web] architecture: ${detected_arch} -> node-v${NODE_VERSION}-linux-${node_arch}"; \
    tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    if [ ! -f "/tmp/node-download/${tarball}" ]; then \
      curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/${tarball}" -o "/tmp/node-download/${tarball}"; \
      curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/SHASUMS256.txt" -o "/tmp/node-download/SHASUMS256.txt"; \
    fi; \
    if [ -n "${NODE_SHA256}" ]; then expected="${NODE_SHA256}"; \
    else expected="$(grep " ${tarball}\$" /tmp/node-download/SHASUMS256.txt | awk '{print $1}')"; fi; \
    [ -n "${expected}" ] || { echo "no checksum for ${tarball}" >&2; exit 1; }; \
    echo "${expected}  /tmp/node-download/${tarball}" | sha256sum -c -; \
    tar -xJf "/tmp/node-download/${tarball}" -C /usr/local --strip-components=1 \
      --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm; \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx; \
    node --version

# Registry mirrors are written to /usr/local/etc/npmrc, not /root/.npmrc: the
# home directory belongs to the mounted volume and would lose them on rebuild.
# Written straight into /usr/local/etc/npmrc: `npm config set disturl` is
# rejected as an unknown option by npm 10, yet node-gyp still reads the key when
# it has to compile a native module, so it cannot be set through the CLI.
RUN printf 'registry=%s\nfund=false\naudit=false\ndisturl=%s\n' \
      "${NPM_REGISTRY}" "${NODE_MIRROR}" >> /usr/local/etc/npmrc \
 && npm config get registry

WORKDIR /opt/pi-web
# `bin/` comes along before the install because package.json's postinstall runs
# bin/prepare-terminal.js (a no-op outside macOS, but npm still executes it).
COPY package.json package-lock.json ./
COPY bin ./bin
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --include=dev --no-audit --no-fund

COPY . .
# `next build --webpack`, as package.json defines it.
#
# On a low-memory VPS every build worker gets a tiny V8 heap and dies with
# "JavaScript heap out of memory". next.config.ts sizes the workers by
# memory; this raises the per-process cap so the surviving ones have room.
# Lower it for very small machines: --build-arg NEXT_BUILD_MAX_OLD_SPACE=1024.
ARG NEXT_BUILD_MAX_OLD_SPACE=2048
ENV NODE_OPTIONS="--max-old-space-size=${NEXT_BUILD_MAX_OLD_SPACE}"
RUN npm run build

# Drop dev dependencies after the build: the runtime only needs `next`, the pi
# SDK, node-pty, and better-sqlite3 (which ships an N-API prebuild).
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Runtime: same Ubuntu base (identical glibc and prebuild compatibility),
# running as root on purpose — the agent works *inside* this container and is
# expected to be able to install packages in it.
# ---------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS runtime
ARG APT_MIRROR
ARG NPM_REGISTRY
ARG NODE_MIRROR
ARG PIP_INDEX

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    mirror="${APT_MIRROR#*://}" \
 && if [ -n "${mirror}" ]; then \
      echo "[pi-web] apt mirror: ${mirror}"; \
      sed -i -E "s|URIs: https?://[a-z.]*ubuntu\\.com/ubuntu/?|URIs: http://${mirror}/ubuntu/|" \
        /etc/apt/sources.list.d/ubuntu.sources; \
    else \
      echo "[pi-web] apt mirror: upstream (archive.ubuntu.com)"; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates tini tzdata locales \
      curl wget rsync openssh-client \
      git git-lfs \
      build-essential python3 python3-venv python3-pip pkg-config \
      sqlite3 jq ripgrep less file unzip zip xz-utils tar \
      vim-tiny tmux procps psmisc \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
 && locale-gen \
 && git lfs install --system \
 && git config --system --add safe.directory '*' \
 && printf '[global]\nindex-url = %s\ntrusted-host = %s\n' \
      "${PIP_INDEX}" "$(echo "${PIP_INDEX}" | sed -E 's|https?://([^/]+).*|\1|')" > /etc/pip.conf

# Same Node build as the builder, copied rather than downloaded twice.
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && printf 'registry=%s\nfund=false\naudit=false\ndisturl=%s\n' \
      "${NPM_REGISTRY}" "${NODE_MIRROR}" >> /usr/local/etc/npmrc \
 && node --version && npm config get registry

WORKDIR /opt/pi-web
COPY --from=builder /opt/pi-web/.next ./.next
COPY --from=builder /opt/pi-web/node_modules ./node_modules
COPY --from=builder /opt/pi-web/public ./public
COPY --from=builder /opt/pi-web/bin ./bin
COPY --from=builder /opt/pi-web/package.json /opt/pi-web/next.config.ts ./

ENV NODE_ENV=production \
    PI_WEB_RELEASES_DIR=/opt/pi-web-releases \
    NEXT_TELEMETRY_DISABLED=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    TZ=UTC \
    HOME=/root \
    PI_WEB_NO_OPEN=1 \
    PI_WEB_HOSTNAME=0.0.0.0 \
    PORT=30141 \
    PI_WEB_SKIP_VERSION_CHECK=1

# Where the in-container updater installs releases. Mount this directory to keep
# them across a container recreate; without the mount a recreated container falls
# back to the build baked into the image.
RUN mkdir -p /opt/pi-web-releases && chmod +x /opt/pi-web/bin/docker-entrypoint.sh

# No `VOLUME` line on purpose: it would silently create an anonymous volume and
# hide whichever data directory the operator forgot to mount. docs/docker.md
# lists the mounts that must exist.
EXPOSE 30141

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||30141)+'/api/web-auth',{redirect:'manual'}).then(()=>process.exit(0)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "/opt/pi-web/bin/docker-entrypoint.sh"]
CMD ["--hostname", "0.0.0.0", "--port", "30141", "--no-open"]
