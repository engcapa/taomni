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
| TASK-11 用例与自动化支持 | verification | 随相关实现 | 已领取；61 条 Shell YAML（45 browser / 16 native）及受影响回归、catalog/policy |
| TASK-12 集成与验收 | verification | 02–11 | 单元测试、三平台 browser/native、结果分析与修复 |

## 本轮实施进度

TASK-01～10 已集成，TASK-11 的当前用例和 runner 支持已实现；TASK-01～12 处于 verification，尚未标记 done。前三轮 GitHub 的实际失败证据完整保留，第四轮三端 browser 已完成，native 仍在运行；继续按逐 case 结果修复。

最新开发批次已集成稳定主工作面、SFTP 后台/跨窗口任务、Git/Notes 窗口恢复、workspace 并行恢复与取消，以及退出/数据库事务边界。第四轮 selection 为 240 个独立 ID（三端 browser 各 183，native Linux 65 / Windows 59 / macOS 58），包括全部截图回归和 AI streaming/history；补充的 Git N21 待下一轮一并提交，届时为 241 ID。数量以具体运行的 selection 为准。按用户要求，本地仅运行单元测试和静态检查，browser/native 与原生构建交给 GitHub。

新增用例不等于整条设计规格全部验收。N01/N13/N14 的自动化部分复用既有 case；N11 的实际 OS picker/权限/UNC、Windows/macOS 真 IME、DPI/读屏与 N17 匹配性能基线仍有证据缺口。详细映射在 [用例登记](./workspace-shell-ux-redesign-test-cases.md#current-execution)。这些缺口未记为 pass 或 done。

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
