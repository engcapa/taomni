# Overview 模糊搜索与会话输出感知

## 1. 范围与基线

- 来源：2026-11-12 用户补充：各视图 overview 大预览支持模糊搜索；运行中 session 的输出实时反映并突出显示。
- 开始条件：issue #797 的三端 browser、native Terminal 61 步及完整 crash 回归已有通过证据，见 `../docs-issue/797-workspace-terminal-preserve-active-tab-design.md`。同步 Notes 的 Linux QA 多行输入准备修正独立补跑，不将其失败隐藏为通过。
- 分支：`feat/tab-overview-live-search`，基于 #797/Notes 修复分支；当前产品基线 `741dae97`（后续证据文档另提交）。
- 三平台：Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView。按用户要求本地仅单元测试与静态检查，browser/native 在 GitHub `qa-ui-auto-platforms` 执行。
- 状态：实现已完成、本地单测/静态检查通过；hosted browser/native 验收待执行。

## 2. 当前事实与边界

`src/components/tabbar/TabOverview.tsx` 是各视图共用大预览。Sessions 默认展示全局会话；Workspaces 默认当前工作区；Home/Tools 默认全部，支持切换当前/全部。当前每秒读取已注册终端最后 8 行，无搜索、无新输出标记。选择卡片复用原会话/文档、恢复所属视图并保留同模式侧栏偏好。

`terminalRegistry` 是 runtime Map，不应变成每输出一次即更新 React/Zustand 的全局 store。`useTerminalRegistry` 负责注册/清理并可访问 xterm；可选的 `onWriteParsed` 监听在 buffer 解析后通知，无需另开连接/PTY。xterm 文档确认该事件至多每帧一次，使用 disposable 清理。

既有 `editor/workspace/fuzzyMatch.ts` 支持前缀、首字母、包含和子序列，提取到 `src/lib/fuzzyMatch.ts` 并保留旧模块 export，复用既有排序契约，不增依赖。

## 3. 验收

| ID | 动作与必须结果 |
| --- | --- |
| AC-01 | 各入口打开现有 overview，初始聚焦搜索框；对名称、主机/路径、协议、所属工作区、当前可见摘要做不区分大小写的多词模糊匹配；清空还原原卡片集合/顺序 |
| AC-02 | 搜索无结果显示明确提示与可清空入口，不混淆无打开 tab；切换当前/全部沿用查询；Enter 激活首个匹配卡片，Escape 关闭并恢复调用方焦点，IME composition 不被抢占 |
| AC-03 | overview 打开期间真实终端产生新输出，解析后合并更新预览，正常事件路径约 100ms 批处理；保留 1s registry/legacy fallback，不为预览启动或重连 session |
| AC-04 | 近期文本变化的 session 卡片显示“有新输出”标记与对比边框，约 3～4s 无变化后消退；不因输出改变卡片顺序或抢焦点，当前 tab 选中态保持独立 |
| AC-05 | 搜索状态下输出仍更新，可匹配新增的可见摘要；关闭 overview 释放监听、批处理和 poll，不残留 UI 更新；跨工作区隔离、同一终端被替换/关闭时无旧回调污染 |
| AC-06 | 文件 dirty 摘要、Current/All 模式、卡片激活所属 view/workspace、同模式侧栏折叠偏好、快捷键/焦点恢复均保留；阅读预览无写盘、无 session 创建 |

## 4. 决策与实现

- DEC-01（用户已定）：沿用各视图现有大预览，增加搜索及实时输出感知；不新建 dashboard/视图，不改变网格主流程。小型控件/状态扩展，不进行布局原型重设计。
- DEC-02（agent 自决，低干扰默认）：以徽标、非动画边框/轻背景突出近期输出，不自动置顶或按每个输出重排。这样持续输出不会让鼠标/键盘目标跳动；后续如用户要求排序，可另扩展。
- DEC-03（agent 自决，复用/成本）：搜索复用现有 fuzzy scorer，保留旧 API；preview 订阅保持 optional，兼容旧 registrant，后备轮询保证注册迟到和非事件消费者。
- 不新增持久化字段、原生 IPC、权限、网络或下载；不索引完整历史输出、不保存命令/输出副本到磁盘。

### 状态与所有权

新增 `useTerminalPreviews` 仅在 overview 挂载时运行：按 tab ID 跟踪当前 registry entry、订阅清理、最后 8 行有界文本及最近变更时间。多次输出合并到一个 100ms 定时器，实际有文本变化才发布；无变化控制序列不触发徽标。1s tick 查找迟到注册、刷新 legacy entry 并消退标记。真实 PTY、连接、xterm、所有输出缓冲及退出行为仍归原 `TerminalPanel`；监听不能持有其生命周期。卸载清空所有 timer/listener，迟到回调检查 disposed。

`TerminalRegistryEntry.subscribeOutput?` 接受 listener 返回 unsubscribe；真实实现包装 `term.onWriteParsed`。旧 registrant 可不实现，调用侧兼容。监控关闭时不额外订阅、不保留每输出 React 更新。

搜索 query/all 为本次打开期间的本地状态，关闭后重置。匹配只读取卡片元数据与 bounded summary，多个词可命中不同字段；查询存在时按匹配分数稳定排序，无查询保持原顺序，活动徽标不参与排序。输入框 maxLength 限制失控长查询。i18n 新文案同时更新 en/zh-CN。

### 文件与任务

| TASK | 文件 | 内容/完成条件 |
| --- | --- | --- |
| TASK-01 | `src/lib/fuzzyMatch.ts`、旧 `editor/workspace/fuzzyMatch.ts`、`tabbar/overview/overviewModel.ts` 及 tests | 提取公用匹配、纯卡片筛选；旧 fuzzy tests + 新多字段/中文/空查询/无结果稳定序列通过 |
| TASK-02 | `terminalRegistry.ts`、`panel/useTerminalRegistry.ts`、`tabbar/overview/useTerminalPreviews.ts` 及 tests | typed 可选订阅、批处理/legacy/替换/清理；不新增 PTY/session 副作用 |
| TASK-03 | `TabOverview.tsx`、`platform.css`、en/zh-CN、`TabOverview.test.tsx` | 搜索与活动徽标接线、键盘/IME/focus、Current/All/原 owner/dirty 保留；新增文件均 <800 行 |
| TASK-04 | QA cases/catalog/policy/dependencies、本文 | browser 搜索主流程 + native 真实输出持续期间大预览更新/突出、清理与原 tab；完整 crash、相关 TC-WS-018/019/046；actual reports/screenshots 回填 |

## 5. 验证

改前本地：`TabOverview.test.tsx` + `usePlatformShortcuts.test.tsx`，2 文件 8/8 passed（`/tmp/taomni-overview-baseline-units.log`）。这是保留行为基线，不证明新功能。

| V | 对应 | 证明与计划 |
| --- | --- | --- |
| V-01 | AC-01/02 | 纯 fuzzy/model 单测、mounted 搜索/clear/no-match/跨 scope/Enter/IME；全精确结果集合 |
| V-02 | AC-03/04/05 | fake timer 与可控 registry output：同一帧多次合并、解析后文本、短期活动消退、替换与迟到注册、关闭零后续读/监听 |
| V-03 | AC-06 | 旧 overview/平台快捷键/编辑器 fuzzy 测试，确保激活不新建 session、dirty 与侧栏偏好保持 |
| V-04 | 全部 | 新 browser QA：Sessions/Workspaces/All 的模糊搜索、metadata/摘要、无结果、清空与进入正确内容；新 native QA：真实 PTY 后台输出经过 buffer 进入 overlay，并验证活动徽标/不重排/最终仍是原 PTY |
| V-05 | 集成 | `pnpm exec tsc -b`、`pnpm check:refactor`、QA audit/contract/selected plan；GitHub 三平台 browser/native release + 完整 crash 集合；截图审阅徽标和内容可读性 |

本地 Node 22 / pnpm 10；Vitest exact file filters，无 `--` passthrough。native 使用 GitHub 隔离 QA release 与 runner-local shell，Linux/WebKitGTK、Windows/WebView2、macOS 15 ARM64/WKWebView 各自留 summary/receipt/source/build identity。浏览器存根不代表 native PTY，macOS synthetic WebView 按键不代表 OS 物理快捷键/IME。现有 Ctrl/Cmd+Shift+E 入口不改，不改变 AppKit accelerator。

## 6. 交付与风险

验证候选稳定后一次合批 hosted，不每次样式调整本地构建。保留初次失败，按真实原因修正并重跑，不削弱输出锚定、身份与生命周期断言。主要风险为高频 PTY 输出拖慢 overview、已卸载订阅、旧 entry 回调、搜索框破坏焦点陷阱；以有界读取、批处理、identity guard、cleanup 与 mounted/native tests 保护。

## 7. 实施与当前证据

- 已实现 `TabOverview` 搜索/清空/count/no-match、Enter/IME/focus、静态新输出徽标；有界 preview observer 带 100ms batch、1s fallback、3s 活动过期与 registry identity guard；原 scorer 通过兼容 facade 复用。
- 新 `TC-WS-093`：58 步 browser，覆盖 Workspaces/Home/Tools 的 fuzzy 标题/路径/dirty 内容、跨 scope、clear/no-match、Enter、重开 query reset 与原文档内容。
- 新 `TC-WS-094`：51 步 native（首轮为 46 步，后补 latest-line viewport 断言），Sessions/Workspaces 的真实 Python producer 每秒输出，overlay 打开时检查新输出行/徽标/不重排/搜索焦点/消退、原 PTY 继续执行。
- 本地 exact Vitest 7 文件 37/37 passed（overview model/hook/UI、原 fuzzy/file search、registry、shortcut），`/tmp/taomni-overview-final-units.log`。相邻终端/viewport/toolbar 10 文件 147 passed / 1 existing skipped，`/tmp/taomni-overview-retained-units.log`。这两批有重叠，不相加虚报。
- QA schema/audit/reviewed contracts、`tsc -b`、`check:refactor` 已通过。拟合批 selected IDs：`TC-WS-093,TC-WS-094,TC-WS-018,TC-WS-019,TC-WS-046` + 完整 `crash-regression`，三平台 browser/native QA release；native readiness/output 原生证明不能从本地 mock 继承。
- 同步 Notes 修复最终 hosted `43270585278` 全绿：每平台 browser 10/10、native 11/11，无失败/skip/infrastructure，完整 crash 集合；不属于新 overview 功能通过证据。

当前 hosted [43278551836](https://github.com/engcapa/taomni/actions/runs/43278551836)，head `e64d5d23`（product `f6d3a453`），三平台 browser/native release，`shards=1`，selected 包含上述目标/保留 case 与完整 crash 集合。Linux browser raw summary 已核对：11/11 passed、0 skip、identity stable；TC-WS-093 全 58 步通过，实际截图搜索 `RDM` 匹配唯一 README.md 并显示 dirty 文本、结果 count（artifact `qa-linux-browser-0f159bc7d0d441dd9770977569ab251f`，本地 `/tmp/taomni-overview-ci-43278551836-linux-browser-rEfMjF`）。Windows browser 同样 11/11 passed、0 skip、identity stable，TC-WS-093 通过，artifact `qa-windows-browser-0f159bc7d0d441dd9770977569ab251f`。macOS browser job 在 runner acquisition 阶段被取消（`runner_name=""`、`steps=[]`；annotation 明确 macOS ARM64 capacity constraints / job not acquired），未执行不计为 pass/fail。Linux native raw summary 14/14 passed（含原生 IME case），macOS native 13/13 passed，0 skip、identity stable；TC-WS-094 首轮全 46 步 passed。macOS 实际截图的实时徽标/稳定次序正常，但长 command wrap 可将新输出裁在卡片底部：补 `OverviewSummary` 仅终端自动 scroll 到最新行，文件 preview 仍在开头；新增 viewport mounted test 通过，native case 补 R4/51 步。Windows native 首轮仍运行；viewport 跟进需三端补跑，不能继承旧候选的执行结果。不因局部通过宣称全部新功能完成。不合并 PR 或自动关闭 issue。
