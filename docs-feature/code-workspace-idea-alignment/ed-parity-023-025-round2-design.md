# ED-PARITY-023..025 第二轮细节对齐设计

来源：2026-09-30 用户反馈（ED-PARITY-010..022 已完成后）——左侧工具栏被挤压且不可拉伸、右侧不支持；弹窗 tab 间方向键切换；调试（断点、暂停时 stack/frame）完整度不足；Linux 下 Java 输入明显卡顿。参照 IDEA Ultimate 2026.2.2（IU-262.10315.125，本机 Linux X11），证据来自实机按键探针（`qa-ui-auto-report/idea-reference/round2-20260930/`，已忽略目录）与 IDEA jar 的 action XML、资源包、字节码（`javap`）。

<a id="ed-parity-023"></a>

## ED-PARITY-023 Linux 输入卡顿

**根因（已测量）**：每次光标移动都让 23k 行的 `CodeWorkspaceTab` 整体重渲染两次（`navigateDiagnostic`/`openHierarchy` 依赖 `cursorPositions` → 命令重注册 → action host generation 递增），15 个常驻底部面板随之重渲染；每次按键重复解析 keymap 与 `detectKeymapPlatform`；error stripe 在 `geometryChanged` 时重建；折叠区域正则逐行重建。WebKitGTK 渲染更慢，放大为明显卡顿。

**修复**：action host 预建按键索引与解析缓存；`KeepAliveToolPanel` 记忆化隐藏面板；`ProjectTree` memo + `useLatestHandlers`；`cursorPositionsRef`；光标/视口/高亮等状态改为 transition；error stripe 去抖；缩进探测缓存。键盘动作读取的光标 ref 由编辑器回调同步写入，避免 transition 期间 Ctrl+F8 等作用到旧行。

- ED-PARITY-023-A1 WebKitGTK（MiniBrowser + WebKitWebDriver，生产包）光标移动 p50 69→26 ms，长帧合计 15.2 s→0.1 s；Chrome 4× 降速下输入 p95 84→47 ms。
- V：单元测试覆盖按键索引失效/重注册；native 回归 `TC-IDE-LAT-01-java-typing-latency-native`、`TC-IDE-C0-03`。

<a id="ed-parity-024"></a>

## ED-PARITY-024 工具窗口条、锚点与弹窗按键

**IDEA 事实**：新 UI 工具窗口条可显示名称（默认 59 px，40–100 px 可拖），条按钮右键菜单为 Hide / Move to（六个锚点）/ Remove from Sidebar / Show Tool Window Names；窗口 ⋮ Options 为 View Mode / Move to / Resize / Remove from Sidebar / Hide；Structure 默认 Left Bottom。Project 窗口头部有 Select Opened File、Expand All、Collapse All。弹窗按键（实测 + 字节码）：IDEA 的 Ctrl+Alt+N 是 Inline 重构而非弹窗；Search Everywhere 用 Tab/Shift+Tab 切换分类，不带修饰键的方向键不切换（第三轮更正：Alt+Left/Right、Ctrl+Tab 等平台 NextTab/PreviousTab/Switcher 也会切换，见 [ED-PARITY-026](ed-parity-026-round3-design.md#ed-parity-026)）；Recent Files 与 Switcher 用 Left/Right 在工具窗口列与文件列之间移动。

- ED-PARITY-024-A1 工具窗口条显示名称、可拖宽、可切换仅图标。
- ED-PARITY-024-A2 任一工具窗口可移到六个锚点，内容经 portal 重新挂载而保留状态（终端会话、搜索结果）。
- ED-PARITY-024-A3 Search Everywhere 用 Tab/Shift+Tab 切分类；Recent Files 与 Switcher 用 Left/Right 在列间移动。
- ED-PARITY-024-A4 Project 头部 Select Opened File / Expand All / Collapse All 与 ⋮ Options 菜单。
- 决策：用户所说的“Ctrl+Alt+N 弹窗方向键切 tab”按 IDEA 实际行为对齐为 Search Everywhere 的 Tab/Shift+Tab（IDEA 方向键在该弹窗里移动列表/光标，不切 tab）。
- V：`TC-IDE-PARITY-024-01`（browser，含 R6 Project 头部）、`TC-IDE-PARITY-024-02`（browser 弹窗按键）、`TC-IDE-PARITY-024-03-tool-window-move-native`（三端 native，移动 Terminal 保留 PTY 会话）。

<a id="ed-parity-025"></a>

## ED-PARITY-025 调试器：断点与暂停态

**IDEA 事实**：断点槽鼠标模型来自 `BreakpointGutterIconRenderer` / `XToggleLineBreakpointActionHandler` 字节码——中键切换启用、右键打开断点气泡、Alt+单击临时断点、Shift+单击非挂起日志断点；气泡为 Enabled / Suspend / Condition + More (Ctrl+Shift+F8) + Done；属性面板（`XDebuggerBundle`）含 Log（"Breakpoint hit" message、Stack trace、Evaluate and log）、Remove once hit、Disable until hitting the following breakpoint（After hit: Disable again / Leave enabled）、Pass count。工具栏为 `XDebugger.ToolWindow.TopToolbar3`：Rerun、Stop | Resume、Pause、Step Over/Into/Out | View Breakpoints、Mute Breakpoints | More。帧视图为线程下拉 + `method:line, Class (package)`，库帧可折叠为 “N hidden frames”；变量视图顶部是 “Evaluate expression (Enter) or add a watch (Ctrl+Shift+Enter)”。

**DAP 边界**：java-debug 0.53.2 没有逐断点挂起策略（`setSuspendPolicy` 为空实现，只有会话级 `suspendAllThreads`），`stopped` 事件没有 `hitBreakpointIds`。因此：不提供 IDEA 的 All/Thread 单选；命中按栈顶帧路径+行匹配；Remove once hit、依赖断点、栈日志、挂起时的日志由客户端执行；纯日志且不挂起的断点仍作为 DAP logpoint 交给适配器；需要客户端处理的非挂起命中经事件闸门（`eventGate`）处理后自动 continue，界面不出现停止态。实例/类/调用者过滤器 DAP 无对应字段，本轮不做。

- ED-PARITY-025-A1 IDEA 槽鼠标模型、图标（红/琥珀/空心/灰/×/✓、条件 ?）、断点行底色、蓝色执行行与箭头、悬停预览、IDEA 提示文字。
- ED-PARITY-025-A2 右键气泡（精简）与空行菜单（Add / Conditional / Logging）；Shift+单击打开展开气泡。
- ED-PARITY-025-A3 View Breakpoints 对话框：按类型分组、完整属性、Space/Delete/F4；Ctrl+Shift+F8 在断点行开气泡、否则开对话框；Ctrl+Alt+Shift+F8 临时断点。
- ED-PARITY-025-A4 属性语义：Suspend、日志三项、Remove once hit、依赖断点、Pass count（= DAP hitCondition）。
- ED-PARITY-025-A5 暂停态：IDEA 工具栏与 More；线程下拉、IDEA 帧格式、库帧折叠、键盘选择、按页加载深栈、帧菜单（Reset Frame / Copy Stack / Jump to Source）；变量区求值/加监视、合并监视、键盘树（方向键、F2、Ctrl+C、Delete、Insert）、IDEA 值格式与右键菜单；Evaluate 对话框（Alt+F8）；inline 值 `name: value`；全局 F7/F8/Shift+F8/F9/Ctrl+F2/Alt+F10。
- V：单元 `debugBreakpointProperties.test.ts`、`useCodeDebugSession.test.tsx`（临时移除、非挂起栈日志直通、依赖断点、启用切换、分页加载）、`debugEditorChrome.test.ts`、`BreakpointUi.test.tsx`、面板测试；`TC-IDE-PARITY-025-01`（browser，A1–A3）；`TC-IDE-PARITY-025-02-debugger-native`（真实 java-debug，A4/A5，Linux native，依赖 java25 fixture）。

## 未覆盖与后续

- Windows/macOS 上真实 java-debug 会话由 CI 计划只在 Linux native 运行（java25 能力仅 Linux 提供）；两平台的调试 UI 仅经 browser 与单元覆盖。
- Smart Step Into、Force Step、Run to Cursor 强制版、Quick Evaluate 弹层、线程挂起/恢复、Mark Object、Inspect、字段/方法断点的 IDEA 专属对话框尚未实现。
- Problems / Run / Terminal 窗口各自工具栏按钮本轮未逐项复核，仅统一了 Options 菜单与头部结构。
