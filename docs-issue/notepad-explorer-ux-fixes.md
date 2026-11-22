# Notepad / File Explorer 交互与主题修复设计

日期：2026-11-22（北京时间）
分支：`fix/notepad-explorer-ux`（基线 `main@888a0297e`）
来源：用户 2026-11-22 反馈的 7 项问题，要求创建分支开发、补 unit/browser/native 用例、本地单测、GitHub 仅跑 Linux/macOS 的 browser/native、阶段性 checkpoint 提交。

## 1. 问题清单与根因

| ID | 用户反馈 | 根因 | 目标 |
|---|---|---|---|
| U1 | Notepad 新建文件保存弹窗在深色主题下仍是白底 | `src/components/notepad/notepad.css` 的 `.np-modal`（及菜单/工具栏等）使用未定义 token `--taomni-surface` / `--taomni-panel`，回退到 `#ffffff`；文字却用深色主题的 `--taomni-text`，深色下白底浅字不可读 | 所有 Notepad 表面只使用 `src/styles/theme.css` 已定义的 token；深/浅主题都与应用其他弹窗一致 |
| U2 | 新建文件保存默认目录应为 `$HOME`，并记住上次保存位置 | `useNotepadActions.performSave` 对 untitled 只传文件名 `"新建 1.txt"`、`initialPath: ""`；`file.saveAs` 同样只传文件名，浏览按钮只传文件名，没有 home/last-dir | Save As 默认路径 = 上次保存目录（无则 `$HOME`）+ 文件名；确认保存后记录新目录；原生保存面板也从该目录打开 |
| U3 | Notepad 打开文件的右键菜单仍是浏览器/WebView 默认菜单 | `NotepadCodeMirrorPane` 没有 contextmenu 处理，CodeMirror 未阻止默认菜单 | 右键编辑器显示应用风格 Notepad 菜单（撤销/重做/剪切/复制/粘贴/删除/全选/查找/替换/转到/行操作/书签/保存等），阻止 WebView 默认菜单 |
| U4 | Notepad 打开的多个 tab 右键操作与风格/图标要和 Sessions tab 一致 | `ExplorerTabStrip` 自绘 `.taomni-workspace-tab` 扁平样式，file-viewer tab 用通用 `FileText` 图标，右键菜单只有 pin/close/move 且图标未限尺寸（24px），缺少 Sessions 的 rename/duplicate/copy path/move-to-first/last | Explorer(Sessions 外的 Notepad 宿主) tab 使用 `.taomni-tab` 样式与共享 `TabIcon`（按类型着色/文件图标）、Sessions 风格的右键菜单顺序与小图标、内联重命名 |
| U5 | File Explorer 右键菜单只有点菜单项或文件才消失，点空白不消失 | 文件列表空白处 `pointerdown` 的 rubber-band 选择调用 `preventDefault()`，浏览器因此不再派发 `mousedown`；`ContextMenu` 只在 `mousedown` 关闭 | 共享 `ContextMenu` 同时监听 `pointerdown` 与 `mousedown`；空白/外部按下即关闭，菜单项点击不受影响 |
| U6 | File Explorer 激活后左侧 File Explorer 边栏作用不大，移除代码与 UI 资源 | `Sidebar` 在 `activeSideTab === "explorer"` 时渲染 `ExplorerSidebarPanel`（Home/新建/固定路径/打开文件夹列表），与 Explorer tab 内导航树重复；`openExplorer` 还主动展开侧栏 | 删除 `ExplorerSidebarPanel`、`pinnedPaths` 偏好与“固定到快速访问”菜单项；explorer 模式只保留主 rail，侧栏保持折叠 |
| U7 | Explorer 左侧树收缩按钮与大视图（左上）图标相同；左上侧栏收缩按钮在 explorer 模式应移除 | `ExplorerCommandBar` 的导航开关用 `PanelLeft`，与 `ControlBar` 的 `toggle-left-sidebar`（`PanelLeft`/`PanelRight`）相同；侧栏移除后该开关无意义 | 导航树开关改为 `PanelLeftClose`/`PanelLeftOpen` 并带 `data-icon`；explorer 模式下隐藏 `toggle-left-sidebar`，`Ctrl+B` 不展开不存在的面板 |

## 2. 验收条件

| AC | 场景 | 动作 | 期望 |
|---|---|---|---|
| AC-1 | 深色主题 | 新建未命名文档 → Ctrl+S | Save As 弹窗背景为深色面板色，文字可读；浅色主题仍为浅色 |
| AC-2 | 未命名文档首次保存 | Ctrl+S / File > Save As | 路径输入框为绝对路径：`<lastSaveDir 或 $HOME>/<文件名>.txt`；浏览按钮打开到同目录 |
| AC-3 | 保存成功后再次另存 | 修改文件名保存 → 新建文档 → Ctrl+S | 默认目录为上次保存的目录；应用重启后仍保留 |
| AC-4 | 编辑器右键 | 在 viewer-editor 上右键 | 应用风格菜单出现，含撤销/重做/剪切/复制/粘贴/删除/全选/查找/替换/转到行/行操作/书签/保存/另存为/复制路径；WebView 默认菜单被阻止；Esc/外点关闭 |
| AC-5 | Explorer 多标签 | 打开 ≥2 个 Explorer/Notepad tab | tab 使用 Sessions 同款 `.taomni-tab` 样式与类型图标；右键菜单含 Close/Close others/Close all/Rename/Duplicate/Copy path/Move first|left|right|last（+Pin/Close left|right/unmodified/unpinned）；菜单图标 12px；双击标题内联重命名 |
| AC-6 | Explorer 空白处右键菜单 | 空白处右键 → 点击另一处空白 | 菜单关闭；点击菜单项仍执行并关闭；Esc 关闭 |
| AC-7 | Explorer 激活 | 点击 rail Explorer | 不再出现左侧 Explorer 边栏（`explorer-sidebar-panel` 不存在）；`toggle-left-sidebar` 不渲染；rail 仍在；切回 Sessions/Workspaces 后侧栏行为恢复 |
| AC-8 | Explorer 导航树开关 | 查看命令栏首个按钮 | 图标与左上侧栏开关不同（`data-icon="panel-left-close" / "panel-left-open"`）；仍可展开/收起导航树并记住 `navVisible` |

## 3. 设计

### 3.1 Notepad 主题（U1）

`notepad.css` 中删除未定义 token：`--taomni-surface` → `--taomni-panel-bg`（弹窗/菜单栏/工具栏/停靠面板）；`--taomni-panel` → `--taomni-panel-bg` / `--taomni-button-from`。`.np-modal` 使用 `var(--taomni-panel-bg, #ffffff)`，输入框/按钮沿用已有定义 token。新增单测读取 CSS 文本禁止 `--taomni-surface`/`--taomni-panel` 再次出现（防回归），深色背景断言由 browser QA 计算样式覆盖。

### 3.2 Notepad 保存默认目录（U2）

- `NotepadPreferences` 增加 `lastSaveDir: string`（默认 `""`），走现有校验/持久化/跨窗口同步。
- 新增纯函数 `src/lib/notepad/persistence/savePath.ts`：
  - `notepadSaveDirectory(lastSaveDir, home)`：合法目录优先，否则 home，否则 `""`；
  - `defaultNotepadSavePath(directory, fileName, platform)`：Windows 用 `\`，其余 `/`；空目录返回文件名。
- `performSave()`（untitled）与 `file.saveAs`：`await getHomeDir()`（`src/lib/ipc/files.ts`），得到默认绝对路径；`saveAs` 的 `defaultPath`/`initialPath` 都传该绝对路径。
- `handleSaveAs` 成功后（含 Save a Copy）从 `res.path` 取目录，`setNotepadPreferences({ lastSaveDir })`。
- `FileLifecycleDialogs` 浏览按钮：`selectSaveFilePath(dirName, dir)` 打开到默认目录；`modal` 增加 `defaultDir`，避免再次拆路径。
- browser stub 需支持 `get_home_dir`（无则补 `src/stubs`），并在 `ipc.test.ts`/新单测中覆盖。

### 3.3 Notepad 编辑器右键菜单（U3）

- `NotepadCodeMirrorPane` 外层 host div 增加 `onContextMenu`：`preventDefault`/`stopPropagation`，回调 `{x,y, paneIndex}`；不得在只读/IME/弹窗打开时误触。
- 新增 `src/components/notepad/NotepadContextMenu.tsx`：接收 `onCommand(id)`、`readOnly`、`hasSelection`、路径信息，用 `useContextMenu` + `ContextMenu`（`testId="notepad-context-menu"`）渲染菜单。菜单项取自命令目录（`NOTEPAD_COMMAND_BY_ID`）的 `commandLabel`/`zhLabel` 与 `formatShortcutDisplay(resolveShortcut(id))`：
  - 撤销 `edit.undo`、重做 `edit.redo`、分隔、剪切 `edit.cut`、复制 `edit.copy`、粘贴 `edit.paste`、粘贴特殊 `edit.pasteSpecial`、删除 `edit.delete`、全选 `edit.selectAll`、分隔、复制行 `edit.duplicateLine`、删除行 `edit.deleteLine`、上移行 `edit.moveLineUp`、下移行 `edit.moveLineDown`、分隔、查找 `search.find`、查找下一个 `search.findNext`、替换 `search.replace`、转到 `search.goToLine`、分隔、切换书签 `search.toggleBookmark`、分隔、复制当前路径 `edit.copyCurrentFilePath`、保存 `file.save`、另存为 `file.saveAs`。
  - 写操作在只读时禁用（复制/查找/另存/复制路径可用）；禁用项仍显示。
- `NotepadEditor` 持有菜单状态（菜单项构建与渲染放新组件，编辑器只做接线），确保 `NotepadEditor.tsx` 保持 ≤ 800 行。
- testid：`notepad-context-menu`、`notepad-context-undo/redo/cut/copy/paste/paste-special/delete/select-all/duplicate-line/delete-line/move-line-up/move-line-down/find/find-next/replace/go-to/toggle-bookmark/copy-path/save/save-as`。

### 3.4 Explorer tab 与 Sessions 对齐（U4）

- `ExplorerTabStrip` 每个 tab：
  - class 改为 `taomni-tab`（保留 `max-w-[190px] shrink-0` 等布局需求），去掉 `.taomni-workspace-tab`；新增 `data-tab-style="session"` 便于断言。
  - 图标：file-browser 用 `ExplorerTabIcon`，file-viewer 用共享 `TabIcon`（`tabbar/tabs/TabItem` 导出的 `TabIcon`，与 Sessions 相同按类型图标）。
  - 关闭按钮对齐 Sessions：`X w-3 h-3 ml-1 opacity-60 hover:opacity-100`，保留 `data-testid="tab-close"`。
  - 标题双击进入内联重命名（`input[data-testid="explorer-tab-rename-input"]`，Enter 提交 / Esc 取消 / blur 提交），提交调用 `useExplorerStore.renameTab`。
- 右键菜单（`data-testid="explorer-tab-context-menu"`，`ContextMenu`）顺序与 Sessions 对齐：
  1. Close（`explorer-tab-context-close`）
  2. Close others（`...-close-others`）
  3. Close all（`...-close-all`）
  4. ——
  5. Rename（`...-rename`，启动内联重命名）
  6. Duplicate（`...-duplicate`，仅 `file-browser` 可用：`openExplorer(path,{forceNew:true})`；viewer tab 禁用）
  7. Copy path（`...-copy-path`，写剪贴板并 toast/status）
  8. ——
  9. Move to first / Move left / Move right / Move to last（`...-move-first/left/right/last`，复用 `moveTab`）
  10. ——
  11. Pin/Unpin（`explorer-tab-context-pin`）
  12. Close tabs to the left / right / Close unmodified / Close unpinned（保留既有 testid）
  所有图标统一 `className="w-3 h-3"`（与 Sessions 菜单一致）。
- 新增共享 builder `src/components/tabbar/tabs/tabContextMenu.ts`：为 Sessions `TabBar.handleTabContext` 与 Explorer 提供同一顺序/图标/分隔线；允许注入 testId 前缀、标签函数与动作，Sessions 现有 testid（`tab-context-duplicate`、`tab-context-copy-session-info`）保持不变。

### 3.5 共享 ContextMenu 外部关闭（U5）

`src/components/ContextMenu.tsx` 的 outside 监听同时注册 `pointerdown` 与 `mousedown`（同一 handler），保证被 `preventDefault` 抑制 mousedown 的空白区域也能关闭；点击菜单内部（含 portal 子菜单）不关闭。`ContextMenu.test.tsx` 增加 pointerdown 关闭与“preventDefault 后 mousedown 不派发仍关闭”的用例。

### 3.6 移除 Explorer 左侧边栏（U6）

- 删除 `src/components/explorer/ExplorerSidebarPanel.tsx`；`Sidebar.tsx` 移除其 import 与 `case "explorer"`（回退到空面板），explorer 模式不再渲染扩展侧栏内容。
- `MainLayoutView` 在 `activeSideTab === "explorer"` 时 `setSidebarCollapsed(true)`（与 home 一致）；`openExplorer.activateExplorer`、`PrimaryNavigationRail.activateMode("explorer")` 不再展开侧栏。
- `explorerPreferences` 移除 `pinnedPaths`；`ExplorerCommandBar` 更多菜单移除“固定到快速访问”；旧 localStorage 未知字段被忽略。
- `Sidebar.test.tsx` 更新为 explorer 模式不再渲染 `explorer-sidebar-panel`。

### 3.7 图标与左上按钮（U7）

- `ExplorerCommandBar` 导航开关：`preferences.navVisible ? PanelLeftClose : PanelLeftOpen`，`data-icon="panel-left-close" / "panel-left-open"`，`aria-expanded` 与 title 保持。
- `ControlBar`：`activeSideTab === "explorer"` 时不渲染 `toggle-left-sidebar`；`onToggleSidebar` 在 explorer 模式直接返回（含 Ctrl+B 与主菜单项），不展开空面板。

## 4. 文件边界

| 范围 | 所有权 |
|---|---|
| Notepad（U1/U2/U3）：`src/components/notepad/**`、`src/stores/notepadPreferences.ts`、`src/lib/notepad/persistence/savePath.ts`、`src/lib/notepad/commands/**`（如需）、`src/stubs/**`（get_home_dir）、相关单测 | dev-notepad |
| Explorer/tab/ContextMenu（U4/U5/U6/U7）：`src/components/ContextMenu.tsx`、`src/components/explorer/**`、`src/components/tabbar/**`、`src/components/sidebar/**`、`src/layouts/main/**`（侧栏折叠）、`src/lib/explorer/openExplorer.ts`、相关单测 | dev-explorer |
| QA YAML/policy/feature-list、docs、checkpoint 提交、CI 运行 | lead |

## 5. 验证

- 单测：新增/更新上述单测；`node node_modules/vitest/vitest.mjs run <files>`；最终全量 unit。
- browser QA（本机 Windows）：新增/更新 TC-NP-007（Notepad 主题/保存默认目录/右键菜单）与 TC-EXPLORER-011（tab 对齐/空白关闭/侧栏移除/图标）；受影响既有用例 TC-NP-002/101/102、TC-EXPLORER-001/002/003/007/010、TC-FILE-OPEN-009/010 等回归。
- native QA（Windows 本机 QA 构建）：TC-NP-101/102 与新增 native 断言（真实 `$HOME` 下默认路径、真实保存）。
- GitHub `qa-ui-auto-platforms`：仅 linux/macos，browser+native，selected 用例 + crash-regression；执行中按 shard 下载报告，失败修复重跑。

## 6. 实施记录与偏差

- 分支 `fix/notepad-explorer-ux`；checkpoint：`e4a93edde`（产品 + 单测）、`b981ea872`（QA 用例与 catalog）、`87050719a`（Save As 首次渲染竞态修复）。
- 共享 ContextMenu 根节点沿用默认 `data-testid="context-menu"`（而不是设计稿里的 `notepad-context-menu` / `explorer-tab-context-menu`），以便 QA runner 的 `assert_menu_items` / `click_menu` / `hover` 直接命中；行级 testid 按设计稿保留。
- Explorer 侧栏空面板守卫落在 `src/layouts/main/sidebarToggle.ts` + `useMainLayoutState`（`toggleSidebar` 包装），未改 `appStore`；Ctrl/Cmd+B、View 菜单、标题栏按钮共用该守卫。
- “已保存文档 Save As 预填当前路径”的旧行为保持不变；只有 untitled 使用 `<lastSaveDir or $HOME>/<name>.txt`。
- macOS browser QA 首次 hosted 运行暴露一个真实竞态：`FileLifecycleDialogs` 常驻挂载、Save As 路径依赖 passive effect 从 `initialPath` 回填，导致弹窗已可见但输入框短暂为空（TC-NP-002 / TC-NP-007 在 macOS 失败）。已把 Save As 拆为按打开键值挂载的子组件（`87050719a`），并新增“常驻宿主 → 打开 saveAs 后同步断言预填值”的单测；该修复后的 hosted 复验见 §8。
- TC-WS-057 本机 Windows native 首次运行在 hover 菜单子项步骤失败一次（子菜单未展开，DOM 无 `code-workspace-tree-menu-compact`），重建最终二进制后单独重跑通过；判定为本机 native hover 时序 flake，与本次改动无调用关系（未改工作区树菜单），hosted crash-regression 继续覆盖三端。
- 本机 native 环境的既有边界：`TC-FILE-OPEN-008` 无 POSIX SSH PTY 跳过、`TC-WS-054` 需 release profile 跳过、`TC-MOBILE-013` 缺 appcache Playwright chromium 失败；由 hosted linux/macOS 覆盖。

## 7. 本地执行证据

- 单元测试：全量 `vitest run` 883 文件 / 7498 通过 / 1 跳过（`qa-ui-auto-report/_local/unit-full-ux.log`）；`tsc -b`、refactor contracts/boundaries/source-size 通过。
- 新增 browser：TC-NP-007、TC-EXPLORER-011 2/2 通过（`qa-ui-auto-report/ux-browser-new/run-20261122-163803-815050200`）。
- 受影响 browser：29/29 通过（`ux-browser-affected/run-20261122-164317-409577800`）。
- 最终源码 browser 子集（NP-001..007 + EXPLORER-011）8/8 通过（`ux-browser-final/run-20261122-171437-345518100`）。
- crash-regression browser：17 通过 / 1 跳过（`ux-browser-crash/run-20261122-165050-242528100`，TC-FILE-OPEN-008 本机无 POSIX SSH PTY）。
- 受影响 native（Windows QA debug 构建）：7/7 通过（`ux-native-affected/run-20261122-164632-799346200`）。
- 最终源码 native 子集（TC-NP-101/102/103 + TC-WS-057 复跑）：4/4 通过（`ux-native-final/run-20261122-171140-330474600`）。
- 本机 native crash-regression：18 通过 / 2 失败 / 2 跳过（`ux-native-crash/run-20261122-165345-221190200`；失败为 TC-MOBILE-013 本机环境与 TC-WS-057 hover flake，后者已复跑通过）。

## 8. GitHub `qa-ui-auto-platforms` 执行证据（linux + macOS）

主运行 [45005824556](https://github.com/engcapa/taomni/actions/runs/45005824556)，head `87050719a7be2e92af4e4ddbd789dd62e599a0d6`，scope=selected，platforms=linux,macos，modes=browser,native，selected 用例会并集 crash-regression；artifact UUID `a90654c865cd4bf398cd7c55c198f968`。浏览器用例执行过程中持续下载已完成 shard（见 `qa-ui-auto-report/hosted-ux/run-45005824556/monitor.log` 与 `qa-ui-auto-report/_local/hosted-monitor2.log`），未等待 result summary。

| 组合 | 执行 | 通过 | 失败 | 跳过 | 说明 |
|---|---:|---:|---:|---:|---|
| linux browser | 40 | 40 | 0 | 0 | 含 TC-NP-001..007、TC-EXPLORER-011 与 browser crash-regression |
| macOS browser | 40 | 39 | 1 | 0 | 唯一失败 TC-EXPLORER-002（macOS 预览窗格收起等待超时，既有已记录 flake） |
| linux native (release) | 32 | 32 | 0 | 0 | 含 TC-NP-101/102/103、TC-EXPLORER-003/010 与 native crash-regression |
| macOS native (release) | 32 | 32 | 0 | 0 | 同上 |

- 结果汇总 `qa-summary-a90654c865cd4bf398cd7c55c198f968/ci-summary.json`：`passed=false`，唯一 failure 为 TC-EXPLORER-002，`merge_eligible=true`，无基础设施/缺失报告/selected skip。
- 既有 flake 复验：定向运行 [45013282658](https://github.com/engcapa/taomni/actions/runs/45013282658)（macOS browser selected，head 同 commit，artifact UUID `fcdb7dc5f1804ec1b41762e470057f5a`）**success**，TC-EXPLORER-002 + browser crash-regression 19/19 通过（shard-1 18/18、shard-2 1/1），确认主运行失败为 macOS runner 预览收起时序 flake，与本次改动无关（本机该用例在受影响 29/29 与 crash 17/18 中均通过；历史 Explorer 文档亦记录过同签名 flake）。
- 结论：本次 7 项修复在所有选中组合上通过（144 次选中执行 + 两次 browser crash-regression 并集），唯一失败已有同 commit 复验通过；macOS native 与 linux 双端均通过真实 release QA 构建执行。
- 证据保留：`qa-ui-auto-report/hosted-ux/run-45005824556/**`（12 个 shard summary、selection、ci-summary、monitor.log）与 `run-45013282658/**`；不入库（report 目录被 gitignore），本文件记录 run/head/UUID 身份。
- 未执行边界：Windows hosted 按用户要求不跑（Windows 由本机 browser/native 覆盖）；物理 OS 键盘/AppKit 菜单/真机打印等不计入本批。

