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
