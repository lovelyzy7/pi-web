# 用 Docker 部署 Pi Web

面向「VPS + 1Panel（OpenResty 是容器）」的场景：镜像用完整 Ubuntu 构建，容器内是 root，Pi Web 不发布宿主端口，由 1Panel 的 OpenResty 容器按容器名反向代理。

---

## 1. 构建

镜像里包含了 `.next` 构建产物和运行依赖，所以构建必须在有源码的地方做。

### 1.0 两个版本：国内版与海外版

仓库里有**两个 Dockerfile，除镜像源以外完全一致**（`lib/dockerfile-variants.test.mjs` 会检查它们没有跑偏）：

| 文件 | 适用 | apt | Node | npm | pip |
| --- | --- | --- | --- | --- | --- |
| `Dockerfile`（默认） | 国内 VPS | `mirrors.aliyun.com` | `npmmirror.com/mirrors/node` | `registry.npmmirror.com` | 清华 PyPI |
| `Dockerfile.global` | 海外 VPS | 官方 `archive.ubuntu.com` | `nodejs.org/dist` | `registry.npmjs.org` | `pypi.org/simple` |

```bash
docker build -t pi-web:latest .                      # 国内版
docker build -f Dockerfile.global -t pi-web:latest . # 海外版
```

四个镜像都可以用 `--build-arg` 单独覆盖，**传空值表示用官方源**：

```bash
docker build --build-arg APT_MIRROR= -t pi-web:latest .                    # 只关掉 apt 镜像
docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org -t pi-web:latest .
docker build --build-arg NODE_MIRROR=https://nodejs.org/dist -t pi-web:latest .
```

腾讯云内网可以用 `--build-arg APT_MIRROR=mirrors.tencentyun.com`，阿里云 ECS 内网用 `mirrors.cloud.aliyuncs.com`（都免费、走内网）。

### 1.0.1 自动检测 VPS 架构

构建时按镜像平台自动选择 Node 包，同一份 Dockerfile 在 x86_64 与 ARM 上都可用：

| `dpkg --print-architecture` | Node 包 |
| --- | --- |
| `amd64` | `linux-x64` |
| `arm64` | `linux-arm64` |
| `armhf` | `linux-armv7l` |

其他架构会**明确报错**并列出支持项。构建日志里会打印实际选中的组合，例如 `[pi-web] architecture: amd64 -> node-v22.19.0-linux-x64`，另有 `--build-arg NODE_ARCH=<x64|arm64|armv7l>` 供特殊平台手工覆盖。基础镜像 `ubuntu:24.04` 本身是多架构的，`docker build` 会拉取与宿主机匹配的那一份；跨架构构建（例如在 x86 上出 arm64 镜像）用 `docker buildx build --platform linux/arm64`。

### 1.0.2 低内存机器（构建时报 JavaScript heap out of memory）

`next build` 会按 CPU 数开静态生成 worker，小内存 VPS 上每个 worker 分到的 V8 堆很小，于是构建在收集页面数据阶段被 OOM 杀掉（报错形如 `FATAL ERROR: Reached heap limit`）。两个 Dockerfile 已经做了三层缓解：

1. `next.config.ts` 里 `memoryBasedWorkersCount: true` —— worker 数量按内存而不是按 CPU 数决定；
2. 同处 `webpackMemoryOptimizations: true` —— webpack 用内存换构建时间；
3. 构建步骤设 `NODE_OPTIONS=--max-old-space-size=2048`（即 `ARG NEXT_BUILD_MAX_OLD_SPACE=2048`），每个进程的堆上限不再卡在 ~500 MB。

机器特别小（≤2 GB）时把上限调小，宁可慢一点也不要触发系统 OOM：

```bash
docker build --build-arg NEXT_BUILD_MAX_OLD_SPACE=1024 -t pi-web:latest .
```

### 1.1 在 VPS 上直接构建（推荐）

```bash
git clone https://github.com/lovelyzy7/pi-web.git
cd pi-web
docker build -t pi-web:latest .                      # 国内 VPS（默认走国内源）
docker build -f Dockerfile.global -t pi-web:latest . # 海外 VPS（全官方源）
```

国内版默认就用国内源（apt 阿里云、Node npmmirror、npm npmmirror、pip 清华），见上面的 §1.0。云厂商 VPS 建议换成内网源，免公网流量且更快：

```bash
# 腾讯云
docker build -t pi-web:latest --build-arg APT_MIRROR=mirrors.tencentyun.com .
# 阿里云 ECS
docker build -t pi-web:latest --build-arg APT_MIRROR=mirrors.cloud.aliyuncs.com .
```

可用参数：`APT_MIRROR`、`NPM_REGISTRY`、`NODE_MIRROR`、`PIP_INDEX`、`NODE_VERSION`、`NODE_SHA256`（固定校验和）、`UBUNTU_IMAGE`。

Docker Hub 本身也要能拉 `ubuntu:24.04`：在 1Panel「容器 → 配置 → 镜像加速」里填 `https://docker.1panel.live`，或改 `/etc/docker/daemon.json` 的 `registry-mirrors`。若本机 `docker build` 走的是 BuildKit（Docker 23+ 默认），apt/npm 缓存会通过 cache mount 复用，重建明显更快。

### 1.2 构建上下文（`.dockerignore`）

`docker build` 会把整个目录发给守护进程，`.dockerignore` 决定发什么。这里刻意只留**构建真正需要的东西**：

- 保留：`app/`、`components/`、`hooks/`、`lib/`、`public/`、`bin/`、`package.json`、`package-lock.json`、`next.config.ts`、`tsconfig.json`、`postcss.config.mjs`、`eslint.config.mjs`、`instrumentation*.ts`、`proxy.ts`、`tailwind.config.ts`、`LICENSE`。
- 排除：`node_modules`、`.next`、`out`、`build`（镜像自己 `npm ci && npm run build`，带上宿主的副本反而可能在 macOS/Windows 上混入错误平台的二进制）、`demo`、`e2e`、`test-results`、`coverage`、`docs`、`themes`、`AGENTS.md`、`CONTEXT.md`、`README*.md`、`.git`、`.github`、`.env*`。
- 大体积**本地产物**（`docker save` 出来的 tar、`npm pack` 的 tgz、`pi-web-releases/`、SQLite 库、pi 会话 `.jsonl`、`*.log`、Playwright 报告、编辑器与 Windows ADS 文件）一律不进上下文。

实测：加了这些规则后上下文 **6.3 MB**（把 `demo`/`docs`/`themes` 与 40 MB 级别的 tar/会话文件排除前是 50 MB 以上）。想确认哪些文件真正进了上下文，可以用一个只 `COPY` 的临时 Dockerfile：

```bash
printf 'FROM ubuntu:24.04\nCOPY . /ctx\nRUN du -sh /ctx && ls /ctx\n' > Dockerfile.ctxcheck
docker build --progress=plain -f Dockerfile.ctxcheck -t ctxcheck . && docker rmi ctxcheck && rm Dockerfile.ctxcheck
```

## 2. 运行

### 2.1 1Panel 的 OpenResty 是容器（默认推荐）

OpenResty 在 `1panel-network` 里，Pi Web 也放同一个网络，**不发布任何宿主端口**：

```bash
docker run -d --name pi-web --restart unless-stopped \
  --network 1panel-network \
  -v /root/.pi/agent:/root/.pi/agent \
  -v /srv:/srv \
  -e PI_WEB_ALLOWED_HOSTS=pi.example.com \
  -e TZ=Asia/Shanghai \
  pi-web:latest
```

然后在 1Panel「网站 → 反向代理」里把上游填成 `http://pi-web:30141`（面板支持直接选容器和端口）。

已确认的事实：容器内无法用 `127.0.0.1` 访问宿主，所以只有两种连法——**同网络按容器名**（上面的做法），或宿主上 `-p 127.0.0.1:30141:30141` + OpenResty 使用 host 网络模式。若 OpenResty 是 bridge 模式又只把端口发布到宿主 `127.0.0.1`，容器是连不上的。

### 2.2 OpenResty 是 host 网络（或想用 IP:端口 直连）

```bash
docker run -d --name pi-web --restart unless-stopped \
  -p 127.0.0.1:30141:30141 \
  -v /root/.pi/agent:/root/.pi/agent \
  -v /srv:/srv \
  -e PI_WEB_ALLOWED_HOSTS=pi.example.com \
  pi-web:latest
```

`-p 127.0.0.1:...` 只监听宿主回环，不会暴露到公网。调试时 `curl http://127.0.0.1:30141` 也能用。

### 2.3 环境变量

| 变量 | 说明 |
| --- | --- |
| `PI_WEB_ALLOWED_HOSTS` | **用域名访问时必填**，逗号分隔的精确主机名（代理会把外部域名放进 Host，不在白名单会 403） |
| `PI_WEB_PASSWORD` | 可选。设置后认证由环境变量管理，`/init` 与 `/user` 的账号功能停用 |
| `PI_WEB_INIT_TOKEN` | 可选。固定初始化验证码，便于脚本化首次初始化（否则用启动日志里的验证码） |
| `PI_WEB_SESSION_TTL_MS` | 可选。空闲会话有效期，默认 30 天 |
| `PI_WEB_CSP` | 可选。CSP 模式：`report-only`（默认，只报告不拦截）/ `enforce` / `off` |
| `PI_WEB_NPM_REGISTRY` | 可选。更新检查与插件市场用的 npm 源（国内可设 `https://registry.npmmirror.com`） |
| `PI_WEB_ALLOW_SELF_UPDATE` | 可选。设为 `1` 允许容器内更新（见第 8 节） |
| `PI_WEB_RELEASES_DIR` | 可选。容器内更新安装新版本的位置，默认 `/opt/pi-web-releases` |
| `PI_WEB_IDLE_TIMEOUT_MS` | 可选。会话空闲卸载时间，默认 10 分钟 |
| `TZ` | 时区，影响会话文件时间戳与界面显示 |
| `PI_WEB_SKIP_VERSION_CHECK` | 镜像默认设为 1：镜像是自己构建的，版本号未必等于 npm 上的最新版 |

---

## 3. 1Panel / Nginx 侧配置

在网站的「自定义配置」（位于 `server {}` 内）里确认或加入：

```nginx
client_max_body_size 128m;      # 网页上传上限（应用侧允许 100MB）
proxy_buffering off;            # SSE：Agent 事件流、终端输出、安装日志
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto $scheme;   # 决定会话 cookie 的 Secure 属性
```

- HTTPS 用 1Panel 面板申请证书即可；`X-Forwarded-Proto` 必须传，否则 `Secure` cookie 不生效。
- 不要给本站开启「反向代理缓存」。
- 已知坑：上游写死容器名时，若 pi-web 没启动，OpenResty 重新加载配置可能失败。用 `--restart unless-stopped` 保证 pi-web 先起；必要时在自定义配置里改成变量形式：

```nginx
resolver 127.0.0.11 valid=10s;
set $piweb http://pi-web:30141;
proxy_pass $piweb;
```

---

## 4. 卷挂载（最容易踩坑的部分）

| 宿主路径 | 容器路径 | 必要性 |
| --- | --- | --- |
| `~/.pi/agent`（如 `/root/.pi/agent`） | 同路径 | **必须**。会话、模型配置、凭据、插件，以及 Pi Web 自己的数据库 `pi-web/pi-web.db` 都在这里 |
| 项目目录（如 `/srv`） | **同路径** | **必须**。见下 |

**项目目录必须挂到容器内的同一个绝对路径。** 原因有三条，任何一条不满足都会出问题：

1. 会话文件里记录的是**绝对工作目录**，路径在容器里不存在 → 打开会话后发消息、看文件、看 git 全部失败；
2. 文件访问白名单由会话里的 cwd 推导，路径变了就是 403；
3. git worktree 的 `.git` 文件里写死主仓库的绝对路径，路径不一致 git 直接报错。

所以 `-v /srv/app:/workspace/app` 这种「换个地方挂」的写法是错的；应该 `-v /srv:/srv`（挂项目父目录）。

**实测对照**（同一个挂载的 `~/.pi/agent`，里面有两个同级项目的会话）：

| 挂法 | `/api/files` 结果 | 文件浏览器 |
| --- | --- | --- |
| `-v /home/pi_agent_project:/home/pi_agent_project` | `pi-web` **200（35 项）**、`pi-web-theme-nier` **200（6 项）** | 看到 `Dockerfile`、`AGENTS.md`、`package.json` |
| `-v /home/pi_agent_project:/workspace`（换路径） | 两个都 **404 `Directory does not exist`** | 一个文件都没有 |
| `-v /home/pi_agent_project/pi-web:/home/pi_agent_project/pi-web`（只挂项目） | 本项目 200，兄弟目录 **404** | 本项目正常，其它项目仍缺失 |

三个结论：

1. **必须是同一绝对路径** —— 会话里存的是绝对 cwd，换个容器路径等于没挂。
2. **挂父目录，不要只挂某个项目** —— 同级项目（`pi-web-theme-nier`、`CF-Server-Monitor` 之类）和 Pi Web 创建的 worktree（`<仓库>-worktrees/<分支>`，与仓库同级）都在父子树里。
3. **读写挂载**（不要 `:ro`）—— Agent 要改代码、跑 git、开终端；容器内以 root 运行，新建文件在宿主上属主是 root（镜像里已设 `git config --global safe.directory '*'`，因此不会报 dubious ownership）。**不要挂 `/` 或 `/root`**：那等于把整机交给容器内的 Agent，挂项目父目录即可。

具体写法：

```bash
docker run -d --name pi-web --restart unless-stopped \
  --network 1panel-network \
  -v /root/.pi/agent:/root/.pi/agent \
  -v /home/pi_agent_project:/home/pi_agent_project \   # 同路径、父目录、读写
  -e PI_WEB_ALLOWED_HOSTS=pi.example.com \
  pi-web:latest
```

```yaml
# compose / 1Panel 容器编排
volumes:
  - /root/.pi/agent:/root/.pi/agent
  - /home/pi_agent_project:/home/pi_agent_project
```

1Panel：「容器 → 编辑 → 挂载」新增一条，宿主 `/home/pi_agent_project` → 容器 `/home/pi_agent_project`，类型 bind，**不勾只读**。改完重建/重启容器并刷新页面，提示即消失，文件浏览器、技能/插件的项目范围与 Agent 运行都会恢复。

不想挂也可以：在容器里新建会话时选一个确实存在的目录（`~/pi-cwd-YYYYMMDD` 或你挂进来的 `/srv`）。老的宿主路径会话仍可**浏览**（读 `.jsonl` 不需要目录存在），只是不能在里面跑 Agent —— 第 4.1 节列了各自的提示。

### 4.1 挂载了 `~/.pi/agent` 但没挂项目会怎样

`~/.pi/agent` 里存着会话文件，每个会话都记着自己的工作目录。宿主上的会话写的是宿主路径（例如 `/home/me/project`），容器里如果没按**同路径**挂载它，那个目录就是不存在的：

- **浏览会话**照常 —— 读 `.jsonl` 不需要目录存在。
- **模型列表不再失败**：`/api/models` 遇到不存在的项目目录时改用存在的目录（可读的项目 → 数据目录 → 进程工作目录），并在输入框上方显示「项目目录不可用：所选项目目录在服务器上不存在：… 模型列表已改从 … 加载」。以前这里会返回 400，界面上只看到红色的「模型错误 Directory does not exist: …」，看起来像模型坏了。
- **发消息会明确拒绝**：启动 Agent 必须有真实的工作目录，接口返回 `409 { code: "cwd_missing" }`，界面提示「会话的工作目录在服务端不存在：…」，并说明容器场景下的两种解法。
- **设置 → 技能 / 插件**只显示全局范围（装在数据目录与包管理里的那份），并在顶部说明「所选项目不在服务器上」（`cwdNotice`）。以前这里整块返回 403 `Access denied`，看起来像权限问题。
- **文件浏览器**显示「目录不存在：<项目路径> —— 如果 Pi Web 跑在容器里，请把该项目按相同路径挂载进容器」，不再是 `Not Found`；git 状态、文件索引与 worktree 切换同理（空结果 + 同一原因）。
- **项目信任**返回 `code: "cwd_missing"`，界面当作"没有可信任的资源"，不再往控制台写错误。

### 4.2 模型服务报错（余额、限流、密钥）

模型提供方失败时 pi 会把原始响应存成普通文本，例如：

```
Error: 402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"},"request_id":"…"}
```

Pi Web 会在对话里渲染成一张卡片：HTTP 状态、按类别给出的一句话解释（余额不足 / 凭据无效 / 限流 / 模型不存在 / 上下文超限 / 内容被拒 / 服务不可用）、提供方原文与 `request_id`，原始响应折叠在「原始响应」里。同一套措辞也用于提示条（notice），所以不会有两处不一致。

> 余额不足本身不是程序问题：请为该提供方充值，或在输入框里切换到别的模型。

两种解法：把项目按同路径挂进容器（`-v /home/me/project:/home/me/project`），或者不要挂载宿主 `~/.pi/agent`（用空卷从零开始，容器内新建的会话路径自然存在）。

可选挂载：

```bash
-v /root/.gitconfig:/root/.gitconfig:ro \
-v /root/.ssh:/root/.ssh:ro \
-v /root/.config/gh:/root/.config/gh:ro
```

这样容器里的 Agent 才能 clone / push。**不要挂 `/var/run/docker.sock`**：那等于把宿主的 root 交给容器内的 Agent。

其它注意事项：

- 容器内是 root，写宿主目录会产生 root 属主文件；镜像里已设置 `git config --system --add safe.directory '*'`，避免 git 报 dubious ownership。
- SELinux 宿主（CentOS/Rocky 等）需要给卷加 `:z`（或 `--security-opt label=disable`）。
- macOS / Windows 宿主的 bind mount 性能与大小写行为不同，且宿主盘符路径无法与容器内路径一致，建议整套在容器内运行。
- 容器内 `apt install` 的东西是临时的：重建镜像/容器就没了。常用工具请写进 Dockerfile；临时用一次可以直接装。

---

## 5. 首次初始化

1. 浏览器打开站点，未初始化时会自动跳到 `/init`；
2. 在服务器上查看验证码：`docker logs pi-web | grep "setup code"`；
3. 输入验证码 + 设置密码（至少 10 位）→ 自动登录。

想免去查日志：给容器加 `-e PI_WEB_INIT_TOKEN=你的固定验证码`，或用命令行完成初始化：

```bash
docker exec pi-web curl -fsS -X POST http://127.0.0.1:30141/api/web-auth/init \
  -H 'Content-Type: application/json' \
  -d '{"password":"足够长的密码","setupCode":"你的固定验证码"}'
```

登录后的账号与安全页在 `/user`：改密码、查看/踢出登录设备、查看登录与初始化审计日志。

---

## 6. 数据与备份

需要备份的只有一个目录：`~/.pi/agent`。其中 Pi Web 自己的数据是 `~/.pi/agent/pi-web/`：

- `pi-web.db`：账号、登录会话、API 令牌、审计日志、各类缓存；
- `secret.key`（0600）：两步验证密钥的加密密钥，**必须和数据库一起备份** —— 只恢复数据库会导致动态码无法校验（页面会明确报错，而不是假装验证码错误）。

```bash
# 一致性备份（SQLite 在 WAL 模式下不要直接拷 .db 文件）
docker exec pi-web sh -c 'sqlite3 /root/.pi/agent/pi-web/pi-web.db "VACUUM INTO \"/root/.pi/agent/pi-web/backup.db\""'
# 然后连同会话目录一起打包
tar czf pi-agent-backup.tar.gz -C /root/.pi agent
```

恢复：停容器 → 用备份覆盖 `~/.pi/agent` → 启动容器。

---

## 7. 更新

### 7.1 宿主重建（默认，最省心）

```bash
cd pi-web && git pull
docker build -t pi-web:latest .
docker rm -f pi-web
docker run -d ... # 与首次启动相同的参数
```

### 7.1.x pi agent：安装 / 更新 pi CLI

设置 → 更新 → **Pi Agent** 卡片管理两样东西，它们都叫"pi agent"，但更新方式不同：

- **运行时（会话实际使用）**：随 Pi Web 构建固定的 SDK（`@earendil-works/pi-coding-agent`），**跟着应用一起更新**（重建镜像 / 容器内自更新 / npm 重装），面板只显示版本与最新版，不单独热更 —— 单独换 SDK 可能改变会话格式与提示词行为。
- **pi CLI**：面板的「安装 pi CLI」会把 CLI 装进**数据目录** `~/.pi/agent/pi-cli/`（就是挂载卷，重建容器不丢），并尽量在 `/usr/local/bin/pi` 放一个符号链接，之后 `docker exec -it pi-web pi` 可用。Docker 部署时面板还会显示**宿主机**的命令 —— 容器内无法替宿主机操作：

```bash
npm install -g @earendil-works/pi-coding-agent@latest   # 在宿主机上执行
```

检测顺序：PATH 上的 `pi` → 应用自带的 `node_modules/.bin/pi` → 数据目录里的安装；「更新 pi CLI」在版本落后于 npm 最新版时可用。CLI 更新不影响运行中会话（会话用的是运行时 SDK）。

### 7.2 容器内更新（可选，不重建容器）

设置 `PI_WEB_ALLOW_SELF_UPDATE=1` 后，「更新」页面会出现「在容器内更新」按钮：

```bash
docker run -d --name pi-web --restart unless-stopped \
  --network 1panel-network \
  -v /root/.pi/agent:/root/.pi/agent \
  -v pi-web-releases:/opt/pi-web-releases \   # 建议挂载，重建容器后仍保留已装版本
  -e PI_WEB_ALLOW_SELF_UPDATE=1 \
  pi-web:latest
```

工作方式：从 npm（可换镜像源）安装 `@agegr/pi-web@<版本>` 到 `/opt/pi-web-releases/<版本>`，然后把 `current` 软链接指向它，最后退出进程让容器重启 —— 入口脚本会跟随 `current` 启动。它自带三项检查：只接受稳定版本号、校验 `engines.node` 是否满足（不满足会明确拒绝并提示重建镜像）、安装失败时不动当前版本。旧版本保留在磁盘上，页面里可一键回退。

注意事项：

- **它安装的是 npm 上已发布的版本**。如果你是从本地检出构建并带着尚未发布的改动，开启它会把运行中的版本换成已发布版（页面提供「回到镜像自带版本」按钮，删除 `current` 软链接后重启即可恢复）。
- 需要容器可访问 npm 源（国内建议配 `PI_WEB_NPM_REGISTRY`）。
- 没有挂载 `/opt/pi-web-releases` 时，`docker restart` 仍会生效，但 `docker rm` 后重建会回到镜像内自带的版本。
- 系统级依赖（apt 包、Node 大版本）无法通过这种方式更新，那种情况仍需重建镜像。

---

## 8. 插件市场

「插件市场」页面直接读取 pi.dev 的包目录（`PI_WEB_MARKET_BASE_URL` 可换源），安装动作复用现有的插件安装通道，因此需要选择一个项目作为工作目录上下文；全局安装对所有项目生效。目录页缓存 6 小时、详情页 24 小时，pi.dev 不可达时页面会显示缓存并标注。

## 9. 排障

| 现象 | 原因/处理 |
| --- | --- |
| 访问域名 403 `Untrusted request` | `PI_WEB_ALLOWED_HOSTS` 没填或域名不匹配 |
| 一直停在 `/init` 且提示验证码错误 | 验证码 10 分钟轮换，重新 `docker logs pi-web \| grep "setup code"` |
| 页面能开但接口 401 | 浏览器 cookie 过期或已被「退出所有设备」作废，重新登录 |
| 启动即 503 `cannot open its database` | `~/.pi/agent` 不可写（卷权限/属主），或挂载路径与 `PI_CODING_AGENT_DIR` 不一致 |
| 会话能看但打不开项目 / 文件浏览器「目录不存在：…」 | 项目目录没有按**同路径**挂载。第 4 节有三组实测对照；按「同路径 + 父目录 + 读写」重挂即可 |
| 设置 → 技能 / 插件提示「所选项目不在服务器上」 | 同上。全局范围的技能与插件仍会列出，只是没有项目那一半 |
| 对话里红色「模型服务报错 HTTP 402 … insufficient balance」 | 与挂载无关：模型提供方账号余额不足，充值或换个模型；卡片里的 `request_id` 可给提供方核对 |
| 容器里 git 报 dubious ownership | 应已由镜像内 `safe.directory '*'` 处理；自定义镜像时记得保留 |
| `docker build` 在 `next build` 阶段 JavaScript heap out of memory | VPS 内存偏小。先确认是这两个 Dockerfile 的构建（已含 §1.0.2 的三层缓解）；仍不够就 `--build-arg NEXT_BUILD_MAX_OLD_SPACE=1024` 或加大 swap/内存 |
| SSE 长时间无输出 | 反向代理未关闭 buffering 或超时太短，见第 3 节 |
