# Taomni - 跨平台远程连接管理工具

> 为开发者打造的 AI 原生一体化远程工作台，支持 Linux / macOS / Windows

---

## 1. 项目定位

Taomni 是一个面向运维和开发人员的跨平台桌面应用，提供：
- 多协议远程连接（SSH、Telnet、RDP、VNC、FTP/SFTP、Serial）
- 内置终端模拟器（本地 Shell + 远程 Shell）
- 会话管理与凭证安全存储
- 图形化 SFTP 文件浏览器
- 多会话并行操作（Multi-Exec）
- 端口转发与隧道管理
- 内置网络工具集
- X11 转发支持

---

## 2. 技术架构选型

### 2.1 UI 框架推荐：Tauri 2.x + React + TypeScript

**为什么选 Tauri 而非纯 Rust GUI 框架：**

| 维度 | Tauri + React | Iced / Slint / egui |
|------|--------------|---------------------|
| AI Agent 友好度 | ★★★★★ (AI 擅长 React/TS) | ★★☆ (文档少，AI 容易出错) |
| 终端模拟 | xterm.js (生产级) | 需从零实现或绑定 |
| 组件生态 | 海量 npm 组件 | 极少 |
| 跨平台成熟度 | 生产就绪 | 部分实验性 |
| 性能 | 系统 WebView，内存占用低 | 原生渲染，略优 |
| 二进制体积 | ~10MB | ~5MB |
| 社区与文档 | 极丰富 | 有限 |

**核心理由：**
1. xterm.js 是业界最成熟的终端模拟组件（VS Code、Hyper 都在用）
2. AI coding agent 对 React/TypeScript 的代码生成质量远高于 Rust GUI DSL
3. Tauri 2.x 已生产就绪，支持多窗口、系统托盘、自动更新
4. Rust 后端处理所有重计算（SSH、PTY、网络），前端只负责展示

**备选方案（如果坚持纯 Rust）：**
- Dioxus：React-like 语法，底层也用 WebView，但生态不如直接用 React
- Slint：声明式 UI，适合嵌入式，桌面复杂 UI 支持有限

### 2.2 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React + TS)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ xterm.js │ │ File     │ │ Session  │ │ Network   │  │
│  │ Terminal │ │ Browser  │ │ Manager  │ │ Tools UI  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └─────┬─────┘  │
│       │             │            │              │         │
│  ─────┴─────────────┴────────────┴──────────────┴─────── │
│                  Tauri IPC (Commands + Events)            │
└─────────────────────────────┬───────────────────────────┘
                              │
┌─────────────────────────────┴───────────────────────────┐
│                   Backend (Rust)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ PTY      │ │ SSH/SFTP │ │ Session  │ │ Network   │  │
│  │ Manager  │ │ Client   │ │ Store    │ │ Tools     │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────┐  │
│  │ Tunnel   │ │ Keyring  │ │ RDP/VNC  │ │ Serial    │  │
│  │ Manager  │ │ (凭证)   │ │ Proxy    │ │ Port      │  │
│  └──────────┘ └──────────┘ └──────────┘ └───────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 2.3 核心 Rust Crate 依赖

```toml
[dependencies]
# 框架
tauri = { version = "2", features = ["tray-icon", "dialog", "shell"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# SSH/SFTP
russh = "0.46"              # 纯 Rust 异步 SSH 实现 (Eugeny/russh)
russh-keys = "0.46"         # SSH 密钥管理
russh-sftp = "2"            # SFTP 协议支持

# 终端/PTY
portable-pty = "0.8"        # 跨平台 PTY (Linux/macOS/Windows ConPTY)

# 存储
rusqlite = { version = "0.31", features = ["bundled"] }  # 会话存储
keyring = "3"               # OS 原生凭证存储

# 网络工具
surge-ping = "0.8"          # ICMP ping
dns-lookup = "2"            # DNS 解析
tokio-serial = "5"          # 串口通信

# 序列化/配置
toml = "0.8"                # 配置文件
uuid = { version = "1", features = ["v4"] }

# 日志
tracing = "0.1"
tracing-subscriber = "0.3"
```

### 2.4 前端依赖

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2.0",
    "react": "^18",
    "react-dom": "^18",
    "@xterm/xterm": "^5.5",
    "@xterm/addon-fit": "^0.10",
    "@xterm/addon-webgl": "^0.18",
    "@xterm/addon-search": "^0.15",
    "@xterm/addon-web-links": "^0.11",
    "zustand": "^4",
    "react-resizable-panels": "^2",
    "lucide-react": "^0.400",
    "tailwindcss": "^3"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^5",
    "@vitejs/plugin-react": "^4"
  }
}
```

---

## 3. 模块详细设计

### 3.1 模块 A：终端模拟器 (Terminal Emulator)

**职责：** 本地 Shell 和远程 SSH Shell 的终端交互

**前端组件：**

```
src/components/terminal/
├── TerminalPanel.tsx        # 单个终端实例，封装 xterm.js
├── TerminalTabs.tsx         # 多标签页管理
├── TerminalSplitView.tsx    # 分屏视图（水平/垂直拆分）
└── TerminalToolbar.tsx      # 终端工具栏（字体、搜索、全屏）
```

**TerminalPanel 核心逻辑：**

```tsx
// TerminalPanel.tsx 关键实现思路
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// 1. 创建 xterm 实例并挂载 addon
// 2. 调用 Tauri command 创建 PTY/SSH 连接，获得 session_id
// 3. 监听 Tauri event `terminal-output-{session_id}` 写入 xterm
// 4. xterm.onData 回调中调用 Tauri command 发送输入到 PTY/SSH
// 5. 窗口 resize 时调用 Tauri command 通知后端调整 PTY 尺寸
```

**Rust 后端 Tauri Commands：**

```rust
// src-tauri/src/terminal/mod.rs

/// 创建本地终端会话
#[tauri::command]
async fn create_local_terminal(
    cols: u16,
    rows: u16,
    shell: Option<String>,       // 可选指定 shell 路径
    cwd: Option<String>,         // 工作目录
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 返回 session_id
    // 使用 portable-pty 创建 PTY
    // 启动异步读取循环，通过 app_handle.emit() 发送 terminal-output 事件
}

/// 创建 SSH 终端会话
#[tauri::command]
async fn create_ssh_terminal(
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,            // Password / PrivateKey / Agent
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 返回 session_id
    // 使用 russh 建立 SSH 连接
    // 请求 PTY channel
    // 启动异步读取循环
}

/// 向终端写入数据
#[tauri::command]
async fn write_terminal(
    session_id: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {}

/// 调整终端尺寸
#[tauri::command]
async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {}

/// 关闭终端会话
#[tauri::command]
async fn close_terminal(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {}
```

**数据流：**

```
用户键盘输入
    → xterm.onData(data)
    → invoke("write_terminal", { session_id, data })
    → Rust: PTY.write(data) 或 SSH_Channel.write(data)
    → PTY/SSH 输出
    → Rust: app_handle.emit("terminal-output-{id}", output_bytes)
    → 前端 listen("terminal-output-{id}")
    → xterm.write(output_bytes)
```

**关键实现细节：**
- 数据传输使用 `Vec<u8>` 而非 String，支持二进制和非 UTF-8 内容
- PTY 读取循环使用 tokio::spawn，每次读取 4KB buffer
- SSH channel 数据通过 russh 的 async stream 读取
- resize 事件需要 debounce（前端 150ms），避免频繁 IPC

---

### 3.2 模块 B：会话管理器 (Session Manager)

**职责：** 连接配置的 CRUD、分组、快速连接、凭证管理

**数据模型：**

```rust
// src-tauri/src/session/models.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    pub id: String,                    // UUID
    pub name: String,                  // 显示名称
    pub session_type: SessionType,     // SSH, Telnet, RDP, VNC, FTP, SFTP, Serial
    pub group: Option<String>,         // 分组/文件夹
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub auth_method: AuthMethod,
    pub options: SessionOptions,       // 协议特定选项
    pub created_at: i64,
    pub updated_at: i64,
    pub last_connected_at: Option<i64>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SessionType {
    SSH, Telnet, RDP, VNC, FTP, SFTP, Serial, LocalShell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthMethod {
    Password,                          // 密码存储在 OS keyring
    PrivateKey { key_path: String },   // 私钥文件路径
    Agent,                             // SSH Agent 转发
    None,                              // Telnet 等无认证协议
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionOptions {
    pub ssh: Option<SshOptions>,
    pub rdp: Option<RdpOptions>,
    pub serial: Option<SerialOptions>,
    pub terminal: TerminalOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshOptions {
    pub x11_forwarding: bool,
    pub agent_forwarding: bool,
    pub compression: bool,
    pub keepalive_interval: u32,       // 秒
    pub port_forwards: Vec<PortForward>,
    pub startup_command: Option<String>,
    pub jump_host: Option<String>,     // ProxyJump
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOptions {
    pub font_family: String,
    pub font_size: u16,
    pub color_scheme: String,          // 主题名称
    pub scrollback_lines: u32,
    pub cursor_style: CursorStyle,
}
```

**SQLite Schema：**

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_type TEXT NOT NULL,
    group_path TEXT,
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT,
    auth_method TEXT NOT NULL DEFAULT 'Password',
    options_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_connected_at INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE session_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    icon TEXT,
    FOREIGN KEY (parent_id) REFERENCES session_groups(id)
);

CREATE INDEX idx_sessions_group ON sessions(group_path);
CREATE INDEX idx_sessions_type ON sessions(session_type);
```

**Tauri Commands：**

```rust
#[tauri::command]
async fn list_sessions(group: Option<String>) -> Result<Vec<SessionConfig>, String> {}

#[tauri::command]
async fn get_session(id: String) -> Result<SessionConfig, String> {}

#[tauri::command]
async fn save_session(config: SessionConfig) -> Result<(), String> {}

#[tauri::command]
async fn delete_session(id: String) -> Result<(), String> {}

#[tauri::command]
async fn import_sessions(format: ImportFormat, data: String) -> Result<u32, String> {}
// 支持从 MobaXterm / PuTTY / SSH config 导入

#[tauri::command]
async fn export_sessions(format: ExportFormat) -> Result<String, String> {}
```

**前端组件：**

```
src/components/session/
├── SessionSidebar.tsx       # 左侧会话树（分组 + 列表）
├── SessionEditor.tsx        # 会话配置编辑表单
├── SessionQuickConnect.tsx  # 快速连接栏（地址栏式）
├── SessionImport.tsx        # 导入向导
└── SessionGroup.tsx         # 分组管理
```

---

### 3.3 模块 C：SFTP 文件浏览器 (File Browser)

**职责：** 双面板文件管理器，左侧本地文件系统，右侧远程 SFTP

**前端组件：**

```
src/components/filebrowser/
├── FileBrowser.tsx           # 双面板容器
├── FilePanel.tsx             # 单面板（本地或远程）
├── FileList.tsx              # 文件列表（表格视图）
├── FileToolbar.tsx           # 操作栏（上传、下载、新建、删除）
├── FileTransferQueue.tsx     # 传输队列与进度
├── PathBreadcrumb.tsx        # 路径导航面包屑
└── FileContextMenu.tsx       # 右键菜单
```

**Tauri Commands：**

```rust
// src-tauri/src/filebrowser/mod.rs

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,          // Unix timestamp
    pub permissions: String,    // "rwxr-xr-x" 格式
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub filename: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub speed_bps: u64,         // bytes per second
    pub status: TransferStatus, // Pending, Active, Completed, Failed, Cancelled
}

/// 列出本地目录
#[tauri::command]
async fn list_local_dir(path: String) -> Result<Vec<FileEntry>, String> {}

/// 列出远程 SFTP 目录
#[tauri::command]
async fn list_remote_dir(
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {}

/// 上传文件（本地 → 远程）
#[tauri::command]
async fn upload_files(
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<String, String> {
    // 返回 transfer_id
    // 通过 event 推送进度: "transfer-progress-{transfer_id}"
}

/// 下载文件（远程 → 本地）
#[tauri::command]
async fn download_files(
    session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
) -> Result<String, String> {}

/// 远程文件操作
#[tauri::command]
async fn remote_mkdir(session_id: String, path: String) -> Result<(), String> {}

#[tauri::command]
async fn remote_delete(session_id: String, paths: Vec<String>) -> Result<(), String> {}

#[tauri::command]
async fn remote_rename(
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {}

/// 取消传输
#[tauri::command]
async fn cancel_transfer(transfer_id: String) -> Result<(), String> {}
```

**关键实现细节：**
- SFTP 连接复用 SSH 会话的底层连接（russh 支持多 channel）
- 大文件传输使用流式读写，每 64KB 报告一次进度
- 支持拖拽上传/下载（Tauri drag-and-drop API）
- 文件列表支持排序（名称、大小、修改时间）和过滤

---

### 3.4 模块 D：端口转发与隧道 (Tunnel Manager)

**职责：** SSH 端口转发（Local/Remote/Dynamic SOCKS）管理

**数据模型：**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub id: String,
    pub forward_type: ForwardType,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub ssh_session_id: String,     // 关联的 SSH 会话
    pub auto_start: bool,           // 随会话自动启动
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ForwardType {
    Local,       // -L: local_port → remote_host:remote_port
    Remote,      // -R: remote_port → local_host:local_port
    Dynamic,     // -D: SOCKS5 代理
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub id: String,
    pub state: TunnelState,  // Active, Stopped, Error
    pub bytes_transferred: u64,
    pub connections_count: u32,
    pub error_message: Option<String>,
}
```

**Tauri Commands：**

```rust
#[tauri::command]
async fn create_tunnel(config: PortForward) -> Result<String, String> {}

#[tauri::command]
async fn stop_tunnel(tunnel_id: String) -> Result<(), String> {}

#[tauri::command]
async fn list_tunnels() -> Result<Vec<TunnelStatus>, String> {}
```

---

### 3.5 模块 E：多会话执行 (Multi-Exec)

**职责：** 同时向多个终端发送相同命令

**前端组件：**

```
src/components/multiexec/
├── MultiExecPanel.tsx        # 多执行面板
├── MultiExecInput.tsx        # 命令输入框
└── MultiExecTargetList.tsx   # 目标会话选择列表
```

**Tauri Commands：**

```rust
/// 向多个终端同时发送命令
#[tauri::command]
async fn multi_exec(
    session_ids: Vec<String>,
    command: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 遍历所有 session_id，调用 write_terminal
    // 自动追加 \n
}

/// 切换 Multi-Exec 模式（实时同步输入）
#[tauri::command]
async fn toggle_multi_exec_sync(
    session_ids: Vec<String>,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {}
```

---

### 3.6 模块 F：网络工具集 (Network Tools)

**职责：** 内置常用网络诊断工具

**工具列表：**

```rust
// src-tauri/src/nettools/mod.rs

/// Ping
#[tauri::command]
async fn ping(
    host: String,
    count: u32,
    timeout_ms: u32,
    app_handle: AppHandle,
) -> Result<(), String> {
    // 每次 ping 结果通过 event 推送: "ping-result"
    // { seq, host, ttl, time_ms, status }
}

/// 端口扫描
#[tauri::command]
async fn port_scan(
    host: String,
    ports: Vec<u16>,          // 或 "1-1024" 范围
    timeout_ms: u32,
    concurrency: u16,         // 并发数
    app_handle: AppHandle,
) -> Result<(), String> {
    // 通过 event 推送每个端口结果: "port-scan-result"
}

/// DNS 查询
#[tauri::command]
async fn dns_lookup(
    hostname: String,
    record_type: String,      // A, AAAA, MX, CNAME, TXT
) -> Result<Vec<String>, String> {}

/// 网络接口信息
#[tauri::command]
async fn get_network_interfaces() -> Result<Vec<NetworkInterface>, String> {}

/// Wake-on-LAN
#[tauri::command]
async fn wake_on_lan(mac_address: String) -> Result<(), String> {}
```

**前端组件：**

```
src/components/nettools/
├── NetworkToolsPanel.tsx     # 工具集面板
├── PingTool.tsx              # Ping 工具
├── PortScanTool.tsx          # 端口扫描
├── DnsLookupTool.tsx         # DNS 查询
└── NetworkInfoTool.tsx       # 网络接口信息
```

---

### 3.7 模块 G：RDP/VNC 客户端 (Remote Desktop)

**职责：** 远程桌面连接（RDP 和 VNC 协议）

**实现策略：**

RDP 和 VNC 的完整协议实现极其复杂，推荐以下务实方案：

```rust
// 方案 1（推荐）：调用系统原生客户端
// Linux: xfreerdp / remmina (RDP), vncviewer / tigervnc (VNC)
// macOS: Microsoft Remote Desktop (RDP), Screen Sharing (VNC)
// Windows: mstsc.exe (RDP), 内置 VNC viewer

#[tauri::command]
async fn launch_rdp(
    host: String,
    port: u16,
    username: Option<String>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    // 生成 .rdp 文件或直接调用系统命令
    // Linux: xfreerdp /v:{host}:{port} /u:{username} /size:{w}x{h}
    // macOS: open rdp://...
    // Windows: mstsc.exe /v:{host}:{port}
}

// 方案 2（进阶）：嵌入式 Web VNC
// 使用 noVNC (HTML5 VNC client) 嵌入 Tauri WebView
// 后端运行 WebSocket → VNC 代理
```

**前端组件：**

```
src/components/remote_desktop/
├── RdpLauncher.tsx           # RDP 连接配置与启动
├── VncViewer.tsx             # VNC 查看器（noVNC 嵌入）
└── RemoteDesktopTab.tsx      # 远程桌面标签页
```

---

### 3.8 模块 H：串口终端 (Serial Terminal)

**职责：** 串口设备连接与通信

**Tauri Commands：**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port_name: String,       // /dev/ttyUSB0, COM3
    pub baud_rate: u32,          // 9600, 115200, etc.
    pub data_bits: u8,           // 5, 6, 7, 8
    pub stop_bits: u8,           // 1, 2
    pub parity: String,          // None, Odd, Even
    pub flow_control: String,    // None, Hardware, Software
}

/// 列出可用串口
#[tauri::command]
async fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {}

/// 打开串口连接
#[tauri::command]
async fn open_serial(config: SerialConfig) -> Result<String, String> {
    // 返回 session_id
    // 数据流复用终端模块的 event 机制
}
```

---

## 4. 全局状态管理

### 4.1 Rust 后端状态 (AppState)

```rust
// src-tauri/src/state.rs

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct AppState {
    /// 活跃终端会话 (session_id → TerminalSession)
    pub terminals: Arc<RwLock<HashMap<String, TerminalSession>>>,
    /// 活跃隧道 (tunnel_id → TunnelHandle)
    pub tunnels: Arc<RwLock<HashMap<String, TunnelHandle>>>,
    /// 活跃传输任务 (transfer_id → TransferHandle)
    pub transfers: Arc<RwLock<HashMap<String, TransferHandle>>>,
    /// 数据库连接
    pub db: Arc<rusqlite::Connection>,
    /// 应用配置
    pub config: Arc<RwLock<AppConfig>>,
}

pub enum TerminalSession {
    Local {
        pty_pair: portable_pty::PtyPair,
        child: Box<dyn portable_pty::Child + Send>,
    },
    Ssh {
        handle: russh::client::Handle<SshHandler>,
        channel: russh::Channel<russh::client::Msg>,
    },
    Serial {
        port: tokio_serial::SerialStream,
    },
}
```

### 4.2 前端状态 (Zustand Store)

```typescript
// src/stores/appStore.ts

interface AppState {
  // 标签页管理
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string) => void;

  // 会话列表（从后端同步）
  sessions: SessionConfig[];
  loadSessions: () => Promise<void>;

  // 活跃连接状态
  connections: Map<string, ConnectionStatus>;

  // 传输队列
  transfers: TransferProgress[];

  // 隧道状态
  tunnels: TunnelStatus[];

  // UI 状态
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  theme: 'light' | 'dark' | 'system';
}

interface Tab {
  id: string;
  type: 'terminal' | 'sftp' | 'rdp' | 'vnc' | 'nettools';
  title: string;
  sessionId?: string;       // 关联的会话配置 ID
  connectionId?: string;    // 活跃连接 ID
  closable: boolean;
}
```

---

## 5. UI 原型参考与布局规范

### 5.0 已有 UI 原型（必读）

在 `/data/code-src/person/mob-design/artifacts/mockup-sandbox/` 目录下已有完整的 UI 原型设计，
AI agent 在实现前端组件时必须参考这些原型，确保视觉风格和交互模式一致。

**原型文件清单：**

| 文件 | 覆盖场景 | 关键 UI 元素 |
|------|---------|-------------|
| `mobaxterm/MainWindow.tsx` | 主窗口整体布局 | 标题栏、菜单栏、Ribbon 工具栏、快速连接栏、左侧会话树（含 SFTP 侧边栏）、标签页、欢迎页、右侧活跃连接面板、状态栏 |
| `mobaxterm/LocalTerminal.tsx` | 本地终端视图 | 终端输出区（含 banner、prompt 样式）、左侧本地文件浏览器、右侧终端 HUD（Shell 信息、历史命令、宏快捷键）、底部命令输入栏 |
| `mobaxterm/SessionDialog.tsx` | 会话配置对话框 | 14 种协议选择器、SSH 基础设置表单、高级 SSH 设置（X11/压缩/认证/跳板机）、终端设置（字体/颜色/主题预览）、网络设置（代理/端口转发）、书签设置 |
| `mobaxterm/SftpTransfer.tsx` | SFTP 双面板文件传输 | 本地/远程双面板文件列表、中间传输箭头、传输队列（进度条/速度/状态）、右侧文件详情和连接信息面板、拖拽提示 |
| `mobaxterm/SplitMultiExec.tsx` | 分屏 + 多执行 | 4 种布局模式（单屏/2 水平/2 垂直/4 宫格）、MultiExec 广播控制栏、每个 pane 的独立头部和状态、底部多执行命令输入栏、左侧主机分组侧边栏 |
| `mobaxterm/_group.css` | 全局主题变量 | CSS 变量定义（颜色、字体、间距）、组件样式（ribbon-btn、tab、tree-row、input、btn、pill、checkbox 等） |

**主题设计系统（从 `_group.css` 提取）：**

```css
/* 核心颜色变量 — 实现时必须遵循 */
--taomni-chrome-bg: #f0f0f0;          /* 窗口背景 */
--taomni-accent: #2b5d8b;             /* 主色调（深蓝） */
--taomni-accent-soft: #5586b5;        /* 辅助色 */
--taomni-tab-active: #ffffff;          /* 活跃标签背景 */
--taomni-tab-inactive: #d6e0ec;        /* 非活跃标签 */
--taomni-sidebar-bg: #f5f6f8;         /* 侧边栏背景 */
--taomni-term-bg: #1d1f21;            /* 终端背景（深色） */
--taomni-term-text: #eaeaea;          /* 终端文字 */
--taomni-term-prompt: #62d36f;        /* 终端 prompt 用户名（绿色） */
--taomni-term-path: #83a7d8;          /* 终端 prompt 路径（蓝色） */
--taomni-hover: #eaf2fb;              /* 悬停高亮 */
--taomni-selected: #cfe2f7;           /* 选中高亮 */

/* 字体 */
font-family: 'Segoe UI', 'Inter', 'Helvetica Neue', sans-serif;  /* UI 字体 */
.taomni-mono: 'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace;  /* 等宽字体 */
```

**给 AI Agent 的原型使用指南：**

1. 实现任何前端组件前，先读取对应的原型文件了解布局结构和交互模式
2. CSS 变量和组件类名（`taomni-btn`、`taomni-tab`、`taomni-tree-row` 等）应迁移到 TailwindCSS + CSS 变量方案
3. 原型中的 lucide-react 图标选择已经确定，实现时保持一致
4. 原型是静态 mockup，实际实现需要接入 Tauri IPC 替换硬编码数据
5. Ribbon 工具栏的按钮布局和分组已在原型中定义，不要随意调整顺序

---

### 5.1 主窗口布局

```
┌──────────────────────────────────────────────────────────────┐
│  [Menu Bar]  File  Edit  Sessions  Tools  View  Help         │
├──────────────────────────────────────────────────────────────┤
│  [Quick Connect]  ssh://user@host:port  [▶ Connect]          │
├────────────┬─────────────────────────────────────────────────┤
│            │  [Tab1: SSH root@srv1] [Tab2: SFTP] [Tab3: +]   │
│  Sessions  ├─────────────────────────────────────────────────┤
│  ┌──────┐  │                                                  │
│  │ 📁 Prod│  │  Terminal / SFTP / Remote Desktop Content      │
│  │  ├ srv1│  │                                                │
│  │  ├ srv2│  │  ┌─────────────────────────────────────────┐  │
│  │  └ srv3│  │  │                                         │  │
│  │ 📁 Dev │  │  │         xterm.js Terminal                │  │
│  │  ├ dev1│  │  │         或 SFTP 文件浏览器               │  │
│  │  └ dev2│  │  │         或 远程桌面                       │  │
│  │        │  │  │                                         │  │
│  │ 📁 DB  │  │  │                                         │  │
│  │  └ pg1 │  │  └─────────────────────────────────────────┘  │
│  │        │  │                                                │
│  └────────┘  ├─────────────────────────────────────────────────┤
│              │  [SFTP Sidebar] (SSH 会话自动附带)              │
│  [Tunnels]   │  /home/user/                                   │
│  L:8080→80   │  ├── documents/                                │
│  D:1080 SOCKS│  ├── config.yml                                │
│              │  └── deploy.sh                                 │
├──────────────┴─────────────────────────────────────────────────┤
│  [Status Bar]  Connected: 3  Tunnels: 2  Transfer: 1 active   │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 布局实现要点

```
src/
├── App.tsx                   # 根组件，全局 Provider
├── layouts/
│   └── MainLayout.tsx        # 主布局（使用 react-resizable-panels）
├── components/
│   ├── menubar/
│   │   └── MenuBar.tsx       # 顶部菜单栏
│   ├── quickconnect/
│   │   └── QuickConnect.tsx  # 快速连接栏
│   ├── sidebar/
│   │   ├── Sidebar.tsx       # 左侧边栏容器
│   │   ├── SessionTree.tsx   # 会话树
│   │   └── TunnelList.tsx    # 隧道列表
│   ├── tabbar/
│   │   └── TabBar.tsx        # 标签栏
│   ├── terminal/             # 终端组件（见 3.1）
│   ├── filebrowser/          # 文件浏览器（见 3.3）
│   ├── session/              # 会话管理（见 3.2）
│   ├── multiexec/            # 多执行（见 3.5）
│   ├── nettools/             # 网络工具（见 3.6）
│   ├── remote_desktop/       # 远程桌面（见 3.7）
│   └── statusbar/
│       └── StatusBar.tsx     # 底部状态栏
├── stores/
│   ├── appStore.ts           # 全局状态
│   ├── terminalStore.ts      # 终端状态
│   └── transferStore.ts      # 传输状态
├── hooks/
│   ├── useTauriCommand.ts    # Tauri command 封装
│   ├── useTauriEvent.ts      # Tauri event 监听
│   └── useTerminal.ts        # 终端生命周期管理
├── lib/
│   ├── ipc.ts                # IPC 类型定义与调用封装
│   └── themes.ts             # 终端主题配置
└── types/
    └── index.ts              # 共享 TypeScript 类型
```

### 5.3 关键 UI 交互规范

**终端标签页：**
- 双击标签可重命名
- 中键点击关闭标签
- 拖拽标签可重排序
- 右键菜单：复制会话、分屏、关闭、关闭其他

**会话树：**
- 双击会话项 → 新建标签页并连接
- 拖拽会话项到分组 → 移动
- 右键菜单：连接、编辑、复制、删除、在文件浏览器中打开

**SFTP 侧边栏：**
- SSH 连接建立后自动展开
- 支持拖拽文件到终端（自动输入路径）
- 双击文件 → 用系统默认编辑器打开（下载到临时目录）

**分屏：**
- Ctrl+Shift+D：垂直分屏
- Ctrl+Shift+E：水平分屏
- 分屏面板可独立连接不同会话

---

## 6. 项目目录结构

```
taomni/
├── src-tauri/                    # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json           # Tauri 配置
│   ├── capabilities/             # Tauri 权限配置
│   ├── icons/                    # 应用图标
│   └── src/
│       ├── main.rs               # 入口，注册所有 commands
│       ├── lib.rs                # Tauri setup
│       ├── state.rs              # AppState 定义
│       ├── terminal/
│       │   ├── mod.rs            # 终端 commands
│       │   ├── pty.rs            # 本地 PTY 管理
│       │   └── ssh.rs            # SSH 连接管理
│       ├── session/
│       │   ├── mod.rs            # 会话 CRUD commands
│       │   ├── models.rs         # 数据模型
│       │   ├── db.rs             # SQLite 操作
│       │   └── import.rs         # 导入/导出
│       ├── filebrowser/
│       │   ├── mod.rs            # 文件浏览 commands
│       │   ├── local.rs          # 本地文件操作
│       │   ├── sftp.rs           # SFTP 操作
│       │   └── transfer.rs       # 传输队列管理
│       ├── tunnel/
│       │   └── mod.rs            # 端口转发管理
│       ├── nettools/
│       │   ├── mod.rs            # 网络工具 commands
│       │   ├── ping.rs
│       │   ├── portscan.rs
│       │   └── dns.rs
│       ├── serial/
│       │   └── mod.rs            # 串口管理
│       └── config/
│           ├── mod.rs            # 应用配置
│           └── keyring.rs        # 凭证管理
├── src/                          # React 前端
│   ├── (结构见 5.2 节)
│   └── ...
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.js
├── index.html
└── DESIGN.md                     # 本文档
```

---

## 7. 分阶段实施计划

### Phase 1：骨架与本地终端（MVP）
**目标：** 能打开应用，创建本地终端标签页

1. `cargo create-tauri-app` 初始化项目（React + TypeScript + Vite）
2. 实现 MainLayout：侧边栏 + 标签栏 + 内容区（react-resizable-panels）
3. 集成 xterm.js，实现 TerminalPanel 组件
4. Rust 端实现 `create_local_terminal` / `write_terminal` / `resize_terminal` / `close_terminal`
5. 打通数据流：xterm ↔ Tauri IPC ↔ PTY
6. 实现标签页管理（新建、关闭、切换）
7. 基础主题支持（dark/light）

**验收标准：** 能在应用内打开多个本地 Shell 标签页，正常交互，支持 resize

### Phase 2：SSH 连接与会话管理
**目标：** 能通过 SSH 连接远程服务器

1. 实现 SessionConfig 数据模型和 SQLite 存储
2. 实现会话编辑表单（SessionEditor）
3. 实现会话树侧边栏（SessionTree）
4. Rust 端实现 SSH 连接（russh）：密码认证 + 密钥认证
5. 实现 `create_ssh_terminal`，复用终端数据流
6. 实现快速连接栏（QuickConnect）
7. 凭证存储（keyring crate）

**验收标准：** 能保存 SSH 会话配置，双击连接，在终端中正常操作远程服务器

### Phase 3：SFTP 文件浏览器
**目标：** SSH 连接时自动展示远程文件浏览器

1. Rust 端实现 SFTP 操作（russh-sftp）：列目录、上传、下载、删除、重命名
2. 实现 FilePanel 组件（文件列表 + 面包屑导航）
3. 实现双面板布局（本地 + 远程）
4. 实现传输队列与进度显示
5. SSH 会话自动附带 SFTP 侧边栏
6. 拖拽上传/下载支持

**验收标准：** SSH 连接后能浏览远程文件，上传下载文件，显示传输进度

### Phase 4：端口转发与高级 SSH 功能
**目标：** 完整的 SSH 隧道管理

1. 实现 Local/Remote/Dynamic 端口转发
2. 隧道管理 UI（创建、停止、状态监控）
3. SSH Agent 转发支持
4. ProxyJump（跳板机）支持
5. X11 转发（Linux 原生支持，macOS/Windows 提示安装 XQuartz/VcXsrv）
6. SSH keepalive 和自动重连

**验收标准：** 能创建各类端口转发，隧道状态实时显示

### Phase 5：多执行与网络工具
**目标：** 运维效率工具

1. 实现 Multi-Exec 面板（选择多个会话，同时发送命令）
2. 实现 Ping 工具
3. 实现端口扫描工具
4. 实现 DNS 查询工具
5. 网络接口信息展示

**验收标准：** 能同时向多个服务器发送命令，能使用内置网络工具

### Phase 6：RDP/VNC/Serial 与导入导出
**目标：** 完整协议支持

1. RDP 启动器（调用系统客户端）
2. VNC 查看器（noVNC 嵌入或系统客户端）
3. 串口终端支持
4. 会话导入（MobaXterm .mxtsessions、PuTTY registry、SSH config）
5. 会话导出
6. 应用设置面板

**验收标准：** 能连接 RDP/VNC/Serial，能从其他工具导入会话

---

## 8. AI Coding Agent 使用指南

### 8.1 给 Agent 的关键提示

当你让 AI agent 实现某个模块时，提供以下上下文：

```
你正在开发一个 Tauri 2.x 桌面应用（Rust 后端 + React/TypeScript 前端）。
项目名称：Taomni（为开发者打造的 AI 原生一体化远程工作台）。

技术栈：
- 后端：Rust + Tauri 2 + tokio + russh + portable-pty + rusqlite
- 前端：React 18 + TypeScript + Vite + xterm.js + Zustand + TailwindCSS
- IPC：Tauri commands (invoke) + Tauri events (emit/listen)

架构约定：
1. 所有后端逻辑通过 #[tauri::command] 暴露给前端
2. 实时数据流（终端输出、传输进度）通过 Tauri event 推送
3. 前端状态用 Zustand 管理
4. 数据库用 SQLite (rusqlite)
5. 密码/密钥存储用 OS keyring (keyring crate)

请参考 DESIGN.md 中对应模块的接口定义来实现。
```

### 8.2 模块实现顺序建议

每次让 agent 实现一个完整模块，不要跨模块。推荐顺序：

1. 先让 agent 搭建项目骨架（Tauri init + 基础布局）
2. 然后按 Phase 顺序逐模块实现
3. 每个模块先实现 Rust 后端 commands，再实现前端组件
4. 每完成一个模块，手动测试验证后再进入下一个

### 8.3 常见 AI Agent 踩坑点与规避

**问题 1：xterm.js 集成**
- Agent 容易忘记调用 `fitAddon.fit()` 导致终端尺寸不对
- 提示 agent：xterm 必须在 DOM 挂载后初始化，用 useEffect + ref
- WebGL addon 在某些环境不可用，需要 try-catch fallback 到 canvas

**问题 2：Tauri IPC 数据类型**
- Rust 的 `Vec<u8>` 在 Tauri IPC 中会被序列化为 JSON 数组，性能差
- 提示 agent：终端数据传输用 base64 编码字符串，或使用 Tauri 的 raw event

**问题 3：异步生命周期**
- PTY 读取循环需要在 tokio::spawn 中运行，但需要持有 AppHandle
- 提示 agent：用 `app_handle.clone()` 传入 spawn，用 `Arc<RwLock<>>` 管理共享状态

**问题 4：跨平台 PTY**
- Windows 上 portable-pty 使用 ConPTY，行为与 Unix PTY 略有不同
- 提示 agent：Shell 路径需要平台判断（Linux/macOS: /bin/bash, Windows: cmd.exe 或 powershell.exe）

**问题 5：russh 使用**
- russh 的 API 较底层，agent 容易写错连接流程
- 提示 agent：需要实现 `russh::client::Handler` trait，处理认证回调

**问题 6：React 组件 resize**
- 终端 resize 需要同步 xterm 和后端 PTY 尺寸
- 提示 agent：用 ResizeObserver 监听容器尺寸变化，debounce 后同时调用 fitAddon.fit() 和 invoke("resize_terminal")

### 8.4 给 Agent 的模块级 Prompt 模板

```markdown
## 任务：实现 [模块名]

### 上下文
- 项目：Taomni (Tauri 2 + React + TypeScript)
- 参考：DESIGN.md 第 [X.X] 节

### 需要创建/修改的文件
- Rust: src-tauri/src/[module]/mod.rs
- React: src/components/[module]/[Component].tsx
- Store: src/stores/[module]Store.ts (如需要)
- Types: src/types/index.ts (添加类型)

### 接口定义
[从 DESIGN.md 复制对应的 Tauri Commands 和数据模型]

### 验收标准
[从 DESIGN.md 复制对应 Phase 的验收标准]

### 注意事项
[从 8.3 节选择相关的踩坑点]
```

---

## 9. 配置文件参考

### 9.1 tauri.conf.json 关键配置

```json
{
  "productName": "Taomni",
  "version": "0.1.0",
  "identifier": "com.taomni.app",
  "build": {
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "Taomni",
        "width": 1280,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": true,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    }
  }
}
```

### 9.2 终端主题示例

```typescript
// src/lib/themes.ts
export const terminalThemes = {
  dark: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#585b70',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
  },
  light: {
    background: '#eff1f5',
    foreground: '#4c4f69',
    cursor: '#dc8a78',
    selectionBackground: '#acb0be',
    black: '#5c5f77',
    red: '#d20f39',
    green: '#40a02b',
    yellow: '#df8e1d',
    blue: '#1e66f5',
    magenta: '#ea76cb',
    cyan: '#179299',
    white: '#bcc0cc',
  },
};
```

---

## 10. 与 MobaXterm 功能对照

| MobaXterm 功能 | Taomni 状态 | 实现方式 |
|---------------|------------|---------|
| SSH 客户端 | Phase 2 | russh + xterm.js |
| 本地终端 | Phase 1 | portable-pty + xterm.js |
| SFTP 浏览器 | Phase 3 | russh-sftp |
| 会话管理 | Phase 2 | SQLite + 会话树 |
| X11 转发 | Phase 4 | SSH X11 forwarding（需系统 X server） |
| 端口转发 | Phase 4 | russh tunnel API |
| Multi-Exec | Phase 5 | 多会话并行写入 |
| RDP 客户端 | Phase 6 | 系统客户端调用 |
| VNC 客户端 | Phase 6 | noVNC 嵌入或系统客户端 |
| Telnet | Phase 6 | tokio TCP 直连 |
| Serial | Phase 6 | tokio-serial |
| 内置 X Server | 不实现 | 复杂度极高，建议用系统 X server |
| 内置 Unix 工具 | 不实现 | Linux/macOS 原生支持，Windows 建议 WSL |
| Ping/Port Scan | Phase 5 | surge-ping + tokio TCP |
| DNS 查询 | Phase 5 | dns-lookup |
| 宏录制 | 未规划 | 可后续扩展 |
| MobaTextEditor | 不实现 | 使用系统编辑器 |

---

## 11. 参考资源

**UI 原型（本地）：**
- `/data/code-src/person/mob-design/artifacts/mockup-sandbox/src/components/mockups/mobaxterm/` — 5 个完整 UI 原型
- `/data/code-src/person/mob-design/current-state.png` — 当前原型截图

**外部文档：**
- [Tauri 2.x 官方文档](https://v2.tauri.app/)
- [xterm.js 文档](https://xtermjs.org/)
- [russh (Eugeny fork)](https://github.com/Eugeny/russh)
- [portable-pty](https://lib.rs/crates/portable-pty)
- [marc2332/tauri-terminal 参考实现](https://github.com/marc2332/tauri-terminal)
- [Tauri 2 + React 教程](https://gtc.noqta.tn/en/tutorials/tauri-2-react-rust-desktop-app-tutorial-2026)
- [Tauri vs Electron 2026 对比](https://tech-insider.org/tauri-vs-electron-2026/)
