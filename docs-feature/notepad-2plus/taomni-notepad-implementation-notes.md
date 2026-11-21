# Taomni Notepad 实施进展与验证记录

日期：2026-11-21
分支：`feat/notepad-2plus-impl`（基于 `main` e4700a8c3 `feat/notepad-2plus` 合并点）
依据：[taomni-notepad-detailed-design.md](taomni-notepad-detailed-design.md)、[taomni-notepad-development-tasks.md](taomni-notepad-development-tasks.md)、[taomni-notepad-prototype.html](taomni-notepad-prototype.html)（v3）

本文件记录本轮接续实施的**实际状态、证据与相对设计的偏差**；任务板仍是任务状态的权威来源，设计 §3/§9 仍是验收与追踪的权威来源。未在本文件出现的 V-* 仍未执行。

## 1. 本轮完成范围

| 任务 | 状态 | 说明 |
|---|---|---|
| TASK-NP-00 | 已实现待验证 | `spikes/spikes-s1-s6.md`（S-1～S-6 结论 + 对设计的影响） |
| TASK-NP-01 | 已实现待验证 | `notepadStore` 按 `docId` 分区、未命名命名规则、`documentStore` 未命名/`rekey` 支持；V-01/V-02 单测通过 |
| TASK-NP-02 | 已验证（单测） | `src/lib/notepad/transforms/*`：7 口径×升降序排序、8 种大小写、空白、行列变换、列编辑序列、MIME/转义；V-03～V-06 覆盖 |
| TASK-NP-03 | 已实现待验证 | 命令注册表 192 条命令、`Mod` 键位、冲突检测、宏白名单；V-07 单测通过 |
| TASK-NP-04 | 已实现待验证 | 新建/打开/保存/另存/保存副本/全部保存/重命名/关闭系列/回收站；Rust `viewer_save_as/viewer_rename/viewer_trash` 已接入；V-09 部分单测 |
| TASK-NP-05 | 已实现待验证 | `recentFiles` store、最近文件子菜单（打开全部/清空）、恢复最近关闭 |
| TASK-NP-06 | 已实现待验证 | 编码检测/重新解释/转换、EOL 转换与编码损失提示（Rust `notepad_list_encodings`/`check_encoding_loss`） |
| TASK-NP-07 | 已实现待验证 | 外部变更横幅、重载、编辑器/属性只读、远程只读副本 |
| TASK-NP-08 | 已实现待验证 | 会话 JSON（`version`）、启动恢复、运行快照扩展 |
| TASK-NP-09 | 已实现待验证 | 周期磁盘备份、保存时备份、崩溃恢复扫描、`viewerDrafts` 一次性迁移 |
| TASK-NP-10 | 部分实现 | 剪贴板历史/多光标/选择下一个相同词/拖动文本（CM6 默认）；特殊粘贴为“粘贴源码文本” |
| TASK-NP-11 | 部分实现 | 插入日期（短/长/自定义）、INS/OVR、虚拟空格、矩形选择、列编辑器 |
| TASK-NP-12 | 已实现待验证 | 查找/替换/增量/正则/扩展模式/历史/转到行/列/偏移；正则超时保护 |
| TASK-NP-13 | 已实现待验证 | 全部查找（当前/所有打开）、所有打开文档替换、在文件中查找/替换、结果面板、Mark、令牌样式 |
| TASK-NP-14 | 已实现待验证 | 书签（切换/导航/批量）、变更历史导航与清除（DEC-04：与工作区书签保持两套） |
| TASK-NP-15 | 已实现待验证 | `NotepadHost`/`viewerTabHost`、同路径去重、标签标题/脏标记回写、窗口菜单与文档列表、标签内分屏/克隆/旋转/同步滚动 |
| TASK-NP-16 | 已实现待验证 | 全屏/Post-It/专注、行号/标尺、换行/缩放、显示符号、主题/栏显隐、文件摘要 |
| TASK-NP-17 | 已实现待验证 | 文档地图、文档列表、字符面板、搜索结果；右/底/浮动三态停靠 + `⋯` 菜单 |
| TASK-NP-18 | 已实现待验证 | 可点击链接（CM6 默认）、选区动作、复制路径、字符面板、脱敏、哈希、Base64/URL 编解码、JSON 转义 |
| TASK-NP-19 | 已实现待验证 | 宏录制/回放/多次运行/运行到文件末尾/保存/管理/SHA-256 校验；移除占位文案 |
| TASK-NP-20 | 已实现待验证 | 与磁盘版本/剪贴板/其他文档对比（`@codemirror/merge`，5 MB 上限待真机确认） |
| TASK-NP-21 | 已实现待验证 | 打印/立即打印/打印设置/打印到 PDF（隐藏 iframe）；三端行为待真机确认 |
| TASK-NP-22 | 已实现待验证 | 首选项分页、快捷键映射器、新建默认值（默认编码/EOL/命名规则） |
| TASK-NP-23 | 部分实现 | 拖放（文件/文件夹 20 个上限）、外部打开、提权保存（S-5 方案）、大文件降级 |
| TASK-NP-24 | 进行中 | 单元测试通过；browser/native 用例、三端构建与真机验证进行中 |
| TASK-NP-25 | 已实现待验证 | `ViewerShell` 文本分支（text/source/large）改挂 `NotepadEditor`，删除旧 `TextEditor`；外壳横幅与轮询保留；V-47 单测 |
| TASK-NP-26 | 已实现待验证 | `FileHandler` 增加 `notepad`/`taoffice`、注册表、Explorer 打开方式与设置、TaOffice 禁用占位 |

## 2. 代码位置（相对设计 §5 的落实）

- 共享库：`src/lib/notepad/{transforms,commands,search,cm6,macro,persistence,print,host}/`
- store：`src/stores/notepadStore.ts`（Notepad 专有状态）、`src/stores/notepadPreferences.ts`、`src/stores/app/recentFiles.ts`
- 组件：`src/components/notepad/`（`NotepadEditor`、菜单/工具栏/查找条/分屏/状态栏、`panels/`、`dialogs/`、`actions/`）
- 集成：`src/components/viewer/ViewerShell.tsx`、`src/components/explorer/{ExplorerTabStrip,fileOpenMenu}.tsx`、`src/components/settings/{panel/SettingsPanelView,settingsSearch,NotepadSettingsPanel}.tsx`、`src/lib/openFile/{index,preferences,handlers,useViewerRecovery}.ts`、`src/stores/{documentStore,explorerStore}.ts`
- 后端：`src-tauri/src/commands/notepad.rs`、`src-tauri/src/viewer/*`、`workspace/viewer_io.rs`；浏览器 stub `src/stubs/commands/notepad.ts`
- 文档：`docs-feature/notepad-2plus/spikes/spikes-s1-s6.md`

## 3. 与高保真原型的一致性处理

原型（v3）作为 UI/交互目标，逐项落地过程中的**有意偏差**：

| 原型 | 实现 | 原因 |
|---|---|---|
| 顶层菜单 9 个（无“帮助”） | 一致：文件/编辑/搜索/视图/编码/工具/宏/对比/窗口；`help.about` 命令保留但不出现在菜单 | DEC-16 与原型一致；关于对话框通过 F1 命令可用 |
| `另存为` Ctrl+Alt+S、`全部保存` Ctrl+Shift+S | 一致（沿 Notepad++ 约定） | 交互一致性 |
| macOS `重做` 显示 ⌘Y | 保留 ⌘⇧Z | 仓库 AGENTS.md 的 macOS 快捷约定优先于原型 |
| 查找条 Esc 不关闭（原型缺陷） | Esc 关闭并把焦点还给编辑器；所有对话框 Esc 取消 | 设计 §4.2 要求 |
| 原型“紧凑模式”仅隐藏部分区域 | 紧凑模式隐藏页签行与选项/按钮区，保留查询行 | 保持可用性 |
| 字符面板 32–255 + 扩展符号（原型 224 格） | 32–255 去控制字符 + 扩展 Unicode 符号（去重） | 原型重复行/键缺陷 |
| 文档列表面板原型崩溃 | 正常渲染并可排序/激活 | 以设计 AC-32 为准，不复制原型缺陷 |
| 宿主标签固定/排序/MRU 由宿主提供 | Notepad 菜单不出现宿主不提供的能力（`capabilities`），Explorer 标签栏实现固定与批量关闭 | DEC-22 |
| 原型无 Notepad 设置页（只有原型顶部抽屉） | 设置面板新增 Notepad 页 + 首选项对话框（同源组件） | 设计 AC-45 |

## 4. 验证记录

### 4.1 单元测试（本机，Linux）

命令：`pnpm exec vitest run src/lib/notepad src/components/notepad src/lib/openFile src/components/viewer`
结果：63 个测试文件、402 个测试通过（2026-11-21）。覆盖 V-01～V-08、V-13～V-16、V-22～V-29、V-34～V-39、V-46～V-49 等单测层。

新增/更新的关键测试：
- `src/lib/notepad/transforms/transforms.test.ts`（21 项：排序 7 口径×升降、大小写 8 种、空白、行操作、列序列）
- `src/lib/notepad/commands/menus.test.ts`（菜单树 9 项顺序、命令引用完整、子菜单 key 唯一、动态节点、zhLabel、快捷键唯一性）
- `src/components/notepad/__tests__/NotepadEditor.test.tsx`、`dec16Exclusions.test.ts`
- `src/components/notepad/actions/extraCommands.test.ts`、`dialogs/PickerDialogs.test.tsx`
- `src/components/viewer/ViewerShell.test.tsx`（V-47：文本/源码/大文件挂载 Notepad，横幅与关闭守卫保留）
- `src/lib/notepad/host/viewerTabHost.test.ts`（V-46）

静态检查：`pnpm check:refactor` 通过（4910+ 文件，全部 ≤ 800 行）。

### 4.2 浏览器 QA（本机）

用例：`qa-ui-auto-tests/cases/TC-NP-*`（F-NOTEPAD-1～4），执行与结果见 QA 报告与 CI 记录。当前状态：见 §5。

### 4.3 GitHub 托管 CI（qa-ui-auto-platforms）

Windows / macOS / Linux 的 browser + native 由 `.github/workflows/qa-ui-auto-platforms.yml` 按选定 case ID 执行；结果与 shard 证据链接记录在 PR/checkpoint 提交说明中。未执行的平台保持“未验证”。

### 4.4 Linux 真机（Xvfb 隔离会话）

native 用例在独立 X11 会话（Xvfb `:n`）、独立 D-Bus（`dbus-run-session`）与独立数据/配置/缓存目录下运行，不接触 `:0` 桌面。

## 5. 未完成 / 下一步

1. TASK-NP-24：browser/native 三端用例跑通并回填证据；Windows/macOS 未执行项保留“未验证”。
2. 真机项 V-43～V-45、V-51（打印、提权、回收站、远程副本、大文件 5/12/35 MB、遗留草稿迁移）仍待执行。
3. 正则方言差异清单（DEC/§10）与“标记是否随会话保存”评审结论待补。
4. 原型“示意”部分（多光标、矩形选择、虚拟空格、系统打印、提权对话框）需真机逐项确认。
