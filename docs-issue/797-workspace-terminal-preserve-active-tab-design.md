# Issue #797：Workspace Terminal 保留当前画布修复设计

## 1. 范围、基线与状态

- 来源：<https://github.com/engcapa/taomni/issues/797>。
- 基线：`c0c6be73`（2026-11-12 的 `origin/main`）；修复分支：`fix/workspace-terminal-preserve-active-tab`。开始时工作树干净。
- 问题：Workspaces 画布正在查看数据库或 shell 等会话型标签时，点击最左侧 Terminal 会切换到或重新创建 Code Workspace，打断上下对照。
- 权威预期：issue 明确要求保留当前画布标签；会话型标签使用 workspace 底部终端；编辑器视图仍按原方式切换终端。
- 平台：Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView。此修复不改变原生 AppKit 菜单、系统快捷键或标题栏控件。
- 本地仅执行单元测试与静态检查，不启动 browser/native 应用。通过 `gh` 在 GitHub `qa-ui-auto-platforms.yml` 运行三平台 browser/native，包含完整 `crash-regression` 集合。
- 当前状态：设计可实施且核心实现完成；改前缺陷单测 6/6 失败、候选已通过，hosted 验收待执行。设计与静态检查不代表 UI/native 执行通过。

## 2. 用户契约与验收

| ID | 前置与操作 | 必须观察到的结果 |
| --- | --- | --- |
| AC-01 | Workspaces 当前为数据库等会话标签，点击左栏 Terminal | 上方当前标签 ID、内容与标签集合不变，下方出现终端；不得切走或新建 Code Workspace |
| AC-02 | Workspaces 当前为 shell 标签，连续打开、隐藏、再打开 Terminal | 上方 shell 一直保留；底部终端的同一会话与既有输出保留，不重复创建 PTY |
| AC-03 | 显式关闭 Code Workspace 标签后，从会话画布点击 Terminal | 仍可显示 workspace 底部终端，Code Workspace 标签保持不存在 |
| AC-04 | 当前是编辑器视图，从左栏或编辑器 Terminal 入口切换工具窗 | 既有编辑器终端行为不变；文件内容、dirty/undo 状态及选中标签不受影响 |
| AC-05 | 打开底部终端后切换工作区、Home、Sessions，再返回 | 工作区会话隔离；当前画布及该 workspace 的底部终端可恢复，隐藏时不错误断开 |
| AC-06 | 原生终端已就绪，打开/隐藏/切换并恢复 | 上、下两端能分别执行命令并产生独立的锚定输出行；不能只以命令回显或控件存在作为 PTY 正常证明 |

## 3. 决策与兼容边界

| DEC | 结论 | 状态与依据 | 关联 |
| --- | --- | --- | --- |
| DEC-01 | 会话画布的 Terminal 是 workspace 工具，不是进入编辑器的导航动作；编辑器上下文保留原工具窗入口 | 用户已定：issue 的三个期望条目。属于恢复明确契约，不新增 UI 选型或审批环节 | AC-01～04 |
| DEC-02 | 复用现有终端、底部 dock 与工作区状态设施，不引入新依赖、持久化格式或原生 IPC | agent 自决：局部路由与 owner 修复；具体复用位置在实现章节确认 | AC-02、05、06 |
| DEC-03 | 本地不跑 browser/native；将三平台功能与相邻回归、完整 crash 集合合批在 GitHub 执行，失败原件保留后定向重跑 | 用户已定的执行方式，加仓库 crash-regression 约束；不以无关用例失败掩盖本次回归 | 全部 |

非目标：调整 Terminal 快捷键、重做终端外观、改变数据库/SSH 功能、变更网络代理/下载功能、迁移既有配置。仅恢复明确交互，不要求新的布局原型决策。

## 4. 调研与因果链

### 已验证因果链

1. `PrimaryNavigationRail` 的 `sidebar-tool-window-rail` 是 portal 目标；`WorkspaceShellView` 将现有编辑器的 Terminal 按钮合并到主 rail。
2. `views/toolWindowChrome.tsx` 的 `toggleToolWindowFromStripe` 在 editor 不可见时先调用 host `onActivateToolWindow`，随后无条件打开 editor 的工具窗。
3. `useWorkspaceCodeHost.ts` 原 `onActivateToolWindow` 忽略 tool ID：非左侧工具在 editor 隐藏时选第一个文件，否则 `openCodeWorkspaceTab`。后者会选择已有 code 标签，或新建并激活 code 标签。
4. 所以“打开 Terminal”被错误解释为“切回编辑器并打开 Terminal”。原 `WorkspaceMainPanel` 虽有 workspace 底部 renderer，但 rail 不调用它，且它使用条件挂载的独立 `TerminalPanel`，隐藏后会真的释放 PTY。

新增 `WorkspaceTerminalRouting.test.tsx` 在基线真实 rail、host、store、shell 上执行：terminal/database/sftp/git、关闭 code、跨上下文六项全部失败，实际 active ID 均变成 `ws:default-workspace:code`。这是路由缺陷的本地 mounted 复现，不是真机 UI 复现。失败原件 `/tmp/taomni-797-red.log`；相关运行时/边界 mock 只替代外部 filesystem、session 内容及 xterm，不替代被测导航。

### 最终实现边界

| 文件 | 修改与保持的 owner |
| --- | --- |
| `workspace/useWorkspaceCodeHost.ts` | 从当前 store（非 deferred 旧快照）判断 Terminal click，只有会话画布/已打开外部 dock 消费动作；保持当前 tab ID/集合；editor 上无外部 dock 时仍走原逻辑 |
| `workspace/WorkspaceBottomDock.tsx`（新增） | 从主 shell 提取 dock presentation；保留 toolbar、tab、close selector 与持久化 state；提供稳定 DOM destination，不创建终端或其他 editor |
| `stores/workspaceEditorHostStore.ts` | 按 workspace ID 登记与清理 terminal DOM destination；runtime-only，不进持久化 |
| `workspace/workspaceHostIntegration.tsx` | 可选 typed `terminalTool`：external/visible/host、最新状态 toggle、hide；原独立 editor 调用者不受影响 |
| `views/toolWindowChrome.tsx` | Terminal handoff 在 editor show 前消费并隐藏旧 editor placement；pressed 状态、context-menu Hide、remove/overflow 对应可见 owner；其他工具不改变 |
| `views/WorkspaceShellView.tsx` | 将同一 terminal content node 放入 workspace destination；抑制内部重复 slot，portal 活跃态包含外部可见；不新增 editor/runtime |
| `panels/WorkspaceTerminalTool.tsx`（新增） | 保持原 `TerminalDockPanel` 和 handle，按实际 host/editor 可见性驱动 active，使用同一 roots/CWD/task environment |

`TerminalDockPanel` 的多终端、pending command ready guard、task exit、取消及 `TerminalPanel` 的真卸载释放均保持原 owner，未改其实现。切换显示位置用既有 `ToolWindowSlot` 收养稳定节点，不改变 portal key；关闭 workspace/应用时正常清理。平台 store/API/IPC/事件名/持久化版本均不改变，无后端或下载行为变更。

额外保护：新增 presentation 对象仅依赖派生可见性，不依赖整个 `openTabs/activeTabId` 对象身份，避免普通 A→B 文件切换提前重组旧 active buffer（已有 `WorkspaceEditorLifecycle` 精确不变量识别并保护）。

## 5. 实现任务

### TASK-01：定位并隔离上下文终端路由

- 输入：issue、现有 rail handler、workspace/editor dock owner 与相关单测。
- 输出：明确上下文的 Terminal 打开/关闭逻辑，真实状态不变量的失败→通过单测。
- 限制：不得增长已有超 800 行产品文件；如必须调整大型 shell，抽取本次职责及其状态、清理和副作用，不做无关拆分。
- 对应 AC-01～04，V-01；本 agent 负责。

### TASK-02：画布底部渲染与生命周期保护

- 依赖 TASK-01。
- 输出：会话画布底部的终端 UI、工作区隔离、隐藏恢复、无重复终端及编辑器路径保留。
- 保持 public API、事件/IPC 名、现有持久化和失败恢复；测试 mock 只替代 xterm/PTY 外部边界，不替代被测路由。
- 对应全部 AC，V-01、V-02、V-03；本 agent 集成负责。

### TASK-03：hosted 回归与收尾

- 更新/新增可执行 YAML、policy/dependencies 及 feature/control 映射；静态校验后提交新分支并通过 `gh` 触发工作流。
- 监控构建及各平台 browser/native 结果，下载 selection/summary/receipt 与失败原件；修复相关失败并定向重跑。
- 本次引入的相邻回归必须解决；只有有代码/基线证据的无关失败可以明确登记后忽略。
- 对应所有 V；回填具体提交、Actions URL、用例计数与实际平台边界。

## 6. 验证选择与改前基线

| V | 用途及证明范围 | 检查 | 改前结果 | 候选结果 |
| --- | --- | --- | --- | --- |
| V-01 | 状态路由、当前标签、dock owner、挂载/隐藏恢复 | `WorkspaceTerminalRouting.test.tsx` 8 项 + 相邻 mounted/unit | 六项缺陷回归全部复现切到 code；保留行为基线见下 | 8 文件 99/99 通过（`/tmp/taomni-797-final-units.log`） |
| V-02 | 实际 rail → 画布流程、会话/编辑器路径、关闭 Code Workspace 后不重建 | 新增 `TC-WS-091` browser；48 步，covers F-WS-1/F-WS-2/F-WS-5/F25.5 | UI 改前未执行 | YAML/contract/selection 有效；hosted 待执行 |
| V-03 | 真实 PTY 生命周期、独立上下输出、隐藏/重开及工作区隔离 | 新增 `TC-WS-092` native；61 步（补充返回编辑器的一次点击恢复），三平台 | UI 改前未执行 | YAML/contract/selection 有效；hosted 待执行 |
| V-04 | 受影响既有编辑器 Terminal 与文档生命周期 | `TC-IDE-PARITY-010-01`、`TC-IDE-PARITY-010-04-tool-windows-native`、`TC-WS-017`；完整 `crash-regression` 由 hosted 合并 | 下方相关单测通过；UI 未执行 | 待执行 |
| V-05 | 类型、模块边界、QA case/catalog | `pnpm exec tsc -b`、`pnpm check:refactor`、QA audit/contract/selected plan | QA audit 基线通过；这些检查不证明 UI 或 PTY | TypeScript、refactor、audit gates 和新增两 case 的 reviewed contract 有效；全库 contracts 存在 32 项无关旧缺口（非本次新增），未修订其状态 |

2026-11-12、基线 `c0c6be73`、本地 Linux、Node 22.18.0 / pnpm 10.30.0：

- `pnpm exec vitest run src/layouts/MainLayout.test.tsx --maxWorkers=2`：53/53 通过。
- `pnpm exec vitest run src/stores/__tests__/workspacePlatformStore.test.ts src/stores/__tests__/workspaceEditorActivation.test.ts src/stores/app/workspaceSidebar.test.ts src/components/workspace/__tests__/WorkspaceEditorLifecycle.test.tsx src/components/sidebar/__tests__/PrimaryNavigationRail.test.tsx --maxWorkers=2`：5 文件、43/43 通过。
- 一共 96 项保留行为单测通过。不将这些既有测试视为已覆盖 issue 缺陷或原生 PTY。

## 7. 三平台 hosted/真机执行手册

1. 使用新分支、确定的候选 SHA，通过已登录 `gh` dispatch `qa-ui-auto-platforms.yml`；外网 CLI 使用 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY=http://10.1.0.80:3228`。
2. `scope=selected`、`platforms=linux,windows,macos`、`modes=browser,native`、`native_release=true`；精确功能 case 加完整 `crash-regression`。原生使用 workflow 生成的匹配源码 QA release，不能借用旧应用冒充当前候选。
3. Linux 为 hosted Ubuntu/X11/WebKitGTK；Windows 为 hosted Windows/WebView2；macOS 为 hosted macOS 15 ARM64/WKWebView。隔离 QA profile 与 fixture 所有权由 runner 管理，不接触个人配置。
4. 功能路径：打开 workspace shell → 点击左栏 Terminal → 检查原标签及内容不变、底部终端可用 → 隐藏/重开 → 关闭 Code Workspace 再打开底部 → 跨工作区/模式返回。原生额外在上、下终端各执行命令，断言分别出现锚定结果行且原输出保留。
5. 下载 invocation 对应 `selection.json`、`ci-summary.json`、每组 raw summary/receipt、构建身份与日志；查看新 case、相邻 case 和完整 crash 集合的通过/失败/skip。环境缺失、skip、未产生证据均不是通过。
6. 保留截图用于查看上下布局、命中和内容；不把 screenshot 成功等同于视觉评审完成。

### 当前 hosted 证据（进行中）

- 首轮 [Actions 43249483420](https://github.com/engcapa/taomni/actions/runs/43249483420)，候选 `e7af074e`，invocation `651ce36cb0f1413eaa387f95a636ed93`。三平台 browser 均实际执行 14 项：13 passed / 1 failed / 0 skipped。`TC-WS-091` 与所选工作区/编辑器/crash browser 用例全部通过；不能从 job `success` 推断所有 case 通过。
- 唯一 browser 失败为同步修复的 `TC-NOTES-008` 新断言：CodeMirror 逐 `.cm-line` 渲染，容器 `textContent` 不含行间换行；已在 `f91df2c4` 改为完整有序行集合断言，不改产品预期。首轮原件保留，独立 browser 重跑为 [Actions 43252255037](https://github.com/engcapa/taomni/actions/runs/43252255037)。
- 首轮三平台 native QA release 构建/执行待完成，不能将 browser 结果当真实 PTY 通过。本地 artifact 读取目录 `/tmp/taomni-797-ci-43249483420-*`；可从 Actions 下载原始 artifact 恢复。

macOS native bridge 的 DOM 按键只证明 WebView/xterm/PTY 输入链路，不证明物理键盘、AppKit accelerator 或系统 IME；本次未改这些边界。hosted macOS 15 ARM64 不覆盖 Intel 或所有支持版本。

## 8. 收尾、风险与回退

- 关键风险：把终端从 editor 移动到 workspace 时重挂载/重复创建 PTY；隐藏上方 session、切错全局 tab；跨工作区共享状态；改坏正常编辑器 toggle。必须分别保留行为断言。
- 未执行的 hosted 测试是交付证据缺口，不记通过。未要求创建 PR、合并或关闭 issue，不自动执行这些动作。
- 如不改变数据格式，代码回退不需要持久化迁移；保留当前用户会话及配置。具体回退边界以最终实现章节为准。
