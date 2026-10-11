# 飞书备份授权：源码事实与方案取舍

日期：2026-10-11。当前生效方案是 [原生飞书连接](feishu-native-auth-design.md)，关联主设计 DEC-14/15。本文件保留外部接口和源码研究结论；企业真实账号测试按用户要求暂不执行。

## 当前方案

Taomni 用 Rust 参考官方 CLI 的备份场景必要逻辑，不打包、安装或调用 lark-cli。连接时优先复用 Taomni 已保存应用；其次读取本机已有 CLI 应用配置，按源码解引用选中 App ID/Secret；没有应用时原生发起官方注册设备流程。两条路径都取得应用凭据，随后在浏览器申请完整备份 scopes；Taomni 持有自己的 user/refresh token 并直接调用 Drive。

该选择由用户明确指定，替代此前“外部 CLI provider + 安装指引”和“不读取 CLI Secret”的设计限制。现有配置是可选导入来源，不是运行前提。普通用户不填写密钥，不配置 OAuth 回调，也无需找管理员分发 Secret。企业既有管控仍然适用，不承诺任何企业都允许注册/授权。

具体读取格式、协议、连接锁与后台状态、迁移、任务和验证以 [详细设计](feishu-native-auth-design.md) 为准；原生代码已替换旧 OAuth 草案，实际验证范围见 [实现记录](implementation-status.md)。

## 官方 CLI 如何取得应用凭据

参考发布版 v1.0.97，commit 72579c80027c863ca51d5f9affda72a70ab0d8a6；现有配置兼容另核对 v1.0.23。

- [install-wizard.js](https://github.com/larksuite/cli/blob/v1.0.97/scripts/install-wizard.js) 先运行 config show。发现 App ID 则询问是否复用，否则运行 config init --new，之后才询问 auth login；非 TTY 安装只给出后续配置指引。
- [config/init.go](https://github.com/larksuite/cli/blob/v1.0.97/cmd/config/init.go)、[init_interactive.go](https://github.com/larksuite/cli/blob/v1.0.97/cmd/config/init_interactive.go) 将新建应用和使用已有应用分开。新建流程不要求用户复制密钥；已有应用手工配置分支才提供 App ID/Secret 输入。
- [app_registration.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/app_registration.go) 对 accounts.feishu.cn 的 /oauth/v1/app/registration 发 begin（PersonalAgent、client_secret）和 poll，浏览器确认后响应直接返回 client_id/client_secret。
- [login.go](https://github.com/larksuite/cli/blob/v1.0.97/cmd/auth/login.go)、[device_flow.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/device_flow.go) 加载已有配置，用 App ID/Secret 发设备授权及 token 轮询，再存 user/refresh token。auth login 自身不创建应用。
- [notconfigured.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/core/notconfigured.go) 的本地无配置错误提示 config init --new。配置损坏、无应用、已有应用未登录是不同状态；Taomni 必须区分，不能因为任何读取错误就创建新应用。

用户两台机器 appId 分别为 cli_a9663ede3eb9dceb 与 cli_a9633abb1a39dbc6，说明使用不同应用，不能称为共享公共隐藏应用。用户只记得浏览器确认，与安装向导自动注册/保存 Secret 的机制相符；未单独重放两台历史安装过程，不声称已证明具体注册时刻或应用数量去重规则。

## 配置与跨平台凭据格式

[config.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/core/config.go) 保存 apps[]、currentApp、应用元数据；[secret_resolve.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/core/secret_resolve.go) 支持 plain/file/keychain。正常初始化把 Secret 交给服务 lark-cli、account appsecret:<appId>，config.json 保存引用；引用必须与 App ID 匹配。config show 总是输出 ****，并不是实际密钥导出接口。

| 平台 | 官方源码的实际存储 |
|---|---|
| Windows | [DPAPI + 当前用户注册表](https://github.com/larksuite/cli/blob/v1.0.97/internal/keychain/keychain_windows.go)，ciphertext 绑定 service/account entropy |
| Linux | [AES-256-GCM 文件](https://github.com/larksuite/cli/blob/v1.0.97/internal/keychain/keychain_other.go)，主密钥在 master.key，权限限定当前用户 |
| macOS | [AES-256-GCM 文件 + 系统 Keychain 主密钥](https://github.com/larksuite/cli/blob/v1.0.97/internal/keychain/keychain_darwin.go)；v1.0.97 兼容已有 master.key.file，并有降级实现。此前只称“Secret 直接保存于系统 Keychain”不准确 |

[token_store.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/token_store.go) 的用户凭据键为 <appId>:<userOpenId>，值含 access/refresh token、到期时间、scope。[uat_client.go](https://github.com/larksuite/cli/blob/v1.0.97/internal/auth/uat_client.go) 有刷新锁、generation/CAS、存储失败/不确定结果处理。

Taomni 只兼容读取所选应用的 Secret，随后复制到自己的系统凭据库；CLI 的 user token、master key、配置和默认 profile 均不改动。Taomni新凭据沿用工程 keyring，不移植 CLI Linux/macOS 文件降级；系统存储不可用明确失败。复用 Secret 不意味着客户端可以对本机用户保证不可提取。

CLI 的环境凭据 provider 能优先覆盖本地配置，但 Taomni本场景不移植环境 token provider、sidecar 或 Agent workspace。配置路径 override 只用于定位明确的本地来源。未来 CLI 格式变化可能要求更新兼容适配器；公开源码不是稳定的存储 API。

## 注册、用户授权和刷新接口

源码 v1.0.97 的设备授权是 /oauth/v1/device_authorization，token poll 和 refresh 均使用 open.feishu.cn/open-apis/authen/v2/oauth/token；poll 是 form-urlencoded，refresh 是 JSON。不得混用旧分支普通 OAuth accounts v3 的授权码/loopback 实现，也不得把 main 分支机制当该发布版本已具备。

官方认证文档未找到注册/设备码接口的完整独立契约。用户已要求参考必要源码实现，因此把它们集中在小型 Rust 适配器中，以 mock 与真实个人账号核验；协议失败不静默改成 Cookie、CLI 安装或第三方网关。MIT 允许参考/移植源代码；实质移植保留版权/许可证，但许可不构成服务端长期兼容保证。

完整备份 scopes 在详细设计中逐操作列出；不采用 CLI 的全业务域 recommend。新 token 由 Taomni 自己授权和刷新，不能读取旧 CLI refresh token 让两个程序争用轮换凭据。同应用新授权是否影响旧 CLI 会话需要实测，不能仅凭本地独立存储得出服务端隔离结论。

## 方案比较与已被替代的决定

| 路径 | 结论 |
|---|---|
| Rust 最小原生参考实现 | 当前采用；已有应用读取凭据、无应用注册、浏览器完整授权、native Drive |
| 外部已安装官方 CLI + provider | DEC-13 历史方案，已被用户取消；不再提供安装/检测/命令调用作为产品依赖 |
| Go wrapper / 捆绑 CLI | 有[官方嵌入说明](https://open.feishu.cn/document/mcp_open_tools/feishu-cli/embed-feishu-cli-in-agent)与 MIT 源码依据，但用户要求只实现场景逻辑，首期不采用 |
| 管理员逐机提供统一 App ID/Secret | 企业安全边界保留于[企业凭据分析](enterprise-credentials.md)，不作为首期用户入口 |
| Taomni 官方统一应用 + 授权网关 | 用户认为复杂，明确暂不采用 |
| 完全无应用、只申请 API scopes | [普通 OAuth 文档](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token) 仍要求应用身份；未找到独立、长期自动备份契约 |
| 官方个人远程 MCP | [官方说明](https://open.feishu.cn/document/mcp_open_tools/end-user-call-remote-mcp-server) 已标逐步下线、新链接 7 天；[工具集](https://open.feishu.cn/document/mcp_open_tools/supported-tools) 没有普通备份文件覆盖上传闭环，不采用 |
| 只手工网页上传/下载 | 可作单次人工操作，不满足本次后台自动备份；不替代 native provider |

[CLI 官方指南](https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu) 明确自动创建或复用应用，且企业管控继续适用。多用户/多设备各自新建可能产生多个应用；再次备份/刷新不应触发注册。不能宣称 PersonalAgent 对管理员隐藏或按 Taomni 全企业自动去重。不同应用的 open_id 不相等时仍可通过用户授权的同一根目录和 Taomni device UUID 协作，不依赖全局跨应用用户 ID。

## 普通文件历史恢复

2026-10-11 已直连复核[版本列表](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file-version/list)与[下载文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/download)：版本接口的 obj_type 为 docx/sheet；普通文件下载没有 version 参数。没有找到受支持的普通 .taobak/ZIP 指定历史版本下载 API。

采用 DEC-15：正常下载当前版本；用户可以打开飞书文件网页手工回退，再回 Taomni 全新下载当前内容、校验并统一恢复。本机先持久化暂停对应文件的上传，跨设备提示暂停源设备；回退后的新下载不沿用旧 partial/cache。

## 本次证据边界

前期调研仅读取发布源码、配置元数据/Secret 引用类型。本轮原生个人测试已实际读取所选应用的 Secret，但不输出它；企业真实账号未测试。缓存位于 output/feishu-backup-api-research/，源码锁定于 v1.0.97/v1.0.23 子目录。飞书 .cn 文档直连，外网源码按用户研究代理访问；该代理不写入产品。

原生流程仍待 TASK-02/05 实现与 V-03/04/06/07 验证；CLI此前成功上传/网页回退不是 Taomni 原生方案的验收证据。
