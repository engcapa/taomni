# 当前 Taomni UI / 交互基线 — AUDIT-20260913-01

采集日期：2026-09-13，Asia/Shanghai。先打印 Taomni 空工作区及真实截图，再建立本轮对照。原始目录为仓库根下 `qa-ui-auto-report/overall-audit-20260913/`；以下相对链接直接指向本机原件。原图被 Git 忽略，交接到其他机器时需要复制该目录，不能只凭本文称已取得原件。

## 身份与执行边界

- 起始 `main` / `27f99b6116f4f6aae906d324cb84e8359695e17a`；工作区干净。产品版本 0.4.24。
- 当前源码 SHA-256：`41875a20d6c07cf619fdd537e425219aa7ae191d6a7d36ca5ecf6bd82c5f1f75`；完整身份、case 和原图 hashes 见 [provenance](../evidence/provenance-20260913.json)。
- Windows，HeadlessChrome 153.0.0.0，1400×992 CSS px，DPR 1；浏览器 locale zh-CN，应用英文；浅色 Follow system。UI 实测 Inter 12px / 18px；编辑器 CSS 字体栈 JetBrains Mono、Cascadia Mono 等，13px / 19.5px，未确认最终 fallback 字体。项目树行 27px，编辑器 tab 条 28px。均是当前观测值，不是 IDEA 设计 token。
- `pnpm dev --host 127.0.0.1` 从本 checkout 启动，URL `http://127.0.0.1:5000/`；`vite.config.ts` 启用 Tauri stubs；Vite development / React StrictMode。命令自动补齐 lockfile 所定依赖，包含 optional node-gyp 安装步骤；没有更改 package.json 或 lockfile，没有 Tauri/Cargo 产品构建。
- 专用 Playwright session `parity-audit-20260913`，无个人浏览器 profile。fixture 准备仅向该浏览器 VFS 写入四个种子文件；交互通过真实 click/key/fill，`observe.js` 仅观察 DOM，未通过 store/组件函数执行产品动作。
- 使用 CLI 自适应采样，非 YAML case 执行、非 native receipt；21 张原始浏览器截图。普通探索后，仅追加一次 Ctrl+F 异常复现和刷新稳定态观察，未扩大成产品测试套件。
- 本轮产品测试 0、YAML runner 0、native 构建 0、native 运行 0、正式 IDEA comparator 0。`native_build.py --check` 一次，exit 1 / `binary missing`。只读 status 一次，见证据失效条目。

## Fixture 与入口

F0 = [fixture catalog](fixture-catalog.md#f0) 的四文件项目；VFS 根 `/preview/fixture`。初始文件 UTF-8/LF、无 dirty、无 Git、无运行配置、无语义 provider。种子与已有 IDEA 参照逐文件相同。原始准备脚本 [seed.js](../../../qa-ui-auto-report/overall-audit-20260913/seed.js)；IDEA 隔离副本 [fixture](../../../qa-ui-auto-report/overall-audit-20260913/fixture)。

实际入口：Welcome → 左侧 Tools → Code workspace… → Add folder → 路径提示输入 `/preview/fixture` → OK → 点击 README.md。路径提示是 browser dialog stub，不代表 Windows 原生文件选择器。

## 打印的当前状态

![当前空工作区](../../../qa-ui-auto-report/overall-audit-20260913/browser/01-empty-workspace.png)

当前空工作区同时显示应用 Tools 侧栏、项目树区域、顶部工作区 toolbar、底部 13 个 tool tabs；References 默认展开，显示 Provider stale / generation 0。代码核对 `createDefaultCodeWorkspaceUi()` 的默认 `bottomDockOpen=true`、`bottomDockTab="references"` 与实拍一致。不能由这个默认空态推断真实 provider 故障。

![当前 Enter 打开文件后的树焦点](../../../qa-ui-auto-report/overall-audit-20260913/browser/05-example-enter.png)

Enter 后 example.txt 正文出现，README 与 example 两个编辑器 tab 存在；DOM activeElement 是 example.txt 的 treeitem button。当前 UI 同时呈现树的选择和编辑器当前行。与 IDEA 的 Enter 编辑焦点目标存在局部交互差异；视觉因主题/缩放/字体不匹配，仍不可比较。

## 逐状态记录

所有图像位于 `qa-ui-auto-report/overall-audit-20260913/browser/`。编号是本次 observation ID（Bxx），不是新增用户场景 ID。[actions.json](../../../qa-ui-auto-report/overall-audit-20260913/browser/actions.json) 逐条保存时间、实际参数和日志路径；日志含 Playwright 执行动作与对应 snapshot；`snapshots/` 保存可复查的 DOM 原件。三个 `*-observation.json` 保存实际焦点、选区、正文和几何信息。

| 观测 | 实际操作与关键结果 | 焦点 / 选区 / 异常 / 退出与恢复 | 原图 |
|---|---|---|---|
| B00 | 专用空 profile 打开 Welcome | 未打开项目、无编辑区；作为应用入口基线 | [00-welcome.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/00-welcome.png) |
| B01 | Tools → Code workspace… | 空树、No file open、References 展开；出现 Command is not available in this phase 状态文案，归因未完成 | [01-empty-workspace.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/01-empty-workspace.png) |
| B02 | Add folder / OK → README 单击 | 一个正式 tab，Markdown 源文本编辑态；Facts Failed 来自 browser build backend 缺席，不登记 Maven 产品缺陷 | [02-readme-open.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/02-readme-open.png) |
| B03 | 单击 docs（展开）→ Right | notes.txt 选中且有焦点，README 正文与 tab 保留；选择不等于打开。初始 docs 单击展开不同于旧 IDEA 单击只选中 | [03-child-selected.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/03-child-selected.png) |
| B04 | Left → Left → Down → Right → Right → Right → Down | 收起 docs、进入 src/main，example 被选择而 README 仍显示。完整动作日志可复核；未把 Home/End 推广为实测 | [04-example-selected.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/04-example-selected.png) |
| B05 | example 选中 → Enter | 两个 tab、正确正文；焦点仍是 treeitem；DOM 选区为空。未写磁盘 | [05-example-enter.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/05-example-enter.png) |
| B06 | 右键 example → 截图 → Escape | 菜单覆盖编辑区，含 Open/New/Rename/Delete/Cut/Copy/Paste 等；取消后未变更正文。取消后的返回焦点没有在同一步记录，待补，不能宣称已恢复 | [06-context-menu.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/06-context-menu.png) |
| B07 | 再单击 example → F2 → 截图 → Escape | Rename prompt 内整个 example.txt 选中；取消后正文与树仍在。前一次菜单取消后直接 F2 没有形成有效弹窗采样，保留动作日志，未归因为 bug | [07-rename-prompt.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/07-rename-prompt.png) |
| B08 | 点击编辑正文 → Ctrl+F | Find 获焦，Find/Replace 两行工具条出现；同时触发更新重入错误，见下节 | [08-editor-find.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/08-editor-find.png) |
| B09 | Find 输入 tree | 可见两个匹配高亮 / 2 matches；正文未编辑。随后 Escape 关闭查找栏；精确 caret 回到何处未记录，待补 | [09-find-results.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/09-find-results.png) |
| B10 | 点击 Split editor right | 左右两个 editor pane 显示 example；未采跨视图编辑、拖拽、关闭与 undo，不把分屏可见写成共享文档通过 | [10-split-right.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/10-split-right.png) |
| B11 | Tab policy settings → Cancel | 对话框可见 tab limit=30、放置/关闭策略与 preview 选项；取消未提交设置。未触发 eviction | [11-tab-policy.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/11-tab-policy.png) |
| B12 | Search bottom tab | Find in Files 输入/范围/替换区域可见；未执行项目查询或预览/提交，焦点归位、取消/错误待采 | [12-find-in-files.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/12-find-in-files.png) |
| B13 | Problems bottom tab | 空态，没有真实诊断 provider；错误跳转、筛选、Quick Fix 未验证 | [13-problems.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/13-problems.png) |
| B14 | Debug bottom tab | Debugger/Console/Breakpoints/Memory 入口，明确 browser 无 debug adapter，Start disabled；不是 native debug 能力缺失证据 | [14-debug-empty.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/14-debug-empty.png) |
| B15 | 两次 Shift | Search everywhere 浮层打开，输入获焦、模式和动作列表可见；输入 keymap 后有两个结果，选择 Keymap Settings | [15-search-everywhere.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/15-search-everywhere.png) |
| B16 | 选择 Keymap Settings → Escape | scheme 显示 IDEA defaults (default)，有 Copy / Rename / Reset / Delete 与动作绑定列表；只查看，未修改绑定，未验证 macOS keymap | [16-keymap-settings.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/16-keymap-settings.png) |
| B17 | Run bottom tab | 无 task/config，显示 backend unavailable 提示；没有启动进程 | [17-run-empty.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/17-run-empty.png) |
| B18 | 主分屏正文重新获焦 → Ctrl+F | 相同重入错误第二次出现；作用于新挂载分屏实例。此复现不等价生产 WebView 通过/失败 | [18-find-repro.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/18-find-repro.png) |
| B19 | Escape → page reload 后立即截屏 | 图中是加载过渡/空白；**不作为恢复完成证据** | [19-reload-restoration.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/19-reload-restoration.png) |
| B20 | 刷新完成后再观察 | Welcome，没有自动重新进入工作区；未操作 Restore last session / Recent workspace，不能据此判定数据丢失或 native 恢复缺陷 | [20-reload-settled.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/20-reload-settled.png) |

## 本轮确认的运行异常与边界

REQ-01 / CW-SEARCH-001 / CW-SHELL-002：B08 与 B18 两次记录
`Calls to EditorView.update are not allowed while an update is in progress`。

证据：[console.log](../../../qa-ui-auto-report/overall-audit-20260913/browser/console.log)，第一次原 console 行 21–31，第二次 33–43；[B18](../../../qa-ui-auto-report/overall-audit-20260913/browser/18-find-repro.png)。堆栈从 `WorkspaceSearchPanel.mount` 的 focus 到 `lspHyperlink` 的 `onBlur → clearMod → view.dispatch`。生产 [lspHyperlink.ts](../../../src/components/editor/workspace/lspHyperlink.ts) 的 clearMod 同步 dispatch；[editorSearchPanel.ts](../../../src/components/editor/workspace/editorSearchPanel.ts) 的 mount 同步 focus，调用关系支持复现机制。Vite 行号与 TS 源文件行号不同，按符号定位。

定性：确认当前 browser/renderer 路径有异常；查找栏和匹配高亮仍出现，尚无正文丢失证据。原生重现、插件是否持续失效、Esc caret 恢复和其他弹层影响列为待验证，不能将错误扩大为全部编辑功能不可用。本轮只登记修复需求，不改产品或测试。

## 当前基线缺失，及最小补采条件

**当前 Taomni native UI / 交互基线缺失。** 已安装生产 Taomni 的 binary 与本 HEAD 未绑定，未借用其个人状态；隔离 QA binary `src-tauri/target/qa-ui-auto/debug/taomni.exe` 不存在。后续需在明确授权构建的开发/验证轮准备同源 QA build；选择本矩阵受影响场景，不要求全套 QA。

未实际执行的正常/失败/取消/保存/撤销/恢复状态，逐场景见 [能力矩阵](../capability-matrix.md)。浏览器未采的可达状态也保留缺口，不能用组件结构补签；本次只做代表性探索，未逐项完成 45 个场景。补采操作使用 fixture catalog 与矩阵的明确动作序列；匹配原生项目、IDEA build、主题/缩放/字体/keymap 后才比较对应维度。

本轮只读 status 结果：历史 tree case `TC-IDE-TREE-01-project-tree-keyboard-native` 的 `run-20260913-092411-263275000/summary.json` 为 stale，原因 `runner changed; source changed; native build source changed`，`ok=false`，命令 exit 0 只说明 status 查询成功。旧原始通过/失败不改写；历史 IDEA 参照与 Taomni receipt 分别判断，不因 Taomni stale 自动废弃 IDEA。

收尾：专用浏览器会话已关闭；本轮启动的 IDEA fixture 窗口已请求正常关闭并确认进程退出；本轮 Vite 会话已停止，5000 端口无监听。fixture 与失败工件保留，不修改锁屏、个人配置或项目文件；没有提交或推送。
