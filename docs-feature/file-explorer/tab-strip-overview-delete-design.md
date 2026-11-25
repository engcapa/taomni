# File Explorer 标签条溢出、Overview 归档与删除确认设计

- 状态：实现完成，本地验证通过（分支 `feat/explorer-tabs-overview-delete`，基线 `main@4e19707e4`）。
  - 单元/静态：全量 Vitest 876 文件 / 7437 通过、1 跳过；`tsc -b`、`pnpm check:refactor`、QA audit/behavior contract 通过。
  - browser：`TC-EXPLORER-010` 86/86 步通过（`qa-ui-auto-report/run-20261122-101317-933835400`）；受影响 `TC-EXPLORER-001/002/003、TC-WS-018/027/093` 6/6 通过（`run-20261122-101417-465286900`）；crash-regression browser 17 通过/1 已知环境跳过（`run-20261122-101653-989404600`）。
  - native：Windows 本机 QA 构建执行 `TC-EXPLORER-010` 86/86 通过（`run-20261122-101145-964936800`，真实磁盘/回收站全树 oracle）；受影响 `TC-EXPLORER-003` 与 `TC-WS-019` 通过（`run-20261122-101832-477750700`）；crash-regression native 19 通过/2 已知环境 skip/1 本机缺 Playwright chromium 的环境失败（`run-20261122-102020-130664700`），hosted 覆盖该环境边界。
- 来源（用户 2026-11-22）：① 打开多个 Explorer 标签时标签头出现原生横向滚动条；需要像 Sessions 视图一样隐藏滚动条、用左右箭头滚动，并增加类似的过滤按钮快速过滤/查找已打开标签。② File Explorer 视图中的 Overview 不包含 Explorer 已打开标签；其它视图切到「全部」时也应包含 Explorer 标签。③ File Explorer 删除文件仍需提示「放到垃圾箱，还是直接删除」。④ 创建分支开发验证，补 unit/browser/native 用例到生产标准。
- 相关既有设计：[`../file-explorer-design.md`](../file-explorer-design.md)、[`../tab-overview-live-search-design.md`](../tab-overview-live-search-design.md)、[`implementation.md`](implementation.md)。

## 1. 现状与缺口

| 位置 | 当前行为 | 缺口 |
|---|---|---|
| `src/components/explorer/ExplorerTabStrip.tsx` | 内层 `overflow-x-auto` 直接滚动的标签条；多标签出现系统滚动条；无左右箭头、无溢出状态、无过滤入口 | 原生滚动条与产品其它标签条不一致；长标签列表只能拖滚动条，无翻页按钮；无法按名称/类别过滤 |
| `src/components/workspace/WorkspaceTabStrip.tsx` + `useWorkspaceTabScroll.ts` | 已有隐藏滚动条、左右箭头、活动标签自动可见、滚轮横滚、过滤菜单/芯片 | 逻辑已成熟，可抽出共享 hook 供 Explorer 复用 |
| `src/components/tabbar/TabOverview.tsx` | 只汇总 Sessions 标签与各工作区标签；`all` 作用域也只含这两类；非 sessions/workspaces 模式（含 explorer）默认全部 | Explorer 已打开标签完全缺席；explorer 模式打开 overview 显示的是全部会话/工作区卡片 |
| `src/components/explorer/useExplorerOperations.ts`、`ExplorerDialogs.tsx` | Del 直接进回收站（失败降级确认），Shift+Del 直接打开永久删除确认 | 普通删除没有让用户在「移到回收站 / 永久删除」之间选择；与用户要求不符 |

## 2. 验收条件

| ID | 场景 | 动作 | 必须观察到的结果 |
|---|---|---|---|
| AC-01 | Explorer 已打开多个标签且总宽度溢出 | 观察标签条；点击左右箭头；滚轮；键盘 Home/End | 标签条无原生横向滚动条；溢出时出现左右箭头，起始/末端禁用对应箭头；点击箭头按页滚动并露出被裁切的标签；活动标签切换后自动滚入视口；Home/End 仍可切换并滚到可见 |
| AC-02 | Explorer 标签溢出或需要查找标签 | 点击工具栏过滤按钮；搜索名称/路径；选择类别；点击行；清除过滤/芯片 | 弹出可搜索的已打开标签菜单，含全部/文件夹/文件类别与计数；搜索即时过滤；点击行激活对应 Explorer 标签；标签条只显示匹配标签但不关闭任何标签；出现可清除的过滤芯片；活动标签被过滤时自动选首个匹配；新开标签不会被隐藏；Esc/外点关闭并把焦点还给触发按钮；IME 组合输入不触发快捷键 |
| AC-03 | Explorer 视图 | 打开 Overview | 默认 `data-scope="explorer"`，仅显示 Explorer 已打开标签（含文件查看器标签），卡片展示类别、标题、路径/条目信息；可切「当前视图/全部」，全部包含 Sessions、Workspaces 与 Explorer；点击 Explorer 卡片回到 Explorer 视图并激活该标签；搜索可匹配标题/路径；无标签/无匹配有明确提示 |
| AC-04 | 其它视图 | Overview 切「全部」 | 关闭再打开 Overview 时按当前视图重置作用域；全部模式仍包含原有 Sessions/Workspace 卡片且新增 Explorer 卡片，原有点击激活与侧栏折叠偏好不变 |
| AC-05 | Explorer 中选中文件/文件夹 | Del；Shift+Del；取消 | Del 先打开确认框，明确提供「移到回收站」与「永久删除」两个选择；取消不触碰磁盘；选择回收站成功后出现带撤销的提示；Shift+Del 打开同一确认框且默认聚焦永久删除；回收站失败时保留失败项并显示原因，只提供永久删除确认 |
| AC-06 | 既有路径回归 | 右键/命令栏删除、Sessions/Workspace 标签条与 Overview、Explorer 标签关闭/固定/中键 | 行为不退化；删除入口均走同一确认框；Sessions/Workspace 标签条与 Overview 原有断言继续通过 |

## 3. 设计

### 3.1 共享标签条滚动

- 新增 `src/components/tabbar/tabs/useTabStripScroll.ts`：以 `scopeKey`、`tabs: readonly {id}[]`、`activeTabId` 为输入，拥有滚动元素 ref、标签元素注册、溢出/首尾状态、活动标签自动滚入视口（用户主动滚动后不抢回）、按页滚动并优先露出被裁切标签、`markUserScroll`。
- `useWorkspaceTabScroll.ts` 改为该 hook 的薄封装，保持既有返回契约，Sessions/Workspace 行为不变。
- `ExplorerTabStrip` 使用同一 hook：
  - 外层 `relative flex overflow-hidden`，滚动区使用隐藏滚动条类（新增 `.taomni-explorer-tab-scroll` 于全局 `platform.css`），保留 `role="tablist"` / `data-testid="explorer-tab-scroll-area"`。
  - 左右箭头复用 `IconBtn`，testid：`explorer-tab-scroll-left` / `explorer-tab-scroll-right`，仅在溢出时渲染，首/尾禁用。
  - 滚轮纵向增量转横向滚动；箭头滚动视为用户滚动。

### 3.2 Explorer 标签过滤

- 纯函数 `src/lib/explorerTabFilter.ts`：`ExplorerTabFilter { category: "all"|"folders"|"files"; query }`、`explorerTabCategory(tab)`、`filterExplorerTabs(tabs, filter)`、`hasExplorerTabFilter(filter)`；查询不区分大小写，匹配标题、`fileBrowser.initialPath`、`fileViewer.path`、`sessionId` 对应标签标题；类别由标签类型决定（`file-browser`→folders，`file-viewer`→files）。
- UI 状态 `src/stores/explorerUiStore.ts`：`tabFilter`、`setTabFilter`、`clearTabFilter`（不持久化，关闭应用即重置；过滤不关闭任何标签/runtime）。
- `src/components/explorer/ExplorerTabsFilter.tsx`：工具栏过滤触发按钮（`explorer-tabs-filter-trigger`，active 表示有过滤），弹层包含搜索框、类别按钮（`explorer-tab-filter-<category>`，带计数）、可见/总数、已打开标签行（`explorer-tabs-filter-row`），支持上下键/Enter、Esc、外点关闭、IME 保护、空结果提示；应用过滤时若当前活动标签不在结果内，激活首个匹配。
- `ControlBar` 在 `activeSideTab === "explorer"` 时于 `PlatformToolbarActions` 中渲染该过滤组件（与 Sessions `tab-more`、Workspace 过滤器同位置）。
- `ExplorerTabStrip` 渲染 `filterExplorerTabs` 后的标签；有过滤时显示芯片 `explorer-tab-filter-chip`（点击清除）与空提示 `explorer-tab-filter-empty`；活动标签变化且因过滤不可见时清除过滤（新开标签可见）。

### 3.3 Overview 纳入 Explorer

- `PreviewItem` 增加可选 `surface: "sessions" | "workspaces" | "explorer"`；保留 `workspaceId` 以兼容既有 `data-workspace-id` 断言。
- `TabOverview`：
  - 作用域：`sessions` / `workspaces` / `explorer` 为「当前视图」，Home/Tools 等默认全部；`explorer` 也显示「当前视图/全部」切换。
  - Explorer 卡片来源 `useExplorerStore.tabs`：标题、类别 `EXPL`/`VIEW`、分组「文件资源管理器/File Explorer」、端点=当前目录路径（优先 `sftpStore.sessions[id].local.path`，退回 `fileBrowser.initialPath`/`fileViewer.path`）、摘要=路径 + 条目数（查看器使用文档文本摘要）；活动态取 Explorer store。
  - `all` 包含 Sessions、Workspaces、Explorer 三类；激活 Explorer 卡片调用 `explorerStore.setActiveTab` 并 `setActiveSideTab("explorer")`，保留侧栏折叠偏好；原 Sessions/Workspace 激活路径不变。
  - `data-scope` 新增 `explorer`；`overviewAll` 文案更新为包含文件浏览器。

### 3.4 删除确认

- `useExplorerOperations`：
  - `DeletePrompt { entries; reason?; defaultIntent: "trash"|"permanent" }`。
  - `remove(entries, permanent?)` 只打开确认框（`defaultIntent` 由是否 Shift 决定），不直接调用后端。
  - 新增 `trash(entries)`：执行 `localTrashEntries`；成功刷新并给出带撤销的提示；部分/全部失败对失败项保留确认框并带原因，只允许永久删除。
  - 保留 `permanentDelete(entries)` 作为确认后的永久删除路径。
- `ExplorerDialogs`：标题「删除 …?」，正文说明回收站可恢复、永久删除不可撤销；主按钮「移到回收站」（回收站不可用时隐藏）、危险按钮「永久删除」；取消/Esc 不变。testid：`explorer-delete-dialog`、`explorer-delete-cancel`、`explorer-delete-trash`、`explorer-delete-confirm`、`explorer-trash-unavailable`。Shift+Del 打开时聚焦永久删除按钮。
- 右键菜单与命令栏文案改为「删除…/Delete…」；键盘 Del/Shift+Del、命令栏、右键菜单共用该确认框。

## 4. 改动清单

| 文件 | 变更 |
|---|---|
| `src/components/tabbar/tabs/useTabStripScroll.ts`（新增） | 通用标签条滚动所有权 |
| `src/components/workspace/useWorkspaceTabScroll.ts` | 委托共享 hook，保持导出契约 |
| `src/components/explorer/ExplorerTabStrip.tsx` | 隐藏滚动条、箭头、滚轮、过滤集成、可见标签 |
| `src/styles/platform.css` | Explorer 标签条隐藏滚动条、箭头布局最小样式 |
| `src/lib/explorerTabFilter.ts`（新增） | 过滤纯函数与类别 |
| `src/stores/explorerUiStore.ts`（新增） | 过滤 UI 状态 |
| `src/components/explorer/ExplorerTabsFilter.tsx`（新增） | 过滤按钮与弹层 |
| `src/components/tabbar/ControlBar.tsx` | Explorer 模式渲染过滤入口 |
| `src/components/tabbar/TabOverview.tsx`、`overview/overviewModel.ts` | Explorer 卡片、作用域、激活、搜索 |
| `src/lib/i18n/locales/{en,zh-CN}.ts` | 全部作用域文案包含文件浏览器 |
| `src/components/explorer/useExplorerOperations.ts`、`ExplorerDialogs.tsx`、`explorerContextMenus.tsx`、`ExplorerCommandBar.tsx` | 删除确认两种选择与降级 |
| `src-tauri` | 无 Rust 变更（回收站/永久删除命令已存在） |
| 单测 | 新增 `useTabStripScroll`/`ExplorerTabStrip`/`explorerTabFilter`/`ExplorerTabsFilter` 测试；更新 `TabOverview`、`useExplorerOperations`、`ExplorerShell.actions`、`ControlBar` |
| QA | 新增 Explorer 标签条/过滤/Overview/删除确认 browser+native 用例；更新 TC-EXPLORER-002/003 删除步骤 |

## 5. 验证计划

| V | 层级 | 断言 |
|---|---|---|
| V-01 | Vitest | 过滤纯函数类别/查询/计数/空过滤；滚动 hook 溢出、首尾、翻页、活动标签可见、用户滚动；ExplorerTabStrip 箭头显示/禁用/滚动、过滤芯片/空提示、关闭/固定/中键不退化 |
| V-02 | Vitest | Overview explorer 作用域、全部包含三类、激活切换、搜索、空/无匹配；原 Sessions/Workspace overview 断言保持 |
| V-03 | Vitest | 删除流程：Del 打开确认框且未触盘；回收站成功/撤销/部分失败降级；Shift+Del 聚焦永久删除；取消/Esc 不触盘；命令栏/右键同路径 |
| V-04 | 静态 | `pnpm exec tsc -b`、`pnpm check:refactor`、聚焦 Vitest：通过（全量 Vitest 876 文件 / 7437 通过 / 1 跳过） |
| V-05 | browser QA | Windows 本地运行：多 Explorer 标签箭头/无滚动条/过滤菜单；Overview explorer/全部；删除确认两选项与取消；`assert_no_runtime_errors`。通过：`TC-EXPLORER-010`（86 步，browser），受影响 002/003 通过 |
| V-06 | native QA | Windows 本地 QA 构建：真实标签条/Overview 切换与真实回收站/永久删除确认（浏览器 stub 不能替代原生删除语义）。Windows 本机 native 运行 `TC-EXPLORER-010`：全树 `assert_explorer_files` 校验真实磁盘删除/撤销/永久删除 |

## 6. 风险与边界

- Overview 订阅 `sftpStore.sessions` 会随目录/选择更新重渲染，仅 Overview 打开期间存在，规模有限；不新增轮询。
- 过滤只影响显示，不关闭标签或会话；清空过滤/激活隐藏标签必须有确定路径。
- 删除确认增加一步交互：Shift+Del 仍然二次确认，普通 Del 从「一步进回收站」改为「一步选择 + 一步确认」，需要同步更新既有用例与文档，不保留静默删除路径。
- 既有 Sessions/Workspace 标签条通过共享 hook 重构，必须由原有用例与新增 hook 单测共同保护；不改变它们的 testid/DOM 契约。
- native 删除真实行为依赖 Windows 回收站；browser 仅证明 UI 与 stub 契约。
