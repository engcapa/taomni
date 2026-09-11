# Code Workspace main 合并后代码评审完善规格（2026-09）

权威任务板：[main 评审完善任务板](../code-workspace-idea-parity-backlog-2026-09-main-review.md)。审查基线 `0566cc249f39b2e860cc30155462f12080111f1d`，日期 2026-09-11；相关生产代码与已合并的 `8215052c` 无差异。本文为可交接的设计，所有修复后验证均待执行。

## 共用合同、证据分级与决定

遵守 [共享合同](./shared-contracts.md) 和 [上一轮规格](./idea-2026-b-review.md)，平台、Cleanup、IDEA 和 build owner 以本板第 3 节为准。路径缩写：`W/` = `src/components/editor/workspace/`；Tab = `src/components/editor/CodeWorkspaceTab.tsx`。文中 owned tests 指实际存在的同名测试；拟新增文件、接口或 case 明确标注，不当成现有工具或运行证据。

本轮按用户要求沿用 ED 任务格式：`ED-MAIN-xxx` 是工作包 ID，`ED-MAIN-xxx-A1/A2/A3` 是 AC；每节 `V-MAIN-xxx-*` 串联验证。所有 ID 属于本板，不借旧卡 acceptance 结案。没有新增产品流程或组件选型待决：恢复原有事务、输入和文件保全契约；普通实现细节由执行者在范围内处理。

| 决定 | 结论、来源与代价 | 状态／关联 |
|---|---|---|
| DEC-MAIN-001 基线与吸收范围 | 用户已合并原分支并要求基于评审建新板；按 main 实际差距编写，不移植另一分支全文件，避免带入已知错误 | 用户已定；全部卡 |
| DEC-MAIN-002 替换遇到新 preimage | 依既有“预览固定内容、旧计划不得重新锚定”契约，文件 preimage 变化时拒绝旧计划并要求重新预览；不自动扩大范围或重算 edits，代价是无关内容变化也可能需重新确认 | agent 按既有合同自决；005-A1/A2 |
| DEC-MAIN-003 快照兼容 | 在现有 viewStates schema 上兼容增加正文身份／scrollLeft；新快照正文不匹配时放弃旧视图定位，旧无身份快照保持原 clamp 行为并在新捕获时升级，不迁移到竞争的 snapshot store | agent 按兼容合同自决；009-A1/A2 |

前轮在 Node 中通过 TypeScript 内存转译直接调用两边生产模块，已观察到：原分支标准 disabled 对象被放行；`abc\rfoo` 的第二行合法匹配被判 stale；两边 clean buffer `ba→ab` 后 Save 抛错都返回 failed 且 Tab 的 mutated=false。这些是模型边界复现，未保存可移交的 runner receipt，不能作本轮修复通过证据。建板时已重新核对 main 对应源码，实施卡必须把各 fixture 落为可复跑的 failing→passing 回归。

版本混用、替换检查与写入断链、Windows delete→rename、剪贴板 focus/registry 缺口为源码事实；涉及实际 OS 的触发频率、Windows 原始故障、IME 最终 flush 顺序尚未真机验证。009 是明确的兼容补强，不将“缺少 hash”直接声称为已发生正文损坏。

### 共用验证入口

以下是实施阶段命令模板／现有入口，不是本次建板运行结果：

```bash
# 仓库根目录；填写本卡实际持有的测试和源码路径
pnpm exec vitest run <owned-test-files> --maxWorkers=1
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <owned-path-1> --path <owned-path-2>
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
python -m qa_ui_auto run --mode browser --filter <existing-or-implemented-case-id>
python -m qa_ui_auto run --mode native --filter <existing-or-implemented-case-id>
# src-tauri/；Rust 变更使用具体模块过滤，macOS 先在根目录执行 krb5 stage
cargo test --lib workspace::tests
cargo test --lib lsp::tests
```

PowerShell 使用 `$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"`。所有 scoped paths 包含生产、测试和实际修改的 adapter；若新增 TS/IPC 修改，追加 required `typecheck`；若实际修改 Rust，追加 required `rust`，通过 task-board 工具维护元数据。不得缩范围绕过本卡错误。001..009 不持有全仓 build。

新增 YAML 不是建板产物。各卡复用下述用例，补充自己的负路径；无法在现有 case 中清晰表达时，由该卡新建 `TC-IDE-MAIN-xxx-*.testcase.yaml`，实施前去重并按 qa-ui-auto authoring/schema 编写，同时维护 F25.5、必要的 F25.1、covers 和真实 controls；不能把只读观察接口变成修改状态的测试后门。

### 三端原生计划及证据边界

所有 native 使用独立构建的 `com.taomni.app.qa`，隔离 app-data 与一次性 fixture，记录 commit/source、QA binary identity、OS/架构/WebView、provider/输入法版本、命令或手工步骤。Linux 当前端计划 WebKitGTK；Windows 后续 WebView2；macOS 后续 WKWebView。构建和启动按 `.agents/skills/qa-ui-auto/references/native-testing.md` 及所选平台 runbook，启动前读取；macOS 不假设 Tauri WebDriver 可用，按实际 OS 自动化或手工记录执行。

每节具体 fixture/actions 在三端分别执行，建板时三端均未执行修复后验证。自动运行检查 summary/receipt 的 selected/pass/fail/skip、source/case/runner/build identity 和退出码；手工证据与 runner receipt 分开，不伪造自动 pass。原生磁盘用独立 read/hash 断言，IME 用真实输入法，clipboard 用真实系统 owner。清理只限本卡创建的数据和 QA 进程，不触碰开发者 profile。

## 卡片索引与参考分支防回退清单

| 卡 | 验证核心 | 前置 |
|---|---|---|
| 001 | buffer/disk 双效果与 journal/history | 无 |
| 002 | 标准 disabled 与 provider reason | 001 |
| 003 | LSP version、revision、generation 各自的门禁 | 002 |
| 004 | EOL 和 code-point→UTF-16 | 无 |
| 005 | preview/preimage/选中 edits 到写入的不可变链 | 001、004 |
| 006 | compositionend/blur/unmount 与最后 flush | 009 |
| 007 | owner 失效后的零编辑、真实 OS effect 观察 | 006 |
| 008 | Windows 替换失败保全旧字节 | 无 |
| 009 | 兼容快照、正文身份、双向滚动及保留量 | 无 |
| 010 | 全部验收和最终源码回归 | 001..009 |

以下属于未合并 `fb3f420b` 的问题，只设为吸收代码时的禁止回归项：failed+unknown 被归零、缺少工作流 journal plan、IME 全部按 user-input 入栈、忽略 resolved kind／text operations／版本、只读锁读旧闭包、语言未加载时只尝试一次 foldable、无尾部落盘的节流、replace cleanup 错误被丢弃。main 已有 live lock ref、composition owner、直接 fold ranges、故障注入和 cleanup helper，不为这些已具备的保护另行重写。

<a id="ed-main-001"></a>
## ED-MAIN-001 已修改 buffer 的保存失败效果与恢复闭环

依赖：无。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与目标

用户从 Rearrange/Cleanup/WorkspaceEdit 入口提交到 `W/workspaceEditApply.ts::applyTextDocumentEdit`。clean buffer 分支先 `applyToOpenBuffer` 再 `saveOpenBuffer`；保存失败只留下 failed outcome。Tab `applyLspWorkspaceEdit` 从 applied* 计算 mutated/appliedEffectPaths，可能误判没有修改并关闭 prepared journal。原分支虽有 diskEffect unknown 和 transaction summary，也未描述失败前已经发生的 buffer effect。需要修复实际账目，不只改提示文字。

### 职责与实施合同

Owner：`W/workspaceEditApply.ts` outcome/applyTextDocumentEdit/result 汇总；Tab applyLspWorkspaceEdit 的 save hook、mutated、transaction summary、journal finalize 和两处 workflow adapter；必要时 `W/rearrangeCleanupWorkflow.ts`、`W/workspaceEditHistory.ts`、`W/refactorPlan.ts` 和已有 recovery handler；相应测试均归本卡。`W/saveCommit.ts` 仅在实际 effect 类型需要兼容时修改，不重写 Rust writer（008 持有）。

在现有 outcome/summary 兼容扩展 bufferEffect 与 diskEffect 或等价结构；字段名可沿既有类型，但必须能表达“buffer performed、disk none/unknown、operation failed”。首次 mutation 前仍准备可恢复 preimage；失败不登记正常成功 history、不把 pending journal 关闭成 no-op。已发生效果的 paths 不能只来自成功状态。工作流先消费实际 effect，再判断身份失效，避免 guard stale 抹掉已发生效果。unknown 不开放盲重试，保留恢复身份和实际影响文件。

复用现有恢复中心／事务恢复入口。恢复之前检查当前 buffer 和磁盘是否仍符合该失败事务的后像；第三方或新输入冲突不能覆盖。恢复后独立回读，重复恢复幂等。没有任何 mutation 的失败保持零效果、零 history。正常操作只有一条成功 history，ED-FOLLOW-001 rename 逆操作不变；无需第二套 history 或新恢复 UI。

### 验收与验证

- **ED-MAIN-001-A1：** clean `ba→ab` 后分别注入保存 known-zero、unknown acknowledgement、post-read failure；result/UI/ledger 准确列 buffer、disk 和已影响路径，不能声称 none 或完整成功；mutation 前失败仍完全零效果。
- **ED-MAIN-001-A2：** 失败后通过现有恢复入口还原 preimage；pending 在重启后可发现，第三方改写／新输入冲突不覆盖，重复恢复不重复写入；journal 准备失败零修改。
- **ED-MAIN-001-A3：** 正常 sortMembers 只登记一次 history，单次 undo/redo 对应整个操作；Cleanup 无 provider 保持 unavailable；模型、mounted、scoped typecheck、browser、当前 native/provider 回归通过。

`V-MAIN-001-unit`：`W/workspaceEditApply.test.ts`、`W/rearrangeCleanupWorkflow.test.ts`、`W/workspaceEditHistory.test.ts`、Tab 同名测试，按 A1/A2 注入可控 Promise 和 save failure，断言正文、disk、journal 状态及恢复结果，保留 baseline failing。`V-MAIN-001-ui`：复用 `TC-IDE-IMPROVE-002-workflow-recovery-native`、`TC-IDE-AUDIT-015-rearrange-sortmembers-native`、`TC-IDE-AUDIT-014-rename-recovery-native`，补实际失败 buffer 的恢复，而非只运行 rename happy-path；browser 补本卡 mounted/可见 ledger 断言。真实 sortMembers 与模型故障分别记账，provider 证据记录 JDT LS/JDK/fixture。上述 V 均待执行，分别覆盖 A1/A2、A2/A3。

<a id="ed-main-002"></a>
## ED-MAIN-002 专用 provider 动作的标准 disabled 对象拒绝

依赖：001。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与目标

`W/rearrangeCleanupWorkflow.ts::workflowActionIsDisabled` 仅认 boolean true；LSP 标准 `{disabled:{reason}}` 在 raw 中存在却不生效。Tab 两个 resolve adapter 调用这个 validator，导致禁用动作仍可能 resolve/apply。目标是在 request/resolve 两端拒绝实际禁用动作并显示 provider 原因。

### 职责与实施合同

Owner：workflow disabled reader、validator；Tab `runRearrangeExecute/runCleanupExecute` 的 request action 选择及 resolve 前后检查；`W/rearrangeCleanupWorkflow.test.ts`、Tab 同名测试、`W/__fixtures__/jdtls/jdtlsRearrangeCleanupContract.test.ts`。优先读取已保留的 raw，不为简单修复强制扩展 IPC；若选择 typed disabled 透传，`src/lib/editor/lsp.ts`、`src-tauri/src/lsp.rs::LspCodeAction/parse_code_action` 及 Rust inline tests 一并纳入 owner，并追加 required rust。

缺省/null/false 为未禁用，标准对象及兼容 true 为禁用；缺失或空 reason 用明确 fallback，不误称 provider 不存在。request 已禁用不发 resolve；resolve 新增 disabled 时零 preview、零 commit、零 history。若同 kind 有可用动作，应在保持既有选择策略的前提下跳过禁用项；只有禁用候选时显示原因。原有 resolved kind、command/resource/cross-file 和 URI/path 约束全部保留，003 再处理版本。

### 验收与验证

- **ED-MAIN-002-A1：** 标准 reason 对象、空对象、true 在 request/resolve 两个阶段准确拒绝；UI 可见原始或 fallback 原因，正文与历史不变；null/false/缺省不误拒绝。
- **ED-MAIN-002-A2：** 真实 sortMembers discover→resolve→preview→apply→undo 保持，不能只依赖 capability 广告或标题；Cleanup/fixAll 边界不扩大。
- **ED-MAIN-002-A3：** validator/Tab/provider contract/scoped typecheck、browser unavailable 和当前 native/provider 通过；若改 IPC，Rust parser 与序列化测试实际通过。

`V-MAIN-002-unit`：上述 focused 测试，fixture 正常 A.java text edit 加 `raw.disabled={reason:"cannot sort"}`，断言 A1；再在 resolve 返回新增 disabled，证明不是只检测 request。`V-MAIN-002-ui`：复用 `TC-IDE-C8-04-rearrange-cleanup-unavailable-browser`、AUDIT-015/016 的真实能力链，mounted 覆盖禁用提示；真实 provider 未产生 disabled 时不得把 synthetic disabled 标为 provider 复现。V 覆盖 A1 与 A2/A3，均待执行。

<a id="ed-main-003"></a>
## ED-MAIN-003 LSP 文档版本与编辑器 revision 分离并贯穿提交

依赖：002。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与目标

validator 当前比较 `entry.version !== input.documentRevision`；Tab 传的是编辑器 revision。resolve 又把文档项 flatten 为 edits，workflow plan 不携带原 LSP version。共享 applier 本身有 open.version/lspSynced 校验，但收到 unversioned plan 就无法使用它。不能用当前 hash 相同代替 provider version 的完整身份。

### 职责与实施合同

Owner：`W/rearrangeCleanupWorkflow.ts` resolve result、validator、freeze/plan/apply context；Tab 两处 workflow adapter；`W/useWorkspaceLspSession.ts` 的 documentVersion/isDocumentSynced 接口消费（仅必要时扩展）；`W/workspaceEditApply.ts` 版本分支若实际变更归本卡。同名 tests、Tab test 和 JDT LS fixture contract 均纳入 scoped typecheck。保留 001 effect/recovery 和 002 disabled 合同。

冻结并分别记录 editor revision、实际已同步 LSP version、text hash、URI/path、workspace instance、provider generation、request token。先完成必要同步，再发请求；resolve 返回的 version 只能与对应 provider 文档比较。保留每文档 version 到不可变计划和首次 mutation 门禁；不得用 editor revision 填 LSP version，也不得简单删 version 以避免 false stale。null/unversioned 载荷仍使用 byte hash/generation/liveness 等门禁，不伪造版本。

versioned edits 的 request/resolve/preview/首次 mutation 窗口逐项验证；same-text revision bump 在能证明 provider 同步身份合法时允许。保留 main 的 live readonly lock ref、token 和预览后 guard。完整载荷先验证再规范化：operations 与 documentEdits 若同时存在，按 native parser 合同核对相同文档、range、text、version；矛盾或丢失项拒绝，不能只信一个列表而隐藏另一个。resolved kind、disabled、command、resource、双向 URI/path/cross-file 校验继续生效；合法 JDT LS 文档末尾 range 的已有兼容行为按协议和实际 payload 保持，不顺便改写所有 range 策略。

### 验收与验证

- **ED-MAIN-003-A1：** editor revision=42、LSP version=7 的合法 version=7 edit 可以完成；version=6 被拒绝；preview 后 LSP version/generation/URI/文件身份变化时按真实身份拒绝旧计划，零写入/history。
- **ED-MAIN-003-A2：** editor-only same-text 合法同步不误杀，unsynced 或 superseded 不能提交；unversioned action 仍有完整 hash 门禁；矛盾的两个 payload 列表和 resolved kind 漂移全部拒绝。
- **ED-MAIN-003-A3：** workflow/session/applier/Tab focused、typecheck、browser 和当前 native/provider 通过，真实 sortMembers 一次 undo 保持，001 failure recovery 与 002 disabled 不回归。

`V-MAIN-003-unit`：workflow、useWorkspaceLspSession、workspaceEditApply 和 Tab 同名 tests，延迟 request/resolve/preview/排队 apply；断言传入最终 applier 的真实版本及实际正文，不只断言导出类型。`V-MAIN-003-ui`：AUDIT-015/016、C8-04；真实正向 provider 使用 pinned SortMembers.java，版本冲突使用 mounted deterministic fixture，二者分列。覆盖 A1/A2 与 A3，均待执行。

<a id="ed-main-004"></a>
## ED-MAIN-004 替换的混合换行与非法搜索坐标一致性

依赖：无。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与目标

`W/replaceInFilesModel.ts::verifyReplaceMatchFreshness` 用 LF split，而 `W/lspTextEdits.ts` 支持 LF/CRLF/CR。已知 `abc\rfoo` 的第二行匹配被误拒绝。原 code-point→UTF-16 转换正常 emoji 已修复，但负值、非整数、NaN、超过行长等原始输入应在转换前校验，不能先 clamp 再把错误 range 当合法匹配。

### 职责与实施合同

Owner：`W/replaceInFilesModel.ts`、`W/buildReplaceEdits.ts`、`W/panels/FindInFilesPanel.tsx` usage/navigation 映射、Tab `openSearchMatch`；同名测试和必要 `W/lspTextEdits.test.ts`。保持搜索 query/ranking、backend index 定义和部分提交 ledger；不要为了映射重写 Rust search engine。

统一 EOL 行定位与 UTF-16 转换，preview、导航、freshness、最终 edit 使用同一合法 range；非法原始 match 返回有原因的无提交结果，异常不能炸掉整个面板。matchedText 仍取正确 UTF-16 slice。保留迭代转换效率，避免对长行每个 offset 重复 Array.from/slice/join 的全量分配。dirty/readonly/外部冲突继续由既有提交边界及 005 管理。

### 验收与验证

- **ED-MAIN-004-A1：** `abc\rfoo`、LF/CRLF/混合 EOL 的相同行文本可正常 preview/定位/替换；`😀foo→😀bar`、多个 astral 前缀、CJK/组合字符保持精确，无破损代理项。
- **ED-MAIN-004-A2：** 负值、fraction、NaN、越界、反向 range 在转换前被拒绝且原因可见；目标正文变化仍冲突，零效果无 history，不静默截断写错位置。
- **ED-MAIN-004-A3：** model/build/panel/Tab scoped 回归和 typecheck、browser、当前 native 文件 pre/post/undo hash 通过，保存的 encoding/EOL/BOM 不漂移。

`V-MAIN-004-unit`：上述同名测试，fixture 至少含 `abc\rfoo` 和 `😀foo`，mounted 检查 preview 与下一次编辑位置。`V-MAIN-004-ui`：D2-01、D2-02、AUDIT-003，扩充 EOL/Unicode fixture；独立读盘比较字节，不在断言前 normalize。A1/A2 对应 unit+mounted，A3 对应实际执行和 native，均待执行。

<a id="ed-main-005"></a>
## ED-MAIN-005 替换 preimage 与精确选中 edit 贯穿首次写入

依赖：001、004。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与目标

面板冻结 scope/query/replacement/matches/edit，但 `ReplacePreviewSnapshot` 无文件 preimage；Tab `onReplaceMatches` 的 freshness read 不传给 applier。closed-file apply 再读盘，使用新 hash 和旧 range，两个读取间的修改可能被当作可写新基准。`validateReplacePreviewSelection` 验证子集、数量、新文本，但没有逐项核对选中 key 与实际 path/range 的对应关系。

### 职责与实施合同

Owner：`W/replaceInFilesModel.ts` snapshot/selected validation、`W/panels/FindInFilesPanel.tsx` prepare/commit、`W/panels/ReplacePreviewDialog.tsx` 排除与准备状态、Tab Replace handler；`W/workspaceEditApply.ts` per-file precondition 消费；同名测试。必要新增 prepare callback 在这些现有组件间定义并标明输入/输出，不建立第二套文件写入接口。若扩展 native readonly metadata，所有 normal/loose read/IPC 返回同步更新并追加 Rust evidence。

预览可确认前读取固定文件集合的 preimage：canonical path/URI、text hash 与磁盘 byte hash 分开、encoding/BOM/EOL、buffer revision/dirty、可读/只读事实及 workspace identity；prepare pending/失败、全部排除、取消可见且零写入。读取期间 scope/query/replacement 或 workspace 改变使旧 prepare 失效，不把迟到结果挂到新预览。显示排除项，不以关闭搜索刷新来规避冻结。

commit 从冻结集合减去用户排除项，逐项验证 path、UTF-16 range、replacement、重复项以及 WorkspaceEdit 的实际 operations；不能仅比较 count 或未消费的 signature。整个 snapshot 的 preflight 在 effect 前执行，每个文件写入前再次使用冻结的 precondition。closed file 的第二次 read 必须匹配原 preimage，不能拿第二次 hash 重新锚定计划；open file 在每个 await 后检查 dirty/revision/hash。scope/facts 改变不扩大集合；身份不成立则显式 stale/conflict，用户重新预览。

多文件首写前全量校验尽量保持零效果；后续文件在已部分写入后发生冲突则保留真实 applied/failed ledger，按 001 恢复，不声称所有文件成功。expected-hash 检查能封闭本应用两次读盘间的重锚定问题，不声称普通文件系统提供了跨任意外部进程的原子 compare-and-swap；OS read→replace 的剩余边界须如实说明。

### 验收与验证

- **ED-MAIN-005-A1：** `A.java/B.java` 各含 foo；preview 后改写任一文件、准备读取后/实际 apply read 前插入前缀、dirty 切换、workspace 切换均不能将旧 range 写到新正文；首写前发现冲突时全体零效果。
- **ED-MAIN-005-A2：** 相同 edit 数量但替换了 path/range 的伪选中集被拒绝；合法排除后只写被冻结的精确子集；后续文件失败报告实际已改数量并可恢复，不覆盖第三方更新。
- **ED-MAIN-005-A3：** prepare/model/panel/Tab/applier tests、typecheck、browser 和当前 native pre/post/undo 字节断言通过；004 Unicode/EOL、单次 undo 和 001 failure effect 保持。

`V-MAIN-005-unit`：上述同名 tests，用两次不同 readDisk 结果和延迟 Promise 确定性复现断链；assert 写入参数仍为冻结 hash、冲突处零写入、partial 的实际正文。`V-MAIN-005-ui`：D2-01/02、AUDIT-003，在 preview 打开后通过独立 fixture 写入修改，再确认并检查所有文件；挂载层补首读与 apply read 的精确窗口。A1/A2 对应边界模型与 UI，A3 对应命令和 native receipt，均待执行。

<a id="ed-main-006"></a>
## ED-MAIN-006 IME 最终 flush 与共享历史收尾验证及修复

依赖：009。必需 evidence：`code-audit`、`unit`、`typecheck`、`native`、`accessibility`。

### 当前事实与先行诊断

main 已有 `composition` origin、owner 的 openCompositionViewId 与合并逻辑，前轮 `n→ni→你` 模型一次 undo 正常。待验证的是 `W/CodeMirrorHost.tsx::compositionEndGuard` 在 capture 阶段立即 finalize，可能早于 CodeMirror 最后一次 flush；blur/unmount 也可能改变顺序。不得从此静态顺序推断所有真实 IME 已坏。

先在 mounted Host+真实 owner 记录 event/update/origin/finalize 序列，分别构造最后 docChanged 在 end 前、同轮后、下一微任务／DOM flush 后的场景；读取当前 CodeMirror 版本事件实现来排除不可能的序列。若当前实现已满足，保留证明并不改生产；若失败，再修正该边界，不以固定 80ms 等魔数代替 flush 身份。

### 职责与实施合同

Owner：`W/CodeMirrorHost.tsx` composition handlers/update listener、`W/workspaceDocumentTransactionOwner.ts` composition lifecycle；必要 `W/workspaceActionHost.ts` chord 释放与 Tab 路由；Host.ime/owner/keymap/Tab tests。保留 009 快照与已有 snippet/virtual caret/historyReplay。

采用明确 session/token 与最终 update 的归属，按 CodeMirror 实际 flush 结束一次组合事务；取消回到本次前像不留额外 undo，后续普通输入不并入 composition。异常 end、blur/unmount/workspace switch 释放会话，不把旧事件合并到新文件。同文档 sibling/provider/external 更新采取可证明的拒绝／安全映射／排队策略；排队必须连同 owner revision 和 controlled-prop reconciliation 一起闭合，不仅延迟 view subscribe。不能用 composition-start 整文件回滚覆盖外部文本。

### 验收与验证

- **ED-MAIN-006-A1：** 先给当前生产链确定性的事件顺序结果；确认 `n→ni→你` 和最终 flush 迟到场景只需一次 undo，取消后 undo 作用于此前普通输入，不能复活预编辑文本。
- **ED-MAIN-006-A2：** blur/unmount/workspace switch、连续 composition session、sibling/provider 更新期间没有文本丢失或遗留 composing/chord，旧事件不归入新会话；结束后快捷键与 history 正常。
- **ED-MAIN-006-A3：** focused/typecheck 与当前端真实输入法 native/accessibility 通过；候选、确认、取消、Tab/Escape/导航/clipboard 不抢候选；name/role/state、焦点、200% zoom 分项记录，未运行屏幕阅读器单列。

`V-MAIN-006-unit`：Host.ime/owner 及实际触及的 keymap/Tab tests，end-before-final-flush 与 sibling 不同位置 edits，断言文本和 undo 结果。`V-MAIN-006-native`：复用 `TC-IDE-IMPROVE-008-ime-lifecycle-native`，Linux 使用实际可用 fcitx5 engine，Windows Microsoft Pinyin、macOS 系统拼音分别后续执行；记录真实 transport 和 composition 事件，不用 synthetic KeyboardEvent 充当 OS 证据。V 分别覆盖 A1/A2 与 A1/A3，均待执行；无法建立真实故障不伪造 baseline red。

<a id="ed-main-007"></a>
## ED-MAIN-007 剪贴板异步焦点 owner 与销毁后观察归属

依赖：006。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与目标

Host paste/plain/cut await 后检查 view connected、doc、selection、composing，但切到另一仍挂载 leaf 不一定改变这些事实，随后还会 focus 原 view。`reportClipboardCancelledObservation` 在结果返回时再查 view WeakMap，销毁后可能丢记录。目标是旧请求不能编辑或夺焦，但已发生的系统效果仍属于原会话。

### 职责与实施合同

Owner：`W/CodeMirrorHost.tsx` clipboard handlers/context lifecycle；`W/workspaceClipboardSession.ts` guarded session 与结果观察边界；`W/clipboardObservationContract.ts`；必要 `W/EditorGroup.tsx`、Tab 活动 leaf/focus token 接线；相应 tests。观察字段只保存计数/长度/hash identity 等非正文元数据，保护 privacy/session isolation。

请求前冻结 workspace/session、file/view、活动 owner generation、doc/selection、request token 与观察端点。返回时先判断当前 owner、readOnly、composition/session，再决定编辑；lost owner、关闭后同 key 重开、旧请求晚于新请求返回，都不得 paste/cut/focus/history。不能简单要求 `view.hasFocus`，因为正常菜单／上下文菜单触发会暂时持有焦点；应使用已授权命令 owner/token 判定菜单归属，保住正常菜单粘贴。

冻结的观察回调必须最终归到仍有效的原会话；workspace 切换后不能调用新工作区的 UI setter 或泄露 clipboard shape/history。原 view 销毁后仍可在 session 观察边界记录 cancelled 与 verbatim systemEffect，performed 不降为 not-performed、unknown 不伪装 denied。fallback 未实际使用时不能写 usedWorkspaceFallback=true。不整块移植参考分支代码。

### 验收与验证

- **ED-MAIN-007-A1：** pending read/write 时切 leaf（保留 DOM/doc/selection）、转焦搜索框、workspace 切换、销毁重开或启动新请求，旧结果均不修改正文、不抢焦点、不增加 history；取消与 OS effect 两轴准确。
- **ED-MAIN-007-A2：** view 销毁后 performed/unknown 仍在原有效会话保留元数据，关闭的 workspace 不更新新 UI；正常快捷键／菜单／上下文菜单 paste/cut 均可用，denied/unknown/fallback 原因可见。
- **ED-MAIN-007-A3：** session/observation/Host/Group/Tab/paste-plan tests、typecheck、browser 与当前 native 通过；2 segments/3 carets 仍 X/Y/X，单 caret 仍完整块，成功一次 undo，外部 OS clipboard 更新不复用旧 segments。

`V-MAIN-007-unit`：复用 Host、session、clipboardObservationContract 同名 tests；拟新增 `W/CodeMirrorHost.clipboardOwner.test.tsx` 由本卡持有，用可控 read/write Promise 覆盖 lost-owner 与合法菜单 owner 两组，并断言焦点和真实正文。`V-MAIN-007-ui`：C3-01/02/03，native 用真实 clipboard 和切 leaf/关闭动作，效果注入与 OS 测试分列。V 对应 A1/A2 与 A2/A3，均待执行。

<a id="ed-main-008"></a>
## ED-MAIN-008 Windows 保存替换失败的旧文件保全

依赖：无。必需 evidence：`code-audit`、`rust`、`native`。

### 当前事实与目标

`src-tauri/src/workspace.rs::replace_file` 在 Windows 先删除 target 再 rename temp；旧文件已删后 rename 失败，writer 还会尝试删除 temp，只剩错误事实而无可恢复字节。现有 WriteBytesFault::Replace 在真正替换前返回，不能覆盖这个窗口。本次尚无 Windows OS 复现，仅据源码确认保全合同缺口。

### 职责与实施合同

Owner：`workspace.rs::replace_file/write_workspace_bytes_with_fault/temp_failure_with_cleanup` 和 inline tests；必要同模块平台适配，只有现有平台依赖确实不够时才精确调整 `src-tauri/Cargo.toml` 及 lock。默认不修改 TS/IPC/Save writer 返回结构；如果必须扩展，则将 `src/lib/editor/workspace.ts`、`W/saveCommit.ts` 及相应 tests 加入 owner 和 required typecheck/unit，顺序与 001 交接。

优先使用 Windows 已有平台绑定提供的替换现有文件原语／安全移动，不以删除唯一旧文件作为准备步骤。存在目标与首次创建分别处理；跨盘临时文件禁止，路径/Unicode/权限/共享句柄和竞态要明确。若任何 fallback 需要备份，备份创建、确认、恢复和失败保留必须可验证，不能清理唯一可恢复副本。Linux/macOS 保持已有同目录 rename 语义，不声称单一原语可保证任意存储故障下绝对持久性。

保留 intent/old/written hash、length 与 target effect；cleanup 自身失败记录独立诊断，不以“目标还存在”单独证明旧字节不变。故障注入覆盖真正 commit/replace 的失败边界，而不只是函数入口；测试需断言旧字节仍在原路径或明确可发现的恢复副本。保留原有 temp open/write/sync/replace 测试，不删除故障模型来取得通过。

### 验收与验证

- **ED-MAIN-008-A1：** Windows 分支不再先删除唯一旧目标；替换失败／拒绝时旧字节仍可验证且不会清理唯一恢复副本，目标存在/缺失、路径 Unicode、共享句柄占用分别有明确结果。
- **ED-MAIN-008-A2：** normal/loose encoded Save 的 intent/old/written facts 与实际字节一致；可清理 temp 不遗留，cleanup 失败保留原因，不删除其他调用的文件；known-zero/unknown 不混淆。
- **ED-MAIN-008-A3：** Rust writer 阶段回归、当前平台真实 native UTF-8/BOM/UTF-16/EOL 保存与失败后字节验证通过；三端 cfg 兼容审查明确，Windows 原始 OS 触发未跑时单列 unverified，不伪称三端已测。

`V-MAIN-008-rust`：从 src-tauri 执行 `cargo test --lib workspace::tests`，新增替换保全与恢复副本 cleanup 的确定性断言。Windows 可用时在目标被占用／替换拒绝场景执行同一测试和 QA 保存，独立检查原文件/备份 hash；当前 Linux 运行同目录替换及可移植故障合同，不能冒充 Windows API 运行。`V-MAIN-008-native`：C0-01、C0-02 保存 smoke，隔离 normal/loose 文件，各编码 pre/post/错误字节断言。V 对应 A1/A2 与 A2/A3，均待执行；平台交付边界见共用合同。

<a id="ed-main-009"></a>
## ED-MAIN-009 视图快照的正文身份与横向滚动兼容完善

依赖：无。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`performance`。

### 当前事实与目标

main 的 `W/CodeMirrorHost.tsx::captureEditorViewState/applyPersistedEditorViewState` 已维护独立 selection/fold ranges/scrollTop；`W/workspaceLayoutPersistence.ts::PersistedEditorViewState` 无正文身份和 scrollLeft。旧快照直接 clamp 到新内容，不证明 folds 仍属于原正文。本卡补强完整 view snapshot，保留已经可工作的生命周期，不移植参考分支的 foldable-before-language 和缺少尾部落盘的问题。

### 职责与实施合同

Owner：上述 Host capture/restore、`W/workspaceLayoutPersistence.ts` normalize/schema、`W/EditorGroup.tsx` snapshot 传递、Tab viewStates hydrate/persist；同名 tests 和 `W/workspaceRestoreModel.test.ts`。不建立竞争 store，不变更 shared document/history owner（006 持有其 composition 变化）。

按 DEC-MAIN-003 兼容增加正文身份与 scrollLeft；旧无 identity 快照按原策略读取，新捕获升级，不能清空所有旧布局。新快照 hash 不匹配时舍弃旧定位/folds，绝不覆盖正文；坏数值 clamp/drop。保留 leaf/file/workspace 三层身份。直接恢复已有 fold ranges，或如果采用语法重算，则等待语言就绪且检查期间无新用户输入／滚动，不能无条件迟到覆盖。

scroll 恢复在实际布局可滚动后完成，横纵都检查可见位置；只应用一次当前身份的 snapshot。持续输入/scroll 捕获保持 debounce，停止后最后一次必须落盘；unmount/切 workspace 的尾部报告必须归原 owner，不污染新实例。正文 hash 在 Text 身份不变时复用，不每键全量 hash/序列化；保留现有 view/undo/echo 保留上限，不通过砍可恢复状态改善性能。

### 验收与验证

- **ED-MAIN-009-A1：** 同一长 Java 文件两个 leaf 具有不同主 selection/多光标、fold ranges、横纵 scroll，切文件／关闭重开／重启恢复各自状态；下一次输入落在正确 caret。
- **ED-MAIN-009-A2：** 旧 schema、损坏 snapshot、相同长度但正文已变、workspace 切换安全处理；语言延迟和布局迟到不能覆盖新操作，短间隔多次滚动停止后最终状态会持久化；shared undo/virtual caret/snippet 不回归。
- **ED-MAIN-009-A3：** persistence/Host/Group/Tab/restore tests、typecheck、browser、当前 native restart 和同条件输入/24-tab restore performance 通过，保留 raw samples、active-ready/all-ready 端点和保留量。

`V-MAIN-009-unit`：上述同名 tests，伪时钟精确检查一次落盘后短间隔最后一次更新仍会落盘；mounted 用相同长度不同 text、延迟 language 和已滚动状态验证 A1/A2。`V-MAIN-009-ui`：IMPROVE-007 view-state native、C4-01/02/03，补横向滚动与下一次输入断言，不只查看存储对象。`V-MAIN-009-perf`：C0-03 与 C4-03，修改前后同 fixture/QA build profile 采样；driver 崩溃留 failed/unverified，不以新预算或删 case 代替。A3 对应真实执行与 raw artifacts，均待执行。

<a id="ed-main-010"></a>
## ED-MAIN-010 main 完善轮最终源码回归与能力矩阵

依赖：001..009。必需 evidence：`code-audit`、`build`、`qa-lint`、`document`。

### 当前事实与目标

建板并不证明产品完成；后续每卡都将改变源码。原 ED-IMPROVE 最终矩阵保留历史身份，不能替代 ED-MAIN 的当前集成结果。010 要把本板 30 个 A ID 与最终实现/测试/执行/平台/能力上限逐项关联，不在此卡修新的产品缺陷。

### 职责与实施合同

Owner：本板最终 evidence、拟新增 `claudedocs/code-workspace-idea-2026-main-review-capability-matrix.md`、受影响 QA catalog/feature 对齐和最终 scope/status；矩阵由本卡实施时新建，本次设计不创建空矩阵。全仓 build 仅本卡执行。每个功能卡实现后维护自己的 YAML/controls，010 检查真实对应关系，不以已有文件个数推断覆盖。

固定最终 source/case/runner/build identity 后，重跑 001..009 受影响链；历史 card pass 可记录来历，过期 receipt 不作当前 pass。矩阵列：A ID、生产 owner、具体 tests/case、source/receipt 或手工 evidence、OS/runtime、实际结果、剩余上限。Windows/macOS 当前未实测与已知产品错误分开；Cleanup unavailable、IDEA 未跑、screen reader 未跑、driver infra-blocked 均不算通过。

最终运行集合至少包含：IMPROVE-002、AUDIT-015/016、AUDIT-014、D2-01/02、AUDIT-003、C0-01/02、IMPROVE-008、C3-01/02/03、IMPROVE-007、C4-01/02/03、C0-03、C8-04，以及功能卡新增的 ED-MAIN 行为 case。先逐项核对实际 case 文件/模式，按明确列表建立非空 scope；手工 native/IME/platform 项单列证据，不能制造自动 receipt。status 不能表达的手工项不伪装自动 pass，必需失败也不能移出范围隐藏。

保留能力回归：实时 readonly ref 和预览后 guard、typed unknown/recovery、fault injection/cleanup 诊断、严格 provider kind/payload、virtual caret undo 后再次输入、snippet 单次接受无额外 indent、X/Y/X 分配、真实 sortMembers、类 rename 路径与字节双还原、provider 进程隔离、5MiB 与 24-tab 性能及保留量。发现新问题须独立列待处理项；若阻断本板验收，不得关闭本卡。

### 验收与验证

- **ED-MAIN-010-A1：** 最终源码 `pnpm build`、`gen_testid_catalog --check`、`audit --gate` 全部 exit 0，记录真实 counts/输出，目录准确且未降低 baseline 或隐藏失败。
- **ED-MAIN-010-A2：** 全部 30 个验收 ID 有具体 owner→tests→当前证据映射，关键失败／恢复与正常流在最终源码重跑；三端和 Cleanup/IDEA 上限明确，不以旧 done 累加完成度。
- **ED-MAIN-010-A3：** 明确 case/feature/platform 集合的非空 `status --gate` 通过，手工项另有真实证据，保留能力回归不变；未执行、失败、skip、infra-blocked 均保留，必需缺口阻止 done。

`V-MAIN-010-build`：根目录 `pnpm build`。`V-MAIN-010-qa`：按共用 PYTHONPATH 设置，运行 `python -m qa_ui_auto.gen_testid_catalog --check`、`python -m qa_ui_auto audit --gate`；运行 `python -m qa_ui_auto status --cases <本卡建立并审核的完整scope目录> --reports qa-ui-auto-report --platform <实际当前平台> --gate`，尖括号均须实施时替换，目录现在不存在。`V-MAIN-010-matrix`：人工核对矩阵每个 A ID、完整 scope、受影响类型及 summary/receipt/source，不以文档 kind 代替 unit/native/provider/performance/accessibility，实际运行追加相应 checks。V 依次对应 A1、A1/A3、A2/A3，全部待执行。

## 设计交接状态

本板初始可领取任务以 `task_board.py list --claimable` 实时输出为准；无 owner 已领取，无产品修复已实施。现有契约足以开始，无需另设文档批准步骤。006 的最小区分性诊断、008 的 Windows 原平台复测以及性能环境可用性已写入各卡，不能提前作为通过或忽略。若后续发现实质合同冲突，按任务生命周期记录 review_required 与具体选项；不由执行者默默降低验收。
