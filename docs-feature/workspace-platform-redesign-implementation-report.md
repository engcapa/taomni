# Workspace-First & One-System 平台重构 · 实现与验证报告

> 当前验收尚未完成。最新工具栏实现已在本机观察到 51 条 browser 与 26 条适用 native 全部通过；机器重启后，本地 `qa-ui-auto-report` 目录下旧报告和临时工具已不在，尚未完成独立回执核验，因此这些结果不能作为现行可复核证据。正在重建隔离环境并补跑验收。旧提交的托管相关集 [40432446710](https://github.com/engcapa/taomni/actions/runs/40432446710) 为 2,076 次执行全部通过，但不包含最新工具栏调整。本轮相关集全部通过后仍须拉取合并 main、复测并执行整体用例；功能完成后再做正式性能对照，目前没有“性能无退化”的结论。外部 `clickhousecrud` 项目用例按用户认可的现有 policy 单独报告缺口。

> 关联设计：[workspace-platform-redesign-design.md](./workspace-platform-redesign-design.md)
> 关联原型：[workspace-platform-redesign-prototype.html](./workspace-platform-redesign-prototype.html)
> 关联用例规范：[workspace-platform-redesign-testcases.md](./workspace-platform-redesign-testcases.md)
> 分支：`docs/workspace-platform-redesign`

## 分类过滤与紧凑操作菜单（2026-10-27，验证中）

Sessions 的既有分类、目录与搜索过滤统一从漏斗按钮打开。Workspaces 新增同样的漏斗入口，分类包括文件/代码、SSH、数据库、SFTP、远程桌面、本地终端及其他，并与标题、路径、主机及用户搜索组合。过滤只改变标签导航，不关闭编辑器或连接；每个工作区独立记住当前过滤，新打开或从大预览激活的标签会正常显现。无匹配时保留当前运行内容并提供清除入口。编辑器原有 Find Action 快捷键继续保留。

广播、单屏/分屏/网格、底栏及活动会话的 SFTP、分离、RDP/VNC 控制统一放入最右侧操作菜单。上下文 action slot 关闭时保持挂载，避免改变活跃运行实例的生命周期。全局搜索、大预览和右侧栏控制保持直接可达。所有主视图移除标题栏语音；Chat 听写与 Settings 配置继续保留，既有语音安装、下载恢复、提供商、草稿、取消和原文撤销用例迁移到这些真实入口。共享 Chat 按钮同时遵循关闭 AI 的设置。

新增 browser `TC-WS-050` 覆盖分类/搜索组合、空结果、过滤清除、工作区隔离、鼠标/键盘选择、窄窗口及未保存草稿；新增 native `TC-WS-051` 检查真实文件读取、同一 PTY 在过滤前后的独立输出、分屏恢复及保存后的磁盘 SHA-256。58 条既有用例迁移菜单导航并同步其验证步骤编号，保留原有业务断言。54 项前端单测、3 项测试服务隔离契约和静态覆盖门禁通过；最终 E2E 回执仍在收集。

本机两个 browser worker 同时使用共享 VNC 测试服务时，后一个用例的 reset 会断开前一个用例，原始 RFB 日志已确认该原因。测试调度现在只对同一 VNC 服务加跨进程互斥，等待发生在用例计时前，并在整个用例和清理结束后释放；其他用例维持原有并发。进程崩溃由系统释放锁，失败结果及原有 deadline 保留。三平台 browser 的 VNC 分片同时执行该隔离契约，Windows/macOS 结果待本轮 hosted 运行确认。

已按 ZIP 成员大小与 CRC 完整核对解压副本，清理 581 个重复旧下载包，回收约 2.37 GiB；解压的成功、失败及签名回执全部保留，当前仍运行的托管任务目录未清理。

## 所有主视图统一顶部拖动（2026-10-27）

Home、Tools 的标题及空白原先没有拖动标记，Workspace 独立的窄拖动区又被主窗口顶部 6px 缩放层覆盖。现在共享 ControlBar 的非交互背景统一处理单击拖动、双击最大化；主窗口提供跨 Home、Sessions、Workspaces、Tools 的顶部 4px 拖动区，外侧 2px 与原有角落继续缩放。移除 Workspace 的重复覆盖层。按钮、SVG 图标所在按钮、链接、输入框、菜单、标签、可编辑文本、拖放目标和 React portal 不触发窗口拖动。

新增 browser `TC-WS-049`，107 步覆盖四视图、空/多标签工作区、800px 溢出布局、顶部实际命中、拖动 API 调用、双击最大化和控件正常操作。浏览器窗口 adapter 只提供有界只读观察，不向 native 注入模拟窗口行为。扩展 `TC-MAIN-RAIL-03`，由真实 X11 输入与独立系统几何读数检查 12 次拖动，每次实际位移 24×18px，宽高均不变；保留三处抓手、折叠、工具按钮与真实 PTY 检查。`TC-WS-048` 同步公共顶部选择器。

本机新用例 `workspace-titlebar-browser/run-20261027-084207-654713663` **1/1 passed**；受影响 browser `workspace-browser/run-20261027-083429-409298911` 为 5 passed / 1 意外页面刷新失败，WS-048 原断言在 `workspace-browser/run-20261027-084538-838679269` 复验通过。原失败 trace 与控制台继续保留。随后独立 Vite WebSocket 探针确认：原样重写 `feature-list.md` 后 14ms 收到 `full-reload`，与失败时的写入/导航时间相符。Vite 现在忽略 QA 目录及设计文档的文件监控；同一探针对目录和设计文档的两次原样写入未触发整页刷新，见 `_local/workspace-vite-catalog-refresh-fixed-probe.jsonl`。最终 native `workspace-native/run-20261027-084330-810003645` **7/7 passed**，包含统一拖动、标签导航、共享面板、隐藏编辑器、工作区冷启动及文件编辑保存。27 项拖动/工具栏/缩放单测、QA 构建（含 TypeScript 与重构边界）通过；无新增 apt/sudo 依赖。本机 UI worker 总数不超过 2，native 位于隔离桌面。

托管旧源码出现的 Linux 保存按钮点击、邮件共享归档状态、Windows/macOS 分屏恢复点击，以及 macOS 分离窗口重新附着失败均保留原证据；不将本机单次通过当作托管失败已解决。当前挂载点占用 94%，尚未触发超过 95% 时清理 repo 临时产物的条件。

邮件面板的轮询可以在按下 Resume 后、松开前把同一 DOM 按钮换成 Pause 并替换事件处理器。两个确定性挂载测试先失败，分别执行了相反操作。现在 Resume/Pause 使用独立 React key，旧按钮被替换后松开不会触发新操作；9 项邮件单测通过。邮件存储用例保留真实共享所有权、断点字节与 PTY 检查，并明确恢复后的控件状态。分屏恢复用例点击可见的编辑器滚动区后使用原有定位快捷键，保留编辑、撤销/重做、草稿恢复和磁盘哈希断言，避免目标文本被诊断浮层覆盖。WS-017 保存入口明确等待按钮可用；旧托管事件只有 pointerdown/up 而无 click，与原生 disabled 按钮一致，但其具体瞬态尚未在本机重现，需由托管复验确认。

macOS `TC-SESSION-BOOK-003` 的重新附着输入耗时约 60 秒，超过窗口切换自身的 45 秒预算，旧驱动随后没有进行任何窗口列表查询就报告 `no matching window`。按相同时间条件新增契约测试，原实现对真实关闭和仍存活两种状态均失败。现在关闭输入只派发一次，即使其回执耗尽等待预算，也在整体 case 截止时间内至少读取一次真实窗口状态；原窗口仍在时必须失败，只有原窗口消失并匹配主窗口 DOM 才可返回。原始窗口状态写入 `native-window-context.jsonl`。不增加等待预算、不重放输入。保留 `TC-SESSION-BOOK-003` 的真实 PTY 输出、重新附着后相同输出和单实例断言；这是测试驱动修复，不新增产品能力。30 项窗口、输入、传输及生命周期工具契约通过，确定性时间条件由红转绿；macOS 当前修复仍须托管执行。

邮件/Vite 修复后的本机 browser `workspace-browser/run-20261027-090842-550443983` 为 **4/4 passed**，native `workspace-native/run-20261027-090920-739571660` 为 **6/6 passed**，签名回执及 source/runner/case/native build 已独立核验，见 `_local/workspace-titlebar-mail-local-evidence.json`。真实邮件双实例证据包含所有权排他、262,144 字节暂停前缀、断点 FETCH、迁移前后对象数量和清理结果；窗口证据包含 12 次系统几何位移。

驱动最后调整后的相同范围已完整复跑：browser `workspace-browser/run-20261027-091652-415482339` **4/4 passed**，native `workspace-native/run-20261027-091654-524529874` **6/6 passed**。两批 `identity_stable=true`，签名回执、当前 source/runner/case/native build 独立核验通过，见 `_local/workspace-titlebar-current-local-evidence.json`。分离窗口的原始列表确认源窗口消失后选中主窗口，再保留同一 PTY 输出。36 项相关前端单测、30 项工具契约、635 ID 的静态门禁、开发用例契约与 `pnpm check:refactor` 通过。QA 原生构建检查确认输入匹配、复用已有二进制，SHA-256 为 `e696780e3ad63301b9a6abcbe36316fe39f7848f147de3466f62214b5ec547fb`。三平台托管相关范围新增 WS-049 后为 634 个适用 ID；下一步执行该范围并核验真实回执，之后再同步 main、执行全量和正式性能对照。

## 标签导航、窗口拖动及托管失败复验（2026-10-27，进行中）

Sessions 的本地终端加号与下拉组成固定宽度的紧凑按钮组。Workspace 标签条新增双向溢出箭头、滚轮横向滚动、活动标签可见性及 Home/End/方向键导航；末尾保留可拖动空白，顶部 4px 边框也可拖动窗口。新增双模式 `TC-WS-048`，既有 `TC-MAIN-RAIL-03` 增加真实系统窗口位移断言，混合标签恢复用例保留文件/协议/草稿断言并补充导航检查。浏览器已通过新标签导航及恢复场景，本机 native 已验证两处实际拖动；当前修复批次的最终回执仍在收集。

`40405967669` 的三平台 browser 共 1,309 passed；Linux native 5 failed、Windows native 3 failed、macOS native 7 failed。独立检查聚合及原始失败记录后，已确认 Replace Preview 的层级遮住全局确认框，以及原生覆盖式滚动条遮住 Run 配置保存按钮。修正层级和滚动区域后，使用真实打包 WebView 复验。另补齐 macOS QA 合成鼠标的默认控件焦点行为；窗口重新附着仅在确认原 WebView 消失后恢复超时，不重放点击。右键重开菜单时清理上次子菜单，主题刷新仍保留当前子菜单。

`TC-SESSION-NET-002` 以真实 reload 代替 native 无操作的第二次 open，验证持久化后再进入 Sessions。`TC-WS-030` 等待实际外部文件变更提示，保留冲突磁盘哈希及未保存缓冲区，并在重启前关闭该模态提示。SCP 路径编辑和分屏恢复的点击失败继续依据实际事件及遮挡诊断处理，不以 job 绿色、跳过或删除原断言替代验收。

最终本机 browser `workspace-controls-browser-final/run-20261027-074041-244615695` 为 **8/8 passed**，native `workspace-native/run-20261027-074420-637737452` 为 **12/12 passed**，独立真实 SCP 批次 `run-20261027-075051-140038032` 为 **1/1 passed**。三个批次均 `identity_stable=true`；签名回执、source/runner/case/native build 身份已独立核验，见 `_local/workspace-controls-local-evidence.json`。本机使用 CI 固定版本、校验 SHA256 的独立 Java 扩展目录，没有修改用户编辑器扩展。此前 Java Test 提供器加载失败、首次分屏点击及冲突用例失败均保留。

SCP 连接状态提示移到文件区下方，避免连接完成时路径工具栏突然上移；原用例在输入路径前增加焦点断言，保留真实协议、断点下载及上传/下载哈希、删除断言。分屏恢复点击可见的末行后通过键盘移到文首，避免点中首行诊断浮层，编辑、撤销/重做和草稿恢复断言不变。保存时的哈希冲突继续由原有状态栏反馈并拒绝写盘，用例不要求重复弹窗。

54 项相关前端单测、8 项窗口切换工具契约、QA 原生构建（含 TypeScript 与 `pnpm check:refactor`）、Rust 格式和 634 ID 的静态 QA 门禁通过。本地最多两个测试 worker，native 顺序运行；当前磁盘使用率 93%。三平台托管相关范围包含 633 个适用 ID，唯一外部项目缺口按既有 policy 单独记录。托管结果和随后全量、main 同步、性能对照仍待完成。

## 全量原生点击和焦点回归（2026-10-27，验证进行中）

相关集 `40344676416` 的 source/runner/case/build 身份、签名回执和聚合已核验，Linux browser/native 为 270/181、Windows 270/162、macOS 269/149，合计 1,301 passed，0 failed/skipped。Windows CRT reader 真实句柄契约 8/8、原子 writer 4/4 通过。按用户要求随后 fetch/merge main，无新增提交或冲突，证据为 `_local/workspace-main-sync-20261026.json`。

全量 `40351595065` 收到 2,001 项，2,000 passed / 1 failed；另 60 项因 macOS ARM runner 从未分配而缺失。失败为 macOS `TC-RDPS-PERF-01-performance-budget`：40/40 样本、0 timeout，M2 p95 70.661ms 超过原 65ms 预算；保留全部样本，未放宽预算。继续执行的 `40360000951` 降为四分片，Linux native 三项失败：`TC-AI-021` 请求 DeepSeek header 却打开 Local 行，`TC-IDE-PARITY-009-06` Enter 后未打开 Structural Search 对话框，以及 `TC-012` 路径输入获得焦点后被终端 textarea 抢走。不能将这些失败计为环境跳过。旧运行、截图、DOM 和焦点历史完整保留。

本机同输入法三项旧实现复跑为 3/3 passed（`workspace-native/run-20261027-011159-140258116`），说明时间条件不同，不能反证托管失败。新增两条确定性组件测试均先失败：延迟终端激活抢新路径框焦点，布局重测再次抢焦点。现在测量与激活焦点分开，焦点请求在另一控件接管后失效，卸载/隐藏取消待执行工作；滚动条或全屏变化只重新测量。`TC-012` 增加路径编辑保持焦点断言，保留真实远端 PWD 验收。

原生通用 click 复用既有稳定坐标和 DOM 命中检查的 W3C pointer 路径，取消坐标变化时的 DOM click/focus 降级；陈旧引用只在输入前重取，输入开始后不重放。`TC-IDE-PARITY-009-06` 使用稳定 Actions tab ID，增加完整查询值和被选中动作断言后再按 Enter，继续保留全部 dirty buffer/encoding/磁盘哈希断言；本轮对该失败的确切输入时序原因仍待进一步证据。没有修改查询排序或 SSR 产品行为。

当前聚焦焦点单测 5/5、WebDriver/pointer 契约 92/92、四个组件文件 122 passed / 1 既有 skipped 通过。第一轮修复 browser 11/11 passed；native 11/12 passed，稳定命中检查在 `TC-012` 第 15 步暴露此前被 DOM click 降级掩盖的真实遮挡：分割面板外层为 overflow:auto，子内容仅溢出 1px，WebKit 外层覆盖式滚动条挡住路径编辑按钮。隔离原生诊断保持同一坐标，将该外层临时改为 hidden 后，命中立即从外层 DIV 恢复到真实按钮，见 `_local/workspace-pointer-probe.json`（诊断注入不计有效通过）。现在两个 FilePanel 外层禁止滚动，由原有内部文件列表负责滚动；接下来以未注入的真实二进制复验。

未注入诊断的最终本机复验：browser `workspace-browser/run-20261027-014003-822921275` 为 **12/12 passed**，native `workspace-native/run-20261027-014343-207486184` 为 **13/13 passed**，覆盖四条托管失败、路径编辑焦点、真实远端 PWD、原生 Search Everywhere、真实输入法及 PTY、大预览、Home 目录恢复与面板崩溃回归。两批 `identity_stable=true`，签名回执和当前 source/runner/case/build 身份由 `load_observations` 独立核验，见 `_local/workspace-focus-local-evidence.json`。另 37 项托管规划/分片/聚合/构建契约通过。当前 QA 二进制 SHA-256 为 `51301c6365f023e4ea5df8fbc755bd7ecbc5bc468a41a6a1915b36cfe7d75bae`，产品源码指纹为 `b62dc2884092ab0837199620cd2a4f77bb383e3fb748d9be6571fbfe78112a31`。下一轮完整相关集为 402 个精确 ID，相关集全部通过后再执行全量。当前挂载点使用率 93%，未触发用户指定的超过 95% 临时产物清理条件。

全量 `40360000951` 最终 2,001 执行，1,997 passed / 4 failed，macOS 被取消的一个分片缺少 60 项。第四条失败是 `TC-MAIL-TAG-01`：用例在 IMAP STORE 尚未完成时就触发 Full Sync，迟到的 Tagged 状态覆盖了它要观察的同步状态。用例先断言 STORE 完成后的标签及 Tagged 提示，再触发全量对账；保留同步完成、重对账后标签和标签过滤断言。macOS RDP 在原 65ms 预算下本轮通过，前次超预算样本仍保留。本次只将 macOS native 同时运行的分片限制为 2，全部分片及适用用例仍执行，以减少 ARM runner 容量取消。适用用例 ID 未增删，沿用 policy/dependencies 与既有 controls，无目录重生成需求。完整功能全量通过后才进行正式 main/candidate 性能对照；目前尚无“性能无退化”结论。

## Home 恢复目录内容修复（2026-10-26）

用户手工测试在 Home 进入 Workspaces、选择 Workspace1 后，已展开的 `.idea`、`.settings`、`src` 等目录显示 `Empty`。本机只读检查确认目录有真实文件；新增 `TC-WS-044` 在修复前 browser `workspace-browser/run-20261026-170337-346038659` 第 29 步复现同样状态。布局持久化保存了子目录展开 key，但挂载时仅重新读取根目录，缺失的子目录缓存又被误显示为空。

新增独立的 `useExpandedWorkspaceDirectories`，在根目录及父目录列表就绪后逐层读取可见的已展开子目录，支持 Project、Compact 与 Detailed List。折叠分支、筛选/平铺视图不触发此恢复遍历；已有缓存和正在进行的读取继续复用，错误保留原显式重试语义。未加载的目录明确显示 Loading，只有成功读取的空目录显示 Empty。

`TC-WS-044` 用 UI 创建 Workspace1、展开文档及嵌套源码目录，切到默认工作区，从 Home 重载并选择 Workspace1；检查子目录、展开状态及打开的文档，再对 Detailed List 重复验收。原生 `TC-WS-030` 在两次真实进程冷启动后增加已展开 `src` 的文件及展开状态断言。33 项相关单元测试已通过；修复前的单元失败日志、browser trace 与截图均保留。

当前源码本机 native `workspace-native/run-20261026-171519-113425853` 为 **12/12 passed**，包含全部新增文件区用例、冷启动和原有 Code Workspace 的原生树键盘导航及焦点转移。Browser 主批次 `workspace-browser/run-20261026-170915-852827221` 为 9 passed / 1 页面意外重载失败，原断言不变的 `TC-WS-036` 在 `run-20261026-171519-039833829` 通过；10 个 browser ID 的最新适用结果全部 passed。三个批次均 `identity_stable=true`，签名回执及所有身份由 `load_observations` 核验，记录在 `_local/workspace-restored-tree-local-evidence.json`；没有删除首次失败。

QA 原生构建、`pnpm check:refactor`、Rust 格式及 630 个目录 ID 的静态 QA 门禁通过。当前 `com.taomni.app.qa` 二进制为 `src-tauri/target/qa-ui-auto/debug/taomni`，SHA-256 `c0b34cad944fa390d7f30c09d878a481e5bc2f94ac3a5b23ffb62e0365765f3b`，产品源码指纹 `48f19b2cf00af8679ab43f6e21ebc0ab31f87e774d3a1a96a079b9d733666bdf`。新一轮三平台相关集使用 394 个精确 ID，全部通过后再执行整体。

## 显式编辑器入口文件区回归（2026-10-26）

相关集 [40299441030](https://github.com/engcapa/taomni/actions/runs/40299441030) 的三平台 browser 回执为 608 passed / 198 failed，涉及 66 个不同失败 ID。截图、DOM 和 trace 确认：Tools → Code Workspace 在没有目录时仍主动收起主左栏；文件区改为共享 Code Workspace 并移入该左栏后，添加目录及打开文件按钮随之隐藏。主边栏用例另保留了旧的“收起状态首次点击 Project 继续隐藏”的预期。原生构建与契约完成后取消剩余旧源码执行，不将该运行计为通过。

显式编辑器入口现在选择 Project 并展开文件区，包括从工作区 Sessions 工具返回的情况。普通模式切换仍使用既有独立折叠偏好；大预览激活会话的行为不受此次入口修复影响。新增双模式 `TC-WS-045` 覆盖空编辑器、折叠/Project、Sessions 工具、Tools 与 Home 再进入以及单一运行实例，原边栏用例改为显式收起后验证收起布局，并同时保留 Project 展开/收起断言。当前修复本机 browser 主批次 `workspace-browser/run-20261026-175251-105079829` 为 67 passed / 4 failed；布局和边栏选择器迁移后，`run-20261026-180539-300355761` 的原 4 条全部通过。另两条失败的 trace 显示 document 请求分别发生在 09:56:23.939Z 与 09:56:24.121Z，与更新本报告（09:56:23.849Z）触发的开发服务器刷新相符；随后冻结文件写入，分屏及 keymap 原断言通过。没有修改产品实现规避此测试干扰。

Native `workspace-native/run-20261026-181135-743400216` 为 **14/14 passed**，包含系统目录选择、LSP 等待、冷启动、目录恢复、主边栏及新增入口。三个批次均 `identity_stable=true`；签名回执与 source/runner/case/native build 身份由 `load_observations` 独立核验，**71 个 browser ID、14 个 native ID** 最新结果全部 passed，记录在 `_local/workspace-empty-entry-local-evidence.json`。当前 QA 二进制 SHA-256 为 `e9bf3f859f80e655015e8051c242241900622ec7f48153341771d92490b6cb5d`，源码指纹 `8e995322a4cd9fb01882821f166c4f707445ba694c2943f57f81f5211c61e585`。6 项入口单测、QA 原生构建（含 `pnpm check:refactor`）及 631 ID 静态门禁通过。托管完整相关集新增 `TC-WS-045`，共 395 个精确 ID，通过后才执行整体。

相关集 [40306481232](https://github.com/engcapa/taomni/actions/runs/40306481232) 的三平台 browser 原始回执为 806 passed / 3 failed，失败均为 `TC-WS-025`：显式编辑器入口已经展开文件区，旧用例随后再次点击收缩按钮，导致切换器不可见。迁移该操作及对应 native `TC-WS-026` 为直接断言展开；目录选择、保存、重新进入和默认工作区归属断言均保留。新 browser `workspace-browser/run-20261026-183858-583230263` 与 native `workspace-native/run-20261026-183957-568677518` 各 **1/1 passed**，`identity_stable=true`，签名回执及当前 source/runner/case/build 身份已核验，记录在 `_local/workspace-route-entry-local-evidence.json`。这一迁移仅改用例，不改变产品源码或 QA 二进制；GitHub native 余下回执与新完整相关集继续跟踪。

## Home 返回后的标签点击稳定性（2026-10-26）

`40306481232` 最终为 **1,292 passed / 8 failed**。除 WS-025/026 六次旧操作失败外，Linux native `TC-MFA-102` 和 `TC-MAIL-FOLDER-01` 各失败一次。原始焦点事件记录显示：Home → Sessions 后，前者 pointerdown 命中 MFA 标签、pointerup 落到 session-favorite；后者 pointerdown 命中关闭按钮、pointerup 落到侧栏分隔条。新布局将标题栏放进内容面板，而侧栏尺寸仍延迟到下一帧更新，导致同一次按下/松开间目标换位。

侧栏尺寸现在在 layout effect 中、绘制之前同步，保留原尺寸记忆、折叠偏好和面板映射。新增确定性测试在不执行 RAF 的条件下检查初始、Home 折叠和 Sessions 恢复；旧实现先失败，修复后主布局 **52/52** 通过。迁移其中仍期待已删除上部 Chat 的旧断言，复用底部 Chat 的要求不变。`TC-WS-039` 增加 Home/Sessions 后立即激活 MFA、关闭 Settings 的双模式流程，不添加睡眠或点击重试。

当前 browser `workspace-browser/run-20261026-191953-315214230` 为 4 passed / 1 failed；新增尾部 MFA 流程在前面窗口重载后需要重新完成 vault gate，补齐后 `workspace-browser/run-20261026-192359-724642968` 为 **1/1 passed**。原生 `workspace-native/run-20261026-192817-770210175` 为 **6/6 passed**，包含 MFA、邮件订阅、Home 目录选择及磁盘保存、隐藏编辑器崩溃恢复、嵌套分栏和主边栏。三个批次 `identity_stable=true`，当前 source/runner/case/build 与签名回执由 `load_observations` 核验，**5 个 browser ID、6 个 native ID** 最新适用结果通过，记录在 `_local/workspace-geometry-local-evidence.json`。QA 构建（含 TypeScript 与重构门禁）通过；当前二进制 SHA-256 为 `ac08843b14f1d9922b1306bbff2c32eca0d17331671ebafee0d2577d3bf2a32f`，源码指纹 `3384b29e4033077a77fc1c235f08200a3457c1158bc934ea4a750a3ca5486c50`。完整单测及包含此修复的新 395 ID 托管相关集继续执行。

## Windows 备份结果记录替换修复（2026-10-26）

相关集 [40312042123](https://github.com/engcapa/taomni/actions/runs/40312042123) 以 `a60b1696` 执行 395 个精确 ID，最终 **1,299 passed / 1 failed**，无基础设施错误。三平台 browser 809/809、Linux native 180/180、macOS native 149/149、Windows native 161/162；唯一失败为 `TC-BACKUP-MAIL-001`。原生日志明确记录 `Failed to persist transfer result: Access is denied (os error 5)`；归档已生成，但最终任务记录原子替换失败，磁盘仍是 packing，独立 ZIP/SQLite oracle 因而没有接受该结果。没有把此次失败归为外部缺口，也没有删除五份归档及 MIME/附件字节的校验。

`backup::control::write_json` 继续同步临时文件后原子替换；Windows 仅对 5/32/33 三类访问/共享锁错误，在两秒期限内重试同一份已同步临时文件。其余平台和错误立即返回，永久锁到期仍报错，原完整记录不会被截断或删除。新增不依赖 Tauri 的真实 Windows 文件句柄契约，检查首次替换确实被 reader 阻挡、释放后发布完整新记录，以及长期锁超时仍保留两份完整文件；`qa-ui-auto-platforms` 的 Windows 备份构建显式运行该生产重试模块的契约并保留日志。原生用例增加全部完成后无 local packing/failed 任务的断言。当前版本本机 browser `workspace-browser/run-20261026-201707-565413576` 为 **2/2 passed**，native `workspace-native/run-20261026-202118-440178236` 为 **7/7 passed**；包括原始失败用例及五份归档独立校验、备份取消/恢复、MFA/邮件标签、共享布局和空编辑器入口。两批 `identity_stable=true`，签名回执及 source/runner/case/native build 身份由 `load_observations` 独立核验，记录在 `_local/workspace-backup-local-evidence.json`。本机三项原子替换契约、18 项 workflow 工具契约、QA 原生构建（含 TypeScript/重构门禁）、631 ID 静态 QA 门禁及 Rust 格式检查通过；Windows 真实 reader 锁的两项平台分支将在托管构建运行，不冒充本机 Linux 结果。

当前 QA 二进制路径为 `src-tauri/target/qa-ui-auto/debug/taomni`，SHA-256 `fcc6b5cf34fe5b8d254f48f48e157b078c5d6bcb906544f602b7c091068c2e98`，产品源码指纹 `6c511e6a29cf36d9e1342809a6ea88099d1fe0fd054849b81ef06986b2f0319e`。新 395 ID 三平台相关集继续执行，全部通过后再同步 main 和执行整体。

整体 Node 22 单测初次为 5,766 passed / 2 failed / 1 既有 skip。两个失败均是既有 Code Workspace 测试仍使用重构前的操作：默认名称排序下的树选择顺序，以及 editor 焦点占用共享 Undo 时的独立 action。迁移为正确的名称顺序与已有工作区 Undo 快捷键，保留“不读取仅选择目标”“整笔事务撤销及排除文件不变”的断言；两条定向复验通过。整体复验为 5,767 passed / 1 failed / 1 既有 skip；新失败的 Extract Method 重试测试没有先等待 provider 拒绝后再操作重开的输入框，补齐 provider 调用和错误状态检查后定向 1/1 通过。随后以 Node 22、最多两个 worker 完整执行 **587 个文件全部通过，5,768 passed / 1 既有 skipped，EXITCODE=0**，日志为 `_local/workspace-final-unit-complete.log`；此前失败日志继续保留。

## 原生大预览快捷键输入诊断（2026-10-26）

相关集 [40322687656](https://github.com/engcapa/taomni/actions/runs/40322687656) 最终为 **1,299 passed / 1 failed**，唯一失败是 Linux native 的 `TC-WS-019` 第 28 步未等到大预览：此前两份真实 PTY 输出、大预览尺寸、卡片激活和侧栏状态均通过，第 27 步 Ctrl+Shift+E 后预览没有出现，进程存活且控制台无异常。Windows 五份真实备份归档与结果任务状态均通过，四项真实文件句柄契约也通过。

保留原快捷键断言，不增加延时、重试或替换成按钮。补充原生诊断的有界修饰键/物理键码和焦点记录，排除普通输入字符与控件值。普通本机原生 `workspace-native/run-20261026-211153-051258694` 为 **1/1 passed**，回执身份已核验，见 `_local/workspace-shortcut-local-evidence.json`；该结果只说明普通环境没有复现，不能覆盖后续发现。

随后复用 CI 的私有 fcitx/GTK 准备流程在本机重现：`_local/workspace-shortcut-ime-repro/result.json` 的第二次实际按键为可信 Ctrl+Shift+E，首个 E keydown 却带 `repeat=true`，此前对应的 E keyup 已送达。产品确实收到并阻止了事件，但 `if (!event.repeat)` 忽略了打开操作。修复前两项新单测分别在“首次 repeat”和“重复初始事件”上失败，日志为 `_local/workspace-shortcut-unit-red.log`。

快捷键现在按下时只切换一次，E 松开或窗口失焦后释放按下状态，不依赖首次事件的 repeat 标记。修复后快捷键/预览 **8/8** 单测通过，保留编辑器 Recent Locations 的原有按键归属。`TC-WS-018/019` 增加连续两次打开/关闭，新增 Linux-only `TC-WS-046` 先通过真实 fcitx 将中文提交到 PTY，再在终端输入区获得焦点后验证卡片选择、快捷键重复打开和终端保留。

最终本机 browser `workspace-browser/run-20261026-213342-869085699` 为 **2/2 passed**，native `workspace-native/run-20261026-215156-402186892` 为 **4/4 passed**。原生批次复用 CI 的 fcitx/GTK 准备流程，`TC-WS-046` 的真实中文 printf 输出及两轮快捷键全部通过；截图已复核。两批 `identity_stable=true`，签名回执及 source/runner/case/build 身份已独立核验，见 `_local/workspace-shortcut-fixed-local-evidence.json`。632 ID 静态门禁、重构契约、TypeScript/QA 构建均通过，96 项测试工具契约通过。QA 二进制 SHA-256 为 `dc78b8624f55baa43cf13e9f427b19b1e4d1fab48c7489c05405428f21570319`，产品源码指纹为 `993a1c795fa6ab217bfd63a891a664840778f7ca3737fb6172d51e18a70f4dda`。

保留本机隔离桌面的环境失败记录：私有输入法服务退出后原窗口管理器不再映射新窗口，后续预检失败或原生驱动超时，没有计为通过。仅重启 QA 所属 `:186` 窗口管理器并禁用该管理器自身的输入法依赖；产品仍使用真实 fcitx/GTK。上述最终两批在环境恢复后执行；未改动个人 `:0` 桌面或用户 profile。输入诊断的旧源码定向运行不作为修复版本证据。新增用例后完整相关范围为 396 个 ID，当前全量单测亦重新执行。

本机完整复验已结束：Node 22、1 worker、**587 files passed / 5,770 tests passed / 1 既有 skipped，EXITCODE=0**，日志为 `_local/workspace-shortcut-complete-unit.log`。相关集 [40335429931](https://github.com/engcapa/taomni/actions/runs/40335429931) 为 **1,300 passed / 1 failed / 0 skipped**，Linux native 181/181、macOS native 149/149、三平台 browser 809/809；真实输入法分片中的 `TC-WS-019/046` 均通过。截图已复核真实中文输出和大预览内容。

## Windows 独立归档观察器的 CRT 错误修复（2026-10-26）

`40335429931` 唯一失败为 Windows `TC-BACKUP-MAIL-001` 第 37 步。前三份归档已通过独立 ZIP/SQLite 校验；第四份完成时观察线程收到 `[Errno 13] Permission denied` 并退出。失败截图和 DOM 显示四份 local 任务均为 completed，原事件文件完整保留。既有 reader 仅重试带 winerror=5/32/33 的错误，遗漏 Python `Path.read_text` 经 Windows CRT 返回 errno=13、winerror 缺失的形式。

观察器补充该 Windows CRT 形式，继续使用原两秒期限；永久拒绝仍报 ORACLE_ERROR，损坏 JSON、错误结构和其他错误不重试。错误诊断保留 errno/winerror。两条确定性测试在修复前分别失败和报错，修复后通过；Windows 构建增加真实独占文件句柄契约，验证实际 CRT 异常、释放后读到完整记录，以及持续锁到期仍拒绝观察。Linux 上不把两条 Windows 专属契约计为通过。

本机 native `workspace-native/run-20261026-225057-483631656` 为 **2/2 passed**，包含 `TC-BACKUP-MAIL-001` 的全部五份归档内容及字节校验，以及 `TC-BACKUP-CANCEL-002` 的真实 OS 锁、取消与恢复。`identity_stable=true`，当前 source/runner/case/native build 与签名回执已独立核验，见 `_local/workspace-journal-crt-local-evidence.json`。观察器与 CI 选择、聚合、构建和导出契约 **51 passed / 2 Windows 专属 skipped**；`pnpm check:refactor` 通过。产品源码和 QA 二进制保持上一节身份；本次仅修改观察器、工具契约和 workflow，原两条执行用例及其断言完整保留，不需要为工具修复另建产品用例。396 ID 完整相关集将使用新的 runner 身份重新执行，全部通过后再同步 main、启动全量。

## 空工作区文件浏览器追加实现（2026-10-26）

空工作区现在挂载与有目录工作区相同的 Code Workspace 文件区及工具窗口，支持直接打开文件或系统目录选择器；初始不挂载 HOME，选择器默认定位 HOME，未打开文件时常用会话默认收起。删除空工作区的降级工具栏和重复 Add Folder 菜单，复用真实 Project、Sessions、Git 与完整工具窗口溢出菜单。

新增 Detailed List 的名称、大小、类型、修改时间列，以及自然排序、升降序、目录优先和偏好恢复；名称列在横向滚动时固定可见，宽度跟随侧栏。新增 Packages 和 Appearance → Flatten Packages，同名包按 main/test 源码根区分，仍可打开原文件、重命名、编辑和保存。修复旧源码过滤把 `com.example` 误判为 examples 容器的问题，继续排除实际示例项目及构建/依赖目录。

目录读取、递归索引、Git 发现和语言服务/扩展探测均通过原生后台任务执行。恢复草稿不等待语言服务初始化；真实 stdio 测试服务将 initialize 暂停，在释放前完成目录展开、普通文档打开、排序及工作区切换，并检查迟到回复不切回旧文档。

Browser 曾实际复现首次添加目录的 `Maximum update depth exceeded`：编辑器在同步新 host 根目录的提交中发布了旧 roots 与新 repoRoot，父窗口命令注册触发状态回写循环。现在在提交 effect 之前同步新输入定义，新增根自动展开、已有根保留原展开状态；挂载测试使用真实父窗口命令注册状态，保留修复前失败日志。

新增 `TC-WS-040/041` browser 与 `TC-WS-042/043` native，迁移既有文件区、恢复、主题和崩溃回归的入口；`TC-WS-003` 实际打开 Terminal、Search、TODO、Coverage、Structure 并切换 Sessions/Project。

最终本机 browser `workspace-browser/run-20261026-164121-553892673` 为 **9/9 passed**（2 workers），native `workspace-native/run-20261026-163507-030400079` 为 **9/9 passed**（顺序执行）。两批均 `identity_stable=true`，签名回执、源码/runner/用例及原生构建身份由 `load_observations` 独立核验；记录在 `_local/workspace-explorer-local-evidence.json`。Browser 首批保留的两个页面重载失败随后在单独批次和完整 9 条批次中均通过，没有修改断言。Native 覆盖真实系统目录选择、磁盘读写、JDTLS 补全、冷启动、面板恢复和真实 stdio 服务初始化等待。

112 项相关 frontend 测试、14 项源码过滤测试、74 项 Rust workspace 测试及慢 LSP fixture 契约通过；`pnpm build --mode qa`（含 `pnpm check:refactor`）、Rust 格式和 QA 静态覆盖门禁通过。该批 QA 二进制的 SHA-256 为 `cc32aa46218aef608e6398e03004f5512e9aae13fd64fc4520fb8acecf210ae7`，产品源码指纹为 `c047370f9e53dc1084dd418366813fa6eac1dbf0253212d08986470e774cce58`，随后启动 393 个精确相关 ID 的托管执行；Home 恢复追加修复和当前验证范围见上节。

## 上一轮功能验收（2026-10-26，9f3ada0f）

已拉取并合并远程 main `a57437927b62d6036a6d473eddccc053a4b4c0e8`，合并提交为 `f1297db1`。合并后修复侧栏状态和跨平台测试工具边界，再以同一最终提交 `9f3ada0f685b01a391f54fdd62dc2061d23ba4b3` 执行完整相关集，全部通过后才启动全量。两次运行均使用 `qa-ui-auto-platforms` workflow；下表是用例回执结果，并非仅依据 job 的 success。

交付包含 Home / Sessions / Workspaces 的入口归属、全局及 Sessions 大预览、合并筛选与紧凑标签导航、广播目标选择、系统目录选择、终端右键菜单，以及共享 Code Workspace 的文件树、编辑器、LSP、外部磁盘变更与文件/会话/草稿恢复。全局主题与字体设置继续生效；重复 Chat / Git 入口及 Tao 靠边悬浮已清理。Agents Crew 按用户要求保留“开发中”按钮，不宣称其调度功能已交付。

| 平台 | 相关 browser / native | 全量 browser / native |
| --- | ---: | ---: |
| Linux | 266 / 176 | 432 / 264（含 1 条双屏用例） |
| Windows | 266 / 158 | 432 / 246 |
| macOS | 265 / 145 | 430 / 232 |
| 合计 | **1,276 / 1,276 passed** | **2,036 / 2,036 passed** |

- 相关集：[40269136009](https://github.com/engcapa/taomni/actions/runs/40269136009)，389 个适用 ID。
- 全量：[40273044230](https://github.com/engcapa/taomni/actions/runs/40273044230)，625 个目录 ID 中的 624 个适用 ID。
- 独立核验 `_local/verify-workspace-hosted-evidence.py` 读取原始签名回执，重新检查选择、执行配置、source/runner/case/native build 身份、summary hash 及聚合一致性；结果为 `_local/workspace-final-hosted-evidence.json`。两次执行均为 0 failed / case skipped / infrastructure errors，未用不同 runner 的历史通过结果拼接最终全绿。
- 唯一外部缺口：`TC-IDE-C6-06-java-definition-realproject-native` 依赖仓库未提供的 clickhousecrud（`QA_JAVA_PROJECT_ROOT`）；按用户确认的既有 policy 在三个 native 平台单列 gap，不计为通过。

`TC-WS-038/039` 在上述两次三平台 browser/native 运行中均通过，覆盖用户手工发现的隐藏编辑器恢复崩溃，以及真实面板组件的嵌套分栏、拖动、键盘调整、模式切换、预览和重载。每个平台 native 的两个用例共有 13 个已安装的运行时检查点；未捕获异常、未处理 Promise、生产 React 根错误或崩溃页都会失败，监控缺失也会失败。具体修复和检测负控制见后面的历史记录。

本机最新补充批次 browser `workspace-browser/run-20261026-122400-614861793`（WS-038/039 2/2）与 native `workspace-native/run-20261026-122433-182786478`（MAIL-001、CANCEL-002、WS-038/039 4/4）均通过且 `identity_stable=true`；更早合并后的受影响功能覆盖共 56 个不同 ID，见对应批次记录。本机始终最多 2 个 UI worker，native 独占顺序执行，使用隔离 QA profile 与私有 Secret Service，不清理个人数据。

该轮 QA v15 的 ID 为 `com.taomni.app.qa`，SHA-256 为 `830f9d952ca304ceaca5a5f910b525614ca8202632af9a6d12357b4a91739847`，产品 source SHA-256 为 `0f145a26430319575478de9cdc84fc63f667bc7b8be21373a7a3e4fa982bce94`。`src-tauri/target/qa-ui-auto/debug/taomni` 会随当前构建更新，不以此历史哈希说明当前文件。

## 性能审查与实测

在全量回执独立核验通过后进行。main 与候选版本在独立桌面、相同工具链和构建输入下交错采样；原始结果位于 `qa-ui-auto-report/workspace-performance/`，方法、构建条件及失败诊断保留于 `_local/workspace-perf-plan.json`、`workspace-perf-conditions.json`。最终对照结果将在本节补全。

## 历史实现与修复记录

以下记录保留各阶段的失败、定位与复验过程。诸如“下一轮”“仍在执行”等措辞描述当时状态；当前功能结论以上面的最终验收为准。

## Windows 备份独立校验竞态（2026-10-26）

相关集 [40264966563](https://github.com/engcapa/taomni/actions/runs/40264966563) 最终为 1,269/1,270 passed、1 failed、0 infrastructure errors：三平台 browser 794/794、Linux native 175/175、macOS native 144/144、Windows native 156/157。唯一失败 `TC-BACKUP-MAIL-001` 的前四份归档已由 ZIP/SQLite oracle 核验，第五份在 UI 显示 completed，但独立观察线程读取 Windows 正在被原子替换的 job journal 时收到 `Permission denied`，写入 `ORACLE_ERROR` 后退出。原始 `snapshot-oracle/events.txt` 和失败截图保留，不把 job 完成视作归档校验通过。

读取 journal 的共享工具仅对 Windows 的 access/sharing/lock 错误码 5/32/33 做最多 2 秒重读；永久拒绝、其他错误、无效 JSON 或非对象内容继续明确失败。不改变用例时限、归档内容、原文字节、附件、索引或成功条件。该工具同时用于快照 oracle 与云端服务的 journal 观察。9 项工具契约通过，其中覆盖短暂拒绝后继续读取、永久拒绝超时、POSIX 拒绝及损坏数据不被忽略。包含崩溃补充的 [40268425464](https://github.com/engcapa/taomni/actions/runs/40268425464) 已主动取消，后续使用包含这项修复的同一 runner 重新执行完整相关集；不拼接不同 runner 的回执作为全绿结果。

当前本机 native `workspace-native/run-20261026-122433-182786478` 为 4/4 passed（MAIL-001、CANCEL-002、WS-038/039），browser `workspace-browser/run-20261026-122400-614861793` 为 WS-038/039 2/2 passed。两批均匹配当前 source/runner 指纹且 `identity_stable=true`；`pnpm check:refactor` 通过。Windows 锁语义的真实复验由下一轮托管 native 执行完成，此处 Linux 本机通过不替代 Windows 结果。

## 崩溃与组件升级防回归补充（2026-10-26）

保留 `TC-WS-038` 对用户原始 `Panel constraints not found for index 2` 崩溃的真实操作复现，并在重载前与每次恢复后增加显式运行时断言。新增 `TC-WS-039` 在真实 `react-resizable-panels` 上连续进行嵌套分栏、Documentation、侧栏指针拖动/键盘调整、终端隐藏、模式切换、大预览、合并分栏及重载，检查草稿、活动会话与单一编辑器所有权。两个用例均要求 browser/native；这保护组件及 WebView 升级后的真实集成，面板组件没有替换成 mock。

新增 `assert_no_runtime_errors`：未捕获异常、未处理 Promise、生产 React 根错误诊断或 `app-crash` 页面均失败，即使后续界面恢复也不清除已有错误；普通警告与已处理服务错误保留为诊断。Native 当前文档在重载前后分别检查，缺失监控或传输失败不能变成空列表通过，原始观察写入 `runtime-errors.jsonl`。原生文档监听提取到独立 `native_console.py`，保持焦点、输入、控制台观察及文档销毁语义。新增原生拖动以单个 W3C action 请求完成，失败时释放指针，兼容 macOS 桥接不跨请求保留指针状态的限制。

本机 `workspace-native/run-20261026-121406-571111343` 与 browser `run-20261026-121546-454194723` 各两条用例通过，两批均匹配当前 source/runner 指纹、`identity_stable=true`，各有 13 个运行时检查点。114 项运行时、拖动、传输、几何及驱动生命周期工具契约通过。独立 Chromium 页面对两个观察通道执行 10 项正负检查，包含真实异步异常和未处理 Promise，均得到预期结果：`_local/workspace-runtime-negative-controls/summary.json`。此项仅证明自动化异常检测，native 产品行为由上述真实桌面用例证明。

625 个目录 ID 的静态审计与覆盖率门禁、`pnpm check:refactor` 通过。产品源码和构建输入未变，匹配 Node 22 与原构建环境后 QA v15 复用检查通过。新增/修改用例已经注册 policy/dependencies；下一轮三平台相关集使用 389 个精确 ID，全绿后才启动全量。性能 review 按用户顺序留在功能全量通过后执行。

## 驱动端口释放续验（2026-10-26）

合并提交 `f1297db1` 的相关集 [40260631956](https://github.com/engcapa/taomni/actions/runs/40260631956) 已完成三平台 browser 794/794 和 macOS native 144/144；Linux native 为 173/175。`TC-WS-030` 第二次关闭后的应用及三个 WebKit 相关进程已退出，失败阶段是 `wait-for-old-ports`：旧适配器关闭期间的 TCP reset 被端口探针直接抛出。随后 `TC-WS-037` 遇到已停止的驱动，Linux 的旧入口假定每个用例间驱动一直运行，因此 setup 连接被拒绝。Windows 结果继续收集；该运行不计作相关集通过。

端口检查现在对关闭中的 reset 继续观察，必须得到后续连接拒绝才确认释放；持续 reset、超时、活跃监听和其他 socket 错误仍失败。将驱动可用性恢复职责从大型 facade 提取到带类型的 `native_driver_lifecycle.py`，保留 Windows/macOS 的原有状态与端口语义；Linux 仅在自有驱动已停止时等待两个旧端口释放并启动新 owner，不重放不确定的 UI 动作。契约测试先在修复前复现 reset 失败，并覆盖持续 reset 不能证明空闲、无关错误继续失败及下一个用例的驱动恢复。

本机 150 项工具测试通过，1 项平台预设跳过；当前 runner 的 native `workspace-native/run-20261026-113147-849761893` 为 `TC-WS-030/037` 2/2 passed、`identity_stable=true`。两次正常关闭、冷启动、profile 恢复和磁盘冲突断言均保留。没有产品构建输入变化，QA v15 仍通过复用检查。以下 56 ID 本机证据是 `f1297db1` 时的记录；本轮工具边界使用上述新回执，最终当前 runner 的完整覆盖由下一轮 GitHub 相关集及全量建立。

这次仅修改自动化工具内部生命周期，未改变产品用户流程；保留的可执行回归为 `TC-WS-030` 与 `TC-WS-037`，新增工具契约纳入全量 workflow。`pnpm check:refactor` 同时检查提取边界。

## main 合并与全量续验（2026-10-26）

`f1587254` 的三平台相关集 [40246136402](https://github.com/engcapa/taomni/actions/runs/40246136402) 已完成：374 个 ID、1,227 次执行全部 passed，0 failed / skipped / infrastructure errors。Linux browser/native 为 259/167，Windows 为 259/148，macOS 为 258/136。原始回执、源码/runner/用例及 native 构建身份已独立核验，记录在 `_local/workspace-final-hosted-evidence.json`。

随后全量 [40249257719](https://github.com/engcapa/taomni/actions/runs/40249257719) 执行 621 个目录 ID 中的 620 个适用 ID，2,018/2,021 次执行通过，3 failed、0 infrastructure errors。虽然 workflow job 为 success，严格用例聚合为未通过。失败分别为 Windows `TC-SHOT-N17` 保存路径逐字符输入漏字、Windows `TC-SHOT-N26` 仍使用 Home 中的旧会话创建入口，以及 macOS release `TC-WS-038` 的折叠侧栏恢复。没有重现原 `Panel constraints not found for index 2` 崩溃。

相关集通过后，依照用户要求 fetch 并合并远程 main `a5743792`。整合保留 main 的备份取消、分类树、邮件存储和异步反馈能力，以及本分支的独立 Workspace、导航和原生重启工具修复；六处文本冲突已解决。邮件用例改走 Sessions 后继续执行 main 的全部原断言，同步更新步骤编号和验证映射。合并后目录为 624 个精确 ID，QA 静态审计与覆盖率门禁通过。

全量反馈的修复：Workspace 折叠偏好独立持久化在 `taomni.workspaceSidebarCollapsed`，进入分区时直接恢复，隐藏的 Sessions 标签组策略不再覆盖 Workspace 侧栏；Home 的自动收起仍是瞬时状态。`TC-WS-038` 增加展开、折叠两种状态下反复切换分区的断言。Windows 截图保存辅助工具改用真实系统剪贴板及 Ctrl+V 输入完整路径，保留原生字段稳定回读、窗口所有权和保存按钮鼠标操作的严格检查，并恢复原截图剪贴板。共用的 `PathPasteboard` 从 macOS 保存辅助工具提取，保留异常清理语义。`TC-SHOT-N26` 先进入 Sessions 后创建原有会话弹窗，不改变截图、像素和快捷键断言。

合并后的本机验证：177 个相关 frontend 单元测试、43 个 QA 工具契约及 Rust 库测试 1,906 passed / 0 failed / 25 预设 ignored；`pnpm build`（包含 `pnpm check:refactor`）和 Rust 格式检查通过。Browser 批次 `workspace-browser/run-20261026-093209-602919200` 为 10/10 passed、`identity_stable=true`，增强后的 `TC-WS-038` 单独批次 `run-20261026-092921-858965310` 也通过。共享导航追加批次 `run-20261026-101950-441892612` 为 30/31 passed；第一次 MAIN-RAIL-01 失败前发生整页刷新，保留原始 trace。更新到 main 0.5.3 的本地 Vite 后返回 Sessions 正常，继续执行暴露旧用例默认 Workspace 总是展开的预期。该用例现明确验证恢复折叠偏好，再展开和收起，完整 browser `run-20261026-103508-734354208` 及 native `run-20261026-103508-866126129` 均通过；更新服务后的 `TC-WS-038` 也通过。未删除合并工具窗口、Settings、键盘操作或重复 Git 的原断言。

QA v15 二进制构建完成，源码指纹为 `0f145a26430319575478de9cdc84fc63f667bc7b8be21373a7a3e4fa982bce94`。Native 的 19 个不同 ID 最新适用结果全部通过，含备份分类/取消、邮件完整归档、真实 SSH/X11、两次冷启动和隐藏编辑器恢复。批次 `workspace-native/run-20261026-094509-637109761` 首次为 13 passed / 5 failed；3 项受私有密钥服务未准备影响，另 2 项为本机缺少 OCR 引擎和私有桌面透明合成。补齐独立密钥服务（真实凭据存、取、清理检查）、校验哈希的中英文 OCR 数据和 xcompmgr 后，`run-20261026-100941-450276495` 完整重跑 5/5 passed；`run-20261026-101333-658089772` 的真实 X11 用例通过。未修改产品或断言来规避这些环境失败。更早的代理误转发本地 WebDriver 连接的 setup 失败保留原日志，随后为 localhost 设置直连。临时密钥服务、profile、SSH 凭据和 X11 会话均隔离，不清理用户手工测试数据。

共享导航原生追加批次 `workspace-native/run-20261026-103841-674155167` 的 15/15 通过。最终本机选中范围为 56 个不同 ID，40 个 browser 与 35 个 native 执行结果；保留所有首次失败及后续完整重跑证据。当前源码、runner、用例与 QA 构建身份的严格核验记录在 `_local/workspace-merged-local-evidence.json`。新一轮 388 个相关 ID 的三平台 browser/native 严格聚合全绿后，再执行全量。

外部 clickhousecrud 用例 `TC-IDE-C6-06-java-definition-realproject-native` 继续按用户确认的现有策略单列，不计作通过。

## 追加反馈与跨平台回归（2026-10-25）

2026-10-26 手工反馈的 Workspaces 点击崩溃已定位：`WorkspaceShellView` 将 Project 的开关状态传给编辑器面板的 `defaultSize`。编辑器在终端标签后隐藏时，修改该初始参数会重新注册面板；所有隐藏面板的尺寸均为零，注册顺序变为 Documentation → Editor，而 DOM 仍为 Editor → Documentation，分隔条计算抛出 `Panel constraints not found for index 2`。编辑器初始尺寸改为在挂载时固定，后续尺寸继续由已有面板 ref 与工具窗口状态管理，不重挂载工作区或清除保存数据。

新增 `TC-WS-038`（browser/native），从真实 UI 添加目录、编辑草稿、打开终端并隐藏 Project，覆盖从 Home 重载后恢复、活动终端和草稿保留、Project/Documentation 操作及重复模式切换。修复前 browser `workspace-browser/run-20261026-065630-378365475` 和 native `workspace-native/run-20261026-065651-938619483` 均出现与用户截图相同的崩溃；另将用户保存布局只读复制到隔离浏览器重现，保留 `_local/workspace-panel-debug/` 证据。修复后本机 browser `workspace-browser/run-20261026-070051-774089364` 的 4 个 ID 全部通过、`identity_stable=true`，包含新增回归、编辑器撤销/保存、Project 宽度保持和分隔条/分屏。最新三平台相关集及全量继续执行；本机结果不代表最终 GitHub 验收已完成。

QA v14 构建完成，`pnpm build --mode qa`（包含 `pnpm check:refactor`）通过。修复后的 native `TC-WS-038` 在 `workspace-native/run-20261026-070414-014308167` 通过、`identity_stable=true`，与 browser 使用相同源码指纹 `aa073f2b470cdd68cf1839c5f97fe304dcc7d543f81ded3c83e3e9bca3284356`。本机手测二进制为 `src-tauri/target/qa-ui-auto/debug/taomni`。原生保留行为批次 `workspace-native/run-20261026-070543-921207439` 的 3 个 ID 全部通过、`identity_stable=true`，包含 `TC-WS-017` 编辑器撤销/保存、`TC-IDE-PARITY-027-03-merged-rail-workspace-native` 导航宽度/工具窗口和 `TC-WS-030` 两次真实冷启动、SSH/SFTP/PTY 与磁盘冲突。新修复本机总计 4 browser + 4 native 全部通过；全程 browser 不超过 2 workers、native 顺序执行，静态 QA 审计通过。

Windows 冷启动工具修复在 [40241207602](https://github.com/engcapa/taomni/actions/runs/40241207602) 完整通过，聚合为 1 passed、0 failures、0 infrastructure errors。两次真实重启均记录 `Windows TCP listener table`、端口 `[4444, 4445]` 无监听及正常关闭观察。旧相关集 [40239319086](https://github.com/engcapa/taomni/actions/runs/40239319086) 最终为 browser 773/773、Linux native 166/166、macOS native 135/135、Windows native 144/147，3 failures、0 infrastructure errors，未通过。该运行尚未覆盖新增的隐藏编辑器布局场景，因此此前未发现本次手工反馈的崩溃。

上述 3 项失败分别为已修复的 Windows 驱动端口检查，以及 `TC-SESSION-SCP-001/002` 的 Cygwin 路径映射。SCP 原始 DOM 证明上传队列 done、远端列表存在 14 字节目标文件；host SHA-256 断言却读取 Windows 的 `\\home\\runneradmin\\...`，未指向 Cygwin 的实际目录。`ci_ssh_features.transfer_paths` 继续向产品传入 POSIX 协议路径，只将独立文件哈希观察映射至 `cygpath -w` 已解析的真实 Windows 目录，不修改或放宽断言。路径/服务/执行工具 22 项契约和本机真实 `TC-SESSION-SCP-001/002` 均通过（`workspace-native/run-20261026-071848-830827743`，`identity_stable=true`）；复用 QA v14 二进制，无产品构建输入变化。保留 [40243431702](https://github.com/engcapa/taomni/actions/runs/40243431702) 的运行结果，包含新场景的 374 ID 相关集需在修正工具映射的最终提交重新执行后，才进入全量。

2026-10-26 最新续验：同一栏的重复 Git 按钮已删除；共享编辑工具栏只保留“在 Git 中比较”，主导航条保留完整 Git 管理入口。`TC-WS-006` 增加数量断言，并继续执行六种 Git 视图、提交选项、多仓库和 Diff 切换，browser/native 定向复跑均通过。根目录行的重复入口也已移除，组件回归保护该边界。

在 `9fc7f4aa` 时本机有效回执核验结果为 **25 个 browser ID、6 个 native ID 全部通过**，无拒绝、过期或缺失结果，记录为 `_local/workspace-current-local-evidence.json`。Browser 主批次为 `workspace-browser/run-20261026-042552-094346821`，更新后的 Git 用例为 `run-20261026-043939-150540769`。Native 为 `workspace-native/run-20261026-042551-971492851`（4 passed / 1 SSH 服务未启动而 skipped）、`run-20261026-042848-716576587`（使用独立服务完整重跑冷启动恢复并通过）、`run-20261026-043110-456493505`（真实 GSS/SSH 与 SFTP 通过）及 `run-20261026-043939-464029535`（最终 Git 用例通过）。保留首次服务缺口，不计作通过；6 个 ID 在该版本的最新适用结果均为 passed。

目录选择定向运行 [40228782682](https://github.com/engcapa/taomni/actions/runs/40228782682) 的 macOS 已通过。后续三平台 5 ID 定向运行 [40230884973](https://github.com/engcapa/taomni/actions/runs/40230884973) 为 Linux 5/5、macOS 4/5、Windows 2/5，4 项失败、0 基础设施错误，未通过。Windows 的 Int32 动态绑定错误在 PowerShell 7 仍复现，版本判断未解决问题；将实际 Win32 枚举、所有者与按钮检查移入 C#，只把观察结果交回 PowerShell JSON 序列化。macOS 冷启动辅助脚本改为操作所属 QA 进程的原生关闭按钮；固定 WebDriver session ID 不再被误判为复用进程，必须观察到所属进程 PID 改变，且仍先验证原 bridge 端口释放、正常关闭与原 profile 恢复。

上述工具修复通过 29 项契约，本机 `TC-WS-006` browser 和 `TC-WS-030` native 完整复跑通过，均 `identity_stable=true`：`workspace-browser/run-20261026-045751-797253612`、`workspace-native/run-20261026-045751-351481537`。此前 browser 配置启动不需要的 SSH 容器时与并行 native 服务撞名，保留 setup 失败日志，改用无需服务的 Git 场景配置后通过。Windows/macOS 系统边界继续定向实测；通过后执行 373 ID 相关集，再执行全量。已核对全量为 619 个适用 ID，唯一外部项目缺口仍为用户确认单列的 `TC-IDE-C6-06`。

系统边界续验 [40233391400](https://github.com/engcapa/taomni/actions/runs/40233391400) 为 1 passed / 3 failed、0 基础设施错误：macOS 目录选择通过，第一次真实冷启动及恢复通过，第二次启动的初始连接被拒绝；Windows 已消除动态绑定异常，但原生 Edit 的 WM_SETTEXT 仅更新显示文本，未更新 Common Item Dialog 的真实选择。Windows 辅助工具改为向已确认所有权和焦点的目录字段发送原生键盘输入，再点击系统按钮；不向产品输入框回填结果。macOS 通过原生关闭按钮和所属进程退出码确认正常退出，再启动新 PID；连接错误分阶段记录，避免清理请求掩盖原始关闭错误。

本机续验 `workspace-native/run-20261026-051455-217700493` 暴露一次最新活动文件没有落盘的问题。重启工具此前在 WebDriver 上下文消失后立即结束进程组，可能打断仍在退出的 WebKit 存储子进程。现在正常关闭后检查所属应用和存储子进程实际结束，再释放适配器；不使用固定等待替代进程观察。首次观察误含仍需保留的 WebKitWebDriver 适配器而失败，已明确排除并加入所有权/适配器边界测试。完整复跑 `workspace-native/run-20261026-052420-817244670` 通过，两次重启分别观察到应用及两个 WebKit 子进程结束；标签顺序、活动文件、草稿和真实 SSH/SFTP/PTY 断言全部保留。

最终本机边界批次 `workspace-native/run-20261026-052700-755631105` 为 `TC-WS-022/026/030` **3/3 passed**，`workspace-browser/run-20261026-052700-646280947` 的 Git 回归 **1/1 passed**；回执与当前源码/runner 身份匹配，均无 skipped。工具契约 **57 tests passed**，包括实际子进程正常退出/超时、WebKit 适配器排除、macOS 初始连接与失败保留；`pnpm check:refactor` 通过。系统边界的 Windows/macOS 仍由下一次 GitHub 实测确认。

定向运行 [40236197565](https://github.com/engcapa/taomni/actions/runs/40236197565) 的 Linux 3/3、macOS 目录选择/入口归属 2/2 已通过；Windows 仍在执行，macOS 第二次冷启动失败。新阶段记录证明错误发生于第二次原生关闭后的 Broken pipe，之后 DELETE 的 ConnectionRefused 掩盖了该原始错误。移除未命中的启动重试，只在已取得所属原生关闭观察后接受 Broken pipe/连接重置，并要求该进程正常退出；清理错误单独保留，原始错误不能被替换。58 项契约通过，本机 `workspace-native/run-20261026-054543-828013276` 与 `workspace-browser/run-20261026-054543-633429900` 的完整冷启动/Git 回归各 1/1 通过。相关集和全量仍未通过，不以 job 的软成功代替用例结果。

Windows 在 [40236197565](https://github.com/engcapa/taomni/actions/runs/40236197565) 的 3 条目录相关用例均因辅助工具的字段读取失败，尚未通过。实际桌面截图证明路径已成功键入；`GetWindowText` 无法读取另一进程中 Edit 的实际内容，改用带超时的 WM_GETTEXT 读取，保留原生输入、所有权/焦点检查和产品返回路径断言。15 项目录工具契约通过，下一轮 Windows 原生执行验证最终选择路径；产品源码与 QA 构建未改变，无需为单独的 Windows 辅助读取重新编译应用。

macOS 完整冷启动定向 [40237170175](https://github.com/engcapa/taomni/actions/runs/40237170175) 已通过，聚合 `passed=true`、0 failures / infrastructure errors；两次关闭退出码均 0，所属 PID 6307→7433→8081。Windows [40237590690](https://github.com/engcapa/taomni/actions/runs/40237590690) 的目录选择和入口归属 2/2 通过，冷启动首次重启停在驱动端口释放：100ms 连接探测早于 Windows 对关闭 loopback 端口的明确拒绝。探测增加到最多 2s，仍必须收到拒绝才继续，超时/实际监听继续失败并保留探测原因。26 项定向进程/重启契约通过，本机 `workspace-native/run-20261026-061247-462240219` 两次重启及所有恢复断言完整通过。此前本机 workflow 工具集为 512 项中 511 passed / 1 平台 skipped，命令成功；该结果不是 UI 全量通过。

Windows 冷启动 [40239289178](https://github.com/engcapa/taomni/actions/runs/40239289178) 仍失败，诊断显示 2s 探测也只有超时而没有明确拒绝。故 Windows 改读实际 TCP 监听表：只有两个端口均无监听记录才继续；查询失败、结果不合法或尚有监听进程均明确失败，不以连接超时当作端口已释放。30 项进程/重启契约通过；本机 `workspace-native/run-20261026-063644-324532334` 完整冷启动回归通过。相关集 [40239319086](https://github.com/engcapa/taomni/actions/runs/40239319086) 的三平台 browser 已全部通过，Linux/Windows/macOS 分别 258/258、258/258、257/257，native 仍在执行；该运行使用此前 runner，保留结果而不作为最终全量通过。

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
