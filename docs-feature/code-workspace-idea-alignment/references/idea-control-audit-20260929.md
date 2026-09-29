# IDEA 控件级复核：2026-09-29

本文件是 2026-09-28 [实机参照](idea-live-audit-20260928.md) 的第二轮细化，逐控件记录 IDEA 与 Taomni 在同一 fixture 上的实际观察。它只陈述观察和源码事实，不证明任何卡已完成；归属列指向 [任务板](../backlog.md) 的卡号。

## 身份与方法

| 项 | IDEA | Taomni |
|---|---|---|
| 产品 | IntelliJ IDEA Ultimate 2026.2.2 / IU-262.10315.125，XWin keymap，JDK `zulu-21` | HEAD `06ef13d0`，`pnpm dev` browser preview（127.0.0.1:5000，Chrome DevTools 驱动） |
| 平台/窗口 | Linux X11，窗口 1400×1000，深色 UI + 浅色编辑器配色，Source Code Pro 16px | 视口 1400×900（部分步骤 1356×857），浅色主题，JetBrains Mono 13px，Inter 12px |
| Fixture | `/tmp/taomni-idea-align-20260929`：`com.acme.app.{OrderService,Main}`、`com.acme.util.PriceCalculator`、`align.iml`，git 仓库 1 次提交 + 工作区改动（`items.add(name.trim())`），`Main.java` 含类型错误 `int broken = "not a number";` | 同内容写入 browser VFS `/preview/taomni-idea-align-20260929`（不含 `.git`/`.idea`） |
| 语言服务 | 真实 PSI/索引就绪 | browser 无 JDT LS：`Java language server is not available in browser preview`，`Facts Failed` |
| 工件 | `qa-ui-auto-report/idea-reference/align-detail-20260929/shots/idea-*.png`（50 个状态），`steps.jsonl`，`cap.py` | 同目录 `taomni-*.png` |

操作规则：IDEA 输入经 XTEST，每步先校验活动窗口属于 IDEA；所有编辑都已撤销，结束时三个 Java 文件 SHA-256 与创建时一致（`OrderService.java 82dbba4a…`、`Main.java 2a9653c5…`）。Keymap 冲突录制在 IDEA 与 Taomni 均点 Cancel，IDEA `keymaps/` 下无新文件，Taomni `keymap.v3:index` 仍为 `[]`。Taomni browser VFS 的缓冲区经撤销后与 VFS 字节逐字相同。

## 复核结论摘要

1. 阻断级交互缺陷（已由实测+源码确认）：Go to File、Recent Files、File Structure、Search Everywhere 和 Keymap 对话框按 Esc 关闭后焦点落到 `BODY`，IDEA 全部回到编辑器。`CodeWorkspaceTab.tsx:21592/21607/21651` 的关闭回调只 `setXxxOpen(false)`，没有焦点归还。Find、Find in Files、Go to Line 回到编辑器。
2. `Ctrl+Shift+A`（Find Action）未注册；按下后焦点仍在编辑器，随后输入的字符替换了当前选区（实测 `items` 被改为 `reformat`，已撤销）。
3. 无 provider 时补全回退为缓冲区单词列表（`0`、`1`、`acme`、`add`…，`abc` 图标、向上展开遮住代码），在 `calculator.` 成员位置冒充成员补全；Problems 显示 “No problems in open files”，把“服务不可用”伪装成“无问题”。
4. 快捷键默认值与 IDEA XWin 不一致：`F12` 绑定 Go to Definition（IDEA 为 Jump to Last Tool Window），`Alt+0/2/7/9`、`Shift+Esc`、`Ctrl+Shift+F12`、`Ctrl+Shift+A` 缺失；Search Everywhere 与 Keymap 直接显示 `ARROWLEFT`、`ENTER`、`SPACE` 等原始键名，Linux 上同时显示 `Meta+…` 绑定。
5. 壳层与编辑器表面差距集中在：无左右 tool rail、30px 高密度工具栏（约 20 个图标）、编辑器上方两条常驻通知/文件信息条（约 56px）、breadcrumb 在编辑器顶部而非底部导航栏、无 VCS/运行 gutter、无默认 import/单行方法折叠、无 error stripe、无标识符用法高亮、无 inlay 参数提示。
6. 弹层视觉差距：Go to File 约 560px 宽且带模态遮罩（IDEA 约 876px、无遮罩、带 scope 下拉/预览/过滤按钮和模块列）；Recent Files 为单列（IDEA 为“工具窗 + 文件”双列切换器）；Go to Line 为 CodeMirror 底部面板且未预填（IDEA 为预填 `行:列` 的对话框）；Quick Doc/Alt+Enter 无 provider 时只写截断的状态栏文字（IDEA 始终弹出 popup）。
7. Taomni 特有的选区 AI 工具条在任何 ≥2 字符选区出现，包括 Find 按 Esc 后留下的匹配选区，遮住上一行代码；IDEA 无此元素。是否保留、何时出现需要用户决定（见设计 DEC-ALIGN-08）。

<a id="shell"></a>
## 1. 壳层、工具窗口与状态栏（ED-PARITY-010）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| 左 rail | 图标+截断标签竖按钮：Project、Commit、Structure、`…`；下部 Services、Terminal、Problems、Git；选中为蓝底（`idea-01-shell.png`） | 无 workspace rail；仅应用级 `Sessions`/`Tools` 竖标签（应用导航） | different |
| 右 rail | Notifications、AI Chat、DB、Augment | 无；Tao 浮动把手贴右缘 | different |
| 同时打开侧+底工具窗 | Commit（左）与 Terminal/Git（底）可同时显示（`idea-33-commit.png`、`idea-34-git.png`） | 只有底部单一 dock；Project tree 为固定左栏 | different |
| 工具窗切换键 | `Alt+1/0/6/7/9/F12` 切换；再次按下隐藏；`Shift+Esc` 隐藏当前工具窗 | 注册 `Alt+1`、`Alt+6`、`Alt+F12`、`Alt+4`；`Shift+Esc` 实测无效（Problems 保持打开） | different |
| 工具窗头部 | 标题 + 分类标签（Problems：File/Project Errors/…；Terminal：会话 tab + `+` + 下拉）+ `⋮` + `—` 隐藏 | 底部 dock 为 9 个横向文本 tab + More + 展开/收起箭头，无每窗 `⋮`/隐藏 | different |
| 空编辑器 | 居中快捷提示：Search Everywhere `Shift Shift`、Go to File、Recent Files、Navigation Bar、Drop files | 居中 “No file open” | different |
| 顶部工具栏 | 36px 主工具栏：项目 widget、VCS 分支 `master`、运行配置 `Current File`、Run/Debug（Main.java 时变绿）、`⋮`、搜索、设置 | workspace 头部 30px：名称+根数、`SDKs ready`、`Facts Failed`、前进/后退、编辑器缩放、换行、列选择、保存、重载、Build、Run、Debug、刷新树、Git、分屏×2、inlay、blame、outline、tab policy | different（信息密度与分组） |
| 状态栏 | 左：导航栏 `项目 › src › com › acme › app › (C) OrderService › (m) total`；右：`20:10`、换行图标、`LF`、`UTF-8`、`2 spaces`、只读锁 | 应用状态栏混合 sessions/network/X11/auth/ASR/LLM 与编辑器段（`Ln 20, Col`、`Spaces: 2 (Aut…`、`UTF-8`、`LF`、`java`、`13px`、主题、版本），多处截断 | different |
| 选区长度 | 有选区时显示 `20:59 (5 chars)` | 仅 `Ln/Col` | different |

<a id="project-tree"></a>
### Project 树（ED-PARITY-014）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| 头部 | `Project ▾` 视图切换 + New(`+`)、Locate、Expand All、Collapse All、`⋮`、Hide | Open file、Add folder、New file、New dir、`…`、Hide；下方 Filter 输入 + 树/紧凑/平铺三态 + 树缩放 | different |
| 根节点 | `taomni-idea-align-20260929 [align] /tmp/…`（模块名+路径），根外有 External Libraries、Scratches and Consoles | `taomni-idea-align-20260929` + 右侧 `folder` 标签 | different |
| 行元数据 | 顶层文件显示 `2026/9/29 07:54, 328 B` | 无 | different |
| 行高（同 1400 宽） | 约 30px（16px UI 字体） | 27px（12px Inter） | 需按 DEC-ALIGN-06 profile 比较 |
| 打开文件后 | 树不自动定位（Locate 按钮手动） | 不自动定位（`Alt+F1` 手动） | matched（默认值） |
| 树右键菜单 | 本轮未采样 | 本轮未采样 | unverified |

<a id="editor-surface"></a>
## 2. 编辑器表面（ED-PARITY-011 / ED-PARITY-022）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| 编辑器 tab | 类型图标（Java 类 ©、可运行类带绿色三角）+ 名称；活动 tab 蓝色描边胶囊；有错误时名称红色波浪线（`idea-29/30`） | 通用文件图标；preview 为斜体，编辑后转正式；dirty 为 `*`；无错误标记 | different |
| Go to File → Enter | 打开正式 tab；连开三次得到 3 个 tab | 打开 preview tab，第二次替换第一次（`PriceCalculator.java` 被 `Main.java` 替换，`taomni-30-main-tabs.png`） | different |
| tab 溢出 | 分屏窄时 `˅` 下拉列出隐藏 tab | 右侧 `…` | different |
| breadcrumb | 状态栏导航栏，含类/方法层级并随 caret 更新（`… › (m) total`） | 编辑器顶部 20px 条，只有路径到文件名 | different |
| 编辑器顶部条 | 无 | `Language Server Degraded …` + `Configure` + 关闭（28px），另一条 `666 B 2026/9/29 08:31:23` + 截断错误 + `Settings` + 上下导航 + `All Problems`（28px） | different |
| 右上检查 widget | `⚠1 ˄ ˅`；有错误时 `❗2 ⚠1`；分析中 `Analyzing…`；无问题时绿色 ✓ | 无（问题导航挤在第二条顶部条） | different |
| 折叠 | `import …` 默认折叠；单行方法折叠成 `{ items.add(...); }`；可展开 `›` | import 不折叠；折叠箭头 `˅` 常显在第 7/10/14/18/24 行；方法不折叠 | different |
| gutter 宽度/内容 | 行号 + 折叠 + VCS 条 + 运行三角 + 重写/实现图标，约 85px | 行号 + 折叠，约 100px，无 VCS/运行标记 | different |
| 代码字体/行高 | Source Code Pro 16px，行距 28px | JetBrains Mono 13px，行距 19.5–20px | 需按 DEC-ALIGN-06 profile 比较 |
| 当前行 | 浅黄底 + 行号高亮 | 浅蓝底 + 行号加粗 | different（配色随主题） |
| 语义着色 | 字段紫色粗体、关键字深蓝粗体、字符串绿色粗体、TODO 蓝色斜体粗体、未用变量灰色 | 关键字红棕、类型/方法蓝绿（Lezer 语法级），字段与局部变量同色 | different（无 provider 时的降级着色也需定义） |
| 标识符用法高亮 | caret 停在 `calculator` 时所有用法淡紫底，写入点粉底 | 无（只有选区相同文本高亮） | different |
| inlay | 参数名提示 `rate:`、`name:`、`unitPrice:`；Code Vision `2 usages`、作者 `fixture*` | 无（inlay 按钮 disabled） | different；Code Vision 本批次不做 |
| error stripe | 右侧滚动条上 VCS、用法、TODO、错误、查找匹配的彩色刻度 | 无 | different |
| 错误表现 | 红色波浪线 + 悬停 tooltip（Required/Provided + `Wrap using 'Integer.parseInt()' Alt+Shift+Enter` + More actions） | browser 无诊断；Problems 显示 “No problems in open files” | different，且空态误导 |
| 分屏 | tab 右键 Split Right：左右两组各自 tab 栏和 `⋮`，活动组 tab 蓝色描边 | 头部按钮或 tab 菜单 Open in Split Right | 结构一致，视觉待比较 |
| 选区 AI 工具条 | 无 | Explain/Syntax/Fix/Ask AI/Default/× 浮在选区上一行，覆盖代码 | Taomni 特有，需决策 |

<a id="find"></a>
## 3. Find/Replace 与弹层焦点（ED-PARITY-012）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| Find 栏位置 | 编辑器内顶部，推下代码，tab 栏下方（`idea-06-find.png`） | breadcrumb 和两条顶部条之下（y≈186），推下代码 | different（叠加顶部条后代码区更小） |
| 搜索框内控件 | 历史下拉放大镜、清除 `×`、多行 `⏎`、`Cc`、`W`、`.*` | 无历史、无清除、无多行；`Aa`、`W`、`.*` | different |
| 框外控件 | `3/4`、上一项、下一项、过滤漏斗、`⋮`、关闭 | `3 / 4`、上一项、下一项、`…`、关闭 | 缺过滤 |
| Replace 行 | 历史放大镜、多行、保留大小写 `AA`；按钮 Replace、Replace All、Exclude | `AB/ab`、Replace、Replace All | 缺 Exclude、历史、多行 |
| `Ctrl+R` 后焦点 | 仍在 Find 框（caret 在 `items|`） | 移到 Replace 框 | different |
| 匹配高亮 | 其他匹配黄底，当前匹配蓝色选区，滚动条刻度 | 其他匹配浅棕描边，当前匹配蓝底，无滚动条刻度 | different |
| Esc | 关闭，焦点回编辑器，保留当前匹配选区，同时触发用法高亮 | 关闭，焦点回 `cm-content`，保留选区 `items`；随后弹出 AI 工具条 | 焦点 matched；附加行为 different |
| 弹层 Esc 焦点归还 | Go to File、Recent Files、File Structure、Search Everywhere、Settings 全部回编辑器 | Go to File、Recent Files、File Structure、Search Everywhere、Keymap 对话框 → `BODY`；Find、Find in Files、Go to Line → 编辑器 | 已确认缺陷 |
| Go to Line | `Ctrl+G` 模态 “Go to Line:Column”，预填并全选 `6:10`，OK/Cancel | CodeMirror 底部面板 `Go to line:` + `go`，空输入 | different |

<a id="navigation"></a>
## 4. 导航弹层（ED-PARITY-014）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| Go to File 外框 | 约 876×750，无遮罩，位于窗口中上部（`idea-02-goto-file.png`） | 约 560px 宽，高度随结果收缩，页面变暗遮罩（`taomni-02-goto-file.png`） | different |
| 分类 tab | All/Classes/Files/Symbols/Actions/Text | 相同 6 项 | matched |
| 右侧工具 | scope 下拉 `Project Files ▾`、预览开关、过滤、在 Find 窗口打开 | 无；搜索框右侧 `×` | different |
| 结果行 | 类型图标 + 高亮匹配 + 相对目录 + 右侧模块 `align` + 模块图标 | 文件图标 + 名称 + `根/路径` | different |
| 底栏 | 选中项路径 + `Open In Right Split` | `↑↓ select`、`Enter open`、`Ctrl+Enter split`、`Esc close`、`5 files` | different |
| Search Everywhere `total` | All：符号 `total(double) of com.acme.app.OrderService` 置顶，随后 Text 命中（文件:行），再相关 Actions；`Include non-project items` | All：只列 `Left`、`Right`、`Move to Line Start`、`Go to Symbol`… 等与 `total` 无关的动作；无文本命中；快捷键显示 `ARROWLEFT`；底栏 `Provider stale · generation 0 · 0/0 providers · incomplete · 0 symbols` | 已确认结果排序/过滤缺陷 + 内部诊断外露 |
| Recent Files `Ctrl+E` | 双列：左侧工具窗列表（Commit Alt+0 … TODO）+ Recent Locations；右侧文件；`Show edited only` 复选；底部路径 | 单列可过滤文件列表 + 开启点 + 键位提示 | different |
| File Structure `Ctrl+F12` | 标题文件名，`Inherited members`、`Anonymous classes`、`Lambdas` 复选，树含可见性图标，预选 caret 所在成员 | “Java language server is not available…”，`0 symbols`；无 tree-sitter 回退 | different |
| Find in Files `Ctrl+Shift+F` | 浮动弹层：标题 + `4 matches in 1 file`、File mask、过滤；In Project/Module/Directory/Scope；结果列表 + 下方可编辑预览；`Open results in new tab`、`Open in Find Window` | 底部 dock 的 Search 页：单行查询 + Project 下拉 + include/exclude + Replace with + Search/Replace All；无预览；dock 扩到半屏 | different |
| Find Action `Ctrl+Shift+A` | Actions 分类，含设置项、开关、`Assign Shortcut Alt+Enter` | 未绑定，按键落入编辑器 | 已确认缺陷 |
| `Ctrl+B` / Back | 字段跳本文件声明；方法跳到 `PriceCalculator.java` 新 tab；`Ctrl+Alt+Left` 返回 | browser 无 provider，未测 | unverified（需 native JDT LS） |

<a id="code-insight"></a>
## 5. 代码洞察弹层（ED-PARITY-020 / ED-PARITY-015）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| 补全 `calculator.` | 自动弹出，向下展开；行：类型图标 + 粗体方法名 + 灰色参数签名 + 右侧返回类型；自有成员在前，`Object` 成员在后；caret 行内提示 `press '.' to show commands`；底栏 `Press Enter to insert, Tab to replace  Next Tip`（`idea-12-completion.png`） | 回退为缓冲区单词：`0`、`1`、`acme`、`add`、`addItem`、`align`…，`abc` 图标，无签名/类型，向上展开遮住 5–20 行，无底栏（`taomni-12-completion.png`） | 已确认：无 provider 时冒充成员补全 |
| 补全内 `Ctrl+Q` | 左侧并排文档卡：FQN、签名、编辑/`⋮` | 未测（无 provider） | unverified |
| Quick Doc `Ctrl+Q` | 深色 popup：`© com.acme.app.OrderService`、声明、模块 `align`；无文档时 “No documentation found.” | 状态栏 “No documentation a…”，无 popup | different |
| Parameter Info `Ctrl+P` | caret 上方白色 tooltip `double price, int quantity`，当前参数加粗 | 未测（无 provider） | unverified |
| Alt+Enter | 列表 popup：`Replace explicit type with 'var'`、`Split into declaration and assignment`，每项 `⋮`；右侧差异预览；底部 `Press Ctrl+Q to toggle preview`；gutter 黄色灯泡 | 状态栏 “Code actions require the language server to fini…”，无 popup/灯泡 | different |
| 错误 tooltip | 见 §2 | 无诊断 | unverified（需 native） |
| 行内 Rename `Shift+F6` | 名称加框；候选 `strings`、`stringArrayList`…；框后 `//` 注释与文本出现开关；`Press Alt+Shift+O to show options popup`；Esc 取消零修改 | 未测（无 provider） | unverified |
| Extract Method `Ctrl+Alt+M` | 直接生成 `getSubtotal()` 并进入行内命名（候选 `getSubtotal`/`getDouble`），新方法绿底；两次 Esc 撤回 | 未测（无 provider） | unverified |

<a id="menus"></a>
## 6. 右键菜单（ED-PARITY-021）

| 菜单 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| 编辑器 | `Show Context Actions Alt+Enter` 置顶；`Paste`、`Copy / Paste Special ›`、`Column Selection Mode`；`Find Usages`、`Go To ›`；`Folding ›`、`Analyze ›`；`Rename…`、`Refactor ›`、`Generate…`；`Open In ›`；`Local History ›`、`Git ›`；`Compare with Clipboard`、`Diagrams ›`；带助记符下划线 | 平铺约 20 项：Go to Definition `F12`、Go to Declaration、Type Definition、Implementation、Find Usages(禁用)、Call/Type Hierarchy(禁用)；Rename Symbol…、Safe Delete(禁用)、Quick Documentation、Show Code Actions…、Format Document；Explain Syntax…、Explain Code…、AI Answer Language ›；Cut/Copy(禁用)、Paste；菜单底部越过状态栏 | different（顺序、分组、子菜单、助记符、可用态） |
| 编辑器 tab | Close、Close Other Tabs（单 tab 时禁用）、Close All Tabs、Close Unmodified、Close Tabs to the Right；Copy Path/Reference…；Split Right、Split and Move Right、Split Down、Split and Move Down；Pin Tab、Open Tab in New Window、Configure Editor Tabs…；Bookmarks ›；Override File Type；Open In ›；Local History ›、Git ›；Rename File…；Convert Java to Kotlin | Pin Tab、Open in Split Right/Down；Close、Close Others（单 tab 仍可用）、Close Tabs to the Right、Close Unmodified；Close All；Copy Path、Copy Relative Path、Reveal in Project Tree、Reveal in Explorer、Open in Terminal；Local History… | different（顺序、禁用态、缺 Split and Move/Bookmarks/Git/Rename File） |
| 运行 gutter | 点击绿色三角：Run `Ctrl+Shift+F10`、Debug、Run with Coverage、Profile、Modify Run Configuration… | browser 无运行 gutter | unverified（需 native facts） |

<a id="keymap"></a>
## 7. Keymap 与快捷键（ED-PARITY-013）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| 入口 | Settings（`Ctrl+Alt+S`）左侧树 → Keymap，OK/Cancel/Apply，Apply 未改时禁用 | 独立模态 “Keymap”，OK/Cancel/Apply | different（入口） |
| 方案 | `XWin ▾` + 齿轮菜单；默认方案可直接改（首次修改时自动派生） | `IDEA defaults (default) ▾` + Copy/Rename/Reset/Delete；默认方案只读，`+ Add` 只在 Copy 后出现 | different |
| 动作组织 | 分组树（Editor Actions、Main Menu › Navigate › Goto by Name Actions…），展开/折叠、编辑按钮 | 平铺列表，每行 标题 + `分类 · actionId` | different |
| 搜索 | 按名称 + “Find Actions by Shortcut” 录制框（含 Second stroke），命中 `Main Menu › Navigate › … › Go to File… Ctrl+Shift+N` | 仅按名称 | different |
| 快捷键显示 | 键帽拆分 `Ctrl` `Shift` `N`；方向键本地化（`向左箭头`）；`or Button 4 Click`；继承项 `inherited from Go to Line:Column…` | 整串 `Ctrl+Shift+N` 与 `Shift+Meta+N` 同时显示；`Alt+Shift+ARROWUP`、`Ctrl+Shift+ENTER`、`Ctrl+SPACE` | different |
| 录制 | 右键行 → Add Keyboard Shortcut / Add Mouse Shortcut / Add Abbreviation / Remove Ctrl+Shift+N；独立 “Keyboard Shortcut” 对话框，含 Second stroke 复选；冲突 “⚠ Already assigned to: Iterate Recent Files in Main Menu › View” | 行内 `recording…` + 录制条 `[KeyE] Ctrl+E · layout: pc` + OK/Cancel；冲突 “Already assigned to: Recent Files (workspace.recentFiles)、Jump to Bookmark [E]”；两段录制由代码支持，UI 无显式复选 | 冲突识别 matched；呈现 different |
| Cancel | 无持久化 | 无持久化（index `[]`）；对话框关闭后焦点 `BODY` | 持久化 matched；焦点缺陷 |

与 IDEA XWin 默认值的已确认绑定差异（来源 `workspaceActionRegistry.ts`）：

| 键 | IDEA XWin | Taomni | 处理 |
|---|---|---|---|
| `Ctrl+Shift+A` | Find Action | 未注册，落入编辑器 | 013 必须补 |
| `F12` | Jump to Last Tool Window | Go to Definition（`workspace.gotoDefinition`） | 013 迁移到 IDEA 语义；Go to Definition 保留在 `Ctrl+B` |
| `Alt+0` / `Alt+7` / `Alt+9` / `Alt+2` | Commit / Structure / Git / Bookmarks 工具窗 | 未注册 | 010 提供对应工具窗后绑定 |
| `Alt+4` | Run 工具窗 | Show Run Tasks | 语义接近，018 核对 |
| `Shift+Esc` | Hide Active Tool Window | 未注册 | 010 |
| `Ctrl+Shift+F12` | Hide All Tool Windows（最大化编辑器） | 未注册 | 010 |
| `Ctrl+Alt+S` | Settings | 未在 workspace 注册 | 013 决定入口 |

<a id="git-run"></a>
## 8. Git、运行与 Problems 工具窗（ED-PARITY-018 / ED-PARITY-022 / ED-PARITY-015）

| 控件/状态 | IDEA 实测 | Taomni 实测 | 差异结论 |
|---|---|---|---|
| VCS 变更条 | 第 14 行蓝色条；点击弹出行内 diff：上一处/下一处、Rollback、Show Diff、Copy、Annotate、`Commit this c…` 输入框 + 发送，旧文本 `items.add(name);`（`idea-28-change-marker-popup.png`） | browser VFS 无 git；未测 | unverified（需 native git） |
| Commit `Alt+0` | 左侧工具窗：刷新/回滚/diff/搁置/预览/展开/折叠；`Changes 1 file` + `Unversioned Files 2 files` 复选树；`Amend last commit ▾`、历史；多行 `Commit Message`；`Commit`（主按钮）、`Commit and Push…`、齿轮 | 无 workspace 内 Commit 工具窗；头部 `Open Git tab` 打开独立 Git 标签 | different |
| Git `Alt+9` | 底部 Log/Console 标签：分支树（HEAD、Local › master）、`Text or hash` + 正则/大小写、Branch/User/Date 过滤、提交列表、`Select commit to view changes`、`Commit details` | 同上，独立 Git 标签 | different |
| Terminal `Alt+F12` | 底部：`Local ×` 会话 tab、`+`、`˅`、`AI Agents ▾`、`⋮`、`—`；cwd 为项目根 | 底部 dock 的 Terminal tab（browser 未启动 PTY） | 未比较内容 |
| Problems `Alt+6` | 标签 File `3` / Project Errors / …；按文件分组，`❗ Incompatible types…:9`、`⚠ Variable 'broken' is never used :8`；左侧眼睛/灯泡/预览 | `Open files`/`Whole project` + `0/0/0` 计数；“No problems in open files”（服务不可用时仍如此） | 已确认空态误导 |
| Structure `Alt+7` | 可与 Commit 上下并排的工具窗：类树 + 字段/方法可见性图标 | 头部 outline 开关（本轮未展开） | unverified |

<a id="verification-boundary"></a>
## 证据边界

- 本轮只运行了 Taomni browser preview；所有依赖 JDT LS、git、PTY、真实窗口和系统快捷键的 Taomni 状态都标为 unverified，需要 native 复测（`/usr/bin/taomni` 为已安装 0.4.28，不代表 HEAD）。
- Taomni 版本号显示 `0.4.27`，因 dev server 自 2026-09-22 启动未重载 `__APP_VERSION__`；源码为当前 HEAD。
- Chrome DevTools 两次独立 `press_key(Shift)` 间隔超过 `createDoubleShiftDetector` 的 400ms 窗口，这不是产品缺陷；Search Everywhere 改用页面内连续派发触发。
- 字号、行高、配色差异受两侧 profile 不同影响，按 DEC-ALIGN-06 先统一 profile 再判断；本文件只记录实际值。
- IDEA 侧快捷键为 Linux XWin；Windows/macOS 默认 keymap 需另行采样。
