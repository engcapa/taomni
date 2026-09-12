# Code Workspace main 完善实现复审修复规格（2026-09）

权威任务板：[ED-REPAIR 任务板](../code-workspace-idea-parity-backlog-2026-09-main-repair.md)。审查日期 2026-09-12，源码 HEAD `826c0c6a5ac17ef0fb795d468d114c948306dc77`，分支 `feat/code-workspace-idea-parity-main-review`。本文是交接设计，全部修复和修复后验证待执行；不把上一轮 done 或本轮建板校验作为产品通过证据。

## 共用合同、证据分级与设计决定

遵守 [共享合同](./shared-contracts.md)；本板第 3 节指定当前平台交付范围及 build owner。承接 [ED-MAIN 规格](./idea-2026-main-review.md) 的效果、冻结预览、IME、剪贴板和快照合同，保留其已实现且本轮未发现新缺陷的 disabled、独立 LSP version、Windows 替换原语。`W/` = `src/components/editor/workspace/`，Tab = `src/components/editor/CodeWorkspaceTab.tsx`；源码行号仅指上述 HEAD，实施以符号为准。各节 named tests 均为仓库现有文件；新增 helper/type/case/scope 会明确标为拟新增。

本轮已执行的 review 命令如下，233 + 2 项通过证明现有用例的覆盖范围，不证明本轮反例已经正确处理：

```bash
pnpm exec vitest run src/components/editor/workspace/rearrangeCleanupWorkflow.test.ts src/components/editor/workspace/replaceInFilesModel.test.ts src/components/editor/workspace/workspaceEditApply.test.ts src/components/editor/workspace/workspaceLayoutPersistence.test.ts src/components/editor/workspace/CodeMirrorHost.test.tsx src/components/editor/workspace/panels/FindInFilesPanel.test.tsx --maxWorkers=1
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t ED-MAIN --maxWorkers=1
```

第一条 6 suites、233 passed；第二条 2 passed、150 skipped（由筛选未选中）。review 还通过 TypeScript 内存转译调用生产函数；IME 使用生产事件处理函数与真实 document transaction owner，剪贴板使用生产 owner guard。它们是确定性逻辑探针，没有可移交的 QA runner receipt，也没有真实输入法/剪贴板 OS 复现。002、004、005 的完整 UI 竞态仍需实施卡做可控 Promise 的 mounted 复现。审查未运行完整构建、Rust 或三端 native；不能推断这些层失败或通过。

| 决定 | 本轮合同与代价 | 负责卡 |
|---|---|---|
| DEC-REPAIR-001 效果与重试 | 原 text edit 的 buffer effect 已发生后，不允许按原 range 再执行。known-zero 保存可以在原身份/后像仍成立时只重试持久化；没有安全入口时转现有恢复再重新预览。unknown 必须先恢复/核实 | 001、004 |
| DEC-REPAIR-002 冻结计划 | 首写前全量检查实际选中目标；任何冻结事实变化均拒绝旧计划，不自动拿新 hash 重算 ranges。后续竞态不能假装原子事务，保留真实部分效果 | 002、003、005、006 |
| DEC-REPAIR-003 取消不可逆 | prepare 或 clipboard 请求一旦丢失 owner，焦点/参数恢复原值也不能复活旧 token；新请求获得新授权，正常菜单有明确归属 | 005、008 |
| DEC-REPAIR-004 组合会话 | 每次 composition 独立归属，延迟 flush 与收尾使用冻结会话身份，不使用迟到回调中的“当前 owner”关闭下一会话 | 007 |
| DEC-REPAIR-005 快照整体 | 定位与正文版本一起捕获。hash 可以延迟，但计算输入必须是该快照原文档；持久化不能把旧位置重标成新正文 | 009 |

上述选择恢复现有功能合同，无新增产品能力或额外批准步骤。具体接口由实施 agent 按当前代码决定，但不得以修复方便而改变用户范围、恢复策略或 required evidence。

### 共用实施与验证入口

先把本卡反例放入现有生产路径测试，在领取基线取得预期失败，再实施。需要运行旧基线时使用隔离 checkout/worktree 或既有测试机制，不回退共享工作区、不覆盖用户及其他 agent 的改动。时间竞态用可控 Promise/事件屏障表达，不用任意 sleep 碰运气。测试同时断言文本、磁盘、operation effects、history/recovery 和可见错误，不只断言函数被调用。

以下是实施阶段模板，不是本次已运行命令；尖括号必须替换成各节实际路径或实施后的 case：

```bash
pnpm exec vitest run <owned-test-files> --maxWorkers=1
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path <owned-production-path> --path <owned-test-path>
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --filter <case-id>
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --filter <case-id>
```

行为卡的 typecheck 必须列出全部实际修改的源码、测试和 adapter，记录 scoped errors 与 out-of-scope errors；不得缩 scope 避开本卡错误。修改 Rust 时通过任务工具追加 `rust`，按模块运行真实测试；macOS 直接 Cargo 前先执行仓库规定的 krb5 stage。001..009 不承担全仓 build。

每个 `V-REPAIR-xxx-unit/browser/native/...` 是本文验证计划标识，不是已有命令或采集器。沿用现有 QA case，补负路径；若不能清晰表达，可由该卡新建 `TC-IDE-REPAIR-xxx-*.testcase.yaml`，先按 `qa-ui-auto` 查重和读取 authoring/verb/schema。不可凭空假定 YAML 支持延迟 IPC 或故障注入。需要新增 QA 故障控制时由对应卡持有，限隔离 QA 环境且经过真实 owner/IPC，不用观察接口直接改正文、历史或伪造 receipt。

### 三端计划与证据上限

Linux 当前端使用隔离 `com.taomni.app.qa`、独立 app-data、fixture 和实际 WebKitGTK；Windows 后续 WebView2，macOS 后续 WKWebView，按各端支持的自动化或手工流程。实施 native 前读取 QA native-testing 与对应 runbook，不假设 macOS 支持 Tauri WebDriver。记录 source/commit、binary identity、OS/架构/WebView、fixture、命令、pre/post 与日志；输入法、系统剪贴板和 provider 另记具体版本。

每卡相同 fixture/action 均安排三端执行，当前端必需层通过才可 done；其他端无设备可以 unverified，不自动阻断当前交付。003 的编码/EOL 在三端独立查真实字节；006 先确认文件系统大小写规则，Windows/macOS 默认不区分大小写目录不可宣称验证了两个大小写文件共存；007 分别用 Linux 实际输入法、Windows 中文 IME、macOS 中文输入法；008 用各端系统剪贴板和跨 surface 焦点；009 用各端重启与真实滚动布局。真实 IDEA 同 fixture 比较和屏幕阅读器可选、独立记录未运行；007 的焦点/键盘/name/role/state/200% zoom 与真实 IME 属于必需 accessibility。

原生磁盘后置条件由独立读盘/字节 hash 证明，不能只读编辑器 store；clipboard 需要外部 OS owner/read/write 验证；IME 必须有真实输入过程。存在性检查不能证明字节保全，函数 replay 不能证明 OS 行为。没有真实 Cleanup provider 时只验证 unavailable，不将 fake action 或 generic fixAll 记为 provider 正向成功。010 保持真实 JDT LS sortMembers 链与 Windows writer 源码防回退检查，不把 Linux 保存成功当成 Windows 替换拒绝实测。

## 任务与验证索引

| 卡 | 主结果 | 依赖 |
|---|---|---|
| 001 | performed buffer 的重试不重复 edit | 无 |
| 002 | selected preimages 全量门禁及每文件效果前复验 | 004、005、006 |
| 003 | 消失行/非法坐标严格拒绝 | 无 |
| 004 | 无 plan 的部分事务可恢复 | 001 |
| 005 | prepare 迟到结果不能发布 | 006 |
| 006 | 路径 key 不错误合并文件 | 003 |
| 007 | end/blur/reentry 不合并 IME 会话 | 009 |
| 008 | 剪贴板 owner 失效不可逆且菜单正常 | 007 |
| 009 | 定位与正文身份同版本，兼容及性能保持 | 无 |
| 010 | 最终源码九项反例、保留能力与 30 个 AC 可追溯 | 001..009 |

<a id="ed-repair-001"></a>
## ED-REPAIR-001 已生效 buffer edit 的保存失败重试安全

依赖：无。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`provider`。

### 当前事实与复现

`W/workspaceEditApply.ts::applyTextDocumentEdit` 已报告 failed + bufferEffect performed，但 `buildWorkspaceEditApplyResultV2` 仍以非 applied/noop 状态设置 failureBoundary；Tab `applyLspWorkspaceEdit`（约 9229 行）的 retry loop 从该 operationIndex 切片重放，只拦截 disk unknown。无版本约束的 edit 将 clean buffer `foo` 的 `[0,3)` 改成 `foobar`，保存抛 `WorkspaceEditOpenBufferSaveFailure(...,"none")` 后重试，正文成为 `foobarbar`；此时 dirty 分支还不再保存。这是生产模型已复现的问题，不是 provider 完整性问题。

### 职责与实施合同

Owner：`W/workspaceEditApply.ts` outcome/result/resume 分类；Tab `applyLspWorkspaceEdit` retry loop、事务汇总与现有 plan journal 接线；`W/workspaceEditApply.test.ts`、Tab 同名测试，必要的 `W/rearrangeCleanupWorkflow.test.ts`。004 接手无 plan 恢复；001 不另造 history/recovery 系统，也不提前重写 002 的 Replace preflight。

区分 operation 的 buffer、disk 和最终执行状态。只对两个效果均未发生且身份有效的操作使用原 edit 重试。buffer performed + disk none 时，保留失败事实并禁止文本重放；若提供“重试保存”，必须确认文档 key/session/revision、当前 buffer 等于失败后的后像、磁盘仍符合保存前置条件，只重试持久化，不因 dirty=true 跳过应有保存。安全验证失败转 conflict/stale 和既有恢复；允许选择直接恢复后重新预览，但 UI 不再承诺“未执行后缀”包含已执行文本。disk unknown 不开放盲重试。

恢复/重试期间新输入、关闭重开、workspace 切换不覆盖新状态；取消保留已发生效果。operation ID/原始 index 与 transactionId 在多次 suffix 尝试中稳定，事件历史保留失败，但最终汇总按每个 operation 的已证明结算状态计算，不能因历史中曾有 failed 而永远 partial，也不能用最后一次 suffix 的 outcomes 抹掉前缀效果。成功仅登记一次整个逻辑事务的 undo/redo；失败不能登记普通成功 history，现有 plan recovery 仍可发现。

### 验收与验证

- **ED-REPAIR-001-A1：** 上述 `foo→foobar` 的 known-zero 保存失败、重复点击重试、放弃重试均不产生 `foobarbar`；unknown 不重放；mutation 前零效果失败仍可按原前置条件重试。正文、磁盘、bufferEffect/diskEffect 和 UI 分别准确。
- **ED-REPAIR-001-A2：** 对含成功前缀、失败边界和未执行后缀的事务，重试/取消/再失败保持稳定 operation 身份及完整账目；新输入/第三方磁盘变化/关闭重开均拒绝不安全保存或恢复。已有 plan 的失败可从原 recovery 入口恢复，正常全部结算只有一次事务 history。
- **ED-REPAIR-001-A3：** 模型与 mounted Tab 从真实入口覆盖 A1/A2，当前端保存失败/恢复有独立磁盘后置条件；真实 JDT LS sortMembers discover→resolve→preview→apply→undo 正常，disabled、版本门禁和 Cleanup unavailable 不回归；focused/typecheck 通过。

`V-REPAIR-001-unit`：运行 workspaceEditApply、rearrangeCleanupWorkflow 及相关 history 测试，新增多次尝试和非幂等 replacement 的断言，覆盖 A1/A2。`V-REPAIR-001-browser`：Tab 同名测试从命令/确认对话框进入，注入可控 save 失败，断言实际正文、UI、journal/history，覆盖 A1/A2/A3。`V-REPAIR-001-native/provider`：补 `TC-IDE-IMPROVE-002-workflow-recovery-native`、`TC-IDE-AUDIT-015-rearrange-sortmembers-native`；真实 provider happy-path 与故障 fixture 分别记账，覆盖 A2/A3，不用 provider happy-path 代替 retry 负路径。全部为待实施/运行计划。

<a id="ed-repair-002"></a>
## ED-REPAIR-002 Replace 全量预检与打开缓冲区冻结条件

依赖：ED-REPAIR-004、005、006。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与复现

Tab `prepareReplacePreimages` 已存 revision/dirty/readOnly/workspace，但 commit 只消费 expectedDiskHashes；`assertExpectedDiskHash` 只在 `readDisk` 调用，`getOpenBuffer`→`applyTextDocumentEdit` 的 open 分支绕过。Tab `onReplaceMatches`（约 18980 行）在 await 读盘前捕获 open 对象，返回后检查旧 dirty。打开 clean A，预览后确认并暂停任一读取/确认/队列等待，用户改 A，再继续，旧 ranges 可能作用于新 buffer。

第二个 fixture：关闭的 A=`foo A`、B=`foo B`，预览后把 B 改成 `foo B!`，匹配范围仍成立；外层 freshness 通过，逐文件 hash 直到 A 已写才拒绝 B。B 的变化在首写前已存在，本应全体零效果。以上生产调用链已确认，完整 mounted/OS 交错仍由本卡记录复现。

### 职责与实施合同

Owner：Tab `onReplaceMatches`、`applyLspWorkspaceEdit` 的冻结条件/preflight/getOpenBuffer/readDisk/apply hooks；`W/replaceInFilesModel.ts` 快照校验；`W/workspaceEditApply.ts` 效果前门禁接口及对应测试。005 输出一致 prepare token/snapshot，006 提供统一路径 key，003 提供严格 freshness，004 提供无 plan 的 recovery。不得另起平行提交器绕过已有 Save/事务 owner。

以被冻结计划减去排除项形成唯一 actual operations。检查实际 edits 与精确选中 path/range/replacement 的一一对应，拒绝重复、非 text 扩张和不属于选中项的同数量替换；不要仅比较 source 全集、数量或未消费的 signature。首次效果前对全部实际选中文件做全量 preflight；被全部排除的文件不写，也不扩大到刷新后的新匹配。预检固定文件存在性、canonical identity、workspace instance、buffer 的 open/closed 会话及 revision/dirty/readOnly/text、磁盘 hash 与相关 encoding/BOM/EOL。正文 hash 与磁盘字节 hash/保存条件保持各自语义，不将两者混为一谈。

每个 await/确认/资源队列返回后重新检查相关 owner；逐文件效果前再次验证冻结条件。open-clean 与 open-dirty 的处理不能因选择了 open 分支而失去 preimage 门禁；沿用 Replace 拒绝 dirty 的策略，不能悄悄改成修改新 dirty buffer。closed→open、close→reopen 同 key、外部重载与 workspace A→B→A 均不能复用旧身份。closed read 返回的新 hash 只用于比较原 preimage，不替换它；未知/缺失前置条件显式拒绝，不能让可选字段或 legacy fallback 绕过生产 Replace 的必需快照。

首写前冲突使全部零 buffer/disk 效果，显示具体 stale/conflict 原因，不能被 readDisk catch 吞成普通 file not found。首写后才发生的冲突停止余项，交给 001/004 的真实 ledger/recovery；拒绝用自动回滚覆盖第三方输入。普通文件系统的 read→replace 不提供跨任意外部进程的原子 compare-and-swap，本卡只封闭应用 owner/await/preimage 的漏洞并如实记录 OS 剩余边界。

### 验收与验证

- **ED-REPAIR-002-A1：** A/B fixture 在预览后、全量预检期间、额外确认/队列等待期间、各次 apply read 前改变 buffer/disk/open-session/readOnly/workspace 均不能把旧 range 写到新正文；首写前已存在 B 冲突时 A/B 全体零效果，并显示真实冲突目标。
- **ED-REPAIR-002-A2：** 首写后才产生的 B 冲突保留 A 的实际效果并可按 004 恢复；未选中项无效果，合法子集只执行一次；伪造相同数量但不同 selected path/range、重复 edit 或资源操作被拒绝。替换正常完成单次 undo/redo，恢复不覆盖后续输入。
- **ED-REPAIR-002-A3：** model/Panel/Tab/applier 覆盖完整冻结条件到首次效果的链，focused/typecheck/browser 和当前 native pre/post/undo 字节断言通过；003 EOL、006 路径大小写及 001 失败重试不回归。

`V-REPAIR-002-unit/browser`：replaceInFilesModel、workspaceEditApply、FindInFilesPanel 和 Tab 同名测试；用可控 Promise 在上述每个 await 点改变条件，记录 A 的写次数为零或真实已执行值，覆盖 A1/A2/A3。`V-REPAIR-002-native`：补 `TC-IDE-D2-02-replace-commit-undo-native`；A/B 使用临时目录，外部进程独立修改 B 与验证 pre/post 字节，覆盖 A1/A2/A3。若新增阻塞点/故障入口必须限定 QA 并由本卡实现，不将仅 mock 的调度当成 OS 测试。

<a id="ed-repair-003"></a>
## ED-REPAIR-003 消失行与越界坐标的严格 freshness 拒绝

依赖：无。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与复现

`W/replaceInFilesModel.ts::verifyReplaceMatchFreshness`（约 238 行）调用允许 clamp 的 `offsetFromLspPositionInString`，原 `line === undefined` 和 end 超出行长检查已移除。生产模型：搜索 `foo\nfoo`，保留第二行 `foo`，磁盘在 preview prepare 前变为 `foo`，freshness 返回空冲突，旧第二行 edit 改了第一行。由于 prepare 捕获的是缩短后的正文，新 expected hash 也通过。`searchMatchesToReplaceInputs` 对 lineNumber 仍有 Math.max，需一并审计严格输入边界。

### 职责与实施合同

Owner：`W/replaceInFilesModel.ts` 搜索输入/严格 freshness；必要时 `W/lspTextEdits.ts` 增加独立严格坐标 helper（拟新增），保留现有宽松导航 API 的兼容语义；上述同名 tests、Panel/Tab 的错误可见性测试。不得全局更改 LSP 导航 clamp，或回退 CR 支持来恢复行检查。

先验证原始 lineNumber 为有效正整数、原始 code-point offsets 为整数且在源行内；转为 UTF-16 后，验证当前正文 start/end line 实际存在、行内字符位置合法且方向正确，再比较 matchedText。非法值、消失行、越界列和需要 clamp 才成立的坐标都返回明确 conflict/invalid-coordinate，零提交。LF、CRLF、独立 CR、混合 EOL 和尾部空行使用一致行界定义，不将 CRLF 的两个字符误当两次换行；合法 emoji/组合字符维持 backend code-point 到 UTF-16 转换。搜索契约若仅支持单行匹配，继续显式拒绝跨行伪数据。

### 验收与验证

- **ED-REPAIR-003-A1：** 第二行消失的 fixture 在 model 和 Panel→Tab 入口均 blocked，第一行不改；覆盖负数、零/小数/NaN 行号，越界/小数/NaN/反向字符位置、缩短行、EOF/尾部空行，绝不 clamp 后继续提交。
- **ED-REPAIR-003-A2：** LF、CRLF、CR、混合 EOL 中的合法 `foo` 和 emoji 匹配正常预览/提交；UTF-16 range、匹配正文和实际字节位置一致，取消零效果、成功单次 undo 恢复原编码/BOM/EOL。
- **ED-REPAIR-003-A3：** replace model、必要的 lspTextEdits 与生产 Panel/Tab 回归通过，focused/typecheck/browser 和当前 native 删除行负路径及合法 EOL 正向验证通过；普通导航行为不回归。

`V-REPAIR-003-unit/browser`：replaceInFilesModel、lspTextEdits、FindInFilesPanel、Tab 同名 tests，覆盖 A1/A2/A3；不要只对构造的 offset helper 做测试。`V-REPAIR-003-native`：扩展 D2-02 的外部删行与编码/EOL fixture，在预览读取前修改文件，并独立比对错误前后 hash 和成功 undo 字节，覆盖 A1/A2/A3。

<a id="ed-repair-004"></a>
## ED-REPAIR-004 无 plan 的部分成功事务恢复入口

依赖：ED-REPAIR-001。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与复现

Tab `applyLspWorkspaceEdit` 仅在 options.plan 存在时准备 recovery journal（约 9149 行），而新增 hasFailedOperation early return（约 9447 行）跳过普通 history。`onReplaceMatches` 不传 plan。关闭文件 A/B 均包含 `foo`，A 写为 `bar`、B 写失败，用户拒绝重试：A 有磁盘效果，当前事务既没有普通 undo 也没有 prepared journal；单文件 Save 记录不能代替本次多文件前缀的恢复身份。源码链已确认，需 mounted/真实磁盘 fixture 落实。

### 职责与实施合同

Owner：Tab apply 的 journal preparation/finalization/history/summary，`W/refactorRecoveryController.ts`、`W/workspaceEditHistory.ts`，必要的 `W/refactorPlan.ts` 现有恢复数据构建和同名 tests、Tab 同名 tests。复用现有 recovery center、journal 存储和文本前像；允许为通用 text WorkspaceEdit 构建适配现有格式的内部恢复描述，不要求调用者伪装成 provider action。001 的效果/重试策略不回退，002 稍后接入同一恢复入口。

对本卡范围内无 plan 的文本 WorkspaceEdit（首先覆盖 Replace）在首个效果前准备可持久发现的恢复记录，关联 transaction/operation IDs 与实际 frozen text/encoding/BOM/EOL、buffer/disk 身份；准备失败全体零效果。正常完成验证后只登记一条事务 history 并结算 journal。部分失败不写普通“成功”history，但保留 recovery-required、已执行文件/效果及清晰可见恢复入口；无效果失败不留虚假可恢复事务。

恢复前验证失败事务的实际后像，区分 open buffer 的正文和 disk 的真实结果；unknown 先读取核实，不凭 planned post-image 覆盖当前内容。用户后续输入、第三方修改、关闭重开身份不成立时拒绝覆盖并显示冲突。多文件恢复可能再部分失败，逐项保留事实与恢复进度；重复恢复幂等，已恢复项不重复应用逆 edit。重启后仍可发现原事务，正常 undo/redo 也不丢 dirty/encoding/BOM/EOL。现有 resource rename/create/delete 恢复合同保持；不在本卡扩张到新资源操作方案。

### 验收与验证

- **ED-REPAIR-004-A1：** 无 plan 的关闭 A 成功/B known-zero 或 unknown 失败、放弃重试后，UI 与持久 journal 列出真实 A/B 效果；正常成功只有一次 history，零效果和 journal 准备失败全体零写入。
- **ED-REPAIR-004-A2：** 通过现有恢复入口还原已发生效果，重启后可发现、重复恢复幂等；第三方更新/新 buffer 输入不被覆盖，恢复自身部分失败保留可继续处理记录与准确原因。
- **ED-REPAIR-004-A3：** Tab、history、recovery tests 及当前 native 的无 plan Replace 部分失败→重启→恢复独立字节断言通过，focused/typecheck/browser 通过；001 retry 和已有 plan/rename 的恢复、单次 undo 不回归。

`V-REPAIR-004-unit/browser`：workspaceEditHistory、refactorRecoveryController、必要的 refactorPlan 及 Tab 同名 tests，直接走 onReplaceMatches/apply 生产链，覆盖 A1/A2/A3。`V-REPAIR-004-native`：扩展 D2-02 与 `TC-IDE-IMPROVE-002-workflow-recovery-native`，保存失败注入必须到真实 Save 边界，并用同一隔离 app-data 重启发现 journal，独立检查磁盘/dirty buffer/重复恢复，覆盖 A1/A2/A3。

<a id="ed-repair-005"></a>
## ED-REPAIR-005 Replace prepare 请求的取消与身份隔离

依赖：ED-REPAIR-006。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与复现

`W/panels/FindInFilesPanel.tsx::replaceAll`（约 587 行）仅检查当时 replacePreview 是否存在，await prepare 期间没有 pending/token。请求 P1 暂停，修改 replacement 为新值并触发 P2，先完成 P2 再完成 P1，旧闭包可覆盖新预览；修改 query/scope/workspace 或关闭面板也不能使旧 continuation 失效。Tab prepare 还在逐文件 await 前获取 open 状态，存在混合时刻快照风险。

### 职责与实施合同

Owner：Panel replaceAll/state/error/pending/取消生命周期、Tab prepareReplacePreimages 接线与逐次 await 的 owner 检查，`W/replaceInFilesModel.ts` 必要的快照请求身份类型及上述 tests。不提前实现 002 的最终提交门禁；本卡负责只发布内部一致且属于当前 prepare 的快照。

请求开始同步分配单调 token，冻结 workspace instance、scope/query/options/replacement、匹配集合/选中身份和准备版本；建立 idle/preparing/preview/error 状态或等价闭合模型，pending 可见且有取消方式，连续点击不启动竞争发布。相关输入变化、搜索 generation/匹配集合变化、取消、unmount、workspace 切换均永久失效旧请求；参数改回原值不复活 token。旧成功、旧错误都不能修改当前 preview/error/loading，不仅 guard 成功路径。重复点击的去重必须在同一 event loop 内也有效，不能只依赖 React 下一次 render。

Tab 在所有 await 后验证被冻结的 workspace/root/session，与调用方 token 一起判断是否允许返回；读盘前后 open revision/dirty 等事实不能混合成伪快照。检测 prepare 期间状态变化就 stale/取消并要求重新准备，且零写入。可以实际取消底层读取，也可忽略失效结果，但 pending 最终释放且不泄漏到新面板。只读观察不触发提交；正常预览仍允许排除、取消、失败重试，不能通过永久禁用搜索更新解决竞态。

### 验收与验证

- **ED-REPAIR-005-A1：** 同步连点、P1/P2 反序完成、旧请求失败、新请求成功均只显示当前结果；pending/取消/失败可见且所有 prepare 路径零 buffer/disk/history 效果。
- **ED-REPAIR-005-A2：** query/options/replacement/scope/搜索 generation/workspace A→B→A、面板关闭重开和 prepare 读盘期间 buffer 变化使旧 token 失效；迟到结果不发布预览或错误，也不清除新请求 pending。
- **ED-REPAIR-005-A3：** model/Panel/Tab 的可控 Promise 测试、focused/typecheck/browser 和当前 native 预览等待/切换/正常排除取消通过；交给 002 的 preimages、workspace/request 身份及 edits 来自同一有效快照。

`V-REPAIR-005-unit/browser`：FindInFilesPanel、replaceInFilesModel、Tab 同名 tests，以实际按钮、输入和 rerender 驱动请求交错，覆盖 A1/A2/A3。`V-REPAIR-005-native`：补 `TC-IDE-D2-01-replace-preview-exclude-cancel-browser` 的 browser 断言；为 native 等待边界在 D2-02 或拟新增本卡 case 中安排真实读盘与取消/切 workspace，确认无写入且新预览可用，覆盖 A1/A2/A3。若 native 不能稳定触发等待，不把即时成功截图记为竞态通过。

<a id="ed-repair-006"></a>
## ED-REPAIR-006 Replace 路径身份保留大小写语义

依赖：ED-REPAIR-003。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与复现

`W/replaceInFilesModel.ts::replacePreimagePathKey`（约 348 行）统一替换分隔符后 toLowerCase；不同的 `/ws/A.java` 和 `/ws/a.java` preimage 在 Map 中覆盖。同一 key 被 expected hash 与 replaceEditKey 消费。`W/codeWorkspaceModel.ts::fsPathComparisonKey/fsPathEquals` 已按既有 Windows 路径语义处理，不应再维护一套更宽松的身份规则。模型已验证两项不同 hash 合成一项；不声称已复现文件被互相覆盖。

### 职责与实施合同

Owner：replace model 的 preimage key/find/hash/edit key，Tab 对这些 key 的消费点和 tests。优先复用 fsPathComparisonKey；仅在确有必要时修改 codeWorkspaceModel 的相关 helper 并追加其回归，不做全仓路径规则改造。

在文件系统路径与 URI 之间先使用现有解析/规范化入口，避免把 `file://` 文本直接当路径再次大小写折叠。preimage lookup、hash map、selected edit 验证使用同一 canonical key。区分大小写的 POSIX 路径保持区别；Windows drive/separator/UNC 按现有已支持规则保持等价。不可通过对全部路径比较 lowercased 值，或把不同 preimage 默默合并，规避一致性错误。重复同一 canonical 文件但事实矛盾时显式冲突；对 symlink/平台真实 case folding 不新增超出仓库现有能力的保证。

### 验收与验证

- **ED-REPAIR-006-A1：** `/ws/A.java` 和 `/ws/a.java` 的不同 preimages 在 map/find/actual edit 校验中保持两项正确身份；替换两个文件和只选一个文件的结果都准确，不产生假 hash 冲突或写入排除项。
- **ED-REPAIR-006-A2：** 现有 Windows drive 大小写、分隔符及 UNC 路径测试保持；URI 解析与 path key 不混淆，重复 canonical 文件的冲突可见，003 严格坐标和正常取消/undo 不回归。
- **ED-REPAIR-006-A3：** replace model 和生产 Tab/Panel 回归、focused/typecheck/browser 通过；当前 Linux 区分大小写目录下两个真实文件分别比对 pre/post/undo 字节，其他平台能力与未验证项明确记录。

`V-REPAIR-006-unit/browser`：replaceInFilesModel、必要的 codeWorkspaceModel 测试与 Tab/Panel 同名 tests，覆盖 A1/A2/A3。`V-REPAIR-006-native`：扩展 D2-02 的 A.java/a.java 双文件 fixture，先确认两文件可独立创建和读取，再验证替换/排除/undo，覆盖 A1/A3；Windows 行为模型是 A2 的确定性证据，不能写成 Windows 原生通过。

<a id="ed-repair-007"></a>
## ED-REPAIR-007 IME end/blur/reentry 的会话收尾

依赖：ED-REPAIR-009。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`accessibility`。

### 当前事实与复现

Host `compositionEndGuard` 先 active=false，再 setTimeout(finalize,0)；`compositionBlurGuard` 清除 timer 后见 active=false 直接返回（约 3075 行）。`compositionStartGuard` 同样只清 timer，没有结算上一会话。复审用生产处理函数及 `WorkspaceDocumentTransactionOwner` 重放“你→end→blur→下一会话好→end→timer”，得到正文你好、undoDepth=1，一次 undo 回到空串。真实输入法的事件时序/频率尚未实测。

### 职责与实施合同

Owner：`W/CodeMirrorHost.tsx` composition start/end/blur/cleanup/最终 flush guards，`W/workspaceDocumentTransactionOwner.ts` 必要的会话归属；Host/owner 同名 tests、必要的 EditorGroup/Tab 生命周期接线。009 的 snapshot 尾部捕获接口先交接；008 接手 clipboard owner。不得把所有 composition 改成普通 user-input 或取消历史合并。

建立明确 composition session identity，冻结 owner/file/view/workspace；active、end pending、finalized 各自有结束路径，清 timer 不能替代 finalize。end 的最终 CodeMirror flush 仍属于本次组合；不能简单同步 finalize 回退到上轮“一次输入两个 undo”的问题。blur 或下一次 start 遇到旧 pending 时必须结算或安全移交旧 flush，并开启独立新 session。迟到 callback 不得读取可变 ref 后关闭新 owner 或新会话；unmount/workspace switch 后也不能往新文件应用旧 flush。

取消回到本次前像不消耗 undo，不能用整文件回滚覆盖 sibling/provider/external 更新。不同 origin 的更新按现有 owner revision 规则隔离，不合并到组合；后续普通输入为独立 undo。若新增队列，需同时证明 canonical owner、controlled prop reconciliation 和订阅更新一致，不只延迟 DOM listener。

### 验收与验证

- **ED-REPAIR-007-A1：** end→最终 microtask flush、end→blur（timer 前）、end→下一 start（timer 前）、blur 先于 end 等交错均正确收尾；“你”和“好”两次确认产生两个逻辑 undo，先退到“你”再空串；单次组合多次 preedit 仍一次 undo。
- **ED-REPAIR-007-A2：** cancel、unmount、workspace 切换、同 key 重开及 sibling/provider/external 更新不遗留会话、不误吞历史、不覆盖新文本；迟到回调不影响下一会话，结束后普通输入和快捷键正常。
- **ED-REPAIR-007-A3：** owner/Host mounted 事件测试和 focused/typecheck/browser 通过；当前端真实 IME 的候选/确认/取消/失焦/连续输入通过，独立记录键盘、焦点、name/role/state、200% zoom；屏幕阅读器与其他端未执行时单列。

`V-REPAIR-007-unit/browser`：workspaceDocumentTransactionOwner、CodeMirrorHost、必要的 EditorGroup/Tab tests，用真实 Host listeners/CodeMirror transactions 和可控时序断言文档/history，不仅调用 finalize mock，覆盖 A1/A2/A3。`V-REPAIR-007-native/accessibility`：扩展 `TC-IDE-IMPROVE-008-ime-lifecycle-native`，当前端真实输入法按 A1/A2 连续组合与失焦复测，记录键盘导航、Tab/Escape 不抢候选及 A3 分项证据；自动化不足可做可复查手工步骤，不伪造 runner pass。

<a id="ed-repair-008"></a>
## ED-REPAIR-008 剪贴板请求 owner 失效不可逆

依赖：ED-REPAIR-007。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`。

### 当前事实与复现

Host `clipboardOwnerLost`（约 597 行）只在 `!view.hasFocus && generation changed` 时拒绝；请求 pending 时从编辑器转焦搜索框再返回，正文和选区未变，旧 paste/cut 获得执行资格。生产 guard 重放 ownerLost 从 true 变回 false。isActive 的可见性、菜单暂时持焦和旧观察端点也需沿实际 Group/Tab 接线验证，不能仅更改条件后宣称全链正确。

### 职责与实施合同

Owner：Host pasteSystemClipboard/pasteAsPlainText/cutSystemClipboard/copy 的 owner/token/endpoint guards；必要的 `W/workspaceClipboardSession.ts` 和现有 observation 层；EditorGroup/Tab 菜单/活动 leaf/workspace 接线及对应 tests。保持 007 的 IME session 拒绝、readOnly、doc/selection 和 newer-request 门禁。

请求前冻结 workspace/session、file/view 实例、单调 owner generation、request token、doc/selection、菜单授权和观察归属。generation 变化永久失效该请求，即使 hasFocus、参数或 workspace 名称恢复；同 key 重开也是新 view/session。不能只看 visibleRef：两个 split 均可见，活动 owner 仍有区别。新的合法请求可以执行，不设置永久全局禁用。

菜单/上下文菜单触发应持有来源编辑器的明确命令 owner/token，临时菜单焦点本身不错误取消正常 paste；从菜单转到搜索框/另一 leaf/另一 workspace 则使旧请求失效。不能简单要求 view.hasFocus，也不能无条件允许“返回时有焦点”的请求。失效结果不改正文、不 focus、不增加编辑历史；cut/copy 的已发生 OS write 或 unknown 仍通过原会话元数据通道记录，不能归零。冻结 endpoint 不能再借内部可变 ref 更新新 workspace UI；原 workspace 已关闭时按现有 session 生命周期保留/终止元数据，不复活新实例或泄漏正文。

### 验收与验证

- **ED-REPAIR-008-A1：** pending read/write 下 editor→search→同 editor、leaf A→B→A、workspace A→B→A、销毁重开、新请求先返回均使旧请求零正文/焦点/history 效果；正文选区保持不变也必须拒绝。
- **ED-REPAIR-008-A2：** 正常快捷键/菜单/上下文菜单 paste/cut 可用，菜单→其他 surface 的旧请求取消；销毁后的 performed/unknown 元数据归原有效会话，关闭 workspace 不更新新 UI，denied/fallback 原因可见。
- **ED-REPAIR-008-A3：** Host/Group/Tab/session 的 mounted 与 focused/typecheck/browser 通过；当前端真实剪贴板所有权/延迟返回/拒绝/恢复验证通过；多光标 2 segments/3 carets 仍 X/Y/X，单 caret 完整块、成功一次 undo，外部 OS 更新不复用旧 segments。

`V-REPAIR-008-unit/browser`：CodeMirrorHost、EditorGroup、Tab、workspaceClipboardSession、workspaceClipboardPastePlan 及相关 observation tests，使用可控 Promise 和真实焦点事件，覆盖 A1/A2/A3。`V-REPAIR-008-native`：补 `TC-IDE-C3-01-clipboard-session-across-splits-with-system-denial`、`TC-IDE-C3-02-native-clipboard-permission-and-multicaret`、`TC-IDE-C3-03-clipboard-observation-and-accessibility`；外部 OS clipboard owner 控制延迟或采用当前平台可复查流程，分别记录 OS 与编辑效果，覆盖 A1/A2/A3。仅快速成功粘贴不证明迟到结果隔离。

<a id="ed-repair-009"></a>
## ED-REPAIR-009 定位快照与正文身份同版本捕获

依赖：无。必需 evidence：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`performance`。

### 当前事实与复现

Host `throttledDocumentTextIdentity`（约 245 行）在 doc 已变化但不足一秒时返回旧 identity，`captureEditorViewState` 却捕获新 selection/folds。快速编辑再切文件/关闭重开，新位置带旧 hash，被 restore 拒绝。另一路 `W/workspaceLayoutPersistence.ts::enrichViewStatesWithIdentity`（约 87 行）把每份旧定位的 hash 改成当前 openFiles 正文身份。模型探针中原文 abc 的 caret=2 被原样保留，却补上 xyz 的 hash。inactive leaf 的旧定位因此可能通过更新后正文的门禁。

### 职责与实施合同

Owner：Host hash/cache/capture/applyPersistedEditorViewState/尾部报告；workspaceLayoutPersistence identity/enrich/normalize；Tab viewStatesRef 与持久化 effect；必要的 EditorGroup snapshot 传递及对应 tests。保留现有 store/schema 兼容策略，不新建竞争的 layout store，不清空用户全部布局。

内存快照必须将 immutable doc identity/revision 与 selection/folds/scroll 一起捕获。hash 若延迟，计算该快照持有的原 doc，只有对应 token 仍有效才发布；不能从当前 openFiles 拿任意新正文补 hash。未完成身份计算的快照不能冒充已证明版本，也不能写入新格式却删除 identity 来绕过 mismatch 检查。Text 身份不变可以缓存，Text 改变必须重新绑定；不按墙钟直接复用旧文档的 hash。

落盘前完成当前有效快照的身份和最终一次 capture；切文件/unmount/workspace 关闭的尾部上报必须携带原 leaf/file/workspace，不能污染新 owner。inactive view 的旧 snapshot 原身份保留，若正文改变则恢复时拒绝旧定位；若希望映射定位，必须有真实变更映射及新快照证明，不准仅改 hash。旧无 identity schema 按原 clamp 策略读，新捕获才升级。相同长度不同内容必须被区分，损坏数值 clamp/drop，不修改正文或 history。

恢复 caret、多光标、folds、scrollTop/scrollLeft 只执行一次对应快照；如实际布局迟到，需要在可滚动后恢复并检查期间无新用户操作。保持现有保留数量和共享 undo，不能每次按键全量 toString/hash，也不能通过删 snapshot、削减 undo/echo 或禁用尾部落盘取得性能改善。接受延迟/缓存优化的前提是上面版本一致性可证明。

### 验收与验证

- **ED-REPAIR-009-A1：** 一秒内编辑并切文件/关闭重开恢复最终 caret/selection/folds/横纵 scroll；两 leaf 各自位置独立，随后输入落在正确 caret；capture identity 与该份定位所属正文匹配。
- **ED-REPAIR-009-A2：** inactive leaf 旧 snapshot 遇到同长度不同正文不会被 persist 补签而通过恢复；legacy、损坏快照、workspace 切换、迟到 hash/布局和短间隔滚动停止均安全，最后一次状态落盘且不覆盖新用户操作。
- **ED-REPAIR-009-A3：** persistence/Host/Group/Tab 回归与 focused/typecheck/browser、当前 native 重启恢复通过；同环境 1MiB/5MiB 输入及 24-tab restore 性能满足原预算，保留 raw samples、active-ready/all-ready 与保留量，不能以删状态掩盖回归。

`V-REPAIR-009-unit/browser`：workspaceLayoutPersistence、CodeMirrorHost、EditorGroup、Tab tests；删除/改写原“把旧定位强行补签当前 hash 即正确”的断言，替换为 abc→xyz、同秒切换、inactive leaf 与尾部捕获的行为回归，而不是直接删测。覆盖 A1/A2/A3。`V-REPAIR-009-native`：补 `TC-IDE-IMPROVE-007-view-state-restore-native` 与 C4-01/C4-02 的快速切换、双 leaf、重启和真实横纵 scroll，覆盖 A1/A2。

`V-REPAIR-009-performance`：使用 `TC-IDE-C0-03-editor-typing-latency-large-doc-native`、`TC-IDE-C4-03-restore-active-ready-timing-native`，baseline 取领取基线（初始为本轮 HEAD），candidate 取实际修复源码；相同机器/runtime/fixture、warmup、样本数和百分位方法，分别报告每组 p50/p95、raw artifacts、输入预算、active-ready/all-ready、24-tab/undo/snapshot 保留量，覆盖 A3。WebDriver 断连保留原失败记录；某个 restore 通过不能覆盖 typing 仍失败，不能用不同用例刷新同一 evidence kind 的末项冒充全部通过。

<a id="ed-repair-010"></a>
## ED-REPAIR-010 修复轮最终源码回归与能力矩阵

依赖：ED-REPAIR-001..009。必需 evidence：`code-audit`、`unit`、`build`、`qa-lint`、`browser`、`native`、`provider`、`performance`、`accessibility`、`document`。

### 当前事实与目标

旧矩阵的全通过及本轮定向 235 项通过都未覆盖本轮九项反例。最终集成不能只把旧 ID 换成新 ID 或引用不同源码的历史测试。目标是在修复汇总后的同一产品源码上证明缺陷关闭、保留能力不回归，并明确平台/运行层上限；不在本卡顺手修新产品问题。

### 职责与实施合同

Owner：拟新增 `claudedocs/code-workspace-idea-2026-main-repair-capability-matrix.md`、拟新增 `qa-ui-auto-tests/scopes/main-repair-202609/`（实施前检查是否已存在）、本板 evidence 更新、最终测试/QA catalog/scope 验证。scope 按 qa-ui-auto 现有机制从各卡实际 cases 组成，不用失联副本降低覆盖。前九卡负责各自测试/QA 实现，本卡检查它们接入 final scope；不足时回到对应卡/记录阻断，不能用文档代替。

固定最终产品 commit/source 与 QA binary identity；文档-only 追加提交可以说明相同产品树，任何影响行为的后续变化都需重跑受影响验证。执行九项反例的 production unit/mounted 回归和当前端 native 负路径，重跑真实 sortMembers provider、受影响 IME accessibility 与输入/restore performance。每种 evidence 下的每个必需场景都要有最终结果，不能靠同 kind 最后一条 unrelated pass 隐藏失败；review 本卡时人工核对脚本不能覆盖的语义。

矩阵每个 AC 记录：问题/fixture → UI caller → owner/effect/recovery → exact test/case → source/build/receipt 或可复查手工记录 → OS/runtime → pass/fail/skip/unrun → 能力上限。分别列九项修复前反例与修复后结果、当前平台范围、Windows/macOS 后续步骤、IDEA/屏幕阅读器未运行、环境不稳定性及未解决问题。历史矩阵与 backlog 保留不覆盖。

最终保留能力清单：provider 标准 disabled request/resolve 拒绝、独立 LSP version 与真实 sortMembers 单次 undo、Cleanup unavailable、Windows 不先删旧文件的源码合同及当前端普通保存 smoke、UTF-16/EOL、精确排除子集、无 plan 和有 plan 的失败恢复、rename undo/恢复、IME 最终 flush 与普通输入分组、剪贴板 denied/unknown/fallback/X/Y/X、两 leaf/旧 schema/横纵滚动和输入/24-tab restore 保留量。未改 Rust 的当前 native smoke 不需要虚构本轮 Rust 结果；若前九卡修改了 Rust，本卡追加真实 Rust 集成检查。

### 验收与验证

- **ED-REPAIR-010-A1：** 最终源码 focused/unit/mounted 回归、全仓 `pnpm build`、QA testid catalog check 与 audit gate 通过，记录真实命令、counts 和测试筛选；九项反例均有具区分性的回归，不以旧 235 passed 或 helper-only 测试结案。
- **ED-REPAIR-010-A2：** 全部 30 个 AC 有 owner→tests→当前证据映射，最终 native/provider/performance/accessibility 覆盖各卡必需场景和保留能力；失败重试、部分恢复、竞态与正常流分别有证据，三端和能力上限明确。
- **ED-REPAIR-010-A3：** 明确非空 case/feature/current-platform scope 的 status gate 通过，summary/receipt/source/build 一致；手工原生项独立审阅，未执行/skip/失败/infra 问题如实保留，必需缺口阻止 done；新矩阵不改写旧卡历史。

`V-REPAIR-010-unit/browser`：在最终源码运行前九卡 named tests，包括 Tab/Host 的新负路径，不仅 `-t ED-MAIN`；覆盖 A1/A2。`V-REPAIR-010-build`：`pnpm build`，覆盖 A1。`V-REPAIR-010-qa` 的实施入口如下，scope 为本卡拟新增，必须实现后再执行：

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.gen_testid_catalog --check
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto audit --gate
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto status --cases qa-ui-auto-tests/scopes/main-repair-202609 --reports qa-ui-auto-report --platform Linux --gate
```

在非 Linux 实施时替换为真实当前平台，不混合平台统计。QA-lint 对应 A1/A3，status 只验证已有执行证据，不能代替实际 run。`V-REPAIR-010-runtime`：以本卡构建的完整 scope 重跑前九卡 native/provider/accessibility/performance，用实际支持的 runner 过滤或各端手工入口，分别记录所有必需场景，覆盖 A2/A3。`V-REPAIR-010-matrix`：人工核对所有 AC、生产 caller、完整 scope 和剩余缺口，覆盖 A2/A3；document kind 不能代替其他必需层。

## 设计交接状态

两份新文档定义待实施任务，没有产品修复已完成。初始依赖图允许 001、003、009 领取，实际以指定本板的 `list --claimable` 为准；依赖 done 后逐步开放其他任务。代码职责按任务板第 4 节交接，不假定可以并发修改同一 Host 或 apply loop。普通实现选择由执行者在上述合同内完成；发现实质契约矛盾时记录具体原因及 review_required，不默默降低验收。
