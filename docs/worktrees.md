# Pi Web 中的 worktree

Pi Web 可以在侧边栏里显示同一个项目的所有 Git worktree。当你想为不同分支保留各自独立的检出目录，同时又希望该项目的会话归组在一起时，就用这个功能。

## worktree 控件何时出现

当所选目录是一个 Git 仓库的**根目录**时，worktree 切换器会出现在项目选择器下方。

以下情况会隐藏：

- 所选目录不是 Git 仓库。
- 所选目录在某个仓库内部，但不是仓库根目录。
- Git 无法读取该仓库的 worktree 列表。

如果你当前在仓库的子目录里，请从项目选择器打开仓库根目录来管理 worktree。

## 切换 worktree

用 worktree 切换器选择 Pi Web 在该项目中进行新工作时使用哪个检出目录。

切换会影响：

- 从侧边栏新建的会话。
- 文件资源管理器。
- 从资源管理器插入的文件引用。

已有会话仍然归组在同一个项目下。打开一个已有会话会把生效的工作目录切回该会话自己的检出目录。

## 创建 worktree

在 worktree 菜单里选择 `New worktree...` 并输入分支名。

Pi Web 会在下面位置创建检出目录：

```text
<仓库>-worktrees/<分支>
```

例如主检出目录为：

```text
/Users/alex/Documents/Workspace/pi-web
```

而你创建分支 `codex/worktree-help` 时，worktree 会创建在：

```text
/Users/alex/Documents/Workspace/pi-web-worktrees/codex-worktree-help
```

如果分支已存在，Pi Web 会为该分支添加一个 worktree；如果不存在，则从当前 `HEAD` 创建该分支。

## 删除 worktree

非主 worktree 旁边的删除按钮可以移除该检出目录。

删除 worktree **不会**删除：

- Git 分支。
- Pi Web 的会话历史。
- 主检出目录。

如果该 worktree 有未提交或未跟踪的文件，Git 会拒绝删除。此时 Pi Web 会提供强制删除。强制删除会丢弃该检出目录里的未提交文件，因此只在你确实不再需要这些改动时使用。

## 会话与 worktree

Pi Web 按项目根目录归组会话，因此主检出与关联 worktree 的会话会一起显示。

每个会话仍然记得它创建时的工作目录，也就是说：

- 在某个 worktree 里开始的会话继续使用该 worktree 路径。
- 在主检出里开始的会话继续使用主检出。
- 如果某个 worktree 已被删除，它过去的会话仍会显示在该项目下，方便你找回历史。

## 常见问题

**看不到 worktree 切换器。**
请选择 Git 仓库根目录。非 Git 目录与仓库子目录只会显示一条小提示，而不是切换器。

**某个分支无法添加为 worktree。**
Git 允许一个分支同时只在一个 worktree 中被检出。请切换到该分支已有的 worktree，或先删除它。

**已删除的 worktree 仍出现在 Git 里。**
检出目录消失后，Git 可能保留可清理的 worktree 记录；Pi Web 会在切换器中过滤掉它们。

**资源管理器显示的分支与当前聊天不一致。**
资源管理器跟随所选 worktree，而聊天跟随已打开的会话。再次点击该会话，即可让侧边栏回到该会话的检出目录。
