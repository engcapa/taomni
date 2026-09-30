# ED-PARITY-018 Git、Run/Debug 与底部工具窗口上下文对齐（P1 设计）

- 卡片：[backlog ED-PARITY-018](backlog.md)；依赖 010、011、013。
- IDEA 参照：[控件级复核 §8](references/idea-control-audit-20260929.md#git-run)——Commit `Alt+0`（左侧：变更复选树、Amend、多行消息、Commit / Commit and Push…）、Git `Alt+9`（底部 Log：分支树、过滤、提交列表、详情）、Terminal 头部会话 tab。
- 保留：repo identity 隔离、取消零写入、迟到响应不串 repo（ED-PARITY-008）、Run/Debug/Terminal 会话与输出、独立 Git 标签。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| Alt+9 打开独立 Git 标签（MainLayout 渲染 `WorkspaceGitManager`）；左 rail Commit 同样打开标签。 | `CodeWorkspaceTab.tsx` `workspace.openGit`、`leftToolRailItems` |
| `WorkspaceGitManager` 自包含（roots/activeRepoRoot/visible），含变更树、提交消息、Commit/Commit and Push、日志、diff。 | `src/components/git/WorkspaceGitManager.tsx` |
| 底部 dock 已有 Problems…Debug 等工具窗与 rail、Shift+Esc 隐藏（010）。 | `CodeWorkspaceTab.tsx` 底部 tab 列表 |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-018-01 | 新增 workspace 内 Git 工具窗（底部 dock `git`，`Alt+9`），承载同一 `WorkspaceGitManager`（本 workspace 的仓库集合）；首次打开挂载并保留（隐藏不丢提交消息/选择）；无仓库时显示 typed 空态。原 `workspace.openGit` 改名 “Open in Git Tab”，不再占 Alt+9。 |
| DEC-018-02 | 左 rail Commit 与 `Alt+0`（IDEA ActivateCommitToolWindow）指向同一 Git 工具窗，工具窗可见时 Commit 显示为激活。IDEA 的 Commit 位于左侧、Git Log 位于底部——Taomni 合并为底部一个工具窗，记 different。 |
| DEC-018-03 | Terminal 头部会话 tab/`+`/`˅`、VCS 变更条与运行 gutter（022）不在本卡；Run/Build/Debug 工具窗保持现状（已在 dock 内，返回编辑器由 010 的 Shift+Esc/Esc 覆盖）。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：Alt+9 / Commit rail 打开 workspace Git 工具窗，repo/branch/path 与 008 一致（TC-018-01 R1、TC-018-02 R1）；位置差异记 different。
- **A2**：Run/Build/Debug/Terminal 工具窗的打开/隐藏/返回编辑器由 010-01/03/04 保留证明；typed unavailable 由 015/020 覆盖。
- **A3**：隐藏/重开不丢变更与编辑器 dirty；真实仓库 index/refs/worktree 零写入（TC-018-02 R2）。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-018-01 Git 工具窗与 Alt+9/Alt+0 | `CodeWorkspaceTab.tsx`、`codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`__fixtures__/ideaXWinKeymap.ts` |
| TASK-018-02 用例与 evidence | `TC-IDE-PARITY-018-01/02-*`、`evidence/ed-parity-018-idea-comparison.md` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-018-01-git-tool-window-browser`（新） | browser | parity008 受控 provider：Alt+9、Commit rail、Shift+Esc 焦点、重开保留。 |
| `TC-IDE-PARITY-018-02-git-tool-window-native`（新） | native（Windows/Linux） | 真实双仓库：Alt+9 列出变更、隐藏后 dirty 保留、index/refs/worktree 字节不变。 |
| 保留 | browser/native | 008-01/02/03、010-01/03/04。 |

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + Windows/Linux native（macOS 与 008-03 同样不纳入 native git fixture）。
