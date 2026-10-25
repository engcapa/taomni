# Workspace-First & One-System 平台重构 · 实现与验证报告

> 当前追加验收进行中：共享 Code Workspace/LSP、混合文件浏览、文件/会话冷启动恢复、广播目标选择、紧凑 Sessions 导航及重复 Git 按钮修复均已实现。本机已完成多批 browser/native 回归；三平台相关集和全量验收仍在推进。以本节最新记录为准，下文历史源码与运行编号不能视为当前版本的全量通过证明。

> 关联设计：[workspace-platform-redesign-design.md](./workspace-platform-redesign-design.md)
> 关联原型：[workspace-platform-redesign-prototype.html](./workspace-platform-redesign-prototype.html)
> 关联用例规范：[workspace-platform-redesign-testcases.md](./workspace-platform-redesign-testcases.md)
> 分支：`docs/workspace-platform-redesign`

## 追加反馈与跨平台回归（2026-10-25）

2026-10-26 最新续验：同一栏的重复 Git 按钮已删除；共享编辑工具栏只保留“在 Git 中比较”，主导航条保留完整 Git 管理入口。`TC-WS-006` 增加数量断言，并继续执行六种 Git 视图、提交选项、多仓库和 Diff 切换，browser/native 定向复跑均通过。根目录行的重复入口也已移除，组件回归保护该边界。

在 `9fc7f4aa` 时本机有效回执核验结果为 **25 个 browser ID、6 个 native ID 全部通过**，无拒绝、过期或缺失结果，记录为 `_local/workspace-current-local-evidence.json`。Browser 主批次为 `workspace-browser/run-20261026-042552-094346821`，更新后的 Git 用例为 `run-20261026-043939-150540769`。Native 为 `workspace-native/run-20261026-042551-971492851`（4 passed / 1 SSH 服务未启动而 skipped）、`run-20261026-042848-716576587`（使用独立服务完整重跑冷启动恢复并通过）、`run-20261026-043110-456493505`（真实 GSS/SSH 与 SFTP 通过）及 `run-20261026-043939-464029535`（最终 Git 用例通过）。保留首次服务缺口，不计作通过；6 个 ID 在该版本的最新适用结果均为 passed。

目录选择定向运行 [40228782682](https://github.com/engcapa/taomni/actions/runs/40228782682) 的 macOS 已通过。后续三平台 5 ID 定向运行 [40230884973](https://github.com/engcapa/taomni/actions/runs/40230884973) 为 Linux 5/5、macOS 4/5、Windows 2/5，4 项失败、0 基础设施错误，未通过。Windows 的 Int32 动态绑定错误在 PowerShell 7 仍复现，版本判断未解决问题；将实际 Win32 枚举、所有者与按钮检查移入 C#，只把观察结果交回 PowerShell JSON 序列化。macOS 冷启动辅助脚本改为操作所属 QA 进程的原生关闭按钮；固定 WebDriver session ID 不再被误判为复用进程，必须观察到所属进程 PID 改变，且仍先验证原 bridge 端口释放、正常关闭与原 profile 恢复。

上述工具修复通过 29 项契约，本机 `TC-WS-006` browser 和 `TC-WS-030` native 完整复跑通过，均 `identity_stable=true`：`workspace-browser/run-20261026-045751-797253612`、`workspace-native/run-20261026-045751-351481537`。此前 browser 配置启动不需要的 SSH 容器时与并行 native 服务撞名，保留 setup 失败日志，改用无需服务的 Git 场景配置后通过。Windows/macOS 系统边界继续定向实测；通过后执行 373 ID 相关集，再执行全量。已核对全量为 619 个适用 ID，唯一外部项目缺口仍为用户确认单列的 `TC-IDE-C6-06`。

本机 QA v13 二进制 `src-tauri/target/qa-ui-auto/debug/taomni` 的构建输入匹配当前产品源码；源码指纹为 `1381198413aefe6d9838904adacbf374f951f41c171afb42b56224ad15615302`。最新静态审计（620 ID）、覆盖门禁、Rust 格式检查和 `pnpm check:refactor` 通过。所有本机测试保持最多 2 个 worker，native 顺序执行；此处本机通过不替代仍在进行的三平台相关集与全量验收。

2026-10-26 续验：相关集 [40204276862](https://github.com/engcapa/taomni/actions/runs/40204276862) 的 browser 为 Linux 258/258、Windows 258/258、macOS 257/257；native 为 Linux 162/166、Windows 141/147、macOS 130/135，15 项失败，基础设施错误 0。该运行未通过，尚不能启动全量验收。目录选择修复覆盖 GTK Recent、macOS NSOpenPanel 查找和 Windows UIA 按钮类型；邮件关闭重开恢复直接关闭标签的原有操作；普通文件保留检查控件；独立 SFTP 窗口补充真实输入焦点与完整地址断言。

Windows 编码弹窗改为挂载到 body，避免 `react-resizable-panels` 的文档级指针监听在弹窗覆盖分隔线时抢焦点。外部文件通知处理从 `controller/fileActions.tsx` 提取到 `controller/externalFileChanges.ts`，保持原入口导出、事件和磁盘冲突流程；删除通知先读取当前磁盘，原子替换后仍存在的文件走正常快照校验，真实删除继续保留本地缓冲区与恢复操作。新增测试验证未变化/替换/删除/关闭期间的结果，原生保存与重排用例继续保护真实副作用。

本机冷启动探针显示：直接 DELETE WebDriver 会话并结束进程会丢失 WebKitGTK 尚未提交的最近 localStorage 事务，包括标签重命名、排序和当前选择。`native_restart_app` 改为通过产品关闭按钮正常退出，等待上下文关闭后释放驱动并启动同一 profile；不使用延时、重载或数据回填代替持久化。用例增加关闭前及重启后 Home 阶段的存储断言，保留原文件/会话/草稿/磁盘冲突断言。QA v11 本机冷启动用例 `workspace-native/run-20261026-001649-611608683` 的 102 步全部通过，包含两次正常退出并保留 profile 的重启。

2026-10-26 本机修复验证：QA v11 `workspace-native/run-20261026-002103-500756976` 为 8 passed / 1 setup failed；唯一失败为 GSS 专用服务未配置、未执行 UI。补齐用户拥有的高端口 KDC/SSH、私有票据及独立 known_hosts 后，真实 GSS 认证探针和 `workspace-native/run-20261026-003448-643214252` 的完整 `TC-SESSION-GSS-001` 均通过，包含终端命令、附属及独立 SFTP 列表。因此本轮 9 个不同回归 ID 最终全部通过；连同冷启动共 10 个 native ID，均 `identity_stable=true`。保留首次服务缺口和历史失败报告。产品二进制为 `src-tauri/target/qa-ui-auto/debug/taomni`，构建日志 `_local/workspace-qa-build-v11b.log`。

同批 browser 的邮件同步、默认工作区和文件浏览通过；外观用例首次选择字体后导航失败，未查明稳定复现，保留报告 `workspace-browser/run-20261026-000958-437770346`，同源码完整复跑 `run-20261026-001722-724798469` 通过。4 个不同 browser ID 最终通过。新增组件/外部文件通知 21 tests、原编辑器 external/workflow/recovery 定向 35 tests 通过（其余 219 项为显式过滤未运行）；工具契约 59 项通过。`pnpm build`、`pnpm check:refactor`、620 ID 的静态审计与覆盖门禁通过。下一步先验证三平台定向原生修复，再执行 373 ID 完整相关集，通过后执行全量。

工作区复用主 Code Workspace 的编辑器、LSP、Project/All Files、查找、导航、分屏、撤销、Git 和工具窗口；不再维护另一套能力不足的代码编辑器。多根目录同时支持普通文档、图片等文件的浏览及系统默认程序打开。字体、字号、主题沿用全局设置。文件和各类会话保存到所属工作区，恢复时保留未保存内容与独立的会话实例。

Home/Tools 的编辑器入口路由至对应工作区或默认工作区；Sessions 不承载工作区或 Welcome。Sessions 筛选合并到既有溢出菜单，支持搜索、协议筛选、键盘导航及大量标签。广播目标通过标签复选框和可搜索选择器选择，筛选不销毁运行实例。大预览激活已有会话时保留侧栏折叠状态。Chat 统一复用左下入口，IDE 工具与全局入口以分隔线、间距和提示区分。Agents/Crew 按用户要求显示“开发中”。

本轮回归另修复：文件标签与共享编辑器运行时的状态栏/重开命令路由、分屏各组文件集合同步、编辑器快捷键优先级，以及键盘切换标签后被终端延迟聚焦打断的问题。编辑器活动文件元数据不再触发重复打开，避免文件移动/撤销和关闭期间重新插入旧缓冲区；显式打开文件统一经过宿主请求。恢复中心在确认最后一条磁盘结果后保持当前页。工作区自动恢复草稿时，既有保存竞态用例改为通过关闭确认明确丢弃草稿并重开磁盘文件，原保存回执、哈希及竞态断言全部保留。工具栏只保留 Git Diff，完整 Git 功能仍由主工具栏侧边入口提供。

当前本机证据（均保留完整报告）：

| 范围 | 结果 |
| --- | --- |
| 核心工作区 browser / native | 37/37、30/30：`workspace-browser/run-20261025-201521-181082186`、`workspace-native/run-20261025-201739-461573604` |
| 旧导航迁移 browser | 41/41：`workspace-browser/run-20261025-205906-690748968` |
| 编辑器 browser | 16/16：`workspace-browser/run-20261025-212951-463647971`，包含分屏共享编辑/撤销、状态栏、关闭重开、Recent Locations |
| 紧凑导航与广播 browser | 3/3：`workspace-browser/run-20261025-214923-804747472` |
| 关键 native 最终修复 | QA v9：`workspace-native/run-20261025-222815-908282466` 9 passed / 1 failed；剩余保存用例调整为显式处理自动恢复草稿后，在 `run-20261025-224710-684944341` 完整通过（397 步）。10 个不同 ID 最终通过；包括系统目录选择、24 文件恢复、分屏、补全、重命名移动/撤销、保存竞态和磁盘结果恢复 |
| Browser 最终修复 | QA v9 同源码：`workspace-browser/run-20261025-222733-723909341` 50 passed / 1 failed；普通文件检查控件的旧隐藏预期在 `run-20261025-224710-880501583` 复测通过；另 `run-20261025-223619-489819249` 两条 SSH 通过，共 53 个不同 ID 最终通过。保留原失败记录 |
| Native 保留行为修复过程 | `workspace-native/run-20261025-215339-155126895` 35 passed / 2 failed，已按以上当前 QA v9 的 10 条定向用例修复并复测；不将该历史批次称为全绿 |
| 单元与工具契约 | 最终 7 文件 / 40 tests 通过（`_local/workspace-ci-repair-unit-final.log`）；QA 重置/目录选择/隔离/验证契约 61/61。`pnpm build` 和 `pnpm check:refactor` 通过，QA v9 构建成功（`_local/workspace-qa-build-v9.log`） |

三平台相关集首次运行 [40194175843](https://github.com/engcapa/taomni/actions/runs/40194175843)，范围为 373 个精确 ID。聚合结果有 292 次 case 失败、0 infrastructure errors，已依据截图、DOM 和日志逐类修复，不以 job 的软成功代表用例成功。macOS 的跨用例工作区残留、系统目录选择的原生窗口层级也纳入修复：仅在已验证隔离身份的 QA 会话中清理 Taomni renderer 命名空间，并在重载前重新写入当前用例的 JDK；系统目录选择分别支持 GTK、Windows 所属主窗口内的原生对话框、macOS NSOpenPanel 的 AXSheet/AXDialog。相关集全部通过后才执行三平台全量，并追加最终证据。

外部项目缺口：`TC-IDE-C6-06-java-definition-realproject-native` 依赖未随仓库提供的 clickhousecrud 源码，按用户确认沿用 `qa-ui-auto-tests/ci/policy.yaml` 的既有策略单独报告，不计作通过。

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
