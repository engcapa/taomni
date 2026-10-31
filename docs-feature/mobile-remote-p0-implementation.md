# Mobile remote P0 实施与验证

关联设计：[mobile-remote-p0-design.md](mobile-remote-p0-design.md)。分支：`feat/mobile-remote-p0`。只实施 TASK-01～TASK-06；TASK-07 / AC-17 属于 P1。

## 使用

桌面主导航 Settings → 搜索“移动服务” → 开启移动服务。默认仅监听回环；远程手机需要显式允许局域网，或由用户提供可到达的 HTTPS endpoint。服务不随设置页关闭而停止，不持久化自动开启。填写手机可到达的 endpoint 后生成二维码或一次性码。手机直接打开 endpoint 的根路径即可使用独立 Mobile Web；也可从一个实例的外壳注册另一个实例。互联网访问使用 TLS。HTTPS 页面拒绝 HTTP 实例，HTTP 局域网页面提示扫码、剪贴板和安装能力降级。

```sh
pnpm dev:mobile                  # 仅开发外壳，端口 5001
pnpm build:mobile                # 生成内嵌 PWA，主 build 会自动执行
./taomni --headless --data-dir /path/to/profile --mobile-port 8787
# 需要 LAN 时显式添加 --mobile-lan；默认 127.0.0.1
# Unix: kill -HUP <pid> 在 stdout 生成新配对码；TERM/Ctrl-C 正常退出
```

同一 profile 的 desktop/headless 模式互斥。headless 不创建窗口、不调用 Tauri Builder、不初始化 GTK/WebView。它可以操作已有持久化聊天线程，P0 不创建线程或终端。终端列表为空是正常能力边界。

## TASK-01～TASK-04 盘点结论

| AC / 责任 | 已核实来源与实现选择 |
| --- | --- |
| AC-02 身份 | `ActiveTerminal` 注册表以不透明后端键索引，前端展示 tabId 另外存在。移动 API 使用 `term:<注册表键>` / `thread:<线程 id>`，不解析工作区 tabId，不合并相同已保存会话。workspace_context 恒为空。|
| AC-03/04 终端 | 本地 PTY、OpenSSH 包装终端与 russh SSH 均在原输出扇出前送入 broker。退出显式标记 exited，关闭移除。桌面 `write_terminal` 和 `resize_terminal` 的输入、广播、Agent 写入、自动 fit 都会抢回；P0 按设计以命令边界为准，不推断用户意图。无法可靠识别 Agent 占用，所有接管统一提示可能打断命令。|
| AC-04 尺寸 | broker 从创建与桌面 resize 记录桌面尺寸。只读输入/resize 被后端拒绝；移动 resize 钳制到 20～300 列、10～100 行。写权按设备和 WS 连接同时归属，同设备多个页面也只有一个持有者。释放、断开、吊销、桌面抢回后恢复桌面尺寸。|
| AC-05 轮次 | `ChatRunRegistry` 的 direct token 和桥接进程 stop 继续复用；新增轮次预留 token 覆盖初始化窗口，桌面与手机共用排他预留。停止幂等，新指令新增历史，不覆盖旧消息。有在途轮次回 turn_in_progress。|
| AC-05 手机上下文 | 只发送 thread_id/content，不补造 cwd、终端内容、local_terminal_env、bound_session、数据库选中对象或 code_workspace。保留线程自己的 linked_session_id / 历史和 provider。卡片明确提示“由手机发起，未带桌面上下文”。|
| AC-06 CC 权限 | `cc_pending_permissions` 的真实 oneshot 可以透传；只给 Allow / Deny，不给 AllowSession。绑定线程，先到者生效，重复回答 already_resolved。只投影工具名称和确认 id，不发送原始参数。|
| AC-06 ACP / 其他 | ACP 原生 permission request 只投影“需在桌面确认”，不提供按钮；resolve/closed 后清理。前端 ActionCard、WebSearchConfirmCard 与副作用工具回调依赖桌面，移动不模拟其确认/执行；headless 不 provision 桌面工具，不启动 CC/Codex/ACP 桥接，返回 desktop_required。|
| AC-15 文件根 | 在桌面构造的 `AgentThreadContext` 中记住已规范化的本地 code_workspace.repo_root 或可信本地 cwd。远程会话 cwd 不授予本机文件权限。不是 localStorage 的平台工作区定义。重启后需桌面重新提供上下文，否则明确 diff_unavailable。|
| AC-15 diff | 独立只读 Git porcelain status + worktree/cached diff，禁用 external diff/textconv；不调用 loose-file API。非 Git 工作目录 / 无可用根返回 diff_unavailable。文件路径拒绝绝对路径、上跳、反斜杠和符号链接越界；删除文件校验规范化父目录。|
| AC-15 推送 | notify 原生递归监听可信根，推送 file_changed；不依赖终端打开。忽略 .git，监听异常触发 resync。列表、文件与 diff 限 256 KiB，二进制拒绝、超限标 truncated。|
| AC-16 初始化 | headless 初始化 profile lease、session/terminal/server/trust/chat 数据表、notes、vault、MFA、mail 目录、AI context、AppState 及移动 listener。`ModeLease` 解决原 ProfileLease 只取共享锁、不能区分模式的问题。|
| AC-16 不启动项 | 不启动 LSP AppHandle 绑定、GUI local-history、LanChat、本地 servers/tunnels 自启、备份调度、截图/屏幕捕获、桌面 QA bridge 或 SocksCap。退出先停止移动 listener/WS/文件监听，再取消聊天运行句柄。|

## 契约与安全参数

- 默认无监听。health/pair 与静态外壳公开；其余端点 bearer 鉴权，WS 使用 60 秒单次票据并绑定请求 Origin。长 token 只走 Authorization，不进入 URL。
- 配对码随机 122 bits、5 分钟单次有效；token 随机 244 bits，只持久化 SHA-256 哈希，使用常量时间比较。失败按真实对端 IP 限 5 次/5 分钟，不信任 X-Forwarded-For。来源上限 1024、设备上限 256、票据上限 1024。日志仅记录失败来源/计数，不记录码、token、票据、业务内容或连接字段。
- 两级 CORS：health/pair 回显 Origin；业务端点只放行同源或存在已配对设备的 Origin。不使用 `*`，不使用 Cookie/Allow-Credentials；不信任 Forwarded Host。吊销最后一个同 Origin 设备后移除该 Origin，浏览器会因 CORS 拒绝后续业务响应；已建 WS 收到 device_revoked 关闭码，页面停止重试并提示重新配对。
- 删除 mobile-devices.json 会使现有设备失效。设备列表和票据保存在实例 profile。浏览器 token 存 localStorage；界面明确说明其弱于系统密钥库。
- PTY 文字尾部最多 1000 行、512 KiB、单行 16 KiB；增量 UTF-8、CR 覆盖、非法字节替换。单独保留有界原始 chunk 用于 after_seq 续接；缺口 replay + gap。不是屏幕快照，也不承诺 TUI 屏幕精确恢复。
- 事件保留 200 条，超界 resync。PTY 广播队列 512 条，发送超时 10 秒；慢消费者断开后续接。30 秒空闲心跳，90 秒无客户端活动断开。REST/WS 输入上限 64 KiB。
- 外壳与哈希静态资源在构建时形成版本化 precache；Service Worker 只缓存公开外壳，不缓存 API、token、终端、文件或 diff。服务入口有 CSP/no-store/nosniff。

## 验证记录

| 设计项 | 具体证据 | 当前结果 |
| --- | --- | --- |
| V-01 / V-06 | Rust `mobile::auth`、真实 HTTP/WS security/CORS/revoke/listener 测试 | 本机通过 |
| V-02 | Rust 真实 provider follow-up/cancel/turn_in_progress、确认点绑定/重复作答；native 保存会话投影 | Rust Rust 本机通过；native 待 GitHub |
| V-03 | Rust 双设备真实 PTY、只读拒绝/尺寸钳制/桌面抢回/续接；回放 UTF-8/CR/截断 | 本机通过；桌面原生入口待 GitHub |
| V-04 | TC-MOBILE-001：390×844、配对、双 Origin endpoint、终端/Agent 输入分离、只读文件/diff、移除与重载；renderer fixture 显式不算 native 证据 | 本机通过 |
| V-04 / V-05 | TC-MOBILE-003：真实 headless listener 内嵌 PWA 配对、WS、390×844、离线外壳；TC-MOBILE-002：真实桌面 settings→PTY→吊销 | 待 GitHub |
| V-07 | Rust 真实 Git worktree/staged/deleted diff、大文件/二进制/越界、无终端文件事件；settings Vitest 21 tests | 本机通过 |
| V-07 / crash | 完整 crash-regression browser/native；matching QA release | 本机稳定源码 browser 9/9（含全部 8 项 crash）通过；native 执行中，最终提交补记 GitHub 结果 |

本机 Node 22.23.4、pnpm 10；Rust 1.98。完整 `pnpm build`（含 check:refactor、Mobile Web 和桌面构建）已通过；Rust `cargo check --lib` 已通过。后续源码变更均重跑受影响检查。最新移动 Rust 集合为 12 项通过，QA 审计无覆盖倒退，CI 规划与 provenance/crash 选择工具契约 28 项通过。

未验证：Android/iOS 真手机、PWA 真实安装、相机扫码权限、真实公网 HTTPS→私网 PNA、用户实际隧道/反向代理、Windows/macOS 实例运行及真实 SSH 网络。本轮使用本机手机尺寸模拟与 GitHub Linux 原生服务测试，不称为多端真机通过。headless CC/Codex/ACP 和桌面副作用工具明确不支持，非隐藏失败或占位按钮。

## 回退

在设置关闭移动服务即可停止监听和所有移动流；桌面终端与聊天继续运行。删除设备清单吊销全部设备。无会话 DB 迁移；生成的 PWA bundle 位于 ignored resources/mobile-web，按 build:mobile 重建。
