# 任务板与规格格式

## 任务板骨架（P0 首次创建）

`docs-feature/db-client-parity/backlog.md` 只保存选板规则、规格索引、交付门槛和卡片。卡片正文写一段目标/范围与链接，实现合同放在 spec。

```markdown
# DB 会话双参照对齐任务板

## 1. 选板规则
本板是 DB-* 卡唯一状态来源。P0 add 产卡（planning）；P1 规划后 ready；P2 claim 开发；P3 review。

## 2. 规格索引
[能力矩阵](capability-matrix.md) / [待细化目标](task-planning.md) / [参考包](references/)

## 3. 交付门槛
目标 DBeaver（CE/PRO）与 DbVisualizer 版本、默认引擎集合、fixture 数据库、当前平台与 build 门槛归属（如 DB-GATE-001）。

## 4. 任务卡
```

卡片由 `add` 追加到文件末尾，因此“任务卡”保持为最后一节。

## ID 与域

`DB-<域>-NNN`，域使用 [db-client-parity 的能力域](../../db-client-parity/references/domains.md)：`CONN` `NAV` `SQL` `EXEC` `GRID` `EDIT` `OBJ` `ER` `TX` `XFER` `CMP` `TASK` `PREF` `HB` `GATE`。编号在域内递增，不复用。`scope` 写引擎（`mysql` `postgres` …）、HBase 后端（`hbase-native` `hbase-thrift`），PRO 独有功能再加 `pro`。

## P0：add

```bash
$tb add DB-SQL-001 --title "执行光标处语句与整脚本" --priority high --size M \
  --spec docs-feature/db-client-parity/task-planning.md#db-sql-001 \
  --source REQ-03,DBV-SQL-02 --scope mysql,postgres \
  --finding "SqlEditorPanel 只有整段执行；无按光标语句定界" \
  --summary "范围：一个编辑器 tab 内的语句定界与执行入口；不含 explain 与参数绑定。"
```

先在 `task-planning.md` 写 `<a id="db-sql-001"></a>` 小节：来源、用户结果、已知事实（生产入口/文件）、非目标。`priority` 为 `high|medium|low`（阶段名 P0–P3 不用于优先级）。`size` 超过 L 就拆卡。`triage --status deferred|planning --note` 用于搁置或把 `review_required` 退回规划。

## P1：spec 小节模板

P1 把目标细化到 `docs-feature/db-client-parity/<slug>-plan.md`（修复类可放 `docs-issue/`），然后 `ready --spec <新路径>#<id>`。

```markdown
<a id="db-sql-001"></a>
## DB-SQL-001 <标题>

- 来源 / 引擎范围 / 参照决策：REQ、矩阵 ID；引擎；`主参照: dbeaver|dbvis|merge|taomni` 与理由；参考包路径与版本
- 当前事实：生产入口 → 组件/store → IPC → Rust 模块；已确认缺陷与待归因风险分开
- 目标：前置、入口（鼠标/菜单/快捷键）、操作、可见状态、结果、失败/取消/迟到/断线/恢复
- UI/交互：布局、密度、焦点、快捷键与主参照的差异（已观测 / Taomni 适配 / 用户接受）
- 保留契约：受影响的既有行为与数据契约，各有可观察断言与改前依据
- 实施：文件/符号职责、共享消费者、依赖卡
- 验收：`A1` …（本卡自己的 AC，区分新增 / 有意改变 / 保留）
- 验证选择：每个 AC 的最便宜充分层级；required_evidence 与 metadata 一致；其他平台计划

<a id="db-sql-001-test-cases"></a>
### 测试用例
| V | AC | 前置/fixture | 操作 | 预期 | 层级/模式 | 路径/ID（现有或 P2 新增） |
```

用例要求：遵循 qa-ui-auto 的 [design-to-implementation-handoff](../../qa-ui-auto/references/authoring.md#design-to-implementation-handoff) 与 [coverage dimensions](../../qa-ui-auto/references/authoring.md#coverage-dimensions-and-mode-selection)。每个受影响入口、快捷键、状态转换和保留行为都有一例；browser 优先，`live-db`/`native` 行写明 browser 无法证明的断言。尚未存在的 case、fixture、verb 标“P2 新增”。

```bash
$tb ready DB-SQL-001 --spec docs-feature/db-client-parity/sql-execute-plan.md#db-sql-001 \
  --acceptance A1,A2,A3 --evidence code-audit,unit,typecheck,browser,live-db
```

## required_evidence 选择

| 卡类型 | 常见组合 |
|---|---|
| 纯 UI/交互（stub 可复现） | `unit` `typecheck` `browser` + 有参照时 `reference-comparison` |
| 依赖真实引擎语义（定界、类型、事务、取消、元数据、HBase scan/put） | 上述 + `rust` 和/或 `live-db` |
| fixture 设施卡（新增 CI capability / 容器 / 就绪探针） | `code-audit` `rust` 或 `unit` + 一次真实 `live-db` 探针 |
| 触及 OS 边界（文件导出/导入、剪贴板、窗口、打包） | 加 `native` |
| 大结果集、分页、流式 | 加 `performance` |
| 构建/集成门槛卡（DB-GATE-*） | `build` `qa-lint` |
| 纯文档/参照卡 | `document` |

不为凑齐而堆叠层级；一次运行可覆盖多个 kind 与 AC。
