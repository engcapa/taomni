# Live Template 修复独立 Review 与复测报告

日期：2026-09-17。结论：**原始 Windows 交互缺陷已修复，但整体验收不通过，不能标记 All Done / All Pass。** 存在跨光标位置的去重缺陷、未满足的只读保护契约，以及不可运行/覆盖不足的新增 UI 用例。此次为 review 与复测，未修改产品实现及提交方测试；诊断脚本位于忽略目录。

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
