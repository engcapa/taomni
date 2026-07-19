# Taomni 跨平台 Sockscap 设计与实施计划

状态：Implementation in progress — Revision 5
初始日期：2026-07-18
最近更新：2026-07-19
本版范围：记录已落地底座，冻结共享数据面与 Windows 捕获选型，并定义 Windows、macOS、Linux 真实接通所需的代码、外部输入、验证矩阵与发布证据。

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

### 1.1 2026-07-19 实施快照

当前分支已经越过“仅设计/原型”阶段，但还没有任何系统完成产品级真实接通。基准状态以 [Sockscap Release Gate Ledger](./sockscap-release-gates.md) 为准：

| 领域 | 已落地 | 当前缺口 |
|---|---|---|
| 策略与出站 | Profile/规则/GFWList、DIRECT、SOCKS5 TCP、HTTP CONNECT、共享 SSH `direct-tcpip`、严格 host-key | 三种 egress 的真实服务器兼容矩阵；稳定 SOCKS5 UDP；从系统流量进入这些连接器的数据面 |
| 生命周期 | `CaptureAdapter`、持久化 coordinator、WAL recovery journal、helper heartbeat、guarded exit | 产品 orchestrator 尚未挂接已安装平台 adapter；真实系统残留恢复尚未在平台实验室闭环 |
| Linux 特权侧 | cgroup v2 + nftables + fwmark/TUN 事务、root helper、SO_PEERCRED、可执行文件 SHA-256 pin、HMAC、root receipt、回滚测试 | 产品侧 helper launcher/client、TUN 读写与 userspace TCP/IP 数据面、polkit/package、真实 root smoke |
| Windows | 禁用模板、Authenticode/SignTool/driver package fail-closed verifier；已冻结 Wintun global + WinDivert app/PID | Wintun/global 与 WinDivert app/PID 实现；固定官方签名 WinDivert artifact/许可证；真实签名 helper/driver 和安装包 |
| macOS | release-only Tauri overlay、Info.plist/entitlement 合同、codesign/provisioning/notarization verifier | Apple capability、Xcode System Extension/Network Extension target、Swift provider、Rust bridge、真实签名/公证包 |
| UI/native | 独立窗口、配置/恢复 UI、Linux native hide/reopen smoke | 三平台托盘、权限、helper/provider、退出和恢复 native/system smoke |
| 性能/长稳 | release-profile core quick、100 synthetic cycles、固定阈值、24h/platform receipt verifier | 24h core receipt；三平台真实捕获延迟/吞吐/泄漏/100-cycle/24h/安装证据 |

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
| 三平台发布 Gate | `.github/workflows/release.yml`、`scripts/sockscap`、`src-tauri/platform/sockscap` | source contracts/verifiers 已落地；后续接入真实 Windows service/driver、macOS provider 与 Linux helper package artifact |

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
- Linux 的 cleanup 思路已扩展为 Taomni 独立 helper、root receipt、recovery journal 和下次启动修复；仍需产品 launcher/client 与真实 kill/断电平台证据。
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
- IP stack 必须通过 trait 隔离，固定精确版本/提交，必要时 vendor；所有 queue/admission 有界，并覆盖 fuzz、IPv4/IPv6、Virtual DNS、UDP 降级、取消、半关闭/RST、性能与 24h Gate。
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
| 全局新连接 | Wintun/TUN | NETransparentProxyProvider 或受控 TUN | TUN |
| 指定程序 | WinDivert SOCKET/FLOW/NETWORK | audit token + code signing identity | cgroup v2 + nft/fwmark；managed launch netns |
| 指定运行中 PID | 目标支持，新连接生效 | 目标支持，新连接生效 | 条件支持；cgroup v2/eBPF，新连接生效 |
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
  └─> S1 实现 Packet/Stream 双入口数据面与身份合同
       └─> S2 将真实 adapter/runtime 接入 orchestrator + recovery
            ├─> L1 Linux launcher/client/TUN + package
            ├─> W1 Windows Wintun + WinDivert + signed service/official drivers
            └─> M1 macOS NE provider + Rust/Swift bridge + entitlement
                 └─> P1 各平台 native/package/性能/泄漏/24h 证据
                      └─> 三平台 stable
```

S0、S1、S2 是三个系统共同的阻塞链。平台团队可以并行做 spike、签名账号准备和安装器，但在共享数据面没有闭环前，任何 adapter 都只能证明“捕获到了”，不能证明流量已经按 Routing Profile 通过生产 egress。

#### 13.0.3 共享代码工作包

| ID | 代码工作 | 主要落点 | 验收条件 |
|---|---|---|---|
| S0-DATA-ADR（已冻结） | Taomni 拥有 `FlowRuntime`；PacketIngress 使用固定/审计的可替换 IP-stack adapter；tun2proxy 仅为参考/oracle | `sockscap-phase0-adr.md`；实现时固定 `Cargo.lock` 与 NOTICE/SBOM | 按 flow 调用 Taomni `PolicyEngine` 和四种 egress；精确依赖版本、有界 queue、fuzz、IPv4/IPv6、Virtual DNS、UDP、取消、统计、性能和 24h 证据仍是实现 Gate |
| S0-WIN-ADR（已冻结） | global=Wintun/TUN；app/PID=WinDivert SOCKET/FLOW/NETWORK；不实现第一方 WFP | `sockscap-phase0-adr.md`；固定官方签名 WinDivert 版本/变体/签名人/SHA-256 | 完成许可证、身份 race、回注、双捕获、IPv6、EDR/VPN、安装/卸载 Gate；任一硬 Gate 失败则 app/PID capability 保持禁用，不回退 WFP |
| S1-INGRESS | 增加统一 `FlowIngress`，至少包含 `PacketIngress`（Linux TUN、Windows Wintun/WinDivert PacketDevice）与 `StreamIngress`（macOS NE）；统一生成 `FlowContext` | 建议新增 `sockscap/capture/packet_device.rs`、`flow/ingress.rs`、`flow/runtime.rs` | 同一 matcher/connector 测试可分别由内存 L3 packet 和已解码 TCP stream 驱动；无平台规则复制到 provider/helper |
| S1-IDENTITY | 定义不可丢失的身份合同：profile selector、PID + start token、app signing identity、五元组、generation；显式解决 simultaneous global + app profiles 的优先级 | `CaptureInstallSpec`/`CaptureArtifactState` 扩展；平台 tuple/profile side channel | 不能在 packet 已进 TUN 后用不可靠的 `/proc`/进程扫描猜 PID。Windows/macOS 直接携带 native metadata；Linux 首版采用可证明的 tuple→profile side channel，或由单一 adapter 管理按 profile 隔离的逻辑 TUN/queue |
| S1-TCP | 把 L3 TCP 重组/状态机或已解码 stream 接到现有 DIRECT/SOCKS5/HTTP/SSH connectors；实现半关闭、RST、超时、取消和 backpressure | `flow/runtime.rs`、现有 `flow/connectors.rs`/`engine.rs` | 内存 packet tests 覆盖 SYN→数据→FIN/RST、慢读写、取消和连接器失败；payload 不进入日志/DB/UI |
| S1-DNS-UDP | 冻结 DNS/Fake-IP/hostname attribution；实现 UDP policy，SOCKS5 UDP 通过前保持显式 BLOCK/DIRECT | `flow/attribution.rs`、DNS/UDP runtime 模块 | IPv4/IPv6 使用同一策略；DoH/ECH 为 unknown 而非伪造域名；HTTP CONNECT/SSH 不把 UDP 标成已代理 |
| S1-GATEWAY | 为 macOS provider 提供 authenticated loopback data gateway；控制面与数据面分离，协议带 version/generation/flow id/长度上限 | 建议新增 `capture/gateway_protocol.rs` 与本地 listener | 只监听 loopback/受控 IPC；peer identity、消息大小、flow 并发、超时、重复 flow id、旧 generation、主进程消失均 fail closed/fail open 符合策略；无 secret 进入 argv/log |
| S1-BYPASS | 将 Taomni、helper/provider、TUN runtime、Proxy/SSH endpoints、DNS resolver 和 loopback 构造成动态硬旁路快照 | `flow/bypass.rs` + adapter update | 每次上游重解析/重连原子更新；无捕获递归；旁路变更失败不发布新 Active generation |
| S2-RUNTIME | 实现 `PlatformAdapterFactory`/runtime handle，将真实 adapter、数据面任务、heartbeat 和 coordinator 组合到 `SockscapEngine::start/stop/recover` | `capture/runtime.rs`、`orchestrator.rs`、`commands.rs` | start 顺序固定为 upstream ready → data plane ready → helper/provider prepare → capture activate → live self-test → Active；任一步失败完整回滚 |
| S2-CAP | 拆分“源码已编译”“artifact 已安装”“签名/entitlement 已验证”“data plane ready”“scope 可用” | `capabilities.rs`/TS contract/UI | 只有 installed probe + real data plane self-test 通过才设置该主机 `can_start_*`；Debug、模板、synthetic receipt 永远不能解锁 |
| S2-RECOVERY | 让 recovery journal 同时记录平台 artifact 与 data-plane generation；恢复先撤销系统规则，再关闭本地 gateway/runtime | coordinator/store/platform adapter | main/helper/provider 在 prepare、activate、Active、stop 的每个注入点死亡均能在本次或下次启动恢复；缺 receipt 时拒绝猜测性清理并显示人工恢复步骤 |

共享数据面必须先用**内存 PacketDevice/StreamIngress**完成确定性测试，再接触真实系统路由。这样平台测试失败时可以区分“捕获/身份问题”和“TCP/IP/egress 问题”。

#### 13.0.4 Linux 接通工作包

当前 Linux 只完成 privileged mutation/server 侧，以下均为剩余工作：

| ID | 代码/打包任务 | 验证出口 |
|---|---|---|
| L1-CLIENT | 实现 `LinuxCaptureAdapter` client：读取 root-owned installed policy，固定绝对路径启动 helper，连接 `/run/taomni` socket，验证 root peer SHA-256，完成 HMAC bootstrap 与 prepare/activate/update/heartbeat/stop/recover | 非 root 调用、错误 UID/PID/hash、符号链接 policy、旧 generation、重放/篡改消息全部拒绝；正常 client 与 fake helper 的集成测试通过 |
| L1-POLKIT | 安装命名 polkit action，`org.freedesktop.policykit.exec.path` 只指向固定 helper；禁止 shell、任意 executable/argv 和宽泛 retained authorization；helper 继续独立验证所有字段 | 有/无桌面 authentication agent、用户取消、错误密码、无授权、重复授权、headless 环境都有明确状态；取消不留下 socket/cgroup/TUN/nft |
| L1-TUN | unprivileged runtime 打开 helper 创建并归属给当前 UID 的持久 TUN，使用 `TUNSETIFF/IFF_TUN/IFF_NO_PI`（或审计后的库），向 helper 回报真实 PID/start token/FD readiness，然后把 packet 交给 S1 数据面 | 真实 IPv4/IPv6 echo/HTTP；MTU、fragment、checksum、RST、并发、runtime 死亡；helper 不能把自身误认作 runtime |
| L1-SCOPE | 完成 global、application group、running PID 与 include-children；保留 PID/start-token 和原 cgroup，处理进程退出/PID 重用；明确多 profile 身份传递 | 选中/未选中进程同时发流；未选流不进入数据面；global + 两个 app profile 同时运行且分别使用不同 egress；停止后逐一恢复原 cgroup |
| L1-NETNS | 为不允许移动既有进程或缺 cgroup socket match 的环境实现“由 Taomni 启动”的 managed user/network namespace fallback；不把它伪装成 running-PID attach | managed child/children、退出、kill、namespace 清理；能力报告解释降级原因 |
| L1-PACKAGE | 冻结支持的 distro/kernel/systemd/cgroup/nft/iproute2/resolved/NetworkManager 矩阵；为 deb/rpm 安装 helper、policy、polkit action 和卸载恢复；决定 AppImage 是否只做 UI/非 capture 或配套 installer | 包签名/来源验证、root owner/mode/hash、安装升级回滚卸载；卸载后无 `/run/taomni`、nft table、ip rule/route、TUN、cgroup 或 policy 残留 |

Linux privileged 测试必须在一次性 VM 或 network namespace fixture 中运行，禁止在共享开发机默认路由上直接做破坏性 CI。最低真实矩阵需覆盖：支持矩阵中的每个 distro、cgroup v2 原生/不满足、systemd-resolved 与 NetworkManager 组合、IPv6 开/关、Wi-Fi/有线切换、至少一个常见 VPN。

#### 13.0.5 Windows 接通工作包

S0-WIN-ADR 已收敛为 Wintun global + WinDivert app/PID。当前工作包不包含第一方 WFP callout：

| ID | 代码/打包任务 | 验证出口 |
|---|---|---|
| W1-GLOBAL | 封装官方 Wintun distribution：adapter create/open、session ring read/write、MTU、route/DNS、close/delete；将 L3 packet 接到 S1 PacketIngress | x64/arm64（按 ADR 范围）、IPv4/IPv6、ring pressure、adapter 已存在、重启、名称冲突、Wintun DLL/driver 缺失或 hash/signature 错误 |
| W1-SELECTED | 实现 WinDivert SOCKET/FLOW tuple→PID/start token cache、NETWORK capture/reinject、动态 filter 和 race 处理；固定官方签名 driver 版本/变体/签名人/SHA-256，不修改 driver | app/PID/children/new-connections；PID 重用；TCP simultaneous open/close；IPv6；高并发；未选 flow 不被延迟；global + selected 不双捕获、不丢 identity；驱动与 release manifest 严格一致 |
| W1-HELPER | 将 privileged boundary 做成签名 Windows service/helper，以 ACL 收紧的 named pipe 与主进程握手；验证调用方 Authenticode publisher、PID/start token、协议 version/generation | 普通用户/UAC 拒绝、错误 signer、旧 client、service crash/restart、主进程 crash；凭据和任意命令永不进入 service protocol |
| W1-BYPASS | 在捕获层排除 Taomni/helper/service、Wintun/WinDivert 自身流量和所有动态 upstream endpoints；验证 reinjection 不再次命中 | 连接计数无递归增长；Defender/EDR/VPN 同时启用时无 packet loop；本机/LAN policy 与设计一致 |
| W1-INSTALL | 生成 MSI/NSIS 所需 service/driver/DLL 安装与回滚；应用/helper/service 使用 timestamped Authenticode；Wintun/WinDivert 仅包含经许可审核、hash-pinned 的官方生产签名 artifact | Secure Boot 开启的干净 Windows；`signtool /pa` 与 `/kp`、publisher、timestamp、hash 全通过；驱动 signer/hash 与 manifest 一致；不接受 test signing、自编译/修改驱动或禁用 Secure Boot 的证据 |
| W1-UPDATE | 设计 driver/provider 版本共存与原子升级：先停 capture/清理，再升级 service/driver，失败回滚；卸载先恢复网络再删除 artifact | 安装→升级→降级拒绝/回滚→卸载、重启中断、占用文件、pending reboot；无 service/filter/adapter/route/DNS 残留 |

Windows 功能实验室至少覆盖：最终支持的 Windows 版本、x64/arm64 范围、Secure Boot、Defender、企业 EDR 样本、常见 VPN、Wi-Fi/有线、睡眠/唤醒。WinDivert 必须完成 LGPL/GPL 分发合规和随包 LICENSE/NOTICE，或经审批的商业许可；安装包不得包含自编译、patched 或 test-signed WinDivert driver。由于当前不具备 EV/Hardware Developer Program 条件，第一方 WFP 不是本阶段 fallback。

#### 13.0.6 macOS 接通工作包

macOS 分为 Apple 账号外部输入、Xcode native target 和 Taomni 集成三条线，缺一不可：

| ID | 代码/外部任务 | 验证出口 |
|---|---|---|
| M0-ACCOUNT | 由 Account Holder 为明确 App ID/Provider ID 启用或申请 Network Extension/System Extension 能力；准备 Developer ID Application 证书、匹配 team ID 和 provisioning profiles | `security cms -D` 显示 app/provider profile 含所需 team/bundle/entitlement；未获批准时 release 保持 blocked，不能用手写 plist 替代 |
| M1-XCODE | 在真实 Xcode 工程新增容器 app 配套的 System Extension + `NETransparentProxyProvider` target，bundle ID/Info.plist/principal class 与 Tauri overlay 一致；provider 启动 system-extension mode | Intel/Apple Silicon 构建；extension 嵌入约定 bundle 路径；Debug 与 Developer ID release provisioning 分离 |
| M1-ENTITLEMENT | 容器 app 签入 `com.apple.developer.system-extension.install` 和 `app-proxy-provider-systemextension`；provider 签入匹配 Network Extension entitlement 与 team/application-group identity | 对最终 `.app` 和 provider 的 `codesign -d --entitlements :-` 验证，而不是只 lint 源 plist；Gatekeeper 与 provisioning verifier 通过 |
| M1-ACTIVATE | Rust/Tauri 调 Swift bridge 发出 `OSSystemExtensionRequest` activation/deactivation，处理用户批准、reboot/replacement、拒绝和版本升级；再通过 `NETransparentProxyManager` 安装/启停配置 | 首次批准、取消、拒绝、已激活、版本相同/更新、停用、卸载；每个状态可见且不把未批准显示为 Active |
| M1-PROVIDER | 实现 `handleNewFlow`/UDP flow：从 `sourceAppAuditToken`/signing identifier 得到 PID/app identity，先做 hard bypass/profile selection；未选 flow 返回 direct，选中 flow 通过 S1 authenticated gateway 转发 | 选中与未选应用并行；PID/start identity、children/new connection；provider/Taomni/upstream 自绕过；TCP half-close/RST；UDP policy；主 app 消失后 fail-open/停止配置 |
| M1-BRIDGE | 控制协议带 version、generation、原子配置、heartbeat、receipt；数据协议复用 S1 gateway，限制 flow/bytes/queue；验证 peer code-signing identity，不仅依赖固定 socket 路径 | 伪造 client、旧 generation、超大帧、连接洪泛、provider/app restart、sleep/wake、NIC/VPN change；无未认证配置或流量注入 |
| M1-SIGN | 通过 release-only Tauri overlay 嵌入 extension，按内到外顺序签名，生成 Developer ID 包，notary submission + staple；不改变普通 preview entitlement | `codesign --verify --deep --strict`、`spctl --assess`、`stapler validate`、架构和 source/signed entitlement verifier 全通过 |
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
5. **发布 Gate**：真实 100-cycle、TCP 建连开销、1 Gbps 基线吞吐、DNS/IPv4/IPv6/UDP leak audit、kill/restart/sleep/NIC/VPN、24h core + 24h actual capture soak。

每个测试必须同时验证**正向路径和未命中路径**。只证明“选中应用能联网”不够，还要证明未选应用没有进入 Sockscap、BLOCK 没有泄漏、DIRECT 没有绕回 proxy、helper/provider/upstream 没有自捕获。

#### 13.0.8 证据与 CI/实验室分工

- 普通 CI 运行 Rust/Vitest/contract、verifier self-tests、模板 lint 和 optimized core quick；不得申请 root、安装驱动或伪造平台签名。
- 平台 self-hosted lab 运行 native/system/package tests。每次 run 固定完整 commit、OS/architecture、host ID、artifact hashes、开始/结束时间和原始日志。
- Windows/macOS `artifactGate` 必须是同机真实 verifier 的最终 PASS JSON，lint JSON 会被拒绝；Linux packaging pipeline 必须输出 architecture/provider、app/helper/policy 路径、包签名和 owner/mode/policy 验证 receipt。
- `nativeSmoke` 必须是 native-mode `qa-ui-auto.summary.v1`，包含 `TC-SOCKSCAP-native-window-smoke`；还需增加平台权限/托盘/恢复 cases，现有 window case 不能替代 packet capture。
- `coreQuick` 和 `coreSoak` 必须由同一 commit、同一 platform/arch 的 optimized `sockscap-gate` 生成；24h minimum 固定 86,400 秒。
- actual capture 的 scope/egress/performance/recovery/leak/install 原始证据全部放进同一 evidence directory，逐文件 SHA-256 pin；最后由 `performance-release-manifest` 在相同 OS 上验证。

#### 13.0.9 里程碑与绿灯顺序

| Milestone | 输出 | 绿灯条件 |
|---|---|---|
| M0 — 决策冻结 | data-plane ADR + Windows provider ADR + 最低平台/发行版矩阵 | 决策包含版本、许可证、维护者、降级策略、包结构和回退方案 |
| M1 — 共享数据面 | Packet/Stream ingress、identity contract、production FlowRuntime、orchestrator runtime | 内存协议矩阵全绿；synthetic adapter 仍标记非 release evidence |
| M2 — Linux functional | 已安装 helper client/polkit/TUN/runtime + global/app/PID vertical slice | 真实 root/VM smoke、三 egress、IPv4/IPv6/DNS、kill cleanup 通过；Linux `can_start_*` 才可按 probe 解锁 |
| M3 — Windows Beta | 落地已冻结 Wintun global + WinDivert app/PID、signed service、官方驱动 artifact 与 installer | Windows 全矩阵、签名、许可、身份 race、EDR/VPN、100-cycle、24h 和安装卸载清理通过 |
| M4 — macOS functional/release | approved capability、signed/notarized app + provider、activation/bridge | Apple Silicon/Intel 范围内全矩阵、批准/拒绝、升级/卸载、24h 通过 |
| M5 — Cross-platform stable | 三份同 commit 或正式 release commit 的 platform PASS manifests | 三个平台均 release connected；全局 QA Gate 无新增/未豁免回归；发布台账全部关闭 |

正式发布顺序仍遵从已确认决策：Windows 可先 Beta，三平台全部通过后才能称“跨平台稳定”。工程上 Linux 是当前最快的数据面反馈通道；这不改变 Windows Beta 的发布口径，也不允许跳过已冻结 Windows 选型的真实 artifact/兼容 Gate。

### Phase 0：三平台能力与许可证 Gate

当前状态：**BLOCKED（选型已冻结，实现/发布证据未完成）**。策略、生命周期、source release gate、Linux privileged transaction 和 helper 认证底座已经落地；共享数据面已冻结为 Taomni `FlowRuntime` + 受控 IP-stack adapter，Windows 已冻结为 Wintun global + WinDivert app/PID。但这些实现、三平台真实 vertical slice、真实签名/entitlement 和平台恢复证据均不存在。详细缺口见 13.0 的 `S1-*` 与平台工作包。

目标：冻结最危险且会改变架构/交付方式的决策，不再以 UI 进度代替平台可行性。

- 以 `wsstun` commit `8282eb2` 为行为参考基线验证 RoutePlan、PacketDevice、WinDivert 身份关联和 cleanup；tun2proxy 只作为差分测试 oracle，不进入产品运行时。
- 落地已冻结 `S0-DATA-ADR`：固定/审计 IP-stack 依赖，实现有界 PacketIngress/FlowRuntime，证明 per-flow 身份、四种 action/egress、Virtual DNS、IPv4/IPv6、UDP 降级、取消、统计、fuzz、性能与 24h 资源边界。
- 落地已冻结 `S0-WIN-ADR`：实现 Wintun global + WinDivert SOCKET/FLOW/NETWORK app/PID；验证应用/PID、回注正确性、本机 loop bypass、许可证、官方驱动签名/hash、EDR/VPN 与卸载恢复。当前无第一方 WFP fallback。
- macOS：取得 Apple-managed capability，并用最小 system extension/provider 捕获 TCP/UDP、读取 audit token；选中应用进入受认证数据网关，未选应用 direct。
- Linux：在已落地 cgroup v2 + nft socket cgroup + fwmark/TUN transaction 上补产品 client/TUN pump，验证 running PID 新连接、global + 多 app profiles 与不支持环境的降级。
- SSH：基于已落地的共享 `SshChannelPool`/严格 host-key 核心，补真实密码/私钥/Agent、remote DNS、断线重连、MFA 与 TCP echo 证据。
- 验证与主流 VPN、系统代理、休眠/唤醒、网卡切换的冲突。
- 输出 ADR：捕获技术、第三方版本/许可证、最低系统版本、打包方式。

退出标准：已冻结的 `S0-DATA-ADR` 与 `S0-WIN-ADR` 均落地且通过各自硬 Gate；三平台至少完成 TCP 到本地 echo/HTTP server 的 global + selected app 垂直切片；SOCKS5、HTTP CONNECT、SSH Jump 三种 egress 都通过可重复测试；停止或强制终止主进程/privileged component 后网络恢复；没有未解释的 DNS/IPv6/UDP 泄漏。任一平台失败则回到范围或架构评审，不得解锁对应平台 capability。

### Phase 1：纯 Rust 配置、规则与策略核心

当前状态：**PASS（软件范围）**。Profile、冲突检测、GFWList 投影/exception、不可变 matcher、test target 解释与 last-good 行为已有测试；镜像在线可用性仍是发布时运行门。

- Profile、selector、`egress_kind/egress_ref_id`、rule source 模型和 schema migration。
- AutoProxy/GFWList Base64 解码、域名投影、exception、IDNA、CIDR、unsupported 报告。
- 不可变 matcher snapshot、冲突检测、test_target 判定解释。
- last-good 下载器和官方镜像回退。
- 单元/属性测试，不接触系统路由。

退出标准：固定 GFWList 样例、自定义规则和异常输入全部有确定结果；规则更新失败不会破坏当前快照。

### Phase 2：FlowEngine 与上游转发

当前状态：**PARTIAL**。DIRECT、SOCKS5 TCP、HTTP CONNECT、共享 SSH `direct-tcpip`、严格 host-key、取消/统计边界已经落地；尚缺 `S1-*` 生产 packet/stream 数据面、DNS/UDP 闭环和三类真实服务器完整矩阵。

- TCP DIRECT、SOCKS5、HTTP CONNECT、SSH Jump `direct-tcpip`。
- 从现有 Tunnel/SSH 模块抽取共享 `SshChannelPool`，补 known_hosts/指纹确认、keepalive、channel 限流、重连和 MFA 状态机。
- Vault 解析、连接测试、超时、取消、上游环路硬绕过。
- DNS/Fake-IP、hostname attribution 和 unknown policy。
- 统计事件，不落 payload。
- SOCKS5 UDP spike；HTTP CONNECT 与 SSH Jump 的 UDP policy 明确降级。

退出标准：本地可重复的 Proxy/SSH 测试服务器覆盖认证成功/失败、host-key 首次信任与变化、断线、DNS、IPv4/IPv6、channel 并发、取消和重连。

### Phase 3：持久化、IPC 与浏览器 Stub

当前状态：**PASS（软件范围）**。SQLite/WAL、recovery journal、IPC/Stub、helper heartbeat/receipt 与合成恢复测试已落地；已安装平台 artifact 的恢复证据归入 Phase 5–8。

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

当前状态：**BLOCKED**。只有 fail-closed manifest、Authenticode/driver-package verifier 与已冻结的 Wintun/WinDivert provider contract；没有真实 adapter、service/driver 或签名安装包。

- 按已冻结 `S0-WIN-ADR` 和 13.0.5 的 `W1-GLOBAL` 至 `W1-UPDATE` 落地 Wintun global + WinDivert app/PID。
- 将应用/PID/子进程/new-connections 身份接到共享 FlowRuntime；关闭 WinDivert ownership race、动态五元组 filter、packet reinjection、双捕获与许可证问题。
- 交付 timestamped Authenticode app/helper/service，以及经许可审核、未修改、hash-pinned 的官方生产签名 Wintun/WinDivert artifact；完成 Secure Boot、管理员提示、EDR/VPN 与安装/升级/回滚/卸载验证。
- 本阶段不交付第一方 WFP callout；若 WinDivert 任一硬 Gate 失败，发布包保持 `can_start_app_group=false`/`can_attach_pid=false`，不用未签名或 test-signed driver 绕过。

退出标准：全局、程序组、运行 PID、三种 egress、GFWList、托盘、Dashboard 全链路；同机 artifact gate 与 13.0.7 全矩阵通过；重启、崩溃和更新不遗留 Wintun/WinDivert/service/route/DNS 状态。只有此时 Windows Beta 可发布。

### Phase 6：macOS 纵向完成

当前状态：**BLOCKED**。已有 release-only Tauri overlay、source plist/entitlement 合同与 fail-closed verifier；没有 Apple-approved capability、Xcode native target、Swift provider、Rust bridge 或已签名/公证 artifact。

- 依次完成 13.0.6 的 `M0-ACCOUNT`、`M1-XCODE`、`M1-ENTITLEMENT`、`M1-ACTIVATE`、`M1-PROVIDER`、`M1-BRIDGE`、`M1-SIGN` 与 `M1-UNINSTALL`。
- entitlement 必须来自匹配的 capability/provisioning profile，并在最终 app/provider 上验证；源码 plist 或 Linux lint 不能替代。
- 用 audit token/signing identity 绑定 app/PID/profile；provider 和 Taomni 之间使用受认证、版本化且有界的 control/data bridge，provider/主程序/upstream 全部硬绕过。
- 在支持范围内同时构建、签名并验证 Apple Silicon 与 Intel。

退出标准：Developer ID 下载包通过签名、provisioning、Gatekeeper、notarization/staple 与同机 artifact gate；全局、程序组、运行 PID 的新连接路由可验证；批准/拒绝/替换/升级状态清晰；卸载不遗留 system extension 或 Network Extension 配置；13.0.7 全矩阵通过。

### Phase 7：Linux 纵向完成

当前状态：**PARTIAL**。真实 cgroup-v2/nft/fwmark/TUN transaction、root-only helper、SO_PEERCRED/executable hash/HMAC、两阶段激活、root receipt 与回滚测试已落地；产品 launcher/client、packet pump、polkit/package 和真实 root capture 尚缺。

- 完成 13.0.4 的 `L1-CLIENT` 至 `L1-PACKAGE`，并通过 `S1-*`/`S2-*` 接入产品 lifecycle。
- 保持最小权限：固定 helper/polkit action、独立字段验证、无任意 shell/argv；helper 创建系统 artifact，unprivileged runtime 持有数据面。
- 在一次性 VM/fixture 中验证 cgroup v2/nft/fwmark/TUN、managed-launch namespace fallback、systemd-resolved、NetworkManager、IPv6 和支持发行版；仅在基线被证实不可行时另开 ADR 评估 eBPF。
- 明确 AppImage/deb/rpm 能力与卸载策略；未安装受信 helper/policy 的便携包不得宣称 capture 可用。

退出标准：支持矩阵内发行版完成 global、application group、running PID/new-connections 与多 profile；能力降级可解释；真实 package gate 与 13.0.7 全矩阵通过；停止、kill、重启、升级、卸载后无 socket/TUN/nft/ip rule/route/cgroup/DNS/policy 残留。

### Phase 8：托盘、可靠性、QA 与发布 Gate

当前状态：**PARTIAL**。native tray/guarded exit 代码、recovery UI、Linux native window smoke、fixed core/per-platform verifier 与 100 synthetic lifecycle cycles 已落地；真实托盘/system smoke、actual capture、24h、性能/泄漏和三平台 package evidence 尚缺。

- 完成并验证已落地 Tauri tray 的动态状态、菜单、错误回显和 guarded exit；禁止 tray Start 绕过 runtime capability probe。
- Windows/macOS 验证左键切换，Linux 验证菜单兜底；三平台都覆盖窗口隐藏、重开与状态保持。
- 睡眠/唤醒、网卡切换、代理不可用、SSH 断线/host-key 变化/MFA 等待、Vault 锁定、规则更新失败、进程退出。
- 扩充 feature-list/YAML；三平台 native smoke 覆盖独立窗口、托盘、权限拒绝/批准、Active 退出、恢复网络与 system component 状态。
- 按 13.0.7–13.0.8 生成三平台长稳、性能、泄漏、恢复、安装/升级/卸载的 hash-pinned evidence；修复或明确豁免全局 QA Gate 的既有基线问题。

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
| 恢复 | kill main、kill helper/provider、restart、sleep/wake、NIC switch、VPN coexistence 全部 PASS |
| 泄漏 | DNS、IPv4、IPv6、UDP audit 全部 PASS；TCP-only egress 的 UDP BLOCK/DIRECT 必须与 profile 声明一致 |
| 证据 | artifact gate、native smoke、core quick、core soak 与至少 4 个 raw evidence 文件逐一 SHA-256 pin；manifest 只能在匹配 OS 上验证 |

除固定 verifier 外，仍需做 1,000 活动连接下 Dashboard IPC ≤2 次/秒、rule snapshot/统计落盘不阻塞转发热路径的 profiling；结果作为 raw evidence 保存。若硬件无法达到 direct 基线，结论应是实验室不合格，而不是下调产品阈值。

### 14.5 UI、native 与 package QA

- 新 feature-list 条目覆盖 Dashboard、Profiles、Rules、process picker、capability warnings 和 recovery。
- Vitest 测纯 UI、状态和 stub；qa-ui-auto 覆盖 browser mode。
- 独立窗口、托盘、权限弹窗、真实 helper/provider 状态和恢复只能用 Tauri/native smoke 验证，不能只靠 jsdom、browser stub 或 dry-run 宣称完成。
- `nativeSmoke` 必须是 native-mode `qa-ui-auto.summary.v1`，至少包含通过的 `TC-SOCKSCAP-native-window-smoke`；发布前还必须加入平台权限、托盘、Active 退出与网络恢复 cases。
- Windows/macOS `artifactGate` 必须使用同机最终签名 artifact verifier 的 PASS JSON；Linux 必须提供等价的包签名、architecture/provider、installed path、root owner/mode/helper-policy receipt。源码合同 lint 永远不是 artifact PASS。

### 14.6 当前证据缺口

- 已通过：Sockscap focused Rust 163/163、frontend 67/67、TypeScript/Vite build、catalog/lint、Linux native window smoke、10,000-rule quick 与 100 synthetic lifecycle cycles。
- 仅执行证明：约 3.2 秒短 soak；它不能充当 24h receipt。
- 尚未运行：三平台真实 capture/egress/leak/performance/100-cycle/24h、真实 tray/system smoke、签名 package 安装/升级/卸载矩阵。
- 全局 QA audit 仍受既有非 Sockscap baseline 问题影响；M5 前必须修复或由正式、可追踪的豁免机制处理，不能用 focused coverage 隐去。

## 15. 主要风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows Wintun/WinDivert 签名、许可与兼容性 | 官方驱动不能合规分发、第三方 signer 不被接受、身份 race/性能不足或触发安全软件 | 固定未修改官方签名 artifact 及 hash；完成 LICENSE/NOTICE 或商业许可、EDR/VPN/回注/双捕获 Gate；失败则禁用 app/PID capability，当前无 WFP fallback |
| macOS entitlement/system extension | 没有资格即无法交付 | 先申请 entitlement，再做完整 UI；保留 capability gate |
| Linux 发行版与内核差异 | PID 模式不一致 | 明确最低矩阵；eBPF/cgroup 探测；netns fallback |
| GFWList 是 URL 规则而产品只做域名路由 | 语义不完全等价 | 域名投影、unsupported 报告、test target，不做虚假全兼容 |
| DoH/ECH 隐藏域名 | GFW 模式漏命中 | hostname_source、unknown policy、严格模式和告警 |
| HTTP CONNECT 不支持 UDP | QUIC/WebRTC 泄漏或失败 | 显式 direct/block；推荐 block 促 TCP fallback |
| SSH `direct-tcpip` 不支持 UDP | QUIC/WebRTC 泄漏或失败 | SSH profile 默认 BLOCK UDP，可改 DIRECT；UI 明确 TCP-only |
| SSH host key 被替换或当前校验过宽 | 中间人风险 | 发布前完成 known_hosts/指纹确认；变更立即阻断并要求人工复核 |
| SSH 单控制连接中断 | 大量 channel 同时结束 | 有界连接池、keepalive、退避重连、Degraded/UserActionRequired 与可选 fail-open |
| VPN/防火墙/EDR 冲突 | 断网或重复捕获 | 单一捕获面、能力诊断、fail-open、兼容矩阵 |
| 崩溃遗留系统规则 | 系统断网 | helper heartbeat、recovery marker、启动修复、一键恢复 |
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
17. 运行进程：默认只匹配所选 PID，可显式包含后续子进程；保存 PID 与 process_start_time 防止 PID 重用。“记住这个进程”转换成程序身份规则，不持久化短生命周期 PID。

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

27. 共享数据面：Taomni 拥有 `FlowRuntime`、逐流身份/策略/egress、取消、统计、背压与生命周期；PacketIngress 通过固定并审计的可替换 IP-stack adapter 得到 TCP/UDP flow，不从零实现 TCP/IP。tun2proxy 仅用于行为参考和差分测试，不是产品运行时依赖，不维护长期 fork。

## 17. Definition of Done

“代码合并”“功能接通”“可发布接通”和“三平台 stable”是四个不同状态。只有同时满足下列项目才能关闭本计划：

- Windows、macOS、支持矩阵内 Linux 均从正式安装包运行一个真实捕获面，并支持 global、application group 和平台承诺的 running PID/new-connections；降级有明确 capability reason。
- 多个配置组按冻结优先级共用单一捕获面；global + 至少两个 app profiles 并行时身份不丢失，不出现多个 TUN/provider/filter 争抢或重复捕获。
- DIRECT、SOCKS5、HTTP CONNECT 与 SSH Jump TCP 通过可重复真实服务器矩阵；SOCKS5 UDP 达到稳定版 Gate；SSH host-key 变化立即阻断。
- GFWList 更新、镜像回退、exception、manual rule 和 test target 可解释；DNS/IPv4/IPv6/UDP/unknown 不静默泄漏，Dashboard 显示实际降级。
- Taomni、helper/provider、data runtime、loopback 和动态 upstream endpoints 永不递归捕获；bypass 更新失败不会发布半配置 generation。
- stop、主进程/helper/provider crash、restart、sleep/wake、NIC/VPN change、upgrade、rollback、uninstall 后无系统网络 artifact 残留，且一键恢复不依赖上游可用。
- Windows 最终 service/driver/package、macOS app/provider 与 Linux helper/package 均通过本机签名/entitlement/owner-policy verifier；不依赖 test signing、开发者模式、关闭 Secure Boot/SIP 或手工 root 命令。
- Vault 外没有 Proxy/SSH 明文 secret；argv、IPC error、日志、DB、统计和 evidence 不含 payload、完整 URL、密码、私钥路径或 MFA 回答。
- Rust、Vitest、contracts、qa-ui-auto、三平台 native/system smoke、真实功能矩阵与 14.3–14.5 Gate 全部通过；三份 platform PASS manifests 对应同一正式 release commit，原始证据 hash-pinned。
- 只有本机 installed probe、artifact verification、data-plane self-test 与 scope probe 全部通过，才可把对应 `can_start_global`/`can_start_app_group`/`can_attach_pid` 置为 true；`capture_implemented` 只表示该平台生产代码进入构建，不能单独解锁启动。
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
