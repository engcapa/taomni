# Workspace-First & One-System 平台重构 · 实现与验证报告

> 关联设计：[workspace-platform-redesign-design.md](./workspace-platform-redesign-design.md)
> 关联原型：[workspace-platform-redesign-prototype.html](./workspace-platform-redesign-prototype.html)
> 关联用例规范：[workspace-platform-redesign-testcases.md](./workspace-platform-redesign-testcases.md)
> 分支：`docs/workspace-platform-redesign`

## 0. 本轮原型对齐（2026-10-25，本机完成，GitHub 验证进行中）

本轮按 HTML 原型统一为全高 42px 导航条、260px 初始左栏、6px 分隔、独立圆角框架、33px 画布工具栏和紧凑 Home。Home 独立于 Sessions，全宽展示；Sessions 不再显示 Welcome 标签或欢迎画布。四种视图右上角按原型的模式操作、布局、搜索、大预览、侧栏、更多排列。语音设置保留在更多菜单，协议专属操作仍使用原有 TabActionSlot。

新增覆盖画布的大预览：Home 支持全局范围，Sessions 支持会话范围，Workspaces 支持当前工作区或全部范围；卡片展示真实终端摘要与未保存文本，点击激活已有实例，Esc 关闭并恢复焦点。删除主窗口旧工具栏小预览和 Tao 贴边悬浮入口，Tao 从主导航条进入。逐标签 hover 和详情快捷键保留；独立会话窗口保留既有入口。

按用户确认，Agents / Crew 暂时只提供“开发中”提示；下文历史 TASK-09 的编排界面不属于本轮交付能力。工作区和模式切换隐藏已访问的运行实例，保留 PTY 输出、未保存文本与撤销历史；未访问工作区不自动连接持久化会话。工作区单/分/网格布局均使用原运行实例。Home 的恢复会话快照按模式刷新；终端摘要跳过视口末尾空白而保留实际短输出。

新增 `TC-WS-016`～`TC-WS-020`，并迁移既有会话、邮件、VNC、数据库、语音、Notes 和 Code Workspace 的导航操作，保留其功能断言。最终相关范围为 197 个精确 ID；三平台各模式仅选择其声明适用的用例，不将能力缺口计为通过。覆盖门禁不降低基线。

本机最终证据：

| 检查 | 结果与证据 |
| --- | --- |
| Browser 相关与保留行为 | **159 个不同 ID 全部 passed**：最终 UI 批次 `workspace-browser/run-20261025-143241-657380700` 为 **131/131 passed**，与服务批次 `run-20261025-142514-676472465` 的 28 个当前通过结果合并。服务批次唯一旧导航失败 `TC-IDE-PARITY-027-01` 已修复并在最终 UI 批次完整通过；失败记录保留 |
| Native 工作区与系统边界 | **26/26 passed，0 failed / skipped**；`workspace-native/run-20261025-145157-982159024`，`identity_stable=true`；含真实 SSH/SFTP、磁盘、PTY、大预览、剪贴板、窗口拖动、会话恢复及侧栏切换 |
| 单元 / 组件 | 最终聚焦 MainLayout / appStore / PrimaryNavigationRail **3 files / 120 passed**（`_local/workspace-final-controls-unit.log`）。全量扫描 560 文件，559 通过、邮件文件 1 项失败（5573 passed / 1 failed / 1 既有 skipped，`workspace-final-unit-v4.log`）；同输入完整复跑邮件文件 **67/67 passed**（`workspace-mail-receipt-unit.log`）。按各文件最新结果为 **5574 passed / 1 既有 skipped**，不将首次全量命令记为成功 |
| 构建与静态检查 | `_local/workspace-final-native-build-v3.log` QA 构建成功，包含 `pnpm build`、`pnpm check:refactor`；`native_build.py --check` 确认 inputs match。`workspace-final-audit-v7.log`：580 IDs、0 schema errors、catalog up to date、覆盖门禁通过（1161/1198 required，57 shallow / 4 既有 orphans）。提交后再核验开发契约 |
| 视觉复核 | `_local/workspace-visual/final-workspaces-dark.png`、`final-workspaces-light.png`、`final-home-dark.png`、`final-home-narrow.png`；1440×900 / 960×720。最终 native `run-20261025-145157-982159024/TC-WS-019/ws-019-sessions-large-overview.png` 已人工检查真实两会话输出与选中态 |

本轮修复了隐藏侧栏后分隔条不可拖动、程序展开侧栏覆盖标签组折叠偏好，以及 Home 快照刷新和短终端输出摘要问题。保留失败记录，迁移旧导航后完整重跑受影响用例；没有删除原功能断言或降低覆盖基线。首次全量单测的邮件回执确认文本失败未在完整文件复跑中再现，未对邮件代码或断言作规避修改。

三个最终 UI 批次均为 `identity_stable=true`；使用 runner 的 `load_observations` 核验签名、summary hash、执行配置、源码/runner/用例指纹及 native 构建身份，159 browser + 26 native 无缺失、失败、跳过或陈旧结果。核验记录：`_local/workspace-final-local-evidence.json`。最终源码身份为 `84c7d53c6d43a7196871938bbed2be843b11f6ac50ba40ed285614bca49fe1a0`。

本机测试 worker 总数不超过 2，native 顺序执行，使用独立 QA 应用、临时目录及私有 X11 会话。GitHub 先执行相关三平台 browser/native 矩阵，再执行整个用例目录，结果将在完成后补充。下文第 1–3 节仅记录此前实现与历史选定运行，不能替代本轮最终证据。

## 1. 交付范围（TASK-01 ~ TASK-10）

| 任务 | 交付内容 | 主要文件 |
| --- | --- | --- |
| TASK-01 | 平台状态层：`PrimaryNavMode`、右栏折叠、左下角 MFA 浮窗状态、工作区多根/默认工作区/隔离标签/固定会话、编辑器瞬态状态 | `src/stores/app/types.ts`、`src/stores/app/layoutSlice.ts`、`src/stores/workspacePlatformStore.ts`、`workspaceEditorStore.ts`、`workspaceUiStore.ts`、`workspaceRailStore.ts`、`agentsStore.ts` |
| TASK-02 | 左侧主导航条：Home / Workspaces / Sessions / Agents / Tools、Workspaces 融合 IDEA 工具窗口、底部 6 个全局工具、Show Tool Window Names | `src/components/sidebar/PrimaryNavigationRail.tsx`、`Sidebar.tsx`、`HomeSidebar.tsx`、`AgentsSidebar.tsx`、`SessionsSidebarPanel.tsx`、`ToolsPanel.tsx` |
| TASK-03 | 单行 33px 共享 ControlBar：左右栏收缩、模式标签条、全局搜索、右栏上下文面板 | `src/components/tabbar/ControlBar.tsx`、`src/components/workspace/RightContextPanel.tsx`、`src/layouts/main/MainLayoutView.tsx`、`usePlatformShortcuts.ts` |
| TASK-04 | 左下角可拖拽 MFA 悬浮窗：安全库门禁、搜索、TOTP/HOTP 复制、30s 环、置顶、Esc、展开全屏 | `src/components/mfa/MfaFloatingWindow.tsx` |
| TASK-05 | 工作区左栏：切换器、多根文件树、新建文件/目录、添加/移除根目录、底部 Git 状态条 | `src/components/workspace/WorkspaceSidebar.tsx`、`WorkspaceSwitcher.tsx`、`WorkspaceFileTree.tsx`、`WorkspaceFsModals.tsx`、`workspaceFs.ts` |
| TASK-06 | 工作区内置 Git：主左栏 Git、状态条、编辑器对比、GIT 标签四路入口；复用 `WorkspaceGitManager` 全部能力；工作区文件编辑器 | `src/components/workspace/WorkspaceGitPanel.tsx`、`WorkspaceFileEditor.tsx`、`WorkspaceTabStrip.tsx` |
| TASK-07 | 工作区打开任意会话：+ 菜单、`Ctrl/Cmd+Alt+O` 选择器、Sessions 工具窗口；运行实例与 Sessions 模式隔离 | `src/components/workspace/WorkspaceSessionPickerModal.tsx`、`WorkspaceSessionsPanel.tsx`、`WorkspaceSessionPane.tsx` |
| TASK-08 | Home 模式接入 WelcomePanel 全部能力；Sessions 单行头部、保留工具条/搜索/目录树/右键菜单与 OpenTabsMenu | `Sidebar.tsx`、`HomeSidebar.tsx`、`SessionsSidebarPanel.tsx`、`MainLayoutView.tsx` |
| TASK-09 | Agents Worktree 调度台（派发、沙箱策略、轨迹、待授权命令、Diff 移交）与 `Ctrl+K` 全局命令面板 | `src/components/agents/AgentsPlatformView.tsx`、`src/components/search/GlobalCommandModal.tsx` |
| TASK-10 | 单测、`TC-WS-001` ~ `TC-WS-014`、跨端 fixture、控件目录、覆盖率基线 ratchet、`pnpm check:refactor` / `pnpm build` / `pnpm test` | `src/**/__tests__`、`qa-ui-auto-tests/**`、`.agents/skills/qa-ui-auto/**` |

## 2. 实现要点与兼容策略

1. **单一导航条**：`sidebar-rail` 同时承载一级模式、Workspaces 上下文工具与底部全局工具；旧 Code Workspace 的工具条在 Workspaces 模式通过 `useWorkspaceRailStore.forceMerge` 强制合并到主栏，画布内不再出现第二条竖向条。
2. **默认工作区保底**：`workspacePlatformStore` 在空/损坏存储下自动生成 `default-workspace`，删除请求返回 `false`；删除自定义工作区时自动回退到默认工作区。
3. **运行实例隔离**：工作区标签 id 采用 `ws:<workspaceId>:<kind>:<uuid>`，独立存储于 `workspacePlatformStore`；Sessions 模式继续使用 `appStore.tabs`，两套运行时互不读写。
4. **测试选择器兼容**：`control-bar`、`window-drag-handle`、`sidebar`、`expanded-sidebar-panel`、`collapsed-sidebar-rail`、`main-sidebar-resize-handle`、`session-tree`、`welcome-panel`、`status-bar`、`theme-cycle`、`language-switcher`、`system-screenshot`、`ribbon-settings` 等既有 id 保持原名。
5. **Code Workspace 入口**：`sidebar-tool-code-workspace` 在工作区存在根目录时进入 Workspaces 模式并打开工作区自己的 Code Workspace 标签；无根目录时保留旧的 app 级 Code Workspace 行为（`TC-064`/`TC-065` 零修改通过）。
6. **macOS 原生菜单**：macOS 无 `app-main-menu`（由系统菜单承载）；`TC-WS-001` 改为断言窗口拖拽抓手，`TC-WS-010` 的 native 覆盖限定 Linux/Windows，浏览器覆盖不受影响。
7. **MFA 浮窗**：复用既有 `mfaStore` / `VaultGate` 语义；未解锁时显示紧凑入口，展开后进入既有 `mfa-tab`，因此 `TC-MFA-*` 的原有流程保持不变。

## 3. 测试与验证

### 3.1 单元 / 组件测试

新增 10 个测试文件、56 个用例（`TC-WS-015` 为 native 端补充用例）：

- `src/stores/__tests__/workspacePlatformStore.test.ts`（UT-WS-01-01 ~ 08）
- `src/components/sidebar/__tests__/PrimaryNavigationRail.test.tsx`（UT-WS-02-01 ~ 07）
- `src/components/tabbar/__tests__/ControlBarSharedToolbar.test.tsx`（UT-WS-03-01 ~ 06）
- `src/components/mfa/__tests__/MfaFloatingWindow.test.tsx`（UT-WS-04-01 ~ 05）
- `src/components/workspace/__tests__/WorkspaceSidebar.test.tsx`（UT-WS-05-01 ~ 06）
- `src/components/workspace/__tests__/WorkspaceGitIntegration.test.tsx`（UT-WS-06-01 ~ 07）
- `src/components/workspace/__tests__/WorkspaceIsolatedSessions.test.tsx`（UT-WS-07-01 ~ 05）
- `src/components/welcome/__tests__/HomeModeWelcomePanel.test.tsx`（UT-WS-08-01 ~ 04）
- `src/components/agents/__tests__/AgentsPlatformView.test.tsx`（UT-WS-09-01 ~ 06）
- 修正受新布局影响的既有测试：`Sidebar.test.tsx`、`ControlBar.test.tsx`、`TitleBarTrayControls.test.tsx`

本地结果：

- `pnpm exec vitest run <以上文件>`：56/56 通过。
- `pnpm test`：557 个文件、5560 个用例通过（1 个 skip）。
- `pnpm check:refactor`：Contracts/Boundaries/Source size 全部通过。
- `pnpm build`：TypeScript 检查与生产构建通过。

### 3.2 Browser / Native 用例

`qa-ui-auto-tests/cases/TC-WS-001` ~ `TC-WS-015`：

- 浏览器：全部 14 条 browser 用例（`TC-WS-012`/`014` 为 native-only）在 Linux/Windows/macOS Chromium 通过。
- 原生：`TC-WS-001` ~ `012`、`014`、`015` 在 Linux WebKitGTK / Windows WebView2 / macOS WKWebView 按平台声明通过；`TC-WS-010` native 限 Linux/Windows（macOS 原生菜单边界），`TC-WS-014` 限 Linux（系统剪贴板独立进程断言），`TC-WS-015` 限 Linux/Windows（macOS 合成文本投递不稳定，改由 `TC-WS-012` 验证提示符）。
- 回归子集：`TC-001/013/014/015/035/036/038/042/053/054/058/062/100/104`、`TC-auto-F-I18n-1`、`TC-auto-F1-5-tab-details-overlay`、`TC-MAIN-RAIL-01/02/03/04`、`TC-IDE-PARITY-027-01`、`TC-IDE-PARITY-027-03`、`TC-064/065`、`TC-MFA-001/101/104` 全部通过。
- 新增夹具 `platform_workspace_root`：browser 使用 `/preview` 虚拟文件系统，native 使用真实临时目录；已登记到 fixture registry、schema 和权限/能力检查链路。
- 控件目录：`F-WS-1` ~ `F-WS-6` 已写入 `qa-ui-auto-tests/feature-list.md`；`testid-catalog.md` 已重新生成。
- 覆盖率基线已按新增 F-WS 表面 ratchet：`1120/1156` required、60 shallow、4 orphans（4 个均为与本变更无关的既有 orphan）。

### 3.3 历史 GitHub Actions 证据

| Run | 范围 | 结果 |
| --- | --- | --- |
| [40134131306](https://github.com/engcapa/taomni/actions/runs/40134131306) | linux/windows/macos · browser+native · 41 条 | 除 macOS `TC-WS-012` 外全部通过（随后修复 xterm 焦点选择器） |
| [40135489934](https://github.com/engcapa/taomni/actions/runs/40135489934) | 三端 · browser+native · TC-WS-012 | 通过 |
| [40139558323](https://github.com/engcapa/taomni/actions/runs/40139558323) | 三端 · browser+native · TC-WS-011/012 | `TC-WS-011` 三端通过；`TC-WS-012` macOS 暴露 WebDriver 聚焦问题 |
| [40140719840](https://github.com/engcapa/taomni/actions/runs/40140719840) | 三端 · native · TC-WS-012 | Linux/macOS 通过（Windows 同构建，随最终全量回归覆盖） |
| [40141568491](https://github.com/engcapa/taomni/actions/runs/40141568491) | 三端 · browser+native · 41 条 | 40/41 通过（仅 macOS `TC-WS-012` 的合成键盘输入不稳定） |
| [40143830758](https://github.com/engcapa/taomni/actions/runs/40143830758) | 三端 · native · TC-WS-012/015 | `TC-WS-015` Linux/Windows 通过；`TC-WS-012` macOS/Linux 通过 |
| [40145294238](https://github.com/engcapa/taomni/actions/runs/40145294238) | 三端 · native · TC-WS-012 | 通过（含 Windows PowerShell 提示符） |
| [40149432172](https://github.com/engcapa/taomni/actions/runs/40149432172) | 三端 · browser+native · 42 条 | 41/42 通过；Linux native `TC-WS-008` 因 WebDriver 将 `_` 输入为 `-` 导致路径不匹配 |
| [40151860983](https://github.com/engcapa/taomni/actions/runs/40151860983) | 三端 · browser+native · TC-WS-008 | 通过（fixture 目录名与选择器均已修复） |
| [40153251124](https://github.com/engcapa/taomni/actions/runs/40153251124) | 三端 · browser+native · 42 条（此前选定范围） | **通过**：161 次执行全部 passed（0 failed / 0 skipped / 0 infrastructure errors） |

### 历史 42 项选定回归

- 此前选定范围运行：[`40153251124`](https://github.com/engcapa/taomni/actions/runs/40153251124)（`docs/workspace-platform-redesign` 分支，结论 **success**）。
- 结果表：

  | Combination | Selected | Passed | Failed | Skipped | Infrastructure errors |
  |---|---:|---:|---:|---:|---:|
  | linux-browser | 35 | 35 | 0 | 0 | 0 |
  | linux-native | 22 | 22 | 0 | 0 | 0 |
  | windows-browser | 35 | 35 | 0 | 0 | 0 |
  | windows-native | 19 | 19 | 0 | 0 | 0 |
  | macos-browser | 34 | 34 | 0 | 0 | 0 |
  | macos-native | 16 | 16 | 0 | 0 | 0 |

- 共 161 次用例执行全部通过；选中的 42 条用例包含 15 条重构用例（`TC-WS-001` ~ `TC-WS-015`）与 27 条既有 browser/native 回归用例。平台/模式不适用时由用例的 `modes` / `native_platforms` 声明排除，不计为 skip 或失败。
- 过程中的失败均已修复并复跑验证：选择器标签（Close all / Move to folder）、受控 checkbox 属性、OpenTabsMenu 过滤对象、macOS 原生菜单、UI 建会话的主机必填、原生驱动不支持文本管道与 `_` 输入、xterm 焦点与 macOS 合成文本、以及一次与本变更无关的 Windows QA 工具临时文件锁单测抖动（重跑通过）。

### 3.4 未验证 / 边界

- 浏览器预览使用 stub（终端、Git、文件系统、MFA 存储）；真实网络、PTY、磁盘与系统剪贴板由 native 用例覆盖。
- 操作系统级剪贴板只在 Linux X11 通过 `TC-WS-014` 断言；Windows/macOS 仅断言应用内复制反馈（`TC-WS-012`）。
- AI 生成 Commit Message 与 Agent Worktree 分支联动的后端能力不在本次 UI 重构范围内，界面入口按设计预留。
