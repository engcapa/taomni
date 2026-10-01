# RealVNC Viewer 7.15.1 实机参照（2026-09-30）

本文件是 `VNC-*` 批次的参照来源。所有观察都在同一台 Windows 主机、同一台 VNC 服务器、同一时间窗口内完成；Taomni 侧数字来自同一服务器的实测或同一批录制帧的离线回放。内网地址、口令、远端桌面名和屏幕内容不入库，原始截图、OCR 文本和录制帧保存在被忽略的 `qa-ui-auto-report/realvnc-reference/20260930/` 与 `qa-ui-auto-report/vnc-perf/`。

<a id="identity"></a>
## 1. 参照身份

| 项目 | 值 |
|---|---|
| 参照客户端 | RealVNC Viewer 7.15.1 (r18)，Windows x64 独立版 `VNC-Viewer-7.15.1-Windows-64bit.exe` |
| 来源与完整性 | 官网下载页受 Cloudflare 拦截，新版 Viewer 连接第三方服务器需要付费计划；二进制取自 Internet Archive 对官方下载 URL 的存档。SHA-256 `39195c0abe53dc8fc2a57beeb6df9accf72226d46688845bf864c4d639030d84`，Authenticode `Valid`，签名者 `CN=RealVNC Ltd, O=RealVNC Ltd, L=Cambridge, C=GB` |
| 本机 | Windows 11，1920×1080 物理像素，缩放 125%（逻辑 1536×864），中文输入法常驻 |
| 服务器 | `<vnc-test-host>:5900`（内网，地址不入库）：RFB 003.007，安全类型 `[18 匿名 TLS, 2 VNCAuth]`，帧缓冲 1680×1050，depth 24 |
| Taomni 基线 | `main` HEAD `383aa4f2` |
| 采集工具 | `.agents/skills/vnc-realvnc-task/scripts/vnc_burst_proxy.py`（回环计数代理，只记字节与时间）、`vnc_pointer_latency.py`、`src-tauri/src/vnc/live_bench.rs`（`#[ignore]` 实测与回放基准）、db-client-parity 的桌面 OCR 脚本（DPI-aware 副本） |

<a id="server-quirk"></a>
### 服务器特性

正确的 VNCAuth 响应发出后，服务器约 **25.0 秒** 才返回 SecurityResult（Python 探针：挑战 1 ms、SecurityResult 25 027 ms、ServerInit 2 ms）。RealVNC 与 Taomni 都受此影响（RealVNC 窗口标题约 25–27 s 后出现桌面名；Taomni 握手 25.0–25.3 s）。这是服务器侧行为，不计入客户端对比；Taomni 现有 45 s 认证超时足以覆盖。

<a id="connection-flow"></a>
## 2. 连接流程与对话框

1. 地址簿（File/View/Help 菜单，搜索栏 “Enter a device address or search”，Address book 侧栏，底部 “Need help connecting?” 与 `N device(s)`）。File 菜单：New connection… `Ctrl+N`、Rename、Delete、Duplicate `Ctrl+D`、Properties… `Alt+Enter`、Sign in…、Import/Export connections…、Apply offline license…、Preferences…、Exit。View 菜单：Icons、Details、Sort by、Filter、Refresh、Show sidebar、Show status bar。
2. 服务器提供 18+2 时 RealVNC 不走匿名 TLS，直接 VNCAuth，并弹出 **Encryption / Unencrypted connection** 对话框：说明凭据安全传输但会话数据可能被截获，`Don't warn me about this again`、Continue、Cancel，背后是 “Connecting to …” 与 Stop。
3. **Authentication** 对话框：“Please enter your credentials for the remote device (NOT your RealVNC account details)”，Username、Password、`Remember password`、`Forgot password?`、OK、Cancel。密码框拒绝剪贴板粘贴。
4. 认证失败提示 “An authentication error occurred. See the RealVNC Server error log for details.”；`AutoReconnect=True` 时关闭提示后自动重连并再次弹出未加密警告，Cancel 结束。
5. 成功后会话窗口标题为 `<地址> (<桌面名>) - RealVNC Viewer`；首次窗口按远端尺寸缩放适配屏幕（1680×1050 远端在 125% 屏上打开为 1575×1020 物理像素的窗口）。

Taomni 对照：未加密时无警告对话框（会话编辑器只有安全策略下拉）；无交互式认证框时依赖已保存密码或 `AuthPrompt`；连接中只有文字遮罩，无 Stop；自动重连固定 3 次（750/1500/3000 ms）。

<a id="properties"></a>
## 3. 连接属性（Properties）

- **General**：Address、Name（Friendly identifier）、Labels（`/` 嵌套）、Security → Encryption：`Let the remote device choose`（默认）/ `Always maximum` / `Always on` / `Prefer on` / `Prefer off`，`Authenticate using single sign-on (SSO) if possible`、`Authenticate using a smartcard or certificate store if possible`；Privacy 段。
- **Options**：General → Picture quality `Automatic`（默认）/ `High` / `Medium` / `Low`、`View-only`；Scaling → `Automatic`（默认）/ `Scale to fit window` / `Scale to fit width` / `Scale to fit height` / 百分比（50%、75%、100%、125%、150%、200% 等）+ `Preserve aspect ratio`；Keys → 直通音量键、媒体键、`Pass special keys directly to the remote device`（Windows、PrtScn、Alt+Tab、Alt+Esc、Ctrl+Esc）。
- **Expert**：带 Filter 的参数表，95 项。与本批次相关的默认值：

| 参数 | 默认 | 参数 | 默认 |
|---|---|---|---|
| PreferredEncoding | ZRLE2 | Quality | Auto |
| ColorLevel | rgb222（Auto 在快链路上实际协商 rgb888） | Scaling | FitAutoAspect |
| AutoReconnect | True | KeepAliveInterval / ResponseTimeout | 30 / 30 |
| ScrollWheelThreshold | 120 | PointerCornerSnapThreshold | 30 |
| PointerEventInterval | 空 | Emulate3 | False |
| RelativePtr | False | UseLocalCursor / DotWhenNoCursor | True / True |
| SendKeyEvents / SendPointerEvents | True / True | SendSpecialKeys / SendMediaKeys / SendVolumeKeys / SendPrintScreenKey | True / True / False / True |
| ClientCutText / ServerCutText | True / True | SendInitialClipboard | False |
| ServerClipboardGraceTime | 1000 | ClipboardKeystrokesEnable | 2 |
| Shared | True | AcceptBell | True |
| EnableToolbar / ToolbarPin / ToolbarIconSize | True / False / 24 | FullScreen / FullScreenChangeResolution | False / False |
| UseAllMonitors / FullScreenMonitors / Monitor | False / 空 / 空 | DynamicResolution | False |
| WarnUnencrypted | True | VerifyId | 2 |
| MenuKey | 空（F8） | EnableUdpRfb | True |

完整 OCR 列表：`qa-ui-auto-report/realvnc-reference/20260930/expert-params.txt`。

<a id="session-ui"></a>
## 4. 会话界面

<a id="f8-menu"></a>
### F8 菜单（第三方服务器）

顺序：Close Connection `Alt+F4` / Full Screen / Relative Pointer Motion / Send F8 / Send Ctrl+Alt+Del / Ctrl Key / Alt Key（锁定开关）/ Scale Automatically（勾选）/ Mute Audio / Refresh Screen / Record Session / Session Information… / About RealVNC Viewer… / Properties… / Transfer Files… / Chat…。音频、录制、文件传输、聊天依赖 RealVNC Server，对第三方服务器不可用（录制按钮 tooltip：“The remote computer does not allow session recording”）。

<a id="toolbar"></a>
### 工具栏

窗口模式下合成指针移动到客户区顶端时未出现工具栏（像素差分只有光标变化）；全屏模式下指针贴近屏幕顶端时在顶部中央滑出约 366×41 物理像素的图标条（10 个图标）。已读到的 tooltip：`Exit full screen`、`Scale to 100%`、会话录制不可用说明、`End session`；其余图标 tooltip 因悬停刷新滞后未可靠读取，记为未验证。

<a id="session-info"></a>
### Session Information

字段：Desktop name、Device、Size `1680 x 1050`、Pixel format `depth 24 (32 bpp) little-endian rgb888`、Device pixel format（同上）、Audio format（Remote device does not support audio）、Requested encoding `ZRLE2`、Last-used encoding `Hextile`、Line-speed estimate `98970 kbit/s (RTT ~0ms)`、Protocol version `3.7`、Security method `no encryption [VncAuth]`、Connection type `Direct TCP`；按钮 Save As…、OK。

结论：该服务器不支持 ZRLE2，RealVNC 的 Automatic 在约 99 Mbit/s 链路上选择 **Hextile + rgb888 全彩**。

<a id="measurements"></a>
## 5. 性能实测

方法：客户端连 `127.0.0.1:5977`，由计数代理转发到真实服务器；“burst” 为间隔 >120 ms 的下行数据段。Taomni 解码成本另用同一批录制帧（首个全屏更新，含 zlib 流起点）在本机回环重放，release 构建，10 次取中位数。

| 场景 | RealVNC 7.15.1 | Taomni 基线 `383aa4f2` | Taomni PERF-001 后 |
|---|---|---|---|
| 全屏刷新（F8 Refresh / 非增量请求）线上字节 | 6.76 MB（Hextile） | ZRLE 2.78 MB；Hextile 6.48 MB | 同左（编码未变） |
| 全屏刷新完成时间（`live_bench`：请求 → 解码完成） | — | ZRLE 570–613 ms；Hextile 785–822 ms（debug 构建实测） | ZRLE 485–509 ms；Hextile 565–573 ms；Raw 614 ms（release） |
| 全屏刷新线上 burst（代理：首字节 → 末字节） | 565–574 ms（Hextile 6.76 MB） | — | native release 应用经匿名 TLS：首帧 314 ms / 2.91 MB，Refresh Screen 219–270 ms / 2.86–2.91 MB（ZRLE） |
| 周期更新（服务器画面每秒变化） | 每次约 125 KB（Hextile） | — | 每次约 50 KB（ZRLE），更新结束 → 下一请求中位 3.3 ms、p95 4.2 ms |
| 客户端解码 1680×1050 全帧（回放，release） | 网络受限，无法单独测 | Hextile 499 ms，ZRLE 70 ms，Raw 24 ms | Hextile 22.8 ms，ZRLE 55 ms，Raw 28 ms |
| 每次全屏更新产生的 relay 消息数 | 不适用 | ZRLE 459 个 64×64 tile；Hextile 6 930 个 16×16 tile | 1 个（每个服务器矩形 1 条，按 damage 合并） |
| 持续更新请求节奏（更新数据结束 → 下一个 FramebufferUpdateRequest） | 中位 2.7 ms，p95 4.3 ms（1 540 次，`vnc_request_cadence.py`） | 等 WebView 绘制并回 ACK 后才请求 | 解码完成立即请求；WebView 未 ACK 超过 1 s 暂停 |
| 窗口最小化 | 最小化 15 s 内无任何更新；恢复后首个 burst 251 KB（累积变化），随后恢复每秒更新 | 隐藏标签页保留一个未 ACK 帧，恢复后继续 | 同 RealVNC：1 s 后暂停请求，恢复时一帧补齐 |
| 指针移动 → 线上 PointerEvent（只计 PointerEvent 大小的上行块，200 ms 间隔 40 次） | 中位 20.1 ms，p95 45.0 ms，最小 4.5 ms（未过滤首轮：中位 18.0 / p95 34.3） | 中位 48.6 ms，p95 64.8 ms，最小 35.2 ms（2026-09-27 debug QA 构建） | PERF-001/002 后 release：中位 52.7 ms，p95 65.5 ms，最小 17.0 ms；差距与本批次改动无关，归 VNC-PERF-005 |

Taomni 基线确认的性能缺陷：

- 明文运行期读取无缓冲，Hextile 每个 tile 的 1–4 字节字段都是一次 socket 读（回放 499 ms 的主因）。
- 解码按 tile 产生独立 `Vec` 和独立 WebSocket 消息；Hextile 全屏 6 930 条超过前端 `MAX_PENDING_RECTS = 4096`，前端丢帧并请求全量刷新，服务器再次回全屏 Hextile，形成刷新循环（只要服务器选择 Hextile 就会发生）。
- 下一次 FramebufferUpdateRequest 被 WebView 绘制与 ACK 串行阻塞，吞吐受 “服务器编码 + 传输 + relay + rAF 绘制 + ACK 往返” 之和限制；RealVNC 在收到更新后立即请求下一次。

<a id="verification-boundary"></a>
## 6. 验证边界

- 只覆盖 Windows 11 + 本机 125% DPI + 单台 RFB 3.7 第三方服务器；RealVNC Server、TigerVNC、macOS 屏幕共享、x11vnc 等未测。
- RealVNC 工具栏只在全屏模式观察到；窗口模式行为未确认。
- 指针延迟只测到 “线上可见”，未测远端画面反馈（服务器桌面为锁屏样式静态画面，没有安全的可视反馈目标）。
- 远端每秒约 125 KB 的周期更新来自服务器画面自身变化，两客户端同时观察到。
