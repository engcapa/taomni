# IDEA 参照复用与对照摘要 — AUDIT-20260913-01

## 实际目标与就绪程度

沿用有效局部参照 [REF-TREE-2026-09-13](project-tree-navigation-2026.2.2.md)：IntelliJ IDEA Ultimate 2026.2.2，build `IU-262.10315.125`，Windows，New UI / 深色 / 英文，窗口 1400×992，OS 报告 DPI 96。已读取本机 `D:/Software/idea-2026.2.2.win/product-info.json` 核对 productCode=IU、version 与 build；hash 见 [provenance](../evidence/provenance-20260913.json)。这是本轮沿用的目标，不将其设置为全部未来任务永久默认。

原参照采于 2026-09-13 **08:31–08:36**；本轮在 22 点以后复用，不刷新其采样时间。逐状态 PNG/JSON 原件本机存在，已记录 24 个有效工件的 SHA-256。用于导航的相同 F0 四文件 fixture；IDEA 的 `.idea`、External Libraries、Scratches 属于 IDE 元节点，不能混入跨产品初始文件 hash。

## 新采样的阻塞记录

本轮先打印 Taomni，再启动独立 `qa-ui-auto-report/overall-audit-20260913/fixture` 窗口，PID 40612 / HWND 18748476，安装路径明确。桌面探针返回 inputDesktop=Default；未锁屏，未尝试解锁。窗口识别为 `fixture – README.md`，1400×992。

`SetForegroundWindow` 首次抛错，后续区分探针返回 0，foreground 仍属 Explorer PID 12256。为保证输入归属，本轮没有对 IDEA 发送键盘或鼠标操作。[blocker.json](../../../qa-ui-auto-report/overall-audit-20260913/idea/blocker.json) 与 [diagnostic-unfocused.png](../../../qa-ui-auto-report/overall-audit-20260913/idea/diagnostic-unfocused.png) 保留当时事实。诊断图有新项目 Markdown 预览、Defender 通知，且没有匹配焦点/设置；**不作为可比较状态或新交互参考**。没有更改 Defender、IDE 设置、安装版本或项目 SDK。窗口最后正常退出。

**本轮新增 IDEA 交互基线缺失。** 不是 IDEA 未安装；具体阻塞是无法验证并取得目标前台焦点。需要可控制的交互桌面/测试机或用户明确可用时段，重新核对窗口与焦点后补采。已有授权无需再次询问“是否可重构 UI”；未知字体、UI scale、完整 keymap、项目 SDK/插件版本应在采样时获取。

## 同 fixture 的局部双侧判断

| 场景 / 子动作 | IDEA 有效原件（相对仓库根） | 本轮 Taomni 原件 | 功能 / 视觉 / 交互判断 |
|---|---|---|---|
| CW-PROJ-002：docs 标签单击 | [08-src-click.png](../../../qa-ui-auto-report/project-tree-e2e/idea/08-src-click.png) / [metadata](../../../qa-ui-auto-report/project-tree-e2e/idea/08-src-click.json)（旧包说明明确实际为 docs；hash 纳入 provenance，采样日期不变） | B03 前置动作日志：click docs，随后 Right 已选到 notes | 双侧动作前置状态可对照：IDEA 单击只选中、Taomni 单击展开；本轮用源码 onClick 的 onSelect+onToggleDir 支持差异，仍需同环境重采鼠标子动作后冻结 UI 设计 |
| CW-PROJ-002：Right/Left/Down 选择与展开 | `.../09-right-expand`、`10-right-child`、`11-left-parent`、`12-left-collapse`、`13-down-select-src`、`29-up-main`、`30-right-expand-main`、`31-down-example`（每项 PNG/JSON） | B03/B04 + DOM observation | 已采子动作的选择/展开与不打开结果相近；未覆盖 Home/End、批量/拖拽。整个场景功能只能部分对齐；视觉不可比较；交互因 Enter 等差距部分对齐 |
| CW-PROJ-002：example Enter | `qa-ui-auto-report/project-tree-e2e/idea/32-enter-example.png` / `.json` | [05-example-enter.png](../../../qa-ui-auto-report/overall-audit-20260913/browser/05-example-enter.png) + [223259815775-observation.json](../../../qa-ui-auto-report/overall-audit-20260913/browser/223259815775-observation.json) | 相同正文与两个 tabs；IDEA 原图 caret 在编辑器、树失焦，原 JSON action=enter；Taomni activeElement 为 treeitem。确认局部交互差异，native 待复验 |
| CW-PROJ-003 / CW-SHELL-002：右键 / Escape | `qa-ui-auto-report/project-tree-e2e/idea/33-context-example.png` / `.json`、`34-context-dismiss.png` / `.json` | B06 及后续 Escape 日志 | 两侧菜单均可覆盖编辑区，取消后内容保留；Taomni 菜单取消焦点未独立记录，IDEA 完整菜单设置未核实，因此这些完整场景仍待验证，不签发匹配 |
| 其余 44 个场景的完整契约 | 没有足够同 fixture、同状态参照；部分有历史规范/receipt，仅作线索 | 已采部分入口或完全缺失，逐项见矩阵 | 对应维度待验证；没有从代码、普通功能测试、截图总数或旧 done 推导已对齐 |

![IDEA 历史有效 Enter 状态](../../../qa-ui-auto-report/project-tree-e2e/idea/32-enter-example.png)

![Taomni 当前 Enter 状态](../../../qa-ui-auto-report/overall-audit-20260913/browser/05-example-enter.png)

两图明确打印了不同的实际环境。IDEA 深色/树行约 36 原始像素，Taomni 浅色/27 CSS px；IDEA 字体与 UI scale 未核实，不能计算尺寸差百分比或像素相似率。窗口总体同为 1400×992 不等于相同客户区和产品内容区。没有正式运行 `compare_idea.py`，本文不是 schema record，也不是 matched receipt。

## 进入可比较状态的最小动作

1. 在可控桌面仅打开 F0 fixture，核对 About/product-info、客户区、DPR、New UI、主题、UI/代码字体、字号、keymap 及 Project 的预览/单击设置。
2. Taomni 用同源 QA 或明确标注 browser 的同字节 F0；IDEA 先 README 源码态，关闭与场景无关通知，匹配选中 docs 折叠、仅 README tab。
3. 双侧顺序采样：docs 标签单击；重置后 Right 展开、Right 子项、Left 父项、Left 收起；进入 src/main 选择 example；Enter；直接输入前核对 editor focus；右键菜单、Escape 并核对返回焦点。
4. 为首包 CW-SEARCH-001 补 example 正文获焦 → Ctrl+F → 输入 tree → Enter/Shift+Enter → Escape，记录查询文本、两个匹配、caret/selection、滚动、正文 hash、控制台及恢复；同一序列重置后再做一次。额外验证右/下分屏与 Ctrl/Cmd+hover 的 retained behavior。
5. 带 provider 的后续场景按 fixture catalog 逐项记录 JDK 与 LSP/DAP/插件身份；尚未采样的语言和三端维度保持未验证。没有 IDE 目标动作或插件的场景写明 edition/provider 边界，不把目标静默排除。

以上是**未执行计划**。本轮没有关闭产品差距，没有新的用户接受差异，也不扩大旧 tree 卡有限豁免。
