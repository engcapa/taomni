# ED-PARITY-014 项目树、Search Everywhere 与导航入口对齐（P1 设计）

- 卡片：[backlog ED-PARITY-014](backlog.md)；依赖 010、013。
- IDEA 参照：[控件级复核 §4](references/idea-control-audit-20260929.md#navigation)（`idea-02`、Recent Files、File Structure、Find in Files）。
- 保留：树选择不误开、preview policy（011 DEC-011-04）、Back 恢复、012 的焦点归还。

<a id="current-facts"></a>
## 1. 现状核对

| 事实 | 位置 |
|---|---|
| All 分类把文件、符号、动作合并后统一模糊排序；散字母匹配让 `total` 命中 “Move to Line Start”。 | `SearchEverywhere.tsx` `filterItems` |
| 底栏常显 `Stale · generation · N/M providers · incomplete · N symbols`。 | 同上 footer |
| Recent Files 单列；重复 `Ctrl+E` 只推进选中项；无 Show edited only 开关（数据层已有 `openRecentFiles({changedOnly})`）。 | `RecentFilesPopup.tsx`、`useWorkspaceNavigation.ts:385` |
| File Structure 无 provider 时只显示原因、0 symbols；Lezer Java 语法已随 CodeMirror 打包。 | `CodeWorkspaceTab.tsx` `openStructurePopup` |

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 |
|---|---|
| DEC-014-01 | All：各贡献者分别排序后按 符号 → 文件 → 动作 拼接；动作需查询的每个词出现在标题或关键字中（不再散字母匹配）。空查询保持原列表。Text 命中不进 All（需后端，记 different）。 |
| DEC-014-02 | 底栏改为 IDEA 结构：选中项路径（`search-everywhere-selected-path`）+ `Open In Right Split Ctrl+Enter`；provider/索引诊断收进状态点的 `title`/`aria-label`（保留 testid）。`QuickPickOverlay.footer` 支持按选中项渲染。 |
| DEC-014-03 | Recent Files 为双列切换器：左列工具窗（Project Alt+1、Problems Alt+6、Structure Alt+7、Terminal Alt+F12、Find、Run、Debug、TODO）+ Recent Locations，点击激活并关闭；右列文件；头部 `Show edited only`（复选框，`Ctrl+E` 再按切换，替代原“推进选中项”）；底栏为选中文件完整路径。 |
| DEC-014-04 | File Structure 标题为文件名；无 provider（无 descriptor、服务未运行、请求失败）且为 `.java` 时，用 Lezer 语法树给出 syntax-only 大纲（类型、字段、构造器、方法、枚举常量，不进入方法体），标注 `syntax only`。 |
| DEC-014-05 | 不在本卡：Go to File 外框宽度/遮罩、scope 下拉与预览开关、Find in Files 浮动弹层与可编辑预览、项目树头部与 External Libraries、File Structure 的 Inherited/Lambdas 开关——逐项记 different，留后续卡。 |

<a id="acceptance"></a>
## 3. 验收细化

- **A2/A4（本卡）**：`total` 查询下 All 首项为相关文件/符号、无无关动作、底栏无诊断文字；Recent Files 双列 + 完整路径 + Show edited only（Ctrl+E 切换、点击切换）；File Structure 无 provider 时 syntax-only 大纲。
- **A1/A3**：树与 preview、Back、dirty 保留由既有用例（011-02、NAV-01、C6-05、FINDFOCUS-01）回归证明；本卡不改树。

<a id="tasks"></a>
## 4. 任务

| TASK | 文件 |
|---|---|
| TASK-014-01 All 排序与动作过滤、底栏 | `SearchEverywhere.tsx`、`QuickPickOverlay.tsx`（+ tests） |
| TASK-014-02 Recent Files 双列与 edited-only | `RecentFilesPopup.tsx`、`WorkspacePopupsHost.tsx`、`CodeWorkspaceTab.tsx`（+ test） |
| TASK-014-03 syntax-only 大纲 | `javaSyntaxOutline.ts`（+ test）、`StructurePopup.tsx`、`CodeWorkspaceTab.tsx` |
| TASK-014-04 用例与 evidence | `TC-IDE-PARITY-014-01-*`、`evidence/ed-parity-014-idea-comparison.md` |

<a id="test-cases"></a>
## 5. 测试用例

| 用例 | 模式 | 覆盖 |
|---|---|---|
| `TC-IDE-PARITY-014-01-navigation-popups-browser`（新） | browser | R1 File Structure syntax-only；R2 All 查询 `total`；R3 Recent Files 双列/edited-only/工具窗激活。 |
| 保留 | browser/native | 011-02、012-01、013-01/02、NAV-01、C6-05。 |

单测：`SearchEverywhere.test.tsx`（动作匹配、All 排序、底栏路径）、`RecentFilesPopup.test.tsx`、`javaSyntaxOutline.test.ts`。

<a id="verification"></a>
## 6. 验证与边界

本地单测 + browser；CI 三端 browser + 保留 native。provider 就绪下的符号/文本命中排序需 native JDT LS 与 IDEA 双侧对照，记 unverified。
