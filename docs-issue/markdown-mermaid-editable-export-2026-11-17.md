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
