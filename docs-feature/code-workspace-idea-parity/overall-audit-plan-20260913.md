# Code Workspace 总需求与首次整体评估计划

本文件与 [能力矩阵](capability-matrix.md) 是同一套目标/差距来源，入口 [index](index.md)。本轮 `AUDIT-20260913-01` 只评估和编写需求；不开发、不领取任务、不改任务状态、不提交推送。需求优先级不代表 ready/done，开发状态必须回到关联任务板查询。

## 目标、分母与边界

目标是 Taomni Code Workspace 在所选 IntelliJ IDEA 用户场景中的功能、视觉、交互高度一致。当前布局、组件、菜单和动作组织允许后续重构；必须保留正确能力、保存/撤销/取消/恢复、数据兼容及 Windows/macOS/Linux 支持。

首次目录为 **45 个场景、11 个能力域、135 个独立比较维度**。范围不沿用旧 editor-only 文档对 Git、Build/Run/Debug/Test/Coverage、终端的排除。完整无限插件生态默认排除，所选语言所需 SDK/provider/IDEA 内建插件逐项记边界，不能把一个 Java fixture 当全部语言。

| 能力域 | 稳定场景ID | 数量 | 本轮实际取证上限 |
|---|---|---:|---|
| 项目树 / 项目入口 | CW-PROJ-001..004 | 4 | F0打开、选择/展开/Enter、菜单与rename取消；其余待采 |
| 标签页 / 分屏 | CW-TAB-001..004 | 4 | 两tabs、左右分屏、policy取消、刷新后Welcome；共享编辑/恢复未证明 |
| 编辑 / 保存 / 恢复 | CW-EDIT-001..005 | 5 | 本轮未执行文本修改、native保存/undo/IME；源码及历史线索 |
| 导航 | CW-NAV-001..004 | 4 | 双Shift/动作搜索进入Keymap；真实语义及历史导航待采 |
| 搜索替换 | CW-SEARCH-001..003 | 3 | 本地Find与异常复现；项目空面板；替换/SSR待采 |
| 补全 / 诊断 / 工程语言 | CW-LANG-001..005 | 5 | browser Facts/No LSP/Problems空态；真实provider待采 |
| 重构 / 格式化 | CW-REFACTOR-001..005 | 5 | 生产caller和provider边界；无本轮语义操作 |
| Git | CW-GIT-001..004 | 4 | 生产manager/IPC；无真实Git fixture或交互 |
| 运行 / 调试 / 测试 / 终端 | CW-RUN-001..005 | 5 | Run/Debug空态；没有执行进程、adapter或coverage |
| 设置 / 快捷键 | CW-SET-001..003 | 3 | 当前外观测量、Keymap只读打开关闭；配置应用/冲突待采 |
| 跨域布局 / 菜单 / 焦点 / 多窗口 | CW-SHELL-001..003 | 3 | shell布局与部分弹层；多workspace/跨窗口/三端待采 |

这是需求目录的明确分母，不声称穷举 IDEA 每条 action。未展开的 scratch/injected-language、Code Vision、插件专属分析器等保留在下文待决扩展项；不得在之后报告完整IDEA覆盖时忽略它们。只有扩展目标和场景拆分确定后，才能增加新的稳定ID并记录映射。当前不输出总体对齐百分比。

## 本轮事实与增量

- HEAD `27f99b6116f4f6aae906d324cb84e8359695e17a`，分支 `main`，开始干净。只新增评估文档，保留现有用户/agent材料。
- Taomni 当前基线：[逐状态摘要](references/taomni-baseline-20260913.md)，21张浏览器原图、动作日志/DOM/焦点/选区/控制台；16/45个场景有局部实际观测。源码和case不是其余29个场景的UI基线。
- IDEA：[复用与阻塞摘要](references/idea-comparison-audit-20260913.md)。实际安装与旧参照均为 Ultimate 2026.2.2 / IU-262.10315.125；复用08:31–08:36的有效项目树参照。新fixture采样因无法取得目标foreground未发送输入，仅保留诊断图。目标字体/scale/keymap等未补齐。
- 新需求 REQ-01..11；初建45个场景；本轮拆分/合并/移出0；差距关闭0；用户接受的新增差异0。每行首次三维判定保存在矩阵，后续在同一行增量更新。
- 新确认 browser 运行异常：Ctrl+F打开查找导致 `WorkspaceSearchPanel.mount → lspHyperlink.onBlur → clearMod → view.dispatch` 重入，B08/B18两次。Find仍能显示/匹配；native影响未证。新增 REQ-01，未写产品。
- 局部双侧交互差异：F0项目树Enter打开正确文件但Taomni树仍有焦点，IDEA进入编辑器；目录标签单击行为也不同，需结合目标设置冻结。进入 REQ-02，不把旧 ED-TREE-001 done 或其有限契约当全树匹配。
- 新证据失效：历史Windows tree native receipt的只读status为stale，理由source/runner/native build source变化。其他历史报告未逐一执行status，不一概写stale；旧IDEA有效原图不受Taomni源码变化自动失效。
- 文档线索纠正：当前 FindInFilesPanel 已接scope/ReplacePreview/onReplaceMatches；completionScopeAdapter/projectFactsConsumers已有生产caller；canonical code action applyPlan已有调用；layoutTreeV2支持递归分屏。旧spec中“test-only/未接线/双组”的描述保留原日期，不再作为当前缺陷。**这些是线索纠正，不是关闭IDEA差距。**

完整证据身份见 [provenance](evidence/provenance-20260913.json) / [源码调用链](source-audit.md)。本轮只运行一次native build可复用性检查（binary missing）和一次tree只读status，没有产品单测、QA runner、Tauri/Cargo构建或正式comparison。`pnpm dev`启动自动补齐依赖不是产品打包。浏览器异常的第二次操作仅为最小复现；未运行检查均保留为计划。

文档校验：45个ID唯一、每场景14项记录齐全、135个维度计数一致；本轮新增文档的本地链接与锚点可解析。81条生产源码记录（70个不同文件）及29个本轮/24个历史参照工件的路径与SHA-256已核对，无缺件或内容不符。这是材料完整性检查，不是产品测试或IDEA匹配通过。

## 按用户价值、共享依赖与风险排序的需求

下表中的“补证先行”不是产品bug；新引擎或UI设计在真实参照就绪后再确定实施细节。RQ排序不新增第二套owner/ready/done流程。

| 顺序 | 需求 | 用户价值 / 影响 / 风险 | 建议处理与依赖 |
|---:|---|---|---|
| 1 | REQ-01，P0 | 高频Find有可重复运行异常；focus/modifier链跨查找与语义hover | 首个小包设计与定位；保护取消、caret与hover；不先做整体皮肤改版 |
| 2 | REQ-11 + REQ-04保留合同，P0 | 保存、dirty、undo、共享文档与恢复有数据风险，是任何重构前提 | 补证先行：选择改动真正影响的native序列；不因stale重报历史bug |
| 3 | REQ-02，P1 | 树到编辑器是日常高频操作，已有局部双侧差异 | 在F0匹配mouse/keymap设置后细化单击/Enter/focus/preview |
| 4 | REQ-03，P1 | toolbar/tool-window/menu密度和焦点影响全部能力 | 固定目标主题/scale/font、可比较客户区；允许重组shell，不先猜token |
| 5 | REQ-10，P1 | 动作/快捷键/样式作用域是多场景基础 | 复用ActionHost和scheme兼容；与布局设计一起校准入口与冲突 |
| 6 | REQ-05，P1 | 工程就绪、补全、导航和文档是主开发流 | 固定Java F2真实provider；逐步扩语言，不用协议接入替代语义完整性 |
| 7 | REQ-08，P1 | 项目范围/批量替换误操作影响多文件 | 使用已经接线的preview，补scope/排除/取消/冲突/undo实测，再定UI差距 |
| 8 | REQ-06，P1 | 重构跨文件，误修改风险高 | 依赖工程facts和usage完整性；按rename、extract、safe-delete、cleanup分别限定引擎支持 |
| 9 | REQ-07，P1核心/P2高级 | 全Workspace的Git与运行闭环，当前缺实测证据 | 先本地Git diff流和Java Build/Run/Debug流；后续冲突/coverage/多会话 |
| 10 | REQ-09，P2 | Smart/Full Line/SSR有明确静态引擎缺口，成本/edition依赖高 | 先目标语言/edition/model参照与独立设计，不用表面替代品伪称完成 |

<a id="req-01"></a>
### REQ-01：查找弹层焦点生命周期

目标：文件内查找打开、匹配导航和取消回到原编辑上下文，无CodeMirror重入异常。当前差距和影响：B08/B18重复报错，源自同步focus触发modifier清理；当前页面仍显示Find，尚未证明正文丢失或native退化。源码/证据：CW-SEARCH-001、CW-SHELL-002；[控制台与步骤](references/taomni-baseline-20260913.md#本轮确认的运行异常与边界)。

方向：先定义focus移交/清理时机和view生命周期，再修复实际触发链；不能通过吞掉异常、禁用Ctrl/Cmd-hover、取消搜索自动focus或改测试证据来通过。

可观察验收：`REQ-01-F` 同F0查找tree返回2个匹配、正文hash不变；`REQ-01-I` 进入Find可输入，Esc回正确view/caret/selection，连续两次和分屏切换无重复dispatch异常；`REQ-01-V` 查找面板锚点/行密度/选中状态有匹配IDEA参照；`REQ-01-R` 保留modifier-hover导航/清理、IME、read-only和其他弹层owner行为。UI具体尺寸待参照，不先承诺像素值。

P1 局部接续（2026-09-14）：[修复设计](../../docs-issue/code-workspace-find-focus-design.md)将以上稳定验收映射到 ED-FINDFOCUS-001-A1..A7 / V-FF-01..06；[准确任务板](../../claudedocs/code-workspace-idea-parity-backlog-find-focus.md)是状态唯一来源。[新 Find 参照](references/find-focus-2026.2.2.md)补到实测查询导航与 Esc 保留当前匹配选区，未关闭整体场景差距。以下其余 REQ 不变。

<a id="req-02"></a>
### REQ-02：项目树打开与菜单交互

目标：树选择/展开不改编辑内容，Enter/鼠标打开按目标IDEA设置进入正确view，菜单取消能恢复选择/焦点。当前：方向选择与打开结果已有局部基础，Enter仍树焦点；单击目录的展开策略不同；菜单返回焦点缺当步记录。影响所有日常文件导航。

方向：允许重做tree row事件组织和open policy，但保留按键选择不打开、dirty、正式tab、Ctrl+Enter分屏、文件事务和已展开后代刷新。验收 `REQ-02-F/I/V/R`：F0逐步状态表与两侧关键原图，Enter后直接输入只进入目标editor；Esc不改正文/文件；同源native补验，不以旧done或浏览器颜色相近关闭。

<a id="req-03"></a>
### REQ-03：整体布局与视觉规范

目标：Project、editor tabs、tool windows、toolbar、主菜单/状态栏的空间层次、密度、字体、图标、锚点与目标高度一致。当前浅色双侧栏/底部References默认展开；IDEA深色New UI参照字体与scale不完整，**这是比较条件缺口，尚不是一组量化视觉bug**。

方向：先建立匹配环境，再按CW-SHELL-001、CW-SET-001、CW-PROJ-001/004做分段布局设计。验收 `REQ-03-V` 正常/选中/失焦/禁用/窄窗口/溢出原图与几何值；`REQ-03-I` resize/collapse/menu键盘进出与恢复；`REQ-03-R` 工作区、Git、Run与保存/恢复入口均仍可达。没有用户接受的有限差异，不以现状锁死重构。

<a id="req-04"></a>

**2026-09-14 REQ-03 P1 增量：** [首包设计](shell-layout-design.md)与[新任务板 ED-SHELLLAYOUT-001](../../claudedocs/code-workspace-idea-parity-backlog-shell-layout.md)已author；状态/领取资格只读板。关键参照未齐，不能ready；中间ready结论已纠正，无owner/claim。CW-SHELL-001主场景、CW-SET-001比较条件，REQ-03-V/I/R映射A1..A7、R1..R7、V-SL-01..07。实际新增IDEA正常/Problems开关/Project resize/窄窗局部；第一轮所缺bottom resize、Run、Project重开和Restore Layout已在21:12–21:22第二轮补齐；剩余current editor font/lineHeight/density/effective scale与min/max/overflow定值仍缺，见[参考边界](references/shell-layout-2026.2.2-linux.md)。当前端Taomni验证由P2计划，P1未执行产品测试/runner/build；未关闭原三维差距。

### REQ-04：标签、分屏与恢复

目标：preview/pin/dirty/limit/MRU、递归分屏、drag、关闭/重开和恢复构成连续一致流程。当前已有layoutTreeV2、TabPolicyPlan和共享transaction owner；本轮只观察双pane和policy Cancel，恢复只看到browser刷新回Welcome，未验证显式Restore。

方向：已有正确数据模型优先复用，先采F1/F5实际策略与恢复，再定体验改版。验收 `REQ-04-F/R` 两view一次undo、关闭非最后view不释放文档、dirty取消零变化、limit按冻结预览提交、重启恢复正确view-state；`REQ-04-I/V` 同IDEA tab/MRU/拖动/选中状态。依赖同源QA和目标tab配置。不是根据旧stale报告要求重写全部模型。

<a id="req-05"></a>
### REQ-05：工程与语义主工作流

目标：SDK/import/index→completion→documentation→declaration/implementation/usages/hierarchy是可解释、可取消并可返回的主开发流。当前生产链已具备scope facts、query/session guards，真实语义结果本轮缺失；不能根据“有LSP”断言IDEA功能一致。

方向：Java F2作为首个代表，之后按F4逐语言；设置ready/failed/stale/unsupported可见状态。验收 `REQ-05-F` 精确候选/引用/层级集合及来源；`REQ-05-I` 选择/accept/Enter/Tab/Esc/Back与late result隔离；`REQ-05-V` candidate/doc/problem popup匹配状态；`REQ-05-R` imports+snippet一次undo、跨workspace不串结果。依赖SDK/JDT LS/IDEA插件身份，不复用未知provider receipt。

<a id="req-06"></a>
### REQ-06：语义重构、Inspection与格式化

目标：每种重构/inspection/format都有实际支持的语义、冲突/预览/取消与可恢复结果。当前按provider kinds调用，InspectionProfile属于provider呈现层；Safe Delete完整性与Cleanup file/default边界不能当完整IDEA引擎。旧卡具体修复仍保留，不一概重开。

方向：把能力缺失、provider不支持、体验差异、纯证据缺口分开逐场景判定；必要新引擎单独设计。验收 `REQ-06-F` F2预期程序/引用/格式输出；`REQ-06-I/V` 冲突和preview操作/呈现匹配；`REQ-06-R` 文件资源路径与文本一起undo，partial failure有真实recovery，不拿“拒绝危险操作正确”当受支持重构完成。依赖REQ-05和REQ-11。

<a id="req-07"></a>
### REQ-07：Git与运行调试闭环

目标：在工作区完成Git diff/提交选择/分支冲突，以及Build/Run/Debug/Test/Coverage/终端连续流程，和编辑器上下文、gutter、错误导航同步。当前源码有manager/IPC/DAP/execution路径；本轮只采Run/Debug空态，无实际后端证据。旧文档的X伴随轨道不是本轮排除理由。

方向：先F3本地双repo diff流与F2 Java run/debug，不使用真实用户repo或远端；之后扩conflict/abort与coverage。验收 `REQ-07-F` index/HEAD/输出/exit/verified breakpoint/frame/result/report准确；`REQ-07-I/V` 工具窗、配置弹窗、Stop/Cancel/返回编辑器匹配；`REQ-07-R` 不误操作其他repo/session，abort/stop恢复和dirty保存可靠。语言/adapter/edition分别列边界。

<a id="req-08"></a>
### REQ-08：全项目搜索替换

目标：scope/mask/取消→结果→排除→预览→提交/undo/恢复的完整行为和UI。当前scope/preview/frozen preimages已接线，旧spec的未接线文字过时；B12只有空面板。

方向：复用生产plan链，按F1/F2/F5补充结果集合和冲突状态再确定UI改版。验收 `REQ-08-F` scope准确、排除结果准确、冻结preimage；`REQ-08-I/V` preview/cancel/late-query/错误提示和焦点；`REQ-08-R` cancel零commit、部分写入可追踪、一次undo恢复实际资源。依赖module facts及字节恢复契约。

<a id="req-09"></a>
### REQ-09：尚缺生产引擎的能力

目标：Smart/Type-Matching、Full Line和Structural Search/Replace按目标IDEA语言/edition生效。当前静态证实Smart action `when=false/run=false`，SSR语言集合为空，Full Line无Code Workspace生产runtime；这是能力缺口，三维未采不签发已对齐/未实现比较结论。

方向：从真实同fixture目标结果设计引擎/provider和用户工作流；Basic候选、regex替换、Terminal FIM不能充数。验收 `REQ-09-F` 预期类型过滤/部分接受/结构变量约束得到准确输出；`REQ-09-I/V` 模型不可用/加载/取消/候选接受状态；`REQ-09-R` 保留Basic、事务undo、隐私设置和资源降级。语言、模型、edition和许可适用性待核对，不默认扩大到插件生态。

<a id="req-10"></a>
### REQ-10：Keymap与样式设置作用域

目标：动作可发现、scheme复制/冲突/重置/取消与平台键位一致；style/EditorConfig/auto-import来源明确且作用域正确。当前Keymap显示IDEA defaults只是scheme名称；本轮没有执行改键、冲突或style Apply。

方向：可统一设置入口，但复用WorkspaceActionHost和现有scheme/profile迁移。验收 `REQ-10-F` 绑定和style值实际生效、优先级有来源；`REQ-10-I/V` 设置搜索、改键/冲突、Cancel/Reset、重开与目标对照；`REQ-10-R` Ctrl/Cmd/AltGr/IME、同名动作多workspace owner及保存编码不退化。

<a id="req-11"></a>
### REQ-11：正确编辑与数据保护的当前证据

目标：日常输入、剪贴板、保存、编码/EOL、外部冲突、Local History和恢复必须在重构中继续正确。当前有大量生产事务/guard/byte-writer及历史修复，但本轮没有这些native实际操作；证据缺口不能登记成保存bug。

方向：后续按改动实际消费者选择F1/F5最小native序列，先建立保留基线；仅有真实反例才新增缺陷。验收 `REQ-11-F/R` 实际字节hash、一次undo、dirty-race保护、unknown effect阻断盲重试与可恢复before-image；`REQ-11-I/V` 冲突/失败/取消/恢复UI可理解可退出；三端分别标记，当前端完成不冒充三端实测。

## 首个建议工作包与进入条件

建议 **P1 规划到可开发**，拟议工作包 `WP-FIND-FOCUS-01`（仅方案标识，**尚未创建任务卡**）：在F0完成“正文获焦 → Ctrl+F → 匹配导航 → Esc → 回到同一编辑上下文”，处理本轮确认异常。范围 CW-SEARCH-001、CW-SHELL-002；CW-NAV-002 的modifier-hover和CW-TAB-002多view为受影响保留消费者。

- 当前基础：CodeMirrorHost创建hyperlink extension；WorkspaceSearchPanel.mount同步focus；onBlur/clearMod同步dispatch。已有两次browser反例，原件不可覆盖。旧ED-FIND-001/002是查找规则合同，不含本次重入闭环，没有可直接领取的准确新任务ID。
- 对齐输入：复用F0字节；补IDEA Ctrl+F/Enter/Shift+Enter/Esc的匹配设置与focus/caret。已有tree参照只能支撑前置导航，不能代替search。
- UI/交互方向：保留输入自动focus与modifier清理的正确目标，调整生命周期和取消恢复。无需全局换编辑器内核或重建完整layout。
- 受影响文件候选：`editorSearchPanel.ts`、`lspHyperlink.ts`、`CodeMirrorHost.tsx`；只有caller分析证明必要才涉及 `CodeWorkspaceTab.tsx`、公共popup/ActionHost。P1完成修复设计后确定，不提前要求修改全部文件。
- 进入设计条件：当前HEAD/diff核对；现有反例原件可取得；补IDEA查询序列或明确保留未观测AC；共享消费者和现有修复规格已查重。桌面受阻时可以完成设计的确定部分，但不能把目标视觉/交互AC写为已证或给缺依赖卡伪造ready。
- 进入开发条件：有准确board path+ID、修复设计、`REQ-01-F/I/V/R`的具体AC、参照和最小验证选择；若必须native而缺binary，在开发授权轮集中构建一次。这里不新建任务状态，也不默认授权构建。
- 最小验证计划（**未执行**）：一个能重现同步focus/blur重入的mounted回归；同源browser F0 normal/cancel/repeat与modifier-hover；稳定后当前Windows WebView2对该序列做一次集中验证。若实际改动涉及IME/clipboard边界再增加对应native探针。Linux/macOS记录计划和未验证，不运行全套QA。

完整可复制交接：[handoff-p1-find-focus.md](handoff-p1-find-focus.md)。不自动启动P1、开发或独立复核角色。

## 仍待决的目标与补证条件

| 缺口 | 当前处理 | 最小补证 / 决定 |
|---|---|---|
| IDEA UI scale、UI/代码字体、完整keymap、预览/鼠标设置 | 沿用build与行为事实；像素比较不可比较 | 可控桌面读Settings/About，保存设置原件，再同fixture采关键状态 |
| IDEA前台输入不可控 | 本轮新交互缺失，诊断图不合格参照 | 在可取得目标focus的交互桌面补首包5个状态；不自动解锁、不输入其他窗口 |
| 当前Taomni native binary缺失 | Windows native缺当前基线 | 后续开发/验证授权后构建或取得身份匹配的QA binary，再采所需动作；不借用生产用户数据 |
| Java项目SDK/JDT LS/DAP版本未就绪 | 所有真实语义/进程维度待验证 | F2记录项目JDK、provider、extensions、import/index readiness |
| 非Java语言、IDEA edition/插件边界 | F4逐语言待定；没有静默排除 | 核对目标内建插件与实际provider，再新增必要变体/场景ID |
| scratches / injected language / Code Vision等未展开目标 | 记录为目录扩展候选；不以45场景宣称穷尽IDEA | 从目标用户动作确认范围，正式纳入时分配新ID、增加分母并链接旧候选来源 |
| 全平台/主题/窗口组合 | 本轮无三端匹配结果 | 当前代表环境先闭环；只扩受影响变体，无变化场景保留旧日期 |

用户未答复不代表接受差异。只有某维度满足目标，或明确接受的有限差异已经验证，才在同一矩阵关闭该维度；保留旧结论、来源与时间。

2026-09-14 21:22 REQ-03补记：DEC-SHELL-02已由用户采用图稿v2；A1/A3仍受BL-SL-01剩余定值阻塞，A2/A4已有真实工具窗/restore输入，但Taomni保留断言仍由P2先建基线。REQ-04/11无新bug结论、REQ-10单owner不变；旧审计结论保持其日期。
