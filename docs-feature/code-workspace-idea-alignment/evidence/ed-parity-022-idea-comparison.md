# ED-PARITY-022 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §2、§8](../references/idea-control-audit-20260929.md#editor-surface)）。
- Taomni：分支 `feat/ed-parity-022-gutter-stripe`（叠在 017 上），browser（parity008 受控 Git）+ Linux/Windows/macOS native 真实 JDT LS。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| VCS 变更条 | 新增绿、修改蓝、删除灰三角 | 同色条（TC-022-01 R1） | matched |
| 变更弹层工具条 | 上一处/下一处、Rollback、Show Diff、Copy、Commit this change | 上一处/下一处（N of M）、Rollback、Show Diff、Copy（R1/R2） | different（无 Commit this change） |
| Rollback | 一次可撤销编辑 | 编辑器事务，Ctrl+Z 恢复（R2） | matched |
| Show Diff | HEAD ↔ 本地 diff 窗 | HEAD（只读）↔ 缓冲区对比（R2） | matched |
| error stripe | 右侧条：错误/警告/TODO/用法/查找刻度，点击跳转 | 错误/警告/TODO/VCS/用法刻度，点击跳转（022-01 R3、022-02 R1） | matched（无查找刻度） |
| 运行图标 | 类与 main 行绿三角；菜单 Run/Debug/Coverage/Modify… | 有 facts 时类与 main 行 ▶；菜单 Run/Debug（022-02 R2） | different（菜单项更少） |
| 无运行 facts | 不显示 | 不显示（022-01 R3） | matched |
| caret 用法高亮 | 语义读/写用法 | Java 仅 provider 结果（022-02 R3），不可用时不冒充 | matched |
| 参数名 inlay | 有 | provider inlay（既有） | matched |
| 重写/实现 gutter 图标 | 有 | 无 | different |
