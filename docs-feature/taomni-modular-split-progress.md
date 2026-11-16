# 模块化实施与验收台账

更新：2026-11-16。范围以[设计 §10.1](taomni-modular-split-design.md#101-可执行任务分解)与 [ADR](../claudedocs/adr-taomni-modular-split.md)为准。基础契约通过不代表业务已迁出或可发布。

## 当前结论

核心仍包含 MFA、Servers、SocksCap、远程桌面和本地语音等业务代码、状态与依赖。目前唯一独立宿主是 hello-plugin。LanChat 已删除；历史 `lanchat.sqlite` / `lanchat.db` 保留原位，不读取、不迁移、不删除。

生产升级 IPC 当前只记录只读预检、源指纹与 pending journal。缺少可信插件包和真实 exporter 时，不复制旧数据、不创建伪插件版本、不改变 active 指针。测试 fixture 的 staging/回滚原语不能算真实旧版升级验收。

签名安装门、宿主生产监督、共享采集/RDP 公共库、CoreState/统一 bootstrap、正常退出与可逆静默已集成。生产工厂、scoped 入口和持久 profile generation 已在 `00ac480d8` 接入，其 macOS 崩溃宿主终止确认失败已由 `5d49b9abc` 修复；该新源码的升级契约 [#43793976461](https://github.com/engcapa/taomni/actions/runs/43793976461) 已 23/23 jobs 成功。相同新源码的 UI [#43794006016](https://github.com/engcapa/taomni/actions/runs/43794006016) 仍在执行，已即时收齐三端 browser 各 24/24；Windows/macOS native 各 27/29，相关失败为 TC-MODULES-007 宿主未启用与 TC-MODULES-009 fixture 过早读取 metadata，Linux native 尚在构建。业务状态仍在 LegacyFeatureRuntime；Vault IPC 协同、远端商店、重启下载恢复、业务宿主迁出与真实升级尚未完成。G1–G11 未通过前，不将具体业务插件迁移标为完成。

## 任务状态

| 任务 | 状态 | 尚需交付的结果 |
|---|---|---|
| TASK-001 基线 | 部分 | 四个发布目标的真实安装包尺寸、启动/内存/吞吐原始样本；源码与依赖起点已有记录。 |
| TASK-002 契约 | 部分 | API、manifest/schema、registry、RPC 已有；待真实插件与 G 门验证后冻结。 |
| TASK-003 共享采集 | 已提交，hosted 验证中 | 引擎/权限/像素/一次性采集已下沉 `taomni-capture`，核心 `capture/` 持有显示器/帧源/窗口生命周期；仅保留 headless 建表例外。四目标 check、三平台库 unit 与 Linux 三个真实 X11 测试已通过，真实截图/MFA/Mobile/RDP/性能及完整 UI shard 仍待结果；`capture.still` 宿主大载荷 RPC 仍依赖 TASK-002。见下方测试设计。 |
| TASK-004 RDP 公共库 | 代码已集成，待 hosted 验证 | `taomni-rdp-common` 与零依赖的 `taomni-file-uri`；客户端与服务端共享能力只经库依赖，config 直接用通用 URI 库。基于 `0f4cdf82f` 的集成单元完整功能 39/39、关闭 bitmap 30/30 及边界检查通过；四目标/三平台和精确保留场景待本提交 hosted 证据。见下方 TASK-004 记录。 |
| TASK-005 核心状态 | 005-A 已集成，待 hosted 验证 | CoreState、LegacyFeatureRuntime、统一 bootstrap、弱观察器与退出清理已集成；005-A 尚待服务准入接线及 TC-MODULES-008/009 多端证据，005-B 的真实业务状态迁出仍未完成。 |
| TASK-006 核心依赖闭包 | 待开始 | Cargo 默认 features、bundle/resources、平台依赖与核心前端 chunk 真正移除已迁移业务。 |
| TASK-007 前端注册和路由 | 部分 | loader/helper 已有；接入主窗口/分离窗口实际 tab、完整性校验、缺失/禁用/坏 chunk 与卸载清理。 |
| TASK-008 宿主监督 | 已提交，部分 hosted 通过 | 主动心跳、重启预算、请求取消及三平台进程树回收已接入；GitHub 三平台各 14 项 unit 与 7 项真实进程测试通过，双向核心服务与 profile 协同仍待后续任务。 |
| TASK-009 生命周期 | 部分 | 版本目录、active 指针与生命周期 IPC 已有；接可信安装门、运行中切换/回滚、无重启生命周期。 |
| TASK-010 商店/下载 | 部分 | 原生 HTTP、代理、Range/校验、路径与内容去重、退出取消等待、续传和进度 IPC 已有，三端每端 13 个真实网络 gate 已通过；远端商店、代理设置 UI、跨应用重启恢复与完整错误恢复尚待完成。 |
| TASK-011 验签安装 | 代码已集成，验证中 | pinned key 的真实 minisign 校验、清单防回滚、安全解包、内容绑定及安装入口强制验签已接入；四目标官方签名包 QA workflow 与 TC-MODULES-007 已集成，待成功安装/重启/篡改拒绝的多端原生证据。 |
| TASK-012 单体升级 | 部分 | 从安全 pending 进入真实 legacy exporter、可信包 staging、Vault 交接、激活、恢复/回滚；真实安装升级证据。 |
| TASK-013 原型与 G 门 | 部分 | hello fixture 已有；真实 MFA 原型和 G1–G11 多端实验与原始证据。 |
| TASK-014 MFA | 待前置闭合 | 完整迁出、数据密钥与备份恢复、功能等价。 |
| TASK-015 | 已取消 | 历史设计 `7bc498b35` 中为 LanChat 迁移，已由用户明确删除决定取消；主设计已保留编号并清理前置依赖。旧库保持原位，不读取、迁移或删除，不创建替代插件。 |
| TASK-016 RDP/VNC 客户端 | 待前置闭合 | 两个插件宿主与前端、证书钉扎、剪贴板/输入、保留会话及特定按键辅助入口。 |
| TASK-017 RDP/VNC 服务端 | 待前置闭合 | 两个插件宿主、共享采集/公共库、系统权限和平台边界。 |
| TASK-018 Servers | 待前置闭合 | 配置迁移、服务生命周期、目录与原有功能等价。 |
| TASK-019 SocksCap | 待前置闭合 | 提权/驱动/辅助进程、文件与恢复日志、卸载清理迁出。 |
| TASK-020 截图 OCR/录制 | 待前置闭合 | OCR/录制插件；截图入口、滚动截图与采集保持核心归属。 |
| TASK-021 本地语音 | 待前置闭合 | 本地 ASR/FIM 引擎和模型插件；云 ASR/麦克风保持核心归属。 |
| TASK-022 Mobile | 待 M0 决策 | 按 DEC-2 默认暂缓排期；M0 末提供 go/no-go 与公开例外，不能默认为已交付。 |
| TASK-023 发布验收 | 部分 | 清单生成与上传顺序已有；四目标插件构建/系统签名、包签名、原子清单发布、独立插件更新/回滚、两套回归及性能。 |
| TASK-024 入口/profile 协同 | 随 005-A 已集成一部分 | GUI/headless bootstrap、ModeLease、可重试退出和任务回收已集成；跨宿主 profile lease、还原静默与完整多进程证据仍待完成。 |
| TASK-025 密钥/一致快照 | A/B/C 已集成；D 实现中 | [服务、锁与快照实施方案](taomni-modular-vault-services-plan.md)；A/B/C 三端基础/真实锁 gate 通过。D 的双向 pump、独立 SDK、有界 dispatcher 与真实 Vault backend 已实现，纯单元 56 项通过；三端各 6 个 SDK 进程场景和 Linux 2 个真实 Vault/SDK 场景已通过；后续生产工厂与 generation 批次待 hosted 验证，Vault IPC 协同未接。E–I 的 MFA 适配、撤销协调、迁出和三态备份还原未完成。 |

具体编号与子任务边界仍以设计原表为准；上表合并描述不改变范围或依赖。

## 当前开发批次（`0f4cdf82f` 已提交，hosted 验证中）

- 验签路径采用与核心 updater 相同的固定公钥，校验真实 Minisign 签名、清单 sequence/内容、平台/版本/API、包 SHA-256 与内部精确文件清单。任意目录安装入口拒绝，版本目录保存签名原包供扫描、启用、启动、回滚和自动重启重新认证。离线安装入口已接入设置页；官方签名包的成功 UI 安装尚缺真实 artifact 验证。
- 安装失败恢复旧 active 指针和 registry 投影；卸载后普通安装也拒绝降级。前端 URL 包含不可变版本，逐资源返回经过签名文件 hash 核验的实际字节；实际业务 tab 的动态插件路由仍未完成。
- 生产宿主接入主动心跳、预算重启、请求 ID、稳定 RPC 错误与取消、退出清理。Windows 使用 Job Object；Linux 使用稳定 spawn-owner、PDEATHSIG 和 ownership guardian；macOS 使用 kqueue guardian。Unix 官方宿主及子孙须留在所属 session/process group，不允许 daemonize 逃逸；本方案不构成第三方沙箱。多进程 profile/备份静默仍属 TASK-024。
- 旧的伪版本 staging/active 迁移执行器已限制到测试编译；生产只保留安全 pending。
- `QA Modular Upgrade Contracts` 扩展为三端真实宿主生命周期/核心强杀清理、四发布目标采集库检查及 Linux X11 原生源测试。这些测试仍不证明已安装 0.5.x 的真实升级、系统签名信任、TCC、noexec、吞吐或 profile gates 已通过。

安装保留一份压缩原包作为可重验凭据，会增加数据目录空间占用。大于 32 MiB 的包必须使用 Minisign ED 预哈希签名；单个前端资源读取上限 256 MiB。Catalog 发布中断时不降低安全水位，重新获取同一或更高序号的签名清单可恢复安装。上述约束应纳入最终包构建、空间预检和发布演练。

`0f4cdf82f` 最终本地 Rust 受影响单元 139 passed（plugin 85、host 14、screenshot 11、MFA 13、mobile 6、RDP display 10），fmt、完整 QA audit 与 check:refactor 通过。此前模块/设置/离线安装前端 55 passed、URL loader 14 passed；采集库 21 passed，3 个真实 X11 测试仅 hosted opt-in。TASK-004 集成后的新增公共库和边界检查结果单列在下方，不混计为旧批次证据。

[QA Modular Upgrade Contracts #43774556826](https://github.com/engcapa/taomni/actions/runs/43774556826) 已全部通过，并取得执行期间下载的三平台宿主 artifacts：每端 14 项 unit 与 7 项真实进程测试通过。四个 capture 发布目标 check 通过；Windows 12、macOS 18、Linux 21 项库 unit 通过，Linux 另有 3 项真实 X11 测试通过，Linux 核心 plugin 单元 85 项通过。原始 artifacts 位于 `qa-ui-auto-report/github/43774556826/upgrade-live/`，完整 run 身份与日志位于同目录上级的 `run-final.json` / `workflow.log`。该 run 不包含之后新增的 RDP 公共库、Vault 基础库或官方签名成功链。

[QA UI Auto Platforms #43774557089](https://github.com/engcapa/taomni/actions/runs/43774557089) 已结束，22 个预期 shard artifact 均在执行期间采集，包含两个只有环境失败信息的 Wayland artifact。三端 browser 的 `TC-MODULES-006` 在关闭 Settings 后等待卸载时失败，属于本批相关问题，不能忽略；Linux Xvfb、Wayland 与 Windows native 也在同一步失败，macOS native 此 case 已通过。trace 显示 close 图标的 mousedown 冒泡先激活 tab，侧栏布局恢复后移动目标，使随后 click 未关闭。`54f7735c7` 阻止该冒泡并补完整指针手势单元回归；相关 15 项 Vitest 和 check:refactor 通过，case 仍断言真正移除 tab/panel 后重开恢复错误，待新 SHA hosted 重跑。

该源码 `0f4cdf82f` 的实际结果如下，不能移用为后续集成提交的通过证据；artifact 采集成功也不等于用例通过。

| 执行组 | 通过 / 已执行 | 失败或缺口 |
|---|---|---|
| Linux / Windows / macOS browser | 每端 32 / 33 | 每端 TC-MODULES-006。 |
| Linux Xvfb native | 39 / 40 | TC-MODULES-006。 |
| Windows native | 39 / 41 | TC-MODULES-006 与 RDP 重启用例的重复弹窗预期。 |
| macOS native | 39 / 39 | 本轮所选用例全部通过。 |
| Ubuntu 26.04 Wayland native | 18 / 20 | TC-MODULES-006 与既有 AI 路径 chip 命中；另 20 项因两个 shard 的环境安装失败未执行。 |

同 run 的两个 Ubuntu 26.04 Wayland shard 在 Playwright 1.55 安装 Chromium 依赖时失败，尚未执行 case，不能计为产品用例通过。workflow 已增加该 profile 专用的 `ubuntu24.04-x64` Playwright 平台覆盖，复用上游 Noble 构建与依赖清单；实际 desktop/profile 仍为 Ubuntu 26.04 Wayland。修复需在新 SHA 的 GitHub runner 验证，不能靠本地 shell 单元判断兼容性已通过。

执行期间下载的 Windows native shard 3 还发现新增 `TC-RDPS-NAT-01` 重启步骤错误地再次要求选择弹窗。生产 `systemRdpChoice.ts` 明确保留第一次的 Taomni 选择，首次真实 NLA/画面/输入、错误密码与停止后的拒绝连接均已通过，失败只发生在第二次等待弹窗。用例已改成断言不重复弹窗，并保留重启后真实客户端完整画面、第二次停止和拒绝连接断言；相关选择逻辑 7 项单元通过，新 SHA native 待重跑。

Wayland `TC-FILE-OPEN-008` 在已有 AI 路径 chip 点击处失败：失败截图显示长 inline 路径跨行，native hit-test 使用其外包矩形中心落在非命中位置。该 hook `src/components/chat/useChatFileLinks.ts` 与 main 相同，失败发生于既有 AI 入口，与这批模块化/采集实现无关。按用户指示单列保留原始失败，不计为通过、不放宽断言；后续相同输入仍失败时继续报告，不能用其他平台通过覆盖该记录。

最新集成批次：`2ed37513d` 为 C 准入/真实 Vault adapter；`be3479313` / `41c1c6f42` 为下载可靠性、真实网络 gate 与退出取消等待；`5b24d9874` / `fca580794` / `af8874a33` 为 CoreState、统一启动退出、可逆静默及 renderer 取消时仍完成已提交的退出。合并后的 `pnpm check:refactor` 已通过；上述生产行为仍需关联最终源码的新 hosted 证据。

本批 host pump 仅将现有收包/心跳/取消方法提取到 `host/pump.rs`，由既有 host 单元和真实进程 gate 保护；尚未处理 host→core 服务请求，不代表 TASK-025-D 已完成。C adapter 通过真实模块声明接入核心后，其专用四项单元及三端下载网络、生命周期单元已加入 upgrade workflow。

合并后的本地验证：前端模块/IPC/重启/Tab 50 项、系统 RDP 选择 7 项、API/作用域服务/下载 48 项、真实 Vault adapter 4 项、核心生命周期 18 项、宿主 14 项、runner 配置 6 项均通过；下载原有三个真实网络测试仍 ignored，新增网络用例留在 GitHub 执行。TypeScript、完整 QA audit、check:refactor、rustfmt、actionlint 与 diff 检查通过。新静态选择包含 68 个明确 case 与完整 crash-regression 的并集，22 个 shard、三套 release QA 构建，`gaps=[]`；这是计划，不是执行通过。Linux 核心单元 workflow 改为编译一次真实 harness、逐过滤器检查非空选择并保存日志及源码/二进制身份，避免重复完整编译。

## 接下来的执行顺序

### 当前待办（按依赖顺序）

1. **收敛当前相关失败并取得新源码证据**：macOS 崩溃宿主终止确认已在 `5d49b9abc` 的契约 run 通过。新 native 证据表明 TC-MODULES-007 探针修复后暴露真实宿主启用缺失，TC-MODULES-009 在首次启动前读取尚不存在的 generation；两处已写修复，待新 SHA 验证。旧 run 的 Windows TC-MODULES-009 关闭前 hit-test 失败仍需排查，已补释放 driver 前的采证。继续逐 shard 收取结果，不能用旧源码或仅 browser 的通过替代。
2. **闭合 Vault、profile 与一致快照（TASK-024/025）**：init/unlock/lock/rekey 接入统一 coordinator，完成关闭准入、取消、撤销/确认退出、drain、清 root 的屏障；保留历史宿主终止 receipt。真实 MFA 领取作用域 permit、密码导出/reset grant，旧固定 ID 和错误语义不变。补运行中、禁用、卸载留数据三态的备份/正常重启还原与真实解密，以及多实例占用、取消和崩溃恢复。
3. **迁出真实业务（TASK-005-B、013/014、016–022）**：先完成真实 MFA 原型与相关 G 门，再依赖序推进 RDP/VNC 客户端与服务端、Servers、SocksCap、OCR/录制、本地语音的宿主、前端、状态与迁移。Mobile 按 DEC-2 留下明确 go/no-go 结论和公开例外，不能默认为交付；LanChat 任务已取消，不新增替代插件。
4. **裁剪核心依赖闭包（TASK-006）**：随业务迁出，从核心 Cargo 默认 features、原生依赖、bundle/resources/helper 和前端 chunk 中实际移除相应实现。保存 cargo tree、资源与产物证据；把状态改名或放入 LegacyFeatureRuntime 不等于瘦身完成。
5. **完成模块使用闭环（TASK-007、009–011）**：远端签名商店、三种代理设置 UI、跨应用重启发现并恢复下载、后台进度及错误恢复；实际主窗/分离窗动态 tab、坏 hash/缺失/禁用占位和清理；安装、启用、禁用、更新、回滚无需重启核心。
6. **验证真实旧单体升级（TASK-012）**：从已发布、已安装的 0.5.x 取得真实数据，经 legacy exporter、可信包 staging、Vault 交接和原子激活；覆盖升级中断、失败、重试和回滚，并证明原数据未损坏。现有只读预检/pending journal 与合成 fixture 都不算该验收；旧 LanChat 库保持原位且不读取。
7. **完成生产发布验收（TASK-001/002/023）**：闭合 G1–G11、冻结真实插件契约；完成四发布目标的宿主系统签名/包签名、原子 modules 清单、模块独立更新/回滚。核心-only 与实际全插件集合分别完成受影响用例及完整 crash-regression，并归档包体积、启动、内存、帧吞吐的匹配基线与原始样本。

### 2026-11-16 启用与原生观察修复批次（开发中）

- 已即时下载 Windows/macOS 全部 native shard，两端均为 27/29；TC-MODULES-007 第 15 步返回真实 `enabled=false`，TC-MODULES-009 第 0 步读取不到尚未 bootstrap 的 `.profile-state.json`。本轮未发现这两类以外的相关失败，Linux native 尚在构建。
- 宿主首次启动和预算重启共用 `host/launch.rs`：认证握手后，只对可信 manifest 声明了 `plugin/enable` 的宿主调用启用钩子，并等成功才返回；握手与启用共享一个启动 deadline。未声明钩子的 v1 服务宿主保持兼容；不把 hello 的默认状态改成启用，也不放宽真实 identity 断言。新增 hello 首次启用与重启状态断言，另有拒绝、超时/实际进程回收、无钩子三个 hosted 场景；workflow 明确选择全部场景。本地只编译这些真实进程测试。
- generation fixture 改为首次启动前仅登记路径，在应用就绪后由 `assert_core_profile_generation` capture 真实 canonical UUID，正常重启后比较同一路径与值；禁止二次 capture 掩盖变化。不创建、不覆盖产品 metadata，独立保存观察 evidence，TC-MODULES-009 保持 24 步与原 checkpoint 索引。
- 正常重启失败时，在释放 driver 前以独立 3 秒预算保存 WebView screenshot、HTML 和关闭按钮的真实命中层；采证失败不替换原异常。这是为 Windows 旧 hit-test 失败补诊断，不代表问题已修复。
- 观察/重启/官方包工具 60 项纯单元通过；新源码核心精确过滤器 117 passed、3 个真实进程场景 ignored，小 crate services 28 / host 14 passed（host 与核心有重复，不混加）。真实 hosted 20 场景仅编译。两个原生用例 schema、reviewed contract 和 verb 注册、完整 QA audit（756 cases、0 errors、catalog current）、check:refactor、rustfmt、actionlint、diff 检查通过；三端静态选择为 22 shards、3 个 release QA 构建、gaps=[]。新的宿主行为、metadata 与退出凭据仍待匹配新源码的 GitHub runner 证据。

### 2026-11-16 核心操作与宿主退出凭据批次（开发中）

- 新增 `CoreOperationPermit`，使仍在核心的受保护业务与宿主共用 epoch/generation、限额、跨进程 lease 和排空计数；没有 HostInstance/wire context，不能借它执行 reverse RPC。核心业务调用方尚未接通，不能据此报告真实 MFA 已适配。
- `AuthorizedHost` 的克隆共享一次实例的终止标记；只有实际 transport 的内核进程树确认成功才记录。崩溃 transport 在 session 释放后仍保留对应身份与 dispatcher；历史 operation/敏感 frame 的 lease 仍要实际释放才能完成撤销。相同 revocation 的确认可重试，错误 epoch/generation/实例仍被拒绝。
- registry 的 scan、禁用、卸载、版本切换、静默和退出改为确认成功后才移除 runtime；失败保留所有权并返回错误，不提前删除数据或更新 active 指针。GUI 退出准备持有可逆静默屏障到提交，headless 也传播确认失败；这批行为待匹配新源码的 hosted native 证据。
- 当前纯进程内 services 单元 28 passed（新增核心操作 5 项、终止凭据 4 项）；生产 host 单元 14 passed，真实 SDK 场景只编译，未在本机执行。核心 registry/退出新增单元与最终静态检查已通过，详见上方启用修复批次。Vault init/unlock/lock/rekey coordinator、MFA 的外层 permit 和一致快照仍未接入。

### 2026-11-16 即时收取的相关失败与修复

- 修复源码 `5d49b9abca67ee5276839067f8e193f9a16ec83b` 的 [契约 #43793976461](https://github.com/engcapa/taomni/actions/runs/43793976461) 已 23/23 jobs 成功，21 份 artifact 在执行期间收齐；macOS 实际日志中的 17 项 unit、2 个 cleanup、6 个 lifecycle、8 个 SDK 场景全部通过。相同源码的 [UI #43794006016](https://github.com/engcapa/taomni/actions/runs/43794006016) 已即时收齐六个 browser shard，三端每端 24/24、identity stable；native 仍在构建/执行，不计为已通过。该证据不包含上述后续开发中的退出凭据批次。

- 源码 `00ac480d81522f3497b3d6804de389cfa77bf0ca` 的 [契约 #43791785215](https://github.com/engcapa/taomni/actions/runs/43791785215) 已结束，22/23 jobs 成功，21 份 artifacts 已在执行期间收齐。Linux/Windows 的 2 个 cleanup、6 个 lifecycle 和 8 个 SDK 真实进程场景均通过；macOS 的 cleanup 2/2、lifecycle 6/6、SDK 7/8。失败为 `confirmed_stop_keeps_crashed_transport_ownership_until_termination_is_observed`，终止查询返回 EPERM，不能忽略或伪造确认。
- Darwin 的负进程组信号探测会过滤僵尸成员，可能对仅余僵尸的组返回 EPERM（XNU `bsd/kern/kern_sig.c` 的 `killpg1`）。修复改为 libproc 枚举所属组并检查每个成员的当前 group/status；只有没有存活成员才确认，查询权限/截断/不完整返回仍失败。真实进程回归沿用上述已失败场景与子孙树退出场景，新增三项纯状态判断单元；macOS 实际结果仍待新 SHA hosted 执行。
- [UI #43787465425](https://github.com/engcapa/taomni/actions/runs/43787465425) 的 macOS native shard 2/4 已边运行边下载。shard 4 为 13/13；shard 2 为 11/12，TC-MODULES-007 在第 12 步失败，其余包括真实 RDP loopback、性能与 crash 场景通过。原生 registry 确实为 `installed`；用例本来就断言未启用调用返回 InvalidState，但观察结果根对象含 `error`，被 W3C transport 误认成驱动失败。新单元已用真实 transport decoder、模拟响应复现相同异常；修复仅包裹观察值，不放宽拒绝断言或启用后的真实 host identity。重跑前不计该 case 通过，其余 shard 继续执行。
- 该旧 run 已结束，22 个 shard artifact 全部收齐。macOS 四个 native shard 为 47/48，Linux Xvfb 为 47/48，两端唯一失败均为同一 TC-MODULES-007 探针；Windows native 为 48/50，另有 TC-MODULES-009 关闭前的指针 hit-test 失败，尚待排查，不能忽略。按最终逐 case summary 复核，Wayland 为 44/48：同一探针、既有 TC-FILE-OPEN-008 路径 chip 命中问题，以及 TC-FILE-OPEN-006 的非左键输入需要 X11、TC-MOBILE-021 的 OS 文本输入仅到达 `77` 而缺少 `QA_DESK_`。后两项原生指针工具和 `deliver_keyboard_input`/probe 路径均与 main 相同；Mobile 真实屏幕 PNG、权限开关与浏览器打开已通过，失败发生在未改动的 Enigo 文本输入。按用户指示把这些 Wayland 工具/输入缺口单列，不改断言、不记通过，不阻塞本批模块化修复。
- 本批本地纯单元：Python 原生观察/官方包契约 9 passed，宿主既有 unit 14 passed；完整 QA audit、check:refactor、rustfmt、actionlint、diff 检查及模块场景加完整 crash-regression 的三端静态选择通过（22 shards）。macOS 新 kernel 状态判断的三个 unit 和真实进程/native case 留在 GitHub 执行，静态选择不算执行证据。

### 2026-11-16 生产工厂与 profile generation 批次

- 双向服务源码 `4a67992d6f5f05e1644888aac8371a9dbcb4c479` 的 [升级契约 #43787463856](https://github.com/engcapa/taomni/actions/runs/43787463856) 已 23/23 jobs 成功，21 份 artifact 在执行期间下载。实际日志复核：三端每端 7 个既有宿主进程场景、6 个 SDK 双向 stdio 场景通过；Linux 两个真实 Vault/SDK 场景通过，receipt 绑定该源码及 core/SDK 二进制 hash。原始结果见 `qa-ui-auto-report/github/43787463856/live-contracts/`；仍不属于已安装 MFA 业务迁移证据。
- 相同源码的 [UI Platforms #43787465425](https://github.com/engcapa/taomni/actions/runs/43787465425) 已即时下载六个 browser shard：Linux/Windows/macOS 每端 35/35，无 fail/skip，identity stable。Windows 官方包签名链通过，确认 LF 修复；三端 native 仍在构建/执行，不能计为通过。
- 本批生产 registry 由统一 GUI/headless bootstrap 配置 `PluginCoreServices`，真实 Vault 作为独立 backend。host factory 只使用 `host_location` 刚验签的 manifest；安装/扫描/启动共用固定 key owner policy。没有核心服务声明的 hello 继续使用旧 wire。dispatcher 在宿主停止且 registry/lifecycle mutex 释放后关闭并 join，不反持 AppState/registry。
- `dispatch.rs` 单独承担 renderer correlation 与 core-only scoped invoke。renderer 的 request ID 仍不能带方向前缀，内部 operation class/context 不接受 renderer 参数；核心在宿主 mutex 前获取外层 VaultOperationLease。取消表保存真实 wire target，排队前取消、取消与 attachment 竞态、shutdown 均映射到 scoped request，drop 清理两者。
- `.profile-state.json` 用稳定 `.profile-locks/profile-state.lock` 协调创建、读取和原子替换。普通重启保留 generation；还原应用前换新 generation 并写 journal，旧 journal 缺字段时补齐，恢复/回滚不使用旧归档 generation。Unix 同步父目录，Windows 沿用已同步临时文件的原子替换且不外推同等 directory fsync。损坏或 symlink state 拒绝启动/写入，不静默重新生成。
- 新增显式 `revoke_keys(deadline)` 和 `stop_confirmed(deadline)`：Linux 核验实际进程组中的存活进程（僵尸不持地址空间），Windows 核验 Job Object ActiveProcesses，macOS 等待所属进程组退出。崩溃 transport 保留 ownership 到确认，不在失去 receipt 后假称清理完成；替换宿主前先确认旧 transport 终止。两个新 SDK 终止场景只在 hosted 执行，SDK selection 从 6 增至 8。
- `TC-MODULES-009` 新增真实 `.profile-state.json` 在正常重启前后的同值断言。fixture 只读 run-owned profile，验证 canonical UUID 后提供路径和值，不生成/覆盖 metadata；browser 保留 TC-MODULES-008/001/006，真实 host/network 边界继续由 hosted gates 和 native case 保护。
- 本批本地只执行纯单元/静态/编译：核心精确过滤器 110 passed、3 个真实进程场景 ignored；小 crate host 14/profile 锁 7 passed（host 断言与核心有重复，不混加为独立场景），QA fixture 单元 2 passed。新增真实 SDK 8 项和进程树 cleanup 2 项仅编译，不在本机执行。完整 QA audit、TC-MODULES-009 三端静态选择、check:refactor、rustfmt、actionlint 和 diff 检查通过。
- 这一批**尚未把 Vault init/unlock/lock/change-master IPC 接入 admission 状态转换**，服务准入在 bootstrap 默认关闭，真实 MFA facade 也未调用 scoped 入口。因此不能把 factory、SDK 或 metadata 的接线报告为 TASK-025-D/E 完成，更不能报告业务已迁出。后续须统一关闭准入、撤销/确认退出、drain、清 root，保留历史 transport 的确认记录，并让真实 MFA 操作领取作用域/密码导出/reset grant。

### 2026-11-16 双向服务批次与最新 runner 证据

- [升级契约 #43781962402](https://github.com/engcapa/taomni/actions/runs/43781962402)，源码 `038b539a413ec44b248f3eb25801c0407c067bc1`，23/23 jobs 成功。21 份 artifact 均在执行期间下载到 `qa-ui-auto-report/github/43781962402/live-contracts/`，已复核实际日志：三端每端 13 个真实下载场景、7 个宿主真实进程场景、1 个 profile/插件写锁崩溃释放场景通过；四目标 capture/RDP 编译、三端公共库单元和 Linux 真实 Vault 4 项/核心生命周期精确过滤器通过。这一 run 尚未包含下面新增的 D 实现。
- [UI Platforms #43782128064](https://github.com/engcapa/taomni/actions/runs/43782128064)，相同源码，六个 browser shard 已即时采集；Linux/Windows/macOS 每端 35/35，无 case fail/skip。Windows 官方包在签名前拒绝前端字节差异：可信文件 95 bytes/0 CRLF，Windows artifact 99 bytes/4 CRLF，且仅将 CRLF 换为 LF 后逐字节相同。`.gitattributes` 已对该官方前端固定 LF，签名器的严格 `read_bytes()` 比较不放宽。该依赖失败会阻断所有 native jobs，因此结束该轮无法进入 native 的执行，待修复和 D 批次新 SHA 重跑；native 用例未执行，不计通过。
- 新实现：`RpcRequest.context`、握手 `coreServices`/`hostInstance` 为 v1 可选加法，旧 params 和 hello 保持不变。`CoreServiceDispatcher` 默认 2 workers/16 queued，session 最多 8 个请求，校验方向 ID、已认证实例、context、deadline、owner/manifest 和 replay。`SensitiveServiceFrame` 原样进入 writer 队列，dequeue 重新验证并持有 permit 到 flush/drop。active、idle、cancel grace 使用同一 pump。
- 新 `taomni-plugin-sdk` 的独立读循环持续响应心跳、取消和 revoke，业务 worker 等待 typed key reply；raw JSON 直接解析为 `FixedKeyResult`，在交付业务 worker 前清零原帧和已消费的 read scratch。密钥 guard 绑定 operation，成功/失败/panic/cancel 清理；不经过通用 Value。核心真实 Vault 已实现 backend trait，仍保持旧固定 ID、缺 key/损坏语义和仅显式初始化/重置可写。
- 本批 API 16、services 19、SDK 7、host 14，共 56 项进程内纯单元通过。新增 6 个 `taomni-host-gates/tests/services.rs` 场景及 2 个根 `vault::plugin_access::host_tests` 场景只编译、不在本机执行；workflow 已接三端 SDK stdio、慢 reverse 时心跳/独立 deadline、取消、实例替换、revoke/新 epoch 和 renderer 不可扩权，以及 Linux 真实旧 key/空库初始化。它们不是已安装/签名 MFA 插件的升级证据。
- 本批没有新增用户入口，复用 TC-MODULES-001/006/007/008/009 与完整 crash-regression 保护既有启动、安装、宿主和退出行为；新增协议边界由上述 hosted 原生进程场景验证。真实 MFA UI 迁出仍须注册/执行计划的 TC-MODULES-020–025，不能用 fixture 代替。
- D 尚需从 verified registry/bootstrap 构造生产 services factory、在 host mutex 前取得外层 permit，并与真实 Vault lock/unlock/rekey、profile generation 和任务退出统一协调；之后再推进 E–I。当前 SDK fixture 不是第二个已交付业务插件。

当前顺序以上方“当前待办”为准。远程 main 已在上一轮拉取并纳入当前分支；历史成功只绑定其各自输入，不替代后续源码验证。

## 验收闭合条件

| 验收 | 当前剩余边界 |
|---|---|
| AC-001/010 | 核心瘦身和 10 个有效插件功能等价，只有 DEC-2 明示例外。 |
| AC-002/005 | 实际 tab 动态加载、缺失占位和保留会话可编辑/导入。 |
| AC-003 | 三代理、取消/续传、后台恢复要在完整商店与原生网络边界验证。 |
| AC-004/007 | 生产监督、稳定错误码、取消、进程树回收及运行中生命周期。 |
| AC-006/017 | 真实已安装 0.5.x → 模块化，数据/Vault 一致与失败恢复。 |
| AC-008/009 | 签名、内容绑定、防降级、安全解包及原子发布，单插件可独立更新。 |
| AC-011/015/016 | 多进程静默/profile 协同、作用域密钥和一致备份恢复。 |
| AC-012/013/014 | 四发布目标、多端功能/crash/性能、核心版和完整插件版的最终证据。 |

G1–G11 均待完整原生实验闭合，不能以纯单测替代。V-001–V-012 按上述实现批次补齐，已有验证只保护其实际输入与断言。

## 最近已完成的验证

以下记录针对源码 `2a245d52d07680d76a3cfd1f4240a484d2598ed7`，后续改动需重新选择受影响验证。

- [QA UI Auto Platforms #43732808941](https://github.com/engcapa/taomni/actions/runs/43732808941)：Linux、Windows、macOS 的 browser 各 22/22、native 各 25/25；包含 TC-MODULES-001–005 和完整 crash-regression。18 个预期 shard 均已在执行期间采集，无失败、skip、缺失或环境阻塞。
- [QA Modular Upgrade Contracts #43737735365](https://github.com/engcapa/taomni/actions/runs/43737735365)：Ubuntu、Windows、macOS 均通过。这是契约/单元测试工作流，尚不证明真实安装升级。
- 本地近期迁移单元测试 10/10、Settings/ModuleStore 29/29；TypeScript、rustfmt 和 refactor boundary 检查通过。更早 Rust lib 全量结果不能代替新改动后的验证。

原始 artifact 下载到 gitignored 的 `qa-ui-auto-report/github/<run-id>/`；当前 run 的完整 shard 索引位于 `43732808941/live-shards-final/live-shard-index.json`，summary/selection 位于同 run 的 `summary-final/`。最终证据要关联实际源码 SHA、case、平台和构建身份。

本地只跑单元测试与静态检查；browser/native、跨进程及真实安装升级在 GitHub runner 执行。每轮包含受影响 case 与完整 crash-regression，运行期间立即采集已完成 shard。与本次修改无关且有依据的既有失败可以单列忽略；本次引入的失败必须修复重跑。


## TASK-003 采集下沉测试设计与证据

本批保持设计 §4.2.1 的六项行为约束：Linux capture 库不引入 xcap；macOS 静态/录制继续用一次性快照而 RDP 保留 SCK/显示流；Wayland ScreenCast、指定显示器流和 MFA Screenshot portal 保持不同授权流程；BGRA/stride/帧时间戳及 MFA TQF1/灰度顺序不变；窗口隐藏、取消和源回收可重入。截图日志改为核心 `taomni::capture`，真正 RDP 流仍由服务器注入日志；已检索现有 YAML/Vitest，没有依赖旧截图 RDP 日志的断言。

改前依据为 `2a245d52d07680d76a3cfd1f4240a484d2598ed7` 的生产实现与既有用例。该 SHA 的历史模块/crash 测试通过不能当作这批真实采集的改前运行基线；本批特定 still/record/scroll/MFA/Mobile/RDP 改前性能比较尚无同条件原始样本。以下新增步骤全部追加，保留原有像素、错误分支、延迟和吞吐预算，不放宽失败条件。`0f4cdf82f` 的 browser/native 正在执行，已取得的部分 case 与采集契约证据见上方 run 记录，尚无完整 UI/crash 通过结论。本地采集边界测试 4/4、边界 CLI、9 个修改 case 的 schema/behavior contract、完整 `qa_ui_auto.audit --gate` 与 `git diff --check` 通过。静态 selected plan 已验证 25 个目标/保留 case 加 crash-regression、三端 browser/native 与 Linux Xvfb/Wayland、release native 共 22 个预期 shard，`gaps=[]`；当时的未提交 plan 不能当运行证据，实际运行必须关联最终源码身份与新 selection。

| AC / V | 场景与保留合同 | 用例、步骤和预期结果 | 层 / fixture / native 原因 |
|---|---|---|---|
| AC-001/010；V-003 | 核心截图取消再开，保留同一个终端 | 更新 `TC-104`：既有按钮取消后重开当前窗口截图，仍为未选区状态；Escape 后 overlay 消失且仅一个原终端 pane，运行时无错。 | browser、`reset_db`；只证明 renderer 与 stub 分发，真实窗口由 N28/N30 保护。 |
| AC-010/012；V-003 | MFA 核心服务错误恢复与二维码数据保持 | 更新 `TC-MFA-007`：浏览器 desktop-only 失败后重开重试，仍能退出且原 HOTP 不变。更新 `TC-MFA-106`：真实成功导入→关闭外部 QR→no-QR→恢复外部 QR 再扫，duplicate-only review 禁止导入；Escape 恢复后仍只有原账户和 755 224。 | browser fake camera 与 native `reset_db`；106 的独立 topmost QR 和真实像素/隐藏恢复仅 Linux X11/Wayland、Windows，macOS MFA TCC 仍需单独证据。106 保留 `TC-BACKUP-AUTH-715` 的授权浏览器清扫前置边。 |
| AC-001/010；V-003 | Mobile 显示器切换、后台刷新和真实核心采集 | 更新 `TC-MOBILE-020`：从副屏关自动刷新、切回主屏、手动刷新，receipt 与已加载 PNG 对应主屏。更新 `TC-MOBILE-021`：保留真实 opt-in 403→开启、两次 PNG、独立 OS input/嵌入 Mobile Web 检查，新增 receipt 的 display/window/event 数量门。 | 020 browser `mobile_web` 仅模拟 HTTP；021 native `reset_db,mobile_service` 验证真实 IPC、OS 采集/输入，仅 Linux/Windows，macOS/Wayland 限制不变。 |
| AC-010/012；V-003 | 录制源释放后仍可截图 | 更新 `TC-SHOT-N5/N6`：原 GIF/MP4 每帧像素、nonce、时间轴/覆盖率全保留；随后立即执行真实 still，留非空图与尺寸并恢复主窗口。 | 三端 native `reset_db`；browser 不能证明编码器、系统资源或真实像素，N5/N6 共用对应 QA app 的构建。 |
| AC-010/012；V-003 | macOS 输入权限失败不污染采集权限 | 更新 `TC-SHOT-N15`：原自动滚动 Accessibility 拒绝持久错误与双出口全保留，随后真实 still 成功并恢复主窗口。 | macOS native `reset_db`；拒绝只注入隔离 QA 边界，不修改 TCC，Screen Recording 正常 grant 仍是 fixture 前置。 |
| AC-004/010/013；V-003 | RDP stop/restart 回收与帧合同 | 更新实际 ID `TC-RDPS-NAT-01-start-connect-display`：原认证/输入/拒绝/停止后再 Start，独立 probe 再收到图像且 painted_share≥0.95，第二 Stop 后连接拒绝。保留 `TC-RDPS-PERF-01-performance-budget` 的 M1≤500ms、M2 p95≤65ms、M3≥25.6fps、M4≤4905kbps。 | 三端 native；真实 NLA、OS source、输入和外部 probe。PERF 要 `release_build_required` 和同条件基线；不能用 debug build 或单次绿结果替代性能比较。 |
| AC-001/010；V-003 | 依赖闭包与数据格式 | `scripts/modular-boundaries.mjs` 拒绝 screenshot/MFA/mobile 的 Servers 耦合，唯一精确例外是 `mobile/headless.rs` 建表；拒绝 library 的 Tauri/Wry/core dependency 和非 macOS/Windows 的 xcap。`taomni-capture::pixels::tests` 检查 stride/Bytes clone/灰度顺序与透明合成、短帧/溢出；原引擎/权限/取消 unit 保留。 | 本地 unit/static；GitHub Linux `cargo tree -p taomni-capture --target x86_64-unknown-linux-gnu --edges normal,build,dev` 的输出交 `node scripts/modular-boundaries.mjs --linux-tree <path>`，拒绝 transitive xcap/Tauri/Wry。 |

本批最小选择是上述目标和保留行为的去重并集，额外包含：`TC-SHOT-N1`（真实 still/OCR/clipboard）、`TC-SHOT-N2/N9/N16/N22`（自动/手动/重复滚动、停止输入与完整像素）、`TC-SHOT-N27/N28/N30`（启动计时、真实窗口隐藏隔离、resident 源生命周期）；browser 保留 `TC-SHOT-003/008/020/027/029/030/031`（滚动预览与导出、录制取消/保存、权限错误/手动模式）。还必须加入完整 `crash-regression` tag。使用现有 policy 已注册 ID，不新增用例编号；依赖表为新增生命周期断言补显式无前置条目，不依赖旧 case 的隐含进程状态。

GitHub 另外在 Xvfb 的真实 X11 display 上 opt-in 执行 `cargo test --manifest-path src-tauri/Cargo.toml -p taomni-capture --lib -- --ignored` 的 3 个源测试。它们现在要求 DISPLAY、MIT-SHM/XDamage fixture 真正可用，缺失即失败；普通本地 unit 不触屏且不会把无 display 的早退计为 native 成功。`43774556826` 已通过四目标 check、各 runner 架构 unit、Linux tree 与 3 项真实 X11 测试并下载 artifacts；对应 UI/native case 仍随 `43774557089` 执行，按已完成 shard 即时下载。

局限继续显式保留：`capture.still` 大帧 RPC 尚未接入；macOS MFA 屏幕录制归属、Linux Wayland 三授权流程和 RDP 性能需要对应真实 runner；本地 schema/audit、较小文件或成功编译均不证明这些行为等价。

## TASK-004 RDP 公共库边界与保留行为

改前材料是 `2a245d52d` 的客户端/服务端实现；集成基础为已包含远程 main 修复及 host/capture 的 `0f4cdf82f`。`taomni-rdp-common` 负责 CLIPRDR 编解码、CF_HTML/DIB/DIBV5 与策略值、7 个有界文件操作 helper，以及可选 `bitmap` 能力协商。`taomni-file-uri` 仅以标准库提供既有宽容 URI-list 编解码，核心 `config::paths` 直接依赖它，关闭 RDP 业务也不必引入协议依赖。RDP 旧 facade 保留兼容导出；服务端和 loopback 测试直接用共享库，不再调用客户端实现。bitmap 使用同一个 `ironrdp-pdu 0.9.0`，QOI/QOIZ 与原客户端解码 feature 一起保留。

配额、请求/stream 关联、取消、staging 的 Drop/Once 清理、延迟剪贴板发布和 session 生命周期仍归原客户端/服务端持有。逐函数复核确认 7 个文件 helper、URI、CLIPRDR 与 HTML/DIB 的原逻辑和错误文本保持不变。单元补足 UTF-16 长度、路径穿越/盘符/ADS、偏移读写与 16 MiB 上限、私有目录、Unix 符号链接不修改目标、Unicode/非法百分号 URI 和 bitmap offer。新文件最大 427 行，测试按协议/格式/文件行为独立拆分。

本任务只改变实现归属与依赖，没有新增 UI 流程或改变协议/持久化，所以复用下列已注册、已断言真实结果的用例，不新增仅断言内部模块名或重复现有步骤的 YAML。完整 ID 与模式如下；这是目标和受影响保留行为的去重集合，不是已通过的执行结果。

| AC / V 与保留行为 | 已有用例及真实断言 | 执行边界 |
|---|---|---|
| AC-009/010；V-003：产品客户端/服务端能力配对 | `TC-RDPJ-01-client-server-loopback`：真实客户端显示宿主桌面、点击改变独立宿主 target、全屏连接栏与断开后服务端再次接受 probe。 | 三端 native；browser 不含 IronRDP 会话解码/OS 输入，独立 probe 不能代替产品双方配对。 |
| AC-010/012；V-003：富格式与图像编解码 | `TC-RDPS-NAT-02-clipboard-rich`：真实主机剪贴板与外部 CLIPRDR probe 的 Unicode、HTML 和图像双向传输，保留原格式/内容断言。 | 三端 native，真实 OS 剪贴板；不由 stub 成功替代。 |
| AC-010/012；V-003：文件路径、内容和 staging 发布 | `TC-RDPS-NAT-03-clipboard-files`：双向 Unicode 多层目录，主机发布的 staging 树与客户端下载的每个相对路径和 SHA-256 相同。 | 三端 native，真实文件与剪贴板；安全拒绝/大小上限的组合由共享库 unit 另行覆盖。 |
| AC-010/012；V-003：策略依旧限制两个方向 | `TC-RDPS-NAT-09-clipboard-policy`：text-only 不发布 HTML/图像/文件，禁用反向后不请求客户端数据且主机剪贴板不变。 | 三端 native；UI 保存本身不证明策略执行。 |
| AC-010/012；V-003：同机双方没有回声 | `TC-RDPJ-02-joint-clipboard-no-echo`：产品双方同机、主机内容正确、日志计数与 quiet period 保留，断开后服务仍可用。 | 三端 native，真实共享系统剪贴板和变更计数。 |
| AC-010/012；V-003：延迟发布仍只转发一次 | `TC-RDPJ-03-deferred-clipboard-publication`：macOS AppKit 先声明类型、1.2 秒后同 token 发布文本，保留内容、公告次数、六秒静默与退出断言。 | macOS native 专项；其他平台按现有 capability/policy 选择，不能计为已执行。 |
| AC-010；V-003：配置控件与持久化保持 | `TC-RDPS-UI-03-rdp-media-clipboard-settings`：默认值、双向策略、文件限制条件显示、Apply 后重开恢复。 | **仅 browser**；该 case 未声明 native，原生策略证据由 NAT-09 提供。 |

六个 native case 为 RDPJ-01/02/03 与 NAT-02/03/09；browser 额外是 UI-03。按平台能力执行实际子集，不把 macOS 专项扩报为三端通过。下一次 `qa-ui-auto-platforms` selection 与 TASK-003 的 NAT-01/性能、模块场景和完整 `crash-regression` 取去重并集；平台 workflow 原有 RDP/dual-display contract 继续开启，不再在升级 workflow 重复全量 RDP。

基于 `0f4cdf82f` 的 Linux 本地集成验证已完成：`cargo metadata --locked`，两库 `--all-features` 39/39、common `--no-default-features` 30/30、模块边界脚本 6/6、`pnpm check:refactor`（799 命令、274 facade exports、29 events）均通过；这不是其他平台或真实 UI/剪贴板证据。Windows 不编译 Unix symlink 测试，预期数量相应少一项。common 的 minimal normal/build tree 仅自身、`libc` 和 URI 库，URI tree 仅自身；静态门禁止 servers/config 导入客户端、共享库导入核心/Tauri/Wry，以及 URI 库增加 runtime/build 依赖。

`qa-modular-upgrade.yml` 新增四发布目标 shared-library `cargo check --all-targets --all-features`、三个 runner 架构的完整/minimal 纯 unit 和严格 normal/build tree allowlist。原 host/capture job 保留；Linux 升级 job 仅追加 `rdp::session::tests::input_and_channels`、`servers::rdp::clipboard::tests`、`config::tests` 三组原调用方单元过滤。日志分别归档为 `modular-rdp-check-*`、`modular-rdp-unit-*`、`modular-retained-rdp-core-linux`。本提交的这些 hosted job 与上表 UI/native 尚待执行，不能用 `0f4cdf82f` 或 `2a245d52d` 的成功代替。
