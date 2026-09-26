# Pi Web 演示

Pi Web 界面的静态、无后端版本，用于 GitHub Pages。它使用真实的 Pi Web 组件，并由浏览器内的 mock 回应界面发出的每一个 `/api/*` 请求，因此访问者无需安装任何东西就能点开会话、文件、模型与设置。

## 访问者能看到什么

- **会话**：一组教学对话（跟随界面语言，英文或简体中文），讲解布局、文件与 `@` 提及、模型与推理等级、分支、工具调用、技能/插件/子代理以及输入框快捷键。第二个项目展示项目切换与一个 *Chat only* 会话。
- **文件**：资源管理器浏览本仓库的一份快照。Welcome 会话会在右侧以渲染预览打开 `README.md`，教学里的编辑会以带 diff 的 Git 变更出现。
- **模型**：一个已登录的 ChatGPT Plus/Pro（Codex）账号、一个 DeepSeek API Key，以及来自 `models.json` 的自定义 "Claude Gateway" 提供方，选择器里有 Codex、Claude 与 DeepSeek 模型。
- **交互**：发送消息会流式返回预置回复（合适时带真实的 `read` 或 `ls` 工具调用），`!command`、终端面板、fork、分支、重命名与标题都在内存中工作。任何需要真实服务端的能力（登录、安装、上传）都会说明这是演示。

## 工作原理

```text
app/DemoRoot.tsx        导入 mock/install.ts，然后渲染 Pi Web 的 AppShell
mock/install.ts         替换 window.fetch（针对 /api/*）与 EventSource
mock/router.ts          API 路由：sessions、agent、files、git、models 等
mock/agent.ts           按 pi 的 SSE 事件序列流式输出回复
mock/sessions/          教学脚本，展开成 pi 会话条目
mock/captured/          从真实的 Pi Web + pi SDK 环境录制的响应
scripts/prepare-demo-files.mjs
                        把本仓库快照进 public/demo-files
```

`components/`、`hooks/` 与 `lib/` 是主项目的副本。以下文件与原件不同：

| 文件 | 原因 |
| --- | --- |
| `app/layout.tsx`、`app/page.tsx`、`app/DemoRoot.tsx` | 加载 mock，不使用 service worker 或 manifest |
| `components/AppShell.tsx` | 默认打开 README 预览、对 base path 安全的 `router.replace`、浏览器内的「完整历史」 |
| `components/ChatWindow.tsx`、`FileIcons.tsx`、`ProviderIcon.tsx` | 给静态资源加上 Pages 的 base path 前缀 |
| `components/FileViewer.tsx`、`FileExplorer.tsx`、`MarkdownBody.tsx` | 从静态快照加载图片、媒体与下载 |
| `lib/subagent-extension.ts`、`lib/terminal-manager.ts` | 只有类型；原件是服务端代码 |

要同步主项目的界面改动，请把更新后的文件复制过来并重新套用上面的改动（在这些文件里搜索 `demo` / `@/mock`）。

## 与 Pi Web 的隔离

演示版永远不会进到应用或其 npm 包里：

- **不发布。**根 `package.json` 只发布 `files` 白名单里的路径，因此 `npm pack` 不会包含 `demo/` 的任何内容。
- **不编译进应用。**Pi Web 不导入 `demo/` 的任何东西；根 `tsconfig.json` 排除了它，`eslint.config.mjs` 也忽略它。
- **不进入应用的 CSS。**Tailwind 会扫描所有未被 gitignore 的文件，因此 `app/globals.css` 里有 `@source not "../demo";`。演示版自己的 `globals.css` 副本保留同一行，只是在那里它什么也不指向。
- **自己的 CI。**只有 `.github/workflows/demo-pages.yml` 会安装并构建 `demo/`。

## 命令

```bash
cd demo
npm install
npm run dev      # http://127.0.0.1:30142
npm run lint
npm run build    # 静态导出到 out/
```

`npm run dev` 与 `npm run build` 会先执行 `scripts/prepare-demo-files.mjs`。要在子路径下预览构建结果（与 GitHub Pages 的提供方式一致），请在 `npm run build` 之前设置 `PAGES_BASE_PATH=/pi-web`。

## 部署

`.github/workflows/demo-pages.yml` 在每次推送到 `main` 时构建演示版，并把 `out/` 部署到 GitHub Pages。

**fork 上的两个默认开关**（工作流“失败”或不出现基本都是它们）：

1. **Actions 默认禁用**：Settings → Actions → General → *Allow all actions*（或 Actions 标签页横幅里的确认按钮）。
2. **Pages 需启用一次**：Settings → Pages → Build and deployment → Source 选 **GitHub Actions**。不做也行：工作流里的 `configure-pages` 带 `enablement: true`，第一次运行会自动创建站点。

站点随后服务于 `https://<owner>.github.io/<repo>/`（`PAGES_BASE_PATH` 来自 `configure-pages` 的输出，自定义域名时为空）。
