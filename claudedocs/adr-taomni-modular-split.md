# ADR 2026-11-14: Taomni 模块化拆分 — 核心默认安装，插件独立打包发布

## Status

Accepted as a design decision; implementation not started. v1.4 is the current review revision, based on `1d2f5748` (Merge PR #810). M0 tasks are ready to start; plugin migration is blocked until the G1–G10 feasibility gates pass. The executable plan is in `docs-feature/taomni-modular-split-design.md` §10.1.

## 1. Context

Taomni 是 Tauri 2 + React 19 + Rust 的本地优先桌面工作台。当前发布仍是一个核心包、一个 `latest.json` 和一个 Rust `AppState`：根 `package.json` 为 0.5.9，`src-tauri/src/lib.rs` 591 行、`commands/mod.rs` 809 行，前端 `TabContentRouter` 静态引入多个重型 tab。当前基线实测为 `src/` 2,926 个文件、`src-tauri/` 2,083 个文件、Rust 325,226 行；发布包体积尚无可复现基线，必须由 TASK-001 先测量。

用户要求核心默认安装、其它能力独立发布，并在第一版交付真实插件运行时和模块商店。首批目标是全部有效非核心模块；实现仍在同一 monorepo，插件以独立 artifact 发布。

## 2. Decisions

### 2.1 核心边界

- 核心保留窄核心（终端、SFTP、Tao 轻聊）、除 RDP/VNC 外的 24 种 session 客户端、Workspace/Code Workspace 全量、Tao Agent 全量、Notes、截图入口、备份、代理基础设施、共享采集服务和插件基础设施。
- RDP/VNC 客户端与服务端拆成四个插件：`plugin-rdp-client`、`plugin-vnc-client`、`plugin-rdp-server`、`plugin-vnc-server`。
- 有效插件共 11 个：上述四个，加 `plugin-servers`、`plugin-sockscap`、暂定的 `plugin-lanchat`、`plugin-screenshot`、`plugin-mfa`、`plugin-ai-voice-local`、`plugin-mobile`。
- nettools 不作为插件。核心 `proxy/`、`test_proxy_connection`、隧道管理器 `TabKind "nettools"` 保留；删除 `ProxyTestTab` 需要另开产品任务。

### 2.2 原生插件形态

采用用户已选择的 A 方案：插件原生部分是核心拉起的宿主可执行文件，控制通道为 stdio JSON-RPC 2.0，高带宽帧走绑定 `127.0.0.1` 随机端口和一次性 token 的 loopback WebSocket；前端部分是签名包中的 ES module chunk，在主 WebView 通过注册表动态加载。

理由：Tauri plugin 注册、capability 和窗口白名单是编译期机制，Rust 没有稳定 ABI，下载来的 cdylib 还涉及 macOS library validation；进程内动态库不满足运行时安装、崩溃隔离和可卸载要求。进程内方案只作为 G5 吞吐门失败后的重议选项，不能先行实现。

宿主进程隔离原生崩溃和生命周期，不提供前端沙箱。插件前端与核心前端同处主 WebView，`permissions` 只约束宿主 RPC；P1 只发布签名的官方插件，第三方插件沙箱是后续重新设计。

### 2.3 运行时、数据与发布

- 新增 `taomni-plugin-api` 和 `taomni-rdp-common` 库 crate；插件 crate 作为 `src-tauri` workspace 成员，以复用根 `[patch.crates-io]`，但不得依赖核心 crate 或其它插件。
- 核心拆为 `CoreState + PluginRegistry`。插件内部状态保存在宿主；核心只保存元数据、宿主句柄、RPC client、安装状态和共享服务扩展点。
- 每个插件有 `module.json`、独立版本、平台 artifact、分离 minisign、SHA-256、`coreApiVersion` 和 `permissions`。安装使用版本目录 + active 指针/原子替换，默认卸载保留数据，显式删除才清理。
- 核心继续使用 `latest.json`；插件使用独立签名的 `modules.json`。模块清单生成器独立为 `scripts/compose-modules-manifest.mjs`，共享底层签名/资产校验但不改变核心更新清单契约。
- 代理、下载、断点续传、取消、进度、失败恢复、备份和迁移必须遵循仓库 `AGENTS.md` 的外部网络与数据完整性要求。

## 3. Feasibility gates and release rule

M0 必须用 hello-plugin 和一个真实原生插件完成 G1–G10：macOS/Windows/Linux 宿主执行与系统信任、TCC 归属、Linux `noexec`、帧吞吐、崩溃清扫、无重启生命周期、安装篡改/路径安全、核心-only 依赖闭包和 RPC 超时/取消。任一门失败时，受影响插件不得进入 M2；只有 DEC-2 允许的 mobile 或 macOS G2 例外可以暂缓，并必须同步到 `modules.json`、发布说明和设计修订记录。

核心-only 依赖闭包是硬门：只把插件 crate 加入 workspace 不算拆分，根 `Cargo.toml` 的 optional dependencies、default features、bundle resources、Linux package dependencies、前端 chunks 和 helper 必须一起迁移并由 `cargo tree`/artifact 检查证明。

## 4. Consequences

正向结果：核心可离线运行；插件可独立安装、启用、禁用、卸载、回滚和发布；原生特权面、崩溃和重型依赖可单独审计。

成本与限制：核心仍保留数据库、邮件、HBase、Code Workspace 和 Tao Agent，瘦身收益需以 M0 实测为准；宿主 RPC、跨平台签名、TCC/SmartScreen/noexec、数据迁移和 mobile 热路径解耦是主要风险；P1 前端不是第三方安全沙箱。

## 5. Implementation plan

执行入口是设计文档 §10.1 的 TASK-001–TASK-023：先做基线/协议、共享能力下沉、状态和依赖闭包，再做宿主/注册表/下载/验签/迁移，随后按 MFA/LanChat → RDP/VNC → Servers/SocksCap → Screenshot/Local Voice/Mobile 分批迁移，最后执行发布和回归收口。任务完成必须关联 AC-001–AC-014 与 V-001–V-010 的证据。

## 6. References

- [完整设计与任务计划](../docs-feature/taomni-modular-split-design.md)
- `docs-feature/tao-home-design.md`：Tao Home/Agent 核心边界
- `claudedocs/auto-update-plan.md`：现有核心 updater、签名和发布契约
- `qa-ui-auto-tests/ci/crash-regressions.md`：完整 crash-regression 验收集合
- 仓库 `AGENTS.md`：800 行边界、下载代理/进度/取消/校验和测试要求
