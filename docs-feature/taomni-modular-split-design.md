# Taomni 模块化拆分设计文档：核心默认安装，其它模块独立打包发布（P1 真插件 + 模块商店）

- 文档版本：v1.8（设计稿，非实现记录；本版在 v1.7 基础上加入 G1–G11 全门禁收口任务，修订明细见 §13.4）
- 日期：2026-11-15（北京时间；v1.4 为 2026-11-14）
- 对象仓库：`engcapa/taomni`，当前工作分支 `refactor/modules-arch`，基线 HEAD `7bc498b35`（Merge PR #813）。v1.4 的取证基线 `1d2f5748`（PR #810）之后又进入 36 个非合并提交、402 个文件（约 +41k 行），主要是全局文件打开/查看器、移动端桌面远控与飞书适配，见 §1.10。代码锚点以本版审查日实测为准（`SessionType` 26 种、当前 `TabKind` 22 种；删除 LanChat 前的历史基线为 23 种、`lib.rs` 593 行、`commands/mod.rs` 823 行、`package.json` 0.5.9）；M0 插件契约、注册表、迁移原语和 LanChat 删除已在本分支落地，后续插件批次仍按 §10.1 推进
- 落点：本仓库 `docs-feature/taomni-modular-split-design.md`（v1.6），随同 ADR `claudedocs/adr-taomni-modular-split.md`
- 目标读者：Taomni 维护者 / 实现者 / 评审者
- 状态：部分可实施。§13.1 的用户决策有效；M0 基线、契约冻结、宿主验证和共享能力下沉可立即开始，M2 插件迁移必须等待 §5.0 的 G1–G11 全部通过。v1.4 修正了过期基线、插件数量表述、核心依赖隔离遗漏、前端安全边界、数据迁移幂等性和发布例外规则，并新增 TASK-001–TASK-023、AC-001–AC-014、V-001–V-010。v1.5 按新代码更正 MFA 采集、前端 lazy 现状等结论，补充文件查看器、移动端桌面远控与 headless、re-exec 入口、插件数据密钥与备份快照、crash-regression 插件依赖等遗漏，新增 S11–S15、G11、TASK-024/025、AC-015/016、V-011。

当前分支已集成插件注册表、版本化安装、宿主监督、签名远端商店、原生下载和离线安装。共享采集与 RDP 公共库已下沉。从正式 `0.5.10` 升级的验证覆盖安装包替换和回退、签名目录自动首装及 MFA 数据迁移，其余业务数据仍记录待迁移。后续更新以模块的实际安装版本为依据，新模块由用户选装。正式首批目录、剩余业务迁出、核心依赖裁剪和发布验收按 §10.1 推进。 [实施与验收台账](taomni-modular-split-progress.md) · [基线记录](taomni-modular-split-baseline-20261115.md)

> 一句话：Taomni 从“一个安装包打全部功能”改成“核心默认安装 + 插件独立打包发布”。第一版不做 P0 多 profile 打包的过渡态，直接做 P1 真插件 + 模块商店；首发目标是全部有效非核心模块，按受控例外规则发布。

### 0.5 本版审查结论

1. **当前文档可以作为 M0 设计输入，但不能直接作为开发卡片。** 原 M0–M3 只描述里程碑，未指定任务边界、输入输出、依赖、完成条件和证据；本版在 §10.1 补成可执行任务清单。
2. **“插件进入 workspace”不等于“核心变瘦”。** 当前根 `Cargo.toml` 仍由核心 crate 持有重型依赖和默认 feature；必须先完成依赖归属、默认 feature、构建产物和 `cargo tree` 闭包验证（TASK-005/TASK-006），否则核心-only 包仍会带上插件依赖。
3. **宿主进程隔离不等于前端沙箱。** 插件前端在主 WebView 内执行，与核心前端同权；`permissions` 只约束核心转发到宿主的 RPC。P1 只支持签名的官方插件，第三方插件沙箱明确列为后续重新设计，不得在宣传或验收中宣称已有安全沙箱。
4. **首发集合采用“全量目标 + 受控例外”规则。** 11 个有效插件都必须通过对应验收才具备发布资格；只有 DEC-2 允许的 `plugin-mobile` 或 macOS G2 例外可以暂缓，并必须在 `modules.json`、发布说明和 §13.4 中明示，不得静默减少范围。
5. **DEC-3 的范围冻结为取消插件化，保留核心代理测试能力。** `proxy/`、`test_proxy_connection`、隧道管理器 `nettools` 仍被核心功能引用；本设计不删除这些核心能力。若要删除 `ProxyTestTab`，应另开产品变更任务，不能混入模块化迁移。
6. **基线已漂移，v1.4 的若干实测结论需要更正（v1.5）。** 新增核心 `viewer/`（3,165 行）、`file-viewer` tab、`taomni-preview` 自定义协议、vendored `wry`；`mobile/` 由 10,455 增至 12,679 行并新增桌面远控与飞书适配；`mfa` 的屏幕采集是自带实现，v1.4 写的“MFA 经核心 `capture/`”与源码不符；`panels.tsx` 已对 RDP/VNC 等使用 `React.lazy`，§1.3 “没有 lazy”的说法需收窄。详见 §1.10。
7. **`plugin-mobile` 的拆分成本被 v1.4 低估（v1.5）。** 它不只是终端/聊天的观察者：它还驱动核心终端与聊天（写入、resize、打开会话）、拥有 `taomni --headless` 独立入口和 `ModeLease`、桌面远控依赖 `screenshot::capture` 与 `servers::rdp::control_permission_granted`，并需要核心侧创建 WebView 窗口。S6 只覆盖观察方向；本版新增 S14/S15，并建议在 M0 末做 mobile 的 go/no-go（§4.5）。
8. **插件数据密钥与备份快照被忽略（v1.5）。** MFA 的库由核心 Vault 固定条目（`mfa.data-key-v1`）加密，并通过 `backup::snapshot_context::hot_backup_conn` 在进程内热备份；`backup::coordination::ProfileLease` 要求多实例共享 profile。“插件只持有 `vault:` 引用”和“核心读 `backupPaths` 文件”在这些路径上不成立，新增 S12/S13、TASK-024/025、AC-015/016。
9. **主二进制有多个 re-exec 入口（v1.5）。** `main.rs` 分发 `--headless`、`--ssh-stdio-forward`、`--screenshot-scroll-input`、`--sockscap-redirector-bridge`、`--vnc-special-key-hook`；VNC / SocksCap / mobile 的入口必须随插件迁出，否则核心-only 二进制仍链接插件代码（S11、G11）。
10. **crash-regression 集合已含插件依赖用例（v1.5）。** `TC-MOBILE-012/013` 需要移动端；核心-only 构建不能运行它们，也不能把缺失记为通过（§11“插件感知”规则）。

### 0.6 稳定验收 ID

下列 ID 是任务和验证的唯一追踪键；设计阶段全部为“待执行”，不表示已有实现或通过证据。

| ID | 可观察结果 |
|---|---|
| AC-001 | 核心-only 包能启动，核心 23 种核心 session、Workspace、Tao Agent、备份和设置行为保持可用；核心构建不携带已迁移插件依赖。 |
| AC-002 | 未安装或禁用插件时，入口显示带名称和安装动作的占位页；保存的 RDP/VNC/session 记录仍可查看、编辑和导入，不被隐藏或删除。 |
| AC-003 | 插件下载支持设置代理、独立代理和无代理三种模式，显示进度，支持取消、断点续传、后台任务和失败恢复。 |
| AC-004 | 核心与宿主完成版本握手、token 校验、命令和权限校验；错误、超时、取消、崩溃和重复请求均返回稳定错误码。 |
| AC-005 | 已签名的插件前端按注册表动态加载，核心 chunk 不静态包含插件页面；CSP 只增加受限插件 scheme。 |
| AC-006 | 0.5.x 数据迁移可重复执行、可中断恢复和失败回滚；`taomni.db`、独立插件库、目录与 Vault 引用均保持一致。 |
| AC-007 | 插件可独立安装、启用、禁用、卸载、保留/删除数据和回滚，核心无需重启且无残留宿主进程。 |
| AC-008 | `modules.json`、插件包、分离签名、SHA-256 和平台矩阵原子发布；只更新一个插件不重发核心。 |
| AC-009 | 官方插件的 `module.json`、路径、权限、版本和数据目录均通过校验；篡改、路径穿越、符号链接和不兼容版本被拒绝。 |
| AC-010 | 11 个有效插件逐个达到既有功能等价；插件之间零直接依赖，共享能力仅经核心服务或库 crate。 |
| AC-011 | 备份能包含已安装、禁用、未安装但仍有数据的插件数据；恢复后能提示缺失插件且不丢核心数据。 |
| AC-012 | Windows、macOS、Linux 均完成代码兼容检查；当前运行端完成打包应用真机验证，其他端明确记录未验证项。 |
| AC-013 | 迁移批次的核心启动、内存、终端 I/O、RDP 帧和安装任务性能与 M0 基线可比较，退化超过阈值会阻断发布。 |
| AC-014 | 完成核心-only、全量、crash-regression、受影响功能和发布演练；所有失败/skip/环境阻塞都有原始证据和后续责任；核心-only 无法执行的插件依赖用例必须在装有对应插件的全量集合中运行，不得记为通过或忽略（§11）。 |
| AC-015 | 多进程入口与 profile 协同：`--headless`、`ModeLease`、`ProfileLease` 与插件宿主协同；备份还原前宿主全部静默；迁出的 re-exec 入口（`--vnc-special-key-hook`、`--sockscap-redirector-bridge`）由宿主承载，核心-only 二进制不含其代码。 |
| AC-016 | 插件加密数据密钥（`mfa.data-key-v1`）经核心 Vault 的受限插件作用域服务访问，宿主不持有 Vault 句柄；备份还原后 Vault 与插件库一致、可解密；运行中的插件库通过 `backup.snapshot` 取得一致快照。 |
| AC-017 | 单体首次升级默认安装首批全部本机兼容正式模块。旧数据按预检、暂存、迁移、提交顺序处理，支持重试和回滚。模块化版本后续只更新已安装的模块，保留禁用和卸载状态。新增正式模块展示名称与功能说明，由用户选择安装。 四端实装以验收时最新公开稳定单体为基线，同轮固定 Release 和资产摘要。已安装 MFA 有旧账户时在工作区提示使用原 Vault 密码迁移。SocksCap 在安装时接管旧配置和规则。 |

## 0. 决策摘要（先看这页）

### 0.1 要做什么

1. **核心默认安装**：用户下载安装后即得的包只含 §3 的核心。核心离线可用，不依赖任何插件；插件未安装时，核心不崩、不丢数据、不留坏 tab，只显示“去模块商店安装”。
2. **插件独立打包发布**：§4 的每一个插件都有自己的 id、版本号、Release asset、签名，可独立下载、安装、启用 / 禁用、卸载、回滚，不用重装核心，不用等核心发版。
3. **模块商店是第一版的一部分**：不是事后补的下载页。商店在应用内（设置 / 欢迎页入口），负责浏览、兼容性检查、下载、验签、安装、启用 / 禁用、卸载、回滚。
4. **同 monorepo，不同 artifact**：第一版不拆多仓库。代码仍在同一个 `engcapa/taomni` 仓库里开发、评审、跑 CI；发布时每个插件单独出包。拆仓库是以后可选的组织决策，不是 P1 的前置条件。

### 0.2 核心边界（用户已决策，见 §13）

| 决策 | 内容 |
|---|---|
| 核心 = A + 全部 session 类型 + workspace | A 是窄核心（终端 + SFTP + Tao 轻聊，见 §3.2）；再加全部 session 类型（除 VNC / RDP / Mail 外，23 种，完整客户端实现留核心，读法 B）；再加 workspace（Workspace-first 主壳 + Code Workspace 全量，含 LSP / DAP / Git / Build-Run-Debug / Java 结构化搜索 5 个重型子项） |
| Tao Agent 全部进核心 | `agent/` + MCP + ACP / Claude Code / Codex 桥接 + chat + LLM 路由 + 工作流，全部留核心，不拆插件 |
| 截图入口、备份进核心 | 截图入口（触发、浮动工具条入口、热键注册）与备份 / 恢复留核心；截图 OCR / 录制编码引擎做插件（§3.7 的拆分口径） |
| MFA 做插件；nettools 已取消 | 第 3 项其余两项原为 MFA、nettools 做插件；nettools 于 2026-11-14 被用户取消（DEC-3），现仅 MFA 做插件 |
| RDP、VNC 做插件，客户端与服务端两类 | RDP 客户端、VNC 客户端、RDP 服务端、VNC 服务端都做插件；分两类：客户端类（`plugin-rdp-client`、`plugin-vnc-client`）与服务端类（`plugin-rdp-server`、`plugin-vnc-server`），共 4 个插件。客户端与服务端不再合一个插件，各自只链接自己需要的引擎（RDP 客户端用 IronRDP 客户端件、服务端用 ironrdp-server；VNC 客户端用 RFB + OpenSSL、服务端监督系统 VNC daemon） |
| 邮件做插件 | Mail 客户端、统一收件箱、缓存和邮件配置迁移到 `plugin-mail`；会话记录仍由核心管理，插件通过核心 Vault、代理和文件查看器服务运行 |
| 第一版 = P1 | 不做 P0 多 profile 打包过渡态；第一版交付插件运行时 + 模块商店，首发目标为全部有效非核心插件 |
| 首批 = 全部非核心模块 | 不是先试点 2–3 个；§4 的 11 个有效插件按 §10 分批迁移，全部通过门禁后一起发布；仅 DEC-2 允许的 mobile 或 macOS G2 情形可以明示暂缓。 |

### 0.3 不做什么（冻结边界）

| 冻结项 | 具体含义 | 违反的后果 |
|---|---|---|
| 现有会话数据不丢 | `taomni.db` 里的会话、分组、隧道、历史，迁移时由各模块做一次性迁移，不静默丢弃，不改用户已保存的 `session_type` 取值 | 老用户升级后会话打不开 |
| 现有 Tao 首页设计不动 | PR #806 已合入的 Tao Home 设计（`docs-feature/tao-home-design.md` v1.3）是核心的一部分；模块化不得改 Tao 的问 / 做 / 深研三档与 DeepSeek VIP 轨道 | 两份设计打架 |
| 现有安全策略不降级 | Vault 加密、确认制、redaction、SSH 已知缺口（`check_server_key` 接受所有 key，无 known-hosts/TOFU）与内置 SSH 服务器 SFTP `rootDir` 非沙箱，这两处缺口在模块化中不扩大、不掩盖（见 §9） | 特权插件 + 旧缺口叠加成真风险 |
| 不改成 SaaS | 不引入 Taomni 运营的账号、强制云端后端、强制登录下载插件；模块商店的下载源默认是 GitHub Release，可离线安装本地插件包 | 违背 local-first 定位（roadmap 非目标） |
| 插件形态以 §5.0 为准 | v1.2 写的“普通插件是进程内 Tauri 插件”经审查不成立（Rust 无稳定 ABI、Tauri 命令与 capability 是编译期的，见 §5.0）。v1.3 方案（DEC-1 用户已选）：原生部分一律是由核心拉起的插件宿主进程，前端部分仍在主 WebView 内动态加载；进程内 cdylib 仅作 G5 失败时的备选 | 做出一个装不上、或装上就崩核心的“插件系统” |

### 0.4 成功标准（验收口径）

- 核心-only 安装可启动、可建 23 种核心 session、可开终端 / SFTP / 数据库 / 工作区；Mail 入口显示模块安装提示、可跑 Tao Agent；未装插件的入口（Mail、RDP / VNC / Servers / SocksCap / MFA / 截图 OCR 与录制 / 本地语音 / 移动端）点开时是“未安装，去商店安装”，不是白屏、不是崩溃、不是静默无反应；已保存的 RDP / VNC 会话、从其它工具导入的 RDP / VNC 会话在插件未装时仍显示在会话树里，不被隐藏、不被删除。
- 现有单体用户首次升级时默认安装本机可用的首批正式模块，可按需卸载。原有会话、服务器配置、MFA 和 SocksCap 等资料按各模块的迁移协议处理。后续根据当前安装状态提供更新，并提示用户选择是否添加新功能模块。见 §6.4–6.5。
- 每个插件可独立安装、启用、禁用、卸载、回滚到上一版本；卸载后核心正常，插件自己的数据按 §8 处理（默认保留数据、显式删除才清）。
- 核心与插件可独立发版：只改一个插件时，只发该插件的新包 + 新的 `modules.json`，不重发核心包；核心发版时不强制重发全部插件，只在 `coreApiVersion` 大版本变化时才要求插件适配。
- 全部回归用例通过：核心-only 回归 + 全量回归两套都过；`pnpm check:refactor` 通过；新增文件遵守 800 行上限（AGENTS.md）。
- 体积基线先实测再报数：本文不承诺“核心瘦 X MB”，因为仓库里没有已发布安装包的体积基线（§1.4）；P1 第一项工作就是实测三端基线，之后每批迁移都报增量。

---

## 1. 现状分析：为什么现在是一个单体

本节取自基线 `1d2f5748`（Merge PR #810）的源码实测，不是推测；相关命令和路径在 §14 记录。需要区分“源码规模”与“发布包体积”：前者已测，后者仍由 M0 产生首份可复现基线。

### 1.1 一个版本、一个包、一个更新清单

- 版本唯一入口是根 `package.json`（0.5.9）；`src-tauri/Cargo.toml` 的 0.3.0 只是 crate 元数据，不是发版号。
- `src-tauri/tauri.conf.json` 是 `bundle targets: all`、`createUpdaterArtifacts: true`；更新只认 GitHub Release 里唯一的 `latest.json`，由 `scripts/compose-updater-manifest.mjs` 汇总（见 `claudedocs/auto-update-plan.md`）。
- 核心整包仍由 `.github/workflows/release.yml`（tag `v*` 触发，Linux / Windows 矩阵 + macOS 双架构）负责。模块-only 发布由 `.github/workflows/release-modules.yml` 按选定稳定模块构建四个平台包，以当前已发布目录为基线生成并签名新的 `modules.json`，不构建核心安装包。联合变更由两个 workflow 分别生成各自资产，发布时再按门禁结果合并。

### 1.2 一个 Rust 入口、一个全局状态

- `src-tauri/src/lib.rs` 593 行，`src-tauri/src/commands/mod.rs` 823 行挂了 50 多个子模块，`AppState`（`src-tauri/src/state.rs:77`）里同时装着 `tunnels、sockscap、servers、mail、database、agent、remote_desktop、workspace、terminal` 等全部运行时。
- 删一个功能不是删一个文件，是改全局状态、改 `invoke_handler`、改 `AppState` 构造、改前端静态 import，四处联动。

### 1.3 前端是静态全量引入

- `src/layouts/main/TabContentRouter.tsx` 直接 `import` 了 `ViewerShell、CodeWorkspaceTab、MailClientTab、MailUnifiedTab、MfaTab、ServersPanel、SocksCapPanel` 等；只有 `src/layouts/main/panels.tsx` 对 RDP / VNC / 数据库 / Redis / HBase / ProxyTest 用了 `React.lazy`（v1.4 写“没有 `React.lazy`”不准确）。但 `React.lazy` 只是核心 `dist` 里的异步 chunk，仍随核心安装包发布，不是可卸载的插件包；MFA / Servers / SocksCap 等则是静态 import。用户一次没打开过邮件、编辑器，代码也已经打进 `dist`。
- `src/components/editor/` 一个目录就 1,167 个文件、约 12MB 源码；mail 98 个、database 85 个、settings 83 个、terminal 71 个、git 69 个、screenshot 51 个、viewer 55 个文件。

### 1.4 规模与体积驱动（实测数）

- 规模：排除 `.git`、`node_modules`、`src-tauri/target` 后，本地工作树（基线 `7bc498b35`）实测 7,293 个文件、约 88 MB；`src/` 3,022 个文件，`src-tauri/` 2,165 个文件；Rust 331,079 行（v1.4 基线 `1d2f5748` 为 7,071 / 86 MB / 2,926 / 2,083 / 325,226）。文件数和源码行数随提交变化，后续只把 M0 产物作为体积比较基线。
- Rust 行数前几名：mail 26,697 行、sockscap 24,839 行、servers 23,256 行、screenshot 21,995 行、agent 21,759 行、hbase 21,090 行、lsp 16,724 行、rdp 14,841 行、database 13,228 行、vnc 12,838 行、mobile 12,679 行、backup 10,357 行、terminal 8,995 行、viewer 3,165 行（新增，核心）。
- 体积驱动不是业务代码，是重型原生依赖：IronRDP 全特性 + 自改 vendor、vendored OpenSSL（VNC TLS）、`sherpa-onnx` + `whisper-rs`（默认特性就开着）、`openh264`、多数据库驱动（`sqlx-mysql / postgres + oracle + tiberius + thrift + zookeeper + cross-krb5`）、编译 C 代码的 `tree-sitter-java`、`rmcp / axum`、`xcap / cpal`，前端还有 `tesseract.js + chi_sim / eng` 语言包、`mermaid、konva、CodeMirror` 13 种语言、`xterm-webgl、yjs`，以及文件查看器新增的 `docx、katex、html-to-image`（`mermaid` 等按需加载，仍在核心 `dist`）；工作区另含 vendored `wry`（约 1.6 万行，由 `[patch.crates-io]` 指向）。这些是静态链接 / 打包进来的，功能不用也占体积。
- **缺口**：仓库里没有已发布安装包的体积基线，本文不编造“核心瘦多少 MB”。P1 第一项工作（§10 M0）是实测 Win / macOS / Linux 三端现包体积、解压后二进制、`dist` 各 chunk，再按插件逐个报增量。

### 1.5 已有拆分先例（可复用，别重造）

- **编译期开关已有**：`Cargo.toml [features]` 保留 `asr-whisper、asr-sherpa、local-llm-fim、vulkan-detect、screen-capture、hbase-kerberos` 等；默认开的是 `hbase-kerberos、rdp-server-audio、voice-capture、asr-whisper、asr-sherpa`。历史上为 LanChat 原生 A/V 增加的 `native-av` feature 已随 LanChat 删除，当前发布矩阵不再启用它。其余“编译期开关”仍未提供“安装时可选”；P1 的工作是把保留的重型 feature 升级成安装期插件，不是重写依赖。
- **数据层已有分库先例**：`notes.db、mail-cache/、vault.db` 已经是分开的，只有 `taomni.db` 是全混在一起。§8 按这个先例继续分，不另起新范式。
- **状态分域雏形已有**：`src-tauri/src/state/domains.rs` 已把 `WorkspaceRuntime、MailRuntime、TerminalRuntime、FileRuntime、RemoteDesktopRuntime、DatabaseRuntime、AgentRuntime` 收成分域结构；但 `sockscap、servers、mfa、mobile、tunnels` 仍是 `AppState` 顶层字段（`state.rs:77`）。M0 的 `CoreState + PluginRegistry` 拆分沿用这个分域方向，不重新发明。
- **命令分发已是字符串路由**：见 §1.8，`commands::handle` 逐名匹配，插件分发可以做成兜底分支。
- **边界检查已有**：`pnpm check:refactor`（`scripts/refactor-contracts.mjs + refactor-boundaries.mjs + source-file-size.mjs`）已经在检查模块边界与文件大小；P1 把插件边界加进这套检查，而不是另起一套 lint。

### 1.6 关键概念：session 类型 ≠ 客户端实现（本设计的分界依据）

- `SessionType` 是 `src-tauri/src/session/models.rs:27` 的枚举，共 26 种（见 §3.3 全表）。
- `TabKind` 是 `src/types/index.ts:9` 的 22 种 tab（v1.5 新增 `file-viewer`；LanChat 删除后减少 1 种）。
- 两者映射在 `src/lib/welcomeSessionResume.ts` 的 `primaryViewTypeForEntry` 与 `ELIGIBLE_SAVED_SESSION_TYPES`（25 种可恢复，Browser 不可恢复）。
- 一个 session 类型要“能用”，需要三层：会话记录（建 / 改 / 删 / 导入）、会话管理（树、分组、Vault 密码、跳转）、客户端实现（打开 tab 后的协议 + UI）。用户选的是读法 B：**23 种核心 session 的客户端实现全部留核心**，不是只留记录（§13.1）。这个选择直接决定了 §3 与 §4 的分界，也决定了瘦身上限（见 §1.7）。

### 1.7 按读法 B，瘦身效果的诚实预告

- 核心还要背：数据库全套驱动、邮件全套、HBase、对象存储、编辑器 + LSP + DAP + Git + 构建链、Tao Agent 全套。
- 能瘦掉的只有：RDP / VNC（IronRDP + OpenSSL + RFB）、剩余 servers、SocksCap（WinDivert / xray-core）、本地语音 / 模型（Whisper / Sherpa / llama.cpp）、截图 OCR 语言包与编码器、MFA、mobile。
- 仍有收益，但不是“核心只剩终端”那种瘦法。这是用户用“开箱即用”换来的 trade-off，本文不掩盖，评审时请按这个口径对预期。

### 1.8 模块耦合实测（v1.3 新增，决定 M0 要先做什么）

方法：在 `1d2f5748` 上用 `grep -rE "crate::<模块>"` 统计 `src-tauri/src` 内各候选插件模块被谁引用（反向依赖）、又引用了谁（正向依赖）。数字是引用次数，不是行数，只用于判断耦合方向；M0 仍需用编译闭包和运行时测试复核，不能把 grep 结果当成完整依赖图。

| 候选模块 | 被谁引用（插件化后会断的边） | 它引用核心的什么 | 判断 |
|---|---|---|---|
| `rdp`（客户端，14,841 行） | `servers/rdp` 的剪贴板 / 编解码辅助（`rdp::session::*`、`rdp::cliprdr`）；`config/paths.rs`（`cliprdr::uri_list_to_paths`）；`state.rs`；`mobile/headless.rs`（`rdp::tls::init_trust_table`） | `terminal` 13、`vault`、`state` | **RDP 服务端并非独立于 RDP 客户端**，v1.2 §4 “只共享 Cargo 依赖，不共享代码”与现状不符 |
| `vnc`（客户端，12,838 行） | `state.rs`、`state/domains.rs`、`commands/vnc.rs`；`rdp` 里的 `crate::vnc` 只在注释里 | `terminal` 8、`state`、`database` 1 | 反向依赖最少，是最干净的一类 |
| `servers`（23,256 行） | `screenshot`（37 处，全部是 `servers::rdp::capture::*`、`LogEmitter`、`ServerType::Rdp`、`control_permission_granted`；含 `screenshot/scroll/input.rs`）、`webview_recovery`、`mobile/headless.rs`、`mobile/desktop/windows.rs`（macOS 输入权限 `rdp::control_permission_granted`，v1.5 新增）、`state.rs` | `rdp` 10、`terminal` 11、`vault` 8、`module_lock` 4 | **屏幕采集引擎住在 `servers/rdp/capture/` 里**，而截图入口、屏幕共享都要用它；`control_permission_granted`（macOS 辅助功能授权）被截图滚动、移动端窗口输入共用；RDP 服务端一旦成插件，核心里的截图入口就断（S1、S2） |
| `sockscap`（24,839 行） | 仅 `commands/sockscap.rs`、`state.rs` | `terminal` 15、`session` 14、`vault` 5、`module_lock` 4 | 反向依赖少，但对核心 `terminal` / `session` 依赖多，需要稳定的核心接口 |
| `screenshot`（21,995 行） | `commands/screenshot.rs`、`webview_recovery` | `servers` 37 | 其中 `qa/` 8,091 行是 QA 夹具；真正的 OCR + 录制只有约 2.3k 行（见 §4.3） |
| `mfa`（2,268 行） | `commands/mfa.rs`、`state.rs`、`backup/tests.rs`、`mobile/headless.rs` | `vault` 10（含固定条目 `mfa.data-key-v1`）、`backup` 3（`snapshot_context::hot_backup_conn`）；屏幕采集是 `mfa/capture.rs` 自带实现（xcap / Linux portal / macOS），**不引用 `servers::`** | 代码耦合干净、体积小；但数据密钥在核心 Vault、热备份在进程内（S12、S13）。v1.4 写的“MFA 屏幕扫描走核心 `capture/`”与源码不符：这是独立于流式引擎的采集实现，已决定并入统一采集层（S1、§4.2.1） |
| `proxy`（473 行） | **被 `agent` 三个桥接、`ai/config`、`asr`、`llm/opencode_go`、`objectstorage`、`terminal/network`、`voice`、`backup`、`mobile/im_adapter` 引用** | `vault`、`session` | **是核心网络基础设施（应用代理解析），不能进插件**；v1.2 把它划给 `plugin-nettools` 是错的（§4.4） |
| `asr` + `voice`（约 5k 行） | `ai/config/asr.rs`、`ai/mod.rs`、`llm/mod.rs`、`ai/commands.rs`、`webview_recovery` | `models`、`proxy` | `voice/streaming/` 里有云端 ASR（`cloud.rs`、`routing.rs`、`providers.rs`、Deepgram 等），不是“本地”；`voice/capture.rs`（`cpal` 麦克风采集）云端 ASR 也要用（§4.4） |
| `mobile`（12,679 行） | **核心终端热路径**：`terminal/authentication.rs`、`terminal/io_commands.rs`（`state.mobile.broker`）、`terminal/output.rs`、`terminal/ssh_start*.rs`、`terminal/local_start.rs`；`chat/stream/*`、`chat/acp/*`、`chat/thread_commands.rs`；`agent/cc_bridge/mcp_*`；`state.rs`；`lib.rs`（`ModeLease`、`state.mobile.stop()`、`config_root`）；`main.rs`（`--headless`） | `terminal` 20、`chat` 18、`state` 14、`ai` 9、`agent` 7、`session` 4、`proxy` 4、`screenshot` 3（`mobile/desktop/capture.rs`）、`servers`/`rdp`（`headless.rs` 建表、`windows.rs` 权限）、`webview_environment`、`migrate` | **与核心双向深度耦合**：观察方向（输出广播）+ 控制方向（写终端、resize、开会话、聊天流、ACP 桥接）+ 独立 headless 入口 + 桌面远控（采集、窗口输入、受管浏览器窗口）；是有效插件里最难拆的一个（§4.5） |

另有三条与插件形态直接相关的现状：

- **命令分发已是按名字字符串匹配**：`lib.rs:534` 用 `.invoke_handler(commands::handle)`，`commands/mod.rs:59` 的 `handle` 对命令名逐个 `match`，再转给各模块的 `handle`。没有一个全量 `generate_handler!`。好消息：加一个 `plugin_invoke` 兜底分支几乎不改现有命令。
- **权限是编译期、集中的**：只有 `src-tauri/capabilities/default.json` 一份 capability，窗口白名单里写着 `rdp-*`、`vnc-*`、`screenshot-*` 等；Tauri 在编译时把它们嵌进二进制，运行时无法给下载来的插件新增 capability。
- **前端类型是封闭联合**：`src/types/index.ts` 的 `TabKind` 是 22 项字符串字面量联合，且文件顶部直接 `import` 了 `RdpOptions`、`VncViewerOptions`、`LaunchPreparation`（来自 sockscap）等插件类型。

### 1.8.1 前端耦合实测（v1.5 新增）

v1.4 只记录了 `src/types/index.ts` 的类型耦合。按 `7bc498b35` 对 `src/` 做 import 反查（不含测试文件）：

| 插件前端目录 | 在目录外被谁 import | 对迁移的含义 |
|---|---|---|
| `components/rdp/`（10） | `layouts/main/panels.tsx`、测试 harness | `React.lazy` 入口，改注册表加载最容易 |
| `components/vnc/`（26） | `components/detached/DetachedSessionWindow.tsx`、`layouts/main/panels.tsx`、`tabs/TabContentRouterProps.ts`、`useProtocolTabs.ts` | 分离窗口是独立 WebView，注册表和 chunk 加载必须在该入口同样初始化 |
| `components/servers/`（23） | `App.tsx`、`MainLayoutView.tsx`、`TabContentRouter.tsx` | `App.tsx` 里有窗口级入口，需插槽化 |
| `components/sockscap/`（35） | `TabContentRouter.tsx`；另有 `lib/sockscap*.ts` | 相对干净 |
| `components/mfa/`（18） | `MainLayoutView.tsx`、`TabContentRouter.tsx`；`stores/mfaStore.ts`、`lib/mfa*` | 左下角悬浮窗在主布局里挂载 |
| `components/screenshot/`（51） | `App.tsx`、`PrimaryNavigationRail.tsx`、`RdpPanelView.tsx`、`VncPanel.tsx`、`TerminalPanelView.tsx`、`DatabaseWorkspaceView.tsx`、`screenshotOverlayBoot.ts/Root.tsx` | 入口留核心；OCR（`lib/screenshotOcr.ts`）与录制只能经扩展点出现，`components/screenshot` 内部也要按 §4.3 文件级拆分 |
| `components/voice/`（5） | `App.tsx`、`chat/Composer.tsx`、`settings/AiShellPanel.tsx`、`terminal/AiRewriteOverlay.tsx` | 语音输入按钮是核心 UI，本地引擎缺失时必须降级（S7） |
| mobile（无独立目录） | `layouts/main/useMobileBridge.ts`、`mobileConnectionAuth.ts`、`mobileProxyAuth.ts`、`useShellSessionTabs.ts`、`useMainWorkspaceOpening.ts`；`components/settings/{MobileHostSettings,MobileServiceSettings,FeishuAdapterSettings,FeishuSetupGuide}.tsx`；`components/terminal/panel/backendConnection.ts`、`lib/ipc/terminal.ts`、`lib/mobileListener.ts`、`stubs/{mobileStub,feishuStub}.ts` | 前端没有可整体搬走的目录；设置页、终端连接、主布局桥接都点名 mobile，需要设置页插槽和桥接扩展点（§4.5） |

另有 `mobile-web/`（56 个文件，独立 Vite 构建）经 `src-tauri/build.rs` 打入 `resources/mobile-web` 并由核心二进制内嵌，迁移后随 `plugin-mobile` 包发布。

### 1.9 打包耦合实测（v1.3 新增）

插件化还要改这些现有打包配置，v1.2 没列：

- `src-tauri/tauri.conf.json`：`bundle.resources` 含 `resources/sockscap/**/*`；Linux `deb` / `rpm` 的 `depends: nftables`（SocksCap 用）与 `recommends: tesseract-ocr`（截图 OCR 用）。包依赖不能随插件安装，需改为运行时检测 + 插件安装向导提示。
- `src-tauri/nsis/hooks.nsh`：安装 / 更新时停 `sockscap-helper.exe`、卸 WinDivert 驱动。插件化后这段清理必须由 SocksCap 插件自己的卸载 / 更新路径承担，核心安装器不能再假设它存在。
- `src-tauri/src/bin/`：`sockscap-helper`、`rdp-probe`（QA 探针）、`mitmproxy-redirector-poc` 三个独立可执行文件；`scripts/before-bundle.sh`、`scripts/stage-*-sockscap-*`、`scripts/stage-mitmproxy-redirector-macos.sh` 负责暂存。
- macOS 签名：`src-tauri/Entitlements.plist` 只有音视频输入权限，没有 `com.apple.security.cs.disable-library-validation`；`docs-issue/macos-screenshot-permission-and-signing.md` 记录发布包是 ad-hoc / 自签名，没有 Developer ID（`release.yml` 里公证为可选）。这决定了“下载来的原生代码如何被 macOS 接受”是真风险（§5.0）。
- 二进制 re-exec 入口（v1.5 新增）：`src-tauri/src/main.rs` 按 `argv[1]` 分发 `--headless`（`mobile::headless::run`）、`--ssh-stdio-forward`（OpenSSH ProxyCommand 桥）、`--screenshot-scroll-input`（Windows）、`--sockscap-redirector-bridge`（macOS）、`--vnc-special-key-hook`（Windows，`VNC_SPECIAL_KEY_HOOK_ARG`）。这些入口让主二进制承载插件代码；迁移时按归属处理（§4.2 S11）。
- 发布矩阵：`release.yml` 实际只构建 Linux x86_64、Windows x86_64、macOS arm64 + x86_64 四个目标；v1.2 `module.json` 示例里的 `windows-aarch64` 当前并不存在。

### 1.10 基线漂移与 v1.5 复核（v1.5 新增）

v1.4 取证于 `1d2f5748`；当前 `7bc498b35` 之间的变更对本设计的影响如下（命令见 §14）：

| 变更 | 数据 | 对设计的影响 |
|---|---|---|
| 全局文件打开 / 查看器（`feat(viewer)`、`file-open` 系列修复） | 核心 `src-tauri/src/viewer/` 3,165 行；`src/components/viewer/` 55 个文件；`src/lib/openFile/` 14 个文件；`TabKind` +`file-viewer`；新增命令 `viewer_*`、`clipboard_write_image_png` | 归核心（§3.9）；引入第二个自定义协议 `taomni-preview`，CSP 的 `frame-src` 已改动，插件 scheme 要与之合并（§5.3）；新增 npm 依赖影响基线（TASK-001） |
| vendored `wry` + `tauri-utils` 的 `html-manipulation-2` | `src-tauri/vendor/wry` 55 个文件、约 1.6 万行；根 `[patch.crates-io]` 新增 `wry` | 工作区 patch 表更大，进一步支持“插件 crate 必须在同一工作区且不得依赖 `tauri` / `wry`”（§5.4、§11） |
| 移动端桌面远控 + 飞书适配（`feat(mobile)`） | `mobile/` 10,455 → 12,679 行；新增 `mobile/desktop/{capture,windows,browser}.rs`、`im_adapter/*`；`objc2-app-kit` 新增 `NSRunningApplication` | 拆分成本显著上升（§4.5、S14、S15）；macOS 窗口聚焦 / 键盘注入使 G2 的 TCC 归属问题扩大到 `plugin-mobile` |
| MFA 采集复核 | `mfa/capture.rs` 自带 xcap / portal / macOS 实现，不引用 `servers::` | 更正 S1 与 §4 第 9 行 |
| 备份 / Vault 复核 | `vault::is_protected_entry`（`mfa.data-key-v1`）、`hot_backup_conn`、`ProfileLease` | 新增 S12、S13（§4.2） |
| 崩溃专项 | `crash-regressions.md` 现含 19 个用例，新增 `TC-MOBILE-012/013`、`TC-FILE-OPEN-001–006` | §11 插件感知规则 |
| 未变化的结论 | `SessionType` 仍 26 种；`state.rs` 与 `state/domains.rs`、`capabilities/default.json`、`release.yml` 矩阵、`rdp` / `vnc` / `sockscap` / `servers` / `proxy` 行数均无变化 | v1.4 其余耦合判断仍成立；仍需 TASK-001 的编译闭包复核，不能用 grep 代替 |

---

## 2. 目标、原则、非目标

### 2.1 目标

1. 核心默认安装、离线可用、不依赖任何插件。
2. 每个插件独立版本、独立发布、独立下载安装、独立回滚；核心只声明它兼容的 `coreApiVersion`，不锁死插件小版本。
3. 插件卸载 / 禁用后核心不崩、不丢数据、不留坏 tab。
4. 第一版就交付插件运行时 + 模块商店 + 全部非核心插件，不留“以后再补商店”的尾巴。

### 2.2 原则

- **核心只通过三样东西跟插件说话**：模块清单（`module.json`）、带命名空间的 IPC（前端 `invokePlugin(<slug>, <cmd>)` → 核心 `plugin_invoke`，§5.0）、核心提供的共享服务（会话、Vault、设置、更新、i18n、Tao Agent 工具总线）。不允许插件之间互相直调、私自读对方的库、私自读对方的数据库文件。
- **插件之间不依赖**：只允许依赖核心。RDP 插件不依赖 VNC 插件，也不依赖 Mail，以此类推。共用能力下沉到核心（§4.2 清单）或抽成**库 crate**（不是插件，各插件各自静态链接一份），不搞插件间依赖图。v1.2 假设这一条“现状已满足”，实测不满足（§1.8）：它是需要先做的重构，不是现成条件。
- **核心不得依赖任何插件**：核心代码不得 `use` 插件 crate、不得读插件数据库、不得因插件缺失而改变核心流程的结果；核心对插件能力的调用只能经过 `taomni-plugin-api` 里定义的扩展点（§5.6），扩展点未注册时必须有明确的降级行为。由 `pnpm check:refactor` 的边界检查强制（§11）。
- **签名与更新复用现有链路**：同一个 minisign 密钥、同一个 `latest.json` 思路，再加一个 `modules.json`；不绕过签名校验，不自行执行未验证的安装包。
- **数据归属清晰**：每个插件自己建库 / 目录，`taomni.db` 只留会话、设置这类核心表（§8）。
- **失败是显式的**：插件缺失、版本不兼容、签名失败、下载中断，全部有明确 UI 与错误码，不静默、不白屏、不假装成功。

### 2.3 非目标

- 不改成 SaaS、不引入强制账号、不强制登录下载插件。
- 第一版不拆多仓库、不为“隔离”而把核心功能拆成多进程；插件原生部分的进程形态以 §5.0 为准。
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
| 应用代理与网络出口 | `src-tauri/src/proxy/`（473 行）、`src-tauri/src/commands/proxy.rs`、`src/components/settings/AppProxyPanel.tsx`、`src/lib/ipc/proxy.ts` | 被 agent 桥接、llm、objectstorage、terminal、backup、asr、voice、mobile 引用（§1.8），必留核心；`test_proxy_connection` 也被会话编辑器与代理设置页使用 |
| 屏幕采集服务（v1.3 新增，自 `servers/rdp/capture/` 下沉） | 现 `src-tauri/src/servers/rdp/capture/`（含 Wayland 检测、`Frame`、`create_capturer*`） | 截图入口、屏幕共享、RDP 服务端共用；下沉为核心 `capture/` 后三者都只依赖核心（§4.2） |
| 插件基础设施（v1.3 新增） | `src-tauri/src/plugin/`（新增）、`taomni-plugin-api` crate（新增，§5.0） | 注册表、插件宿主进程管理、`plugin_invoke` 分发、日志发射器 `LogEmitter`（自 `servers/engine` 下沉）、`module_lock` |

### 3.2 A 窄核心：终端 + SFTP + Tao 轻聊

| 项 | 代码位置 | 说明 |
|---|---|---|
| 本地终端 | `src-tauri/src/terminal/`（8,995 行）、`src/components/terminal/`（69 个文件） | 本地 PTY（`portable-pty`）、分屏、MultiExec、宏、录制、zmodem、终端外观、OSC 7 |
| SSH 终端 | 同上，`russh` 后端 | 含跳板、代理、keep-alive；已知缺口：`check_server_key` 接受所有 key，无 known-hosts/TOFU，模块化中不扩大（§9） |
| SFTP / 文件浏览 | `src-tauri/src/filebrowser/`（5,195 行）、`src/components/filebrowser/`（38 个文件）、`src/components/explorer/`（38 个文件） | `russh-sftp`、双面板、传输队列、同步；本地 File 会话也走这套文件浏览 |
| 隧道 | `src-tauri/src/tunnel/`（1,085 行）、`src/components/tunnel/` | SSH 本地 / 远程 / 动态转发；是终端的附属，留核心 |
| Tao 轻聊 | `src/components/chat/、src/components/tao/、src/stores/chat/` + Tao Home（PR #806） | 首页 Tao 的问 / 做 / 深研三档、DeepSeek 全家桶 VIP 轨道；Tao Agent 重型部分见 §3.5，不是只留轻聊 |

### 3.3 全部核心 session 类型（读法 B，23 种完整客户端留核心）

`SessionType` 全 26 种，除 RDP、VNC、Mail 外的 23 种，完整客户端实现（协议 + UI + tab）全部留核心。Mail 的记录和恢复元数据留核心，客户端实现由 `plugin-mail` 提供。映射以 `src/lib/welcomeSessionResume.ts:primaryViewTypeForEntry` 为准。

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
| Proxy | `proxy-test` | 会话记录、配置、Rust 侧 `proxy/` 与 `test_proxy_connection` 全部留核心（§3.1）；`proxy-test` tab 的 82 行 UI（`ProxyTestTab.tsx`）随 DEC-3 不拆成插件，现阶段保留现状代码；删除该测试页需另开产品任务（§13.3 DEC-3） |

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

**邮件会话记录（实现由独立模块提供）：**

| session_type | 开 tab | 代码 / 依赖 |
|---|---|---|
| Mail | `mail` / `mail-unified` | 会话记录和恢复元数据仍在核心；邮件客户端、统一收件箱、同步、缓存和发送实现迁移到 `plugin-mail`，使用核心 Vault、代理、文件查看器和备份服务 |

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

- **截图入口留核心**：热键注册、菜单入口、浮动工具条（`FloatingToolbar`）触发、截图 Overlay 入口。入口本身不带 OCR 引擎、不带录制编码器；点开 OCR / 录制功能时若插件未装，显示安装提示（引擎拆分口径见 §4.3）。入口依赖的屏幕采集随 §4.2 下沉到核心 `capture/`，不依赖任何插件。
- **备份 / 恢复留核心**：`src-tauri/src/backup/`（10,357 行）。备份范围含核心数据 + 各插件的数据文件（只备份数据，不备份插件代码）；恢复时若某插件未装，先恢复其数据文件、提示安装插件，不报错、不丢数据。

### 3.8 其它留核心的

- 本地文件资源管理器（原型 v1，`src/components/explorer/`）与 File 会话共用同一套文件浏览，留核心。
- 终端补全与命令重写、Web Search Provider 矩阵随 Tao Agent 留核心（原文章节号以 `docs-feature/tao-home-design.md` 为准，本文不再引用其内部编号）。
- 多选会话连接、上下文菜单容错、双语 UI、标签分离、SSH MFA 弹窗（`MfaPrompt`，注意：MFA 弹窗是 SSH 登录流程的一部分，留核心；MFA 验证器本体是插件，见 §4（`plugin-mfa`）——两者不要混淆）。

### 3.9 文件打开与查看器（留核心，v1.5 新增）

分支新增的全局文件打开能力全部归核心，不进插件清单：Rust `src-tauri/src/viewer/`（文本/字节读取、分块、写入、HTML 预览会话与网络桥、临时文件、粘贴图片）、`src/components/viewer/`（55 个文件）、`src/lib/openFile/`、`TabKind "file-viewer"`、邮件附件只读副本（`source: "mail-attachment"`）、远程临时文件（`source: "remote-temp"`）。它复用核心 `proxy/` 与 `workspace/`，不依赖任何候选插件。对模块化的约束：

- `viewer::register_protocol` 在 `lib.rs` 的 `tauri::Builder` 上注册 `taomni-preview` 协议，CSP `frame-src` 已加入 `taomni-preview:` 与 `http(s)://taomni-preview.localhost`（`csp` 与 `devCsp` 两处）。插件前端协议按同样模式注册并合并 CSP，不得覆盖该项（§5.3）。
- vendored `wry` 保证 WebView2 只对主框架注入 Tauri IPC 凭据，不向不透明的本地 HTML 预览帧泄漏；插件 chunk 必须只在主框架加载，且不得使用会弱化该保证的 `unsafe-inline` 脚本策略。
- `TC-FILE-OPEN-001–006` 已纳入 `crash-regression`，核心-only 和全量回归都要运行（§11）。

---

## 4. 插件清单（首批：全部非核心模块）

首批目标 = §3 之外的全部有效模块，共 11 个有效插件（按 §10.1 的迁移分组排序；其中 RDP / VNC 按客户端与服务端两类拆为 4 个，见 §0.2）。下表保留已取消的 nettools 记录以便追踪历史，但它不计入插件数量、构建矩阵或验收集合。

| # | 插件 id | 名称 | 代码位置（现状） | 体积驱动 / 说明 | 数据归属 |
|---|---|---|---|---|---|
| 1 | `taomni-plugin-rdp-client` | RDP 客户端 | Rust `src-tauri/src/rdp/`（14,841 行）+ 前端 `src/components/rdp/`（10 个文件） | IronRDP 全特性 + vendor patch；客户端类（`kind: remote-client`），只链接客户端件 | `rdp-client` 自有表 / 文件（新库，见 §8）；会话记录仍在核心 `taomni.db` |
| 2 | `taomni-plugin-vnc-client` | VNC 客户端 | Rust `src-tauri/src/vnc/`（12,838 行）+ 前端 `src/components/vnc/`（26 个文件） | 自研 RFB + vendored OpenSSL（匿名 TLS）；客户端类，只链接客户端件 | 同上 |
| 3 | `taomni-plugin-rdp-server` | RDP 服务端 | 服务端 `src-tauri/src/servers/rdp.rs、src-tauri/src/servers/rdp/`（其中 `rdp/capture/` 屏幕采集按 §4.2 下沉核心，不随插件走） | IronRDP server（`ironrdp-server`，含 EGFX）；服务端类（`kind: local-server`），走插件宿主进程（§5.5），只链接服务端件；剪贴板 / 编解码辅助与 RDP 客户端共用，抽成库 crate `taomni-rdp-common`（§4.2，不是插件） | 服务端自有库；RDP 审批与 tab 锁随服务端插件走（§12） |
| 4 | `taomni-plugin-vnc-server` | VNC 服务端 | 服务端 `src-tauri/src/servers/vnc.rs`（监督系统 VNC daemon，不是自研引擎） | 服务端类；监督外部 VNC daemon，不自带提权路径 | 同上 |
| 5 | `taomni-plugin-servers` | 本地服务器（除 RDP / VNC 外） | Rust `src-tauri/src/servers/`（23,256 行，扣除已划给 RDP / VNC 服务端的 `rdp*、vnc.rs` 后剩余）+ 前端 `src/components/servers/`（23 个文件） | 内置 SSH / SFTP / HTTP / FTP / TFTP / NFS / Telnet / iperf / cron；特权面大，见 §5.5 | 现状是 `taomni.db` 里的 `server_configs` 表（`src-tauri/src/servers/db.rs`，`lib.rs` setup 中建表），不是独立的 `servers.db`；迁移为插件自有库（§8.2） |
| 6 | `taomni-plugin-sockscap` | SocksCap | Rust `src-tauri/src/sockscap/`（24,839 行）+ 前端 `src/components/sockscap/`（35 个文件）+ `src-tauri/resources/sockscap/` + 提权 helper（`src/bin/sockscap-helper/`） | WinDivert / xray-core + 提权 helper；平台差异最大、风险最高 | 插件自有库；规则与捕获状态不进核心库 |
| 7 | `taomni-plugin-screenshot` | 截图 OCR / 录制引擎 | 只含 OCR（`screenshot/ocr.rs`、`ocr_windows.rs`、前端 `screenshotOcr.ts`）与录制编码（`screenshot/record/`、`recording_commands.rs`、`RecorderBar`）；Overlay、标注、贴图、收藏、滚动截图（DEC-4 已定核心）、`capture/`、`shortcut`、`qa/` 全部留核心。整个 `screenshot/` 目录 21,995 行，其中 `qa/` 8,091 行是 QA 夹具，OCR + 录制仅约 2.3k 行 | `tesseract.js + chi_sim / eng` 语言包（`package.json` 里的 `@tesseract.js-data/*`）+ `openh264 / mp4 / gif` 编码器；入口留核心（§3.7），引擎做插件。Linux 包的 `recommends: tesseract-ocr` 迁到插件的安装提示 | 截图文件仍在用户指定的持久目录，不随插件卸载删除 |
| 8 | `taomni-plugin-mfa` | MFA 验证器 | Rust `src-tauri/src/mfa/`（2,268 行）+ 前端 `src/components/mfa/`（18 个文件）+ 左下角悬浮窗 | TOTP / HOTP、二维码导出、截图 / 屏幕扫描添加账户（屏幕扫描采集是 `mfa/capture.rs` 自带实现，不依赖截图插件，也不引用 `servers::`；并入 `taomni-capture` / 核心 `capture/`（S1、§4.2.1）；SSH 登录弹窗 `MfaPrompt` 留核心，§3.8） | 已独立：`mfa.db`（懒加载），直接划归插件；加密密钥是核心 Vault 固定条目 `mfa.data-key-v1`（S12） |
| 9 | `taomni-plugin-mail` | 邮件客户端与统一收件箱 | Rust `src-tauri/src/mail/`（26,697 行）+ 前端 `src/components/mail/`（98 个文件） | IMAP/SMTP、邮件解析、同步、缓存、统一收件箱和发送任务独立运行；宿主通过核心 Vault、代理、文件查看器、通知和备份服务访问共享能力 | `mail-cache/`、邮件同步状态和模块设置归模块数据目录；核心 `taomni.db` 只保留 Mail 会话记录与恢复元数据 |
| 10 | ~~`taomni-plugin-nettools`~~（已取消，DEC-3） | 用户 2026-11-14 决定取消该插件；此行只保留审计记录，不进入首发集合 | 实测 `src/components/proxy/ProxyTestTab.tsx` 只是核心代理测试 UI；`src-tauri/src/proxy/`、`test_proxy_connection` 和 `TabKind "nettools"` 的隧道管理器仍是核心能力，不迁、不删除 | — | — |
| 11 | `taomni-plugin-ai-voice-local` | 本地语音 / 本地模型 | **只含本地推理部分**：Rust `src-tauri/src/asr/`（2,242 行，Whisper / Sherpa / SenseVoice 模型管理）、`voice/streaming/local.rs`、`src-tauri/src/tab/fim_engine*.rs`（`llama-cpp-2`，`local-llm-fim` 特性）。`voice/` 里的云端 ASR（`streaming/cloud.rs`、`routing.rs`、`providers.rs`，如 Deepgram）、`voice/capture.rs`（`cpal` 麦克风采集）、`cleanup`、`vocabulary` 云端与本地共用，留核心（§4.4）。前端 `src/components/voice/`（5 个文件）按同样口径拆 | `whisper-rs、sherpa-onnx、llama-cpp-2` 与模型二进制；`asr-whisper、asr-sherpa`（现为默认特性）移出核心默认特性；终端 FIM 补全经核心“本地补全”扩展点调用插件，未装时降级为云端 / 无补全（§5.6） | 模型文件在模型目录，不进数据库；ASR 配置在核心设置里只存“用哪个引擎”，不存模型 |
| 12 | `taomni-plugin-mobile` | 移动端远程控制面 | Rust `src-tauri/src/mobile/`（12,679 行，含桌面远控 `desktop/`、飞书适配 `im_adapter/`、`headless.rs`）+ `mobile-web/`（56 个文件，经 `build.rs` 内嵌为 `resources/mobile-web`）+ 前端设置页（`MobileHostSettings`、`MobileServiceSettings`、`FeishuAdapterSettings`、`FeishuSetupGuide`）与 `useMobileBridge` 等桥接 | 独立 Mobile Web + 实例移动服务；是另一条产物线，不跟桌面模块混版本号。**与核心双向深度耦合**：核心终端热路径直接调用 `state.mobile.broker`（`terminal/io_commands.rs`、`output.rs`、`authentication.rs`、`ssh_start*.rs`、`local_start.rs`），`chat/stream`、`chat/acp`、`agent/cc_bridge/mcp_*` 也引用它；它自己引用 `terminal` 20 处、`chat` 18 处、`agent` 7 处，并反向驱动终端写入、resize、聊天流与 ACP；拥有 `taomni --headless` 独立入口；桌面远控使用 `screenshot::capture` 与 macOS 输入权限。必须先定义观察者、控制面、headless、桌面远控四类扩展点（§4.5、§5.6）才能拆 | 插件自有库（`mobile_feishu_events` 等）；`mobile-desktop-remote.json` 策略文件；移动端 Cookie / 网关 / 飞书配置随插件走 |

**不在插件清单里的（不要误拆）**：数据库、对象存储、Code Workspace、Tao Agent、终端、SFTP、隧道、会话管理、Vault、备份、Notes——全部在 §3，留核心。

**插件间依赖**：零（目标状态，需先完成 §4.2 的共享能力下沉才成立；v1.2 把它当成现状，实测不是，见 §1.8）。RDP 客户端不依赖 VNC 客户端；RDP 服务端与 RDP 客户端只共享库 crate `taomni-rdp-common`（不是插件，不共享插件进程、数据与版本号）；不依赖 Mail；截图引擎、屏幕共享、MFA 屏幕扫描、RDP 服务端都只依赖核心 `capture/`，互不依赖。

本地服务器入口由基座统一展示服务列表、公共字段、日志和单实例标签。选中一项时，根据服务类型从 `servers`、`rdp-server` 或 `vnc-server` 的验签前端加载专属表单。各模块可独立安装。缺少模块或模块已停用时，专属区域显示模块商店入口。表单继续使用共享 Vault、配置和权限探测接口。备份与单体升级沿用各模块的数据声明。

### 4.1 已移除的 LanChat（2026-11-15）

LanChat 不再作为模块化产品能力或插件交付。核心不注册其 tab、IPC、后台服务、窗口或备份入口；插件清单、发布矩阵、迁移向导和验收集合均不包含 LanChat。升级 0.5.x 时若发现旧 `lanchat.sqlite`，预检只记录遗留文件并将其原样留在旧数据目录，不读取、不复制、不移动、不迁移、不删除；用户可在文件系统层自行备份或删除。这样预检保持只读，升级失败或取消时不会改变用户的旧数据。

### 4.2 共享能力下沉清单（M0 前置重构，插件零依赖的前提）

这是 v1.2 没有的一节。下表每一项都是“现在住在某个将被插件化的模块里，但核心或其它插件也要用”的代码，必须先搬到核心（或抽成库 crate），再迁移插件；否则迁移某个插件会让核心或别的插件编译失败 / 运行时缺功能。证据见 §1.8。

| # | 要下沉的东西 | 现位置 | 谁在用 | 目标位置 | 验收 |
|---|---|---|---|---|---|
| S1 | 屏幕采集引擎（`Frame`、`Capturer`、`create_capturer*`、Wayland 检测、`stage_trace`、macOS 屏幕录制授权）。**现有实现分三处（一个引擎加两个层，§4.2.1）**：`servers/rdp/capture/`（截图入口 37 处、屏幕共享、RDP 服务端使用）、`screenshot/capture/`（截图入口自身及 `mobile/desktop/capture.rs` 使用）、`mfa/capture.rs`（MFA 自带，不引用 `servers::`） | `servers/rdp/capture/`、`screenshot/capture/`、`mfa/capture.rs` | 截图入口、屏幕共享、RDP 服务端、移动端桌面远控、MFA 屏幕扫描 | **已决定合并（用户 2026-11-15）**：库 crate `taomni-capture`（流式引擎、`CaptureLog`、权限、一次性采集策略）+ 核心 `src-tauri/src/capture/`（显示器模型、通用 `FrameSource`、`capture.still` 服务），方案与保持行为约束见 §4.2.1 | 核心-only 构建里截图入口、MFA、移动端桌面远控、屏幕共享不再引用 `servers::`；MFA 与屏幕共享的重复后端删除且行为等价（§4.2.1） |
| S2 | `LogEmitter`、`control_permission_granted`（macOS 辅助功能 / 输入授权）、`ServerType::Rdp` 中被截图 / 使用的部分 | `servers/engine`、`servers/rdp/input/permissions.rs`、`servers/mod.rs` | 截图（含 `screenshot/scroll/input.rs`）、移动端窗口输入（`mobile/desktop/windows.rs`，v1.5 新增） | 核心里的小接口（`plugin/`、`capture/` 或新增 `platform_permissions/`） | 同上 |
| S3 | RDP 剪贴板 / 文件传输安全路径、位图编解码辅助（`rdp::session::{client_bitmap_codecs, read_clipboard_file_range, write_remote_file_chunk, remote_clipboard_safe_path, clipboard_relative_name, ensure_private_directory, process_is_alive, remote_top_level_name}`、`rdp::cliprdr`） | `rdp/session*`、`rdp/cliprdr.rs` | RDP 客户端、RDP 服务端（`servers/rdp/clipboard/*`）、`config/paths.rs` | 库 crate `taomni-rdp-common`（两个 RDP 插件各自静态链接）；`config/paths.rs` 用到的 `uri_list_to_paths` 搬进核心通用工具 | 两个 RDP 插件互不引用对方 crate；核心不引用 `rdp::` |
| S4 | RDP 信任表初始化（`rdp::tls::init_trust_table`） | `rdp/tls.rs` | `mobile/headless.rs` | 随 S6 的扩展点处理，或由 RDP 客户端插件在启用时自行初始化 | `mobile/` 不再直接引用 `rdp::` |
| S5 | 前端类型：`RdpOptions`、`VncViewerOptions`、`LaunchPreparation`（来自 sockscap）等被 `src/types/index.ts` 直接引用；`TabKind` 是封闭联合 | `src/types/*`、`src/lib/sockscap`、`src/lib/vncOptions` | 核心 `Tab` 类型 | `TabKind` 拆为 `CoreTabKind`（核心字面量）+ 插件在注册表里登记的开放字符串；Tab 的插件载荷用 `unknown` + 插件自己的类型守卫 | 核心 `src/types/index.ts` 不再 import 插件模块 |
| S6 | 终端 / 聊天观察者扩展点（`state.mobile.broker`、`mobile::events::EventSink`、SSH 键盘交互认证转发） | 核心 `terminal/*`、`chat/stream/*`、`agent/cc_bridge/mcp_*` 里直接调 `crate::mobile` | 仅 mobile | 核心定义 trait（如 `TerminalObserver`、`ChatStreamObserver`、`AuthPromptForwarder`），默认空实现；`plugin-mobile` 启用时注册实现 | 核心 `terminal/`、`chat/`、`agent/` 不再 `use crate::mobile`；未装 mobile 时终端 I/O 热路径无额外开销 |
| S7 | 本地推理扩展点（`asr` 本地引擎、`voice/streaming/local.rs`、终端 FIM 补全 `tab/fim_engine*`） | `asr/`、`voice/`、`tab/` | 核心 `ai/config/asr.rs`、`ai/mod.rs`、`llm/mod.rs`、终端补全 | 核心定义 `LocalSpeechEngine`、`LocalCompletionEngine` 接口；插件注册实现 | 未装插件时 ASR 只剩云端引擎、FIM 补全降级；`ai/`、`llm/` 不再 `use crate::asr` 的本地部分 |
| S8 | `webview_recovery` 对 `servers / screenshot / voice` 的引用 | `webview_recovery/mod.rs` | 核心 | 插件在注册表登记“窗口恢复策略”，核心遍历注册表 | 核心不再点名插件模块 |
| S9 | 备份对插件数据的引用（`mfa` 引用 `backup`；`backup/model.rs`、`backup/tests.rs` 点名 `mfa`） | `backup/`、`mfa/` | 备份 | `module.json` 新增 `backupPaths` 声明，备份读注册表（含未启用、未安装但数据仍在的插件） | 备份不点名插件模块；卸载插件后数据仍随备份走 |
| S10 | `state.rs` / `state/domains.rs` 对 `RdpSession、VncSession、ServerRegistry、SocksCapRuntime、MfaStore、MobileRuntime` 的持有 | `state.rs:77` | 核心 | 拆成 `CoreState + PluginRegistry`（§5.4） | 核心 `state.rs` 不再 `use` 插件类型 |
| S11 | 主二进制 re-exec 入口：`main.rs` 的 `--headless`、`--ssh-stdio-forward`、`--screenshot-scroll-input`（Win）、`--sockscap-redirector-bridge`（macOS）、`--vnc-special-key-hook`（Win，`lib.rs` 的 `run_vnc_special_key_hook`） | `src-tauri/src/main.rs`、`lib.rs` | 核心二进制自身拉起自己作为子进程 | 归属规则：`--ssh-stdio-forward`、`--screenshot-scroll-input` 属核心保留；`--vnc-special-key-hook` 随 `plugin-vnc-client`、`--sockscap-redirector-bridge` 随 `plugin-sockscap` 迁入各自宿主二进制（入口由宿主 `main` 解析）；`--headless` 见 S15 | 核心-only 二进制不含迁出入口的代码；迁出入口的行为用 Windows / macOS 原有用例或等价 fixture 验证；参数拼写与 `current_exe` 的调用方同步改 |
| S12 | 插件作用域数据密钥：`vault::MFA_DATA_KEY_ENTRY_ID`（`mfa.data-key-v1`）、`vault::is_protected_entry` | `vault/`、`mfa/crypto.rs` | `plugin-mfa`（以及未来有加密库的插件） | 核心 Vault 增加受限服务 `vault.fixed-key`（按插件 slug 作用域限定条目 id，由核心代为加解密或一次性下发数据密钥并绑定宿主会话，不落盘、不进日志）；宿主永远不持有 Vault 句柄、不直接解锁 Vault | 宿主不读 `vault.db` 也能打开自己的库；Vault 锁定 / 口令错误的错误码沿用 `ERR_VAULT_*`；条目保护规则不被插件绕过；备份还原后密钥与库同时回到一致状态（AC-016） |
| S13 | 备份快照与 profile 协同：`backup::snapshot_context::hot_backup_conn`（`mfa/store.rs` 使用）、`backup::coordination::ProfileLease`、还原的 `RESTORE_INTENT_FILE` / `JOURNAL_FILE` | `backup/`、`mfa/`、`lib.rs` | 备份 / 还原、多实例共享 profile | 核心经 RPC `backup.snapshot` 请求运行中的宿主产出一致快照（宿主进程内用 SQLite online backup）；未启用 / 未安装 / 宿主未运行的插件由核心按 `backupPaths` 直接拷贝；还原前核心先停全部宿主并持有独占 `ProfileLease`；宿主不得自行持有跨还原的文件句柄 | 对运行中、已禁用、未安装三种状态各有备份 / 还原用例；还原过程中无宿主残留写入（AC-011、AC-015、AC-016） |
| S14 | 移动端控制面：核心为 `plugin-mobile` 暴露的反向服务（写终端 / resize / 信号 / 打开会话、聊天流与 ACP 驱动、受管浏览器窗口、桌面窗口枚举与输入、屏幕采集） | `mobile/session_open.rs`、`mobile/desktop/*`、`mobile/im_adapter/*` 对 `terminal`、`chat`、`agent`、`webview_environment` 的直接调用 | 仅 mobile | 在 `taomni-plugin-api` 定义 `terminal.control`、`chat.control`、`desktop.input`、`capture.screen`、`window.create` 等 RPC 服务；Tauri 窗口只能由核心创建，宿主只发请求 | 宿主无法创建窗口或直接触碰核心 PTY；每个服务有权限项和速率 / 背压限制；未装 mobile 时这些入口无额外开销 |
| S15 | `--headless` 与 `ModeLease`：独立无 GUI 运行 mobile 服务 / 飞书适配，初始化完整 `AppState`（`mobile::headless::initialize`） | `mobile/headless.rs`、`mobile/headless_ops.rs`、`main.rs`、`lib.rs` | `plugin-mobile` | 先决策归属：（a）`--headless` 留核心，仅启动 `CoreState` 并拉起已安装的 `plugin-mobile` 宿主，未安装则明确报错退出；（b）整体随 mobile 暂缓留核心（DEC-2）。无论哪种，`ModeLease` 与 `ProfileLease` 的语义不变 | headless 与 GUI 同一 profile 的互斥 / 共享租约行为与现状一致；`Core::Headless` 路径有测试 |

约束：S1–S3、S5、S10 是 M0 阻塞项（不做完不能开始任何一个插件迁移）；S12、S13 必须在第一批（`plugin-mfa`）数据迁移前完成（TASK-013 的 MFA 实验可只验证进程、信任和生命周期，不读写加密库）；S11 在 VNC / SocksCap / mobile 批前完成；S4、S6–S9、S14、S15 随对应插件所在批次（§10）完成，但必须在该批次开始前有接口评审。

### 4.2.1 屏幕采集合并方案（S1 的落地设计，TASK-003 交付；用户 2026-11-15 决定合并）

**现状复核（`7bc498b35`）**：三者不是对等的三套引擎，而是一个流式引擎加两个层：

| 层 | 位置 | 实际内容 | 外部依赖 |
|---|---|---|---|
| E 流式引擎 | `servers/rdp/capture/**`（约 4.6k 行：`Frame`、`Capturer`、`create_capturer*`、`PortalInput`、X11 SHM+XDamage、Wayland PipeWire/portal、macOS 显示流/SCK、Windows WGC+GDI、`xcap_backend`、`stage_trace`） | 仅依赖 `LogEmitter`（只调用 `line()` 与 `clone()`）和 `control_permission_granted`；无 `tauri` 类型 | `x11rb`、`ashpd`/PipeWire、`objc2*`、`windows`、`xcap` |
| S 截图层 | `screenshot/capture/**`（约 1.5k 行） | Tauri 显示器模型 `DisplayInfo`、单帧 `capture_display`、录制/滚动用的 `FrameSource`、macOS CoreGraphics 一次性快照（`mac_snapshot.rs`，刻意避开显示流以规避 macOS 14 WindowServer 崩溃）、隐藏窗口后截图 `overlap.rs`、临时产物 `artifacts.rs`；Linux 与 Windows 录制建立在 E 之上，Windows/macOS 静态图直接用 `xcap` | E、`xcap`、Tauri |
| M MFA 采集 | `mfa/capture.rs`（341 行） | 独立实现：非 Linux 用 `xcap::Monitor::all()`；Linux X11 用 `x11rb` RandR 逐显示器读取；Wayland 用 `ashpd` 的 Screenshot portal（一次性，由桌面自身弹窗）；macOS 用 `CGPreflight/CGRequestScreenCaptureAccess`；另含灰度转换与剪贴板图片读取 | `xcap`、`x11rb`、`ashpd`、`objc2_core_graphics` |

> `sockscap/capture/` 是网络流量捕获，与屏幕采集无关，不在合并范围，仅需避免命名混淆。

**目标结构**

1. **库 crate `taomni-capture`**（`src-tauri/crates/taomni-capture/`，workspace 成员，不依赖 `tauri` / `wry` / 核心 crate）：
   - `engine`：由 E 原样迁入（`git mv` 保留历史），含全部平台后端与 `stage_trace`。
   - `CaptureLog` trait：`fn line(&self, msg: String)`，取代签名里的 `&LogEmitter`；可 `Clone`（`Arc<dyn CaptureLog>`）。这也让 `x11/tests.rs` 不再需要“没有 AppHandle 的变通”。
   - `permissions`：macOS 屏幕录制授权（`mac::permission_granted/request_permission`，与 M 的 `CGPreflight/CGRequest` 合并为同一实现；“授权重启后生效”的错误码映射仍由调用方持有）和辅助功能 / 输入授权 `control_permission_granted` / `request_control_permission`（自 `servers/rdp/input/permissions.rs`）。
   - `still`：一次性采集 API，策略显式化：`PersistentStream`（E 的 `Capturer`）、`PortalScreenshot`（Wayland 一次性 portal，保留 M 的“桌面自带弹窗、不留 ScreenCast 共享指示”行为）、`X11RandR`（M 的逐显示器读取，与 E 的 X11 后端共用连接与 RandR 解析）、`MacSnapshot`（S 的 CoreGraphics 一次性快照，**不得并入显示流路径**）、`Xcap`（仅 Windows/macOS，维持现有 cfg 门控）。`pixels` 转换（BGRA↔RGBA↔灰度）集中在此。
2. **核心模块 `src-tauri/src/capture/`**（依赖 Tauri）：`displays`（`DisplayInfo`、`list_displays`、`resolve_display`，自 `screenshot/capture/displays.rs`，供截图与 `mobile/desktop/capture.rs` 共用）、`source`（通用 `FrameSource`）、`log`（`CaptureLog` 的核心实现：写 `log` crate 并按需发 Tauri 事件，**不再冒充 `ServerType::Rdp`**）、`service`（插件宿主用的 `capture.still` RPC 服务，见下）、QA 注入点（`QA_DENY_CAPTURE` 等）。
3. **各调用方的归位**：

| 现代码 | 合并后 |
|---|---|
| `servers/rdp/capture/**` | `taomni-capture::engine`；`servers/rdp/*`（display、gfx、input、sound、probes）改为直接依赖 `taomni_capture`，RDP 服务端宿主静态链接该 crate |
| `screenshot/capture/{displays,source,frames,snapshot,pixels,permissions}.rs` | 通用部分迁入核心 `capture/`；`overlap.rs`、`artifacts.rs`、`display_at_cursor`、`display_for_window`、滚动截图专用 `for_scroll` / `portal_scroll` 留在 `screenshot/`，只依赖 `capture/` |
| `mfa/capture.rs` | 删除全部后端（`capture_x11`、`capture_portal`、xcap 分支、`ensure_screen_permission`），改调 `still`；MFA 只保留灰度编码 `encode_frames`、`read_clipboard_image` 和二维码扫描逻辑；隐藏 Taomni 窗口再采集（`capture_screens_hiding`）属 Tauri 窗口操作，留在核心 |
| `mobile/desktop/capture.rs` | 路径改为 `crate::capture::displays/still`，行为不变 |
| `screenshot/scroll/input.rs`、`mobile/desktop/windows.rs` | `control_permission_granted` 改指 `taomni_capture::permissions`（S2） |

**与插件形态的关系（G2 / G5）**

- 采集若发生在宿主进程，macOS 的屏幕录制与辅助功能授权归属宿主（G2）。因此默认路径是：**截图入口、MFA 扫描、移动端桌面远控在核心内采集**，`plugin-mfa` 通过 RPC `capture.still`（权限 `capture.screen`）取灰度帧，不携带任何采集后端，也就不触发 G2。该服务需要 TASK-002 的协议支持大二进制载荷旁路（帧不走 JSON stdio）。
- 流式热路径（`plugin-rdp-server` 屏幕共享）不能走 RPC 逐帧转发，宿主静态链接 `taomni-capture` 直接采集。若 G2 在 macOS 失败，则这两类宿主改为请求核心 `capture.stream`（loopback WS + 一次性 token，沿用 §5.0 的数据通道模式），`Capturer` 接口不变，故合并后的接口两种部署都能承载；该例外按 DEC-2 记录。
- 因此合并不改变“核心与插件互不依赖”：核心与宿主共同依赖的是库 crate（与 `taomni-rdp-common` 同类），不是彼此。

**保持行为的约束（TASK-003 必须逐项验证，不能只靠编译通过）**

1. Linux 不得因合并引入 `xcap` / libgbm / EGL 依赖（`mfa/capture.rs` 注释明确要避免）；`cargo tree --target x86_64-unknown-linux-gnu` 中 `taomni-capture` 不含 `xcap`，Windows / macOS 保持原 cfg 门控。
2. macOS 静态图与录制继续用一次性 CoreGraphics 快照，不得改走显示流；RDP 服务端继续用显示流 / SCK。
3. Wayland 三条路径各自保留：E 的 PipeWire ScreenCast（流式）、截图的指定显示器流（`try_new_for_monitor`）、M 的 Screenshot portal（一次性）；每条都有对应测试，不得合并成其中一条而改变弹窗次数和授权提示。
4. 日志不再写入 Servers/RDP 日志面板：先 `grep` 现有 Vitest / QA 用例是否断言这些行，有则更新，并在修订记录写明这是有意的行为变化。
5. `Frame` 的 BGRA、自顶向下、紧密 `stride` 约定不变；RDP 服务端 `BitmapUpdate` 零转换路径不退化（`rdp-probe` / `TC-RDPS-PERF-01` 预算内，AC-013）。
6. MFA 灰度帧的尺寸、顺序和 `ERR_*` 错误码不变；QA 的 hosted scan 保留路径（`retain_hosted_qa_scan`）不变。

**实施顺序（每步单独提交、单独可回退）**

1. 引入 `CaptureLog` 并改引擎签名（不搬文件）；补不依赖 `AppHandle` 的单测。
2. 建 `taomni-capture` crate，`git mv` 引擎；在 `servers::rdp::capture` 保留临时 `pub use` 垫片，调用方先不动。
3. 迁移 `permissions`（含 `control_permission_granted`），`servers/rdp/input` 与 macOS 路径改引用。
4. 建核心 `capture/`，迁 `displays` / `source` / `pixels`，截图与 `mobile/desktop/capture.rs` 改引用；`overlap` / `artifacts` / 滚动留截图。
5. MFA 改用 `still`，删除其重复采集后端。
6. 删除垫片；`scripts/refactor-boundaries.mjs` 增加规则：`screenshot/`、`mfa/`、`mobile/`（`headless.rs` 的建表除外，由 TASK-018/S15 处理）不得 `use crate::servers`；`taomni-capture` 不得依赖 `tauri` / `wry`。
7. 回填证据：各步 `cargo test --lib` 过滤结果、三目标 `cargo check`、下表 case。

**验证入口**：静态——`grep -rn "servers::" src-tauri/src/{screenshot,mfa,mobile}` 仅余 S15 例外；`cargo tree -p taomni-capture`。单测——随代码迁移的 `x11/tests.rs`、`wayland/tests.rs`、`screenshot/capture/tests.rs`、macOS tests、`mobile/desktop/tests.rs`。UI/native（当前平台实跑，其余平台只做 `cargo check` 并记录未验证）——`TC-104-capture-toolbar`、既有截图 still / 录制 / 滚动截图 case、`TC-MFA-007`、`TC-MFA-106`、`TC-MOBILE-020/021`、`TC-RDPS-NAT-01`、`TC-RDPS-PERF-01`。

### 4.3 `plugin-screenshot` 的实际边界（v1.3 更正）

v1.2 把整个 `screenshot/`（21,995 行）列为插件代码位置，但同时又决定“入口留核心”，两者矛盾：Overlay、标注、贴图、收藏、采集、快捷键都是“入口”的一部分。按 v1.3 实测拆分：

| 部分 | 行数（实测） | 归属 |
|---|---|---|
| `qa/`（夹具与 QA 驱动） | 8,091 | 核心（仅 QA / 开发构建使用） |
| `scroll/`、`scroll_commands.rs`、`scroll_input.rs`（滚动长截图） | 约 2.3k | **核心**，DEC-4 已定；它与 Overlay、采集和截图入口紧耦合 |
| `capture/`、`capture_exclusion`、`overlay_*`、`surfaces`、`pins`、`edit`、`favorites`、`shortcut*`、`window_lifecycle` 等 | 约 7k | 核心（入口） |
| `ocr.rs`、`ocr_windows.rs`（+ 前端 `screenshotOcr.ts`、`tesseract.js` 与 `@tesseract.js-data/*` 语言包） | 约 0.74k | **插件** |
| `record/`、`recording_commands.rs`（+ `RecorderBar`，`openh264 / mp4 / gif` 编码器） | 约 1.55k | **插件** |

结论：该插件的 Rust 代码量约 2.3k 行，真正的体积收益来自 `tesseract.js` 语言包与视频编码器依赖，不是源码行数。M0 要产出文件级拆分表（逐文件标“核心 / 插件”），并实测拆出后核心包体积增量；拆分表必须同时列出 `Cargo.toml` feature、前端 chunk 和 Linux 包依赖，避免只移动源码目录而没有改变产物。

### 4.4 `plugin-nettools` 与 `plugin-ai-voice-local` 的实际边界（v1.3 更正）

- **`plugin-nettools`（已取消，DEC-3）**：实测它只剩 82 行的 `ProxyTestTab`；Rust 侧 `proxy/` 是被 8 个以上核心模块引用的网络基础设施，必须留核心。用户 2026-11-14 决定“先删除这个功能，其实也没有实现”，该插件不再出现在清单中，也就没有“纯前端插件”需要验证（§5.0）。
- **`plugin-ai-voice-local`**：只含“本地”推理（Whisper / Sherpa / SenseVoice / llama.cpp）。云端 ASR（Deepgram 等）、麦克风采集（`cpal`，`voice-capture` 特性）、文本清理与词表是云端与本地共用的，留核心，因此 `Cargo.toml` 里 `voice-capture` **留在核心默认特性**；v1.2 §5.4 写的“语音采集归 plugin-ai-voice-local”更正为“本地推理归插件，采集留核心”。另外 v1.2 说“已有 llama.cpp sidecar 前例”，实测没有已打包的 llama.cpp sidecar：`llama-cpp-2` 是可选的进程内依赖（`local-llm-fim`，被终端 FIM 补全使用），`llm/gpu_detect.rs` 里提到的 `llama-server` sidecar 只是从缓存目录探测；所以本地模型走插件宿主进程是新建，不是复用。

### 4.5 `plugin-mobile` 的可拆性（v1.3 新增，v1.5 扩充）

`mobile/` 是 11 个有效插件里与核心耦合最深的（§1.8）：核心终端 I/O 热路径直接持有 `state.mobile.broker`，聊天流和 Claude Code 桥接也点名它。它能不能在第一版拆成插件，取决于 S6 的观察者扩展点能否在不改变终端行为、不增加热路径开销的前提下做出来。处理：

**v1.5 新增事实（分支上的新代码）**：

- 桌面远控：`mobile/desktop/capture.rs` 经 `screenshot::capture::{list_displays, resolve_display, capture_display}` 采集屏幕；`windows.rs`（548 行）枚举窗口、聚焦并注入键盘输入，macOS 上用 `NSRunningApplication` 并检查 `servers::rdp::control_permission_granted()`；`browser.rs` 创建受管 WebView 窗口（依赖核心 `webview_environment`）。屏幕查看默认关闭（fail-closed），策略存于 `mobile-desktop-remote.json`。宿主进程做这些事时，macOS TCC 归属是 G2 的直接对象。
- 飞书 / IM 适配（`im_adapter/`）：出站网络、卡片、通知，并经 `terminal::*_inner`、`chat::chat_stream_inner`、`agent::acp_bridge` 驱动核心；出口必须走核心代理（`proxy` 在 `mobile` 中已有 5 处引用）。
- `--headless`（`main.rs`）与 `ModeLease`（`lib.rs`）：mobile 可脱离 GUI 运行，`Core::Headless(AppState)` 与 `Core::Desktop(AppHandle)` 并存；`headless::initialize` 建 `servers` 表、`rdp` 信任表、`MfaStore`——这些会随各自插件迁出而失效。
- 前端没有独立目录：设置页、`useMobileBridge`、终端连接都点名 mobile（§1.8.1）。

**决定（用户已按建议确认，2026-11-15；不改变 DEC-2 范围）**：因为四类扩展点（观察者 S6、控制面 S14、headless S15、桌面远控）互相牵连，建议把 mobile 的 go/no-go 放在 M0 末——以 G2、G5 结果和终端热路径开销原型为依据，而不是等到 M2 最后一批；排期默认假设按 DEC-2 暂缓（`mobile` 暂留核心）以免关键路径被它拖住，若原型证明可行再拉回首发。

- 放在 M2 最后一批（④），并设“可拆性验收”：S6、S14、S15 完成后核心 `terminal/`、`chat/`、`agent/`、`lib.rs`、`main.rs` 不再引用 `crate::mobile`，且终端吞吐 / 输入延迟基线不退化（`qa-ui-auto` 终端性能用例）；`TC-MOBILE-012/013` 在装有 `plugin-mobile` 的全量集合中通过。
- 若验收不过，该插件允许暂缓出第一版（`mobile` 暂留核心），但须在 §13.4 写明，不静默缩水（沿用 §12 第一行规则）。这是对 §13.1“首批全部非核心模块”的受控例外，需用户知情（DEC-2）。

**首发决定（2026-11-22）**：按 DEC-2 将 Mobile 保留在基座。终端 SSH、聊天审批和 Agent 仍直接依赖 Mobile 的运行时，独立宿主缺少可供验收的终端热路径及 macOS 权限回执。首发保留移动端连接、桌面远控、飞书适配和 `--headless`。核心回归选择继续包含 Mobile。签名目录用 `releaseExceptions` 公开归属，Release 说明同步展示，首发自动安装名单包含实际发布的独立模块。

---

## 5. 插件运行时架构（P1 核心工作）

### 5.0 可行性审查与插件形态（v1.3 新增，替换 v1.2 §5.4 的“进程内 cdylib”）

v1.2 的方案是：每个插件是 `crate-type = ["cdylib", "rlib"]` 的 Cargo crate，“核心通过 Tauri 插件机制加载，不用 `dlopen` 手写加载器”，启用 / 禁用后重启生效。审查结论：**这个方案在技术上不成立**，原因有 6 条，前 3 条是硬阻塞：

1. **Tauri 插件是编译期注册的**：`tauri::plugin::Builder` 通过 `Builder::plugin(...)` 在构建应用时挂载，没有“运行时从磁盘加载一个 Tauri 插件”的机制。要加载下载来的 `.dll / .so / .dylib`，必须手写 `dlopen`，与“不用 dlopen”自相矛盾。
2. **Rust 没有稳定 ABI**：核心与插件分开编译（插件由单独的 CI 任务出包），只要边界上出现 `tauri::AppHandle`、`tokio` 类型、`serde` 类型、`dyn Trait`，就必须保证 rustc 版本和所有依赖版本逐位一致，否则是未定义行为。唯一安全的边界是 `extern "C"` + 自描述数据（JSON / 二进制块）。v1.2 的 `PluginRegistry: HashMap<PluginId, Box<dyn PluginState>>` 正是跨 ABI 的 `dyn Trait`。
3. **Tauri 的权限（capability）与窗口白名单是编译期的**：`src-tauri/capabilities/default.json` 在构建时嵌入二进制（§1.8），运行时不能为插件新增权限；v1.2 `module.json` 里的 `"capabilities": ["core:window:allow-set-size", ...]` 无法生效。
4. **macOS 校验**：发布包是 ad-hoc / 自签名、没有 Developer ID，`Entitlements.plist` 没有 `disable-library-validation`（§1.9）。启用 hardened runtime 时，进程不能加载签名身份与自己不同的 dylib；Apple Silicon 上任何下载来的原生代码还必须至少带 ad-hoc 签名。
5. **崩溃与卸载**：进程内 cdylib 的崩溃 / 未定义行为会带走整个应用，且 Rust 动态库不能安全卸载，“禁用立即生效”做不到，只能重启。
6. **运行时重复**：每个 cdylib 静态链接一份自己的 `std` / `tokio`，各自一个运行时、一份全局状态，与核心共享的不是类型而只是内存地址。

**v1.3 形态（DEC-1，用户已定选 A；M0 验证门 G1–G11 不通过时回到 DEC-1 重议）：插件 = 前端 chunk（可选）+ 原生插件宿主可执行文件（可选）。**

| 部分 | 形态 |
|---|---|
| 原生部分（Rust） | 独立可执行文件 `taomni-plugin-<slug>(.exe)`，由核心在插件启用时（或首次使用时）拉起；核心与宿主通过**控制通道**（stdio 上的 JSON-RPC 2.0，带 `apiVersion` 握手）通信；高带宽数据（RDP / VNC 帧、录屏帧）走宿主自己绑定的 `127.0.0.1` 随机端口 + 一次性 token 的 WebSocket，由主 WebView 直连——这正是现有 `rdp/ws.rs`、`vnc/ws.rs` 已经在用的模式，不是新发明 |
| 前端部分 | 独立 ES module chunk，在主 WebView 内动态 `import()`（§5.3）；前端经核心通用命令 `plugin_invoke(slug, cmd, payload)` 调用宿主，核心按 `module.json` 的命令清单与 `permissions` 校验后转发 |
| 纯前端插件 | 没有宿主可执行文件（当前清单里没有这类插件，机制保留供将来使用） |
| 核心 ↔ 插件契约 | 新增 `taomni-plugin-api` crate（协议消息类型、握手、`serve()` 宿主入口、扩展点 trait 的消息形式）；插件宿主只依赖它与库 crate（如 `taomni-rdp-common`），不依赖核心 crate |

与 v1.2 相比的收益：没有 ABI 问题；插件崩溃不带走核心，可自动重启并给用户明确错误；启用 / 禁用 / 升级不用重启应用，也不需要为每个插件写“卸载”逻辑（结束进程即可）；应用退出时统一回收宿主进程（宿主在控制通道断开时自行退出；Windows 用 Job Object、Linux 用 `PDEATHSIG` 兜底；macOS 没有等价机制，靠控制通道断开 + 下次启动清扫，G6 验证），SocksCap / 内置服务器 / RDP 服务端本来就需要这种独立进程清理（§5.5）。代价：每个插件的 Rust 命令要从 `#[tauri::command]` 改成“JSON 消息处理函数”（`commands/*.rs` 里 `tauri::generate_handler!` 的包装层要重写，见 §1.8 命令分发现状）；核心共享服务（Vault 引用、会话读取、设置读取）要通过 RPC 暴露；多一个进程的内存；macOS / Windows / Linux 对“下载来的可执行文件”各有拦截（见下）。**Vault 凭据的处理规则**：宿主平时只持有 `vault:` 引用；RDP / VNC / 内置服务器等必须自己完成协议认证的插件，由核心在“建立连接”这一刻经 RPC 一次性下发该会话所需的明文，绑定会话 ID、不落盘、不进日志，宿主用完即丢（§9）。

**M0 验证门（不通过则不得开始 M2，结果写入 §13.4）：** 用 hello-plugin + 一个真实原生插件（建议 `plugin-mfa`，最小）验证下列各项，每项记录命令、环境、证据：

| # | 验证项 | 通过标准 |
|---|---|---|
| G1 | macOS ad-hoc / 自签名发布包能否拉起下载来的、同一签名身份签名的宿主可执行文件 | 在 hardened runtime 开启的包上拉起成功；写明 `codesign` 身份与 `spctl` 结果 |
| G2 | macOS 屏幕录制 / 辅助功能（TCC）授权的归属：由核心拉起的宿主进程做屏幕采集、输入注入，授权算谁的（对象含截图引擎、`plugin-rdp-server`、`plugin-mobile` 的桌面窗口输入与屏幕采集、`plugin-mfa` 的屏幕扫描） | 若算宿主自己的 TCC 主体，截图引擎与 `plugin-rdp-server` 的采集需要二次授权，且升级后 cdhash 变化会再次失效（见 `docs-issue/macos-screenshot-permission-and-signing.md`）；此时这两类能力改走核心内 `capture/`（§4.2 S1）或由 DEC-2 例外处理 |
| G3 | Windows 下载到应用数据目录的宿主在系统防护下启动 | 沿用 main 的发布方式，接受未签名安装件。记录 Authenticode 状态、下载区域标记、Defender 和可观察的 SmartScreen 结果，实际启动候选宿主。 |
| G4 | Linux：deb / rpm / AppImage 下应用数据目录是否可执行（`noexec` 挂载） | 不可执行时的明确报错与替代目录 |
| G5 | 数据通道吞吐：RDP 帧经宿主进程 + loopback WS，与现有进程内路径对比 | 输入到画面的 p95 可比原验收上限增加最多 100%，以 65 ms 为基准，模块化验收上限为 130 ms。首帧 ≤ 500 ms，动画 ≥ 25.6 fps，带宽 ≤ 4905 kbps，沿用原用例的采样和画面验证。 |
| G6 | 应用崩溃 / 强杀后宿主进程是否残留 | 三端都不残留，或有下一次启动的清扫 |
| G7 | 启用 / 禁用 / 升级 / 回滚是否都不需要重启核心 | 通过 |
| G8 | 安装包、`module.json`、`modules.json` 的篡改和路径穿越 | 任意包内容、清单、签名文件、`dataDir`、`backupPaths` 被篡改或包含 `..` / 符号链接时拒绝安装，不覆盖当前版本，并留下可诊断错误 |
| G9 | 核心-only 依赖闭包 | 核心构建的 `cargo tree`、前端产物和 bundle 资源均不包含已迁移插件的原生依赖、语言包、helper 或插件 chunk；结果保存到 M0 基线报告 |
| G10 | RPC 契约、超时、取消和重复请求 | 握手版本不兼容、未声明命令、未授权权限、超时、宿主崩溃、重复 request id 均得到稳定错误码；取消后宿主和 loopback WS 不再持有该请求资源 |
| G11 | 多进程 profile 协同与入口模式（v1.5） | 宿主与 `ProfileLease` / `ModeLease` 协同：备份还原前所有宿主静默并释放文件锁；`--headless` 与 GUI 共享 profile 时宿主不重复启动或有明确错误；迁出的 re-exec 入口（`--vnc-special-key-hook`、`--sockscap-redirector-bridge`）由宿主二进制承载且核心-only 二进制不再含其代码（S11、S13、S15） |

G4 的宿主启动和监督重启先检查已验签宿主所在文件系统的 `ST_NOEXEC`。受限时返回 `MODULE_HOST_NOEXEC` 和协议 `PermissionDenied`，并显示实际路径和恢复指引。用户正常退出并备份后，将受支持的数据复制到允许执行且归自己所有的文件系统，保留应用标识目录结构，再通过新的 `XDG_DATA_HOME` 启动。原数据和历史 LanChat 库保留在原位置。`TC-MODULES-024` 检查挂载限制、真实宿主拒绝和卸载限制后的读写恢复。正式格式的 QA 候选 deb、RPM 和 AppImage 均验证了可执行目录搬迁及原 MFA 数据读写。 [Linux 安装验证](taomni-modular-installed-upgrade-verification.md#linux-安装格式的-noexec-恢复)

**备选方案（DEC-1 选项 B）**：进程内 cdylib，但边界收窄为 `extern "C"` 的单入口 `taomni_plugin_call(json) -> json` + 事件回调，加 `libloading` 手写加载器、macOS 加 `disable-library-validation` 并确认签名身份一致、插件禁用 / 升级一律重启应用。它保留了低延迟与单进程，但保留了崩溃拖垮核心、无法热卸载的缺点，并要把 `Entitlements.plist` 放宽（安全面扩大）。v1.3 不推荐，仅在 G5 不通过时回到这里重议。

**安全边界（必须写入实现和发布说明）**：宿主进程隔离的是原生崩溃、资源生命周期和特权 helper；插件前端 chunk 仍在主 WebView 内运行，和核心前端拥有同等 Tauri 调用能力。`permissions` 是核心对宿主 RPC 的 allowlist，不是前端沙箱，也不能阻止官方插件前端直接调用已暴露的核心命令。P1 因此只发布经过签名的官方插件；第三方插件、iframe / 独立 WebView 沙箱、细粒度前端 capability 均不在本版范围。实现任务必须增加“官方包签名 + chunk hash 与包 hash 绑定 + 不加载未注册 slug”的检查，避免把签名误解为运行时权限隔离。

### 5.1 模块清单 `module.json`（每个插件一份，随包发布）

```json
{
  "id": "taomni-plugin-rdp-client",
  "slug": "rdp-client",
  "name": "RDP 客户端",
  "version": "0.5.9",
  "coreApiVersion": "1",
  "kind": "remote-client",
  "status": "stable",
  "platforms": ["windows-x86_64", "darwin-aarch64", "darwin-x86_64", "linux-x86_64"],
  "entry": { "host": "bin/taomni-plugin-rdp-client", "frontend": "frontend/index.js", "protocol": 1 },
  "tabs": [{ "kind": "rdp", "title": "RDP" }],
  "commands": ["connect", "disconnect"],
  "permissions": ["vault.ref", "session.read", "network.egress", "fs.dataDir", "window.open"],
  "dataDir": "plugins/rdp-client",
  "dataSchemaVersion": 1,
  "backupPaths": ["plugins/rdp-client/data/data.db"],
  "legacyTables": ["rdp_certificate_pins"],
  "vaultFixedKeys": [],
  "snapshot": "rpc"
}
```

字段说明：

- `id` 是全局唯一标识（`taomni-plugin-<slug>`）；`slug` 是短名，用于 IPC 命名空间、数据目录、仓库路径（`src-tauri/plugins/<slug>/`）、窗口标签（`plugin-<slug>-*`），文档里 `plugin-xxx` 的简写都指 `taomni-plugin-xxx`。
- `coreApiVersion` 是兼容矩阵的键（§7.2）；`entry.protocol` 是核心 ↔ 宿主 RPC 协议版本，两者分开：前者管“核心接口形状”，后者管“线上消息格式”。
- `kind` 取值 `remote-client / local-server / collaboration / media / auth / ai-local / mobile`，仅用于商店分类与权限模板，不做运行时分发。
- `permissions` 是**核心自己定义并在 `plugin_invoke` 与 RPC 处强制的权限集**（不是 Tauri capability，见 §5.0 第 3 条）；取值范围由核心维护，插件不得自声明集合之外的值，新增取值需评审；商店安装确认页把它展开成人话（§6.2）。
- `platforms` 与 `release.yml` 的实际矩阵一致（目前 `windows-x86_64`、`darwin-aarch64`、`darwin-x86_64`、`linux-x86_64`；v1.2 示例里的 `windows-aarch64` 当前不存在）。
- `dataDir` 标识 `plugins/<slug>` 命名空间；宿主只写其 `data/` 子树，`versions/`、active 指针、信任和控制记录由核心管理。`dataSchemaVersion` 为正整数，旧 manifest 缺省为 1；`backupPaths` 只能是该 owner 的 `plugins/<slug>/data` 或其后代，不接受核心路径、其他 owner、代码/指针、链接/reparse、路径穿越及重复大小写路径。它只声明数据位置，不授予执行或 Vault 权限。卸载保留数据时先在核心控制的 `plugins/.retained-data/<slug>.json` 原子记录数据 schema 和受限文件分类，再移除 active 指针；备份必须独立于代码安装状态发现这些数据，详见 [TASK-025 §8–9](taomni-modular-vault-services-plan.md)。
- `legacyTables`（v1.3 起写入 §8.2，v1.5 补进示例）：声明旧版留在 `taomni.db` 的表，核心经只读 RPC `legacy.read` 供迁移；`vaultFixedKeys`：插件作用域的 Vault 固定条目（S12，如 `mfa.data-key-v1`）；`snapshot`：`rpc`（运行中的宿主经 `backup.snapshot` 产出一致快照）或 `file`（直接拷贝文件，S13）。
- `permissions` 初始取值草案（核心维护，新增需评审）：`vault.ref`、`vault.session-secret`（连接时一次性明文）、`vault.fixed-key`（S12）、`session.read`、`network.egress`、`fs.dataDir`、`window.open`、`capture.screen`、`terminal.observe`、`terminal.control`、`chat.observe`、`chat.control`、`desktop.input`、`backup.snapshot`；后八项主要由 `plugin-mobile`、`plugin-mfa`、截图相关插件使用（S6、S14）。
- `status` 取 `stable / provisional`；为 `provisional` 并附 `removalCandidate`（§4.1）。
- **没有 `signature` 字段**（v1.2 把签名与公钥写在 `module.json` 里，等于让被校验的包自带验证公钥）：签名是包旁边的分离文件（`.minisig`），公钥只用核心二进制里内置的那一把（§9）。

### 5.2 注册表与生命周期

- 发现：核心启动时扫描 `应用数据目录/plugins/<slug>/module.json`，校验签名记录、`coreApiVersion`、当前平台，合法的进注册表，不合法的进“已禁用（原因）”列表，不静默丢弃。启用状态存在核心设置里，不存在插件目录里。
- 生命周期：`installed → enabled → disabled → uninstalled`；`enabled` 才允许注册 tab、命令、窗口恢复策略、备份路径并拉起宿主；`disabled` 保留数据、结束宿主进程、不加载前端 chunk；`uninstalled` 删代码、不删数据（除非用户显式勾“同时删除数据”）。
- 热加载：前端 chunk 用动态 `import()`，宿主进程可随时拉起 / 结束，**启用、禁用、升级、回滚都不需要重启应用**（前提是 DEC-1 选 A；选 B 时恢复“Rust 部分重启生效”）。
- 宿主进程管理：核心负责拉起（空闲不常驻的插件可懒启动）、握手、心跳、崩溃重启（限次，超限标“已崩溃”并显示错误与日志入口）、退出时统一回收。
- 缺失处理：tab 记录指向未装插件时，`TabContentRouter` 渲染“未安装”占位页（插件名、简介、去商店安装按钮），不白屏；会话记录指向未装插件的 tab 类型时，欢迎页恢复跳过该条并提示，不阻塞其它恢复；新建会话时，RDP / VNC 类型在插件未装时仍可新建与编辑（会话记录归核心，§1.6），仅“连接”动作进入占位页。

### 5.3 前端拆分

- 核心 tab 保留静态入口，包括 terminal、sftp、database、code-workspace 和隧道管理器 `nettools`。`TabContentRouter.tsx` 通过 `React.lazy` 和模块注册表加载 mail、mail-unified、rdp、vnc、servers、sockscap 和 mfa 等模块 tab。已保存的邮件会话及恢复信息归核心。`TabKind` 使用核心字面量和模块登记的开放字符串（§4.2 S5）。LanChat 已从注册表移除。
- 每个插件前端是一个独立 Vite 构建（`frontend/index.js`），单独打 chunk，不进核心 `dist`；`src/stubs/` 的浏览器预览为每个插件提供桩，桌面-only 效果不得泄漏桩假设（沿用现有 `src/stubs/` 规则）。
- **插件 chunk 必须使用宿主提供的 React 与共享库**，不得各自打包一份：两份 React 会让 hooks 失效。构建时把 `react`、`react-dom`、`zustand`、`lucide-react`、i18n、`ipc` 等标成 external，运行时由核心通过 `globalThis.__taomniHost` 或 import map 解析；这批共享面就是“前端插件 SDK”，版本绑定 `coreApiVersion`，列入 §7.1。
- **加载来源与 CSP**：现有 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`，应用数据目录里的 chunk 无法直接加载。方案：核心注册一个自定义 URI scheme（如 `taomni-plugin://<slug>/<file>`）只服务 `plugins/<slug>/frontend/**`，并仅把这个 scheme 加进 `script-src`；不放宽 `assetProtocol` 范围（当前只放行 `$APPDATA/ai-generations/**/*`）。分支上的 `viewer::register_protocol` 已经在 `lib.rs` 的 `tauri::Builder` 上注册了 `taomni-preview`，并把 `taomni-preview:` 与 `http(s)://taomni-preview.localhost` 加进 `frame-src`（Windows / Android 上自定义协议以 `http(s)://<scheme>.localhost` 形式出现，所以插件 scheme 也必须同时登记这两种形式）。插件 scheme 沿用该注册模式，`csp` 与 `devCsp` 两处同步修改并保留预览项，不得引入 `unsafe-inline` 脚本；vendored `wry` 的“只对主框架注入 IPC 凭据”保证必须保持（§3.9）。CSP 变更属安全敏感变更，需单独评审。
- **安全边界说明**：插件前端跑在主 WebView 里，和核心前端同权，能调用任何核心 `invoke`；`permissions` 只约束宿主 RPC，约束不了前端 JS。因此第一版“只卖官方、全部签名”是安全前提，不是产品取舍；若将来开放第三方插件（§13.3），前端必须改为 iframe / 独立窗口沙箱，是重新设计，不是加个开关。
- 分离窗口（`components/detached/DetachedSessionWindow.tsx`、`screenshotOverlayRoot.tsx` 等）是独立 WebView：插件注册表、`__taomniHost` 共享面和 chunk 加载必须在这些窗口入口同样初始化，不能只在主窗口 `App.tsx` 初始化（§1.8.1）。
- 共享 UI（菜单、侧栏、设置页）由核心提供插槽：插件只声明“我要在侧栏 / 设置页挂一个入口”，不直接改核心组件。插件窗口（RDP / VNC 分离窗口、截图工具窗等）使用标签 `plugin-<slug>-*`，核心静态 capability 一次性放行该模式（现有 `rdp-*`、`vnc-*` 等标签迁移到新模式，已移除能力的旧标签不再注册）。

### 5.4 Rust 拆分

- **工作区**：插件宿主 crate 放在 `src-tauri/plugins/<slug>/`，作为现有 `src-tauri/Cargo.toml` `[workspace]` 的成员（当前 members 只有 `vendor/ironrdp-*`）。原因：`[patch.crates-io]`（libspa、IronRDP、portable-pty 等 vendor patch）只在工作区根生效，插件 crate 必须在同一工作区才能复用同一张 patch 表，不各自 patch 一份。v1.2 写的仓库根目录 `plugins/` 不能满足这一点。
- 新增两个库 crate（不是插件）：`taomni-plugin-api`（协议与宿主 SDK）、`taomni-rdp-common`（§4.2 S3）。核心通过同一协议调用宿主，不 `use` 任何插件 crate。
- `AppState` 拆成 `CoreState + PluginRegistry`（沿用 `state/domains.rs` 的分域方向）：核心 State 只留 §3.1 的共享服务与 §4.2 下沉的能力；`PluginRegistry` 只保存插件元数据、宿主进程句柄与 RPC 客户端，**不保存插件内部状态**（v1.2 的 `Box<dyn PluginState>` 删除）。
- 命令：`commands::handle`（`commands/mod.rs:59`）在现有逐名匹配之后增加一个兜底分支，把 `plugin_invoke` 转交注册表；插件命令不再进核心 `generate_handler!`。前端 `src/lib/ipc.ts` 按领域分文件（现有 `src/lib/ipc/*.ts` 已部分如此），插件命令统一经 `invokePlugin(slug, cmd, payload)`。
- `Cargo.toml [features]` 的重型默认特性：`asr-whisper、asr-sherpa` 从核心默认特性拿掉（归 `plugin-ai-voice-local`）；LanChat 及其历史 `native-av` feature 已删除；`hbase-kerberos` 留核心；`rdp-server-audio` 归 `plugin-rdp-server`；**`voice-capture`（cpal 麦克风采集）留核心**（云端 ASR 也要用，§4.4）。
- 插件宿主 crate 的依赖白名单：只能依赖 `taomni-plugin-api`、库 crate 和第三方协议库，**不得依赖 `tauri`、`wry`、`tauri-utils`**（根 `[patch.crates-io]` 已含 vendored `wry`、`tauri-utils`，宿主引入它们等于把 WebView 栈带进每个插件），也不得依赖核心 crate。
- `main.rs` 的 re-exec 入口按 §4.2 S11 的归属表迁移。
- `sockscap-helper` 和 `mitmproxy-redirector-poc` 随对应插件迁入插件 crate。QA 探针 `rdp-probe` 已移入独立的 `src-tauri/crates/taomni-rdp-probe/`，由 QA 构建编译并随对应测试运行时上传。

### 5.5 特权 / 重型模块的进程边界

按 §5.0 推荐形态，所有带原生部分的插件都是宿主进程；本节只回答“哪些还需要**额外**的独立提权进程或外部 daemon 监督”：

| 插件 | 进程结构 | 理由 |
|---|---|---|
| `plugin-sockscap` | 插件宿主 + 既有提权 helper（`sockscap-helper`） | 要提权、要装驱动、要抓包；helper 与宿主分离的现状保留；卸载 / 更新前由宿主执行清理（§9），Windows NSIS 里的 helper / WinDivert 清理（`nsis/hooks.nsh`）迁入该插件 |
| `plugin-servers`（SSH / SFTP / HTTP 等，不含 RDP / VNC Server） | 插件宿主 | 内置服务器是长驻服务，应用退出时要独立清理 |
| `plugin-rdp-server` | 插件宿主 | RDP Server 是长驻服务，输入注入与录屏权限边界单独审计；应用退出时独立清理；macOS TCC 归属见 G2 |
| `plugin-vnc-server` | 插件宿主，监督外部系统 VNC daemon（不自研引擎） | 监督外部 daemon，不自带提权路径；启停随 daemon |
| `plugin-ai-voice-local` | 插件宿主（内含推理线程，必要时再拉起 `llama-server` 类子进程） | 模型推理是重型工作，独立进程可独立重启、独立限流；v1.2 所说“已有 llama.cpp sidecar 前例”实测不成立（§4.4），这里是新建 |

其余带原生部分的插件（RDP / VNC 客户端、截图 OCR / 录制、MFA、mobile）也是宿主进程，但无额外 helper。

### 5.6 共享服务与扩展点（核心提供，插件只调接口）

- **共享服务**（宿主经 RPC 调用，受 `permissions` 约束）：会话（读会话配置、订阅会话变化）、Vault（给 `vault:` 引用；连接时一次性明文和插件作用域固定数据密钥是两条受限例外，S12）、备份快照（`backup.snapshot`，S13）、设置（读核心设置，插件自己的设置存在自己目录）、更新（只读核心版本）、i18n（插件自带语言包，核心只给当前语言）、屏幕采集（§4.2 S1）、Tao Agent 工具总线（插件可注册工具，但要过 §9 的 scope 检查与确认制，不得绕过安全路径）。
- **扩展点**（核心定义接口，插件注册实现，未注册时核心有明确降级行为；这些接口取代“核心直接 `use` 插件模块”）：终端 / 聊天观察者（S6，mobile）、终端 / 聊天 / 桌面控制面（S14，mobile）、本地语音引擎与本地补全引擎（S7，ai-voice-local）、窗口恢复策略（S8）、备份路径声明（S9）。
- 扩展点按 `coreApiVersion` 版本化；新增扩展点不升大版本，改变既有扩展点形状才升。
- 长期双向 RPC 使用握手明确协商的单调序号与有界 pending/取消响应 owner，核心 operation ID 由准入屏障原子分配；旧 v1 保留兼容 ledger。方向、实例、重放、计数溢出及跨 epoch 边界详见 [Vault 服务方案 §4.1](taomni-modular-vault-services-plan.md#41-长期运行与有界防重放)，不得以移除重复检查或扩大终生额度解决持续运行问题。

---

## 6. 模块商店

### 6.1 入口与浏览

- 入口：设置页“模块商店” + 欢迎页“浏览模块” + 未安装占位页的“去商店安装”按钮，三处进同一商店页。
- 浏览：列表按 `kind` 分类（远程桌面 / 本地服务器 / 协作 / 媒体 / 验证 / 网络工具 / 本地 AI / 移动），每项显示名称、简介、版本、大小、兼容性（`coreApiVersion` 是否匹配当前核心）、已安装 / 未安装 / 有更新。
- 第一版只卖官方插件（§4 的 11 个有效插件），不做第三方市场、不做评分评论、不做付费。
- 官方目录默认地址为 `https://github.com/engcapa/taomni/releases/latest/download/modules.json`。设置页允许独立保存官方目录镜像的 HTTP(S) 传输地址，拒绝 URL 内凭据与 fragment；镜像仍使用同一个核心固定公钥、精确原始字节验签和持久 sequence 防回滚，不授予第三方信任。刷新失败时显示错误及最后一次验证成功的来源，保留原已验证列表，不启动下载。目录新增可选 `kind`、`permissions` 与简介；旧清单没有权限元数据时，先提示下载后查看实际权限，不能当作无权限。

### 6.2 安装流程

1. 用户点安装 → 商店查 `modules.json`（§7）取该插件最新兼容版本 → 显示版本、大小、权限清单（`permissions` 展开成人话）、数据目录、是否含需要系统授权的能力（屏幕录制、辅助功能、提权 helper） → 用户确认。
2. 下载插件包（GitHub Release asset，断点续传，分片校验 SHA256）→ 验 minisign 签名（与核心同一公钥，失败拒绝安装并提示）→ 解压到 `plugins/<slug>/` 临时目录 → 校验 `module.json`（id、版本、`coreApiVersion`、平台，且与已验签的 trusted comment 一致，§9）→ 原子替换（先装新目录、再换指针，失败回滚旧目录）。下载走 AGENTS.md 的外部网络规则：默认用设置里的应用代理，也支持插件独立代理或不使用代理（显式绕过系统 / 环境代理）；显示连接中 / 下载中 / 校验中 / 完成 / 取消 / 失败与字节、百分比，支持取消、断点续传与后台下载，关闭对话框不取消任务，重开恢复进度；失败或取消的包不替换已装好的插件。
3. 安装完成：按 §5.0 推荐形态，前端 chunk 与宿主进程都可立即启用，不需要重启应用；若 DEC-1 选备选方案 B，则 Rust 部分提示“重启后生效”，用户确认后重启（复用 `tauri-plugin-process` 的重启路径）。需要系统授权的能力（macOS 屏幕录制 / 辅助功能、SocksCap 提权）在首次使用时由对应入口引导，不在安装时静默申请。
4. 正在下载、安装、授权或等待重启时，重新检查不会替换当前任务；安装阶段不提供取消按钮（复用现有 updater 的取消隔离规则，见 `claudedocs/auto-update-plan.md` 客户端行为第 7–8 条）。

实现边界：renderer 只提交 `{pluginId, version, sha256}`，native 每次从重新验签的缓存目录选择本机平台资产，并推导内容寻址的下载任务及 `.downloads/<sha256>.part` / `<sha256>.taomni-plugin` 路径；不接收 renderer URL、路径、平台或信任标记。下载完成只表示包可供审查，安装确认显示实际验签包的权限与原生数据目录，最终安装再次验签；目录声明的权限与分类必须和包一致。下载任务、代理和跨应用重启发现复用既有 native manager，安装操作不依附设置组件生命周期。测试目录仅由可信 GitHub 签名 job 为相同源码的官方包生成，loopback 地址与 42/41 两个序号固定；不替换生产公钥，不预写注册表或验签结果。

### 6.3 启用 / 禁用 / 卸载 / 回滚

- 启用 / 禁用：开关在商店详情页；禁用保留数据、不加载代码；特权插件（SocksCap / Servers）禁用时先停服务、清驱动 / helper 状态，再卸载代码（复用现有 `sockscap_prepare_for_update` 的清理路径）。
- 卸载先停止宿主并记录已卸载状态，再删除当前版本、回滚版本和版本目录内的签名原件。记录保留模块名称、说明和最后安装版本，用于商店展示、避免自动重装和防止降级。应用重启或刷新注册表可继续清理中断的代码删除。默认保留 `dataDir` 和备份定位记录，用户勾选删除模块数据并确认后才删除两者。
- 回滚：每个插件保留上一版本目录；新版本启用后 7 天内可在商店点“回滚到上一版本”，回滚只换代码，不动数据；回滚也验签。
- 离线安装：商店支持“从本地文件安装插件包（`.taomni-plugin`）”，同样验签、验 `coreApiVersion`，不绕过校验。

### 6.4 更新检查

- 模块商店刷新签名 `modules.json`，按本机平台、核心 API 和注册表中的 active 版本给出模块更新。仅已安装且有更高兼容版本的模块进入更新列表。禁用但仍装有代码的模块可更新并保持禁用。更新提交前复核当前 active 版本，下载期间卸载的模块须由用户重新选择安装。
- 核心更新继续使用 `latest.json`。主窗口独立检查模块目录，模块商店可主动刷新。后续模块更新使用现有下载、权限审查和安装确认。核心 API 升级时显示兼容性与可用更新。
- 每个 profile 持久记录已经见过的正式模块 ID。首份验证成功的目录建立基线，后续目录新增的本机兼容 ID 显示名称和签名目录中的功能简介。用户可前往商店逐个安装或稍后处理。已在注册表中安装或卸载的模块、已处理的提示，以及临时从目录消失再出现的旧 ID 均沿用历史记录。

### 6.5 首次从单体升级到模块化版本

- 启动时持有 profile 使用锁，在应用待还原备份及打开应用数据库前记录来源。全新安装只装核心。旧单体 profile 首次进入模块化版本时，自动通过签名目录安装首批发布集合中所有本机兼容的正式模块。已有模块化标记的 profile 始终沿用当前安装状态，包括注册表为空或所有模块均已卸载的情况。
- 签名 `modules.json` 的 `legacyUpgrade` 字段列出首批正式模块 ID，后续目录沿用该集合。旧单体用户直接跳到后续版本时，仍自动安装本机兼容的首发模块。首发之后新增的兼容模块在首轮检查时显示名称和说明，由用户选装。发布生成器按正式产物的稳定状态和平台资产核对集合。LanChat 已退出产品及首装集合。
- 按 profile 持久化待处理 ID。模块用现有代理、后台传输、断点恢复及验签安装入口处理，模块商店展示进度和失败，支持重试。离线时核心可继续使用，已验签的本地包可通过商店安装。完成一项后重复执行依据 active 版本与卸载记录收敛。完成后的卸载沿用商店数据保留规则。
- 原生用例 TC-MODULES-027 和 040 使用同一签名 QA 目录提供 Hello 和 MFA。027 从正式 `0.5.10` 建立的 profile 升级，核对两份包及旧资料。040 验证两份包均自动安装，卸载 Hello 并正常重启后，MFA 继续保留原签名版本。046 从旧配置直接读到只把 MFA 列入首装名单的后续签名目录，核对自动安装 MFA、Hello 零预先传输和用户确认后安装。
- TC-MODULES-047 使用旧版格式的待还原备份，检查启动后原会话已恢复，签名首发目录仍自动安装全部兼容模块。
- 仍使用 `newmob.db` 的配置同样登记为旧单体。核心先处理待还原备份，再在持有 profile 使用锁时迁移旧库。存在 WAL 或回滚日志时，通过 SQLite 快照生成 `taomni.db`，保留原库和日志。迁移失败时显示错误，旧配置可修复后重试。TC-MODULES-051 核对已提交的 WAL 内容、原文件摘要和重启后的迁移记录。
- 旧数据预检决定每个模块具体迁入的数据。模块代码安装与数据迁移分别记录。依赖旧资料的功能须在数据提交后切换到新宿主，系统授权按对应能力首次使用时获取。

### 6.5.1 单体安装升级协议（v1.5 实施补充）

`plugin_migration_inspect` 只读扫描旧 profile，已提交的 MFA 从待迁移列表移除。通用 `plugin_migration_execute` 记录 pending。Settings 使用已安装 MFA 版本的签名原件或用户选取的签名包，经原 Vault 验证和正常退出交给离线进程，迁移结果由启动后的 Settings 显示。包括历史 LanChat 库在内的旧资料继续留在原目录。 [MFA 执行与交接](taomni-modular-readonly-key-check.md#设置页交接)

升级必须先完成迁移预检，再切换核心版本；不能把旧版目录直接当作插件目录，也不能在下载插件失败时删除旧数据。核心启动时在旧版应用数据目录上建立一次性的 `migration/journal.json`，记录源版本、目标 `coreApiVersion`、每个迁移项的源指纹、暂存目录和提交状态。写 journal 使用临时文件加原子 rename，进程被终止后从最后一个 `committed` 项继续，重复执行同一个项必须得到相同目标内容。

迁移按以下顺序执行：

1. **预检和快照**：以只读方式检查 `taomni.db` 的 `sessions`、`rdp_certificate_pins`、`server_configs` 表，以及 `mfa.db`、`sockscap/config.json`、移动端配置和 Vault 固定条目。记录文件大小与 SHA-256；无法读取、权限不足或 Vault 锁定时只显示可修复错误，不改写源数据。
   SQLite 源指纹必须包含主文件和已有非空 `-wal` 的内容哈希与字节数，排除瞬态 `-shm`；不得为获取指纹主动 checkpoint。无 WAL/空 WAL 保留既有主文件指纹格式。分类和固定密钥存在性查询在只读事务中完成，查询前后复核源指纹；写入或 checkpoint 与扫描并发时明确要求稍后重试，不能把不同时间的候选和指纹记成同一个快照。MFA 文件只做稳定指纹，不解密业务内容；原生 032 和 hosted Rust WAL/并发写入场景保护这一边界，browser 026 只保护现有 renderer 流程。
   预检按实际数据记录归属。`sessions.session_type=RDP/VNC` 分别归属 `rdp-client` 与 `vnc-client`，证书 pin 与 Servers 配置仅在有行时列出。`server_configs.server_type` 中 `rdp` 归属 `rdp-server`（`rdp-server-configs`），`vnc` 归属 `vnc-server`（`vnc-server-configs`），其余类型归属 `servers`（兼容 `server-configs`）。在同一只读 SQLite snapshot 内通过 EXISTS 检查，不读取凭据和配置正文，遇到未知 schema 显示错误。Journal 沿用 `rdp-vnc-sessions`，新增 `vnc-sessions`。预检仅校正未执行且无 target 的 pending 占位。恢复执行器处理 staged、committed 和 rolled-back 历史。设置页按模块显示旧数据归属，journal 逐项记录会话、证书 pin 等待迁内容。
2. **准备目标**：创建版本目录 `plugins/<slug>/versions/<version>.staging` 和独立数据目录；校验 `module.json`、平台、`coreApiVersion`、签名 trusted comment、路径和清单中的 `legacyTables`/`vaultFixedKeys`，任一步失败都清理 staging 并保留旧版核心可启动。
3. **迁移数据**：先复制可直接归属插件的库和目录到 staging，再通过核心只读接口读取 `taomni.db` 中声明的 legacy 表；MFA 的 `data-key-v1` 仍由核心 Vault 按 slug 授权，插件宿主不获得 Vault 句柄。运行中的宿主在 `backup.snapshot` 完成前必须静默，避免热备份与写入交错。
4. **提交和激活**：逐项完成后更新 journal 为 `staged`，对目标文件重新计算指纹并执行原子目录替换，最后切换 `active` 指针并写 `committed`。旧版核心和旧目录至少保留一个回滚点；插件下载、验签或启动失败时只回退 active 指针，不覆盖旧文件。
5. **恢复和收尾**。恢复应用后按注册表与首装记录继续待处理项。保留源数据，在模块商店呈现安装或迁移进度。用户可重试中断项，或卸载已安装模块。所有数据项提交后，迁移 journal 标记 `complete` 并保留摘要和源指纹，供恢复或回滚时核对。

TC-MODULES-027 在 GitHub 安装固定哈希的正式 deb/MSI/DMG，由旧程序创建 schema、重开合成 SSH/VNC 行，再由候选 release QA 核心在同一隔离 profile 执行预检、记录 pending 并正常重启。重启后经签名 QA 目录自动安装首装模块，复核旧文件和 VNC journal。历史基线为 `0.5.9`，现用固定安装输入为 `0.5.10`。Windows 旧 GUI-subsystem 进程的强停记录为 crash 输入。正式候选安装包替换与回退另有对应的验收场景。 [正式旧版安装验证](taomni-modular-installed-upgrade-verification.md)

升级期间核心仍必须能打开终端、Workspace、设置、备份和旧会话编辑页；指向未安装插件的连接动作进入带安装入口的占位页。旧版本运行中的宿主在升级前由核心协调退出，若无法退出则阻止替换并提示关闭相关窗口。离线环境只允许使用已验签的本地插件包；没有可用包时升级仍完成核心更新，插件迁移保持 `pending`。

---

## 7. 版本、发布、清单

### 7.1 版本策略

- 核心继续 SemVer，版本唯一入口仍是根 `package.json`。
- 每个插件独立 SemVer，版本存在各插件的 `module.json` 与 `src-tauri/plugins/<slug>/Cargo.toml` / `package.json` 里，不跟核心锁步。
- `coreApiVersion` 是兼容矩阵的键：第一版定为 `1`；核心只在破坏插件接口时才升大版本（改 RPC 协议消息、改共享服务与扩展点签名、改 `permissions` 取值语义、改前端插件 SDK 的共享面）；插件小版本升级不升 `coreApiVersion`。

### 7.2 清单：`latest.json`（核心）+ `modules.json`（插件）

- 核心清单不变：`latest.json` 仍是包含所有已发布平台的单一清单，由 `scripts/compose-updater-manifest.mjs` 生成（沿用现有规则：平台构建禁止各自发布局部清单）。
- 新增插件清单 `modules.json`，结构：`{ "coreApiVersion": "1", "sequence": 42, "updatedAt": "...", "plugins": { "<id>": { "version": "...", "platforms": { "<platform>-<arch>": { "url": "...", "signature": "...", "sha256": "...", "size": 123 } } } } }`；平台键沿用 `latest.json` 的 `windows-x86_64 / darwin-aarch64 / darwin-x86_64 / linux-x86_64` 命名。`modules.json` 自身也有分离签名（`modules.json.minisig`），`sequence` 单调递增，用于防回滚攻击（§9）。
- 生成器：扩展 `scripts/compose-updater-manifest.mjs`（或新增 `scripts/compose-modules-manifest.mjs`，二选一，评审时定），从各插件构建产物生成；同名双架构、签名原始字节不变、平台别名等回归门禁复用现有测试（`scripts/compose-updater-manifest.test.mjs` 的思路）。

发布时使用 `scripts/compose-modules-manifest.mjs`，通过仓库变量 `TAOMNI_LEGACY_UPGRADE_IDS` 提供被冻结的首装 ID。发布工具在签 `modules.json` 前验证每个模块的包签名、SHA-256、所有声明平台、版本及描述。最终上传步骤使用内置公钥再次验签。正式清单只接受 `stable` 模块及完整平台产物。

### 7.3 发布流程（CI）

- `.github/workflows/release.yml` 保持核心整包矩阵，`.github/workflows/release-modules.yml` 负责模块矩阵（每个原生模块 × 四个现有发布目标：Linux x86_64、Windows x86_64、macOS arm64 / x86_64；纯前端模块只出一份与平台无关的包）。产物是插件包（`.taomni-plugin`，zip 格式，内含 `module.json` + 宿主可执行文件 + 前端 chunk + `SHA256SUMS`；签名是包旁边的分离 `.minisig`），不是整包安装程序。macOS 包内可执行文件须用与核心相同的签名身份签名（G1），Windows 可执行文件的 Authenticode 要求以 G3 结论为准。
- 每个插件单独出 Release asset：同一 GitHub Release 里，核心包与插件包共存，但文件名、签名、清单条目各自独立，不互相覆盖（吸取 v0.4.29 macOS ARM / Intel 同名覆盖的教训，见 `claudedocs/auto-update-plan.md` 2026-10-02 一节）。
- 只改一个插件时，打包该模块的全部声明平台，以当前已签名目录为基线生成完整的新目录。工具沿用首装清单和其他模块的资产地址，并要求目录序号递增。先上传新包及签名，再上传目录签名和目录。客户端验签成功后原子替换本地目录缓存。 [模块独立发布准备](../scripts/plugin-package/README.md#production-catalog-preparation)
- 首次发布模块目录后，只更新核心的发布会继承原目录和签名。发布工作流先验证目录的原始字节，再上传到新的核心 Release。目录中的包地址仍指向原始资产。

### 7.4 兼容矩阵（第一版）

| 核心版本 | `coreApiVersion` | 插件要求 |
|---|---|---|
| 0.6.x（P1 首版，版本号评审时定） | 1 | 插件 `coreApiVersion == 1` 才能安装；`== 0` 或 `>= 2` 拒绝安装并提示 |
| 未来核心大版本 | 2（仅当破坏插件接口时） | 插件需发适配版，商店提示“需同步更新” |

---

### 7.6 核心与模块差异发布规则（v1.7）

- 首次带标签发布时，Release Bundle 从源码中的 `src-tauri/plugins/legacy-upgrade.json` 选取十个模块。每个模块的全部声明平台均须提供稳定包和签名。后续发布以 GitHub Latest 核心 Release 的签名目录为准。如果新核心 Release 刚创建，发布流程从带 `latest.json` 的上一个核心 Release 取目录。独立模块 Release 只保存对应发布的工件和目录快照。
- **只改核心**：构建新的核心安装包和 `latest.json`。发布工作流从上一份正式目录继承原始 `modules.json` 与 `modules.json.minisig`，把目录文件带到新的核心 Release，模块包继续使用原 Release 的资产地址，不重新构建或上传未变化模块。
- **只改模块**：只构建该模块声明的全部平台包。以已发布目录和全部原始模块资产为基线生成完整的新 `modules.json`，保留 `legacyUpgrade` 和未变化模块的原始 URL。新的包、签名及目录快照保存在独立的模块 Release。该 Release 可下载后，把验签的目录签名与目录同步到 Latest 核心 Release，商店继续从固定入口刷新。
- **核心与模块同时改**：从同一源码手动运行 Release Bundle，通过 `modules` 指定改动模块的 slug，逗号分隔。工作流构建核心和所选模块声明的平台。模块签名作业只交付 Actions 工件，由核心发布作业在同一 draft Release 统一上传。发布作业验证并继承旧目录中的未变更条目和首装名单，上传新包与签名后再提交目录签名、`modules.json` 和 `latest.json`。在分支上使用空 `tag` 可只生成 Actions 工件。
- 用同一批候选产物发布时，候选源码写入实际版本并使用 `main` 的签名配置。先用空 `tag` 生成四目标工件，在 GitHub 完成 G1–G11 和两套崩溃回归。正式运行 Release Bundle 时使用同一源码，传入正式 `tag`、候选 `candidate_run`，以及联合发布所选的 `modules`。工作流按工件 ID 读取并核对安装包和模块包，再根据正式 Release 地址签发模块目录。
- 模块目录始终是完整目录，Release 资产按变化集合增量保存。核心 API 大版本变化时，所有受影响模块必须重新适配并发布。

### 7.5 当前实现的发布落点与新增模块流程（M0/M1 基础设施）

当前分支已经把发布边界固定下来，但还没有把 11 个有效插件全部迁移完成。模块源码和宿主放在同一 monorepo 的 `src-tauri/plugins/<slug>/`；前端入口通过核心注册表动态加载。安装后的每个模块使用独立目录，便于回滚和保留数据：

- `<app data>/plugins/<slug>/versions/<version>/`：已验签并解包的只读版本目录；
- `<app data>/plugins/<slug>/active.json`：原子切换的当前版本指针；
- `<app data>/plugins/<slug>/data/`：模块数据，禁用或卸载默认保留；
- 核心更新仍发布 `latest.json`；插件包发布 `.taomni-plugin`、旁路 `.minisig` 与 `SHA256SUMS`，最后原子发布签名的 `modules.json`。

新增模块时按以下顺序落地：先建立 `module.json`（slug、版本、平台、`coreApiVersion`、权限、数据和 legacy 迁移声明），再加入 workspace/宿主和前端注册表；补齐 registry、安装/回滚、缺失占位页以及 browser/native 用例和 feature-list/testid catalog；在 release workflow 中加入平台构建、签名和 hash；CI 先上传包与签名，所有资产完成后才生成并发布新的 `modules.json`。未通过宿主、签名、升级或受影响功能门禁的模块不得进入首发清单。`ModuleStorePanel` 负责核心 registry 投影，`ModuleMarketplace` 负责官方签名目录的浏览、下载与安装；接线的 hosted 验证状态和尚未发布的正式目录须在台账明确，不能用 browser 模型或 QA 签名目录代替正式 release 闭环。

## 8. 数据与迁移

### 8.1 分库原则（沿用已有先例）

| 数据 | 现状 | P1 归属 |
|---|---|---|
| 会话、分组、隧道、聊天元数据、查询工作区、历史 | `taomni.db` | 核心（会话记录是核心的，插件只读） |
| Notes | `notes.db` | 核心 |
| MFA | `mfa.db`（懒加载） | `plugin-mfa`（已独立，直接划归；密钥 `mfa.data-key-v1` 留核心 Vault，经 S12 访问） |
| Mail 缓存与账户状态 | `mail-cache/`、核心设置中的 Mail 配置 | `plugin-mail` 数据目录，备份通过 `backupPaths`，会话记录仍留核心 |
| Vault | `vault.db` | 核心（插件只拿引用） |
| Servers | `taomni.db` 里的 `server_configs` 表（`servers/db.rs`）；其中 RDP / VNC Server 的配置行按 `server_type` 区分 | `plugin-servers`；RDP / VNC Server 行随 `plugin-rdp-server / plugin-vnc-server` 走（§4） |
| RDP 客户端 | `taomni.db` 里的 `rdp_certificate_pins`（`rdp/tls.rs`）；会话记录是 `sessions` 表 | 证书钉扎表迁入 `plugin-rdp-client` 自有库；会话记录留核心 |
| SocksCap | `<应用数据目录>/sockscap/{config.json, rules/, recovery.json}` | 0.1.3 起，签名宿主首次读取时将旧配置导入 `plugins/sockscap/data/config.json`，保存、重开和备份使用该文件。旧配置保留供回退。签名模块的本机恢复日志与模块指针同目录，兼容旧日志见 §8.2。 |
| 移动端 | `mobile_feishu_events` 等表（`mobile/`）、`mobile-desktop-remote.json`（桌面远控策略文件），其余配置在核心设置 | 插件自有库，逐表核查后迁移 |
| VNC 客户端 / 截图 | 实测未发现独立表（偏好存核心设置） | 无需新库；M0 逐模块再核一遍 |

### 8.2 迁移规则

- 每个插件自己写一次性迁移：旧数据在 `taomni.db` 时，**插件宿主不直接打开 `taomni.db`**（多进程写同一 SQLite 有锁冲突，也违反“不读对方库”）；`module.json` 声明 `legacyTables`，核心提供只读 RPC `legacy.read(table)`，插件读出属于自己的行、写入自己的库，写完打标；不删旧表（旧表留一个版本周期再清，给回滚留路）。
- 迁移失败时插件不启用、核心不崩，商店显示“迁移失败，数据未动”，用户可重试或卸载插件。
- 卸载插件不删数据；重装同一插件时数据还在；显式“删除数据”才清。
- **SocksCap 恢复日志的特例**：签名模块的本机网络恢复日志位于 `plugins/sockscap/recovery.json`，随模块指针同目录保存。便携备份只保存用户配置。启动、恢复和更新前检查该路径及旧版 `sockscap/recovery.json`。若有未清理状态而模块未安装或已禁用，核心继续处理该机器的恢复记录，恢复失败时给出明确提示和可用的手动清理步骤。完成恢复后清理相应记录。
- 备份（核心）备份全部数据文件（核心库 + 各插件库），恢复时按 §3.7 处理。运行中的宿主用 `backup.snapshot` 取一致快照，已禁用 / 未安装的插件按 `backupPaths` 拷贝；还原前核心先停全部宿主并持有独占 `ProfileLease`（S13）。Vault 与插件库必须同批恢复，否则加密库无法解密（AC-016）。
- 将 v2 MFA 备份恢复到新配置后，启动时按还原事务生成的定位记录使用 `plugins/mfa/data/mfa.db`。用户安装并启用签名模块后，用原 Vault 密码访问已恢复的账号。后续恢复 v1 MFA 备份也写入该配置当前使用的模块库。仍使用旧库且已含账号的配置会拒绝缺少配对旧 MFA 数据的 Vault 还原。
- 首次升级遇到旧 Mail 账号时，模块商店自动准备验签包并显示下次启动时导入。应用下次启动先处理未完成的备份还原，再在打开业务库前用独占租约导入邮件。SQLite 快照包含已提交的 WAL 内容。原件按归档索引核对解压后的长度和 SHA-256，完整的缓存附件随账号复制。核心先发布数据，再激活验签代码，最后提交 journal。任何原件校验失败时商店保留待迁移和重试入口。首次激活前中断时，重试使用最新的原缓存。会话记录和原缓存保留，供旧版回滚读取。

#### Mail 邮箱数据接管（TASK-026 待实施部分）

- 复用 `migration_mail` 的启动顺序、`StagedMailData` 的离线快照和 Mail 宿主 `Store`。从账户配置中的原目录和历史搬迁定位文件解析旧库。在同一邮箱的同步、归档和批量任务静默后获取独占 profile 和模块数据租约。在提交前保持旧库、原件和旧配置可供回退读取。
- 启动先应用待还原备份。已有模块备份覆盖账户时，即使旧机器上的自定义目录不可访问，也能从已还原的模块库激活。部分备份按账户补入缺失的旧库。先保留还原目录，再发布校验后的合并结果。激活前中断时从保留的还原目录和最新旧库重试，激活和 journal 提交成功后清除临时副本。
- 以账户为单位提交。接管时把文件夹、消息、IMAP UID 水位、过滤水位、批量写前日志、POP3 UIDL 与原件、归档索引和清理标记视为一组。以当前持有邮箱的库作为该组来源。已由签名宿主持有的草稿和发件箱、地址簿、日历、规则定义与附件按各自归属继续读取。已还原的模块数据和已提交接管的邮箱沿用其现有库。历史 IMAP 原件按文件夹、UIDVALIDITY、UID 和内容摘要识别，POP3 UIDL 和本地 UID 保持原对应关系。
- 先在暂存区校验 SQLite 与全部归档原件的引用，再发布文件及归属回执。启动时按回执和 journal 恢复中断。接管完成后，由声明对应数据能力的签名宿主读取和写入模块目录。首版从单体升级时，Mail 0.1.49 的签名宿主声明邮箱所有权能力。Mail 0.1.50 在首次保存默认路径的 IMAP 账户时创建签名宿主数据和归属回执。已保存账户及显式自定义目录沿用当前存储路由。首次保存失败可沿用该账户重试。TC-MAIL-CACHE-02 检查浏览器保存和重开，TC-MODULES-101 核对实际签名包、数据库和新邮件。每个已接管 IMAP 账户使用模块数据目录的独立归属回执。旧库和原有目录设置可供旧核心回退。旧版模块或早期数据备份中缺少该回执的账户继续使用原来的活动库。已接管账户遇到缺少该能力的旧模块时提示在模块商店更新，并保留现有数据。
- 备份运行中的模块时从宿主取一致快照。禁用、卸载保留和自动还原沿用签名清单。还原及退回旧核心后再升级时验证已拥有的模块数据仍可打开。TC-MODULES-049/050/052 核对预检、失败和重试，TC-MODULES-070/076 分别核对归档和 POP3 的恢复，TC-MODULES-083 核对附件。签名 Mail 升级专项使用默认与自定义旧目录，核对 WAL、错配原件拒绝、只提交一次，以及模块宿主读取和旧库回退。
- Mail 0.1.52 由签名宿主组装发件、草稿与回执，并在 SMTP 确认后提交已发送联系人。宿主复用账户缓存锁，在一个事务内更新联系人，取消时回滚。旧单体数据继续沿用上述迁移协议。缺少组装或回执命令的早期模块包需在模块商店更新。G9 检查四个默认构建目标均排除 Lettre。TC-MODULES-059 与 TC-MAIL-SEND-01 分别核对原生数据库和重新写信时的联系人建议。
- Mail 0.1.53 的签名宿主同时负责查询和重建收件人建议索引。重建保留 SMTP 已确认的收件人和计数，包括只出现在 Bcc 中的联系人。TC-MODULES-059 停用并重新启用模块后，从收件箱重开写信，核对已发送的收件人仍可查到。

---

## 9. 安全

- **签名**：插件包与核心包同一 minisign 密钥；验证公钥只使用核心二进制内置的那一把（`tauri.conf.json`），不接受包内自带公钥；轮换密钥时先规划旧客户端升级路径（沿用现有 CI 签名要求：`TAURI_SIGNING_PRIVATE_KEY` 只在 CI secrets 里）。
- **签名绑定内容，防串包与降级**：每个插件包的 minisign trusted comment 写入 `id、version、platform、coreApiVersion、sha256`，核心安装前必须与 `module.json`、`modules.json` 条目逐项一致，防止“把插件 A 的合法包当插件 B 装”；`modules.json` 自身签名且 `sequence` 单调递增，核心拒绝低于已见最大值的清单，也拒绝安装低于已装版本的包（显式“回滚”除外，§6.3）。同一把密钥意味着密钥泄露会同时影响核心与全部插件，评审时可议是否为插件单设子密钥（§13.3）。
- **权限**：`permissions` 是核心定义、在 `plugin_invoke` 与 RPC 处强制的权限集（§5.1），不是 Tauri capability（后者编译期固定，§5.0）；插件不得自声明集合之外的值，新增取值需评审，不随插件发版静默加。**局限必须说清**：插件前端与核心前端同在主 WebView，`permissions` 约束不了前端 JS，真正的信任边界是“官方签名 + 评审”，所以第一版不开放第三方插件（§5.3）。
- **宿主进程通道**：核心拉起宿主时下发一次性随机 token；控制通道只走 stdio，数据通道只绑定 `127.0.0.1` 随机端口并校验 token，不监听外部网卡；宿主进程以当前用户权限运行，不继承核心的 Vault 句柄与数据库句柄。
- **平台信任**：下载来的可执行文件在 macOS（签名身份、TCC）、Windows（SmartScreen / Defender）、Linux（`noexec`）上的行为见 §5.0 的 G1–G4，结论出来前不承诺“三端一致”。
- **特权边界**：SocksCap / Servers 的提权 helper、驱动、系统捕获状态，在停用 / 卸载 / 更新前必须清理（复用 `sockscap_prepare_for_update`）；RDP Server 的输入注入与录屏权限单独审计；VNC Server 监督的是系统 VNC daemon，不自带提权路径。
- **Vault**：插件平时只持有 `vault:` 引用；插件作用域固定数据密钥（`mfa.data-key-v1`）经核心受限服务访问（S12），宿主不持有 Vault 句柄；必须自己完成协议认证的插件（RDP / VNC / 内置服务器等），由核心在建立连接时一次性下发该会话所需明文（绑定会话 ID、不落盘、不进日志，§5.0）；插件不得把凭据写进自己的日志、自己的库、自己的导出文件，也不得转发给其它插件。
- **出口**：插件的网络出口同样走核心的代理与 allowlist；Tao Agent 的 egress allowlist（默认只放 `api.deepseek.com` 等，见 Tao 设计 §11）不因插件化而放宽。
- **已知缺口不扩大**：SSH `check_server_key` 无 known-hosts/TOFU、内置 SSH 服务器 SFTP `rootDir` 非沙箱，这两处在 P1 不修复（roadmap P2 安全闭环），但模块化不得让更多代码绕过它们（例如插件不得自己实现一个不校验的 SSH 客户端）。
- **审计**：插件安装 / 启用 / 禁用 / 卸载 / 回滚全部记审计日志（沿用 Tao 设计 §11 的 `tao_audit` 思路，落到核心审计表，不落插件库）。

---

## 10. 实施计划（P1 内部分批，第一版一起发布，Mail 纳入首发验收集合）

不做 P0 多 profile 打包。P1 内部分四个里程碑，M0–M3 做完才发第一版，中间不单独发版。

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 基线、验证门与前置解耦（3–5 周，v1.2 为 1–2 周） | ① 实测三端现包体积、`cargo tree`、`dist` chunk 和 bundle 资源；② **§5.0 G1–G11**（hello-plugin + `plugin-mfa` 真实宿主进程，当前端先行、其余端保留计划）；③ **§4.2 阻塞项重构 S1–S3、S5、S10**（采集下沉、`LogEmitter` 下沉、`taomni-rdp-common`、`TabKind` 开放化、`AppState` 拆 `CoreState + PluginRegistry`）；④ 搭运行时骨架（`module.json`、注册表、生命周期、`plugin_invoke`、宿主进程管理、前端动态加载与自定义 URI scheme、前端插件 SDK）；⑤ 产出 `screenshot/` 文件级拆分表和依赖归属表（§4.3）；⑥ 冻结 S11 re-exec 归属与 S12/S13 数据密钥、快照服务设计（TASK-024、TASK-025）；⑦ 在 M0 末对 `plugin-mobile` 做 go/no-go（§4.5） | 基线报告（体积 + 依赖闭包 + chunk）；G1–G11 结果表（含失败项的处置，写入 §13.4）；核心-only 构建中 `capture/`、截图入口、MFA 扫描不再引用 `servers::` / `rdp::`；hello-plugin 可被加载、启用、禁用并显示在商店里。**G 项未通过的插件类，不得进入 M2** |
| M1 商店与清单（1–2 周） | 模块商店 UI + 安装 / 启用 / 禁用 / 卸载 / 回滚流程；`modules.json` 生成器；签名校验；离线安装 | 商店可安装 hello-plugin 并回滚；签名失败拒绝安装的用例通过 |
| M2 插件迁移（分批，3–5 周） | 按 §10.1 的任务顺序迁移：① `plugin-mfa`；② VNC/RDP 客户端与服务端；③ `plugin-servers`、`plugin-sockscap`；④ `plugin-screenshot`、`plugin-ai-voice-local`、`plugin-mobile`。每批做数据迁移（§8）、扩展点和动态加载；`plugin-mobile` 及 macOS G2 例外必须按 DEC-2 单独记录 | 每批：对应 AC-010 通过、核心-only 回归通过、插件回归通过；未通过的插件不进入首发清单，除非写明 DEC-2 例外 |
| M3 发布与回归（1–2 周） | `.github/workflows/release.yml` 扩展插件矩阵；`modules.json` 原子发布；核心-only + 全量两套回归；回滚演练（插件回滚 + 核心回滚互不影响） | 两套回归全过；只发一个插件包的演练通过；文档与 ADR 更新 |

工作量估算：M0–M3 约 9–16 周（v1.5 新增 S11–S15、TASK-024/025 与 mobile 控制面，较 v1.4 的 8–14 周上调约 1–2 周；若 mobile 按建议暂缓则回到 8–14 周）；v1.4 为 8–14 周（单人全职等效，估算非承诺；v1.2 的 6–11 周没有计入 §4.2 的前置解耦与 §5.0 的验证门，M0 由此从 1–2 周上调到 3–5 周；M2 的 SocksCap 与 Servers 占大头，平台差异与提权路径是主要风险）。估算依据是模块耦合实测（§1.8）而不是代码行数，且在 M0 验证门结果出来后必须重估一次。

**文件清单（新增 / 大改，评审时逐项对）：**

- 新增：`src-tauri/plugins/<slug>/`（原生插件 crate，宿主可执行文件，各含 `Cargo.toml、module.json、src/main.rs、frontend/index.*`；纯前端插件无 Rust 部分）、库 crate `taomni-plugin-api`、`taomni-rdp-common`、核心 `src-tauri/src/plugin/`（注册表、宿主进程管理、`plugin_invoke`）与 `src-tauri/src/capture/`、`src/lib/pluginRegistry.ts、src/lib/moduleStore.ts、src/stores/moduleStore.ts、src/components/settings/ModuleStorePanel.tsx、scripts/compose-modules-manifest.mjs`（或扩展现有生成器）。
- 大改：`src-tauri/src/main.rs`（re-exec 入口归属）、`src-tauri/build.rs`（`mobile-web` 资源随 mobile 迁出）、`src-tauri/src/lib.rs`（AppState 拆分）、`src-tauri/src/state.rs`、`src-tauri/src/commands/mod.rs`（按插件拆）、`src/layouts/main/TabContentRouter.tsx`（动态加载）、`src/lib/ipc.ts`（按领域分文件）、`src/types/index.ts`（`TabKind` 开放化）、`src-tauri/tauri.conf.json`（CSP 加插件 scheme、`bundle.resources` 去 `sockscap`、deb / rpm 依赖调整）、`src-tauri/capabilities/default.json`（`plugin-*` 窗口模式）、`src-tauri/nsis/hooks.nsh`（SocksCap 清理迁出）、`src-tauri/Cargo.toml`（workspace members、特性调整）、`.github/workflows/release.yml`（插件矩阵）、`scripts/refactor-boundaries.mjs`（加插件边界检查）。
- 不动：`src-tauri/src/session/models.rs` 的 `SessionType` 取值（26 种不变）、`taomni.db` 的会话表结构（只新增插件自有库）、Tao Home 设计。

### 10.1 可执行任务分解

任务由职责角色领取，表中的文件范围是所有权边界；共享文件必须由同一任务集成，后续任务只通过已冻结的契约修改。每个任务完成后回填对应 `AC-*`、`V-*` 证据，不能只以“编译通过”关闭。

| 任务 | 目标、文件范围与具体产物 | 依赖 | 完成条件 / 验收 / 验证 |
|---|---|---|---|
| TASK-001 | 建立 M0 基线：`package.json`、`src-tauri/Cargo.toml`、`tauri.conf.json`、`release.yml`、`dist`、四平台 artifact 采样；生成 `docs-feature/taomni-modular-split-baseline-<date>.md`，记录命令、hash、大小、平台和已知缺口；基线须在 `7bc498b35` 或其后继提交上取得，并单列文件查看器新增的 `docx/katex/html-to-image/mermaid` chunk、vendored `wry`、`resources/mobile-web` 的大小。 | 无 | 体积、`cargo tree`、chunk、资源清单可复现；AC-013/014；V-001。 |
| TASK-002 | 冻结插件协议：新增 `src-tauri/crates/taomni-plugin-api/`（或等价 workspace crate），定义 `apiVersion`、握手、request id、错误码、取消、事件、心跳和 token 绑定；同步 `module.json` JSON Schema。 | 无 | 协议 fixture 可序列化/反序列化，未知字段和版本错误有明确策略；支持大二进制载荷旁路（供 `capture.still` 等大帧服务，不经 JSON stdio）；AC-004/009；V-002。 |
| TASK-003 | 合并并下沉屏幕采集（方案见 §4.2.1，用户已决定合并）：新建 `src-tauri/crates/taomni-capture/`（迁入 `servers/rdp/capture/**`，新增 `CaptureLog`、`permissions`、`still` 采集策略）和核心 `src-tauri/src/capture/`（`displays`、通用 `FrameSource`、`CaptureLog` 核心实现、`capture.still` 服务）；迁移 `control_permission_granted` 及全部调用方（`screenshot/scroll/input.rs`、`mobile/desktop/windows.rs`、`servers/rdp/input`、`servers/probes.rs`）；`mfa/capture.rs` 的重复后端删除并改调统一 API；`servers/engine` 的 `LogEmitter` 不再被采集层引用；按 §4.2.1 七步分提交，保留跨平台 Wayland/X11/macOS/Windows 分支及其保持行为约束；边界脚本新增 `screenshot/`、`mfa/`、`mobile/` 不得引用 `servers::`。 | TASK-001、002（大二进制载荷旁路） | 核心截图入口、MFA 扫描、移动端桌面远控不再引用 `servers::`；`taomni-capture` 不含 `tauri`/`wry`，Linux 目标不含 `xcap`；RDP 帧预算不退化；§4.2.1 验证入口全部有原始结果、未验证平台明确记录；AC-001/010/012/013；V-003。 |
| TASK-004 | 提取 `taomni-rdp-common`，迁移 RDP 剪贴板、文件传输安全路径、编解码和 URI 工具；RDP client/server 只依赖库 crate，不互相依赖。 | TASK-001 | 两端独立构建，核心不再 `use crate::rdp`；AC-009/010；V-003。 |
| TASK-005 | 拆 `AppState`：修改 `src-tauri/src/state.rs`、`state/domains.rs`、`lib.rs`、`commands/mod.rs`，形成 `CoreState + PluginRegistry`；插件内部状态只留宿主，核心保存元数据、句柄和 RPC client；`main.rs` 与 `ModeLease` / `ProfileLease` 的归属以 TASK-024 的结论为准。 | TASK-002、003、004 | 现有核心命令契约无删除；状态初始化、退出清理和恢复路径有单测；AC-001/002/004；V-002/003。 |
| TASK-006 | 做依赖闭包迁移：修改 `src-tauri/Cargo.toml`、构建脚本、features、`tauri.conf.json`、Linux 依赖、bundle resources；把 `asr-whisper/asr-sherpa`、RDP、OCR/录制、SocksCap 资源从核心默认产物移出，`voice-capture` 保留核心。 | TASK-001、003、004 | 核心-only `cargo tree`、bundle、`dist` 均不含已迁移项；插件构建可独立解析同一 `[patch.crates-io]`；AC-001/013；V-001/002。 |
| TASK-007 | 建立前端插件 SDK 和 tab 注册：修改 `src/types/index.ts`、`src/layouts/main/TabContentRouter.tsx`、`src/layouts/main/panels.tsx`，新增 `src/lib/pluginRegistry.ts`、`src/lib/pluginLoader.ts`、占位页和 chunk hash 校验；CSP 自定义 scheme 仅映射插件目录，且与 `taomni-preview` 合并（`csp`、`devCsp` 两处）；分离窗口入口同样初始化注册表。 | TASK-002、005 | 核心 tab 保持静态，插件 tab 通过注册表 `React.lazy` 加载；缺失/禁用/坏 chunk 都有可见错误；AC-002/005/009；V-004。 |
| TASK-008 | 实现宿主监督器：新增 `src-tauri/src/plugin/`，负责启动、stdio JSON-RPC、心跳、超时、取消、崩溃重启、Windows Job Object、Linux `PDEATHSIG` 和 macOS 启动清扫；loopback WS 只允许随机端口 + 一次性 token。 | TASK-002、005 | G1/G2/G3/G4/G6/G7/G10 有可复现实验记录；AC-004/007/012；V-002/010。 |
| TASK-009 | 实现注册表和安装状态机：新增/修改 `src-tauri/src/plugin/registry.rs`、`src/lib/pluginRegistry.ts`、`src/stores/moduleStore.ts`；采用版本目录 + active 指针/原子替换，卸载默认保留数据。 | TASK-002、007、008 | installed/enabled/disabled/uninstalled/rollback 状态可持久化，重启恢复一致；AC-007/009；V-003/005。 |
| TASK-010 | 实现下载服务：新增 `src-tauri/src/plugin/download.rs` 及前端任务 store；复用应用代理解析，支持独立代理和 no-proxy，Range/Content-Range 校验、断点续传、取消、后台、去重、未知总量进度。 | TASK-002、009 | 三种代理模式和失败/恢复路径都有字节进度和错误码；AC-003/007；V-005。 |
| TASK-011 | 实现验签与安装安全：`module.json`/`modules.json` schema、minisign trusted comment、SHA-256、`sequence`、平台/版本匹配、路径穿越/符号链接拒绝、临时目录和失败清理。 | TASK-002、009、010 | 篡改包、串包、降级、坏签名、坏路径均拒绝且不替换旧版本；AC-008/009；V-005/008。 |
| TASK-012 | 实现备份与迁移框架：修改 `src-tauri/src/backup/`、`src/components/welcome/`、`src/stores/backupStore.ts`；从 `module.json` 读取受限 `backupPaths`，新增迁移 journal、幂等版本、失败回滚和“稍后安装”向导；接入 `backup.snapshot` 与插件 Vault 密钥一致性（TASK-025）。单体升级必须遵循 §6.5.1：只读预检、源指纹、staging 目录、active 原子切换、宿主静默和离线 `pending`。 | TASK-005、009、011、025 | 真实 0.5.x fixture 的 RDP/VNC/Servers/MFA/SocksCap 数据迁移可重跑、可取消、可恢复；验签/下载失败保留旧数据和核心可启动；AC-006/011/017；V-006/012。 |
| TASK-013 | 建立 hello-plugin 和 G 门实验：`src-tauri/plugins/hello-plugin/`、平台签名/执行脚本、M0 实验记录；按 G1–G11 逐项写通过标准、原始日志和失败处置。 | TASK-002、008、009、011 | 当前端先完成，Windows/macOS/Linux 计划完整；任何未通过的 G 项阻断相关插件批次；AC-004/007/012；V-002/010。 |
| TASK-014 | 迁移 `plugin-mfa`：`src-tauri/src/mfa/`、`src/components/mfa/`、`commands/mfa.rs`、`mfa.db`、核心 MFA prompt 与 capture 扩展点分离。 | TASK-003、005、007、009、012、013、024、025 | MFA 可独立安装/禁用，SSH `MfaPrompt` 仍在核心，`mfa.db` 数据完整；`mfa.data-key-v1` 经 S12 服务访问；AC-002/006/010/016；V-006/007。 |
| TASK-026 | 将 Mail 同步及邮箱库交给独立宿主，页面和 store 随签名模块发布。核心保留会话记录、恢复定位、Vault、代理、文件查看器和备份协调。按 §8.2 接管邮箱库、POP3 UIDL 和归档索引。 | TASK-005、007、008、009、011、012、024、025 | Mail 可独立安装、启用、禁用、更新、回滚和卸载。旧 Mail 配置、账户引用、缓存和同步状态可幂等迁移。未安装时旧会话可查看和编辑，连接显示安装入口。验收覆盖 AC-002/006/010/011/017 和 V-006/007/010/012。 |
| TASK-027 | G1–G11 全门禁收口：按匹配源码 SHA 在 GitHub runner 完成 macOS/Windows/Linux 系统信任、TCC、noexec、帧吞吐、强退清扫、无重启生命周期、篡改与路径安全、核心-only 依赖闭包、RPC 取消/超时/重复请求、ProfileLease/ModeLease/re-exec 全矩阵；统一归档原始 receipt、日志、包身份和 artifact 索引。 | TASK-001–026（按门禁依赖闭合） | G1–G11 每项均有三端适用范围内的通过证据；失败、skip、环境阻塞和未验证项均有明确状态；所有受影响 browser/native 用例与完整 crash-regression 通过；未闭合门禁不得发布正式模块目录或核心-only 包。 |
| TASK-015 | 已取消：原 LanChat 插件迁移任务。用户于 2026-11-15 要求彻底删除该功能；保留编号用于历史追踪。 | 无，不再作为其它任务的前置依赖 | 产品、插件、迁移、备份与 QA 入口删除；历史 `lanchat.sqlite` / `lanchat.db` 留原位，不读取、迁移或删除。不创建替代插件。 |
| TASK-016 | 迁移 VNC/RDP 客户端：`src-tauri/src/vnc`、`src-tauri/src/rdp`、前端和现有 WS relay；会话记录仍由核心管理，凭据按会话一次性下发；`--vnc-special-key-hook` 入口迁入 VNC 宿主二进制（S11）。 | TASK-004、005、007、008、009、013、024 | 客户端功能回归、断开/重连、detach 和未安装占位通过；AC-002/004/010/013；V-007/010。 |
| TASK-017 | 迁移 RDP/VNC Server：从 `servers/rdp*`、`servers/vnc.rs` 拆出宿主，迁移 tab lock、capture、输入注入、外部 daemon 监督和服务端审批。 | TASK-003、004、008、016 | G2 结论适用；服务启停、退出清理、权限和 tab lock 无残留；AC-004/010/012/013；V-007/010。 |
| TASK-018 | 迁移 `plugin-servers`：剩余 `servers/`、`server_configs` 一次性迁移、长驻服务清理、`nsis/hooks.nsh` 中不再由核心承担的清理路径。 | TASK-005、008、009、011、012、017 | 旧配置可迁移，核心不再读插件库；SSH/SFTP/rootDir 已知缺口不扩大；AC-006/010/012；V-006/007。 |
| TASK-019 | 迁移 `plugin-sockscap`：`sockscap/`、resources、helper、WinDivert/xray staging、恢复日志和卸载清理；保留既有提权 helper 边界；`--sockscap-redirector-bridge` 入口迁入宿主二进制（S11）。 | TASK-006、008、009、010、011、012、024 | 启停/升级/卸载不残留驱动或 helper；`recovery.json` 未清理时核心有明确提示；AC-003/007/010/012；V-005/007/010。 |
| TASK-020 | 迁移 `plugin-screenshot`：按 §4.3 文件表拆 OCR 与录制，迁移 tesseract 语言包/编码器和 `RecorderBar`，滚动截图、Overlay、采集和入口留核心。 | TASK-003、006、007、008、009、011 | 未安装时入口可用且 OCR/录制占位清晰；安装后文件落盘和取消收尾正确；AC-002/005/010/012；V-004/007/010。 |
| TASK-021 | 迁移 `plugin-ai-voice-local`：`asr/` 本地引擎、`voice/streaming/local.rs`、`fim_engine*`、模型目录和 feature；云端 ASR、cpal 采集、清理和词表留核心。 | TASK-006、007、008、009、011、013 | 未安装时文字聊天/云端 ASR 可用，本地引擎和 FIM 明确降级；模型不进核心包；AC-001/002/010/013；V-007。 |
| TASK-022 | 迁移 `plugin-mobile`：先在 M0 末做 go/no-go 原型（§4.5）；若 go，依次实现 S6 观察者、S14 控制面、S15 headless 和桌面远控服务（含 macOS G2 结论），解除 `terminal/chat/agent/lib.rs/main.rs` 对 `crate::mobile` 的直接依赖，迁移 `mobile-web` 资源与设置页插槽；按性能门决定首发或 DEC-2 暂缓。 | TASK-005、007、008、009、013、014、024 | 核心热路径无 `crate::mobile`，吞吐/延迟不退化；不满足则记录例外，不能伪称全量首发；AC-010/012/013/015；V-007/010/011。 |
| TASK-023 | 集成发布与验收：`compose-modules-manifest`（或扩展现有生成器）、`.github/workflows/release.yml`、`scripts/refactor-boundaries.mjs`、插件包 smoke；执行核心-only、全量、crash-regression、受影响 case 和回滚演练，回填本设计与 ADR。 | TASK-001–022、024–027（按批次闭合） | AC-001–016 全部有证据；`pnpm check:refactor`、发布脚本测试、完整 `crash-regression` tag（核心-only 与全量两套，§11）和当前端 native smoke 通过；V-001–011 归档。 |
| TASK-024 | 多进程入口与 profile 协同（v1.5 新增）：`src-tauri/src/main.rs`、`lib.rs`（`ModeLease`）、`backup/coordination.rs`、`mobile/headless*.rs`；冻结 S11 re-exec 归属表、S15 `--headless` 在插件模型下的行为，设计并验证宿主与 `ProfileLease` / 还原的协同。 | TASK-002、005 | G11 有记录；`--ssh-stdio-forward`、`--screenshot-scroll-input` 保持核心且有测试；迁出入口有归属表；AC-015；V-011。 |
| TASK-025 | 插件数据密钥与一致快照服务（v1.5 新增）：`vault/`（插件作用域固定条目服务，`mfa.data-key-v1` 迁移为按 slug 限定）、`backup/snapshot_context.rs`（`backup.snapshot`）、`module.json` 的 `vaultFixedKeys` / `snapshot` 字段与 schema。 | TASK-002、005 | 宿主不持有 Vault 句柄也能打开自己的库；备份还原后 Vault 与插件库一致；运行中 / 已禁用 / 未安装三种状态的备份与还原用例通过；AC-011/016；V-006。 |

**执行顺序与并行规则**：TASK-001、TASK-002 可先行；TASK-024、TASK-025 在 TASK-005 契约冻结后启动，必须先于 TASK-012、TASK-014 合并；TASK-003/004 可并行但都必须在 TASK-005 前合并；TASK-006 与 TASK-007 可在状态契约冻结后并行；TASK-008–013 是 M0/M1 的关键路径，任何 G1–G11 未通过只允许继续非受影响的文档、fixture 和核心重构；TASK-014–022 中未取消的任务严格按依赖闭合逐批迁移，不允许多个任务同时改 `state.rs`、`commands/mod.rs`、`TabContentRouter.tsx` 或 `Cargo.toml` 而没有集成负责人。TASK-023 是唯一的发布收口任务。

**每项任务的交接包**：实现提交或变更列表、改动文件边界、契约/迁移 fixture、自动化命令及原始结果、三端编译检查、当前端真机证据、未验证项和回退步骤。任务计划本身不代表已领取、已实现或已通过。

---

## 11. 测试与验收

- **核心-only 回归**要求在空模块配置下通过终端、SFTP、数据库、工作区、Tao、备份和核心会话管理用例。邮件等历史会话仍可查看，打开未安装的模块时显示安装提示。全插件配置验证 Mail、RDP、VNC 等实际业务。
- **全量回归**：装全部 11 个有效插件；若 `plugin-mobile` 或 macOS G2 触发 DEC-2，则按实际发布集合执行并在报告、`modules.json`、§13.4 同时注明，不能用“全量”掩盖缺项。
- **插件单测**：每个插件独立安装 / 启用 / 禁用 / 卸载 / 回滚各一遍；签名失败、版本不兼容、下载中断、迁移失败各一遍，全部有明确错误与回滚。
- **发布演练**：只发一个插件的新版本（不发核心），`modules.json` 更新后商店显示更新、安装成功、核心不受影响。
- **crash-regression 的插件感知（v1.5）**：`qa-ui-auto-tests/ci/crash-regressions.md` 当前 19 个用例中，`TC-MOBILE-012/013` 依赖移动端，其余为核心功能（工作区、IDEA 对齐、文件打开）。规则：给每个用例登记 `requires-plugin`（无则为核心）；核心-only 运行执行全部不依赖插件的用例；依赖插件的用例只在装有对应插件的全量运行中执行，核心-only 报告里列为“需要插件，未在本集合运行”，不得记为通过、也不得静默跳过；评审时两份报告都要有。mobile 若按 DEC-2 暂留核心，这两个用例回到核心集合。新增或迁移插件时同步更新该登记。
- **边界检查（自动化）**：把下列规则加进 `scripts/refactor-boundaries.mjs` 并纳入 `pnpm check:refactor`：核心 `src-tauri/src/` 不得 `use` 任何 `taomni_plugin_*` / 插件模块；插件 crate 只能依赖 `taomni-plugin-api` 与库 crate，不得依赖核心 crate，也不得互相依赖；核心前端 `src/` 不得 import 插件前端目录；插件 crate 不得依赖 `tauri` / `wry` / `tauri-utils`；核心 `main.rs` 不得保留迁出插件的 re-exec 入口（S11）；核心-only 构建（`cargo tree`）中不得出现 `ironrdp-*`（客户端 / 服务端）、`whisper-rs`、`sherpa-onnx`、`tesseract.js` 等应已移出的依赖。
- **宿主进程专项**：宿主崩溃重启、应用强杀后无残留进程（三端）、握手版本不匹配的明确错误、token 校验失败拒绝连接、`plugin_invoke` 对未声明命令 / 未授权 `permissions` 的拒绝。
- **升级迁移**：从 0.5.x 带真实 RDP / VNC / Servers / MFA / SocksCap 数据升级到 0.6.x，迁移向导检测准确、安装后数据完整、取消向导后数据无损（§6.5）。
- **性能**：核心-only 启动时间与内存不比现包差（基线对比，M0 的基线报告为准）；插件启用后按插件报增量，不掩盖。

### 11.1 验证项与命令

| V ID | 证明目标与层级 | 具体入口 / 断言 | 命令或环境 | 产物 |
|---|---|---|---|---|
| V-001 | M0 基线与依赖闭包（脚本/构建） | 三端包体积、`cargo tree`、bundle resources、`dist` chunk、默认 feature 和核心-only 负依赖清单 | 根目录 `pnpm build`；`src-tauri/` 下按目标运行 `cargo tree`；记录实际平台命令 | `docs-feature/taomni-modular-split-baseline-<date>.md`、hash 清单 |
| V-002 | 协议/状态/宿主生命周期（Rust unit + integration） | 握手、错误码、request id、超时、取消、崩溃重启、token、Job Object/PDEATHSIG/清扫 | `cargo test --manifest-path src-tauri/Cargo.toml --lib <plugin filter>`；跨进程 fixture 由 TASK-013 提供 | RPC fixture、宿主日志、G1–G11 表 |
| V-003 | 共享能力下沉和边界（Rust + static audit） | capture、LogEmitter、RDP common 的调用方和行为；核心不 import 插件 crate | `pnpm check:refactor`；新增边界脚本 fixture；必要时 `cargo test --test integration` | 依赖图、边界报告、回归日志 |
| V-004 | 前端注册/动态加载（Vitest + browser UI） | 缺失、禁用、坏 hash、CSP scheme、占位页、session/tab 恢复；核心 tab 仍可用 | `pnpm exec vitest run <新增/受影响测试>`；browser `qa_ui_auto run --tag impacted` | Vitest 输出、browser receipt、截图/运行时错误记录 |
| V-005 | 下载/安装/验签/回滚（Rust + browser/native） | 三代理模式、断点/取消/后台、签名失败、篡改、路径穿越、原子替换、卸载保留数据 | 先跑新增 Rust/TS tests；再用隔离 app-data 的 native smoke | 下载任务日志、包/签名 hash、安装状态快照 |
| V-006 | 迁移/备份（Rust integration + native） | 0.5.x fixture、幂等 journal、取消/失败恢复、未装插件数据备份和恢复、SocksCap recovery 特例 | `cargo test --test integration <migration filter>`；native 使用隔离 app-data | 迁移前后数据库 hash/行数、journal、恢复提示截图 |
| V-007 | 每个插件功能回归（browser/native） | RDP/VNC、Servers、SocksCap、截图 OCR/录制、MFA、本地语音、mobile 的主流程、断开/禁用/恢复 | 复用 `qa-ui-auto-tests/feature-list.md` 中现有 feature/case；新增 case 必须登记 `TC-*` | 每插件 case receipt、runtime-errors、功能/磁盘副作用证据 |
| V-008 | 发布清单与独立发版（Node tests + CI dry run） | 11 个插件平台矩阵、SHA/签名、`sequence`、原子上传、单插件更新不重发核心 | `node --test scripts/compose-updater-manifest.test.mjs scripts/release-workflow.test.mjs` 及新增 modules manifest tests | `modules.json`、签名验证日志、CI artifact manifest |
| V-009 | 崩溃回归（browser/native） | 完整 `crash-regression` 集合，再跑受影响功能；断言真实 pane/content/lifecycle 和 `assert_no_runtime_errors` | 按 `qa-ui-auto-tests/ci/crash-regressions.md` 使用隔离配置、匹配源码的 QA release binary，`--require-pass` | run receipt、`runtime-errors.jsonl`、源码/runner/case/binary 身份 |
| V-010 | 当前端真机与三端兼容检查（native） | 当前环境打包应用安装、插件启停、权限/进程清理；Windows/macOS/Linux 分别记录未执行或通过，不互相推断 | 依据当前平台 runbook；打包/签名/真实 WebView，不以 `pnpm dev` 代替 | 平台矩阵、截图/录屏、进程和文件清理记录 |
| V-011 | 多进程入口与 profile 协同（Rust integration + native） | 宿主与 `ProfileLease`/`ModeLease`、还原前静默、`--headless` 行为、迁出 re-exec 入口、核心-only 二进制不含迁出入口代码 | `cargo test --test integration <profile/headless filter>`；`strings`/`cargo tree` 检查核心-only 产物；native 使用隔离 app-data | 租约日志、还原前后进程列表、产物符号检查 |
| V-012 | 单体升级迁移（Rust unit/integration + native） | 0.5.x 旧数据预检、journal 幂等/中断恢复、签名或下载失败回滚、Vault 固定密钥、未安装插件提示与核心可用性 | `.github/workflows/qa-modular-upgrade.yml` 在 Linux/Windows/macOS runner 执行协议、前端和边界契约，Linux 额外执行 `cargo test --lib plugin::migration`；native 使用旧版 fixture 和隔离 app-data 执行升级 smoke | journal、源/目标指纹、回滚目录、迁移提示截图 |

浏览器 stub、Vitest 和 `pnpm build` 只能证明前端逻辑、类型或静态构建，不能替代宿主进程、Tauri capability、签名、代理、文件权限、真实 WebView 和系统授权验证。所有 V 项在实现前标为待执行；执行结果必须区分通过、失败、skip、环境阻塞和未验证。

---

## 12. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| M2 一起迁 11 个有效插件，单批失败拖垮第一版 | 第一版延期 | M2 内部分批，每批独立验收；某批延期时该插件可暂缓进第一版，但须在 §13.4 修订记录里写明，不静默缩水 |
| `AppState` 拆分牵一发而动全身 | 核心回归面大 | M0 只拆结构、不动业务；每批迁移后跑核心-only 回归 |
| RDP / VNC 服务端从 `servers/` 拆出，注册表与 tab 锁（`tab_lock.rs`）耦合 | Servers tab 单实例锁失效 | 拆分时把 `tab_lock` 按插件拆，`plugin-rdp-client / plugin-vnc-client / plugin-rdp-server / plugin-vnc-server` 各自持锁，`plugin-servers` 不再持 RDP / VNC 的锁；用例覆盖 |
| SocksCap / Servers 提权路径在卸载时残留驱动 / helper | 系统状态脏、更新失败 | 复用 `sockscap_prepare_for_update` 的清理路径；卸载前先停服务、清状态，再删代码 |
| `modules.json` 与 `latest.json` 双清单不一致 | 商店显示的版本与实际包不符 | 生成器同一套门禁（同名双架构、签名原始字节不变）；发布是原子操作，先传包、最后发清单 |
| **插件形态或契约选错**：进程内 cdylib、安装安全或 RPC 生命周期不成立（§5.0） | 做到 M2 才发现，返工整个运行时 | M0 验证门 G1–G11 先行，G 项未过不进 M2；选项 B 仅作为 G5 失败时回到 DEC-1 重议的备选 |
| macOS 自签名发布包拉不起下载来的宿主，或屏幕录制授权归属到宿主而非核心（G1、G2） | 截图引擎、RDP 服务端在 macOS 上用不了或每次升级重新授权 | 这两类能力的采集部分已下沉核心 `capture/`（§4.2 S1）；若 G2 仍不通过，对应插件在 macOS 暂以核心内置能力提供，写入 DEC-2 例外 |
| `plugin-mobile` 与核心终端热路径双向耦合（§4.5） | 拆出后终端延迟退化，或拆不动 | S6 扩展点 + 终端性能基线验收；验收不过则暂缓 mobile，并在 §13.4 写明 |
| 老用户升级后“功能消失” | 投诉、误以为数据丢失 | §6.5 迁移向导 + 可选全量安装包；数据不删（§8.2） |
| SocksCap 恢复日志未清理而插件未装（§8.2） | 系统网络状态残留 | 启动时核心检测并明确提示，引导安装或手动清理 |
| `plugin-mobile` 的桌面远控、headless 与控制面在 v1.4 之后显著扩大（§4.5） | M2 最后一批拖垮首发 | M0 末 go/no-go；默认按 DEC-2 暂缓排期；S14/S15 接口先评审 |
| 插件加密库的数据密钥在核心 Vault，备份快照在进程内（S12、S13） | 还原后 MFA / 数据无法解密或还原中途被宿主写入 | 受限 Vault 服务 + `backup.snapshot` + 还原前静默；三种状态的备份还原用例（AC-016） |
| 迁出的 re-exec 入口漏迁（S11） | 核心-only 二进制仍含 VNC / SocksCap 代码，或 Windows / macOS 子进程找不到入口 | 归属表 + V-011 产物符号检查 + 原有平台用例 |
| 核心-only 的 crash-regression 因插件依赖用例缺失被误判通过 | 崩溃回归缺口 | `requires-plugin` 登记、两套报告并列（§11） |
| 同一把 minisign 密钥签核心与全部插件 | 密钥泄露影响面扩大 | §9 签名绑定 trusted comment；是否为插件单设子密钥在 §13.3 评审 |
| 用户误解“截图入口在核心 = 截图全在核心” | 以为 OCR 不用装插件 | 商店与占位页文案写清：入口在核心，OCR / 录制引擎是插件（§3.7、§4.3） |

**回滚**：核心回滚走现有 updater 回滚（旧版本重装）；插件回滚走商店“回滚到上一版本”（§6.3）；两者互不影响。若 P1 上线后发现插件运行时有严重缺陷，可先在 `modules.json` 里下架该插件（商店不再显示），已装用户不受影响，核心不受影响。

---

## 13. 决策记录（用户已决策；v1.4 补充实施约束）

### 13.1 已决策（2026-11-14，用户原话与本文落笔一一对应）

| # | 用户原话（2026-11-14） | 本文落笔 |
|---|---|---|
| 1 | 选读法 B | §3.3：23 种核心 session 类型完整客户端留核心；§1.6、§1.7 写明 trade-off |
| 2 | Workspace 的 5 个重型子项：放到核心 | §3.4：LSP、DAP、Git、Build / Run / Debug、Java 结构化搜索全部留核心 |
| 3 | 截图入口、备份：放到核心其它插件 | §3.7：截图入口、备份留核心；§4（`plugin-mfa`）做插件（2026-11-14 20:28 用户确认理解正确）；**2026-11-14 DEC-3：用户取消 nettools 插件**（“先删除这个功能，其实也没有实现”），第 3 项现为：截图入口、备份留核心，仅 MFA 做插件 |
| 4 | Tao Agent 全部要作为核心 | §3.5：Agent 全套留核心；本地语音 / 模型二进制仍归插件（2026-11-14 20:22 用户确认理解正确） |
| 5 | RDP 和 VNC：客户端和服务端都做插件并且是两种类插件 | §4：两类 = 客户端类与服务端类，共 4 个插件：`plugin-rdp-client、plugin-vnc-client、plugin-rdp-server、plugin-vnc-server`（2026-11-14 20:22 用户澄清） |
| — | 第一版就要求是 P1 的真插件 + 模块商店（2026-11-14 18:07） | §0.1、§5、§6：不做 P0 过渡态 |
| — | 首批试点是除第 1 点确认完成后的所有非核心模块（2026-11-14 18:07） | §4：11 个有效插件是首发目标（原 12 个，DEC-3 取消 nettools）；§10：内部分批，全部通过门禁后一起发版，DEC-2 例外必须明示 |
| — | 先作成插件，后续可能移除（2026-11-14 20:22） | §4.1：暂定插件，`status: provisional`，核心不得依赖，移除前先标 deprecated、再下架、数据可导出 |

### 13.2 已关闭的解释项

无。第 3、4、5 项的解释已全部由用户确认：第 3 项（2026-11-14 20:28）——截图入口、备份放核心，MFA、nettools 做插件（其中 nettools 已被 DEC-3 取消，见 §13.3）；第 4 项（20:22）——本地语音 / 模型二进制排除在 Tao Agent“全部”之外；第 5 项（20:22）——“两种类”指客户端与服务端两类，已按 4 个插件落笔。

### 13.3 未决策

**v1.3 审查新增的四项取舍（DEC-1 ~ DEC-4 均已由用户在 2026-11-14 答复）：**

| ID | 问题 | 选项与代价 | 结论 | 状态 |
|---|---|---|---|---|
| DEC-1 | 插件原生部分的形态（§5.0） | A：独立宿主进程 + 稳定 RPC 协议。无 ABI 问题、崩溃隔离、启用 / 禁用 / 升级不重启；代价是命令层要从 `#[tauri::command]` 重写成消息处理、多一个进程、三端对下载来的可执行文件各有拦截（G1–G4）。B：进程内 cdylib + `extern "C"` 单入口。低延迟、单进程；代价是崩溃拖垮核心、不能热卸载、macOS 要放宽 `Entitlements.plist`、插件变更需重启应用 | A，由 M0 验证门 G1–G11 验证；G5（帧吞吐）不过再回到 B | **用户已定：选 A（2026-11-14 答复“A：宿主进程”）**；M0 验证门不过时回到本项重议 |
| DEC-2 | 允许受控例外：某插件因耦合或平台限制，第一版暂缓出插件、保留在核心（涉及 `plugin-mobile`，以及 G2 不通过时 macOS 上的截图 / RDP 服务端） | 接受例外：第一版可能不是“全部 11 个都插件化”，但每个例外有验收标准和修订记录；不接受：第一版延期直到全部拆完，或接受更大范围的核心重构 | 接受，且仅限 §4.5 与 G2 描述的情形 | **用户已定：接受，仅限 mobile 与 G2（2026-11-14 答复）** |
| DEC-3 | `plugin-nettools`（实测仅 82 行前端 `ProxyTestTab`，Rust 侧 `proxy/` 不能迁，§4.4）是否仍做成独立插件 | 保持独立插件、并入核心，或取消 | 取消插件化；保留核心 `proxy/`、`test_proxy_connection` 和隧道管理器 `nettools` | **用户已定（2026-11-14）**：“先删除这个功能，其实也没有实现”。本设计将其解释为取消独立插件；删除 `ProxyTestTab` 的产品变更另开任务，避免误删仍被 Session/Settings 使用的核心代理测试路径。 |
| DEC-4 | 滚动长截图（`screenshot/scroll*`，约 2.3k 行）归核心还是 `plugin-screenshot`（§4.3） | 留核心：入口体验完整、与 Overlay 紧耦合；入插件：核心更小，但插件边界要穿过 Overlay | 留核心 | **用户已定（2026-11-14）** |

**P1 不阻塞、发布切线时再定的其它项：**

- 第三方插件市场做不做、什么时候做（P1 只做官方插件）。注意：开放第三方需要把前端插件改为 iframe / 独立窗口沙箱（§5.3），是重新设计。
- `modules.json` 生成器是扩展现有 `compose-updater-manifest.mjs` 还是新增 `compose-modules-manifest.mjs`。
- P1 首版核心版本号（0.6.x 还是 0.7.0）。
- 体积基线实测由谁跑、在哪台机器跑（M0 的一部分）。
- 是否为插件包单设签名子密钥（§9）。
- 是否随发布提供“核心 + 全部插件”的全量安装包供企业 / 离线使用（§6.5）。
- `taomni-plugin-api` 与前端插件 SDK 是否对外公开文档（P1 内部使用即可）。

**v1.4 实施约束（agent 自决，依据当前源码和本次审查，不改变用户范围）：**

| ID | 约束 | 依据与影响 |
|---|---|---|
| DEC-5 | P1 使用独立 `scripts/compose-modules-manifest.mjs`，不把模块字段混进核心 `latest.json` 生成器；两者共享签名/资产校验库。 | 当前 `compose-updater-manifest.mjs` 的单一核心资产契约已有测试；拆出模块生成器降低核心更新回归面。TASK-012、V-008。 |
| DEC-6 | 插件安装采用“版本目录 + active 指针/原子替换”，运行中的宿主只绑定已激活目录；回滚只切换指针并重新握手。 | 直接覆盖正在执行的 exe/chunk 在 Windows/macOS 有锁定和缓存风险；该约束决定 TASK-009/011 的数据结构。 |
| DEC-7 | `permissions` 仅作为宿主 RPC 的核心 allowlist；前端插件继续按“官方签名、同 WebView 信任”处理，P1 不宣称第三方沙箱。 | 当前 `withGlobalTauri` 和单一 capability 使前端细粒度隔离不可得；见 §5.0 安全边界。TASK-007/011。 |

**v1.5 实施约束（agent 提出，用户已于 2026-11-15 确认采用，不改变用户范围）：**

| ID | 约束 | 依据与影响 |
|---|---|---|
| DEC-8 | re-exec 入口按归属迁移：核心只保留 `--ssh-stdio-forward`、`--screenshot-scroll-input`；VNC / SocksCap 入口迁入各自宿主二进制。 | `main.rs` 现状；否则核心-only 二进制仍链接插件代码。TASK-024、S11。 |
| DEC-9 | `--headless` 若 mobile 首发插件化，则留核心作为入口，只启动核心并拉起已安装的 `plugin-mobile` 宿主，未安装则明确报错退出；若 mobile 按 DEC-2 暂缓，则整体留核心。 | `mobile/headless.rs` 依赖完整 `AppState`；S15。mobile 的 go/no-go 在 M0 末进行，结果决定走哪一支。 |
| DEC-10 | 插件加密数据密钥走核心 Vault 的 slug 作用域受限服务，宿主不持有 Vault 句柄；运行中插件库经 `backup.snapshot` 备份。 | `mfa.data-key-v1`、`hot_backup_conn`；S12、S13。 |

**P1 不阻塞、发布切线时再定的其它项（v1.5 追加）：**

- `plugin-mobile` 的 go/no-go 在 M0 末按 §4.5 评估，排期默认按 DEC-2 暂缓（用户已于 2026-11-15 确认）。
- 屏幕采集合并：用户已于 2026-11-15 决定合并，方案见 §4.2.1，由 TASK-003 实施。

### 13.4 修订记录

- v1.9（2026-11-22）：确认 DEC-2 的 Mobile 首发例外。签名模块目录和 GitHub Release 说明记录 Mobile 归基座，后续模块独立发布时保留冻结的首发自动安装名单。

- v1.8（2026-11-19，用户要求 G1–G11 目标全部完成）：新增 TASK-027 作为独立收口任务，要求每个门禁绑定匹配源码 SHA、平台 runner、构建/安装身份和原始 artifact；G1–G11 未全部闭合时不得进入生产发布。

- v1.7（2026-11-19，用户要求将 Mail 从核心迁移到独立模块）：Mail session 记录和恢复元数据保留核心，邮件客户端、统一收件箱、缓存、同步与发送实现新增为 `plugin-mail`；有效模块数量增为 11；新增 TASK-026；明确核心-only、模块-only 和联合发布的差异资产规则。

- v1.6（2026-11-15，用户明确要求彻底删除 LanChat）：移除 LanChat 的插件规划、代码边界、IPC / UI / 备份与 QA 入口；升级预检只在旧数据目录原样保留旧 `lanchat.sqlite`，不读取、不复制、不移动、不迁移、不删除。有效插件数量由 11 减为 10，LanChat 不再进入首发、迁移和验收集合。
- v1.5（2026-11-15，基线 `7bc498b35`）：针对分支新增代码（自 `1d2f5748` 起 36 个非合并提交、402 个文件）重新取证并完善，模块化重构仍未开始执行。更新锚点与规模统计（`lib.rs` 593 行、`commands/mod.rs` 823 行、`TabKind` 23 种、Rust 331,079 行、`mobile/` 12,679 行）；更正三处与源码不符的结论：MFA 屏幕采集是自带实现而非走 `servers/rdp/capture`（现有采集实现分三处，已决定合并）、`panels.tsx` 已对 RDP/VNC 等使用 `React.lazy`、`mobile` 不止是观察者；新增 §1.8.1 前端耦合实测与 §1.10 基线漂移表；新增 §3.9（文件查看器归核心、`taomni-preview` 协议与 CSP 合并、vendored `wry` 约束）；新增 S11（re-exec 入口）、S12（插件数据密钥）、S13（备份快照与 profile 协同）、S14（mobile 控制面）、S15（`--headless`），并修正 S1（采集实现分三处，决定合并，方案见 §4.2.1）、S2（`control_permission_granted` 新调用方）；§4.5 扩充 mobile 事实并建议 M0 末 go/no-go；G1–G10 扩为 G1–G11（新增多进程 profile 协同与入口模式，G2 扩大到 mobile / MFA）；`module.json` 补 `legacyTables`、`vaultFixedKeys`、`snapshot` 与 `permissions` 初始取值草案；宿主 crate 禁止依赖 `tauri` / `wry` / `tauri-utils`；新增 TASK-024/025、AC-015/016、V-011，调整相关任务依赖与估算；§11 增加 crash-regression 的 `requires-plugin` 规则与自动化边界项；新增 DEC-8–DEC-10；用户于 2026-11-15 确认采用 DEC-8–DEC-10 以及“M0 末 mobile go/no-go、默认暂缓排期”的建议，用户同日决定合并屏幕采集，方案写入 §4.2.1 并在 TASK-003 明确（`taomni-capture` 库 crate + 核心 `capture/`）。
- v1.4（2026-11-14，基线 `1d2f5748`）：对 v1.3 设计做实现前审查并完善。更新过期提交锚点和规模统计；把 M0–M3 展开为 TASK-001–TASK-023，补充 AC-001–AC-014、V-001–V-010、依赖顺序、共享文件所有权和交接证据；将 G1–G7 扩为 G1–G10，增加安装篡改/路径安全、核心-only 依赖闭包和 RPC 超时/取消门；明确根 `Cargo.toml` 的依赖隔离是核心-only 瘦身阻塞项；冻结 DEC-3 为“取消插件化但保留核心代理测试能力”；将 DEC-4 从待定改为已决的核心归属；明确宿主进程隔离不等于前端沙箱；规定 11 个有效插件的全量目标与 DEC-2 受控例外的发布门槛；选择独立 modules manifest 生成器和版本目录原子切换作为实施约束。
- v1.3（2026-11-14 审查后）：以 `f532eb4c3` 的代码实测审查并修订。DEC-1 ~ DEC-4 已由用户答复：宿主进程方案 A、接受受控例外（mobile 与 G2）、取消 nettools 插件（§13.1 第 3 项随之修订）、滚动长截图留核心。主要变更：（1）§5.0 新增可行性审查，推翻 v1.2 “进程内 cdylib Tauri 插件”（Tauri 插件编译期注册、Rust 无稳定 ABI、capability 编译期固定、macOS 库校验、崩溃与卸载问题），推荐宿主进程形态并设 M0 验证门 G1–G7（DEC-1）；（2）§1.8 / §1.9 新增耦合与打包实测，§4.2 新增 10 项共享能力下沉（采集引擎住在 `servers/rdp/capture/`、RDP 服务端复用 RDP 客户端代码、`mobile` 嵌在终端热路径等），v1.2 “插件间依赖零”被证明不是现状；（3）更正插件边界：`plugin-nettools` 实际仅 82 行前端，`proxy/` 是核心基础设施，`TabKind "nettools"` 是隧道管理器（§4.4、DEC-3）；`plugin-screenshot` 实际仅 OCR + 录制约 2.3k 行（§4.3、DEC-4）；`plugin-ai-voice-local` 只含本地推理，云端 ASR 与麦克风采集留核心，且不存在已打包的 llama.cpp sidecar（§4.4）；`plugin-mobile` 可拆性须验收（§4.5、DEC-2）；（4）§5.1 `module.json`：去掉自带公钥的 `signature` 字段、`capabilities` 改为核心强制的 `permissions`、补 `slug`、`backupPaths`、`legacyTables`、平台列表对齐 `release.yml`；（5）§6.5 新增从 0.5.x 升级的迁移向导；§7.2 / §9 增加清单签名、`sequence` 防回滚、签名绑定包内容；§8 更正数据归属（Servers 与 RDP 证书钉扎在 `taomni.db`，SocksCap 是文件目录且有恢复日志特例）与迁移时不直连 `taomni.db`；（6）§10 M0 调整为 3–5 周并加入验证门与前置重构，总估算 6–11 周调为 8–14 周；§11 增加自动化边界检查、宿主进程专项、升级迁移用例；§12 增加 6 项风险；（7）修正交叉引用与编号（原 §4.11 → §4.1；原先指向不存在章节的引用，包括 §3.1 误指 A 窄核心、§3.7 误指 Tao Agent、§4.5 / §4.6、§14.2 / §14.5；“只有这三类”实为五项、`plugins/` 路径与 `[patch.crates-io]` 工作区冲突）。
- v1.2（2026-11-14 20:28 确认后）：第 3 项确认理解正确，§13.2 待确认解释清零。开 PR 前基线更新至最新 main `8233beaca`（Merge PR #808），锚点复核无变化（`lib.rs` 590→591 行、`commands/mod.rs` 807→809 行）。
- v1.1（2026-11-14 20:22 澄清后）：第 5 项改按客户端 / 服务端两类，RDP / VNC 拆为 4 个插件，插件总数 10→12；第 4 项确认理解正确；新增 §4.1 暂定插件（后续可能移除）。
- v1.0（2026-11-14 18:22 决策后）：初稿；§13 全部 5 项已决策，§13.2 三处解释待确认。

**M0 验证记录（2026-11-21）**

| 验证门 | 已取得的结果 | 剩余验证 |
|---|---|---|
| G1 macOS 宿主启动 | macOS 26 ARM64 的候选 DMG 与签名 MFA 宿主均使用固定证书及 hardened runtime。实际安装后带隔离属性的宿主成功启动，两个主体的 Gatekeeper 评估均返回 3。 [实装回执](https://github.com/engcapa/taomni/actions/runs/44816840208) | 最终候选与 main 使用同一固定签名身份，实测宿主启动并保留 Gatekeeper 原始评估。按 2026-11-22 的发布决定，接受主线的未公证配置。 |
| G2 macOS 系统权限 | 同一签名身份的核心升级后保留屏幕录制和辅助功能授权。macOS 26 ARM64 的已安装签名 MFA 通过核心 `capture.still` 读取窗口并识别账号。 [授权保持](https://github.com/engcapa/taomni/actions/runs/44816840208) · [实装采集](https://github.com/engcapa/taomni/actions/runs/44824402835) | 补齐正式候选的原生输入及各模块权限归属。 |
| G3 Windows 系统保护 | GitHub Windows Runner 在 Defender 实时保护开启时从 `LOCALAPPDATA` 成功启动带 Internet 区域标记的 Hello 和 MFA。启动前后均确认实时保护开启。 [Defender 工件](https://github.com/engcapa/taomni/actions/runs/44628961420) | 在最终候选上复验下载宿主、Defender 与执行结果，附安装件 Authenticode 状态。接受主线的未签名配置。 |
| G4 Linux `noexec` | deb、RPM 和 AppImage 均验证宿主拒绝、用户按指引迁移 profile、原 Vault 与 MFA 连续读写。 [安装验证](taomni-modular-installed-upgrade-verification.md#linux-安装格式的-noexec-恢复) | 正式首发产物按同场景复验。 |
| G5 帧吞吐 | 签名 RDP 查看器的 Linux、Windows 和 macOS 26 分别测得 p95 84.00、46.90、76.00 ms，每端均收到 40/40 个样本，均在 130 ms 上限内。独立探针通过首帧、动画帧率和带宽检查。 [Linux](https://github.com/engcapa/taomni/actions/runs/44890131445) · [Windows 与 macOS](https://github.com/engcapa/taomni/actions/runs/44888211385) | 在同一正式候选 SHA 上复测并绑定各平台签名包与原始样本。 |
| G6 强制退出 | Linux deb、Windows MSI 和 macOS 26 ARM64 DMG 各有实装强退回执。签名 MFA 宿主在驱动清理前退出，重开后原账号继续计数。 [Linux 安装验证](taomni-modular-installed-upgrade-verification.md#linux-已安装应用的强制退出) · [Windows 实装](https://github.com/engcapa/taomni/actions/runs/44886832952) · [macOS 实装](https://github.com/engcapa/taomni/actions/runs/44816840208) | 用同一正式候选验证三端及各业务宿主的资源回收。 |
| G7 无重启生命周期 | Linux、Windows、macOS Intel 的签名模块更新和回滚经过实际宿主重新握手，保留禁用偏好及原数据。 [三端结果](https://github.com/engcapa/taomni/actions/runs/44287815253) | 正式业务宿主逐个验证状态、资源释放与回滚。 |
| G8 验签与路径 | 四种原生运行配置通过正式公钥校验的包安装和篡改拒绝。签名目录和原子发布另有下载与发布契约。 [安装用例](https://github.com/engcapa/taomni/actions/runs/43804951477) · [发布契约](https://github.com/engcapa/taomni/actions/runs/44393439596) | 正式首发目录与每个首批包的签名及拒绝用例。 |
| G9 核心依赖闭包 | `b97d58d22` 的四个默认核心 Cargo 构建目标排除了 RDP/VNC 客户端引擎及宿主，生产 Vite 清单也排除了对应查看器。 [四目标依赖清单](https://github.com/engcapa/taomni/actions/runs/44879692505) | 核对其他首批模块的依赖裁剪与四个真实安装包的产物清单。 |
| G10 协议与取消 | 三端各 37 项实际进程测试覆盖监督、取消、Vault 撤销、profile 作用域和快照。 [宿主结果](https://github.com/engcapa/taomni/actions/runs/44020928836) | 首批业务的完整请求、错误和资源释放验收。 |
| G11 多进程 profile | 现有入口已统一持锁，得到宿主生命周期和实际快照、正常重启的证据。 [进程及还原证据](taomni-modular-split-progress.md) | 所有正式入口的多实例矩阵、迁出的 re-exec 与核心产物裁剪。 |

### 13.5 当前实现与 hosted 验证快照（2026-11-19）

插件 API/registry、验签安装、生产宿主监督、共享采集/RDP 公共库、CoreState/统一 bootstrap、作用域 Vault、profile generation 与静默快照已集成。原生下载支持三代理、后台进度、取消、续传及重启恢复；远端商店已接入并取得测试签名目录的三端 native 证据，正式目录、独立业务更新/回滚和四目标正式发布仍待完成。各批结果只保护对应源码与场景，逐 TASK/AC/G 的身份、原始结果和缺口见[实施台账](taomni-modular-split-progress.md)。

TASK-025 的 Vault 服务、锁、一致快照、离线 v2 和三态正常重启已有契约及 Native 证据。macOS 15 Intel 的真实确认自动 relaunch 已覆盖三态。旧 MFA 迁移完成后，生产入口通过签名宿主访问原账号，v2 数据归档可在另一个 profile 还原后单独安装并启用模块。动态 MFA 界面、新装 profile 的宿主入口和签名 MFA 三态完整验收按台账推进。 [还原入口验证](taomni-modular-restore-relaunch-verification.md) · [实施台账](taomni-modular-split-progress.md)

主窗/独立 WebView 的动态模块 ESM、状态清理、locator 恢复与篡改拒绝已有 native 证据，具体业务前端仍待迁出。WKWebView 的跨 `tauri`/`taomni-plugin` scheme 导入问题使用应用同源保留前缀转发到相同 registry/完整性验证器解决，不放宽 CSP、CORS 或原生文件范围；契约与验证边界见[前端接入方案](taomni-modular-frontend-contract.md)。

从单体版首次升级按签名首发名单自动安装当前平台兼容模块。后续按实际安装状态提供更新，目录中新增的兼容模块展示名称、说明和选装入口。已验证从 `0.5.10` 替换和回退四种目标的安装件，Linux deb 还覆盖原账号进入签名 MFA 模块。`plugin_migration_execute` 为其余业务项记录 pending journal。历史 LanChat 库留在原 profile。 [安装验证](taomni-modular-installed-upgrade-verification.md) · [更新策略](#64-更新检查)

远程 main `80ec08eee` 已合并，保留 File Explorer 可编辑类型新建和 Markdown Live 表格。TASK-015 已按删除 LanChat 的决定取消。Browser、Native、跨进程和真实安装验证在 GitHub runner 执行，分片完成即下载并核对源码及结果。 [文件编辑验收](file-explorer/editable-file-creation-and-live-tables.md) · [运行台账](taomni-modular-split-progress.md)

---

## 14. 参考

- 现状核查：v1.5 基于 `7bc498b35`（Merge PR #813，v1.4 基于 `1d2f5748`），`package.json` 0.5.9；`src-tauri/src/session/models.rs`（`SessionType` 26 种）、`src/types/index.ts:9`（`TabKind` 22 种）、`src/lib/welcomeSessionResume.ts`（映射与可恢复类型）、`src-tauri/src/state.rs:77`（`AppState`）、`src/layouts/main/TabContentRouter.tsx`（静态 import）、`src-tauri/tauri.conf.json`（bundle + updater）、`.github/workflows/release.yml`、`claudedocs/auto-update-plan.md`（更新与签名）、`DESIGN.md`（架构总览）、`roadmap.md`（2026-08-05）、`qa-ui-auto-tests/feature-list.md`（已实现功能清单）。
- 前序设计：`docs-feature/tao-home-design.md` v1.3（PR #806 已合入）+ ADR `claudedocs/adr-tao-home-deepseek-app.md`——Tao Home 与 Tao Agent 是核心的一部分，模块化不得改动。
- v1.4 审查所用的取证命令：`grep -rE "crate::<模块>" src-tauri/src`（耦合，§1.8）、`wc -l` 与 `find … -type f | wc -l`（行数与文件数）、`du -sh`（工作树规模）、阅读 `src-tauri/Cargo.toml`（workspace、features 与 `[patch]`）、`src-tauri/capabilities/default.json`、`src-tauri/tauri.conf.json`、`src-tauri/Entitlements.plist`、`src-tauri/nsis/hooks.nsh`、`.github/workflows/release.yml`、`docs-issue/macos-screenshot-permission-and-signing.md`、`qa-ui-auto-tests/README.md` 与 `ci/crash-regressions.md`。引用次数只表示耦合方向，不是工作量。
- v1.5 增补取证命令：`git log --no-merges 1d2f5748..HEAD`、`git diff --stat 1d2f5748 HEAD`（漂移）；`grep -rn "crate::mobile|state\.mobile" src-tauri/src`、`grep -rhoE "crate::[a-z_]+" src-tauri/src/mobile/desktop`（mobile 双向耦合）；`grep -rn "get_fixed|hot_backup_conn|ProfileLease" src-tauri/src`（S12、S13）；阅读 `src-tauri/src/main.rs`、`mobile/headless.rs`、`mobile/desktop/*`、`viewer/mod.rs`、`mfa/capture.rs`、`src/layouts/main/panels.tsx`、`qa-ui-auto-tests/ci/crash-regressions.md`；`src/` 的 import 反查（§1.8.1）。
- 行数与文件数：Rust 行数按 `find src-tauri/src -name "*.rs" | xargs wc -l` 实测；前端文件数按 `find src/components/<dir> -type f | wc -l` 实测；均截至 2026-11-14 18:22 前后，未实测已发布安装包体积（见 §1.4）。
