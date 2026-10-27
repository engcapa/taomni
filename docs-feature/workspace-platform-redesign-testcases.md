> 2026-10-27 崩溃专项：新增 TC-WS-052/053/054/055/056，与 TC-WS-038/039/045/051 共同标记 `crash-regression`，每次新功能、重构、组件升级必跑整组 browser/native。四文件直接 Grid 和 Split→Grid、0/1/2/3 文件边界、关闭面板、内外分屏交替、Sessions 从四会话关闭至空再重开、混合终端及跨视图返回、QA release 冷启动与实际磁盘保存均有独立结果断言；全程检查运行时错误。具体断言、复盘、自动执行与证据要求见 [崩溃专项](../qa-ui-auto-tests/ci/crash-regressions.md)。已有少文件 happy path 的通过不能代替这些状态转换。

> 2026-10-27 工具栏验收更新：Sessions 的 `tab-more` 为漏斗过滤入口，保留分类、目录与搜索；Workspaces 新增 `workspace-tabs-filter-trigger`，支持分类与搜索组合。广播、布局、底栏和会话上下文操作集中在最右侧 `titlebar-actions-more`，Home/Tools 不显示空操作菜单。全部主视图移除标题栏语音，Chat 听写及 Settings 语音配置保留。新 browser `TC-WS-050` 验证过滤、草稿、工作区隔离、键盘/窄窗口和菜单入口；native `TC-WS-051` 以真实 PTY 输出、未保存缓冲区和磁盘 SHA-256 验证运行实例及文件保存。既有 SFTP、RDP、VNC、广播、语音等用例迁移导航后保留其业务断言。以下早期表格的 `⋯` 过滤图标以此更新为准。

> 2026-10-25 补充验收：全局/Sessions 实时大预览（Ctrl/Cmd+Shift+E）、移除 Sessions Welcome 与右上角小预览、移除 Tao 贴边悬浮条、按模式对齐右上角工具栏。TC-WS-018 覆盖文件缓冲区预览与工作区分屏，TC-WS-019 通过原生 PTY 输出验证 Sessions 大预览；TC-NOTES-005 改验主导航入口和无悬浮条，原 Chat/Notes/通知用例保留。旧会话用例显式进入 Sessions，历史启动/恢复用例回到 Home；不由 runner 隐式更改模式。本机测试 worker 总数不超过 2。

# Taomni Workspace-First & One-System 平台级 UI/交互重构全量测试规范（Unit / Browser / Native & 既有回归适配专册）

> **关联详细设计文档**：[`docs-feature/workspace-platform-redesign-design.md`](./workspace-platform-redesign-design.md)
> **关联交互原型**：[`docs-feature/workspace-platform-redesign-prototype.html`](./workspace-platform-redesign-prototype.html)
> **新增 YAML 用例路径**：`qa-ui-auto-tests/cases/TC-WS-001*.testcase.yaml` ~ `TC-WS-012*.testcase.yaml`

---

## 本轮执行范围补充（2026-10-25）

- 按用户确认，Agents / Crew 仅保留按钮及“开发中”反馈。`TC-WS-011` 验证主导航、Home、命令面板入口均提示且保留当前画布；下文历史 TASK-09 编排与授权场景属于后续设计。
- `TC-WS-016`（browser）验证 Home 默认全宽、独立圆角框架、紧凑卡片、导入菜单、原有启动/工具入口、右栏调宽与持久化和窄窗口布局；视觉复核包含主操作蓝色填充、次操作中性色、深浅主题及真实编辑器语法高亮。
- `TC-WS-017`（browser/native）验证跨工作区和 Home/Sessions 模式切换后，未保存文档、撤销/重做与保存重载均保持；native 使用真实临时目录读写。
- `TC-WS-012/015` 验证 PTY 在模式切换后保留输出并继续工作；Linux `TC-WS-014` 验证系统剪贴板；`TC-MAIN-RAIL-03` 验证真实原生窗口拖动。浏览器 stub 不替代这些系统边界证据。
- `WorkspaceEditorLifecycle.test.tsx` 保护未访问工作区不启动会话、StrictMode 异步加载/撤销保持及保存期间继续编辑的 dirty 状态。`TC-IDE-PARITY-024-01/027-03` 同步图标默认值，并保留双向名称切换、调宽、Move、Remove 与恢复行为。
- 本机自动化 worker 总数不超过 2，native 顺序执行；GitHub 使用 `qa-ui-auto-platforms` 先跑相关选定矩阵，再跑完整目录，核对逐例统计及原始 receipts。准确结果和执行边界见实现报告第 0 节。

## ⚠️ 测试与验收核心原则（多 Coding Agent 必读）

1. **铁律验证：严禁随意删除 `main` 分支已有功能**
   - 本次重构是**纯粹的 UI 布局与交互重构**。任何 Coding Agent 提交代码时，除了要通过本专册第一部分（Unit Tests）与第二部分（新增 `TC-WS-001` ~ `TC-WS-012`）外，**必须确保第三部分列出的全部既有 `main` 测试用例 100% 通过**。
   - 严禁通过删除断言、弱化测试条件或跳过右键菜单检查来“凑通过率”。
2. **三层验证闭环**：
   - **Layer 1 — Unit / Component Tests (`Vitest` & `cargo test`)**：验证 Store 状态隔离、默认工作区兜底、组件渲染属性、快捷键回调与边界条件（毫秒级反馈）。
   - **Layer 2 — Browser E2E Tests (`qa_ui_auto run --mode browser`)**：在真实 Chromium 渲染管线中验证 DOM 布局、尺寸几何、右键菜单、拖拽与 LocalStorage 持久化。
   - **Layer 3 — Native Desktop E2E Tests (`qa_ui_auto run --mode native --isolated`)**：在 Linux (`WebKitGTK`)、Windows (`WebView2`)、macOS (`WKWebView`) 真实桌面窗口中验证无边框窗口拖拽、系统剪贴板、本地 PTY、Vault 门禁与原生文件树交互。

---

## 第一部分：单元测试与组件测试规范（Unit & Component Tests, `TASK-01` ~ `TASK-09`）

### 1.1 `TASK-01` 单测：`src/stores/__tests__/workspacePlatformStore.test.ts`

- **执行命令**：`pnpm exec vitest run src/stores/__tests__/workspacePlatformStore.test.ts`
- **必测用例清单（8 项）**：
  1. **`UT-WS-01-01`（空存储自动初始化默认工作区）**：清空 `localStorage.getItem("taomni.platformWorkspaces.v1")` 后初始化 store，断言 `workspaces` 长度 `>= 1`，第 1 项为 `id === "default-workspace"`、`isDefault === true`、`name` 包含 `"Default Workspace"`。
  2. **`UT-WS-01-02`（默认工作区禁止删除保底）**：调用 `deleteWorkspace("default-workspace")`，断言返回 `false` 且 `"default-workspace"` 仍在列表中；创建自定义工作区 `ws-custom` 后调用 `deleteWorkspace("ws-custom")`，断言删除成功且 `activeWorkspaceId` 自动回退到 `"default-workspace"`。
  3. **`UT-WS-01-03`（多根目录 Multi-Root 增删与去重）**：对工作区调用 `addRootFolder(wsId, { path: "/repo/a", name: "a" })` 与 `addRootFolder(wsId, { path: "/repo/b", name: "b" })`，断言 `rootFolders` 包含两个目录；重复添加相同 `path` 时自动去重不产生重复节点；调用 `removeRootFolder` 仅从工作区配置移除引用而不删除磁盘文件。
  4. **`UT-WS-01-04`（新建文件与新建目录状态同步）**：调用 `createFileInWorkspace(wsId, rootId, "src/index.ts")` 与 `createFolderInWorkspace(wsId, rootId, "src/utils")`，断言文件树节点同步插入并自动在工作区 `openTabs` 中打开新建的文件。
  5. **`UT-WS-01-05`（打开全局任意会话——不限于已关联会话）**：传入一个不在 `pinnedSessionIds` 中的全局 `SessionConfig`（如 `id: "global-mysql-01"`），调用 `openSessionInWorkspace(wsId, session, { pinToWorkspace: false })`，断言成功在 `ws.openTabs` 中生成独立会话 Tab，且 `pinnedSessionIds` 未被污染。
  6. **`UT-WS-01-06`（打开全局会话并勾选“同时关联到本工作区常用”）**：调用 `openSessionInWorkspace(wsId, session, { pinToWorkspace: true })`，断言 `ws.openTabs` 新增该会话 Tab 且 `ws.pinnedSessionIds` 包含 `session.id`。
  7. **`UT-WS-01-07`（工作区会话实例与 `Sessions` 全局模式 100% 隔离）**：
     - 在 `appStore`（`Sessions` 模式）打开会话 `ssh-prod-01`（得到 `globalTabId`）；
     - 在 `workspacePlatformStore`（`Workspaces` 模式）打开同一个 `ssh-prod-01`（得到 `wsTabId`）；
     - 断言 `wsTabId !== globalTabId`；
     - 关闭工作区内的 `wsTabId`，断言 `appStore.getState().tabs` 中的 `globalTabId` 依然存在且处于激活/连接态；反之关闭 `globalTabId`，工作区内的 `wsTabId` 依然存在。
  8. **`UT-WS-01-08`（左下角 MFA 悬浮窗状态管理）**：验证 `appStore` 中 `floatingMfa` 初始坐标为 `{ left: 50, bottom: 30 }`，`toggleFloatingMfa()`、`setFloatingMfaPosition(x, y)`（含视口边界 Clamp）与 `setFloatingMfaPinned(true)` 正确更新。

---

### 1.2 `TASK-02` 单测：`src/components/sidebar/__tests__/PrimaryNavigationRail.test.tsx`

- **执行命令**：`pnpm exec vitest run src/components/sidebar/__tests__/PrimaryNavigationRail.test.tsx`
- **必测用例清单（7 项）**：
  1. **`UT-WS-02-01`（顶部 5 大一级模式顺序契约）**：渲染 `PrimaryNavigationRail`，查询顶部模式按钮列表，断言 DOM 顺序严格为：`[data-testid="nav-mode-home"]`（第 1 位） -> `[data-testid="nav-mode-workspaces"]`（第 2 位） -> `[data-testid="side-tab-sessions"]`（第 3 位） -> `[data-testid="nav-mode-agents"]`（第 4 位） -> `[data-testid="side-tab-tools"]`（第 5 位）。
  2. **`UT-WS-02-02`（Workspaces 模式下融合 IDEA 工具窗口按钮展示）**：当 `activeSideTab === "workspaces"` 时，断言 `[data-testid="code-workspace-tool-rail-left"]` 存在于主左侧导航条内，且依次渲染 `code-workspace-tool-rail-project`、`code-workspace-tool-rail-sessions`、`code-workspace-tool-rail-git`、`code-workspace-tool-rail-structure`、`code-workspace-bottom-tab-overflow`。
  3. **`UT-WS-02-03`（非 Workspaces 模式下隐藏工作区专属工具按钮）**：切换到 `home`、`sessions`、`agents` 或 `tools` 时，断言 `code-workspace-tool-rail-project` 等工作区上下文按钮不在 DOM 中渲染。
  4. **`UT-WS-02-04`（保留 `⋯` 溢出菜单全部 IDEA 工具窗口项）**：在 `Workspaces` 模式下点击 `[data-testid="code-workspace-bottom-tab-overflow"]`，断言弹出菜单包含 `Terminal`、`Problems`、`Run`、`Find`、`Bookmarks`、`TODO`、`Services`、`Database`、`Show Tool Window Names`、`Move to`。
  5. **`UT-WS-02-05`（底部 6 工具严格顺序契约）**：查询主左侧导航条底部区域按钮，断言自上而下顺序严格为：
     - 第 1：`[data-testid="rail-mfa-button"]`（MFA，在截图上方）
     - 第 2：`[data-testid="system-screenshot"]`（截图，在聊天上方）
     - 第 3：`[data-testid="rail-chat-button"]`（聊天 Tao）
     - 第 4：`[data-testid="theme-cycle"]`（主题切换）
     - 第 5：`[data-testid="language-switcher"]`（语言切换，在主题切换下方）
     - 第 6：`[data-testid="ribbon-settings"]`（设置）
  6. **`UT-WS-02-06`（右键 `Show Tool Window Names` 保留验证）**：右键点击左侧主导航条任意按钮，断言弹出 `[data-testid="sidebar-rail-menu-show-names"]`，点击后双向切换按钮文字显示/隐藏并写入 `taomni.codeWorkspace.toolWindowStripes.v1`。
  7. **`UT-WS-02-07`（语言切换与主题切换在左栏底部的完整行为）**：点击 `[data-testid="language-switcher"]` 弹出 `language-option-en` 与 `language-option-zh-CN`；点击 `[data-testid="theme-cycle"]` 循环切换 `light -> dark -> system`。

---

### 1.3 `TASK-03` 单测：`src/components/tabbar/__tests__/ControlBarSharedToolbar.test.tsx`

- **执行命令**：`pnpm exec vitest run src/components/tabbar/__tests__/ControlBarSharedToolbar.test.tsx`
- **必测用例清单（6 项）**：
  1. **`UT-WS-03-01`（单行 33px 共享工具栏与零额外顶栏）**：渲染主窗口壳层，断言仅存在一个 `[data-testid="control-bar"]`，不存在第二个顶栏或 3 色装饰圆点。
  2. **`UT-WS-03-02`（左右栏收缩按钮与 `Ctrl+B` 联动）**：点击 `[data-testid="toggle-left-sidebar"]`（`◧`）切换左栏折叠状态；点击 `[data-testid="toggle-right-sidebar"]`（`◨`）切换右栏折叠状态。
  3. **`UT-WS-03-03`（按模式切换共享工具栏中间的 Tab 条）**：在 `Workspaces` 模式下展示当前工作区的 `openTabs`；在 `Sessions` 模式下展示全局会话 `TabBar`。
  4. **`UT-WS-03-04`（100% 保留 `app-main-menu` 所有主菜单项）**：点击 `[data-testid="app-main-menu"]`，断言 `New local terminal`、`New remote session`、`New SFTP`、`Sessions`（含导入导出子菜单）、`View`、`Tools`、`Settings`、`Help`、`Exit` 全部存在。
  5. **`UT-WS-03-05`（大预览与统一过滤）**：断言原小预览 `tab-details-hover` 已移除，`tab-overview-trigger` 打开大预览；`tab-more`（漏斗）打开 `open-tabs-menu`，保留分类、目录分组与搜索过滤已打开标签。
  6. **`UT-WS-03-06`（保留左栏拖拽分隔条 `main-sidebar-resize-handle`）**：断言左栏展开时 `[data-testid="main-sidebar-resize-handle"]` 可见且拖拽更新左栏宽度。

---

### 1.4 `TASK-04` 单测：`src/components/mfa/__tests__/MfaFloatingWindow.test.tsx`

- **执行命令**：`pnpm exec vitest run src/components/mfa/__tests__/MfaFloatingWindow.test.tsx`
- **必测用例清单（5 项）**：
  1. **`UT-WS-04-01`（左下角默认位置契约）**：点击 `[data-testid="rail-mfa-button"]`，断言 `[data-testid="mfa-floating-window"]` 挂载，且初始内联位置为 `left: 50px; bottom: 30px;`。
  2. **`UT-WS-04-02`（Vault 未初始化/未解锁门禁保护）**：当 Vault 未解锁时，悬浮窗内渲染解锁入口，不泄露任何 TOTP 条目；解锁后立即渲染令牌列表。
  3. **`UT-WS-04-03`（搜索过滤与单击复制验证码）**：在 `[data-testid="mfa-floating-search"]` 输入关键字过滤条目；点击某一条目卡片，断言调用剪贴板写入 6 位数字验证码并显示已复制提示。
  4. **`UT-WS-04-04`（悬浮窗拖拽与视口边界夹紧）**：模拟在 `[data-testid="mfa-floating-drag-handle"]` 上执行 `mousedown -> mousemove -> mouseup`，断言窗口位置更新且不会超出视口边界。
  5. **`UT-WS-04-05`（展开为全屏 MFA Tab 兼容既有流程）**：点击 `[data-testid="mfa-floating-expand-tab"]`，断言打开 `[data-testid="mfa-tab"]` 全屏标签页并关闭悬浮窗。

---

### 1.5 `TASK-05` & `TASK-06` & `TASK-07` & `TASK-08` & `TASK-09` 单测汇总

| 单测文件 | 执行命令 | 核心必测断言 |
| :--- | :--- | :--- |
| `src/components/workspace/__tests__/WorkspaceSidebar.test.tsx` | `pnpm exec vitest run src/components/workspace/__tests__/WorkspaceSidebar.test.tsx` | ① 工作区切换器 `[data-testid="workspace-switcher"]` 在左栏顶部；② 左栏无冗余 `[文件管理\|Git]` 按钮行；③ 工具栏与目录右键菜单支持 `workspace-new-file`、`workspace-new-folder`、`workspace-add-folder`（Multi-Root）；④ 底部常驻 `workspace-sidebar-git-bar`。 |
| `src/components/workspace/__tests__/WorkspaceGitIntegration.test.tsx` | `pnpm exec vitest run src/components/workspace/__tests__/WorkspaceGitIntegration.test.tsx` | ① 顶栏右上角无冗余 `Git` 按钮；② 主左侧栏 `🌿 Git`、左栏底部 Git 状态条、编辑器工具栏 `editor-open-git-diff`、工作区 `GIT` Tab 共 4 条路径均可跳转内置 Git Panel；③ 内置 Git Panel 完整渲染 `Changes / Log / Branches / Tags / Stash / Settings` 6 大标签页、`RepoSelector`、`BranchBadge`、`Tree/Flat`、`Amend`、`Side-by-Side / Unified Diff`。 |
| `src/components/workspace/__tests__/WorkspaceIsolatedSessions.test.tsx` | `pnpm exec vitest run src/components/workspace/__tests__/WorkspaceIsolatedSessions.test.tsx` | ① 通过工作区 `+` 菜单、`Ctrl+Alt+O` 会话选择器弹窗、主左侧栏 `Sessions` 工具窗口均可打开未关联的全局任意会话；② 工作区内打开的会话实例与 `Sessions` 模式的运行实例完全隔离。 |
| `src/components/welcome/__tests__/HomeModeWelcomePanel.test.tsx` | `pnpm exec vitest run src/components/welcome/__tests__/HomeModeWelcomePanel.test.tsx` | ① `Home` 模式下完整渲染 `welcome-panel`、`welcome-open-local-terminal`、OpenSSH 导入、最近会话与工作区卡片；② `Sessions` 模式左栏 100% 保留 `SessionTree` 7 按钮、过滤芯片与右键菜单。 |
| `src/components/agents/__tests__/AgentsPlatformView.test.tsx` | `pnpm exec vitest run src/components/agents/__tests__/AgentsPlatformView.test.tsx` | ① `Agents` 模式渲染独立 Git Worktree 任务卡片与权限边界；② 点击“在 Git 面板审阅 Diff”跳转工作区内置 Git Panel；③ `Ctrl+K` 全局搜索面板正常检索。 |

---

## 第二部分：新增 Browser / Native 端到端自动化测试用例集（`TC-WS-001` ~ `TC-WS-012`）

所有新增用例均已生成至 `qa-ui-auto-tests/cases/` 目录，严格遵循 `qa_ui_auto` 契约：

| 用例 ID | 用例文件 | 模式 (`modes`) | 覆盖特性 (`covers`) | 测试目标与核心步骤 |
| :--- | :--- | :--- | :--- | :--- |
| **`TC-WS-001`** | `TC-WS-001-single-shared-toolbar-and-sidebar-collapse.testcase.yaml` | `browser`, `native` | `F1.2`, `F1.3`, `F-WS-1` | **单行 33px 共享主工具栏与左右栏收缩**：验证顶栏高度 `<= 33px`、无多余顶栏行、无右上角 3 色圆点；验证左侧 `◧`（`toggle-left-sidebar` / `Ctrl+B`）与右侧 `◨`（`toggle-right-sidebar`）折叠/展开侧栏。 |
| **`TC-WS-002`** | `TC-WS-002-primary-rail-modes-home-first.testcase.yaml` | `browser`, `native` | `F1.2`, `F1.6`, `F-WS-1` | **左侧主导航条顶部 5 大模式（Home 并列第 1）**：验证顶部模式按钮顺序为 `Home -> Workspaces -> Sessions -> Agents -> Tools`；点击 `Home` 渲染 `welcome-panel` 全部功能。 |
| **`TC-WS-003`** | `TC-WS-003-workspace-merged-idea-rail-and-overflow-menu.testcase.yaml` | `browser`, `native` | `F25.5`, `F-WS-2` | **Workspaces 模式下 IDEA 工具窗口条单轨融合与 `⋯` 菜单**：验证切换到 `Workspaces` 时，`Project / Sessions / Git / Structure / ⋯` 直接融合在窗口主左侧栏中，工作区内绝无第二条竖向工具条；验证 `⋯` 菜单包含全部 IDEA 工具窗口与 `Show Tool Window Names`。 |
| **`TC-WS-004`** | `TC-WS-004-rail-bottom-tools-and-bottom-left-floating-mfa.testcase.yaml` | `browser`, `native` | `F5.5`, `F27.1`, `F-MFA-1`, `F-I18n-1`, `F-WS-3` | **主左侧栏底部 6 工具顺序与左下角 MFA 悬浮窗口**：验证底部依次为 `MFA -> 截图 -> 聊天 -> 主题 -> 语言 -> 设置`；点击 `MFA` 在左下角（`left: 50px, bottom: 30px`）弹出可拖拽悬浮验证器，验证搜索、复制 6 位 TOTP 验证码及展开全屏 MFA 页。 |
| **`TC-WS-005`** | `TC-WS-005-left-sidebar-resize-workspace-switcher-and-default-workspace.testcase.yaml` | `browser`, `native` | `F1.2`, `F-WS-2` | **左栏拖拽调宽、左栏工作区切换器与默认工作区保底**：验证拖拽 `main-sidebar-resize-handle` 改变左栏宽度并在 reload 后保持；验证工作区切换器位于工作区左栏顶部，初始自带不可删除的 `Default Workspace`，支持新建与切换工作区。 |
| **`TC-WS-006`** | `TC-WS-006-workspace-in-panel-git-navigation-and-full-parity.testcase.yaml` | `browser`, `native` | `F25.1`, `F-WS-4` | **工作区内置专用 Git Panel 4 路跳转与 `main` 全功能对齐**：验证工作区左栏已移除 `[文件管理\|Git]` 按钮行（标识 1）、右上角已移除 `Git` 按钮（标识 3）；验证从主左侧栏 `🌿 Git`、左栏底部 Git 状态栏、编辑器 `🌿 在 Git 面板对比`、工作区 `GIT` Tab 跳转到内置 Git Panel，并验证 6 大子标签页、Repo/Branch/Remote、Tree/Flat、Amend、Side-by-Side Diff。 |
| **`TC-WS-007`** | `TC-WS-007-workspace-open-any-session-and-instance-isolation.testcase.yaml` | `browser`, `native` | `F1.5`, `F2.4`, `F-WS-5` | **工作区打开全局任意会话与运行实例隔离**：验证在工作区内通过 `+` 菜单、`Ctrl+Alt+O` 会话选择器弹窗、主左侧栏 `Sessions` 工具窗口打开未关联的全局会话；验证同一会话在 `Workspaces` 与 `Sessions` 模式下各自打开时运行实例完全独立，关闭一方不影响另一方。 |
| **`TC-WS-008`** | `TC-WS-008-workspace-multi-root-and-new-file-folder.testcase.yaml` | `browser`, `native` | `F25.1`, `F-WS-2` | **工作区多根目录（Multi-Root）与新建文件/目录**：验证通过工作区左栏工具栏与文件夹右键菜单执行 `新建文件 (Alt+Insert)`、`新建目录`、`添加外部文件夹到工作区`，并在编辑器中打开新建文件。 |
| **`TC-WS-009`** | `TC-WS-009-sessions-mode-simplified-header-and-preserved-filters.testcase.yaml` | `browser`, `native` | `F1.4`, `F1.5`, `F-Sidebar-1` | **Sessions 模式单行头部极简化与全量过滤保留**：验证 `Sessions` 模式无冗余快速连接芯片行与次级终端栏；验证左栏 `SessionTree` 7 个工具按钮、协议过滤、搜索与顶栏大预览（`Ctrl/Cmd+Shift+E`）与漏斗（`OpenTabsMenu` 分类、目录分组及搜索过滤）可用。 |
| **`TC-WS-010`** | `TC-WS-010-preserved-context-menus-and-shortcuts-regression.testcase.yaml` | `browser`, `native` | `F1.2`, `F1.4`, `F1.8`, `F25.5` | **全量右键上下文菜单与导入导出 100% 保留专项回归**：逐一验证 `app-main-menu`（含 JSON/CSV/MobaXterm/OpenSSH 导入导出）、左侧主导航条右键 `Show Tool Window Names`、`SessionTree` 文件夹与会话右键菜单、`TabBar` 标签右键菜单、`Workspace` 文件树右键菜单无任何缺失。 |
| **`TC-WS-011`** | `TC-WS-011-agents-worktree-orchestrator-and-global-search.testcase.yaml` | `browser` | `F-WS-6` | **Agents 模式 Git Worktree 编排与 `Ctrl+K` 全局命令面板**：验证切换到 `🤖 Agents` 模式查看并行 Worktree 任务、点击跳转工作区 Git 面板审阅 Diff；验证 `Ctrl+K` 搜索工作区、文件与全局会话。 |
| **`TC-WS-012`** | `TC-WS-012-native-desktop-window-drag-mfa-clipboard-and-pty.testcase.yaml` | `native` | `F1.3`, `F2.4`, `F-MFA-1`, `F-WS-3` | **Native 桌面端综合验证（Linux / Windows / macOS）**：在真实桌面 WebView 中验证单行 33px 顶栏原生窗口拖拽、左下角 MFA 悬浮窗复制验证码写入操作系统剪贴板、以及工作区内独立打开真实本地 PTY 终端收发命令。 |

---

## 第三部分：既有受影响测试用例全量盘点与修改适配指南（Existing Affected Cases Audit）

我们对 `qa-ui-auto-tests/cases/` 下的全部既有测试用例进行了地毯式扫描与影响评估，按影响程度分为 **A 类（零修改直接兼容，共 21 个核心用例）** 与 **B 类（因入口迁移需同步微调步骤的受影响用例，共 8 个用例）**。

### 3.1 A 类：通过 `data-testid` 严格保留实现“零修改直接通过”的既有核心用例

得益于第 4.4 节的 `data-testid` 兼容设计，以下既有测试用例**不需要修改任何一行 YAML 步骤**即可在新版 UI 下直接运行并通过（严禁 Coding Agent 破坏这些选择器）：

| 用例 ID | 用例标题 | 为什么零修改即可通过（必须在代码中保障的兼容锚点） |
| :--- | :--- | :--- |
| **`TC-001`** | `Main interface shell renders all primary surfaces` | 顶栏保留 `[data-testid="control-bar"]`、`[data-testid="app-titlebar"]`、`[data-testid="app-main-menu"]`、`[data-testid="titlebar-tray"]`；左栏保留 `[data-testid="sidebar"]`、`[data-testid="main-sidebar-resize-handle"]`、`[data-testid="session-tree"]`、`[data-testid="session-search"]`、`[data-testid="session-new"]`；左侧栏底部保留 `[data-testid="theme-cycle"]`；主区域保留 `[data-testid="welcome-panel"]` 及全部文本锚点；底部保留 `[data-testid="status-bar"]`。 |
| **`TC-013`** | `Session tree search, duplicate and context menu` | `Sessions` 模式左栏 100% 保留 `SessionTree.tsx` 的 `[data-testid="session-search"]`、`[data-testid="session-duplicate"]` 及会话右键菜单。 |
| **`TC-014`** | `Tab bar right-click menu manages open tabs` | `TabBar` 100% 保留标签右键菜单（Close / Close others / Close to the right / Duplicate）。 |
| **`TC-015`** | `Application theme cycles Light → Dark → Follow system` | 移至左侧主导航条底部的主题按钮保留 `button[aria-label="Cycle application theme"]` 与 `[data-testid="theme-cycle"]`，点击行为与 `taomni.appTheme.v1` 持久化完全不变。 |
| **`TC-034`** | `Status bar reflects active terminal count and theme` | `StatusBar`（`[data-testid="status-bar"]`）完全保留。 |
| **`TC-035`** | `Unified app menu opens a new local terminal and lists session entries` | 左上角 `[data-testid="app-main-menu"]` 及其下拉菜单项（`context-menu-item-new-local-terminal`、`Sessions` 子菜单、`context-menu-item-show-sessions`、`context-menu-item-reload-sessions`）100% 保留。 |
| **`TC-036`** | `Session tree creates folders and moves a session` | `SessionTree` 文件夹创建与移动完全保留。 |
| **`TC-038`** | `Welcome panel exposes local-terminal launcher` | `[data-testid="welcome-panel"]` 与 `[data-testid="welcome-open-local-terminal"]` 完全保留。 |
| **`TC-041` / `TC-055`** | `Welcome panel imports OpenSSH config` | `WelcomePanel` 中的 OpenSSH 导入入口完全保留。 |
| **`TC-042`** | `Tab management including middle-click close` | `TabBar` 中键关闭、拖拽排序与新建按钮完全保留。 |
| **`TC-053`** | `Session tree drag-and-drop moves session into a folder` | `SessionTree` 拖拽移动会话完全保留。 |
| **`TC-054`** | `Session import and export JSON, CSV and MobaXterm` | `app-main-menu -> Sessions -> Import / Export` 全部子菜单项 `data-testid` 完全保留。 |
| **`TC-058`** | `Local terminal administrator launch button is visible` | 本地终端启动器完全保留。 |
| **`TC-062`** | `Welcome panel active connections list updates` | `WelcomePanel` 活动连接列表完全保留。 |
| **`TC-100`** | `Custom title bar renders window controls and tray` | `control-bar`、`window-drag-handle`（高度 `<= 32px`）、`window-controls`、`window-min/max/close`、`titlebar-tray`、`theme-cycle` 全部可见。 |
| **`TC-104`** | `Session screenshot entry is removed and system capture remains usable` | 移至左侧主导航条底部的 `ScreenshotMenuButton` 完整保留 `[data-testid="system-screenshot"]`、`[data-testid="system-screenshot-delay-toggle"]`、`[data-testid="system-screenshot-current-window"]` 及 `[data-testid="screenshot-overlay"]`。 |
| **`TC-auto-F-I18n-1`** | `Language switcher cycles between English and Simplified Chinese` | 移至左侧主导航条底部（主题按钮下方）的 `LanguageSwitcher` 完整保留 `[data-testid="language-switcher"]`、`[data-testid="language-option-en"]`、`[data-testid="language-option-zh-CN"]` 与 `[data-testid="ribbon-settings"]`。 |
| **`TC-auto-F1-5`** | `Visible tab details overlay and active detach menu` | 顶栏右侧完整保留 `[data-testid="tab-details-hover"]`、`Ctrl+Shift+H`、`[data-testid="tab-more"]`、`[data-testid="open-tabs-menu"]` 与 `[data-testid="open-tabs-detach-active"]`。 |
| **`TC-WELCOME-RS-01..04`** | `Welcome recent sessions restore suite` | `Home`（`WelcomePanel`）完整保留最近会话恢复横幅与列表。 |

---

### 3.2 B 类：因入口与布局重构受影响、需同步适配或双入口兼容的既有测试用例（8 个）

以下 8 个既有测试用例直接断言了旧版布局中的特定位置或旧入口。在执行 `TASK-02`、`TASK-04`、`TASK-05`、`TASK-10` 时，必须按以下规范提供**双入口兼容**或**同步更新 YAML 断言**：

#### 1. `TC-MAIN-RAIL-01-permanent-tool-window-buttons.testcase.yaml` & `TC-MAIN-RAIL-02-responsive-theme-language.testcase.yaml`
- **受影响原因**：
  - 旧版左侧主导航条顶部仅有 `side-tab-sessions` 和 `side-tab-tools` 两个按钮，且通过点击 `side-tab-tools -> sidebar-tool-code-workspace` 打开代码工作区后，仅在 `collapsed-sidebar-rail`（侧栏折叠态）下才将 `code-workspace-tool-rail-left` 合并进左侧主导航条。
  - 新版（v6.1）中：
    1. 左侧主导航条顶部新增了 `nav-mode-home`、`nav-mode-workspaces`、`nav-mode-agents`，同时保留了 `side-tab-sessions` 和 `side-tab-tools`；
    2. `ToolsPanel` 中保留 `[data-testid="sidebar-tool-code-workspace"]` 兼容入口（点击后自动切换到 `Workspaces` 模式）；
    3. 在 `Workspaces` 模式下，无论左栏展开还是折叠，`[data-testid="code-workspace-tool-rail-left"]`（含 `code-workspace-tool-rail-project` 与 `code-workspace-bottom-tab-overflow`）**始终融合在左侧主导航条 `sidebar-rail` 中**，不再在工作区内部出现第二条竖条！
- **代码兼容与 YAML 适配方案**：
  - **代码侧（`TASK-02`）**：在 `Sidebar.tsx` 的 `sidebar-rail` 中，当处于 `Workspaces` 模式时，始终渲染 `[data-testid="code-workspace-tool-rail-left"]`；同时在 `ToolsPanel` 中保留 `[data-testid="sidebar-tool-code-workspace"]`（点击即激活 `Workspaces` 模式）。
  - **YAML 用例适配（`TASK-10`）**：
    - 在 `TC-MAIN-RAIL-01` 第 95 行：旧版断言展开 `Sessions` 侧栏后工作区内部又出现第二条 `[data-testid="code-workspace-tab"] [data-testid="code-workspace-tool-rail-left"]`；新版已消除双左栏并列（用户明确要求：`希望切换到workspace时，把idea式左边栏融合到窗口左边栏上，不需要第二条左边栏`），因此将该步更新为断言切换到 `Workspaces` 模式时 `[data-testid="sidebar-rail"] [data-testid="code-workspace-tool-rail-left"]` 始终可见，且 `[data-testid="code-workspace-tab"] [data-testid="code-workspace-tool-rail-left"]` 数量为 `0`。

#### 2. `TC-IDE-PARITY-027-01-merged-rail-workspace-browser.testcase.yaml`、`TC-IDE-PARITY-027-02-merged-rail-terminal.testcase.yaml`、`TC-IDE-PARITY-027-03-merged-rail-workspace-native.testcase.yaml`
- **受影响原因**：
  - 这 3 个用例原本测试“当主侧栏折叠时合并工具条，当主侧栏展开时退回双工具条并列”。
  - 新版（v6.1）进一步升级了这一设计：切换到 `Workspaces` 一级模式时，主左侧栏展示的是**当前工作区自己的左栏（文件树 / 工作区切换器）**，IDEA 工具窗口按钮（`Project / Sessions / Git / Structure / ⋯`）**常驻融合在窗口最左侧主导航条 `sidebar-rail` 中**，彻底消除了双左栏并列。
- **代码兼容与 YAML 适配方案**：
  - **代码侧（`TASK-02` & `TASK-05`）**：
    - 保留 `[data-testid="code-workspace-tab"]`、`[data-testid="code-workspace-tree-pane"]`、`[data-testid="code-workspace-tree-add-folder"]`、`[data-testid="code-workspace-tool-rail-project"]`、`[data-testid="code-workspace-tool-rail-right"]` 等全部 `data-testid`；
    - 点击主左侧导航条中的 `[data-testid="code-workspace-tool-rail-project"]` 可直接折叠/展开 `[data-testid="code-workspace-tree-pane"]`，并更新 `aria-pressed="true" | "false"`。
  - **YAML 用例适配（`TASK-10`）**：
    - 将选择器 `[data-testid="collapsed-sidebar-rail"] [data-testid="code-workspace-tool-rail-left"]` 放宽或更新为 `[data-testid="sidebar-rail"] [data-testid="code-workspace-tool-rail-left"]`，并验证点击 `code-workspace-tool-rail-project` 隐藏/显示 `code-workspace-tree-pane` 且宽度保持在 `180px–520px` 像素区间内。

#### 3. `TC-064-code-workspace-editor-save-and-style-status.testcase.yaml` & `TC-065-code-workspace-appearance-and-actions.testcase.yaml` & `TC-IDE-SHELLLAYOUT-01..02`
- **受影响原因**：
  - 这些用例通过 `[data-testid="app-main-menu"] -> [data-testid="context-menu-item-tools"] -> [data-testid="context-menu-item-code-workspace"]` 或 `[data-testid="sidebar-tool-code-workspace"]` 进入代码工作区。
- **代码兼容方案（零 YAML 修改即可通过）**：
  - 在 `ControlBar.tsx` 的 `Tools` 主菜单中保留 `[data-testid="context-menu-item-code-workspace"]`，在 `Sidebar.tsx` 的 `ToolsPanel` 中保留 `[data-testid="sidebar-tool-code-workspace"]`；触发 `onCommand("code-workspace")` 时自动切换到 `Workspaces` 模式并激活当前工作区编辑器（容器保留 `data-testid="code-workspace-tab"`）。这样 `TC-064`、`TC-065` 及所有 `TC-IDE-*` 用例**无需修改打开步骤即可 100% 兼容运行**！

#### 4. `TC-MFA-001-tools-entry-vault-gate.testcase.yaml` ~ `TC-MFA-108`
- **受影响原因**：
  - 新版在左侧主导航条底部新增了 `[data-testid="rail-mfa-button"]`（点击弹出左下角悬浮窗 `[data-testid="mfa-floating-window"]`）。
  - 同时，`TC-MFA-001` ~ `TC-MFA-108` 测试的是通过 `app-main-menu -> Tools -> MFA`（`[data-testid="context-menu-item-mfa"]`）或 `side-tab-tools -> [data-testid="sidebar-tool-mfa"]` 打开全屏 `[data-testid="mfa-tab"]` 管理页。
- **代码兼容方案（零 YAML 修改即可通过 + 新增 `TC-WS-004` 覆盖悬浮窗）**：
  - **保留**：`context-menu-item-mfa` 与 `sidebar-tool-mfa` 继续打开全屏 `[data-testid="mfa-tab"]`（或在悬浮窗点击 `[data-testid="mfa-floating-expand-tab"]` 也打开 `[data-testid="mfa-tab"]`），使 `TC-MFA-001` ~ `TC-MFA-108` **零修改 100% 通过**；
  - **新增**：左侧主导航条底部 `[data-testid="rail-mfa-button"]` 触发左下角悬浮窗 `[data-testid="mfa-floating-window"]`，由新增用例 **`TC-WS-004`** 与 **`TC-WS-012`** 全面覆盖测试。
# GTK 输入法与大预览快捷键追加回归

`TC-WS-046`（Linux native）：在隔离 QA 应用和 CI 相同的 fcitx/GTK 环境中启动真实 PTY，使用 wbpy 输入并提交两个中文字符，独立检查 printf 的完整输出行。通过大预览卡片返回会话后，连续两次按 Ctrl+Shift+E 打开、Esc 关闭，检查同一个终端和原输出保留。此场景保护输入法将首次 keydown 标记为 repeat 时的实际路由；browser 不替代原生输入法证据。`TC-WS-018/019` 同时保留工作区/browser 与 Sessions/native 的连续开关回归；单测确定性覆盖首次 repeat、长按/重复事件、keyup/窗口失焦释放及编辑器快捷键让行。
