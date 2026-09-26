# pi-web-theme-nier

**NieR:Automata —— 寄叶地堡终端（YoRHa Bunker Terminal）** 风格的 Pi Web 第三方主题。

配色、边框、括号式标题与整套 NieR 光标移植自 CF-Server-Monitor 的 NieR 主题
（其设计系统来自 `lunar-base` 的 `automata.css`）。这里只移植视觉层：Pi Web 主题是 CSS，不是应用。

本目录是**仓库内的项目主题示例**：放在 `<项目>/themes/` 下，设置面板的「本地主题」分区会自动探测到它，无需手输路径。同样的主题放在仓库外时，用法见下文的 `local:` 路径。

## 内容

```
theme.json         # 清单：light 基底，light/dark 变体
theme.css          # 共享层：NieR 光标、4px 画布网格、括号式标题
theme.light.css    # 米白配色（画布 #cfc7b0，炭黑 #1a1814）
theme.dark.css     # 地堡配色（画布 #0e0d0a，骨白 #e6dfc9）
assets/            # cursor-default.png、cursor-pointer.png
```

| 元素 | 浅色 | 深色 |
| --- | --- | --- |
| Canvas `--bg` | `#cfc7b0` | `#0e0d0a` |
| Panel `--bg-panel` | `#d8d1bb` | `#16140f` |
| Text `--text` | `#2c2922` | `#e6dfc9` |
| Accent (the only "brand" colour) | `#1a1814` | `#e6dfc9` |
| Failure `--danger` | `#6b0a0a` | `#cf7160` |
| Healthy `--success` | `#3a4d24` | `#86a762` |

## 安装

- **就在本仓库里**（推荐）：选中 pi-web 项目，打开 **设置 → 主题 → 本地主题**，条目「NieR:Automata」会带着来源标签 `项目` 出现，点 **应用**；刷新后即是该主题。想让它随数据目录持久化、与原目录解耦，用 **导入** 复制到 `~/.pi/agent/themes/`。
- **在仓库外**：打开 **设置 → 主题 → 第三方主题**，粘贴下面任一种来源：

```
local:/absolute/path/to/pi-web-theme-nier
https://github.com/<you>/pi-web-theme-nier/tree/<commit-sha>
```

使用本地目录时，服务端会要求批准一次（**Approve …** 按钮），除非该路径已位于可浏览的项目内、
`~/.pi/agent/themes/` 或 `PI_WEB_THEME_ROOTS` 中。用 **校验** 查看校验报告，**试用** 在当前页预览，
**应用** 保留它。在浅色与深色配色之间切换会切换对应的变体样式表。

## 修改

```bash
# 在本仓库根目录执行
node bin/pi-web-theme.js check themes/pi-web-theme-nier
```

每个选择器都必须以 `html[data-pi-theme="custom"]` 开头；只能覆盖文档化的变量；外链会被拒绝
（需要的东西打包进 `assets/` 并用相对路径引用）。完整契约见
[Pi Web 主题开发文档](../../docs/theme-development.md)。

## 致谢

- 设计语言：NieR:Automata（© PlatinumGames / Square Enix），经由 `lunar-base` 的
  `automata.css` 与 CF-Server-Monitor 的 NieR 主题转译。
- 光标图片沿用同一来源。
- 与其借鉴的项目一样，以 MIT 许可发布。
