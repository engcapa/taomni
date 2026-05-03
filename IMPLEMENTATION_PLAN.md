# NewMob 实施计划

> 基于 DESIGN.md 拆分的可执行任务清单，每个任务独立可交付，适合逐个交给 AI coding agent 执行。

---

## Phase 1：骨架与本地终端（MVP）

### Task 1.1 — 项目初始化 ✅ DONE

**范围：** 创建 Tauri 2 + React + TypeScript + Vite 项目骨架

**具体步骤：**
1. 使用 `cargo create-tauri-app` 创建项目，选择 React + TypeScript + Vite
2. 安装前端依赖：tailwindcss, zustand, lucide-react, react-resizable-panels
3. 配置 TailwindCSS（tailwind.config.js + index.css）
4. 配置 tauri.conf.json（窗口尺寸 1280×800，最小 800×600，productName: NewMob）
5. 创建 Rust 端目录结构：`src-tauri/src/{terminal,session,filebrowser,tunnel,nettools,serial,config}/`
6. 添加 Rust 依赖到 Cargo.toml（tokio, serde, serde_json, uuid, tracing）
7. 创建 `src-tauri/src/state.rs` 定义 AppState 骨架
8. 前端创建目录结构：`src/{components,stores,hooks,lib,types}/`

**产出文件：**
- `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
- `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/state.rs`
- `src/main.tsx`, `src/App.tsx`, `src/index.css`

**验收：** `cargo tauri dev` 能启动空白窗口，TailwindCSS 生效

---

### Task 1.2 — 主布局框架 ✅ DONE

**范围：** 实现主窗口三栏布局（侧边栏 + 标签栏 + 内容区）

**具体步骤：**
1. 创建 `src/layouts/MainLayout.tsx`，使用 react-resizable-panels 实现可拖拽分栏
2. 创建 `src/components/sidebar/Sidebar.tsx` — 左侧边栏容器（占位）
3. 创建 `src/components/tabbar/TabBar.tsx` — 标签栏（新建/关闭/切换）
4. 创建 `src/components/statusbar/StatusBar.tsx` — 底部状态栏
5. 创建 `src/stores/appStore.ts` — Zustand store（tabs, activeTabId, sidebarWidth）
6. 从 mob-design 原型提取 CSS 变量到 `src/index.css`（--moba-* 变量体系）
7. 实现标签页基础交互：点击切换、中键关闭、+ 按钮新建

**参考原型：** `mob-design/.../MainWindow.tsx` 的整体布局结构

**产出文件：**
- `src/layouts/MainLayout.tsx`
- `src/components/sidebar/Sidebar.tsx`
- `src/components/tabbar/TabBar.tsx`
- `src/components/statusbar/StatusBar.tsx`
- `src/stores/appStore.ts`
- `src/types/index.ts`（Tab, ConnectionStatus 等类型定义）

**验收：** 应用显示三栏布局，标签页可新建/切换/关闭，侧边栏可拖拽调整宽度

---

### Task 1.3 — xterm.js 终端组件 ✅ DONE

**范围：** 封装 xterm.js 为 React 组件，纯前端（暂不接后端）

**具体步骤：**
1. 安装 xterm 相关包：`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-web-links`
2. 创建 `src/components/terminal/TerminalPanel.tsx`
   - useRef 持有 xterm Terminal 实例
   - useEffect 中初始化 Terminal + FitAddon + WebglAddon（try-catch fallback）
   - ResizeObserver 监听容器尺寸变化，debounce 150ms 后调用 fitAddon.fit()
   - 暴露 props：`sessionId`, `onData`, `onResize`, `theme`
3. 创建 `src/lib/themes.ts` — 终端主题定义（dark/light，从 DESIGN.md 9.2 节取）
4. 创建 `src/hooks/useTerminal.ts` — 终端生命周期管理 hook
5. 在 MainLayout 中，当新建标签页时渲染 TerminalPanel

**注意事项：**
- xterm 必须在 DOM 挂载后初始化（useEffect with ref check）
- WebGL addon 可能失败，需 try-catch 降级到 canvas renderer
- 组件卸载时必须调用 terminal.dispose()

**产出文件：**
- `src/components/terminal/TerminalPanel.tsx`
- `src/hooks/useTerminal.ts`
- `src/lib/themes.ts`

**验收：** 新建标签页显示空白终端（黑底），能输入字符（本地回显），resize 时终端自适应

---

### Task 1.4 — Rust PTY 后端 ✅ DONE

**范围：** 实现本地终端的 Rust 后端（PTY 创建、读写、resize）

**具体步骤：**
1. 添加 Cargo 依赖：`portable-pty = "0.8"`, `uuid = { version = "1", features = ["v4"] }`
2. 创建 `src-tauri/src/terminal/mod.rs`
3. 创建 `src-tauri/src/terminal/pty.rs`，实现：
   - `create_pty(cols, rows, shell, cwd)` → 返回 (PtyPair, Child)
   - 平台判断默认 shell：Linux/macOS → `/bin/bash` 或 `$SHELL`，Windows → `powershell.exe`
4. 在 `terminal/mod.rs` 实现 Tauri commands：
   - `create_local_terminal` — 创建 PTY，存入 AppState.terminals，启动 tokio::spawn 读取循环
   - `write_terminal` — 向 PTY 写入数据（接收 base64 编码字符串）
   - `resize_terminal` — 调整 PTY 尺寸
   - `close_terminal` — 关闭 PTY，从 AppState 移除
5. 读取循环：4KB buffer，读到数据后 base64 编码，通过 `app_handle.emit("terminal-output-{session_id}", data)` 推送
6. 在 `src-tauri/src/lib.rs` 注册所有 commands

**关键数据流：**
```
前端 invoke("create_local_terminal") → 后端创建 PTY → 返回 session_id
后端 spawn 读取循环 → emit("terminal-output-{id}") → 前端 listen 写入 xterm
前端 xterm.onData → invoke("write_terminal", {session_id, data_base64})
前端 resize → invoke("resize_terminal", {session_id, cols, rows})
```

**产出文件：**
- `src-tauri/src/terminal/mod.rs`
- `src-tauri/src/terminal/pty.rs`
- 修改 `src-tauri/src/lib.rs`（注册 commands）
- 修改 `src-tauri/src/state.rs`（完善 AppState）

**验收：** `cargo tauri dev` 无编译错误，commands 注册成功

---

### Task 1.5 — 前后端数据流打通 ✅ DONE

**范围：** 连接 xterm.js 前端与 Rust PTY 后端，实现完整终端交互

**具体步骤：**
1. 创建 `src/lib/ipc.ts` — 封装 Tauri invoke/listen 调用
   - `createLocalTerminal(cols, rows)` → Promise<string>
   - `writeTerminal(sessionId, data)` → Promise<void>
   - `resizeTerminal(sessionId, cols, rows)` → Promise<void>
   - `closeTerminal(sessionId)` → Promise<void>
   - `listenTerminalOutput(sessionId, callback)` → UnlistenFn
2. 修改 `src/hooks/useTerminal.ts`：
   - 组件挂载时调用 createLocalTerminal 获取 sessionId
   - 注册 listenTerminalOutput，收到数据后 base64 decode 写入 xterm
   - xterm.onData 回调中 base64 encode 后调用 writeTerminal
   - fitAddon.fit() 后获取 cols/rows 调用 resizeTerminal
   - 组件卸载时调用 closeTerminal + unlisten
3. 修改 `src/stores/appStore.ts`：Tab 类型增加 connectionId 字段
4. 修改 `src/components/tabbar/TabBar.tsx`：新建标签页时创建终端连接

**注意事项：**
- base64 编解码用于 IPC 传输二进制数据（终端输出可能包含非 UTF-8）
- listen 返回的 unlisten 函数必须在组件卸载时调用，防止内存泄漏
- 首次 fit 需要在 terminal open 之后执行

**产出文件：**
- `src/lib/ipc.ts`
- 修改 `src/hooks/useTerminal.ts`
- 修改 `src/stores/appStore.ts`
- 修改 `src/components/terminal/TerminalPanel.tsx`

**验收：** 打开应用 → 新建标签页 → 出现本地 shell → 能执行 `ls`, `pwd` 等命令 → resize 窗口终端自适应

---

## Phase 2：SSH 连接与会话管理

### Task 2.1 — SQLite 数据库与会话模型 ✅ DONE

**范围：** 建立会话持久化存储层

**具体步骤：**
1. 添加 Cargo 依赖：`rusqlite = { version = "0.31", features = ["bundled"] }`
2. 创建 `src-tauri/src/session/models.rs` — 定义 SessionConfig, SessionType, AuthMethod, SessionOptions 等结构体（从 DESIGN.md 3.2 节复制）
3. 创建 `src-tauri/src/session/db.rs`：
   - `init_db(path)` — 创建 sessions 和 session_groups 表（DDL 从 DESIGN.md 复制）
   - `list_sessions(group)` → Vec<SessionConfig>
   - `get_session(id)` → SessionConfig
   - `save_session(config)` — INSERT OR REPLACE
   - `delete_session(id)`
   - `list_groups()` → Vec<SessionGroup>
4. 创建 `src-tauri/src/session/mod.rs` — 暴露 Tauri commands
5. 修改 `src-tauri/src/state.rs` — AppState 增加 db 字段
6. 在 app setup 中初始化数据库（路径：`app_data_dir/newmob.db`）

**产出文件：**
- `src-tauri/src/session/mod.rs`
- `src-tauri/src/session/models.rs`
- `src-tauri/src/session/db.rs`

**验收：** 编译通过，能通过 Tauri command 增删改查会话配置

---

### Task 2.2 — 会话树侧边栏 ✅ DONE

**范围：** 左侧边栏显示会话分组树

**具体步骤：**
1. 创建 `src/components/sidebar/SessionTree.tsx` — 树形会话列表
   - 支持文件夹展开/折叠
   - 双击会话项 → 触发连接
   - 右键菜单：连接、编辑、复制、删除
   - 拖拽移动到分组
2. 创建 `src/stores/sessionStore.ts` — 会话列表状态
   - loadSessions() 从后端加载
   - 按 group 分组展示
3. 在 `src/lib/ipc.ts` 增加会话相关 IPC 封装
4. 侧边栏底部增加「最近连接」区域

**参考原型：** `mob-design/.../MainWindow.tsx` 的 TreeFolder/TreeItem 组件

**产出文件：**
- `src/components/sidebar/SessionTree.tsx`
- `src/stores/sessionStore.ts`
- 修改 `src/lib/ipc.ts`
- 修改 `src/components/sidebar/Sidebar.tsx`

**验收：** 侧边栏显示会话树，支持展开折叠，双击触发连接（暂时只打开本地终端）

---

### Task 2.3 — 会话编辑对话框 ✅ DONE

**范围：** 新建/编辑会话的配置表单

**具体步骤：**
1. 创建 `src/components/session/SessionEditor.tsx` — 模态对话框
   - 协议选择器（SSH, Telnet, RDP, VNC, FTP, SFTP, Serial, Shell）
   - SSH 基础设置：host, port, username, auth method
   - 高级 SSH 设置标签页：X11, 压缩, 执行命令, 跳板机
   - 终端设置标签页：字体, 颜色, 主题
   - 书签设置标签页：名称, 分组, 标签, 快捷键
2. 创建 `src/components/session/SessionQuickConnect.tsx` — 快速连接栏
   - 地址栏式输入：`ssh user@host:port`
   - 解析输入自动填充协议/用户/主机/端口
3. 表单提交调用 `save_session` IPC

**参考原型：** `mob-design/.../SessionDialog.tsx`（完整的表单布局和字段定义）

**产出文件：**
- `src/components/session/SessionEditor.tsx`
- `src/components/session/SessionQuickConnect.tsx`
- 修改 `src/layouts/MainLayout.tsx`（集成快速连接栏）

**验收：** 能打开会话编辑对话框，填写 SSH 配置并保存，侧边栏实时更新

---

### Task 2.4 — SSH 连接后端 ✅ DONE

**范围：** Rust 端实现 SSH 连接（russh）

**具体步骤：**
1. 添加 Cargo 依赖：`russh = "0.46"`, `russh-keys = "0.46"`
2. 创建 `src-tauri/src/terminal/ssh.rs`：
   - 实现 `russh::client::Handler` trait（处理认证回调、host key 验证）
   - `connect_ssh(host, port, username, auth, cols, rows)` → (Handle, Channel)
   - 支持三种认证：Password, PrivateKey（从文件读取）, Agent
   - 请求 PTY channel（term="xterm-256color"）
   - 启动 shell
3. 修改 `src-tauri/src/terminal/mod.rs`：
   - 实现 `create_ssh_terminal` command
   - SSH channel 读取循环复用与本地 PTY 相同的 event 推送机制
   - SSH 连接存入 AppState.terminals（TerminalSession::Ssh 变体）
4. 添加 Cargo 依赖：`keyring = "3"` 用于凭证存储
5. 创建 `src-tauri/src/config/keyring.rs` — 密码存取封装

**注意事项：**
- russh Handler trait 需要处理 `check_server_key` 回调（首次连接需确认）
- 私钥读取用 `russh_keys::load_secret_key`
- SSH Agent 认证需要连接系统 ssh-agent socket

**产出文件：**
- `src-tauri/src/terminal/ssh.rs`
- `src-tauri/src/config/keyring.rs`
- 修改 `src-tauri/src/terminal/mod.rs`
- 修改 `src-tauri/src/state.rs`

**验收：** 从会话树双击 SSH 会话 → 弹出密码输入（或使用密钥）→ 连接成功 → 终端可操作远程服务器

---

### Task 2.5 — 前端 SSH 连接流程集成 ✅ DONE

**范围：** 前端串联会话选择 → SSH 连接 → 终端显示

**具体步骤：**
1. 修改 `src/hooks/useTerminal.ts`：支持 SSH 模式（调用 create_ssh_terminal）
2. 创建 `src/components/session/AuthPrompt.tsx` — 密码输入弹窗
3. 修改 `src/components/sidebar/SessionTree.tsx`：双击触发 SSH 连接流程
4. 修改 `src/stores/appStore.ts`：Tab 关联 sessionConfigId
5. 修改 `src/components/statusbar/StatusBar.tsx`：显示活跃连接数
6. 实现连接状态管理：connecting → connected → disconnected

**产出文件：**
- `src/components/session/AuthPrompt.tsx`
- 修改多个已有文件

**验收：** 完整流程：侧边栏双击 → 认证 → 终端打开 → 操作远程服务器 → 关闭标签页断开连接

---

## Phase 3：SFTP 文件浏览器 ✅ DONE

### Task 3.1 — SFTP 后端操作 ✅ DONE

**范围：** Rust 端实现 SFTP 文件操作

**具体步骤：**
1. 添加 Cargo 依赖：`russh-sftp = "2"`
2. 创建 `src-tauri/src/filebrowser/mod.rs` — Tauri commands
3. 创建 `src-tauri/src/filebrowser/sftp.rs`：
   - 从已有 SSH 连接打开 SFTP subsystem channel
   - `list_remote_dir(session_id, path)` → Vec<FileEntry>
   - `remote_mkdir`, `remote_delete`, `remote_rename`
4. 创建 `src-tauri/src/filebrowser/local.rs`：
   - `list_local_dir(path)` → Vec<FileEntry>（使用 std::fs）
5. 创建 `src-tauri/src/filebrowser/transfer.rs`：
   - `upload_files` — 流式上传，每 64KB emit 进度事件
   - `download_files` — 流式下载
   - `cancel_transfer` — 通过 CancellationToken 取消
6. 定义 FileEntry, TransferProgress 结构体

**产出文件：**
- `src-tauri/src/filebrowser/mod.rs`
- `src-tauri/src/filebrowser/sftp.rs`
- `src-tauri/src/filebrowser/local.rs`
- `src-tauri/src/filebrowser/transfer.rs`

**验收：** 通过 Tauri command 能列出远程目录、上传下载文件、收到进度事件

---

### Task 3.2 — 双面板文件浏览器 UI ✅ DONE

**范围：** 前端实现本地/远程双面板文件管理器

**具体步骤：**
1. 创建 `src/components/filebrowser/FileBrowser.tsx` — 双面板容器
2. 创建 `src/components/filebrowser/FilePanel.tsx` — 单面板（表格视图）
   - 列：图标、名称、大小、修改时间、权限、（远程）所有者
   - 排序支持（点击列头）
   - 过滤输入框
3. 创建 `src/components/filebrowser/PathBreadcrumb.tsx` — 路径导航
4. 创建 `src/components/filebrowser/FileToolbar.tsx` — 操作栏
5. 创建 `src/components/filebrowser/FileTransferQueue.tsx` — 传输队列面板
   - 进度条、速度、ETA、状态
   - 暂停/恢复/取消/重试按钮
6. 创建 `src/stores/transferStore.ts` — 传输状态管理

**参考原型：** `mob-design/.../SftpTransfer.tsx`（完整的双面板 + 传输队列布局）

**产出文件：**
- `src/components/filebrowser/FileBrowser.tsx`
- `src/components/filebrowser/FilePanel.tsx`
- `src/components/filebrowser/PathBreadcrumb.tsx`
- `src/components/filebrowser/FileToolbar.tsx`
- `src/components/filebrowser/FileTransferQueue.tsx`
- `src/stores/transferStore.ts`

**验收：** SSH 连接后能打开 SFTP 标签页，浏览本地和远程文件，上传下载显示进度

---

### Task 3.3 — SFTP 侧边栏（SSH 会话附带） ✅ DONE

**范围：** SSH 终端标签页自动附带 SFTP 侧边栏

**具体步骤：**
1. 修改 `src/components/sidebar/Sidebar.tsx`：SSH 连接时底部显示 SFTP 面板
2. 创建 `src/components/filebrowser/SftpSidebar.tsx` — 精简版文件列表
   - 显示当前 SSH 会话的远程目录
   - 支持导航（上级目录、刷新、回到 home）
   - 双击文件 → 下载到临时目录并用系统编辑器打开
   - 拖拽文件到终端 → 自动输入文件路径
3. 修改 `src/hooks/useTerminal.ts`：SSH 连接成功后自动初始化 SFTP channel

**参考原型：** `mob-design/.../MainWindow.tsx` 底部的 SFTP browser 面板

**产出文件：**
- `src/components/filebrowser/SftpSidebar.tsx`
- 修改 `src/components/sidebar/Sidebar.tsx`

**验收：** SSH 连接后侧边栏底部自动显示远程文件列表，能导航和拖拽

---

## Phase 4：端口转发与高级 SSH 功能 ✅ DONE

### Task 4.1 — 端口转发后端 ✅ DONE

**范围：** Rust 端实现 SSH 隧道（Local/Remote/Dynamic）

**具体步骤：**
1. 创建 `src-tauri/src/tunnel/mod.rs`：
   - `create_tunnel(config: PortForward)` — 根据 forward_type 创建隧道
   - Local forward：本地监听 TCP → 通过 SSH channel 转发到远程
   - Remote forward：通过 SSH 请求远程监听 → 转发到本地
   - Dynamic forward：本地 SOCKS5 代理 → 通过 SSH channel 转发
   - `stop_tunnel(tunnel_id)` — 关闭隧道
   - `list_tunnels()` → Vec<TunnelStatus>
2. 隧道状态通过 event 推送：`tunnel-status-{id}`
3. 定义 PortForward, ForwardType, TunnelStatus 结构体（从 DESIGN.md 3.4 节）

**产出文件：**
- `src-tauri/src/tunnel/mod.rs`

**验收：** 能创建 Local forward 隧道，通过隧道访问远程服务

---

### Task 4.2 — 隧道管理 UI ✅ DONE

**范围：** 前端隧道创建和状态监控界面

**具体步骤：**
1. 创建 `src/components/sidebar/TunnelList.tsx` — 侧边栏隧道列表
   - 显示活跃隧道：类型、本地端口 → 远程地址、状态
   - 启动/停止按钮
2. 创建 `src/components/tunnel/TunnelEditor.tsx` — 隧道配置表单
3. 修改 `src/components/sidebar/Sidebar.tsx`：增加隧道区域
4. 创建 `src/stores/tunnelStore.ts`

**产出文件：**
- `src/components/sidebar/TunnelList.tsx`
- `src/components/tunnel/TunnelEditor.tsx`
- `src/stores/tunnelStore.ts`

**验收：** 能通过 UI 创建/停止隧道，状态实时更新

---

### Task 4.3 — 高级 SSH 功能 ✅ DONE

**范围：** ProxyJump、Agent 转发、X11 转发、keepalive、自动重连

**具体步骤：**
1. 修改 `src-tauri/src/terminal/ssh.rs`：
   - ProxyJump：先连接跳板机，再通过 direct-tcpip channel 连接目标
   - Agent forwarding：转发本地 ssh-agent socket
   - X11 forwarding：请求 X11 channel（需系统有 X server）
   - keepalive：定时发送 SSH keepalive 包
2. 实现自动重连逻辑：
   - 检测连接断开（channel EOF / 网络错误）
   - 通过 event 通知前端
   - 前端显示重连提示，用户确认后重新连接
3. 修改 `src/components/session/SessionEditor.tsx`：高级设置标签页功能生效

**产出文件：**
- 修改 `src-tauri/src/terminal/ssh.rs`
- 修改 `src/components/session/SessionEditor.tsx`

**验收：** 能通过跳板机连接、X11 转发生效（Linux 下）、断线后提示重连

---

## Phase 5：多执行与网络工具

### Task 5.1 — 分屏终端

**范围：** 终端分屏视图（水平/垂直/四宫格）

**具体步骤：**
1. 创建 `src/components/terminal/TerminalSplitView.tsx`
   - 4 种布局模式：单屏、2 水平、2 垂直、4 宫格
   - 每个 pane 独立的 TerminalPanel 实例
   - 活跃 pane 高亮边框
   - 布局切换按钮
2. 修改 `src/stores/appStore.ts`：Tab 支持 split 模式
3. 快捷键：Ctrl+Shift+D 垂直分屏，Ctrl+Shift+E 水平分屏

**参考原型：** `mob-design/.../SplitMultiExec.tsx` 的 gridClass 和 PaneView

**产出文件：**
- `src/components/terminal/TerminalSplitView.tsx`
- 修改 `src/stores/appStore.ts`

**验收：** 能切换 4 种分屏布局，每个 pane 独立终端

---

### Task 5.2 — Multi-Exec 多执行

**范围：** 同时向多个终端发送命令

**具体步骤：**
1. 创建 `src/components/multiexec/MultiExecPanel.tsx` — 多执行控制面板
   - 同步输入开关（ON/OFF）
   - 暂停/恢复广播
   - 目标会话选择（checkbox 列表）
   - 底部命令输入栏
2. 创建 `src/components/multiexec/MultiExecInput.tsx` — 命令输入框
3. Rust 端实现 `multi_exec` command（遍历 session_ids 调用 write_terminal）
4. 实时同步模式：前端 xterm.onData 时同时写入所有选中的 session

**参考原型：** `mob-design/.../SplitMultiExec.tsx` 的 MultiExec 控制栏

**产出文件：**
- `src/components/multiexec/MultiExecPanel.tsx`
- `src/components/multiexec/MultiExecInput.tsx`
- 修改 `src-tauri/src/terminal/mod.rs`

**验收：** 开启 MultiExec → 输入命令 → 所有选中终端同时执行

---

### Task 5.3 — 网络工具集

**范围：** Ping、端口扫描、DNS 查询

**具体步骤：**
1. 添加 Cargo 依赖：`surge-ping = "0.8"`, `dns-lookup = "2"`
2. 创建 `src-tauri/src/nettools/mod.rs` — commands 入口
3. 创建 `src-tauri/src/nettools/ping.rs`：
   - `ping(host, count, timeout_ms)` — 每次结果通过 event 推送
4. 创建 `src-tauri/src/nettools/portscan.rs`：
   - `port_scan(host, ports, timeout_ms, concurrency)` — tokio 并发扫描
5. 创建 `src-tauri/src/nettools/dns.rs`：
   - `dns_lookup(hostname, record_type)` → Vec<String>
6. 前端创建 `src/components/nettools/NetworkToolsPanel.tsx` — 工具集面板
7. 创建 `src/components/nettools/PingTool.tsx`
8. 创建 `src/components/nettools/PortScanTool.tsx`
9. 创建 `src/components/nettools/DnsLookupTool.tsx`

**产出文件：**
- `src-tauri/src/nettools/{mod,ping,portscan,dns}.rs`
- `src/components/nettools/{NetworkToolsPanel,PingTool,PortScanTool,DnsLookupTool}.tsx`

**验收：** 能 ping 主机、扫描端口范围、查询 DNS 记录

---

## Phase 6：RDP/VNC/Serial 与导入导出

### Task 6.1 — RDP/VNC 启动器

**范围：** 调用系统客户端连接 RDP/VNC

**具体步骤：**
1. 创建 `src/components/remote_desktop/RdpLauncher.tsx` — RDP 配置与启动
2. 创建 `src/components/remote_desktop/VncViewer.tsx` — VNC 配置与启动
3. Rust 端实现平台判断和系统命令调用：
   - Linux RDP: `xfreerdp /v:{host}:{port}`
   - macOS RDP: `open rdp://...`
   - Windows RDP: `mstsc.exe /v:{host}:{port}`
   - VNC 类似处理

**产出文件：**
- `src/components/remote_desktop/RdpLauncher.tsx`
- `src/components/remote_desktop/VncViewer.tsx`
- Rust 端启动器 command

**验收：** 双击 RDP/VNC 会话 → 调用系统客户端打开远程桌面

---

### Task 6.2 — 串口终端

**范围：** 串口设备连接与通信

**具体步骤：**
1. 添加 Cargo 依赖：`tokio-serial = "5"`
2. 创建 `src-tauri/src/serial/mod.rs`：
   - `list_serial_ports()` → Vec<SerialPortInfo>
   - `open_serial(config: SerialConfig)` → session_id
   - 数据流复用终端模块的 event 机制
3. 前端复用 TerminalPanel，连接类型为 Serial

**产出文件：**
- `src-tauri/src/serial/mod.rs`

**验收：** 能列出系统串口，打开串口连接，在终端中收发数据

---

### Task 6.3 — 会话导入导出

**范围：** 从其他工具导入会话配置

**具体步骤：**
1. 创建 `src-tauri/src/session/import.rs`：
   - 解析 MobaXterm `.mxtsessions` 文件格式
   - 解析 PuTTY registry 导出
   - 解析 `~/.ssh/config` 文件
   - 导出为 JSON 格式
2. 创建 `src/components/session/SessionImport.tsx` — 导入向导 UI
3. 在 `src-tauri/src/session/mod.rs` 增加 import/export commands

**产出文件：**
- `src-tauri/src/session/import.rs`
- `src/components/session/SessionImport.tsx`

**验收：** 能从 SSH config 导入会话，能导出会话为 JSON

---

### Task 6.4 — 应用设置面板

**范围：** 全局设置（外观、终端默认值、快捷键）

**具体步骤：**
1. 创建 `src-tauri/src/config/mod.rs` — 应用配置读写（TOML 文件）
2. 创建 `src/components/settings/SettingsPanel.tsx`：
   - 外观：主题（dark/light/system）、语言
   - 终端：默认字体、字号、配色方案、滚动行数
   - 连接：默认 SSH 端口、keepalive 间隔、默认认证方式
   - 快捷键：可自定义的键绑定
3. 配置文件路径：`app_config_dir/settings.toml`

**产出文件：**
- `src-tauri/src/config/mod.rs`
- `src/components/settings/SettingsPanel.tsx`

**验收：** 能打开设置面板，修改主题和终端配置，重启后保持

---

## 任务依赖关系

```
Phase 1 (必须按顺序):
  1.1 → 1.2 → 1.3 → 1.4 → 1.5

Phase 2 (1.5 完成后):
  2.1 → 2.2 (可与 2.3 并行)
  2.1 → 2.3
  2.4 (可与 2.2/2.3 并行)
  2.2 + 2.3 + 2.4 → 2.5

Phase 3 (2.5 完成后):
  3.1 → 3.2 (可与 3.3 并行)
  3.1 → 3.3

Phase 4 (2.5 完成后，可与 Phase 3 并行):
  4.1 → 4.2
  4.3 (可独立)

Phase 5 (1.5 完成后，可与 Phase 2+ 并行):
  5.1 → 5.2
  5.3 (完全独立)

Phase 6 (Phase 2 完成后):
  6.1, 6.2, 6.3, 6.4 均可并行
```

---

## 工作量估算

| Task | 预估复杂度 | 前端/后端 | 预估文件数 |
|------|-----------|----------|-----------|
| 1.1 项目初始化 | 低 | 均衡 | ~12 |
| 1.2 主布局框架 | 中 | 前端为主 | ~7 |
| 1.3 xterm 组件 | 中 | 纯前端 | ~3 |
| 1.4 PTY 后端 | 中 | 纯后端 | ~4 |
| 1.5 数据流打通 | 高 | 均衡 | ~5 |
| 2.1 数据库 | 中 | 纯后端 | ~3 |
| 2.2 会话树 | 中 | 前端为主 | ~4 |
| 2.3 会话编辑 | 高 | 纯前端 | ~3 |
| 2.4 SSH 后端 | 高 | 纯后端 | ~3 |
| 2.5 SSH 集成 | 高 | 均衡 | ~5 |
| 3.1 SFTP 后端 | 高 | 纯后端 | ~4 |
| 3.2 文件浏览器 | 高 | 纯前端 | ~6 |
| 3.3 SFTP 侧边栏 | 中 | 前端为主 | ~2 |
| 4.1 隧道后端 | 高 | 纯后端 | ~1 |
| 4.2 隧道 UI | 中 | 前端为主 | ~3 |
| 4.3 高级 SSH | 高 | 后端为主 | ~2 |
| 5.1 分屏终端 | 中 | 纯前端 | ~2 |
| 5.2 Multi-Exec | 中 | 均衡 | ~3 |
| 5.3 网络工具 | 中 | 均衡 | ~8 |
| 6.1 RDP/VNC | 低 | 均衡 | ~3 |
| 6.2 串口 | 中 | 后端为主 | ~1 |
| 6.3 导入导出 | 中 | 均衡 | ~2 |
| 6.4 设置面板 | 中 | 均衡 | ~2 |

**总计：23 个任务，约 90 个文件**

---

## 给 AI Agent 的执行说明

每次执行一个 Task 时，向 agent 提供：

```
请实现 NewMob 项目的 Task [X.Y]。

项目技术栈：Tauri 2 + React 18 + TypeScript + Vite + Rust
参考文档：DESIGN.md 第 [对应章节] 节
UI 原型：/data/code-src/person/mob-design/artifacts/mockup-sandbox/src/components/mockups/mobaxterm/

[粘贴该 Task 的完整内容]
```

执行完一个 Task 后，运行 `cargo tauri dev` 验证，确认无误再进入下一个。
