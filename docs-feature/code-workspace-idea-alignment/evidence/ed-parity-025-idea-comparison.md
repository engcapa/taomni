# ED-PARITY-025 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125。调试 action 结构来自 `lib/intellij.platform.debugger.impl.ui.jar!/intellij.platform.debugger.impl.ui.xml`（`XDebugger.ToolWindow.TopToolbar3`、`XDebugger.ValueGroup`、`XDebugger.Frames.Tree.Popup`、`XDebugger.Hover.Breakpoint.Context.Menu`），文案来自 `XDebuggerBundle` / `XDebuggerUiBundle` / `JavaDebuggerBundle`，槽鼠标行为来自 `BreakpointGutterIconRenderer`、`XLineBreakpointManager$MyEditorMouseListener`、`XToggleLineBreakpointActionHandler` 的 `javap` 反汇编，键位来自 `$default.xml` / `Default for XWin.xml`。
- 适配器：java-debug 0.53.2（`com.microsoft.java.debug.core`），用于确认 DAP 边界。
- Taomni：分支 `feat/ed-parity-round2-detail`，browser 三端（TC-025-01）+ Linux native 真实 java-debug（TC-025-02、TC-IDE-DEBUG-01）。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 槽单击 / Alt+单击 / Shift+单击 | 切换 / 临时断点 / 非挂起日志断点并展开属性 | 同（TC-025-01 R1） | matched |
| 中键 / 右键 | 启用↔禁用 / 断点气泡 | 同（R1、R2） | matched |
| 空行右键 | Add Breakpoint / Conditional… / Logging… | 同（R2） | matched |
| 断点气泡 | Enabled、Suspend（All/Thread）、Condition、More、Done | Enabled、Suspend、Condition、More、Done | different（java-debug 无逐断点 All/Thread） |
| 属性：Log | "Breakpoint hit" message、Stack trace、Evaluate and log | 同；非挂起纯日志交 DAP logpoint，栈日志等由客户端执行（TC-025-02） | matched |
| Remove once hit | 命中后删除 | 同（TC-025-02 真实会话） | matched |
| Disable until hitting… / After hit | 依赖断点，Disable again / Leave enabled | 同（单元测试覆盖，按会话武装） | matched（native 未单独演示） |
| Pass count | Java 过滤器中的通过次数 | 映射 DAP hitCondition | matched |
| Instance / Class / Caller filters | 有 | 无（DAP 无字段） | different |
| View Breakpoints 对话框 | 按类型分组树 + 属性面板，Space/Delete/F4 | 同（R3） | matched |
| 槽图标与行色 | 红/非挂起/禁用空心/静音灰/无效、条件 ?、断点行底色、蓝色执行行+箭头、悬停预览 | 同 | matched |
| 工具栏 | Rerun、Stop｜Resume、Pause、Step Over/Into/Out｜View/Mute Breakpoints｜More | 同；More 含 Run to Cursor、Show Execution Point、Evaluate、Reset Frame、Step Back、类重载 | different（无 Smart/Force Step、Force Run to Cursor） |
| 标签页 | Threads & Variables、Console | Threads & Variables、Console，另保留 Breakpoints、Memory | different（多两个 Taomni 页） |
| 线程 | 下拉 `"main"@1 in group "main": RUNNING` | 下拉 `"main"@1: SUSPENDED/RUNNING` | different（DAP 无线程组/详细状态） |
| 帧 | `method:line, Class (package)`，库帧灰显/折叠 “N hidden frames”，懒加载 | 同（TC-025-02 真实帧 `main:7, App (com.example.app)`） | matched |
| 帧菜单 | Reset Frame、Copy Stack（Java 另有 Force Return 等） | Reset Frame、Copy Stack、Jump to Source | different（无 Java 专属项） |
| 变量区 | 顶部 Evaluate(Enter)/Add watch(Ctrl+Shift+Enter)，监视并入树，键盘树与 ValueGroup 菜单 | 同（TC-025-02 求值 43）；菜单为 Set Value/Copy Value/Copy Name/Evaluate/Add to Watches | different（无 Inspect/Mark Object/Referring/Pin） |
| Evaluate 对话框 | Alt+F8，结果树 | 同 | matched |
| inline 值 | `name: value` 灰色 | 同 | matched |
| 全局步进键 | F7/F8/Shift+F8/F9/Ctrl+F2/Alt+F8/Alt+F10 | 同（XWin keymap 一致性测试） | matched |
