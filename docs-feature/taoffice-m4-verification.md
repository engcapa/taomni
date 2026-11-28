# TaOffice M4 验证记录

## Word 与 PowerPoint 语料往返

在 Linux x86_64 使用产品提交 `adc72e2760a950bdeb624dbefaf4d8adda751244` 的 Word 0.2.0 和 PowerPoint 0.1.0 读写实现。样本固定于 Apache POI 的 `f63b77bb7497d950073969f9d418f2270dd87edd`。每份输入均比对了 Git blob 身份，原件、输出的 SHA-256 以及逐文件结果列于回执中。 [Word 语料](https://github.com/apache/poi/tree/f63b77bb7497d950073969f9d418f2270dd87edd/test-data/document) · [PowerPoint 语料](https://github.com/apache/poi/tree/f63b77bb7497d950073969f9d418f2270dd87edd/test-data/slideshow) · [逐文件回执](taoffice-research/office-roundtrip-f63b77b.csv)

| 类型 | 输入 | 已生成副本 | 无可编辑段落 | 拒绝的输入 | LibreOffice 重开并读到编辑值 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DOCX | 30 | 20 | 9 | 1 | 20/20 |
| PPTX | 30 | 22 | 7 | 1 | 22/22 |

每次运行选取第一个受支持的非空段落，替换为 `TaOffice roundtrip <原文件名>`。保存后重读编辑值，对比 OPC 部件名和每个解压部件的字节。Word 副本仅变更 `word/document.xml`，PowerPoint 副本仅变更选中段落所在的幻灯片。使用 LibreOffice 24.2.7.2 的独立配置以只读模式打开全部副本，禁用宏和外部链接更新，遍历 Writer 文本与表格及 Impress 形状与表格。42 份副本均读到替换文本。另经 PDF 导出和文本提取，38 份能读到完整替换文本。其余 4 份 PPTX 的编辑值已在 Impress 文档模型中核实，页面可见文字的完整呈现仍待逐页对照。

`deep-table-cell.docx` 触发 Word 的 128 层 XML 嵌套上限。`keyframes.pptx` 内部声明宏演示文稿类型，并包含 `ppt/vbaProject.bin`。语料中的保护文档、字段、SmartArt、图片和嵌入媒体保留其只读语义。Microsoft Word 与 PowerPoint 的原应用重开仍待实机验证。

## Linux 回归

在上述产品提交运行 TaOffice、UI 契约和完整崩溃回归 Browser 选集，88 项中通过 86 项。所有 TaOffice 用例通过。`TC-FILE-OPEN-008` 缺少 SSH/SFTP 夹具。`TC-FILE-OPEN-004` 在第 102 步等待 Markdown HTML 下载超时，相同步骤已在基线 `8eea6ebea` 复现。Browser 回执为 `receipt-run-20261128-115028-521141847`。
