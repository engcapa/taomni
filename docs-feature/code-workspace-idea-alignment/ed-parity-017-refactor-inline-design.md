# ED-PARITY-017 Refactor 行内命名、Preview 与事务撤销对齐（P1 设计）

- 卡片：[backlog ED-PARITY-017](backlog.md)；依赖 011、014、015。
- IDEA 参照：[控件级复核 §5](references/idea-control-audit-20260929.md#code-insight)（Shift+F6 行内 Rename：名称加框、候选列表、`Press Alt+Shift+O to show options popup`）与 [ED-PARITY-007 参照 R2–R9](../code-workspace-idea-parity/references/ed-parity-007-reference.md)（Extract Method 直达后进入就地模板；首次 Esc 只关闭建议列表；Enter 接受后单步撤销）。IDEA 设置 `Editor › Code Editing › Refactorings › Specify refactoring options: In the editor / In modal dialogs`，默认 In the editor。
- 保留：`renameSymbolAt` 的 revision/owner 新鲜度、plan gate、preview 确认、recovery journal、单次事务 undo；ED-PARITY-007 的 Extract 直达、重入保护与 DEC-07 重试；所有写入仍走 `applyLspWorkspaceEdit`。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| Rename（Shift+F6）经 `promptAppDialog` 模态对话框取名；Extract Method 提交后经 `promptExtractName`（`TextInputDialog`）取名。两者共用 `renameSymbolAt(..., {promptName})`。 | `CodeWorkspaceTab.tsx` `renameSymbolAt`、`continueExtractNaming` |
| 多文件或资源操作的 WorkspaceEdit 在写入前弹 `RefactoringPreviewDialog`：按文件分组、可排除、冲突分级；每项只显示 `Lx:y → newText`，没有改前/改后行。 | `RefactoringPreviewDialog.tsx`、`workspaceEditPreview.ts` `requiresConfirmation` |
| 单文件编辑直接应用，一次 Ctrl+Z 撤回整笔事务（C6-04、007-01 已证明）。 | `workspaceEditApply.ts`、C6-04/007-01 |
| 浏览器 parity007 provider 的 rename 以整文档替换返回编辑，multi-file 模式只作用于 Extract resolve。 | `src/stubs/parity007Extract.ts` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-017-01 | 新增“重构选项位置”偏好（`taomni.codeWorkspace.refactorOptions.v1` = `{"mode":"editor"\|"dialog"}`，默认 `editor`，与 IDEA 默认一致），每次调用时读取。`dialog` 保留现有模态路径（Rename 对话框、Extract 命名框），现有 007/C6-04/AUDIT-014/JAVA-RENAME 用例改为显式选择 `dialog`，继续证明该选项路径。 |
| DEC-017-02 | `editor` 模式下 Rename 与 Extract 命名打开**行内命名会话**：目标名称加框（`cm-inline-rename-target`），本文件其他出现处（provider documentHighlight 可用时）加虚框；名称上方覆盖输入框（`code-workspace-inline-rename-input`，初值全选），下方候选列表（`code-workspace-inline-rename-suggestions`，provider 默认名 + 驼峰后缀候选，如 `stringArrayList` → `arrayList`、`list`）与提示 `Press Shift+F6 again to open the dialog · Alt+Shift+O to show options`。输入期间文档零修改，Enter 才提交同一 provider rename。 |
| DEC-017-03 | 键盘：↑/↓ 在候选中移动并写入输入框；Enter 提交；首次 Esc 在列表可见时只关闭列表（IDEA R6），再次 Esc 结束会话——Rename 零修改，Extract 保留 provider 默认名（已提交的提取不回滚，Ctrl+Z 单步撤回，IDEA R9）；再次 Shift+F6 以当前输入打开模态对话框；Alt+Shift+O 打开选项弹层；非法标识符在框内显示错误并保持会话。会话关闭后焦点回编辑器原 caret。 |
| DEC-017-04 | 选项弹层（`code-workspace-inline-rename-options`）：`Rename in comments and strings` 显示为不可用并给出原因（LSP rename 无此参数，provider-bounded，不伪造文本替换）；`Specify refactoring options in modal dialogs` 复选即切换 DEC-017-01 偏好；`Open Rename Dialog…  Shift+F6`。 |
| DEC-017-05 | Preview 显示真实 preimage/postimage：每个 usage 行显示改前行与改后行（`refactoring-preview-before` / `-after`），由打开的缓冲区或磁盘读取的真实文本计算；读不到时显示 typed “source unavailable”，不伪造。标题 `Refactoring Preview`，按钮 `Do Refactor` / `Cancel`（testid 不变）。行内模式的多文件编辑仍经过 Preview（安全优先；IDEA 行内多文件直接应用，记 different）。 |
| DEC-017-06 | 浏览器 fixture 的 rename 改为逐出现处的最小编辑（整词匹配），multi-file 模式在 `ExtractHelper.java` 追加一处真实编辑，用于 Preview 改前/改后与单笔撤销的浏览器证明；真实 JDT LS 路径由原生用例证明。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：Rename/Extract 的入口、行内候选、选项、Esc/Enter/Shift+F6 流程与 IDEA 对照（TC-017-01 R1–R3、TC-017-02 R1）；Safe Delete/format 入口与不可用态保持 C6-03/C8-03 证明；模态选项路径由 007/C6-04 用例（dialog 模式）继续证明。
- **A2**：跨文件修改列出全部受影响文件与真实改前/改后行；Do Refactor 后一次 Undo 恢复全部文件（TC-017-01 R4 浏览器、TC-017-03 原生 JDT LS）。
- **A3**：Esc 零修改（行文本与 dirty 不变）、非法名保持会话不写入、provider 失败保留输入（TC-017-01 R2/R3）；dirty/外部修改/late response/partial effect/recovery 由既有 C6-04、AUDIT-014、JAVA-RENAME、007-02 继续证明。

<a id="tasks"></a>
## 4. 任务

- **TASK-017-01**：`refactorOptions.ts`（读写偏好）+ `inlineRename.ts`（CM StateField 装饰 + 候选算法）+ `InlineRenamePopup.tsx`（输入/列表/提示/选项弹层）。
- **TASK-017-02**：`CodeWorkspaceTab` 增加 `promptInlineName`，`renameSymbolAt` 与 `continueExtractNaming` 在 editor 模式使用；Shift+F6 转对话框。
- **TASK-017-03**：Preview 改前/改后行（`RefactoringPreviewDialog` `lineImages`，由 `confirmWorkspaceEdit` 计算）。
- **TASK-017-04**：fixture rename 最小编辑 + multi-file；现有 dialog 路径用例加 `seed_storage` 选择 dialog；新用例、feature-list 控件、testid 目录。

<a id="cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| TC-IDE-PARITY-017-01 | browser（parity007 provider） | R1 Shift+F6 行内框/候选/提示；R2 列表 Esc→会话 Esc 零修改；R3 非法名保持会话、Shift+F6 转对话框、选项弹层；R4 multi-file Preview 改前/改后 → Do Refactor → 单次 Undo。 |
| TC-IDE-PARITY-017-02 | browser（parity007 provider） | Extract 直达后行内命名：Enter 提交新名、Esc 保留默认名、一次 Undo 撤回。 |
| TC-IDE-PARITY-017-03 | native（Linux/Windows/macOS，JDT LS） | 真实 JDT LS：类名行内 Rename → Preview 列出两个文件与改前/改后 → Do Refactor → 磁盘/缓冲区一致 → Undo 恢复。 |

<a id="verification"></a>
## 6. 验证与边界

单元：`inlineRename.test.ts`（候选、装饰映射）、`InlineRenamePopup.test.tsx`（键盘契约、选项）、`RefactoringPreviewDialog.test.tsx`（改前/改后、source unavailable）、`refactorOptions.test.ts`。IDEA 行内实时同步其他出现处、`Rename in comments/strings`、多文件行内直接应用未对齐，记 different/unavailable；候选名启发式与 IDEA 类型推导不同。
