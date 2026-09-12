# Alt+Enter 开发模式失效修复（2026-09-12）

## 复现与根因

用户确认通过 `pnpm tauri dev` 手工测试，Linux 与 Windows 都出现 Alt+Enter 无反应。此前仅通过打包生产前端的原生 QA 用例，不足以判定开发模式可用；不能将后来观察到的已安装应用进程当作用户测试了旧版本的证据。

`src/main.tsx` 使用 React StrictMode。开发模式首次挂载会经历 effect setup → cleanup → setup。原 `CodeWorkspaceTab` 在 render 阶段创建 `IntentionSession`，只在 cleanup 中调用永久 `dispose()`，第二次 setup 没有创建新的会话。快捷键已成功匹配，provider 也能返回，但随后 `IntentionSession.open()` 抛出 `IntentionSession was disposed`，菜单无法显示。

同时，`workspace.codeActions.run` 用 `void` 丢弃打开菜单的 Promise，因此异常未进入 `WorkspaceActionHost` 的错误反馈，用户看到的是无反应。上述行为是共享 React 生命周期问题，不是 Linux 专属键码问题。

## 修改

- effect setup 创建会话，cleanup 取消当前请求、销毁该 setup 所有的实例并清空引用；workspace 实例改变时同样重建。
- 快捷键 action 返回 `openCodeActionsAtCursor` 的 Promise，让 action host 统一捕获并显示异步失败。
- 保留 StrictMode、原快捷键映射、IME guard、provider 请求、应用修复与撤销的原有路径。
- 快捷键测试改为真实 StrictMode 挂载，并从 `.cm-content` 发出普通 `Enter` 和 `Unidentified + code=Enter` 两种事件。旧代码明确复现 disposed 异常，修复后两种事件均显示候选菜单且不插入换行。
- QA 构建记录将 `NODE_ENV` 纳入输入标识，避免相同源码和 Rust debug profile 下复用错误的 React production/development 前端；附加构建身份测试。

## 验证与边界

- 失败日志：`/tmp/taomni-alt-strict-baseline.log`。普通 Enter 在 StrictMode 下触发未处理的 disposed 异常，菜单断言失败。首版参数化测试另一项复用 workspace id，还受上一项延迟清理影响；已使用独立 workspace id 修正测试隔离。
- 定向测试：`/tmp/taomni-alt-strict-fixed.log`，2 passed。
- 类型检查：修改范围内及范围外均 0 错误。
- QA 构建身份测试：4 passed。
- 完整相关回归：4 个文件、211 项通过，包括 CodeWorkspaceTab、IntentionSession、快捷键运行时及 action controller。日志 `/tmp/taomni-alt-regression.log`。
- 原生开发前端首轮已打开真实 JDT 菜单并完成 import，但短暂的 `Applied code action` 状态被 JDT `Searching...` 覆盖，导致第 24 步状态断言失败。控制台无异常，失败截图保留了已插入 import 的编辑器。后续本地用例改为在同一步直接断言预期磁盘 SHA-256，保留后面的内容、保存、一次撤销及第二入口验证；没有删除结果断言或增加预算。
- 原生重跑：Linux，`com.taomni.app.qa`，React development + StrictMode，1 passed / 0 failed / 0 skipped，源码稳定。真实 JDT 的 Alt+Enter 菜单、导入应用、保存、一次撤销恢复原始 SHA-256，以及灯泡入口的同候选应用/撤销均通过。原始按键记录为 `key=Enter, code=Enter, altKey=true, defaultPrevented=true`。

原生验证采用独立的 `com.taomni.app.qa`，使用 `NODE_ENV=development` 构建 React 开发前端，使 StrictMode 的重复 effect 生命周期实际执行；后端仍为真实 Tauri/JDT。它证明开发前端生命周期下的原生行为，不声称执行了 Vite HMR 的启动/热替换流程。用例读取现有开发观测标记，拒绝生产前端；样例工程与应用数据均隔离。

原生构建命令：`NODE_ENV=development python .agents/skills/qa-ui-auto/scripts/native_build.py`。

本轮不以 Windows 风格事件的单元测试冒充 Windows 原生测试。Windows/WebView2 与 macOS/WKWebView 尚待原生回归。Linux 输入性能继续维持“未完全解决”，本次不将 Alt+Enter 的生命周期修复计为性能修复。

## 证据位置

- 基线失败、修复后单测、211 项回归和构建日志副本：`qa-ui-auto-report/alt-strict-dev/taomni-alt-*.log`。
- 原生首次状态断言失败：`qa-ui-auto-report/alt-strict-dev/native/run-20260912-211252-074410765/`。
- 原生完整通过：`qa-ui-auto-report/alt-strict-dev/native-retry/run-20260912-211555-714221753/`，保留 `summary.json`、`runner_receipt.json`、按键记录、菜单截图和撤销结果截图。
- 本地开发前端验证用例：`qa-ui-auto-report/alt-strict-dev/cases/TC-IDE-ALT-DEV-LOCAL.testcase.yaml`，沿用原 TC-IDE-AUDIT-008 的真实 JDT 与文件哈希断言，并检查开发观测标记。
