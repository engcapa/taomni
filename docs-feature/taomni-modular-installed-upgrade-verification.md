# 已安装 0.5.9 升级验证输入

本批补 TASK-012 / AC-017 / V-012 的真实旧版安装输入。生产仍只执行只读预检和 pending journal；候选安装包替换、真实 exporter、可信 staging、激活、中断恢复和回滚仍须后续交付。用例尚未在 GitHub 执行前不记通过。

## 输入与执行边界

`TC-MODULES-027` 使用公开正式 Release `v0.5.9`（release ID `443581958`），按平台固定资产 ID、文件名、长度和 SHA-256。下载不足、内容变化、非 HTTPS、未知架构均失败，不从 latest 或候选构建生成“旧版”。完整常量保存在 `qa_ui_auto/legacy_release.py`。

| 平台 | 真实安装方法 | 资产 ID | SHA-256 |
|---|---|---|---|
| Linux x86_64 | `apt-get install` deb，并查询 dpkg 注册版本和架构；不是只解包 | 741932993 | `f62218535835d6103f0c51d9cfdc7baf29a148981031965425025c53eaa0b00c` |
| Windows x86_64 | `msiexec /i` 静默安装到 run-owned INSTALLDIR，检查实际 exe 版本；不是 `/a` | 741933721 | `dfdb0b246808768dd46469d3e64872994d0ee61068a34d15ab1bc567cf2faa8e` |
| macOS ARM64 | 只读挂载 DMG，drag-install 到 run-owned Applications，检查 plist/签名 | 741932423 | `61351e3dc809a356fd59584275baae86aceaac858b11c09813f8be70605daafa` |
| macOS Intel | 同上；仅使用显式 Intel runner 时执行 | 741933471 | `f0b558fc38b63791b22685c320c4b269cce8df7e2c80054b762f27ee80f8320b` |

只允许 `engcapa/taomni` GitHub runner 执行安装。本地仅运行纯工具单元和静态检查。安装和下载原件放在该 run 的 `_workdirs/legacy-install/`，不污染候选 QA binary，也不被报告归档重复上传。安装命令、退出状态、实际 binary hash、系统签名观察和旧进程日志另存于 case 的 `legacy-install/`，由 runner receipt 绑定。

## 场景与独立断言

1. `reset_db` 清理候选 QA 的 run-owned profile。只接受空目录和该次 native isolation 环境，不接触用户 profile。
2. 实际安装后，运行旧 binary 的公开入口 `--headless --data-dir <该 profile> --mobile-port 0`。必须看到真实 loopback endpoint；由旧 binary 创建实际 schema、Vault、历史 LanChat store 等，不用测试 SQL 创建旧 schema。
3. 旧进程退出后，在旧 schema 中插入明确标注为合成输入的 SSH/VNC 行，再运行旧 binary 重开一次，检查完整原记录保持。空 Servers / RDP pin 表不得推荐这些模块。未通过旧版 UI 创建 MFA secret，不能将该场景称为真实 MFA 迁移。
4. Unix 的旧进程必须经 SIGTERM handler 正常退出且 exit=0。Windows 0.5.9 使用 GUI subsystem，headless 没有退出 IPC，本场景明确强停其拥有的进程树并作为 crash/recovery 输入；不假称旧版正常退出。异常/超时执行有界清理并保留失败，不遗留进程。
5. 候选 release QA binary 打开同一 profile，通过真实 Settings/IPC 预检，必须只推荐 `vnc-client`，显示两种历史 chat 文件名保留，无误报或 error，预检前不写 journal。
6. 显式点击迁移后仍为 pending，恰好一项 `vnc-sessions`，源为真实 `taomni.db` 指纹、target 为空；不得创建伪模块版本、数据目录或 active 指针。
7. 候选通过真实窗口关闭/退出重启。用例精确声明单个 Settings tab 的 Exit title/message/confirm label，由 runner 确认一次并观察旧 QA owner 退出；不能以 kill 或任意确认代替。重开设置、再点迁移，journal 必须保持一致，完整旧会话行不得改变。
8. 仅独立 QA oracle 对旧 `lanchat.sqlite` / `lanchat.db` 及已有 WAL/SHM 计算长度/hash，核对文件集合和字节保持；新产品不读取、复制、迁移或删除这些历史文件。已有 `TC-MODULES-025` 继续使用两个非法 SQLite 文件检查同一产品边界；browser `026` 保留显式 renderer 模型。

macOS 保留原始 `codesign` 与 `spctl` 结果。直接 CLI 启动、没有浏览器 quarantine 的测试输入不证明 Gatekeeper 信任；Windows Authenticode 观察同样不等于 SmartScreen 通过。此场景不关闭或绕过系统安全检查，也不替代 G1/G3。

## 执行与后续

使用现有 `qa-ui-auto-platforms.yml`，选 `TC-MODULES-005/025/026/027` 与完整 `crash-regression`；Linux Xvfb/Wayland、Windows、macOS release QA。安装输入由该 case 的 fixture 准备，不再增加重复构建的独立 workflow。完成 shard 即下载，逐项核对 selection/source、receipt 签名及 summary hash、native release identity 和安装/旧进程证据。

新增 fixture 不改变生产 IPC 或 UI，browser 026 保护现有 renderer 流程。纯单元验证固定资产替换拒绝、宿主环境限制、配对码脱敏、不伪造旧 schema、不覆盖既有业务行，以及完整旧行/chat sidecar oracle 的拒绝路径；单元成功不算真实安装成功。

源码 `c89a3bfd21ca8ac46c99a25265077bc777adcdb8` 的 [#44024044217](https://github.com/engcapa/taomni/actions/runs/44024044217) 已在执行期间下载并核对 Linux Xvfb、Ubuntu 26.04 Wayland、macOS ARM64 和 Windows 的 027 shard，本用例在四种 native profile 均通过。

- Linux 实际 `apt-get install` / dpkg 记录为 `0.5.9 amd64`，安装的 `/usr/bin/taomni` SHA-256 为 `c0adc7fc3c0cc299af87cd9f17246b3e434b8c3b4bf1815826f8022cd50acd33`；两次旧进程均 ready、SIGTERM handler exit=0、没有强制清理。23/24 份 case 文件均逐份核对 runner receipt 的 hash/bytes 绑定。
- macOS ARM64 实际 DMG drag-install 的 bundle version 为 `0.5.9`，旧 binary SHA-256 为 `ca1ddc81de8953919a443fcfe9d19eb41ec263e1a91548ddc9486993369570bb`；两次旧进程均 ready、SIGTERM handler exit=0、没有强制清理。28 份 case 文件与 receipt 绑定通过。Gatekeeper exit 3 如实保留，CLI 启动不记为系统信任通过。
- Windows 实际 `msiexec /i` exit=0，exe/product version 均为 `0.5.9`，旧 binary SHA-256 为 `d625cc1ca5c3198f0fb82dc8f80e4673ef6779038e0ce395fb3ac4f518fcbea8`，Authenticode 为 `NotSigned`。两次旧进程均 ready，按预定方案强停 owned GUI-subsystem 进程树，exit=1；这是明确记录的 crash 输入，不能称正常旧版退出。18 份 case 文件的 receipt hash/bytes 绑定通过，核验时规范化 Windows 路径分隔符。

四组均完成 preflight/pending/repeat/repeat 四次独立观察、完整旧行与历史 chat/WAL 字节保持，以及候选正常重启。上述结果只覆盖本方案所述真实安装输入与 pending，不替代下述生产升级事务，也不覆盖未执行的 macOS Intel 输入。

本批通过后，下一步仍是核心可信 exporter 与验证包 staging 的生产事务，以及候选安装程序对真实已安装版本的替换/中断/回滚。G1–G11 未闭合前不得切换 MFA 或其它业务 owner。

## 正式 0.5.10 安装输入

`TC-MODULES-027` 的现用安装输入固定到 `v0.5.10`（release ID `449346766`）。2026-11-18 的同标签发布替换了四个安装件。下表记录 03:25–03:26 UTC 重新上传的资产。runner 的准备步骤用只读 token 通过 GitHub Releases API 按资产 ID 取件，核对字节长度及 SHA-256。fixture 在启动安装前复核文件，安装后检查应用版本。候选与旧版显示版本相同，因此分别核对安装件、旧程序与候选 QA 程序的指纹。 [正式发布](https://github.com/engcapa/taomni/releases/tag/v0.5.10)

| 目标 | 资产 ID | 字节 | SHA-256 |
|---|---:|---:|---|
| Linux x64 deb | 761714749 | 109669454 | `237b5b3ae296e74d3227d9c1135d72caa189eb5fd41be7fb0042016bc39adb8a` |
| Windows x64 MSI | 761715464 | 96120832 | `8b51c045c09a3411a4bd3a44613c48bb4e50192a5eaa4f6d0cf91e5135921237` |
| macOS ARM64 DMG | 761714079 | 98517685 | `d5a78bddf9d71a4cce9ba57c3b744f14878806eece0283e181b0a48891645dab` |
| macOS Intel DMG | 761715279 | 104617252 | `e6f8f3eb7f4f3af4e29e53d7870bc48a55a9d0b34de05724ced95e62a4514e2c` |

`TC-MODULES-027` 在上述旧安装预检与重启之后，通过真实签名 QA 目录触发首装。候选主窗自动下载模块并写入当前版本指针，模块商店读到已安装状态。测试复核旧会话、历史文件摘要及尚待迁移的 VNC journal。该目录提供用于验证自动安装的 Hello 包，正式首批目录随业务模块发布。

## 原生 Linux MFA 升级

`TC-MODULES-039` 安装固定 deb，用 WebDriver 操作正式 `0.5.10` 的桌面界面，在隔离 XDG profile 新建 Vault 和 RFC HOTP 测试账号。推进到计数 1 后通过应用的退出确认关闭窗口，等待该进程组中的应用和 WebKit 子进程退出。fixture 保留实际安装记录、关闭凭据以及源 MFA 和 Vault 数据库的 SHA-256。它将数据库和存在的 WAL 交给隔离的候选 QA profile。

候选执行生产离线维护入口，用真实签名包、原口令和旧库提交迁移。随后在候选界面用原口令解锁，校验原发行者、计数 1 的验证码和计数 2 的新验证码。设置页的自动重启独立由 macOS `TC-MODULES-038` 覆盖。正式候选安装器的原位替换和 rollback 仍需端到端执行。

## Linux 安装件替换与回滚

十模块演练在 `qa-modular-upgrade.yml` 选择 `package_first_release_linux=true`，传入生成签名目录的联合构建 run、源码和版本。runner 通过 apt 安装固定的 0.5.12 deb，用旧桌面创建 Vault 和 HOTP 账户，再用同一安装位置的候选 deb 打开原 profile。第一次打开会从已签名目录安装全部本平台业务模块。在设置卸载 Mail 后正常退出并重启，核对其余模块的版本指针、签名包摘要、下载次数和商店状态。随后使用这次业务发布的 MFA 包迁移原账户，降级后核对原计数器，再升回候选核对迁移后的计数器。结果保存在 `installed-linux-mfa-upgrade-<run-id>/installed-mfa-evidence/` 的 `first-release-build.json`、`installed-first-release.json` 和 `installed-mfa-upgrade.json`。

使用 Release Bundle 的仅产出 artifacts 模式生成 QA 版本 `0.5.11`。在 QA Modular Upgrade Contracts 设置 `package_upgrade_linux=true`，传入构建 run ID、完整源码 SHA 和包版本。工作流按上传的资产 ID 下载真实 deb，用同一源码为 Linux 生成签名 MFA 包。 [候选包构建 #44243313388](https://github.com/engcapa/taomni/actions/runs/44243313388)

GitHub Linux runner 从已安装的 `0.5.10` 界面创建合成 MFA 账户，经正常退出后在同一 XDG profile 上更换安装件。候选通过离线维护迁移，实际 UI 解锁并推进计数。降级到原 deb 时核对旧二进制指纹及旧库验证码，再装候选时核对候选指纹及模块中的新验证码。安装命令、源码和包 receipt、界面关闭及逐阶段结果归档在 `installed-linux-mfa-upgrade-<run-id>`。

GitHub Linux x64 已完成全程。候选源码 `c660c6bb68578e7943594fff33a2963af65f659a` 的 deb 来自构建资产 `14403262209`，SHA-256 为 `c65382dc50e7e7e20c276c26aabb5143eba9b6e761eab8cdf63177a522906544`。原位升级到 `0.5.11 amd64` 后，原口令解锁成功，HOTP 从 `287 082` 推进到 `359 152`。降级到 `0.5.10 amd64` 核对了原二进制指纹与原库 `287 082`。重装 `0.5.11` 再读取模块计数，得到 `359 152`。资料来自核对过的发布安装件和同一隔离 profile。 [实际安装和回滚 #44250423203](https://github.com/engcapa/taomni/actions/runs/44250423203)

### Linux 安装格式的 noexec 恢复

`package_relocation_linux=true` 在真实 deb 升级、回退和重装之后验证原生恢复。工作流使用 `package_signed_run` 取得候选源码匹配的已验签 MFA 资产，并从同一发布构建取得 RPM 和 AppImage。RPM 在 Ubuntu 上由 `rpm` 安装，使用已安装的发行版依赖。AppImage 使用其 `extract-and-run` 模式，X11 正常退出依据真实应用进程。

三种格式各自在原配置目录应用 `noexec`。MFA 显示 `MODULE_HOST_NOEXEC`、受影响路径和 `XDG_DATA_HOME` 指引。正常退出后复制 14 项应用数据及已验签模块到可执行目录。新位置用原口令解锁，账号从 `359 152` 推进至 `969 429`。验证复核原始摘要、历史 LanChat 文件及挂载清理。 [验证 #44405163808](https://github.com/engcapa/taomni/actions/runs/44405163808)

### Linux 已安装应用的强制退出

GitHub runner 在实际替换、回退和重装 deb 后，通过设置页打开已迁移的 MFA，并将 HOTP 推进到 `969 429`。runner 按驱动进程组、可执行文件路径、父进程和内核启动时间绑定应用与签名宿主，只向应用的 pidfd 发送 `SIGKILL`。两个 pidfd 都在测试驱动清理前报告退出。再次启动同一安装与配置，原口令和账号可用，HOTP 由 `969 429` 推进到 `338 314`，已安装的宿主摘要和版本指针保持一致。候选产物使用 `c660c6bb6`，验证脚本使用 `bc26bab58`。 [安装验证 #44416333190](https://github.com/engcapa/taomni/actions/runs/44416333190)

### Windows MSI 与 macOS DMG 替换

QA Modular Upgrade Contracts 使用 `package_upgrade_desktop=true` 运行已上传安装包的替换和回滚。`package_targets` 列出有产物的平台，例如 `windows-x86_64,darwin-x86_64`。输入包含 Release Bundle 的 run ID、完整源码 SHA 和候选版本。

Windows 安装和回退走 `msiexec`。测试读取两个 MSI 的 ProductCode 和 UpgradeCode，并核对系统实际注册的安装状态。macOS 通过只读挂载 DMG 和 `ditto` 替换隔离 Applications 下的同一个 app，留存 `codesign` 与 Gatekeeper 的原始结果。各端对比原安装、候选及回退的可执行文件摘要，在同一隔离 profile 启动实际已安装二进制并读取原 SSH/VNC 会话。候选运行后核对历史 LanChat 库及现有 sidecar 的原字节。此场景验证安装替换、旧会话和启动后的可回退性。Windows/macOS 的完整 MFA 数据迁移仍由对应 native 与安装专项场景验收。

G11 的安装件专项在一次性 runner 上预留实际 `com.taomni.app` 数据目录，遇到已有目录即停止该场景。候选 GUI 创建 profile 后，运行同一可执行文件的 headless 入口，检查其退出码、占用错误和未创建监听端口的结果。结束 GUI 后重开同一 profile 的 headless，再用实际安装的 GUI 复核反向互斥和 profile generation。进程与包身份、两次拒绝的详细结果留在 `installed-desktop-mode-lease.json`。已安装宿主的强退回收仍由 G6 专项验证。

Windows x64 和 macOS Intel 已完成 `0.5.10 → 0.5.11 → 0.5.10` 的实际安装、profile 重开和回退。候选安装包均来自 `c660c6bb68578e7943594fff33a2963af65f659a`，MSI 资产 ID `14404860675`，Intel DMG 资产 ID `14404300717`。两端原 SSH/VNC 会话及候选运行前后的历史库核对通过。Windows 测试对正常运行的 GUI-subsystem headless 进程按既有方法执行受控强停，安装的可执行文件报告 `NotSigned`。macOS 三次进程均由正常退出信号完成，候选 DMG 的代码签名校验成功，Gatekeeper 评估 exit 3。 [安装替换与回退 #44292054057](https://github.com/engcapa/taomni/actions/runs/44292054057)

macOS 15.8.2 ARM64 已完成同一版本链路。候选 DMG 来自源码 `26a6471d014711bda960df3eaee1d9eaf2cd1131`、资产 ID `14425596053`。使用同一隔离 profile 重开并复核原 SSH/VNC 会话与历史库，回退后恢复旧版摘要。候选 app 和 updater app 的代码签名校验成功，Gatekeeper 评估 exit 3。 [ARM64 候选构建 #44293901398](https://github.com/engcapa/taomni/actions/runs/44293901398) · [安装替换与回退 #44300055546](https://github.com/engcapa/taomni/actions/runs/44300055546)

### macOS 26 签名宿主与强退恢复

macOS 26.7.2 ARM64 在 `macos-26-arm64` 镜像 `20261117.0516.1` 上通过 0.5.10 → 0.5.11 安装替换、profile 双向互斥和回退。DMG 生产源码为 `c16b4218ac68eb5028c079b542b0044525ecd5b9`，选用构建 #44799259990 的工件 `14668975419`，DMG SHA-256 为 `f7c33f26aec9b3c8d80dcbc597e8cf489f1d5b75ad5a0d240c5692ca6a488037`。验证工具源码为 `0d07a68d59a92edde5a6ecc28e5a395175da52e5`。 [候选构建](https://github.com/engcapa/taomni/actions/runs/44799259990) · [验收与原始日志](https://github.com/engcapa/taomni/actions/runs/44816840208/job/136569044783)

核心与 MFA 宿主均通过固定证书验证，且均启用 hardened runtime。已验证包的 SHA-256 为 `f6a6ac5d14bc48e4cb203a4e8347cd4d8ada7784be0371677e199050282bf171`。候选核心实际拉起带隔离属性的 MFA，核心收到 `SIGKILL` 后宿主在驱动清理前退出。重开后保留原 HOTP 并推进一次。屏幕录制与辅助功能授权在新旧核心间均保留，两个签名主体的 Gatekeeper 评估均返回 3。原始记录为 `qa-ui-auto-report/github/44816840208/live-contracts/modular-bundle-darwin-aarch64-44799259990/` 下的 `bundle-baseline.json`、`installed-desktop-upgrade.json`、`installed-desktop-mode-lease.json`、`installed-desktop-mfa-crash.json` 和 `macos-permissions-*.json`。 [GitHub 工件](https://github.com/engcapa/taomni/actions/runs/44816840208)

Windows MSI 和 macOS 双架构 DMG 的十模块演练使用同一个 `qa-modular-upgrade.yml` 入口，选择 `package_first_release_desktop=true`、联合构建 ID、源码及版本。三个 runner 分别用正式 0.5.12 创建并重开同一份 profile，在原位置安装候选包，从这次构建的签名目录安装业务模块，卸载 Mail 并正常重启，然后恢复旧安装并核对原会话。每端将安装件、目录与全部模块的摘要、应用退出、实际请求及回退结果保存在 `modular-bundle-<target>-<producer-run>/`。仅核心安装件采样以及 0.5.10 模式互斥与崩溃恢复仍可单独执行。
