---
name: db-client-parity
description: 统筹 Taomni 数据库会话（database TabKind 的 MySQL/PostgreSQL/Oracle/SQL Server/ClickHouse/Presto 等 SQL 引擎，以及 hbase-shell）向 DBeaver（CE + PRO）与 DbVisualizer（Pro）取长对齐功能、UI 与交互的 P0 评估产卡、P1 规划、P2 开发、P3 验收。允许重构现有界面；任务板操作交给 db-client-task。创建或维护 skill 本身时不启动产品盘点或开发。
---

# DB 会话双参照对齐（DBeaver + DbVisualizer）

以当前生产能力为基础，参照两款客户端并取二者之长：DBeaver（Community 为通用基线，PRO 独有功能纳入）和 DbVisualizer Pro（本机 25.1.3）。每个场景按 [ui-alignment.md](references/ui-alignment.md#取长规则) 选定主参照并记录理由，不做两者的机械并集。具体版本由 P0 写入任务板第 3 节。范围包括 SQL 会话和 HBase 会话，边界见 [domains.md](references/domains.md#范围)。当前布局、组件、菜单、快捷键和流程都可以重构；已保存 session、query workspace、history、saved queries、vault 凭据和 SSH/代理转发等数据契约必须保留或按 spec 迁移。三端（Windows/macOS/Linux）兼容，中文交接。

## 固定位置

| 材料 | 路径 |
|---|---|
| 入口与派生摘要 | `docs-feature/db-client-parity/index.md` |
| 能力矩阵（场景 `DBV-<域>-NN`） | `docs-feature/db-client-parity/capability-matrix.md` |
| 唯一任务板（卡 `DB-<域>-NNN`） | `docs-feature/db-client-parity/backlog.md` |
| P0 目标小节 / P1 设计 | `task-planning.md#<id>` / `<slug>-plan.md#<id>` |
| 参考包（`DBR-*` DBeaver / `DBVIS-*` DbVisualizer）/ 入库证据摘要 | `references/` / `evidence/` |
| P2 交接 | `handoff-p2-<id小写>.md` |

任务板是开发状态唯一来源；index 和矩阵只存链接与结论，不另记状态。Code Workspace 的 `ED-*` 板与脚本不适用于本工作流。

## 阶段

| 阶段 | 做什么 | 不做什么 |
|---|---|---|
| P0 评估产卡 | 建立/增量更新矩阵，`add` 产卡，维护优先级与依赖 | 不改产品代码，不 claim |
| P1 规划 | 选一张 `planning` 卡，补参照、spec、AC、`test-cases`，`ready` 并写 P2 交接 | 不改产品代码或可执行测试，不跑产品测试 |
| P2 开发自验 | 用 `db-client-task` 领取并交付一张卡；中断/失败恢复也在 P2 | 不做无关修复，不越出本卡 |
| P3 独立验收 | 另一会话逐 AC 复核并 `review` | 不改产品代码 |

循环：`P0 → P1 → P2 → P3 → P0 增量`。用户授权时同一 agent 可连续 P1→P2。每个 agent 只执行收到的阶段，不自行启动其他 agent。

各阶段的权限、步骤和输出见 [stages.md](references/stages.md)；可复制提示词见 [prompts.md](references/prompts.md)。能力域与代码定位见 [domains.md](references/domains.md)。真实数据库 fixture、HBase 现状与两款客户端的安装/启动见 [fixtures.md](references/fixtures.md)。已有参照（同一 MariaDB fixture、同一组场景）：`docs-feature/db-client-parity/references/DBVIS-001-pro-25.1.3.md`、`DBR-001-ce-26.2.1.md`（含双侧对照与取长初判）。

## 共通规则

- 先读 `AGENTS.md`，记录分支、HEAD、工作区改动；沿用会话中已明确的卡、参照客户端版本、引擎和 UI 决定。
- 场景驱动：前置、入口、操作、可见状态、结果、失败/取消/迟到/断线/事务恢复。区分已满足、待验证、行为缺陷、UI/交互差异、缺失能力、不适用。
- 沿生产链核对事实：UI 入口 → `src/components/database/` 与 store → `src/lib/ipc.ts` → `db_*` / HBase 命令 → `src-tauri/src/database/` 或 `src-tauri/src/hbase/`。只看到导出函数或 stub 不算。
- 证据分层：browser（`pnpm dev` 使用 `src/stubs/tauri-core.ts` 合成数据）只证明 UI 流程；引擎语义、事务、取消、类型映射需 `live-db`（按 fixtures.md 连真实 MySQL/HBase 等）；文件/剪贴板/窗口/打包需 `native`。未运行不算通过，一次运行可覆盖多个 AC。
- 引擎差异显式记录；某引擎或 HBase 后端未实测即为未验证，不用 MySQL 结论代表其他引擎。
- 参照身份显式记录：客户端（dbeaver / dbvis）+ edition + 版本。不用一款的观察代表另一款，不用 CE 观察代表 PRO。许可证/试用激活由用户完成。
- 用户正在使用的客户端实例（含未保存标签和真实连接）：DbVisualizer 常驻实例已获授权可做交互实测，但只在新开标签里操作（见 fixtures.md）。其他未授权实例只做不抢焦点的只读采集。
- 外网下载（驱动、镜像、依赖）按用户提供的本机代理执行；内网地址与凭据不写入入库文档。
- 修改数据的操作必须有预览或确认、失败语义和以独立查询核对的最终状态。
- 回归保护遵循 [regression-protection](../qa-ui-auto/references/regression-protection.md)：列出本卡有意改变的行为与受影响但须保持的行为（含 AI 入口、Query Library、多标签工作区），后者有可观察断言。
- 验证选择遵循 [efficient-verification](../qa-ui-auto/references/efficient-verification.md)；UI 用例遵循 qa-ui-auto 的 [开发期用例合同](../qa-ui-auto/SKILL.md#development-time-case-contract)。

## 协作 skill

| 需要 | 使用 |
|---|---|
| DBeaver / DbVisualizer 实操参照、安装文件与源码依据 | [reference-capture.md](references/reference-capture.md) |
| UI/交互目标与原型 | [ui-alignment.md](references/ui-alignment.md)，新增能力/改版用 `feature-design` |
| 已证实缺陷的修复设计 | `issue-design` |
| 任务板命令、单卡交付、证据、验收 | `db-client-task` |
| 用例编写、运行、证据解读 | `qa-ui-auto` |

## 收尾

报告阶段、卡 ID 或范围、结果、UI 差异、实际测试与构建次数、平台与前端模式、未运行层和剩余缺口。仅要求维护 skill 时，停留在 skill 文件，不预填任何真实任务或能力状态。
