# Taomni 模块化重构交接

## 0.6.0 当前候选

当前产品 SHA 为 `5e53df106549b9fa8a49e435120fc820c8e608ca`，已合入 `main` 的 `07031c6f5`。Windows 更新后首次启动使用桌面环境，基座继续清理旧单体语音 DLL，SocksCap 和 VNC 的宿主入口归各自模块。0.6.0 暂缓上线。四目标依赖清点已通过。三端原生运行合并验证十模块的双版本生命周期、业务迁移、备份还原和篡改拒绝。最新稳定单体实装与全模块回归复用这轮打包的签名资产。[候选提交](https://github.com/engcapa/taomni/commit/5e53df106) · [四目标构建](https://github.com/engcapa/taomni/actions/runs/45556290903) · [核心清点](https://github.com/engcapa/taomni/actions/runs/45556295313) · [纯核心回归](https://github.com/engcapa/taomni/actions/runs/45556300017) · [十模块原生验收](https://github.com/engcapa/taomni/actions/runs/45556693711)

11 月 25 日 15:46（北京时间），四端基座安装件已归档。四端 updater 验签通过，17 个资产摘要与 11 个更新目标已逐项匹配。Windows 默认 NSIS 的原单体和候选安装在同一路径，升级后启动的程序与候选 NSIS 包内字节一致，原有四个语音 DLL 全部移除。回退后原程序、四个 DLL 和原 SSH/VNC 会话均恢复。首轮验收脚本误用 MSI 的程序摘要，修正后用同一产品安装件复验通过。[updater](https://github.com/engcapa/taomni/actions/runs/45556290903/artifacts/15000775815) · [NSIS 首轮](https://github.com/engcapa/taomni/actions/runs/45568185856/artifacts/15001595470) · [NSIS 实装与回退](https://github.com/engcapa/taomni/actions/runs/45568698025/artifacts/15001931217)

Linux 原生历史升级回归 30/30 通过，覆盖当前及旧 NewMob 数据库文件名下的 SQLite WAL、先前待应用的备份和跨版本安装冻结名单。三端真实宿主、协议及系统执行专项已通过。Wayland 五项截图、MFA 和 RDP 专项均通过，可见动画帧率 41.81 fps，40/40 个延迟样本的 p95 为 52.16 ms。附带用例的四个失败已逐项与历史运行对照，失败步骤和错误相同。三个右键用例在本候选的 Xvfb 原生环境通过，第四项是授权夹具拒绝当前 XDG 目录。[历史配置](https://github.com/engcapa/taomni/actions/runs/45564802462) · [协议](https://github.com/engcapa/taomni/actions/runs/45564723372) · [宿主](https://github.com/engcapa/taomni/actions/runs/45564732594) · [Wayland](https://github.com/engcapa/taomni/actions/runs/45566118029) · [Wayland 历史对照](https://github.com/engcapa/taomni/actions/runs/45509531362)

四目标各自验证了正式单体 → 模块化候选 → 正式单体 → 模块化候选。首次升级自动装齐十个签名模块，手动卸载 Mail 后重新打开仍保留九个。SSH 主机密钥和 RDP TLS 身份跨升级与回退保持一致，Linux 另行复核了附件字节、旧邮件与新邮件、MFA 计数。Mac 两种架构验证权限延续。Windows 另用默认 updater 的 NSIS 载荷验证语音 DLL 清理和回退恢复。旧 Vault 密码仍由用户本机解锁。[四端实装](https://github.com/engcapa/taomni/actions/runs/45571113510) · [Linux 补验](https://github.com/engcapa/taomni/actions/runs/45572953475) · [Windows NSIS](https://github.com/engcapa/taomni/actions/runs/45568698025/artifacts/15001931217)

十模块生命周期在 Linux、Windows、macOS ARM64 分别通过 100 个阶段，业务迁移专项覆盖全部十模块。签名 MFA 和 Mail 额外通过 48 和 6 次专项执行。生产发布演练使用同一产品 SHA，成功复用四目标的 17 个基座文件、40 个签名模块包，并用正式下载地址生成签名目录。公开发布步骤已跳过。[生命周期与业务迁移](https://github.com/engcapa/taomni/actions/runs/45556693711) · [MFA](https://github.com/engcapa/taomni/actions/runs/45571328671) · [Mail](https://github.com/engcapa/taomni/actions/runs/45571340099) · [生产演练](https://github.com/engcapa/taomni/actions/runs/45573947330/artifacts/15003203574)

纯核心三端 Browser/Native 回归通过 132/132。全模块回归的 Linux 原生分片首次初始化时，工件下载工具漏取第二页中的 Mail 包，原件保留。验收工具已修正分页，并以相同源提交与签名包补跑 Linux。[纯核心](https://github.com/engcapa/taomni/actions/runs/45556300017) · [全模块原运行](https://github.com/engcapa/taomni/actions/runs/45571123435) · [Linux 补跑](https://github.com/engcapa/taomni/actions/runs/45573044507)

macOS ARM64 的纯核心在窗口就绪时测得 RSS 中位数从 221.84 MiB 升至 396.69 MiB，启动就绪快 815 ms。每个版本各启动三次，单体的第三次读数明显高于前两次。设计 §11 要求纯核心内存不劣于现版，已派发四轮配对复测，使用相同权限、交替启动顺序，分别采集就绪与稳态 RSS、physical footprint 和内存分区。Windows、macOS Intel 和 Linux 的原运行核心 RSS 分别减少 8.45、2.92、11.95 MiB。[ARM64 原始采样](https://github.com/engcapa/taomni/actions/runs/45571113510/artifacts/15001309935) · [配对复测](https://github.com/engcapa/taomni/actions/runs/45577594130) · [性能目标](taomni-modular-split-design.md#11-测试与验收)

上一候选 `f69c52f2e` 加入旧 MFA 账户迁移提示和 SocksCap 安装时的数据接管。该轮纯核心 Browser/Native 通过 132 项，Linux Mobile 原配置补跑通过。旧 MFA 导出测试因缺少测试依赖首次编译失败，修正后在同一候选迁移源码上通过 Linux、Windows、macOS Intel 原生导出。打包和生命周期任务已移交至新候选。[纯核心](https://github.com/engcapa/taomni/actions/runs/45540715604) · [导出复验](https://github.com/engcapa/taomni/actions/runs/45554945039)

实装工作流默认选择当时公开的稳定单体版本，记录 Release ID 和四个目标各自的资产 ID、字节数、SHA-256。四个平台在同一次验收中复用这份记录。放行时再查询 GitHub 公开版并与实装回执匹配。单体发布有更新时使用新基线复验，涉及主线产品改动时同步更新候选和对应回执。历史版本号用于重现已执行的测试。[滚动基线实现](https://github.com/engcapa/taomni/commit/04e6e0497) · [首次自动选择的实装](https://github.com/engcapa/taomni/actions/runs/45538704639) · [公开稳定版](https://github.com/engcapa/taomni/releases/latest)

生产放行前，取最终四目标实装运行的 `first-upgrade-baseline-<run-id>/first-upgrade-baseline.json`，执行下列复核。四端实装时将 `package_first_release_version` 留空。若公开单体版本或任一安装资产已变动，重新派发四端实装，再以新回执复核。若主线改动需要合入产品，按新产品 SHA 重新打包并收证。[实装工作流](../.github/workflows/qa-modular-upgrade.yml)

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.legacy_baseline \
  --verify-current first-upgrade-baseline.json
```

### 十个独立模块的首次升级验收范围

| 模块 | 旧数据归属和需要验证的用户结果 |
| --- | --- |
| RDP Client | 已存 RDP 会话保留在核心会话库。将旧证书 pin 迁入模块数据库，重连和还原后仍识别原服务器。 |
| VNC Client | 原连接信息和会话标识保留在基座，安装签名 viewer 后从原会话重连。 |
| RDP Server | 迁入服务配置、TLS 证书和私钥，启动后保持原身份，停止或卸载后释放监听端口。 |
| VNC Server | 迁入服务配置，凭据经 Vault 保护。验收旧密码认证、停止和禁用。 |
| Servers | 迁入本地服务配置和 SSH 主机密钥。已有认证配置的服务使用原凭据，客户端继续识别原主机身份。 |
| SocksCap | 安装签名包时接管旧配置、选用的代理及已有规则缓存，保留原始文件。验证启用前模块文件、启用后规则效果和禁用后保留。 |
| Mail | 从旧库导入账户、缓存、归档和附件，所需重启由首装流程提示。验证原邮件、升级后新增邮件、卸载与回退。 |
| MFA | 工作区提示旧账户使用者输入原 Vault 密码，已安装签名包接管加密数据库。验证错误密码、重试、重启及 HOTP 计数连续性。 |
| Screenshot | 普通截图、滚动截图由基座提供。OCR、脱敏、GIF/MP4 编码由模块提供。验证真实像素、成品可解码和卸载后基础截图可用。 |
| Local Voice | 沿用已配置模型目录和模型文件，签名宿主负责离线识别。验证同一模型输入的识别结果及禁用后的状态。 |

上述条目定义业务验收范围。安装指针、包签名和空的 `legacyPending` 另行证明十个包已按首发名单装齐。原 Vault 密码由使用者在本机输入。[首发名单](../src-tauri/plugins/legacy-upgrade.json) · [受影响用例](../qa-ui-auto-tests/cases)

### 上一候选 60a4d99dc 的放行复核

产品源码为 `60a4d99dc2ad924963b7e46568b54164f7e5e9fd`，远端候选分支为 `rc/modular-0.6.0`。开发分支上的后续提交修正 QA 驱动并补足实际安装观测。公开版仍为 v0.5.13。 [候选引用](https://github.com/engcapa/taomni/tree/rc/modular-0.6.0) · [公开版](https://github.com/engcapa/taomni/releases/tag/v0.5.13)

| 放行依据 | 结果 |
| --- | --- |
| 安装件与签名 | Linux x64、Windows x64、macOS ARM64、Intel 四个目标交付基座，十个 stable 模块各四个包。发布选择器对冻结分支实际选出 4 份基座工件、40 份模块工件、1 份 updater 工件。使用发布脚本复核复用输入，通过 17 个核心资产摘要、40 个模块及 macOS 固定签名身份记录比对。 [构建和验签](https://github.com/engcapa/taomni/actions/runs/45505517152) |
| 迁移与回退 | 四目标完成 v0.5.13 → 0.6.0 → v0.5.13 → 0.6.0。Linux 邮箱实装迁移保留旧邮件 UID 1 和归档原文，升级后同步新邮件 UID 2，卸载保留模块数据，回退可读旧邮件。deb、RPM、AppImage 三种格式均验证 noexec 拒绝和搬迁恢复。 [Linux](https://github.com/engcapa/taomni/actions/runs/45533440378/artifacts/14985823182) · [Windows](https://github.com/engcapa/taomni/actions/runs/45524159453/artifacts/14981703294) |
| 原生权限 | macOS 两架构均记录固定签名身份和 Gatekeeper、升级前后屏幕录制与辅助功能状态、签名 MFA 识别外部二维码。Mobile 在桌面端配对，默认拒绝屏幕请求，勾选后取得 PNG，受管窗口收到文本和 Enter。Windows 记录下载宿主在 Defender 开启时运行。 [ARM64](https://github.com/engcapa/taomni/actions/runs/45534494663/artifacts/14987211263) · [Intel](https://github.com/engcapa/taomni/actions/runs/45534494663/artifacts/14986262563) |
| 生命周期与崩溃回归 | 十个模块在 Linux、Windows、macOS ARM64 各通过十个阶段。纯核心 Browser/Native 共 140/140，全模块 155/155。Windows 原失败分片及同源码补跑已并列归档。 [纯核心](https://github.com/engcapa/taomni/actions/runs/45505570023) · [Windows 补跑](https://github.com/engcapa/taomni/actions/runs/45511844676) · [全模块](https://github.com/engcapa/taomni/actions/runs/45519040386) |
| RDP 性能 | Linux 安装版 RPM、签名 RDP 服务端和独立探针测得首帧 68 ms、可见动画帧率 57.24 fps（`marker.observed_fps`）、414.06 kbps，40/40 样本、零超时，输入到画面 p95 为 39.47 ms，上限 130 ms。Wayland 专项 p95 为 68.77 ms。该专项另外四个夹具因 X11 右键或 XDG 目录前置条件失败，已保留原失败，同候选的标准 Linux 路线对应场景通过。 [实装](https://github.com/engcapa/taomni/actions/runs/45533440378/artifacts/14985823182) · [Wayland](https://github.com/engcapa/taomni/actions/runs/45509531362) |

该轮发布输入对应 `60a4d99dc`。更换产品 SHA 后，四目标安装件、十模块、升级回退、两种崩溃回归及 G1–G11 均以新候选重新取证。公开发布时复用最终通过验收的候选包运行，发布作业生成并验签正式 GitHub 地址的模块目录。历史原件路径、runner 镜像和摘要已归档。[上一候选逐门记录](taomni-modular-0.6.0-receipts.md) · [发布工作流](../.github/workflows/release.yml)

### 交付边界与维护方式

| 归属 | 0.6.0 范围 |
| --- | --- |
| 基座共享服务 | 主窗口、标签页、工作区壳、会话树与恢复元数据、Settings、网络代理、Vault、profile 和 GUI/headless 租约、备份协调、共享采集、更新器、模块商店、验签、权限、宿主启停和前端加载。 |
| 随基座发布的业务 | 23 种核心会话含终端、SSH、SFTP、本地文件、数据库、Redis、HBase 和对象存储。另含隧道和代理测试、Code Workspace（Git/LSP/DAP/构建）、Tao 聊天与 Agent、Notes、普通截图与滚动长截图、麦克风采集和云端 ASR。Mobile 首发归核心，含移动端连接、远控、飞书适配及 headless 入口。 |
| 可独立装卸的十模块 | `rdp-client`、`rdp-server`、`vnc-client`、`vnc-server` 各自发布。另有 `servers`（本地服务）、`sockscap`（按应用代理）、`mail`、`mfa`（验证器）、`screenshot`（OCR、脱敏与录制）、`ai-voice-local`（本地语音识别）。`hello-plugin` 用于 QA。 |

基座与内置业务随主版本更新。模块独立版本化，可启用、禁用、升级、回滚和卸载。已有单体用户首次升级至模块化版时，固定首发名单用于恢复原有功能。卸载清理代码和派生运行文件，用户显式确认永久删除前保留数据。 [首发名单](../src-tauri/plugins/legacy-upgrade.json) · [边界设计](taomni-modular-split-design.md)

开发按数据与接口归属落点。模块实现放在 `src-tauri/plugins/<slug>/`，通过公共 API 和获准共享 crate 使用基座能力，清单声明入口、权限、数据版本、迁移及备份。改模块须同步清单、测试、目录和签名矩阵。核心契约兼容时维持 `coreApiVersion`，破坏性变更才升级契约。测试从功能本身延伸至模块缺席、启停、双版本切换、失败恢复、数据保留，以及纯核心和全模块两种崩溃回归。真实安装、跨进程、系统权限和签名均留 GitHub 原始回执。 [仓库约定](../AGENTS.md)

只改核心时发布安装件和 `latest.json`，沿用已验签的模块目录。只改模块时重建该模块全部声明平台的包，在模块 Release 发布包、签名及递增序号的完整目录，再同步最新核心 Release 的目录。两者同时变更时共用草稿 Release，先传包及签名，再传签名目录和 updater 清单。 [核心与联合发布](../.github/workflows/release.yml) · [模块发布](../.github/workflows/release-modules.yml)

四个目标的基础安装包实测比 v0.5.13 小约 48%–50%。按本次工件大小计，安装全部十模块另需下载约 68.6–76.1 MB（十进制，按平台），因此全装总下载量比旧单体更大。独立发布和回退缩小了单次修复影响范围，代价是兼容、迁移、签名分发和跨进程排错。资源变化也因平台而异，两轮 macOS ARM64 实装的核心进程 RSS 中位数较 v0.5.13 分别高约 106 和 95 MiB。 [候选资产](https://github.com/engcapa/taomni/actions/runs/45505517152) · [ARM64 首轮](https://github.com/engcapa/taomni/actions/runs/45524159453/artifacts/14981658523) · [ARM64 复验](https://github.com/engcapa/taomni/actions/runs/45534494663/artifacts/14987211263)

## 2026-11-25 发布候选验收

公开版为 v0.5.13，0.6.0 暂缓上线。验收源码为 `60a4d99dc2ad924963b7e46568b54164f7e5e9fd`。该版本合入主线的窗口审批修复，审批状态接到 `CoreState`，Mobile 回调沿用现有状态归属。旧 E2E 工作流改用共享 Python 依赖，修复三条入口在 helper 单测导入 Pillow 时的缺失。 [公开版](https://github.com/engcapa/taomni/releases/tag/v0.5.13) · [候选](https://github.com/engcapa/taomni/commit/60a4d99dc) · [主线 #879](https://github.com/engcapa/taomni/pull/879) · [原失败日志](https://github.com/engcapa/taomni/actions/runs/45502680305)

- 上一阶段 `078fe8741` 的 RDP Server、VNC Server 在 Linux 和 Windows 各通过 10 个阶段。纯核心回归的 Windows Native 共 24 项，其中 `TC-FILE-OPEN-010` 在设置页取消脚本复选框时失败。两轮均缺 macOS Native 分片，GitHub 回执记录 runner 未分配。 `d6adb5a7c` 的四目标核心包与 updater 通过，但有七个 macOS 模块构建或签名作业未分配，未生成首装目录。 [服务端](https://github.com/engcapa/taomni/actions/runs/45427030060) · [纯核心](https://github.com/engcapa/taomni/actions/runs/45428206447) · [旧打包](https://github.com/engcapa/taomni/actions/runs/45420902624)
- 新候选四目标 Cargo、Vite 和入口清点已通过。GitHub 工件 `14973283284` 记录 `ubuntu24` 镜像 `20261116.133.1`，已逐一核对 15 个原始文件的长度和 SHA-256。G9 还需核对四目标实际安装载荷，G11 还需原生租约与入口回执。 [清点运行](https://github.com/engcapa/taomni/actions/runs/45505563614) · [原始工件](https://github.com/engcapa/taomni/actions/runs/45505563614/artifacts/14973283284)
- 候选采用主线固定签名配置，以 macOS 26 ARM64 构建两种 macOS 安装架构。Release Bundle 使用空 `tag`、`platforms=all`、`macos_arch=both` 和冻结的十模块名单。纯核心回归选 Linux、Windows、macOS 26 ARM64 的 Browser、Native release 模式，含完整崩溃回归和主线三条窗口审批用例。跨进程宿主契约已派发。 [打包](https://github.com/engcapa/taomni/actions/runs/45505517152) · [纯核心](https://github.com/engcapa/taomni/actions/runs/45505570023) · [跨进程契约](https://github.com/engcapa/taomni/actions/runs/45506223399)
- 十模块双版本生命周期先在 Linux 和 Windows 执行，包含完整崩溃回归、签名安装、后台续传、前三种 MFA 还原状态和 RDP Server 实际捕获与输入。macOS 轮次单独派发。已核对官方 v0.5.13 四个安装件的 GitHub 资产 ID、大小和 SHA-256 与夹具一致。 [生命周期](https://github.com/engcapa/taomni/actions/runs/45508735320) · [升级输入](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/legacy_release.py)
- 本地通过 Rust 编译检查和 14 项窗口路由单测、41 项前端单测、37 项 QA helper 单测、TypeScript、rustfmt、`pnpm check:refactor` 和 QA 静态审计。
- G10 的生产宿主适配器和真实 hello/MFA 进程在 Linux、Windows、macOS ARM64 各通过 38 项。超时、取消、重复请求和 profile 所有权的原始回执分别绑定 `ubuntu24/20261116.133.1`、`win25-vs2026/20261116.315.1`、`macos26/20261117.0516.1` 及宿主摘要。Linux Wayland 已派发采集、输入、RDP 性能和适用崩溃回归。 [Linux 原件](https://github.com/engcapa/taomni/actions/runs/45506223399/artifacts/14973594032) · [Windows 原件](https://github.com/engcapa/taomni/actions/runs/45506223399/artifacts/14972679873) · [macOS 原件](https://github.com/engcapa/taomni/actions/runs/45506223399/artifacts/14973464553) · [Wayland](https://github.com/engcapa/taomni/actions/runs/45509531362)
- 纯核心 Windows 原生分片在 Chocolatey 返回 503 后未能开始执行。QA 工作流 `508848590` 改用 Tesseract 官方发布的同版安装件，下载重试后核对固定 SHA-256，仍验证可执行文件和两份固定语言数据。已按新工作流派发 Windows 补跑，`head` 继续固定至候选 `60a4d99dc`，用例和产品源码以 selection、build identity 与 runner receipt 核对。 [失败分片](https://github.com/engcapa/taomni/actions/runs/45505570023/job/138854819875) · [QA 修复](https://github.com/engcapa/taomni/commit/508848590) · [Windows 补跑](https://github.com/engcapa/taomni/actions/runs/45511844676)
- macOS 十模块生命周期使用 macOS 15 ARM64，包含签名 RDP Server 和截图权限相关用例。Wayland 的五个专项用例全部通过，RDP 首帧 119 ms、延迟 p95 68.77 ms（上限 130 ms）、40/40 有效样本、39.33 fps、836.46 kbps。该轮附带选集的 `TC-FILE-OPEN-006/008` 与 `TC-EXPLORER-013` 触发 QA 的 X11 非左键限制，`TC-BACKUP-AUTH-715` 触发授权夹具的 XDG 根目录校验。四个失败原件保留，完整崩溃回归继续以主平台两种配置的完整结果验收。 [macOS 生命周期](https://github.com/engcapa/taomni/actions/runs/45512106167) · [Wayland 性能原件](https://github.com/engcapa/taomni/actions/runs/45509531362/artifacts/14976277019) · [Wayland 全分片](https://github.com/engcapa/taomni/actions/runs/45509531362)

- 四目标核心安装件与 updater 验签已在候选打包运行完成。下载的资产与 `SHA256SUMS` 的 17 个条目逐一吻合，两份 macOS 构建身份绑定候选源码。Windows 纯核心 Native 补跑两个分片各 13/13 通过，包含之前失败的脚本复选框用例。 [updater 原件](https://github.com/engcapa/taomni/actions/runs/45505517152/artifacts/14978490415) · [Windows 补跑](https://github.com/engcapa/taomni/actions/runs/45511844676)
- 已复核 Linux/Windows 生命周期的 14 个分片，Linux Browser 22/22、Native 44/44，Windows Browser 22/22、Native 43/44。Linux 十模块和 Windows 九模块均有各自的十个阶段回执。Windows 的 `TC-MODULES-112` 在重新附着并交付按键之后，首次枚举旧版 VNC Client 宿主时观测到零个匹配进程，已派发同源码、同断言的复验。Windows 分片的镜像版本取自对应 job 的 Runner Image 日志，二进制摘要取自匹配的 `native_identity` 与 `build-identity.json`。通用回执的 `bundleIdentity.platform` 对 Native 固定写 linux，不能用于区分三端。索引位于 `qa-ui-auto-report/github/45508735320/reviewed-shards.json`。 [原始失败分片](https://github.com/engcapa/taomni/actions/runs/45508735320/job/138866866021) · [Windows 复验](https://github.com/engcapa/taomni/actions/runs/45516576994)
- QA 提交 `08a4c5d1b` 补入 Windows 与 macOS 回退后的再次升级。检查原位安装路径、候选可执行文件 SHA-256、Windows Installer 注册状态、原 profile 会话与首装目录、九个安装指针和用户移除的 Mail。Linux 性能探针从指定安装包的生产源码构建，实装与全模块回归继续使用 `60a4d99dc` 的包。63 项相关本地单测与边界检查通过。 [实装验收变更](https://github.com/engcapa/taomni/commit/08a4c5d1b) · [协议、采集与包契约](https://github.com/engcapa/taomni/actions/runs/45517779764)

| 放行项 | 验收与凭据 |
| --- | --- |
| 四目标候选安装包、40 个模块包和目录 | 核对四目标安装包资产、updater 验签、40 个模块签名及首装目录摘要。Linux 载荷覆盖 deb、RPM 和 AppImage。 |
| 从公开版实装升级、回退 | 在 Windows x64、Linux x64、macOS ARM64 和 macOS Intel 上，使用候选 `package_run` 复验固定的 v0.5.13 安装件、已有 profile、首装十模块、卸载 Mail 后重开和回退。关联各平台安装件 ID 与 SHA-256。 |
| 双配置回归 | 归档纯核心和全模块两个 Browser/Native release 选集及逐分片证据。全模块模式通过 `first_release_run` 绑定签名目录与候选包。 |
| G1、G2、G3 | 两种 macOS 架构采集固定签名证书、Gatekeeper、已安装宿主启动、TCC 与实际采集及输入。Windows 采集 MSI Authenticode、下载区标记、Defender 实时保护及下载的签名宿主启动。 |
| G4、G5、G6 | Linux 三格式验证 `noexec` 拒绝和 profile 搬迁。签名 RDP 采集首帧、帧率、带宽及 40 个延迟样本，p95 上限 130 ms。实装升级记录强制退出后的宿主清理和数据恢复。 |
| G7、G8 | 十模块在三端跑双版本无重启生命周期，检查宿主退出、资源释放、原数据与回滚。用签名包和目录验收拒绝篡改并核对候选摘要。 |
| G9、G10、G11 | 四目标实际安装载荷核对构建清单。保留三端真实进程的 RPC 超时、取消、重复请求回执，以及实装 GUI/headless 互斥、备份静默和 re-exec 归属。 |

### 同候选回执复核（11 月 25 日续）

| 验收项 | 结果与原始回执 |
| --- | --- |
| 候选安装件与签名目录 | 打包成功，46 个工件已归档。核对 17 个 updater 清单条目、首装目录中的 40 份模块包与各自的产物记录。签名验收目录 SHA-256 为 `1183d6ec00ec7db317e741e4483e918d6b741676343fde85efb09d175cdf125b`。该目录使用实装测试镜像地址，正式发布流程另行生成带 GitHub Release 地址的 `modules.json`。 [打包](https://github.com/engcapa/taomni/actions/runs/45505517152) · [首装目录](https://github.com/engcapa/taomni/actions/runs/45505517152/artifacts/14979546289) |
| G7 首发十模块 | Linux、Windows、macOS ARM64 各十模块、每模块十阶段通过。Windows VNC Client 复验同时通过 27/27 项，原失败分片保留。分片索引绑定 runner 镜像日志、产品源码、包摘要、选集、用例、QA 二进制和原始回执。 [Linux 与 Windows](https://github.com/engcapa/taomni/actions/runs/45508735320) · [Windows VNC](https://github.com/engcapa/taomni/actions/runs/45516576994) · [macOS](https://github.com/engcapa/taomni/actions/runs/45512106167) |
| 纯核心崩溃回归 | 三端 Browser 各 21 项，Linux、Windows Native 各 26 项，macOS Native 25 项，全部通过。原 Windows 四分片在安装 OCR 时失败，补跑的两分片已逐项复核。 [原运行](https://github.com/engcapa/taomni/actions/runs/45505570023) · [Windows Native](https://github.com/engcapa/taomni/actions/runs/45511844676) |
| Windows 与 macOS 实装 | Windows x64、macOS ARM64、Intel 的 v0.5.13 升级、回退、再次升级均通过。两种 macOS 架构保留同一 designated requirement、屏幕录制及辅助功能授权，原件含 Gatekeeper、签名宿主、MFA 实际扫码、RDP 权限、强退清理与租约记录。Windows 原件包括 Authenticode、Defender 与下载宿主执行记录。 [Windows](https://github.com/engcapa/taomni/actions/runs/45524159453/artifacts/14981703294) · [macOS ARM64](https://github.com/engcapa/taomni/actions/runs/45524159453/artifacts/14981658523) · [macOS Intel](https://github.com/engcapa/taomni/actions/runs/45524159453/artifacts/14982455129) |
| Linux 实装、全模块回归 | Linux 首次执行在旧版 MFA 页关闭控件处停止，第二次到达旧 Mail 邮箱，未读到预期正文。QA 提交 `9b5144d97` 经消息行打开独立阅读页并保留失败截图，单独派发 Linux 实装。全模块回归使用同一候选打包运行的十个签名包。 [Linux 原失败](https://github.com/engcapa/taomni/actions/runs/45524159453/artifacts/14981554091) · [Linux 复验](https://github.com/engcapa/taomni/actions/runs/45525582190) · [全模块回归](https://github.com/engcapa/taomni/actions/runs/45519040386) |
| 全模块崩溃回归结果 | 三端 Browser 各 23/23，Linux 与 Windows Native 各 29/29，macOS Native 28/28，全轮 155/155。签名包来自打包运行 45505517152。全部分片的选集、用例 SHA-256、原始回执和 native QA 二进制摘要已核对。 [GitHub 回归](https://github.com/engcapa/taomni/actions/runs/45519040386) |
| Linux Mail 最新定位 | v0.5.13 的失败截图显示原始邮件正文已加载，阅读器选中 HTML，验收断言查找 Plain 视图。QA 提交 `a64ca9087` 在实时邮件与归档预览中显式切换到 Plain，并继续逐字核对同一封邮件。两种 macOS 与 Windows 的实装验收均已通过。 [失败原件](https://github.com/engcapa/taomni/actions/runs/45525582190/artifacts/14983285387) · [Linux 复验](https://github.com/engcapa/taomni/actions/runs/45526779092) |
| Linux 旧版应用退出 | 正文断言已通过。旧版同时打开 MFA 和 Mail，退出验证仍匹配单标签提示。QA `8e6bdc3c5` 为这个夹具匹配双标签提示并保留其余场景的单标签检查。81 项相关单测与边界检查通过。 [原失败](https://github.com/engcapa/taomni/actions/runs/45526779092/artifacts/14983141551) · [复验](https://github.com/engcapa/taomni/actions/runs/45528225990) |




原件按运行 ID 保留在 `qa-ui-auto-report/github/`。后续收口逐项记录完整源码 SHA、runner 镜像、包资产 ID、摘要与原件路径。 [仓库发布门禁](../AGENTS.md#modular-product-development) · [实装与升级](taomni-modular-installed-upgrade-verification.md)

## 2026-11-24 生产准备状态

**暂缓发布 `0.6.0`。** 当前公开版本为 `v0.5.13`。`refactor/modules-arch` 已推送至 `078fe874155b28b06ef65ddb204c7d6230acf3d4`，包含当前 `origin/main` 的 `ec8ef63f1`。基座版本已定为 `0.6.0`，十个首发模块清单均已设为 `stable`。`d6adb5a7c` 的四目标打包继续验证构建链路。正式放行须使用含本轮 QA 修正的同源码工件和回执。 [公开版本](https://github.com/engcapa/taomni/releases/tag/v0.5.13) · [分支提交](https://github.com/engcapa/taomni/commit/078fe8741) · [打包 #45420902624](https://github.com/engcapa/taomni/actions/runs/45420902624)

- 基座已接入模块商店、验签和生命周期管理、profile 租约与备份协调。十个业务模块已具备独立打包入口，Mobile 与普通截图保留在基座。MFA 运行、禁用、卸载保留三态还原已有阶段回执，V-008 单模块目录更新演练已通过。 [实施台账](taomni-modular-split-progress.md) · [目录演练 #45314025590](https://github.com/engcapa/taomni/actions/runs/45314025590)
- Mail `0.1.59` 将协议引擎移出默认基座，历史邮箱、归档和备份兼容保留共享存储实现。macOS 基座包已移除旧 SocksCap Redirector 桥接程序。核心通过验签后的系统 Provider 清除旧捕获范围，签名 SocksCap 宿主负责正常捕获。 [Mail 迁移](https://github.com/engcapa/taomni/commit/ef895cd1b) · [SocksCap 裁剪](https://github.com/engcapa/taomni/commit/55cdefc0b)
- `d6adb5a7c` 的 G9 构建清点和 G11 入口清点通过。核对了 `ubuntu24` 镜像 `20261116.376.1` 回执中的 15 份文件摘要。四目标默认 Cargo 树排除 Mail 协议引擎及 SocksCap 宿主、工具和 Xray 运行依赖，424 个 Vite 清单条目均排除首发模块渲染器。实际安装载荷和跨进程租约仍待验收。 [清点 #45422710624](https://github.com/engcapa/taomni/actions/runs/45422710624) · [原始清点工件](https://github.com/engcapa/taomni/actions/runs/45422710624/artifacts/14936050990)
- Wave 2A 的 18 个分片通过 150 项，含完整崩溃回归。加上 Wave 2B 的 VNC、RDP 客户端，十个首发模块中已有八个在阶段提交上取得 Linux、Windows、macOS ARM64 三端双版本生命周期回执。 [Wave 2A #45391530402](https://github.com/engcapa/taomni/actions/runs/45391530402) · [Wave 2B 首轮 #45399176436](https://github.com/engcapa/taomni/actions/runs/45399176436)
- Wave 2B 服务端复跑 `a403a4a11` 的三个 Linux 原生分片通过 34 项，RDP Server 和 VNC Server 各通过 10 个生命周期阶段。Windows 原生 31/33 项通过，`TC-MODULES-114` 在 RDP 宿主退出后的端口检查失败，`TC-MODULES-115` 在 Windows 外部 VNC 服务指引已显示后的端口检查失败。macOS 26 的 VNC Server 构建和一个浏览器分片未分配到 runner，三个原生分片缺失。两个已收取的 macOS 浏览器分片通过 21 项。 [Linux/Windows #45412993964](https://github.com/engcapa/taomni/actions/runs/45412993964) · [macOS ARM64 #45414324974](https://github.com/engcapa/taomni/actions/runs/45414324974)
- `078fe8741` 让服务端生命周期检查复用 Windows TCP 监听表来判断回环连接超时，保留实际端口仍在监听时的失败，记录端口关闭的证据方式。29 项相关 Python 单测、`pnpm check:refactor`、`pnpm exec tsc -b`、仓库 rustfmt 检查及 QA 静态审计通过。两个服务端用例和完整崩溃回归已在新 SHA 上派发，用 Linux、Windows 和 macOS 26 ARM64 执行。 [修复](https://github.com/engcapa/taomni/commit/078fe8741) · [服务端复跑 #45427030060](https://github.com/engcapa/taomni/actions/runs/45427030060)
- 纯核心崩溃回归已切换到新 SHA，旧运行 `#45423650609` 已取消并保留已收分片。新运行使用 `module_profile=core-only`、`native_release=true` 和三端 Browser/Native。 [纯核心回归 #45428206447](https://github.com/engcapa/taomni/actions/runs/45428206447)

### 续接验收

1. 以验收源码重建四目标核心安装件、40 个签名模块包、首装目录和 updater 验签回执。四目标为 Linux x64、Windows x64、macOS ARM64 和 macOS Intel。Linux 安装载荷覆盖 deb、RPM 和 AppImage。 [打包工作流](../.github/workflows/release.yml)
2. 从同一候选 SHA 的 `package_run` 验收官方 `v0.5.13 → 0.6.0` 四目标实装升级、旧数据迁移、回退与再升级。通过 `first_release_run` 绑定全模块崩溃回归的签名包，归档同一 SHA 下纯核心和全模块两轮结果。 [升级工作流](../.github/workflows/qa-modular-upgrade.yml) · [回归选集](../qa-ui-auto-tests/ci/README.md)
3. 在候选上收齐 10 个模块的生命周期回执，补测 Windows 和 macOS ARM64 的服务端场景。按 G1–G11 逐门归档候选源码、runner 镜像、包资产 ID 与 SHA-256、用例摘要及原始工件。G5 实装输入到画面 p95 上限为 130 ms。 [放行规则](../AGENTS.md#modular-product-development)

Wave 2B 原始分片位于 `qa-ui-auto-report/github/45412993964/wave2b-linux-windows/` 和 `qa-ui-auto-report/github/45414324974/wave2b-macos/`。`selection.json`、`build-identity.json`、`ci-outcome.json`、`runner_receipt.json`、`summary.json` 和各用例的生命周期记录随分片保留。构建清点在 `qa-ui-auto-report/github/45422710624/artifacts/modular-core-build-inventory/`。当前两个回归的分片正在收取，目录为 `qa-ui-auto-report/github/45427030060/server-lifecycle/` 和 `qa-ui-auto-report/github/45428206447/core-only/`。

## 2026-11-24 20:34 原交接快照

本节及下方台账保留原交接时的记录。当前验收状态见上方「生产准备状态」。

本阶段已完成 Mail `0.1.57` POP3 附件与 `0.1.58` 引擎/解析迁移、MFA 三态自动还原、SocksCap Linux 启动器/冷启与草稿修复、V-008 只读单模块目录演练、基座 `ironrdp`/`rcgen`/`mail-parser` 依赖裁剪，以及 Wave 1 + Wave 2A 的 6 个首发业务模块三端双版本无重启生命周期验证。 [实施台账](taomni-modular-split-progress.md#接下来的执行顺序)

## 接手位置

- 工作区位于 `/data-share-winsys/code/person/taomni-refactor-modules`。分支 `refactor/modules-arch` 在本次交接文档提交前的最新代码提交为 `168f69fae98092984cd847d4dad05dcd1071d978`（紧随其后的提交仅更新本交接文档）。[重构分支](https://github.com/engcapa/taomni/tree/refactor/modules-arch)
- 远程 `origin/main`（`ec8ef63f1`，PR #878 Maven transfer resilience）已通过 [`9795ce284`](https://github.com/engcapa/taomni/commit/9795ce284) 干净合入，合并时无新增冲突。
- 上一份交接（`6439685e3`）中未提交的两组草稿——Mail `0.1.57` POP3 附件解码与 MFA 三态自动还原——已全部补齐单测与观测器、验证并提交；当前工作区除本交接文档外无未提交代码改动。
- 目标范围仍是台账中的 1–7 项、设计中的 `TASK-001` 至 `TASK-027`、`AC-001` 至 `AC-017`、`V-001` 至 `V-012`，以及 G1–G11 发布回执。LanChat（`TASK-015`）已删除，Mobile 按 DEC-2 在首发中由基座提供。[设计 §10](taomni-modular-split-design.md#10-实施计划p1-内部分批第一版一起发布mail-纳入首发验收集合) · [ADR](../claudedocs/adr-taomni-modular-split.md) · [AGENTS.md](../AGENTS.md)

## 已完成的开发与本阶段进展（6439685e3 → 168f69fae）

### 基座基础能力（6439685e3 及之前已入库）

- 基座已具备模块注册表、签名版本目录、启停与禁用、默认保留数据的卸载、回滚、进程监督、profile/模式租约、Vault 作用域服务、备份协调、三代理模式可断点续传下载器，以及设置内模块商店入口。[架构与验收台账](taomni-modular-split-progress.md#任务状态)
- 首发名单固定为 10 个模块：`ai-voice-local`、`mail`、`mfa`、`rdp-client`、`rdp-server`、`screenshot`、`servers`、`sockscap`、`vnc-client`、`vnc-server`；截图入口/普通截图/滚动截图/共享采集由基座持有，OCR 与录制归 `screenshot`。首次升级夹具已锚定官方 `v0.5.13` 四目标资产与 `0.5.12` 可选旧基线回放。[首装名单](../src-tauri/plugins/legacy-upgrade.json) · [截图归属](taomni-modular-split-design.md#37-截图入口留核心与备份留核心)

### 本阶段已提交并经 GitHub 验证的交付

- **`TC-MAIL-CACHE-02` 修复与 Mail 0.1.57 / 0.1.58 迁移**：[`eebc3527b`](https://github.com/engcapa/taomni/commit/eebc3527b) 修复重复同步与缓存正文状态保留；[`0e2be91bd`](https://github.com/engcapa/taomni/commit/0e2be91bd) 与 [`0ac5d486b`](https://github.com/engcapa/taomni/commit/0ac5d486b) 完成 Mail `0.1.57` POP3 附件在签名宿主内解码与原子保存；[`e58217239`](https://github.com/engcapa/taomni/commit/e58217239) 发布 Mail `0.1.58`，将旧 POP3 路径与 `mail-parser` 迁入签名 Mail 宿主，并在 [G 门 #45337958092](https://github.com/engcapa/taomni/actions/runs/45337958092) 与 [协议/契约 #45337965410](https://github.com/engcapa/taomni/actions/runs/45337965410) 通过验证。
- **签名 MFA 三态自动还原与生命周期收口**：[`de73677fc`](https://github.com/engcapa/taomni/commit/de73677fc) 与 [`4f6e1b2d7`](https://github.com/engcapa/taomni/commit/4f6e1b2d7) 补齐 `TC-MODULES-104/105/106`（运行、禁用、卸载保留三态自动还原，含 SQLite WAL sidecar 与 HOTP 解密校验）；[`fe1974f1f`](https://github.com/engcapa/taomni/commit/fe1974f1f) 修复 `TC-MODULES-103` 会话侧边栏选择步骤。
- **SocksCap Linux 启动器迁出与静默超时/归档性能修复**：[`dbc5e2d4e`](https://github.com/engcapa/taomni/commit/dbc5e2d4e) 将 Linux trace launcher 迁入签名 SocksCap 包；[`854806a3e`](https://github.com/engcapa/taomni/commit/854806a3e) 在宿主静默期保留 `HostUnavailable` 语义；[`3ab722ef2`](https://github.com/engcapa/taomni/commit/3ab722ef2) 改为内存验证已安装包归档并允许 Windows SocksCap 冷启动。三项获 [Platforms #45319002178](https://github.com/engcapa/taomni/actions/runs/45319002178)、[Upgrade Contracts #45309871747](https://github.com/engcapa/taomni/actions/runs/45309871747)、[G1–G11 #45309880849](https://github.com/engcapa/taomni/actions/runs/45309880849) 全绿通过。
- **V-008 只读单模块目录演练**：[`028c8800a`](https://github.com/engcapa/taomni/commit/028c8800a) 与 [`d128b3d57`](https://github.com/engcapa/taomni/commit/d128b3d57) 新增并通过 `release.yml` 执行单模块增量目录合并、签名校验与资产保留演练，[Release Bundle #45314025590](https://github.com/engcapa/taomni/actions/runs/45314025590) `completed/success`。
- **G9 核心依赖首轮裁剪**：[`1b8f1ac8a`](https://github.com/engcapa/taomni/commit/1b8f1ac8a) 移除基座中未使用的 `ironrdp*`、`taomni-rdp-common` 与 `rcgen` 运行时依赖。[`#45358137976`](https://github.com/engcapa/taomni/actions/runs/45358137976)（`suite=core`，`completed/success`，本地归档 `qa-ui-auto-report/github/45358137976/artifacts/modular-core-build-inventory/cargo-tree-*.txt`）在四目标构建清点中确认：`ironrdp=0`、`taomni-rdp-common=0`、`rcgen=0`、`mail-parser=0`；默认基座 Cargo 树仍残留 `taomni-mail-engine=2`、`taomni-sockscap=2`。
- **Wave 1 签名双版本生命周期（`servers`、`sockscap`）**：[`948eccfb0`](https://github.com/engcapa/taomni/commit/948eccfb0) 将 `assert_signed_module_lifecycle`、`qa_catalog` 与 `qa-modular-packages.yml` 抽象为通用双版本签名机制，新增 `TC-MODULES-107`（`servers`）与 `TC-MODULES-108`（`sockscap`）；[`#45357871114`](https://github.com/engcapa/taomni/actions/runs/45357871114) 验证 `TC-MODULES-107` 与 `TC-MODULES-103` 在三端 10/10 阶段全过并暴露出 SocksCap 手动编辑未完成上行配置时的草稿丢失问题；[`899435ec4`](https://github.com/engcapa/taomni/commit/899435ec4) 修复 [`createProfileActions.tsx`](../src-tauri/plugins/sockscap/renderer/panel/createProfileActions.tsx) 后，[Platforms #45365029513](https://github.com/engcapa/taomni/actions/runs/45365029513) 18/18 分片 158/158 用例全过，`TC-MODULES-108` 三端 10/10 阶段通过。
- **Wave 2A 签名双版本生命周期（`screenshot`、`ai-voice-local`、`mail`）**：[`7802d70e3`](https://github.com/engcapa/taomni/commit/7802d70e3) 新增 `TC-MODULES-109/110/111`，补齐无状态定位器、纯宿主可选 `frontendSha256`、`ggml-base.bin` SHA-256 校验与 Mail SQLite/`.imap-owner` 复用（本地单测 61/61、`qa_ui_auto.audit --gate` 0 error、`pnpm check:refactor` exit 0）；[`#45376841330`](https://github.com/engcapa/taomni/actions/runs/45376841330) 与 [`#45383929494`](https://github.com/engcapa/taomni/actions/runs/45383929494) 证明 `TC-MODULES-109` 与 `TC-MODULES-111` 在三端 10/10 阶段通过；随后 [`83a55c772`](https://github.com/engcapa/taomni/commit/83a55c772)、[`439e8d395`](https://github.com/engcapa/taomni/commit/439e8d395)、[`168f69fae`](https://github.com/engcapa/taomni/commit/168f69fae) 依次消除窄视口 floating 抽屉与 Windows CPU Whisper 解码耗时竞争，最终在 [Platforms #45391530402](https://github.com/engcapa/taomni/actions/runs/45391530402) 跑通全部 18/18 分片（150/150 用例全绿，`TC-MODULES-110` 三端 10/10 阶段 `reinstalled` + `passed: True`）。

### 10 首发模块双版本生命周期台账（6/10 完成，4/10 待开发）

| 模块 slug | 当前清单版本/状态 | G7 双版本生命周期用例 | 当前验证状态 |
| --- | --- | --- | --- |
| `mfa` | `0.1.2` / `provisional` | `TC-MODULES-103`（及三态还原 `104–106`） | **已通过**（`linux-x86_64`、`windows-x86_64`、`darwin-aarch64` 10/10 阶段，含 `#45319002178` / `#45357871114`） |
| `servers` | `0.1.3` / `provisional` | `TC-MODULES-107` | **已通过**（三端 10/10 阶段，`#45357871114`） |
| `sockscap` | `0.1.14` / `provisional` | `TC-MODULES-108` | **已通过**（三端 10/10 阶段，`#45365029513` 18/18 分片全绿） |
| `screenshot` | `0.1.4` / `provisional` | `TC-MODULES-109` | **已通过**（三端 10/10 阶段，`#45376841330` / `#45383929494`） |
| `ai-voice-local` | `0.1.0` / `provisional` | `TC-MODULES-110` | **已通过**（三端 10/10 阶段 `168f69fae`，`#45391530402` 18/18 分片 150/150 全绿） |
| `mail` | `0.1.58` / `provisional` | `TC-MODULES-111` | **已通过**（三端 10/10 阶段，`#45376841330` / `#45383929494`） |
| `vnc-client` | `0.1.0` / `provisional` | 待新增（建议 `TC-MODULES-112`） | **待开发（Wave 2B）** |
| `rdp-client` | `0.1.2` / `provisional` | 待新增（建议 `TC-MODULES-113`） | **待开发（Wave 2B）**（已有单版本分离窗口 `TC-MODULES-056`） |
| `rdp-server` | `0.1.2` / `provisional` | 待新增（建议 `TC-MODULES-114`） | **待开发（Wave 2B）** |
| `vnc-server` | `0.1.2` / `provisional` | 待新增（建议 `TC-MODULES-115`） | **待开发（Wave 2B）** |
| （验证基线）`hello-plugin` | `0.1.0` / `provisional` | `TC-MODULES-042` | 已在三端长期通过 |

## GitHub 任务执行与监控状态

- **最新在途运行 [`#45391530402`](https://github.com/engcapa/taomni/actions/runs/45391530402)（`qa-ui-auto-platforms.yml`，`head=168f69fae`）**：
  - 全部 **18/18 个 QA 分片（150/150 用例）均已通过**，`FAILS: []`，原始分片及 `TC-MODULES-110` 三端 `signed-ai-voice-local-lifecycle.jsonl`（含完整 `crash-regression` 与 `TC-MODULES-067`）已下载至 `qa-ui-auto-report/github/45391530402/wave2a-voice-final/`。
  - 按用户 20:32 指令已于 **20:34 立即停止本地监控进程**（`task-3007` 已取消）；停止时刻仅剩 `native-contracts / native-build-linux-x64-release` 作业在 GitHub 端收尾，因此 `#45391530402` 的整体 workflow `status/conclusion` 尚未在本机作最终确认。接手后请先执行下方 `gh run view 45391530402` 核对最终收口。

| 运行 ID | Workflow | 源码 SHA | 状态与结论摘要 | 本地证据路径 |
| --- | --- | --- | --- | --- |
| [`#45391530402`](https://github.com/engcapa/taomni/actions/runs/45391530402) | `qa-ui-auto-platforms.yml` | `168f69fae` | **18/18 QA 分片 150/150 全过**（Wave 2A Voice + 全量 `crash-regression`）；停止监控时 `native-contracts / native-build-linux-x64-release` 仍在收尾 | `qa-ui-auto-report/github/45391530402/wave2a-voice-final/` |
| [`#45383929494`](https://github.com/engcapa/taomni/actions/runs/45383929494) | `qa-ui-auto-platforms.yml` | `83a55c772` | `TC-MODULES-109`（`screenshot`）与 `TC-MODULES-111`（`mail`）三端 10/10 通过；`TC-MODULES-110` 已在 `168f69fae` 修复通过；偶发 `TC-FILE-OPEN-009` macOS 已在 `#45391530402` 通过 | `qa-ui-auto-report/github/45383929494/` |
| [`#45376841330`](https://github.com/engcapa/taomni/actions/runs/45376841330) | `qa-ui-auto-platforms.yml` | `7802d70e3` | `TC-MODULES-109` 与 `TC-MODULES-111` 三端 10/10 通过；偶发 Windows `TC-FILE-OPEN-005` 已在 `#45383929494` 与 `#45391530402` 通过 | `qa-ui-auto-report/github/45376841330/` |
| [`#45365029513`](https://github.com/engcapa/taomni/actions/runs/45365029513) | `qa-ui-auto-platforms.yml` | `899435ec4` | `completed/success`，18/18 分片 158/158 用例全过，`TC-MODULES-108`（`sockscap`）三端 10/10 通过 | `qa-ui-auto-report/github/45365029513/live-monitor/` |
| [`#45357871114`](https://github.com/engcapa/taomni/actions/runs/45357871114) | `qa-ui-auto-platforms.yml` | `948eccfb0` | `TC-MODULES-103`（`mfa`）与 `TC-MODULES-107`（`servers`）三端 10/10 通过 | `qa-ui-auto-report/github/45357871114/live-monitor/` |
| [`#45358137976`](https://github.com/engcapa/taomni/actions/runs/45358137976) | `qa-modular-gates.yml` (`suite=core`) | `948eccfb0` | `completed/success`，验证四目标基座已清除 `ironrdp`/`taomni-rdp-common`/`rcgen`/`mail-parser` | `qa-ui-auto-report/github/45358137976/artifacts/` |
| [`#45337958092`](https://github.com/engcapa/taomni/actions/runs/45337958092) / [`#45337965410`](https://github.com/engcapa/taomni/actions/runs/45337965410) | `qa-modular-gates.yml` / Upgrade Contracts | `e58217239` | `completed/success`，Mail `0.1.58`、协议与四端探针通过 | `qa-ui-auto-report/github/45337958092/` · `45337965410/` |
| [`#45314025590`](https://github.com/engcapa/taomni/actions/runs/45314025590) | `release.yml`（V-008 演练） | `d128b3d57` | `completed/success`，只读单模块增量目录合并、序号递增与资产一致性通过 | `qa-ui-auto-report/github/45314025590/rehearsal-evidence/` |
| [`#45319002178`](https://github.com/engcapa/taomni/actions/runs/45319002178) / [`#45309871747`](https://github.com/engcapa/taomni/actions/runs/45309871747) / [`#45309880849`](https://github.com/engcapa/taomni/actions/runs/45309880849) | Platforms / Contracts / G1–G11 | `3ab722ef2` | 三者均 `completed/success`，覆盖 MFA 三态、归档内存验签与 SocksCap 冷启动 | `qa-ui-auto-report/github/45319002178/` |

### 监控与续传常用命令（含 CI 已知坑点）

```bash
export HTTPS_PROXY=http://10.1.0.80:3228 HTTP_PROXY=http://10.1.0.80:3228
gh run view 45391530402 --json headSha,status,conclusion,jobs
gh run list --branch refactor/modules-arch --limit 10
python .agents/skills/qa-ui-auto/scripts/ci_live_monitor.py \
  --repository engcapa/taomni --run-id 45391530402 \
  --destination qa-ui-auto-report/github/45391530402/live-resumed
```

- **切勿对 `qa-ui-auto-platforms.yml` 执行 `gh run rerun --failed`**：`ci.py` 跨分片收集会因 `run_attempt` 不匹配导致收口失败，需重新派发完整 run。
- **派发 `qa-modular-gates.yml` 必须同时传分支名与完整 40 位 SHA**：`modular_gate_runs.py` 通过 `git/ref/heads/{source_ref}` 解析分支，请固定传 `source_ref=refactor/modules-arch` 与 `head=<40-char-sha>`。
- **并行限额与 macOS runner**：本模块化任务在途 workflow 同时最多保持 3 个；`macos-15` 容量不足时可临时切 `macos_runner=macos-26`，但正式 Intel G1 与 Intel 实装升级仍需对应 Intel runner。

## 2026-11-24 交接时的待办快照

1. **P0 待办 1 — 完成 Wave 2B 剩余 4 个业务模块双版本无重启生命周期（G7）**：
   - 按 `TC-MODULES-107`–`111` 复用架构，为 `vnc-client`、`rdp-client`、`rdp-server`、`vnc-server` 新增签名前后两版本生命周期用例（`TC-MODULES-112`–`115`），验证同一桌面核心 PID 下启停、升级、握手失败恢复、无重启回滚、卸载保留与重装，以及对应独立窗口/服务端监听端口/输入回放与资源回收；同步更新 `feature-list.md`、`testid-catalog.md`、`policy.yaml`、`dependencies.yaml`（视需要），本地跑通 `qa_ui_auto.audit --gate`、`pnpm check:refactor` 及受影响单测后，经 `qa-ui-auto-platforms.yml`（含完整 `crash-regression`）在 Linux/Windows/macOS ARM64 全绿过关。
2. **P0 待办 2 — 清理基座剩余 Mail 与 SocksCap 核心依赖及平台入口（Item 3 & G9）**：
   - 将默认四目标基座 Cargo 树仍残留的 `taomni-mail-engine`（2 处）与 `taomni-sockscap`（2 处）裁剪出基座默认编译图，移除基座内遗留 Mail 旧读写/兼容代码路径以及 SocksCap 在核心包内的 macOS bundle/bridge 残留引用（核查 [`tauri.macos.conf.json`](../src-tauri/tauri.macos.conf.json)、[`verify-macos-release-bundle.sh`](../scripts/verify-macos-release-bundle.sh)、[`bridge.rs`](../src-tauri/src/sockscap/redirector/runtime/bridge.rs)）；确保历史归档/备份还原、系统权限归属与卸载安全不退化。完成后重新派发 `qa-modular-gates.yml`（`suite=core`），在四目标 Cargo 树、Vite 产物、四目标安装包载荷（含 Linux deb/RPM/AppImage）及原生入口清单全部清零验证。
3. **P1 待办 3 — 合入最新 `origin/main`、正式定版与模块清单转 `stable`**：
   - 拉取并合入届时 `origin/main` 的新增提交并处理冲突，保留两边代码修复与测试覆盖；
   - 将基座版本号升级至正式目标版本（如 `0.6.0`），把 10 个首发模块的 `src-tauri/plugins/<slug>/module.json` 从 `"status": "provisional"` 全部切换为 `"stable"`（并同步所需冻结版本号）；
   - 在本地跑完格式、严格类型检查、Rust 单元/集成测试、`qa_ui_auto.audit --gate` 与 `pnpm check:refactor`，推送并**冻结单一正式候选 SHA**。
4. **P0 待办 4 — 在同一正式候选 SHA 上收齐发布包、`0.5.13` 升级、双配置回归与 G1–G11 原始回执**：
   - **(a) 全量发布包预建与签名校验**：用冻结候选 SHA 跑 [`release.yml`](../.github/workflows/release.yml)（空 `tag`、`platforms=all`、`macos_arch=both`、冻结十模块 roster、沿用 `main` 签名配置），产出四目标核心安装件、40 个 `.taomni-plugin`、`.minisig`、`SHA256SUMS`、`modules.json`、updater 验签工件与 `modular-candidate-roster-<run-id>`。
   - **(b) 真实 `v0.5.13 → 0.6.0` 四目标安装与升级验收**：使用同一 SHA 和 `package_run` 派发 [`qa-modular-upgrade.yml`](../.github/workflows/qa-modular-upgrade.yml)（`package_targets=all`，启用 `package_first_release_linux`、`package_first_release_desktop`、`package_relocation_linux`、`package_rdp_perf`，安装基线 `0.5.13`），验收 Linux（deb/RPM/AppImage）、Windows MSI 与 macOS 双架构（ARM64/Intel）实装升级、旧数据迁移（至少覆盖 RDP/VNC、Servers、MFA、SocksCap、Mail）、禁用/卸载保留、新模块选装、回退与再次升级，以及 G1–G6 实装回执。
   - **(c) 双安装配置全量与核心崩溃回归**：同一候选 SHA 以 `module_profile=core-only` 和 `module_profile=full` 各通过 [`qa-ui-auto-platforms.yml`](../.github/workflows/qa-ui-auto-platforms.yml)。两轮传 `tags=crash-regression` 和 `native_release=true`，完整模块配置额外传 `first_release_run`。在正式候选上确认 MFA 界面还原、v1 归档兼容、GUI/headless 互斥，以及安装包体积、启动、内存、终端 I/O、RDP 与安装任务性能预算。
   - **(d) G1–G11 全门绑定归档**：按每次并发 ≤3 个上限通过 [`qa-modular-gates.yml`](../.github/workflows/qa-modular-gates.yml) 收齐其余 `host`/`protocol`/`system`/`signed` 子运行回执，确保发布台账把 G1–G11 逐一绑定到**同一候选源码 SHA、runner 镜像版本、包资产 ID 与 SHA-256、用例/选集摘要与原始工件路径**。
5. **P0 待办 5 — 正式差异发布（待用户确认后执行）**：
   - 全部门禁闭环并获用户确认发布后，按双清单与先上传包与 `.minisig`、最后发布 `modules.json` 与 `latest.json` 的规则，复用已验签 `candidate_run` 工件发布正式 Core Release 与首套模块 Catalog，模块资产绝不打入核心安装包。

## 1–7 项进展与剩余交付

| 项 | 当前已达到 | 上生产还需完成 |
| --- | --- | --- |
| 1 多端回归 | Wave 1 与 Wave 2A 三端全量分片（含 `crash-regression`）在阶段提交全过，最新 `#45391530402` 18/18 分片 150/150 全绿 | 完成 Wave 2B 后，以**同一正式候选 SHA** 分别跑 `module_profile=core-only` 与 `module_profile=full` + `crash-regression`（含 `native_release=true`） |
| 2 Vault、profile 与一致快照 | `TC-MODULES-103/104/105/106` 已全部入库并三端实测通过三态自动还原、WAL 与 HOTP 连续性 | 在同一正式候选上复验 MFA 界面还原、旧 v1 归档、GUI/headless 互斥、强退与进程锁释放 |
| 3 业务归属 | 10 模块可签名打包；Mail `0.1.58` 已迁走 POP3 附件与旧 POP3/`mail-parser`；SocksCap Linux launcher 已迁出 | 清理基座内剩余 Mail 旧兼容路径及 SocksCap macOS bundle/bridge 残留，保护还原与卸载安全 |
| 4 核心依赖闭包（G9） | `#45358137976` 已证实四目标核心彻底清零 `ironrdp`/`taomni-rdp-common`/`rcgen`/`mail-parser` | 清除剩余 `taomni-mail-engine`（2）与 `taomni-sockscap`（2）默认依赖，并在候选 SHA 重跑 `suite=core` 核验四目标与 Linux 三格式载荷 |
| 5 模块生命周期（G7） | 已有 **6/10** 首发业务模块（`mfa`、`servers`、`sockscap`、`screenshot`、`ai-voice-local`、`mail`）完成三端双版本 10/10 阶段实测，另含 `hello-plugin` (`TC-MODULES-042`) | 补齐 Wave 2B 剩余 **4/10** 模块（`vnc-client`、`rdp-client`、`rdp-server`、`vnc-server`）双版本无重启生命周期并在候选 SHA 收齐 |
| 6 首装及精细化升级 | `v0.5.13` 升级夹具已对齐；过往 `0.5.12 → 0.6.0` 四目标演练及 `TC-MODULES-040–047` 已建 | 用**正式候选**从真实 `v0.5.13` 执行四目标升级、五类旧数据迁移、卸载/禁用保留、回退与再升级 |
| 7 正式发布验收 | V-008 只读单模块演练已在 `#45314025590` `completed/success`；候选工件复用契约已就绪 | 定版 `0.6.0` 与清单转 `stable`，在正式候选收齐性能预算与 G1–G11 绑定回执后，再按差量规则正式发布 |

## G1–G11 正式候选状态与待补证据

| 门 | 阶段进展与已有回执 | 同一正式候选 SHA 必须补齐的验收结果 |
| --- | --- | --- |
| G1 macOS 宿主启动 | 已有历史安装及 ARM64/Intel 签名核验路线 | 同一候选的 macOS ARM64 与 Intel 安装包及签名宿主、固定证书、hardened runtime、Gatekeeper 原件与实际启动回执 |
| G2 系统权限 | 已有 `#45150360966` 历史 TCC 权限回执 | 正式候选升级前后 macOS 屏幕录制/辅助功能归属（核心、MFA、RDP Server、截图、Mobile）及 Linux Wayland 实际授权/输入 |
| G3 Windows 防护 | 已有 `#45125000076` 及近期 Native 冷启实测 | 正式候选 MSI Authenticode（接受 unsigned）、下载区标记与 Defender 开启下安装启动签名宿主、可观察 SmartScreen 状态 |
| G4 Linux `noexec` | 已有历史实装迁移/回退记录（[见实装核验](taomni-modular-installed-upgrade-verification.md#linux-安装格式的-noexec-恢复)） | 正式候选 deb、RPM、AppImage 上的宿主拒绝、可执行 profile 搬迁与原数据恢复（含 OS 挂载与清理原件） |
| G5 RDP 性能 | `#45337965410` 等已测得编码探针；约定参考 65 ms、上限 p95 ≤ 130 ms | 同候选 SHA 签名 RDP 实装输入到画面，附首帧 ≤ 500 ms、帧率 ≥ 25.6 fps、带宽 ≤ 4905 kbps 与 40/40 有效样本原始记录 |
| G6 强制退出 | 已有历史强杀释放原件与静默 `HostUnavailable` 修复 | 正式候选实装包三端强杀核心后的宿主/子进程清理及重启后数据恢复回执 |
| G7 无重启生命周期 | **6/10 首发业务模块三端 10/10 阶段已通过**（`103`/`107`/`108`/`109`/`110`/`111`） | 补齐 Wave 2B 4 模块（`vnc-client`/`rdp-client`/`rdp-server`/`vnc-server`），并在候选 SHA 留存 10 模块完整 PID、宿主与数据摘要回执 |
| G8 篡改拒绝 | 已有签名清单、V-008 演练（`#45314025590`）与安装拒载记录 | 正式候选验证目录/签名/包/清单/路径篡改拒绝，附官方公钥验签与资产 SHA-256 一致性 |
| G9 核心闭包 | `#45358137976` 证实 `ironrdp`/`taomni-rdp-common`/`rcgen`/`mail-parser` 已清零 | 清除 `taomni-mail-engine`（2）与 `taomni-sockscap`（2）后，正式候选 `suite=core` 证明四目标全零、Vite/载荷/入口清白 |
| G10 RPC 健壮性 | `#45337965410` 等已归档多轮三端进程契约与协议套件 | 正式候选 SHA 上三端真实宿主的握手、权限、超时、取消、崩溃与重复请求清理回执 |
| G11 租约和入口 | 备份静默（`854806a3e`）、三态互斥与 VNC/SocksCap re-exec 已有阶段验证 | 正式候选核对备份前静默、profile 与 GUI/headless 双向互斥、VNC/SocksCap re-exec 入口与四目标核心可执行清单 |

## 用户要求与操作提示

- 目标是依据设计完成模块化并具备生产发布条件；LanChat 直接删除；Mail 属于独立模块；前后两套发行安装状态和跨进程验证必须在 GitHub runner 执行。[仓库约定](../AGENTS.md#modular-product-development)
- 首次从单体升级时，为已有 profile 自动安装签名目录冻结名单中与当前平台兼容的模块（允许卸载）；后续仅更新已安装模块并保留禁用/卸载选择；新增模块展示名称与说明待用户选择安装；卸载默认保留业务数据，明确确认后才永久删除。[升级设计](taomni-modular-split-design.md#8-数据与迁移) · [历史实装](taomni-modular-installed-upgrade-verification.md)
- 本地仅跑单元、静态、契约与构建检查；Browser/Native 均附带完整 `crash-regression` 与受影响用例，及时分片下载核对 `selection.json`、`build-identity.json`、`ci-outcome.json`、`runner_receipt.json` 和 `summary.json`。无关失败仅在保留原始证据与判定依据下可单列。[QA 工作流](../.github/workflows/qa-ui-auto-platforms.yml) · [崩溃回归规则](../qa-ui-auto-tests/ci/crash-regressions.md)
- Windows 签名与 Apple 公证沿用 `main`（接受 unsigned MSI 与未公证 macOS app），但固定 macOS 签名身份、Gatekeeper、真实 TCC、Windows Defender 与目录/模块/updater 验签均是强制门禁；G5 接受输入到画面 p95 ≤ 130 ms。[签名及性能约定](../AGENTS.md#modular-product-development)
- 远程 `main` 有新提交时须先合入当前分支并解决冲突；涉及修改后注意以 `pnpm check:refactor` 把关 800 行拆分上限与边界检查。

## 发布和新增模块

| 改动 | GitHub 发布方式 |
| --- | --- |
| 仅核心 | [`release.yml`](../.github/workflows/release.yml) 生成四目标核心安装件和 `latest.json`；沿用上一版已验签 `modules.json` 与 `.minisig` 到新的核心 Release，不重编模块包。 |
| 仅一个模块 | [`release-modules.yml`](../.github/workflows/release-modules.yml) 生成指定模块全声明平台的 `.taomni-plugin`、`.minisig`、`SHA256SUMS` 与递增序号后的完整签名目录，上传至模块 Release 并同步目录到最新核心 Release。 |
| 同时修改核心与模块 | `release.yml` 的 `modules` 传改动 slug（首发传全部 10 模块），在同一 draft Release 中先上传全部包与 `.minisig` 再发布 `modules.json` 和 `latest.json`，模块资产绝不嵌入核心安装包。 |

模块源码位于 `src-tauri/plugins/<slug>/`，共享协议与库位于 `src-tauri/crates/`，安装态采用 `<app-data>/plugins/<slug>/versions/<version>/`、`active.json` 和 `data/`；卸载时清理 `runtime/` 派生缓存但保留 `data/` 直至明确删除。[发布设计](taomni-modular-split-design.md#76-核心与模块差异发布规则v17) · [独立目录工具](../scripts/plugin-package/README.md#production-catalog-preparation)
