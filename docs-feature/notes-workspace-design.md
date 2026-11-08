# Tao Notes 与 Workspace 联动

来源：本轮用户要求修复 Win11 Notes 光标错位，并新增默认 Notes space，支持像 txt/md 一样编辑、保留原 Notes 编辑入口，以及 Preview 跳转；阶段完成后创建分支、英文详细提交，并在 GitHub 执行指定三端 browser/native 工作流。

基线为 `1baeb208e`。代码事实：Notes 使用独立 `notes.db`，任务元数据、步骤、标签和提醒均由原有 Notes 模型持有；Workspace 有独立的工作区/Tab 持久化和 CodeMirror 编辑器。现有工作区文件路径代表真实文件，不应让笔记伪装成磁盘文件后进入 Git、LSP 或文件操作接口。

## 决策和交互

有效图稿：[v1，1280×650](notes-workspace/prototype.svg)。这是方案示意，不是产品或测试截图。

- DEC-01（用户已定，来源：本轮需求）：默认提供 Notes space；原 Tao Notes 快速编辑保留；大 Preview 跳转 Workspace。
- DEC-02（agent 自决，来源：已有 SQLite 权威数据和避免双份数据/迁移）：Notes space 通过专用 `note` Tab 引用原笔记 ID，复用 Workspace 的 `CodeMirrorHost` 和 `MarkdownPreview`。提供共享数据与真实 .md 两种方向的异步选择并展示 v1；未收到额外偏好后按现有数据共享继续，不将推荐写成用户批准。不新增物理文件导出/双向磁盘同步。
- DEC-03（agent 自决，来源：现有普通文件必须保留真实路径）：使用受保护的 `notes-workspace` 系统工作区，独立于 Default Workspace。笔记仅进入笔记导航，不进入文件/Git/LSP/终端路径。普通 Workspace 保持原实现。
- DEC-04（agent 自决，来源：并发保护）：两个编辑入口共享窗口内的草稿；跨窗口提交比较实际旧标题/正文，不用秒级时间戳作为版本。冲突/删除/保存失败保留草稿，提供复制、重载（显式放弃确认）或重试。

Notes 工作区的侧栏提供创建、搜索和笔记列表，包含完成和归档笔记，与 Tao Notes 的任务过滤器分开。Tab 标题显示笔记标题加 `.md`，稳定 ID 与标题无关。正文使用现有 Markdown 编辑和预览组件；编辑、分栏、预览切换保留编辑器实例、Undo 和选区。Workspace 中保存由按钮或 Ctrl+S（Windows/Linux）、Cmd+S（macOS）触发；原 Notes 标题/正文仍在失焦时保存。返回 Tao Notes 打开相同笔记和共享草稿。

## 状态和接口

`notesContentStore` 独立持有标题、正文、已保存内容、dirty/saving/error；UI 挂载不拥有保存请求。草稿同步写入 `taomni.notes.drafts.v1`，关闭 Tab、切换空间和重启后可恢复。保存时取快照，晚到结果只更新已保存基线，不能覆盖保存期间继续输入的内容。每个笔记的保存去重，读取和导航请求要检查生命周期/请求序列。

新增 `notes_save_content`，参数 `id/title/body/expectedTitle/expectedBody`（Rust snake_case 参数按 Tauri 默认 camelCase 接线）。SQLite 执行带 `WHERE id AND title AND body` 的条件更新，仅修改标题、正文、更新时间。结果为完整 `NoteItem`；错误包含 `kind: conflict | missing | storage` 和 `message`。不会重建已删除笔记、重置任务属性或清除提醒确认。

`taomni://notes-changed` 在成功的 Notes 内容/CRUD 操作后通知其他消费者重新读取。当前窗口事件同步发送；浏览器窗口使用 BroadcastChannel，原生使用 Tauri event。订阅按消费者引用计数持有，并释放异步注册后到达的 listener。独立便签窗口的大 Preview 使用 `taomni://notes-open-workspace` 请求主窗口导航并激活主窗口。

原有 `notes_update` 全量替换接口保留。UI 内容改走专用提交；任务属性修改前先提交草稿并读取当前完整笔记，再替换对应属性，避免使用旧渲染携带的正文。无数据库格式迁移、无外网访问及新增依赖。

## 工作包与验收

| 工作包 | 责任与文件边界 | 验收 |
|---|---|---|
| TASK-01 | `NoteTextField` 持有输入/链接预览和命中；`NoteEditor` 组合任务属性与共享草稿 | AC-01：输入光标/文字对齐；原有 URL、主题、完成/归档、步骤/标签与失焦保存保留 |
| TASK-02 | `notes/db/content*`、IPC、browser stub 提供原子内容保存；`notesContentStore/Recovery` 持有草稿及异步提交 | AC-02：内容编辑不修改任务元数据；并发、失败和删除保留草稿；保存期间继续输入不丢失 |
| TASK-03 | `workspaceNotes`、Workspace shell 和 `NotesWorkspace*` 提供系统 Notes space、导航、CodeMirror/Markdown 模式 | AC-03：默认空间可浏览/创建/搜索；标题变化不创建副本；Preview/返回打开同一笔记；Tab 切换/关闭/重开恢复草稿 |
| TASK-04 | `notesWorkspaceNavigation` 和主窗口 hook 处理独立窗口；`notesChanges/useNotesContentSync` 持有订阅 | AC-04：原生独立便签窗口可跳回主窗口；两个入口内容刷新；失效结果不污染新选择 |
| TASK-05 | Vitest/Rust/YAML、CI 注册及交付记录 | AC-05：相关正常行为、完整 crash-regression、指定 GitHub 三端 browser/native 验证；新分支与英文详细提交 |

本次拆分从 `NoteEditor` 提取文本输入及其命中、光标样式和滚动同步；不是仅移动大 shell。Native Notes 的命令识别移到 `commands/notes.rs`，避免继续扩大既有超限路由模块。公共命令名、笔记数据结构和旧持久化键保留。

## 验证及平台边界

| 验证 | 断言与方式 | 对应验收 |
|---|---|---|
| V-01 | `NotesPanel.test.tsx`、`notesStore.test.ts`、`noteLinks.test.ts`；基线 24/24 已通过 | AC-01 |
| V-02 | `notesContentStore.test.ts`：同笔记两个入口、晚到保存、冲突/删除、失败重试、重载期间输入、草稿恢复 | AC-02/04 |
| V-03 | Rust `notes::db::content::tests`：真实 SQLite 条件更新，内容更新保留元数据，旧保存拒绝且当前数据不变，删除不重建 | AC-02 |
| V-04 | `TC-NOTES-008` browser/native：中英文、URL、焦点真实文字层、键盘移动与插入、失焦预览和重开 | AC-01 |
| V-05 | `TC-NOTES-009` browser/native：Tao Notes→大 Preview→Workspace 编辑/保存→返回；草稿关闭/重开/刷新恢复；Notes 搜索/创建 | AC-03/04 |
| V-06 | 原有 Notes 001–004、相关 Workspace 单测/用例，完整 crash-regression 标记集合 | AC-01/03/05 |
| V-07 | `pnpm build`、`pnpm check:refactor`、Rust formatting；在 GitHub 指定工作流执行 selected + crash-regression，`native_release=true` | AC-05 |

Windows 使用 WebView2，macOS 使用 WKWebView，Linux 使用 WebKitGTK。代码不引入平台专属路径/控件。Markdown/文本编辑通过相同 CodeMirror 模块，macOS 保留 Command 编辑语义；系统菜单与 OS 键盘投递仍需独立核验，不能以桥接 press 冒充。Win11 物理机的缩放/IME复测步骤见 [光标修复设计](../docs-issue/notes-windows-caret-design.md)。托管 Windows Server 2025 的 native 结果只证明其 WebView2 环境。

实际执行结果、提交身份、GitHub run 和证据目录另记 `notes-workspace/delivery.md`。未执行条目保持待验证，图稿/构建/静态审计不充当运行证据。
