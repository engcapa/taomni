# TaOffice M3 验证记录

产品提交为 `88a05920c14f006addb95882b5280a910b8cce31`。后续提交 `bed742e0a94fb04826ff7d71eef1146e472db201` 更新 Word Native 用例，产品及测试运行器源码摘要与产品提交相同。分支在 `372fe9084` 合入 `origin/main` 的 `7b67c1e0c`，核心版本为 0.6.1，模块使用核心 API 1。 [开发分支](https://github.com/engcapa/taomni/tree/feat/taoffice-document-modules) · [模块契约](taomni-modular-frontend-contract.md)

## 功能与文件往返

- Word 0.1.0 支持 DOCX 分页预览、页眉页脚和表格。可编辑只含一个文本 run 的受支持正文段落。另存检查覆盖原件和未修改的 OPC 部件。15 个上游样本中有 8 个生成了副本，由 LibreOffice 重开并核对修改和部件字节。 [Browser 用例](../qa-ui-auto-tests/cases/TC-TAOFFICE-021-word-edit-browser.testcase.yaml) · [Native 用例](../qa-ui-auto-tests/cases/TC-TAOFFICE-022-word-copy-native.testcase.yaml)
- Project 0.1.0 按 MSPDI 命名空间识别 `.xml`，也接受 `.mppx`。甘特视图显示任务层级、里程碑及前置任务，支持筛选、改名和另存。用 MPXJ 的 21 个样本检查了 Project 2007、2013 和 2019 导出的文件，覆盖日历、分配、基线、任务链接和自定义文本字段。14 个样本另存后，经字节比对和独立 XML 解析确认仅修改指定的任务名称。 [MPXJ 样本来源](https://github.com/joniles/mpxj/tree/63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671/junit/data/generated) · [Browser 用例](../qa-ui-auto-tests/cases/TC-TAOFFICE-023-project-gantt-browser.testcase.yaml) · [Native 用例](../qa-ui-auto-tests/cases/TC-TAOFFICE-024-project-copy-native.testcase.yaml)
- Media 0.1.2 支持空格播放和暂停，方向键每次跳转五秒。Native 用例检查 VP8/WebM 的解码尺寸、时长、键盘跳转、播放推进和切换标签后的暂停。用例视频源自 AVI 转码。 [媒体夹具](../qa-ui-auto-tests/fixtures/taoffice/README.md) · [Native 用例](../qa-ui-auto-tests/cases/TC-TAOFFICE-026-media-seek-native.testcase.yaml)
- PDF 表单的关闭回归检查了取消按钮的初始焦点和 Escape 保留表单修改。 [Browser 用例](../qa-ui-auto-tests/cases/TC-TAOFFICE-017-pdf-form-browser.testcase.yaml)

## 测试结果

本地使用 Node 22 和 pnpm 10。12 个 Vitest 文件共 91 项通过。修正用例后，Word XML 和共享关闭对话框的 10 项单测及 Word、PDF 的两项 Browser 回归通过。`pnpm build`、`pnpm check:refactor`、工作流 lint 和 QA 用例目录检查通过。

| 环境 | Browser | 原选集 Native | Word 用例修正后 Native |
| --- | --- | --- | --- |
| Linux Mint 22.3 x86_64 本机 | 77 通过，1 跳过 | 83 通过，1 跳过 | 1/1 |
| macOS 26 ARM64，GitHub Actions | 78/78 | 83/83 | 69/69 |
| Windows Server 2025 x64，GitHub Actions | 78/78 | 首轮 83/84 | 70/70 |

Linux 汇总包括 TaOffice、`ui-contract` 和 `crash-regression`。两种模式各跳过 `TC-FILE-OPEN-008`，本机缺少 SSH/SFTP 配置。Native 使用源自相同提交的 QA release，在 Xvfb `:101`、独立 D-Bus 会话和隔离的应用数据、配置、缓存目录执行。签名安装用本地临时测试密钥。首次 `TC-MOBILE-013` 未在隔离缓存找到 Chromium，在同一个二进制上指定 Playwright 浏览器缓存后通过。主套件和复跑回执为 `receipt-run-20261128-011316-816613983`、`receipt-run-20261128-013030-956189257` 和 `receipt-run-20261128-015224-665723021`。`ui-contract` 的 Browser 和 Native 回执为 `receipt-run-20261128-024322-418363016` 和 `receipt-run-20261128-024322-500620173`。

Windows 首轮的 `TC-FILE-OPEN-005` 在打开 HTML 前失败。夹具创建了 `report.html`，Explorer 却把 `D:/…` 解析成 `/D:/…`，Windows 返回错误 123。用失败回执中的实际路径，在 `7b67c1e0c` 和 `88a05920c` 的地址解析代码上模拟空目录状态，均得到相同的错误路径。目录初始化后，同一输入解析为正确的盘符路径。首轮的三个历史剪贴板用例均通过。 [失败分片](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15224728002) · [首轮汇总](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15225396646)

Windows 同源码复跑的 84 项 Native 用例有 80 项通过。`TC-FILE-OPEN-005` 和 `TC-EXPLORER-013` 均出现同一盘符路径问题。`TC-UIC-020-explorer-notifications` 在向系统剪贴板设置空夹具时超时，PowerShell 命令尚未返回。Word 的 `TC-TAOFFICE-022` 在取消系统另存后过早检查保存按钮，采集失败页面时按钮已恢复。后续用例等待按钮启用，确认原文档仍标记为未保存，再另存并重开副本。四个分片均在汇总产生前下载和验证。 [Windows 复跑汇总](https://github.com/engcapa/taomni/actions/runs/46053044749/artifacts/15226716221) · [Word 失败分片](https://github.com/engcapa/taomni/actions/runs/46053044749/artifacts/15225349472) · [HTML 失败分片](https://github.com/engcapa/taomni/actions/runs/46053044749/artifacts/15226625877) · [Explorer 失败分片](https://github.com/engcapa/taomni/actions/runs/46053044749/artifacts/15226770894)

修正后的 `TC-TAOFFICE-022` 在 Linux 独立桌面通过。复验使用只含核心的 QA release 与临时签名 Word 模块，构建优化级别为 1。原生对话框回执记录了取消和选定新文件两次操作。用例 SHA-256 为 `8a4d833590fd6b8b8a6ec6cec9811741de7e995f9c72a6b02c6249a432971ee5`，回执为 `receipt-run-20261128-033605-712108359`。

修正后的 GitHub 复验在 Windows 和 macOS 共通过 139 项，涵盖 Word 和完整的 `ui-contract`、`crash-regression` 选集。Windows 此前失败的两项目录导航和一项剪贴板用例均通过。两端复用了原 QA release 二进制，并使用最新提交的正式签名 Word 模块。8 个分片均在汇总前下载，选集摘要为 `f0908a2706d503daf894c22206e18b710f26056e0606bc694c0c987691789c58`。 [最终汇总](https://github.com/engcapa/taomni/actions/runs/46058090115/artifacts/15228232330) · [选集](https://github.com/engcapa/taomni/actions/runs/46058090115/artifacts/15227277892) · [分片实时索引](https://github.com/engcapa/taomni/actions/runs/46058090115/artifacts/15227958210) · [Windows Word 回执](https://github.com/engcapa/taomni/actions/runs/46058090115/artifacts/15227659397) · [macOS Word 回执](https://github.com/engcapa/taomni/actions/runs/46058090115/artifacts/15228890027)

## 回执与构建身份

首轮 12 个分片均在汇总产生前下载。选集摘要为 `0ed170d2ad3332bd8cf6c0a6d574a5c56966345ae97397edb6f2caf5d0340142`。逐片核对 `selection.json` 中的源码与用例摘要、`ci-outcome.json`、Native 的 `build-identity.json`，以及 `run-*/runner_receipt.json` 绑定的 `run-*/summary.json`。macOS 和 Windows Native 均使用本轮构建的正式签名模块包。 [选集](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15221762632) · [分片实时索引](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15225945414)

| Native 环境 | QA release 二进制 SHA-256 |
| --- | --- |
| Linux x86_64，本机临时签名密钥 | `46096e836dbb59f7dd4ea63dcb32b3d96dae7bd5b3d4e69654ad594bab7b7662` |
| Linux x86_64，Word 修正复验 | `a9de9c7d0c239f5fba12e950d2b726cb6566219d480a72689c0c91075a7ab332` |
| macOS 26 ARM64，`macos26/20261123.0526.1` | `1537da18eda3308473106d21fa7a196bd7b30c00e437712324cc16cb0018732b` |
| Windows x64，`windows-2025-vs2026/20261123.321.1` | `89769f182b7193d25bd6b6e4615624d1bdbea13f79ac2b88a640a85961e84250` |

| 首轮原始分片 | 工件 |
| --- | --- |
| macOS Browser | [1](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15223590125) · [2](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15222810957) |
| macOS Native | [1](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15224775052) · [2](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15223652573) · [3](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15224150713) · [4](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15222114986) |
| Windows Browser | [1](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15222558215) · [2](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15223161012) |
| Windows Native | [1](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15224762627) · [2](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15225391628) · [3](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15224728002) · [4](https://github.com/engcapa/taomni/actions/runs/46045339273/artifacts/15224822865) |

## Project 二进制导入

Project 0.3.0 用隔离的原生宿主读取 MPP。前端通过当前文档的只读授权分块上传，导入后的调度数据进入现有甘特视图，系统另存对话框只接受 MSPDI XML 副本。MPP9、MPP12 和 MPP14 的 21 个样本均已转换。独立 XML 解析确认 650 条任务的名称和日期、64 条前置关系、67 份日历及 629 条资源分配记录与读取模型一致，导出包括 350 条任务基线。Microsoft Project 重开验收待完成。 [二进制样本来源](https://github.com/joniles/mpxj/tree/63cdc4e8dd9eaa4c7b87158dcbd5fda77a04b671/junit/data/generated)

宿主固定使用 LGPL-2.1-or-later 的 `mpxj-rs` 0.1.1。核心无默认特性构建的依赖树排除导入宿主和引擎。模块正式分发需要随包提供许可证、对应源码和重新链接路径，链接方式按设计 §8.6 的发布前复核执行。 [依赖许可证](https://github.com/lyj-514328/rust-mpxj)

## 待验证范围

Word 当前保留原文件的静态分页，支持编辑混合格式 run 和表格单元格，正文之外的复杂对象继续只读。Project 已接入工作日历和前置关系的调度重算，任务日期和完成度、依赖及资源分配编辑仍待补齐。旧格式媒体通过独立 FFmpeg 命令验证过 AVI、FLV 和 WMV 的可转换性，应用内第三档解码或转码仍待集成。PowerPoint、Visio、视频编辑、PDF 批注和页面操作、Excel 公式重算属于后续阶段。 [设计与阶段](taoffice-design.md#112-阶段m0-落地后才开始-m1)
