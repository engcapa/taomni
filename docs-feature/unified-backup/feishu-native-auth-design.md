# 飞书原生连接：复用应用或自助注册

日期：2026-10-11。状态：原生实现已落地，验证结果与未验证边界见 [实现验证记录](implementation-status.md)，真实云端完整验收尚未完成。本文件细化 DEC-14/15、TASK-02/03/05、AC-03/04/08/12、V-03/04/06/07。

## 1. 用户行为与最小范围

个人/企业都从备份设置的“连接飞书”进入。Taomni 自己实现所需 Rust 逻辑；客户机不用安装 lark-cli、Node.js 或 Go。用户无需复制 App ID/Secret、配置 loopback 回调或找管理员取得应用密钥。

连接顺序：优先复用 Taomni 已保存的飞书连接；否则发现本机已有 CLI 应用并取得其 App ID/Secret；没有可复用应用时，按官方 CLI 流程在浏览器确认注册并取得 App ID/Secret。随后进行完整备份 scopes 的用户授权，由 Taomni 保存自己的用户凭据并直接操作 Drive。

已有 CLI 配置是可选的首次接入来源，不是运行依赖。复制已选应用的 Secret 到 Taomni 自己的系统凭据库后，CLI 卸载或配置目录移动不影响已连接目标。普通用户界面仅显示应用标签/脱敏 ID、账户、连接状态、目录、备份密码和代理；Secret 始终留在后端。

仅实现下面三块必要认证逻辑，尽量复用现有依赖：

| 边界 | 实现文件/改动 | 所需能力 |
|---|---|---|
| 应用发现与兼容读取 | `src-tauri/src/backup/feishu/cli_config.rs`、`cli_secret.rs` | 解析本机 apps/currentApp，解引用选中 App Secret；平台代码位于同一模块的 cfg 分支，不新增 CLI 框架 |
| HTTP 协议适配 | `feishu/device_flow.rs`，改 `feishu/auth.rs` | 注册 begin/poll、设备授权 begin/poll、身份核验、刷新、退出/拒绝/取消/超时 |
| 本机状态与后台入口 | `backup/credentials.rs`、`model.rs`、`control.rs`、`commands.rs` | 应用/连接引用、系统凭据、授权快照、去重与锁；复用 network/任务设施 |

不需要 Go helper、命令路由、npm 安装器、CLI Skills、Agent workspace 绑定、CLI 的环境 token provider 或消息/日历等业务。Rust Drive provider 继续接收通用加密 artifact，统一恢复器继续负责实际恢复。

## 2. 固定源码依据

协议参考官方发布 `v1.0.97`，commit `72579c80027c863ca51d5f9affda72a70ab0d8a6`；配置/Secret 兼容另外检查本机实际使用过的 `v1.0.23`。不把 main 分支新增机制混入发布版行为。以下为代码证据而非独立公开 HTTP 契约：

| 官方源码（v1.0.97） | 参考内容 |
|---|---|
| [config.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/core/config.go)、[secret.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/core/secret.go)、[secret_resolve.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/core/secret_resolve.go) | apps/currentApp/profile 选择；plain/file/keychain 引用；`appsecret:<appId>` 匹配校验 |
| [Windows keychain](https://github.com/larksuite/cli/blob/v1.0.97/internal/keychain/keychain_windows.go)、[macOS keychain](https://github.com/larksuite/cli/blob/v1.0.97/internal/keychain/keychain_darwin.go)、[Linux keychain](https://github.com/larksuite/cli/blob/v1.0.97/internal/keychain/keychain_other.go) | 现有 CLI App Secret 的平台读取格式，不照搬 Taomni 新凭据的写入后端 |
| [app_registration.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/app_registration.go)、[init_interactive.go](https://github.com/larksuite/cli/blob/v1.0.97/cmd/config/init_interactive.go) | 无应用时注册、浏览器验证 URL、成功取得 client_id/client_secret |
| [device_flow.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/device_flow.go)、[paths.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/paths.go)、[login.go](https://github.com/larksuite/cli/blob/v1.0.97/cmd/auth/login.go) | 带应用凭据的用户设备码流程、完整 scopes、用户信息 |
| [uat_client.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/uat_client.go)、[token_store.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/token_store.go) | 刷新轮换、写入检查、锁、损坏和不确定结果处理 |
| [LICENSE](https://github.com/larksuite/cli/blob/v1.0.97/LICENSE) | MIT；实质移植保留官方版权和许可声明，在对应源码标出处及第三方许可中登记 |

原始源码和文档缓存位于 `output/feishu-backup-api-research/v1.0.97/`、`v1.0.23/`（被工程忽略，仅本地证据）。前期调研只读取配置字段类型、应用元数据和引用方式。本轮原生个人测试实际读取所选应用凭据，始终不打印 Secret/token；企业账号未测试。

## 3. 有应用时：原生读取，避免重复注册

### 3.1 发现与选择

1. 检查当前 target 已绑定的 Taomni connection；凭据可用直接使用，已授权时不再打开浏览器。新目标可复用已保存连接，同账户多目标不重复授权/注册。
2. 没有 Taomni 应用可用时，读取当前 OS 用户正常本地 workspace 的 CLI 配置：默认 `~/.lark-cli/config.json`。支持非空 `LARKSUITE_CLI_CONFIG_DIR` 指定的配置根目录，并显示发现来源；不继承 Agent 环境变量自动切入 openclaw/hermes 子目录，不扫描其他用户目录或全部磁盘。
3. 两个核对版本均采用 `apps[]`，`name` 可省略；只接入 `brand=feishu`。默认按 `currentApp` 的 name/App ID 匹配，未设置时按首个可用 Feishu 项选择；有多个候选显示默认项和切换列表。无国际版 Lark API 接入需求，不增加品牌切换 UI。
4. 单个候选直接在“连接飞书”动作内复用；多个候选时复用页面中选定的默认项。来源选择用不含 Secret 的内部 applicationId/reference，不让前端提交任意 Secret 路径或 keychain 服务名。
5. 配置文件确实不存在或无 Feishu 应用时进入新建；解析失败、currentApp 悬空、未知格式、Secret 不可用、文件不可读都返回可操作错误，不把它们折叠成“无应用”。用户可修复后重试；不自动覆盖 CLI 配置，也不自动新建绕过错误。

启动发现只解析元数据，不解密所有 profile 的 Secret；真正连接时才解析用户选中的一项。限制配置/引用文件读取大小并检查普通文件，防止坏文件导致无界内存分配。读取前后发现文件被替换时重读一次，仍变化则要求重试。

### 3.2 Secret 解析：遵循官方格式，只读兼容

`SecretInput` 支持官方 `string`、`{source:"file",id:...}`、`{source:"keychain",id:...}` 三种形式。keychain 引用必须满足 `id == "appsecret:" + appId`；未知引用源、不匹配、空 Secret 或解密认证失败均拒绝。file 引用只在后端按配置中明确声明的路径读取并 trim；不执行命令、不展开 shell、不把文件内容作为错误输出。

| 平台 | 官方 CLI Secret 读取方式 | Taomni 兼容实现 |
|---|---|---|
| Windows | `HKCU\Software\LarkCli\keychain\lark-cli`；值名是 `base64url_no_pad("appsecret:<appId>")`，值为标准 Base64 的 DPAPI 密文；entropy 是 `lark-cli\0appsecret:<appId>` | 利用工程已有 winreg/windows，增加 Cryptography feature（按编译实际需要）；只读选中注册表值，调用当前用户 `CryptUnprotectData`，及时释放/清零缓冲区 |
| Linux | 默认 `~/.local/share/lark-cli/`（支持 `LARKSUITE_CLI_DATA_DIR`）；account 中非 `[a-zA-Z0-9._-]` 替换成 `_` 得到 `.enc` 文件；`master.key` 为 32 字节密钥，文件为 12 字节 nonce + AES-256-GCM 密文/tag，AAD 为空 | 复用 aes-gcm/zeroize，仅解密选中 appsecret 文件；不读取 `<appId>:<openId>` 用户令牌文件 |
| macOS | `~/Library/Application Support/lark-cli/` 中同样的 `.enc` 格式；服务 `lark-cli`、account `master.key` 的系统 Keychain 值是 Base64 的 32 字节主密钥；v1.0.97 已有 `master.key.file` 时会先尝试该文件 | 读取选中密文，用系统 Keychain 取主密钥；兼容已有 fallback 文件，但不创建/降级任何 CLI 存储；拒绝/超时显示系统访问错误。不能用“普通 Keychain 条目 appsecret”代替真实格式 |

CLI 缓存不是跨版本稳定 SDK，因此把兼容逻辑集中在 `cli_config/cli_secret`，用合成 fixture 覆盖两个核对版本；不支持的格式明确失败。不要通过 `security find-generic-password -w`、PowerShell、进程环境或 CLI 子进程输出明文密钥。平台 Keychain 调用使用受控阻塞任务，等待取消后忽略迟到结果，不把不可取消的 OS 权限弹框误称已强制关闭。

取得 App ID/Secret 后先保存到 `taomni.backup` 的私有 credential entry，再保存脱敏的 application binding。自此不再逐次备份读取 CLI 文件。CLI 侧的 `config.json`、当前 profile、Secret、master key 和用户 token 均不写入或删除。CLI 密钥轮换导致 `invalid_client` 时首期显示修复凭据/重新连接错误；自动重新读取同一 appId 的来源为后续待办；App ID 发生变化时要求用户重新选择，不能悄悄切应用。

这里取得的是应用级 Secret：并没有因为存入系统凭据库而变成不可提取或仅能访问一个用户文件的秘密。具体账户访问仍使用每个用户授权的 user token 和飞书 ACL。

## 4. 没有应用时：参考注册 begin/poll

按 `v1.0.97` 的必要协议实现，入口均来自当前目标的 network client：

| 阶段 | 请求 | 处理 |
|---|---|---|
| begin | `POST https://accounts.feishu.cn/oauth/v1/app/registration`，form-urlencoded：`action=begin`、`archetype=PersonalAgent`、`auth_method=client_secret`、`request_user_info=open_id tenant_brand` | 不带 App ID/Secret；校验 device_code/user_code、expire_in（兼容 expires_in）、interval。官方默认过期 600 秒、轮询 5 秒；begin 单请求上限 30 秒 |
| 浏览器确认 | 参考源码展示可信 `https://open.feishu.cn/page/cli?user_code=...` | 用户在官方网页登录/确认注册；这是官方页面，不伪装为 Taomni 自己创建的登录页，也不读 Cookie。CLI 专属版本/渠道跟踪参数不影响必需协议；需要服务端验证，不捏造 Taomni 为某个 CLI 发布版本 |
| poll | 同一注册接口 POST form：`action=poll`、`device_code=...` | 首次立即 poll，pending 后按 interval 等待；slow_down 增加 5 秒，最多 60 秒。设备码过期/拒绝明确终止。首期仅 Feishu；若 tenant_brand 要求切到 Lark，明确不支持，不把凭据发送给未支持域 |
| 成功 | 响应 `client_id`、`client_secret`、可选 user_info | 校验字段和 brand，立即保存应用凭据/绑定后进入用户授权。user_info 是注册身份线索，不是 user_access_token，也不构成 Drive 已授权 |

连接按本机应用初始化加锁、重复点击返回同一 session；多个目标同时首次连接也不能重复注册。注册成功后即使用户拒绝后续权限或退出应用，重试仍复用已经保存的 App ID/Secret。

注册为外部副作用，不能承诺取消或保存失败会撤回已创建的应用。只要尚未持久化成功返回的凭据，显示“应用注册可能已完成，但本机保存失败”，停止自动重试新建；保留本轮内存中的待保存结果供用户重试保存。应用重启后无法恢复该结果时明确说明，需要处理已有应用后再连接，不暗示能找回未保存 Secret。先检查 Taomni credential store 可读写，减少创建成功却无法保存的情况。

注册流和用户授权流在官方代码中是独立步骤。Taomni可自动衔接，但可能需要用户在浏览器分别确认；不承诺只出现一次确认，也不把注册成功称为备份连接成功。

## 5. 用户授权、权限与令牌

### 5.1 与源码相同的必要设备码协议

| 操作 | `v1.0.97` 参考请求 |
|---|---|
| 用户授权 begin | `POST https://accounts.feishu.cn/oauth/v1/device_authorization`；Basic auth 是 base64(App ID + `:` + Secret)；form-urlencoded 包含 `client_id`、完整 space-separated `scope` |
| 用户 token poll | `POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`；form-urlencoded：`grant_type=urn:ietf:params:oauth:grant-type:device_code`、`client_id`、`client_secret`、`device_code` |
| 身份核验 | `GET https://open.feishu.cn/open-apis/authen/v1/user_info`，仅使用取得的 user token；该 API 不要求额外通讯录 scope，不读取手机号/邮箱等不需要字段 |
| refresh | 同一 open.feishu.cn v2 token endpoint；JSON：`grant_type=refresh_token`、`client_id`、`client_secret`、`refresh_token`。按源码区分 token 响应必需字段、code/OAuth 错误和不确定结果 |

使用 begin 返回的 verification_uri_complete（缺失用 verification_uri），验证 HTTPS、官方 accounts/open.feishu.cn 域和可信路径后才展示/打开。session ID 把设备码、网络设置、应用/账户绑定在后台；不把 device_code、Secret 或 token 通过 IPC 发给 React。用户网页确认后轮询得到的是 token，**不是 loopback authorization code 回调**。

只有 session 仍有效、字段完整、user_info 核验通过、scope 检查满足要求且本机保存成功，才转 connected。处理 pending/slow_down/拒绝/过期/取消，使用可取消的等待和请求、服务端 deadline；网页关闭不等于 Taomni 已取消，需要用户点击取消或超时。新 session 使旧 session 结果失效，迟到结果不得覆盖新账户/新授权。

### 5.2 一次申请完整的备份操作集合

首期维护 `FEISHU_BACKUP_SCOPES_V1`，在应用复用和新建两条路径都用相同集合：

| Scope | 操作 |
|---|---|
| `offline_access` | 获取 refresh token，供后台定时备份 |
| `space:document:retrieve` | `drive/v1/files` 目录/设备清单 |
| `space:folder:create` | 根/设备/目标文件夹创建 |
| `drive:file:upload` | `upload_all`、`upload_prepare`、`upload_part`、`upload_finish`；含同 file_token 覆盖 |
| `drive:file:download` | 当前文件完整下载、Range 下载、上传后回读核验 |
| `drive:drive.metadata:readonly` | 文件元数据与可用修订校验；以落地 stat API 的正式权限契约核对 |

实现前按每个实际 API 核对 manifest，覆盖全部启用操作；不使用 `--recommend` 请求所有 CLI 域。普通文件没有可用版本 API，因此不申请 `drive:drive:version`；首期没有远端删除操作，不申请删除 scope。将来增加操作时更新 manifest，在执行前补授权，不宣称当前集合涵盖所有未来功能。

解析实际 granted scope，以集合匹配避免子串误判。返回范围不足或没有 refresh token：保留有效应用绑定，会话转 failed，显示缺少权限；connected 查询根据已保存 granted scopes/有效 refresh 判断，后续重新申请全部必要 scopes。未返回可判定 scope 时不能假定已具备；用协议核验/受控探针补证据，不靠一次 list 成功推断可上传下载。应用权限和用户同意是两个边界，企业/已有应用拒绝某 scope 时不能通过创建更多应用绕过限制。

### 5.3 最小持久化与多目标

控制配置 connections[] 的 FeishuConnection 字段为 id、appId、label、origin（cli_existing/native_registered/legacy）、accountId/accountName/tenantKey、authProtocolVersion、scopeManifestVersion、registrationPending；不含 Secret 或 token。CLI 来源按同一 appId 重新发现，不接受前端文件路径；credential entry 由 device UUID + connection UUID 确定。target 引用 connectionId，并独立保存目录、备份密码与代理，多个 target 可共享已授权 connection。

凭据存储使用 taomni.backup service：connection entry 保存 app_id（注册结果写入后恢复绑定）、app_secret、access_token/refresh_token、expires_at、refresh_expires_at、granted_scopes、generation 和 refresh_in_flight；target entry 保存独立备份密码。Windows 单条凭据容量有限，connection bundle 使用最多 128 KiB 的有界分块（每块 2,000 字节）存入同一系统凭据库，全部写完后原子发布含 SHA-256 的小型索引，再清理旧世代；失败保留原索引，读取检测并发世代变化后重试。不写明文文件，兼容旧小型 JSON entry。凭据 JSON 使用 Rust snake_case，控制 IPC 使用 camelCase。connectionId 是随机 UUID，按 device UUID 分区；均不进入归档或跨设备恢复。

同一 connection 共享 token 时加 connection 锁，锁内重新读取最新 generation，刷新并原子替换 bundle；多个目的地不能分别刷新同一 refresh token。刷新由当前发起操作的 target proxy 进行，不因代理失败改用其他目标代理或直连。后续等待者读取最新 token；只有新失败且仍需刷新才按自身明确配置再发请求，避免未配置的自动 fallback。

借鉴官方的写入检查、锁和 generation 思路，不移植整套 provider/错误框架。并发重新授权/注销与刷新使用同一锁；跨同一 app-data 的进程用工程现有跨进程锁。临时网络失败与明确 invalid_grant 分开；不能把所有刷新错误都删除凭据。请求已发出但轮换结果不确定时，停止盲目重试和重复消费，标记需要重新授权；已签发新 token 但保存失败时不继续自动使用旧 generation。

Taomni 为自己单独设备授权，不读取/复制 CLI 的 user/refresh token，不修改 CLI 用户列表。服务端是否允许同一应用/用户多个独立授权会话仍要实测；本地分区不能保证新授权不会在飞书侧影响旧 CLI 登录，这项待验证不能写成已解决。账户改变先核验再清空相关目标的旧目录/file token 映射，暂停写入并要求重新选择目录；不同应用下的 open_id 不能用作跨设备统一账户标识。

### 5.4 现有未发布草案迁移

`BackupTarget.appId/oauthPort`、保存入口 appSecret、前端密钥/回调表单属于当前分支旧草案。TASK-02/05 改为 connectionId，不再接受前端任意 App ID/Secret。已有草案配置若存在：将有效 appId/Secret转入本机 connection，保留备份密码、device UUID 和 root token；只有旧 token 身份/协议/范围可以证明有效才复用，否则保留应用并要求重新授权。迁移失败保留原控制文件，禁止静默注册新应用。旧本地备份 IPC/归档与当前 vault 恢复权限语义保持兼容。

## 6. 后台会话、UI 和网络

沿用已选单页布局与三代理 UI。删除 App ID/Secret 输入框、OAuth 端口和回调配置指导；连接区显示已有应用选择（有多个时）、来源/账户、注册/授权状态、授权链接/重新打开按钮、取消/重试。这是用户要求的官方流程替换，不新增页面或角色。

IPC：backup_feishu_apps 返回 appId/label/isDefault；backup_feishu_authorize 接受 targetId、applicationSelection?（已保存 connection UUID 或已发现 CLI App ID），返回完整 AuthorizationSession；backup_feishu_authorization_status 返回所有安全快照；backup_feishu_authorization_cancel 接受 sessionId。事件 backup-authorization 与快照同型：id、targetId、revision、createdAt、phase、verificationUrl?、userCode?、error?；phase 为 discovering/resolving_app/registering/awaiting_registration/authorizing/awaiting_authorization/verifying/connected/failed/cancelled/expired/interrupted。Secret 解析始终在后端。

授权由 Rust 后台持有，UI 先订阅再取快照、按 revision 合并。关闭设置页不取消；重开显示等待状态并允许重新打开官方链接。进程退出不能继续轮询；重启保存的应用可复用，授权 session 标为 interrupted，用户重试新用户授权，不自动再创建应用。注册应用凭据与等待状态分开持久化，设备码无需长久存盘。

注册、设备授权、轮询、身份 API、刷新以及后续 Drive 全部用 `backup/network.rs::client` 解析发起 target 的应用/独立/直连模式；`.no_proxy()` 禁止隐式系统/环境代理，配置代理失败明确报错。会话建立后冻结网络配置，用户更改代理须显式取消后重新开始。测试飞书 .cn 按用户约定直连；外部源码下载使用研究代理，地址不写入产品默认。

浏览器作为 OS 外部进程，其网络不由 Taomni 请求 client 控制，不能声称目标代理同时控制系统浏览器。native HTTP 关闭自动重定向；密钥不发往任意输入的 URL。机密类型禁止 Debug/Serialize 到前端，敏感内存用 zeroize，日志只输出阶段、安全错误码、脱敏身份。

## 7. 备份版本与恢复

官方 [版本列表](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-version/list) 的 obj_type 只有 docx/sheet；[普通文件下载](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/download) 只有 file_token/Range，没有指定历史 revision 参数。本轮已直连重新读取两份文档。结论限于支持的公开契约：普通 `.taobak`/ZIP 没有找到指定历史版本下载 API。

因此 `currentDownload=true`，普通文件 `listVersions=false`、`downloadVersion=false`；原生覆盖版本能力按探针/实际回读验证。API 默认拉当前文件，不能传猜测的 version 参数或使用网页私有 history/revert API。

“飞书历史版本”打开被选文件的官方网页，用户手工回退后，“已在飞书恢复，重新下载”调用普通当前下载 API，下载到新的不可变本地 artifact。进入网页流程前持久化暂停本机写入，检查已运行上传，不能允许旧上传在暂停之后再提交覆盖。保持暂停到用户显式恢复上传；同 connection 下其他 target 若指向同一云端 file token，也需阻止其覆盖。跨设备不伪造全局锁，提示用户暂停源设备。

网页回退使 file_token 对应内容变化，重新下载必须使用新的缓存/partial 世代；没有稳定 validator 时从头下载，不能拼接网页回退前字节。整包加密认证、manifest 哈希、SQLite 预检通过后，展示实际备份时间、来源与范围，再由统一恢复器确认/暂存/重启。下载成功不会自动覆盖 live DB。

## 8. 验证与交付

下表是完整验收计划；已执行的子集和未验证边界见 [实现验证记录](implementation-status.md)，不能把表格本身当作执行证据。

| V/AC | 必需断言与最小验证层 |
|---|---|
| V-03，AC-03/12 | Rust fixture：两个版本 apps/currentApp、多个 profile、空配置、缺配置、坏 JSON、悬空引用、plain/file/keychain、App ID 与 Secret key 不匹配；损坏/锁定不能新建；不读未选用户 token |
| V-03，AC-03/12 | Windows 合成 DPAPI 注册表 entry（仅测试随机 service/account），验证 entropy/value 编码；Linux AES-GCM 主密钥/密文/损坏/tag；macOS合成 Keychain 主密钥+加密文件、已有 fallback、拒绝/超时。测试无真实 Secret 输出 |
| V-03，AC-03/12 | 本地 mock HTTP 真实客户端：注册 begin/poll 返回凭据、pending/slow_down/拒绝/过期；复用不触发注册；重复点击、多目标只一次注册；注册成功后拒绝用户授权仍复用应用；保存失败不继续授权/自动新建 |
| V-03，AC-03/12 | 检查 Basic/header、form/JSON、token endpoint、完整 scopes、scope 缺失/不足、refresh 缺失、身份错误、可信 URL 校验、迟到旧会话；成功必须保存后才 connected |
| V-03/07，AC-03/08 | connection 并发刷新只消费一次旧 generation；注销/重新授权与刷新冲突、不确定结果/写入失败不能回滚到旧 token；真实 native HTTP 测试三代理、取消活动请求及等待，不依赖 browser stubs |
| V-06，AC-03/07/12 | `RemoteBackupPanel.test.tsx`：不出现手填 Secret/回调或安装 CLI 指引；已有应用、无应用、两阶段浏览器等待；关闭重开恢复、错误重试、取消、目标切换迟到事件不污染当前目标；多目的地/代理/备份密码继续有效 |
| V-04/07，AC-04/06 | 真实个人合成 v1/v2/v3 上传同 file_token；当前下载 v3；飞书网页回退 v1 再下载，哈希/实际 manifest/SQL 数据为 v1；暂停跨重启保留，旧 partial 不拼入新版本 |

快速验证沿用 `src-tauri/` 的 `cargo test --lib backup::feishu`，测试落地后再使用准确筛选；前端使用 `pnpm test -- src/components/settings/RemoteBackupPanel.test.tsx` 和本地 BackupSettingsPanel/backupStore 相关回归。稳定输入后统一 `pnpm build`、`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 和必要 native 构建，已有无关编译失败记录实际影响，不假称通过。

Windows 当前端：真实 Tauri、隔离 app-data、专用合成云备份目录；先原生复用已有 CLI App ID/Secret，再完成 Taomni 设备授权/上传/网页回退/恢复。通过只读元数据确认同 appId、没有额外注册、CLI 配置未改，单独检查原 CLI 授权仍可用。凭据和 token 的证据只记录状态/哈希，不展示内容。

无应用路径用没有配置的隔离测试来源和 Taomni credential 命名空间，确实完成应用注册并留 App ID/原生协议证据；不能通过隐藏真实配置后误改用户配置。每次仅一个 session，不反复创建应用。个人首次注册成功尚未有本方案的真实证据，服务端兼容性需在这一步确认。企业真实测试仍按用户要求暂不执行，保留管理员策略拒绝等 mock/文档检查。

macOS 接续：WKWebView、真实 CLI 加密文件与 Keychain 读取权限、Taomni 独立 Keychain 保存、系统浏览器授权/重启；Linux 接续：WebKitGTK、CLI 文件兼容读取与 Secret Service 保存、无可用存储失败、原生网络。三端 cfg/依赖代码兼容本轮审查，缺设备保持未实测，不能推导通过。

仍需实证的技术边界是注册/设备接口被 Rust 客户端接受、同应用新用户授权对原 CLI 的影响、应用可申请的实际 scopes、三端凭据读取权限和版本覆盖/下载稳定性；这些是验证任务，不再是等待用户选择 CLI 安装或管理员 Secret 的设计决策。若新证据使已定流程不可用，再带实际问题与可比较替代方案讨论。
