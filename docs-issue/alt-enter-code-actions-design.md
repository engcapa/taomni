# Alt+Enter Code Actions 修复设计

## 1. 设计摘要与范围

- 问题类型：功能缺陷
- 设计状态：可实施
- 来源：Linux Tauri 手工测试：编辑器内按 Alt+Enter 无反应。
- 平台范围：Windows、macOS、Linux Tauri 桌面应用。
- 推荐方案：在统一 workspace action dispatcher 中补齐 `Alt+Enter` 的原生事件归一化与 editor target 解析；命令仍由 `workspace.codeActions` 和 `openCodeActionsAtCursor` 执行，避免新增第二套快捷键系统。

## 2. 当前实现与问题依据

| 位置 | 当前行为 | 依据 |
|---|---|---|
| `src/components/editor/CodeWorkspaceTab.tsx:13525` | 注册 `workspace.codeActions`，声明 `keybinding: "Alt+Enter"` | 源码事实 |
| `CodeWorkspaceTab.tsx:14985` | capture listener 将事件交给 `dispatchKeydownV2` | 源码事实 |
| `workspace/workspaceCommands.ts:eventLogicalKey/parseKeybinding` | 负责组合键归一化与匹配 | 源码事实 |
| `openCodeActionsAtCursor` | 依赖活动 editor、诊断和 LSP codeAction 能力 | 源码事实 |

因果链：Linux WebView 产生的 Alt+Enter 事件未被统一 dispatcher 匹配或未解析到活动 editor → action 未执行 → 无菜单、状态或错误反馈。根因当前为“事件归一化/分发链候选”，需以新增失败测试确认具体断点。

## 3. 验收

| ID | 前置与动作 | 结果 |
|---|---|---|
| AC-ALT-01 | 活动编辑器存在诊断，按 Alt+Enter | 显示 Code Actions/Quick Fix 菜单，焦点和当前文件保持不变 |
| AC-ALT-02 | 无诊断或 provider 不可用，按 Alt+Enter | 显示明确的无可用 code action/provider 状态，不静默 |
| AC-ALT-03 | context menu 的 Code Actions 项 | 与快捷键调用相同 target、诊断和 action 结果 |
| AC-ALT-04 | Ctrl/Meta、Alt 组合及 IME composing 状态 | 不误触发，三端现有快捷键不回归 |

## 4. 修复方案与决策

保持既有 action registry 和 `dispatchKeydownV2`，补充 `Alt+Enter` 的 key/code 归一化测试；若 Linux 事件 key 为空，使用 `event.code === "Enter"` 与 `altKey` 匹配。执行前通过 `resolveEditorTarget` 获取活动 leaf/view。无 action 时将 typed no-op reason 写入 status message。

无需 UI 原型或人工取舍；沿用现有 Code Actions 菜单。

## 5. 改动清单

| 文件 | 变更 |
|---|---|
| `src/components/editor/workspace/workspaceCommands.ts` | 补 Alt+Enter 事件归一化/匹配测试及必要修复 |
| `src/components/editor/workspace/workspaceActionHost.ts` | 校验组合键 dispatcher 的 editor target 与 disabled reason |
| `src/components/editor/CodeWorkspaceTab.tsx` | 仅在必要时补显式 fallback 和状态反馈 |
| 对应 `*.test.ts(x)` | 新增快捷键、无诊断、context menu 回归 |

## 6. 任务

### TASK-ALT-01 快捷键分发修复

- 职责：上述快捷键与 action host 文件。
- 依赖：无。
- 实施：先写 Linux 风格 `key="Enter"/code="Enter"/altKey=true` 失败测试；修复归一化和 target；保持 composing、tree、terminal 过滤。
- 对应 AC：AC-ALT-01..04。
- 完成条件：定向测试通过，`typecheck_scope.py` 通过，context menu 与快捷键共享同一 action owner。

## 7. 验证

| V ID | 层级 | 操作与断言 | 命令 | 状态 |
|---|---|---|---|---|
| V-ALT-01 | Vitest | synthetic key/code Alt+Enter 触发 code actions；无诊断显示 typed reason | `pnpm test -- src/components/editor/workspace/workspaceKeymapRuntime.test.ts src/components/editor/CodeWorkspaceTab.test.tsx` | 待执行 |
| V-ALT-02 | 类型 | 修改路径 scoped typecheck | `python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <changed paths>` | 待执行 |
| V-ALT-03 | Linux native | QA app +真实 JDT 诊断，Alt+Enter 菜单和 action 结果 | `python .agents/skills/qa-ui-auto/scripts/native_build.py`；`python -m qa_ui_auto run --mode native --filter <new case>` | 待执行 |

真机计划：Linux 本轮执行；Windows WebView2、macOS WKWebView 需分别复测并记录未验证范围。浏览器测试只能证明 renderer dispatcher，不能证明桌面事件链。

## 8. 风险与交付

Alt 键可能被桌面环境或输入法拦截；native case 必须记录原始 key/code 与 IME 状态。代码必须保持三端构建兼容。当前可开始 TASK-ALT-01。
