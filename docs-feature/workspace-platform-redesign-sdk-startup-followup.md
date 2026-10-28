# 工作区文件打开与 SDK 后台初始化

当前状态：候选 `2ff025f4` 相关集 [40773829621](https://github.com/engcapa/taomni/actions/runs/40773829621) 已完成，123 passed / 2 failed，18/18 执行分片已收齐。三平台 browser 51/51、Linux native 25/25、Windows native 24/24 通过；macOS Java 完整编辑也通过。macOS TypeScript 错误 SDK 场景打开普通文件为 1579.30ms，超出原有 1500ms，另一个正常 SDK 场景在所有交互及其 pending 检查通过后的重复观察越过五秒，仍保留原失败。已独立核验原始回执、汇总和 2044 个发布附件 SHA。正在补只读诊断并重跑，不能称全量或正式性能对照已通过。关联[重构实现报告](./workspace-platform-redesign-implementation-report.md)。

## 目标与保留行为

- 空工作区、添加目录、浏览 txt/log/csv/json/Markdown 等普通文件时，不自动启动 SDK 注册表解析、版本探测或语言服务发现。用户主动打开 SDK 对话框和刷新仍可解析当前目录。
- 源码先读取、显示和编辑，SDK/语言服务在后台初始化。重开正在关闭的文件仍先等待原有资源清理，清理完成后不再等待 provider；保留最新 dirty buffer 和 didClose/didOpen 顺序。
- 每次成功添加目录都显示当前工作区的 Project 树并展开目标 root，包括第二个目录和重复选择已有目录。取消、被动导航和迟到的其他工作区操作保留当前侧栏偏好。
- 保留语言服务的文档队列、增量同步、诊断作用域、重启、Java bundles 配置、SDK 绑定、错误、手动刷新与 watcher 生命周期。不改变 IPC 名称、持久化格式、原有 5 秒 SDK 超时或缓存 TTL。

## 实现边界

`useWorkspaceServerDiscovery` 单独拥有自动发现、配置与迟到响应失效。产品 runtime 使用已有扩展名分类器，从真实打开的源码 buffer 推导需求；Project 树的历史 `languagePanelOpen` 开关不是语言服务需求。

`useWorkspaceSdkResolution` 按源码需求或显式对话框解析 SDK，以 root 定义而非临时数组引用识别变化，并拒绝取消、隐藏、卸载后的迟到结果。未检测时显示中性 SDK 状态；真实版本命令的 `installation.lastError` 可见。

后端 `sdk/resolution_cache` 合并同 root 的并发解析，不同 root 独立。注册表修订在解析期间变化时重新解析，错误和既有缓存时效保持原语义；取消会释放该 root 的等待锁。Weak owner 表不永久保留所有访问目录的锁。

`workspaceFolderReveal` 是明确成功操作的显示边界；平台 Add Folder 与旧编辑器 Add Root 均接入。回调保持稳定，避免通过命令注册引发重复渲染。Project 不因单纯切换文件、返回模式或恢复旧工作区而被强制展开。

40759974223 的 browser 失败揭示显示边界最初错误地使用标签命令路由 ID，实际编辑器 UI 使用持久化实例 ID。现通过 `workspaceEditorInstanceId` 复用真实 owner，保留导入工作区的既有实例 ID 和默认 `platform:` 格式；添加两个测试，直接读取传给生产编辑器的实例 ID，改前均失败、改后均通过。已有 TC-WS-060 的第二/第三 root、重复选择、取消与切换断言全部保留。

同轮 TC-WS-039 的原始几何记录中，Documentation 可见但宽度为 1px；随后的失败截图已恢复正常，符合旧 `useEffect` 再调度一帧恢复宽度的行为。提取 `useToolWindowPanelVisibility`，用户显示/隐藏操作在 layout effect 中同步真实 panel 尺寸；库内部 ResizeObserver 的延迟发布保持不变。CJS/ESM 真实组件新增连续三次显示/隐藏测试，改前均失败，修正后与原有隐藏恢复、observer 清理和嵌套分屏回归一并通过。不延长用例超时、不增加等待、不修改几何下限。

## 改前证据

产品 source `6294904349ed0130a2eeccbee4214e1f62d8b14523ec29657248581bbcb73b3c`：

- [40746813409](https://github.com/engcapa/taomni/actions/runs/40746813409)：17 passed / 5 failed。普通文件场景仍触发发现、第二 root 未显示 Project，SDK exit-1 的实际错误正文未显示。原始回执与汇总已独立核验。
- [40749400862](https://github.com/engcapa/taomni/actions/runs/40749400862)：16 passed / 1 failed。Java 打开 653.8ms；编辑 1540.9ms 超过既定 1500ms。同项目出现四个并发真实 SDK 版本进程。DOM 已含预期编辑内容，这不能单独证明数秒主线程冻结。
- [40743957940](https://github.com/engcapa/taomni/actions/runs/40743957940)：全量 2115 passed / 3 failed。macOS 慢 LSP 与 RDP 剪贴板为功能失败，不能套用性能例外；RDP 性能 p95 90.153292ms 超过 65ms，按用户授权单列。

## 验证

本机只运行单测与静态检查，没有运行 browser/native UI 用例，并发测试 worker 不超过 2。

- 相关 hook、SDK UI、文件操作、资源恢复及真实编辑器生命周期：7 文件 / 77 tests passed。
- 目录对话框、共享代码编辑器与侧栏：3 文件 / 16 tests passed。
- Rust SDK：37 passed，包含真实 SDK 子进程的并发合并、不同 root、迟到注册表更新、失败 TTL 重试、取消重试五项合同。
- SDK 原生观察工具：7 tests passed，拒绝把多个真实版本进程当成一次共享后台探测。
- TypeScript 与 refactor 合同通过；提取模块不超过 800 行，未改变公共命令、事件及 facade 导出。
- 托管失败后追加的实例 ID/绘制前布局修复：5 文件 / 35 tests passed，包括真实编辑器生命周期 10 项、真实 panel 库 CJS/ESM 14 项。新增测试已在修正前复现，原有几何与崩溃断言保持。

托管验收集合包括 `TC-WS-059` 至 `063`、`TC-WS-043`、文件打开/保存/恢复与 LSP 保留场景，以及完整 10 ID `crash-regression`。059 覆盖普通文件保存重开与显式 SDK 刷新；060 覆盖多 root、重复选择、取消及侧栏状态；061/062/063 使用真实待完成 SDK 子进程和真实转发 IPC，验证编辑、模式切换、普通文件打开、失败正文、迟到 LSP、dirty 内容及磁盘 SHA。打开、清空、切换保留 1500ms；逐键测量规则和原始失败见下。正式结果在当前源码的 GitHub 运行完成后填写，旧源码通过记录不替代本轮验收。

## 原生输入测量纠正（2026-10-29）

run `40759974223` Linux Java 整段填充耗时 1894.9ms，run `40762986849` 同路径 1542.4ms，旧 1500ms 整段断言均失败。驱动每字符有固定 20ms pause，前者完整输入约 1.265s；后者保留的 25 个 keydown → input 样本为 1–3ms。最后一次原始 input 曾显示两个右花括号，但两次最终失败 HTML 都是正确的 `public class Main { int value = 7; }`，这是 CodeMirror 接管前的 DOM 瞬态，不能据此声称产品破坏配对状态。真实生产 Host 的同步/迟到 controlled echo 两条组件回归均通过。

因此不把整段打字耗时当单次 UI 响应，也不把修正测量后的通过称为产品加速。现在保留完整原文、原来的逐字键盘输入和 20ms pause；每批最多八个真实 paced keys，保留 1500ms 请求预算；每个 keydown 到下一帧进一步限 150ms。每帧检查当时所有已观察键对应的 canonical document 前缀/caret，最终 DOM 与原文完全相等。总打字耗时、每批请求、每键原始事件/帧和 SDK 等待状态全部保留。每批及后续切换仍须发生在同一真实 SDK 子进程未完成、原有五秒超时之前。原失败报告保留，不重写为通过。

另发现 macOS 原生 `fill` 把 Ctrl+A 当全选，导致 `TC-WS-059` 将新文本接在旧文档后。原生 contenteditable 输入职责已提取到 `native_contenteditable.py`，改用平台 `Mod+A`（macOS Cmd+A）；不改产品快捷键、不用 JS setter、不中途修补文件文本。新增工具回归改前失败、改后通过，原用例的完整文本和磁盘哈希断言保留。

macOS 慢 LSP 诊断 run `40758688130` 已完成 17 passed / 0 failed，330 个发布附件 SHA 及回执已核验。真子进程采样确认 initialize 被持有后仍能打开普通文件、切换工作区并释放，随后出现 didOpen；该次只读诊断通过不能覆盖更早全量中的失败，最终候选仍需运行原用例。

## 逐字观察往返与 Backspace 修正

`40768691984` Linux Java 的 36 字符源文本在输入第 34 个字符后失败：完整逐字观察已耗时 4190.29ms，SDK 第一条 started 至最后 waiting 约 4982ms。34 个已记录键的 keydown → frame p95 为 37ms、max 为 81ms；失败仍保留，未输入的两个字符不算通过。每字符一次输入、一次帧读取和一次 IPC 读取造成约百次 WebDriver 往返，消耗真实子进程的五秒寿命。现在仅将相同 20ms paced input 合为每批最多八键，减少观察往返；36 字符、150ms 逐键帧上限、1500ms 每批请求上限、同一个真实子进程/IPC pending 和五秒生产超时全部保留。若多个键共享一帧，必须检查那一帧已观察到的完整前缀/caret，不丢弃任一键或慢帧。新增工具合同覆盖丢键/乱序、错误前缀、缺帧、慢帧、慢批次和 SDK 已结束。

同 run 的 macOS `TC-WS-062/063` 在清空时失败。原始 `editor-input-failure.json` 显示 Cmd+A 已正确选全文，但接下来的 W3C `U+E003` 被 QA 桥原样作为字符插入，最终 HTML 为一个私用区字符。这是自动化桥缺少 Backspace 解码。把既有键映射移到其键盘 owner 并补齐该项；真实 CodeMirror 的“选全文后删除”和“删除前一字符”组件测试在修复前均失败，修复后与既有表单、按钮默认行为共 15/15 组件测试通过。没有修改生产编辑器输入或采用 JS 文档 setter。

RDP 修复定向 run `40767562150` 已完成 21/21 passed（macOS browser 7、native 14），原始回执和 382 个发布附件 SHA 已独立核验，包含原 `TC-RDPJ-02`、新增同标记迟到发布、rich/files/policy 及完整适用崩溃组。该修复提交的证据不替代最终组合源码的三平台相关集和全量。

本轮工具合同 33/33 通过，TypeScript、Rust formatting、`pnpm check:refactor` 和 `audit --gate` 通过；本机没有运行 browser/native UI。新工具及 QA 桥组合仍需匹配源码的托管相关集、完整崩溃组、全量与正式性能对照。

## 剩余 macOS 响应时间诊断

run `40773829621` 的 macOS `TC-WS-062` 已正确清空并输入完整源码；返回工作区为 1458.41ms，接着打开普通文件为 1579.30ms，失败截图已含正确 notes.txt。现有记录无法区分原生 WebDriver 准备/往返、真实文件读取与绘制，不将其归咎于产品或以重跑通过解释。补充 `sdk-action-trace.json`：原始 HTTP 方法/路径/耗时（不含 payload）、真实 pointer/click 时间、下一帧及 canonical/DOM 内容发表。原生转发观察器在独立 `fileReads` 中记录真实读文件 callback 时间，不改变 SDK/LSP counts、不读取源码响应。观察器退出时恢复原请求 owner、取消全部帧和监听器；既有动作、完整字符、1500/150ms 和五秒生产超时不变。

同 run 的 macOS `TC-WS-061` 五个动作及其真实 pending 检查均通过（打开普通文件 1339.67ms），失败发生于无新用户动作之间的第二次最终观察。现在直接保留最后动作结束后已验证的 pending 快照；启动握手成功后也复用同一快照，减少两个重复的 WebDriver 观察请求。没有删除任何交互后的校验；原始 5 秒失败仍保留。正式性能仍须匹配四轮实测。
