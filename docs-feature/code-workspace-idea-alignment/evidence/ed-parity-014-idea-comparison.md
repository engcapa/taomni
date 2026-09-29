# ED-PARITY-014 IDEA 对照记录

- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，Linux X11（[控件级复核 §4](../references/idea-control-audit-20260929.md#navigation)）。
- Taomni：分支 `feat/ed-parity-014-navigation`（叠在 020 上），browser Chromium 本地 + CI 三端。

| 控件/状态 | IDEA | Taomni（本卡后） | 结论 |
|---|---|---|---|
| All 查询 `total` 的动作 | 仅相关动作 | 只保留词匹配的动作，“Move to Line Start” 不再出现（TC-014-01 R2、单测） | matched |
| All 排序 | 符号 → 文本 → 动作 | 符号 → 文件 → 动作（单测）；文本命中未进 All | different（Text 需后端） |
| 底栏 | 选中项路径 + Open In Right Split | 同；诊断移入状态点 tooltip（R2） | matched |
| Recent Files 布局 | 左工具窗 + Recent Locations，右文件，底部路径 | 同（R3） | matched |
| Show edited only / 再按 Ctrl+E | 切换 | 切换（R3） | matched |
| File Structure 标题 | 文件名 | 文件名（R1） | matched |
| File Structure 无 provider | 不适用（PSI） | syntax-only 大纲并标注（R1、单测） | matched（语义） |
| Inherited/Anonymous/Lambdas 开关、可见性图标 | 有 | 无 | different |
| Go to File 外框宽度、无遮罩、scope 下拉、预览开关 | 有 | 未改 | different |
| Find in Files 浮动弹层 + 可编辑预览 | 有 | 底部 Search 工具窗 | different |
| 项目树头部、External Libraries | 有 | 未改 | different |
| provider 就绪的符号/文本命中 | 见 idea-02 | 未双侧观察 | unverified |
