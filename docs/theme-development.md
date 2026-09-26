# 编写 Pi Web 主题

Pi Web 主题**是数据，不是代码**：一个清单加一份样式表，用来覆盖 CSS 变量。没有 JavaScript 可执行、没有页面被替换，浏览器也不会向你的主机发任何请求 —— 由服务端取回你的文件、校验，再从自己的源提供。

## 主题长什么样

```
my-theme/
├── theme.json          # 清单（必需）
├── theme.css           # 样式表（必需；文件名可通过 `styles` 配置）
├── theme.light.css     # 可选：按模式拆分的变体
├── theme.dark.css
├── preview.png         # 可选封面
└── assets/             # 可选图片与字体，用相对路径引用
    └── grain.svg
```

以本仓库的 [`themes/_template/`](../themes/_template) 为起点。

## theme.json

```json
{
  "schema": 1,
  "id": "emerald",
  "name": "Emerald",
  "version": "1.0.0",
  "author": "你的名字",
  "homepage": "https://github.com/you/pi-web-theme-emerald",
  "license": "MIT",
  "piWeb": ">=0.9 <1.0",
  "base": "dark",
  "description": { "en": "Emerald palette.", "zh-CN": "翡翠配色。" },
  "variables": ["--bg", "--accent"],
  "styles": ["theme.css"],
  "variants": { "light": "theme.light.css", "dark": "theme.dark.css" },
  "assets": ["assets/grain.svg"]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `schema` | 是 | 必须为 `1`。更新的 schema 会被拒绝，而不是猜测其含义。 |
| `id` | 是 | 小写字母、数字与连字符，最多 41 个字符。 |
| `name` | 是 | 显示在设置面板中。 |
| `author` | 否 | 显示在名称旁边。 |
| `version` | 否 | `1.2.3` 形式，显示在面板中；主题商店用它判断是否有更新。 |
| `base` | 是 | `light` 或 `dark`。Pi Web 会在你的覆盖之下应用对应的内置配色。 |
| `piWeb` | 否 | 兼容区间（`>=0.9 <1.0`、`^0.9.0`、`~0.9.0`）。超出区间只会警告，不会拒绝。 |
| `description` | 否 | 按语言给出文案（界面会使用 `en`、`zh-CN`、`zh-TW`）。 |
| `variables` | 否 | 供人阅读的说明；真正的来源是你的 CSS。 |
| `styles` | 否 | 默认 `theme.css`。其它文件必须放在 `assets/` 下。 |
| `variants` | 否 | 模式 → 样式表，例如 `{ "light": "theme.light.css", "dark": "theme.dark.css" }`。 |
| `assets` | 否 | 主题用到的 `assets/` 下文件。 |

## theme.css

**每个选择器都必须以 `html[data-pi-theme="custom"]` 开头。** 这个前缀不是装饰：Pi Web 在 `data-theme` 上应用内置配色（light、dark、mist、rose、pine），你的样式表是压在它**上面的一层**，因此带 `html` 元素选择器才能保证无论样式表加载顺序如何都由你胜出。

```css
html[data-pi-theme="custom"] {
  --bg: #0b0f14;
  --bg-panel: #111823;
  --accent: #4ade80;
  --accent-contrast: #06210f;
  --text: #e8f1ee;
}

/* 窄屏可以不同 —— 外层依然需要作用域。 */
@media (max-width: 600px) {
  html[data-pi-theme="custom"] { --bg-panel: #0d131a; }
}

/* 打包进来的资源用相对路径引用。 */
html[data-pi-theme="custom"] {
  background-image: url(assets/grain.svg);
}
```

只覆盖你关心的变量即可，未覆盖的沿用内置值。允许 `@media`、`@supports`、`@container`、`@layer`、`@keyframes`、`@charset` 以及 `@font-face`（源必须是打包文件或 `data:`）。其余一律拒绝：

| 被拒绝 | 原因 |
| --- | --- |
| 未带作用域前缀的选择器 | 主题不能隐藏或改写登录/初始化页面，也不能改写自己所在的对话框。 |
| `@import`、`url(https://…)`、远程字体与图片 | 浏览器不得与第三方通信；文件由服务端反代。主题需要的东西必须打包。 |
| `expression(`、`javascript:`、`behavior:`、`-moz-binding` | 历史遗留的可执行向量。 |
| `theme.css` 超过 512 KiB、单个资源超过 2 MiB | 防止主题变成拒绝服务。 |

未知变量只会产生警告；属于用户自身设置的变量（`--chat-content-max-width`、`--chat-content-font-size`、`--sidebar-width`、`--right-panel-width`、`--chat-font-size-offset`、`--font-mono`）会被忽略，因此主题无法悄悄改写聊天外观滑块。

## 明暗两套配色（变体）

主题可以为每个模式各带一份样式表。在清单里声明后，Pi Web 会挂载与用户解析出的模式（主题分区里的 浅色/深色/跟随系统）匹配的那份，并在模式切换时替换：

```json
{
  "base": "light",
  "variants": { "light": "theme.light.css", "dark": "theme.dark.css" }
}
```

- `theme.css` 仍是共享层（光标、纹理、两种模式都需要的东西）；变体也可以直接重复完整配色。
- **每个声明的变体都必须存在并通过与基础样式表相同的校验** —— 缺失变体或越界选择器会拒绝整个主题，而不是只在某一个模式下生效一半。
- `base` 是服务端首屏渲染所用的模式，因此页面不会以错误的配色开头；存在变体时，用户选择的明/暗从客户端第一次渲染起就生效。

## 可主题化的变量

| 分组 | 变量 |
| --- | --- |
| 表面 | `--bg`、`--bg-panel`、`--bg-hover`、`--bg-selected`、`--bg-subtle`、`--border` |
| 文字 | `--text`、`--text-muted`、`--text-dim` |
| 强调 | `--accent`、`--accent-hover`、`--accent-contrast` |
| 消息气泡 | `--user-bg`、`--assistant-bg`、`--tool-bg` |
| 状态 | `--danger`、`--success`、`--warning`、`--info` |
| 终端外框 | `--terminal-bg`、`--terminal-fg`、`--terminal-cursor` |
| 扫码 | `--qr-bg`（两步验证二维码底色，需保持足够亮以便扫描） |

`--accent-contrast` 是绘制在 `--accent` 之上的文字颜色；当 `--text`/`--bg` 或 `--accent-contrast`/`--accent` 的对比度低于 WCAG AA 的 4.5:1 时，校验器会给出警告。

## 本地主题：放在哪里，怎么导入

Pi Web 会**探测**已知位置里的本地主题，不需要你逐个粘贴路径：

| 位置 | 说明 |
| --- | --- |
| `~/.pi/agent/themes/<名字>/` | **托管目录**。导入的目标，随数据目录一起持久化（容器里就是挂载卷）。 |
| `PI_WEB_THEME_ROOTS` 列出的目录 | 你自己声明的主题目录，逗号分隔。 |
| `<项目>/themes/<名字>/`、`<项目>/.pi/themes/<名字>/` | **项目内主题**：主题跟着代码走，随项目切换出现在列表里。只有当前可浏览的项目会被扫描。 |

每个候选目录都必须有 `theme.json`；以 `_` 或 `.` 开头的目录会被跳过（`_template` 之类不是主题）。设置面板的 **主题** 页把探测结果与商店条目放在**同一个卡片网格**里，并给每个主题三个动作：**应用**、**在真实界面预览**、**导入**（已在托管目录里的则是 **移除**）。

**导入**会把主题复制到 `~/.pi/agent/themes/<theme.json 里的 id>/`，因此之后可以删掉原目录，主题也不会因为换机器、删检出目录而消失。导入前一律先跑完整的服务端校验，坏的清单、未加作用域的选择器不会进到托管目录。几条硬规则：

- 只有 Pi Web 本来就能读取的目录可以被导入（可浏览的项目、托管目录、`PI_WEB_THEME_ROOTS`，或在面板里批准过一次的目录）。
- 目录里不能有符号链接 —— 一个指向别处的链接会让「导入」变成复制任意文件，因此直接拒绝。
- 整个目录上限 32 MiB。
- 同名（同一个 `id`）已存在时返回「已存在」，面板会给出 **覆盖导入**，这也是手动更新一个已导入主题的方式。

**移除**只会删除托管目录里**直接位于其下**的目录，因此手写的项目主题不会被面板误删。

把主题放进项目的 `themes/<名字>/` 就能被探测到，本仓库里有两个可直接应用的例子：`themes/slate/`（深色 + 浅色变体的最小样板）与 `themes/pi-web-theme-nier/`（实际的 NieR 主题，双变体 + 自定义光标）。

## 试用

两种方式让 Pi Web 指向一个主题：

- **开发期间** —— `local:/absolute/path/to/my-theme`。文件每次请求都从磁盘读取，改完刷新即可。目录需要位于可浏览的项目内、`~/.pi/agent/themes/`、`PI_WEB_THEME_ROOTS` 列出的目录，或在面板里被批准过一次（服务端拒绝该路径时会出现 **Approve …** 按钮）。容器里最方便的做法就是把主题放进挂载的 `~/.pi/agent/themes/`，然后引用 `local:/root/.pi/agent/themes/my-theme`。
- **分享** —— 把主题推到公开的 GitHub 仓库，然后使用 `https://github.com/you/pi-web-theme-emerald/tree/main`。分支每小时重新获取；**commit sha** 会按不可变缓存，这也是可复现的写法：

  ```
  https://github.com/you/pi-web-theme-emerald/tree/8f3c1a…  （40 位十六进制）
  ```

在设置面板打开 **主题 → 第三方主题**，粘贴来源（本地主题通常直接从 **本地主题** 分区里点 **应用**），然后：

1. **校验**（Check）会在不改变任何东西的前提下解析并校验，列出发现的问题。
2. **试用**（Try it）只把样式表应用到当前页面 —— 什么都不保存，*结束试用*（或刷新）即恢复。
3. **应用**（Apply）会保存设置；页面刷新后由服务端渲染该主题。
4. **还原内置配色**（Use built-in palettes）会移除它。

## 在真实界面里预览

面板里的 **试用** 会在当前页替换样式表。需要更诚实的检查时 —— 真实结构、真实滚动容器 —— 用 **在真实界面预览**（Preview in the app）：它会打开 `/api/themes/preview?source=…`，先完整解析并校验主题，再把来源写进一个短期 cookie 回到 Pi Web，由服务端按该主题渲染。它不会被应用；`/api/themes/preview?off=1`（或等 cookie 过期）即可恢复。

**预览失败时不会发生任何改变**：服务端在重定向前就解析主题，读不出来（清单不合法、选择器没作用域、仓库取不到、路径不在可读范围内）就在新标签页里给出原因，而不是让你看到一个"没上主题"的正常页面。预览的样式表如果加载失败，页面只会丢掉这次预览 —— 它**不会**触发下面那条逃生通道，因此一次失败的预览不会把整个浏览器的主题关掉。

## 校验主题

```bash
# 在本仓库检出目录中
node bin/pi-web-theme.js check /path/to/my-theme
node bin/pi-web-theme.js check /path/to/my-theme --json
```

CLI 运行的是**与服务端完全相同的校验器**，因此在这里通过的主题在那边也会被接受。它会报告错误（未加作用域的选择器、外链、文件缺失）与警告（未知或保留变量、对比度不足）。它需要 Node 22.19+（类型剥离），与 Pi Web 自身的运行要求一致。

## 主题商店

商店是一个列出主题的 JSON 清单，用户可以浏览而不是逐个粘贴 URL：

```json
{
  "schema": 1,
  "themes": [
    {
      "id": "emerald",
      "title": "Emerald",
      "author": "you",
      "tags": ["dark", "green"],
      "description": { "en": "Green accent, dark base.", "zh-CN": "深色底、绿色强调。" },
      "cover": "https://raw.githubusercontent.com/you/pi-web-theme-emerald/main/docs/preview.png",
      "url": "https://github.com/you/pi-web-theme-emerald",
      "branch": "main",
      "version": "1.0.0"
    }
  ]
}
```

这正是 CF-Server-Monitor 商店已经在用的结构，因此现有商店无需修改即可使用；`url` 也可以是完整的 `tree/<ref>` 地址或 `local:` 路径。用 `PI_WEB_THEME_STORE_URL` 或在设置面板里填写地址（环境变量优先）把 Pi Web 指向它。清单由服务端取回并缓存五分钟，封面图同样经服务端反代；每个条目都会走**与手输 URL 完全相同的来源校验** —— 商店无法给主题任何校验器本会拒绝的权限。

**版本。** 在条目里加可选的 `"version": "1.2.0"`，卡片就会显示它。没写也没关系：Pi Web 会去读每个主题自己的 `theme.json`（并发 4、缓存一天），因此早于该字段的商店也能显示版本。已应用的主题落后于商店副本时，卡片会出现更新提示，按钮变成 **更新**，再次应用同一个来源（分支 ref 会重新读取，commit ref 本身不可变）。

## 主题把页面弄坏时

三条逃生通道，按绝望程度排列：

1. 在任意 URL 后加 `?theme=off` —— 本设备停用主题一天，参数会自动从地址栏清除。
2. **主题 → 主题把界面弄坏了？ → 在本设备关闭主题**（面板还打得开时可用）。
3. 从应用外部删除该设置：
   ```bash
   sqlite3 ~/.pi/agent/pi-web/pi-web.db "delete from app_settings where key = 'theme:active'"
   ```

**回来。**关闭状态存在 cookie（`pi-web-theme-off`）里，主题分区会读到它并在顶部显示「本浏览器上已关闭主题」，带一个 **重新启用主题** 按钮 —— 清掉 cookie 并刷新。样式表加载失败会自动设置同一个 cookie（否则一个坏主题会在每次刷新时重新破坏界面），所以看到这条提示通常意味着曾经有主题加载失败过。

登录、初始化与错误页面从不加载主题，因此坏主题不可能把你锁在登录之外。

## 反代是怎么工作的

```
主题仓库 ──fetch──▶ Pi Web ──同源──▶ 浏览器
   （或本地目录）      （校验 + 缓存）
```

- 只有 `theme.json`、`theme.css`、`theme.<模式>.css` 与 `assets/` 下的文件可以被取用；路径段经过白名单校验（`[A-Za-z0-9._-]`，禁止 `.`/`..`），因此代理无法被指向其它文件。
- 来源仅限 `github.com` 的 tree 地址与本地目录。其它 HTTPS 主机需要 `PI_WEB_THEME_ALLOW_ANY_URL=1`，且回环/内网地址永远拒绝（代理不能变成 SSRF 工具）。
- 文件按**路径**寻址（`/api/themes/asset/theme.css`、`/api/themes/asset/assets/cursor-default.png`），这样样式表里的相对 `url(assets/…)` 才能正确解析。
- 响应自带 `X-Content-Type-Options: nosniff` 与独立的安全策略，应用的 CSP 保持 `style-src 'self'` —— 不会为主题放宽任何东西。
- `/login` 与 `/init` 从不加载主题：它们是主题出问题时的回退通道。
- 解析结果与文件内容缓存在数据库里，因此重启不会重新拉取，离线时已应用的主题依然可用。

## 发布前检查清单

- [ ] `theme.json` 可解析、`schema: 1`、填写了 `base`。
- [ ] 每个选择器都以 `html[data-pi-theme="custom"]` 开头。
- [ ] 没有 `@import`、没有远程 URL；资源都在 `assets/` 下。
- [ ] 正文在 `--bg` 上、强调按钮文字在 `--accent` 上的对比度都达标（≥ 4.5:1）。
- [ ] `theme.css` 小于 512 KiB，单个资源小于 2 MiB。
- [ ] 用 **试用** 在浅色与深色两套内置配色下都看过。
- [ ] 打过 tag，并公布该 commit 的 URL 以便复现安装。
