# ED-PARITY-010 壳层与工具窗口布局对齐（P1 设计）

- 卡片：[backlog ED-PARITY-010](backlog.md)；总体合同 [alignment-design.md#ed-parity-010](alignment-design.md#ed-parity-010)。
- 基线：`feat/ed-parity-013-keymap`（013 实现 `db9021b4`，其 F12/Shift+Esc/Ctrl+Shift+F12/Alt+2/7/9 绑定是本卡的键位基础）。
- IDEA 参照：[控件级复核 §1](references/idea-control-audit-20260929.md#shell)（`idea-01-shell`、`idea-33-commit`、`idea-34-git`、`idea-35-after-hide`）。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| 工具窗切换依赖 BottomDock 顶部 9 个文本 tab + `More` 溢出菜单（`code-workspace-bottom-tab-<id>`、`…-overflow`、`…-overflow-menu`、`…-overflow-<id>`，13 个用例引用）；Project 是固定左栏，折叠后只剩 `code-workspace-project-collapsed-rail`；右侧 Outline/Documentation 由头部按钮切换。无 IDEA 式左右 tool rail。 | `panels/BottomDock.tsx`、`CodeWorkspaceTab.tsx:~21000-21160` |
| Project + 底部工具窗已可同时打开、各自持久化尺寸（`restoreDefaultToolWindowLayout` / `bottomDockHeight`）。 | `codeWorkspaceStore`、`BottomDock` |
| workspace 头部 30px 约 20 个图标：名称/根数、SDK 状态、Facts 徽标、前进/后退、缩放三件、换行、列选择、保存、重载、Build、Run、配置下拉、Debug、刷新树、Git、分屏×2（及分屏子操作）、Outline、Blame/Inlay、Tab policy。约 30 处用例直接点击其中按钮。 | `CodeWorkspaceTab.tsx:~20730-21010` |
| 空编辑器居中 “No file open”。 | EditorGroup 空态 |
| 状态栏在 workspace 激活时仍显示 sessions/network/X11/auth/ASR/LLM/主题/版本，并追加 `Ln x, Col y`、`Spaces: 2`、编码、EOL、语言、LSP、Git、字号；无导航栏、无选区字符数、无只读锁。`Ln x, Col y` 被 15 个用例共 29 处断言。 | `statusbar/StatusBar.tsx`、`codeWorkspaceStatusStore` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-010-01 | 新增 `ToolWindowRail`（左、右两条，32px 宽，图标 + 截断标签，选中=该工具窗可见，蓝底）。左 rail 上组：Project（Alt+1）、Commit（Alt+0 → 暂开 Git 管理器，018 换成 Commit 工具窗）；左 rail 下组：全部底部工具窗（Problems/Terminal/Run/Debug/Build/Tests/Search/…，按现有 dock 顺序）；右 rail：Structure（Alt+7）、TODO/Bookmarks（Alt+2）。rail 按钮沿用 `code-workspace-bottom-tab-<id>`，溢出按钮与菜单沿用 `code-workspace-bottom-tab-overflow*`，因此旧用例不需改选择器；新 testid `code-workspace-tool-rail-left/right`、`code-workspace-tool-rail-<id>`。点击语义与 IDEA 一致：未显示则打开并激活，已显示且为当前则隐藏。 |
| DEC-010-02 | BottomDock 不再渲染横向 tab 条；头部改为 IDEA 工具窗头：标题（当前工具名）+ 工具自身内容 + `⋮`（Restore Default Layout / Hide）+ `—` 隐藏（`code-workspace-tool-window-hide`）。Project 面板头部追加同一 `—` 隐藏按钮。 |
| DEC-010-03 | 空编辑器显示 IDEA 快捷提示列表：Search Everywhere（Double Shift）、Go to File、Recent Files、Navigation Bar、Drop files here to open them；快捷键取当前 keymap 的有效绑定（013 格式化），无绑定时省略键帽。 |
| DEC-010-04 | 头部工具栏收敛到 IDEA 主工具栏分组：项目 widget（名称 + 根数）、VCS widget（当前分支，点击打开 Git）、运行配置下拉 + Build/Run/Debug、Search Everywhere 放大镜、Settings 齿轮、`⋮` 更多（`code-workspace-toolbar-more` → 菜单 `code-workspace-toolbar-more-menu`）。前进/后退、缩放、换行、列选择、保存、重载、刷新树、分屏组、Outline、Blame/Inlay、Tab policy 移入 `⋮` 菜单并保留原 testid；受影响用例在点击前先打开 `⋮`。 |
| DEC-010-05 | SDK 状态与 Facts 徽标通过 portal 渲染进状态栏 widget 区（`status-bar-workspace-widgets`），保持组件状态与原 testid。 |
| DEC-010-06 | workspace 激活时状态栏为 IDEA 布局：左侧导航栏（`status-bar-workspace-navbar`：根 › 目录… › 文件 › 类 › 方法，符号来自面包屑同源 `documentSymbol`；无 provider 时止于文件）；右侧 `行:列` 或 `行:列 (N chars)`、EOL、编码、缩进（`2 spaces` / `4 spaces` / `Tab`）、只读锁（只读时 `status-bar-workspace-readonly`）、LSP、Git、大文件、字号；所有段 `shrink-0` 不截断。应用级 sessions/network/X11/auth/AI/主题/版本段在 workspace 激活时隐藏。`Ln x, Col y` 断言按 `x:y` 迁移。 |
| DEC-010-07 | 本卡不重做 Project 头部按钮与树（014）、编辑器顶部条/面包屑（011）、Commit/Git 工具窗（018）。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：rail/工具窗头/工具栏/状态栏的层级与 IDEA 实测逐项对照（§1 表）；选中/非选中/禁用态有 DOM 可观察属性（`aria-pressed`、`data-active`、`disabled`）；未接受差异写入 comparison。
- **A2**：通过 rail、Alt+数字、F12、Shift+Esc、`—` 打开/隐藏 Problems、Terminal、Search、Run；resize 后隐藏再打开恢复高度；隐藏后焦点回编辑器。
- **A3**：切换工具窗、隐藏全部、恢复默认布局与重载不卸载 editor view（`.cm-content` 仍为同一节点 / dirty 标记与文本保留），工具输出（Search 结果、Problems 列表）在切换后仍在。
- **A4**：左/右 rail 存在且承载 §DEC-010-01 列表；Project 与底部工具窗可同时打开；空编辑器快捷提示含真实绑定；状态栏导航栏与 `行:列 (N chars)` 可见且不截断。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-010-01 `ToolWindowRail` 组件（上下分组、溢出、选中态、键盘可达） | 新 `workspace/panels/ToolWindowRail.tsx` |
| TASK-010-02 BottomDock 去 tab 条、IDEA 头、`—`/`⋮` | `workspace/panels/BottomDock.tsx` |
| TASK-010-03 工具栏收敛 + `⋮` 菜单、Settings/Search 入口 | `CodeWorkspaceTab.tsx`、新 `workspace/WorkspaceToolbarMore.tsx` |
| TASK-010-04 空编辑器提示 | `EditorGroup.tsx`（空态）、新 `workspace/EmptyEditorHints.tsx` |
| TASK-010-05 状态栏 IDEA 布局、导航栏、选区字符数、只读锁、widget portal | `statusbar/StatusBar.tsx`、`stores/codeWorkspaceStatusStore.ts`、`CodeWorkspaceTab.tsx` |
| TASK-010-06 用例迁移（工具栏 `⋮`、`x:y`）与新用例 | `qa-ui-auto-tests/cases/…`、policy、feature-list |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-010-01-tool-rails-browser`（新） | browser | A1/A2/A4：两条 rail 与按钮集合；点 Problems rail → dock 打开、按钮 `aria-pressed=true`；再点 → 隐藏；Project 与 Terminal 同时可见；`—` 隐藏后焦点回编辑器；Alt+4 打开 Run 并高亮；resize 后隐藏/再开高度保持。 |
| `TC-IDE-PARITY-010-02-shell-toolbar-statusbar-browser`（新） | browser | A1/A4：工具栏只剩 IDEA 分组 + `⋮`，`⋮` 菜单含分屏/缩放/换行等；Settings 齿轮打开设置；空编辑器提示含 `Double Shift` 与 Go to File 真实键；状态栏导航栏含文件名；选区 5 字符时 `x:y (5 chars)`；应用级段隐藏；只读文件显示锁。 |
| `TC-IDE-PARITY-010-03-layout-keeps-editor-browser`（新） | browser | A3：编辑未保存内容后切 Problems/Search/Terminal、隐藏全部、恢复默认布局，`.cm-content` 文本与 dirty 标记保留，Search 结果仍在。 |
| `TC-IDE-PARITY-010-04-tool-windows-native`（新） | native | A2/A3：打包应用中 rail 打开 Terminal（真实 PTY 就绪）、隐藏再打开不丢输出；Alt+1/Alt+6 真实按键。 |
| 保留：点击被移入 `⋮` 的工具栏按钮的用例、`Ln x, Col y` 断言用例 | browser/native | 机械迁移后在 CI 重跑。 |

单测：`ToolWindowRail.test.tsx`（分组、溢出、切换语义）、`BottomDock` 现有测试更新、`StatusBar.test.tsx`（workspace 布局、`x:y (N chars)`、锁）、`EmptyEditorHints` 渲染真实绑定。

<a id="verification"></a>
## 6. 验证与边界

本地 Linux：单测 + 新旧 browser 用例；GitHub `qa-ui-auto-platforms` 三端 browser/native 运行新用例与迁移用例。IDEA 对照为复核 §1 的文字化实测；像素/字体按 DEC-ALIGN-06 profile 仍记为 unverified，交 019。Commit 工具窗、Git Log 工具窗、Project 头部重排不在本卡。
