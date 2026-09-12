# Linux Java 编辑器输入延迟修复设计

## 1. 设计摘要与范围

- 问题类型：Linux 原生性能/响应缺陷
- 设计状态：部分可实施（需 profiling 区分 renderer、LSP 和 provider）
- 来源：Linux Tauri 手工测试打开 `/data-raw-ssd/code-src/ads/persis-g2/persis-g2-server/src/main/java/com/deepzero/ads/persis/PersisG2Application.java` 后输入延迟；Windows 体感较好。
- 推荐方案：先采集 keydown→DOM、CodeMirror update→store、LSP change/diagnostic 回包三段耗时，再针对确认的热点做节流、增量同步或诊断调度优化；不以禁用 LSP 为默认修复。

## 2. 当前实现与问题依据

| 位置 | 当前行为 | 确定性 |
|---|---|---|
| `CodeMirrorHost.tsx` update listener | 每次文档变化转换全文并向 owner/onChange 发布 | 源码事实 |
| `CodeWorkspaceTab.tsx` editor/LSP sync | 文本变化触发 store 与 LSP 同步、诊断刷新 | 源码事实 |
| JDT LSP provider | Java 文件打开后提供诊断/能力 | 手工环境事实，具体耗时待测 |
| Linux WebKitGTK | 当前环境原生 WebView | 环境事实 |

因果链尚未完全确定：输入 → CodeMirror/React 全文转换、共享文档同步或 JDT 诊断回包阻塞 → Linux 输入延迟。必须先完成分段 profiling，不能假定是单一模块。

## 3. 验收

| ID | 场景 | 结果 |
|---|---|---|
| AC-LAT-01 | Linux QA app 打开指定 Java 文件，连续输入 100 字符 | keydown→编辑器 DOM 更新 p95 ≤ 基线预算，且无明显丢字/乱序 |
| AC-LAT-02 | 同场景开启 JDT 诊断 | 输入响应不被单次诊断/全文同步阻塞；诊断最终收敛 |
| AC-LAT-03 | 大文件、中文 IME、撤销/重做 | 不丢输入，IME composition 为单逻辑事务，undo 正常 |
| AC-LAT-04 | Windows/macOS | 保持既有输入和 LSP 行为，不引入平台专属分支回归 |

性能预算需从现有 `native_editor_performance` 或同机基线确定，未测前不写死绝对阈值。

## 4. 修复方案与决策

TASK-LAT-01 先建立分段测量：保留原始样本、p50/p95、OS/WebView/JDT 版本和文件大小。若 DOM 段高，检查 CodeMirror 全文转换和 React 提交；若 LSP 段高，使用已有 change queue/idle 机制合并非必要诊断；若 provider 回包高，确保回包异步且不阻塞编辑器。任何节流必须保留最终文本、取消旧响应和 IME 边界。

这是性能修复，无 UI 原型需求；暂不需要用户决策。

## 5. 改动清单与任务

| 文件/模块 | 变更 | 任务 |
|---|---|---|
| `CodeMirrorHost.tsx`、相关 hooks | 分段 instrumentation、减少重复全文转换 | TASK-LAT-01/02 |
| `CodeWorkspaceTab.tsx`、LSP session | 合并/取消非必要诊断同步，保持最终收敛 | TASK-LAT-02 |
| `qa-ui-auto-tests` native performance case | 指定 Java fixture、真实输入与 p95 证据 | TASK-LAT-03 |

### TASK-LAT-01 诊断与基线

记录 Linux/Windows/macOS 对同一 fixture 的输入延迟样本，不改变行为；产出原始 JSON。

### TASK-LAT-02 性能热点修复

仅修改经 V-LAT-01 证明的热点；保留 LSP 最终一致性、取消旧响应、IME 和 undo 契约。

### TASK-LAT-03 三端回归

维护 native performance case、provider 诊断 case 和普通编辑器回归；负责集成前后对照。

## 6. 验证

| V ID | 层级 | 核心断言 | 命令 | 状态 |
|---|---|---|---|---|
| V-LAT-01 | performance/native | 指定文件连续输入，记录 keydown→DOM p50/p95 与 LSP 收敛 | `python .agents/skills/qa-ui-auto/scripts/native_build.py`; `python -m qa_ui_auto run --mode native --filter <performance case>` | 待执行 |
| V-LAT-02 | Vitest | 输入 burst、旧 LSP 回包、IME、undo 回归 | `pnpm test -- src/components/editor/workspace/CodeMirrorHost.test.tsx src/components/editor/CodeWorkspaceTab.test.tsx` | 待执行 |
| V-LAT-03 | typecheck | 修改路径类型检查 | `python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <changed paths>` | 待执行 |

真机：Linux 当前端必须执行真实 Tauri/WebKitGTK + JDT；Windows WebView2、macOS WKWebView 分别执行同 fixture。浏览器只能辅助定位，不能作为性能结论。

## 7. 风险与交付

不能通过关闭诊断、降低测试字符数或放宽预算掩盖延迟。若无法取得匹配基线，交付状态为“已实现但性能无对照证据”。
