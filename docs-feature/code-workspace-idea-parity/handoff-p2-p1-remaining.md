# P2 统一开发交接：ED-PARITY-008 + ED-PARITY-009

你负责 Taomni Code Workspace 与 IntelliJ IDEA 对齐的一个统一 P2 工作包。唯一任务板是 `docs-feature/code-workspace-idea-parity/backlog.md`；本次固定处理两张原卡：`ED-PARITY-008`（REQ-07 / CW-GIT-001、CW-GIT-003）和 `ED-PARITY-009`（REQ-09 / CW-SEARCH-003）。不要新建替代卡、不要领取旧历史卡。开发领取后仍须分别在这两张卡写 owner、claimed_at、baseline、evidence 和终态；本文件只是总交接。

## 必读材料与基线

- 设计与完整测试用例：[p1-remaining-unified-plan.md#p1-remaining](p1-remaining-unified-plan.md#p1-remaining)；按卡读取 `#ed-parity-008`、`#ed-parity-009` 和 [`#test-cases`](p1-remaining-unified-plan.md#test-cases)。
- IDEA 参照：[ed-parity-008-009-reference.md](references/ed-parity-008-009-reference.md)。原始截图和 fixture 在 `qa-ui-auto-report/idea-reference/p1-remaining/run-20260927/`，输入污染/远程桌面断开原件不能当证据。
- 生产入口：`src/components/editor/workspace/useWorkspaceGitSnapshots.ts`、`src/components/git/WorkspaceGitManager.tsx`、`src/components/git/WorkspaceChangesView.tsx`、`src/components/git/DiffViewer.tsx`、`src/lib/git.ts`、`src-tauri/src/git.rs`；SSR 基础为 `src/components/editor/workspace/companionCapabilities.ts`。
- 当前源码 HEAD：`a9e37c2e9a91b2c4b58eb91e45cc05796b85f5e3`。接手先记录 branch/status/diff，不覆盖其他改动。

## 实施顺序与责任

1. **TASK-008 / ED-PARITY-008**：建立 F3 两个隔离本地仓库 fixture；修复/补强 repoRoot + request generation 的快照、diff pair、scope、切换与迟到隔离；保留单仓库、refresh、编辑器 dirty/selection 和取消零写入。新增/复用 browser、unit、native 用例。
2. **TASK-009 / ED-PARITY-009**：实现 Java AST parser/backend adapter、typed query/result/unavailable/error 生命周期和首个 Structural Search UI。支持 `System.out.println($arg$);`、Text=42/999、范围与结果树导航；严禁 regex fallback。若 parser 依赖不能三端构建，先给明确 unavailable 和阻塞证据，不把空结果当成功。
3. **TASK-INTEGRATE**：最后处理共享 `CodeWorkspaceTab` 路由/Actions、Find/project search/editor selection 回归，维护 `qa-ui-auto-tests/feature-list.md` 的 covers/controls，合并执行选定用例并回填两张卡。

## AC 与证据回填

- 008：A1 状态/diff 与两 repo manifest 一致；A2 IDEA/Taomni 功能、交互、视觉分开比较；A3 取消/关闭零 Git 写入、迟到响应不串 root、编辑器状态保持。对应 V-008-01..03。
- 009：A1 三处/一处/零处 AST 精确集合且 typed unavailable；A2 Java 模板、modifier、结果树、导航、高亮、空态和关闭有双侧证据；A3 local Find/regex/editor/磁盘保留且资源释放。对应 V-009-01..03。
- 共享 V-009-04 覆盖两卡受影响的入口、快捷键、焦点和结果返回。

P2 必须实际新增或复用精确 `TC-IDE-PARITY-008-*`、`TC-IDE-PARITY-009-*` YAML，运行前查重并维护 feature controls。浏览器只能证明 renderer 入口和可见结果；native 必须独立证明真实 Tauri IPC、Git 磁盘状态、provider/parser 资源和无写入。required evidence：008 为 `code-audit,unit,typecheck,browser,native,idea-comparison`；009 为 `code-audit,unit,typecheck,browser,native,provider,rust,idea-comparison`。

## 最小验证与终态

先运行受影响 Vitest/browser；稳定后对所有 owned paths 做一次 scoped typecheck，Rust 变更运行 focused `cargo test`。按当前环境运行一次隔离 native，三端代码兼容审查分别记录；Windows/macOS 缺设备保留未验证。使用匹配源码、case、runner、build、fixture 身份生成 IDEA comparison record，不能把参考截图或 validator exit 0 写成 matched。

最终分别复核两卡 AC、保留行为和 required evidence，再用显式 `--doc docs-feature/code-workspace-idea-parity/backlog.md` 更新各卡。`done` 只在全部证据通过；实现完成但证据缺失为 `implemented`；真实外部前置阻塞才为 `blocked`。不得用统一 handoff 状态替代细任务状态。
