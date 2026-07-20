# Taomni 跨平台 Sockscap 设计与实施计划

状态：Implementation in progress — Revision 9
初始日期：2026-07-18
最近更新：2026-07-20
本版范围：Revision 9 在 Revision 8 的公共 supervisor、Linux generation owner、Store/包安全边界上，补齐权威 packet→tuple/checksum admission、独立有界 TCP/UDP ingress、Direct UDP/策略 relay、组合 transport ceiling、runtime UDP in-flight byte budget，以及 provider quiesce → runtime/owner drain → final termination 的显式两阶段停机合同。smoltcp 以 `=0.13.1`、0BSD、crates.io archive SHA-256 `5f73d40463bba65efc9adc6370b56df76d563cc46e2482bba58351b4afb7535e` 进入受控底层基座，fragmentation feature 保持关闭，并有独立 packet/byte ceiling 的 `Medium::Ip` staging device。

本版仍不声称 provider 已完成：必须先以可执行 P0 spike 锁定 arbitrary-destination IPv4/IPv6 TCP exact-listener/SYN-ACK 与共享端口 UDP metadata demux，再完成 bounded socket actor/bridge、完整内存 ledger、MTU/deadline/parser-differential、Virtual DNS/reassembly 决策、可信 tuple→profile side channel和默认 async Linux 注入。queued-but-unaccepted flow/association 的 drain/quarantine、close-failure recovery，以及 Drop emergency detached reaper 也仍是生产 blocker。所有入口继续 fail-closed：四个 capability 位全 false，architecture/OpenPGP/完整 distro dependency contract 与受保护 lab attestation 仍为 `unconfigured`；当前不能称为任一平台已接通或生产就绪。

HTML 评审入口：[原型总览 / Dashboard](./sockscap-prototype/index.html) · [目标架构](./sockscap-prototype/architecture.html) · [配置组编辑器](./sockscap-prototype/profile-editor.html) · [规则与生命周期](./sockscap-prototype/rules-lifecycle.html)

## 1. 结论先行

该能力命名为 “Sockscap”，作为 Taomni 的独立网络流量路由模块，而不是扩展现有的 “Application Proxy” 开关。

核心设计是：

1. 系统只运行一个流量拦截平面，由它统一接收新建网络流。
2. 用户可以配置多个“路由配置组（Routing Profile）”；每组绑定程序、临时进程、上游 Proxy/SSH 会话和域名规则源。
3. 按配置组优先级选择策略，再按规则决定 PROXY、DIRECT 或 BLOCK。
4. 复用现有 Proxy、SSH Session、Dynamic SSH Tunnel 和 Vault，不建立第二套明文凭据。
5. 使用独立 Sockscap 窗口和系统托盘；关闭窗口只隐藏，明确退出时才停止引擎并恢复系统网络状态。
6. 不做 TLS 中间人解密，不保存请求正文或完整 URL。HTTPS 仅根据应用身份、远端主机名、DNS 映射、TLS SNI 或目标 IP 路由。

技术上可实现，但必须先经过 Phase 0 三平台能力门。最难的不是 HTTP CONNECT、SOCKS5 或 SSH `direct-tcpip` 转发，而是三平台的系统级拦截、权限、驱动/系统扩展签名、进程身份归属、DNS 泄漏与异常恢复。

### 1.1 2026-07-20 实施快照

当前分支已经越过“仅设计/原型”阶段，但还没有任何系统完成产品级真实接通。基准状态以 [Sockscap Release Gate Ledger](./sockscap-release-gates.md) 为准：

| 领域 | 已落地 | 当前缺口 |
|---|---|---|
| 策略与出站 | Profile/规则/GFWList、DIRECT、SOCKS5 TCP、HTTP CONNECT、共享 SSH `direct-tcpip`、严格 host-key | 三种 egress 的真实服务器兼容矩阵；稳定 SOCKS5 UDP；从系统流量进入这些连接器的数据面 |
| 生命周期 | `CaptureAdapter`、持久化 coordinator、WAL + disk `synchronous=FULL` recovery journal、helper heartbeat、guarded exit；同一 Store 的 runtime detached transactions 共用 store-scoped mutex，caller cancel 后仍持有 operation owner，recovery 使用 expected-generation CAS/revalidation；privileged call 前 durable adapter/generation binding，返回 handle 后校验 helper PID 等完整 lineage；untrusted receipt 仅允许 generation rollback；canonical 目录/锁/DB 检查和 retained OS owner lock 是 intended source-level journal 边界，Tauri single-instance 仅负责 activation UX | 默认 `AppState` 仍用 `with_store`，同步 IPC/tray recovery 没有构造真实 adapter；当前只有 same-process double-open/drop-release 与 Unix path 测试，handle-relative SQLite/VFS、Windows SID/DACL、三平台跨进程/crash/multi-session、helper 侧跨进程 generation lock 与真实系统残留恢复仍须 installed/root/native lab 闭环 |
| 共享数据面 | bounded TCP/UDP ingress 与 L3 admission；packet bytes 权威导出 tuple并校验 IPv4/TCP/UDP checksum，新 TCP 只接受 pure SYN；`FlowRuntime` 有独立 transport quota、组合 ceiling、Direct UDP relay与共享 in-flight byte budget；唯一公开 `ProductDataPlaneSupervisor` 实施 quiesce ack → runtime/owner drain → final termination，timeout 保留同一 owner；smoltcp 0.13.1 exact pin与有界 `Medium::Ip` device已落地 | P0 executable spike与完整 socket actor/bridge、最终 memory/profile/config builder、Virtual DNS/reassembly决策均未完成；queue 中未接收对象和 close failure 仍缺 bounded drain/quarantine/reconcile；Drop detached reaper仍非cleanup proof；不能解锁 capability 或替代 native/performance/24h/7d Gate |
| Linux 特权、产品 owner 与包 | cgroup v2+nft+fwmark/TUN、认证 helper、WAL/PID、fixed TUN/pump/lifecycle、generation adapter/coordinator recovery；公共数据面的 TCP/UDP/quiesce 基础；DEB/RPM-only overlay、policy/polkit、root:root 0755 runtime-dir、shared/exclusive lifecycle lock、package sentinel、严格 stage、快照/hermetic package verifier和元数据/mode Gate | signer/architecture、完整 GUI/系统动态依赖 profile与 trusted lab attestation 均 `unconfigured`；AppImage/updater capture-disabled；尚缺可运行 provider/final builder/tuple side channel/default async injection、签名包及真实 package-manager/root/native/PID-race lab，因此 capability 全 false |
| Windows | source capability/schema/template/verifier/tests 已收敛为 x86_64 + Wintun global + WinDivert app/PID，并固定官方 artifacts；PowerShell 7.2.24 AST 与 disabled-template lint 通过 | first-party publisher/certificate policy 当前 `unconfigured`；仍缺真实 Windows non-lint `/kp`、Wintun/WinDivert adapter/service、许可证、受信用户态签名和安装/兼容/恢复实验室 |
| macOS | release-only Tauri overlay、Info.plist/entitlement/profile/certificate/full-`.app` deterministic digest 合同与 codesign/provisioning/notarization verifier | Team/certificate/architecture policy 当前 `unconfigured`；`11.0` 仅 provisional build floor；仍缺 Apple capability、Xcode target、Swift provider、Rust bridge、真实签名/公证 `.app`，以及把最终 DMG/PKG/updater 绑定到该候选的 protected provenance |
| UI/native | 独立窗口、配置/恢复 UI、Linux native hide/reopen smoke | 三平台托盘、权限、helper/provider、退出和恢复 native/system smoke |
| 性能/长稳 | release-profile core quick、100 synthetic cycles、固定阈值、24h/platform verifier，以及严格 typed real-capture receipt/candidate hash 绑定 | typed native producer/case 尚无；24h core receipt；三平台真实捕获延迟/吞吐/泄漏/100-cycle/24h/安装证据；stable 所需 7-day staged actual-capture receipt/schema/verifier 尚未实现 |
| 生产发布运维 | updater 基础链路、签名 receipt 结构；Source/Quick Non-Release workflow 的第三方 Actions 已 pin 完整 commit SHA，Rust toolchain/MSRV 固定 `1.95.0`，Windows/macOS source compile/process checks 已配置 | Windows/macOS CI runner 结果尚未取得，不能声称两平台编译通过；正式 `release.yml` 尚未依赖该 workflow；另缺 protected release workflow/provenance producer、runner image 与 action 更新审计、updater 私钥托管/轮换/吊销、分阶段发布/停止放量/回滚、持续 SBOM/CVE、威胁模型、脱敏支持包与符号保留 |

因此当前必须继续保持 `capture_implemented=false`、`can_start_global=false`、`can_start_app_group=false` 和 `can_attach_pid=false`。源码存在、模板 lint 通过或 synthetic Gate 通过，都不能改变这些运行时能力位。

## 2. Taomni 当前可复用基础

仓库已经具备以下基础：

| 现有能力 | 位置 | 复用方式 |
|---|---|---|
| Tauri 2 + React 19 多窗口/托盘 | `src-tauri/src/windowing/mod.rs`、`src-tauri/src/sockscap/tray.rs`、`src/App.tsx` | Sockscap 独立 Webview/hash route、native tray 与 guarded exit 已落地；补三平台 native/system smoke |
| HTTP CONNECT / SOCKS5 Proxy 会话 | `src/components/proxy`、`src-tauri/src/terminal/network.rs`、`src-tauri/src/sockscap/flow/connectors.rs` | 已作为 Sockscap connector/session 来源；补真实服务器、DNS/IPv6/UDP 矩阵 |
| SSH Session、跳板与 Dynamic SOCKS5 | `src-tauri/src/terminal/ssh.rs`、`src-tauri/src/tunnel/mod.rs`、`src-tauri/src/sockscap/egress.rs` | 共享认证/host-key/connection pool；每个 TCP flow 使用 `direct-tcpip` 出站 |
| 应用自身代理配置 | `src/components/settings/AppProxyPanel.tsx`、`src-tauri/src/proxy/mod.rs` | 复用解析和连接测试，但不混淆产品语义或生命周期 |
| Vault 凭据 | `src-tauri/src/vault` | 保存上游代理密码，只在 Rust 侧短暂解析 |
| Sockscap SQLite/WAL | `src-tauri/src/sockscap/storage.rs` | `sockscap.db`、schema migration、统计和 recovery journal 已独立于主会话库 |
| IPC、事件与浏览器 Stub | `src/lib/ipc.ts`、`src/stubs`、`src-tauri/src/sockscap/commands.rs` | 真实 contract 与 `pnpm dev` 演示数据双路径已落地；真实 adapter 仍由 capability fail-closed |
| 三平台发布 Gate | `.github/workflows/sockscap-platform-gates.yml`、`.github/workflows/release.yml`、`scripts/sockscap`、`src-tauri/platform/sockscap` | Source/Quick Non-Release contracts/verifiers 与 Windows/macOS compile/process jobs 已配置，Linux 另有 DEB/RPM-only artifact Gate；Windows/macOS jobs 须以各自 CI runner 结果才可声称编译通过，且正式 release 尚未依赖；后续仍须真实 Windows service/driver、macOS provider 与三平台签名/native/package-manager evidence |

当前 Application Proxy 只用于 Taomni 自己的部分 HTTP 出站流量，不会接管系统或其他程序流量。Sockscap 必须是新模块，两者可以引用同一个 Proxy 会话，但生命周期互不替代。

### 2.1 `wsstun sockscap` 参考实现结论

已审阅 `D:\code\person\wsstun` 的 commit `8282eb2`，相关路径在审阅时是 clean。重点参考文件包括 `sockscap-design.md`、`src/sockscap/{cli,engine,backend,windows_process,linux_process,macos_process,packet_device,policy,socks}.rs` 与 `resources/macos-provider/`。

可借鉴：

- 启动数据面前先做 capability/preflight，缺驱动、工具、权限或 provider 时 fail fast。
- 先生成 RoutePlan/dry-run，再安装路由；解析上游 IP 并加入硬绕过，避免递归捕获。
- global 使用 TUN/tun2proxy；平台进程捕获通过内存 PacketDevice 接入同一 userspace IP stack。
- Windows 参考实现使用 WinDivert 的 SOCKET/FLOW/NETWORK 层关联 PID 与五元组，并为选中流动态创建精确捕获过滤器。
- Linux 已实现两条有价值的路径：managed command 使用 user/network namespace；既有进程使用 cgroup v2 + nftables socket cgroup match + fwmark policy routing，并保存原 cgroup 用于恢复。
- macOS 使用版本化 JSON-lines 控制协议驱动 NETransparentProxyProvider，provider 根据 audit token、签名身份和父进程链决定是否接管。
- 统一 CancellationToken、启动前探测、明确 cleanup 顺序、引擎自身 PID 与上游端点绕过，都应进入 Taomni 设计。

不能直接照搬：

- 当前源码中 selected 模式默认仍是 route backend，未命中流量会先进入 TUN 再后置 DIRECT；Taomni 的程序组模式必须优先真正的平台前置过滤，能力不足时明确降级，不能静默假装“只捕获该程序”。
- Windows 已选 WinDivert，但只允许使用未修改、固定版本/变体/签名人/SHA-256 的官方签名驱动；不复用 `wsstun` 的 patched `windivert-sys`。LGPLv3/GPLv2 或商业许可、签名主体、性能、身份 race 与 EDR/VPN 兼容仍是硬 Gate。
- Linux 的 cleanup 已扩展为 Taomni 独立 helper、mutation-before-WAL root receipt、cleaned-generation tombstone、recovery journal 和下次启动修复；fixed-path client/session、双向 TUN pump、lifecycle ownership、产品 generation owner/coordinator recovery 与 package hooks 已有源码合同，但仍需具体 stack/provider、默认产品注入和真实 kill/断电/root/package-manager 证据。
- macOS provider 协议需要补调用方认证、心跳、原子配置版本和恢复状态，不能只依赖 Unix socket 存在。
- `wsstun` 的 MITM inspection、WebSocket 上游和 CLI secret 传递不进入本产品范围。

## 3. 产品范围

### 3.1 必须支持

- 上游：SOCKS5、HTTP CONNECT，以及通过已保存 SSH Session 的跳板转发；Proxy 支持无认证和用户名/密码，SSH 支持密码、私钥和 Agent，并复用 Vault。
- 路由范围：
  - 全局：系统中符合安全条件的新网络流。
  - 程序组：一个配置组包含多个可执行程序或 macOS 应用身份。
  - 运行中进程：选择 PID 后接管它后续创建的新连接。
- 规则：
  - 内置 GFWList 订阅。
  - 自定义 URL 订阅。
  - 本地导入 AutoProxy/GFWList 或纯域名列表。
  - 用户手工 DIRECT、PROXY、BLOCK 规则。
- 多配置组：不同程序组可以选择不同上游、规则和默认动作。
- 独立配置窗口、托盘显示/隐藏、运行状态和异常告警。
- Dashboard：带宽、连接数、直连/代理比例、错误、应用和域名聚合。
- 停止、退出、崩溃恢复时撤销系统级网络改动。

### 3.2 明确不做

- 不解密 HTTPS，不安装本地根证书，不读取 HTTP body、Cookie 或账号内容。
- 不承诺接管进程已经建立的连接；只保证策略生效后的新连接。
- HTTP/1.1 CONNECT 不伪装成支持任意 UDP。
- 首版支持一个 SSH 跳板作为出站，但不支持任意 Proxy 链、嵌套 SSH 多跳、负载均衡或自动故障切换。
- 首版不以 DLL 注入、DYLD 注入、LD_PRELOAD 作为核心方案。
- 不把 GPL 网络内核直接静态链接进 MIT 主程序；任何第三方核心都先做许可证审核。

## 4. 目标架构

主评审原型改为 HTML：[目标架构](./sockscap-prototype/architecture.html)。先前生成的 `sockscap-design-prototype.drawio` 作为历史草图保留，不再作为本方案的主入口。

### 4.1 组件边界

SockscapOrchestrator：

- 维护 Disabled、Preparing、Active、Degraded、Stopping、RecoveryRequired 状态机。
- 校验配置冲突、解析 Vault 凭据、编译规则、启动平台适配器。
- 统一管理配置热更新；影响捕获面的修改采用 prepare/commit，失败保留旧配置。

CaptureAdapter：

- Windows：选型已冻结为 global 使用 Wintun/TUN，程序/PID 使用 WinDivert SOCKET/FLOW/NETWORK + 内存 PacketDevice。第一方 WFP callout 不在当前交付路径：项目现阶段无法获取 EV 证书并完成 Microsoft Hardware Developer Program/HLK 发布链路。若 WinDivert 硬 Gate 失败，对应 app/PID capability 保持禁用，不得默认切换到不可发布的 WFP 实现。
- macOS：NETransparentProxyProvider system extension，根据 sourceAppAuditToken 识别进程并决定处理或直接放行。
- Linux：优先复用 `wsstun` 已验证的 cgroup v2 + nftables socket cgroup match + fwmark policy routing；managed launch 使用 user/network namespace。eBPF connect hook 保留为后续性能/兼容替代，不作为首个实现的前置条件。
- 适配器只负责捕获、身份和原始目标，不负责产品规则。

FlowEngine：

- 接收 FlowContext：平台、PID、进程启动时间、应用身份、协议、源/目标、可用主机名。
- 调用 PolicyEngine 得到 DIRECT、PROXY(upstream_id) 或 BLOCK。
- TCP 通过 SOCKS5、HTTP CONNECT 或 SSH `direct-tcpip` 建立出站连接。
- UDP 仅在策略和上游能力允许时转发。
- 将生命周期和计数写入内存聚合器，不把 payload 发送给 UI。

DomainAttribution：

- 主机名优先级：平台提供的 remote hostname → Fake-IP/DNS 映射 → TLS ClientHello SNI / HTTP Host → IP 规则 → unknown。
- 不进行 TLS 解密。
- 每条连接记录 hostname_source，Dashboard 可以暴露 unknown 比例，避免把规则命中率伪装成 100%。

PolicyEngine：

- 一个系统捕获面可以同时承载多个配置组。
- 先按应用/进程选择配置组，再按域名/IP/协议规则选择动作。
- 使用不可变编译快照；更新规则时原子替换，现有连接不重路由。

StatsAggregator：

- 热路径只更新内存原子计数或有界 channel。
- 每分钟批量写 sockscap.db。
- Webview 最多每秒接收一次摘要，图表默认两秒刷新，避免高频 IPC。

PrivilegedHelper：

- 仅安装/撤销捕获规则、创建设备、传递必要句柄，不持有代理密码。
- 与主程序做版本握手、调用方签名校验和心跳。
- 主进程消失后 fail-open，自动撤销临时规则并恢复直连。

### 4.2 生产数据面决策

选型已冻结为 **Taomni 自有 `FlowRuntime` + 受控 IP-stack adapter**，而不是改造 tun2proxy 成为产品内核。“自有受控”指 Taomni 拥有逐流身份、策略、egress 选择、取消、统计、背压与生命周期；底层 TCP/UDP 重组使用固定并审计的现有 IP stack，不是从零实现 TCP/IP。

- `PacketIngress`（Linux TUN、Windows Wintun/WinDivert PacketDevice）通过可替换 IP-stack adapter 产生 TCP/UDP flow。
- `StreamIngress`（macOS Network Extension）直接产生 flow，不绕经用户态 IP stack。
- 两种入口统一生成 `FlowContext`，调用已有 `PolicyEngine` 和 DIRECT/SOCKS5/HTTP CONNECT/SSH connector。
- 当前已落地并硬化 bounded decoded TCP/UDP 合同：`FlowDescriptor` 对 generation、平台、transport、五元组、PID/start token、app identity、capture intent 与 profile binding fail closed；只有明确 global capture 可用 global fallback，app/PID 归因缺失直接拒绝。`FlowEngine` 绑定 revision 与完整 profile SHA-256，并支持 UDP policy、Direct UDP 与 fail-open/fail-closed fallback。`FlowRuntime` 分离 TCP/UDP quota、检查组合 active ceiling，以同一 runtime byte semaphore 在两方向 receive 前预留最大 UDP datagram，并隔离两种 transport 的 reject-close/finalization pool。root-cause diagnostic 与当前 cleanup proof 分离，只有所有 live owner 的完成都被观察到才报告 clean。queue 中未被 accept 的对象和 close failure 仍须进入显式 drain/quarantine/reconcile，不能由 receiver/record Drop 代替。Linux source bridge已接入该公共composition seam，但没有完整provider，也未从默认 `AppState`/commands/tray启用。
- replaceable `PacketStackSupervisor` 不内置 production stack：descriptor/driver/ready必须匹配精确provider pin、generation、revision、platform、capability和同一opaque `source_id`。唯一公开 `ProductDataPlaneSupervisor` 以detached worker+generation registry启动它和一个`FlowRuntime`；调用者在任意await点取消仍能查询status并按generation重试recovery，Windows/macOS后续必须复用这一入口。
- ready 后正常 stop 必须先由 provider 停止 native packet admission、drop 两个 decoded sender、完成所有 in-flight send 并明确 acknowledge quiesced；随后才 drain/cancel `FlowRuntime`、close profile owner，最后发 final termination。startup、ready前失败、任一阶段 timeout或调用者取消时，stack/runtime/profile/task owner均保留显式retry state。Drop emergency detached reaper只作资源 containment，不是cleanup证明。provider terminal根因可以保留诊断，但不会在owner都已join后伪造residue；反之任何join、close、live task或owner shutdown不确定都不得被根因掩盖为clean。
- `PacketFlowRegistry` 从原始 packet 权威解析 tuple，不接受调用者另传独立 key；校验 IPv4/TCP/UDP checksum、长度、端口、地址/作用域，新 TCP tuple 只接受 pure initial SYN。显式 active TCP/UDP 计数避免每次 admission 线性扫描完整表；这不把 `HashMap` 的全部操作宣称为严格 worst-case O(1)，也不替代容量、性能和长稳证据。
- IP stack 必须通过 trait 隔离，固定精确版本/提交，必要时 vendor；所有 queue/admission 有界，并覆盖 fuzz、IPv4/IPv6、Virtual DNS、UDP 降级、取消、半关闭/RST、性能与 24h Gate。当前选定 smoltcp `=0.13.1`（0BSD，archive SHA-256 `5f73d40463bba65efc9adc6370b56df76d563cc46e2482bba58351b4afb7535e`）作为受控 state-machine foundation；feature 只启 `std`、`medium-ip`、IPv4/IPv6、TCP/UDP sockets，fragmentation保持关闭。独立 RX/TX packet+byte staging budget、TX reservation和sticky invariant fault已落地，但不等于完整provider。
- `ipstack` 1.0.1（tag `v.1.0.1`，commit `a343ea8c696e761acce8dbcd6687c862ecd8aacd`）因多条 unbounded channel 路径继续排除。smoltcp 路线必须先通过 executable P0 spike：IPv4/IPv6 AnyIP exact listener在首 SYN 后进入正确tuple并发出源地址正确的SYN-ACK；单 wildcard UDP socket以`UdpMetadata.endpoint + local_address`对同port的多源/多目的正确demux/回包；MTU+1在Taomni前置验证被拒绝。任一关键语义失败就停止该路线，不以猜测或 silent drop 补偿。
- tun2proxy 仅保留为行为参考和差分测试 oracle，不加入产品运行时，不维护 tun2proxy 长期 fork。
- 不把代理密码放到 sidecar 命令行。

### 4.3 统一出站连接器与 SSH 跳板

FlowEngine 不直接依赖某一种代理协议，而是使用 `EgressConnector` 边界：

```text
connect(flow_target, flow_context) -> bidirectional byte stream + egress metadata
```

首版连接器：

- `DirectConnector`：从物理网络直连原始目标。
- `Socks5Connector`：复用 Proxy Session，支持远端域名与可选 UDP ASSOCIATE。
- `HttpConnectConnector`：复用 Proxy Session，TCP CONNECT；UDP 明确 DIRECT/BLOCK。
- `SshJumpConnector`：引用一个已保存 SSH Session，在共享 SSH 控制连接上为每个 TCP flow 打开 `direct-tcpip(target_host, target_port)` channel。

SSH 跳板实现约束：

1. 共享 SSH `direct-tcpip`/认证/连接池边界已经落地，Tunnel 与 Sockscap 复用底层能力；继续保持不调用 Tauri command、不偷偷启动另一条持久化 Tunnel，并补齐真实跳板的重连/MFA/并发证据。
2. SSH Session 继续由主 `taomni.db` 管理，密码由 Vault 解析；`sockscap.db` 只保存 `ssh_session_id` 引用和非敏感运行参数。
3. 一个 flow 对应一个 SSH channel；控制连接使用 keepalive、有限并发、指数退避和有界连接池。控制连接断开时 profile 进入 Degraded，既有 channel 自然结束，新连接遵循 fail-open/fail-closed 配置。
4. 域名应尽量作为 `host_to_connect` 传给 SSH 服务器解析；UI 显示 `DNS: SSH remote`。若只有 IP，则按 IP 转发。
5. 标准 SSH `direct-tcpip` 只承载 TCP。SSH egress 的 UDP/QUIC 默认 BLOCK，可显式 DIRECT，不能显示为“已代理”。
6. 跳板机地址、Taomni/Sockscap/helper PID 和 SSH keepalive 流量加入硬绕过，避免 SSH 控制连接被自身再次捕获。
7. 首版只允许一个 SSH 跳板。被选择的 SSH Session 若自身再配置 Proxy/Jump 网络链路，保存时拒绝并说明递归风险。
8. 启动前必须验证 SSH host key。`terminal/ssh.rs` 已实现首次显式确认、保存和 key-change 阻断；发布前仍需用真实跳板验证首次信任、匹配、变化、存储错误与无交互后台重连路径。
9. Agent、私钥和已保存密码可以自动重连；需要键盘交互/MFA 的跳板可在手工启动时提示，后台自动启动或断线重连时进入 `UserActionRequired`，不得无限弹窗。

SSH Dashboard 指标包括控制连接状态、握手 RTT、活跃 channel、channel open error、重连次数、上行/下行字节和最近 host-key 状态，不记录 channel payload。

## 5. 路由配置组

每个 RoutingProfile 包含：

| 字段 | 含义 |
|---|---|
| id、name、enabled、priority | 标识、启用状态和冲突优先级 |
| scope | global、applications 或 runtime_processes |
| app_selectors | Windows executable path、macOS signing identity/path、Linux path/cgroup selector |
| include_children | 是否包含配置程序启动的子进程 |
| egress_kind | `proxy_session` 或 `ssh_jump`；DIRECT 由规则动作选择，不伪装成上游 |
| egress_ref_id | 引用现有 SessionType::Proxy 或 SessionType::SSH |
| egress_failure_action | fail-open DIRECT、fail-closed BLOCK；默认沿用全局 fail-open |
| ssh_pool_options | SSH 时可配置最大控制连接/channel、keepalive 与连接超时；不保存 secret |
| rule_source_ids | 有序规则源列表 |
| default_action | DIRECT、PROXY 或 BLOCK |
| dns_mode | system-capture、virtual-dns、strict-proxy |
| unknown_domain_action | DIRECT、PROXY 或 BLOCK |
| udp_policy | proxy-if-supported、direct 或 block |
| local_network_policy | loopback、Taomni/helper 和上游端点强制绕过；LAN/链路本地默认 DIRECT，可配置按规则或 BLOCK |
| stats_privacy | 是否保留域名聚合及保留时长 |

约束：

- 同时最多一个启用的 global 配置组。
- 应用选择器重叠时，priority 数字较小者优先；同优先级禁止保存并给出冲突解释。
- runtime PID 必须同时保存 process_start_time，防止 PID 重用误接管其他进程。
- “记住这个进程”实际保存程序身份，不保存短生命周期 PID。
- 上游 Proxy/SSH 会话被删除、Vault 锁定、SSH host key 变化或需要未满足的 MFA 时，配置组进入 Invalid/UserActionRequired，不悄悄改用其他上游。
- SSH egress 引用的 Session 不允许再配置 Proxy/Jump 链；首版拒绝嵌套而不是递归连接。

## 6. 规则与 GFWList

### 6.1 当前源的事实

2026-07-18 的设计验证中，用户给出的 Bitbucket raw URL 在当前环境返回 404；GFWList 当前官方 README 已不再列出 Bitbucket，列出的镜像包括 GitLab、Repo.or.cz，并另给出 GitHub raw。因此内置 GFWList 不能只绑定用户给出的 URL，也不能把已知失效地址作为默认首选。

从官方 GitLab 镜像取得的当前文件：

- Base64 解码后以 [AutoProxy 0.2.9] 开头。
- Header 标记 Last Modified 为 2025-12-24。
- 约 7614 行，其中约 3623 条域名锚点、123 条例外规则、少量正则。
- Header 声明 LGPL-2.1。

建议内置 source_id 为 gfwlist-official，默认从官方 GitHub raw、GitLab 与 Repo.or.cz 健康源中选择；用户显式导入 Bitbucket URL 时保留其来源记录，404 后立即转入健康镜像。所有来源都展示当前镜像、last-good、哈希和许可证。首版不把列表内容编译进安装包。

### 6.2 下载与更新

- 支持 ETag、If-Modified-Since、超时、最大响应尺寸、有限重定向和 SHA-256。
- 下载 → 校验 → 解码 → 解析 → 编译 → 原子替换；任一步失败继续使用 last-good。
- 默认遵从列表 Expires 但设置最短 6 小时，允许手工立即更新。
- 更新请求可选择直连或指定上游；引擎自身和上游端点始终在硬绕过集合，防止环路。
- UI 显示最后成功时间、当前镜像、原始规则数、有效域名数、例外数、忽略数和错误示例。

### 6.3 AutoProxy 到域名策略的投影

Sockscap 是域名/连接级路由，不是浏览器 URL 过滤器。解析规则如下：

1. ||example.com 转为 domain-suffix。
2. |http://host/path、https URL 和可安全解析的通配表达式提取 host。
3. @@ 规则转为 DIRECT 例外，优先于同一规则源的 PROXY 条目。
4. 纯 IP 和 CIDR 进入 IP matcher。
5. 正则或路径规则只有在能无歧义提取 host 时才转换；其余标为 unsupported，不默默误配。
6. 域名先做小写、去尾点、IDNA 规范化，再编译成反向标签 trie；IP 使用前缀树。

固定决策顺序：

1. 引擎安全硬绕过：loopback、helper、Taomni 自己的上游连接、代理服务器端点。
2. 用户有序 override 规则，first-match wins。
3. 订阅例外规则。
4. 订阅代理规则。
5. 配置组 default_action。

UI 必须提供“测试目标”功能，输入应用、域名/IP、端口和协议，返回匹配的配置组、规则源、规则文本、最终动作和 hostname_source。

### 6.4 DNS、DoH、SNI 与 ECH

传统系统 DNS 可以被拦截或使用 Fake-IP，能得到最准确的域名映射。自行实现 DoH 的程序不会把查询交给系统；此时只能依赖平台 remote hostname 或 TLS SNI。ECH 可能隐藏 SNI，因此 rule-based + unknown=DIRECT 无法保证所有目标都按域名命中。

产品必须明确提供：

- unknown=DIRECT：最接近传统 GFWList，选择性最好，但存在漏代理可能。
- unknown=PROXY：隐私/可达性更稳妥，但更多流量走上游。
- unknown=BLOCK：严格模式。

Dashboard 显示 unknown 连接比例和 DNS leak warning。不得宣称“所有 HTTPS 均可准确识别域名”。

## 7. 协议行为

| 流量 | SOCKS5 上游 | HTTP CONNECT 上游 | SSH 跳板 |
|---|---|---|---|
| TCP / HTTPS | 支持 | 支持 | `direct-tcpip` channel，支持 |
| DNS | Virtual DNS、TCP DNS 或 SOCKS5 转发 | 本地受控解析或 DNS-over-TCP CONNECT | 优先把域名交给 SSH 服务器解析 |
| UDP | 服务器支持 UDP ASSOCIATE 时支持 | 标准 HTTP CONNECT 不支持任意 UDP | 标准 `direct-tcpip` 不支持 |
| QUIC / HTTP3 | 走 SOCKS5 UDP、直连或阻断 | 直连或阻断；推荐阻断以促使应用回退 TCP | 直连或阻断；默认阻断促使回退 TCP |
| ICMP 与非 TCP/UDP | 默认直连或阻断 | 默认直连或阻断 | 默认直连或阻断 |
| IPv6 | 与 IPv4 同等纳入策略 | 与 IPv4 同等纳入策略 | 取决于跳板到目标的 IPv6 可达性，启动测试中展示 |

首个可发布版本以 TCP + DNS 正确性为硬门槛。UDP 不能用“看似启动成功、实际泄漏”的方式降级；每个配置组必须显式显示当前 UDP policy。

## 8. 平台能力矩阵

| 能力 | Windows | macOS | Linux |
|---|---|---|---|
| 首发生产范围 | Sockscap Beta 为 x86_64；ARM64 不发布且 app/PID fail-closed | 最低版本与 Apple Silicon/Intel 范围待 entitlement、签名构建和 lab 证据冻结 | distro/kernel/systemd/cgroup/nft/iproute2/resolver/NetworkManager 范围待 lab 与维护 owner 冻结 |
| 全局新连接 | Wintun/TUN | NETransparentProxyProvider 或受控 TUN | TUN |
| 指定程序 | WinDivert SOCKET/FLOW/NETWORK | audit token + code signing identity | cgroup v2 + nft/fwmark；managed launch netns |
| 指定运行中 PID | x86_64 目标支持，新连接生效；ARM64 不可用 | 目标支持，新连接生效 | 条件支持；cgroup v2/eBPF，新连接生效 |
| 子进程跟随 | 进程树监听/身份规则 | audit token/进程树 | cgroup 继承最可靠 |
| 权限 | Wintun/WinDivert 需管理员；只分发固定官方签名驱动，当前不自建 WFP callout | 首次激活 system extension 需用户/管理员批准和 Apple entitlement | cgroup/nft 路径需 CAP_NET_ADMIN/root；managed netns 取决于 user namespace 策略 |
| 托盘左键切换 | 支持 | 支持 | Tauri 2 官方托盘 click 事件不支持；使用菜单“显示/隐藏”兜底 |
| 主要发布风险 | 驱动签名、EDR/VPN 冲突 | entitlement、Xcode target、签名与公证 | kernel/systemd/Wayland/distro 差异 |

Linux 若能力探测不满足 cgroup v2/nft/iproute2，UI 不假装支持 PID attach：降级为全局或“由 Taomni 启动程序”的 network namespace 模式，并解释原因。

## 9. 生命周期、隐藏和退出

状态机：

Disabled → Preparing → Active → Degraded → Stopping → Disabled  
任何准备或停止失败进入 RecoveryRequired，并提供“一键恢复网络”。

启动事务：

1. 读取不可变配置快照。
2. 检查选择器冲突、系统能力、上游与 Vault。
3. 编译规则并执行上游握手测试；SSH 还要验证 host key、认证/MFA 状态、`direct-tcpip` 探测和跳板地址硬绕过。
4. 写 recovery marker，启动 Packet/Stream data runtime 与 authenticated gateway，确认 read/write loop ready。
5. 启动 helper/service/provider 与心跳，执行 platform `prepare`，但尚不让系统流量命中半成品 generation。
6. 原子 `activate` 捕获规则，并用独立观察点完成 DIRECT、PROXY、BLOCK、DNS、IPv4/IPv6 live self-test。
7. 全部通过后才提交 Active generation 和 capability/status；任一步失败按 journal 撤销系统捕获，再关闭 gateway/runtime/upstream。

停止事务先撤销系统捕获，再关闭本地 gateway/runtime/upstream，最后把 journal 标记 Clean。默认 fail-open：主进程或 privileged component 心跳丢失时撤销捕获恢复直连，避免用户持续断网；这是“系统 owner 消失”的安全恢复规则。配置组 fail-closed 约束的是 owner 存活期间的上游/规则/flow-runtime 故障，不能把主进程死亡后的恢复直连伪装成仍在保护。

窗口和托盘交互：

- Taomni 中的 Sockscap 入口打开或聚焦独立窗口。
- Sockscap 窗口关闭按钮只隐藏；Windows/macOS 点击托盘图标显示/隐藏。
- Linux 托盘菜单始终提供“打开 Sockscap”和“隐藏 Sockscap”。
- 托盘图标颜色：灰色 Disabled、蓝/绿 Active、黄色 Degraded、红色 RecoveryRequired。
- 托盘菜单：状态、启动/停止、当前活动配置组、Dashboard、显示/隐藏、退出 Taomni。
- Sockscap Active 时关闭主窗口，建议弹出三选一：隐藏到托盘并继续、停止后退出、取消。
- “退出 Taomni”必须停止引擎、恢复网络并确认完成；超时则提示恢复失败，不能静默退出。

## 10. 数据与隐私

当前已经使用 app_data_dir/sockscap.db 并启用 WAL。主 taomni.db 继续拥有 Proxy 与 SSH sessions，sockscap.db 只保存其 session id 引用；SSH 密码、私钥口令和 host-key 信任材料不复制到统计库。

主要实体：

- routing_profiles
- app_selectors
- rule_sources
- profile_rule_sources
- custom_rules
- traffic_minute_buckets
- optional_domain_day_buckets
- engine_recovery_journal
- egress_health_minute_buckets

规则原文和编译缓存放 app_data_dir/sockscap/rules；临时下载使用同目录原子替换。

默认统计：

- 保留分钟聚合 7 天、小时聚合 90 天。
- 记录 profile、应用身份、动作、协议、字节、连接、错误和握手耗时；SSH 额外记录非敏感 channel/reconnect 聚合。
- 域名聚合默认关闭；打开时默认保留 7 天。
- 不保存 payload、完整 URL、DNS response body、用户名或代理密码。
- UI 提供立即清空统计和关闭采集。

## 11. 独立窗口原型

HTML 是主评审原型；全部使用本地 CSS/JS，不依赖网络资源：

- [原型总览 / Dashboard](./sockscap-prototype/index.html)
- [目标架构与平台数据路径](./sockscap-prototype/architecture.html)
- [配置组编辑器](./sockscap-prototype/profile-editor.html)
- [规则解释、托盘与恢复流程](./sockscap-prototype/rules-lifecycle.html)

`sockscap-design-prototype.drawio` 保留为第一版历史草图，不删除，但后续评审和实现对齐以 HTML 为准。

Dashboard：

- 顶部 master 状态、当前上游、隐藏到托盘按钮；上游可以显示 SOCKS5、HTTP CONNECT 或 SSH Jump。
- KPI：上传、下载、活动连接、代理比例、错误。
- 30 分钟带宽趋势、DIRECT/PROXY/BLOCK 分布。
- Top Applications、Top Domains、配置组状态和最近告警；SSH 卡片显示 control connection、channel、重连与 host-key 状态。

Profile Editor：

- 左侧配置组列表和优先级。
- Scope：全局、程序组、运行中进程。
- 程序选择支持添加可执行文件、选择运行中进程、包含子进程。
- Egress 可选择 Proxy Session 或 SSH Jump Session；SSH 面板展示认证方式、host-key、remote DNS、TCP-only 与连接测试。
- Routing：全局代理、GFWList、完全自定义。
- DNS、unknown 和 UDP 策略始终可见，并按平台显示 capability warning。

Rules & Lifecycle：

- 规则源状态、镜像、最后更新时间、解析统计。
- 测试目标的完整判定链。
- 主窗口、Sockscap 窗口与托盘的显示/隐藏/退出流程。
- SSH 断线、host key 变化和 MFA 等待进入 Degraded/UserActionRequired，而不是伪装为健康。

## 12. 预期 IPC 与事件边界

以下只是评审期接口草案：

Commands：

- sockscap_capabilities
- sockscap_open_window
- sockscap_list_profiles / sockscap_upsert_profile / sockscap_delete_profile
- sockscap_list_processes
- sockscap_start / sockscap_stop / sockscap_recover
- sockscap_status
- sockscap_list_egress_sessions / sockscap_test_egress
- sockscap_refresh_rule_source / sockscap_import_rule_source
- sockscap_test_target
- sockscap_stats_snapshot / sockscap_clear_stats

Events：

- sockscap://status
- sockscap://traffic-summary
- sockscap://profile-health
- sockscap://egress-health
- sockscap://alert

所有写命令由 Rust 再校验，不信任 Webview 传入的路径、PID、URL 或端口。真实权限操作只通过 helper 的窄接口完成。

## 13. 分阶段实施计划

### 13.0 三系统真实接通：定义、依赖链与剩余工作

#### 13.0.1 “接通”有两级，不得混用

**功能接通（vertical slice connected）**要求某一系统在真实权限环境中完成：

1. Taomni 启动真实 adapter，而不是 Stub/synthetic adapter。
2. 系统新建 TCP 流确实进入 Sockscap；DIRECT、PROXY、BLOCK 都能由生产 `PolicyEngine` 决策。
3. 全局、程序组和运行 PID 三种 scope 按平台承诺工作；应用/PID 身份不会在进入数据面时丢失。
4. SOCKS5、HTTP CONNECT、SSH Jump TCP 至少各完成 IPv4、IPv6/DNS 能力范围内的真实 echo/HTTP 测试。
5. Taomni/helper/provider/上游端点硬旁路，不递归捕获；停止、主进程死亡和 privileged component 死亡后可恢复网络。

**可发布接通（release connected）**在功能接通之上还要求：

- 安装包中所有 privileged/native artifacts 经过目标平台要求的签名、entitlement、provisioning/notarization 或包签名验证；
- 正常用户从安装、授权、首次启动、升级、回滚到卸载都能完成，不依赖开发者模式、test signing、SIP/Secure Boot 关闭或手工 root 命令；
- 平台 native/system smoke、真实捕获矩阵、泄漏、性能、100-cycle、故障恢复和 24h Gate 全部产出 hash-pinned 证据；
- 对应平台运行时 capability 才可变为可启动。一个平台变绿不自动使另外两个平台或“跨平台稳定”变绿。

#### 13.0.2 关键依赖链

```text
S0 已冻结：Taomni FlowRuntime/IP-stack adapter + Windows Wintun/WinDivert
  ├─> S0-CONTRACT-ALIGN：源码、manifest、verifier 与冻结 ADR 一致
  ├─> W0-SUPPORT-MATRIX + W0-SIGNING-ACCOUNT：发布范围与用户态签名输入
  └─> S1 实现 Packet/Stream 双入口数据面与身份合同
       └─> S2 将真实 adapter/runtime 接入 orchestrator + recovery
            ├─> L1 Linux product owner/package source → concrete provider/final builder/default async wiring + installed evidence
            ├─> W1 Windows Wintun + WinDivert + signed service/official drivers
            └─> M1 macOS NE provider + Rust/Swift bridge + entitlement
                 └─> P1 各平台 native/package/性能/泄漏/24h 证据
                      + P0-RELEASE-OPS：更新、安全响应与现场支持
                      └─> 三平台 stable
```

S0、S1、S2 是三个系统共同的阻塞链。平台团队可以并行做 spike、签名账号准备和安装器，但在共享数据面没有闭环前，任何 adapter 都只能证明“捕获到了”，不能证明流量已经按 Routing Profile 通过生产 egress。

#### 13.0.3 共享代码工作包

| ID | 代码工作 | 主要落点 | 验收条件 |
|---|---|---|---|
| S0-DATA-ADR（已冻结） | Taomni 拥有 `FlowRuntime`；PacketIngress 使用 exact-pinned smoltcp 0.13.1 behind a controlled adapter；tun2proxy 仅为参考/oracle；ipstack 1.0.1因unbounded channel排除 | `sockscap-phase0-adr.md`、`Cargo.toml`/`Cargo.lock`、`flow/providers/smoltcp/`；NOTICE/SBOM仍须接入release | exact archive pin与有界device只是foundation；P0 executable semantics、完整actor/bridge/memory ledger、fuzz、IPv4/IPv6、Virtual DNS/reassembly、UDP、取消、统计、性能和24h仍是实现Gate |
| S0-WIN-ADR（已冻结） | global=Wintun/TUN；app/PID=WinDivert SOCKET/FLOW/NETWORK；不实现第一方 WFP | `sockscap-phase0-adr.md`；固定官方 WinDivert package/variant；DLL 固定 provenance/architecture/SHA-256；driver 固定预期 signer/SHA-256 | 完成许可证、身份 race、回注、双捕获、IPv6、EDR/VPN、安装/卸载 Gate；任一硬 Gate 失败则 app/PID capability 保持禁用，不回退 WFP |
| S0-CONTRACT-ALIGN（PARTIAL：source complete） | capability 文案、schema 2 Windows template、Windows/macOS fixed release policy、artifact verifier、typed native/performance receipt tests 已收敛；Windows 只接受 `windivert`/x86_64，并固定 Wintun 0.14.1 与 WinDivert 2.2.2-A exact hashes | `src-tauri/src/sockscap/capabilities.rs`、`src-tauri/platform/sockscap/{windows,macos}/`、`scripts/sockscap/` 与 Rust/Python/shell/PowerShell contracts | Python helper-policy 5/5、package-contract 10/10、Linux release 27/27、aggregate/performance 26/26，以及 macOS shell/Bash 3.2 lint、PowerShell 7.2.24 AST+disabled-template lint 已通过。Windows publisher/certificate 与 macOS Team/certificate/architecture policy 故意 `unconfigured`，non-lint 会硬失败。配置后仍须在匹配主机验证 staged candidates；Windows driver 过 `/kp`，macOS 验证 full `.app` digest并用 protected provenance 绑定最终 DMG/PKG |
| S1-INGRESS（PARTIAL） | bounded、cancellation-safe decoded TCP `FlowIngress`、UDP `UdpFlowIngress` 与 L3 `PacketIngress` 已实现；packet queue 按字节预算、有界 lease、严格 IPv4/IPv6 envelope、generation/platform/identity fail-closed；同一 native packet-device queues 共享 opaque `source_id` 防交叉配对；IPv6 extension chain 按 head/byte budget、顺序、长度、TLV/reserved 字段严格解析，得到最终 protocol 并在 tuple 前标记 fragment；Linux exact TUN source 与双向 pump 已接入 source lifecycle | `flow/ingress.rs`、`capture/packet_device.rs`、`flow/ip_stack.rs`、`capture/linux_tun.rs`、`capture/linux_adapter.rs` | 已有内存证明；畸形/重复/乱序/超预算链 fail closed，但 fragment reassembly 尚无。cancel/ingress fault时queue中尚未accept的TCP/UDP对象仍需close admission + bounded drain/quarantine；provider Phase1须拒绝未经smoltcp differential证明的IPv6 extension；真实 native ingress与压力/泄漏证据仍缺 |
| S1-IDENTITY（PARTIAL） | `FlowDescriptor` 固定 generation、platform、flow id、tuple、PID + platform-native incarnation token、app identity、hostname hints、capture intent 与 trusted profile revision；只有显式 global 可 fallback；plain TUN 的 `capture_id=None` 由 stack 按 tuple 分配稳定 flow identity；Linux picker/helper 使用 `/proc/<pid>/stat` start tick 并在 mutation 前后重验 | `flow/ingress.rs`、`policy/selector.rs`、`flow/ip_stack.rs`、`capture/linux_process.rs`、`processes.rs`；后续 native tuple/profile side channel | selector 11 + IP-stack admission 10 + Linux process 12 source tests 已通过；平台 native metadata、tuple→profile side channel、global + app 并发与 PID race 仍须真实系统证明 |
| S1-STACK-SUPERVISOR（PARTIAL：公共 supervisor/two-phase source complete） | `PacketStackSupervisor` 的 exact pin/capability/identity/first-terminal/one-shot handoff之上，唯一公开 `ProductDataPlaneSupervisor` 用 detached worker + generation registry 接管 startup；caller 在任意 await 点取消也能按 generation 取回并恢复 owner。ready stop显式拆为admission quiesce ack、runtime/owner drain、final provider termination；任一timeout保留同一owner。`FlowRuntime` 将 root-cause diagnostic 与 cleanup-pending 分离 | `flow/packet_stack.rs`、`flow/composition.rs`、`flow/runtime.rs`、`capture/packet_device.rs` | close failure quarantine/reconcile与Drop无detached cleanup尚未闭环；仍须完整 smoltcp actor/bridge、最终 profile/config builder并接入各平台 withdrawal；Windows/macOS 必须直接复用该 supervisor，禁止复制平台私有 registry；native/performance/24h/7d 前不得 PASS |
| S1-LINUX-CAPTURE（PARTIAL：产品 owner source complete） | helper WAL/client/TUN/pump/lifecycle/fault monitor之上，`LinuxCaptureAdapter` 持有单 generation owner，Linux data-plane bridge委托公共 supervisor；runtime 以 Store-global detached transaction 持有取消后的操作 owner，recovery 使用 expected-generation CAS/revalidation；coordinator 在 privileged call 前 durable-bind adapter/generation，返回后校验 platform/spec/generation/revision/helper PID/完整 artifact lineage，untrusted receipt 仅走 generation rollback；disk WAL `synchronous=FULL`、canonical directory/lock/DB checks与 retained OS owner lock构成 intended source-level journal 边界，desktop single-instance 仅负责 activation UX | `capture/linux_{product,data_plane,client,helper,process,tun,adapter}.rs`、`capture/{runtime,coordinator}.rs`、`storage.rs`、`orchestrator.rs`、`lib.rs` | 默认 `AppState`/同步 IPC/tray仍未构造真实 adapter；当前只有 same-process double-open/drop-release 与 Unix path tests，handle-relative SQLite/VFS、Windows SID/DACL、三平台跨进程/crash/multi-session、numeric `cgroup.procs` 与 helper generation ownership仍须 installed PID-race/root lab。另缺具体 provider/default injection、tuple side channel、配置签名/依赖 policy和 package-manager evidence；能力保持 false |
| S1-TCP（PARTIAL） | `FlowRuntime` 已实现 supervisor-owned handle、有界 admission/close pool、duplicate/overload/stale rejection、snapshot/owner binding、EOF half-close、waiter-abort cleanup、panic containment、绝对 shutdown deadline与partial-byte accounting；`PacketFlowRegistry`从packet权威导出tuple、验证checksum/headers并以pure SYN创建TCP tuple | `flow/runtime.rs`、`flow/engine.rs`、`flow/ip_stack.rs`、现有 connectors | smoltcp TCP exact-listener P0 spike、actor/bridge、handshake/FIN/RST deadlines及native证据尚缺；close失败必须保留tuple/permit进入reconcile，不能只记metric；性能与24h/7d未完成 |
| S1-DNS-UDP（PARTIAL） | hostname source、unknown/degraded、TCP-only egress UDP policy已落；`UdpDatagram`边界、独立association ingress/quota、Direct connected UDP、双向datagram relay/idle timeout/stats、runtime in-flight byte semaphore已实现；smoltcp wildcard UDP metadata demux进入P0 spike | `flow/{ingress,connectors,engine,runtime,ip_stack}.rs`、`flow/providers/smoltcp/`、attribution/policy | in-flight slots必须对两方向/association给出活性证明；完整shared-port actor/binding memory、SOCKS5 UDP ASSOCIATE、Virtual DNS、fragment/MTU、queue/close quarantine与真实DNS/IPv4/IPv6/UDP leak matrix仍未完成 |
| S1-GATEWAY | 为 macOS provider 提供 authenticated loopback data gateway；控制面与数据面分离，协议带 version/generation/flow id/长度上限 | 建议新增 `capture/gateway_protocol.rs` 与本地 listener | 只监听 loopback/受控 IPC；peer identity、消息大小、flow 并发、超时、重复 flow id、旧 generation、主进程消失均 fail closed/fail open 符合策略；无 secret 进入 argv/log |
| S1-BYPASS（PARTIAL） | 已有静态 self/upstream/loopback 旁路规则和 fail-closed transaction 合同；仍须把 Taomni、helper/provider、TUN runtime、Proxy/SSH endpoints、DNS resolver 构造成 generation-bound 动态硬旁路快照 | `flow/bypass.rs` + adapter update；各平台 native filter/route builder | 每次上游重解析/重连原子更新；无捕获递归；旁路变更失败不发布新 Active generation。静态 source test 不能替代真实递归/endpoint 变化验证 |
| S2-RUNTIME（PARTIAL：注入 seam 已落） | `CaptureRuntimeOwner` 与 orchestrator 显式 adapter/recovery seam 已有 source contract；下一步由平台 factory 构造真实 adapter、packet-stack、`FlowRuntime`、heartbeat/fault monitor并接到 async `SockscapEngine::start/stop/recover` | `capture/runtime.rs`、`orchestrator.rs`、`state.rs`、`commands.rs`、`tray.rs` | 当前 `AppState` 仍调用 `with_store`，commands/tray仍走同步 fail-closed recovery。产品接通后顺序固定为 upstream/probe ready → helper/provider prepare → native+stack+runtime ready → activate → live self-test → Active；任一 component fault自动 recovery且完整回滚 |
| S2-CAP（PARTIAL） | capability schema、稳定 reason code、主机前置条件与默认 fail-closed UI 已落；仍须拆分并实现“artifact 已安装”“签名/entitlement 已验证”“data plane ready”“scope 可用”的只读产品探测 | `capabilities.rs`/TS contract/UI + 平台 installed/self-test probes | 现有 probe 只证明前置条件，不能证明产品已安装。只有 installed probe + real data-plane self-test 通过才设置该主机 `can_start_*`；Debug、模板、synthetic receipt 永远不能解锁 |
| S2-RECOVERY（PARTIAL） | durable coordinator journal、Linux helper WAL、generation-bound artifact、owner retention、helper-first withdrawal 与 cleaned tombstone source contract 已落；仍须把真实 provider/gateway/data-plane generation 接进默认产品并完成跨崩溃证明 | coordinator/store/platform adapter + product runtime | main/helper/provider 在 prepare、activate、Active、stop 的每个注入点死亡均能在本次或下次启动恢复；tombstone 必须经真实 root crash/断电测试。既无 pending receipt 又无匹配 cleaned tombstone时拒绝猜测性清理并显示人工恢复步骤 |

共享数据面必须先用**内存 PacketDevice/StreamIngress**完成确定性测试，再接触真实系统路由。这样平台测试失败时可以区分“捕获/身份问题”和“TCP/IP/egress 问题”。

当前已完成 bounded TCP/UDP ingress、权威 L3/transport admission、Direct UDP/runtime resource slice、packet-stack两阶段停机合同、smoltcp exact pin与bounded staging device、共享 product composition、Linux helper/client/TUN/pump/lifecycle、产品 generation owner/coordinator recovery 与包合同；尚未接入完整 smoltcp socket actor/bridge 或默认产品 capture runtime。不要把P0 compatibility spike、focused tests或完整 Sockscap 软件测试 PASS，解释成真实 PacketIngress/IP-stack provider、平台 adapter、orchestrator、native smoke、性能或24h已通过。

#### 13.0.4 Linux 接通工作包

当前 Linux 已完成 privileged transaction、WAL/PID checks、fixed helper client/TUN/pump、generation owner/coordinator recovery和 DEB/RPM/polkit source contracts；以下真实数据面、产品启用和实验室证据仍为剩余工作，capability 继续保持 fail-closed：

| ID | 代码/打包任务 | 验证出口 |
|---|---|---|
| L1-CLIENT（source complete） | `LinuxHelperClient`/actor session、`LinuxCaptureLifecycle` 与 real transport 已封装成 generation-scoped `LinuxCaptureAdapter`，并有 coordinator/orchestrator recovery 注入边界；Store-global runtime mutex与 retained owner lock分别承担进程内操作串行和预期的跨进程 journal ownership，desktop single-instance 仅负责 activation UX；固定 pkexec/helper/policy/runtime路径和认证保持不变 | source tests通过；owner lock 已有 same-process double-open/drop-release 与 Unix path tests，默认产品仍不注入。helper持有共享 lifecycle lock、package transaction持有独占锁并用sentinel阻断新session；仍须 handle-relative DB binding、三平台跨进程/crash/multi-session native，以及真实并发、取消、kill、断电与package receipt证明 |
| L1-POLKIT（source complete） | 固定 action 仅指向 `/usr/libexec/taomni/sockscap-helper`；`allow_any/inactive=no`、active=`auth_admin`，无 retained authorization；DEB/RPM overlay按固定 root owner/mode安装 | 有/无桌面 agent、取消/错误密码/headless、升级/卸载与残留必须在真实包管理器/root lab通过 |
| L1-TUN（source composition complete） | `LinuxGlobalTunReader`、双 pump及公共 `ProductDataPlaneSupervisor` 已有 exact queue/identity/health/stop合同；Linux bridge不再复制 registry，只接受显式 `PacketStackProvider` 与 snapshot builder | 仍需具体 TCP/UDP/reassembly/Virtual-DNS provider、真实 IPv4/IPv6/MTU/checksum/RST/并发/runtime death与 product fault证据；helper不能被误认作runtime |
| L1-CLEANUP（source hardened） | mutation-before-WAL、detached runtime transaction、expected-generation CAS/revalidation、privileged call 前的 durable adapter binding、helper PID/handle lineage、untrusted receipt 仅 generation rollback、helper-first withdrawal和cleaned tombstone已接coordinator source；runtime-dir要求 root:root 0755，helper session持有共享生命周期锁，包事务持有独占锁并设置崩溃持久sentinel，失败事务不会提前放行helper。生产 tombstone GC只能由 durable journal/rollback low-water mark驱动 | prepare/activate/Active/stop每个 crash/cancel点，helper response丢失、receipt+tombstone、foreign/conflicting tombstone、dir replacement、并发helper/upgrade、失败升级、主进程/helper/data-plane kill与断电重启均须root VM证据；source fake/lock tests不能替代 |
| L1-SCOPE（PARTIAL） | global/app-group/PID/include-children 的选择模型、PID/platform-native incarnation token、原 cgroup restore、Linux kernel start tick 与 mutation 邻近重验已落；仍须完成可信 tuple→profile 通道和真实 scope enforcement | 选中/未选中进程同时发流；未选流不进入数据面；global + 两个 app profile 分别使用不同 egress；停止后只恢复仍属于该 generation 的精确 process incarnation；专门 PID reuse race lab 通过；side channel 缺失时 app/PID capability 保持 false |
| L1-NETNS | 为不允许移动既有进程或缺 cgroup socket match 的环境实现“由 Taomni 启动”的 managed user/network namespace fallback；不把它伪装成 running-PID attach | managed child/children、退出、kill、namespace 清理；能力报告解释降级原因 |
| L1-PACKAGE（source contract hardened） | release-only overlay只生成DEB/RPM；canonical入口和真实stage同时校验architecture、双signer、DEB/RPM-only及受限test override；输入私有快照、hermetic外部工具、RPM transaction/trigger/sysusers/policies/filecaps/fileflags及DEB conffile/trigger/关系字段均fail closed，producer/verifier固定owner/mode/umask | architecture/OpenPGP与完整distro dependency contract故意 `unconfigured`：不能把3个capture工具依赖误称完整GUI依赖。仍须从最终ELF+bundle冻结DEB/RPM依赖profile，配置signer，生成签名包，在干净VM跑安装/dirty blocker/升级/回滚/卸载/重装/缺依赖负向与零残留；capability保持false |

**L1-SCOPE-ID ADR（实现前必须冻结）**：优先评估“每个有界 capture/profile bucket 使用独立 TUN/source，`source_id + generation + profileRevision` 直接绑定不可变 profile snapshot”，因为它不依赖首包到达前的异步 conntrack 查询。备选方案是“唯一 fwmark/conntrack mark + 受认证 netlink/helper side channel 映射 normalized 5-tuple/方向到 profile”；若选择备选，必须定义首包竞态、TCP simultaneous-open、UDP 重绑定、IPv4 fragment/IPv6 extension、NAT 前后 tuple、PID 退出/复用、更新并发、TTL/LRU 容量、eviction、helper/main restart、generation rollover 和 stale-entry 拒绝语义。两种方案都必须有固定上限、无身份时 fail closed（app/PID 不得降级成 global）、原子 profile revision 切换，并以 global + 两个 app profiles 使用不同 egress、首包零误路由、压力下零跨 profile 污染、重启后零 stale 命中作为验收。完成该 ADR/原型/真实内核证据前，不实现默认 app/PID 产品注入。

Linux privileged 测试必须在一次性 VM 或 network namespace fixture 中运行，禁止在共享开发机默认路由上直接做破坏性 CI。最低真实矩阵需覆盖：支持矩阵中的每个 distro、cgroup v2 原生/不满足、systemd-resolved 与 NetworkManager 组合、IPv6 开/关、Wi-Fi/有线切换、至少一个常见 VPN。

#### 13.0.5 Windows 接通工作包

S0-WIN-ADR 已收敛为 Wintun global + WinDivert app/PID。当前工作包不包含第一方 WFP callout：

| ID | 代码/打包任务 | 验证出口 |
|---|---|---|
| W0-SUPPORT-MATRIX（Windows架构已冻结；Windows OS版本、macOS/Linux矩阵待冻结） | 第一版生产 Windows Sockscap Beta只支持`x86_64`，不发布ARM64；probe稳定fail-closed。仍须从真实lab冻结具体Windows版本；同时冻结macOS最低版本/Apple Silicon/Intel与Linux distro/kernel/systemd/cgroup/nft/iproute2/resolver/NetworkManager范围；macOS overlay的`11.0`只是provisional build floor | Windows x86_64 manifest/installer/artifact/lab一致且ARM64 fail-closed；列出的Windows OS版本全部完成Secure Boot/EDR/VPN矩阵。macOS/Linux由带证据的矩阵修订关闭，未列入范围的系统不生成release PASS |
| W0-SIGNING-ACCOUNT（外部输入，OPEN） | 为 Taomni app/helper/service/installer 选择受信任的用户态 Authenticode 证书或 signing service，确定组织验证、密钥托管/HSM、CI 身份、timestamp、续期、轮换、吊销和应急 owner，并把 exact publisher subject + leaf-certificate SHA-256 通过评审提交到 fixed policy。该任务不要求 EV，也不授权签名自有 kernel driver；Wintun/WinDivert 仍来自固定官方 package | 干净 Secure Boot Windows x86_64 验证 publisher chain、timestamp、artifact hash 和安装生命周期；CI 不导出私钥；完成轮换/吊销演练。当前 policy 为 `unconfigured`，因此 non-lint gate 必然 fail closed，Windows Beta 保持 BLOCKED |
| W1-GLOBAL | 封装官方 Wintun distribution：adapter create/open、session ring read/write、MTU、route/DNS、close/delete；将 L3 packet 接到 S1 PacketIngress | Windows x86_64、IPv4/IPv6、ring pressure、adapter 已存在、重启、名称冲突、Wintun DLL/driver 缺失或 hash/signature 错误 |
| W1-SELECTED | 实现 WinDivert SOCKET/FLOW tuple→PID/start token cache、NETWORK capture/reinject、动态 filter 和 race 处理；固定官方签名 driver 版本/变体/签名人/SHA-256，不修改 driver | app/PID/children/new-connections；PID 重用；TCP simultaneous open/close；IPv6；高并发；未选 flow 不被延迟；global + selected 不双捕获、不丢 identity；驱动与 release manifest 严格一致 |
| W1-HELPER | 将 privileged boundary 做成签名 Windows service/helper，以 ACL 收紧的 named pipe 与主进程握手；验证调用方 Authenticode publisher、PID/start token、协议 version/generation | 普通用户/UAC 拒绝、错误 signer、旧 client、service crash/restart、主进程 crash；凭据和任意命令永不进入 service protocol |
| W1-BYPASS | 在捕获层排除 Taomni/helper/service、Wintun/WinDivert 自身流量和所有动态 upstream endpoints；验证 reinjection 不再次命中 | 连接计数无递归增长；Defender/EDR/VPN 同时启用时无 packet loop；本机/LAN policy 与设计一致 |
| W1-INSTALL | 生成 MSI/NSIS 所需 service/driver/DLL 安装与回滚；应用/helper/service/installer 使用 timestamped Authenticode；Wintun/WinDivert 仅来自经许可审核、hash-pinned 的官方 package。WinDivert DLL 不因当前官方包无 PE Authenticode certificate table 而伪造 signer 要求，必须校验 package provenance/variant/architecture/hash；kernel driver 必须校验预期 signer/hash | Secure Boot 开启的干净 Windows；Taomni 用户态 artifact 通过 `signtool /pa`、publisher、timestamp、hash；WinDivert driver 通过 `/kp` 且 signer/hash 与 manifest 一致；DLL provenance/architecture/hash 与 manifest 一致；不接受 test signing、自编译/修改驱动或禁用 Secure Boot 的证据 |
| W1-UPDATE | 设计 driver/provider 版本共存与原子升级：先停 capture/清理，再升级 service/driver，失败回滚；卸载先恢复网络再删除 artifact | 安装→升级→降级拒绝/回滚→卸载、重启中断、占用文件、pending reboot；无 service/filter/adapter/route/DNS 残留 |

Windows 功能实验室至少覆盖：最终冻结的 Windows 版本、`x86_64`、Secure Boot、Defender、企业 EDR 样本、常见 VPN、Wi-Fi/有线、睡眠/唤醒。WinDivert 必须完成 LGPL/GPL 分发合规和随包 LICENSE/NOTICE，或经审批的商业许可；安装包不得包含自编译、patched 或 test-signed WinDivert driver。由于当前不具备 EV/Hardware Developer Program 条件，第一方 WFP 不是本阶段或失败后的 fallback；Windows ARM64 也不能借由 WFP、test signing 或关闭系统安全策略进入本次发布范围。

冻结的 source pin（均为 SHA-256）为：Wintun 0.14.1 ZIP
`07c256185d6ee3652e09fa55c0b673e2624b565e02c4b9091c79ca7d2f24ef51`、x64 DLL
`e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce`、license
`183adac21e7d96c508c8fd34d394b7b6708bc81564ad1bad61ab66143a008cd2`；WinDivert
2.2.2-A ZIP `63cb41763bb4b20f600b6de04e991a9c2be73279e317d4d82f237b150c5f3f15`、
x64 DLL `c1e060ee19444a259b2162f8af0f3fe8c4428a1c6f694dce20de194ac8d7d9a2`、
x64 driver `8da085332782708d8767bcace5327a6ec7283c17cfb85e40b03cd2323a90ddc2`、
license `14a0cb5214d536e4fdae6aa3f5696f981eeda106cd026e9794bba489ee79d628`。
这些 source pin 不能替代最终 Windows package 的同机 non-lint verifier、driver
signer 与 `/kp` 证据。

#### 13.0.6 macOS 接通工作包

macOS 分为 Apple 账号外部输入、Xcode native target 和 Taomni 集成三条线，缺一不可：

| ID | 代码/外部任务 | 验证出口 |
|---|---|---|
| M0-ACCOUNT | 由 Account Holder 为明确 App ID/Provider ID 启用或申请 Network Extension/System Extension 能力；准备 Developer ID Application 证书、匹配 team ID 和 provisioning profiles；把 Team ID、leaf-certificate SHA-256 与冻结 architecture set 提交到 fixed policy | `security cms -D` 显示 app/provider profile 含所需 team/bundle/entitlement 且 DeveloperCertificates 含实际 codesign leaf；当前 `unconfigured` policy 和未获批准 capability 都会阻塞 release，不能由 manifest/手写 plist 覆盖 |
| M1-XCODE | 在真实 Xcode 工程新增容器 app 配套的 System Extension + `NETransparentProxyProvider` target，bundle ID/Info.plist/principal class 与 Tauri overlay 一致；provider 启动 system-extension mode | Intel/Apple Silicon 构建；extension 嵌入约定 bundle 路径；Debug 与 Developer ID release provisioning 分离 |
| M1-ENTITLEMENT | 容器 app 签入 `com.apple.developer.system-extension.install` 和 `app-proxy-provider-systemextension`；provider 签入匹配 Network Extension entitlement 与 team/application-group identity | 对最终 `.app` 和 provider 的 `codesign -d --entitlements :-` 验证，而不是只 lint 源 plist；Gatekeeper 与 provisioning verifier 通过 |
| M1-ACTIVATE | Rust/Tauri 调 Swift bridge 发出 `OSSystemExtensionRequest` activation/deactivation，处理用户批准、reboot/replacement、拒绝和版本升级；再通过 `NETransparentProxyManager` 安装/启停配置 | 首次批准、取消、拒绝、已激活、版本相同/更新、停用、卸载；每个状态可见且不把未批准显示为 Active |
| M1-PROVIDER | 实现 `handleNewFlow`/UDP flow：从 `sourceAppAuditToken`/signing identifier 得到 PID/app identity，先做 hard bypass/profile selection；未选 flow 返回 direct，选中 flow 通过 S1 authenticated gateway 转发 | 选中与未选应用并行；PID/start identity、children/new connection；provider/Taomni/upstream 自绕过；TCP half-close/RST；UDP policy；主 app 消失后 fail-open/停止配置 |
| M1-BRIDGE | 控制协议带 version、generation、原子配置、heartbeat、receipt；数据协议复用 S1 gateway，限制 flow/bytes/queue；验证 peer code-signing identity，不仅依赖固定 socket 路径 | 伪造 client、旧 generation、超大帧、连接洪泛、provider/app restart、sleep/wake、NIC/VPN change；无未认证配置或流量注入 |
| M1-SIGN | 通过 release-only Tauri overlay 嵌入 extension，按内到外顺序签名，生成 Developer ID DMG/PKG，notary submission + staple；不改变普通 preview entitlement；artifact/aggregate/native 以 policy-pinned canonical tree digest 绑定同一完整 `.app`，protected build attestation 再绑定最终 DMG/PKG/updater | `codesign --verify --deep --strict`、app/provider Info.plist IDs、profile certificate、`spctl --assess`、`stapler validate`、架构/source/signed entitlement/full-app digest 全通过；attestation 证明 shipped payload 对应该候选 |
| M1-UNINSTALL | 容器应用先请求 deactivation/移除 Network Extension 配置，再删除应用；升级前后保持 provider/config generation 一致 | 正常卸载、强制中断后恢复、旧 provider 替换、应用拖入废纸篓与正式 uninstaller 路径；无激活 extension/NE configuration 残留 |

macOS 功能实验室必须同时包含 Apple Silicon 与 Intel（若 Intel 仍在支持范围），并覆盖首次系统扩展批准、权限拒绝、Developer ID 下载启动、Gatekeeper、睡眠/唤醒、Wi-Fi/有线、至少一个 VPN、升级和卸载。Linux 上只能 lint 合同，不能生成或替代上述证据。

#### 13.0.7 统一验证矩阵

每个平台在宣布“功能接通”前，至少运行下列矩阵；`N/A` 必须由冻结 ADR 解释，不能静默跳过：

| 维度 | 必测值 |
|---|---|
| Scope | global、application group、running PID、include children；再测 global + 至少两个不同 app profiles 同时 Active |
| Action | DIRECT、PROXY、BLOCK、egress fail-open、egress fail-closed、unknown DIRECT/PROXY/BLOCK |
| Egress | SOCKS5 无认证/用户名密码、HTTP CONNECT 无认证/认证、SSH 密码/私钥/Agent；host-key 首信/变化、MFA UserActionRequired、断线重连 |
| Network | IPv4、IPv6、系统 DNS、remote DNS/Fake-IP（按数据面 ADR）、DoH/ECH unknown、LAN/loopback、TCP half-close/RST、UDP/QUIC policy |
| Identity | 选中/未选中并行、PID reuse、进程退出、子进程、相同 executable 多实例、Taomni/helper/provider 自身、动态 upstream IP 变化 |
| Lifecycle | prepare 每步失败、Active kill main、kill helper/provider、restart、sleep/wake、NIC change、VPN on/off、upstream loss、Vault lock、规则更新失败 |
| Package | clean install、权限拒绝、再次授权、upgrade、rollback、reboot during update、uninstall、reinstall；系统网络状态前后 diff 为零 |

验证分五层执行：

1. **纯代码 Gate**：Rust unit/property/contract、Vitest、Python verifier tests；不需要权限。
2. **内存数据面 Gate**：synthetic Packet/Stream ingress 驱动真实 matcher/connectors，覆盖协议状态机、取消、限流和隐私。
3. **平台功能 Gate**：一次性 VM/物理机真实 adapter，使用可控 echo、DNS、SOCKS5、HTTP CONNECT、SSH servers；用独立观察点确认流量确实经过预期 egress。
4. **native/package Gate**：真实安装包、系统权限 UI、托盘/窗口、签名/entitlement/driver/service/helper、升级/卸载。
5. **发布 Gate**：真实 100-cycle、TCP 建连开销、1 Gbps 基线吞吐、DNS/IPv4/IPv6/UDP leak audit、kill/restart/sleep/NIC/VPN、24h core + 24h actual capture soak；跨平台 stable 候选还需完成分阶段 7-day actual-capture 长稳。

每个测试必须同时验证**正向路径和未命中路径**。只证明“选中应用能联网”不够，还要证明未选应用没有进入 Sockscap、BLOCK 没有泄漏、DIRECT 没有绕回 proxy、helper/provider/upstream 没有自捕获。

#### 13.0.8 证据与 CI/实验室分工

- 普通 CI 运行 Rust/Vitest/contract、verifier self-tests、模板 lint 和 optimized core quick；不得申请 root、安装驱动或伪造平台签名。
- 平台 self-hosted lab 运行 native/system/package tests。每次 run 固定完整 commit、OS/architecture、host ID、artifact hashes、开始/结束时间和原始日志。
- Windows/macOS `artifactGate` 必须是同机真实 verifier 的最终 PASS JSON，lint JSON 会被拒绝；Linux packaging pipeline 必须输出 architecture/provider、app/helper/policy 路径、包签名和 owner/mode/policy receipt。aggregate verifier 会在匹配主机重读绝对路径并重算 hash；macOS 会重算完整 `.app` canonical tree digest，最终 DMG/PKG/updater 则由 protected build attestation 绑定，不能只附一个无 payload 对照的 package hash。
- `nativeSmoke` 必须是 schema 1、`gateKind=sockscap_native_capture_smoke`、`evidenceClass=real_host_capture`、`releaseEligible=true`、native PASS 的 typed receipt，包含唯一通过的 `TC-SOCKSCAP-native-capture-smoke`，并精确绑定 commit/platform/architecture/provider/buildId、artifactGate digest 与 app/privileged/provider hashes；macOS 额外绑定 full-bundle digest。capture matrix 必须证明 global IPv4/IPv6 TCP、app group、runtime PID、DNS、UDP policy、hard bypass 与 cleanup residue zero。现有 `qa-ui-auto.summary.v1`/`TC-SOCKSCAP-native-window-smoke` 只证明 UI/IPC，release verifier 会拒绝它；typed producer/case 尚待实现。
- `coreQuick` 和 `coreSoak` 必须由同一 commit、同一 platform/arch 的 optimized `sockscap-gate` 生成；24h minimum 固定 86,400 秒。
- 7-day 长稳是三平台 stable 的 staged actual-capture Gate，不由当前 synthetic `sockscap-gate`/24h verifier 自动证明；需新增 receipt/schema/verifier，并固定同一候选 commit、签名 artifact、host/support matrix、每日资源/故障/网络状态采样和零未解释 residue。
- actual capture 的 scope/egress/performance/recovery/leak/install 原始证据全部放进同一 evidence directory，逐文件 SHA-256 pin；最后由 `performance-release-manifest` 在相同 OS 上验证。
- receipt schema、candidate binding、同机 OS 检查和 artifact rehash 只证明 JSON/文件自洽，不证明 producer 身份。生产 lab/CI 必须受保护，并输出签名 provenance/attestation（in-toto/SLSA 或等价机制），把同一 candidate ID、host identity、原始 evidence 与最终 app/helper/provider/installer/DMG/PKG hashes 绑定；自报 JSON 不得解锁 capability。
- 当前 `.github/workflows/sockscap-platform-gates.yml` 明确命名并限定为 **Source/Quick Non-Release**：它提供 Linux source/optimized quick，以及已配置的 Windows/macOS source compile/process jobs。后两项只有在对应 CI runner 返回结果后才可声称编译通过；本快照没有该 runner 证据。即使这些 job 全绿，也不等于 protected native/non-lint artifact、真实 24h、7-day staged 或签名发布 PASS。通用 `.github/workflows/release.yml` 尚未依赖 Sockscap Gate，且仍使用可移动 Action/toolchain 标签；因此它只能发布 capture-disabled 的普通 Taomni bundle，不能产出或宣称 Sockscap production PASS。启用任一平台 capability 前，必须建立独立、最小权限、commit-SHA pinned 的受保护 Sockscap build/sign/publish workflow，并让发布 promotion 强制依赖同一 candidate 的 platform manifest/attestation 全绿。

#### 13.0.9 生产发布运维、安全与支持工作包

下列工作不阻塞内存数据面开发，但会阻塞任何生产发布标签。现有 updater 能检查/下载更新，不等于生产发布、撤回与现场支持链路已经闭环。

| ID | 生产任务 | 验证出口 |
|---|---|---|
| P0-RELEASE-OPS（OPEN） | Source/Quick Non-Release workflow的第三方Actions已pin完整commit SHA，Rust/MSRV固定1.95.0；Windows/macOS source compile/process jobs已配置但尚无对应runner结果，不能写成编译PASS。通用`release.yml`尚未依赖Sockscap Gate，仍含可移动Action/toolchain标签，也没有native/non-lint/24h/7d protected jobs；启用capability前须将capture-disabled普通发布与最小权限Sockscap build/sign/publish promotion明确隔离。另建立action更新/源码审计、冻结runner image，指定updater minisign私钥owner/HSM、离线恢复、轮换/吊销；定义组件ABI/protocol/journal兼容矩阵，实现分阶段发布、停止放量和签名rollback | 普通release不能产生Sockscap PASS；受保护promotion强制依赖同candidate三平台manifest/签名attestation。action/runner更新有review+hash记录；隔离release演练完成正常升级、Active clean stop后升级、暂停放量、坏版本回滚、私钥轮换/吊销恢复；旧组件拒绝不兼容组合 |
| P0-SECURITY | 对 privileged IPC、packet/stream parser、identity side channel、bypass、配置更新和软件更新链完成 threat model 与发布前安全评审；每次正式构建生成 SBOM、license inventory、依赖/driver CVE/EOL 扫描，定义分级响应时限与停止发布条件 | threat model/评审结论有 owner 和关闭记录；CI 对高危未豁免项 fail closed；ipstack/Wintun/WinDivert/Tauri 变更触发兼容、安全和许可证复审；豁免含到期时间而非永久忽略 |
| P0-SUPPORT | 提供用户显式导出的脱敏支持包：版本/commit、platform/arch、capability reason、artifact version/hash、适用时的 signer、有限网络状态 diff、recovery receipt 和有界日志；不含 payload、完整 URL、凭据、私钥路径、MFA 或默认域名明文。建立 crash symbol 保留/访问策略、日志/receipt 磁盘上限和现场恢复手册 | 自动 redaction tests 和恶意字段 fixture 通过；支持包需用户确认且展示内容范围；日志轮转/空间耗尽/崩溃场景不阻塞转发或泄漏 secret；每个正式 release 的符号与 manifest 可按 commit 检索并有保留期限 |

#### 13.0.10 里程碑与绿灯顺序

| Milestone | 输出 | 绿灯条件 |
|---|---|---|
| M0 — 决策冻结 | data-plane ADR + Windows provider ADR + `S0-CONTRACT-ALIGN` + `W0-SUPPORT-MATRIX` + `W0-SIGNING-ACCOUNT` | 决策包含版本、许可证、维护者、最低平台/架构、降级策略、包结构、签名责任人和无 WFP fallback；源码/manifest/verifier 与 ADR 一致 |
| M1 — 共享数据面 | Packet/Stream ingress、identity contract、production FlowRuntime、orchestrator runtime | 内存协议矩阵全绿；synthetic adapter 仍标记非 release evidence |
| M2 — Linux functional | 已安装 helper client/polkit/TUN/runtime + global/app/PID vertical slice | 真实 root/VM smoke、三 egress、IPv4/IPv6/DNS、kill cleanup 通过；Linux `can_start_*` 才可按 probe 解锁 |
| M3 — Windows Beta | 在冻结的 Windows `x86_64` 范围落地 Wintun global + WinDivert app/PID、signed service、官方驱动 artifact 与 installer | Windows x86_64 全矩阵、签名、许可、身份 race、EDR/VPN、100-cycle、24h 和安装卸载清理通过；ARM64 不生成误导性 capability 或 release PASS |
| M4 — macOS functional/release | approved capability、signed/notarized app + provider、activation/bridge | 冻结的 Apple Silicon/Intel 范围内全矩阵、批准/拒绝、升级/卸载、24h 通过 |
| M5 — Cross-platform stable | 三份同 commit 或正式 release commit 的 platform PASS manifests + 7-day staged actual-capture receipt + `P0-RELEASE-OPS/P0-SECURITY/P0-SUPPORT` 关闭证据 | 三个平台均 release connected；24h 与 7-day 长稳、更新/回滚/安全响应/支持链通过；全局 QA Gate 无新增/未豁免回归；发布台账全部关闭 |

正式发布顺序仍遵从已确认决策：Windows 可先 Beta，三平台全部通过后才能称“跨平台稳定”。工程上 Linux 是当前最快的数据面反馈通道；这不改变 Windows Beta 的发布口径，也不允许跳过已冻结 Windows 选型的真实 artifact/兼容 Gate。

### Phase 0：三平台能力与许可证 Gate

当前状态：**BLOCKED（选型已冻结，公共双transport composition、smoltcp受控foundation与Linux产品/包source contract已实现，发布证据未完成）**。策略、生命周期、source release gate、Linux privileged transaction/helper认证底座、bounded TCP/UDP ingress/FlowRuntime、权威packet/checksum admission、strict IPv6 parser、packet-stack quiesce/drain/terminate supervisor、唯一product composition、Linux generation owner/coordinator recovery、DEB/RPM helper/polkit/package Gate已落地。Windows source contract固定为Wintun global + WinDivert app/PID。smoltcp P0 compatibility spike与完整socket actor/bridge、Virtual-DNS/reassembly、queue/close quarantine仍未闭环，三平台真实vertical slice、配置后的签名/entitlement policy、签名package/native/root/性能/长稳证据仍不存在；因此所有capture capability继续为false。

目标：冻结最危险且会改变架构/交付方式的决策，不再以 UI 进度代替平台可行性。

- 以 `wsstun` commit `8282eb2` 为行为参考基线验证 RoutePlan、PacketDevice、WinDivert 身份关联和 cleanup；tun2proxy 只作为差分测试 oracle，不进入产品运行时。
- 继续落地 `S0-DATA-ADR`：保留已完成的 bounded TCP/UDP StreamIngress/FlowRuntime 与权威 L3/transport admission；ipstack 1.0.1继续排除，smoltcp精确锁定0.13.1并先完成AnyIP TCP/共享port UDP executable spike。随后实现有界sharded socket actor、TCP/UDP bridge、tuple lease、queue/close quarantine与完整memory ledger，并证明Virtual DNS、IPv4/IPv6、MTU/fragment、取消、统计、fuzz、性能与24h资源边界。
- 落地已冻结 `S0-WIN-ADR`：实现 Wintun global + WinDivert SOCKET/FLOW/NETWORK app/PID；验证应用/PID、回注正确性、本机 loop bypass、许可证、官方驱动签名/hash、EDR/VPN 与卸载恢复。当前无第一方 WFP fallback。
- 完成 `S0-CONTRACT-ALIGN` 的平台证据半程：source/schema/template/fixed-policy/verifier/tests 已收敛；先通过评审提交非 placeholder 的 Windows publisher/certificate 与 macOS Team/certificate/architecture policy，再在匹配主机对最终 distribution 跑 non-lint gate（Windows 含 `/kp`）。
- 完成 `W0-SUPPORT-MATRIX`：Windows Beta 固定为 x86_64；macOS `11.0` 只是 provisional build floor，正式最低版本/架构和 Linux distro/kernel/网络栈必须由真实 lab 与维护承诺冻结。
- 完成 `W0-SIGNING-ACCOUNT`：取得并托管受信任的 Windows 用户态 Authenticode 凭据，把 exact publisher/leaf certificate 提交 fixed policy；不要求 EV，不扩大为自有 kernel driver/WFP 签名授权。
- macOS：取得 Apple-managed capability，并用最小 system extension/provider 捕获 TCP/UDP、读取 audit token；选中应用进入受认证数据网关，未选应用 direct。
- Linux：在已落地 cgroup v2+nft+fwmark/TUN、helper WAL/PID、fixed client/TUN/pump、公共 `ProductDataPlaneSupervisor`、产品 `LinuxCaptureAdapter`/coordinator recovery 与 DEB/RPM/polkit Gate 上，补具体受控 stack provider、最终 profile/config builder、可信 tuple→profile side channel和默认 async 产品注入；配置 signer/architecture/完整dependency policy后取得 package-manager/root/native lab，验证 PID race、global+多 app profiles 与降级。未取得证据前 capability 保持 false。
- SSH：基于已落地的共享 `SshChannelPool`/严格 host-key 核心，补真实密码/私钥/Agent、remote DNS、断线重连、MFA 与 TCP echo 证据。
- 验证与主流 VPN、系统代理、休眠/唤醒、网卡切换的冲突。
- 输出 ADR：捕获技术、第三方版本/许可证、最低系统版本、打包方式。

退出标准：已冻结的 `S0-DATA-ADR` 与 `S0-WIN-ADR` 均落地且通过各自硬 Gate；`S0-CONTRACT-ALIGN`、三个系统的最低支持矩阵与 Windows 用户态签名输入关闭；三平台至少完成 TCP 到本地 echo/HTTP server 的 global + selected app 垂直切片；SOCKS5、HTTP CONNECT、SSH Jump 三种 egress 都通过可重复测试；停止或强制终止主进程/privileged component 后网络恢复；没有未解释的 DNS/IPv6/UDP 泄漏。任一平台失败则回到范围或架构评审，不得解锁对应平台 capability。

### Phase 1：纯 Rust 配置、规则与策略核心

当前状态：**PASS（软件范围）**。Profile、冲突检测、GFWList 投影/exception、不可变 matcher、test target 解释与 last-good 行为已有测试；镜像在线可用性仍是发布时运行门。

- Profile、selector、`egress_kind/egress_ref_id`、rule source 模型和 schema migration。
- AutoProxy/GFWList Base64 解码、域名投影、exception、IDNA、CIDR、unsupported 报告。
- 不可变 matcher snapshot、冲突检测、test_target 判定解释。
- last-good 下载器和官方镜像回退。
- 单元/属性测试，不接触系统路由。

退出标准：固定 GFWList 样例、自定义规则和异常输入全部有确定结果；规则更新失败不会破坏当前快照。

### Phase 2：FlowEngine 与上游转发

当前状态：**PARTIAL**。DIRECT TCP/UDP、SOCKS5 TCP、HTTP CONNECT、共享SSH `direct-tcpip`、严格host-key、UDP policy/fallback、独立transport quota、runtime UDP byte budget、取消/统计边界、公共product supervisor和Linux adapter注入seam已经落地；尚缺完整smoltcp TCP/UDP actor/bridge、SOCKS5 UDP ASSOCIATE、Virtual-DNS/reassembly、最终profile/config builder、默认async产品接线、queue/close recovery和三类真实服务器完整矩阵。

- TCP DIRECT、SOCKS5、HTTP CONNECT、SSH Jump `direct-tcpip`。
- 从现有 Tunnel/SSH 模块抽取共享 `SshChannelPool`，补 known_hosts/指纹确认、keepalive、channel 限流、重连和 MFA 状态机。
- Vault 解析、连接测试、超时、取消、上游环路硬绕过。
- DNS/Fake-IP、hostname attribution 和 unknown policy。
- 统计事件，不落 payload。
- SOCKS5 UDP spike；HTTP CONNECT 与 SSH Jump 的 UDP policy 明确降级。

退出标准：本地可重复的 Proxy/SSH 测试服务器覆盖认证成功/失败、host-key 首次信任与变化、断线、DNS、IPv4/IPv6、channel 并发、取消和重连。

### Phase 3：持久化、IPC 与浏览器 Stub

当前状态：**PASS（既有软件范围）**。SQLite/WAL、recovery journal、IPC/Stub、helper heartbeat、mutation-before-WAL root receipt、cleaned tombstone、取消安全 lifecycle/recovery owner 与 Linux coordinator/orchestrator reconciliation 边界已落地；但默认产品 adapter 注入、异步 capture IPC 和已安装平台 artifact 的恢复证据仍归入 Phase 5–8，不能由本阶段 PASS 代替。

- sockscap.db、WAL、recovery journal、统计聚合与清理。
- Tauri commands/events、能力探测和权限状态。
- pnpm dev stub 提供可控的 Windows/macOS/Linux capability、Proxy/SSH egress health 与模拟流量。

退出标准：无真实管理员权限也能完整开发和测试 UI；IPC schema 有 Rust/TS 契约测试。

### Phase 4：独立窗口、配置与 Dashboard

当前状态：**PARTIAL**。UI、focused tests、feature/testcase catalog 与 Linux native hide/reopen smoke 已完成；三平台 tray、权限、恢复和 native system smoke 尚未完成。

- 新 hash route 和 SockscapWindow。
- Profile、程序/进程选择、Proxy/SSH egress、规则源、test target、advanced policies。
- Dashboard、Live Connections 的有界采样和隐私开关。
- i18n、键盘导航、错误/降级文案。

退出标准：Vitest 覆盖编辑冲突、能力降级、状态流转；浏览器 stub 能完成完整用户路径。

### Phase 5：Windows 纵向完成

当前状态：**BLOCKED**。只有 fail-closed manifest/fixed policy、Authenticode/driver-package verifier 与已冻结的 Wintun/WinDivert contract；PowerShell 7.2.24 AST/disabled-template lint 已通过，但 first-party policy 仍 `unconfigured`，且没有真实 Windows non-lint `/kp`、adapter、service/driver 或签名安装包。

- 先关闭 `S0-CONTRACT-ALIGN`、`W0-SUPPORT-MATRIX` 和 `W0-SIGNING-ACCOUNT`；Windows Beta 只构建、验证并发布 x86_64，ARM64 Sockscap capability 保持 fail-closed。
- 按已冻结 `S0-WIN-ADR` 和 13.0.5 的 `W1-GLOBAL` 至 `W1-UPDATE` 落地 Wintun global + WinDivert app/PID。
- 将应用/PID/子进程/new-connections 身份接到共享 FlowRuntime；关闭 WinDivert ownership race、动态五元组 filter、packet reinjection、双捕获与许可证问题。
- 交付 timestamped Authenticode app/helper/service/installer，以及经许可审核、未修改、hash-pinned 的官方 Wintun/WinDivert package；WinDivert DLL 按 provenance/variant/architecture/hash 验证，kernel driver 按预期 signer/hash 和 `/kp` 验证；完成 Secure Boot、管理员提示、EDR/VPN 与安装/升级/回滚/卸载验证。
- 本阶段不交付第一方 WFP callout；若 WinDivert 任一硬 Gate 失败，发布包保持 `can_start_app_group=false`/`can_attach_pid=false`，不用未签名或 test-signed driver 绕过。

退出标准：在 Windows x86_64 支持矩阵内完成全局、程序组、运行 PID、三种 egress、GFWList、托盘、Dashboard 全链路；同机 artifact gate 与 13.0.7 全矩阵通过；重启、崩溃和更新不遗留 Wintun/WinDivert/service/route/DNS 状态；ARM64 不生成 PASS 或可启动 capability。只有此时 Windows Beta 可发布。

### Phase 6：macOS 纵向完成

当前状态：**BLOCKED**。已有 release-only Tauri overlay、source plist/entitlement/profile-certificate/full-`.app` digest 合同与 fail-closed verifier；Team/certificate/architecture policy 仍 `unconfigured`，没有 Apple-approved capability、Xcode target、Swift provider、Rust bridge、已签名/公证 `.app` 或 final DMG/PKG provenance。

- 依次完成 13.0.6 的 `M0-ACCOUNT`、`M1-XCODE`、`M1-ENTITLEMENT`、`M1-ACTIVATE`、`M1-PROVIDER`、`M1-BRIDGE`、`M1-SIGN` 与 `M1-UNINSTALL`。
- entitlement 必须来自匹配的 capability/provisioning profile，profile 的 DeveloperCertificates 必须包含实际 codesign leaf，并在最终 app/provider 上验证；完整 `.app` digest 绑定 native 候选，DMG/PKG/updater 通过 protected build attestation 绑定该候选。源码 plist 或 Linux lint 不能替代。
- 用 audit token/signing identity 绑定 app/PID/profile；provider 和 Taomni 之间使用受认证、版本化且有界的 control/data bridge，provider/主程序/upstream 全部硬绕过。
- 先以真实 Apple entitlement、构建和实验室能力冻结最低 macOS 版本及 Apple Silicon/Intel 支持范围；`11.0` 不作为现成支持结论。把 Team/certificate/architecture 提交 fixed policy 后，只对冻结范围构建、签名并验证。

退出标准：Developer ID 下载包通过签名、provisioning、Gatekeeper、notarization/staple 与同机 artifact gate；全局、程序组、运行 PID 的新连接路由可验证；批准/拒绝/替换/升级状态清晰；卸载不遗留 system extension 或 Network Extension 配置；13.0.7 全矩阵通过。

### Phase 7：Linux 纵向完成

当前状态：**PARTIAL（公共双transport supervisor、smoltcp foundation、产品owner与包安全合同已落地，真实数据面仍BLOCKED）**。既有cgroup-v2/nft/fwmark/TUN、认证helper、WAL/PID、fixed client/TUN、双pump、fault withdrawal/tombstone之上，已有取消安全的公共generation supervisor、权威packet admission、Direct UDP/有界runtime、provider quiesce→runtime drain→final terminate、`LinuxCaptureAdapter`/coordinator recovery、Store-global detached operation mutex、disk WAL `synchronous=FULL`，以及canonical directory/lock/DB checks + retained OS owner lock的source-level journal ownership边界；desktop single-instance仅负责activation UX。当前只有source/memory tests、same-process double-open/drop-release与Unix path tests；handle-relative SQLite/VFS、Windows SID/DACL、三平台跨进程/crash/multi-session native、WAL fault/power-loss仍待验。另有带生命周期锁/sentinel/快照/hermetic verifier/元数据拒绝的DEB/RPM-only package Gate。仍缺P0 spike后的完整stack actor/bridge、最终profile/config builder、tuple→profile side channel、queue/close quarantine、默认产品注入/异步IPC，以及配置后的signer/architecture/完整依赖policy、可信lab attestation和真实package-manager/root/native smoke，因此四个capability位全部保持false。

- 完成 13.0.4 剩余项：先让smoltcp P0 compatibility spike全绿，再实现有界sharded socket actor、TCP/UDP bridge、tuple lease、MTU/deadline/parser differential和queue/close quarantine；以最终Linux composition builder接通profile/config snapshot和可信tuple→profile side channel。在不改变fail-closed probe的前提下完成默认产品/异步IPC注入，再取得签名package/native/root evidence。
- 先冻结首发 distro/kernel/systemd/cgroup/nft/iproute2/resolver/NetworkManager 矩阵及维护责任；本文不以“主流 Linux”替代可执行的版本清单。
- 保持最小权限：固定 helper/polkit action、独立字段验证、无任意 shell/argv；helper 创建系统 artifact，unprivileged runtime 持有数据面。
- 在一次性 VM/fixture 中验证 cgroup v2/nft/fwmark/TUN、managed-launch namespace fallback、systemd-resolved、NetworkManager、IPv6 和支持发行版；仅在基线被证实不可行时另开 ADR 评估 eBPF。
- 对 numeric `cgroup.procs` 无法把“PID incarnation 识别 + move”做成单次原子内核操作这一缺口，完成 pidfd/可用内核接口评估，并在高频 PID reuse 的真实 root lab 中证明不会移动错误进程；当前写前/写后 start-tick、UID 与 owned-cgroup 复验是 fail-closed 防线，不是原子性证明。
- 已明确 AppImage/deb/rpm 边界：只有显式 release overlay 的 DEB/RPM 候选可携带固定 helper/policy/polkit；AppImage/updater永远capture-disabled。先对最终app/helper做ELF/脚本依赖解析并冻结每个distro/arch的完整依赖profile；当前仅3个capture工具依赖不是完整GUI包合同。随后在真实包管理器证明缺依赖拒绝、clean install、dirty-state blocker、upgrade、rollback、uninstall/reinstall与零残留。
- DEB 的 detached `.asc` 只证明候选可被本 verifier 检查，不会自动让 `apt`/`dpkg` 强制验证；生产分发必须使用签名 apt repository `Release/InRelease`，或一个不可绕过且先验签的受控 installer，并测试篡改下载、旧 Release、过期 key 与回滚攻击。RPM同样必须在冻结仓库/安装器链中验证 GPG policy，而非只验证离线文件。
- 当前 aggregate 对 Linux package-manager provenance 固定 fail-closed；实现受保护 runner、冻结并提交其身份/公钥/签名协议、通过伪造/重放/候选替换负向测试后，才可移除 `LINUX_INSTALL_PROVENANCE_ATTESTATION_UNCONFIGURED`。结构正确或 hash 自洽的自报 JSON 仍不是生产证据。

退出标准：支持矩阵内发行版完成 global、application group、running PID/new-connections 与多 profile；能力降级可解释；真实 package gate 与 13.0.7 全矩阵通过；停止、kill、重启、升级、卸载后无 socket/TUN/nft/ip rule/route/cgroup/DNS/policy 残留。

### Phase 8：托盘、可靠性、QA 与发布 Gate

当前状态：**PARTIAL**。native tray/guarded exit代码、recovery UI、Linux native window smoke、fixed core/per-platform 24h verifier与100 synthetic lifecycle cycles已落地；本版新增的UDP resource/two-phase cleanup仍只有source tests。真实托盘/system smoke、actual capture、真实adapter 100-cycle、24h、stable 7-day receipt/verifier、性能/泄漏和三平台package evidence尚缺。

- 完成并验证已落地 Tauri tray 的动态状态、菜单、错误回显和 guarded exit；禁止 tray Start 绕过 runtime capability probe。
- Windows/macOS 验证左键切换，Linux 验证菜单兜底；三平台都覆盖窗口隐藏、重开与状态保持。
- 睡眠/唤醒、网卡切换、代理不可用、SSH 断线/host-key 变化/MFA 等待、Vault 锁定、规则更新失败、进程退出。
- 扩充 feature-list/YAML；三平台 native smoke 覆盖独立窗口、托盘、权限拒绝/批准、Active 退出、恢复网络与 system component 状态。
- 按 13.0.7–13.0.9 生成三平台长稳、性能、泄漏、恢复、安装/升级/卸载与生产运维的 hash-pinned evidence；修复或明确豁免全局 QA Gate 的既有基线问题。

退出标准见 Definition of Done。

## 14. 测试与质量门槛

以下门槛分为“代码/合成证明”和“真实平台发布证明”。前者用于快速回归，不能替代后者；固定阈值已经编码在 `scripts/sockscap/verify-performance-gate.py`，发布时不得临时放宽或缩短。

### 14.1 功能与协议矩阵

- 配置组优先级与重叠拒绝。
- GFWList proxy/exception、手工 override、unknown 三种动作。
- HTTP/SOCKS 认证、错误、超时、连接重用边界。
- SSH 密码/私钥/Agent、known_hosts、指纹变化、MFA、remote DNS、channel 并发、keepalive、断线重连与跳板禁止转发错误。
- 程序、PID、子进程；PID 重用保护。
- IPv4/IPv6、DNS、DoH 场景、QUIC/UDP policy。
- Proxy/SSH 上游地址、loopback、LAN、Taomni/helper 自身不形成环路。
- global + 两个不同 app profiles 并行；未选中流量不进入 Sockscap，选中流量保持原 profile identity。
- 同一套 matcher/connector 分别由内存 packet、内存 stream 和平台真实 ingress 驱动，决策结果一致。

### 14.2 生命周期与故障注入

- 每个真实 adapter start/stop 连续至少 100 次，并逐次比较路由/DNS/filter/TUN/cgroup/service/provider 前后状态；cleanup failure 必须为零。
- 在 prepare/activate/Active/stop 每一步注入失败；Active 时分别终止主进程和 helper/provider，验证当次或下次启动恢复。
- 睡眠、唤醒、Wi-Fi/有线切换、VPN 开关、代理掉线、SSH 控制连接重置和跳板重启。
- 安装、升级、被中断的升级、回滚和卸载均先恢复系统网络；正式包卸载后 residue 为零。
- owner 存活时，上游/规则/flow-runtime 故障必须分别证明 fail-open 恢复 DIRECT 与 fail-closed 保持 BLOCK；主进程/helper/provider 心跳丢失则按 16.6 决策 23 撤销捕获恢复直连，并记录可见的 forced safety recovery，不能继续显示为 Active/受保护。

### 14.3 已固定的 core Gate

| Gate | 固定要求 |
|---|---|
| Matcher quick | 编译 10,000 条规则；20,000 个计时样本；P99 ≤ 100 µs |
| Lifecycle quick | 100/100 synthetic start-stop 完成，journal 清空 |
| Core soak | optimized `sockscap-gate` 连续至少 86,400 秒；heartbeat 最大间隔 ≤ 10 秒，资源采样最大间隔 ≤ 2 秒 |
| Core resources | RSS end growth ≤ 32 MiB、peak growth ≤ 64 MiB；支持测量时 open-file end growth ≤ 4 |
| Evidence identity | receipt 标明完整 40 位 commit、release profile、platform/architecture 与 `releaseEligible=false`；quick/soak 同 commit、同 platform/arch |

Core Gate 证明生产 matcher/store/coordinator 在合成 adapter 上的确定性与资源边界；其 receipt 明确是 `synthetic_core_no_host_capture`，不能解锁 `can_start_*` 或替代任何平台 Gate。

### 14.4 已固定的真实平台性能/长稳 Gate

| Gate | 固定要求 |
|---|---|
| TCP 建连 | ≥100 个 direct/captured 样本；排除 direct baseline 后额外中位延迟 `< 10 ms` |
| 吞吐 | 同机样本 ≥60 秒；链路标称 ≥1,000 Mbps；direct ≥链路 80%；captured ≥direct 80% |
| 生命周期 | ≥100 次真实 start-stop，≥100 次 cleanup check；residue、unexpected app exit、unexpected helper/provider exit 全为 0 |
| 长稳资源 | actual capture 连续 ≥86,400 秒；RSS growth ≤64 MiB；open-handle growth ≤8 |
| Stable staged 长稳 | 三平台 stable 候选在冻结支持矩阵中分阶段连续运行 ≥7 天；需新增并固定非 synthetic receipt/schema/verifier、候选 commit/artifact/host，未解释 component exit、capture residue、DNS/IPv4/IPv6/UDP leak、资源越界均为 0 |
| 恢复 | kill main、kill helper/provider、restart、sleep/wake、NIC switch、VPN coexistence 全部 PASS |
| 泄漏 | DNS、IPv4、IPv6、UDP audit 全部 PASS；TCP-only egress 的 UDP BLOCK/DIRECT 必须与 profile 声明一致 |
| 证据 | artifact gate、native smoke、core quick、core soak 与至少 4 个 raw evidence 文件逐一 SHA-256 pin；manifest 只能在匹配 OS 上验证 |

除固定 verifier 外，仍需做 1,000 活动连接下 Dashboard IPC ≤2 次/秒、rule snapshot/统计落盘不阻塞转发热路径的 profiling；结果作为 raw evidence 保存。磁盘 Store 已固定为 WAL + `synchronous=FULL`，因此还必须在真实统计写入频率与受控磁盘上记录 batching throughput、commit p95/p99、WAL checkpoint latency/size、capture/UI jitter，并在发布前冻结可维护阈值；不得为跑分把 durability 降回 `NORMAL`。若硬件无法达到 direct 基线，结论应是实验室不合格，而不是下调产品阈值。

### 14.5 UI、native 与 package QA

- 新 feature-list 条目覆盖 Dashboard、Profiles、Rules、process picker、capability warnings 和 recovery。
- Vitest 测纯 UI、状态和 stub；qa-ui-auto 覆盖 browser mode。
- 独立窗口、托盘、权限弹窗、真实 helper/provider 状态和恢复只能用 Tauri/native smoke 验证，不能只靠 jsdom、browser stub 或 dry-run 宣称完成。
- release `nativeSmoke` 必须是 typed `sockscap_native_capture_smoke` real-host receipt，包含通过的 `TC-SOCKSCAP-native-capture-smoke` 与完整 capture matrix，并绑定 exact artifact Gate/candidate/component hashes；macOS 绑定 full-`.app` digest，最终 distribution 由 protected provenance 关联。现有 qa-ui native-window summary 继续作为独立窗口/IPC 证据，但会被 release verifier 拒绝。
- Windows/macOS `artifactGate` 必须使用同机最终签名 artifact verifier 的 PASS JSON；Linux 必须提供等价的包签名、architecture/provider、installed path、root owner/mode/helper-policy receipt。aggregate Gate 在该主机重算 receipt-listed artifacts；源码 lint 永远不是 artifact PASS，JSON 自洽也不能替代 protected producer 的 signed attestation。

### 14.6 当前证据缺口

- 已通过：最终共享源码 Sockscap Rust 355/355，repository lib 1,234 total：1,223 passed、0 failed、11 ignored；Python helper-policy 5/5、package-contract 10/10、Linux release 27/27、aggregate/performance 26/26；macOS host/Bash 3.2 syntax+disabled-template lint；PowerShell 7.2.24 AST+disabled-template lint；frontend 67/67 与 TypeScript/Vite build。既有 catalog/lint、Linux native window smoke、10,000-rule quick 与 100 synthetic cycles 是较早 source snapshot/非 capture 证据，最终候选仍须精确 commit 重新绑定。Linux WAL/PID/client/TUN/adapter/supervisor/Store tests 只证明 source contracts，不是产品 capture、power-loss 或跨进程 owner-lock evidence。
- 仅执行证明：约 3.2 秒短 soak；它不能充当 24h receipt。
- 尚未实现或运行：P0 executable compatibility spike之后的production smoltcp sharded socket actor、TCP/UDP bridge、tuple lease、queue/close quarantine/reconcile、Virtual DNS/reassembly policy与最终profile/config builder；可信tuple→profile side channel；`AppState`/async commands/tray的真实Linux adapter start/update/heartbeat/stop注入；Windows/macOS真实adapter；single-instance的window-ready pending focus与allowlisted `--sockscap-auto-restore` activation-intent转交；Linux完整distro依赖profile、签名repository/package及root/native evidence；typed real-capture producer；protected signed lab attestation；三平台真实capture/egress/leak/performance/100-cycle/24h/7d、tray/system smoke和安装/升级/卸载矩阵。exact dependency pin、P0 memory spike或Linux source owner/coordinator/package verifier都不能代替上述证据，缺口关闭前四个capability位不得改变。
- 全局 QA audit 仍受既有非 Sockscap baseline 问题影响；M5 前必须修复或由正式、可追踪的豁免机制处理，不能用 focused coverage 隐去。

## 15. 主要风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows Wintun/WinDivert provenance、签名、许可与兼容性 | 官方 package 不能合规分发、driver signer 不被接受、DLL provenance/hash/architecture 不一致、身份 race/性能不足或触发安全软件 | 固定未修改官方 package/variant 与逐文件 hash；DLL 校验 provenance/architecture/hash，driver 校验预期 signer/hash 与 `/kp`；完成 LICENSE/NOTICE 或商业许可、EDR/VPN/回注/双捕获 Gate；失败则禁用 app/PID capability，当前无 WFP fallback |
| Windows 支持范围/用户态签名 | ARM64 被误报可用，或 unsigned app/helper/service/installer 无法可信分发 | 第一版 Windows Beta 仅 x86_64；ARM64 capability fail-closed；关闭 `W0-SIGNING-ACCOUNT`，验证 timestamp、publisher、密钥托管与轮换/吊销 |
| macOS entitlement/system extension | 没有资格即无法交付 | 先申请 entitlement，再做完整 UI；保留 capability gate |
| Linux 发行版与内核差异 | PID 模式不一致 | 明确最低矩阵；eBPF/cgroup 探测；netns fallback |
| Linux 包依赖/仓库信任不完整 | 包可通过离线签名/metadata Gate却在干净主机缺WebKit/GTK/OpenSSL/Kerberos等依赖，或用户用未验证的 detached package直接安装 | `packageDependencyContractState=unconfigured`时硬失败；按冻结distro/arch从最终ELF与脚本生成并审查完整依赖profile；DEB使用签名apt Release/InRelease或不可绕过的verified installer，RPM使用受控仓库GPG policy；clean-install与篡改下载负向测试必过 |
| smoltcp transparent semantics或资源账本不成立 | AnyIP/listener/UDP demux与预期不一致会串flow；MTU/fragment/parser differential会silent drop；bridge/binding未计入会突破内存上限 | exact 0.13.1/0BSD/archive hash；先跑IPv4/IPv6 TCP与shared-port UDP executable STOP/GO spike；fragmentation关闭、link-local拒绝；显式stack+bridge+association+binding+staging内存公式与checked overflow；任何probe失败停止路线而非猜测/fork |
| queue/close cleanup proof缺口 | cancel/ingress fault时尚未accept的flow/association或close timeout/error可能丢失control owner、提前释放tuple/permit并让旧native状态泄漏 | ingress admission close + bounded drain；每个tuple使用lease；close必须cancellation-safe、无detached且幂等可重试；失败进入有界quarantine/recovery registry并阻止clean/owner shutdown，直到平台reconcile明确成功；Drop emergency reaper不计proof |
| UDP预算有界但无活性 | 两方向receive都先占同一semaphore，若slot少于association双向需求，静默方向可饿死有数据方向到idle timeout | 配置验证`floor(bytes/65535) >= 2 * max_udp_associations`或拆方向budget；默认值必须满足；最终single-product builder提供跨generation共享/互斥证明，压力测试双向静默/突发公平性 |
| 双实例/包事务并发误清理 | 第二个Taomni、helper session与upgrade同时操作同一generation，可能清理live capture或放行不完整升级 | 同 Store runtime owner 共用 operation mutex；`SockscapStore` canonicalize并持有目录，复核目录/锁/DB path后持续持有OS owner lock，竞争失败即fail closed；desktop single-instance只做activation UX。helper共享锁、package独占锁+sentinel；coordinator做expected-generation CAS并精确绑定durable adapter/handle lineage，install heartbeat 后的失败不得用旧 handle 清理。当前仅有same-process double-open/drop-release、Unix path和source fake tests；SQLite仍按pathname打开，故须handle-relative VFS/Windows SID-DACL、恶意same-user substitution、三平台跨进程/crash/multi-session、崩溃/升级并发native测试并证明各锁在整个owner/session/transaction内持有 |
| Linux numeric PID/cgroup move race | 进程在身份检查与 `cgroup.procs` 数字写入之间退出并复用时，可能短暂移动错误 incarnation | 已做 kernel start tick/UID/owned cgroup 的写前写后重验、exact target 确认并 fail to recovery；生产前在真实内核做高压 PID-reuse lab，评估 pidfd/可用 kernel interface，不能把 source checks 宣称为原子保证 |
| CI供应链/证据producer混用 | 可移动Action tag、漂移runner或高权限source job可改变构建/证据而不被manifest发现 | Sockscap Actions已pin commit、Rust/MSRV固定1.95；继续冻结runner镜像，建立action升级审计，把build/sign/publish与普通source gate隔离并签发不可伪造provenance |
| 更新密钥或坏版本发布 | 客户端无法继续升级、批量故障或回滚链失效 | `P0-RELEASE-OPS`：受控密钥、离线恢复、轮换/吊销演练、分阶段放量、停止放量和签名回滚 |
| privileged parser/现场日志安全 | 提权边界被攻击，或支持资料泄漏网络与凭据 | `P0-SECURITY/P0-SUPPORT`：threat model、持续 SBOM/CVE、脱敏 fixture、日志磁盘上限和符号访问控制 |
| GFWList 是 URL 规则而产品只做域名路由 | 语义不完全等价 | 域名投影、unsupported 报告、test target，不做虚假全兼容 |
| DoH/ECH 隐藏域名 | GFW 模式漏命中 | hostname_source、unknown policy、严格模式和告警 |
| HTTP CONNECT 不支持 UDP | QUIC/WebRTC 泄漏或失败 | 显式 direct/block；推荐 block 促 TCP fallback |
| SSH `direct-tcpip` 不支持 UDP | QUIC/WebRTC 泄漏或失败 | SSH profile 默认 BLOCK UDP，可改 DIRECT；UI 明确 TCP-only |
| SSH host key 被替换或当前校验过宽 | 中间人风险 | 发布前完成 known_hosts/指纹确认；变更立即阻断并要求人工复核 |
| SSH 单控制连接中断 | 大量 channel 同时结束 | 有界连接池、keepalive、退避重连、Degraded/UserActionRequired 与可选 fail-open |
| VPN/防火墙/EDR 冲突 | 断网或重复捕获 | 单一捕获面、能力诊断、fail-open、兼容矩阵 |
| 崩溃遗留系统规则 | 系统断网 | helper heartbeat、recovery marker、启动修复、一键恢复 |
| 数据面 Active 后静默死亡 | UI 仍显示 Active，而捕获可能黑洞、泄漏或停留在旧规则 | Linux source lifecycle 已订阅 terminal/heartbeat ambiguity并helper-first withdrawal；产品 generation owner/coordinator/orchestrator recovery已绑定journal且取消安全。仍须默认产品注入、异步状态回显及真实 privileged lab证明；Windows/macOS也必须实现同等路径 |
| helper 清理响应丢失或 tombstone 无界累积 | receipt 已删除但调用方无法证明清理、错误猜测成功，或 `/run` 长期累积 generation 记录 | cleaned-generation tombstone 先持久化再删 receipt，重试继续做 absence audit；GC 仅接受 durable coordinator journal/rollback low-water mark，禁止按时间/数量盲删；仍须真实 root crash/断电/磁盘错误/GC 证据 |
| 域名统计敏感 | 隐私风险 | 默认关闭域名聚合、短保留、清空、不记录 payload/URL |
| 第三方许可证 | 与 MIT 发布冲突 | Phase 0 SBOM/许可证 Gate；优先 MIT；不直接静态链接未批准 GPL 核心 |
| `wsstun` 参考实现继续演进 | 设计与复制代码漂移 | 固定参考 commit；以行为测试和 ADR 为准，不建立源码目录间隐式依赖 |

## 16. 评审决策（已确认）

以下结论已于 2026-07-18 完成评审，作为 Phase 0 和后续实现基线。若实现验证需要改变结论，必须通过新的 ADR 或设计评审更新本节。

### 16.1 产品、平台与发布

1. 产品名：界面叫 “Sockscap”，设置搜索关键词同时包含“流量路由”“进程代理”和“上游代理”。
2. 平台顺序：Phase 0 同时验证 Windows、Linux、macOS；正式纵向实现顺序为 Windows → Linux → macOS。
3. 发布口径：Windows 可以先发布 Beta；三平台均通过 stop、crash、restart、upgrade、uninstall 恢复测试后才标记为“跨平台稳定”。

### 16.2 故障、未知流量与协议降级

4. 故障策略：全局默认 fail-open，恢复 DIRECT；每个配置组可以显式选择 fail-closed BLOCK。fail-closed 适用于系统 owner 存活期间的上游/规则/数据面故障；主进程/helper 心跳丢失时以决策 23 的可恢复网络安全规则为准。
5. 未知域名：普通模式默认 DIRECT，并显示 unknown/DNS leak 指标；严格模式可以选择 PROXY 或 BLOCK。
6. TCP-only 上游：HTTP CONNECT 和 SSH Jump 的 UDP/QUIC 默认 BLOCK，以促使 QUIC 回退 TCP；用户可以显式改为 DIRECT，UI 必须标示潜在泄漏。
7. 本地网络：loopback、Taomni/helper 自身连接、Proxy/SSH 上游端点属于强制硬绕过；LAN、私有地址和链路本地默认 DIRECT，但配置组可以改为按规则或 BLOCK。
8. 不可代理协议：ICMP 及所选上游无法承载的协议默认 DIRECT，strict/fail-closed 配置组可以 BLOCK；IPv4、IPv6 使用相同策略，不允许静默漏掉 IPv6。
9. SOCKS5 UDP：上游能力探测通过时支持标准 UDP ASSOCIATE，关联生命周期绑定 TCP control connection；失败时严格执行配置组 UDP policy，不静默降级。TCP CONNECT 与 DNS 是 Windows Beta Gate，SOCKS5 UDP 是跨平台稳定版 Gate。

### 16.3 GFWList 与规则语义

10. GFWList 来源：内置 `gfwlist-official` 使用官方 GitHub raw、GitLab、Repo.or.cz 健康镜像；Bitbucket URL 保留为来源记录和兼容候选；失败时继续使用 last-good。允许本地文件和自定义 URL，首版不把列表内容打包进安装包。
11. 规则顺序：用户有序 override 采用 first-match wins，优先于订阅规则；订阅 DIRECT 例外优先于 PROXY 条目，最后使用配置组 default_action。
12. 规则投影：URL、路径、通配符和正则只有能无歧义提取 hostname 时才转换；其余标记 unsupported 并展示数量和示例。部分 unsupported 不阻止更新，Base64、结构或完整性校验失败则拒绝新快照并保留 last-good。
13. 可解释性：测试目标必须返回配置组、规则原文、规则源、hostname_source 和最终动作；不得宣称 GFWList URL 语义被完整等价实现。

### 16.4 配置组、程序与进程

14. 新连接语义：配置组、程序/PID、规则和上游变更只影响后续新连接，不迁移已有 TCP 连接或 SSH channel。
15. 配置组冲突：同时最多一个启用的 global 配置组；多个程序组按较小 priority 数字优先；同优先级选择器重叠时拒绝保存并显示冲突来源。
16. 程序选择：程序身份规则持续匹配后续实例，默认包含子进程，用户可以关闭。
17. 运行进程：默认只匹配所选 PID，可显式包含后续子进程；保存 PID 与 platform-native process-incarnation token 防止 PID 重用（Linux 为 `/proc/<pid>/stat` kernel start tick，并紧邻 mutation 前后重验）。“记住这个进程”转换成程序身份规则，不持久化短生命周期 PID。

### 16.5 SSH Jump 与信任

18. SSH 范围：首版选择一个已保存 SSH Session 作为 egress，每条 TCP 流使用一个 direct-tcpip channel，并共享控制连接池；不支持嵌套 Proxy/Jump、多跳、负载均衡或自动切换跳板。
19. SSH 信任：known_hosts/指纹严格校验是发布 Gate；首次信任需要用户确认，host key 变化立即阻断。该软件能力已经落地，发布前仍须完成真实 SSH server 的首次信任、匹配、变化与后台重连验证。
20. SSH 认证状态：Agent、私钥和已保存密码可以后台重连；需要交互式 MFA 时，手工启动允许提示，后台启动或重连进入 UserActionRequired。Session 删除、Vault 锁定或认证失效时不切换到其他上游，按配置组 fail-open/fail-closed 处理。

### 16.6 窗口、自动恢复与统计隐私

21. 窗口与托盘：Sockscap Active 时关闭窗口默认隐藏到托盘并继续运行；托盘提供打开、启动/停止、恢复网络和退出。明确退出时必须等待 helper 确认网络恢复。
22. 自动启动：首次安装默认不自动启用；用户可以显式开启“登录系统后恢复 Sockscap”。自动恢复只使用上次成功提交的配置快照，不加载草稿。
23. 故障恢复：helper 启动时先检查 recovery journal 并清理遗留捕获/路由状态，再决定是否恢复上次 Active 状态；host key、MFA、Vault 或凭据问题进入 UserActionRequired。helper 心跳丢失时优先撤销捕获恢复直连；一键恢复网络不依赖上游可用。
24. 聚合统计：不含域名的分钟聚合默认保留 7 天、小时聚合保留 90 天；支持“仅本次运行，不落盘”、修改期限、停止采集和立即清空。
25. 域名与敏感数据：域名聚合默认关闭，开启后默认保留 7 天。不记录 payload、完整 URL、DNS response body、用户名、密码、私钥路径或 MFA 回答；SSH 仅保存 channel、重连和 RTT 等非敏感聚合。

### 16.7 Windows 技术选型

26. Windows 捕获：全局模式以 Wintun/TUN 为基线；程序/PID 使用 WinDivert SOCKET/FLOW/NETWORK。只分发固定版本/变体/签名人/SHA-256 的未修改官方签名驱动，并完成许可证、身份 race、性能、回注正确性、IPv6、EDR/VPN 兼容和故障恢复 Gate。项目当前无法取得 EV 证书，因此第一方 WFP callout 不在当前路线；WinDivert 硬 Gate 失败时禁用 app/PID capability，不使用 test-signed WFP 回退。

### 16.8 生产数据面

27. 共享数据面：Taomni 拥有 `FlowRuntime`、逐流身份/策略/egress、取消、统计、背压与生命周期；PacketIngress 通过exact-pinned smoltcp 0.13.1 behind a controlled adapter得到TCP/UDP flow，不从零实现TCP/IP。ipstack 1.0.1因unbounded channel排除；tun2proxy仅用于行为参考和差分测试，不是产品运行时依赖，不维护长期fork。exact pin/device单测不等于provider完成，必须通过P0 executable semantics与全部resource/native Gate。

### 16.9 生产范围、签名与运维

28. 支持矩阵：第一版生产 Windows Sockscap Beta 仅支持 x86_64。当前官方 WinDivert/不自建驱动路线不交付 Windows ARM64 Sockscap。macOS 最低版本与 Apple Silicon/Intel 范围、Linux distro/kernel/用户态网络组件范围必须由真实实验室和维护 owner 冻结；macOS overlay 的 `11.0` 仅是 provisional build floor，不是生产支持承诺。
29. Windows 签名：Taomni app/helper/service/installer 必须使用受信任、带时间戳的用户态 Authenticode；本计划不要求 EV。exact publisher subject 与 leaf-certificate SHA-256 必须提交到 fixed policy，当前 `unconfigured` placeholder 会让 non-lint gate 硬失败。凭据需受控托管、最小 CI 权限、轮换、吊销和应急 owner；它不授权构建、修改或 test-sign Wintun/WinDivert/WFP 驱动。
30. 生产运维：Sockscap 生产标签要求 `P0-RELEASE-OPS`、`P0-SECURITY` 和 `P0-SUPPORT` 关闭。能下载 updater 包不等于生产链完成；必须可分阶段放量、停止新版本放量、验证签名回滚，并持续生成 SBOM/CVE 结果及可安全导出的脱敏诊断证据。
31. 数据面 readiness 与 cleanup：provider ready只表示精确pin/identity/capability的event loop接管了有界输入，不能单独解锁capture capability。平台只有在native pump、packet stack与唯一`FlowRuntime`组合ready/healthy后才可activate；Active后任一组件fault必须自动撤销capture。正常stop固定为provider admission quiesce+ack → runtime/egress/profile cleanup proof → final provider termination；queued/unaccepted对象与close failure必须被drain/quarantine/reconcile。startup/drop的emergency detached reaper不计入clean-shutdown或发布恢复证据。

## 17. Definition of Done

“代码合并”“功能接通”“可发布接通”和“三平台 stable”是四个不同状态。只有同时满足下列项目才能关闭本计划：

- Windows x86_64、冻结支持矩阵内的 macOS 与 Linux 均从正式安装包运行一个真实捕获面，并支持 global、application group 和平台承诺的 running PID/new-connections；Windows ARM64 和其他未支持环境 fail-closed 且有明确 capability reason。
- 多个配置组按冻结优先级共用单一捕获面；global + 至少两个 app profiles 并行时身份不丢失，不出现多个 TUN/provider/filter 争抢或重复捕获。
- DIRECT、SOCKS5、HTTP CONNECT 与 SSH Jump TCP 通过可重复真实服务器矩阵；SOCKS5 UDP 达到稳定版 Gate；SSH host-key 变化立即阻断。
- GFWList 更新、镜像回退、exception、manual rule 和 test target 可解释；DNS/IPv4/IPv6/UDP/unknown 不静默泄漏，Dashboard 显示实际降级。
- Taomni、helper/provider、data runtime、loopback 和动态 upstream endpoints 永不递归捕获；bypass 更新失败不会发布半配置 generation。
- stop、主进程/helper/provider crash、restart、sleep/wake、NIC/VPN change、upgrade、rollback、uninstall 后无系统网络 artifact 残留，且一键恢复不依赖上游可用。
- native pump、packet stack 或 `FlowRuntime` 在 Active 后异常退出时，owner 无需等待下一次用户操作即可观察 fault、撤销 capture 并进入可恢复状态；所有正常 stop 均显式 join，不能以 Drop emergency reaper 作为通过证据。
- Windows 最终 service/driver/package、macOS app/provider 与 Linux helper/package 均通过本机签名/entitlement/owner-policy verifier；不依赖 test signing、开发者模式、关闭 Secure Boot/SIP 或手工 root 命令。
- Vault 外没有 Proxy/SSH 明文 secret；argv、IPC error、日志、DB、统计和 evidence 不含 payload、完整 URL、密码、私钥路径或 MFA 回答。
- Rust、Vitest、contracts、qa-ui-auto、三平台 typed native/system smoke、真实功能矩阵与 14.3–14.5 Gate 全部通过；三份 platform PASS manifests 对应同一正式 release candidate，原始证据 hash-pinned，并由 protected lab/CI 的签名 provenance/attestation 绑定 host 与最终 app/helper/provider artifacts；macOS native 直接绑定 canonical full-`.app` digest，最终 DMG/PKG/updater 再由 build attestation 证明包含同一候选。
- 只有本机 installed probe、artifact verification、data-plane self-test 与 scope probe 全部通过，才可把对应 `can_start_global`/`can_start_app_group`/`can_attach_pid` 置为 true；`capture_implemented` 只表示该平台生产代码进入构建，不能单独解锁启动。
- updater 密钥托管/轮换/吊销、分阶段放量/停止放量/签名回滚、安全评审、持续 SBOM/CVE、脱敏支持包、crash symbols 和日志磁盘上限均有通过的演练或自动化证据。
- Windows Beta 可以在 Windows manifest 单独绿后发布；产品或文档只有在 Windows、macOS、Linux 三份 manifest 全绿后才能使用“跨平台稳定”。

当前 DoD 状态为 **BLOCKED**：基础软件与 synthetic/native-window 证据已存在，但三平台均未达到功能接通，更未达到可发布接通。

## 18. 参考资料

- 本地参考实现：`D:\code\person\wsstun` commit `8282eb2`，重点为 `sockscap-design.md`、`src/sockscap/` 与 `resources/macos-provider/`；仅作为设计和 spike 基线，不形成运行时目录依赖。
- [GFWList 官方 GitLab 镜像与 README](https://gitlab.com/gfwlist/gfwlist)
- [GFWList GitLab raw](https://gitlab.com/gfwlist/gfwlist/raw/master/gfwlist.txt)
- [GFWList 官方 GitHub 仓库与当前订阅地址](https://github.com/gfwlist/gfwlist)
- [tun2proxy：MIT Rust TUN to HTTP/SOCKS core](https://github.com/tun2proxy/tun2proxy)
- [ipstack：Apache-2.0 userspace TCP/IP stack](https://github.com/narrowlink/ipstack)
- [WinDivert 官方项目、签名二进制与分发说明](https://reqrypt.org/windivert.html)
- [WinDivert FAQ：WFP、驱动签名与许可](https://reqrypt.org/windivert-faq.html)
- [Tauri 2 System Tray](https://v2.tauri.app/learn/system-tray/)
- [Tauri 2 macOS code signing](https://v2.tauri.app/distribute/sign/macos/)
- [Tauri 2 macOS application bundle 与 entitlements](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Tauri 2 sidecar](https://v2.tauri.app/develop/sidecar/)
- [Wintun 官方项目与 API](https://www.wintun.net/)
- [Microsoft Windows Filtering Platform](https://learn.microsoft.com/en-us/windows/win32/fwp/about-windows-filtering-platform)
- [Microsoft Application Layer Enforcement](https://learn.microsoft.com/en-us/windows/win32/fwp/application-layer-enforcement--ale-)
- [Microsoft driver signing tutorial](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/windows-driver-signing-tutorial)
- [Microsoft Hardware Developer Program 注册条件](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/hardware-program-register)
- [Microsoft driver signing options and best practices](https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/driver-signing-offerings)
- [Microsoft kernel-mode code-signing policy](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-)
- [Apple NETransparentProxyProvider](https://developer.apple.com/documentation/networkextension/netransparentproxyprovider)
- [Apple Network Extension provider deployment](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)
- [Apple Network Extension entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.networking.networkextension)
- [Apple System Extension install entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.developer.system-extension.install)
- [Apple OSSystemExtensionRequest](https://developer.apple.com/documentation/systemextensions/ossystemextensionrequest)
- [Apple NEFlowMetaData sourceAppAuditToken](https://developer.apple.com/documentation/networkextension/neflowmetadata/sourceappaudittoken)
- [Apple capability requests](https://developer.apple.com/help/account/capabilities/capability-requests/)
- [Linux TUN/TAP driver](https://docs.kernel.org/networking/tuntap.html)
- [Linux network namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [nftables manpage（含 socket cgroupv2 expression）](https://netfilter.org/projects/nftables/manpage.html)
- [polkit architecture and authorization](https://polkit.pages.freedesktop.org/polkit/polkit.8.html)
- [pkexec security model](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html)
