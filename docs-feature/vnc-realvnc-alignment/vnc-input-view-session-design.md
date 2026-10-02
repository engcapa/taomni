# VNC-INPUT-001/002、VNC-VIEW-001、VNC-SESS-001/002（P1 设计与交付记录）

- 卡片：[backlog](backlog.md)；总体设计 [§6](alignment-design.md#vnc-input-001)。
- 参照：[实机参照 §3–§4](references/realvnc-live-audit-20260930.md#properties)。
- 基线：`383aa4f2`。

<a id="mouse"></a>
## 1. 鼠标（VNC-INPUT-001）

| 基线 | 目标（RealVNC） | 实现 |
|---|---|---|
| 右/中键：`syncLocalClipboardToServer(force)` + 固定 120 ms 后才发按下 | 立即发送 | 右键立即；中键只在剪贴板同步进行中时等待，最多 150 ms（DEC-VNC-07） |
| 每个 pointer 事件都尝试读剪贴板（250 ms 节流） | 事件驱动 | 改为 `pointerenter` 强制同步，保留 750 ms 轮询（剪贴板策略由 VNC-CLIP-001 继续对齐） |
| React `onWheel`（被动监听，`preventDefault` 无效）；每事件按下 + 50 ms 定时释放；无水平 | 一格一步，按下/释放成对 | 原生 `wheel` 非被动监听；`VncWheelAccumulator` 100 px/3 行为一格；Shift+滚轮转水平；按键位 `held | step` 后立刻 `held` |
| 无后退键 | X1 → 按键 8 | `mouseButtonMask` bit 7；前进键无 8 位掩码位，未映射 |
| `blur`/`visibilitychange` 发送 `pointer(0,0,0)` | 不移动指针 | 仅在有按下按钮时于最后位置释放；锁定键保持 |

<a id="special-keys"></a>
## 2. 特殊键动作（VNC-INPUT-002）

- F8（无修饰）在画布焦点下打开会话菜单，不转发；view-only 同样可打开。
- `sendKeyCombo`：按顺序按下、逆序释放；已通过菜单锁定的 Ctrl/Alt 跳过。
- 锁定：`latchedKeysymsRef` + `ctrlLatched/altLatched` 状态；关闭连接时清除；失焦不释放锁定键。
- 工具栏：Send Ctrl+Alt+Del（非 view-only）。

<a id="scaling"></a>
## 3. 缩放（VNC-VIEW-001）

`computeVncDisplaySize(scaling, fbW, fbH, viewportW, viewportH, dpr, preserveAspect)`：100% = `fb / dpr` CSS 像素（一个远端像素一个设备像素）。

| 模式 | 规则 |
|---|---|
| `auto`（默认） | `min(1, 适应宽, 适应高)`，不放大；关闭保持宽高比时两轴分别缩小 |
| `fit` | 双向适应；关闭保持宽高比时拉伸填满 |
| `fit-width` / `fit-height` | 以一轴适应，另一轴按比例（或 100%），溢出时滚动 |
| 百分比 | 25–400%（菜单）；`normalizeVncScaling` 接受 10–800 |

画布元素直接设为计算尺寸，容器 `display:flex` + 画布 `margin:auto`：小于视口居中，大于视口从左上可滚动。坐标统一按画布盒子映射（`mapClientToFramebuffer(..., "one")`）。`ResizeObserver` + `resize` 事件更新视口与 DPR。

<a id="session-menu"></a>
## 4. F8 会话菜单（VNC-SESS-001）

`buildVncSessionMenuItems(state, actions, t)` → 复用 `ContextMenu`（键盘导航、子菜单、勾选、`useFocusReturn`）。

| RealVNC F8（第三方服务器） | Taomni | 说明 |
|---|---|---|
| Close Connection `Alt+F4` | 关闭连接 | 不触发自动重连，遮罩提供重新连接 |
| Full Screen | 全屏 / 退出全屏（勾选） | DEC-VNC-10 |
| Relative Pointer Motion | — | 推迟到 INPUT-003 |
| Send F8 / Send Ctrl+Alt+Del | 同 | |
| Ctrl Key / Alt Key | 同（勾选=锁定） | |
| Scale Automatically | 自动缩放（勾选） | 再点切到 100%，与 RealVNC 工具栏 “Scale to 100%” 一致 |
| — | 缩放 ▸（自动/适应窗口/宽/高/百分比/保持宽高比） | RealVNC 在 Properties > Options 中；Taomni 放入菜单便于会话内切换 |
| Mute Audio / Record Session / Transfer Files / Chat | — | DEC-VNC-05 |
| Refresh Screen | 刷新屏幕 | 权威帧缓冲立即重绘 + 服务器全量请求 |
| Session Information… | 会话信息… | SESS-002 |
| About / Properties… | — | Properties 归 VNC-CONN-001 |

<a id="session-info"></a>
## 5. 会话信息（VNC-SESS-002）

- 后端 `RuntimeStats`（线上字节、更新数、最近编码、最近一次更新的字节与耗时）→ `StatsWindow` 每秒一条 `stats`（请求编码、最近编码、像素格式、吞吐 kbit/s、≥256 KiB 更新估计的线路速度 EMA、更新/帧速率、平均每次更新耗时）。
- 前端 `parseWsMessage` 校验字段类型与非负；`VncSessionInfoDialog` 展示 RealVNC 同类字段（桌面名、设备、尺寸、像素格式、请求/最近编码、线路速度、协议、安全、连接类型），再加 “更新/帧” 与 “解码耗时”。音频格式与 Save As… 不提供。

<a id="test-cases"></a>
## 6. 测试

| 用例 | 层 | 覆盖 |
|---|---|---|
| `src/lib/vnc.test.ts` “VNC viewer scaling” | unit | VIEW-001-A1 |
| `src/lib/vnc.test.ts` “VNC wheel and buttons” | unit | INPUT-001-A2、后退键、SESS-002-A2 |
| `VncPanel.test.tsx` “does not move the remote pointer to 0,0…” | unit（基线失败） | INPUT-001-A3 |
| `VncPanel.test.tsx` “sends a right click immediately…” | unit | INPUT-001-A1、VIEW-001-A2（960×540 盒子中心 → 1920×1080 的 960,540） |
| `VncPanel.test.tsx` “turns a mouse wheel notch…” | unit | INPUT-001-A2 |
| `VncPanel.test.tsx` “opens the session menu on F8…” / “sends Ctrl+Alt+Del from the session menu…” | unit | INPUT-002-A1/A2、SESS-001-A2 |
| native 会话（V-VNC-03） | native | INPUT-001-A4、INPUT-002-A3、VIEW-001-A3、SESS-001-A1/A3、SESS-002-A3 |

browser 模式没有 VNC stub（`src/stubs/tauri-core.ts` 不实现 `vnc_connect`），连接后的 UI 只能由 jsdom 单测与 native 验证。
