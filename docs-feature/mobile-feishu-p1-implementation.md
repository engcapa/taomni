# Mobile P1 飞书适配器实现与验证

关联：[设计 TASK-07 / AC-17 / V-08](mobile-remote-p0-design.md)。
分支：`feat/mobile-feishu-p1`，基于 P0 验收提交 `21620700`。

## 交付范围

企业自建应用使用出站 WebSocket 长连接接收消息和 `card.action.trigger` 回调；发消息使用官方 HTTP OpenAPI（不是在 WebSocket 上发送聊天消息）。不需要公网入站端口。复用 P0 `session_view`、`agent_view`、`file_view`，不另建 Agent/PTY 执行协议，也不绕过原有确认点、文件根目录和轮次互斥。

设置 → 搜索 `feishu` / `飞书` → 移动服务内配置。先开启移动服务，再启动飞书连接；保存凭据不会启动连接。关闭 Settings 继续运行，停止移动服务会停止飞书。每个实例配置独立飞书应用：官方长连接为集群分发，同一个应用连到多个实例时，事件不保证发往用户想操作的实例。

配置步骤：

1. 在飞书开发者后台创建企业自建应用并启用机器人。
2. 事件订阅选择长连接，订阅 `im.message.receive_v1`；卡片回调订阅选择长连接，订阅 `card.action.trigger`。
3. 授予 `im:message:send_as_bot`、`im:message.p2p_msg:readonly`，发布应用并让测试用户可见。当前命令以私聊为首选；群消息须额外授予对应接收权限，`@机器人` 文本前缀尚未适配。
4. 设置 App ID、App Secret 和 `open_id chat_id` 白名单，每行一组；最多 32 组。身份必须与会话同时匹配。通知发往这些会话，群成员即使无操作权限也可见通知。
5. 填可从手机访问的 Mobile Web 地址（可选），选择应用代理 / 独立代理 / 不使用代理，保存后启动连接。

App Secret 保存在加密 vault；首次使用或锁定时通过现有按需弹窗初始化/解锁，完成后自动继续保存，取消保留输入。`mobile-feishu.json` 仅保存密钥引用。密钥不回传前端，不进入 Mobile Web。配置修改必须先停止适配器。独立代理重用 Settings 代理编辑器与后端严格解析，不修改应用代理；不使用代理显式绕过环境/系统代理，配置代理失败不自动直连。

Headless 可加 `--feishu`；从当前数据目录读取同一配置。可通过进程环境 `TAOMNI_FEISHU_APP_SECRET` 临时提供密钥，或使用已解锁 vault 中的引用；不通过命令行参数传递明文密钥。未提供可用凭据时显式报错，不擅自解锁 vault。

## 指令与通知

| 私聊输入 | 行为 |
| --- | --- |
| `/taomni help` | 查看命令 |
| `/taomni list` | 最多 20 项会话摘要 |
| `/taomni show thread:<id>` | 当前摘要、状态、待确认点及最近一条 Agent 结果（隐藏内容保留隐藏标记） |
| `/taomni file thread:<id> <相对路径>` | 受原文件根目录约束的文本快照 |
| `/taomni send thread:<id> 后续指令` | 对现有 Agent 线程发起新轮次，不附桌面上下文 |
| `/taomni stop thread:<id>` | 停止当前轮次 |
| `/taomni approve thread:<id> <确认id>` | 同意支持透传的当前确认点 |
| `/taomni reject thread:<id> <确认id>` | 拒绝支持透传的当前确认点 |

后续指令/停止/确认只允许 `thread:`；不提供 PTY 输入，不创建会话。并发轮次、桌面专属 provider、已解决或错线程确认点仍由原有服务拒绝。等待确认时发送卡片，支持透传的确认点提供同意/拒绝按钮，其他确认点显示“需在桌面确认”。完成、失败、停止发送状态通知。

正文按 Unicode 字符截断至 1200 字并标注，追加可选 Mobile Web 地址；发送层总上限 2000 字，确保合法配置的链接不被正文截掉。文件继承 P0 的大小、二进制和越界路径限制。

停止适配器时尝试发送“已停止，实例可能离线”通知（最多等待 3 秒）。进程崩溃、断网或主机断电时，本实例无法经失效网络立即通知自己的离线状态；完整离线告警需要独立在线监测服务，当前未实现，不能声明满足 AC-17 的全部掉线场景。

## 协议、生命周期与边界

- HTTP：官方 `tenant_access_token/internal`、`im/v1/messages`；缓存 token，失效后下次有界重试刷新。WS bootstrap 使用 `/callback/ws/endpoint`，只信任 `wss://*.feishu.cn`。生产不能注入任意平台端点；loopback 注入仅测试可用。
- 二进制 protobuf 帧沿用官方 SDK 字段编号；心跳、pong 超时、重连退避 1/2/5/10/30 秒，健康连接 60 秒后重置退避。
- 收帧、业务执行和 HTTP 发送分别轮询，输入队列 64、输出队列 128。回调在授权及去重登记后确认受理，不等待 Agent 完成。HTTP 每条最多 5 次重试，使用同一 UUID；最终失败、队列满、事件缺口在设置中可见。
- 分片最多 64 片、256 KiB、16 个未完成消息，5 秒过期；不接受未支持的编码。
- 除 TLS 验证外再校验 app_id、用户 open_id、会话 chat_id、事件时间。消息时间为毫秒，卡片回调时间为微秒；接受最近 10 分钟事件，未来偏差最多 1 分钟。拒绝事件记日志但不记录内容或凭据。
- 消息按 `message_id` 去重（官方明确不能只用 event_id）；卡片按 event_id 去重。现有实例数据库 `mobile_feishu_events` 保存 SHA-256 键，保留 24 小时、最多 10000 项。登记在执行之前完成，重连/重新启动不会重放已受理动作；若登记后进程崩溃，该动作可能不执行，语义为至多一次受理，并非持久任务队列或保证送达。
- Runtime 拥有连接和发送任务，关闭设置不会取消。显式停止取消全部 worker，再尽力发送停止通知。不保证退出时排空未送队列。
- 不暴露入站 webhook：长连接支持卡片回调，无需不带签名校验的 fallback。个人微信无官方 Bot API，本次决定不实现个人微信自动化；企业微信/服务号需独立设计与授权，不计入本次飞书交付。

`commands/mod.rs` 原有超 800 行分发器本次缩小：移动命令 allowlist 与生成 handler 由小型 `commands/mobile.rs` 同时拥有。契约检查增加对此显式 predicate 的解析，仍逐条校验注册、缺失、重复与错误路由，不豁免任何移动命令。适配器按配置、协议、网络、动作、worker、Settings 和测试拆分，各文件小于 800 行。

## 官方依据

2026-11-01 查询官方文档和 `larksuite/oapi-sdk-go` 的 `ws` 实现：

- [长连接](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md)
- [卡片回调订阅方式](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address.md)
- [接收消息与去重](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)
- [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create.md)
- [tenant token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal.md)
- [卡片回调字段](https://open.feishu.cn/document/feishu-cards/card-callback-communication.md)
- [官方 Go SDK 协议实现](https://github.com/larksuite/oapi-sdk-go/tree/main/ws)：`pbbp2.pb.go`、`model.go`、`client_message.go`、`client_session.go`、`client_transport.go`。

检索副本位于忽略目录 `qa-ui-auto-report/_local/feishu-p1/`。长连接支持卡片回调，已解除原设计待核实项；真实应用能否按具体租户权限/发布状态工作仍需 V-08。

## 验证记录

本机 Linux：`pnpm build` 通过（含 `check:refactor`）；初轮相关 Settings Vitest 10/10 通过；凭据库修复后含 vault gate 的相关测试 16/16 通过；`cargo test --lib mobile::` 18/18 通过（含最近结果查询复测）。静态 `audit --gate` 与 native dry-run 通过；dry-run 不算 native 执行证据。

初轮实际 browser：`qa-ui-auto-report/feishu-p1-browser/run-20261101-084505-771164808`，TC-MOBILE-001、TC-MOBILE-004 共 2/2 通过，0 失败、0 跳过；004 确实关闭并重新创建 Settings 标签，非重复激活原标签。截图：[保存后重开](mobile-feishu-p1/settings.png)。修复按需解锁后，TC-MOBILE-004 在 `run-20261101-091406-971275306` 再次通过，实际完成首次凭据库弹窗和自动续存。

- `TC-MOBILE-004`：全局设置入口、非法身份拒绝、独立代理编辑、密钥保存后清空、关闭/重新打开 Settings 后配置恢复，移动服务未开启时不能启动。browser 为 renderer stub；native 使用隔离 QA vault 和真实 IPC/磁盘配置。
- `mobile::im_adapter` Rust fixture：真实 loopback HTTP 与 protobuf WebSocket，token/消息、心跳、断线重连、重复事件、越权、确认卡片映射到真实 oneshot、发送重试 UUID、真实 Agent 后续轮次及停止、不允许 PTY、文件快照/截断/链接、配置与持久去重。
- GitHub 首轮 `41258283715`：触发参数误用了短 SHA，checkout 失败，未执行用例；改为完整 SHA。
- GitHub `41258424343`：初轮 browser 三平台各 10/10，Linux Rust 契约 41/41；Linux native TC-MOBILE-004 保存凭据返回 `VAULT_LOCKED`。原来的 `vault_first_run` 在主界面可见时直接返回，不能证明按需凭据库已经初始化；浏览器 stub 又缺少此状态检查。已复用现有 vault gate，新增解锁续存/取消保留回归，YAML 改为实际初始化弹窗，stub 同样拒绝锁定状态。本轮不能计为通过（即使个别 shard job 为绿色）。
- 修复后的三平台 browser/native 与完整 `crash-regression` 正待重新执行；最终记录核对 selection、raw summary、receipt 和 aggregate。
- V-08 真实飞书账号、应用发布、实际通知与卡片到达、只允许出站的网络环境：未验证。开发期间未向真实飞书发送消息，也未搜索/使用个人凭据。AC-17 当前为部分实现，不能标记全部验收完成。
- P0 真机、相机/PWA 安装、公共 TLS/PNA 的既有验证缺口不因本次测试自动补齐。

## P1 之后的建议任务

以下为 2026-11-01 用户要求整理的候选工作顺序，不表示原设计已经定义 P2，也不在本轮自动启动这些产品变更。P1 自身须先取得当前 CI 通过证据，并单独完成真实飞书 V-08。

| 顺序 | 后续工作 | 具体交付与验收边界 |
| --- | --- | --- |
| 1 | 移动端专项验收补齐 | Android/iOS 真机 PWA、相机扫码、剪贴板、后台恢复；公共 TLS/PNA；Windows/macOS 移动服务的配对、吊销、PTY 单写权和尺寸复原。保留平台实测证据，浏览器 stub 不代替 native/真机。 |
| 2 | IM 可靠送达 | 持久化待发送通知、应用重启恢复、可追踪的失败重试。模拟断网/限流/崩溃，明确受理与执行状态；不得把现有至多一次登记宣称为保证执行。 |
| 3 | 飞书交互与绑定引导 | 群聊 @ 指令、获取/确认身份绑定的本机引导、实例标识。默认拒绝未授权身份；若允许单应用多实例，须先设计明确路由，不能依赖官方随机集群分发。 |
| 4 | 独立离线告警 | 另行设计独立监测端，覆盖断网、进程崩溃与主机关机。验收告警延迟和恢复通知；本实例主动停止通知不能替代独立离线检测。 |
| 5 | 微信官方渠道决策 | 比较企业微信与服务号的接收事件方式、审批回调、权限、部署与成本；确定一个明确方案后再开发，不实施个人微信自动化。 |

headless 新建终端、原生壳/应用商店、内置中继不自动纳入这些任务。原设计对前者要求另行决策，后两者当前不在范围内。
