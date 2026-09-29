# ED-PARITY-013 Keymap、冲突提示与平台快捷键对齐（P1 设计）

- 卡片：[backlog ED-PARITY-013](backlog.md)；总体合同 [alignment-design.md#ed-parity-013](alignment-design.md#ed-parity-013)。
- 基线：分支 `docs/code-workspace-idea-alignment-20260929` HEAD `6763642b`（2026-09-29）；IDEA Ultimate 2026.2.2 / IU-262.10315.125，Linux XWin keymap。
- IDEA 参照：[控件级复核 §7](references/idea-control-audit-20260929.md#keymap)（`idea-24/40..45`），以及 IDEA 安装包内置 keymap 原文 `lib/intellij.platform.ide.impl.jar!/keymaps/$default.xml` + `Default for XWin.xml`（XWin 以 `$default` 为父，覆盖 `RunToCursor`、`ShowUsages`、`SurroundWith` 等）。绑定比较以该 XML 为权威，截图只用于布局/交互。
- 设计状态：P1 完成后 `ready`；不代表已实现或已验证。

<a id="current-facts"></a>
## 1. 现状核对（生产代码）

| 事实 | 位置 | 影响 |
|---|---|---|
| 运行期动作真相是 `WorkspaceActionHost` 快照：`CodeWorkspaceTab` 的 `WorkspaceCommand[]` 经 `registerCommands` 适配，`CodeMirrorHost` 经 `buildEditorHostActions` 注册 `editor.*`。`DEFAULT_WORKSPACE_ACTIONS` 只被实验 fixture 使用。 | `workspaceActionHost.ts`、`CodeWorkspaceTab.tsx:~13990-15500`、`workspaceCodeMirrorKeymap.ts:252` | 默认绑定修改落在实际命令定义上，而不是只改 catalog。 |
| `actionKeybindings()` 把 `default/macos/windows/linux` 全部并集，且 `secondaryKeybindings` 里的 `Meta+…` 在所有平台都参与匹配与显示。 | `workspaceActionHost.ts:174` | Linux/Windows 显示并响应 `Meta+`（Super）绑定，与 IDEA XWin 不同（A4）。 |
| 显示字符串由 `stroke.key ?? stroke.code` 拼接，定义派生的 key 被 `toUpperCase()`，于是出现 `ARROWLEFT`、`ENTER`、`SPACE`。Search Everywhere、Cheat Sheet、ControlBar 都消费该字符串；Keymap 对话框另用 `formatShortcut`；编辑器右键菜单写死字符串（`F12`、`Ctrl+Alt+S`）。 | `workspaceActionHost.ts:1270`、`workspaceKeymapScheme.ts:106`、`editorContextMenu.ts:141/168`、`SearchEverywhere.tsx:282` | 显示点不共享格式化函数（A1/A4）。 |
| `Ctrl+Shift+A` 无任何动作；按下后焦点仍在编辑器，随后输入替换选区（复核实测）。 | 无注册 | A4 首个缺陷。 |
| `workspace.gotoDefinition` 默认 `F12`；IDEA `F12` = `JumpToLastWindow`，Go to Declaration 为 `Ctrl+B`。`workspace.aiExplainSyntax` 占用 `Ctrl+Alt+S`（IDEA = `ShowSettings`）。`editor.selectSelectionMatches` 占用 `Ctrl+Shift+L`（IDEA = `FindPrevious` 次绑定）。 | `CodeWorkspaceTab.tsx:14791/14944`、`workspaceCodeMirrorKeymap.ts:501` | 与 DEC-ALIGN-07 冲突。 |
| `lspNavigationExtensions` 在 CodeMirror 内另装 `F12`/`Shift-F12`/`Mod-b`/`Mod-Alt-B`，是 host 之外的第二套派发真相（`Mod-Alt-B` 在 IDEA 是 Go to Implementation）。 | `CodeMirrorHost.tsx:1933` | A1：注册表与实际派发不一致的来源。 |
| 无 `Alt+2/7/9`、`Shift+Esc`、`Ctrl+Shift+F12`；`Alt+0` 无对应 Commit 工具窗。`Alt+4` = Show Run Tasks（IDEA Run 工具窗）。 | 命令表 | §7 差异表。 |
| XWin 专有：`RunToCursor` = `Shift+Alt+9`（Taomni `Alt+F9`），`ShowUsages` = `Ctrl+Alt+7`（Taomni `Ctrl+Alt+F7`，Linux 会切 VT）。`F1` 在 Win/Linux 为 Context Help，Taomni 把 `F1` 作为 Quick Doc 次绑定（这是 IDEA macOS 绑定）。 | 命令表 + IDEA XML | 平台绑定需分 Windows/Linux/macOS。 |
| Keymap 对话框：默认方案 `draftScheme=null` 视为不可变，`+ Add` 只在 Copy 后出现；平铺列表；只能按名称过滤；录制器为行内条，两击自动连续录入，无 Second stroke 开关；无行右键菜单；关闭时焦点落 `BODY`。`ensureMutableDraft` 分叉时不复制父方案绑定。 | `KeymapSettingsDialog.tsx` | A2/A4 呈现差异。 |
| 鼠标快捷键已有真实派发：左键单击/双击 + 修饰键，经 `attachWorkspaceMouseDispatcher`。 | `workspaceMouseDispatcher.ts` | “Add Mouse Shortcut” 可以做真实录制，不是空壳。 |
| 派发门：IME（`isComposing`/`Process`）、死键、AltGr 在匹配前拒绝；外部输入框不获得编辑器上下文；终端 helper textarea 视为外部输入。 | `workspaceActionHost.ts:1120` | A3 保留行为。 |

共享消费者：Search Everywhere（Actions/All）、Keymap Cheat Sheet（`Ctrl+Alt+/`）、ControlBar/原生应用菜单（`nativeAppMenu.ts`，用原始 `command.keybinding` 生成 accelerator，不受显示格式化影响）、编辑器右键菜单、鼠标派发器、`BindingConflictNotice` 状态文案、现有用例 `TC-IDE-C1-01`、`TC-IDE-PARITY-004-01..04`、以及按 `F12` 做定义跳转的 `TC-IDE-C6-02/05/06/07`。

<a id="decisions"></a>
## 2. 设计决定

| DEC | 决定 | 依据 |
|---|---|---|
| DEC-013-01 | 引入平台感知的绑定解析：`windows`/`linux`/`mac` 三个平台。Win/Linux 丢弃任何含 `Meta` 的定义绑定（显示与派发一致）；`mac` 保留当前 “Ctrl 主绑定 + Cmd 别名” 模型并把含 Cmd 的绑定排在首位。命令可声明 `platformKeybindings.{windows,linux,mac}` 以**替换**该平台的默认集合。 | IDEA XWin/$default 无 Meta 绑定；现有 macOS 用例按字面 `Control+…` 驱动，完整 macOS IDEA keymap 另行对齐（见 §7 边界）。 |
| DEC-013-02 | 所有显示点共用 `formatShortcutLabel(shortcut, platform)`：修饰键顺序 Ctrl/Alt/Shift/(mac: Cmd)，mac 用 `Option`/`Cmd` 文本；键名 `Left/Right/Up/Down/Enter/Space/Esc/Backspace/Delete/Insert/Home/End/Page Up/Page Down/Tab`，数字与字母大写，标点用符号，小键盘 `NumPad -`/`NumPad +`；zh-CN 下方向键为 `向左箭头` 等。Keymap 对话框把同一标签拆成键帽，键帽间保留隐藏的 `+` 以维持可访问名称与文本断言。 | 复核 §7：IDEA 键帽拆分、方向键本地化；A4 禁止原始键名。mac 字形（⇧⌘）留给 019。 |
| DEC-013-03 | 新增 `workspace.findAction`（Find Action…），默认 `Ctrl+Shift+A`，mac 另加 `Cmd+Shift+A`；打开 Search Everywhere 的 Actions 分类；终端与模态焦点下不可用（保护终端输入）。Actions/All 中选中动作按 `Alt+Enter` = Assign Shortcut：打开 Keymap 设置、过滤到该动作并直接进入录制对话框。 | IDEA `GotoAction`；复核 §4 “含 Assign Shortcut Alt+Enter”。 |
| DEC-013-04 | “未注册的 `Ctrl+Shift+字母` 不得把后续输入落到编辑器选区” 的可验证含义：未绑定的该类组合本身不修改文档、不改变选区；随后正常键入的字符按普通编辑处理（与 IDEA 未绑定组合一致）。原缺陷由 DEC-013-03 注册 Find Action 修复。 | 字面要求会与 IDEA 未绑定键的行为矛盾；以 IDEA 为准并记录解释。 |
| DEC-013-05 | 默认绑定迁移（DEC-ALIGN-07）：`F12` → `workspace.jumpToLastToolWindow`；Go to Definition 不再有默认键（`Ctrl+B` Go to Declaration 在 Java 等等价语言已路由到定义）；`Ctrl+Alt+S` → `workspace.showSettings`（打开应用 Settings）；AI Explain Syntax 失去默认键（入口保留在右键菜单、选区工具条、Find Action）；`Ctrl+Shift+L` 从 Select All Occurrences of Selection 移到 Find Previous 次绑定，`Ctrl+L` 为 Find Next 次绑定；`Alt+2` → TODO/Bookmarks 窗、`Alt+7` → Structure（Outline）窗、`Alt+9` → Git（打开 Git 管理器）；`Shift+Esc` → 隐藏当前工具窗、`Ctrl+Shift+F12` → 隐藏/恢复全部工具窗；Linux 专有 `Shift+Alt+9` Run to Cursor、`Ctrl+Alt+7` Show Usages；`F1` 仅 mac 作为 Quick Doc。 | IDEA XML；A4 §7 表。 |
| DEC-013-06 | 旧绑定以内置只读方案 “Taomni Classic” 保留（`F12` = Go to Definition、`Ctrl+Alt+S` = AI Explain Syntax，并清空与之冲突的新默认）。已有用户数据（本地存在任何 `taomni.codeWorkspace.*` 键且未记录 defaults revision 2）时，首次打开 workspace 显示一次右下角气泡说明变更并提供 “Open Keymap” / “Dismiss”；全新配置静默写入 revision。用户自建方案只是 delta，读取格式不变。 | 设计风险 §9：不得静默覆盖肌肉记忆。 |
| DEC-013-07 | `Alt+0`（Commit 工具窗）本卡不绑定：Taomni 无 workspace Commit 工具窗，由 ED-PARITY-018 提供窗口时绑定。`Alt+4` 语义接近（Run 工具窗 ≈ Run Tasks），记为 matched-with-note，018 复核。 | §7 表 “010/018 提供对应工具窗后绑定”。 |
| DEC-013-08 | Keymap UI：按动作分类的可折叠分组树（无过滤时折叠，过滤/按键查找时展开）；“Find Actions by Shortcut” 录制过滤（含 Second stroke）；默认方案与内置方案可直接编辑，首次修改自动派生 “… (copy)” 并**复制父方案 delta**；行右键菜单 Add Keyboard Shortcut / Add Mouse Shortcut / Remove `<键>` / Reset Shortcuts；录制改为 “Keyboard Shortcut” 子对话框，First stroke + `Second stroke` 复选框 + 冲突 “Already assigned to:”；不勾选 Second stroke 时新按键替换第一击。Enter 确认、Esc 取消、Backspace 删除保留为录制器控制键（与 ED-PARITY-004 一致）。 | 复核 §7 录制/分组/搜索差异；ED-PARITY-004 DEC-02..04 保留冲突语义。 |
| DEC-013-09 | Mouse Shortcut 录制只接受左键单击/双击且至少一个修饰键（与现有派发能力一致），其余给出就地提示，不写入。 | 避免记录永远不会触发的绑定或劫持普通点击。 |
| DEC-013-10 | Keymap 对话框、Keyboard/Mouse Shortcut 子对话框关闭（OK/Cancel/Esc/遮罩）后把焦点交回打开前的元素；若其已失效则交回活动编辑器（DEC-ALIGN-11，本卡负责 Keymap 对话框这一处）。焦点归还做成可复用 `useFocusReturn`，012 复用。 | DEC-ALIGN-11。 |
| DEC-013-11 | 删除 `lspNavigationExtensions` 在有 action host 时的键位（仅无 host 的嵌入保持旧行为），使编辑器内 `F12/Shift+F12/Ctrl+B/Ctrl+Alt+B` 只由 host 派发。 | A1：显示绑定 = 实际派发。 |
| DEC-013-12（P2 修订） | `+ Add` / Add Keyboard Shortcut 按 IDEA 语义**追加**到继承的默认绑定之后（旧 ED-PARITY-004 S3 “新 chord 取代 Ctrl+R” 被本卡取代）；移除最后一个绑定写入显式空覆盖，不让默认值复活；原位替换按有效绑定索引。受影响用例 `TC-IDE-C1-01`、`TC-IDE-PARITY-004-01..04` 的断言同步改为 `replace-1`/“旧 chord 仍可用”。 | IDEA Keymap 行为；P2 发现旧实现对未覆盖动作 Add 会丢默认、Replace 在空 delta 上失效。 |
| DEC-013-13（P2 修订） | IDEA XWin 全映射对照（104 个动作）中允许保留的差异只列在 `__fixtures__/ideaKeymapAcceptedDifferences.ts`（Alt+Left/Right 返回/前进、Ctrl+T、Ctrl+Shift+K、Ctrl+Shift+F10 共享、Alt+/ 交 020）；同时修复 `Ctrl+Period`、`Alt+Insert`、`Alt+Shift+Insert`、`Ctrl+Shift+NumpadSubtract/Add` 等命名键从未被解析的缺陷，并补 IDEA 次绑定。 | `CodeWorkspaceTab.test.tsx` “A4.2 … match IDEA XWin” 为门。 |

<a id="acceptance"></a>
## 3. 验收细化

原卡 AC ID 不变，下列为可观察断言。

- **ED-PARITY-013-A1**（注册表 = UI = 派发）
  - A1.1 同一动作在 Search Everywhere、Keymap 行、Cheat Sheet、编辑器右键菜单显示的快捷键文本来自同一格式化结果；右键菜单 Go to Definition 不再显示 `F12`。
  - A1.2 编辑器内按 `F12` 只触发 host 解析出的动作（Jump to Last Tool Window），CodeMirror 内置导航键不再旁路。
  - A1.3 录制冲突时 “Already assigned to:” 列出全部持有者（标题 + id）；平台过滤后的绑定才参与冲突判断。
- **ED-PARITY-013-A2**（改键全流程）
  - A2.1 默认方案不 Copy 即可 `+ Add`/右键 Add Keyboard Shortcut；首次修改自动派生 “IDEA defaults (copy)”，Apply 前零写入，Cancel/Esc 零写入。
  - A2.2 Keyboard Shortcut 子对话框：Second stroke 未勾选时第二次按键替换第一击；勾选后可录两击；冲突即时显示；OK/Cancel。
  - A2.3 Find Actions by Shortcut：录入 `Ctrl+Shift+N` 只剩 Go to File 等持有者；清除后恢复。
  - A2.4 分组树折叠/展开，过滤时自动展开；行右键 Remove/Reset 生效于草稿。
  - A2.5 Taomni Classic 方案可选；派生、Apply、重开后保持；迁移气泡只对既有用户出现一次。
  - A2.6 Add Mouse Shortcut 录制 `Ctrl+Click` 写入草稿，Apply 后真实点击触发；无修饰键的点击被拒绝。
- **ED-PARITY-013-A3**（平台与保护）
  - A3.1 Windows/Linux 以 `Ctrl+Shift+A`、macOS 以 `Cmd+Shift+A`（及兼容 `Ctrl+Shift+A`）在 native 打开 Find Action。
  - A3.2 IME 组合期间、AltGr 字符、外部输入框、终端焦点下，`Ctrl+Shift+A` 与改键后的绑定都不触发编辑器动作；终端中不打开 Find Action。
  - A3.3 按住 `Ctrl+Shift+A` 产生 `repeat` 事件时 Find Action 保持单个打开实例，不反复切换。
- **ED-PARITY-013-A4**（IDEA 绑定与显示）
  - A4.1 `Ctrl+Shift+A` 打开 Find Action，输入进入搜索框，编辑器字节与选区不变；未绑定的 `Ctrl+Shift+Q` 不改文档。
  - A4.2 §7 表每一行：`Ctrl+Shift+A`、`F12`、`Alt+2/7/9`、`Shift+Esc`、`Ctrl+Shift+F12`、`Ctrl+Alt+S` 与 IDEA XWin 同语义；`Alt+0` 与 `Alt+4` 按 DEC-013-07 记录。另核对全部可映射动作的 XWin 绑定，差异只允许出现在显式 accepted 列表中并附 DEC。
  - A4.3 所有显示点不出现 `ARROWLEFT`/`ENTER`/`SPACE` 等原始全大写键名；Win/Linux 不出现 `Meta+`。

<a id="states"></a>
## 4. 状态与恢复路径

| 表面 | 正常 | 空 | 加载 | 失败/拒绝 | 取消 | 恢复 |
|---|---|---|---|---|---|---|
| Find Action | Actions 列表 + 快捷键 + 分类 | “No matching actions” | — | 动作不可用时不列出；执行 no-op 走状态栏原因 | Esc 关闭，零副作用 | 再次 `Ctrl+Shift+A` |
| Assign Shortcut | 打开 Keymap + 录制框 | — | — | 动作为只读/内置方案 → 自动派生 | 录制 Esc/Cancel 零写入 | Keymap Cancel 丢草稿 |
| Keymap 分组树 | 分类折叠 | “No matching actions.” | — | 损坏存储 → 既有 quarantine 提示 | Cancel/Esc/遮罩零写入 | Reset 恢复默认 delta |
| Find by Shortcut | 匹配行 | “No actions use this shortcut.” | — | 保留键（F5/F11/F12/Tab/Space 裸键）仍可查找 | Esc 退出查找 | 清除按钮 |
| 录制子对话框 | 冲突即时提示 | “press keys…” | — | IME/死键/AltGr 忽略；保留键拒绝 | Esc/Cancel | — |
| Jump/Hide 工具窗 | 打开并聚焦/隐藏并回编辑器 | 无上次工具窗 → Project | — | 模态打开时不可用 | — | 再按 `Ctrl+Shift+F12` 恢复 |
| 迁移气泡 | 一次显示 | 新配置不显示 | — | 存储不可用 → 不显示、不报错 | Dismiss | Open Keymap |

<a id="tasks"></a>
## 5. 实现任务与文件职责

| TASK | 内容 | 文件 |
|---|---|---|
| TASK-013-01 | 平台检测、平台绑定选择、`formatShortcutLabel`、键名表 | 新 `workspace/workspaceKeymapPlatform.ts`（+ test） |
| TASK-013-02 | host 使用平台绑定与统一显示；`platformKeybindings` 贯通 `WorkspaceCommand`/`WorkspaceActionMetadata`；`formatShortcut` 委托新格式化 | `workspaceActionHost.ts`、`workspaceCommands.ts`、`workspaceActionRegistry.ts`、`workspaceKeymapScheme.ts` |
| TASK-013-03 | 默认绑定迁移与新动作：findAction、jumpToLastToolWindow、hideActiveToolWindow、hideAllToolWindows、showSettings、Alt+2/7/9、Linux 专有、F1 mac-only、Ctrl+Shift+L/Ctrl+L | `CodeWorkspaceTab.tsx`（命令表与工具窗 helper）、`workspaceCodeMirrorKeymap.ts` |
| TASK-013-04 | Taomni Classic 预置方案、defaults revision、迁移气泡 | `workspaceKeymapScheme.ts`、新 `workspace/KeymapMigrationNotice.tsx`、`CodeWorkspaceTab.tsx` |
| TASK-013-05 | Keymap 对话框重构：分组树、键帽、按键查找、默认方案可编辑+派生复制、行菜单、Keyboard/Mouse Shortcut 子对话框、焦点归还 | `KeymapSettingsDialog.tsx`（+ test）、新 `workspace/useFocusReturn.ts` |
| TASK-013-06 | Search Everywhere `Alt+Enter` Assign Shortcut；QuickPickOverlay `onAltEnter` | `SearchEverywhere.tsx`、`QuickPickOverlay.tsx`、`CodeWorkspaceTab.tsx` |
| TASK-013-07 | 右键菜单快捷键来自快照；删除 CM 旁路导航键（有 host 时） | `editorContextMenu.ts`、`CodeMirrorHost.tsx`、`CodeWorkspaceTab.tsx` |
| TASK-013-08 | IDEA XWin 绑定参照 fixture 与对照单测 | 新 `workspace/__fixtures__/ideaXWinKeymap.ts`、新 `workspace/ideaKeymapParity.test.ts` |
| TASK-013-09 | QA 用例、policy、feature-list 控件、受影响旧用例改键 | `qa-ui-auto-tests/cases/…`、`qa-ui-auto-tests/ci/policy.yaml`、`qa-ui-auto-tests/feature-list.md` |

保留行为（回归责任在本卡）：ED-PARITY-004 的冲突识别、displacement、Apply-only 持久化、Cancel 零写入、输入框保护、IME/AltGr 拒绝；Cheat Sheet 执行冻结评估；双 Shift；`Ctrl+Tab` Switcher；鼠标派发；Java 定义跳转（改用 `Ctrl+B` 入口）。

<a id="test-cases"></a>
## 6. 测试用例

| 用例 | 模式 | 覆盖 | 关键步骤与期望 |
|---|---|---|---|
| `TC-IDE-PARITY-013-01-find-action-assign-browser`（新） | browser | A4.1、A1.1、A2.1、DEC-013-03/10 | 打开 browser VFS 文件，点击编辑器；`Control+Shift+A` → Search Everywhere 可见且 Actions tab `aria-selected=true`、输入框为焦点；键入 `reformat` → 输入框值为 `reformat`、编辑器 `.cm-line` 与打开时逐行相同；Reformat Code 行 `kbd` 匹配 `(Ctrl|Cmd)\+(Alt|Option)\+L`；`Alt+Enter` → Keymap 对话框出现、录制子对话框可见、过滤为该动作；Esc 取消录制、Esc 关闭对话框 → `document.activeElement` 为 `.cm-content`；`Control+Shift+Q` 后编辑器行不变。 |
| `TC-IDE-PARITY-013-02-idea-default-bindings-browser`（新） | browser | A4.2、A4.3、A1.2、A3.3 | Actions 搜 `Left` → `kbd` 文本为 `Left`，全页 `kbd` 无 `ARROW|ENTER|SPACE`，非 mac 无 `Meta+`；编辑器中 `Alt+6` 开 Problems、Esc 回编辑器、`F12` → Problems 可见且焦点在 dock 内；`Shift+Escape` → dock 隐藏、焦点回 `.cm-content`；`Control+Shift+F12` → 项目树隐藏，再按恢复；`Alt+7` → Outline 窗可见；repeat：连续两次 `Control+Shift+A`（第二次在输入框内）仍只有一个 Search Everywhere。 |
| `TC-IDE-PARITY-013-03-keymap-tree-record-browser`（新） | browser | A2.1–A2.4、A2.6、A1.3 | Find Action → Keymap Settings；默认方案下 Navigation 分组 `aria-expanded=false`，点击展开；按键查找录 `Control+Shift+N` → 只见 `keymap-row-workspace.goToFile`；右键该行 → 菜单含 Add Keyboard Shortcut / Add Mouse Shortcut / Remove；Add Keyboard Shortcut → 子对话框；按 `Control+Alt+K` 再按 `Control+Alt+J`（未勾选）→ 只保留第二击；勾选 Second stroke 后按 `Control+Alt+K` → 两击；冲突区显示；OK → 方案名含 `(copy)`；Add Mouse Shortcut → 无修饰点击被拒，`Ctrl+Click` 记录；Cancel 整个对话框后重开无改动；再次修改 Apply 后重开保持。 |
| `TC-IDE-PARITY-013-04-classic-scheme-browser`（新） | browser | A2.5、DEC-013-06 | Keymap 选 Taomni Classic → Go to Definition 行显示 `F12`，Jump to Last Tool Window 行 “no shortcut”；Apply 后编辑器 `F12` 不打开工具窗；切回 IDEA defaults Apply → `F12` 打开上次工具窗。 |
| `TC-IDE-PARITY-013-05-find-action-platform-native`（新） | native | A3.1、A3.2 | 隔离 QA 应用；编辑器中 `Mod+Shift+A`（mac = Cmd，其余 = Ctrl）→ Find Action 打开、编辑器字节不变；Esc 焦点回编辑器；`Alt+F12` 打开终端并聚焦，`Mod+Shift+A` → Search Everywhere 不出现；Keymap 过滤框内 `Control+f` 不打开编辑器 Find。 |
| 保留：`TC-IDE-C1-01`、`TC-IDE-PARITY-004-01/02/03/04` | browser/native | 保留行为 | 选择器不变；004-02 的 `editor.find` 平台断言改为 “Ctrl+F 已移除且 Win/Linux 显示 no shortcut / mac 仍有 Cmd+F”。 |
| 保留：`TC-IDE-C6-02/05/07`（及本地 `C6-06`） | browser/native | 定义跳转入口 | `F12` 改为 `Control+B`，断言不变。 |

单测：`workspaceKeymapPlatform.test.ts`（格式化、平台选择、zh-CN）、`ideaKeymapParity.test.ts`（§7 表 + 全部映射动作对 XWin，accepted 差异列表）、`workspaceActionHost*.test.ts`（Meta 过滤、平台替换、显示）、`KeymapSettingsDialog.test.tsx`（分组、查找、派生复制、子对话框、鼠标录制、焦点归还）、`SearchEverywhere` Alt+Enter、`editorContextMenu.test.ts`（快捷键来自快照）、`CodeMirrorHost.test.tsx`（有 host 时无旁路）、`CodeWorkspaceTab.test.tsx`（findAction/F12/Shift+Esc/Ctrl+Shift+F12/迁移气泡）。

<a id="verification"></a>
## 7. 验证组合与平台边界

- 迭代：上述单测文件；`typecheck_scope.py` 覆盖本卡路径。
- browser：本地 Linux 运行 013-01..04 + 保留 keymap 用例；GitHub `qa-ui-auto-platforms.yml` `scope=selected` 在 linux/windows/macos × browser/native 运行新用例与受影响保留用例，三端全部通过才可 `done`。
- native：013-05（三端）；004-04（重启持久化）；C6-05（JDT LS 定义跳转，Linux/Windows/macOS 需 Java 能力）。
- IDEA comparison：绑定用 IDEA 2026.2.2 内置 XML 做逐动作比较（`ideaKeymapParity.test.ts` + 报告）；Keymap UI/Find Action 交互对照复核 §7 实测记录。`compare_idea.py` 记录保持 `unverified` 的维度不写成 matched。
- 边界：macOS 仍是 “Ctrl 主绑定 + Cmd 别名” 而非完整 IDEA macOS keymap（例如 Go to File 应为 `⇧⌘O`），显示为文字 `Cmd+…` 而非字形；Windows 的系统级快捷键冲突（如 `Ctrl+Alt+方向键` 显卡热键）不在本卡；mac 的 WebDriver bridge 只证明 DOM 键事件，不证明系统键盘/IME。上述进入 ED-PARITY-019 收口。
