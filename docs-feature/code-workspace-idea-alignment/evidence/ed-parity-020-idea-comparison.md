# ED-PARITY-020 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §5](../references/idea-control-audit-20260929.md#code-insight)）。
- Taomni：分支 `feat/ed-parity-020-code-insight`（叠在 015 上），browser Chromium 本地 + CI 三端。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 无 provider 的成员补全 `calculator.` | 不适用（PSI 始终可用） | 不再出现缓冲区单词；caret 下方 notice “Member completion unavailable: …” + Configure（TC-020-01 R1、单测） | matched（不冒充成员） |
| 非成员位置 / `Alt+/` | 单词补全 | 保留（`workspace wor` 单测、Alt+/ 未改） | matched |
| Quick Doc 无结果 | caret 处 popup “No documentation found.” | ready 时同文案 popup；不可用时 “Documentation unavailable: …”（TC-020-01 R2） | matched |
| Parameter Info 不可用 | popup | notice “Parameter info unavailable: …”（R3） | matched（语义） |
| Alt+Enter 不可用 / 无动作 | popup 列表或 “No intentions” | notice（R4），不再只写状态栏 | matched（语义） |
| popup 焦点 | 不抢焦点，Esc 关闭 | 同；Esc 后焦点 `.cm-content`、caret 不变（R1–R4） | matched |
| 补全列表行结构/底栏 `Enter 插入 / Tab 替换` | 有 | 未改 | different（后续） |
| 补全内 `Ctrl+Q` 文档卡、Intention 差异预览、错误 tooltip 结构 | 有 | 未改 | unverified（需真实 provider 双侧对照） |
