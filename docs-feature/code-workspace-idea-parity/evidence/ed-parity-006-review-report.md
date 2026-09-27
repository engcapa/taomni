# ED-PARITY-006 Review 修复与最终自检

## 1. 身份与结论

- 唯一任务：[backlog.md](../backlog.md) / `ED-PARITY-006`，需求 `REQ-08` / 场景 `CW-SEARCH-002`。本轮开始时 metadata 已为 `done`、无 owner、依赖为空；按用户追加的 review 修复要求执行，没有重领、修改历史 owner 或另选任务。
- 基线与最终 HEAD：`f5d9c44474b9217c23d8c9a0268b449f1faf94af`，本轮修改保留在工作区，未提交、推送、合并、发布或委派。
- 两项上线阻断已关闭：Undo 确认框焦点/键盘管理；受确认语义影响的既有测试适配。最终 Linux native、browser、单测、typecheck 和静态门禁通过，按本轮授权范围重新核实 `done` 条件。以下是开发自检，不是独立 P3 验收。
- 原件根目录：`qa-ui-auto-report/ed-parity-006/`，不入库。下文报告目录均保留 `summary.json`、匹配 `runner_receipt.json` 及截图/主机观测；日志与 `.job.json` 保存执行命令。旧报告不替代本轮证据。

## 2. 实现与保留行为

生产链：结果行快捷键或 Actions Undo -> `CodeWorkspaceTab.requestWorkspaceUndoConfirmation` -> 独立 `UndoWorkspaceEditConfirmDialog` -> OK 调用既有 `undoWorkspaceEdit` -> 既有 history/preflight/IPC 写入整批恢复 -> 缓冲、磁盘、状态栏结果。Cancel/Escape 仅关闭确认框，不调用 history。

| 文件 | 本轮改动与结果 |
|---|---|
| `src/components/editor/workspace/UndoWorkspaceEditConfirmDialog.tsx` | 新独立组件，`aria-modal` 与可访问名称；同步聚焦 OK；Tab/Shift+Tab 在 OK/Cancel 循环；Enter 执行当前按钮，Escape 取消；阻止默认动作及冒泡，单次处理；卸载恢复仍连接的入口 |
| `src/components/editor/CodeWorkspaceTab.tsx` | 使用独立组件；记录打开 Actions 前的焦点，使 Actions 关闭后确认框可回到原结果行；移除异步 RAF 聚焦/回焦 |
| `CodeWorkspaceTab.test.tsx` | `confirmWorkspaceUndo()` 用于非编辑器调用；覆盖 code actions、comparison、Rename/refactor recovery、连续失败恢复、A.java/a.java；新增键盘循环、单次两文件恢复与 Cancel/Escape 零写入/回焦断言 |
| `CodeWorkspaceTab.fileTemplate.test.tsx` | 创建文件撤销确认 OK；写入失败无成功历史时断言不弹确认 |
| `TC-IDE-PARITY-006-01/02/03` | Exclude/Restore 通过实际 testid 操作，保留必需 controls；006-02 用真实连续按键断言焦点，不在发键前重设焦点；通用快捷键使用 Mod；006-03 引用 fixture 生成 SHA |
| `TC-IDE-D2-02`、`TC-IDE-AUDIT-003` | 等待事务可观察收尾再继续操作，保留字节/失败/历史断言；Mod 快捷键；两例全部字节 SHA 改为 fixture 值；大小写身份段明确要求 Linux 大小写敏感文件系统 |
| `fixtures/parity006_replace.py`、`fixtures/workspace_root.py` | 根据原 seed 和预期生成字节导出初始/提交/外部修改/dirty SHA-256；parity006 manifest 同步，不改变原始 fixture 字节 |
| `qa-ui-auto-tests/feature-list.md` | 增加新组件归属；required controls 属性不变，catalog 校验仍为 up to date，无需重生成 |

保留 Linux Actions Undo、结果单击后焦点留在结果列表、编辑器内 Ctrl+Z 的 claim 路径、Rename 撤销及 redo。未修改生产 `workspaceEditHistory.ts`、`replaceInFilesModel.ts`、`workspaceActionRegistry.ts`、替换/preflight/ledger 逻辑。scope/mask、冻结快照、迟到丢弃、实例/选择校验、真实 recovery id、UTF-16 坐标和大小写路径继续由原实现及回归证明。

## 3. AC / V 与最终证据

报告短名：

- **B**：[review-browser-verified/run-20260927-092109-201690714](../../../qa-ui-auto-report/ed-parity-006/review-browser-verified/run-20260927-092109-201690714/summary.json)，5/5，0 fail/0 skip，171.821 s。
- **N**：[review-native-verified/run-20260927-092449-358177511](../../../qa-ui-auto-report/ed-parity-006/review-native-verified/run-20260927-092449-358177511/summary.json)，3/3，0 fail/0 skip，104.119 s。

| AC / V | 实际检查与决定性断言 | 结果 / 原件 |
|---|---|---|
| A1 / V1、A3 / V6 unit | FindInFilesPanel、ReplacePreviewDialog、replaceInFilesModel、buildReplaceEdits、KeymapSettingsDialog 五套件；排除/冻结/修剪、summary/键盘/失败恢复、UTF-16、同行多处 freshness、keymap 保留 | 130/130，13.57 s；[review-v6-unit.log](../../../qa-ui-auto-report/ed-parity-006/review-v6-unit.log) |
| A3 / V2、V6 mounted | 27 个目标与消费者测试；Undo 焦点/回焦、Cancel/Escape 不写盘不消费历史、OK 一次恢复两文件、code action、comparison undo/redo、Rename/refactor 后续外部修改阻断、连续失败恢复与 A.java/a.java、fileTemplate | 27/27，195 非选中，82.96 s；[review-unit-final.log](../../../qa-ui-auto-report/ed-parity-006/review-unit-final.log) |
| A3 / V2、V6 mounted 保留 | 7 个补充测试；code action 非编辑器撤销、ED-REPAIR-002 全集 preflight/dirty/排除与部分失败、editor claim 的单条 history | 7/7，208 非选中，26.99 s；[review-unit-retained.log](../../../qa-ui-auto-report/ed-parity-006/review-unit-retained.log) |
| A1 / V3 | `TC-IDE-PARITY-006-01`：Delete、右键 Restore/Exclude、预览排除/2 of 3/summary、Esc/Cancel、Enter 提交、结果修剪 | B passed，24.221 s |
| A3 / V4 browser | `TC-IDE-PARITY-006-02`：默认 OK、双向 Tab 循环、Enter on Cancel、Escape、Actions Undo -> Enter on OK、返回结果行、输入 undo/redo 不触发 workspace undo、editor claim 不确认、Replace 入口聚焦 | B passed，32.882 s；连续按键之间无测试 `.focus()` 或 selector-directed press |
| A1/A3 / V4 native | `TC-IDE-PARITY-006-03`：真实搜索与 Tauri 写入、四文件 hash、输入撤销保护、Cancel/Escape 零写入、确认整批恢复、外部修改与 dirty 阻断/恢复、预览关闭/结果修剪 | N passed，94 步，28.414 s；browser 无法证明真实 ripgrep、主机字节、外部写入及 WebKitGTK |
| A3 / V6 browser | D2-01 预览排除/Cancel、D1-01 scope fail-closed、FINDFOCUS-01 本地 Find 与连续键盘流程 | B 各 passed，21.592 / 18.072 / 74.444 s |
| A3 / V6 native | D2-02 替换/确认撤销、UTF-16 坐标、A.java/a.java 独立字节恢复；AUDIT-003 真实权限写入失败、失败 ledger、无成功历史、保存恢复与 editor claim | N 中 D2-02 passed，85 步，46.984 s；AUDIT-003 passed，69 步，26.186 s；browser 无法证明主机大小写身份、权限故障与真实写盘 |
| A1/A3 / typecheck | 本轮四个 TS/TSX paths，复用最终 native build 成功 `tsc -b` 日志 | scoped/external errors 均 0；[review-typecheck.json](../../../qa-ui-auto-report/ed-parity-006/review-typecheck.json) |
| A2 / V5 | 当前 Taomni preview/final、Undo dialog/routing、native dirty/final 截图自检 | 文字/按钮/摘要可读、无本卡遮挡；用户免 IDEA 真机比较，IDEA matched 与 C1-C5 仍 unverified，未重签旧 comparison record |
| 静态/当前执行门禁 | `audit --gate`、`contracts --gate`、限定 8 ID 的 `status --gate --platform Linux` | audit 273 cases、0 error/orphan/gap、required 480/480；contracts 273/273、0 gap；status `ok=true, gaps=[]`；[audit](../../../qa-ui-auto-report/ed-parity-006/review-audit-verified.log)、[contracts](../../../qa-ui-auto-report/ed-parity-006/review-contracts-verified.log)、[status](../../../qa-ui-auto-report/ed-parity-006/review-status-verified.json) |

所有指定用例已实现并运行。Vitest 的 skipped 是名称过滤未选中，不是已通过或环境跳过；未完成的全量 mounted 扫描不计 PASS。当前门禁按每个 case 的最新匹配报告取值，旧失败批次原样保留在第 5 节。

## 4. 源码、构建与运行身份

当前平台：Ubuntu Linux x86_64，kernel `6.14.0-37-generic`，WebKitGTK `2.52.6`。native 使用独立 Xvfb `:98`（1280x832）、隔离 QA 数据目录与临时工作区；未操作个人桌面 `:0`、未自动解锁。测试结束已停止本轮 Xvfb。browser 为本 checkout 的 `http://127.0.0.1:5001`、Chromium 1440x900；保留现有 Vite。

| 身份 | 值 |
|---|---|
| source SHA-256 | `3c24a5c144f2b2f481945202e7285c8c86b9170aecdf57b79913eaf5bc752381` |
| runner SHA-256 | `af1bfc5dfcc8ec3521798f0ccb0c74366c1ba327f411e1ecc3a8a08468a9b6ee` |
| binary | `src-tauri/target/qa-ui-auto/debug/taomni`，`com.taomni.app.qa`，Rust debug / production renderer |
| binary SHA-256 | `0afb4417a41a830d7255dd35528ddc516b444a5c247ce47d927199d44f3a17a4` |
| browser conditions | `ca59652ab1178594fe9017bedf639d8aada89618a301aa8328048291b95f9fd8` |
| native conditions | `3d8b9a60aff216587d19630887df15f57aeb8c7b80ca4527826ad39e6f1b68c3` |
| config | `qa-ui-auto-report/ed-parity-006/current.config.yaml`，native 命令显式 `--mode native` |

最终 B/N 均 `identity_stable=true`，同 source/runner/binary（browser 无 binary）。每个 case 的完整 SHA 在 summary 中；三个最终 native case SHA 分别为：006-03 `ed40f3098459474336293f5cc20fa9437e9fd8dd01ccc11578783aeebffdfbbc`，D2-02 `88684eb0cb943453103b1b360a24fac14928f848bc627101b2ef1012914eb3e0`，AUDIT-003 `4f6c3b93039bb83a09601f7f3d8547a04b0cd08a226197ba804539dd2a6f2774`。

本轮仅一次 native 构建，297.034 s；随后四次执行（3 + 3 + 1 + 3 case attempts）共用该 binary，后三次没有重构建。`native_build.py --check` 最终 `reusable=true, inputs match`。完整构建身份副本：[review-native-build.identity.json](../../../qa-ui-auto-report/ed-parity-006/review-native-build.identity.json)；[构建日志](../../../qa-ui-auto-report/ed-parity-006/review-native-build.log)与[复用检查](../../../qa-ui-auto-report/ed-parity-006/review-native-reuse-check.json)。browser 共五次执行（1 + 5 + 4 + 5 + 5 case attempts），最后一批为当前完整证据；此前结果见下一节。

实际主要命令（长任务经 `background_job.py start --log ... -- <command>` 启动）：

```bash
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx src/components/editor/CodeWorkspaceTab.fileTemplate.test.tsx -t 'ED-PARITY-006|ED-REPAIR-004|ED-REPAIR-006|ED-AUDIT-014|records one comparison transaction|undoes an applied code action|supports undo to remove created Java file|reports resource write failure' --maxWorkers=1
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t 'requests code actions on Alt\+Enter and applies workspace edits|ED-REPAIR-002|registers exactly one success history entry|saves through write retry' --maxWorkers=1
pnpm exec vitest run src/components/editor/workspace/panels/FindInFilesPanel.test.tsx src/components/editor/workspace/panels/ReplacePreviewDialog.test.tsx src/components/editor/workspace/replaceInFilesModel.test.ts src/components/editor/workspace/buildReplaceEdits.test.ts src/components/editor/workspace/KeymapSettingsDialog.test.tsx --maxWorkers=1
python .agents/skills/qa-ui-auto/scripts/native_build.py
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --config qa-ui-auto-report/ed-parity-006/current.config.yaml --filter TC-IDE-PARITY-006-01,TC-IDE-PARITY-006-02,TC-IDE-D2-01-replace-preview-exclude-cancel-browser,TC-IDE-D1-01-find-scope-module-unresolved-browser,TC-IDE-FINDFOCUS-01 --workers 1 --report-dir qa-ui-auto-report/ed-parity-006/review-browser-verified --require-pass
DISPLAY=:98 PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --config qa-ui-auto-report/ed-parity-006/current.config.yaml --filter TC-IDE-PARITY-006-03,TC-IDE-D2-02-replace-commit-undo-native,TC-IDE-AUDIT-003-replace-conflict-ledger-native --report-dir qa-ui-auto-report/ed-parity-006/review-native-verified --require-pass
DISPLAY=:98 PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --config qa-ui-auto-report/ed-parity-006/current.config.yaml --filter TC-IDE-D2-02-replace-commit-undo-native --report-dir qa-ui-auto-report/ed-parity-006/review-d2-final --require-pass
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/CodeWorkspaceTab.tsx --path src/components/editor/workspace/UndoWorkspaceEditConfirmDialog.tsx --path src/components/editor/CodeWorkspaceTab.test.tsx --path src/components/editor/CodeWorkspaceTab.fileTemplate.test.tsx --from-file qa-ui-auto-report/ed-parity-006/review-native-build.log --exit-code 0 --json
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto audit --gate
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto contracts --gate
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto status --gate --platform Linux --case TC-IDE-PARITY-006-01 --case TC-IDE-PARITY-006-02 --case TC-IDE-PARITY-006-03 --case TC-IDE-D2-01-replace-preview-exclude-cancel-browser --case TC-IDE-D2-02-replace-commit-undo-native --case TC-IDE-D1-01-find-scope-module-unresolved-browser --case TC-IDE-FINDFOCUS-01 --case TC-IDE-AUDIT-003-replace-conflict-ledger-native --reports qa-ui-auto-report/ed-parity-006 --config qa-ui-auto-report/ed-parity-006/current.config.yaml --output qa-ui-auto-report/ed-parity-006/review-status-verified.json --json
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate
git diff --check
```

第二条 mounted 命令中的 `saves through write retry` 未匹配测试，不计覆盖；实际选中为其余三组的 7 项。full-file mounted 尝试停止后改用上述已审阅调用方集合，没有宣称整份大文件通过。

## 5. 失败、旧证据与归因

1. 改前按两个精确名称分别复现连续失败恢复后整批 Undo、A.java/a.java Undo 失败，均因新增确认未点击 OK，磁盘仍为提交内容。新增弹窗回归在 baseline 首先报缺少 `aria-modal`。三次失败及两次早期绿测的终端摘录保留在 [review-baseline-excerpts.txt](../../../qa-ui-auto-report/ed-parity-006/review-baseline-excerpts.txt)，明确不是 runner receipt。
2. `review-mounted-full.log` 是额外全文件扫描，约五分钟仍无完成结果，CPU/内存占用高，主动停止。不能作为通过或单项失败证据。其运行期间 `review-browser-final/run-20260927-084323-701545440` 有四例在 Welcome 等待阶段 15 s 超时（1 pass/4 fail），未进入目标交互。停止扫描并用单 worker 后，同断言/同超时的四例在 `review-browser-retry/run-20260927-084740-178167235` 通过；符合并发启动资源争用表现，未提高超时或删步骤。
3. `review-browser/run-20260927-084157-530053303` 初次 006-02 passed，36.170 s；上项失败批次 76.144 s，四例复跑 160.834 s。之后 fixture 导出 SHA 的变更更新 runner 身份，`review-browser-completion/run-20260927-090906-341005856` 五例通过，132.049 s；这些报告保留历史结果，当前证据由 B 的完整五例替代。
4. `review-native/run-20260927-085719-424077828` 为 1 pass/2 fail，79.042 s。006-03 通过；AUDIT-003 在 Undo 后树行 dblclick 遭 stale element；D2-02 在替换字节已变而弹窗未收尾时开始下一次 fill，被遮罩拦截。增加事务收尾断言后复跑，没有修改产品、字节期望或超时。
5. `review-native-final/run-20260927-090442-822574057` 中 AUDIT-003 与 006-03 通过，整批 2 pass/1 fail、91.657 s；D2-02 新加的状态栏 `Undid Replace in files` 等待失败，原文被 watcher 的 `File changed on disk` 覆盖。该同步检查改为确认框关闭，原始恢复 hash 断言保留；`review-d2-final/run-20260927-090727-644757044` 单项通过，50.839 s。失败原件和 case 身份原样保留。
6. 上项 D2-02 恢复 hash 的最长轮询为 12.587 s（原 30 s 预算内），旧原件同恢复阶段为 6.776 s；未采同机噪声样本，不声明性能改善或性能回归已排除。本轮只判用户结果及门禁。
7. 上次交付原件在本机已找到：`native/run-20260927-013238-810396421` 与 `native/run-20260927-013506-678365023`。它们绑定旧 source `26652d...` / binary `0608a9...`，仅供历史审查，不证明本轮弹窗修复。dry-run/无执行标记报告被最终 status 拒绝，未用于 PASS。
8. 最后静态核查发现 AUDIT-003 尚有两个固定 SHA（其中一个与 D2-02 重复），补为 workspace_root 生成字节的值，外部写入内容也引用同 fixture；006-02 的 native 边界说明同步改为当前平台。这改变了 runner/case 身份，随后完成 B/N 两个最终完整批次并重跑 audit/contracts/status，全部通过。没有改变产品源码或重构建 binary。

## 6. 三维自检与交付边界

| 维度 | 结论 |
|---|---|
| 功能 | 本卡主流程、保留消费者、外部修改/dirty 阻断、真实失败 ledger 与恢复均通过；确认适配后完整批次 undo、后续修改保护、editor claim/Rename/redo 有明确断言 |
| UI | 已读 B 的 preview/final/Undo dialog/routing 及 N 的 dirty/final 截图。browser 1440x900、native 截图 1280x800 内 Undo 小弹窗、OK/Cancel、2 of 3/summary、长错误及结果 notice 可读，无本卡内容重叠。未重新量字体/缩放，不签 IDEA 像素一致 |
| 交互 | 真实 browser 连续键盘验证默认 OK、正反循环、Enter/Cancel、Escape、Actions/结果入口回焦；native 验证真实 WebKitGTK 下替换/阻断/恢复与确认撤销；输入 undo 和编辑器 claim 路由保留 |

用户明确免 IDEA 真机比较，本轮没有 IDEA 双侧匹配结论；C1-C5 保持 unverified。dock 入口、冻结逐处 checkbox、提交/撤销直接落盘仍为已接受差异。Windows/WebView2、macOS/WKWebView 未验证；后续在同源码隔离 QA 构建运行 006-03 和适用的 D2-02/AUDIT-003 序列，大小写与权限 fault 必须具备相应文件系统条件，macOS 使用 Mod 映射且 direct Cargo 前 stage krb5。不能把当前 Linux PASS 外推到这两端。

P0 增量输入：`REQ-08 / CW-SEARCH-002` 在 F1-REPL-006、当前 Linux/WebKitGTK 范围内保持 G1-G5 已关闭；本轮追加的 Undo 焦点缺陷、调用方测试遗漏、required controls 静态缺口已关闭，依据为上表 A1-A3 / V1-V6 与当前 source/runner/binary 的 8 项 status gate。任务维持 `done`，不换算为 REQ-08 全能力或整体 IDEA matched。
