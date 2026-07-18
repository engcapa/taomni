# Taomni 跨平台 Sockscap 设计与实施计划

状态：Draft for review — Revision 2  
日期：2026-07-18  
本轮范围：仅设计与原型，不修改业务代码、依赖、构建或测试配置。

HTML 评审入口：[原型总览 / Dashboard](./sockscap-prototype/index.html) · [目标架构](./sockscap-prototype/architecture.html) · [配置组编辑器](./sockscap-prototype/profile-editor.html) · [规则与生命周期](./sockscap-prototype/rules-lifecycle.html)

## 1. 结论先行

建议把该能力命名为 “Sockscap（暂名）”，作为 Taomni 的独立网络流量路由模块，而不是扩展现有的 “Application Proxy” 开关。

核心设计是：

1. 系统只运行一个流量拦截平面，由它统一接收新建网络流。
2. 用户可以配置多个“路由配置组（Routing Profile）”；每组绑定程序、临时进程、上游 Proxy/SSH 会话和域名规则源。
3. 按配置组优先级选择策略，再按规则决定 PROXY、DIRECT 或 BLOCK。
4. 复用现有 Proxy、SSH Session、Dynamic SSH Tunnel 和 Vault，不建立第二套明文凭据。
5. 使用独立 Sockscap 窗口和系统托盘；关闭窗口只隐藏，明确退出时才停止引擎并恢复系统网络状态。
6. 不做 TLS 中间人解密，不保存请求正文或完整 URL。HTTPS 仅根据应用身份、远端主机名、DNS 映射、TLS SNI 或目标 IP 路由。

技术上可实现，但必须先经过 Phase 0 三平台能力门。最难的不是 HTTP CONNECT、SOCKS5 或 SSH `direct-tcpip` 转发，而是三平台的系统级拦截、权限、驱动/系统扩展签名、进程身份归属、DNS 泄漏与异常恢复。

## 2. Taomni 当前可复用基础

仓库已经具备以下基础：

| 现有能力 | 位置 | 复用方式 |
|---|---|---|
| Tauri 2 + React 19 多窗口 | src-tauri/src/windowing/mod.rs、src/App.tsx | 增加独立 Sockscap Webview 窗口和 hash route |
| HTTP CONNECT / SOCKS5 Proxy 会话 | src/components/proxy、src-tauri/src/terminal/network.rs | 作为上游代理的统一来源 |
| SSH Session、跳板与 Dynamic SOCKS5 | src-tauri/src/terminal/ssh.rs、src-tauri/src/tunnel/mod.rs | 抽取共享 SSH channel pool；每个 TCP flow 使用 direct-tcpip 出站 |
| 应用自身代理配置 | src/components/settings/AppProxyPanel.tsx、src-tauri/src/proxy/mod.rs | 复用解析和连接测试，但不混淆产品语义 |
| Vault 凭据 | src-tauri/src/vault | 保存上游代理密码，只在 Rust 侧短暂解析 |
| SQLite 与独立数据库惯例 | taomni.db、notes.db | 新建 sockscap.db，避免高频统计锁住主会话库 |
| IPC、事件与浏览器 Stub | src/lib/ipc.ts、src/stubs | 支持真实引擎和 pnpm dev 演示数据双路径 |
| 三平台发布流水线 | .github/workflows/release.yml | 后续加入 Windows helper/driver、macOS system extension、Linux helper 的签名与打包 |

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
- Windows WinDivert 是 LGPLv3/GPLv2 双许可且需要随包分发匹配驱动；仓库还维护了本地 patched `windivert-sys`。是否采用必须经过许可证、签名、性能、EDR/VPN 兼容 Gate。
- Linux 的正常退出 cleanup 值得复用，但 Taomni 还需要独立 helper、recovery journal 和下次启动修复来覆盖 kill -9/断电。
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

- Windows：Phase 0 同时比较 `wsstun` 已有的 WinDivert SOCKET/FLOW/NETWORK + 内存 PacketDevice 路径与 WFP ALE redirect。初始建议 global 使用 Wintun/TUN，程序/PID 优先验证 WinDivert；若许可证、性能、签名或兼容性不达标，再进入自有 WFP helper/callout 路径。
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

### 4.2 第三方转发核心建议

Phase 0 优先验证 tun2proxy 作为 Rust 库候选。它当前是 MIT 许可，支持 Linux、macOS、Windows，覆盖 HTTP、SOCKS5、IPv4/IPv6、Virtual DNS 和 SOCKS5 UDP，并有基础流量回调。

不直接把 tun2proxy CLI 当最终产品内核，原因是当前公开 API 以单一上游为中心，缺少 Taomni 所需的按流 RouteSelector、按配置组统计和应用身份策略。推荐边界是 Taomni 自己定义 FlowEngine trait：

- 若 tun2proxy 能通过小规模上游贡献暴露 per-flow selector 和 lifecycle callback，则固定到审计过的版本。
- 若改动过大，则只复用其 MIT 模块或基于 ipstack、自有 HTTP/SOCKS/SSH connector 实现本地受控核心。
- 不把代理密码放到 sidecar 命令行。

这一选择必须在 Phase 0 用真实三平台样机、许可证清单和性能数据决定。

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

1. 抽取 `src-tauri/src/tunnel/mod.rs` 的 Dynamic SOCKS5/`channel_open_direct_tcpip` 与 `terminal/ssh.rs` 的认证能力为共享 `SshChannelPool`，由 Tunnel 和 Sockscap 共同调用；不要通过调用 Tauri command 或偷偷启动另一条持久化 Tunnel 来拼装生命周期。
2. SSH Session 继续由主 `taomni.db` 管理，密码由 Vault 解析；`sockscap.db` 只保存 `ssh_session_id` 引用和非敏感运行参数。
3. 一个 flow 对应一个 SSH channel；控制连接使用 keepalive、有限并发、指数退避和有界连接池。控制连接断开时 profile 进入 Degraded，既有 channel 自然结束，新连接遵循 fail-open/fail-closed 配置。
4. 域名应尽量作为 `host_to_connect` 传给 SSH 服务器解析；UI 显示 `DNS: SSH remote`。若只有 IP，则按 IP 转发。
5. 标准 SSH `direct-tcpip` 只承载 TCP。SSH egress 的 UDP/QUIC 默认 BLOCK，可显式 DIRECT，不能显示为“已代理”。
6. 跳板机地址、Taomni/Sockscap/helper PID 和 SSH keepalive 流量加入硬绕过，避免 SSH 控制连接被自身再次捕获。
7. 首版只允许一个 SSH 跳板。被选择的 SSH Session 若自身再配置 Proxy/Jump 网络链路，保存时拒绝并说明递归风险。
8. 启动前必须验证 SSH host key。当前 `terminal/ssh.rs::SshHandler::check_server_key` 仍无条件接受，必须先落地 known_hosts/指纹确认与变更告警；此项是 SSH egress 的发布阻断条件。
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
| local_network_policy | 默认绕过 loopback、LAN、链路本地和上游端点 |
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
| 全局新连接 | Wintun/TUN 首选；WFP/WinDivert 作为捕获适配器候选 | NETransparentProxyProvider 或受控 TUN | TUN |
| 指定程序 | WinDivert SOCKET/FLOW/NETWORK 参考路径；WFP ALE 备选 | audit token + code signing identity | cgroup v2 + nft/fwmark；managed launch netns |
| 指定运行中 PID | 目标支持，新连接生效 | 目标支持，新连接生效 | 条件支持；cgroup v2/eBPF，新连接生效 |
| 子进程跟随 | 进程树监听/身份规则 | audit token/进程树 | cgroup 继承最可靠 |
| 权限 | Wintun/WinDivert 或 WFP helper/driver 需管理员及签名发布 | 首次激活 system extension 需用户/管理员批准和 Apple entitlement | cgroup/nft 路径需 CAP_NET_ADMIN/root；managed netns 取决于 user namespace 策略 |
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
4. 写 recovery marker，启动 helper 与心跳。
5. 安装捕获规则并做直连、代理、DNS、IPv4/IPv6 自检。
6. 全部通过后才发布 Active。

停止事务按相反顺序执行。默认 fail-open：引擎崩溃时 helper 撤销捕获规则，让系统恢复直连，避免用户失去网络。

窗口和托盘交互：

- Taomni 中的 Sockscap 入口打开或聚焦独立窗口。
- Sockscap 窗口关闭按钮只隐藏；Windows/macOS 点击托盘图标显示/隐藏。
- Linux 托盘菜单始终提供“打开 Sockscap”和“隐藏 Sockscap”。
- 托盘图标颜色：灰色 Disabled、蓝/绿 Active、黄色 Degraded、红色 RecoveryRequired。
- 托盘菜单：状态、启动/停止、当前活动配置组、Dashboard、显示/隐藏、退出 Taomni。
- Sockscap Active 时关闭主窗口，建议弹出三选一：隐藏到托盘并继续、停止后退出、取消。
- “退出 Taomni”必须停止引擎、恢复网络并确认完成；超时则提示恢复失败，不能静默退出。

## 10. 数据与隐私

建议新增 app_data_dir/sockscap.db，并启用 WAL。主 taomni.db 继续拥有 Proxy 与 SSH sessions，sockscap.db 只保存其 session id 引用；SSH 密码、私钥口令和 host-key 信任材料不复制到统计库。

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

### Phase 0：三平台能力与许可证 Gate

目标：先证明最危险部分，不做完整 UI。

- 以 `wsstun` commit `8282eb2` 为参考基线验证 tun2proxy 0.8.x、RoutePlan、PacketDevice 和 cleanup；记录哪些代码可抽取、重写或只作为行为参考。
- tun2proxy 或替代核心：验证 per-flow route hook、HTTP/SOCKS/SSH connector、Virtual DNS、IPv4/IPv6、取消和流量回调。
- Windows：并行 spike WinDivert SOCKET/FLOW/NETWORK 动态过滤与 WFP ALE redirect；验证应用/PID、回注正确性、本机 loop bypass、许可证、签名和卸载恢复后写 ADR 选型。
- macOS：取得 Network Extension entitlement；最小 system extension 捕获 TCP/UDP，读取 audit token，选中应用代理、未选应用返回 direct。
- Linux：先移植验证 cgroup v2 + nft socket cgroup + fwmark/TUN，以及 managed-command user/network namespace；验证 running PID 新连接和不支持时的降级。
- SSH：从 Taomni Dynamic Tunnel 抽取最小 `SshChannelPool` spike，完成 host-key 验证、密码/私钥/Agent、remote DNS、断线重连和 TCP echo 垂直切片。
- 验证与主流 VPN、系统代理、休眠/唤醒、网卡切换的冲突。
- 输出 ADR：捕获技术、第三方版本/许可证、最低系统版本、打包方式。

退出标准：三平台至少完成 TCP 到本地 echo/HTTP server 的 global + selected app 垂直切片；SOCKS5、HTTP CONNECT、SSH Jump 三种 egress 都通过可重复测试；停止或 kill -9 后网络恢复；没有未解释的 DNS/IPv6 泄漏。任一平台失败则回到范围评审，不进入大规模 UI 开发。

### Phase 1：纯 Rust 配置、规则与策略核心

- Profile、selector、`egress_kind/egress_ref_id`、rule source 模型和 schema migration。
- AutoProxy/GFWList Base64 解码、域名投影、exception、IDNA、CIDR、unsupported 报告。
- 不可变 matcher snapshot、冲突检测、test_target 判定解释。
- last-good 下载器和官方镜像回退。
- 单元/属性测试，不接触系统路由。

退出标准：固定 GFWList 样例、自定义规则和异常输入全部有确定结果；规则更新失败不会破坏当前快照。

### Phase 2：FlowEngine 与上游转发

- TCP DIRECT、SOCKS5、HTTP CONNECT、SSH Jump `direct-tcpip`。
- 从现有 Tunnel/SSH 模块抽取共享 `SshChannelPool`，补 known_hosts/指纹确认、keepalive、channel 限流、重连和 MFA 状态机。
- Vault 解析、连接测试、超时、取消、上游环路硬绕过。
- DNS/Fake-IP、hostname attribution 和 unknown policy。
- 统计事件，不落 payload。
- SOCKS5 UDP spike；HTTP CONNECT 与 SSH Jump 的 UDP policy 明确降级。

退出标准：本地可重复的 Proxy/SSH 测试服务器覆盖认证成功/失败、host-key 首次信任与变化、断线、DNS、IPv4/IPv6、channel 并发、取消和重连。

### Phase 3：持久化、IPC 与浏览器 Stub

- sockscap.db、WAL、recovery journal、统计聚合与清理。
- Tauri commands/events、能力探测和权限状态。
- pnpm dev stub 提供可控的 Windows/macOS/Linux capability、Proxy/SSH egress health 与模拟流量。

退出标准：无真实管理员权限也能完整开发和测试 UI；IPC schema 有 Rust/TS 契约测试。

### Phase 4：独立窗口、配置与 Dashboard

- 新 hash route 和 SockscapWindow。
- Profile、程序/进程选择、Proxy/SSH egress、规则源、test target、advanced policies。
- Dashboard、Live Connections 的有界采样和隐私开关。
- i18n、键盘导航、错误/降级文案。

退出标准：Vitest 覆盖编辑冲突、能力降级、状态流转；浏览器 stub 能完成完整用户路径。

### Phase 5：Windows 纵向完成

- 按 Phase 0 ADR 完成 Wintun + WinDivert 或 WFP helper/driver 的签名安装、升级、卸载和恢复。
- 应用/PID/子进程、新连接语义；若采用 WinDivert，覆盖 SOCKET/FLOW ownership race、动态五元组 filter 与 packet reinjection。
- Windows 安装包、管理员提示、EDR/VPN 兼容验证。

退出标准：全局、程序组、运行 PID、三种 egress、GFWList、托盘、Dashboard 全链路；重启、崩溃和更新不遗留 Wintun/WinDivert/WFP 规则或驱动状态。

### Phase 6：macOS 纵向完成

- Xcode system extension target 与 Rust/Swift bridge。
- Developer ID、entitlement、notarization、用户批准与版本升级。
- audit token 安全解析、应用身份、provider 自身绕过。
- Intel 和 Apple Silicon 构建。

退出标准：全局、程序组、运行 PID 的新连接路由可验证；拒绝权限时清晰降级；卸载/升级不遗留配置。

### Phase 7：Linux 纵向完成

- 最小权限 helper、polkit 或 capability 安装流程。
- cgroup v2/nft/fwmark adapter；managed-launch user/network namespace fallback；仅在基线失败时评估 eBPF 替代。
- systemd-resolved、NetworkManager、IPv6 和常见发行版兼容。
- AppImage/deb/rpm 的能力与卸载策略评审。

退出标准：支持矩阵内的发行版完成全局和程序组；PID attach 不可用时按能力探测降级；无 nft、route、cgroup 残留。

### Phase 8：托盘、可靠性、QA 与发布 Gate

- Rust 后端创建 Tauri tray；动态状态图标和菜单。
- Windows/macOS 左键切换，Linux 菜单兜底。
- 睡眠/唤醒、网卡切换、代理不可用、SSH 断线/host-key 变化/MFA 等待、Vault 锁定、规则更新失败、进程退出。
- 更新 feature-list.md，新增 YAML UI 用例；真实 Tauri smoke 覆盖独立窗口。
- 三平台长稳、性能、泄漏、恢复、安装/升级/卸载测试。

退出标准见 Definition of Done。

## 14. 测试与质量门槛

功能测试：

- 配置组优先级与重叠拒绝。
- GFWList proxy/exception、手工 override、unknown 三种动作。
- HTTP/SOCKS 认证、错误、超时、连接重用边界。
- SSH 密码/私钥/Agent、known_hosts、指纹变化、MFA、remote DNS、channel 并发、keepalive、断线重连与跳板禁止转发错误。
- 程序、PID、子进程；PID 重用保护。
- IPv4/IPv6、DNS、DoH 场景、QUIC/UDP policy。
- Proxy/SSH 上游地址、loopback、LAN、Taomni/helper 自身不形成环路。

可靠性测试：

- start/stop 连续 100 次。
- Active 时 kill 主进程/helper、断电模拟后的下次启动恢复。
- 睡眠、唤醒、Wi-Fi/有线切换、VPN 开关、代理掉线、SSH 控制连接重置和跳板重启。
- 升级和卸载时恢复系统网络。

建议性能目标，待 Phase 0 用硬件基线确认：

- 排除上游 RTT 后，TCP 建连额外中位延迟小于 10 ms。
- 1 Gbps 本机基准下吞吐不低于 direct baseline 的 80%。
- 10,000 条域名规则匹配 P99 小于 100 µs。
- 1,000 活动连接时 Dashboard IPC 不高于 2 次/秒。
- 规则更新和统计落盘不得阻塞转发热路径。

UI/QA：

- 新 feature-list 条目覆盖 Dashboard、Profiles、Rules、process picker、capability warnings 和 recovery。
- Vitest 测纯 UI、状态和 stub；qa-ui-auto 覆盖 browser mode。
- 独立窗口、托盘、权限弹窗和恢复只能用 Tauri/native smoke 验证，不能只靠 jsdom 宣称完成。

## 15. 主要风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| Windows Wintun/WinDivert/WFP 选型与签名 | 无法发布、性能不足或触发安全软件 | 对照 wsstun 做双 spike；许可证/签名/EDR/VPN/回注正确性 ADR 后再冻结实现 |
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

## 16. 需要评审确认的决策

建议按以下默认值进入 Phase 0，评审时可逐项修改：

1. 产品名：界面叫 “Sockscap”，设置搜索关键词同时包含“流量路由/进程代理”。
2. 初始平台顺序：Phase 0 同时验证三平台，正式纵向先 Windows，再 macOS，再 Linux。
3. 故障策略：默认 fail-open。
4. GFWList 未知域名：默认 DIRECT，但显示 unknown/DNS leak 指标；提供 strict PROXY。
5. HTTP CONNECT 的 UDP：默认 BLOCK，以促使 QUIC 回退 TCP；用户可改 DIRECT。
6. 域名统计：默认关闭。
7. 主窗口退出：Sockscap Active 时默认“隐藏到托盘并继续”，明确菜单退出才停止。
8. GFWList：内置使用当前官方 GitHub raw/GitLab/Repo.or.cz 健康源；用户给出的 Bitbucket URL 作为来源记录和兼容候选，失败后使用 last-good/健康镜像。
9. 不承诺既有连接迁移：程序/PID 选择只影响后续新连接。
10. SSH Jump：首版选择一个已保存 SSH Session 作为 egress，不允许嵌套 Proxy/Jump 链。
11. SSH UDP：默认 BLOCK，以促使 QUIC 回退 TCP；可显式 DIRECT。
12. SSH 信任：known_hosts/指纹校验是发布 Gate；需要 MFA 的后台重连进入 UserActionRequired。
13. Windows 捕获：Phase 0 对照 `wsstun` 的 WinDivert 路径与 WFP ALE 双 spike 后由 ADR 决定，不在评审阶段拍脑袋锁死。
14. 首个 release Gate：三平台都通过恢复测试后才称“跨平台稳定”；Windows 先行版本必须标 Beta。

## 17. Definition of Done

- Windows、macOS、支持矩阵内 Linux 均能运行 global 和 application group。
- 支持的系统上可选择 running PID，明确只作用于新连接；不支持时有可解释降级。
- SOCKS5、HTTP CONNECT 与 SSH Jump TCP 经真实服务器验证；SSH host-key 变化会被阻断。
- GFWList 更新、镜像回退、例外规则、手工规则和 test target 可解释。
- DNS/IPv6/UDP 状态不静默泄漏，Dashboard 能显示 unknown 和降级。
- 多配置组按优先级稳定运行，无多个 TUN/拦截器争抢。
- 窗口隐藏/托盘恢复符合平台能力；Linux 有可靠菜单入口。
- stop、crash、restart、upgrade、uninstall 均不遗留系统网络配置。
- Vault 外没有 Proxy/SSH 明文 secret；日志和统计不含 payload、完整 URL、密码、私钥或 MFA 回答。
- Rust、Vitest、qa-ui-auto、三平台 native smoke 和性能/长稳 Gate 全部通过。

## 18. 参考资料

- 本地参考实现：`D:\code\person\wsstun` commit `8282eb2`，重点为 `sockscap-design.md`、`src/sockscap/` 与 `resources/macos-provider/`；仅作为设计和 spike 基线，不形成运行时目录依赖。
- [GFWList 官方 GitLab 镜像与 README](https://gitlab.com/gfwlist/gfwlist)
- [GFWList GitLab raw](https://gitlab.com/gfwlist/gfwlist/raw/master/gfwlist.txt)
- [GFWList 官方 GitHub 仓库与当前订阅地址](https://github.com/gfwlist/gfwlist)
- [tun2proxy：MIT Rust TUN to HTTP/SOCKS core](https://github.com/tun2proxy/tun2proxy)
- [Tauri 2 System Tray](https://v2.tauri.app/learn/system-tray/)
- [Microsoft Windows Filtering Platform](https://learn.microsoft.com/en-us/windows/win32/fwp/about-windows-filtering-platform)
- [Microsoft Application Layer Enforcement](https://learn.microsoft.com/en-us/windows/win32/fwp/application-layer-enforcement--ale-)
- [Apple NETransparentProxyProvider](https://developer.apple.com/documentation/networkextension/netransparentproxyprovider)
- [Apple Network Extension provider deployment](https://developer.apple.com/documentation/technotes/tn3134-network-extension-provider-deployment)
- [Apple source application audit token guidance](https://developer.apple.com/forums/thread/781247)
- [Linux network namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
- [Netfilter nftables](https://www.netfilter.org/projects/nftables/index.html)
