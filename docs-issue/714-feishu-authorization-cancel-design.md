# #714 飞书授权可取消、可移除与跨渠道可达性修复设计

## 1. 状态与来源

- 来源：[engcapa/taomni #714](https://github.com/engcapa/taomni/issues/714)，标题“开启云端飞书备份时，无法终止正在进行的授权任务”；作者 ganwenlong，2026-10-12 创建，本次读取时 open、无评论。
- 2026-10-25 通过本机已登录 GitHub CLI 凭据读取；实际账户为 `engcapa`。本轮 GitHub/附件访问均显式使用用户指定 HTTP 代理。未向 issue 发送评论或更改状态。
- 调研基线：`65a822785a86c52671983076cd0a244c59626260`；开始时工作区干净。当前 Windows，产品范围仍兼容 Windows/macOS/Linux。
- 实施状态：已在 `feat/backup-settings-unification` 实施，实际测试证据见文末实现记录。证据支持原 UI 存在取消入口失联的路径；原作者真实账号场景本轮未在桌面复现，不将静态分析冒充原生复现。
- 归属：[Backup 设置整合设计](../docs-feature/backup-settings-unification-design.md)。用户已采用其同页折叠布局，进一步要求只改 Backup、支持中英文、保持既有备份文件格式。

本修复使活动授权始终可见、可取消，停止后可重新选择/连接，并提供移除本地任务记录的操作。任务移除与移除渠道、删除系统凭据、撤销远端授权、删除飞书应用是不同操作；本次任务移除只处理本地会话，不执行后面几项外部副作用。

下文验证表和真机手册保留设计阶段的计划；实施后的实际通过、失败和未验证范围统一见 [实现与验证记录](../docs-feature/backup-settings-unification/implementation-status.md)。GitHub 原生自动化使用隔离 profile 与受控服务，不代表真实飞书账号授权已验证。

## 2. 问题、证据与因果链

### 2.1 用户报告

用户准备连接个人飞书，但浏览器仍登录企业飞书。第一步在企业账号网页新建连接时发现错误，Taomni 中无法回退或终止，希望删除进行中的授权任务。

原始报告截图已下载保留为 [issue-reported.jpg](714-feishu-authorization/issue-reported.jpg)，原始地址为 issue 正文的 GitHub user-attachments。截图显示：

1. 当前目标为“新飞书目标”，正在显示可编辑的连接配置。
2. 当前区域没有活动授权会话及取消控件。
3. 页面提示“另一个备份或授权任务正在运行，请完成或取消后再试”，技术详情为 `Wait for active backup tasks before changing target settings`。

这是报告者当时的真实证据，不是本轮复现截图；其中的个人设备标识不用于测试 fixture。

### 2.2 当前代码事实

| 位置/符号 | 已核实事实 | 影响 |
|---|---|---|
| `RemoteBackupPanel.tsx` 的 `session` 派生 | `sessions.filter(s => s.targetId === target?.id)` 仅取当前目标的最新会话 | 原目标 A 授权中，切 B 或新建目标后找不到 A 的取消入口 |
| 同组件的添加/切换入口 | “添加飞书目标”仅因 busy/配置未加载禁用；可以把当前 target 换成未保存的新 UUID | 新目标没有对应 session，活动会话仍在后端运行 |
| 同组件的取消按钮 | 仅在当前 session 存在且 `authorizing` 时渲染 | 不能仅靠存在 `cancelAuthorization()` 判定问题已经修复 |
| `backup/commands.rs::backup_remote_save_config` | 任意 `jobs.running` 非空就拒绝保存 control | 新目标保存失败，但它的 UI 仍不能处理其他目标的授权 |
| `feishu/auth.rs::start` | 保存 `auth:{sessionId}` 到 `BackupJobs.running`，全局最多一条活动连接；相同目标重复开始返回既有会话 | 授权任务能阻止新保存/连接；反复点击不会自动逃离旧会话 |
| `feishu/auth.rs::cancel` | 对匹配活动 session 的 token.cancel；不等待终态/释放，也没有移除本地会话记录接口 | IPC 成功不等于已经停止；取消后立即连接可能仍 busy |
| `auth.rs::connect` / `device_flow.rs` | 网络与轮询已有 CancellationToken；注册恢复信息另存凭据，取消通常保留 | 可以复用取消机制；不能通过删除 JSON 假装网络已停止 |
| `auth.rs::publish/start` | 每个异步任务持有可变 session 副本，结束时写状态并清 active/running | 增加移除时必须防止旧任务重写记录或清掉新 owner |

因果链：A 开始连接 → 活动会话全局运行且占用 auth running → 用户切换到 B/新目标 → UI 只派生 B 的 session，取消 A 的控件消失 → 保存 B 被全局运行约束拒绝 → 用户被要求取消但没有可达入口。

该路径由报告截图与当前代码一致支持。浏览器身份选择影响注册/授权的服务端账号，但**本机可取消性不应依赖浏览器账号是否正确**。不需要改认证协议来解决入口失联，也不能把全部问题归为用户没有切账号。

### 2.3 最小区分性复现（实施前待执行）

在挂载组件的测试中提供已保存目标 A/B 和 A 的 `awaiting_registration` 会话；先选 A，再选 B，另测“添加新目标”。断言活动 A 的取消仍可操作，并调用 A 的 sessionId。当前代码预计在选 B/新建时找不到取消按钮；必须实际运行并保留 red 结果后才能称该具体回归已复现。对“始终停留 A 能正常取消”的原有路径建立 through→through 基线。

真实 Windows 复现使用隔离 profile/测试应用：发起注册，浏览器停留未确认状态，返回 Taomni 切目标/新增目标观察取消入口。无需为复现真的创建企业应用或对生产账号授权。

## 3. 决策与图稿

| ID | 结论与依据 | 状态 | 关联 |
|---|---|---|---|
| DEC-01 | 活动授权提示属于整个 Backup 区域，不能隶属所选 target；任务与记录仍列出终态 | 用户已采用整合布局；修复入口缺失为明确期望 | AC-01/02；TASK-01/03；V-01/04 |
| DEC-02 | “取消授权”停止本地请求/轮询并保留可安全复用的应用；“移除本地任务”先停止再移除记录，不删除飞书应用 | 用户问题要求可终止/删除任务；外部副作用保持既有契约，agent 自决细节 | AC-03/04/06；TASK-02；V-02/05 |
| DEC-03 | 在收到终态且 active/running 释放前显示“正在取消…”，不把 token.cancel 的返回当完成；重连使用新 session ID | agent 自决：现有取消是异步，避免再次 busy 与迟到覆盖 | AC-03/05；TASK-02；V-02 |
| DEC-04 | 仅改 Backup 内部并覆盖中英；不变更 `.taobak`、manifest、加密或恢复协议 | 用户明确约束 | AC-07/08；TASK-03/04；V-03/05 |

当前有效 [V2 授权恢复预览](../docs-feature/backup-settings-unification/authorization-recovery-v2.png) / [可编辑 draw.io](../docs-feature/backup-settings-unification/authorization-recovery-v2.drawio)。内容区 950×1040，只表示原有 Backup 分组内部；它是拟议修复，不是问题复现。V1 内部布局已获反馈，V2 按后续“设置整体不动”约束移除外围结构；不需要重新选择相同的内部布局。

## 4. 修复行为与接口

### 4.1 用户流程

活动授权提示放在 Backup 标题后、各配置分区前，显示目标名/授权阶段/必要验证码、取消、重新打开网页、定位渠道和移除入口。它从全部授权会话派生，既不依赖编辑目标，也不因展开/折叠渠道、保存失败或 busy 消失。未展开整个 Backup 分组时不另改外层 Settings；重新展开后从后台恢复。

| 当前状态 | 动作 | 结果/恢复 |
|---|---|---|
| 发现应用、注册中、等注册网页、授权中、等用户授权、验证身份 | 取消授权 | 独立发送取消，不受保存/传输 busy UI 阻挡；按钮显示正在取消；等待后台确认 |
| 正在取消 | 重复点击、切目标、关闭重开 | 幂等；仍显示活动 session，不能创建第二个授权或假报成功 |
| 确认已取消且释放 owner | 重新连接 | 新 session，复用已保存应用或安全的注册恢复材料；浏览器身份需要用户自行切换 |
| 已取消/失败/过期/中断 | 重新选择应用 | 显示已保存连接/本地可用应用选择，不能自动新建应用掩盖错误 |
| 活动授权 | 移除本地任务 | 确认“停止并移除”，先取消/等待退出，再移除本地会话记录；失败保持可见、允许重试 |
| 终态会话 | 移除本地任务 | 无活动副作用地移除记录，原渠道与已保存应用保持；记录不在轮询/重启后复活 |
| 与成功提交竞争 | 取消/移除 | 若 connected 已提交则返回真实终态；显示“连接已完成”，不能假称撤销；移除只隐藏记录 |
| 用户需要放弃已开始但未确认的注册 | 重连/重新开始应用连接 | 提供继续已有注册或现有显式重建入口；重建提示网页可能已创建应用，不能自动重复注册 |

取消不强行关闭默认浏览器、OS 凭据权限弹框或远端网页。已发出的远端注册可能完成，提示“网页上已创建的应用不会被删除”。取消完成必须意味着本进程不再轮询或使用该会话提交连接；不能承诺能撤销远端副作用。

### 4.2 新旧 IPC 和事件

| 名称 | 契约 |
|---|---|
| 既有 `backup_feishu_authorization_status` | 仍返回 `AuthorizationSession[]`；旧必需字段保留。增加可选 `cancelRequested`、`cleanupComplete`、`dismissedAt` 本机状态；旧值缺省 false、terminal(phase)、null；默认不列出已移除会话 |
| 既有 `backup_feishu_authorization_cancel(sessionId)` | 仍保持成功返回 void 的兼容。按 ID 幂等请求取消；错误来源明确。前端另等 status/event 确认终态与可重连资格，不以返回值冒充完成 |
| 拟新增 `backup_feishu_authorization_forget(sessionId)` | async → `{sessionId, phase, removed: true}`；活动时请求取消、等待相应任务释放，再持久化移除标记。缺失/已移除返回幂等成功；本地持久化失败返回错误且记录保留 |
| 既有 `backup_feishu_authorize` | 入口名称/参数保持；相同活动任务仍幂等。取消退出后新建 session，不复用已移除 ID |
| 既有 `backup-authorization` | 原必需 payload 不变，新增可选字段同 status；revision 单调。移除事件带 dismissedAt，订阅者据此删显示；不得把记录的同 revision 旧快照插回 |

本机会话新增字段不涉及备份文件格式，保存位置仍在 `backup-control/authorization`。移除采用已终止记录上的持久 tombstone（dismissedAt）而不是先删文件让 worker 重建；status 默认过滤，有限清理只处理已确认终态。UI store 保留观察到的最高 revision/移除标记，拒绝旧事件与轮询结果。任务列表与顶部提示使用同一份会话集合。

如会话属于另一持有后台任务锁的进程，沿用现有 owner 检查并显示“请在拥有此授权的 Taomni 实例中取消”，不能 silent no-op 后显示成功。此修复不引入跨进程远控协议；原报告同实例路径必须可取消。

### 4.3 后端生命周期与竞态

1. 统一 owner 按 sessionId + generation 持有 token、完成通知、当前 revision、取消/移除标志。开始/取消/状态发布/清理走同一个状态 owner，取消结果不能靠多个 session 副本各自自增 revision。
2. cancel 标记 cancelRequested 并发 token；网络 request、poll wait 和初始化锁等待均用现有可取消分支退出。新会话 cleanupComplete=false；running key 和 active ownership 按 session ID 条件释放后，再持久化 cleanupComplete=true、递增 revision、发状态事件及完成通知。前端只有 terminal(phase) 且 cleanupComplete=true 才开放重连；终态先到但清理未完成仍等待。状态持久化失败明确报错并保留记录。不能持注册锁等待 worker 自己清理，也不能让新任务启动后旧 finally 无条件 `active=None`。
3. worker 在 keyring/绑定/connected 提交前校验当前 session/generation 与未取消状态。提交临界区与 cancel 仲裁：提交先完成就是真实 connected；取消先接受则旧结果不得覆盖账号、目录或连接状态。不能仅在 React 层忽略事件却仍写了错误凭据。
4. OS 凭据读取的 spawn_blocking 可能不可强杀。取消后使其结果失效，不能让迟到结果继续绑定或触发网络；不把 OS 弹框仍在显示视为后台仍有有效授权 owner。
5. 已返回的注册 App ID/Secret 涉及不可逆外部创建。即使取消，也按既有恢复边界安全保留已签发结果供恢复，不丢密钥、不自动创建另一个，不把仅保存应用称为 Drive connected。注册保存失败保持既有“先修复凭据保存”路径。
6. forget 等退出后写 tombstone；等待中失败/进程退出仍保留原 journal。重启继续把未结束会话标 interrupted，不自动重新发起已取消/已移除授权。取消后注册恢复材料属于 connection，不因移除 UI 记录盲目清掉。
7. 已授权共享 connection、其他目标和 CLI 原配置/密钥都不因取消/移除删除；切账号后原有 root token 清理、暂停写入和完整权限校验继续生效。

### 4.4 文件职责

`auth.rs` 当前同时处理会话、注册/连接、刷新及凭据锁。本次按生命周期提取，保留其既有公开函数的 facade/re-export：

| 拟新增模块 | 职责与依赖 |
|---|---|
| `feishu/authorization_session.rs` | 会话 owner、revision、取消/终态/移除、journal 和完成通知；不执行注册协议 |
| `feishu/authorization_service.rs` | start/cancel/forget/initialize 协调；调用 session 与 connection_flow |
| `feishu/connection_flow.rs` | 已有应用发现/注册/授权/校验/连接提交；使用 typed SessionContext，不反向导入 auth facade |
| `feishu/credential_lock.rs` | 现有可取消、跨进程凭据锁；供刷新及连接复用 |

新模块目标 200～500 行，均不超过 800；状态、取消、清理随 owner 迁移，不只移动 JSX 或新增另一个巨大 controller。若最低修复先保留 auth.rs 内部结构，至少必须先有同一会话 owner 的串行状态/清理契约和回归证据，不能把移除接口直接实现为 `remove_file`。

前端由整合设计中的 `backupControlStore.ts` 拥有会话，`BackupAuthorizationBanner.tsx`（新）只负责呈现与动作；`RemoteBackupPanel` 不再自行过滤出唯一可操作会话。操作使用按 session/action 区分的 pending 状态，不用页面级 busy 禁止取消。切 target 的 generation 仅影响目标查询，不能丢弃全局授权事件。

### 4.5 多语言

继续使用 `remoteBackup` 现有 key；拟新增 key 包括 `cancelling`、`authorizationCancelled`、`activeAuthorizationFor`、`forgetAuthorization`、`stopAndForget`、`forgetAuthorizationWarning`、`authorizationOwnedElsewhere`、`connectionCompletedBeforeCancel`。中英同步提供：

- 取消授权 / Cancel authorization；正在取消… / Cancelling…；本次授权已取消 / Authorization cancelled。
- 移除本地任务 / Remove local task；停止并移除 / Stop and remove。
- 将停止本地等待并移除此记录。网页上已创建的飞书应用不会被删除。 / Stop waiting locally and remove this task. Any Feishu application already created in the browser will remain.

store 持有阶段和错误码，不缓存已翻译长字符串。语言切换不能重复打开浏览器、重发取消、丢 pending/draft；状态/ARIA/live region 和确认框一起切换。服务器脱敏技术错误保持可展开，主提示使用本地化错误映射。

## 5. 验收与验证映射

| AC | 必须观察的结果 | V |
|---|---|---|
| AC-01 原缺陷 | A 授权中，切 B 或添加目标，仍能看到并取消 A；保存被阻止时仍保留此入口 | 01/04 |
| AC-02 保留 | 留在 A 的原有取消、事件恢复、关闭重开、同目标重复点击仍正常；跨目标查询迟到不污染 | 01/03/04 |
| AC-03 原缺陷/竞态 | 注册/授权各活动阶段取消后停止请求/轮询并释放 auth running；等待完成后可新建 session；旧结果不能提交连接 | 02/04/05 |
| AC-04 删除 | 进行中“停止并移除”及终态“移除”均可幂等完成；status/事件/重启不复活；落盘失败不假报成功 | 02/04 |
| AC-05 竞争 | 取消与 connected、forget 与迟到事件、旧 cleanup 与新 start 竞争时返回真实状态，不清新 owner | 02 |
| AC-06 保留 | 取消/移除不删除已签发应用、共享 connection/凭据、其他渠道或远端数据；重选/重试不盲目重复注册 | 02/05 |
| AC-07 多语言/范围 | 仅 Backup 内部变化，中英实时切换正确，键盘取消/移除可达，关闭确认焦点恢复 | 03/04 |
| AC-08 兼容 | 原生复用/新建应用、缺权限、凭据库失败、账号变化暂停、云备份传输/恢复继续；`.taobak` 格式无改动 | 02/05 + 主设计 V-07/08 |

## 6. 工作包

| TASK | 职责与文件 | 依赖、验证及完成条件 |
|---|---|---|
| TASK-01 区分性复现 | 在 `RemoteBackupPanel.test.tsx` 或新的 `backup/BackupAuthorizationBanner.test.tsx` 使用既有 mounted harness 加 A→B/添加新目标场景；先保留 old UI red 与 A 正常取消基线，不改生产协议 | 可立即开始；V-01 实际运行并保存失败点，避免仅凭存在 IPC 就判已修复 |
| TASK-02 生命周期 | 上述四个 Rust 模块、model 可选会话字段、commands/lib IPC 包装；实现带结束确认的取消与本地 forget、monotonic publication/条件清理 | 依赖明确 owner 契约；V-02/05；不改 provider、归档、加密协议 |
| TASK-03 Backup 呈现与语言 | 新 `BackupAuthorizationBanner.tsx`、共享 `backupControlStore`，RemoteBackupPanel 接线，zh-CN/en；全局提示不依赖编辑 target | 依赖 01 的回归与 02 的状态契约，接主设计 TASK-03；V-01/03/04 |
| TASK-04 集成与原生复测 | 负责共享 model/commands/locale 集成、F-BACKUP-2 映射与所选恢复 case 更新、Windows 合并真机复测及三端代码检查 | 01～03 完成后；V-04/05、主设计对应回归；修复本次引入的相邻退化并回填证据 |

## 7. 验证步骤与证据边界

| V | 具体用例/断言 | 命令或执行方式；当前状态 |
|---|---|---|
| V-01 前端 red→green | A awaiting_registration，切 B/添加 C，操作全局取消→准确 A id；取消完成后新连接可用。另测 stay-A、重挂载、迟到 status/事件。不能把生产 owner mock 掉只验证按钮存在 | `pnpm exec vitest run src/components/settings/RemoteBackupPanel.test.tsx src/components/settings/backup`；新回归待实现/执行 |
| V-02 Rust 状态/真实边界 | 新 `feishu/authorization_tests.rs`：registering/awaiting/authorizing/verifying 逐阶段取消；mock server 记录取消后无新 poll；阻塞请求取消；终态但 cleanupComplete=false 仍不能重连；finally 与新 start 竞争；forget 磁盘持久及失败，旧字段读取、owner 释放、不同账户结果不提交 | `cargo test --manifest-path src-tauri/Cargo.toml --lib backup::`；临时目录、受控凭据 adapter 与本地 HTTP server；待执行 |
| V-03 多语言/保留 | 现有组件测试中 pending/失败/取消/移除确认状态 zh↔en，不重发 authorize/open/cancel；共享连接复用/云历史下载、三代理保存继续 | 现有三份前端测试共 28 项已作基线通过，新增断言待执行 |
| V-04 UI+本机持久化 | 在 F-BACKUP-2 对现有 `TC-BACKUP-CLOUD-002` 增补授权路径或新增专用 case（实施前查重）：切渠道、停止并移除、重开/重启。浏览器证明 UI；native 真实 IPC/journal 证明停止与移除，不宣称已完成服务端授权 | 由主设计 TASK-05 集中更新现有映射；本设计没有新增已登记 YAML，待执行 |
| V-05 当前端真实连接 | Windows 原生打开浏览器、取消等待、重选正确测试账号完成授权、验证完整 scope、继续实际备份；外部应用可能已建的恢复、keyring 拒绝、旧应用/其他目标不删除；归档/恢复兼容引用主设计 | 见下方步骤，待执行；stub 不替代真实 keyring/API/WebView |

本轮实际执行的仅是原有三份前端测试，3 files/28 tests passed。不能因此推导跨目标取消、移除、真实网络停止或历史报告已复测通过；完整基线见 [调研记录](../docs-feature/backup-settings-unification/research-evidence.md)。

### 当前 Windows 原生合并步骤（待执行）

1. 使用已绑定候选前后端的真实 Tauri + WebView2，隔离 profile 与测试凭据分区。保留原应用 profile，不清除用户真实连接。网络测试按测试渠道显式配置三代理模式；日志只记 ID/阶段/请求计数，不输出 Secret/token。
2. A 发起飞书连接，停在浏览器等待注册或授权，不确认创建。回应用切 B/新增 C，观察全局授权提示；即使 C 保存提示 busy，取消 A 仍可操作。
3. 点击取消，观察“正在取消”到终态与 auth running 释放；受控服务端计数确认不再 poll。收起重开 Backup，状态一致。
4. 重新发起后选择“停止并移除”，确认后记录消失，重启不复活；再次连接新 session 能开始。人为阻止 journal 写入时应显示失败，不能只隐藏卡片。
5. 在测试浏览器切正确账号，再继续已保存应用/安全注册或明确重新选择。连接成功后检查身份与所需权限；错误账号不能被旧 session 迟到结果重新绑定。任何已经创建的应用不因本地任务移除被删除。
6. 复用另一已有渠道，验证它的连接和备份仍可工作。新旧 `.taobak` 的检查/解密/恢复按主设计验证。无真实测试账号时，记录 V-05 未验证，不能用 mock 报服务端通过。
7. 保存构建身份、journal 前后脱敏摘要、mock 请求计数/真实 API 阶段、截图与归档 hash，产物放 `qa-ui-auto-report/backup-settings-unification/`（实现时生成）。只清理本轮专用目录/凭据，不撤销真实用户账号。

macOS 对应 WKWebView/Keychain，Linux 对应 WebKitGTK/Secret Service，执行同样的切目标取消、重开、终态移除、正确账号重连与权限拒绝恢复。OS 凭据弹框不可强杀时验证迟到结果无副作用。两端目前未验证，保留后续设备接续；不因此把当前 Windows 兼容范围缩小，也不声称三端实测通过。

## 8. 交付与风险边界

当前可开始全部设计工作包；没有等待用户重新批准的设计项。实际实现交付须包含原缺陷区分性失败→通过、相关正常流程保持、必要 Rust/配置边界、当前端真实 Tauri 复测及归档兼容证据，并通过仓库 `check:refactor`/构建/格式检查。

原报告旧版本未绑定明确 SHA，当前源码证据不能保证覆盖每一个历史失败原因。外部注册不可撤销、OS 凭据弹框不可强制关闭、跨进程任务 owner 不能由别的实例静默取消，这些限制必须准确反馈；不能用重复注册、删除凭据或隐藏卡片来绕过。移除记录的本机新字段不影响任何已有 `.taobak`，无需转换归档。此文档和图稿交付不等于问题已修复，GitHub issue 保持原状态。

实现与验证记录：[`backup-settings-unification/implementation-status.md`](../docs-feature/backup-settings-unification/implementation-status.md)。
