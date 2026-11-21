# Markdown 导出 Word 矢量标签定位与 PNG 分辨率修复

## 用户问题与根因

- 用户提供 `E:\temp\_t\testing-3.md`（Mermaid C4Context 图）。导出 Word 后图框内的文本整体居右；Markdown Live 预览与导出 PDF/PNG 均为居中。
- 用户同时要求提升导出 PNG 与 Word 时 md 内图片（mermaid/drawio）的分辨率。

根因分析（本机浏览器 harness 生成当前导出产物 + Word COM/WPS COM 渲染逐项验证）：

- Mermaid 11 的 C4 标签结构是嵌套行 tspan：外层 `row` tspan `x="0"` 携带 `text-anchor="middle"`，内层 word tspan 不带 x，行位置完全依赖 `text-anchor`/`dominant-baseline`/相对 tspan 坐标链。旧导出仅对含 CJK 的标签做逐字固定（`wordSvgText.ts`），英文标签继续依赖这些属性。
- Office 家族 SVG 导入器对这些属性并不可靠：本机 WPS（KWPS）渲染旧矢量时把 C4 标题、`[Person]`、描述行从方框中线开始向右绘制——A/B 对比 docx 中旧矢量标签中心相对方框中心右偏 +26px（约半行宽），即用户看到的"居右"；同一 docx 中修复后的矢量全部居中。Microsoft Word 16（COM 导 PDF 为矢量文本）与浏览器 600DPI fallback 对新旧矢量均居中，说明这是导入器差异问题而非导出几何错误。
- 整文档 PNG 导出原先 `pixelRatio: 1`，一个 CSS 像素对应一个画布像素，内嵌 mermaid/drawio 图缩放即模糊；PDF 已是 300 DPI、单图 PNG 300 DPI、Word 矢量 + 600DPI fallback，唯整图 PNG 落后。

## 变更边界

- `wordSvgText.ts`：把既有的 CJK 逐字固定机制扩展到所有非上下文标签——测量浏览器实际字形位置后，把每个 `<text>` 重写为携带绝对 `x/y`、`text-anchor="start"`、`xml:space="preserve"` 的字组 tspan，Latin 连续段保持为一个 run 以保留 kerning/连字。上下文塑形（阿拉伯/希伯来/天城文等）、双向文本、组合记号、textPath/rotate/transform、空白折叠不一致与度量不可用的文本保持原 SVG 语义；空白行（`<br/>` 空行残留）跳过。
- `markdownExport.ts`：新增 `PNG_EXPORT_DPI = 300` 与 `pngExportScale()`；整文档 PNG 以 800 CSS px 版式按 300/96 光栅化，受既有 40M 像素/32700 边长画布上限约束超长文档时优雅降级，1x 以下不输出。导出失败语义、取消、文件名与保存流程不变。
- 不修改预览渲染、Mermaid 源码语义、drawio 富文本标签、PDF/PNG 单图导出与 Word 600DPI fallback 路径。

## 验收与保留能力

| 行为 | 验证 |
| --- | --- |
| C4 导出矢量不再依赖 text-anchor；45 个 text 全部固定（0 个 middle 残留） | fixed-portable.svg 结构检查；单元/契约测试 |
| flowchart（CJK+Latin+`<br/>`）与 sequence 固定覆盖 100%，空行豁免 | quality 夹具 harness 产物 ET 遍历：content 违规 0 |
| 固定后浏览器栅格与旧输出像素级一致 | docx fallback 400dpi 级对比：ink bbox 完全相同，计数差 11/1.67M 像素 |
| Word 16 / WPS 渲染修复后矢量居中 | A/B comparison.docx COM 渲染测量：修复页全部 CENTERED |
| 整文档 PNG 300 DPI | 本机与 Linux runner 实际下载均为 2500×~10.8k @3.125；<2x 或超限被契约拒绝 |
| 独立检查器拒绝回归 | `inspect_vector_text` 契约 + 27 项 Python 契约单测 |
| 实际导出流与 OS chooser | TC-FILE-OPEN-014 browser、015 native 扩展步骤 |

## 执行证据

- 单测：Vitest 全量 343 文件 / 3028 项通过；`pnpm build`、`pnpm check:refactor`、`qa_ui_auto.audit --gate`（covered_required 1842→1845）、dev 契约通过。QA Python 契约 27 项通过（含新增 WordVectorTextLayoutTest 5 项与 png-doc 3 项）；`qa-ui-auto-entry.yml` 的 Linux 契约作业已加入 `test_markdown_testing_quality`、`test_export_quality_native`。
- 本机 Windows browser：受影响 004/013/014/025/027/035/037 全通过（014/027 首次因本机缺 pypdf 失败，装依赖后重跑通过——环境问题，与产品无关）；完整 crash-regression browser 通过，TC-FILE-OPEN-008 因本机无 ssh_posix 凭据跳过（本地环境限制，与本次无关，hosted 已覆盖通过）。
- 本机 Windows native：QA release 二进制含本修复重建（native_build --release，identity 绑定当前源码）。受影响 007/015/018/023/026/028/036 **7/7 通过**：015 实际 OS 保存 quality.png 为 2500×10787 @3.125（300 DPI），quality.docx vectorCount 3、positionedRuns 81、600DPI fallback、原始栅格 1600×800 保留。crash-regression native 22 项：19 通过；TC-FILE-OPEN-006 失败为已记录的既有产品竞态（[2026-11-20-native-readonly-copy-load-race](2026-11-20-native-readonly-copy-load-race.md)，修复前三个完整批次已连续失败，与导出无关，单独复跑同失败）；TC-MOBILE-013 因本机缺 Playwright Chromium 可执行文件失败（环境限制，hosted 覆盖）；TC-FILE-OPEN-008 ssh_posix 跳过。
- 真实 app 导出的 quality.docx（native 015 产物）经本机 Word 16 与 WPS COM 渲染逐行测量：flowchart 节点框、边标签、sequence 参与者标签全部居中，无居右；"LEFT/RIGHT"行仅为容器框内嵌套节点的测量基准误差。
- hosted：run [44862955249](https://github.com/engcapa/taomni/actions/runs/44862955249)（linux/macos selected+crash-regression 合并集，head d2ab59d14）。**browser 4/4 分片全绿**：linux 22+1、macos 22+1 全部通过，014 实际下载 quality.png 2500×10790 @3.125、docx positionedRuns 81。**native 8/8 分片**：linux 4 分片 28 项 27 通过、macos 4 分片 28 项 27 通过，每分片完成即下载复核（ci-summary 逐分片计数一致）；build-linux（含 51 项 Python 契约与全量 vitest）、native-contracts、build-macos 全部成功。全 run 唯一失败为 TC-FILE-OPEN-006（linux shard-4 与 macos shard-4，同一 step 68 readonly 内容等待），与上述 2026-11-20 文档记录的既有产品竞态一致——修复前三个完整批次已连续失败，与本导出修复无关；run 的总失败结论仅由此既有竞态触发（selected scope 要求全通过）。
- LibreOffice：本机 msiexec 静默安装与 Docker daemon 均不可用，未取得本机 LibreOffice 渲染证据；修复按"不依赖 text-anchor/相对坐标链"的结构契约消除该类导入器差异，Linux CI 契约检查持续执行。
