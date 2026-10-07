# Taomni Workspace-first 导航与实体模型详细设计

## 1. 设计摘要与范围

- 类型：现有能力扩展 / UI 与导航模型重构
- 文档位置：`docs-feature/workspace-first-navigation-design.md`
- 设计状态：部分可实施
- 来源：用户确认的 Workspace-first 实体模型；交互原型 `docs-feature/ui-layout-refactor-prototype.html`
- 调研基线：当前 `main` 分支，2026-10-07；工作区存在未提交的原型文件，不修改业务代码。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用；浏览器用于辅助验证。
- 本轮真机执行端：Windows；macOS/Linux 仅制定计划，未实测。
- 推荐方案：Workspace 是默认主视图；Session 是全局唯一 canonical 实体；Surface 是 Workspace/Session 的视图实例；Global Tool 跨工作区存在。移除顶层 Terminal / Code Workspace / Git review 并列标签，保留 Workspace 内的视图切换以及全局 Sessions 视图。

本设计解决当前 `Tab`、Session Tree、Workspace、Git、Mail、Tao、SFTP 与工具入口混在同一层的问题。完成后用户先选择工作区，在工作区中切换 Overview、Files/Code、Terminal、Preview、Tao、Changes、Mail 等视图；需要按连接管理时进入 Sessions，看到一份 canonical session 目录；截图、MFA、Network tools、LAN Chat 等不属于任意 Workspace 的能力进入 Tools 的 Outside workspace 区域。既有 Session Tree 的文件夹、Favorites、搜索、拖动、导入导出、右键操作继续保留，但从 Workspace 导航中分离。

本设计不实现具体业务代码，不改 `feat/ui-layout-refactor` 分支，也不把当前原型的示例记录当作真实用户数据。

## 2. 当前实现与功能缺口

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/types/index.ts:9` `TabKind`、`Tab:425` | 一个 `Tab` 同时承载 terminal、sftp、git、code-workspace、mail、settings、tools 等不同层级对象 | 需要增加 scope/owner 语义，不能继续把所有视图当同一类顶层对象 | 源码事实 |
| `src/stores/sessionStore.ts:31` | `sessions` 与 `groups` 是持久化会话目录；支持多选、搜索、分组移动、导入导出 | 复用为 Sessions canonical 目录，不复制 Session | 源码事实 |
| `src/components/sidebar/SessionTree.tsx:126` | 树按 `group_path` 组织 Saved Session，带拖拽、右键、导入导出 | 保留为 Sessions 视图；Workspace 只显示引用摘要 | 源码事实 |
| `src/types/index.ts:403` `CodeWorkspaceTabInfo`、`RecentWorkspace:415` | Code Workspace 具备 roots、looseFiles、workspaceId、workspaceInstanceId、recent persistence | 作为 Workspace 数据模型的直接迁移基础 | 源码事实 |
| `src/layouts/MainLayout.tsx:3901-3913` | 按 TabKind 分别渲染 terminal/sftp/git/code workspace/mail/db 等，并用绝对层 `display:none` 保持部分内容挂载 | 渐进式迁移 Surface host；先不破坏生命周期，再统一 scope | 源码事实 |
| `src/layouts/MainLayout.tsx:4104-5035` | 当前 shell 是 ControlBar → Sidebar/PanelGroup → tab content → Tao/StatusBar | 重排为 Rail → Navigator → Workspace canvas；保留 keep-mounted 内容和可调整面板 | 源码事实 |
| `src/components/tabbar/ControlBar.tsx:207-265`、`src/components/tabbar/TabBar.tsx:492-654` | 顶部同时放应用菜单、TabBar、Tab overflow、截图、窗口控件 | 顶部删除业务 Tab；只保留全局操作、窗口操作、Search/New/Theme/More | 源码事实 |
| `src/components/chat/ChatDrawer.tsx:295-377,718-1264` | Tao drawer 可按 left/right/top/bottom 浮动、绑定 Tab、保留挂载、含 Chat/Notes/Notifications | 作为 Workspace/Session Surface；Chat scope 增加 workspaceId，未绑定时可进入 Global Tao | 源码事实 |
| `src/stores/sidebarRailPolicy.ts:1-79` | 当前 rail 按 code-workspace/terminal/other 记忆 sidebar collapsed | 被 Workspace-first navigator 取代；迁移期间保留旧 key 读取与一次性兼容 | 源码事实 |
| `src/components/WelcomePanel.tsx:428-495` | Welcome 同时列 Recent sessions、Recent workspaces、Local directories | 改为 Welcome/Home 的入口选择：Recent Workspaces 优先，Recent Sessions 次级，Global Tools 快捷入口明确 | 源码事实 |
| `docs-feature/ui-layout-refactor-prototype.html` | 当前交互原型已展示 Work/Sessions/Tools/Alerts/Settings Rail、Workspace/Session 双视图、Global/Workspace/Session tool 分组、无顶层业务 Tab | 作为 v0.4 当前有效原型；所有示例文本和交互需继续保持无乱码 | 原型实测事实 |

### 当前层级混淆

1. Terminal 既是 `TabKind`，又是用户理解的工作内容入口。
2. Git tab 由 Code Workspace 关联，但当前仍可作为独立顶层 tab 打开。
3. Mail account、Unified Mail、Mail tab 的边界不明确。
4. SFTP 既可独立 tab，也可 attached 到 terminal；缺少“Session + Surface instance”关系。
5. Global tools 与 Workspace tools 都进入 Sidebar Tools 列表，但没有 scope 标识。
6. AI Chat 使用 `linked_session_id`，不能完整表达 workspace-scoped chat。

## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | 应用启动且没有活跃工作区 | 打开 Taomni | 默认进入 Work/Workspace 视图；顶部没有 Terminal、Code Workspace、Git review 业务 Tab；可见 Workspace navigator、全局 Rail、主画布 | 三端；当前 UI 原型先验证浏览器 |
| AC-02 | 至少存在两个 Workspace | 在 Work 视图选择 Workspace | 主画布标题、摘要、Surface 列表、右工具 pane 和状态栏都切换到该 Workspace；相关 session 连接不被复制 | 三端 |
| AC-03 | 一个 SSH Session 被两个 Workspace 引用 | 在 Workspaces 中打开两个 Workspace，再进入 Sessions | Sessions canonical 区只显示一份 SSH；Workspace memberships 区显示两个 reference；修改/删除 canonical Session 不会制造重复实体 | 三端；删除流程需确认引用影响 |
| AC-04 | 存在多个 terminal、SSH、RDP、Mail session | 进入 Sessions → kind filter | 可按 All/Terminal/Remote/Mail 筛选；打开 Session 时主画布显示对应 Session Surface，但不创建顶层业务 tab | 三端 |
| AC-05 | Workspace 含 terminal、files、Git、SFTP、Mail | 在 Workspace Surface 区切换 Overview、Files、Preview、Tao、Changes、Mail | 所有视图都显示 Workspace/Session scope；Git review 不出现在顶部；Mail 是 workspace 引用的 Mail Surface | 三端 |
| AC-06 | 存在 Global Tool | 进入 Tools | Outside workspace 显示 Screenshot、MFA、Network、LAN Chat、Local servers 等，并标注 global；点击后不改变当前 Workspace membership | 三端 |
| AC-07 | 存在 Workspace/Session Tool | 在 Tools 点击 Git changes、SFTP browser、Mail | Git/SFTP/Mail 显示 workspace 或 session scope；缺少 scope 时给出可操作提示，不静默创建错误引用 | 三端 |
| AC-08 | 工作区有多个 session，Session Tree 有 folders/Favorites | 在 Sessions 视图搜索、展开、拖动、右键、导入/导出 | 既有 Session Tree 操作仍可用；Sessions 视图是 canonical 管理入口，Workspace 只显示引用；旧 `group_path` 不丢失 | 三端；IPC/文件操作需 native |
| AC-09 | 左导航已展开 | 点击 Hide，再恢复 | 只收起 navigator 到 rail；主画布保持完整宽度，不变成窄条；再次点击 Work/Sessions/Tools 可恢复 | 三端 |
| AC-10 | 已有 active Tao thread | 在 Workspace 与 Session 之间切换 | thread、draft、message history 按 workspace/session scope 恢复；不会把其他 Workspace 的 thread 混入当前视图 | 三端 |
| AC-11 | 应用重启 | 重启并恢复工作区 | 恢复 Workspace、membership、active surface、pane layout；对不存在的 Session 标为 unavailable 并提供 Remove reference/Retry，不自动创建连接 | 三端 |
| AC-12 | 顶部 Search/New/More/Theme/Window 操作 | 点击或快捷键 | Search 打开 Command Center；New 默认创建 Workspace（可从菜单选择 Session）；Theme/More/窗口控件可见且文案明确 | 三端 |
| AC-13 | 小窗口或 400px 左右宽度 | 缩小窗口 | Rail 保留；Navigator 可折叠；Workspace canvas 至少保留 Overview 和 active surface；右 pane 进入 overflow/关闭，不发生页面横向滚动 | 浏览器 + 三端代码兼容 |
| AC-14 | 浏览器/渲染资源加载 | 打开原型和后续实现页面 | 无字符乱码、无脚本异常；UTF-8、favicon、按钮操作及折叠状态正常 | 浏览器 |

## 4. 方案与关键决策

### 4.1 实体模型

```text
Workspace
  id, name, description, roots[], settings, activeSurface, memberships[]

Session (canonical)
  id, kind, connectionConfig, groupPath, displayName, runtimeState

WorkspaceMembership
  workspaceId, sessionId, role, order, pinned, defaultSurface, metadata

SurfaceInstance
  id, surfaceKind, ownerScope, workspaceId?, sessionId?, state, viewState

GlobalTool
  id, toolKind, globalState, lastUsedAt
```

#### Membership roles

- `primary`：工作区主连接或主资源；可参与默认恢复。
- `attached`：依附于工作区上下文，例如 terminal 的 attached SFTP。
- `reference`：仅作为快捷引用，不拥有 Session 生命周期。

#### Surface ownership

- `workspace`：Overview、Code/Files、Git Changes、Preview、Tasks、Problems、Workspace Tao。
- `session`：Terminal、SFTP、RDP/VNC、Database、Mail account、Object Storage。
- `global`：Screenshot、MFA、Network tools、LAN Chat、Local servers、Settings。

Surface 关闭只关闭 Surface instance；除非用户明确选择“关闭并断开 Session”，否则不能删除/断开 canonical Session。

### 4.2 导航结构

```text
Taomni
├─ Work
│  ├─ Pinned Workspaces
│  ├─ Recent Workspaces
│  └─ Workspace navigator
│     ├─ Overview
│     ├─ Files / Code
│     ├─ Terminal (session surfaces)
│     ├─ Preview
│     ├─ Tao
│     ├─ Changes
│     └─ Mail
├─ Sessions
│  ├─ User sessions (现有 SessionTree canonical folders)
│  ├─ All terminal sessions
│  ├─ Remote sessions
│  ├─ Database sessions
│  ├─ Mail accounts
│  └─ Workspace memberships (references)
├─ Tools
│  ├─ Outside workspace
│  ├─ Workspace tools
│  └─ Session tools
├─ Alerts
└─ Settings
```

顶部不显示业务 tabs。顶部只显示应用级动作：Home、Search、New、Theme、More，以及原生窗口控件。需要快速切换最近工作区使用 Work navigator 或 Command Center，不新增第二套顶部 tabs。

### 4.3 Workspace 视图

Workspace 画布采用三块可调整区域：

1. 左 Rail：Work / Sessions / Tools / Alerts / Settings。
2. Navigator：Workspace 树、Session Tree 或 Tools 列表；可折叠到 40–48px rail，不影响主画布。
3. Canvas：Workspace header、Surface strip、主 surface、可选右侧 Tools pane、底部 dock。

当前原型中已体现：

- `docs-feature/ui-layout-refactor-prototype.html` 的 Work/Sessions/Tools 切换。
- workspace surface：Overview、Files、Preview、Tao、Changes、Mail。
- Tools 的 global/workspace/session 分组。
- Hide 采用 `grid-template-columns: 42px 0 minmax(0,1fr)`，不再把主内容压缩到左侧窄区。

后续业务实现应把示例 card 替换为真实 Surface host，但保留结构：Surface 内容由 scope store 提供，非 active surface 可 keep-mounted 或按生命周期策略卸载。

### 4.4 Sessions 视图与现有 Session Tree

现有 `SessionTree` 不是删除，而是成为 Sessions → User sessions 的 canonical 管理组件：

- 保留 `group_path`、folder、Favorites、选中、多选、拖动、右键、导入导出。
- Sessions 视图顶部增加 kind filter：All、Terminal、Remote、Mail、Database 等。
- 每个 canonical row 右侧显示 `Used by N workspaces`；点击可展开 membership references。
- Workspace 中显示的是 membership row，默认操作是 Open surface / Reveal session / Remove reference；删除 canonical Session 要显示引用数量并确认。
- Session search 与 Workspace search 互不混淆：前者搜索 canonical Session，后者搜索 Workspace name/root/metadata。

不在本阶段改变 Rust session 数据库存储的 canonical identity；Workspace membership 先采用独立 store/持久化层，以便旧 Session 数据可被原样读取。

### 4.5 Tools 视图

#### Global tools

- `servers` / Local servers
- `network` / Network tools
- `capture` / Screenshot capture
- `mfa` / MFA authenticator
- `lan` / LAN Chat
- `tunneling` / Tunneling
- `sockscap` / SocksCap
- Settings / Vault / Backup / Updates

#### Workspace tools

- Git Changes
- Code Workspace / Files
- Preview
- Tao Chat / Notes / Notifications
- Workspace Tasks / Problems

#### Session tools

- Terminal
- SFTP
- RDP / VNC
- Database / Redis / HBase
- Mail account
- Object storage

每一行显示作用域 badge：`global`、`workspace`、`session`。Global tool 打开时不改变 active Workspace；Workspace tool 缺少 workspace context 时引导选择 Workspace；Session tool 缺少 Session 时引导选择或创建 Session。

### 4.6 现有 Tab 迁移策略

不立即删除 `Tab`，分三阶段迁移：

#### Phase A：增加 scope adapter

新增纯逻辑模型（拟新增）:

```ts
export type SurfaceOwnerScope = "global" | "workspace" | "session";
export type SurfaceKind =
  | "overview" | "files" | "preview" | "tao" | "changes" | "mail"
  | "terminal" | "sftp" | "rdp" | "vnc" | "database" | "redis"
  | "hbase-shell" | "object-storage" | "settings" | "network" | "mfa"
  | "screenshot" | "lan-chat";

export interface WorkspaceMembership {
  workspaceId: string;
  sessionId: string;
  role: "primary" | "attached" | "reference";
  order: number;
  pinned: boolean;
  defaultSurface?: SurfaceKind;
}

export interface SurfaceDescriptor {
  id: string;
  kind: SurfaceKind;
  scope: SurfaceOwnerScope;
  workspaceId?: string;
  sessionId?: string;
  sourceTabId?: string;
}
```

`tabToSurfaceDescriptor(tab)` 根据 `Tab.type` 和关联字段推导 scope；旧 tab 仍能被 MainLayout 打开。

#### Phase B：分离导航状态

新增 `workspaceStore` 管理 Workspace、membership、activeWorkspaceId、activeSurfaceId；`appStore.tabs` 暂时继续管理 runtime surface instances。`activeTabId` 只作为向后兼容的 active session surface，不再驱动顶部业务 tabs。

#### Phase C：按生命周期迁移

- Terminal/SFTP/RDP/VNC/DB/Mail 的 runtime host 迁移到 SessionSurface registry。
- Code Workspace/Git/Files/Preview/Tao 迁移到 WorkspaceSurface registry。
- Global tools 迁移到 GlobalTool host。
- `Tab` 保留为兼容 projection，最终只代表可恢复的 Surface instance，而不是实体。

#### keep-mounted 约束

沿用 MainLayout 当前对 terminal、SFTP、Git、Code Workspace、Mail、DB 等的 `display:none` 常驻策略；切换 Workspace 不能中断 PTY、SFTP transfer、VNC/RDP、长查询、Mail sync 或 Tao stream。明确关闭 Surface 与删除 Session 的生命周期边界。

### 4.7 Tao scope

现有 `ChatThread.linked_session_id` 保留；新增可空 `workspace_id`（或兼容 metadata）并规定：

- Workspace Tao：`workspace_id` + optional `linked_session_id`。
- Session Tao：`linked_session_id` + inferred workspace context。
- Global Tao：两者均空，仅允许用户主动打开。
- workspace/session 切换不改变另一个 scope 的 active thread。

Draft、queue、messages、tool cards、usage 归 thread scope 保存；不能只按 drawer 是否打开判断。

### 4.8 Mail scope

- Mail account 是 canonical Session，沿用 `SessionConfig.session_type === "Mail"` 和 `MailTabInfo`。
- Unified Mail 是 Global/Workspace 可引用的 Surface；它可汇总多个 Mail Session。
- Mail account surface 可绑定一个 Workspace，也可在 Sessions → Mail accounts 中单独打开。
- Mail 数据同步、账号凭据与 Workspace membership 分离；删除 Workspace 不删除 Mail Session。

### 4.9 Global Tool scope

Screenshot、MFA、Network、LAN Chat、Local servers、Tunneling、SocksCap 等均不自动获得 workspaceId。它们可以读取当前 Workspace/Session 作为上下文，但必须在 UI 上显示 `Global`，并允许从任意 Workspace 访问。

## 5. 改动清单

| 路径 / 模块 | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/types/index.ts` | 新增 Workspace、WorkspaceMembership、SurfaceDescriptor、scope 类型；保留 `Tab` 字段兼容 | AC-02/03/04/05/06/11 | TASK-01 |
| `src/stores/workspaceStore.ts`（拟新增） | Workspace/membership/active view/persistence；不存在 Session 的 membership 标记 unavailable | AC-02/03/11 | TASK-02 |
| `src/lib/workspaceScope.ts`（拟新增） | Tab → SurfaceDescriptor、scope resolver、legacy migration helpers | AC-03/05/06/11 | TASK-01 |
| `src/stores/appStore.ts` | active workspace/surface projection、legacy activeTab compatibility；不破坏 terminal split、cwd、runtime state | AC-05/09 | TASK-03 |
| `src/stores/chatStore.ts` | Chat thread 增加 workspace scope，兼容旧 linked_session_id | AC-10 | TASK-04 |
| `src/components/sidebar/SessionTree.tsx` | 保留现有树；增加 kind filter、membership reference、scope action | AC-04/08 | TASK-05 |
| `src/components/sidebar/Sidebar.tsx` | 从 Sessions/Tools 双 tab 改为由 Rail 驱动 Workspaces/Sessions/Tools；保留现有 SessionTree | AC-01/04/06/09 | TASK-06 |
| `src/components/tabbar/ControlBar.tsx` | 去除业务 TabBar 的顶层展示；保留全局 actions、Command Center、window controls、overflow | AC-01/12 | TASK-07 |
| `src/components/tabbar/TabBar.tsx` | 迁移为 Surface strip 或 Workspace view strip；不再生成顶层 Terminal/Git/Code Workspace 业务 tabs | AC-05/12 | TASK-07 |
| `src/layouts/MainLayout.tsx` | 引入 Workspace canvas、Surface host、Global tool host；复用 keep-mounted panes 与 panel persistence | AC-02/05/06/09/13 | TASK-08 |
| `src/components/chat/ChatDrawer.tsx`、`src/stores/chatStore.ts` | workspace/session/global scope、Tao hub tabs 与 drawer memory | AC-10 | TASK-04 |
| `src/components/WelcomePanel.tsx` | Workspace-first Welcome；Recent Workspaces primary，Recent Sessions secondary，Global Tools entry | AC-01/12 | TASK-09 |
| `src/components/editor/workspace/panels/ToolWindowRail.tsx` | Rail 迁移、scope badge、global/workspace/session tool groups、accessible collapse | AC-06/09/13 | TASK-06 |
| `src/lib/tabDetails.ts` | session/workspace/surface summary，保留 copy details | AC-04/05 | TASK-03 |
| `src/components/filebrowser/SftpSidebar.tsx` | 由 terminal/session surface descriptor 接入，不复制 Session | AC-05/07 | TASK-08 |
| `.agents/skills/qa-ui-auto/...` 与 `qa-ui-auto-tests/feature-list.md` | 新增/维护 Workspace/Sessions/Tools cases 与 selectors | AC-01-13 | TASK-10 |
| `docs-feature/ui-layout-refactor-prototype.html` | 保持为交互原型，不接入业务；持续修复 UTF-8、空 favicon、button 操作与 prototype state | AC-14 | TASK-11 |

## 6. 实现任务与交接

### TASK-01 类型与 scope resolver

- 职责与文件范围：`src/types/index.ts`（拟新增类型）、`src/lib/workspaceScope.ts`（拟新增）。
- 输入与必读：本设计 4.1、4.6；`Tab`、`CodeWorkspaceTabInfo`、`RecentWorkspace`。
- 依赖：无；可开始。
- 实施内容：定义 serializable types；实现 legacy TabKind 映射；对缺失 workspace/session 返回明确 `scope: unavailable`，不猜测归属。
- 对应验收：AC-03/04/05/06/11。
- 验证与完成条件：V-01；纯函数覆盖全 TabKind、旧数据、未知 kind。
- 并行与集成：可与 TASK-05/11 并行；类型稳定后供 store/UI 使用。

### TASK-02 Workspace store 与 membership persistence

- 职责与文件范围：拟新增 `src/stores/workspaceStore.ts`、`src/lib/workspacePersistence.ts`、对应 tests。
- 依赖：TASK-01。
- 实施内容：Workspace CRUD、membership 多对多、order/pinned/defaultSurface、active workspace/surface；校验 workspace/session 存在；旧数据/不存在 Session 采用 unavailable 状态；版本化迁移。
- 对应验收：AC-02/03/11。
- 验证与完成条件：V-02、V-03。

### TASK-03 AppStore / Surface projection

- 职责与文件范围：`src/stores/appStore.ts`、`src/lib/tabDetails.ts`、`src/components/tabbar/TabBar.tsx`（按需）。
- 依赖：TASK-01/02。
- 实施内容：active workspace/surface 与 legacy activeTab 双向 projection；不改变 terminal split、cwd、runtime state、duplicate/detach semantics；surface close 不删除 Session。
- 对应验收：AC-04/05/09。
- 验证与完成条件：V-04；现有 TabBar/terminal tests 保留并改写到新入口。

### TASK-04 Tao scope 与 Mail scope

- 职责与文件范围：`src/stores/chatStore.ts`、`src/components/chat/ChatDrawer.tsx`、`src/layouts/MainLayout.tsx`、Mail open path。
- 依赖：TASK-01/02。
- 实施内容：workspaceId optional backward-compatible；thread scope resolver；Mail Session/Unified Mail Surface descriptor；切换 scope 不串 thread/draft/queue。
- 对应验收：AC-05/10/11。
- 验证与完成条件：V-05、Mail 现有回归测试。

### TASK-05 Sessions canonical UI

- 职责与文件范围：`src/components/sidebar/SessionTree.tsx`、`src/components/sidebar/Sidebar.tsx`、session tests。
- 依赖：TASK-01/02；保持既有 SessionTree behavior baseline。
- 实施内容：Sessions rail mode、kind filters、canonical/reference sections、workspace badges、open/reveal/remove reference actions；不破坏 folder drag/import/export/multi-select/context menu。
- 对应验收：AC-04/08。
- 验证与完成条件：V-06；既有 SessionTree tests 通过。

### TASK-06 Rail / Tools scope UI

- 职责与文件范围：`src/components/editor/workspace/panels/ToolWindowRail.tsx`、`src/components/sidebar/Sidebar.tsx`、scope labels/icons。
- 依赖：TASK-01/02。
- 实施内容：Work/Sessions/Tools/Alerts/Settings rail；global/workspace/session groups；accessible hide/restore；tools without scope show picker rather than silently bind.
- 对应验收：AC-01/06/07/09/13。
- 验证与完成条件：V-07；rail resize/collapse retained behavior.

### TASK-07 Header and surface strip

- 职责与文件范围：`src/components/tabbar/ControlBar.tsx`、`src/components/tabbar/TabBar.tsx`、`OpenTabsMenu`。
- 依赖：TASK-03/06。
- 实施内容：删除 top-level Terminal/Code Workspace/Git business tabs；global Search/New/Theme/More；Workspace surface strip；keep overflow/detach for current Surface where needed.
- 对应验收：AC-01/05/12。
- 验证与完成条件：V-08、browser case for no duplicated top-level buttons.

### TASK-08 Main canvas and lifecycle integration

- 职责与文件范围：`src/layouts/MainLayout.tsx`、`SftpSidebar.tsx`、Git/Code/Mail hosts、`loadResizableLayout` usage。
- 依赖：TASK-02/03/04/06/07。
- 实施内容：Workspace canvas, right pane, bottom dock, Surface registry; reuse keep-mounted hosts; explicit close/detach; restore ordering and scope.
- 对应验收：AC-02/05/07/09/11/13。
- 验证与完成条件：V-09; one focused browser run; current-platform native smoke only for Tauri lifecycle/IPC boundary.

### TASK-09 Welcome/Home

- 职责与文件范围：`src/components/WelcomePanel.tsx`、welcome tests、i18n.
- 依赖：TASK-02/05/06。
- 实施内容：Workspace-first cards and recent history; Sessions secondary; Global Tools entry; restore last workspace/session explicit.
- 对应验收：AC-01/12。
- 验证与完成条件：V-10。

### TASK-10 QA catalog and cases

- 职责与文件范围：`qa-ui-auto-tests/cases/` 拟新增 cases、`qa-ui-auto-tests/feature-list.md`、`qa-ui-auto-tests/ci/policy.yaml`、dependencies.
- 依赖：TASK-05-09 stable testids.
- 实施内容：新增 Work/Sessions/Tools/scope/Hide/header cases；维护 controls/cases/policy; keep existing F1.5 and F1.1 retained assertions updated to intended target.
- 对应验收：AC-01-14。
- 验证与完成条件：V-11; exact case IDs and selectors checked by QA tooling.

### TASK-11 Prototype maintenance

- 职责与文件范围：`docs-feature/ui-layout-refactor-prototype.html`。
- 依赖：本设计 decisions; no business code dependency.
- 实施内容：保持 UTF-8; no emoji-only labels; no top-level business tabs; Work/Sessions/Tools/Alerts/Settings; model canonical/reference records; implement every visible button with honest toast/state change; no `favicon.ico` console error.
- 对应验收：AC-14。
- 验证与完成条件：V-12; browser render at desktop/mobile and console clean.

## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-03/04/05/06/11 scope mapping | `src/lib/workspaceScope.test.ts`（拟新增） | 构造每种 legacy TabKind、missing IDs、multi-membership | descriptor scope/kind/workspace/session 映射稳定；unknown/unavailable 不猜测 | `pnpm test -- src/lib/workspaceScope.test.ts` | 待执行；现有 `Tab` mapping 无统一 scope 基线 |
| V-02 | AC-02/03 persistence | `src/stores/workspaceStore.test.ts`（拟新增） | in-memory/localStorage adapter；多 workspace 同一 Session | set/reload/version migration；membership duplicate prevention；remove reference vs delete Session | `pnpm test -- src/stores/workspaceStore.test.ts` | 待执行 |
| V-03 | AC-11 restore | workspace store test + mounted MainLayout test | stale membership, missing session, duplicate workspace | unavailable state; retry/remove reference; no auto-created connection | focused Vitest | 待执行 |
| V-04 | AC-04/05 retained Tab lifecycle | `src/stores/appStore.test.ts`、MainLayout/TabBar tests | existing terminal split, duplicate, detach, cwd | surface projection does not close PTY/SFTP/DB; active legacy tab projection correct | `pnpm test -- src/stores/appStore.test.ts` + affected mounted tests | existing tests are retained behavior baseline; results待执行 |
| V-05 | AC-10 Tao/Mail scope | `src/stores/chatStore.test.ts`、`src/components/chat/ChatDrawer.test.tsx`、Mail tests | two workspace IDs, one session ID, drafts/queues | scope isolation, old linked_session_id compatibility, Unified Mail references | focused Vitest | 待执行 |
| V-06 | AC-04/08 Sessions | `src/components/sidebar/SessionTree.test.tsx`、new mounted Sidebar test | folders, favorites, shared membership, kind filters | canonical/reference rows, folder operations, no duplicate session | focused Vitest | existing SessionTree behavior retained;待执行 |
| V-07 | AC-01/06/07/09 Rail/Tools | new `src/components/sidebar/WorkspaceNavigator.test.tsx`（拟新增） | global/workspace/session tools; collapse/restore | scope labels, tool picker, hide keeps canvas width | focused Vitest | 待执行 |
| V-08 | AC-01/05/12 header | `src/components/tabbar/ControlBar.test.tsx`、new surface strip test | multiple workspaces/surfaces | no top-level Terminal/Git/Code buttons; Search/New/More route; surface switch | focused Vitest | existing ControlBar tests require target update;待执行 |
| V-09 | AC-02/05/07/09/11/13 shell | browser case `TC-WS-001`（拟新增） | browser config, deterministic fixture workspaces/sessions | Work → workspace → Files/Changes/Tao; Tools global; hide; stale reference recovery; no horizontal scroll | `python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-WS-001 --require-pass` | 待执行 |
| V-10 | AC-01/12 Welcome | existing Welcome mounted test + `TC-WS-002`（拟新增） | recent workspace/session fixture | Workspace primary; Session secondary; global tools entry; restore explicit | focused Vitest/browser | existing Welcome baseline retained;待执行 |
| V-11 | AC-01-13 QA catalog | `TC-WS-001/002/003` cases + feature list/policy | selectors after TASK-06-09 | exact controls/covers/policy/dependency registration | `python -m qa_ui_auto.audit --gate` + selected plan | 待执行 |
| V-12 | AC-14 prototype | browser/manual Playwright | desktop 1440x900, 980px, 400px; Work/Sessions/Tools/Hide/Command Center | no console errors; no favicon 404; no mojibake; every visible control changes state/toast; hide keeps canvas full width | `pnpm dev` + Playwright against `/docs-feature/ui-layout-refactor-prototype.html` | current prototype render checked; after edits rerun |
| V-13 | Native boundary AC-02/07/09/11 | Windows current-platform Tauri smoke (case to be added after stable UI) | isolated app data, disposable workspace/session references | Tauri WebView + Rust IPC opening/closing/membership persistence; no PTY/SFTP interruption on surface switch | `python .agents/skills/qa-ui-auto/scripts/native_build.py --check`, then selected native runner | 待执行；macOS/Linux plan only |

Browser cases prove renderer state and stub boundaries only; native V-13 is required for actual Tauri lifecycle, IPC, persistence and PTY/SFTP behavior.

## 8. 真机验证手册

### Windows（当前环境，本轮执行计划）

- OS: Windows 11 x64；Tauri WebView2；development `pnpm tauri dev` or isolated QA application.
- Prepare isolated app data and disposable directories; do not clear personal data. Use a test workspace with two roots and two SessionConfig records, one shared SSH/SFTP reference and one Mail account reference.
- Verify: launch → Work → select workspace → open Terminal/Changes/Tao → Sessions → filter Remote/Mail → confirm canonical/reference relation → Tools → open Screenshot/MFA/Network without workspace reassignment → hide/restore navigator → restart → restore stale reference.
- Evidence: screenshot of Work/Sessions/Tools states, app logs, workspace persistence JSON/database diff, selected case summary. Status: 待执行。

### macOS（后续）

- Check overlay titlebar/native menu, Cmd shortcuts, Rail and workspace surface switching, session tree operations, Mail/SFTP references and restart recovery.
- Run same isolated data flow with `pnpm tauri dev`/QA runner on macOS. Status: 未验证，后续执行。

### Linux（后续）

- Check WebKitGTK layout, keyboard shortcuts, rail collapse, SFTP/terminal keep-mounted behavior and global screenshot/MFA/network tool fallbacks.
- Run same isolated data flow with `pnpm tauri dev`/QA runner on Linux. Status: 未验证，后续执行。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01/02/03 | 4.1-4.3 | TASK-01/02/06/08 | V-01/02/09/13 | 待生成 | 未实现 |
| AC-04/08 | 4.4 | TASK-05 | V-06/09 | 待生成 | Session Tree 需要迁移入口 |
| AC-05/07/10 | 4.5-4.8 | TASK-03/04/08 | V-04/05/09/13 | 待生成 | scope store 与 Mail/Chat schema 未实现 |
| AC-06/09/12/13 | 4.2-4.3/4.5 | TASK-06/07/08 | V-07/08/09/12/13 | 待生成 | 新 Rail 与 header 未实现 |
| AC-14 | 原型 | TASK-11 | V-12 | `output/ui-layout-refactor-prototype.png`（浏览器截图） | 仍需持续维护操作完整性 |

交付条件：实现阶段完成相关 AC、V-01 至 V-12，并完成 Windows 当前端 V-13；macOS/Linux 保留未验证结果与接续计划。未实现业务代码、未执行自动化和未执行真机验证不能由本设计文档标记为完成。

## 10. 风险、未决项与回退

- 迁移 `Tab` 到 Surface projection 时，最大风险是 PTY/SFTP/DB/Mail/Chat 生命周期被错误卸载；先保留现有 keep-mounted host，再逐类迁移。
- Workspace membership 的持久化介质尚未确定为 SQLite、现有 Rust command 还是前端 JSON。TASK-02 应优先复用现有 Rust/IPC persistence patterns；不得在 renderer localStorage 中存放需要跨窗口可靠共享的最终数据。若新增 Rust command，补 integration/native coverage。
- 多窗口/Detached session 的 membership 同步需要 BroadcastChannel/IPC 契约；第一阶段可只在主窗口读写，明确 detached window 通过 reattach 后重新 resolve membership。
- 旧 `sidebarRailPolicy`、`activeTabId`、`TabBar` 可能被已有 QA 与用户快捷键依赖。采用 projection 与旧 key 读取回退，完成切换后再删除旧路径。
- 原型与产品实现不得混用：原型中的示例 workspace/session 不是生产数据。
- 当前可开始：TASK-01、TASK-05（保持现有树的测试基线）、TASK-11；TASK-02 需先确定持久化复用路径，但可先写纯内存契约测试。TASK-03/04/06/07/08/09 等待 TASK-01/02 契约稳定。

## 11. 实施前冻结契约与完整用例交接

本节是对实现 agent 的强制补充，避免把 Workspace-first 误实现为一次性替换 `Tab/activeTabId` 的 rewrite。详细的 browser/native case 设计和受影响既有用例矩阵见 [`workspace-first-navigation-testcase-handoff.md`](workspace-first-navigation-testcase-handoff.md)。

### 11.1 稳定身份、生命周期与入口规则

- **Durable Workspace ID** 与 `RecentWorkspace.id` 分离。`RecentWorkspace.id` 继续作为按 roots/kinds 计算的 recents 去重键；首次将 Recent Workspace 固化为 Workspace 时生成稳定 UUID，重命名、增删 roots、改变 active file 均不改变 Workspace ID。迁移记录 `legacyRecentId`，重复迁移必须幂等。
- **Canonical Session** 只有 `SessionConfig.id` 一个身份，Workspace 只保存 membership，不复制 `SessionConfig`、凭据、`options_json` secrets、vault reference 或 Mail cache。
- **Ephemeral runtime session**：没有 Saved Session 的 local shell、command terminal、adopted terminal 或 attached SFTP 只生成 runtime `sessionRef`，不得因为打开 Surface 自动写入 `sessions` 表。用户选择“Save session”才进入 canonical store。
- **Surface instance** 具有独立 `surfaceId`。同一 canonical Session 可以有多个 terminal/database/mail Surface；关闭一个 Surface 不关闭其他实例或 canonical Session。`sourceTabId` 只用于迁移/回溯，不能作为持久化 canonical identity。
- **Standalone Session opening**：从 Sessions 视图直接打开 Session 时，默认进入 Session context，不自动写入 active Workspace membership；界面提供明确 `Add to Workspace`。从 Workspace 内点击 Session reference 才进入该 Workspace 的 Session Surface。
- **Workspace deletion** 只删除 memberships、Workspace navigation/layout 和 Workspace metadata，不删除 Session；删除 canonical Session 必须显示引用 Workspace 数量并由用户确认，确认后才可移除所有 memberships 和 Session。
- Membership 唯一键是 `(workspaceId, sessionId)`；重复添加是幂等 no-op。`primary`/`attached`/`reference` 角色变更必须是显式 patch；删除 primary 不自动提升另一个 reference，需显示“选择新的 primary / 保持无 primary”。
- **Unified Mail** 的 global surface 聚合全部 canonical Mail Sessions；Workspace surface 只聚合该 Workspace 的 Mail memberships。两个 surface 都按 Session ID 去重，不启动重复 sync worker，也不复制 credentials/cache。
- **Global Tool context** 使用 transient `contextWorkspaceId`/`contextSessionId`，不写 membership；离开工具后仍保持原 active Workspace。
- `welcome` 不创建伪 Workspace。无 Workspace 时 Work 视图显示创建/选择 Workspace 的空状态；Welcome compatibility Surface 可继续作为旧 Tab projection，但不可成为 durable Workspace。

### 11.2 严格的 SurfaceDescriptor 形状

不得使用同时带有可选 `workspaceId`、`sessionId` 的宽松接口。实现采用 discriminated union（字段名可按最终代码风格调整）：

```ts
export type SurfaceDescriptor =
  | {
      scope: "global";
      kind: GlobalSurfaceKind;
      surfaceId: string;
      contextWorkspaceId?: string;
      contextSessionId?: string;
    }
  | {
      scope: "workspace";
      kind: WorkspaceSurfaceKind;
      surfaceId: string;
      workspaceId: string;
    }
  | {
      scope: "session";
      kind: SessionSurfaceKind;
      surfaceId: string;
      sessionRef:
        | { kind: "canonical"; sessionId: string }
        | { kind: "ephemeral"; runtimeId: string };
      workspaceId?: string;
    }
  | {
      scope: "unavailable";
      kind: string;
      surfaceId: string;
      workspaceId?: string;
      sessionId?: string;
      reason: "missing-workspace" | "missing-session" | "unknown-kind" | "migration-error";
    };
```

`workspaceId` 对 `workspace` 必填；canonical `sessionId` 对 canonical Session Surface 必填；global context 字段只用于上下文，不改变 ownership。Resolver 必须对当前全部 `TabKind` 显式返回结果：

| 当前 TabKind | Surface scope | 迁移规则 |
|---|---|---|
| `terminal` | `session` | `tab.sessionId` 存在则 canonical；local/command/adopted 无 saved Session 时 ephemeral；workspaceId 仅作上下文 |
| `sftp` | `session` | `tab.sessionId` 是 canonical 时使用；`tab.sftp.sessionId` 是 runtime handle 时只能作为 ephemeral runtimeId；attached SFTP 继承 terminal workspace context |
| `rdp`, `vnc` | `session` | canonical `tab.sessionId` 优先，否则 ephemeral；detach 保留 surfaceId/scope |
| `database`, `redis`, `hbase-shell`, `object-storage` | `session` | canonical sessionId 优先；runtime DB connection 不成为 canonical Session；workspace query state 单独按 workspaceId 保存 |
| `mail` | `session` | Mail account 是 canonical Session；账号 surface 可被 Workspace membership 引用 |
| `mail-unified` | `global` | 可带 contextWorkspaceId；按 global 全量或 Workspace membership 聚合，禁止重复 sync |
| `git` | `workspace` | `sourceWorkspaceId`/`sourceWorkspaceInstanceId` 可解析则复用 Workspace；仅 repoRoot 的旧 standalone Git 必须显式创建/reuse Workspace shell，不复制 Session |
| `code-workspace` | `workspace` | `workspaceId` 是 durable Workspace 关联；`workspaceInstanceId` 是 editor runtime scope |
| `file-browser` | `workspace` / `session` / `global` | 有 Workspace binding 用 workspace；Saved File Session 用 session；ad-hoc local path 用 global context，不猜测为 Workspace |
| `nettools`, `sockscap`, `mfa`, `lan-chat`, `settings` | `global` | 不写 membership；使用 transient context |
| `proxy-test` | `session` | 有 SessionConfig 用 canonical；临时 proxy test 用 ephemeral sessionRef |
| `welcome` | `global` | compatibility Home surface；不创建 durable Workspace |
| `placeholder` 或未来未知类型 | `unavailable` | 保留原始 type/source，显示迁移/不支持原因，不能静默绑定 |

### 11.3 原生持久化与 hydration 顺序

Workspace records 和 membership 使用现有 `AppState.db` 对应的 `taomni.db` SQLite 连接与 Tauri command pattern（`src-tauri/src/session/db.rs`、`session/mod.rs`、`src/lib/ipc.ts`），而不是以 renderer `localStorage` 作为权威来源。建议新增 versioned tables（最终表名由实现 agent 与现有迁移习惯核对）：

- `workspaces`: `id`, `name`, `description`, `roots_json`, `settings_json`, `created_at`, `updated_at`, `last_opened_at`, `sort_order`, `revision`。
- `workspace_memberships`: `workspace_id`, `session_id`, `role`, `sort_order`, `pinned`, `default_surface`, `metadata_json`, timestamps；primary key `(workspace_id, session_id)`。
- `workspace_navigation`: `workspace_id`, `active_surface`, `layout_json`, `revision`, `updated_at`。
- `workspace_schema_meta`: schema version / migration marker only; no credentials.

每次 membership/workspace/navigation composite write 使用 SQLite transaction；已有 revision 不匹配时返回 conflict，前端重新读取再合并，不覆盖另一个窗口的更新。启动 hydration 顺序固定为：打开 DB → load canonical Sessions/Groups → load Workspaces/Memberships → resolve missing references → restore active Workspace/Surface → project legacy `activeTabId`/runtime Tabs。任何 Session 未加载前不得把 membership 判为 missing。

Rust command 需要定义输入、输出、错误和 event：`list_workspaces`, `get_workspace`, `save_workspace`, `delete_workspace`, `list_workspace_memberships`, `upsert_workspace_membership`, `remove_workspace_membership`, `save_workspace_navigation`；提交成功后 emit `workspace-state-changed`（workspaceId、revision、changed collections），多窗口订阅后按 revision reload。Browser fallback 可用 BroadcastChannel，但只作为 stub；不得把它当 native durability 证据。

Workspace records 不保存密码、private key、vault secret、Mail password/token、数据库 password 或完整 Session options；只保存 Session IDs 与非敏感 display metadata。

### 11.4 Detached / multi-window contract

Detached handoff payload 增加 `surfaceId`, `workspaceId?`, `sessionRef`, `surfaceKind`；凭据仍沿用现有 one-time handoff/claim，不复制进 Workspace 数据。`BroadcastChannel`/localStorage backstop 的 reattach message 要保留 scope 字段；主窗口按 `(kind, surfaceId)` 去重，重新 resolve membership 后才创建 compatibility Tab projection。Detached window 关闭/reattach 不删除 canonical Session 或 membership。

### 11.5 入口与快捷键影响清单

实施前必须建立 exhaustive inventory：

- `MainLayout.handleCommand`、`ControlBar.openMainMenu`、native menu `buildAppMenuSpec/installAppMenu`。
- `Ctrl/Cmd+1..9`, `Ctrl/Cmd+Shift+T/N/L/S`, `Ctrl/Cmd+Shift+H`, command palette/common commands、QuickConnect、Welcome cards、Sidebar Tools/SessionTree rows。
- 所有直接调用 `addTab`, `setActiveTab`, `removeTab`, `updateGitTabInfo`, `openCodeWorkspaceInfo`, `openGitTab`, `openMailTab`, `openDetached*` 的调用点。
- `App.tsx` detached routes：SFTP、terminal、RDP、VNC、database、LAN Chat、notes、servers、screenshot；每个 detached route 必须声明 scope 恢复策略。
- Existing QA controls/cases must be mapped to new Rail/Navigator/Surface IDs; no case is removed merely because its selector changed.
