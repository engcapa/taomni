# NewMob 已完成功能清单

> 本文档基于当前仓库代码 + `IMPLEMENTATION_PLAN.md` / `TERMINAL_EXPERIENCE_PLAN.md` / `TERMINAL_APPEARANCE_PLAN.md` / `ipc-improve-plan.md` / `replit.md` 的标记，**仅记录已实现并接入主流程的功能**。
> 标记说明：
> - ✅ 已完成
> - 🟡 已部分完成（关键路径可用，仍有未覆盖的能力，列出具体范围）
> - 未完成的能力不写入本文档（详见各 plan 文档的待办项）
> 当前对照版本：v0.1.0 → v0.1.32（含本仓库 `package.json` 标识的当前版本）。

---

## 1. 应用框架与主界面

### 1.1 工程基座 ✅
- Tauri 2 + React 18 + TypeScript + Vite 桌面工程已搭建
- Rust 后端模块拆分：`terminal / session / filebrowser / tunnel / appearance / config / state`
- 前端目录拆分：`components / layouts / lib / stores / hooks / stubs / types`
- 同时支持 **Tauri 桌面打包模式** 与 **Vite 浏览器开发预览模式**（通过 `TAURI_ENV_PLATFORM` 自动切换 stub/真实后端）

### 1.2 主窗口三栏布局 ✅

<!-- feature
id: F1.2
status: done
area: main
components: [MainLayout, MenuBar, Ribbon, QuickConnect, Sidebar, TabBar, StatusBar]
files:
  - src/layouts/MainLayout.tsx
controls:
  # MainLayout owns layout-level chrome only; menu/ribbon/sidebar/quick-connect testids belong to their own features
  - id: collapsed-sidebar-rail
    selector: '[data-testid="collapsed-sidebar-rail"]'
    kind: interactive
    optional: true       # only when sidebar collapsed
  - id: compact-sidebar-drawer
    selector: '[data-testid="compact-sidebar-drawer"]'
    kind: display
    optional: true       # only in compact mode after Show sessions drawer
  - id: sidebar-resize-handle
    selector: '[data-testid="main-sidebar-resize-handle"]'
    kind: display    # drag handle — meaningless to click; existence is the assertion
-->

- 顶部菜单栏 `MenuBar`（File/Edit/View/Sessions/Tools/Help）
- Ribbon 工具条 `Ribbon`（Session、Servers、Tools、View、Split、MultiExec、Tunneling、Packages、Settings、Help、X server、Exit）
- 地址栏式快速连接 `QuickConnect`
- 左侧可拖拽/可折叠 Sidebar
- 中间 Tab 栏 + 内容区
- 底部状态栏 `StatusBar`（活跃连接数、当前应用主题、状态消息）
- 侧边栏宽度通过 `react-resizable-panels` 持久化

### 1.3 自定义标题栏与窗口控制 ✅

<!-- feature
id: F1.3
status: done
area: main/window
components: [AppTitleBar, WindowControls, WindowResizeHandles, TitleBarTrayControls]
files:
  - src/components/window/AppTitleBar.tsx
  - src/components/window/WindowControls.tsx
  - src/components/window/TitleBarTrayControls.tsx
controls:
  - id: titlebar
    selector: '[data-testid="app-titlebar"]'
    kind: display
  - id: tray
    selector: '[data-testid="titlebar-tray"]'
    kind: display
  - id: theme-cycle
    selector: '[data-testid="theme-cycle"]'
    kind: interactive
  - id: compact-toggle
    selector: '[data-testid="compact-toggle"]'
    kind: interactive
  - id: split-view             # toggles terminal split view (lives in title bar tray)
    selector: '[data-testid="tab-split-view"]'
    kind: interactive
  - id: multiexec-toggle       # toggles MultiExec (lives in title bar tray)
    selector: '[data-testid="tab-multiexec-toggle"]'
    kind: interactive
  - id: ai-chat-drawer-toggle  # toggles global AI Chat Drawer (hidden when AI fully disabled)
    selector: '[data-testid="ai-chat-drawer-toggle"]'
    kind: interactive
    optional: true             # absent in fully_disabled mode
  # language-switcher control is owned by F-I18n-1; the tray simply hosts the
  # button. Putting it both places would create a duplicate-selector lint
  # error, so this feature only documents that the title bar is its mount
  # point in prose below.
  - id: window-controls
    selector: '[data-testid="window-controls"]'
    kind: display
  - id: window-min
    selector: '[data-testid="window-min"]'
    kind: display    # clicking would minimize the window — assertion of presence is the right check
  - id: window-max
    selector: '[data-testid="window-max"]'
    kind: display    # clicking would maximize/restore the window
  - id: window-close
    selector: '[data-testid="window-close"]'
    kind: display    # clicking would close the window and abort the test
-->

- 取消原生 decorations，前端自绘 `AppTitleBar` + `WindowControls`（最小化 / 最大化 / 关闭）
- 标题栏托盘 `TitleBarTrayControls`：分组排列 — Voice (PTT) | View (主题循环 + 紧凑模式) | Terminal (Split + MultiExec) | AI (Chat Drawer) | Language (locale 切换)
- `WindowResizeHandles` 在无 decorations 模式下提供 8 向窗口缩放（North/South/East/West/四个角）
- 主菜单 / Sessions / View / Tunneling / Settings / Help / Exit 入口接入

### 1.4 紧凑 UI 模式（Compact mode）✅

<!-- feature
id: F1.4
status: done
area: main/window
components: [CompactTitleBar]
files:
  - src/components/tabbar/CompactTitleBar.tsx
  - src/index.css
controls:
  - id: titlebar
    selector: '[data-testid="compact-titlebar"]'
    kind: display
  - id: main-menu
    selector: '[data-testid="compact-main-menu"]'
    kind: interactive
  - id: sidebar-drawer-toggle
    selector: '[data-testid="compact-sidebar-drawer-toggle"]'
    kind: interactive
    aliases:
      - '[aria-label="Show sessions drawer"]'
-->

- 默认布局 vs 紧凑布局可一键切换，状态持久化到 `localStorage` (`newmob.compactMode`)
- 紧凑模式下使用 `CompactTitleBar`：主菜单按钮 + 标签栏 + 托盘控件统一在一行
- 标题栏内置主菜单：新建本地/远程会话、新建 SFTP、关闭活动标签、Sessions、View、Tunneling、Settings、Help、Exit
- 快捷键 Ctrl+Shift+M 切换紧凑模式

### 1.5 标签页系统 ✅

<!-- feature
id: F1.5
status: done
area: main/tabs
components: [TabBar]
files:
  - src/components/tabbar/TabBar.tsx
  - src/lib/customDnD.ts
  - src/stores/appStore.ts
controls:
  - id: tab-bar
    selector: '[data-testid="tab-bar"]'
    kind: display
  - id: tab-item               # individual tab; pair with [data-tab-type=...] / [data-tab-title=...] when targeting
    selector: '[data-testid="tab-item"]'
    kind: interactive
  - id: tab-title              # the title span inside a tab; double-click to rename
    selector: '[data-testid="tab-title"]'
    kind: interactive
  - id: tab-title-input        # inline rename input; only present while editing
    selector: '[data-testid="tab-title-input"]'
    kind: interactive
    optional: true
  - id: new-local-terminal     # the "+" plus tab button
    selector: '[data-testid="new-local-terminal"]'
    kind: interactive
  - id: tabs-more
    selector: '[data-testid="tab-more"]'
    kind: interactive
  - id: tab-menu-move-first
    selector: '[data-testid="context-menu-item-move-to-first"]'
    kind: interactive
    optional: true       # only visible in a tab context menu
  - id: tab-menu-move-left
    selector: '[data-testid="context-menu-item-move-left"]'
    kind: interactive
    optional: true
  - id: tab-menu-move-right
    selector: '[data-testid="context-menu-item-move-right"]'
    kind: interactive
    optional: true
  - id: tab-menu-move-last
    selector: '[data-testid="context-menu-item-move-to-last"]'
    kind: interactive
    optional: true
  - id: tab-new-output-dot
    selector: 'span[aria-label="New output"]'
    kind: display
    optional: true
-->

- 多标签：本地终端 / SSH 终端 / SFTP / VNC / 设置 / 隧道管理 / Welcome / 占位标签
- 标签操作：新建、切换、关闭、中键关闭
- **拖拽排序**：标签通过 `customDnD` 指针驱动层重新排列，拖拽时显示 drop indicator
- **重命名**：双击标签标题或右键菜单 "Rename" 进入内联编辑，Enter 确认 / Esc 取消 / 失焦自动提交
- 标签右键菜单：关闭、关闭其他、关闭全部、复制标签、新建本地终端、重命名、Move to first/left/right/last
- SSH / SFTP / VNC 标签 **常驻挂载**（切换标签不销毁，传输/输出/连接不中断）
- 关闭应用前若有终端活跃会弹出确认

### 1.6 欢迎页 `WelcomePanel` ✅

<!-- feature
id: F1.6
status: done
area: main/welcome
components: [WelcomePanel]
files:
  - src/components/WelcomePanel.tsx
controls:
  - id: panel-root
    selector: '[data-testid="welcome-panel"]'
    kind: display
  - id: open-local-terminal
    selector: '[data-testid="welcome-open-local-terminal"]'
    kind: interactive
  - id: shell-select
    selector: 'select[aria-label="Terminal shell"]'
    kind: interactive
    optional: true       # only rendered when >1 local shell detected
  - id: open-home-folder
    selector: '[data-testid="welcome-open-home-folder"]'
    kind: interactive
    optional: true       # only rendered when onOpenLocalPath prop is set
  - id: open-as-administrator
    selector: 'button[aria-label="Open as administrator"]'
    kind: interactive
    optional: true       # only rendered when selected shell canElevate
  - id: new-session-card
    selector: 'text="New session…"'
    kind: interactive
  - id: import-openssh-card
    selector: 'text="Import OpenSSH config"'
    kind: interactive
  - id: refresh-sessions-card
    selector: 'text="Refresh sessions"'
    kind: interactive
  - id: tips-section
    selector: 'text="Tips"'
    kind: display
  - id: active-connections-list
    selector: 'text="Active connections"'
    kind: display
    aliases:
      - 'text="No active terminal tabs."'   # empty-state copy used by tests as a proxy for the list
  - id: last-events-list
    selector: 'text="Last events"'
    kind: display
  - id: version-header
    selector: '[data-testid="welcome-version"]'
    kind: display
  - id: version-footer
    selector: '[data-testid="welcome-version-footer"]'
    kind: display
-->

- 启动入口：开始本地终端、新建会话、导入 OpenSSH config
- 显示活跃连接列表

### 1.7 状态栏 ✅

<!-- feature
id: F1.7
status: done
area: main/statusbar
components: [StatusBar]
files:
  - src/components/statusbar/StatusBar.tsx
controls:
  - id: status-bar
    selector: '[data-testid="status-bar"]'
    kind: display
-->

- 显示活跃连接数
- 显示当前应用主题（Light / Dark / Follow system）
- 显示瞬时状态消息（操作反馈）

### 1.8 关于对话框 `AboutDialog` ✅
- Help 菜单入口
- 展示应用图标、`Version` 字段（来自 `__APP_VERSION__` 注入的 `package.json` 版本号）
- Esc / 点击遮罩 / Close 按钮均可关闭

### 1.8 主菜单栏 `MenuBar` ✅

<!-- feature
id: F1.8
status: done
area: main/menubar
components: [MenuBar]
files:
  - src/components/menubar/MenuBar.tsx
controls:
  - id: menu-bar
    selector: '[data-testid="menu-bar"]'
    kind: display
  - id: menu-terminal
    selector: '[data-testid="menu-terminal"]'
    kind: interactive
  - id: menu-sessions
    selector: '[data-testid="menu-sessions"]'
    kind: interactive
  - id: menu-view
    selector: '[data-testid="menu-view"]'
    kind: interactive
  - id: menu-help
    selector: '[data-testid="menu-help"]'
    kind: interactive
  - id: menu-import-sessions      # submenu trigger inside Sessions menu
    selector: '[data-testid="menu-import-sessions"]'
    kind: interactive
    optional: true       # only after opening the Sessions menu
  - id: menu-export-sessions      # submenu trigger inside Sessions menu
    selector: '[data-testid="menu-export-sessions"]'
    kind: interactive
    optional: true
-->

- 顶级菜单：Terminal / Sessions / View / X server / Tools / Settings / Macros / Help
- 下拉项调用 ribbon 命令或在新标签内打开会话
- 右键菜单兜底已被 ContextMenu 通用化

### 1.9 Ribbon 命令条 `Ribbon` ✅

<!-- feature
id: F1.9
status: done
area: main/ribbon
components: [Ribbon]
files:
  - src/components/menubar/Ribbon.tsx
controls:
  - id: ribbon
    selector: '[data-testid="ribbon"]'
    kind: display
  - id: ribbon-session
    selector: '[data-testid="ribbon-session"]'
    kind: interactive
  - id: ribbon-sftp
    selector: '[data-testid="ribbon-sftp"]'
    kind: interactive
  - id: ribbon-settings
    selector: '[data-testid="ribbon-settings"]'
    kind: interactive
  - id: ribbon-tunneling
    selector: '[data-testid="ribbon-tunneling"]'
    kind: interactive
  - id: ribbon-multiexec
    selector: '[data-testid="ribbon-multiexec"]'
    kind: interactive
    optional: true
  - id: ribbon-commands
    selector: '[data-testid="ribbon-commands"]'
    kind: interactive
    optional: true
-->

- 大图标命令：Session / SFTP / Servers / Tools / View / Split / MultiExec / Tunneling / Packages / Settings / Help
- 每条命令通过 `data-testid={`ribbon-${slug(label)}`}` 暴露稳定锚点

---

## 2. 本地终端（Local Terminal）

### 2.1 PTY 后端 ✅

<!-- feature
id: F2.1
status: done
area: terminal/local
components: [TerminalPanel]
files:
  - src-tauri/src/terminal/
controls: []   # backend-only — PTY runtime has no UI surface; the terminal pane is owned by F2.2
-->

- Rust 端基于 `portable-pty` 创建 PTY（Linux/macOS/Windows）
- 平台默认 shell 自动判定（bash / zsh / powershell）
- 命令：`create_local_terminal` / `write_terminal` / `resize_terminal` / `close_terminal`
- 数据通路：默认通过 `terminal-output-{sid}` event 推送；Tauri 2 IPC channel 改造后改用 `tauri::ipc::Channel<InvokeResponseBody>` 直传二进制，去掉 base64 编解码与字符串拷贝
- 桌面启动器中 `TERM` 缺失的回归已修复（保证 vi、TUI 程序可用）

### 2.2 终端面板 `TerminalPanel` ✅

<!-- feature
id: F2.2
status: done
area: terminal/local
components: [TerminalPanel]
files:
  - src/components/terminal/TerminalPanel.tsx
  - src/components/ContextMenu.tsx
controls:
  - id: terminal-pane
    selector: '[data-testid="terminal-pane"]'
    kind: interactive       # type / send_keys go here
  - id: attached-sftp-toggle
    selector: '[data-testid="attached-sftp-toggle"]'
    kind: interactive
    optional: true          # only on SSH-backed terminals
  - id: tab-chat-toggle
    selector: '[data-testid="tab-chat-toggle"]'
    kind: interactive
    optional: true          # terminal floating toolbar; hidden in terminal split mode
  # Shared right-click menu surface (rendered by ContextMenu)
  - id: context-menu
    selector: '[data-testid="context-menu"]'
    kind: display
    optional: true          # only after right_click
-->

- xterm.js + FitAddon + WebglAddon（失败回退 canvas）+ SearchAddon + WebLinksAddon
- ResizeObserver + debounce 自动 fit
- 容器卸载时正确 dispose 终端实例与监听器
- 浮动工具栏包含当前 tab 绑定 Chat 入口（`tab-chat-toggle` / Ctrl+Shift+L）；标题栏 AI 入口与 Ctrl+L 仅打开全局 Chat
- 命令历史持久化：每条 host 维度记录到 SQLite (`command_history` 表)，支持 `history_append / history_match_prefix / history_list_recent / history_clear`
- Inline ghost-text 自动补全：基于 host 命令历史的前缀匹配，按右箭头 / End / Tab 接受建议（PowerShell 本地终端关闭以避免与 PSReadLine 冲突）
- Common commands 调色板（`CommonCommandsPalette`）：合并历史 + 用户自定义 + 平台预置命令（Windows / Unix），在本地终端中可调出
- SSH 终端连接进度态 UI（连接中 / 已建立 / 断开）有更连贯的过渡

### 2.3 终端连接状态 ✅
- SSH 终端启动期 UI：占位骨架 + "Connecting…"，连接成功后无缝切换到 xterm 渲染
- 端会话失败时给出错误提示

### 2.4 本地 shell 选择 ✅

<!-- feature
id: F2.4
status: done
area: terminal/local
components: [WelcomePanel]
files: []     # WelcomePanel UI is owned by F1.6; F2.4 is the logical concern (which shells get listed) and has no dedicated source surface
controls: []
-->

- `list_local_shells` 列出系统 shell
- `open_local_shell_as_administrator` 以管理员身份启动（平台支持时）
- 支持选择 shell 启动本地终端

### 2.5 本地真实信号投递 🟡
- 已实现 Unix `SIGINT / SIGTERM / SIGKILL / SIGQUIT / SIGHUP`
- 跨平台对齐尚未完整覆盖

---

## 3. SSH 终端

### 3.1 SSH 后端（russh）✅

<!-- feature
id: F3.1
status: done
area: terminal/ssh
components: [TerminalPanel]
files:
  - src-tauri/src/terminal/
controls: []   # backend-only — russh client + IPC lives in src-tauri; the terminal pane belongs to F2.2
-->

- `create_ssh_terminal` / `test_ssh_connection` / `send_terminal_signal`
- 三种认证：Password、PrivateKey（密钥文件）、Agent
- 请求 PTY channel（term=`xterm-256color`），启动 shell
- SSH channel 与本地 PTY 共用相同的 event 推送通道
- Windows 11 上私钥认证失败的兼容性问题已修复

### 3.2 高级 SSH 能力 ✅

<!-- feature
id: F3.2
status: done
area: terminal/ssh
files:
  - src-tauri/src/terminal/forwards.rs
  - src-tauri/src/terminal/network.rs
controls: []   # backend-only — ProxyJump / agent forwarding / keepalive run in Rust; user-facing toggles live in the SessionEditor (F6.3)
-->

- ProxyJump（跳板机）：`forwards.rs` 实现 direct-tcpip 链路
- Agent 转发
- X11 转发（Linux）
- Keepalive 定时包
- 断线检测 + 状态事件
- 网络代理配置（`network.rs` 入口）

### 3.3 OSC 7 工作目录广播 ✅

<!-- feature
id: F3.3
status: done
area: terminal/ssh
files:
  - src/components/terminal/TerminalPanel.tsx
controls: []   # OSC 7 is an in-pty protocol; the terminal pane surface is owned by F2.2
-->

- 终端解析 `\e]7;file://host/path\e\` 序列
- 通过 `onCwdChange` prop 同步给主布局
- 连接成功后自动注入 `PROMPT_COMMAND` (bash) / `precmd_functions` (zsh) 来周期性发出 OSC 7
- 高级设置中可按会话开关 OSC 7 自动注入

### 3.4 浏览器预览模式下的 SSH 桥接（开发用）✅
- Vite 插件 `sshProxy.ts` + WebSocket `/__newmob/ssh-bridge`
- 浏览器内连接真实 SSH 服务器（仅密码与内联私钥）
- 仅 dev 模式启用，不进入 desktop release 包

---

## 4. 终端右键菜单与操作（MobaXterm 同款）

### 4.1 复制粘贴查找 ✅

<!-- feature
id: F4.1
status: done
area: terminal/right-menu
files:
  - src-tauri/src/lib.rs
  - src/components/terminal/TerminalPanel.tsx
controls:
  # Right-click menu items (text-based — ContextMenu generates testids dynamically by label slug)
  - id: copy
    selector: 'text="Copy"'
    kind: interactive
    optional: true            # only after right_click on terminal
  - id: copy-all
    selector: 'text="Copy All"'
    kind: interactive
    optional: true
  - id: copy-formatted
    selector: 'text="Copy formatted text (HTML/RTF)"'
    kind: interactive
    optional: true
  - id: paste
    selector: 'text="Paste"'
    kind: interactive
    optional: true
  - id: find
    selector: 'text="Find"'
    kind: interactive
    optional: true
    aliases:
      - '[data-testid="context-menu-item-find"]'
  # Find dialog spawned by Ctrl+Shift+F or "Find" menu item
  - id: find-input
    selector: 'input[placeholder="Find"]'
    kind: interactive
    optional: true
  - id: find-match-info
    selector: 'span:has-text("Match")'
    kind: display
    optional: true
  - id: find-close
    selector: 'role=button[name="Close"]'
    kind: interactive
    optional: true
-->

- Copy / Copy All / Paste / Paste with Shift+Insert
- 跨平台复制/粘贴快捷键：macOS `Cmd+C / Cmd+V`，Windows / Linux `Ctrl+Shift+C / Ctrl+Shift+V`
- **CopyOnSelect**：选区释放后自动复制到剪贴板（开关存在 `terminalProfile`，每会话可覆盖）
- **中键粘贴（middle-click paste）**：当前选区优先，无选区则回退剪贴板内容；read-only 模式下被拦截
- **OS 文件拖入终端**：拖到终端面板时按当前 shell 引号风格（unix/powershell/cmd）插入引号路径，多文件以空格分隔，末尾保留一个空格
  - SSH 远程终端：固定 unix 引号（路径仅插入文本，不会触发上传）
  - 本地终端：按解析后的 `localShellId`（powershell / command-prompt / git-bash）选择风格，未知时按主机平台回退
  - 来源：Linux/macOS 走 Tauri `onDragDropEvent` 绝对路径；Windows 走 webview HTML5 `text/uri-list`
  - read-only 模式下被拦截，状态栏给出提示
  - **e2e 测试限制**：与 SFTP 同因——单元测试 `src/lib/osFileDrop.test.ts` + `TerminalPanel.test.tsx` 覆盖引号格式与事件路由，平台行为需手动回归
- Find（Ctrl+Shift+F），结果计数、上下匹配、关闭
- HTML + 纯文本剪贴板写入（`ClipboardItem` 可用时）

### 4.2 字体与显示 ✅

<!-- feature
id: F4.2
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
  - src/components/terminal/FontPickerPanel.tsx
controls:
  - id: font-settings
    selector: 'text="Font settings"'
    kind: interactive
    optional: true
    aliases:
      - '[data-testid="context-menu-item-font-settings"]'
  - id: font-more-fonts
    selector: '[data-testid="context-menu-item-more-fonts"]'
    kind: interactive
    optional: true
  - id: font-picker-search
    selector: 'input[placeholder="Search fonts..."]'
    kind: interactive
    optional: true
  - id: font-picker-empty
    selector: 'text="No matching fonts found"'
    kind: display
    optional: true
  - id: font-ligatures-toggle
    selector: '[data-testid="context-menu-item-display-font-ligatures"]'
    kind: interactive
    optional: true
    aliases:
      - 'text="Display font ligatures"'
  - id: terminal-display
    selector: 'text="Terminal display"'
    kind: interactive
    optional: true
  - id: read-only-toggle
    selector: 'text="Read-only terminal"'
    kind: interactive
    optional: true
  - id: scrollbar-toggle
    selector: 'text="Toggle terminal scrollbar"'
    kind: interactive
    optional: true
  - id: fullscreen-toggle
    selector: 'text="Fullscreen terminal"'
    kind: interactive
    optional: true
-->

- 字体设置子菜单：切换字体家族、More fonts 搜索面板、显示字体连字、字号增大/减小/重置
- Ctrl+滚轮调整字号、Ctrl+0 重置
- Terminal display 子菜单：Reset terminal output、Clear scrollback、Set terminal title、Toggle scrollbar、Fullscreen (F11)、Read-only

### 4.3 语法高亮 ✅

<!-- feature
id: F4.3
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: syntax-highlighting
    selector: 'text="Syntax highlighting"'
    kind: interactive
    optional: true
  - id: syntax-default
    selector: 'text="Default"'
    kind: interactive
    optional: true
  - id: syntax-keywords
    selector: 'text="Error/Warning/Success keywords"'
    kind: interactive
    optional: true
-->

- Default / Error-Warning-Success keywords / Unix shell / Cisco / Perl / SQL
- Read-only 模式下输入被拦截，输出仍正常渲染

### 4.4 宏录制与回放 ✅

<!-- feature
id: F4.4
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: record-macro
    selector: 'text="Record new macro"'
    kind: interactive
    optional: true
  - id: stop-macro
    selector: 'text="Stop macro recording"'
    kind: interactive
    optional: true
-->

- 录制新宏、执行宏（Ctrl+Space）

### 4.5 输出导出 ✅

<!-- feature
id: F4.5
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: save-to-file
    selector: 'text="Save to file"'
    kind: interactive
    optional: true
  - id: start-output-record
    selector: 'text="Record terminal output to file"'
    kind: interactive
    optional: true
  - id: stop-output-record
    selector: 'text="Stop recording terminal output"'
    kind: interactive
    optional: true
-->

- Save to file（Ctrl+Shift+S）：浏览器下载导出当前 buffer
- Record terminal output to file：实时记录会话输出

### 4.6 特殊命令 / 信号 🟡
- 已实现：Local 端真实 Unix 信号、SSH channel 信号 + Ctrl+C 兜底 SIGINT、Break、IGNORE message
- 未实现：SSH break request、跨平台完整信号矩阵

### 4.7 事件日志 🟡

<!-- feature
id: F4.7
status: partial
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls:
  - id: event-log-menu-item
    selector: '[data-testid="context-menu-item-event-log"]'
    kind: interactive
    optional: true
    aliases:
      - 'text="Event Log"'
-->

- 已记录：connect / auth / resize / disconnect / error / 导出 / 日志 / 宏 / 信号
- 未记录：reconnect 事件（重连流程尚未上线）

### 4.8 快捷键 ✅

<!-- feature
id: F4.8
status: done
area: terminal/right-menu
files:
  - src/components/terminal/TerminalPanel.tsx
controls: []   # F4.8 covers OS-level keyboard shortcuts (Ctrl+0 / F11 / Ctrl+Shift+F / etc.) — exercised via `press` verb against [data-testid="terminal-pane"] (F2.2). No dedicated DOM surface.
-->

- Shift+Insert 粘贴、Ctrl+Shift+F 查找、F11 全屏、Ctrl+0 重置字号、Ctrl+滚轮缩放字号
- macOS Cmd+C / Cmd+V，Windows / Linux Ctrl+Shift+C / Ctrl+Shift+V

### 4.9 Linux 中文输入兼容 ✅
- WebKitGTK 下 IME composition/preedit guard
- 防止中文重复回显，commit 阶段唯一放行
- `compositionend`/`beforeinput` fallback、组合时间窗内的去重

### 4.10 Z-modem 文件收发（rz / sz）✅

<!-- feature
id: F4.10
status: done
area: terminal/file-transfer
components: [TerminalPanel, ZmodemConflictDialog]
files:
  - src/lib/zmodem.ts
  - src/components/terminal/ZmodemConflictDialog.tsx
controls:
  - id: dialog
    selector: '[data-testid="zmodem-conflict"]'
    kind: display
    optional: true       # only when a name conflict surfaces during rz/sz
  - id: overwrite
    selector: '[data-testid="zmodem-overwrite"]'
    kind: interactive
    optional: true
  - id: rename
    selector: '[data-testid="zmodem-rename"]'
    kind: interactive
    optional: true
  - id: skip
    selector: '[data-testid="zmodem-skip"]'
    kind: interactive
    optional: true
-->

- 基于 `zmodem.js` 的 `Sentry` 实现协议检测，所有终端输出字节流经 `ZmodemSession.consume()` 透明路由
- **接收（sz → 本地）**：检测到远端 `sz` 握手后弹出目录选择对话框，通过 Tauri 文件写流（`onOpenWriteStream / onAppendWriteStream / onCloseWriteStream`）落盘，支持中途 abort
- **发送（rz → 远端）**：
  - 右键菜单 "Send file using Z-modem" 主动触发：弹出文件选择器，选好后自动向终端注入 `rz\r` 并排队发送
  - 远端主动执行 `rz` 时自动弹出文件选择器，通过 Tauri 文件读流（`onOpenReadStream / onReadStream / onCloseReadStream`）分块发送
- 传输进度条：实时显示文件名、已传字节 / 总字节、百分比进度条，覆盖接收与发送两个方向
- 文件冲突对话框 `ZmodemConflictDialog`：目标文件已存在时弹出 Overwrite / Skip / Rename，可勾选 "应用到剩余文件"
- 事件日志：传输完成与错误均写入终端事件日志（`appendEvent("zmodem", ...)`）
- 状态互斥：传输进行中菜单项 disabled，防止并发冲突；传输结束后自动重置为 idle
- 协议容错：`on_retract` / 超时 grace 期（750 ms）自动重置协议状态，异常时重建 Sentry 实例
- 内存占用优化：传输管线按块流式处理，避免整文件常驻内存
- 已修复 password 模式 SSH 终端下 rz/sz 不工作 / 弹出多次文件选择器 / vi 等 TUI 程序回归等问题

### 4.11 MultiExec 多终端广播模式 ✅

<!-- feature
id: F4.11
status: done
area: terminal/multiexec
components: [MultiExecBar]
files:
  - src/components/terminal/MultiExecBar.tsx
controls:
  - id: bar
    selector: '[data-testid="multiexec-bar"]'
    kind: display
    optional: true       # only when MultiExec is active
  - id: input
    selector: '[data-testid="multiexec-input"]'
    kind: interactive
    optional: true
-->

- Ribbon 入口 + 全局 `Ctrl+Alt+M` 切换
- 选中多个标签后，输入广播到所有被选中的终端
- `MultiExecBar`：紧凑发送条 + 可拖拽的展开编辑器（多行文本、最近命令历史、回车 / Ctrl+Enter 发送）
- 选中状态在 TabBar 上有视觉标记（`isMultiExecTarget`）

### 4.12 Common commands 调色板 ✅

<!-- feature
id: F4.12
status: done
area: terminal/palette
components: [CommonCommandsPalette]
files:
  - src/components/terminal/CommonCommandsPalette.tsx
controls:
  - id: palette
    selector: '[data-testid="commands-palette"]'
    kind: display
    optional: true       # only when palette is open
  - id: search
    selector: '[data-testid="commands-search"]'
    kind: interactive
    optional: true
  - id: list
    selector: '[data-testid="commands-list"]'
    kind: display
    optional: true
-->

- 本地终端中通过快捷键调出 `CommonCommandsPalette`
- 候选合并三类来源并去重：命令历史（host 维度）、用户自定义命令、平台预置命令（Windows / Unix 各一套，覆盖 nav / git / network / process / system / files / env）
- 选中后注入到当前终端

### 4.13 终端截图 / 滚动截屏 / GIF 录制 ✅

<!-- feature
id: F4.13
status: done
area: capture
components: [CaptureToolbar, FloatingToolbar]
files:
  - src/components/capture/CaptureToolbar.tsx
  - src/lib/capture/
controls:
  - id: toolbar-root
    selector: '[data-testid="capture-toolbar"]'
    kind: display
  - id: capture-menu
    selector: '[data-testid="capture-menu"]'
    kind: interactive
  - id: save-visible
    selector: '[data-testid="capture-save-visible"]'
    kind: interactive
    optional: true       # only renders when menu is open
  - id: copy-clipboard
    selector: '[data-testid="capture-copy-clipboard"]'
    kind: interactive
    optional: true
  - id: save-full
    selector: '[data-testid="capture-save-full"]'
    kind: interactive
    optional: true       # menu open AND host provides getFull
  - id: toggle-scroll
    selector: '[data-testid="capture-toggle-scroll"]'
    kind: interactive
    optional: true       # menu open AND host provides getScrollFrame
  - id: toggle-gif
    selector: '[data-testid="capture-toggle-gif"]'
    kind: interactive
    optional: true       # menu open AND host provides getGifFrame
  - id: stop-scroll-pill   # active-capture pill, only while scroll-capturing
    selector: '[data-testid="capture-stop-scroll"]'
    kind: interactive
    optional: true
  - id: stop-gif-pill      # active-capture pill, only while recording
    selector: '[data-testid="capture-stop-gif"]'
    kind: interactive
    optional: true
-->

- 终端面板内嵌 `CaptureToolbar`（通过 `FloatingToolbar` 浮窗承载，可拖拽 / 折叠 / 位置持久化）
- **可见区域 PNG**：截取当前可见 viewport，可保存到磁盘或写入剪贴板（`ClipboardItem`）
- **滚动截屏**：滚动捕获整段 scrollback 拼接为单张长图（`startScrollCapture`）
- **GIF 录制**：基于 `gifenc` 的实时录制，工具条显示计时与 Stop；保存为 .gif
- 文件名前缀按上下文（terminal / vnc）自动生成时间戳后缀

---

## 5. 终端外观与配置

### 5.1 OS 字体枚举 ✅

<!-- feature
id: F5.1
status: done
area: terminal/appearance
files:
  - src/lib/systemFonts.ts
  - src-tauri/src/appearance/
controls: []   # font enumeration is consumed by F4.2/F5.2 UI controls
-->

- Tauri 命令 `list_system_fonts`（基于 `font-kit`）
- 前端 IPC 拉取系统字体列表，加载失败时使用安全 fallback
- Source Code Pro 在可用时作为默认字体

### 5.2 终端主题画廊（Termius 风格）✅

<!-- feature
id: F5.2
status: done
area: terminal/appearance
components: [TerminalAppearanceSettings]
files:
  - src/components/terminal/TerminalAppearanceSettings.tsx
controls:
  - id: appearance-root
    selector: '[data-testid="terminal-appearance-settings"]'
    kind: display
  - id: theme-gallery
    selector: '[data-testid="terminal-theme-gallery"]'
    kind: display
  - id: preview
    selector: '[data-testid="terminal-preview"]'
    kind: display
  - id: preview-cursor
    selector: '[data-testid="terminal-preview-cursor"]'
    kind: display
  # Settings inputs (aria-label fallback — promote to testids when these labels change)
  - id: font-size
    selector: 'input[aria-label="Terminal font size"]'
    kind: interactive
  - id: font-family
    selector: 'select[aria-label="Terminal font"]'
    kind: interactive
  - id: font-size-decrease
    selector: 'button[aria-label="Decrease text size"]'
    kind: interactive
  - id: font-size-increase
    selector: 'button[aria-label="Increase text size"]'
    kind: interactive
  - id: font-ligatures-toggle
    selector: 'input[aria-label="Enable font ligatures"]'
    kind: interactive
  - id: scrollback
    selector: 'input[aria-label="Scrollback lines"]'
    kind: interactive
  - id: inline-suggestions-max
    selector: 'input[aria-label="Maximum command history entries per host"]'
    kind: interactive
  - id: cursor-style
    selector: 'select[aria-label="Terminal cursor"]'
    kind: interactive
  - id: right-click-behavior
    selector: 'select[aria-label="Right click behavior"]'
    kind: interactive
  - id: background-hex
    selector: 'input[aria-label="Terminal background hex"]'
    kind: interactive
  - id: foreground-hex
    selector: 'input[aria-label="Terminal foreground hex"]'
    kind: interactive
-->

- 多套预置主题，带可视化预览
- 主题元数据驱动 UI
- 终端右键菜单可快速切换主题（无需重连重挂载）

### 5.3 共享外观控件 `TerminalAppearanceSettings` ✅
- 字体选择器、字号 stepper、主题画廊、底部预览
- 光标样式（block / underline / bar）+ 闪烁
- Scrollback 行数、日志、关键字高亮、显示项、剪贴板/粘贴策略
- 同一控件复用于全局设置面板与会话编辑器
- 实时预览反映光标样式与闪烁状态

### 5.4 配置持久化 ✅
- 全局终端配置：`localStorage`（默认值，未保存会话使用）
- 每会话 override：`session.options_json.terminalProfile`
- 活跃终端可在不重启的情况下应用主题/字体/字号/连字变化

### 5.5 应用整体主题（Light / Dark / Follow system）✅

<!-- feature
id: F5.5
status: done
area: main/theme
files:
  - src/lib/appTheme.ts
  - src/components/settings/AppThemeSwitcher.tsx
controls:
  # Title-bar quick-cycle theme button is owned by F1.3 (theme-cycle).
  # F5.5 owns the in-Settings switcher: 3-button group + compact <select> + standalone icon button.
  - id: theme-light
    selector: '[data-testid="app-theme-light"]'
    kind: interactive
  - id: theme-dark
    selector: '[data-testid="app-theme-dark"]'
    kind: interactive
  - id: theme-system
    selector: '[data-testid="app-theme-system"]'
    kind: interactive
  - id: theme-compact-select
    selector: 'select[aria-label="Application theme"]'
    kind: interactive
    optional: true       # only renders in compact mode of AppThemeSwitcher
  - id: theme-icon-button
    selector: 'button[aria-label="Cycle application theme"]'
    kind: interactive
    optional: true       # AppThemeIconButton — currently unused outside the title-bar tray
-->

- `localStorage` key `newmob.appTheme.v1`
- `data-app-theme` 应用到 root document
- Follow system 监听 `prefers-color-scheme` 变化
- 全局 Settings、Welcome、顶部菜单、会话设置标题栏均可快速切换主题
- MenuBar / Ribbon / QuickConnect / Tabs / Sidebar / StatusBar / Cards / Inputs / Buttons / 右键菜单 / 会话设置 / 认证弹窗 全部接入主题变量

---

## 6. 会话管理

### 6.1 SQLite 会话存储 ✅

<!-- feature
id: F6.1
status: done
area: sessions/persistence
files:
  - src-tauri/src/session/
  - src/stubs/tauri-core.ts
controls: []   # backend-only — SQLite persistence + dev-mode IPC stubs; sidebar/editor surfaces belong to F6.2 / F6.3
-->

- 表：`sessions` + `session_groups`
- 命令：`list_sessions / get_session / save_session / delete_session / mark_session_connected / list_session_groups / save_session_group / delete_session_group`
- 应用启动时初始化于 `app_data_dir/newmob.db`
- 浏览器预览模式回退到 `localStorage`（key `newmob.sessions.v1` / `newmob.groups.v1`）

### 6.2 会话树 `SessionTree` ✅

<!-- feature
id: F6.2
status: done
area: sessions
components: [SessionTree, Sidebar]
files:
  - src/components/sidebar/SessionTree.tsx
  - src/components/sidebar/Sidebar.tsx
  - src/lib/customDnD.ts
controls:
  - id: sidebar
    selector: '[data-testid="sidebar"]'
    kind: display
  - id: session-tree
    selector: '[data-testid="session-tree"]'
    kind: display
  - id: session-tree-item       # individual row; pair with [data-session-name=...] / [data-session-type=...]
    selector: '[data-testid="session-tree-item"]'
    kind: interactive
  - id: session-search
    selector: '[data-testid="session-search"]'
    kind: interactive
  - id: session-new
    selector: '[data-testid="session-new"]'
    kind: interactive
  - id: session-edit
    selector: '[data-testid="session-edit"]'
    kind: interactive
  - id: session-duplicate
    selector: '[data-testid="session-duplicate"]'
    kind: interactive
  - id: session-delete
    selector: '[data-testid="session-delete"]'
    kind: interactive
-->

- 分组树（展开 / 折叠 / 拖拽到分组）
- 搜索框 `session-search`
- 双击 → 触发连接
- 右键菜单：Connect / Edit / Duplicate / Move to folder / Delete
- 「最近连接」区域

### 6.3 会话编辑器 `SessionEditor` ✅

<!-- feature
id: F6.3
status: done
area: sessions
components: [SessionEditor]
files:
  - src/components/session/SessionEditor.tsx
controls:
  # Dialog frame
  - id: editor
    selector: '[data-testid="session-editor"]'
    kind: display
  # Protocol selectors (dynamic: session-proto-${id.toLowerCase()})
  - id: proto-ssh
    selector: '[data-testid="session-proto-ssh"]'
    kind: interactive
  - id: proto-sftp
    selector: '[data-testid="session-proto-sftp"]'
    kind: interactive
  - id: proto-rdp
    selector: '[data-testid="session-proto-rdp"]'
    kind: interactive
  - id: proto-vnc
    selector: '[data-testid="session-proto-vnc"]'
    kind: interactive
  - id: proto-telnet
    selector: '[data-testid="session-proto-telnet"]'
    kind: interactive
    optional: true        # placeholder protocols may be hidden in some builds
  - id: proto-mosh
    selector: '[data-testid="session-proto-mosh"]'
    kind: interactive
    optional: true
  - id: proto-localshell
    selector: '[data-testid="session-proto-localshell"]'
    kind: interactive
    optional: true
  - id: proto-file-browser
    selector: '[data-testid="session-proto-file-browser"]'
    kind: interactive
    optional: true
  # Top-level connection fields (visible when SSH/SFTP/VNC/RDP)
  - id: host
    selector: '[data-testid="session-host"]'
    kind: interactive
  - id: user
    selector: '[data-testid="session-user"]'
    kind: interactive
  - id: port
    selector: '[data-testid="session-port"]'
    kind: interactive
  - id: name
    selector: '[data-testid="session-name"]'
    kind: interactive
  - id: file-target
    selector: '[data-testid="session-file-target"]'
    kind: interactive
    optional: true        # only visible for file-browser proto
  # Section tabs (dynamic: session-section-${t.id})
  - id: section-bookmark
    selector: '[data-testid="session-section-bookmark"]'
    kind: interactive
  - id: section-advanced
    selector: '[data-testid="session-section-advanced"]'
    kind: interactive
  - id: section-terminal
    selector: '[data-testid="session-section-terminal"]'
    kind: interactive
  - id: section-network
    selector: '[data-testid="session-section-network"]'
    kind: interactive
  # Section bodies
  - id: advanced-body
    selector: '[data-testid="advanced-ssh-settings"]'
    kind: display
  - id: terminal-body
    selector: '[data-testid="terminal-settings"]'
    kind: display
  - id: network-body
    selector: '[data-testid="network-settings"]'
    kind: display
  - id: bookmark-body
    selector: '[data-testid="bookmark-settings"]'
    kind: display
  # Advanced SSH inputs (aria-label fallback — selectors will fail when label text changes; promote to testids later)
  - id: advanced-execute-command
    selector: 'input[aria-label="Execute command"]'
    kind: interactive
  - id: advanced-ssh-password
    selector: 'input[aria-label="SSH password"]'
    kind: interactive
    optional: true        # only when authMethod=Password
  - id: save-in-vault
    selector: '[data-testid="session-save-in-vault"]'
    kind: interactive
    optional: true        # only when authMethod=Password and vault is not empty
  - id: advanced-private-key
    selector: 'input[aria-label="Private key path"]'
    kind: interactive
    optional: true        # only when authMethod=PrivateKey
  - id: advanced-jump-host
    selector: 'input[aria-label="Jump host"]'
    kind: interactive
    optional: true
  - id: advanced-jump-user
    selector: 'input[aria-label="Jump user"]'
    kind: interactive
    optional: true
  - id: advanced-jump-port
    selector: 'input[aria-label="Jump port"]'
    kind: interactive
    optional: true
  # Network inputs
  - id: network-proxy-host
    selector: 'input[aria-label="Proxy host"]'
    kind: interactive
  - id: network-proxy-port
    selector: 'input[aria-label="Proxy port"]'
    kind: interactive
  - id: network-proxy-user
    selector: 'input[aria-label="Proxy username"]'
    kind: interactive
  - id: network-proxy-password
    selector: 'input[aria-label="Proxy password"]'
    kind: interactive
  - id: network-keepalive
    selector: 'input[aria-label="Keep-alive interval"]'
    kind: interactive
  - id: network-new-forward-local
    selector: 'input[aria-label="New forward local address"]'
    kind: interactive
  - id: network-new-forward-remote
    selector: 'input[aria-label="New forward remote address"]'
    kind: interactive
  - id: network-new-forward-desc
    selector: 'input[aria-label="New forward description"]'
    kind: interactive
  # Bookmark inputs
  - id: bookmark-background
    selector: 'input[aria-label="Background image"]'
    kind: interactive
  - id: bookmark-bg-opacity
    selector: 'input[aria-label="Background opacity"]'
    kind: interactive
  - id: bookmark-description
    selector: 'textarea[aria-label="Description notes"]'
    kind: interactive
  - id: bookmark-tags
    selector: 'input[aria-label="Tags"]'
    kind: interactive
  - id: bookmark-extra-params
    selector: 'input[aria-label="Additional parameters"]'
    kind: interactive
  - id: bookmark-shortcut
    selector: 'input[aria-label="Keyboard shortcut"]'
    kind: interactive
  # Footer
  - id: save
    selector: '[data-testid="session-save"]'
    kind: interactive
-->

- 协议选择：SSH、SFTP、RDP、VNC（SSH/SFTP 已实装；VNC 与 RDP 均已接入基础 client）
- 基础设置：host、port、username、auth method
- Advanced SSH：SSH-browser type、Auto-inject OSC 7、Execute command、跳板机/代理
- Terminal：复用 `TerminalAppearanceSettings` 全套外观控件
- Network：Keep-alive、proxy 配置、隧道转发列表（local/remote/dynamic 添加）
- Bookmark：name、group、tags、描述备注
- 顶部主题快速切换条
- Session 类型 LocalShell：在编辑器中设置启动参数

### 6.4 快速连接栏 `QuickConnect` ✅

<!-- feature
id: F6.4
status: done
area: sessions
components: [QuickConnect]
files:
  - src/components/quickconnect/QuickConnect.tsx
controls:
  - id: bar-root
    selector: '[data-testid="quick-connect"]'
    kind: display
  - id: input
    selector: '[data-testid="qc-input"]'
    kind: interactive
  - id: submit
    selector: '[data-testid="qc-submit"]'
    kind: interactive
  - id: back
    selector: '[data-testid="qc-back"]'
    kind: interactive
  - id: forward
    selector: '[data-testid="qc-forward"]'
    kind: interactive
  - id: home
    selector: '[data-testid="qc-home"]'
    kind: interactive
  - id: recent-button         # one of N rendered for each recent session
    selector: '[data-testid="qc-recent"]'
    kind: interactive
    optional: true            # only when there's at least one recent session
  - id: refresh
    selector: '[data-testid="qc-refresh"]'
    kind: interactive
-->

- 地址栏式输入：`ssh://user@host:port`、`ssh user@host:port`
- 自动解析协议/用户/主机/端口
- Enter 提交后弹出认证弹窗（密码场景）

### 6.5 认证弹窗 `AuthPrompt` ✅

<!-- feature
id: F6.5
status: done
area: sessions
components: [AuthPrompt]
files:
  - src/components/session/AuthPrompt.tsx
controls:
  - id: prompt
    selector: '[data-testid="auth-prompt"]'
    kind: display
  - id: password
    selector: '[data-testid="auth-password"]'
    kind: interactive
  - id: submit
    selector: '[data-testid="auth-submit"]'
    kind: interactive
  - id: cancel
    selector: '[data-testid="auth-cancel"]'
    kind: interactive
  - id: close
    selector: '[data-testid="auth-close"]'
    kind: interactive
-->

- 密码输入弹窗
- 空密码不可提交（防 Enter 误触）

### 6.6 OpenSSH 配置导入 ✅

<!-- feature
id: F6.6
status: done
area: sessions/import
files:
  - src/lib/sessionImportExport.ts
controls: []   # UI entry is F1.6's `import-openssh-card`; this feature is the import library logic only
-->

- 解析 `~/.ssh/config` 并批量导入会话
- Welcome 页提供入口

### 6.7 会话 import/export 工具 ✅
- `src/lib/sessionImportExport.ts` 提供导入导出能力（含单元测试）

---

## 7. SFTP 文件浏览器

### 7.1 SFTP 后端（russh-sftp 2.x）✅

<!-- feature
id: F7.1
status: done
area: sftp
files:
  - src-tauri/src/filebrowser/
controls: []   # backend-only — russh-sftp protocol layer; the dual-pane UI is owned by F7.2
-->

- 命令：
  - 连接：`sftp_attach / sftp_detach`
  - 浏览：`sftp_list_remote / sftp_list_local / sftp_local_home / sftp_local_drives / sftp_realpath / sftp_stat`
  - 增删改：`sftp_mkdir / sftp_remove / sftp_rename / sftp_chmod`
  - 读写：`sftp_read_file_text / sftp_write_file_text`
  - 传输：`sftp_upload / sftp_download / sftp_upload_dir / sftp_download_dir / sftp_upload_bytes / sftp_download_bytes`
  - 控制：`sftp_cancel_transfer / sftp_pause_transfer / sftp_resume_transfer`
  - 系统：`sftp_open_path`（xdg-open / open / start）
  - 跨窗口：`open_sftp_window`
- `ActiveSftp` 内持有 `client::Handle` 保持 SSH 连接存活

### 7.2 双面板浏览器 `FileBrowser` ✅

<!-- feature
id: F7.2
status: done
area: sftp
components: [FileBrowser, FilePanel]
files:
  - src/components/filebrowser/LocalFileBrowserPanel.tsx
  - src/components/filebrowser/FileBrowser.tsx
  - src/components/filebrowser/FilePanel.tsx
  - src/components/filebrowser/PathBreadcrumb.tsx
  - src/lib/sftp.ts
controls:
  - id: panel-root
    selector: '[data-testid="sftp-browser"]'
    kind: display
  - id: local-pane
    selector: '[data-testid="sftp-local-pane"]'
    kind: display
  - id: remote-pane
    selector: '[data-testid="sftp-remote-pane"]'
    kind: display
  - id: local-list
    selector: '[data-testid="sftp-local-list"]'
    kind: display
  - id: remote-list
    selector: '[data-testid="sftp-remote-list"]'
    kind: display
  - id: col-header-name
    selector: '[data-testid="col-header-name"]'
    kind: interactive       # click to sort
  - id: col-header-size
    selector: '[data-testid="col-header-size"]'
    kind: interactive
  - id: col-header-type
    selector: '[data-testid="col-header-type"]'
    kind: interactive
  - id: col-header-modified
    selector: '[data-testid="col-header-modified"]'
    kind: interactive
  - id: col-resize-name
    selector: '[data-testid="col-resize-name"]'
    kind: interactive       # drag handle
  - id: col-resize-size
    selector: '[data-testid="col-resize-size"]'
    kind: interactive
  - id: col-resize-modified
    selector: '[data-testid="col-resize-modified"]'
    kind: interactive
  - id: breadcrumb-drives-root
    selector: '[data-testid="breadcrumb-drives-root"]'
    kind: interactive
    optional: true          # Windows-only drives breadcrumb
-->

- 远程面板 + 本地面板（左右或上下，可切换 orientation）
- 列：图标 / 名称 / 大小 / 修改时间 / 类型 / 权限 / 所有者
- 列头点击排序
- 路径面包屑 + 路径输入框（Enter 跳转）
- 工具条：刷新、上一级、Home、新建文件、新建文件夹、上传、下载、预览、删除
- 多选 + 全选
- 本地新建文件、本地删除、本地上传到远程
- 远程预览（`sftp_remote_preview`）

### 7.3 文件传输队列 ✅

<!-- feature
id: F7.3
status: done
area: sftp
files:
  - src/components/filebrowser/FileTransferQueue.tsx
controls:
  - id: queue-root
    selector: '[data-testid="sftp-transfer-queue"]'
    kind: display
-->

- 状态：进度条、速度、ETA、状态徽章
- 操作：暂停 / 恢复 / 取消 / 重试
- 暂停事件 `sftp-paused-{id}` 即时反馈
- 文件夹传输：双向 `sftp_upload_dir` / `sftp_download_dir`（预先 dir_size 计算总量，按文件聚合进度）
- 跨窗口同步：`BroadcastChannel newmob.sftp.sync` 镜像同源窗口的传输队列
- 入队时记录 `kind: file | dir`，重试路由到正确命令
- 批量上传 / 下载吞吐优化：合并复制粘贴和拖拽路径，减少多文件场景下的 IPC 抖动
- 复制粘贴：跨面板复制粘贴文件（参考 OS 行为，配合 `application/x-newmob-files` MIME）

### 7.4 SFTP 入口（三种）✅

<!-- feature
id: F7.4
status: done
area: sftp
files:
  - src/components/filebrowser/FileBrowser.tsx
  - src/components/filebrowser/FileToolbar.tsx
  - src/components/filebrowser/SftpDetachedWindow.tsx
controls:
  - id: detach
    selector: '[data-testid="sftp-detach"]'
    kind: interactive
    optional: true       # only when host wires onDetach
  - id: close
    selector: '[data-testid="sftp-close"]'
    kind: interactive
    optional: true       # only when host wires onClose (attached sidebar)
  - id: orientation-toggle
    selector: '[data-testid="sftp-orientation-toggle"]'
    kind: interactive
  - id: local-detach           # toolbar detach (FileToolbar testId={`sftp-${side}-detach`})
    selector: '[data-testid="sftp-local-detach"]'
    kind: interactive
    optional: true
  - id: remote-detach
    selector: '[data-testid="sftp-remote-detach"]'
    kind: interactive
    optional: true
-->

- **附加侧边栏**：每个 SSH 终端右上角 `attached-sftp-toggle`，与终端共用凭证；远程面板首次跟随 OSC 7 跳转一次，工具条 Sync 按钮可手动重跳
- **独立标签页**：从会话编辑器选择 `SessionType::SFTP` → 全标签 `FileBrowser`，未激活时仍挂载以保持传输
- **分离窗口**：附加 / 独立两种均提供 Detach 入口
  - Tauri：通过 `open_sftp_window` 打开真实 OS WebviewWindow
  - 浏览器：`window.open` 兜底
  - 使用独立 sessionId（`__detached`）避免与父窗口共享 SFTP channel
  - 通过 `localStorage` `newmob.sftp.detached.<sid>` 传递凭证
  - 父窗口 OSC 7 cwd 通过 `BroadcastChannel` 同步给分离窗口

### 7.5 面板交互 ✅

<!-- feature
id: F7.5
status: done
area: sftp
files:
  - src-tauri/src/lib.rs
  - src/components/filebrowser/FileToolbar.tsx
  - src/components/filebrowser/FilePanel.tsx
  - src/components/filebrowser/PathBreadcrumb.tsx
  - src/components/filebrowser/ChmodDialog.tsx
  - src/lib/customDnD.ts
controls:
  # path input + breadcrumb (FilePanel renders PathBreadcrumb with testId={`sftp-${side}-path`})
  - id: local-path
    selector: '[data-testid="sftp-local-path"]'
    kind: interactive       # click to edit, Enter to navigate
  - id: remote-path
    selector: '[data-testid="sftp-remote-path"]'
    kind: interactive
  # toolbar — local side
  - id: local-back
    selector: '[data-testid="sftp-local-back"]'
    kind: interactive
  - id: local-forward
    selector: '[data-testid="sftp-local-forward"]'
    kind: interactive
  - id: local-up
    selector: '[data-testid="sftp-local-up"]'
    kind: interactive
  - id: local-refresh
    selector: '[data-testid="sftp-local-refresh"]'
    kind: interactive
  - id: local-upload-selected
    selector: '[data-testid="sftp-local-upload-selected"]'
    kind: interactive
    optional: true       # only when host wires onUploadSelected
  - id: local-open-selected
    selector: '[data-testid="sftp-local-open-selected"]'
    kind: interactive
    optional: true
  - id: local-reveal-in-os
    selector: '[data-testid="sftp-local-reveal-in-os"]'
    kind: interactive
    optional: true
  - id: local-new-folder
    selector: '[data-testid="sftp-local-new-folder"]'
    kind: interactive
  - id: local-new-file
    selector: '[data-testid="sftp-local-new-file"]'
    kind: interactive
    optional: true
  - id: local-delete
    selector: '[data-testid="sftp-local-delete"]'
    kind: interactive
    optional: true
  - id: local-chmod
    selector: '[data-testid="sftp-local-chmod"]'
    kind: interactive
    optional: true
  - id: local-preview
    selector: '[data-testid="sftp-local-preview"]'
    kind: interactive
    optional: true
  - id: local-toggle-hidden
    selector: '[data-testid="sftp-local-toggle-hidden"]'
    kind: interactive
  # toolbar — remote side
  - id: remote-back
    selector: '[data-testid="sftp-remote-back"]'
    kind: interactive
  - id: remote-forward
    selector: '[data-testid="sftp-remote-forward"]'
    kind: interactive
  - id: remote-up
    selector: '[data-testid="sftp-remote-up"]'
    kind: interactive
  - id: remote-refresh
    selector: '[data-testid="sftp-remote-refresh"]'
    kind: interactive
  - id: remote-download-selected
    selector: '[data-testid="sftp-remote-download-selected"]'
    kind: interactive
    optional: true
  - id: remote-upload-from-disk
    selector: '[data-testid="sftp-remote-upload-from-disk"]'
    kind: interactive
    optional: true
  - id: remote-new-folder
    selector: '[data-testid="sftp-remote-new-folder"]'
    kind: interactive
  - id: remote-new-file
    selector: '[data-testid="sftp-remote-new-file"]'
    kind: interactive
    optional: true
  - id: remote-delete
    selector: '[data-testid="sftp-remote-delete"]'
    kind: interactive
    optional: true
  - id: remote-chmod
    selector: '[data-testid="sftp-remote-chmod"]'
    kind: interactive
    optional: true
  - id: remote-preview
    selector: '[data-testid="sftp-remote-preview"]'
    kind: interactive
    optional: true
  - id: remote-toggle-hidden
    selector: '[data-testid="sftp-remote-toggle-hidden"]'
    kind: interactive
  - id: remote-open-terminal-here
    selector: '[data-testid="sftp-remote-open-terminal-here"]'
    kind: interactive
    optional: true
  # Right-click context-menu items (rendered by the shared ContextMenu surface)
  - id: ctx-permissions
    selector: '[data-testid="context-menu-item-permissions"]'
    kind: interactive
    aliases:
      - 'text="Permissions…"'
  - id: ctx-rename
    selector: '[data-testid="context-menu-item-rename"]'
    kind: interactive
    aliases:
      - 'text="Rename"'
  - id: ctx-delete
    selector: '[data-testid="context-menu-item-delete"]'
    kind: interactive
    optional: true       # also reachable via toolbar; menu item only fires when right-click chooses it
  # ChmodDialog (opened by ctx-permissions)
  - id: chmod-dialog
    selector: '[aria-label="Permissions"]'
    kind: display
  - id: chmod-apply
    selector: 'role=button[name="Apply"]'
    kind: interactive
-->

- 右键菜单：
  - 远程：Download to local、Rename、Permissions（chmod）、Delete、New folder、New file
  - 本地：对应操作
- chmod 对话框：Owner / Group / Other 三组权限位 + Apply
- 跨面板拖拽（REMOTE↔LOCAL）：`customDnD` 指针驱动层 + `application/x-newmob-files` MIME，支持多选与文件夹
- OS 文件拖入远程面板 → 直接上传到当前远程目录
  - Linux/macOS：通过 Tauri `onDragDropEvent` 拿到绝对路径，前端 `sftpStat(side="local") → controller.upload`
  - Windows：通过 webview HTML5 `dataTransfer.files`（拿不到绝对路径，按 File blob 上传）
  - 与跨面板拖拽并存：根据 `dataTransfer.types` 区分 OS drop（`Files` / `text/uri-list`）vs 内部 drop（`application/x-newmob-files`）
  - 主窗口 + 分离 SFTP 窗口 `dragDropEnabled=true`，仅 Windows `disable_drag_drop_handler()`
  - **e2e 测试限制**：依赖真实 OS 拖拽产生的 `DataTransfer.types=Files`/`text/uri-list` 或 Tauri `onDragDropEvent`，Playwright `drag_to` 与 `tauri-driver` 都无法合成此 payload；当前 verb-catalog 也禁止 `dispatchEvent`/`new DataTransfer`。覆盖由单元测试 `src/lib/osFileDrop.test.ts` + `FileToolbarWiring.test.tsx` 承担，平台行为（Win/macOS/Linux）需手动回归
- 双击文件：下载后用系统编辑器打开（"先下载"确认）
- Open terminal here：把远程当前路径发到关联终端（`cd 'path'`）

### 7.6 同步与方向控制 ✅
- 终端 cwd → 远程面板：一次性首次同步 + 手动 Sync 按钮（不再连续追踪）
- Pane orientation：横向/纵向布局切换 + per-scope 持久化（`newmob.sftp.orientation.<scope>`）
- 附加侧边栏默认 vertical，全标签/分离窗口默认 horizontal

### 7.7 浏览器预览模式 SFTP 桥接（开发用）✅
- `vite-plugins/sftpProxy.ts` WebSocket 桥
- `src/stubs/sftpClient.ts`、`localVfs.ts`（IndexedDB 模拟本地 FS）
- 仅 dev 模式启用

---

## 8. SSH 隧道（端口转发）

### 8.1 隧道后端 ✅
- 命令：`list_tunnels / upsert_tunnel / delete_tunnel / start_tunnel / stop_tunnel / start_all_tunnels / stop_all_tunnels / reorder_tunnels / test_tunnel / get_tunnel_status / list_tunnel_statuses`
- 类型：Local / Remote / Dynamic (SOCKS5)
- 应用启动时自动启动 `autostart=true` 的隧道
- 状态通过 `tunnel-status-{id}` 事件推送

### 8.2 隧道管理界面 `TunnelManager` ✅

<!-- feature
id: F8.2
status: done
area: tunnel
components: [TunnelManager, TunnelEditor]
files:
  - src/components/tunnel/TunnelManager.tsx
  - src/components/tunnel/TunnelEditor.tsx
controls:
  - id: panel-root
    selector: '[data-testid="tunnel-manager"]'
    kind: display
  - id: tunnel-list
    selector: '[data-testid="tunnel-list"]'
    kind: display
  # Footer: bulk actions
  - id: new-tunnel
    selector: '[data-testid="tunnel-new"]'
    kind: interactive
    aliases:
      - 'button:has-text("New SSH tunnel")'   # legacy text-based reference in TC-032..057
  - id: start-all
    selector: '[data-testid="tunnel-start-all"]'
    kind: interactive
  - id: stop-all
    selector: '[data-testid="tunnel-stop-all"]'
    kind: interactive
  - id: exit-button
    selector: '[data-testid="tunnel-exit"]'
    kind: interactive
    optional: true       # only rendered when onClose prop is wired
  # Per-row controls (matched by data-tunnel-id when targeting a specific tunnel)
  - id: row
    selector: '[data-testid="tunnel-row"]'
    kind: display
  - id: row-move-up
    selector: '[data-testid="tunnel-row-move-up"]'
    kind: interactive
  - id: row-move-down
    selector: '[data-testid="tunnel-row-move-down"]'
    kind: interactive
  - id: row-toggle           # central status-column start/stop button
    selector: '[data-testid="tunnel-row-toggle"]'
    kind: interactive
  - id: row-toggle-reveal
    selector: '[data-testid="tunnel-row-toggle-reveal"]'
    kind: interactive
  # Settings-column action icons (rendered via IconBtn — extractor missed them)
  - id: row-edit
    selector: '[data-testid="tunnel-row-edit"]'
    kind: interactive
  - id: row-edit-key
    selector: '[data-testid="tunnel-row-edit-key"]'
    kind: interactive
  - id: row-test
    selector: '[data-testid="tunnel-row-test"]'
    kind: interactive
  - id: row-clone
    selector: '[data-testid="tunnel-row-clone"]'
    kind: interactive
  - id: row-autostart
    selector: '[data-testid="tunnel-row-autostart"]'
    kind: interactive
  - id: row-delete
    selector: '[data-testid="tunnel-row-delete"]'
    kind: interactive
  - id: row-power            # right-edge duplicate of row-toggle
    selector: '[data-testid="tunnel-row-power"]'
    kind: interactive
  # TunnelEditor dialog (modal opened by new-tunnel / row-edit)
  - id: editor-root
    selector: '[data-testid="tunnel-editor"]'
    kind: display
  - id: editor-name
    selector: 'input[placeholder="e.g. postgres-replica"]'
    kind: interactive
  - id: editor-host
    selector: 'input[placeholder="ssh.example.com"]'
    kind: interactive
  - id: editor-user
    selector: 'input[placeholder="user"]'
    kind: interactive
  - id: editor-port
    selector: 'input[placeholder="22"]'
    kind: interactive
  - id: editor-local-port
    selector: 'input[placeholder="0"]'
    kind: interactive
  - id: editor-remote-host
    selector: 'input[placeholder="127.0.0.1"]'
    kind: interactive
    optional: true       # only rendered for remote-forward / dynamic kinds
  - id: editor-remote-port
    selector: 'input[placeholder="5432"]'
    kind: interactive
    optional: true
  - id: editor-kind-remote
    selector: 'label:has-text("Remote port forwarding") input[type="radio"]'
    kind: interactive
  - id: editor-kind-dynamic
    selector: 'label:has-text("Dynamic port forwarding (SOCKS proxy)") input[type="radio"]'
    kind: interactive
  - id: editor-save
    selector: '[data-testid="tunnel-editor-save"]'
    kind: interactive
    aliases:
      - 'button:has-text("Save")'
  - id: editor-cancel
    selector: '[data-testid="tunnel-editor-cancel"]'
    kind: interactive
    optional: true
-->

- 列表展示：类型、状态徽章（运行/错误/停止）、本地端口 → 远程地址、关联会话、认证图标
- 操作：启动 / 停止 / 启动全部 / 停止全部 / 测试 / 编辑 / 复制 / 删除 / 显示隐藏认证 / 拖拽排序
- 实时状态订阅 `listenTunnelStatus`
- 编辑器 `TunnelEditor`：填写所有字段、验证

---

## 9. VNC 客户端

### 9.1 嵌入式 VNC client（RFB 协议引擎）✅

<!-- feature
id: F9.1
status: done
area: vnc
files:
  - src-tauri/src/vnc/
controls: []   # backend-only — RFB protocol + WebSocket bridge; the canvas surface is owned by F9.6
-->

- Rust 端 VNC 模块：`src-tauri/src/vnc/{mod, rfb, ws, encodings, clipboard}.rs`
- Tauri 命令：`vnc_connect / vnc_disconnect / vnc_test_connection`
- 本地动态端口 WebSocket relay：VNC server ↔ 前端 Canvas（前端不再直接持有 TCP 套接字）

### 9.2 RFB 握手与认证 ✅
- 安全类型：None、VNC password、RealVNC RA2 / RA2ne（128 / 256 位 AES）
- RA2 子模式：USER_PASS、PASS-only；公钥位长度合法性校验（1024–8192 bit）

### 9.3 编码与画面 ✅
- 解码器：Raw（0）、CopyRect（1）、Hextile（5）、ZRLE（16，单一持久 zlib 流）
- 伪编码：DesktopSize（-223）+ 自动 SetDesktopSize 回写，远端分辨率切换不掉线
- ZRLE 单 zlib 状态贯穿整个 session，已修复历史的 "zrle: eof cpixel" 间歇性断连
- 像素格式 `set_pixel_format_rgba()` 协商成 little-endian RGBA，前端按位图直接渲染
- Tight 编码暂未启用（解码器尚未 RFC-conformant，避免 stream 失步）

### 9.4 ExtendedClipboard 互通 ✅
- 实现 ExtendedClipboard 伪编码（`0xC0A1E5CE` + 旧 draft 值 `-1063` 双广告兼容）
- 支持 actions：caps / request / peek / notify / provide
- 支持 formats：text (UTF-8)、HTML、RTF（zlib 压缩）
- 老服务器（vino 等）回落 legacy `ServerCutText / ClientCutText` 路径，并已修复中文剪贴板丢失 / Windows 11 端到端粘贴乱码 / 非 ASCII 粘贴丢失等回归
- 前端 ↔ 后端剪贴板桥：`vncStore` 协调，文本/HTML/RTF 选择性传输

### 9.5 输入处理 ✅
- 鼠标：左/中/右键、滚轮、拖拽（pointer capture）
- 键盘：包含 RealVNC 输入修复，组合键正确转发
- 剪贴板：双向同步，自动切换 Extended / Legacy

### 9.6 前端 `VncPanel` ✅

<!-- feature
id: F9.6
status: done
area: vnc
components: [VncPanel, FloatingToolbar, CaptureToolbar]
files:
  - src/components/vnc/VncPanel.tsx
controls:
  - id: panel-root
    selector: '[data-testid="vnc-panel"]'
    kind: display
  - id: canvas
    selector: '[data-testid="vnc-canvas"]'
    kind: display       # pointer / wheel / context-menu handlers fire only after a live RFB session;
                        # without a configured VNC fixture we can only verify the canvas is attached.
                        # Driving it is left to feature-flagged conformance tests.
  - id: floating-toolbar
    selector: '[data-testid="vnc-floating-toolbar"]'
    kind: display
    optional: true          # only renders when canvas is showing (connected)
  - id: scale-toggle
    selector: '[data-testid="vnc-scale-toggle"]'
    kind: interactive
    optional: true          # inside the floating toolbar
  - id: reconnect
    selector: '[data-testid="vnc-reconnect"]'
    kind: interactive
    optional: true          # only on disconnected/error state
-->

- Canvas 画面渲染 + fit / 1:1 缩放
- 浮动 `FloatingToolbar`：可拖拽 / 折叠 / 位置持久化
- 内嵌 `CaptureToolbar`：可见区域 PNG / 全帧 PNG / GIF 录制（与终端共用截图链路）
- 断开提示 + Reconnect、错误分类（区分用户主动断开 / 服务端断开 / 网络异常）
- 保存的 VNC 会话可从会话树双击连接，密码场景复用 `AuthPrompt`
- VNC tab 常驻挂载，切换标签时连接不主动销毁
- 已修复 VNC 剪贴板与输入延迟、Windows 11 上的 client→server 文本粘贴

### 9.7 RDP client（IronRDP 0.14）🟡

<!-- feature
id: F9.7
status: partial
area: rdp
components: [RdpPanel, RdpOptionsForm]
files:
  - src/components/rdp/RdpPanel.tsx
  - src/components/session/forms/RdpOptionsForm.tsx
  - src/lib/rdp.ts
  - src/types/rdp.ts
  - src-tauri/src/rdp/mod.rs
  - src-tauri/src/rdp/ws.rs
  - src-tauri/src/rdp/session.rs
  - src-tauri/src/rdp/transport.rs
  - src-tauri/src/rdp/gateway/mod.rs
controls:
  - id: panel-root
    selector: '[data-testid="rdp-panel"]'
    kind: display
  - id: toolbar
    selector: '[data-testid="rdp-toolbar"]'
    kind: display
  - id: status
    selector: '[data-testid="rdp-status"]'
    kind: display
  - id: canvas
    selector: '[data-testid="rdp-canvas"]'
    kind: display       # browser-mode smoke verifies mount; live frame paint is covered by Rust live tests
  - id: scale-toggle
    selector: '[data-testid="rdp-scale-toggle"]'
    kind: interactive
  - id: resize
    selector: '[data-testid="rdp-resize"]'
    kind: interactive
    optional: true       # disabled until an RDP session reaches connected
  - id: reconnect
    selector: '[data-testid="rdp-reconnect"]'
    kind: interactive
  - id: fullscreen
    selector: '[data-testid="rdp-fullscreen"]'
    kind: interactive
-->

- Tauri desktop 模式下通过 IronRDP 0.14 驱动真实 RDP 会话：CredSSP/NLA、active-stage 图像解码、键盘/鼠标/滚轮输入、画布绘制
- 传输路径支持 direct TCP、HTTP/SOCKS5 proxy，以及 RD Gateway（MS-TSGU）代码路径；RD Gateway 当前无真实环境，只以 unit test + ignored live smoke 作为验收
- RDP tab 常驻挂载，保存会话和 `rdp://` QuickConnect 均能打开 RDP panel；密码场景复用 `AuthPrompt`
- resize 优先使用 DisplayControl DVC；服务器不开放该通道时保持同一 WS/control session 并按新桌面尺寸重连
- RDP options 表单已持久化 domain、color depth、NLA/performance、clipboard、audio、drive redirection、RD Gateway 配置
- 浏览器预览模式只提供 desktop-only stub；真实协议连接和画面验证必须在 Tauri/native 或 Rust live test 环境下执行

### 9.8 已知限制
- QuickConnect 的 VNC URL 尚未接入主流程（已保存的 VNC 会话连接路径不受影响）
- 浏览器预览模式没有 VNC stub（仅 Tauri 桌面下可用）

---

## 10. 截图 / 录屏 / 浮动工具条（共享基础设施）

### 10.1 `FloatingToolbar` ✅
- 任意 tab 内嵌的浮动浮窗：可拖拽、可折叠、最小化为 pill
- 位置 / 折叠状态按 `storageKey` 持久化到 `localStorage`
- 终端、VNC、SFTP 等多个面板共用

### 10.2 `CaptureToolbar` ✅
- 三类操作：可见区域 PNG、滚动 / 全帧 PNG、GIF 录制
- 输出路由：保存到磁盘（`saveBlobToFile` 走原生保存对话框）/ 复制到剪贴板（`ClipboardItem`）
- `startScrollCapture`：滚动区域逐帧拼接为长图（终端 scrollback / VNC 画面）
- `createGifRecorder`：基于 `gifenc` 的 GIF 实时编码，工具条显示录制时长 + Stop
- 文件名前缀按上下文 + 时间戳生成（`safeFilePart` / `timestampFilePart`）

### 10.3 文件 IO 流式 IPC ✅
- Tauri 命令对：`read_stream_open / read_stream_read / read_stream_close` 与 `write_stream_open / write_stream_append / write_stream_close / write_stream_abort`
- 用于 zmodem / 大文件 / GIF 等场景，避免一次性把整个文件塞进单次 IPC body
- `read_file_bytes` 用 `tauri::ipc::Response::new(bytes)` 返回原始二进制，跳过 base64
- 配合 `clipboard_read_text / clipboard_write_text`、`check_file_exists`、`select_save_directory / select_save_file_path / select_upload_file / select_private_key_file` 等原生对话框命令

### 10.4 命令历史持久化 ✅
- SQLite 表 `command_history`（host_key + command 唯一）+ `last_used_at` / `use_count`
- Tauri 命令：`history_append / history_match_prefix / history_list_recent / history_clear`
- 写入按 host 上限自动 LRU 裁剪
- 复用于终端 inline ghost-text 自动补全 + Common commands 调色板

---

## 11. 应用全局设置 `SettingsPanel` ✅

<!-- feature
id: F11.1
status: done
area: settings
components: [SettingsPanel]
files:
  - src/components/settings/SettingsPanel.tsx
controls:
  - id: panel-root
    selector: '[data-testid="settings-panel"]'
    kind: display
  - id: reset-terminal-profile
    selector: '[data-testid="settings-reset-terminal-profile"]'
    kind: interactive
-->

- Application Theme 切换（Light / Dark / Follow system）
- Terminal Appearance 区块（与会话编辑器 Terminal 段一致的完整外观与行为控件）
- 终端预览
- 设置项即时持久化

---

## 12. 凭证保险库（Credential Vault）

### 12.1 保险库管理 `VaultSettings` ✅

<!-- feature
id: F12.1
status: done
area: vault
components: [VaultSettings, VaultSetupDialog, VaultUnlockDialog]
files:
  - src/components/vault/VaultSettings.tsx
  - src/components/vault/VaultSetupDialog.tsx
  - src/components/vault/VaultUnlockDialog.tsx
  - src/stores/vaultStore.ts
  - src-tauri/src/vault/
controls:
  - id: settings-root
    selector: '[data-testid="vault-settings"]'
    kind: display
  - id: state-badge
    selector: '[data-testid="vault-state-badge"]'
    kind: display
  - id: init-button
    selector: '[data-testid="vault-init-button"]'
    kind: interactive
    optional: true       # only when state=empty
  - id: unlock-button
    selector: '[data-testid="vault-unlock-button"]'
    kind: interactive
    optional: true       # only when state=locked
  - id: lock-button
    selector: '[data-testid="vault-lock-button"]'
    kind: interactive
    optional: true       # only when state=unlocked
  - id: change-master-button
    selector: '[data-testid="vault-change-master-button"]'
    kind: interactive
    optional: true       # only when state=unlocked
  - id: change-master-form
    selector: '[data-testid="vault-change-master-form"]'
    kind: display
    optional: true       # only when change-master action is active
  - id: change-master-old
    selector: '[data-testid="vault-change-master-old"]'
    kind: interactive
    optional: true
  - id: change-master-new1
    selector: '[data-testid="vault-change-master-new1"]'
    kind: interactive
    optional: true
  - id: change-master-new2
    selector: '[data-testid="vault-change-master-new2"]'
    kind: interactive
    optional: true
  - id: change-master-submit
    selector: '[data-testid="vault-change-master-submit"]'
    kind: interactive
    optional: true
  - id: entries-section
    selector: '[data-testid="vault-entries-section"]'
    kind: display
    optional: true       # only when state=unlocked
  # VaultSetupDialog
  - id: setup-dialog
    selector: '[data-testid="vault-setup-dialog"]'
    kind: display
    optional: true       # only when init action is active
  - id: setup-pw1
    selector: '[data-testid="vault-setup-pw1"]'
    kind: interactive
    optional: true
  - id: setup-pw2
    selector: '[data-testid="vault-setup-pw2"]'
    kind: interactive
    optional: true
  - id: setup-cancel
    selector: '[data-testid="vault-setup-cancel"]'
    kind: interactive
    optional: true
  - id: setup-confirm
    selector: '[data-testid="vault-setup-confirm"]'
    kind: interactive
    optional: true
  - id: setup-too-short
    selector: '[data-testid="vault-setup-too-short"]'
    kind: display
    optional: true       # only when pw1 is 1-7 chars
  - id: setup-mismatch
    selector: '[data-testid="vault-setup-mismatch"]'
    kind: display
    optional: true       # only when pw2 differs from pw1
  - id: setup-error
    selector: '[data-testid="vault-setup-error"]'
    kind: display
    optional: true       # only on submit error
  # VaultUnlockDialog
  - id: unlock-dialog
    selector: '[data-testid="vault-unlock-dialog"]'
    kind: display
    optional: true       # only when unlock action is active
  - id: unlock-pw
    selector: '[data-testid="vault-unlock-pw"]'
    kind: interactive
    optional: true
  - id: unlock-reason
    selector: '[data-testid="vault-unlock-reason"]'
    kind: display
    optional: true       # only when reason prop is provided
  - id: unlock-cancel
    selector: '[data-testid="vault-unlock-cancel"]'
    kind: interactive
    optional: true
  - id: unlock-confirm
    selector: '[data-testid="vault-unlock-confirm"]'
    kind: interactive
    optional: true
  - id: unlock-error
    selector: '[data-testid="vault-unlock-error"]'
    kind: display
    optional: true       # only on wrong password
-->

- AES-256-GCM 加密存储，密钥由 Argon2id 从主密码派生
- 三态生命周期：empty（未初始化）→ locked（已设置但未解锁）→ unlocked（可读写）
- **初始化**：VaultSetupDialog 设置主密码（≥8 字符，二次确认）
- **解锁**：VaultUnlockDialog 输入主密码解锁，错误密码提示
- **锁定**：一键锁定，从内存中清除密钥
- **修改主密码**：输入旧密码 + 新密码（≥8 字符，二次确认）
- **条目管理**：解锁后展示已保存条目列表，支持删除
- 会话编辑器 / 隧道编辑器中 "Save in vault" 复选框将密码加密存入保险库
- 打开已保存密码的会话时自动触发解锁流程

---

## 13. 自动化测试基线

### 13.1 单元测试（Vitest）✅
- 测试文件 17 个，覆盖：
  - `ChmodDialog`、`FileToolbarWiring`、`SftpPolish`
  - `SessionEditor`
  - `AppThemeSwitcher`、`SettingsPanel`、`TerminalAppearanceSettings`
  - `MainLayout`
  - `CommonCommandsPalette`、`TerminalPanel`
  - `clipboard`、`zmodem`、`terminalOutputFilter`、`terminalImeGuard`、`sessionImportExport`
  - `VaultSetupDialog`、`VaultUnlockDialog`
  - `appStore`（含 moveTab / updateTabTitle）

### 13.2 Rust 测试 ✅
- `appearance::lists_installed_font_families` 验证 OS 字体枚举
- VNC `encodings` 模块单元测试（Hextile / ZRLE 解码、跨 rectangle 共享 zlib 状态）
- VNC `clipboard` 模块单元测试（Extended caps body 编/解码）
- Vault `crypto` + `db` 模块单元测试（加密/解密、条目 CRUD、主密码变更）
- `cargo check` 通过

### 13.3 端到端测试用例（`qa-ui-auto-tests/cases/*.testcase.yaml`，被 `qa-ui-auto` 消费）✅ 89 条
- 覆盖 TC-001 ～ TC-109：主界面、设置、会话编辑器、SSH/SFTP/QuickConnect 全流程、终端右键菜单与快捷键、SFTP 多种交互（chmod / rename / 拖拽 / 多选 / 双击下载 / 列宽 / 创建文件夹）、独立 SFTP 标签、open-terminal-here、会话树搜索 / 复制 / 拖拽、标签栏右键与移动动作、应用主题循环、隧道编辑器与重排、终端字体连字 / 字体搜索 / 语法高亮、本地管理员启动、tab 中键关闭、会话 import/export 多格式、OpenSSH config 导入、Welcome active connections、custom title bar、compact mode、MultiExec、command palette、capture toolbar、zmodem 冲突、VNC scaffold 等

### 13.4 部署 ✅
- Replit 上验证通过：Tauri 桌面构建（`pnpm tauri build --debug --no-bundle`）通过 VNC 查看；Web 模式作为静态站点构建到 `dist/`
- GitHub Actions：`release.yml` 推送 `v<version>` tag 触发跨平台打包

---

## 14. AI 子系统

### 14.1 AI 总开关与隐私 ✅

<!-- feature
id: F-AI-2.1
status: done
area: ai/settings
components: [AiMasterSwitch, PrivacyToggle, SettingsPanel]
files:
  - src/components/settings/AiMasterSwitch.tsx
  - src/components/settings/PrivacyToggle.tsx
  - src/components/settings/SettingsPanel.tsx
  - src/stores/aiStore.ts
controls:
  - id: ai-master-toggle
    selector: 'text="Disable AI completely"'
    kind: interactive
  - id: privacy-fully-local
    selector: 'text="Full local mode"'
    kind: interactive
    optional: true       # only shown when AI master is enabled
-->

- `AiMasterSwitch`：一键关闭所有 AI 入口（Drawer 按钮、PTT、命令重写等），内存占用与网络调用全部归零
- `PrivacyToggle`：保持 AI 启用，但强制把请求路由到 loopback / 本地 provider
- 状态由 `aiStore.config.fully_disabled` 持久化；勾选后标题栏 `ai-chat-drawer-toggle` 与 `ptt-button` 立即从 DOM 中移除

### 14.2 终端补全与命令重写 ✅

<!-- feature
id: F-AI-2.2
status: done
area: ai/terminal
components: [TerminalAppearanceSettings, AiRewriteOverlay]
files:
  - src/components/terminal/TerminalAppearanceSettings.tsx
  - src/components/terminal/AiRewriteOverlay.tsx
controls:
  - id: inline-suggestions-history
    selector: 'input[name="inlineSuggestionsSource"][value="history"]'
    kind: interactive
  - id: inline-suggestions-history-path
    selector: 'input[name="inlineSuggestionsSource"][value="history+path"]'
    kind: interactive
  - id: inline-suggestions-history-path-ai
    selector: 'input[name="inlineSuggestionsSource"][value="history+path+ai"]'
    kind: interactive
  - id: ai-command-rewrite-shortcut
    selector: 'input[aria-label="AI command rewrite shortcut"]'
    kind: interactive
-->

- 三档 inline 候选源切换（History / +PATH / +PATH+AI）持久化至 `terminalProfile`
- `Enable AI command rewrite (Ctrl+K)` 开关 + 自定义快捷键输入框
- 选择 `+ai` 时按需下载 FIM 模型（约 400 MB）；本地 PowerShell 终端忽略此功能避免与 PSReadLine 冲突

### 14.3 PTT 语音录制按钮 ✅

<!-- feature
id: F-AI-2.3
status: done
area: ai/voice
components: [PttButton, AsrPanel, TitleBarTrayControls]
files:
  - src/components/window/PttButton.tsx
  - src/components/settings/AsrPanel.tsx
  - src-tauri/src/voice/
controls:
  - id: ptt-button
    selector: '[data-testid="ptt-button"]'
    kind: interactive
    optional: true       # hidden when AI master switch is on (fully_disabled)
-->

- 标题栏托盘内的麦克风按钮：按下开始录音、释放停止 + 转写
- 探测 `voice_capture_supported` 失败时按钮置灰并显示 `MicOff` 图标（`data-state="unsupported"`）
- 转写结果通过 `chatStore.attachToComposer(text, "global")` 暂存到 Chat 输入框，便于检视后再发送
- AI 全局禁用 (`fully_disabled`) 时整个按钮被卸载

### 14.4 AI Chat Drawer ✅

<!-- feature
id: F-AI-2.4
status: done
area: ai/chat
components: [ChatDrawer, ChatThreadList, Composer, AttachmentChip, MessageBubble, NewThreadFormatPicker, SearchProgressChip, CodeBlockToolbar]
files:
  - src/components/chat/ChatDrawer.tsx
  - src/components/chat/ChatThreadList.tsx
  - src/components/chat/Composer.tsx
  - src/components/chat/AttachmentChip.tsx
  - src/components/chat/MessageBubble.tsx
  - src/components/chat/NewThreadFormatPicker.tsx
  - src/components/chat/SearchProgressChip.tsx
  - src/components/chat/CodeBlockToolbar.tsx
  - src/lib/chat/composerRefs.ts
  - src/lib/chat/renderFormatted.ts
  - src/stores/chatStore.ts
controls:
  - id: ai-chat-drawer
    selector: '[data-testid="ai-chat-drawer"]'
    kind: display
    optional: true       # only mounted when drawerOpen
  - id: ai-chat-drawer-textarea
    selector: '[data-testid="ai-chat-drawer"] textarea'
    kind: interactive
    optional: true
  - id: ai-chat-new
    selector: 'button[title="New chat"]'
    kind: interactive
    optional: true
  - id: ai-chat-new-global
    selector: 'button[title="New global chat (no terminal binding)"]'
    kind: interactive
    optional: true
  - id: ai-chat-history
    selector: 'button[title="History"]'
    kind: interactive
    optional: true
  - id: ai-chat-copy-all
    selector: 'button[aria-label="Copy entire conversation"]'
    kind: interactive
    optional: true
  - id: ai-chat-close
    selector: '[data-testid="ai-chat-drawer"] button[title^="Close"]'
    kind: interactive
    optional: true
  - id: ai-chat-provider-select
    selector: 'select[aria-label="Thread LLM provider"]'
    kind: interactive
    optional: true       # rendered only when an active thread + at least one provider configured
  - id: ai-chat-output-format
    selector: 'select[aria-label="Thread output format"]'
    kind: interactive
    optional: true       # locked into a span once the thread has any messages
  - id: ai-chat-format-cycle
    selector: 'button[aria-label="Convert visible transcript to another format"]'
    kind: interactive
    optional: true
  - id: attachment-chip
    selector: '[data-testid="attachment-chip"]'
    kind: display
    optional: true       # only when composer text contains a parseable @ref
-->

- 全局唯一抽屉（每窗口一个），由 `chatStore.drawerOpen` + `drawerScope` 控制状态机
- **打开方式**：标题栏 `ai-chat-drawer-toggle` / 全局快捷键 `Ctrl+L` 打开 global drawer；终端浮动工具条上的 `tab-chat-toggle` / `Ctrl+Shift+L` 打开 tab-bound drawer（绑定当前终端，自动注入终端上下文）
- **抽屉头部**：复制全部对话 / 新建全局对话 / 新对话 / 历史对话 / 关闭 五个按钮（标题文案随当前 locale 切换 — 默认英文 `New chat / History / Close`，中文为 `新对话 / 历史对话 / 关闭`）
- **Thread badge 区**：显示 thread 是绑定到具体终端 (`Link2` 图标 + 终端标题) 还是 Global；Provider 选择器在配置了多 provider 时显示；output format 选择器在 thread 仍空时可改、有消息后锁定
- **Composer**：`Ctrl+Enter` 发送、`@terminal:last-N` / `@file:./X` / `@session:Q` 解析为 `attachment-chip`（文件/会话目前仅展示，不发送内容）
- **Format cycling**：右上角按钮按 `md → html → plain` 循环显示格式
- 历史对话面板可删除 thread；删除当前 thread 时自动落到下一个或新建
- 抽屉宽度可拖拽调整且持久化

### 14.5 Web Search Provider 矩阵 ✅

<!-- feature
id: F-AI-2.5
status: done
area: ai/search
components: [WebSearchPanel, SearchProgressChip]
files:
  - src/components/settings/WebSearchPanel.tsx
  - src/components/chat/SearchProgressChip.tsx
controls:
  - id: web-search-section
    selector: 'text="Web Search"'
    kind: display
  - id: web-search-confirm-per-call
    selector: 'text="Confirm every time (default)"'
    kind: display
  - id: web-search-confirm-per-thread
    selector: 'text="Confirm once per thread"'
    kind: display
  - id: web-search-confirm-always
    selector: 'text="Always allow"'
    kind: display
  - id: web-search-confirm-disabled
    selector: 'text="Disabled"'
    kind: display
-->

- 设置面板列出至少 6 个搜索 provider：SearXNG / Tavily / Serper / Brave Search / Exa / Google CSE
- 每次调用前的确认模式四选一：每次确认 / 本 thread 静默 / 总是允许 / 完全禁用
- `SearchProgressChip` 在 Chat 中实时显示搜索进度并可取消

### 14.6 Claude Code & 模型分发设置 ✅

<!-- feature
id: F-AI-2.6
status: done
area: ai/models
components: [ClaudeCodePanel, ModelsAdvancedPanel, ChatHistoryPanel, ChatOutputFormatPanel]
files:
  - src/components/settings/ClaudeCodePanel.tsx
  - src/components/settings/ModelsAdvancedPanel.tsx
  - src/components/settings/ChatHistoryPanel.tsx
  - src/components/settings/ChatOutputFormatPanel.tsx
controls:
  - id: ai-settings-section
    selector: 'text="AI Settings"'
    kind: display
  - id: models-mirror-section
    selector: 'text="Model distribution & GPU acceleration"'
    kind: display
  - id: models-mirror-modelscope
    selector: 'text="ModelScope first"'
    kind: display
  - id: models-mirror-github
    selector: 'text="GitHub direct"'
    kind: display
  - id: models-mirror-ghproxy
    selector: 'text="gh-proxy"'
    kind: display
  - id: models-mirror-custom
    selector: 'text="Custom base URL"'
    kind: display
  - id: chat-history-section
    selector: 'text="Chat history management"'
    kind: display
  - id: chat-history-retention
    selector: 'input[aria-label="Chat history retention days"]'
    kind: interactive
  - id: chat-history-retention-label
    selector: 'text="Retention (days)"'
    kind: display
-->

- 模型分发镜像四选一：ModelScope 优先 / GitHub 直连 / gh-proxy 代理 / 自定义 base URL
- Claude Code 集成面板（账号、CLI 入口、会话引用）
- 对话历史保留天数滑动 + 一键清理（位于 `ChatHistoryPanel`）
- Thread 默认输出格式（`ChatOutputFormatPanel`）

### 14.7 LLM Provider 列表 ✅

<!-- feature
id: F-AI-11
status: done
area: ai/providers
components: [LlmProvidersPanel]
files:
  - src/components/settings/LlmProvidersPanel.tsx
controls: []   # SettingsPanel-level concern; the provider editor renders inline rows without dedicated testids — covered indirectly via TC-AI-004's "AI 设置" section assertions
-->

- LLM provider 列表（OpenAI / Anthropic / 自定义 base URL 等）
- API key 写入 vault；vault 锁定时整段会话保留但显示锁图标，提示用户先解锁
- 与 `aiStore.providers` 双向同步

---

## 15. 终端分屏

### 15.1 Terminal Split View ✅

<!-- feature
id: F-Split-1
status: done
area: terminal/split
components: [MainLayout, TerminalSplitToolbar]
files:
  - src/layouts/MainLayout.tsx
  - src/stores/appStore.ts
controls:
  - id: split-stage
    selector: '[data-testid="terminal-split-stage"]'
    kind: display
    optional: true       # rendered only when split active
  - id: split-toolbar
    selector: '[data-testid="terminal-split-toolbar"]'
    kind: display
    optional: true
  - id: split-panes
    selector: '[data-testid="terminal-split-panes"]'
    kind: display
    optional: true
  - id: split-pane
    selector: '[data-testid="terminal-split-pane"]'
    kind: display
    optional: true
  - id: split-resize-handle
    selector: '[data-testid="terminal-split-resize-handle"]'
    kind: interactive
    optional: true       # only in horizontal/vertical layouts
  - id: split-grid-column-resize-handle
    selector: '[data-testid="terminal-split-grid-column-resize-handle"]'
    kind: interactive
    optional: true       # only in grid layout
  - id: split-grid-row-resize-handle
    selector: '[data-testid="terminal-split-grid-row-resize-handle"]'
    kind: interactive
    optional: true
  - id: split-layout-horizontal
    selector: '[data-testid="terminal-split-layout-horizontal"]'
    kind: interactive
    optional: true
  - id: split-layout-vertical
    selector: '[data-testid="terminal-split-layout-vertical"]'
    kind: interactive
    optional: true
  - id: split-layout-grid
    selector: '[data-testid="terminal-split-layout-grid"]'
    kind: interactive
    optional: true
  - id: split-input-lock
    selector: '[data-testid^="terminal-split-lock-"]'
    kind: interactive
    optional: true
  - id: terminal-input-locked
    selector: '[data-testid="terminal-input-locked"]'
    kind: display
    optional: true       # rendered when a pane is input-locked
-->

- 标题栏 `tab-split-view` 切换分屏；激活后所有打开的本地/SSH 终端 tab 同时挂载到 `terminal-split-stage`
- 三种布局：horizontal / vertical / grid，分别由 `data-layout` 属性标识
- 拖拽中分割条（`terminal-split-resize-handle` 或 grid 模式下的列/行 handle）调整面板尺寸
- 每个 pane 上的 `terminal-split-lock-<id>` 按钮可单独锁定该 pane 输入
- 与 MultiExec 协同：选 "All" 时计数文案为 `<active>/<total>`

---

## 16. 通用对话框

### 16.1 In-app `ConfirmDialog` ✅

<!-- feature
id: F-Confirm-1
status: done
area: ui/dialog
components: [ConfirmDialog]
files:
  - src/components/sidebar/ConfirmDialog.tsx
controls:
  - id: confirm-dialog
    selector: '[data-testid="confirm-dialog"]'
    kind: display
    optional: true
  - id: confirm-dialog-message
    selector: '[data-testid="confirm-dialog-message"]'
    kind: display
    optional: true
  - id: confirm-dialog-cancel
    selector: '[data-testid="confirm-dialog-cancel"]'
    kind: interactive
    optional: true
  - id: confirm-dialog-confirm
    selector: '[data-testid="confirm-dialog-confirm"]'
    kind: interactive
    optional: true
-->

- 取代 `window.confirm` 的跨平台 React 模态（macOS WKWebView 默认禁用 `window.confirm`/`alert`）
- 支持 `danger` 标志、自定义 confirm/cancel 文案、Esc 取消、Enter 确认
- 当前在 SessionTree 删除文件夹流程中替换原生 confirm

### 16.2 Session Import 预览 ✅

<!-- feature
id: F-ImportPreview-1
status: done
area: sessions/import
components: [SessionImportPreview]
files:
  - src/components/session/SessionImportPreview.tsx
  - src/components/sidebar/SessionTree.tsx
  - src/components/menubar/MenuBar.tsx
controls:
  - id: preview-dialog
    selector: '[data-testid="session-import-preview"]'
    kind: display
    optional: true       # only after triggering an import flow
  - id: preview-summary
    selector: '[data-testid="session-import-preview-summary"]'
    kind: display
    optional: true
  - id: preview-warnings
    selector: '[data-testid="session-import-preview-warnings"]'
    kind: display
    optional: true       # only when result.warnings.length > 0
  - id: preview-table
    selector: '[data-testid="session-import-preview-table"]'
    kind: display
    optional: true
  - id: preview-select-all
    selector: '[data-testid="session-import-preview-select-all"]'
    kind: interactive
    optional: true
  - id: preview-cancel
    selector: '[data-testid="session-import-preview-cancel"]'
    kind: interactive
    optional: true
  - id: preview-confirm
    selector: '[data-testid="session-import-preview-confirm"]'
    kind: interactive
    optional: true
  # Menu-bar leaf items that trigger the preview (under Sessions →
  # Import / Export submenus). Each calls openTextFile/openBinaryFile,
  # which means the preview dialog only renders after a real file picker
  # selects a fixture — but the menu route itself is observable.
  - id: import-json
    selector: '[data-testid="import-json"]'
    kind: interactive
    optional: true
  - id: import-mobaxterm
    selector: '[data-testid="import-mobaxterm"]'
    kind: interactive
    optional: true
  - id: import-csv
    selector: '[data-testid="import-csv"]'
    kind: interactive
    optional: true
  - id: import-openssh
    selector: '[data-testid="import-openssh"]'
    kind: interactive
    optional: true
  - id: export-json
    selector: '[data-testid="export-json"]'
    kind: interactive
    optional: true
  - id: export-mobaxterm
    selector: '[data-testid="export-mobaxterm"]'
    kind: interactive
    optional: true
  - id: export-csv
    selector: '[data-testid="export-csv"]'
    kind: interactive
    optional: true
  - id: export-html
    selector: '[data-testid="export-html"]'
    kind: interactive
    optional: true
-->

- 第三方会话 / NewMob JSON / MobaXterm / CSV / OpenSSH / Tabby / Xshell / WindTerm / iTerm2 / Terminal.app / Termius / PuTTYCM / SuperPuTTY / mRemote / Exceed / SecureCRT / RDM / WSL / PuTTY / External Bash 等导入入口共用的预览对话框
- 支持每行勾选 + 全选 / 反选；前 80 条出现在表格预览中，剩余仍按选择应用
- Cancel 走遮罩点击 / Esc / Cancel 按钮；Confirm 在没有选中行时禁用
- 摘要区列出待写入 vault 的密码数与 standalone secret 数

### 16.3 第三方 Vault 解锁对话框 ✅

<!-- feature
id: F-ExternalVault-1
status: done
area: sessions/import
components: [ExternalVaultUnlockDialog]
files:
  - src/components/session/ExternalVaultUnlockDialog.tsx
  - src/components/sidebar/SessionTree.tsx
controls:
  - id: dialog
    selector: '[data-testid="external-vault-unlock-dialog"]'
    kind: display
    optional: true       # only when importing a tool that has an encrypted vault (e.g. Tabby)
  - id: description
    selector: '[data-testid="external-vault-unlock-description"]'
    kind: display
    optional: true
  - id: pw-input
    selector: '[data-testid="external-vault-unlock-pw"]'
    kind: interactive
    optional: true
  - id: error
    selector: '[data-testid="external-vault-unlock-error"]'
    kind: display
    optional: true       # only after wrong password / decryption error
  - id: skip
    selector: '[data-testid="external-vault-unlock-skip"]'
    kind: interactive
    optional: true
  - id: confirm
    selector: '[data-testid="external-vault-unlock-confirm"]'
    kind: interactive
    optional: true
-->

- 通用 prop 驱动的第三方主密码输入框（与 NewMob 自身的 `VaultUnlockDialog` 区分，避免误导）
- 用于 Tabby vault 解密：错误密码后保留对话框并显示内联错误（`tabby_vault_bad_password` → "Incorrect Tabby master password (attempt N)"）
- 「Skip」按钮跳过 vault 解密但仍继续走 OS keychain 回退

### 16.4 Folder Name 对话框 ✅

<!-- feature
id: F-FolderName-1
status: done
area: sessions/folder
components: [FolderNameDialog, SessionTree]
files:
  - src/components/sidebar/FolderNameDialog.tsx
  - src/components/sidebar/SessionTree.tsx
controls:
  - id: dialog
    selector: '[data-testid="folder-name-dialog"]'
    kind: display
    optional: true
  - id: parent-readout
    selector: '[data-testid="folder-name-dialog-parent"]'
    kind: display
    optional: true
  - id: input
    selector: '[data-testid="folder-name-dialog-input"]'
    kind: interactive
    optional: true
  - id: cancel
    selector: '[data-testid="folder-name-dialog-cancel"]'
    kind: interactive
    optional: true
  - id: confirm
    selector: '[data-testid="folder-name-dialog-confirm"]'
    kind: interactive
    optional: true
-->

- 替代 `window.prompt` 的文件夹命名 React 模态，新建 / 重命名共用
- 父路径只读显示在顶部
- 空名 / 非法字符（"/"、控制字符）禁用 Confirm

---

## 17. 会话侧边栏与多选

### 17.1 多选会话连接 ✅

<!-- feature
id: F-Sidebar-1
status: done
area: sessions/multiselect
components: [SessionTree, Sidebar, MainLayout]
files:
  - src/components/sidebar/SessionTree.tsx
  - src/components/sidebar/Sidebar.tsx
  - src/layouts/MainLayout.tsx
controls: []   # selection state is exposed via [data-selected] / [aria-selected] on existing session-tree-item rows; no new dedicated testids
-->

- 在 SessionTree 中按住 Ctrl / Meta 单击会话条目可累加选中
- 选中状态通过 `data-selected` / `aria-selected` 属性暴露
- 右键菜单首项变成 `Connect selected sessions (N)`，一次性把所有选中会话作为新 tab 打开
- 普通点击仍然回到单选语义

---

## 18. 上下文菜单容错

### 18.1 子菜单视口翻转 ✅

<!-- feature
id: F-Submenu-1
status: done
area: ui/menu
components: [ContextMenu]
files:
  - src/components/ContextMenu.tsx
controls: []   # no dedicated testid: the submenu container itself uses class-based positioning, not a testid. behavior-only feature kept here to document the fix.
-->

- 二级 / 三级 子菜单出现时，若按默认 `left-full` 渲染会超出视口右边缘，则通过 `getBoundingClientRect` 切换到 `right-full` 向左展开
- macOS WKWebView 上原本被裁掉的子菜单恢复可见
- 没有 testid，行为通过现有右键菜单链路（如会话树 Import / Export 子菜单）覆盖

---

## 19. 双语 UI

### 19.1 语言切换 (i18n) ✅

<!-- feature
id: F-I18n-1
status: done
area: ui/i18n
components: [LanguageSwitcher, LanguageSection, useT, useLocale]
files:
  - src/components/window/LanguageSwitcher.tsx
  - src/components/settings/LanguageSection.tsx
  - src/lib/i18n/index.ts
  - src/lib/i18n/labels.ts
  - src/lib/i18n/locales/en.ts
  - src/lib/i18n/locales/zh-CN.ts
controls:
  - id: tray-switcher
    selector: '[data-testid="language-switcher"]'
    kind: interactive
  - id: language-option-en
    selector: '[data-testid="language-option-en"]'
    kind: interactive
    optional: true       # only after the tray button opens its menu
  - id: language-option-zh
    selector: '[data-testid="language-option-zh-CN"]'
    kind: interactive
    optional: true
  - id: settings-section
    selector: '[data-testid="settings-language-section"]'
    kind: display
  - id: settings-language-en
    selector: '[data-testid="settings-language-en"]'
    kind: interactive
  - id: settings-language-zh
    selector: '[data-testid="settings-language-zh-CN"]'
    kind: interactive
-->

- 标题栏 `LanguageSwitcher`（地球图标 + EN / 中 缩写）打开 locale 选择上下文菜单
- 设置面板 `LanguageSection` 提供同样的切换入口（适合不熟悉托盘的用户）
- locale 持久化到 `localStorage` (`newmob.locale.v1`)；默认 `en`，已保存的偏好最优先
- 切换时 `document.documentElement.lang` 同步更新
- 字典覆盖范围：menu / ribbon / quick connect / session editor / settings / capture / SFTP toolbar / chat drawer / agent / file browser / tunnel manager / vault / about dialog 等所有用户可见入口
- 未翻译键自动回落到英文，缺失键直接显示 key 路径（便于发现缺漏）

---

## 附：占位但未实装的入口

> 下述入口已经在 UI 中可见但点击会显示 "not active in this phase" 占位面板，对应能力**尚未实装**，本清单不视为完成项，仅在此说明以解释 UI 为何存在：
>
> - Ribbon `Tools`（除 Tunneling 之外的网络工具）
> - Ribbon `Packages`、`Macros`
> - QuickConnect 的 VNC URL 入口（已保存 VNC 会话可连接，QuickConnect 尚未接入 VNC client）
> - SFTP 底部的 "Cross-host transfer (remote ↔ remote)" 按钮（disabled 占位）
