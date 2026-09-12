# 数据库查询 Tab 自定义重命名 详细设计

## 1. 设计摘要与范围

- 类型：新功能（现有能力扩展）
- 文档位置：`docs-feature/db-query-tab-rename-design.md`
- 设计状态：已实现；Windows 当前端真机验证通过（2026-09-12），macOS/Linux 未验证
- 来源：GitHub issue engcapa/taomni#559（Feature Request，优先级中，2026-09-10，issue 正文可访问；附图是私有签名 URL，本次无法核实图片内容，仅采用正文描述与用户消息）、用户会话给出的 MariaDB 测试连接
- 调研基线：commit `0566cc24`（实现改动见 `git status`），2026-09-12
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 2 桌面应用；方案与代码必须兼容三端构建与运行
- 本轮真机执行端：Windows（当前环境 `win32`），使用用户提供的 MariaDB 实例；macOS/Linux 保留计划并标未验证
- 推荐方案：在 SQL 查询窗口（`DbClientTab`）的内层 query 面板上，复用外层应用 Tab 已验证的「双击标题 / 右键 Rename tab + 内联输入」交互；在 `PanelState` 增加 `displayName`，随查询工作区持久化到 `sql_query_workspace_tabs.display_name`；`sql_history` 增加 `panel_id`/`tab_name` 两列，执行时写入快照，重命名后按 session+panel 回溯更新既有历史条目，History 面板显示名称标签

用户问题是：长期保留多条不同用途 SQL 时，Tab 标题只有递增的 `Query N`（issue 附图已到 Query 16），无法从名称识别业务内容，找回查询只能逐个点开猜测。完成后，用户可自定义 Tab 名称，刷新/重启后名称保留，历史查询记录也按名称展示，重命名不影响 SQL 内容、执行结果、已保存查询、文件与历史元数据。

**本期范围（in scope）**

- `DbClientTab`（全部 SQL 引擎：MySQL/MariaDB/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto）内层 query 面板的自定义重命名
- 重命名入口与内联编辑、名称显示优先级、空名清除、dirty 标记保持
- 名称随查询工作区持久化（SQLite + 浏览器 stub），刷新/重启恢复
- History 面板逐条展示所属 Tab 名称；重命名回溯更新；新执行记录写入名称快照

**本期不做（out of scope）**

- HBase Shell（`HBaseShellTab`）内层 Query 面板重命名：同样存在 `Query N` 问题，但该组件没有 workspace 持久化通道，需要独立存储设计，用户已确认后续单独立项
- Redis 客户端（单编辑器，无多 query 面板）
- 外层应用 Tab 重命名：已实现（`src/components/tabbar/TabBar.tsx`），不改动
- Query Library 已保存查询的重命名/重新关联：沿用现有能力，重命名只改显示名
- 历史记录按名称搜索/过滤控件：需求原文只要求「展示该自定义名称，便于检索」，本次以可见名称标签满足；新增搜索框另立需求
- 历史 `+Tab`/库打开时继承历史条目名称：不在本期
- 关闭 Tab 的重开 UI（`db_reopen_query_workspace_tab` 已有实现但未接线）：不涉及

## 2. 当前实现与功能缺口

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/database/DbClientTab.tsx:200` `PanelState` | 面板有 `id/doc/sheets/activeSheetId/filePath/fileName/savedQuery/dirty/createdAt`，无自定义名称字段 | 新增 `displayName: string \| null` | 源码 |
| `src/components/database/DbClientTab.tsx:2609` | 标签按 `p.fileName ?? p.savedQuery?.name ?? \`Query ${i+1}\`` 派生，`:2623` 追加 `*` | 前缀自定义名；渲染内联编辑态 | 源码 |
| `src/components/database/DbClientTab.tsx:1723` `openPanelMenu` | 右键菜单含 AI/运行/格式化/保存/新建/关闭，无重命名 | 首项新增 Rename tab | 源码 |
| `src/components/database/DbClientTab.tsx:697-805` | 启动时 `dbLoadQueryWorkspace` 重建面板（content/filePath/fileName/savedQueryId/dirty/createdAt） | 增加读取 `displayName` | 源码 |
| `src/components/database/DbClientTab.tsx:840` `persistWorkspaceSnapshot`、`:473` `workspaceTabFromPanel` | 自动保存（1s debounce + 5s 间隔 + 卸载 flush）写入 workspace tab；`tabs` 不含名称 | 快照包含 `displayName` | 源码 |
| `src-tauri/src/database/query_workspace.rs:11-106` | `DbQueryWorkspaceTab` 无名称字段；表 `sql_query_workspace_tabs` 无 `display_name`；已有 `PRAGMA table_info` + `ALTER TABLE` 迁移先例（`saved_query_id`，`:92-104`） | 新增 `display_name` 列、结构字段与 upsert | 源码 |
| `src-tauri/src/database/history.rs:9-75` | `DbHistoryEntry` 无 Tab 关联；`sql_history` 无 `panel_id`/`tab_name`；`INSERT OR REPLACE` 16 列 | 新增两列、迁移、更新函数与新命令 | 源码 |
| `src/components/database/DbClientTab.tsx:1130` `appendSqlHistory` / `:1212` 调用点 | 历史条目只记录 SQL 与执行结果元数据，不知道来自哪个面板 | 写入 `panelId` + 当前 `tabName` | 源码 |
| `src/components/database/DbClientTab.tsx:3020` `HistoryDropdown` | 条目渲染时间/耗时/行数/SQL 摘要/错误与操作按钮，无名称 | 名称 chip 展示 | 源码 |
| `src/lib/ipc.ts:1419,1464,1497` | `DbSqlHistoryEntry`/`DbQueryWorkspaceTab`/保存函数无名称与更新命令 | 扩展类型并新增 `dbUpdateHistoryTabName` | 源码 |
| `src/stubs/tauri-core.ts:206-245,3736-3803` | 浏览器 stub 用 localStorage 模拟历史与工作区；键 `taomni.stub.dbSqlHistory.v1`、`taomni.stub.dbQueryWorkspaces.v1` | 同步 stub 类型与新命令 | 源码 |
| `src/components/tabbar/TabBar.tsx:312-333,890-920` | 外层 Tab 已有「双击 / 右键 Rename + 内联 input，Enter 提交、Esc 取消、失焦提交、全选」完整实现与样式 | 直接复用的交互先例 | 源码，已实测现有功能 |
| `src/components/database/HBaseShellTab.tsx:1201-1232` | HBase 面板同样显示 `savedQuery?.name ?? Query N`，无右键/双击，无 workspace 持久化 | 明确不做，保持现状 | 源码 |
| `src/components/database/DbClientTab.test.tsx:9-102` | Vitest 通过 `vi.mock("../../lib/ipc")` 注入 IPC 假实现 | 新增 mock 与用例 | 源码 |
| `qa-ui-auto-tests/feature-list.md:3827-4042`（F-DB-1） | 已登记 sql-editor/query-result-grid/query-history-* 等控件；query tab 与历史名称 chip 尚无 testid 与控件条目 | 补充控件与覆盖 | 文档 |

调用链现状：`MainLayout.openDbTab`（`src/layouts/MainLayout.tsx:1866`）用 `session.id` 作为 `workspaceSessionId`（`:598/630`）打开 `DbClientTab`；面板状态是组件内 `useState`，按 `workspaceSessionId` 经 `dbLoadQueryWorkspace`/`dbSaveQueryWorkspace` 持久化到 `taomni.db` 的 `sql_query_workspace_tabs`；历史经 `dbAppendHistory` 写入 `sql_history`，History 面板按 `{ savedSessionId, engine }` 读取。本次全部在既有链路上扩展，不新增存储介质。

## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | SQL 查询窗口已打开（连接成功或连接失败均可，面板存在） | 双击某个 query tab 标题 | 该 tab 进入内联编辑：出现输入框、文本全选、tab 保持激活；编辑态不触发 tab 切换或关闭 | 三端一致 |
| AC-02 | 同上 | 右键某个 query tab | 菜单第一项为 `Rename tab`（i18n `tabs.rename`），带铅笔图标；点击进入与 AC-01 相同的编辑态；其余菜单项顺序与行为不变 | 三端一致 |
| AC-03 | 处于编辑态 | Enter / 失焦提交；Esc 或点外部取消；输入空白或与当前派生标题相同 | 提交：名称立即生效；空白或等于派生标题 → 清除自定义名并回落派生标题；最长 120 字符、换行折叠为空格、允许重名；IME 组合输入中按 Enter 不提交 | 三端一致，中文 IME 重点 |
| AC-04 | 已有自定义名，或 tab 关联 `.sql` 文件 / Query Library 查询 | 观察标题 | 显示优先级 `displayName > fileName > savedQuery.name > Query N`；`dirty` 时仍追加 `*`；tooltip（文件路径）行为不变 | 三端一致 |
| AC-05 | 已完成一次重命名 | 等待 ≥1s 自动保存；刷新页面；重启应用并重新打开同一会话 | 名称写入 workspace tab；刷新/重启后标题仍为自定义名，不重置为 `Query N` | 三端一致；桌面持久化验证 SQLite，浏览器辅助验证 stub |
| AC-06 | 旧版本数据库或旧工作区行（无 `display_name`），或连续两次启动 | 启动应用加载工作区 | 缺少名称的行加载为 `null`，显示派生标题；`ALTER TABLE` 迁移幂等，不丢数据、不报错；旧版本回退读取时不因新列失败 | 三端一致 |
| AC-07 | 某 Tab 已执行过 SQL，History 面板存在对应记录 | 打开 History 面板 | 每条记录在 SQL 摘要旁显示执行时 Tab 的自定义名（chip）；升级前或未命名 Tab 的旧记录不显示 chip，不报错 | 三端一致 |
| AC-08 | 某 Tab 已有历史记录，其中部分记录带有旧名称 | 重命名该 Tab（或清空名称） | 同一 session+panel 的既有历史条目名称同步更新（清空后 chip 消失）；历史 SQL、时间、耗时、行数、错误字段不变 | 三端一致 |
| AC-09 | 某 Tab 有自定义名 | 执行新 SQL | 新历史条目写入该 `panelId` 与执行时 `tabName` 快照；随后重命名仍能回溯更新（AC-08） | 三端一致 |
| AC-10 | 任意状态 | 重命名、清除名称、切换/关闭其他 Tab、执行查询 | SQL 内容、执行结果、已保存查询（名称/revision）、`.sql` 文件、历史 SQL 与统计均不变化；既有查询工作区恢复、历史增删清、Query Library 行为回归通过 | 三端一致 |
| AC-11 | 三端代码与当前端运行 | 静态兼容审查 + Windows 真机 | 无平台特有分支、依赖、路径与权限差异；Windows 真机完成「重命名 → 执行 → History 显示 → 重启恢复」链路；macOS/Linux 记录未验证与后续步骤，不阻塞本轮 | Windows 执行；macOS/Linux 计划 |

## 4. 方案与关键决策

### 4.1 交互与状态

复用外层 Tab 重命名的既有形态（`TabBar.tsx:312-333, 895-920`）：

- 入口 1：双击 tab 标题（`onDoubleClick`，`stopPropagation` 防止激活/关闭副作用）
- 入口 2：右键菜单首项 `Rename tab`（`openPanelMenu` 的 `items` 首项，`testId: "db-context-rename-tab"`，图标 `Pencil`，标签 `t("tabs.rename")`）
- 编辑态：该 tab 从 `<button>` 切换为 `<input data-testid="db-query-tab-input">`（避免 input 嵌套在 button 内造成非法 DOM），`autoFocus`、`onFocus` 全选；点击/按下/双击输入框时 `stopPropagation`
- 提交：Enter、失焦；取消：Esc（取消后触发失焦也提交的问题用 `panelRenameCancelRef` 守卫）；`e.nativeEvent.isComposing` 为 true 时不处理 Enter/Esc，避免中文/日文 IME 组合被打断
- 名称规范化：换行折叠为空格、`trim`、长度上限 120（`maxLength` + 提交时 `slice`）；空串或等于当前派生标题 ⇒ `displayName = null`，否则写入
- 允许重名（名称仅用于显示）；不做唯一性校验

新增组件内状态：`editingPanelId: string | null`、`panelDraftTitle: string`、`panelRenameCancelRef: boolean`。

### 4.2 数据与持久化

- 权威状态：`PanelState.displayName`（组件内 `useState`），派生标题由它和 `fileName/savedQuery/index` 计算
- 持久化：随既有 `persistWorkspaceSnapshot` 写入 `DbQueryWorkspaceTab.displayName`，落库 `sql_query_workspace_tabs.display_name TEXT`；重命名后调用 `scheduleWorkspaceSave()`（1s debounce），5s 间隔与卸载 flush 兜底
- 恢复：`dbLoadQueryWorkspace` 返回 `displayName`，重建 `PanelState`；旧行 `NULL` ⇒ `null`
- 历史关联：`sql_history` 新增 `panel_id TEXT`、`tab_name TEXT`；`appendSqlHistory` 写入当前面板 `displayName` 快照；重命名后调用新命令 `db_update_history_tab_name(savedSessionId, panelId, tabName)` 按 session+panel 更新既有条目，并就地更新已加载的 `historyEntries` state

### 4.3 关键决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 重命名入口与编辑态 | A 双击+右键+内联编辑（与现有外层 Tab 一致，改动小、一致性好）；B 仅右键+内联（发现性差）；C 双击+右键+弹窗（多一步、与外层不一致） | 采用 A：issue 明确期望「双击或右键」，外层 `TabBar` 已有同款实现可复用；右键项置于菜单首项（已随选项展示在原型 v1） | 用户已定 | 用户答复 2026-09-12（问题 1 选推荐项 A）；原型 `docs-feature/db-query-tab-rename/prototype-v1.drawio` | AC-01、AC-02、AC-03、TASK-01、V-01 |
| DEC-02 名称显示优先级 | A 自定义名最优先（重命名总立即生效，清除后回落）；B 已保存查询名优先（库内改名义覆盖用户命名）；C 文件名优先（保存文件后覆盖用户命名） | 采用 A：`displayName > fileName > savedQuery.name > Query N`；只改显示名，不改库内查询名或文件；自定义名等于派生名时视为清除，避免误冻结默认名 | 用户已定 | 用户答复 2026-09-12（问题 2 选推荐项 A） | AC-04、TASK-01、V-01 |
| DEC-03 History 展示与回溯 | A 新增 `panel_id`+`tab_name`，执行时快照并重命名回溯更新（完全满足检索）；B 仅快照不回填（旧记录无名称）；C 不改表（不满足需求） | 采用 A：`sql_history` 迁移加两列 + 新命令；回溯按 `saved_session_id + panel_id`，旧记录无名称时仅显示 SQL | 用户已定 | 用户答复 2026-09-12（问题 3 选推荐项 A） | AC-07、AC-08、AC-09、TASK-03、V-03、V-05 |
| DEC-04 覆盖范围 | A 仅 SQL 查询窗口；B 同时覆盖 HBase Shell 面板（无 workspace 持久化，需新增存储通道，成本高） | 采用 A：复用现有 workspace 持久化完整交付；HBase 后续单独立项 | 用户已定 | 用户答复 2026-09-12（问题 4 选推荐项 A） | AC-11、TASK-01、TASK-02 |
| DEC-05 名称存储位置 | A（采用）随 workspace tab 增加 `display_name` 列；B 新建名称表；C 写入 Query Library | A：与查询工作区同生命周期、同一次保存事务，迁移沿用现有 `PRAGMA+ALTER TABLE` 先例；B/C 引入额外生命周期与冲突 | agent 自决 | 代码依据：`query_workspace.rs:92-104` 迁移先例；`persistWorkspaceSnapshot` 单事务保存 | AC-05、AC-06、TASK-02、V-04 |
| DEC-06 重命名菜单项位置 | A 菜单首项；B 放在关闭分组后（仿外层 TabBar） | 首项：DB 右键菜单较长（15 项），首项触达成本最低；已随 DEC-01 原型展示 | 用户已定（含于 DEC-01 选项描述） | 用户答复 2026-09-12；原型 v1 面板 C | AC-02、TASK-01、V-01 |
| DEC-07 空名/长度/重名策略 | A 空名或等于派生名 ⇒ 清除；trim、换行折叠、上限 120、允许重名；B 空名报错；C 唯一性校验 | A：与「清除自定义名」直觉一致，避免重名阻塞；TAB 标签本身有 `max-w-[190px] truncate`，120 字符足够 | agent 自决 | 代码依据：`TabBar` 提交仅 `trim` 非空；`DbClientTab.tsx:2614` 截断样式 | AC-03、TASK-01、V-01 |
| DEC-08 历史名称派生方式 | A（采用）执行时快照 + 重命名回溯；B 渲染时按 panelId 现查当前名称 | A：实现简单、历史页面无需跨模块 join，且历史条目独立可读；B 需要 History 加载时联查面板状态，跨窗口/已关闭面板时不可得 | agent 自决 | 代码依据：`HistoryDropdown` 只接收 `entries`；`dbListHistory` 为纯后端查询 | AC-07、AC-08、TASK-03、V-03 |

### 4.4 用户流程与交互

| 当前状态 | 动作或事件 | 前置条件 | 下一状态与可见反馈 | 失败 / 取消处理 |
|---|---|---|---|---|
| 浏览（非编辑） | 双击 tab 标题 | 面板存在 | 进入编辑：输入框替换标题、文本全选、面板激活 | — |
| 浏览（非编辑） | 右键 tab → 点 `Rename tab` | 面板存在 | 同双击，菜单关闭 | — |
| 编辑 | 输入文本 | — | 输入框实时显示 | — |
| 编辑 | Enter / 失焦 | 非 IME 组合中 | 提交：标题更新（空/等于派生名则回落），`*` 标记按 dirty 保留，触发自动保存与历史名称更新 | 保存失败：状态栏 `Query auto-save failed: …`，内存名称保留，5s 间隔重试 |
| 编辑 | Esc / 点击外部 | — | 取消：恢复原标题，不保存、不更新历史 | 取消后触发的 blur 不提交（ref 守卫） |
| 编辑 | IME 组合中按 Enter | `isComposing` | 不提交、不取消，交给输入法 | — |
| 已重命名 | 打开 History | 有历史条目 | 同 panel 条目显示名称 chip；重命名后已打开的面板即时刷新 | `dbUpdateHistoryTabName` 失败：状态栏提示，名称仍随 workspace 保存 |
| 已重命名 | 刷新 / 重启并重开会话 | 自动保存已执行 | 标题恢复自定义名；历史 chip 恢复 | 工作区恢复失败沿用现有状态栏错误路径 |

### 4.5 原型与示意图

- 当前有效图稿：`docs-feature/db-query-tab-rename/prototype-v1.drawio`（1500×1130 画布，含 A 现状 / B 双击内联编辑 / C 右键菜单 / D History 展示 / E 状态流）；可直接查看的导出预览 `docs-feature/db-query-tab-rename/prototype-v1.drawio.png`（含嵌入 XML，可回编辑）
- 图稿决策：DEC-01、DEC-06。2026-09-12 向用户展示 v1 并针对 4 个决策提问，用户选择推荐方案 A（双击+右键+内联、自定义名最优先、历史回溯、仅 SQL 窗口），未提出图稿修改意见
- 修订结果：v1 即当前有效版本，无需修订；若实现阶段 UI 反馈出现实质变化（如菜单位置、编辑态样式），回写本节并按需产出 v2，保留 v1 与反馈记录
- 边界说明：原型只表达结构与状态，未验证像素、暗色主题对比度、长名称截断效果；这些在实现后用真实 WebView 截图验收，原型评审不等同于 UI 或真机测试通过

### 4.6 数据流、状态与生命周期

- 创建/持有：`PanelState.displayName` 由 `DbClientTab` 持有；`newPanel()` 默认 `null`；恢复路径由 `dbLoadQueryWorkspace` 注入
- 写入时机：重命名提交后 `patchPanel` → `scheduleWorkspaceSave()`（1s debounce）→ `persistWorkspaceSnapshot` 组装全部 tabs → `dbSaveQueryWorkspace` 单事务 upsert；5s 间隔与组件卸载 flush 兜底；关闭单个/其他/全部面板前都会先 `persistWorkspaceSnapshot`（`DbClientTab.tsx:1635,1655,1676`）
- 历史更新时机：提交后立即 `dbUpdateHistoryTabName`（异步，不阻塞 UI），并同步更新已加载的 `historyEntries`
- 释放：面板关闭时 `cleanupClosedPanels` 清理编辑器句柄与 refs；名称随 closed 行保留 30 天（`CLOSED_TAB_RETENTION_MS`），本期无重开入口
- 并发/重试：rename 是幂等 `UPDATE`；`autoSaveInFlightRef` 单飞避免并发保存；历史更新失败不回滚名称，仅提示
- 兼容：不需要数据迁移脚本；两处 `ALTER TABLE ADD COLUMN` 在启动建表时按 `PRAGMA table_info` 幂等执行

### 4.7 接口与共享契约

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `PanelState.displayName: string \| null`（新增字段） | `DbClientTab` 内部 | 组件状态，不序列化 | 标题计算输入 | 初始值 `null`；不破坏现有面板字段 |
| `DbQueryWorkspaceTab.displayName?: string \| null`（TS 扩展 `src/lib/ipc.ts:1464`） | `DbClientTab` → `dbSaveQueryWorkspace` | camelCase `displayName`，可空 | 随 `DbQueryWorkspace.tabs` 返回 | 旧后端/旧 stub 缺字段时按 `null` 处理 |
| Rust `DbQueryWorkspaceTab.display_name: Option<String>`（`query_workspace.rs:13` 扩展） | `db_save_query_workspace` → `sql_query_workspace_tabs.display_name` | `ALTER TABLE … ADD COLUMN display_name TEXT`（幂等） | `load_query_workspace` 原样返回 | 旧库自动加列；旧版本 SELECT 显式列名，忽略新列 |
| `DbSqlHistoryEntry.panelId?/tabName?: string \| null`（TS 扩展 `src/lib/ipc.ts:1419`） | `DbClientTab` → `dbAppendHistory`；`dbListHistory` → History UI | camelCase `panelId`/`tabName`，可空 | 列表返回同字段 | 旧记录为 `null`，UI 不显示 chip |
| Rust `DbHistoryEntry.panel_id/tab_name: Option<String>`（`history.rs:9` 扩展） | `db_append_history` / `db_list_history` | `ALTER TABLE sql_history ADD COLUMN panel_id TEXT`、`tab_name TEXT`（幂等） | 同上 | 同上 |
| `dbUpdateHistoryTabName(savedSessionId, panelId, tabName)`（新增 IPC，`src/lib/ipc.ts`） | `DbClientTab` 重命名提交 → `db_update_history_tab_name` | `{ savedSessionId: string, panelId: string, tabName: string \| null }` | `Promise<number>` 更新行数；错误字符串 | 新命令，无既有调用者 |
| Rust `db_update_history_tab_name`（新增命令，`history.rs`） | `lib.rs` `invoke_handler` 注册 | `saved_session_id: String`、`panel_id: String`、`tab_name: Option<String>` | `Result<i64, String>` 行数 | 无既有契约 |
| 纯函数 `update_history_tab_name(conn, saved_session_id, panel_id, tab_name) -> SqlResult<usize>`（新增） | 命令与单元测试 | 同上 | 行数；无匹配行返回 0 | 无 |
| `t("tabs.rename")`（现有 i18n key，`en.ts:805`） | 菜单项与输入框 `aria-label` | — | 英文 `Rename tab`，中文已本地化 | 不新增 locale key |

关键类型签名（拟新增/扩展）：

```ts
// src/components/database/DbClientTab.tsx
interface PanelState {
  id: string;
  doc: string;
  sheets: ResultSheet[];
  activeSheetId: string | null;
  filePath: string | null;
  fileName: string | null;
  savedQuery: DbSavedQuery | null;
  displayName: string | null; // 新增
  dirty: boolean;
  createdAt: number;
}
```

```ts
// src/lib/ipc.ts
export interface DbQueryWorkspaceTab {
  // …既有字段…
  displayName?: string | null;
}
export interface DbSqlHistoryEntry {
  // …既有字段…
  panelId?: string | null;
  tabName?: string | null;
}
export async function dbUpdateHistoryTabName(
  savedSessionId: string,
  panelId: string,
  tabName: string | null,
): Promise<number>;
```

```rust
// src-tauri/src/database/query_workspace.rs
pub struct DbQueryWorkspaceTab { /* …既有字段… */ pub display_name: Option<String> }

// src-tauri/src/database/history.rs
pub struct DbHistoryEntry { /* …既有字段… */ pub panel_id: Option<String>, pub tab_name: Option<String> }
pub fn update_history_tab_name(conn: &Connection, saved_session_id: &str, panel_id: &str, tab_name: Option<&str>) -> SqlResult<usize>;
#[tauri::command] pub async fn db_update_history_tab_name(saved_session_id: String, panel_id: String, tab_name: Option<String>, state: State<'_, AppState>) -> Result<i64, String>;
```

### 4.8 三端兼容与相关存储、故障边界

- 三端无平台特有代码：键盘事件（Enter/Esc/blur）+ IME `isComposing` + web 标准输入；SQLite `ALTER TABLE ADD COLUMN` 由 rusqlite 统一执行；无路径、权限、系统 API 差异
- 平台适配：`pnpm tauri dev` 在 Windows/WebView2、macOS/WKWebView、Linux/WebKitGTK 均渲染同一 React 组件；macOS 无 Tauri WebDriver，真机验证采用手工步骤（见第 8 节）
- 存储迁移：启动时 `init_query_workspace_tables`/`init_history_tables` 按列存在性迁移；迁移失败会使启动初始化报错（沿用现有行为），因此新增列必须保持幂等；无破坏性删除
- 回退边界：应用降级到旧版本时，旧代码 SELECT 显式列名、不读取新列，INSERT 不写新列，数据仍可用；`display_name`/`tab_name` 仅新增可空列，无需数据回退脚本
- 浏览器 stub：`src/stubs/tauri-core.ts` 增加 `db_update_history_tab_name` 分支、在 `StubDbQueryWorkspaceTab`/`StubDbSqlHistoryEntry` 增加对应字段；`db_save_query_workspace` 的 spread 已自动保留 `displayName`；stub 仅辅助渲染与持久化路径测试，真实 SQLite 与重启行为必须原生验证
- 故障边界：`dbUpdateHistoryTabName` 失败不影响重命名与工作区保存；workspace 保存失败沿用 `Query auto-save failed` 提示与 5s 重试；重命名过程中关闭面板时，`closePanel` 先持久化快照再关闭，名称不丢

## 5. 改动清单

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/components/database/DbClientTab.tsx` | `PanelState.displayName`（新增）+ `newPanel` 默认；恢复 effect 注入 `entry.displayName ?? null`；`workspaceTabFromPanel` 输出 `displayName`；标题改为 `p.displayName ?? p.fileName ?? p.savedQuery?.name ?? \`Query ${i+1}\``；新增 `editingPanelId`/`panelDraftTitle`/`panelRenameCancelRef` 与 `startPanelRename`/`commitPanelRename`/`cancelPanelRename`；tab 渲染支持编辑态、`onDoubleClick`、`data-testid="db-query-tab"`/`db-query-tab-input`；`openPanelMenu` 首项 `Rename tab`（`testId: "db-context-rename-tab"`）；工具栏 History 按钮加 `data-testid="db-query-history-toggle"`；`appendSqlHistory` 增加 `panelId` 入参并写 `panelId/tabName`；重命名提交后同步 `historyEntries` 并调用 `dbUpdateHistoryTabName`；`HistoryDropdown` 渲染 `data-testid="db-query-history-entry-name"` chip；既有行为（Tab limit、dirty、关闭、自动保存）不变 | AC-01~AC-05、AC-07~AC-10 | TASK-01、TASK-03 |
| `src/lib/ipc.ts` | `DbQueryWorkspaceTab.displayName`、`DbSqlHistoryEntry.panelId/tabName` 字段；新增 `dbUpdateHistoryTabName` 包装 | AC-05、AC-08、AC-09 | TASK-02、TASK-03 |
| `src-tauri/src/database/query_workspace.rs` | 结构体 `display_name`；迁移加列；`row_to_workspace_tab` 与两处 SELECT 追加列；upsert 写入与冲突更新；单元测试 | AC-05、AC-06 | TASK-02 |
| `src-tauri/src/database/history.rs` | 结构体 `panel_id/tab_name`；迁移加列与索引 `idx_sql_history_session_panel`；`row_to_history`/`append_history`/`list_history` 列清单；`update_history_tab_name` 纯函数与 `db_update_history_tab_name` 命令；单元测试 | AC-06~AC-09 | TASK-03 |
| `src-tauri/src/lib.rs` | `invoke_handler` 注册 `database::db_update_history_tab_name`（历史命令块之后） | AC-08 | TASK-03 |
| `src/stubs/tauri-core.ts` | `StubDbQueryWorkspaceTab.displayName`、`StubDbSqlHistoryEntry.panelId/tabName`；新增 `db_update_history_tab_name` 分支（按 session+panel 更新并返回行数） | AC-05、AC-08（浏览器辅助） | TASK-03 |
| `src/components/database/DbClientTab.test.tsx` | mock 增加 `dbUpdateHistoryTabName`；新增 7 个重命名/恢复/优先级/取消/清除/历史快照与 chip 用例（总计 23 passed） | AC-01~AC-10 | TASK-04 |
| `qa-ui-auto-tests/feature-list.md`（F-DB-1） | 新增控件 `db-query-tab`、`db-query-tab-input`、`db-context-rename-tab`、`db-query-history-toggle`、`db-query-history-entry-name`、`run-current-statement`；补充行为描述；同步 `testid-catalog.md` | AC-01、AC-02、AC-07 | TASK-04 |
| `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename.testcase.yaml`（新增） | 浏览器用例：双击重命名 + stub 持久化 + 右键菜单 + Esc 取消（reload 不可行，见第 7 节说明） | AC-01~AC-05（浏览器辅助） | TASK-04 |
| `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename-native.testcase.yaml`（新增） | 原生用例：真实 MariaDB 连接 + 重命名 + 执行 + History chip | AC-01~AC-05、AC-07~AC-10 | TASK-04、TASK-05 |
| `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename-native-restore.testcase.yaml`（新增） | 原生用例：应用重启 + Welcome 恢复 + 名称与历史标签断言 | AC-05、AC-07 | TASK-04、TASK-05 |
| `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-sql-session-scaffold.testcase.yaml` | 既有回归用例补充 `side-tab-sessions` 展开步骤（侧栏默认折叠导致原步骤不可见）；其余步骤不变 | AC-10（回归） | TASK-04 |

## 6. 实现任务与交接

### TASK-01 前端重命名交互与标题优先级

- 职责与文件范围：`src/components/database/DbClientTab.tsx`（tab 渲染、编辑态、菜单、标题计算）
- 输入与必读：本设计 4.1/4.4/4.7、DEC-01/02/06/07、原型 v1；先例 `src/components/tabbar/TabBar.tsx:312-333,895-920`
- 依赖：无阻塞；`displayName` 类型字段可先本地定义，接口字段在 TASK-02/03 落地
- 实施内容：按 4.1/4.7 增加状态与函数；tab 从 `<button>` 切换为 `<input>` 时保留尺寸/颜色/dirty 标记；双击与菜单入口都调用同一 `startPanelRename`；提交规范化与 `isComposing` 守卫；`data-testid` 按第 5 节添加；不改变现有 onClick 激活、X 关闭与 Tab limit 行为
- 对应验收：AC-01、AC-02、AC-03、AC-04、AC-10
- 验证与完成条件：V-01 通过；本地手工检查双击/右键/Esc/IME/长名称截断；`pnpm build` 无类型错误
- 并行与集成：可与 TASK-02/03 并行（接口字段名已冻结）；与 TASK-03 共享 `DbClientTab.tsx`，由 TASK-03 负责历史相关改动的最终合并

### TASK-02 工作区名称持久化（前端 IPC + Rust）

- 职责与文件范围：`src/lib/ipc.ts`、`src-tauri/src/database/query_workspace.rs`
- 输入与必读：本设计 4.2/4.7/4.8、DEC-05；现有迁移先例 `query_workspace.rs:92-104`
- 依赖：无；被 TASK-01（恢复/保存字段）消费
- 实施内容：TS/Rust 结构体加 `displayName/display_name`；迁移加列；row mapper 与 SELECT 列清单；upsert 的列与参数；补 Rust 单元测试
- 对应验收：AC-05、AC-06
- 验证与完成条件：V-04、V-08 通过；用旧结构建表后调用 `init_query_workspace_tables` 验证加列幂等
- 并行与集成：独立文件，可与 TASK-01/03 并行

### TASK-03 历史名称记录、回溯与展示

- 职责与文件范围：`src-tauri/src/database/history.rs`、`src-tauri/src/lib.rs`、`src/lib/ipc.ts`、`src/stubs/tauri-core.ts`、`src/components/database/DbClientTab.tsx`（`appendSqlHistory`、`historyEntries` 同步、`HistoryDropdown` chip）
- 输入与必读：本设计 4.2/4.7/4.8、DEC-03/08；`DbClientTab.tsx:1130-1164,1212,3020-3136`
- 依赖：TASK-02 冻结的类型字段名；与 TASK-01 共享 `DbClientTab.tsx`（合并顺序：TASK-01 → TASK-03）
- 实施内容：`sql_history` 加列与索引；`append_history`/`list_history`；`update_history_tab_name` + 命令 + 注册；TS 包装；stub 分支；`runQuery` 调用 `appendSqlHistory(..., panelId)`；重命名提交调用 `dbUpdateHistoryTabName` 并更新 `historyEntries`；History chip 渲染（空值不渲染）
- 对应验收：AC-07、AC-08、AC-09
- 验证与完成条件：V-03、V-05、V-08 通过；旧表迁移幂等；更新范围仅限目标 session+panel
- 并行与集成：Rust 与 stub 部分可先行；组件整合责任在 TASK-03

### TASK-04 自动化测试与 UI 目录维护

- 职责与文件范围：`src/components/database/DbClientTab.test.tsx`、`qa-ui-auto-tests/feature-list.md`、新增 `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename.testcase.yaml`
- 输入与必读：第 7 节测试计划与 YAML 草案、`.agents/skills/qa-ui-auto/references/authoring.md`、现有用例 `TC-auto-F-DB-1-sql-session-scaffold.testcase.yaml`
- 依赖：TASK-01/02/03 的符号与 testid 落地后执行；YAML 可提前编写
- 实施内容：补 mock 与用例；feature-list 增加 4 个控件与描述；新增浏览器用例并用 `python -m qa_ui_auto audit --gate` 校验
- 对应验收：全部 AC 的自动化覆盖部分
- 验证与完成条件：V-01~V-03、V-06、V-07 通过；audit 无新增违规
- 并行与集成：TASK-01~03 完成后开始

### TASK-05 集成、三端兼容检查与真机验证

- 职责与文件范围：集成审查（本设计全部落点）、三端兼容静态审查、Windows 真机执行与证据归档
- 输入与必读：第 8 节手册、AGENTS.md、真实 MariaDB 连接（凭据经环境变量注入）
- 依赖：TASK-04 完成
- 实施内容：执行 V-08/V-09；审查无平台分支；回填第 9 节追踪表与证据路径；记录 macOS/Linux 未验证状态与步骤
- 对应验收：AC-11 及全部 AC 的端到端确认
- 验证与完成条件：Windows 当前端真机链路通过（V-09）；三端代码兼容检查通过（V-12）；证据目录生成、清理完成
- 并行与集成：最终集成责任；必须等待 TASK-01~04

## 7. 自动化测试计划

| V ID | AC | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 状态 |
|---|---|---|---|---|---|---|
| V-01 | AC-01~04、AC-10 | Vitest，`src/components/database/DbClientTab.test.tsx`（新增用例：恢复名称、双击改名、Esc 取消、空白清除、右键菜单入口） | `dbLoadQueryWorkspace` 返回带 `displayName` 的 tab；双击 `db-query-tab`、输入、Enter；上下文菜单项 | 恢复后标题为 `订单巡检*`；双击出现 `db-query-tab-input`；Enter 后标题变化；Esc 不保存；空白提交回落派生标题；菜单首项为 `db-context-rename-tab` | `pnpm test src/components/database/DbClientTab.test.tsx`（根目录） | 通过（2026-09-12，23 passed） |
| V-02 | AC-04、AC-05、AC-08 | Vitest，同文件（持久化与历史同步用例） | mock `dbSaveQueryWorkspace`、`dbUpdateHistoryTabName`；改名后 `flushWorkspace()` | `dbSaveQueryWorkspace` 收到 `displayName`；`dbUpdateHistoryTabName` 收到新名称/null；清空后历史 chip 消失 | 同上 | 通过 |
| V-03 | AC-03、AC-07、AC-09 | Vitest，同文件（历史快照与 chip 用例） | 执行一次查询触发 `dbAppendHistory`；`dbListHistory` 返回 `{ panelId, tabName }` 后打开 History | `dbAppendHistory` 收到 `panelId` 与 `tabName` 快照；`db-query-history-entry-name` 显示名称；`tabName: null` 不渲染 chip | 同上 | 通过 |
| V-04 | AC-05、AC-06 | Rust unit，`src-tauri/src/database/query_workspace.rs`（`saves_and_loads_workspace_tab_display_name`、`adds_display_name_to_existing_workspace_tables`） | 内存 SQLite；保存/清除名称；旧表结构连续迁移两次 | 名称 round-trip；清除后 `None`；迁移列存在且幂等 | `cargo test --lib database::query_workspace`（`src-tauri/`） | 通过（7 passed） |
| V-05 | AC-06~AC-09 | Rust unit，`src-tauri/src/database/history.rs`（`appends_and_lists_history_tab_names`、`updates_tab_names_for_session_panel_only`、`adds_tab_name_columns_to_existing_history_tables`） | 内存 SQLite；不同 session/panel 条目；调用 `update_history_tab_name`；旧表结构连续迁移两次 | 条目 round-trip 保留 `panel_id/tab_name`；更新只命中目标 session+panel；迁移幂等 | `cargo test --lib database::history`（`src-tauri/`） | 通过（6 passed） |
| V-06 | AC-01~AC-05（浏览器辅助） | qa-ui-auto browser，新增 `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename.testcase.yaml` | 离线 MySQL 会话；双击重命名；`assert_localstorage` 校验 stub；右键菜单与 Esc 取消 | 标题显示自定义名；stub 中含名称；右键菜单含 `Rename tab`；Esc 后名称保持 | `python -m qa_ui_auto run --mode browser --filter TC-auto-F-DB-1-query-tab-rename`（需 dev server；本机用 5310 端口） | 通过（run-20260912-145706-279398500，1 passed） |
| V-07 | AC-01~AC-10 | 类型与构建 | — | 类型检查与前端构建通过 | `pnpm build`（根目录） | 通过（2026-09-12） |
| V-08 | AC-05~AC-09 | Rust 库测试（含 V-04/V-05） | — | `cargo test --lib database::` 全部通过 | `cargo test --lib database::`（`src-tauri/`） | 通过（57 passed, 0 failed） |

浏览器用例（已落盘 `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename.testcase.yaml`；相比初稿移除了 `reload` 步骤：`reset_db` fixture 的 init script 会在每次导航清空 `taomni.sessions.v1`，刷新后无法重开会话，刷新/重启恢复由 V-09b 原生用例覆盖）：

```yaml
id: TC-auto-F-DB-1-query-tab-rename
title: Query tab rename updates the label and the browser query-workspace stub
covers: [F-DB-1]
modes: [browser]
fixtures: [reset_db]
timeout_sec: 90
steps:
  - open: ${cfg.app.base_url}
  - wait_for: '[data-testid="sidebar"]'
  - click: '[data-testid="side-tab-sessions"]'
  - wait_for: '[data-testid="session-new"]'
  - click: '[data-testid="session-new"]'
  # …创建 MySQL 会话（同 TC-auto-F-DB-1-sql-session-scaffold）…
  - dblclick: '[data-testid="db-query-tab"]'
  - wait_for: '[data-testid="db-query-tab-input"]'
  - fill: {selector: '[data-testid="db-query-tab-input"]', value: qa-rename-orders}
  - press: Enter
  - assert_text: {selector: '[data-testid="db-query-tab"]', contains: qa-rename-orders}
  - wait: 1.5s
  - assert_localstorage: {key: taomni.stub.dbQueryWorkspaces.v1, contains: qa-rename-orders}
  - right_click: '[data-testid="db-query-tab"]'
  - assert_menu_items: [Rename tab]
  - click_menu: Rename tab
  - wait_for: '[data-testid="db-query-tab-input"]'
  - fill: {selector: '[data-testid="db-query-tab-input"]', value: should-be-cancelled}
  - press: Escape
  - assert_text: {selector: '[data-testid="db-query-tab"]', contains: qa-rename-orders}
```

（完整步骤见用例文件；原生用例 V-09/V-09b 见第 8 节。）

说明：浏览器用例只证明 React 渲染、stub 持久化与交互路径（AC-01~AC-05 的浏览器辅助部分）；不同步证明真实 SQLite、真实历史回溯与重启行为，这些由 V-09 原生验证与 V-04/V-05 Rust 测试覆盖。History chip 的浏览器自动化依赖执行 SQL（浏览器无法连接），因此 V-06 不断言 chip，chip 由 V-01/V-03 组件测试与 V-09 真机覆盖。

## 8. 真机验证手册

### 环境与准备

- 当前运行端：Windows（本机 `win32`，PowerShell 7+），本轮已执行 Windows 真机项
- 被测构建：QA 应用 `com.taomni.app.qa`，`python .agents/skills/qa-ui-auto/scripts/native_build.py` 构建（`src-tauri/target/qa-ui-auto/debug/taomni.exe`，WebView2 `MicrosoftEdge=152.0.4191.66`）；普通开发验证也可用 `pnpm tauri dev`
- 真实依赖：用户提供的 MySQL/MariaDB 测试实例——host `10.1.5.52`、port `3306`、user `test`、database `test`；密码仅通过环境变量 `$env:TAOMNI_TEST_MYSQL_PASSWORD` 注入，不写入文档、日志或提交（仓库既有约定见 `docs-feature/welcome-recents-session-restore-design.md` V-11）
- 就绪检查：`Test-NetConnection -ComputerName 10.1.5.52 -Port 3306` 返回 True（2026-09-12）；账号认证已由应用真实连接验证通过。本机未安装 `mysql` CLI，不依赖外部客户端
- 隔离数据注意：Windows 上 `native_isolation_env` 只重定向 `APPDATA`/`LOCALAPPDATA` 环境变量，Tauri 仍按系统已知文件夹写入 `%APPDATA%\com.taomni.app.qa`（QA 标识，非生产 profile）。本轮验证前备份并清理该目录，验证后已恢复备份；后续执行需要同样的备份/清理/恢复流程，或在用例前置步骤处理 vault 状态
- 测试数据：只执行只读语句（`select 1`），不修改测试库业务数据；QA 会话命名 `qa-ui-auto-rename-native` 便于清理

### V-09 Windows 真实桌面验证（当前端，本轮已执行）

- 对应验收：AC-01~AC-05、AC-07~AC-11
- 用例（已落盘，原生 runner 不支持 `open_session`/`set_check`，改用 `dblclick` 与直接 `click` vault 控件）：
  - `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename-native.testcase.yaml`：连接 MariaDB → 双击改名为 `native-orders*` → 执行 `select 1` → History 标签校验
  - `qa-ui-auto-tests/cases/auto/TC-auto-F-DB-1-query-tab-rename-native-restore.testcase.yaml`：重启 QA 应用 → 解锁 vault → Welcome「Restore last session」→ 断言名称与历史标签恢复
- 执行命令（PowerShell，仓库根目录）：
  ```powershell
  $env:TAOMNI_TEST_MYSQL_PASSWORD = "<用户提供的密码，勿提交>"
  $env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
  python -m qa_ui_auto run --mode native --filter TC-auto-F-DB-1-query-tab-rename-native,TC-auto-F-DB-1-query-tab-rename-native-restore
  ```
- 实际结果：run-20260912-155139-275164400，2 passed / 0 failed
  - 连接成功（无连接错误横幅），`select 1` 返回 1 行 1 列 3 ms，History 条目显示 `native-orders`
  - 重启后会话恢复，Tab 名称 `native-orders*` 与 History 标签均保留
- SQLite 落盘证据（应用退出后只读查询）：`sql_query_workspace_tabs.display_name='native-orders'`、`sql_history.tab_name='native-orders'`（panel_id 对应一致）；两表新列由幂等 `ALTER TABLE` 迁移生成
- 证据：截图 `run-20260912-155139-275164400/TC-auto-F-DB-1-query-tab-rename-native/native-query-tab-rename-history.png` 与 `...-restore/native-query-tab-rename-restored.png`；汇总与 DB 摘要见 `qa-ui-auto-report/db-query-tab-rename/windows/2026-09-12.md`
- 清理：QA 应用 profile 已从备份恢复；临时 dev server、taomni 进程已结束；`10.1.5.52` 上的业务数据未修改
- 状态：通过（Windows 当前端；V-09、V-09b）

### V-12 三端代码兼容静态审查（本轮已执行）

- 变更仅涉及 Web 前端（React 键盘/输入/blur）与 rusqlite 表结构；无 `#[cfg]`、平台 API、路径或权限分支
- Windows 已验证 `pnpm build` 与 `cargo test --lib database::`；macOS/Linux 代码路径一致，未执行构建/真机，按上述计划接续

### macOS / Linux 真机计划（本轮未验证）

- macOS（计划，未验证）：Apple Silicon/Intel，Tauri 打包或 `pnpm tauri dev`；执行同一 UI 链路（连接可用等价 MySQL/MariaDB 实例或本地容器）；键盘 Enter/Esc/blur 与中文 IME 行为重点检查；无 Tauri WebDriver，使用系统录屏/手工步骤记录证据；直接 Cargo 测试前需 `bash scripts/bundle-krb5-macos.sh stage`
- Linux（计划，未验证）：WebKitGTK 环境，X11 下可用 `qa-ui-auto` native runner；重复同样用例（需先按隔离说明处理 XDG 目录与 QA 构建），重点检查右键菜单位置与 IME 组合提交行为；Wayland 环境记录差异
- 接续方式：具备对应平台环境时按本节 V-09 步骤执行并归档到 `qa-ui-auto-report/db-query-tab-rename/<platform>/`；未执行前在第 9 节保持“未验证”，不引用 Windows 结果

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | 4.1、4.4 | TASK-01 | V-01、V-06、V-09（Windows） | 组件测试 23 passed；浏览器 run-20260912-145706 通过；原生截图 | macOS/Linux 未验证；IME 手测未执行 |
| AC-02 | 4.1、4.4 | TASK-01 | V-01、V-06、V-09 | 同上 + 右键菜单断言 | macOS/Linux 未验证 |
| AC-03 | 4.1、4.4、DEC-07 | TASK-01 | V-01、V-09（IME 未手测） | 组件测试（Enter/Esc/空白/IME 守卫代码）；原生 `type`+Enter 提交 | 中文 IME 真机手测未执行 |
| AC-04 | 4.1、DEC-02 | TASK-01 | V-01、V-02 | 组件测试输出（优先级 + dirty `*`） | 无（Windows 已覆盖） |
| AC-05 | 4.2、4.6、DEC-05 | TASK-01、TASK-02 | V-02、V-04、V-06、V-09b | 组件/Rust 测试；stub localStorage；SQLite `display_name` + 重启恢复截图 | macOS/Linux 未验证 |
| AC-06 | 4.8、DEC-05 | TASK-02 | V-04、V-05、V-12 | 迁移测试（幂等加列）；真实 DB 列存在 | macOS/Linux 未验证 |
| AC-07 | 4.2、4.5、DEC-03 | TASK-03 | V-03、V-09 | 组件测试；原生 History 截图（`native-orders` chip） | macOS/Linux 未验证 |
| AC-08 | 4.2、DEC-03/08 | TASK-03 | V-03、V-05、V-09 | 组件/Rust 测试；SQLite `tab_name` 一致性 | 重命名回溯的浏览器 UI 断言由组件测试覆盖 |
| AC-09 | 4.2、4.7 | TASK-03 | V-03、V-05 | 组件/Rust 测试输出 | 无（Windows 已覆盖） |
| AC-10 | 4.2、4.8 | TASK-01~03 | V-01、V-07、V-09 回归步骤 | 测试输出；真机会话中执行/关闭/库面板未受影响 | macOS/Linux 未验证 |
| AC-11 | 4.8、8 | TASK-05 | V-09（Windows）、V-12；macOS/Linux 未验证 | 兼容审查（无平台分支）；Windows 真机证据 | macOS/Linux 未验证 |

交付条件：本轮自动化（V-01~V-08）与 Windows 当前端真机（V-09、V-09b）均已通过并归档证据，三端代码兼容检查未见平台特有分支（无 `#[cfg]`/平台 API/路径差异，纯 Web + rusqlite），可报告本轮完成；macOS/Linux 保持未验证并附后续步骤，不单独阻塞本轮。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| IME 组合中 Enter 误提交 | 中文/日文输入法确认候选词时可能提前提交重命名（外层 TabBar 未处理） | 提交/取消处理前判断 `e.nativeEvent.isComposing`，V-01 增加组合态用例，V-09 用中文 IME 手测 | TASK-01 | 组件测试与真机手测通过 |
| input 替换 button 造成布局/焦点跳动 | 内联编辑需保持与原 tab 相同尺寸、颜色与截断；tab 激活/关闭事件可能被误触发 | 输入框继承 tab 样式（`max-w-[190px]`、字号、选中色），事件 `stopPropagation`；V-01 断言编辑态与取消后标签不变 | TASK-01 | 原型实现评审与组件测试通过 |
| 重命名后立即关闭/退出导致名称丢失 | 依赖 1s debounce；但关闭前 `persistWorkspaceSnapshot` 与卸载 flush 已兜底（`DbClientTab.tsx:964,1635`） | V-02 在 flush 后断言 `displayName`；V-09 增加“重命名后立即重启”步骤 | TASK-02 | 测试与真机通过 |
| 历史更新失败导致名称不一致 | `dbUpdateHistoryTabName` 与 workspace 保存是两次调用，失败时名称仍在工作区但历史 chip 旧名 | 失败仅提示不阻塞；下次重命名幂等重试；V-05 覆盖更新范围与重复调用 | TASK-03 | 错误路径测试通过；接受“历史名称可能短暂滞后” |
| `sql_history` 增长导致回溯更新变慢 | 更新按 `saved_session_id + panel_id`，无索引时全表扫描 | 迁移同时创建 `idx_sql_history_session_panel`；历史表保留策略不变 | TASK-03 | 索引存在且查询计划使用（可选 EXPLAIN 记录） |
| 旧版本回退兼容 | 新列仅追加、旧代码显式列名；无删除/重命名列 | 不引入数据回退脚本；V-12 审查确认旧 SELECT/INSERT 不引用新列 | TASK-02、TASK-03 | 兼容审查记录 |
| 历史 `+Tab` 不继承名称 | 从命名历史重开的面板显示派生名，用户可能预期延续名称 | 本期不接受该范围（第 1 节 out of scope）；后续若需要可用 `tabName` 作为 `newPanel` 初始 `displayName` 单独设计 | 不阻塞 | 用户提出新需求 |
| issue 附图为私有 URL，未能核实 | 复现细节（Query 16 截图）仅来自正文描述，可能与真实 UI 细节略有差异 | 原型基于当前代码实际布局绘制；实现后以真实 WebView 截图核对 | 不阻塞 | 已用原生截图核对 |
| Windows 原生验证的环境隔离不生效 | `native_isolation_env` 仅重定向环境变量，Tauri 按已知文件夹写入真实 `%APPDATA%\com.taomni.app.qa`；不处理会导致 vault 处于锁定状态、会话与用例相互污染 | 验证前备份并清理 QA profile、验证后恢复；用例内处理按需 vault 初始化/启动解锁。生产 profile 不受影响 | TASK-05（已按此执行） | 已记录流程；后续平台执行沿用 |
| 浏览器用例无法覆盖 reload 恢复 | `reset_db` 的 init script 每次导航清空 `taomni.sessions.v1`，reload 后无法重开会话（已在用例描述注明） | 刷新/重启恢复由 V-09b 原生用例与 Vitest 恢复用例覆盖；如需浏览器内覆盖需调整 fixture 注入方式（另行立项） | 不阻塞 | 原生 V-09b 已通过 |
| 既有 `TC-auto-F-DB-1-sql-session-scaffold` 在本环境仍有布局遮挡失败 | 侧栏默认折叠（已补 `side-tab-sessions` 步骤）后，步骤 22 点击 `db-query-library-tab` 被 resizable 分隔条/面板遮挡，与本功能无关 | 记录为既有环境问题；组件与原生回归均通过，不影响本功能验收 | 不阻塞 | 如需修复应单独处理面板布局/用例 |

实现与 Windows 真机验证均已完成；无待用户决策项。macOS/Linux 按第 8 节计划接续，未执行前保持“未验证”。
