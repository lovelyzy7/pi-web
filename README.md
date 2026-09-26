# Pi Web

[English](./README.en.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

[pi coding agent](https://github.com/earendil-works/pi) 的本地浏览器界面。Pi Web 使用与 pi 完全相同的本地配置与会话文件，因此你可以在浏览器里浏览与继续对话、运行 Agent 回合、配置模型与资源、查看项目文件。

**[在线演示 →](https://agegr.github.io/pi-web/)** 真实的 Pi Web 界面完全在浏览器里运行，带有示例会话、文件与模型。无需安装，回复是预置文本，不会调用任何模型。

![Pi Web 显示一个包含结构化 Markdown、工具调用与项目导航的 pi 会话](https://raw.githubusercontent.com/lovelyzy7/pi-web/main/docs/screenshot2.png)

## 功能

- **会话工作区**：按项目分组的会话浏览、继续、重命名、导出与删除，并显示运行状态、上下文用量、费用与压缩详情。
- **两种分支方式**：**新建会话**（New session）从某条历史消息派生出一个独立会话文件；**从此处编辑**（Edit from here）在当前会话内部创建分支。
- **项目文件工具**：浏览与上传文件、查看 Git 差异，预览源码、Markdown、图片、音频、PDF 与 DOCX，并自动刷新。
- **Git worktree**：在侧边栏切换检出目录，同时把同一仓库的会话归组在一起。
- **网页端配置**：无需离开 Pi Web 即可管理提供方登录与 API Key、模型、模型测试、插件包与技能。
- **插件市场与更新**：浏览 pi.dev 官方包目录并直接安装，查看 Pi Web、pi SDK 与插件的当前/最新/待更新版本 —— 两者都在设置弹窗里，与「模型」「插件」并列。
- **英文、简体中文与繁体中文界面**：初次使用跟随浏览器语言，顶栏可随时切换。
- **5 套内置配色 + 跟随系统**，在设置弹窗的「主题」分区里选择。
- **第三方主题**：纯 CSS 主题包，可从 GitHub 仓库或本地目录加载，文件由本服务反代提供；支持明/暗两套变体、JSON 清单主题商店（含版本与更新提示）、以及在真实界面里预览。设置里的主题分区会**探测**数据目录、`PI_WEB_THEME_ROOTS` 与当前项目 `themes/` 下的主题，并支持把它们**导入**到数据目录（本仓库 `themes/slate/` 就是一个示例）。开发方式见[主题开发文档](./docs/theme-development.md)，校验用 `node bin/pi-web-theme.js check ./my-theme`。

## 快速开始

Pi Web 需要 Node.js 22.19.0 或更高版本。先用 `node --version` 确认版本，然后运行：

```bash
npx @agegr/pi-web@latest
```

服务就绪后 CLI 会自动打开浏览器；如果没有打开，请访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 默认只监听 `127.0.0.1`。

如果还没有配置任何模型提供方，打开 **模型** 面板登录或填入 API Key。

全局安装 `pi-web` 命令：

```bash
npm install -g @agegr/pi-web@latest
pi-web
```

升级时用 `Ctrl+C` 停止进程后重新执行安装命令；卸载执行 `npm uninstall -g @agegr/pi-web`。

## 配置

端口与监听地址：命令行参数优先于同名环境变量。`--no-open` 或 `PI_WEB_NO_OPEN=1` 可关闭自动打开浏览器。`pi-web --help`（或 `-h`）打印启动选项后退出，不启动服务；未知参数会直接报错退出。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项后退出 | — |
| `--port <port>`、`-p <port>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <host>`、`-H <host>` 或 `PI_WEB_HOSTNAME` | 监听地址 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 关闭 Pi Web 更新检查 | 未设置 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的精确代理/自定义主机名，逗号分隔 | 未设置 |
| `PI_WEB_PASSWORD` | 改用环境变量密码而不是内置账号；API 客户端可使用用户名为 `pi` 的 Basic Auth | 使用数据库中的账号 |
| `PI_WEB_INIT_TOKEN` | 固定首次初始化验证码，而不是从日志中读取 | 随机生成并打印在启动日志 |
| `PI_WEB_CSP` | Content-Security-Policy 模式：`report-only`、`enforce` 或 `off` | `report-only` |
| `PI_WEB_NPM_REGISTRY` | 更新检查与插件市场使用的 npm 源 | `https://registry.npmjs.org` |
| `PI_WEB_MARKET_BASE_URL` | 插件市场目录来源 | `https://pi.dev` |
| `PI_WEB_THEME_STORE_URL` | 第三方主题商店的 JSON 清单地址 | 未设置（商店关闭） |
| `PI_WEB_THEME_ALLOW_ANY_URL` | 允许非 GitHub 的主题来源 | 关闭 |
| `PI_WEB_THEME_ROOTS` | 允许读取本地主题的额外目录，逗号分隔 | 未设置 |
| `PI_WEB_ALLOW_SELF_UPDATE` | 允许服务把新版本安装到 `PI_WEB_RELEASES_DIR` 并自行重启 | 关闭 |
| `PI_WEB_RELEASES_DIR` | 容器内更新安装新版本的位置 | `/opt/pi-web-releases` |
| `PI_WEB_SESSION_TTL_MS` | 空闲会话有效期（毫秒） | `2592000000`（30 天） |
| `PI_WEB_IDLE_TIMEOUT_MS` | 会话空闲卸载时间（毫秒），上限 `2147483647`；`0` 表示不因空闲卸载；非法或越界值使用默认值 | `600000`（10 分钟） |

示例：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 账号与首次初始化

Pi Web 在 `~/.pi/agent/pi-web/` 下的 SQLite 数据库中保存唯一的使用者账号。尚未初始化时，访问站点会自动进入 **/init**，要求输入启动日志里打印的初始化验证码：

```bash
pi-web --hostname 0.0.0.0          # 日志会打印：First-run setup code: XXXX-XXXX
# 也可以自己固定验证码，同时便于脚本化初始化：
PI_WEB_INIT_TOKEN='我的验证码' pi-web --hostname 0.0.0.0
```

之后用 `/login` 登录。设置弹窗里的**账号**分区（深链接 `/user`）就是账号与安全页：修改密码、开启**两步验证**（TOTP，含一次性恢复码）、创建 **API 令牌**、查看并踢出登录设备、查看初始化与登录审计日志。会话是随机令牌（数据库里只存摘要），因此可以逐台退出登录；账号数据随 `~/.pi/agent` 一起在重启后保留。

开启两步验证后有两处行为变化：

- 登录先输入密码，再输入动态码（或使用恢复码）；
- **HTTP Basic 认证会被拒绝**（Basic 无法携带动态码），请改用 API 令牌：

```bash
curl -H "Authorization: Bearer pi_pat_…" https://pi.example.com/api/sessions
```

安全响应头（Content-Security-Policy 默认只报告不拦截）见 [docs/docker.md](./docs/docker.md)。

### 远程访问

监听非回环地址会暴露一个可执行高权限操作的智能体。请务必设置足够长的密码，并在完成 `/init` 前保管好初始化验证码：

```bash
pi-web --hostname 0.0.0.0
```

密码认证不会加密连接。不要通过明文 HTTP 将 Pi Web 暴露到互联网；远程访问应使用可信反向代理提供 HTTPS，或通过可信 VPN。如果反向代理传递外部主机名，请把该名称精确加入 `PI_WEB_ALLOWED_HOSTS`。这个白名单不会改变 Pi Web 的监听地址。

### Docker 部署

两个 Dockerfile：`Dockerfile`（国内源，默认）与 `Dockerfile.global`（海外版，全部走官方源），除镜像源外完全一致；构建时自动识别 VPS 架构（amd64 / arm64 / armhf）。完整 Ubuntu 镜像、卷挂载规则与 1Panel 反向代理说明：[docs/docker.md](./docs/docker.md)。

```bash
docker build -t pi-web:latest .                      # 国内 VPS
docker build -f Dockerfile.global -t pi-web:latest . # 海外 VPS
```

**一条容易踩的坑**：项目目录必须按**同一绝对路径**、挂在**项目父目录**上（`-v /srv:/srv`），会话文件里存的是绝对工作目录 —— 换个路径挂（`-v /srv/app:/workspace/app`）等于没挂。没挂对时 Pi Web 不会伪装成正常：文件浏览器会说「目录不存在：<路径>」，技能/插件只显示全局范围，发消息会告诉你「会话的工作目录在服务端不存在」。三组实测对照见文档第 4 节。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @agegr/pi-web@latest
```

Windows PowerShell：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @agegr/pi-web@latest
```

## 说明

- **Agent 数据**：Pi Web 默认从 `~/.pi/agent` 读取 pi 数据，包括 `sessions/<编码后的 cwd>/<时间戳>_<uuid>.jsonl` 下的会话文件。可用 `PI_CODING_AGENT_DIR` 指定其它 pi agent 目录。
- **文件系统访问**：Pi Web 需要能读取 agent 数据目录，以及各会话记录的工作目录。若要共用已有会话，请让 Pi Web 与 pi 运行在同一个文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置与凭据存储，两个界面的改动互相可见。
- **文件访问边界**：文件浏览器只限于在 Pi Web 中选择过的工作目录，以及它已知的项目/会话根目录，它不是通用的文件系统浏览器。
- **Git worktree**：切换器可见性、创建与删除行为见 [Pi Web 中的 worktree](./docs/worktrees.md)。

### 下游集成的会话右键菜单

Electron 壳等下游集成无需改动 `SessionSidebar` 即可提供会话行右键菜单：监听可取消的 `pi-web:session-row-contextmenu` 浏览器事件，并在自己处理时同步调用 `preventDefault()`。

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

`detail` 包含 `id`、`path`、`cwd`、可选的 `name`、指针坐标，以及用于「操作改变了会话列表」时刷新界面的 `refresh()`。如果没有任何监听者取消该事件，Pi Web 保留浏览器原生右键菜单。这个钩子完全在浏览器侧，与 Pi agent 扩展无关。

### 扩展会话存活租约

带有后台游离任务的 Pi 扩展（服务端）可以通过带版本号的全局注册表，阻止会话因空闲被自动卸载：

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

每个活跃的扩展会话注册一次，并在会话关闭、被替换或重新加载时调用返回的幂等 `release()`。`isActive` 必须同步、轻量，并且只针对传入的确切 session id 或文件。提供方出错时会保守地保留该会话。这个租约只影响「空闲自动卸载」；显式关闭与 Stop 兜底清理依然优先。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发**不要**运行 `next build` 或 `npm run build`：它会写入 `.next/` 并可能干扰开发服务器，构建留给发布流程。

贡献者指南：[国际化](./docs/i18n.md) 与 [发布流程](./docs/release.md)。

## 仓库结构

```text
app/             Next.js 界面与 API 路由
components/      React 界面组件
hooks/           客户端状态与交互 hooks
lib/             会话、agent、模型、文件、Git 与安全逻辑
public/          静态资源与 PWA 文件
bin/             npm CLI 入口与启动参数解析
docs/            面向用户与贡献者的专题文档
themes/          主题模板与说明
demo/            发布到 GitHub Pages 的静态浏览器演示（见 demo/README.md）
```

架构说明与详细文件地图见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
