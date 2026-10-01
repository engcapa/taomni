# VNC 客户端 RealVNC Viewer 对齐入口

本目录承接 2026-09-30 在本机对 RealVNC Viewer 7.15.1 与 Taomni VNC 客户端的同服务器实测，目标是让 Taomni 的 VNC 会话在功能、交互、鼠标键盘和性能上对齐 RealVNC Viewer（面向第三方 VNC 服务器的能力）。

## 入口

- [任务板](backlog.md)：本批次唯一任务来源（`VNC-*`，脚本 `.agents/skills/vnc-realvnc-task/scripts/task_board.py`）。
- [总体设计与交接](alignment-design.md)：目标、差距、DEC、每张卡的交付与验收、验证计划。
- [能力矩阵](capability-matrix.md)：按功能、交互、鼠标键盘、性能、验证状态拆分差距。
- [RealVNC 实机参照](references/realvnc-live-audit-20260930.md)：参照身份、连接流程、属性与默认值、F8 菜单、工具栏、会话信息、性能实测。
- [2026-10-01 同 fixture 对照](references/realvnc-fixture-comparison-20261001.md)：RealVNC 7.0.0 与 Taomni 的特殊键、键盘布局与输入法、全屏工具栏时机、剪贴板时机、指针延迟（系统级输入）。
- P1 设计：[解码与更新流水线](vnc-perf-001-002-pipeline-design.md)、[鼠标/特殊键/缩放/会话菜单/会话信息](vnc-input-view-session-design.md)。
- [macOS 屏幕共享 ARD 认证](vnc-ard-macos-design.md)：RFB 安全类型 30、选择顺序、hosted macOS runner 真机用例 TC-152（任务板外的追加需求）。
- [P1 交接提示词](handoff-p1.md)：细化 deferred 卡的固定入口。
- [现场证据清单](evidence/live-audit-20260930.json)：采样身份、命令与数字。
- 操作技能：`.agents/skills/vnc-realvnc-task/SKILL.md`（任务板、参照采集、性能测量工具）。

## 当前结论

Taomni 已有完整的 RFB 握手、安全类型、主要编码和剪贴板互通。与 RealVNC 同服务器实测后，性能差距集中在解码读取（Hextile 全帧 499 ms）、按 tile 的 relay 扇出（Hextile 全屏 6 930 条消息触发丢帧与全量刷新循环）以及被 WebView ACK 串行阻塞的更新请求；交互差距集中在鼠标时序、F8 菜单与特殊键、缩放模式、会话信息与连接生命周期。

16 张卡中，PERF-001、VIEW-001、SESS-001、SESS-002 为 `done`；PERF-002、PERF-005、INPUT-001、INPUT-002 为 `implemented`（剩余缺口：native DesktopSize 未测；指针延迟中位约 21 ms，仍比 RealVNC 高约 2 ms；Ctrl+Alt+Del 未向真实远端发送）；其余卡为 `deferred`，需 P1 细化。以任务板为准。

本批次后同服务器实测（Windows 11 release QA 构建）：Hextile 全帧解码 499 → 22.8 ms，relay 消息 6 930 → 1 条；更新结束到下一请求中位 3.3 ms（RealVNC 2.7 ms）；首帧 2.9 MB 在认证后 239–314 ms 到达；指针到线上中位 52.7 → 约 21 ms（RealVNC 17–20 ms）；会话信息线路速度 92 Mbit/s（RealVNC 99 Mbit/s）。只完成了 Windows 11 + 单台第三方 RFB 3.7 服务器的验证，macOS/Linux 和其他服务器类型未验证，整体对齐结论留给 VNC-QA-001。
