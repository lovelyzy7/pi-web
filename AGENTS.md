# Pi Web —— 开发笔记

## 快速开始

```bash
npm run dev   # 端口 30141
```

类型检查：`node_modules/.bin/tsc --noEmit`
Lint：`npm run lint`
**开发期间绝不运行 `next build`** —— 它会污染 `.next/` 并弄坏 `npm run dev`。

### 开发服务器排障

- 启动服务前先执行 `lsof -nP -iTCP:30141 -sTCP:LISTEN`，若已有健康的 Pi Web 进程就直接复用。同一检出目录的第二个 `next dev` 不能靠换端口绕过：两个进程会争抢 `.next/dev/lock`。
- 只在浏览器里出现的 `Module ... factory is not available` 覆盖层，通常表示该标签页持有过期的 Turbopack/HMR 图，并不证明服务端或源码有问题。先触发浏览器的显式刷新，再对比当前服务端日志与一次直接的 HTTP/API 请求。
- 只有在新标签页仍能复现、且服务端检查同样失败时才重启：优雅停止确切的 dev 进程，把 `.next` 移到 `mktemp -d` 备份目录，再用标准 `npm run dev` 重启。
- 不要退而使用 `next dev --webpack`。本仓库的开发图会在 `undici` 的 `node:console` 之类导入上失败；开发预期使用 Turbopack。
- `next dev` 启动时可能在 `AGENTS.md` 末尾追加一段生成的 `BEGIN:nextjs-agent-rules` 块。把它当作工具生成的产物：用 `git status` 核对，不要带进无关的功能提交。

---

## 架构

```
浏览器                  Next.js 服务端                AgentSession（同进程）
  │                        │                               │
  ├─ GET /api/sessions ────▶ 读取 ~/.pi/agent/sessions/    │
  ├─ GET /api/sessions/[id] 直接读取 .jsonl 文件            │
  ├─ GET /api/agent/running ───────▶ 运行中 id 快照         │
  │                        │                               │
  ├─ 发送消息 ─────────────▶ POST /api/agent/[id]           │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE 连接 ─────────────▶ GET /api/agent/[id]/events     │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**会话浏览**（只读）：通过 SDK 的 `SessionManager` 辅助函数与 `lib/session-reader.ts` 读取 `.jsonl` 文件 —— 不创建 AgentSession。
**认证闸门**：`proxy.ts` 匹配 `/`、`/login`、`/init`、`/user`、`/market`、`/updates` 与 `/api/:path*`；新增页面路由必须加入该 matcher，否则会在无认证的情况下被提供。
**发送消息**：`lib/rpc-manager.ts` 里的 `startRpcSession()` 在同进程内创建 AgentSession。

---

## 文件地图

```
app/api/
  sessions/route.ts               GET  列出所有会话
  sessions/[id]/route.ts          GET/PATCH/DELETE 单个会话
  sessions/[id]/context/route.ts  GET ?leafId= —— 指定叶子节点的上下文
  sessions/[id]/export/route.ts   GET 导出会话 HTML
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET 状态 | POST 任意命令
  agent/[id]/events/route.ts      GET SSE 事件流
  agent/running/route.ts          GET 当前运行中的会话 id
  auth/api-key/[provider]/route.ts POST/DELETE 提供方 API Key 存储
  auth/login/[provider]/route.ts  GET OAuth/设备码 SSE | POST 手动验证码
  auth/logout/[provider]/route.ts POST OAuth 登出
  auth/providers/route.ts         GET OAuth 与 API Key 提供方列表
  web-auth/route.ts               GET 状态 | POST 密码登录 | DELETE 登出
  web-auth/init/route.ts          GET 首次初始化状态 | POST 创建账号
  user/route.ts                   GET /user 的账号概览
  user/password/route.ts          PUT 修改账号密码
  user/sessions/route.ts          GET 已登录设备 | DELETE 登出其它设备
  user/sessions/[id]/route.ts     DELETE 登出指定设备
  user/audit/route.ts             GET /user 的 auth_events 分页
  user/totp/route.ts              GET 状态 | POST 开始登记 | PUT 确认 | DELETE 关闭 | PATCH 恢复码
  user/tokens/route.ts            GET API 令牌 | POST 创建
  user/tokens/[id]/route.ts       DELETE 撤销某个令牌
  themes/route.ts                 GET 当前主题 | POST 校验/应用 | DELETE 还原
  themes/asset/[...path]/route.ts GET 同源主题文件（路径白名单）
  themes/local/route.ts           GET 探测本地主题 | POST 导入/移除托管副本
  themes/store/route.ts           GET/POST/DELETE 主题商店清单地址
  themes/store/versions/route.ts  GET 商店条目的版本与更新提示
  themes/cover/route.ts           GET 反代的商店封面图
  themes/preview/route.ts         GET 真实界面预览 cookie（及 ?off=1）
  market/route.ts                 GET pi.dev 目录页或单个包详情
  updates/route.ts                GET 应用/运行期/部署/插件 | POST 检查、自更新、回退、全部更新插件
  cwd/validate/route.ts           POST 校验/选择 cwd
  default-cwd/route.ts            POST 创建 ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts        GET 供查看器使用的文件内容
  home/route.ts                   GET 用户主目录
  models/route.ts                 GET { models, modelList, defaultModel, cwd, cwdNotice? }
  models/enabled/route.ts         GET/PUT 模型面板的 enabledModels 开关
  models/refresh/route.ts         POST 按需从 pi.dev 拉取提供方目录
  models-config/route.ts          GET/PUT —— 读写 ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev 价格预设
  models-config/discover/route.ts POST 拉取已配置提供方的上游模型列表
  models-config/test/route.ts     POST 测试已配置的模型/提供方
  plugins/route.ts                GET/POST 包插件管理
  skills/route.ts                 GET/PATCH 已加载技能与 disable-model-invocation
  skills/install/route.ts         POST 通过 npx skills add 安装技能
  skills/search/route.ts          GET/POST skills.sh 搜索
  subagents/settings/route.ts     GET/PUT 内置子代理功能开关
  subagents/profiles/route.ts     PATCH 内置 profile 的启用状态（scope: "builtin"）
  worktrees/route.ts              GET/POST/DELETE git worktree
  web-auth/route.ts               GET 状态 | POST 登录 | DELETE 登出（浏览器密码）
  plugins/check/route.ts          POST 检查插件包更新
  project-trust/route.ts          GET/POST 包安装所需的项目信任
  sessions/search/route.ts        GET 会话搜索
  sessions/[id]/state/route.ts    GET 会话运行中的 wrapper 实时状态
  sessions/[id]/auto-name/route.ts POST 生成会话标题
  terminal/route.ts               POST 创建终端会话
  terminal/[id]/route.ts          GET 流 | POST 输入/尺寸 | DELETE 结束
  cwd/browse/route.ts             GET 浏览允许的 cwd 目录
  app-update/route.ts             GET 当前与最新发布的 pi-web 版本
  file-index/route.ts             GET @ 提及用的文件列表
  git/status/route.ts             GET 某 cwd 的变更文件
  git/diff/route.ts               GET 单个变更文件的 diff
  provider-usage/query/route.ts   POST 提供方用量配额
  push/config/route.ts            GET 推送订阅用的 VAPID 公钥
  push/subscribe/route.ts         POST 注册推送订阅
  tools/settings/route.ts         GET/PUT shell 工具设置（Windows 上的 PowerShell）

app/
  init/page.tsx        首次初始化页（尚无账号时自动打开）
  login/page.tsx       密码登录
  user/page.tsx        账号页（/user）

lib/
  agent-client.ts       /api/agent 命令的类型化 fetch 辅助
  db.ts                 better-sqlite3 连接、迁移、globalThis 单例
  db-schema.ts          只追加的迁移列表（由 user_version 驱动）
  auth-store.ts         账号、登录会话、审计事件、应用设置
  auth-throttle.ts      口令失败退避的纯曲线
  auth-throttle-store.ts  数据库限流计数，无法用库时退回内存
  password-hash.ts      scrypt 哈希/校验（异步 + 供代理使用的同步版本）
  totp.ts               RFC 6238、base32、otpauth URI、恢复码形态
  totp-service.ts       在 store、密钥与二维码之上的登记/校验
  secret-box.ts         用 0600 密钥文件做 AES-256-GCM 封装
  auth-challenge.ts     证明「口令步已通过」的签名凭据
  api-tokens.ts         Bearer 令牌：哈希、scope、最近使用时间
  user-api.ts           /api/user/* 路由共享的管道代码
  security-headers.ts   固定响应头、CSP 模式、nonce、HSTS
  theme-source.ts       主题来源解析、路径白名单、资源 URL
  theme-manifest.ts     清单 schema、CSS 作用域/URL 校验、对比度
  theme-store.ts        主题取回/缓存、当前主题、本地目录边界、预览
  theme-store-catalog.ts  商店清单解析、URL 校验、缓存
  cwd-notice.ts         设置分区「所选项目不在服务器上」的共享类型与文案
  highlight-style.ts    SyntaxHighlighter 风格的简写/longhand 归一化
  missing-path.ts       nearestMissingRoot()：树在哪一层开始不存在（挂载点）
  model-cwd.ts          /api/models 的 cwd 解析与降级（missing/not_a_directory/not_allowed）
  project-cwd.ts        项目 cwd 的五态判定，供技能/插件/worktree 等读路径降级
  provider-error.ts     解析提供方失败文本（状态码/类型/request id）并分类
  theme-local.ts        本地主题探测（托管/配置/项目目录）与导入/移除
  theme-safety.ts       「在本设备关闭主题」cookie
  market-catalog.ts     pi.dev 目录解析、market_cache 读写
  app-update-service.ts 数据库缓存的 Pi Web 版本检查、部署形态识别
  self-update.ts        容器内发布安装、符号链接切换、回退
  npm-registry.ts       上面两者使用的 registry 地址
  password-policy.ts    /init 与改密码使用的口令规则
  init-setup.ts         打印到服务端日志的首次初始化验证码
  draft-store.ts        本地草稿持久化辅助
  file-access.ts        /api/files 与 worktree 的允许文件根目录
  file-paths.ts         客户端/服务端路径编码辅助
  enabled-models.ts     `enabledModels` 模式列表的纯最小编辑引擎
  enabled-models-runtime.ts  SDK 适配：逐模式解析、提供方种类、设置读写
  markdown.ts           共享 markdown 辅助
  node-cli.ts           定位内置 npm-cli.js / npx-cli.js，使 npm/npx 无需 shell（Windows 的 npm.cmd）
  npx.ts                技能安装使用的 npx 运行器
  plugin-updates.ts     /api/plugins/check 的 npm view 更新检查
  pi-types.ts           pi SDK 对象的本地结构化类型
  rpc-manager.ts        AgentSessionWrapper + 注册表 + startRpcSession
  session-reader.ts     SessionManager 包装 + 路径缓存 + buildSessionContext 适配
  subagent-settings.ts  读写 ~/.pi/agent/agents/settings.json
  subagents.ts          内置 profile 常量与解析
  tool-presets.ts       PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  新会话在浏览器里持久化的默认预设
  types.ts              共享 TypeScript 类型
  normalize.ts          normalizeToolCalls() —— 文件格式与本地类型之间的字段名差异
  worktree.ts           项目/worktree 解析与 git worktree 操作

components/
  AppShell.tsx        布局 + URL 状态 + 标签页管理
  SettingsPanel.tsx   设置弹窗：分区标签 + 嵌入式分区
  UserPage.tsx        AccountSettings（嵌入式）+ /user 的页面外壳
  ThemeSettings.tsx   配色选择器 + 第三方主题控件
  MarketPage.tsx      MarketSettings（嵌入式）+ /market 的页面外壳
  UpdatesPage.tsx     UpdatesSettings（嵌入式）+ /updates 的页面外壳
  SettingsUi.tsx      共享的小型配置原语（按钮、开关、外壳）
  SessionSidebar.tsx  会话树 + FileExplorer
  ChatWindow.tsx      聊天编排 + 完成提示音包装
  ChatInput.tsx       输入栏 + 模型/思考/工具/压缩控件
  MessageView.tsx     渲染单条消息（user/assistant/toolCall/toolResult）
  BranchNavigator.tsx 会话内分支切换器
  ChatMinimap.tsx     消息列表旁的滚动缩略图
  MarkdownBody.tsx    markdown 渲染器
  ModelsConfig.tsx    编辑 models.json 的弹窗（从侧边栏底部打开）
  EnabledModelsSection.tsx  ModelsConfig 内的模型开关，由 enabledModels 支撑
  AgentsConfig.tsx    内置子代理开关 + agent profile 编辑器
  PluginsConfig.tsx   已安装包插件的弹窗
  SkillsConfig.tsx    已加载/可搜索/可安装技能的弹窗
  FileExplorer.tsx    侧边栏内的文件树
  FileIcons.tsx       文件图标辅助
  FileViewer.tsx      标签页里的文件内容
  TabBar.tsx          标签栏（聊天 + 打开的文件标签）

hooks/
  useAgentSession.ts  消息 + 流式 + SSE + fork/navigate/对账逻辑
  useAudio.ts         完成提示音 + 浏览器 AudioContext 解锁
  useDragDrop.ts      共享拖放状态
  useIsMobile.ts      响应式断点 hook
  useTheme.ts         主题状态
```

---

## 关键设计决策与陷阱

### AgentSession 生命周期（`lib/rpc-manager.ts`）
- 每个 session id 一个 `AgentSessionWrapper`，存放在 `globalThis.__piSessions`
- `globalThis` 能跨 Next.js 热重载存活；普通模块级 Map 不能
- 空闲超时默认 10 分钟（`PI_WEB_IDLE_TIMEOUT_MS`，`0` 表示关闭）。并发的 `startRpcSession()` 共用一个启动 Promise（`globalThis.__piStartLocks`）

### fork 之后必须立刻销毁 wrapper
`AgentSession.fork()` 会**就地改写 wrapper 的内部状态** —— fork 之后 `inner.sessionId` 已经是**新**会话的 id。若 wrapper 仍以旧 id 留在注册表里，下一个请求拿到的是已经 fork 过的状态，再 fork 就会产生损坏的 `parentSession` 链。

**修法**：`send("fork")` 先取到 `newSessionId`，返回前调用 `this.destroy()`。原会话的下一个请求会从原文件重新加载一个干净的 AgentSession。

### 两种分支，不要混淆
- **Fork**（用户消息上的「新建会话」）：创建独立的 `.jsonl` 文件。通过头部的 `parentSession` 字段在侧边栏树里显示为子节点。
- **会话内分支**（「从此处编辑」/ BranchNavigator）：在同一文件内调用 `navigate_tree`。多条条目共享同一个 `parentId`。在它们之间切换会调用 `/api/sessions/[id]/context?leafId=`。

### 会话文件可以被整体重写
头部的 `parentSession` **只是展示用元数据** —— 对聊天内容零影响。整文件 `writeFileSync` 是安全的（pi 自己在迁移时就这么做）。删除时级联重挂父节点用的就是这一点。

### ToolCall 字段归一化
pi 把 toolCall 块存成 `{type:"toolCall", id, name, arguments}`，而 `ToolCallContent` 使用 `{toolCallId, toolName, input}`。`lib/normalize.ts` 的 `normalizeToolCalls()` 负责转换 —— `session-reader.ts`（文件加载）与 `hooks/useAgentSession.ts` 的 `handleAgentEvent`（流式）两处都调用它。

### 新会话的工具预设
工具名在创建会话时传入（`POST /api/agent/new` -> `toolNames[]`），并以带版本号的 `pi-web:tool-selection` 自定义条目持久化。没有条目表示旧格式会话，保持 pi 的默认行为；空数组表示 Chat only。Chat only 在创建服务之前就完成解析，不加载任何扩展/技能/提示词/主题，并用 pi 发现的上下文文件按序内容替换 pi 的基础提示词。跨越 Chat only 边界会重建 wrapper；在非空预设之间切换则就地更新。

**确切的系统提示词走 `before_agent_start`。** 自 pi 0.86 起提示词存在于转录里：`agent.state.systemPrompt` 是从已持久化的 system 消息重放出来的 getter（赋值会抛错），而 agent 循环的请求上下文没有 `systemPrompt` 字段，因此无论是改状态还是补 `prepareNextTurnWithContext` 都到不了模型。Chat only 会话与处于 replace 模式的子代理 profile 会把 `lib/exact-system-prompt.ts` 作为内联扩展工厂注册到资源加载器上；它的 `before_agent_start` 处理器返回 `{ systemPrompt }`，SDK 会把该值作为整轮请求提供给提供方的首个系统提示词，同时转录照常记录 pi 的结构化分段。对那些 wrapper，`get_state.systemPrompt` 报告的是确切提示词，因为 SDK 状态只显示结构化分段。子代理把活动工具以及 profile 级的技能/扩展加载开关存进 `resourceSnapshot`；已加载的扩展无法把保留工具 `Agent`、`get_subagent_result`、`steer_subagent` 暴露给子代理。见 `docs/adr/0002-chat-only-tool-selection.md`。

用户显式选择的最后一个预设保存在浏览器 `localStorage`，只用于初始化新会话的输入框。已有会话从不信任该偏好：它们使用实时的 `get_tools` 状态，没有 wrapper 时则用 pi 的默认值。

### 新会话的模型默认值
`GET /api/models` 返回从 `~/.pi/agent/settings.json` 读取的 `defaultModel`。`ChatWindow` 在挂载时为
新会话预选它。浏览器里显式的模型/思考选择会在构造 AgentSession 时原子地应用，随后 `lib/startup-preferences.ts` 保存它们的实际生效值，而不重放 `set_model`/`set_thinking_level`；`enabledModels` 的隐式回退与思考固定不会被持久化。

### 远程提供方目录
pi 内置的模型列表在 SDK 构建时生成，而 pi-web 固定一个 SDK 版本，因此提供方在该版本之后发布的模型在 pi-web 发布新版本之前不可见（#914）。SDK 携带了另一半：每个内置提供方都包在一层 pi.dev 目录覆盖里，由 `ModelRuntime.refresh()` 取回并写入 `~/.pi/agent/models-store.json`，而恢复该覆盖不需要网络。pi-web 的两条刷新路径都只要离线那一半（`createAgentSessionServices()` 与 `lib/provider-usage.ts` 传 `allowNetwork: false`），这也是过去「先跑一次 pi CLI」能修好的原因 —— CLI 带网络刷新，pi-web 读它留下的结果。

`lib/model-catalog-refresh.ts` 执行那次带网络的拉取，**且只在用户要求时**：`EnabledModelsSection` 里的「Refresh catalog」按钮 POST 到 `/api/models/refresh`。没有任何逻辑会按定时器或在别的请求路径上刷新目录 —— 一次拉取会为每个已认证的提供方取一份目录，保存操作不该等一个慢目录，这与 `/api/auth/api-key/[provider]` 直接存储凭据而不调用 `ModelRuntime.login()` 是同一个理由。`refresh()` 以 `force: true` 调用，因为按下按钮本就是要求跳过 SDK 的 4 小时新鲜期；但**不带** `allowNetwork`，因此运行期继续执行它自己的 `PI_OFFLINE` 规则，而不是由 pi-web 覆盖；模块会报告 `reason: "offline"`，而不是假装跑过一轮。`shareModelCatalogRefresh()` 会合并针对同一批提供方的并发按下，避免两个标签页争抢 store 文件。

变更检测比较的是运行期暴露的模型 id 与名称，而不是存储的字节：一次成功的重新校验每轮都会重写 `checkedAt` 与 `etag`。它只决定是否调用 `invalidateModelsCache()`、面板是否重新加载 —— 覆盖本身通过常规的 `/api/models` 与 `/api/models/enabled` 加载进入界面，那两条路径会构建一个恢复 store 的新运行期，所以刷新路由从不自己返回模型列表。

### `enabledModels` 的范围
`enabledModels` 使用 pi 的 `--models` 语法：对 `provider/modelId` 或裸 `modelId` 做 minimatch 通配，对非通配模式做模糊匹配，并可带 `:thinkingLevel` 后缀。**永远不要把这些模式当字面字符串比较** —— `lib/model-scope.ts` 委托给 SDK 的 `resolveModelScopeWithDiagnostics()`，使 pi-web 与 TUI 对可见模型列表的看法一致，并在模式解析不出东西时回退到所有可用模型。`startRpcSession()` 在创建 AgentSession 之前解析该范围，并原子地传入选定的初始模型、思考固定与 SDK 原生的 `scopedModels`；`GET /api/models` 只在需要选择器数据、`thinkingLevelPins` 与 `modelScopeWarnings` 展示时复用该辅助。

从模型面板编辑该设置一律走 `/api/models/enabled`，绝不使用浏览器端拼装的模式字符串。每次开关都是对已存列表的**最小编辑**（`lib/enabled-models.ts`）：匹配不到任何可用模型的模式原样保留；只把覆盖被关闭模型的那个模式就地展开（保留其 `:level` 后缀）；任何最终完全启用的提供方，若由两条以上条目覆盖，则折叠回一个通配 —— pi 会从网络把提供方目录刷新进 `models-store.json`，所以模型改名时枚举列表会腐坏（deepseek 的 `deepseek-v4-flash` 变成 `deepseek-flash`），而通配能自愈。孤立的精确引用是刻意的挑选，保持不动。**永远不要假定 `provider/*` 覆盖某个提供方**：pi 用 minimatch 匹配，其 `*` 在 `/` 处停止，因此该通配会静默漏掉所有嵌套模型 id（`commandcode/sakana/fugu-ultra`、大多数 OpenRouter id）—— 写它曾把「全部启用」变成 71 个里的 15 个。`resolveProviderGlobs()` 先解析 `provider/*` 再解析 `provider/**`，只保留匹配集恰好等于该提供方全部模型的那个；两者都覆盖不了的提供方按模型逐个写出。也不要像 TUI 的 `/scoped-models` 那样用 `getAvailable()` 整体重写列表 —— 它只能看到当前通过 `checkAuth()` 的提供方，那会删掉凭据暂时缺失的提供方的所有条目，并摊平通配与固定。

关闭最后一个启用的模型会被拒绝，返回 `409 { reason: "last-model" }`：当范围解析不出东西时 pi 会回退到所有模型，因此空列表的语义恰好相反。写入始终针对全局设置文件；项目的 `.pi/settings.json` 会整体替换全局数组而不是合并，因此路由报告 `scope: "project"`、把开关渲染为只读，并返回该文件路径作为 `settingsPath` —— 横幅直接点名它刚写入的文件（`~/.pi/agent/settings.json · enabledModels 20/104`），而不是用一句话描述效果。内置提供方**与**扩展注册的提供方都有逐模型开关；models.json 提供方由详情头部、Delete 旁边的 `EnabledModelsProviderSwitch` 整体开关，因为自定义模型可以直接删除，而两个批量按钮永远只是同一个提供方级写入。该开关仅在提供方全部模型都启用时为开，因此部分选择在侧边栏 `1/2` 徽标旁读作关，一次点击即可补全；读作「有任意启用」会让部分状态在「最后一个模型」守卫挡住向下路径时两个方向都不可达。它不能移动的原因放在 tooltip 里，而不是正文。`op: "prune"` 是唯一会删除失配条目的操作，用于清理这类改名之后果；其它操作都保留它们。保存 models.json 后会用 `op: "resync"` 重新读取开关，它针对新目录修复已存模式：先改写被改名的**模型**、再改写被改名的**提供方**、**裁掉提供方前缀已不再限定它们的条目**、并重新声明保存前处于完全启用状态的提供方。（模型引用在前：它们拼写的仍是旧提供方 id，否则会被提供方改写提前替换掉。）三者都必需，因为模式的含义依赖目录。pi 除 `provider/modelId` 外还会把模式与裸 `modelId` 匹配，因此 `stepfun/*` 也能匹配另一个提供方 id **就是** `stepfun/Step-5-Preview` 的模型 —— 把提供方改名为 `stepfun` 会静默启用三个 `commandcode` 模型，随后关掉 stepfun 又把它们写进文件。反向情形是把模型改成带斜杠的 id，它会掉出 `provider/*`（minimatch 的 `*` 在 `/` 处停止），于是完全启用的提供方静默丢掉一个模型。在面板里改名的模型是一次已知的移动，不属于值得保留的失配：`stepfun/ddd` 变成 `stepfun/ddd1` 后若留下旧条目就会丢掉选择，而当它是唯一条目时范围解析为空，pi 会把「没有范围」读成「启用全部」。`ModelsConfig` 在 `savedModelIdsRef` 里镜像草稿的每次数组移动，使 `collectModelRenames()` 无需猜测就能区分改名与新增/删除。只有 `resync` 会修复条目；普通开关保持最小编辑，绝不改写用户没碰过的内容。运行期里不存在的 models.json 提供方（未保存的改动、没有模型、密钥不可用）不应被报告成登录问题，这正是它有独立控件的原因：开关渲染为禁用并把它作为 tooltip 原因，而已经只负责内置提供方的 `EnabledModelsSection` 保留登录空状态。见 `docs/adr/0004-enabled-models-toggles.md`。

### 流式进行中刷新页面时的 SSE 重连
`ChatWindow` 挂载时会调用 `GET /api/agent/[id]`。若 `state.isStreaming === true`，会自动重连 SSE。`thinkingLevel` 与 `isCompacting` 也在该响应里同步。

### 压缩相关 SSE 事件
较新的 pi 发 `compaction_start` / `compaction_end`；较旧版本发 `auto_compaction_start` / `auto_compaction_end`。`handleAgentEvent` 同时接受两组，以保持 `isCompacting` 同步。手动压缩是阻塞式 POST —— 响应返回前面板按钮保持禁用。

### 转录里的 system 消息、usage 条目与 context 编辑（pi >= 0.86）
- 每个新会话的首次请求都会持久化一条 `role: "system"` 的 `message` 条目，保存提示词分段与工具声明；之后的提示词或工具变化会追加更多。agent 循环像普通消息一样用 `message_start` / `message_end` 通告它们。它们是提供给模型的输入，不是对话：`toClientAgentEvent()` 在 SSE 流之前丢掉它们（它们携带全部工具 schema），`handleAgentEvent` 跳过漏网者，`entryToUiMessage()` 对它们返回 null，`BranchNavigator` / `lib/project-tree.ts` 也从不拿它们作为分支的标题或预览。它们仍然计入 `messageCount` 与 `totalMessages`，与 SDK 的计数完全一致。
- `usage` 条目（`kind: "cache_warm"`）记录计费但不进入模型上下文的提示词缓存预热。`computeSessionStats()` 像处理压缩用量那样累加它们，使 token/费用计数与 TUI 的 `/session` 一致。
- `context_edit` 条目在不改变原始历史的前提下，省略或替换更早条目的模型上下文；界面忽略它们。retain-none 的压缩会把自己的 id 存进 `firstKeptEntryId`。
- `SessionManager.listAll()` 现在按 mtime 从新到旧读取文件（同 mtime 时按文件名倒序），使 `--resume` 能渐进渲染；它的稳定排序在活动时间相同时也保持该顺序，`listSessionsIncremental()` 能依据已保存的 stat 指纹复现它。

### 运行状态轮询与对账
- 侧边栏在标签页可见时每 2.5 秒轮询 `/api/agent/running`，后台标签页暂停轮询。会话列表响应仍是初始回退。
- `invalidateSessionListCache()` 递增代号但**保留**上一次扫描，缓存只在其记录的代号匹配时才算新鲜。普通的 agent 活动会不断使其失效，而重建要花几百毫秒，因为 `loadAllSessions()` 会重读每个 fork 与子代理会话。只需要元数据的调用方 —— 例如把搜索命中映射到侧边栏行 —— 传 `listAllSessions({ allowStale: true })` 读取上一次扫描，让重建在后台发生。过期扫描除了几秒前刚建的会话之外是完整目录，因此这些调用方接受一个短暂窗口：新会话尚未出现在列表里。
- `useAgentSession` 把每会话 SSE 当作聊天事件的主通道，并在每次提示词之前打开它。`prompt_done` 会立即结束当前界面阶段与通知，但空闲 SSE 会保留 30 秒宽限窗口并被下一次提示词复用。`agent_start` 会取消该关闭定时器；`agent_settled` 结束没有 wrapper 级 `prompt_done` 的扩展注入运行，并开启新的宽限窗口。**不要**在第一个 `agent_end` 就关闭：重试、压缩与扩展排队的消息都可能延续同一个逻辑提示词。
- 运行期间，`useAgentSession` 会周期性调用 `GET /api/agent/[id]`，并在 `visibilitychange`/`online` 时对账。这修复了后台标签页或半开连接漏掉的终态事件。
- 提示词运行使用单调递增的 run id；旧 run 的迟到 SSE 或缓慢对账响应必须被忽略，否则会复活过期的流式气泡。
- `useAgentSession` 里每次 SSE（重）连接都以 `sessionHookMountedRef` 为闸门。React Strict Mode（`next dev` 默认开启）会在模拟卸载后按声明顺序重跑 effect：只挂载一次的 effect 的清理会把该 ref 置为 `false`，而它只在该 effect 重跑时才恢复，**晚于**预热会话的 effect。因此预热会话的 effect 会在 `maintainEventsConnected()` 之前重新置位该 ref。否则 dev 服务器下的标签页在挂载时、或切回运行中的会话时永远不会打开事件流，流式输出与新消息要等到 15 秒的对账轮询或刷新页面才可见（`next start` 不受影响）。

### worktree 与项目归组
- `lib/worktree.ts` 把链接式 worktree 的顶层目录解析回主仓库的 `projectRoot`；`listAllSessions()` 把它挂到每个 `SessionInfo` 上，使同一仓库的所有 worktree 在侧边栏里归为一组。
- worktree 操作由 `/api/worktrees` 提供，并受与 `/api/files` 相同的允许根目录规则约束。
- 新 worktree 创建在 `<repoRoot>-worktrees/<净化后的分支名>` 下。已存在的分支会被复用；否则用 `git worktree add -b` 创建分支。
- 删除脏 worktree 会返回 `409` 与 `{ dirty: true }`，让界面先询问再用 `force` 重试。
- cwd 指向已删除 worktree 的会话会被归回主项目，而不是变成一行幽灵项目。
- git 即使在 Windows 上也输出 POSIX 风格的绝对路径，因此从 git 读出的每个路径在比较或返回之前都要经过 `toNativePath()`（`lib/paths.ts`）。比较路径必须用 `samePath()`，绝不用 `===` —— 裸相等会让 `isTopLevel` 在 Windows 上永远为假，从而完全隐藏 worktree 切换器。分支名不是路径，必须保留正斜杠。浏览器代码无法套用 Node 的路径规则，因此 `/api/worktrees` 在服务端解析 `currentWorktreePath`；侧边栏必须用该身份做高亮与删除回退。

### 文件访问白名单
- `/api/files` 刻意不是通用文件系统浏览器。允许的根目录来自会话 cwd、它们解析出的项目根、`~/pi-cwd-*`，以及用 `allowFileRoot()` 显式添加的根。
- `/api/cwd/validate`、`/api/default-cwd` 与 `/api/worktrees` 在让一个新位置可浏览时会调用 `allowFileRoot()`。
- 允许根以斜杠规范化的形式存储，但那只是 Set 键的约定，不是正确性要求：`isPathWithinRoots()`（`lib/path-security.ts`，`isFilePathAllowed()` 背后唯一的实现）会重新解析并对两侧做大小写折叠，因此任一种路径形式都能正确授权。**请保持这一份实现** —— 它就是安全边界。
- UNC 形式的 cwd（`\\host\share\dir`）必须在 `/api/files/[...path]` 往返中存活。`encodeFilePathForApi()` 把 `//` 根折进第一段（`%2F%2Fhost`），因为字面的 `//` URL 前缀会在路由之前被 308 规范化掉；`filePathFromApiSegments()` 再把它解码回来。绝不把 UNC 路径拆成段再拼回去 —— 那会把 `\\host\share` 悄悄变成看似相对的 `host/share`，所有允许检查都会以 403 失败。

### 插件与技能
- `/api/plugins` 使用 pi 的 `SettingsManager` + `DefaultPackageManager` 处理全局/项目包的安装、移除、更新、启用与禁用。禁用会为该包条目写入空的 `extensions/skills/prompts/themes` 数组。
- `/api/skills` 使用 `DefaultResourceLoader`，使设置路径、包技能与项目 `.agents/skills` 的列出方式与运行期所见一致。
- 技能开关只编辑目标 `SKILL.md` 的 `disable-model-invocation` frontmatter 键；保持这种外科手术式修改，用户的格式才能存活。
- `/api/skills/install` 通过 `npx skills add ... --agent pi` 执行；项目级安装以选定的 cwd 运行。

### 内置子代理
- 全局 `builtInEnabled` 开关存放在 `~/.pi/agent/agents/settings.json`，文件或字段缺失时默认 `false`。设置损坏时失败关闭；原子更新保留未知字段。
- 内联的内置扩展工厂始终存在，以便重载已存在的 wrapper 时能应用设置变化，但禁用期间不注册任何工具。改动开关后，用户必须显式重载当前会话。
- 启用时，只有被识别为旧 `pi-subagents`、且注册了任一保留工具（`Agent`、`get_subagent_result`、`steer_subagent`）的扩展会被移除。无关扩展保持加载，解析出的冲突诊断被丢弃。
- 运行期 `Agent` 派发会再次检查设置，使功能关闭后到达的旧工具调用无法启动子代理。
- 优先级与持久化的理由见 `docs/adr/0003-built-in-subagent-toggle.md`。
- 单个内置 profile（`general-purpose`、`explore`、`plan`）在同一个文件的 `disabledBuiltIns` 数组里按名字关闭，**绝不**把它们复制成 `.md` 文件：副本会把内置提示词冻结在复制时的版本，并且会被读那些目录的其它运行期看见。`builtInProfiles()` 给常量打上 `enabled`，使面板、`Agent` 工具描述与 `resolveSubagentProfile` 保持一致；每次写入都是最小编辑，保留本次没碰过的名字，包括没有任何内置认领的（更新版本写的）。读取该列表失败**开放** —— 旁边的功能开关此时已经失败关闭 —— 而 `PATCH /api/subagents/profiles` 带 `scope: "builtin"` 执行写入，`PUT`/`DELETE` 仍拒绝该 scope。同名文件会整体替换内置 profile，并通过它自己的 frontmatter 关闭。内置只有开关是活的，表单其余部分保持只读。见 `docs/adr/0005-built-in-subagent-disable.md`。
- 后台运行的完成通知（`notifyParent`）在父代理已用 `get_subagent_result` 收走同一结果时会被跳过：该工具把已结束的后台运行标记为已消费，通知读取该标记。这项检查不能只在完成 promise 兑现时做 —— 那时父代理通常还在自己的 `get_subagent_result` 轮询里（500ms 间隔），而 `deliverAs: "followUp"` 只会把重复内容排队到该回合结束。因此 `notifyParent` 在父代理 `isRunning()` 期间持有消息，并在发送前重新检查标记；空闲的父代理仍会被立即通知。
- Agent profile 文件（`~/.pi/agent/agents/*.md`、项目 `.pi/agents/*.md`）与其他运行期共享，因此保存时会原样往返本应用不拥有的 frontmatter 键（`name`、`allowed_subagents`、`exclude_extensions`、`disallowed_tools` 等），并携带外来的 `ext:` 工具选择器。受管理的键恰好是 `description`、`display_name`、`tools`、`load_skills`、`load_extensions`、`enabled`、`inherit_context`、`run_in_background`、`model`、`thinking`、`max_turns`。
- 后台运行的完成报告通过 `sendCustomMessage` 到达父代理，而 pi 的 `convertToLlm` 会把每条 `custom` 消息作为普通 `user` 回合重放给模型。因此 `subagentNotificationText()` 会给报告加上 `SUBAGENT_NOTIFICATION_PREFIX` 前缀，使压缩流程 —— 它的提示词问的是**用户**想要什么 —— 不会把子代理的输出归到 Goal / Constraints 之下（#875）。前台 `Agent` 与 `get_subagent_result` 的结果保留裸 `subagentFinalText()`：它们本来就是 `toolResult` 消息，不需要标记。前缀要放在代码里，而不是 profile 提示词里，这样模型无法丢掉它。
- pi-subagents 读取的 `skills` / `extensions` 拼写会在首次保存时种下，并在它们仍是布尔值时保持同步；手写的白名单（如 `extensions: pi-advisor-flow`）永不改写，而当 `load_skills` / `load_extensions` 缺失时，这两个标志会回退到那些别名。

### 容器里的「项目目录不存在」
- **宿主路径进不了容器是常态**：挂载宿主 `~/.pi/agent` 时，会话文件记的是宿主 cwd（`/home/me/project`），镜像里没有这个目录。浏览不受影响，运行 Agent 需要真实目录。
- **`/api/models` 绝不因为 cwd 不存在而失败**：`lib/model-cwd.ts` 的 `resolveModelCwd()` 在请求的目录不是目录或不可读时改用候选（可读根按字典序 → `getAgentDir()` → `process.cwd()` → `$HOME`，最后一个保证存在），响应带 `cwd` 与可选 `cwdNotice {requested, used, reason}`；`ChatInput` 的 `ModelCwdNoticeBanner` 以警告样式显示两条路径。此前这里返回 400 `Directory does not exist: …`，客户端把它渲染成红色「模型错误」，看起来像模型坏了（#Docker 反馈）。
- **启动会话必须拒绝**：`lib/rpc-manager.ts` 在 `SessionManager` 解析出 cwd 后立刻 `existsSync`，失败抛 `CwdMissingError`（`code: "cwd_missing"`）。`POST /api/agent/[id]` 与 `POST /api/agent/new` 映射成 `409 { code: "cwd_missing", cwd }`；SSE 的 `startup_error` 也带 `errorCode: "cwd_missing"`，`AgentEventConnectionError` 透传后由 `useAgentSession` 用 `t("chat.cwdMissing")` 本地化 —— 否则两条不同的失败路径里总有一条会露出英文原始消息。`cwd_missing` 同时算**确定性拒绝**，否则客户端会去等一个永远不会发生的 settled 事件。
- 测试注意：`/api/models` 的候选包含 `process.cwd()`，所以断言「回退到哪个目录」时要固定候选（见 `lib/model-cwd.test.mjs` 的注入式探针），路由测试只断言回退目录存在即可。

### 新失败说法的用词（改代码时保持一致）
- **`cwdNotice` / `cwd_missing`**：服务器说明「你请求的目录用不了」的结构化字段与错误码，取值 `missing | not_a_directory | not_allowed`。**能降级就降级**（模型列表、技能、插件、worktree、文件浏览器的提示）并带上 `cwdNotice`；**不能降级才拒绝**（启动 Agent、项目范围的安装）。原因不写进文案里猜：`not_allowed` 是权限问题（403 保留），另外两个是「这台机器没有这个目录」。
- **`chat.providerError.<kind>`**：提供方失败的解释文案；`lib/provider-error.ts` 分类，`MessageView` 渲染卡片、`useAgentSession` 渲染提示条。原始响应与 `request_id` 永远保留。
- **`chat.modelError`**：Pi Web 自己加载模型列表失败（不是提供方失败）。两者别混：以前提供方报的 402 和 cwd 不存在都被塞进这个横幅，用户看到的是「模型错误」，指向完全不同的东西。
- 术语表（`CONTEXT.md`）里已把 Session cwd、cwdNotice、Provider error 与 Model error 的用词固定下来，新增文案时照它写。

### 大文件与忽略范围（`.gitignore` / `.dockerignore`）
- **两个文件按「用途」排除，不按扩展名一刀切**：`docs/screenshot2.png`（README 的题图，2.1 MB）与主题光标 PNG 都是**有意提交**的资产，所以没有 `*.png` 这类规则。
- **`.gitignore` 兜底的是「本来就不该进仓库」的东西**：`docker save` 的 `*.tar*`、`npm pack` 的 `*.tgz`、`pi-web-releases/`、SQLite 库与 pi 会话（`*.db*` / `*.sqlite*` / `*.jsonl` —— 又大又含隐私）、Playwright 报告、`*.log`、编辑器与 `*:Zone.Identifier`。改完用 `git ls-files | git check-ignore --stdin -v` 确认**没有误伤已跟踪文件**（应当无输出）。
- **`.dockerignore` 决定构建上下文**：只留 builder 需要的源码与配置；`demo`/`docs`/`themes`/`AGENTS.md`/README/大产物全部排除。实测上下文 6.3 MB（排除前 >50 MB）。**新增顶层目录时先想一遍要不要进上下文**，验证方法写在 `docs/docker.md` §1.2（只 `COPY` 的临时 Dockerfile 打印 `du -sh /ctx`）。
- 子项目自带自己的忽略文件（`demo/.gitignore` 覆盖 `demo/node_modules`、`.next`、`out`、`public/demo-files`），根 `.gitignore` 的 `/node_modules` 是**锚定**写法，覆盖不到子目录。

### 两个 Dockerfile 与架构检测
- **`Dockerfile`（国内版，默认）与 `Dockerfile.global`（海外版）必须保持只有镜像默认值不同**：`lib/dockerfile-variants.test.mjs` 会把注释与 `ARG NODE_MIRROR / NPM_REGISTRY / PIP_INDEX / APT_MIRROR` 的默认值归一化后逐行比较，改了一个忘了另一个就会红。四个值都可以用 `--build-arg` 覆盖，**空值表示保留上游源**（所以 apt 的 `sed` 重写必须包在 `if [ -n "${mirror}" ]` 里 —— 否则海外版会把 `archive.ubuntu.com` 改写成没配置过的镜像）。
- **低内存 VPS 的构建 OOM**：`next build` 按 CPU 数开静态生成 worker，小内存机器上每个 worker 的 V8 堆只有 ~500 MB，构建在收集页面数据时 `Reached heap limit`。三层缓解（都已在仓库里）：`next.config.ts` 的 `memoryBasedWorkersCount: true` + `webpackMemoryOptimizations: true`，以及两个 Dockerfile 构建步骤的 `ENV NODE_OPTIONS="--max-old-space-size=${NEXT_BUILD_MAX_OLD_SPACE}"`（`ARG NEXT_BUILD_MAX_OLD_SPACE=2048`，只在 builder 阶段生效，运行时不受影响；≤2 GB 机器用 `--build-arg NEXT_BUILD_MAX_OLD_SPACE=1024`）。改动这三处或新增 docker 构建变量时，`lib/dockerfile-variants.test.mjs` 会检查。
- **架构自动检测**：`dpkg --print-architecture` → `amd64→x64`、`arm64→arm64`、`armhf→armv7l`，其它组合直接报错并列出 `NODE_ARCH` 覆盖用法；构建日志打印 `[pi-web] architecture: amd64 -> node-v22.19.0-linux-x64`。基础镜像是多架构的，`docker build` 自动取宿主机那一片；跨架构用 `docker buildx --platform`。**不要**在 Dockerfile 里写死 `linux-x64`。
- 仓库是 `agegr/pi-web` 的 **fork**（`lovelyzy7/pi-web`）：所有仓库链接（README 题图 raw 地址、release API URL、`gh --repo`、文档里的链接、`package.json` 的 homepage/repository/bugs）都指向 fork；**npm 包名仍是 `@agegr/pi-web`**，`lib/session-liveness.ts` 里的 `Symbol.for("@agegr/pi-web/…")` 是跨模块 globalThis 键，**永远不要**跟着改。改名发布到自己的 scope 时要同步的位置列在 `docs/release.md`。

### GitHub Actions 在 fork 上的两个默认开关
- **Actions 默认禁用**：fork 上 `/repos/{owner}/{repo}/actions/workflows` 返回 `total_count: 0`、也不会有任何运行 —— 用户看到的"工作流失败/不出现"多半是这个，而不是 YAML 有问题。要在 Settings → Actions 里确认一次。
- **Pages 默认未创建**：`/repos/{owner}/{repo}/pages` 返回 404，`actions/deploy-pages` 会以 "Get Pages site failed" 失败。`demo-pages.yml` 用 `actions/configure-pages@v5` 的 `enablement: true` 让第一次运行自动建站，因此工作流必须声明 `pages: write` + `id-token: write`（只有 `contents: read` 时 `configure-pages` 自己就会 403「Resource not accessible by integration」）。
- `ci.yml` 的 lint 步骤是 `npx eslint . --max-warnings 0`：仓库现在是 0 warning，这条能在 CI 里挡住遗留的未使用 import（本地 `npm run lint` 不会因为 warning 失败，曾因此漏过一个）。

### Pi Agent 的安装/更新（设置 → 更新分区）
- **两个东西都叫 pi agent，别混**：**运行时** = `@earendil-works/pi-coding-agent` SDK，会话实际用它，随 pi-web 发布更新，面板只显示版本与 npm 最新版（`lib/pi-agent.ts` 的 `fetchPiLatestVersion`，缓存于 `update_checks` 表 6 小时），**绝不热更** —— pi 0.86 就改过提示词与会话格式，单独换 SDK 会坏。
- **CLI** = 终端里敲的 `pi` 命令。`POST /api/updates/pi {action: install|update}` 用 `npm install --prefix ~/.pi/agent/pi-cli …` 装进**数据目录**（挂载卷，重建容器不丢），再往 `/usr/local/bin/pi` 放一个尽力而为的符号链接（非 root 失败就忽略，面板显示真实路径）。检测顺序：PATH → 应用自带 `.bin/pi` → 数据目录；`--version` 读版本，30s 超时。
- **Docker 部署下宿主机不可达**：GET 返回 `deployment.mode`，是 docker 就附带 `hostCommand`（`npm install -g …`）让面板直接显示"宿主机自己执行"，而不是假装容器能替宿主机安装。
- 测试注意：`installPiCli` 的 `run`/`buildInvocation`/`linkDir` 都可注入，测试绝不真的跑 npm、绝不碰 `/usr/local/bin`；路由测试通过替换 `globalThis.fetch` 离线断言。真实安装只在手工验证里做（会把 `/usr/local/bin/pi` 指向数据目录 —— 验证完要删）。

### 设置面板：项目闸门与移动端分区
- **技能/子代理/插件是「按项目」分区**：没有选中项目（全新容器还没有会话）时三个标签禁用 —— 与宿主机有没有 pi agent **无关**。面板在 `!cwd` 时显示 `.settings-project-hint`（原因 + 「创建默认项目」按钮，走 `POST /api/default-cwd` → `onProjectCreated` → AppShell 的 `setNewSessionCwd`），创建后三个分区立即启用。后端同时放宽：`/api/skills` 与 `/api/plugins` 的 GET 在没有 `cwd` 时列出全局范围而不是 400。
- **`.settings-dialog-main` 是列，不是行**：项目提示条与分区宿主必须上下堆叠。曾经把提示条当行的兄弟放进去，`flex-basis:auto` 让它按未换行的 max-content 排布、再靠 `min-width:0` 收缩——它一宽就把宿主挤成 **0 宽**，账号分区整个不可见。提示条自己还要 `flex: 0 1 auto; min-width: 0`，否则中文段落永远不换行。
- **账号分区内联子标签不要跟着主标签条隐藏**：≤640px 视口时 `.settings-section-tabs { display:none }` 换成 mobile select —— 但那只是**分区切换器**，账号自己的 `settings-section-tabs-inline` 是唯一导航，必须同块里 `display:flex` 恢复，且基础规则就 `flex-wrap: wrap; row-gap: 4px`（否则 700px 上下的中宽面板会把最后的子分区裁掉）。`components/SettingsPanel.test.mjs` 里有两组断言守住这些。

### 容器里的「项目目录不存在」与提供方报错
- **「同路径挂载」是硬约束，不是建议**：会话文件里存的是绝对 cwd，容器里少了这个目录，Agent 无法运行、文件浏览器为空、技能/插件读不到项目范围。实测（`pi-web:latest`，两个同级项目会话）：`-v /home/pi_agent_project:/home/pi_agent_project` → 两个项目都 200；`-v /home/pi_agent_project:/workspace` → 两个都 404（换路径等于没挂）；只挂 `-v …/pi-web:/home/pi_agent_project/pi-web` → 本项目 200、兄弟目录（以及 `<仓库>-worktrees/`）仍 404。所以文档一律要求挂**项目父目录**、路径一字不差、读写挂载。
- **路由文件只能导出处理函数**：`app/api/.../route.ts` 里多导出一个辅助函数（`export function nearestMissingRoot`），`next build` 的 `.next/types` 检查会报 `Type ... does not satisfy the constraint '{ [x: string]: never }'` 而**构建失败** —— `tsc --noEmit` 看不到这一条（类型在构建时才生成），所以「本地类型检查干净」不代表镜像能构建。辅助函数放 `lib/`（这里是 `lib/missing-path.ts`）。
- **降级而不是 403/404**：`lib/project-cwd.ts` 的 `resolveProjectCwd()` 区分 `ok|missing|not_a_directory|not_allowed|none`。缺失的目录（容器没挂项目）在**读**路径上降级为全局范围并带 `cwdNotice`；不变的是「存在但不在可读根里」仍然 403 —— 那才是真正的授权失败。落地处：`/api/skills`（以前整块 403 Access denied，把全局技能一起藏了）、`/api/plugins`（读降级、写 409 `cwd_missing`，因为往不存在的目录里装东西没有意义）、`/api/worktrees`（空列表 + notice）、`/api/git/status` 与 `/api/file-index`（404 + `code: "cwd_missing"` + `path`）、`/api/project-trust`（`cwd_missing` → 界面按"没有资源可信任"处理，不写 console.error）。
- **文件浏览器**：`/api/files` 对 `type=list` 的缺失目录返回 `code: "cwd_missing"`、`path`（请求的那个路径）与 `missingRoot`（树在哪一层就不存在了，多级缺失时就是挂载点）；`FileExplorer` 用 `CwdMissingError` 把它变成 `files.cwdMissing` 的本地化文案，而不是 "Not Found"。
- **提供方报错**：`lib/provider-error.ts` 解析 pi 存下来的 `Error: <status> {json}`，识别 402/401/403/404/413/429/5xx 与常见 `type`（`insufficient_balance_error`、`rate_limit_error`、`overloaded_error` …），得到 `{status, code, message, requestId, kind, raw}`。`MessageView` 把整段就是提供方错误的文本渲染成 `ProviderErrorCard`（类别解释 + 原文 + request id + 折叠的原始响应），`useAgentSession` 的 `providerErrorNotice()` 让提示条用同一套措辞。**只改呈现**：不拦请求、不改重试、不改 agent 行为。新增 kind 时必须同时补 `chat.providerError.<kind>` 三种语言，`components/ProviderErrorCard.test.mjs` 会检查。

### 认证、限流与数据库
- Pi Web 把自己的状态 —— 账号、登录会话、审计事件、限流计数、允许根目录、各种缓存 —— 存在 `~/.pi/agent/pi-web/pi-web.db` 的 SQLite 里。pi 的文件（sessions、`auth.json`、`models.json`、`settings.json`、agents、项目信任）保持文件形态，因为 pi CLI 与 TUI 会读写它们。`lib/db.ts` 是唯一的打开者；`getDatabase()` 缓存在 `globalThis` 上以免热重载开第二个连接；迁移只追加，更新的 `user_version` 会被拒绝。见 `docs/adr/0006-pi-web-database.md`。
- **`proxy.ts` 有两种互斥模式。**`PI_WEB_PASSWORD` 保持原有的环境变量口令行为（HMAC cookie，不需要数据库）。否则适用账号模式：cookie 是随机 `pws_…` 令牌，在 `web_sessions` 里以 SHA-256 摘要存储，通过主键以及「会话 `epoch` 与 `account.session_epoch` 相等」来校验。`isAccountConfigured()`（`password_hash` 非空）是 `/init` 与 `/login` 之间唯一的开关。
- **代理从不运行 scrypt。**口令校验位于 `/api/web-auth`（登录）、`/api/web-auth/init` 与改密码路由。每个请求都经过代理 —— 包括 2.5 秒的运行状态轮询与每一帧 SSE —— 因此在那里放故意很慢的 KDF 就是自造 DoS。改密码会递增 `session_epoch`，一次性作废所有会话；发起改密的浏览器会拿到新令牌。
- 限流刻意是全局而非按 IP：Next 16 的路由处理器没有套接字地址，`x-forwarded-for` 可伪造。失败按 scope（`login`、`init`）使延迟翻倍（1s → 60s 上限），成功或空闲 5 分钟会重置。重置窗口必须长于最大延迟，否则等过一次封禁就等于重启爆发窗口。计数是 `auth_throttle` 里的行，因此重启无法给爆破者一段新窗口；当数据库打不开时（agent 目录只读的 `PI_WEB_PASSWORD` 模式），`lib/auth-throttle-store.ts` 警告一次并退化为进程内存。
- `POST /api/web-auth` 与 `/api/*` 上每个 `Authorization: Basic` 头共用 `login` 计数；`proxy.ts` 在它的 `/api/web-auth` 豁免之前检查 Basic，因此 `GET /api/web-auth` 不是无限流的密码探测口。有效的会话 cookie 先被检查，且永不被封禁。封禁期间 Basic 即使口令正确也返回 `429`（否则答案会泄漏），而一次 Basic 成功不会重置计数：Basic 客户端每个请求都认证一次，重置等于让交替猜测者回到基础延迟。账号模式下，一次成功的 Basic 校验会缓存五分钟（`globalThis.__piWebBasicAuthCache`，键含改密时间戳），否则每个请求都要跑一次 scrypt。
- `/init` 是唯一无需认证的写入端点，因此它要求启动时打印的验证码（`lib/init-setup.ts`）。这里**没有回环豁免**：Next 会自己注入 `x-forwarded-for`，却把客户端提供的值原样透传，因此 `Host: 127.0.0.1` 加上伪造的头就能自称本地。脚本化路径改由 `PI_WEB_INIT_TOKEN` 承担。
- 数据库打不开时，代理失败关闭并返回 `503`：没有它就无法区分已认证请求，而旧行为「没配密码=开放」会静默丢掉认证。

### 双因素认证、API 令牌与响应头
- TOTP 在 `/user` 登记、在登录时校验；**代理从不检查动态码**，理由与它从不跑 scrypt 相同。登录是两次 POST 到 `/api/web-auth`：口令返回 `{totpRequired: true, challenge}` 且不下发 cookie；挑战值（以已存口令哈希为 HMAC 密钥，因此改密即失效）加上动态码才返回会话。见 `docs/adr/0007-two-factor-and-api-tokens.md`。
- 种子用 AES-256-GCM 封装在 `~/.pi/agent/pi-web/secret.key` 下，而不是存在数据库里，因此仅有一份数据库副本无法生成动态码。只恢复数据库而丢掉密钥时**失败关闭**并给出明确错误。
- `account.totp_last_step` 记录已接受的时间步；等于或早于它的一律拒绝，因此一个码不能在其 30 秒窗口内登录两次。恢复码是单次使用的 SHA-256 行，界面显示未使用数量，避免最后一个被不知不觉用掉。
- **登记第二因素后 HTTP Basic 被拒绝**（`token_required`）：Basic 无法携带动态码，放行它会让登记失去意义。`Bearer pi_pat_…` 令牌取代它；只存其 SHA-256，`read` scope 仅限安全方法，`last_used_at` 每分钟最多写一次。
- 安全响应头按需求拆分：固定项（nosniff、frame DENY、referrer、permissions、COOP）由 `next.config.ts` 覆盖所有路径；基于 nonce 的 CSP 与 HSTS 由 `proxy.ts` 施加，因为只有代理知道请求的协议并能按响应生成 nonce。`proxy.ts` 会把 nonce 转发到请求上，使 Next 给自己的内联脚本打上它，`app/layout.tsx` 也能给主题脚本打上。
- **CSP 默认只报告**（`PI_WEB_CSP=enforce` 强制，`off` 跳过）：差一条指令的策略会让升级后的安装直接坏掉，而应用依赖内联样式（xterm、KaTeX）并注入内联主题脚本。`next.config.ts` 以显式 `.ts` 扩展名导入 `lib/security-headers.ts`，因为 `lib/next-config-esm.test.mjs` 通过 Node 的类型剥离加载该配置，而后者要求完整说明符。

### 认证与模型配置
- `ModelsConfig` 把 `~/.pi/agent/models.json` 里的模型与 pi 的 `AuthStorage`/`ModelRegistry` 给出的提供方认证状态合并展示。
- 提供方列表由能力驱动，绝不由 id 驱动：`lib/provider-listing.ts` 依据 `auth.apiKey.login` / `auth.oauth` 与已存凭据类型决定归属，因此双重认证的提供方（目前是 anthropic 与 github-copilot —— 哪些提供方同时声明两者会随 SDK 版本变化，所以永远不要从 id 推断）恰好出现一次，也不会在两个列表里都漏掉（#309）。`lib/provider-listing-runtime.ts` 把 `ModelRuntime` 适配到这些纯函数。
- `auth.json` 每个提供方只保存**一份**凭据，`ModelRuntime.logout()` 删掉的就是那一份。因此删除路由使用 `removeStoredCredentialIfType()`，在与 pi 的 auth 存储相同的文件锁下比较并删除。任何认证变化后，`ModelsConfig` 会刷新**两个**提供方列表 —— 只刷新一个会让双重认证的提供方渲染两次。
- OAuth/设备码/手动码流程由 `GET /api/auth/login/[provider]` 以流式传输；手动码响应 POST 回来时带一个短期令牌，存在 `globalThis.__piLoginCallbacks`。
- API Key 路由通过 `AuthStorage` 存储与移除密钥。状态端点绝不返回原始密钥。
- 模型测试路由是 `app/api/models-config/test/route.ts`；`app/api/models/test/` 不是真实路由。

### 第三方主题（`docs/adr/0008`、`docs/theme-development.md`）
- **主题是数据，不是代码**：一份 `theme.json` 清单加一份只允许在 `html[data-pi-theme="custom"]` 内覆盖既定变量的样式表。那个 `html` 前缀是承重的 —— 它压过 `[data-theme="…"]` 配色块，且不依赖样式表顺序。
- **基础配色留在下层**：服务端渲染 `data-theme="<manifest.base>"` 与 `data-pi-theme="custom"`，并且 `THEME_INIT_SCRIPT` 与 `useTheme` 的 `applyDomTheme` 在主题生效期间都拒绝覆盖 `data-theme`。覆盖它曾是第一个「能跑但不对」的 bug：主题加载了，随后初始化脚本把属性重置，什么都没变。
- **文件由服务端取回并提供**（`/api/themes/asset/...`），绝不由浏览器直接获取：CSP 保持 `style-src 'self'`，响应经过校验、限制大小（`X-Content-Type-Options: nosniff`），并缓存在 `market_cache`（commit 24 小时不可变、分支 1 小时、本地目录不缓存）。
- **来源**：`github.com/owner/repo/tree/<ref>[/sub]`（或 `github:owner/repo@ref` 简写）、`local:/abs/path`（必须位于可浏览根或 `~/.pi/agent/themes` 内），以及仅在 `PI_WEB_THEME_ALLOW_ANY_URL=1` 时开放的任意 https 主机；回环与 RFC1918 主机永远拒绝，使代理无法被指向内网。
- 任何东西被保存之前都会校验：schema、每个选择器的作用域、禁止 `@import`、禁止外域 `url()`、禁止 `expression()`/`behavior:`/`-moz-binding`、体积上限、保留/未知变量警告，以及 WCAG AA 对比度检查。
- **主题永远到不了 `/login`、`/init` 或错误页**，出问题时有三条逃生通道：`?theme=off`、主题分区里的按钮（两者都写 `pi-web-theme-off`，布局在渲染时读取它），以及用 `sqlite3` 删除 `app_settings` 里的 `theme:active` 行。
- 配色选择器从「常规」迁到新的主题分区，第三方控件也在那里。「常规」的各区块现在通过 `.settings-general-sections` 排布。
- **变体**：清单里的 `variants: { light, dark }`，与基础样式表同等校验（缺失或越界 ⇒ 拒绝整个主题）。`ThemeVariantLink` 在模式切换时替换链接；服务端渲染 `manifest.base` 保证首屏，`useTheme.applyDomTheme` 只在 `data-pi-theme-variants="1"` 时放行用户的明/暗选择。
- **资源 URL 是路径式**（`/api/themes/asset/theme.css`、`…/asset/assets/cursor.png`）：样式表里的相对 `url(assets/…)` 会相对它自己的 URL 解析，而 `?path=` 形式会破坏这一点。白名单接受 `theme.json`、`theme.css`、`theme.<模式>.css` 与 `assets/` 下的一切。
- **`/login` 与 `/init` 不带任何主题标记**：代理在这些页面请求上设置 `x-pi-theme: off`，布局遵守它。在此之前，登录页会链接样式表，请求未认证，响应是 `text/plain`，加载守卫于是把主题当成坏的并关掉它。
- **预览失败不得关闭主题**：布局给预览样式表打 `data-pi-theme="preview"`（已应用的是 `"active"`），`ThemeLoaderGuard` 只让**已应用**主题的加载失败写 `pi-web-theme-off`；预览失败只删预览链接并清掉预览 cookie —— 这正是"在真实界面预览没生效"的由来：一次加载失败会把整个浏览器的主题关掉 24 小时，而且界面上没有任何解释。因此预览 cookie 不再是 httpOnly（页面要能清它），面板在安全 cookie 存在时显示原因并给出 **重新启用主题**（之前只有关闭、没有回来）。
- **`/api/themes/preview` 先 `resolveTheme` 再重定向**：读不出的主题就在刚打开的那个标签页里返回一张 HTML 原因页（400/502），而不是 302 之后让浏览器落到一个"看起来正常、但没主题"的页面 —— 后者看起来就像按钮没反应。
- **`lib/highlight-style.ts`：`vs` 与 `vscDarkPlus` 不能直接传给 `SyntaxHighlighter`。** `vs` 给 `pre[class*="language-"]` 写 `backgroundColor`、`vscDarkPlus` 写 `background`，而两者落在同一个 `<pre>` 上（还有我们自己的 `customStyle`），切换配色时 React 会报「Removing a style property during rerender (backgroundColor) when a conflicting property is set (background)」。`prepareHighlightTheme()` 把主题每个节点里的冲突组展开成 longhand（并按对象记忆化，保持引用稳定），`splitConflictingShorthands()` 用于我们自己的 `customStyle`；`components/MermaidBlock.tsx` 与 `components/FileViewer.tsx` 都只经这两个函数传样式。解析不出的简写保持原样 —— 猜错会真的改掉渲染结果。
- **`stopPreview()` 恢复预览前的文档状态**，而不是删除 `data-pi-theme`。它也会从卸载清理里运行，而无条件删除会在设置面板一关闭时就把已应用的主题从页面上撕掉。
- **批准根目录的测试必须装一个内存数据库**：`allowFileRoot()` 会写 `allowed_roots`，而 `lib/db.ts` 的 `getDatabase()` 在没有测试数据库时打开的是操作者真实的 `pi-web.db`。`lib/subagent-isolation.test.mjs`（`addWorktree` 会批准新 worktree）与 `app/api/cwd/validate/route.test.mjs`（校验即批准）曾因此在真实库里留下 22 条指向已删除临时目录的根；两处都已改为 `installDatabaseForTests(openDatabase(":memory:"))`。新写这类测试时照做。
- `allowFileRoot()` 现在会**持久化**到 `allowed_roots`（ADR 0006 早已如此声明）；`isLocalThemeAllowed()` 也接受 `PI_WEB_THEME_ROOTS`，面板可以用 `allowLocal: true` 批准一个主题目录 —— 与目录选择器批准一个项目是同一个显式决定。读与写都经过 `withExistingDatabase()`，它**绝不创建**数据库：这个模块位于文件访问路径上，而仅仅读取允许根目录的测试曾在操作者的 agent 目录里留下一个 `pi-web.db`。`lib/file-access.test.mjs` 断言读取与批准都不会创建任何文件。
- **本地主题靠探测，不靠手输路径**：`lib/theme-local.ts` 扫描托管目录（`~/.pi/agent/themes`）、`PI_WEB_THEME_ROOTS`，以及所选项目的 `<cwd>/themes` 与 `<cwd>/.pi/themes`；后两者只在项目本身可浏览时才读（allowed roots 是同一道边界）。以 `_`/`.` 开头的目录跳过，缺 `theme.json` 的跳过。导入 = 校验通过后把目录复制到 `~/.pi/agent/themes/<manifest.id>`，因此原目录可以删（容器里托管目录就是挂载卷）；导入前先跑完整校验，坏主题进不去。硬规则：目录含符号链接直接拒绝（否则「导入」等于复制任意文件）、整目录上限 32 MiB、同名存在时返回 `exists`，面板用 `overwrite: true` 重来（这就是手动更新的方式）。`remove` 只删托管目录**直接位于其下**的目录，手写的项目主题删不掉。托管目录里的 `managed` 标记比较的是主题的**父目录**与托管根，不是主题目录本身。
- **商店版本有两个来源**：清单条目里可选的 `version`，否则由 `/api/themes/store/versions` 按需读取主题自己的 `theme.json`（并发 4，缓存在 `market_cache`）。它不挂在商店请求上，使列表能立即渲染；该端点同时报告哪些条目比已应用主题更新。
- **e2e 会先创建账号**（`e2e/run.mjs`）：在账号模式下，未初始化的实例对每个 API 路由都返回 401，因此该套件固定 `PI_WEB_INIT_TOKEN`、完成 `/init`，并把会话 cookie 同时带进 `fetch` 与浏览器 context。没有这一步，CI 的就绪探测会因空口令超时。
- **商店是清单，不是信任决定**：条目会被规范化成普通主题来源并重新校验，因此商店无法给任何东西开白名单。它
的清单与封面图都由服务端取回（`market_cache`，source `theme-store` / `theme-cover`），且清单地址必须是公开 https。
- **路由处理器里的重定向不得使用 `request.url`。**Next 用它绑定的地址构建它（监听所有网卡时是 `http://0.0.0.0:30141`），于是 `/api/themes/preview` 把浏览器送到了它没有会话 cookie 的主机上并落在 `/login`。`clientOrigin()` 用 `Host` 头加 `x-forwarded-proto` 重建来源，这也是反向代理所需要的。因此预览链接的是**被预览的**来源（`preview=1&source=…`），而不是已应用的那个。

### 设置分区与合并进来的页面
- 九个设置控件会让标签太多，因此面板有九个分区，账号中心保留自己的内联子标签行：`settings-section-tabs-inline` 变体就是头部标签去掉固定的 50 像素头部几何。
- **`SETTINGS_SECTION_VALUES` 是唯一真值来源。**不在该列表里的分区无法被保存或恢复，`SettingsPanel` 也不会渲染它；面板的 `sections` 数组、移动端选择器与图标都读同一个联合类型。
- 账号、市场与更新是**一个组件两个宿主**：设置面板内嵌渲染 `AccountSettings`/`MarketSettings`/`UpdatesSettings`，而 `/user`、`/market`、`/updates` 把同一批组件放进页面外壳以支持深链接。区别只在外壳 —— 页面宿主多一个标题、一个返回链接，以及（市场页）项目选择器，因为面板已经知道所选项目。
- 市场详情**在面板内替换网格**（`.market-detail-inline`），而不是再叠一层 `settings-dialog-backdrop`；两层叠加还会让 Esc 关掉整个面板而不是详情。
- 跨分区导航是回调而不是链接：`PluginsConfig` 接收 `onOpenSection`，聊天的更新横幅接收 `onOpenSettings`，两者都打开面板到正确分区，而不是跳到重复它的页面。回调缺失时 `/updates` 页面仍是回退。
- **面板宽约 1080px，一列 420px 的控件会浪费大半。**去掉 `.settings-general` 旧的 680px 上限并没有解决它 —— 里面的单个控件块本就限在 420px，空白只是挪了位置。各区块现在进入 `.settings-general-sections`，一个在 900px 以上双列的网格，每个控件块填满自己的列（`.settings-general-sections > .settings-general-section > … { max-width: 100% }`）。正文保持可读行宽。新增一个区块就是新增一个网格子项，而不是一次布局决策。
- **主题分区按 CF-Server-Monitor 的主题页设计**（用户要求替换掉原有分区式布局）：`theme-warning`（⚠️ 实验性说明 + 逃生通道按钮 + 主题是什么 + 坏主题怎么办）→ `theme-toolbar`（当前主题 label/value + 版本/基底/变体/来源/引用）→ `theme-custom` 卡片 ×2（内置配色选择器；主题来源表单 + 校验结果）→ `theme-roots`（探测目录，`<details>` 折叠）→ `theme-grid` 卡片网格（本地主题与商店条目同一个网格）→ 导入行 → `theme-footer`（商店地址/刷新/文档链接）。类名与 CF-SM 的 `ThemeStorePanel.vue` 对齐（`theme-card`/`theme-cover-wrap`/`theme-info`/`theme-header`/`theme-title`/`theme-version`/`theme-tags`/`theme-tag`/`theme-desc`/`theme-author`/`theme-space`/`theme-actions`）。
- **卡片对齐靠三件事，动它们要重测**：① 封面 `aspect-ratio: 16/9` + `overflow: hidden`，没有封面的卡片用 `ThemeCardCover` 占位填满同一个盒子（`ThemeCover` 的 `onError` 也回退到它，否则裂图会撑塌整行）；② `.theme-info { flex: 1 }` + `.theme-space { flex: 1 }` 把动作行压到卡片底部；③ **每张卡片都恰好 3 个动作**（本地：应用/真实预览/导入或移除；商店：应用/真实预览/↗ 查看），否则 2 个动作的卡片动作行会高一截，同一行的卡片就错位 —— 这是实测发现的问题，商店条目因此要在解析时带上 `homepageUrl`。窄容器（`@container settings-panel (max-width: 700px)`）整页竖排、按钮全宽，和 CF-SM 的 720px 规则一致（**不能写 `max-width: 720px`**，`SettingsUi.test.mjs` 的惰性正则占用了那个字面量）。
- **配色选择器位于主题分区，不在「常规」。**`components/ThemeSettings.tsx` 拥有它，因为第三方主题的工作也落在那里；「常规」保留聊天行为、推送、语言、shell 与退出登录。

### 市场、更新与容器内更新
- 目录**没有 JSON API** —— pi.dev 对 `/api/*` 回答「API routes are reserved for future features」—— 因此 `lib/market-catalog.ts` 解析站点已经渲染的标记：`/packages` 卡片上的 `data-package-*` 属性与详情页的 `definition-grid`。每个字段都是可选的，站点变化只会让字段变少，绝不抛错。README 文本取自 npm registry（markdown），而不是站点的已净化 HTML。
- 解析后的列表页与详情缓存在 `market_cache`（6 小时 / 24 小时）。刷新失败时返回标了 `stale: true` 的旧副本而不是让页面变空，界面会说明正在显示哪一种。
- **市场通过 `/api/plugins` 安装**，那里已经拥有包管理器、项目信任与设置文件。这就是该页面需要项目的原因：插件路由用文件访问白名单校验 `cwd`，而 agent 目录刻意不在其中。
- 更新检查从 `globalThis` 搬到 `update_checks` 表，因此重启不会重新查询 npm，横幅与更新页也不会互相矛盾。`force` 故意绕过 `PI_WEB_SKIP_VERSION_CHECK` —— 这正是「立即检查」的含义。
- `deploymentMode()` 决定「更新」长什么样：`/.dockerenv` 表示 Docker，argv 路径位于 `node_modules/@agegr/pi-web` 下表示全局 npm 安装，其余是源码检出。页面按识别结果打印对应命令。
- **容器内更新是选项式开启**（`PI_WEB_ALLOW_SELF_UPDATE=1`），因为它允许服务替换自己的代码。它把 registry 上的 `@agegr/pi-web@<version>` 安装进 `PI_WEB_RELEASES_DIR/<version>`，之后才切换 `current` 符号链接，因此下载失败不会影响正在运行的版本；安装失败会清掉它自己的目录。先检查 `engines.node`，不匹配就拒绝并给出「重建镜像」的理由。`bin/docker-entrypoint.sh` 在 `current` 存在时启动它，因此一次容器重启就是应用更新，旧版本留在磁盘上供回退按钮使用。

### 完成提示音
- `hooks/useAudio.ts` 把开关以 `pi-sound-enabled` 存进 `localStorage`，并复用一个 `AudioContext`。
- 浏览器自动播放策略要求声音必须由用户手势解锁；`ChatInput` 从交互控件调用解锁 hook，`ChatWindow` 在 `onAgentEnd` 时播放提示音。

### 导出的会话 HTML
- `/api/sessions/[id]/export` 委托给 pi 的导出辅助，然后把生成 HTML 里的递归树辅助改成迭代版本，使极深的线性会话不会让浏览器调用栈溢出。

## Pi 会话文件格式

位置：`~/.pi/agent/sessions/<编码后的 cwd>/<时间戳>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext` 里的 `entryIds[]` 与 `messages[]` 是并行的数组 —— 把每条展示的消息映射回它的 `.jsonl` 条目 id，用于 fork 与 navigate_tree 调用。

---

## CSS 变量（`app/globals.css`）

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --accent-hover --accent-contrast
--user-bg --assistant-bg --tool-bg --bg-subtle
--danger --success --warning --info
--terminal-bg --terminal-fg --terminal-cursor --qr-bg
--font-mono
```
