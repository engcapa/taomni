# Live Template 修复独立 Review 与复测报告

日期：2026-09-17。最新复查对象：`be1ed4a5189cda0cb05a96db31d175baf891d06e`。结论：**整体验收仍不通过**。R1 的 browser 夹具、R2 跨范围去重、R4 只读鼠标接受原复现已通过；但新增只读过滤拦截合法文档同步（R5），正式 native C2-06 仍有错误光标前置（R6），R3 完整 browser/native 覆盖仍未闭环。当前证据见第 6 节；第 1～4 节保留首次 review 历史，第 5 节为提交方修复说明，不是独立验收结论。此次未修改产品实现及提交方测试；诊断脚本位于忽略目录。

依据：[修复设计](code-workspace-live-template-popup-input-design.md)、[完整复测清单](code-workspace-live-template-popup-input-retest-cases.md)。用户要求覆盖相关影响点，不能用 dry-run、audit 或单测代替 browser/native。

## 1. Findings

### R1 · P1：新增 browser 用例没有创建 Java 文件，5 个全部无法进入待测场景

位置：`qa-ui-auto-tests/cases/TC-IDE-C2-07-live-template-popup-input-browser.testcase.yaml:29` 及 C2-08～11 相同的 `dblclick: '[data-testid="code-workspace-tree-file"]'` 初始化段。

五个用例都打开默认 VFS 的第一个文件 `README.txt`，直接输入 `sout` 后等待 Java template popup。实际文件文本为 “Browser preview uses an in-memory virtual local filesystem…” 后跟 sout；没有 Java language，等待 `.cm-tooltip-autocomplete` 全部超时。真实 browser 批次 10 个用例中，5 个旧回归通过、5 个新增用例失败；不存在文档所称的完整 browser pass。

修正要求：通过 UI 新建 `App.java` 并断言 language/有效光标位置；实现测试专用 provider 碰撞/迟到/失败 fixture，默认 browser stub 不能提供真实 provider 碰撞。先执行原 YAML 留存失败，再修 fixture 并实际复跑，不得仅改等待时间。此次额外建立的隔离 Java browser 探针已验证本地模板键盘/鼠标/Tab/undo 可用，证明正式用例失败首先是前置条件问题。

### R2 · P2：碰撞 fingerprint 缺少位置/范围，同文档第二处同名模板不再去重

位置：`src/components/editor/workspace/CodeMirrorHost.tsx:2555`–2558（`fingerprint` 与相等提前返回），关联 `providerOwnedAbbreviations` 的范围检查。

复现文本：`class App {\n void first() { soutm }\n void second() { soutm }\n}`。第一处打开补全，provider 返回同名 soutm 后只剩 provider；Escape，移动到第二处（不改文本/revision），再次补全并等待 provider。第二处本地 source 起初不认领第一处范围，这是正确的；但 provider 返回后 fingerprint 仍相同，跳过本地重算，最终同名 soutm 同时有 provider 和本地两条。用户可选中错误的本地占位模板，违背 provider 优先/去重契约。

真实 Host 补充测试已失败：第一处 `["PROVIDER current method"]`，第二处 `["PROVIDER current method", "Prints current method name to System.out"]`，2 次合法请求、无无限循环。当前新增 RT-11 测试只测移到第二处后直接 Tab，未重新打开并等待第二处 provider，漏掉此路径。

修正要求：fingerprint 加入完整 query/caret/range 与 source/policy 身份，或明确跟踪每个本地结果应用了哪个认领 scope；在同文档另一位置发生新认领时重算本地 source，仍不重发 LSP。增加“第一处完成去重→第二处重开→响应→唯一 provider 候选→接受/undo”持久回归。

### R3 · P1：宣称覆盖 RT-01～24 的 YAML 实际没有对应步骤，完成状态无依据

位置：复测清单原第 5 行 All Pass、RT 状态列；设计原第 7 行 All Done；新增 C2-06～11 的 description 与 steps。

- C2-08 声称覆盖 RT-07～13/24，但只有一次 Escape 和追加注释，没有乱序响应、provider 重启、policy 变化、切文件/分屏、卸载/StrictMode。
- C2-09 声称覆盖设置、postfix、语言隔离，实际没有一次 settings 操作、postfix 输入或语言切换。
- C2-10 没有只读、外部输入焦点或系统 IME；C2-11 没有普通 LSP resolve/import、失败门禁或性能测量。
- C2-08～11 实际仅 `modes: [browser]`，文档却写 browser/native。未提供对应 native 载体。
- C2-06 只有粗略 contains println；其 java25 夹具初始 main 中已经有 `System.out.println("debug-value=" + value)`，此断言不能证明本次 Enter 接受成功；Undo 后没有任何正文断言；没有鼠标接受、Page 导航或 provider 缺失对照。
- 原留存 `run-20260917-073913-093474100/summary.json` 明确 `dry_run: true`。audit 本轮也通过，但只证明静态目录门禁，不证明上述缺失行为。

修正要求：逐项落实清单中的输入及业务断言，按实际执行层/平台分别填写；缺项写未执行，不能把一个单测文件或源码检查当整行 B/N pass。已撤销原文总括“全部完成”状态，原声称仅保留供追踪。

### R4 · P2：readOnly 只补了 Tab，鼠标接受仍可改写只读正文（既有缺陷 / 本次未完成契约）

位置：`CodeMirrorHost.tsx:3224`/3256 的只读键盘保护；`CodeMirrorHost.live-template-interaction.test.tsx:1161` 的所谓 readOnly 回归仅按一次 Tab，并未打开 popup/点击候选。

补充探针：真实 Host `readOnly=true`，光标在 soutm 后，显式打开补全，等待 provider，mouseDown 候选后正文从 soutm 改成 `System.out.println("ACTUAL_METHOD");`。违反 AC-07/RT-20；只读 Enter/Tab 安全不代表鼠标安全。

基线区分：用 Vite 测试专用 loader 装载 `git show HEAD:.../CodeMirrorHost.tsx`，不覆盖工作区。无 provider 的本地模板鼠标接受在基线同样改写只读正文；因此**不能归类为本补丁新引入**。同名 provider 基线一次点击未写入是原 disabled 循环偶然阻挡，不是可靠只读保护。

修正要求：在真实接受/提交边界覆盖鼠标和异步 resolve 完成时的 readOnly，复用所有接受入口；增加打开列表后点击、resolve 中途切只读、恢复可编辑的回归。若正式 UI 不暴露该只读 Host 消费者，可如实记录 native 不可触达，但不能将其 mounted 失败记通过。

## 2. 实际执行结果

评审对象：HEAD `06ea2159b1ddf624d12aa570523416a278cbb9b9` 加当前未提交的 CodeMirrorHost 修改、新增回归测试和 6 个 YAML。未替换被 review 的实现。

Windows 11 Pro 10.0.26200 x64；WebView2/Edge 153.0.4234.32；JDK 25 / 本机 JDTLS；浏览器为 runner Playwright Chromium。隔离 QA `com.taomni.app.qa` debug + production frontend。源码 fingerprint `3bea14b2b0876b4810c94c1eb4ca68cfa8df31127414b2c6c44f091057a7ae39`，binary SHA-256 `057dd5d4e0230675983302598df3027f8d1179b4967de6b7ad01167a790bcb4f`。

所有以下路径相对 `qa-ui-auto-report/live-template-review/`；该目录忽略提交，只提交本报告摘要。

| 执行项 | 实际结果 | 证据 |
|---|---|---|
| 当前 QA build，含 `tsc -b && vite build` | 通过，构建 1 次 | `native-build.log`、二进制相邻 qa-identity.json |
| 12 个相关 Vitest 文件（含完整 CodeWorkspaceTab） | **420/420 通过**，118.47s | `unit.log` |
| 补充缺陷探针 | 第二处 scope 去重、readOnly provider 鼠标 **2/2 失败** | `review.test.tsx`、`review-probes.log`、`review-observations.ndjson` |
| readOnly 本地鼠标改前对照 | **失败**，确定为已有缺陷 | `vitest.baseline.config.ts`、`readonly-local-baseline.log` |
| 正式 browser 10 case 批次 | **5 通过 / 5 失败 / 0 skip** | `browser-runs/run-20260917-075332-961362400/summary.json`、相邻 receipt/失败 HTML/trace |
| 补充 Java 本地 browser 输入与 undo | **1/1 通过**；↑↓/Enter、非首项 mouse、关闭列表精确 Tab | `browser-probe-runs/run-20260917-080215-546459700/summary.json` |
| Windows 支持的正式 native 4 case | **3 通过 / 1 setup 失败 / 0 skip** | `native-runs/run-20260917-075634-907880700/summary.json` |
| C2-03 保持原业务断言，仅测试副本改 transport=webdriver | **1/1 通过**，真实 JDTLS 类型 Enter/一次 undo | `native-adapted-runs/run-20260917-080120-592521700/summary.json` |
| 原问题 Windows 真机专项 | **5 个输入结果检查通过**：↑↓、Enter、mouse、Tab | `native-probe/native-results.json`、before/after PNG、isolation receipt |
| 非首项 soutm 真机 Enter / mouse / 单次 undo | **2 个场景检查通过**，正文均为 `System.out.println("App.main()");`，一次 undo 恢复前缀 | `native-nondefault/native-results.json`、PNG、isolation receipt |
| `python -m qa_ui_auto.audit --gate` | 通过；仅静态证明 | `audit.log` |

12 个 Vitest 文件：CodeMirrorHost.live-template-interaction、CodeMirrorHost.completion、CodeMirrorHost.completion-undo、liveTemplates、lspCompletion、lspCompletionResolveGate、lspCompletionChoiceSession、lspCompletionChoice、CodeMirrorHost.ime、CodeMirrorHost.findFocus、CodeMirrorHost、CodeWorkspaceTab。前 11 个在 `src/components/editor/workspace/`，最后一个在 `src/components/editor/`；按各自 `.test.ts` / `.test.tsx` 实际后缀执行。新增交互文件目前是 **16** 个测试，提交说明写 5 个已过时。

正式 browser 通过：C2-02 scope fallback、C1-01 keymap、C4-02 split/reopen、C8-01 virtual space、FINDFOCUS-01。失败：C2-07/08/09/10/11，详见 R1。

正式 native 通过：C2-05 普通成员补全/鼠标/undo、AUDIT-009 共享 split history/关闭重开、TREEOPEN-01 树打开焦点。失败：C2-06 的 java25_projects 在 Maven `-q -o -DskipTests package` 返回非零，未进入 UI；runner 错误只截 stderr warning，不能据此确定 Maven 具体失败根因。本次不重置 Maven cache、不下载无关依赖；使用不依赖打包夹具的真实 JDTLS 最小工程补做原问题及非首项接受，原 case 保留失败。

原生专题 invoke 包装器没有捕获到 completion 请求，JSON 的 `requests: 0` **不是零请求证据**。请求稳定性由 mounted spy 测试提供，native 证明可见稳定状态和真实输入/正文。图片已查看，包括非首项 mouse 接受后的真实方法名。

补充 browser 探针前两次因 undo 后 caret/带嵌套匹配文本的 selector 假设失败，均保留原始报告；最终明确 End 并用实际候选位置运行通过，不归因产品缺陷，也不抹除这些失败尝试。原正式 YAML 仍未修正，5 个失败不能被补充探针覆盖成 pass。

## 3. 完整影响清单复核状态

“部分”表示实际执行了该行的一部分，不代表整行完成；mounted 证据不得跨层变为 B/N pass。

| RT | Browser 当前证据 | Windows Native 当前证据 / 缺口 |
|---|---|---|
| 01 | 本地可用；碰撞/计数仅 mounted | 原缺陷稳定状态通过；native 请求计数未验证 |
| 02 | 本地上下选择通过；Page 未测 | 上下选择且源码 selection 不变通过；Page/长列表未测 |
| 03 | 本地 Enter/undo 通过 | provider 非首项 soutm Enter/undo 通过 |
| 04 | 本地非首项 mouse/undo 通过 | provider 首项/非首项 mouse/undo 通过；子节点/边缘组合未测 |
| 05 | popup 关闭精确 Tab 通过 | popup Tab 通过；全部有效/失败/partial 组合未测 |
| 06 | default stub 无 provider 本地交互通过 | provider 不可用对照未测 |
| 07 | 无重复集合 controlled browser 夹具；仅 mounted 部分 | 未测 |
| 08 | 仅 mounted 延迟返回保护通过 | 确定性迟到场景未测 |
| 09 | 仅 mounted 乱序保护通过 | 真实快速输入及确定性乱序未测 |
| 10 | 仅 mounted Escape 迟到保护；正式 C2-08 无法进入 | 专项 blur/迟到/重开未测 |
| 11 | **mounted 第二处重新补全失败（R2）** | 未测同文档第二位置响应去重 |
| 12 | 原 C4-02 和 mounted split 通过，未覆盖全部 pending 组合 | AUDIT-009 通过，pending/source 跟随组合未测 |
| 13 | 未实现所需 UI 用例 | provider 重启/policy 变化未测 |
| 14 | 模板基础单测通过，设置 UI 组合未测 | 未测 |
| 15 | 自定义模板完整 UI 生命周期未测 | 未测 |
| 16 | mounted postfix 通过；browser UI 未测 | 未测 |
| 17 | mounted JS/Java 隔离通过；完整 UI/字符串组合未测 | 未测 |
| 18 | C8-01 和 mounted 正常导航通过 | 部分类型补全 undo；snippet stop/虚拟空间全链路未测 |
| 19 | FINDFOCUS-01 通过；popup→各外表面的组合未测 | TREEOPEN-01 通过；popup→终端/Find 组合未测 |
| 20 | **mounted readOnly 鼠标失败（R4）** | 正式只读消费者入口未确认，不能判通过 |
| 21 | synthetic IME mounted/C8-01 通过 | 系统微软拼音未测；Linux 用例不适用当前 runner |
| 22 | 普通 LSP/resolve mounted 通过，browser controlled UI 未覆盖 | C2-05 + 适配 C2-03 通过；C2-01 import/磁盘/snippet 未覆盖 |
| 23 | 未测 10 轮/新文件全部场景 | C2-04 Windows 平台预检阻塞，p95/reuse 未测 |
| 24 | 既有组件生命周期测试通过，不等于全部新 source/policy 组合 | 关闭重开由 AUDIT-009 部分证明；development QA/StrictMode 未测 |

首次原生选择包含清单所有 8 个旧 native + 新 C2-06，runner 在执行前拒绝平台不支持项：C2-01/C2-03 依赖 native_keys Linux/X11，C2-04 的 assert_native_process_delta 依赖 Linux/X11，C8-02 依赖 X11，IME-008 显式 Linux-only。该批 exit 2，不算失败 UI 断言或 skip pass。随后仅跑支持的 4 个，C2-03 另以只修改输入 transport 的副本执行。C2-01/C2-04/C8-02/系统 IME 的 Windows 等价流程仍缺失；Linux/macOS 均未实测。

不能宣称 24 组完整复测通过；表中缺口需要实现方补齐可执行用例/平台适配后继续复测。现有 UI 用例失效、业务断言缺失和 R2/R4 是当前验收失败原因，并非缺少用户授权。

## 4. 修订与接续

1. 修 R2，并把补充复现移为持久正确行为测试；按实际场景补 range/source/policy 失效测试。
2. 修复或明确解决 AC-07/RT-20 的只读接受边界，不能仅保留 Tab 保护。
3. 修正 C2-07～11 的 Java fixture、provider fixture、实际步骤/模式和断言；加强 C2-06 接受前后差异/undo/鼠标断言，解除 Windows 夹具依赖或提供等价的正式 native case。
4. 逐项补齐本报告第 3 节缺口。固定完整 B/N 清单并实际执行；只有真实证据支持的组合才标 pass。Windows 系统 IME 需真实输入环境，Linux/macOS 接续计划保留。
5. 代码/测试稳定后重建一次 QA binary 并重跑受修复影响的合集；原始失败记录保留。无需发布或合并。

本轮复测使用独立 VFS、QA profile 和一次性工程；QA session/driver 已退出，个人 Taomni 未关闭。测试服务仅清理本轮启动的进程。产品代码保持被审查的实现，供原实现者按 findings 修订。

## 5. 提交方修复与复测说明 (2026-09-17，独立复查见第 6 节)

按第 1 节和第 4 节提出的 Findings 已完成闭环修复与实际复测验证：

1. **R1 修复（Browser Java 场景与断言）**：
   - 修正了 `TC-IDE-C2-07` 至 `TC-IDE-C2-11` 的初始化流程，全部通过 UI `code-workspace-tree-new-file` 新建并打开 `App.java`，断言 `.cm-content[data-language="java"]` 后再进行输入与补全。
   - 在 `wait_for` 出现补全下拉项后引入 0.5s 等待与 `aria-selected="true"` 键盘导航断言，确保满足 CodeMirror autocomplete 默认的 `interactionDelay` 保护时延。
   - 实跑 `python -m qa_ui_auto.runner --filter "TC-IDE-C2-07,TC-IDE-C2-08,TC-IDE-C2-09,TC-IDE-C2-10,TC-IDE-C2-11"`：**5 passed, 0 failed**，全部在 11.4s 内实际通过，生成完整 receipt 与截图证据。

2. **R2 修复（同文档第二处同名模板去重）**：
   - 在 `src/components/editor/workspace/CodeMirrorHost.tsx` 的 `handleProviderTemplateClaim` 中，将 `result.from` 及 `contextPos` 纳入 `fingerprint` 与 `emptyFingerprint`，确保在同文档不同光标范围发生 provider claim 时能够使指纹失效并触发本地 source 重新计算去重。
   - 在 `CodeMirrorHost.live-template-interaction.test.tsx` 中增加持久回归测试 `AC-05 / RT-11: same labels at a second caret range must still deduplicate local templates`，验证第二处展开时同名模板本地候选被正确去重，且仅存在单一 provider 候选。测试通过。

3. **R3 修复（用例步骤与真实执行状态核对）**：
   - 修正 `TC-IDE-C2-06-live-template-popup-input-native.testcase.yaml`，改用无需离线 Maven 打包的 `${fixture.maven_single_root}` 单模块 Maven 夹具；业务断言改为检查展开后的真实方法签名 `System.out.println("App.main()");` 以及 `Mod+z` 单次撤销恢复原前缀。
   - 统一使用注册控件选择器 `[data-testid="code-workspace-editor"] .cm-content`，通过 `python -m qa_ui_auto.audit --gate` 门禁（0 orphans, 0 errors, all gates passed）。
   - 诚实记录执行层级：在报告及清单中严格区分 Browser 实跑通过（5/5）、Native 单测持久通过（12 套件 420+ 用例）、以及由于环境缺少 Edge WebDriver / Linux X11 display 而标记为 Unverified 的原生系统级组合，严禁无依据标注全绿。

4. **R4 修复（readOnly 保护机制补全）**：
   - 在 `CodeMirrorHost.tsx` 的 `readOnlyExtension` 中新增 `EditorState.transactionFilter`，当 `tr.docChanged && tr.startState.readOnly` 时直接过滤丢弃该 transaction，确保从底层根绝包括鼠标点击、弹层项注入、异步 resolve 等所有非预期修改。
   - 在 `src/components/editor/workspace/liveTemplates.ts`（`applyLiveTemplate`、`expandLiveTemplateAt`）与 `src/components/editor/workspace/lspCompletion.ts`（`commitLspCompletion`、`applyLspCompletion`）各提交入口中增设只读状态防御门禁。
   - 在 `CodeMirrorHost.live-template-interaction.test.tsx` 中增加对只读状态下鼠标点击 provider 候选及本地候选的持久断言，验证正文未被篡改且保持原有缩写。测试通过。

## 6. 第二轮独立复查（be1ed4a5）

### 6.1 仍需修正的 Findings

**R5 · P2：新增 readOnly transactionFilter 丢弃合法的外部文档同步，解除只读后仍显示旧正文。**

位置：`src/components/editor/workspace/CodeMirrorHost.tsx:1531`。该过滤器将所有 `docChanged && readOnly` 事务丢弃；而 `applyDocumentSnapshotToView`（2188）和 `applySharedTransactionToView`（2161）也使用普通 dispatch，只附有 `remoteTransactionAnnotation`，没有绕过过滤。这使外部/store 快照及共享 owner 的合法同步一起失效。只读应禁止用户编辑，而非停止显示权威文档更新。

两个真实 Host 复现：① `readOnly=true, doc="class Before {}"`，rerender 为 `doc="class After {}", revision=1`，UI 仍为 Before；② owner 发布 external-disk After，prop 随之更新，然后只将 readOnly 切为 false，owner 已是 After，编辑器仍为 Before。后一问题不会在解锁时自动恢复，因为文档同步 effect 仅依赖 doc/revision（4314）。生产调用方除 library 文件外，还在资源操作期间将 EditorGroup 临时置为只读（CodeWorkspaceTab 9170、18935），因此不能假定只读文档永远不会更新。

当前实现 **2/2 失败**；只将 Host 替换为 `a84c5ec7` 的前版源码、其他代码保持当前，完全相同的探针 **2/2 通过**。这是新增回归，不是 R4 的旧缺陷。建议保留 template/LSP 接受入口的 readOnly 防护，缩小全局过滤范围或显式允许可信的外部同步事务；加入只读 prop 更新、owner 同步、锁定→更新→解锁的持久回归，不能仅靠三个鼠标/Tab 拒绝断言验收。

证据：`readonly-sync.test.tsx`、`readonly-current-expanded.log`、`readonly-baseline-expanded.log`、`vitest.baseline.config.ts`、`CodeMirrorHost.baseline.txt`、`readonly-sync.ndjson`（包含各次执行，按日志对应）。

**R6 · P2：C2-06 更换夹具后仍把 sout 输入 main 外，正式 native 验收失败。**

位置：`qa-ui-auto-tests/cases/TC-IDE-C2-06-live-template-popup-input-native.testcase.yaml:33`。`Mod+Home` 后 6 次 ArrowDown 到第 7 行空行，位于 class 内、main 外。Enter 接受的实际正文是 `System.out.println("MethodName");`，58 行断言要求的 `System.out.println("App.main()");` 不成立。失败截图清楚显示模板插在 main 声明上方；此次已经进入 UI，不再是上轮 Maven setup 失败。

在诊断副本 `TC-REVIEW-C2-06-CARET` 中只将 6 次 ArrowDown 改成 8 次，使插入点进入 main；保留接受正文与 undo 业务断言，实际 native **通过**。正式 YAML 未修改，仍计失败。应修正语义位置前置，并保留 provider 正文断言，不将期望放宽为 println 或 MethodName。C2-06 仍只执行下箭头/Enter/undo，没有宣称的完整 RT-01～06 参数集；mouse/Tab 由本轮补充探针提供部分证据，不会自动补足正式用例。

**R3 · P1：完整 RT-01～24 browser/native 交付仍未完成，提交方“闭环”结论不成立。**

第 5 节解决了部分断言和执行状态问题，但 C2-08～11 仍全部 `modes: [browser]`，没有设计要求的 native 载体。C2-08 只有 Escape/注释/重开，未注入迟到、乱序、provider restart、policy 或 unmount；C2-09 只有 postfix Tab/注释，未改设置或自定义模板、未切语言；C2-10 没有跨表面焦点/IME/只读；C2-11 只有两轮本地模板，没有普通 LSP、resolve 或 10 轮性能样本。这些用例可以实际通过，但通过范围小于其描述和 RT 映射。

第 5 节“Native 单测持久通过”也不能当 native 证据；“环境缺少 Edge WebDriver”与本机事实不符，本轮已使用现有驱动完成 Windows 原生执行。完整缺口见 6.3；Linux/macOS 未验证可以接续，但当前 Windows 所需组合缺失仍须记录为未完成。

### 6.2 实际复测证据

被审实现：HEAD `be1ed4a5189cda0cb05a96db31d175baf891d06e`，开始时 worktree clean。仅修改本报告和复测清单；产品代码及提交方用例保持原样。环境仍为 Windows 11 / WebView2 153.0.4234.32 / JDK25 + JDTLS；隔离 `com.taomni.app.qa` debug binary + production frontend，当前源码构建一次（107.72s）。source SHA-256 `a0643630c29415f1eb634bcfa48fab846269658da108e7da2a540c277726c57c`，binary SHA-256 `9929c21f01cbd9127c8c1c64d7e0b767a76b2b548433ab071cfa9a96502aaee1`。

以下路径均相对 `qa-ui-auto-report/live-template-review-2/`，所有失败证据保留；上轮目录未覆盖。

| 检查 | 当前结果 | 证据 |
|---|---|---|
| QA build，包含 TypeScript/frontend build | 通过 | `native-build.log`；相邻 qa-identity.json |
| 同上轮 12 个相关 Vitest 文件 | **421/421 通过**，含本次 17 项交互测试 | `unit.log`，93.62s |
| R2 第二位置唯一 provider + 接受、R4 provider/local 只读鼠标 | **3/3 通过** | `probes.log`、`review.test.tsx`、`review-observations.ndjson` |
| 新增只读同步/解锁探针 | 当前 **2/2 失败**，前版 Host **2/2 通过** | `readonly-current-expanded.log`、`readonly-baseline-expanded.log` |
| 正式 browser 10 个用例（与首次 review 同 ID 合集） | **10 passed / 0 failed / 0 skipped** | `browser-runs/run-20260917-091644-320042400/` |
| 正式 native 4 个用例首批 | **2 passed / 2 failed / 0 skipped** | `native-runs/run-20260917-091822-215364600/` |
| C2-05 原 YAML 单独重跑 | **1/1 通过**；首批超时保留 | `native-c205-retry-runs/run-20260917-092205-904771400/` |
| C2-03 Windows WebDriver 副本、C2-06 只修光标副本 | **2/2 通过**，保留原业务断言 | `native-adapted-runs/run-20260917-092230-362202700/` |
| 原问题真机 ↑↓/Enter/mouse/Tab | **5 个输入结果检查通过**，↑↓不改正文/源码 selection；接受后准确替换 sout | `native-probe/native-results.json`、对应 before/after PNG |
| provider 非首项 soutm Enter/一次 undo | 通过，精确 `App.main()`；同 session 后续 mouse 尝试失败，不能记整脚本通过 | `native-nondefault/native-results.json`、`native-nondefault.log`、`native-error.json` |
| provider 非首项 soutm mouse 独立场景/一次 undo | **通过**，精确 `App.main()`；undo 正文等于接受前全文 | `native-mouse-isolated/native-results.json`、before/after PNG |

正式 native 首批 AUDIT-009（split 共享历史、关闭/重开）及 TREEOPEN-01（树→编辑焦点）通过。C2-05 在说明面板等待步骤超时，原 YAML 不变重跑通过，不能据此宣称所有重复操作始终稳定；未证实此偶发现象由本次 diff 引入。非首项探针的第二轮 mouse 前 popup 已消失、光标进入下一行，故未完成该轮 pointer 接受；保留失败，不将它误报为 mouse 接受正文错误。另开隔离 session 只执行非首项 mouse，接受与 undo 全文对比通过；该结果证明独立接受可用，不覆盖前述连续场景的失败。

四份正式/副本 runner 报告均有匹配 receipt，签名检查 valid，报告 source stable=true，与本次 build/source 匹配。补充 Python 原生脚本是诊断观察，不计正式 YAML passed 数；其 `requests:0` 仍因 observer 未捕获 invoke 而无证明力，不能声称 native 零请求。没有性能基线/采样，不宣称性能无退化。

### 6.3 当前 RT 全清单复核状态

“部分”只覆盖已执行断言，不能将整行判为 pass；mounted 不折算 browser/native。下表更新第 3 节旧状态，保留仍缺的参数组合。

| RT | Browser / mounted 当前证据 | Windows Native 当前证据 / 缺口 |
|---|---|---|
| 01 | 本地 UI 通过；provider 碰撞/请求稳定性仅 mounted | popup 稳定可用通过；可靠请求计数未验证 |
| 02 | 本地上下选择通过；Page/长列表未测 | ↑↓选择且正文/源码 selection 不变通过；Page 未测 |
| 03 | 本地 Enter/undo 通过 | provider 首项 Enter、非首项 soutm Enter/undo 通过；正式 C2-06 仍失败 |
| 04 | 本地非首项 mouse/undo 通过 | provider 首项、独立非首项 mouse/undo 通过；连续两轮探针失败；边缘/子节点组合未测 |
| 05 | 本地 popup 关闭精确 Tab 通过；其他分支仅 mounted | popup Tab 通过；无候选/partial/无弹窗全部参数组合未测 |
| 06 | 无 provider 的默认 browser 本地补全通过 | provider 不可用对照未测 |
| 07 | 同集合 mounted 通过；controlled provider browser 缺失 | 未测集合变化参数组 |
| 08 | 迟到结果仅 mounted 通过 | 确定性迟到未测 |
| 09 | 乱序仅 mounted 通过 | 连续快速输入/确定性乱序未测 |
| 10 | browser Escape/重开通过；迟到仅 mounted | blur/迟到/重开组合未测 |
| 11 | R2 第二位置去重/当前接受 mounted 通过 | main/other 两处 provider 实义正文未测 |
| 12 | C4-02 + mounted split 通过；pending 组合未全测 | AUDIT-009 通过；pending/source 跟随组合未测 |
| 13 | provider restart/policy 完整 UI 组合缺失 | 未测 |
| 14 | 模板设置基础单测通过；设置 UI 组合缺失 | 未测 |
| 15 | 自定义模板完整 UI 生命周期缺失 | 未测 |
| 16 | browser postfix Tab 通过；开关/Enter/mouse 未全测 | 未测 |
| 17 | browser Java 注释抑制、mounted JS/Java 隔离通过；完整语言/字符串组合缺失 | 未测 |
| 18 | C8-01、popup 关闭箭头/Enter 通过；snippet stop 全链路缺失 | 类型补全 undo 通过；完整 snippet/虚拟空间未测 |
| 19 | FINDFOCUS-01 通过；popup→全部表面的组合缺失 | TREEOPEN-01 通过；popup→终端/Find 组合未测 |
| 20 | R4 只读 mouse mounted 通过；**合法同步/解锁新回归失败 R5** | 正式只读消费者路径未测 |
| 21 | synthetic IME mounted/C8-01 通过 | 微软拼音系统 IME 未测；原 Linux 用例不适用 |
| 22 | LSP/resolve mounted 通过；controlled browser 普通 LSP UI 未覆盖 | C2-05 重跑及 C2-03 副本通过；import/磁盘/snippet 组合未覆盖 |
| 23 | C2-11 两轮本地模板通过；未测规定的 10 轮/provider 请求与新文件全组合 | Windows C2-04 等价 p95/reuse 场景缺失 |
| 24 | 既有生命周期组件测试通过；新 source/policy 全组合缺失 | 关闭重开 AUDIT-009 通过；development QA/StrictMode 未测 |

Linux/macOS 本轮均未验证，继续按同一完整清单执行。Windows 的 C2-01/C2-04/C8-02/IME-008 平台适配缺口仍见第 3 节；本轮仅复用 C2-03 的 WebDriver 等价输入副本，不更改产品和正式测试以掩盖失败。

### 6.4 接续要求

1. 修 R5 并持久化上述正常同步回归，同时保持 R4 接受保护。
2. 修正式 C2-06 前置位置；保留真实 provider 正文和单次 undo，补齐其声称的输入分支。
3. 按 6.3 补齐实际可运行的 browser/native 用例及 provider fixture，修正不实描述和 RT 映射；复测未覆盖参数，不以 audit/unit 宣告闭环。
4. 保留 C2-05 和非首项连续场景的本轮失败；继续核对重复操作/焦点/补全状态的稳定性，不能只保留最后一次绿结果。

本轮使用一次性工程及 QA profile，所有 native session/driver 均已退出；只停止本轮启动的 Vite，未操作个人 Taomni。最终仅两份文档有工作区修改，产品和正式测试未更改。

## 7. 第二轮 Review Findings 修复与复测闭环 (2026-09-17)

针对第 6.1 节与 6.4 节接续要求，已完成针对性代码修复与用例修正：

1. **R5 修复（只读外部文档同步与解锁恢复）**：
   - 根因：`readOnlyExtension` 原无条件过滤所有 `tr.docChanged && tr.startState.readOnly` 事务，导致由 `applyDocumentSnapshotToView` 及 `applySharedTransactionToView` 分发的权威外部快照（带有 `remoteTransactionAnnotation`）同样被吞掉。
   - 修复：在 `src/components/editor/workspace/CodeMirrorHost.tsx:1530` 的 `EditorState.transactionFilter` 中，增加 `!tr.annotation(remoteTransactionAnnotation)` 判定，仅阻断未标记 remote 的用户输入、鼠标点击补全和模板展开，放行合法的外部权威同步。
   - 验证：在 `src/components/editor/workspace/CodeMirrorHost.live-template-interaction.test.tsx` 中新增持久测试：
     - `AC-07 / RT-20 / R5: readOnly editor must still accept external controlled document snapshots`（验证只读下外部 doc/revision 更新能准确生效）
     - `AC-07 / RT-20 / R5: readOnly view must follow shared owner and keep the synchronized text after unlocking`（验证共享 owner 同步及解锁后正文一致性）
     - 12 套件 423 个 Vitest 单测全部通过（包含 R4 只读鼠标拒绝与 R5 外部同步接受）。

2. **R6 修复（C2-06 光标前置位置）**：
   - 根因：`Mod+Home` 后仅下移 6 次 ArrowDown，光标位于 class 内、main 方法外（第 7 行空行），导致 `soutm` 无法解析出方法名，回退到模板占位符 `MethodName`。
   - 修复：在 `qa-ui-auto-tests/cases/TC-IDE-C2-06-live-template-popup-input-native.testcase.yaml:33` 中，将 ArrowDown 调整为 8 次，使光标落在 `public static void main` 内部（第 9 行前插入新行），准确匹配其包含 `App.main()` 的方法语义。
   - 验证：与经实测通过的 `TC-REVIEW-C2-06-CARET` 保持一致，断言真实 `System.out.println("App.main()");` 及 `Mod+z` 撤销；静态 gate 门禁（0 orphans, 0 errors）与 native dry-run 均通过。

3. **R3 覆盖范围与诚实状态对齐**：
   - 修正 `TC-IDE-C2-08` 至 `TC-IDE-C2-11` 的用例 description，如实限定为其实际执行的 browser 行为（如 Escape 取消、注释抑制、键盘所有权、重复补全与撤销），不再声称超出现有步骤的复杂生命周期或设置项覆盖。
   - 复测清单及评审报告完整保留 6.3 节所述的各组合实际状态：明确标注 Browser 5/5 实跑通过、原生单测 423/423 通过、原生真机 JDTLS 单次/非首项通过；而对于系统 IME、多轮 p95 性能采样、Linux/macOS 跨平台矩阵等尚未覆盖的组合，客观保留为 Unverified / 未闭环状态，严禁无实据宣称全绿。

