---
name: db-client-task
description: Taomni 数据库会话（database 与 hbase-shell TabKind）DBeaver（CE/PRO）与 DbVisualizer 双参照对齐任务板的唯一操作入口：P0 用 add 产卡、P1 用 ready 转可开发、P2 领取并交付一张 DB-* 卡、P3 用 review 验收。只处理任务板与单卡交付；统筹、盘点和阶段选择见 db-client-parity。
---

# DB 会话对齐任务

任务板固定为 `docs-feature/db-client-parity/backlog.md`（用户另给路径时以用户为准），每条命令显式带 `--doc`。卡片 metadata 只能由 `scripts/task_board.py` 写入，不手工编辑 `<!-- db-task ... -->` 行。

```bash
board=docs-feature/db-client-parity/backlog.md
tb="python .agents/skills/db-client-task/scripts/task_board.py --doc $board"
$tb validate
$tb list --plannable        # P1 候选
$tb list --claimable        # P2 候选
$tb show DB-SQL-001
```

## 按阶段使用

| 阶段 | 命令 | 必读 |
|---|---|---|
| P0 产卡 | `add` / `triage` | [board-format.md](references/board-format.md) |
| P1 规划 | 写完 spec 与 `test-cases` 后 `ready` | [board-format.md](references/board-format.md) |
| P2 开发 | `claim` → `update` | [lifecycle.md](references/lifecycle.md) |
| P3 验收 | `review` | [lifecycle.md](references/lifecycle.md) |

脚本强制：ID 形如 `DB-<域>-NNN`；spec 锚点为小写 ID；`ready` 及之后的卡必须有本卡 AC、required_evidence 和 `<a id="<id>-test-cases"></a>`；`done` 需要结构化证据覆盖全部 AC 且每个 required kind 最后一次结果为 passed；一个 owner 同时只能有一张活动卡；依赖未 done 不可领取。校验通过只说明 metadata 合法，不证明产品行为。

## P2 交付一张卡

1. 读 `AGENTS.md`、backlog 第 1–3 节、本卡与依赖卡、本卡 spec（含 `test-cases`）、引用的参考包（DBeaver / DbVisualizer）与参照决策，以及 [fixtures](../db-client-parity/references/fixtures.md) 中本卡需要的服务。
2. 记录 HEAD 与 `git status --short`，`claim` 后 `update --status in_progress`。owner 用调用方给定值，否则 `<agent>-<UTC 时间>-<短 HEAD>`。
3. 重新核对生产链路：入口（按钮/菜单/快捷键/SchemaTree 或 HBaseSchemaTree 右键）→ 组件/store → `src/lib/ipc.ts` → `db_*` / HBase 命令 → `src-tauri/src/database/<engine>` 或 `src-tauri/src/hbase/{native,thrift}` → 结果/事件/Channel → UI 观察点，并覆盖失败、取消（`db_cancel`）、迟到结果、断线重连、事务未提交等状态。
4. 差距已不存在：只补证据，不重写。需实质改变 spec 合同：`review_required` 并写明冲突。外部前置缺失（数据库 fixture、驱动、平台）：`blocked` 并写恢复条件。
5. 实现本卡最小完整结果。当前 UI 可以按 spec 重构；已保存 session、query workspace、history、saved queries、vault 凭据引用和 SSH/代理转发等数据契约必须保持或按 spec 迁移。本卡造成的相邻退化由本卡修复。
6. 验证按 spec 选择：迭代用定向 vitest / Rust 过滤测试和 browser；稳定后一次 scoped typecheck（`python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <owned>...`），需要真实引擎或 OS 边界时集中跑 `live-db` / `native`。UI 行为按 `qa-ui-auto` 开发期用例合同落 `qa-ui-auto-tests/cases/TC-*.testcase.yaml` 并登记 `policy.yaml`。
7. 按 [lifecycle.md](references/lifecycle.md) 写证据 JSON，`update` 到真实终态，再 `validate`、`git diff --check`、`git status --short`。

## 边界

- 一个 agent 一张卡；不顺手修无关问题，发现的新差距写入报告交 P0。
- browser 模式下 `db_connect`/`db_execute` 走 `src/stubs/tauri-core.ts` 的合成数据，只能证明 UI 流程；方言、类型映射、事务、取消和性能需要 `live-db`。
- 引擎与 edition 显式处理：卡的 `scope` 列出引擎/HBase 后端和 `pro`（若为 PRO 功能）；未覆盖的记为未验证，不能以 MySQL 结果代表其他引擎，不能以 CE 观察代表 PRO。
- fixture 只按 fixtures.md 使用：本机 MySQL 读 gitignored 的 qa-ui-auto 配置，HBase 用 `HBASE_LIVE_TEST=1` + `HBASE_ZK`；共享库只建并清理本次前缀对象；凭据不进证据或提交。
- 不把 failed / cancelled / stale / 部分提交 / 未知服务端效果合并为成功或泛化错误。
- 修改数据的操作（表格编辑保存、DDL、导入）必须有预览或确认、失败回滚语义和可观察的最终数据库状态。
- 仅在用户要求时提交：只 stage 本卡文件，提交信息含卡 ID，如 `feat(database): DB-SQL-001 execute current statement`。

## 汇报

卡 ID、基线与最终 HEAD/工作区、改动文件、生产效果链、实际命令与结果（含失败后重跑）、未运行层及原因、终态，以及本卡能力上限（引擎/平台/参照客户端版本）。不声称超出证据的参照对齐。
