# Taomni Notepad 工作台 详细设计（修订 2：宿主=每文件一个应用标签）

> 本文档是 `taomni-notepad-design.md`（v1.0）的**细化与替代设计**，不修改三份来源文档。开发任务板见 [taomni-notepad-development-tasks.md](taomni-notepad-development-tasks.md)，高保真交互原型见 [taomni-notepad-prototype.html](taomni-notepad-prototype.html)。
> 决策、验收、任务与验证 ID 在本设计内稳定。**本轮只做设计，没有实现任何产品代码，所有 V-* 均为待执行。**

## 1. 设计摘要与范围

- 类型：现有能力扩展（把 `file-viewer` 文本编辑能力扩展为类 Notepad++ 的多文档文本编辑工作台）+ 功能设计细化
- 文档位置：`docs-feature/notepad-2plus/taomni-notepad-detailed-design.md`
- 设计状态：**可实施**。用户已回复 DEC-01～DEC-04（见 §4.1）；DEC-22（A 方案下多文档类功能降级）已由用户确认接受。TASK-NP-25（viewer 文本编辑迁移）与 TASK-NP-26（打开方式选择器）为本次修订新增。
- 来源：
  - `docs-feature/notepad-2plus/adr-taomni-notepad.md`（ADR）
  - `docs-feature/notepad-2plus/taomni-notepad-decisions.md`（用户 2026-11-21 决策表：**89 支持 / 43 不支持 / 1 待定 = 移至回收站，共 133 项**）
  - `docs-feature/notepad-2plus/taomni-notepad-design.md`（v1.0 设计）
  - 用户请求：基于以上三份文档出新的详细设计（含 TASK-*）与高保真交互原型；只设计，不开发。
- 调研基线：工作区当前提交（2026-11-21，含未提交的上述文档与原型）；只读调研，未运行产品测试。v1.0 中与源码不符之处已在 §2 更正。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须三端可构建运行。
- 本轮真机执行端：当前环境为 **Linux（Replit）**。设计阶段不执行真机；后续实施以 Linux 为首个真机端，Windows / macOS 保留计划，未执行不单独阻塞交付。
- 推荐方案：**每个文件一个应用标签（DEC-01=A，用户已定）**。新增与宿主无关的单文档编辑组件 `NotepadEditor`（菜单栏、工具栏、查找条、编辑区、标签内分屏、面板、状态栏），经窄接口 `NotepadHost` 挂在应用标签中（当前以现有 `file-viewer` 标签承载，不新增 TabKind；宿主将与另一分支正在开发的 file explorer 对接）。内部复用现有 `file-viewer` 的文档读写 IPC、CodeMirror 6 编辑器与 `FindInFilesPanel`、Git/Viewer 已有的 `@codemirror/merge`；纯文本变换与命令注册放入新建共享库 `src/lib/notepad/`；文档键 `docId` = 路径键或 `untitled:<uuid>`，继续使用 `documentStore`。**现有 viewer 里简单的文本编辑器迁移到 Notepad 并移除（DEC-20）；Explorer 提供“打开方式”选择：系统默认 / Code editor / Notepad / TaOffice（开发中）（DEC-21）。**

**用户问题与完成后的可观察结果。** 用户希望 Taomni 内置一个能替代 Notepad++ 日常文本工作的编辑器：多文档标签、双视图、强力查找替换、行与列操作、编码与行尾转换、会话与自动备份、宏、文件对比、打印。完成后，用户能从文件管理器、终端链接、聊天链接等入口用 Notepad 打开文件，在其中完成上述 90 项能力（含用户已确认的“移至回收站”；其中 F-56/F-57/F-58/F-59/F-64 因“一个文件一个标签”而降级，见 DEC-22）；43 项被决策为“不支持”的功能**在 UI 中没有入口、没有占位菜单、没有“即将推出”文案**（DEC-16）。

**本次不做：** 语法高亮、折叠、自动完成、括号匹配、注释、缩进、语言菜单、UDL、插件体系、Run 菜单、监控模式、项目面板/文件夹工作区面板、隐藏行、始终置顶、右键菜单定制、命令行参数集、多实例设置、本地化切换、更新检查等 43 项（清单见 decisions 文件“❌ 不支持”行）。Notepad 内的多文档标签栏、跨文件分屏不做（由宿主应用标签承担，见 DEC-22）。TaOffice 本体不在本设计范围（另一团队开发，本设计只预留“打开方式”入口）。现有 viewer 里的图片 / SVG 渲染、Markdown 实时编辑器、HTML 预览不改；**但 viewer 中的简易文本编辑器（`TextEditor`）迁移到 Notepad 并移除**（AC-48）。

**设计与原型的关系。** 原型是**设计产物**，用于评审布局、交互与状态，不是产品实现，也不证明任何 AC 已满足。原型内标有“示意”的部分（见 §4.4）在实现时需要独立设计验证。

## 2. 当前实现与功能缺口

v1.0 把“现状”写得偏宽泛。以下为按源码核对后的**更正表**（核对方式：读取/检索，未运行）。

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/viewer/{ViewerShell,TextEditor,EditorSurface,ViewerDialogs}.tsx` | 单文件 viewer：一个文档对应一个界面；文本编辑基于 CodeMirror 6 | 编辑器表面复用，外壳（菜单、工具栏、标签内分屏、面板、状态栏）新建为 `NotepadEditor`；标签由宿主应用标签承担（DEC-01=A） | 源码检索，高 |
| `src/lib/viewer.ts` `ViewerDocument` | 文本编辑上限 5 MB，硬上限 20 MB，分块读取 256 KB | P0 沿用该上限（DEC-12）；50 MB 仅做 spike | 源码，高 |
| `src/lib/openFile/{index,classifyFile,closeGuard,pathIdentity,preferences,viewerCommands,useViewerRecovery}.ts` | 文件分类、关闭守卫、路径身份；`viewerCommands` **只有 `viewer.save` 一个命令**；`useViewerRecovery` 用 `taomni.viewer.tabs.v1` 做启动恢复 | 命令注册表在 `src/lib/notepad/` 新建，不扩展 `viewerCommands`；启动恢复复用并扩展 `useViewerRecovery` | 源码，高 |
| `src/stores/viewerDrafts.ts` | 草稿存 localStorage（`taomni.viewer.drafts.v1`），每次编辑写入**全文** | 大文件下不可扩展；由磁盘备份取代并做一次性迁移（DEC-14） | 源码，高 |
| 文档仓库 `documentStore`（以 `documentPathKey` 为键） | 路径即身份；`open/save/reload/checkExternal/keepMine/configure/readChunk` 均以路径为键；无法表示未命名文档 | DEC-01=A 后“一标签一文件”，**路径键继续沿用**；未命名文档使用 `untitled:<uuid>` 作为键并需验证 `documentStore` 能容纳无路径文档与“另存为后改键”（DEC-13 修订，S-1） | 源码，中（无路径文档的改造面待 S-1 确认） |
| `src-tauri/src/commands/viewer.rs` + `src-tauri/src/viewer/{text,chunks,filesystem,paths,temporary}.rs` | `viewer_stat / read_text / read_bytes / write_text / read_text_chunk / save_pasted_image / html_open / create_temp / temp_allocate` 等；`viewer_write_text` **要求传入完整 SHA-256 作 expectedHash** | 另存为/新建文件/覆盖、重命名、回收站、备份、哈希、提权保存需新增 IPC（§4.5） | 源码，高 |
| `src-tauri/src/workspace/{viewer_io,encoding}.rs` | 解码/编码与原子写入；`Cargo.toml` 已含 `encoding_rs`、`chardetng`、`sha2`、`sha1`、`md-5`、`trash = "5"` | 编码、哈希、回收站无需新增依赖 | 源码/Cargo.toml，高 |
| `src-tauri/src/filebrowser/local_ops/trash.rs` | 已有回收站实现 | F-03 如确认可直接复用 | 源码，高 |
| `src-tauri/src/{local_history,workspace_search}.rs`、`session/resume.rs` | 本地历史、工作区搜索、欢迎页运行快照（SQLite） | 查找文件内容复用 `workspace_search`；会话文件**不**复用 `session/resume.rs` | 源码，高 |
| `src-tauri/src/backup/` | 统一备份引擎（面向应用数据） | **不用于**记事本备份：语义不同（见 DEC-14），记事本备份目录独立 | 源码，高 |
| `src/components/editor/workspace/editorCommands/{lines,clipboard,carets,selection,keymap}.ts` | 工作区编辑器已有行操作、剪贴板、多光标、选区、键位 | 逐项评估“复用 / 抽取为共享纯函数”（TASK-NP-02） | 源码，高；复用度待逐项核对 |
| `.../searchPanel/{controls,filtering,history,panel,replacement,style}.ts`；历史键 `taomni.editorSearchHistory.v1` | 工作区查找面板 | 复用并共享搜索历史键，避免两套历史 | 源码，高 |
| `.../panels/FindInFilesPanel.tsx`、`GoToLineDialog.tsx`、`ClipboardHistoryPopup.tsx`、`KeymapSettingsDialog.tsx`、`FileEncodingDialog.tsx`、`ExternalFileConflictDialog.tsx`、`panels/TodosBookmarksPanel.tsx` | 工作区内已有对应对话框与面板 | 复用或抽取通用部分；Notepad 版本由 notepad 命令表驱动 | 源码，高 |
| `.../editorCompareModel.ts`（位于 workspace 目录） | 比较模型，大小上限 2 MB，来源：剪贴板/文件/本地历史/缓冲区 | 以 `@codemirror/merge`（`^6.12.2`）作为唯一 diff 内核（DEC-10），上限 5 MB | 源码，高 |
| Git `DiffViewer` + `ViewerDiff` | 已使用 `@codemirror/merge` | 复用同一内核 | 源码，高 |
| `src/components/WelcomePanel.tsx`、`welcome/RecentWorkspacesPanel`、`src/stores/app/recentWorkspaces.ts` | 有最近**工作区**，**没有最近文件 store** | 新增 `recentFiles` store（TASK-NP-05） | 源码，高 |
| `src/stores/app/tabsSlice.ts`（`guardViewerClose`）、`src/layouts/main/{usePlatformShortcuts,detachedWindows}.ts` | 应用级标签与快捷键、独立窗口；`openFile` 已对同一路径复用既有 `file-viewer` 标签（`existingViewer`） | Notepad **不新增 TabKind**；同路径去重、关闭守卫沿用；快捷键由 `NotepadEditor` 在其标签内处理（与 `ViewerShell` 的 Ctrl/Cmd+S 同法），不改 `usePlatformShortcuts` | 源码，高 |
| `src/components/settings/SettingsPanel.tsx`、`FileOpenSettings.tsx`、`src/lib/appTheme.ts` | 设置面板、文件打开偏好、主题 | Notepad 首选项作为设置面板新分页；主题沿用 `appTheme` | 源码，高 |
| `src/components/viewer/markdown/markdownExport.ts` `printMarkdownHtml` | 通过隐藏 iframe 打印 | 打印方案沿用该技术（TASK-NP-21 先 spike 三端表现） | 源码，高 |
| `zh-CN.ts:949` | 占位文案“本阶段尚未启用宏录制功能” | 宏实现后移除占位 | 源码，高 |
| Rust 侧无原生应用菜单 | 菜单均为 React 实现 | Notepad 菜单栏为 React 组件；不引入原生菜单 | 源码，高 |
| 测试与规则 | `pnpm test`、`pnpm exec vitest run <file>`、`pnpm build`、`pnpm check:refactor`、`cargo test --lib`；单文件 ≤ 800 行；崩溃回归套件；`qa-ui-auto-tests/cases` | 所有拟新增文件遵守 800 行限制；改动命令/IPC 须跑崩溃回归 | 仓库约定，高 |
| 依赖 | React 19、zustand 5、CodeMirror 6 | 不引入新编辑器 | package.json，高 |
| `src/components/viewer/ViewerShell.tsx` | 按 `viewer.mode==="source"`、`document.large`、`kind==="text"` 渲染 `TextEditor`（简易工具栏：保存/撤销/重做/查找/换行/字号/编码/EOL，“在 Workspace 中编辑”，大文件分块与 20 MB 确认）；`kind` 为 image/svg/markdown/html 时渲染对应查看器；外壳负责只读副本横幅与“另存为本地后编辑”、外部修改横幅、草稿恢复提示、`hosts` 引用计数、`checkExternal` 轮询（Tauri 下 500 ms）、`Ctrl/Cmd+S`、底部状态栏 | 迁移点：文本分支改挂 `NotepadEditor`；外壳横幅与引用计数保留；底部状态栏在 Notepad 分支由 `NotepadEditor` 自带状态栏取代（DEC-20） | 源码，高 |
| `src/components/viewer/TextEditor.tsx` | 仅被 `ViewerShell` 使用（检索确认） | 迁移完成后删除；`EditorSurface.tsx`/`ViewerDialogs.tsx` 是否仍被 Markdown 编辑器或 `ViewerDiff` 使用须在 TASK-NP-25 逐个核对后再删 | 源码，高 |
| `src/lib/openFile/{index,classifyFile,preferences}.ts` | `openFile()` 依次按 `options.mode ?? associations[ext] ?? defaultHandler` 选择；`FileHandler = "taomni"\|"workspace"\|"system"`；`classifyFile` 把 txt/log/ini/conf/env/json/yaml/toml/xml/csv 等归为 `text`，ts/py/go 等归为 `source`（进入 Code Workspace）；`supportsFileViewer` 为 image/svg/text/markdown/html；偏好存 `taomni.fileOpen.preferences.v1`，非法值被 `validated` 过滤 | 增加 `notepad` 与 `taoffice` 两种处理方式；`text` 类的 `taomni` 含义改为“Notepad”（存储键与既有值不变，无需迁移）；`mode:"source"` 作为 `notepad` 的别名保留一版（DEC-21） | 源码，高 |
| `src/components/settings/FileOpenSettings.tsx`、`src/components/explorer/fileOpenMenu.tsx` | 设置表按“文件类型组”选择处理方式（text 组、data 组名为“文本编辑器”）；Explorer 右键“打开方式”菜单含“Taomni <查看器>”、“Taomni 文本编辑器（源码）”、Code Workspace、系统默认应用与“记住”项 | 两处都要增加 Notepad 与 TaOffice（开发中，禁用）选项并改文案；这两个文件与 `ExplorerCommandBar.tsx`、`useExplorerOperations.ts` 由另一分支（file explorer）并行演进，实施前须先对齐（TASK-NP-26） | 源码，高；分支情况为只读核对：`feat/file-explorer` 的提示点已包含在当前工作区基线中，之后的改动以该分支为准 |

**调用链与数据归属（现状）。** 文件入口 `openFile` → `classifyFile` → 文本类进入 `file-viewer` 标签（`FileViewerTabInfo`）→ `ViewerShell` → `TextEditor` → `viewer_*` IPC。文档内容由 `ViewerDocument` 与 `documentStore`（路径为键）持有，草稿写 localStorage。工作区平台（workspace-platform）里也会承载 viewer。

**v1.0 与源码不一致处（已在上表更正）：** ① 宏占位文案与“宏尚未存在”的说明属实，但 v1.0 未指出 `viewerCommands` 仅有一个命令；② v1.0 把对比能力描述为“新写”，实际 Git DiffViewer 与 ViewerDiff 已有 `@codemirror/merge`；③ v1.0 没有指出 `documentStore` 以路径为键对未命名/克隆文档的约束；④ v1.0 没有指出 `viewer_write_text` 需要完整 SHA-256，影响另存为与新建文件的接口设计；⑤ 回收站相关基础设施已存在。

## 3. 验收条件

通用约定：除特别说明，下列行为在三端（Windows / macOS / Linux）一致；快捷键 `Mod` 在 Windows/Linux 为 Ctrl、macOS 为 Cmd。验收以真实应用行为为准，原型只作展示参考。

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | 工作台已打开 | 新建 / 打开 / 保存 / 另存为 / 保存副本 / 全部保存 / 重命名 | 新建得到“新建 N”未命名文档；保存未命名文档弹出另存为；**保存副本**写出新文件而当前文档继续指向原文件；**重命名**改变磁盘文件名并更新标签和最近文件；保存使用原子写入；磁盘中途变化时按 AC-09 提示而不是静默覆盖 | 三端；远程文件见 AC-09 |
| AC-02 | 打开了多个 Notepad 标签，含未保存文档 | 文件 → 关闭 / 全部关闭 / 关闭其他 / 关闭未修改 / 关闭左侧 / 右侧（经 `NotepadHost.requestClose`）；宿主标签栏的关闭操作 | 有未保存修改的文档逐个提示保存/不保存/取消；取消则整个批量操作终止；固定标签是否被保护取决于宿主是否提供固定能力（`capabilities.pinTabs`），Notepad 不自带固定；“关闭左侧/右侧/未固定”仅在宿主提供对应能力时出现 | 三端；DEC-22 |
| AC-03 | 已保存的本地磁盘文件（DEC-03 用户已定：实现） | 文件 → 移至回收站 | 二次确认后文档关闭、文件进入系统回收站（Windows 回收站 / macOS 废纸篓 / Linux 回收站）；未命名或远程文档该项禁用；失败给出可见错误且文档保持打开 | 三端；复用 `trash` crate 与 `filebrowser/local_ops/trash.rs` |
| AC-04 | 打开过若干文件 | 文件 → 最近文件；恢复最近关闭文件；打开全部最近文件；清空 | 列表按最近使用排序，数量受首选项上限限制；已不存在的文件点击后提示并可从列表移除；清空后列表为空且持久化 | 三端 |
| AC-05 | 打开了一组文档，含选区、滚动位置、书签、只读标记、分屏状态 | 保存会话 / 加载会话 | 会话保存为带 `version` 字段的 JSON；加载后以“每个文件一个应用标签”重新打开文件集合，恢复活动标签、各文档的分屏状态、选区、滚动、书签；缺失文件列出并跳过，不崩溃 | 三端；未命名文档的内容通过 AC-07 备份恢复 |
| AC-06 | 首选项“启动时恢复上次会话”开启 | 退出并重新启动应用 | 重新打开上次的文件集合与活动文档；关闭该选项后不恢复 | 三端 |
| AC-07 | 开启自动备份（默认 30 秒），有未保存修改 | 应用被强制结束后重启 | 未保存修改（含未命名文档）无需额外确认即恢复，标签保持“已修改”状态；备份在保存或正常关闭后清理；备份写盘不阻塞输入，大文件按 AC-13 降级 | 三端 |
| AC-08 | 首选项“保存时备份”：无 / 简单 .bak / 带时间戳 | 保存已有文件 | 按所选模式保留上一版本到指定目录；失败时提示且**不**阻止保存（或按首选项阻止，默认不阻止）；远程文件不备份 | 三端 |
| AC-09 | 已打开的磁盘文件被外部改动；以及打开远程文件 | 外部改动保存 / 窗口重新聚焦 / 手动从磁盘重载 | 无未保存修改时可选择自动重载或提示；有未保存修改时提示“重载 / 保留我的 / 对比”；手动重载丢弃未保存编辑并要求确认；**远程文件为只读临时副本，无写回、无备份，保存入口给出明确说明** | 三端 |
| AC-10 | 打开非 UTF-8 文件（如 GBK、UTF-16） | 打开时自动检测；编码 → 按编码重新解释 | 自动检测正确时文本不乱码；用户可手动按任意受支持编码重新解释，文本同步刷新；检测不确定时状态栏显示可疑标记；重新解释不改动磁盘 | 三端 |
| AC-11 | 文档已加载 | 编码 → 转换为 UTF-8 / UTF-8 BOM / UTF-16 LE/BE / ANSI（GBK 等） | 字符内容保持不变，保存后磁盘字节为目标编码；目标编码无法表示的字符在转换前提示数量与示例，用户可取消 | 三端 |
| AC-12 | 文档含 CRLF/LF/CR 混合行尾 | 行尾转换为 CRLF / LF / CR | 全文统一为目标行尾，混合行尾被修复；状态栏同步；撤销可还原 | 三端 |
| AC-13 | 打开 5 MB 以上文件 | 打开、滚动、查找 | ≤ 5 MB 完整编辑；5～20 MB 进入受限编辑模式（关闭变更历史、增量查找与自动备份降级为保存时备份，并有可见提示）；> 20 MB 拒绝以文本打开并给出原因；操作不卡死界面 | 三端；50 MB 仅 spike 结论，不作验收 |
| AC-14 | 拖入文件或文件夹 | 拖放到工作台 | 文件打开为新标签；文件夹按首选项打开其中文本文件，**上限 20 个**，超过时提示数量；二进制文件跳过并提示 | 三端 |
| AC-15 | 已保存的磁盘文件 | 在外部打开 / 在文件管理器中显示 / 在终端中打开所在目录 | 用系统默认程序、各平台文件管理器、当前平台的终端打开；未保存文档禁用 | 三端；Windows 额外提供 PowerShell/cmd 项，macOS/Linux 提供 Terminal |
| AC-16 | 需要更高权限才能写入的文件 | 保存 | 先显示“权限不足”，用户确认后经当前平台的提权机制保存（Windows UAC / macOS 授权对话框 / Linux pkexec 等，方式由 S-5 确定）；用户拒绝则保留未保存状态；**提权保存路径不得扩大写入范围**，仅写目标文件 | 三端；方案待 S-5 |
| AC-17 | 有文本内容 | 撤销/重做、剪切/复制/粘贴、删除、全选 | 行为与编辑器一致；无选区时 `Mod+C`/`Mod+X` 复制/剪切整行（可在首选项关闭） | 三端 |
| AC-18 | 多次复制 | 打开剪贴板历史；使用特殊粘贴 | 历史面板保留最近条目，双击粘回；特殊粘贴可粘贴剪贴板 HTML/RTF **源码**，二进制模式保留 NUL 等字符 | 三端；系统剪贴板格式差异见 §4.6 |
| AC-19 | 有文本 | 开始/结束选择（含列模式）、Alt+拖动矩形选择、`Mod`+点击多光标、多选下一个、拖动选区文本 | 选区行为符合 Notepad++ 手册描述；多光标处同时输入、复制、粘贴；拖动选区移动文本（可在首选项关闭）；矩形选区输入同时修改所有行 | 三端；macOS 的修饰键以 Cmd/Option 映射 |
| AC-20 | 有光标 | 插入日期时间（短/长/自定义）；Insert 切换插入/改写；虚拟空格；列编辑器 | 日期按所选格式插入；状态栏显示 INS/OVR；虚拟空格开启时光标可越过行尾且输入以空格补齐；列编辑器可对每行插入相同文本或递增数字序列（进制、前导零、步长、重复） | 三端 |
| AC-21 | 有多行文本 | 复制行 / 上移 / 下移 / 合并 / 拆分 / 插入空行；排序（7 种口径 × 升降序）；去重/连续去重/删空行/反转/随机打乱 | 作用于选区行；**无选区时对排序/去重类操作默认作用于全文并弹出确认（可勾选“不再提示”）**；排序稳定；一次操作可整体撤销 | 三端；DEC-09 |
| AC-22 | 有文本 | 8 种大小写转换；Trim 行首/行尾/两端；TAB↔空格（全部/仅行首）；行尾转空格 | 结果与 Notepad++ 手册一致；一次操作整体可撤销 | 三端 |
| AC-23 | 有文档 | 编辑器只读切换（当前/全部）；切换文件系统只读属性 | 编辑器只读时输入被拒并有提示；只读标记随会话保存；文件属性切换对不支持的平台/文件系统给出明确提示 | 三端；文件属性语义各平台不同 |
| AC-24 | 文档有修改与保存 | 变更历史边距；上一处/下一处变更；清除变更历史 | 边距以颜色区分“已改未保存 / 已改已保存 / 已还原”；导航与清除生效；大文件按 AC-13 降级时关闭并提示 | 三端 |
| AC-25 | 文档已打开 | 查找 / 替换 / 增量查找 / F3 与 Shift+F3 / 选中即查（含 Volatile）/ 搜索历史 / 紧凑与透明模式 | 命中高亮与计数正确；增量查找边输边跳；Volatile 不改动查找框内容；历史跨会话保留并与工作区编辑器共用；查找条可折叠为紧凑形态 | 三端 |
| AC-26 | 文档已打开 | 普通 / 扩展 / 正则模式；区分大小写、全词、循环、反向、仅选区、`.` 匹配换行 | 扩展模式正确解释 `\n \r \t \0 \xNN`；正则支持捕获组与反向引用 `${1}`；非法正则给出行内错误而非崩溃；复杂/灾难性正则不得卡死界面（有超时或中止） | 三端；正则方言差异见 §10 |
| AC-27 | 指定目录与文件过滤 | 在文件中查找 / 替换 | 复用工作区搜索；替换前显示每文件命中数并要求确认；写盘失败的文件逐项报告 | 三端 |
| AC-28 | 多个文档已打开 | 全部查找（当前/所有打开文档）；在所有打开文档中替换；搜索结果面板 | 结果按文件分组，双击跳转，F4/Shift+F4 逐条；替换前可逐项确认；全部替换可整体撤销（每文档一个撤销步） | 三端 |
| AC-29 | 有文本 | Mark 对话框（标记全部/清除/给行加书签/复制标记文本）；5 种令牌样式高亮、清除、跳转 | 标记颜色按样式区分；清除只清指定样式；标记默认不随会话保存（见 §10，评审时确认） | 三端 |
| AC-30 | 文档已打开 | 转到行/列/偏移 | 三种模式均可；超范围给出提示并定位到边界 | 三端 |
| AC-31 | 文档已打开 | 切换/跳转/清除书签；书签行剪切/复制/粘贴替换/删除/删除非书签行/反转 | 书签边距点击生效；批量操作整体可撤销；书签随会话保存。DEC-04 未决前书签与工作区编辑器书签保持两套 | 三端 |
| AC-32 | 已用 Notepad 打开多个文件（DEC-01=A） | 再次打开同一路径；修改文档；宿主标签栏拖动/固定/切换；Notepad 窗口菜单；文档列表面板 | **每个文件一个应用标签**；同一路径再次打开只激活既有标签（不重复）；标签标题为文件名，已修改时有标记，只读/远程文档有标记；标签的排序、拖动、固定、切换（含最近使用顺序切换）**由宿主标签栏提供**，Notepad 不重复实现；“窗口”菜单与文档列表面板列出全部已打开的 Notepad 标签，可按名称/路径/类型/长度/修改时间排序并点击激活（经 `NotepadHost.listDocuments/activateDocument`）；宿主不提供的能力（固定/排序/MRU）在 Notepad 菜单中不出现，也不弹“即将推出”（DEC-22） | 三端 |
| AC-33 | 一个文档已打开 | 视图 → 分屏（左右/上下）；克隆到另一窗格；旋转；同步滚动；关闭分屏 | 在**同一标签内**把当前文档显示为两个窗格：两窗格指向**同一缓冲区**，编辑与撤销栈同步，各窗格有独立滚动与选区；旋转切换左右/上下；同步滚动可开关；关闭一个窗格不丢文档；不提供“把另一个文件放进第二窗格”（跨文件并排请用“对比”AC-43 或打开两个标签） | 三端；S-2 验证两个 CodeMirror 视图共享状态 |
| AC-34 | 一个 Notepad 标签已打开 | 全屏 / Post-It / 专注模式 | 隐藏的界面元素与手册描述一致；退出键可恢复；状态随会话保持 | 三端；全屏在三端使用各自窗口 API |
| AC-35 | 有文本 | 行号与边距、垂直标尺、自动换行、缩放、显示空格/Tab/行尾/不可见字符/缩进线/折行标记 | 各开关即时生效；缩放仅作用于当前视图（可选跨视图同步）；标尺列可配置 | 三端 |
| AC-36 | 一个 Notepad 标签已打开 | 文档地图、文档列表、字符面板/搜索结果面板的停靠与浮动 | 面板可在**右侧、底部、浮动**三种位置之间切换（DEC-02 用户已定：限定型）；位置作为首选项全局保存，各标签一致；文档地图点击/拖动定位；文档列表显示全部已打开的 Notepad 标签，可排序、分组并切换（AC-32） | 三端；任意边缘/成组/拖动重排不在范围，已由用户接受 |
| AC-37 | 一个 Notepad 标签已打开 | 主题与深浅色；状态栏/工具栏/菜单栏显示开关；文件摘要 | 跟随应用主题（浅/深/跟随系统）；状态栏字段可点击切换；菜单栏可隐藏并能通过快捷键恢复；摘要显示完整路径、时间戳、字节/字符/词/行数 | 三端 |
| AC-38 | 文本含 URL / 路径 | 点击链接；选区动作；复制路径信息 | URL 经系统浏览器打开（可在首选项关闭）；选区动作支持打开文件/所在文件夹/联网搜索（搜索引擎可配）；复制文件名/路径/目录/全部路径 | 三端；只允许 `http/https` 及本地路径 |
| AC-39 | 有文本或选区 | 字符面板；选区脱敏；哈希（MD5/SHA-1/SHA-256/SHA-512）；Base64/Quoted-Printable/URL 编解码；ASCII↔十六进制等转换 | 结果可复制或替换选区；哈希可作用于文本、文件、选区；转换非法输入时给出错误而非静默改写 | 三端 |
| AC-40 | 一个 Notepad 标签已打开 | 录制 / 停止 / 回放；多次运行；运行到文件末尾 | 仅录制**白名单命令**（见 DEC-07）；弹窗类命令不可录并有提示；运行到文件末尾遇无进展时终止，不死循环 | 三端 |
| AC-41 | 已录制宏 | 保存宏并绑快捷键；改键；删除；执行已保存宏 | 宏出现在宏菜单；快捷键冲突时提示并不覆盖已有命令；删除需确认 | 三端 |
| AC-42 | 宏文件 `macros.json` 被外部修改 | 打开宏菜单 | 校验 SHA-256，不一致时警告并禁用执行，直到用户“校验宏文件”确认；**未经确认的宏文件永远不被执行** | 三端 |
| AC-43 | 当前文档 + 另一文件/剪贴板/选区 | 对比 | 并排差异（忽略空白/大小写可选），上一处/下一处差异；超过 5 MB 给出明确提示；对比不改动原文档 | 三端 |
| AC-44 | 有文档 | 打印 / 立即打印；打印设置；打印到 PDF | 打开系统打印对话框；设置项含行号、页边距、页眉页脚、颜色模式；PDF 通过系统“打印到 PDF”实现，**无应用内 PDF 引擎** | 三端；Linux 依赖 WebView 打印能力，见 §10 |
| AC-45 | 一个 Notepad 标签已打开 | 首选项对话框；快捷键映射器；新建文档默认值 | 首选项分页保存并立即生效；快捷键映射器检测冲突，可重置为默认；新建文档使用默认编码/行尾/命名规则 | 三端；macOS 默认键位使用 Cmd |
| AC-46 | 已有 file-viewer、Markdown、Git diff 能力 | 日常使用 | 现有查看器、Markdown、图片/HTML 预览、Git diff、工作区编辑器行为不退化；不出现 43 项“不支持”功能的任何入口；新增文件均 ≤ 800 行；崩溃回归套件通过 | 三端 |
| AC-47 | 三端构建 | 构建与运行 | 条件编译和平台 API（提权、回收站、文件管理器、终端）在三端可构建；缺少平台能力时降级路径有明确文案 | 三端 |
| AC-48 | 在 Explorer、终端链接、聊天链接、Git 文件操作、邮件附件等任一入口按默认方式打开 `classifyFile` 为 `text` 的文件（txt/log/ini/conf/env/json/yaml/toml/xml/csv 等），或打开 svg/markdown/html 的“源码”模式，或打开 >5 MB 的文本文件 | `openFile` | 在 `file-viewer` 标签内由 **Notepad 编辑器**打开；**不再出现旧 `TextEditor` 的简易工具栏**；旧 viewer 已有行为全部保留：只读/远程副本横幅与“另存为本地后编辑”、外部修改横幅（重新加载/比较差异/保留我的版本）、草稿恢复提示且不改动磁盘、5 MB 可编辑 / 5–20 MB 分块只读 / 超过 20 MB 确认或拒绝、编码与行尾显示、`Ctrl/Cmd+S`；图片、SVG 渲染、Markdown 实时编辑器、HTML 预览不变；`source` 类文件仍进入 Code Workspace；迁移前遗留的未保存草稿在升级后仍可恢复（DEC-14） | 三端；切换在 Notepad 达到旧编辑器功能对等后一次完成（TASK-NP-25） |
| AC-49 | Explorer 中选中文件 | 右键“打开方式”、设置 → 文件打开、双击（及 Ctrl/⌘+双击取另一种） | 菜单与设置列出：**系统默认 / Code editor（Code Workspace）/ Notepad / TaOffice**（以及该文件类型已有的查看器选项）；**TaOffice 在未提供前显示为禁用并带“开发中”标记**，点击无动作，不隐藏也不静默改用其他应用；选择后用对应应用打开；“记住”按扩展名写入关联，设置页可见可改，TaOffice 在设置里同样禁用；若已保存的关联指向当前不可用的处理器，打开失败时给出可见提示和“用系统默认应用打开”按钮；`.docx` 等二进制类型默认仍为系统默认应用；既有的 Markdown/HTML 选项与“记住”项不退化 | 三端；TaOffice 的可处理扩展名与调用契约由 TaOffice 团队提供（DEC-21） |

## 4. 方案与关键决策

**推荐实现。** 新增单文档编辑组件 `NotepadEditor`（DEC-01=A、DEC-19），由 React 实现菜单栏、工具栏、查找条、编辑区、标签内分屏、面板区与状态栏；它由 `ViewerShell` 在 `file-viewer` 应用标签中挂载，通过 `NotepadHost` 与宿主交互（标签标题/已修改标记、列出与激活其他 Notepad 标签、打开文件、批量关闭守卫）。编辑器表面沿用 CodeMirror 6；文档状态仍由 `documentStore` 按文档键持有，Notepad 专有状态（分屏、书签、标记、查找、宏、面板）放在新的 `notepadStore`（zustand，按 `docId` 分区；全局项如面板位置、宏、查找历史不属于单个文档）；所有“命令”统一登记到命令注册表，使菜单、工具栏、快捷键、宏录制、快捷键映射器共享同一份命令定义。文本变换（排序、去重、大小写、空白、行操作、列编辑序列生成、扩展模式转义解析等）写成**不依赖 DOM 的纯函数**，放在 `src/lib/notepad/`，使其可被单元测试，也可被宏回放复用。

### 4.1 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-00 功能范围 | 133 项功能中 89 支持 / 43 不支持 / 1 待定 | 按用户决策表执行 | 用户已定 | 用户 2026-11-21 决策表；用户本次请求 | 全部 AC；TASK-NP-* |
| DEC-01 宿主架构 | **A**：每个文件一个应用标签；**B**：专用 Notepad 工作台标签，内部自带文档标签与双视图 | **A（用户已定）**。宿主将放在另一分支正在开发的 file explorer 上，所以 Notepad 设计为与宿主无关的单文档组件，经窄接口 `NotepadHost`（§4.5）交互：不新增 TabKind、不改 `tabsSlice` 标签模型，多文档能力（标签栏、固定、排序、切换）由宿主应用标签承担。决策表中依赖“一个宿主多个文档”的 F-55～F-60、F-64 随之降级，见 DEC-22 | 用户已定 | 用户对 DEC-01 提问的回复（单选项未填，评论明确为“每个文件一个应用标签；宿主会放到正在开发的 file explorer 上”） | AC-32、AC-33；TASK-NP-15、NP-01 |
| DEC-02 面板停靠 | 限定型 / 通用停靠系统 | **限定型（用户已定）**：文档地图/文档列表/字符面板/搜索结果四个面板可在右侧、底部、浮动三处切换；决策表 F-70 的“任意边缘/成组/拖动重排”由此**部分满足，用户已接受缩范围** | 用户已定 | 用户对 DEC-02 提问的回复 | AC-36；TASK-NP-17 |
| DEC-03 移至回收站（F-03） | 做 / 不做 | **实现（用户已定）**：复用 `trash = "5"` 与 `filebrowser/local_ops/trash.rs`；F-03 从“待定”转为支持（P1），总功能数 90 | 用户已定 | 用户对 DEC-03 提问的回复 | AC-03；TASK-NP-04、S-6 |
| DEC-04 书签是否与工作区编辑器统一 | 先保持两套 / 统一 | **先保持两套（用户已定）**：Notepad 书签按文档存会话内；工作区编辑器书签（`TodosBookmarksPanel`）不动；统一另立后续任务 | 用户已定 | 用户对 DEC-04 提问的回复 | AC-31；TASK-NP-14 |
| DEC-05 核心实现而非插件；编辑器基于 CodeMirror 6 | 插件化 vs 核心 | 沿用 ADR：核心实现，CM6 | v1.0 提议（沿用） | `adr-taomni-notepad.md` | 全部 |
| DEC-06 共享库 `src/lib/notepad/` | 纯函数集中 vs 散在组件内 | 沿用 ADR | v1.0 提议（沿用） | ADR | TASK-NP-02 |
| DEC-07 宏安全模型 | 录制任意脚本 vs 仅录制已注册白名单命令 | 沿用 ADR：只记录白名单命令，存 `macros.json` 并以 SHA‑256 校验；外部改动后禁止执行直到确认 | v1.0 提议（沿用） | ADR | AC-40～42；TASK-NP-19；V-27～V-29 |
| DEC-08 会话文件格式 | XML（Notepad++ 同款）vs JSON | **JSON**，`.taomni-session.json`，含 `version` 字段便于迁移 | agent 自决 | v1.0 提议使用 JSON 的方向；`version` 字段为本设计补充，依据仓库其他持久化均带版本键 | AC-05；TASK-NP-08 |
| DEC-09 无选区的行操作 | 报错 / 仅作用当前行 / 默认全文并确认 | **默认全文并确认**，勾选“不再提示”后直接执行；与 Notepad++ 行为一致且避免静默大范围改动 | agent 自决 | Notepad++ 手册行为 + 防误操作 | AC-21；TASK-NP-02/03 |
| DEC-10 差异内核 | 自写 diff / `@codemirror/merge` | **以 `@codemirror/merge` 为唯一内核**，取代工作区 `editorCompareModel` 的独立实现；上限 5 MB | agent 自决 | Git DiffViewer 与 ViewerDiff 已使用该库 | AC-43；TASK-NP-20 |
| DEC-11 跨文件查找入口 | 新写 / 复用 | 复用 `FindInFilesPanel` 与 `workspace_search.rs` | agent 自决 | 源码 | AC-27；TASK-NP-13 |
| DEC-12 大文件阈值 | 沿用 5/20 MB / 提高到 50 MB / 更高 | **P0 沿用 5 MB 可编辑、20 MB 硬上限、256 KB 分块**；50 MB 仅作 spike S-4，不承诺 | agent 自决 | `ViewerDocument` 现有常量；决策表 F-13 为 P1 | AC-13；TASK-NP-00(S-4)、TASK-NP-23 |
| DEC-13 文档身份 | 路径为键（沿用）/ 全新 `docId` | **`docId` = 文档键**：路径文档沿用 `documentPathKey`；未命名文档为 `untitled:<uuid>`；继续使用 `documentStore`，不引入第二套文档仓库。DEC-01=A 后一标签一文件，原先“克隆/双视图需要脱离路径键”的理由消失，改为只需验证无路径文档与“另存为后改键”（S-1）；克隆在标签内由同一文档的两个 CodeMirror 视图实现 | agent 自决（随 DEC-01 修订） | `documentStore` 以路径为键；DEC-01=A | AC-01、AC-33；TASK-NP-00(S-1)、TASK-NP-01 |
| DEC-14 草稿与备份 | 继续 localStorage / 磁盘备份 | **磁盘备份**取代 `taomni.viewer.drafts.v1`，保留一次性迁移；不复用 `backup/` 统一备份引擎（语义不同） | agent 自决 | localStorage 每次编辑写全文，大文件不可扩展 | AC-07、AC-08；TASK-NP-09 |
| DEC-15 远程文件 | 允许写回 / 只读临时副本 | **只读临时副本，无写回、无备份** | v1.0 提议（沿用） | ADR | AC-09；TASK-NP-07 |
| DEC-16 不支持项的呈现 | 灰显占位 / 完全不出现 | **完全不出现**（无菜单项、无设置项、无“即将推出”） | 用户已定（随决策表的“不支持”决定）；呈现方式沿用 ADR | 决策表；ADR | AC-46；TASK-NP-24；V-38 |
| DEC-17 Windows 特有功能的跨平台表达 | 仅 Windows / 跨平台等价 | UAC 保存、回收站、外部打开等改为三端等价能力；macOS 使用 Cmd 键位 | v1.0 提议（沿用） | ADR / v1.0 | AC-15、AC-16、AC-45 |
| DEC-18 原型范围 | 全部交互 / 核心交互 + 示意 | 核心交互真实可操作，难以在 HTML 中真实呈现的（多光标、矩形选择、虚拟空格、系统打印、提权对话框）为“示意”，并在原型“原型覆盖范围”抽屉中列明 | agent 自决 | §4.4 | 无（设计评审用） |
| DEC-19 宿主接口 | 新增 TabKind / 复用 `file-viewer` 标签并经 `NotepadHost` 接口接入 | **复用 `file-viewer` 标签（含 workspace-platform 的 viewer 标签），不新增 TabKind**；`NotepadEditor` 只依赖 `NotepadHost` 接口，默认实现 `viewerTabHost` 读写 `appStore.tabs`/workspace 标签。假设：用户说的“宿主放到正在开发的 file explorer 上”指标签由 file explorer 所在的应用壳承载；若该分支最终采用独立 TabKind，只需新增一个 `NotepadHost` 实现，编辑器不变 | agent 自决（含一条对用户措辞的假设） | 用户 DEC-01 评论；`openFile` 现有 `file-viewer` 标签与 `existingViewer` 去重 | AC-32；TASK-NP-15 |
| DEC-20 viewer 文本编辑迁移 | 保留旧 `TextEditor` 与 Notepad 并存 / 迁移并移除 | **迁移并移除（用户已定方向）**：`classifyFile` 为 `text` 的文件、svg/markdown/html 的“源码”模式、>5 MB 的受限文本都改由 `NotepadEditor` 编辑；图片、SVG 渲染、Markdown 实时编辑器、HTML 预览保持。细节（agent 自决）：① 切换在 Notepad 与旧编辑器功能对等后一次完成（TASK-NP-25 最后落地），期间旧编辑器保持可用；② 旧的“在 Workspace 中编辑”改为 Notepad 文件菜单“用 Code editor 打开”；③ 不新增并存开关 | 用户已定（方向）+ agent 自决（细节） | 用户对 DEC-01 提问的评论：“需要设计将原来简单的用于编辑文本类文件（非代码）editor 功能从现有 viewer 移除并迁移到 notepad 中支持” | AC-48；TASK-NP-25 |
| DEC-21 打开方式选择器 | 仅沿用 taomni/workspace/system / 扩展为 Notepad 与 TaOffice | **扩展（用户已定）**：`FileHandler` 增加 `notepad`、`taoffice`；`taomni` 在 `text` 类中含义为 Notepad，存储键与旧值不变；注册表 `FileHandlerRegistry` 允许 TaOffice 日后注册可处理的扩展名与 `open()`；注册前 TaOffice 选项禁用并标“开发中”（不是 DEC-16 中的“不支持”项：它是用户明确要求的预留入口）；保存的关联指向不可用处理器时**可见报错，不静默降级**。TaOffice 预留扩展名（假设，待 TaOffice 团队确认）：docx/doc/xlsx/xls/pptx/ppt/odt/ods/odp/rtf/csv/tsv | 用户已定（选项集合）+ agent 自决（注册表与预留扩展名） | 用户评论：“可在 file explorer 中选择使用的应用：系统默认 / code editor / taoffice（TaOffice in development）” | AC-49；TASK-NP-26 |
| DEC-22 一文件一标签下的多文档类功能 | 接受降级 / 要求 Notepad 内多文档 / 增加跨文件分屏 | **用户已定：接受降级**（原推荐方案）：F-55 多文档界面由宿主应用标签满足；F-57 切换器与 F-56 固定由宿主提供（无则不出现）；F-58 双视图与 F-59 克隆收敛为“同一文档的标签内分屏”；F-60 同步滚动保留；F-64 文档列表列出全部已打开 Notepad 标签。**这收窄了 decisions 表中这些条目的范围，需要用户确认**；若要求“第二窗格可放另一个文件”，作为独立增量任务（影响 `documentStore` 多文档同屏与撤销栈归属） | **待用户确认** | DEC-01=A 的直接后果；decisions 表 F-55～F-60、F-64 | AC-32、AC-33、AC-36；TASK-NP-15 |

> **用户答复已并入本表（DEC-01～DEC-04、DEC-22）；目前没有待用户确认的决策。**DEC-19/20/21 的“假设/细节”部分为 agent 自决，用户可随时推翻，推翻后同步更新本表、§4.2、§6 受影响任务、§9。

### 4.2 用户流程与交互

**入口（DEC-01=A）。** 文件管理器右键“打开方式 → Notepad”、双击 `text` 类文件（默认）、终端/聊天/Git 等入口的文件链接、命令面板“新建 Notepad 文档”、欢迎页“新建”、拖放文件到应用；每个文件在一个应用标签中打开，同一路径复用既有标签。`NotepadEditor` 内部：菜单栏（文件/编辑/搜索/视图/编码/工具/宏/对比/窗口）、工具栏、查找条、编辑区（可在标签内分屏）、右侧/底部/浮动面板、状态栏（行列、选区、字符数、EOL、编码、INS/OVR、缩放、备份状态）。“文件 → 用其他应用打开”列出系统默认 / Code editor / TaOffice（开发中，禁用）。

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 无文档 | 打开工作台 | — | 显示最近文件与“新建”空态 | 最近文件不存在 → 提示并可移除 |
| 文档已修改 | 保存 | 路径存在且磁盘未变 | 原子写入，标签“已修改”标记消失，变更历史边距变绿 | 磁盘已变 → AC-09 对话框；无权限 → AC-16 流程；写入失败 → 错误条，文档保持已修改 |
| 文档已修改 | 关闭标签 | — | 弹出保存/不保存/取消 | 取消 → 保持打开 |
| 文档打开 | 外部改动被检测 | 窗口聚焦或保存前 | 顶部横幅：重载 / 保留我的 / 对比 | 关闭横幅 → 标记为“与磁盘不同步”，保存时再提示 |
| 编辑中 | 开始录制 | 命令白名单 | 工具栏与菜单栏出现“录制中 · N 步”；弹窗命令被拒绝并提示 | 停止后可回放/保存 |
| 单文档标签 | 视图 → 分屏 / 克隆到另一窗格 | 当前文档已打开 | 同一标签内出现第二窗格，两窗格共享同一缓冲区与撤销栈 | 关闭一个窗格不丢文档 |
| 应用异常退出后重启 | 启动 | 存在备份 | 恢复文档并标记已修改，状态栏提示“已从备份恢复” | 备份损坏 → 跳过该项并提示 |
| 文件 > 5 MB | 打开 | 在 5～20 MB 之间 | 顶部提示进入受限编辑模式并列出被关闭的功能 | > 20 MB → 拒绝并说明 |
| 任一入口 | 打开 `text` 类文件（默认方式） | 偏好未改为系统/Code editor | 在 `file-viewer` 标签内由 Notepad 编辑器打开；已有同路径标签则激活 | 读取失败 → 沿用 `ViewerShell` 错误页（重试/系统应用/在 Explorer 中显示） |
| Explorer 文件 | 右键 → 打开方式 | 文件存在 | 列出系统默认 / Code editor / Notepad / TaOffice（开发中，禁用）；选择后打开；可勾选“记住” | 所选处理器不可用 → 可见提示 + “用系统默认应用打开” |
| Notepad 内 | 窗口菜单 → 选择另一个文档 | 宿主已有其他 Notepad 标签 | 激活该标签（`NotepadHost.activateDocument`） | 目标标签已被关闭 → 列表刷新，不报错 |

键盘与焦点：所有对话框 `Esc` 取消、`Enter` 确认；查找条可用 `Esc` 关闭并把焦点还给编辑器；`Alt+字母` 打开菜单栏（macOS 无此行为，保留 Cmd 快捷键）；IME 组合输入期间不触发快捷键和宏录制。

### 4.3 数据流、状态与生命周期

- **权威状态**：文档内容、编码/EOL、已修改与外部变更状态仍由 `documentStore`（按 `docId` 键）持有；Notepad 专有状态在 `notepadStore`（拟新增，zustand）：`docs: Record<docId, NotepadDocState>`（分屏开关与方向、同步滚动、各窗格选区与滚动、书签、标记、变更历史）、`panels`（位置与显隐，全局偏好）、`ui`（菜单栏/工具栏/状态栏显隐、全屏/Post-It/专注，全局偏好）、`find`（查找条状态，每标签一份）、`macro`（录制缓冲与已保存宏，全局；录制绑定到开始录制的标签，切到其他标签时暂停并提示）。标签顺序、固定、最近使用顺序**不在** `notepadStore`，由宿主持有。
- `NotepadDoc`（与 `documentStore` 的文档合成视图）：`docId`、`path?`、`name`、`encoding`、`bom`、`eol`、`readOnly`（编辑器内）、`remote`（只读临时副本）、`bookmarks`、`marks`、`savedHash`（上次保存/加载时磁盘内容 SHA-256）、`dirty` 派生自缓冲区与 `savedHash`/编码/行尾；`pinned` 不属于文档，由宿主标签持有（有 `pinTabs` 能力时）。**克隆/分屏**：同一 `docId` 的两个 CodeMirror 视图，各自有选区与滚动；两视图共享同一份编辑状态与撤销栈（需 S-2 验证；若 CM6 不能共享，改为共享 `Transaction` 流）。**未命名文档**：键为 `untitled:<uuid>`，标签标题为“新建 N”，保存时走“另存为”并把键改为路径键。
- **持久化**：
  - 会话：`.taomni-session.json`（带 `version`，保存时写入用户选定位置，自动会话写入应用数据目录）。
  - 备份：应用数据目录下 `notepad/backups/<docId>/<ts>`；周期默认 30 秒；保存或正常关闭后清理；崩溃后启动时扫描并恢复。
  - 宏：`macros.json` + 外部 SHA-256 记录；外部修改检测发生在打开宏菜单与启动时。
  - 最近文件、首选项、查找历史（复用 `taomni.editorSearchHistory.v1`）。
  - 一次性迁移：读取 `taomni.viewer.drafts.v1` 的草稿，转成备份后清除。
- **读写时机**：打开→`viewer_read_text`/分块读取；保存→新增写入 IPC（带 `expectedHash`，覆盖标志）；备份→后台定时、不阻塞输入、按文档脏标记节流；外部变更检测→窗口聚焦与保存前（不轮询，不做监控模式）。
- **并发与过期**：每次读写携带请求序号；保存期间再次编辑，保存完成后 `savedHash` 取**写入时的内容哈希**，保存完成后若缓冲区已变化文档仍保持已修改；异步搜索/替换/哈希对已关闭文档的响应丢弃。
- **句柄释放**：关闭文档时取消其备份计时器、搜索任务与 CM 视图；工作台卸载时统一取消；崩溃恢复不依赖卸载钩子。

### 4.4 原型与示意图

- 当前有效图稿：[`taomni-notepad-prototype.html`](taomni-notepad-prototype.html)（单文件、可直接用浏览器打开；**v3，按 DEC-01=A 重画**：顶部为宿主应用标签栏，每个文件一个标签；“打开方式”对话框含系统默认 / Code editor / Notepad / TaOffice（开发中）；覆盖浅色/深色、Windows/Linux 与 macOS 键位切换；推荐窗口宽度 ≥ 1280 px）。
- 图稿决策：DEC-18（agent 自决）；DEC-01～04 已由用户答复并体现在 v3；DEC-22（降级范围）已由用户确认接受，原型按此绘制。
- 原型内入口：顶部“场景”按钮可触发外部修改、崩溃恢复、宏文件被改、远程文件、12 MB / 35 MB 大文件、需提权文件、GBK 文件；新增“打开方式”按钮演示 Explorer 选择器；“待确认决策”按钮展示已定结论与仍未确认的假设；“原型覆盖范围”按钮列出真实交互与示意内容。
- 原型中**真实可操作**：宿主应用标签（每文件一个标签、同路径去重、关闭守卫）、新建/保存状态、另存/重命名/关闭系列、最近文件、查找替换（普通/扩展/正则、全部查找、结果面板、标记、令牌样式）、行操作与大小写与空白、排序与去重、书签、变更历史边距、标签内分屏/克隆/同步滚动、面板（文档地图/列表/字符/结果）停靠位置、显示符号、全屏/Post-It/专注、编码重新解释与转换、行尾转换、宏录制/回放/保存/校验、对比、打印预览、首选项、快捷键映射器、会话保存/加载、备份与崩溃恢复、哈希/MIME、移至回收站、打开方式选择器（含 TaOffice 禁用态）。
- 原型中**仅示意**：多光标（只会选中下一个同名词）、矩形选择（用多行选区代替）、虚拟空格、特殊粘贴、开始/结束选择（近似）、提权保存（只有对话框）、回收站（只演示确认与关闭，不进入系统回收站）、系统打印/PDF（不调用）、宿主标签的固定与最近使用切换（宿主能力，原型仅示意一个固定按钮）。43 项不支持功能**没有任何入口**。
- 修订记录：v1 → v2：补入双视图旋转、面板位置切换、宏安全、崩溃恢复场景与“原型覆盖范围”抽屉；v2 → v3（本次）：宿主从“专属工作台标签”改为“每文件一个应用标签”，内部文档标签条/MRU/跨文件双视图移除，分屏改为同一文档的标签内分屏，窗口菜单与文档列表改为列出宿主标签，新增“打开方式”选择器与回收站；v1、v2 已被替代。
- 评审限制：原型评审不等于实现通过；所有 AC 在实现前保持“未实现”。

### 4.5 接口与共享契约

以下名称为**拟新增，最终命名在实现时确定**；Rust 侧复用 `viewer/` 模块并放在 `commands/viewer.rs`（或按 800 行限制拆出 `commands/notepad.rs`）。

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `viewer_write_text`（现有） | 前端 → `commands/viewer.rs` | 路径、内容、`expectedHash`（完整 SHA-256） | 成功返回新哈希；哈希不符返回冲突错误 | 保持不变，已有调用者不受影响 |
| `viewer_save_as`（拟新增，含覆盖标志） | `notepadStore` → Rust | 目标路径、内容、编码、BOM、EOL、`overwrite:boolean` | 新哈希；目标已存在且未允许覆盖 → 明确错误码 | 不改现有写入命令语义 |
| `viewer_rename`（拟新增） | 同上 | 原路径、新名称 | 新路径；跨设备/已存在返回错误 | 原路径变化需更新最近文件与会话 |
| `viewer_trash`（拟新增，**DEC-03 确认后**） | 同上 | 路径 | 成功/失败；复用 `trash` crate | 与 `filebrowser/local_ops/trash.rs` 共享实现 |
| `notepad_backup_write / list / read / prune`（拟新增） | 备份调度 → Rust | `docId`、内容、编码/EOL、序号 | 备份项列表；写入失败返回但不阻塞编辑 | 与 `backup/` 引擎无共享 |
| `notepad_hash`（拟新增） | 工具箱 → Rust | 算法（md5/sha1/sha256/sha512）、文本或文件路径 | 十六进制摘要 | 使用已存在的 `md-5/sha1/sha2` crate |
| `notepad_list_encodings`（拟新增） | 编码对话框 → Rust | — | 受支持编码列表（来自 `encoding_rs`） | 与 `workspace/encoding.rs` 一致 |
| `viewer_set_readonly_attr`（拟新增） | 只读切换 → Rust | 路径、布尔值 | 成功/平台不支持 | Windows 属性位；Unix 权限位 |
| `viewer_write_text_elevated`（拟新增，方案待 S-5） | 保存 → Rust | 同 `viewer_save_as` | 成功/用户拒绝/平台不支持 | 严格限定写入目标 |
| 命令注册表 `NotepadCommand`（拟新增，TS） | 菜单/工具栏/快捷键/宏 → `src/lib/notepad/commands` | `id`、`label`、`defaultKey`、`recordable`、`run(ctx,args)` | 返回编辑事务或副作用描述 | 所有 UI 入口只调用 `run`；宏仅回放 `recordable` |
| 宿主接口 `NotepadHost`（拟新增，TS） | `NotepadEditor` → 宿主（默认 `viewerTabHost`） | 见下方类型；`requestClose(docIds)` 逐个走保存确认，任一取消整体取消 | `listDocuments` 返回宿主中全部 Notepad 标签；`capabilities` 声明宿主是否提供固定/排序/最近使用切换 | 不提供的能力 Notepad 不渲染对应菜单项；接口不得暴露 `tabsSlice` 内部结构，宿主改用其他 TabKind 时只换实现 |
| `FileHandlerRegistry`（拟新增，`src/lib/openFile/handlers.ts`） | `openFile`、`fileOpenMenu`、`FileOpenSettings` → 注册表 | 处理器 `id`（`taomni`/`workspace`/`system`/`notepad`/`taoffice`）、`label`、`extensions`、`available()`、`open(path)` | `available()===false` 的处理器在菜单与设置中禁用并标“开发中”；`openFile` 遇到不可用处理器返回可见错误 | `FileOpenPreferences` 存储键与已有值不变；`validated` 白名单增加 `notepad`、`taoffice` |
| 浏览器 QA stub | `src/stubs/commands/*`、`src/stubs/tauri-core.ts`（`viewer_` 前缀走 `invokeViewer`） | 新增命令需在 stub 中补齐 | 与真实 IPC 同形的结果 | 未补 stub 的命令不得在浏览器 QA 中被调用 |

类型签名（拟）：

```ts
type DocId = string;
interface NotepadDoc { docId: DocId; path?: string; name: string; encoding: string; bom: boolean;
  eol: 'LF'|'CRLF'|'CR'; readOnly: boolean; remote: boolean;
  savedHash?: string; bookmarks: number[]; }
interface NotepadCommand { id: string; label: string; defaultKey?: string; recordable: boolean;
  run(ctx: CommandContext, args?: Record<string, unknown>): void; }
interface NotepadHost { capabilities: { pinTabs: boolean; reorderTabs: boolean; tabSwitcher: boolean };
  setTabState(docId: DocId, s: { title: string; dirty: boolean; readOnly: boolean }): void;
  listDocuments(): { docId: DocId; path?: string; active: boolean }[];
  openDocument(t: { path?: string; untitled?: boolean }, o?: { line?: number }): Promise<DocId>;
  activateDocument(docId: DocId): void;
  requestClose(docIds: DocId[]): Promise<boolean>;   // 逐个保存确认，取消则整体取消
  pinTab?(docId: DocId, pinned: boolean): void; }
type FileHandler = 'taomni'|'workspace'|'system'|'notepad'|'taoffice';
interface SessionFileV1 { version: 1; active?: DocId; docs: SessionDoc[]; /* SessionDoc: path、split、orient、selection、scroll、bookmarks、readOnly、encoding、eol */ }
```

### 4.6 三端兼容与相关存储、故障边界

- **Windows**：提权保存（UAC，细节待 S-5）；回收站；文件管理器与 cmd/PowerShell 打开；只读属性位。
- **macOS**：Cmd 键位（`Mod` 映射）；提权保存使用系统授权；废纸篓；Finder 显示；终端打开 Terminal。
- **Linux**：提权方式（pkexec / polkit，S-5）；回收站（freedesktop）；文件管理器按 `xdg-open`；IME（fcitx5/ibus）组合输入不触发快捷键；WebView 打印能力有限，需 spike（TASK-NP-21）。
- **共同**：路径差异（大小写、分隔符）通过 `pathIdentity` 统一；原子写入使用同目录临时文件并替换；备份目录权限仅当前用户。
- **故障边界**：备份写失败只提示不阻塞；会话文件损坏时忽略并提示；宏文件被改 → 禁用；磁盘已满 → 保存失败保留脏状态；崩溃重启扫描备份。
- **浏览器 QA stub**：新增 IPC 必须同步 `src/stubs/commands/` 并保持返回结构一致。

## 5. 改动清单

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/lib/notepad/`（拟新增，含 `transforms/`、`commands/`、`search/`、`macro/`、`session/`） | 纯函数与命令注册表；不依赖 DOM；每文件 ≤ 800 行 | AC-17～AC-45 | TASK-NP-02/03 等 |
| `src/stores/notepadStore.ts`（拟新增） | 按 `docId` 分区的 Notepad 专有状态（分屏、书签、标记、查找）与全局偏好（面板、宏）；不重复持有文档内容 | AC-01、AC-33 | TASK-NP-01 |
| `src/components/notepad/`（拟新增） | `NotepadEditor`、`MenuBar`、`Toolbar`、`SplitPanes`、`StatusBar`、`FindBar`、`panels/*`、`dialogs/*`；**不含**标签栏 | AC-32～AC-37 | TASK-NP-15/16/17 |
| `src/lib/notepad/host/`（拟新增：`NotepadHost` 接口与 `viewerTabHost` 实现）；`src/components/viewer/ViewerShell.tsx` | 文本分支改挂 `NotepadEditor`；**不新增 TabKind**，不改 `tabsSlice` 标签模型；标签标题与已修改标记经 `setTabState` 回写；`FileViewerTabInfo` 可能需增加未命名文档字段（待 S-1） | AC-32、AC-48 | TASK-NP-15/25 |
| `src/lib/openFile/{index,preferences,classifyFile}.ts`、拟新增 `handlers.ts`、`useViewerRecovery.ts` | 扩展恢复；`FileHandler` 增加 `notepad`/`taoffice`；`text` 类默认进入 Notepad；`mode:"source"` 为 `notepad` 别名；`openFile` 对不可用处理器报可见错误 | AC-06、AC-14、AC-48、AC-49 | TASK-NP-08/23/25/26 |
| `src/components/viewer/TextEditor.tsx`（删除）、`EditorSurface.tsx`/`ViewerDialogs.tsx`（逐个核对使用者后保留或删除）、`ViewerShell.test.tsx` 等既有测试 | 旧简易文本编辑器随迁移移除；测试改为断言文本类由 Notepad 编辑器挂载、横幅与分块行为保留 | AC-48 | TASK-NP-25 |
| `src/components/settings/FileOpenSettings.tsx`、`src/components/explorer/fileOpenMenu.tsx`、`ExplorerCommandBar.tsx` | “文本编辑器”组改称 Notepad；选项增加 Notepad 与 TaOffice（开发中，禁用）；“Taomni 文本编辑器（源码）”改为“Notepad 打开源码”；与 file explorer 分支并行修改，需先对齐 | AC-49 | TASK-NP-26 |
| `src/stores/viewerDrafts.ts` | 增加迁移读取，之后停用写入 | AC-07 | TASK-NP-09 |
| `src/stores/app/recentFiles.ts`（拟新增） | 最近文件 store 与持久化 | AC-04 | TASK-NP-05 |
| `src/components/editor/workspace/*` | 仅在抽取共享纯函数时调整导入；**行为保持不变** | AC-46 | TASK-NP-02 |
| `src/components/settings/SettingsPanel.tsx` | 新增 Notepad 首选项分页 | AC-45 | TASK-NP-22 |
| `src-tauri/src/commands/viewer.rs`（及拟新增 `commands/notepad.rs`） | 新 IPC（§4.5）；注册到 invoke handler | AC-01～AC-16 | TASK-NP-04/07/09/23 |
| `src-tauri/src/viewer/*`、`workspace/viewer_io.rs`、`workspace/encoding.rs` | 复用；原子写入与编码列表 | AC-10、AC-11 | TASK-NP-06 |
| `src-tauri/Cargo.toml` | **不新增依赖**（编码/哈希/回收站已有）；提权方案如需依赖须在 S-5 后评审 | AC-16 | TASK-NP-00 |
| `src/stubs/commands/*`、`src/stubs/tauri-core.ts` | 补齐新增命令的 browser stub | 全部 | 各 IPC 任务 |
| `src/i18n/zh-CN.ts`（及对应英文） | 文案；删除宏占位 | AC-40 | 各 UI 任务 |
| `qa-ui-auto-tests/cases/`（拟新增） | 逐功能的 UI 测试用例 | AC-* | TASK-NP-24 |

## 6. 实现任务与交接

任务编号 `TASK-NP-xx`。任务板（状态、依赖、波次）见[开发任务板](taomni-notepad-development-tasks.md)；以下为每个任务的完整交接说明。所有任务启动前须再次核对源码（本文 §2 来源于 2026-11-21 的只读调研）。

### TASK-NP-00 技术 spike（S-1～S-6）

- 职责与文件范围：只产出结论文档与一次性原型，不合入产品代码；结论写入 `docs-feature/notepad-2plus/spikes/`（拟新增）。
- 输入与必读：§2、§4.3；`documentStore`、`CodeMirrorHost.tsx`、`markdownExport.ts`、`viewer_io.rs`、`filebrowser/local_ops/trash.rs`。
- 依赖：无。
- 实施内容：S-1 `documentStore` 容纳无路径（`untitled:<uuid>`）文档与“另存为后改键”的改造面（DEC-13 修订：路径键继续沿用）；S-2 同一文档的两个 CM 视图共享状态与撤销栈（标签内克隆）可行性；S-3 文档地图（minimap）实现方案与性能；S-4 20～50 MB 文件的分块编辑/只读浏览可行性（DEC-12，只做结论）；S-5 三端提权保存方案与安全边界；S-6 回收站在三端的行为与失败模式（DEC-03 已定，复用 `trash` crate）。
- 对应验收：AC-01、AC-13、AC-16、AC-33、AC-36。
- 验证与完成条件：每个 spike 给出“可行/不可行/需调整”结论、证据（命令输出或截图路径）与对设计的修订建议；V-39。
- 并行与集成：S-1～S-6 互相独立，可并行；结论回流到本设计的 DEC/风险。

### TASK-NP-01 文档身份与 store

- 职责与文件范围：`src/stores/notepadStore.ts`、`src/lib/notepad/doc/`；不改 `documentStore` 现有调用者的键语义。
- 输入与必读：§4.3、DEC-13、S-1 结论。
- 依赖：TASK-NP-00（S-1）。
- 实施内容：定义 `NotepadDocState`（分屏、书签、标记、变更历史）与脏状态派生；未命名文档命名规则（`新建 {n}`）与 `untitled:<uuid>` 键；同一 `docId` 的两个窗格共享同一缓冲区；与 `documentStore` 的适配层（路径文档仍可被其他入口读取）。不含标签顺序与 MRU（宿主持有）。
- 对应验收：AC-01、AC-33。
- 验证与完成条件：V-01、V-02；`pnpm exec vitest run` 新增单测通过。
- 并行与集成：只有本任务改 `notepadStore.ts`，其他任务通过 selector 读取。

### TASK-NP-02 共享文本变换纯函数

- 职责与文件范围：`src/lib/notepad/transforms/*`（排序 7 口径、去重/连续去重/删空行/反转/打乱、8 种大小写、Trim/TAB↔空格/行尾转空格、行合并/拆分、列编辑序列生成）；必要时从 `editorCommands/lines.ts` 抽取并保持工作区行为不变。
- 输入与必读：`editorCommands/lines.ts`、决策表 F-29～F-33。
- 依赖：无。
- 实施内容：每个函数输入文本与选区范围，输出新文本与新选区；排序稳定；列选区按列键排序；本地化排序使用 `Intl.Collator`；随机打乱可注入随机源以便测试。
- 对应验收：AC-21、AC-22、AC-20（序列生成）。
- 验证与完成条件：V-03～V-06；与原工作区行操作回归（V-37）。
- 并行与集成：可与 TASK-NP-00 并行。

### TASK-NP-03 命令注册表、键位与接线

- 职责与文件范围：`src/lib/notepad/commands/*`、`NotepadCommand`、菜单/工具栏数据定义、F-17/F-18/F-21 的 CM6 内置命令接线。
- 输入与必读：§4.5；`editorCommands/keymap.ts`；`usePlatformShortcuts.ts`。
- 依赖：TASK-NP-01、TASK-NP-02。
- 实施内容：命令注册、`recordable` 标记、`Mod` 键位映射、冲突检测数据结构；撤销/重做、剪切/复制/粘贴（含无选区整行）、删除、全选接入。
- 对应验收：AC-17、AC-45（键位数据）。
- 验证与完成条件：V-07、V-08。
- 并行与集成：本任务是菜单/宏/键位映射器的共同依赖，须先合入。

### TASK-NP-04 文件生命周期

- 职责与文件范围：新增 `viewer_save_as`、`viewer_rename`、`viewer_trash`（DEC-03 已定）；前端新建/打开/保存/另存/保存副本/全部保存/重命名/移至回收站；关闭系列经 `NotepadHost.requestClose`。
- 输入与必读：§4.5；`commands/viewer.rs`；`closeGuard`；`filebrowser/local_ops/trash.rs`；DEC-03、DEC-22。
- 依赖：TASK-NP-01；关闭系列的宿主交互依赖 TASK-NP-15 的 `NotepadHost`（可先用桩）。
- 实施内容：原子写入；覆盖确认；关闭系列保护固定标签（仅当宿主提供固定能力）；保存副本不改变当前文档路径；重命名同步最近文件与会话；回收站二次确认，未命名/远程文档禁用，失败保持打开。
- 对应验收：AC-01、AC-02、AC-03。
- 验证与完成条件：V-09、V-10；Rust 单测 `cargo test --lib`。
- 并行与集成：回收站子项可作为本任务的最后一个提交，不阻塞其余。

### TASK-NP-05 最近文件

- 职责与文件范围：`src/stores/app/recentFiles.ts`、文件菜单与欢迎页入口。
- 依赖：TASK-NP-04。
- 实施内容：持久化最近列表、上限设置、恢复最近关闭文件、打开全部最近文件、清空；不存在的文件处理。
- 对应验收：AC-04。
- 验证与完成条件：V-11。
- 并行与集成：与 TASK-NP-06/07 可并行。

### TASK-NP-06 编码与行尾

- 职责与文件范围：编码检测/重新解释/转换/EOL 转换（前端状态 + `workspace/encoding.rs`、新增 `notepad_list_encodings`）。
- 依赖：TASK-NP-01。
- 实施内容：打开时自动检测（`chardetng`）；按编码重新解释（不改磁盘）；转换前检查不可表示字符；EOL 一键转换并支持撤销。
- 对应验收：AC-10、AC-11、AC-12。
- 验证与完成条件：V-12、V-13。
- 并行与集成：与 TASK-NP-05/07 可并行。

### TASK-NP-07 外部变更、重载与只读

- 职责与文件范围：外部变更检测（聚焦与保存前，基于 `viewer_stat` 与哈希）、重载、编辑器只读与文件属性只读、远程文件只读。
- 依赖：TASK-NP-01、TASK-NP-04。
- 实施内容：冲突对话框与顶部横幅；重载丢弃确认；`viewer_set_readonly_attr`；远程文件标记。
- 对应验收：AC-09、AC-23。
- 验证与完成条件：V-14、V-15。
- 并行与集成：复用 `ExternalFileConflictDialog` 的交互模式，避免重复造轮子。

### TASK-NP-08 会话与启动恢复

- 职责与文件范围：会话 JSON 读写、`useViewerRecovery` 扩展、“启动时恢复上次会话”。
- 依赖：TASK-NP-01、TASK-NP-04、TASK-NP-05。
- 实施内容：`SessionFileV1`；缺失文件处理；视图分配、选区、滚动、书签、只读；版本迁移钩子。
- 对应验收：AC-05、AC-06。
- 验证与完成条件：V-16、V-17。
- 并行与集成：与 TASK-NP-09 的备份数据对接约定：未命名文档内容来自备份。

### TASK-NP-09 备份

- 职责与文件范围：`notepad_backup_*` IPC、备份调度器、保存时备份、`viewerDrafts` 一次性迁移。
- 依赖：TASK-NP-01、TASK-NP-04。
- 实施内容：周期备份（默认 30 秒、节流）、崩溃恢复扫描、清理策略；保存时备份三种模式；大文件降级（AC-13）。
- 对应验收：AC-07、AC-08。
- 验证与完成条件：V-18、V-19；崩溃回归套件。
- 并行与集成：不使用 `backup/` 统一引擎。

### TASK-NP-10 剪贴板、选区与多光标

- 职责与文件范围：剪贴板历史、特殊粘贴、开始/结束选择、多光标、拖动选区文本。
- 依赖：TASK-NP-02、TASK-NP-03。
- 实施内容：复用 `ClipboardHistoryPopup`、`carets.ts`；多光标处分别粘贴历史条目；拖动选区文本开关。
- 对应验收：AC-18、AC-19。
- 验证与完成条件：V-20。
- 并行与集成：与 TASK-NP-11 共享选区模型，先约定选区数据结构。

### TASK-NP-11 插入/改写、虚拟空格、列选择与列编辑

- 职责与文件范围：插入日期时间、INS/OVR、虚拟空格、矩形选择、列编辑器。
- 依赖：TASK-NP-03。
- 实施内容：CM6 扩展实现覆盖模式与虚拟空格；矩形选择；列编辑器对话框（数值序列参数）。
- 对应验收：AC-19（矩形部分）、AC-20。
- 验证与完成条件：V-21。
- 并行与集成：虚拟空格与自动换行、IME 的交互风险最高，先做 spike 性质的原型再合入。

### TASK-NP-12 查找替换核心

- 职责与文件范围：查找条、替换、增量查找、F3/Shift+F3、选中即查（含 Volatile）、普通/扩展/正则、范围选项、历史、转到行/列/偏移、紧凑与透明模式。
- 输入与必读：`searchPanel/*`、`GoToLineDialog.tsx`、AC-25/26/30。
- 依赖：TASK-NP-02、TASK-NP-03。
- 实施内容：扩展模式转义解析（纯函数）；正则超时/中止；搜索历史键共用 `taomni.editorSearchHistory.v1`。
- 对应验收：AC-25、AC-26、AC-30。
- 验证与完成条件：V-22、V-23。
- 并行与集成：TASK-NP-13/14 依赖本任务的查找状态。

### TASK-NP-13 批量查找与标记

- 职责与文件范围：跨文件查找替换（复用 `FindInFilesPanel`）、全部查找、所有文档替换、搜索结果面板、Mark、令牌样式。
- 依赖：TASK-NP-12。
- 实施内容：结果分组与 F4/Shift+F4；替换前确认；Mark 的高亮装饰与清除；令牌样式 5 种。
- 对应验收：AC-27、AC-28、AC-29。
- 验证与完成条件：V-24、V-25。
- 并行与集成：与 TASK-NP-14 并行。

### TASK-NP-14 书签与变更历史

- 职责与文件范围：书签（切换/跳转/清除/批量）、变更历史边距与导航；DEC-04 归并子项。
- 依赖：TASK-NP-12；归并子项依赖 DEC-04。
- 对应验收：AC-24、AC-31。
- 验证与完成条件：V-26。
- 并行与集成：默认保持两套书签，不改 `TodosBookmarksPanel`。

### TASK-NP-15 宿主适配、标签集成与标签内分屏

- 职责与文件范围：`NotepadHost` 接口与 `viewerTabHost` 默认实现；`ViewerShell` 挂载 `NotepadEditor` 的接线（先在 `mode` 为 notepad 的标签上启用，切换由 TASK-NP-25 完成）；标签标题/已修改/只读标记回写；同路径去重沿用 `openFile`；窗口菜单与文档列表（经 `listDocuments`）；标签内分屏、克隆、旋转、同步滚动。不做标签栏、固定、拖动排序、最近使用切换（宿主提供，DEC-22）。
- 依赖：TASK-NP-00（S-1、S-2）、TASK-NP-01；DEC-01 已定为 A；DEC-22 已确认接受降级：宿主不提供固定/排序/MRU 时 Notepad 不补做。
- 实施内容：`NotepadHost` 能力声明（`pinTabs/reorderTabs/tabSwitcher`）；`openDocument` 对已存在路径返回既有标签；`requestClose` 逐个保存确认，取消则整体取消；未命名文档的 `FileViewerTabInfo` 扩展（待 S-1）；分屏两窗格共享缓冲区。与 file explorer 分支对接时只改 `NotepadHost` 的实现。
- 对应验收：AC-32、AC-33、AC-36（文档列表）。
- 验证与完成条件：V-30、V-31、V-46。
- 并行与集成：本任务是 UI 集成的中心，建议单人负责；接口先于实现合入，其他任务只通过 `NotepadHost` 读取标签信息。

### TASK-NP-16 视图设置

- 职责与文件范围：全屏/Post-It/专注、行号与标尺、自动换行与缩放、显示符号、主题与栏显隐、文件摘要。
- 依赖：TASK-NP-03、TASK-NP-15。
- 对应验收：AC-34、AC-35、AC-37。
- 验证与完成条件：V-32。
- 并行与集成：与 TASK-NP-17 并行。

### TASK-NP-17 文档地图与面板停靠

- 职责与文件范围：文档地图、面板位置切换（右/底/浮动）。
- 依赖：TASK-NP-00（S-3）、TASK-NP-15；DEC-02 已定为限定型。
- 对应验收：AC-36。
- 验证与完成条件：V-33。
- 并行与集成：通用停靠系统不做（用户已接受缩范围）。

### TASK-NP-18 链接与文本工具箱

- 职责与文件范围：可点击链接、选区动作、复制路径信息、字符面板、脱敏、哈希、MIME、Converter。
- 依赖：TASK-NP-02、TASK-NP-03。
- 实施内容：链接只允许 `http/https` 与本地路径；哈希通过 `notepad_hash`；转换对非法输入报错。
- 对应验收：AC-38、AC-39。
- 验证与完成条件：V-34。
- 并行与集成：与 TASK-NP-19 并行。

### TASK-NP-19 宏

- 职责与文件范围：录制/回放/多次运行、保存与管理、安全校验。
- 依赖：TASK-NP-03。
- 实施内容：只记录 `recordable` 命令；`macros.json` + SHA-256；“运行到文件末尾”的无进展终止；移除 `zh-CN.ts:949` 占位文案。
- 对应验收：AC-40、AC-41、AC-42。
- 验证与完成条件：V-27～V-29。
- 并行与集成：与快捷键映射器（TASK-NP-22）的宏页签对接。

### TASK-NP-20 文件对比

- 职责与文件范围：对比对话框与并排视图，使用 `@codemirror/merge`。
- 依赖：TASK-NP-01。
- 对应验收：AC-43。
- 验证与完成条件：V-35。
- 并行与集成：不修改 Git DiffViewer；工作区 `editorCompareModel` 的迁移另行评估。

### TASK-NP-21 打印

- 职责与文件范围：打印/立即打印/打印设置/打印到 PDF（沿用隐藏 iframe 技术）。
- 依赖：TASK-NP-03。
- 实施内容：先在三端 spike 打印行为；页眉页脚、行号、颜色模式。
- 对应验收：AC-44。
- 验证与完成条件：V-36。
- 并行与集成：Linux 打印能力不足时给出降级文案。

### TASK-NP-22 首选项、键位映射器与新建默认值

- 职责与文件范围：Notepad 首选项分页、快捷键映射器、新建文档默认值。
- 依赖：TASK-NP-03、TASK-NP-19。
- 对应验收：AC-45。
- 验证与完成条件：V-37。
- 并行与集成：复用 `KeymapSettingsDialog` 的冲突检测逻辑。

### TASK-NP-23 拖放、外部打开、提权保存与大文件

- 职责与文件范围：拖放文件/文件夹、外部打开与终端打开、提权保存、大文件降级。
- 依赖：TASK-NP-00（S-4、S-5）、TASK-NP-04、TASK-NP-06。
- 对应验收：AC-13～AC-16。
- 验证与完成条件：V-40。
- 并行与集成：提权保存须有安全评审。

### TASK-NP-24 集成与验收

- 职责与文件范围：全局回归、崩溃回归、`qa-ui-auto` 用例、真机验证、43 项不出现的检查。
- 依赖：全部前序任务。
- 对应验收：AC-46、AC-47，汇总全部 AC。
- 验证与完成条件：V-38、V-41、V-42。
- 并行与集成：本任务负责整体集成、三端构建与当前端真机验证。

### TASK-NP-25 viewer 文本编辑迁移到 Notepad

- 职责与文件范围：`ViewerShell.tsx`（`kind==="text"`、`mode==="source"`、`document.large` 三个分支改挂 `NotepadEditor`；保留外壳横幅、`hosts` 引用计数与 `checkExternal` 轮询；Notepad 分支不再渲染 `fv-status`）；删除 `TextEditor.tsx`（`EditorSurface.tsx`/`ViewerDialogs.tsx` 先检索使用者再决定）；`classifyFile`/`openFile` 路由；`FileOpenSettings` 文案；`viewerDrafts` 草稿迁移（与 TASK-NP-09 共用）；更新 `ViewerShell.test.tsx` 等既有测试。
- 输入与必读：§2 新增的 ViewerShell/TextEditor/openFile 行；DEC-14、DEC-20；`documentStore`。
- 依赖：TASK-NP-15、NP-04、NP-06、NP-07、NP-09、NP-23（大文件降级）、NP-26（路由别名）。即 Notepad 对旧编辑器达到功能对等后才切换。
- 实施内容：① 先列“旧 TextEditor 能力对等清单”（保存、撤销/重做、查找、换行、字号、编码、EOL、读取失败页、大文件 256 KB 分块只读与 20 MB 确认、只读副本、“在 Workspace 中编辑”→“用 Code editor 打开”）并逐项勾验；② 一次切换，不加并存开关；③ 删除旧编辑器及其无人使用的样式；④ 升级后遗留的 `taomni.viewer.drafts.v1` 草稿可恢复；⑤ 确认 Markdown 编辑器、图片/SVG/HTML 查看器不受影响。
- 对应验收：AC-48、AC-46。
- 验证与完成条件：V-47、V-48、V-37、V-41、V-51；`pnpm exec vitest run src/components/viewer/ViewerShell.test.tsx` 及相关用例；`pnpm check:refactor`。
- 并行与集成：最后落地的集成任务，建议单人负责；回退点为合并前的提交（旧编辑器仍可恢复）。

### TASK-NP-26 打开方式选择器（系统默认 / Code editor / Notepad / TaOffice）

- 职责与文件范围：`src/lib/openFile/preferences.ts`（`FileHandler` 增加 `notepad`/`taoffice`，`validated` 白名单，存储键与旧值不变）、`src/lib/openFile/index.ts`（`mode` 联合类型与路由，不可用处理器报可见错误）、拟新增 `src/lib/openFile/handlers.ts`（`FileHandlerRegistry`，TaOffice 占位项 `available()===false`）、`fileOpenMenu.tsx`、`FileOpenSettings.tsx`、i18n 文案。
- 输入与必读：§2 新增的 openFile/FileOpenSettings/fileOpenMenu 行；DEC-21；file explorer 分支（`feat/file-explorer`、`feat/file-open-improve`）对这些文件的最新改动。
- 依赖：注册表、设置与菜单可立即开始；“Notepad”选项在 TASK-NP-15 落地前映射到现有 `source` 路径，TASK-NP-25 后统一；TaOffice 的扩展名与调用契约依赖 TaOffice 团队（未决）。
- 实施内容：菜单与设置同源于注册表；TaOffice 项禁用并标“开发中”；“记住”写入扩展名关联；保存的关联指向不可用处理器时打开失败给出可见提示与“用系统默认应用打开”；`text`/`data` 组改称 Notepad；不改变 Code Workspace、系统应用、Markdown/HTML 现有选项与 Ctrl/⌘+双击行为。
- 对应验收：AC-49。
- 验证与完成条件：V-49、V-50、V-51。
- 并行与集成：与 file explorer 分支共改三个文件，开工前先 rebase 并与该分支负责人确认；接口放在 `handlers.ts` 以减小冲突面。

## 7. 自动化测试计划

测试文件均为**拟新增**，路径在实现时核对；工作目录为仓库根；单文件测试使用 `pnpm exec vitest run <file>`（不要多带一个 `--`）。当前**全部待执行**，设计阶段没有“改前基线”之外的结果。

| V ID | AC / 用途 | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-01 文档身份 | Vitest `src/stores/__tests__/notepadStore.test.ts` | 创建未命名/路径文档、同一文档分屏 | 未命名文档命名递增且键为 `untitled:` 前缀；另存为后键改为路径键；分屏共享 `docId`；脏状态派生 | `pnpm exec vitest run src/stores/__tests__/notepadStore.test.ts` | 无基线 / 待执行 |
| V-02 | AC-33 分屏同步 | Vitest | 同一文档两窗格并编辑、撤销 | 缓冲区与撤销栈一致 | 同上 | 待执行 |
| V-03 | AC-21 排序 | Vitest `src/lib/notepad/transforms/__tests__/sort.test.ts` | 7 口径 × 升降序，含稳定性与列键 | 结果与预期序列一致；相等键保持原序 | `pnpm exec vitest run src/lib/notepad/transforms/__tests__/sort.test.ts` | 待执行 |
| V-04 | AC-21 去重/删空行/反转/打乱 | Vitest | 含仅空白行与连续重复 | 去重保留首次；连续去重只去相邻 | 同上模式 | 待执行 |
| V-05 | AC-22 大小写 | Vitest | 8 种转换，含中文/Unicode | 与手册示例一致 | 同上模式 | 待执行 |
| V-06 | AC-22 空白 | Vitest | Trim/TAB↔空格/行尾转空格 | 全部/仅行首选项正确 | 同上模式 | 待执行 |
| V-07 | AC-17 命令注册表 | Vitest | 注册、冲突、`recordable` | 重复键位被检出；`Mod` 映射 | `pnpm exec vitest run` 指定文件 | 待执行 |
| V-08 | AC-17 无选区整行复制/剪切 | Vitest + 编辑器挂载 | 无选区 `Mod+C` | 剪贴板为整行；开关生效 | 同上 | 待执行 |
| V-09 | AC-01 保存/另存/保存副本 | Rust `cargo test --lib` + Vitest | 临时目录 | 原子写入；覆盖需确认；保存副本不改当前路径 | `cargo test --lib`（`src-tauri`）；vitest | 待执行 |
| V-10 | AC-02 关闭系列 | Vitest | 含脏文档，及宿主声明 `pinTabs` 时的固定标签 | 固定不被关（有该能力时）；取消终止 | 同上 | 待执行 |
| V-11 | AC-04 最近文件 | Vitest | 增删清空 | 排序、上限、缺失文件处理 | 同上 | 待执行 |
| V-12 | AC-10/11 编码 | Rust `cargo test --lib` | GBK/UTF-16/UTF-8 BOM 样本 | 检测与转换往返无损；不可表示字符被报告 | `cargo test --lib` | 待执行 |
| V-13 | AC-12 EOL | Vitest | 混合行尾 | 统一后无混合；可撤销 | vitest | 待执行 |
| V-14 | AC-09 外部变更 | Vitest + 集成 | 保存前改磁盘 | 弹出冲突，不静默覆盖 | vitest | 待执行 |
| V-15 | AC-23 只读 | Vitest | 编辑器只读/属性只读 | 输入被拒；会话保存标记 | vitest | 待执行 |
| V-16 | AC-05 会话往返 | Vitest | 保存→加载 | 结构一致；缺失文件被列出 | vitest | 待执行 |
| V-17 | AC-06 启动恢复 | Vitest | 模拟重启 | 恢复文件集合与活动文档 | vitest | 待执行 |
| V-18 | AC-07 备份与恢复 | Rust + Vitest | 模拟强制退出 | 恢复未保存内容；保存后清理 | 同上 | 待执行 |
| V-19 | AC-08 保存时备份 | Rust | 三种模式 | 文件位置与命名符合规则 | `cargo test --lib` | 待执行 |
| V-20 | AC-18/19 剪贴/选区/多光标 | Vitest（编辑器挂载） | 多光标粘贴、拖动 | 多处同时修改；开关生效 | vitest | 待执行 |
| V-21 | AC-19/20 插入与列编辑 | Vitest | 序列生成与覆盖模式 | 进制/前导零/步长正确 | vitest | 待执行 |
| V-22 | AC-25/26 查找替换 | Vitest | 普通/扩展/正则 | 转义与反向引用正确；非法正则不崩溃 | vitest | 待执行 |
| V-23 | AC-26 正则安全 | Vitest | 灾难性正则 | 超时中止，界面可用 | vitest | 待执行 |
| V-24 | AC-27 跨文件 | Vitest + Rust | 临时目录 | 命中数与替换确认 | 同上 | 待执行 |
| V-25 | AC-28/29 批量与标记 | Vitest | 多文档 | 分组、整体撤销 | vitest | 待执行 |
| V-26 | AC-24/31 书签与变更历史 | Vitest | 批量书签操作 | 整体可撤销；状态颜色 | vitest | 待执行 |
| V-27 | AC-40 宏录制回放 | Vitest | 录制白名单命令 | 弹窗命令被拒；回放一致 | vitest | 待执行 |
| V-28 | AC-41 宏保存 | Vitest | 保存/改键/删除 | 冲突被提示 | vitest | 待执行 |
| V-29 | AC-42 宏安全 | Vitest | 改动 `macros.json` | 哈希不符时禁用执行 | vitest | 待执行 |
| V-30 | AC-32 标签行为 | 浏览器 QA（拟新增 TC） | 同路径重复打开、已修改标记、窗口菜单与文档列表激活 | 同路径只一个标签；标记与列表一致；宿主不提供的固定/排序项不出现 | `qa-ui-auto` 现有执行方式（实施时核对） | 待执行 |
| V-31 | AC-33 标签内分屏 | 浏览器 QA | 分屏、旋转、克隆、同步滚动、关闭一个窗格 | 符合验收；文档不丢 | 同上 | 待执行 |
| V-32 | AC-34/35/37 视图设置 | 浏览器 QA | 全屏/专注/符号 | 符合验收 | 同上 | 待执行 |
| V-33 | AC-36 面板 | 浏览器 QA | 切换位置 | 位置持久化 | 同上 | 待执行 |
| V-34 | AC-38/39 工具箱 | Vitest + Rust | 哈希/转换 | 摘要与已知向量一致 | 同上 | 待执行 |
| V-35 | AC-43 对比 | Vitest | 忽略空白/大小写 | 差异块正确；超 5 MB 提示 | vitest | 待执行 |
| V-36 | AC-44 打印 | 手工 + Vitest（HTML 生成） | 页眉页脚 | 内容与设置一致 | 见 §8 | 待执行 |
| V-37 | AC-45/46 回归 | Vitest（现有套件） | 工作区编辑器行操作 | 行为不退化 | `pnpm test` | 现有基线待执行 |
| V-38 | AC-46 43 项不出现 | Vitest/静态检查 | 菜单与设置数据 | 不含任何“不支持”条目 | vitest | 待执行 |
| V-39 | AC-01/13/16/33/36 spike 结论 | 文档 | S-1～S-6 | 结论齐备 | — | 待执行 |
| V-40 | AC-13～16 拖放/外部/提权/大文件 | Rust + 手工 | 大文件与权限样本 | 降级与权限路径正确 | `cargo test --lib`；§8 | 待执行 |
| V-41 | AC-46 崩溃回归 | 崩溃回归套件 | 现有套件 | 全部通过 | 现有崩溃回归命令（实施时核对） | 待执行 |
| V-42 | 全部 AC 三端构建 | 构建 | 三端 CI | 可构建运行 | `pnpm build`；`cargo build` | 待执行 |
| V-46 | AC-32 `NotepadHost` | Vitest `src/lib/notepad/host/__tests__/viewerTabHost.test.ts`（拟新增） | 模拟 `appStore` 标签与 workspace viewer 标签 | `openDocument` 同路径返回既有标签；`requestClose` 取消整体取消；`setTabState` 回写标题与已修改；`capabilities` 缺失时对应菜单项不渲染 | `pnpm exec vitest run src/lib/notepad/host/__tests__/viewerTabHost.test.ts` | 待执行 |
| V-47 | AC-48 文本类路由与外壳 | Vitest `src/components/viewer/ViewerShell.test.tsx`（更新） | text / svg 源码 / markdown 源码 / large 文档 / image / html | 前三者与 large 挂载 `NotepadEditor`，image/markdown 编辑器/html 保持原组件；只读横幅、外部修改横幅、草稿提示仍在；旧 `TextEditor` 不再被引用 | `pnpm exec vitest run src/components/viewer/ViewerShell.test.tsx` | 改前：现有测试断言 `TextEditor`（待核对）/ 待执行 |
| V-48 | AC-48 迁移不丢数据与大文件 | Vitest + 浏览器 QA | 预置 `taomni.viewer.drafts.v1` 草稿；5/12/25 MB 样本；远程只读副本 | 草稿恢复且磁盘未改；5 MB 内可编辑、5–20 MB 分块只读、>20 MB 确认/拒绝；远程副本只读并可“另存为本地后编辑” | 同上模式 | 待执行 |
| V-49 | AC-49 偏好与注册表 | Vitest `src/lib/openFile/__tests__/handlers.test.ts`（拟新增）与 `preferences` 现有测试 | 旧偏好 JSON；保存 `taoffice` 关联；`available()` 为 false | 旧值读入不变；`notepad`/`taoffice` 通过白名单；不可用处理器的 `openFile` 返回可见错误且不降级 | `pnpm exec vitest run src/lib/openFile/__tests__/handlers.test.ts` | 待执行 |
| V-50 | AC-49 菜单与设置 UI | Vitest（组件）+ 浏览器 QA | Explorer 右键“打开方式”；设置表；双击与 Ctrl/⌘+双击 | 四个选项齐备；TaOffice 禁用且带“开发中”；记住项持久化；Markdown/HTML 选项不退化 | 同上模式 | 待执行 |
| V-51 | AC-48/49 真机 | 真机（§8 V-51） | 见 §8 | 见 §8 | — | 待执行 |

UI 用例映射：feature ID（F-xx）→ 拟新增 case（`qa-ui-auto-tests/cases/TC-NP-*.testcase.yaml`，格式与现有 case 保持一致）→ controls/testid（实现时拟新增 `data-testid="np-*"`）；维护任务为 TASK-NP-24。浏览器 QA 使用 stub（不证明真实文件系统/提权/打印行为），真实行为须由 §8 真机验证证明。

## 8. 真机验证手册

### 环境与准备

- **Linux（当前环境，Replit）**：使用仓库的 Linux 原生 QA 桌面包装（Xvfb/Fluxbox/DBus/FCITX5，需显式启用）运行被测构建；使用隔离的 app-data 与测试工作区；准备样本：GBK/UTF-16 文件、5/12/35 MB 文件、需 root 的目标文件、含混合行尾的文件、外部修改脚本。
- **Windows**：待执行（需 Windows 机器）。重点：UAC、回收站、PowerShell/cmd 打开、高 DPI。
- **macOS**：待执行（需 macOS 机器）。重点：Cmd 键位、授权保存、废纸篓、Finder。

### V-43 真机主流程（Linux 先行）

- 对应验收：AC-01～AC-16。
- 执行前状态：干净的 app-data；无遗留备份。
- 操作与逐步预期：新建→输入→保存→重命名→外部改动→冲突处理→强制退出→重启恢复→GBK 重新解释→转换为 UTF-8→EOL 转换→拖放文件夹（>20 文件）→打开 12 MB 文件看降级提示→打开 35 MB 文件被拒。
- 故障与恢复：磁盘只读、磁盘已满、权限不足时提示与状态保持。
- 证据：命令与日志、截图路径（实施时生成）。
- 清理：删除临时目录与备份。
- 状态：待执行。

### V-44 真机编辑与查找

- 对应验收：AC-17～AC-31。
- 操作：行操作、列编辑、多光标、查找替换（含正则、扩展）、跨文件、书签、标记。
- 状态：待执行。

### V-45 真机视图与宏

- 对应验收：AC-32～AC-45。
- 操作：标签内分屏/克隆/同步滚动、窗口菜单与文档列表、面板切换、全屏/专注、宏录制与外部改动 `macros.json`、对比、打印（含“打印到 PDF”）、快捷键映射器冲突。
- 状态：待执行；Windows / macOS 同项目保留，未执行不继承 Linux 结果。

### V-51 真机：viewer 迁移与打开方式

- 对应验收：AC-48、AC-49。
- 执行前状态：升级前构建留下的 `taomni.viewer.drafts.v1` 草稿；样本 .txt/.json/.csv/.md/.svg/.html/.png/.docx 与 5/12/25 MB 文本。
- 操作与逐步预期：双击 .txt/.json → Notepad；.md → Markdown 编辑器；.png → 图片查看器；.md/.svg 右键“Notepad 打开源码”；12 MB 受限提示；25 MB 确认或拒绝；远程只读副本“另存为本地后编辑”；右键 .docx/.txt 的“打开方式”四个选项，TaOffice 禁用；记住 .log→Code editor 后双击生效；遗留草稿恢复。
- 状态：待执行；Windows / macOS 同项目保留。

## 9. 验收追踪与交付条件

### 9.1 验收追踪

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4.3/4.5 | NP-01/04 | V-01 V-09 V-43（Linux） | 单测/真机日志 | 未实现 |
| AC-02 | §4.2 | NP-04 | V-10 | 单测 | 未实现 |
| AC-03 | DEC-03 | NP-04 | V-09 | 单测+真机 | 未实现；S-6 |
| AC-04 | §4.3 | NP-05 | V-11 | 单测 | 未实现 |
| AC-05 | DEC-08 | NP-08 | V-16 | 单测 | 未实现 |
| AC-06 | §4.3 | NP-08 | V-17 | 单测 | 未实现 |
| AC-07 | DEC-14 | NP-09 | V-18 V-41 | 单测+崩溃回归 | 未实现 |
| AC-08 | §4.3 | NP-09 | V-19 | Rust 单测 | 未实现 |
| AC-09 | DEC-15 | NP-07 | V-14 V-43 | 单测+真机 | 未实现 |
| AC-10/11/12 | §4.5 | NP-06 | V-12 V-13 | Rust/Vitest | 未实现 |
| AC-13 | DEC-12 | NP-23 | V-40 V-43 | 真机 | 未实现；S-4 |
| AC-14/15/16 | §4.6 | NP-23 | V-40 | 真机 | 未实现；S-5 |
| AC-17 | §4.5 | NP-03 | V-07 V-08 | 单测 | 未实现 |
| AC-18/19 | §4.3 | NP-10/11 | V-20 V-21 | 单测 | 未实现 |
| AC-20 | §4.5 | NP-02/11 | V-21 | 单测 | 未实现 |
| AC-21/22 | DEC-09 | NP-02/03 | V-03～V-06 | 单测 | 未实现 |
| AC-23 | §4.3 | NP-07 | V-15 | 单测 | 未实现 |
| AC-24/31 | DEC-04 | NP-14 | V-26 | 单测 | 未实现 |
| AC-25/26/30 | §4.5 | NP-12 | V-22 V-23 | 单测 | 未实现 |
| AC-27/28/29 | DEC-11 | NP-13 | V-24 V-25 | 单测 | 未实现 |
| AC-32/33 | DEC-01 DEC-22 | NP-15 | V-30 V-31 V-46 | 浏览器 QA+真机 | 未实现；S-1 S-2 |
| AC-34/35/37 | §4.2 | NP-16 | V-32 | 浏览器 QA | 未实现 |
| AC-36 | DEC-02 | NP-15/17 | V-33 | 浏览器 QA | 未实现；S-3 |
| AC-38/39 | §4.5 | NP-18 | V-34 | 单测 | 未实现 |
| AC-40/41/42 | DEC-07 | NP-19 | V-27～V-29 | 单测 | 未实现 |
| AC-43 | DEC-10 | NP-20 | V-35 | 单测 | 未实现 |
| AC-44 | §4.6 | NP-21 | V-36 | 手工 | 未实现；打印 spike |
| AC-45 | §4.5 | NP-22 | V-37 | 单测 | 未实现 |
| AC-46 | DEC-16 | NP-24 | V-37 V-38 V-41 | 回归 | 未实现 |
| AC-47 | §4.6 | NP-24 | V-42 | 三端构建 | 未执行 |
| AC-48 | DEC-20 | NP-25 | V-47 V-48 V-51 | 单测+浏览器 QA+真机 | 未实现；依赖 NP-15/04/06/07/09/23 |
| AC-49 | DEC-21 | NP-26 | V-49 V-50 V-51 | 单测+浏览器 QA+真机 | 未实现；TaOffice 契约未决 |

### 9.2 功能（F-01～F-90）到任务与验收的追踪

F 编号按 decisions 文件中**支持与待定条目**的出现顺序编号；“不支持”的 43 项不编号。

| 功能 | 名称 | 决策表优先级 | 任务 | 验收 | 备注 |
|---|---|---|---|---|---|
| F-01 | 新建 / 打开 / 保存 / 另存 / 保存副本 / 全部保存 / 重命名 | P0 | TASK-NP-04 | AC-01 |  |
| F-02 | 关闭系列：关闭 / 全部关闭 / 批量关闭 | P0 | TASK-NP-04 | AC-02 |  |
| F-03 | 移至回收站 | P1 | TASK-NP-04 | AC-03 | 用户已定：实现（DEC-03） |
| F-04 | 最近文件列表 | P0 | TASK-NP-05 | AC-04 |  |
| F-05 | 会话：加载 / 保存会话 | P1 | TASK-NP-08 | AC-05 |  |
| F-06 | 启动时记住当前会话 | P0 | TASK-NP-08 | AC-06 |  |
| F-07 | 会话快照与定期备份（自动保存） | P0 | TASK-NP-09 | AC-07 |  |
| F-08 | 保存时备份 | P1 | TASK-NP-09 | AC-08 |  |
| F-09 | 文件外部变更检测与从磁盘重载 | P0 | TASK-NP-07 | AC-09 |  |
| F-10 | 编码识别与解释：ANSI / UTF-8 / UTF-16 / 字符集 | P0 | TASK-NP-06 | AC-10 |  |
| F-11 | 编码转换（Convert to …） | P0 | TASK-NP-06 | AC-11 |  |
| F-12 | 行尾（EOL）转换 | P0 | TASK-NP-06 | AC-12 |  |
| F-13 | 大文件支持 | P1 | TASK-NP-23 | AC-13 |  |
| F-14 | 拖放打开文件 / 文件夹 | P1 | TASK-NP-23 | AC-14 |  |
| F-15 | 在外部打开：默认查看器 / 资源管理器 / cmd / PowerShell / 文件夹工作区 | P2 | TASK-NP-23 | AC-15 |  |
| F-16 | UAC 管理员保存 | — | TASK-NP-23 | AC-16 |  |
| F-17 | 撤销 / 重做 | P0 | TASK-NP-03 | AC-17 |  |
| F-18 | 剪切 / 复制 / 粘贴 | P0 | TASK-NP-03 | AC-17 |  |
| F-19 | 剪贴板历史与多重粘贴 | P1 | TASK-NP-10 | AC-18 |  |
| F-20 | Paste Special：粘贴 HTML/RTF 源码、二进制内容 | P2 | TASK-NP-10 | AC-18 |  |
| F-21 | 删除 / 全选 | P0 | TASK-NP-03 | AC-17 |  |
| F-22 | Begin/End Select（两步选区，含列模式版） | P2 | TASK-NP-10 | AC-19 |  |
| F-23 | 插入日期时间（短 / 长 / 自定义格式） | P2 | TASK-NP-11 | AC-20 |  |
| F-24 | 插入 / 改写模式 | P1 | TASK-NP-11 | AC-20 |  |
| F-25 | 虚拟空格 | P2 | TASK-NP-11 | AC-20 |  |
| F-26 | 列 / 块选择（矩形选择） | P1 | TASK-NP-11 | AC-19 |  |
| F-27 | 列编辑器 | P1 | TASK-NP-11 | AC-20 |  |
| F-28 | 多光标 / 多选编辑 | P1 | TASK-NP-10 | AC-19 |  |
| F-29 | 行操作：复制行 / 上移 / 下移 / 合并 / 拆分 / 插入空行 | P0 | TASK-NP-02 | AC-21 |  |
| F-30 | 行操作：排序（多口径，升/降序） | P1 | TASK-NP-02 | AC-21 |  |
| F-31 | 行操作：删除重复行 / 删除连续重复行 / 删空行 / 反转 / 随机打乱 | P1 | TASK-NP-02 | AC-21 |  |
| F-32 | 大小写转换（8 种） | P1 | TASK-NP-02 | AC-22 |  |
| F-33 | 空白操作：Trim / TAB↔空格 / 行尾转空格 | P1 | TASK-NP-02 | AC-22 |  |
| F-34 | 拖动选区文本 | P2 | TASK-NP-10 | AC-19 |  |
| F-35 | 只读切换（编辑器内 / 文件属性） | P1 | TASK-NP-07 | AC-23 |  |
| F-36 | 变更历史边距 | P2 | TASK-NP-14 | AC-24 |  |
| F-37 | 查找 | P0 | TASK-NP-12 | AC-25 |  |
| F-38 | 替换 | P0 | TASK-NP-12 | AC-25 |  |
| F-39 | 在文件中查找 / 替换（跨文件） | P0 | TASK-NP-13 | AC-27 |  |
| F-40 | 标记 Mark | P1 | TASK-NP-13 | AC-29 |  |
| F-41 | 全部查找（当前文档 / 所有打开文档） | P1 | TASK-NP-13 | AC-28 |  |
| F-42 | 在所有打开文档中替换 | P1 | TASK-NP-13 | AC-28 |  |
| F-43 | 增量查找 | P1 | TASK-NP-12 | AC-25 |  |
| F-44 | 免对话框查找：上一个 / 下一个（含 Volatile 与选中即查） | P1 | TASK-NP-12 | AC-25 |  |
| F-45 | 搜索结果窗口 | P1 | TASK-NP-13 | AC-28 |  |
| F-46 | 正则表达式搜索替换 | P0 | TASK-NP-12 | AC-26 |  |
| F-47 | 扩展 / 普通搜索模式与范围选项 | P0 | TASK-NP-12 | AC-26 |  |
| F-48 | 搜索历史 | P2 | TASK-NP-12 | AC-25 |  |
| F-49 | 转到行 / 列 / 偏移 | P0 | TASK-NP-12 | AC-30 |  |
| F-50 | 书签：切换 / 跳转 / 清除 | P1 | TASK-NP-14 | AC-31 |  |
| F-51 | 书签行批量操作 | P1 | TASK-NP-14 | AC-31 |  |
| F-52 | 令牌样式高亮（5 种样式） | P2 | TASK-NP-13 | AC-29 |  |
| F-53 | 变更历史导航 | P2 | TASK-NP-14 | AC-24 |  |
| F-54 | 查找对话框透明 / 紧凑模式 | P2 | TASK-NP-12 | AC-25 |  |
| F-55 | 标签页多文档界面 | P0 | TASK-NP-15 | AC-32 | 宿主应用标签满足（DEC-01=A）；范围收窄见 DEC-22 |
| F-56 | 标签固定（Pin） | P2 | TASK-NP-15 | AC-32 | 由宿主提供；无则不出现 |
| F-57 | 文档切换器（Ctrl+Tab MRU） | P2 | TASK-NP-15 | AC-32 | 由宿主提供；Notepad 不自带 |
| F-58 | 双视图分屏 | P1 | TASK-NP-15 | AC-33 | 收敛为同一文档的标签内分屏 |
| F-59 | 克隆文档 | P1 | TASK-NP-15 | AC-33 | 即标签内克隆窗格 |
| F-60 | 双视图同步滚动 | P2 | TASK-NP-15 | AC-33 | 标签内两窗格同步滚动 |
| F-61 | 全屏 / Post-It / 专注模式 | P2 | TASK-NP-16 | AC-34 |  |
| F-62 | 行号与边距 / 垂直标尺 | P0 | TASK-NP-16 | AC-35 |  |
| F-63 | 文档地图（Minimap） | P1 | TASK-NP-17 | AC-36 | DEC-02 已定 |
| F-64 | 文档列表面板 | P2 | TASK-NP-15 | AC-36 | 列出宿主中全部 Notepad 标签 |
| F-65 | 主题 / 样式配置器与暗色模式 | P1 | TASK-NP-16 | AC-37 |  |
| F-66 | 状态栏 / 工具栏 / 菜单栏定制 | P1 | TASK-NP-16 | AC-37 |  |
| F-67 | 显示符号：空格/Tab/行尾/不可见字符/缩进线/折行标记 | P1 | TASK-NP-16 | AC-35 |  |
| F-68 | 自动换行与缩放 | P0 | TASK-NP-16 | AC-35 |  |
| F-69 | 文件摘要 Summary | P2 | TASK-NP-16 | AC-37 |  |
| F-70 | 可停靠 / 浮动面板体系 | P1 | TASK-NP-17 | AC-36 | 限定型（用户已定，缩范围已接受） |
| — | （本次新增，非决策表条目）viewer 文本编辑迁移 | — | TASK-NP-25 | AC-48 | 用户本轮要求（DEC-20） |
| — | （本次新增，非决策表条目）Explorer 打开方式选择器 | — | TASK-NP-26 | AC-49 | 用户本轮要求（DEC-21） |
| F-71 | 可点击链接 | P2 | TASK-NP-18 | AC-38 |  |
| F-72 | 字符面板（ASCII 插入） | P2 | TASK-NP-18 | AC-39 |  |
| F-73 | 选区脱敏 Redact Selection | P2 | TASK-NP-18 | AC-39 |  |
| F-74 | 选区动作：打开文件 / 打开所在文件夹 / 联网搜索 | P2 | TASK-NP-18 | AC-38 |  |
| F-75 | 复制路径信息到剪贴板 | P2 | TASK-NP-18 | AC-38 |  |
| F-76 | 哈希工具 MD5 / SHA-1 / SHA-256 / SHA-512 | P2 | TASK-NP-18 | AC-39 |  |
| F-77 | MIME Tools（插件）：Base64 等编解码 | P2 | TASK-NP-18 | AC-39 |  |
| F-78 | Converter（插件）：ASCII↔十六进制等进制转换 | — | TASK-NP-18 | AC-39 |  |
| F-79 | 宏录制 / 回放 | P1 | TASK-NP-19 | AC-40 |  |
| F-80 | 保存宏并绑快捷键 | P1 | TASK-NP-19 | AC-41 |  |
| F-81 | 多次运行宏 | P1 | TASK-NP-19 | AC-40 |  |
| F-82 | 宏管理：改快捷键 / 删除宏 | P2 | TASK-NP-19 | AC-41 |  |
| F-83 | 宏安全校验 | P2 | TASK-NP-19 | AC-42 |  |
| F-84 | 文件对比 Compare / ComparePlus（插件） | P1 | TASK-NP-20 | AC-43 |  |
| F-85 | 打印 / 立即打印 | P1 | TASK-NP-21 | AC-44 |  |
| F-86 | 打印设置 | P2 | TASK-NP-21 | AC-44 |  |
| F-87 | 打印到 PDF | P2 | TASK-NP-21 | AC-44 |  |
| F-88 | 首选项对话框（与文本编辑相关的分页） | P1 | TASK-NP-22 | AC-45 |  |
| F-89 | 快捷键映射器 | P1 | TASK-NP-22 | AC-45 |  |
| F-90 | 新建文档默认值 | P1 | TASK-NP-22 | AC-45 |  |

### 9.3 交付条件

设计阶段所有 V-* 保持“待执行”。实施阶段：当前端（Linux）的必要自动化与真机验证通过、三端无已知代码不兼容时可报告本轮完成；Windows / macOS 未执行的项保留“未验证”和后续计划。**当前端的空产物、skip 或环境阻塞不能算验证完成。**

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| DEC-22 已确认，残余风险 | A 方案使 F-56/F-57/F-58/F-59/F-64 收窄；用户已接受，decisions 表这些条目按收窄后的范围验收 | 如日后要“第二窗格放另一个文件”，作为增量任务另提 | NP-15 | — |
| `documentStore` 路径键改造面不明 | 影响未命名/克隆文档 | S-1 先行 | NP-01 起的全部任务 | S-1 结论 |
| CM6 两视图共享撤销栈 | 标签内克隆体验的核心 | S-2；不可行则共享事务流 | NP-15 | S-2 结论 |
| 文档地图性能 | 大文档时重绘代价 | S-3；超过阈值降级为简化条 | NP-17 | S-3 结论 |
| 20～50 MB 文件 | 内存与渲染 | 仅 spike；P0 不承诺 | 不阻塞 P0 | S-4 |
| 提权保存的安全与三端方案 | 权限越界风险 | S-5 + 安全评审；限定目标文件 | NP-23 | S-5 结论 |
| 正则方言差异 | Notepad++ 为 Boost/PCRE，WebView 为 JS 正则 | 在文档说明差异；环视以外基本兼容；必要时 Rust 侧 `regex`/`fancy-regex` 评估 | NP-12 | 方言差异清单评审 |
| 灾难性正则 | 界面卡死 | 超时中止（V-23） | NP-12 | — |
| 宿主不提供固定/排序/MRU | Notepad 不自带，菜单项不出现 | 与 file explorer 分支确认 `NotepadHost.capabilities`；`Ctrl+Tab` 的 WebView 占用问题归宿主 | NP-15 | 宿主能力确认 |
| Linux 打印能力 | WebView 打印不可用 | spike；降级文案 | NP-21 | 打印 spike |
| IME 与宏/快捷键冲突 | 误触发 | 组合输入期间忽略 | NP-03/19 | V-27 |
| 现有 viewer 回归 | 共享代码改动 | AC-46、崩溃回归、800 行限制 | NP-24 | V-37 V-41 |
| 标记（Mark）是否随会话保存 | 决策表未说明 | 默认**不保存**，在评审时确认 | NP-13 | 评审结论 |
| 与 file explorer 分支并行改动同一批文件 | `fileOpenMenu.tsx`、`FileOpenSettings.tsx`、`ExplorerCommandBar.tsx`、`openFile/index.ts` 冲突 | NP-26 开工前 rebase 并与该分支负责人对齐；新接口放 `handlers.ts` | NP-26、NP-25 | 对齐结论 |
| TaOffice 契约未决 | 可处理扩展名、`open()` 签名、可用性判定由另一团队提供；预留扩展名为假设 | 只提供注册表接口与禁用占位；TaOffice 就绪后仅注册即可启用 | NP-26 | TaOffice 团队提供契约 |
| 旧编辑器移除的回归面 | `TextEditor` 的大文件分块、20 MB 确认、只读副本、草稿恢复、“在 Workspace 中编辑”等行为不得丢失 | 先列对等清单再切换（NP-25）；V-47/V-48/V-51；崩溃回归 | NP-25 | 对等清单全部勾验 |
| 宏录制与多标签 | 录制绑定到开始录制的标签，切换标签会暂停 | 暂停时提示；宏回放只作用于当前标签 | NP-19 | 评审结论 |

**回退边界。** 代码回退：`NotepadEditor` 与 `NotepadHost` 为新增模块，整体回退后 `ViewerShell` 恢复旧 `TextEditor` 分支（TASK-NP-25 合并前的提交是回退点；合并后回退需恢复被删除的 `TextEditor`）；`documentStore` 的无路径文档支持须保持向后兼容；`FileOpenPreferences` 存储键与既有值不变，新增的 `notepad`/`taoffice` 值在回退版本中会被 `validated` 过滤掉。数据回退：一次性迁移保留 `taomni.viewer.drafts.v1` 原数据直至迁移成功并确认；备份目录与会话文件可直接删除而不影响用户文件。

**现在可开始的任务：** TASK-NP-00、TASK-NP-02、TASK-NP-26（注册表/设置/菜单部分，需先与 file explorer 分支对齐）；S-1 完成后 TASK-NP-01，进而 TASK-NP-03～09、10～14、15～17、18～20、21。**必须等待：** TASK-NP-23（S-4、S-5）；TASK-NP-25 须等 NP-15/04/06/07/09/23/26 全部完成。**待用户确认：** DEC-22（不阻塞开工）。

### 9.4 本轮执行记录（2026-11-21 接续开发，实施后回填）

> 本节只记录实际执行过的验证。未列出的 V-* 仍未执行；Windows / macOS 真机项保持“未验证”。命令均在本仓库根目录执行。

| V | 结果 | 命令与证据 |
|---|---|---|
| V-01～V-08、V-22～V-29、V-34、V-38、V-39、V-46～V-49（单测层） | **通过** | `pnpm exec vitest run src/lib/notepad src/components/notepad src/lib/openFile src/components/viewer` → 63 files / 402 tests passed（2026-11-21）。关键文件：`transforms.test.ts`（21）、`commands.test.ts`、`menus.test.ts`（新增，5）、`search.test.ts`、`cm6.test.ts`、`persistence.test.ts`、`macro.test.ts`、`ipc.test.ts`、`viewerTabHost.test.ts`、`ViewerShell.test.tsx`、`openFile/__tests__/handlers.test.tsx` |
| V-37 | **部分通过** | 上述 vitest 全绿；`pnpm check:refactor` 通过（4989 files，0 超限）；`pnpm exec tsc -b` 通过 |
| V-30～V-33、V-49/V-50（browser，托管三端） | **通过** | 托管 run `44936461619`/`44945018379`/`44951373132`：Linux/Windows/macOS browser 各 22+1（crash-regression + Notepad）全部通过；TC-NP-001..005 三端绿 | 
| V-30～V-33、V-49/V-50（browser 本机） | **通过（本机）** | 新增 `qa-ui-auto-tests/cases/TC-NP-001..005`；`python -m qa_ui_auto run --mode browser --filter TC-NP-001..005 --require-pass --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml` → 5 passed / 0 failed；证据 `qa-ui-auto-report/browser/run-20261122-004206-322632473/`（summary.json、runner_receipt.json、截图、runtime-errors 为空） |
| V-40（native 三端，真实磁盘） | **通过（托管+本机）** | 托管 run `44945018379`：Linux/Windows/macOS native 各 4 shards；TC-NP-101/102 三端全部通过，crash-regression 套件除 `TC-FILE-OPEN-006` 的 Playwright-only 选择器（分支已修）外全部通过；本机隔离会话同样通过（含 `TC-FILE-OPEN-002` 草稿恢复） |
| V-40（Linux native，真实磁盘，本机） | **通过（本机）** | `TC-NP-101`/`TC-NP-102` 在独立 Xvfb `:137`（1600×1000×24）+ `dbus-run-session` + 私有 XDG data/config/cache 下执行 → 各 1 passed；证据 `qa-ui-auto-report/run-20261122-004304-429435665/`、`qa-ui-auto-report/run-20261122-0048*/`。QA 二进制身份 `src-tauri/target/qa-ui-auto/debug/taomni.qa-identity.json` |
| V-41 | **托管通过（Notepad 用例）/ 含既有套件结果** | `.github/workflows/qa-ui-auto-platforms.yml` run `44931303328`（scope=selected，三端 browser+native，selected 自动并入 `crash-regression`）。Notepad 结果见下方 V-30～V-33/V-40 行；既有套件失败单独判定 |
| V-42 | **托管通过** | 托管 run `44931303328` 在 Linux/Windows/macOS 三端完成 release QA 构建与 native 执行；本机同时通过 `pnpm exec tsc -b`、`pnpm check:refactor` |
| V-43～V-45、V-51 | **未执行** | 真机手册 §8 项目；打印/提权/回收站/远程副本/大文件 5/12/35 MB/遗留草稿迁移等仍需真机逐项执行 |
| V-30～V-33、V-47～V-51（托管三端） | **托管运行中** | `gh workflow run qa-ui-auto-platforms.yml --ref feat/notepad-2plus-impl -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native -f case_ids=TC-NP-001,...,TC-NP-102`；shard 报告与失败修复记录见运行页面 |

实现范围与有意偏差见 [taomni-notepad-implementation-notes.md](taomni-notepad-implementation-notes.md)。
