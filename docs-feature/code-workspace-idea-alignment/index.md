# Code Workspace IDEA 编辑器对齐续办入口

本目录承接 2026-09-28 在本机 IDEA Ultimate 2026.2.2 上进行的真实对比结果，目标是让 Taomni Code Workspace 在功能、交互、快捷键和 UI 组织上逐步贴近 IntelliJ IDEA Code Editor。

本目录是新的规划批次。既有 [code-workspace-idea-parity](../code-workspace-idea-parity/index.md) 任务板继续保留历史首包状态；本批次不重开旧卡，也不把旧卡的 `done` 解释成整体编辑器对齐完成。

## 入口

- [新任务板](backlog.md)：本批次的唯一任务来源。
- [总体设计与交接](alignment-design.md)：目标、范围、任务、验收和验证合同。
- [能力矩阵](capability-matrix.md)：按功能、交互、快捷键、UI 和验证状态拆分差距。
- [IDEA 实机参照](references/idea-live-audit-20260928.md)：版本、隔离 fixture、实际截图和动作记录。
- [P1 交接提示词](handoff-p1.md)：将一张 deferred 卡细化为可开发工作包的固定入口。
- [现场证据清单](evidence/live-audit-20260928.json)：本次采样身份与工件索引。
- [控件级复核](references/idea-control-audit-20260929.md)：2026-09-29 逐控件、逐快捷键的 IDEA/Taomni 对照，及[证据清单](evidence/control-audit-20260929.json)。

## 当前结论

本次实机对比确认了入口和部分快捷键方向一致，但 Taomni 与 IDEA 的编辑器壳层、工具窗口组织、查找/导航焦点、快捷键冲突提示、语言服务反馈和结构搜索呈现仍存在差距。45 场景总体分母来自旧总评估，本批次把其中最影响编辑器体验的差距拆成 13 个可交付工作包（2026-09-29 复核新增 020 代码洞察弹层、021 右键菜单、022 gutter 与标记）。

2026-09-29 复核另确认 6 个源码级缺陷（弹层 Esc 焦点落 `BODY`、`Ctrl+Shift+A` 未注册且输入落入编辑器、`F12` 默认值冲突、Search Everywhere 结果与查询无关、Problems 空态误导、无 provider 时单词补全冒充成员补全），已写入对应卡的首个切片。

本批次尚未实施产品改动，也没有任务可以直接宣称 `ready` 或 `done`。当前 IDEA 证据只覆盖 Linux 本机窗口与隔离 Java 工程；Windows/macOS 真机、不同 DPI、真实 JDT LS 就绪状态和完整 IDEA Keymap 仍须在对应任务中分别验证。
