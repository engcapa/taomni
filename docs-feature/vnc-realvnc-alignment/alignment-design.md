# VNC 客户端与 RealVNC Viewer 对齐设计

## 1. 设计摘要与范围

- 类型：现有 VNC 客户端（`src-tauri/src/vnc/`、`src/components/vnc/`、`src/lib/vnc.ts`）的功能、交互、鼠标键盘和性能对齐。
- 参照：RealVNC Viewer 7.15.1 (r18) Windows 独立版，连接第三方 RFB 3.7 服务器（见[实机参照](references/realvnc-live-audit-20260930.md)）。只对齐 RealVNC Viewer 面向第三方服务器可用的能力；依赖 RealVNC Server 的音频、录制、文件传输、聊天、云连接、SSO 不在本批次（DEC-VNC-05）。
- 基线：Taomni `main` HEAD `383aa4f2`（2026-09-30）。
- 平台：Windows、macOS、Linux Tauri 2 桌面应用。browser 模式只能证明 renderer 分支；RFB 解码、relay、WebView 绘制、输入到线上延迟、剪贴板、全屏必须有 native 或 live-vnc 证据。
- 性能是本批次的阻断级维度：每张涉及数据路径的卡都必须用同一服务器、同一方法给出 Taomni 与 RealVNC 的数字（`live-vnc` + `performance` + `realvnc-comparison`）。

用户要的是 Taomni 的 VNC 会话在功能、交互、鼠标操作、尤其性能上与 RealVNC Viewer 对齐。实测显示 Taomni 已具备 RFB 3.3/3.7/3.8、VNCAuth/RA2/匿名 TLS、Raw/CopyRect/Hextile/ZRLE、ExtendedClipboard、光标伪编码、view-only 和剪贴板方向策略；差距集中在解码/relay 流水线、更新请求节奏、滚轮与右键时序、会话菜单与特殊键、缩放模式、会话信息、连接生命周期和画质选择。

## 2. 目标用户结果

1. 同一台服务器上，Taomni 的全屏刷新、持续更新和指针到线上延迟不劣于 RealVNC；高分辨率 Hextile/ZRLE 更新不丢帧、不触发刷新风暴。
2. 鼠标：左/中/右键、拖拽、滚轮（一格一步、触控板累积、水平滚动）、后退键与 RealVNC 行为一致；右键菜单即时出现；窗口失焦不移动远端指针。
3. 键盘：F8 打开会话菜单，可发送 F8、Ctrl+Alt+Del，锁定 Ctrl/Alt；特殊键直通、AltGr、死键与输入法有明确策略。
4. 视图：Automatic / 适应窗口 / 适应宽度 / 适应高度 / 百分比缩放与保持宽高比；100% 为一个远端像素对应一个设备像素；全屏和工具栏可用。
5. 会话信息显示与 RealVNC 同类字段，并附带 Taomni 流水线计数，可作为性能诊断入口。
6. 连接生命周期（未加密警告、认证框、连接中停止、自动重连、保活）和连接属性（画质、缩放、按键直通、剪贴板）与 RealVNC 对齐且持久化。

## 3. 当前实现与差距（2026-09-30 实测）

| 区域 | 基线事实 | 处理卡 |
|---|---|---|
| 解码读取 | 运行期明文流无用户态缓冲，Hextile 每个字段一次 syscall；全屏 1680×1050 Hextile 回放解码 499 ms（release）。 | VNC-PERF-001 |
| relay 粒度 | 按 tile 产出 `Vec` 与 WS 消息（ZRLE 459 条、Hextile 6 930 条）；Hextile 超过前端 `MAX_PENDING_RECTS=4096` 导致丢帧 → 全量刷新循环。 | VNC-PERF-001 |
| 请求节奏 | `request_update(true)` 只在前端绘制并 ACK 后发送；RealVNC 收到更新后约 10 ms 即发出下一次请求。 | VNC-PERF-002 |
| WebView 绘制 | 主线程 `putImageData`，常驻 rAF；CopyRect 在后端展开为像素。 | VNC-PERF-003 |
| 画质/编码 | 固定 ZRLE>Hextile>CopyRect>Raw、rgb888；无 Picture quality、无 Tight/JPEG、无降色深。RealVNC 在该服务器上 Automatic 选 Hextile+rgb888。 | VNC-PERF-004 |
| 鼠标 | 右/中键按下前等待剪贴板同步 + 120 ms；滚轮每个事件发按下、50 ms 后发释放，无累积、无水平；无后退键；窗口 blur 发送 `pointer(0,0,0)`，远端指针跳到左上角（可能触发热角）。 | VNC-INPUT-001 |
| 特殊键动作 | 无 F8 菜单、无 Send Ctrl+Alt+Del / Send F8、无 Ctrl/Alt 锁定。 | VNC-INPUT-002 |
| 键盘直通与布局 | 按 `KeyboardEvent.key` 映射 keysym；Win/Alt+Tab/PrtScn 被系统拦截；AltGr、死键、输入法组合无策略。 | VNC-INPUT-003 |
| 缩放 | 只有 fit（CSS object-fit）与 1:1 CSS 像素；125% DPI 下 “1:1” 实为 1.25 设备像素，发虚。 | VNC-VIEW-001 |
| 全屏/工具栏 | 标签页内无全屏；独立窗口有 OS 全屏；无顶端自动隐藏工具栏、无多显示器。 | VNC-VIEW-002 |
| 会话菜单 | 无 F8 菜单。 | VNC-SESS-001 |
| 会话信息 | 无；store 只记录尺寸、协议、安全。 | VNC-SESS-002 |
| 连接生命周期 | 无未加密警告、无连接中 Stop、固定 3 次重连、无 KeepAlive 探测。 | VNC-SESS-003 |
| 连接属性 | 会话编辑器只有安全策略、view-only、剪贴板方向。 | VNC-CONN-001 |
| 剪贴板 | 连接时强制同步本地剪贴板（RealVNC `SendInitialClipboard=False`），每 750 ms 轮询；无 “剪贴板作为按键发送”。 | VNC-CLIP-001 |
| 三端收口 | 仅本机 Windows 实测。 | VNC-QA-001 |
| 凭据询问（2026-10-01 VMware 实测） | 没保存密码的会话打开前总弹密码框且不能空提交；只提供 None 的服务器要随便输入一个字符。RealVNC 只在服务器要求时询问。 | VNC-AUTH-002 |
| 首选编码被忽略（同上） | VMware 内置 VNC 只看列表第一项，而且只实现 Raw 与 JPEG Tight：High/Automatic 以 ZRLE 为首时回 Raw，整帧 7.45 MB；Tight 带 JPEG 质量为首时用 Tight。 | VNC-PERF-006 |
| 会话编辑器文案（同上） | VNC 分区的标签、选项与说明写死英文，中文界面不翻译。 | VNC-CONN-002 |

<a id="decisions"></a>
## 4. 设计决定

| DEC | 决定 | 状态 | 依据 |
|---|---|---|---|
| DEC-VNC-01 | 新批次独立任务板（`VNC-<域>-NNN`，`vnc-task` 元数据），脚本 `.agents/skills/vnc-realvnc-task/scripts/task_board.py`。 | agent 自决 | 与 IDEA/DB 批次结构一致，避免混用 ID。 |
| DEC-VNC-02 | 参照固定为 RealVNC Viewer 7.15.1 (r18) Windows 独立版 + 第三方 RFB 3.7 服务器；换版本需新参照修订。 | agent 自决 | 7.x 仍可免费连接第三方服务器；新版 Connect Viewer 需付费计划。 |
| DEC-VNC-03 | 性能对比统一用回环计数代理（线上字节与时间）与录制帧 release 回放（纯解码）；服务器 25 s 认证延迟不计入。 | agent 自决 | 两个客户端同方法、同服务器、同时段才可比。 |
| DEC-VNC-04 | 后端持有权威帧缓冲；relay 以 “damage 合并 + WebView 就绪即发最新像素” 取代 “每个更新一个邮箱帧 + 丢帧后全量刷新”。WS 线协议不变（12 字节矩形头 + RGBA，空消息为帧边界）。 | agent 自决 | 消除刷新风暴且兼容现有前端。 |
| DEC-VNC-05 | 不提供依赖 RealVNC Server 的菜单项（Mute Audio、Record Session、Transfer Files、Chat）；Relative Pointer Motion 推迟到 INPUT-003 评估。 | agent 自决 | 第三方服务器上这些项在 RealVNC 中也不可用。 |
| DEC-VNC-06 | Scaling “Automatic” 定义为 “缩小以适应、不放大”；“适应窗口/宽度/高度” 双向缩放；百分比以设备像素为 100%。 | agent 自决，可推翻 | RealVNC `FitAutoAspect` 首窗按远端尺寸自适应；Taomni 标签页尺寸固定，放大会发虚。 |
| DEC-VNC-07 | 右键即时发送；剪贴板改为指针进入画布/获得焦点时同步，仅中键（X11 粘贴）等待进行中的同步，上限 150 ms。 | agent 自决 | RealVNC 无点击延迟；保留中键粘贴正确性。 |
| DEC-VNC-08 | 滚轮以 100 CSS 像素（行模式 3 行）为一格累积，每格立即发送按下+释放并保留已按下的键；单事件最多 10 格。 | agent 自决 | 对应 RealVNC `ScrollWheelThreshold=120` 的一格一步语义。 |
| DEC-VNC-09 | F8 为会话菜单键（与 RealVNC `MenuKey` 默认一致），菜单内 “Send F8” 发送该键；可配置菜单键归 VNC-CONN-001。 | agent 自决 | RealVNC 默认。 |
| DEC-VNC-10 | 标签页内 “全屏” 使用 Fullscreen API 作用于会话容器；独立窗口使用 OS 全屏。真正的屏幕级全屏与顶端自动隐藏工具栏归 VNC-VIEW-002。 | agent 自决 | 标签页受主窗口约束。 |
| DEC-VNC-11 | 画质预设：服务器支持 Tight 时用 JPEG 质量/压缩等级伪编码实现 High/Medium/Low；只支持 ZRLE/Hextile 时用降色深像素格式；Automatic 依据会话信息的线路速度估计切换。 | P1 已细化（[P1 §2](vnc-p1-batch2-design.md#perf-004)） | RealVNC Picture quality 语义（色深）+ 带宽收益。 |
| DEC-VNC-12 | 按需绘制：帧边界到达才调度一次 rAF，绘制后 ACK。 | agent 自决 | 空闲会话零 rAF 负载。 |
| DEC-VNC-13 | CopyRect 仍在后端帧缓冲内移动；OffscreenCanvas/Worker 不采用。 | agent 自决，可推翻 | 保留截图/GIF 采集源，WKWebView 支持不完整。 |
| DEC-VNC-14 | flate2 使用 zlib-rs 后端。 | agent 自决 | inflate 是 ZRLE 回放的主要成本。 |
| DEC-VNC-15 | 像素格式只在无未完成更新请求时切换，读线程在下一个更新开始时应用。 | agent 自决 | 避免旧格式更新被按新格式解码。 |
| DEC-VNC-16 | Windows 用进程内低级键盘钩子实现特殊键直通；macOS/Linux 不实现。 | agent 自决，可推翻 | RealVNC `SendSpecialKeys=True`；其他端需要系统权限。 |
| DEC-VNC-17 | AltGr 合成的左 Ctrl 不发送；死键发组合结果；本机 IME 不参与。 | agent 自决 | 与 RealVNC fixture 实测对照。 |
| DEC-VNC-18 | 全屏 = OS 窗口全屏 + 固定定位覆盖，不用 Fullscreen API，Esc 转发远端。 | agent 自决 | 与 RealVNC 全屏按键行为一致。 |
| DEC-VNC-19 | 未加密警告在认证前出现；自动重连持续退避；KeepAlive 30/30 s。 | agent 自决 | RealVNC `WarnUnencrypted` / `AutoReconnect` / `KeepAlive*` 默认值。 |
| DEC-VNC-20 | Windows 上指针停在已连接画布上且无按键时，relay 线程每 1–4 ms 读光标位置直接发 PointerEvent；WebView 照常发自己的事件，relay 丢弃采样后 50 ms 内的无按键移动副本；按键、滚轮、拖拽仍走 WebView；macOS/Linux 不启用；`TAOMNI_VNC_NATIVE_POINTER=0` 关闭。 | agent 自决（[PERF-005 §指针](references/realvnc-fixture-comparison-20261001.md#pointer-latency)） | 逐段测量表明 WebView/JS/relay 合计 < 1 ms，延迟与尾部来自 Windows 按显示刷新投递 `WM_MOUSEMOVE`（裸 Win32 窗口同样 p95 ≈ 31 ms）；RealVNC 走同一机制，只有读光标才能稳定低于它。 |
| DEC-VNC-21 | 凭据按需询问：会话没有密码时直接连接；服务器选定的安全类型需要密码时，客户端不回应挑战，以 `credentials-required` 结束这次尝试，由会话内认证表单询问；表单提交的重连沿用这次已确认的未加密警告。 | agent 自决（[VMware 实测 §3](references/vmware-vnc-live-20261001.md)） | RealVNC 只在服务器要求时询问；连接前弹框挡住了只提供 None 的服务器。现有架构每次认证都是新的 TCP 连接，所以“询问后重连”与未加密警告的处理方式一致。 |
| DEC-VNC-22 | 首选的压缩编码被服务器用大块 Raw 回应（≥ 64×64 像素且本次更新没有压缩矩形）时，把下一个候选提到第一位：High 为 ZRLE → Tight（JPEG 质量 9，服务器默认 zlib 级别）→ Hextile，降色深档为 ZRLE → Hextile；候选用尽则保持。Tight 为首仍收到大块 Raw 才认定服务器没有 Tight。 | agent 自决；用户确认可用 Tight + JPEG（2026-10-01） | 符合规范的服务器按客户端顺序选第一个支持的编码，不会对大块区域回 Raw；只看第一项的服务器（VMware 内置 VNC）只有这样才拿得到压缩编码。探针显示 VMware 对不带 JPEG 质量的 Tight 也回 Raw，最初的无损 Tight 候选因此误判“没有 Tight”，Low 随后改用 8 色像素格式，VMware 收到 RGB111 即重置连接；带 JPEG 质量的 Tight 在完整实现的服务器上仍对不适合 JPEG 的区域发无损子矩形。 |

## 5. 交互与 UI 总体合同

- **所有者**：键盘事件只在会话画布（或其容器）获得焦点时转发；输入框、菜单、对话框打开时不转发。菜单/对话框关闭后焦点回到画布（沿用 `useFocusReturn`）。
- **状态**：connecting / connected / disconnected / error / view-only 各有可见状态；view-only 时输入类菜单项禁用而不是隐藏。
- **不伪装**：服务器不支持的能力（ZRLE2、音频、文件传输）不显示为可用；统计未就绪显示 “正在统计…”。
- **数据契约**：已保存会话、vault 密码引用、代理/SSH 跳板转发、detach claim、剪贴板方向和 view-only 的前后端双重执行必须保留。
- **性能合同**：数据路径改动必须附回放与实测数字；任何改动不得让全屏刷新、持续更新或指针延迟相对基线退化。

## 6. 任务交接

<a id="vnc-perf-001"></a>
### VNC-PERF-001 解码读取缓冲与整矩形 relay

- 交付：运行期明文流 256 KiB 用户态读缓冲（握手阶段保持无缓冲，大负载直读目标）；Raw/Hextile/ZRLE 解码到可复用的整矩形 scratch，再一次性写入权威帧缓冲；每个服务器矩形只产生一个 damage，relay 帧由帧缓冲按 damage 读出（≤16 个矩形，超出合并为包围盒）。
- 主要文件：`src-tauri/src/vnc/{rfb,encodings,framebuffer,live_bench}.rs`。
- 必须保留：ZRLE 单一持久 zlib 流、Hextile bg/fg 跨 tile 继承、CopyRect 越界拒绝、帧缓冲/矩形/压缩长度上限、RA2 安全通道读路径。
- P1 设计：[vnc-perf-001-002-pipeline-design.md](vnc-perf-001-002-pipeline-design.md)。
- 验收：
  - **VNC-PERF-001-A1**：同一批录制帧 release 回放，1680×1050 Hextile 全帧解码 ≤ 60 ms（基线 499 ms），ZRLE 不高于基线 70 ms，Raw 不退化超过 10%。
  - **VNC-PERF-001-A2**：一次全屏更新产生的 relay 矩形数 ≤ 服务器矩形数且 ≤ 16；Hextile 全屏不再触发前端丢帧/全量刷新循环。
  - **VNC-PERF-001-A3**：真实服务器实测全屏刷新（ZRLE、Hextile、Raw）完成时间与 RealVNC 同场景（565–574 ms）相比不劣于 +10%，并记录线上字节。
  - **VNC-PERF-001-A4**：原有 RFB/编码/限额/光标单测全部通过，新增缓冲读、tile 步长、damage 合并和 CopyRect 重叠单测。

<a id="vnc-perf-002"></a>
### VNC-PERF-002 更新请求流水线与渲染背压解耦

- 交付：解码完一个更新立即发送下一个增量请求（WebView 最近 1 s 内 ACK 过或当前空闲）；WebView ACK 时把累积 damage 的最新像素作为一帧发出；隐藏/停滞超过 1 s 暂停请求，下次 ACK 恢复；Refresh 立即从权威帧缓冲重绘并向服务器请求全量；DesktopSize 清空旧帧并整屏重绘。
- 主要文件：`src-tauri/src/vnc/{ws,queue}.rs`。
- 必须保留：WS 鉴权、控制消息优先级、clipboard/光标/bell 顺序、view-only 与剪贴板策略、断线结构化错误。
- P1 设计：[vnc-perf-001-002-pipeline-design.md](vnc-perf-001-002-pipeline-design.md#pipeline)。
- 验收：
  - **VNC-PERF-002-A1**：持续变化画面下，服务器更新间隔不再包含 WebView 绘制与 ACK 往返；代理记录的 “更新数据结束 → 下一个增量请求” 中位数 ≤ 20 ms（RealVNC 中位 2.7 ms、p95 4.3 ms，差值来自解码与 TLS 桥接，须如实记录）。
  - **VNC-PERF-002-A2**：WebView 绘制慢于服务器时不丢像素、不请求全量刷新；隐藏标签页 1 s 后服务器流量停止，恢复可见后首帧包含隐藏期间全部变化。
  - **VNC-PERF-002-A3**：DesktopSize、Refresh、断线、重连路径保持正确，native 实测无画面残缺。

<a id="vnc-perf-003"></a>
### VNC-PERF-003 WebView 绘制路径与 ZRLE 热路径

- 交付：评估并实现三端可用的更快绘制路径（按需 rAF、单帧 ImageData 复用、CopyRect 作为画布内复制、OffscreenCanvas/Worker 可用时启用）；ZRLE inflate 与 palette-RLE 热路径优化。
- 主要文件：`VncPanel.tsx`（或抽出的渲染器）、`src/lib/vnc.ts`、`encodings.rs`。
- 必须保留：帧边界 ACK 语义、尺寸校验、截图/GIF 采集源。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#perf-003)。
- 验收：
  - **VNC-PERF-003-A1**：native 下 1680×1050 全帧从 WS 到画布完成的主线程耗时有测量记录，三种 WebView 各自记录或标注未验证。
  - **VNC-PERF-003-A2**：ZRLE 全帧回放解码 ≤ 35 ms（release）。
  - **VNC-PERF-003-A3**：空闲会话主线程无常驻 rAF 负载。

<a id="vnc-perf-004"></a>
### VNC-PERF-004 Picture quality 与自适应编码

- 交付：Automatic / High / Medium / Low 画质（DEC-VNC-11）；Tight（含 JPEG、四个 zlib 流、filter）解码；质量/压缩伪编码；降色深像素格式；Automatic 按线路速度切换。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#perf-004)。
- 验收：
  - **VNC-PERF-004-A1**：Tight 解码器通过 RFC 向量与真实服务器实测，stream 不失步。
  - **VNC-PERF-004-A2**：限速链路（≤10 Mbit/s）上 Low/Medium 的全屏刷新字节与时间和 RealVNC 同档对比有记录，Taomni 不劣于 RealVNC。
  - **VNC-PERF-004-A3**：画质切换在会话中即时生效并在会话信息中显示实际编码与像素格式。

<a id="vnc-perf-005"></a>
### VNC-PERF-005 指针输入到线上延迟

- 背景：native 同服务器实测，指针移动到线上 PointerEvent 的中位/p95：RealVNC 20.1 / 45.0 ms；Taomni 基线（2026-09-27 debug QA 构建）48.6 / 64.8 ms，PERF-001/002 后 release 52.7 / 65.5 ms——差距在本批次之前已存在。`pointermove` 在 Chromium 中按动画帧对齐，是主要可疑项。
- 交付：WebView2（Chromium）上用 `pointerrawupdate` 发送移动，`pointermove` 在收到 raw 事件后不再重复发送；WebKit（WKWebView/WebKitGTK）保留 `pointermove`；逐段测量 “OS 事件 → JS → WS → relay → 线上” 并处理剩余差距（必要时评估原生输入钩子）。
- 主要文件：`VncPanel.tsx`、`src/lib/vncPointerScheduler.ts`、`ws.rs` 控制路径。
- 验收：
  - **VNC-PERF-005-A1**：Windows native 同服务器、同方法（`vnc_pointer_latency.py --size <PointerEvent 块大小>`，200 ms 间隔 40 次）的中位数与 p95 不高于 RealVNC。
  - **VNC-PERF-005-A2**：拖拽、按键变化和指针捕获不重复、不丢事件（单测 + native）；WebKit 路径行为不变。
  - **VNC-PERF-005-A3**：macOS / Linux 各自记录测量值或标注未验证。

<a id="vnc-input-001"></a>
### VNC-INPUT-001 鼠标按键、滚轮与失焦行为

- 交付：右键即时；中键仅等待进行中的剪贴板同步（≤150 ms）；指针进入画布时同步剪贴板，移除每次移动时的剪贴板读取；滚轮原生非被动监听、刻度累积、水平滚轮（按住 Shift 转水平）、每格按下+释放并保留已按键；后退键映射为 RFB 按键 8；窗口失焦只释放已按下的键和按钮，不再发送 `(0,0)` 指针。
- 主要文件：`src/components/vnc/VncPanel.tsx`、`src/lib/vnc.ts`。
- P1 设计：[vnc-input-view-session-design.md](vnc-input-view-session-design.md#mouse)。
- 验收：
  - **VNC-INPUT-001-A1**：右键按下立即产生 PointerEvent（无定时器）；中键在无进行中同步时同样即时。
  - **VNC-INPUT-001-A2**：一格鼠标滚轮 = 一对按下/释放；触控板小增量累积；水平滚动发送按键 6/7；拖拽中滚动保留按键位。
  - **VNC-INPUT-001-A3**：窗口 blur / 页面隐藏不发送 `(0,0)` 指针，只释放已按下的键和按钮。
  - **VNC-INPUT-001-A4**：native 实测指针移动到线上延迟中位数与 p95 不高于 RealVNC（18.0 / 34.3 ms）。

<a id="vnc-input-002"></a>
### VNC-INPUT-002 F8 菜单键与特殊键动作

- 交付：画布焦点下 F8 打开会话菜单（view-only 也可打开）；菜单 Send F8、Send Ctrl+Alt+Del、Ctrl Key / Alt Key 锁定（锁定键在失焦时保持，关闭连接时清除）；工具栏 Ctrl+Alt+Del 按钮。
- 主要文件：`VncPanel.tsx`、`vncSessionMenu.ts`、`src/lib/vnc.ts`。
- P1 设计：[vnc-input-view-session-design.md](vnc-input-view-session-design.md#special-keys)。
- 验收：
  - **VNC-INPUT-002-A1**：F8 打开菜单且不向远端发送 F8；菜单 Send F8 发送一次 F8 按下/释放。
  - **VNC-INPUT-002-A2**：Send Ctrl+Alt+Del 按 Ctrl↓ Alt↓ Del↓ Del↑ Alt↑ Ctrl↑ 发送；已锁定的修饰键不重复按下/释放。
  - **VNC-INPUT-002-A3**：view-only 下输入类菜单项禁用；native 上 Ctrl+Alt+Del 到达远端（Windows 服务器弹出安全屏或 Linux 服务器收到按键序列）。

<a id="vnc-input-003"></a>
### VNC-INPUT-003 特殊键直通、键盘布局与输入法

- 交付：Pass special keys（Win、Alt+Tab、Alt+Esc、Ctrl+Esc、PrtScn）需要各平台原生键盘钩子的方案评估与实现；AltGr、死键、输入法组合期间的策略；Relative Pointer Motion 评估。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#input-003)。
- 验收：
  - **VNC-INPUT-003-A1**：三端分别记录 Win/Cmd、Alt+Tab、PrtScn 的实际去向，Windows 至少实现可开关的直通。
  - **VNC-INPUT-003-A2**：德/法布局 AltGr 与死键、中文输入法下的按键转发与 RealVNC 对照有结论。

<a id="vnc-view-001"></a>
### VNC-VIEW-001 缩放模式与设备像素 100%

- 交付：Automatic、适应窗口、适应宽度、适应高度、25%–400% 百分比、保持宽高比；画布元素直接取缩放后尺寸（不再用 object-fit 留黑边），坐标映射按画布盒子；大于视口时容器滚动；100% 按 `devicePixelRatio` 映射为设备像素；工具栏 “缩放到 100% / 自动缩放” 切换。
- 主要文件：`src/lib/vnc.ts`（`computeVncDisplaySize`、`normalizeVncScaling`）、`VncPanel.tsx`。
- P1 设计：[vnc-input-view-session-design.md](vnc-input-view-session-design.md#scaling)。
- 验收：
  - **VNC-VIEW-001-A1**：各模式尺寸计算单测覆盖缩小、放大、滚动、拉伸和 DPR 1.25。
  - **VNC-VIEW-001-A2**：任一模式下点击远端同一像素得到相同 RFB 坐标（误差 ≤1 远端像素）。
  - **VNC-VIEW-001-A3**：native 125% DPI 下 100% 模式一个远端像素占一个物理像素，窗口缩放后 Automatic 实时重算。

<a id="vnc-view-002"></a>
### VNC-VIEW-002 屏幕级全屏、自动隐藏工具栏与多显示器

- 交付：标签页会话进入屏幕级全屏（Tauri 窗口全屏 + 容器全屏）；全屏时顶端悬停滑出工具栏（Exit full screen、Scale、Send Ctrl+Alt+Del、菜单、End session），可钉住；多显示器跨屏评估。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#view-002)。
- 验收：
  - **VNC-VIEW-002-A1**：全屏进入/退出、Esc 与 F8 行为、焦点与键盘转发三端记录。
  - **VNC-VIEW-002-A2**：顶端工具栏出现/隐藏时机与 RealVNC 对照。

<a id="vnc-sess-001"></a>
### VNC-SESS-001 F8 会话菜单

- 交付：按 RealVNC F8 顺序的会话菜单：关闭连接 / 全屏 / Send F8 / Send Ctrl+Alt+Del / Ctrl 键 / Alt 键 / 自动缩放 / 缩放子菜单 / 刷新屏幕 / 会话信息；工具栏菜单按钮；键盘导航、Esc 关闭并还焦点。
- 主要文件：`vncSessionMenu.ts`、`VncPanel.tsx`、复用 `ContextMenu`。
- P1 设计：[vnc-input-view-session-design.md](vnc-input-view-session-design.md#session-menu)。
- 验收：
  - **VNC-SESS-001-A1**：菜单项顺序、勾选态（全屏、Ctrl/Alt、自动缩放、当前缩放）与 RealVNC F8 菜单逐项对照，差异有 DEC。
  - **VNC-SESS-001-A2**：F8/工具栏打开，方向键/Enter 执行，Esc 关闭后焦点回画布；“关闭连接” 不触发自动重连，可手动重连。
  - **VNC-SESS-001-A3**：刷新屏幕立即重绘并向服务器请求全量更新。

<a id="vnc-sess-002"></a>
### VNC-SESS-002 会话信息与流水线遥测

- 交付：后端每秒发送 `stats`（请求/最近编码、像素格式、线上吞吐、线路速度估计、更新/帧速率、每次更新耗时）；会话信息对话框字段对齐 RealVNC，并附 Taomni 计数。
- 主要文件：`rfb.rs`（`RuntimeStats`）、`ws.rs`（`StatsWindow`）、`VncSessionInfoDialog.tsx`、`src/lib/vnc.ts`。
- P1 设计：[vnc-input-view-session-design.md](vnc-input-view-session-design.md#session-info)。
- 验收：
  - **VNC-SESS-002-A1**：字段与 RealVNC Session Information 对照（桌面名、设备、尺寸、像素格式、请求/最近编码、线路速度、协议、安全、连接类型）。
  - **VNC-SESS-002-A2**：`stats` 消息经过前端校验，畸形计数被拒绝；统计未到达时显示 “正在统计…”。
  - **VNC-SESS-002-A3**：native 实测会话信息中的编码与线路速度与代理测得值一致（±20%）。

<a id="vnc-sess-003"></a>
### VNC-SESS-003 连接生命周期

- 交付：未加密连接警告（含 “不再提示”）、交互式认证框（用户名/密码/记住密码）、连接中 Stop、按 RealVNC `AutoReconnect` 的重连策略与提示、KeepAlive 探测与断线检测。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#sess-003)。
- 验收：
  - **VNC-SESS-003-A1**：四类对话框/状态的文案、按钮和焦点与 RealVNC 对照。
  - **VNC-SESS-003-A2**：认证失败、服务器慢认证（本服务器 25 s）、网络中断、用户取消分别有正确的结构化状态与恢复入口。

<a id="vnc-conn-001"></a>
### VNC-CONN-001 连接属性与持久化选项

- 交付：会话编辑器 VNC 页扩展：画质、缩放默认值与保持宽高比、view-only、Shared、按键直通、剪贴板收/发开关、AcceptBell、菜单键；会话内 “属性” 入口。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#conn-001)。
- 验收：
  - **VNC-CONN-001-A1**：选项与 RealVNC Options/Expert 对应关系表，旧会话数据读取不变。
  - **VNC-CONN-001-A2**：修改后重连生效，detach claim 与独立窗口保留相同选项。

<a id="vnc-clip-001"></a>
### VNC-CLIP-001 剪贴板策略对齐

- 交付：默认不在连接时推送本地剪贴板（RealVNC `SendInitialClipboard=False`），以焦点/指针进入/本地变化驱动同步并降低轮询；“剪贴板作为按键发送”；服务端剪贴板宽限时间。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#clip-001)。
- 验收：
  - **VNC-CLIP-001-A1**：连接、切换焦点、复制、粘贴四个时机的收发与 RealVNC 对照。
  - **VNC-CLIP-001-A2**：ExtendedClipboard 与 legacy 回退、中文与富文本、方向策略保持。

<a id="vnc-qa-001"></a>
### VNC-QA-001 三端收口与正式 RealVNC 对比

- 交付：Windows WebView2、macOS WKWebView、Linux WebKitGTK 的 native 性能与交互记录；RealVNC 对比记录汇总；QA 用例与 feature catalog 同步。
- P1 设计：[vnc-p1-batch2-design.md](vnc-p1-batch2-design.md#qa-001)。
- 验收：
  - **VNC-QA-001-A1**：所有 done 卡的功能、交互、鼠标键盘、性能对比可追溯到同一参照与方法，`different`/`unverified` 单独保留。
  - **VNC-QA-001-A2**：当前端 native 组合回归通过；其他端未执行项有后续步骤。

<a id="vnc-auth-001"></a>
### VNC-AUTH-001 macOS 屏幕共享 ARD 认证

- 来源：2026-10-01 用户追加需求（不在 RealVNC 对比分母内：RealVNC Viewer 对 Mac 的同类能力未作参照）。
- 交付：RFB 安全类型 30（Apple Remote Desktop）客户端；有用户名时优先于 VNCAuth；会话不加密，走未加密警告；hosted macOS runner 上的真实屏幕共享用例。
- 设计：[vnc-ard-macos-design.md](vnc-ard-macos-design.md)（DEC-ARD-1…6、AC-ARD-1…7、V-ARD-1…5）。
- 验收：
  - **VNC-AUTH-001-A1**：协议与选择（AC-ARD-1、2、4、6）：DH/MD5/AES-128-ECB 凭据经独立服务器实现解出原文；选择顺序按 DEC-ARD-1；`RequireEncryption` 拒绝；`RFB 003.889` 按 3.8 协商。
  - **VNC-AUTH-001-A2**：交互（AC-ARD-3、5）：缺用户名时归类为认证失败并重开带用户名的认证浮层；会话信息显示 `ARD (Apple Remote Desktop)`。
  - **VNC-AUTH-001-A3**：真机（AC-ARD-7）：GitHub macOS runner 上 TC-152 通过；Windows/Linux 客户端连真实 Mac 记为未验证并给出步骤。

以下三张卡来自 [2026-10-01 VMware 内置 VNC 实测](references/vmware-vnc-live-20261001.md) 的发现（用户要求在本批次修复）。

<a id="vnc-auth-002"></a>
### VNC-AUTH-002 凭据按需询问

- 交付（DEC-VNC-21）：没保存密码的 VNC 会话（会话树打开与 `vnc://` 快速连接）直接连接，不再弹连接前的密码框；服务器选定的安全类型需要密码（VNCAuth、RA2/RA2ne、ARD）而会话没有时，客户端不回应挑战，以 `credentials-required` 结束这次尝试，会话内认证表单询问；表单提交的重连沿用已确认的未加密警告；保存密码（vault 引用）与“记住密码”流程不变。
- 验收：
  - **VNC-AUTH-002-A1**：后端：VNCAuth、RA2/RA2ne、ARD 在没有密码时不发送挑战回应，返回 `credentials-required`（认证阶段、不可重试）；None 不受影响；RFB 3.3 与 3.8 都覆盖；browser 预览桥行为一致。
  - **VNC-AUTH-002-A2**：前端：没保存密码的会话（含 `vnc://` 快速连接）打开时不出现连接前密码框；`credentials-required` 打开会话内认证表单且不显示错误；提交后的重连不再问未加密警告；密码错误仍显示错误、重问警告。
  - **VNC-AUTH-002-A3**：实测：VMware 内置 VNC（None）不输入任何内容即连上；fixture（VNCAuth，TC-151 两种模式）与 macOS 屏幕共享（ARD，TC-152）经会话内表单连上，未加密警告只出现一次。

<a id="vnc-perf-006"></a>
### VNC-PERF-006 首选编码被忽略时调整编码顺序

- 交付（DEC-VNC-22）：读线程统计每次更新的 Raw 像素与压缩矩形；首选的压缩编码被大块 Raw 回应时，画质控制器把下一个候选提到第一位并按画质切换的路径重发 SetEncodings 与整帧请求；High 的 Tight 候选带 JPEG 质量 9；会话信息的“请求的编码”随之变化。
- 验收：
  - **VNC-PERF-006-A1**：单测：ZRLE 首选收到大块 Raw → Tight 首选（带 JPEG 质量 9、不带 zlib 级别，像素格式不变）；再收到 Raw → Hextile 首选；候选用尽后不再切换；小块 Raw、混有压缩矩形的更新不触发；降色深档同理；High 学到 Tight 后 Low/Medium 仍用 Tight + JPEG 与 32 bpp（VMware 断线回归）。
  - **VNC-PERF-006-A2**：实测：VMware 内置 VNC 上 High 与 Automatic 在首个整帧后改用 Tight，会话信息的请求与实际编码为 Tight，整帧字节低于 Raw，各档画质切换不断线；fixture 上 TC-151/TC-153 不回退。

<a id="vnc-conn-002"></a>
### VNC-CONN-002 会话编辑器 VNC 分区本地化

- 交付：会话编辑器 VNC 分区的标签、选项与说明全部走 i18n；与会话内 Properties 相同的项共用 `vnc.*` 文案，安全策略、输入、连接时剪贴板与说明补 `sessionEditor2.*` 中英文。
- 验收：
  - **VNC-CONN-002-A1**：中文界面下 VNC 分区（安全策略及其五个选项、画质、缩放、按键、剪贴板、输入、连接、说明）显示中文；英文界面与会话内 Properties 用词一致；单测覆盖两种语言。

## 7. 验证计划

| V | 适用 | 检查 |
|---|---|---|
| V-VNC-01 | PERF-001/003/004 | `TAOMNI_VNC_CAPTURE_DIR=… cargo test --release --lib vnc::live_bench::replay -- --ignored --nocapture`，同一批录制帧 10 次中位数。 |
| V-VNC-02 | PERF-001/002/004、SESS-002 | `TAOMNI_VNC_LIVE_HOST/PORT/PASSWORD` 实测 `vnc::live_bench::live`，与 RealVNC 走同一 `vnc_burst_proxy.py` 的 burst 记录对比。 |
| V-VNC-03 | INPUT-001/002、PERF-002 | native 会话连 `127.0.0.1:<proxy>`：`vnc_pointer_latency.py` 指针延迟；代理 `since_last_up_ms` 看请求节奏；隐藏/恢复标签页观察流量暂停与恢复。 |
| V-VNC-04 | INPUT/VIEW/SESS | `pnpm test src/lib/vnc.test.ts src/components/vnc` 单测 + browser 用例（stub 下验证菜单、缩放、按键序列）。 |
| V-VNC-05 | 全部 | RealVNC 对比记录：功能、交互、鼠标键盘、性能四列；未观测为 `unverified`。 |

## 8. 风险与未决项

- 只有一台第三方服务器；Tight/JPEG、ExtendedDesktopSize、ContinuousUpdates 等需要 TigerVNC/x11vnc fixture 才能验收（PERF-004、VIEW-002）。
- 服务器认证固定延迟 25 s，每次实测连接成本高；实测要合并批次。
- 原生键盘钩子（INPUT-003）涉及三端权限与输入法，可能需要用户确认范围。
- WebView 绘制成本在三种 WebView 差异大；PERF-003 必须逐端测量，不能以 WebView2 外推。

## 9. 交付门槛

设计完成只表示可继续细化。每张卡在同一卡内完成 AC、测试、实际证据、平台边界和 RealVNC 对比；当前端通过即可结束当前端交付，其他端未运行项保留。整体 “与 RealVNC 对齐” 只能在 VNC-QA-001 汇总后判断。
