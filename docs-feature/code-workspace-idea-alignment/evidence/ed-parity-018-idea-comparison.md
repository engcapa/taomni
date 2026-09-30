# ED-PARITY-018 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §8](../references/idea-control-audit-20260929.md#git-run)）。
- Taomni：分支 `feat/ed-parity-018-git-tool-window`（叠在 016 上），browser（parity008 受控 provider）+ Windows/Linux native 真实仓库。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| Alt+9 | Git 工具窗（底部） | workspace Git 工具窗（底部，TC-018-01/02 R1） | matched |
| Alt+0 / Commit | 左侧 Commit 工具窗 | 指向同一底部 Git 工具窗（R2） | different（位置合并） |
| 变更树 + 提交消息 + Commit / Commit and Push | 有 | 有（同 Git 管理器） | matched |
| Log：分支树、过滤、提交列表、详情 | 有 | 有（同 Git 管理器） | matched（布局 different） |
| 隐藏/重开保留状态 | 保留 | 首次挂载后保留（R2） | matched |
| 零 Git 写入 | 只读浏览不写 | index/refs/worktree 字节不变（018-02 R2） | matched |
| Terminal 会话 tab、`+`、`˅` | 有 | 未改 | different |
| 独立 Git 标签 | 无 | 保留为 “Open in Git Tab” | different（accepted） |
