# 工作区文件打开与 SDK 后台初始化

当前状态：文件打开及标签切换卡顿仍未通过验收。最新托管相关集 [40840344631](https://github.com/engcapa/taomni/actions/runs/40840344631)（`9d70ce07`）共64次执行，55 passed / 9 failed、无跳过；适用的完整崩溃组通过。用户授权本机隔离 QA release 性能复现，已捕获真实 HOME 场景的窗口线程同步扫描造成4–6秒长帧。后台扫描修复后仍有冷打开长帧；当前继续减少全局样式重写及目录树渲染。参考 [Home 文件打开分析](../docs-issue/workspace-home-file-open-latency-design.md)，全量与正式四轮性能对照仍待执行。以下保留失败，关联[重构实现报告](./workspace-platform-redesign-implementation-report.md)。

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

新增 JSON 改前 run `40782708587` 已捕获冷打开的真实慢帧：Linux browser
214.6ms、macOS browser 157.8ms、macOS native 267ms。内容与高亮在 1500ms 内
出现，但不能据此忽略用户可感知的卡顿。为定位渲染/布局开销，Chromium 另保留
固定 1000µs 间隔的 CPU 采样，失败后也保存；采样不可用明确记录，不取代精确
文档、每帧预算、原生 I/O 和保存断言。改前/改后对照须使用相同观察工具。

用户另报告本机 QA release 首次打开约 600 多行 JSON 时有 2–3 秒阻塞。
新增 `TC-WS-064/065` 使用完全公开、无凭据的 704 行 JSON：64 在 browser/native
中保留冷打开、切回标签、Home 返回的精确文档与语法高亮首帧（1500ms），并对开始
至高亮后 1 秒的每一帧间隔限制 150ms；65 增加真实原生逐键输入（32 键、p95
150ms）、保存、关闭重开和磁盘 SHA。两者均断言不自动调用 SDK/LSP 探测。
先在 GitHub 对改前产品采样，再依据原始耗时定位；不把新增测试或工具单测通过
当作产品问题已经解决。本机不启动 browser/native 用例。

run `40773829621` 的 macOS `TC-WS-062` 已正确清空并输入完整源码；返回工作区为 1458.41ms，接着打开普通文件为 1579.30ms，失败截图已含正确 notes.txt。现有记录无法区分原生 WebDriver 准备/往返、真实文件读取与绘制，不将其归咎于产品或以重跑通过解释。补充 `sdk-action-trace.json`：原始 HTTP 方法/路径/耗时（不含 payload）、真实 pointer/click 时间、下一帧及 canonical/DOM 内容发表。原生转发观察器在独立 `fileReads` 中记录真实读文件 callback 时间，不改变 SDK/LSP counts、不读取源码响应。观察器退出时恢复原请求 owner、取消全部帧和监听器；既有动作、完整字符、1500/150ms 和五秒生产超时不变。

同 run 的 macOS `TC-WS-061` 五个动作及其真实 pending 检查均通过（打开普通文件 1339.67ms），失败发生于无新用户动作之间的第二次最终观察。现在直接保留最后动作结束后已验证的 pending 快照；启动握手成功后也复用同一快照，减少两个重复的 WebDriver 观察请求。没有删除任何交互后的校验；原始 5 秒失败仍保留。正式性能仍须匹配四轮实测。

## 原生文件读取不占用调用线程

四个读文件 IPC 原来使用同步 Tauri command，路径解析、磁盘读取、编码检测和
SHA 计算会在调用线程执行。现在由独立 async 适配器交给 blocking worker；慢文件
不串行阻塞其他读取。核心读取函数、IPC 名称/参数、内容/编码/BOM/hash/metadata、
大小限制、路径逃逸检查与错误保持原契约，后台失败明确返回错误。

这是执行线程调整，不新增用户操作。保留 `TC-WS-064/065` 的真实树打开、切换、
恢复、输入与磁盘 SHA，及既有 `TC-WS-040/042/043` 的文件浏览回归和
`TC-IDE-C0-01` 的编码/磁盘保存回归。
本机 4 项新增 worker 单测与 14 项既有编码/读写单测通过，包括持有慢读取时
调用 executor 与另一读取继续推进、UTF-16/BOM、错误与 worker panic。
CI 的 root Rust contract 同时执行这组测试。原生三平台与完整崩溃组仍须用包含
本次产品改动的 QA release 验证；不能据此认定渲染慢帧已解决。

## JSON 冷打开的渲染开销

同一改前源码的 Linux 定向 `40784926015` 为 16 passed / 2 failed，原始回执与
附件 SHA 已核验。JSON browser 的首帧为 197.8ms，内容首次出现前另有 251.3ms
慢帧；原生首帧为 191ms。CPU 原样采样显示同步 React 渲染/提交占用约 665.6ms，
其中 Lucide 的 `createElement` 调用约 114.6ms。采样与帧报告保留，不能将这些
数值外推为未插桩的生产耗时。

工作区常驻的树、面包屑、工具栏、编辑器和 dock 改用共享的 memo 图标组件：
buffer/selection 更新时复用 props 未变化的 SVG 子树，图标 props、主题 context
和 ref 仍按 React 语义更新。这不改变操作、可达性或工具内容挂载生命周期。
`TC-WS-064/065` 与完整崩溃组继续验证最终组合，正式性能比较仍待执行。

改前 JSON run `40782708587` 已收齐，49 passed / 8 failed，1,180 附件 SHA
核验一致；七项为真实慢帧，Windows 原生 65 的另一项发生于已完成输入、磁盘
SHA 和重开末尾文本之后：Mod+End 使首行离开 CodeMirror 虚拟视口，新用例却
要求首行 DOM 存在。现在只读实际文档首行，仍要求精确 `{`；不改变滚动、输入、
文件内容、预算或磁盘校验。所有原始失败继续保留。

## 用户文件的大小与长行负载

用户提供本机文件路径后，只读统计得到 196,289 bytes、693 行、最长行 5,148
字符、字符串最大长度 5,125，内容均为 ASCII。未将原文、字段名或字段值写入
测试与报告。此前 `TC-WS-064/065` 的公开 JSON 只有 19,362 字符，不能代表这项
长行负载，原用例继续保留。

新增 `TC-WS-066/067` 使用代码生成的公开数据：693 行、197,472 bytes、最长行
5,151 字符，40 条记录，字符串最大长度 5,125。66 在 browser/native 中验证冷开、
标签切回与 Home 恢复的精确内容和语法高亮，1500ms 打开及每帧 150ms 预算不变；
67 增加原生 32 键输入、完整保存 SHA、关闭重开与首行/末尾内容。普通文件的
SDK/LSP 自动探测必须保持为零。当前新增用例未完成托管执行，不能充当修复证据。

## 编辑器与目录排序的渲染边界

主布局会随编辑器 context 和命令注册发表刷新。为避免输入相同时重复遍历整个
编辑器，在平台 canvas、编辑器桥与公共 `CodeWorkspaceTab` 入口使用 React 默认
`memo` 边界；各组件自身的 store/context 订阅继续交付真实变化，没有自定义
比较器、延迟内容、改变挂载生命周期或取消资源。Project 树仅在目录条目、平铺
文件或排序偏好变化时重排，selection、caret、dirty 更新复用已有顺序。

本机对应真实编辑器生命周期、平台文件桥、Git 同步、Project 树及公共编辑器共
5 文件 / 288 tests passed（最多 2 workers）；TypeScript 与 refactor 合同通过。
这是待托管测量的产品优化，尚不能据单测声称减少慢帧。保留 `TC-WS-064` 至
`067` 和完整崩溃组，并将补充普通 txt/log/csv 冷开及连续标签切换的响应回归。

新增 `TC-WS-068/069`：68 从真实树冷开 txt/log/csv/未知扩展名的普通文本；69
在五个 txt/log/csv/JSON 标签之间连续切换十次，其中包含 193KiB 长行 JSON，
并保留未保存草稿，最后保存、关闭和重开精确内容。两者均覆盖 browser/native。
普通文本没有语法 token，显式使用 `require_highlight: false`；仍检查完整可见
canonical 文档、1500ms 内容预算和从真实操作至内容出现后 1 秒的每帧 150ms
预算。原 JSON 默认高亮断言完全保留。工具 13 项 Python 和 4 项 JS 合同通过，
覆盖纯文本未高亮、错误内容、慢帧、超时、清理与原始失败保留；目录 audit gate
及托管选择计划通过。新用例执行结果仍待 GitHub，不能作为通过证据。

普通文件基线 [40792477689](https://github.com/engcapa/taomni/actions/runs/40792477689)
已在 browser 复现：30 字符 notes.txt 冷开有 159ms 帧间隔，切至 51 字符
service.log 有 171ms 帧间隔；不是仅由大 JSON 触发的问题。新用例的原始失败
保留，native 仍在构建。

另修正主窗口的订阅范围：`useMainLayoutState` 仅订阅实际使用的字段，公共
session import/export hook 和 Welcome 只订阅其 `setStatusMessage` 方法。
此前后两者即使只取一个方法也订阅整个 app store，文件 context、诊断或状态
发表会连带刷新整个窗口。新增真实 MainLayout 回归在改前失败；三处订阅边界
修正后与既有窗口导航、终端保活、主菜单快捷键及 Home 回归共 80 tests passed。
context 和状态仍由原 owner 发表，原消费者继续收到更新，广播开关仍触发 shell
更新；没有调整持久化、快捷键或编辑器挂载生命周期。托管帧验证尚未完成。
状态条消费者与 session import/export 另有 55 tests passed，TypeScript 和
`pnpm check:refactor` 通过；本机只执行这些单测和静态检查。

同一公共路径还存在 `useWorkspaceTabs` 对完整平台工作区数组的订阅，尽管
关联 Git 清理只使用“仍打开的 code 编辑器实例 ID”。现在使用浅比较选择这些
ID，文件选择、目录和 buffer 信息变化由原消费者交付，编辑器关闭或导入实例
ID 变化仍立即清理失去 owner 的 Git 标签。新增隔离测试改前由一次 render
增至四次，改后与两条 Git 清理回归、真实 Git 集成及主布局回归共 67 tests
passed。本轮 `8d4fc91b` 托管验证仍捕获 browser 慢帧（JSON 152–163ms、普通
文件/标签 188–228ms）；订阅调整尚不能作为卡顿通过证据。

## 命令发布与最近记录隔离

`5d280fbf` 的 Linux 同工具验证 `40795232441` 已结束：21 passed / 10 failed，
20 个用例 ID（含完整 10 ID 崩溃组）与 711 个附件 SHA 独立核验一致。browser
冷开/切换慢帧 160–275ms；native 153–276ms。关闭 DOM 快照后仍有真实同步
React 耗时，因此不能将卡顿归因于录制或宣称前述优化已通过。

进一步去掉命令注册时的主窗口 React state 更新。实例命令和 shell shortcut
claims 仍同步写入注册表，快捷键读取原 ref；窗口菜单在打开时读取当前 owner，
macOS 原生菜单直接订阅注册表，隐藏实例发表不重装当前菜单，卸载释放订阅。
关闭的 owner 不再执行残留菜单操作。最近工作区记录移到 Home 内部订阅，仍
保持记录与恢复逻辑，打开文件不再因此刷新所有窗口后代。

两条隔离回归在改前分别捕获命令发布 render 1→2、最近记录主窗口 render 3→4。
修正后主布局、Home 最近记录、主菜单、快捷键桥、编辑器上下文桥共 6 文件 /
95 tests passed；TypeScript 与 refactor 合同通过。这是纯更新边界重构，没有新增
用户流程；保留 `TC-WS-064` 至 `069`、Home 路由 `TC-WS-025/026`、
`TC-IDE-C4-02-split-and-structured-reopen` 与完整崩溃组作为托管行为门禁。
新的帧测量及三平台结果尚未收齐，当前仍未验收。

## 文件激活的协调与定义更新

新增回归在修改前复现三种多余渲染：同目录的 active-file 发布仍重建
`rootFolders`；文件请求完成标记使编辑器额外 render 1→2；仅更新历史 caret、
前进/后退可用性未变仍 render 4→5。文件协调的单测还发现读取旧 React
snapshot 会将已激活的 b.html 发布为 a.txt。

`useWorkspaceCodeDefinition` 拥有平台输入与编辑器输出的适配、最近记录和
持久化；通过发布对象的精确身份识别自身反射，不把保存的 active file 再当成
一次新输入。外部打开请求、新 root、loose files 和恢复身份继续传给编辑器。
平台定义动作提取到 `workspacePlatformCodeActions`，未改变根目录时复用原
列表，仍即时保存当前文件和原有存储格式。没有暂停或延迟用户选择。

`useWorkspaceHostFiles` 用 ref 记录内部协调状态，队列完成后直接从同一
buffer owner 的最新状态发布结果并协调 canvas，不额外刷新整个编辑器。
保留串行队列、迟到请求取消、pending-close、dirty 恢复和 provider 同步；
canvas 仍在真实文件就绪后执行，并保留独立 editor split。导航历史仅在按钮
可用性改变时刷新 React，caret/history 本身仍同步更新。

本机 8 文件 / 56 tests passed，包含真实 CodeMirror 的 dirty/save/undo、
split/grid/single、关闭后重开、外部定义和快速 supersede。新增
`TC-WS-070` 覆盖五行 HTML、704 行文本、小文本的三次冷开和六次标签激活；
HTML 保留高亮、正文精确相等、零自动 SDK/LSP、1500ms 内容和每帧150ms
断言。064–069、025/026、C4-02 与完整 10 ID 崩溃组继续保留。此处只记录
实现和单测结果，托管帧验证及原生 release 仍待新一轮执行。

## 激活时的同步持久化与辅助更新

`33313e03` 的 Linux 托管运行
[40802285035](https://github.com/engcapa/taomni/actions/runs/40802285035)
已完成并独立核验：25 个适用 ID、38 次执行，28 passed / 10 failed；801 个
附件 SHA 与 aggregate 一致，无基础设施错误。完整 10 ID 崩溃专项在 browser
和 native 均通过，但文件激活的性能尚未通过。browser HTML 正文 401.1ms、
最大帧 241.5ms；native HTML 最大帧 178ms。native 普通文本四种冷开和连续
十二次标签激活通过，不代表其他文件或用户本机已经达标。保留全部失败证据。

继续去掉公共激活路径中的重复工作：干净文件的加载、关闭和重复 publication
不重写 dirty 恢复日志；真实编辑、保存、关闭 dirty 文件仍同步更新恢复内容，
写入失败仍在下次 publication 重试。同一树节点重复 click/double-click、同一
canvas 重复聚焦不再写 store 或平台持久化。

编辑器 command port 的 owner 注册和命令执行仍即时完成，菜单 projection、
selection revision 和已捕获 caret/fold/scroll 的持久化通知使用 transition。
命令 dispatch 从实时 store 和 port 读取上下文，避免辅助 UI 尚未 render 时
使用旧文件、选区、只读或 composition 标志。布局退出保存仍直接读取原 ref。
新增改前失败的去重、恢复写入和实时 owner 回归；连同真实 CodeMirror 的
dirty/save/undo、split/grid/single、StrictMode、恢复和 pending save，共
8 文件 / 126 tests passed（本机最多 2 workers）。

生命周期测试的命令发布改为按 runtime ID 保存，匹配生产主窗口；此前隐藏
空 workspace 的晚发布会覆盖测试单个全局变量，现按真实活动 workspace
选择命令，保留所有实际编辑、撤销与保存断言。`TC-WS-070` 保留三次冷开、
六次切换，增加重复点击当前标签和正文聚焦，共 11 次激活测量。正文、HTML
高亮、零自动 SDK/LSP、1500ms 内容和每帧 150ms 预算未放宽。当前实现的
GitHub 性能与完整崩溃回归仍待执行，不能据单测宣称速度达标。


## Home 文件监听与增量目录刷新

`7724ce43` 的 Linux 托管运行
[40805896015](https://github.com/engcapa/taomni/actions/runs/40805896015)
已结束：38 次执行中 31 passed / 7 failed，无基础设施错误；完整崩溃组通过。
失败仍是文件打开/激活长帧（154–199ms），不是性能验收通过证据。

参考 `docs-issue/workspace-home-file-open-latency-design.md`，先处理 P0 监听边界：
OS watcher 注册移入 blocking worker，Home 根只监听直接子项，已展开目录和
已打开文件补充按需监听。普通项目保留递归语义，显式打开的缓存目录/文件仍
可操作。应用自身存储路径在进入异步队列前过滤，显式打开一个内部文件不会
放开其它内部写入。取消 token 和任务身份保护启动/停止重叠时的归属。

外部事件按 200ms 批次刷新已加载的受影响父目录，不 reset 全树；保留其它
目录的列表与行。平铺索引仅在当前显示/过滤需要时更新，迟到响应不能覆盖
新一轮列表。Project 树只接收 dirty 提示，正文和加载变化不重建该输入。
移除初始文档构造中多余的空扩展 EditorState 初始化。

新增 native `TC-WS-071` 将真实 runner Home 与公开的报告目录同时加入，
用真实 host 新建、修改、删除及重建文件，核验树、buffer 与未受影响目录，
通过转发观察器断言没有递归扫描或全树重刷。这个用例负责磁盘/监听契约；
064–070 的真实打开帧预算继续独立保留，完整崩溃组仍是门禁。
本机不执行 browser/native 用例；执行 focused Vitest、真实 notify Rust 测试、
工具单测、TypeScript 与 refactor 合同。EditorView 复用及最终性能验收尚未完成。

## 常驻编辑器、文件状态缓存与读取就绪提交

Home 监听版本 [40811827670](https://github.com/engcapa/taomni/actions/runs/40811827670)
实际执行 35 次，26 passed / 9 failed；无基础设施错误，完整崩溃组通过，真实
Home 外部文件增删改与增量树刷新 `TC-WS-071` 通过。browser 的冷开长行 JSON
仍有 347ms 慢帧；native 首次打开 JSON、HTML、普通文本仍有 163–216ms 慢帧。
保留原始报告，这说明仅修监听没有解决文件打开的固有开销。

按分析 P1 移除普通文件的动态 host key，每个 pane 复用同一 EditorView。
新增独立 `editorStateCache`，最多缓存 24 个文件及 800 万字符；关闭文件、改变
文档路径、切换 workspace/transaction owner、卸载 pane 时释放对应状态。
回切保留选区、折叠、滚动与独立撤销，canonical 文档和共享 history 的所有权
保持不变；用当前只读、换行、字体、诊断、调试等配置重新绑定扩展。相同正文
复用已有 CodeMirror Text，避免回切重新构造全文树。

文档激活结束会释放原 view lease、监听、composition、clipboard generation、
补全和 snippet 请求；旧语义选区 promise、被拒事务 microtask、参数提示清理
均不能修改新文件。最终卸载才销毁实际 EditorView。慢读取显示只读加载遮罩，
保留编辑器实例；读取就绪解除只读并显示正文。

读取请求直接开始，80ms 内返回则先发布 ready buffer 再激活标签，避免
loading→卸载→重建的中间态。超过 80ms 才发布加载状态。较早请求的迟到
结果可以补齐后台标签，但不能夺走后续用户选择。关闭后立即重开仍即时认领
标签，再等待旧清理结束，以免 cleanup 删除已经恢复的 canonical buffer；
LSP 重开继续在后台进行。现有 workspace 测试捕获该竞态后已修复。

本机执行主 workspace 全部 254 条、真实 CodeMirror/IME、快速/慢速读取、
关闭重开、缓存边界与当前设置等 focused 单测；新增实际 View 身份和跨文件
状态回归（6 条），工具 Python 14 条、JS probe 5 条通过。TypeScript、refactor
合同和 catalog gate 通过；本机不跑 browser/native。`TC-WS-070` 在首次打开
之后的十次操作额外断言真实 EditorView 未被替换，正文、高亮、零自动 SDK/LSP、
1500ms 内容及每帧 150ms 门槛均未放宽。保留 `TC-WS-025/026`、064–071，
增加 split/history、跨 pane clipboard、原生 view-state 恢复及关闭重开既有
用例，与完整崩溃组共同在 GitHub 执行；托管性能结果尚待新版本验证。

复查补充：CodeMirror 的 root reconfigure 会保留已有 compartment overrides，
单靠重新传入扩展不能保证缓存文件收到新字体、只读、换行等配置。另一个边界
是旧只读 filter 会拒绝外部 canonical 正文更新。新增两条单测在修前分别捕获
tabSize 仍为 4（期望 8）与正文仍为旧磁盘快照；现在同时重配各 compartment，
并沿用已有 remote transaction 标记同步 canonical 内容。7 条真实 View 回归
包含在另一文件中修改全局外观后回切；CodeMirror/IME/cache 4 文件 88 tests
passed。前一提交用 Node.js 22、2 workers 执行的相关 10 文件 375 tests passed。
`TC-WS-034` 增加先切至普通文本再修改 Settings、回切 README 的字体/主题及
独立撤销断言，覆盖缓存文件的全局外观同步。

## 隐藏工具窗口的构造边界与 Home 历史更新

常驻 View 首轮 [40815182933](https://github.com/engcapa/taomni/actions/runs/40815182933)
执行 39 次，28 passed / 11 failed；完整崩溃组、原生视图状态、拆屏关闭重开和
Home 真实监听通过。native 连续回切与保存重开正文为 57–92ms，但首次打开仍
有 151–231ms 慢帧。设置缓存补修轮
[40816522359](https://github.com/engcapa/taomni/actions/runs/40816522359)
执行 40 次，29 passed / 11 failed。browser 使用单 worker 后首次打开仍有
289–318ms 慢帧，native 为 182–229ms；native 连续切换 48–75ms。两轮均保留
原始失败，不能据此宣称性能达标。后者另有 `TC-WS-034` fixture 选错目录：
该浏览器路径实际有 README.txt，没有 Documents，现改用真实存在的文本文件，
保留字体、主题、dirty 与单字符 undo 断言。

CPU 采样仍显示隐藏工具的 JSX 构造、portal 包装和隐藏 Home 最近记录参与
文件激活。原 KeepAlive 已冻结面板组件，但其父 factory 仍预先构造全部工具
内容。现在将内容构造传入 KeepAlive 内部；隐藏 portal 同样跳过父更新，显示
时使用最新回调和配置。所有工具仍在初始挂载时创建，保留后台 Run/Terminal
句柄、订阅和任务生命周期。工具图标使用固定元素，减少 stripe 的 SVG 重建。
Home 隐藏时冻结 props 并暂停最近 workspace 订阅，返回时同步当前记录，
搜索、所选历史分区和滚动仍由原组件保存。

新增 mounted 回归核验后台句柄、draft、移动 portal、实际卸载、重新显示的
最新回调与 Home 搜索/历史；连同完整 workspace 单测共 7 文件 305 tests
passed（Node 22、最多 2 workers）。`TC-WS-025` 增加隐藏 Home 后保留搜索与
历史分区再进入 workspace 的实际流程。保留并选择 064–071 性能、034 外观、
010/024 工具条、弹层、终端移动原生回归与完整 crash-regression；正文、高亮、
每帧 150ms、1500ms 就绪预算及真实 View 身份不变。本机未运行 browser/native，
本轮托管结果待收集；最终 main 对比和全量门禁仍未完成。

## 面包屑、关闭弹窗与最近记录的订阅边界

`1d63c01b` 的托管运行
[40819080806](https://github.com/engcapa/taomni/actions/runs/40819080806)
browser 实际执行 22 次，17 passed / 5 failed。034 外观、069 连续切换与崩溃
browser 组通过；064/066/068/070 首次打开仍有 251–291ms 长帧。025 在往返
默认和自定义工作区后有两个常驻编辑器，其新增步骤选中了隐藏实例；现在只在
该等待中增加 `:visible`，不改变任何正文、路由、状态保持或错误断言。
native 实际执行 25 次，19 passed / 6 failed；合计 47 次，36 passed / 11 failed。
064 JSON、068 普通文件、069 连续切换通过，但 065/067/066/070 仍有
152–232ms 长帧。另外 007 分屏光标恢复和 024-03 终端移动存在功能失败，
需修复后重新验证，本轮不能宣称性能验收完成。

新的采样显示，隐藏 Home 的子面板直接订阅整个 App store，可以绕过父组件的
memo。最近会话同时订阅整个 Session store。新增 mounted 回归在改前捕获了
一次无关状态发布导致 21 次翻译调用；现在分别选择所需 action 与 session/group
数据，无关文件/状态更新不再重绘历史面板，分组变化仍正常更新。

面包屑路径/图标提取为 memoized `BreadcrumbTrail`，事件通过现有 latest handler
机制读取当前回调；弹窗的 actions getter、请求 generation、清理和键盘导航仍由
原 Breadcrumbs 管理。关闭的导航弹窗保留 owner，但跳过无关正文/光标发布；
每次打开和关闭都渲染，保证异步取消、当前数据、回调以及焦点返回。工具条按钮
同样按实际显示字段 memo，点击、双击及右键都使用当前 handler 和 item。

此轮是保持交互的内部渲染优化，沿用真实耗时用例 064–071，不新增同义 YAML；
回归增加选择 `TC-IDE-NAV-01`、`TC-IDE-PARITY-014-01` 以覆盖面包屑导航、
Structure/Search Everywhere/Recent Files 的关闭再打开，并保留工具条 010/024、
Home 025/026、全局外观034和完整 crash-regression。单测新增旧/新回调、弹窗
焦点、状态订阅与当前按钮数据显示断言；本机只运行单测和静态检查，不运行
browser/native。持久化、后台发现和大型树的剩余方案仍需按实际证据推进，
不得用单测或较小文件行数替代最终同条件 native 性能对比。

本机最终组合回归：14 文件 357 tests passed（Node.js 22、最多 2 workers）；
TypeScript、`pnpm check:refactor`、catalog gate、selected CI plan 全部通过。
新增用例的改前失败和全部修后日志保存在 `qa-ui-auto-report/_local/`，不作为
browser/native 的执行证据；新 SHA 的托管运行仍待执行。

## 慢读取视图恢复与终端移动的竞态回归

托管运行 40819080806 中，007 恢复两个活动文件共耗时 665ms，超过读取占位的
80ms 阈值。常驻编辑器在空占位文档上提前消费了光标/折叠快照，真实正文到达
后仅同步内容，没有重新恢复光标。新增真实 mounted 回归在改前复现光标落在
offset 0，以及 beforeunload 把空文档快照写回的问题。

现在由独立的 `editorViewStateLifecycle` 管理每次文件激活的恢复、延时捕获、
退出捕获与清理；`documentReady` 显式标识正文是否可用。待正文 reconciliation
完成后才消费一次快照，占位文档不能写回持久化或进入 EditorState 缓存。
分屏各自恢复、已有用户操作取消恢复、内容身份不符拒绝恢复、关闭重开、撤销
和延迟滚动语义保持。007 原生用例额外断言在另一分屏编辑后返回主分屏，41行
光标与折叠仍保留，并检查运行时错误。

024-03 的失败证据显示终端已经移回底部、命令有回显，但独立结果行缺失；
移动后 100ms 才执行的尺寸同步会与新输入竞争。将 ResizeObserver 的延时防抖
改为下一帧同步最新几何，连续通知每帧合并一次，销毁取消待处理帧。mounted
回归改前无法在下一帧得到正确 PTY 尺寸，修后通过；真实输出是否修复仍以
托管 024-03 原有的三次独立输出断言为准，不添加输出重试、不删除或放宽断言。
该调度属于内部生命周期修复，复用 024-03、051/056 及现有终端 retained cases。

本机：编辑器/工作区 14 文件 404 tests passed；终端及工具窗口 6 文件 116
passed / 1 既有编译模式条件 skip（生产模式与 QA 镜像分支互斥），最多 2 workers。
本机未执行 browser/native。1500ms 正文/高亮及全观察期每帧150ms预算保持。
下一轮托管覆盖 064–071、007/024-03 等功能与完整 crash-regression，结果待收集。

## 后台元数据持久化与外观读取缓存

托管运行 40823139637（`db4dff9e`）共执行49次：browser 20通过/4失败，
native 19通过/6失败，无跳过。007分屏恢复与024-03三次独立终端输出均通过，
本轮适用的完整崩溃回归通过。失败全部为首次打开的全观察期150ms帧预算：
browser 153.8–173.3ms，native 191–231ms；仍未达验收，不刷绿、不放宽预算。

CPU采样与源码继续发现激活调用栈上的同步存储，以及外观初始值在每次渲染
重复读取/规范化。真实store单测复现一组文件操作5次同步写入；mounted外观
单测复现3次切换6次存储读取。元数据现合并为最多300ms一次后台序列化写入，
beforeunload/pagehide立即保存最新tab、目录和活动项。显式reload取消旧队列；
落盘前检查上次读取后的外部替换，避免退出旧窗口时覆盖较新的导入/窗口数据。
未保存正文的恢复日志继续同步，错误/重试行为保持。外观初始读取按workspace
身份缓存，全局设置订阅及跨工作区读取仍生效。

新增TC-WS-072 browser/native用例覆盖混合文件/终端、关闭移除、激活后立即
reload及末次dirty正文恢复；不增加持久化等待或写入store/storage来制造结果。
现有029/030混合恢复、034全局外观、054 release冷启动等继续保护保留行为。
本机8文件58 tests passed、TypeScript及refactor通过，最多2 workers；
不在本机执行browser/native。托管新SHA性能及生命周期验证待执行。

## HOME 本机原生根因与专项回归（2026-10-29）

用户授权本机专项性能复现，其余 browser/native 回归继续在 GitHub 执行。
使用隔离 QA release、独立 data/config/cache，在真实 HOME 下创建公开临时
文档目录；不读取用户提供的 credentials.json 正文，不修改生产配置或进程。
三次基线 notes.txt（30字符、3行）分别记录5970、4335、5042ms最长帧。
4335ms样本中七次 storage.setItem 均为0ms，不能把这次秒级停顿归因于存储。

保留的原生栈 `qa-ui-auto-report/_local/workspace-profiler-baseline/`
`combined-native-stack-02.txt` 及04/06/08显示，Tauri窗口线程从
`Webview::on_message` 同步进入 `workspace_execution_model`、
`detect_execution_model`、`ignore::Walk`，递归读取HOME里的gitignore等元数据。
同期WebProcess主线程空闲、帧回调暂停；JSC样本中的较短布局开销不能解释
整个5秒停顿。临时CSS containment试验也没有消除此停顿，未进入产品。

修复把整个执行模型发现（含root规范化）放到 `spawn_blocking`，保留命令名、
输入输出、provider、失败传播。普通文件夹中的txt/html/json/md不自动递归
发现Build/Run；源码、构建描述符和已识别项目里的文档保留自动发现，显式
Build/Run入口保持完整能力。项目识别按活动文件所属descriptor限定，跨root
不误启；切文件取消后拒绝迟到结果，Java fallback保持。

同时隔离文件树工具栏的无关渲染，文件激活同一调用栈通知平台host；普通文件
只做root级项目描述符发现，源码或显式刷新才递归。Git快照全局并发最多2、
失败释放队列，并复用目录变更计数索引。尚未实现树虚拟化及按活动文件祖先
发现HOME Git根，不把它们写成已完成。

新增TC-WS-073（browser/native）保护300文档/100目录的cold/warm/dirty路径；
074（native/release）使用真实HOME和公开文档；075（native/release）打开公开
Python源码，断言真实execution-model请求仍发生、切回文档和warm tab仍响应。
073/074额外断言零自动execution-model/递归描述符/SDK/LSP探测；075保留真实
异步模型成功或错误结果，不通过stub制造性能证据。所有路径继续执行精确
正文、高亮、EditorView复用及1500ms正文/150ms全观察期帧预算。

测量起点从dblclick前移到最早pointerdown/mousedown，保留triggerEvent、
每个原始帧及临时存储写入耗时（只记录key/长度，不保存value），结束恢复
原有方法和监听。原生观察器转发并计数execution-model请求，单测验证真实
结果/错误和callback生命周期，同时不记录HOME路径、参数及模型内容。

本机支持性验证：执行目标/编辑器/Build/Run 5文件292 tests passed；
Python probe与HOME fixture安全合同17 passed，Node原生观察器/probe合同
13 passed。TypeScript、Rust formatting、refactor gate、catalog gate通过。
073/074/075的dry-run准确选择三条，仅证明语法，尚不算实际通过。
TC-WS-030只对旧同步metadata落盘假设增加有界1秒poll；072立即reload仍无
新增等待。匹配修复源码的QA release性能实测与托管相关集结果待补。

### 本机候选的剩余长帧

首次候选实测 `run-20261029-152439-224934258` 为0 passed / 3 failed。
窗口无系统焦点，RAF稳定约1秒；075还因host_write_file正确拒绝report范围外
写入而失败。075公开源码改由HOME fixture创建，保留其严格所有权清理规则；
未放宽host_write_file权限。下载并在repo临时目录解包xdotool/Xvfb，无需sudo。
随后使用独立Xvfb显示与隔离窗口管理器，不影响生产桌面。

`run-20261029-153134-606587301` 精确执行三条，仍0 passed / 3 failed，
无skip：073普通大目录最长帧309ms，074真实HOME为229ms，075源码为247ms。
原始秒级阻塞在这些冷打开样本中未出现，但未执行到的warm/dirty路径不算通过。
不能据此宣称已达到响应预算，也不通过重跑筛掉失败。

原生JSC采样及转发DOM操作计时，把额外开销定位到首次EditorView插入后
`scrollDOM.scrollTop = 0` 强制的同步布局（89ms），另有焦点同步布局16ms。
临时size-containment对照无改善，没有进入产品。新建scroller原生位置就是0，
现跳过这次冗余写入；复用view时仍重置/恢复每个文件的横纵滚动，持久化
光标、折叠、慢读取恢复和用户输入取消恢复逻辑保留。

新增mounted测试先复现冷创建多余scroll写入，再验证同一EditorView切到新文档
归零、返回缓存文档恢复240/32位置。改前1 failed / 7 passed；修后连同真实
编辑器、慢读取恢复与缓存4文件89 passed，TypeScript通过。新release正在
编译，真实性能收益尚待测量；所有诊断注入报告只作定位证据，不作验收。

`run-20261029-155826-869721899`（去掉冷创建scroll写入后的matching release）
为1 passed / 3 failed、无skip：076真实Node项目从notes.txt自动发现并实际执行
脚本通过；073/074/075仍分别有298/277/240ms长帧。冗余scroll修复没有消除
整体冷打开布局成本，不能称作验收通过。额外诊断继续执行全部观察点并在
末尾强制保留失败判定，显示074的warm切换127–150ms，HTML冷开219ms，
JSON冷开245ms；最长帧152/197ms仍失败。上述仅用于定位，正式用例继续
在首次预算失败时失败，没有删除原始样本或放宽预算。

新增TC-WS-076以公开、无依赖Node项目保护普通文档下的真实Run入口、
自动模型成功响应与独立终端输出；同时选取原Maven Run/Build/Tests原生
用例及多语言工具配置browser用例，保留功能回归边界。076的fixture、catalog、
policy、schema和依赖同步登记。正在推进新SHA托管相关集与完整崩溃组；
冷打开长帧仍在修复中，相关集通过前不合并main。

## 外观样式与大目录渲染（2026-10-29 本机 QA release）

`9d70ce07` 托管64次执行为 browser 25 passed / 5 failed，native 30 passed / 4 failed，原始1473个附件摘要及源码身份已核验。全部9个失败均为150ms帧预算：browser 064/066/068/070/073，native 065/067/073/075。真实 HOME 的074及项目普通文档运行076通过，完整适用崩溃组17次执行通过；这些结果不替代后续组合源码验收。

新增真实 Host 外观生命周期回归：相同设置切换文件、第二编辑器 pane 共享样式，以及移除样式表后重新附加。改前2 failed / 1 passed；外观扩展按所有设置值做有界缓存，style-mod 4.1.3 的 ESM/CJS 路径仅在 CSS 变化时写 textContent，保留顺序、nonce、脱离 DOM 后附加的逻辑。修正后连同文档切换与性能支持测试为21 passed。此处是消除重复样式写入，不能据单测声称性能通过。

同源码的本机标准 runner `workspace-local-appearance-candidate/run-20261029-163903-131038814` 为1 passed / 3 failed：073冷打开374ms、074为267ms、075为273ms长帧；076真实脚本运行通过。连续路径诊断 `workspace-local-appearance-pipeline/run-20261029-164329-996280186` 保留失败继续收样，最后主动使case失败：073切换最大帧95–117ms，074切换79–99ms；首次打开仍有351ms/265ms长帧。观察脚本只转发原调用，不延长或删除预算；这些诊断不能作为整条case通过证据。曾隐藏树的隔离实验没有读到最终文档，探针超时，不能据其数据宣称改善，保留在 `workspace-tree-isolation-diagnostic`。

当前将 Project 树拆为逻辑行及视口渲染，超过80行时只挂载可见行和上下各8行预取；采用已有排序、压缩链、分组、错误与 dirty/Git 标记，未改变文件扫描或文件操作。键盘顺序按全部逻辑行计算，Home/End/上下及父子导航保留。077同时覆盖 browser/native 的跨屏导航不激活、真实文件、搜索/清除、列表及反向排序；073/074/075保留150/1500ms预算。虚拟行由真实滚动揭示，滚动样本另存；读取文件的计时仍从最早 pointerdown/mousedown 开始。目录树、编辑器样式、全局字体主题及完整崩溃组需要本轮匹配release与托管重新验证。


目录虚拟化后的标准本机 run `workspace-local-virtual-candidate/run-20261029-171751-679135703`
为2 passed / 5 failed：073与076通过；065/067/074/075最长帧分别为152/162/151/228ms，
仍未达到150ms预算。077首先在驱动聚焦不可聚焦的滚动容器时失败，按键入口改为已有可聚焦的
Project pane。后续真实按键已触达逻辑末行，但发现本机 WebKit 的
`Intl.Collator` 默认区域为 `en-US-u-va-posix`，即使指定 `sensitivity: "base"`，
也把大写文件名排到小写前。现在仅移除 POSIX 排序变体，保留自然语言与其他区域设置，
补充三种区域的混合大小写/数字顺序断言；原077的README/Draft10预期不放宽。

只转发DOM调用的诊断 `workspace-virtual-pipeline/run-20261029-172419-747904347`
保留全部超预算样本并在最终断言失败。073、074、075的已打开标签切换最大帧为
42–62ms；首次创建编辑器仍有154–195ms长帧。原生采样及转发栈表明首次focus包含
58–76ms同步布局。独立CSSOM插入实验没有改善（冷开仍178–234ms），未采用到产品。
这些是定位数据，不是整条用例通过，也不是正式main/candidate性能结论。

继续减少初始化的重复工作：EditorView在附加到真实host前完成插件、样式和属性构建；
空语言/签名提示不再重复reconfigure；补全初始配置记录实际安装的策略，避免随后立即再次
重建相同插件。Project虚拟行同时处理列表固定表头、容器内边距及从pane导航到行的焦点，
键盘回归改为挂载真实FileTreePane，077增加列表末行焦点及可见范围断言。
此组合正在重新编译匹配的QA release；其原生性能、077、全局字体主题和完整崩溃回归仍待验收。
