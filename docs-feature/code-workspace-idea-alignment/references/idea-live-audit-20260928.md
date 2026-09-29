# IDEA 实机对比参照：2026-09-28

## 身份与环境

- 产品：IntelliJ IDEA Ultimate 2026.2.2，build IU-262.10315.125。
- 平台：Linux X11；IDEA 主窗口客户区约 1400×1000；深色主题；DPI 96。
- 项目：隔离工程 `/tmp/taomni-design-audit-20260928`，Java 文件 `src/StructuralTarget.java`，字节 SHA-256 `8fea975fe2c16a584a0538981201f8c567b9c511b9a7ef4950b65500c0b6ec23`。
- 原始工件：`qa-ui-auto-report/idea-reference/current-design-audit-20260928/`。该目录被忽略，不作为产品源码提交。

## 壳层

IDEA 欢迎页显示项目列表、项目搜索、New Project/Open/Clone；进入工程后，左侧为 Project 工具窗和竖 rail，中央是 editor，右侧保留工具 rail，底部是 Problems、Analysis、Search、Structural Search、References、Call Hierarchy、Type Hierarchy、TODOs、Terminal、Run、Build、Tests 等工具窗口。顶栏集中项目、Version Control、Current File、运行和设置入口。

Taomni 同一隔离工程显示应用级顶栏、workspace toolbar、Project tree、editor、底部工具标签和状态栏，同时显示 SDK/Facts、语言服务降级、editor zoom、split、Git、inlay 等更多状态。功能入口较多，但空间层级、密度、标签、图标和信息组织不同。

## 编辑器与查找

IDEA 的编辑器 tab 位于编辑区顶部，代码区带行号、折叠标记、右侧问题/变更标记；`Ctrl+F` 打开嵌入编辑器顶部的 Find 栏，输入框立即获得焦点，显示匹配计数、上一项/下一项、大小写、整词、正则、更多选项和关闭。Esc 关闭 Find，编辑器保留当前匹配选区。

Taomni 也提供 Find、Replace、匹配计数和导航按钮；本次 browser 对照显示相同入口，但 editor 顶部通知、工具按钮、底部工具窗、字体/行高、状态层级和查找栏几何不同。Esc/连续查找/多 view/IME/迟到结果仍需任务 012 的正式双侧验证。

## 导航与快捷键

本次 IDEA 实测：

| 动作 | IDEA 观察 |
|---|---|
| `Ctrl+Shift+N` | Go to File，中央搜索弹层，按文件结果过滤。 |
| `Shift+Shift` | Search Everywhere，按 All/Classes/Files/Symbols/Actions/Text 分类。 |
| `Ctrl+F` | 编辑器内 Find。 |
| `Enter` / `Esc` | 结果打开/确认、关闭弹层或查找，并将焦点交回对应 owner。 |
| `Ctrl+Z` | 编辑器撤销；隔离文件被恢复到原始字节。 |

Taomni `workspaceActionRegistry.ts` 已登记 Go to File `Ctrl+Shift+N`、Search Everywhere `Shift+Shift`、Go to Symbol、Find、Rename、Extract Method 等绑定；实际派发、冲突、输入框保护、IME 和三端 Mod 映射尚未由本次采样完整证明。

## Structural Search

IDEA 的 `Search Structurally…` 使用独立工具窗口/对话框，模板区显示 `System.out.println($arg$);`，语言为 Java，提供 Count、Reference、Text、Type、Script 等 modifier，并支持 In Project、Module、Directory、Scope。结果按 class → method → location 展开，可导航并在 editor 中高亮；Text=42 得到 1 个结果，Text=999 为空。

Taomni 009 首包使用 Java AST backend，3/1/0 结果集合和注释/字符串排除逻辑已有证据，但结果树、对话框布局、scope/modifier、空态、预览和工具窗口呈现与 IDEA 不同，旧 comparison 明确为 `unverified`。

<a id="verification-boundary"></a>
## 证据边界

- 这次参照只证明 IDEA 的实际观察状态，不证明 Taomni 已匹配。
- 未覆盖 Windows/macOS、完整 DPI/主题组合、重启恢复、staged/commit/冲突、真实 JDT LS ready、Structural Search Replace、全部 modifier 和插件生态。
- 任何新卡使用该参照时，必须把复用范围和未观测项写进自己的 evidence。
