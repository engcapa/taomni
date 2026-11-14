# ADR 2026-11-14: Taomni 模块化拆分 — 核心默认安装，插件独立打包发布（P1 真插件 + 模块商店）

## Status

Accepted（设计稿，非实现记录；完整设计见 `docs-feature/taomni-modular-split-design.md` v1.3，2026-11-14；修订见设计文档 §13.4）。v1.3 经代码实测审查，修订了插件形态与若干边界，并记录 4 项用户已答复的取舍（DEC-1 ~ DEC-4）；§2.1 的用户决策除 nettools 被取消外不变。

---

## 1. Context

Taomni 是本地优先的 AI 原生远程工作台（Tauri 2 + React 19 + TypeScript + Rust），现在是一个单体：一个版本（`package.json` 0.5.9）、一个包（`tauri.conf.json` `bundle targets: all`）、一个更新清单（GitHub Release 里唯一的 `latest.json`）、一个 Rust 入口（`lib.rs` 591 行 + `commands/mod.rs` 809 行 + `AppState` 全量运行时）、前端静态全量引入（`TabContentRouter.tsx` 直接 import 全部 tab）。Release 体积随功能越长越大，本地 main `8233beaca` 实测 Rust 约 324,633 行，`src/components/editor/` 一个目录 1,167 个文件，重型依赖（IronRDP、vendored OpenSSL、Whisper / Sherpa、openh264、多数据库驱动、`tree-sitter-java`、tesseract 语言包等）静态链接进默认包，功能不用也占体积。

目标：核心默认安装，其它模块独立打包发布，支持独立下载和安装。第一版不做 P0 多 profile 打包过渡态，直接做 P1 真插件 + 模块商店；首批是全部非核心模块。

## 2. Decision

### 2.1 核心边界（用户 2026-11-14 18:22 已决策）

- 核心 = A 窄核心（终端 + SFTP + Tao 轻聊）+ 全部 session 类型（除 VNC / RDP 外，24 种，完整客户端实现留核心，读法 B）+ workspace（Workspace-first 主壳 + Code Workspace 全量，含 LSP / DAP / Git / Build-Run-Debug / Java 结构化搜索 5 个重型子项）。
- Tao Agent 全部进核心（`agent/` + MCP + ACP / Claude Code / Codex 桥接 + chat + LLM 路由 + 工作流）。
- 截图入口、备份进核心；MFA 做插件；nettools 插件已取消（2026-11-14，用户：“先删除这个功能，其实也没有实现”，设计文档 DEC-3）。
- RDP、VNC：客户端和服务端都做插件，分两类：客户端类（`plugin-rdp-client`、`plugin-vnc-client`）与服务端类（`plugin-rdp-server`、`plugin-vnc-server`），共 4 个插件（2026-11-14 20:22 用户澄清；v1.0 的按协议分两类已废弃）。

24 种 session 类型：SSH、Telnet、Rlogin、LocalShell（含 WSL）、Serial、Mosh、FTP、Browser、SFTP、File、Proxy、MySQL、PostgreSQL、PanWeiDB、Oracle、SQLServer、StarRocks、ClickHouse、Presto、Redis、HBaseShell、Mail、S3、AzureBlob（`SessionType` 共 26 种，见 `src-tauri/src/session/models.rs:27`）。

### 2.2 插件清单（首批，11 个）

`taomni-plugin-rdp-client`、`taomni-plugin-vnc-client`、`taomni-plugin-rdp-server`、`taomni-plugin-vnc-server`、`taomni-plugin-servers`（除 RDP / VNC 外的内置服务器）、`taomni-plugin-sockscap`、`taomni-plugin-lanchat`（暂定，后续可能移除，见设计文档 §4.1）、`taomni-plugin-screenshot`（OCR / 录制引擎；入口留核心）、`taomni-plugin-mfa`、`taomni-plugin-ai-voice-local`（Whisper / Sherpa / llama.cpp）、`taomni-plugin-mobile`。数据库、邮件、对象存储、Code Workspace、Tao Agent 全部留核心，不在插件清单里。插件之间零依赖，只依赖核心。

### 2.3 插件运行时与模块商店

- 每个插件一份 `module.json`（id、slug、版本、`coreApiVersion`、平台、入口、tab、命令、`permissions`、数据目录、备份路径）；签名是包旁的分离 `.minisig`，验证公钥只用核心内置的一把；核心启动扫描 `应用数据目录/plugins/<slug>/`，校验签名记录与 `coreApiVersion` 后注册。
- 前端按注册表动态加载（`React.lazy`），替代 `TabContentRouter` 的静态 import；插件 chunk 使用宿主提供的 React 与共享库，通过核心自定义 URI scheme 加载（CSP 仅加这一个 scheme）。
- Rust 侧：v1.2 的“进程内 cdylib Tauri 插件”经审查不成立（Tauri 插件编译期注册、Rust 无稳定 ABI、capability 编译期固定、macOS 库校验、崩溃与卸载），v1.3 方案（DEC-1，用户已选 A；M0 验证门 G1–G7 不通过时重议）：原生部分是由核心拉起的插件宿主进程，经 stdio JSON-RPC 与核心通信，高带宽数据走 loopback WebSocket；插件 crate 放 `src-tauri/plugins/<slug>/`，作为现有 workspace 成员以共用 `[patch.crates-io]`；`AppState` 拆成 `CoreState + PluginRegistry`，命令经核心 `plugin_invoke` 分发。
- 模块商店在应用内：浏览、兼容性检查、下载（断点续传、分片校验、代理三模式、进度与取消）、minisign 验签（与核心同一公钥）、原子安装、启用 / 禁用、卸载（默认保留数据）、回滚到上一版本、离线安装本地插件包。
- 带原生部分的插件都是宿主进程；SocksCap 额外保留既有提权 helper；VNC Server 监督外部系统 VNC daemon；纯前端插件没有宿主（当前清单里没有）。
- 插件之间零依赖是**目标状态**，不是现状：实测屏幕采集引擎住在 `servers/rdp/capture/`（被截图入口、LanChat、RDP 服务端共用）、RDP 服务端复用 RDP 客户端代码、`mobile` 嵌在核心终端热路径里，需先做 10 项共享能力下沉（设计文档 §4.2）才能迁移。

### 2.4 版本与发布

- 同 monorepo，不同 artifact：代码仍在同一仓库开发、评审、跑 CI，发布时每个插件单独出包。
- 核心继续 SemVer，插件独立 SemVer，`coreApiVersion`（第一版为 `1`）是兼容矩阵的键；只改一个插件时，只发该插件的新包 + 新的 `modules.json`，不重发核心包。
- `latest.json`（核心）不变，新增 `modules.json`（插件），生成器扩展现有 `compose-updater-manifest.mjs` 思路，发布是原子操作。

### 2.5 待确认解释（设计文档 §13.2）与 v1.3 待决策项（§13.3）

无。第 3、4、5 项的解释已全部由用户确认：第 3 项（2026-11-14 20:28）——截图入口、备份放核心，MFA、nettools 做插件（其中 nettools 已被 DEC-3 取消）；第 4 项（20:22）——本地语音 / 模型二进制排除在 Tao Agent“全部”之外；第 5 项（20:22）——“两种类”指客户端与服务端两类，已按 4 个插件落笔。LanChat 为暂定插件，后续可能移除（设计文档 §4.1）。

v1.3 四项取舍均已由用户答复（2026-11-14）：DEC-1 插件原生部分用宿主进程（M0 验证门通过后落地，不通过则重议）；DEC-2 接受受控例外，仅限 `plugin-mobile` 与 macOS 屏幕录制授权（G2）不通过时的截图 / RDP 服务端；DEC-3 取消 `plugin-nettools`（用户：“先删除这个功能，其实也没有实现”；是否同时删除现有 `proxy-test` 页代码待澄清）；DEC-4 滚动长截图留核心。

## 3. Consequences

- **正向**：核心默认安装、离线可用；插件可独立发版、独立回滚，核心发版不强制重发全部插件；SocksCap / Servers 等特权面从核心包里移出，风险面可单独审计、单独回滚；商店让“装不装”变成用户选择，不再是打包时决定。
- **负向 / 成本**：按读法 B，核心还要背数据库全套驱动、邮件全套、HBase、对象存储、编辑器 + LSP + DAP + Git + 构建链、Tao Agent 全套，瘦身效果有限（见设计文档 §1.7）；P1 约 8–14 周（单人全职等效，估算非承诺；v1.2 的 6–11 周未计入前置解耦与形态验证门），`AppState` 拆分、采集引擎与 RDP 公共代码下沉、`mobile` 与终端热路径解耦是主要风险点；下载来的原生可执行文件在 macOS 自签名发布包、屏幕录制授权、Windows SmartScreen 下的行为是未验证风险（G1–G4）。
- **未验证**：本文是设计稿，未实测已发布安装包体积基线（M0 第一项工作），未编译插件运行时，未验证插件矩阵发布；体积收益以 M0 基线 + 每批增量为准，不以本文数字为准。

## 4. References

- 设计文档：`docs-feature/taomni-modular-split-design.md`（v1.3，2026-11-14）
- 前序设计：`docs-feature/tao-home-design.md`（v1.3，PR #806 已合入）——Tao Home 与 Tao Agent 是核心的一部分
- 现状核查：v1.2 基于 main `8233beaca`（Merge PR #808），v1.3 审查基于 `f532eb4c3`（Merge PR #809）；`DESIGN.md`；`claudedocs/auto-update-plan.md`（更新与签名）；仓库 `AGENTS.md`（800 行上限、外部网络与下载规则、测试与 crash 回归）
