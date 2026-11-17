# File Explorer 新建可编辑文件与 Live 表格修复（2026-11-17）

File Explorer 保留新建文件夹和原文本文件入口，工具栏“新建 → 其他文件类型…”与目录空白处右键“新建其他文件…”共用类型选择对话框。类型来自 `classifyFile` 的可编辑扩展名与约定文件名清单，涵盖 Markdown/HTML/SVG、文本与配置、源代码、Dockerfile/Makefile 等，不提供只能预览的 PDF/位图或未知二进制格式。可以选择类型并更改当前目录下的文件名；普通扩展名自动建议未占用的编号，成功后按后端实际路径选中并进入原重命名流程。特殊约定文件名冲突要求另选名称；输入重复名、路径或不支持的扩展名时保留对话框，不覆盖既有文件。IPC 失败可更正重试。新建 `.env` 等隐藏配置后自动显示隐藏项，以便选中并重命名。创建为空文件，双击使用已有编辑器；HTML/SVG 可进入源码编辑，代码沿用 Code Workspace 路由。

Live 表格此前直接使用 `textContent` 展示单元格，导致 `**` 等源码显示而未渲染。现由独立 TableCell owner 管理单元格渲染、源码编辑、IME、粘贴与图片异步生命周期：只读及未激活单元格调用共享 Markdown inline parser/sanitizer、KaTeX 和受控图片加载；激活可编辑单元格显示原源码，离开后恢复渲染。保留 Tab/Enter、行列/对齐、历史和标准 GFM 保存。渲染和焦点切换不写文档，非目标更新不覆盖正在组合的中文输入，同一单元格并发变更拒绝迟到的 IME 提交；编辑/销毁使旧图片结果失效。

## 当前验收

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
| `TC-EXPLORER-006` browser/native | 两入口、类型菜单、取消/错误/冲突/重试、代表类型空文件（含隐藏配置）、重复 Markdown 命名、独立 VFS/host 字节 |
| `TC-EXPLORER-007` browser/native | 新建 Markdown/HTML/SVG/JSON/TS 的实际路由、编辑、保存、关闭重开/代码恢复，独立完整字节；包含 crash-regression |
| `TC-FILE-OPEN-023` browser/native | Live/Split 格式一致、HTML 清理/本地图片/公式、只读、编辑/Tab/Undo/Redo、未改单元格与完整 GFM 保存重开；包含 crash-regression |
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
