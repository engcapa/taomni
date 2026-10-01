# VNC 客户端 RealVNC Viewer 对齐入口

本目录承接 2026-09-30 在本机对 RealVNC Viewer 7.15.1 与 Taomni VNC 客户端的同服务器实测，目标是让 Taomni 的 VNC 会话在功能、交互、鼠标键盘和性能上对齐 RealVNC Viewer（面向第三方 VNC 服务器的能力）。

## 入口

- [任务板](backlog.md)：本批次唯一任务来源（`VNC-*`，脚本 `.agents/skills/vnc-realvnc-task/scripts/task_board.py`）。
- [总体设计与交接](alignment-design.md)：目标、差距、DEC、每张卡的交付与验收、验证计划。
- [能力矩阵](capability-matrix.md)：按功能、交互、鼠标键盘、性能、验证状态拆分差距。
- [RealVNC 实机参照](references/realvnc-live-audit-20260930.md)：参照身份、连接流程、属性与默认值、F8 菜单、工具栏、会话信息、性能实测。
- [2026-10-01 同 fixture 对照](references/realvnc-fixture-comparison-20261001.md)：RealVNC 7.0.0 与 Taomni 的特殊键、键盘布局与输入法、全屏工具栏时机、剪贴板时机、指针延迟（系统级输入）。
- [2026-10-01 VMware 内置 VNC 服务器实测](references/vmware-vnc-live-20261001.md)：macOS 14 客户机的真实桌面，None 安全类型、锁屏与桌面上的指针和键盘、画质切换与服务器编码行为。
- P1 设计：[解码与更新流水线](vnc-perf-001-002-pipeline-design.md)、[鼠标/特殊键/缩放/会话菜单/会话信息](vnc-input-view-session-design.md)。
- [macOS 屏幕共享 ARD 认证](vnc-ard-macos-design.md)：RFB 安全类型 30、选择顺序、hosted macOS runner 真机用例 TC-152（任务板外的追加需求）。
- [P1 交接提示词](handoff-p1.md)：细化 deferred 卡的固定入口。
- [现场证据清单](evidence/live-audit-20260930.json)：采样身份、命令与数字。
- 操作技能：`.agents/skills/vnc-realvnc-task/SKILL.md`（任务板、参照采集、性能测量工具）。

## 当前结论

Taomni 已有完整的 RFB 握手、安全类型、主要编码和剪贴板互通。与 RealVNC 同服务器实测后，性能差距集中在解码读取（Hextile 全帧 499 ms）、按 tile 的 relay 扇出（Hextile 全屏 6 930 条消息触发丢帧与全量刷新循环）以及被 WebView ACK 串行阻塞的更新请求；交互差距集中在鼠标时序、F8 菜单与特殊键、缩放模式、会话信息与连接生命周期。

本批次 17 张卡（16 张对齐卡 + 追加的 AUTH-001）全部 `done`，以任务板为准。VNC-QA-001 的汇总结论：

- 性能（Windows 11 release QA 构建）：Hextile 全帧解码 499 → 22.8 ms，relay 消息 6 930 → 1 条；同服务器全屏刷新 Hextile 565–573 ms（RealVNC 565–574 ms），默认 ZRLE 485–509 ms；更新结束到下一请求中位 3.3 ms（RealVNC 2.7 ms）；画质 Low / Medium 的字节与时间都低于 RealVNC 同档；指针移动到线上中位 1.14 / p95 1.70 ms（RealVNC 7.0.0 10.96 / 22.51 ms，Windows 原生光标采样）；会话信息线路速度 92 Mbit/s（RealVNC 99 Mbit/s）。
- 功能与交互：F8 菜单、缩放模式、屏幕级全屏与顶端工具栏、会话信息、连接生命周期、Properties、特殊键直通、剪贴板时机与 RealVNC 行为一致。保留的差异逐行写在[能力矩阵](capability-matrix.md)：AltGr 发送方式、剪贴板同步时延（15–35 ms 对 4–9 ms）、对挂起服务器 KeepAlive 会断开、低画质用 JPEG 而 RealVNC 降色深、自动重连间隔 1.5 s 对 1.2 s。
- 三端：Windows native 组合回归通过（键盘布局与输入法沿用 INPUT-003 的实测，之后键盘路径未改）；托管 CI 上 TC-151（browser + native）与 TC-153（native）三端通过，TC-152 在 macOS runner 上以 ARD 登录真实屏幕共享。macOS、Linux 的系统级输入、系统剪贴板、全屏与 WebView 绘制成本未验证，后续步骤见矩阵“三端覆盖”。服务器侧验证了一台第三方 RFB 3.7 服务器、合成 fixture、macOS 屏幕共享，以及 VMware Workstation 内置 VNC 服务器上的 macOS 14 客户机（连接、指针、键盘与画质切换通过，剪贴板未测）。
