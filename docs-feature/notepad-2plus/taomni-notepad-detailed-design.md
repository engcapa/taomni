# Taomni Notepad 工作台 详细设计

> 本文档是 `taomni-notepad-design.md`（v1.0）的**细化与替代设计**，不修改三份来源文档。开发任务板见 [taomni-notepad-development-tasks.md](taomni-notepad-development-tasks.md)，高保真交互原型见 [taomni-notepad-prototype.html](taomni-notepad-prototype.html)。
> 决策、验收、任务与验证 ID 在本设计内稳定。**本轮只做设计，没有实现任何产品代码，所有 V-* 均为待执行。**

## 1. 设计摘要与范围

- 类型：现有能力扩展（把 `file-viewer` 文本编辑能力扩展为类 Notepad++ 的多文档文本编辑工作台）+ 功能设计细化
- 文档位置：`docs-feature/notepad-2plus/taomni-notepad-detailed-design.md`
- 设计状态：**部分可实施**。DEC-01～DEC-04 待用户决策；依赖它们的 TASK-NP-15、TASK-NP-17、TASK-NP-04（仅回收站部分）、TASK-NP-14（仅书签归并部分）按条件草案编写，其余任务可开工。
- 来源：
  - `docs-feature/notepad-2plus/adr-taomni-notepad.md`（ADR）
  - `docs-feature/notepad-2plus/taomni-notepad-decisions.md`（用户 2026-11-21 决策表：**89 支持 / 43 不支持 / 1 待定 = 移至回收站，共 133 项**）
  - `docs-feature/notepad-2plus/taomni-notepad-design.md`（v1.0 设计）
  - 用户请求：基于以上三份文档出新的详细设计（含 TASK-*）与高保真交互原型；只设计，不开发。
- 调研基线：工作区当前提交（2026-11-21，含未提交的上述文档与原型）；只读调研，未运行产品测试。v1.0 中与源码不符之处已在 §2 更正。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须三端可构建运行。
- 本轮真机执行端：当前环境为 **Linux（Replit）**。设计阶段不执行真机；后续实施以 Linux 为首个真机端，Windows / macOS 保留计划，未执行不单独阻塞交付。
- 推荐方案：新增专用 **Notepad 工作台**（DEC-01 推荐 B），内部复用现有 `file-viewer` 的文档读写 IPC、CodeMirror 6 编辑器与 `FindInFilesPanel`、Git/Viewer 已有的 `@codemirror/merge`；纯文本变换与命令注册放入新建共享库 `src/lib/notepad/`；文档以 `docId` 标识（不再以路径为键），支持未命名文档、克隆与双视图；备份、会话、宏、最近文件落盘到应用数据目录。

**用户问题与完成后的可观察结果。** 用户希望 Taomni 内置一个能替代 Notepad++ 日常文本工作的编辑器：多文档标签、双视图、强力查找替换、行与列操作、编码与行尾转换、会话与自动备份、宏、文件对比、打印。完成后，用户能从应用打开 Notepad 工作台，在其中完成上述 89 项能力（若 DEC-03 通过则为 90 项）；43 项被决策为“不支持”的功能**在 UI 中没有入口、没有占位菜单、没有“即将推出”文案**（DEC-16）。

**本次不做：** 语法高亮、折叠、自动完成、括号匹配、注释、缩进、语言菜单、UDL、插件体系、Run 菜单、监控模式、项目面板/文件夹工作区面板、隐藏行、始终置顶、右键菜单定制、命令行参数集、多实例设置、本地化切换、更新检查等 43 项（清单见 decisions 文件“❌ 不支持”行）。现有 viewer 里已有的 Markdown/图片/HTML 等预览能力不改，不属于本设计。

**设计与原型的关系。** 原型是**设计产物**，用于评审布局、交互与状态，不是产品实现，也不证明任何 AC 已满足。原型内标有“示意”的部分（见 §4.4）在实现时需要独立设计验证。

## 2. 当前实现与功能缺口

v1.0 把“现状”写得偏宽泛。以下为按源码核对后的**更正表**（核对方式：读取/检索，未运行）。

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/viewer/{ViewerShell,TextEditor,EditorSurface,ViewerDialogs}.tsx` | 单文件 viewer：一个文档对应一个界面；文本编辑基于 CodeMirror 6 | 编辑器表面复用，外壳（标签、双视图、面板、菜单）新建 | 源码检索，高 |
| `src/lib/viewer.ts` `ViewerDocument` | 文本编辑上限 5 MB，硬上限 20 MB，分块读取 256 KB | P0 沿用该上限（DEC-12）；50 MB 仅做 spike | 源码，高 |
| `src/lib/openFile/{index,classifyFile,closeGuard,pathIdentity,preferences,viewerCommands,useViewerRecovery}.ts` | 文件分类、关闭守卫、路径身份；`viewerCommands` **只有 `viewer.save` 一个命令**；`useViewerRecovery` 用 `taomni.viewer.tabs.v1` 做启动恢复 | 命令注册表在 `src/lib/notepad/` 新建，不扩展 `viewerCommands`；启动恢复复用并扩展 `useViewerRecovery` | 源码，高 |
| `src/stores/viewerDrafts.ts` | 草稿存 localStorage（`taomni.viewer.drafts.v1`），每次编辑写入**全文** | 大文件下不可扩展；由磁盘备份取代并做一次性迁移（DEC-14） | 源码，高 |
| 文档仓库 `documentStore`（以 `documentPathKey` 为键） | 路径即身份；无法表示未命名文档、同一文档的两个视图 | 新增 `docId` 身份（DEC-13）；路径只是属性。spike S-1 先验证 | 源码，中（改造面待 S-1 确认） |
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
| `src/stores/app/tabsSlice.ts`（`guardViewerClose`）、`src/layouts/main/{usePlatformShortcuts,detachedWindows}.ts` | 应用级标签与快捷键、独立窗口 | Notepad 宿主决策（DEC-01）直接影响此处 | 源码，高 |
| `src/components/settings/SettingsPanel.tsx`、`FileOpenSettings.tsx`、`src/lib/appTheme.ts` | 设置面板、文件打开偏好、主题 | Notepad 首选项作为设置面板新分页；主题沿用 `appTheme` | 源码，高 |
| `src/components/viewer/markdown/markdownExport.ts` `printMarkdownHtml` | 通过隐藏 iframe 打印 | 打印方案沿用该技术（TASK-NP-21 先 spike 三端表现） | 源码，高 |
| `zh-CN.ts:949` | 占位文案“本阶段尚未启用宏录制功能” | 宏实现后移除占位 | 源码，高 |
| Rust 侧无原生应用菜单 | 菜单均为 React 实现 | Notepad 菜单栏为 React 组件；不引入原生菜单 | 源码，高 |
| 测试与规则 | `pnpm test`、`pnpm exec vitest run <file>`、`pnpm build`、`pnpm check:refactor`、`cargo test --lib`；单文件 ≤ 800 行；崩溃回归套件；`qa-ui-auto-tests/cases` | 所有拟新增文件遵守 800 行限制；改动命令/IPC 须跑崩溃回归 | 仓库约定，高 |
| 依赖 | React 19、zustand 5、CodeMirror 6 | 不引入新编辑器 | package.json，高 |

**调用链与数据归属（现状）。** 文件入口 `openFile` → `classifyFile` → 文本类进入 `file-viewer` 标签（`FileViewerTabInfo`）→ `ViewerShell` → `TextEditor` → `viewer_*` IPC。文档内容由 `ViewerDocument` 与 `documentStore`（路径为键）持有，草稿写 localStorage。工作区平台（workspace-platform）里也会承载 viewer。

**v1.0 与源码不一致处（已在上表更正）：** ① 宏占位文案与“宏尚未存在”的说明属实，但 v1.0 未指出 `viewerCommands` 仅有一个命令；② v1.0 把对比能力描述为“新写”，实际 Git DiffViewer 与 ViewerDiff 已有 `@codemirror/merge`；③ v1.0 没有指出 `documentStore` 以路径为键对未命名/克隆文档的约束；④ v1.0 没有指出 `viewer_write_text` 需要完整 SHA-256，影响另存为与新建文件的接口设计；⑤ 回收站相关基础设施已存在。

## 3. 验收条件

通用约定：除特别说明，下列行为在三端（Windows / macOS / Linux）一致；快捷键 `Mod` 在 Windows/Linux 为 Ctrl、macOS 为 Cmd。验收以真实应用行为为准，原型只作展示参考。

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | 工作台已打开 | 新建 / 打开 / 保存 / 另存为 / 保存副本 / 全部保存 / 重命名 | 新建得到“新建 N”未命名文档；保存未命名文档弹出另存为；**保存副本**写出新文件而当前文档继续指向原文件；**重命名**改变磁盘文件名并更新标签和最近文件；保存使用原子写入；磁盘中途变化时按 AC-09 提示而不是静默覆盖 | 三端；远程文件见 AC-09 |
| AC-02 | 有多个文档，含未保存与固定标签 | 关闭 / 全部关闭 / 关闭其他 / 关闭未固定 / 关闭左侧 / 右侧 / 关闭未修改 | 有未保存修改的文档逐个提示保存/不保存/取消；取消则整个批量操作终止；固定标签不被“全部关闭/关闭其他/关闭未固定”关闭 | 三端 |
| AC-03 | **仅 DEC-03 确认“做”后生效。** 已保存的磁盘文件 | 文件 → 移至回收站 | 二次确认后文档关闭、文件进入系统回收站（Windows 回收站 / macOS 废纸篓 / Linux 回收站）；未命名或远程文档该项禁用；失败给出可见错误且文档保持打开 | 三端；DEC-03 未确认前保持待定，不实现 |
| AC-04 | 打开过若干文件 | 文件 → 最近文件；恢复最近关闭文件；打开全部最近文件；清空 | 列表按最近使用排序，数量受首选项上限限制；已不存在的文件点击后提示并可从列表移除；清空后列表为空且持久化 | 三端 |
| AC-05 | 打开了一组文档，含选区、滚动位置、书签、只读标记 | 保存会话 / 加载会话 | 会话保存为带 `version` 字段的 JSON；加载后恢复文件集合、活动文档、各视图分配、选区、滚动、书签；缺失文件列出并跳过，不崩溃 | 三端；未命名文档的内容通过 AC-07 备份恢复 |
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
| AC-32 | 打开多个文档 | 拖动排序标签；固定；滚轮/`Mod+Tab`/`Mod+PageUp` 切换；窗口菜单排序；文档切换器 | 固定标签靠左且无关闭按钮；MRU 切换器按最近使用排序；窗口菜单可按名称/路径/类型/长度/修改时间排序 | 三端；`Ctrl+Tab` 在 WebView 中可能被占用，见 §10 |
| AC-33 | 打开多个文档 | 双视图（左右/上下）；旋转；移动到另一视图；克隆；同步滚动 | 各视图独立标签；克隆后两视图指向**同一缓冲区**，编辑与撤销栈同步；关闭一侧不丢失文档；同步滚动可开关 | 三端 |
| AC-34 | 工作台打开 | 全屏 / Post-It / 专注模式 | 隐藏的界面元素与手册描述一致；退出键可恢复；状态随会话保持 | 三端；全屏在三端使用各自窗口 API |
| AC-35 | 有文本 | 行号与边距、垂直标尺、自动换行、缩放、显示空格/Tab/行尾/不可见字符/缩进线/折行标记 | 各开关即时生效；缩放仅作用于当前视图（可选跨视图同步）；标尺列可配置 | 三端 |
| AC-36 | 工作台打开 | 文档地图、文档列表、字符面板/搜索结果面板的停靠与浮动 | 面板可在**右侧、底部、浮动**三种位置之间切换（DEC-02 推荐范围）；位置随首选项保存；文档地图点击/拖动定位；文档列表可排序、分组并切换 | 三端；DEC-02 |
| AC-37 | 工作台打开 | 主题与深浅色；状态栏/工具栏/菜单栏显示开关；文件摘要 | 跟随应用主题（浅/深/跟随系统）；状态栏字段可点击切换；菜单栏可隐藏并能通过快捷键恢复；摘要显示完整路径、时间戳、字节/字符/词/行数 | 三端 |
| AC-38 | 文本含 URL / 路径 | 点击链接；选区动作；复制路径信息 | URL 经系统浏览器打开（可在首选项关闭）；选区动作支持打开文件/所在文件夹/联网搜索（搜索引擎可配）；复制文件名/路径/目录/全部路径 | 三端；只允许 `http/https` 及本地路径 |
| AC-39 | 有文本或选区 | 字符面板；选区脱敏；哈希（MD5/SHA-1/SHA-256/SHA-512）；Base64/Quoted-Printable/URL 编解码；ASCII↔十六进制等转换 | 结果可复制或替换选区；哈希可作用于文本、文件、选区；转换非法输入时给出错误而非静默改写 | 三端 |
| AC-40 | 工作台打开 | 录制 / 停止 / 回放；多次运行；运行到文件末尾 | 仅录制**白名单命令**（见 DEC-07）；弹窗类命令不可录并有提示；运行到文件末尾遇无进展时终止，不死循环 | 三端 |
| AC-41 | 已录制宏 | 保存宏并绑快捷键；改键；删除；执行已保存宏 | 宏出现在宏菜单；快捷键冲突时提示并不覆盖已有命令；删除需确认 | 三端 |
| AC-42 | 宏文件 `macros.json` 被外部修改 | 打开宏菜单 | 校验 SHA-256，不一致时警告并禁用执行，直到用户“校验宏文件”确认；**未经确认的宏文件永远不被执行** | 三端 |
| AC-43 | 当前文档 + 另一文件/剪贴板/选区 | 对比 | 并排差异（忽略空白/大小写可选），上一处/下一处差异；超过 5 MB 给出明确提示；对比不改动原文档 | 三端 |
| AC-44 | 有文档 | 打印 / 立即打印；打印设置；打印到 PDF | 打开系统打印对话框；设置项含行号、页边距、页眉页脚、颜色模式；PDF 通过系统“打印到 PDF”实现，**无应用内 PDF 引擎** | 三端；Linux 依赖 WebView 打印能力，见 §10 |
| AC-45 | 工作台打开 | 首选项对话框；快捷键映射器；新建文档默认值 | 首选项分页保存并立即生效；快捷键映射器检测冲突，可重置为默认；新建文档使用默认编码/行尾/命名规则 | 三端；macOS 默认键位使用 Cmd |
| AC-46 | 已有 file-viewer、Markdown、Git diff 能力 | 日常使用 | 现有查看器、Markdown、图片/HTML 预览、Git diff、工作区编辑器行为不退化；不出现 43 项“不支持”功能的任何入口；新增文件均 ≤ 800 行；崩溃回归套件通过 | 三端 |
| AC-47 | 三端构建 | 构建与运行 | 条件编译和平台 API（提权、回收站、文件管理器、终端）在三端可构建；缺少平台能力时降级路径有明确文案 | 三端 |

## 4. 方案与关键决策

**推荐实现。** 新增 Notepad 工作台（DEC-01 推荐 B），由 React 实现菜单栏、工具栏、标签栏、双视图、面板区与状态栏；编辑器表面沿用 CodeMirror 6，但文档状态不再绑定路径，而是由新的 `notepadStore`（zustand）按 `docId` 持有；所有“命令”统一登记到命令注册表，使菜单、工具栏、快捷键、宏录制、快捷键映射器共享同一份命令定义。文本变换（排序、去重、大小写、空白、行操作、列编辑序列生成、扩展模式转义解析等）写成**不依赖 DOM 的纯函数**，放在 `src/lib/notepad/`，使其可被单元测试，也可被宏回放复用。

### 4.1 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-00 功能范围 | 133 项功能中 89 支持 / 43 不支持 / 1 待定 | 按用户决策表执行 | 用户已定 | 用户 2026-11-21 决策表；用户本次请求 | 全部 AC；TASK-NP-* |
| DEC-01 宿主架构 | **A**：保持“一个文件一个应用标签”，Notepad++ 式多文档作为其内部子能力；改动小，但双视图/克隆/会话与应用标签体系冲突，应用级标签栏会被文件撑满。**B**：新增专用 “Notepad” 工作台标签，内部自带文档标签与双视图；与 Notepad++ 心智一致，需新增 TabKind、`tabsSlice` 守卫与恢复逻辑 | **推荐 B**：双视图、克隆、固定、MRU、会话都要求“一个宿主多个文档”，A 需要大量绕行。原型按 B 绘制 | **待用户决策** | 代码依据：`tabsSlice.guardViewerClose`、`FileViewerTabInfo` 一标签一文件 | AC-32、AC-33；TASK-NP-15（阻塞）、TASK-NP-01、TASK-NP-08 |
| DEC-02 面板停靠 | **限定型**：文档地图/文档列表/字符面板/搜索结果四个面板可在右侧、底部、浮动三处切换；实现成本中等。**通用停靠系统**：任意边缘、成组标签页、拖动重排；成本高，且 v1.0 未给出 UI 规格 | **推荐限定型**，通用停靠留作后续；决策表 F-70 的“任意边缘/成组/拖动重排”在限定型下**部分满足**，需用户确认接受该缩范围 | **待用户决策** | 决策表 F-70；成本评估 | AC-36；TASK-NP-17（阻塞） |
| DEC-03 移至回收站（F-03） | **做**：复用 `trash = "5"` 与 `filebrowser/local_ops/trash.rs`，成本低；**不做**：从文件菜单中移除 | **推荐做**（P1）；确认前不实现，也不在原型中当作已定功能（原型内带“待定”标记） | **待用户决策** | 决策表“待定”行 | AC-03；TASK-NP-04（仅回收站子项） |
| DEC-04 书签是否与工作区编辑器统一 | **先保持两套**：Notepad 书签按文档存会话内；工作区编辑器书签（`TodosBookmarksPanel`）不动。**统一**：共享存储，需迁移与冲突规则 | **推荐先保持两套**，统一另立任务；避免本次改动扩散到工作区编辑器 | **待用户决策** | 代码依据：`TodosBookmarksPanel.tsx` | AC-31；TASK-NP-14（仅归并子项） |
| DEC-05 核心实现而非插件；编辑器基于 CodeMirror 6 | 插件化 vs 核心 | 沿用 ADR：核心实现，CM6 | v1.0 提议（沿用） | `adr-taomni-notepad.md` | 全部 |
| DEC-06 共享库 `src/lib/notepad/` | 纯函数集中 vs 散在组件内 | 沿用 ADR | v1.0 提议（沿用） | ADR | TASK-NP-02 |
| DEC-07 宏安全模型 | 录制任意脚本 vs 仅录制已注册白名单命令 | 沿用 ADR：只记录白名单命令，存 `macros.json` 并以 SHA‑256 校验；外部改动后禁止执行直到确认 | v1.0 提议（沿用） | ADR | AC-40～42；TASK-NP-19；V-27～V-29 |
| DEC-08 会话文件格式 | XML（Notepad++ 同款）vs JSON | **JSON**，`.taomni-session.json`，含 `version` 字段便于迁移 | agent 自决 | v1.0 提议使用 JSON 的方向；`version` 字段为本设计补充，依据仓库其他持久化均带版本键 | AC-05；TASK-NP-08 |
| DEC-09 无选区的行操作 | 报错 / 仅作用当前行 / 默认全文并确认 | **默认全文并确认**，勾选“不再提示”后直接执行；与 Notepad++ 行为一致且避免静默大范围改动 | agent 自决 | Notepad++ 手册行为 + 防误操作 | AC-21；TASK-NP-02/03 |
| DEC-10 差异内核 | 自写 diff / `@codemirror/merge` | **以 `@codemirror/merge` 为唯一内核**，取代工作区 `editorCompareModel` 的独立实现；上限 5 MB | agent 自决 | Git DiffViewer 与 ViewerDiff 已使用该库 | AC-43；TASK-NP-20 |
| DEC-11 跨文件查找入口 | 新写 / 复用 | 复用 `FindInFilesPanel` 与 `workspace_search.rs` | agent 自决 | 源码 | AC-27；TASK-NP-13 |
| DEC-12 大文件阈值 | 沿用 5/20 MB / 提高到 50 MB / 更高 | **P0 沿用 5 MB 可编辑、20 MB 硬上限、256 KB 分块**；50 MB 仅作 spike S-4，不承诺 | agent 自决 | `ViewerDocument` 现有常量；决策表 F-13 为 P1 | AC-13；TASK-NP-00(S-4)、TASK-NP-23 |
| DEC-13 文档身份 | 路径为键 / `docId` | **`docId`**，路径作为属性；先由 S-1 验证对 `documentStore` 的改造面 | agent 自决 | `documentStore` 以 `documentPathKey` 为键，无法表示未命名/克隆 | AC-01、AC-33；TASK-NP-00(S-1)、TASK-NP-01 |
| DEC-14 草稿与备份 | 继续 localStorage / 磁盘备份 | **磁盘备份**取代 `taomni.viewer.drafts.v1`，保留一次性迁移；不复用 `backup/` 统一备份引擎（语义不同） | agent 自决 | localStorage 每次编辑写全文，大文件不可扩展 | AC-07、AC-08；TASK-NP-09 |
| DEC-15 远程文件 | 允许写回 / 只读临时副本 | **只读临时副本，无写回、无备份** | v1.0 提议（沿用） | ADR | AC-09；TASK-NP-07 |
| DEC-16 不支持项的呈现 | 灰显占位 / 完全不出现 | **完全不出现**（无菜单项、无设置项、无“即将推出”） | 用户已定（随决策表的“不支持”决定）；呈现方式沿用 ADR | 决策表；ADR | AC-46；TASK-NP-24；V-38 |
| DEC-17 Windows 特有功能的跨平台表达 | 仅 Windows / 跨平台等价 | UAC 保存、回收站、外部打开等改为三端等价能力；macOS 使用 Cmd 键位 | v1.0 提议（沿用） | ADR / v1.0 | AC-15、AC-16、AC-45 |
| DEC-18 原型范围 | 全部交互 / 核心交互 + 示意 | 核心交互真实可操作，难以在 HTML 中真实呈现的（多光标、矩形选择、虚拟空格、系统打印、提权对话框）为“示意”，并在原型“原型覆盖范围”抽屉中列明 | agent 自决 | §4.4 | 无（设计评审用） |

> **待用户决策的具体问题**（已随本设计交付时向用户提出）：DEC-01 宿主采用 A 还是 B；DEC-02 面板采用限定型还是通用停靠；DEC-03 是否实现移至回收站；DEC-04 书签是否先保持两套。收到答复后同步更新本表、§4.2、§6 受影响任务、§9。

### 4.2 用户流程与交互

**入口（DEC-01=B 的草案）。** 左侧栏“Notepad”入口或命令面板“打开 Notepad 工作台”；文件管理器/欢迎页“用 Notepad 打开”；拖放文件到应用。工作台内部：菜单栏（文件/编辑/搜索/视图/编码/工具/宏/对比/窗口）、工具栏、文档标签栏（每个视图一条）、可选第二视图、右侧/底部面板、状态栏（行列、选区、字符数、EOL、编码、INS/OVR、缩放、备份状态）。**DEC-01=A 时**：菜单栏与工具栏作为 file-viewer 文本模式的附加外壳，文档标签退化为应用标签，双视图/克隆/窗口菜单/MRU 范围需重新评审。

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 无文档 | 打开工作台 | — | 显示最近文件与“新建”空态 | 最近文件不存在 → 提示并可移除 |
| 文档已修改 | 保存 | 路径存在且磁盘未变 | 原子写入，标签“已修改”标记消失，变更历史边距变绿 | 磁盘已变 → AC-09 对话框；无权限 → AC-16 流程；写入失败 → 错误条，文档保持已修改 |
| 文档已修改 | 关闭标签 | — | 弹出保存/不保存/取消 | 取消 → 保持打开 |
| 文档打开 | 外部改动被检测 | 窗口聚焦或保存前 | 顶部横幅：重载 / 保留我的 / 对比 | 关闭横幅 → 标记为“与磁盘不同步”，保存时再提示 |
| 编辑中 | 开始录制 | 命令白名单 | 工具栏与菜单栏出现“录制中 · N 步”；弹窗命令被拒绝并提示 | 停止后可回放/保存 |
| 双视图 | 克隆文档 | 当前文档已打开 | 另一视图出现同缓冲区标签；两边编辑同步 | 关闭一侧不丢文档 |
| 应用异常退出后重启 | 启动 | 存在备份 | 恢复文档并标记已修改，状态栏提示“已从备份恢复” | 备份损坏 → 跳过该项并提示 |
| 文件 > 5 MB | 打开 | 在 5～20 MB 之间 | 顶部提示进入受限编辑模式并列出被关闭的功能 | > 20 MB → 拒绝并说明 |

键盘与焦点：所有对话框 `Esc` 取消、`Enter` 确认；查找条可用 `Esc` 关闭并把焦点还给编辑器；`Alt+字母` 打开菜单栏（macOS 无此行为，保留 Cmd 快捷键）；IME 组合输入期间不触发快捷键和宏录制。

### 4.3 数据流、状态与生命周期

- **权威状态**：`notepadStore`（拟新增，zustand）。结构：`docs: Record<docId, NotepadDoc>`、`views: [ViewState, ViewState?]`（每个视图有标签顺序与活动 `docId`）、`mru`、`panels`（位置与显隐）、`ui`（菜单栏/工具栏/状态栏显隐、全屏/Post-It/专注）、`find`（查找条状态）、`macro`（录制缓冲与已保存宏）。
- `NotepadDoc`：`docId`、`path?`、`name`、`encoding`、`bom`、`eol`、`readOnly`（编辑器内）、`remote`（只读临时副本）、`pinned`、`bookmarks`、`marks`、`savedHash`（上次保存/加载时磁盘内容 SHA-256）、`dirty` 派生自缓冲区与 `savedHash`/编码/行尾。**克隆**两视图共享同一 `docId`，只是每视图各有选区、滚动与撤销历史所在的 CodeMirror state（撤销栈同步需 S-2 验证；若 CM6 不能共享，改为共享 `Transaction` 流）。
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

- 当前有效图稿：[`taomni-notepad-prototype.html`](taomni-notepad-prototype.html)（单文件、可直接用浏览器打开；v2；覆盖浅色/深色、Windows/Linux 与 macOS 键位切换；推荐窗口宽度 ≥ 1280 px）。
- 图稿决策：DEC-18（agent 自决）；DEC-01、DEC-02 的方案选择**尚未向用户展示后确认**，原型按 DEC-01=B、DEC-02=限定型绘制，**这不代表用户已选择**。
- 原型内入口：顶部“场景”按钮可触发外部修改、崩溃恢复、宏文件被改、远程文件、12 MB / 35 MB 大文件、需提权文件、GBK 文件；“待用户决策”按钮展示 DEC-01～04；“原型覆盖范围”按钮列出真实交互与示意内容。
- 原型中**真实可操作**：新建/保存状态、另存/重命名/关闭系列、最近文件、查找替换（普通/扩展/正则、全部查找、结果面板、标记、令牌样式）、行操作与大小写与空白、排序与去重、书签、变更历史边距、标签固定与 MRU、双视图/克隆/同步滚动、面板（文档地图/列表/字符/结果）停靠位置、显示符号、全屏/Post-It/专注、编码重新解释与转换、行尾转换、宏录制/回放/保存/校验、对比、打印预览、首选项、快捷键映射器、会话保存/加载、备份与崩溃恢复、哈希/MIME。
- 原型中**仅示意**：多光标（只会选中下一个同名词）、矩形选择（用多行选区代替）、虚拟空格、特殊粘贴、开始/结束选择（近似）、提权保存（只有对话框）、回收站（待定演示）、系统打印/PDF（不调用）、`Ctrl+Tab` MRU（用对话框代替）。43 项不支持功能**没有任何入口**。
- 修订记录：v1 → v2：补入双视图旋转、面板位置切换、宏安全、崩溃恢复场景与“原型覆盖范围”抽屉；v1 已被替代。
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
| 浏览器 QA stub | `src/stubs/commands/*`、`src/stubs/tauri-core.ts`（`viewer_` 前缀走 `invokeViewer`） | 新增命令需在 stub 中补齐 | 与真实 IPC 同形的结果 | 未补 stub 的命令不得在浏览器 QA 中被调用 |

类型签名（拟）：

```ts
type DocId = string;
interface NotepadDoc { docId: DocId; path?: string; name: string; encoding: string; bom: boolean;
  eol: 'LF'|'CRLF'|'CR'; readOnly: boolean; remote: boolean; pinned: boolean;
  savedHash?: string; bookmarks: number[]; }
interface NotepadCommand { id: string; label: string; defaultKey?: string; recordable: boolean;
  run(ctx: CommandContext, args?: Record<string, unknown>): void; }
interface SessionFileV1 { version: 1; views: {docs: DocId[]; active?: DocId}[]; docs: SessionDoc[]; }
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
| `src/stores/notepadStore.ts`（拟新增） | `docId` 为键的文档仓库、视图、面板、宏、查找状态 | AC-01、AC-33 | TASK-NP-01 |
| `src/components/notepad/`（拟新增） | `NotepadWorkbench`、`MenuBar`、`Toolbar`、`DocTabs`、`SplitViews`、`StatusBar`、`FindBar`、`panels/*`、`dialogs/*` | AC-32～AC-37 | TASK-NP-15/16/17 |
| `src/stores/app/tabsSlice.ts`、`src/layouts/main/usePlatformShortcuts.ts` | DEC-01=B：新增 Notepad TabKind、关闭守卫、快捷键路由 | AC-32 | TASK-NP-15 |
| `src/lib/openFile/*`、`useViewerRecovery.ts` | 扩展恢复；`classifyFile` 增加“用 Notepad 打开” | AC-06、AC-14 | TASK-NP-08/23 |
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
- 实施内容：S-1 以 `docId` 取代路径键的改造面；S-2 两个 CM 视图共享缓冲区与撤销栈（克隆）可行性；S-3 文档地图（minimap）实现方案与性能；S-4 20～50 MB 文件的分块编辑/只读浏览可行性（DEC-12，只做结论）；S-5 三端提权保存方案与安全边界；S-6 回收站在三端的行为与失败模式（DEC-03 确认后）。
- 对应验收：AC-01、AC-13、AC-16、AC-33、AC-36。
- 验证与完成条件：每个 spike 给出“可行/不可行/需调整”结论、证据（命令输出或截图路径）与对设计的修订建议；V-39。
- 并行与集成：S-1～S-6 互相独立，可并行；结论回流到本设计的 DEC/风险。

### TASK-NP-01 文档身份与 store

- 职责与文件范围：`src/stores/notepadStore.ts`、`src/lib/notepad/doc/`；不改 `documentStore` 现有调用者。
- 输入与必读：§4.3、DEC-13、S-1 结论。
- 依赖：TASK-NP-00（S-1）。
- 实施内容：定义 `NotepadDoc`、视图与 MRU、脏状态派生；未命名文档命名规则（`新建 {n}`）；克隆共享 `docId`；与 `documentStore` 的适配层（路径文档仍可被其他视图读取）。
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

- 职责与文件范围：新增 `viewer_save_as`、`viewer_rename`（及 DEC-03 确认后的 `viewer_trash`）；前端新建/打开/保存/另存/保存副本/全部保存/重命名/关闭系列。
- 输入与必读：§4.5；`commands/viewer.rs`；`closeGuard`；DEC-03。
- 依赖：TASK-NP-01；回收站子项依赖 DEC-03。
- 实施内容：原子写入；覆盖确认；关闭系列尊重固定标签；保存副本不改变当前文档路径；重命名同步最近文件与会话。
- 对应验收：AC-01、AC-02、AC-03（条件）。
- 验证与完成条件：V-09、V-10；Rust 单测 `cargo test --lib`。
- 并行与集成：回收站子项可延后，不阻塞其余。

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

### TASK-NP-15 工作台宿主

- 职责与文件范围：标签栏（固定、拖动排序、MRU、窗口菜单排序）、双视图、克隆、同步滚动、文档列表；`tabsSlice` 与快捷键路由（DEC-01=B）。
- 依赖：TASK-NP-00（S-2）、TASK-NP-01；**DEC-01 待用户决策**。
- 实施内容：B 方案：新增 Notepad TabKind 与关闭守卫；A 方案：改写为文件标签附加外壳（范围需重评）。
- 对应验收：AC-32、AC-33、AC-36（文档列表）。
- 验证与完成条件：V-30、V-31。
- 并行与集成：本任务是 UI 集成的中心，建议单人负责；等待 DEC-01 前可先做不依赖宿主的组件。

### TASK-NP-16 视图设置

- 职责与文件范围：全屏/Post-It/专注、行号与标尺、自动换行与缩放、显示符号、主题与栏显隐、文件摘要。
- 依赖：TASK-NP-03、TASK-NP-15。
- 对应验收：AC-34、AC-35、AC-37。
- 验证与完成条件：V-32。
- 并行与集成：与 TASK-NP-17 并行。

### TASK-NP-17 文档地图与面板停靠

- 职责与文件范围：文档地图、面板位置切换（右/底/浮动）。
- 依赖：TASK-NP-00（S-3）、TASK-NP-15；**DEC-02 待用户决策**。
- 对应验收：AC-36。
- 验证与完成条件：V-33。
- 并行与集成：通用停靠系统（若 DEC-02 选通用型）另立任务，不在本任务范围。

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

## 7. 自动化测试计划

测试文件均为**拟新增**，路径在实现时核对；工作目录为仓库根；单文件测试使用 `pnpm exec vitest run <file>`（不要多带一个 `--`）。当前**全部待执行**，设计阶段没有“改前基线”之外的结果。

| V ID | AC / 用途 | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-01 文档身份 | Vitest `src/stores/__tests__/notepadStore.test.ts` | 创建未命名/路径文档、克隆 | 未命名文档命名递增；克隆共享 `docId`；脏状态派生 | `pnpm exec vitest run src/stores/__tests__/notepadStore.test.ts` | 无基线 / 待执行 |
| V-02 | AC-33 克隆同步 | Vitest | 两视图指向同文档并编辑 | 缓冲区一致 | 同上 | 待执行 |
| V-03 | AC-21 排序 | Vitest `src/lib/notepad/transforms/__tests__/sort.test.ts` | 7 口径 × 升降序，含稳定性与列键 | 结果与预期序列一致；相等键保持原序 | `pnpm exec vitest run src/lib/notepad/transforms/__tests__/sort.test.ts` | 待执行 |
| V-04 | AC-21 去重/删空行/反转/打乱 | Vitest | 含仅空白行与连续重复 | 去重保留首次；连续去重只去相邻 | 同上模式 | 待执行 |
| V-05 | AC-22 大小写 | Vitest | 8 种转换，含中文/Unicode | 与手册示例一致 | 同上模式 | 待执行 |
| V-06 | AC-22 空白 | Vitest | Trim/TAB↔空格/行尾转空格 | 全部/仅行首选项正确 | 同上模式 | 待执行 |
| V-07 | AC-17 命令注册表 | Vitest | 注册、冲突、`recordable` | 重复键位被检出；`Mod` 映射 | `pnpm exec vitest run` 指定文件 | 待执行 |
| V-08 | AC-17 无选区整行复制/剪切 | Vitest + 编辑器挂载 | 无选区 `Mod+C` | 剪贴板为整行；开关生效 | 同上 | 待执行 |
| V-09 | AC-01 保存/另存/保存副本 | Rust `cargo test --lib` + Vitest | 临时目录 | 原子写入；覆盖需确认；保存副本不改当前路径 | `cargo test --lib`（`src-tauri`）；vitest | 待执行 |
| V-10 | AC-02 关闭系列 | Vitest | 含固定与脏文档 | 固定不被关；取消终止 | 同上 | 待执行 |
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
| V-30 | AC-32 标签行为 | 浏览器 QA（拟新增 TC） | 固定、排序、MRU | 符合验收 | `qa-ui-auto` 现有执行方式（实施时核对） | 待执行 |
| V-31 | AC-33 双视图 | 浏览器 QA | 旋转、移动、克隆 | 符合验收 | 同上 | 待执行 |
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
- 操作：双视图/克隆/同步滚动、面板切换、全屏/专注、宏录制与外部改动 `macros.json`、对比、打印（含“打印到 PDF”）、快捷键映射器冲突。
- 状态：待执行；Windows / macOS 同项目保留，未执行不继承 Linux 结果。

## 9. 验收追踪与交付条件

### 9.1 验收追踪

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4.3/4.5 | NP-01/04 | V-01 V-09 V-43（Linux） | 单测/真机日志 | 未实现 |
| AC-02 | §4.2 | NP-04 | V-10 | 单测 | 未实现 |
| AC-03 | DEC-03 | NP-04（条件） | V-09 | 单测+真机 | 待 DEC-03 |
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
| AC-32/33 | DEC-01 | NP-15 | V-30 V-31 | 浏览器 QA+真机 | 待 DEC-01；S-2 |
| AC-34/35/37 | §4.2 | NP-16 | V-32 | 浏览器 QA | 未实现 |
| AC-36 | DEC-02 | NP-15/17 | V-33 | 浏览器 QA | 待 DEC-02；S-3 |
| AC-38/39 | §4.5 | NP-18 | V-34 | 单测 | 未实现 |
| AC-40/41/42 | DEC-07 | NP-19 | V-27～V-29 | 单测 | 未实现 |
| AC-43 | DEC-10 | NP-20 | V-35 | 单测 | 未实现 |
| AC-44 | §4.6 | NP-21 | V-36 | 手工 | 未实现；打印 spike |
| AC-45 | §4.5 | NP-22 | V-37 | 单测 | 未实现 |
| AC-46 | DEC-16 | NP-24 | V-37 V-38 V-41 | 回归 | 未实现 |
| AC-47 | §4.6 | NP-24 | V-42 | 三端构建 | 未执行 |

### 9.2 功能（F-01～F-90）到任务与验收的追踪

F 编号按 decisions 文件中**支持与待定条目**的出现顺序编号；“不支持”的 43 项不编号。

| 功能 | 名称 | 决策表优先级 | 任务 | 验收 | 备注 |
|---|---|---|---|---|---|
| F-01 | 新建 / 打开 / 保存 / 另存 / 保存副本 / 全部保存 / 重命名 | P0 | TASK-NP-04 | AC-01 |  |
| F-02 | 关闭系列：关闭 / 全部关闭 / 批量关闭 | P0 | TASK-NP-04 | AC-02 |  |
| F-03 | 移至回收站 | — | TASK-NP-04 | AC-03 | 待 DEC-03 |
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
| F-55 | 标签页多文档界面 | P0 | TASK-NP-15 | AC-32 | 待 DEC-01 |
| F-56 | 标签固定（Pin） | P2 | TASK-NP-15 | AC-32 | 待 DEC-01 |
| F-57 | 文档切换器（Ctrl+Tab MRU） | P2 | TASK-NP-15 | AC-32 | 待 DEC-01 |
| F-58 | 双视图分屏 | P1 | TASK-NP-15 | AC-33 | 待 DEC-01 |
| F-59 | 克隆文档 | P1 | TASK-NP-15 | AC-33 | 待 DEC-01 |
| F-60 | 双视图同步滚动 | P2 | TASK-NP-15 | AC-33 | 待 DEC-01 |
| F-61 | 全屏 / Post-It / 专注模式 | P2 | TASK-NP-16 | AC-34 |  |
| F-62 | 行号与边距 / 垂直标尺 | P0 | TASK-NP-16 | AC-35 |  |
| F-63 | 文档地图（Minimap） | P1 | TASK-NP-17 | AC-36 | 待 DEC-02 |
| F-64 | 文档列表面板 | P2 | TASK-NP-15 | AC-36 | 待 DEC-01 |
| F-65 | 主题 / 样式配置器与暗色模式 | P1 | TASK-NP-16 | AC-37 |  |
| F-66 | 状态栏 / 工具栏 / 菜单栏定制 | P1 | TASK-NP-16 | AC-37 |  |
| F-67 | 显示符号：空格/Tab/行尾/不可见字符/缩进线/折行标记 | P1 | TASK-NP-16 | AC-35 |  |
| F-68 | 自动换行与缩放 | P0 | TASK-NP-16 | AC-35 |  |
| F-69 | 文件摘要 Summary | P2 | TASK-NP-16 | AC-37 |  |
| F-70 | 可停靠 / 浮动面板体系 | P1 | TASK-NP-17 | AC-36 | 待 DEC-02 |
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
| DEC-01～04 未决 | 宿主、面板、回收站、书签范围影响多个任务 | 向用户提问并按答复更新本文 | NP-15、NP-17、NP-04（回收站）、NP-14（归并） | 用户答复 |
| `documentStore` 路径键改造面不明 | 影响未命名/克隆文档 | S-1 先行 | NP-01 起的全部任务 | S-1 结论 |
| CM6 两视图共享撤销栈 | 克隆体验的核心 | S-2；不可行则共享事务流 | NP-15 | S-2 结论 |
| 文档地图性能 | 大文档时重绘代价 | S-3；超过阈值降级为简化条 | NP-17 | S-3 结论 |
| 20～50 MB 文件 | 内存与渲染 | 仅 spike；P0 不承诺 | 不阻塞 P0 | S-4 |
| 提权保存的安全与三端方案 | 权限越界风险 | S-5 + 安全评审；限定目标文件 | NP-23 | S-5 结论 |
| 正则方言差异 | Notepad++ 为 Boost/PCRE，WebView 为 JS 正则 | 在文档说明差异；环视以外基本兼容；必要时 Rust 侧 `regex`/`fancy-regex` 评估 | NP-12 | 方言差异清单评审 |
| 灾难性正则 | 界面卡死 | 超时中止（V-23） | NP-12 | — |
| `Ctrl+Tab` 在 WebView 被占用 | MRU 切换不可用 | 备用快捷键 + 菜单入口 | NP-15 | 真机验证 |
| Linux 打印能力 | WebView 打印不可用 | spike；降级文案 | NP-21 | 打印 spike |
| IME 与宏/快捷键冲突 | 误触发 | 组合输入期间忽略 | NP-03/19 | V-27 |
| 现有 viewer 回归 | 共享代码改动 | AC-46、崩溃回归、800 行限制 | NP-24 | V-37 V-41 |
| 标记（Mark）是否随会话保存 | 决策表未说明 | 默认**不保存**，在评审时确认 | NP-13 | 评审结论 |

**回退边界。** 代码回退：新增模块与 TabKind 可整体回退到 `file-viewer` 原行为；`documentStore` 适配层须保持向后兼容。数据回退：一次性迁移保留 `taomni.viewer.drafts.v1` 原数据直至迁移成功并确认；备份目录与会话文件可直接删除而不影响用户文件。

**现在可开始的任务：** TASK-NP-00、TASK-NP-02；S-1 完成后 TASK-NP-01，进而 TASK-NP-03～09、10～14、18～20、21。**必须等待：** TASK-NP-15（DEC-01、S-1、S-2）、TASK-NP-17（DEC-02、S-3）、TASK-NP-04 回收站子项（DEC-03）、TASK-NP-14 归并子项（DEC-04）、TASK-NP-23（S-4、S-5）。
