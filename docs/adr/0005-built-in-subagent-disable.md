# 0005 — 内置子代理在设置里关闭，而不是复制成文件

## 状态

已接受。

## 背景

Pi Web 把三个内置 profile（`general-purpose`、`explore`、`plan`）作为常量放在 `lib/subagents.ts` 里。其余 profile 都活在 markdown 文件里 —— `~/.pi/agent/agents/*.md`、`.agents/agents/*.md` 或 `.pi/agents/*.md` —— 用 frontmatter 的 `enabled: false` 关闭。

内置 profile 没有这样的文件，于是 Agents 面板把它的开关连同整个表单一起渲染成禁用，唯一的关闭办法是写一个同名文件去遮盖它（#874）。这办法能用，但代价远大于用户的要求：

- 遮盖文件是内置系统提示词的**完整副本**，冻结在复制时的版本，之后对提示词的改进永远到不了用户手里，文件里也没有任何地方说明它曾是副本；
- 面板的 `Duplicate` 按钮会改名（`explore` → `explore-copy`），因此它根本不产生遮盖 —— 用户必须自己知道要改回原名；
- 「想少一个 agent」最后变成磁盘上的一个文件，连正在读同一目录的另一个运行时（pi-subagents）也会看到它。

## 决策

**内置 profile 的关闭状态是 `~/.pi/agent/agents/settings.json` 里的一个名字**，也就是已经存放 `builtInEnabled` 与 `maxConcurrent` 的那个文件：

```json
{ "version": 1, "builtInEnabled": true, "disabledBuiltIns": ["explore"] }
```

- `lib/subagents.ts` 里的 `builtInProfiles()` 根据该列表给常量打上 `enabled`；`listSubagentProfiles` 与 `listSubagentProfileSources` 都经过它，因此面板、`Agent` 工具描述与 `resolveSubagentProfile` 里的启动守卫无需第二条代码路径就能保持一致。
- **每次写入都是对所存列表的最小编辑**，与 ADR 0004 的 `enabledModels` 开关一样。本次调用没碰过的名字保持原有位置与拼写，包括没有任何内置 profile 认领的名字 —— 那通常意味着文件由更新的版本写入，丢
  掉它会在那个版本下次启动时静默重新启用某个 agent。服务端保存内置自己的拼写，并以不区分大小写的方式匹配，与其它地方比较 profile 名称的方式一致。
- **读取该列表时失败开放**，与 `isBuiltInSubagentsEnabled` 的失败关闭相反。设置文件损坏不应让内置 profile 从面板消失；而同一文件里的功能开关此时已经失败关闭，因此任何东西都无法被派发。
- `PATCH /api/subagents/profiles` 接受 `scope: "builtin"` 并把它路由到该设置；`PUT` 与 `DELETE` 仍然拒绝该 scope，因为没有文件可写或可删。路由返回带新 `enabled` 的内置 profile，面板据此更新它已有的那一行。
- **同名文件依然整体替换内置 profile，包括它自己的 `enabled`。**`disabledBuiltIns` 描述的是内置本身，而不是这个名字：遮盖文件本身就是一个独立 profile，通过它自己的 frontmatter 关闭。

**内置 profile 依旧刻意不可就地编辑。**这次只给开关找了个写入位置；内置的名称、提示词、工具与模型，要通过保存同名 profile 去遮盖来改变 —— 那是受支持的路径，不是缺少功能的变通。可编辑表单必须把结果持久化成 profile 的完整副本，冻结在复制时的版本，而这正是本决策要避免的代价，所以开关是内置唯一拥有的控件。

## 影响

- 关闭一个内置不会留下 `.md` 文件，因此 pi-subagents 以及任何读取那些目录的运行时都不受影响，内置的提示词也会继续跟随 Pi Web 所发布的版本。
- 运行中的会话保留创建时的 `Agent` 工具描述，因此被关闭的内置在那里仍会被列出，直到会话重载。但它无法启动：`resolveSubagentProfile` 会重新读取设置并拒绝调用，与文件 profile 在会话中途被关闭时的行为完全一致；因此这个开关不像 `builtInEnabled` 那样要求重载。
- `readSubagentSettings()` 现在会报告 `disabledBuiltIns`。`maxConcurrent` 在该对象上仍不可枚举；新字段不影响这一点。
