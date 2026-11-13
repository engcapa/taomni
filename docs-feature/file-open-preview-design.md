# 全局文件打开 / 预览 / 编辑（Open File Service）详细设计

## 1. 设计摘要与范围

- 类型：新增能力 + 现有能力扩展（把分散的“用系统应用打开”统一升级为 Taomni 内置的全局文件打开服务与一组共享查看器 / 编辑器）。
- 文档位置：`docs-feature/file-open-preview-design.md`；原型与截图位于 `docs-feature/file-open-preview/`。
- 设计状态：**设计已确认，可进入实施**。DEC-02 / DEC-03 / DEC-04 已由用户选定推荐方案（见决策记录）；尚未开始实现，所有验证为“待执行”。
- 来源（用户需求原文要点）：
  1. 文件资源管理器支持常见文件的预览 / 打开，参考 Win11 资源管理器的预览窗格。
  2. Taomni 自身能打开常见文件：图片、SVG 可查看；txt 类可编辑。
  3. Markdown 在现有基础上支持粘贴图片 / 表格，体验清晰、接近 Typora，支持多种导出格式。
  4. HTML 能打开并预览，类似浏览器。
  5. 以上打开 / 编辑能力**全局共享**，Taomni 各视图、各功能共用。
  6. 先出设计与高保真原型。
- 调研基线：提交 `1344dc3c5`。未运行真实桌面应用，未做任何实现、单元测试、浏览器或真机验证；所有验证项均为“待执行”。
- 平台：Windows、macOS、Linux 三端 Tauri 桌面应用；设计期可用环境为 Linux，原型仅为静态评审稿。
- 推荐方案：
  1. 新增唯一入口 `openFile(target, { context, mode })`，按 `FileKind` 路由到：主界面标签 `file-viewer`、Code Workspace 标签 `viewer`、系统应用；所有现有 `sftpOpenPath` 调用点逐步改走该入口。
  2. 新增一组共享组件：`ImageViewer`（含 SVG）、`TextEditor`（CodeMirror 6 轻量封装）、`MarkdownEditor`（实时渲染）、`HtmlPreview`（沙盒预览）；状态（草稿、脏标记、外部修改）由统一的 `documentStore` 持有，同一文件在任何入口打开都是同一个文档。
  3. Explorer 预览窗格补齐 SVG 渲染 / HTML 缩略预览，并增加“用 Taomni 打开 / 编辑 / 打开方式”操作区。
  4. 新增按路径读写的 Rust 命令（现有 loose-file 命令绑定工作区），带大小上限、编码识别、`expected_hash` 原子写。
- 范围与不做：不做 Office / 压缩包 / 音视频内嵌播放（转系统应用）；PDF 预览列为 P1（pdf.js 懒加载，本轮仅设计占位）；不做云同步、协同编辑；不做远程文件原位编辑回写（远程文件以只读临时副本打开，回写另行设计）；不重写 Code Workspace 的源码编辑器。

高保真原型是评审用的静态交互稿，**不是**产品实现、UI 测试或真机证据。原型文件：[`file-open-preview/prototype-v1.html`](file-open-preview/prototype-v1.html)。

## 2. 当前实现与功能缺口

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/explorer/preview/previewModel.ts` 与预览窗格组件 | 文本 ≤256 KB、图片 ≤20 MB（`explorer_read_preview_bytes` → blob URL）、SVG 经 DOMPurify 净化、CSV 前 100 行、Markdown 走 `renderOfflineMarkdown`；无 HTML 预览，无打开 / 编辑操作区 | 扩展：新增 HTML 缩略预览、操作区、与查看器共用渲染函数 | 源码阅读，确定 |
| `src/components/explorer/useExplorerOperations.ts`（`open`） | Explorer 双击文件调用 `sftpOpenPath`（系统默认应用） | 改为 `openFile(..., {context:"explorer"})`，按 DEC-04 决定默认 | 源码，确定 |
| `sftpOpenPath` / `sftp_open_path` 其他调用方 | `LocalFileBrowserPanel`、`FileBrowser`、`FileBrowserView`、工作区 `treeActions` / `useWorkspaceFileActions`、git `fileActions`、数据库 `useGridExport` | 逐一迁移或明确保留（例如“导出后打开”继续用系统应用）；终端链接 `WebLinksAddon` 仅处理 URL，没有文件路径链接 | 源码 grep，确定；逐点处理清单见 TASK-07 |
| `src/types/index.ts` `TabKind` | 无查看器类型；`file-browser` 为 Explorer | 新增 `"file-viewer"`；会话恢复需兼容 | 源码，确定 |
| `workspacePlatformStore.ts` `WorkspaceTabKind` | 含 file/note/git/explorer/code/terminal 等，无查看器 | 新增 `"viewer"`，渲染同一组共享组件 | 源码，确定 |
| `src/components/editor/workspace/*` | CodeMirror 6 宿主（`CodeMirrorHost.tsx`）、`MarkdownPreview.tsx`（marked + DOMPurify + mermaid；`MarkdownViewMode` edit / preview / split） | 源码类文件继续由 Code Workspace 编辑；共享 Markdown 渲染管线抽出复用，不复制 | 源码，确定 |
| `workspace_read_loose_file*` / `workspace_write_loose_file*`（`src-tauri/src/workspace/`） | 带编码与 `expected_hash`、原子写；路径限定在工作区语义内 | 不能直接给任意路径使用；复用其编码识别与原子写实现，新增路径命令 | 源码，确定；复用边界在 TASK-01 复核 |
| `Cargo.toml` / `tauri.conf.json` | Tauri 2.12，`protocol-asset` 启用但 asset scope 仅 `$APPDATA/ai-generations`；CSP `frame-src 'self' data: blob:`；未注册自定义 URI 协议 | 图片继续走字节命令 + blob；HTML 预览需要受限只读协议或 blob 重写（DEC-03） | 源码，确定 |
| 依赖 | 有 `@codemirror/lang-markdown`/`lang-html`、`marked`、`dompurify`、`mermaid`；无 turndown、docx、pdf 库 | HTML→Markdown 粘贴转换自写小转换器；docx / pdf 库按需懒加载（新增依赖需在 TASK 内评估体积） | 源码 `package.json`，确定 |
| 终端 / 邮件 / AI 对话 / Git | 邮件附件、AI 消息中的路径、Git 变更列表均无统一“打开文件”能力 | 入口矩阵见 §4（原型场景 ⑥） | 源码，确定 |
| `AGENTS.md` | 单文件 ≤ 800 行；macOS 快捷键映射；外网访问代理模式与下载规则；新功能须纳入 crash-regression | 查看器按文件拆分；HTML“可浏览网页”若采用必须遵守代理 / 下载规则（DEC-03） | 仓库规则 |

调用链（现状）：各入口 →（多数）`sftp_open_path` → 系统默认应用；仅 Explorer 预览窗格与 Code Workspace 可在 Taomni 内显示内容，且二者代码互不共享。

## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | Explorer 预览窗格开启 | 选中 png/jpg/gif/webp/bmp/ico/avif | 窗格显示图片缩略图 + 尺寸 / 大小 / 类型；> 20 MB 仅显示元信息 | 三端；AVIF 依赖 WebView 支持，不支持时显示元信息并提供系统应用 |
| AC-02 | 同上 | 选中 `.svg` | 窗格显示净化后的渲染图；脚本、事件属性、外部引用被移除并有“已净化”标识；源码文件不被改动 | 三端 |
| AC-03 | 同上 | 选中 txt/log/json/yaml/csv/md/html | txt 类带行号（≤256 KB，超出提示截断）；md 渲染；csv 表格；html 显示沙盒缩略预览（脚本与网络关闭）；不支持类型显示图标与元信息 | 三端 |
| AC-04 | 选中任一受支持文件 | 点击窗格“用 Taomni 打开”/“编辑”/“打开方式▾” | 在新的 `file-viewer` 标签打开；“打开方式”列出 Taomni、Code Workspace、系统应用、记住选择 | 三端 |
| AC-05 | DEC-04 默认值生效 | Explorer 中双击受支持文件 | 默认在 Taomni 内打开（若 DEC-04 选系统应用则维持现状）；Ctrl/Cmd+双击或右键可选另一方式；不支持类型始终交给系统应用 | 三端 |
| AC-06 | 打开图片 / SVG | 滚轮缩放、拖动平移、适应窗口 / 100%、旋转、翻转、背景（棋盘 / 浅 / 深）、同目录上一张 / 下一张、缩略图条 | 操作即时生效；缩放与平移不改变源文件；复制图片 / 路径可用 | 三端；大图（>20 MB）按查看器上限提示，上限数值在 TASK-02 依据实测确定，不预设 |
| AC-07 | 打开 SVG | 切换 渲染 / 代码 / 分栏；编辑代码并保存 | 分栏下编辑后渲染实时更新；保存写回原文件；渲染始终使用净化结果 | 三端 |
| AC-08 | 打开 txt 类 | 编辑、撤销 / 重做、查找、换行开关、字号、切换编码与换行符 | 脏标记显示在标签与状态栏；Ctrl/Cmd+S 原子保存；保存保持原编码与换行符，除非用户显式改变 | 三端；macOS 快捷键按 AGENTS.md 映射 |
| AC-09 | 文件被其他程序修改（本应用已打开） | 回到窗口 / 保存时 | 无未保存修改：自动或一键重新加载；有未保存修改：横幅提供“重新加载 / 比较差异 / 保留我的版本”；保存带 `expected_hash`，冲突不静默覆盖 | 三端 |
| AC-10 | 打开 > 5 MB 的文本 | 打开 | 以只读分块方式查看并提示；不卡死 UI；“仍以编辑方式打开”需二次确认且有上限 | 三端；阈值在 TASK-03 以实测确定，5 MB 为原型示意值 |
| AC-11 | 打开 `.md` | 默认模式 | 采用实时渲染（DEC-02）：当前行显示 Markdown 源标记，其余行渲染；大纲面板、格式工具栏、标题 / 列表 / 引用 / 任务 / 代码块 / 表格 / mermaid 渲染；可切换 源码 / 分栏 / 专注模式 | 三端 |
| AC-12 | Markdown 已打开且文件有保存路径 | 粘贴剪贴板图片（截图 / 复制图片） | 图片保存到配置的目录（默认文档同级 `assets/`，文件名 `image-{日期}-{时间}.png`），插入相对路径链接；失败时给出原因且不插入悬空链接；未保存的新文档先提示选择位置 | 三端；剪贴板图片读取在三端行为不同，需真机 |
| AC-13 | Markdown 已打开 | 粘贴 HTML 表格 / TSV 文本（来自网页、Excel） | 转换为 Markdown 表格；可 Undo 一次还原为纯文本粘贴；复杂表格（合并单元格）降级并提示 | 三端 |
| AC-14 | Markdown 实时模式 | 表格内 Tab / Enter、添加删除行列、对齐、拖拽图片到文档、点图片出现缩放 / 替换 / 在 Explorer 显示 / 复制路径 | 操作结果写入标准 Markdown，源码可读、不引入私有语法 | 三端 |
| AC-15 | Markdown 已打开 | 导出菜单 | 提供：HTML（自包含，图片内嵌）、PDF（页面设置：纸张 / 边距 / 页眉页脚）、PNG 长图、Word（.docx）、Markdown+图片文件夹、复制为富文本、复制 HTML 源码、打印；导出失败有明确错误；导出不修改源文件 | 三端；PDF / 打印依赖系统打印通道，需真机 |
| AC-16 | 打开 `.html` / `.htm` | 默认 | 类浏览器视图：地址栏（只读 file 路径 + “沙盒”标识）、刷新、前进后退、缩放、设备尺寸（桌面 / 平板 / 手机）、预览 / 源码分栏、控制台；同目录及子目录的相对资源（css/js/图片）可加载 | 三端；实现通道见 DEC-03 |
| AC-17 | HTML 预览 | 页面发起外部网络请求或脚本执行 | 脚本在隔离沙盒内运行；外部网络默认阻止并以横幅提示，可“本次允许网络”；点击外链用系统浏览器打开，不在预览内导航 | 三端；若 DEC-03 选“可浏览网页”则遵守 AGENTS.md 代理 3 模式与下载规则 |
| AC-18 | 终端 / Workspace 项目树 / Git 变更 / 邮件附件 / AI 对话 / SFTP | 从各入口打开受支持文件 | 全部经 `openFile`，同一文件同一作用域去重（激活已有标签）；结果与 Explorer 一致；工作区内打开为工作区标签，主界面内为主界面标签 | 三端；逐入口迁移清单见 TASK-07 |
| AC-19 | 远程来源（SFTP、邮件附件） | 打开 | 下载到受控临时目录后只读打开；标签显示“只读副本”；另存为本地后才可编辑；临时文件在关闭标签 / 应用退出时清理 | 三端 |
| AC-20 | 设置 → 文件打开 | 修改按扩展名的默认打开方式、Markdown 粘贴图片目录与命名、HTML 网络策略、编辑器偏好 | 即时生效并持久化；可恢复默认；对全部入口一致 | 三端 |
| AC-21 | 已有未保存修改的查看器标签 | 关闭标签 / 退出应用 / 崩溃重启 | 关闭与退出时提示保存；重启后草稿恢复（沿用现有会话恢复机制，范围在 TASK-03 确认）；恢复内容与磁盘冲突走 AC-09 | 三端 |
| AC-22 | 任意查看器 | 打开不存在 / 无权限 / 损坏 / 超大文件 | 显示错误态（原因 + 重试 / 用系统应用打开 / 在 Explorer 显示），不显示空白页，不崩溃 | 三端 |

## 4. 方案与关键决策

**全局入口与路由。** 新增 `src/lib/openFile/`：`openFile(target, opts)`，其中 `target = { path, source: "local" | "remote-temp" | "mail-attachment" ... }`，`opts = { context, mode?, line? }`。`classifyFile(path)` 根据扩展名与（必要时）头部字节返回 `FileKind`：`image | svg | text | markdown | html | pdf | source | binary`。路由表：

| FileKind | 默认处理 | 备选 |
|---|---|---|
| image / svg | `file-viewer` → ImageViewer | 系统应用 |
| text（txt/log/ini/json/yaml/csv…） | `file-viewer` → TextEditor | Code Workspace、系统应用 |
| markdown | `file-viewer` → MarkdownEditor | 源码模式、Code Workspace |
| html | `file-viewer` → HtmlPreview | TextEditor 源码、系统浏览器 |
| source（ts/rs/py/java… 已由 Code Workspace 管理） | Code Workspace loose-file 编辑器（现状） | 系统应用 |
| pdf | P1：`file-viewer` → PdfViewer；本轮系统应用 | — |
| binary / office / zip / 音视频 | 系统应用 | — |

**共享组件与状态。** 组件放 `src/components/viewer/`：`ImageViewer`、`TextEditor`、`MarkdownEditor`、`HtmlPreview`、`ViewerShell`（工具栏、状态栏、错误态、外部修改横幅）。`documentStore`（`src/stores/documentStore.ts`，拟新增）以规范化路径为键保存 `{ content, savedHash, dirty, encoding, eol, mtime, readOnly }`；主界面标签与工作区标签只是同一文档的两种宿主，避免同一文件在两处各持一份草稿。

**标签类型。** 主界面新增 `TabKind "file-viewer"`（`FileViewerTabInfo{ path, kind, mode, readOnlyReason? }`）；工作区新增 `WorkspaceTabKind "viewer"`。去重键 = 作用域 + 规范化路径（规范化沿用 Explorer 去重所用工具，Windows 大小写不敏感）。会话恢复时路径不存在显示错误态而非丢弃标签。

**文本编辑器。** CodeMirror 6 轻量封装（不带 LSP / 项目索引）：行号、查找替换、换行、字号、撤销栈、编码与换行符切换；语法高亮按扩展名懒加载语言包。读写走新 Rust 命令，不经过前端 `fs`。

**Markdown（DEC-02）。** 推荐在 CodeMirror 6 上用装饰（decorations）实现“实时渲染”：文档永远是 Markdown 源码文本，渲染是视图层；光标所在块展示源标记，其余块渲染。优点是无损往返、复用现有依赖与 `MarkdownPreview` 渲染管线（mermaid、代码块高亮）；缺点是表格内编辑等“所见即所得”体验需要自写 widget，工作量大于分栏方案。备选 ProseMirror / Milkdown：真 WYSIWYG，体验最接近 Typora，但新增大依赖、Markdown 往返序列化可能改写用户原文格式，需要额外的“保真”策略。粘贴图片与表格、导出见 AC-12~15；Markdown 路径逻辑（`assets/` 命名模板、相对路径、Windows 反斜杠转换为 `/`、URL 编码空格与中文）由统一的 `markdownAssets.ts` 处理。

**导出实现。** HTML：渲染管线输出 + 内嵌 CSS + 图片转 data URI；PDF / 打印：隐藏 iframe 套用打印样式 + 页面设置对话框，调用系统打印通道（Windows / macOS / Linux 的 WebView 打印行为差异在真机验证）；PNG：离屏 DOM 栅格化（库选型 TASK-05 评估）；DOCX：按需懒加载库，仅在首次导出时加载；Markdown+图片文件夹：把引用的本地图片复制到 `<name>/assets/`；复制富文本：写 `text/html` + `text/plain` 到剪贴板。

**HTML 预览（DEC-03）。** 推荐方案“本地沙盒”：iframe `sandbox` 属性不含 `allow-same-origin`，页面内容通过受限只读自定义 URI 协议（仅允许读取该 HTML 所在目录及子目录，禁止 `..` 越界与符号链接逃逸，只读 GET）提供，使相对资源可加载；CSP 默认 `connect-src`/外链资源阻止，可“本次允许网络”；外链点击交给系统浏览器；控制台通过 `postMessage` 桥接。备选“可浏览网页”：把预览扩成内嵌浏览器（任意 URL、前进后退、下载）。该方案需遵守 `AGENTS.md` 的外部网络代理三种模式与下载规则，并需新增原生 WebView 或放宽 CSP，范围明显更大，本轮不推荐。

**SVG 安全。** 渲染一律经 DOMPurify（禁用脚本、`foreignObject` 内事件、外部 `href`/`xlink:href`），以 `<img>` 或净化后的内联渲染展示；“代码”视图展示原始源码；保存只写用户编辑的源码，不写净化结果。

**Explorer 预览窗格。** 复用同一 `previewModel`，新增 SVG 渲染与 HTML 沙盒缩略预览（脚本关闭）；顶部操作区：“用 Taomni 打开”、“编辑”（text / md / svg）、“打开方式▾”、“系统应用”。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 全局能力架构 | 各视图各自实现 vs 统一 `openFile` 服务 + 共享查看器 + `documentStore` | 统一服务与共享组件，满足“全局共享”原文要求 | 用户已定 | 用户需求原文“全局共享，各处通用” | AC-18；TASK-01 |
| DEC-02 Markdown 编辑技术 | **A** CM6 实时渲染装饰（无损往返、复用现有依赖，表格 / 图片 widget 需自写）；**B** ProseMirror/Milkdown 真 WYSIWYG（最像 Typora，新增大依赖，往返可能改写原文）；**C** 源码 + 预览分栏（成本最低，体验不及 Typora） | 采用 **A**，保留 **C** 作为同一组件内的“分栏”模式 | 用户已定 | 用户在原型评审后选择「实时渲染（推荐）」 | AC-11~15；TASK-05；V-05 |
| DEC-03 HTML 预览范围 | **A** 本地沙盒预览（只读本地资源，网络默认阻止，外链走系统浏览器）；**B** 可浏览网页（任意 URL，需代理 / 下载规则，范围大） | 采用 **A**；B 另行单独设计 | 用户已定 | 用户在原型评审后选择「本地沙盒（推荐）」 | AC-16、17；TASK-06；V-06 |
| DEC-04 Explorer 双击默认 | **A** 受支持类型默认 Taomni 打开，另有“系统应用”与 Ctrl/Cmd+双击、按扩展名可改；**B** 保持系统应用，Taomni 仅经预览窗格 / 右键进入 | 采用 **A**；全局设置可切回系统应用 | 用户已定 | 用户在原型评审后选择「Taomni 打开（推荐）」 | AC-05、20；TASK-04、07 |
| DEC-05 源码类文件归属 | 源码继续走 Code Workspace loose-file 编辑器，不被轻量 TextEditor 取代 | 采用，避免两套代码编辑器并行 | agent 自决 | 现有 Code Workspace 已有 LSP / 项目上下文 | AC-04；TASK-01 |
| DEC-06 图片通道 | 扩大 asset 协议 scope vs 受限字节命令 + blob URL | 采用后者，与 Explorer 既有做法一致 | agent 自决 | asset scope 仅 `$APPDATA/ai-generations`，放大有安全面 | AC-01、06；TASK-02 |
| DEC-07 粘贴图片默认落点 | 文档同级 `assets/`（相对链接，可移植）vs 单独附件库 vs 内嵌 base64（文件膨胀） | 默认同级 `assets/` + `image-{日期}-{时间}.png`，目录与模板可在设置中修改 | agent 自决 | 与 Typora 默认行为一致，便于文档整体搬迁 | AC-12、20；TASK-05 |
| DEC-08 范围分级 | P0：图片+SVG、txt 类、Markdown、HTML；P1：PDF（pdf.js）；其余转系统应用 | 采用 | agent 自决 | 用户列举的是图片 / SVG / txt / md / html；PDF 为常见补充，需单独评估体积 | 全部 |
| DEC-09 远程文件 | 只读临时副本 vs 原位编辑回写 | 只读临时副本，回写另行设计 | agent 自决 | 回写涉及冲突与权限，超出本需求 | AC-19；TASK-07 |
| DEC-10 导出格式集 | HTML、PDF、PNG 长图、DOCX、MD+图片夹、复制富文本 / HTML、打印 | 采用；DOCX 懒加载库，选型在 TASK-05 评估后回填 | agent 自决 | 用户要求“多种格式导出”，未限定集合 | AC-15；TASK-05 |

### 用户流程与交互

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| Explorer | 选中文件 | 预览窗格开启 | 窗格按类型渲染（图片 / SVG / 文本 / MD / HTML / CSV），顶部出现“用 Taomni 打开”等操作 | 读取失败 → 窗格错误态 + 系统应用 |
| Explorer | 双击 / Enter | DEC-04 | 受支持类型 → 打开或激活 `file-viewer` 标签；不支持 → 系统应用 | 无关联应用 → 提示 |
| 任意入口 | 点击文件路径 / 附件 / 变更项 | 受支持类型 | 调用 `openFile`，与 Explorer 一致 | 同上 |
| 文本 / MD | 编辑 | 非只读 | 脏点出现在标签与状态栏；Ctrl/Cmd+S 保存 | 保存冲突 → 横幅（AC-09） |
| Markdown | 粘贴图片 / 表格 | 有保存路径 | 图片写入 `assets/` 并插入链接；表格转 Markdown 表格 | 写入失败 → 提示原因，不插入 |
| Markdown | 导出 | — | 选择格式 → 进度 / 对话框 → 完成提示与“在 Explorer 显示” | 失败 → 错误详情，源文件不变 |
| HTML | 打开 | — | 沙盒预览；网络阻止横幅 | 资源缺失 → 控制台警告；外链 → 系统浏览器 |
| 查看器 | 外部文件被改 | 窗口重新聚焦 | 自动重载或横幅 | 比较 → 差异视图（沿用现有 diff 组件，TASK-03 确认） |

键盘：Ctrl/Cmd+S 保存、Ctrl/Cmd+F 查找、Ctrl/Cmd+B/I/K（Markdown 格式）、+/-/0 缩放（图片 / HTML）、←/→ 上下一张。macOS 按 `AGENTS.md` 映射，不新增裸 Ctrl 绑定。

#### 原型与示意图

- 当前有效图稿：[`file-open-preview/prototype-v1.html`](file-open-preview/prototype-v1.html)（v1，自包含，浅 / 深主题，视口约 1440×860）。关键状态截图：
  - [① Explorer 预览窗格](file-open-preview/proto-v1-explorer-light.jpg)
  - [② SVG 分栏（深色）](file-open-preview/proto-v1-svg-dark.jpg)
  - [③ 文本编辑（查找 + 外部修改横幅）](file-open-preview/proto-v1-text-editor.jpg)
  - [④ Markdown 实时渲染（粘贴图片 / 表格工具条）](file-open-preview/proto-v1-markdown-live.jpg)
  - [④ Markdown 导出菜单（深色）](file-open-preview/proto-v1-markdown-export-dark.jpg)
  - [⑤ HTML 沙盒预览 + 控制台](file-open-preview/proto-v1-html-preview.jpg)
  - [⑥ 全局入口矩阵](file-open-preview/proto-v1-entries.jpg)
- 原型场景：⑦ 打开方式设置未单独截图，可在原型中切换查看。URL 参数：`sc=explorer|image|text|md|html|entries|settings`、`theme=light|dark`、`md=`、`html=`、`menu=export`、`pimg=1`、`ptbl=1`、`imgsel=1`、`svg=split`、`find=1`、`ext=1`、`dirty=1`、`dev=1`、`pop=t`。顶栏可切换 DEC-02 / 03 / 04 的两种方案。
- 本地查看：`cd docs-feature/file-open-preview && python3 -m http.server`。
- 修订结果：v1 为首版。绘图工具（draw.io）不可用，以 HTML 原型与截图代替，无 `.drawio` 源。原型数据全部为模拟；已在 Linux 的无头浏览器渲染并修复了样式冲突（大纲面板类名与按钮类名同名导致按钮被拉伸、入口卡片裁切菜单），未做交互冒烟或真机检查，不代表产品行为。

### 数据流、状态与生命周期

- **打开**：入口 → `openFile` → `classifyFile` → 路由；去重键命中则激活已有标签。
- **读取**：前端经 `viewer_stat` 取大小 / mtime / 类型，再 `viewer_read_text`（编码识别 + 上限）或 `viewer_read_bytes`（图片、字节上限）；结果进入 `documentStore`。
- **保存**：`viewer_write_text`（临时文件 + 原子替换，`expected_hash` 不符返回冲突错误；保留原编码与换行符）。
- **脏状态**：`documentStore` 持有；标签、状态栏订阅；关闭 / 退出提示；草稿按现有会话恢复机制持久化（范围 TASK-03）。
- **外部修改**：窗口聚焦与保存时比对 `mtime + hash`（不引入文件监听，沿用 Explorer“聚焦刷新”策略）。
- **blob / 临时资源**：blob URL 在卸载 / 切换时释放；远程临时副本放受控临时目录，关闭标签与应用退出时清理。
- **并发与过期**：读取带请求序号；同文件多宿主共享同一 `documentStore` 条目，防止双份草稿；预览窗格快速切换只渲染最后一次。

### 接口与共享契约

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `openFile(target, opts)`（拟新增） | 各入口 → `src/lib/openFile` | `{path,source}` + `{context,mode?,line?}` | 打开 / 激活标签或调用系统应用；抛出可展示错误 | 旧 `sftpOpenPath` 保留，逐点迁移 |
| `classifyFile(path)`（拟新增） | `openFile`、预览窗格 | 路径 | `FileKind` | 扩展名为主，可选读头部字节 |
| `viewer_stat` / `viewer_read_text` / `viewer_read_bytes` / `viewer_write_text`（拟新增） | `src/lib/viewer.ts` → Rust | `{path,maxBytes?,encoding?,expectedHash?}` | 内容 + `{hash,encoding,eol,mtime,size}`；错误码 `not_found/permission/too_large/conflict/binary` | 新命令，不改现有 `sftp_*` / `workspace_*` |
| `viewer_save_pasted_image`（拟新增） | MarkdownEditor → Rust | `{docPath,dir,fileName,bytes}` | 相对路径；冲突自动改名 | 路径限定在用户配置目录，防 `..` |
| `viewer_html_protocol`（拟新增，DEC-03 A） | HtmlPreview iframe → Rust 协议处理 | `taomni-preview://<token>/<相对路径>` | 只读字节 + MIME；越界 / 符号链接逃逸返回 403 | token 与根目录绑定，标签关闭失效；需同步 CSP |
| `TabKind "file-viewer"` / `WorkspaceTabKind "viewer"`（拟新增） | 标签路由 | `FileViewerTabInfo` | — | 旧会话快照无此值；未知 kind 回退逻辑不变 |
| `documentStore`（拟新增） | 查看器与宿主 | 按规范化路径键控 | 订阅脏 / 冲突状态 | 与 Code Workspace loose-file 状态的整合边界在 TASK-01 复核 |
| `fileOpenPreferences`（拟新增） | 设置页 → 全入口 | 扩展名→处理方式、MD 粘贴目录 / 模板、HTML 网络策略 | 持久化偏好 | 新键，不迁移旧数据 |

### 三端兼容与相关存储、故障边界

- **Windows**：路径大小写不敏感；反斜杠写入 Markdown 链接时转 `/`；长路径与 UNC；剪贴板位图读取（DIB / PNG）；WebView2 的 PDF / 打印行为；HTML 预览自定义协议在 WebView2 中形如 `http://taomni-preview.<token>/`，需真机确认。
- **macOS**：快捷键与菜单按 `AGENTS.md`；WKWebView 对 AVIF、自定义协议、打印的支持与差异；沙盒 / 全盘访问授权不在本期；Cmd+双击为替代打开方式。
- **Linux**：WebKitGTK 对 blob / 自定义协议 / 打印的行为；剪贴板图片格式（`image/png` 与 `text/uri-list` 区分）；无桌面环境时系统应用失败提示。
- **存储**：偏好新增键；`documentStore` 草稿按现有会话恢复；回退时可只恢复到系统应用打开，偏好键保留无害。
- **browser stub**：浏览器 / QA 模式需提供 `viewer_*` 命令内存 stub，仅证明前端逻辑；HTML 协议与剪贴板图片需原生验证。
- **安全**：路径只读读取遵守现有本地路径策略；HTML 沙盒不授 `allow-same-origin`；Markdown 渲染继续 DOMPurify；所有“外部链接”走既有外链打开通道。

## 5. 改动清单

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/lib/openFile/*`（拟新增） | 入口、分类、路由、去重 | AC-04、05、18 | TASK-01 |
| `src/stores/documentStore.ts`（拟新增） | 文档状态、脏、冲突 | AC-08、09、21 | TASK-01、03 |
| `src-tauri/src/viewer/*`（拟新增）、`commands/mod.rs` | 路径读写命令，复用 `workspace/encoding.rs`、`atomic_write.rs` 的算法 | AC-08~10、22 | TASK-01 |
| `src/types/index.ts`、`workspacePlatformStore.ts`、`TabContentRouter.tsx` | `file-viewer` / `viewer` 标签类型与路由；会话恢复 | AC-04、21 | TASK-01 |
| `src/components/viewer/ImageViewer*`（拟新增） | 缩放 / 旋转 / 背景 / 缩略图条 / SVG 三模式 | AC-01、02、06、07 | TASK-02 |
| `src/components/viewer/TextEditor*`（拟新增） | CM6 轻量编辑器、编码 / 换行、外部修改横幅、大文件只读 | AC-08~10、21 | TASK-03 |
| `src/components/explorer/preview/*`、`useExplorerOperations.ts` | SVG 渲染、HTML 缩略、操作区、双击行为 | AC-01~05 | TASK-04 |
| `src/components/viewer/markdown/*`（拟新增，≤800 行 / 文件，按 widget 拆分） | 实时渲染、粘贴图片 / 表格、导出、大纲、专注模式 | AC-11~15 | TASK-05 |
| `src/components/viewer/HtmlPreview*`、Rust 预览协议、CSP | 沙盒 iframe、设备尺寸、控制台、网络策略 | AC-16、17 | TASK-06 |
| 各调用点（见 §2） | 迁移到 `openFile`；远程 / 附件临时副本 | AC-18、19 | TASK-07 |
| 设置页、i18n、菜单命令 | 「文件打开」设置；中英文文案 | AC-05、20 | TASK-07 |
| browser stub、`qa-ui-auto-tests/cases/`、`feature-list.md`、crash-regression | 新用例与 stub | 全部 | TASK-08 |

## 6. 实现任务与交接

### TASK-01 打开服务、文档状态与路径读写命令
- 文件范围：`src/lib/openFile`、`documentStore`、`src-tauri/src/viewer`、标签类型与路由。
- 依赖：DEC-01（已定）；与 Code Workspace loose-file 状态的整合边界先复核。
- 对应验收：AC-04、05、18、22。验证：V-01、V-02。
- 并行：命令与前端可并行，契约以 §4 接口表为准。

### TASK-02 图片与 SVG 查看器
- 范围：`ImageViewer`、SVG 净化与三模式、缩略图条；大图上限实测确定。
- 依赖：TASK-01 的 `viewer_read_bytes`。验收：AC-01、02、06、07。验证：V-03。

### TASK-03 文本编辑器
- 范围：`TextEditor`、编码 / 换行、外部修改、大文件只读、草稿恢复。
- 依赖：TASK-01。验收：AC-08~10、21。验证：V-04。

### TASK-04 Explorer 预览窗格与双击行为
- 范围：预览新增类型、操作区、“打开方式”、双击默认。
- 依赖：TASK-01、02；DEC-04 已定（默认 Taomni 打开）。验收：AC-01~05。验证：V-02、V-03。

### TASK-05 Markdown 编辑器与导出
- 范围：实时渲染、粘贴图片 / 表格、导出全集、设置项。
- 依赖：TASK-03；DEC-02 已定（实时渲染）；导出库选型回填。验收：AC-11~15。验证：V-05。

### TASK-06 HTML 预览
- 范围：沙盒 iframe、预览协议、设备尺寸、控制台、网络策略。
- 依赖：TASK-01；DEC-03 已定（本地沙盒）。验收：AC-16、17。验证：V-06。

### TASK-07 全局入口迁移、远程临时副本与设置
- 范围：逐个替换 `sftpOpenPath` 调用点或写明保留理由；终端文件路径链接；邮件附件、AI 消息、Git 变更、SFTP；设置页。
- 依赖：TASK-01~04。验收：AC-18~20。验证：V-07。

### TASK-08 测试资产与回归
- 范围：stub、QA 用例、crash-regression、三端原生验证。
- 依赖：全部。验收：全部。验证：V-01~V-09。

## 7. 验证计划

以下全部为**待执行**，设计阶段未运行任何测试。

| ID | 层级 | 覆盖 AC | 内容 | 状态 |
|---|---|---|---|---|
| V-01 | 单元（Vitest） | AC-04、05、18、22 | `classifyFile`、路由表、去重、错误映射 | 待执行 |
| V-02 | 单元 + Rust 测试 | AC-08、09、22 | 编码识别、原子写、`expected_hash` 冲突、大小上限、路径越界 | 待执行 |
| V-03 | 浏览器 UI | AC-01、02、06、07 | 图片 / SVG 查看、净化（含恶意 SVG 样本）、三模式 | 待执行 |
| V-04 | 浏览器 UI | AC-08~10、21 | 编辑 / 保存 / 脏 / 外部修改 / 大文件只读 / 草稿恢复 | 待执行 |
| V-05 | 单元 + 浏览器 UI | AC-11~15 | Markdown 往返无损（样本集）、粘贴表格转换、图片路径（含中文 / 空格 / 反斜杠）、导出产物检查 | 待执行 |
| V-06 | 浏览器 UI + 安全用例 | AC-16、17 | 沙盒隔离、越界读取拒绝、网络阻止、外链行为 | 待执行 |
| V-07 | 集成 | AC-18~20 | 各入口一致、去重、远程只读副本与清理、设置生效 | 待执行 |
| V-08 | 回归 | 全部 | `pnpm check:refactor`、类型检查、crash-regression | 待执行 |
| V-09 | 三端原生 / 真机 | AC-12、15~17、21 | 剪贴板图片、打印 / PDF、自定义协议、WebView 差异、快捷键 | 待执行 |

### 三端真机验证计划

| 平台 | 必须真机确认 | 状态 |
|---|---|---|
| Windows（WebView2） | 剪贴板位图粘贴、打印 / PDF、预览协议 URL 形式、长路径 / UNC | 待执行 |
| macOS（WKWebView） | 同上 + Cmd 快捷键、AVIF 支持、打印 | 待执行 |
| Linux（WebKitGTK） | 同上 + 剪贴板图片格式、无桌面环境的系统应用失败提示 | 待执行 |

## 8. 追踪矩阵

| AC | DEC | TASK | V |
|---|---|---|---|
| AC-01~03 | DEC-06、08 | TASK-02、04 | V-03 |
| AC-04、05 | DEC-01、04、05 | TASK-01、04、07 | V-01、V-07 |
| AC-06、07 | DEC-06 | TASK-02 | V-03 |
| AC-08~10、21 | — | TASK-03 | V-02、V-04 |
| AC-11~15 | DEC-02、07、10 | TASK-05 | V-05、V-09 |
| AC-16、17 | DEC-03 | TASK-06 | V-06、V-09 |
| AC-18、19 | DEC-01、09 | TASK-07 | V-07 |
| AC-20 | DEC-04 | TASK-07 | V-07 |
| AC-22 | — | TASK-01 | V-01、V-02 |

## 9. 风险与未决事项

- Markdown 实时渲染（方案 A）工作量大，表格 / 图片 widget 与 IME（中文输入）、光标映射的稳定性是主要风险；建议 TASK-05 先做 spike 并回填。
- HTML 预览自定义协议在三端 WebView 的行为不同，且属于新的 IPC / 安全面，需威胁评审后再合入。
- DOCX / PNG / PDF 导出依赖库体积与许可证待评估，必须懒加载，不得拖慢启动。
- 与 Code Workspace loose-file 编辑状态的整合边界（同一文件在两处同时打开）需要在 TASK-01 先定。
- 本设计基于 `1344dc3c5` 的静态阅读；实施前需重新核对 §2 各符号与调用点，因 Explorer 等模块仍在演进。
- 原型与截图仅为评审稿，不是实现、测试或真机证据。
