# VNC RealVNC 对齐能力矩阵

本矩阵只描述本批次 16 个工作包，不计算总体完成百分比，也不记录开发状态（状态以 [backlog](backlog.md) 为准）。“基线” 列来自 2026-09-30 实测（HEAD `383aa4f2`），“本批次后” 列只写有证据的结论；RealVNC 列来自[实机参照](references/realvnc-live-audit-20260930.md)。

| 卡 | 功能 | 交互 | 鼠标/键盘 | 性能 | 基线 | 本批次后 |
|---|---|---|---|---|---|---|
| PERF-001 解码与 relay | 已有 | — | — | **确认缺陷**：Hextile 解码 499 ms、6 930 条消息触发刷新循环 | different | Hextile 22.8 ms、1 条消息；实测全屏刷新 Hextile 565–573 ms（RealVNC 565–574 ms）、ZRLE 485–509 ms |
| PERF-002 请求流水线 | 已有 | — | — | 确认差异：请求等 ACK | different | 更新结束→下一请求中位 3.3 ms / p95 4.2 ms（RealVNC 2.7 / 4.3 ms）；隐藏标签 1 s 后停流；native DesktopSize 未测（服务器不能改分辨率） |
| PERF-005 指针延迟 | 已有 | — | pointermove 按动画帧对齐 | **确认差异**：中位 52.7 ms（RealVNC 20.1 ms） | different | `pointerrawupdate` 后中位 19.8–23.3 ms、p95 32.8–41.1 ms；同时段 RealVNC 17.3–20.3 / 31.6–40.6 ms |
| PERF-003 绘制路径 | 已有 | — | — | 待测：WebView 主线程耗时 | unverified | unverified |
| PERF-004 画质/编码 | 缺失（无画质、无 Tight） | 缺失 | — | 慢链路未测 | different | unverified |
| INPUT-001 鼠标 | 部分已有 | **确认缺陷**：失焦指针跳到 (0,0) | 确认差异：右键延迟、滚轮无累积/水平、无后退键 | 指针延迟见 PERF-005 | different | 失焦不再发 (0,0)、右键即时、滚轮累积与水平、后退键（单测）；指针延迟中位约 21 ms，仍比 RealVNC 高约 2 ms |
| INPUT-002 特殊键动作 | 缺失 | 缺失 F8 菜单键 | 缺失 Ctrl+Alt+Del/F8/锁定 | — | different | F8 菜单、Send F8、Ctrl/Alt 锁定、Ctrl+Alt+Del 顺序已实现；Ctrl+Alt+Del 未向真实远端发送 |
| INPUT-003 直通/布局/IME | 部分已有 | 未验证 | 确认差异：系统键被本机拦截 | — | different | unverified |
| VIEW-001 缩放 | 部分已有（fit/1:1） | 确认差异：125% DPI 下 1:1 发虚 | — | — | different | RealVNC 缩放模式；125% DPI 下 100% 按设备像素显示；窗口缩放后 Automatic 重算 |
| VIEW-002 全屏/工具栏 | 部分已有（独立窗口） | 缺失顶端工具栏 | — | — | different | unverified |
| SESS-001 F8 菜单 | 缺失 | 缺失 | — | — | different | 共有项顺序与 RealVNC 一致；键盘导航、Esc 焦点回画布、关闭连接不自动重连（native） |
| SESS-002 会话信息 | 缺失 | 缺失 | — | 无遥测 | different | RealVNC 字段集 + 更新/帧速率与解码耗时；线路速度 92 Mbit/s（代理 78–96 Mbit/s，RealVNC 99 Mbit/s） |
| SESS-003 连接生命周期 | 部分已有 | 确认差异：无未加密警告/Stop/KeepAlive | — | — | different | unverified |
| CONN-001 连接属性 | 部分已有 | 确认差异 | — | — | different | unverified |
| CLIP-001 剪贴板策略 | 已有 | 确认差异：连接即推送、750 ms 轮询 | — | 轮询开销未测 | different | unverified |
| QA-001 三端收口 | 未执行 | 未执行 | 未执行 | 未执行 | unverified | unverified |

RealVNC 专属或第三方服务器上不可用的能力（音频、录制、文件传输、聊天、云、SSO）不在分母内（DEC-VNC-05）。
