# CI 与浏览器回归测试

改编自 @Nuctori 在 #617 与 #599 中的 CI/E2E 方案。性能扫描器、反向读取器、侧边栏改动与计时基准未包含在内。

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

脚本会在一个可用的回环端口上自行启动并停止 Turbopack 开发服务器。请在没有活跃开发服务器的检出目录里运行它：同一检出目录内的 Next.js 会共用 `.next/dev/lock`。所有夹具在启动前创建于一个临时的 `PI_CODING_AGENT_DIR`，并在结束后删除。不需要模型凭据，也不需要已有的 Pi 会话。

CI 在一个 job 里运行 lint、类型检查与单元测试；另一个 job 在干净的检出目录里构建应用，并以 `E2E_SERVER_MODE=start` 对 `next start` 运行同一批浏览器测试。不要在用于开发的检出目录里构建。

覆盖范围：

- 一个 5000 条消息的会话只打开最后 50 条，详情/上下文响应有界，且无浏览器错误。
- 桌面与移动端滚动会连续加载两页更早的消息。每个响应的 id 符合预期，无缺口与重复，消息在聊天里只出现一次。另有一个小会话检查经由根节点的分页。
- 分支上下文跟随所选叶子节点，并排除另一分支。
- Markdown、代码块与真实的 tool-call/tool-result 块能正确渲染。
- 聊天宽度与字号可持久化，已有草稿会随窗口变化重排，短设置面板在桌面与移动端都能触达每个语言选项。
- 未知会话与夹具项目之外的路径会被拒绝。
- 一个本地扩展检查对话框键盘导航、Esc 取消、折叠/展开时的草稿保留、倒计时显示以及服务端过期。

模型提示词、真实的模型流式输出与 agent 执行不在本套件范围内。失败时会在 `test-results/e2e/` 下保存截图、Playwright trace 与服务端日志，CI 会上传该目录。用 `npx playwright show-trace test-results/e2e/trace.zip` 打开 trace。
