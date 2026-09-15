# IDEA Rename 参照包（2026.2.2）

## 参照身份

目标：IntelliJ IDEA 2026.2.2，Code Editor，Java，默认 keymap，独占干净 maven-single fixture。公开依据：[Search for usages](https://www.jetbrains.com/help/idea/find-highlight-usages.html)、[Code refactoring](https://www.jetbrains.com/help/idea/refactoring-source-code.html)。本文件是采样规格与可复用摘要；未采集的步骤不作 observed 结论。

## 匹配 fixture 与步骤

fixture 使用 `App.java` 中 `signatureTargets()` 及 `AppTest.java` 调用点，初始 symbol `signatureTargets`，目标名 `renamedTargets`。记录：入口（Refactor > Rename、Shift+F6）、inline rename/editor focus、Rename Preview 文件树与变更计数、取消、确认、外部 dirty 冲突、Undo（Ctrl+Z）后的文本/路径 hash。分别复制 clean、dirty、read-only/library 和 stale 输入；每次记录 IDE build、OS、fixture SHA-256、截图原件 hash。

## 状态转换目标

`idle → rename-input → preview (complete/partial) → confirm → applied → undo`；取消回 `idle` 且零写。provider 不完整、只读、库文件、外部修改或结果过期进入带原因的 blocked/conflict，不进入 applied。截图需覆盖输入、preview、冲突、完成和 undo 后状态；磁盘/hash/历史语义用独立日志记录。

## 当前复用范围与缺口

可复用历史交易设计中关于两文件 rename preview、取消、apply、单次 undo 的场景描述；不能把旧截图或 Taomni browser 截图当作 2026.2.2 当前 IDEA 观测。尚缺本轮独占桌面采样、真实 dirty/read-only/library/stale 负向状态及截图原件。P2 交付前补齐这些原件并保存到被忽略的 `qa-ui-auto-report/idea-reference/ed-ref-001/<run>/`，摘要和 hash 写入本目录 evidence。
