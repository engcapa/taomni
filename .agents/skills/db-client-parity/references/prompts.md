# 可复制提示词

规则都在 skill 里，提示词只给阶段、权限和可选输入。复制对应代码块即可；`[可选]` 行可删除。

## P0 评估与产卡

```text
使用 $db-client-parity 执行 P0：评估 Taomni 数据库会话（database TabKind）与 DBeaver、DbVisualizer 的差距并按取长规则选主参照，
含 hbase-shell 会话和 DBeaver PRO 独有功能，建立或增量更新 docs-feature/db-client-parity/ 的能力矩阵，
并用 $db-client-task 的 add 产出 DB-* 卡（缺 fixture 时先产 DB-GATE 设施卡）。
[可选] 范围：<域或场景，如 SQL/EXEC/GRID/HB>；参照：<DBeaver CE 26.2.1 / PRO 26.2.0 / DbVisualizer Pro 25.1.3>；引擎：<mysql,postgres>
权限：读代码、pnpm dev 浏览器观察、DBeaver 与 DbVisualizer 采样、写上述文档目录和任务板。不改产品代码/测试，不 claim。
交付：矩阵变化、新卡列表（ID/优先级/依赖）、待决问题。
```

## P1 规划一张卡

```text
使用 $db-client-parity 执行 P1：从 docs-feature/db-client-parity/backlog.md 规划一张 planning 卡到 ready。
[可选] 卡 ID：<DB-XXX-NNN>
权限：读代码、DBeaver 与 DbVisualizer 采样、写本卡 spec/参考包/P2 交接、task_board ready/triage。
不改产品代码或可执行测试，不运行产品测试或构建，不 claim，不启动 P2。
缺少会改变设计的信息时直接问我，同时继续其他工作。
交付：板路径::ID、spec 与 test-cases 锚点、参考包、handoff-p2 文件和可复制的 P2 提示词。
```

## P2 开发一张卡

```text
使用 $db-client-task 执行 P2：从 docs-feature/db-client-parity/backlog.md 领取并交付一张 DB-* 卡。
[可选] 卡 ID / 交接：<DB-XXX-NNN> / docs-feature/db-client-parity/handoff-p2-<id>.md
[可选] 可用环境：<平台；fixture（默认本机 qa-ui-auto 配置的 mysql 块 / HBASE_ZK）；是否可跑 pnpm tauri dev>
权限：产品代码、测试、QA case、本卡 spec 必要修订、task_board claim/update。允许按 spec 重构 UI。
[可选] 完成后提交一个 commit（仅本卡文件）。
交付：终态、生产效果链、实际命令与结果、未运行层、剩余差距。
```

## P3 独立验收

```text
使用 $db-client-parity 执行 P3：独立验收 docs-feature/db-client-parity/backlog.md 中的 <DB-XXX-NNN>。
权限：只读代码、运行验证、双参照对照、task_board review。不改产品代码。
交付：accepted / changes_requested / 证据阻塞，逐 AC 判定、复跑记录、交回 P0 的新差距。
```

## 单 agent 连续交付（可选）

```text
使用 $db-client-parity 对 <DB-XXX-NNN 或场景> 连续执行 P1→P2：规划到 ready 后直接领取开发并自验。
权限：同 P1 + P2。需要独立结论时另开会话做 P3。
```
