# TaOffice M4 验证记录

## Windows 编辑与另存验收

受测产品提交为 `f6388728bbf1ce74f1567d0fb2b8321946c86cb8`。Windows Browser 选集通过 94 项，Native 通过 100 项，各有 1 项因缺少 SSH/SFTP 夹具而跳过。两个模式下的 TaOffice 均为 33/33。Browser 的 UI 契约为 40/40，崩溃回归为 34/35。Native 分别为 42/42、38/39。跳过的是同一个 `TC-FILE-OPEN-008`。

| 编辑入口 | Windows Browser | Windows Native |
| --- | --- | --- |
| Word 页面 | 021 验证在纸张内编辑正文与表格、保留混合格式和取消关闭后的草稿。053 验证旧格式转存及归档内只读预览。 | 022 将两页 DOCX 另存并从磁盘重开。054 将 DOC、ODT、RTF 分别转存为 DOCX，并检查原件哈希。 |
| Excel 工作表 | 019 验证网格内输入、无效数值反馈、Tab 提交与移动、表头与公式保护、取消关闭后的草稿。 | 020 安装签名模块、取消系统另存、再次保存并重开 XLSX。Microsoft Excel 16.0 build 20625.0 用普通只读方式打开副本，Totals 工作表保留 QuarterlyTotals 表，A2 为 Mechanical Keyboard，B2 为 15.5，C2 保留公式 `=B2*2` 并读到结果 31。 |
| PowerPoint 普通视图 | 039 验证缩略图键盘导航、选中页与编辑区同步、编辑另存和新建演示文稿。059 验证 PPT 与 ODP 导入。 | 040 在取消系统另存后重试，重开并核对两页 PPTX。060 将 PPT 和 ODP 分别转存为 PPTX，再从磁盘重开。 |

Browser 回执为 `receipt-run-20261128-163532-846234100`，Native 主选集回执为 `receipt-run-20261128-164911-719051300`。截图按 Word 页面编辑、Excel 单元格编辑、PowerPoint 缩略图导航排列。其中 Word 截图来自同一提交的 Browser 回执 `receipt-run-20261128-163517-477624800`。Word 纸面与焦点对应 UI-FND-04 和 UI-FOC-02，Excel 输入与键盘行为对应 UI-INP-06、UI-INP-07、UI-KEY-04，PowerPoint 列表导航对应 UI-LST-03 和 UI-LST-05。[三个编辑界面](taoffice-research/office-windows-editing-f6388728b.jpg) · [Windows 原应用逐文件读回](taoffice-research/office-microsoft-reopen-f6388728b.csv)

## PowerPoint 普通视图的幻灯片导航

PowerPoint 0.1.2 在左侧显示按顺序编号的真实幻灯片缩略图，右侧显示所选页或其文本编辑器。单击缩略图、在列表内按上下方向键、Home、End、Page Up 或 Page Down 会同步焦点、选中标记和当前页，输入标题前缀可定位幻灯片。预览和可见缩略图在同一个隔离渲染器中共享已加载的 PPTX，缩略图最长 192 像素、最高 144 像素。浏览器 039 和原生 040 对照 UI-LST-03、UI-LST-05 检查缩略图、焦点、画布以及原有的编辑和另存流程。[Microsoft 365 普通视图说明](https://support.microsoft.com/en-us/powerpoint/training/choose-the-right-view-for-the-task-in-powerpoint)

## Word 与 PowerPoint 语料往返

在 Linux x86_64 使用产品提交 `adc72e2760a950bdeb624dbefaf4d8adda751244` 的 Word 0.2.0 和 PowerPoint 0.1.0 读写实现。样本固定于 Apache POI 的 `f63b77bb7497d950073969f9d418f2270dd87edd`。每份输入均比对了 Git blob 身份，原件、输出的 SHA-256 以及逐文件结果列于回执中。 [Word 语料](https://github.com/apache/poi/tree/f63b77bb7497d950073969f9d418f2270dd87edd/test-data/document) · [PowerPoint 语料](https://github.com/apache/poi/tree/f63b77bb7497d950073969f9d418f2270dd87edd/test-data/slideshow) · [逐文件回执](taoffice-research/office-roundtrip-f63b77b.csv)

| 类型 | 输入 | 已生成副本 | 无可编辑段落 | 拒绝的输入 | LibreOffice 重开并读到编辑值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DOCX | 30 | 20 | 9 | 1 | 20/20 |
| PPTX | 30 | 22 | 7 | 1 | 22/22 |

每次运行选取第一个受支持的非空段落，替换为 `TaOffice roundtrip <原文件名>`。保存后重读编辑值，对比 OPC 部件名和每个解压部件的字节。Word 副本仅变更 `word/document.xml`，PowerPoint 副本仅变更选中段落所在的幻灯片。使用 LibreOffice 24.2.7.2 的独立配置以只读模式打开全部副本，禁用宏和外部链接更新，遍历 Writer 文本与表格及 Impress 形状与表格。42 份副本均读到替换文本。另经 PDF 导出和文本提取，38 份能读到完整替换文本。其余 4 份 PPTX 的完整编辑值仅在这次 Impress 文档模型读回中检出。

`deep-table-cell.docx` 触发 Word 的 128 层 XML 嵌套上限。`keyframes.pptx` 内部声明宏演示文稿类型，并包含 `ppt/vbaProject.bin`。语料中的保护文档、字段、SmartArt、图片和嵌入媒体保留其只读语义。

Linux WPS Office 12.1.2.29183 在隔离的 X11 会话中用“另存为 PDF”重开和导出了这 42 份副本。逐文件回执记录了每个 PDF 的 SHA-256、页数以及按空白规范化后能否提取完整编辑值。Word 为 20/20，PowerPoint 为 17/22。`45541_Footer.pptx`、`45541_Header.pptx`、`45545_Comment.pptx`、`highlight-test-case.pptx` 和 `table-with-different-font-colors.pptx` 的 WPS PDF 均未检出完整编辑值。下节记录这五份原件及副本在 Microsoft PowerPoint 中的首页对照。Microsoft Project 和 Visio 原应用重开仍待有相应应用的环境验证。

### Windows Microsoft PowerPoint 首页对照

使用 Windows 上的 Microsoft PowerPoint 16.0 重开上述 5 份原件，以及用同一组 Apache POI 输入和本分支读写代码重新生成的 5 份副本。逐份核对输入 SHA-256。副本均只变更 `ppt/slides/slide1.xml`，PowerPoint 形状模型和导出的 PDF 首页都读到完整编辑值。直接导出原件和副本的首页 PNG 并排对照，三个标题保留了原色、对齐和两行排版。后两份表格中的较长替换文字在单元格内换行，行高随之增加，邻近内容也出现在截图中。原 Linux WPS 导出的 5 份 PDF 仍保留各自的文本提取结果。[首页对照截图](taoffice-research/pptx-powerpoint-first-page.png) · [逐文件哈希与对照区域](taoffice-research/pptx-powerpoint-first-page.csv)

### Windows Microsoft Word 与 PowerPoint 重开

在 `f6388728b` 的 Windows Native 主选集结束后，按 runner 回执核对 022、040、054、060 的模块包与输出摘要。Microsoft Word 和 PowerPoint 16.0 build 20625 各以普通只读方式重新打开本轮实际保存的 4 份 DOCX 与 3 份 PPTX。全部读回预期编辑值，关闭后文件 SHA-256 均与打开前相同。与上一轮各自的输出逐部件比较，6 份的所有 OOXML 部件字节一致，RTF 转存件仅有 `docProps/core.xml` 的创建与修改时间变化。

同一 PowerPoint 会话还打开了用 `f6388728b` 的演示文稿模块对上述 Apache POI 语料重新编辑得到的 22 份 PPTX。逐件核对输入与输出 SHA-256，每份仅变更 `ppt/slides/slide1.xml`。22/22 均以实际页数打开，从首页形状或表格单元格读回完整编辑文本，正常关闭后副本哈希均保持一致。对前节五份样本又分别导出原件和副本首页。在 1280 像素宽的画布上，五组图片的差异像素外框均与前节记录相同。逐像素对照覆盖这五份的首页，其余样本的结果覆盖页数和首页编辑值。[本轮 30 份 Office 副本的输入、输出与读回值](taoffice-research/office-microsoft-reopen-f6388728b.csv)

历史提交 `1acd5cf3a216f60fe5e6f228290d1a1fd7536ee2` 的 27 份回执包含其 Windows Native 的 7 份系统另存副本，以及 20 份与历史 Linux 输出逐文件 SHA-256 相同的公开 Word 副本。Word 读回正文与表格，PowerPoint 读回两页及其预期标题。27 份文件在原应用重开前后都通过 SHA-256 对比。这 20 份公开 Word 的原应用证据来自该轮，Native 回执为 `receipt-run-20261128-145838-889896600`。[历史逐文件读回与摘要](taoffice-research/office-microsoft-reopen.csv)

## Word 页面编辑与缩放

Word 0.4.0 的编辑区按文档顺序显示正文、标题和表格，纸张宽高与页边距读取自 DOCX 的节设置。用户可在原行列输入文本，Tab 和 Shift+Tab 按正文及表格顺序切换，Escape 返回阅读视图。状态栏的缩放在阅读、编辑间保留。编辑范围为既有的单段文字和表格单元格，带域的段落保留静态值；原始打印预览仍用于检查页眉、图片及复杂版式。TC-TAOFFICE-021、022、053、054 覆盖现代与转换文档的编辑和副本保存。纸张内容遵从 UI-FND-04，键盘焦点遵从 UI-FOC-02。[Microsoft Word 视图](https://learn.microsoft.com/en-us/office/vba/api/word.wdviewtype) · [Word 文档缩放](https://learn.microsoft.com/en-us/office/vba/api/word.view.zoom)

## 旧版演示文稿导入

Windows Browser 回执 `run-20261128-142945-077647600` 同时通过 039、059。059 使用 Microsoft PowerPoint 导出的两页 PPT、ODP，在 Explorer 内导入，直接下载 PPT 的转换结果，编辑 ODP 首页标题后下载。PowerPoint 16.0 build 20625 用普通打开命令重开两份下载文件，读回两页及各自首页标题，第二页均为 Delivery appendix。原件的 SHA-256 在用例中独立核对。PPT 副本的 SHA-256 为 `a0a1fd54e5d38910339a68052d4cb4bbf560e2566fc9d05c64fb7c3fb3b32407`，ODP 编辑副本为 `b7901ddd7af796693111fc8b2d1f836b535b359fd5d60a0b23044717c9b9dc61`。

首次重开暴露两处生成器兼容性问题。Office Oxide 的幻灯片母版和备注母版引用了同一主题部件，PowerPoint 需要独立的备注主题。OfficeParser 生成了空的 normalViewPr，而此节点需要两个恢复布局元素。导入模块在生成副本时分别处理这两种情况，并保留独立的单元回归。签名模块的安装、系统另存与重开由 TC-TAOFFICE-060 验证。

## Project 交换格式语料

使用 Project 0.5.0 宿主的导入代码转换了 MPXJ 固定版本中的全部 19 份 MPX。独立 XML 解析器从生成的 MSPDI 文件读到 305 项任务、23 条前置关系、16 项资源、6 项分配和 39 份日历。德语样本中任务 12 的前置 UID 为 11，滞后量为 4800 个十分之一分钟，开始日期为 2003-01-09。逐文件记录保留了原始 Git blob、输入与输出 SHA-256 和各项计数。 [语料及逐文件回执](taoffice-research/project-exchange-63cdc4e.csv)

## Visio 页面与外观

从 libvisio 0.1.12 的官方源码包取出全部 34 份 VSD 和 VSDX。使用 `adc72e276` 的模块 WASM 和产品 SVG 清理函数解码，再以 Chromium 渲染页面。在独立配置中使用 LibreOffice Draw 24.2.7.2 打开原文件并导出 PDF。32 份图形在两端共得到 34 对可比较页面。另两份 `recursion-cycle.vsdx` 和 `tab-short-prefix.vsdx` 的解码器返回零宽高页面，TaOffice 显示格式错误，Draw 也没有导出 PDF。 [固定版本语料](https://dev-www.libreoffice.org/src/libvisio/libvisio-0.1.12.tar.xz) · [逐页回执](taoffice-research/visio-libvisio-0.1.12.csv)

比较时将页面等比放入 480 × 480 白底画布。34 对页面的宽高比相对差均小于 1.5%。用任一颜色通道低于 224 判定有墨迹后，33 对有墨迹的页面中，两个渲染结果的交并比中位数为 0.3821。薄线、文字换行和图形填充可明显影响该数值。抽查中，`color-boxes.vsdx` 的色块位置吻合，`Visio11PlanWithDimensions.vsd` 的文字换行有差异，`dwg.vsdx` 的嵌入对象填充和 `tdf154379-QuickStyleFillMatrix.vsdx` 的主题填充也有差异。Microsoft Visio 的原应用外观仍待对照。 [六份样本并排截图](taoffice-research/visio-libvisio-0.1.12.png)

Visio 0.1.1 的 VSDX 副本支持修改简单形状的纯文本、PinX/PinY 及已有的字面填充色和线色。编辑器按 OPC 页面关系定位目标。带签名或受保护的文档、带公式的单元格、连接与继承的形状保留查看能力。模块通过核心的文档草稿和另存能力处理关闭、取消及权限。编辑结果保存在用户文档中，模块数据 schema 为 1。

Visio 0.1.2 实现设计 §8.5 的当前页 PDF 对照导出。模块根据已完成预览的草稿生成一页白底、无损位图 PDF，页面尺寸取自原图，屏幕缩放与主题只作用于界面。栅格化的目标分辨率为 192 dpi，单边最多 4096 像素，总面积最多 4194304 像素。若 96 dpi 的完整页面已经超过上限，查看器提示使用 SVG。导出使用共享按钮和窗口所属的另存选择器，保留形状草稿。旧核心按其声明的扩展名提供对应按钮，归档预览和远程临时文件沿用只读规则。适用 UI-CTL-01、UI-PAT-15、UI-FND-04、UI-FND-07。

Windows Chromium 的 TC-TAOFFICE-057 从资源管理器打开两页图纸，将第二页的形状 3 改为 Release confirmed，PinX 改为 4.25 英寸。下载的 SVG 含新文字，下载的 VSDX 重读得到两项新值。与输入逐部件比对，仅 visio/pages/page2.xml 有变化，另 7 个部件的原始内容逐字节一致。用例同时验证焦点返回、无效坐标禁用保存及输入法组词时的 Escape。TC-TAOFFICE-058 包含签名模块的系统另存取消、重试及从磁盘重开，实机回执由集成验证归档。

## 图片预览语料

Image 0.1.0 在 Linux Chromium 上打开了 33 份公开输入。15 份 PSD、3 份 HEIC 和 10 份相机 RAW 输出了可独立读取的 PNG。PSD 与 psd-tools 1.27.0 的内嵌预览或合成图、RAW 与 LibRaw 的内嵌缩略图、HEIC 与 libheif 的输出分别缩放至 48 × 48 后比较了 RGB 像素。平均绝对通道差在 0–255 标度上分别为 0、0–0.84 和 0.03–4.96。逐文件记录包含输入、输出摘要和两端尺寸。 [逐文件回执](taoffice-research/image-preview-corpus.csv)

两份 DNG 没有可显示的内嵌预览，LibRaw 同样报告无缩略图。另一个标为 DNG 的 Samsung 输入实际以 JFIF/JPEG 开头，模块提示无法读取 RAW 目录。两份 HEIF 输入未能解码，其中一份使用非压缩 RGB；本机独立读取器也未能打开。 [PSD 来源](https://github.com/psd-tools/psd-tools/tree/b5637927626c7e577ffb5b8925901fc9d06c69f9/tests/psd_files) · [HEIF 来源](https://github.com/strukturag/libheif/tree/12a259a5882dd99d45ec5fc77e296a3b620d1e2e) · [相机来源](https://raw.pixls.us/)

## 核心 RAR 解压

在 Linux x86_64 用提交 `51049cdb1` 的核心目录读取和解压实现验证了 35 份输入。34 份来自 rars 0.13.1 的固定上游语料，另 1 份模拟普通 RAR5 文件只下载到一半。28 份成功解压，包含 36 个文件、2,334,604 字节。与 UnRAR 7.00 独立解压的目录、文件名和每个文件的 SHA-256 逐一相符，覆盖 RAR 1.3、3.0、4.2、5.0、固实压缩、PPMd、过滤器、注释和恢复记录。3 份密码保护文件和 3 份分卷显示了对应的限制提示，截断文件提示输入不完整。7 次拒绝后目标目录均为空。 [上游样本](https://github.com/bitplane/rars/tree/b7b3ba2d1492b0c5fc68d01678a476184de1e9e1/crates/rars/tests/fixtures) · [逐文件回执](taoffice-research/archive-rar-0.13.1.csv)

## Linux 回归

在产品提交 `adc72e276` 运行 TaOffice、UI 契约和完整崩溃回归 Browser 选集，88 项中通过 86 项。所有 TaOffice 用例通过。`TC-FILE-OPEN-008` 缺少 SSH/SFTP 夹具。`TC-FILE-OPEN-004` 在第 102 步等待 Markdown HTML 下载超时，相同步骤已在基线 `8eea6ebea` 复现。Browser 回执为 `receipt-run-20261128-115028-521141847`。

相同产品提交的 Linux Native 使用 QA release、七份独立签名模块包和隔离的 Xvfb `:108`、D-Bus 与 XDG 目录。主选集 94 项中 91 项通过，1 项缺少 SSH/SFTP 夹具。媒体裁剪另存和 Vault 键盘解锁首轮失败，在相同二进制及原用例上各自重跑通过。媒体回执包含取消后恢复控件、原件哈希、导出尺寸与时长，以及重新打开并播放输出。主选集回执为 `receipt-run-20261128-120958-984431962`，媒体与 Vault 的复跑回执为 `receipt-run-20261128-125125-036784396` 和 `receipt-run-20261128-131503-783536615`。
