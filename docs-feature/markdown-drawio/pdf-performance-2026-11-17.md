# Markdown PDF 性能对比

测量时间：2026-11-17。优化实现已提交在 `6d7dcdf98`；早一轮配对测量的候选产品版本为 `0c8c037e12ee6f1a322401c0523c8465e147449c`。当前产品版本 `dc6de5f8056f850d1f38b51bb9b3b0dff5701bd4` 另修复 draw.io 原生入口、导出提示布局和快速回复后的历史保存，未改变 PDF 实现。该版本的三平台 PDF 原生复测均已完成；完整功能回归和个别启动准备失败的补跑另见 [验证记录](../tao-home-follow-up/verification-md-history-agent-2026-11-17.md)。

## 当前版本复测

固定 FILE018 文档：15 节正文、表格、中文、Mermaid，12 页 A4，300 DPI。每版三次，全部保留。下面以当前版本的中位数为主；后文保留早一轮较快的受控候选测量，避免只选最快批次。

| 平台 | 旧版确认路径后的等待中位数 | 当前版中位数 | 倍数 / 耗时减少 |
| --- | --- | --- | --- |
| Windows hosted QA release / WebView2 | 47.187 秒 | 6.078 秒 | 7.76 倍 / 87.12% |
| Linux 本机 QA release / WebKitGTK | 138.462 秒 | 16.056 秒 | 8.62 倍 / 88.40% |
| macOS hosted QA release / WKWebView | 无同文档旧版基线 | 5.221 秒 | 不计算提升倍数 |

| 平台 | 当前版三次确认路径后等待（秒） | 当前版三次含自动化保存框（秒） |
| --- | --- | --- |
| Windows | 6.453 / 6.078 / 6.078 | 9.718 / 9.344 / 9.218 |
| Linux | 16.056 / 15.182 / 16.273 | 19.838 / 19.139 / 20.176 |
| macOS | 7.252 / 2.044 / 5.221 | 15.240 / 7.751 / 10.497 |

包含自动化保存框时，Windows 中位数 **51.109 → 9.344 秒**，快 **5.47 倍**，减少 **81.72%**；Linux **142.796 → 19.838 秒**，快 **7.20 倍**，减少 **86.11%**。macOS 当前中位数为 **10.497 秒**。原生保存框返回与导出可能重叠，这两个口径都包含自动化开销，不能当作纯编码函数耗时。

当前 Linux/Windows 各三份 PDF 的全部 12 页实际 RGB 像素、完整 Poppler 渲染、纸张尺寸和搜索文字均与各自旧版一致。Linux 文件保持 4,292,248 bytes（旧版 5,486,223）；Windows 3,634,441 bytes（旧版 4,874,224）。macOS 三份的全部页面与已目视复核的 R15 新版参考一致。保留 300 DPI 和 Unicode 搜索/复制文字层，独立生成文件，不调用打印机。

当前版索引（`qa-ui-auto-report/_local/markdown-drawio/`）：`pdf-linux-performance-r16.json`、`pdf-windows-performance-r16.json`、`pdf-macos-performance-r16.json`。Linux 来源 `native/run-20261117-131148-430500431/`；Windows/macOS 来源 [44020111810](https://github.com/engcapa/taomni/actions/runs/44020111810)，各原生第 4 分片在 workflow 结束前已下载。源码、release 构建、用例/条件指纹、回执和所有证据产物哈希均已独立核验。

Windows 对比来自同类 GitHub runner，并非同一物理机，也不是用户 Win11 原文件的设备实测。Linux 同机的综合回归结果比前一轮独立测量慢，保留两轮以反映负载与执行环境波动。每版三次不支持跨设备的稳定 p95 承诺。

## Linux 桌面 QA release

同一台 Linux 主机、相同 release 配置、WebKitGTK、独立 X11 桌面及软件渲染。固定 FILE018 文档包含 15 节正文、表格、中文和 Mermaid，生成 12 页 A4 PDF，保持 300 DPI。每个版本连续三次，全部保留，不丢弃慢样本。用例 SHA 和执行条件 SHA 相同。

| 计时口径 | 旧版三次（秒） | 优化后三次（秒） | 中位数变化 |
| --- | --- | --- | --- |
| 自动化选完路径后等待保存完成 | 128.193 / 138.462 / 145.253 | 12.258 / 12.197 / 12.588 | 138.462 → 12.258，快 11.30 倍，耗时减少 91.15% |
| 含自动化打开/填写/确认保存框及完成等待 | 132.627 / 142.796 / 150.285 | 15.810 / 15.814 / 16.234 | 142.796 → 15.814，快 9.03 倍，耗时减少 88.93% |

这是包含轮询和自动化开销的固定操作计时，不是内部编码函数的精确时长，也不代表用户手工操作保存框所需时间。机器其他活动存在噪声；三次样本不能支持跨设备的稳定 p95 承诺。

三份实际输出逐页独立比较：每份 12 页，2480×3507 像素，所有页面 RGB 像素完全一致，全部可搜索文字一致。文件由 5,486,223 减少到 4,292,248 bytes，减少 21.76%。优化没有通过降低 DPI、改用 JPEG 或删除搜索文字取得加速。

另保留综合回归中的诊断批次 `native/run-20261117-120811-434418900/`：三次完成等待为 19.563 / 18.775 / 20.767 秒，PDF 仍各为 4,292,248 bytes。该批次同时进行了浏览器布局复现及其他检查，并在运行中修复新发现的 CSS 问题，回执 `identity_stable=false`，不作为同条件性能主对比或最终源码验收。最终 QA release 已在本地 browser/build 完成后复测三次，全部样本保留在本页“当前版本复测”中。

实现减少了长文档的重复 clone、样式冻结、字体和图片嵌入，逐页复用同一份渲染模板；共享相同的冻结 HTML 样式；直接将页面 RGB 无损压缩嵌入 PDF，省去 PNG 编码、解码和再次压缩。

原始证据（工程根目录下）：

- 旧版：`qa-ui-auto-report/md-home-native-20261117/run-20261117-095914-754923723/`，QA release SHA-256 `ab0fa6b9f394b11b8b8f714b6b9d6348bdb4a4725041f5eece072e1a2e2fd825`。
- 候选：`qa-ui-auto-report/_local/markdown-drawio/native/run-20261117-113901-832345372/`，QA release SHA-256 `927d074b2d27d2af30f133dd6e34b29d18134470ff302fcc4841dc0c009cc02f`。
- 独立回执检查：`qa-ui-auto-report/_local/markdown-drawio/linux-pdf-evidence.json`。
- 时间、构建身份及逐页对比索引：`qa-ui-auto-report/_local/markdown-drawio/pdf-linux-performance-current.json`，对应 `pdf-linux-quality-current-{1,2,3}.json`。原始 PDF 保留在各次执行的 `platform-workspaces/` 中。

## Windows GitHub QA release

同一 FILE018 用例和执行条件，Windows hosted release / WebView2，每个版本三次。两次 workflow 使用同类 Windows runner，不能视为同一台物理机，也不能将 runner 时长直接当作用户 Win11 设备时长。候选 PDF 实现对应 `0c8c037e1`；之后 draw.io 导入和提示布局的调整未改动 PDF 实现。

| 计时口径 | 旧版三次（秒） | 优化后三次（秒） | 中位数变化 |
| --- | --- | --- | --- |
| 自动化选完路径后等待保存完成 | 47.968 / 47.187 / 46.828 | 4.984 / 5.266 / 5.219 | 47.187 → 5.219，快 9.04 倍，耗时减少 88.94% |
| 含自动化打开/填写/确认保存框及完成等待 | 55.328 / 51.109 / 50.797 | 8.593 / 8.891 / 8.719 | 51.109 → 8.719，快 5.86 倍，耗时减少 82.94% |

三份实际输出均为 12 页，逐页 RGB 像素、搜索文字完全一致。文件由 4,874,224 减少到 3,634,441 bytes，减少 25.44%。计时包含轮询及自动化开销，特别是原生保存框返回与导出任务可能有重叠，因此同时保留以上两种口径。

`28c92e37b` 的后续 Windows 原生复测三次完成等待为 **6.844 / 6.094 / 6.125 秒**，中位数 **6.125 秒**（相对旧基线快 **7.70 倍**，减少 **87.02%**）；包含自动化保存框的三次为 **10.140 / 9.344 / 9.250 秒**，中位数 **9.344 秒**。三份输出的全部 12 页像素和搜索文字仍与旧基线一致，文件体积相同。该轮记录为 `pdf-windows-performance-r15.json` 及 `pdf-windows-performance-r15-quality-{1,2,3}.json`；原始报告在 `hosted-44012785922/qa-windows-native-shard-4-cdd577ade23a4bf99f0caaf5c9682947/run-20261117-043042-873238800/`。保留两轮数据以体现不同 hosted runner 的运行波动。

原始证据（工程根目录下）：

- 旧版：`qa-ui-auto-report/_local/md-home-20261117/hosted-43999765708/qa-windows-native-shard-4-b1ad4ac2849f480089c5c82ac174d4e7/run-20261117-022344-331761000/`。
- 候选：[44008732252](https://github.com/engcapa/taomni/actions/runs/44008732252)，`qa-ui-auto-report/_local/markdown-drawio/hosted-44008732252/qa-windows-native-shard-4-7a9db29836cd4cb8bc0e6c682bd273ca/run-20261117-042151-389068300/`。该 shard 在 workflow 运行中即已下载。
- 时间、条件、构建身份和三份逐页检查索引：`qa-ui-auto-report/_local/markdown-drawio/pdf-windows-performance-current.json`，对应 `pdf-windows-performance-current-quality-{1,2,3}.json`；候选回执独立核对见 `windows-pdf-evidence-current.json`。

## 浏览器诊断与 macOS

Linux Chromium 函数诊断的旧版三次为 100.146 / 108.048 / 120.639 秒，优化原型一次 15.780 秒，约快 6.85 倍。12 页像素与搜索文字一致。该结果属于原型诊断，正式桌面比较以上表为准。

macOS 的相同 FILE018 在 `28c92e37b` 的三次原生测试均通过，结果如下。当前没有旧版相同长文档的 macOS 基线，不报告 macOS 提升倍数，也不把 Linux/Windows/Chromium 的倍数当作 macOS 的实测结果。

| 计时口径 | 新版三次（秒） | 中位数（秒） |
| --- | --- | --- |
| 自动化选完路径后等待保存完成 | 6.233 / 5.115 / 1.275 | 5.115 |
| 含自动化保存框及完成等待 | 14.793 / 9.254 / 6.550 | 9.254 |

三份各 12 页，均保持 300 DPI，全部 15 节、每节表格末行和 Mermaid 中文标签可搜索；三份的实际页面像素、完整渲染和文字一致。已查看全部 12 页的联系图和首张图形细节，文字清晰且内容完整。原始记录 `pdf-macos-current-r15-active-pages-v2.json`，渲染证据 `pdf-macos-visual-r15/`。原生保存框操作与导出可能重叠，两个计时口径都保留；最终输入的 macOS 原生回归已完成 52/52，本页开头记录其最新三次性能样本。

## 逐页质量复核方法

本轮补充复核发现，jsPDF 的图片资源字典由各页共享。初版外部比对脚本的 `page.images[0]` 不能单独证明后续页面；该旧检查记录保留，逐页等价结论以新版复核为准。产品 QA 的 `assert_export_quality` 已按页面的 `Do` 指令选择实际图像，不受该外部脚本问题影响。

新版逐页读取 `Do` 指向的图像，使用 Poppler `pdfimages` 提取实际绘制的 300 DPI RGB 像素，另用 `pdftoppm` 比较完整页面，并独立核对每页 Unicode 搜索文字及纸张尺寸。Linux 主配对的三份、Windows 两轮各三份与各自旧基线全部通过，每份都核对全部 12 页；macOS 三份也通过相互一致性检查。原始 PDF/回执不作修改，临时解码图片在完成后清除。

结果索引（`qa-ui-auto-report/_local/markdown-drawio/`）：

- `pdf-linux-performance-current-active-pages-v2.json`
- `pdf-windows-performance-current-active-pages-v2.json`
- `pdf-windows-performance-r15-active-pages-v2.json`
- `pdf-macos-current-r15-active-pages-v2.json`
- `pdf-active-page-fingerprints-v2.json`
