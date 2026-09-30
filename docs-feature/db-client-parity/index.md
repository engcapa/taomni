# DB 会话双参照对齐入口

目标：Taomni 数据库会话（`database` TabKind，后续含 `hbase-shell`）以 DBeaver CE 26.2.1 与 DbVisualizer Pro 25.1.3 为参照，按场景取二者之长。开发状态只看 [backlog.md](backlog.md)；本页只放链接和派生摘要。

| 材料 | 作用 |
|---|---|
| [capability-matrix.md](capability-matrix.md) | 场景 `DBV-*` 的功能 / UI / 交互结论与主参照 |
| [backlog.md](backlog.md) | `DB-*` 卡片唯一状态来源 |
| [task-planning.md](task-planning.md) | P0 目标小节（P1 细化前） |
| [batch1-plan.md](batch1-plan.md) | 第一批卡的 P1 设计与测试用例 |
| [references/DBVIS-001-pro-25.1.3.md](references/DBVIS-001-pro-25.1.3.md) | DbVisualizer 参照 |
| [references/DBR-001-ce-26.2.1.md](references/DBR-001-ce-26.2.1.md) | DBeaver 参照与取长初判 |

P0 首次运行：2026-09-30，分支 `feat/db-client-parity`，基线 `fa04812b`。用户决定：ER 图不支持；DBeaver PRO 暂不采集；排序以 DbVisualizer 为准；Query Builder 与图表不做；所有引擎都要支持，但采集只用 MariaDB。
