# Code Workspace B 分支评审完善规格（2026-09）

权威任务板：[独立 B 评审完善任务板](../code-workspace-idea-parity-backlog-2026-09-b-review.md)。基线 `c6bc315c7d6450d3e8f304a357bb50080f3f98a5`，审查日期 2026-09-10。新卡均为设计与计划，本文不记录实现完成证据。

## 共用执行与证据合同

- 每卡先审查当前 caller 与基线差异；已确认问题保留 failing regression，待补强边界先实测，已满足时直接证明而不重复改写。
- 遵守 [共享合同](./shared-contracts.md)，平台、IDEA、Cleanup 和 build owner 以本轮任务板第 3 节为准。所有 acceptance 只引用自己的完整 ID。
- TypeScript 路径以 `src/components/editor/workspace/` 为默认前缀；Tab 指 `src/components/editor/CodeWorkspaceTab.tsx`。每卡同名测试及实际修改的 adapter 类型都要进入 scoped typecheck；不缩 scope 避开自己造成的错误。
- focused 使用现有 `pnpm exec vitest run <owned tests> --maxWorkers=1`；typecheck 使用现有 `typecheck_scope.py --path <全部 owned paths>`；尖括号是执行时需填写的参数，不是已运行的命令。Rust 实际变更追加 focused Cargo 证据。
- YAML/covers/controls/fixture/只读观察接口由对应行为卡持有，实施前使用 qa-ui-auto 技能。文中“拟新增”文件/用例现在尚未创建，不可提前填 execution pass；复用用例不能只截图而无断言。
- native 必须使用隔离的 `com.taomni.app.qa` 和 fixture。当前运行平台满足本轮门槛，Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView 分别记录实测或未验证。文件卡三端分别测试权限/路径/编码；UI 卡三端分别测试对应 WebView/OS 行为。不能由 Chromium 推断原生。
- 模型延迟/错误注入只证明被模拟的合同，真实 provider 和 OS 侧证据分别采集。A1/A2 的失败场景不能由无关 happy-path 通过代替；每个 required kind 的最后检查应通过，且覆盖全部 A ID。
- A 分支 `e7ac0575` 是参考而非正确性权威：保留 B 已有能力，不假定直接 cherry-pick 能满足本轮合同。没有同平台同条件 raw baseline/candidate 不声称性能改善。
- 证据目录、构建产物和日志保持 ignored；本轮编写仅创建 backlog/spec，未实现产品变更、collector、YAML 或能力矩阵。

## 卡片索引与交接

| 卡 | 边界 | 前置卡 |
|---|---|---|
| 001 | await/preview/首次 mutation 前身份保护 | 无 |
| 002 | postcondition、effect、history、恢复一致 | 001 |
| 003 | 完整 provider payload 与 kind/profile 边界 | 002 |
| 004 | 搜索坐标到 UTF-16 的统一映射 | 无 |
| 005 | 替换 scope、preimages、selected edit 冻结 | 004 |
| 006 | 原生保存失败字节事实和临时文件 | 无 |
| 007 | 每 leaf/file view snapshot | 无 |
| 008 | IME 共享历史与 lifecycle | 007 |
| 009 | 剪贴板迟到取消及系统效果 | 008 |
| 010 | 静态 QA 目录修复 | 无 |
| 011 | 最终源码门禁、回归及矩阵 | 001..010 |

<a id="ed-improve-001"></a>
## ED-IMPROVE-001 Rearrange／Cleanup 异步身份与预览后零提交保护

依赖：无（历史卡仅作参考，不跨板设依赖）。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与目标

`rearrangeCleanupWorkflow.ts` 的 `executeRearrangeTransaction`／`executeCleanupTransaction` 在 provider resolve 后用 live text 重建 preimage，且在预览 await 之前做 freshness 校验。生产 `CodeWorkspaceTab.tsx::runRearrangeExecute/runCleanupExecute` 未把完整冻结身份传到 apply 前。评审模型探针：`ba → ab` 计划在预览期间遇到正文变成 `XY` 和 provider generation 增加，仍提交 `ab` 并返回成功。这是已确认缺陷，不是 IDEA 比较差异。

### 职责与实施合同

Owner：上述两个 execute 函数、两处 Tab handler；必要时扩充已有 `workspaceEditApply.ts::preflightMutation`，只修改本卡 preflight 部分。测试归属同名 workflow、Tab、workspaceEditApply 测试。请求前先完成必要同步，固定 workspace instance、file key/URI/path、文本/hash、语义身份、provider generation 和 request token；document revision 与 LSP version 分别记录，禁止混用。

request/resolve 返回后和 preview 确认后都检查；真正首次 mutation 前通过共享 apply 边界最后校验。文档变化不能重新锚定旧 edits；same-text revision bump 只有在身份与已同步 provider 文档版本均得到证实时才允许，不可一律移除 version gate。关闭文件、切 workspace、启动新请求须使旧请求失效；能取消 transport 则传递 signal，不能取消也必须拒绝迟到提交。任何 effect 前的 stale/cancel/conflict 为零写入、零 history；effect 后失败由 002 的合同接管。本卡不扩展 Cleanup 能力或重写 semantic engine。

### 验收与验证

- **ED-IMPROVE-001-A1：** 生产入口的 request、resolve、preview 三个 await 窗口分别改变正文、workspace、provider 和文件身份，全部拒绝旧计划；首次 mutation 前再次校验，same-text 合法同步不误杀真实 sortMembers。
- **ED-IMPROVE-001-A2：** 取消、双击重入、文件关闭和只读切换各有可见 typed 状态，旧请求不抢焦点、不写入、不登记 history；正常重排仍一次 undo 恢复。
- **ED-IMPROVE-001-A3：** focused/mounted、scoped typecheck、browser、当前 native/provider 通过；冻结身份和 actual effect 能回链同一次请求。

Fixture：模型使用 `ba/ab/XY` 精确复现；mounted 使用延迟 request/resolve/confirm 的确定性 fixture，断言真实 commit 调用和正文。真实 provider 复用 `TC-IDE-AUDIT-015-rearrange-sortmembers-native.testcase.yaml` 的 SortMembers.java，补预览期间独立修改文件再确认的真实拒绝场景；Cleanup 复用 C8-04 unavailable。A1/A2 由 workflow+Tab 回归和 native 字节断言证明，A3 由命令/receipt 证明。浏览器正向模型只证明 renderer 合同，provider 必须来自真实 JDT LS。

<a id="ed-improve-002"></a>
## ED-IMPROVE-002 工作流 postcondition 与 history／恢复效果统一

依赖：ED-IMPROVE-001。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与目标

两处 Tab execute handler 以 `recordHistory: true` 调用 `applyLspWorkspaceEdit`；workflow 得到 postText 后才验证 expected hash，失败统一返回 `committed:false` 并提示 “Undo was not registered”。代码顺序与效果轴相矛盾，不能以失败文案充当恢复入口。

### 职责与实施合同

Owner：`rearrangeCleanupWorkflow.ts` 的 execute result/postcondition，Tab 两处工作流 apply/history adapter；复用 `codeActionProviderAdapter.ts::CanonicalCodeActionService.applyPlan`、`workspaceEditHistory.ts`、`workspaceEditApply.ts`，必要时复用既有 refactor recovery，不建立第二套 competing history。这些模块若实际修改，其同名测试均归本卡。依赖 001 的冻结/最后校验合同，不改其语义。

明确分离 execution status 与 effect：none、performed/partial、unknown。首次 mutation 前获得可恢复快照／所需 journal；成功历史仅在独立 postcondition 与 receipt 一致后登记一次。post mismatch、读取失败、写入确认未知必须返回 recovery-required/unknown-effect，列出已影响文件及可用恢复操作；零效果分支不留成功 history。已回滚也记录曾发生的效果与恢复结论。重复恢复幂等，第三方变化不得覆盖，持久化失败发生在 effect 前时必须拒绝。不得把失败恢复伪装成一次成功 undo，也不得损坏 B 的 ED-FOLLOW-001 文件移动逆操作。

### 验收与验证

- **ED-IMPROVE-002-A1：** 从 mounted Rearrange 和 Cleanup 支持分支注入 post mismatch／post-read failure／unknown acknowledgement，结果准确，未登记成功 committed/history；正常结果只登记一个事务，单次 undo/redo 对应整个操作。
- **ED-IMPROVE-002-A2：** 已发生效果有真实 UI 恢复入口，快照/journal 准备失败零写入；重启后 pending 可发现，恢复经独立回读，第三方冲突不覆盖，重复恢复不重复写入。
- **ED-IMPROVE-002-A3：** workflow、adapter、history、Tab 回归与 typecheck 通过；当前 native 的真实 sortMembers apply/undo 和恢复磁盘后置条件通过，provider 版本及能力边界明确。

复用 SortMembers.java 正常流、`TC-IDE-AUDIT-014-rename-recovery-native.testcase.yaml` 恢复基础设施；本卡拟新增 `TC-IDE-IMPROVE-002-workflow-recovery-native.testcase.yaml`，由本卡持有 YAML、fixture 与只读观察接口。确定性 fault injection 只证明失败合同，必须与真实 provider 正常流及 native filesystem restore 分开记账。A1 以 mounted 精确 history 次数为主，A2 以 native restart/字节为主，A3 汇总对应层；没有真实 Cleanup provider 不声称正向修复已证。

<a id="ed-improve-003"></a>
## ED-IMPROVE-003 专用 provider action 完整载荷与能力边界校验

依赖：ED-IMPROVE-002。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与目标

`runRearrangeExecute/runCleanupExecute::resolveAction` 从 provider 的 `documentEdits` 中过滤当前文件并 flatten edits，未整体验证被丢弃的其他文档、resource operations、命令和 disabled 状态；`CLEANUP_ACTION_KINDS` 将 `source.fixAll` 作为等效 Cleanup。目标是保持真实发现能力，同时拒绝不符合当前文件专用操作的载荷；这不意味着所有未覆盖 payload 已经有真实 provider 复现。

### 职责与实施合同

Owner：`rearrangeCleanupWorkflow.ts` kinds 与 payload validator、两处 Tab resolve adapter、必要的 `codeActionProviderAdapter.ts` 和 `src/lib/editor/lsp.ts` 类型/取消接口；同名测试与 JDT LS rearrange fixture contract。依赖 002，保留其唯一事务 owner。

先校验完整 WorkspaceEdit，再交付 immutable plan：URI/path 一致且仅当前文件，documentEdits 与 operations 不矛盾，无 create/rename/delete、无遗漏的跨文件 edits；验证 range/版本、disabled、resolve null/malformed、实际 edit+command 副作用。未支持 command-only/额外 command 时明确拒绝，不可默默丢弃或部分执行。保持 `source.sortMembers` 的 live discovery，不恢复 advertised-summary 前置阻断。Cleanup 仅接受有明确专用 kind/profile 合同的操作；generic fixAll 缺等效证明即 unavailable，不凭标题推断。no-change 必须可见且零 history；不得把 malformed 归并成健康空结果。

### 验收与验证

- **ED-IMPROVE-003-A1：** 跨文件、resource operation、URI/path 矛盾、edit+command、disabled、异常 range、resolve null/malformed 的 mounted 用例全体零提交，原始失败类别及原因可见。
- **ED-IMPROVE-003-A2：** 真实 sortMembers 继续 discover→resolve→preview→apply→undo；仅广告缺席不能禁用；普通 formatting/imports/fixAll 不被重标为等效 Cleanup，空变更无成功计数。
- **ED-IMPROVE-003-A3：** focused/Tab/provider contract/typecheck、browser unavailable 与当前 native/provider 通过；支持 fixture 与真实 provider 证据分别标注，不提高 Cleanup 能力上限。

模型覆盖两个 Java 文件同时返回 edit、同文件 edit 搭配 rename operation，以及 command 搭配 text edit。复用 C8-04 与 AUDIT-015；A1 由 production adapter mounted tests，A2 由真实 JDT LS 与 native 文本/undo，A3 由 receipts 证明。不得用“filtered 后本文件能成功”作为跨文件载荷通过标准。

<a id="ed-improve-004"></a>
## ED-IMPROVE-004 文件替换统一 Unicode UTF-16 坐标

依赖：无（历史卡仅作参考，不跨板设依赖）。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与目标

`replaceInFilesModel.ts::searchMatchesToReplaceInputs` 直接使用 `matchStart/matchEnd` 作为 LSP character；`matchedText` 却使用 `Array.from` 的 code-point 坐标。评审生产函数探针中 `😀foo` 的 `foo → bar` 结果为 `\ud83dbaro`，正确结果应为 `😀bar`。该缺口继承自 main，但属于本轮必须修复的可见文本误改。

### 职责与实施合同

Owner：`replaceInFilesModel.ts` 坐标映射/freshness、`buildReplaceEdits.ts`，实际使用 range 的 `panels/FindInFilesPanel.tsx`、`panels/ReplacePreviewDialog.tsx` 与 Tab `onReplaceMatches`。同名测试归本卡；不修改搜索 query/ranking，后端若实际变更则追加 Rust 验证。

明确 backend search index → UTF-16 range 的转换位置，使 preview、导航、freshness 和 commit 共用同一个映射。不能只修 matchedText 检查而让写入仍用旧坐标。LF/CRLF/CR 的行定位一致，UTF-8 字节 hash 与字符偏移分开；非法偏移拒绝或返回有理由的冲突，不静默截断到错误位置。保留 B 的真实部分提交 ledger。

### 验收与验证

- **ED-IMPROVE-004-A1：** `😀foo` 搜索替换精确得到 `😀bar`；emoji/CJK/组合字符/多个 astral 前缀、多行与混合 EOL fixture 的 preview range 和结果一致，无破损代理项。
- **ED-IMPROVE-004-A2：** preview 后目标发生变化时拒绝旧 match，零效果无 history；正常多文件替换单次 undo 恢复所有原始文本，保存后磁盘编码/EOL/BOM 不漂移。
- **ED-IMPROVE-004-A3：** buildReplaceEdits/replace model/panel/Tab focused 与 typecheck、browser、当前 native 文件 hash 断言通过，baseline failing regression 保留。

复用 `TC-IDE-AUDIT-003-replace-conflict-ledger-native.testcase.yaml` 和 D2 Replace 用例，扩充 Unicode fixture，测试工具不得在结果断言前 normalize 掉代理项或替换符。A1 以纯映射和 mounted UI 双证，A2 以 native pre/post/undo hash，A3 以实际命令与 receipt；不需要 IDEA 实测来认定 Unicode 错位是错误。

<a id="ed-improve-005"></a>
## ED-IMPROVE-005 替换预览范围与提交集合不可变

依赖：ED-IMPROVE-004。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与目标

B 的 replace 模型已经有 `summarizeReplaceCommitReport`，但没有 A 的统一 preview scope snapshot。需从 `FindInFilesPanel`、`ReplacePreviewDialog` 到 Tab `onReplaceMatches` 审计 roots、scope、query/options、file mask、project generation、选中结果、replacement 与磁盘 preimages 的身份保持。这是明确的补强要求；不能未做复现就把每种 scope 都宣称已发生误改。

### 职责与实施合同

Owner：`findInFilesScopeModel.ts`、`replaceInFilesModel.ts`、上述 panels 与 Tab prepare/commit handler；`buildReplaceEdits.ts` 只消费 004 的统一坐标。必要文件可写状态通过已有读取接口取得，不把 library 状态当普通磁盘 readonly 的全部事实。若修改 `src/lib/editor/workspace.ts` 或 native file metadata，先与 006 顺序交接并补相应 Rust/native 验证。

preview 打开前固定 scope roots/files、query flags/globs/mask、项目分析 generation、selected IDs、replacement、ranges 和各文件 hash/dirty/readonly/可读取状态。显示排除项与原因；确认不能因为搜索刷新、范围扩大或文件新增而扩大集合。commit 校验整个 snapshot 和选中 edit 签名；IO 阶段保留每文件 precondition。取消/非法 regex/全部排除/只读/超限/读取失败不能报完整成功；部分效果继续用实际 ledger 和已有恢复，不回退到 planned count。

### 验收与验证

- **ED-IMPROVE-005-A1：** 固定 `src/A.java`、`src/B.java`、test、excluded fixture 的两处匹配；preview 后变更 root、facts、replacement、query、mask 或新增匹配文件不扩大实际提交集合，UI 与冻结选中集合一致。
- **ED-IMPROVE-005-A2：** dirty/readonly、外部改写、文件缺失/超限、取消及部分失败显示准确状态和实际数量；零效果无 history，已发生效果可恢复，Unicode 004 回归保持通过。
- **ED-IMPROVE-005-A3：** scope/model/panels/Tab tests、typecheck、browser 与当前 native 的磁盘 pre/post/undo 通过；只有实际改变搜索 hot path 才追加同 fixture performance evidence。

复用 D2 preview/cancel 和 AUDIT-003 native ledger 场景，加入“预览打开后独立修改”的步骤。A1 对应 scope snapshot 和 mounted selection assertions，A2 对应 native conflict/partial effect，A3 对应执行层。不得以删除结果刷新能力规避 snapshot 身份合同。

<a id="ed-improve-006"></a>
## ED-IMPROVE-006 原生保存失败的字节事实与临时文件清理

依赖：无（历史卡仅作参考，不跨板设依赖）。必需 evidence：`code-audit`、`unit`、`typecheck`、`rust`、`native`。

### 当前事实与目标

B 的 `src-tauri/src/workspace.rs::write_workspace_bytes` 对不同阶段错误提供的 effect/intent facts 不一致，临时写入失败没有统一清理。A 的 writer 修改可作参考，但不能覆盖 B 已完成的 save race/writeback 行为。目标是用户能准确区分“目标未改”“已写成功但后续失败”“结果未知”，并保留字节证据。

### 职责与实施合同

Owner：`workspace_write_file_encoded`、`workspace_write_loose_file_encoded`、`write_workspace_bytes`、`WorkspaceWriteError`；必要的 `src/lib/editor/workspace.ts` 兼容类型、Tab `saveFile` 的结果映射和 `saveCommit.ts` 回归。Rust inline tests 和 saveCommit/Tab tests 归本卡。

编码完成后预先固定 intent hash/byte length，读取可得 old hash；read/mkdir/temp open/write/sync 失败准确记录目标 zero effect，并尽力移除本次临时文件，清理失败保持诊断信息。编码前失败不得伪造 intent，rename/ack 不确定不得降为 known-zero；目标 byte effect 与新建父目录等辅助文件系统效果区分。closed-buffer、输入竞争、未知确认不盲重试合同保持。若追加 readonly 元数据，所有普通/loose/encoding 读取构造和 IPC 类型兼容，不能只更新一个返回路径。

### 验收与验证

- **ED-IMPROVE-006-A1：** encoded/loose Save 各错误阶段的目标 effect、intent/old/written hash 和 byte length 与实际字节一致；失败不遗留可清理的本次 temp，不能误清理他人文件。
- **ED-IMPROVE-006-A2：** 保存 await 中继续输入/关闭、external conflict、未知确认各有回归；新文本不丢失，失败或 unknown 状态不被 UI 显示为完整保存，无错误 history/自动重试。
- **ED-IMPROVE-006-A3：** Rust writer 真实测试、saveCommit/Tab focused、IPC/owner scoped typecheck 与当前 native 编码/EOL/BOM、独立 disk hash 检查通过。

Fixture：UTF-8 LF/CRLF、UTF-8 BOM、UTF-16LE BOM；普通与 loose file；isolated readonly/父路径为普通文件、可控 temp-write failure。Rust 故障注入需覆盖 write/sync/replace 分类，不伪装 OS 运行结果。native 复用 C0-01 和保存观察，权限注入根据实际 OS 能力分别实施。A1 以 Rust+native 字节为主，A2 以 mounted race/native 场景，A3 汇总。仅格式化编辑的 Rust 文件，macOS Cargo 前先执行仓库 krb5 stage。

<a id="ed-improve-007"></a>
## ED-IMPROVE-007 每个 leaf／file 的光标滚动折叠快照恢复

依赖：无（历史卡仅作参考，不跨板设依赖）。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`performance`。

### 当前事实与目标

B 的 layout/tab 结构和 active-first restore 已接线，但 `CodeMirrorHost`、`EditorGroup` 和 `workspaceLayoutPersistence` 未持久化每个 leaf/file 的完整 selection、scroll、fold。吸收 A 的状态划分思路；不移植其尚未补齐的 virtual-space undo 或重写 B restore 调度。

### 职责与实施合同

Owner：`workspaceLayoutPersistence.ts`、`workspaceTabPolicy.ts`、`EditorGroup.tsx`、`CodeMirrorHost.tsx` 的 snapshot capture/restore、Tab 对应 map/persistence/close/reopen handler；同名测试及 `workspaceRestoreModel.test.ts`。当前 schema 采用兼容扩展/显式迁移，不破坏旧 snapshot。

按 workspace identity → leaf ID → file key 保存 mainSelection、各 selection ranges、scroll 和 folds。shared text/history 仍只由 document owner 管理；同文档另一 leaf 不能覆盖本 leaf 视图状态。关闭/切 tab/重启恢复正确身份，损坏或越界快照安全 clamp/drop；dirty cancel、save failure 不关闭，清理不复活错误 workspace。捕获不能每键全量序列化到持久层；restore 后迟到 snapshot/Git diff 不覆盖已发生的新输入或滚动。

### 验收与验证

- **ED-IMPROVE-007-A1：** 同一长文件在两个 leaf 分别保持不同 caret/scroll/fold，多光标与主 selection 可恢复；切换文件、关闭重开和进程重启后恢复到正确 leaf/file。
- **ED-IMPROVE-007-A2：** 旧/坏/越界 snapshot、最后 dirty leaf cancel、save failure、文件丢失及 workspace 切换有负路径；共享 undo 和 B virtual caret/snippet/historyReplay 不回归，迟到 restore 不覆盖新输入。
- **ED-IMPROVE-007-A3：** persistence/Host/Group/Tab 回归、typecheck、browser、当前 native restart、匹配条件的输入及 24-tab restore performance 通过，性能 raw samples 可获取。

复用 C4-01/C4-02 与 `TC-IDE-C4-03-restore-active-ready-timing-native.testcase.yaml`；长 Java fixture 有可折叠块与超出屏幕的行。A1/A2 断言可见 caret/scroll/fold 和下一次输入效果，不只看序列化对象。性能复用现有 collector，在修改前后相同机器/runtime/fixture 下测量，不新设无来源预算；A3 保留 active-ready/all-ready 两种端点和误差，不用截图证明延迟。

<a id="ed-improve-008"></a>
## ED-IMPROVE-008 IME 确认取消与单次撤销的共享历史边界

依赖：ED-IMPROVE-007。必需 evidence：`code-audit`、`unit`、`typecheck`、`native`、`accessibility`。

### 当前事实与目标

B 已加入 composing guards 和 IME 测试；C3-02 native 尾段有真实 wbpy 输入，但只断言粘贴抑制、Escape 后焦点。A 有 composition 生命周期与 owner 分组思路。本卡先复现 B 实际确认/取消/undo，再补合同，不能把“缺少证据”直接写成所有输入法都坏，也不能直接搬 A 的全量 preimage 回滚。

### 职责与实施合同

Owner：`CodeMirrorHost.tsx` composition handlers、`workspaceDocumentTransactionOwner.ts` composition/history ownership、必要的 `workspaceActionHost.ts` chord 生命周期与 Tab event routing；已有 Host.ime/owner/keymap/Tab tests。依赖 007，保留新的 view snapshots 和 B snippet Tab/Shift-Tab 行为。

真实 pre-edit 到确认只形成一个逻辑 undo；取消清除本次 transient effect，不吞掉之前的历史或 sibling/provider/external 更新。并发外部 mutation 必须采用明确的拒绝/排队/安全映射策略，不能简单用 composition-start 的整文件快照覆盖最新正文。按 CodeMirror 最终 flush 时机结算；blur、unmount、切 workspace、异常 compositionend 均释放 owner/chord。composition 阶段导航、clipboard、snippet 和 workspace shortcuts 不抢候选；结束后正常恢复。

### 验收与验证

- **ED-IMPROVE-008-A1：** 当前平台真实输入法候选选择/确认/取消行为正确，确认一次 undo 还原，取消不额外占用 undo；中途导航/Tab/Escape/clipboard 不误触工作区命令。
- **ED-IMPROVE-008-A2：** blur/unmount/workspace switch、迟到事件、同文档 sibling 或外部更新不丢文本，不残留 composing/chord，结束后快捷键和正常 history 可用。
- **ED-IMPROVE-008-A3：** focused/owner/Host/Tab/typecheck 与当前 native+accessibility 通过，真实 composition 事件、键盘焦点、name/role/state、200% zoom 分项记录；屏幕阅读器未跑单列，不冒充通过。

本卡拟新增 `TC-IDE-IMPROVE-008-ime-lifecycle-native.testcase.yaml`，或扩展当前 C3-02 但保持独立 IME 断言。native 平台计划：Linux fcitx5 实际 engine，Windows Microsoft Pinyin，macOS 系统拼音，分别记版本和实际输入 transport。A1 的系统证据不可用 synthetic KeyboardEvent 替代；A2 的异步边界可用 mounted deterministic faults，并辅以 native 生命周期场景；A3 汇总当前平台实测。

<a id="ed-improve-009"></a>
## ED-IMPROVE-009 异步剪贴板取消与真实系统副作用记账

依赖：ED-IMPROVE-008。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与目标

B 的 `CodeMirrorHost.tsx::pasteSystemClipboard/cutSystemClipboard/pasteAsPlainText` 在异步结果迟到且正文/selection/composition 已变时有直接 return 分支；取消后的系统 effect 和 UI 观察不足。此卡吸收 A 的结果记账思想，同时保留 B 的循环分配、丢弃多余 segments 的明确降级与单光标 whole-block 行为。

### 职责与实施合同

Owner：上述 Host handlers、`workspaceClipboardSession.ts` guarded result、`clipboardObservationContract.ts`，必要的 popup cancellation 接口；对应 Host/session/observation/history/paste-plan tests。依赖 008，不能在剪贴板处理里绕开 IME owner。

冻结 workspace/session generation、view/file、doc/selection 和请求 token；任何迟到结果先判当前 owner。取消状态与 systemEffect 分开，write 已 performed 不能变为 not-performed；unknown 必须保留。closed view 不更新已销毁 UI，仍在有效的会话观察边界保留事实。pending plain paste 同样检查 selection 和焦点 owner；不向失去 owner 的编辑器写入/夺焦。fallback 明示原因，不把 unknown 一律称为 denied，history/privacy 数据不跨 workspace 泄漏。

### 验收与验证

- **ED-IMPROVE-009-A1：** pending read/write 期间变更 selection/doc/composition/owner，结果 cancelled/stale 与 performed/not-performed/unknown 两轴准确，无迟到 paste/cut、错误 focus 或 history。
- **ED-IMPROVE-009-A2：** denied/unknown/fallback 可见，外部 OS clipboard 更新后不使用旧 segments；2 segments/3 carets 为 X/Y/X，单 caret 得完整块，成功一次 undo 恢复。
- **ED-IMPROVE-009-A3：** session/observation/Host/paste-plan/mounted、typecheck、browser、当前 native 的真实 clipboard+后置文本断言通过，另两 OS 分列未验证。

复用 C3-01/02/03；模型用可控制 resolve 的 read/write Promise 覆盖每种系统 effect，native 使用实际系统 clipboard owner/权限环境验证正常与可运行负路径。不能用 stub effect 满足 OS native 证据。A1 以 typed result 和 mounted DOM 双证，A2 以实际 clipboard 与 undo，A3 以 receipt；日志不记录用户真实敏感剪贴板内容。

<a id="ed-improve-010"></a>
## ED-IMPROVE-010 同步 QA 控制目录并恢复静态门禁

依赖：无（历史卡仅作参考，不跨板设依赖）。必需 evidence：`code-audit`、`qa-lint`、`document`。

### 当前事实与目标

在 B HEAD `c6bc315c` 上运行 `qa_ui_auto audit --gate`，整体 exit 1，stderr 指向 `testid-catalog stale`。feature.controls 已包含 recovery、refactoring-preview、lightbulb 等控制项，而生成目录缺失。局部 coverage gate OK 与最终 exit code 不同，现有矩阵的全绿摘要不能作为当前 pass。

### 职责与实施合同

Owner：`.agents/skills/qa-ui-auto/references/testid-catalog.md` 生成产物；`qa-ui-auto-tests/feature-list.md` 只在核实生产 selector 后纠正不准确 control，不新增虚构 selector。不改产品代码、runner 退出码、coverage baseline 或历史证据。

按 qa-ui-auto 当前流程先核对 catalog/production controls，运行现有 `python -m qa_ui_auto.gen_testid_catalog` 生成，再 audit。记录完整 stdout/stderr/exit code，区分 static inventory 和 runtime coverage。本卡只修当前目录与静态门禁，不声称后续功能卡或最终源码运行通过；最终矩阵归 011。

### 验收与验证

- **ED-IMPROVE-010-A1：** stale 差异逐项可回链真实生产 selector 与 feature.controls，现存目录准确同步，旧 control 不因凑数删除。
- **ED-IMPROVE-010-A2：** `gen_testid_catalog --check` 与 `qa_ui_auto audit --gate` 均整体 exit 0，无新增 orphan/shallow 回归，不降低 baseline。
- **ED-IMPROVE-010-A3：** 保留 baseline exit 1 与修复后 exit 0 的原始结果/counts，文档只声称当前静态门禁，不把 helper footer 或目录覆盖率当运行验收。

A1 code-audit，A2 qa-lint，A3 document；本卡无 native/product effect、undo 或 performance 变更，不要求额外 UI 实测。

<a id="ed-improve-011"></a>
## ED-IMPROVE-011 B 完善轮最终源码门禁与能力矩阵

依赖：ED-IMPROVE-001、ED-IMPROVE-002、ED-IMPROVE-003、ED-IMPROVE-004、ED-IMPROVE-005、ED-IMPROVE-006、ED-IMPROVE-007、ED-IMPROVE-008、ED-IMPROVE-009、ED-IMPROVE-010。必需 evidence：`code-audit`、`build`、`qa-lint`、`document`。

### 当前事实与目标

原能力矩阵基于较早 ED-AUDIT-006 收官，§7 还保留已经由 ED-FOLLOW 卡处理的历史缺口；本板后续提交会再次改变 source/case/runner identity。最终集成必须从当前 B 树出发，逐项区分已修、仍未支持、未验证和历史记录。

### 职责与实施合同

Owner：本板最终 evidence、拟新增 `claudedocs/code-workspace-idea-2026-b-review-capability-matrix.md`、当前 QA catalog/feature 对齐与既有 status/release 证据汇总。011 是本板唯一 repository build owner，依赖其余十卡全部 done；原任务板的 done/history 不回写。不得在此卡顺手修新的产品缺陷：明确定位并建立独立后续项，必需验收未满足时不能关闭集成卡。

对本板 33 个 A ID 和原建议逐项建立 implementation→tests→summary/receipt/source/case/runner→platform→ceiling 映射。所有功能修复集成完成后固定源码，重跑本轮相关 native/provider/IME/clipboard/save/restore flows；功能卡历史通过可作来历，若 hash 过期则在最终 evidence 中补相应真实验证种类。运行全仓 `pnpm build`、`audit --gate`、覆盖本轮影响范围且非空的 `status --gate`，不能只选一个 unavailable case掩盖其余范围。若当前 status 工具不能承载某个平台手工项，单列该证据，不改成自动通过；不降低 scope 来隐藏本板必需失败。

保留 B 优势回归：virtual caret 撤销后的再次输入、snippet 无多余 indent 的单次 undo、2/3 segments 分配、真实 sortMembers、类 rename 的路径+字节双还原、连续 provider cases 无泄漏、5 MiB 与 24-tab 性能/保留量。不重做上游架构，不把 A 的已知缺口移入 B。Cleanup 仍按真实 provider unavailable 与已测合同范围表述；没有 IDEA 实测不宣称对齐百分比/L3。需要 release manifest 的既有范围另跑 `audit --release-evidence`，无 manifest 不声称 release-ready。

### 验收与验证

- **ED-IMPROVE-011-A1：** 最终源码 `pnpm build` 与 QA static gate 整体 exit 0，完整记录 counts/stdout/stderr，未隐藏真实失败；此前 catalog 修复在最终树仍有效。
- **ED-IMPROVE-011-A2：** 本板所有 A ID 有具体实现和可获取 evidence，必需受影响 flows 在最终源码对应当前 pass；Windows/Linux/macOS 分列，IDEA/Cleanup 未支持部分明确，过期 receipt 不冒充当前。
- **ED-IMPROVE-011-A3：** 明确列出的本轮 case/feature/platform 集合运行 status gate 并通过，失败/跳过/未覆盖保留；上述 B 核心优势回归保持，矩阵与真实能力一致，不以历史 done 相加宣称完整 parity。

本卡必需 evidence 是 code-audit/build/qa-lint/document；最终回归按实际执行追加 unit/native/provider/performance/accessibility 等 checks，不能用文档 kind 代替真实执行。A1 对应构建和静态门禁；A2 对应逐卡 evidence 审计及过期项补跑；A3 对应 current status 和关键回归记录。复用本板各卡选定 fixture/runner，artifact 存 ignored QA report 目录并在矩阵记录路径/hash/身份；无独立文档截图要求。
