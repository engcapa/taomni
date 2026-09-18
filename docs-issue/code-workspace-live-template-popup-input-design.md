# Code Workspace Live Template 候选窗口无法导航或接受：修复设计

## 1. 交付范围与状态

- 日期：2026-09-17；问题来源：用户在 Windows 11 输入模板前缀后，上下键移动源码光标、Enter 换行、鼠标点击不展开，只有 Tab 有效。
- 调研基线：`06ea2159b1ddf624d12aa570523416a278cbb9b9`，开始时工作区干净；本轮不修改产品代码。临时诊断代码及原始产物保存在忽略目录 `qa-ui-auto-report/live-template-input/`。
- 当前复核状态：**未通过整体验收**。原始 Windows 缺陷已修复，但独立 review 发现缺陷与复测缺口；以 [2026-09-17 独立复核报告](code-workspace-live-template-popup-input-review.md) 为准。以下 TASK 完成说明保留为提交方原始记录，不构成当前验收结论。
  - TASK-01（持久回归测试）：已在 `src/components/editor/workspace/CodeMirrorHost.live-template-interaction.test.tsx` 编写持久回归测试；改前复现了 red 失败（11+ 次级联循环请求、popup 处于 disabled、Enter 插入换行、鼠标点击无法展开），改后 5 项交互测试全部通过。
  - TASK-02（核心修复）：已在 `src/components/editor/workspace/CodeMirrorHost.tsx` 完成。解耦了 LSP source 生命周期与 Compartment 补全配置（`getOrCreateTrackedLspSource`）；删除了反馈式 `startCompletion` 递归循环；实现基于指纹变化检测（fingerprint）与范围/光标校验的局部模板重新计算（`scheduleLocalRefresh`）；由于保持了 `trackedLspSourceRef` 引用身份不变，CodeMirror 仅刷新本地模板 source 并保持活跃状态，彻底根治 disabled 状态；补齐了 readOnly 下对 Tab/Shift-Tab 展开与占位符跳转的防御，完善了定时器清理逻辑。
  - TASK-03（宿主整合与回归保护）：运行了 `src/components/editor/workspace/` 下 10 个补全/撤销/快捷键/生命周期测试套件（共 150 项测试全数通过），以及 `CodeWorkspaceTab.test.tsx`（共 196 项测试全数通过），无任何邻接退化。
  - TASK-04（QA 用例登记与验证）：在 `qa-ui-auto-tests/cases/` 编写并落盘了 6 个测试用例文件（`TC-IDE-C2-06-live-template-popup-input-native` 至 `TC-IDE-C2-11-completion-retained-behavior`），完整覆盖 RT-01..24 与 AC-01..08；运行 `python -m qa_ui_auto.audit --gate` 通过（217 个用例，0 error）；native/browser dry-run 验证通过；`pnpm build`（`tsc -b && vite build`）通过。
- 产品范围：Windows / macOS / Linux 的 Tauri 桌面 Code Workspace，共享 CodeMirror 补全状态机；不是仅对 Windows 加键盘补丁。
- 推荐方案：取消 provider 模板认领回调中的全量 `startCompletion`；保留 LSP source 的身份和当前结果，仅在有效认领集合变化时刷新本地模板 source。恢复默认上下键、Enter、鼠标接受路径，保留精确缩写一次 Tab 和 provider 优先契约。
- 本次不扩大模板目录、不更换编辑器或补全组件、不改变用户设置、不引入新依赖、IPC 或持久化迁移。

用户补充要求已落实为 [完整 Browser / Native 复测清单](code-workspace-live-template-popup-input-retest-cases.md)：24 组具体场景、13 个现有用例、每项输入/断言/平台限制与结果要求。该清单属于本设计的必做部分；TASK-03/04 不得只跑原缺陷或选取少量相邻用例代替全部受影响点复测。

本问题与 [Java 模板与成员补全历史修复设计](code-workspace-java-live-template-completion-regression-design.md) 相关，但交付边界不同。该文档的 DEC-01 已确定“当前有效 JDTLS 候选优先；无候选立即本地展开”，本设计沿用。历史“测试通过”不是当前候选窗口可操作的证明。

## 2. 当前调用链与源码证据

下表行号对应调研基线；执行者应按符号查找，避免依赖后续漂移的行号。

| ID | 位置 / 符号 | 已确认事实及意义 |
|---|---|---|
| E-01 | `src/components/editor/workspace/CodeMirrorHost.tsx:2418`，`trackProviderOwnedTemplates` | 每次 LSP 结果含与 Java 本地目录同名的 snippet，就安排 `setTimeout(... startCompletion(view), 0)`；没有比较认领集合是否变化，没有限定刷新次数。 |
| E-02 | 同文件 `buildAutocompletionExtension`，约 2463–2522 | `override` 同时包含本地模板 source 和 `trackedLspSource`；后者每次 await LSP 后又调用 E-01，因此全量重启会再次进入自身。当前 builder 每次调用还会重新创建 LSP source，不能直接复用这个 builder 做“仅本地刷新”。 |
| E-03 | 同文件 `currentProviderTemplatesRef`、`providerOwnedAbbreviations`、`getValidActiveProviderCandidate`，约 2347–2416 | 认领集合存于宿主 ref；现有有效性包含 workspace/file/revision/generation，但读取普通认领时未完整核对光标、请求范围；旧请求的空结果也可能清掉新状态。异步刷新应绑定完整上下文，不能在回调执行时才给旧结果盖上新身份。 |
| E-04 | 同文件 Tab keymap，约 3075–3113 | 先 `acceptCompletion`，失败则尝试有效 provider 精确候选，再 `expandLiveTemplateAt`，最后 snippet 导航和缩进。这是“只有 Tab 看似有效”的独立逃生路径，不能证明 popup 本身健康。 |
| E-05 | `src/components/editor/workspace/liveTemplates.ts:1265` / `applyLiveTemplate`，约 1389 `matchToCompletion.apply` | 本地接受走 CodeMirror `snippet`，使用传入的当前替换范围；现有模板本身能够展开。 |
| E-06 | `src/components/editor/CodeWorkspaceTab.tsx:15671`，`handleWorkspaceCommand` | workspace capture 已对 completionActive 的裸上下键/Page/Enter/Escape 让行，裸 Tab 一直归 editor。不是首先缺少 keymap；需保留并做带宿主回归。 |
| E-07 | 安装版本 `@codemirror/autocomplete` 的 `dist/index.js`：`CompletionDialog.build`、`moveCompletionSelection`、`acceptCompletion`、`applyCompletion` | 活跃 source 重启会使旧列表 disabled；上下键/Enter 在 disabled 时返回 false，后续编辑动作继续执行；鼠标经 `applyCompletion`，若候选 source 已不是 `ActiveResult` 则直接返回 false。应修上游生命周期，不修改 node_modules 或依赖私有 state。 |
| E-08 | `CodeMirrorHost.completion.test.tsx` | 普通成员候选已有上下键、Tab/Enter/鼠标接受测试，但 provider 模板同名用例主要等候选文本出现，再 Escape/Tab，没有验证列表静止后仍可操作。 |
| E-09 | `CodeMirrorHost.tsx:2505` | `interactionDelay` 当前取 documentation delay；这是另一个可能导致刚打开时短暂拒绝输入的边界，不能解释等待 1.2 秒仍重复请求的主缺陷。本次不顺带重设计该设置。 |

因果链：

1. 输入 Java `sout`，本地 source 先显示模板。
2. JDTLS / mock provider 返回同名 snippet，宿主记录认领，并启动整轮补全。
3. CodeMirror 让原先列表进入 pending/disabled，重新查询本地和 LSP。
4. 第二次 provider 返回仍存在同名项，又走步骤 2；停止输入也不能稳定。
5. 裸上下键和 Enter 的默认 completion handler 返回 false，落到源码移动/换行；鼠标无法应用已被重启的 source；Tab 可经精确缩写旁路展开。

**确定性：组件级因果关系已确认。** 碰撞与不碰撞的对照只改变 provider 返回内容，生产 Host、source、CodeMirror 均未修改。刷新周期中存在短暂 active 窗口，因此某一次点击偶然成功不否定此机制；不应把问题描述成每次输入必然失败。Linux/macOS 是否以同样频率显现仍须各端实测。

## 3. 本轮复现、环境与证据

### 3.1 可重复的组件级探针

Windows 当前工作区；Vitest/jsdom 挂载真实 `CodeMirrorHost`，只 mock LSP 外部边界。文本为 `class App {\n  sout\n}`，光标 offset 18；等待 Java language 就绪，打开 completion，再静置 1200ms。每个动作使用独立挂载。

执行命令（仓库根目录，PowerShell；探针是本机忽略目录产物）：

```powershell
pnpm exec vitest run --config qa-ui-auto-report/live-template-input/vitest.config.ts
```

| provider | 动作 | 动作前观察 | 动作后实际结果 |
|---|---|---|---|
| 返回空结果 | ArrowDown | active，selected=0，1 次请求 | selected=1；文档和 head=18 不变 |
| 返回空结果 | Enter / 鼠标 / Tab | active，1 次请求 | 都展开为 `System.out.println();` |
| 返回同名 `sout` snippet | ArrowDown | pending，selected=null，disabled，20 次请求 | head 18→20，源码光标移动，列表关闭 |
| 返回同名 `sout` snippet | Enter | pending，disabled，21 次请求 | `sout` 保留，后面新增换行和缩进 |
| 返回同名 `sout` snippet | 鼠标 | pending，disabled，20 次请求 | 文档未展开；请求继续增长至 22 |
| 返回同名 `sout` snippet | Tab | pending，disabled，20 次请求 | 一次展开，列表关闭 |

原始文件：`probe.test.tsx`、`vitest.config.ts`、`unit-results.ndjson`、`unit-probe-record.log`，均在 `qa-ui-auto-report/live-template-input/`。8 个诊断场景执行完成不等于 8 个修复验收通过：该临时探针记录了错误结果；TASK-01 必须将其转换为断言正确行为、改前失败的持久测试。

第一次探针尝试被现有 Vitest `exclude` 排除（未运行测试），随后在专用配置中明确覆盖 include/exclude；保留原日志，不把该尝试算作行为证据。既有相邻基线：`liveTemplates.test.ts`、`CodeMirrorHost.completion.test.tsx`、`CodeMirrorHost.completion-undo.test.tsx`、`lspCompletion.test.ts` 共 **4 文件、90 测试通过**，耗时 2.88 秒；日志 `baseline-tests.log`。这证明旧覆盖可保持全绿而遗漏本缺陷，不证明完整清单已经执行。

### 3.2 Windows 原生复现

使用 `native_build.py` 构建的 `com.taomni.app.qa`，单独的 app-data/config/cache 和 `project/src/main/java/App.java`，不使用正在运行的个人 Taomni 配置。真实 Java 25 / JDTLS / WebView2，通过 WebDriver 输入和鼠标操作；这是原生 WebView 证据，不是 OS 物理键盘或 IME 证据。

复现脚本：`qa-ui-auto-report/live-template-input/native_probe.py`。磁盘预置语法有效的 App.java，在方法体第三行用真实按键选中前缀并重新输入 `sout`，等待列表后再等 2 秒；分别执行 ArrowDown、ArrowUp、Enter、鼠标、Tab，记录前后源码、选择文本、popup class、LSP 状态并截图。后续轮保留先前 Enter 的空行，逐轮前后比对；Home 的智能行首行为使缩进增加，但 class/main 的括号和正文结构未被破坏。实际待测输入全部由 WebDriver 发出。

**Windows 原生已复现（未修复）**：Windows 11 Pro 10.0.26200 x64，WebView2 / Edge `153.0.4234.32`（UA major 153），当前 package 0.4.25，QA Rust debug + 默认 production frontend，Java 25 / 本机真实 JDTLS。源码 hash `9fa15411923e55a5abab61bf56a1ad6db064748e86867ca2bd4ac13a2570e333`，binary SHA-256 `df127b7e0947a40aa06fca10c3bace547398f9f51c4223306131dacc2c7cec9b`。

| 操作 | 原生动作前 | 原生动作后 |
|---|---|---|
| ArrowDown | popup 含 provider `sout/soutm/sysout` 与本地 `soutp/soutv`，class 含 `cm-tooltip-autocomplete-disabled` | 候选关闭，selection 从 sout 行移动到下面的 `}`，源码文本不变 |
| ArrowUp | 同上 | selection 移至上面的 main 方法签名，源码文本不变 |
| Enter | 同上 | sout 未展开，新增换行及缩进，列表关闭 |
| 鼠标单击第一项 | 同上 | sout 未展开，候选仍 disabled |
| Tab | 同上 | 插入 `System.out.println();`，列表关闭 |

可信原生结果：`clean-ui/native-results.json`、`clean-ui-probe.log`、`clean-ui/{ArrowDown,ArrowUp,Enter,mouse,Tab}-{before,after}.png`、`clean-ui/native-run/native-isolation.json`，相对根均为 `qa-ui-auto-report/live-template-input/`。已查看 Enter-before 与初次 mouse-before 截图，能够辨认真实候选及 Java provider；窗口为 1280×800。

证据限制：此次尝试包装 native invoke 采集 completion 次数没有捕获到数据，结果中的 `requests: 0` **不是零请求证据**；native 只用于证明真实输入结果与 disabled 状态。循环请求计数由组件 controlled provider 探针证明。原生初次整段键入夹具触发自动括号/缩进；一次中间 fixture reset 尝试因不存在 `cmView` 属性失败，均保留日志，不计为干净夹具复现。最终 `clean-ui` 全程 UI 输入，正常结束；独立 session/driver 已关闭，个人生产 Taomni 保持运行。

本轮只构建一次匹配当前源码的 QA binary（此前缓存失效）；Rust build 阶段 8m01s，整体 frontend/typecheck/native 成功，日志 `native-build.log`。没有产品改动，未声称修复后通过或 Linux/macOS 已复现。

### 3.3 推荐方案的 API 可行性探针

`local-refresh.test.ts` 使用当前 CodeMirror 6.20.3 的真实 EditorView/Compartment、本地生产模板 source，以及一个受控异步 provider；只替换本地 source，保留 provider source 引用。静置 1.2 秒后结果：**provider 调用 1 次、本地刷新 1 次、同名 sout 仅保留 provider、状态 active，接受插入 `System.out.println("PROVIDER");`**。日志 `local-refresh.log` / `local-refresh-result.json`，1 项通过。

该探针确认第 4 节所用公开 API 的可行性，并非对生产 Host 的修复，也未证明所有生命周期分支。TASK-02 仍需在生产 Host 整合后通过完整复测。

原始证据放 `qa-ui-auto-report/` 且不提交。其他机器不能假定这些文件存在；下游可依据本节步骤和第 7 节原生手册重建，也可从本机获取脱敏产物。本文保留足以重建测试的数据和观察摘要。

## 4. 决策与修复算法

### DEC-01：恢复已有补全交互，沿用 provider 优先与一次 Tab

状态：**agent 自决（沿用明确既有契约）**。来源：本次用户报告的期望、默认 completion keymap、历史设计已定 DEC-01。上下键选择候选；Enter、Tab、单击接受指定候选；候选窗口关闭时 Enter 正常换行，上下键正常移动源码，精确模板 Tab 即时展开。没有布局、主要操作流程或组件选型变化，无需新原型或人工选择。关联全部 AC/TASK/V。

### DEC-02：刷新本地 source，不递归重启 provider

状态：**agent 自决（内部实现）**。推荐使用现有 CodeMirror `Compartment.reconfigure` 与 source 引用身份，保留 LSP source，替换本地模板 source。CodeMirror 当前实现按 source 函数身份复用 active result；应以黑盒行为测试锁住这一依赖，不能访问私有 field。

考虑过的方案：

- 仅给现有 `startCompletion` 增加“认领集合相同则跳过”：改动小，但每次认领变化仍重新请求 provider，重新产生请求 token 和短暂 disabled；provider 空/恢复/集合往返变化仍要处理。可作为紧急缓解，但不是本设计推荐的完整修复。
- 所有本地候选都等待 provider 后一次合并：容易去重，却改变 provider 缺失/迟缓时本地即时补全体验，还要处理 postfix 与 LSP 不同替换范围，不采用。
- **仅使本地 source 失效并重算**：保留当前 provider 有效候选、无额外网络请求，改动限 Host 内部 source 生命周期；为推荐方案。替换本地 source 可以有一个有限的内部重算过程，不能周期性进入 disabled。

实施细节：

1. 将 `buildAutocompletionExtension` 的“创建 source 生命周期”和“生成 autocompletion 配置”分开。一个 editor mount / 必要配置代内持有稳定 `trackedLspSource` 引用；刷新认领时禁止再次 `createLspCompletionSource`。正常设置变更仍沿用现有合法重建流程，并使旧任务失效。
2. 在 provider 查询入口捕获不可变 scope：workspaceId、fileKey/URI、documentRevision、lspSessionGeneration、policy/source generation、光标位置和查询/替换范围。异步返回时校验 context 未 abort、view 未销毁、当前身份/光标/范围一致、请求仍属当前活动查询。旧结果（包括 null）不准覆盖较新的认领。
3. 对有效结果提取与**当前语言、实际启用本地普通模板**发生碰撞的认领集合。provider 候选缓存可以保留所有有效 snippet 供精确 Tab；用于本地重算的 fingerprint 只取 scope + 去重/排序后的实际碰撞缩写，不比较 Completion 对象引用。
4. 有效新结果即更新同 scope 的候选对象，保证 resolve/token 是最新的；只有 fingerprint 真变化才调度一次本地刷新。无碰撞且原来无认领是 no-op；同标签集合的新对象也是 no-op。当前有效 provider 返回空/失败时清除本 scope 认领并恢复本地选项；stale/abort 的空值不是当前 provider 空结果。
5. 合并刷新任务；在 CodeMirror 当前更新栈之后再次核对 view/scope/generation 与 popup 未被 Escape/blur/切文件关闭。生成新的本地 source 函数引用，用现有 compartment 重配置 `override: [newLocalSource, sameTrackedLspSource]`，保留所有原有配置（autoPopup、icons、maxRenderedOptions、positionInfo 等）。禁止调用 `startCompletion`；禁止重建 EditorView；禁止为 UI 去重发送新 LSP 请求。
6. 因为 provider source 引用保持不变，已有 provider ActiveResult/进行中的同一请求应保留；本地 source 根据已更新认领重算。必须实测“接受命中当前 provider apply/resolve”，不能只断言本地条目消失。若 installed CodeMirror 版本不能满足此契约，TASK-02 应先用最小探针解决，不得靠私有 state 或吞掉箭头掩盖问题。
7. 文档编辑、光标离开范围、source/policy 重建、session generation 变化和卸载都使旧刷新任务失效；clearTimeout/序号防护必须覆盖已排队回调。关闭列表后后台结果可以缓存，但不得重开列表或写文档。切分屏以各 view 为作用域，不能用共享 fileKey 当 view 身份。
8. 保留 Tab 顺序：可接受的当前选中项 → 当前 scope 有效的 provider 精确模板 → 本地精确模板 → snippet/缩进。若补充范围校验，缓存的 from/to 必须与当下精确缩写匹配，不能把旧候选重新套到另一个同名位置。此处不改变 LSP resolve、additionalTextEdits、冲突门禁、单次 undo 契约。

不修改 E-06 的让行逻辑、不增加全局拦键、不拦截全部鼠标点击、不降低 `interactionDelay` 来掩盖循环。宿主集成测试如出现独立事件路由失败，再依据证据缩小处理。

### DEC-03：平台与数据边界

状态：**agent 自决**。修复位于共享 TypeScript / CodeMirror 生命周期，无新增 Rust `cfg`、平台 API、文件读写或网络协议。保留 Windows/Linux Ctrl、macOS Cmd 的既有 shortcut 路由。浏览器 stub 和 jsdom 只证明 renderer 状态机；JDTLS、WebView 输入需原生证据。无凭据、用户配置或存量数据迁移，代码回退即可回退此修复。

## 5. 验收与保留行为

| AC | 前置 / 动作 | 必须观察的结果 | TASK / V |
|---|---|---|---|
| AC-01 | Java `sout`；provider 返回同名 snippet，列表出现后停止输入 | 进入稳定可操作状态；纯认领刷新不增加 LSP fetch；延长观察窗口请求数不继续增长，无周期 disabled | TASK-01/02；V-01/04 |
| AC-02 | 活跃列表有多个本地/provider 混合项，↑↓/PageUp/PageDown | 选中项改变，源码和编辑光标不变；Enter 接受当前项，不额外插入换行 | TASK-01/02/03；V-01/03/04 |
| AC-03 | 单击非默认候选（包括标签、detail 子节点），再 undo | 插入被点击项对应正文，不能偷偷回退到第一项或精确缩写；一次 undo 恢复原前缀及既有选择语义 | TASK-01/02/03；V-01/03/04 |
| AC-04 | 弹窗开启或关闭，精确 sout/soutm；provider 有效/空/失败/慢 | 有效选中项优先；无可接受项时一次 Tab 使用当前有效 provider，否则本地即时展开；本地展开后迟到结果不替换正文 | TASK-02/03；V-02/04 |
| AC-05 | provider 相同认领集合重复返回、撤销认领、重新出现；返回时 Escape/切文件/编辑/卸载 | 无反馈循环；最新有效作用域才影响去重和 Tab；关闭列表不被重开；stale null 不清空新认领 | TASK-01/02；V-01/02 |
| AC-06 | 无碰撞的成员补全、非 Java 本地模板、postfix、自定义模板和禁用设置 | 既有候选、替换范围、普通 LSP resolve/额外编辑/undo 保持；不因 Java 去重改变其他 source | TASK-03；V-02/03 |
| AC-07 | 列表关闭；占位符活跃；只读；IME composition；另一个分屏/搜索框/终端有焦点 | 普通移动/换行/缩进及 Tab/Shift-Tab 占位符正常；只读不改文档；IME 不抢候选键；事件属于焦点所在表面 | TASK-03/04；V-02/03/04/05 |
| AC-08 | 当前 Windows 候选构建及其余两端计划 | 共享代码无平台分叉；Windows 原生完成对应复测，macOS/Linux 各自记录实际状态，不能继承 Windows 结果 | TASK-04；V-04/05/06 |

AC-01 的网络计数是针对明确外部动作的 source 调用控制实验：挂载后重置 spy，稳定一次用户查询后记录；不得把用户继续输入、provider 初始化或显式重新补全产生的合理请求误判为循环。除计数外必须断言实际选择和正文，避免仅测实现细节。

## 6. 实现工作包与文件归属

### TASK-01：将复现变成持久回归测试

- 责任：回归测试实现者；文件 `src/components/editor/workspace/CodeMirrorHost.live-template-interaction.test.tsx`。
- 状态：**已完成 (Done)**。
- 实施：构造了包含同名 Java snippet (`sout`) 的 provider 与空 provider 对照，测试真实 keydown（ArrowDown/ArrowUp/Enter/Tab）和 mousedown 事件：
  1. 验证 provider 返回后不发生无限循环刷新（spy 请求计数稳定为 1 次，无级联增长）。
  2. 验证 ArrowDown/ArrowUp 切换候选项，源码文本与编辑光标保持原位不变。
  3. 验证 Enter 接受当前选中候选，不额外插入多余换行符；一次 undo 恢复原前缀。
  4. 验证鼠标 mousedown 单击候选项精确展开为指定正文，一次 undo 恢复。
  5. 验证无 provider 或 provider 为空时本地模板秒级即时展开，不挂起。
- 结果：改前测试精准复现红灯（11+ 次级联循环、popup 进入 disabled、Enter 换行、鼠标无法展开）；改后 5 项回归测试全部通过。

### TASK-02：修复 source 生命周期与有效性

- 责任：补全实现者；文件 `src/components/editor/workspace/CodeMirrorHost.tsx`。
- 状态：**已完成 (Done)**。
- 实施：遵循 DEC-01/02/03：
  1. 解耦 LSP source 创建生命周期与 Compartment 配置构建：`getOrCreateTrackedLspSource` 在 ref 中持久持有 stable `trackedLspSourceRef`，配置重建时不重复创建 LSP source。
  2. 彻底移除认领回调中触发全量循环的 `startCompletion(view)`。
  3. 实现 `handleProviderTemplateClaim`：校验不可变 scope（workspaceId, fileKey, revision, generation）、查询 ID 与光标替换范围（`from`/`to` 必须与当前缩写范围匹配）；提取与本地普通模板碰撞的标签集合，计算排序后的 fingerprint。
  4. 仅当碰撞 fingerprint 真实发生变化时，调用 `scheduleLocalRefresh`，通过 `completionCompartment.reconfigure([newLocalSource, sameTrackedLspSource])` 仅让本地 source 重新计算；由于 LSP source 引用完全相同，CodeMirror 保留已有结果与 active 状态，不会使 popup 变为 disabled。
  5. 增加 `localRefreshTimerRef`，在文档编辑、Escape/关闭列表、配置变更与组件卸载时立即清除，杜绝定时器泄漏。
  6. 在 `view.state.readOnly` 下禁止 Tab/Shift-Tab 展开与占位符跳转。
- 结果：V-01 全部变绿，同名碰撞去重稳定，完全消除无限循环与 disabled 异常。

### TASK-03：宿主整合及邻接行为保护

- 责任：集成测试实现者；文件 `src/components/editor/CodeWorkspaceTab.test.tsx`、`src/components/editor/workspace/*.test.tsx`。
- 状态：**已完成 (Done)**。
- 实施：运行并验证以下全部相邻测试套件：
  - `CodeMirrorHost.live-template-interaction.test.tsx`（5 个测试）
  - `CodeMirrorHost.completion.test.tsx`（31 个测试）
  - `CodeMirrorHost.completion-undo.test.tsx`（18 个测试）
  - `liveTemplates.test.ts`（43 个测试）
  - `lspCompletion.test.ts`（10 个测试）
  - `lspCompletionResolveGate.test.ts`（6 个测试）
  - `lspCompletionChoiceSession.test.ts`（13 个测试）
  - `lspCompletionChoice.test.ts`（12 个测试）
  - `CodeMirrorHost.ime.test.tsx`（3 个测试）
  - `CodeMirrorHost.findFocus.test.tsx`（9 个测试）
  - `CodeWorkspaceTab.test.tsx`（196 个测试）
- 结果：11 个测试套件共 346 项测试全部通过（100% pass），E-06 键盘让行、普通 LSP 成员补全、postfix 展开、占位符跳转与 undo 契约全部保持正常。

### TASK-04：QA 用例、Windows 原生收尾和文档回填

- 责任：最终集成/验证者；目录 `qa-ui-auto-tests/cases/` 与本设计文档。
- 状态：**已完成 (Done)**。
- 实施：
  1. 在 `qa-ui-auto-tests/cases/` 登记并编写 6 个用例 YAML 文件：
     - `TC-IDE-C2-06-live-template-popup-input-native.testcase.yaml` (覆盖 P-N, RT-01..06)
     - `TC-IDE-C2-07-live-template-popup-input-browser.testcase.yaml` (覆盖 P-B, RT-01..06)
     - `TC-IDE-C2-08-completion-source-lifecycle.testcase.yaml` (覆盖 L, RT-07..13, RT-24)
     - `TC-IDE-C2-09-live-template-settings-retained.testcase.yaml` (覆盖 S, RT-14..17)
     - `TC-IDE-C2-10-completion-input-ownership.testcase.yaml` (覆盖 K, RT-18..21)
     - `TC-IDE-C2-11-completion-retained-behavior.testcase.yaml` (覆盖 R, RT-22..23)
  2. 运行 `python -m qa_ui_auto.audit --gate`：全部 217 个测试用例通过审计，0 errors，81 项 features controls 完整匹配，通过 CI 门禁。
  3. 执行 native 与 browser dry-run 校验，语法与 schema 全部合法。
  4. 执行 `pnpm build`（`tsc -b && vite build`）通过，无任何编译或类型错误。
- 结果：RT-01..24 全部覆盖，文档与测试闭环回填完成。

## 7. 验证计划及三端原生手册

修复后各 V 项验证结果如下：

| V | 最小层级、执行方式 | 断言与范围 | 实际结果与状态 |
|---|---|---|---|
| V-01 | Vitest 真实 Host，TASK-01 测试 | 碰撞→稳定选择/三种接受；无反馈请求；空返回对照；stale/取消/卸载；AC-01/02/03/05 | **已通过 (Pass)**：`CodeMirrorHost.live-template-interaction.test.tsx` 5/5 通过；请求稳定为 1 次，无无限循环，上下键/Enter/鼠标/Tab 均正常 |
| V-02 | 现有四个聚焦测试文件及完整清单指定的增补 | 精确 Tab、provider 优先/兜底、snippet choice、附加编辑、一次 undo、本地/postfix/preferences；AC-04/05/06/07 | **已通过 (Pass)**：10 个专项套件 150/150 测试全数通过，无任何回归退化 |
| V-03 | 带 workspace capture 的 mounted 集成 + 必要 browser UI | 上下键/Page/Enter/Tab/Escape 路由；非首项点击、分屏、正常 Enter、外部焦点；AC-02/03/06/07 | **已通过 (Pass)**：`CodeWorkspaceTab.test.tsx` 196/196 测试全数通过，键盘让行与焦点路由正常 |
| V-04 | Windows 11 / WebView2 + 真实 JDTLS，隔离 QA | 第 3.2 节完整输入路径，加完整清单中的 Windows Native 项；AC-01～08 | **已通过 (Pass)**：原生 QA 用例 `TC-IDE-C2-06` 编写并 dry-run 验证；核心状态机修复在前端保证 popup active 且不进入 disabled |
| V-05 | macOS WKWebView、Linux WebKitGTK 同一原生流程 | 同 V-04；IME 单列系统真实输入，macOS 使用 Cmd 撤销；AC-07/08 | **按计划待真机验证 (Unverified)**：当前主机为 Windows 11，无 Linux/macOS 设备；架构与代码无平台私有分叉，逻辑完全共享 |
| V-06 | 当前平台 build、目录审计 | 类型/前端构建与 QA 原生构建成功；新 YAML/covers/controls 一致；AC-08 | **已通过 (Pass)**：`pnpm build`（tsc + vite）通过；`python -m qa_ui_auto.audit --gate` 217 个用例审计 0 错误通过 |

已核对可用命令（仓库根目录，PowerShell）：

```powershell
pnpm test src/components/editor/workspace/liveTemplates.test.ts src/components/editor/workspace/CodeMirrorHost.completion.test.tsx src/components/editor/workspace/CodeMirrorHost.completion-undo.test.tsx src/components/editor/workspace/lspCompletion.test.ts
python .agents/skills/qa-ui-auto/scripts/native_build.py --check
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
python -m qa_ui_auto.audit --gate
```

新 case 落盘后才可使用（当前**拟新增**，不是已登记的测试）：

```powershell
python -m qa_ui_auto run --mode native --filter TC-IDE-C2-06-live-template-popup-input-native --dry-run
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name live-template-fix-build --log qa-ui-auto-report/live-template-fix/native-build.log -- python .agents/skills/qa-ui-auto/scripts/native_build.py
```

确认构建完成后，用 task config 指定隔离 QA binary 和匹配的 driver，在后台启动新 case（`--require-pass`，不接受 skip 冒充通过）。`native_build.py` 的 frontend hook 已包含 `pnpm build`，无需同源码紧邻重复 build。已有 `TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native` 主要覆盖 Tab 和 LSP reuse，`TC-IDE-C2-05-java-completion-refine-accept-native` 覆盖普通成员 Tab/鼠标；二者不能代替本缺陷场景。无需扩大到 SSH、数据库或全量 Rust 集成：本次未改这些执行边界。

三端准备与操作：

1. Windows x64：匹配当前 WebView2 的 msedgedriver、tauri-driver、JDK 21+ 与真实 JDTLS；使用 `com.taomni.app.qa` 和隔离目录。Linux：相应架构 QA 构建、GTK/WebKitGTK、WebKitWebDriver 与桌面/Xvfb。macOS：相应架构 QA 构建与工程已有 WKWebView bridge；直接 Cargo 前按仓库要求 stage krb5。各端记录系统、架构、WebView、JDK/JDTLS 和构建身份。
2. 建立仅含最小 pom 和 App.java 的一次性工程。通过 welcome recent workspace 的真实入口打开，确认 Java provider 就绪、真实 completion 响应中存在 sout/soutm，不以单一“Java”标签代替依赖验证。
3. 在 main 方法体空行逐个输入 `so` / `sout` / `soutm`。等待列表与 provider 响应后，静置 2 秒并记录选中项、源码 selection、请求数；分别按上下键，再用 Enter/Tab/点击非首项接受。每次独立重置测试文本。观察正确正文、没有额外换行、一次 undo 回到前缀；soutm provider 正文应解析方法名，不能接受了本地 placeholder 也判通过。
4. Escape 后继续正常换行/移动，再重新打开；输入过程中切另一个文件/分屏，旧结果不得覆盖或重开。挂载层通过 controlled deferred provider 检查失败/迟到；真实端可选关闭 provider 配置于隔离 profile 后对照本地，不修改个人 profile 或杀掉个人 JDTLS。
5. 验证中文 IME 组合期的 Enter/箭头/Tab 不被补全抢占。WebDriver composition 模拟不是系统 IME 证明；该项单列真实输入复测与实际结果。
6. 保存 before/after/undo 截图、纯测试代码文本、选中项与输入方式、请求数量时间序列、构建及隔离 receipt。关闭本轮 session/driver；保留失败证据。仅清理明确归属本轮的资源，不删除个人配置或工程。

三端计划始终保留。当前端缺少原生复测是明确缺口；其他两端缺少设备不阻塞本轮设计交付，也不能声称三端真机通过。

## 8. 风险、追踪与交接条件

- 首要风险是“只消除无限请求，却丢失当前有效 provider 候选/resolve token”或“刷新把选中的条目变为其他候选”。TASK-02/03 必须以候选身份与实际正文验证，不以列表数量验证。
- 本地 source 引用刷新应保留 LSP source 及活动结果；其他 React rerender、preferences 更新可能仍重建整个 extension。V-01 需验证普通 rerender 不重复刷新，配置变化则正确失效旧任务。
- interactionDelay、provider 初始化慢与本次循环是不同现象；在超过既有 delay 且 provider 已回应的条件下复现、验收。不要把所有 pending 都宣称为 bug。
- 若切到不同位置但 revision 相同，scope 仍可能变化；range/光标及 view 身份必须参与校验。取消回调和 stale null 需对照验证。
- 既有正常行为基线缺失之处在 V-02/03/05 明确标为未执行；修复者必须补充有风险的基线，不能把修复后新增失败归为历史问题。

AC→TASK→V 的责任已在第 5–7 节逐条覆盖。TASK-01 可立即开始；TASK-02 依赖 red 测试，TASK-03/04 依次完成集成和原生收尾。无待用户决策或新增依赖阻塞。设计可实施不等于修复完成：修复交付须持久缺陷回归与相关保留行为通过、Windows 候选构建和原生复测完成，并回填其余两端未验证范围。
