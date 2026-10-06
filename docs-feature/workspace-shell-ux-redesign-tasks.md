# Workspace Shell 实施任务

设计：[详细设计](./workspace-shell-ux-redesign-design.md) · [用例](./workspace-shell-ux-redesign-test-cases.md)。

领取者：Codex。基线：`5fb098474f072f4e0c7e99407ab0d072b7d49c53`，分支 `feat/ui-layout-refactor`。
用户已授权实现、本地单元测试、Windows 11 browser/隔离 native 回归、推送及 `qa-ui-auto-platforms` browser/native 循环验证。
状态：`todo` → `in_progress` → `verification` → `done`。用户于 2026-10-05 明确确认：本轮以实现完成和同一最终输入的六端自动化全部通过为 done 条件；真实 OS 文件对话框、Windows/macOS 真 IME、DPI/跨屏/读屏及匹配性能基线单列后续验收。未自动化项保留完整规格与未验证状态，不计为自动化 pass。

用户于 2026-10-06 排除 LAN Chat 测试。当前最终范围为 **290 ID / 875 次**：browser 三端各 218，native Linux 77 / Windows 71 / macOS 73。TC-001 的 More 改验通用容器展开/收回；B06/B38 移除 LAN 分支并保留其它动作、结果和预算；N20 不选择。旧 291 ID / 878 次报告完整保留，不作为新范围的完成证据。

| 任务 | 状态 | 依赖 | 交付 / 验证证据 |
|---|---|---|---|
| TASK-01 契约与纯模型 | verification | 无 | 类型、身份、尺寸策略、Shell store；unit 与最终六端验收 |
| TASK-02 壳层布局集成 | verification | 01 | Rail / Navigator / MainLayout / ControlBar；最终六端验收 |
| TASK-03 标签与 action 路由 | verification | 01,04 | lane、总览、快速切换、快捷键；最终六端验收 |
| TASK-04 实例与关闭事务 | verification | 01 | stable surface、close coordinator、DB adapter；最终六端及真实 SQL 验收 |
| TASK-05 SFTP 与任务 ownership | verification | 01,04 | view/job lease、后台、promotion；最终六端及独立文件/协议观察 |
| TASK-06 Workspace / Git | verification | 01,04 | Project、tools、Git Host；最终六端及真实单/多仓库验收 |
| TASK-07 Tao / 通知 | verification | 01,04,05 | Hub、目标解析、成功后确认；最终六端及 AI HTTP/SSE 验收 |
| TASK-08 Home / 恢复 | verification | 01,03,10 | 三主动作、最近项、组合恢复；最终六端验收 |
| TASK-09 原生窗口 | verification | 04,05,06,07 | Git、detach 事务、回停靠；三端实际 native 验收 |
| TASK-10 持久化与回退 | verification | 01,04,07 | v2 migration、SQLite 确认保存、恢复 identity；本机 N08 精确重启恢复通过，待新输入六端验证 |
| TASK-11 用例与自动化支持 | verification | 随相关实现 | 本轮新增 B46～B52、N23，适配既有入口用例与 catalog/policy；新输入六端待验收 |
| TASK-12 集成与验收 | verification | 02–11 | 本机前端 534 文件 / 5301 项全部通过，Rust 1603/0/16 既有 ignored；聚焦 browser 403 步通过；新输入 GitHub 六端待完整验收 |

## main 合并与审阅补齐（当前批次）

本批已合入 `origin/main` 的 `a90a0bd3`、截图增量 `307c6322` 和 QA 桌面增量 `bc130eee`；冲突和功能整合已完成。补齐恢复错误、Panel 路由、关闭部分成功摘要、总览检索/定位、壳层回退与扩展契约及用例缺口；按用户要求移除本地终端 Rail Git、Tao 悬浮球、旧顶部 Tab 预览与左上角展开入口，窗口抓手放在右上角系统区。四向 Dock/隐藏、完整沉浸、统一 Project 入口、按能力展示标题栏及 Java 工作区切换复用已实现。输入 `8bc41266` 的 [291 ID / 878 次完整六端回归 37342130547](https://github.com/engcapa/taomni/actions/runs/37342130547) 已结束，为 **873 pass / 5 fail / 0 skip**；SQLite N08 三 native 端真实重启与独立磁盘观察通过。后续输入 `9a10118a` 的 [三端 native 精准回归 37353593967](https://github.com/engcapa/taomni/actions/runs/37353593967) 为 **16 pass / 2 fail / 0 skip**，IDE-027 三端全部 70 步通过；Linux N5 编码前画面差异和 macOS N12 源位移不足仍待新输入复验。当前批次继续 verification，历史通过不代替最终同输入六端验收。

### 当前精准复验与 macOS 录屏定位

输入 `b23f2da3` 的 [六端精准 run 37393821741](https://github.com/engcapa/taomni/actions/runs/37393821741) 为 **26 pass / 1 fail / 0 skip**：browser 三端各 3/0/0、403 步；native Linux/Windows 各 6/0/0、90 步，macOS 5/1/0、89 步。身份、receipt、构建及原始 ZIP hashes 匹配；Linux 原图发布和 macOS N12 高视口验证通过。macOS N7 的 802 ms 采集停顿超出原时间断言；同输入 [区分 run 37395892565](https://github.com/engcapa/taomni/actions/runs/37395892565) 再次 5/1/0，N7 有 1068 ms 采集停顿、全零 RGBA 原始帧及两帧比对失败。GIF 与失败 raw PNG 完全一致，差异在编码前；内部原因尚未确定，不再以原样重跑作为恢复依据。

候选只在 QA trace 增加 macOS 快照/provider/copy/conversion 有界阶段耗时与图像尺寸信息，不改变原像素、采集时间戳或固定断言。待定位并恢复后，执行最终 **290 ID / 875 次**统一输入六端回归，实际审阅 **126 张 UI 原图及 12 张录屏差分**；新增 12 张是 LAN 排除后 TC-001/B06/B38 的共享入口画面。LAN Chat 按用户要求排除，历史记录保留。TASK-01～12 仍为 verification。

## 上一批次实施进度（历史）

TASK-01～12 已全部 done。最终产品/runner/用例输入为 `98ddf0182c74e53dbeb8b3c196e0ff02169020c2`；[完整六端 run 37247775178](https://github.com/engcapa/taomni/actions/runs/37247775178) 已成功结束，250 ID / 761 次实际执行为 **761 pass / 0 fail / 0 skip**，33,090 步全部完整通过。三个 browser 端各 190/0/0，native Linux 68/0/0、Windows 62/0/0、macOS 61/0/0。六份原始报告与源码、runner、用例、配置、receipt、native build 及 ZIP hashes 匹配，严格 gate 通过；72 张当前 Shell 截图已实际审阅。本地前端 526 文件 / 5244 项已按原始全量报告和完整编辑器重跑核对通过；前序 Rust full unit 为 1590 pass / 0 fail / 16 既有 ignored，本轮截图诊断相关 Rust unit 52/52 与日志观察 unit 5/5 通过，TypeScript 与相关静态检查通过。历史失败和未验证边界完整保留。

早期完整 [run 37231369098](https://github.com/engcapa/taomni/actions/runs/37231369098) 的六份原始报告为 759 pass / 2 fail / 0 skip；browser Linux/Windows 各 190/0/0、macOS 188/2/0，native Linux 68/0/0、Windows 62/0/0、macOS 61/0/0。失败为 macOS B07 延迟身份绑定抢导航与 B17 在 ready 前读取状态。两条在修正输入的 [三端 browser 复验 37236895398](https://github.com/engcapa/taomni/actions/runs/37236895398) 各 2/0/0，17+27 步完整执行，共 132 步通过；最终六端运行也全部通过。N08 的 stored/rendered 精确 232 检查在三端精准 run 37233544174 和最终六端运行通过，旧 248px 未复现，根因未确定；未据此声称完成了产品持久化修复。

最终完整范围为 250 个独立 ID：browser 三端各 190，native Linux 68 / Windows 62 / macOS 61，共 761 次执行。范围包含 Terminal、SSH、DB、Code Workspace、SFTP、AI Chat、全部截图回归和 Git Panel；LAN Chat 为入口与草稿的轻量范围。最终列表为 `qa-ui-auto-report/_local/shell-ci-case-ids-final-307.txt`；269 的旧 249 ID 列表保留。新增一个既有 RDP Server 用例保护本轮共享 host_helper 修改，数量以固定输入的 selection 核对。按用户要求，本地只运行单元测试和静态检查，browser/native 与原生构建通过 GitHub 执行。

新增用例不等于整条设计规格全部验收。N01/N13/N14 的自动化部分复用既有 case；N11 的实际 OS picker/权限/UNC、Windows/macOS 真 IME、DPI/读屏与 N17 匹配性能基线仍有证据缺口。按用户明确确认，这些项单列后续验收，不阻塞本轮实现和六端自动化范围的 done；其自身未记为 pass 或已验收。详细映射在 [用例登记](./workspace-shell-ux-redesign-test-cases.md#current-execution)。

N21/N22 分别以真实多仓库和单仓库操作验收 Git；新增七条既有 DB browser 用例补足离线 renderer 工作流。历史完整 [run 37237715943](https://github.com/engcapa/taomni/actions/runs/37237715943) 为 759/2/0，macOS 两项失败为 RDP 探针遇到尚未释放的旧连接，以及 GIF 录屏时间轴缺帧；原始失败截图和逐步记录保留。RDP 用例增加最新连接生命周期的释放检查，最终三端原独立协议探针均通过。录屏增加 QA 独立采集/排队诊断，最终三端全部原断言通过；旧 macOS GIF 缺帧未复现，根因仍未确定，未声称完成了产品缺帧修复。

输入 `bc8b06f1bbde025683514b4d8aab99dbcfc801a8` 的 [macOS 精准复验 37243895415](https://github.com/engcapa/taomni/actions/runs/37243895415) 为 4/1/0。N5～N8 四条录屏通过；RDP 的第 62 步误把“释放日志必须是最后一行”作为条件，实际释放后还持续输出延迟统计。随后改为观察最新连接生命周期记录的断开状态，5 个 jsdom 单元观察样本通过，原独立协议探针、63 步和 480 秒预算保持；最终三端 native 复验通过。

## 上一批次六端验收（历史）

<a id="final-acceptance"></a>

| 平台 | Browser pass/fail/skip | Native pass/fail/skip | 实际步骤数 browser / native |
|---|---|---|---|
| Linux | 190/0/0 | 68/0/0 | 8,298 / 2,897 |
| Windows | 190/0/0 | 62/0/0 | 8,298 / 2,664 |
| macOS | 190/0/0 | 61/0/0 | 8,298 / 2,635 |

最终 [workflow](https://github.com/engcapa/taomni/actions/runs/37247775178) 为 completed / success；原始报告的逐 case 结果独立核对为 761/0/0。selection 的 gaps/unreviewed 为空；严格 gate 同时验证六份完整报告、250 ID、当前 source/runner/case/config、receipt 与实际 summary、native binary/build recipe 及原始产物 hashes。`step-review.json` 对照每份原始步骤与对应 YAML，33,090 步无缺失、重排或失败。

证据根为 `qa-ui-auto-report/workspace-shell/github/run-37247775178/`，包含原始 ZIP 与 receipt，以及 `selection-review.json`、`evidence-review.json`、`final-automated-gate.json`、`step-review.json`、`module-review.json`、`oracle-review.json`、`recording-review.json`。模块登记覆盖 Terminal、SSH、DB、Code Workspace、SFTP、AI Chat、截图、Git Panel 与轻量 LAN Chat；其六端所选用例均没有 fail/skip/unrun，模块计数存在交叉，不相加推定额外覆盖。

三端 native 的 AI HTTP/SSE provider receipts 均精确为 5 requests / 5 streamRequests / 5 toolRequests、1 cancelledStreams、3 completedStreams、最后消息 `SHELL AI recovery`。Git 的最终 HEAD/index/worktree/branches、SQL committed rows、SFTP 外部 growing/stable 文件与协议 bytes、应用退出进程观察满足各自原断言；原始 polling 的暂时不满足样本保留。

72 张代表性当前截图已实际审阅（browser 每端 11，native 每端 13），记录在 `qa-ui-auto-report/_local/shell-visual-review-37247775178/reviewed-*.json`；捕获状态未见主要控件明显遮挡/裁切。macOS N7 的原图/实际/差分 contact sheet 也已查看，长停留 frame 37 进入编码，最长 unexplained gap 为 166 ms，原 700 ms 上限保持。Linux GIF 的满队列合并样本也完整保留，原逐帧和时间轴断言通过；不把所有采集帧都编码作为已建立结论。

按用户明确确认，本轮 done 条件已满足；真实 OS picker/权限/UNC、Windows/macOS 真 IME、DPI/跨屏/读屏和匹配性能基线继续在 [后续独立验收](./workspace-shell-ux-redesign-test-cases.md#follow-up-acceptance) 标为未验证。本次收尾仅修改文档，产品、runner、用例及构建文件与验收输入一致，验收产品 SHA 保留为 `98ddf018`；分支交付不等于合并或发布。

## 验证记录

以下按批次保留当时的输入、结果和失败；早期计数与状态是历史记录，当前状态以上面的进度及后续最新验收为准。

设计阶段只有静态文档检查通过，产品与运行时改前基线尚未执行。
实现阶段复用现有 Welcome / TabBar / ControlBar / sidebar / Tao / detach 的回归测试；新增纯逻辑覆盖尺寸降级、迁移损坏、实例幂等、关闭失败。
最终远程验证检查 selection、逐 case pass/fail/skip、receipt 与源码身份，不以 workflow 总体绿色代替用例通过。

### 首批集成输入（30 个可执行用例）

- 26 browser + 4 native 已登记到 CI policy；用例语义已按实际动作与结果审查。首批范围只覆盖 YAML 中明确列出的分支，62 条设计用例尚未完整实现。
- 本地：129 项 Shell/Main/Welcome/SessionEditor 单测、239 项 Code Workspace 回归、Notes 实际编辑器保留回归与 9 项 runner 契约通过。ChatDrawer 回归 31 项通过。
- SFTP 低高度、Notes 唯一编辑器、100 标签首轮失败已修复并重跑通过；证据在 `qa-ui-auto-report/workspace-shell/browser/run-20261004-041532-176837200`。源码后续变更后，以后续运行确认最终身份。
- 全仓 `cargo fmt --check` 存在既有未格式化文件；本次两个 Rust 文件已用 rustfmt 处理。没有把旧文件格式差异计为本次 Rust 检查通过。
- 首次 native 编译完成，但构建期间输入变化被 provenance 拒绝，不能用于 native 通过证据；待稳定输入重建。

### GitHub 首轮与第二批修复（2026-10-04）

- 首轮：[run 37152585554](https://github.com/engcapa/taomni/actions/runs/37152585554)。精确 selection 为 26 browser + 4 native；Linux browser 26/0，Windows/macOS browser 各 25/1；Linux native 2/2，Windows/macOS native 各 1/3（pass/fail），均无 skip。原始 summary、receipt、selection 与 ci-summary 位于 `qa-ui-auto-report/workspace-shell/github/run-37152585554/`。workflow job 绿色不代表所有 case 通过。
- B30 在 resize 后等待实际断点状态再断言；N02 使用原生 CSS 选择器与真实 xterm 输入框。原生子窗口复用 QA WebView 数据目录，解决 Windows handoff 与窗口发现失败。macOS URL 查询改用原生窗口 API，并在选中窗口后等待应用 ready。
- 修复 Workspace 恢复时隐藏 Separator 被参与布局排序所导致的 `Panel constraints not found for index 3`；隐藏 tool area 的 handle 随可见性卸载，业务 Panel 实例保持。B04 本地真实 reload/restore 路径通过。
- 第二批新增 B04/B14/B15/B20/B21/B22，总计 32 browser + 4 native 可执行；B14 覆盖五个 dirty 关闭入口的取消与 undo 保留，B15 覆盖实际编码写入失败及重试。B15 首轮注入旧写入命令造成无效故障，已改为 `workspace_write_file_encoded`，本地执行通过；失败运行保留。
- Windows 匹配 build-3 的 N02/N05/N06/N08 四条 native 通过，证据 `qa-ui-auto-report/workspace-shell/native/run-20261004-050917-404019100/`。后续源码已修改，需要 build-4 和新运行；上述证据只证明其记录的输入。
- 当前 focused Extract 回归 14 项通过，runner 窗口/尺寸契约 11 项通过。完整 CodeWorkspace/Terminal 上轮 311 项通过、3 项失败：splitter 预期已更新并通过，两个 Extract 失败在 focused 整组重跑通过；后续完整收尾仍需稳定输入检查。
- 未执行的范围仍包括：12 条 browser、14 条 native 设计用例及已登记用例的未实现分支、OS/IME/读屏手工边界、匹配性能基线。不能以当前 36 条 YAML 代替 62 条设计场景，TASK-01～12 保持 in_progress。
- 第二批收尾：QA build-4、TypeScript/前端构建成功；Windows N02/N05/N06/N08 全部通过，源码身份稳定，报告 `qa-ui-auto-report/workspace-shell/native/run-20261004-052341-161431600/`。Shell/Main/Welcome 聚焦单测 91 项通过；case/catalog audit gate 通过（静态检查，仍列出未触达控件）。检查 N05/N06 截图：1280×800 下标题与状态栏无遮挡，Git 底 Host 与正文可读；不代表所有视觉/读屏/DPI分支通过。

### 第二轮 GitHub 与旧用例适配（2026-10-04）

- 第二轮：[run 37155160043](https://github.com/engcapa/taomni/actions/runs/37155160043)。32 browser 三端全部通过；Linux/Windows native 各 4/4，macOS native 2/4。macOS N05 的子窗口脚本等待超时、N08 受桌面尺寸限制（1280×684）；已补 page-load 跟踪和测试桌面分辨率设置，尚待第三轮远程验证。完整原始报告在 `qa-ui-auto-report/workspace-shell/github/run-37155160043/`。
- 对当前 HEAD 的旧用例 diff 逐步骤检查：121 条入口迁移用例的 modes、步骤数量与非入口业务步骤完全保留；只把旧 Sessions/Tools/Settings 控件切换到 v2 Rail/Navigator。另行更新 Main Rail、IDE merged rail、SFTP 独立主标签、终端 gutter 和 Notes 的布局/持久化契约。当前总计 131 个既有 YAML 有修改，具体 ID 和审查结果在 `qa-ui-auto-report/_local/retained-case-ids.json`、`shell-retained-inventory.json`。
- browser 实际发现并修复两个 Project 问题：Shell 中隐藏 Project 后树仍可见；内部旧 Panel collapse 冻结已移动到 Navigator 的树。真实 mounted 回归验证文件节点、隐藏/重开及相同 DOM。新增 `shell_navigate` 只读取可见性并点击真实 Rail/Page，避免重复入口把 Navigator 关闭；runner 契约 4 项通过。
- 恢复原有宽屏 Tao Ribbon，其点击/拖动委托同一 Hub 和 Shell 布局 owner。旧 TC-NOTES-005/006 与 TC-MAIN-RAIL-01/02 browser 全部通过，报告 `qa-ui-auto-report/workspace-shell/browser/run-20261004-072934-545485400/`；同一运行 B41 失败，保留失败证据。
- B41 暴露 Top→Bottom 移动后覆盖层仍引用旧宿主导致内部点击关闭 Hub。已修复 listener 的宿主依赖，并以真实 ShellFrame/StableSurface mounted 回归验证移动后的输入保留与外部点击关闭。B41 完整四边、pin、opacity、Notes 全文、窄屏返回与 reload 流程通过，报告 `qa-ui-auto-report/workspace-shell/browser/run-20261004-073818-199830900/`。此前持久化尚未完成的断言失败也保留，现改为观察实际写入就绪后检查。
- 当前可执行 Shell YAML：37 browser + 5 native。数量不代表全部设计分支完成。新 B06/B25/B27/B32/B41/N07 与各自 native/manual 边界在用例文档中继续细分；没有把 missing 分支或手工检查标为通过。
- 本地 Shell/Main/Welcome/ControlBar/Terminal/Chat/Notes/RecentWorkspace 聚焦单测 18 files / 264 tests 通过（`shell-product-unit-10.log`）；Project 新 mounted 回归 1 项通过（`shell-hosted-project-unit-11.log`）；覆盖层移动回归 1 项通过（`shell-overlay-unit-13.log`）。完整 CodeWorkspace 单测仍在检查，`shell-codeworkspace-unit-12` 中止且无完整结果，不能记通过。
- Catalog/schema/control audit-10 全部静态 gate 通过：required 917，covered_required 876，orphans 6；没有降低 baseline。103 条受影响旧 browser 用例已启动，报告 `qa-ui-auto-report/workspace-shell/browser/run-20261004-074027-635498200/`；完成后逐失败分析。Windows QA build-8 已启动，构建/运行期间固定产品输入。

### 当前统一开发批次（2026-10-04；待 GitHub 验收）

- 真实 SFTP paused/cancelled 边界先 drain WRITE ACK 再发布状态，避免 pause 后远端继续增长；`shell-sftp-rust-unit-47` 的 7 项 Rust 单测通过。历史 UI 失败保留，最终原生效果由下一轮 N03/N15 验证。
- workspace composer 以 saved identity/order 恢复，最多并行 4 项，部分失败保留成功 owner；取消/迟到回复和用户主动导航不抢焦点。`shell-restore-unit-51` 5 项单测通过，B04/B42 已补独立分支。
- `RetainedPrimaryView` 保留 LAN、MFA、SocksCap、Proxy 和 network tools 的 DOM/草稿并暂停隐藏 effects；`shell-retained-utility-unit-53` 66 项通过，B38/B43 保留真实业务操作。
- 首次全量前端单测 `shell-product-unit-all-57`：5192 项中 5185 通过、7 失败。SftpPolish 补齐 jsdom ResizeObserver，FloatingNotesPanel 更新 operationId 契约；两文件 23 项通过。CodeWorkspace 的 5 个异步失败保持原产品与断言，聚焦 16 项和完整文件 241 项均通过；最终组合以 `shell-product-unit-all-68.json` 的全量结果为准，尚未完成前不记全量通过。
- runner 最终本地单测 `shell-runner-unit-71` 53 项通过，覆盖 CI selection、导航、clipboard/SQL/process/file picker 的外部边界、几何、窗口和 SFTP fixture。TypeScript `shell-types-58` exit 0。
- 静态 audit-70 暴露新增控件归属及 F1.3 Split/MultiExec 托盘入口漏测，已补 catalog 与 B33 实际操作；不降低 coverage baseline。最终 audit/契约结果及 GitHub commit/run 随验收回填。

- 单测收尾：全量 `shell-product-unit-all-68` 的 521 个文件 / 4951 项全部通过，仅编辑器文件 3 项失败。修复测试异步 dispatch 与拆分 8 个独立故障场景后，完整 `shell-editor-final-unit-77` 248/248 通过；两份原始结果共同覆盖当前 5199 项，不改写失败 JSON，也不将 unit-68 标为通过。仅测试编排改变，产品代码自 unit-68 后未改变。`shell-types-final-78` exit 0。
- 最终静态 `shell-final-static-gate-76` 通过：required 967、covered_required 922、shallow 41、orphans 4；原 baseline 619/614/46/9 保持不变。57 条 Shell schema/reviewed contract 通过；7 条既有 DB 用例的缺失契约已按实际 SQL/UI 动作与结果补齐并通过静态检查。`shell-final-ci-plan-80` exit 0，精确规划 198 ID，无 capability gaps。20 条既有 case 的 needs-review/legacy-imported 标签仍在 selection 中明确列出，不从 schema 或入口迁移推断全面验收。
- TASK-01～12 进入 verification，下一步以统一提交的 SHA 执行 GitHub browser/native。手工/外部及性能缺口仍保持未验证。

### GitHub 第三轮（已完成；修复中）

- 提交：`bf4d6639489d3379a041bd1d477b0d9c199f4cdc`；[run 37178495569](https://github.com/engcapa/taomni/actions/runs/37178495569)，`publish_issues=false`。
- plan 的 runner、catalog、policy gate 通过；已下载的 selection 确认上述 SHA，无 capability gaps。三端 browser 各 156（44 Shell + 112 保留），native Linux 50（13 Shell + 37 保留）、Windows 44（12 + 32）、macOS 43（12 + 31）。仅 Linux 包含真 IME case N10。
- 原始报告保留在 `qa-ui-auto-report/workspace-shell/github/run-37178495569/`；6/6 报告的 source identity、selection、receipt、artifact hash 均已核对通过。Linux/macOS browser 各 146 pass / 10 fail，Windows browser 148 / 8；Linux native 35 / 15，macOS native 23 / 20，Windows native 23 / 21，全部无 skip。workflow 的绿色不能替代以上 case 结果。
- 本轮修复初次/重连 SSH 提示符被 banner 覆盖、总览 rename 自动焦点、点击区尺寸、DB rollback 关闭反馈、邮件已读响应竞态。更新旧 native Sessions 入口、SFTP owner 范围、菜单入口和持久化等待，保留业务断言及 1-based 验收映射。
- runner 修复 newline/Mod 输入、Linux Unicode 原生 clipboard paste、MySQL env 配置解析、子窗口关闭/中断及退役 handle，并精确清理当前 Windows QA profile 的 WebView2 进程。macOS 显示配置改为 session 生效，运行前另行验证实际 NSScreen；原生效果待新 GitHub 输入验证。
- 增加 B45/N19：Home 全局 AI 对话、流式发送、隐藏完成提示、精确跳转、草稿和历史；N19 使用只监听 loopback 的 OpenAI 协议 fixture，通过实际 Rust IPC/SQLite 与进程重启验证，包含真实 provider 503 和下一次发送恢复。browser 回复明确标记 IPC preview stub，不当作 native 证据。N20 轻量检查 LAN history 入口和同一 owner 的拒绝启用状态。
- 用户指定的截图模块已扩大到全部 TC-SHOT browser/native 用例；当前选择 240 个独立 ID，最终每端数量以新 selection 为准。补充范围的 runtime 结果尚未建立。
- 本地单测原始证据：`shell-product-repairs-unit-98` 62/62，`shell-runner-final-unit-101` 119 pass / 9 平台限定 skip（128 总数），`shell-ai-product-unit-104` 71/71，`shell-ai-runner-unit-105` 16/16。全局历史修复后的最终 AI 单测、类型和静态检查另行回填；旧失败日志保持原样。

### 第四轮输入收尾（待远程验收）

- 最终 AI / Shell 单测 `shell-ai-final-unit-111.json` 72/72 通过；TypeScript `shell-types-final-113` exit 0；受影响 Rust 文件 `rustfmt --edition 2024 --check` 通过。没有在本地启动 browser/native 或进行原生构建。
- `shell-static-final-112` audit gate 通过：required 967、covered_required 922、shallow 41、orphans 4；baseline 未调整。`shell-dev-contract-114` exit 0，正常 Git `diff --check` 无错误。以上均为静态或单元测试证据。
- `shell-ci-plan-108` 精确选择 240 个独立 ID，无 capability gaps：browser 三端各 183（45 Shell、27 Screenshot、111 其他保留），native Linux 65 / Windows 59 / macOS 58（分别含 15 / 14 / 14 Shell，三端各 13 Screenshot）。共 731 次平台/模式执行，尚未记为 runtime pass。
- 本轮继续要求最终 SHA 的 selection、逐 case 结果、receipt、source identity 与 artifact hash 全部相符；TASK-01～12 保持 verification，未补齐的 OS/IME/读屏及匹配性能证据仍显式保留。

- 第四轮远程验证已启动：[run 37186026272](https://github.com/engcapa/taomni/actions/runs/37186026272)，输入 `986c2016d5361f22e609fc4601193956ef6d7bfa`。已下载 selection，身份和 6 个 entry 数量与上述计划一致；运行中，尚未作通过结论。
- 等待远程构建期间补充 N21 原生 Git 操作：stage/unstage、Commit Cancel、选定文件提交到新分支、真实 Log 与 Discard Cancel/Confirm。独立 Git oracle 只读本例仓库，禁用 optional locks，记录 exact branch/HEAD/status/blob；不以 UI 成功提示代替磁盘结果。`shell-git-unit-119` 21/21 通过；最终 `shell-git-product-final-123` Git Panel / Workspace Git 回归 33/33 通过，`shell-git-types-124` exit 0；N21 schema/reviewed contract 与三端 native CI plan 通过。该补充尚未包含在第四轮已冻结的输入中，下一轮选择增加到 241 ID。

### 第四轮 browser 结果与候选修复

- 已核对 3/3 browser 报告的 selection、源码身份、receipt 和 ZIP 内的 artifact hashes；全部匹配，无 hash errors。Linux / macOS 各 175 pass / 8 fail，Windows 176 / 7，三端各 183 条且无 skip。native 报告尚未返回，不能据此完成桌面验收。
- 修复同一保存会话的重复标签继承原标签 pin/lane 偏好；保存连接的首个 live owner 持有恢复偏好，新副本保持独立，原 owner 关闭后剩余实例接管。修复活动工作区模型晚绑定时漏记 last-active restore identity。
- `shell_navigate` 先等实际 Rail 挂载再读取可见性，避免 React 初始挂载期间把默认展开的 Navigator 关闭。B37 保留 anchored/exactly-once output，用目标标题前缀兼容 cwd 自动后缀；B43 使用生产规范 folder path。旧 Settings 用例先改为 35 并核对保存，再改回 20；B04 显式清除 legacy session candidate，仅恢复其明确打开的工作区。
- 本地 `shell-browser-repairs-unit-130` 120/120、`shell-browser-runner-repairs-131` 27/27 通过；TypeScript `shell-browser-final-types-132` exit 0；静态 `shell-browser-final-static-133` gate 通过（required 970 / covered_required 925 / shallow 41 / orphans 4），baseline 未改。61 条 Shell YAML 及上述 Settings case 的 schema/reviewed contract 均通过。下一候选先远程验证这 8 个失败 ID，再合入 native 实际结果的修复批次。

### 第四轮完整结果与本次修复批次

- [run 37186026272](https://github.com/engcapa/taomni/actions/runs/37186026272) 的 6/6 报告已核对 selection、source identity、receipt 与 ZIP 内 artifact hashes，全部匹配。共 731 次执行：667 pass、64 fail、0 skip。三端 browser 结果见上文；native Linux 55/65、Windows 43/59、macOS 43/58 通过。workflow success 仍不代表 case 全部通过。
- `2c5a6eacf7583020d539bf97a8d8b7b495016b59` 的 [browser 定位 run 37188658984](https://github.com/engcapa/taomni/actions/runs/37188658984) 包含 8 个 ID，六种旧失败中的导航、duplicate 偏好和恢复问题已在三端通过；剩余 TC-011、B37、B43 为实际 ControlBar 几何及新标题/菜单选择器问题。Linux/macOS 各 5 pass / 3 fail，Windows 6 / 2，身份和 hashes 匹配且无 skip；保留广播 exactly-once 与业务结果断言。
- Linux 原生输入器为 `_`、引号等符号补真实 Shift，并让 Unicode form/textarea 使用完整 OS paste 后才恢复 clipboard；修复 N12 的 `qa_shell_tx` 被输入成 `qa-shell-tx` 和 N07 的中文重复输入。Windows 当前候选沿用精确 QA profile 的进程清理；旧轮 WebView2 锁文件失败尚需新运行确认。
- macOS 在 fixtures 完成后才启动 QA app，session 结束立即释放进程；WKWebView 使用每个隔离 profile 的持久 UUID store，同一 case 的窗口/重启共享，reset 后新 case 换 store。AI fixture 写入实际 `com.taomni.app.qa/taomni/ai.json` 配置路径，Linux 保持 XDG 路径。
- 修复 MySQL 查询取消：单连接事务 owner 的 SQL 使用独立控制连接执行 `KILL QUERY`，等原命令响应结束后再报告取消；失败连接不回池。N12 的独立 PROCESSLIST 零条 SLEEP 断言保持不变，三端效果待远程验收。
- 修复带生产工具目录的 OpenAI 请求走真实 SSE，按字节解析 UTF-8、并行 tool call 分片、usage、结束标记和 provider error。已经发出文本的 key/group 流不会切换 provider 重复输出；N19 独立 receipt 要求 4 次真实 stream 且 4 次含 tools，503 恢复、持久历史和进程重启断言保留。
- SFTP 镜像只广播窗口拥有的任务，合并时保护推进的字节/终态并保留 owner 元数据；重复完成 snapshot 不刷新 finishedAt，避免队列广播循环与存储写入风暴。N04 的真实并行字节、文件 hash、隐藏/中断/回停靠和取消断言及原有时间预算均保持；scope 区分当前 child 与隐藏全局队列。
- Mail catch-up 已缓存新 headers 后立即发布到达通知，不再等待可选 flags reconcile；N16 Navigator hide 点击区固定 28×28；N03 等实际 tab 删除后核对精确数量；N15 Cancel 后通过 quick switch 返回 Build 数据库 owner 并核对完整 SQL/Pending；LAN 入口适配当前 testid。
- 本地 `shell-runner-unit-142` 共 95 项，86 pass / 9 平台限定 skip；`shell-mail-unit-144` 48/48、`shell-sftp-unit-146` 32/32、最终同步/幂等/重试/接管 `shell-sftp-owner-unit-155` 8/8、Shell 布局/关闭/持久化 `shell-layout-unit-150` 24/24 通过。`shell-types-final-156` exit 0；62 条 Shell/改动 case 的 schema/reviewed contract 通过。以上不是 browser/native 运行证据。
- 全后端单测 `shell-rust-unit-145` 首轮 1583 pass / 4 fail / 16 ignored，完整保留日志。修正四条旧测试的 Windows absolute path、隔离的不存在路径、canonical verbatim prefix、读取目录时原生 Permission 分类假设，保留迁移数量、hash、字节意图及零写入效果断言；不改变这些模块的产品路径处理。最终 `shell-rust-final-unit-153`：1587 pass / 0 fail / 16 原有 opt-in ignored，exit 0。新增真实工具 stream/parser/fallback 与 MySQL 取消响应单测均在其中通过。
- 控件增加 B43 实际动态 group testid 的 alias 并重新生成 catalog；未调整 baseline。此前 static-154 的 stale-catalog 失败日志保留，最终 `shell-static-reviewed-157` gate 通过（required 970 / covered_required 925 / shallow 41 / orphans 4）。受影响 Rust 格式和 Git diff check 通过。
- 下一次统一三端 browser/native 选择 241 个 ID，预期 browser 各 183，native Linux 66 / Windows 60 / macOS 59，共 734 次执行，以实际 selection 为准。全部单测与静态检查通过后提交、推送、验证并继续修复；任务保持 verification。

### 第五轮与 AI 停止保留契约补充

- 第五轮 [run 37193142141](https://github.com/engcapa/taomni/actions/runs/37193142141) 固定输入 `85a1d57b48e803bb2d81d61fdace45b140ab784b`，已提交并推送。selection 核对为 241 ID、上述六端 734 次执行，`gaps=[]`、`unreviewed=[]`。运行中，尚未建立完整 runtime 结果。
- 核对停止逻辑的改前源码：失败/停止不持久化 assistant 回答是既有契约，不能把它误记为工具 SSE 重构引入的数据丢失。本轮保留该语义、用户消息与发送队列，补充实际停止验收。
- B25 增加声明的 browser IPC hold→Stop→排队发送完成一次；N19 增加真实 SSE 部分回答→排队→Stop→实际连接取消→下一请求完成→重启历史。独立 provider receipt 要求 5 次真实 stream/tools 请求、3 次完成、1 次取消；重启只恢复 3 个完整 assistant 回答，不重发。没有提高原 150/180 秒预算或放宽既有断言。这些新增分支不在第五轮冻结输入中，待下一候选远程执行。
- 本地 `shell-ai-stop-unit-161` 4 files / 80 tests、`shell-ai-provider-unit-162` 6 tests 通过；后者用真实 stdlib HTTP 客户端关闭测试连接验证服务端取消记录，未启动 browser/native app。`shell-ai-stop-types-163` exit 0；两个修改 case 的 schema/reviewed contract、`shell-ai-stop-static-164` audit gate 与 Git diff check 通过。静态 coverage baseline 未变，任务仍为 verification。

### 第五轮 browser 与 AI 定位结果及修复

- 第五轮三份 browser 报告均为 180 pass / 3 fail / 0 skip（每端 183）；selection、source/case identity、summary receipt 与 ZIP hashes 均匹配。三端失败相同：B01 Rail 按钮高度 36px 低于 40px，B43 返回 Sessions 后折叠状态丢失导致导入组不可见，IDE-PARITY-024-01 仍断言旧 Rail 宽度 59px。native 三端尚在运行，不能从 browser 结果推断通过。
- Rail 按钮改用设计要求的 48/40px；应用根字号 12px 导致原 Tailwind rem 高度实际只有 36/30px。IDE 的名称模式宽度按已经确定的设计下限 68px 适配，保留 compact 52px、键盘 resize、Move/Remove、焦点及快捷键全部业务断言。
- Navigator Sessions/Tools 保持挂载并隐藏非活动页面；改前新增 mounted 回归确实失败（`shell-navigator-baseline-unit-167`），修复后同一树/行 DOM、展开、选择与 scrollTop 均保留。B43 新增返回 Sessions 后展开组及子行仍可见的验收，保留 import/export 的完整数量及取消检查。
- AI 定位 [run 37194738007](https://github.com/engcapa/taomni/actions/runs/37194738007)，输入 `67d73c154abe6a32f2f06d211a04ded98123eac8`，六份 receipt/identity/hash 均匹配。browser 三端各 1/1；native 三端各 0/1，在 N19 step 40 因 fixture 导出相对路径被再次拼接 case dir 而失败。此前真实部分 SSE、排队、Stop 与停止状态均已执行；恢复及重启后的全部检查未执行，不能记通过。独立 Linux provider receipt 记录 5 次 stream/tools、1 次取消、3 次完成。fixture 现导出绝对且归属 run-root 的 receipt 路径，并新增相对 case dir 回归。
- 本地修后 `shell-navigator-final-unit-170` 5 files / 30 tests、`shell-ai-path-unit-171` 7/7 通过；TypeScript `shell-navigator-types-172` exit 0；B43 与 IDE-024 的 schema/reviewed contract 通过。`shell-navigator-static-173` gate 通过（required 971 / covered 926 / shallow 41 / orphans 5）；随后为真实 queue badge 补 control 归属，baseline 保持不变。仍需最终候选 GitHub 执行，TASK-01～12 保持 verification。
- queue badge 归属及 catalog 同步后，最终 `shell-queue-catalog-static-174` audit gate 通过：required 972 / covered 927 / shallow 41 / orphans 4；45 个 required 未触达控件仍在静态报告中明确列出，不能把 gate 通过表述成全覆盖。

### 第五轮 native 结果与第六轮候选

- 第五轮六份报告已收齐：browser 三端各 180 pass / 3 fail；Linux native 61 / 5，Windows native 51 / 9，macOS native 50 / 9，均为 pass/fail 且零 skip。source/runner/case/selection/receipt 与 native build 匹配。每份 native archive 的 36 个缺失 hash 都是 fixture `.git` 默认被 artifact upload 排除；本次启用 `include-hidden-files`，保留 profile/cache 排除和全部 hash 验证，待新运行核对。
- browser 定位 [run 37196090363](https://github.com/engcapa/taomni/actions/runs/37196090363)，输入 `0fb69b44d1dae1d9c62aa5c408219d105d50a2f1`，每端 B01/B05/IDE-024 通过，B43 在 export 文件验证因相对 fixture 路径重复拼接失败，各 3 pass / 1 fail / 0 skip。身份、执行配置、receipt 和 archive hashes 匹配。本次 runner 在创建 fixture/harness 前统一绝对化 report/case 根，并用三个单测保护文件读取及 failure trace 相对链接。
- N16 Close 控件使用真实 28×28px 点击区。macOS N04/N05 重建同 label 子窗口时清除旧 page-load readiness，并等待本次 navigation 完成；N15 使用已安装的 AppKit Quit 菜单，其余端仍点真实 renderer Exit。N08 先点正常 Exit、确认、独立 PID 已退出，再重启原 profile，继续精确 232px Navigator 与工作区恢复断言。
- N20 在实际 LAN 入口激活 VaultGate 后设置密码，保留拒绝 enable/read-only history 与同 owner 返回。N21 改为真实两个 root，以独立 aux 仓库验证隔离，并验证完整 local branch 集合；N22 单独覆盖真正 single GitPanel 的分支 Cancel/Confirm、stage/unstage、直接 Commit、Log 精确文件集与 Discard Cancel/Confirm。用例契约见 [N21](./workspace-shell-ux-redesign-test-cases.md#v-n21) / [N22](./workspace-shell-ux-redesign-test-cases.md#v-n22)。
- Windows IDE-027-02/03 旧用例默认窗口处于 medium，却要求宽屏常驻 Navigator/Project。本次固定 1280×800、等待实际 wide 模式，保留原尺寸、Files 单实例、合并与偏好断言。N15 保存 SFTP 后重新导航 Sessions，再等待并操作可见目标，保留真实传输、事务、取消和退出效果。
- MAIL-IDLE-01 原生三端仍缺通知：新增计数/阶段及 UID 协议观察以区分事件、sync、filters 和通知路径，不记录邮件正文/认证。Windows TC-155 SSH 真实输出出现 `bash: cho: command not found`，仍需区分输入/ConPTY；没有增加原超时、尝试数或放宽 first-column clipboard 断言。
- 本地：`shell-runner-contract-unit-180` 52/52，`shell-native-repairs-unit-181` 4 files / 80 tests，`shell-window-load-rust-unit-177` 1/1，`shell-native-repairs-types-182` exit 0。180 中 taskkill OEM 文本解码的后台异常已修为读取 bytes，随后 `shell-runner-unit-187` 56/56 无该异常。受影响 Rust 格式与 Git diff 检查通过，全仓既有 Rust 格式差异仍未计为通过。
- 最终 `shell-static-191` audit gate 通过：required 975 / covered 930 / shallow 41 / orphans 4，baseline 未改；45 个未触达控件继续明确列出。`shell-plan-192` 六端 selection 为 242 个 ID、737 次执行（browser 各 183，native 67/61/60），gaps/unreviewed 均为空。早期 viewport 断言使用不支持的参数已被静态检查拒绝，修正为已有 wait_for 契约后上述检查通过。
- 以上为候选实现与本地 unit/static 结果，尚不是第六轮 runtime 通过。TASK-01～12 保持 verification；远程先验证精确失败集及新 Git case，再用最终固定输入执行统一三端集合。

### 第六轮工具契约修复

- [run 37199342505](https://github.com/engcapa/taomni/actions/runs/37199342505)，输入 `26efb101875ebce46ebe517206ccde60f3d1bbd5`，在 plan 的 QA tools 单测阶段被两条旧 taskkill 测试拦下，未执行任何 browser/native case。旧 mock 仍返回字符串并要求 `text=True`，与修复后的 bytes 输出不符；该运行不是产品用例结果。
- 修正旧 mock/参数预期，并加入中文 OEM 错误 bytes 下仍报告失败、保留 owned PID、下一次清理能成功的回归。新增测试第一次在重试成功路径缺少 profile-owner mock，局部单测明确失败；补上外部过程 mock 后，相关 isolation/transport 单测 40 项，38 pass / 2 平台限定 skip，exit 0。没有启动实际 browser/native app。继续以新 runner 输入触发同一精确失败集。

### 远程路径与导出契约定位

- 继发定位 [run 37199680203](https://github.com/engcapa/taomni/actions/runs/37199680203)，输入 `05588c93cfeaa7bbd7deba6a985166f4351a9eff`，plan 单测和静态 gate 通过；selection 为 browser 每端 5、native 每端 13，共 54 次执行，gaps/unreviewed 为空。
- Windows/macOS 的 browser/native 四个 job 在 Git fixture 单测阶段拦下，均未执行 UI：导出的仓库已经 canonicalize，但测试拿它与尚未 resolve 的临时目录作词法比较。macOS 临时目录别名与 Windows runner 目录映射暴露此问题；本次对双方 resolve 后继续验证 primary/aux 都归属 run-root，未放宽边界。相关三个工具模块本地 22/22 通过。
- Linux browser 4 pass / 1 fail / 0 skip，身份、配置、receipt、hashes 匹配；B43 现在能独立读取 export 文件，后续失败是 fixture 的 `auth: agent` 字符串不符合 v1 的 `auth: {kind: agent}` 契约，导入 fallback 变成 password。对整个文件禁止 `password` 单词也会误伤合法认证类型。本次修正输入格式，并要求七个 export auth 都精确为 agent；为 qa-alpha seed 明确的 proxy 凭据样本，检查该值和各 session 的 password/proxyPass 字段全部缺席，保持七条 session 与取消/导入断言。
- 本地 `shell-export-unit-203` 47/47，使用生产 parser/serializer 证明 agent round-trip 与凭据排除；`shell-static-204` gate 通过，coverage baseline 未改。Linux native 的旧输入仍在执行，用于收集邮件阶段/UID 诊断；下一运行先恢复 Windows/macOS 的实际用例执行。

### 邮件、退出与真实 Git 证据修复

- `37199680203` 的 Linux native 最终为 9 pass / 4 fail / 0 skip，receipt、source/case/runner/config/native build 均匹配，archive hash errors 为 0。失败为 MAIL-IDLE-01、N08、N21/N22。独立 IMAP 协议与应用诊断确认 UID 31–33 已 catch-up，newUnseen 为 3；消息 FLAGS 中的 `$Junk/$NotJunk` 被写成 folder attributes 后，INBOX 被误判为 Junk，通知计数降为 0。
- [Windows/macOS 复验 run 37200740481](https://github.com/engcapa/taomni/actions/runs/37200740481) 输入 `238ee3093385386ceb7c560166f223c3a875c60f`。browser 两端各 5/5；native Windows 9 pass / 4 fail、macOS 7 pass / 6 fail，全部无 skip。4/4 报告的 source/runner/case/selection/receipt/config 与 native build 匹配，hash errors 为 0。Windows TC-155 本轮通过，旧首字丢失证据仍保留，最终统一运行继续验证。
- Mail 同步保持 LIST 的 mailbox attributes / delimiter；EXAMINE 的 message FLAGS 单独命名，不再作为目录角色。初次或未缓存同步从真实 LIST 获取，之后多步复用元数据；UIDVALIDITY reset 不丢失目录角色。前端按完整 RFC special-use 属性匹配，并兼容旧缓存中混入的 `$Junk/$NotJunk`；真正 Sent/Trash/Junk/Drafts 继续不产生新邮件通知。移除本轮定位阶段日志，保留错误日志。Rust mail 单测 `shell-mail-rust-unit-209` 108 pass / 1 既有 opt-in ignored / 0 fail；MailClientTab `shell-mail-unit-212` 53/53。早期 208/210 测试编排错误保留，未记为通过。
- N08 的失败 DOM 显示无风险工作区被再次要求确认关闭 4 项（Workspace/Git/Problems/Terminal）。退出确认后，无业务风险时直接 flush/关闭；有风险和普通批量关闭继续询问。`shell-exit-unit-211` CloseCoordinator / close bridge / MainLayout 58/58，通过顺序 flush、取消保留与风险检查。
- N21/N22 修正 native context 的真实 step_index，并在 runner 每步同步。新增真实 Git fixture 经 `_native_run` 连续两步的回归，独立保留 `git-state-1.json` 与 `git-state-2.json`，不使用默认固定编号掩盖错误。
- macOS N15 的 126 个业务步骤全部通过，独立 PID 已退出后，清理 HTTP DELETE 因应用内 WebDriver bridge 已关闭而失败。仅在独立观察到先前 owned PID 退出后免去该请求；仍清理 transport 与 owned driver，未确认的连接失败继续报错。N04 的独立协议 receipt 记录 16 MB 每包额外固定等待造成实际约 168 KB/s，90 秒未完成；fixture 改为把协议耗时计入原 256 KB/s 的时间额度，禁止累计 idle credit。16 MB、90 秒、实际 growing / cancel / SHA256 断言全部保留。
- runner focused 本地 79 项，72 pass / 7 平台限定 skip，exit 0；这些 skip 仅为工具单测的平台条件，不是 browser/native case 通过。TypeScript `shell-types-213` exit 0，受影响 Rust 格式与 Git diff 检查通过。TASK-01～12 继续 verification，下一固定输入先验以上根因修复，再执行 242 ID 六端统一验收。
- 该批最终 runner 单测 `shell-runner-unit-214` 与上列 79 项结果一致。静态 audit gate exit 0：required 975 / covered 930 / shallow 41 / orphans 4，未调整 baseline；45 个未触达控件仍显式列为覆盖缺口，静态结果不代表 runtime 通过。

### 七轮根因修复复验与入口覆盖补充

- [run 37202537846](https://github.com/engcapa/taomni/actions/runs/37202537846)，固定输入 `bcdebdf5fb7b15fd632215bf999d08e60b9a47b7`，8 个 ID、27 次执行：browser 三端各 3/3；native 三端各 5 pass / 1 fail，全部 0 skip。6/6 报告的 source/runner/case/selection/receipt/config/native build 与 archive hashes 匹配。邮件 LIST/message FLAGS、N04 真实传输、N15 多窗口退出和 N21 多仓库 Git 修复均通过。
- Linux N08 在真实 Exit 确认的 click 请求中收到 `Session terminated without a reply`，尚未运行下一条独立 PID 断言。新增 `click_app_exit`：先要求之前观察到 owned PID，并成功找到真正的最后确认按钮；点击后只在独立 OS 枚举确认该 PID 已退出时接受 transport 丢回复。按钮不存在、会话提前不可用、应用仍运行一律失败；原 30 秒退出预算与后续 PID/恢复断言保留。N15 最后风险确认复用同一契约。
- Windows/macOS N22 独立 Git 记录显示分支已创建，但提交尚未发生；新分支的磁盘操作先于 renderer refresh/busy 完成。用例在 Commit 操作前等待真实按钮 enabled，再保留原 exact HEAD/status/index/blob 与取消分支断言。没有增加超时或接受未提交状态。
- B03 新增 Navigator Recent → 既有 Workspace 的单实例结果；B09 新增详情 type/host、attention 过滤、type 排序、空态 Home/New 取消与 backdrop 恢复；B22 新增 Host 标签 Problems/Terminal 切换后的完整 buffer/undo；B23 新增右侧恢复、真正关闭 idle Files 后重开的视图数量和 SSH 存活。原步骤及其断言完整保留，新增动作结果单独映射。
- 修正实际 scoped DOM selector 的 catalog aliases，使已发生的 card/keymap 子控件操作归属到真实控件。只取已有 YAML 的最终 descendant，不把 `:has` 内的被动子元素记作操作；static touch 仍不是 runtime 通过。
- 本批本地 `shell-exit-runner-unit-222`：107 项工具单测，100 pass / 7 平台限定 skip，exit 0；包括正常退出、丢回复、仍存活、预先失联和缺失 owned PID 的真实契约回归。工具单测 skip 不计入 UI 用例通过。`shell-final-static-225` audit gate exit 0，required 975 / covered 947 / shallow 39 / orphans 4，baseline 未降低；未触达控件及 OS/IME/DPI/performance 边界仍显式保留。`shell-full-plan-224` 为 242 个 ID、六端 737 次执行，gaps/unreviewed 为空；尚不是 runtime 通过。Git diff check 通过。

- 最终统一单测：`shell-final-product-unit-227` 全量 526 files / 5235 tests，5231 pass / 4 fail，失败原始 JSON 保留。CodeWorkspace 的导航测试在故意 held didChange 释放前等待 action 完成；改为保留 pending promise、release 后要求真实 definition 调用与 action 完成。symbol split/Outline 按真实文档 synced 状态衔接；Extract 的 Enter、watcher echo、Escape 三个独立场景拆成三项，保留全部原断言与 15 秒单项预算。
- `shell-editor-async-unit-230` 聚焦 6/6 通过。整文件 `shell-final-editor-unit-231` 249/250，发现 Action 列表的 focus/snapshot 尚未 settle 就选 Undo；进一步以 async act 和实际 activeElement 衔接。最终 `shell-final-editor-unit-233` 250/250 通过。其它 525 个文件在 227 已通过且无修改；两份最终结果覆盖 5237 项，未把 227/231 失败运行改写为成功，也未降低断言或扩大超时。
- `shell-final-rust-unit-228` 全量 Rust --lib：1590 pass / 0 fail / 16 既有 ignored；仅 unit 编译，没有构建/启动 native app。`shell-final-types-232` TypeScript exit 0；Git diff check 通过。设计明确简洁工作流及未来 AI surface/关闭/跳转的复用边界，产品源码自七轮输入后未再修改。
- 已查看七轮同产品输入的 Windows native N08（恢复与总览）、N15（DB 与 Notes 同屏）以及 macOS browser B15 画面，无明显遮挡/裁切；contact sheet `qa-ui-auto-report/_local/shell-current-visual-234.png`。这仅是三张实际画面的检查，未替代最终版本的完整 UI/native 验收。


### 统一运行 37207509863 与 Host 后续修复

- [run 37207509863](https://github.com/engcapa/taomni/actions/runs/37207509863)，固定输入 `228a09e74d5101dff533af0f39c0179e22f6fbc4`。selection 为 242 个 ID、六端 737 次执行，无 gaps/unreviewed；实施基线以来改动的 201 个 YAML 全部包含在选择中。browser 三端各 180 pass / 3 fail / 0 skip，已核对 source/runner/case/selection/receipt/config 与 ZIP 内的 artifact hashes；native 尚在运行。
- B09 详情断言使用了 DOM querySelectorAll 不支持的 Playwright text 伪类，改为失败 DOM 中实际观察到的 fixture tab identity 前缀，保持全部 65 步、断言和动作映射。同步 catalog alias，并将六条详情 checkpoint 写为明确结果。
- B22 暴露工作区旧 tool-window 选择器切换后，仍保留的 Problems 实例被 Host 标签列表排除；Host 现在展示当前 owner 在该边已创建的工具，只在有有效显示目标时打开宿主。点击标签经原 adapter 恢复工具，不增加一套工具可见性状态；全部隐藏与 owner 隔离继续保持。
- B23 暴露未固定 Host 跨边移动后，外部点击监听仍引用旧宿主，点击新宿主的菜单会误隐藏面板。监听现在随实际右/底宿主模式更新。原关闭/重开及单实例、SSH 存活断言保持；没有扩大超时或移除验收步骤。
- 独立 worktree 保持当前远程输入稳定。新增真实 ShellFrame/StableSurface 双向移动回归和已挂载 CodeWorkspace 的 Host 标签往返：改前 `shell-host-red-unit-239` 为 3 fail / 1 pass；修复后 `shell-host-green-unit-241` 为 4/4 pass。未选中的 249 个 editor 测试是 filter 排除，不算 UI skip。`shell-host-regression-unit-243` 为 17 files / 105 tests 全通过；TypeScript `shell-host-types-246` exit 0；`shell-host-static-245` audit/精确六端计划通过，仍为 242 ID / 737 executions，无 gaps/unreviewed。新候选运行效果尚待 GitHub 验证，TASK-01～12 保持 verification。
- 另检查上一轮同产品源码的 12 张三端原生 SFTP/Git/恢复/退出取消画面，未见明显遮挡或裁切；原图与索引保存在 `qa-ui-auto-report/_local/shell-visual-review-37202537846/`。仅按实际检查范围记录，未替代新输入及 OS/IME/DPI/performance 的独立验收。

### Host 复验、Linux 会话释放与 Windows prompt 修复

- 完整运行 37207509863 已收齐六份报告：browser 三端各 180 pass / 3 fail；Linux native 37 / 30，Windows native 59 / 2，macOS native 60 / 0；全部零 skip。六份 source/runner/case/selection/receipt/config/native build 与原始 ZIP hashes 均匹配。Windows 剩余失败为 TC-155 与 IDE-027-02；未把 workflow 的总体 success 当作 case 通过。
- [Host 复验 37211142267](https://github.com/engcapa/taomni/actions/runs/37211142267) 输入 2325fd2e51847ed073c0463fa2b0a128272562e7，browser 三端各 2 pass / 1 fail / 0 skip；三份身份及 hashes 匹配。B09、B23 全步骤通过。B22 已通过 Host 标签往返和完整编辑内容，在一次 Undo 后观察到 host-tab-edi：逐字符 type 不构成单次撤销事务。现改用完整三行的单次 fill，保留 41 步、全文与一次 Undo/单实例断言；R3 checkpoint 明确结果。
- B22 的真实挂载回归现在包含完整长文本事务、两个 Host 标签往返、相同 EditorView 与一次 Ctrl+Z 恢复原文。shell-host-undo-unit-253 1/1 通过（另 249 项是本次 filter 排除）；TypeScript 254 exit 0；静态 255 audit gate、242 ID / 737 次精确计划通过，无 gaps/unreviewed，baseline 未改。
- Linux N08 的正常 Exit 与独立 PID 退出已通过，restart 收到 Maximum number of active sessions，后续 29 项在 setup 同样失败。macOS bridge 随应用退出，Linux 的独立 WebKit driver 仍保留会话名额；现在只对已观察退出的 macOS 免 DELETE。真实 loopback HTTP 工具单测验证 exit→DELETE→restart→close→下一例和幂等清理；改前 251 失败，修后 252 为 131 项、122 pass / 9 平台限定 skip、零 fail。没有本地启动原生应用。
- Windows 失败原图与 buffer 显示原生终端可见，但 readiness 在初始化后失效，且 TC-155 命令被解释成 cho。已发现近期输出读取只看 buffer 最后三行，真实 24/50 行的尾部预分配空行使 MINGW64 识别失效。新增真实行数的 mounted 回归，改前 257 为 1 pass / 2 fail；读取前先去尾部空行后，TerminalPanel / shell integration / cwd 的 258 共 3 files / 103 tests 全通过。两个既有 YAML 各加一次隐藏初始化命令未泄露检查，所有原步骤和预算保留；尚待 GitHub 证明 Windows 原生失败已解决。
- 本批最终 TypeScript 260 exit 0；静态 261 audit gate、242 ID / 737 次精确计划通过，gaps/unreviewed 为空；两条 SSH YAML 的 schema/reviewed contract 通过，Git diff check 通过。没有本地 browser/native 或 app 构建；下一候选固定输入复验八个相关 ID。

### 逐模块范围复核与 DB browser 补充

- 候选 1e2bb817cf8794495bbe22697ec54ef0960e09b5 已快进合入并推送 feat/ui-layout-refactor。[复验 37213780261](https://github.com/engcapa/taomni/actions/runs/37213780261) 为八个 ID、六端 27 次执行；已收齐的 browser 三端各 4/4 通过，身份、receipt/config 与 hashes 匹配；native 尚在执行。没有提前宣称 Windows SSH 或 Linux restart 已通过。
- 按用户点名的模块逐项核对选择，发现 7 条既有 DB browser 用例未纳入旧 242 ID；此前 native DB 有覆盖，不能代替 browser。现适配这些用例的 Sessions 入口、分别审阅打开连接和业务结果要求；原 SQL、事务状态、Query Library 和 rename 步骤及 45/90 秒预算保留。新增一次 Home/Overview 往返后的完整 SQL/Log 和单实例验收、Query Library 完整内容保存检查。
- 最终预期范围增加为 249 ID / 758 次：browser 三端各 190，native Linux 67 / Windows 61 / macOS 60。新列表为 qa-ui-auto-report/_local/shell-ci-case-ids-final-269.txt；旧 242 ID 列表保留用于历史核验。schema/reviewed contract 已通过；本地 DB unit 与静态精确计划仍在执行，随后推送并通过 GitHub 验证。
- 收尾结果：DB/Query Library/执行日志单测 266 为 3 files / 48 tests 全通过；静态 267 audit gate 与 249 ID / 758 次精确计划通过，gaps/unreviewed 为空；Git diff check 通过。只改用例和证据文档，未改产品或构建输入。本批先远程执行七条 DB browser，再用最终统一 SHA 验收六端全范围。

### 原生精准复验与路径焦点修复

- [run 37213780261](https://github.com/engcapa/taomni/actions/runs/37213780261)，固定输入 `1e2bb817cf8794495bbe22697ec54ef0960e09b5`：browser 三端各 4 pass / 0 fail / 0 skip；Windows/macOS native 各 5/0/0，Linux native 4/1/0。六份 source/runner/case/selection/receipt/config/native build 和原始 ZIP hashes 均匹配。Windows TC-155/IDE-027-02 及三端 N08/N09 通过；Linux N15 在上传前的本地路径导航失败，不能以 workflow success 记为通过。
- Linux N15 原图显示本地列表仍为 `/home/runner`，整页文本被选中。原生 form fill 重新点击已经聚焦的 blur-commit 路径框，没有检查焦点；单测 274 的两个实际失败分别复现输入框提前提交和无焦点仍发全局快捷键。现在复用已有 locator focus 并验证 activeElement，保留真实 select-all/backspace/text 与 Unicode OS paste。N15 新增 Enter 前完整 fixture 路径值检查，原 126 步与 600 秒预算保留，requirements/checkpoints/results 随插入同步。
- 本地 276 工具单测：117 项，108 pass / 9 平台限定 skip / 0 fail；这些 skip 不属于 browser/native 用例结果。277 audit gate 通过，未降低 baseline。273/275 的测试命令缺少模块路径或引用不存在模块，原日志保留，未当作产品失败或通过。本批不修改产品/构建输入，没有本地启动 browser/native 应用。
- [DB browser run 37215235654](https://github.com/engcapa/taomni/actions/runs/37215235654)，固定输入 `d39a285b983ad384bbc7e569ccdbb8b172132ae3`：三端各 7/0/0，共 21 次全部通过；三份身份、receipt/config 与 ZIP hashes 匹配。实施基线以来改动的 208 个 YAML 全部包含在最终 249 ID 范围，无遗漏。N15 修复仍待 GitHub 精准复验，然后执行最终六端统一输入。

### N15 路径复验与 Windows 进程观察

- [run 37216273760](https://github.com/engcapa/taomni/actions/runs/37216273760)，固定输入 `2bec9b26d5238e271d101b3ec33db27bfe449ee4`：Linux/macOS native 各 1/0/0，Windows 0/1/0。三份身份、receipt/config、native build 与 ZIP hashes 匹配。两端 N15 完整 127 步通过，Linux 路径修复得到实际证明；已检查 Linux 的 DB/Notes 同屏原图，无明显裁切。Windows 在 step 47 的独立 `Get-CimInstance` 全进程查询超过原有 15 秒预算，尚未执行该输入的 SFTP 路径部分。
- Windows 独立 oracle 改为 Toolhelp32 + QueryFullProcessImageNameW，读取真实 PID、父 PID、完整 Unicode executable；所有已打开句柄在成功/失败时关闭。保护进程或查询时已退出的 PID 保留未知路径；观察到原 PID 但无法读取路径，不能误判 app 已退出。保留原 15 秒观察和 N15 600 秒 case 预算，未读取 renderer 的 PID 作为独立证据。WebView2 精确 profile 清理继续保持原身份保护。
- 本地工具单测 285：124 项，115 pass / 9 平台限定 skip / 0 fail。包含 Windows API 实测识别本次 Python 单测进程的 PID、parent 和真实 executable，以及 Unicode 路径、访问拒绝、API 枚举失败/句柄清理和未知 executable 不能证明退出。284 的误判退出测试改前真实失败；另一个旧 mock 的 TypeError 保留但不计为根因证明。产品和 native build 输入未修改；下一输入先复验 Windows N15，再执行最终六端集合。

### 六端统一运行与 SFTP owner 定位

- [Windows N15 run 37217880429](https://github.com/engcapa/taomni/actions/runs/37217880429)，输入 `dadb395d374a49524bc652bea351b987ae91fe86`：1 pass / 0 fail / 0 skip，全部 127 步通过；source/runner/case/selection/receipt/config/native build 与 ZIP hashes 匹配。真实 Win32 oracle、路径输入、SFTP growing/pause、取消保留、MySQL rollback 与进程退出通过。
- [统一 run 37218987069](https://github.com/engcapa/taomni/actions/runs/37218987069)，同一固定输入，249 ID / 758 次，selection 无 gaps/unreviewed。已收齐 Linux browser 190/0/0、macOS browser 189/1/0；两份身份、receipt/config 与 ZIP hashes 匹配，其余报告尚在运行。已查看这两端共 22 张 Home/Code/Git/SFTP/Tao 等原图，无明显遮挡；不提前宣布六端通过。
- macOS B18 step 25 的 `.first` 命中了 parking 中被隐藏的 alpha 文件行；实际 Host 为可见且 ready 的 beta，原图中目标 job.txt 存在。用例现在以 Host owner 前缀精确限定两次 list/file/download 操作；隐藏的旧 controller/view 按设计保留。完整 95 步和 150 秒预算不变，所有 bytes/state/count、后台、pause/resume、完成通知与 held cancel 的断言保留。产品和 runner 未修改。
- 293 audit gate 通过，baseline 未降低；294 的 StableSurface / sftpController 既有单测 2 files / 4 tests 全通过。修正只涉及六个定位 selector，未用 force click 或扩大超时；下一输入先三端 browser 精准复验 B18，同时收齐统一运行的其余原始报告。

### B18 复验与 macOS RDP 宿主目标

- [B18 run 37221675568](https://github.com/engcapa/taomni/actions/runs/37221675568)，固定输入 `62b668c50ce09ba7e39f2b7cd624bf6b95007ff8`：三端 browser 各 1 pass / 0 fail / 0 skip，95 步全部通过；source/runner/case/selection/receipt/config 与原始 ZIP hashes 均匹配。该精准结果没有改写上一完整运行的 B18 失败。
- 完整 run 37218987069 已收齐五份报告：Linux/Windows browser 各 190/0/0，macOS browser 189/1/0；Linux native 67/0/0，macOS native 59/1/0；Windows native 仍在执行。五份身份、receipt/config、native build 与 ZIP hashes 匹配。已查看 browser 三端 33 张、Linux/macOS native 各 13 张成功原图，未见明显遮挡/裁切。
- macOS 唯一 native 失败为 TC-RDPJ-01 step 45 的宿主 flip 计数为零。原始画面显示 Python 的本地网络权限弹窗，target-state 仍为 ready/零 flip。macOS flip 目标改用独立 AppKit 进程，保持真实宿主点击/按键、physical-pixel geometry、原子 JSON、PID、计数和子进程清理；不操作权限。Windows/Linux 及 animation/photo 测量仍使用原 Tk 目标。RDP 原 59 步、20 秒 flip 观察和 480 秒总预算完整保留。
- 298 的改前工具单测保留：macOS GUI identity 选择断言真实失败，另有四个 Windows log 未关闭的清理错误；后者不能代替权限弹窗的原生证据。host_helper 在 Popen 后关闭父进程的 log handle，子进程继续拥有自己的 stdout。修复后的 299 为 66 项工具单测全通过，涵盖 dispatch/ready、spawn failure、幂等 cleanup 和相邻 RDP/CI/native assertions；不是本地 native 应用执行。AppKit 的实际效果待 GitHub 精准复验。
- 300 audit gate 通过，原 coverage baseline 保持；301 精确六端计划仍为 249 ID / 758 次，无 gaps/unreviewed。只改测试工具与 RDP fixture 说明，产品、所有执行步骤和预算保持。随后固定输入推送并先复验 macOS 的真实 RDP 输入。
- 完整 run 37218987069 已收齐：Windows native 61/0/0；最终共 756 pass / 2 fail / 0 skip，六份身份、receipt/config/native build 和 ZIP hashes 均匹配。三端 browser 共 33 张及三端 native 共 39 张成功原图已实际检查，无明显遮挡/裁切；索引及审阅记录为 `shell-visual-review-37218987069/` 与 `shell-visual-reviewed-306.json`。
- 沿 host_helper 追踪全部消费者：macOS 的 functional flip 还被 TC-RDPS-NAT-01 和 PERF-01 使用；Windows 专属 NAT-06/NAT-08 无 backend 改变。补入既有 NAT-01 三端 native，保护 NLA、两组 codec、独立 10 次点击计数与 decoded framebuffer、错密拒绝和 Stop 后连接失败。原 28 步、420 秒和全部阈值不变；本条不是 Shell 匹配 baseline/candidate 性能验收。最终并集增为 250 ID / 761 次，旧 249 ID 原始结果保持。
- 308 精确计划为 250 ID / 761 次，六端无 gaps/unreviewed；309 audit gate 通过且 baseline 未改。新增范围只是已存在的 native case；变更说明从 Tk 改为平台对应的真实宿主，不改 steps/modes/fixtures/thresholds。PERF-01 的 flip 源也随工具改变，若要比较其性能，必须重建使用同一目标的匹配 baseline/candidate；本轮未引用旧 Tk 性能结果。

### AppKit 精准复验与最终统一输入

- [macOS RDP run 37224044887](https://github.com/engcapa/taomni/actions/runs/37224044887)，固定输入 `04be9078535003f0ed3bc11b9cbf9ace68dbb99c`：macOS native 1 pass / 0 fail / 0 skip，原 59 步全部通过。source/runner/case/selection/receipt/config/native build 与原始 ZIP hashes 均匹配。独立 `target-state.json` 为 `target_backend: AppKit`、`flips: 1`，记录真实 event/draw sample 与 480×320 宿主窗口；结果没有改写旧 Tk 目标的失败报告。
- 固定输入 `63ce4708c26d559b79276caccec3d23767d32bce` 已推送，并启动 [最终统一 run 37227772151](https://github.com/engcapa/taomni/actions/runs/37227772151)。当前精确 selection 为 250 ID / 761 次：browser 三端各 190，native Linux 68 / Windows 62 / macOS 61。310 提交后 development contract 已通过；本次没有本地 browser/native 启动或原生构建。逐 case 验收、模块矩阵与当前截图审阅在运行完成后回填。

### D2 预览用例的输入前置条件修正

- run 37227772151 已收齐 Linux browser 189 pass / 1 fail / 0 skip、macOS browser 190/0/0；两份 selection/source/runner/case/receipt/config 与 ZIP hashes 均匹配。Linux 的 TC-IDE-D2-01 在 step 32 观察到默认 README 三行仍在 needle 文本之前。原始 Playwright trace 的 fill 后快照已经显示该内容，因此失败发生在替换预览之前，不把取消操作判为改写了文件。失败 screenshot、HTML、console 和 trace 原件保留。
- 该 case 在 CodeMirror 输入前新增定向 `Mod+a`，使全选经过编辑器的实际平台键盘绑定；fill 后立即检查完整三行输入。所有原 40 个步骤、两个取消分支的全文断言、覆盖归属、fixture、mode 与 180 秒预算完整保留，现为 42 步；requirements/checkpoints/results 随新增步骤同步。只修改用例，不修改产品或通用 fill runner。实际输入效果仍待 GitHub 三端精准复验。
- 本地 CodeMirrorHost 314 为 1 file / 75 tests 全通过；315 静态 audit gate 通过且 coverage baseline 未改；316 精准计划为三端 browser 各 1 条，gaps/unreviewed 为空。YAML schema、reviewed contract、每个 checkpoint 与实际步骤的精确匹配及原步骤保留检查均通过。
- 本轮 Linux/macOS browser 的 22 张实际画面已逐页检查：Home、SFTP、Code/Git、Tao、Notes 的已捕获状态没有明显遮挡或裁切。索引为 `shell-visual-review-37227772151/screenshot-index.json`；审阅只涵盖当前两端捕获状态，不代替其余端、DPI/读屏或像素基线。


### 延迟恢复绑定与 N08 原生诊断（2026-10-05）

- run 37227772151 的 Windows native 62/0/0 已收齐；最终 250 ID / 761 次为 759 pass / 2 fail / 0 skip。六份 source/runner/case/selection/receipt/config/native build 与原始 ZIP hashes 均匹配。D2 精准 [run 37230541532](https://github.com/engcapa/taomni/actions/runs/37230541532)，固定输入 `359e9b2816277f29d1d61792ee00b118f08b73ad`，三端 browser 各 1/0/0，原断言及新增输入检查共 42 步全部通过，三份身份与原始 ZIP hashes 匹配。
- 同输入的 run 37231369098 尚未收齐六端：Linux browser 190/0/0、macOS browser 188/2/0，当前两份身份、receipt/config 与原始 ZIP hashes 匹配。B07 trace 已先观察到 Communicate empty 和 inert，随后 Home action 消失，失败 HTML/截图为 Connect。延迟 restore bind 调用 visitTab 会清除用户的显式 Lane；现在只记录 lastActiveRestoreRef，实际标签导航仍负责清除临时 Lane 和更新 MRU。
- 新增两种 restore source 的 store 回归与真实 ShellFrame Home/retained input 挂载回归；改前 335 为 3 fail / 9 pass，修复后 336 为 12/12 pass。共享 Shell/恢复/关闭/ControlBar 单测 339 为 18 files / 72 tests 全通过；TypeScript 337 exit 0；338 audit gate 通过且 baseline 未调整。B07 保留原 14 步和 150 秒，增加实际持久化 identity 就绪后的精确 Communicate/inert 检查，现 17 步；B17 原 26 步和 150 秒保留，增加 ready selector 等待，现 27 步。两条 schema/reviewed contract、精确 checkpoint 映射及原步骤保留检查通过，尚未用本地 browser 代替远程执行。
- B17 原即时 assert 读到 initializing；约 0.4 秒后捕获的原始 HTML 已为 ready。新增等待目标为真实 Host data-phase=ready，随后仍执行原 exact ready、attach 次数、单实例和 owner 往返结果；没有加固定 sleep、扩大 case 预算或删减业务断言。
- N08 原失败前的 232px handle、实际 localStorage 写入、真实 Exit 与独立 PID 退出均通过；重启后即时 handle 为 248。新增只读 stored/rendered 双字段检查，要求两者精确为 232，随后保留原 exact width 与 workspace restore；35 个原步骤、300 秒预算保留，现 36 步。327 的布局/store/Shell 单测 14/14 pass；初始 expression 触发 schema 的 CSS 等号误判，328/329 无效日志保留。改用等价只读转义后，330 audit 与 331 三端 native 精准 plan 通过。固定输入 `9ad0a3ea928647bd7f06387e73de9fe651124b77` 的 run 37233544174 已启动，尚不确定是存储丢失还是恢复时序。
- 本轮已查看 run 37227772151 的 macOS native 12 张成功原图，未见捕获状态的明显遮挡/裁切；审阅记录 `shell-visual-reviewed-macos-native-341.json`。该结果不代替最终输入的画面、DPI/读屏或像素基线。
- 全量前端 unit 342 已启动，结果尚待收齐；原始旧失败报告保留。本批没有本地 browser/native 启动或 native build。所有修正需统一输入通过六端逐 case 验收后更新当前任务状态。


### N08 复验与本地单测收尾

- 固定输入 9ad0a3ea928647bd7f06387e73de9fe651124b77 的 [run 37233544174](https://github.com/engcapa/taomni/actions/runs/37233544174) 三端 native 各 1 pass / 0 fail / 0 skip，36 步完整执行，共 108 步。三份 source/runner/case/selection/receipt/config/native build 和原始 ZIP hashes 均匹配。macOS 的 stored/rendered 检查在首次读取即为精确 232/232；此精准运行未复现旧 248，不能据此确定旧失败根因。
- 完整 run 37231369098 已收齐 Linux native 68/0/0、macOS native 61/0/0；macOS 原 N08 的 35 步、即时 exact width 也通过，step 27 约 0.008 秒。两份身份、receipt/config/build 和 ZIP hashes 匹配，Windows native 尚待收齐。macOS N19 独立 provider receipt 为 5 stream/tool requests、1 cancelled stream、3 completed streams、最后 SHELL AI recovery；未把 UI 成功提示当成真实 provider 结果。
- 全量前端 342 为 526 files / 5244 tests，525 文件全通过，编辑器文件仅 pending Java didChange barrier 的一项失败。347 原断言独立运行通过；该成功同步场景刻意暂停 provider，真实 400ms feature deadline 会在忙碌的 act 期间到期。仅在暂停阶段使用受控测试时钟并在 finally 恢复，保留零提前查询、两次 didChange 与精确 definition 请求；生产期限未改变。
- 编辑器完整 349 的 barrier 已通过，但另一个 focus-reset fixture 在 await menu disappearance 后才 blur，可能晚于两个真实焦点恢复回调。现在在菜单卸载的同一同步提交模拟 WebView reset，再保留原精确 row focus 等待；没有改变产品焦点恢复。351 两项聚焦 unit 通过；排除的 248 项仅为 filter，不当 UI skip 或完整回归通过。
- 最终完整编辑器 352 为 250/250 pass，TypeScript 350 exit 0。342 的另外 525 文件 / 4994 项与 352 的全部 250 项共同覆盖当前前端 526 文件 / 5244 项；完整 assertion 名称集合相同，原 342/349 失败报告未改写，核对记录 `shell-unit-review-353.json`。本批 unit fixture 修改没有新的用户行为或 executable case；原 tree focus 边界继续由 TC-IDE-TREEOPEN-01 保护，同步屏障由原 unit 成功/失败分支保护。产品代码在 342 后未改变。
- 345 的精确并集仍为 250 ID / 761 次，gaps/unreviewed 为空；346 提交后的 development contract 通过。下一输入先通过 GitHub 三端 browser 复验 B07/B17，再执行稳定输入的完整六端验收。没有本地 browser/native 启动或 native build。

### B07/B17 三端复验与完整六端候选

- 上一完整 [run 37231369098](https://github.com/engcapa/taomni/actions/runs/37231369098)，固定输入 `359e9b2816277f29d1d61792ee00b118f08b73ad`，已收齐六份原始证据：browser Linux/Windows 各 190/0/0、macOS 188/2/0；native Linux 68/0/0、Windows 62/0/0、macOS 61/0/0，共 759 pass / 2 fail / 0 skip。六份 selection/source/runner/case/receipt/config/native build 与原始 ZIP hashes 均匹配；B07/B17 的原失败保留。
- 固定输入 `79ab1d6b46a4d65fe7026b3d8b7da3e799f0ea0b` 的 [browser 精准 run 37236895398](https://github.com/engcapa/taomni/actions/runs/37236895398) 三端各 2 pass / 0 fail / 0 skip。B07 的 17 步与 B17 的 27 步均完整通过，共 132 步；不仅核对 case 状态，也核对原始 step_timings 与冻结 YAML 的数量、逐项动作和顺序。三份身份、配置、receipt 与 ZIP hashes 均匹配，原失败报告未覆盖。
- 本地前端核对记录 `shell-unit-review-353.json` 绑定 342/352 原始 JSON hashes，当前 526 文件 / 5244 项通过；原 342/349 失败原件保留。提交后的 development contract 356 exit 0。此阶段没有再次运行本地 browser/native 或构建原生 app。
- 同一稳定输入启动 [完整 run 37237715943](https://github.com/engcapa/taomni/actions/runs/37237715943)，精确 selection 为 250 ID / 761 次：browser 三端各 190，native Linux 68 / Windows 62 / macOS 61，gaps/unreviewed 均为空。dispatch 记录 `shell-ci-dispatch-final-357.json`；监控自动保留各端原始 ZIP/receipt。运行中，TASK-01～12 保持 verification，待收齐全部逐 case 结果、独立 oracle 和当前画面后回填。

### macOS native 回环与录屏诊断

- 完整 run 37237715943 已结束，六份原始报告为 759 pass / 2 fail / 0 skip，身份、配置、receipt、构建与 ZIP hashes 匹配。33 张 browser 和 39 张 native 代表性 Shell 截图已实际审阅，共 72 张；当前捕获状态未见明显主要控件遮挡/裁切，记录在 `shell-visual-review-37237715943/reviewed-*.json`。这不是 DPI、读屏、像素基线或性能通过证据。
- macOS TC-RDPJ-01 在原第 59 步失败；客户端 UI 已断开，服务端仍记录旧 session active 并拒绝新连接。用例保留原 59 步、独立协议/首帧结果和 480 秒预算，补 4 步打开 Local servers 并等待最新一条日志确认释放，现 63 步；避免用证书确认阶段的旧断开日志作为当前释放证据。
- macOS TC-SHOT-N7 的 13 帧像素/顺序/nonce 均匹配，但 960 ms 间隔导致时间轴失败。QA app 增加有界采集/排队记录，保留 sampled marker、native timestamp、poll 耗时和 pending 发送状态，帮助区分 OS 画面、采集与编码队列；生产录制流程及原 oracle/预算未调整。精准 GitHub 验证尚待启动，不能声称根因已确定或产品缺帧已修复。
- 本地 screenshot Rust unit 362 为 52 pass / 0 fail，包含真实 GIF/MP4 编解码和丢失原图帧的拒绝检查；TypeScript/前端输入未改变，复用 353 核对的 5244 项。catalog audit 和 development contract 通过；改动两份 Rust 文件的 rustfmt 检查通过，全仓 rustfmt 显示既有文件格式差异，不把它记为全仓通过。本批没有本地 browser/native 启动或 native build。

### macOS 精准复验与连接生命周期观察

- [run 37243895415](https://github.com/engcapa/taomni/actions/runs/37243895415) 的 selection、source/runner/case/config、receipt、native build 和原始 ZIP hashes 均匹配；精确 5 条实际为 4/1/0，失败报告与未执行的末步完整保留。
- RDP 原始 DOM 显示本次 peer `127.0.0.1:49356` 在 00:16:40 已释放，后面仍每 5 秒输出 latency；第 62 步等待 last-child 必然被统计行覆盖。修正后的只读条件取最近的 `RDP client connection from` / `RDP client ... disconnected after` 记录，再确认最近一条为断开；后续新连接会使条件恢复为 false，旧证书握手断开不会冒充当前释放。未改产品 RDP 实现或独立探针结果。
- `shell-rdp-release-unit-367.json` 保留从原始失败 DOM 建立的五个 jsdom 单元样本：统计行后的已释放状态通过；当前活动连接、释放后新连接、只有统计行和空日志均拒绝。reviewed checkpoint 与真实 YAML 逐项一致，仍 63 步 / 480 秒。
- N5～N8 的采集队列均无满队列样本，采集到的 frame code 全部出现在解码结果，四条逐帧原图比对和生命周期通过。N7 最长 unexplained gap 为 150 ms（原 700 ms 上限），像素、顺序及 nonce 均通过；四张 source/actual/difference contact sheet 已实际查看。旧 N7 的 865 ms 失败未复现，根因仍未确定，不声称完成了产品缺帧修复。证据 `run-37243895415/recording-review.json` 与 `shell-mac-record-review-366/` 保留。
- 本批只修正 YAML 观察条件并更新记录，产品源码、runner、录屏诊断、原断言与预算保持；本地未运行 browser/native。下一轮在统一固定输入验证完整 250 ID / 761 次六端范围。


### 当前补齐实现与检查（2026-10-05）

- 标题栏全部入口已按全局/上下文/状态/窄屏逐项审阅，具体决策见设计末尾矩阵。空分类不再把 close、detach、Panel 或工作区命令送给后台保留标签；菜单的 split/multiexec 条件与标题栏一致。
- Dock 分类与四方向、沉浸模式、Project 合并、Tao 悬浮球移除、Java discovery/最近工作区切换、恢复错误、部分关闭摘要和剩余重试已实施。
- 本地聚焦 `shell-followup-unit-411`：20 files / 91 tests 通过；`shell-followup-types-410` 两类类型错误已修正，后续完整检查进行中。`shell-followup-audit-412` 发现继承的 readonly selector 字符串校验问题和三处新 contract 末步映射缺失，已按实际观察修正，保留全部行为断言与原时间预算。
- 本地仅执行 unit/static；browser/native 未启动。GitHub 新输入尚未验证，任务不标 done。

### 合并后候选本地验证收尾

- main 合并提交为 `b690bcda`（合入 `a90a0bd3`）；后续改动按用户最终要求采用右上角抓手、四方向 Dock、全隐藏沉浸模式和统一标题栏上下文规则。
- Rust 全量 lib 单测 `shell-followup-rust-unit-416`：1598 passed / 0 failed / 16 ignored。前端全量 `shell-followup-full-unit-413`：529 files、5275 passed / 1 failed；唯一失败为删除 Project stripe 后的旧入口。更新该用例并加入沉浸往返的完整草稿、EditorView 与 undo 断言后，`shell-editor-final-427` 两项相关测试全部通过（248 项为名称过滤未选中）。保留原失败日志，不将补跑描述为再次全量通过。
- 新增 ContextActionsSlot/PanelRegistry/CloseCoordinator 单测 `424` 为 3 files / 10 tests 通过，keyboard runner 单测 `415` 为 16 项通过。类型检查 `422` 通过，后续沉浸 Action 路由调整继续由 `428` 检查。静态 audit `426` 通过，coverage baseline 未变；最后批次复核为 `430`。
- Welcome 恢复及 native cwd/PTY 用例重新语义审阅，加入恢复后的真实命令输出、唯一隔离目录及持久化结果；八条旧 needs-review 已按真实断言更新，未把语法审查当作运行通过。
- 本批本地仅 unit/static，无 browser/native 执行或应用构建。六端验证尚未通过，TASK-01～12 继续 in_progress。

### 合并后首轮六端失败分析与修复（2026-10-05）

- 固定提交 `cf97768738f0ece095d01282b20d2fe90c9a6e13` 的 [run 37265774830](https://github.com/engcapa/taomni/actions/runs/37265774830)：291 个唯一 ID / 878 次执行，806 passed / 72 failed / 0 skipped。Linux/Windows/macOS browser 各 199/19/0；native 分别 73/5/0、68/4/0、68/6/0。六份 selection/source/runner/case/config/receipt/native build 身份和 ZIP hashes 已核对。工作流绿色只表示报告完整，不能用作产品验收通过。
- 失败原件保留于 `qa-ui-auto-report/workspace-shell/github/run-37265774830/`，诊断汇总为 `_local/shell-failures-436.json`。新版 Dock 先切换分类再切换导航显隐，旧用例必须明确当前分类；通过实际 Dock/Overview 操作更新路径，保留分屏、多发送、终端输出、Git 独立磁盘检查、恢复复用及布局持久化断言。浏览器本地终端使用已有显式 `local_terminal_preview` fixture，不伪装为原生 PTY。
- 产品修复：同 ID 的显式标签激活退出空分类；临时标题栏优先拥有 Escape；水印弹层按视口限制位置；恢复记录读取忽略过期响应，清除前暂停并等待后台保存，清除后将当前保留工作集作为已处理状态，新的工作集变化才再次保存；首页在后台保存完成后刷新候选。
- macOS N7 诊断为 12 个采集样本全部进入编码、无满队列，最长 poll 818 ms / 帧间隔 819 ms；原图比对仍有 1 帧时间不匹配，原失败不撤销。针对整屏快照转换后裁剪及转换后时间戳，改为 CoreGraphics 区域快照、在像素转换前记录时间戳。继续使用兼容快照路径，不开启曾触发 WindowServer 故障的流采集；700 ms 上限、原图像素/nonce/时间轴断言保持。实际改善等待 GitHub macOS 结果，不宣称已测得性能提升。
- 本地聚焦单测 `shell-focused-unit-443`：5 files / 89 tests 通过；包含过期恢复读取、清除与保存竞态、同标签激活、Escape 所有权、水印视口边界。Rust `shell-capture-unit-441`：8 passed，包含有 padding 的区域像素转换和截断输入拒绝；类型 `444` 通过。后续完整单测和静态用例检查仍在进行。任务保持 in_progress，下一轮六端验证前不标 done。
- 收尾：`shell-followup-unit-439` 前端全量为 532 files、5281 passed / 1 failed；唯一失败是 Extract Method 多候选点击后的异步 React 更新尚未完成就观察命名对话框。该用例采用与单候选路径一致的异步 `act` 等待，不改生产期限或断言；`shell-extract-suite-454` 整个 ED-PARITY-007 组 24 项通过（226 项名称过滤未运行）。原失败日志保留，不把全量 439 改写为通过。最终标题栏完整挂载回归 `447` 为 50 项通过；Rust 全量 `446` 为 1599 passed / 16 ignored；类型 `450`、审计 `449`、开发契约 `451` 通过，coverage baseline 不变。
- `58abf9de` 的精准 [run 37280422134](https://github.com/engcapa/taomni/actions/runs/37280422134) 选择 40 ID / 124 次；计划身份一致且 gaps/unreviewed 为空。三端 browser 均 25/3/0；native 此时仍执行中。B47 暴露第二层 Escape 捕获：可见 Code Workspace 抢先执行工作区命令。将 Shell 标题栏加入表面按键所有权排除，真实 CodeWorkspace 挂载回归验证事件未被 preventDefault、焦点/EditorView/全文保持；`459` 的新用例及相邻 hosted Project/Problems 三项通过，类型 `460` 通过。
- TC-MAIN-RAIL-04 在首次创建空工作区后通过 UI 添加目录，才具有可持久化的最近工作区；TC-auto-F1-5 创建两个真实预览终端，验证同分类多卡快捷预览（固定 Home 不属于内容卡），原单卡悬停、Overview、detach 菜单断言保留。上述新修改待远端再验，旧失败不删除。

### 2026-10-05 第二次 main 合并与本机回归

- 按用户新要求拉取 main 到 `307c6322`，合并提交 `8a05db84`。5 处文本冲突已解决；保留 Linux GTK 主线程显示器枚举、原生保存对话框修复与截图用例。macOS 统一为 main 的缓存 CoreGraphics 区域快照及请求时间戳，复用本分支有 padding/截断输入单测的 BGRA 转换函数，移除重复区域捕获路径。水印采用 main 的窄视口/滚动结果定位与滑块最小宽度处理；几何工具兼容 viewport_margin、within_viewport、hit_center 和最大尺寸断言。
- 用户明确允许本机 Windows 11 browser/native 验证，先本机稳定后再 GitHub 三 OS。构建 `472` 在新 main 合并前停止，未生成有效验收结果；保留日志和增量缓存。最终本机 native 仍用隔离 QA ID、独立报告数据和匹配构建身份。
- 聚焦远端 `37280422134` 最终：三端 browser 各 25/3/0；Linux native 14/0/0、macOS native 13/0/0、Windows native 12/1/0。六份身份/receipt/config/build/ZIP hashes 匹配。N5～N8 均通过，macOS N7/N8 原始采集仍有约 1 秒间隔，不宣称性能改善；原始失败和慢样本保留。
- 远端 `37282347150` 三端 browser 均 2/1/0，B47 和 Tab 预览已通过；MAIN-RAIL-04 进一步发现右侧条的 End 调宽未实现。本批补齐可访问 separator 的 Home/End 边界调宽，保留箭头与拖动。MAIN-RAIL-01 在点击 Sessions 前明确回 Home，消除不同视口/菜单关闭后 Navigator 状态差异，后续 Enter/Space 显隐断言保持。
- 本机 browser `471`：3 pass / 1 fail，失败同为 End 调宽；B47、B49、Tab 预览通过。B49 实际截图确认空 Messages 分类不再泄露保留 Settings 的 sticky 搜索框（修复 `15223ac7`），仍保留原设置实例。修后 `475`：MAIN-RAIL-01、MAIN-RAIL-04、SHOT-017 全部 3/0/0，含窄视口、持久化、键盘和实际命中区域。
- 聚焦前端 `474`：3 files / 31 tests 通过；几何工具 8 项 unit 通过，修改的两份 capture Rust 文件 rustfmt 检查通过。完整前端 `478`、Rust `479`、catalog `480`、隔离 native build `477` 继续执行；9 条 native dry-run `476` 通过，仅证明语法/平台能力，不算 native 执行。所有 TASK 仍为 in_progress，待最终同输入六端验收。

- 本机收尾：完整前端 `478` 为 **532 files / 5286 passed / 0 failed**；完整 Rust `479` 为 **1599 passed / 0 failed / 16 ignored**，忽略项为既有平台/外部依赖测试；catalog `480` 通过，开发契约通过。QA build `477` 成功且 ID 为 `com.taomni.app.qa`。本机 RDP 会话 `RDP-Tcp#0` 下没有强行执行系统截图/录屏/对话框子集；WebDriver native `484` 的 5 条（IDE-PARITY-010-04、MAIN-RAIL-01、SHELL-N22、SHELL-N23、WELCOME-RS-N-01）全部通过，包含真实 PTY、独立 Git 磁盘状态与 native 重启恢复。
- 本机 browser `482` 的 B46/B48/B50/B51/B52 全部 5/0/0，覆盖四向 Dock、Java 切换复用、恢复错误、MRU 和部分关闭重试。`475/482/484` 的 current identity、stable 输入、receipt 与全部 artifact hashes 已核对；记录 `_local/shell-local-evidence-review-485.json`。3 张修后代表性截图已实际评审，记录 `_local/shell-local-visual-review-481.json`。下一步推送最终输入，执行 291 ID 的 GitHub 六端完整回归；远端未返回前全部任务仍 in_progress。

### 2026-10-05 空分类截图回归

- 输入 `4df6d953` 的 [run 37309271341](https://github.com/engcapa/taomni/actions/runs/37309271341) 已收到 Linux/macOS browser 各 218/0/0，身份、receipt、配置及原始 ZIP hashes 匹配。但实际 B49 截图仍有空 Messages 分类下的 Settings 搜索框残留，因此本批不能验收。此前 Windows 本机没有该绘制残留，不推广为其它平台通过。
- B49 原隐藏断言只在返回 Code Workspace 后执行；新增空分类截图前的隐藏断言和通过 Actions 返回 Settings 的精确搜索草稿检查。Windows 修前 `490` 为 1/0/0，实际截图无残留，明确未在本机复现远端绘制问题。保留旧远端截图作为视觉失败证据。
- Shell 改为在稳定业务容器上隐藏内容，保留 DOM、控制器与草稿；恢复时先显示容器再发尺寸变化通知，避免终端/编辑器测到隐藏尺寸。新增挂载回归保护隐藏/恢复和 resize 通知顺序，聚焦 `493` 为 4 files / 61 tests 全部通过。N23 增加真实 PTY 未提交输入与 Settings 搜索草稿的空分类往返，共 90 步，原 300 秒预算和原业务断言保持。
- 当前修复仍待本机 browser/native、完整单测及新输入 GitHub 六端验证，全部任务保持 in_progress。

- 本机修后收尾：完整前端 `498` 为 **532 files / 5288 passed / 0 failed**；聚焦 `493` 为 61/0。类型与 catalog/开发契约检查通过。Rust 源码本批没有变动，保留完整 `479` 的 1599/0/16 ignored 结果；隔离 QA build `497` 成功。native `502` 的 N02/N06/N23 为 **3/0/0**，真实 PTY 输入、磁盘保存/撤销及 90 步空分类往返全部通过，7 张实际截图已审阅。
- browser `499` 为 5/0/0，但截图发现长期运行 Vite 缓存了合并前版本号常量。确认该 QA 服务的 PID/仓库/端口后重启为 `504`，读取 runtime defines 确认为 0.4.32；补跑 `506` 的 B07/B17/B46/B47/B49 为 **5/0/0**。8 张新截图已实际审阅。`_local/shell-empty-current-evidence-507.json` 核对两个实际报告的 current/stable identity、case/config、receipt、native build 与完整产物 hashes；没有用 dry-run 代替执行。
- 旧输入 `37309271341` 三端 browser 各 218/0/0，Linux native 78/0/0；Windows/macOS native 此时仍执行。即使最终自动断言全部通过，旧 B49 视觉失败仍保留，本批完成条件继续由新修复输入的六端回归证明。

### 正常重启布局耐久保存与最新 main QA 合并

- 输入 `c769812b` 的 [run 37318695278](https://github.com/engcapa/taomni/actions/runs/37318695278) 六份报告已收齐：browser 三端各 218/0/0，native Linux 78/0/0、Windows 72/0/0、macOS 73/1/0，共 **877 pass / 1 fail / 0 skip**。六份 selection/source/runner/case/config/receipt/native build 与全部 ZIP hashes 匹配；macOS N08 原第 27 步重启后的 stored/rendered 均为 200，原预期 232。原第 14、16、17 步退出前均为 232；不把差异解释成已经证实的某个 WebKit 内部原因，也不以一次重跑抹掉失败。
- 60 张 browser 和 53 张去重 native 代表性画面已实际审阅，三端 B49/N23 空分类没有 Settings 搜索框残留；macOS N08 失败原图另存。三原生 AI/Git/SQL/SFTP 独立观察和 N5～N8 录屏几何/像素/时间校验满足原断言，保留慢样本及满队列未编码样本，不宣称性能改善。当前唯一自动化失败仍阻塞 done。
- 修复增加原生 SQLite 布局来源、旧 profile 一次迁移、串行确认/比较写入、主窗口挂载前读取、Exit 关闭标签前保存等待和失败重试；清除恢复意图等待原生确认。browser 保留 localStorage；两处未知版本/损坏输入均保留，显式 Reset 才覆盖。N08 增加进程退出后的独立只读 SQLite 宽度/恢复记录观察，并等待实际 restore available 后操作，现 38 步，原精确 232 断言与 300 秒预算保持。
- 聚焦前端 `520` 为 **5 files / 77 tests 全部通过**，完整前端 `522` 为 **534 files / 5301 pass / 0 fail**；完整 Rust `521` 为 **1603 pass / 0 fail / 16 既有 ignored**，TypeScript `523` 通过。原生 QA build `525` 成功。catalog `531` 通过。全量 `cargo fmt --check` 有 main 既有格式差异；新增模块及 lib.rs 单文件格式检查通过，未批量格式化无关模块。
- 本机 native `529` 的独立磁盘/重启 232 检查通过，但 Restore 在 snapshot available 前点击，后续工作区等待失败，原失败保留。加 available checkpoint 后 `534` 的 N07/N08/N23 为 **3 pass / 0 fail / 0 skip**，42/38/90 步完整；`535` 的 B17/B34/B35/B42/B46 为 **5/0/0**。两份报告输入 stable、source/case/config/receipt/全产物 hashes 匹配，`shell-durable-local-evidence-537.json` 保留检查时的 current identity；16 张实际截图已审阅。`529/532` 还因测试过程中 helper 关闭句柄调整被判输入不稳定，不冒充完成证据。随后只修改 main CI 单测的 Path subclass mock，不改变产品与 native runtime；最终 runner 输入仍须由 GitHub 统一重跑。
- runner `528` 的 42 项 unit 通过。main 合并后的 `530` 为 54 pass / 1 error，唯一错误是 Windows concrete Path 没有命中基类 is_mount mock；改用 concrete subclass mock。定向 `539` 为 9 pass / 1 error：未模拟架构查询，Windows 的 `ver` 消耗了本应供 Linux XTEST 探针使用的模拟输出；补齐架构模拟后 `541` 的全部 10 项通过。真实 Linux XTEST 检查、teardown 和卸载断言保持，原失败日志保留；本批只调整 unit 的环境模拟，不改变用户行为，原 N08 重启及原生 workflow 继续保护真实边界。
- 再次拉取 main 至 `bc130eee`，通过 merge `5f509399` 合入可选 Linux 桌面环境与 setup/teardown 诊断。仅 workflow 的相邻步骤冲突，保留 main 的 Linux VNC/Wayland 分支及本分支 macOS display helper 退出后的显示尺寸核对。默认 Ubuntu 24.04/Xvfb 不变，本轮仍选择六个 browser/native 平台组合；产品代码没有新增 main 差异。
- 最终 catalog audit `542`、development contract `543` 通过，精确 selection `544` 为 **291 ID / 878 次**：browser 三端各 218，native Linux 78 / Windows 72 / macOS 74；gaps/unreviewed 均为空。TASK-01～12 继续 verification，待统一新输入的完整六端结果与实际证据。
- 统一输入 `8bc41266` 的 [run 37342130547](https://github.com/engcapa/taomni/actions/runs/37342130547) 三端 browser 已收齐，各 **218 pass / 0 fail / 0 skip**，每端 9,393 步，共 654 次执行 / 28,179 步完整；source/runner/case/config/receipt 和全部原始 ZIP hashes 匹配。60 张当前代表性画面已实际审阅，B47/B49/SHOT-017 原尺寸另行查看；空分类无 Settings 残留，沉浸内容和窄视口控件正常。原件与 `evidence-review.json`、`step-review.json`、`shell-visual-review-37342130547/reviewed-*.json` 保留；三个 native 端仍在运行，不用 browser 结果替代 native 验收。
- 随后该运行六份报告全部收齐：native Linux **76/2/0**、Windows **71/1/0**、macOS **72/2/0**，六端合计 **873 pass / 5 fail / 0 skip**。六份身份、stable input、selection、receipt、config、native build 及全部原始 ZIP hashes 匹配。N08 在三 native 端均完成 38 步；独立 SQLite 观察均为宽度 232 / 1 个 workspace，真实进程退出与重启记录通过，见 `durable-oracle-review.json`。这些通过不抵消其余失败，全部 TASK 仍为 verification。
- 三端同一 IDE-027 原第 22 步树宽 247，源于旧用例用 localStorage 缓存覆盖 native SQLite 来源；适配为公开分隔条 Home 后五次 Shift+ArrowRight，精确断言 360，并在最终 reload 后再次断言 360。保留树宽 300～500、全部 stripe ownership / Navigator 操作结果及 300 秒预算，1-based verification 同批更新；待实际复验。
- Linux N6 的 29 帧录屏只有 decoded frame 19 的空间像素失败（8 个 tile），其 id 64 / nonce 45686 / 顺序 / 时间轴通过；失败原图可见移动方块与对应完整原图的位置差异。macOS N12 未达到至少四帧及长于 native preview 的真实源位移要求。根因尚未确证，新增有界 pre-encoder 原始像素保留和 scroll status/sourceTop 采样诊断，保留原 oracle、150 次轮询、20 秒脚本期限及用例预算；诊断不筛除采集帧或改变编码输入。原失败与差分图完整保留，下一轮先做远程精准复验，再执行统一六端验收。
- 诊断与用例适配的本机 `571` 截图 Rust 单测为 **61 pass / 0 fail**；`572` catalog gate、`573` 三份 YAML/schema/reviewed verification 和 `574` 三端 6 ID / 18 次 native 精确选择通过。再次 fetch main，远端仍为已合入的 `bc130eee`。Linux 当前 14 张 native 代表图已实际审阅，终端、SFTP、Notes、Git、AI 与空分类未见新布局残留；这些图不替代修复输入的最终画面。
- 固定输入 `9a10118a` 的 [精准 run 37353593967](https://github.com/engcapa/taomni/actions/runs/37353593967) 共 **16 pass / 2 fail / 0 skip**：Windows 6/0/0、Linux 5/1/0、macOS 5/1/0；三份输入、receipt、config、native build 与全部 ZIP hashes 匹配。IDE-027 三端的全部 70 步和 reload 后 360 通过。Linux N5 的 captured raw 8 与 decoded GIF 8 的 PNG bytes/hash 完全一致，但与 id 44 的独立完整原图不符，确认差异在编码前已经存在，不能据此指定某个 X11 内部根因。其余 11 条录屏均无 retained raw/编码差异；原失败不由这些通过抹掉。
- macOS N12 的原始 progress 记录为 previewHeight 1200、regionHeight 428、poll 149 时 sourceTop 880 / frames 22，整个过程持续 auto、needsOverlap false。440 px 源窗口在原期限内未达到真实长预览条件；改用 640 px 的真实源窗口，仅适配此 controls 场景，仍以实际 OS wheel/stitch、至少四帧、原生 viewport + 160 的源长度及原图像素验收。动画 fixture 改为离屏画完整场景后一次发布至可见 canvas，继续保留实际绘制 PNG、nonce、全部帧、固定 pixel/timeline oracle 和诊断；复验尚待执行。
- 候选 fixture 输入的本机完整 Rust `583` 为 **1602 pass / 1 fail / 16 ignored**，独立临时仓库的 Git config 写入返回 Permission denied，原失败日志保留。检查未发现共享目录或相关权限修改；不改个人 Git 配置，不忽略测试。原测试定向 `586` 为 **1 pass / 0 fail**，不改代码的完整重跑 `587` 为 **1603 pass / 0 fail / 16 既有 ignored**；错误尚未复现，具体原因仍未确认。TypeScript `584`、catalog `585` 与四份 YAML/schema/reviewed contract 检查通过；完整前端 `582` 仍在运行，native 复验尚待启动。
- 随后完整前端 `582` 为 **534 files / 5299 pass / 2 fail / 0 pending**，实际使用本机默认 Node 24 / pnpm 11；保存失败重试测试耗时 17.8 秒后失败，报告只保留 STACK_TRACE_ERROR，原因未确定。截图收藏的 DOM 空列表检查后立即检查 passive effect 清理，改为在同一默认等待期限内单独观察 URL 撤销，保留删除确认、取消和精确 URL 断言。QA 目录按官方 SHA-256/npm integrity 校验准备 Node 22.23.3 / pnpm 10.34.6，与 `.github/actions/qa-runtime/action.yml` 的版本系列一致。修改前两项定向 `595` 均通过（252 项为名称过滤未选中）；修改后的完整前端 `596` 已启动。误传参数分隔符的 `593` 已停止，未作为定向或完整通过证据。没有修改保存重试产品代码、测试超时或原生像素/时间预算。
- 按用户最新范围，`599` 为 TC-001/B06/B38 保存旧→新步骤映射；B06 从 153→148 步，B38 从 217→204 步，其余行为逐项保持，LAN 标签移除后的总览分别精确为 20/6。`600` 检查最终 290 ID 的实际步骤中没有 LAN 操作，N20 排除；`601` 的静态六端计划为 **875 次**，gaps/unreviewed 均为空。计划和契约审查不计为运行通过；最终仍要求统一输入的六端实证。21 个独立业务观察、114 张代表性 UI 画面和 12 张录屏差分的原验收要求继续适用，其范围不包含 LAN。
- Node 22 / pnpm 10 的完整前端 `596` 为 **534 files / 5299 pass / 2 fail / 0 pending**。替换测试在磁盘写入后、事务校验与 Undo 登记前发送快捷键，改为观察成功的 LSP apply-edit 确认；Git 测试在 viewer identity 已变更、异步语言/editor 尚未挂载时检查文本，改为单独等待精确 WORKTREE 内容。原内容、撤销、迟到请求、期限断言保留；`611` 两项定向通过（254 项名称过滤未选中），完整 `612` 正在执行，不能据定向结果宣称全量通过。
- 排除 LAN 后的本机 Windows browser `609` 为 **3 pass / 0 fail / 0 skip、403 步**；`local-browser-evidence-610.json` 核对当时的 current/stable source、runner、case、config、receipt 和 12 个原产物 hashes，四张原始 PNG 已实际查看。Home More、20/6 个总览项、终端与 MFA 画面无主要遮挡；DB renderer fixture 的真实连接边界仍明确。随后 unit 文件修改改变保守 source identity，最终六端候选会重新执行这些用例，不拼接旧结果为 done。
- 当前候选完整前端 `612` 为 **534 files / 5301 pass / 0 fail / 0 pending**；`shell-scene-unit-evidence-588.json` 核对完整文件/测试名称集合与失败轮 `596` 一致，最终源码/runner 与执行中快照一致。Rust `587` 为 **1603/0/16 既有 ignored**，Node 22/pnpm 10 TypeScript `613`、catalog `606`、相关 Rust 单文件 rustfmt 与 diff check 通过。原失败完整保留，未改超时或像素预算；远程精准复验和最终同输入六端仍是后续必要验收。
