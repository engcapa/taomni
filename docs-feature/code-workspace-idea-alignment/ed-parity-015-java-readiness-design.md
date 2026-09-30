# ED-PARITY-015 Java 工程就绪、补全与诊断反馈对齐（P1 设计）

- 卡片：[backlog ED-PARITY-015](backlog.md)；依赖 010、011、013。
- IDEA 参照：[控件级复核 §5/§8](references/idea-control-audit-20260929.md#git-run)（`idea-3x` Problems：File `3` / Project Errors，按文件分组，`❗ Incompatible types…:9`、`⚠ Variable 'broken' is never used :8`）。
- 保留：provider 原始 snippet、一次接受/undo（C2-01、PARITY-005-*）、Smart completion typed unavailable（`editor.smartCompletion`）。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| Problems 在零诊断时只看计数：语言服务不可用/启动中/失败也显示 “No problems in open files”。 | `panels/ProblemsPanel.tsx:176` |
| 语言服务状态已在 `LspFileState.status`（active/available/semanticReady/error/installHint）和 `state.syncing/error`，状态胶囊 `LspStatusPill` 据此出文案与 Settings 链接。 | `workspaceChrome.tsx:22-90` |
| 重启入口 `restartWorkspaceServers` 仅供设置/SDK 变更内部调用，未暴露给 UI。 | `useWorkspaceLspSession.ts:299` |
| Problems 行尾为 `行:列`，文件组头带计数。 | `ProblemsPanel.tsx:268` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-015-01 | 新增纯函数 `languageServiceReadiness(state)` → `{ kind, message, action }`，`kind ∈ ready / indexing / starting / not-installed / failed / inactive / idle`，`action ∈ configure / retry / null`。LspStatusPill 与 Problems 共用它，文案同源（A1）。 |
| DEC-015-02 | Problems（Open files 作用域）零诊断时：`ready` 才显示 “No problems in open files”；其他状态显示 `code-workspace-problems-provider-state`（`data-state=<kind>`）：原因文案 + `Configure…`（not-installed/failed → 打开 Language Servers 设置）或 `Retry`（failed/inactive → 重启本工作区语言服务）。`indexing/starting` 显示 “Analyzing… results will appear when <name> is ready” 且无按钮（A3/A4）。 |
| DEC-015-03 | 有诊断但服务非 ready（重启中、降级）时，列表照常显示，顶部加一行 `code-workspace-problems-stale`：“Results may be outdated: <reason>”。不清空真实结果（A3）。 |
| DEC-015-04 | 行尾位置改为 IDEA 的 `:行号`（`title` 保留 `行:列`）；文件组头保留计数。File/Project Errors 标签重命名不在本卡（保留 Open files/Whole project 与 testid，记 different）。 |
| DEC-015-05 | `useWorkspaceLspSession` 返回 `restartServers`，Problems Retry 调用它；重启后沿用现有重新同步路径。 |
| DEC-015-06 | 补全（A2）本卡不改外观（交 020），以现有真实 provider 用例 C2-01/PARITY-005-05 作为三端证据，与 IDEA 的比较写入 evidence。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：pill 与 Problems 对同一状态给出同一原因；not-installed/failed 有 Configure，failed/inactive 有 Retry，indexing/starting 无按钮。
- **A2**：Basic Completion 由 C2-01/005-05 在三端真实 JDT LS 下通过；Smart 为 typed unavailable（既有 C3-x 用例）。
- **A3**：服务不可用时 Problems 不显示 “No problems”；有旧诊断时显示且标注 stale。
- **A4**：native：打开含 1 个类型错误 + 1 个未用变量的 `App.java`，服务就绪后 Problems 按文件分组显示 1 error / 1 warning，行尾 `:行号`，pill 显示 `1E 1W`；browser：无 JDT LS 时 Problems 显示 provider state 与 Configure。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-015-01 `languageServiceReadiness` + 单测；pill 改用 | `workspace/languageServiceReadiness.ts`、`workspaceChrome.tsx` |
| TASK-015-02 Problems provider state / stale / `:行号` | `panels/ProblemsPanel.tsx`（+ test） |
| TASK-015-03 Retry/Configure 接线 | `useWorkspaceLspSession.ts`、`CodeWorkspaceTab.tsx` |
| TASK-015-04 用例与 evidence | `qa-ui-auto-tests/cases/TC-IDE-PARITY-015-*`、`evidence/ed-parity-015-idea-comparison.md` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-015-01-problems-provider-state-browser`（新） | browser | A1/A3/A4 browser：打开 `.java`（browser 无 JDT LS），Alt+6 打开 Problems，断言 `data-state` 非 ready、文案不含 “No problems”、存在 Configure 且点击打开 Language Servers 设置。 |
| `TC-IDE-PARITY-015-02-problems-java-native`（新） | native | A4：maven-single 写入含类型错误与未用变量的 `App.java`，等待 semantic ready，Problems 显示 2 行（error/warning）、组头 `App.java`、行尾 `:行号`，pill 含 `1E 1W`。 |
| 保留 | native | C2-01、PARITY-005-05、CW-ANALYSIS-01/02/03（ready 后隐藏诊断仍显示 “No problems in open files”）。 |

单测：`languageServiceReadiness.test.ts`、`ProblemsPanel.test.tsx`（provider state、stale、`:行号`）。

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + native。Problems 标签改名、快速修复按钮列、预览交 018/019；补全外观交 020。
