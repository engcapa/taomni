# ED-PARITY-020 代码洞察弹层与无 provider 态对齐（P1 设计）

- 卡片：[backlog ED-PARITY-020](backlog.md)；依赖 011、013；就绪模型复用 015 的 `languageServiceReadiness`。
- IDEA 参照：[控件级复核 §5](references/idea-control-audit-20260929.md#code-insight)（`idea-09/10/11/12/13/36`，`taomni-09/11/12`），DEC-ALIGN-09。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| provider 不可用时补全回退 `completeAnyWord`，在 `obj.` 成员位置冒充成员补全。 | `lspCompletion.ts` identity 缺失 / fetch 失败 / provider inactive 三处 |
| Quick Doc 无结果或不可用只写状态栏 “No documentation available”。 | `CodeWorkspaceTab.tsx` `openQuickDocumentation` |
| Alt+Enter 在服务未就绪时只写状态栏 “Code actions require the language server…”；无动作时 “No … provided”。 | `requestCodeActions` / `showCodeActionsMenu` |
| Parameter Info 通过 nonce 进入 CodeMirrorHost，服务不可用时无任何反馈。 | `workspace.parameterInfo` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-020-01 | 新增 caret 处小弹层 `CodeInsightNotice`（`code-workspace-code-insight-notice`，`role=status`）：位于 caret 行下方，视口底部不足时翻到上方；不抢焦点；下一次按键关闭（Esc 被消费，不再触发编辑器 Esc 语义），外部点击/滚轮关闭；不可用原因带 `Configure…`（打开 Language Servers 设置）。 |
| DEC-020-02 | Quick Doc：服务 ready 但无内容 → “No documentation found.”；服务非 ready → “Documentation unavailable: <原因>”；失败 → provider 消息。状态栏消息保留。 |
| DEC-020-03 | Parameter Info、Alt+Enter：服务非 ready 时直接弹 notice（“Parameter info unavailable: …”/“Context actions unavailable: …”），不发请求；Alt+Enter 请求失败 / 无上下文 / 无动作也弹 notice。 |
| DEC-020-04 | 补全：provider 不可用（无 identity、fetch 失败、inactive）且位于成员访问（`.` 前缀）时返回空并经 `onProviderUnavailable` 弹 notice “Member completion unavailable: …”；非成员位置保留单词补全，`Alt+/` 不变。 |
| DEC-020-05 | 本卡不改补全列表行结构/底栏、补全内文档、Intention 预览与错误 tooltip 结构（需要真实 provider 的双侧对照），记录为 different/unverified，留给 019 收口或后续卡。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**（本卡范围内）：notice 位置在 caret 下方且不遮挡 caret 行；provider 就绪时既有补全/参数信息/intention 行为不变（C2-01、PARITY-005-05、AUDIT-008 保留用例）。补全行结构与底栏逐项对照记 different。
- **A2**：provider 不可用时，`calculator.le` 不出现单词列表；Ctrl+Q、Ctrl+P、Alt+Enter 各自弹出含原因的 notice；Esc 关闭后焦点仍在 `.cm-content`、caret 不变。
- **A3**：notice 从不抢焦点、不接受按键；迟到结果沿用既有 identity/revision 丢弃语义（无改动）。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-020-01 `CodeInsightNotice` + caret 定位 | `workspace/CodeInsightNotice.tsx` |
| TASK-020-02 Quick Doc / Parameter Info / Alt+Enter 接入 | `CodeWorkspaceTab.tsx` |
| TASK-020-03 成员位置补全不回退单词 | `lspCompletion.ts`（+ test）、`CodeMirrorHost.tsx`、`EditorGroup.tsx` |
| TASK-020-04 用例与 evidence | `TC-IDE-PARITY-020-01-*`、`evidence/ed-parity-020-idea-comparison.md` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-020-01-code-insight-unavailable-browser`（新） | browser | A2/A3：browser 无 JDT LS 的 `.java`：键入 `calculator.le` 无补全列表且出现 notice；Ctrl+Q、Ctrl+P、Alt+Enter 分别弹 notice 且文案含 “unavailable”；每次 Esc 后 notice 消失、焦点在 `.cm-content`、caret 位置不变；Configure 打开 Language Servers 设置。 |
| 保留 | native | C2-01、PARITY-005-05、AUDIT-008（provider 就绪路径不回归）。 |

单测：`lspCompletion.test.ts`（成员位置不回退单词 + hook）。

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + native 保留用例。补全列表外观、Intention 预览、错误 tooltip 结构需真实 provider 的 IDEA 对照，列为后续。
