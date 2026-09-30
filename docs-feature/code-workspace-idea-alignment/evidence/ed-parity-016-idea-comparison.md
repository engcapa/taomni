# ED-PARITY-016 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[实机参照 · Structural Search](../references/idea-live-audit-20260928.md#structural-search)）。
- Taomni：分支 `feat/ed-parity-016-structural-search`（叠在 021 上），browser Chromium（parity009 fixture 后端）本地 + CI 三端；native tree-sitter 由 009-03/06 保留。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| 入口与独立对话框 | Search Structurally… | 同（009-01、016-01） | matched |
| Recent / Existing Templates | 左侧模板树 | 左栏 Recent + Existing Templates · Java（TC-016-01 R1、单测） | matched（模板数量较少） |
| 模板编辑器 + Language | Java | 同 | matched |
| 过滤器 Count/Reference/Text/Type/Script | 全部可用 | Add filter 列出全部，Text 可用，其余 typed unavailable 并给原因（R2） | different（后端限制，已显式声明） |
| Scope | In Project/Module/Directory/Scope | In Project/Module/Current File | different |
| 结果树 class → method → location、导航高亮 | 有 | 有（009-01） | matched |
| Text=42 / 999 | 1 / 0 | 1 / 0（009-02） | matched |
| Replace、Injected code、Script | 有 | 无 | different |
