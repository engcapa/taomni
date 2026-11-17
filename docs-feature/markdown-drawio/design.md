# Markdown 与 draw.io 互通设计

当前分支 `feat/tao-home-follow-up`，调研起点 `731d5ce9f`。Windows、macOS、Linux Tauri 桌面共用实现；浏览器用于辅助验证。设计决定已确定，实现与验收分别记录。本轮同时保留此前未提交的 PDF 性能优化、目录记忆、Mermaid 查看和主题文案调整。

## 决策与有效图稿

当前图稿：[V2 可编辑示意图](options-v2.drawio)。V1 已被本次用户反馈替代。

| ID | 结论 | 状态与依据 |
| --- | --- | --- |
| DEC-01 | Mermaid 优先导出为 draw.io 原生节点和连线，接受布局变化；不能转换的类型保留 SVG 和 Mermaid 源码并提示回退数量。 | 用户已定，2026-11-17 对图稿第一问题的回复。 |
| DEC-02 | 导入时提供“保留 Sheet 图形布局”和“优先还原 Markdown 文字表格”，必须由使用者选择一种后才能插入。 | 用户已定，第二问题回复“导入时让用户选择1或2”。 |
| DEC-03 | 全文/全部图片、一个 Sheet/每图一个 Sheet 均在导出对话框选择。默认全文、文档页加每图独立 Sheet；文档页用内部页链接标出图片位置。 | 用户明确要求选项；默认是可逆的局部实现选择。 |
| DEC-04 | 导入保留 XML 到标准 `drawio` fence，由本地延迟加载的 `@maxgraph/core` 渲染。文字模式保留 `drawio-source` 原始备份 fence。 | agent 自决：无需安装 draw.io、无需联网、支持 Notes 和普通文件统一保存/Undo。Apache-2.0 依赖仅使用时加载。 |
| DEC-05 | 在线链接本地 deflate + base64 编码，使用 diagrams.net 标准 `#R` URL；复制链接和系统浏览器打开均为显式动作。 | agent 自决：不调用服务器转换接口，不增加应用下载任务或隐式网络请求。系统浏览器沿用其自身网络设置。 |

## 入口和行为

1. Mermaid 预览右键、悬浮更多菜单及大图查看器，在 SVG/高清 PNG 保存操作旁增加“保存 draw.io 文件”和“复制 draw.io 在线链接”。复制/保存的是当前图形，保留其 Mermaid 源码；缩放平移不裁剪输出，旋转/翻转属于导出副本。
2. Markdown 原有导出菜单增加 draw.io，进入独立选项对话框。正文、表格和图片导出共用原生保存、覆盖保护及上次成功目录；取消不写入目录记忆，不覆盖源文档。
3. 选择“全文档”：标题、段落、列表和代码作为可编辑文本对象；表格每个单元格有独立对象、行列和表头元数据。图片嵌入原始数据。选择“全部图片”：仅输出图片、Mermaid 与导入的 draw.io 图形，文档无图时显示错误。
4. Mermaid 流程图、状态图、类图、ER 图通过 Mermaid 的结构化数据库读取节点、端点和分组，导出原生 `mxCell`。每条 edge 必须包含 relative geometry。子图使用 parent-child，保留标签多行文本。其他类型保留矢量图片与源码，反馈给出原生转换数和 SVG 回退数；不能宣称所有 Mermaid 类型已转成可编辑节点。
5. 导入按钮在只读、Live 浏览锁定时禁用；编辑后可选择 `.drawio`/XML。解析非压缩、压缩多 Sheet 或单个 `mxGraphModel`。导入对话框列出全部页、提供预览和独立勾选；全选/取消全选、Escape、Tab 焦点约束、取消恢复焦点。
6. 两种导入方式都只插入所选页。布局方式每页插入 `drawio` fence；文字方式识别文本对象、Taomni 表格及标准 diagrams.net table/row/cell，转换为 MD，未识别图形保留为 `drawio` fence，完整原页保留到可展开的 `drawio-source` fence。普通图形的标签不被误当正文删除。
7. 异步读取期间文档切换/卸载丢弃迟到结果；打开导入后文档发生变化则拒绝向旧选区插入。实际插入是一次 CodeMirror transaction，使用既有 dirty/save/undo，Notes 使用原 owner。

## 数据与安全边界

- `drawioCodec.ts`：文件、页面、链接的格式契约，XML well-formedness 和身份校验；文件/展开总量 20 MB、100 页、10,000 cell；拒绝 DTD、实体、重复 ID。
- `drawioMermaid.ts`：Mermaid 数据到原生图形。`inspectMermaidDiagram` 与现有 Mermaid rendering 使用同一队列，避免跨文档全局数据库串用。
- `drawioExport.ts`：正文/表格/图片分 Sheet、既有 draw.io 模型重编号与嵌入。正文不被栅格化。
- `drawioRender.ts`：原始 XML 与安全渲染副本分离；副本只复制模型/几何白名单，文本去活动 HTML，拒绝外网图片和不安全 style，限制 parent 深度并拒绝循环。引擎销毁和离屏 DOM 释放在 finally 中完成。
- 不支持的自定义 stencil 可能使用普通轮廓预览，给出提示，原始数据保留。引入联网 stencil 拉取不在本轮范围。
- 在线链接携带所选内容，界面提示该事实；超过链接上限时要求保存文件，不默默截断。创建链接不代表发布托管链接，内容由 URL 自身携带。

## 验收、任务和测试

| AC | 可观察结果 | TASK / V |
| --- | --- | --- |
| AC-01 | 两处导出入口产生 draw.io 可解析的原生 graph，节点、连线、子图及标签可编辑。 | TASK-01 codec/转换；V-01 codec/document unit；V-02 FILE019；V-04 FILE021。 |
| AC-02 | 全文/全部图片和 Sheet 选项改变输出结构；全文文字表格可编辑，图片嵌入。 | TASK-02 导出设置与组装；V-01、V-02；下载后独立解析/渲染。 |
| AC-03 | 复制和打开标准内容链接，中文、特殊字符、多页可恢复，无本地隐式联网。 | TASK-03 链接与剪贴板；V-01、V-04 系统剪贴板。 |
| AC-04 | 压缩/非压缩文件显示页预览，必须选择导入方式，未选页不进入 MD。 | TASK-04 导入 UI；V-01 dialogs unit；V-03 FILE020；V-04 真机打开对话框。 |
| AC-05 | 文字表格恢复、未知图形保留、原页备份、只读禁用、取消和迟到结果保护。 | TASK-04；V-01 import/document unit、V-03；受影响 Markdown/Notes unit 与 FILE013。 |
| AC-06 | 保存沿用上次成功目录；取消失败不覆盖源文件；原 PNG/SVG/Word/PDF 导出及查看器正常。 | TASK-05 保留原修复；目录/export 单测；FILE014/015/018、FILE019/021 和完整 crash-regression。 |

本次不修改应用快捷键和 AppKit 菜单，保留 Ctrl/Cmd 已有绑定。macOS 原生验证需使用实际 WKWebView、原生 NSOpenPanel/NSSavePanel、系统剪贴板；browser 不能替代这些证据。Linux 当前端执行 unit、browser、QA release native；Windows/macOS 在 `qa-ui-auto-platforms` workflow 执行 browser/native，运行中下载完成的 shard、检查失败再跑。

## 执行记录

- 改前选中单测 14 项：13 通过、1 个既有新查看器测试失败；该测试在对象 URL 尚未生成前关闭窗口，却要求已生成 URL 被释放。增加图片加载断言后保留资源释放检查，没有放宽断言。
- 新增 codec/document/dialog 单测已执行 15 项通过；后续标准 table 恢复新增测试和最终组合验证继续执行。
- TypeScript 编译、`pnpm check:refactor` 已通过一次；最终源码上的结果见后续验证记录。
- FILE020 第一轮实际 browser 通过；FILE019 文档与图片下载、可编辑节点/XML、旋转等通过，右键后的下载等待失败；保留该轮证据并继续复核，不能据此标整项完成。
- 此前任务的 Linux R14 50 项 native 实际通过；R14 Windows/macOS 有 HOME045/046 失败，后续批次继续验证。旧结果不冒充当前源码通过。
- 清理了不再使用的 QA debug 构建和 debug incremental，保留 release 缓存。较早的 GitHub 证据逐文件 SHA-256 核对后移至 HDD，旧路径保留符号链接，失败、截图和回执仍可查；本地迁移清单在 `qa-ui-auto-report/_local/markdown-drawio/evidence-migration.json`。

所有未完成的 native/hosted/性能比较仍为待验；原 Tao follow-up 未完成的总体任务继续以其审计文档为准。

### 2026-11-17 当前实现复核

- Markdown/Notes 27 个单测文件、130 项测试通过（Node 22）。完整构建中的 TypeScript、refactor contracts/boundaries/source-size 已通过；native release 编译中。
- 修复实际浏览器右键的 CodeMirror mouseup/caret 生命周期问题，FILE019/020 稳定源码首轮 2/2 通过。后续扩展 FILE020 异常输入、取消焦点、保存重开及 FILE022 四种图形均实际通过，但该轮末尾发生类型检查修正，`identity_stable=false`，只保留诊断价值；当前 46 项 browser 回归重新验证最终输入。
- 独立 draw.io Desktop 渲染导出的流程图、状态图、类图、ER 图；节点位置读取稳定 DB 标识，忽略 render 前缀和解析计数器变化，多行 tspan 不丢换行。ER 使用实际类型 `er`，保留 cardinality；class 保留空心继承箭头。图像证据：`qa-ui-auto-report/_local/markdown-drawio/drawio-visual/`。
- 完整 browser/native crash suite 并入保留的 R14 验证场景，选集见本地 `local-selection.json`；正式 native candidate 和 hosted Windows/macOS 验证未完成，不标通过。
