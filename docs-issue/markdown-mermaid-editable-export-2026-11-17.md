# Mermaid 查看与 draw.io 导出回归修复

## 用户问题与根因

- Markdown 反复选择文本后，导入 draw.io 按钮不断增加。实际挂载 CodeMirror 的回归测试复现为 3 个按钮；导入与导出组件在同一父节点用了相同的文档 key。
- 查看器 SVG、PNG、draw.io 保存均使用 Download 图标，无法直接区分格式。
- 原转换器为整个 Mermaid 图添加 group，所有连接都强制直角路由；sequence 类型未列入转换，直接回退 SVG 图片。

## 变更边界

- 导入/导出的文档 key 各自加命名空间，保持切换文档时清理异步任务的原有生命周期。
- 三种格式使用 FileCode2、FileImage、Workflow 图标，并显示 SVG、PNG、draw.io。保留工具提示、可访问名称和忙碌禁用行为。
- 分离解析入口、通用几何/视图变换、节点图转换、时序图转换。新增模块均小于 200 行；不向现有大组件添加转换职责。
- Mermaid 图形的全部元素直接归属图层，没有整体组合。子图轮廓也是独立可编辑形状。第一个元素的 mxGraph user object 保留原始 Mermaid 源码，不承担父容器职责。
- 使用实际 SVG 的线段、折点与路径。折线保留每个顶点；曲线转换为标准 draw.io 曲线连接并保留采样路径（最多 256 段），不强制直角自动路由。连接仍绑定实际节点，保持箭头、虚线和关系基数。
- 旋转、翻转和全文导出的偏移应用于每个元素、连接锚点和控制点。
- 用户提供的时序图保留独立参与者、生命线、9 条消息、3 条自调用、激活条、循环框和自动编号；文本均可编辑。Actor 用原生椭圆、线段和文字构成。仍不支持的其他图族继续明确回退 SVG。
- 文本模式导入 draw.io 时，不把时序图编号/参与者标签从图形中抽走。

## 验收与保留能力

| 行为 | 验证 |
| --- | --- |
| 反复选区、Live/Source/Split 切换后只有一个导入/导出控件 | MarkdownEditor mounted regression；TC-FILE-OPEN-025/026 |
| 格式图标、格式文字和可访问名称可区分 | MarkdownDiagramActions unit；025/026 查看器截图 |
| Flowchart、State、Class、ER 标签及关系语义保留 | 原 drawioMermaid/Document 单测；TC-FILE-OPEN-022 实际下载后独立 XML 检查 |
| 用户时序图不再图片化，没有整体组合，消息/激活/循环/编号保留 | 保留真实渲染 fixture 的单测；025 浏览器下载；026 原生保存和独立 XML 检查 |
| 折线/曲线、旋转/翻转和文档偏移 | 几何单测；025/026 的 linear、stepBefore、basis 与时序图输出 |
| 全文/图片、分 Sheet、导入与取消仍可用 | TC-FILE-OPEN-019/020/021，加受影响回归 |
| 应用生命周期与崩溃回归 | 完整 crash-regression browser/native，使用匹配 QA release |

本机证据：`/data-raw-hdd/temp/taomni-six-20261117`；转换探针和修复前复现：`/data-raw-hdd/temp/taomni-mermaid-candidate-20261117`。临时副本已把变更落回当前分支；不把副本探针当成主分支 QA 回执。

当前已通过：Markdown 30 文件/149 单测；独立 draw.io 检查器 5 项单测；TypeScript、refactor 契约/边界/source size；用户时序图通过独立 maxGraph 渲染检查（48 个独立可编辑元素，0 图片回退）。

重点 browser `run-20261117-165210-221367348` 为 022/025 两项通过、identity stable；实际下载文件的独立 XML 检查确认单图 48 个独立元素、全部图片 4 Sheet / 72 个独立元素、没有图片回退，且同时存在保留折点的折线和曲线。已查看格式按钮截图。完整 browser/native 与 Windows/macOS hosted 最终结果运行后回填；dry-run 不计真实执行通过。

完整 Linux browser `run-20261117-165744-683451083` 为 28/28（含全部 18 项 crash-regression），新 025 增加 SVG/PNG 真实下载后，`run-20261117-170555-620597995` 补跑 1/1。两份 receipt 签名有效、identity stable，分别绑定 145/15 个产物，逐文件大小和 SHA-256 独立复核无误。

Linux native 完整批次 `run-20261117-170015-602376762` 为 30/33，全部 22 项 crash-regression 通过，identity stable。三项失败保留原始报告：023 命中隐藏旧 Explorer 的同名文件、026 在异步写盘完成前读 XML、WS085 系统文件管理器抢焦点后触发输入安全检查。用例分别限定活动 Explorer、等待保存完成和返回当前 Git 标签；保留真实文件、剪贴板、PTY 和焦点安全断言。`run-20261117-173646-156961843` 三项全部通过，当前有效并集为 **33/33、22 项 crash-regression**。两批回执分别绑定 747/76 个产物，独立复核签名、源码/runner/QA release 身份、用例指纹、配置和文件散列均通过。

Windows/macOS browser 在 [44052981988](https://github.com/engcapa/taomni/actions/runs/44052981988) 各 **28/28、18 项 crash-regression**；native 均 **31/33、全部 22 项 crash-regression 通过**。原批次因 023 命中隐藏 Explorer、026 在写盘前读文件而失败，两端原因与本机一致；完整原始失败保留，未改写成成功。全部分片在 workflow 结束前下载并独立核验。

023/026/WS085 的用例修正为 `00696cf81`，[44057813183](https://github.com/engcapa/taomni/actions/runs/44057813183) **成功结束**：Windows/macOS 各 **25/25、22 项 crash-regression** 全部通过。八片均已在 workflow 结束前下载，不等待最终汇总。三平台新 026 实际保存的单图均为 1 Sheet / 48 个独立元素，全部图片均为 4 Sheet / 72 个独立元素，同时保留折线与曲线，无图片回退；旋转/翻转和三平台格式按钮截图已复核。

最终有效并集（当前产品、runner、用例和配置；原失败保留，使用修正后的具名补跑）：

| 平台 | browser | native | 完整 crash-regression |
| --- | --- | --- | --- |
| Linux | 28/28 | 33/33 | browser 18 / native 22 |
| Windows | 28/28 | 33/33 | browser 18 / native 22 |
| macOS ARM hosted | 28/28 | 33/33 | browser 18 / native 22 |

最终独立核验保存在证据根的 `independent-mermaid-evidence.json/.log`：签名、source/runner、QA release、用例指纹、执行配置和绑定产物大小/SHA-256；实际导出文件另记 `independent-native-export-files.json`。Linux 同一源码的 Agnes 无代理真实请求另有 1/1，不混入上述 33 项。`pnpm check:refactor`、开发用例契约和 case/control audit 均通过。macOS 截图/桥接按键不作为 OS 层送键或其他 macOS 版本/架构的证据，边界见六项 follow-up 记录。

## 真实 testing.md 追加回归（进行中）

输入为用户原文件 `/home/zhyhang/temp/testing.md`，4510 字节，SHA-256 `c669a35a1cc8ec37aba798b496fa5b6c8c6405118079482bcaec03ee4c27f900`。新增 TC-FILE-OPEN-027/028 保存完全相同的 fixture；本机 native 通过 `TAOMNI_QA_MARKDOWN_SOURCE_FILE` 直接打开原路径，只做浏览和导出，并在前后独立核对哈希。编辑/撤销检查仅在 browser 的隔离副本中执行。

本次实际使用 draw.io Desktop 29.6.6 复现了下方时序图连接点被拉远的问题。上一轮 XML 和应用内 maxGraph 渲染通过，**未证明真实 draw.io 的连接点正确**；上方历史结果只保留其实际验证范围，不能当作本次修复验收。draw.io 的 `anchorPointDirection` 默认为 1，maxGraph 默认为 false；生命线的 `direction=south` 因此重复旋转端口。当前导出显式固定 anchor 语义，并补偿 legacy 对垂直形状 flip 轴的交换。4 种旋转 × 4 种翻转的 16 项端点测试在修复前全部失败，修复后通过。独立 Python 检查器还对实际 XML 按 draw.io 的规则计算全部消息端点，误差不得大于 1.5px。旋转的消息文字改为独立可编辑文字元素，避免 draw.io 仍水平显示边标签而相互覆盖。

真实文件的 Word 流程图含 13 条 `stroke-dasharray="0px"` 线身，箭头另用 marker 绘制。导出明确把 SVG 中无间隙的描边写为 `none` 实线，真正虚线保留数值间隔；不修改预览和原始 SVG。Word 保留两幅矢量图与 600 DPI fallback。新增独立检查器拒绝带箭头但线身为零间隙 dash 的原导出，接受当前实际导出。LibreOffice 可建立本机排版/线条证据，不能替代 Win11 Microsoft Word 的客户端验收。

Live 表格原来直接使用 `textContent` 写原始 Markdown。现在使用现有 marked GFM 解析器与共享 sanitizer 渲染单元格内联格式；可编辑格聚焦时显示原始标记，失焦恢复格式，只读格聚焦仍保留格式。保留 IME 延迟提交、单元格 DOM 身份、Tab/Enter、表格操作与撤销/重做。表格中的图片暂显示 alt，避免引入无所有权的图片请求；链接沿用显式外部打开。

本轮验证选择：完整 Markdown 单测（首次 174 项通过，时序旋转参数化后具名 14 项补测通过），独立 draw.io 检查器 9 项和 Word 线身检查器 3 项；受影响 004/013/014/015/019/020/021/022/025/026/027/028，保留六项近期交付及完整 crash-regression browser 18 / native 22。匹配 QA release 原生验证是用户明确要求，覆盖 WebKitGTK 中的原文件读取、真实导出和 OS chooser；Windows/macOS 通过 qa-ui-auto-platforms 运行。新的证据根 `/data-raw-hdd/temp/taomni-testing-20261117`。此段写入时本机与 hosted 完整验收尚未结束，不把探针或 dry-run 计作通过。

追加人工检查发现：默认字体下 LibreOffice 会截断流程图 SVG 的部分中文，文件内 600 DPI fallback 文字完整。单纯调整字体列表、去除单位、合并 tspan 或添加坐标列表都不能可靠解决。独立实验确认逐字固定中文的浏览器实际位置能够保留原字体、文字内容和矢量清晰度；连续英文仍保留为文本段，以保留字偶距和连字。新增 `wordSvgText.ts` 在冻结样式前读取布局，在写入 presentation attributes 后应用；复杂文字塑形、textPath 或不可用的度量保留原始 SVG，不丢失文字。独立导出检查加入字形位置及三处曾被截断的完整标签；最终仍需匹配 QA release 重新打开原文件验收。

Word 中文追加修复前，本轮 Linux native 完整批次 `run-20261117-222534-951648892` 为 **33/33、完整 22 项 crash-regression**；原文件 028 在 `run-20261117-222408-356048930` 为 **1/1**，42 步全部通过，原文件前后 SHA 一致。有效并集 **34/34**；737/38 个绑定产物的回执签名、源码/runner/QA release、用例、配置与文件散列均独立复核。两图用实际 draw.io Desktop 29.6.6 打开，流程与时序连接正常；PDF 四页逐页检查完整且可搜索。此批是追加字形修复前的验收，不能冒充新产品源码验证。

新增字形布局 7 项单测；完整 Markdown **33 文件 / 182 项通过**。首次有一项既有导入取消测试在按钮恢复启用后立即断言焦点，而产品通过 effect 恢复焦点；保留原失败，把焦点本身作为异步等待条件后完整复跑通过，没有移除焦点断言。独立 draw.io/Word 检查器 **15 项通过**，refactor 契约/边界/source size 通过。新证据独立保存于上述根目录的 `final/`；此段写入时新 QA release 与新源码 browser 正在执行。
