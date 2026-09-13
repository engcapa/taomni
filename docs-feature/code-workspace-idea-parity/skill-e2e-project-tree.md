# IDEA 对齐与 App QA skills：实跑验收与接续

2026-09-13，Windows。本轮目标是可供 coding agent 使用的高效、高质量 skills；Project tree 是端到端验证场景。主 agent 完成产品实跑，另有独立 agent 完成只读接续评估，收尾补跑非 IDEA 的 Welcome browser 场景。独立评估没有再次开发或执行产品 E2E，不据此声称所有 agent/平台均已验证。

入口链：`code-workspace-idea-parity` → `idea-reference` → `issue-design` / `code-workspace-idea-task` → `qa-ui-auto`，用 `skill-creator` 检查技能格式。

- 工作包：[ED-TREE-001](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md)。任务板命令必须带此完整路径；完成后不得重领。
- 契约：[项目树修复设计](../../docs-issue/project-tree-keyboard-idea-alignment-design.md)。
- 参照：[IDEA 2026.2.2 / IU-262.10315.125](references/project-tree-navigation-2026.2.2.md)。包含 fixture 字节、有效采样步骤和无效样本，不依赖聊天记录解释。
- 用例：[TC-IDE-TREE-01](../../qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml)。

## Skill 重构目标验收

本轮已完成所选范围的重构和实跑验证。保留 `qa-ui-auto` 一个通用 QA 入口与现有 runner，通过工具修复和精确选择减少重复工作；没有创建第二套冲突的通过体系。

| 目标 | 完成依据 |
|---|---|
| 可由后续 agent 接续 | 四个核心 skill 明确路由、当前任务定位和范围；独立评估找到 done 卡、契约及原始证据，未重领或扩大盘点 |
| 高效验证 | 精确 case plan、递归报告发现、构建输入校验；最小 browser 配置不携带 native/provider 前提；报告失效与二进制可复用分开判断 |
| 防止破坏既有能力 | 目标与保留行为联合验收、改前失败/正常路径、连续操作和 shell 接线；真实保存后刷新问题已修复并留回归 |
| UI 与交互可重构 | 不冻结当前 UI；参考包有版本/状态/输入/工件，分别判断视觉与交互，并明确本例 Enter 焦点等差异 |
| 修复落到设施 | launcher/退出码、native focus/verbs、fixture/schema/audit、报告发现/选择诊断均有持久修复及复验，见下表 |
| Skill 保持简洁 | 入口仅保留决策与按需路由；采样字段集中于 reference contract；实跑指南压缩为四步，过程记录只保留在本报告及原始工件中 |

独立评估原件：`qa-ui-auto-report/skill-refactor-review/forward-evaluation.md`（本机 ignored）。已确认并修复其发现的显式 case 选择文案、报告根目录搜索、browser-only 与 desktop 完成条件冲突、缺少最小 browser 配置。对 exact filter 前缀误选的怀疑经检查不成立，不作为已修复缺陷。未把其只读结果写成新的产品通过记录。

收尾还发现 status 对 stale 只返回空原因/路径，需手工翻报告。现返回历史报告路径和 `runner changed`、`source changed`、`case changed`、配置/构建来源差异；门禁仍失败，不把历史 pass 当当前 pass。两项定向回归先失败，修复后相关 Python 检查 **32 passed**。真实 Tree status 已返回 `runner changed`；QA build 仍 `reusable=true`，收尾新增 native 构建/运行均为 0。

通用 QA 实跑命令（先由本 checkout 启动 `pnpm dev --host 127.0.0.1`，headless、独立 browser context）：

```powershell
$env:PYTHONPATH = '.agents/skills/qa-ui-auto/scripts'
python -m unittest test_report_paths test_verification_selection test_verification_costs test_verification_workflow
python -m qa_ui_auto run --mode browser --filter TC-auto-F1-6 --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --report-dir qa-ui-auto-report/skill-refactor-review/welcome-runs --keep-runs 0 --require-pass
python -m qa_ui_auto status --case TC-auto-F1-6 --platform Windows --reports qa-ui-auto-report/skill-refactor-review --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --gate --json
```

首次 Welcome 运行 11.009s；status 诊断设施修改后复跑一次，最终 `run-20260913-110354-539877400` 为 **1 passed / 0 failed / 0 skipped，3.5s run / 2.92s case**，打开新会话编辑器并 Escape 关闭，截图确认返回欢迎页。两次冷暖条件不同，不宣称加速比。当前 runner 为 `9502ff7553efbaf796dffccfe69269a56269512b0265ac833066de6ee5b79e3f`。用例保留原 `needs-review` 标签，status 接受当前执行、仍因 review gap 返回 exit 1；这是通用 QA 设施验证，不是欢迎页完整功能覆盖认证。未创建会话、操作生产 profile 或注入全局鼠键，未验证锁屏 native/IDEA。

原产品任务完成时的 native pass 保留；后来报告工具变化使其当前 status 为 stale。因此本轮 skill 重构完成，不意味着当前 runner 又完成了 native 运行。下文的原产品结果、时间和身份均按实际采集时点解读。

收尾静态检查：四个 skill quick validation、46 个 Markdown 文件链接、QA audit gate、JSON 解析和 diff whitespace check 通过。Audit 的既有 coverage 缺口未扩大，也未作为本轮全产品盘点。自启 Vite 与 browser 已退出，未提交或推送改动。

## 产品验证结果与上限

目标是方向键选择/父子导航及选中视觉角色，并保护原有打开、分屏、右键菜单、重命名/删除取消、编辑保存和撤销。不是完整 Project view UI/action 对齐。

| 契约 | 生产路径与验证 |
|---|---|
| A1 只导航，不打开/切换 | `CodeWorkspaceTab.handleTreeKeyDown` → `navigateProjectTree` → `setSelected`；模块覆盖 tree/compact/flat/loose，shell 和 native 检查 tab/buffer 不变 |
| A2 按方向展开/进入/回父/折叠 | 可见 treeitem 的层级/选择状态 → `toggleRoot/toggleDir` → `loadDir` / workspace IPC；模块、shell、native 连续动作验证 |
| A3 保留动作与内容 | Enter/Ctrl+Enter → 原 `openFile` / split owner；右键/F2/Delete → 原 command runner 与 file actions；取消不写盘；单字符编辑 → save → 独立读盘 → Undo/save → 原始 SHA-256 |
| A4 语义与焦点 | `ProjectTree` selected/expanded/level；局部 CSS 的 focus-within/失焦背景；shell 检查 toolbar/filter 按键不被抢占，native 验证编辑器实际焦点并复核截图 |

导航不再以 `.click()` 代替选择。目录加载仍由原数据 owner 执行，代际守卫处理 reset/remove 后的迟到响应。打开失败、workspace edit/保存的取消、冲突和恢复沿原 owner，不另造副作用通道。

实跑还发现已有的保存后树刷新缺陷：watcher → `refreshTree` 清空所有缓存，仅重载 root，展开的 src/main 因而显示 Empty。该实现与 HEAD 相同；它阻断保存后继续树导航的本卡验收，因此修复 `useWorkspaceFileActions`，重载当前展开 root 下已展开目录，保留展开与选择、刷新合并及卸载清理。定向测试先红后绿，最终 native 保存后选中行和 split 均通过。

IDEA/应用原图人工复核：

| 比较 | 结论 |
|---|---|
| IDEA 09–13、30–31 与 native 01/02 | Right/Left/Down 的选择、展开与不打开行为符合本卡方向语义 |
| IDEA 31 与 native 02；IDEA 32 与 native 05 | 均区分树有焦点/编辑器有焦点的选择角色；Taomni 采用自身主题 token。不是像素、颜色或尺寸相等证明 |
| Enter 打开 | 都打开第二个文件；IDEA 自动移入编辑器，Taomni 此轮仍保留树焦点。native 05 是明确点击编辑器后的状态，不能冒充 Enter 自动转焦点 |
| 菜单/取消 | 菜单均可覆盖编辑区，Escape 后内容/选中保留；未声明菜单内容和排列全部相等 |
| 整体外观与鼠标 | Taomni 浅色、1280×800；IDEA 深色、1400×992 且 IDE UI scale 未核实，不能测像素差。Taomni 仍有独立 active-file 高亮、焦点轮廓、不同字号/间距/工具栏；目录单击切换、文件单击永久打开、Ctrl+Enter 分屏是保留契约 |

Home/End 为本卡导航补齐，未采样 IDEA 同键。Enter 自动转焦点、完整鼠标模型、全量 action、三端外观和屏幕阅读器另需明确工作包，本轮不把它们算作完成。

## 实际使用中修到 skill / 设施的问题

| 可重现触发 / 原因 | 持久修复 | 重新验证 |
|---|---|---|
| Windows scoped typecheck 无法启动 pnpm；丢弃退出码可能误报通过 | `typecheck_scope.py` 解析平台 launcher、保留退出码，拒绝无法分类/全局 TS 错误；导入日志要求 `--exit-code`，文档说明它不能认证来源 | 6 个行为测试；默认真实 `pnpm exec tsc -b --pretty false` 成功，owned/external 均 0 |
| native press selector 先 click，可能展开目录/打开文件；browser 只聚焦 | `NativeSession.focus` + native press，聚焦失败不发键；文档说明 DOM focus/W3C 非 OS 焦点证据 | 传输测试 + native 同一目录上的 selector-scoped Right 通过 |
| catalog 允许 assert_count/right_click/assert_menu_items，native 未实现，构建后才被拒绝 | 补 W3C button 2 右键、数量与可见菜单断言；rich 右键参数明确拒绝；补模式说明和构建前 dry-run 路由 | 参数/负向/输入释放测试；同一项目树用例实际执行全部操作 |
| 新 fixture 已注册但未加入 schema enum；audit 识别后再次 discover 抛 traceback | project_tree 同步 module + REGISTRY + schema；authoring 写清三处接线；audit lint 错误时停止后续 coverage/diff，返回错误与未评估状态 | 非法 fixture/坏 YAML 临时输入测试；实际 catalog audit 通过 |
| baseline 嵌套 worktree 被根 Vitest 意外发现 | `vitest.config.ts` 排除报告目录；文档指导大文件按名称选择、拆职责后保留 shell 回归 | 最终候选只选中主工作区 1 文件/5 测试；隔离 baseline 保留 |
| IDEA 共享桌面输入交错、文件名与实际选中对象不符 | capture 明确集中时段、每步目标与焦点核对、污染标记；参考包记录实际状态而非按文件名猜测 | 用户授权空闲后完成有效采样，关闭仅 fixture 窗口，保留 drawing |
| 泛化“做 E2E”文字没有促使工具改进 | QA 路由加入 `skill-e2e-evaluation.md`：触发→原因→md/工具修复→同场景重跑，并区分 agent 执行错误 | 本表、设施行为测试和实际失败/成功回执形成接续记录 |

另有用例假设需要明确：`seed_storage` 接受 JSON 文本，tree view 配置是原始字符串；隔离 profile 默认已是 tree，因此移除多余 seed。多字符 W3C 输入不保证单一 undo 单元，第一次 native 只撤销了末字符；本卡改用一个字符验证一次 undo 与精确字节恢复，不声称测过输入分组。`eval_readonly` schema 保守文本规则会误拒绝字符串内的 `=`，authoring 已说明局限，优先专用断言/短只读表达式，不绕过写入约束。

## 测试和构建成本

以下是实测记录，测试选择不同，不能解释为产品响应速度提升。

| 检查 | 结果 / 耗时 |
|---|---|
| 最初 FileTreePane/toolbar/shortcut baseline | 19 passed，约 1.47s |
| 一次过宽 shell + tree/toolbar 执行 | 188 passed，78.87s；不是后续默认范围 |
| HEAD 隔离 baseline + 新缺陷断言 | 2 target failed + 3 retained passed，6.51s；错误打开文件/重复 Right 折叠 |
| 最终 shell 名称选择 | 5 passed、175 未选择，7.79s；未选择不是环境 skip |
| ProjectTree + useWorkspaceFileActions | 12 passed，2.25s；新增刷新断言修复前 1 failed |
| QA Python 受影响设施 | 29 tests：22 passed、7 Linux 平台 skip，约 4.30s |
| scoped typecheck 设施 | 6 passed；默认真实 launcher 成功。先前也成功复用完整 native build 日志 |
| 第一次 QA 构建 | 156.469s，Rust 阶段约 2m04s；随后修 runner/YAML 无重编 |
| 第一次实际 native | 0 passed / 1 failed / 0 skipped；22.13s，含 SHA 失败等待约 10s；截图暴露树刷新缺陷 |
| 第二次 QA 构建 | 100.0s，Rust 阶段约 1m09s；因产品刷新修复而重编 |
| 最终实际 native | 1 passed / 0 failed / 0 skipped；run 14.215s，case 10.528s |
| 静态 audit / 当前 execution gate | 204 case、0 schema error、0 orphan、catalog fresh、coverage 无退化；所选 Windows case status gate 通过 |
| Skill quick validation | 4 个入口通过 |

共两次产品构建、两次实际 native、两次 dry-run；另有 unsupported-verb preflight 和 schema 拒绝，未启动应用。不把 dry-run 当执行通过。costs 保留两次实际尝试，合计 case 28.90s；相互重叠的 build/run/phase/step 不相加。最终 `native_build.py --check` 返回 reusable=true，没有再编译。随后又修改了 runner 的报告递归发现和 plan 文案；因此之前 native summary 的 runner identity 对当前工作区会变 stale，本轮没有在锁屏环境重新启动 native，必须由后续 agent 在需要当前 native 证据时复验。

## 证据身份与保留位置

HEAD：`7c38e41f4c84320e2ebc70a1b9d15133b943cc42`，验证针对含本轮未提交更改的工作区。最终 native 身份：

```text
source  f54cc2e897d252b4dbe66713b90df103957ec225702fd051f3cb41149d58cbed
runner  2ad7dc395df6024c457f3e17b87c6284eedbfa39db485dfb87febfca48aa79f3
case    b86fec80ed025e93dc58f46e39085d33ccff7612134a505425c3ac6ce39ee627
binary  22ff3c61608278a65850d1976040530ac12706b18b359d7c22ee9799ace5229b
config  3d8b9a60aff216587d19630887df15f57aeb8c7b80ca4527826ad39e6f1b68c3
```

环境：Windows 11，WebView2 152.0.4191.66，msedgedriver 152.0.4191.62；`com.taomni.app.qa`、Rust debug、打包 production React frontend。隔离 APPDATA/LOCALAPPDATA 和临时工作区。未自动操作用户生产 Taomni。运行结束后 QA/driver 已退出。

原始材料在本机被 git 忽略的 `qa-ui-auto-report/project-tree-e2e/`，不得当作已入库工件：

- `idea/`：仅参考包列出的有效 PNG/JSON 是比较证据。35 关闭后的桌面不是 IDEA 样本，不分享。
- `native-build.log`、`native-build-final.log`：两次完整构建输出。
- `runs/run-20260913-091538-331824800/`：失败 summary、receipt、截图、HTML 和原始 fixture。
- `runs/run-20260913-092411-263275000/`：最终 summary、匹配 receipt、native-isolation、6 张截图、恢复原始哈希后的 fixture；已通过 status 的来源/工件检查。
- `baseline/`：HEAD 隔离 worktree，仅应用新测试断言，供审阅改前失败；node_modules 为共享 junction。不要从根测试发现这个工作区，不修改主工作区来复造 baseline。

IDEA 全局鼠键有效集中采样为 08:31–08:36（Asia/Shanghai）；前置焦点/IME污染保留为诊断。fixture 窗口关闭后释放桌面。native 09:15/09:24 两批通过独立 WebDriver 会话输入，不证明物理 OS 输入或 IME。用户随后锁屏，本轮未以锁屏环境重跑，不声称已验证锁屏兼容性。

## 下一位 coding agent 的入口

可直接请求：“使用 `$qa-ui-auto`，按本报告复验 TC-IDE-TREE-01，先判断证据和 QA build 能否复用；发现 skill/设施问题直接修正并在同场景验证。不要重领已完成卡，不做全量 IDEA 盘点。”新对齐开发使用 `$code-workspace-idea-parity next`，由新请求决定下一工作包。

以下从仓库根运行，python 需有 pyyaml/jsonschema 等 harness 依赖，pnpm/Rust/驱动按 native-testing 安装。Windows config 只包含本轮差异；使用当前机器匹配的驱动路径，不固定复制本机版本号：

```yaml
app: {base_url: http://localhost:1980}
worker: {parallel: 1}
webdriver:
  host: 127.0.0.1
  port: 4444
  tauri_driver: tauri-driver
  native_driver: qa-ui-auto-report/native-tools-152/edgedriver/msedgedriver.exe
  startup_timeout: 30
report: {dir: qa-ui-auto-report/project-tree-e2e/runs, keep_runs: 0}
```

```powershell
$env:PYTHONPATH = '.agents/skills/qa-ui-auto/scripts'
pnpm exec vitest run src/components/editor/CodeWorkspaceTab.test.tsx -t 'ED-TREE-001|opens the selected tree file in a split|offers tree context menu actions|opens successive tree files' --maxWorkers=1
pnpm exec vitest run src/components/editor/workspace/ProjectTree.test.tsx src/components/editor/workspace/useWorkspaceFileActions.test.tsx --maxWorkers=1
python -m unittest test_native_assertions test_tauri_webdriver test_audit_errors
python -m unittest discover -s .agents/skills/code-workspace-idea-task/scripts -p test_typecheck_scope.py
python -m qa_ui_auto run --mode native --config qa-ui-auto-report/project-tree-e2e/config.yaml --filter TC-IDE-TREE-01-project-tree-keyboard-native --dry-run
python .agents/skills/qa-ui-auto/scripts/native_build.py --check
# 仅在 build needed 且本轮需要 native 时运行 native_build.py；不要手改 identity。
python -m qa_ui_auto run --mode native --config qa-ui-auto-report/project-tree-e2e/config.yaml --filter TC-IDE-TREE-01-project-tree-keyboard-native --require-pass
python -m qa_ui_auto status --case TC-IDE-TREE-01-project-tree-keyboard-native --platform Windows --reports qa-ui-auto-report/project-tree-e2e/runs --config qa-ui-auto-report/project-tree-e2e/config.yaml --gate
```

这些是按变化选用的命令，不是每次强制整套重跑。案例自建小型项目，无需 JDK/Java provider；native fixture 成功后保留，可验证四文件哈希后用于 IDEA 补采。其他机器应取得有效原图包或重新采样，不把此摘要升级为自己的实测。

大文件已作为 skill 的职责/回归判断信号：本轮抽出树导航模块和挂载测试，同时保留 shell 接线验证。CodeWorkspaceTab 约两万行、lsp.rs 约一万四千行，后续需按请求生命周期/传输/语言适配等 owner 渐进拆分；单纯搬文件不证明解耦或性能改进。本轮没有整体重构 LSP。

Linux/WebKitGTK、macOS/WKWebView、物理 OS 输入/IME、screen reader 和匹配环境的像素/性能基线未验证。原 Windows 产品交付在记录的身份上通过；当前 native 报告时效见开头，不声明其他平台或全 app 功能全部通过。
