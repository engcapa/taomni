# TaOffice 首批候选验证

核心候选为 0.6.0，核心安装件、PDF 和 Media 的签名产物使用 `107aa2b796c28b18de84c050c57648bc43a7eaac`。Excel 0.1.3 使用后续提交 `9e7a95e22c558bab05cdee5de6259dd8f303dd81`。这次产品修正位于 Excel 模块，其余提交补充用例和安装验证。 [开发分支](https://github.com/engcapa/taomni/tree/feat/taoffice-document-modules)

核心负责文档授权、路由、CSV/TSV、TIFF、归档预览与解压，以及原生另存。PDF 0.1.5、Excel 0.1.3、Media 0.1.1 独立打包，使用核心 API 1。Excel 由模块自己的 Rust 宿主解析和写入。三个模块的清单状态为 `provisional`，复用现有 `media` 分类，通过 `document` 字段注册打开能力。 [设计](taoffice-design.md) · [前端模块契约](taomni-modular-frontend-contract.md) · [UI 规范](ui-standard/UI-STANDARD.md)

## 功能与崩溃回归

| 环境 | Browser | Native | 回执 |
| --- | --- | --- | --- |
| Windows 本机 | 34 通过，1 项缺 SSH/SFTP 测试服务 | 0.1.3 所在候选的 TaOffice 13/13。0.1.3 正式签名 Excel 包专项 2/2，0.1.2 所在候选的正式签名包专项 5/5。另验证了 H.264 播放、键盘控制和切换标签时暂停 | 下文的本机记录 |
| Linux Ubuntu 22.04 X11，Excel 0.1.3 | 35/35 | 39/39 | [GitHub 分片](https://github.com/engcapa/taomni/actions/runs/46007048048) |
| macOS 15 ARM64，Excel 0.1.2 | 35/35 | 39/39 | [GitHub 分片](https://github.com/engcapa/taomni/actions/runs/45966678662) |
| macOS 26 ARM64，Excel 0.1.3 | 35/35 | 39/39 | [GitHub 分片](https://github.com/engcapa/taomni/actions/runs/46007048048) |

Excel 0.1.3 的 Linux 和 macOS 平台矩阵包含 TaOffice 和完整的 `crash-regression` 选集，共 148 项通过。12 个分片均在汇总完成前下载。逐片核对源码、`selection.json`、用例 SHA-256、构建身份、runner 镜像和 `runner_receipt.json` 绑定的 `summary.json`。选集摘要为 `efa14e8f2f123ddae0a35ceecc6d39bc66ad4a7a4a4f300c44bed492f19e2782`。本机下载记录为 `D:/tqa/46007048048/download-times.jsonl`，包括 42 个已校验分片的索引位于 `D:/tqa/taoffice-verified-shards.json`。 [最终汇总](https://github.com/engcapa/taomni/actions/runs/46007048048/artifacts/15205509302) · [选集](https://github.com/engcapa/taomni/actions/runs/46007048048/artifacts/15202337587)

早期组合运行中的 TC-MOBILE-013 未启动监听。仅调整排程单测的 `5b6e4f66e3b52fcb808a8644ffe0af8313117477` 通过 Linux Native 复验，最终矩阵也通过了该用例。 [早期组合结果](https://github.com/engcapa/taomni/actions/runs/45966678662) · [Linux 复验](https://github.com/engcapa/taomni/actions/runs/45972628298)

Excel 0.1.3 所在候选的 Windows Native 完整崩溃集合为 23 通过、3 失败和 1 项缺 SSH/SFTP 测试服务。三个剪贴板用例 `TC-EXPLORER-013`、`TC-FILE-OPEN-007`、`TC-FILE-OPEN-012` 在前一产品检查点复现，也保留了 Taomni 未启动时的剪贴板读取失败记录。先前在 700×480 桌面未通过的 5 个布局与点击用例本轮通过。本机回执位于 `D:/tqa/w9e7` 的 `browser-verified`、`native-feature`、`crash` 和 `native-official-verified` 目录。提交前的 13 项 Native 使用一次性签名身份，正式签名包专项使用 GitHub 产物和核心内置的发布公钥。 [崩溃回归规范](../qa-ui-auto-tests/ci/crash-regressions.md)

全量 Vitest 有 7,819 项通过、1 项跳过和 1 项失败。失败项为 Markdown 菜单关闭后的选区恢复，在分支基线 `32695d3d4` 上复现。文件路由专项 82 项、Rust 查看器 47 项和插件 API 30 项通过。Excel 0.1.3 所在候选另有 30 项前端专项和 8 项 Excel 宿主单测通过。`pnpm check:refactor` 通过命令兼容性、模块边界和源码体积检查。 [用例索引](../qa-ui-auto-tests/feature-list.md) · [Test ID 目录](../.agents/skills/qa-ui-auto/references/testid-catalog.md)

24 份公开 PDF 样本完成页面检查，11 份表单保存副本由 pypdf 校验并由 MuPDF 重开。28 份公开 XLSX 样本中生成 19 份保存副本，8 份在检查范围内没有受支持的编辑位置，1 份布尔值编码无效。Microsoft Excel 16.0（Build 20625）重开了 Excel 0.1.3 生成的 18 份副本。拒绝的东亚日期样本，其原件也无法在该版本 Excel 打开。三份受修复影响的结构化表格都通过重开，数据行的修改正确，表格定义的字节与原件一致。正式签名包执行 TC-TAOFFICE-020 生成的副本也在 Microsoft Excel 重开并核对了标题、两项更改和公式。原件位于 `D:/tqa/w9e7/corpus/reopen.json`、`D:/tqa/w9e7/corpus/official-copy-reopen.json` 和 `D:/tqa/taoffice-excel-office-107/originals.json`。

20 个 TaOffice 用例覆盖文件路由、模块安装、归档处理和查看器交互。PDF 表单用例检查字段编辑、页面实时回显和关闭时的保存操作。Excel 用例检查工作表切换、选区及公式栏、键盘提交与取消。两个 macOS ARM64 镜像都验证了 PDF、XLSX 经原生另存后重新打开。0.1.3 的 Native 用例还验证了结构化表格标题只读和数据行保存。 [PDF 表单](https://github.com/engcapa/taomni/actions/runs/45970886450/artifacts/15187712761) · [Excel Linux](https://github.com/engcapa/taomni/actions/runs/46007048048/artifacts/15204831821) · [Excel macOS](https://github.com/engcapa/taomni/actions/runs/46007048048/artifacts/15205982824)

## 签名包与安装

四目标核心安装件和 12 个 TaOffice 包均已构建并核对 SHA-256。单个模块包低于 100 MiB。签名候选的 `modular-candidate-updater-45966753924` 保存四目标签名验证后的 `latest.json`、`SHA256SUMS` 和源码回执。 [签名候选](https://github.com/engcapa/taomni/actions/runs/45966753924)

| 实装目标 | 软件包 | SHA-256 |
| --- | --- | --- |
| Windows x64 | `Taomni_0.6.0_x64_en-US.msi` | `aeaba27e9ab3859207703cd8db5cce817c206343891b180b272011c0922170e0` |
| macOS ARM64 | `Taomni_0.6.0_aarch64.dmg` | `a0be778a8eaff2b10cfc01848b008721bf17ecbfe41b204c4cf2a4f66414cafc` |
| macOS Intel | `Taomni_0.6.0_x64.dmg` | `91b1c8e3671f59b0d5407b02de09f114655775e8f6a118e2d0976bae08479b50` |
| Linux x64 | `Taomni_0.6.0_amd64.deb` | `b603dec6c99df50dc3b8d91b855a353106fd80dc72923acaea033faf9537c9d1` |
| Linux x64 | `Taomni-0.6.0-1.x86_64.rpm` | `cefcef137fbba8d5e92e913b1e9fd6d5b5c2be5640ecc151c1b360a8f2f79ccb` |
| Linux x64 | `Taomni_0.6.0_amd64.AppImage` | `41171007be58009a8d41b3817e71fa5e58d51fe18b5e5b48cfae9ffaf1ebe745` |

以下回执基于核心候选源码 `107aa2b796c28b18de84c050c57648bc43a7eaac`。安装工件绑定上表的软件包、实装二进制和模块包摘要。原始文件名相对于对应的 GitHub 工件目录。

| 门禁 | 实测 | 原始证据 |
| --- | --- | --- |
| G1 | 固定证书签名的 macOS ARM64、Intel 安装候选均启动了 MFA 宿主。核心和宿主的 Gatekeeper 返回 3。两个 Darwin Excel 宿主使用同一证书签名 | macos26/20261117.0516.1、macos15/20260824.0482.1，`installed-desktop-mfa-crash.json`、`g1-core-gatekeeper.command.json`、`g1-host-gatekeeper.command.json` [ARM64](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198241849) · [Intel](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198301905) · [Excel ARM64](https://github.com/engcapa/taomni/actions/runs/45966753924/artifacts/15189097448) · [Excel Intel](https://github.com/engcapa/taomni/actions/runs/45966753924/artifacts/15189692686) |
| G2 | ARM64 和 Intel 从 0.5.10 升级到 0.6.0 后保留录屏与辅助功能授权，MFA 扫描真实窗口，Mobile 取得实屏图像并向受控窗口发送文本与 Enter。macOS 26 还验证了签名 Screenshot 的真实捕获、OCR 与遮挡，以及签名 RDP Server 的画面和远控输入 | 两个 DMG runner 与 G1 相同，`installed-desktop-upgrade.json` 的 `permissionContinuity` 绑定 `macos-permissions-candidate.json` 与 `installed-macos-mobile.json`，另存 `installed-macos-mfa-screen-scan.json`。macOS 26 两个签名包原件为 `TC-MODULES-061/signed-screenshot-running.json`、`TC-MODULES-065/signed-rdp-server-input.json` [ARM64](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198241849) · [Intel](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198301905) · [Screenshot](https://github.com/engcapa/taomni/actions/runs/45982912269/artifacts/15195010944) · [RDP 输入](https://github.com/engcapa/taomni/actions/runs/45982912269/artifacts/15196640318) |
| G3 | Windows MSI 在 Defender 实时保护开启时启动带 Internet zone 标记的宿主，Authenticode 返回 `NotSigned` | win25-vs2026/20261123.321.1，`core-payload-receipt.json`、`installed-desktop-mfa-crash.json`、`g3-defender-before.stdout.txt`、`g3-host-before.stdout.txt` [Windows 安装](https://github.com/engcapa/taomni/actions/runs/45982048583/artifacts/15189289473) |
| G4 | deb、RPM、AppImage 完成 `noexec` 拒绝、配置搬迁和恢复 | ubuntu24/20261122.23.1，`installed-mfa-evidence/installed-mfa-profile-relocation.json` 及 `rpm`、`appimage` 子目录 [Linux 安装](https://github.com/engcapa/taomni/actions/runs/45980995454/artifacts/15189854856) |
| G5 | RPM 实装 RDP 首帧 87 ms，填充率 100%，输入到画面 p95 38.4 ms、40/40 样本，55.39 fps，386.91 kbps。2186 次压缩更新，0 次解压错误。阈值为 500 ms、130 ms、25.6 fps 和 4905 kbps | ubuntu24/20261122.23.1，`installed-mfa-evidence/rdp-performance/installed-rdp-performance.json` 绑定实装二进制和 RDP Server 0.1.2 签名包，`perf-connect.json`、`perf-latency.json`、`perf-throughput.json` 位于同目录 [已安装 RDP 性能](https://github.com/engcapa/taomni/actions/runs/45980995454/artifacts/15189854856) |
| G6 | Windows、Linux、macOS ARM64 和 Intel 已安装候选的核心强退后宿主均退出 | 各安装 runner 与 G1、G3、G4 相同，`installed-mfa-evidence/installed-mfa-upgrade.json`、`installed-desktop-mfa-crash.json` [Linux](https://github.com/engcapa/taomni/actions/runs/45980995454/artifacts/15189854856) · [Windows](https://github.com/engcapa/taomni/actions/runs/45982048583/artifacts/15189289473) · [ARM64](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198241849) · [Intel](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198301905) |
| G7 | 真实签名包安装、启停、无重启更新和回滚通过。Linux 生命周期与完整崩溃回归 31/31 | ubuntu22/20261122.372.1，`run-20261127-104625-781219951/TC-MODULES-042/module-marketplace-observations.jsonl` 与同分片 `runner_receipt.json` [生命周期分片](https://github.com/engcapa/taomni/actions/runs/45979481717/artifacts/15190782903) |
| G8 | Linux 签名拒绝与崩溃回归 29/29，拒绝不受信的分离签名、篡改目录和旧目录序号。安装后渲染器篡改拒绝另有回执。签名目录演练新增 Excel 的 XLSX、XLSM 四目标关联，将序号从 1 增至 2，并保留其他模块和 `legacyUpgrade` | ubuntu22/20261116.365.1，`run-20261127-121106-478606592/TC-MODULES-006`、`run-20261127-120712-440793977/TC-MODULES-022/module-marketplace-observations.jsonl`、`delta-verification.json`、`next-catalog/modules.json.minisig` [29 项摘要](https://github.com/engcapa/taomni/actions/runs/45987108163/artifacts/15195724483) · [不受信签名](https://github.com/engcapa/taomni/actions/runs/45987108163/artifacts/15195913471) · [目录拒绝](https://github.com/engcapa/taomni/actions/runs/45987108163/artifacts/15195907723) · [目录签名](https://github.com/engcapa/taomni/actions/runs/45985352457/artifacts/15192244843) |
| G9 | 四目标依赖图和前端包核验通过。Calamine、TaOffice 前端及 PDF.js 由独立模块交付 | ubuntu24/20261116.133.1，inventory-receipt.json、cargo-tree-*.txt、vite-manifest.json [核心清点](https://github.com/engcapa/taomni/actions/runs/45967077434/artifacts/15183027862) |
| G10 | 三平台实际宿主验证超时、取消、重复请求、协议版本、命令和权限边界 | ubuntu24/20261122.23.1、win25-vs2026/20261116.315.1、macos26/20261117.0516.1，`profile-rpc-receipt.json` 记录宿主摘要，`host-process.log`、`service-selection.txt` 保存过程 [Linux](https://github.com/engcapa/taomni/actions/runs/45968987029/artifacts/15183464940) · [Windows](https://github.com/engcapa/taomni/actions/runs/45968987029/artifacts/15183618991) · [macOS](https://github.com/engcapa/taomni/actions/runs/45968987029/artifacts/15183919888) |
| G11 | 已安装 Linux、Windows、macOS ARM64 和 Intel 的双向模式租约及四目标核心入口归属均通过 | 各安装 runner 与 G1、G3、G4 相同，`installed-desktop-mode-lease.json`、`installed-mfa-evidence/installed-mfa-upgrade.json`、`entrypoints.txt` [Linux](https://github.com/engcapa/taomni/actions/runs/45980995454/artifacts/15189854856) · [Windows](https://github.com/engcapa/taomni/actions/runs/45982048583/artifacts/15189289473) · [ARM64](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198241849) · [Intel](https://github.com/engcapa/taomni/actions/runs/45998535320/artifacts/15198301905) · [入口清点](https://github.com/engcapa/taomni/actions/runs/45967077434/artifacts/15183027862) |

## 本批范围

首批候选覆盖 PDF 阅读与 AcroForm、Excel 的 XLSX/XLSM 预览与 XLSX 文本及数值另存，以及系统 WebView 支持的音视频播放。PDF 批注与页面操作、Excel 公式重算、媒体高级解码，以及 Word、Project、PowerPoint 和 Visio 属于后续设计。 [阶段和验收](taoffice-design.md#112-阶段m0-落地后才开始-m1)

## Excel 0.1.3 签名目录演练

四目标的 Excel 0.1.3 软件包均已签名，包摘要与 `next-catalog/modules.json` 对应目标的记录一致。目录序号由 1 增至 516，保留了 10 个已有条目和 10 个 `legacyUpgrade` 条目。Excel 条目登记 XLSX 和 XLSM。两个 Darwin 宿主都有独立的系统签名记录。 [演练回执](https://github.com/engcapa/taomni/actions/runs/46007048254/artifacts/15203221180) · [Linux](https://github.com/engcapa/taomni/actions/runs/46007048254/artifacts/15200354898) · [Windows](https://github.com/engcapa/taomni/actions/runs/46007048254/artifacts/15202483045) · [ARM64](https://github.com/engcapa/taomni/actions/runs/46007048254/artifacts/15202690859) · [Intel](https://github.com/engcapa/taomni/actions/runs/46007048254/artifacts/15202284674)
