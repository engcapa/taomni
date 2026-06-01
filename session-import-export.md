# Session 导入导出功能 — 实现状态分析与计划

## 1. 总体评估

> **结论：后端逻辑已完整实现（纯前端 TypeScript），UI 入口基本具备，但仍有若干 gap 需要补齐。**

| 维度 | 状态 | 说明 |
|------|------|------|
| 核心解析/序列化库 | ✅ 完成 | `src/lib/sessionImportExport.ts` (1,127 行) |
| OpenSSH 配置解析 | ✅ 完成 | `src/lib/quickConnect.ts` `parseOpenSshConfig()` |
| 单元测试 | ✅ 完成 | `src/lib/sessionImportExport.test.ts` (245 行) |
| Session Store import 方法 | ✅ 完成 | `sessionStore.ts` `importSessions()` |
| 右键菜单导入导出 | ✅ 完成 | `SessionTree.tsx` 文件夹右键菜单 |
| WelcomePanel OpenSSH 导入 | ✅ 完成 | `WelcomePanel.tsx` "Import OpenSSH config" 卡片 |
| MenuBar 菜单导入导出 | ✅ 完成 | Sessions 菜单已增加 Import/Export 子菜单与稳定 test-id |
| Rust 后端系统级导入 | ✅ 完成 | `src-tauri/src/session/import.rs` 已创建，用于 PuTTY/WSL/本地配置扫描等系统 API 场景 |
| AI 安全字段 (disableAiWrite) | ✅ 完成 | 已对齐并紧急补齐，确保导入导出时会话 AI 限制属性不丢 |
| PuTTY 注册表导入 | ✅ 完成 | Rust 后端读取 `HKCU\Software\SimonTatham\PuTTY\Sessions`，SessionTree 已接入 |
| Xshell 导入 (文件/本地配置) | ✅ 完成 | 已支持 `.xsh` INI、包含多个 `.xsh` 的 ZIP 压缩包，以及 `%APPDATA%\NetSarang\Xshell\Sessions` 本地扫描 |
| Tabby 导入 (文件/本地配置) | ✅ 完成 | 已支持 `config.yaml` YAML/JSON 解析，以及 Windows/macOS/Linux 默认路径扫描 |
| WindTerm 导入 (文件/本地配置) | ✅ 完成 | 已支持 `user.sessions` JSON 递归解析，以及常见 profile 路径扫描 |
| macOS 常用工具 (iTerm2/Terminal.app/Termius) | ✅ 完成 | iTerm2 JSON/XML/binary plist、Terminal.app XML/binary plist/本机偏好、Termius OpenSSH 导出引导与探测已接入 |
| 其他 MobaXterm 对齐导入 (WSL/mRemote/SecureCRT等) | ✅ 完成 | WSL/External Bash/PuTTYCM/SuperPuTTY/mRemote/SecureCRT/RDM/Exceed 已接入，Exceed 覆盖 XML、INI/key-value 与 SSH 命令型配置 |
| CSV 导出 | ✅ 完成 | `serializeCsvSessions()` 已实现，右键菜单与 MenuBar 均可导出 |
| 导入预览/确认对话框 | ✅ 完成 | `SessionImportPreview` 已接入 SessionTree 与 MenuBar，确认后才写库 |
| IPC 类型包装 | ✅ 完成 | `ipc.ts` 已添加 PuTTY/WSL/External Bash/本地配置扫描 typed invoke 包装 |

---

## 2. 已实现功能详细清单

### 2.1 导入格式

| 格式 | 入口函数 | 文件 | UI 入口 |
|------|----------|------|---------|
| **Taomni JSON** (`.taomni-sessions.json`) | `parseTaomniSessions()` | `sessionImportExport.ts` | SessionTree 右键菜单 → "Import Taomni sessions" |
| **MobaXterm** (`.mxtsessions` / `.moba`) | `parseMobaXtermSessions()` | `sessionImportExport.ts` | SessionTree 右键菜单 → "Import MobaXterm sessions" |
| **CSV** (`.csv`) | `parseCsvSessions()` | `sessionImportExport.ts` | SessionTree 右键菜单 → "Import sessions from a CSV file" |
| **OpenSSH config** | `parseOpenSshConfig()` | `quickConnect.ts` | WelcomePanel → "Import OpenSSH config" 卡片 |

### 2.2 导出格式

| 格式 | 入口函数 | 文件 | UI 入口 |
|------|----------|------|---------|
| **Taomni JSON** | `serializeTaomniSessions()` | `sessionImportExport.ts` | SessionTree 右键菜单 → "Export Taomni sessions" |
| **MobaXterm** | `serializeMobaXtermSessions()` | `sessionImportExport.ts` | SessionTree 右键菜单 → "Export MobaXterm sessions" |
| **HTML 网页** | 内联 `generateHtml()` | `SessionTree.tsx` | SessionTree 右键菜单 → "Generate HTML web page" |

### 2.3 安全与健壮性

- ✅ 最大导入文件大小限制：2MB (`MAX_IMPORT_CHARS`)
- ✅ 最大会话数限制：5,000 (`MAX_SESSIONS`)
- ✅ 字段长度限制：名称 160 字符、主机 512 字符、路径 1024 字符
- ✅ 重名检测与自动重命名（如 "Prod" → "Prod (2)"）
- ✅ 导出排除密码/敏感数据
- ✅ 导出排除本地日志路径 (`logPath`)
- ✅ 完美支持并保留 `disableAiWrite` AI 安全属性的导入与导出，防止备份迁移造成安全降级
- ✅ MobaXterm 编码自动检测（UTF-8/GBK/Windows-1252）
- ✅ 控制字符过滤
- ✅ 端口号范围钳制（0-65535）

### 2.4 数据流

**导入流程**（全前端实现）：
```
用户右键点击 SessionTree → 选择导入格式 → 浏览器文件选择器 
→ 前端解析文件 (sessionImportExport.ts) → SessionConfig[] 
→ sessionStore.importSessions() → 逐个调用 saveSession/saveSessionGroup IPC 
→ 刷新 UI
```

**导出流程**（全前端实现）：
```
用户右键点击 SessionTree → 选择导出格式 → 前端序列化 (sessionImportExport.ts) 
→ 创建 Blob → <a> 元素触发浏览器下载
```

> **注意**：整个导入导出没有使用 Rust 后端！所有解析和序列化都在浏览器/WebView JavaScript 层完成。数据库操作通过已有的 `save_session` / `save_session_group` IPC 逐条完成。

---

## 3. 已实现 / 改进项

### 3.1 ✅ MenuBar 菜单入口（P1 已完成）

**现状**：[MenuBar.tsx](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/components/menubar/MenuBar.tsx) 的 "Sessions" 菜单已补齐：
- Import Taomni sessions
- Import MobaXterm sessions
- Import sessions from a CSV file
- Import OpenSSH config
- Export Taomni sessions
- Export MobaXterm sessions
- Export sessions as CSV
- Generate HTML web page

**测试用例期望**：TC-054 期望右键菜单中有导入导出选项（已实现），但没有期望 File 菜单的导入导出。然而 DESIGN.md 和 feature-list.md (F6.6 controls) 定义了 `#menu-file`、`#menu-import-sessions`、`#menu-export-sessions` 等控件 ID。

**实现**：已通过共享 `fileHelpers.ts`、`sessionExportHtml.ts` 和核心 import/export 函数接入 MenuBar；ContextMenu 新增显式 `testId` 支持，菜单项提供 `menu-import-sessions`、`import-json`、`import-csv`、`import-mobaxterm`、`import-openssh`、`menu-export-sessions`、`export-json`、`export-csv` 等稳定锚点。

### 3.2 ✅ CSV 导出（P2 已完成）

**现状**：`sessionImportExport.ts` 已实现 CSV 导入和导出。

**实现**：新增 `serializeCsvSessions()`，导出列为 `name, session_type, host, port, username, group_path`，按 RFC 4180 处理逗号、引号和换行；CSV 导入同步识别 `group_path` / `folder_path` / `folder` 列，支持与目标文件夹组合后保留层级。

### 3.3 ✅ 导入预览/确认对话框（P2 已完成）

**现状**：导入文件后先展示预览，不再直接写入数据库。

**实现**：新增 `SessionImportPreview` 对话框，展示导入来源、目标文件夹、会话数量、跳过数量、警告信息，以及最多 80 条会话预览；SessionTree 右键导入和 MenuBar 导入均确认后才调用 `importSessions()`。

### 3.4 ✅ MobaXterm 第三方程序导入（P3 已完成）

**现状**：SessionTree 右键菜单中的 "Import sessions from third-party programs" 子菜单已经从存根改为可执行入口。WSL、External Bash、PuTTY 已走 Rust 后端；PuTTYCM、SuperPuTTY、mRemote/mRemoteNG、SecureCRT、RDM 已支持文件导入，其中 mRemoteNG 和 SecureCRT 也支持本机配置扫描。Exceed 已覆盖 XML、INI/key-value 与 SSH 命令型文本配置。

1. **Import WSL sessions**：导入 Windows Subsystem for Linux (WSL) 子系统会话。
   - **实现策略**：需要 Tauri 后端调用 `wsl.exe -l -v` 命令，枚举系统已安装的 WSL 发行版（如 Ubuntu, Debian 等），将其作为本地 Terminal 会话（或 SSH 本地环回）导入 Taomni。
2. **Import External Bash sessions**：导入外部 Bash 会话。
   - **实现策略**：后端扫描系统已知路径（如 `C:\Program Files\Git\bin\bash.exe`、`C:\cygwin64\bin\bash.exe`、`C:\msys64\usr\bin\bash.exe`），将检测到的 Shell 路径导入为本地 Terminal 会话。
3. **Import PuTTY sessions**：导入 PuTTY 会话。
   - **实现策略**：需要 Rust 后端读取注册表 `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\` 下的子项，解析主机、端口、用户名、协议、密钥文件等字段。
4. **Import PuTTYCM sessions**：导入 PuTTY Connection Manager 会话。
   - **实现策略**：支持导入 PuTTYCM 导出的 XML 格式配置文件，解析其中的连接节点。
5. **Import SuperPuTTY sessions**：导入 SuperPuTTY 会话。
   - **实现策略**：支持导入 SuperPuTTY 导出的 XML 格式配置文件（通常为 `SuperPuTTY.settings` 里的 Connection 列表）。
6. **Import MRemote sessions**：导入 mRemote / mRemoteNG 会话。
   - **实现策略**：
     - **导出文件**：支持导入用户导出的 `.xml` 格式会话文件。
     - **本地配置**：自动扫描 `%APPDATA%\mRemoteNG\confCons.xml`，解析其中的 XML 会话层级与连接属性。
7. **Import Exceed sessions**：导入 OpenText Exceed X-server 会话。
   - **实现策略**：解析 Exceed 的会话配置文件，提炼相关连接。
8. **Import SCRT sessions**：导入 SecureCRT (SCRT) 会话。
   - **实现策略**：
     - **导出文件**：支持导入导出的 XML 会话结构或打包文件。
     - **本地配置**：自动扫描 SecureCRT 的配置目录（如 `%APPDATA%\VanDyke\Config\Sessions\`），解析目录下的所有 `.ini` 配置文件，保留目录树结构导入。
9. **Import RDM sessions**：导入 Remote Desktop Manager 会话。
   - **实现策略**：解析 RDM 导出的 `.rdm` 或 `.xml` 格式文件，转换 SSH/SFTP/Telnet 连接。

### 3.5 ✅ Rust 后端导入模块（P3/架构决策）

**现状**：`src-tauri/src/session/import.rs` 已创建，系统级访问逻辑在 Rust 后端实现，通用文件解析仍保留在前端 TypeScript：

- 前端解析对于大文件（2MB 限制内）性能足够
- PuTTY 注册表读取已在后端完成
- WSL / External Bash 枚举已在后端完成
- 本机配置路径扫描已在后端完成，返回文本后由前端解析器转换

**决策**：保持现有前端解析架构（Taomni JSON / MobaXterm / CSV / OpenSSH / 第三方导出文件），仅在需要系统 API 或跨目录读取时通过 Rust 后端命令提供扫描能力。

### 3.6 ✅ IPC 类型包装（P3）

**现状**：`ipc.ts` 已添加 `importPuttySessions()`、`importWslSessions()`、`importExternalBashSessions()`、`scanLocalSessionFiles()` 与 `LocalSessionFile` 类型，前端不再直接散落裸 `invoke`。

### 3.7 ✅ 扩展第三方会话导入功能（新增 Xshell, Tabby, WindTerm, macOS 常用工具）

根据用户需求，在对齐 MobaXterm 已有功能的基础上，进一步扩展支持目前最主流的终端工具（**Xshell**、**Tabby**、**WindTerm** 以及 **macOS 常用终端工具**）的会话导入。

对于每种工具，均需提供以下**双轨导入模式**：
1. **对应导出文件导入**（由用户手动选择该软件导出的会话备份文件，纯前端解析，跨平台支持）。
2. **本机已安装配置导入**（自动扫描本机当前正在使用的该软件配置路径，通过 Tauri 后端或前端文件读取 API 直接加载，零操作一键导入）。

具体工具的技术规格如下：

---

#### 3.7.1 Xshell (NetSarang) 会话导入
Xshell 是 Windows 平台最主流的商业终端。

- **1. 对应导出文件导入**
  - **支持格式**：`.xsh` 单个会话文件或包含多个 `.xsh` 文件的 ZIP 压缩包。
  - **格式规范**：`.xsh` 为标准的 **INI 文本格式**。我们需要解析 `[Connection]` 段中的关键字段：
    - `Host` (主机地址)
    - `Port` (端口)
    - `Protocol` (协议，如 SSH, TELNET, SFTP)
    - `UserName` (用户名)
  - **解析示例**：
    ```ini
    [Connection]
    Host=192.168.1.100
    Port=22
    Protocol=SSH
    [Terminal]
    UserName=root
    ```
- **2. 本机已安装配置导入**
  - **自动扫描路径**：`%APPDATA%\NetSarang\Xshell\Sessions\` (即 `C:\Users\<Username>\AppData\Roaming\NetSarang\Xshell\Sessions\`)。
  - **导入逻辑**：Tauri 后端（或通过授权的前端路径读取）递归遍历该目录下的所有文件夹和 `.xsh` 文件。
  - **目录结构保留**：Xshell 会话的文件夹层级直接映射为 Taomni 的 Session 组层级，完美保留用户的分类习惯。

---

#### 3.7.2 Tabby (原 Terminus) 会话导入
Tabby 是一款极受欢迎的开源现代跨平台终端。

- **1. 对应导出文件导入**
  - **支持格式**：`config.yaml` 或其导出的配置文件。
  - **格式规范**：**YAML 格式**。我们需要读取其中的 `profiles` 数组，并筛选 `type: ssh`、`type: telnet` 等节点：
    - `name` (会话名称)
    - `options.host` (主机)
    - `options.port` (端口)
    - `options.user` (用户名)
  - **解析示例**：
    ```yaml
    profiles:
      - name: My Server
        type: ssh
        options:
          host: 10.0.0.5
          port: 22
          user: ubuntu
    ```
- **2. 本机已安装配置导入**
  - **自动扫描路径**（跨平台默认路径）：
    - **Windows**: `%APPDATA%\tabby\config.yaml` (以及用户级覆盖路径 `~/.tabby/config.yaml`)
    - **macOS**: `~/Library/Application Support/tabby/config.yaml` (以及 `~/.tabby/config.yaml`)
    - **Linux**: `~/.config/tabby/config.yaml` (以及 `~/.tabby/config.yaml`)
  - **导入逻辑**：检测到对应文件存在后，直接异步读取并解析，提取所有 SSH/Telnet 会话导入至 Taomni 指定分组中。

---

#### 3.7.3 WindTerm 会话导入
WindTerm 是一款高性能、多功能的高颜值跨平台终端。

- **1. 对应导出文件导入**
  - **支持格式**：`user.sessions` 文件或导出的 `.sessions` (JSON 格式)。
  - **格式规范**：**JSON 格式**。
  - **解析字段**：
    - `name` (名称)
    - `host` (主机)
    - `port` (端口)
    - `username` (用户名)
    - `protocol` (如 "ssh", "sftp")
- **2. 本机已安装配置导入**
  - **自动扫描路径**：WindTerm 是便携式的，其配置文件通常保存在用户指定的 `Profiles` 目录下：
    - 典型路径为：`[Profiles_Directory]/.wind/profiles/default.v10/terminal/user.sessions`
    - 我们将提供引导输入，或者当检测到同级或安装目录下存在 `profiles.config` 时，解析其中的路径来自动定位 `user.sessions`。
  - **导入逻辑**：定位后直接以 JSON 格式解析会话列表，保留其定义的属性与分组结构。

---

#### 3.7.4 macOS 常用终端工具导入
针对 macOS 平台的用户，专门适配三款最常用的终端工具：**iTerm2**、**Terminal.app** 以及 **Termius**。

- **iTerm2**
  - **1. 对应导出文件**：iTerm2 支持将 Profile 导出为 JSON 格式。
  - **2. 本机配置导入**：
    - **扫描路径**：`~/Library/Application Support/iTerm2/DynamicProfiles/`
    - **解析规格**：该目录下存放着 Dynamic Profiles (JSON 或 XML Plist)。我们读取文件，解析 `Profiles` 数组下所有的字典节点，提取 `Name`, `Command` (如解析 `ssh user@host -p port`) 或 `Custom Command`，自动转换为 SSH 会话导入。
- **Terminal.app (macOS 内置终端)**
  - **1. 对应导出文件**：`.terminal` 文件（XML/二进制 Plist 格式，记录会话设置）。
  - **2. 本机配置导入**：
    - **扫描路径/命令**：读取 `~/Library/Preferences/com.apple.Terminal.plist`。
    - **解析规格**：由于 plist 属于苹果私有格式，需要使用 Rust 后端的 `plist` 库或前端调用 macOS `defaults read com.apple.Terminal` 命令来读取并转换其 Shell 启动命令中包含 of SSH 连接。
- **Termius**
  - **1. 对应导出文件**：Termius CLI 导出的标准 SSH config。
    - **实现策略**：Termius 客户端本身不提供直接导出 CSV/JSON 的按键，但官方提供了 Termius CLI 命令行工具。用户可以在终端运行：
      ```bash
      termius export-ssh-config
      ```
      这会将所有主机导出为标准的 OpenSSH Config 格式。Taomni 的导入功能将直接提示并复用已有的 OpenSSH Config 解析器 (`parseOpenSshConfig`) 来完美解析导入。
  - **2. 本机配置导入**：
    - **技术说明**：Termius 本地 SQLite 数据库（存储于 `%APPDATA%\Termius\` 或 `~/Library/Application Support/Termius/`）使用系统凭据管理器（Windows Credential Manager / macOS Keychain）中的密钥进行了端到端硬加密，直接读取 file 无法解密敏感数据。
    - **解决策略**：在 UI 导入界面中，为 Termius 增加“引导提示”，以图文形式指导用户运行 `termius export-ssh-config` 导出到默认位置，随后 Taomni 会自动检测该位置的配置文件并一键导入。

---

### 3.8 🔴 已解决的紧急安全机制对齐：安全字段 `disableAiWrite` 导入导出支持

**现状分析**：
在最近合并的分支中，Taomni 引入了极其关键的**会话级 AI 安全动作禁用限制**（用以规避 AI 助手在特定会话下执行写动作，如命令注入与 SFTP 文件上传等）。该属性 `disableAiWrite: boolean` 被保存在 Session `options_json` 中。
然而，在分析代码时我们发现，[sessionImportExport.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/lib/sessionImportExport.ts) 中的核心过滤函数 `sanitizeOptions()` 采用的是强白名单过滤复制机制，因此在导入和导出时，旧版的白名单没有包含这个全新的字段，导致：
1. 导入含有 `disableAiWrite: true` 的 Taomni JSON 配置文件时，该属性会被完全过滤并降级丢失。
2. 导出时，即使会话开启了此项安全保护，导出的备份文件里也无法带有这一关键字段。

**解决与实现**：
为了规避由于导入导出备份导致会话安全性降级的问题，我们已经**完成了该紧急安全机制的对齐与修复**！
在 `sanitizeOptions()` 函数中成功补齐了该安全属性的显式保留：
```typescript
copyBoolean(source, output, "disableAiWrite");
```
这确保了无论是通过 JSON 文件做会话迁移、备份，还是未来跨终端的导入导出，AI 安全限制字段均能在往返（Round-trip）生命周期中完美保留。

---

## 4. 关键文件索引

| 文件 | 说明 | 行数 |
|------|------|------|
| [sessionImportExport.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/lib/sessionImportExport.ts) | 核心导入/导出解析与序列化库 | 1,127 |
| [sessionImportExport.test.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/lib/sessionImportExport.test.ts) | 单元测试 | 245 |
| [quickConnect.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/lib/quickConnect.ts) | OpenSSH config 解析 (`parseOpenSshConfig`) | 224 |
| [SessionTree.tsx](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/components/sidebar/SessionTree.tsx) | UI：右键菜单导入/导出入口 | 845 |
| [WelcomePanel.tsx](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/components/WelcomePanel.tsx) | UI：Welcome 页面 OpenSSH 导入 | 399 |
| [MenuBar.tsx](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/components/menubar/MenuBar.tsx) | UI：菜单栏（缺少导入导出） | 101 |
| [sessionStore.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/stores/sessionStore.ts) | Zustand store，含 `importSessions()` | 283 |
| [ipc.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/lib/ipc.ts) | Tauri IPC 类型定义（含导入扫描包装） | 488 |
| [session/mod.rs](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src-tauri/src/session/mod.rs) | Rust 后端会话 CRUD + import 模块导出 | 66 |
| [session/import.rs](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src-tauri/src/session/import.rs) | Rust 后端系统级会话导入与本地配置扫描 | 604 |
| [session/models.rs](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src-tauri/src/session/models.rs) | Rust 数据模型 | 110 |
| [session/db.rs](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src-tauri/src/session/db.rs) | SQLite 数据库操作 | 174 |

---

## 5. 实施计划

### Phase 1：MenuBar 菜单入口 ✅

**目标**：在菜单栏添加导入导出入口，与 SessionTree 右键菜单功能保持一致。

#### 步骤

1. ✅ **修改 [MenuBar.tsx](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/components/menubar/MenuBar.tsx)**
   - 在 "Sessions" 菜单中添加分隔线和以下项：
     - Import Taomni sessions
     - Import MobaXterm sessions
     - Import sessions from a CSV file
     - Import OpenSSH config
     - ——（分隔线）
     - Export Taomni sessions
     - Export MobaXterm sessions
     - Generate HTML web page
   - 需要引入 `sessionImportExport.ts` 中的解析/序列化函数
   - 需要引入 `sessionStore` 以获取 sessions 和 importSessions
   - 需要引入 `quickConnect.ts` 中的 `parseOpenSshConfig`

2. ✅ **添加 test-id 属性**
   - 给菜单项添加 `data-testid` 以匹配 feature-list.md 中定义的控件 ID：
     - `#menu-import-sessions` → 导入子菜单
     - `#import-json` → Import Taomni sessions
     - `#import-csv` → Import CSV
     - `#import-mobaxterm` → Import MobaXterm
     - `#import-openssh` → Import OpenSSH config
     - `#menu-export-sessions` → 导出子菜单
     - `#export-json` → Export Taomni sessions
     - `#export-csv` → Export CSV (需 Phase 2 实现后启用)

3. ✅ **复用文件打开/下载逻辑**
   - 将 `SessionTree.tsx` 中的 `openTextFile`、`openBinaryFile`、`downloadTextFile` 提取到公共模块 `src/lib/fileHelpers.ts`

### Phase 2：CSV 导出 ✅

#### 步骤

1. ✅ **在 [sessionImportExport.ts](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/src/lib/sessionImportExport.ts) 中添加 `serializeCsvSessions()`**
   - 导出列：name, session_type, host, port, username, group_path
   - 处理包含逗号和引号的字段（RFC 4180）
   - 返回 `SessionExportResult`

2. ✅ **更新 SessionTree 右键菜单**
   - 在 "Export MobaXterm sessions" 后添加 "Export sessions as CSV"

3. ✅ **添加单元测试**
   - 在 `sessionImportExport.test.ts` 中添加 CSV 导出测试

### Phase 3：导入预览对话框 ✅

#### 步骤

1. ✅ **创建 `src/components/session/SessionImportPreview.tsx`**
   - 对话框 UI，展示：
     - 将导入的会话数量
     - 会话列表预览（名称、类型、主机、端口）
     - 警告信息（如有）
     - 跳过的会话数量（如有）
     - 目标文件夹选择（可选）
   - 确认/取消按钮

2. ✅ **修改 `SessionTree.tsx` 的导入流程**
   - 文件解析后，先展示预览对话框
   - 用户确认后再调用 `importSessions()`

### Phase 4：PuTTY 注册表导入 ✅

> **注意**：此功能需要 Rust 后端支持，因为需要读取 Windows 注册表。

#### 步骤

1. ✅ **创建 `src-tauri/src/session/import.rs`**
   - 添加 `read_putty_sessions()` 函数
   - 读取 `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions` 注册表键
   - 解析每个 session 的 HostName, PortNumber, UserName, Protocol, PublicKeyFile

2. ✅ **注册 Tauri 命令**
   - `import_putty_sessions` → 返回 `Vec<SessionConfig>`

3. ✅ **前端调用**
   - 在 `ipc.ts` 添加 `importPuttySessions()` 包装
   - 在 SessionTree 右键菜单中替换 "PuTTY sessions" 的 `unavailable` 回调

### Phase 5：第三方会话导入扩展（Xshell, Tabby, WindTerm, macOS 工具）✅

#### 步骤

1. ✅ **扩展前端解析库 (`src/lib/sessionImportExport.ts`)**
   - 添加 `parseXshellSessions(content: string): SessionConfig[]` (INI 解析)
   - 添加 `parseTabbySessions(content: string): SessionConfig[]` (YAML 解析)
   - 添加 `parseWindTermSessions(content: string): SessionConfig[]` (JSON 解析)
   - 添加 `parseItermDynamicProfiles(content: string): SessionConfig[]` (JSON Profiles)

2. ✅ **添加 Tauri 系统级别文件扫描指令**
   - 在 `src-tauri/src/session/import.rs` 中：
     - 添加 `scan_local_sessions(app_name: String)` 指令。
     - 实现针对 Windows/macOS 的路径定位逻辑：
       - `Xshell`: 获取 `%APPDATA%\NetSarang\Xshell\Sessions` 下的所有 `.xsh` 文件。
       - `Tabby`: 读取对应系统下 `%APPDATA%\tabby\config.yaml` 或 `Library/Application Support/tabby/config.yaml`。
       - `macOS Terminal/iTerm`: 读取 Plist 配置文件或 DynamicProfiles 目录文件。
     - 前端通过 Tauri IPC 调用 `scan_local_sessions(appName)`，并由前端库进行反序列化和格式转换。

3. ✅ **UI 增强与用户引导**
   - 在导入界面中设计“本机自动导入”卡片，通过一键点击触发自动扫描。
   - 针对 Termius，展示引导式弹窗提示：
     > *“由于 Termius 本地配置采用系统级加密，请点击 [查看指引] 在您的终端执行 `termius export-ssh-config`。Taomni 将自动探测导出路径并为您完美导入会话。”*
   - 提供成功导入提示，并支持将新导入的会话在指定的独立分类组（如 "Imported_Xshell", "Imported_Tabby"）中隔离存放。

---

## 6. 测试用例对照

| 测试用例 | 期望行为 | 当前状态 |
|----------|----------|----------|
| [TC-054](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/qa-ui-auto-tests/cases/TC-054-session-import-and-export-json-csv-and-mobaxterm.testcase.yaml) | 右键菜单有 Export Taomni / Export MobaXterm | ✅ 通过 |
| [TC-055](file:///C:/Users/zhyha/.gemini/antigravity/worktrees/taomni/audit-session-import-export/qa-ui-auto-tests/cases/TC-055-openssh-config-import-from-welcome-panel-creates.testcase.yaml) | Welcome 面板有 "Import OpenSSH config" | ✅ 通过 |
| 单元测试 | Taomni JSON 往返、MobaXterm 导入导出、安全过滤 | ✅ 全部通过 |

---

## 7. 总结

Session 导入导出功能已完成 **约 100%**（结合新增的扩展第三方导入目标后）：

- ✅ **核心库基本建立**：支持 Taomni JSON、MobaXterm、CSV、OpenSSH 导入及部分导出。
- ✅ **基础 UI 框架就绪**：SessionTree 右键菜单及 WelcomePanel 完成。
- ✅ **安全及规范机制到位**：大小限制、敏感信息排除、重名规避等已实现。
- ✅ **MenuBar 入口完成**：Sessions 菜单已有 Import/Export 子菜单（Phase 1 已完成）。
- ✅ **CSV 导出完成**：支持 CSV 导入/导出 round-trip（Phase 2 已完成）。
- ✅ **导入预览确认框完成**：文件导入后先预览，确认后写库（Phase 3 已完成）。
- ✅ **高级系统级导入完成**：PuTTY 注册表、WSL、External Bash 已有 Rust 后端支撑并接入 UI（Phase 4 已完成）。
- ✅ **主流第三方软件导入完成**：Xshell、Tabby、WindTerm、iTerm2、Terminal.app、Termius 已接入文件/本地扫描主路径；Xshell ZIP、Terminal 二进制 plist、Exceed XML/INI/SSH 命令型配置均已覆盖（Phase 5 已完成）。

**后续仅保留运维类事项**：如未来拿到新的 Exceed 二进制专有样本，可追加专项适配；Termius 加密本地数据库按设计不直接读取，继续采用官方 CLI 导出 OpenSSH config 的安全路径。

---

## 8. 实现状态（2026-05-24 审计 / 首批完善任务）

图例：✅ 已完成 / ℹ 后续运维类事项

### 8.1 P1 / P2 已完成

- ✅ MenuBar Sessions 菜单新增 Import/Export 子菜单
- ✅ ContextMenu 支持显式 `testId`，导入导出菜单已有稳定测试锚点
- ✅ 抽取 `src/lib/fileHelpers.ts`，复用文件选择与下载逻辑
- ✅ 抽取 `src/lib/sessionExportHtml.ts`，SessionTree 与 MenuBar 共用 HTML 导出
- ✅ 新增 `serializeCsvSessions()`，支持 CSV 导出
- ✅ CSV 导入支持 `group_path` / `folder_path` / `folder` 列，导入时保留层级
- ✅ SessionTree 右键菜单新增 "Export sessions as CSV"
- ✅ 新增 `SessionImportPreview`，导入前展示数量、跳过项、警告和会话预览
- ✅ SessionTree 导入流程改为预览确认后写库
- ✅ MenuBar 导入流程改为预览确认后写库
- ✅ 单元测试新增 CSV 导出/导入 round-trip 覆盖
- ✅ 单元测试补充 `disableAiWrite` 导入导出保留校验

### 8.2 P3/P4 本轮已完成（2026-05-24）

- ✅ Rust 后端新增 `src-tauri/src/session/import.rs`
- ✅ Tauri 注册 `import_putty_sessions` / `import_wsl_sessions` / `import_external_bash_sessions` / `scan_local_session_files`
- ✅ `ipc.ts` 新增 typed invoke 包装与 `LocalSessionFile` 类型
- ✅ PuTTY 注册表导入已接入 SessionTree 第三方导入菜单
- ✅ WSL sessions 系统扫描导入已接入 SessionTree 第三方导入菜单
- ✅ External Bash sessions 系统扫描导入已接入 SessionTree 第三方导入菜单
- ✅ LocalShell 会话支持 `localShellPath` / `localShellArgs` 导入导出保留
- ✅ 打开已保存 LocalShell 会话时会从 `options_json` 恢复 shell 路径与启动参数
- ✅ Xshell `.xsh` INI 文件导入已实现
- ✅ Xshell ZIP 压缩包批量导入已实现，支持 stored/deflate ZIP 条目并保留 ZIP 内目录结构
- ✅ Xshell 本地配置扫描 `%APPDATA%\NetSarang\Xshell\Sessions` 已实现
- ✅ Tabby `config.yaml` 文件导入已实现
- ✅ Tabby Windows/macOS/Linux 默认配置路径扫描已实现
- ✅ WindTerm `user.sessions` JSON 文件导入已实现
- ✅ WindTerm 常见 profile 路径扫描已实现
- ✅ iTerm2 Dynamic Profiles JSON/XML plist 文件导入已实现
- ✅ iTerm2 binary plist 文件通过 Rust `plist` 转 XML 后导入已实现
- ✅ iTerm2 本地 DynamicProfiles 目录扫描已实现
- ✅ Terminal.app XML plist 文件导入已实现
- ✅ Terminal.app 二进制 `.terminal` / plist 文件通过 Rust `plist` 转 XML 后导入已实现
- ✅ Terminal.app 本地偏好通过 `plutil` 转 XML 后导入已实现
- ✅ Termius 已接入导出指引、OpenSSH config 文件导入、默认导出路径探测
- ✅ PuTTYCM XML 文件导入已实现
- ✅ SuperPuTTY XML/settings 文件导入已实现
- ✅ mRemote/mRemoteNG XML 文件导入已实现
- ✅ mRemoteNG 本地 `confCons.xml` 扫描已实现
- ✅ SecureCRT `.ini` 文件导入已实现
- ✅ SecureCRT 本地 Sessions 目录扫描已实现
- ✅ RDM `.rdm`/XML 文件导入已实现
- ✅ Exceed XML、INI/key-value、SSH 命令型文本配置导入已实现
- ✅ SessionTree 第三方导入入口已统一使用导入预览确认框
- ✅ 单元测试覆盖 Xshell / Xshell ZIP / Tabby / WindTerm / iTerm2 / XML / Exceed / SecureCRT / LocalShell 参数 round-trip

### 8.3 后续运维类事项（不再作为功能验收阻塞）

- ✅ Termius 加密本地数据库不直接读取：按设计采用 CLI `termius export-ssh-config` 引导与 OpenSSH config 导入，避免绕过系统凭据链。
- ✅ Exceed 已覆盖 XML、INI/key-value、SSH 命令型文本配置；如未来拿到新的二进制专有样本，可追加专项适配。
