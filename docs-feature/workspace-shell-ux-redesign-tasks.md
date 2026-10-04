# Workspace Shell 实施任务

设计：[详细设计](./workspace-shell-ux-redesign-design.md) · [用例](./workspace-shell-ux-redesign-test-cases.md)。

领取者：Codex。基线：`5fb098474f072f4e0c7e99407ab0d072b7d49c53`，分支 `feat/ui-layout-refactor`。
用户已授权实现、本地单元测试、推送及 `qa-ui-auto-platforms` browser/native 循环验证。
状态：`todo` → `in_progress` → `verification` → `done`；只有最终输入对应的实际验证满足验收后才标记 done。

| 任务 | 状态 | 依赖 | 交付 / 验证证据 |
|---|---|---|---|
| TASK-01 契约与纯模型 | verification | 无 | 已领取；类型、身份、尺寸策略、Shell store |
| TASK-02 壳层布局集成 | verification | 01 | Rail / Navigator / MainLayout / ControlBar |
| TASK-03 标签与 action 路由 | verification | 01,04 | lane、总览、快速切换、快捷键 |
| TASK-04 实例与关闭事务 | verification | 01 | stable surface、close coordinator、DB adapter |
| TASK-05 SFTP 与任务 ownership | verification | 01,04 | view/job lease、后台、promotion |
| TASK-06 Workspace / Git | verification | 01,04 | Project、tools、Git Host |
| TASK-07 Tao / 通知 | verification | 01,04,05 | Hub、目标解析、成功后确认 |
| TASK-08 Home / 恢复 | verification | 01,03,10 | 三主动作、最近项、组合恢复 |
| TASK-09 原生窗口 | verification | 04,05,06,07 | Git、detach 事务、回停靠 |
| TASK-10 持久化与回退 | verification | 01,04,07 | v2 migration、恢复 identity |
| TASK-11 用例与自动化支持 | verification | 随相关实现 | 已领取；62 条 Shell YAML（45 browser / 17 native）及受影响回归、catalog/policy |
| TASK-12 集成与验收 | verification | 02–11 | 单元测试、三平台 browser/native、结果分析与修复 |

## 本轮实施进度

TASK-01～10 已集成，TASK-11 的当前用例和 runner 支持已实现；TASK-01～12 处于 verification，尚未标记 done。第四轮六份报告及后续 browser 定位运行已收齐，继续按逐 case 结果修复；历史失败证据完整保留。

最新开发批次已集成稳定主工作面、SFTP 后台/跨窗口任务、Git/Notes 窗口恢复、workspace 并行恢复与取消，以及退出/数据库事务边界。第五轮已提交 Git N21，selection 为 241 个独立 ID（三端 browser 各 183，native Linux 66 / Windows 60 / macOS 59），共 734 次执行，包括全部截图回归和 AI streaming/history。数量以具体运行的 selection 为准。按用户要求，本地仅运行单元测试和静态检查，browser/native 与原生构建交给 GitHub。

新增用例不等于整条设计规格全部验收。N01/N13/N14 的自动化部分复用既有 case；N11 的实际 OS picker/权限/UNC、Windows/macOS 真 IME、DPI/读屏与 N17 匹配性能基线仍有证据缺口。详细映射在 [用例登记](./workspace-shell-ux-redesign-test-cases.md#current-execution)。这些缺口未记为 pass 或 done。

最新候选新增 N22 的单仓库 Git 真操作，与 N21 的真实双 root 提交分开验收。远程统一选择增至 242 个 ID；预期 browser 三端各 183，native Linux 67 / Windows 61 / macOS 60，共 737 次执行，以最终 selection 核对。本批先定位已知失败与新的 Git case，取得邮件协议诊断后再回到最终输入的统一验收。

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
