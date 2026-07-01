# Tao Ribbon 便签功能开发计划

状态：设计完成，待开发  
日期：2026-07-01  
目标读者：后续负责实现、测试和审查该功能的 AGENT

## 1. 整体目标

在 Taomni 中增加一个融合“便签 + 备忘录 + 任务管理”的统一便签功能，并与现有 Tao Ribbon 深度整合。

该功能不是三个独立模块，而是一个统一的“便签”能力：

- 所有记录都是便签。
- 每条便签都具备完成状态。
- 便签可通过截止时间、提醒时间、优先级、步骤、标签等属性自然承担任务管理能力。
- 便签正文、来源上下文、标签、颜色、置顶等属性承担备忘录能力。
- 默认入口是 Tao Ribbon，默认视图显示最近未完成便签。

最终产品结构：

```text
Tao Ribbon
- 四边任意位置悬浮
- 统一提醒入口
- 点击打开 Tao Hub 或最重要的待处理事件

Tao Hub
- Chat
- 便签

便签
- 单独 notes.db
- 单一 notes 数据模型
- 每条都有完成标识
- 最近未完成默认视图
- 搜索 / 过滤 / 标签 / 临期 / 过期
- 可选独立单例悬浮面板
- 主题可配置
```

## 2. 范围

### 2.1 本期范围

- 新增单独 SQLite 数据库 `notes.db`。
- 新增统一便签数据模型。
- 每条便签必须支持完成 / 未完成状态，默认未完成。
- 支持手工切换完成状态。
- 便签面板默认显示最近未完成便签。
- 支持搜索和过滤。
- 支持便签主题配置。
- Tao Ribbon 支持在窗口四周任意位置悬浮。
- Tao Ribbon 可展示提醒状态并跳动提示。
- AI 对话完成后通过 Tao Ribbon 提醒。
- 待办临期 / 过期通过 Tao Ribbon 提醒。
- Tao Hub 中只有两个主 tab：`Chat` 和 `便签`。
- 便签可配置为单独单例悬浮面板。
- AI 对话框位于上 / 下边时也支持 pinned。

### 2.2 本期不做

- 不拆分独立的“备忘录”tab。
- 不拆分独立的“任务”tab。
- 不使用 `tao.db` 存储便签数据。
- 不把便签数据混入现有 `taomni.db`。
- 不做多个独立便签 OS 窗口。
- 不做云同步。
- 不做多人协作。
- 不做系统关闭后的跨进程提醒调度。
- 不做完整自然语言任务解析，只预留扩展点。
- 不做邮件模块本身；只预留 Tao Ribbon 事件入口。

## 3. 现有集成点

### 3.1 Tao Ribbon / Chat Drawer

当前 Tao Ribbon 主要在：

- `src/components/chat/ChatDrawer.tsx`
- `src/layouts/MainLayout.tsx`
- `src/stores/chatStore.ts`

现状：

- `ChatDrawerRibbon` 是边缘小按钮，显示 `Tao`。
- 点击 / 悬停打开 `ChatDrawer`。
- 当前位置是四边之一，不支持边上任意 offset。
- 左右 pinned 已有较完整交互。
- 上下浮动已有基础，但 pinned 行为需要补齐。

目标：

- 将 `ChatDrawerRibbon` 抽象为统一 `TaoRibbon`。
- 将 `ChatDrawer` 逐步纳入 `TaoHubDrawer` 的 `Chat` tab。
- 新增 `便签` tab。
- 保持单一 Tao Ribbon，不新增第二个边缘入口。

### 3.2 数据存储

当前主应用数据库为 app data 下的 `taomni.db`。

便签必须使用单独 SQLite：

```text
app_data_dir/
  taomni.db
  notes.db
  vault.db
```

后端实现建议新增 Rust 模块：

```text
src-tauri/src/notes/
  mod.rs
  db.rs
  commands.rs
```

前端 IPC 封装建议新增：

```text
src/lib/notes.ts
src/stores/notesStore.ts
src/components/notes/
```

浏览器预览 stub 建议在 `src/stubs/tauri-core.ts` 使用 localStorage 模拟。

## 4. 信息架构

### 4.1 Tao Hub 主结构

Tao Hub 只有两个主 tab：

```text
Chat | 便签
```

切换规则：

- 点击 Tao Ribbon：打开上次使用的 Tao Hub tab。
- 如果存在最高优先级提醒事件，点击 Tao Ribbon 优先进入该事件目标。
- AI 完成事件：打开 `Chat` tab 并定位对应 thread。
- 便签临期事件：打开 `便签` tab 并定位对应 note。
- 多个事件：打开轻量事件列表，再由用户选择。

### 4.2 便签 tab 结构

默认布局：

```text
顶部工具栏
- 新建便签
- 搜索框
- 过滤器
- 主题入口 / 设置入口

左侧或顶部过滤
- 最近未完成
- 全部
- 置顶
- 今日
- 临期
- 过期
- 已完成
- 归档
- 标签

主体
- 便签列表
- 当前便签编辑区
```

窄宽度时：

- 搜索与过滤合并到紧凑工具栏。
- 列表优先展示。
- 编辑区通过点击列表项进入。

默认视图：

```text
最近未完成
```

排序建议：

1. pinned desc
2. due_at asc，null 最后
3. updated_at desc

### 4.3 单独悬浮便签面板

便签可以配置为单独单例悬浮面板：

- 默认关闭，便签显示在 Tao Hub 内。
- 开启后，便签从 Tao Hub 中以单例浮层显示。
- 仍然只有一个便签面板，不创建多个便签窗口。
- 面板可拖动、调整大小、固定位置。
- 面板默认展示最近未完成便签。
- 面板可设置主题。

配置项示例：

```text
notes.panel.mode = "hub" | "floating"
notes.panel.position = { x, y, width, height }
notes.panel.alwaysOnTopInApp = true | false
notes.panel.theme = "taomni" | "system" | "light" | "dark" | "paper" | "compact"
```

说明：

- `alwaysOnTopInApp` 仅指 Taomni 主窗口内部层级置顶。
- 跨应用置顶需要真实 OS 窗口，暂不纳入本期。

## 5. 数据设计

### 5.1 数据库文件

数据库文件名：

```text
notes.db
```

位置：

```text
app.path().app_data_dir()/notes.db
```

原则：

- 不与 `taomni.db` 混用。
- 不以 `tao` 命名。
- 数据库初始化独立。
- 后续导入导出、备份、加密可独立演进。

### 5.2 表结构

建议 schema：

```sql
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  color TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  reminder_at INTEGER,
  repeat_rule TEXT,
  source_tab_id TEXT,
  source_session_id TEXT,
  source_title TEXT,
  source_uri TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_steps (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  completed_at INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS note_tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_tag_links (
  note_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES note_tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS note_prefs (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note_alert_events (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  fire_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_active
  ON notes(completed_at, archived_at, pinned, due_at, updated_at);

CREATE INDEX IF NOT EXISTS idx_notes_due
  ON notes(due_at);

CREATE INDEX IF NOT EXISTS idx_notes_reminder
  ON notes(reminder_at);

CREATE INDEX IF NOT EXISTS idx_note_steps_note
  ON note_steps(note_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_note_alert_events_state
  ON note_alert_events(state, fire_at);
```

### 5.3 完成状态

所有便签都有完成状态：

- `completed_at IS NULL` 表示未完成。
- `completed_at IS NOT NULL` 表示已完成。
- UI 上表现为复选框。
- 用户可以随时手工切换。
- 完成不自动归档。
- 归档独立使用 `archived_at`。

### 5.4 任务属性

任务能力是便签属性，不是独立类型：

- `due_at`：截止时间。
- `reminder_at`：提醒时间。
- `repeat_rule`：重复规则，建议使用简化 iCal RRULE 字符串或 JSON。
- `priority`：0 普通，1 低，2 中，3 高。
- `note_steps`：子步骤。

是否为“任务”由属性自然决定：

```text
有 due_at / reminder_at / steps / priority 时，UI 可表现为任务型便签。
```

不要新增 `kind = task`。

## 6. IPC 设计

### 6.1 Rust commands

建议新增命令：

```text
notes_list
notes_get
notes_create
notes_update
notes_delete
notes_toggle_complete
notes_archive
notes_list_tags
notes_upsert_tags
notes_set_steps
notes_get_prefs
notes_set_prefs
notes_list_alerts
notes_ack_alert
```

### 6.2 前端封装

建议新增：

```text
src/lib/notes.ts
```

导出类型和 API：

```ts
export interface NoteItem { ... }
export interface NoteStep { ... }
export interface NoteTag { ... }
export interface NoteQuery { ... }

export async function listNotes(query: NoteQuery): Promise<NoteItem[]>;
export async function createNote(input: CreateNoteInput): Promise<NoteItem>;
export async function updateNote(id: string, patch: UpdateNoteInput): Promise<NoteItem>;
export async function toggleNoteComplete(id: string, completed: boolean): Promise<NoteItem>;
```

### 6.3 Store

建议新增：

```text
src/stores/notesStore.ts
```

职责：

- 保存当前列表、筛选、搜索、选中 note。
- 管理便签面板开关、位置、主题。
- 周期性或事件驱动刷新临期提醒。
- 向 Tao Ribbon 暴露 badge / alert 状态。

不要把 notes 状态混入 `chatStore`。

## 7. Tao Ribbon 设计

### 7.1 位置

当前四边中点需要升级为四边任意位置：

```ts
type TaoRibbonEdge = "left" | "right" | "top" | "bottom";

interface TaoRibbonPlacement {
  edge: TaoRibbonEdge;
  offsetRatio: number; // 0 到 1，表示沿该边的位置
}
```

拖动规则：

- 拖动时根据鼠标距离最近的窗口边决定 edge。
- 在该边投影为 offset。
- offset 使用 ratio 存储，窗口 resize 后位置保持相对稳定。
- clamp 避免遮挡标题栏交通灯、窗口控制按钮、状态栏、resize handle。
- 设置持久化到 localStorage 或 notes prefs；推荐短期放 localStorage，后续统一迁入 prefs。

### 7.2 状态提示

Tao Ribbon 需要展示统一状态：

```text
idle
ai_done
note_due_soon
note_overdue
mail_new_future
multiple
```

表现：

- `ai_done`：轻微跳动 / 呼吸光，显示 AI 小徽标。
- `note_due_soon`：黄色点或数字。
- `note_overdue`：红色点或数字。
- `multiple`：数字徽标。
- 提醒动画应节制，不要持续高频跳动。

建议动画策略：

- 新事件出现时跳动 2-3 次。
- 未处理期间保留徽标。
- 用户打开目标后 ack。

### 7.3 点击行为

点击 Tao Ribbon：

1. 如果有未处理高优先级事件，打开该事件目标。
2. 如果有多个事件，打开事件列表。
3. 否则打开上次使用的 Tao Hub tab。

事件优先级：

1. note_overdue
2. note_due_soon
3. ai_done
4. mail_new_future

右键或长按可提供快捷菜单：

- 新建便签
- 新建带截止时间的便签
- 打开最近未完成
- 打开 Chat
- 打开提醒列表

## 8. AI 对话框 pinned 设计

### 8.1 当前问题

现有 Chat Drawer 左右 pinned 较完整；上 / 下方向主要是浮动抽屉语义。

目标：

- 当 Tao Ribbon 或 Chat Drawer 位置为 top / bottom 时，AI 对话框也可 pinned。
- pinned 后成为主内容区的一部分，不因点击外部关闭。

### 8.2 行为

top pinned：

```text
ControlBar
Pinned Chat Drawer
Main Work Area
StatusBar
```

bottom pinned：

```text
ControlBar
Main Work Area
Pinned Chat Drawer
StatusBar
```

要求：

- 高度可拖动调整。
- pinned 状态持久化。
- 宽度默认占满工作区，保留左右边距或与工作区对齐。
- 窄窗口下自动回退为浮动或隐藏到 Tao Ribbon。
- Chat 正在生成时，隐藏面板不应中断任务。

## 9. 便签主题设计

便签窗口主题可配置。

第一版建议支持：

```text
taomni  - 跟随当前 Taomni 主题变量
system  - 跟随系统
light   - 强制浅色
dark    - 强制深色
paper   - 便签纸风格
compact - 高密度列表风格
```

注意：

- 不要使用过度装饰。
- 与 Taomni 主 UI 保持一致。
- 主题只影响便签面板和便签卡片，不应破坏全局应用主题。
- 所有文本必须在浅色 / 深色下可读。

## 10. 提醒设计

### 10.1 便签提醒

提醒来源：

- `due_at` 临期。
- `due_at` 已过期。
- `reminder_at` 到点。

运行方式：

- App 运行期间，前端或后端定时检查。
- 建议后端提供 `notes_list_alerts`，前端定时拉取。
- 后续可改为 Tauri event push。

临期规则建议：

```text
due_at 在未来 30 分钟内：due_soon
due_at 已过去且未完成：overdue
reminder_at 已到且未完成：reminder
```

### 10.2 AI 完成提醒

当 Chat thread 后台生成完成且对应 Chat 面板不在当前可见状态：

- 生成 `ai_done` 前端事件。
- Tao Ribbon 显示提醒。
- 点击打开对应 Chat thread。

### 10.3 新邮件预留

本期不实现邮件模块，但 Tao Ribbon 事件结构需可扩展：

```ts
type TaoAlertSource = "chat" | "notes" | "mail";
```

未来新邮件事件可复用同一 badge / 跳转机制。

## 11. 前端组件建议

建议新增：

```text
src/components/tao/TaoRibbon.tsx
src/components/tao/TaoHubDrawer.tsx
src/components/tao/TaoAlertInbox.tsx

src/components/notes/NotesPanel.tsx
src/components/notes/NotesList.tsx
src/components/notes/NoteEditor.tsx
src/components/notes/NoteFilters.tsx
src/components/notes/NoteThemeSettings.tsx
src/components/notes/FloatingNotesPanel.tsx
```

迁移方式：

1. 先保留现有 `ChatDrawer` 行为。
2. 抽出 `TaoRibbon`，保持现有 Chat 打开逻辑不变。
3. 引入 `TaoHubDrawer`，把 Chat 放入第一个 tab。
4. 增加 Notes tab。
5. 最后补齐事件 badge、上/下 pinned、独立便签浮层。

这样风险低于一次性重写 Chat Drawer。

## 12. 开发任务步骤

### 阶段 0：确认设计

状态：完成

- [x] 明确便签 / 备忘 / 任务合并为一个功能。
- [x] 明确 UI 上只有一个 `便签` tab。
- [x] 明确所有便签都有完成状态。
- [x] 明确数据库使用单独 `notes.db`。
- [x] 明确 Tao Ribbon 是统一入口。
- [x] 明确 Tao Ribbon 四边任意位置悬浮。
- [x] 明确 AI 完成、便签临期可触发 Tao Ribbon 提醒。

### 阶段 1：数据层

状态：未开始

- [ ] 新增 `src-tauri/src/notes/` 模块。
- [ ] 在 app setup 中打开 `notes.db`。
- [ ] 初始化 notes schema。
- [ ] 实现 notes CRUD。
- [ ] 实现完成 / 未完成切换。
- [ ] 实现搜索和过滤查询。
- [ ] 实现 tags 和 steps。
- [ ] 实现 prefs 表读写。
- [ ] 实现 alert 查询。
- [ ] 添加 Rust 单元测试。

验收：

- [ ] `notes.db` 独立生成。
- [ ] 不修改 `taomni.db` schema。
- [ ] 创建、更新、完成、归档、搜索均可通过 Rust 测试。

### 阶段 2：IPC 与前端 store

状态：未开始

- [ ] 在 Tauri command handler 注册 notes commands。
- [ ] 新增 `src/lib/notes.ts`。
- [ ] 新增 `src/stores/notesStore.ts`。
- [ ] 在 browser stub 中实现 notes commands 降级。
- [ ] 添加 Vitest 覆盖 store 行为。

验收：

- [ ] `pnpm test` 中 notes store 测试通过。
- [ ] 浏览器预览可创建和读取便签。
- [ ] Tauri 环境读写 `notes.db`。

### 阶段 3：Tao Ribbon 抽象

状态：未开始

- [ ] 从 `ChatDrawerRibbon` 抽象 `TaoRibbon`。
- [ ] 支持 `edge + offsetRatio` 位置模型。
- [ ] 支持拖到四边任意位置。
- [ ] 保持现有点击打开 Chat 的兼容行为。
- [ ] 持久化 ribbon 位置。
- [ ] 添加测试覆盖拖动位置计算。

验收：

- [ ] Ribbon 可贴左 / 右 / 上 / 下任意位置。
- [ ] 窗口 resize 后位置合理。
- [ ] 不遮挡窗口控制按钮和状态栏。
- [ ] 现有 Chat Tao 行为不回退。

### 阶段 4：Tao Hub

状态：未开始

- [ ] 新增 `TaoHubDrawer`。
- [ ] 主 tab 仅包含 `Chat` 和 `便签`。
- [ ] 将现有 Chat Drawer 内容嵌入 Chat tab。
- [ ] 记录上次使用 tab。
- [ ] 保留 drawer resize、hide、pin 交互。

验收：

- [ ] 点击 Tao Ribbon 可打开 Tao Hub。
- [ ] Chat 原有发消息、历史、pin、hide 行为正常。
- [ ] 可以切换到便签 tab。

### 阶段 5：便签 UI

状态：未开始

- [ ] 新增 NotesPanel。
- [ ] 默认显示最近未完成。
- [ ] 支持新建便签。
- [ ] 支持编辑标题和正文。
- [ ] 支持完成 / 未完成切换。
- [ ] 支持置顶、颜色、归档。
- [ ] 支持 due_at、reminder_at、priority。
- [ ] 支持 steps。
- [ ] 支持搜索。
- [ ] 支持过滤视图。
- [ ] 支持标签。
- [ ] 添加 Vitest 组件测试。

验收：

- [ ] 新建便签默认未完成。
- [ ] 最近未完成视图只显示未完成、未归档便签。
- [ ] 完成后从默认视图移出。
- [ ] 搜索可匹配标题、正文、标签。
- [ ] 过滤切换正确。

### 阶段 6：便签主题与悬浮面板

状态：未开始

- [ ] 增加便签主题配置。
- [ ] 实现 `taomni/system/light/dark/paper/compact`。
- [ ] 新增单例 FloatingNotesPanel。
- [ ] 支持 hub / floating 模式切换。
- [ ] 持久化浮层位置和尺寸。
- [ ] 支持 Taomni 内部 always-on-top。

验收：

- [ ] 主题切换后便签面板即时更新。
- [ ] FloatingNotesPanel 只出现一个。
- [ ] 关闭后配置仍保留。
- [ ] 浅色 / 深色下无不可读文本。

### 阶段 7：提醒和 Tao Ribbon badge

状态：未开始

- [ ] 建立 Tao alert event 模型。
- [ ] Notes store 定时刷新临期 / 过期事件。
- [ ] Chat 完成后产生 `ai_done` 事件。
- [ ] Tao Ribbon 显示 badge / 跳动提示。
- [ ] 点击事件可跳转到目标。
- [ ] 多事件时显示 TaoAlertInbox。
- [ ] 添加测试覆盖事件优先级。

验收：

- [ ] AI 后台完成时 Ribbon 有提示。
- [ ] 临期便签有黄色提示。
- [ ] 过期便签有红色提示。
- [ ] 点击可打开对应 Chat thread 或 Note。
- [ ] 打开目标后提醒可 ack。

### 阶段 8：上 / 下 pinned Chat

状态：未开始

- [ ] 扩展 Chat Drawer pinned 状态到 top / bottom。
- [ ] MainLayout 支持顶部 / 底部 pinned 区域。
- [ ] 支持高度调整。
- [ ] 窄窗口下自动回退。
- [ ] 添加布局测试。

验收：

- [ ] Chat 位于 top 时可 pin。
- [ ] Chat 位于 bottom 时可 pin。
- [ ] pinned 后点击外部不关闭。
- [ ] resize 正常。
- [ ] 左右 pinned 现有行为不回退。

### 阶段 9：E2E 与回归

状态：未开始

- [ ] 增加 qa-ui-auto testcase。
- [ ] 覆盖 Tao Ribbon 拖动。
- [ ] 覆盖打开 Tao Hub。
- [ ] 覆盖便签创建、完成、过滤。
- [ ] 覆盖 FloatingNotesPanel。
- [ ] 覆盖提醒跳转。
- [ ] 回归现有 Chat Drawer 测试。

验收：

- [ ] `pnpm test` 通过。
- [ ] `pnpm build` 通过。
- [ ] `cd src-tauri && cargo test` 通过或明确记录未跑原因。
- [ ] qa-ui-auto 新增用例通过。

## 13. 测试计划

### 13.1 Rust 测试

覆盖：

- schema 初始化幂等。
- CRUD。
- completed_at 切换。
- 默认查询最近未完成。
- 搜索。
- 标签关联。
- steps 排序。
- alert 查询。
- prefs 读写。

### 13.2 Vitest

覆盖：

- notesStore 初始加载。
- 创建 note。
- 更新 note。
- toggle complete。
- filter/search。
- floating prefs。
- Tao alert 优先级。
- ribbon placement clamp。

### 13.3 UI 自动化

建议新增用例：

```text
TC-0XX-tao-ribbon-drags-to-arbitrary-edge-position.testcase.yaml
TC-0XX-tao-hub-opens-notes-tab.testcase.yaml
TC-0XX-notes-create-and-complete.testcase.yaml
TC-0XX-notes-filter-recent-incomplete.testcase.yaml
TC-0XX-notes-floating-panel-theme.testcase.yaml
TC-0XX-tao-ribbon-alert-jumps-to-due-note.testcase.yaml
TC-0XX-chat-top-bottom-pin.testcase.yaml
```

## 14. 风险与注意事项

- 不要破坏现有 AI Chat Drawer 行为。
- 不要把便签数据写入 `taomni.db`。
- 不要新增多个 OS 窗口。
- Tao Ribbon 动画要克制，避免持续干扰。
- 便签 floating 面板层级不能遮挡系统级弹窗、认证弹窗、vault 解锁弹窗。
- 上 / 下 pinned 会影响 MainLayout 布局，需重点回归终端、SFTP、数据库、RDP/VNC。
- 所有新增 UI 文案需进入 i18n。
- 所有按钮需要 title / aria-label，便于测试和可访问性。
- 主题必须同时检查浅色和深色。

## 15. 完成定义

该功能完成时应满足：

- 用户可通过同一个 Tao Ribbon 打开 Chat 和便签。
- 用户可创建、编辑、完成、搜索、过滤便签。
- 默认便签视图显示最近未完成便签。
- 数据持久化在独立 `notes.db`。
- Tao Ribbon 可在窗口四边任意位置悬浮。
- Chat 上 / 下位置可 pinned。
- AI 完成和便签临期 / 过期可通过 Tao Ribbon 提醒并跳转。
- 便签可配置为单独单例悬浮面板。
- 便签主题可配置。
- 单元测试、构建、必要 UI 自动化测试通过。
