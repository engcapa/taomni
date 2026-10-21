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

E 补充：`e-rust-integration.log` **62 passed**，`audit-e.log` 全部 gates 通过。[三端 run 39589289028](https://github.com/engcapa/taomni/actions/runs/39589289028) 测试 `698b5cdee06790bb0fddd6b15ce923eabceaa447`；workflow 已成功结束，完整 raw receipts / aggregate 核验结果后续追加。

## 2026-10-21 实施批次 F

- WelcomePanel：恢复入口、历史容器、最近会话/工作区、本地目录、启动卡片与菜单分离。history hook 拥有查询/排序/选择，shell hook 拥有 shell/WSL 发现状态和取消；目录启动中的 pending 状态保留在入口。
- VncPanel：连接 hook 拥有 WebSocket/session、连接 generation、认证重试、自动重连/heartbeat timers、framebuffer/cursor/stats；keyboard、pointer、Windows special keys、fullscreen 和 viewport 生命周期分别独立。跨连接 teardown 仍显式清理共享输入/剪贴板 refs，保持 effect 顺序及异步回调读取时机。
- MCP HTTP：server 拥有 loopback listener/token registry，model/parameters 保留原 schema，scope/permissions 保留会话约束和授权流水线，handler 负责前端 side-effect 往返，capture 负责命令执行/取消/结果归约，tools 注册保持原名称和描述。原导出保留，新增生产模块不使用 `use super::*`。
- Screenshot：runtime 拥有 ToolState、session lease、generation、opening/recording guards 和中断收尾；window lifecycle 负责隐藏/等待/恢复、焦点和平台位置；overlay、pin、scroll controls、recording controls 分域。root 保留 IPC 与兼容路径，原窗口隐藏/恢复时序、guard、录制恢复 owner 不变。

| 入口 | E | F |
|---|---:|---:|
| WelcomePanel | 2075 | 321 |
| VncPanel | 2068 | 791 |
| agent/cc_bridge/mcp_http.rs | 2131 | 64 |
| screenshot/mod.rs | 2024 | 894 |

MCP 54 个函数、Screenshot 62 个函数逐个 token 对照：差异仅为模块路径、visibility、rustfmt 尾逗号与 closure 外层花括号。结构对照不替代测试。当前清单 2488 个代码文件；CodeWorkspaceTab、Mail、Windows capture helper 等剩余大文件继续处理，P0–P5 尚未全部完成。

### F 本地验证

- `f-shell-tests.log`：原 Welcome/VNC mounted tests **55 passed**。包括认证/自动重连、取消连接、键盘/AltGr/IME、指针采样、剪贴板回显与全屏恢复。
- `f-shell-types.log`：TypeScript 通过。
- `f-build.log`：Node 22 生产构建通过；761 commands / 328 façade exports / 39 literal events 保持，364 modules boundary 通过。
- `f-unit-full.log`：全量 **540 files / 5455 passed / 1 conditional skip**。
- `browser-f/run-20261021-191832-151427200`：Linux Chromium **10 passed / 0 skipped**；TC-038、TC-151、TC-156、TC-159、TC-WELCOME-RS-01/02/03/04、TC-auto-F1-6、TC-auto-F1-6-welcome-recent-sessions。真实 RFB fixture 验证认证/输入/持续绘制/resize/双向 Unicode 剪贴板，欢迎页验证目录排序/恢复/失败重试/清空/卡片与历史。receipt signature/hash/identity_stable 核验通过；summary sha256 `623cd6343099397a2b04926b98dbde099910ed4e73730b0bc73c9a2db06bb4e9`。此浏览器证据在 Rust 拆分前采集，不替代最终组合 native 证据。
- `browser-f.log` / `browser-f-fixed.log` 是选择参数错误（filter 不支持 regex、TC-153 仅支持 native），没有执行用例；修正为明确支持 browser 的 10 IDs 后通过。TC-153 仍由三端 native 执行，不改模式。
- `f-mcp-tests.log` 抓到提取脚本把测试 helper `scope` 误作为生产 import，已移除；`f-rust-combined.log` 抓到 screenshot 的 QA 兼容导入和 Manager trait 遗漏，已补齐，并补查 macOS 的 QA_WINDOW_HIDE_CALLS 条件路径。失败记录保留，最终组合 Rust 结果待追加。

本批纯实现重构，不新增仅断言文件搬迁的测试；沿用上述真实入口与已有 screenshot/agent native cases。窗口、OS 输入/剪贴板、MCP native 行为由最终提交的 GitHub 三端证据验证。

F 补充：`f-rust-final.log` 组合源码 **1868 passed / 25 ignored**，`audit-f.log` 全部 gates 通过。

### E 三端核验结果（有失败，未验收）

25 reports 的签名、summary hash 和 stable identity 全部核验；源码 identity `3b3a980ec9866e50041724f9a02a1bd60c57755e998b0b05998be5801638ef9c`。aggregate `report_ok=true`、`passed=false`、无 infrastructure_errors。实际 **1782 passed / 5 failed / 0 skipped**，不能用 workflow success 覆盖失败：

| 平台 | browser passed | native passed | native failed |
|---|---:|---:|---:|
| Linux | 396 | 213 | 2 |
| Windows | 396 | 196 | 3 |
| macOS | 394 | 187 | 0 |

- Linux TC-RDPS-PERF-03-photo-content：`fps_ratio=0.9165561619502087` 未达到 0.95，保留阈值和原始性能样本。
- Linux TC-BACKUP-CLOUD-002：fixture 的 secret-tool store 失败，未执行应用步骤；D 的该项通过不能覆盖本次失败。
- Windows TC-IDE-CW-ANALYSIS-01-baseline-native：预期 StringUtils diagnostic 未出现，失败快照有 Initialize Workspace (20%)。
- Windows TC-IDE-PARITY-007-03：Extract Method 未出现命名输入框，最终状态为 RESOLVE_TIMEOUT。
- Windows TC-IDE-PARITY-005-05：StringUti 补全 popup 未在 120s 内出现。

原始报告 `github-e/`、核验 `github-e-verification.json`。将对失败场景执行同提交与 D 基线的定向对照；当前原因尚未证实，不能归为既有问题。原有 real Java project 三平台 capability gaps 仍不计通过。

F 最终本地集成测试 `f-rust-integration.log` **62 passed**。第一次全量 dispatch [39601429854](https://github.com/engcapa/taomni/actions/runs/39601429854) 因输入短 SHA `430f339c` 被 actions/checkout 解释为分支名，在 checkout 失败，没有执行应用测试。后续只传完整 SHA，并将 G 与 F 组合验证。

E 同提交定向对照 [39601436436](https://github.com/engcapa/taomni/actions/runs/39601436436)，D 基线对照 [39601444393](https://github.com/engcapa/taomni/actions/runs/39601444393)：相同 5 IDs、Linux/Windows native、release、单分片，respect 原有平台适用范围；测试源码分别为 `698b5cdee06790bb0fddd6b15ce923eabceaa447` 和 `b75c69f075378dfe5816836d27498bcb11ef27f8`。不能使用 run 顶层 workflow head（430f339c）误标实际 tested head。

Linux 凭据诊断：临时目录解包 libsecret-tools（没有修改系统安装），在私有 dbus-run-session + run-owned XDG storage 下连续 12 次执行真实 credential fixture 全通过，日志 `f-keyring-probe-ready.log`。此实验未复现 hosted 失败，不能证明已修复。首次 probe 因本地缺 secret-tool 未执行完整 roundtrip，记录 `f-keyring-probe.log` 保留。

## 2026-10-21 实施批次 G：Windows capture helper

`bin/sockscap-helper/capture.rs` 2177 行拆为 28 行公共入口，以及 plan、flow table、PID map、filter、address、packet、classification、process scope、maintenance、packet loop、engine。engine 仍独占 WinDivert handles、stop flag、worker joins、live plan slot 和 shared tables；私有 fields 不暴露给其它领域。流表 expiry、port reuse、TCP reflection、QUIC 和 bypass 语义不变。

54 个原函数 token 对照一致。原 tests 分成 portable 18 项和 Windows process selector 2 项，全部保留；integration suite 直接引用生产算法和原 portable tests，让 Linux/macOS 也能验证端口复用、TTL、过滤器、TCP/UDP 解析，无 mock 替代这些算法。Windows native build job 增加明确的 `cargo test --bin sockscap-helper` 并留存日志，覆盖原来 `test=false` 默认不跑的 helper tests；失败会阻断该平台 build。

- `g-capture-contracts.log`：18 passed。仅证明 portable 算法，不证明 WinDivert 真实捕获。
- Windows 目标交叉类型检查通过后记录结果；真正 Windows binary tests 以三端 job 为准。
- `test_ci_build_pipeline` 3 项通过，workflow YAML/嵌入 Python 语法校验通过。
- 本批不改用户行为，沿用已有 SocksCap browser/native 场景。真实 WinDivert/UAC 流量接管仍需要匹配具备驱动与权限的原生场景，不把纯算法测试计为真实网络接管验证。

G 补充：`g-windows-typecheck-final.log` 使用临时最小 Cargo manifest 直接引用实际 helper `main.rs`，`cargo check --target x86_64-pc-windows-gnu --tests --offline` 通过，覆盖全部生产 helper 与 tests 的 Windows cfg/type/import 边界。它不是 Windows 可执行测试，后续 hosted Windows 会真正运行 binary unit tests。首次临时 manifest 漏列 tracing 导致检查失败，补齐后通过，未为此修改产品依赖。当前全文件清单 2502 项。


### D/E 定向对照结果

两个 run 均核验 2 份原始 receipt 的 signature/hash/identity_stable；aggregate 均为 `report_ok=true`、`passed=false`，无 infrastructure_errors。每个版本实际 Linux native 3 passed / 1 failed、Windows native 5 passed，0 skipped。原 E 的凭据 fixture 和 3 项 Windows Java 场景在同提交定向对照中通过，D 也通过；这是定向通过证据，不能覆盖原全量失败或据此确认某一种 race 原因。

Linux TC-RDPS-PERF-03-photo-content 在两个版本均未达标：D `fps_ratio=0.8550504600956308`、E `0.9421719934680614`，要求仍为 ≥0.95。该指标取 decoded marker 的 observed FPS；D baseline/adaptive 为 34.60/29.58，E 为 32.99/31.09。两组 bulk decompression_errors 均为 0，adaptive 选择 RemoteFX photo tiles，不能把正确解码等同于性能通过。D 在 E 之前的完整 run 曾通过，现在定向基线也失败，说明并非 E 独有；确切性能原因仍需调查，未更改阈值。

F/G 组合全量 [39609696680](https://github.com/engcapa/taomni/actions/runs/39609696680) 测试完整 SHA `513cea1f1a1426f66e77f1121042aa71f7f3ff24`，三平台 browser/native，等待最终 raw reports。

## 2026-10-21 实施批次 H：编辑器状态与生命周期

CodeWorkspaceTab 从 7715 行降至 7104 行。新边界按职责拥有原 state/ref/effect，而非把全部状态送入另一个巨型 controller：

- `useWorkspaceAppearance`：外观 hydration/migration/persistence、workspace rebinding、每个 editor 的 zoom、soft wrap、列选模式、树字体与 clipboard history 配置。
- `useWorkspaceToolWindowRouting`：legacy dock/right-pane 路由、同一 microtask 的 open/tab 顺序处理、tool layout 和稳定内容 host nodes。原 `useWorkspaceToolWindows` 的尺寸/焦点/恢复控制保留。
- `useWorkspaceInspections`：profile 与 rule/baseline/suppression 操作、clipboard import/export、源诊断数组的 WeakMap 显示缓存，保持 provider 原始 diagnostics 不变。
- `useWorkspaceIntelligencePreferences` 与 `useWorkspaceParameterInfo`：分别拥有偏好和 completion session manager、参数提示 provider 请求及文件切换/invalidation/Escape 接线；原 ReferenceInfoSession owner 保留订阅和 dispose。
- `useWorkspaceUsagesState`：唯一 UsageQuerySession、dispose、pin/scope/recents/result/rerun marker；actions hook 接收一个 typed owner，面板的 pin/restore 操作归还 owner。
- `useWorkspaceHierarchy`：call/type roots、request sequence、provider/project provenance 和 stale panel props，不向 shell 暴露内部 setters。
- `useWorkspaceKeymap`：scheme hydration/persistence、action host 同步、shell key claims、mouse listener 的注册与清理。
- `useWorkspaceTabPolicy`：policy/revision/receipt、设置窗口焦点返回与事务 base revision；已有 layout restore 和 apply transaction 继续用原契约。

新增 routing mounted tests 验证 open→tab / tab→open 均定位到已移动工具窗口、同 microtask suppression 在下一轮失效、内容 node 不重建，及 documentation 隐藏/重开。纯重构继续使用既有用户入口 cases；不新增只检查文件存在的 case。原有 browser usages case 仅打开 Analysis，不能用它证明真实 provider 的 pin/rerun/hierarchy；这些由现有 session/panel/semantic 单测和最终 native 证据区分。

H 迭代证据：`h-editor-fixed.log` 5 files / 289 passed，`h-routing-tests.log` 3 passed；最终组合 `h-build.log` 通过。初次 `h-types.log` 捕获提取时误用了已有 hook 名称以及 Usages 参数残留，已恢复原 hook 并将新 owner 命名为 ToolWindowRouting，`h-types-fixed.log` 通过。旧 `h-editor-tests.log` 在缺陷修正后终止，未作为通过证据。最终全量 unit 和 browser 结果后续追加。


H browser：`browser-h/run-20261021-215313-961905131` **9 passed / 0 skipped**，TC-IDE-C4-01、C5-01、CW-UI-01、PARITY-004-01/02/03、010-01/03、024-01；包括设置应用/重开、键位 draft/apply/conflict/cancel/reset/delete/输入保护、工具窗口移动和保留 dirty editor。receipt signature、summary hash、stable identity 已核验，summary sha256 `65f979546f6256d529a188169eaa10a150b5df379f7ed891ec2b44af80929404`，运行期间产品源码未改。`h-build.log` 通过 761 commands / 328 façade exports / 39 literal events 与 373 implementation boundaries；当前文件清单 2512 项。


H 最终组合全量 `h-unit-full.log`：**541 files / 5458 passed / 1 conditional skip**。`audit-h.log` 全部 gates 通过。提交 `cecf5782` 已 push；后续 I 与 H 组合使用新完整 SHA 验证三端。

## 2026-10-21 实施批次 I：数据库结果表格

QueryResultGrid 从 1813 行降至 952 行（以最终清单为准），保留虚拟行显示和 toolbar 编排；`useGridFilters` 拥有排序/列过滤草稿与 popover listener、`useGridSelection` 拥有行/矩形选择和拖动终止、`useGridEditing` 拥有编辑框/提交状态与原 preview→confirm→commit 流程、`useGridExport` 拥有导出选项/列/目标/窗口与原真实导出调用、`useGridGeneratedSql` 拥有异步 rewrite identity 和迟到响应取消。结果或 columns 变化时，原 reset 分别归到所属 owner；shell 仍拥有共享 rows，避免 selection/filter 与 editing 互相调用造成循环依赖。ColumnFilterPopover 直接消费 typed filter owner，不复制几十个 prop 类型。

- 原 15 项 grid mounted tests 在第一轮提取后通过；补充跨边界 regression：替换结果后旧选区/过滤草稿清理；第二次排序生效后丢弃第一次迟到 SQL rewrite。
- `i-grid-fixed.log`：QueryResultGrid / DbClientTab / dbGridChanges **63 passed**，覆盖真实组件的确认取消、预览失败回退、排序/过滤、复制矩形选择、生成 SQL 和父级 database 集成。
- 失败记录保留：`i-grid-types.log` 发现未使用的 shell setters；`i-build.log` / `i-grid-final.log` 发现 `editing` owner 与行内 editing 布尔值遮蔽、popover nullable narrowing 及遗漏的 status 解构。已修正为 editSession、局部 non-null column 与显式 status 依赖，后续定向通过。
- browser 的 DB stub 明确不提供真实连接/执行，现有 browser transaction case 只测 offline；不把它计为 grid 行为验证。本批复用 TC-DB-GRID-001-sort-filter-count-native、TC-DB-EDIT-001-grid-sql-preview-native 及既有 DB execution/transaction cases，通过新三端 native job 验证真实 MySQL IPC 与写回。没有为重构伪造网络/SQL stub 的通过证据。
- 扩展 `refactor-boundaries.mjs` 覆盖 database/grid，禁止反向依赖 QueryResultGrid façade 和内部 runtime cycle。

I 最终构建 `i-build-final.log` 通过，原 contracts 与 387 implementation boundaries 通过。`i-build-fixed.log` 补抓到 selection.activeCell 在 closure 中需局部 narrowing，已修正为捕获当前 activeCell；不更改选择语义。

## 2026-10-21 性能验收标准调整（用户明确授权）

用户确认“对于性能类用例，偏差在 15% 之内可接受”。从本次变更起，相同条件的基线/候选相对性能回退允许到 15%：吞吐/FPS ≥ 基线 85%，延迟或每帧带宽 ≤ 基线 115%。更好的性能不因偏离基线超过 15% 而失败。

- TC-RDPS-PERF-03 的 FPS ratio 从 0.95 改为 0.85，bandwidth per delivered frame ratio 从 1.05 改为 1.15；同步 description 和 requirement。至少 100 marker frames、真实 RemoteFX 选择、零 bulk 解码错误保留。其它用例的 95% framebuffer painted share 属于画面完整性，不放宽。
- Chromium renderer proxy 的 `perf_baseline.py` 默认 `--regression-fraction 0.15`，写入结果；保留匹配 conditions、原始慢样本、测得的 noise allowance 和绝对延迟预算。`test_verification_workflow` 18 项通过，包括恰好 15%、超过 15%、改善、显式严格门槛、绝对预算和无效参数。此处只验证判定逻辑，不是新的 native 性能测量。
- 上文 A–G 和 D/E 对照为当时旧标准下的原始历史结果，保留失败状态、签名与样本，不回写为通过。后续新完整提交运行才作为新标准的验收证据。

## 2026-10-21 实施批次 J：会话树

SessionTree 从 1963 行降至 399 行。`useSessionTreeNavigation` 拥有树过滤、展开、可见顺序/range anchor、外部选中自动展开/scroll timer 和拖动选择；`useSessionFolders` 拥有创建/重命名/删除窗口；`useExternalSessionSecrets` 拥有 Tabby/SecureCRT keychain/decrypt 与外部密码提示；`useSessionImportPreview` 拥有 enrichment→preview→选择过滤→vault preparation→持久化及失败重试。来源适配、导出、文件夹菜单和递归树视图各有独立模块，主入口保留跨领域编排与会话批量菜单。

纯实现重构沿用既有入口 cases，不新增只断言文件搬迁的 case。新增 3 项导入 owner 回归验证选中会话/关联凭据过滤且保留 standalone secrets、保存失败保留预览可重试、等待外部 enrichment 后展示及取消不保存。该补测没有独立改前执行，不声称它提供改前基线。

- `j-build-final.log` 构建通过：761 commands / 328 façade exports / 39 literal events、396 implementation boundaries 无反向依赖和 runtime cycles。
- `j-tests-final.log`：SessionTree / sessionImportExport / SessionImportPreview **3 files / 70 passed**；`j-import-tests.log` 新增 **3 passed**。此前传入的 sessionImportSecrets.test.ts 路径不存在，不计为执行证据。
- `browser-j/run-20261021-222335-168746478`：**4 passed / 0 skipped**，TC-SESSION-TREE-01/02、TC-auto-F-FolderName-1、TC-auto-F-ImportPreview-1。多选范围、批量移动和 reload、拖动预览/取消/单独移动、新建文件夹/取消、导入菜单入口通过。导入菜单用例不操作文件选择器，不能据此声称真实文件导入或 OS keychain 已验证。
- receipt signature、summary hash、identity_stable 核验通过；summary SHA256 `9c19ae220a70c234af95980ea76a3879f804e6bc0861eb3c8d089e840e65e7e5`，source identity `a3284b1fd12a3cc48d7bdad8cc1013e6de0177df77bef82deea3c9419ad27e96`。
- OS 凭据、文件选择器/磁盘和三端 native 持久化仍以新提交的匹配原生证据为准；P0→P5 整体仍在进行。

J 补充：新增测试后的 `j-types.log` 类型检查通过；`audit-j.log` 全部 gates 通过，清单 2528 项。G 当前已下载的 20 reports 均 signature/hash/stable identity 通过，但仍有 Linux PERF-03（旧 0.95 标准）和 macOS TC-MAIL-BULK-01 的确认框缺失失败；G 尚未结束，以上不是完整三端结果。

H/I/J 与 15% 性能标准已提交并 push 到 `4741b43c09dbcc759da24f3ae79f86ec8302f44f`；完整三端 browser/native workflow [39616923665](https://github.com/engcapa/taomni/actions/runs/39616923665) 已触发，尚无验收结论。

G macOS TC-MAIL-BULK-01 定位：第一次永久删除确认框正常打开并取消；20ms 后的第二次 Delete 操作只有 pointerdown/up，没有 click/focus 事件，最终按钮可用且选区仍为 3。`runMailAction` 的 finally 异步解除 busy，而 macOS bridge 的 `el.click()` 对 disabled button 静默无操作。这与取消后尚未恢复可用时就点击一致；现有证据不足以声称产品数据操作失败。用例增加取消后的明确 enabled 等待，再执行原第二次删除/确认/服务器数量验证，原断言全部保留并更新 step indexes；不增加固定 sleep 或自动重试删除。最终通过仍需对应原生执行。

G Windows helper 补充核验：`github-g-windows-build/qa-build-output/capture-contracts.log` 明确运行真实 `sockscap_helper-*.exe`，**26 passed / 0 failed**（capture 18、Windows process selector 2、proc_info 6）。这证明 Windows binary unit contracts，不等同于真实 WinDivert 驱动流量接管。

## 2026-10-21 实施批次 K：编辑器命令归属与展示入口

CodeWorkspaceTab 从 7104 行降至 6791 行。`useWorkspaceEditorCommands` 拥有端口 map、注册 token 检查、command context revision、按活动分栏/固定菜单目标查找及执行、返回编辑器焦点和 provider target 解析；shell 通过校验后的 owner lookup 授予树焦点，不再直接读取可变 map。注册所需 refs 在 hook 调用前建立，避免延迟 getter 初始化依赖。

`useWorkspaceCommandFocus` 集中 terminal/modal/tree/editor 分类及局部快捷键归属保护；`useWorkspaceProblemPresentation` 拥有 provider provenance 展示、inspection baseline/抑制映射和诊断打开；`useWorkspaceCoverage` 拥有报告及 overlay 状态、原候选路径扫描；`useWorkspaceDebugEntryPoints` 保留运行 gutter 的 source-file/facts 判断与远程 JVM attach 流程。实际 Java provider/DAP 连接仍需要 native evidence。

新增 3 项 command owner 回归验证菜单目标固定而键盘跟随活动分栏、旧卸载 token 不移除新端口、文件变化拒绝旧命令、pending tree focus 仅授予匹配 group/canonical key，并读取实时 selection。纯重构沿用原有 browser/native 入口，不新增机械迁移 case。

`k-build.log` 构建与 contracts/boundaries 通过。首次 `browser-k.log` 因使用缩写 TC-IDE-CW-SHELL-01 而未执行用例，已改为 YAML 完整 ID；保留该失败记录，不计为产品失败或通过。组合单测、浏览器、全量 Vitest 和三端结果后续追加。

K 定向验证：`k-editor-tests.log` **8 files / 298 passed**；`k-build.log` **401 implementation boundaries** 与原 command/export/event contracts 通过；`audit-k.log` 全部 gates 通过。

`browser-k/run-20261021-223550-231825961` **8 passed / 0 skipped**：C3-01 跨分栏 clipboard/undo/lease、CW-SHELL-01 编码与无 provider 操作、PARITY-006-02 输入/全局撤销焦点、012-01 弹层返回原 caret、013-01 Find Action、015-01 provider unavailable、022-01 gutter/stripe、025-01 断点弹层/键盘输入归属。报告 signature/hash/identity_stable 全部通过，summary SHA256 `566263d35a61281595dce8eac3429ba3b9d3b44d166cc99b194c5488bccd09d1`，source identity `5f82db08b94bd23daacaf725d8894740b7307701b9b1f8b260951e5f1c1270aa`。没有把这些 browser stub 场景计为真实 Java provider、remote attach 或 OS 剪贴板证据。

K 全量首轮 `k-unit-full.log`：543 files，5465 passed / 1 failed / 1 conditional skip。失败为 tree-menu 卸载后焦点 reset 的测试：其 `await waitFor(menu gone)` 期间下一帧可能已执行，随后才模拟 blur，就把“卸载后、下一帧前失焦”变成了更晚的失焦。产品的 `claimTreeFocus` 原实现没有改动；原定向组合该项通过不能覆盖本次全量失败。测试现显式截取并执行下一帧，先确认菜单卸载及 body 失焦，再执行 RAF 并断言恢复到原 tree row，未放宽断言或增加超时。`k-focus-tests.log` DEC-TOF-04 的 3 项通过；249 项因名称过滤未执行，不计通过。最终全量重跑待完成。

### G 最终三端结果（历史提交，未验收通过）

[39609696680](https://github.com/engcapa/taomni/actions/runs/39609696680) 完整结束，tested head `513cea1f1a1426f66e77f1121042aa71f7f3ff24`。25 reports 均 signature/hash/stable identity 通过；source identity `94aec519ca3bc413fe7a4b1465874bf10ff299c302bc45c6c0d6d1dac2cc1a8f`。实际 **1785 passed / 2 failed / 0 skipped**，aggregate `report_ok=true`、`passed=false`、无 infrastructure errors。Linux browser 396 / native 214 passed + 1 failed（含 dual-display 1）；Windows browser 396 / native 199 全通过；macOS browser 394 / native 186 passed + 1 failed。失败为旧标准 PERF-03 与上述 MAIL-BULK-01。3 个 declared capability gaps 与 99 个 unreviewed cases 保留，不因执行通过声称完整验收。

G RDP contracts 日志已下载到 `github-g-contracts/contracts.log`；K 的 native 源码、vendor/lock/toolchain 均未更改，定向复用 G unit contracts，仍重新执行真实平台场景。

K 定向 [39619541727](https://github.com/engcapa/taomni/actions/runs/39619541727) tested head `26e9bb580e481e6455ab0d18c1f4a2cae517ee37`，三端 browser/native：8 个 K browser IDs，加 tree-open focus、Problems provider、gutter facts、真实 debugger/Java breakpoint、MAIL-BULK-01 和 PERF-03（尊重原平台支持范围）。H/I/J 全量 [39616923665](https://github.com/engcapa/taomni/actions/runs/39616923665) 仍运行；不能用 K 定向替代该全量。K browser 本地报告绑定测试时间的源码身份，后续仅更改焦点测试文件也会使保守 source fingerprint 变化，最新提交证据以本次 GitHub run 为准。

K 最终全量 `k-unit-final.log`：**543 files / 5466 passed / 1 conditional skip**，exit 0。该结果包含确定帧顺序的焦点测试修正；首轮 1 failed 的日志保留。生产源码迁移复核 28 个原 initializer，除依赖访问路径和 2 处 type literal 尾部分号格式外保持原表达式。

H/I/J 全量的当前下载仅含 8 reports（Linux browser 396、Linux dual-display native 1、macOS browser 230），均签名/hash/stable identity 通过，尚非完整结果。GitHub 39616923665 与 39619541727 仍在执行；最终三端结论待下载全部 artifacts 后核验。

## 2026-10-21 实施批次 L：邮件 owner 与小文件约束

根目录 `AGENTS.md` 已在 `bd8ddb29` 加入持续规则：手写源码以 200–500 行为目标，超过 500 行复核职责，新文件和提取模块不超过 800 行；既有大文件禁止继续增加职责。按状态、生命周期、协议和平台拆分，保留取消/清理与异步归属，禁止通过压缩排版、删除测试或另建巨型 controller 降低表面行数。生成绑定、schema、locale 和不可分 fixture 采用明确例外。此次也纠正定向 Vitest 命令，使用 `pnpm exec vitest run <files>`，避免 `--` 把过滤器变成透传参数。

`MailClientTab.tsx` 从 2761 行降至 799 行，`MailClientView` 614 行，其余新模块 53–293 行左右。消息缓存持有同步更新的 live list、正文请求表、请求代次和缓存删除版本；加载、同步/补历史、线程与范围选择、邮件标签页、阅读/自动标记、写信/草稿/Outbox、联系人、日历/提醒、回执、字体与面板和快捷键各有独立 owner。菜单与各弹窗采用显式类型输入，视图消费 typed owner，未将整份组件搬入另一个大 controller。原有接口、隐藏标签页后台同步、批处理重试、SMTP 接受与 Sent-copy 状态、草稿自动保存和证书确认保留。

联系人查询的额外回归用例先复现关闭写信窗口后的迟到响应重新填入建议列表（`l-recipient-red.log`：2 passed / 1 failed），随后在 effect cleanup 作废对应请求序号。测试还覆盖旧查询后到、账户切换隔离；未删除/放宽断言。`TC-MAIL-CONTACTS-01` 增加关闭→重新打开→再查询的 browser/native 入口验证，原用例 ID、目录映射与断言保留。竞态由 unit test 控制响应顺序，入口 case 不声称控制了 native 后端响应时序。

- 定向组合 `l-mail-final.log`：5 files / 78 passed。随后只将 mock 的响应类型从 UI 建议类型收窄为真实 IPC 的 `MailContactSuggestion`；此前构建因该测试类型不匹配失败（`l-build.log`），不是产品运行失败，修正后的构建与该单测复核另记。
- `browser-l/run-20261021-232358-964768938`：13 passed / 0 failed / 0 skipped；批量操作、联系人重开、邀请、快捷键、退订、Outbox、回执、搜索、发送、标签、线程和收件人校验。签名、summary hash、identity_stable 核验通过。Summary SHA-256 `af77f998fbc22655a0a87521b12e41b35b14b9e3b30359614c48ad1bf9884bec`；源码身份 `aecdf40018290d09723f61f4d565ef5bab81ea1746173d2c28cad51ee5f46569`。此报告在上述测试类型修正之前；生产实现与 case 相同，不作为整个任务最终提交的当前 native 证据。
- `audit-l.log`：全部静态 gate 通过。没有把 catalog/schema 检查计作执行通过。
- `l-mail-tests.log` 是误将文件过滤放在 `--` 后启动的全量运行，已终止，不计完成验证；正确的 `l-mail-focused.log` 为 4 files / 75 passed。最终任务仍需稳定提交的全量测试与三端 workflow。

全文件清单现为 2558 项。P0→P5 其余结构退出条件及最终三端验证继续推进，不以此单批次宣布整体完成。

L 修正后的 `l-build-final.log` 成功：TypeScript、761 commands / 328 façade exports / 39 literal events、424 implementation modules 的边界检查及 Vite 构建全部通过。`l-recipient-final.log` 3 passed，IPC mock 类型与真实边界一致。

### H/I/J 全量及 K 定向三端原始结果收齐

- H/I/J run [39616923665](https://github.com/engcapa/taomni/actions/runs/39616923665)，实际源码 `4741b43c09dbcc759da24f3ae79f86ec8302f44f`。25 份原始 runner receipt 的签名、summary 哈希及 `identity_stable` 全部核验通过，源码指纹统一为 `a3284b1fd12a3cc48d7bdad8cc1013e6de0177df77bef82deea3c9419ad27e96`。Linux browser 396/native 215（含独立双屏 1），Windows browser 396/native 197 passed + 2 failed，macOS browser 394/native 186 passed + 1 failed；合计 **1784 passed / 3 failed / 0 skipped**。聚合 `passed=false`、`report_ok=true`，三端 native build 和 Rust contracts job 成功；原 3 个外部 Java 项目缺口及 99 个 unreviewed 条目保留。
- H/I/J 失败保留：macOS `TC-123` step56 在保存后重开会话设置时找不到网络页按钮；Windows `TC-IDE-TREEOPEN-01-project-tree-open-focus-native` step40 的树菜单缺少 Open/Rename/Delete；Windows `TC-RDPS-NAT-08-mstsc-interop` step26 在停止已连接、完成图像断言的 mstsc 时抛出 WinError5。须依据原始日志/截图和实际生命周期定位，不得用 workflow 绿色或重跑成功抹除。
- K run [39619541727](https://github.com/engcapa/taomni/actions/runs/39619541727)，实际源码 `26e9bb580e481e6455ab0d18c1f4a2cae517ee37`。15 份原始报告核验通过，统一指纹 `49f866c47d7275dadcd6ec99978edc397cfbd4920d3ff497869b1970812ba460`。Linux browser9/native7，Windows browser9/native5，macOS browser9/native5；合计 **44 passed / 0 failed / 0 skipped**，聚合 `passed=true`、`report_ok=true`、无 gaps。Linux 的两项 Java 调试场景没有在另两平台选择，不能作为另两平台的通过项。三平台 PERF-03 与 MAIL-BULK-01 在各自已选择范围通过，仍须最终提交全量验收。

原始报告分别保留于 `qa-ui-auto-report/refactor-p0-p5/github-hij/` 和 `github-k/`。以上是对应历史提交的证据，未用作尚在修改的 M 批次完成证明。

## 2026-10-22 实施批次 M：编辑器入口职责收敛

- `CodeWorkspaceTab.tsx` 从 6,791 行收敛至 152 行，只按依赖顺序连接 session、project、files、editing、semantics、commands、insight、execution 和 surfaces。保留对外 props/exports。新建 53 个生产模块，格式化后最大 546 行，ShellView 330 行；没有另建巨型 controller。
- 按实际所有权迁移 buffer/edit/recovery、code style、semantic query、tree intent/focus/menu、LSP document/cancellation、Java creation、code actions、transaction/planning、自动导入 timer、status/context publication、缩放监听和视图弹窗。异步 token、ref mirror、StrictMode restore、卸载 cleanup 和原 effect 依赖保持原语义。后声明动作继续通过带类型的接口惰性读取，避免 render 初始化顺序改变；界面状态与执行/语义动作各有独立 owner。
- 本批是实现重构，保留原有可执行用例和断言。`m-editor-tests-2.log`：原 CodeWorkspaceTab + CodeMirrorHost **327 passed / 0 failed**。首次 `m-editor-tests-1.log` 的 3 个失败为 refactoring popup 提取时引用遗漏，已修复，失败日志保留。
- `m-types-9.log`、`m-build.log` 通过；后续只整理 import、展开长 return 对象和修复反向 type import，`m-build-final.log` 为提交前最终构建。契约 761 commands / 328 façade exports / 39 literal events，477 implementation modules 无反向 facade 引用和内部运行时循环。
- `browser-m/run-20261022-003444-968965816`：Linux Chromium **19 passed / 0 failed / 0 skipped**，覆盖 settings、tab policy、clipboard、keymap、tool windows、replace undo、VCS popup、focus、Actions、occurrences、Problems、Undo transaction、SSH network save/reopen。已校验 summary 哈希、receipt 签名及 identity_stable；最终格式整理不改变这些执行语义。native 留待本批提交上的三端 workflow。
- H/I/J macOS TC-123 的保存后重开竞态：两次保存均增加等待旧 editor 关闭的断言；不能以已有 tree row 判断保存完成。所有旧持久化断言保留，requirements step/actions/results 映射同步，`m-audit.log` gate 通过，当前 browser 原场景通过。
- Windows mstsc stop 的进程退出竞态：TerminateProcess 返回 ACCESS_DENIED 时只在 GetExitCodeProcess 已确认退出后接受；仍运行或其他错误继续失败。5 个 focused Python 回归中先验证两个旧实现失败，再全部通过（`m-mstsc-red.log` / `m-mstsc-green.log`），workflow tool-contracts 加入该测试。仍需 Windows 实际 native 退出验证。TREEOPEN 的历史输入落在树空白区域的问题仍保留为待验证，未盲改产品或放宽断言。

AGENTS.md 的小文件规则已在 `bd8ddb29` 提交：目标 200–500 行、新建/提取 ≤800 行、按状态与生命周期划分，禁止压缩排版或搬成另一个巨型 controller，生成/schema/locale/不可分 fixture 例外需按规则处理。

P0→P5 整体仍在推进，后续继续处理其余大文件，并在最终完整 SHA 上执行全量 Vitest、适用 Rust 回归和三端 scope=all；历史通过不代替最终证据。


## 2026-10-22 实施批次 N：Shell、会话、终端与截图 owner

SessionEditor 从 1,633 行降至 51 行，MainLayout 从 1,615 行降至 64 行，TerminalPanel 从 1,800 行降至 150 行，ScreenshotOverlay 从 1,747 行降至 114 行。41 个新生产模块最大 518 行。会话表单、序列化与保存/探测、分节导航、窗口拖动和视图分开；主布局按终端接入、窗口生命周期、会话动作、工作区打开、连接认证、工具页、菜单与 chrome 归属组合。终端按 panel 状态、交互、命令、生命周期、注册、投影与视图连接；截图选择与拖动、图像和输出动作、快捷键、浮层定位、工具栏、视图及几何/图像工具分别拥有明确边界。

终端旧 sessionLifecycle 从 1,343 行降至 347 行。真实连接/MFA/重连和本地/命令/SocksCap/adopted 启动、延迟 CWD 安装、IME 位置锁及复焦、OSC、ZMODEM/输出链分开。输出、连接、CWD installer 与卸载共享同一个 effect 实例的 TerminalSessionLifetime：销毁标志、unlisten 句柄、timer 与 SocksCap PID 均通过对象实时读写，避免移动闭包后捕获布尔/句柄快照。StrictMode 延迟启动、早期输出排序、adopted session 归属和 detach/close 条件保留。

- `n-checks-5.log`：TypeScript、761 commands / 328 façade exports / 39 literal events、518 implementation modules 边界检查通过；原 MainLayout / TerminalPanel / SessionEditor / ScreenshotOverlay **4 files / 218 passed / 1 conditional skip**。常规模式下跳过的 QA 全文镜像路径在 `n-terminal-qa.log` 的 `--mode qa` 选择中通过，**31 passed**，另 56 项因名称过滤未执行，不记为通过。
- `n-build.log`：完整 production build 成功。未由代码行数或构建成功推导性能改善。
- `browser-n/run-20261022-010408-105903356`：71 项首轮 **60 passed / 11 failed / 0 skipped**。11 项均在 step1 等待 app root 的 30 秒预算处超时；原 trace 中请求成功，失败捕获时页面已挂载。首轮使用 6 个 worker，并与构建重叠；不修改 timeout、用例断言或生产代码。
- `browser-n-recheck/run-20261022-011357-127723982`：仅上述 11 项，在构建结束后使用 2 个 worker **11 passed / 0 failed / 0 skipped**。两轮 receipt 签名、summary 哈希、identity_stable 已核验，生产源身份均为 `7b6a51d0f1381c0f7a870bfdf13ff7074ee98614d5ca02e1936e80278ed00ebd`。复核 summary SHA256 `b6ec3cfa3f8ec6dc0e8ac0cbf81f6c4e881eb8916058f5855aafb88c6dcdb0df`。原失败保留，不能声称首轮 71 项全绿。
- 71 项覆盖 TC-SHOT-001 至 039 的全部 browser 场景，终端菜单/搜索/显示/宏/信号/日志/分屏、SSH 认证取消与重连、附属 SFTP 生命周期、会话高级/网络/认证/外观持久化，以及 TERM-TEXT-001 至 005。SSH 使用 runner 管理的本地 Docker fixture 和随机临时密码；真实 browser service bridge 不记作 native PTY/IME/OS 证据。
- 新增 `TC-TERM-IME-001`：Linux/X11 的真实 fcitx5 wbpy 提交两个 CJK 字符、Escape 取消后仅 ASCII 到达 PTY、关闭终端后新会话再次提交且无拼音残留。policy/dependencies 与 F2.2 映射同步。尚未执行，不声称新增用例具有改前 native 基线；将通过本批完整提交的 GitHub native job 验证。Windows/macOS 输入法传输不由此 Linux case 证明。
- 初期 `n-types-1`、`n-types-3`、`n-checks-4` 的 nullable 闭包/unused import 和选择状态命名问题已修复，原失败日志保留。`n-case-gates` 的只读表达式 schema 错误另行修正，不计为产品执行失败或通过。

原有入口行为沿用已有用例，无需为纯搬迁新增重复 case。新增 IME 用例填补此次实际生命周期边界的证据缺口。清单更新到 2,652 项；整体 P0→P5 仍须继续处理其余大文件并完成最终全量与三端验证。

M 三端 run 39636904994 当前已收齐 11 reports：Linux browser5/native8、macOS browser5/native7、Windows browser5，全通过且签名/hash/stable identity 校验成功，统一源码指纹 `dcc373287c86a2a26a5a4607729c10d3da152045e569783912a919265313b6ef`。macOS 的 TC-123 在 M 原生提交上通过。Windows native 尚在执行，完整聚合结论待收齐，不将此部分结果当作 M 完成验收。

M 最终三端结果：完整提交 `3f1143ab8364bf9f69acd7dc87b913d5673fbce5`、[run 39636904994](https://github.com/engcapa/taomni/actions/runs/39636904994)，15 reports 全部下载至 `github-m/` 并核验签名、summary hash 和 stable source identity。Linux browser5/native8、Windows browser5/native8、macOS browser5/native7，总计 **38 passed / 0 failed / 0 skipped**。聚合 `ci-summary.json` 的 head 正确、`report_ok=true`、`passed=true`，failures/gaps/infrastructure_errors/unreviewed 均为空；统一 source identity 与上述部分结果相同。该次 selected planner 未运行 tool/native contracts，不能将 skipped job 算作合约通过。H/I/J 历史失败及其原始证据继续保留。

N 最终三端结果：完整提交 `275eb19168b776d032c870b2ce3afa5855b449d8`、[run 39643166877](https://github.com/engcapa/taomni/actions/runs/39643166877)。18 reports 全部下载到 `github-n/`；签名、summary hash、stable source identity 核验通过，身份与 N 本地 browser 相同。Linux browser72/native28、Windows browser72/native28、macOS browser72/native26，合计 **298 passed / 0 failed / 0 skipped**。聚合 head 正确、`report_ok=true`、`passed=true`，failures/gaps/infrastructure_errors 为空。`TC-TERM-IME-001` 已在 Linux native 通过，但不能外推到 Windows/macOS IME；本次 tool/native contracts job 未执行。

N 聚合仍有 13 项旧用例审阅缺口：TC-005/014/019/020/021/022/023/024/025/035/059/061、TC-auto-F-Detach-1-terminal-detach。它们的执行结果通过，但不视为 reviewed coverage；最终验收须分别说明审阅和执行状态，原失败与该缺口继续保留。

## 2026-10-22 实施批次 O：工作区模型、事务、Action 与模板

7 个旧门面继续提供兼容 API：dapDebugModel 1735→130、rearrangeCleanupWorkflow 1718→65、refactorPlan 1522→60、codeWorkspaceModel 1577→162、workspaceActionRegistry 1644→23、workspaceActionHost 1482→22、liveTemplates 1475→17。新增 68 个实现模块，最大 591 行；清单 2720 项。公开导出列表保持可读格式，未压缩实现来减少行数。

- Debug 按状态、内存、源断点、函数/指令断点、数据断点和异常断点分层；工作流按能力、计划、变更 guard、action validation、Rearrange/Cleanup 事务分离；重构计划、postconditions、旧 journal 与存储/准备分开。原拒绝过期结果、原子提交和恢复约束保留。
- 工作区 path/file/tree 与 build/run、LSP、Java 偏好独立；hash identity 与 Java preference keys 抽为共同底层，消除 files↔paths 和 Java↔LSP preferences 的循环。
- ActionRegistry 与条件求值、领域 metadata 分离，132 个动作的原注册顺序完整保留。ActionHost 使用组合：注册层及 command adapter 有独立 owner，keymap/chord timer/view registry/index/display cache 有独立 owner，原 host 持有 execution/evaluation lifetime；typed callbacks 实时读取 generation、disposed 和 registrations，没有复制状态快照。原晚到 disposer、split owner、busy/stale evaluation 和冲突通知行为保留。
- Live Templates 按语言目录、偏好订阅、匹配、provider 优先级、展开和 completion 分离。全局偏好订阅只随 cache owner 初始化一次，内置模板顺序及同步设置刷新保留。
- `o-model-baseline.log`：修改前 10 files / 268 passed；`o-model-regression-1.log`：修改后同组 **268 passed**。`o-model-checks-2.log` 类型检查通过，`o-build.log` 完整 production build 通过；最终契约 761/328/39、586 implementation modules 边界检查通过。初始漏写 type re-export 的 `o-model-checks-1.log` 保留，后已修复。
- 静态结构对照确认 6 个 model/catalog 门面导出一致、468 个原声明 AST 一致（仅 export/模块相对路径与格式调整）、132 个 metadata 及顺序一致。ActionHost 的组合改造由原 host/keymap 测试及真实 UI 入口验证，未用静态对照代替执行结果。
- `browser-o/run-20261022-013518-613396492`：**12 passed / 0 failed / 0 skipped**，receipt 签名、summary hash、identity_stable 核验通过，源码身份 `46fa032947f79a27ba2c4a34e8851f93f81535df4516a0f1ba9200c5619633b0`。覆盖 keymap scheme 编辑/Apply、冲突重分配/取消、输入保护/Reset/Delete、tree recorder、Classic scheme、模板 popup/postfix/comment、breakpoint gutter/dialog、不可用 Rearrange/Cleanup、shell Actions 以及 Extract Method/Undo。随后只展开原门面的长 export 列表；最终组合仍需完整 SHA 的全量回归。

本批为保留行为的实现重构，复用上述已执行的原场景，不新增只验证搬文件的用例。真实 JDT LS 整理/清理、refactor journal 磁盘恢复、DAP hit 和 WebView 重启持久化仍由最终组合上的原生场景验证。整体 P0→P5 尚未全部完成。

## 2026-10-22 实施批次 P：Rust 协议、同步、探测与平台职责

Presto、SDK detect、ACP wire protocol、SSH server、scroll capture、structural search、mail sync 和 config 共 8 个旧大模块按责任分离；83 个相关 Rust 文件中最大为 Presto 测试 762 行，生产模块最大为 SSH requests 494 行。每个实现模块使用显式 imports，旧 API 和两套 Tauri generated command helpers 经门面保留。清单更新至 2795 项。

- Presto 按协议、共享流状态、transport、statement/value、query/catalog 分离；SDK 按证据模型、scope、manifest、Maven/Gradle/Python/version files 分离；ACP 按 request/response、permission、updates/display 分离。
- SSH authentication/connection、listener、request、forwarding、PTY 与 SFTP path/attributes/handler 分开，共享原连接状态与取消/Drop；截图 scroll 的 control/capture/sampling/input/frame/matching/stitching/chrome 分开。macOS debug QA permission guard 的可见范围保留至 screenshot 域。
- Structural search 的请求 owner/Drop、pattern、matching/results/files、service/commands 分开；mail sync 的 schema、水位、cache、planning、IMAP 与 folder step 分开，原 UIDVALIDITY/补洞/flags/atomic commit 保留。
- Config 按文件流、dialogs、clipboard、paths 和四类平台实现分开，平台逻辑 module path 保持兼容。文件流 owner、abort/close、clipboard formats 与原生对话框行为保持。
- `p-rust-baseline.log` 初次有 4 项本地 HTTP fixture 被外网代理返回 502；加回环 `NO_PROXY` 后同一改前组合 `p-rust-baseline-local.log` 为 **1868 passed / 0 failed / 25 ignored**。没有改产品网络策略或放宽断言。
- 前 4 模块拆后 `p-rust-check-2.log` 为 **1868 passed / 0 failed / 25 ignored**。8 模块组合 `p-rust-final.log`：lib **1868 passed / 0 failed / 25 ignored**，integration **80 passed / 0 failed**。初期遗漏 trait import、Tauri helper 与重复 test import 的失败日志保留。
- 301 个生产函数 token 对照一致；Config 公共 29 个函数和 Windows 12/macOS 13/Unix 26/unsupported 8 个平台函数对照一致，仅可见域、真实 helper 路径和 rustfmt 调整。此静态对照不替代行为执行。
- `rustfmt` 仅作用于本批文件，`git diff --check` 和 **761 commands / 328 façade exports / 39 literal events** 契约通过。格式整理及删除一个 unused import 不改变执行语义；最终仍需完整提交上的三端 native 和全量组合验证。

本批为实现位置与依赖重构，复用原有真实数据库/SSH、截图、clipboard、structural search、ASR 与相关单元测试，不添加只验证文件搬迁的重复场景。后续继续处理其余大文件；当前批次通过不代表 P0→P5 整体完成。

## 2026-10-22 实施批次 Q：协议 owner 与前端领域 API

继续处理 13 个旧入口。RDP server clipboard/display、RDPDR、本地 ASR 安装、邮件过滤和 LanChat SQLite store 拆为 57 个实现/测试模块；Rust 最大 537 行左右。前端 LSP、布局树、Code Action、编辑命令、邮件 API、邮件 HTML 和 SQL metadata completion 拆为 60 个实现模块，最大 689 行。旧门面保留原导出，清单为 2912 项。

- CLIPRDR 的 host worker、change token、共享 snapshot/request gate、文件 staging/download 与 per-client backend 分离；原 echo suppression、锁定快照、超时/取消及 Drop 归属不变。RDP display 的 mailbox、更新消费、三平台 warm-up 和 capture loop 分离；保留同一个 capture/mailbox lifetime。
- RDPDR 在同一 backend 上分离 opening、file IO、query、mutation、path confinement、metadata 和 wire response；未重建 handle map 或写入预算。ASR 的 installation tracker、取消令牌、reporter、proxy、inventory、下载校验与两类安装流程独立，仍串行化到同一个 INSTALL owner。
- Mail filter model/matching/planning、cache mark、IMAP SEARCH、actions 与 command adapter 分离。LanChat 在同一 Connection mutex 和 message key 上分离 identity、pins/peers、conversations、encryption/messages、retention/groups 与 schema；未复制数据库连接或 key。
- LSP 保留 renderer 全局请求序号、detect cache epoch 和 QA completion observation 的单次初始化；Code Action class 保留原 request/resolve/apply pipeline。布局事务、持久化、节点操作、编辑命令的 clipboard/caret/folding/selection/statement/line 行为各自独立。
- SQL completion 的语法、parsing、metadata、SELECT/JOIN/INSERT、namespace 与 source 分开；邮件 HTML 的 purifier hook owner、style sanitizer、document preparation 与 compose 分开。边界 gate 发现并消除了 document↔sanitize 循环，旧 sanitizer 与 iframe 行为由原测试保留。
- 静态对照：6 个 Rust 域共 **265 个生产函数**保持 tokens 一致（仅 visibility、module path 和 rustfmt）；7 个前端公共 API、**525 个原声明及全部 top-level side effects**保持一致。静态对照不代替执行结果。
- `q-rust-final.log`：lib **1868 passed / 0 failed / 25 ignored**；integration **80 passed / 0 failed**。`q-model-tests.log`：**16 files / 627 passed**，包含原编辑器、数据库与邮件入口回归。`q-types-2.log` 和 `q-build.log` 通过；契约 761/328/39、**646 implementation modules** 边界通过。初期 test import、format capture constant、trait import 和 unused facade import 的失败日志保留。

本批保持原流程和测试断言，因此复用原 executable cases。O/P/Q 组合的原生 clipboard、capture、JDT LS、真实 SSH、结构搜索、邮件过滤与 RDP 性能将使用完整提交在三平台验证；ASR 的原生网络与文件语义还由 Rust loopback HTTP/cancellation/integrity tests 验证，浏览器 fixture 不作为其网络证据。整体剩余大文件与最终 scope=all 继续推进。
