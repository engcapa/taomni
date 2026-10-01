# VNC RealVNC 对齐能力矩阵

本矩阵只描述本批次 16 个工作包和追加的 AUTH-001，不计算总体完成百分比，也不记录开发状态（状态以 [backlog](backlog.md) 为准）。“基线” 列来自 2026-09-30 实测（HEAD `383aa4f2`），“本批次后” 列只写有证据的结论；RealVNC 列来自[实机参照](references/realvnc-live-audit-20260930.md)与 [2026-10-01 同 fixture 对照](references/realvnc-fixture-comparison-20261001.md)（RealVNC 7.0.0，第二台 Windows 主机）。

| 卡 | 功能 | 交互 | 鼠标/键盘 | 性能 | 基线 | 本批次后 |
|---|---|---|---|---|---|---|
| PERF-001 解码与 relay | 已有 | — | — | **确认缺陷**：Hextile 解码 499 ms、6 930 条消息触发刷新循环 | different | Hextile 22.8 ms、1 条消息；实测全屏刷新 Hextile 565–573 ms（RealVNC 565–574 ms）、ZRLE 485–509 ms |
| PERF-002 请求流水线 | 已有 | — | — | 确认差异：请求等 ACK | different | 更新结束→下一请求中位 3.3 ms / p95 4.2 ms（RealVNC 2.7 / 4.3 ms）；隐藏标签 1 s 后停流；native DesktopSize 未测（服务器不能改分辨率） |
| PERF-005 指针延迟 | 已有 | — | pointermove 按动画帧对齐 | **确认差异**：中位 52.7 ms（RealVNC 20.1 ms） | different | Windows：画布上无按键时 relay 直接读光标（DEC-VNC-20），同 fixture 交替各 240 样本中位 1.14 / p95 1.70 ms（RealVNC 7.0.0 10.96 / 22.51 ms）；未采样时延迟由系统按刷新投递光标移动决定，与 RealVNC 互有高低；macOS/Linux unverified |
| PERF-003 绘制路径 | 已有 | — | — | 待测：WebView 主线程耗时 | unverified | Windows：1680×1050 全帧主线程 putImageData 2.2–2.5 ms，服务器静止时 0 次 rAF；ZRLE 回放解码中位 30.1 ms（前 55 ms）；WKWebView/WebKitGTK unverified |
| PERF-004 画质/编码 | 缺失（无画质、无 Tight） | 缺失 | — | 慢链路未测 | different | Tight/JPEG 画质 Low/Medium/High；同服务器 Low 93.8 KB / 85–99 ms、Medium 183–191 KB（RealVNC 171 KB / 227 ms、2.90 MB），字节与时间每档更低；保真方式 different（JPEG vs 降色深） |
| INPUT-001 鼠标 | 部分已有 | **确认缺陷**：失焦指针跳到 (0,0) | 确认差异：右键延迟、滚轮无累积/水平、无后退键 | 指针延迟见 PERF-005 | different | 失焦不再发 (0,0)、右键即时、滚轮累积与水平、后退键（单测）；native fixture 上右/中键、上下/水平滚轮、左键拖拽无重复（系统级输入，含原生采样）；指针延迟见 PERF-005 |
| INPUT-002 特殊键动作 | 缺失 | 缺失 F8 菜单键 | 缺失 Ctrl+Alt+Del/F8/锁定 | — | different | F8 菜单、Send F8、Ctrl/Alt 锁定、Ctrl+Alt+Del 顺序已实现，fixture 收到 Ctrl↓ Alt↓ Del↓ Del↑ Alt↑ Ctrl↑；Windows 服务器安全屏 unverified（共享桌面不能收 Ctrl+Alt+Del） |
| INPUT-003 直通/布局/IME | 部分已有 | 未验证 | 确认差异：系统键被本机拦截 | — | different | Windows：Win、Alt+Tab、Alt+Esc、Ctrl+Esc、PrtScn 直通（可关闭）与 RealVNC 线上一致；德语死键与中文输入法 same；AltGr different（ISO_Level3_Shift，RealVNC 发 Ctrl+Alt）；macOS/Linux unverified |
| VIEW-001 缩放 | 部分已有（fit/1:1） | 确认差异：125% DPI 下 1:1 发虚 | — | — | different | RealVNC 缩放模式；125% DPI 下 100% 按设备像素显示；窗口缩放后 Automatic 重算 |
| VIEW-002 全屏/工具栏 | 部分已有（独立窗口） | 缺失顶端工具栏 | — | — | different | Windows：标签页屏幕级全屏、Esc 转发、F8 菜单、退出恢复最大化；工具栏第 0–2 行触发、离开即收起，滑出开始晚约 70 ms、完成早约 65 ms；跨屏全屏未实现（同 RealVNC 默认）；macOS/Linux unverified |
| SESS-001 F8 菜单 | 缺失 | 缺失 | — | — | different | 共有项顺序与 RealVNC 一致；键盘导航、Esc 焦点回画布、关闭连接不自动重连（native） |
| SESS-002 会话信息 | 缺失 | 缺失 | — | 无遥测 | different | RealVNC 字段集 + 更新/帧速率与解码耗时；线路速度 92 Mbit/s（代理 78–96 Mbit/s，RealVNC 99 Mbit/s） |
| SESS-003 连接生命周期 | 部分已有 | 确认差异：无未加密警告/Stop/KeepAlive | — | — | different | 未加密警告（认证前、重连再问）、认证表单、Stop、自动重连（RealVNC 1.2 s / Taomni 1.5 s）、KeepAlive 30 s 探测与断开；对挂起服务器 RealVNC 一直保持连接 different |
| CONN-001 连接属性 | 部分已有 | 确认差异 | — | — | different | 会话内 Properties：画质、菜单键、view-only 等持久化并按需重连生效（native fixture）；独立窗口 detach 只有单测 |
| CLIP-001 剪贴板策略 | 已有 | 确认差异：连接即推送、750 ms 轮询 | — | 轮询开销未测 | different | 四个时机行为与 RealVNC same：连接不推送、指针进入与焦点返回发送本地变化、远端剪贴板写入本机且不回送；无轮询；以按键发送剪贴板。时延 different：三次运行指针进入 15–35 ms / 焦点返回 14–23 ms（RealVNC 4–9 / 3–10 ms，WebView 事件按刷新投递）；ExtendedClipboard 中文与 HTML 双向通过（RealVNC 只用 legacy） |
| AUTH-001 macOS ARD（追加） | 缺失（无安全类型 30） | — | — | — | different | ARD 登录（DH + AES-128）、有用户名时优先、未加密警告、会话信息显示 ARD；GitHub macOS runner 真实屏幕共享 TC-152 通过；不在 RealVNC 分母内 |
| QA-001 三端收口 | 未执行 | 未执行 | 未执行 | 未执行 | unverified | 见下节 |

RealVNC 专属或第三方服务器上不可用的能力（音频、录制、文件传输、聊天、云、SSO）不在分母内（DEC-VNC-05）。

## 三端覆盖（VNC-QA-001）

| 端 | 已验证 | 未验证与后续步骤 |
|---|---|---|
| Windows（WebView2，本机 1920×1080 @ 100%） | 全部卡的 native 场景（`vnc_native.py`，系统级输入）与 RealVNC 7.0.0 同 fixture 对照；hosted TC-151 browser + native | 125% 以外 DPI、多显示器全屏；Windows 服务器安全屏（Ctrl+Alt+Del） |
| macOS（WKWebView，hosted macos-15） | TC-151（连接、点击、按键、Ctrl+Alt+Del、DesktopSize）browser + native；TC-152 真实屏幕共享 ARD 登录 | 系统级指针/键盘、剪贴板、全屏、绘制成本：在 Mac 上用平台输入 API 跑 `vnc_native.py` 对应场景 |
| Linux（WebKitGTK，hosted ubuntu-24.04） | TC-151 browser + native | 同上；WebKitGTK 绘制成本与 X11 系统级输入 |

