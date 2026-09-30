# 领取、证据与验收

## P2：claim → update

```bash
$tb claim DB-SQL-001 --owner <owner>
$tb update DB-SQL-001 --owner <owner> --status in_progress
# 终态四选一
$tb update DB-SQL-001 --owner <owner> --status done --evidence-file <evidence.json>
$tb update DB-SQL-001 --owner <owner> --status implemented --evidence-file <evidence.json> --note "live-db 未运行：缺 Oracle fixture"
$tb update DB-SQL-001 --owner <owner> --status review_required --note "spec 要求取消后零写入，但 PG 已提交的 DDL 不可撤回"
$tb update DB-SQL-001 --owner <owner> --status blocked --note "SQL Server 容器无法拉取；恢复条件：可用镜像源"
```

- `done`：目标 AC、required evidence 和受影响保留行为全部通过，无本卡引入的回归。
- `implemented`：生产改动完成，但某个 required kind 未运行或当前失败。已确认的本卡产品回归不是“缺证据”，要继续修。
- `review_required`：与 spec 合同有实质冲突，需要 P0/P1 修订（之后 `triage --status planning`）。
- `blocked`：外部前置阻塞，保留 owner，写明恢复条件。

`implemented` / `review_required` / `done` 释放 owner，本次尝试存入 `last_attempt`。

## 证据 JSON

```json
{
  "verified_at": "2026-10-01T08:30:00Z",
  "head": "<验证所用 HEAD>",
  "checks": [
    {"kind": "unit", "command": "pnpm test src/components/database/SqlEditorPanel.test.tsx", "result": "failed", "summary": "1 failed: 光标在注释内时定界错误", "acceptance": []},
    {"kind": "unit", "command": "pnpm test src/components/database/SqlEditorPanel.test.tsx", "result": "passed", "summary": "14/14", "acceptance": ["DB-SQL-001-A1"]},
    {"kind": "live-db", "command": "cargo test --lib database::sql::tests::split_ -- --ignored (MySQL 8.4.2 容器)", "result": "passed", "summary": "6/6，含 DELIMITER 与存储过程体", "acceptance": ["DB-SQL-001-A2"]}
  ],
  "unrun": ["native: 本卡无 OS 边界"],
  "notes": ["工作区基于记录 HEAD，含本卡未提交改动"]
}
```

规则（脚本强制前三条）：checks 按时间顺序，保留失败后重跑；每个 required kind 最后一次必须 passed；passed checks 的 AC 并集覆盖全部 AC；`build` 这类门槛可以 `acceptance: []`；无法运行的层写入 `unrun`，不能写成 passed。

## 各 kind 的最低要求

| kind | 合格证据 |
|---|---|
| `code-audit` | 点名生产入口与 owner，追踪 IPC/Rust、失败/取消/迟到、恢复与观察点；只看到导出函数不算 |
| `unit` | 准确命令、结果与数量；mock 只证明其模拟边界 |
| `typecheck` | `typecheck_scope.py --path ...` 覆盖本卡全部 owned 路径，记录 owned 与范围外错误数；不为通过而缩小范围或放宽类型 |
| `build` | 全仓 `pnpm build` 等 exit 0；仅门槛/集成卡使用 |
| `rust` | 定向 `cargo test --lib <filter>` 结果；只含 Rust/IPC 真实覆盖 |
| `qa-lint` | `python -m qa_ui_auto.audit --gate` 等命令与计数；不证明行为 |
| `browser` | qa-ui-auto browser 运行的 summary/receipt：入口、结果、负路径、恢复断言；截图本身不算 |
| `native` | 打包/Tauri 运行时跨真实 OS 边界，记录平台、build、fixture、后置状态 |
| `live-db` | 真实服务端（SQL 引擎或 HBase）：引擎/HBase 与版本、fixture 来源（配置键或 CI capability，不含凭据）、连接方式（直连/SSH/代理/Thrift）、本次对象前缀、执行的语句或命令与结果/取消/事务后置状态（以另一连接或查询核对）、清理结果 |
| `performance` | 环境、数据量、预热、样本数、分位方法、预算与原始产物位置 |
| `accessibility` | 键盘、焦点、名称/角色/状态、缩放等分项观察 |
| `reference-comparison` | 客户端（dbeaver/dbvis）与版本/edition（CE、已激活 PRO、DbVisualizer Pro）/平台、同一 fixture 与动作、双侧观察与差异、接受的结论上限；HBase 需注明参照来源（Phoenix / PRO NoSQL 编辑器） |
| `document` | 文档内容对照指定 AC 与权威来源审阅 |

不合格替代：合成 PASS、手写收据、无断言截图、browser stub 冒充真实引擎或 OS 行为、手工构造的驱动响应、旧提交的证据未在当前代码重跑、为通过而删断言或放宽类型。

## P3：review

P3 独立于实现者，按 spec 逐条复核 AC、保留契约与证据身份；默认不改产品代码。

```bash
$tb review DB-SQL-001 --reviewer <reviewer> --result accepted --note "A1-A3 复核通过；Oracle 未在范围" [--evidence-file <复核证据>]
$tb review DB-SQL-001 --reviewer <reviewer> --result changes_requested --note "A2：取消后结果网格仍追加迟到批次"
```

`accepted` 只用于 `done` 卡。`changes_requested` 可用于 `done` 或 `implemented`：卡回到 `ready`，原证据/尝试/审阅移入 `history`，由 P2 重新领取。复核证据使用同一 JSON 结构，AC 只能引用本卡。

## 收尾

```bash
$tb validate
git diff --check
git status --short
```
