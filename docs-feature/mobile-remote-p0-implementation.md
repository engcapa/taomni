# Mobile remote P0 实施与验证

本次独立评审处置与新提交验证见 [mobile-feishu-p1-review-resolution.md](mobile-feishu-p1-review-resolution.md)。2026-11-05 增量开发与新验证见 [离线恢复、数据新鲜度与设置多语言](mobile-recovery-i18n-implementation.md)。以下历史运行只证明其标注的提交。

关联设计：[mobile-remote-p0-design.md](mobile-remote-p0-design.md)。分支：`feat/mobile-remote-p0`。只实施 TASK-01～TASK-06；TASK-07 / AC-17 属于 P1。

## 使用

桌面主导航 Settings → 搜索“移动服务” → 开启移动服务。默认仅监听回环；远程手机需要显式允许局域网，或由用户提供可到达的 HTTPS endpoint。服务不随设置页关闭而停止，不持久化自动开启。填写手机可到达的 endpoint 后生成二维码或一次性码。手机直接打开 endpoint 的根路径即可使用独立 Mobile Web；也可从一个实例的外壳注册另一个实例。互联网访问使用 TLS。HTTPS 页面拒绝 HTTP 实例，HTTP 局域网页面提示扫码、剪贴板和安装能力降级。

```sh
pnpm dev:mobile                  # 仅开发外壳，端口 5001
pnpm build:mobile                # 生成内嵌 PWA，主 build 会自动执行
./taomni --headless --data-dir /path/to/profile --mobile-port 8787
# 需要 LAN 时显式添加 --mobile-lan；默认 127.0.0.1
# 每 5 分钟自动轮换配对码；Unix 可用 HUP 主动轮换，TERM/Ctrl-C 正常退出
# Windows headless 附着父控制台，或创建控制台；Ctrl-C 正常退出
```

同一 profile 的 desktop/headless 模式互斥。headless 不创建窗口、不调用 Tauri Builder、不初始化 GTK/WebView。它可以操作已有持久化聊天线程，P0 不创建线程或终端。终端列表为空是正常能力边界。

## TASK-01～TASK-04 盘点结论

| AC / 责任 | 已核实来源与实现选择 |
| --- | --- |
| AC-02 身份 | `ActiveTerminal` 注册表以不透明后端键索引，前端展示 tabId 另外存在。移动 API 使用 `term:<注册表键>` / `thread:<线程 id>`，不解析工作区 tabId，不合并相同已保存会话。workspace_context 恒为空。|
| AC-03/04 终端 | 本地 PTY、OpenSSH 包装终端与 russh SSH 均在原输出扇出前送入 broker。退出显式标记 exited，关闭移除。桌面 `write_terminal` 和 `resize_terminal` 的输入、广播、Agent 写入、自动 fit 都会抢回；P0 按设计以命令边界为准，不推断用户意图。无法可靠识别 Agent 占用，所有接管统一提示可能打断命令。|
| AC-04 尺寸 | broker 从创建与桌面 resize 记录桌面尺寸。只读输入/resize 被后端拒绝；移动 resize 钳制到 20～300 列、10～100 行。写权按设备和 WS 连接同时归属，同设备多个页面也只有一个持有者。释放、断开、吊销、桌面抢回后恢复桌面尺寸。|
| AC-05 轮次 | `ChatRunRegistry` 的 direct token 和桥接进程 stop 继续复用；新增轮次预留 token 覆盖初始化窗口，桌面与手机共用排他预留。停止幂等，新指令新增历史，不覆盖旧消息。有在途轮次回 turn_in_progress。该互斥同样约束桌面（移动服务未启用时亦然）；桌面显示中文提示且不会回退到 chat_send，也不会留下未落库的乐观消息。预留由 TurnGuard 负责异常/取消清理。|
| AC-05 手机上下文 | 只发送 thread_id/content，不补造 cwd、终端内容、local_terminal_env、bound_session、数据库选中对象或 code_workspace。保留线程自己的 linked_session_id / 历史和 provider。卡片明确提示“由手机发起，未带桌面上下文”。|
| AC-06 CC 权限 | `cc_pending_permissions` 的真实 oneshot 可以透传；只给 Allow / Deny，不给 AllowSession。绑定线程，先到者生效，重复回答 already_resolved。只投影工具名称和确认 id，不发送原始参数。|
| AC-06 ACP / 其他 | ACP 原生 permission request 只投影“需在桌面确认”，不提供按钮；resolve/closed 后清理。副作用工具等待点以 supported:false 投影，解决、取消、超时后清理；消息内的 ActionCard、WebSearchConfirmCard 不代表后端暂停，任务详情明确提示在桌面查看处理。headless 的 CC/Codex/ACP 返回 desktop_required；直连 provider 可作文本对话，任务详情明确标注本轮没有桌面工具。|
| AC-15 文件根 | 在桌面构造的 `AgentThreadContext` 中记住已规范化的本地 code_workspace.repo_root 或可信本地 cwd。远程会话 cwd 不授予本机文件权限。不是 localStorage 的平台工作区定义。重启后需桌面重新提供上下文，否则明确 diff_unavailable。|
| AC-15 diff | 独立只读 Git porcelain status + worktree/cached diff，禁用 external diff/textconv；不调用 loose-file API。非 Git 工作目录 / 无可用根返回 diff_unavailable。文件路径拒绝绝对路径、上跳、反斜杠和符号链接越界；删除文件校验规范化父目录。|
| AC-15 推送 | notify 原生递归监听可信根，推送 file_changed；不依赖终端打开。采用每任务 500ms 合并的粗粒度失效事件，忽略 .git、node_modules、target；异常也合并为失效事件，不逐个文件洪泛。列表、文件与 diff 限 256 KiB，二进制拒绝、超限标 truncated。|
| AC-16 初始化 | headless 初始化 profile lease、session/terminal/server/trust/chat 数据表、notes、vault、MFA、mail 目录、AI context、AppState 及移动 listener。`ModeLease` 解决原 ProfileLease 只取共享锁、不能区分模式的问题。|
| AC-16 不启动项 | 不启动 LSP AppHandle 绑定、GUI local-history、LanChat、本地 servers/tunnels 自启、备份调度、截图/屏幕捕获、桌面 QA bridge 或 SocksCap。退出先停止移动 listener/WS/文件监听，再取消聊天运行句柄。|

## 契约与安全参数

- 默认无监听。health/pair 与静态外壳公开；其余端点 bearer 鉴权，WS 使用 60 秒单次票据并绑定请求 Origin。长 token 只走 Authorization，不进入 URL。
- 配对码随机 122 bits、5 分钟单次有效；token 随机 244 bits，绝对有效期 90 天、闲置有效期 30 天，只持久化 SHA-256 哈希，使用常量时间比较。last_used_at 最多每 5 分钟写盘一次，正常停止也刷新。失败按真实对端 IP 限 5 次/5 分钟，不信任 X-Forwarded-For。来源表最多 1024，表满淘汰最旧条目，设备上限 256、票据上限 1024。成功配对不累计失败。回环对端可能是共享反向代理：无效码仍限流，正确的高熵码不受共享桶封禁；不读取未受信的转发 IP。日志仅记录失败来源/计数，不记录码、token、票据、业务内容或连接字段。
- 两级 CORS：health/pair 回显 Origin；业务端点只放行同源或存在已配对设备的 Origin。不使用 `*`，不以 Cookie 授予 Taomni 权限、不发送 Allow-Credentials；不信任 Forwarded Host。用户自备网关的已有登录 Cookie 仅允许由同源 Mobile Web 请求携带，跨实例请求仍 `omit`；详见 [SLB 配对修复](mobile-cookie-gateway-fix-20261105.md)。吊销最后一个同 Origin 设备后移除该 Origin，后续业务请求在进入 handler 前返回 origin_denied。预检允许携带 Authorization 的传输，拒绝响应回显 Origin 以便浏览器读取固定错误码，绝不返回业务数据；已建 WS 收到 device_revoked 关闭码，页面停止重试并提示重新配对。
- 删除 mobile-devices.json 会使现有设备失效。设备列表保存在实例 profile；WS 票据仅存内存，60 秒单次有效，停止/重新启动即失效。配对码在停止/重新启动时失效。浏览器 token 存 localStorage；界面明确说明其弱于系统密钥库。
- PTY 文字尾部最多 1000 行、512 KiB、单行 16 KiB；增量 UTF-8、CR 覆盖、非法字节替换。单独保留有界原始 chunk 用于 after_seq 续接；缺口 replay + gap。不是屏幕快照，也不承诺 TUI 屏幕精确恢复。
- 事件保留 200 条，超界 resync。PTY 广播队列 512 条，发送超时 10 秒；慢消费者断开后续接。30 秒空闲心跳，90 秒无客户端活动断开。REST/WS 帧输入上限 64 KiB；Agent 指令上限 32768 UTF-8 字节，手机按字节提示，413 映射为指令过大。
- 外壳与哈希静态资源在构建时形成版本化 precache；Service Worker 只缓存公开外壳，不缓存 API、token、终端、文件或 diff。服务入口有 CSP/no-store/nosniff。

## 验证记录

| 设计项 | 具体证据 | 当前结果 |
| --- | --- | --- |
| V-01 | `auth_tests.rs::single_use_expiry_revocation_and_origin_bound_tickets`、`persistence_contains_only_hashes_and_deletion_revokes`、`absolute_idle_expiry_and_stopping_invalidate_credentials`；`service_tests.rs::http_security_cors_revocation_and_listener_shutdown` | 具体新结果见评审处置记录 |
| V-02 | `task_tests.rs::headless_followup_is_a_real_turn_cancellable_and_never_overlaps`、`confirmations_are_thread_scoped_and_first_answer_wins`；TC-MOBILE-002 的保存会话字段投影 | 同上 |
| V-03 | `service_tests.rs::two_viewers_share_real_pty_with_readonly_resize_control_and_replay`；`replay.rs::tests`；`review_tests.rs::exited_replay_and_poisoned_mobile_locks_do_not_break_desktop_output`、`slow_event_consumer_disconnects_and_can_request_a_bounded_resync` | 同上 |
| V-04 | `mobile-web/src/live.test.tsx`、`api.test.ts`、`TaskView.test.tsx`；TC-MOBILE-001；`task_tests.rs::real_git_file_diff_bounds_and_notifications_without_a_terminal`、`review_tests.rs::subdirectory_root_paths_stay_local_and_diff_is_literal` | 自动化覆盖；实际 HTTPS/PNA/手机未验证 |
| V-05 | TC-MOBILE-002 桌面原生服务；TC-MOBILE-003 真实 headless 服务与内嵌 PWA | loopback 已有历史运行；用户自备双 endpoint 未验证 |
| V-06 | `service_tests.rs::http_security_cors_revocation_and_listener_shutdown`；`review_tests.rs::revoked_origin_errors_and_missing_terminal_are_readable_over_the_wire`；鉴权限流/过期测试 | 具体新结果见评审处置记录；真实部署日志抽检未执行 |
| V-07 | TC-MOBILE-003 无 Display；完整 crash-regression browser/native；`review_tests.rs::desktop_shared_mode_and_headless_exclusive_mode_are_mutually_exclusive`、`concurrent_desktop_entry_rejects_before_persisting_and_tools_omit_details` | 具体新结果见评审处置记录 |
| V-08 | `im_adapter/network_tests.rs` 为 loopback 协议与真实 Agent oracle | 真实飞书应用端到端仍未执行，不能以 fixture 替代 |

P0 初轮环境：Node 22.23.4、pnpm 10；Rust 1.98。完整 `pnpm build`（含 check:refactor、Mobile Web 和桌面构建）已通过；Rust `cargo check --lib` 已通过。后续源码变更均重跑受影响检查。P0 初轮移动 Rust 集合为 12 项通过，QA 审计无覆盖倒退，CI 规划与 provenance/crash 选择工具契约 28 项通过。

### GitHub selected 执行

P0 历史验证：[qa-ui-auto-platforms / 41228578529](https://github.com/engcapa/taomni/actions/runs/41228578529)，代码与用例提交 `abfa5e182be180c435e4bb4a8458d15cd425f3b4`。显式选择 `TC-MOBILE-001,TC-MOBILE-002,TC-MOBILE-003`，workflow 合并完整 `crash-regression` 集合，使用匹配源码的独立 QA release。

| 平台 | browser | native |
| --- | --- | --- |
| Linux | 9/9 通过 | 11/11 通过，含 TC-MOBILE-002/003 |
| Windows | 9/9 通过 | 9/9 通过 |
| macOS | 9/9 通过 | 9/9 通过 |

已下载并核对最终 `ci-summary.json`、逐例报告和原始 receipt：共 **56/56 通过、0 failed、0 skipped**；`passed=true`、`report_ok=true`，无 infrastructure errors、未审用例或分组错误。执行期间源码稳定，三平台源码与 runner 指纹一致。分片 job 绿色本身不代表用例通过。原生 Rust 契约 35 项通过（含 12 项 mobile）；Windows capture helper 契约 26 项通过。

报告保存在本机 `qa-ui-auto-report/github/41228578529/`，GitHub Actions artifacts 同步保留 selection、原始报告、截图、receipt 与汇总。产品源码指纹为 `b437d4048073b51e8fb3534f9a55affcdc748305abac75602b1c1c2f3ca1dae1`；本记录与截图的后续提交不修改被测产品、runner 或用例。

前轮失败与修复均保留在 Actions 中：TC-MOBILE-002 在设备吊销尚处于 busy 时点击服务关闭，已改用真实 WebDriver 点击并等待可操作状态；TC-MOBILE-003 的 Chromium 二进制查找受隔离 `XDG_CACHE_HOME` 影响，已固定安装位置并继承 `PLAYWRIGHT_BROWSERS_PATH`；TC-MOBILE-001 在重开实例后早于异步列表加载统计数量，已等待实际会话条目再保留原有精确数量断言。未跳过失败用例或降低断言。

### 手机尺寸截图

- [终端只读与接管界面](mobile-remote-p0/terminal-phone.png)、[Agent 文件与 diff](mobile-remote-p0/agent-files-phone.png)：production Mobile Web + renderer fixture，390×844。
- [真实 headless 服务页面](mobile-remote-p0/headless-phone.png)：源码匹配的 Linux QA release 内嵌页面，390×844；未创建终端的空列表符合 P0 能力边界。

未验证：Android/iOS 真手机、PWA 真实安装、相机扫码权限、真实公网 HTTPS→私网 PNA、用户实际隧道/反向代理、Windows/macOS 移动服务专用场景及真实 SSH 网络。三平台构建与桌面 crash 用例不代表移动服务在三平台均完成专项验收。本轮使用本机手机尺寸模拟与 GitHub Linux 原生服务测试，不称为多端真机通过。headless CC/Codex/ACP 和桌面副作用工具明确不支持，非隐藏失败或占位按钮。

## 回退

在设置关闭移动服务即可停止监听和所有移动流；桌面终端与聊天继续运行。删除设备清单吊销全部设备。无会话 DB 迁移；生成的 PWA bundle 位于 ignored resources/mobile-web，按 build:mobile 重建。

## 评审后补充的部署边界

Host 默认只允许监听端口对应的 loopback（LAN 模式额外包含当前网卡地址）。反向代理保留外部 Host 时，可在 Settings → 移动服务的访问域名设置中添加 `pc.example.com`、`pc.example.com:8443` 等实际 authority，保存后立即生效；也可显式开启“允许所有域名”，但会失去 Host／DNS 重绑定防护，配对、Origin 与鉴权仍保留。配置兼容 profile 的 `mobile-listener.json`（`allowed_hosts` 和默认 false 的 `allow_all_hosts`）；手工改文件仍需重启服务。详见 [Mobile Web Host 设置](mobile-host-settings.md)。转发日志应隐藏 WS ticket 查询串。

文件根拒绝根目录、家目录本身与本实例 profile/应用配置目录；默认拒绝 .ssh/.aws/.gnupg/.kube/.config/.git、.env 与常见私钥路径。子目录 Git 状态统一换算为任务根相对路径，Git 使用 literal pathspec、关闭 fsmonitor/external diff/textconv，特殊文件在打开前拒绝。已退出终端保留输出尾部，最多保留 64 个退出条目，显式关闭即删除。能从本地子进程取得退出码时发送实际值；SSH/不可取得时为 null。

headless 默认数据目录与 Tauri 的 `dirs::data_dir()/com.taomni.app` 一致；自定义 `--data-dir` 时，AI/应用代理配置位于 `<data-dir>/config/taomni/`，不读取桌面的全局配置。迁移发生于 ModeLease/数据库建目录之前。headless 使用 stderr 输出固定错误码与计数，不记录配对码或业务内容；配对码只输出到操作者控制台。
