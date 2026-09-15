# REF-FIND-FOCUS-20260914：F0 文件内查找与返回

本包只为 REQ-01 / CW-SEARCH-001、CW-SHELL-002 提供参照。CW-NAV-002 modifier-hover、CW-TAB-002 多 view 是受影响保留消费者。不是产品比较通过记录；旧 REF-TREE-2026-09-13 只用于到达 F0 文件的树子动作。

## 身份、原件与有效范围

- IDEA Ultimate 2026.2.2，`IU-262.10315.125`；安装 `D:/Software/idea-2026.2.2.win`。product-info.json 与 P0 hash 相同（`e4cb8371ae3c12fd117b89beb05ae707e739c2fce474ffd95eb67a9c6febd426`）；本次进程 PID 27816 的实际路径为该安装的 `bin/idea64.exe`。没有采 About，不用进程标题替代安装身份。
- Windows / 英文 / New UI；真实 Win32 鼠键，Python ctypes、pywin32、PyAutoGUI。输入前检查 Default input desktop、准确 HWND/PID/foreground；每步保存 before/after，非 Java DOM 注入。用户明确提供约 5 分钟独占时段，有效序列 2026-09-14 06:37:27–06:41:33（Asia/Shanghai）。未发现该序列内的非脚本鼠标移动。
- 主窗口 HWND 593850；屏幕 rect `(260,20)-(1660,1012)`，窗口原图 1400×992 px；Win32 client 1384×984，DPI 96。设置对话框 HWND 2101248 / 同 PID，原图 1350×1032。**1400×992 外框不能当成 1400×992 CSS 客户区。**
- 原始目录：[20260914](../../../qa-ui-auto-report/idea-reference/find-focus/20260914/)；完整 [manifest.json](../../../qa-ui-auto-report/idea-reference/find-focus/20260914/manifest.json) 列文件 hash、有效/诊断/不转交分类。
- 可转交原件：[reference-transfer.zip](../../../qa-ui-auto-report/idea-reference/find-focus/20260914/reference-transfer.zip)，SHA-256 `fa328fa968648123d8aa3da67858bf7ab7208e690f8ff0177f9ed9f52444f5cb`。在其他机器须从本机复制此 zip，解压到同相对目录并按 manifest 核验；没有原件则 A2/A3 的 IDEA 输入缺失，不继承 matched。
- 00–11：独占授权前发现非脚本鼠标位移，整段仅诊断，不用于定目标。20 将正文重置到 1:1；21/22 的旧查询残留来自此前被污染段，不当作干净初始 query 证据。23–26 的显式 tree 查询和 27–33 的受控重跑有效。
- 34–37 设置初始/过渡页含与本任务无关个人设置，**禁止转交**；本机原件保留，zip 排除。38/40/44/51 才是已审阅的相关设置原图。裁剪与 review-sheet 是派生审阅物，不是原图，不放入转交包。

## 设置与 fixture

| 项目 | 已核实来源与值 | 边界 |
|---|---|---|
| 主题 | 40-appearance.png：Islands Dark，editor scheme Dark，Sync with OS 未勾选 | 不是 P0 Taomni 的浅色环境 |
| UI scale/font | 40：Zoom 100%；Use custom font 开启，Microsoft YaHei UI，18 | 原始像素值按该环境解释；不强制产品全局改为个人字体 |
| 代码字体 | 38 显示当前字体由 scheme 覆盖；51-color-font.png：JetBrains Mono 18.0，line height 1.2，fallback None，ligatures 关闭 | 字体设置值不等于 CSS 18px×1.2；原图行基线距离约 31px |
| Keymap | 44-keymap-tree.png：Windows-zhyhang，Based on Windows keymap；keymap-excerpt.json 记录配置 hash/parent `$default`，本场景 Find/Next/Previous/Replace/Escape 没有自定义覆盖 | 有效绑定另由真实 Ctrl+F/Enter/Shift+Enter/Esc 序列证明；46 搜索页面未展开到绑定，不冒充 binding UI 证据 |
| Project 鼠标设置 | 未核实 | 本包明确正文获焦前置，树不是验收动作；不关闭 REQ-02，也不依赖鼠标设置冻结 Find |
| SDK/provider | F0 是 UTF-8/LF 纯文本，没有语言 provider 前置，无须项目 SDK | 不证明 modifier-hover 语义；其保留验证另用真实 provider fixture |
| F0 | `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py::SEED_FILES` 四文件；本机 `qa-ui-auto-report/overall-audit-20260913/fixture` | 四文件 hash 见 [P1 provenance](../evidence/find-focus-plan-20260914.json) 与 [F0 catalog](fixture-catalog.md#f0)，不含 `.idea` 和元节点 |

example 正文为 `Project tree example\nThe editor buffer should survive tree navigation.\n`，71 UTF-8 字节。两个 `tree` 的零基 UTF-16 范围 `[8,12)`、`[53,57)`。起始无 dirty，20/27 正文 caret 1:1、无选区；全程没有正文编辑，结束四文件 hash 与种子相同。

## 实际动作与结果

每个编号均对应上述原始目录中的同名 `.png` / `.json`；JSON 记录实际键值/坐标、时间、foreground、window/client rect、DPI、鼠标位置。Caret/selection 来自正文高亮、状态栏行列/字符数与后续按键效果观察，未声称读到 Java 内部 selection API。

| 步骤 | 实际输入 | 观察 / 焦点 / selection |
|---|---|---|
| 20-reset | Ctrl+Home（正文已打开且获焦） | 正文 caret 1:1、无选择；Find 关闭 |
| 21/22 | Ctrl+F；Ctrl+A | Find 输入获焦、旧 query 全选；旧 query 内容不用于目标或转交 |
| 23-query | type `tree` | Find 输入继续获焦；第一处 tree 选中，第二处高亮；`1/2`，正文状态栏 `1:13 (4 chars)` |
| 24-next | Enter | 输入保持焦点；第二处选中，`2/2`，`2:38 (4 chars)` |
| 25-previous | Shift+Enter | 第一处选中，`1/2`，`1:13 (4 chars)` |
| 26-escape | Esc | Find 关闭，正文获得焦点；保留第一处 4 字符选区，未回到 1:1 |
| 27-reset | Ctrl+Home | 正文 1:1、无选择 |
| 28-repeat-find | Ctrl+F | query `tree` 被全选；保留查询重开，当前第一处选中 |
| 29/30 | Ctrl+A；type `tree` | `1/2`，与 23 相同 |
| 31/32/33 | Enter；Shift+Enter；Esc | `2/2` → `1/2` → 关闭；同一正文保留第一处 4 字符选区，与首轮一致 |
| 34–51 | Ctrl+Alt+S，设置搜索 appearance / keymap / color scheme font，点击对应页 | 只读相关设置；未 Apply，设置查询过渡不算产品目标状态 |
| 52/53 | 点击 Settings Cancel；独立捕获主窗口 | Cancel 后 settings HWND 销毁，采样器后置 GetWindowRect 报 1400；53-cancel-return 证明返回主窗口。此设施错误不属于 IDEA Find 异常 |
| 54–58 | Ctrl+F；Ctrl+A；Backspace；Esc；Right | 空查询显示 `0 results`；Esc 关闭，原匹配 selection 保留；Right 后 selection 收起、caret 位于其右端，证明按键进入正文。没有正文写入 |

![有效 tree 查询原图](../../../qa-ui-auto-report/idea-reference/find-focus/20260914/30-repeat-query.png)

![有效 Esc 原图](../../../qa-ui-auto-report/idea-reference/find-focus/20260914/33-repeat-escape.png)

## 可实施目标和测量条件

同一 editor pane，查找面板在 tab 下、正文上方，随 pane 宽度布局；Find 默认仅一行，左侧有展开标记。输入内有搜索/清除/匹配选项，后方为计数、上下匹配和过滤/更多/关闭或溢出。有效图中右端空间不足时呈现 `›`，不推断其未打开的菜单内容。输入焦点蓝色边框；当前匹配与其他匹配有不同高亮角色。Esc 后面板空间归还正文，保留当前匹配选区。

在 30-repeat-query 原始坐标下人工边界测量（约 ±2 px 的读图不确定度）：pane x=528..1329，tab 底 y≈122；Find 外带 x≈534..1321、y≈123..191（约 68 px）；输入焦点外框 x≈592..1007、y≈135..180（约 415×45 px）；正文第一/二行基线约 207/238（31 px）。26/33 关闭后第一行回到 y≈137。坐标可由完整原图复查。约 ±2 是测量不确定度，**不是跨产品默认允差**。

P2 用相同 pane 内容宽、DPI/字体/zoom/主题条件对齐后，才能制定并记录几何允许差和测量误差；未匹配环境不得把这些原始像素直接写成全局 CSS token，也不得拿 P0 的 Inter12、CSS13/19.5 浅色图算相似率。该动作不需要重新盘点 shell；只比较 panel、输入、计数、按钮、匹配和焦点角色。

未观测的视觉项：Replace 展开后的确切几何/溢出菜单内容、错误 regex 的 IDEA 呈现、只读/IME/多 pane 边缘状态。它们不能写成已匹配；本包保留已有能力，以现有规则测试和局部 Taomni 适配断言保护，不新增 IDEA 全替换目标。若 P2 为修改这些分支需要新几何决定，只补对应状态。

## 结束及环境限制

06:41:57 对本轮唯一 fixture HWND 发送 WM_CLOSE；出现 Confirm Exit，06:43:48 只读核对其 HWND 3018688 / PID 27816。独占时段已结束，未再注入输入、未强杀、未声称进程退出。可能仍有本轮 fixture 退出确认窗口；以后取得可用桌面时可正常确认退出。没有自动解锁、改变个人 IDE 设置、启动 Taomni/runner/产品测试/构建。

本包真实 Find 参照就绪；产品三维仍须 P2 自验。若原件转交、匹配 Taomni 当前运行环境或当前平台 WebView/IME/provider 不可用，分别记录对应 AC 的证据缺口，不能扩大旧 tree 豁免。没有 IntelliJ 源码实测替代物，也没有正式 comparison schema PASS。
