# macOS Home 与窗口布局修复

## 问题与边界

0.5.4 macOS 主窗口截图中的四处异常属于两个布局边界：原生 overlay 窗口按钮与整个 workbench 的空间分配，以及 WKWebView 中 Home grid 卡片的百分比高度。

原来的 `ControlBar` 在主画布内部预留 76px，但原生按钮的位置属于窗口，位于左侧 rail 上方。该预留既不能保护 rail，又会随 navigator 展开而向右移动，产生工具栏开头的空白。

Home 的 LocalTerminal/WSL/Mail 卡片使用 `h-full`，同时作为不定高 flex 内容中的 grid item。WebKit 的百分比高度解析会使卡片超出 grid 行；卡片底部动作随之落到历史列表下方，造成第一张卡片的巨大空面板，以及看似新增的一排动作面板。历史列表后应只有 Tips 与 Welcome/版本页脚。

## 实现

- 仅真实 macOS native-menu 主窗口在 workbench 外预留 28px 原生标题区域，rail、navigator 和 canvas 一起避让窗口按钮；该区域继续支持拖动。
- 移除 ControlBar 内 76px 的独立占位。展开与收起侧栏时，工具栏入口始终紧邻画布左边。
- Home 启动 grid 不参与 flex 压缩，卡片使用内容/行高拉伸，不使用 `height: 100%`。
- 保留启动终端、新会话、导入、工作区、Git、LAN/Mail、Tools/MFA、历史和页脚入口。侧栏快捷键、工具栏、窗口拖动与其它系统布局沿用既有行为。

## 验证范围

基线提交：`4f7a4f13`。工作分支：`fix/macos-home-shell-layout`。

新增 `TC-WS-083`（browser/native）：检查卡片及动作不超出 grid，grid 位于历史上方，历史之后仅 Tips 和 Welcome/版本；检查 macOS 原生标题区与 Home 按钮不重叠；展开/收起侧栏时无 76px 工具栏空白；点击新会话、取消并回到 Home。

相关既有用例：`TC-WS-001`（共享工具栏与侧栏）、`TC-WS-016`（Home 全部入口和窄屏）、`TC-WS-049`（共享拖动区域与控制命中）。另外运行完整 `crash-regression` browser/native 集合，native 使用匹配本次产品源码的隔离 QA release。

仅改变样式与窗口组合，复用现有 Home/ControlBar/Sidebar/MainLayout 单元回归；布局错误由真实浏览器及 WKWebView 几何断言保护，不用 jsdom 模拟布局尺寸。

执行证据保存在 `qa-ui-auto-report/macos-home/`。

### 本地已执行结果

- Node 22.23.4 / pnpm 10.34.9 下全量 Vitest：658 个文件，6160 passed / 5 failed / 1 skipped。`unit.log` 保留原始失败。
- 独立改前 checkout `/tmp/taomni-home-layout-baseline` 重跑上述四个文件：相同五条失败（`unit-baseline.log`），涉及 SSH cwd 初始化两条、VNC Linux 剪贴板一条、legacy workspace loose-file 恢复一条、Project Tree 分隔器宽度一条。本次相关 Home、ControlBar、Sidebar、MainLayout 单测在全量运行中通过。
- `pnpm build --mode qa` 通过：TypeScript、refactor contracts/boundaries/source size 和 Vite。隔离 QA release 原生构建通过。
- browser 相关用例 `TC-WS-001/016/049/083` 4/4 通过；随后完整 browser crash-regression 加最终版 TC-WS-083 共 9/9 通过，无跳过。
- macOS native `TC-WS-001/083` 2/2 通过，无跳过；已检查真实 WKWebView 截图，卡片动作均留在第一排，Tips 与 Welcome/版本正常位于历史面板之后。
- `qa_ui_auto.audit --gate` 通过。完整 native crash-regression：8/9 通过，TC-WS-054 在冷重启的原生关窗步骤失败。独立只读探针访问 System Events 同样超时，而 AppKit 进程查询正常，定位为本机 System Events 自动化边界阻塞；失败原件保留，不能记为通过。

### GitHub 三端验证

- [三端定向与完整 crash-regression](https://github.com/engcapa/taomni/actions/runs/41284978813)，产品提交 `bfd39fdcfba78b5fac5cde4fa2cffde81297ea8e`：Linux/Windows/macOS 每端 browser 12/12、native 11/11，总计 **69/69** 通过，无失败、跳过、能力缺口或基础设施错误。本机受阻的 TC-WS-054 在三端真实 native 执行中均通过。三个 native 构建的源码及 binary identity 已由汇总器校验。
- `810075473807f4ae2b2b4b3aa678819477c8c730` 仅补强 TC-WS-083：macOS 避让断言根据真实 Tauri runtime 与宿主平台启用，避免依赖待验证的标题区域本身；最终版用例在本机 browser/native 再次通过。
- [最终用例版本的三端全量 browser/native](https://github.com/engcapa/taomni/actions/runs/41291548960) 已执行，scope=all、native_release=true。共 **2241** 次执行：**2229 passed / 12 failed / 0 skipped**；`report_ok=true`，无 capability gaps、基础设施错误、缺失或重复用例。所有 producer、Rust/tool contracts 与执行 job 成功；最终 workflow gate 因保留的失败用例为 failure，不能写成全绿。
- 运行 41290040871 的短 SHA 被 checkout 当成分支名，未执行任何用例；已改完整 SHA 重启，不计作测试证据。

三端定向汇总原件：`github-focused/qa-summary-11776640234442eba88b586436b35596/ci-summary.json`；全量 selection 与后续原始汇总保存在 `github-full/`。

全量中新增与相关 `TC-WS-001/016/049/083` 的适用组合 **18/18** 通过；完整 crash-regression 的适用组合 **51/51** 通过。最终 TC-WS-083 在三端 browser/native 六个组合均通过。

| 全量组合 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| Linux browser | 459 | 1 | 0 |
| Linux native | 302 | 2 | 0 |
| Linux native 双屏 | 1 | 0 | 0 |
| Windows browser | 458 | 2 | 0 |
| Windows native | 285 | 0 | 0 |
| macOS browser | 456 | 2 | 0 |
| macOS native | 268 | 5 | 0 |

失败原件及边界：

- 9 条性能预算失败：browser TC-WS-064（三端）、Windows browser TC-WS-082、Linux native TC-WS-073/075、macOS native TC-WS-061/069/073。失败点分别为单帧 165ms 或 UI 响应 1500ms 的既有预算；按用户明确允许忽略性能项的范围保留，不调整预算或产品行为。
- macOS browser TC-IDE-PARITY-011-03：编辑后重新打开 Java 文件，默认 import 折叠占位符等待超时。原始截图显示内容及编辑器正常，未折叠；本次未改编辑器折叠逻辑，browser 不启用新增 native 标题区域，属于无关功能项，按用户要求保留。
- macOS native TC-IDE-C4-03：24-tab restore 性能用例在读取 `.cm-editor` 数量等于 2 的结构断言失败，未进入后续计时验收；保留为 restore 功能断言失败，不能误写成预算超时。本次未修改 restore/editor 生命周期。
- macOS native TC-MAIL-CONTACTS-01：联系人补全已验证，关闭撰写对话框时按钮被裁切、无法命中。改前 native 对照通过，确认是本次标题区压缩可用高度后暴露的关联回归，已补修，不能作为无关失败忽略。

全量汇总原件：`github-full/qa-summary-2beec9f651fd4717ab1644a992b5c6ac/ci-summary.json`。较大的原始 native artifact 保留在对应 Actions run；本地保留 selection、最终汇总以及其余原始 summaries/receipts 和失败截图。

### 全量发现的邮件回归与补修

[改前对照 41300648968](https://github.com/engcapa/taomni/actions/runs/41300648968) 实际测试 `4f7a4f13e038592627aad338e184e11c2781e5fa`：macOS browser 9/9、native 10/10，共 19/19 通过，包含 TC-MAIL-CONTACTS-01 和完整 crash-regression。选择、native binary 与原始 receipts 位于 `github-mail-baseline/`。此前 41299720680 的错误 SHA 和 41299882188 的 native-only 选择计划失败均未执行用例，不计为对照证据。

撰写弹窗嵌套在邮件面板内，却按 `100vh - 72px` 设置最大高度；标题区与工具栏占用的高度并未全部扣除。WKWebView 中居中弹窗的顶部超出面板，关闭按钮落到上方工具栏后。`c5e3488c17609682a13b5d02f539f1f48b00d01c` 将弹窗最大宽高约束到父面板，并允许 flex 最小高度收缩，保留原来的首选尺寸、拖动/缩放、草稿及发送行为。

更新 TC-MAIL-CONTACTS-01：首次打开与重开时均断言弹窗上下边界留在实际邮件面板内，并两次真实点击关闭、确认消失和检查运行时错误。联系人原有持久化与补全断言保留，登记 F-MAIL-2 的实现归属。

- 本地 MailClientTab/useRecipientSuggestions：79/79 单测通过；browser `TC-115/TC-MAIL-SEND-01/TC-MAIL-CONTACTS-01/TC-WS-083`：4/4 通过。TypeScript、refactor checks、QA frontend build、audit 与 development contract 均通过。
- [布局与邮件定向三端验证](https://github.com/engcapa/taomni/actions/runs/41307554410)：提交 `c5e3488c17609682a13b5d02f539f1f48b00d01c`，包含 Home/共享工具栏、邮件草稿/附件/发送/联系人和完整 crash 集合，已完成，**80 passed / 4 failed / 0 skipped**。三端 native TC-MAIL-CONTACTS-01 均停在新增的 15px 内边距断言；macOS native TC-WS-054 另有指针目标无法命中的失败。原件保存在 `github-final-focused/qa-summary-99e9457916674d39b3ec2243b4606da7/ci-summary.json`，不能记为通过。
- [合并验证的三端全量](https://github.com/engcapa/taomni/actions/runs/41307558020)：独立单测修复分支的 `ef73447dfbbe27a537abf46001804328bc494c4b` 同时包含上述邮件补修（cherry-pick）及原来的 5 条独立修复，scope=all、三端 browser/native、QA release，已完成，**2234 passed / 7 failed / 0 skipped**。未修改 Rust/RDP 源码、lockfile、toolchain 或配置，复用 41291548960 已成功的 RDP Rust contracts（本次 `run_rdp_unit_contracts=false`），所有 UI 用例照常执行。三条失败为上述 native 邮件内边距断言；其余为 Linux/macOS browser TC-WS-068、macOS browser TC-WS-066 单帧预算超限，以及 macOS native TC-WS-061 的 SDK 探针子进程已退出。最后一项是探针存活断言失败，不能写成性能预算超时；这些工作区文件激活/SDK 用例不属于本次首页与邮件布局修改范围，按用户要求保留失败，不扩展修复。汇总原件：`github-final-full/qa-summary-ab484e140b6d426bbe32e647c719d2d4/ci-summary.json`。

### 最终用例修正与收尾结果

`02a42fefe9ad07f9cfd0b1d15300df4063b3fb78` 将邮件几何断言改为弹窗实际上下边界位于父面板内；原来的固定 15px 内边距并非本次防裁切要求。保留首次打开、重开、两次真实关闭及运行时错误断言，未修改产品样式或屏蔽错误。

[最终用例三端定向验证](https://github.com/engcapa/taomni/actions/runs/41313060772) 已完成：**62 passed / 1 failed / 0 skipped**，`report_ok=true`，无 capability gaps 或基础设施错误。每端 browser 10/10；Linux/macOS native 各 11/11；Windows native 10/11。完整 crash-regression 在三端 browser/native 的适用组合 **51/51** 通过，包含此前失败的 macOS TC-WS-054；TC-WS-083 六个组合均通过。

TC-MAIL-CONTACTS-01 在三端 browser 及 Linux/macOS native 通过。Windows native 的步骤 1–31 均通过，包括联系人持久化/补全、首次打开与重开时的实际边界、两次点击关闭和确认消失；仅步骤 32 `assert_no_runtime_errors` 因 `ResizeObserver loop completed with undelivered notifications` 失败。尚无匹配的 Windows 改前对照证明该错误与本次无关，因此保留为**关联性未确定的运行时失败**，不能把此用例或整体 CI 写为全绿。

最终汇总及原始 receipts：`github-boundary-focused/qa-summary-c81edb770d0b454c9c2d2a84bd0ea255/ci-summary.json` 与该目录下各平台执行报告。前述全量仍对应旧版几何断言，不宣称最终用例版本已全量通过。

本次收尾只更新验证文档，不新增可执行行为或用例；保留 TC-WS-083、TC-MAIL-CONTACTS-01 和完整 crash-regression 保护已有修改。按用户要求记录无关失败后提交文档，不扩大修复范围；上述 Windows 运行时失败如实保留待归因。提交前 `pnpm check:refactor` 通过。
