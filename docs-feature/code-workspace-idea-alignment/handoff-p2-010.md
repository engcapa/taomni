# ED-PARITY-010 P2 执行提示词

将下面正文交给负责实现的 agent。本提示词启动 P2 产品开发与验证；P1 文档中“本轮只做设计”的限制描述的是上一阶段，不适用于本次 P2。

---

请使用 `code-workspace-idea-task` 执行 Taomni 的 **ED-PARITY-010：Code Workspace 壳层与工具窗口布局对齐**，使用 `qa-ui-auto` 完成相关验证。直接按已完成的 P1 合同领取、实现、测试和回填证据，持续推进到本卡可诚实交付的状态。

## 唯一任务与必读输入

从当前 Taomni 仓库根目录执行，先读适用 `AGENTS.md` 及上述技能。唯一任务板为：

`docs-feature/code-workspace-idea-alignment/backlog.md`

只领取 `ED-PARITY-010`，不从旧 parity 板领取，不继续实现 011–022。必读：

1. [010 独立实施合同](shell-layout-010-plan.md#ed-parity-010)：完整阅读，尤其 §4 状态/快捷键、§5 数据/生命周期、§6 AC、§7 T1–T6。
2. [完整测试合同](shell-layout-010-plan.md#test-cases)：V0–V7 的 fixture、动作、逐步断言、拟新增 YAML 和共享消费者回归。
3. [总体设计](alignment-design.md)：沿用 DEC-ALIGN-06/07/11；DEC-ALIGN-08 的选区 AI 工具条由其他卡处理。
4. [共享契约](../../claudedocs/code-workspace-idea-specs/shared-contracts.md)：workspace/document/view owner、typed failure、cancel/stale、undo/recovery。
5. [IDEA 控件级参照](references/idea-control-audit-20260929.md#shell)及 [010 状态补采](references/idea-shell-010-20260929.md)。
6. [可编辑布局图](assets/shell-layout-010.drawio)、[正常布局预览](assets/shell-layout-010.png)、[Hide All 预览](assets/shell-layout-010-max.png)。图稿表示布局和职责，不是像素金图或产品已实现证据。

P1 基线为 `6763642b`，当时产品实现和所有产品运行验证均未执行；010 已转 `ready`、`planning_required=false`。这是历史交接信息，开始时必须重新检查当前 HEAD、worktree、卡状态和已有改动。保留当前未提交的 P1 文档及其他人的工作，不通过 reset/checkout 清理它们。不要把现存辅助模型、截图、fixture 或旧绿卡当成本卡已完成。

## 领取与执行方式

先读技能的 task-lifecycle / evidence-policy。所有 task-board 命令显式携带本板 `--doc`：

```bash
git rev-parse HEAD
git status --short
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-alignment/backlog.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-alignment/backlog.md show ED-PARITY-010
```

确认卡可领取且依赖满足后，使用当前会话的稳定 owner 标签。下面命令中的 `<owner>` 要替换为实际标签，不要原样执行尖括号：

```text
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-alignment/backlog.md claim ED-PARITY-010 --owner <owner>
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-alignment/backlog.md update ED-PARITY-010 --owner <owner> --status in_progress
```

若已有其他 owner 或状态已变化，按当前事实处理，不能覆盖领取信息或重开 done 卡。领取后重新审计真实生产 caller，不照着旧行号机械修改。

本次已授权实现该设计、必要的 UI/组件重构、配套测试和当前端验证。普通实现选择自主完成，不重新请求设计批准。只在出现超出本卡的实质需求取舍或无法自主解决的合同冲突时提出具体问题；期间继续独立工作。T1–T6 是同一卡内部工作包，不是额外任务卡，也不构成并发 agent 授权。本提示词不要求提交 commit、推送或创建 PR。

## 必须交付的生产行为

按照独立合同实施，不用本节摘要替代完整 AC：

- 提供真实左右工具 rail、left/right/bottom 工具区域、稳定 editor、主 toolbar 和 workspace status。侧窗与底窗可以同时显示；全部原有工具仍能从 rail/More/View/Action 找到。
- 统一工具激活状态 owner 与 Action 路由：隐藏时打开并聚焦；显示但失焦时先聚焦；显示且聚焦时再次触发才隐藏。`Esc` 返回原 editor leaf，保留工具可见；`Shift+Esc` 隐藏当前工具；`Ctrl+Shift+F12` 隐藏全部并可恢复原组合；`F12` 跳到最后工具；Restore Default 是独立动作。
- 所有 focus 查询和迟到 callback 限定当前 workspace。保留 IME、输入框、terminal 子输入及 modal 的优先级。默认绑定以 IDEA 为准，保护用户自定义 scheme；保留 `Ctrl+B` 定义导航。
- 隐藏、切换、resize、最大化和默认恢复不能丢 editor leaf、dirty、undo/redo、每 leaf 选择/滚动、查询/结果、Git draft/selection 或真实 PTY 会话；隐藏不等于 dispose。
- 增量迁移 layout 数据，保留旧布局、合法文档/视图数据和兼容字段；处理 resize cancel、storage 失败/重试、workspace 切换与 stale 结果。
- 将低频 toolbar 动作迁到可达菜单，保留原 Action 和真实效果；SDK/Facts、导航和 editor 状态进入 workspace status，保护应用其他 tab 的状态与操作。
- Commit 和 Git 必须接入现有 Changes/Commit/Log/Diff 的真实共享 controller，不能用占位面板或跳到独立 Git tab 代替。独立 Git 管理器仍需正常工作，保留 multi-root 隔离和迟到响应保护。

保留 `failed/cancelled/stale/conflict/unknown-effect` 的真实语义。不得通过吞错、显示假空态、禁用已有能力或放宽测试来取得绿结果。

## 工作顺序与边界

1. **V0 / T1 前置**：建立受影响保留行为的改前基线，覆盖常驻工具内容、dirty/undo、多 leaf、旧布局、Git 多仓库迟到隔离。没有执行的基线明确标未知；缺陷回归与保留行为检查分别记录。
2. **T1**：统一 store/controller/registry 和布局迁移，旧 setter 通过 adapter 收敛，不建立双状态 owner。
3. **T2/T3**：切换 shell/rail/frame、resize 与焦点/Action 接线，保持 document 和工具内容的稳定生命周期。
4. **T4**：提取 Git controller 并接两个工具容器，验证独立 Git 管理器共享消费者。
5. **T5**：迁移 toolbar/status/navigation 和 SDK/Facts 呈现，验证所有被移动入口及应用其他 tab。
6. **T6**：组合验证、补齐 YAML/catalog/controls、最终 diff 审查和证据回填。

010 负责工具容器、现有内容接入与自身焦点；011 接续 editor 内部表面，012 接续通用弹层，013 接续完整 Keymap UI，015 接续 Problems/provider 状态，018 接续 Git/Run 内容细节。不要反向等待这些后续卡来完成 010 已承诺的行为；本卡造成的相邻退化必须在本卡修复。

## 测试与证据要求

逐项兑现 `ED-PARITY-010-A1..A4` 和 V0–V7。把计划中的测试变成真实可执行用例并运行，不能只补设计说明：

- 优先按 V0–V5 运行精确的 unit/mounted/browser 检查，覆盖正常、空、加载、失败、取消、恢复、各入口、实际快捷键及保留行为。新增 YAML ID 和文件名以 §8 为准，落地前再次检查冲突。
- 修改 YAML 时同步 `covers`、`fixtures`、`modes`、`verification`、`feature-list.md` controls、CI policy/dependencies。按技能完成相关静态门禁；静态通过不代表行为通过。
- 代码稳定后，对全部 owned paths 做一次 scoped typecheck，包括 Git/status/MainLayout 的实际编辑路径；不能缩小 scope 隐藏错误。全库 frontend build/integration 由 019 收口，010 仍负责自身类型与当前端 native 构建/运行。
- 按 V6 使用绑定当前源码的隔离 QA 应用，稳定输入后集中构建和执行。验证真实磁盘 save→undo→save/hash、PTY 会话保留、Git 容器实际数据与取消零写入、OS 快捷键/IME 和 WebView 焦点。不要用 browser VFS、旧安装包或 mock 替代。
- 按 V7 分别记录 IDEA 功能、交互、视觉差异与 accessibility 的 keyboard/focus/name/role/state/zoom/screen-reader/IME。`compare_idea.py` 普通退出码 0 只是结构合法；宣称 measured match 的范围需要实际双侧观察、几何/视觉评审和相应匹配检查。
- Windows、macOS、Linux 代码均须兼容。当前运行端完整 native 验证是本轮要求，其他端未实测写明范围和后续步骤，不继承当前端通过结论。

IDEA 先复用有效参照，只补缺失状态。用户已授权在当前会话控制桌面采集；采样前核对实际版本、窗口、隔离 fixture 与焦点，不能硬编码旧 PID/窗口 ID。若桌面出现用户输入交错，停止输入并保留诊断。原件目录被忽略：

`qa-ui-auto-report/idea-reference/ed-parity-010-p1-20260929/`

P1 补采客户区为 1920×1044，旧参照为 1400×1000，设计图为 1400×900；不能混作相同 profile 的像素证据。按 DEC-ALIGN-06 对齐窗口、字体、字号、行高、主题和缩放后再判断；只补必要参照，不修改用户全局配置。

本卡 required evidence 为 `code-audit/unit/typecheck/browser/native/accessibility/idea-comparison`。一个合格运行可覆盖多个 kind/AC，避免重复构建。原始报告、receipt、日志、截图、hash 与手工记录保存在 `qa-ui-auto-report/ed-parity-010/<run>/`，不要提交原始日志或伪造 runner 记录。保留失败到修复后通过的完整历史。

## 收尾与交付

审查最终生产链：用户入口 → 当前 workspace owner → provider/IPC 或布局效果 → typed result → failure/cancel/stale → undo/recovery → 实际证据。回填独立设计中的 **AC → V → 实际测试/断言 → 结果/报告/receipt**，记录新文件、具体命令、通过/失败/skip/unrun 数、平台范围及接受差异。

使用 task-board 脚本按实际结果更新本卡：

- `done`：全部 AC、required evidence、受影响保留行为及当前端要求满足，无本次引入的未解决退化。
- `implemented`：产品实现完整，但明确的必需证据仍缺失；不能把产品退化伪装成仅缺证据。
- `blocked`：存在可复现外部前置障碍，写明恢复条件。
- `review_required`：出现需要维护者决策的实质合同冲突，写清冲突及影响。

尽力解决可修复问题后再结束，不因一轮测试失败就提前交接。最后验证本板、检查 diff，报告任务状态、基线/最终 worktree、实现效果、验证结果、未验证平台和能力上限。没有额外指示时，交付保留在工作区，不提交或推送。
