# 阶段合同

`$tb` 指 `python .agents/skills/db-client-task/scripts/task_board.py --doc docs-feature/db-client-parity/backlog.md`。每个阶段开始记录分支、HEAD、`git status --short`，结束运行 `$tb validate` 和 `git diff --check`。

## P0 评估与产卡

- 权限：读源码/文档、运行 `pnpm dev` 浏览器观察、DBeaver 与 DbVisualizer 采样、写 `docs-feature/db-client-parity/` 文档、`add`/`triage`。不改产品代码或测试，不 claim。
- 首次：建立 `index.md`、`capability-matrix.md`、`backlog.md`（骨架见 [board-format](../../db-client-task/references/board-format.md)）和 `task-planning.md`，在 backlog 第 3 节写定目标 DBeaver CE/PRO 与 DbVisualizer 版本、默认引擎集合、fixture 方案（按 [fixtures](fixtures.md)）和 build 门槛卡。
- 已有参照先复用：`references/DBVIS-001-pro-25.1.3.md` 与 `references/DBR-001-ce-26.2.1.md`，两者覆盖同一组 MariaDB 场景，DBR-001 末尾有取长初判。缺 DBeaver 入口目录时，用安装文件（`plugins/*/plugin.xml`）补齐。
- HBase 与 PRO：先实测确定 HBase 的参照来源（Phoenix / PRO NoSQL 编辑器 / Taomni 适配），逐项判定 PRO 功能是否适用；缺 HBase 或其他引擎 fixture 时先产 `DB-GATE-*` 设施卡。
- 增量：只重判受影响场景；复用已有矩阵 ID 与参考包；不重开 done。
- 矩阵：按 [domains](domains.md) 列出稳定场景 ID `DBV-<域>-NN`，每项标 `ref`（已观测来源与主参照，见取长规则）和引擎/HBase 后端范围，分别给功能 / UI / 交互结论（`已对齐` `差异` `缺失` `未验证` `不适用`）、Taomni 生产入口、DBeaver 参考、证据及当前性。没有逐场景分母不给百分比。
- 产卡：每张卡一个可演示用户结果，写 `task-planning.md#<id>` 目标小节后 `add`。优先级依据用户影响与依赖：连接/执行/结果集主链优先。fixture 数据库或 QA 设施缺失时，先产一张设施卡并作为依赖。
- 输出：新增/调整卡列表、矩阵变化、待决问题。

## P1 规划到 ready

- 权限：读源码/文档、DBeaver 与 DbVisualizer 采样、写本卡 spec/参考/交接、`ready`/`triage`。不改产品代码或可执行测试，不运行产品测试或构建，不 claim。
- 选卡：用户给 ID 时用该卡；否则 `$tb list --plannable --json` 取第一张依赖可推进、无人在改的卡，立即在聊天报告 `板路径::ID`。之后不换卡。
- 工作：按 [ui-alignment](ui-alignment.md) 与 [reference-capture](reference-capture.md) 复用或补采参照；沿生产链核对事实；用 `feature-design`（新增/改版）或 `issue-design`（已证实缺陷）写 spec；按 board-format 模板写 AC、保留契约和完整 `test-cases`。
- 缺少会改变结论的信息（参照客户端版本、引擎、产品取舍、主参照选择）时向用户提具体问题，同时继续不依赖它的工作；未回答则保持 `planning`，在 spec 写明缺口。
- 就绪：`$tb ready <id> --spec ... --acceptance ... --evidence ...`，生成 `handoff-p2-<id小写>.md`：板路径与 ID、spec/test-cases 锚点、参考包、owner 文件范围、保留断言、最小验证选择、所需 fixture（配置键/capability，不含凭据）、HEAD。
- 过大时收窄到可交付首包，其余交回 P0 产卡，不静默删除验收。

## P2 开发并自验

- 权限：产品代码、测试、QA case、本卡 spec 的必要修订、`claim`/`update`。提交/推送仅在用户要求时。
- 按 [db-client-task](../../db-client-task/SKILL.md) 交付一张卡。中断或失败后的恢复也在 P2：重新读卡的 `last_attempt`/`note`/`history`，从变化处继续，不重跑仍有效的结果。
- 开发中迭代用定向测试与 browser；稳定后集中一次 scoped typecheck 和所需 `live-db`/`native`。
- 输出：终态、证据 JSON 路径、未运行层、剩余差距。

## P3 独立验收

- 权限：只读代码、运行验证、双参照对照、`review`。不修改产品代码；发现问题写入 `changes_requested` 的 note。
- 不与实现者同一 agent 会话。以 spec 为准逐条复核 AC 与保留契约：生产链是否真实、证据身份是否匹配当前 HEAD、引擎/平台范围是否超出证据、UI 与参考包差异是否被接受。
- 必要时复跑关键 case 或 `live-db`；不重复已有且身份匹配的通过结果。
- 结论：`accepted` / `changes_requested`（回到 ready）/ 证据阻塞（在报告中说明，不改状态）。
- 输出：结论、逐 AC 判定、复跑记录、交回 P0 的新差距。
