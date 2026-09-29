# Code Workspace IDEA 对齐续办能力矩阵

本矩阵只描述本批次的 13 个工作包，不计算总体完成百分比。每个维度必须由同一 fixture、同一 profile 和可追踪证据支持；旧卡完成不自动关闭本矩阵。2026-09-29 列来自[控件级复核](references/idea-control-audit-20260929.md)，Taomni 侧仅 browser 证据。

| 任务 | 功能 | 交互 | 快捷键 | UI | 2026-09-29 已确认缺陷 | 当前判断 |
|---|---|---|---|---|---|---|
| ED-PARITY-010 壳层与工具窗口 | 部分已有 | 确认差异 | 确认差异（`Shift+Esc`、`Alt+0/7/9` 缺失） | 确认差异（无 rail、工具栏密度、状态栏截断） | — | deferred |
| ED-PARITY-011 编辑器表面 | 部分已有 | 确认差异（Go to File 开 preview tab） | 部分已有 | 确认差异（顶部两条常驻条、无默认折叠） | — | deferred |
| ED-PARITY-012 Find/Replace 与弹层焦点 | 部分已有 | **确认缺陷**（5 处 Esc 焦点落 `BODY`） | 部分已有 | 确认差异（缺历史/清除/多行/过滤/Exclude） | 焦点归还 | deferred |
| ED-PARITY-013 Keymap/快捷键 | 部分已有 | 确认差异（默认方案只读、平铺列表） | **确认缺陷**（`Ctrl+Shift+A` 落入编辑器、`F12` 冲突） | 确认差异（原始键名、Linux 显示 `Meta+`） | `Ctrl+Shift+A`、键名格式 | deferred |
| ED-PARITY-014 项目树与导航 | **确认缺陷**（Search Everywhere 结果与查询无关） | 确认差异 | 部分已有 | 确认差异（弹层宽度/遮罩/单列 Recent） | Search Everywhere 过滤排序 | deferred |
| ED-PARITY-015 Java provider/诊断 | **确认缺陷**（Problems 把不可用显示为无问题） | 待 native | 部分已有 | 确认降级差异 | Problems 空态 | deferred |
| ED-PARITY-016 Structural Search | AST 结果部分对应 | 确认结果树差异 | 入口待验证 | 确认 dialog/工具窗差异 | — | deferred |
| ED-PARITY-017 Refactor/事务撤销 | 局部已有 | IDEA 行内 rename/extract 已采样，Taomni 待 native | 部分已有 | 待验证 | — | deferred |
| ED-PARITY-018 Git/Run/Debug 工具窗 | Git 首包部分已有 | 确认差异（无 workspace Commit/Log 工具窗） | 待验证 | 确认差异 | — | deferred |
| ED-PARITY-019 三端与组合收口 | 未执行 | 未执行 | 未执行 | 未执行 | — | deferred |
| ED-PARITY-020 代码洞察弹层 | **确认缺陷**（单词补全冒充成员补全） | 确认差异（Quick Doc/Alt+Enter 只写状态栏） | 部分已有 | 确认差异（向上展开、无签名/类型/底栏） | 无 provider 补全 | deferred |
| ED-PARITY-021 右键菜单 | 部分已有 | 确认差异（可用态不一致、越界） | 部分已有 | 确认差异（顺序/分组/子菜单/助记符） | — | deferred |
| ED-PARITY-022 Gutter 与标记 | 缺失（browser） | 待 native | — | 确认差异 | — | deferred |

## 旧批次与新批次的关系

旧 `ED-PARITY-001..009` 证明了若干局部功能、数据事务和 provider 首包。新批次把实机对比中仍未闭合的体验差距拆开：010/011 处理 shell/editor surface，012/013 处理交互与快捷键，014–018 与 020–022 处理主要编辑器能力与控件，019 负责组合和三端证据。新卡不复用旧卡的 done 作为本卡验收，只复用其代码契约和有效测试。
