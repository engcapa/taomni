# Code Workspace B 完善轮能力矩阵（2026-09）

任务板：[Code Workspace B 分支评审完善任务板](./code-workspace-idea-parity-backlog-2026-09-b-review.md)

本矩阵由 `ED-IMPROVE-011` 从最终源码重建，覆盖本板 33 个 acceptance ID。它不累加历史
`done`，也不把 A 分支的缺口移入 B。条目只声明当前源码与当前实测证据能支撑的能力上限。

## 1. 最终源码门禁

| 项目 | 命令 | 结果 |
|---|---|---|
| 全仓构建 | `pnpm build` | exit 0（TypeScript + vite build；构建期告警为既有 chunk/动态导入提示） |
| 静态 QA 门禁 | `python -m qa_ui_auto audit --gate` | exit 0：cases 197，features 81，controls 1248，orphans 0，required 394，covered_required 376，shallow 52，无 baseline 变更 |
| 目录一致性 | `python -m qa_ui_auto gen_testid_catalog --check` | exit 0（catalog 与 feature.controls 同步） |
| 本轮执行门禁 | `python -m qa_ui_auto status --cases qa-ui-auto-tests/scopes/b-review-202609 --platform Linux --gate` | exit 0：F25.5 14/14（native 9 + browser 5），F25.1 5/5；unmet 0 |

`status` 作用域目录 `qa-ui-auto-tests/scopes/b-review-202609/` 是本板 14 个受影响用例的
快照；scope 目录内容与 `qa-ui-auto-tests/cases/` 的对应文件逐字节一致，因此报告
`case_sha256` 直接匹配。唯一 rejected report 是一条 dry-run/legacy 记录
（`run-20260911-031851-126627968`），不计入 scope。

## 2. 最终源码回归批次

最终源码指纹：`f614684c792ce99c`（app source；010 只改 catalog/feature 文档，未改产品代码）。

| 环境 | 运行 | 用例 | 结果 |
|---|---|---|---|
| native Linux | `run-20260911-070322-168820957` | AUDIT-015, IMPROVE-002, AUDIT-003, D2-02, C0-01, IMPROVE-007, C4-03, IMPROVE-008, C3-02 | 7 passed / 2 failed |
| native Linux | `run-20260911-070825-277436788` | IMPROVE-002, IMPROVE-007（失败重跑） | 2 passed / 0 failed |
| browser Linux | `run-20260911-071003-548543689` | C8-04, D2-01, C4-02, C3-01, C3-03 | 5 passed / 0 failed |

首轮两条失败为环境/时序问题，保留记录：IMPROVE-002 在 step 26 的 `Undid Rearrange Code`
断言遇到延迟状态消息；IMPROVE-007 在 step 21 遇到 WebDriver `RemoteDisconnected`。两者
在相同源码重跑均通过。

B 优势回归的额外最终源码检查：

| 用例 | 运行 | 结果 |
|---|---|---|
| `TC-IDE-AUDIT-014-rename-recovery-native` | `run-20260911-071330`（首轮失败，保留）→ `run-20260911-071810` | 重跑 1 passed；首轮失败在 recovery 段落，属 jdtls/时序抖动 |
| `TC-IDE-FOLLOW-001-file-move-recovery-native` | `run-20260911-071330`/`071926`（RemoteDisconnected）→ `run-20260911-072021` | 重跑 1 passed（类 rename 路径 + 字节双还原） |
| `TC-IDE-C0-03`（5 MiB 输入） | `run-20260911-072112`/`072502`/`072851` | 三次均在 step 39 driver `RemoteDisconnected`（ED-FOLLOW-004 已记录的同一环境抖动）；终止前所有 `native-editor-performance-*.json` 组均已写入且 p95 远低于预算（见第 7 节） |

## 3. 逐卡 acceptance 矩阵

| 卡 | Acceptance | 实现（生产链） | 测试 / 证据 | 平台 | 上限 |
|---|---|---|---|---|---|
| 001 | A1/A2/A3 | `rearrangeCleanupWorkflow.ts` 冻结 text hash/provider generation/request token，所有 await 窗口与共享 apply 边界前校验；Tab 每文件 token + `preflightMutation` | unit 49/49、mounted 1/1、typecheck 0、browser C8-04、native AUDIT-015 `run-20260910-235040` | Linux native + browser | L2：provider-backed rearrange；Cleanup 仅 unavailable |
| 002 | A1/A2/A3 | v2 recovery journal 在首次 mutation 前准备；postcondition/receipt 一致后才登记唯一 history；unknown-effect 不自动重试；`WorkspaceEditApplyTransactionSummary` 分离 effect | unit 56/56、mounted 6/6、native IMPROVE-002 `run-20260911-070825`、typecheck 0 | Linux native + mounted | L2：真实 sortMembers apply/undo + 文件系统恢复 |
| 003 | A1/A2/A3 | `validateWorkflowProviderAction` 校验完整 payload（跨文件/resource/command/disabled/range/version）；Cleanup kinds 去掉 `source.fixAll` | unit 67/67、mounted 7/7、native AUDIT-015 `run-20260911-070322`、provider 透镜 | Linux native + provider | L2：真实 `source.sortMembers`；无 cleanup provider |
| 004 | A1/A2/A3 | `codePointOffsetToUtf16Offset` 统一搜索 code-point → UTF-16；preview/freshness/导航/commit 共用 | unit 53/53、mounted 1/1、native D2-02 `run-20260911-070322`、AUDIT-003 `run-20260911-070322`、browser D2-01 | Linux native + browser | L2：真实磁盘字节 hash 断言 |
| 005 | A1/A2/A3 | 冻结 preview snapshot（scope/query/replacement/match keys/edit signature）；commit 校验选中集与 frozen replacement | unit 60/60、mounted 3/3、native AUDIT-003 + D2-02 `run-20260911-070322`、browser D2-01 | Linux native + browser | L2 |
| 006 | A1/A2/A3 | `write_workspace_bytes` 统一 intent/old/null 效果事实；temp 写失败句柄先释放再清理并保留诊断；不误删他人文件 | Rust `write_workspace_bytes` 6/6、全 lib 1346 passed、save 前端 78/78、native C0-01 `run-20260911-070322` | Linux native（解码矩阵） | L2：Linux；Windows temp 清理顺序仅代码审查 |
| 007 | A1/A2/A3 | `viewStates`（leaf→file）持久化 + CodeMirrorHost 一次性 restore/capture（限幅、去重、不覆盖新输入） | unit 83/83 + Tab 150/150、typecheck 0、native IMPROVE-007 `run-20260911-070825`、C4-03 ×3、browser C4-02 | Linux native + browser | L2；24-tab restore 有 raw 样本，无预算/前后对比 |
| 008 | A1/A2/A3 | composition origin 合并为单次 undo；取消丢弃 transient entry；blur/unmount/external 释放 ownership；chords 拒绝 composing | owner/host 74/74 + Tab 150/150、native IMPROVE-008 `run-20260911-070322`、accessibility（焦点/role/state/IME） | Linux native | L2 IME；200% zoom、屏幕阅读器未跑 |
| 009 | A1/A2/A3 | 迟到 paste/cut/plain 结果上报 `cancelled` observation 并保留 OS effect；selection-owner 校验；unknown 不称 denied | contract/host/ime 95/95 + Tab 150/150、browser C3-01/C3-03、native C3-02 `run-20260911-070322` | Linux native + browser | L2；真实 OS clipboard 权限/拒绝 |
| 010 | A1/A2/A3 | 同步 `testid-catalog.md` 并补 4 个真实 EditorGroup leaf selector；恢复 recovery/refactoring/lightbulb 目录项 | audit --gate exit 0、gen --check exit 0、逐项回链生产 selector | 静态目录（无平台差异） | 静态门禁通过；runtime 覆盖归 011 |
| 011 | A1/A2/A3 | 本矩阵 + 最终源码门禁 | build exit 0、audit exit 0、status gate exit 0、最终回归批次 | Linux；Windows/macOS unverified | 本矩阵范围，不宣称完整 parity |

## 4. 平台矩阵

| 平台 | native 实测 | 说明 |
|---|---|---|
| Linux | 本板全部 native 用例通过 | 执行环境 `:0` X11/WebKitGTK、jdtls 1.61.0、fcitx5 wbpy |
| Windows | unverified | 未在本环境执行；WebView2/路径/权限/剪贴板/IME 未验证 |
| macOS | unverified | 未在本环境执行；WKWebView/Cmd 快捷键/IME/剪贴板未验证 |

浏览器（Chromium，Linux）仅证明 renderer 合同，不替代 native。

## 5. IDEA 与 Cleanup 边界

- IDEA 2026.2.x：本环境无可用样本，未做 comparison；不声称 `idea-comparison` 或 L3，
  不以历史 `done` 相加宣称完整 parity。
- Cleanup：本机无专用 cleanup/profile provider（静态 bundle + live 探测均无 cleanup
  kind）；`source.fixAll` 不再被当作等效 Cleanup。能力上限为真实 `unavailable` 边界与
  已测的确定性事务合同，不把 test-double 当 capable provider。
- Rearrange：真实 JDT LS `source.sortMembers` 正向链路保留（discover → resolve →
  preview → apply → undo）。
- `release-evidence`：本轮未声明 release-ready；未运行 `audit --release-evidence`（无
  release manifest 需求）。

## 6. B 优势回归

以下 B 既有能力在最终源码保持：

- virtual caret 撤销后的再次输入、snippet 单次接受与 Tab/Shift-Tab、共享 undo。
- 剪贴板 2/3 segments 分配（X/Y/X）、单光标整块粘贴与一次 undo。
- 真实 sortMembers 正向链路；类 rename 的路径 + 字节双还原（ED-FOLLOW-001）。
- 替换部分提交 ledger 与真实磁盘冲突零效果。
- 5 MiB 与 24-tab 保留量/恢复路径；内存保留上限（ED-FOLLOW-004）。
- 本板新增：001/002 冻结身份与恢复账本、003 payload 边界、004 UTF-16、005 snapshot、
  006 字节事实、007 view snapshot、008 IME 单 undo、009 迟到剪贴板 effect、010 静态门禁。

## 7. 未运行与上限

- Windows/macOS native 全部列 unverified。
- 008 的 200% zoom 与屏幕阅读器未跑；其他 OS IME transport 未验证。
- 006 Windows 的 temp 清理顺序未在本环境执行。
- 007 性能为同源码样本（n=3，无匹配 baseline 的预算对比）。
- 011 的 `audit --release-evidence` 未请求。

最终源码的 5 MiB 输入性能分组（`run-20260911-072502`，每组密钥 100、warmup 24，p95 预算见
括号）：1 MiB group1 p95 26/150ms、group2 24/150ms；5 MiB group1 18/500ms、group2
18/500ms、group3 16/500ms、group4 16/500ms；warmup p95 19–31ms。所有分组均通过各自
guardrail；该运行的 `TC-IDE-C0-03` 最终状态仍为环境阻塞（step 39 WebDriver 断连），不冒充
完整 native 通过。
