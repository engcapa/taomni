# RealVNC Viewer 7.0.0 与 Taomni 同 fixture 对照（2026-10-01）

补充[2026-09-30 实机参照](realvnc-live-audit-20260930.md)：第二台 Windows 主机上，RealVNC Viewer 与 Taomni 连接同一个本机 RFB fixture（`.agents/skills/vnc-realvnc-task/scripts/vnc_fixture_server.py`），用同一套系统级输入（`vnc_native.py` / `vnc_realvnc_probe.py`，扫描码 `SendInput`，前台守卫只允许输入落到被测窗口）测键盘、全屏工具栏、剪贴板与指针延迟。fixture 逐条记录客户端发到 “远端” 的消息，因此对照的是线上实际收到的内容。原始日志、截图与延迟转储在被忽略的 `qa-ui-auto-report/vnc-native/20261001-host2/`；共享 VNC 服务器的地址与口令不入库。

<a id="identity"></a>
## 1. 参照身份

| 项目 | 值 |
|---|---|
| 参照客户端 | RealVNC Viewer 7.0.0 (r48935)，`VNC-Viewer-7.0.0-Windows-64bit.exe`，SHA-256 `8df894b1bb69180ae4214a1be8a55b7b7b3561176a6ad6a6f6e30518d833474a`，Authenticode `Valid`（`CN=RealVNC Ltd, O=RealVNC Ltd, L=Cambridge, C=GB`） |
| 本机 | Windows 11 专业版 26200，1920×1080，缩放 100%；键盘布局 en-US、zh-CN（微软拼音），德语布局只在被测窗口临时加载并在测后卸载 |
| Taomni | native QA release 构建（`com.taomni.app.qa`，隔离数据目录），代码对应 `893e033a`–`c42921ef` |
| 服务器 | fixture：RFB 3.8（延迟测量用 3.7）、VNCAuth、1280×720（延迟测量 1680×1050，每秒 1 帧动画），ExtendedClipboard 文本 + HTML |
| 2026-09-30 共享服务器 | 本次未用于对比：该服务器宣告 RFB 005.000、安全类型 RA2 `[13, 5]`，需要 RealVNC 账户用户名，未取得 |

<a id="special-keys"></a>
## 2. 特殊键直通（VNC-INPUT-003-A1）

| 组合 | RealVNC（SendSpecialKeys 默认开） | Taomni 直通开 | Taomni 直通关 |
|---|---|---|---|
| Win | 远端 Super_L ↓↑，本机无反应 | 远端 Super_L ↓↑，本机无反应 | 本机开始菜单（远端也收到 Super_L） |
| Alt+Tab | 远端 Alt ↓ Tab ↓↑ Alt ↑ | 同 RealVNC | 本机任务切换 |
| Alt+Esc | 远端 Alt ↓ Esc ↓↑ Alt ↑ | 同 RealVNC | 本机切换窗口 |
| Ctrl+Esc | 远端 Ctrl ↓ Esc ↓↑ Ctrl ↑ | 同 RealVNC（此前 Esc 先于 Ctrl 到达，已修复） | 本机开始菜单 |
| PrtScn | 远端 Print ↓↑ | 同 RealVNC | 本机截图工具 |

Taomni 的低级键盘钩子运行在辅助进程（`taomni --vnc-special-key-hook <pid>`）：钩子挂在 WebView2 宿主进程里时，只要 Taomni 窗口在前台就收不到任何回调（工作线程与主线程两种安装方式实测 `hook_calls = 0`）。直通开启时每个组合在钩子里拦截 2 个事件，窗口保持前台，没有本机界面弹出。macOS（Cmd、Cmd+Tab、截图快捷键）与 Linux（Super、Alt+Tab、Print）没有全局钩子，按代码这些组合由本机系统处理，未在真机记录。

<a id="layouts"></a>
## 3. 键盘布局与输入法（VNC-INPUT-003-A2）

| 输入 | RealVNC 线上 | Taomni 线上 | 结论 |
|---|---|---|---|
| 德语 AltGr+Q（@） | Ctrl_L ↓ Alt_R ↓，`@` 前释放二者，`@` ↓ 后再按下、↑ 后释放 | ISO_Level3_Shift ↓ `@` ↓↑ ISO_Level3_Shift ↑（Windows 合成的左 Ctrl 不发送） | different：远端都得到 `@`；Taomni 不发送会被远端当成 Ctrl+Alt 的组合 |
| 德语死键 ^ 后 e | `ê` ↓↑ | `ê` ↓↑（此前发送单独的 `e`，已修复） | same |
| 中文输入法开启时 a | `a` ↓↑（原始按键，由远端输入法组合） | `a` ↓↑ | same |

Chromium 在切换布局后的第一个死键会丢失组合，测量前先按一次 Shift 预热；这是 WebView 的行为，不是 VNC 转发问题。法语布局未单独测量（AltGr 与死键路径与德语相同）。

<a id="fullscreen-toolbar"></a>
## 4. 全屏与顶端工具栏（VNC-VIEW-002）

方法：全屏后把指针移到屏幕顶端再移开，按工具栏所在区域的像素变化计时（以变化像素的 10% / 90% 为开始 / 完成），各 3 次。

| 项目 | RealVNC 7.0.0 | Taomni |
|---|---|---|
| 指针到顶端 → 开始滑出 | 0.029–0.030 s | 0.096–0.098 s |
| → 完全显示 | 0.295–0.296 s | 0.229–0.231 s |
| 指针离开 → 开始收起 | 0.033–0.068 s | 0.099–0.104 s |
| → 完全收起 | 0.300–0.335 s | 0.198–0.216 s |
| 触发区域 | 第 0–2 行像素 | 第 0–2 行像素（3 设备像素） |
| 离开多远开始收起 | 指针越过 y = 35 | 指针越过 y = 40（工具栏高度） |

Taomni 此前离开 1.5 s 后才收起，现在与 RealVNC 一样离开即收起（50 ms 只用于从边缘条移到滑入的工具栏），滑动 250 ms。Taomni 开始滑出晚约 70 ms（WebView 指针事件与合成），完成更早。全屏从最大化窗口进入时覆盖整个屏幕；Tauri 无边框窗口的缩放边框子窗口原本盖住屏幕顶端 4 px，全屏期间关闭窗口缩放后顶端各行命中 WebView；Esc 发往远端且不退出全屏；F8 打开会话菜单、Esc 关闭后焦点回画布；退出后恢复最大化与可缩放。

<a id="clipboard"></a>
## 5. 剪贴板时机（VNC-CLIP-001，卡未领取，结果先记录）

| 时机 | RealVNC 7.0.0 | Taomni |
|---|---|---|
| 连接时 | 不推送本地剪贴板 | 不推送 |
| 本地复制后指针重新进入远端画面 | 8–9 ms 后发送（legacy ClientCutText） | 25–28 ms 后发送 |
| 本地复制后窗口重新获得焦点 | 9–10 ms 后发送 | 14–18 ms 后发送 |
| 远端复制 → 本机剪贴板 | 收到并写入；随后不回送 | 收到并写入；1 s 宽限内不回送 |
| ExtendedClipboard | 未宣告该伪编码，只用 legacy 剪贴板；服务器端的 ExtendedClipboard 通知不处理 | 中文文本双向、HTML 富文本粘贴（Ctrl+V 先送 HTML 再送 V）通过 |

<a id="pointer-latency"></a>
## 6. 指针移动到线上延迟（VNC-PERF-005 / VNC-INPUT-001-A4）

方法：fixture（RFB 3.7、1680×1050、VNCAuth、每秒 1 帧动画）前接 `vnc_burst_proxy.py`；`vnc_pointer_latency.py` 每 200 ms 移动一次指针、共 40 次，只计 6 字节 PointerEvent 上行块；Taomni（release）与 RealVNC 交替 3 轮、每轮 3 次，各 360 个样本合并，百分位线性插值。

| 统计 | RealVNC 7.0.0 | Taomni |
|---|---|---|
| 中位数 | 10.35 ms | 9.97 ms |
| p90 | 17.93 ms | 22.79 ms |
| p95 | 25.90 ms | 27.75 ms |
| p99 | 32.39 ms | 33.63 ms |
| 单次运行中位数范围 | 8.52–12.25 ms | 6.84–12.87 ms |

结论（上午，HEAD `c42921ef`）：中位数与 RealVNC 持平（低 0.4 ms），尾部仍高（p90 +4.9 ms、p95 +1.9 ms），VNC-PERF-005-A1 / VNC-INPUT-001-A4 的 “不高于 RealVNC” 严格判定未满足。

### 6.1 尾部来源（下午，同主机、同 fixture）

逐段测量（`vnc_native.py --scenario pointer-trace`，120 次移动）：OS 移动 → WebView 事件时间戳中位 10.8 / p95 32.0 ms；事件 → 监听器 0.3 / 0.6 ms；监听器 → WebSocket 发送 ≈ 0；发送 → 线上 0.1 / 0.2 ms。延迟与尾部几乎全部在 Windows 把光标移动投递给窗口之前：投递跟随显示刷新（约 16.7 ms 周期的锯齿），10–20 % 的移动多等一到两个周期。裸 Win32 测试窗口（`SetCursorPos` → `WM_MOUSEMOVE`，120 次）同样为中位 11.4 / p95 31.4 ms；RealVNC 也走这条路，所以同一主机不同会话的 p95 会互有高低：

| 会话（交替 3 轮 × 2 次） | RealVNC 中位 / p90 / p95 | Taomni 中位 / p90 / p95 |
|---|---|---|
| A（`872d61f9`） | 10.07 / 20.70 / 26.43 ms | 7.47 / 19.65 / 24.44 ms |
| B（`872d61f9`） | 11.23 / 17.39 / 22.75 ms | 9.07 / 18.00 / 24.60 ms |
| 上午 + A + B 合并（各 840 样本） | 10.61 / 18.03 / 25.95 ms | 9.22 / 20.61 / 26.57 ms |

### 6.2 原生光标采样后（DEC-VNC-20，`396a74aa` 构建）

指针停在已连接画布上且无按键时，relay 线程每 1–4 ms 读光标位置直接发送；WebView 仍发按键、滚轮和拖拽，relay 丢弃它晚到的移动副本。同方法、交替 3 轮 × 2 次：

| 统计（各 240 样本） | RealVNC 7.0.0 | Taomni |
|---|---|---|
| 中位数 | 10.96 ms | 1.14 ms |
| p90 | 17.49 ms | 1.65 ms |
| p95 | 22.51 ms | 1.70 ms |
| p99 | 33.18 ms | 1.95 ms |

结论：中位数与 p95 均远低于 RealVNC，VNC-PERF-005-A1 / VNC-INPUT-001-A4 满足。只有 Windows 采样；macOS/Linux 仍走 WebView 事件，未测。

<a id="boundary"></a>
## 7. 验证边界

- 只覆盖这台 Windows 11（100% 缩放）与本机 fixture；fixture 画面是合成的，不代表真实服务器的编码与负载。
- macOS、Linux 未执行。托管 CI 的 `vnc` 能力给三端提供同一个 fixture，TC-151（browser + native）覆盖连接、输入到达与 DesktopSize，不含系统级输入与系统剪贴板；本次只在这台 Windows 上以两种模式执行。
- RA2 服务器（2026-09-30 共享服务器）需要用户名，本次未连接；RealVNC 与 Taomni 在该服务器上的对照仍以 09-30 参照为准。
