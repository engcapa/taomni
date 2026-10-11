# 企业飞书应用与本机凭据边界

日期：2026-10-11。当前首期采用[原生飞书连接](feishu-native-auth-design.md)，关联主设计 DEC-14。本文保留企业应用/Secret 的事实与取舍，不再把管理员分发密钥或企业网关当作待选产品前置步骤。企业真机测试按用户要求暂不执行。

## 当前用户体验

个人/企业统一：Taomni优先复用已保存连接；没有绑定时读取本机已有 CLI 应用并取得 App ID/Secret；没有应用时参考官方注册设备流程，在浏览器确认后取得凭据。随后按完整备份 scopes 授权用户，Rust直接调用 Drive。无需安装 CLI、复制密钥、配置回调，也没有管理员输入 App ID/App Secret 的 Taomni 入口。

CLI 的安装向导已经证明“用户没有维护过 Secret”可以成立：程序自动注册并保存，浏览器用户只完成确认。[官方 CLI 指南](https://open.feishu.cn/document/mcp_open_tools/feishu-cli-let-ai-actually-do-your-work-in-feishu) 同时说明应用管控仍遵循企业规则。因此无需管理员提供密钥，不等于企业的任何注册/授权策略都可被绕过。

本机与企业机器已有配置的 App ID 不同，表示不同应用；不能把两台机器的体验解释为一个公共隐藏应用。Taomni复用已有应用时不再创建；新建与重新注册是明确动作，常规定时备份、刷新和增加使用同一连接的目的地不应产生更多应用。

## 应用、用户与设备三层隔离

| 层 | 身份/控制 | 备份语义 |
|---|---|---|
| 应用 | App ID/Secret；可以由原生注册取得，也可以复用已有 CLI 应用 | 应用级 Secret 可能属于共享应用，不是某个用户专属的文件密码 |
| 用户连接 | Taomni自己获得的 user/refresh token、飞书返回的用户/租户、granted scopes | 文件访问依赖用户授权和 ACL；不用管理员 token 或 bot token 替代 |
| 设备/目的地 | 本机 device UUID、target UUID、目录/file token、代理、独立备份密码 | 同用户多设备分目录；恢复别的设备数据不覆盖本机身份和凭据；每目标可选择不同代理 |

多个目标可以复用同一 Taomni connection，共享令牌时按 connection 串行刷新；应用初始化按本机锁去重。不同企业用户使用自己的连接；共享目录的读取由飞书 ACL 决定，目录名称本身不是访问隔离。不同应用下的 open_id 不同，不据此拒绝同一云盘下的跨设备目录恢复。

Taomni只导入所选应用的 App Secret，之后存在自己的系统凭据库；不读取/复制 CLI用户 token，不写 CLI配置或令牌。原生 Taomni 授权后已用 CLI user 身份只读获取云盘清单成功；此项证明当前 CLI 会话仍可用，不能据此推断所有 CLI 功能或长期刷新均已验证。

## 密钥保护与终端边界

App ID 是公开标识；App Secret 是应用共享凭据。系统凭据库保护静态存储及部分跨用户访问，不能保证控制终端的用户/管理员绝对无法从可使用该 Secret 的程序中提取它。自动注册、加密保存或换用 Rust 都不会消除这个边界。

Taomni的新 Secret/令牌使用现有 keyring，不进入 React、普通配置、命令参数、环境变量、日志、遥测、备份包或配置导出；IPC只返回已连接/缺权限/脱敏应用等元数据。凭据库不可用或锁定时明确失败，不静默改用明文。恢复后的业务 vault 密码和独立备份密码各有职责，不用于代替飞书应用 Secret。

已有 CLI存储读取是只读兼容：Windows DPAPI注册表、Linux AES-GCM文件，以及 macOS AES-GCM文件+Keychain主密钥；若 CLI已经使用文件 fallback，可按源码读既有数据，Taomni不执行降级。具体格式、核对版本和错误路径见[原生连接设计](feishu-native-auth-design.md)。

应用 Secret 轮换会影响持有该应用凭据的程序。首次导入记录来源/appId，invalid_client 首期提示修复凭据/重新连接；自动对相同 App ID 重新读取来源留作待办；来源 App ID变化不能自动切换账户。Taomni断开仅移除本机授权和绑定，不删除云备份或自动删除可能被 CLI/其他设备复用的应用。不能保证清理本地 token 已撤销服务端 token；后续服务端 revoke 若实现，范围和可用协议需验证。

## 企业限制出现时

首期按照官方注册/授权流程处理个人和企业，不提供特殊“绕过管理员”模式。企业允许时，用户可自助连接；策略阻止时展示服务端安全错误与重试/取消入口，不反复新建应用，不增加手工 Secret表单。

如果企业禁止应用 Secret落员工终端，这与“像 CLI一样让本机程序持有/使用 Secret”的当前方案存在实质冲突。此时带实际限制和替代方案与用户讨论，不能假称原生方案已满足。企业真机测试当前暂停，该限制不是对本次用户企业配置的实测结论。

## 历史方案的事实，首期不采用

| 历史路径 | 事实与限制 |
|---|---|
| 管理员向每台终端配置统一应用 Secret | 普通用户无需自己创建应用，但共享 Secret仍落终端，一台泄露可能影响整个应用；当前取消该入口 |
| 企业后端代办 OAuth/刷新 | 可把 Secret留服务器，每用户单独授权；需要服务身份绑定、凭据托管与维护，当前不新增该服务 |
| Taomni官方统一应用+授权网关 | 用户认为复杂，已明确暂不采用 |
| 直接使用 PKCE消除普通应用 Secret | [OAuth v3 文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3) 声明普通开放平台应用为 Confidential Client、Public Client未开放普通注册；PKCE本身不能消除 Secret |

飞书提供授权页、token签发/刷新和企业应用管理。此前公开认证/网页登录/aPaaS/MCP索引研究未找到面向任意自建应用、直接代替桌面端保管 Secret的通用托管授权服务。该结论限于公开材料，不排除另行企业合同能力；但当前原生方案不需要部署这样的服务。

具体实施与验证责任沿用 TASK-02/03/05/06 和 V-03/04/06/07；应用自助注册、实际 scopes、旧 CLI会话影响及三端 Secret兼容读取仍是待验证项。本轮原生实现已替换 loopback 草案，当前已测和未测项见 [实现记录](implementation-status.md)。
