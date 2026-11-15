# 模块化实施与验收台账

更新：2026-11-16。范围以[设计 §10.1](taomni-modular-split-design.md#101-可执行任务分解)与 [ADR](../claudedocs/adr-taomni-modular-split.md)为准。基础契约通过不代表业务已迁出或可发布。

## 当前结论

核心仍包含 MFA、Servers、SocksCap、远程桌面和本地语音等业务代码、状态与依赖。目前唯一独立宿主是 hello-plugin。LanChat 已删除；历史 `lanchat.sqlite` / `lanchat.db` 保留原位，不读取、不迁移、不删除。

生产升级 IPC 当前只记录只读预检、源指纹与 pending journal。缺少可信插件包和真实 exporter 时，不复制旧数据、不创建伪插件版本、不改变 active 指针。测试 fixture 的 staging/回滚原语不能算真实旧版升级验收。

签名安装门、宿主生产监督和共享采集下沉已由 `0f4cdf82f` 提交，正在 GitHub 验证；宿主与采集已有下述部分通过证据，UI 和升级核心单元仍在运行。TASK-004 的公共库、核心 URI 接线与依赖门已集成到下一批隔离提交，尚待该提交的 hosted 结果。随后按设计依赖闭合核心状态、数据服务与真实插件。G1–G11 未通过前，不将具体业务插件迁移标为完成。

## 任务状态

| 任务 | 状态 | 尚需交付的结果 |
|---|---|---|
| TASK-001 基线 | 部分 | 四个发布目标的真实安装包尺寸、启动/内存/吞吐原始样本；源码与依赖起点已有记录。 |
| TASK-002 契约 | 部分 | API、manifest/schema、registry、RPC 已有；待真实插件与 G 门验证后冻结。 |
| TASK-003 共享采集 | 已提交，hosted 验证中 | 引擎/权限/像素/一次性采集已下沉 `taomni-capture`，核心 `capture/` 持有显示器/帧源/窗口生命周期；仅保留 headless 建表例外。四目标 check、三平台库 unit 与 Linux 三个真实 X11 测试已通过，真实截图/MFA/Mobile/RDP/性能及完整 UI shard 仍待结果；`capture.still` 宿主大载荷 RPC 仍依赖 TASK-002。见下方测试设计。 |
| TASK-004 RDP 公共库 | 代码已集成，待 hosted 验证 | `taomni-rdp-common` 与零依赖的 `taomni-file-uri`；客户端与服务端共享能力只经库依赖，config 直接用通用 URI 库。基于 `0f4cdf82f` 的集成单元完整功能 39/39、关闭 bitmap 30/30 及边界检查通过；四目标/三平台和精确保留场景待本提交 hosted 证据。见下方 TASK-004 记录。 |
| TASK-005 核心状态 | 待开始 | CoreState、PluginRegistry 与宿主业务状态分离。 |
| TASK-006 核心依赖闭包 | 待开始 | Cargo 默认 features、bundle/resources、平台依赖与核心前端 chunk 真正移除已迁移业务。 |
| TASK-007 前端注册和路由 | 部分 | loader/helper 已有；接入主窗口/分离窗口实际 tab、完整性校验、缺失/禁用/坏 chunk 与卸载清理。 |
| TASK-008 宿主监督 | 已提交，部分 hosted 通过 | 主动心跳、重启预算、请求取消及三平台进程树回收已接入；GitHub 三平台各 14 项 unit 与 7 项真实进程测试通过，双向核心服务与 profile 协同仍待后续任务。 |
| TASK-009 生命周期 | 部分 | 版本目录、active 指针与生命周期 IPC 已有；接可信安装门、运行中切换/回滚、无重启生命周期。 |
| TASK-010 商店/下载 | 部分 | 原生 HTTP、代理、续传、取消/进度 IPC 已有；接远端商店、代理设置、后台恢复、离线安装与错误恢复。 |
| TASK-011 验签安装 | 代码已集成，验证中 | pinned key 的真实 minisign 校验、清单防回滚、安全解包、内容绑定及安装入口强制验签已接入；待官方签名 artifact 成功路径和多端原生证据。 |
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
| TASK-024 入口/profile 协同 | 待开始 | re-exec 归属、ModeLease/ProfileLease、还原前宿主静默、headless 模式。 |
| TASK-025 密钥/一致快照 | A/B 基础实施中 | [服务、锁与快照实施方案](taomni-modular-vault-services-plan.md)；typed DTO/lease/SQLite helper 开发中，C–I 生产接线、MFA 迁出与三态备份还原未完成。 |

具体编号与子任务边界仍以设计原表为准；上表合并描述不改变范围或依赖。

## 当前开发批次（`0f4cdf82f` 已提交，hosted 验证中）

- 验签路径采用与核心 updater 相同的固定公钥，校验真实 Minisign 签名、清单 sequence/内容、平台/版本/API、包 SHA-256 与内部精确文件清单。任意目录安装入口拒绝，版本目录保存签名原包供扫描、启用、启动、回滚和自动重启重新认证。离线安装入口已接入设置页；官方签名包的成功 UI 安装尚缺真实 artifact 验证。
- 安装失败恢复旧 active 指针和 registry 投影；卸载后普通安装也拒绝降级。前端 URL 包含不可变版本，逐资源返回经过签名文件 hash 核验的实际字节；实际业务 tab 的动态插件路由仍未完成。
- 生产宿主接入主动心跳、预算重启、请求 ID、稳定 RPC 错误与取消、退出清理。Windows 使用 Job Object；Linux 使用稳定 spawn-owner、PDEATHSIG 和 ownership guardian；macOS 使用 kqueue guardian。Unix 官方宿主及子孙须留在所属 session/process group，不允许 daemonize 逃逸；本方案不构成第三方沙箱。多进程 profile/备份静默仍属 TASK-024。
- 旧的伪版本 staging/active 迁移执行器已限制到测试编译；生产只保留安全 pending。
- `QA Modular Upgrade Contracts` 扩展为三端真实宿主生命周期/核心强杀清理、四发布目标采集库检查及 Linux X11 原生源测试。这些测试仍不证明已安装 0.5.x 的真实升级、系统签名信任、TCC、noexec、吞吐或 profile gates 已通过。

安装保留一份压缩原包作为可重验凭据，会增加数据目录空间占用。大于 32 MiB 的包必须使用 Minisign ED 预哈希签名；单个前端资源读取上限 256 MiB。Catalog 发布中断时不降低安全水位，重新获取同一或更高序号的签名清单可恢复安装。上述约束应纳入最终包构建、空间预检和发布演练。

`0f4cdf82f` 最终本地 Rust 受影响单元 139 passed（plugin 85、host 14、screenshot 11、MFA 13、mobile 6、RDP display 10），fmt、完整 QA audit 与 check:refactor 通过。此前模块/设置/离线安装前端 55 passed、URL loader 14 passed；采集库 21 passed，3 个真实 X11 测试仅 hosted opt-in。TASK-004 集成后的新增公共库和边界检查结果单列在下方，不混计为旧批次证据。

[QA Modular Upgrade Contracts #43774556826](https://github.com/engcapa/taomni/actions/runs/43774556826) 已取得并即时下载三平台宿主 artifacts：每端 14 项 unit 与 7 项真实进程测试通过。四个 capture 发布目标 check 通过；Windows 12、macOS 18、Linux 21 项库 unit 通过，Linux 另有 3 项真实 X11 测试通过。该 run 的 Linux 核心升级单元仍在执行。原始 artifacts 位于 `qa-ui-auto-report/github/43774556826/upgrade-live/`。

[QA UI Auto Platforms #43774557089](https://github.com/engcapa/taomni/actions/runs/43774557089) 的 22 个预期 shard 正在运行，已在其他构建/用例执行期间取得 Linux browser shard 2 的 `TC-008` pass。这只是一个已下载 case 的结果，不能视为整 shard、三端 UI、完整 crash-regression 或本批整体通过。

## 接下来的执行顺序

1. 继续监控 `0f4cdf82f` 的 GitHub 三端 browser/native、完整 crash-regression、升级核心单元与采集验证，完成的 shard 立即下载分析，修复本次回归后重跑。远程 main 已重新拉取，当前分支已包含 `e8e3afc0f`，无新增合并冲突。
2. 完成 TASK-004 公共库、四目标/三平台契约及下述精确保留场景的 GitHub 验证，接着拆 CoreState、宿主业务状态与核心依赖闭包；完成双向核心服务 RPC 和大帧数据通道，随后闭合 TASK-024/025。
3. TASK-025 必须保持旧固定密钥 ID `mfa.data-key-v1` 和已有密文缺密钥时的错误语义。反向 RPC 从已认证会话取得宿主身份，并同时限制固定条目归属、manifest 声明和权限；不能接受宿主自报 slug。锁 Vault 时须阻止新调用、取消在途调用、撤销宿主密钥，未确认清零则终止宿主。
4. 备份/还原须建立跨进程写入屏障并保持 MFA → Vault 锁序；同实例禁用或未运行不能作为文件可直接复制的依据。文件回退必须取得插件数据独占锁，并处理 SQLite WAL；运行中、已禁用、卸载保留数据三态都要验证还原后重启、解锁和真实账户解密，另测取消、崩溃和跨实例写入。
5. 完成远端商店、三种代理、后台下载/重启续传、实际 Tab 动态路由和无重启生命周期；实现真实旧版 exporter、可信包激活及失败回滚，取得已安装单体版本升级证据。当前 pending 不等于已完成迁移。
6. 按前置条件与 G1–G11 结果逐个迁出业务插件；Mobile 按 DEC-2 做 go/no-go。最后完成四发布目标的系统/包签名、原子清单发布、独立插件更新/回滚、核心版与全插件版回归，以及尺寸、性能和资源基线。

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
