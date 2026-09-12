# Code Workspace main 修复轮能力矩阵（2026-09）

本矩阵由 ED-REPAIR-010 在最终产品源码与 QA 运行时上重建，逐项关联本修复板 30 个验收 ID（ED-REPAIR-001..010 的 A1/A2/A3）到生产 owner、当前测试/用例、实际运行 receipt、平台、结果与能力上限。不累加历史全绿假设，九项反例均在此最终同一产品树上验证关闭与保留能力。

## 1. 最终身份与范围

| 项 | 值 |
|---|---|
| 最终产品源码提交基线 | `92e1317a400180d09536fcd9a0d2d0e505c83c9e`（+ ED-REPAIR-010 最终集成修正与文档） |
| 应用源码指纹（source_sha256） | `971bbc709cdbbbcedc507f010497b41e7bd2c6f18f363e2a4431d77e12e97b9c` |
| QA 运行时指纹（runner_sha256） | `36f8302e03f93ab25dba01027be03fd5dcf8e347e87cbf120d7fc6cbae3941c7` |
| QA 运行二进制（Linux/WebKitGTK） | `com.taomni.app.qa`（binary_sha256: `154a8f6d00b8b444616c0785368b90734b4aec57610865ee2b8c6d8149834cf3`） |
| 前端与仓库构建 | `pnpm build` exit 0（tsc -b + rolldown/vite，0 scoped errors） |
| QA testid 目录校验 | `gen_testid_catalog --check` exit 0（testid-catalog.md is up to date） |
| QA 审计门禁 | `audit --gate` exit 0（required 394→394，covered 376，shallow 52，orphans 0，0 regressions） |
| 最终修复 scope | `qa-ui-auto-tests/scopes/main-repair-202609`（18 个用例：7 browser + 11 native） |
| `status --gate` | Linux exit 0，Unmet 0，rejected 2（dry-run 报告）；F25.5 18/18 passed、F25.1 5/5 passed、F1.7 4/4 passed |

## 2. 30 个验收 ID 映射

| A ID | 生产 owner | 当前测试 / 用例 | 当前证据（commit / receipt / command） | OS / runtime | 结果 | 能力上限 |
|---|---|---|---|---|---|---|
| **001-A1** | `workspaceEditApply.classifyWorkspaceEditOperationRetry` | `workspaceEditApply.test.ts` (1207..1225)；`CodeWorkspaceTab.test.tsx` (10050..10150) | `9d96b78d` / `vitest` passed (4 mounted tests) | Linux / jsdom | passed | 模型+mounted 严格分类：buffer=performed&disk=none 为 retry-save-only，unknown 禁止重试 |
| **001-A2** | Tab `commitOpenBufferPreparedSave` + `retryOpenBufferSave` | `CodeWorkspaceTab.test.tsx` mounted ED-REPAIR-001 | `9d96b78d` / `vitest` passed | Linux / jsdom | passed | 用户确认后仅调用存储写入，取消保留 dirty 且登记 recovery，打断拒绝旧参数 |
| **001-A3** | Save failure retry contract & receipt | typecheck (`0 scoped errors`)；native `TC-IDE-C0-01` | run-20260912-152811-026173954 (25.6s)；browser `TC-IDE-C0-02` (31.7s) | Linux browser+native | passed | L2 native 真实保存失败重试与恢复 |
| **002-A1** | `replaceInFilesModel.ts` 全量原子预检 | `replaceInFilesModel.test.ts`；mounted `CodeWorkspaceTab.test.tsx` (10600..10680) | `9d96b78d` / `vitest` passed | Linux / jsdom | passed | 任何一处 open buffer 或 disk hash mismatch 立即退出，0 额外写入 |
| **002-A2** | Replace partial failure recovery ledger | mounted `CodeWorkspaceTab.test.tsx` ED-REPAIR-002-A2；native `TC-IDE-AUDIT-003` | run-20260912-153447-349361405 (30.2s) | Linux native | passed | 多文件部分失败时已写文件进 recovery ledger，未写文件保持原样，提供明确清单与单次 undo |
| **002-A3** | Replace preflight & freeze coverage | typecheck；browser `TC-IDE-D2-01` (16.3s)；native `TC-IDE-D2-02` (26.6s) | run-20260912-152718-394470543；run-20260912-153853-472619691 | Linux browser+native | passed | L2 native 真实多文件预检与冻结提交 |
| **003-A1** | `workspaceDocumentTransactionOwner.ts` freshness validation | `workspaceDocumentTransactionOwner.test.ts` (16 tests)；`CodeMirrorHost.test.tsx` | `9d96b78d` / `vitest` passed | Linux / jsdom | passed | 越界行号、越界列号、消失行或文本变化严格拒绝，禁止模糊 clamp |
| **003-A2** | Transaction rejection isolation | `workspaceDocumentTransactionOwner.test.ts`；`CodeMirrorHost.test.tsx` | `9d96b78d` / `vitest` passed | Linux / jsdom | passed | 拒绝执行零副作用，正文与选区完全保留，不污染 undo 历史 |
| **003-A3** | Split & coordinates freshness coverage | typecheck；browser `TC-IDE-C4-02` (21.0s) | run-20260912-152718-394470543 | Linux browser | passed | L2 browser 多 leaf 分割下的严格坐标与选区隔离 |
| **004-A1** | `journalRecovery.ts` 无 plan 事务副作用捕获 | `CodeWorkspaceTab.test.tsx` (9800..9900) ED-REPAIR-004 | `9d96b78d` / `vitest` passed (4 mounted tests) | Linux / jsdom | passed | 无 plan 的批量操作部分失败自动捕获 performed effects 并生成 pending recovery journal |
| **004-A2** | Recovery journal 交互与落盘入口 | `CodeWorkspaceTab.test.tsx` ED-REPAIR-004；native `TC-IDE-IMPROVE-002` | run-20260912-153928-976662419 (68.7s) | Linux native | passed | 恢复中心支持查看、撤销、确认保留；重启后从 localStorage/disk 正确加载未决 recovery entry |
| **004-A3** | Workflow & recovery coverage | typecheck；native `AUDIT-014` (50.0s)、`AUDIT-015` (44.8s)、`AUDIT-016` (42.7s)；browser `C8-04` (17.1s) | run-20260912-152811-026173954；run-20260912-152718-394470543 | Linux browser+native | passed | L2 provider JDT LS 真实交互与事务恢复 |
| **005-A1** | `replaceWorkerClient.ts` / `FindInFilesPanel.tsx` request token | `replaceInFilesModel.test.ts`；`FindInFilesPanel.test.tsx` | `ff27de56` / `vitest` passed | Linux / jsdom | passed | Replace prepare 请求携带单调 token；查询变化立即失效旧 prepare 请求 |
| **005-A2** | Obsolete prepare result cancellation | `FindInFilesPanel.test.tsx`；`ReplacePreviewDialog.test.tsx` (4 tests) | `ff27de56` / `vitest` passed | Linux / jsdom | passed | 迟到返回的旧 prepare 零副作用，不触发 preview 对话框，不覆盖新查询 |
| **005-A3** | Replace prepare cancellation verification | typecheck；browser `TC-IDE-D2-01` (16.3s)；native `TC-IDE-D2-02` (26.6s) | run-20260912-152718-394470543；run-20260912-153853-472619691 | Linux browser+native | passed | L2 快速连续输入与取消隔离 |
| **006-A1** | `replaceInFilesModel.ts::replacePreimagePathKey` POSIX 区分 | `replaceInFilesModel.test.ts` (35 tests)；`codeWorkspaceModel.root-helpers.test.ts` (11 tests) | `ab652c02` / `vitest` passed | Linux / jsdom | passed | POSIX 系统上区分 `/ws/A.java` 与 `/ws/a.java`，Windows 保留盘符/分隔符规范化 |
| **006-A2** | Preimage / expected hash / edit path 一致性 | `replaceInFilesModel.test.ts`；`FindInFilesPanel.test.tsx` | `ab652c02` / `vitest` passed | Linux / jsdom | passed | 全链条路径一致，消除大小写冲突覆盖与虚假校验失败 |
| **006-A3** | Case-preserving replace coverage | typecheck；mounted `CodeWorkspaceTab.test.tsx` ED-REPAIR-006；native `TC-IDE-D2-02` (26.6s) | run-20260912-153853-472619691 | Linux native | passed | L2 native 真实磁盘大小写不同文件并行替换与单次 undo 还原 |
| **007-A1** | `CodeMirrorHost.tsx` CompositionSession 显式生命周期 | `CodeMirrorHost.test.tsx` (70)；`workspaceDocumentTransactionOwner.test.ts` (16) | `748db9b4` / `vitest` passed | Linux / jsdom | passed | 唯一 session ID；end-pending 延迟处理 microtask flush；blur/start/unmount/切文件完全清理 |
| **007-A2** | Composition transaction coalescing & undo isolation | `workspaceDocumentTransactionOwner.test.ts`；`CodeMirrorHost.ime.test.tsx` | `748db9b4` / `vitest` passed | Linux / jsdom | passed | 取消输入零 undo，确认输入严格一次确认一次 undo，连续两次输入产生两次独立 undo |
| **007-A3** | Real fcitx5 IME verification & accessibility | typecheck；native `TC-IDE-IMPROVE-008-ime-lifecycle-native` (19.1s) | run-20260912-154106-916602415 | Linux native + fcitx5 | passed | L2 native 真实输入法 confirm/cancel、单次 undo 及 activeElement/role/multiline 焦点保持 |
| **008-A1** | `CodeMirrorHost.tsx` clipboardOwnerLost 不可逆性 | `CodeMirrorHost.test.tsx` (7 tests in ED-REPAIR-008 suite) | `92e1317a` / `vitest` passed | Linux / jsdom | passed | 移除 `!view.hasFocus`；转焦搜索框/另一 leaf/另一 workspace 单调递增 generation 且不可逆，回焦旧请求必被拒绝 |
| **008-A2** | 菜单 owner 保持与转焦取消、performed 事实保留 | `CodeMirrorHost.test.tsx`；`clipboardObservationContract.test.ts` (10 tests) | `92e1317a` / `vitest` passed | Linux / jsdom | passed | 菜单持焦合法，转出失效；失效 host 不更新 UI 但 OS 已写入 performed 事实准确记录 |
| **008-A3** | Clipboard multi-split isolation & multi-caret distribution | typecheck；browser `TC-IDE-C3-01` (28.0s)、`TC-IDE-C3-03` (25.8s)；native `TC-IDE-C3-02` (45.6s) | run-20260912-152718-394470543；run-20260912-154139-938439902 | Linux browser+native | passed | L2 native 真实 X11 权限拒绝、多光标 2 segments/3 carets 分配、单次 undo 与跨会话隔离 |
| **009-A1** | `CodeMirrorHost.tsx` textIdentity WeakMap 绑定 | `workspaceLayoutPersistence.test.ts` (14)；`CodeMirrorHost.test.tsx` (70) | `fc39fc1c` / `vitest` passed | Linux / jsdom | passed | 消除 1s 节流，快照与 immutable Text 严格同版本绑定；1s 内连续编辑切 tab 正确恢复 |
| **009-A2** | Inactive leaf 快照身份保留与 unmount 尾部落盘 | `CodeWorkspaceTab.test.tsx` ED-REPAIR-009 (3 tests)；`workspaceLayoutPersistence.test.ts` | `fc39fc1c`+本卡 / `vitest` passed | Linux / jsdom | passed | enrichViewStates 不为旧定位补签新正文 hash；unmount 立即刷新尾部快照，restore 中保护不被空状态覆盖 |
| **009-A3** | View state persistence & restore performance | typecheck；native `TC-IDE-IMPROVE-007` (8.2s)；native `TC-IDE-C4-03` (11.7s)；browser `C4-01`/`C4-02` | run-20260912-154046-724253901；run-20260912-153832-851796322 | Linux browser+native | passed | L2 native 真实重启双向滚动/折叠恢复与 24-tab active-ready (11.7s) 性能指标 |
| **010-A1** | 最终源码 build、qa-lint 与单元/挂载全回归 | `pnpm build` (exit 0)；`gen_testid_catalog --check`；`audit --gate`；312 tests passed | 本卡 / 全仓回归 | Linux | passed | 九项反例均在最终同一代码库有具区分性的负路径回归，0 依赖历史全绿假设 |
| **010-A2** | 全 30 个 AC 映射与保留能力覆盖 | 本能力矩阵与对应 evidence 记录 | 本卡 | Linux | passed | 失败重试、部分恢复、竞态隔离、三端上限及保留能力完全核实 |
| **010-A3** | 非空 scope status gate 通过与真实 receipt 绑定 | `status --cases qa-ui-auto-tests/scopes/main-repair-202609 --reports qa-ui-auto-report --platform Linux --gate` | 本卡 (exit 0, 18/18 passed) | Linux | passed | 18 个测试用例全部以最新源码指纹通过，真实 receipt/summary 完全匹配 |

## 3. 最终回归 scope 与 receipt（Linux）

`qa-ui-auto-tests/scopes/main-repair-202609` 聚合了本修复轮全部 9 张功能卡的 18 个自动化用例（7 个 browser，11 个 native），全部在最终源码和 QA 二进制上运行通过：

| 模式 | 用例 ID | 耗时 | 最终测试报告 Receipt | 覆盖特性 |
|---|---|---:|---|---|
| browser | `TC-IDE-C0-02` | 31.7s | `run-20260912-152718-394470543` | F25.5, F1.7 |
| browser | `TC-IDE-C3-01` | 28.0s | `run-20260912-152718-394470543` | F25.5 |
| browser | `TC-IDE-C3-03` | 25.8s | `run-20260912-152718-394470543` | F25.5, F1.7 |
| browser | `TC-IDE-C4-01` | 26.9s | `run-20260912-152718-394470543` | F25.5 |
| browser | `TC-IDE-C4-02` | 21.0s | `run-20260912-152718-394470543` | F25.1, F25.5 |
| browser | `TC-IDE-C8-04-rearrange-cleanup-unavailable-browser` | 17.1s | `run-20260912-152718-394470543` | F25.5 |
| browser | `TC-IDE-D2-01-replace-preview-exclude-cancel-browser` | 16.3s | `run-20260912-152718-394470543` | F25.5 |
| native | `TC-IDE-AUDIT-003-replace-conflict-ledger-native` | 30.2s | `run-20260912-153447-349361405` | F25.5 |
| native | `TC-IDE-AUDIT-014-rename-recovery-native` | 50.0s | `run-20260912-152811-026173954` | F25.5 |
| native | `TC-IDE-AUDIT-015-rearrange-sortmembers-native` | 44.8s | `run-20260912-152811-026173954` | F25.5 |
| native | `TC-IDE-AUDIT-016-cleanup-unavailable-native` | 42.7s | `run-20260912-152811-026173954` | F25.5 |
| native | `TC-IDE-C0-01` | 25.6s | `run-20260912-152811-026173954` | F25.1, F25.5, F1.7 |
| native | `TC-IDE-C3-02` | 45.6s | `run-20260912-154139-938439902` | F25.5, F1.7 |
| native | `TC-IDE-C4-03` | 11.7s | `run-20260912-153832-851796322` | F25.1, F25.5 |
| native | `TC-IDE-D2-02-replace-commit-undo-native` | 26.6s | `run-20260912-153853-472619691` | F25.5 |
| native | `TC-IDE-IMPROVE-002-workflow-recovery-native` | 68.7s | `run-20260912-153928-976662419` | F25.5 |
| native | `TC-IDE-IMPROVE-007-view-state-restore-native` | 8.2s | `run-20260912-154046-724253901` | F25.1, F25.5 |
| native | `TC-IDE-IMPROVE-008-ime-lifecycle-native` | 19.1s | `run-20260912-154106-916602415` | F25.1, F25.5 |

全部 18 个用例在 `status --cases qa-ui-auto-tests/scopes/main-repair-202609 --reports qa-ui-auto-report --platform Linux --gate` 中输出 `Unmet case/target checks: 0; rejected reports: 2`（rejected 报告为历史 dry-run 标记），门禁返回码 0。

## 4. 九项反例修复前后对比

| 卡号 | 修复前反例行为 | 修复后保证与回归断言 |
|---|---|---|
| **ED-REPAIR-001** | 保存失败（bufferEffect=performed, diskEffect=none）再次触发时重复执行缓冲区编辑，导致正文被多次应用相同变更；diskEffect=unknown 时仍允许盲目重试 | 失败分类器识别 `retry-save-only`，重试仅调用底层写入不重放编辑；unknown disk 严格阻止重试；编辑打断拒绝旧版本 |
| **ED-REPAIR-002** | 多文件 Replace 在 commit 阶段边写边验，当文件 B 发生哈希冲突时文件 A 已落盘，破坏原子性且未向用户提供清晰的恢复边界 | 提交前全量预检（open buffer + disk hash），任一冲突 0 写入中止；部分写入进入 recovery ledger，未写保持原样 |
| **ED-REPAIR-003** | 行号/列号越界时模糊 clamp 到行首/行尾执行，导致代码在错误位置静默插入；消失行强行应用 | 严格坐标与锚点 freshness 校验，越界与消失行严格抛出 mismatch，零正文/选区污染，不污染 undo |
| **ED-REPAIR-004** | 无 plan 的批量编辑在部分失败时未生成 recovery journal，导致部分写入状态丢失，重启后无法恢复 | 自动捕获 performed buffer/disk effects 生成 pending recovery entry，持久化到本地，提供还原/确认入口 |
| **ED-REPAIR-005** | Replace prepare 请求无 token 隔离，连续键入或取消后旧 Promise 返回，错误弹出旧结果 preview 对话框或覆盖新查询 | 每个 prepare 分配唯一请求 token 与查询指纹，输入变化或取消立即失效旧请求，旧结果返回零副作用 |
| **ED-REPAIR-006** | Replace 路径 key 强制 `toLowerCase()`，导致 Linux POSIX 下 `/ws/A.java` 与 `/ws/a.java` 合并为一个条目并相互覆盖哈希 | 复用 `fsPathComparisonKey`，POSIX 保留大小写区分，Windows 保留规范化，全链条路径语义统一 |
| **ED-REPAIR-007** | 输入法组合快速 end 后紧跟 blur，timer 被取消导致 finalize 遗漏，两次组合被合并为一个 undo 步数 | 显式 CompositionSession 会话跟踪与唯一 token，end-pending 机制兼容 microtask flush，一次确认一次 undo |
| **ED-REPAIR-008** | 剪贴板 `clipboardOwnerLost` 包含 `!view.hasFocus`，请求 pending 时转焦搜索框再回焦，ownerLost 变回 false 使已失效请求复活 | 移除 `!view.hasFocus`，转焦搜索框/其他 leaf/其他 workspace 单调递增 generation 且不可逆，回焦旧请求必被拒绝 |
| **ED-REPAIR-009** | 1s 节流导致编辑后快速切 tab 时定位快照带旧 hash 被拒绝；enrichViewStates 强行为 inactive leaf 补签 live buffer hash | WeakMap 绑定 immutable Text 身份消除节流；inactive leaf 快照保留原身份；unmount 立即刷新尾部快照，restore 中保护不被空状态覆盖 |

## 5. 保留能力回归清单

以下能力在修复后经同一源码验证依然完备有效：

- **LSP / Provider 合同**：标准 disabled request/resolve 明确拒绝，独立 LSP 版本传递，真实 JDT LS `source.sortMembers` 预览/单次 undo，Cleanup unavailable 诚实回退。
- **保存与恢复**：Windows 不预删旧文件的源码合同；当前端普通保存 smoke；UTF-16 与 EOL 处理；有 plan 与无 plan 事务的部分成功恢复；rename 路径与字节双还原。
- **输入法与编辑历史**：IME 最终 flush 与普通按键分组；取消输入不消耗 undo；连续两次组合产生两次独立 undo。
- **剪贴板**：denied/unknown/fallback 状态上报；多光标 2 segments/3 carets 保持 X/Y/X 分配；单 caret 完整块；成功单次 undo；外部 OS 更新不复用旧 segments。
- **视图定位与多 Leaf**：两 leaf 独立定位；同秒编辑切 tab 恢复；旧 schema 兼容与损坏数值 clamp；横纵滚动几何迟到恢复；24-tab restore active-ready (11.7s) 性能。

## 6. 平台边界与能力上限

- **当前平台**：所有 Native QA 测试与全仓构建在 Linux (x86_64, Ubuntu/glibc 2.39, WebKitGTK, fcitx5) 上真实运行通过。
- **Windows / macOS 边界**：
  - Windows 原生 WebView2、Windows 路径规范化替换、真实 Windows 剪贴板所有权在当前 Linux runner 上标记为 `unverified`，需在 Windows runner 上验证。
  - macOS WKWebView 与原生 IME/剪贴板在当前 Linux runner 上标记为 `unverified`，需在 macOS runner 上验证。
- **Cleanup 真实 Provider**：本地 JDT LS 仅支持 `source.sortMembers` 和 `source.organizeImports`，不支持专用 `source.cleanup`；系统按合同返回 unavailable，不以 `source.fixAll` 冒充 Cleanup。
- **性能与压力测试上限**：
  - 24-tab restore (`TC-IDE-C4-03`) 在原生 Linux 上 11.7s 达成 active-ready 并平稳完成 background drain。
  - 5 MiB 文本保存 (`TC-IDE-C0-03` step 39): 在 WebKitGTK 下，5 MiB 大文档进行 JS EOL 归一化与 IPC 序列化时主线程占用超过 30 秒，触发 WebDriver HTTP client 的 30 秒超时（`RemoteDisconnected`），此项行为已按规范记录为已知上限/环境不稳定项，不以删减用例或伪造全绿掩盖。
- **无障碍（Accessibility）**：
  - 已通过自动化验证：ARIA live region 状态通知（保存、剪贴板）、键盘焦点恢复、`.cm-content` 上的 `role="textbox"` 与 `aria-multiline="true"`。
  - 屏幕阅读器真实音频发声与 200% 页面缩放属于手工原生项，自动化流水线未执行，如实保留为未运行。
