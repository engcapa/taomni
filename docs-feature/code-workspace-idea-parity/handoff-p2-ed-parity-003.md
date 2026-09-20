# P2 交接指令：ED-PARITY-003 预览标签转正式标签与分屏共享文档

> **使用说明**：本交接文档由 P1 规划阶段生成。请直接复制下方的完整提示词代码块，提供给 P2 开发 Agent 执行。不要让 P2 自行选板、猜 ID 或转去历史旧卡。

---

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障修复、集成、自检和必要当前端验证。

本轮只允许领取 docs-feature/code-workspace-idea-parity/backlog.md 中的 ED-PARITY-003 新卡，并且 p0.planning_required=false、status=ready、依赖全 done。若交接给的是旧板/旧 ID，返回身份不符，不自行改选历史卡或借用其证据。所有 task-board 命令显式带上述 --doc。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的需求 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md，ID 为 ED-PARITY-003，当前状态 ready（无开发 owner）
- 目标范围与用户结果：REQ-04 / CW-TAB-001、CW-TAB-002；一个文件经 preview 打开（斜体）→ 编辑或双击转正式标签（正体）→ Open in Split Right 分屏 → 左右独立光标与选区 → 共享编辑与单次撤销 → 关闭非最后视图保持存活的连续闭环场景。
- 目标 IDEA 与参考包：IntelliJ IDEA 2026.2.2 Ultimate (build IU-262.10315.125)；参考包路径为 docs-feature/code-workspace-idea-parity/references/ed-parity-003-reference.md
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/preview-tab-split-plan.md#ed-parity-003；DEC-01..DEC-07，A1..A3，V1..V4，S0..S7
- 必须保留：
  1. REQ-02 项目树单击只选中节点、双击/Enter 正式打开的已交付合同；
  2. 单视图 dirty 文件关闭时的确认弹窗与 Cancel 取消零变化行为；
  3. LSP 诊断、高亮与定义跳转在多视图与关闭视图后的稳定性。
- 文件/模块 owner 与依赖：
  - 生产核心：src/components/editor/CodeWorkspaceTab.tsx、src/components/editor/workspace/EditorGroup.tsx、src/components/editor/workspace/workspaceDocumentTransactionOwner.ts、src/components/editor/workspace/CodeMirrorHost.tsx、src/components/editor/workspace/recursiveLayoutTree.ts
  - 依赖关系：无前置任务依赖（depends_on: []）
- 验证材料：
  - 定向单元测试：src/components/editor/workspace/EditorGroup.test.tsx、src/components/editor/workspace/workspaceDocumentTransactionOwner.test.ts、src/components/editor/CodeWorkspaceTab.test.tsx
  - 类型检查：python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/EditorGroup.tsx --path src/components/editor/workspace/workspaceDocumentTransactionOwner.ts
  - 原生/浏览器测试：通过 qa_ui_auto 原生驱动或浏览器挂载执行 S0..S7
- 执行环境：当前 Windows 宿主（Windows 11 / WebView2），QA 二进制为 src-tauri/target/qa-ui-auto/debug/taomni.exe（若需执行原生）。
- 修改权限：允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送。
- 当前工作区或交接：分支 docs/code-workspace-idea-audit-20260913，HEAD 17beeabb2c26345f63b0abcf495d5fd5efe01f65。P1 规划完成并校验通过。

先读取适用 AGENTS.md、$code-workspace-idea-task 和 $qa-ui-auto；按需读取 $code-workspace-idea-parity、$idea-reference 及设计 skill 的有效材料。不要自行委派其他 agent。核对任务、依赖、HEAD、生产代码和工作区后，按 task lifecycle 领取（python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md claim ED-PARITY-003）；不是可领取状态、依赖未满足或 ID 不准确时不要另造任务，返回精确缺口。done 卡不得重领。

你与用户及其他 agent 共用工作区。保留已有改动，只修改本卡 owner 范围；共享接口或其他 owner 文件确需调整时，先核对现状并最小化影响，不覆盖或撤销他人成果。未经授权不提交、推送、合并或发布。

按目标 IDEA 参考和设计在真实生产入口实施。当前布局、组件、菜单、样式和交互可以重构，不能用当前错误实现反推验收，也不能把 fixture、experimental 或 mock 冒充生产能力。明确有意改变与必须保留的行为；检查共享状态唯一 owner、动作路由、异步取消/迟到结果、焦点/快捷键抢占、保存/撤销/恢复、IPC、磁盘和 provider 副作用。缺陷修复增加能暴露原错误的最小回归。

发现失败、回归或耗时异常时由你在本轮内先归因：保留原始报告，区分产品退化、测试期望错误、设施故障、依赖缺失和 stale 证据；用最小复现和区分性检查定位，不直接跑全套。授权范围内的本卡回归直接在本卡解决，不能只因目标场景通过就宣布交付。

验证按 efficient-verification 分层进行：开发期间使用定向单测/挂载迭代，相关代码稳定后再执行 scoped typecheck 及原生 QA 运行；需要原生才执行编译，避免高频全量构建。各端独立验证，未执行的平台保持 unverified。双侧比较以真实工件为依据。

全部 AC 满足、必需证据齐全且无未解决回归后，按 task-board 规则在 backlog.md 中更新该任务状态为 done，并附上准确结构化证据（通过 checks 列表包含 document、code-audit、unit、typecheck、browser/native、idea-comparison）。最终报告任务 ID、改动文件、effect 链、命令与结果、unrun 项及能力边界。
```

---

## P3 只读复核补记（2026-09-19，不改变任务板状态与验收结论）

> 性质：本节仅记录只读复核发现的差异与证据缺口，不修改 P1 规约措辞、不修改测试断言、不调用 task-board 写入、不改动生产行为。ED-PARITY-003 保持 `done`；以下任一项如需产品行为变更，须另开新卡，不在本卡内解决。

- **复核基线**：HEAD `17beeabb2c26345f63b0abcf495d5fd5efe01f65`，`task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate` 为 OK；工作区改动与 P2 交付一致（`CodeWorkspaceTab.tsx` 键入转正式修复、`CodeWorkspaceTab.test.tsx` 连续用例、backlog done 证据），未引入其他产品改动。
- **主发现 S6（设计与实现分歧，原样保留）**：设计 `preview-tab-split-plan.md:87` S6 断言“编辑器恢复单 Pane 布局”，而当前实现 `CodeWorkspaceTab.tsx:6938` 在 `usedByOtherGroup` 时直接返回（保活 buffer/dirty，不折叠空 leaf），测试 `CodeWorkspaceTab.test.tsx:6287-6306` 明确断言 2 pane（空 leaf 保留、存活侧完整）并在 idea-comparison 中记为 `different` delta。A1 第 4 项只要求“释放当前视图租约、不 didClose、不销毁 buffer、不丢 dirty”，故 AC 级判定通过成立；但 S6 的单 Pane 折叠仍是未实现的 UI 目标。曾验证的自动折叠方案在关闭 primary leaf 时因 survivor remount 丢失共享 dirty 文本与历史（ED-AUDIT-009 回归），已回退。单 Pane 折叠须以前置条件进入后续新卡：remount 安全的文档/历史保留方案 + 可视化双侧对照，禁止在本 done 卡内偷换 S6 措辞或测试期望去“对齐”实现。
- **证据缺口（逐项确认，均不推翻 done 判定）**：
  1. browser 首次 `ERR_CONNECTION_REFUSED` 属 Vite 未起的设施失败，磁盘有保留但未入卡；后继 `run-20260919-105639` 2/2 通过为有效证据，设施失败无需补入卡内 checks。
  2. 卡内 browser/native 命令省略了实际运行的 `--report-dir qa-ui-auto-report/_local/parity003 --keep-runs 5` 与 browser `--config`；复现时以上述完整命令为准，receipt/summary 以 `run-20260919-105639`（browser）、`run-20260919-105940`（native AUDIT-009）、`run-20260919-110024`（native TREEOPEN）目录为准。
  3. idea-comparison record 的 Taomni S6 观察（dirty=true）来自单测连续链（含 S1b 键入前缀），而原生 AUDIT-009 段 2 关闭前已保存（clean）；两者是不同链路的各自真实观察，record 的顶层 `observations` 已按链路分述，未虚构同源。不做 record 重签（重签需重跑双侧，不符合 efficient-verification 的停止条件）。
  4. 缺 Taomni 关闭非最后视图后的布局截图：单测仅断言 pane 数量与存活内容，原生段 2 仅断言 `1 个 .cm-editor` 与文本/历史；空 leaf 可视形态无截图留存，记为明确缺口，后续折叠卡需补。
  5. native receipt 中 `bundleIdentity.platform="linux"` 是 runner 硬编码标签（`.agents/skills/qa-ui-auto/scripts/qa_ui_auto/bundle_identity.py:265`，native 模式固定写 `linux`），不是本轮 Windows WebView2 运行的平台错报；平台身份以各 run 的 summary/receipt 运行环境与本补记为准。
  6. `index.md` / `capability-matrix.md` 仍为 P1 ready 快照：唯一状态来源是 `backlog.md`，矩阵与索引的派生摘要不在本卡 owner 范围内，不随本卡更新。
- **A3 第 3 项偏薄确认**：LSP 多视图诊断/高亮/跳转稳定性本卡只有 code-audit 静态追踪 + “非最后关闭不调 `lspCloseDocument`”的 mock 断言，无执行性 LSP 多视图用例。 thin 但如实记录，不扩展断言。
- **S0/S1/S3 双侧记录边界确认**：IDEA 侧无 preview 斜体独立工件，record 未对 S0/S1/S3 签发 `matched`；其覆盖来自单测（italic/`data-preview`、双击与键入转正式、独立选区）+ 代码链，未虚构。
- **Unrun 重申**：macOS/Linux 原生、执行性 LSP 多视图、preview→键入转正的原生/浏览器端到端、S6 折叠可视化双侧对照，维持 `unverified`。
- **能力上限重申**：仅 L2（Windows 11/WebView2、纯文本单文件连续闭环）；不含 MRU/拖拽/重启布局、3+ 嵌套分屏、像素级对齐，不宣布 REQ-04 全域 parity。
