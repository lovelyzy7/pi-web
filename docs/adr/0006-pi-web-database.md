# 0006 — Pi Web 把自己的状态放进 SQLite，pi 的文件仍是文件

## 状态

已接受。

## 背景

在这次改动之前，Pi Web 没有数据库。它需要记住、又不属于它读取的那些 pi 文件的东西，要么放在 `~/.pi/agent/*.json` 里，要么放在进程内存里：

- 浏览器密码是环境变量，因此「改密码」意味着改 compose 文件并重启容器；
- 会话 cookie 是 `HMAC(PI_WEB_PASSWORD)`，只能整体作废 —— 改密码，无法只登出一台设备；
- `lib/auth-throttle.ts` 把失败计数放在 `globalThis` 上，重启就等于给爆破者一段新的窗口；
- `allowFileRoot()`（通过 `/api/cwd/validate` 批准的目录）只是内存集合，重启就静默丢掉了操作者批准过的根目录；
- 会话列表索引、更新检查结果、web-push 密钥与订阅要么是 JSON 文件、要么是 `globalThis` 值，必须重建或者直接丢失；
- 而且完全没地方记录谁在什么时间、从哪里登录过。

背景的另一半是：有些东西**不能**搬走。pi 拥有 `~/.pi/agent/sessions/**`、`auth.json`、`models.json`、`settings.json`、`agents/*` 以及项目信任库，并且 pi CLI 与 TUI 也在读写它们；Pi Web 只是多个写入者之一。

## 决策

**Pi Web 把自己的数据存在 `~/.pi/agent/pi-web/pi-web.db`，同时继续把 pi 的文件当文件读写。**

- 数据库放在 agent 目录里是刻意的：在文档化的容器部署中，那是唯一被挂载的卷，因此重建容器会保留账号、审计日志与各种缓存，而一次 `tar` 打包 `~/.pi/agent` 就是完整备份。
- **schema 只保存 Pi Web 自己的数据**：`account`、`web_sessions`、`auth_events`、`auth_throttle`、`app_settings`、`allowed_roots`、`api_tokens`、`update_checks`、`market_cache`、`jobs`/`job_logs`、`push_state`。任何 pi 也会读的东西都不镜像进来。可以完全由 pi 的文件重建的缓存（会话列表索引）以后可以搬进来，但文件始终是权威来源，缓存也必须能按 mtime 失效。
- 驱动选择 `better-sqlite3`：同步 API 让路由与代理保持简单，并且它为受支持的平台提供 N-API 预编译。`lib/db.ts` 是唯一打开它的模块，`getDatabase()` 缓存在 `globalThis` 上以免热重载开第二个连接，迁移通过 `PRAGMA user_version` 版本化（由更新版本写出的数据库会被拒绝打开，而不是降级使用）。
- **账号取代环境变量密码，但不移除它。**`PI_WEB_PASSWORD` 仍会把应用切回原来的模式：cookie 是旧的 HMAC 令牌，不需要数据库；账号模式是默认模式，也是唯一拥有 `/init`、`/user` 与逐设备撤销的模式。两种模式互斥，代理在做任何认证判断之前先选定其中一种。
- 账号是否已配置的判据是 `isAccountConfigured()`（是否存在 `password_hash`），而不是一个可能与数据不一致的独立标记。
- **口令哈希用 Node 自带的 `crypto` 里的 scrypt**，存储格式为 `scrypt$N=..,r=..,p=..$salt$hash`，因此不为一件事引入原生 KDF 依赖 —— 而这件事恰恰不能自己手写。口令校验只发生在 `/api/web-auth`（登录）、`/api/web-auth/init` 与改密码路由里。**代理从不运行 scrypt**：它用主键在 `web_sessions` 中校验随机令牌，并比对会话的 `epoch` 与账号的 `session_epoch`。每个请求都会经过代理，包括 2.5 秒一次的运行状态轮询和每一帧 SSE，因此把故意很慢的 KDF 放在那里就是自造拒绝服务。
- **`/user` 页面即账号页**，其中只在账号模式下才有意义的部分在环境变量模式下是隐藏的，而不是以无法解释的样式禁用。
- `lib/init-setup.ts` 里的**首次初始化验证码**之所以存在，是因为 `/init` 是唯一无需认证的写入端点。这里刻意没有「可信来源」豁免：Next.js 会自己注入 `x-forwarded-for`，却把客户端提供的值原样透传，路由处理器也拿不到可靠的套接字地址，因此能连到端口的攻击者可以发 `Host: 127.0.0.1` 声称自己来自本机。脚本化初始化改由 `PI_WEB_INIT_TOKEN` 承担。
- 失败计数是 `auth_throttle` 里的行，按 scope 区分（`login`、`init`，以后还有 `totp`），退避曲线仍以纯函数放在 `lib/auth-throttle.ts`。当无法使用数据库时，`lib/auth-throttle-store.ts` 会退化为进程内存并给出警告 —— 环境变量密码模式必须能在 agent 目录只读的机器上继续工作，丢一个限流计数总好过拒绝启动。
- 数据库打不开时，代理**失败关闭**：没有它就无法区分已认证与匿名请求，而旧行为（没配密码=开放）会静默丢掉操作者要求的认证。

## 影响

- 全新安装会落在 `/init`，之后 `/login` 登录，`/user` 显示账号、已登录设备与审计日志。在环境变量密码模式下，`/init` 报告 `reason: "environment"`，账号相关标签页保持隐藏。
- 修改密码会 `session_epoch+1` 并给浏览器换发新会话，因此「改密码」与「其它设备全部登出」是同一个事务。
- 账号模式下 HTTP Basic 对 API 客户端仍然可用，但一次成功的校验会被缓存五分钟，因为 Basic 客户端每个请求都携带口令。缓存键包含改密时间戳。
- 数据库是默认模式的新硬依赖，`better-sqlite3` 必须留在 `serverExternalPackages` 里；把它打包进去会让运行期的原生预编译失效。
- 迁移只追加：已发布的迁移永不修改，`user_version` 更新的数据库会拒绝打开，而不是在它不理解的 schema 上默默运行。
- 备份是一个目录，但 SQLite 运行在 WAL 模式：请用 `VACUUM INTO` 复制数据库，而不是直接拷文件，否则会漏掉 `-wal` 旁文件。
- `allowed_roots` 让「批准过的目录」跨重启存活，但这条路径（`lib/allowed-roots.ts`）**绝不创建数据库**：它位于文件访问路径上，只读地读取已经存在的库；未安装数据库时批准只保存在内存里。
