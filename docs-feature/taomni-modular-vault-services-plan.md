# TASK-025：宿主 Vault 服务、一致快照与 profile 协同实施方案

- 日期：2026-11-16。
- 状态：TASK-025-A/B/C 已集成，三端基础/真实锁与 Linux 真实 Vault gate 通过。D 的双向 pump、敏感 writer、有界 dispatcher、独立读循环 SDK 与真实 Vault backend 已实现；`00ac480d8` 已接 registry/bootstrap 生产工厂、外层 scoped 入口及持久 profile generation。macOS 崩溃宿主终止确认已在 `5d49b9abc` 的契约 run #43793976461 通过（全 run 23/23 jobs 成功）。后续核心 operation permit、历史 transport 终止凭据和可重试 registry 清理已接入；当前开发批次已连接 Vault IPC 生命周期、普通核心凭据消费者和真实 MFA facade，仍需该批匹配源码的 hosted browser/native 证据，见[实施台账](taomni-modular-split-progress.md)。D–I 和主 TASK-025 未完成，统一跨库快照、三态还原与独立 MFA 宿主仍待实施。
- 来源：`docs-feature/taomni-modular-split-design.md` S12/S13、DEC-8–DEC-10、TASK-024/025、AC-011/015/016、V-006/011；`claudedocs/adr-taomni-modular-split.md`。
- 调研提交：首次调查为 `2a245d52d`，继续调查时 HEAD 为 `0f4cdf82ffbd519b4217eb56477d0e548e974bce`。签名安装、宿主监督、共享采集这一批仍在集成/验证；本文件没有修改或假设这些共享源码已经冻结合并。
- 文档位置：`docs-feature/taomni-modular-vault-services-plan.md`，关联主设计和 progress 台账。所有项目路径均为仓库相对路径。
- 执行约束：在独立 worktree 实施已授权 A/B，不改其他 owner 的共享文件。本地允许纯进程内单元与静态检查；真实进程锁、崩溃、browser/native 和完整验收均在 GitHub runner 执行。
- 平台：Windows x64/WebView2、Linux x64/WebKitGTK、macOS ARM64/WKWebView，另对 macOS x64 做发布目标编译检查。现工作机为 Linux，但不作为运行测试的替代环境。

目标是让真实 MFA 宿主迁出后仍能生产使用：不连接或解锁 `vault.db`，不把数据密钥交给 renderer；Vault 锁定立即停止受保护操作；原单体 MFA 数据保持可解密；运行中、禁用、卸载保留数据三态均能得到一致备份，并在正常重启还原后验证真实验证码。hello、stub、合成 journal 或伪密文的测试通过，均不能单独使 TASK-025 或 MFA 迁移完成。

当前实施增量：`fdd05d232` 的升级契约 #43819768258 已 23/23 jobs 成功，多端 UI 持续收证。随后本批实现了 F/G 的离线插件数据集、v2 档案、兼容 journal 与依赖检查，尚待匹配源码 hosted 验证。运行中宿主协议、三态真实重启还原、MFA 宿主迁出仍未完成；下文初始调查和分阶段验收要求保留，实时结果以[实施台账](taomni-modular-split-progress.md)为准。

当前新增宿主所有权接线：production registry 已改用 profiled spawn，hello/SDK 自取 shared ProfileUseLease 和 owner 独占 PluginDataLease，并在创建 store 前取得锁；握手确认当前 generation，reader EOF 后 worker/store 尚存时不能提前释放。新五个真实 process gate 与增强 TC-MODULES-007 的 OS writer-lock 观察已准备，待匹配源码 GitHub 证据。运行中 snapshot、三态实际还原和 MFA 迁出仍未完成；下文初始事实表为历史调查，实时状态见实施台账。

运行中快照实施增量：宿主所有权接线和修正后的 profiled Vault/SDK harness 已在源码 `6d8e2ab29` 的契约 #43836198487 取得 23/23 jobs 成功。当前增量把 freeze/export/resume 的所有权放在 SDK 串行 actor，prepare 返回一次性 barrier 并绑定 job、generation、宿主实例和核心指定的空 staging；业务 writer gate 保持到 release，超时/取消/失败/EOF 回收，禁止在 snapshot 请求内取得 Vault key。宿主只以自有 SQLite connection 做 online snapshot；核心复核 inventory、hash、大小和 quick_check，从验证过的同一普通文件句柄复制到私有 staging，完成同批 Vault 后再 release，不允许 live 失败降级为 offline。hello 正常启动仅恢复已存在的自有库，未使用的 profile 不创建库。四项三端真实进程 gate 与 TC-MODULES-012 覆盖两次真实写入、两个备份 job、正常重启及 writer OS 锁；协议尚待匹配源码 hosted 验证，三态 applied restore、真实 MFA 解密与 GUI/headless 协同仍是后续验收。

## 1. 当前事实与缺口

| 位置 | 已有实现 | 待实现/风险 |
|---|---|---|
| `src-tauri/src/vault/mod.rs:26,321,349` | 固定 ID `mfa.data-key-v1`；`get_fixed` 返回 `Zeroizing<String>`；`put_fixed` 为 upsert | 这些是核心进程内部 API，不是 slug 受限服务。不得把通用 upsert 暴露给宿主。 |
| `vault/mod.rs:29,618,627` | renderer 删除命令保护 MFA 固定 ID | `Vault::delete` 本身不保护，renderer update 也未同等保护。新服务必须禁止宿主通用写入、更新或删除其他固定项；核心管理项的 update/delete 要统一保护。 |
| `mfa/crypto.rs:97,114,144,174` | 32 字节随机数据密钥 Base64 存 Vault；AES-GCM + account AAD；key_check 验证；缺 key 且库不空报错；显式 reset 后可重绑 | 宿主版要抽去对 `crate::vault` 的依赖，保留算法、错误和旧密钥 ID。不能“缺 key 就创建”。 |
| `mfa/commands.rs:41,215,243` | 每次账户操作都在 MFA connection 锁内调用 `ensure_key`；锁序 MFA→Vault；导出额外验主密码；reset 先探测 Vault 再清库 | 新服务必须保持锁 Vault 后不再生成代码、导出验密码、reset 锁定时不清库等行为。 |
| `mfa/store.rs:23,41,61` | 懒加载连接，未用过 MFA 不产生文件；库损坏不阻止核心启动；快照可取消等待连接锁 | 宿主自己拥有连接；核心不得为备份重新初始化 MFA schema。 |
| `backup/snapshot_context.rs:114,130,153` | 取消/进度/可取消 mutex；SQLite progress handler；`hot_backup_conn` 实际是 `VACUUM INTO` | 主设计写的是 online backup；为宿主及 offline SQLite 路径提供真正的分步 online backup。 |
| `backup/engine.rs:258,269` | 先单独快照 Vault，后单独快照 MFA；include_mfa 强制 include_vault | 没有跨库/跨进程屏障，首次创建 key、reset、换主密码可能导致两库世代不一致。 |
| `backup/coordination.rs:9` | 多核心 shared ProfileLease；启动有 restore intent/journal 时获取 exclusive 后应用 | 宿主不持 profile lease；没有插件 writer lease、静默/恢复协议。 |
| `plugin/mod.rs:70,422` | manifest 已有 `vaultFixedKeys`、`snapshot`、`backupPaths`；dataDir 校验 `plugins/<slug>` | 未校验固定 key owner；backupPaths 只检查相对路径，未限定插件 data 子树。 |
| `plugin/host/process.rs:327,375` | 核心发 invoke 时等待对应 response；只接受 heartbeat notification | host→core Request 被静默忽略。简单加入密钥服务函数仍会在 MFA invoke 内请求密钥时死锁/超时。 |
| `plugin/runtime.rs:220` | shutdown 取消请求、停止宿主，永久设置 shutting_down | 可复用退出逻辑，但不能把 shutdown 当成可恢复的备份屏障。 |
| `mobile/headless.rs:16,48,115` | GUI shared ModeLease、headless exclusive；headless 自行初始化 Vault/MFA/AppState | 同步改 GUI/headless 的 bootstrap 与生命周期；子宿主不能获取 core 的 ModeLease。 |
| `backup/restore.rs:123,287,407` | 核心固定路径映射，stage→正常重启→journal/rollback；检查 SQLite quick_check | 没有插件 data 路径映射、跨插件依赖集合检查或插件静默。 |

当前测试范围必须准确表达：`TC-MFA-103` 只检查归档同时列出两库，并取消还原；`backup/tests.rs::test_backup_restore_replaces_mfa_db_and_keeps_safety_copy` 使用 `x'00'` 伪密文，只检查行数。这两者都不能证明恢复后可解密。

## 2. 设计决定与验收追踪

沿用用户已确认 DEC-10：核心受限固定密钥服务、宿主不持 Vault 句柄、运行库经 RPC 快照。以下均为既定约束下的内部实现选择，不新增用户审批流程。

| ID | 决定、理由 | 状态 |
|---|---|---|
| DEC-025-1 | 每次 MFA 数据操作领取一次密钥，宿主在该操作结束/取消时清零；禁止 host 生命周期级缓存。最接近现有每命令检查 Vault 的语义。 | agent 技术决定 |
| DEC-025-2 | 保留固定 ID `mfa.data-key-v1`；canonical slug 采用 `mfa`、id=`taomni-plugin-mfa`，主文中“plugin-mfa”是模块称谓。若任务 owner 已冻结其他 slug，应统一改所有 owner 表和 migration alias，禁止双 owner。 | agent 技术决定，集成时核对 TASK-002 |
| DEC-025-3 | 每个 profile/slug 只允许一个写入宿主。第二个 GUI 明确提示“该模块正由其他实例使用”；不新增跨实例转发 daemon。G11 允许共享 profile 下明确拒绝重复启动。 | agent 技术决定 |
| DEC-025-4 | host 自持 shared ProfileUseLease 和 exclusive PluginDataLease；core 崩溃后、guardian 清理前，仍不能错误地还原或启动第二 writer。 | agent 技术决定 |
| DEC-025-5 | offline SQLite 也用只读来源连接做 online backup，禁止忽略 WAL、复制主 db 或调用业务 schema 初始化。普通非数据库文件才直接复制。 | agent 技术决定，收紧 S13 的“直接拷贝”表述 |
| DEC-025-6 | 保持现有“stage 后正常重启应用还原”，不在打开 DB 的 core 进程中做 live restore。存在其他 core/host 的 shared profile lease 时明确阻止。 | 沿用当前产品流程 |
| DEC-025-7 | Vault 锁定为当前 core 实例的锁定，保持现有多实例语义；跨实例主密码/密钥变更由全局操作锁与持久化 revision 检查使其他实例失效。不能把本地锁定误写成已实现全 profile 广播锁定。 | 保持已有语义并补数据一致性 |

以下子验收 ID 附属于原 AC，不替代主设计编号：

| 子验收 | 必须观察到的结果 | 原 AC/V |
|---|---|---|
| AC-016.a | 合法 MFA 宿主能从旧库读取 key 并生成固定 HOTP；其他 slug/未声明 ID/未授权方法被拒，错误无密钥材料 | AC-004/016；V-006 |
| AC-016.b | 锁 Vault 返回成功后，无旧请求、定时操作或旧宿主响应再次显示验证码；正确解锁恢复，错误口令拒绝 | AC-016；V-006/007 |
| AC-016.c | 正常写入、首次建 key、reset、换主密码与备份并发时，归档的 Vault 和数据库可在恢复后共同解密 | AC-011/016；V-006 |
| AC-016.d | 运行、禁用、卸载留数据三态各能备份/重启还原；卸载态无需执行插件代码，重装后读回原 HOTP | AC-006/011/016；V-006 |
| AC-015.a | 第二 writer/其他实例占用/未退出宿主阻止还原；取消/崩溃后锁正确释放 | AC-015；V-011 |
| AC-015.b | GUI/headless 使用同一协议、路径、锁顺序；headless 不创建 Tauri AppHandle；现 ModeLease 行为不倒退 | AC-015；V-011 |
| AC-017.a | 真实旧版 MFA 库迁移后保留 key_check/账户/验证码；源文件不变，失败保留 pending，不伪装 committed | AC-006/017；V-012 |

## 3. 所有权与核心服务类型

以下类型/文件均为拟新增。API crate 只保留协议 DTO，不引用 Tauri、核心 AppState 或 Vault；宿主 SDK、锁和 SQLite helper 按依赖方向独立。

```rust
// crates/taomni-plugin-api/src/services/context.rs
pub struct HostInstanceId(String);  // 私有值；parse 校验非零 canonical UUID
pub struct OperationId(String);     // core 生成，renderer 不能指定
pub struct ProfileGeneration(String);
pub struct VaultEpoch(pub u64);            // 本 core 内单调递增；溢出即拒绝继续
pub struct ServiceVersion(pub u16);

pub struct OperationContext {
    pub host_instance: HostInstanceId,
    pub operation: OperationId,
    pub profile_generation: ProfileGeneration,
    pub vault_epoch: VaultEpoch,
}

// 仅 core 内部构造，不从任何请求反序列化认证身份。
pub struct AuthenticatedHost {
    pub(crate) instance: HostInstanceId,
    pub(crate) slug: ValidatedSlug,
    pub(crate) package_digest: Sha256,
    pub(crate) manifest: Arc<AuthorizedManifest>,
}

// core/services/dispatcher.rs；没有向 host 暴露 Arc<Vault>。
pub trait CoreServiceDispatcher: Send + Sync {
    fn submit(
        &self,
        host: &AuthenticatedHost,
        request: InboundServiceRequest,
    ) -> Result<ServiceTicket, RpcError>;
}
```

- `AuthenticatedHost` 在实际签名包检查、spawn/握手成功后由 core 构造，绑定当前 stdout/stdin pair；不能从 plugin id、JSON 字段、renderer slug 或旧 token 单独恢复。
- core services 只持 `Arc<Vault>`、profile operation coordinator、policy；不持 `Arc<PluginRegistry>`、`HostProcess` 或 `AppState`，避免 Arc 环及反向 mutex 获取。
- `ServiceTicket` 是有取消/deadline 的有限队列任务；completion 只能被对应 HostInstance 的 pump 投递。submit 不等待 Vault mutex/文件锁/宿主响应。
- 外部服务队列按 host 限额；初始上限沿用 transport 的有界策略，通过配置注入测试，队列满返回稳定 busy，不能无限建线程。
- 握手增加可选 `coreServices: {"vault.fixed-key":1,"backup.snapshot":1}` 版本协商；旧 hello 不要求这些服务，继续运行。MFA 宿主缺必需服务时拒绝握手，绝不回退成读 Vault 文件。
- API_VERSION=1 是否仍适用由 TASK-002 owner 以兼容规则确认：字段加法用 serde default/skip 可以保持 wire v1，但改变既有 payload 含义不允许伪装加法。不要在本批测试冻结时随意修改版本常量。

内部统一使用 typed `CoreServiceError`，wire 映射沿用现 `ErrorCode`，不随实现随意新增数值：

| 错误场景 | wire code / 稳定 kind | 兼容要求 |
|---|---|---|
| owner/permission/manifest 拒绝 | PermissionDenied(-32004) / PERMISSION_DENIED | 不带密钥是否存在的信息 |
| Vault 锁定/口令错误 | InvalidState(-32009) / VAULT_LOCKED、VAULT_BAD_PASSWORD、VAULT_PASSWORD_REQUIRED | 前端 facade 继续识别现 ERR_VAULT_* 字符串 |
| key 缺失/不匹配 | InvalidState(-32009) / MFA_KEY_MISSING、MFA_KEY_MISMATCH | Missing 的 Load 结果仍为成功；由真实库状态决定错误 |
| operation/generation/epoch 过期 | InvalidState(-32009) / STALE_PLUGIN_CONTEXT | 不执行副作用，不用旧结果刷新 UI |
| 数据由外部实例占用 | InvalidState(-32009) / PLUGIN_PROFILE_IN_USE | 给关闭其他实例/重试的可操作消息，不转为 skip |
| 取消/超时 | RequestCancelled(-32006)、RequestTimeout(-32007) | 取消后的写入不重放 |
| service 队列已满 | InvalidState(-32009) / CORE_SERVICE_BUSY | 可重试，保留原 operation deadline |

Tauri 的既有 Result<String> 边界通过一处映射保留已有错误前缀；不要让 UI 各自解析 Debug。新归档依赖错误使用 BACKUP_PLUGIN_DEPENDENCY_MISSING，stage前拒绝并列出安全的缺失模块名称。

## 4. 双向 RPC pump 与死锁防护

方法名冻结为 host→core `core/vault.fixed-key`、`core/vault.export-grant.validate`，core→host `backup/prepare`、`backup/snapshot`、`backup/release`、`vault/revoke`。权限标识沿用 `vault.fixed-key`、`backup.snapshot`；method 与 permission 不是同一字段。

1. `RpcRequest` 增加可选 `context: OperationContext`，普通旧插件调用不改变 params 的原始形状；MFA 必须带 core 生成的 context。
2. core/outbound 与 host/outbound 请求 ID 使用不同方向前缀并绑定 HostInstance；host 的 ID 数值不允许冒充 core pending response。所有 response 先按方向和 pending map 路由。
3. `HostProcess::receive_response`、空闲 tick、取消后的宽限等待统一调用一个 `pump_one`：处理 heartbeat、core pending response、host service request 和 service completion；未知/非法消息返回稳定错误或终止协议，不再静默吞 host Request。
4. host service request 校验握手状态、当前 HostInstance、OperationContext、已注册 operation、generation/epoch、permission、deadline、同 session 重复 ID。完全相同的重复服务请求也不再执行，以防重复创建/替换 key。
5. dispatcher 把任务送到独立的有界 worker；worker 只访问 core services，完成结果返回 pump；即便外层 `PluginRegistry::invoke` 正持有 runtime.process mutex，worker 也不获取它。
6. core 在发送 MFA invoke 前获取 `DataOperationPermit`，登记 context。宿主在该命令内请求 key 时借用同一个 permit；不能再获取一次相同屏障读锁，避免“snapshot writer 等外层 invoke，内层 key request 又等 snapshot writer”的递归死锁。
7. host SDK 也需要独立读 pump：MFA worker 等 core key response 时仍接收 heartbeat、cancel、revoke；core 等 snapshot 时 host 也必须继续应答心跳。禁止同步 read-loop 中直接运行整项业务。
8. snapshot/revoke 的 deadline 使用 core job/lifecycle配置，作为不同 OperationClass 显式传入；不能盲用普通短 invoke timeout，也不能接受 host 自报无穷超时。operation 结束时宿主先清 key，再发送结果；core 注销 permit 后拒绝迟到 service request。取消/超时先标记 epoch/context 无效，宿主未确认取消清理则沿用既有 containment 终止与有预算重启，绝不重放写入。

仍在 core 的可信调用与宿主共用 in-flight/epoch/drain 屏障，但 core permit 不含 HostInstance/wire context，不能授权 reverse RPC；其 ID 只在 permit 存活期间保留，Drop 后释放，避免每秒取码消耗宿主历史重放 ledger。宿主历史 ID 仍拒绝重用，不能借 core permit 或取消后重新授权旧 context。长期防重放按下述方案实施；runner 证据闭合前不将此边界记为通过。

锁约束：dispatcher 不拿 registry/host mutex；worker 不回调 PluginRegistry；Vault mutex 持有期间不等 host RPC；host DB mutex 持有期间向 core 请求 key是允许路径（MFA→Vault），但屏障/file lease 已由外层 operation 获取，不在这时再排队获取。

### 4.1 长期运行与有界防重放

- 握手增加可选 `requestIdMode: monotonic-v1`。只有对端明确回显才启用；缺省/旧宿主保留 v1 原有有限 ledger 和错误语义，不根据 ID 外观推断支持，不改变 API/protocol version 或业务 params。单调模式必须绑定本次 core 发放的 HostInstance。
- 两个方向各自使用 `core/<HostInstance>/<u64>`、`host/<HostInstance>/<u64>`，严格十进制、非零、无前导零。单个 stdio writer 的分配与入队顺序一致；接收方只保存已接收最大值，较小/相等 ID 永久拒绝，busy/无效业务请求也消耗序号。允许跳号，不允许迟到补号；不是接受乱序请求的滑动窗口。计数溢出明确失败，绝不饱和重用或回绕。
- renderer 的 correlation、core operation UUID 和线上序号保持各自作用。宿主 mutex 内才分配线上序号；稳定 caller ID 与 wire ID 原子关联同一个取消标记。排队前取消、关联时取消、发送后取消、释放两个 ID 均保留原来的语义。生命周期/snapshot/revoke 也使用同一 core writer 的序号。
- 生产 `OperationAdmission` 在同一屏障内分配并登记新 ID，使用 `74616f6d-*-8*-8*-*` 保留 UUID 空间的 88 位非回绕计数；version/variant 与本地随机 v4 ID 明确分离，不持有已完成历史。显式传 ID 的兼容 API 和本地 core permit 均拒绝整个保留空间，调用方不能选一个旧/未来 ID 重新准入；原显式 API 的 epoch ledger/重复拒绝保持。计数不在 unlock/profile 切换时重置；实际服务仍逐次验证 live permit、已认证 host、generation、epoch、deadline、权限和租约，ID 本身不授予能力。
- SDK 把 pending、待丢弃的一次迟到响应和序号归一个 owner/mutex。取消转为 retirement 与回复路由原子互斥，不存在中间丢失标记；pending + retirement 总计不超过 8。迟到响应只丢弃一次，重复/未发出的响应仍拒绝；对端欠响应时施加背压，收到响应即恢复容量，断开后整个 session 清理。成功/已收到迟到响应的历史不占容量，不按总调用数耗尽。
- 验证包含 70,000 次 API watermark/SDK 内存收发、超过旧额度的核心准入与真实 SDK 子进程调用；额外检查旧握手、错误方向/实例/格式、重复与被拒绝 ID、并发 enqueue 顺序、取消/回复竞态、满队列恢复、溢出、正常退出/重启/epoch 和敏感资源清理。纯 channel 单元不能当真实 stdio、Vault 或 UI 迁移证据；GitHub 真实宿主门与受影响模块/MFA 及完整 crash-regression 分别归档。

## 5. 固定密钥 owner、创建和重置

```rust
// API 中请求不含 slug、不含自定义 kind/label、不含明文 key。
pub enum FixedKeyAction {
    Load,
    CreateIfAbsent,
    RepairEmptyAfterReset { grant: ResetGrantId },
}
pub struct FixedKeyRequest {
    pub context: OperationContext,
    pub key_id: FixedKeyId,
    pub action: FixedKeyAction,
}

// SecretKey 不实现 Clone/Display，Debug 恒为 [REDACTED]，Drop 清零。
pub enum FixedKeyResult {
    Missing,
    Key { context: OperationContext, key: SecretKey32 },
}

// core/services/fixed_key_policy.rs
const FIXED_KEY_OWNERS: &[FixedKeyOwner] = &[
    FixedKeyOwner {
        slug: "mfa",
        id: "mfa.data-key-v1",
        kind: "mfa_secret",
        label: "MFA Data Key",
        bytes: 32,
    },
];
```

授权必须全部满足：当前签名包真实 owner slug=policy owner；manifest permission 含 `vault.fixed-key`；manifest `vaultFixedKeys` 精确包含 key ID；context 对应 core 已准入的 MFA operation。其他 ID 即使声明了 permission 也拒绝。registry、package verification 共用 policy validator；hello 声明 MFA ID 的包安装/启用即拒绝。

`Load`：Vault 锁定保留 `VAULT_LOCKED`；不存在返回 Missing；现有 Base64 或长度损坏保留 `MFA_KEY_MISMATCH`。宿主运行原 `ensure_key` 流程，已有账户或 key_check 时遇 Missing 报 `MFA_KEY_MISSING`。没有读取权限的错误先返回 PermissionDenied，不能泄露条目是否存在。

`CreateIfAbsent`：仅正常首次空库初始化命令可调用；由签名 MFA 宿主在连接锁内确认账户=0、key_check 缺失后发出。核心生成随机 32 字节，固定 kind/label，并用原子 insert-if-absent 替代 upsert；已有 key 返回已有值，绝不覆盖。宿主收到 key 后写旧格式 key_check。core 可检查短期初始化 grant，但不得信任 renderer 的 `databaseIsEmpty` 布尔值；数据库判断归实际持有连接的官方宿主。

`RepairEmptyAfterReset`：只在 core 已准入的显式 `mfa_reset_store` operation 有效；原双重确认 UX 保留。宿主先用 Load 探测 Vault 可访问，再事务性清账户/key_check，然后领取 reset grant 允许的重绑；该 grant 单次、host/operation/epoch 绑定。只有这一分支可以替换损坏固定项；普通 Load/Create 永不能修复/覆盖。grant 接口不进入前端通用 plugin SDK。失败后保留明确的空库恢复状态，不把旧密文伪装成可解密。

普通 `vault_update/delete` 对 core-managed ID 都返回 `VAULT_ENTRY_PROTECTED`；插件没有通用 fixed-key put/update/delete。核心内部原方法逐步降为 pub(crate) 或加受限 policy façade，禁止后续绕过 owner 检查。

密码验证：保留现 `mfa_export_uri` 每次验证主密码。core 先从 renderer 命令参数直接验证主密码，移除密码字段后才发宿主 invoke，不能把密码先发宿主再回传。成功发一次性 `ExportGrantId`；host→core `core/vault.export-grant.validate` 只消费这个 grant，限定当前 export/secret-copy operation。宿主业务命令必须验证 grant 才返回 secret URI；grant 不提供通用 Vault 解锁权。受信官方宿主本就取得数据key，此 grant 是保留官方产品授权流程，不宣称能约束恶意官方签名代码。

## 6. 敏感帧与 generation/epoch 撤销

不能先把 SecretKey 变成普通 `serde_json::Value` 再声称它可清零。现 RpcMessage/Response、transport Vec 及 codec 都有普通 Debug/缓冲，因此需显式敏感通道分支：

- core 的 typed `SensitiveRpcResponse<FixedKeyResult>` 直接序列化到 `Zeroizing<Vec<u8>>`；writer queue 的 WireBytes 区分 Plain/Sensitive，写入、失败、取消、丢弃都清零。日志只记录 method、request id、错误码、耗时。
- host SDK 读帧缓冲清零；根据待处理 reverse request ID 将密钥 response 直接反序列化为 typed secret reply，不经过 generic Value。Base64 暂存、解析失败分支也清零。
- SecretKey32 无 Clone，Debug/错误输出固定脱敏；作用域 guard 在账户操作成功/失败/panic/cancel 时清零。core/helper 不向 Tauri result、event 或 renderer store 返回 key。
- 不把敏感消息写到 stderr/trace、QA evidence、crash metadata。测试验证格式化与错误不含 key，静态审查路径负责检查所有缓冲所有权；不能声称单个 assert 证明了操作系统内存完全不可恢复。

撤销状态：`Open(epoch)` → `Revoking(next_epoch)` → `Locked(next_epoch)`；解锁后到 `Open(next_epoch+1)`。profile restore、host replacement、disable/uninstall 同样使旧 context 失效。ProfileGeneration 存在 core 管理的 `.profile-state.json`（`{formatVersion:1,generation:UUID}`），通过稳定 `.profile-locks/profile-state.lock` 互斥 create/read/atomic rename 初始化，不在还原映射中被旧档案覆盖；每次还原尝试开始写库前换新 UUID，恢复/回滚后也不重新使用旧 UUID。

`vault_lock` 的顺序：

1. 同步关闭本 core 所有 encrypted-data operation admission，递增 epoch；renderer/store 订阅现有 Vault 状态变更并清除可见 code/secret/export UI。增加 generation/operation 比对，迟到成功响应也不得回填。
2. 取消在途 operation，并向当前宿主发送 revoke；宿主阻止新 worker、清 operation keys、等待数据库操作退出，回复当前 host/epoch 的确认。
3. 宽限期使用已配置的生命周期 deadline，不无界等待；未确认时终止 process tree，禁止监督器在 Locked 状态自动恢复 encrypted operation。心跳仍能工作。
4. 确认操作清零/宿主已死后清核心 root_key，重建现有 AI router，报告锁定成功。失败不能返回“已锁定”同时允许旧宿主继续工作；保持 admission 关闭并报告清理失败。
5. 正确口令解锁建立新 epoch；新 command 重新领取 key。宿主进程可保持但不能跨命令缓存 key；被终止则按新 host instance 正常重建。

“锁定请求已收到”到确认结束之间 UI 即隐藏代码；“锁定返回成功”是没有本实例可用旧 permit 的屏障。其他 GUI 的本地锁定状态不被虚构为广播。跨实例 rekey 机制见下一节。

## 7. 跨进程锁与统一顺序

拟新增 `crates/taomni-profile-locks`：仅 std 文件锁、typed root/slug/path validation、取消/超时回调，无 Tauri/业务/RPC。稳定 lock inode 不随 uninstall、restore 或 cleanup 删除。Windows 使用 std 对应 OS 锁，Unix 使用同套 std 文件锁；不要用 PID 文本作为锁的真相。

| 锁/句柄 | 所有者与生命周期 | 作用 |
|---|---|---|
| ModeLease (`.mobile-mode.lock`) | core lifetime；GUI shared/headless exclusive | 保持现有模式互斥；host 子进程不持 ModeLease。 |
| ProfileUseLease (`.profile-use.lock`) | 每个 core 及每个 host 各持 shared、直至自己所有数据句柄关闭 | 还原 exclusive 必须排除真实存活 writer，含 core 崩溃后的 orphan host。 |
| PluginDataLease (`.profile-locks/plugins/<slug>.lock`) | host lifetime exclusive；offline snapshot/迁移/清数据由 core 暂持 exclusive | 保证一个 writer。host 在打开业务 DB前获取，握手成功前必须报告已持有；失败不能初始化文件。 |
| VaultOperationLease (`.profile-locks/vault-operations.lock`) | 正常受保护 operation 持 shared；snapshot/rekey/reset持 exclusive | 跨 core 排除修改 key 与使用旧 key/取得一致快照的并发。 |
| BackupProcessLock (`.backup-operation.lock`) | 原有备份 job | 跨 core 序列化 backup；不替代 ProfileUseLease 或 writer lease。 |
| RestoreExclusiveLease (`.profile-use.lock`) | 还原 core、在打开任何 DB前取得 exclusive | 保持至文件应用/回滚、generation 更新、journal cleanup 全结束。 |

锁顺序与边界：

- user MFA：已有 ProfileUseLease → 本地 DataOperationAdmission → VaultOperationLease shared → outbound invoke → host DB mutex → core Vault mutex。reverse fixed-key 借外层 permit，不重新拿前两项。
- snapshot：BackupProcessLock → 关闭本地 admission 并排空 → VaultOperationLease exclusive → host prepare/freeze 或 offline PluginDataLease → host DB mutex/SQLite snapshot（释放）→ core Vault mutex/snapshot（释放）→ release host/lease → 打开 admission。host snapshot期间不调用 fixed-key/verify-master。
- rekey/reset：关闭本地 affected admission 并排空 → VaultOperationLease exclusive → 被允许的专用 reset/rekey操作。不能先拿 Vault mutex，再等 host DB/准备确认。
- host 的 lifetime PluginDataLease 在启动时已持有，运行态 snapshot不重新抢同一锁；offline 若拿不到锁，则返回 `PLUGIN_PROFILE_IN_USE`，不会无声改用主 db copy。
- restore 与上列锁不同：先停完本地所有宿主和后台任务、关核心 DB，释放自身 shared，然后尝试 exclusive ProfileUseLease；不得在还持本 core shared 时“升级”为 exclusive。失败保留 staged/journal，提示关闭其他实例。
- 锁文件获取均 try_lock+取消/剩余 deadline，不在 UI thread 阻塞。相同进程同一 lease不递归重拿，typed guard 标识 ownership。

跨实例 rekey：正常固定密钥操作持 VaultOperationLease shared。主密码更换/受限密钥替换持 exclusive，故会等待其他实例操作结束。Vault 解锁时记录现数据库 verifier/salt/params 的非秘密 revision；每次准入受保护操作时，在同一 lease 内重新读取 revision。如果被其他实例 rekey，立即清本 core root key、递增本地 epoch，返回 VAULT_LOCKED，必须重新解锁，不把错误旧 root key传给宿主。revision 比对及 grant 获取不能分成可被 rekey 插入的两个无锁步骤。

Vault/root revision 的读取与缓存更新始终在 Vault mutex 内完成，不能用 TOCTOU 存在的无锁 verifier 查询来决定发 key。所有正常 Vault 加密读写也应经相同 access coordinator；外层已持 permit 用 `_with_permit` 内部方法，不重复获取 lease。先为仍在核心的 `mfa::commands::with_key/export/reset` 加外层 permit 再切换 snapshot，否则“持 MFA mutex等 shared lease、snapshot持 exclusive等 MFA mutex”会死锁。

## 8. 一致快照协议与三态行为

```rust
pub struct SnapshotJobId(pub uuid::Uuid);
pub struct SnapshotBarrierToken(pub uuid::Uuid);
pub struct StagingToken(pub uuid::Uuid); // core 映射到一个受限目录，不是任意 path
pub struct SnapshotDestinationGrant {
    pub token: StagingToken,
    pub absolute_job_root: PathBuf,  // 只能由 core 创建、发送，绝不接受 renderer 输入
    pub allowed_files: Vec<SafeRelativePath>,
}
pub struct PrepareSnapshot {
    pub job: SnapshotJobId,
    pub profile_generation: ProfileGeneration,
    pub destination: SnapshotDestinationGrant,
}
pub struct SnapshotRequest {
    pub job: SnapshotJobId,
    pub barrier: SnapshotBarrierToken,
    pub staging: StagingToken,
}
pub struct SnapshotFile {
    pub relative_path: SafeRelativePath,
    pub size_bytes: u64,
    pub sha256: Sha256,
}
pub struct SnapshotResult {
    pub job: SnapshotJobId,
    pub host_instance: HostInstanceId,
    pub profile_generation: ProfileGeneration,
    pub files: Vec<SnapshotFile>,
}
```

host 在认证的 `backup/prepare` 内收到 core 生成的 SnapshotDestinationGrant，将 token/job 映射为该独立 snapshot export 子目录，job结束即注销；路径必须位于指定 staging root，无 symlink/junction/Windows reparse escape。令牌和 path只发给对应宿主，不允许宿主/renderer选择任意绝对目标。宿主只能返回 manifest已授权的文件、固定最大数量/大小和相对路径；core重新校验 regular file、canonical containment、size、hash、SQLite quick_check并通过已验证句柄消费，避免校验后换路径。拒绝 `versions/`、active.json、Vault、core DB、控制锁和日志作为插件 data。

一次 snapshot：

1. 固定本次 selected dependency closure。选择 MFA 自动选择 Vault；未用过的 MFA 不新建库或 key。
2. 暂缓 affected 本地的新 admission 并排空，然后取得 VaultOperationLease exclusive。快照的短暂 pause 保留 epoch 和已准入请求，让其正常完成；新请求在取得 OS lease、store/host mutex 之前等待，取消或 drain/ownership 超时中止且不发布 archive。Vault 锁定/改密仍使用撤销/取消屏障，不能把后台快照误报成 Vault 锁定。真实插件后台 writer 的 prepare 协议仍按第 3 步关闭写入。
3. 本地运行宿主 `backup/prepare`：关闭业务写入门，排空 in-flight和后台 writer，创建 job-scoped barrier token；等待取消/心跳的 pump仍活跃。不把 mutex guard跨 wire或跨 await 保存，而由宿主 store actor/gate持状态。
4. `backup/snapshot` 在 host连接内产 standalone SQLite快照；core Vault在同一全局 exclusive lease期间产快照。顺序不依赖拿两个 mutex，但统一使用 host DB后 Vault，不违反 MFA→Vault。
5. core检查完整结果和Vault依赖后 `backup/release`；宿主只接受 matching job/instance/barrier的release，重复release幂等。`Drop`/error/cancel必须release，host或core死则进程/lease清理；旧job不能解开新job的屏障。
6. 释放屏障和全局lease后才 packing/encryption/upload。后台工作不持续冻结MFA；取消/失败不替换上一完整归档。

`crates/taomni-sqlite-snapshot` 使用 rusqlite backup feature（当前根 rusqlite仅 bundled/hooks，需加 backup），用 `Backup::step` 分页；每步检查 cancel/deadline，Busy/Locked有限等待；目的地 `.part` 完成后 quick_check、fsync再发布job内 ready文件。core SnapshotContext和host SDK通过小trait适配cancel/progress，不让小库依赖Tauri/tokio运行时或core。原 `VACUUM INTO`测试保留，在新 helper与其消费者稳定后按实际影响替换；不得为过关只改注释。

| 三态 | 取数据方式 | 失败/恢复 |
|---|---|---|
| 已启用且本 core host运行 | 上述 prepare/snapshot/release；保留host DB权威连接 | timeout/cancel/crash清job，不静默file fallback；按监督规则恢复后用户可重试 |
| 已禁用/已安装但host未运行 | core拿exclusive PluginDataLease，按受限data contract取offline snapshot；不启动host、不改enabled | 如果其他实例host持lease，明确busy；禁用状态重启后保持 |
| 已卸载但data保留 | 使用core管理的retained data locator，拿exclusive PluginDataLease；不加载chunk、不执行host | 缺metadata可按严格限定的data subtree做保守备份，不能忽略残留数据；重装同owner后恢复可解密 |

“disabled/not-running”是本地状态，不能证明同profile其他GUI没有writer。获取不到跨进程lease时不能记成功或跳过。普通文件按受限相对path复制；SQLite即便离线也使用只读连接online backup，包含残留WAL的已提交内容；不使用 immutable=1，不调用MFA schema初始化，不对source checkpoint/rename/delete。

retained locator 存在core控制目录，卸载前原子记录 canonical slug、数据schema版本及受限相对文件分类；它仅是备份位置记录，不是可信安装凭证，不授予commands、vault keys、code execution或任意路径。其所有路径再次锚定 `plugins/<slug>/data/`；fixed-key dependency由core owner policy强制，metadata不能声称不需Vault。旧 `<profile>/mfa.db` 只作为core已知legacy alias，由TASK-012受控读取；插件manifest不能声明读取任意core根路径。

## 9. 还原、迁移与 GUI/headless 启动

### 9.1 档案与依赖集合

扩展 `backup/manifest.rs` 为带插件数据集的可识别格式：新 modular archive 使用 format_version=2，旧纯核心 format=1仍可读。修改所有格式判断和V1兼容测试，不给未知旧客户端产生“好像支持却忽略插件”的档案。

每个v2插件数据集记录 slug、dataSchemaVersion、archive相对文件列表、依赖Vault标记、snapshot job/generation、数据类别；这是数据metadata，不是可执行manifest。restore把条目锚定 `<profile>/plugins/<slug>/data/`，不恢复版本代码、active指针、permissions或签名信任。解析器限定大小、类型、重复/大小写collision/path/reparse校验；现有path安全、checksum和SQLite检查继续使用。

- archive含加密插件库必须含Vault；缺失时在stage前拒绝，不能在重启应用后才发现不可解密。
- Vault还原将覆盖现有加密插件的数据key；若目标profile已有加密插件数据而档案缺对应数据集，默认拒绝并说明应使用完整备份或空profile。不能默默保留可能不匹配的现库；将来若做“密码验证后比较相同数据key允许”是独立能力，不在此批猜测安全性。
- V1中 `databases/mfa.db` + `databases/vault.db` 按可信legacy映射迁入canonical MFA数据位置；没有Vault的MFA档案明确拒绝，修正伪密文的旧测试。没有MFA的老核心档案仍可读，但覆盖Vault遇目标插件数据时遵循同一依赖保护。
- 不在备份中删除/读取/迁移LanChat；它仍是本次范围外的旧残留目录，保持用户要求的产品删除决定。

### 9.2 正常退出与恢复顺序

stage保持当前流程，写入intent后提示正常重启。退出时core关闭plugin admission、取消请求、停止并等待所有本地host进程树、终止background snapshot工作；然后关闭DB/Vault与file actors，最后释放ProfileUseLease/ModeLease。Arc背景任务不能在lease释放后继续写。

GUI和headless下一次启动均遵循：identity migration/path resolution → core ModeLease → shared ProfileUseLease → 检测intent/journal → 无业务DB打开时释放shared并尝试exclusive → apply/rollback → 更新ProfileGeneration → journal cleanup → 转回shared → 打开核心DB/Vault/registry → 服务注册 → 允许host启动。host只获取shared ProfileUseLease，不调用apply_pending_restore。任何其他实例或orphan host持shared时返回明确busy并保留intent，不kill不归本core的进程。

RestoreJournal增加可向后兼容的generation字段；在第一次实际改文件前原子发布新的generation。crash恢复和rollback也保留这次新generation，不让旧response/grant重新有效。各文件仍由现有journal保护；Vault与所有选中插件库属于同一journal事务，不能分次提交。已有旧journal缺字段时在排他锁内补生成一次，不擅自丢弃journal。

### 9.3 单体迁移衔接

TASK-012继续负责真实exporter与安装状态迁移，不能借本方案把安全pending改为假committed。MFA迁移时：核心只读源 `mfa.db`/Vault存在性预检 → 签名MFA包准备完成 → plugin data staging用一致SQLite快照 → 同key ID的受限服务自检key_check及已知账户解密 → 原子发布数据generation/active与journal committed；失败保持源不变和可重试pending。首次打开新host不默认读取旧根路径，也不生成替代key。

2026-11-18 接线前复核：`migration_preflight::build_file_migration_specs` 只是路径计划，MFA 的 `source=mfa.db` 不能被生产执行器解释为主文件直接复制；`migration_fixture` 中的伪版本/复制事务仍只用于测试。下一批 core-owned exporter 需遵守以下边界：

- 源与目标从核心拥有的 profile、固定 slug 和签名包数据声明推导，不接受 renderer 提供路径。迁移 owner 绑定同一 profile 的排他维护 lease、Vault 操作屏障和生命周期；不能仅传入一个无法核对归属的 lease 加任意根目录。源 `mfa.db`、`vault.db` 及其非空 WAL 的指纹必须与只读预检一致，导出后再次核对；遇到 writer、checkpoint 或源变化时可重试失败，不以旧预检继续激活。
- 使用现有 `taomni-sqlite-snapshot::snapshot_existing` 生成独立、已检查的 SQLite staging；保留原加密列、key_check、HOTP counter、metadata 和偏好，不调用 engine 的 `open_db/init_db` 去迁移或初始化旧源。源、sidecar、父目录及目标拒绝链接/重解析点；取消、超时、busy、校验失败和已有目标均不得替换工作库。staging 在完整检查与持久化后才交给后续可信激活事务，数据最终归 `plugins/mfa/data/mfa.db`，不放在只读 `versions/<version>` 代码目录。
- 预检存在 Vault 固定项但缺少 `mfa.db` 也是现有合法候选。导出器要明确区分“无旧库”和“读取失败”，保留原固定项，不能生成替代密钥或把 key-only 输入错误记为已迁移。旧根 `taomni.db` 的业务记录则必须按归属白名单导出，不能整库复制给宿主；LanChat 历史库不参与扫描内容、导出或清理。

该复核最初只确定接线约束。现已实现受维护 lease 保护的临时 MFA 一致导出 owner，见[实现与验证](taomni-modular-legacy-mfa-export-verification.md)；尚未接入可信激活事务，生产 pending 行为保持。真实验证需覆盖已提交 WAL-only 记录、源并发变化、取消/busy 与失败重试、链接路径、key-only 输入，以及由同一受限 key 服务验证的真实 MFA/HOTP 数据；真实文件、进程和旧版安装输入均在 GitHub runner 执行。导出成功仍不等于可信包 staging、原子激活或完整升级/回滚验收。

TASK-025完成不等于TASK-014完成；后者必须真正移除core的MfaStore/commands/crypto依赖，动态加载MFA UI，保留SSH登录MfaPrompt在core，跑真实安装与升级。headless初始化不能继续私有创建旧MfaStore来绕过插件服务。核心不直连新MFA业务DB（offline只读备份helper和受限legacy exporter除外）。

## 10. 分文件实施顺序与所有权

2026-11-16 MFA engine 增量：纯业务迁至 `crates/taomni-mfa-engine`（models/validation/otp/crypto/keys/operations 与 store schema/accounts/mutations/preferences），不依赖 Tauri、Vault、SDK、网络或采集。核心 `mfa/store.rs` 暂时保留 lazy connection 与 snapshot adapter，`mfa/access.rs` 保持 outer permit、独占初始化/reset、导出口令和 stale-result 校验；Tauri commands 委托同一 engine。本步为 H 的准备，不满足“仅 host 持业务”和“core-only 不引用 MFA”的完成条件。纯 OTP/校验测试移入 engine，真实 Vault/备份/口令断言保留；TC-MFA-015 补真实命令层的 metadata/偏好/重复拒绝/删除持久化。固定 v1 AES-GCM 向量验证旧 schema/AAD/key-check 格式。matching GitHub 执行和后续 SDK owner/actor、可信迁移/安装及动态 UI 完成前，不标 H/I 或 TASK-014 完成；以实施台账记录实际结果。

所有拟新增手写源/测试文件目标200–500行、硬上限800行；超过则按表中责任继续拆，不能压缩格式。根共享文件只由集成负责人指定owner修改。A/B 已获授权在独立 worktree 开始；C/D及共享源码接线仍由集成负责人协调原owner，在冻结结束后推进。

| 子任务 | 依赖/owner责任 | 文件落点与边界（拟新增除标existing） | 完成条件 |
|---|---|---|---|
| TASK-025-A 契约 | TASK-002/005状态契约；API owner | `crates/taomni-plugin-api/src/services/{mod,context,fixed_key,snapshot,error}.rs` 各<350；existing `src/lib.rs`只re-export；schema按字段加法/格式版本维护 | typed context/版本/错误/generation约定落地；不含Tauri/Vault；单元矩阵覆盖serde/invalid input |
| TASK-025-B lease与helper | A；基础设施owner | `crates/taomni-profile-locks/src/{lib,profile,plugin,vault,paths}.rs` 各<350，tests按lock分；`crates/taomni-sqlite-snapshot/src/{lib,backup,context}.rs` 各<350 | 真跨进程锁/崩溃释放、WAL/cancel/Busy snapshot过；小crate无core依赖 |
| TASK-025-C admission/policy | A+B；core services owner | `src-tauri/src/plugin/services/{mod,context,admission,dispatcher,fixed_key,fixed_key_policy,sensitive_wire}.rs` 各<500；`vault/plugin_access.rs`、`vault/access_epoch.rs`各<500；tests按授权/撤销拆 | owner/manifest矩阵、atomic create、无通用upsert、旧key/error兼容；无AppState/registry反向依赖 |
| TASK-025-D 双向pump | C；host owner，等待本批冻结结束 | existing `plugin/host/process.rs`抽出`host/{pump,service_requests,service_completions}.rs` 各<400；existing transport敏感writer分文件；planned `crates/taomni-plugin-sdk/src/{client,service_client,dispatcher,sensitive,operation}.rs` 各<500 | invoke内reverse request正常；取消/心跳/旧响应/限额通过；敏感帧无generic Value路径 |
| TASK-025-E 当前MFA适配 | C+D；MFA owner（在迁出前做保留行为适配） | existing `mfa/commands.rs`外层permit，拆`mfa/{key_provider,export,recovery}.rs`；`crypto.rs`改typed KeyProvider，crypto封装不知Vault路径 | 旧test行为相同；键缺失不重建；export与reset授权不下降；之后可无core依赖搬进MFA宿主 |
| TASK-025-F snapshot与retained | B–E；backup owner | `backup/plugins/{mod,plan,contracts,snapshot,offline,barrier}.rs` 各<500；`plugin/retained_data.rs`<400；existing engine只compose调用；`backup/snapshot_context.rs`适配helper | 三态真实DB一致快照、取消清理、外部owner busy、metadata不扩权；Vault/MFA世代同批 |
| TASK-025-G restore/profile启动 | B+F；唯一bootstrap owner，协调TASK-024 | `backup/plugins/{restore,dependencies}.rs` 各<450；existing restore抽`backup/restore/{paths,journal,apply}.rs`；existing coordination做core orchestration；`bootstrap/{profile,plugin_services}.rs`<400；lib.rs/state.rs/headless.rs仅接线 | GUI/headless统一，host shared profile lease生效；journal兼容、依赖缺失stage前拒绝、crash rollback无旧generation |
| TASK-025-H MFA迁出接线 | E–G且TASK-014前置闭合；插件owner | `src-tauri/plugins/mfa/{module.json,src/main.rs}` shell<250；`src/{runtime,store,crypto,keys,commands,snapshot,recovery,export}.rs`各<500，OTP/fixtures独立；对应frontend按现责任拆 | 实际业务仅host持有；核心only不引用MFA业务；可信安装后真实HOTP、升级、三态还原可用 |
| TASK-025-I 验证与证据 | A–H；QA owner | 新Rust `*_tests.rs`按场景<500；修改TC-MFA-101/102/103/107/108；拟新增cases见§11；catalog/policy/dependencies同改；existing workflow按生产crate加jobs/filter | GitHub三端原生/浏览器/完整crash通过，逐shard实时收证；全部实际原生路径有构建身份 |

A/B 当前已在独立 worktree 实施。A 不改现有 RpcRequest/Handshake 结构，仅新增独立 typed ServiceRequest/OperationContext；其接线由D统一实施。A、B可在API/bootstrap契约明确后独立；C先于D/E；D只由原host owner在当前批结束后集成。F/G不得分别发明屏障、锁和generation。H需要TASK-012真实迁移框架与TASK-013/G门，不因基础单测成功提前交付。Cargo.toml/workspace、state、lib、commands、host process、TabContentRouter不可多owner并行编辑。

## 11. 单元、真实进程与 native/browser 验证计划

全部条目当前均为待执行。用现 `qa-modular-upgrade.yml`扩展真实core service/host contracts，UI使用 `qa-ui-auto-platforms.yml`；不要只给独立小crate写复制的假core。现 `taomni-host-gates`通过path编译生产adapter，可继续复用，但涉及Vault/backup必须链接真正生产service实现，而非在gate内重写一套。

### 11.1 unit行为断言

| 位置（拟新增） | 断言 |
|---|---|
| `services/fixed_key_policy_tests.rs` | 正确owner+manifest+permission全满足；缺一项拒绝；声明他人ID/未知ID/错误大小写/旧session拒绝；拒绝信息不泄露存在性 |
| `vault/plugin_access_tests.rs` | 旧Base64 key字节不变；并发CreateIfAbsent返回唯一key、不覆盖；locked无写入；库不空缺key仍MFA_KEY_MISSING；损坏key非reset不能替换；protected update/delete拒绝 |
| `services/admission_tests.rs` | invoke准入后借用permit不递归拿屏障；epoch变化拒绝late reply；cancel/revoke成功后不注册旧任务；panic/drop释放操作和secret；超时kill后才完成锁定 |
| `host/service_requests_tests.rs` | 外层invoke等待时host反向请求成功；空闲请求未关联operation被拒；pre-handshake/duplicate/direction collision拒绝；长service不阻塞heartbeat/cancel；有界队列满可恢复 |
| `services/sensitive_wire_tests.rs` | Debug/error/日志与serialized metadata无secret；敏感结果不进genericValue/TauriEvent；写失败/取消/queue drop的zeroize owner路径被实际执行 |
| `taomni-sqlite-snapshot` | WAL已提交、未checkpoint数据出现在standalone快照；未提交事务不在快照；Busy可取消；取消不替换旧产物；未知total进度可用；never-used不建源库 |
| `backup/plugins/snapshot_tests.rs` | 首次key创建、HOTP递增、reset、change_master与snapshot并发可恢复解密；key与DB同世代；host崩溃不能fallback主db；篡改size/hash/path/symlink拒绝；job release幂等/过期token拒绝 |
| `backup/plugins/restore_tests.rs` | 三态真实密文+Vault备份→修改→stage→apply→重新打开Vault/宿主code正确；vault-only/mfa-only破坏依赖被stage拒绝；v1完整归档兼容；失败回滚两库同回退 |
| `taomni-profile-locks/tests/process_*` | 第二真实进程writer失败；orphan host仍持ProfileUseLease阻止exclusive；kill后锁释放；不同profile互不影响；Windows/Unix锁不靠PID文本 |
| `bootstrap/profile_tests.rs` | GUI shared、headless exclusive保持；host不持ModeLease；pending restore前不开DB；恢复未拿exclusive不改文件；旧journal按新generation安全恢复 |

复用保留测试：`vault::tests::fixed_entries_roundtrip_and_update`、`mfa::tests::key_errors_locked_vault_and_master_password_change`、`backup_snapshot_only_when_mfa_was_used`、`export_uri_requires_the_master_password_and_round_trips_the_account`、`mfa_data_key_entry_is_protected_from_vault_deletion`、`backup::snapshot_tests`取消断言、`backup::coordination`真实进程锁断言。迁出后移动到对应owner测试crate，保留断言，不能只删除core tests。

### 11.2 原生与浏览器 cases

基础设施补充用例 `TC-MODULES-013/014/015` 分别使用 hello 的运行、禁用、卸载保留数据三态，配对仍在核心内的真实 Vault/MFA，验证精确手工归档→真实数据/HOTP/主密码变化→生产 stage IPC→正常关闭/冷启动 apply→原数据/密码/HOTP 恢复与 generation 连续性。只允许固定场景的路径来源和口令，不在 YAML 暴露任意 IPC；不模拟原生数据或解密。它们尚待 hosted，且不能代替下表独立 MFA 迁出后的 020–022。

原生还原确认界面成功后会在 1.5 秒内主动 relaunch；现有 `native_restart_app` 只支持主动正常关窗后重新启动，不接管应用自动重启。三态用例因此明确验证生产 stage/apply 后端边界；新增 `TC-BACKUP-RESTORE-001` 仅以浏览器模型验证确认界面空/错密码、暂存成功和禁止重复确认。原生确认按钮及自动 relaunch 的会话/进程所有权接管仍需独立补齐，不能从这两类证据推导通过。

下面 TC-MODULES-020–025 已由集成负责人为本方案预留，均为计划、尚未登记。TC-MODULES-007 已由签名成功链使用；新增前仍须复查目录冲突；同一change登记policy、必要dependency、feature-list/covers/controls/testid catalog。不要通过skip或available=false规避必须场景。

| case | 模式与真实步骤/断言 |
|---|---|
| 更新 TC-MFA-101 | native：通过UI安装可信候选MFA包→建立HOTP/TOTP→native_restart_app→账户、HOTP和prefs仍在；证据确认独立MFA PID、已验证包hash、canonical plugin data路径；原core私有MFA代码不能满足 |
| 更新 TC-MFA-102 | native：保持宿主有in-flight code请求→Settings锁Vault→UI立即隐藏→锁定成功后迟到结果不回填→错密码拒绝→正确解锁恢复固定755224；同时确认key-bearing worker已清理或旧host退出 |
| 更新 TC-MFA-103 | native：从原“列档案文件并取消”扩展/拆case；原case保留archive reader检查，但不再宣称包含真实apply/decrypt覆盖 |
| 更新 TC-MFA-107/108 | native：QR/secret-copy仍经core真实主密码验证；错口令时host不收到导出grant、不显示secret；正确口令成功；日志没有master/key/URI |
| TC-MODULES-020-mfa-running-backup-restore | native：UI添加RFC HOTP(755224)→手动backup跟踪精确job/archive→递增到287082并改账户→UIstage原档案→native_restart_app→解锁→原账户及755224恢复；host在snapshot期间确实存活并执行RPC；archive有vault+plugin DB |
| TC-MODULES-021-mfa-disabled-backup-restore | native：同数据→模块商店禁用MFA，确认host退出→backup→使data改变（通过正常重新启用/业务操作后再禁用）→stage/restart→状态仍disabled→重新启用→原HOTP；backup时没有偷偷启动host |
| TC-MODULES-022-mfa-retained-backup-restore | native：同数据→UI卸载保留data→确认版本代码不运行→backup→正常重装/改数据/卸载→stage/restart→仍未安装→重新安装同owner可信包→原HOTP；证明卸载数据未漏备份 |
| TC-MODULES-023-mfa-backup-cancel-recovery | browser+native：snapshot阶段可见progress/job→取消→任务cancelled、旧有效archive未替换→返回MFA正常code/写入→重试成功。native检查真实partial cleanup/屏障释放；browser只证明UI状态恢复 |
| TC-MODULES-024-profile-restore-coordination | native：run-owned第二core/host占用同profile→重复MFA writer明确busy→stage restore后重启被shared lease阻止、journal/两库不变→正常关闭第二进程→重启完成→原HOTP；再覆盖core-kill仍有orphan host保护直到containment退出 |
| TC-MODULES-025-mfa-upgrade-key-continuity | native：真实已发布0.5.x隔离安装创建已知HOTP/固定key→安装候选core+可信MFA→源指纹/journal迁移→原HOTP/导出密码可用→重启幂等→断网/验签失败保留pending与旧数据；不是在新版本直接合成source文件 |

现有 `native_restart_app` 已支持正常关闭并复用隔离profile，不能用 `reload_window`假装重启。新三态case优先用现有UI和host文件断言；跨进程/攻击请求需要runner能力时在QA工具新增受限run-owned进程fixture，只接受本次构建路径/隔离profile，返回PID/exit/锁事件，不给production UI增加“发送任意core RPC”入口。授权负例在真实core+签名probe host integration gate验证；probe不持真实MFA权限，不改core trust来允许任意测试公钥。

browser增加/更新模块启用、不可用/忙、备份任务cancel/reopen、旧response epoch丢弃、导出grant UI状态的mounted/store用例；stub明确只有renderer模拟，不能把其key值/DB模拟作为native证据。完整 `crash-regression` tagged browser/native套件随最终候选运行，插件依赖case必须配对应真实可信插件，不以core-only缺模块skip视为通过。

### 11.3 GitHub执行与证据

现 `qa-modular-upgrade.yml`已在main注册可dispatch。实现后扩展 exact head jobs：服务/SQLite/lease unit（真实production源码），三端真实core/host integration，MFA候选包构建和签名；签名秘密只在可信workflow上下文使用，不能为不可信fork泄露。候选包必须经同一生产验签安装门；QA特殊trust若确有需要只能属于隔离QA身份，记录与production签名链未覆盖的差异，不能据此宣布production trust已验收。

已存在命令（本方案不执行）：

```bash
# 仓库根目录；head必须为已推送的完整SHA。
gh workflow run qa-modular-upgrade.yml --ref refactor/modules-arch -f head=FULL_SHA
# 新case落地和policy登记后才使用这些选择。
gh workflow run qa-ui-auto-platforms.yml --ref refactor/modules-arch \
  -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native \
  -f case_ids=TC-MFA-101,TC-MFA-102,TC-MFA-103,TC-MFA-107,TC-MFA-108,TC-MODULES-020,TC-MODULES-021,TC-MODULES-022,TC-MODULES-023,TC-MODULES-024,TC-MODULES-025
```

Rust jobs中使用真实crate的过滤：`cargo test --manifest-path src-tauri/Cargo.toml -p taomni-plugin-api --lib --locked`、拟新增crate的同类unit命令；native真实进程integration显式选择test名，记录实际executed/pass/fail/skip，不把 ignored测试未执行当通过。实际新增crate/test target按实现落地再固定workflow，不提交写着不存在target的命令。`pnpm check:refactor`、TypeScript/frontend相关unit、必要格式检查也在GitHub执行。

每个完成shard出现artifact即下载、读取summary/receipt/失败步骤和截图；其他runner/build仍执行时就开始判断相关失败并准备修复，不能等最终summary。使用用户指定代理 `http://10.1.0.80:3228`仅用于本工作机外网gh请求；GitHub hosted runner不得继承该内网代理。保留gh认证，沿用当前live shard collector，不另造丢token/覆盖证据的下载器。

证据最少包括：full source SHA、candidate core/插件binary hash、signed package digest、case和runner identity、platform/arch/WebView、host instance/PID、隔离profile、确切snapshot/archive job、每case pass/fail/skip、sanitized raw锁/进程/restore记录、截图。日志只能有非秘密ID和hash，不保留key字节、master、OTP secret或otpauth URI。无关用例失败按用户授权记录并忽略；共享lease/Vault/host改动造成的相邻回归属于本次，必须修复重跑。

## 12. 完成门槛与交接状态

TASK-025可报告完成必须同时满足：

1. owner/manifest/认证dispatcher确在production路径；外层invoke内reverse RPC不死锁，敏感响应不进入renderer。
2. 原固定key与数据兼容、锁定撤销、密码导出门、显式reset保护实际生效。
3. Vault与MFA在真实并发和三态备份后可重启恢复解密；存活进程无法绕过ProfileLease/PluginDataLease写坏还原。
4. GUI/headless共用bootstrap/service协议；MFA迁出后core无私有业务DB句柄，旧upgrade真实fixture与实际旧安装升级分别有明确证据。
5. 当前候选在GitHub三端native/browser受影响cases及完整crash-regression通过；macOS x64编译能力与未运行架构区分记录，不外推真实native结果。
6. 主设计S12/S13、ADR、progress台账和发布/QA文档回填实际行为、run链接、未验证项。基础unit或hello通过不能替代上述条件。

当前实际状态：已完成只读调查与可执行方案，A/B 在独立 worktree 已实现服务DTO、typed文件锁、SQLite online snapshot；本地纯单元和静态验证见下文，三端 hosted gate 待执行。它们尚未接入生产host/backup/bootstrap，不能证明Vault撤销、真实三态还原或MFA迁出。C–I继续按§10推进；主TASK-025待完整原生证据后才能完成。


### A/B 当前实现与实际验证（2026-11-16）

- `taomni-plugin-api::services`：独立 ServiceRequest/OperationContext，固定key/快照/revoke typed DTO；现有 RpcRequest/Handshake payload与API/协议版本不变。SecretKey32不可Clone/Display，Debug脱敏；SensitiveRpcResponse直接写Zeroizing缓冲，尚待D接transport。
- `taomni-profile-locks`：复用std OS文件锁；ProfileUse/Restore沿用`.profile-use.lock`，plugin writer和VaultOperation使用§7固定路径。进程内共享/排他、取消/超时、symlink拒绝已用unit验证；真实进程/崩溃gate为ignored，禁止把编译成功当执行通过。
- `taomni-sqlite-snapshot`：真实`Backup::step`、read-only existing source、WAL一致性、分步取消/Busy/quick_check/临时文件fsync和原子persist。取消在发布前生效，发布为commit点；Unix目录sync结果显式返回，Windows不声称具有同等directory fsync。
- 本地命令：`cargo test --manifest-path src-tauri/Cargo.toml -p taomni-plugin-api -p taomni-profile-locks -p taomni-sqlite-snapshot --lib --locked --offline`；`cargo clippy`同三个package的`--all-targets -- -D warnings`；`pnpm check:refactor`。本地纯单元32/32通过（API15、profile锁7、SQLite10），clippy零warning，check:refactor通过；真实进程测试仅--no-run编译，当前没有hosted执行证据。

为避免与其他owner编辑workflow冲突，以下为整合后`qa-modular-upgrade.yml`新增独立job建议；现workflow不要在基础worker树直接修改：

```yaml
  vault-foundations:
    name: Vault foundations (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.head || github.sha }}
          persist-credentials: false
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri -> target
          shared-key: modular-vault-foundations
      - name: Production contract and in-process SQLite/WAL units
        run: |
          mkdir -p modular-evidence
          set -o pipefail
          cargo test --manifest-path src-tauri/Cargo.toml -p taomni-plugin-api -p taomni-profile-locks -p taomni-sqlite-snapshot --lib --locked 2>&1 | tee modular-evidence/vault-foundation-unit.log
      - name: Real host-owned profile/writer leases and crash release
        run: |
          set -o pipefail
          cargo test --manifest-path src-tauri/Cargo.toml -p taomni-profile-locks --test process_locks --locked -- --ignored --test-threads=1 --exact surviving_host_excludes_restore_writer_and_rekey_until_a_crash_releases_them --nocapture 2>&1 | tee modular-evidence/profile-process.log
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: modular-vault-foundations-${{ matrix.os }}
          path: modular-evidence
          if-no-files-found: error
```

该job只证明A/B单库快照和真实OS锁，不证明生产host已持锁、双向dispatcher、Vault撤销、跨库一致性、GUI/headless或真实MFA升级。C–I仍为待办。
