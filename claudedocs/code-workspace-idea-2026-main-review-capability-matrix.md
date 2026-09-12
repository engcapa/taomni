# Code Workspace main 完善轮能力矩阵（2026-09）

本矩阵由 ED-MAIN-010 在最终源码上重建，逐项关联本板 30 个验收 ID（ED-MAIN-001..010 的
A1/A2/A3）到生产 owner、当前测试/用例、实际运行 receipt、平台、结果与能力上限。不累加
历史 done，引用旧提交的旧证据只作来历记录。

## 1. 最终身份与范围

| 项 | 值 |
|---|---|
| 最终数据源 | `b499c871638fcd65199b44e9c41e265b38adc95b`（+ 本卡文档/scope 提交） |
| 应用源码指纹（status identity） | `ed0faa7df1d3a0f7430f51321594b1125aad69069e13650de8b955b0ffdc8bbb` |
| QA 运行时 | 隔离 `com.taomni.app.qa`（Linux/WebKitGTK），最终 binary `ec247104a293944cda60c77554eff96021fd6038896dbd98da4c323bc06851dc` |
| runner | `70118d90372ac4a79750e4133676b831625448cf4020c79404aba437ac75a941` |
| 前端/仓库构建 | `pnpm build` exit 0（tsc -b + vite，只有既有 chunk/ineffective-import 警告） |
| QA 门禁 | `gen_testid_catalog --check` exit 0；`audit --gate` exit 0（required 394→394，covered 376，shallow 52，orphans 0） |
| 最终回归 scope | `qa-ui-auto-tests/scopes/main-review-202609`（19 个 YAML，见第 3 节） |
| `status --gate` | Linux exit 0，Unmet 0，rejected 0；F25.5 19/19、F25.1 5/5、F1.7 4/4 |

## 2. 30 个验收 ID 映射

| A ID | 生产 owner | 当前测试 / 用例 | 当前证据（commit / receipt） | OS / runtime | 结果 | 上限 |
|---|---|---|---|---|---|---|
| 001-A1 | `workspaceEditApply.applyTextDocumentEdit` buffer/disk effect | `workspaceEditApply.test.ts`（31）；mounted `CodeWorkspaceTab` ED-MAIN-001 | `3074482b`；mounted baseline-red→green | Linux/browser jsdom | passed | L2 模型+mounted |
| 001-A2 | Tab `applyLspWorkspaceEditNow` journal finalize + recovery | mounted ED-MAIN-001；native `IMPROVE-002`（run-20260912-075206） | `3074482b` | Linux native | passed | L2 native recovery |
| 001-A3 | Tab transaction summary + workflow adapter | native/provider `AUDIT-015`（075111） | `3074482b` | Linux native + JDT LS | passed | L2 provider |
| 002-A1 | `readWorkflowActionDisabled` + request-stage selection | `rearrangeCleanupWorkflow.test.ts`（74）；mounted disabled | `acefdaa5`；baseline-red | Linux/browser | passed | 模型/ mounted（无 provider disabled 复现） |
| 002-A2 | `executeRearrangeTransaction`/`executeCleanupTransaction` | workflow tests；native/provider `AUDIT-015`（075111） | `acefdaa5` | Linux native | passed | L2 provider |
| 002-A3 | validator + Tab adapters | typecheck；browser `C8-04`（080424） | `acefdaa5` | Linux browser+native | passed | L2 |
| 003-A1 | `validateWorkflowProviderAction` version gate | workflow tests（79）；plan version 断言 | `895a75c3`；baseline-red | Linux jsdom | passed | L2 模型 |
| 003-A2 | `documentVersion` 贯穿 plan/applier | workflow tests；applier version 测试 | `895a75c3` | Linux | passed | L2 模型 |
| 003-A3 | Tab `lspDocumentVersion` resolve adapter | typecheck；mounted；native/provider `AUDIT-015`（075111） | `895a75c3` | Linux native | passed | L2 provider |
| 004-A1 | `verifyReplaceMatchFreshness` EOL-aware | `replaceInFilesModel.test.ts`（23）；browser `D2-01`（080424） | `d2d746ba`；baseline-red | Linux browser | passed | L2 |
| 004-A2 | `codePointOffsetToUtf16OffsetChecked` | replace tests；panel catch | `d2d746ba` | Linux jsdom | passed | L2 模型 |
| 004-A3 | replace 提交链 | typecheck；native `D2-02`/`AUDIT-003`（080756/080529） | `d2d746ba` | Linux native | passed | L2 native 字节/undo |
| 005-A1 | `ReplaceFilePreimage` + `expectedDiskHashes` readDisk guard | `FindInFilesPanel.test.tsx`（28）；model expected-hash | `4ccc6f23`；baseline-red | Linux mounted | passed | post-preview 外部写为 mounted/model，非 native fixture |
| 005-A2 | `validateReplacePreviewSelection` source edit check | replace model tests（25）；panel | `4ccc6f23` | Linux jsdom | passed | L2 模型 |
| 005-A3 | Tab commit + applier | typecheck；native `D2-02`/`AUDIT-003`（080756/080529） | `4ccc6f23` | Linux native | passed | L2 native |
| 006-A1 | `CodeMirrorHost` compositionEndGuard + owner coalescing | `CodeMirrorHost.test.tsx` 迟到 flush；owner tests | `32e90e2e`；baseline-red | Linux jsdom + fcitx5 | passed | L2 |
| 006-A2 | `workspaceDocumentTransactionOwner` lifecycle | Host/owner/ime 69；native `IMPROVE-008`（074822） | `32e90e2e` | Linux native fcitx5 wbpy | passed | L2 |
| 006-A3 | 收尾顺序 + 焦点/role/state | typecheck；native `IMPROVE-008`（074822） | `32e90e2e` | Linux native | passed | 200% zoom/屏幕阅读器未运行 |
| 007-A1 | clipboard owner generation/token；`clipboardOwnerLost` | Host ED-MAIN-007（3）；suite 82；native `C3-02`（074931） | `b499c871`；baseline-red | Linux native + jsdom | passed | L2 |
| 007-A2 | frozen observation endpoint；菜单 owner | Host ED-MAIN-007；native `C3-02`（074931） | `b499c871` | Linux native | passed | L2 |
| 007-A3 | 多光标/矩形/undo + 观察 seam | typecheck；browser `C3-01`/`C3-03`（080424）；native `C3-02` | `b499c871` | Linux browser+native | passed | L2 |
| 008-A1 | `workspace.rs::replace_file` 原子替换 | `cargo test --lib workspace::tests`（72）；`#[cfg(windows)]` 回归 | `b629e983` | Linux rust；Windows OS 触发未验证 | passed | Linux 合同；Windows unverified |
| 008-A2 | writer intent/old/written + temp cleanup | rust tests；native `C0-01`（075323） | `b629e983` | Linux native | passed | L2 native |
| 008-A3 | 三端 cfg 审查 + native 保存 | rust + native `C0-01`（075323） | `b629e983` | Linux native | passed | win/mac unverified |
| 009-A1 | `captureEditorViewState`/`applyPersistedEditorViewState` identity | Host/persistence（66）；native `IMPROVE-007`（075036） | `4bb63bce`+`aa77dc46` | Linux native + jsdom | passed | L2 |
| 009-A2 | `documentTextIdentity` + `enrichViewStatesWithIdentity` | Host/persistence（66） | `aa77dc46`；baseline-red | Linux jsdom | passed | L2 |
| 009-A3 | 恢复/横纵滚动 + 性能 | typecheck；native `IMPROVE-007`；perf `C0-03`（075947）/`C4-03`（075407） baseline+candidate | `aa77dc46` | Linux native perf | passed | C0-03 环境 driver 抖动已记录 |
| 010-A1 | 最终源码 build/qa-lint | `pnpm build`、`gen_testid_catalog --check`、`audit --gate` | 本卡 | Linux | passed | 无 |
| 010-A2 | 全 30 A ID 映射 + 最终回归 | 本矩阵；19 用例 `status --gate` exit 0 | 本卡 | Linux | passed | win/mac/IDEA 未验证 |
| 010-A3 | 明确 scope 的非空 status gate | `qa-ui-auto-tests/scopes/main-review-202609` | 本卡 | Linux | passed | 手工项另有证据 |

## 3. 最终回归 scope 与 receipt（Linux）

| 模式 | 用例 | receipt |
|---|---|---|
| native | IMPROVE-002 | run-20260912-075206-411369459 |
| native | AUDIT-015 | run-20260912-075111-305040233 |
| native | AUDIT-016 | run-20260912-080705-724410160 |
| native | AUDIT-014 | run-20260912-080605-991541657 |
| native | D2-02 | run-20260912-080756-814666055 |
| native | AUDIT-003 | run-20260912-080529-354355128 |
| native | C0-01 | run-20260912-075323-523243126 |
| native | C0-03 | run-20260912-075947-053193824 |
| native | C3-02 | run-20260912-074931-461748099 |
| native | IMPROVE-007 | run-20260912-075036-612487712 |
| native | IMPROVE-008 | run-20260912-074822-195754167 |
| native | C4-03 | run-20260912-075407-912486552 |
| browser | C0-02 / C3-01 / C3-03 / C4-01 / C4-02 / C8-04 / D2-01 | run-20260912-080424-678590493 |

失败与环境抖动（C0-03、C3-02、IMPROVE-002、AUDIT-015、C0-01 的 `RemoteDisconnected` 或
JDT LS 冷导入超时）已按时间顺序保留在 `qa-ui-auto-report/`，最终以通过的当前源码 receipt 作为
证据；未把失败移出范围或写成全绿。

## 4. 保留能力回归

以下能力在本轮改动后仍由最终源码与 receipt 覆盖：

- 实时 readonly ref、预览后 identity guard、typed unknown/recovery（001/003）；
- 故障注入与 temp cleanup 诊断、intent/old/written hash（008 rust tests）；
- 严格 provider kind/payload/disabled 校验与真实 `source.sortMembers`（002/003，AUDIT-015）；
- virtual caret undo 后再次输入、snippet 单次接受、X/Y/X 分配（006/007，无关测试套件）；
- 类 rename 路径与字节双还原（AUDIT-014）；
- provider 进程隔离与真实 JDT LS（AUDIT-015/C3-02/C0-01）；
- 5 MiB 输入与 24-tab 恢复保留量（C0-03/C4-03，raw artifacts）。

## 5. 平台与能力上限

- 只在 Linux/WebKitGTK 执行；Windows（WebView2/替换旧文件/IME/剪贴板）与 macOS（WKWebView/IME）
  为 unverified，不声称三端通过。
- Cleanup：本机 JDT LS 无专用 cleanup/`source.cleanup` provider，保持 unavailable；
  `source.fixAll` 不作为 Cleanup，不声称正向 Cleanup。
- IDEA 2026.2.x 未安装，未做 idea-comparison；不声称 L3 或对齐百分比。
- 屏幕阅读器与 IME 200% zoom 未运行，单独列出；不并入已通过项。
- ED-MAIN-009 性能：baseline（pre-009 `f0ede1e0`）与 candidate（`defc3d1d`）均通过 C0-03/C4-03
  守卫；初次实现的大文档逐次 hash 回归已由 throttle+persist-exact 修复；残余 p95 差异与系统整体
  p50 漂移一致，按环境噪声记录，未重置预算。
- ED-MAIN-008 的缺陷位于 `cfg(windows)` 分支；Linux 只证明可移植替换/cleanup 合同与原子 rename
  不变式，Windows OS 触发未复测。

## 6. 未运行 / 缺口

- Windows 和 macOS 的原生验证（三端要求；当前只执行 Linux）。
- IDEA 2026.2.x 对比（本机无样例）。
- 屏幕阅读器观察；IME 流程 200% zoom。
- Cleanup 专用 provider 的正向执行（本机不存在）。
- C0-03 与 C3-02 的 WebDriver/WebKit `RemoteDisconnected` 稳定复现（已如实记录，非隐藏）。
