# Mobile 飞书：终端查看、输入与远程打开会话

日期：2026-11-11。分支：`mobile-feishu-improve`。基线：合并 `origin/feat/mobile-web-session-list-search`（`f08df97c`，会话列表搜索与终端摘要）后的 `main`。

## 目标与范围

本轮把飞书适配器从「以 Agent 线程为中心」调整为「与 Mobile Web 的终端能力对齐」：

- 可以在飞书里查看终端输出、发送输入、发送常用按键；
- 输出以卡片形式短暂自动刷新，尽量接近实时；
- 可以在桌面打开已保存会话或新建本地终端，并把新终端继续用于查看与输入；
- **不扩展 tao-ai-chat 的远程能力**。现有 Agent 指令（`send`/`stop`/`approve`/`reject`）保持原状，本轮不新增 Agent 侧能力。

设计边界延续 P1：只做出站长连接、不暴露入站 webhook；复用 Mobile core 的 `session_view`、`pty_broker`、`session_open`，不新建执行协议。

## 用户可见能力

| 指令 | 作用 |
| --- | --- |
| `终端` / `term <id>` | 选中终端并返回尾部输出卡片，随后 60 秒内每 3 秒原地刷新 |
| `输入 <文本>` / `input <文本>` | 向「当前终端」发送文本并追加回车 |
| `输入 <id> <文本>` | 显式指定终端；文本保留原始空格与换行 |
| `按键 <键>` / `key <键>` | 向当前终端发送 Enter、Tab、Esc、Backspace、Ctrl-C、Ctrl-D、Ctrl-Z 或方向键 |
| `保存` / `saved` | 列出可远程打开的已保存会话（短 id、名称、类型、打开按钮） |
| `打开 <短id或名称>` / `open` | 请求桌面打开已保存会话，成功后返回新终端卡片 |
| `新建` / `new` | 请求桌面新建本地终端 |

已有指令 `help`、`list`、`show`、`file`、`send`、`stop`、`approve`、`reject` 保持不变。`查看` 命中终端时改为返回终端卡片。

「当前终端」按 `open_id + chat_id` 记忆：`终端`、`查看`、`输入`、`按键`、`打开` 都会更新。群聊不能查询或操作终端；终端卡片、输入、打开会话都要求已绑定私聊，与 `show`/`file` 的隐私规则一致。

## 实时查看

卡片按钮与自动刷新是两条路径：

1. **自动跟随**：`Reply::Terminal` 消息送达后，适配器用平台返回的 `message_id` 启动一个 60 秒（20 次 × 3 秒）的跟随任务，通过 `PATCH /open-apis/im/v1/messages/:message_id` 更新同一张卡片。终端退出、跟随到期、适配器停止或用户点「停止跟随」都会结束任务。
2. **手动刷新**：点击「刷新」时，`card.action.trigger` 回调在 3 秒响应内直接返回新卡片（`{"card":{"type":"raw","data":…}}`），不产生新消息；转发到其他会话的卡片不会返回任何终端内容。

卡片同时设置 `config.update_multi = true`。平台要求更新前后都是共享卡片，且单条消息更新频控为 5 QPS（3 秒一次远低于限制），只支持 14 天内的消息。终端卡片正文取最近 18 行、最多 1100 字符，超出时丢弃更早的内容并加省略号。

## 输入与控制权

- 每条输入在 `pty_broker` 的操作锁内执行「接管 → 写入 → 释放」，使用一次性 connection id，设备名固定为 `feishu`。
- 如果 Mobile Web 页面正持有控制权，飞书输入返回 `control_busy`，不会抢占；桌面输入会按原有逻辑抢回控制权。
- 输入文本最多 4096 字节，默认追加 `\r`；`按键` 发送固定字节序列（如 Ctrl-C 为 `0x03`），不加回车。
- 释放控制权时恢复桌面尺寸，避免远端接管留下错误的 PTY 几何。
- 不支持 resize、滚动或 TUI 屏幕重建；卡片展示的是回放文本尾部，不是终端画面快照。

## 打开已保存会话

- `打开` 复用 `session_open` 的请求/claim/poll 流程：桌面主窗口负责真实打开（保险库解锁、SSH 认证、代理、跳板机），飞书只轮询结果，最多等待 20 秒。
- 该能力受设置里的「允许手机打开会话」约束；未开启时返回 `open_sessions_disabled`，headless 返回 `desktop_required`。
- 飞书请求在 `OpenRequests` 中标记为 IM 来源：身份已由 open_id + chat_id 绑定校验，因此桌面 claim 不再要求它对应一个已配对的 Web 设备；未标记的请求仍按原规则校验设备吊销。
- 需要桌面认证时飞书无法代答，命令会回复「仍在等待认证」；用户在桌面完成后可发送 `终端` 查看新终端。

## 实现位置

| 文件 | 变化 |
| --- | --- |
| `src-tauri/src/mobile/replay.rs` | `Replay::tail`：从末尾取干净行，保留最新内容 |
| `src-tauri/src/mobile/pty_broker.rs` | `Terminal::tail` 暴露给适配器 |
| `src-tauri/src/mobile/im_adapter/commands.rs` | `parse` 保留原文；新增 `term`/`input`/`key`/`saved`/`open`/`new`、已保存会话解析、按键映射 |
| `src-tauri/src/mobile/im_adapter/cards.rs` | 终端卡片、已保存会话卡片、`update_multi`、按钮回调 |
| `src-tauri/src/mobile/im_adapter/actions.rs` | 终端查看/输入/按键/打开会话分发与输入写入 |
| `src-tauri/src/mobile/im_adapter/network.rs` | `send` 返回 `message_id`；新增 `update_card` |
| `src-tauri/src/mobile/im_adapter/worker.rs` | 卡片原地刷新、跟随任务启动、回调内联刷新 |
| `src-tauri/src/mobile/im_adapter/mod.rs` | 当前终端与跟随任务注册表 |
| `src-tauri/src/mobile/session_open.rs` | `start_im` 与 IM 请求 claim 规则 |
| `src/components/settings/*`、`src/lib/i18n/locales/*` | 帮助文案与配置指南补充终端用法 |

## 验证

（待本轮执行后回填）

## 已知限制

- 未在真实飞书租户验证：卡片原地更新、回调内联卡片、按钮渲染与 `update_multi` 需要 V-08 真机验证；Rust loopback fixture 只证明协议与分发逻辑。
- 跟随窗口固定 60 秒；不支持无限订阅，也不在终端有新输出时主动推送新消息。
- 打开会话需要桌面在线并开启「允许手机打开会话」；需要认证的会话不能在飞书内完成认证。
- 群聊只保留列表与 Agent 摘要；终端内容、输入、打开会话仅限私聊。
- 现有 Agent 远程能力不在本轮扩展范围内。
