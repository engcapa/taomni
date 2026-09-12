# Format Document 命令失效修复设计

## 1. 设计摘要与范围

- 问题类型：功能缺陷
- 设计状态：可实施
- 来源：Linux Tauri 手工测试：context menu 与快捷键 Format code 均无效果。
- 推荐方案：统一 `workspace.format` 的命令、context menu binding 和 `formatActiveFile` 执行链；能力尚未 ready 时保持命令可发现但显示明确状态，provider 请求失败必须可见，不静默吞错。

## 2. 当前实现与问题依据

| 位置 | 当前行为 | 依据 |
|---|---|---|
| `CodeWorkspaceTab.tsx:13407` | `workspace.format` 使用 `Ctrl+Alt+L`，when 依赖 formatting/rangeFormatting capability | 源码事实 |
| `CodeWorkspaceTab.tsx:8667` | `formatActiveFile` 调 `formatFileText`，`next === null` 直接返回，catch 仅 `console.error` | 源码事实 |
| `CodeWorkspaceTab.tsx:16558` | context menu 通过 `prepareBinding("workspace.format")` | 源码事实 |
| 用户手工测试 | 快捷键和 context menu 均无效果 | 实测事实 |

因果链候选：capability 尚未 ready/被报告为 false → action `when` 禁用；或 provider 调用返回 null/错误而仅写 console → 用户看到静默无反应。需要测试分别覆盖两条分支。

## 3. 验收

| ID | 前置与动作 | 结果 |
|---|---|---|
| AC-FMT-01 | formatter capability true，快捷键执行 | 当前文件按 provider 返回文本更新，dirty/LSP 同步正确 |
| AC-FMT-02 | 同条件 context menu Format | 与快捷键得到相同结果和 target |
| AC-FMT-03 | capability loading/未报告 | 命令可发现或显示加载中/不可用原因，不静默禁用 |
| AC-FMT-04 | provider 不可用、请求失败、只读文件、选区不支持 | 状态栏显示明确原因，不修改文件 |
| AC-FMT-05 | format on save、undo/redo、CRLF/BOM | 保持既有保存策略和格式元数据 |

## 4. 修复方案与决策

保留 `workspace.format` 单一 action。将 capability gating 从“未 ready 即禁用”改为允许执行并由 `formatFileText` 返回 typed unavailable；若产品要求菜单禁用，则至少提供 disabled reason/status。`formatActiveFile` 不再静默 catch：把 provider 错误、null reason 和只读原因写入 status message。context menu 继续使用 frozen binding，避免重算 target。

无需原型和人工决策，属于恢复既有 Format Document 契约。

## 5. 改动清单

| 文件 | 变更 | AC |
|---|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx` | `workspace.format` when/run、`formatActiveFile` 错误反馈和 capability readiness | AC-FMT-01..05 |
| `src/components/editor/workspace/editorContextMenu.ts` | 核对 Format binding 的 enabled/disabled reason | AC-FMT-02..04 |
| `CodeWorkspaceTab.test.tsx` | 快捷键、context menu、loading/error/readonly 回归 | 全部 |
| `qa-ui-auto-tests` | 新增/复用 native format case | AC-FMT-01/02/04 |

## 6. 任务

### TASK-FMT-01 Format action 链路

- 职责：`CodeWorkspaceTab.tsx`、`editorContextMenu.ts`。
- 依赖：无；先确认 capability state 的 ready/unknown 语义。
- 实施：增加失败测试；保持快捷键 `Ctrl+Alt+L`（macOS 对应 Meta 变体）和 context menu 使用同一 action；将 null/error 转为状态反馈；保留选区格式化和只读保护。
- 验收：AC-FMT-01..05。

### TASK-FMT-02 provider/native 验证

- 职责：测试与 QA case、三端真机复测。
- 依赖：TASK-FMT-01。
- 实施：使用真实 Java formatter capability 和不可用 provider 两条路径，检查磁盘/内存/undo。

## 7. 验证

| V ID | 层级 | 操作与断言 | 命令 | 状态 |
|---|---|---|---|---|
| V-FMT-01 | Vitest | formatting true 时快捷键和 context menu 均修改文本；false/loading/error 有状态提示 | `pnpm test -- src/components/editor/CodeWorkspaceTab.test.tsx src/components/editor/workspace/editorContextMenu.test.ts` | 待执行 |
| V-FMT-02 | typecheck | 修改路径 scoped check | `python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <changed paths>` | 待执行 |
| V-FMT-03 | Linux native/provider | QA app + JDT formatter，快捷键/context menu、只读和失败分支 | `python .agents/skills/qa-ui-auto/scripts/native_build.py`; `python -m qa_ui_auto run --mode native --filter <format case>` | 待执行 |

真机计划：Linux 当前环境执行；Windows WebView2、macOS WKWebView 需分别复测并记录未验证。浏览器测试仅证明 renderer action wiring，不能证明真实 JDT formatter。

## 8. 交付与风险

不能把 provider 未 ready、请求失败或只读状态转换成静默成功。保持三端快捷键映射、LSP 同步、保存格式和撤销契约。TASK-FMT-01 可立即开始，TASK-FMT-02 依赖其完成。
