# 统一备份与恢复：飞书首期详细设计

## 1. 范围与状态

- 基线：`2f18feb4`，2026-10-11，开始调研时工作区干净。
- 平台：Windows、macOS、Linux；本轮真机端为 Windows。其他两端需要保留验证计划，不能继承 Windows 实测结论。
- 状态：设计已定，原生实现与验收进行中；具体能力及执行证据见 [实现验证记录](unified-backup/implementation-status.md)。
- 用户要求：统一考虑本地、S3、Google Drive、OneDrive、飞书、SFTP；本次详细设计并实现飞书，首先用于本地 Taomni SQLite 数据备份；抽象支持以后接入其他数据源；多地安装可以共用一个个人云盘。
- 本次保留现有本地 `.taobak` 导出、core/full/custom 范围、定时备份、历史、解密与重启恢复。首期云端数据源接入已有 Taomni 数据包，SQLite 使用热备，不能直接复制正在写入的数据库文件。通用目录、其他数据库的数据源只定义扩展契约，暂不提供可用配置入口。
- 当前有效选择：设备隔离且可跨设备恢复；同页管理目标/计划/设备恢复；云端强制使用独立密码加密。个人/企业均由 Taomni 原生连接飞书：参考官方 CLI 的必要逻辑，先复用本机已有应用并读取 App ID/Secret；不存在时走浏览器注册。随后申请备份所需完整用户权限，由 Rust 直接调用 Drive。不依赖安装、打包或运行 lark-cli，也没有手填应用凭据或回调配置步骤。详见 [原生飞书连接详细设计](unified-backup/feishu-native-auth-design.md)。
- 本次只参考备份场景需要的配置读取、密钥解析、应用注册、设备码授权与刷新；不移植 Go 命令框架、Agent Skills、消息/日历等业务。官方统一网关及管理员向每台客户端配置 Secret 的路径均不作为首期方案。企业仍可限制应用创建/授权，但不新增管理员提供密钥的 Taomni 入口。

## 2. 当前实现与证据

| 路径 / 符号 | 当前事实 | 复用与变化 |
|---|---|---|
| `src/components/settings/BackupSettingsPanel.tsx` | 手动导出、自动策略、本地历史、恢复确认 | 扩展目标配置和远端浏览，统一恢复预览 |
| `src/lib/backup.ts`、`src/stores/backupStore.ts` | 现有 IPC 和 UI 状态 | 兼容旧调用；任务权威状态移到 Rust |
| `src-tauri/src/backup/engine.rs::hot_backup_conn` | `VACUUM INTO` 生成一致的单库快照 | 接入 `TaomniSource`；不承诺多个独立 DB 的全局事务快照 |
| `engine.rs::pack_staged_archive` | manifest、SHA-256、ZIP、可选加密、完成后 rename | 复用格式与密码算法，增加来源信息；上传只读取已完成产物 |
| `backup/crypto.rs` | Argon2id + AES-256-GCM | 云端必须加密；独立备份密码与 vault 密码不同 |
| `backup/scheduler.rs`、`coordination.rs` | Rust 定时/退出备份，进程内和跨进程互斥 | 在本地快照完成后持久化云端投递任务 |
| `backup/restore.rs` | 暂存、manifest 校验、重启时替换；部分错误被忽略 | 补齐严格路径与格式校验、事务日志、失败恢复；统一本地/远端入口 |
| `backup/mod.rs::backup_stage_restore` | 校验当前 vault 主密码再暂存 | 保留授权；恢复后的 vault 用备份时主密码解锁 |
| `proxy/mod.rs::resolve/resolve_default` | 应用代理和会话代理解析 | 复用；显式直连禁用环境代理 |
| `AppProxyPanel.tsx` 的 `value/onSave` | 已支持嵌入独立配置 | 用于备份目标自定义代理，不覆盖应用代理 |
| `agent/search/key_storage.rs`、全局 keyring 初始化 | 工程已有三端系统凭据库 | 备份单独 service/entry；不复用可被恢复覆盖的 vault 凭据 |
| 当前分支 `backup/feishu/auth.rs`、`cli_config.rs`、`cli_secret.rs`、`device_flow.rs`、`commands.rs`、`RemoteBackupPanel.tsx` | 已替换为原生应用读取/浏览器注册/设备码授权，连接与目标分离；删除手填密钥和 loopback 表单 | 验证状态见 [实现验证记录](unified-backup/implementation-status.md)，真实云端完整验收尚未完成 |

飞书实验在 `output/playwright/feishu-backup-version-test-20261011/report.md`，该目录被忽略，仅为本机证据。结论：同名新上传产生不同 token；显式携带已有 token 可以更新原生版本；ZIP、`.taobak` 已验证；网页恢复 v1 后公开 API 下载的字节哈希与 v1 相同。历史空间没有逐版相加是该账户的观测，不构成服务承诺；容量、保留期限、最大版本数不写成 Taomni 保证。

## 3. 决策记录

| ID | 决定与理由 | 状态 / 来源 | 关联 |
|---|---|---|---|
| DEC-01 | 每个安装实例独立 UUID 及目录，跨设备可读/恢复；恢复不替换本机身份 | 用户已定：2026-10-11 异步答复 | AC-02，TASK-01，V-02 |
| DEC-02 | 继续核查公开 API 的普通文件历史下载；若没有支持接口，打开飞书网页恢复版本，再回 Taomni 下载 | 用户已定条件路径；API 结论见第 6 节 | AC-04，TASK-03，V-04 |
| DEC-03 | 用户配置自己的飞书应用，在 Taomni 发起 OAuth | 历史决定已被 DEC-14 替代；取消手工 App ID/Secret 和 loopback 回调配置 | AC-03，TASK-02，V-03 |
| DEC-04 | 继续使用设置内单页，目标、计划、设备筛选的恢复列表 | 用户已选择草图 v1 | AC-07，TASK-05，V-06 |
| DEC-05 | 云端强制加密，独立备份密码进入系统凭据库，跨设备恢复手动输入 | 用户已定 | AC-05，TASK-02/04，V-05 |
| DEC-06 | provider 与认证方式分开：Google Drive/OneDrive 是 provider，OAuth 是认证策略 | agent 自决，避免把 OAuth 当成存储协议 | AC-01，TASK-01，V-01 |
| DEC-07 | 源/传输/恢复分层；飞书原生历史能力不伪装为所有 provider 都可用 | agent 自决，依据协议差异 | AC-01/04，TASK-01/03 |
| DEC-08 | 企业复用统一自建应用，各用户分别 OAuth；分析共享 Secret 的终端/服务端边界 | 历史方案已被 DEC-12/14 替代，不再等待管理员 Secret 分发决定 | AC-03/08，TASK-02，V-03 |
| DEC-09 | 简化用户配置的候选：Taomni 官方统一应用 + OAuth 网关。用户只授权飞书；网关保管 App Secret，桌面端只保存自己的 user token。飞书企业租户仍可能要求管理员一次安装/批准；商店应用还要求 ISV 资格与发布审核 | 用户明确暂不采用：认为方案复杂，要求继续调研 | 替代 DEC-03/08；AC-03/08，TASK-02，V-03 |
| DEC-10 | 嵌入官方 CLI 自动初始化应用及设备码授权 | 比较候选，已被 DEC-14 的原生最小实现替代 | AC-03/08，TASK-02/05，V-03/06 |
| DEC-11 | 参考 MIT 许可 Go 源码，用 Rust 实现备份所需认证及云盘调用 | 用户已选此方向并要求只实现场景必要逻辑，按 DEC-14 细化；服务端协议兼容性待验证 | AC-03/08，TASK-02/03/05，V-03/04/06 |
| DEC-12 | 个人/企业统一快捷连接，不提供管理员 App ID/App Secret 配置入口 | 用户已定；应用选择与凭据取得方式按 DEC-14 更新 | AC-03/08，TASK-02/05，V-03/06 |
| DEC-13 | 曾使用外部已安装 CLI，缺失显示安装指引，Drive 通过 CLI provider | 已由用户最新要求替代；取消 CLI 安装/检测/进程调用方案 | AC-03/08，TASK-02/03/05，V-03/04/06 |
| DEC-14 | Taomni 原生参考实现：优先复用已有 CLI 应用，按官方配置/存储逻辑取得 App ID/Secret；没有应用则浏览器注册并取得凭据。用户分别授权，Rust 直接调用 API；只移植当前场景必要逻辑 | 用户已定：不独立安装 CLI；有应用直接用、无应用再创建，两条路径均取得 App ID/Secret；简单、高效、可靠。此前不读取 CLI Secret 的设计限制由本决定替代 | AC-03/08/12，TASK-02/03/05，V-03/06/07 |
| DEC-15 | 普通备份文件使用当前版本下载 API；允许用户先在飞书网页恢复历史，再回 Taomni重新下载、校验、走统一恢复 | 用户重申 DEC-02 的降级路径；公开 API 未找到普通文件指定历史版本下载契约 | AC-04，TASK-03/04/05，V-04/07 |

当前有效原型：[预览](unified-backup/ui-preview.png)、[可编辑 draw.io](unified-backup/ui.drawio)。尺寸约 1140×930，代表设置内容区滚动布局，非整窗固定大小。2026-10-11 已展示并得到用户“采用该布局”的反馈；原型通过不代表 UI 已实现。

## 4. 统一模型与目录

数据流：`BackupSource → 一致性快照 → ArtifactCodec → 不可变本地 Artifact → DestinationProvider → Receipt`。
恢复：`BackupLocator → Provider 下载/本地读取 → ArtifactCodec 验证解密 → SourceRestoreAdapter 预检 → RestorePlan → 暂存 → 应用/回滚`。

### 4.1 统一抽象与扩展契约

下表区分首期已实现契约与后续扩展；IPC 实际类型以第 8 节和 `backup/model.rs` 为准。

| 类型 | 首期字段/操作与后续扩展 | 约束 |
|---|---|---|
| `ProviderKind` | local / feishu / s3 / google_drive / onedrive / sftp | 未实现返回 `PROVIDER_NOT_IMPLEMENTED`，不展示假成功 |
| `ProviderCapabilities` | currentDownload、nativeVersionUpload、listVersions、downloadVersion、resumeUpload、resumeDownload | 能力按 provider/账户/传输路径识别；未知不等于支持 |
| `BackupSource` | 首期 `snapshot(app,spec,path,password)`、`inspect(path,password)`；未来数据源注册表与 `planRestore` 待扩展 | 仅数据源知道 DB、目录、数据依赖；provider 不知道 SQLite |
| `Artifact` | path、snapshotId、size、sha256、sourceKind；设备/源版本/时间/加密属性放 manifest | 完成后不可修改；不能把机器绝对路径放远端 manifest |
| `DestinationProvider` | 首期 `capabilities/list/upload/download`；探针与设备枚举封装在 Feishu provider 内；独立版本接口后续按能力扩展 | 接收通用 artifact/locator；不直接恢复业务数据 |
| `BackupTarget` | id、name、kind、enabled、connectionId、rootToken、proxy、source、writesPaused；能力由 provider 查询 | 用户账户身份与目录绑定；所有机密在 keyring |
| `BackupPlan` | 首期使用旧 BackupPolicy 时间计划 + selectedTargetIds + 各 target.source；独立多计划 DTO 后续扩展 | 每目标独立结果；本地完成不等于云端完成 |
| `BackupJob` | id、revision、operation、targetId、phase、bytes、total?、error、artifact?、remote?、receipt?、createdAt | 持久化，UI 只订阅/查询；恢复操作须再次确认 |
| `BackupLocator` | 首期 `RemoteBackup`（targetId/deviceId/deviceName/sourceKind/fileToken/name/modifiedAt）；固定 version/revision 后续扩展 | 不能把任意 URL 当凭据请求目标 |
| `RestorePlan` | 首期由统一恢复器内部管理 manifest/白名单映射/restore intent；其他源恢复适配后续扩展 | 文件映射由已注册数据源产生，不相信归档给出的绝对目标路径 |
| `ProviderError` | 首期脱敏 String/稳定错误标识；结构化 code/retryable/retryAfter 后续扩展 | 不含 token、secret、授权码、签名下载 URL |

Rust 采用 `async_trait` 的 provider 接口，数据源的阻塞快照在 blocking pool 执行；trait 不引用 React/命令参数。首期 `TaomniSource` 适配当前 scope/customOptions，保留 MFA→vault 依赖。新数据源应提供自有恢复映射和版本迁移；不能通过给飞书模块添加数据库分支扩展。

### 4.2 设备与命名空间

本机 `backup-control/config.json` 的 device 保存 UUID 与显示名，同时保存 targets 和 connections 引用；控制目录还保存任务及下载缓存索引，独立于 taomni.db，不进入归档/恢复白名单。系统凭据按 deviceId/targetId 或 deviceId/connectionId 分区。重命名只改标签；恢复保留当前设备身份。整目录克隆的身份冲突需要后续的“作为新设备注册”入口，不宣称能无条件自动识别。

飞书选择的根目录下：

```text
Taomni/
  devices/
    <deviceUuid>/
      taomni/<planUuid>/current.taobak
      device.json
```

上述为逻辑名称；实际操作必须保留 folder_token/file_token。目录名不等于唯一键，创建后持久化 token；重试先做归属校验。设备条目/描述不含主机用户名、IP、路径或机密。发现两个相同标识对象时返回冲突，不取第一个覆盖。每台设备只写自己的分支，浏览可读取所有设备，默认操作不清理其他设备的数据。

备份 archive 内增加可选来源元数据，旧 formatVersion=1 仍可识别；首期来源信息包括 snapshotId/deviceId/deviceName/sourceKind/sourceSchemaVersion；planId 为后续独立多计划扩展。不能只依赖云端 `device.json` 或本机上传历史判断内容：网页回退后必须重新读取归档内部的来源与 createdAt。

## 5. 备份、调度、加密与任务

1. 复用现有 SQLite 热备生成暂存快照；同一实例的手动、自动、恢复准备串行协调。
2. 使用独立云备份密码加密 artifact。首启目标必须设置密码并确认可从系统凭据库读取；无凭据库时明确阻止启用自动云备份，不落明文替代文件。
3. artifact 与投递任务先持久化再上传。上传失败保留 artifact；本地 retention 不得删除未投递任务持有的文件。缓存满时报错，不静默丢任务。
4. 各目标独立 receipt；仅远端确认且核验达到要求后记云端成功。失败可重试；单目标失败不重跑其他已成功目标。
5. 计划和任务由 Rust 服务拥有。UI 卸载/关闭设置继续运行；整进程退出时上传中断，重启恢复为 interrupted/pending，不谎称“关闭应用仍上传”。退出时本地快照和任务入队完成即可，网络上传下次继续。
6. 首期遵循已有 daily/weekly/on_exit；云端启用是显式配置动作。旧用户升级不自动上传。现有本地历史/策略独立迁移，不将失败解析默认为新账户。

任务阶段：queued → preparing → connecting → uploading/downloading → verifying → completed；任一可取消阶段可到 cancelling/cancelled，异常到 failed/interrupted。取消要终止活动请求与流，保留安全 partial/checkpoint。取消上传不能保证撤回已经提交到服务端的版本；网络结果不确定进入 `reconciling`，核对 snapshotId/hash 后再决定是否重试，避免盲目产生重复版本。

keyring 使用独立服务 `taomni.backup`；保存 app secret、OAuth token bundle、archive password。控制 JSON 只有引用和非敏感配置。密码变更只用于后续备份；旧版本仍需要旧密码，UI 在修改密码前明确说明。当前 vault 密码负责允许覆盖当前数据；备份密码负责解包；备份时 vault 密码负责恢复后解锁，三者不能混同。

## 6. 飞书实现细节与 API 核查

### 6.1 授权

当前生效方案为 [原生飞书连接详细设计](unified-backup/feishu-native-auth-design.md)，研究证据见 [CLI 源码与认证调研](unified-backup/feishu-auth-alternatives.md)。应用配置和用户授权是两个阶段：

1. 用户点击“连接飞书”。已有 Taomni 应用绑定时复用；否则原生读取本机 `~/.lark-cli/config.json` 的应用列表和当前 profile，按源码解析 App ID/Secret。CLI 二进制是否存在不影响此步骤。多个候选显示当前应用，允许选择；配置损坏或凭据库锁定要报错，不误判为“没有应用”并新建。
2. 没有本机可复用应用时，Rust 按官方 CLI 的 `PersonalAgent` 注册 begin/poll 流程打开飞书网页；成功响应直接返回 App ID/Secret。保存成功后才进入用户授权，不让用户复制密钥。注册与用户授权可能需要分别确认一次，不能承诺服务端会合并页面。
3. 以取得的 App ID/Secret 发起设备码用户授权，一次带齐本功能所有启用操作需要的 scopes；用户浏览器确认后，Rust 轮询取得 user/refresh token，验证 user_info 和权限并保存到 Taomni 自己的系统凭据库。
4. Taomni 使用自己的 token 直接调用 Drive，不读取、覆盖或刷新 CLI 的 user token，也不修改 CLI 配置和默认 profile。已有 CLI 应用的 Secret 是应用级共享凭据；本机令牌存储分开不等于服务端一定隔离授权，需要在个人账户验证 Taomni 新授权不破坏原 CLI 登录。
5. 首期个人/企业用相同流程。企业限制自助注册或授权时明确显示服务端原因；不能创建新应用绕过管控，也不转为手填管理员 Secret。所有目标继续独立三代理，注册、授权、刷新、上传、下载全部走该目标的网络设置。

最小实现是应用发现/Secret 兼容读取、注册/设备码 HTTP 适配、token 管理三个边界，复用已有 `network.rs`、`credentials.rs` 和后台任务。配置与密钥格式按已核对的 CLI `v1.0.23`/`v1.0.97` 兼容，网络协议固定参考 `v1.0.97`，不混合 main 分支实现。macOS 实际是 AES-GCM 凭据文件 + Keychain 主密钥，并非 App Secret 直接存于普通 Keychain 条目；兼容适配必须按真实源码处理。Taomni 自己的新凭据写入沿用工程 keyring，不复制 CLI 全套存储后端。

首期 scope manifest：`offline_access`、`drive:file:upload`、`drive:file:download`、`drive:drive.metadata:readonly`、`space:folder:create`、`space:document:retrieve`。按实际 list/create/upload_all/prepare/part/finish/download/metadata 操作与文档校正并版本化；不使用 CLI 的 `--recommend` 请求消息/日历权限。用户授权返回范围不足时不能记为已连接；重新申请完整集合，并给出准确缺失项。不申请普通文件不支持的文档版本权限，也不以 bot token 替代用户权限。

源码 `v1.0.97` 设备码 token/刷新使用 `https://open.feishu.cn/open-apis/authen/v2/oauth/token`；现有普通 OAuth 草案的 accounts v3 JSON 流程不能直接套入设备码。初始化/设备码接口未找到完整独立公开契约，放在集中适配器中，用服务端验证补齐可靠性证据；协议不支持时停止连接并讨论替代方案，不要求用户临时安装 CLI。逐 connection 串行刷新及原子保存轮换结果，失败分类处理；详见详细设计与 V-03。

### 6.2 版本与上传

截至本次重新读取公开文档：

- `GET /open-apis/drive/v1/files/:file_token/versions` 的 `obj_type` 仅列 `docx`、`sheet`，并非普通二进制文件。
- `GET /open-apis/drive/v1/files/:file_token/download` 文档只有 file_token 和 Range，没有指定历史 version 的公开参数。
- 官网云文档索引未列普通文件历史下载接口。结论是“没有找到受支持的公开契约”，不是宣称飞书内部不存在实现；不猜测未文档化参数作为产品保证。
- 上轮网页内部 history/revert API 依赖浏览器登录态，不接入产品，也不采集 Cookie。

据 DEC-02，普通文件能力声明 `listVersions=false`、`downloadVersion=false`，历史入口导航到可信 `https://my.feishu.cn/file/<token>` 或公开返回且验证域名的文件 URL。具体 URL 以实际文件元数据/网页验证为准，不伪造历史面板 deep link。

小文件新建使用 `upload_all`；后续携带现有 file_token 创建版本，验证返回 token 不变及 version 结果。覆盖字段处于灰度：首次连接在专用探针目录检测，不拿用户有效备份当探针。能力不足时停用该目标写入并明确错误，不能静默创建多个同名文件冒充版本控制。

大于 upload_all 上限使用 prepare/part/finish；需进一步实测指定 file_token 的分片覆盖是否保持原生历史。CLI 参考称分片路径没有 version 返回，不能以空 version 判定失败或凭 action 推断成功；必须结合 token、下载哈希及网页历史证据。若账户不支持大文件覆盖，应在写入前明确拒绝且保留本地 artifact，具体大文件产品退化需与用户讨论，不擅自改独立快照策略。

### 6.3 历史恢复闭环与竞态

当前版本恢复：用户点击“下载当前备份”→ API 下载 → 校验解密 → 显示归档真实时间/设备/范围 → 用户确认 → 统一暂存和重启恢复。Taomni 不需要列出历史就能走通此路径。

历史恢复：用户点击“飞书历史版本”→ Taomni 展示来源设备/文件并打开网页 → 用户在飞书手工恢复某个版本 → 返回点击“已在飞书恢复，重新下载”→ 全新获取当前内容 → 解密显示归档内备份时间/来源/文件清单 → 用户确认 → 统一暂存和重启恢复。此流程满足用户“没有指定版本 API 时拉取当前，但也允许手工回退后再拉取”的要求。

启动网页恢复引导时，检查本机上传任务并持久化暂停该目标写入，在用户点击“结束历史恢复，恢复上传”之前持续暂停，关闭页面/重启也不解除。其他设备是独立写入者：跨设备历史恢复要提示用户暂停源设备上传；下载采用修订校验/稳定性检查，检测变更则丢弃不安全 partial 并重新获取。网页回退后的下载创建新的 job 和 revision/checkpoint，不复用回退前的缓存或 Range 残片。无法给云端只靠目录实现的机制虚构跨机器锁；若无法得到稳定 revision，禁止跨版本拼接续传。用户最终确认的是已下载并验证的本地不可变 artifact，而非远端“当前版本”指针。

本地上传记录只是操作日志，不作为可下载的完整云端历史。网页回退后 size/hash/createdAt 可能变化，不能拿最新上传日志硬判旧版损坏。整包解密认证、内部 manifest 的逐文件哈希负责内容验证；有可信 provider revision/hash 才用它固定下载。

### 6.4 网络、断点与错误

每目标三种代理：应用（默认）、独立配置、直连；复用 `AppProxyPanel` 和 `proxy::resolve`。本次用户指定飞书.cn 直连，测试及其目标配置显式选直连；不将个人网络地址硬编码产品。HTTP client 禁止隐式环境代理，配置代理失败不回退；重定向跨域不转发 Authorization，限制 HTTPS 和允许的服务/CDN，避免授权请求流出。官方认证域和 API 域分别校验。

下载 `.part` 与已完成文件分开；checkpoint 保存 locator、稳定 validator、预期总长、已写长度、已确认区间。重启读取文件真实长度。续传 206 必须核对 Content-Range 起点/终点/总长；200 表示服务器忽略 Range，明确从零重新下载；416 不能直接当成功，需核验完整大小与内容。没有稳定 ETag/revision 或远端已变更时从零重启，说明原因。进度包括连接/下载/校验/完成/取消/失败、字节/总长/百分比，未知总长显示不确定进度。

频控遵循公开文档及 Retry-After；429/暂时性 5xx 用可取消退避。401 只进行一次串行刷新后安全重试；403 显示缺 scope/文件权限区别。写操作超时后先核对远端，禁止当成“未写入”盲重试。

## 7. 统一恢复与兼容

本地导入和远端下载最终共用同一恢复器，不允许 provider 直接写 live DB。

1. 验证封装格式、appName、支持的 formatVersion/sourceSchemaVersion、加密认证、条目数量和解包上限、重复路径、跨平台安全相对路径、文件大小、SHA-256。拒绝绝对路径、`..`、反斜线混淆、盘符、NTFS ADS、symlink、未登记文件、大小写碰撞。
2. 数据源生成目标白名单；SQLite `quick_check`/兼容性预检通过后才能准备 apply。控制平面和本机 identity 永远不在映射内。
3. 先在唯一临时目录完成校验，再原子发布 restore intent；失败不破坏之前可用的 pending restore，不接触 live DB。
4. 恢复确认区明确：来源设备、备份时间、范围、覆盖后重启、所需三个密码角色。不提供跨设备合并或自动同步承诺。
5. 重启打开任何 DB 之前应用。每次 restoreId 创建 safety copy，含所有将覆盖的数据及必要 WAL/SHM；写入日志记录阶段。备份或替换失败则停止，保留可恢复材料，不记录成功或继续在半恢复数据上启动。
6. 多文件恢复需可恢复事务：先备份全部目标，再依次发布，失败回滚已经替换的目标；重启遇到中断日志先回滚/继续明确阶段，不能重做覆盖 safety copy。日志中包含原文件不存在的情况，回滚删除本次新建文件。
7. 成功清理 staging、记录结果后启动应用；本机 identity、目标配置、token、备份密码仍属于本机。若 vault 被替换，后续解锁要求备份时主密码。

旧 manifest v1 缺少来源时显示“来源未知”，仍按 Taomni 旧版映射恢复。旧未加密本地文件仍可导入，云端新上传必须加密。未来数据源未知时允许下载保存但禁止套用 Taomni 恢复器。

## 8. 首期 IPC 与 UI 行为

| 命令 | 输入 | 输出 / 行为 |
|---|---|---|
| `backup_remote_get_config` | 无 | `config`（device/targets/connections/selectedTargetIds）和 `statuses`（targetId/connected/passwordConfigured）；不返回凭据 |
| `backup_remote_save_config` | config、targetId?、archivePassword? | 校验和持久化；App ID/Secret 与 connection 绑定由后端管理 |
| `backup_feishu_apps` | 无 | CLI 可复用应用元数据 `appId/label/isDefault`；不解密全部 Secret；已保存 connections 通过 config 返回 |
| `backup_feishu_authorize` | targetId、applicationSelection? | 完整 `AuthorizationSession`；后台发现/读取/注册/授权，通过事件提供可信网页 URL 与状态 |
| `backup_feishu_authorization_status` | 无 | 所有安全授权快照；重新打开页面恢复等待状态 |
| `backup_feishu_authorization_cancel` | sessionId | 取消后台会话；组件卸载不自动取消 |
| `backup_run_selected` | scope（core/full，本地范围） | 每个目的地 `targetId/jobId?/localPath?/error?`；云端范围使用各 target source spec |
| `backup_remote_list` | targetId | 全设备当前文件列表；后端分页，前端按 deviceId 筛选 |
| `backup_remote_start` | targetId | jobId，后台创建或复用相同上传任务 |
| `backup_remote_download` | remote（RemoteBackup） | jobId，后台下载后提供受控 artifact；网页回退后启动新下载世代 |
| `backup_remote_jobs` | 无 | 持久化任务快照 |
| `backup_remote_cancel/retry` | jobId | 显式取消/重试与安全续传 |
| `backup_remote_history_url` | remote | 验证归属后返回网页 URL，并暂停本机该目标上传 |
| 既有 `backup_inspect/backup_stage_restore` | path、备份密码、当前主密码 | 兼容本地和云端文件，调用统一校验与恢复器 |

事件 `backup-job-progress` 是完整 BackupJob，字段包含 id/revision/phase/bytes/total?/error?；`backup-authorization` 是完整 AuthorizationSession。先订阅再获取快照，按 revision 忽略迟到消息；组件卸载只取消订阅。错误不清空上次成功结果，保存失败保留表单。密码不进入 Zustand 持久化或日志。

新增界面使用现有 i18n 中英文词条：目标设置、代理、授权阶段、后台任务、恢复提示和操作反馈随语言切换重新渲染；设备/目标名称保留用户输入。错误主提示本地化，脱敏的后端原始错误放可展开技术详情。日期使用应用语言。恢复确认的来源、设备身份与三个密码角色也本地化。

## 9. 实现工作包

| TASK | 文件职责（落点） | 依赖 / 具体交付 | AC / V |
|---|---|---|---|
| TASK-01 | `backup/model.rs`、`backup/control.rs`、`backup/source.rs`、`backup/provider.rs`、`manifest.rs` | 统一模型、版本化配置、设备身份隔离、TaomniSource 与 local 适配；其他 provider 返回明确 TODO | AC-01/02，V-01/02 |
| TASK-02 | `backup/credentials.rs`、`backup/feishu/auth.rs`、`feishu/cli_config.rs`、`feishu/cli_secret.rs`、`feishu/device_flow.rs`、`backup/network.rs`、`model.rs`/`control.rs` | 按 DEC-14 原生读取已有应用/Secret，无应用注册；完整 scopes 设备码授权、身份验证、刷新互斥、三端 keyring。删除 loopback 和 App Secret 手填契约；协议/存储具体落点见原生连接设计 | AC-03/05/08/12，V-03/05/07 |
| TASK-03 | `backup/feishu/mod.rs`、`transfer.rs` | 官方 API list/upload/download、token 归属、原生版本探针、历史网页路径；大文件覆盖实测 | AC-04/06，V-04/07/08 |
| TASK-04 | `backup/jobs.rs`、`scheduler.rs`、`engine.rs`、`restore.rs`、`lib.rs` | 持久化调度/恢复、队列、取消/重试/去重；统一恢复严格校验与可回滚 apply | AC-05/06/09/10，V-05/07/09 |
| TASK-05 | `src/lib/backup.ts`、`src/lib/remoteBackup.ts`、`backupStore.ts`、`BackupSettingsPanel.tsx`、`RemoteBackupPanel.tsx`、locales/stubs、`backup/commands.rs`/`lib.rs` | 保留已选布局，替换应用密钥/回调表单为原生连接状态、已有应用选择及浏览器注册/授权；目标三代理、设备筛选、当前/网页历史恢复、后台任务恢复 | AC-03/04/07/12，V-03/04/06 |
| TASK-06 | 相邻 Rust/Vitest 测试、QA case/catalog、本文证据回填 | 完成集成、当前 Windows Tauri 真机；其他 OS 兼容检查和接续步骤 | 全部 AC/V |

其他 provider 待办：S3（endpoint/region/bucket/path-style/凭据/版本能力）、Google Drive（OAuth/refresh token/文件修订能力）、OneDrive（OAuth/driveId/itemId/upload session）、SFTP（SSH/密钥/host-key 校验/atomic rename）。仅保留 provider 标识、不可用能力声明和接入任务；不能把对象存储浏览器或 SFTP 会话直接冒充已完成备份适配。

## 10. 验收与验证

| AC | 可观察结果 | V / 具体断言与实现后命令 |
|---|---|---|
| AC-01 | local/feishu 复用归档引擎，provider 只接收通用 artifact，不包含 SQLite 专用逻辑；首期按各目标范围/密码生成归档，不承诺所有目标使用同一字节快照；未实现 provider 明确拒绝 | V-01：Rust 模型/适配测试；`cargo test --lib backup::`，`src-tauri/` |
| AC-02 | A/B 同账户并发备份分别落各自目录；B 恢复 A 后 B 身份不变，B 下一次仍写 B | V-02：两个隔离 app-data + 真实飞书根目录；检查 token 与 identity 哈希 |
| AC-03 | 无 CLI 安装仍能完成原生连接：已有应用读取 ID/Secret 并复用，无应用通过网页注册；随后带全 scopes 授权、验证身份、刷新/重新授权；拒绝/过期/取消不产生假连接 | V-03：注册与设备码 mock server、合成 CLI 配置/三端加密存储 fixture、Windows 原生浏览器授权；不输出机密。具体断言见原生连接设计 |
| AC-04 | 连续三次备份 token 不变；历史恢复指向实际文件，回到应用展示旧 archive 时间与内容 | V-04：真实个人账户合成 DB v1/v2/v3，网页历史 + API 下载 hash + SQL 值 |
| AC-05 | 新云备份不能上传明文；错误备份密码不暂存；当前主密码授权与备份时主密码职责正确 | V-05：加密/密码错误/跨设备凭据隔离测试、现有 vault 恢复回归 |
| AC-06 | 页面关闭后继续传输；取消停止网络；重启重试不拼接不同修订、不产生伪完成 | V-07：原生本地 HTTP 测试服务覆盖 200/206/416、错误 Range、断流、ETag 改变、429 |
| AC-07 | 同页配置/筛选/任务/恢复闭环，未支持 provider 禁用，错误状态可恢复 | V-06：`pnpm test -- src/stores/backupStore.test.ts src/components/settings/BackupSettingsPanel.test.tsx`，新组件测试，`pnpm build`；Windows WebView smoke |
| AC-08 | 三代理模式有效；直连忽略环境代理；独立配置不覆盖全局；代理失败不直连 | V-07：Rust 客户端向本地代理/目标记录实际请求，断开代理观察失败 |
| AC-09 | 本地旧 v1 明文/加密恢复不退化；恶意归档/未知版本/写失败不损坏原数据 | V-09：现有 `backup/tests.rs` 生命周期 + 新路径/校验/回滚故障注入测试 |
| AC-10 | 本地成功、云端失败分别显示；退出备份入队；重启可重试且保留 artifact | V-09：scheduler/job 持久化测试 + 原生退出/重开 |
| AC-11 | >20 MB 原生版本覆盖实际可用或写前明确能力不支持，不能造出同名独立文件冒充版本 | V-08：已实测两次约 25.2 MB 加密 SQLite 归档分片覆盖，同 token、当前下载 hash 及解密通过；具体边界见实现验证记录 |
| AC-12 | 配置坏/凭据库锁定不能自动新建；再次连接、多目标使用不重复创建；关闭设置和重开恢复授权等待；复用不修改 CLI 配置、Secret 或 user token | V-03/06：配置损坏/缺密钥/重复点击/注册中断/多目标/迟到响应/重新挂载；V-03 Windows 核查只读复用及 Taomni 独立授权会话 |

验证状态：前端与 i18n 27 项、Windows 后端备份 34 项通过；实际范围与原生检查见 [实现验证记录](unified-backup/implementation-status.md)。不能据此推导全部 AC 通过。前期 CLI/网页测试不算 Taomni 实现通过。

### 真机执行与平台

Windows 当前端：使用 QA runner 的独立应用标识与实际支持的 NEWMOB_DATA_DIR/NEWMOB_CONFIG_DIR/NEWMOB_CACHE_DIR。只上传隔离 profile 的合成 SQLite 到专用测试根；验证多次上传、关闭/重开后台状态、另一 profile 同账户浏览/恢复、SQL 行数、设备身份和云端 token，避免上传开发者真实数据库。

先读 `.agents/skills/qa-ui-auto/SKILL.md` 再选已支持 runner；现有备份 feature 位于 `qa-ui-auto-tests/feature-list.md` 的 `settings/backup`，沿用 `backup-history-row`/`backup-restore-files`/`backup-auto-toggle` 等结果断言。新增云端 selector/case 由 TASK-05/06 登记，不能只检查按钮存在。

macOS：使用 Keychain + WKWebView，验证 CLI 加密文件/Keychain 主密钥兼容读取、系统权限弹框、原生浏览器设备授权、目录权限、原子替换及退出续传。Linux：使用 Secret Service + WebKitGTK，兼容读取 CLI 的 AES-GCM 文件；Taomni 新凭据仍写自己的系统存储，无 Secret Service 时明确阻止保存云凭据，不降级文件。两端构建/真机当前未验证，复用同样合成数据和 AC，需各自留证据。

三端代码审查关注 portable path、Windows DPAPI/注册表及文件替换、macOS Keychain 主密钥读取、Linux 加密文件读取、大小写碰撞、系统凭据初始化、设备码后台生命周期、可信外部浏览器 URL。首次成本较高的 native 构建在相关代码稳定后集中执行，失败不反复跑无关全量检查。

## 11. 未完成项与交付条件

原生应用复用/注册、完整 scopes 设备授权及 Rust Drive 链路已落地；Windows 个人账户真实授权、版本覆盖、网页回退后下载与重启恢复、大文件分片及原 CLI 当前登录只读回归已通过，具体范围见 [实现验证记录](unified-backup/implementation-status.md)。仍需补齐无应用真实注册、长期刷新、跨设备恢复和发布评估中的异常处理缺口。企业按用户要求暂不真机测试。CLI 的独立实验不代替产品验证；实际不兼容时带具体错误与方案讨论，不悄悄改用 Cookie、外部 CLI 或独立快照。

回退：旧本地 archive 格式和调用兼容；新控制目录不覆盖原业务 DB。禁用云目标停止后续投递，保留本地 artifact/远端内容；撤销授权不删除云端备份。回退版本看不见新云目标状态，但仍可使用旧本地恢复；恢复事务一旦暂存，必须由支持该 intent 版本的程序处理，旧版本不得误应用。

本轮完成要求：设计与实现一致、全部适用 AC 有证据、必要自动化通过、Windows 真实 Tauri 主流程与真实飞书交互通过、无已知三端兼容缺陷；其他端仅保留未验证状态。不得用设计落盘、CLI 实验或浏览器 stub 代替功能实现完成。
