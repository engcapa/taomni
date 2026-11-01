> 后续核对与处置：[mobile-feishu-p1-review-resolution.md](mobile-feishu-p1-review-resolution.md)。本报告保留原始评审结论，后续修复和 CI 结果以处置记录为准。

# taomni 移动端 P0 + P1（分支 feat/mobile-feishu-p1）独立评审报告

评审对象：分支 `feat/mobile-feishu-p1`，头 `d813defe2`（完整 `d813defe2641d910d4cc1e01f09831c6830f3bac`），合并基底 `e72fc0d6f`，评审日期 2026-11-01。
适用对象：负责完善该分支的实施方。修复优先级以第 1 节合并前必须修复项为准，发现清单按编号 F-01～F-48 逐条核对。

证据标注口径：
- 【代码】：代码可以直接证实。
- 【文档】：仅为实现文档自述，无直接证据，本评审未核实。
- 【无证据】：未找到相关原文。

所有 CI、真机、真实飞书结果，只按【文档】口径引用。

---

## 1. 总体判断

分支目前不能合并。代码主体基本兑现了 P0/P1 设计，但存在若干与设计验收直接矛盾的逻辑错误；分支头提交也没有可核对的 CI 通过证据。

合并前必须修复的项：

- **M1 分支头 CI 证据缺失**
  - P1 实现文档自述：凭据库修复后的轮次 `41260611701` 仍在“执行中”，上一轮 `41258424343` 的 native TC-MOBILE-004 返回 `VAULT_LOCKED`，不能计为通过。
  - P0 文档的 56/56 证据针对提交 `abfa5e18…`，不是分支头 `d813defe…`。
  - P1 又修改了 P0 代码路径（`chat/stream/*`、`mobile/mod.rs` 等），所以 P0 证据不能覆盖分支头。
- **M2 事件流重连后序列号不重置（F-01）**：实例重启后，手机会静默丢弃后续全部实时事件，破坏 AC-08 与 AC-15。
- **M3 跨域吊销后用旧 token 无限重试（F-02）**：直接违反 AC-02 “不自动用旧 token 重试”。
- **M4 git porcelain 路径基准与文件根不一致（F-03）**：文件根位于仓库子目录时，改动列表与文件、diff 接口互相对不上，破坏 AC-15。
- **M5 task_status 重复发布导致飞书重复通知（F-04）**：每次轮次结束至少 2 条通知，停止操作 2～3 条，属于 AC-17 的行为错误。
- **M6 实现文档中与代码不符的表述须更正（F-40～F-43）**：包括票据“保存在 profile”、限流“按失败计数”、headless 可用“已解锁 vault 引用”、V-07 映射漂移。这些文档是完成状态的依据，不能带着错误口径合并。

---

## 2. 设计对照表

### 2.1 决策 DEC-01～DEC-12

| ID | 状态 | 证据与说明 |
|---|---|---|
| DEC-01 多实例控制面 | 已实现 | 【代码】`mobile/mod.rs` 的 `MobileRuntime::start` 为每个实例起独立服务；`mobile-web/src/App.tsx` 的 `App` 维护多实例列表，`InstanceView` 按 `instance.id` 作为 key 切换。 |
| DEC-02 只做 PWA | 已实现 | 【代码】`mobile-web/` 是独立 Vite 应用，含 `manifest.webmanifest`、`sw.js`，无原生壳。真实安装【文档】未验证。 |
| DEC-03 PTY 共享 | 已实现 | 【代码】`terminal/output.rs` 的 `send_terminal_output` 先调用 `broker.output`，再向桌面扇出；无屏幕共享代码。 |
| DEC-04 行尾回放 | 已实现（有偏差） | 【代码】`replay.rs` 常量为 `MAX_LINES=1000`、`MAX_BYTES=512*1024`、`MAX_LINE=16*1024`，实现了增量 UTF-8 与 `\r` 覆盖；`pty_broker::Broker::resume` 越界时标 `gap`。偏差：`Broker::exit` 清空回放，与 §4.2 “已退出显示最后输出尾部”冲突（F-24）。 |
| DEC-05 用户自备到达方式 | 已实现 | 【代码】`api.ts` 的 `endpoint()` 只做 URL 规范化，无厂商分支；证据范围无中继代码。 |
| DEC-06 双模式同契约 | 部分实现 | 【代码】`main.rs` 在 `run()` 前拦截 `--headless`，`headless::run` 不建 Builder。缺口：EventSink 只有桌面适配器（F-22）；Windows 下 headless 不可用（F-11）；headless 无日志后端（F-10）；直连 provider 在 headless 下静默去掉工具（F-12）。 |
| DEC-07 IM 第二客户端面 | 部分实现 | 【代码】`im_adapter/` 实现出站长连接。入站 webhook 未实现，文档给出理由（F-37）。微信决策只在【文档】。V-08 未执行。 |
| DEC-08 一次性码 + token | 部分实现 | 【代码】`auth.rs` 的 `pairing_code`、`pair`、`revoke`、`authenticate` 齐备。token 无有效期（F-13），TASK-01 应确定的“有效期”未回填。 |
| DEC-09 实例自托管 + 两级 CORS | 已实现（客户端有缺口） | 【代码】`server.rs` 的 `cors`、`origin_allowed`、`static_file`。客户端对 CORS 拒绝的处理与 AC-02 矛盾（F-02）。 |
| DEC-10 单写者 + 桌面抢回 | 已实现 | 【代码】`pty_broker::Broker::desktop`、`control`、`resize`、`ensure_holder`；`io_commands::write_terminal`、`resize_terminal` 通知 broker。持有者取值没有 `desktop`（F-33）。 |
| DEC-11 只读文件 + diff + 事件推送 | 部分实现 | 【代码】`file_view::changes`、`file`、`diff`、`watch`。存在 porcelain 路径基准错误（F-03）、监听洪泛（F-07）、根被清除风险（F-08）。 |
| DEC-12 双输入通道 | 已实现 | 【代码】`TerminalView` 只通过终端 WS 发 `input`；`TaskView` 只调用 `/message`。两处 UI 分离。 |

### 2.2 验收 AC-01～AC-17

| ID | 状态 | 证据与说明 |
|---|---|---|
| AC-01 配对 | 部分实现 | 【代码】122 位码，300 秒过期，成功后 `self.code=None` 单次有效；token 只返回一次；码在 QR/手动输入中传递，不进 URL。<br>扫码依赖 `BarcodeDetector`，iOS Safari 很可能不可用（F-27）。<br>真机【文档】未验证。 |
| AC-02 多实例切换 / 吊销 / CORS | 部分实现 | 【代码】`term:` / `thread:` 前缀（`session_view::list`）；吊销后 WS 收到 4001 关闭码，`live.ts` 停止重试。<br>跨域吊销后客户端误判为连接失败并无限重试（F-02）；跨域场景页面也不会显示“已被实例吊销”。 |
| AC-03 attach 回放 + 实时 | 已实现（代码层） | 【代码】`Broker::subscribe` 先发 `replay` 与 `last_seq`；本地、routed、SSH 创建路径都调用了 `broker.register`。真机【文档】未验证。 |
| AC-04 只读 / 接管 / 抢回 / 钳制 / 尺寸恢复 | 已实现 | 【代码】`streams::terminal_command` 中 input/resize 都先 `ensure_holder`；`Broker::resize` 钳制到 20～300 列、10～100 行；`Broker::desktop` 发出 `control-lost` 并返回恢复尺寸。<br>释放路径在无尺寸记录时不写日志（F-34）。 |
| AC-05 停止 / 后续指令 / turn_in_progress | 已实现 | 【代码】`agent_view::stop`、`message`；`chat_stream_inner` 共享预留。存在预留泄漏风险（F-15）和重复通知（F-04）。 |
| AC-06 确认点透传 | 部分实现 | 【代码】CC 权限可透传，Allow/Deny，`already_resolved`；ACP 显示“需桌面”。<br>`cc_pending_tool_calls`、ActionCard、WebSearchConfirmCard 未投影，手机上不显示“需在桌面确认”（F-14）。 |
| AC-07 两 endpoint 无厂商分支 | 部分实现 | 【代码】客户端无厂商分支。TC-MOBILE-001 的两个 endpoint（`127.0.0.1` 与 `localhost`）是同一个 Python fixture，不是真实服务；真实用户 endpoint【文档】未验证。 |
| AC-08 断线续接 / gap / resync | 部分实现 | 【代码】`Events::resume`、`Broker::resume` 逻辑正确。客户端在实例重启后丢弃事件（F-01）；已关闭终端无限重连（F-05）。 |
| AC-09 关闭 / 离线 / 双模式 | 已实现（代码层） | 【代码】默认无监听；`ModeLease` 实现桌面共享锁、headless 独占锁；`/health` 与 `hello` 返回 `run_mode`；`lastOnline` 有展示。<br>“桌面与 headless 互斥”没有用例：TC-MOBILE-003 只测了第二个 headless 进程。 |
| AC-10 安全基线 | 部分实现 | 【代码】只存哈希，常量时间比较，无 `*`，不发 Allow-Credentials，WS 校验 Origin。<br>限流口径与可用性有缺口（F-16、F-17、F-18）；headless 失败计数不落日志（F-10）；日志脱敏无测试【无证据】。 |
| AC-11 背压 / 有界 | 部分实现 | 【代码】broadcast 512/200，Lagged 即断开，发送超时 10 秒。文件监听无去抖、可能洪泛（F-07）。 |
| AC-12 桌面回归 | 部分实现 / 未核实 | 【代码】命令签名不变。桌面 `chat_stream` 新增 `turn_in_progress` 拒绝语义（F-19）；桌面写入每次都经过 broker gate。回归结果只有【文档】。 |
| AC-13 PWA 离线外壳 | 部分实现 | 【代码】`sw.js` 只缓存外壳；HTTP 下有提示。只有 SVG 图标（F-28）；真实安装【文档】未验证。 |
| AC-14 P0 边界 | 已实现 | 【代码】Mobile Web 无编辑、新建、连接入口；`saved_sessions` 只取终端类，只暴露 4 个字段。 |
| AC-15 改动 / 文件 / diff | 部分实现 | 【代码】`watch` 推送 `file_changed` 不依赖终端；路径校验与 256 KiB 截断到位。缺口见 F-03、F-07、F-08、F-29。 |
| AC-16 headless | 部分实现 | 【代码】无 Builder，ModeLease，空终端列表，CC/Codex/ACP 返回 `desktop_required`。缺口见 F-10、F-11、F-12、F-20、F-21。 |
| AC-17 飞书 P1 | 部分实现 | 【代码】白名单、长连接、卡片、截断、无 PTY 输入。存在重复通知（F-04）；“掉线”只覆盖主动停止；链接不是深链；V-08 未执行。 |

### 2.3 任务 TASK-01～TASK-07

| ID | 状态 | 证据与说明 |
|---|---|---|
| TASK-01 | 部分实现 | 【代码】服务、鉴权、CORS、事件骨架、headless、设置入口都有。<br>`setup()` 初始化项与清理项的逐项盘点表只在【文档】中有摘要。<br>EventSink 盘点不完整（F-22）；反向代理同源实测未记录【文档】；token 有效期未定（F-13）。 |
| TASK-02 | 已实现（小缺口） | 【代码】已抽出 `write_terminal_inner`、`resize_terminal_inner`、`send_terminal_signal_inner`，broker 与会话派生完成。终端 stop 在 unix 的效果待核实（F-23）；broker 存在残留条目（F-25）。 |
| TASK-03 | 部分实现 | 【代码】CC/ACP 投影已做；`tools: []` 恒为空（F-35）；副作用工具未投影（F-14）。 |
| TASK-04 | 部分实现 | 【代码】PWA 各页面与 `file_view` 已实现。PNA 实测【文档】未做；设计要求的 `mobile-web/` Vitest 不存在（F-38）；porcelain 路径错误（F-03）。 |
| TASK-05 | 部分实现 | 【文档】只有“契约与安全参数”摘要，没有设计要求的逐项“通过 / 失败”清单；日志脱敏无验证【无证据】。 |
| TASK-06 | 未实现（真机部分） | 【文档】明确写明 Android/iOS 真机、PWA 安装、相机、公共 TLS/PNA、Windows/macOS 移动专项均未验证。 |
| TASK-07 | 部分实现 | 【代码】飞书适配器完整拆分。V-08 未执行；离线告警只覆盖主动停止（【文档】如实说明）。 |

### 2.4 验证 V-01～V-08

| ID | 状态 | 证据与说明 |
|---|---|---|
| V-01 | 用例存在，结果为【文档】 | 【代码】`auth.rs` 的 `single_use_expiry_revocation_and_origin_bound_tickets`、`persistence_contains_only_hashes_and_deletion_revokes`；`service_tests` 中验证监听关闭。 |
| V-02 | 部分 | 【代码】`task_tests` 覆盖 turn_in_progress、幂等停止、确认点作答；`mobile_native.desktop` 校验已保存会话字段。<br>“已退出终端在列表中显示为已退出”“同一已保存会话的两个运行键分两条”无列表级断言。 |
| V-03 | 部分 | 【代码】`two_viewers_share_real_pty_with_readonly_resize_control_and_replay`、`replay.rs` 两个测试、`pty_broker` 单测。<br>慢消费者“被断开”只测到 broadcast Lagged，没有测到连接断开；“抽出内部函数后命令行为不变”无专门断言。 |
| V-04 | 部分 | TC-MOBILE-001 是 fixture 对端；TC-MOBILE-003 是真实 headless 外壳。“PTY 洪流不拖慢事件流”与 HTTPS endpoint 无用例；Vitest 缺失。 |
| V-05 | 部分 | 真实双 endpoint 未执行；fixture 的两个地址指向同一服务。 |
| V-06 | 部分 | 【代码】CORS、吊销、票据 Origin 绑定有测试。恶意 Origin 发起 WS 握手无测试；日志抽检【无证据】。 |
| V-07 | 部分 | TC-MOBILE-003 无 Display 场景结果为【文档】；桌面回归只有 crash 集合结果【文档】；`desktop_required` 有单测。 |
| V-08 | 未执行 | 【文档】明确未验证，只有 loopback fixture。 |

---

## 3. 模块分析与发现清单

### 3.1 模块分析

#### 移动服务（`mobile/mod.rs`、`server.rs`）

**兑现了什么**
- 默认不监听。`MobileRuntime::start` 按 `lan` 绑定 `127.0.0.1` 或 `0.0.0.0`。
- 路由与设计 §4.4 一一对应；`DefaultBodyLimit` 为 64 KiB。
- 所有业务 handler 都先调用 `authenticated`，再执行业务。
- 静态资源由 `build.rs` 嵌入，不依赖 `AppHandle`。
- 服务以独立 tokio 任务运行；`stop` 依次停飞书、取消、等待、`broker.disable`、`auth.flush`。

**缺什么**
- 没有 TLS，需要用户自备反向代理（设计允许）。
- 已在运行时再次 `start` 会直接返回旧地址，新传入的 lan/port 被忽略且无提示。
- 桌面进程退出时没有调用 `mobile.stop`（F-36）。
- 资源目录缺失时静默嵌入空集合（F-30）。

**风险**
- `.lock().unwrap()` 遍布 broker、auth、events。移动侧一旦 panic 并毒化 broker 锁，桌面 `write_terminal`（经 `broker.gate`）也会 panic，故障隔离不是结构性的（F-31）。
- Host 头不校验，存在 DNS rebinding 可读 `/health`、`/pair` 的理论面（F-32）。

#### 鉴权（`auth.rs`）

**兑现了什么**
- 码与票据都只存 SHA-256 哈希。
- token 由两个 UUIDv4 组成，约 244 位随机。
- `equal` 使用 `subtle` 常量时间比较。
- 设备文件原子写入（`NamedTempFile::persist`）。
- 删除设备文件即吊销（`synchronize_revocation`）。
- 票据 60 秒、单次（`remove`）、绑定 Origin，并在消费时校验设备仍存在。

**缺什么**
- token 无过期（F-13）。
- `pair` 在校验配对码之前就给 `attempt.1` 加一，成功配对也计入 5 次限额（F-16）。
- `failures.len()>=1024` 时对所有来源统一返回 `rate_limited`（F-17）。
- 服务停止不清除未用配对码（F-39）。

**风险**
- 经反向代理时所有请求来源都是回环地址，限流退化为全局 5 次（F-18）。

#### PTY broker（`pty_broker.rs` 及 `terminal/*` 接入）

**兑现了什么**
- 接入点在 `send_terminal_output`，与桌面同源。
- 本地、命令、routed、SSH 四条创建路径都在注册表插入前 `register`，并用 `get_size` 或参数记录初始桌面尺寸。
- 写权按“设备 + 连接”归属；`control_busy` 生效；`ensure_holder` 在后端拒绝输入与 resize。
- 桌面写入或 resize 经 `Broker::desktop` 抢回，区分 `desktop_input` 与 `desktop_resize`，并恢复尺寸。
- 断开、吊销、服务停止时，在 `streams::run` 尾部释放写权并恢复尺寸。
- 所有操作在每终端一把 `gate` 下串行。

**缺什么**
- `exit` 清空回放，已退出终端看不到尾部（F-24）。
- `exit` 帧 `code` 恒为 null（F-34）。
- SSH 结束路径只调用 `exit`，没有 `remove`，`broker.terminals` 中会残留条目（F-25）。

**风险**
- `output` 在 PTY 读线程上持有全终端共享的 std Mutex，并执行 UTF-8 解码与拷贝。终端多、输出快时会产生锁争用（属性能风险，无测试）。

#### 回放（`replay.rs`）

**兑现了什么**
- 1000 行包含当前未完成行：`lines.len()+1 > MAX_LINES`。
- 512 KiB 按解码后文本计；16 KiB 单行截断，标记长度预留 32 字节。
- `\r` 后接非 `\n` 时清空当前行。
- 增量 UTF-8 解码：保留不完整尾字节，非法字节替换为 `�`。
- 两个单测覆盖跨 chunk 中文字符、进度条、超长行、2000 行淘汰。

**与 broker 的关系**：续接使用独立的原始 chunk 队列（1000 个 chunk 或 512 KiB），语义是“1000 chunk”而不是“1000 行”。实现文档已说明，与设计不冲突。

**风险**
- `\r` 实现为整行清空，与真实终端逐字符覆盖不同。
- ANSI 光标移动不解释，TUI 回放会失真。两点均为设计已接受的近似。

#### 事件流（`events.rs`、`streams.rs`、`live.ts`）

**兑现了什么**
- 服务端 200 条缓冲与 200 容量 broadcast；`resume` 判界正确（单测覆盖）。
- 终端流与事件流分离，各自持有序列号。
- 心跳 30 秒；服务端 90 秒收不到客户端帧即断开；客户端 90 秒看门狗。
- WS 握手要求 Origin 存在且被允许，并消费绑定该 Origin 的票据。
- 设备吊销后用 4001 关闭码断开。

**缺什么**
- `resync` 帧带 `seq` 字段，客户端又按 seq 过滤，重连时不重置序列号，导致实例重启后丢弃事件（F-01）。
- 已关闭终端被无限重连（F-05）。
- `hello.event_seq` 取值晚于订阅（F-26）。

**风险**
- 事件流没有按 `task_id` 的服务端过滤（设计规定 P0 全量推送，属已接受）。

#### 文件视图（`file_view.rs`）

**兑现了什么**
- `relative` 拒绝空路径、`\`、`:`、NUL、绝对路径和非 Normal 组件。
- `resolve` 对根与目标都 `canonicalize`，用 `Path::starts_with` 按组件比较，符合“逐段比较”。
- 删除文件时校验规范化后的父目录。
- `git` 调用带 `--no-ext-diff --no-textconv`、`kill_on_drop`、10 秒超时、256 KiB 上限。
- 二进制拒绝；不暴露 loose 读取。
- `remember_root` 不把远端会话 cwd 授予本机读取权限。

**缺什么**
- porcelain 路径相对仓库根，而文件根可能是子目录（F-03）。
- 监听不去抖、不尊重 `.gitignore`（F-07）。
- 手机或飞书发起的后续指令可能清除已记住的根（F-08）。
- pathspec 未字面化（F-29）。

**风险**
- 打开 FIFO 会阻塞（F-29 附带）。
- 根可能是家目录甚至 `/`，从而开放整个家目录读取（F-09）。
- Windows 上子进程可能闪出控制台窗口（F-29 附带）。

#### Agent 视图（`agent_view.rs`、`chat/*`、`permissions.rs`）

**兑现了什么**
- 预留令牌贯穿 `chat_stream_inner`、`stream_provider` 与 CC/Codex/ACP，覆盖 provider 尚未登记前的窗口。
- 停止幂等。
- `confirm` 校验线程、`supported` 与 oneshot 是否存在，先到者生效。
- ACP 只投影、不可作答。
- headless 下 CC/Codex/ACP 返回 `desktop_required`。

**缺什么**
- 副作用工具与前端确认卡不投影（F-14）。
- `tools` 恒为空（F-35）。
- 重复发布状态事件（F-04）。
- 直连 provider 在 headless 下静默去掉工具（F-12）。

**风险**
- 预留泄漏会永久锁死线程（F-15）。
- 桌面 `chat_stream` 新增拒绝语义（F-19）。
- 终端 stop 在 unix 发给 shell PID 可能无效（F-23）。

#### 会话视图（`session_view.rs`）

**兑现了什么**
- `term:` / `thread:` 前缀；以运行键分条展示，不按已保存会话合并。
- `workspace_context` 恒为 null。
- 已保存会话按 7 种终端类类型过滤，只给 4 个字段。
- 线程状态依次判断：待确认、在途（runs 或 pending）、空闲。

**缺什么**
- `last_activity_at` 对终端恒为 null。
- `detail` 中 `tools: []`（F-35）。
- `capabilities.message` 用 `starts_with("acp:")`，而 `agent_view::message` 用 `profile_id_from_provider_id`，两处判定口径不一致。

**风险**
- `list_threads(&db, 200)` 只列最近 200 个线程（未见于设计，属行为限制）。

#### headless（`headless.rs`、`main.rs`）

**兑现了什么**
- `main` 在第一参数为 `--headless` 时直接进入 `headless::run`。
- 自建多线程 runtime；`ModeLease` 独占锁加 `ProfileLease`。
- `initialize_with_config` 不依赖 `AppHandle`。
- 配对码输出到 stdout；unix 下 SIGHUP 轮换；TERM 或 Ctrl-C 后依次停服务、停轮次。

**缺什么**
- 未初始化日志后端（F-10）。
- Windows 发布版处于 GUI 子系统，stdout 与 Ctrl-C 都不可用，也无码轮换手段（F-11）。
- 未调用 `migrate::run`；默认数据目录与桌面 `resolved_app_data_dir` 是否一致【无证据】（F-20）。
- `--feishu` 依赖 vault 引用，但 headless 没有解锁路径（F-21）。

#### 飞书 `config.rs`

**兑现了什么**
- `deny_unknown_fields`。
- `validate` 校验 `cli_` 前缀、`ou_`/`oc_` 前缀、最多 32 组绑定、`secret_ref` 必须是 vault 引用、endpoint 不得含凭据/查询串/片段。
- 原子保存。
- `resolve_proxy` 三种模式中 none 为显式直连，custom 强制启用。

**风险**：app 模式下若应用代理未启用，则直连。这与应用整体语义一致，但设置 UI 未提示这一点。

#### 飞书 `network.rs`

**兑现了什么**
- reqwest 设置 `no_proxy()` 后，仅显式代理可用；`socks5h` 远端解析；禁止重定向；15 秒超时；响应最大 512 KiB。
- WS 端点只接受 `wss://*.feishu.cn`，loopback 放行仅在 `cfg(test)` 下生效。
- WS 走同一代理，失败不回退直连。
- token 缓存，并在特定错误码时失效。

**风险**：`read` 内部发送 Pong 时可能被 `select!` 取消（属理论风险）。

#### 飞书 `protocol.rs`

**兑现了什么**
- 字段编号 1～9 与文档所述 SDK 一致【文档】。
- ping 使用 method 0；应答 payload 中 `data` 为 base64。
- 分片限制：64 片、256 KiB、16 个未完成消息、5 秒过期；拒绝非空 `payload_encoding`。

**缺什么**：任何协议错误都会通过 `?` 断开整条连接（F-06）。

#### 飞书 `actions.rs`

**兑现了什么**
- 白名单要求身份与会话同时匹配；校验 app_id 与时效（10 分钟 / 1 分钟）。
- 去重：消息用 `message_id`，卡片用 `event_id`，SQLite 存哈希，保留 24 小时、上限 1 万。
- 先登记再执行，即至多一次。
- `bounded` 截断 1200 字；`send/stop/approve/reject` 只接受 `thread:`；文件快照继承 `file_view` 的约束。

**缺什么**
- 卡片回调时间按微秒处理是【文档】结论，未经真实验证（F-44）。
- 链接只是实例根地址，不是深链。

**风险**：`show` 与 `file` 会把助手结果和文件内容（截断后）发往飞书服务器（F-45）。

#### 飞书 `worker.rs`

**兑现了什么**
- 收帧、业务、发送三个循环分离；队列 64 / 128；先 `try_reserve` 再登记。
- 发送重试 5 次，复用同一 UUID。
- 退避 1/2/5/10/30 秒；连接存活满 60 秒后重置退避。
- 心跳超时判断为 `2×interval+5s`。

**缺什么**
- 重复通知（F-04）。
- 业务循环串行执行，命令处理期间不消费事件，易出现 Lagged（F-46）。

#### 飞书 `mod.rs`（Runtime）与 `settings.rs`

**兑现了什么**
- 启动前校验必填项；运行中拒绝改配置。
- 停止时 3 秒内尽力发送停止通知。
- `mobile_feishu_save` 强制沿用旧的 `secret_ref`，前端无法指向任意 vault 项。
- 密钥长度不超过 1024，`put_fixed` 存入 vault。
- `mobile_feishu_start` 要求移动服务已运行。

**缺什么**
- 无法删除已存密钥。
- 设计 §4.4 要求 IM 进程内调用“仍须鉴权”；实现以白名单代替 Bearer（F-37）。

#### Mobile Web 各视图

**App / InstanceView**
- 【代码】实例切换时卸载旧视图并关闭 WS。
- 事件经 100 ms 去抖触发全量刷新。
- 显示上次在线与上次更新时间。
- 风险：洪泛时请求风暴（F-07 关联）。

**PairForm**
- 【代码】只在安全上下文中提供扫码；有混合内容拦截；有浏览器存储风险提示。
- 风险：iOS 上缺少 `BarcodeDetector`（F-27）。

**TerminalView**
- 【代码】只读时本地丢弃键入，resize 按钮置灰；接管提示是静态文案。
- 有常用键条，粘贴为显式操作，剪贴板只在安全上下文读取。
- 重连不清屏；只有 gap 时才 `reset`。
- 页脚时间每次渲染都重新计算，不是“上次更新”时间（属建议级）。

**TaskView**
- 【代码】支持停止、确认（仅 supported 时显示按钮）、后续指令（运行中禁用）、“由手机发起，未带桌面上下文”提示。
- 文件视图带行号，diff 按 hunk 折叠，显示截断提示。
- 输入上限与服务端口径不一致（F-47）。

**api.ts / live.ts**
- 【代码】请求 `credentials: "omit"`，token 只放 Authorization 头，票据放查询串。
- 缺口见 F-01、F-02、F-05。

**sw.js / manifest / vite**
- 【代码】只缓存外壳，按构建版本号预缓存。
- 只有 SVG 图标（F-28）。

#### 桌面设置

**MobileServiceSettings**
- 【代码】放在 network 分组；提供开关、局域网选项、端口、endpoint、码与二维码、5 分钟到期清除、失败计数、设备列表与吊销。
- 缺：配对成功后设备列表不自动刷新；没有明确的“局域网 HTTP 为明文”警示。

**FeishuAdapterSettings 与测试**
- 【代码】vault 锁定时按需解锁并续存，取消时保留输入；运行中禁止编辑；每 3 秒轮询。
- 测试文件含 5 个用例（`it.each` 展开为 2 个）。文档中“16/16”是多个文件的合计，无法逐一核对。

---

### 3.2 发现清单

**F-01**
- 严重度：合并前必须修复
- 位置：`mobile-web/src/live.ts` 的 `useLive`（`onmessage`）；`mobile/events.rs` 的 `Events::resume`
- 问题：重连时客户端不重置 `sequence`，`hello` 中的 `event_seq` 只在首连时采用。实例进程重启后服务端序列号从 0 开始：`resume(N)` 在 `after > b.0` 时返回带 `seq:b.0` 的 `resync`，被客户端按 `seq <= sequence` 丢弃；之后序列号小于 N 的全部事件也被丢弃。`hello` 中的 `instance_id` 不参与判断。
- 证据：【代码】`resume` 返回 `json!({"type":"resync","seq":b.0})`；客户端写有 `if (frame.seq <= sequence) return`，并带条件 `!reconnect`。
- 建议：`resync` 不带 `seq`，或客户端遇到 `resync` 时无条件处理；`hello` 的 `instance_id` 变化时重置序列号。补一个“服务重启后续接”的测试。

**F-02**
- 严重度：合并前必须修复
- 位置：`live.ts` 的 `connect` 的 catch 分支；`api.ts` 的 `request`；`server.rs` 的 `cors`
- 问题：吊销同一 Origin 下最后一个设备后，跨域业务请求得到不带 ACAO 的 403。浏览器无法读取响应，`request` 将其映射为 `connection_failed`，`live.ts` 于是带旧 token 无限退避重试，页面也不显示“已被实例吊销”。违反 AC-02。
- 证据：【代码】只有 `unauthorized`、`origin_denied` 会停止重试；`service_tests` 自身断言吊销后为 `origin_denied`（非浏览器客户端才能读到）。
- 建议：对 `origin_denied` 的业务响应也回显 Origin，使浏览器能读到错误码（不泄露业务数据）；或客户端对连续 CORS 失败配合 `/health` 可达性判定为“已吊销 / 需重新配对”。

**F-03**
- 严重度：合并前必须修复
- 位置：`file_view::changes`、`file_view::diff`
- 问题：`git status --porcelain=v1` 输出的路径相对仓库根，与 cwd 无关；而 `file` 与 `diff` 以文件根（可能是仓库子目录）为基准解析路径与 pathspec。文件根是子目录时：
  - 列表中会出现根外的路径名（只是路径名，不含内容）；
  - 点开后返回 `file_unavailable` 或 `diff_unavailable`。
- 证据：【代码】`git(&root, ["status","--porcelain=v1",...])` 之后直接把 `row[3..]` 当作相对根路径。此 git 行为属通用知识，证据范围无反证。
- 建议：先用 `rev-parse --show-prefix` 求出前缀并过滤、剥离；或改用 `git status --porcelain -- .` 加前缀换算；补一个“根为子目录”的测试。

**F-04**
- 严重度：合并前必须修复
- 位置：`chat/stream_events.rs` 的 `emit_stream_event`；`preparation.rs` 的 `chat_stream_inner`；`agent_view::stop`；`shutdown.rs` 的 `stop_thread_runtime_inner`；`im_adapter/worker.rs` 的 `business`
- 问题：同一结果被重复发布为多条 `task_status`：
  - `End` 时 `emit_stream_event` 发一次 `idle/turn_finished`，`chat_stream_inner` 收尾再发一次；
  - 停止时 `stop_thread_runtime_inner` 发一次、`agent_view::stop` 又发一次，若轮次在途，收尾再发一次。
  `business` 对每条都入队通知，UUID 由 seq 派生，飞书无法去重，所有绑定会话都会收到 2～3 条。对空闲线程发 `/taomni stop`、桌面删除线程也会触发“stopped”通知。
- 证据：【代码】见上述各函数；`network_tests` 只断言“存在”，不断言条数。
- 建议：只在 `chat_stream_inner` 收尾处发布终态；`agent_view::stop` 不再直接发布；worker 按 `(task_id, 终态, 轮次)` 去重；补“恰好一条”的断言。

**F-05**
- 严重度：重要
- 位置：`live.ts` 的 `connect`、`retry`；`streams::terminal`
- 问题：终端被 `close_terminal` 移除，或实例重启后键已不存在时，升级阶段返回 `terminal_not_found`（HTTP 404）。浏览器只看到 WS 失败，于是无限申请票据并重连。
- 证据：【代码】`Broker::subscribe(...)?` 在升级前失败；`onclose` 只对 4001 停止重连。
- 建议：先升级再发送 `error` 帧并用专用关闭码关闭；客户端收到 `exit` 或该关闭码后停止重连。

**F-06**
- 严重度：重要
- 位置：`im_adapter/worker.rs` 的 `connection`；`protocol::Fragments::accept`
- 问题：分片非法、`payload_encoding` 非空、容量满、JSON 非法时都经 `?` 断开整条连接。若平台重投该帧，会形成“毒消息”重连循环，期间其他事件也无法处理。
- 证据：【代码】`fragments.accept(&frame)?`、`serde_json::from_slice(&bytes).map_err(...)?`。
- 建议：单帧错误改为回复非 200 应答并计数，不断开连接。

**F-07**
- 严重度：重要
- 位置：`file_view::watch`；`App.tsx` 的 `InstanceView`；`TaskView`
- 问题：递归监听没有去抖，也不尊重 `.gitignore`，只忽略 `.git`。构建或 `node_modules` 写入时，每个文件都会发布一次 `file_changed`：
  - 200 条事件缓冲被冲刷，`task_status` 被挤出，触发 resync；
  - 事件流与飞书订阅出现 Lagged，导致断开或通知丢失；
  - 手机每 100 ms 全量刷新一次。
  这破坏 AC-11 与 AC-15 的实时性。
- 证据：【代码】回调中对每个 path 调用 `events.publish`；`business` 对 Lagged 只记录 `feishu_event_gap_query_list`。
- 建议：按任务做时间窗合并（如 500 ms 内只发一次），过滤 ignored 文件，或改为“改动列表已变化”的粗粒度事件。

**F-08**
- 严重度：重要（待核实）
- 位置：`preparation.rs` 的 `stream_inner` 调用 `file_view::remember_root`
- 问题：桌面模式下，手机或飞书发起的后续指令也会进入 `remember_root`（因为 `app.is_some()`）。请求不带 cwd 或 code_workspace 时，若 `build_agent_thread_context` 不回填后端已存的 cwd，计算出的 root 为 None，会执行 `roots.remove(thread_id)`。结果是手机发完一条指令后，该任务的文件与 diff 变为不可读。
- 证据：【代码】确有删除分支；【无证据】`build_agent_thread_context` 的回填逻辑不在证据范围。
- 建议：只在 root 可得时更新，root 为 None 时保留旧值；补“手机后续指令后改动页仍可读”的测试。

**F-09**
- 严重度：重要
- 位置：`file_view::remember_root`、`resolve`
- 问题：根可能是本地终端的 cwd，例如家目录或 `/`。此时已配对手机和飞书白名单用户可以读取根下任意文本文件（256 KiB 以内），例如 `~/.ssh/*`、app-data 下的配置文件。
- 证据：【代码】除 `is_dir()` 外没有任何根范围约束或敏感路径排除。
- 建议：拒绝家目录本身、`/`、app-data 目录作为根，或至少在设置中明示；对隐藏凭据目录做默认拒绝。

**F-10**
- 严重度：重要
- 位置：`headless::run`、`headless::serve`
- 问题：headless 路径没有初始化任何日志后端，`auth::pair`、`server::ApiError`、飞书的 `log::warn!` 很可能全部无输出。设计 §4.5 要求“headless 模式下失败计数输出到日志”；headless 也没有设置页，飞书状态完全不可见。
- 证据：【代码】`run`、`serve` 中没有 logger 初始化；`main.rs` 在任何初始化之前就分流；桌面 logger 的安装点【无证据】。
- 建议：在 headless 中初始化 stderr 日志（脱敏规则不变），并定期输出失败计数与飞书状态。

**F-11**
- 严重度：重要
- 位置：`main.rs`（`windows_subsystem = "windows"`）；`headless::serve` 的 `#[cfg(not(unix))]` 分支
- 问题：Windows 发布版是 GUI 子系统，没有控制台：
  - 配对码 `println!` 在未重定向时不可见；
  - `ctrl_c` 无法送达，进程只能被强杀，飞书停止通知与 `auth.flush` 不会执行；
  - 没有 SIGHUP，码在 5 分钟后过期，只能重启进程。
  这与设计“server 三端可运行”冲突。
- 证据：【代码】`main.rs` 的 `cfg_attr`，`serve` 中非 unix 分支只有 `ctrl_c`。
- 建议：headless 模式下 `AttachConsole`/`AllocConsole`，或把配对码写入 profile 内仅本人可读的文件；提供基于文件或命名管道的轮换与退出机制。

**F-12**
- 严重度：重要
- 位置：`chat/stream/provider.rs` 的 `stream_provider`
- 问题：headless 下，`supports_tools_for && app.is_some()` 为假，直连 provider 不带任何工具继续运行。这不是 AC-16 要求的“显式失败”。P0 文档的写法容易被读成 headless 统一返回 `desktop_required`。
- 证据：【代码】判断条件见上；`TaskView` 只有静态提示文案。
- 建议：在 `task_status` 或轮次结果中显式标记“本轮未提供桌面工具”；同时修正 P0 文档措辞。

**F-13**
- 严重度：重要
- 位置：`auth::Device`、`auth::authenticate`
- 问题：token 永不过期。设计 TASK-01 要求确定有效期，§10 的缓解措施也写了“提供 token 有效期”。
- 证据：【代码】`Device` 无过期字段；P0 文档只列了位数与哈希。
- 建议：增加有效期与闲置过期（基于 `last_used_at`），并在文档中回填。

**F-14**
- 严重度：重要
- 位置：`agent_view::confirmations`；`permissions.rs`；`acp/events.rs`
- 问题：只投影了 CC 权限与 ACP 权限。`cc_pending_tool_calls`（需前端执行的副作用工具）、ActionCard、WebSearchConfirmCard 都不进入 `mobile.confirmations`，手机上看不到“需在桌面确认”，任务只显示为“运行中”。AC-06 要求这类确认点显示提示。
- 证据：【代码】移动侧代码中没有 `cc_pending_tool_calls` 的任何引用。
- 建议：以 `supported:false` 投影这些等待点，并在解决后清理。

**F-15**
- 严重度：重要（低概率）
- 位置：`agent_view::message`；`chat_stream_inner`
- 问题：`pending_turns` 插入之后，若 `serde_json::from_value(...)?` 返回错误，或派生任务 panic，预留永不移除。`stop` 只取消令牌、不删预留，于是该线程在手机和桌面都永久返回 `turn_in_progress`，直到进程重启。
- 证据：【代码】`pending.insert` 之后的 `?`；只有 `chat_stream_inner` 正常收尾时才移除。
- 建议：先构造请求再预留；用 RAII guard 在 drop 时移除；`stop` 时同步清理。

**F-16**
- 严重度：建议（且与文档表述不符）
- 位置：`auth::pair`
- 问题：`attempt.1 += 1` 发生在校验码之前，成功配对也计入；同一 IP 在 5 分钟内最多配对 5 次（含成功）。P0 文档写“失败按真实对端 IP 限 5 次 / 5 分钟”，与代码不符。
- 证据：【代码】见 `pair`。
- 建议：只在失败时累加，或修正文档。

**F-17**
- 严重度：重要
- 位置：`auth::pair`（`failures.len() >= 1024`）
- 问题：来源表满 1024 后对所有来源返回 `rate_limited`。局域网内可用大量 IPv6 地址填满来源表，阻断合法配对 5 分钟。
- 证据：【代码】。
- 建议：表满时淘汰最旧条目，或按 /64 前缀聚合，而不是全局拒绝。

**F-18**
- 严重度：重要
- 位置：`server::pair`（使用 `ConnectInfo` 的 IP）
- 问题：经用户自备反向代理到达时，所有请求的对端都是回环地址，5 次限额变成全局共享。互联网上任何人 5 次错误尝试即可锁死配对。设计要求反向代理场景须实测，文档写明未验证。
- 证据：【代码】；【文档】“用户实际隧道 / 反向代理”未验证。
- 建议：提供显式的可信代理配置；或对回环来源采用独立策略，并在文档中说明。

**F-19**
- 严重度：重要（待核实）
- 位置：`preparation.rs` 的 `chat_stream`、`chat_stream_inner`（`reserved=false` 分支）；关联 `agent_view::message`（`reserved=true` 路径）；`mobile/mod.rs` 的 `MobileRuntime::pending_turns`、`turn_cancel`
- 问题：桌面 Tauri 命令 `chat_stream` 改为调用 `chat_stream_inner(req, Some(app), state, false)`。在 `reserved=false` 时，函数先检查 `state.mobile.pending_turns`。若同一 `thread_id` 已有条目，直接返回 `Err("turn_in_progress")`，不进入 `stream_inner`；否则插入一个新的 `CancellationToken`，轮次收尾时再移除。分支前，桌面 `chat_stream` 在本文件内没有这一层拒绝。这是桌面命令的行为变更，签名没变，语义变了。
  - 触发条件一：手机或飞书发起的后续指令。`agent_view::message` 在 spawn 前插入预留，派生任务以 `reserved=true` 调用 `chat_stream_inner`，直到收尾才移除。这段时间里，桌面对同一线程发送都会被拒绝，包括 provider 尚未登记 `chat_runs` 的准备阶段。
  - 触发条件二：桌面自身在途轮次。桌面第一次 `chat_stream` 也会插入预留，同一线程的第二次桌面发送同样被拒绝。分支前同一线程能否并发发送、前端是否本来就禁止，现有证据不足以确认（待核实）。
  - 触发条件三：与移动服务是否启用无关。`pending_turns` 随 `MobileRuntime::default()` 恒存在，检查也没有用 `broker.enabled` 或服务运行状态做门控。即使用户从未开启移动服务，桌面 `chat_stream` 也会走这段预留与拒绝逻辑。这与“移动能力默认关闭、可选启用”的总体口径不一致。
  - 与 F-15 的关系：F-15 描述的预留泄漏，其后果正是通过本条暴露给桌面用户。预留泄漏后，桌面 `chat_stream` 对该线程会永久返回 `turn_in_progress`，直到进程重启。此外，`reserved=false` 分支本身也是“先插入、正常收尾才移除”，没有 RAII guard。若 `stream_inner` 及其下游在桌面路径上 panic，桌面自己插入的预留同样不会移除，形成同样的永久锁死，这一触发点不依赖移动端。`.lock().unwrap()` 意味着 `pending_turns` 锁一旦被毒化，桌面 `chat_stream` 会直接 panic（与 F-31 同一类故障隔离问题）。停止操作能否清理预留，以 F-15 已有结论为准；`stop_thread_runtime_inner` 的实现不在现有证据中。
  - 拒绝发生的时机：在 `stream_inner` 之前，因此用户消息不会落库，也不会发出 `UserMessage` 事件、调用 `remember_root` 或发布 `turn_starting`。后端数据不会被污染。
  - 桌面端表现：现有证据不足以确认（待核实）。包括：前端是否识别 `turn_in_progress` 这一机器码，还是原样显示字符串；前端是否已乐观插入用户消息气泡，导致界面显示一条未落库的消息；手机轮次进行中，桌面界面能否从 `chat-stream:{thread_id}` 事件得知线程在途并禁用输入（`emit_stream_event` 实现不在证据范围）。
  - 与 AC-12 的关系：AC-05 要求移动端在轮次进行中返回 `turn_in_progress`。桌面插入预留是让移动端感知桌面在途轮次的必要手段，而桌面被反向拒绝是这一设计的副产物。AC-12 要求桌面回归不变，本评审只在【代码】层面确认“命令签名不变”。设计 AC-12 原文和实现文档是否声明了这一行为变更，现有证据中找不到（【无证据】，待核实）。`task_tests` 是否覆盖桌面 `reserved=false` 路径被拒绝的场景，现有证据也不足以确认。
- 证据：
  - 【代码】`chat_stream` 调用 `chat_stream_inner(req, Some(app), state.inner(), false)`。
  - 【代码】`if !reserved { ... if pending.contains_key(&tid) { return Err("turn_in_progress".into()); } pending.insert(...) }`。
  - 【代码】移除只发生在函数末尾的 `state.mobile.pending_turns.lock().unwrap().remove(&tid)`，中间无 guard。
  - 【代码】`agent_view::message` 先 `pending.insert` 再 `tokio::spawn`，以 `reserved=true` 调用；注释写明“Shared with desktop preparation”。
  - 【代码】`MobileRuntime::default()` 无条件创建 `pending_turns`；`chat_stream_inner` 的检查不读 `broker.enabled`。
  - 【代码】统一 diff 显示，分支前 `chat_stream` 的函数体从 `ai_ctx.config.fully_disabled` 检查直接开始，本文件内没有 `turn_in_progress` 分支。下游 `stream_claude_code`、`stream_codex`、`stream_provider` 在分支前是否另有并发拒绝，【无证据】。
  - 【无证据】桌面前端对该错误的处理、AC-12 原文、实现文档中对此变更的声明。
- 建议：
  - 文档回填：在 AC-12 对照与实现文档中明确声明“桌面 `chat_stream` 在同线程存在在途轮次（含手机或飞书发起）时返回 `turn_in_progress`”，并写明这适用于未启用移动服务的情形，或改为仅在移动服务启用时生效。
  - 前端处理：确认桌面前端收到 `turn_in_progress` 时给出可理解提示（如“该任务正由手机/飞书执行”），不残留未落库的乐观消息，并可提供停止入口。可让 `pending_turns` 的值记录发起来源（desktop/mobile/im），以便提示更具体。
  - 与 F-15 合并修复：RAII guard 同时覆盖 `reserved=false` 与 `reserved=true` 两个分支，保证 panic 或提前返回时也能移除预留。锁毒化时返回错误，不直接 panic。
  - 补用例：
    - 手机预留期间，桌面 `chat_stream` 被拒绝，且不落库用户消息；
    - 手机轮次结束后，桌面发送恢复正常；
    - 同一线程两次桌面并发发送的预期行为；
    - 移动服务未启用时，桌面行为与基底一致（或与文档声明一致）。
  - 把以上场景纳入桌面回归集合，作为 AC-12 的回归证据。



**F-20**
- 严重度：重要
- 位置：`mobile/headless.rs` 的 `serve`（`--data-dir` 缺省分支）；`lib.rs` 的 `run`（`migrate::run(&app_data)`）
- 问题：
  - headless 未指定 `--data-dir` 时，使用 `dirs::data_dir().join("com.taomni.app")`。桌面使用 `crate::resolved_app_data_dir(&app)`，并在其之前调用 `migrate::run`。两者是否指向同一目录无法确认。若不一致，headless 会打开另一个空 profile，`ModeLease` 也锁在不同目录上，“同一 profile 桌面与 headless 互斥”失效。
  - headless 不调用 `migrate::run`。`lib.rs` 注释写明迁移“在 app-data 目录创建之前运行，使目录重命名的目标不存在”。headless 的 `ModeLease::acquire` 与 `initialize_with_config` 都会先 `create_dir_all(data)`。若用户先运行 headless、后升级桌面，迁移的目标目录可能已经存在。
- 证据：
  - 【代码】`serve` 的缺省路径表达式；`initialize_with_config` 中没有 `migrate::run`；`lib.rs` diff 中的迁移注释与调用顺序。
  - 【无证据】`resolved_app_data_dir` 的实现、Tauri identifier 取值、`migrate::run` 遇到目标已存在时的行为，均不在证据范围。
  - 附带：`AiConfig::load(&default_ai_config_path())` 不随 `--data-dir` 变化（代理路径同理，见第 4 节代理项）。
- 建议：headless 与桌面共用同一个数据目录解析函数（不依赖 `AppHandle` 的版本），并在 headless 中先执行 `migrate::run`。补一个“缺省目录下桌面与 headless 互斥”的用例（AC-09 原本就缺这个用例）。

**F-21**
- 严重度：重要
- 位置：`headless::serve` 的 `--feishu` 分支
- 问题：headless 只执行 `Vault::open` 后直接 `vault.resolve(&config.secret_ref)?`，没有任何解锁路径。桌面需要“首次使用或锁定时通过按需弹窗初始化 / 解锁”（P1 文档），而 headless 进程刚启动时 vault 是否已解锁，证据范围看不出来。因此 headless 下实际可用的凭据来源很可能只有环境变量 `TAOMNI_FEISHU_APP_SECRET`。另外，环境变量对同一用户的其他进程可见（如 `/proc/<pid>/environ`），文档没有提示这一点。
- 证据：
  - 【代码】`serve` 中只有 `Vault::open`（在 `initialize_with_config` 里）和 `resolve`，没有 unlock 调用。
  - 【文档】桌面需要按需解锁。
  - 【无证据】`Vault::open` 是否自动解锁（例如依赖系统钥匙串）、`resolve` 在锁定状态下返回 `Err` 还是 `Ok(None)`。现有证据不足以确认 headless 走 vault 路径时的实际报错内容。
- 建议：明确 headless 的凭据来源。可以提供显式解锁方式（如从 stdin 读主密码，不经命令行参数），或在文档中写明 headless 只支持环境变量，并提示其可见性风险。补一个“vault 锁定 + 无环境变量时报错文案”的测试。

**F-22**
- 严重度：建议
- 位置：`mobile/events.rs` 的 `EventSink`、`DesktopSink`；`terminal/io_commands.rs` 的 `read_loop_local`；`terminal/ssh_start.rs` 的退出闭包
- 问题：`EventSink` 只有 `DesktopSink(AppHandle)` 一个实现，调用点只有两处终端退出事件，都直接构造 `DesktopSink(app)`。trait 没有起到“双模式同契约”的抽象作用。headless 下移动路径实际靠 `Option<AppHandle>`（`core.app()`）分支规避桌面事件，而不是通过 sink 适配。TASK-01 要求的 EventSink 盘点，在代码里看不到覆盖 chat、权限等事件的清单。
- 证据：
  - 【代码】`events.rs` 中只有一个 impl；diff 中的两处调用。
  - 【无证据】`chat_stream_inner` 等在 `app == None` 时如何处理桌面事件，不在证据范围。
- 建议：二选一。补一个 headless sink（no-op 或写日志），把移动路径上的桌面事件统一经过 sink；或删掉 trait，在文档中如实写明“以 `Option<AppHandle>` 分支实现”，并列出 headless 下被跳过的事件。

**F-23**
- 严重度：重要（待核实）
- 位置：`mobile/agent_view.rs` 的 `stop`（`term:` 分支）；`io_commands::send_terminal_signal_inner`
- 问题：unix 下对终端执行 stop，会调用 `send_terminal_signal_inner(state, tid, "SIGINT")`。
  - 本地终端走 `send_local_signal(child, ...)`。`child` 是 PTY 中的 shell 进程。若该函数只对 shell 的 PID 发信号、而不是对前台进程组发，交互式 shell 通常会忽略 SIGINT，前台命令收不到。
  - SSH 走 channel signal 请求，部分服务端不处理该请求。
  - 非 unix 分支写入 `0x03`，经过 PTY 行规程送达前台进程组。两个平台的语义不一致。
- 证据：
  - 【代码】`stop` 的 `cfg(unix)` 与 `cfg(not(unix))` 两个分支。
  - 【无证据】`send_local_signal` 是否使用 `killpg` 或 `tcgetpgrp`，不在证据范围。现有证据不足以确认 unix 下 stop 是否实际无效。上面关于 shell 忽略 SIGINT、SSH 服务端行为的描述属通用知识。
- 建议：所有平台统一改为写入 `0x03`（与 Ctrl-C 键条一致）；或确认 `send_local_signal` 发往前台进程组。补一个“`sleep 100` 被移动端 stop 中断”的真实 PTY 测试。另见第 4 节追加发现：stop 不检查写权。

**F-24**
- 严重度：重要
- 位置：`pty_broker::Broker::exit`；`Broker::subscribe`
- 问题：`exit` 把 `running` 置为 false，同时 `replay = Replay::default()`、`chunks.clear()`、`bytes = 0`。此后新 viewer 订阅只能拿到空的 `replay` 帧加 `exit` 帧，看不到退出前的最后输出。这与 DEC-04 / §4.2 的“已退出显示最后输出尾部”冲突。对排查“命令为何退出”这一主要移动场景影响直接。
- 证据：【代码】`exit` 函数体；`subscribe` 在 `!t.running` 时追加 `exit` 帧，但 `lines` 已被清空。`pty_broker` 单测只覆盖运行中的终端。
- 建议：`exit` 只停止接收输出、保留 replay，在 `remove` 和 `disable` 时再清空。补一个“退出后新订阅仍能拿到尾部”的单测。

**F-25**
- 严重度：建议（待核实）
- 位置：`ssh_start.rs` 的退出闭包；`io_commands.rs` 的 `read_loop_local`；`Broker::exit`、`Broker::remove`
- 问题：
  - SSH 结束路径只调用 `outputs.broker.exit(&sid)`，不调用 `remove`。从现有 diff 看，本地 `read_loop_local` 也是一样，两条路径对称。条目会以 `exited` 状态留在 `broker.terminals` 中，直到 `close_terminal` 调用 `remove`。如果某些退出场景下桌面不调用 `close_terminal`，条目会一直存在，列表中持续显示已退出终端。
  - 附带：`exit` 末尾的 `self.changed(id, "exited")` 不在 `if let` 内。`close_terminal` 先 `remove`（内部会调 `exit`），读循环结束后再次 `exit`，会对已删除的终端再发一次 `session_changed/exited`。
- 证据：
  - 【代码】两处退出路径只有 `exit`；`exit` 中 `changed` 的位置。
  - 【无证据】桌面在 SSH 或本地终端自然结束后是否总会调用 `close_terminal`，不在证据范围。现有证据不足以确认残留是永久的还是暂时的。
- 建议：明确“已退出”条目的生命周期（例如退出后保留 N 分钟或最多 M 条）；`exit` 只在条目存在时发布 `changed`。

**F-26**
- 严重度：建议
- 位置：`streams::events`；`streams::run`（构造 `hello`）；`live.ts` 的 `onmessage`
- 问题：`events` 在升级前订阅 `rx`，而 `hello.event_seq` 在 `on_upgrade` 之后的 `run` 中才读取 `s.runtime.events.seq()`。两者之间发布的事件已经进入 `rx`，且 seq 不大于 `event_seq`。客户端首连时设 `sequence = event_seq`，随后按 `frame.seq <= sequence` 丢弃这些事件。代码注释“Subscribe before hello/sequence snapshot: no event can fall in the gap”的意图没有实现：快照晚于订阅，正好造成这段窗口。实际影响有限，因为 `InstanceView` 收到 `hello` 后会做一次全量刷新。但对依赖增量帧的逻辑来说是错误的。
- 证据：【代码】订阅、`resume` 计算、`hello` 构造三者的先后顺序；客户端的过滤条件。
- 建议：订阅时在 `buffer` 锁内同时取得 seq 快照，作为参数传给 `run`；或让客户端首连时不按 `event_seq` 过滤。

**F-27**
- 严重度：重要
- 位置：`mobile-web/src/PairForm.tsx` 的 `Scanner`
- 问题：扫码完全依赖 `window.BarcodeDetector`，没有就只提示“当前浏览器不支持扫码”。按通用知识，iOS Safari 默认不提供 `BarcodeDetector`，iOS 用户的 AC-01 扫码路径因此不可用，只能手动输入一个 32 位十六进制码。另外，扫码按钮只在 `isSecureContext` 下显示，HTTP 局域网场景本来就没有扫码。
- 证据：
  - 【代码】`ctor` 检测与降级文案；`vite.config.ts` 的 `target` 含 `safari16`，说明 iOS 是目标平台。
  - 【文档】真机与相机权限未验证。
  - 【无证据】桌面端二维码载荷是否就是 `{endpoint, pairing_code}` JSON，桌面生成侧代码不在证据范围。
- 建议：引入纯 JS 解码器作为降级（版本锁定），或在文档与 UI 中把手动输入列为 iOS 的主路径。真机验收时把 iOS 扫码列为单独一项。

**F-28**
- 严重度：建议
- 位置：`mobile-web/public/manifest.webmanifest`；`sw.js` 的预缓存清单
- 问题：manifest 只有一个 `icon.svg`，`sizes: "any"`，`purpose: "any maskable"`。按通用平台要求：iOS 主屏图标使用 `apple-touch-icon`（PNG）；部分 Android / Chromium 版本的安装判定需要 192 与 512 的位图；`any` 与 `maskable` 合用同一图标会导致裁切不当。AC-13 的“可安装”因此存在平台风险。
- 证据：
  - 【代码】manifest 原文；`vite.config.ts` 预缓存的文件只有 `icon.svg`。
  - 【无证据】`index.html` 是否声明 `apple-touch-icon`。
  - 【文档】真实安装未验证。
- 建议：补 192/512 PNG 与单独的 maskable 图标，并加上 `apple-touch-icon`；安装验收按平台分别记录。

**F-29**
- 严重度：重要
- 位置：`file_view::diff`（pathspec）；`file_view::file`（打开顺序）；`file_view::git`（子进程创建）
- 问题：三个独立的小缺口，同属文件访问层。
  - pathspec 未字面化：`relative` 拒绝 `:`，所以 `:(...)` 这类 magic 前缀进不来。但 `*`、`?`、`[` 默认仍按通配解析。`diff` 对不存在的路径（如 `*`）只校验父目录，随后 `git diff -- *` 会返回根下所有文件的 diff，绕过了逐路径的 `resolve` 与符号链接检查。范围仍限于根内。
  - FIFO：`file` 先 `File::open(target)`，再检查 `metadata().is_file()`。根内若存在 FIFO，open 会阻塞在 tokio blocking 线程上，没有超时。反复请求会耗尽 blocking 线程池，飞书 `file` 命令也会卡住业务循环（见 F-46）。
  - Windows 控制台：`tokio::process::Command::new("git")` 没有设置 `CREATE_NO_WINDOW`。GUI 子系统进程拉起控制台程序时，可能闪出窗口。
- 证据：
  - 【代码】`diff` 的分支逻辑与 git 参数中没有 `--literal-pathspecs`；`file` 中 open 先于 metadata；`git` 中没有 `creation_flags`。
  - Windows 是否实际闪窗、FIFO 阻塞时长，均未实测。现有证据不足以确认具体现象。
- 建议：`git` 加 `--literal-pathspecs`（或设 `GIT_LITERAL_PATHSPECS=1`）；`file` 先用 `metadata` 或 `symlink_metadata` 判断 `is_file`，再以非阻塞方式打开并加超时；Windows 下设置 `CREATE_NO_WINDOW`。

**F-30**
- 严重度：建议（待核实）
- 位置：`build.rs`（生成 `mobile_assets.rs`）；`server::static_file`
- 问题：前文模块分析提到的线索为“资源目录缺失时静默嵌入空集合”。`build.rs` 不在现有证据中，现有证据不足以确认其行为细节。证据范围能确认的只有后果：若 `ASSETS` 为空，`static_file` 对所有路径返回 404，移动服务的 API 正常而页面全白，且没有任何构建期或运行期提示。`vite.config.ts` 的输出目录 `src-tauri/resources/mobile-web` 是被忽略目录（P0 文档），从干净检出直接 `cargo build`，就有可能走到这一路径。
- 证据：
  - 【代码】`include!(concat!(env!("OUT_DIR"), "/mobile_assets.rs"))` 与 `static_file` 的遍历逻辑。
  - 【无证据】`build.rs` 原文。
- 建议：资源缺失时在 release 构建中失败，至少发出 `cargo:warning`；`/health` 中报告外壳是否可用。

**F-31**
- 严重度：重要
- 位置：`pty_broker.rs` 全部方法；`events.rs` 的 `publish`、`seq`、`resume`；`terminal/output.rs` 的 `send_terminal_output`；`io_commands::write_terminal`、`resize_terminal`
- 问题：broker、events、auth 普遍使用 `.lock().unwrap()`。桌面热路径已依赖 broker：
  - `send_terminal_output` 在 PTY 读线程上先调用 `broker.output`；
  - `write_terminal`、`resize_terminal` 先调用 `broker.gate` 和 `broker.desktop`。
  
  只要任何持有 `broker.terminals` 锁的代码 panic，锁就被毒化，此后桌面每次键入和每次输出都会 panic，桌面终端整体失效。设计要求移动侧故障不影响桌面，但这里的隔离只靠“当前代码不太会 panic”，不是结构性的。`session_view` 对锁使用了 `map_err`，与其他模块口径不一致。
- 证据：【代码】上述各处的 `unwrap`；diff 中 `send_terminal_output` 的第一行就是 `outputs.broker.output(...)`。目前锁内可能 panic 的点较少（例如 `events.rs` 中的 `as_u64().unwrap()`，按构造恒有 seq），但没有测试覆盖。
- 建议：broker 与 events 改用不会毒化的锁，或统一 `unwrap_or_else(|e| e.into_inner())`；桌面路径上对 broker 的调用失败时降级为跳过移动扇出。

**F-32**
- 严重度：建议
- 位置：`server::origin_allowed`；`server::cors`；`server::router`
- 问题：服务不校验 Host 头。同源判定只比较 `Origin` 的 authority 与 `Host`。DNS rebinding 时（例如 `evil.example:8787` 解析到 127.0.0.1），两者相同，业务端点的 Origin 检查会放行。业务端点仍需要 Bearer，所以无法读取业务数据。剩余面有两处：
  - `/health` 泄露 `run_mode`；
  - `/pair` 可被反复尝试。来源 IP 是回环地址，5 次即可锁住本机来源 5 分钟，与 F-18 叠加。
  
  另外，公共端点的 CORS 本就回显任意 Origin，任何网页在浏览器允许的前提下（PNA 未实测）都可以跨域调用 `/pair`。rebinding 主要多出的是绕过 PNA 这一层。
- 证据：【代码】`origin_allowed` 只做 authority 与 Host 的比较；路由层没有 Host 白名单；`cors` 中 `public` 分支不检查 Origin。
- 建议：按绑定地址与已配置的 endpoint 建立 Host 白名单，不匹配直接拒绝；公共端点只对白名单内的 Host 回显 Origin。

**F-33**
- 严重度：建议
- 位置：`pty_broker::Broker::holder`、`desktop`、`control`
- 问题：持有者只有 `mobile:<device>` 与 `none` 两种取值。桌面抢回后状态是 `none` 而不是 `desktop`，手机可以立即再次 `take-control`，不知道桌面刚刚在输入。UI 只显示“只读”，用户无法区分“无人控制”和“桌面正在使用”。设计对照表 DEC-10 指出持有者取值没有 `desktop`；设计原文不在证据范围，以设计对照表为准。
- 证据：
  - 【代码】`holder()` 的两个分支；`desktop()` 只发送 `control-lost` 与 `holder:"none"`。
  - 【无证据】设计中持有者取值的具体定义。
- 建议：桌面输入后设置 `desktop` 持有态，保留一个宽限期；或在 `control` 帧中附带“桌面最近活动时间”，并在接管确认文案中展示。

**F-34**
- 严重度：建议
- 位置：`Broker::exit`、`Broker::subscribe`（`code: null`）；`Broker::control`（`take=false` 分支）；`streams::run` 尾部；`local_start.rs` 的三处 `get_size().ok()`
- 问题：两个独立的小缺口，按清单合在同一编号。
  - exit code 恒为 null：`exit` 与 `subscribe` 都写死 `"code": null`，客户端无法区分正常退出与异常退出。
  - 释放时无尺寸记录不写日志：`desktop()` 在 `desktop_size` 为 None 时会 `log::warn!`。但 `control(.., false)` 释放分支直接返回 `t.desktop_size`（None），调用方 `if let Ok(Some(..))` 不 resize，也不记录。结果是 PTY 保持手机尺寸，桌面尺寸没有恢复，且无任何痕迹。三条本地创建路径用 `get_size().ok()` 取初始尺寸，失败时 `desktop_size` 就是 None。
- 证据：【代码】上述函数体。
- 建议：退出路径把实际退出码传给 `exit`（读循环能拿到时）；`control` 释放分支在 `desktop_size` 为 None 时同样记录日志，并发送“尺寸未恢复”提示帧。

**F-35**
- 严重度：建议
- 位置：`session_view::detail`
- 问题：Agent 详情固定返回 `"tools": []`。TASK-03 要求的工具投影没有做，字段存在却恒为空，客户端无法据此展示“正在调用什么工具”。`api.ts` 的 `Detail` 类型也没有声明 `tools`，前后端都没有使用这个字段。
- 证据：【代码】`detail` 的 json 字面量；`api.ts` 的 `Detail` 接口。
- 建议：投影当前轮次的工具名与状态（不含参数），或移除该字段并在文档中标为未实现。

**F-36**
- 严重度：重要（待核实）
- 位置：`lib.rs` 的 `run`（`setup` 与退出事件处理）；`MobileRuntime::stop`；`im_adapter::Runtime::stop`
- 问题：现有 `lib.rs` diff 只新增了 `pub mod mobile` 和 `ModeLease` 的 manage，没有在 `RunEvent::Exit` 或窗口关闭时调用 `mobile.stop()`。若其他文件中也没有，桌面退出时：
  - 飞书“已停止，实例可能离线”通知不会发出，AC-17 的主动停止场景只在用户手动停止时成立；
  - `auth.flush()` 不执行，`last_used_at` 丢失（设备增删时已经落盘，影响限于使用时间）；
  - 已连接的手机只能靠心跳超时发现离线。
- 证据：
  - 【代码】lib.rs diff 中没有 stop 调用。
  - 【无证据】`shutdown.rs` 或窗口关闭处理中是否另有调用，不在现有 diff 范围内。现有证据不足以完全确认缺失。
- 建议：在退出事件中以有界超时（如 3 秒）调用 `mobile.stop()`；补一个原生用例“桌面退出时飞书收到停止通知”（可用 loopback fixture）。

**F-37**
- 严重度：重要（设计偏差，需签字）
- 位置：`im_adapter/actions.rs` 的 `authorize`、`dispatch`；`im_adapter/mod.rs` 模块注释
- 问题：
  - 鉴权口径：飞书动作直接调用 `session_view`、`agent_view`、`file_view`，不经过 `server::authenticated`。鉴权依据是 app_id、open_id 与 chat_id 白名单、事件时效，加上 TLS 长连接。这本身是一种身份校验，但与设计 §4.4 “IM 进程内调用仍须鉴权”的口径不同。具体后果有三：
    - 吊销全部移动设备不会影响飞书；
    - 飞书操作不出现在设备列表与 `last_used_at` 中；
    - 没有统一的“谁做了什么”记录。
  - webhook：入站 webhook 未实现。P1 文档给出的理由是长连接已支持卡片回调，无需不带签名校验的 fallback。理由成立，但它改变了设计的交付面，需要以决策形式回填。
- 证据：
  - 【代码】`dispatch` 中直接调用三个 view；`allows` 的判断条件；模块注释“no public webhook ingress”。
  - 【文档】P1 文档对 webhook 的说明。
- 建议：在设计中新增或修订决策，明确“IM 主体以白名单鉴权”；把每组绑定作为可吊销主体纳入设置中的设备列表，或至少提供“一键停用飞书动作”。webhook 的取舍写入 DEC-07。

**F-38**
- 严重度：重要
- 位置：`mobile-web/`（测试缺失）
- 问题：设计要求的 Mobile Web Vitest 在现有包中找不到。`vite.config.ts` 没有 test 配置，也没有任何 `*.test.ts(x)`。F-01、F-02、F-05、F-26 都是 `live.ts` 中的纯客户端逻辑，正好是单测最容易覆盖的部分，目前只有端到端 fixture（TC-MOBILE-001）。P0 文档中的“settings Vitest 21 tests”和 P1 文档中的“16/16”都是桌面设置测试，不是 mobile-web 的。
- 证据：【无证据】现有证据中找不到 mobile-web 测试文件。仓库其他位置是否存在，现有证据不足以确认。
- 建议：为 `live.ts` 补单测，至少覆盖：重连 seq 重置、`instance_id` 变化、`resync` 处理、CORS 失败分类、不存在终端停止重连。同时补 `api.ts` 的错误映射测试，纳入 CI。

**F-39**
- 严重度：建议
- 位置：`MobileRuntime::stop`；`MobileRuntime::start`；`Auth::load`
- 问题：`stop` 只调用 `auth.flush()`，不清除 `Auth.code`。`start` 中的 `auth.load` 只重载 `devices`，同样不动 `code`。用户关闭服务、以为配对码已作废，若在 5 分钟内重新开启，旧码仍然有效。桌面设置页的“5 分钟到期清除”只是 UI 显示层面的处理。
- 证据：【代码】`stop`、`load`、`pairing_code` 中 `code` 的读写位置。
- 建议：在 `stop` 或 `start` 中把 `code` 置为 None，并补一个“停止后重启，旧码失效”的测试。

**F-40**
- 严重度：合并前必须修复（文档更正）
- 位置：P0 实现文档 “契约与安全参数”；`auth.rs` 的 `Auth.tickets`、`save`
- 问题：文档写“设备列表和票据保存在实例 profile”。代码中票据只存在于内存中的 `HashMap`。`save` 只序列化 `self.devices`，票据从不落盘，进程重启后全部失效（这也是正确的行为）。
- 证据：【代码】`save` 只写 `devices`；`tickets` 字段没有任何持久化逻辑。
- 建议：改为“设备列表保存在实例 profile；WS 票据仅存于内存，60 秒单次有效”。

**F-41**
- 严重度：合并前必须修复（文档更正）
- 位置：P0 实现文档 “契约与安全参数”；`auth::pair`
- 问题：文档写“失败按真实对端 IP 限 5 次 / 5 分钟”“来源上限 1024”。代码实际是：
  - 每次尝试（含成功）都计数（F-16）；
  - 来源表满 1024 时全局拒绝（F-17）；
  - 经反向代理时退化为全局 5 次（F-18）。
  
  文档没有体现后两点，读者会误以为限流只影响攻击者。
- 证据：【代码】`attempt.1 += 1` 位于校验码之前；`failures.len() >= 1024` 分支。
- 建议：按实际行为改写；如果修复了 F-16、F-17，则按修复后的行为改写，并补充反向代理下的限流说明。

**F-42**
- 严重度：合并前必须修复（文档更正）
- 位置：P1 实现文档 “交付范围” 的 headless 段；`headless::serve`
- 问题：文档写 headless“可通过进程环境临时提供密钥，或使用已解锁 vault 中的引用……不擅自解锁 vault”。headless 进程中没有任何代码会让 vault 进入“已解锁”状态（F-21），这句话描述了一个 headless 自己无法达到的前提。如果 `Vault::open` 会经系统钥匙串自动解锁，这句话可能成立，但证据范围无法确认。
- 证据：
  - 【代码】`serve` 中没有 unlock 调用。
  - 【无证据】`Vault` 的锁定语义。
- 建议：如实写明“headless 不提供解锁手段，当前只能使用环境变量”；或在实现解锁路径后再保留原表述。

**F-43**
- 严重度：合并前必须修复（文档更正）
- 位置：P0 实现文档 “验证记录” 表的 V-07 两行
- 问题：P0 文档 V-07 第一行的内容是 Git worktree / staged / deleted diff、大文件、二进制、越界、无终端文件事件，加上 settings Vitest，属于 AC-15 文件与 diff 的验证。按第 2.4 节的对照，设计中的 V-07 是 headless 无 Display、桌面回归与 `desktop_required`。文档的 V 编号与设计已经漂移，读者无法按编号核对。另外，“Rust 真实 Git worktree/staged/deleted diff”测试在现有 `file_view.rs` 中只有路径边界一个单测。`service_tests`、`task_tests` 不在证据范围，这些测试的存在【无证据】。
- 证据：
  - 【文档】P0 文档表格原文。
  - 【代码】`file_view.rs` 的 tests 模块只有 `path_boundary_rejects_traversal_absolute_and_symlink_escape`。
  - 设计中 V-07 的原文不在证据范围，以设计对照表为准。
- 建议：按设计 V-01～V-08 重新映射验证表，每一行写明对应的测试名与所在文件。

**F-44**
- 严重度：重要（待 V-08 验证）
- 位置：`im_adapter/actions.rs` 的 `authorize`（`card.action.trigger` 时 `timestamp / 1000`）
- 问题：代码假设卡片回调的 `create_time` 以微秒为单位，除以 1000 后与毫秒时间比较。若真实平台给的是毫秒，除后的值约为 1.7e9，远小于 `now - 600_000`（约 1.7e12），所有卡片按钮都会被判为过期。worker 对这类拒绝回 `accepted=true`，toast 为“无权限或回调已过期”，确认点无法经卡片作答，也很难从表象定位原因。测试 fixture 由同一假设构造，无法发现这个问题。
- 证据：
  - 【代码】除以 1000 的分支；worker 中 `Err(_)` 分支的 toast 与 `rejected += 1`。
  - 【文档】“消息时间为毫秒，卡片回调时间为微秒”，依据是文档与 SDK 阅读。
  - 未经真实飞书验证（V-08 未执行）。
- 建议：按数量级判定单位（例如大于 1e14 视为微秒），或同时接受两种单位；V-08 中把“卡片按钮实际可作答”列为必测项。

**F-45**
- 严重度：重要
- 位置：`actions::dispatch` 的 `show`、`file` 分支；`worker::delivery`
- 问题：`show` 返回最近一条助手结果（最多 1201 字符，再经 `bounded` 截到 1200）；`file` 返回任意根内文本文件的前 1200 字。两者都经 `open.feishu.cn` 发往绑定会话。这是把本机数据发往第三方平台；绑定会话若是群聊，所有群成员可见（P1 文档承认通知对群成员可见）。与 F-09 叠加时，白名单用户一条命令就能把根下的凭据文件片段（如 `~/.ssh/` 中的文件，若根是家目录）发进飞书。`show` 对 `redacted` 消息做了隐藏，这一点是到位的。
- 证据：
  - 【代码】两个分支的返回值直接进入 `Outbound::text`；`file_view::file` 没有敏感路径排除。
  - 【无证据】`FeishuAdapterSettings` 是否提示数据外发，设置页源码不在证据范围。
- 建议：`file` 默认关闭，在设置中显式开启；`show` 与 `file` 只对私聊绑定生效；继承 F-09 的敏感路径拒绝；设置页明示“内容会发送到飞书服务器”。

**F-46**
- 严重度：重要
- 位置：`im_adapter/worker.rs` 的 `business`
- 问题：`business` 在同一个 `select!` 中处理命令与事件。处理命令时 `actions::execute(...).await` 会占住循环：`list`、`show` 要拿数据库锁，`file` 可能阻塞（F-29 的 FIFO），`stop` 要等 `stop_thread_runtime_inner`。这期间事件订阅不被消费。`Events.tx` 容量只有 200，与 F-07 的 `file_changed` 洪泛叠加时很快 Lagged。Lagged 时只调用 `runtime.error("feishu_event_gap_query_list")`，丢失的 `turn_finished` 或 `awaiting_confirmation` 不会补发，用户收不到完成或确认通知。
- 证据：【代码】`business` 的循环结构与 Lagged 分支；`events.rs` 中 `broadcast::channel(200)`。
- 建议：命令处理改为有界并发的独立任务；事件订阅侧先过滤，只保留 `task_status`；Lagged 后根据 `task_summaries` 与 `confirmations` 做一次对账补发。

**F-47**
- 严重度：建议
- 位置：`agent_view::message`（`text.len() > 32768`）；`TaskView.tsx`（`maxLength={32768}`）；`server::router`（`DefaultBodyLimit::max(64*1024)`）；`api.ts` 的 `request`；`actions::authorize`（`command.len() > 8192`）
- 问题：三处口径不一致。
  - 服务端按 UTF-8 字节限 32768；前端 `maxLength` 按 UTF-16 码元限 32768。中文约 1.1 万字就超出服务端上限，前端却允许输入到 3.2 万字。
  - 3.2 万中文字约 96 KiB，超过 64 KiB 的 body 上限。axum 返回的 413 不是 JSON，`response.json()` 抛异常，被映射为 `connection_failed`，提示“检查网络”，误导用户。
  - 飞书命令超过 8192 字节时，`authorize` 返回错误。worker 把它当作“拒绝”计数，消息场景下不给用户任何回复。
  
  P0 文档写“REST/WS 输入上限 64 KiB”，与 32 KiB 的消息上限也不一致。
- 证据：【代码】上述各处常量与错误映射。
- 建议：统一按字节定上限；前端按 `TextEncoder` 计算字节并提示；`request` 对非 JSON 的错误响应按状态码映射（413 映射为 `message_too_large`）；飞书超长命令回复明确的错误文本；文档同步更正。

---

**F-48**
- 严重度：重要
- 位置：`server::stop`、`agent_view::stop` 的 `term:` 分支
- 问题：`POST /sessions/{term:..}/stop` 只做 `authenticated`。`agent_view::stop` 的 `term:` 分支不调用 `ensure_holder`，只读设备可以向终端发 SIGINT 或写入 `0x03`，绕过 DEC-10 的单写者约束。
- 证据：【代码】`server::stop` 与 `agent_view::stop`。
- 建议：在 `term:` 分支同样调用 `ensure_holder`，只读设备不得停止终端；补只读设备调用停止被拒绝的用例。

## 4. 安全核查

**配对与鉴权**
- 到位：
  - 【代码】码 122 位、300 秒、单次有效；只存 SHA-256 哈希，`subtle` 常量时间比较。
  - 业务 handler 一律先 `authenticated`。
  - 删除设备文件即吊销；`consume_ticket` 校验设备仍存在；WS 循环与 `terminal_command` 在 gate 内复查设备。
- 缺口：
  - token 无有效期（F-13）。
  - 限流计入成功配对，且可被填满、经代理退化为全局（F-16、F-17、F-18）。
  - 停止服务不清除配对码（F-39）。
  - 不校验 Host（F-32）。
- 终端 stop 绕过单写者约束（F-48，见发现清单）。

**token 与票据**
- 到位：
  - 【代码】token 只放在 Authorization 头，`credentials: "omit"`。
  - WS 只使用 60 秒单次票据，并绑定 Origin；Origin 不匹配时票据也会被 `remove` 消耗掉。
  - CSP 的 `script-src 'self'` 限制了 localStorage 中 token 被 XSS 读取的面。
- 缺口：
  - 票据出现在查询串中，用户自备的反向代理访问日志可能记录（单次加 60 秒有效，风险低），文档未提示。
  - 票据全局上限 1024：任一已配对设备反复申请即可让其他设备在 60 秒内得到 `rate_limited`（属已鉴权主体的 DoS，低）。
  - 文档“票据保存在 profile”不实（F-40）。

**两级 CORS**
- 到位：
  - 【代码】公共端点回显 Origin；业务端点只放行同源或已配对 Origin。
  - 不使用 `*`，不发 Allow-Credentials，设置 `Vary: Origin`。
- 缺口：
  - 被拒响应不带 ACAO，浏览器读不到错误码，导致吊销后旧 token 无限重试（F-02）。
  - 同源判定依赖未校验的 Host（F-32）。
  - 没有 Origin 的请求一律放行。对非浏览器客户端这是合理的，但文档没有说明。

**WS 握手**
- 到位：【代码】要求 Origin 存在且被允许，消费绑定票据，`max_message_size` 64 KiB，4001 吊销关闭码，90 秒无活动断开，Lagged 即断开。
- 缺口：
  - 终端不存在时在升级前返回 404，客户端无限重连（F-05）。
  - `hello.event_seq` 晚于订阅（F-26）。
  - 恶意 Origin 握手无测试【无证据】（V-06）。

**限流**
- 缺口：
  - 只对 `/pair` 限流，见 F-16～F-18。
  - Bearer 失败不限流。token 约 244 位，无法暴力猜测；但每次 `unauthorized` 都 `log::warn!`，存在日志放大。
  - headless 下失败计数不可见（F-10）。

**日志脱敏**
- 到位：【代码】配对失败只记录来源 IP 与计数；`ApiError` 只记录错误码；飞书拒绝事件不记录内容；`auth.rs` 注释与实现一致。
- 缺口：
  - 没有任何脱敏测试【无证据】。
  - headless 没有日志后端（F-10）。
  - 未限速的拒绝日志可被刷屏。

**飞书白名单与凭据**
- 到位：
  - 【代码】app_id、open_id 与 chat_id 成对校验，事件时效 10 分钟 / 1 分钟。
  - 消息与卡片分别去重，先登记后执行。
  - `secret_ref` 强制沿用旧值，前端拿不到密钥；token 使用 `Zeroizing`。
  - WS 端点限定 `wss://*.feishu.cn`；禁止重定向；响应上限 512 KiB。
- 缺口：
  - 白名单代替 Bearer，不可从设备列表吊销（F-37）。
  - 卡片时间单位未验证，可能使所有按钮失效（F-44）。
  - 助手结果与文件内容外发（F-45）。
  - 无法删除已存密钥。
  - headless 凭据来源受限，环境变量对同用户可见（F-21）。

**文件根与符号链接**
- 到位：
  - 【代码】`relative` 拒绝绝对路径、上跳、`\`、`:`、NUL；根与目标都 canonicalize 后按组件比较。
  - 删除文件时校验父目录；git 禁用 ext-diff、textconv、pager；256 KiB 上限与 10 秒超时。
- 缺口：
  - 根可能是家目录或 `/`（F-09）。
  - porcelain 路径基准错误（F-03）。
  - 根可能被手机或飞书的后续指令清除（F-08）。
  - pathspec 通配、FIFO 阻塞（F-29）。
- 补充两点理论风险：
  - canonicalize 与 open 之间存在 TOCTOU：根内有写权限的本地进程可以在两步之间把目录替换为符号链接。
  - `git status` 会执行仓库配置中的 `core.fsmonitor` 等钩子，手机可以远程触发这些钩子的执行。前提是仓库本身已不可信，风险低，但值得在文档中说明。

**代理配置**
- 到位：【代码】reqwest 使用 `no_proxy()`，再按显式代理配置；`socks5h` 远端解析；custom 模式强制启用；none 模式显式直连；代理失败不回退直连。
- 缺口：
  - app 模式读取 `default_app_proxy_path()`，不随 `--data-dir` 变化，headless 的 profile 隔离不完整（与 F-20 同源）。
  - WS 经 `establish_transport` 走代理时是否远端解析 DNS【无证据】。
  - 移动 listener 侧没有可信反向代理配置（F-18），也没有 Host 白名单（F-32）。

---

## 5. 过度承诺核查

以下结论在实现文档中以“通过 / 已验证 / 已核实”出现，但现有证据无法直接证实，或与代码相矛盾。

**CI 与测试计数**
- 【文档】P0 的“56/56 通过”针对提交 `abfa5e18…`，不是分支头 `d813defe…`；P1 修改过 P0 代码路径，这份证据不能覆盖分支头。
- 【文档】P1 的 `41260611701` 仍在执行中；`41258424343` 的 native TC-MOBILE-004 失败，文档自己也声明不计为通过。分支头没有可核对的 CI 通过记录。
- 【文档】`cargo test --lib mobile:: 18/18`、“Rust 契约 41/41”、“Settings Vitest 16/16”、“最新移动 Rust 集合 12 项”都只是计数，证据范围不含 `service_tests`、`task_tests`、`network_tests` 原文，无法逐项核对。V-07 行列出的 Git diff 测试也找不到（F-43）。

**V-08 与飞书**
- 【文档】V-08 未执行，文档如实说明。
- 以下结论均依赖 loopback fixture 或文档阅读，没有真实平台证据：
  - 协议字段编号“与官方 SDK 一致”；
  - 卡片回调时间为微秒（F-44）；
  - 长连接可接收卡片回调；
  - 实际通知与卡片到达。
- “HTTP 每条最多 5 次重试”：【代码】实际是共 5 次尝试，即 4 次重试，属措辞误差。
- “事件缺口在设置中可见”：【代码】`Status.error` 是单值，后发生的错误会覆盖之前的，只能看到最近一次。

**真机、PWA 安装、相机**
- 【文档】Android/iOS 真机、PWA 真实安装、相机扫码均未验证，文档如实说明。
- TC-MOBILE-003 中的“离线外壳”是 Linux Chromium 下的 Service Worker 行为，不等于 PWA 安装。iOS 扫码在代码层很可能不可用（F-27），图标只有 SVG（F-28）。这两项在真机验收前就已有可预见的风险，文档没有提及。

**公共 TLS / PNA 与反向代理**
- 【文档】未验证。没有 HTTPS endpoint 用例（V-04）。
- 文档用“互联网访问使用 TLS”“HTTPS 页面拒绝 HTTP 实例”描述使用方式，但反向代理下限流退化为全局（F-18）、Host 不校验（F-32），文档没有说明这两点。

**Windows / macOS 专项**
- 【文档】三平台 browser/native 的 9/9 是 crash 回归集合，文档已声明“不代表移动服务在三平台均完成专项验收”。
- P0 文档“使用”一节给出 `./taomni --headless` 时未注明平台限制。而 Windows 发布版是 GUI 子系统，配对码输出、Ctrl-C 退出、码轮换在 Windows 下均不可用（F-11）。这一节构成隐含的跨平台承诺。

**与代码不符的表述**（文档写成既成事实，但与代码矛盾或无法支撑）
- 票据保存在 profile（F-40）。
- 限流按失败计数（F-41）。
- headless 可用“已解锁 vault 引用”（F-42）。
- V-07 映射漂移（F-43）。
- “headless……返回 desktop_required”“非隐藏失败”：直连 provider 在 headless 下会静默去掉工具（F-12）。
- “退出显式标记 exited”：成立，但同时清空了回放（F-24）。
- “吊销……页面停止重试并提示重新配对”：只对已建立的 WS 成立；跨域 REST 场景下不成立（F-02）。
- “慢消费者断开后续接”：测试只覆盖到 broadcast Lagged，没有覆盖连接断开（设计对照表 V-03）。
- “REST/WS 输入上限 64 KiB”：消息实际上限为 32 KiB，且按字节计（F-47）。

---

## 6. 合并与后续建议

### 合并前必须完成

与第 1 节 M1～M6 一致，不改变已有结论。

1. 在分支头 `d813defe2641d910d4cc1e01f09831c6830f3bac` 上取得完整 CI 证据：三平台 browser/native、TC-MOBILE-001～004、完整 crash-regression。按 P0 文档的做法核对 selection、raw summary、receipt 与 aggregate，以 0 failed / 0 skipped 为准。M2～M6 修复后需要再跑一轮。
2. 修复 F-01（重连 seq 与 `instance_id`）、F-02（吊销后的 CORS 可读性或判定）、F-03（porcelain 前缀）、F-04（task_status 去重，补“恰好一条”断言）。每项都要有对应的自动化测试。
3. 更正 F-40～F-43 涉及的文档表述，并按设计编号重排验证表。

### 建议在合并前一并处理

这些项不改变第 1 节结论，但修复成本低、或会直接让功能失效。

- F-44：卡片时间单位容错。若假设错误，确认按钮将全部失效。
- F-48：终端 stop 绕过单写者约束，修复只需一行 `ensure_holder`。
- F-39：停止服务时清除配对码。
- F-47：413 被误报为“连接失败”。

### 合并后建议顺序

仅为排序建议，不自动启动任何产品变更。

1. 隔离与稳定性：F-31（锁毒化影响桌面）、F-07 加 F-46（洪泛与飞书 Lagged）、F-15（预留泄漏）、F-05、F-06。
2. 数据暴露面：F-09、F-45、F-29、F-32、F-17、F-18、F-13。先确定根范围与外发策略，再决定 token 有效期。
3. headless 可用性：F-20、F-10、F-11、F-21、F-12、F-22，并补“桌面与 headless 互斥”用例。
4. 体验与语义：F-24、F-23、F-33、F-34、F-25、F-26、F-35、F-08、F-14、F-36。
5. 测试与验收补齐：F-38（mobile-web Vitest）、F-30（资源缺失时构建失败）；然后按 P1 文档“后续建议任务”第 1 项做真机、PWA 安装、iOS 扫码（F-27、F-28）、公共 TLS/PNA、Windows/macOS 专项，并单独完成真实飞书 V-08。
6. 设计回填：F-37（IM 鉴权口径与 webhook 取舍）、F-13（token 有效期）、F-33（持有者取值）。以决策记录形式更新设计文档后，再进入 P1 文档所列的 IM 可靠送达等后续工作。