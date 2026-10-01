# VNC 第二批卡 P1 设计（PERF-003/004、INPUT-003、VIEW-002、SESS-003、CONN-001、CLIP-001、QA-001）

- 卡片：[backlog](backlog.md)；总体设计 [§6](alignment-design.md#vnc-perf-003)。
- 参照：[实机参照](references/realvnc-live-audit-20260930.md)；本批次补采项写在各节 “补采”。
- 基线：`7c915d58`（分支 `feat/vnc-realvnc-alignment`，第一批已提交）。
- 共享合同：DEC-VNC-03/04/05；保留已保存会话、vault 密码引用、代理/SSH 跳板、detach claim、view-only 与剪贴板方向的前后端双重执行、三端兼容。

<a id="fixture"></a>
## 0. 共用测试设施

共享实测服务器不能改分辨率、不能安全接收 Ctrl+Alt+Del/点击，也无法制造断线、挂起或认证失败。新增可脚本化的本地 RFB 服务器 `.agents/skills/vnc-realvnc-task/scripts/vnc_fixture_server.py`（RFB 3.3/3.7/3.8，None/VNCAuth（`vnc_des.py`，FIPS 向量自检），Raw/Tight（fill/palette/copy/gradient/JPEG），任意真彩像素格式，DesktopSize，legacy/Extended 剪贴板），把收到的每条客户端消息写 JSONL；控制端口命令 `resize / cuttext / extclip / bell / drop / freeze / thaw / reject-auth / stats`。RealVNC 与 Taomni 可连同一 fixture，对比 “远端实际收到了什么”。

- V-VNC-06：native 会话连 fixture，用 fixture 日志证明按键、指针、剪贴板、尺寸变化与生命周期事件到达 “远端”。
- 回环计数代理增加 `--rate-kbps` 限速，用于 PERF-004 慢链路对比（V-VNC-07）。

<a id="perf-003"></a>
## 1. VNC-PERF-003 WebView 绘制路径与 ZRLE 热路径

事实：`VncPanel` 连接后常驻 `requestAnimationFrame`；每帧 `putImageData`；ZRLE 回放 53.6 ms（release，2026-10-01 复测），其中 inflate（miniz_oxide）占主要部分。

- DEC-VNC-12：按需绘制——收到帧边界才调度一次 rAF，绘制后立即 ACK；空闲会话不调度任何动画帧。抽出 `src/lib/vncFramePainter.ts` 承担排队、越界/超限丢帧、隐藏保留、绘制与统计。
- DEC-VNC-13：CopyRect 继续在后端权威帧缓冲内移动并以像素 relay（回环 WS 带宽便宜，画布内复制需要与 damage 合并重新排序，收益小于风险）；OffscreenCanvas/Worker 不采用（会失去截图/GIF 采集用的画布元素，WKWebView 16 支持不完整）。二者记为 “已评估未采用”。
- DEC-VNC-14：flate2 切换 zlib-rs 后端（纯 Rust，全应用生效），ZRLE/Tight/剪贴板 inflate 同时受益。
- 统计：painter 记录每帧接收（头解析+视图）与 `putImageData` 耗时、≥90% 画面的整屏帧；会话信息新增 “WebView 绘制”，容器 `data-vnc-full-frame-ms` 供 native 读取。
- 验收映射：A1 = native 读取整屏帧 receive+paint（WebView2 实测，WKWebView/WebKitGTK 标注未验证）；A2 = `live_bench::replay` ZRLE 中位 ≤ 35 ms；A3 = 单测（空闲无 rAF）+ native 计数 rAF 回调。
- 测试：`vncFramePainter.test.ts`（空闲不调度、整帧一次绘制后 ACK、隐藏保留并在恢复时绘制、越界请求刷新、reset 丢弃）；`live_bench` 回放；native 注入计数器统计 2 s 内 rAF 回调数。

<a id="perf-004"></a>
## 2. VNC-PERF-004 Picture quality 与自适应编码

事实：共享服务器支持 Tight（请求 `[7,-26,-250]` 时首个矩形为 Tight，2026-10-01 探测）；RealVNC 不实现 Tight，其画质档通过色深实现。

- DEC-VNC-11（细化）：
  - 画质 `automatic | high | medium | low`，会话默认 `automatic`。
  - High：`rgb888`，编码 `ZRLE, Hextile, Tight(无 JPEG), CopyRect, Raw`（与现有默认一致）。
  - Medium / Low，服务器支持 Tight：`rgb888`，`Tight` 优先并带 JPEG 质量 6 / 2、压缩等级 6 / 9。
  - Medium / Low，服务器不支持 Tight（Tight 优先的首个像素更新中没有 Tight 矩形）：回落到 `ZRLE, Hextile, CopyRect, Raw` + 降色深像素格式，色深档与 RealVNC 同档实测结果一致（补采：RealVNC `-Quality=Medium/Low` 的会话信息像素格式）。
  - Automatic：起始 High；线路速度估计（SESS-002）连续 2 个窗口 < 10 Mbit/s 降到 Medium、< 2 Mbit/s 降到 Low；连续 5 个窗口高于阈值 1.5 倍才升档。
- DEC-VNC-15：像素格式切换只在没有未完成的 FramebufferUpdateRequest 时发送（流水线在该次更新结束后暂停一次），读线程在下一个 FramebufferUpdate 开始时应用新格式；若服务器合并请求导致计数不归零，最近 1 s 无更新后强制切换。仅编码列表变化（同为 rgb888）立即发送并请求全量刷新。
- 解码：新模块 `pixel.rs`（`PixelFormat`、`PixelConverter`：rgb888 直拷，8/16 bpp 查表，CPIXEL/TPIXEL 规则），Raw/Hextile/ZRLE/RichCursor 接收任意真彩格式；新模块 `tight.rs`（四个持久 zlib 流、reset 位、fill、JPEG（zune-jpeg，RGBA 直出）、copy/palette/gradient 过滤器、compact length；TightPNG 拒绝）。
- 交互：F8 菜单新增 “画质 ▸ 自动/高/中/低”（单选，view-only 可用）；WS 二进制控制 `[5, q]`；会话信息显示画质（含 Automatic 的当前档）、请求编码、实际编码与像素格式。
- 验收映射：A1 = `tight::tests`（fill/短数据/持久流与 reset/单色与索引调色板/gradient/JPEG/降色深 TPIXEL/非法过滤器）+ fixture 与共享服务器 Tight 实测无失步；A2 = 代理限速 10 Mbit/s 下 RealVNC 与 Taomni 各档全屏刷新字节与时间（V-VNC-07）；A3 = native 切换画质后会话信息即时变化、fixture 日志出现新的 SetEncodings/SetPixelFormat。

<a id="input-003"></a>
## 3. VNC-INPUT-003 特殊键直通、键盘布局与输入法

- DEC-VNC-16：Windows 用 `WH_KEYBOARD_LL` 钩子实现 “Pass special keys directly”（RealVNC `SendSpecialKeys=True` 默认）：仅在 VNC 画布持有焦点、本应用窗口在前台且会话选项开启时生效；拦截 Win、Alt+Tab、Alt+Esc、Ctrl+Esc、PrtScn，吞掉本机处理并通过事件交给持有焦点的会话按 keysym 发送；失焦、切标签、关闭连接时停止。钩子运行在辅助进程（`taomni --vnc-special-key-hook <父进程 pid>`，stdin 收 on/off，stdout 回传按键与调用计数，父进程退出即结束）：2026-10-01 实测，钩子挂在 WebView2 宿主进程（工作线程或主线程）时，只要本应用窗口在前台就收不到任何回调。转发前先补发为 AltGr 检测暂存的 Ctrl，保证 Ctrl+Esc 的顺序。macOS（需要辅助功能权限的 CGEventTap）与 Linux（X11 键盘抓取 / Wayland 不可行）不实现，记录实际去向。
- DEC-VNC-17：AltGr——Windows 为 AltGr 合成的左 Ctrl（同一时间戳紧跟 AltGraph）不发送，远端只收到 ISO_Level3_Shift 与字符 keysym；死键——不发送 Dead，组合出的字符按 keysym 发送；输入法——画布不是可编辑元素，本机 IME 不参与组合，按键以原始字符发送、由远端输入法组合。三者都以 RealVNC 连 fixture 的实测为对照（补采）。
- 验收映射：A1 = Windows native（钩子开/关两种状态下 fixture 收到 Super/Tab/Escape/Print）+ macOS/Linux 未验证记录；A2 = 德语布局（仅对被测窗口临时加载 KLID 00000407，测后卸载）下 AltGr+Q、死键 ^+e、中文输入法开启时按键在 RealVNC 与 Taomni 的 fixture 日志对照结论。
- 测试：`keyboardHook` 纯函数单测（哪些组合被拦截）；`VncPanel` 单测（special-key 事件转 keysym、AltGr 合成 Ctrl 过滤）。

<a id="view-002"></a>
## 4. VNC-VIEW-002 屏幕级全屏、自动隐藏工具栏与多显示器

- DEC-VNC-18（取代 DEC-VNC-10 的标签页部分）：全屏 = Tauri 窗口 OS 全屏 + VNC 容器以 `position: fixed; inset: 0` 覆盖整个 WebView（不用 Fullscreen API，因此 Esc 与其他按键照常转发到远端，与 RealVNC 一致）；退出通过顶端工具栏、F8 菜单或再次切换。进入前先退出最大化并关闭窗口缩放：Tauri 无边框窗口的缩放边框子窗口在全屏时仍盖住屏幕顶端（96 DPI 下 4 px），会吃掉工具栏触发区的指针。退出时恢复进入前的窗口全屏/最大化/可缩放状态。独立窗口沿用 OS 全屏，同样启用顶端工具栏。
- 顶端工具栏（RealVNC 全屏工具栏）：全屏时指针进入顶端 3 个设备像素滑出（RealVNC 第 0–2 行），离开即收起（50 ms 只覆盖从边缘条移到滑入工具栏的间隙），滑动 250 ms，可钉住；按钮：退出全屏、缩放 100%/自动、Send Ctrl+Alt+Del、会话菜单、结束会话。时机对照见 [2026-10-01 fixture 对照 §4](references/realvnc-fixture-comparison-20261001.md#fullscreen-toolbar)。
- 多显示器：与 RealVNC 默认 `UseAllMonitors=False` 一致，全屏只覆盖窗口所在显示器；跨屏全屏记录为未实现。
- 验收映射：A1 = native 进入/退出、Esc 转发、F8 打开菜单、焦点回画布（Windows；其他端未验证）；A2 = 工具栏出现/隐藏时机与 RealVNC 参照 §4 对照。

<a id="sess-003"></a>
## 5. VNC-SESS-003 连接生命周期

- DEC-VNC-19：未加密警告在认证之前出现（与 RealVNC 一致）：`vnc_connect(allow_unencrypted=false)` 在选定安全类型为未加密（VNCAuth/None/RA2ne）时、发送选择之前返回 `unencrypted-confirmation-required`；前端弹出 “未加密连接” 对话框（继续 / 取消，“不再提示” 写回会话选项 `vncWarnUnencrypted=false`），继续后以 `allow_unencrypted=true` 重连。
- 认证：保留连接前的 `AuthPrompt`（含保存到 vault）；认证失败时在会话内显示凭据表单（用户名、密码、记住密码、错误原因），提交后重连；取消留在断开状态。
- 连接中：遮罩显示阶段与 Stop；`vnc_cancel_connect(attempt_id)` 取消后台握手并关闭套接字。
- 自动重连（RealVNC `AutoReconnect=True`）：非用户发起、可重试的断线自动重连，退避 1/2/4/8/15 s 持续尝试，遮罩显示 “连接已断开，正在重连（第 n 次）” 与 Stop / 立即重连；认证失败、用户关闭、未加密取消不自动重连。会话选项 `vncAutoReconnect` 可关闭。
- KeepAlive（RealVNC 30/30 s）：30 s 未收到任何服务器消息发送 1×1 非增量请求；再 30 s 无响应判定断线（`keepalive-timeout`，可重试）。
- 验收映射：A1 = 四类对话框/状态文案、按钮、焦点与 RealVNC 对照（补采：RealVNC 连 fixture 的 drop / 认证失败 / 挂起行为）；A2 = fixture 上认证失败、慢认证（`--auth-delay-ms 25000`）、drop、freeze、用户 Stop 的结构化状态与恢复入口（native）+ 单测。

<a id="conn-001"></a>
## 6. VNC-CONN-001 连接属性与持久化选项

- 会话选项（`options_json`，缺省即旧行为）：`vncPictureQuality`（automatic）、`vncScaling`（auto）、`vncPreserveAspect`（true）、`vncShared`（true）、`vncPassSpecialKeys`（true，Windows）、`vncAcceptBell`（true）、`vncMenuKey`（F8，可选 F8–F12 / 无）、`vncSendInitialClipboard`（false）、`vncWarnUnencrypted`（true）、`vncAutoReconnect`（true）；已有 `vncSecurityPolicy / vncViewOnly / vncClipboardPolicy` 不变。安全策略新增 `prefer-off`（RealVNC “Prefer off”）。
- 会话编辑器 VNC 页按 RealVNC Options（画质、缩放、按键、剪贴板、连接）分组；F8 菜单新增 “属性…” 对话框，即时生效项（画质、缩放、按键直通、响铃、菜单键）立即应用，需重连项（view-only、剪贴板方向、共享、安全策略）提示 “重新连接后生效” 并提供立即重连；修改写回已保存会话。
- detach claim 增加 `viewer_options`（有界 JSON），独立窗口与标签页使用相同选项。
- 验收映射：A1 = 选项对照表（本节 + RealVNC 参照 §3）与 “旧会话无新键时读取为默认值” 单测；A2 = native 修改后重连生效、分离窗口保留选项。

<a id="clip-001"></a>
## 7. VNC-CLIP-001 剪贴板策略对齐

- 连接时不推送本地剪贴板（`SendInitialClipboard=False`）：连上后把当前本地文本记为基线，不发送；此后本地变化才发送。
- 同步时机改为事件驱动：窗口获得焦点、指针进入画布、画布获得焦点、WebView 内 copy/cut；删除 750 ms 轮询。
- 服务端剪贴板宽限（`ServerClipboardGraceTime=1000`）：写入服务端剪贴板后 1 s 内不把本地变化回送。
- “以按键发送剪贴板”（F8 菜单，view-only 禁用）：本地文本逐字符以 keysym 发送（换行 → Return，>U+00FF 用 Unicode keysym），上限 4 096 字符。
- 保留：ExtendedClipboard 与 legacy 回退、HTML/RTF、方向策略前后端双重执行、Ctrl+V 先同步后发 V、中键等待。
- 验收映射：A1 = fixture 日志对照 RealVNC 与 Taomni 在连接、切换焦点、本地复制、远端复制四个时机的收发；A2 = 单测 + fixture（`--ext-clipboard` 与无扩展两种）中文与 HTML 往返。

<a id="qa-001"></a>
## 8. VNC-QA-001 三端收口与正式 RealVNC 对比

- 汇总：能力矩阵 “本批次后” 列逐卡更新，`different`/`unverified` 保留；RealVNC 对比统一引用参照 §5 与本批次补采记录。
- QA 用例：新增 native VNC fixture 用例（连接 fixture、F8 菜单、Ctrl+Alt+Del 到达、DesktopSize 重绘、画质切换），`feature-list.md` F9.6 同步，重新生成派生目录。
- 验收映射：A1 = 矩阵与证据可追溯；A2 = Windows native 组合回归通过，macOS/Linux 写明后续步骤。

<a id="tasks"></a>
## 9. 任务与文件职责

| TASK | 内容 | 文件 |
|---|---|---|
| TASK-FIX-01 | fixture 服务器、DES、代理限速 | `.agents/skills/vnc-realvnc-task/scripts/` |
| TASK-PERF-003-01 | 按需绘制与绘制统计 | `vncFramePainter.ts`、`VncPanel.tsx`、`VncSessionInfoDialog.tsx` |
| TASK-PERF-003-02 | zlib-rs 后端 | `Cargo.toml` |
| TASK-PERF-004-01 | 像素格式与转换 | `pixel.rs`、`encodings.rs`、`rfb.rs` |
| TASK-PERF-004-02 | Tight 解码 | `tight.rs`、`rfb.rs` |
| TASK-PERF-004-03 | 画质状态机、同步切换、Automatic | `ws.rs`（或 `quality.rs`）、`vncSessionMenu.ts`、`vnc.ts` |
| TASK-SESS-003-01 | 未加密确认、取消连接、KeepAlive | `tls.rs`、`mod.rs`、`ws.rs` |
| TASK-SESS-003-02 | 生命周期 UI | `VncPanel.tsx`、新 `VncConnectionOverlay.tsx` |
| TASK-CONN-001-01 | 选项模型与持久化 | 新 `src/lib/vncOptions.ts`、`SessionEditor.tsx`、`MainLayout.tsx`、`DetachedSessionWindow.tsx`、`mod.rs` claim |
| TASK-CONN-001-02 | 会话内属性对话框 | 新 `VncPropertiesDialog.tsx` |
| TASK-CLIP-001-01 | 剪贴板时机与按键发送 | `VncPanel.tsx` |
| TASK-INPUT-003-01 | Windows 低级键盘钩子 | 新 `src-tauri/src/vnc/keyboard_hook.rs`、`lib.rs` 命令注册 |
| TASK-INPUT-003-02 | AltGr 过滤与特殊键事件 | `VncPanel.tsx`、`vnc.ts` |
| TASK-VIEW-002-01 | 屏幕级全屏与顶端工具栏 | `VncPanel.tsx`、新 `VncFullScreenToolbar.tsx` |
| TASK-QA-001-01 | QA 用例、矩阵与收口 | `qa-ui-auto-tests/`、`capability-matrix.md` |

native 步骤统一：`native_build.py --release` 生成 QA 身份构建 → WebDriver（tauri-driver + msedgedriver）驱动隔离数据目录中的应用 → 连 fixture 或经计数代理连共享服务器；OS 级指针/按键用 `SendInput`/`SetCursorPos` 驱动，只作用于 QA 窗口。
