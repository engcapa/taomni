# Taomni 模块化拆分设计文档：核心默认安装，其它模块独立打包发布（P1 真插件 + 模块商店）

- 文档版本：v1.2（设计稿，非实现记录）
- 修订记录：v1.2（2026-11-14 20:28）——第 3 项确认：截图入口、备份放核心，MFA、nettools 做插件，理解正确；§13.2 待确认解释清零。
- 修订记录：v1.1（2026-11-14 20:22）——第 5 项澄清：第 5 项“两种类”指客户端与服务端两类，RDP / VNC 拆为客户端插件与服务端插件共 4 个，插件总数 10→12；第 4 项确认：本地语音 / 模型二进制排除在 Tao Agent“全部”之外，理解正确；LanChat 标注为暂定插件，后续可能移除（§4.11）。
- 日期：2026-11-14（北京时间）
- 对象仓库：`engcapa/taomni`，本地克隆 `~/workspace/taomni`，`main` 分支，HEAD `8233beaca`（Merge PR #808），`package.json` 版本 `0.5.9`
- 落点：本仓库 `docs-feature/taomni-modular-split-design.md`（v1.2，随同补 ADR `claudedocs/adr-taomni-modular-split.md`）
- 目标读者：Taomni 维护者 / 实现者 / 评审者
- 状态：§13 全部 5 项已由用户决策并全部确认（2026-11-14 18:22 决策，20:22 澄清第 4、5 项与 LanChat，20:28 确认第 3 项）；§13.2 待确认解释已清零；其余待确认项见 §13.3。可进 P1 实现评审。

> 一句话：Taomni 从“一个安装包打全部功能”改成“核心默认安装 + 插件独立打包发布”。第一版不做 P0 多 profile 打包的过渡态，直接做 P1 真插件 + 模块商店；首批就是全部非核心模块，一起发布。

## 0. 决策摘要（先看这页）

### 0.1 要做什么

1. **核心默认安装**：用户下载安装后即得的包只含 §3 的核心。核心离线可用，不依赖任何插件；插件未安装时，核心不崩、不丢数据、不留坏 tab，只显示“去模块商店安装”。
2. **插件独立打包发布**：§4 的每一个插件都有自己的 id、版本号、Release asset、签名，可独立下载、安装、启用 / 禁用、卸载、回滚，不用重装核心，不用等核心发版。
3. **模块商店是第一版的一部分**：不是事后补的下载页。商店在应用内（设置 / 欢迎页入口），负责浏览、兼容性检查、下载、验签、安装、启用 / 禁用、卸载、回滚。
4. **同 monorepo，不同 artifact**：第一版不拆多仓库。代码仍在同一个 `engcapa/taomni` 仓库里开发、评审、跑 CI；发布时每个插件单独出包。拆仓库是以后可选的组织决策，不是 P1 的前置条件。

### 0.2 核心边界（用户已决策，见 §13）

| 决策 | 内容 |
|---|---|
| 核心 = A + 全部 session 类型 + workspace | A 是窄核心（终端 + SFTP + Tao 轻聊，见 §3.1）；再加全部 session 类型（除 VNC / RDP 外，24 种，完整客户端实现留核心，读法 B）；再加 workspace（Workspace-first 主壳 + Code Workspace 全量，含 LSP / DAP / Git / Build-Run-Debug / Java 结构化搜索 5 个重型子项） |
| Tao Agent 全部进核心 | `agent/` + MCP + ACP / Claude Code / Codex 桥接 + chat + LLM 路由 + 工作流，全部留核心，不拆插件 |
| 截图入口、备份进核心 | 截图入口（触发、浮动工具条入口、热键注册）与备份 / 恢复留核心；截图 OCR / 录制编码引擎做插件（§3.8 的拆分口径） |
| MFA、nettools 做插件 | 第 3 项其余两项（MFA、nettools）做插件（解释口径，见 §13.2） |
| RDP、VNC 做插件，客户端与服务端两类 | RDP 客户端、VNC 客户端、RDP 服务端、VNC 服务端都做插件；分两类：客户端类（`plugin-rdp-client`、`plugin-vnc-client`）与服务端类（`plugin-rdp-server`、`plugin-vnc-server`），共 4 个插件。客户端与服务端不再合一个插件，各自只链接自己需要的引擎（RDP 客户端用 IronRDP 客户端件、服务端用 ironrdp-server；VNC 客户端用 RFB + OpenSSL、服务端监督系统 VNC daemon） |
| 第一版 = P1 | 不做 P0 多 profile 打包过渡态；第一版直接交付插件运行时 + 模块商店 + 全部非核心插件 |
| 首批 = 全部非核心模块 | 不是先试点 2–3 个；§4 的 12 个插件第一版一起迁移、一起发布，内部仍分批做（§10）；LanChat 是暂定插件，后续可能移除（§4.11） |

### 0.3 不做什么（冻结边界）

| 冻结项 | 具体含义 | 违反的后果 |
|---|---|---|
| 现有会话数据不丢 | `taomni.db` 里的会话、分组、隧道、历史，迁移时由各模块做一次性迁移，不静默丢弃，不改用户已保存的 `session_type` 取值 | 老用户升级后会话打不开 |
| 现有 Tao 首页设计不动 | PR #806 已合入的 Tao Home 设计（`docs-feature/tao-home-design.md` v1.3）是核心的一部分；模块化不得改 Tao 的问 / 做 / 深研三档与 DeepSeek VIP 轨道 | 两份设计打架 |
| 现有安全策略不降级 | Vault 加密、确认制、redaction、SSH 已知缺口（`check_server_key` 接受所有 key，无 known-hosts/TOFU）与内置 SSH 服务器 SFTP `rootDir` 非沙箱，这两处缺口在模块化中不扩大、不掩盖（见 §9） | 特权插件 + 旧缺口叠加成真风险 |
| 不改成 SaaS | 不引入 Taomni 运营的账号、强制云端后端、强制登录下载插件；模块商店的下载源默认是 GitHub Release，可离线安装本地插件包 | 违背 local-first 定位（roadmap 非目标） |
| 不把每个模块做成独立进程 | 只有特权 / 重型模块（§5.5）才走独立进程（sidecar）；普通插件是进程内 Tauri 插件，不为隔离而付全量进程成本 | 启动慢、调试难、IPC 全量重写 |

### 0.4 成功标准（验收口径）

- 核心-only 安装可启动、可建 24 种 session、可开终端 / SFTP / 数据库 / 邮件 / 工作区、可跑 Tao Agent；未装插件的入口（RDP / VNC / Servers / SocksCap / LanChat / MFA / nettools / 截图 OCR / 本地语音）点开时是“未安装，去商店安装”，不是白屏、不是崩溃、不是静默无反应。
- 每个插件可独立安装、启用、禁用、卸载、回滚到上一版本；卸载后核心正常，插件自己的数据按 §8 处理（默认保留数据、显式删除才清）。
- 核心与插件可独立发版：只改一个插件时，只发该插件的新包 + 新的 `modules.json`，不重发核心包；核心发版时不强制重发全部插件，只在 `coreApiVersion` 大版本变化时才要求插件适配。
- 全部回归用例通过：核心-only 回归 + 全量回归两套都过；`pnpm check:refactor` 通过；新增文件遵守 800 行上限（AGENTS.md）。
- 体积基线先实测再报数：本文不承诺“核心瘦 X MB”，因为仓库里没有已发布安装包的体积基线（§1.4）；P1 第一项工作就是实测三端基线，之后每批迁移都报增量。

---

## 1. 现状分析：为什么现在是一个单体

本节全部取自本地 main `8233beaca`（Merge PR #808，开 PR 前由 `8b0c8f6e8` 更新）的实测，不是推测；锚点已在新 HEAD 上复核（`SessionType` 26 种、`TabKind` 22 种、`package.json` 0.5.9 均未变）。

### 1.1 一个版本、一个包、一个更新清单

- 版本唯一入口是根 `package.json`（0.5.9）；`src-tauri/Cargo.toml` 的 0.3.0 只是 crate 元数据，不是发版号。
- `src-tauri/tauri.conf.json` 是 `bundle targets: all`、`createUpdaterArtifacts: true`；更新只认 GitHub Release 里唯一的 `latest.json`，由 `scripts/compose-updater-manifest.mjs` 汇总（见 `claudedocs/auto-update-plan.md`）。
- 发布是 `.github/workflows/release.yml`（tag `v*` 触发，Linux / Windows 矩阵 + macOS 双架构），产物是整包，没有“模块包”的概念，也没有模块清单。

### 1.2 一个 Rust 入口、一个全局状态

- `src-tauri/src/lib.rs` 591 行，`src-tauri/src/commands/mod.rs` 809 行挂了 50 多个子模块，`AppState`（`src-tauri/src/state.rs:77`）里同时装着 `tunnels、sockscap、servers、mail、lanchat、database、agent、remote_desktop、workspace、terminal` 等全部运行时。
- 删一个功能不是删一个文件，是改全局状态、改 `invoke_handler`、改 `AppState` 构造、改前端静态 import，四处联动。

### 1.3 前端是静态全量引入

- `src/layouts/main/TabContentRouter.tsx` 直接 `import` 了 `CodeWorkspaceTab、MailClientTab、MailUnifiedTab、LanChatGate、ServersPanel、SocksCapPanel` 等，没有 `React.lazy`。用户一次没打开过邮件、编辑器，代码也已经打进 `dist`。
- `src/components/editor/` 一个目录就 1,167 个文件、约 12MB 源码；mail 98 个、database 85 个、settings 81 个、terminal 69 个、git 69 个、screenshot 51 个文件。

### 1.4 规模与体积驱动（实测数）

- 规模：本地克隆 7,025 个文件，约 143 MB；`src/` 2,893 个文件，`src-tauri/` 2,078 个文件；Rust 约 324,633 行。
- Rust 行数前几名：mail 26,697 行、sockscap 24,839 行、servers 23,256 行、screenshot 21,995 行、agent 21,759 行、hbase 21,090 行、lsp 16,724 行、rdp 14,841 行、database 13,228 行、vnc 12,838 行、mobile 10,455 行、backup 10,357 行、lanchat 9,341 行、terminal 8,995 行。
- 体积驱动不是业务代码，是重型原生依赖：IronRDP 全特性 + 自改 vendor、vendored OpenSSL（VNC TLS）、`sherpa-onnx` + `whisper-rs`（默认特性就开着）、`openh264`、多数据库驱动（`sqlx-mysql / postgres + oracle + tiberius + thrift + zookeeper + cross-krb5`）、编译 C 代码的 `tree-sitter-java`、`rmcp / axum`、`xcap / cpal`，前端还有 `tesseract.js + chi_sim / eng` 语言包、`mermaid、konva、CodeMirror` 13 种语言、`xterm-webgl、yjs`。这些是静态链接 / 打包进来的，功能不用也占体积。
- **缺口**：仓库里没有已发布安装包的体积基线，本文不编造“核心瘦多少 MB”。P1 第一项工作（§10 M0）是实测 Win / macOS / Linux 三端现包体积、解压后二进制、`dist` 各 chunk，再按插件逐个报增量。

### 1.5 已有拆分先例（可复用，别重造）

- **编译期开关已有**：`Cargo.toml [features]` 已有 `asr-whisper、asr-sherpa、native-av、local-llm-fim、vulkan-detect、screen-capture、hbase-kerberos` 等；默认开的是 `hbase-kerberos、rdp-server-audio、voice-capture、asr-whisper、asr-sherpa`；Linux 发布还单独加 `--features native-av`。也就是说“编译开关”有了，“安装时可选”没有。P1 的工作是把编译期 feature 升级成安装期插件，不是重写依赖。
- **数据层已有分库先例**：`notes.db、lanchat.sqlite、mail-cache/、vault.db` 已经是分开的，只有 `taomni.db` 是全混在一起。§8 按这个先例继续分，不另起新范式。
- **边界检查已有**：`pnpm check:refactor`（`scripts/refactor-contracts.mjs + refactor-boundaries.mjs + source-file-size.mjs`）已经在检查模块边界与文件大小；P1 把插件边界加进这套检查，而不是另起一套 lint。

### 1.6 关键概念：session 类型 ≠ 客户端实现（本设计的分界依据）

- `SessionType` 是 `src-tauri/src/session/models.rs:27` 的枚举，共 26 种（见 §3.3 全表）。
- `TabKind` 是 `src/types/index.ts:9` 的 22 种 tab。
- 两者映射在 `src/lib/welcomeSessionResume.ts` 的 `primaryViewTypeForEntry` 与 `ELIGIBLE_SAVED_SESSION_TYPES`（25 种可恢复，Browser 不可恢复）。
- 一个 session 类型要“能用”，需要三层：会话记录（建 / 改 / 删 / 导入）、会话管理（树、分组、Vault 密码、跳转）、客户端实现（打开 tab 后的协议 + UI）。用户选的是读法 B：**24 种的客户端实现全部留核心**，不是只留记录（§13.1）。这个选择直接决定了 §3 与 §4 的分界，也决定了瘦身上限（见 §1.7）。

### 1.7 按读法 B，瘦身效果的诚实预告

- 核心还要背：数据库全套驱动、邮件全套、HBase、对象存储、编辑器 + LSP + DAP + Git + 构建链、Tao Agent 全套。
- 能瘦掉的只有：RDP / VNC（IronRDP + OpenSSL + RFB）、剩余 servers、SocksCap（WinDivert / xray-core）、LanChat 音视频、本地语音 / 模型（Whisper / Sherpa / llama.cpp）、截图 OCR 语言包与编码器、MFA、nettools、mobile。
- 仍有收益，但不是“核心只剩终端”那种瘦法。这是用户用“开箱即用”换来的 trade-off，本文不掩盖，评审时请按这个口径对预期。

---

## 2. 目标、原则、非目标

### 2.1 目标

1. 核心默认安装、离线可用、不依赖任何插件。
2. 每个插件独立版本、独立发布、独立下载安装、独立回滚；核心只声明它兼容的 `coreApiVersion`，不锁死插件小版本。
3. 插件卸载 / 禁用后核心不崩、不丢数据、不留坏 tab。
4. 第一版就交付插件运行时 + 模块商店 + 全部非核心插件，不留“以后再补商店”的尾巴。

### 2.2 原则

- **核心只通过三样东西跟插件说话**：模块清单（`module.json`）、带命名空间的 IPC（`plugin:<id>:<cmd>`）、核心提供的共享服务（会话、Vault、设置、更新、i18n、Tao Agent 工具总线）。不允许插件之间互相直调、私自读对方的库、私自读对方的数据库文件。
- **插件之间不依赖**：只允许依赖核心。RDP 插件不依赖 VNC 插件，LanChat 不依赖 Mail，以此类推。共用能力下沉到核心或抽成共享库，不搞插件间依赖图。
- **签名与更新复用现有链路**：同一个 minisign 密钥、同一个 `latest.json` 思路，再加一个 `modules.json`；不绕过签名校验，不自行执行未验证的安装包。
- **数据归属清晰**：每个插件自己建库 / 目录，`taomni.db` 只留会话、设置这类核心表（§8）。
- **失败是显式的**：插件缺失、版本不兼容、签名失败、下载中断，全部有明确 UI 与错误码，不静默、不白屏、不假装成功。

### 2.3 非目标

- 不改成 SaaS、不引入强制账号、不强制登录下载插件。
- 第一版不拆多仓库、不把每个模块做成独立进程（只有 §5.5 的特权 / 重型模块走 sidecar）。
- 不做可视化插件编排器、不做用户自定义工作流商店；模块商店只卖“官方插件”，不做第三方插件市场（第三方市场是以后可选的扩展，P1 不做，见 §13.3）。
- 不重写 Tao Home（PR #806 已合入）、不重写会话存储、不重写 Vault。

---

## 3. 核心清单（减法结果：留在默认安装包里的全部）

本节是减法总表：从 main 全量出发，逐项判留核心还是做插件。凡是 §3 列出的，都在核心包里；凡是不在 §3 的，都在 §4 的插件清单里，没有第三类。

### 3.1 核心底座（共享服务，全部留核心）

| 核心底座 | 代码位置 | 说明 |
|---|---|---|
| 应用壳 / 窗口 / tab / 侧栏 | `src/App.tsx、src/layouts/main/MainLayoutView.tsx、src/layouts/main/TabContentRouter.tsx、src/components/tabbar/、src/components/sidebar/、src/components/window/` | 含标签分离到独立窗口、WebView 恢复、紧凑 UI |
| 会话管理 | `src-tauri/src/session/`（3,772 行）、`src/components/session/`（48 个文件）、`src/stores/sessionStore.ts、src/lib/sessionImportExport/` | 会话树、分组、SessionEditor、QuickConnect、导入导出（PuTTY / WSL / Tabby / OpenSSH / MobaXterm / Xshell / ZeroOmega）、欢迎页恢复 |
| Vault 与密钥 | `src-tauri/src/vault/`（1,230 行）、`src/components/vault/` | argon2 + aes-gcm + 系统 keyring；凭据只存 Vault 引用，不存明文 |
| 设置与 i18n | `src/components/settings/`（81 个文件）、`src/lib/i18n/` | 含工作区工具链设置（§11.2 多版本 SDK） |
| 更新 | `src/lib/updateService.ts、src/stores/updateStore.ts、src-tauri/src/update.rs、src-tauri/tauri.conf.json`（updater endpoint + minisign 公钥） | 核心更新仍走 `latest.json`；插件更新走 `modules.json`（§7） |
| 备份 / 恢复 | `src-tauri/src/backup/`（10,357 行）、`src/stores/backupStore.ts` | 用户已决策进核心（§13）；含 MFA 数据在备份中的处理（MFA 本体是插件，备份时只备份其数据文件，不备份其代码） |
| 欢迎页 | `src/components/welcome/` | 含模块商店入口（§6） |

### 3.2 A 窄核心：终端 + SFTP + Tao 轻聊

| 项 | 代码位置 | 说明 |
|---|---|---|
| 本地终端 | `src-tauri/src/terminal/`（8,995 行）、`src/components/terminal/`（69 个文件） | 本地 PTY（`portable-pty`）、分屏、MultiExec、宏、录制、zmodem、终端外观、OSC 7 |
| SSH 终端 | 同上，`russh` 后端 | 含跳板、代理、keep-alive；已知缺口：`check_server_key` 接受所有 key，无 known-hosts/TOFU，模块化中不扩大（§9） |
| SFTP / 文件浏览 | `src-tauri/src/filebrowser/`（5,195 行）、`src/components/filebrowser/`（38 个文件）、`src/components/explorer/`（38 个文件） | `russh-sftp`、双面板、传输队列、同步；本地 File 会话也走这套文件浏览 |
| 隧道 | `src-tauri/src/tunnel/`（1,085 行）、`src/components/tunnel/` | SSH 本地 / 远程 / 动态转发；是终端的附属，留核心 |
| Tao 轻聊 | `src/components/chat/、src/components/tao/、src/stores/chat/` + Tao Home（PR #806） | 首页 Tao 的问 / 做 / 深研三档、DeepSeek 全家桶 VIP 轨道；Tao Agent 重型部分见 §3.7，不是只留轻聊 |

### 3.3 全部 session 类型（读法 B，24 种完整客户端留核心）

`SessionType` 全 26 种，除 RDP、VNC 外的 24 种，完整客户端实现（协议 + UI + tab）全部留核心。映射以 `src/lib/welcomeSessionResume.ts:primaryViewTypeForEntry` 为准。

**终端类，开 `terminal` tab（8 种）：**

| session_type | 默认端口 | 说明 |
|---|---|---|
| SSH | 22 | 核心终端主入口 |
| Telnet | 23 | 终端类，连接命令警告（`CLIENT_WARNING_TYPES`） |
| Rlogin | 513 | 终端类 |
| LocalShell | 0 | 本地 shell，含 WSL 变体（`wsl.exe`，`src-tauri/src/wsl/` 169 行） |
| Serial | 0 | 终端类，串口设备 + 波特率在 `options_json` |
| Mosh | 60001 | 终端类，UDP 漫游 |
| FTP | 21 | 终端类（`TERMINAL_TYPES` 含 FTP），不是文件浏览器 tab |
| Browser | 0 | 开 URL，无后端，最轻；不可恢复（不在 `ELIGIBLE_SAVED_SESSION_TYPES` 里） |

**文件类（2 种）：**

| session_type | 开 tab | 说明 |
|---|---|---|
| SFTP | `sftp` | 见 §3.2 |
| File | `file-browser` | 本地文件浏览，`fileEmbedInTab / fileExtraArgs` 在 `options_json` |

**代理类（1 种）：**

| session_type | 开 tab | 说明 |
|---|---|---|
| Proxy | `proxy-test` | 会话记录与配置留核心；连通性测试 UI 的实现归属见 §4（`plugin-nettools`）——点开 Proxy 会话的测试页时若插件未装，显示安装提示，会话本身不受影响 |

**数据库类，开 `database` / `redis` tab（10 种）：**

| session_type | 开 tab | 代码 / 依赖 |
|---|---|---|
| MySQL | `database` | `src-tauri/src/database/`（13,228 行）+ `sqlx-mysql` |
| PostgreSQL | `database` | 同上 + `sqlx-postgres` |
| PanWeiDB | `database` | 同上 + `tokio-opengauss`（openGauss） |
| Oracle | `database` | 同上 + `oracle` / ODPI-C |
| SQLServer | `database` | 同上 + `tiberius` |
| StarRocks | `database` | 同上 + `sqlx-mysql` 方言 |
| ClickHouse | `database` | 同上 + `clickhouse-rs`（HTTP） |
| Presto | `database` | 同上 |
| Redis | `redis` | 同上 + `redis-rs` |
| HBaseShell | `database`（`primaryViewTypeForEntry` 回 `database`；`TabKind` 另有 `hbase-shell`） | `src-tauri/src/hbase/`（21,090 行）+ `thrift / zookeeper / prost / cross-krb5`；最重的一组，仍按用户决策留核心 |

数据库共用：查询工作区、流式结果、Query Library 与草稿持久化、结果网格、SQL 补全与危险语句检查，全部留核心。

**邮件类（1 种）：**

| session_type | 开 tab | 代码 / 依赖 |
|---|---|---|
| Mail | `mail` / `mail-unified` | `src-tauri/src/mail/`（26,697 行）+ `imap / lettre / mail-parser`；前端 `src/components/mail/` 98 个文件；数据已独立（`mail-cache/`，见 §8） |

**对象存储类（2 种）：**

| session_type | 开 tab | 代码 / 依赖 |
|---|---|---|
| S3 | `object-storage` | `src-tauri/src/objectstorage/`（4,157 行）+ `rusty-s3` |
| AzureBlob | `object-storage` | 同上 + Azure Blob SDK |

### 3.4 Workspace（全部留核心，含 5 个重型子项）

分两层：

**（a）Workspace-first 主壳，留核心。** `src/components/workspace/`（42 个文件）：`WorkspaceMainPanel、WorkspaceSidebar、WorkspaceSwitcher、WorkspaceBottomDock、WorkspaceSessionPane、WorkspaceSessionPickerModal、WorkspaceGitPanel`（壳内 Git 面板是 Code Workspace Git 的壳入口，实现见下），主导航 5 大模式、Ctrl+K 命令面板、右栏收纳。`src/stores/workspacePlatformStore.ts、workspaceEditorHostStore.ts、workspaceEditorStore.ts、workspaceUiStore.ts`。拆了它等于拆主界面，不可插件化。

**（b）Code Workspace，全量留核心。** `src/components/editor/`（1,167 个文件）+ Rust `workspace/`（5,844 行）、`workspace_fs.rs、workspace_search.rs、workspace_execution/`（4,339 行）、`workspace_tooling/`（1,090 行）。用户已决策 5 个重型子项全部留核心：

| 子项 | 代码 | 说明 |
|---|---|---|
| LSP | `src-tauri/src/lsp/`（16,724 行）+ Java 运行时 / 源码索引 | 补全、诊断、跳转、重构、语义 token；LSP 服务器本身是外部进程，核心只留客户端与会话管理 |
| DAP | `src-tauri/src/dap/`（1,282 行）+ Debug 面板 | 调试适配器协议客户端，适配器本身是外部进程 |
| Git | `src-tauri/src/git/`（2,658 行）+ 前端 `src/components/git/`（69 个文件）+ `WorkspaceGitManager` | 多仓库 Changes、diff、分支、worktree；Git 二进制是外部依赖，核心只留调用层 |
| Build / Run / Debug 执行 | `workspace_execution/`（cargo / cmake / dotnet / go / jvm / node / python / swift）+ `workspace_tooling/`（gradle / maven）+ Build / Problems 面板 | 结构化执行目标与工具配置；工具链本身是外部安装，核心只留发现与编排 |
| Java 结构化搜索 | `src-tauri/src/structural_search/`（1,728 行）+ `tree-sitter-java`（编译 C 代码） | ED-PARITY-009；语法编译进核心二进制，P1 不拆 |

轻量部分当然也留核心：文件树 / 多根目录、CodeMirror 编辑器宿主、文件打开保存编码、Find in Files、大纲、面包屑、分组 / 标签、本地历史、模板。

### 3.5 Tao Agent（全部留核心）

用户已决策：Tao Agent 全部进核心，不拆插件。

| 部分 | 代码 | 说明 |
|---|---|---|
| Agent 运行时与工具 | `src-tauri/src/agent/`（21,759 行） | 工具循环、MCP 工具、会话绑定、redaction、审计；工具调用次数不限、每轮总 token 预算默认 10M（Tao 设计 §9.4） |
| LLM 路由与 Provider | `src-tauri/src/llm/`（4,966 行）、`src-tauri/src/ai/`（2,739 行）、`src-tauri/src/models/` | 云端 / 本地 provider 路由、模型目录快照（`resources/model-catalog.snapshot.json`） |
| Chat | `src-tauri/src/chat/`（5,988 行）、`src/components/chat/`、`src/stores/chat/` | ChatDrawer、Tao Home、线程模型 |
| ACP / Claude Code / Codex 桥接 | `src-tauri/src/agent/cc_bridge/`、`src/components/agent/`、`src/components/agents/` | 本地进程桥接，`rmcp / axum` MCP HTTP 服务器 |
| 工作流 | Tao 设计 §9.4 内置工作流（深研、代码 review、SQL 排查、故障排查、文件整理） | 内置、不让用户配置，随核心发版 |
| Web 搜索 | `src-tauri/src/llm/` 内搜索 provider 矩阵 | 搜索是数据外发，遵守 §9 的 egress allowlist |

**口径说明（重要）**：本地语音 / 本地模型二进制（`whisper-rs、sherpa-onnx、llama-cpp-2、cpal`）**不**算 Tao Agent 本体，仍归 §4 的 `plugin-ai-voice-local`。Tao Agent 核心通过“语音能力接口”调用它们，插件未装时语音输入不可用、显示安装提示，文字聊天与 Agent 不受影响。（2026-11-14 20:22 用户已确认此理解正确。）

### 3.6 Tao Notes（留核心）

`src-tauri/src/notes/`（2,008 行）+ 前端 `src/components/notes/`（28 个文件），数据已独立（`notes.db`）。是 Tao 检索的本地资料来源之一，体积小，留核心比拆出去划算。

### 3.7 截图入口（留核心）与备份（留核心）

- **截图入口留核心**：热键注册、菜单入口、浮动工具条（`FloatingToolbar`）触发、截图 Overlay 入口。入口本身不带 OCR 引擎、不带录制编码器；点开 OCR / 录制功能时若插件未装，显示安装提示（实现见 §4.6）。
- **备份 / 恢复留核心**：`src-tauri/src/backup/`（10,357 行）。备份范围含核心数据 + 各插件的数据文件（只备份数据，不备份插件代码）；恢复时若某插件未装，先恢复其数据文件、提示安装插件，不报错、不丢数据。

### 3.8 其它留核心的

- 本地文件资源管理器（原型 v1，`src/components/explorer/`）与 File 会话共用同一套文件浏览，留核心。
- 终端补全与命令重写（AI 子系统 §14.2）、Web Search Provider 矩阵（§14.5）随 Tao Agent 留核心。
- 多选会话连接、上下文菜单容错、双语 UI、标签分离、SSH MFA 弹窗（`MfaPrompt`，注意：MFA 弹窗是 SSH 登录流程的一部分，留核心；MFA 验证器本体是插件，见 §4（`plugin-mfa`）——两者不要混淆）。

---

## 4. 插件清单（首批：全部非核心模块）

首批 = §3 之外的全部。共 12 个插件（按 id 排序；其中 RDP / VNC 按客户端与服务端两类拆为 4 个，见 §0.2）。每个插件一行：id、名称、代码位置、体积驱动、数据归属、依赖核心的服务。

| # | 插件 id | 名称 | 代码位置（现状） | 体积驱动 / 说明 | 数据归属 |
|---|---|---|---|---|---|
| 1 | `taomni-plugin-rdp-client` | RDP 客户端 | Rust `src-tauri/src/rdp/`（14,841 行）+ 前端 `src/components/rdp/`（10 个文件） | IronRDP 全特性 + vendor patch；客户端类（`kind: remote-client`），只链接客户端件 | `rdp-client` 自有表 / 文件（新库，见 §8）；会话记录仍在核心 `taomni.db` |
| 2 | `taomni-plugin-vnc-client` | VNC 客户端 | Rust `src-tauri/src/vnc/`（12,838 行）+ 前端 `src/components/vnc/`（26 个文件） | 自研 RFB + vendored OpenSSL（匿名 TLS）；客户端类，只链接客户端件 | 同上 |
| 3 | `taomni-plugin-rdp-server` | RDP 服务端 | 服务端 `src-tauri/src/servers/rdp.rs、src-tauri/src/servers/rdp/` | IronRDP server（`ironrdp-server`，含 EGFX）；服务端类（`kind: local-server`），走 sidecar（§5.5），只链接服务端件 | 服务端自有库；RDP 审批与 tab 锁随服务端插件走（§12） |
| 4 | `taomni-plugin-vnc-server` | VNC 服务端 | 服务端 `src-tauri/src/servers/vnc.rs`（监督系统 VNC daemon，不是自研引擎） | 服务端类；监督外部 VNC daemon，不自带提权路径 | 同上 |
| 5 | `taomni-plugin-servers` | 本地服务器（除 RDP / VNC 外） | Rust `src-tauri/src/servers/`（23,256 行，扣除已划给 RDP / VNC 服务端的 `rdp*、vnc.rs` 后剩余）+ 前端 `src/components/servers/`（23 个文件） | 内置 SSH / SFTP / HTTP / FTP / TFTP / NFS / Telnet / iperf / cron；特权面大，见 §5.5 | `servers.db`（现状 `src-tauri/src/servers/db.rs`，迁移为插件自有库） |
| 6 | `taomni-plugin-sockscap` | SocksCap | Rust `src-tauri/src/sockscap/`（24,839 行）+ 前端 `src/components/sockscap/`（35 个文件）+ `src-tauri/resources/sockscap/` + 提权 helper（`src/bin/sockscap-helper/`） | WinDivert / xray-core + 提权 helper；平台差异最大、风险最高 | 插件自有库；规则与捕获状态不进核心库 |
| 7 | `taomni-plugin-lanchat` | LanChat（暂定，后续可能移除，见 §4.11） | Rust `src-tauri/src/lanchat/`（9,341 行）+ 前端 `src/components/lanchat/`（24 个文件） | mDNS 发现、P2P、原生音视频（Opus / H.264，`native-av` feature 默认关闭）；文字消息与音视频再拆子选项（§4.5） | 已独立：`lanchat.sqlite`，直接划归插件，不迁移 |
| 8 | `taomni-plugin-screenshot` | 截图 OCR / 录制 | Rust `src-tauri/src/screenshot/`（21,995 行）+ 前端 `src/components/screenshot/`（51 个文件） | `tesseract.js + chi_sim / eng` 语言包 + `openh264 / mp4 / gif` 编码器；入口留核心（§3.7），引擎做插件 | 截图文件仍在用户指定的持久目录，不随插件卸载删除 |
| 9 | `taomni-plugin-mfa` | MFA 验证器 | Rust `src-tauri/src/mfa/`（2,268 行）+ 前端 `src/components/mfa/`（18 个文件）+ 左下角悬浮窗 | TOTP / HOTP、二维码导出、截图 / 屏幕扫描添加账户（扫描能力依赖截图插件，未装时降级为手动输入密钥） | 已独立：`mfa.db`（懒加载），直接划归插件 |
| 10 | `taomni-plugin-nettools` | 网络工具 | Rust `src-tauri/src/nettools/`（1 行占位）+ `src-tauri/src/proxy/`（473 行）+ 前端 `proxy-test` tab | 连通性测试、代理测试；Proxy 会话记录留核心（§3.3），测试 UI 做插件 | 无独立库，测试结果不持久化 |
| 11 | `taomni-plugin-ai-voice-local` | 本地语音 / 本地模型 | Rust `src-tauri/src/asr/`（2,242 行）、`src-tauri/src/voice/`（2,741 行）+ 前端 `src/components/voice/`（5 个文件）+ `whisper-rs、sherpa-onnx、llama-cpp-2、cpal` | Whisper / Sherpa 模型二进制 + llama.cpp sidecar；默认特性里就开着，拆出去是核心最容易瘦的一刀 | 模型文件在模型目录，不进数据库；ASR 配置在核心设置里只存“用哪个引擎”，不存模型 |
| 12 | `taomni-plugin-mobile` | 移动端远程控制面 | Rust `src-tauri/src/mobile/`（10,455 行）+ `mobile-web/` | 独立 Mobile Web + 实例移动服务；是另一条产物线，不跟桌面模块混版本号 | 插件自有库；移动端 Cookie / 网关配置随插件走 |

**不在插件清单里的（不要误拆）**：数据库、邮件、对象存储、Code Workspace、Tao Agent、终端、SFTP、隧道、会话管理、Vault、备份、Notes——全部在 §3，留核心。

**插件间依赖**：零。RDP 客户端不依赖 VNC 客户端，RDP 服务端不依赖 RDP 客户端（两者只共享 Cargo 依赖，不共享插件代码与数据），LanChat 不依赖 Mail，截图不依赖 MFA（MFA 添加账户时若截图插件未装，降级为手动输入，不静默失败）。

### 4.11 LanChat 暂定插件（后续可能移除）

- **状态**：`taomni-plugin-lanchat` 第一版先做成插件，但标注为暂定（`module.json` 里加 `"status": "provisional", "removalCandidate": true`），后续版本可能移除。商店详情页明确写“暂定提供，后续版本可能下线”，不让用户误以为是长期承诺。
- **设计约束（为移除留路）**：核心不得依赖 LanChat（不调用它的 IPC、不读 `lanchat.sqlite`、不把它作为 Tao 检索的必选源）；其它插件不得依赖 LanChat；LanChat 不得成为任何核心流程的必经之路。
- **移除流程**：决定移除时，先在一个版本里把 `modules.json` 中的该插件标 `deprecated: true`（商店显示“即将下线”，不再向新用户推荐，但已装用户仍可更新一次）；再下一个版本从商店下架，已装用户的本地插件包保留、仍可使用、不再更新；数据（`lanchat.sqlite`、消息与文件）不随下架删除，提供导出（按 §8 的导出格式，消息导出为可读文件），导出后再由用户显式删除。

---

## 5. 插件运行时架构（P1 核心工作）

### 5.1 模块清单 `module.json`（每个插件一份，随包发布）

```json
{
  "id": "taomni-plugin-rdp-client",
  "name": "RDP 客户端",
  "version": "0.5.9",
  "coreApiVersion": "1",
  "kind": "remote-client",
  "platforms": ["windows-x86_64", "windows-aarch64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"],
  "entry": { "rust": "libtaomni_plugin_rdp_client", "frontend": "plugin-rdp-client/index.js" },
  "tabs": [{ "kind": "rdp", "title": "RDP" }],
  "commands": ["plugin:rdp-client:connect", "plugin:rdp-client:disconnect"],
  "capabilities": ["core:window:allow-set-size", "core:clipboard:allow-read"],
  "dataDir": "plugins/taomni-plugin-rdp-client",
  "signature": { "algorithm": "minisign", "publicKey": "<与核心同一公钥>" }
}
```

字段说明：`coreApiVersion` 是兼容矩阵的键（§7.2）；`kind` 取值 `remote-client / local-server / collaboration / media / auth / nettools / ai-local / mobile`，仅用于商店分类与权限模板，不做运行时分发；`capabilities` 是 Tauri capability 的子集，插件不得自声明超出模板的权限；`dataDir` 是插件唯一可写的数据目录，核心不代写。

### 5.2 注册表与生命周期

- 发现：核心启动时扫描 `应用数据目录/plugins/<id>/module.json`，校验签名与 `coreApiVersion`，合法的进注册表，不合法的进“已禁用（原因）”列表，不静默丢弃。
- 生命周期：`installed → enabled → disabled → uninstalled`；`enabled` 才能注册 tab 与 IPC；`disabled` 保留数据、不加载代码；`uninstalled` 删代码、不删数据（除非用户显式勾“同时删除数据”）。
- 热加载：前端插件用动态 `import()` 加载，启用后不用重启；Rust 插件是进程内 Tauri 插件，启用 / 禁用需要重启应用（第一版接受这个限制，商店里明确提示“启用后重启生效”；sidecar 插件见 §5.5 可热启）。
- 缺失处理：tab 记录指向未装插件时，`TabContentRouter` 渲染“未安装”占位页（插件名、简介、去商店安装按钮），不白屏；会话记录指向未装插件的 tab 类型时，欢迎页恢复跳过该条并提示，不阻塞其它恢复。

### 5.3 前端拆分

- `TabContentRouter.tsx` 的静态 import 全部改成按插件注册表动态加载：核心 tab（terminal / sftp / database / mail / code-workspace 等）仍静态 import；插件 tab（rdp / vnc / servers / sockscap / lan-chat / mfa / proxy-test 等）走 `React.lazy + 注册表`。
- 每个插件前端是一个独立 Vite 入口（`plugin-<id>/index.js`），单独打 chunk，不进核心 `dist`；`src/stubs/` 的浏览器预览为每个插件提供桩，桌面-only 效果不得泄漏桩假设（沿用现有 `src/stubs/` 规则）。
- 共享 UI（菜单、侧栏、设置页）由核心提供插槽：插件只声明“我要在侧栏 / 设置页挂一个入口”，不直接改核心组件。

### 5.4 Rust 拆分

- 每个插件是一个 Cargo workspace 成员（`plugins/taomni-plugin-<id>/`），`crate-type = ["cdylib", "rlib"]`，核心通过 Tauri 插件机制加载，不用 `dlopen` 手写加载器（第一版）。
- `lib.rs` 的 `AppState` 拆成 `CoreState + 各插件 State`：核心 State 只留 §3.1 的共享服务；每个插件 State 由插件自己构造、自己持有，核心只存一个 `PluginRegistry: HashMap<PluginId, Box<dyn PluginState>>`。
- `commands/mod.rs` 按插件拆：核心命令留在 `commands/`，插件命令移到各插件 crate 内，命令名带命名空间（`plugin:<id>:<cmd>`），前端 `src/lib/ipc.ts` 按命名空间分文件，不再一个文件全量导出。
- `Cargo.toml [features]` 的重型默认特性改成插件 feature：`asr-whisper、asr-sherpa` 从默认里拿掉（归 `plugin-ai-voice-local`）；`native-av` 仍默认关闭（归 `plugin-lanchat` 的音视频子选项）；`hbase-kerberos` 留核心（HBase 留核心，§3.3）；`rdp-server-audio、voice-capture` 按插件归属拆（RDP 音频归 `plugin-rdp-server`，语音采集归 `plugin-ai-voice-local`）。
- 现有 `vendor/` patch（IronRDP、portable-pty 等）不动；插件 crate 复用同一 patch 表，不各自 patch 一份。

### 5.5 特权 / 重型模块走 sidecar（只有这三类）

| 插件 | 形态 | 理由 |
|---|---|---|
| `plugin-sockscap` | sidecar 独立进程 + 提权 helper | 要提权、要装驱动、要抓包；崩了不拖垮主进程，升级不用重启整个应用 |
| `plugin-servers`（SSH / SFTP / HTTP 等，不含 RDP / VNC Server） | sidecar 独立进程 | 内置服务器是长驻服务，应用退出时要独立清理 |
| `plugin-rdp-server` | sidecar 独立进程 | RDP Server 是长驻服务，输入注入与录屏权限边界单独审计；应用退出时独立清理 |
| `plugin-vnc-server` | 随被监督的系统 VNC daemon 走（不自研引擎） | 监督外部 daemon，不自带提权路径；启停随 daemon，不单独起 sidecar |
| `plugin-ai-voice-local`（llama.cpp 部分） | sidecar（已有 `llama.cpp` sidecar 前例） | 模型推理是重型进程，独立进程可独立重启、独立限流 |

其余插件（RDP / VNC 客户端、LanChat 文字、截图 OCR、MFA、nettools、mobile）进程内 Tauri 插件即可，不为隔离而付全量进程成本。

### 5.6 共享服务（核心提供，插件只调接口）

会话（读会话配置、订阅会话变化）、Vault（只给引用，不给明文）、设置（读核心设置，插件自己的设置存在自己目录）、更新（只读核心版本）、i18n（插件自带语言包，核心只给当前语言）、Tao Agent 工具总线（插件可注册工具，但要过 §9 的 scope 检查与确认制，不得绕过安全路径）。

---

## 6. 模块商店

### 6.1 入口与浏览

- 入口：设置页“模块商店” + 欢迎页“浏览模块” + 未安装占位页的“去商店安装”按钮，三处进同一商店页。
- 浏览：列表按 `kind` 分类（远程桌面 / 本地服务器 / 协作 / 媒体 / 验证 / 网络工具 / 本地 AI / 移动），每项显示名称、简介、版本、大小、兼容性（`coreApiVersion` 是否匹配当前核心）、已安装 / 未安装 / 有更新。
- 第一版只卖官方插件（§4 的 12 个），不做第三方市场、不做评分评论、不做付费。

### 6.2 安装流程

1. 用户点安装 → 商店查 `modules.json`（§7）取该插件最新兼容版本 → 显示版本、大小、权限清单（capabilities 展开成人话）、数据目录 → 用户确认。
2. 下载插件包（GitHub Release asset，断点续传，分片校验 SHA256）→ 验 minisign 签名（与核心同一公钥，失败拒绝安装并提示）→ 解压到 `plugins/<id>/` 临时目录 → 校验 `module.json`（id、版本、`coreApiVersion`）→ 原子替换（先装新目录、再换指针，失败回滚旧目录）。下载走 AGENTS.md 的外部网络规则：默认用设置里的应用代理，也支持插件独立代理或不使用代理（不绕过系统 / 环境代理）；显示连接中 / 下载中 / 校验中 / 完成 / 取消 / 失败与字节、百分比，支持取消、断点续传与后台下载，关闭对话框不取消任务，重开恢复进度；失败或取消的包不替换已装好的插件。
3. 安装完成：前端插件可立即启用；Rust 插件提示“重启后生效”，用户确认后重启（复用 `tauri-plugin-process` 的重启路径）。
4. 正在下载、安装、授权或等待重启时，重新检查不会替换当前任务；安装阶段不提供取消按钮（复用现有 updater 的取消隔离规则，见 `claudedocs/auto-update-plan.md` 客户端行为第 7–8 条）。

### 6.3 启用 / 禁用 / 卸载 / 回滚

- 启用 / 禁用：开关在商店详情页；禁用保留数据、不加载代码；特权插件（SocksCap / Servers）禁用时先停服务、清驱动 / helper 状态，再卸载代码（复用现有 `sockscap_prepare_for_update` 的清理路径）。
- 卸载：删代码、不删数据；勾选“同时删除数据”才删 `dataDir`，删前二次确认并提示不可恢复。
- 回滚：每个插件保留上一版本目录；新版本启用后 7 天内可在商店点“回滚到上一版本”，回滚只换代码，不动数据；回滚也验签。
- 离线安装：商店支持“从本地文件安装插件包（`.taomni-plugin`）”，同样验签、验 `coreApiVersion`，不绕过校验。

### 6.4 更新检查

- 商店打开时查一次 `modules.json`，有更新的插件标“有更新”；不自动下载、不自动安装。
- 核心更新（`latest.json`）与插件更新（`modules.json`）是两个独立检查，不互相阻塞；核心大版本升级（`coreApiVersion` 变化）时，商店提示哪些插件需同步更新，不强制全量更新。

---

## 7. 版本、发布、清单

### 7.1 版本策略

- 核心继续 SemVer，版本唯一入口仍是根 `package.json`。
- 每个插件独立 SemVer，版本存在各插件的 `module.json` 与 `plugins/taomni-plugin-<id>/Cargo.toml` / `package.json` 里，不跟核心锁步。
- `coreApiVersion` 是兼容矩阵的键：第一版定为 `1`；核心只在破坏插件接口时才升大版本（改 IPC 形状、改共享服务签名、改 capability 模板）；插件小版本升级不升 `coreApiVersion`。

### 7.2 清单：`latest.json`（核心）+ `modules.json`（插件）

- 核心清单不变：`latest.json` 仍是包含所有已发布平台的单一清单，由 `scripts/compose-updater-manifest.mjs` 生成（沿用现有规则：平台构建禁止各自发布局部清单）。
- 新增插件清单 `modules.json`，结构：`{ "coreApiVersion": "1", "updatedAt": "...", "plugins": { "<id>": { "version": "...", "platforms": { "<platform>-<arch>": { "url": "...", "signature": "...", "sha256": "...", "size": 123 } } } } }`。
- 生成器：扩展 `scripts/compose-updater-manifest.mjs`（或新增 `scripts/compose-modules-manifest.mjs`，二选一，评审时定），从各插件构建产物生成；同名双架构、签名原始字节不变、平台别名等回归门禁复用现有测试（`scripts/compose-updater-manifest.test.mjs` 的思路）。

### 7.3 发布流程（CI）

- `.github/workflows/release.yml` 扩展：现有核心矩阵不变；新增插件矩阵（每个插件 × 平台 × 架构），产物是插件包（`.taomni-plugin`，内含 `module.json` + Rust 插件库 + 前端 chunk + 签名），不是整包安装程序。
- 每个插件单独出 Release asset：同一 GitHub Release 里，核心包与插件包共存，但文件名、签名、清单条目各自独立，不互相覆盖（吸取 v0.4.29 macOS ARM / Intel 同名覆盖的教训，见 `claudedocs/auto-update-plan.md` 2026-10-02 一节）。
- 只改一个插件时，只发该插件的新包 + 新的 `modules.json`，不重发核心包；`modules.json` 的发布是原子操作（先传完所有插件包与签名，最后发布完整清单）。

### 7.4 兼容矩阵（第一版）

| 核心版本 | `coreApiVersion` | 插件要求 |
|---|---|---|
| 0.6.x（P1 首版，版本号评审时定） | 1 | 插件 `coreApiVersion == 1` 才能安装；`== 0` 或 `>= 2` 拒绝安装并提示 |
| 未来核心大版本 | 2（仅当破坏插件接口时） | 插件需发适配版，商店提示“需同步更新” |

---

## 8. 数据与迁移

### 8.1 分库原则（沿用已有先例）

| 数据 | 现状 | P1 归属 |
|---|---|---|
| 会话、分组、隧道、聊天元数据、查询工作区、历史 | `taomni.db` | 核心（会话记录是核心的，插件只读） |
| Notes | `notes.db` | 核心 |
| LanChat | `lanchat.sqlite` | `plugin-lanchat`（已独立，直接划归） |
| MFA | `mfa.db`（懒加载） | `plugin-mfa`（已独立，直接划归） |
| Mail 缓存 | `mail-cache/` | 核心（Mail 留核心） |
| Vault | `vault.db` | 核心（插件只拿引用） |
| Servers | `src-tauri/src/servers/db.rs` | `plugin-servers`（RDP / VNC Server 部分随 `plugin-rdp-server / plugin-vnc-server` 走，见 §4） |
| SocksCap / RDP / VNC / 截图 / nettools / 移动端 | 混在 `taomni.db` 或无独立库 | 各插件新建自有库（`plugins/<id>/data.db`），一次性迁移 |

### 8.2 迁移规则

- 每个插件自己写一次性迁移：从 `taomni.db` 的旧表读出属于自己的行，写入自己的库，写完打标，不删旧表（旧表留一个版本周期再清，给回滚留路）。
- 迁移失败时插件不启用、核心不崩，商店显示“迁移失败，数据未动”，用户可重试或卸载插件。
- 卸载插件不删数据；重装同一插件时数据还在；显式“删除数据”才清。
- 备份（核心）备份全部数据文件（核心库 + 各插件库），恢复时按 §3.7 处理。

---

## 9. 安全

- **签名**：插件包与核心包同一 minisign 密钥；公钥在 `tauri.conf.json`；轮换密钥时先规划旧客户端升级路径（沿用现有 CI 签名要求：`TAURI_SIGNING_PRIVATE_KEY` 只在 CI secrets 里）。
- **权限**：插件 capability 是核心 capability 模板的子集；插件不得自声明超出模板的权限；新增 capability 需评审，不随插件发版静默加。
- **特权边界**：SocksCap / Servers 的提权 helper、驱动、系统捕获状态，在停用 / 卸载 / 更新前必须清理（复用 `sockscap_prepare_for_update`）；RDP Server 的输入注入与录屏权限单独审计；VNC Server 监督的是系统 VNC daemon，不自带提权路径。
- **Vault**：插件只拿 `vault:` 引用，不拿明文；插件不得把凭据写进自己的日志、自己的库、自己的导出文件。
- **出口**：插件的网络出口同样走核心的代理与 allowlist；Tao Agent 的 egress allowlist（默认只放 `api.deepseek.com` 等，见 Tao 设计 §11）不因插件化而放宽。
- **已知缺口不扩大**：SSH `check_server_key` 无 known-hosts/TOFU、内置 SSH 服务器 SFTP `rootDir` 非沙箱，这两处在 P1 不修复（roadmap P2 安全闭环），但模块化不得让更多代码绕过它们（例如插件不得自己实现一个不校验的 SSH 客户端）。
- **审计**：插件安装 / 启用 / 禁用 / 卸载 / 回滚全部记审计日志（沿用 Tao 设计 §11 的 `tao_audit` 思路，落到核心审计表，不落插件库）。

---

## 10. 实施计划（P1 内部分批，第一版一起发布）

不做 P0 多 profile 打包。P1 内部分四个里程碑，M0–M3 做完才发第一版，中间不单独发版。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 基线与骨架（1–2 周） | 实测三端现包体积基线；搭插件运行时骨架（`module.json`、注册表、生命周期、IPC 命名空间、前端动态加载、capability 模板）；`AppState` 拆 `CoreState + PluginRegistry`（先拆结构，不动业务） | 基线报告（三端体积 + `dist` chunk 表）；骨架可加载一个空插件（hello-plugin）并显示在商店里 |
| M1 商店与清单（1–2 周） | 模块商店 UI + 安装 / 启用 / 禁用 / 卸载 / 回滚流程；`modules.json` 生成器；签名校验；离线安装 | 商店可安装 hello-plugin 并回滚；签名失败拒绝安装的用例通过 |
| M2 插件迁移（分批，3–5 周） | 按 §4 顺序迁移：① 最干净的 `plugin-lanchat、plugin-mfa、plugin-nettools` → ② `plugin-rdp-client、plugin-vnc-client、plugin-rdp-server、plugin-vnc-server`（服务端从 `servers/` 拆出）→ ③ `plugin-servers、plugin-sockscap`（sidecar）→ ④ `plugin-screenshot、plugin-ai-voice-local、plugin-mobile`；每批做数据迁移（§8）与 `TabContentRouter` 动态加载 | 每批：插件可独立安装 / 卸载、核心-only 回归通过、该插件回归通过 |
| M3 发布与回归（1–2 周） | `.github/workflows/release.yml` 扩展插件矩阵；`modules.json` 原子发布；核心-only + 全量两套回归；回滚演练（插件回滚 + 核心回滚互不影响） | 两套回归全过；只发一个插件包的演练通过；文档与 ADR 更新 |

工作量估算：M0–M3 约 6–11 周（单人全职等效，估算非承诺；M2 的 SocksCap 与 Servers 占大头，平台差异与提权路径是主要风险）。

**文件清单（新增 / 大改，评审时逐项对）：**

- 新增：`plugins/taomni-plugin-*/`（12 个 crate，各含 `Cargo.toml、module.json、src/lib.rs、frontend/index.*`）、`src/lib/pluginRegistry.ts、src/lib/moduleStore.ts、src/stores/moduleStore.ts、src/components/settings/ModuleStorePanel.tsx、scripts/compose-modules-manifest.mjs`（或扩展现有生成器）。
- 大改：`src-tauri/src/lib.rs`（AppState 拆分）、`src-tauri/src/state.rs`、`src-tauri/src/commands/mod.rs`（按插件拆）、`src/layouts/main/TabContentRouter.tsx`（动态加载）、`src/lib/ipc.ts`（按命名空间分文件）、`src-tauri/tauri.conf.json`（capability 模板）、`.github/workflows/release.yml`（插件矩阵）、`scripts/refactor-boundaries.mjs`（加插件边界检查）。
- 不动：`src-tauri/src/session/models.rs` 的 `SessionType` 取值（26 种不变）、`taomni.db` 的会话表结构（只新增插件自有库）、Tao Home 设计。

---

## 11. 测试与验收

- **核心-only 回归**：不装任何插件，跑现有 `qa-ui-auto-tests` 全量中核心相关的用例（终端、SFTP、数据库、邮件、工作区、Tao、备份），全部通过；未装插件的入口全部是“未安装”占位页，无白屏、无崩溃。
- **全量回归**：装全部 12 个插件，跑全量用例（含 RDP / VNC、Servers、SocksCap、LanChat、截图 OCR、MFA、nettools、本地语音、移动端），全部通过。
- **插件单测**：每个插件独立安装 / 启用 / 禁用 / 卸载 / 回滚各一遍；签名失败、版本不兼容、下载中断、迁移失败各一遍，全部有明确错误与回滚。
- **发布演练**：只发一个插件的新版本（不发核心），`modules.json` 更新后商店显示更新、安装成功、核心不受影响。
- **性能**：核心-only 启动时间与内存不比现包差（基线对比，M0 的基线报告为准）；插件启用后按插件报增量，不掩盖。

---

## 12. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| M2 一起迁 12 个插件，单批失败拖垮第一版 | 第一版延期 | M2 内部分批，每批独立验收；某批延期时该插件可暂缓进第一版，但须在 §13 修订记录里写明，不静默缩水 |
| `AppState` 拆分牵一发而动全身 | 核心回归面大 | M0 只拆结构、不动业务；每批迁移后跑核心-only 回归 |
| RDP / VNC 服务端从 `servers/` 拆出，注册表与 tab 锁（`tab_lock.rs`）耦合 | Servers tab 单实例锁失效 | 拆分时把 `tab_lock` 按插件拆，`plugin-rdp-client / plugin-vnc-client / plugin-rdp-server / plugin-vnc-server` 各自持锁，`plugin-servers` 不再持 RDP / VNC 的锁；用例覆盖 |
| SocksCap / Servers 提权路径在卸载时残留驱动 / helper | 系统状态脏、更新失败 | 复用 `sockscap_prepare_for_update` 的清理路径；卸载前先停服务、清状态，再删代码 |
| `modules.json` 与 `latest.json` 双清单不一致 | 商店显示的版本与实际包不符 | 生成器同一套门禁（同名双架构、签名原始字节不变）；发布是原子操作，先传包、最后发清单 |
| 用户误解“截图入口在核心 = 截图全在核心” | 以为 OCR 不用装插件 | 商店与占位页文案写清：入口在核心，OCR / 录制引擎是插件（§3.7） |

**回滚**：核心回滚走现有 updater 回滚（旧版本重装）；插件回滚走商店“回滚到上一版本”（§6.3）；两者互不影响。若 P1 上线后发现插件运行时有严重缺陷，可先在 `modules.json` 里下架该插件（商店不再显示），已装用户不受影响，核心不受影响。

---

## 13. 决策记录（用户已决策，待确认解释已清零）

### 13.1 已决策（2026-11-14，用户原话与本文落笔一一对应）

| # | 用户原话（2026-11-14） | 本文落笔 |
|---|---|---|
| 1 | 选读法 B | §3.3：24 种 session 类型完整客户端留核心；§1.6、§1.7 写明 trade-off |
| 2 | Workspace 的 5 个重型子项：放到核心 | §3.4：LSP、DAP、Git、Build / Run / Debug、Java 结构化搜索全部留核心 |
| 3 | 截图入口、备份：放到核心其它插件 | §3.7：截图入口、备份留核心；§4（`plugin-mfa`、`plugin-nettools`）做插件（2026-11-14 20:28 用户确认理解正确） |
| 4 | Tao Agent 全部要作为核心 | §3.5：Agent 全套留核心；本地语音 / 模型二进制仍归插件（2026-11-14 20:22 用户确认理解正确） |
| 5 | RDP 和 VNC：客户端和服务端都做插件并且是两种类插件 | §4：两类 = 客户端类与服务端类，共 4 个插件：`plugin-rdp-client、plugin-vnc-client、plugin-rdp-server、plugin-vnc-server`（2026-11-14 20:22 用户澄清） |
| — | 第一版就要求是 P1 的真插件 + 模块商店（2026-11-14 18:07） | §0.1、§5、§6：不做 P0 过渡态 |
| — | 首批试点是除第 1 点确认完成后的所有非核心模块（2026-11-14 18:07） | §4：12 个插件第一版一起发布；§10：内部分批、一起发版 |
| — | LanChat 先作成插件，后续可能移除（2026-11-14 20:22） | §4.11：暂定插件，`status: provisional`，核心不得依赖，移除前先标 deprecated、再下架、数据可导出 |

### 13.2 待确认解释

无。第 3、4、5 项的解释已全部由用户确认：第 3 项（2026-11-14 20:28）——截图入口、备份放核心，MFA、nettools 做插件；第 4 项（20:22）——本地语音 / 模型二进制排除在 Tao Agent“全部”之外；第 5 项（20:22）——“两种类”指客户端与服务端两类，已按 4 个插件落笔。

### 13.3 未决策（P1 不阻塞，评审时可定）

- 第三方插件市场做不做、什么时候做（P1 只做官方插件）。
- `modules.json` 生成器是扩展现有 `compose-updater-manifest.mjs` 还是新增 `compose-modules-manifest.mjs`。
- P1 首版核心版本号（0.6.x 还是 0.7.0）。
- 体积基线实测由谁跑、在哪台机器跑（M0 的一部分）。

### 13.4 修订记录

- v1.2（2026-11-14 20:28 确认后）：第 3 项确认理解正确，§13.2 待确认解释清零。开 PR 前基线更新至最新 main `8233beaca`（Merge PR #808），锚点复核无变化（`lib.rs` 590→591 行、`commands/mod.rs` 807→809 行）。
- v1.1（2026-11-14 20:22 澄清后）：第 5 项改按客户端 / 服务端两类，RDP / VNC 拆为 4 个插件，插件总数 10→12；第 4 项确认理解正确；新增 §4.11 LanChat 暂定插件（后续可能移除）。
- v1.0（2026-11-14 18:22 决策后）：初稿；§13 全部 5 项已决策，§13.2 三处解释待确认。

---

## 14. 参考

- 现状核查：本地 main `8233beaca`（Merge PR #808），`package.json` 0.5.9；`src-tauri/src/session/models.rs`（`SessionType` 26 种）、`src/types/index.ts:9`（`TabKind` 22 种）、`src/lib/welcomeSessionResume.ts`（映射与可恢复类型）、`src-tauri/src/state.rs:77`（`AppState`）、`src/layouts/main/TabContentRouter.tsx`（静态 import）、`src-tauri/tauri.conf.json`（bundle + updater）、`.github/workflows/release.yml`、`claudedocs/auto-update-plan.md`（更新与签名）、`DESIGN.md`（架构总览）、`roadmap.md`（2026-08-05）、`qa-ui-auto-tests/feature-list.md`（已实现功能清单）。
- 前序设计：`docs-feature/tao-home-design.md` v1.3（PR #806 已合入）+ ADR `claudedocs/adr-tao-home-deepseek-app.md`——Tao Home 与 Tao Agent 是核心的一部分，模块化不得改动。
- 行数与文件数：Rust 行数按 `find src-tauri/src -name "*.rs" | xargs wc -l` 实测；前端文件数按 `find src/components/<dir> -type f | wc -l` 实测；均截至 2026-11-14 18:22 前后，未实测已发布安装包体积（见 §1.4）。
