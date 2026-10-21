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
