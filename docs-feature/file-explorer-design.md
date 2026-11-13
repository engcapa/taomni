# 文件资源管理器（File Explorer）详细设计

## 1. 设计摘要与范围

- 类型：现有能力扩展（在现有「文件」会话 / `file-browser` 标签基础上升级为 Windows 11 风格的本地文件资源管理器，并新增工作区与终端入口）
- 文档位置：`docs-feature/file-explorer-design.md`；原型与截图位于 `docs-feature/file-explorer/`
- 设计状态：**草案**。三项 UI/行为取舍（DEC-01/02/03）待用户决策，未决前 TASK-05（工作区入口）、TASK-06（预览窗格默认值）、TASK-03（删除语义）只能做到与选项无关的部分；其余任务可开始。
- 来源：用户需求——参考 Windows 11 资源管理器（左树、右文件列表、可配置预览窗格、常用文件操作）但更简洁易用；以现有本地文件浏览为基础；工作区的「项目树」要能切换为文件资源管理器（用户建议：左侧工具栏图标，在新标签页打开）；本地会话终端右键可打开 Explorer，作为会话类型标签展示，默认同一目录只保留一个标签并提供「在新标签打开」。
- 调研基线：提交 `b2d1a753c`，工作树干净，调研时无未提交变更。未运行真实桌面应用；主应用预览（5000 端口）因既有缺失依赖 `@tanstack/react-virtual`（`ProjectTreeViewport.tsx` 引用）无法渲染，与本设计无关，实现前需另行修复，否则无法做浏览器验证。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行。
- 本轮真机执行端：当前环境为 Linux（Replit，Xvfb/Fluxbox 隔离桌面）。三端均保留计划，本轮完成 Linux 验证即可，Windows / macOS 未执行不单独阻塞交付。
- 推荐方案：
  1. 复用 `FilePanel` 与 `sftpStore` 的本地窗格，在其外新增 `ExplorerShell`：左侧导航树（快速访问 / 工作区 / 此电脑）、地址栏面包屑（可编辑）、命令栏、右侧预览窗格、状态栏。
  2. 本地文件操作补齐：复制 / 剪切 / 粘贴 / 移动 / 拖放 / 回收站删除 / 属性，新增 Rust 命令（现有 sftp 命令没有本地复制与移动）。
  3. 三个入口统一走一个 `openExplorer(path, {forceNew})`：工具面板与菜单、工作区工具栏图标、终端右键菜单。同目录去重。
- 范围与不做：不做远程（SFTP/SMB）Explorer；不做标签页内分栏（双窗格）、文件搜索索引、云盘集成、压缩包浏览、批量重命名模板、文件内容全文搜索；不改 SFTP 双栏浏览器；不改变 Code Workspace 的项目树本身行为。

高保真原型是评审用的静态交互稿，**不是**产品 UI 实现、UI 测试或真机证据。

## 2. 当前实现与功能缺口

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/filebrowser/LocalFileBrowserPanel.tsx` | 包装 `FilePanel`；用 `useSftpStore.attachLocalOnly(tabId, initialPath)`；支持打开、系统中显示、重命名、**永久删除**（`sftpRemove`，仅确认框）、新建文件夹/文件、chmod；无复制/移动/粘贴、无导航树、无预览 | 扩展为 Explorer 的文件列表区；删除改为可撤销 | 源码阅读，确定 |
| `src/components/filebrowser/filePanel/*`、`preview.ts` | 工具栏、可排序列、面包屑、隐藏文件开关、过滤框；`preview.ts` 只有 `isPreviewable` | 保留列表/排序/过滤；新增预览渲染 | 源码，确定 |
| `src/lib/sftp.ts` 与 `src-tauri/src/filebrowser/`、`commands/filebrowser.rs` | 本地命令：`sftp_list_local_detailed`、`sftp_local_home`、`sftp_local_drives`、`sftp_mkdir`、`sftp_remove`、`sftp_rename`、`sftp_stat`、`sftp_chmod`、`sftp_open_path`、`sftp_read_file_text`；**无**本地 copy/move、回收站、二进制预览 | 新增本地 copy/move/trash/properties/read-bytes 命令 | 源码，确定 |
| `src-tauri/src/workspace/resource_operations.rs` | 工作区资源复制/移动助手，路径限定在工作区根内 | 不能直接用于任意本地路径；仅参考冲突重命名与递归复制的算法 | 源码，确定 |
| `src-tauri/src/config/clipboard.rs`、`src/lib/clipboard.ts` | `clipboard_read_files` / `clipboard_write_files` 读写系统文件剪贴板 | 复制/剪切时同时写系统剪贴板，粘贴时先读系统剪贴板，可与系统文件管理器互通 | 源码，确定 |
| `src-tauri/Cargo.toml` | 无 `trash` crate；asset 协议 scope 仅 `$APPDATA/ai-generations` | 回收站需新增依赖；图片预览不能依赖 asset 协议，改用受限大小的字节命令 + blob URL | 源码，确定 |
| `src/layouts/main/useProtocolTabs.ts:152` `openFileBrowserTab` | 每次调用生成 `file-<sessionId|ad-hoc>-<Date.now()>`，**不去重** | 新增去重入口；保持旧入口对「文件」会话的行为 | 源码，确定 |
| `src/layouts/main/tabs/TabContentRouter.tsx:411-430` | 渲染 `file-browser` 标签 → `LocalFileBrowserPanel` | 改为渲染 `ExplorerShell`（内含 LocalFileBrowserPanel） | 源码，确定 |
| `src/components/sidebar/ToolsPanel.tsx`、菜单 `AppCommand` | 工具列表项镜像主菜单 Tools；无 Explorer | 新增 `file-explorer` 命令与列表项 | 源码，确定 |
| `src/stores/workspacePlatformStore.ts:73` `WorkspaceToolWindow = "project"\|"sessions"\|"structure"`；`useWorkspaceCodeHost.ts` `navigationItems`（Sessions Alt+2、Git Alt+9） | 左侧导航条项由 `navigationItems` 提供；Git 项以 `openGitTab` 打开工作区标签 | 新增 Explorer 导航项（建议 Alt+3），以 `WorkspaceTabKind` 新值 `"explorer"` 的工作区标签打开 | 源码，确定；Alt+3 是否冲突待 TASK-05 核对 |
| `src/components/terminal/panel/useTerminalContextMenu.tsx`；`TerminalTabContents.tsx:233` | 已有 `gitToggle{cwd,onOpen}` 模式，仅本地、非 SSH、非 commandTerminal 终端传入；cwd 来自 `appStore.cwdByTab` / `queryTerminalCwd` | 仿照新增 `explorerToggle`，同样的启用条件 | 源码，确定 |
| `src/components/editor/workspace/explorerPreferences.ts` | 项目树排序偏好 | 复用排序键定义；Explorer 视图/预览偏好另存 | 源码，确定 |
| `AGENTS.md` | 单文件 ≤ 800 行；macOS 快捷键规则；`pnpm check:refactor`；新功能须跑 `crash-regression` | 所有新组件按文件拆分；快捷键走既有映射；V-08 / V-10 覆盖 | 仓库规则 |

调用链（现状）：「文件」会话 → `openFileBrowserTab` → `file-browser` 标签（`FileBrowserTabInfo{initialPath}`）→ `LocalFileBrowserPanel` → `sftpStore` 本地窗格 → `sftp_*` Tauri 命令。工作区内「文件」协议会话由 `WorkspaceSessionPane.tsx` 同样渲染 `LocalFileBrowserPanel`。

## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | 已有本地环境 | 工具面板 / 主菜单打开「文件资源管理器」 | 打开一个 Explorer 标签，起始目录为用户主目录；左树选中并展开到该目录，面包屑与文件列表一致 | 三端 |
| AC-02 | Explorer 已打开 | 点击左树节点、面包屑段、地址栏输入路径回车、后退/前进/上一级 | 文件列表与面包屑、左树选中、标签标题同步；路径不存在或无权限时在地址栏下方提示错误，当前目录不变 | 三端；Windows 含盘符与 UNC 路径 |
| AC-03 | 选中单个文本 / Markdown / CSV / 图片 / 文件夹，预览窗格开启 | 选择该项 | 预览窗格显示：文本带行号（上限 256 KB，超出提示已截断）；Markdown 渲染；CSV 表格前 N 行；图片缩略显示（上限 20 MB，超出显示元信息）；文件夹显示项目数与大小；多选显示数量与总大小；不支持类型显示图标与元信息；二进制不尝试渲染 | 三端 |
| AC-04 | Explorer 已打开 | 切换预览位置（右 / 下）、开关预览（Alt+P）、窗口变窄 | 位置与开关持久化到偏好并对所有 Explorer 标签生效；宽度不足阈值时自动折叠预览且不丢失开关状态；折叠后可手动展开 | 三端；快捷键在 macOS 使用既有映射规则 |
| AC-05 | 目录有文件 | 单击、Ctrl/Cmd 点击、Shift 点击、框选、Ctrl+A | 选择行为与 Windows 资源管理器一致；状态栏显示项目数与选中数量及总大小 | 三端 |
| AC-06 | 目录内选中一项 | F2 / 命令栏重命名 | 行内编辑，文件名不含扩展名部分预选；同名冲突提示且不覆盖；非法字符（Windows 保留名与字符）提示 | 三端 |
| AC-07 | 选中文件，剪贴板为空 | 复制或剪切，导航到另一目录并粘贴 | 复制：源保留、目标新增；剪切：源移除、目标新增；同目录粘贴复制产生「名称 - 副本」；目标已存在同名时生成不冲突名称，不覆盖；系统文件剪贴板同步，可粘贴到系统文件管理器，反向亦然 | 三端；跨设备移动（剪切）退化为复制后删除 |
| AC-08 | 选中文件 / 文件夹 | 拖放到左树节点、面包屑段或文件列表里的文件夹 | 默认移动（同卷）；按住 Ctrl（macOS 为 Option）复制；拖放目标高亮；落到自身或子孙目录被拒绝并提示 | 三端 |
| AC-09 | DEC-03 选「回收站」 | Del 或命令栏删除；Shift+Del | Del：条目进入系统回收站，出现带「撤销」的提示，点击撤销后恢复到原位置；Shift+Del：确认框后永久删除，不可撤销；回收站不可用（如网络盘、无回收站的 Linux 环境）时降级为确认后永久删除并明确说明 | 三端；Linux 依赖 freedesktop trash |
| AC-10 | 选中项 | 右键 | 菜单项：打开、在新的 Explorer 标签打开（仅文件夹）、在终端中打开、剪切、复制、复制路径、重命名、删除、属性；空白处右键：新建文件夹/文本文件、粘贴、刷新、在系统文件管理器中显示 | 三端 |
| AC-11 | 已有 Explorer 标签 A 当前目录为 D | 从任一入口再次打开目录 D | 激活 A，不新增标签；若 A 当前目录不是 D 则不匹配，新建标签 | 三端；去重只在同一作用域（主界面 / 同一工作区）内 |
| AC-12 | 已有 Explorer 标签 A 当前目录为 D | 点击工具栏「在新标签中打开」或菜单「在新的 Explorer 标签中打开」 | 新建标签 B（当前目录 D），A 不变，两个标签独立导航 | 三端 |
| AC-13 | 本地终端（非 SSH、非 commandTerminal）标签；终端 cwd 可知 | 终端右键 →「在 Explorer 中打开当前目录」 | 打开或激活当前 cwd 的 Explorer 标签，标签显示为会话类型标签；cwd 未知时弹出与 Git 入口一致的提示且不打开 | 三端；SSH/命令终端不显示该菜单项 |
| AC-14 | 工作区已选中 | 点击工作区左侧导航条 Explorer 图标（DEC-01 方案 A）或使用侧栏「树/浏览」切换（方案 B） | A：打开工作区内 Explorer 标签（起始目录为工作区根）；B：侧栏切换为单列浏览，窄栏下不显示树与预览，可「在标签页中打开」；两方案下项目树原有行为不变 | 三端 |
| AC-15 | 在工作区项目树中右键文件夹 | 选择「在 Explorer 中打开 / 在新的 Explorer 标签中打开」 | 与 AC-11/12 规则一致，作用域为该工作区 | 三端 |
| AC-16 | 目录含大量文件（≥ 10 000 项） | 打开并滚动、排序、过滤 | 列表虚拟滚动，首屏可交互；排序与过滤不阻塞 UI；目录读取失败显示错误状态而非空列表 | 三端；性能目标与测量边界在 TASK-07 / V-09 确定，当前无既有指标，**不得**在实现前臆造数值 |
| AC-17 | 目录被外部修改 | 在系统文件管理器中新增 / 删除文件，回到 Explorer 或点刷新 | 刷新后列表一致；Explorer 重新获得焦点时自动刷新当前目录 | 三端；本轮不做文件系统监听 |
| AC-18 | 失败与恢复 | 目标不可写、源已被删除、权限不足、磁盘满 | 对应操作提示具体原因；多项操作部分失败时逐项汇总，已成功项不回滚；撤销失败提示原因 | 三端 |
| AC-19 | 既有「文件」会话与 SFTP 本地窗格 | 打开已保存的「文件」会话、SFTP 双栏的本地窗格 | 行为不退化：「文件」会话打开后同样是 Explorer 外观，但保持原有 `sessionId` 关联；SFTP 双栏本地窗格不受影响 | 三端 |
| AC-20 | 重启应用 | 重新打开应用 | Explorer 标签（若会话恢复启用）恢复到各自当前目录；视图模式、排序、预览位置与开关恢复；已不存在的目录回退到其最近存在的上级目录并提示 | 三端 |

## 4. 方案与关键决策

**组件与复用。** 新增 `src/components/explorer/ExplorerShell.tsx` 作为标签内容：顶部导航行（后退/前进/上一级/刷新、面包屑地址栏、搜索）、命令栏（新建、剪切、复制、粘贴、重命名、删除、排序、查看、预览开关、在终端中打开、在新标签打开、更多）、主体（`ExplorerNavTree` + 文件列表 + `ExplorerPreviewPane`）、状态栏。文件列表复用 `FilePanel` 的列定义、排序、选择与虚拟列表；所有目录读取与导航继续经 `sftpStore` 本地窗格，不新建第二套目录状态。`LocalFileBrowserPanel` 保留，作为 ExplorerShell 的内部实现细节，并由 SFTP 本地窗格之外的入口使用。

**标签类型。** 复用 `TabKind "file-browser"`，扩展 `FileBrowserTabInfo` 为 `{ initialPath; explorer?: true }`，由 `explorer` 标记区分新旧外观；`currentPath` 以 `sftpStore.sessions[tabId].local.path` 为权威，不另存一份。工作区侧新增 `WorkspaceTabKind "explorer"`，渲染同一个 ExplorerShell，隔离在各工作区内，不与主界面标签混用。

**同目录去重。** 键 = 「作用域 + 当前目录规范化路径」。主界面作用域为所有 `file-browser` Explorer 标签；工作区作用域为该工作区 `openTabs` 中 `kind==="explorer"` 的标签。目录规范化：Windows 不区分大小写并统一分隔符，macOS 默认大小写不敏感文件系统按实际路径比较，Linux 区分大小写；以 Rust 命令 `explorer_canonical_path` 或前端已有路径规范化工具为准（TASK-01 核对）。

**本地文件操作。** 新增 Rust 命令集（见接口表），在 `src-tauri/src/filebrowser/local_ops.rs`（拟新增）实现：递归复制、同卷移动（`rename`）、跨卷移动（复制后删除并在失败时保留源）、冲突自动重命名、符号链接按链接本身复制（不跟随）、进度事件仅用于大目录复制（超过阈值才发事件）。回收站使用 `trash` crate；失败时返回结构化错误让前端降级为永久删除确认。

**预览。** 前端按扩展名与 MIME 分发：文本类 → `sftp_read_file_text`（已有，限制 256 KB）；Markdown → 复用现有 Markdown 渲染组件（TASK-04 确认可用实例）；CSV → 前端解析前 100 行；图片 → 新命令 `explorer_read_preview_bytes`（≤ 20 MB，返回字节，前端生成 blob URL 并在切换/卸载时 `revokeObjectURL`）；其余仅显示图标与元信息。预览加载按选择变化做取消与过期响应丢弃。

**偏好。** 视图模式（详细信息 / 列表 / 大图标）、排序键与方向、是否显示隐藏文件、预览开关、预览位置、预览宽度、换行；全局一份，存放于现有偏好存储（TASK-02 确认使用 `explorerPreferences.ts` 同一机制或新增 `explorerViewPreferences.ts`）。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 工作区如何切换到文件资源管理器 | **A** 左侧导航条新增 Explorer 图标，点击在主区打开 Explorer 标签；项目树保持不变。成本低，与用户建议一致，窄侧栏不挤压树。**B** 侧栏头部 [树 \| 浏览] 分段切换，在侧栏内浏览；不开新标签，但侧栏窄，无树无预览，能力弱，且要改 `WorkspaceSidebar` 的编辑器宿主 portal，改动与回归面大 | 推荐 **A**；B 的「在标签页中打开」作为 A 的补充不做 | **待用户决策**（已在原型中提供 A/B 切换） | 用户建议为图标 + 新标签，倾向 A，但未明确选择 | AC-14、AC-15；TASK-05 |
| DEC-02 预览窗格默认开关与位置 | 默认开：开箱即看内容，窄窗自动折叠；默认关：界面更干净，需要时 Alt+P。位置右 / 下均支持，持久化 | 推荐默认开、位置右、窄窗自动折叠 | **待用户决策** | 用户要求「预览窗格可配置」，未指定默认值 | AC-03、AC-04；TASK-04 |
| DEC-03 删除语义 | **回收站 + 撤销**：误删可恢复，需新增 `trash` crate，Linux 依赖 freedesktop trash，网络盘等不可用时降级；**确认后永久删除**：沿用现状，无新依赖，但不可恢复 | 推荐回收站 + 撤销，Shift+Del 永久删除，不可用时降级为永久删除确认 | **待用户决策** | 当前行为为永久删除；用户要求「常用文件操作」，未涉及删除语义 | AC-09；TASK-03 |
| DEC-04 打开方式 | 每个入口都走 `openExplorer`，默认同目录去重并提供新标签入口 | 采用 | 用户已定 | 需求原文「默认一个目录一个标签，另加按钮新开标签」 | AC-11、AC-12；TASK-01 |
| DEC-05 去重键 | 以「标签当前目录」而非「创建时的初始目录」判定同目录；导航后标签不再占用旧目录 | 采用，避免导航后旧目录无法再打开 | agent 自决 | 需求只说「一个目录一个标签」，当前目录语义更符合预期 | AC-11；TASK-01 |
| DEC-06 底层复用 | 复用 `FilePanel` + `sftpStore` 本地窗格 + 现有 `file-browser` 标签；不重写 | 采用 | agent 自决 | 需求要求基于现有本地文件浏览；源码已具备列表、排序、选择能力 | 全部；TASK-02 |
| DEC-07 终端入口范围 | 仅本地、非 SSH、非 commandTerminal 终端；与 Git 入口启用条件一致；本轮不分配快捷键 | 采用；原型中曾有的 Ctrl+Shift+E 已删除，避免与终端 / IDEA 键位冲突，后续需要再单独设计 | agent 自决 | `TerminalTabContents.tsx` 既有 `gitToggle` 条件；快捷键冲突风险 | AC-13；TASK-06 |
| DEC-08 图片预览通道 | 扩大 asset 协议 scope（暴露面大）vs 新增受限字节命令 + blob URL | 采用后者 | agent 自决 | asset scope 仅 `$APPDATA/ai-generations`，放大有安全风险 | AC-03；TASK-04 |

### 用户流程与交互

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 任意界面 | 工具 → 文件资源管理器 | 无 | 新建 Explorer 标签（主目录）；已有同目录标签则激活 | 目录不可读 → 标签内显示错误态与「重试 / 上一级」 |
| 终端标签 | 右键 → 在 Explorer 中打开当前目录 | 本地终端；cwd 已知 | 打开或激活该 cwd 的 Explorer；标签标题为目录名 | cwd 未知 → 提示对话框，不打开 |
| 终端标签 | 右键 → 在新的 Explorer 标签中打开 | 同上 | 新建标签，即使同目录已有标签 | 同上 |
| 工作区 | 点击导航条 Explorer 图标 | 已选工作区 | 工作区内打开 Explorer 标签（工作区根）；再次点击激活而非重复 | 无根目录的工作区 → 使用主目录并提示 |
| Explorer | 选择文件 | 预览开启 | 预览更新；快速连续选择只渲染最后一次 | 读取失败 → 预览区显示错误与「用系统应用打开」 |
| Explorer | 复制 / 剪切 → 粘贴 | 有选中项 | 剪切项半透明；粘贴后提示「已粘贴 N 项」 | 部分失败 → 汇总失败项及原因 |
| Explorer | Del | 有选中项 | 回收站：提示「已移到回收站」+ 撤销（时限内）；永久：确认框 | 回收站失败 → 降级确认框并说明原因 |
| Explorer | 拖放 | 有选中项 | 目标高亮；放下后移动 / 复制，提示结果 | 目标是自身或子孙 → 拒绝并提示 |
| Explorer | 窗口变窄 | 预览开启 | 预览折叠为按钮；展开时覆盖在列表上方，不挤压列表 | 无 |

键盘：方向键移动焦点、Enter 打开、Backspace / Alt+↑ 上一级、Alt+←/→ 后退前进、F2 重命名、Del / Shift+Del、Ctrl/Cmd+C/X/V、Ctrl/Cmd+A、Ctrl/Cmd+L 聚焦地址栏、F5 刷新、Alt+P 预览。macOS 键位按 `AGENTS.md` 现有映射规则处理，不新增裸 Ctrl 绑定。

#### 原型与示意图

- 当前有效图稿：[`docs-feature/file-explorer/prototype-v1.html`](file-explorer/prototype-v1.html)（v1，自包含，浅 / 深主题，视口约 1440×860）。关键状态截图：
  - [Explorer 标签（浅色）](file-explorer/proto-v1-explorer-light.jpg)
  - [Explorer 标签（深色）+ 右键菜单](file-explorer/proto-v1-explorer-dark-menu.jpg)
  - [工作区入口 方案 A](file-explorer/proto-v1-workspace-A.jpg)
  - [工作区入口 方案 B](file-explorer/proto-v1-workspace-B.jpg)
  - [终端右键入口](file-explorer/proto-v1-terminal-menu.jpg)
- 原型 URL 参数：`sc=explorer|workspace|terminal`、`var=A|B`、`pv=on|off`、`theme=light|dark`、`menu=term|file`、`bmode=browse`、`open=<路径>`。可用 `python3 -m http.server` 在 `docs-feature/file-explorer/` 下打开。
- 图稿决策：DEC-01、DEC-02、DEC-03 已在原型顶栏提供切换，**待用户反馈**。
- 修订结果：v1 为首版，无旧版本被替代。绘图工具（draw.io）在本环境不可用，示意图以 HTML 原型与截图代替，没有可编辑的 `.drawio` 源。原型内的文件系统与数据均为模拟，原型只做过脚本级冒烟（去重、复制 / 剪切 / 粘贴、重命名、删除 / 撤销、新建、移动，均无脚本错误），不代表产品行为。

### 数据流、状态与生命周期

- **目录状态**：权威在 `sftpStore.sessions[tabId].local`（路径、条目、选择、排序、过滤），沿用 `attachLocalOnly` / `detachLocalOnly` 生命周期；Explorer 卸载时 `detachLocalOnly`。
- **去重索引**：`openExplorer` 读取 appStore `tabs`（主界面）或 `workspacePlatformStore` 的 `openTabs`（工作区）和各标签 `sftpStore` 当前路径，不单独存索引，避免与导航状态不一致。
- **剪贴板**：内存中保存 `{paths, cut}`，同时 `clipboard_write_files`；粘贴时优先读系统剪贴板，若其来自外部应用则按复制处理；剪切状态只对本应用内的路径生效，粘贴成功后清空。
- **回收站撤销**：前端保存本次被删除项的原路径与 `trash` 返回的回收站标识，撤销调用 `explorer_trash_restore`；超时（建议提示可见期间，例如 10 秒）或标识失效则撤销按钮消失；跨应用重启不保留。**撤销在 Linux 的可行性**依赖 freedesktop trash 元数据，若 crate 不能按原路径还原，则退化为「在回收站中显示」提示——TASK-03 需先验证并回填。
- **预览**：请求带递增序号，旧响应丢弃；blob URL 在选择变化、卸载时释放；文本预览仅读取前 256 KB。
- **偏好**：启动时读取，修改即写；多个 Explorer 标签共享，storage 事件同步。
- **并发与过期**：目录读取带请求序号；长时间复制 / 移动允许取消，取消后已复制部分保留并提示。

### 接口与共享契约

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `local_copy_entries`（拟新增） | `src/lib/explorer.ts` → `filebrowser/local_ops.rs` | `{ sources: string[]; destDir: string; conflict: "rename" }` | `{ done: {from,to}[]; failed: {path,code,message}[] }`；大目录发 `explorer:progress` 事件 | 新命令，不影响现有 `sftp_*` |
| `local_move_entries`（拟新增） | 同上 | 同上 | 同上 | 同卷 `rename`，跨卷复制后删源，失败保留源 |
| `local_trash_entries` / `local_trash_restore`（拟新增） | 同上 | `{ paths: string[] }` / `{ items: TrashRef[] }` | `{ trashed: TrashRef[]; failed: [...] }`；不可用返回 `code: "trash_unavailable"` | 新增 Cargo 依赖 `trash`；三端条件编译一致 |
| `local_properties`（拟新增） | 属性对话框 → Rust | `{ path }` | 大小（目录递归，带上限与取消）、时间、权限、所有者、符号链接目标 | 递归大小需可取消 |
| `explorer_read_preview_bytes`（拟新增） | 预览窗格 → Rust | `{ path, maxBytes }`（上限 20 MB） | 字节 + MIME 猜测；超限返回 `too_large` | 仅读文件，不跟随越权符号链接以外的限制，沿用现有本地路径访问策略 |
| `sftp_read_file_text`、`sftp_list_local_detailed`、`sftp_local_home`、`sftp_local_drives`、`sftp_mkdir`、`sftp_rename`、`sftp_stat`、`sftp_open_path`、`clipboard_*_files`（现有） | 沿用 | 不变 | 不变 | 不改签名 |
| `FileBrowserTabInfo`（现有） | 前端类型 | 增加 `explorer?: true` | 无 | 旧标签数据缺该字段时按旧外观 / 迁移为 Explorer（由 TASK-02 决定默认并保持恢复兼容） |
| `WorkspaceTabKind "explorer"`（拟新增） | `workspacePlatformStore` | `{ kind:"explorer"; initialPath }` | 无 | 旧工作区快照无此值；未知 kind 的既有回退逻辑保持不变 |
| `AppCommand "file-explorer"`（拟新增） | 菜单 / `ToolsPanel` → `openExplorer` | 无 | 打开 / 激活主目录 Explorer | 新增，不改现有命令 |

### 三端兼容与相关存储、故障边界

- **Windows**：盘符列表 `sftp_local_drives`；`trash` crate 用 Shell API；路径大小写不敏感、`\` 与 `/` 统一；保留名（CON、PRN…）与非法字符校验；长路径（`\\?\`）读写；剪切跨盘走复制后删除；隐藏属性按文件属性判定。
- **macOS**：回收站走 NSFileManager；大小写不敏感（默认卷）；`.DS_Store` 等点文件按隐藏处理；快捷键按 `AGENTS.md` macOS 规则；拖放复制修饰键为 Option；打包应用的沙箱与全盘访问授权不在本期范围，访问受限目录时给出权限提示。
- **Linux**：回收站走 freedesktop trash（`$XDG_DATA_HOME/Trash`），网络 / 其他挂载点可能没有；系统文件剪贴板格式 `text/uri-list` / `x-special/gnome-copied-files` 与现有 `clipboard_*_files` 一致；WebKitGTK 下 blob URL 与拖放行为需在真机确认；无桌面环境时 `sftp_open_path` 失败要给出提示。
- **存储**：偏好新增键，不迁移旧数据；旧「文件」会话标签数据兼容。若实现回退，仅需恢复旧渲染分支，偏好键可保留无害。
- **browser stub**：浏览器 / QA 模式下需提供上述新命令的 stub（内存虚拟文件系统），使浏览器测试可覆盖 UI；stub 只证明前端逻辑，不证明原生文件系统行为。

## 5. 改动清单

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/lib/explorer/openExplorer.ts`（拟新增）与 `useProtocolTabs.ts` | 统一入口 `openExplorer(path,{scope,forceNew})`；去重；保持 `openFileBrowserTab` 对「文件」会话的行为 | AC-01、11、12、19 | TASK-01 |
| `src/types` 中 `FileBrowserTabInfo`、`TabKind` 相关 | 增加 `explorer` 标记；会话恢复兼容 | AC-19、20 | TASK-01、02 |
| `src/components/explorer/ExplorerShell.tsx`（拟新增，拆分 `ExplorerNavTree.tsx`、`ExplorerAddressBar.tsx`、`ExplorerCommandBar.tsx`、`ExplorerStatusBar.tsx`） | 导航树、地址栏、命令栏、状态栏、窄窗折叠；每个文件 ≤ 800 行 | AC-01、02、04、05、10 | TASK-02 |
| `src/components/filebrowser/LocalFileBrowserPanel.tsx` 与 `filePanel/*` | 接入剪贴板、拖放、回收站删除、右键菜单扩展；保留 SFTP 本地窗格用法 | AC-06~10、19 | TASK-02、03 |
| `src/components/explorer/preview/*`（拟新增） | 文本 / Markdown / CSV / 图片 / 目录 / 多选 / 其他；序号取消与 blob 释放 | AC-03、04 | TASK-04 |
| `src/lib/explorer.ts`（拟新增） | 新 Tauri 命令的 TS 封装与类型 | AC-07~09 | TASK-03、04 |
| `src-tauri/src/filebrowser/local_ops.rs`（拟新增）、`commands/filebrowser.rs`、`commands/mod.rs`、`Cargo.toml` | 复制 / 移动 / 回收站 / 属性 / 预览字节命令；注册；`trash` 依赖 | AC-07~09、18 | TASK-03、04 |
| `src/components/sidebar/ToolsPanel.tsx`、`menubar/commands.ts`、i18n 资源 | 新增 `file-explorer` 命令与列表项；中英文文案 | AC-01 | TASK-01 |
| `workspacePlatformStore.ts`、`useWorkspaceCodeHost.ts`、`WorkspaceSessionPane` / 工作区标签渲染、项目树右键菜单 | 新 `"explorer"` 标签类型；导航条图标（DEC-01 A）；右键菜单项 | AC-14、15 | TASK-05 |
| `useTerminalContextMenu.tsx`、`TerminalTabContents.tsx` | 新增 `explorerToggle` 与菜单项（两项：当前目录 / 新标签） | AC-13 | TASK-06 |
| browser stub（路径由 TASK-07 核对）、`qa-ui-auto-tests/cases/`、`feature-list.md` | stub 命令；新增 Explorer 用例 | 全部 | TASK-07 |

## 6. 实现任务与交接

### TASK-01 打开入口与同目录去重
- 职责与文件范围：`openExplorer`、`useProtocolTabs.ts`、`TabContentRouter.tsx` 路由到 ExplorerShell、`ToolsPanel`、命令枚举与菜单、i18n。
- 输入与必读：本设计 §2、§4（去重）、DEC-04/05；`useProtocolTabs.ts:152`、`TabContentRouter.tsx:411-430`。
- 依赖：无；路径规范化方式在本任务内确认。
- 实施内容：实现去重与 `forceNew`；主界面与工作区两种作用域；注册 `file-explorer` 命令。
- 对应验收：AC-01、11、12、19。
- 验证与完成条件：V-01、V-05；回填 Vitest 输出。
- 并行与集成：可与 TASK-03 的 Rust 部分并行；ExplorerShell 由 TASK-02 提供，先用占位路由合入。

### TASK-02 ExplorerShell 与导航
- 职责与文件范围：`src/components/explorer/*`（除 preview）、`LocalFileBrowserPanel` 的外观接入、偏好存储。
- 输入与必读：§4、原型 `prototype-v1.html`、`FilePanel` 与 `sftpStore` 本地窗格。
- 依赖：无（可先于 TASK-01 开始）。
- 实施内容：导航树（快速访问 / 工作区 / 此电脑，懒加载、展开记忆）、可编辑面包屑、命令栏、状态栏、视图模式、窄窗折叠、会话恢复。
- 对应验收：AC-01、02、04、05、10、16、20。
- 验证与完成条件：V-02、V-05、V-09。
- 并行与集成：与 TASK-03/04 通过 `src/lib/explorer.ts` 契约对接。

### TASK-03 本地文件操作与回收站（待 DEC-03）
- 职责与文件范围：`local_ops.rs`、命令注册、`src/lib/explorer.ts`、剪贴板 / 拖放 / 删除接线。
- 输入与必读：§4 本地文件操作、接口表；`resource_operations.rs` 的冲突命名算法；`config/clipboard.rs`。
- 依赖：DEC-03（影响删除分支与 `trash` 依赖）。复制 / 移动 / 拖放不依赖 DEC-03，可先做。
- 实施内容：复制、移动、冲突命名、符号链接、回收站与撤销（Linux 还原可行性先验证并回填）、部分失败汇总、进度与取消。
- 对应验收：AC-06~09、18。
- 验证与完成条件：V-03、V-04、V-06。
- 并行与集成：Rust 与前端接线可由两人并行，契约以接口表为准。

### TASK-04 预览窗格（待 DEC-02）
- 职责与文件范围：`explorer/preview/*`、`explorer_read_preview_bytes`、偏好项。
- 依赖：DEC-02 只影响默认值；其余无。
- 实施内容：类型分发、序号取消、blob 释放、位置与折叠、上限提示。
- 对应验收：AC-03、04。
- 验证与完成条件：V-02、V-05。

### TASK-05 工作区入口（待 DEC-01）
- 职责与文件范围：`workspacePlatformStore.ts`、`useWorkspaceCodeHost.ts`、工作区标签渲染、项目树右键菜单。
- 依赖：DEC-01 与 TASK-01、TASK-02；Alt+3 与现有键位冲突需先核对。
- 实施内容：方案 A：新增 `"explorer"` 标签类型与导航条项；方案 B：侧栏分段切换（若选 B，需同时重估 `WorkspaceSidebar` 改动）。
- 对应验收：AC-14、15。
- 验证与完成条件：V-05、V-07。

### TASK-06 终端入口
- 职责与文件范围：`useTerminalContextMenu.tsx`、`TerminalTabContents.tsx`。
- 依赖：TASK-01。
- 实施内容：与 `gitToggle` 同条件的 `explorerToggle`；使用 `terminalCwdsRef` / `queryTerminalCwd`；cwd 未知提示。
- 对应验收：AC-13。
- 验证与完成条件：V-05、V-07。

### TASK-07 测试、stub 与整体集成
- 职责与文件范围：browser stub、Vitest、Rust 测试、QA 用例与 feature 清单、`crash-regression` 与 `check:refactor`。
- 依赖：TASK-01~06。
- 实施内容：stub 与用例；性能目标制定（AC-16）；整体回归；Linux 真机验证（V-07）。
- 对应验收：全部。
- 验证与完成条件：V-01~V-10。
- 并行与集成：最终集成与回归、真机验证由本任务负责。

## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-11、12 / 去重与新标签 | Vitest（拟新增 `openExplorer.test.ts`） | 构造 tabs 与路径 | 同目录激活不新增；导航后旧目录可新开；`forceNew` 新增；作用域隔离 | `pnpm exec vitest run <文件>`（仓库根）；见记忆「Focused unit commands」 | 无既有基线 / 待执行 |
| V-02 | AC-03、04、05 / 预览与选择 | Vitest 组件测试（拟新增） | stub 命令返回文本、图片、过大文件 | 类型分发正确；过期响应丢弃；折叠阈值；blob 释放 | 同上 | 待执行 |
| V-03 | AC-07、08、18 / 复制移动 | Rust 单测（`local_ops.rs`，拟新增） | 临时目录构造文件树、符号链接 | 冲突命名；同卷 / 跨卷语义；部分失败汇总；移动到自身子目录被拒 | `cargo test -p <crate> local_ops`（`src-tauri`）；Replit 需按记忆里的 Rust 工具链说明 | 待执行 |
| V-04 | AC-09 / 回收站 | Rust 单测 + 真机 | 临时目录；Linux freedesktop | 进入回收站；撤销还原到原位置；不可用时返回 `trash_unavailable` | 同上；需桌面 trash 目录 | 待执行 |
| V-05 | AC-01~06、10~15 / UI 流程 | 浏览器 QA（`qa-ui-auto-tests/cases/` 拟新增 Explorer 用例，feature ID 与 `feature-list.md` 条目由 TASK-07 维护） | 使用 browser stub 的内存虚拟文件系统 | 控件 testid（拟新增：explorer-tab、explorer-nav-tree、explorer-address、explorer-preview、explorer-cmd-*）的可观察结果；`assert_no_runtime_errors` | 按 `qa-ui-auto-tests/README.md` 的 browser 运行方式；先修复 `@tanstack/react-virtual` 缺失 | 待执行 |
| V-06 | AC-18 / 失败路径 | Rust + Vitest | 只读目录、已删除源、重名 | 提示原因；成功项不回滚 | 同上 | 待执行 |
| V-07 | AC-13、14、15 / 入口 | 浏览器 QA + 真机 | 本地终端 cwd 已知 / 未知；工作区 | 菜单项显隐；cwd 未知提示；标签作用域 | 同 V-05 | 待执行 |
| V-08 | AC-19 / 回归 | 既有 `crash-regression` 标签套件 + 受影响的 SFTP / 文件会话用例 | 全套运行 | 既有「文件」会话、SFTP 双栏本地窗格无退化 | 按 `qa-ui-auto-tests/ci/crash-regressions.md`；原生套件需匹配 QA 构建 | 待执行 |
| V-09 | AC-16 / 大目录 | 浏览器 QA + 真机基准 | 生成 ≥ 10 000 项目录 | 虚拟滚动、排序、过滤的响应；指标由 TASK-07 与现有基线确定 | 待定 | 待执行 |
| V-10 | 回归 / 仓库规则 | `pnpm check:refactor`、`pnpm exec tsc -b`、全量 `pnpm test` | — | 文件 ≤ 800 行、边界与类型检查通过 | 仓库根 | 待执行 |

browser stub 只能证明前端逻辑与 IPC 契约；Rust 单测证明文件语义；原生行为（真实回收站、系统剪贴板、拖放、WebKitGTK）只能由 V-07 / V-11 真机验证。stub、mock、内存文件系统均不能替代真机证据。

## 8. 真机验证手册

### 环境与准备

- **Linux（本轮执行端）**：Replit 容器，使用 opt-in 的 Xvfb/Fluxbox/DBus/FCITX5 包装脚本启动隔离桌面；使用匹配的 QA release 构建，隔离 app-data 与专用测试目录（含文本、图片、CSV、Markdown、符号链接、只读目录、10 000 项目录）。执行前确认 `tauri-driver` 与 WebKitWebDriver 端口都就绪，工具链按项目记忆中的 Replit Rust / bindgen 说明处理。回收站验证需确认 `$XDG_DATA_HOME/Trash` 可写。
- **Windows**：x64 Windows 11，WebView2；隔离 app-data；测试盘符与 UNC 路径；执行 V-11（Windows）。本轮未执行。
- **macOS**：Apple Silicon，WKWebView；隔离 app-data；执行 V-11（macOS）。本轮未执行。

### V-11 Explorer 真实桌面验证（各端同一清单）

- 对应验收：AC-01~15、17、18、20。
- 执行前状态：QA 构建、隔离 app-data、测试目录就绪；无残留 Explorer 标签。
- 操作与逐步预期：
  1. 工具 → 文件资源管理器：新标签，主目录，左树同步（AC-01）。
  2. 地址栏、面包屑、后退 / 前进 / 上一级导航；输入不存在路径出现错误提示（AC-02）。
  3. 选择文本 / Markdown / CSV / 图片 / 大文件 / 文件夹 / 多选，预览符合 AC-03；切换位置与开关，窄窗折叠（AC-04）。
  4. 重命名、新建、复制 / 剪切 / 粘贴、拖放（含 Ctrl / Option 复制）；用系统文件管理器核对真实结果与系统剪贴板互通（AC-06~08）。
  5. Del 进入真实回收站，撤销还原；Shift+Del 永久删除；人为让回收站不可用，验证降级提示（AC-09）。
  6. 本地终端 `cd` 到某目录，右键打开 Explorer；再次打开激活原标签；「在新标签」新增（AC-11~13）。
  7. 工作区入口（按 DEC-01 所选方案）与项目树右键入口（AC-14、15）。
  8. 在系统文件管理器中修改目录，回到 Explorer 刷新一致（AC-17）。
  9. 失败路径：只读目标、源被删除、权限不足（AC-18）。
  10. 重启应用，视图偏好与 Explorer 标签恢复（AC-20）。
- 故障与恢复：回收站不可用、剪贴板读取失败、预览读取失败，均有可见提示且应用不崩溃。
- 证据：真实应用截图 / 录屏路径、命令输出、文件系统 `ls` 前后对比；无运行时错误日志。
- 清理：删除测试目录与回收站条目，恢复隔离 app-data。
- 状态：Linux **待执行**；Windows **未执行（本轮不阻塞）**；macOS **未执行（本轮不阻塞）**。当前端自动化不可用时，按上述步骤手工执行并记录。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4 组件与复用 | TASK-01、02 | V-05、V-11（Linux） | 待生成 | 未实现 |
| AC-02 | §4 | TASK-02 | V-05、V-11 | 待生成 | 未实现 |
| AC-03 | §4 预览 | TASK-04 | V-02、V-05、V-11 | 待生成 | 未实现；DEC-02 默认值待定 |
| AC-04 | §4 偏好 | TASK-02、04 | V-02、V-11 | 待生成 | 未实现 |
| AC-05 | §4 | TASK-02 | V-02、V-05 | 待生成 | 未实现 |
| AC-06 | §4 本地文件操作 | TASK-03 | V-03、V-05、V-11 | 待生成 | 未实现 |
| AC-07 | §4 | TASK-03 | V-03、V-11 | 待生成 | 未实现 |
| AC-08 | §4 | TASK-03 | V-03、V-11 | 待生成 | 未实现 |
| AC-09 | §4、DEC-03 | TASK-03 | V-04、V-11 | 待生成 | 未实现；DEC-03 待定；Linux 撤销可行性待验证 |
| AC-10 | §4 | TASK-02、03 | V-05 | 待生成 | 未实现 |
| AC-11 | §4 去重 | TASK-01 | V-01、V-05 | 待生成 | 未实现 |
| AC-12 | §4 | TASK-01 | V-01、V-05 | 待生成 | 未实现 |
| AC-13 | §4 | TASK-06 | V-07、V-11 | 待生成 | 未实现 |
| AC-14 | DEC-01 | TASK-05 | V-07、V-11 | 待生成 | 未实现；DEC-01 待定 |
| AC-15 | DEC-01 | TASK-05 | V-07、V-11 | 待生成 | 未实现；DEC-01 待定 |
| AC-16 | §4 | TASK-02、07 | V-09 | 待生成 | 未实现；性能目标未定 |
| AC-17 | §4 | TASK-02 | V-11 | 待生成 | 未实现 |
| AC-18 | §4 | TASK-03 | V-03、V-06、V-11 | 待生成 | 未实现 |
| AC-19 | §4 | TASK-01、02 | V-08 | 待生成 | 未实现 |
| AC-20 | §4 | TASK-01、02 | V-11 | 待生成 | 未实现 |

三端状态：代码兼容检查（三端构建与条件编译）待实现后执行；自动化测试全部待执行；Linux 真机待执行；Windows / macOS 真机未执行，不继承 Linux 结果。本轮完成条件：V-01~V-10 通过、Linux V-11 通过且无已知三端不兼容。设计阶段未执行任何测试。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| DEC-01 / 02 / 03 待用户决策 | 影响入口形态、预览默认值、删除语义与新依赖 | 推荐 A / 默认开 / 回收站 | TASK-05、TASK-04（默认值）、TASK-03（删除分支） | 用户答复 |
| 主应用预览缺 `@tanstack/react-virtual` | 浏览器验证无法渲染主应用 | 先安装 / 修复依赖，单独处理 | TASK-07 的 V-05、V-09 | 依赖补齐且预览正常 |
| Linux 回收站撤销可行性 | `trash` crate 在 Linux 对按原路径还原的支持有限 | TASK-03 先做最小验证；不可行则撤销降级为「在回收站中显示」，AC-09 相应调整并回到用户确认 | TASK-03 | 验证结论 |
| 跨卷移动与大目录复制 | 失败时可能留下部分结果 | 复制完成后才删除源；进度与取消；部分失败汇总 | 不阻塞 | — |
| 快捷键冲突（Alt+3、终端 Ctrl+Shift+E） | 可能与现有键位或 IDEA 键位冲突 | 本轮终端入口不设快捷键；Alt+3 在 TASK-05 核对 | TASK-05 | 核对结论 |
| 路径大小写与 UNC 去重 | 误判同目录 | 以规范化路径比较，三端分别测试 | 不阻塞 | — |
| asset 协议与预览安全 | 暴露面 | 采用受限字节命令，不放宽 scope | 不阻塞 | — |
| 性能目标缺失 | AC-16 无可比基线 | TASK-07 先测当前 `FilePanel` 基线再定目标 | TASK-07 | 基线数据 |

回退：代码层可恢复 `TabContentRouter` 对 `file-browser` 的旧渲染分支并移除新入口；新增 Rust 命令与 `trash` 依赖无数据迁移，偏好键可保留。会话恢复数据新增字段向后兼容，无需数据回退。

现在可开始：TASK-01、TASK-02、TASK-03 的复制 / 移动部分、TASK-04 的预览（除默认值）。必须等待：TASK-05（DEC-01）、TASK-03 删除分支（DEC-03）、TASK-07 的最终集成。
