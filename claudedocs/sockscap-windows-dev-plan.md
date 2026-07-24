# SocksCap Windows 开发计划

**目标**：在 Windows 上交付可发布的透明 TCP 捕获(全局/按应用)、经 HTTP/SOCKS5/SSH 上游路由;安装包开箱具备 `sockscap-helper` 与 WinDivert,且捕获状态仅在提权 helper + WinDivert 实际就绪后显示为 Active。

**当前状态**：捕获代码已实现并经内网手测(WinDivert 2.x 动态 FFI、FLOW+NETWORK streamdump 反射、UAC helper + token RPC、relay 端口热切换、与三端共享的策略/egress 引擎)。主要差距在**分发**(helper 未入安装包、WinDivert 未随包)、**CI/自动化测试**(无 Windows job、win11 测试打真机且含硬编码凭据)与**真机功能验证**(无自动化留痕)。

**关键决策(已确认)**：
- WinDivert 随安装包打入(动态加载已满足 LGPLv3/GPLv2;`WinDivert64.sys` 沿用作者已签驱动,不重签)。
- `sockscap-helper.exe` 复用发布流程已有的 Authenticode 证书签名。
- 暂无可提权 Win11 真机 → 真机功能验证(Phase 4)标记延后。
- 多方案(多个 App 方案各走不同上游)本轮仅做代码保证 + 单测,不真机验证。

## Task checklist

- [x] **Phase 0：现状基线与差距识别**
  - [x] WinDivert 2.x 动态 FFI(运行时 `LoadLibrary`,探测并拒绝 1.x)。
  - [x] FLOW(PID 归属)+ NETWORK streamdump 反射捕获引擎,IPv4/IPv6;App 模式 PID→端口倒排索引 + 进程树祖先匹配 + `GetExtendedTcpTable` owner-PID 兜底。
  - [x] UAC 提权 helper + loopback JSON-RPC(token 鉴权、ready-file 握手);relay 端口热切换(`capture_update`)。
  - [x] 与 Linux/macOS 共享的 `config`/`policy`/`rules`/`egress`/`stats`/`recovery`。
  - [x] 识别差距:capture 引擎无自动化验证;helper 未入安装包;无 Windows CI;`win11` 测试打真机且含硬编码凭据。

- [ ] **Phase 1：打包与分发**
  - [ ] `tauri.conf.json` 增加 `bundle.externalBin`,把 `sockscap-helper`(.exe)打入安装包;校验 `paths.rs` 的安装态路径解析命中(现无 `externalBin`,发布包不含 helper)。
  - [ ] WinDivert.dll + WinDivert64.sys 随包:bundle 前 staging 到资源目录 + `resources` 通配收录;README 补 LGPLv3/GPLv2 合规与再分发声明。
  - [ ] `sockscap-helper.exe` 复用发布 Authenticode 证书签名(与主程序同证书)。
  - [ ] 给 `stage-sockscap-windows.ps1` 增加 `--check` 模式,接入 `beforeBundleCommand` 的 Windows 分支做发布前预检(对齐 `stage-sockscap-linux.sh --check`)。
  - [ ] 验证:`tauri build` 产物含 helper + WinDivert 且签名有效;干净机器安装后 Start 可拉起提权 helper。

- [ ] **Phase 2：测试与 CI**
  - [ ] `sockscap_win11_scenarios.rs` 的 HTTP/SOCKS5/SSH dialer 测试加 `#[ignore]` 或 env 门控,避免无内网时 CI 挂起/失败。
  - [ ] 移除硬编码真实凭据(SSH 口令)与内网 IP(`10.1.0.80` 等),改环境变量注入;(建议清 git 历史,待确认后执行)。
  - [ ] `release.yml` 新增 Windows sockscap job:`cargo build --bin sockscap-helper`、`policy`/`config` 单测、`stage-sockscap-windows.ps1 --check`。
  - [ ] 验证:Windows CI 绿;无内网也不阻塞。

- [ ] **Phase 3：多方案代码保证与健壮性**
  - [ ] 走查并补单测:单 relay + per-flow `PID→path→profile` 归属(policy 已有多方案单测,补 Windows 归属路径可单测部分)。
  - [ ] 走查 Global 与 Apps 混合激活语义(`mode_apps` 仅全 Apps 时为真 → 混合走全局捕获 + relay 侧按 `process_path` 归属)。
  - [ ] 运行中修改 app 选择/模式:补热更 `app_paths`/`mode` 到 helper,或 UI 明确提示需 Stop/Start(现 `set_config` 仅热更 relay 策略,`capture_update` 仅换端口)。
  - [ ] 应用退出时对 helper 发 `capture_stop`/`shutdown`,避免残留提权进程与已加载驱动。
  - [ ] 失败态 UI 可读可重试:UAC 取消、WinDivert 1.x、驱动未签、`.sys` 被占用。
  - [ ] 说明:多方案不在本轮做真机多上游验证(见关键决策)。

- [ ] **Phase 4：真机功能验证与发布(延后 — 缺可提权 Win11)**
  - [ ] Global:全局 TCP 经上游,IPv4+IPv6,`bypass_cidrs`/`bypass_pids`/`bypass_endpoints` 生效(relay 回环不被再捕获)。
  - [ ] App:FLOW 可用与 FLOW 不可用(SOCKET/TCP 表兜底)两条路径。
  - [ ] streamdump 反射在真实网卡上的正确性(校验和重算、长连接续传、分片)。
  - [ ] Stop/Recover/崩溃后 `boot_repair` 清干净 WinDivert 句柄与网络状态。
  - [ ] 收集真机流量、UI Active/字节计数、包产物证据;准备 release/tag。

## 验证记录

- 本机为 Linux:可跑共享层单测(`sockscap::policy` / `config`),无法编译 windows target、无法加载 WinDivert;Windows 专属项均未在此环境验证。
- `win11` scenarios 测试存在但直连硬编码内网(`10.1.0.80` 等)且未门控,当前非提权/无内网环境不可用。
- Phase 1–3 为待执行(未勾选);Phase 4 依赖可提权 Win11,按决策延后。

## 实现偏差与原因

- TCP 重定向采用官方 WinDivert **streamdump 反射**(`C:sp→R:dp` 反射为 `R:sp→C:relay`),而非 NAT-to-127.0.0.1——后者投递不到 loopback-only listener,故 relay 绑 `0.0.0.0`。
- 多方案在 Windows 用**单 relay + per-flow PID→path 归属 profile**,区别于 Linux 的每方案独立 cgroup+relay 端口——Windows 无 cgroup v2 等价物。本轮仅代码保证 + 单测,不真机验证(见关键决策)。
- `WinDivert64.sys` 沿用作者 EV 已签驱动,项目侧只签自有 helper/主程序,不重签第三方驱动。
