# Mobile P1 飞书适配器实现与验证

本次独立评审逐项核对、修复与新提交证据见 [评审处置记录](mobile-feishu-p1-review-resolution.md)。

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

Headless 可加 `--feishu`；从当前数据目录读取同一配置。headless 不提供 vault 解锁手段，当前必须通过进程环境 `TAOMNI_FEISHU_APP_SECRET` 提供密钥；未提供时输出明确错误，不尝试读取锁定引用。密钥不通过命令行参数传递；环境变量对同用户的其他进程可能可见（例如 Linux /proc），应仅在受控服务账户下提供。

## 指令与通知

私聊中 `/taomni` 前缀可省略；群聊仍须以 `/taomni` 独立记号开头，不带前缀的群消息不回复。前缀与英文指令不区分大小写（兼容手机首字母自动大写）。任意 Unicode 空白（含输入法全角空格 U+3000、制表符、换行）都作为分隔并折叠为一个 ASCII 空格，指令正文和文件路径中的连续空白也遵循此规则。单独发送 `/taomni` 返回帮助；私聊中无法识别的文本回复一句“发送‘帮助’查看可用指令”。

| 私聊输入（群聊加 `/taomni ` 前缀） | 英文形式 | 行为 |
| --- | --- | --- |
| `帮助` | `help` | 查看命令与短 id 用法 |
| `列表` | `list` | 会话列表卡片：编号、短 id、标题、状态，每项带按钮 |
| `查看 <id>` | `show` | 详情卡片：摘要、状态、待确认点及最近一条 Agent 结果（隐藏内容保留隐藏标记），仅私聊 |
| `文件 <id> <相对路径>` | `file` | 仅私聊且设置显式开启后可用，受文件根与敏感路径约束的文本快照 |
| `发送` / `继续 <id> 后续指令` | `send` | 对现有 Agent 线程发起新轮次，不附桌面上下文 |
| `停止 <id>` | `stop` | 停止当前轮次 |
| `同意` / `批准 <id> <确认id>` | `approve` | 同意支持透传的当前确认点 |
| `拒绝 <id> <确认id>` | `reject` | 拒绝支持透传的当前确认点 |

**短 id。** 列表中的短 id 固定为 `thread:` / `term:` 之后的前 8 个字符（不足 8 字符则全部显示）。所有带 id 的指令接受：完整 id、`thread:<前缀>` / `term:<前缀>`、或至少 4 个字符的裸前缀，全部按当前 `session_view::list` 结果解析。精确匹配优先于前缀匹配；匹配到多个时报错并列出最多 5 个候选（短 id · 标题及 thread/term 类型），需要补充更多字符或完整 id；包括带类型前缀在内的 id 无匹配时均给出未找到错误，裸前缀不足 4 字符时明确拒绝。不按列表序号解析：`list` 与后续指令之间列表顺序可能变化，序号可能指向错误线程。卡片已携带完整 id，执行时必须仍有精确匹配；过期卡片不能退化成前缀并操作另一个会话。

后续指令/停止/确认只允许 `thread:`，在短 id 解析之后检查（前缀解析到终端时同样拒绝）；不提供 PTY 输入，不创建会话。并发轮次、桌面专属 provider、已解决或错线程确认点仍由原有服务拒绝。等待确认时发送卡片，支持透传的确认点提供同意/拒绝按钮，其他确认点显示“需在桌面确认”。完成、失败、停止仅由轮次收尾发布一次，按 task_id + turn_id 生成稳定通知身份；对空闲线程的停止不通知。

**会话链接。** 配置 Mobile Web 地址后，单个会话的链接为 `<地址去掉末尾 />/#/session/<encodeURIComponent(完整会话 id)>`，例如 `https://pc.example:8443/#/session/thread%3Aabc123`；与 Mobile Web 路由约定一致。列表/详情卡片的“打开手机页面”按钮、详情卡片与确认卡片中的 `Mobile Web：` 文本行、任务完成/失败/停止通知都使用该会话链接；帮助、文件、错误等其他文本回复仍追加 Mobile Web 首页地址。

**卡片按钮。** 列表与详情回复为 `interactive` 卡片（与确认卡片相同的消息卡片格式，文本均为 `plain_text`）。每个会话的按钮：

- `查看`（详情卡片上可再次查询以刷新内容）：回调值 `{"action":"show","task_id":"<完整 id>","p2p_chat_id":"<发送卡片的私聊 chat_id>"}`。只在发往私聊的卡片上出现；回调的 `context.open_chat_id` 必须等于 `p2p_chat_id` 才算私聊查询，转发到其他会话或群聊的卡片按非私聊处理并拒绝内容查询。
- `停止`：回调值 `{"action":"stop","task_id":"thread:<id>"}`，只对状态为运行中/待确认的 `thread:` 会话显示，点击前有飞书二次确认弹窗。
- `打开手机页面`：URL 按钮，仅在配置 Mobile Web 地址时显示。
- 详情卡片对每个支持透传的确认点（最多 5 个）另给同意/拒绝按钮，回调值沿用确认卡片的 `{"task_id","confirmation_id","decision"}`，原有确认卡片的值与行为不变。

`card.action.trigger` 按回调值是否含 `action` 字段区分新动作与原有 `decision`（字段存在但不是合法字符串也拒绝）；新动作只接受 `show`（`thread:` / `term:`）和 `stop`（仅 `thread:`），`task_id` 必须为单个无空白记号且不超过 256 字节，其他动作一律拒绝并计入拒绝数。新动作与确认按钮共用同一身份白名单（open_id + chat_id）、事件时间窗口、按 event_id 的去重登记，以及 `show`/`file` 仅限私聊的规则。

正文按 Unicode 字符截断至 1200 字并标注，追加可选 Mobile Web 链接；文本消息发送层总上限 2000 字。卡片沿用 1200 字可见正文预算（列表按各行合计计算，超出时提示“[已截断] 仅显示前 N 个”，最多 20 行），所有可见文字（含标题、按钮及链接行）合计不超过 2000 字，并保证卡片 JSON 编码进请求体后不超过 28 KiB（飞书卡片请求体上限 30 KB）；列表超出时从末尾减少会话行，详情/确认元数据异常大时返回带截断提示的有界卡片，不发送超限 JSON。文件继承 P0 的大小、二进制和越界路径限制。

停止适配器时尝试发送“已停止，实例可能离线”通知（最多等待 3 秒）。进程崩溃、断网或主机断电时，本实例无法经失效网络立即通知自己的离线状态；完整离线告警需要独立在线监测服务，当前未实现，不能声明满足 AC-17 的全部掉线场景。

## 协议、生命周期与边界

- HTTP：官方 `tenant_access_token/internal`、`im/v1/messages`；缓存 token，失效后下次有界重试刷新。WS bootstrap 使用 `/callback/ws/endpoint`，只信任 `wss://*.feishu.cn`。生产不能注入任意平台端点；loopback 注入仅测试可用。
- 二进制 protobuf 帧沿用官方 SDK 字段编号；心跳、pong 超时、重连退避 1/2/5/10/30 秒，健康连接 60 秒后重置退避。
- 收帧、最多 4 个独立命令任务、状态订阅与 HTTP 发送分别运行，输入队列 64、输出队列 128。文件变化不进入飞书状态队列；Lagged 时从任务状态快照对账并按轮次去重。回调在授权及去重登记后确认受理，不等待 Agent 完成。HTTP 每条最多 5 次尝试（4 次重试），使用同一 UUID；最终失败、队列满、事件缺口写入设置中的最近一次错误（后续错误会覆盖），计数独立保留。
- 分片最多 64 片、256 KiB、16 个未完成消息，5 秒过期；不接受未支持的编码。单帧分片/编码/JSON 错误返回失败应答并累计拒绝，不断开整条连接。
- 除 TLS 验证外再校验 app_id、用户 open_id、会话 chat_id、事件时间。按时间数量级同时接受毫秒与微秒；接受最近 10 分钟事件，未来偏差最多 1 分钟。拒绝事件记日志但不记录内容或凭据。
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
- 凭据库修复 `10e73c6d` 的三平台 browser/native 与完整 `crash-regression` 在 [41260611701](https://github.com/engcapa/taomni/actions/runs/41260611701) 最终通过；selection、raw summary、receipt 和 aggregate 核对结果见下表。
- 旧轮次 Linux Chromium 安装在 `apt-get update` 的 Azure HTTP 镜像索引停留超过 20 分钟。`ci_linux_setup.sh` 原有 HTTPS 镜像准备发生在 Chromium 步骤之后；已让 Chromium 安装先调用同一 `prepare_apt_mirrors`，并加 15 分钟步骤上限。镜像 helper 的 5 项 shell 行为测试通过，YAML 解析和 refactor 检查通过。未修改用例断言或减少选择范围。
- Linux 追加轮次 `41261967252` 仅选 native，规划被完整 crash-regression 中仅支持 browser 的用例拒绝，未执行用例；保留此失败，不算通过证据。改为 browser/native 后，[41262327253](https://github.com/engcapa/taomni/actions/runs/41262327253) 在提交 `d813defe2641d910d4cc1e01f09831c6830f3bac` 成功：browser 10/10、native 12/12，0 failed、0 skipped；Rust 契约 41/41。已下载原始 artifacts 并用 `qa_ui_auto.ci report` 独立复核 selection、receipt、源码/用例/runner/QA binary 身份与汇总，`passed=true`、`report_ok=true`，无基础设施错误或缺失用例。报告位于 `qa-ui-auto-report/github/41262327253/`。
- 补充本机 browser 审阅截图：使用全新隔离浏览器上下文，经首次凭据库设置、保存、关闭并重开 Settings，再截图完整飞书配置区；确认 App ID 保留、密钥框为空，运行时错误为 0。此截图不替代 native 或真实飞书消息证据。
- 私聊免前缀与中文别名、短 id、会话链接与列表/详情卡片按钮：`CARGO_TARGET_DIR=/data-raw-ssd/code-src/person/taomni/src-tauri/target cargo test --lib mobile::` 50/50 通过（新增 `commands_tests`：前缀/别名/Unicode 空白折叠/群聊规则、固定 8 字符显示、短 id 唯一/歧义/未找到/过短、解析后的线程限定；`cards_tests`：encodeURIComponent 等价编码、列表/详情/确认卡片 JSON、文本与大小预算、show/stop 回调解析与未知动作拒绝、转发卡片不算私聊、过期卡片不重定向、通知链接）。既有真实 loopback HTTP/protobuf WS 用例扩展为接收免前缀中文列表、点击实际输出的查看按钮、回调重复去重、短 id 后续轮次和 stop 回调取消真实轮次，原有 approve/reject、重连与重试继续通过。真实飞书客户端对卡片 `note`、`danger` 按钮二次确认弹窗与 URL 按钮的渲染，以及新回调的实际到达，同属下一条 V-08 未验证项；本轮未启动 GitHub 流程，也未取得匹配当前提交的 browser/native crash-regression 证据，历史 CI 不替代本轮验收。
- V-08 真实飞书账号、应用发布、实际通知与卡片到达、只允许出站的网络环境：未验证。开发期间未向真实飞书发送消息，也未搜索/使用个人凭据。AC-17 当前为部分实现，不能标记全部验收完成。
- P0 真机、相机/PWA 安装、公共 TLS/PNA 的既有验证缺口不因本次测试自动补齐。

### P1 评审前的三平台自动化证据

运行 `41260611701`，被测提交 `10e73c6de41cf036fdc6918dca1fd13e7d8df771`。显式选择 `TC-MOBILE-001,TC-MOBILE-002,TC-MOBILE-003,TC-MOBILE-004`，workflow 合并完整 `crash-regression`，native 使用匹配源码的隔离 QA release。

| 平台 | browser | native |
| --- | --- | --- |
| Linux | 10/10 通过 | 12/12 通过，含 TC-MOBILE-002/003/004 |
| Windows | 10/10 通过 | 10/10 通过，含 TC-MOBILE-004 |
| macOS | 10/10 通过 | 10/10 通过，含 TC-MOBILE-004 |

共 **62/62 通过、0 failed、0 skipped**。Linux Rust 契约 41/41（含 mobile 18 项），Windows capture helper 契约 26/26。已下载 selection、逐例报告、截图、原始 receipt、QA build identity 和 hosted `ci-summary.json`；在本机用 `ci_collect.py` 与 `qa_ui_auto.ci report` 重新汇总，分组计数和三平台 binary hash 与 hosted 汇总完全一致。`passed=true`、`report_ok=true`，无基础设施错误、缺失用例或未审用例。

报告位于 `qa-ui-auto-report/github/41260611701/`，GitHub Actions artifacts 同步保留。产品源码指纹 `647acb54ac86ea5a5e73f77646b224d4aec6823e135bda8533f04c10570a1bae`，runner 指纹 `9af9d8af84dd9fcef6837d1dcd6c12e5a0a18d98094eaa8b4aff8b06498acfa0`。镜像修复后追加运行 `41262327253` 的产品/runner 指纹与本轮一致，Linux 22/22 再次通过；本次证据与截图收尾不修改产品、用例或 runner。

## P1 之后的建议任务

以下为 2026-11-01 用户要求整理的候选工作顺序，不表示原设计已经定义 P2，也不在本轮自动启动这些产品变更。P1 已取得上述 CI 通过证据；真实飞书 V-08 仍须单独完成，独立离线告警也尚未实现。

| 顺序 | 后续工作 | 具体交付与验收边界 |
| --- | --- | --- |
| 1 | 移动端专项验收补齐 | Android/iOS 真机 PWA、相机扫码、剪贴板、后台恢复；公共 TLS/PNA；Windows/macOS 移动服务的配对、吊销、PTY 单写权和尺寸复原。保留平台实测证据，浏览器 stub 不代替 native/真机。 |
| 2 | IM 可靠送达 | 持久化待发送通知、应用重启恢复、可追踪的失败重试。模拟断网/限流/崩溃，明确受理与执行状态；不得把现有至多一次登记宣称为保证执行。 |
| 3 | 飞书交互与绑定引导 | 群聊 @ 指令、获取/确认身份绑定的本机引导、实例标识。默认拒绝未授权身份；若允许单应用多实例，须先设计明确路由，不能依赖官方随机集群分发。 |
| 4 | 独立离线告警 | 另行设计独立监测端，覆盖断网、进程崩溃与主机关机。验收告警延迟和恢复通知；本实例主动停止通知不能替代独立离线检测。 |
| 5 | 微信官方渠道决策 | 比较企业微信与服务号的接收事件方式、审批回调、权限、部署与成本；确定一个明确方案后再开发，不实施个人微信自动化。 |

headless 新建终端、原生壳/应用商店、内置中继不自动纳入这些任务。原设计对前者要求另行决策，后两者当前不在范围内。

## 评审后身份与内容发送决策

IM 主体由 TLS 长连接、app_id + open_id/chat_id 绑定和时间窗口鉴权，独立于 Mobile Web Bearer 设备；吊销 Web 设备不吊销飞书。设置中的“停止飞书连接”立即停用全部飞书动作，修改/删除绑定后重新启动可单独撤销主体。未暴露 webhook，不存在未签名的入站回退。

`show` 最近助手结果仅私聊返回；`file` 默认关闭，须显式开启“允许私聊查询任务目录内的文件内容”。两者都发送到飞书服务器，设置页明示数据流向。群聊仍可接收任务摘要/确认工具名与通知，但不能查询完整助手结果或文件内容。真实飞书 V-08 必须验证实际卡片按钮可作答、时间单位、私聊内容授权和重复通知数量。
