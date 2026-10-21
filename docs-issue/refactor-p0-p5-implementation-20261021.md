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
