# ED-PARITY-017 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11。行内 Rename 见[控件级复核 §5](../references/idea-control-audit-20260929.md#code-insight)；Extract Method 就地模板见 [ED-PARITY-007 参照 R2–R9](../../code-workspace-idea-parity/references/ed-parity-007-reference.md)（原件 `qa-ui-auto-report/idea-reference/ed-parity-007/run-20260927-1143/`）。
- Taomni：分支 `feat/ed-parity-017-refactor-inline`（叠在 018 上），browser（parity007 受控 provider）+ Linux/Windows/macOS native 真实 JDT LS。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 重构选项位置 | 设置 In the editor（默认）/ In modal dialogs | 同名偏好，默认 editor；选项弹层内可切换（TC-017-01 R3） | matched（入口位置 different） |
| Shift+F6 | 名称加框、就地编辑、候选列表、`Press Alt+Shift+O…` 提示 | 加框 + 覆盖输入框（全选）+ 候选列表 + 提示（R1；native 017-03 R1） | matched |
| 其他出现处 | 实时同步修改 | provider documentHighlight 可用时虚框，输入期间不改文档 | different（零修改优先） |
| 候选名 | 名称/类型启发式（`strings`、`stringArrayList`） | 名称驼峰后缀（`stringArrayList`→`arrayList`、`list`） | different（LSP 无类型候选） |
| Esc | 首次关列表（R6）；再次结束 | 同；Rename 零修改、Extract 保留默认名（R2） | matched |
| 再次 Shift+F6 | 打开 Rename 对话框 | 以当前输入打开对话框（R3） | matched |
| Alt+Shift+O 选项 | comments/strings/text occurrences | comments/strings 不可用并给原因；模态选项；Open Dialog | different（provider-bounded） |
| 名称冲突/非法名 | 框内错误气泡，模板保留 | 框内错误，输入保留；非法名本地拦截（R2） | matched |
| Extract Method 命名 | 直达后调用处就地模板 | 直达后在声明名处就地命名，无对话框（TC-017-02 R1） | matched（锚点位置 different） |
| 多文件 Refactoring Preview | Find 工具窗树 + 源码预览，Do Refactor | 模态预览列出文件与真实改前/改后行，Do Refactor（R4；017-03 R2） | matched（容器 different） |
| 行内多文件直接应用 | 行内 Enter 直接改全部文件 | 仍经 Preview 确认 | different（安全优先） |
| 单次事务撤销 | 一次 Undo | 一次 Undo 恢复全部文件（R3/R4；017-03 R2） | matched |
