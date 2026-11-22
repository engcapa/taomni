# File Explorer 新建可编辑文件与 Live 表格修复（2026-11-17）

File Explorer 保留新建文件夹和原文本文件入口，工具栏“新建 → 其他文件类型…”与目录空白处右键“新建其他文件…”共用类型选择对话框。类型来自 `classifyFile` 的可编辑扩展名与约定文件名清单，涵盖 Markdown/HTML/SVG、文本与配置、源代码、Dockerfile/Makefile 等，不提供只能预览的 PDF/位图或未知二进制格式。可以选择类型并更改当前目录下的文件名；普通扩展名自动建议未占用的编号，成功后按后端实际路径选中并进入原重命名流程。特殊约定文件名冲突要求另选名称；输入重复名、路径或不支持的扩展名时保留对话框，不覆盖既有文件。IPC 失败可更正重试。新建 `.env` 等隐藏配置后自动显示隐藏项，以便选中并重命名。创建为空文件，双击使用已有编辑器；HTML/SVG 可进入源码编辑，代码沿用 Code Workspace 路由。

Live 表格此前直接使用 `textContent` 展示单元格，导致 `**` 等源码显示而未渲染。现由独立 TableCell owner 管理单元格渲染、源码编辑、IME、粘贴与图片异步生命周期：只读及未激活单元格调用共享 Markdown inline parser/sanitizer、KaTeX 和受控图片加载；激活可编辑单元格显示原源码，离开后恢复渲染。保留 Tab/Enter、行列/对齐、历史和标准 GFM 保存。渲染和焦点切换不写文档，非目标更新不覆盖正在组合的中文输入，同一单元格并发变更拒绝迟到的 IME 提交；编辑/销毁使旧图片结果失效。

## 当前验收

当前复验绑定 `396b7bb294e0c4ccbc17871ac71eca246d5cfc0d`；Linux/Windows browser 的文档提交 `2621bae0081d3c0a6f96ab87a92c094cad0f463f` 与其产品/runner 输入相同。产品源码指纹为 `c35b48e6018a22744215dcd62f63f41f3e60313e810e3ea06be53f1c97f186bf`、runner 指纹为 `10bb03145a467fbea7f9e9ea784d5e226469d9613a95acba250fd7f4974ce8a8`。下表各轮 plan 均已通过并下载 selection，全部保留完整 crash-regression、gaps=[]/unreviewed=[]；native 使用 release QA。完成 shard 即下载，逐份核验原始 receipt、完整 artifacts、case digest、selection/run/source 和 native build 身份；没有用计划数或缺失结果代替通过。

| GitHub run | 范围 | 计划用例 / shard | 状态 |
|---|---|---|---|
| [44128316716](https://github.com/engcapa/taomni/actions/runs/44128316716) | Linux Xvfb、Windows native | 各 43，合计 8 shards | 8/8 片已核验：Linux 43/43；Windows 42/43；两端完整 crash 各 24/24，Windows 外部 Shell Paste 超时另列 |
| [44142742009](https://github.com/engcapa/taomni/actions/runs/44142742009) | Windows native 定向复验 | 25，4 shards | 整轮成功，25/25、完整 crash 24/24，Explorer005 全 73 步通过 |
| [44128351358](https://github.com/engcapa/taomni/actions/runs/44128351358) | macOS 15 Intel native | 44，1 shard | 整轮成功，44/44、完整 crash 24/24，三态真实自动 relaunch 全部通过 |
| [44128388069](https://github.com/engcapa/taomni/actions/runs/44128388069) | macOS 26 ARM64 native | 44，1 shard | GitHub 容量取消，producer 没有任何执行步骤；无应用用例结果 |
| [44130389617](https://github.com/engcapa/taomni/actions/runs/44130389617) | macOS 15 Intel browser | 35，1 shard | 整轮成功，35/35、完整 crash 20/20，Explorer002 全部 152 步通过 |
| [44145215361](https://github.com/engcapa/taomni/actions/runs/44145215361) | Linux、Windows browser | 各 35，合计 8 shards | 整轮成功，各 35/35、完整 crash 各 20/20，8/8 片全部核验 |

最新 Linux/Windows native 的 006（153 步）、007（131 步）、029（68 步）均通过；已查看两端新建对话框及 Live 表格原始截图，类型/名称/取消/创建控件完整，粗体、斜体、删除线、代码、公式、换行、列对齐与 escaped pipe 正常。macOS browser 的同三项及修订后的 Explorer002 均通过，也已查看对应表格与窄窗口预览画面；browser 画面不代替 AppKit/OS 输入证据。两端 native 的模块 013/014/015 均通过。

Windows 原轮唯一失败 `TC-EXPLORER-005` 停在第 25 步外部 Windows Shell `InvokeVerb('paste')` 的原有 30 秒 PowerShell 超时。第 24 步及 Paste 前的独立读取已验证准确 CF_HDROP 路径；实际剪贴板写入、解析和 Paste 脚本均与 main 相同。`host_clipboard._ps` 的新增参数保持该调用原默认值、命令和超时；Explorer `copy` 分支未改。保留原始失败、截图、`system-file-paste.jsonl` 与逐文件对照 `windows-explorer-005-unrelated-failure.json`，按用户授权作为本次改动无关的外部自动化失败单列，不声称已完成 main 复现或确定唯一 OS 根因。同 SHA 的定向复验已核验 4/4 片、**25/25**，包含完整 24 项 crash 集合及 Explorer005 的全部 73 步；未改产品/用例、扩大超时或弱化断言。按相同 source/runner/case digest 的最新结果合并，Windows 所选 43 项均取得通过证据；原 #44128316716 workflow 仍为 failure，不能改写成单轮 43/43。

最终矩阵保存于 `qa-ui-auto-report/github/file-feature-current-matrix.json`：browser 三端各 35、Linux native 43、Windows native 43（上述两轮按 case 合并）、Mac Intel native 44，六个执行范围均通过完整 crash 集合。逐 run 的 `workflow-result.json` 保留 GitHub 真实结论；ARM64 缺口使 `all_four_release_targets_verified=false`。该矩阵不代表整个模块化迁出或发布验收完成。

最新 ARM64 producer 的原始 check annotations 已保存为 `runner-capacity-annotations.json`：明确报告 hosted runner 未获配及 macOS ARM64 capacity constraints，`steps=[]`。这是未执行的覆盖缺口，不能由 Intel 或旧 ARM64 部分通过替代。

较早恢复轮 [44124269305](https://github.com/engcapa/taomni/actions/runs/44124269305) 绑定 `daa1fc0bd4ccd22d24247a19f0c75d41e0ed72bf`、runner `dc27dfdbdb09b317ba3e1c6af8c8a591e40acc03b4aa1882dbe33682e5a4b6a8`，产品源码与当前相同：Linux/Windows native 各 43/43、各完整 crash 24/24，8/8 片全部核验，整轮成功。同一旧 runner 的 [Intel 44124347927](https://github.com/engcapa/taomni/actions/runs/44124347927) 也已成功结束，4/4 片全部在运行期间下载核验，**44/44**、完整 crash **24/24**，含 033/034/035 三态真实自动 relaunch。新建文件与 Live 表格均通过，已查看该端对话框和表格截图。两轮保留原 SHA/runner，不能回写为最新 runner 执行。

browser 的首次补跑 #44128421025 因输入误带 native 专用 ID，被规划器明确拒绝，未执行任何应用用例；已按首轮实际 macOS browser 的准确 35 项集合重新调度为上表 #44130389617，完整 crash 集合保持。原规划失败日志保存在对应 run 的 `plan-failure.log`。

同产品源码的首轮 `750f6f417528c25fb813bdd547c36c69239e7079` 使用 runner `bccd320420dc81388adea1107b3de937643ebf4309ea659fd7d16367d3ad7eb2`，原始计划和结果保留如下，不能把未执行项记为通过：

| GitHub run | 平台与模式 | 实际结果 |
|---|---|---|
| [44119120276](https://github.com/engcapa/taomni/actions/runs/44119120276) | Linux Xvfb、Windows，browser/native | browser 各 35/35；两份 release QA build 成功，但未选中的 ARM64 模块 builder 因容量取消，native 8 片未执行 |
| [44119238192](https://github.com/engcapa/taomni/actions/runs/44119238192) | macOS 15 Intel，browser/native | browser 34/35、完整 20 项 crash 全过；release QA build 成功，但旧四目标签名包被 ARM64 容量取消阻断，native 未执行 |
| [44119201895](https://github.com/engcapa/taomni/actions/runs/44119201895) | macOS 26 ARM64，native | 未执行应用用例；native producer 未获配 runner 后被 GitHub 容量取消 |

三轮计划均合并完整 crash-regression；额外覆盖 Explorer001–007、Live 表格029、保留 Markdown 和 main 新增的导出/格式回归、Workspace085/096/097、真实 MySQL 结果搜索与 Tao 配置/provider 用例。Tao045/046 现有 case 只声明 Linux/Windows native，保留在恢复批次中，不外推 macOS。静态计划 gaps=[]/unreviewed=[]；全部真实结果必须另核验 receipt、完整 artifacts、case/selection/source/build 身份与截图。

首轮运行期间已下载并逐份核验 8 个完成的 browser shards：Linux、Windows 各 **35/35**，各含完整 20 项 crash-regression，零失败/skip；全部 artifact hash/bytes、receipt、case digest 与 CI outcome 的 source/selection/run 绑定均通过。记录为 `qa-ui-auto-report/github/44119120276/hosted-evidence-review.json` 和 `post-main-review.json`。已查看 Linux 新建对话框、029 Live 表格与用户 testing.md 的实际截图，控件和格式正常。该轮全量前端单元 **7399 passed / 1 skipped，869 files passed**、Linux Rust contracts **197/197** 和 Windows helper contracts **26/26** 的原始 producer 日志也已在运行期间下载至 `live-producers/`；两份 release QA build 成功不代替尚未执行的 native UI。

模块打包的 Darwin 构建仍固定 `macos-latest`，排队超过十分钟后阻挡了所有依赖签名模块的 native shard。补充 `qa-modular-packages.yml` 的 hosted macOS runner 选择和平台 workflow 转发；source job 先校验固定允许清单，再调度两个明确 Rust target，保持包平台与签名审查。纯工具/工作流单元 **29/29** 和 actionlint 已通过；实际恢复批次另行补录。此修改不改变产品源码和用例预期。

2026-11-18 再次 fetch/merge main，远程仍为 `677ec4d77`，无冲突。进一步确认旧四目标模块打包会让 Linux/Windows 聚焦验证等待未选中的 macOS builder；platforms 现传递计划的 native build matrix，仅为需要 `signed-module` 的实际平台/架构构建和签名，多个 Linux profile 去重。独立打包及未传该参数的升级调用仍保留四目标，签名 job 的可信工具 checkout、凭证隔离和清单审查保持。相关工具/工作流单元 **37/37** 已通过；最新 Linux/Windows run 已实际只构建和签名选中的两个目标并进入应用用例。

Intel browser 首轮为 **34/35**，唯一 `TC-EXPLORER-002` 在恢复宽窗口后紧接 Alt+P 时未隐藏预览。trace 显示两者相隔约 50 ms；预览实现与 main 相同，尚未确认事件根因或建立 main 复现。本轮仅在原快捷键前断言窄窗口 overlay 已退出，作为宽布局操作的前置条件，保留后续隐藏/重开、创建、拖动和删除全部断言，reviewed 步号同步为 152 步。上述 #44130389617 已完整重跑通过 152 步及 35 项集合，旧失败保留。

首轮 Linux GitHub native Rust contracts 已通过 **197/197**，包含实际非空的 `deepseek_app`、迁移及 Workspace 过滤；原始日志位于 `qa-ui-auto-report/github/44119120276/live-contracts/contracts.log`。这不代替 native UI 运行。

再次合并远程 main `677ec4d77` 后，保留双方 Markdown 修复和实际编辑器回归测试；本页 Live 表格场景改为 `TC-FILE-OPEN-029`，main 的 native 导出操作场景继续使用 `TC-FILE-OPEN-023`。下列旧 run 与 171 项结论绑定合并前的产品源码指纹；合并后的匹配 browser/native 与完整 crash-regression 须另行记录。旧 SHA 的单作业 #44110689605 已在应用用例开始前结束，其未执行项不计通过。

合并后相关前端单元 40 文件 **274/274**、QA 工具 **68/68**、TypeScript、catalog、check:refactor 及 852 个唯一用例的完整 audit gate 已通过。新增 Workspace 场景 WS-096 补充切回当前目录的真实点击、唯一 radio 选中和名称输入框隐藏断言，未修改 coverage baseline。上述属于本地单元与静态验证，新的真实多端结果另行记录。

修正 035 探针后的 [Intel #44095029967](https://github.com/engcapa/taomni/actions/runs/44095029967)（`0dfdfb159caa31b65ba239fd80917c79acee02e0`、selection `563142a953e24addbe9a5089798eec0f`）已成功结束，4/4 分片在 summary 前收齐，34/34、零失败/skip，含完整 24 项 crash-regression。全部 artifact 的 hash/bytes、receipt、source/runner/selection、实际 case digest/计数与 release QA 身份已核验，详见 `qa-ui-auto-report/github/44095029967/hosted-evidence-review.json`。与下述已核验的 137 项共同覆盖三端 browser/native，目前共 171 项通过；macOS native 此结论限定 Intel macOS 15，ARM64 不能由此记为通过。

ARM64 [#44095086934](https://github.com/engcapa/taomni/actions/runs/44095086934) 仅一片实际执行，8/8 通过；其余三片在任何步骤前因 GitHub 无法分配 hosted runner 而取消，原始容量注释保存在该 run 的 `runner-capacity-annotations.json`。按用户允许临时使用更高版本的要求，workflow 增加官方 `macos-26` ARM64 选项，保留原用例/digest、完整 crash 集合和准确 release 架构；不由新版外推 macOS 15 ARM64 兼容性。

首轮 [macOS 26 #44102464430](https://github.com/engcapa/taomni/actions/runs/44102464430) 的实际构建身份为 **macOS 26.7.2 ARM64**。第 2 片在 summary 前下载并核验全部原始 artifact/receipt/身份/计数，**8/9**：033 完整三态之一的运行中模块自动 relaunch 通过，旧 PID 8432 exit=0、新 PID 9178，原密码/HOTP 和 writer lease 通过。既有 `TC-FILE-OPEN-007` 在 step 50 的原生 HTML Save chooser 识别失败；导出实现和 OS chooser 工具与 main 的 git blob 完全一致，同一用例在主验收 Intel 批次通过。按用户允许忽略无关失败的要求单列，保留 `macos26-unrelated-export-failure.json`；不计为通过，也不将这轮称为完整 macOS 26 crash 验证。另三片约 15 分钟未获得 runner，已调度相同 34 项的[单作业补跑 #44110689605](https://github.com/engcapa/taomni/actions/runs/44110689605) 后取消旧轮；旧轮未执行项不算通过。补跑 selection `86b156b3d84e40519ebc0500fcbef709`、相同产品/工具指纹和全部 case digest，1 个 native shard、release QA、gaps=[]/unreviewed=[]，即时收证已启动，结果待完成。

产品修复 `2939a224e178563be0a4425127760e3460d62f08` 的 [GitHub #44071094242](https://github.com/engcapa/taomni/actions/runs/44071094242) 已核验 20 个实际执行分片，共 137 项通过、零失败、零 skip。三端 browser 各 25/25（各含完整 20 项 crash-regression），Linux Xvfb 与 Windows native 各 31/31（各含完整 24 项 crash-regression）；新 006/007、023 与保留场景全部通过。原始 artifact 的 hash/bytes、runner receipt、源码/用例/selection 和 native release QA 二进制身份已独立核验，记录在 `qa-ui-auto-report/github/44071094242/hosted-evidence-review.json`。已查看本轮 Windows browser 与 Linux/Windows native 新建对话框、Live 表格和 macOS browser 表格画面，控件与 inline 格式正常。

该 workflow 的 macOS ARM64 build 因 GitHub hosted runner 容量不足，在任何步骤前被取消，4 个 native 分片未执行，整轮 workflow 不计全绿。[Intel 补跑 #44077458265](https://github.com/engcapa/taomni/actions/runs/44077458265) 与 [ARM64 补跑 #44087810304](https://github.com/engcapa/taomni/actions/runs/44087810304) 均绑定 `481d59afda4791578da03699aecc7c55a4fa9f2a`；两者与原计划的 34 个 macOS native 用例集合和 case digest 完全一致，gaps=[]/unreviewed=[]，按完成分片即时收证。

Intel 4/4 分片已收齐，33/34 通过：文件新建/编辑/保存、Live 表格、全部保留用例与完整 crash-regression 均通过；已查看该端新建对话框和 Live 表格截图。唯一失败是 035 的第 95 步错误调用另一个场景的 `qa-retained.txt` 固定文本探针，本场景实际通过真实宿主创建并备份 `hello.sqlite`，未创建该文本文件。自动 relaunch 已成功，完整还原仍不计通过。修正保留 signed/lifecycle、完整业务行、generation、active pointer、writer lease、Vault/MFA/HOTP 和单次确认断言，并在 `ui-restored` 独立核验准确 SQLite locator、`dataRetained=true`、完整数据库字节和原始档案 hash；不更改原业务数据、不插入额外文件。新单元先复现错用场景和漏检，再验证拒绝缺失/伪造 locator、链接和 SQLite 尾部变化。相关工具 71/71、QA audit、actionlint 和 check:refactor 通过；修订后的真实执行另行补录，旧失败保留。

上述产品修复与 QA 修订的产品源码指纹均为 `ad584d3171fd61ae23f88b0c4de9f78370e908144b1d60baf8639fca40d068aa`；QA 修订分别处理旧 HTTP 连接和 035 的场景探针，runner 指纹绑定各自 selection，035 的修订另以实际 case digest 记录，不能把新结果回写到旧失败批次。macOS 结果必须按实际架构记录，browser/bridge 输入不代替物理 IME、AppKit 菜单或 OS 快捷键验证。本功能验收也不代表模块化整体迁出、真实单体升级激活或正式发布门已完成。

验收分工：

| 证据 | 断言 |
|---|---|
| `ExplorerShell.newFile.test.tsx` 与原 Explorer 单元 | 完整类型清单、两入口、取消、选择/重命名/打开、扩展名编号、输入校验、冲突和失败重试；浏览器 DOM/mock，不代表 native 文件效果 |
| `TableWidget.test.ts`、原 markdownWidgets/MarkdownEditor 等单元 | 改前四项失败已复现；格式/安全/公式、焦点不写源码、单元格编辑与历史、IME/并发和迟到图片清理 |
| `TC-EXPLORER-014` browser/native | 两入口、类型菜单、取消/错误/冲突/重试、代表类型空文件（含隐藏配置）、重复 Markdown 命名、独立 VFS/host 字节。合入 #829 前的执行记录沿用原编号 `TC-EXPLORER-006`。合入 #859 前的一段执行记录使用 `TC-EXPLORER-010`，合入 #865 之前使用 TC-EXPLORER-012 |
| `TC-EXPLORER-013` browser/native | 新建 Markdown/HTML/SVG/JSON/TS 的实际路由、编辑、保存、关闭重开/代码恢复，独立完整字节；包含 crash-regression。合入 #863 之前使用 TC-EXPLORER-011 |
| `TC-FILE-OPEN-041` browser/native（历史编号 023、029、033、037） | Live/Split 格式一致、HTML 清理、本地图片、公式、只读、编辑、Tab、Undo、Redo、未改单元格与完整 GFM 保存重开，包含 crash-regression |
| 保留用例 | Explorer001–005；FILE-OPEN001/003/004/007/013，覆盖旧文本/文件夹/操作、SVG与Markdown原合同和 native 导出；workflow 合并完整 crash-regression |

真实 UI 和 native 磁盘/进程验证全部在 GitHub `qa-ui-auto-platforms` 执行，三端 browser/native、匹配 release QA binary，完成一个 shard 即下载检查。未执行的用例不得记为通过。WebView 按键与 composition 单元不等于物理 IME、AppKit 菜单或 OS 快捷键证据；单元格 Select All 的平台、焦点与菜单边界见下方记录。截图仅是保留证据，需要另外查看画面。

## 调试与执行记录

首次 [#44053218016](https://github.com/engcapa/taomni/actions/runs/44053218016) 在规划阶段的 `test_crash_regressions` 失败：新增两项 crash-regression 未同步固定 EXPECTED 清单和 smoke 注册，没有执行应用用例。补齐两项注册与专项说明，保留全部原集合和断言，修订后重新执行三端 browser/native。

[#44054414878](https://github.com/engcapa/taomni/actions/runs/44054414878) 按完成片下载，发现三项操作需要适配：006 对列表中心右键命中文件行，改为通过可见目录筛选得到无匹配空白区并右键其空状态，创建后清除筛选；007 刷新后先按既有启动行为切回 Code Workspace，再核验真实 loose 文件和完整字节；旧 004 编辑表格先点击激活源码并断言原值为 `1`，再替换为 `2`，保留保存和导出断言。同步全部 verification 步号，不扩大超时或修改预期数据。Linux native 构建前的四 profile 选择合同另有一份固定 smoke 清单遗漏，同步新两项后通过原失败单元。

已查看该轮 Linux browser 原始截图：新建对话框的类型、名称、取消/创建控件均完整可见，Live 表格显示粗体、斜体、删除线、代码、公式和换行，列对齐正常。截图审查仅对应这两张已执行画面，三端最终结论仍以修订后的 matching runner 结果为准。

修订后的 [#44058015738](https://github.com/engcapa/taomni/actions/runs/44058015738) 绑定 `5cbd077c158cbdfcc4480607bcaf142e5c60edad`，selection `5f73d60ba9084aed9ede82b855441882`。文件功能、模块三态还原/自动 relaunch 和完整 crash-regression 合并执行：三端 browser 各 25 项，Linux Xvfb/Windows native 各 31 项，macOS ARM64 native 34 项；24 shards、3 份 release QA build，gaps=[]/unreviewed=[]。即时下载已在规划时启动。修订后 CI 选择/crash 合同 31/31、还原观察器 6/6、842-case audit 的全部请求 gate 和 check:refactor 通过；未改 coverage baseline。这些是工具/静态结果，应用结果仍须逐片核验。

按片核验 `44058015738` 的 12 个 browser shards：Linux/Windows/macOS 各 25/25，无 skip。原始 artifact 的 bytes/hash、receipt、source/runner/selection/build 身份与实际计数已独立复核，详情保存在 `qa-ui-auto-report/github/44058015738/hosted-evidence-review.json`；该轮 native 尚在执行。

旧 `44054414878` 的 Windows 和 macOS native 首片进一步复现两处问题：完整 HTML 逐字键入触发自动闭合后重复 `</h1>`；Live 表格 Ctrl+A/Command+A 未选中单元格源码，导致替换变成追加。两处均保留原始失败与完整预期数据。产品修复在 TableCell 内限定活动、可编辑、非 IME 单元格的 Select All，Windows/Linux 为 Ctrl+A、macOS 为 Command+A；只选择当前源码，不写文档/历史，不处理 macOS Control+A、Alt/Shift 或只读上下文。没有新增菜单项或 accelerator，沿用原 Edit 菜单路由；单元和 case 检查 WebView 输入，物理 OS Select All、AppKit 菜单点击与真实 IME 仍未由此证明。

完整 HTML 的 case 改为显式 `fill: {method: paste}`，保持自动闭合功能、HTML 字节预期及保存重开断言。工具在 browser 使用 Chromium 剪贴板与普通 Paste 按键，在 native 独立写入/读回 OS 剪贴板后发送一次真实 OS Paste；不通过 DOM、store、IPC 或文件直接灌入，不重放失败输入。为避免异步 Paste 读取到旧剪贴板，隔离 runner 保留 fixture 内容并记录 `fill-paste.jsonl`。Windows 独立文本读回保留首尾空白，避免丢失源码最后换行。补充工具/错误分支及 schema 单元 44/44、表格回归 13/13；最初 Select All 红测 2 项失败已保留。`TC-FILE-OPEN-023` 增加准确选区断言并平移原所有验证步号。HTML 在保存前新增完整行断言以等待真实 Paste 完成，保留原磁盘/重开断言。原 markdownWidgets/MarkdownEditor 21/21、TypeScript 和 check:refactor 通过。上述新改动的三端应用结果须由下一轮 matching source/runner 复验后补录。

[#44063469863](https://github.com/engcapa/taomni/actions/runs/44063469863) 使用产品修复 `8659eca951bbcdee8ee7f4d691dc97bf690fbf1c`、selection `b05a05e9b4a04408b150a895d0358168`。browser 已逐片收齐：Linux/macOS 各 25/25；Windows 24/25，其中 007 在任何 Paste 之前被工具的剪贴板读回检查拒绝。原始 Playwright trace 明确请求文本为末尾 LF、Windows Chromium 读回末尾 CRLF。工具仅在 Windows browser 接受 Chromium 的标准 LF→CRLF 表示转换，保持所有其他字符和空白；Linux/macOS 继续严格比较。没有修改 editor/disk 字节预期或后续完整行/保存/重开断言。增加对应先红后绿的工具回归；`44065226283` 在规划阶段取消，用于合并此修正和模块观察器 null-error 修正后统一复验。取消批次不计为通过。

统一工具修正的 [#44066113956](https://github.com/engcapa/taomni/actions/runs/44066113956) 绑定 `e65496400b807262301d0af5309be3c9befcda50`、selection `93425e14a0104e76bcc2021ee6dbbdc5`，产品源码指纹与 `44063469863` 相同。browser 三端各 25/25，12/12 shards 的原始 artifact/receipt/身份/计数已核验，Windows 007 的 CRLF 问题已实际复验通过。该轮仍须收齐 native，不能把 browser 当 native 证据。

`44063469863` 的 Windows native 007 已通过完整创建、编辑、磁盘保存重开及 Code Workspace 恢复。023 的 Select All/替换也通过，但后续 Undo 只撤掉一个字符；原输入轨迹同时显示单词间空格被删、光标回到开头，使 token 顺序变化。根因是单元格逐字提交后马上把 GFM parser 去掉 padding 的结果写回正在输入的 DOM，以及提交标成不可合并的 `input` 历史事件。补充两项红测精确复现尾部空格丢失；修复在同步提交期间保留拥有的 DOM/caret，以 `input.type` 合并连续键入，在每个单元格编辑会话首个实际变更前隔离历史，粘贴保持独立历史边界。非自身的 Undo/Redo/外部更新仍同步，既有 IME 并发拒绝和迟到图片清理保留，其他 widget 默认历史语义不变。单元覆盖逐字符输入完整格式源码、空格、完整 Undo/Redo、单元格间历史边界和活动单元格恢复；`TC-FILE-OPEN-023` 另在 Tab 前增加整段原始源码准确断言，保留全部已有保存、重开、历史和字节预期并平移 verification 步号。表格/Markdown widgets 26/26、MarkdownEditor/model 19/19 与 check:refactor 已通过，修订后的实际三端验证另行记录。

输入/历史修复 `2939a224e178563be0a4425127760e3460d62f08` 的 [#44071094242](https://github.com/engcapa/taomni/actions/runs/44071094242)，selection `6099bb40a9d3433198213239af7ed2d6`，三端 browser 各 25/25，12/12 browser shards 的全部 artifact hash/bytes、receipt、source/runner/selection 身份及实际计数已核验。已查看本轮 Windows browser 新建对话框和 macOS browser 表格截图，控件无裁剪、各 inline 格式与列对齐正常。Linux/Windows native 继续逐片收证；macOS ARM64 build 在任何步骤之前被 GitHub 取消，check annotations 明确为 hosted runner 无法分配与 ARM64 容量约束，不记为测试通过，使用已有 `macos-15-intel` 恢复入口补跑。
