# ED-PARITY-016 Structural Search 对话框、结果树与过滤器对齐（P1 设计）

- 卡片：[backlog ED-PARITY-016](backlog.md)；依赖 010、011、013。
- IDEA 参照：[实机参照 · Structural Search](references/idea-live-audit-20260928.md#structural-search)——独立对话框：模板区 `System.out.println($arg$);`、语言 Java、Count/Reference/Text/Type/Script 过滤、In Project/Module/Directory/Scope；结果 class → method → location，可导航高亮；Text=42 → 1，Text=999 → 0。
- 保留：ED-PARITY-009 的 AST 精确结果（注释/字符串/反例排除）、取消释放、编辑器字节不变、结果树与导航（009-01..06）。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| 对话框已有模板编辑器、Language=Java、变量列表、Text + Invert、Match case、In Project/Module/Current File、Find/Cancel、Esc 取消。 | `StructuralSearchDialog.tsx` |
| 结果工具窗已按 file → class → method → location 成树，支持预览/打开、键盘、折叠。 | `panels/StructuralSearchPanel.tsx` |
| 后端（tree-sitter / Lezer fixture）只接受 Count=[1,1] 与 Text；Type/Reference 返回 `unsupported-constraint`。 | `structural_search.rs:573-590`、`parity009StructuralSearch.ts:170` |
| 无 IDEA 的 Recent / Existing Templates 面板，无 “Add filter” 入口。 | 同对话框 |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-016-01 | 对话框左栏 `Templates`：Recent（最近运行的 8 个模板，会话 + localStorage）与 Existing Templates · Java（println、System.err.println、equals()、new 表达式）；点击载入模板编辑器并重置变量过滤。Find 记录 Recent。 |
| DEC-016-02 | 变量过滤区加 `Add filter` 菜单：Text（可用，选中后聚焦 Text 输入）、Count/Type/Reference/Script（禁用，显示 “Not supported by the syntax-only backend (needs a Java language server)”）。不伪造后端不支持的约束。 |
| DEC-016-03 | 不在本卡：Directory/Scope 作用域、Script 过滤、Replace 模式、预览面板、Injected code——记 different；后端扩展 Count/Type 需语言服务，留后续卡。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A1**：Templates 面板与 Add filter 与 IDEA 对照（TC-016-01 R1/R2）；AST 结果仍为 3（R3、009-01）。
- **A2**：3/1/0 结果、树、导航、空态、错误、取消由保留的 009-01/02/05 与 009-03（native）证明。
- **A3**：取消/关闭释放请求、Find/编辑器字节不变由 009-02/04/06 保留证明。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-016-01 模板面板与 Recent 存储 | `structuralSearchTemplates.ts`、`StructuralSearchDialog.tsx` |
| TASK-016-02 Add filter 菜单 | `StructuralSearchDialog.tsx` |
| TASK-016-03 测试与 evidence | `StructuralSearch.parity009.test.tsx`、`TC-IDE-PARITY-016-01-*`、`evidence/ed-parity-016-idea-comparison.md` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-016-01-structural-templates-filters-browser`（新） | browser | R1 模板载入；R2 Add filter typed unavailable；R3 结果 3 + Recent。 |
| 保留 | browser/native | 009-01/02/04/05（browser）、009-03/06（native）。 |

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + native 009-03/06。
