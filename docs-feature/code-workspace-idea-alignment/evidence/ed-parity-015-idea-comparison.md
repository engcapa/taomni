# ED-PARITY-015 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §8](../references/idea-control-audit-20260929.md#git-run)）。
- Taomni：分支 `feat/ed-parity-015-java-readiness`（叠在 012 上），browser Chromium 本地 + CI 三端（native 真实 JDT LS）。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 服务不可用时的 Problems | 不会出现（IDEA 自带 PSI）；索引中显示 “Analyzing…” | typed 状态行 `data-state` + 原因 + Configure/Retry，不再显示 “No problems”（TC-015-01） | matched（语义） |
| 状态胶囊与 Problems 文案 | 同源（检查 widget 与 Problems 计数一致） | `languageServiceReadiness` 单一来源（单测 + TC-015-01 R1） | matched |
| 旧结果在服务重启/降级时 | 保留并重新分析 | 保留并标注 “Results may be outdated”（单测） | matched |
| 按文件分组 + 计数 | `App.java 2` | 组头文件名 + 计数（TC-015-02 R1） | matched |
| 行尾位置 | `:9` | `:行号`，列在 tooltip（TC-015-02 R1） | matched |
| 错误/警告计数 | widget `❗1 ⚠1` | pill `1E 1W` 与 Problems 过滤按钮计数同源（TC-015-02 R2） | matched |
| File / Project Errors 标签 | 有 | Open files / Whole project（保留 testid） | different（accepted，019 复核） |
| 行左侧查看/快速修复/预览按钮 | 有 | 仅右键 Quick Fix | different（018/022） |
| Basic Completion 接受/import/snippet/undo | 见 idea-11/12 | C2-01、PARITY-005-05 三端真实 provider | matched（既有证据） |
| Smart / Type-Matching | 可用 | typed unavailable（`editor.smartCompletion`） | different（已声明） |
| 补全弹层外观 | 结构化列表 | 未改 | 交 020 |
