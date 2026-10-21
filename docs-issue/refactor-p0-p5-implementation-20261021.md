# P0–P5 重构实施与证据

分支：`refactor/p0-p5-architecture`；原始基线：`f3e375eb`。

这是一项进行中的全仓重构。阶段完成要求原实现真正迁出、生产调用接入、保留契约经过验证。新增未接线的 controller 或仅验证自身的测试不算完成。早期未接线草稿已移除。

| 阶段 | 当前状态 | 剩余验收 |
| --- | --- | --- |
| P0 基线 | 已记录 761 个实际注册命令、299 个 façade 导出、39 个前端字面量事件；IPC/store 改前 68 项测试通过 | 完成全部受影响工作流映射、回归证据 |
| P1 IPC/启动/状态 | IPC/slices/native registrar/stub registry/domain runtime 已迁移 | 三端启动与全量 native 回归 |
| P2 Workspace/LSP | 部分实现，见批次 A | 编辑器、LSP、文件/执行服务实际拆分与回归 |
| P3 Shell/Session | 部分实现，见批次 A | MainLayout、SessionEditor、TerminalPanel 实际拆分与回归 |
| P4 Mail/DB/File/Git | 部分实现，见批次 A | UI、服务与传输边界实际拆分与回归 |
| P5 协议/系统能力 | 部分实现，见批次 A | RDP/VNC、SocksCap、Screenshot、Chat/LanChat/Backup 实际拆分与回归 |

## 保留契约

- 旧 `src/lib/ipc.ts`、`src/stores/appStore.ts` 导出继续可用；命令名称、参数、默认值、返回值、Vault 提示和异常传播保持一致。
- 终端输出 Channel、数据库流式结果与探测连接的 finally 清理保持一致。
- Store 各 slice 使用同一个 Zustand store，跨 slice 更新保持原来的单次 set 事务；历史工作区、侧栏、终端、查询上下文和持久化键保持一致。
- 浏览器专用 parity/MFA/voice/backup 拦截顺序保持一致，原 switch 的 fallthrough、undefined 返回与未知命令 fallback 保持一致。
- 原生命令路由只改变注册位置；平台 cfg、Tauri 参数反序列化与错误处理仍由原命令宏负责。

## 检查与证据

`node scripts/refactor-contracts.mjs` 检查旧命令/导出/字面量事件没有移除，不能证明 payload 或 native 行为；动态事件名称不在该目录断言范围。

改前：`pnpm exec vitest run src/lib/ipc.test.ts src/stores/appStore.test.ts`，2 文件 / 68 测试通过。相同测试在 IPC/slices 拆分后通过。

后续以具体测试日志、GitHub run URL、selection、runner receipt 和 summary 记录结果。没有运行或仍失败的项目不得标记为通过。前期未接线草稿的 14 个测试及 Rust architecture 测试不作为任何阶段完成证据。

## 2026-10-21 实施批次 A（仍在推进）

已迁移并接入生产调用：

- P1：20 个 IPC 领域模块、6 个 Zustand slices、18 个 browser stub handler；761 个 native 命令按领域分发。AppState 的工作区、邮件、终端、文件、远程桌面、数据库和 Agent 资源改由 7 个 domain runtime 持有，旧锁与 Arc 实例仍由同一个 AppState 创建。
- P2：LSP 进程/传输/请求/Java/诊断与工作区文件/执行 provider 分离；CodeWorkspace 的保存、WorkspaceEdit、恢复、导航、重构、命令和运行操作接入 controller factories；CodeMirror 剪贴板、视图状态、命令、提示层和文档同步迁出。主组件中的状态与 effect 仍需进一步拆分，尚未宣称 P2 完成。
- P3：SessionEditor 基础字段与协议表单；MainLayout 的连接队列、认证、分离窗口、恢复和控制工具；TerminalPanel 的 buffer、协议、输入策略和传输 helpers。终端生命周期和剩余视图拆分待完成。
- P4：Mail 的 IMAP pool/transport/messages、OAuth、SMTP、缓存、附件及命令模块；MailClient 正文加载、同步、读状态、附件；DB 查询执行、事务、工作区持久化、grid SQL/export/model；Git worktree/remote/branch/history/operation 命令与底层进程/查询/blob 分离。FileBrowser 的传输 service 已在基线独立，需要回归验证现有分层及共享 AppState 迁移。
- P5：RDP queue/lifecycle/clipboard/audio/input/display；VNC stream/security/writer、relay/frame/input/clipboard/transport；SocksCap platform capture、lifecycle、launch、upstream、recovery、diagnostics；Screenshot QA fixture/evidence/capture/scroll/recorder/input/platform 分离；Chat attachment/media/stream/context/presentation 分离。LanChat 与 Backup 在基线已按 transport/store/transfer/worker 等领域拆开，后续重点验证保留行为，不为行数重复搬迁。

各阶段仍以剩余工作与最终证据验收。

### 当前验证

- `cargo check --manifest-path src-tauri/Cargo.toml --tests`：通过，含 7 个 AppState domain runtime 和协议模块拆分。日志 `qa-ui-auto-report/refactor-p0-p5/state-check-2.log`。
- `pnpm build`：通过。日志 `build.log`。
- CodeWorkspaceTab + CodeMirrorHost 原 mounted tests：327 项通过。日志 `editor-tests.log`。
- MainLayout、TerminalPanel、DbClientTab、QueryResultGrid、MailClientTab、SessionEditor：310 项通过，1 项由 `__TAOMNI_TERMINAL_TEXT_MIRROR__` 条件跳过；另一编译模式仍需验证。日志 `ui-tests.log`。
- IPC/store/registry + 新增真实 stub dispatch 集成测试：80 项通过。仅 IndexedDB 写入边界被 mock，invoke 注册、路由、raw body/header、stream 生命周期、会话持久化和 Vault 都走实际实现。日志 `stub-integration.log`。
- `node scripts/refactor-contracts.mjs`：761 命令/299 导出/39 字面量事件保留，且 dispatcher 的命令集合、目标 handler 与注册宏一致。
- `qa_ui_auto.audit --gate`：通过，原有 shallow/orphan 条目仍作为静态审计信息保留；审计不代表运行覆盖。
- 全量 Vitest：539 文件、5451 passed / 1 conditional skip，416.71s；日志 `unit-all.log`。Rust lib/integration tests 运行中；三端 GitHub 执行待记录。

### 保留用例与回归边界

本批次为实现位置/依赖边界重构，无意改变用户流程、控件或 IPC payload；因此复用原有用例，不新增只检查页面存在的重构 smoke。最终使用 workflow 的 `scope=all` 验证全部登记场景。下面列出关键保留断言，不能用其子集代替最终全量结果：

| 边界 | 现有用例 | 保护目标 |
| --- | --- | --- |
| 主窗口、工作区入口 | TC-001、TC-064 | 原有 UI surfaces 与入口接线 |
| 保存与恢复 | TC-IDE-PARITY-002、TC-IDE-IMPROVE-002、TC-IDE-AUDIT-014 | 真实 native 写入/ack/watcher 竞态、dirty 保留、恢复日志 |
| SSH/SFTP | TC-012、TC-027、TC-SSH-VI-001 | 附加 SFTP/终端 cwd、列表、真实 SSH 编辑 |
| 数据库 | TC-DB-EDIT-001-grid-sql-preview-native、TC-DB-DETAIL-001-table-detail-native | grid 保存 SQL/无主键提示、表详情 |
| 邮件 | TC-MAIL-ATTACH-01、TC-MAIL-BULK-03 | 附件提醒、复制与恢复 |
| Vault/MFA | TC-MFA-001、TC-MFA-002 | 入口锁定、持久化与复制 |
| VNC/RDP | TC-151、TC-158、TC-RDPC-REF-02-xrdp | 实际 RFB 输入/resize/clipboard、真实 RDP 连接 |
| 截图 | TC-SHOT-001、TC-SHOT-034 | overlay 入口、收藏恢复 |
| Backup | TC-BACKUP-001、TC-BACKUP-CLOUD-001、TC-BACKUP-CLOUD-003 | 后台任务、独立代理配置、服务恢复 |

上述 IDs 来自当前仓库用例。平台能力不支持、skip、缺少 receipt 的结果不计通过；最终报告需记录 selection、原始 receipt 和 ci-summary。

## 2026-10-21 实施批次 B

继续接入生产入口，保持原有闭包时点、effect 依赖、订阅清理和异步失败传播：

- P2：编辑器 toolbar/editor group 视图、buffer mutation/统一字节写入/save commit、比较、树动作、语义查询、菜单、恢复日志、布局持久化和启动操作继续迁出。项目诊断、语义装饰及工作区偏好开始拥有独立 hook 生命周期；原有 generation/epoch/取消保护保留。CodeWorkspaceTab 仍有 12,949 行的状态与编排，不能把它描述为已经完成的轻量 shell。
- 编辑器原测试按行为迁入 15 个 case 模块，共享原 mocks/setup/fixture，不通过复制实现验证自身。原基线的 236 个字面量测试名完整保留，参数化展开后仍为 252 项。修复共享 clipboard mock 未恢复导致的测试顺序依赖：每个用例前清空内存剪贴板并恢复 read/write mock 实现。保存路径静态保护改为扫描主组件和全部 controller，仍只允许统一 writer 内的两个 encoded 写入调用。
- P3：Terminal session 生命周期和 viewport effect、MainLayout TabContentRouter/分离窗口事件、SessionEditor 通用连接字段迁出。终端连接类型直接依赖领域 types，旧组件导出兼容；全局 registry 和后台会话 owner 不随视图拆分重建。
- 会话导入按 portable/CSV/MobaXterm/Xshell/Tabby/数据库客户端/终端配置/ZeroOmega/归档/公共校验拆分，旧入口仅显式 re-export。公共校验不反向依赖格式解析器。原基线公开导出也纳入契约快照。
- P4：Mail toolbar/folders/messages/reader/composer 视图、draft actions、outbox hook 接入原流程；发送成功与异步 Sent-copy 状态仍分开。SQL 连接、查询/流式结果、值解码、语句分类、MySQL/PostgreSQL/SQL Server 元数据服务分离；所有新 SQL 模块使用显式导入，无 `super::*`。
- P5：SocksCap preflight/start/stop/recover/redirector 生命周期操作迁出，原权限提示、独立代理选择、诊断与恢复行为保留。
- P0：新增 `scripts/refactor-boundaries.mjs` 检查迁移目录不回引各自 facade/UI shell、无目录内运行时循环；包含 inline import type 和动态 import 检查。`pnpm build` 同时执行契约和边界检查。此静态约束不替代行为测试，也不声称检查了全仓所有动态依赖。

### 原有测试假设的修复

1. 原 `three_source_probe` 期望旧 models manifest 含 ASR；`0bc9d88b` 已将 ASR 迁至独立 pinned catalog。集成测试继续校验 LLM，新增 ASR catalog 单元测试校验真实 MODELS 非空、预期大小、有效 SHA-256 和下载 URL。没有为测试重新添加旧 manifest 条目或暴露内部 API。
2. 原保存静态测试依赖 `const writeTextSnapshot = useCallback(async ...` 源码位置；迁出后改为 AST 检查全部 controller 的写入边界，断言两个 encoded writer 恰好各一处，未允许绕过统一保存入口。
3. GitHub macOS browser `TC-IDE-PARITY-017-02` 在第二次 Undo 失败：trace 中第二次 Meta+z 始于 725192.624ms，而首次 `Undid Rename symbol` 完成状态直到 727589.460ms 的快照才出现。buffer 文本早于 journal bookkeeping 完成可见，busy journal 原本就拒绝重入。用例 step 35 从固定等待 0.8s 改为断言首次撤销完成提示；原 82 步的编号及完整文件内容断言保留，补充该完成状态检查的 requirement 映射。

### 批次 B 验证记录

- `unit-d.log`：540 文件中 539 通过，5454 项通过、1 条件跳过、1 失败（上述旧保存路径静态假设）。`write-boundary.log` 修正后保存边界 + 全部会话格式测试 66 项通过；保留失败日志。
- `terminal-qa-b.log`：QA 编译模式终端 86 项通过、1 条件跳过，与默认模式互补。
- `db-contract2.log`：SQL 拆分后 database 单元测试 62 通过、1 ignored；ignored 不是通过。
- `build-e.log`：生产构建与 761 命令/新增后的 façade 导出/39 事件及边界检查通过。后续只调整类型依赖与静态测试；最终构建记录在 `build-final-b.log`。
- `browser-extract`：当前 Linux Chromium 完整执行原 TC-IDE-PARITY-017-02，82 步通过；更新完成状态等待后的报告在 `browser-extract-completion`。这不是 macOS/native 证据。
- 最终组合上的全量 Vitest、Rust lib/integration、构建分别记录在 `unit-final-b.log`、`rust-final-b.log`、`build-final-b.log`；完成结果待追加。

### GitHub 批次 A 证据（不代表 B 的最终源码）

源码 `d10b8917f16a381f5c964a22fdf719f69c94f2a6`，workflow run：
<https://github.com/engcapa/taomni/actions/runs/39552025913>。

三端 native 构建通过。已下载 12 个 browser 原始报告并校验 summary 哈希与 runner receipt 签名：Linux 396 passed；Windows 396 passed；macOS 393 passed / 1 failed，失败为上述 Undo 时序用例。执行 job 的 success 不能替代用例结果，聚合报告仍需检查。native 分片仍在执行，最终以 aggregate 的结果为准。

selection 有 3 个外部项目能力缺口：三平台 `TC-IDE-C6-06-java-definition-realproject-native` 需要 `QA_JAVA_PROJECT_ROOT` 指向仓库不分发的 clickhousecrud 项目；这些项目不能计为通过。其余 unreviewed/not_applicable 是登记或平台/模式配对信息，不能混入 passed。

为区分旧时序假设与本次回归，安排基线 `f3e375eb` 在 macOS browser 执行原用例：
<https://github.com/engcapa/taomni/actions/runs/39556543432>。该 run 的 workflow ref 是重构分支，实际测试源码由完整 head 输入指定为原始基线。

### 剩余退出条件

P0–P5 仍未全部完成：编辑器主壳的大量状态/事件/工具窗口编排、Session/Terminal 剩余表单与输入责任、Git/File 现有分层的完整验收、部分 Rust glob 依赖和最终提交上的三端 native 证据仍需收敛。所有本地或 GitHub 既有失败、能力缺口均保留，不用旧提交的成功覆盖新提交。

### 批次 B 最终本地结果

- `unit-final-b.log`：540 文件全部通过，**5455 passed / 1 conditional skip**；终端 QA 模式另有 86 passed / 1 conditional skip，覆盖另一编译分支。
- `rust-final-b.log`：**1868 passed / 25 ignored**（lib）、**62 passed**（integration）。ignored 保持基线条件，未作为通过。
- `build-final-b.log`：通过；契约检查为 **761 native commands / 328 façade exports / 39 literal events**，包含 29 个旧会话导入导出 API；155 个实现模块边界检查通过。
- `audit-b.log`：全部静态 gate 通过，无目录/requirement 漂移。
- `browser-extract-isolated`：更新后的 TC-IDE-PARITY-017-02 **82 步全部通过**，有完整 summary/receipt。前一次 `browser-extract-completion` 在并行工具运行期间页面重新导航到 welcome，导致 step49 超时；保留失败报告和 trace，不改断言，在构建/单测结束后隔离重跑。仅证明本地 Linux Chromium。
- 基线 macOS browser 对照 run `39556543432` 完成；需与重构提交的原始报告比较，单次基线成功不代表负载下不会出现上述 busy 时序。
- 批次 A native 已发现待定位失败：Linux/macOS `TC-RDPS-PERF-03-photo-content` 的 FPS 比率约 0.90，低于原 0.95 阈值；macOS `TC-MAIL-STORAGE-09` 的 server 18 条与 UI 0 条不一致；macOS `TC-152` VNC 会话菜单未出现。保留原阈值/断言，后续使用最终提交与必要的基线对照定位。

### 批次 B GitHub 原始报告核验（2026-10-21）

Run [39557611607](https://github.com/engcapa/taomni/actions/runs/39557611607)，实际源码 `ef10df6b34163a3bc851c4bc230fc102980d3f72`。从 `github-final/qa-*/run-*/` 核验 25 份 runner receipt 签名、summary SHA-256 及 `identity_stable`；不重复统计 diagnostics 副本。25 份源码指纹一致（`5f0f19306fbe019f37bc6e9649a8718cae6fa335ffe064e9566ae6060546e923`）。

| 平台 | Browser | Native |
| --- | --- | --- |
| Linux | 396 passed | 214 passed，另 dual-display 1 passed |
| Windows | 396 passed | 198 passed / 1 failed |
| macOS | 394 passed | 186 passed / 1 failed |

合计 **1785 passed / 2 failed / 0 skipped**，另有原有 3 个外部 Java 项目能力缺口。99 个 unreviewed 条目不因运行成功而自动成为已审核覆盖。汇总 `passed=false`、`report_ok=true`：该 workflow 的全量模式有意仅对基础设施/报告完整性设失败门禁，只有 selected 模式要求所有用例通过，因此绿色 workflow 不能说明用例全部通过。

失败与处理：

- Windows `TC-BACKUP-001` step 38，点击禁用自动备份后 `assert_file_contains` 立即因 PermissionError 退出（该步骤耗时 0）。策略保存使用临时文件加原子 rename；读取断言原有 15 秒轮询只处理缺文件/内容未就绪，没有处理原子替换期间 Windows 短暂访问冲突。修复 runner 在原超时内重试 PermissionError/FileNotFoundError，并保留最后错误；不修改应用写入行为、超时、用例内容断言。4 个新回归测试分别验证短暂冲突后读取真实文件、持续拒绝访问失败、缺失后错误内容仍失败、其他 I/O 错误即时失败。
- macOS `TC-RDPS-PERF-01-performance-budget` step 28，40 个有效输入样本、0 timeout，p95=72.403542 ms > 65 ms。保留阈值与失败样本，安排原基线同用例及 photo-content 对照。性能问题未解决前不算通过。
- 原批次 A 的 Undo、邮件列表、VNC、photo-content 失败在本轮对应平台原始报告均通过；本轮不能抹去之前失败记录，也不能证明以后没有性能抖动。

原始文件保留在 `qa-ui-auto-report/refactor-p0-p5/github-final/`，汇总 `qa-summary-749f8f80c503487f96d591c6dbde1caa/ci-summary.json`。P0–P5 剩余架构退出条件仍未完成。

## 2026-10-21 实施批次 C（进行中）

用户确认 CodeWorkspaceTab 仍过大，并要求其他大文件采用相同职责拆分标准。本批次进一步迁移真实 hook 状态与 lifecycle，仍不能将入口文件描述为轻量 shell：

- CodeWorkspace：保存编排、外部文件变更订阅/合并/关闭、运行配置发现、JUnit 测试发现/执行/结果、符号重构/Extract 命名、断点弹窗、Git HEAD/blame 缓存与异步效果、键盘/MRU 切换、工具窗口尺寸/显隐生命周期成为独立 hooks。Git 缓存与 Extract session 的 state/ref 归属 hook；保留前序控制器读取 later bindings 的惰性访问，避免 render 时 TDZ。
- 批量替换的整体 preflight 与磁盘快照核对，以及 tab policy 的资源清理/原子布局提交/恢复结果，迁出 JSX 到 controller。工具窗口菜单、条带和 pane 的视图组织单独实现。
- MainLayout：原生菜单安装与主窗口键盘监听归属 `useMainMenuBridge`，原注销/取消和最新 handler ref 保留。
- SessionEditor：保存/另存代理/模板/删除、邮件 OAuth、SSH/DB/HBase/代理连接探测各有独立 actions；原 JSON/校验表单状态尚未完整归并，不能算 Session shell 已完成。
- TerminalPanel：命令历史/建议状态归属 `useTerminalSuggestions`；IME 过滤、输入暂存/释放、广播、二进制输入与 CWD 请求归属 `useTerminalInput`，复用原 session refs 和 cleanup。
- MailClientTab：flags、移动/复制、垃圾箱/永久删除、批处理幂等 session、失败重试、incoming filters 与缓存列表对账迁入 mutations 模块。
- SocksCapPanel：rootless 应用配置、启动前检查、已启动进程清单和停止操作迁入 applicationLaunch。
- 新 workspace hooks 纳入反向 facade 依赖和 runtime cycle 检查。保存静态保护同时扫描 controllers/hooks，仍限定统一 writer 中两处 encoded 写入，并要求只存在一个 writer 接线。

均为行为保持重构，复用原测试与 testcase；不添加仅检查重构后文件/函数存在的用例。保留的关键流程包括 TC-IDE-PARITY-017-02、TC-IDE-C4-01、TC-IDE-C4-02、TC-IDE-CW-LAYOUT-01、TC-019、TC-MAIL-BULK-03 和原 Session/Terminal/MainLayout mounted tests。

### B 后续定向 native 与性能基线

- 修复 runner 的提交 `db2befbf9f8888c8b0c3625687bf47ce5c798632`：run [39567883553](https://github.com/engcapa/taomni/actions/runs/39567883553)，Windows/macOS 各执行 TC-BACKUP-001、TC-RDPS-PERF-01-performance-budget、TC-RDPS-PERF-03-photo-content。6 份原始报告签名/summary 哈希/identity_stable 验证通过，**6 passed**，aggregate passed=true。macOS p95=44.35825 ms、Windows p95=35.9545 ms。没有修改 RDP 实现或阈值，因此不称为性能修复；此前全量超标仍保留。
- 原始基线 `f3e375ebdeb63e8dad0af807dddf8c475142edf8`：run [39567671565](https://github.com/engcapa/taomni/actions/runs/39567671565)，macOS 原生性能 2 项，**1 passed / 1 failed**。receipt/hash 均验证。PERF-01 p95=50.130166 ms，通过；PERF-03 photo-content FPS ratio=0.8014557576021836 < 0.95，失败。说明 photo-content 超标在重构前也存在；不同 hosted runner 的单次结果不能证明性能等价或提速。RDP server 实现目录 `src-tauri/src/servers/` 在基线至本分支没有变更。
- 本地 raw artifacts：`github-followup/`、`github-perf-baseline/`。这两次结果绑定 B 后的源码，不能代表 C。

### C 本地验证（暂记）

- `editor-c-stable.log`：CodeWorkspaceTab 原 252 项 + 保存字节/写入边界 20 项，**272 passed**。
- `types-c5.log`、`types-c6.log`：对应当时迁移组合类型检查通过。
- `unit-c.log`：**539 files passed / 1 suite failed，5407 passed / 1 conditional skip**。失败套件 MainLayout 因新 hook 末尾整理空返回值时生成多余逗号，transform 失败；其余所有套件（含 editor/mail/session/terminal/sockscap）通过。已修正空返回值，后续 focused MainLayout 与 build 记录待追加。
- `editor-c.log`：误用 `pnpm test -- ...`，Vitest 将分隔符后参数视为脚本参数，实际启动全量；包含 StructuralSearch 单次失败，主动停止并保留日志。后续正确用 `pnpm exec vitest run <paths>`。最终 unit-c 中 StructuralSearch 已通过。
- `editor-c-focused.log` 在状态迁移过程中启动，保存静态路径假设未同步，后主动停止；修复并稳定后由 editor-c-stable 完整覆盖。
- `types-c3.log`：Git hook state 移入后留了一个旧 setter 参数及未使用 import，已修复，后续类型检查通过。

- `main-c-fixed.log`：修正后 MainLayout 原 **48 tests passed**，与 unit-c 已通过的 5407 项合计覆盖原全量 **5455 passed / 1 conditional skip**。无需把相同 539 套件无差别再跑一轮。
- `build-c-fixed.log`：类型检查通过后，边界 gate 抓到新 terminal hook 的两个类型仍回引 TerminalPanel façade；修为直接依赖原 `panel/types.tsx` 领域类型，未改变运行逻辑。最终构建 `build-c-final.log`。

本批次后六个主要入口（未计新模块）行数：CodeWorkspaceTab 10477，MainLayout 2643，SessionEditor 2122，TerminalPanel 2575，MailClientTab 3638，SocksCapPanel 3391。入口仍有剩余状态/视图编排，需要后续批次；不能据此宣布 P0–P5 完成。

### C 本地验收补充

- `build-c-final.log`：生产构建、761 commands / 328 exports / 39 events 契约及 **175 modules** 边界检查通过。
- `terminal-c-qa.log`：终端 QA 编译模式 **86 passed / 1 conditional skip**，与默认模式互补。
- `audit-c.log`：全部静态 gates 通过。
- `browser-c/run-20261021-165707-464696343`：Linux Chromium 原用例 **4 passed / 0 skipped**，TC-IDE-C4-01（80 步）、TC-IDE-C4-02（46 步）、TC-IDE-CW-LAYOUT-01-resize-and-split-browser（54 步）、TC-IDE-PARITY-017-02（82 步）。签名、summary 哈希及 identity_stable=true 核验通过。三端 native 仍需 GitHub 上本批次源码证据。


## 2026-10-21 实施批次 D（继续处理全部大文件）

用户明确要求所有大文件按相同标准处理。本批采用职责模块、状态 owner 与 retained workflow 共同验收；不以行数下降代替架构完成。

- Git：工作区仓库 scope/model、branches/tags/settings 视图、操作确认与菜单分离；单仓库 changes/branches/tags/stash/settings、纯 model 与 actions 分离。
- Debug：断点 state/ref/persistence、Watch 表达式 state/persistence 分别由 hook 拥有；断点同步、断点 actions、DAP 事件及 closing drain、launch group、execution、memory/variables/source inspection 分离。公共 hook 导出保留，内部模块直接依赖领域 types，禁止回引主 hook。
- Code Workspace：173 个命令项（含 mnemonic spreads）按 13 个领域注册，保留顺序；一次 AST 对照确认每项实现与原注册顺序相同。AI 选区/改写草稿、恢复日志、reference sessions、buffer store teardown、UI actions 状态、completion、semantic navigation、local history、layout persistence、splits、run/build、encoding、bookmarks、comparisons、document sync、WorkspaceEdit snapshots、generate/intention、library sources、usages 等接入独立 hooks。
- Main：terminal profile overrides、session resume waiters/snapshot refs、split sizing state 归属 hooks；protocol tabs、workspace/Git tabs、shell sessions、退出确认、控制工具监听独立编排。
- Session：邮件、数据库、local shell/WSL 表单分域；序列化/校验与重置显式使用领域 form，保留协议切换、初值、持久化和 Vault 数据格式。
- Terminal：搜索状态、延迟查询、焦点恢复归于单一 hook；clipboard/file-drop、recording/macro、快捷键、context menu、pointer selection 分离；继续复用 session lifecycle owner。
- Mail：邮箱初始化/轮询/IDLE 生命周期、composer 附件与 native drop、读附件、导出/打印、文件夹变更、邀请、证书确认分离。
- SocksCap：profile、upstream、rules、traffic、application scope 视图与 actions 分离；rootless application draft 的 state/reset/edit 由 hook 拥有，view 直接接收该领域对象。
- Database：事务状态、query workspace hydration、query registry bridge、schema、grid changes、query panels、generated SQL、statement、AI actions 分离。

这是保持行为的拆分，不为文件移动新增重复 testcase。原 TC-IDE-C4-01/02、TC-IDE-CW-LAYOUT-01、TC-IDE-PARITY-013-01/018-01/025-01/026-03、TC-018、TC-auto-F-Sockscap-1 以及 retained unit/mounted suites 继续验证真实入口；native 由三端 workflow 验证。

| 入口/领域 | C 批次行数 | D 当前行数 |
|---|---:|---:|
| CodeWorkspaceTab | 10477 | 7955 |
| useCodeDebugSession | 3312 | 697 |
| commandCatalog | 2228 | 224 |
| WorkspaceGitManager | 2499 | 1118 |
| GitPanel | 2075 | 897 |
| MainLayout | 2643 | 1615 |
| SessionEditor | 2122 | 1633 |
| TerminalPanel | 2575 | 1800 |
| MailClientTab | 3638 | 3032 |
| SocksCapPanel | 3391 | 1344 |
| DbClientTab | 2082 | 1312 |

新全文件清单 `source-code-inventory-refactor-current.tsv` 包含本次组合 2396 个代码文件，原始 TSV 保留用作基线。新增模块增加总行数，类型与依赖显式化有成本；不宣称性能提升。主 editor、Mail、CodeMirror、completion 和部分 Rust 系统模块仍需收敛，P0–P5 未全部完成。

### D 验证记录

- `git-d.log`：原 Git 27 tests passed。
- `debug-d.log`：原 Debug 59 tests passed。
- `editor-d-fixed.log`：Editor/Git/Debug/文件模板/保存字节 **365 passed**。
- `clients-d-tests.log`：Mail/SocksCap 原 **103 passed**。
- `d-shell-tests.log`：Main/Session/Terminal **190 passed / 1 conditional skip**；保留原条件跳过。
- `d2-editor-db.log`：Editor/文件模板/保存字节/Db **319 passed**。
- `build-d-node22-final.log`：使用独立临时 Node 22.23.3、pnpm 10，生产构建及契约/304 模块边界检查通过。
- `browser-d/run-20261021-174233-547973156`：Linux Chromium **9 passed / 0 skipped，458 步**；receipt signature、summary sha256、identity_stable 核验通过。仅是浏览器证据，不替代 native。
- 全量 Node 22 Vitest 在 `unit-d-node22-final.log`，结果待追加。
- 初次 AI 状态归属迁移误删了 editor group 的 `setEditorAiSelection` 参数；类型检查与原文件模板 mounted tests 抓到，已补回，以上通过记录覆盖修复。失败日志 `editor-d-build.log` / `editor-d-probe.log` 保留。
- `clients-d-types.log` 抓到拆分后的 sidebar cfg nullable 边界，改为调用方实际保证的非空配置；`clients-shell-d-types.log` / `d-integrated-build.log` 抓到 split class 字符串推断与漏导入，已修复。早期 Node 22 命令因 PATH 不含 pnpm 退出 127，未执行测试；最终使用继承 PATH 并前置 Node 22。

### C 三端原始结果（下载/核查中）

[39573498970](https://github.com/engcapa/taomni/actions/runs/39573498970) 绑定 `6e3a39b1e9dfaefd23498f4c9afb381d108f46b5`，不代表 D。本次已核查报告发现 Linux native 的 TC-BACKUP-CLOUD-001/002 在 fixture setup 的 `secret-tool clear` 失败，还没有执行应用步骤；当前调查凭据 fixture 原始失败，不能当通过。完整 aggregate 与 raw receipts 待下载完后追加。


D 补充：`unit-d-node22-final.log` 全量 **540 files passed，5455 passed / 1 conditional skip**。最终组合生产构建/边界已通过。此批 frontend 纯重构，Rust 源码未在 D 修改，复用 B 的 Rust lib/integration 本地结果并继续执行 GitHub native build/contracts。

C 凭据 fixture 诊断：Linux job 119139144468 的原日志显示 `secret-tool store` 激活了另一个 `gnome-keyring-daemon --start --foreground`，随后尝试 SystemPrompter 但无 DISPLAY，无法解锁。隔离 D-Bus + 临时 XDG 的本地 probe 复现旧命令返回后 NameHasOwner=false，随后才 true；增加 `--daemonize` 后返回即 true。提交 `b19a671c` 增加等待初始化的参数；store/lookup 失败时不再用 finally 的 clear 错误覆盖原始失败，成功 roundtrip 后清理失败仍使 fixture 失败。5 项 Python 回归通过，包括双重失败保留原错、成功后清理失败不放行。真实 native 应用用例仍需最终 workflow，不能用本地 D-Bus probe 代替。

本批代码提交：`6965cea5`、`b4704fb7`、`23c1b523`，runner 修复 `b19a671c`。GitHub C 下载曾发生 artifact unexpected EOF，保留失败日志并仅补下缺失产物。

## 2026-10-21 批次 D 三端验收结果

[GitHub run 39580464092](https://github.com/engcapa/taomni/actions/runs/39580464092) 实际测试提交 `b75c69f075378dfe5816836d27498bcb11ef27f8`。25 份原始报告的 receipt 签名、summary 哈希及 identity_stable 全部核验；aggregate `passed=true`、`report_ok=true`，无 infrastructure errors。总计 **1787 passed / 0 failed / 0 skipped**：

| 平台 | browser | native |
|---|---:|---:|
| Linux | 396 | 215（含 dual-display） |
| Windows | 396 | 199 |
| macOS | 394 | 187 |

原 C 的 Linux 云备份凭据 fixture 两项失败在 D 通过。C 完整结果为 25 reports / 1785 passed / 2 failed / 0 skipped，失败均为 TC-BACKUP-CLOUD-001/002 setup；C 的失败日志仍保留。D 仍有 `TC-IDE-C6-06-java-definition-realproject-native` 三平台 capability gaps：仓库没有外部 clickhousecrud / `QA_JAVA_PROJECT_ROOT`，不计为通过。unreviewed / not_applicable 不计入上述通过数。原始报告 `github-d/`、核验结果 `github-d-verification.json`；D 的 `audit-d.log` 全部 gates 通过。

## 2026-10-21 实施批次 E

继续按职责和生命周期拆分，不以 façade 缩短替代功能完成：

- LSP completion：类型、请求 telemetry/invocation、resolve、能力判定、ranking、policy controller、snippet session、acceptance、tooltip information、accept intent、sources 独立。request counter 由 sources 拥有；snippet WeakMap/choice cycle 由 snippets 拥有。原公共导出和 CodeMirror 类型 augmentation 保留。
- CodeMirrorHost：provider completion 持有候选/查询序号/刷新计时器；document reconciliation 持有本地回显队列、版本和受控文档镜像；presentation/intelligence/decorations 各自持有 compartment 与已渲染状态。IME 注册和释放、文档 update listener、DOM clipboard/contextmenu、模板按键与 mounted actions 独立。保留 effect 顺序、mount-once 行为和清理入口。
- CodeWorkspaceTab：剪贴板 store/权限 adapter 的 acquire/release、布局 hydration/view snapshots、Java debug main-class choice/launch、停止位置和库源码导航分离。
- Mail：搜索 query/filter/results/sequence 由 useMailSearch 拥有；远程图片许可由独立 hook 拥有；列表和 popup 共用 reader renderer。
- HBase：配置/认证初始化、DTO/session model、shell grammar、REST session/HTTP/catalog/operations、结果编码、native/Thrift dispatch 分离；入口保留 IPC、session registry 和 cancellation。显式引用领域模块，新增生产模块不使用 `use super::*`。保留原 live opt-in tests，未配置外部 HBase 不算实集群验证。
- RD Gateway：RPC framing、HTTP framing、NTLM auth、bootstrap、data payload、authenticated transport、RPC stream reads、双向 stream lifetime、tunnel handshake 分离；原公共 API 显式 re-export。NDR/RTS 直接引用协议模块，不经 façade 回引。

HBase 69 个、Gateway 64 个函数进行 token 级对照，除 visibility 与 rustfmt 尾逗号外实现不变。该对照仅说明移动保真，不代替测试。

| 入口 | D | E |
|---|---:|---:|
| CodeWorkspaceTab | 7955 | 7715 |
| CodeMirrorHost | 2466 | 1348 |
| lspCompletion | 2428 | 112（公共导出按行展开） |
| MailClientTab | 3032 | 2761 |
| hbase/mod.rs | 2537 | 308 |
| rdp/gateway/mod.rs | 2222 | 72 |

当前全文件清单更新为 2448 个代码文件。CodeWorkspaceTab/Mail 的主编排、其它尚未处理的大模块和跨模块 service 边界仍有剩余，**P0–P5 尚未全部完成**。

### E 本地验证

- `completion-e.log`：66 passed。
- `cm-e-tests-fixed.log`：9 files / 201 passed，含 IME、completion undo、live templates、参数/焦点和 shared document owner。
- `e-editor-mail.log`：11 files / 508 passed，覆盖 workspace、CodeMirror 与 Mail。
- `e-unit-full.log`：Node 22.23.3，540 files / **5455 passed / 1 conditional skip**。
- `e-build-fixed.log`：生产构建通过；761 native commands / 328 facade exports / 39 literal events 保持，341 implementation modules 无 reverse façade imports / internal runtime cycles。
- `e-rust-lib.log`：**1868 passed / 25 ignored**；保留原 opt-in 约束，部分 live 测试未提供环境会提前返回，不能以单测汇总证明实集群验证。
- `browser-e/run-20261021-184845-111013486`：Linux Chromium **7 passed / 0 skipped**。TC-IDE-C2-07/08/10、TC-IDE-C4-01/02、TC-IDE-PARITY-005-04、TC-MAIL-SEARCH-01。receipt signature/hash/identity_stable 核验通过，summary sha256 `dbb3a4347947cbf644a0c796556fcf28c54547e475be40f131f59ffad715222b`。浏览器运行期间没有修改产品源码。邮件 case 验证本地/服务器搜索入口、过滤、选择及删除；completion case 验证 provider null/error/timeout/retry/primary-only/undo。
- 保留失败：`cm-e-tests.log` 抓到提取时 host context 与 CodeMirror CompletionContext 同名遮蔽，已用显式依赖解构修复；`e-integrated-build.log` 抓到 remote-permission hook 遗留空参数，已移除；`e-hbase-tests.log` 抓到 ResultRow 误导入路径，改回 native/client 后由全量 Rust 通过覆盖。

这是保持行为的重构，复用上述真实入口 cases 和现有 mounted/native tests，不新增只验证新文件/函数存在的测试。三端最终结论以本批提交的新 workflow 为准，不能复用 D 的通过作为 E 的结果。
