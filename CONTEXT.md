# Pi Web

Pi Web 为用户选定的项目承载编码智能体会话，同时把 Web 服务器自身的运行时关切与项目工作分开。

## 术语

**Host Runtime Environment（宿主运行时环境）**：
Pi Web 服务器及其框架运行时自己拥有的环境。
_避免使用_：项目环境、shell 环境

**Project Command Environment（项目命令环境）**：
Pi Web 代表用户选定项目执行命令时所呈现的环境。
_避免使用_：宿主环境、继承的环境

**Built-in Project Shell（内置项目 Shell）**：
由 Pi Web 自己拥有并操作的 shell 入口，用于执行与项目关联的命令。
_避免使用_：扩展 shell、任意子进程

## 目录与失败说法

**Session cwd（会话工作目录）**：
会话文件头里记录的**绝对**目录，会话就绑定在它上面；容器必须按同一路径挂载它才存在。
_避免使用_：工作区、workspace（`/workspace` 容易被读成挂载目标，而挂载目标恰恰必须是原路径）

**Project root（项目根）**：
主仓库的顶层目录；worktree 全部归到它下面显示。
_避免使用_：仓库路径、项目 cwd

**Managed theme directory（托管主题目录）**：
`~/.pi/agent/themes/`，第三方主题「导入」的落地位置，随数据目录一起持久化。
_避免使用_：主题目录（那通常指项目里的 `themes/`）

**cwdNotice / `cwd_missing`**：
服务器说明「你请求的目录用不了」的结构化字段与错误码（`missing` / `not_a_directory` / `not_allowed`）。可降级时带着它继续返回结果（模型列表、技能、插件、worktree），不可降级时以 `cwd_missing` 拒绝（启动 Agent、项目范围的安装）。
_避免使用_：报错、Access denied（那会把「没挂载」误读成「没权限」）

**Provider error（提供方报错）**：
模型提供方返回的失败（余额不足、限流、密钥无效…），pi 以 `Error: <状态码> {json}` 存进转录；界面按类别解释并保留原始响应与 `request_id`。
_避免使用_：模型错误（那是 Pi Web 自己的模型加载失败，对应 `chat.modelError`）
