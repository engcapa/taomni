# Taomni Code Workspace IDEA 高度一致性改造：当前 Agent 职责与提示词

本文件提供可直接发送给当前 agent 的任务提示词。目标是基于当前正确能力，推进 Taomni Code Workspace 与指定版本 IntelliJ IDEA code editor 在功能、UI 和交互上的高度一致。文中的提示词是待使用模板，不代表已经领取任务、实施改造或完成验收。

由我手工选择 agent、分派任务和衔接各阶段。每段提示词只描述当前 agent 要完成的职责、边界与交付物，不要求主 agent 调度或委派。过程和结果保存在任务文档及 QA 报告中，skills 保持精简。

## 1. 如何使用

按本次需要，选择一个角色提示词发送给承担该职责的 agent：

- 按阶段推进时，按第 4.1 节的工作流顺序选择 P1–P11；产出由我手工交给后续 agent。
- 中断接续或维护测试设施时，按需使用第 4.2 节的 P12、P13。
- 当前 agent 独立完成包含分析、设计、实现和验证的完整范围时，使用第 4.3 节的 P0。

新会话或委派任务时发送“公共前提 + 本次参数 + 一个角色提示词”。同一会话的有效前提无需重复发送。提示词中的“你”始终指当前接收任务的 agent，包括被委派的子 agent；每个 agent 只读取当前职责需要的材料，不要求阅读全部提示词、全部 skill references 或完整聊天历史。

也可以直接发送这个简短入口：

```text
阅读 docs-feature/code-workspace-idea-parity/agent-collaboration-prompts.md
中的公共前提、任务参数和 <P0–P13 中的一个编号>，完成该角色的工作。
本轮范围：<填写范围>
当前职责与交付物：<填写本次需要你完成的工作、修改范围和产出>
任务分派和后续衔接由我手工处理。
```

### 公共前提

```text
你负责完成随附范围内的当前角色工作。agent 选择、任务分派和后续衔接由我
手工处理；需要其他职责的输入时，记录具体缺口、影响和所需材料，继续可独立
完成的部分。交付聚焦自己的结果与待接续事项，不编排其他 agent 的执行。

目标：推进 Taomni Code Workspace 与指定版本 IntelliJ IDEA code editor
在功能、UI 和交互上的高度一致。当前布局、组件、菜单、样式和交互模型
都可以重构或替换，不要求复刻 IDEA 内部实现。

保留已有正确能力、数据兼容、错误语义以及保存、撤销、取消和恢复契约。
明确区分有意改变与必须保留的行为；本次引入的相邻退化由本次任务修复。
不要根据当前错误实现反推验收期望，也不要为通过测试削弱断言。

读取适用 AGENTS.md，按职责使用当前 skills 和必要 references。
以当前生产代码和匹配证据为依据，复用有效设计、任务和参考包。
历史 done 不等于当前证据有效；不重领 done、不把缺证据直接认定为缺陷。

产品固定兼容 Windows、macOS、Linux 三端 Tauri 桌面构建与运行。
真机计划覆盖三端，本轮完成当前运行端必要验证即可；其他端记录未验证
及后续步骤。已知不兼容仍需修复，browser 不替代 native/OS 证据。

验证选择为目标验收与受影响保留行为的并集。用定向单测、挂载和 browser
快速迭代；native 独有缺陷尽早做区分性探针，相关输入稳定后集中构建和
运行必要 native 场景。分别判断报告是否 current 和 QA binary 能否复用。
已有有效结果直接复用，不机械执行完整 plan/audit/status/全套测试循环。

真实 IDEA 桌面输入按已授权时段执行，核对窗口和焦点；锁屏时继续可行的
独立检查，不假定 native 或 IDEA 可操作，不自动解锁。使用隔离 QA 数据。

普通实现选择自主完成。只有偏离参照、产品范围或兼容契约等实质未决取舍
需要我 review；先提供具体候选及影响，不重复申请已授权的 UI 重构。
需要用户决定的部分保持待决，继续独立工作，未回复不代表同意。

保留其他 agent 和用户改动。按任务授权处理代码、任务状态和提交，不因
协作自动提交、推送或发布。过程记录不写入 skills；若获授权维护 skill，
只沉淀可复用规则和设施修复。
```

### 任务参数与交接包

只填写本阶段实际需要的字段。整体盘点时可以没有任务 ID；进入工作包开发前必须定位有效板和 ID。缺失的可查证信息由 agent 查找，真正影响目标的未决信息再讨论。

```text
本轮范围：<能力或连续用户场景>
目标 IDEA：<版本/build/edition，或现有有效参考包路径>
参考环境：<平台、主题、窗口尺寸、缩放、字体、keymap；未知项标明>
仓库与源码基线：<checkout/worktree、HEAD、相关未提交改动或内容身份>
任务板与 ID：<完整仓库相对路径 + ID；没有则说明尚待规划>
当前设计与参考：<有效 spec、DEC、参考包/图稿路径>
目标及保留验收：<AC/V ID 或对应章节>
当前职责与交付物：<本次要完成的工作、文件/模块范围、结果及结束条件>
依赖与集成约定：<共享接口、依赖输入、相关 owner、已有集成约定>
验证材料：<精确 case ID/test 文件、配置、报告路径及有效性>
当前阶段与待办：<已完成、失败、缺证据、待决及本次应完成项>
执行资源：<可用环境、QA 构建/输出目录归属、桌面时段>
本次修改权限：<只读/文档/指定产品代码/测试设施；提交要求沿用用户授权>
```

## 2. 人工选择角色时的参考

本节供我选择承担者，不要求当前 agent 选择模型、安排人员或派发任务。

**模型建议核查于 2026-09-13。** 每份 P 提示词前提供至少 8 个组合，供我手工设置当前工具、模型和 effort；这些选择说明放在可复制任务正文之外。详细工具接入、原生档位、价格、促销期限与官方来源见 [Coding Agent 与模型选型说明](coding-agent-model-selection.md)。推荐是按本任务的能力/成本要求作出的判断，尚未在 Taomni 上横向实跑。

**已确认可用资源：agy + Gemini 3.8 Flash、OpenCode + Muse Spark 1.3/DeepSeek V4.1 Flash/GLM-5.3 Flash、Codex + Astra/Sol/Terra/Luna、Claude Code + DeepSeek V4.1 Flash**（agy 按 Google Antigravity 理解）。已把它加入每个 P 段：状态汇总 Low，常规采样/实现/验证 Medium，设计/复核及复杂分析 High；在适合的阶段优先利用现有额度。具体套餐及余量尚未核对，账单按 agy 自身规则。

表中的“首选”是没有额外账号偏好时的起点；Claude Code + DeepSeek V4.1 Flash 与 Codex/OpenCode + DeepSeek V4.1 Flash 共享模型参考，但工具 harness 和实际成本需分别校准；已有订阅额度时可优先选择对应工具。`默认/自动` 表示不虚构产品未提供的 effort 档位，`thinking on/adaptive` 是原生思考模式。Cline/Kilo/OpenHands 的费用按实际 provider 核算，不能直接套用其他网关价格。

| 合并工作包 | 推荐的已有 agent / 模型 / effort | 主要职责与提示词 | 适用边界 |
|---|---|---|---|
| 1. 盘点、参考与方案 | **agy + Gemini 3.8 Flash High**；Codex + Astra/Sol high；OpenCode + Muse Spark 1.3 high | 范围盘点、优先级、IDEA 参考、UI/交互目标、架构契约（P1–P5） | 需要真实 IDEA/native 采样时必须具备对应桌面环境；未决契约交给强推理组合 |
| 2. 实现、修复与集成 | **agy + Gemini 3.8 Flash Medium**；Codex + Terra medium/high；OpenCode + GLM-5.3 Flash max；Claude Code + DeepSeek V4.1 Flash high | 开发工作包、失败修复、集成、交接接续（P6、P10–P12） | 任务契约应已明确；共享状态、异步竞态或反复失败时升级 Astra/Sol |
| 3. 功能、UI 与回归验收 | **agy + Gemini 3.8 Flash Medium/High**；Codex + Luna medium；OpenCode + Muse Spark 1.3 high；Claude Code/OpenCode/Codex + DeepSeek V4.1 Flash high（文字证据） | 功能回归、截图和交互比较、完成标准（P7–P8、P11） | 纯文本模型不能独立作视觉结论；native 证据仍需本机设施 |
| 4. 高风险审查与测试设施 | **Codex + Astra high/xhigh**；Codex + Sol xhigh；OpenCode + GLM-5.3 max；Claude Code + DeepSeek V4.1 Flash max | 独立 review、根因诊断、runner/fixture/skill 维护（P9–P10、P13） | 独立 review 应由未参与实现的 agent 执行；DeepSeek 组合不套用原生 Claude/Codex 榜单分数 |


这些是四类可直接执行的工作包，不要求四个常驻 agent，也不绑定必须的模型。一个 agent 可以连续完成多个工作包；小包的开发和验证可以合并。独立复核应由未参与该实现的 agent 执行，条件不满足时如实标注为自检。

成本较低的 agent 先用一个边界清楚的工作包校准能力。如果经常误解验收或返工，调整任务粒度或升级承担者；不要只根据调用单价判断总成本。

## 3. 阶段安排与并行边界

| 顺序 | 合并工作包 | 包含提示词 | 推荐已有组合 | 进入条件 |
|---|---|---|---|---|
| 1 | 盘点、参考与方案 | P1–P5 | agy Gemini High；Codex Astra/Sol high；OpenCode Muse high | 范围、目标、证据和契约足够明确 |
| 2 | 实现、修复与集成 | P6、P10–P12 | agy Gemini Medium；Codex Terra medium/high；GLM-5.3 Flash max；Claude Code DeepSeek V4.1 Flash high | 工作包或修复边界明确 |
| 3 | 功能、UI 与回归验收 | P7–P8、P11 | agy Gemini Medium/High；Codex Luna medium；Muse high | 目标 AC、保留行为和比较材料可验证 |
| 4 | 高风险审查与测试设施 | P9–P10、P13 | Codex Astra/Sol；GLM-5.3 max；Claude Code DeepSeek V4.1 Flash max | 有具体风险、失败或设施维护目标 |


四类工作包按常见顺序排列，但不要求每次都执行四类。盘点发现参考缺口时在第 1 类内补 P3；任意阶段出现失败时转入第 2 或第 4 类的 P10，修复后回到第 3 类复验；P12 用于中断接续，P13 用于设施维护，P0 是当前 agent 独立完成完整范围的替代入口。

阶段由我手工衔接，可重叠，也可在小改动中合并；不要求每个工作包经过全部角色。目标已清楚、规格充分时直接使用 P6。当前 agent 按本次职责交付，不自动启动其他角色。阶段转换不新增通用审批关卡。

- 当前 agent 沿用已确定的目标、契约和任务板；仅在本次职责包含开发任务归属时领取并更新状态，其余角色交付材料。任务板仍是开发状态唯一来源，不另建状态引擎。
- 当前 agent 只修改约定文件和模块。同一 `CodeWorkspaceTab`、LSP 共享模块或共享 store 存在他人并行改动时，先核对边界；未明确归属的冲突写入交付，继续独立部分。
- 隔离 worktree 可减少文件覆盖，但不能消除接口和行为冲突。合并后检查最终组合代码，分支各自通过不等于集成通过。
- 当前 agent 仅使用约定的构建和桌面资源。同一 QA 输出目录不并行构建，原生会话和共享桌面采样顺序执行。browser/单测仅在状态与资源隔离时并行。
- 有效依赖未完成时不抢领下游卡。独立工作包可集中原生验证；真正的前置卡先完成必要验收，不为了凑批次绕过依赖。
- 目标、契约或风险发生变化时，当前 agent 给出依据、影响和候选方案；常规执行在职责内自主完成。不能因降低成本遗漏必需的验收。

## 4. 按工作流排列的可复制提示词

以下提示词配合第 1 节公共前提和本次参数使用。`audit`、`plan`、`next` 等是 skill 的自然语言模式，不是 shell 命令。

### 4.1 按工作流顺序使用

以下按一次完整迭代的常见顺序排列。P1 用于需要先确认现状的会话；已有明确任务时可跳过。P9 仅在高风险时使用，P10 仅在发现问题时使用。其他阶段也可按有效输入和本次职责直接进入，不要求逐项重跑。

#### P1 只看当前状态与下一步

适合：能依据当前材料汇总状态并提出下一步建议的 agent。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | Low | 你已有可用入口；只读状态汇总先用轻思考和现有额度 |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选省钱 | Codex | GPT-5.6 Luna | low | 明确材料的状态汇总，token 单价低 |
| 文字省钱 | OpenCode / Zen | DeepSeek V4.1 Flash（API `deepseek-flash`；旧 ID 兼容） | low | 任务板、回执与文字证据整理；不做图像判断 |
| 文字省钱 | Qwen Code / Model Studio | Qwen3.8 Flash | thinking off | 纯提取与格式化；涉及冲突判断时开启 thinking |
| 已有订阅 | GitHub Copilot 本地 Agent / CLI | MAI-Code-1.1-Flash | 默认 | 轻量汇总，优先利用现有 AI credits |
| 低成本执行 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 材料量较大时仍可用较低单价完成工具检索 |
| 更复杂材料 | OpenCode / Zen | Muse Spark 1.3 | low | 存在少量相互矛盾的记录时，兼顾判断与成本 |
| 已有订阅 | Claude Code | Claude Haiku 4.5 | 默认；无 effort 档 | 轻量只读任务；API 并非本表最低价 |
| IDE 入口 | Cursor Agent | Composer 2.5 | 自动/默认；Standard | 已有 Cursor 时方便；选择普通速度降低费用 |

成本重点：这里只读汇总，先用轻量模型；材料存在实质冲突时再选择更强判断能力。

```text
你负责使用 $code-workspace-idea-parity status 汇总随附范围的当前状态和下一步。
只读代码、任务、设计与已有证据；按需用 $qa-ui-auto 判断证据时效和已有成本，
不执行产品测试、启动 IDEA/native、编译、改代码或修改任务状态。

分别列出功能实现、UI 比较、交互比较、证据当前性、保留行为验证和未决项。
历史 done、当前 stale 和确定的产品回归分开说明，不输出缺少分母的对齐百分比。
给出建议接续的准确任务/设计路径和下一动作，说明需要补证据还是需要改产品。
已有完成任务不重领；本次只交付状态，不把建议当成已启动工作。
```

#### P2 整体盘点与优先级规划

适合：强推理 agent。只交付盘点和计划时使用。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选均衡 | Codex | GPT-5.6 Sol | high | 生产调用链、证据与优先级需综合判断；控制盘点范围 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 多来源、长指令和 UI 材料的低于顶级旗舰价位备选 |
| 已有资源备选 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；复杂材料与图像盘点可试，高风险契约再比较强推理选项 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 代码与图像参照一起分析，International 当前 $2/$6 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 跨模块盘点；材料可放入 256K 时比 K3 1M 省配额 |
| 稳定起点 | Claude Code | Claude Sonnet 5 | high | 按约束形成差异和优先级，成本低于 Opus/Fable |
| 多模态备选 | Gemini CLI / Google API | Gemini 3.8 Flash | high | 截图、长文档与代码综合整理，直连有当前促销价 |
| 源码专项 | OpenCode / Zen | GLM-5.3 | high | 只承接文字/源码盘点；UI 结论需已有有效图像复核材料 |
| 另一模型家族 | OpenCode / Zen | Grok 4.6 | high | 工具调用与多步判断，输出单价低于 Sol/Opus |

成本重点：先限定盘点场景及证据范围；源码专项组合不能单独替代直接的视觉判断。

```text
你负责随附范围的整体盘点与规划。使用 $code-workspace-idea-parity audit 和 plan，
比较当前 Taomni Code Workspace 与目标 IDEA；本次交付盘点和规划，不实施产品改动。

定位生产入口和调用链、已有任务、设计及证据。建立范围内的场景目录，
覆盖相关项目树、标签页/分屏、编辑、导航、搜索替换、补全/诊断、重构/格式化、
Git、运行调试、设置与快捷键；完整 IDEA 插件生态不自动纳入。

分别判断功能、视觉和交互，分类为已对齐、部分对齐、未实现、待验证或不可比较。
每项关联代码入口、IDEA 参照、Taomni 证据和差异依据；没有明确分母及逐项证据
不输出笼统的对齐百分比。首次做整体目录，后续按变化增量更新。

按需使用 $idea-reference 复用参考或提出最小补采需求；使用 $qa-ui-auto
判断现有证据和必要区分性检查，不为整体盘点默认编译 native 或跑全套测试。

产出可接续差异表、优先级、依赖和建议首个工作包。区分产品缺陷、体验差异
与纯证据缺口。复用有效文档，必要材料写入 docs-feature/code-workspace-idea-parity/。
不领取任务，不把规划中的检查标为已执行。
```

#### P3 IDEA 参考：复用、采样与源码解释

适合：探索和设计能力强的 agent；步骤已确定时可交给可靠执行者。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | Medium | 你已有；图像、browser 与采样资料整理适合复用现有环境 |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选均衡 | Gemini CLI / Google API | Gemini 3.8 Flash | medium | 参考截图、步骤和状态整理，多模态且直连价格较低 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | medium | 已有场景步骤的采样与摘要，避免默认最高 effort |
| 已有订阅 | Claude Code | Claude Sonnet 5 | medium | 同时理解操作、界面状态和源码解释 |
| 固定步骤省钱 | Codex | GPT-5.6 Luna | medium | 步骤和观察点已明确时使用；隐藏规则探索换 Terra/Sol |
| 低成本多模态 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 原图读取、工具执行和资料整理；先校准一个场景 |
| 低成本多模态 | Qwen Code / Model Studio | Qwen3.7 Plus | thinking on；默认预算 | 图像与文字参考整理，适合明确采样范围 |
| IDE/browser 入口 | Cursor Agent | Grok 4.6 | medium；Standard | 利用已有 browser 工具；真实 IDEA 仍需桌面设施 |
| 已有订阅 | Kimi Code | K2.8 Preview（kimi-for-coding） | high | 支持图像/视频的资料接续；显式 high 控制默认 max 的用量 |
| 低成本多模态 | OpenCode / Zen | GLM-5.3 Flash | high | 已明确步骤的图像采样与整理；先核对当前 provider 的图像输入 |

成本重点：已确定步骤可用便宜执行者；参照未知或焦点/状态难解释时提高能力。所有选项都需要实际桌面采样设施。

```text
你负责随附场景的 IDEA 参考材料，使用 $idea-reference 建立可交接的参考包。
先检查现有参考的版本/build、设置、fixture、关键状态和原始工件，复用有效部分，
仅补缺失或失效场景。不修改 Taomni 产品，也不领取产品任务。

使用可重建的隔离 fixture 和匹配环境，记录实际鼠标/键盘动作、焦点、选区、
展开/打开、菜单、取消、撤销和关键恢复状态。保存必要原图及步骤对应关系。
界面记录布局、密度、字体、图标、颜色角色及本场景有关的控件状态。

在已授权且可操作的桌面时段完成采样，输入前检查目标与焦点。
输入交错或焦点漂移的步骤标为无效并按需重采；原图不能靠文件名猜状态。
环境不具备时继续可做的源码/资料整理，明确缺少哪些实测。

只有需要解释隐藏规则时才查对应版本源码与测试，不默认克隆或构建整个 IDEA。
事实、源码依据、推断和拟议 Taomni 适配分开记录。

交付脱离聊天即可复现的参考摘要、原始工件位置/获取方式和复用边界。
参考包完成不等于 Taomni 已经对齐。
```

#### P4 UI 与交互目标设计

适合：设计能力强的 agent。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；多状态 UI 目标和可查看原型可优先尝试 |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选均衡 | Claude Code | Claude Sonnet 5 | high | UI/交互契约与可实施方案兼顾，费用低于 Opus/Fable |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 图像理解、长指令与前端代码产出结合 |
| 多模态备选 | Gemini CLI / Google API | Gemini 3.8 Flash | high | 多状态截图和设计材料分析；当前直连价格较低 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 多模态目标设计，适合中文契约与图稿说明 |
| 复杂契约 | Codex | GPT-5.6 Sol | high | 同时改变布局、动作与状态 owner 时使用 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 前端视觉与工程契约结合；大视频材料另选 1M 入口 |
| IDE 原型 | Cursor Agent | Grok 4.6 | high；Standard | 可编辑前端原型并用 browser 检查，避免 Fast 溢价 |
| Pro 备选 | Gemini CLI / Google API | Gemini 3.1 Pro Preview | high | 复杂多模态推理的另一选项；费用高于当前 Flash 促销价 |
| 小范围省钱 | OpenCode / Zen | GLM-5.3 Flash | max | 支持视觉 UI 编码；明确目标的小范围设计先校准，再扩大使用 |

成本重点：优先具备图像理解和工程约束能力的组合；重大交互契约未定时不要只按单价选择。

```text
你负责本轮 UI 与交互目标设计，使用 $feature-design design，依据随附差异和
$idea-reference 参考，形成高度贴近 IDEA 的 UI 与交互改造设计。

以匹配的 IDEA 状态和操作为目标，不把当前 Taomni 布局与组件视为约束。
先核对现有正确能力及动作/数据 owner，设计新的界面组织和交互，明确保留契约。

设计覆盖本场景相关的布局比例、行高/间距、字体、图标、颜色角色、溢出、
菜单/弹层锚点，以及鼠键动作、焦点流转、选区、加载/失败、取消/恢复状态。
写清有意改变的行为和平台差异。尺寸或容差须有参照与环境依据，不凭空声明像素一致。

在涉及结构或主要流程调整时，提供足够判断的可查看图稿或交互原型。
按 skill 使用可用绘图工具；静态图不足以表达关键反馈时再补交互原型。
沿用已有决定；存在实质体验或兼容取舍时，先展示具体方案、推荐及影响供我 review。
没有新的实质取舍时自主收敛，不为每处样式细节设置审批。

交付可实施设计、目标状态、重要 DEC、AC/V、保留行为断言及必要图稿，
写入或更新 docs-feature/ 的有效文档。计划覆盖三端桌面，当前端真机验收和
其他端待验证步骤明确；本次设计不冒充产品实现或验证通过。
```

#### P5 架构与职责拆分、建立开发工作包

适合：强推理/架构 agent。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选均衡 | Codex | GPT-5.6 Sol | high | 共享状态、接口、生命周期和依赖拆分 |
| 稳定起点 | Claude Code | Claude Sonnet 5 | high | 常规架构工作包；实质复杂冲突再考虑 Opus |
| 已有资源备选 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；契约明确时可拆工作包，复杂共享状态需更强复核 |
| 文字工程备选 | OpenCode / Zen | GLM-5.3 | max | 官方建议复杂编码使用 max；模型单价低，但推理 token 需观察 |
| 文字成本备选 | OpenCode / Zen | DeepSeek V4 Pro | high | 源码因果与工作包依赖，适合已有明确 UI 目标的输入 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 跨模块设计转任务，沿用已确定的验收契约 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 长代码上下文与职责边界，优先较省配额的 256K |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 把完整目标与约束整理成可开发任务 |
| 另一模型家族 | OpenCode / Zen | Grok 4.6 | high | 工具接续与多步方案分析，当前输出价格适中 |

成本重点：共享契约错误会放大后续返工；复杂状态/IPC 问题保留强推理，文字模型使用已确定的 UI 设计作为输入。

```text
你负责将随附目标设计细化为可开发工作包。使用 $code-workspace-idea-parity plan，
结合 $feature-design 和 $code-workspace-idea-task 的工作包编写流程。
本次授权编写/更新相关设计及任务板，不领取或实施产品任务。

核对当前代码的入口、状态 owner、异步生命周期、动作路由、IPC 和副作用。
针对本轮需要重构的部分确定模块边界、接口、集成位置与消费者，不按前后端
文件数量平均分工。遇到大型 shell 或 LSP 模块，按相关职责渐进提取；
搬文件本身不视为解耦，也不开展无关全量重写。

每包以一个可演示用户结果为单位，关联 IDEA 目标、目标/保留 AC、生产落点、
建议文件职责、依赖、错误/取消/迟到结果/恢复语义和最小验证集合。
保留模块级快速测试和必要 shell/IPC 接线回归，三端兼容与当前端验证明确。

标明依赖关系、可并行条件、共享文件冲突，以及最终集成和 QA 构建需要的职责与输入。
已有 owner 约定直接沿用，尚未分派的职责标为待分派，供我手工处理。
已有板和 ID 优先复用；所有 task-board 命令带准确 --doc，不修改无关卡或
制造已完成依赖。只给当前可开发的任务充分细化，后续不确定任务保留待细化状态。

交付板路径、首批可推进 ID、共享契约、依赖和工作包交接材料。
```

#### P6 开发一个工作包

适合：实现和执行能力强的 agent。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | Medium | 你已有；已设计清楚的常规工作包优先利用现有额度 |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选均衡 | Codex | GPT-5.6 Terra | medium | 验收已清楚的常规工作包，控制相较 Sol 的用量 |
| 低成本实现 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 明确组件/模块开发；先确认真实接线和回归完整性 |
| 低成本实现 | Qwen Code / Model Studio | Qwen3.7 Plus | thinking on；默认预算 | 边界明确的前端/脚本实现，不承担未决架构取舍 |
| 已有订阅 | Kimi Code | K2.8 Preview（kimi-for-coding） | high | 官方定位日常开发；比默认 max 更保守地使用配额 |
| IDE 入口 | Cursor Agent | Composer 2.5 | 自动/默认；Standard | 适合文件编辑、终端与工具循环；普通速度价格明显更低 |
| 已有订阅 | Claude Code | Claude Sonnet 5 | medium | 已设计清楚的编码与测试；跨模块风险提高到 high |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | medium | 长指令约束较多的小包，可按实际复杂度提高到 high |
| 已有订阅 | GitHub Copilot 本地 Agent / CLI | Kimi K2.7 Code | 默认 | 利用现有额度执行代码任务；保留真实测试与 native 边界 |
| 编码专项 | OpenCode / Zen | Grok Build 0.1 | 默认；未公开离散 effort | 低输出单价的明确编码备选；不要套 Grok 4.6 的档位 |
| 隔离执行备选 | OpenHands / OpenRouter | MiniMax M3 | 默认 adaptive | 适合可在其运行环境完成的小包；本机 native 验收需另具环境 |

成本重点：任务已充分设计时优先中档或低价实现；涉及共享状态、异步生命周期或复杂 Rust/Tauri 接线时提高档位。

```text
你负责使用 $code-workspace-idea-task 完成随附任务板和 ID 对应的一个工作包，
按需使用 $qa-ui-auto。先核对任务、依赖和生产代码，按当前 lifecycle 领取或接续。

按已确定的 IDEA 目标和设计实施 UI/交互重构，保持真实生产入口及副作用接线。
先确定本次保留行为及相关改前依据；缺陷修复补能暴露原错误的最小回归。
普通实现自主决定，不能用当前实现替代目标，也不能跳过共享消费者的影响检查。

你与其他 agent 共用代码成果。只修改约定职责范围，不覆盖或撤销他人改动；
需要调整共享接口/其他 owner 文件时，给出具体变更建议、影响和所需输入。

快速迭代选择相关测试文件/名称和 browser 场景；稳定后完成本卡必要当前端验证。
若随附材料已有验证证据，核对其有效性并复用；你仍负责完整验收和本卡状态更新。
本次引入的回归先修复，不留给下一工作包。

发现参照/设计存在实质冲突时，向我报告最小复现、受影响契约和候选方案，
继续独立工作；不擅自降低目标。按证据如实结束于当前 skill 支持的状态。
交付生产效果链、变更、测试/回归结果、未运行边界和下一步，不默认提交或推送。
```

#### P7 功能与回归验证执行

适合：可靠执行者；验收不明确或失败无法归因时交付具体缺口和诊断证据。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | Medium | 你已有；固定用例、回执和截图验证适合 Medium |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选省钱 | Codex | GPT-5.6 Luna | medium | 固定 case、回执身份与断言核对，范围明确时成本低 |
| 文字执行省钱 | OpenCode / Zen | DeepSeek V4.1 Flash（API `deepseek-flash`；旧 ID 兼容） | high | 运行已知检查并分析文字回执；截图判断交给多模态选项 |
| 低成本多模态 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 命令执行、结果与失败截图整理，需有实际测试工具 |
| 低成本多模态 | Qwen Code / Model Studio | Qwen3.7 Plus | thinking on；默认预算 | 已知测试步骤和结果比对，失败复杂时再升级 |
| 已有订阅 | Kimi Code | K2.8 Preview（kimi-for-coding） | high | 执行定向回归并保留证据，不默认 max/HighSpeed |
| 复杂验收 | Claude Code | Claude Sonnet 5 | medium | 需要理解保留契约的验证，费用高于 Flash/Luna |
| 多模态备选 | Gemini CLI / Google API | Gemini 3.8 Flash | medium | 涉及多张失败图与回执的定向执行 |
| IDE 入口 | Cursor Agent | Composer 2.5 | 自动/默认；Standard | 复用 IDE/browser 环境；无必要不购买更快生成速度 |
| 低成本多模态 | OpenCode / Zen | GLM-5.3 Flash | high | 固定命令、文字和失败图整理；需确认 provider 传递图像 |

成本重点：编译、fixture 和等待耗时通常不靠提高模型 effort 或购买 Fast 缩短；失败无法归因时按 P10 处理。

```text
你负责使用 $qa-ui-auto 验证随附工作包的目标 AC 与受影响保留行为。
先检查断言和输入身份，复用有效证据，选择最便宜且充分的检查。
仅运行已知 case 时直接选择执行，不增加固定的审计/规划/状态检查全流程。

browser 使用确认属于当前 checkout 的 URL、明确模式和隔离上下文；
可按需使用 skill 的最小 browser 配置，不继承无关 native/provider 前提。
需要 native 时先检查 QA build 复用条件，使用独立 QA ID、配置和 fixture。
新 native 语法/平台支持在构建前做必要 preflight，稳定输入集中执行。

实际验证动作后的用户结果和保留行为，包括相关错误、取消、保存/撤销、
连续操作与恢复；不能只断言控件可见或被点击。保留失败回执和截图。
未经授权不改产品；不得以删除步骤、降低断言或扩大超时来制造通过。

检查 summary、matching receipt 及 source/case/runner/config/build 身份。
区分 current/stale、selected/pass/fail/skip 和 review gap；二进制可复用
不等于当前用例已通过，browser 不能证明磁盘、IME、OS 或 native 行为。

交付 AC/保留行为到检查和证据的对应、精确命令、平台/前端模式、构建/复用次数、
耗时与失败/缺口。未知项列明待证事实和所需输入，不更新他人任务状态。
```

#### P8 UI 与交互一致性复核

适合：强设计 agent，优先与实现者不同。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；双侧截图和交互证据复核使用 High |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选均衡 | Claude Code | Claude Sonnet 5 | high | 按关键状态和交互契约复核，避免仅做主观视觉评价 |
| 多模态备选 | Gemini CLI / Google API | Gemini 3.8 Flash | high | 匹配双侧截图和操作证据，直连促销费用较低 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 对照图像、长约束及多步行为，Standard 支持完整思考档位 |
| 复杂行为 | Codex | GPT-5.6 Sol | high | 视觉差异涉及焦点、状态和代码行为时使用 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 多模态目标与实际结果的比较；保留原图与步骤依据 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 前端视觉与操作状态分析；需要读视频时改用 k3 |
| IDE/browser 入口 | Cursor Agent | Grok 4.6 | high；Standard | 已有 Cursor 检查环境时成本与操作便利性兼顾 |
| 小范围省钱 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 明确状态与容差的小范围比较；模糊体验判断选更强备选 |
| 小范围省钱 | OpenCode / Zen | GLM-5.3 Flash | max | 有明确状态与容差的图像复核；不能沿用纯文本 5.3 的能力判断 |

成本重点：这里需要真实图像与操作证据。模型选择不能补足缺少的双侧材料，纯文本模型不作为完整复核选项。

```text
你负责随附工作包的 UI 与交互一致性复核，使用 $code-workspace-idea-parity verify
和 $qa-ui-auto 的 IDEA 比较流程。本次不实施产品改动或更新任务状态。
未参与实现时作为独立复核；参与过实现时如实标注为自检。

依据真实 IDEA 参考与 Taomni 当前运行结果，匹配 fixture、操作、关键状态、
窗口/缩放、字体、主题和平台。优先复用有效双侧材料，缺哪项才补哪项。

视觉检查相关布局、几何、密度、字体、图标、颜色角色、焦点/失焦、禁用、
菜单/弹层和边缘状态；交互检查真实鼠键、焦点、选区、打开/关闭、取消和恢复。
文字描述和静态截图不能替代决定性的操作证据；不同主题/缩放不能直接算像素差。

对每项分别给出已一致、存在差异或待验证，指出依据和影响。
结构 validator 通过不等于实测匹配，也不把所有差异合并成一个“看起来相似”。
明确哪些差异属于已接受适配，哪些仍阻止达到工作包目标。

返回优先修复项、状态/截图/步骤定位、证据限制及范围内结论。
普通执行证据齐全时不重新跑全套功能测试；新发现的功能风险附具体触发与依据。
```

#### P9 高风险代码与回归独立 Review

适合：强推理/架构 agent。用于共享状态、快捷键、保存/撤销、LSP 生命周期等风险。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选推理 | Codex | GPT-5.6 Sol | xhigh | 共享状态、保存/撤销、竞态等需要深入追踪；限定相关调用链 |
| 强推理备选 | Claude Code | Claude Opus 5 | high | 复杂契约与代码后果，费用高于 Sonnet，适合高风险复核 |
| 已有资源备选 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；可做有界独立 review，多重异步/保存契约优先强推理选项 |
| 文字工程备选 | OpenCode / Zen | GLM-5.3 | max | 适合源码、异步与共享消费者；观察 max 的实际 token 成本 |
| 文字成本备选 | OpenCode / Zen | DeepSeek V4 Pro | high | 有精确 diff/契约的独立 review，降低输出单价 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 跨文件上下文审查；只有必要时增加到 max 或 1M |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 契约及代码证据完整时的另一家族复核 |
| 另一模型家族 | OpenCode / Zen | Grok 4.6 | high | 独立检查实现后果，复杂未决问题才升 xhigh |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | xhigh | 复杂长链约束审查；比默认 high 花费更多思考 token |
| 疑难升级 | Codex | GPT-6 Astra | high | 多重未决契约或反复漏判时使用，不作为普通卡默认 |
| 疑难升级 | Claude Code | Claude Fable 5.1 | high | 长程根因与高风险完整性；高单价仅在减少返工时值得 |

成本重点：仅检查相关入口、消费者和风险；独立性来自未参与实现及独立判断，换品牌本身不等于独立审查。

```text
你负责依据随附契约和 diff，独立 review 本工作包的生产实现及保留行为。
使用 $code-workspace-idea-parity 的契约接续与 $qa-ui-auto 的回归/证据规则。
本次只读审查；必要时执行非破坏的最小诊断，不修改产品、用例或任务状态。

沿入口、owner、共享消费者、真实副作用和观察点核对实现，重点检查本次涉及的
状态唯一归属、异步取消/迟到结果、焦点/快捷键抢占、保存/撤销/恢复及三端兼容。
大型文件只读取有关符号和必要调用方，不反复通读整个模块。

检查目标和保留行为是否都有真实断言，测试是否 mock 掉被改路径，删除/放宽
断言是否对应授权的契约变化，分支各自通过是否遗漏最终组合行为。
开发者自评用作定位，不能代替独立判断；复用有效测试，不默认再编译或跑全套。

按影响列出发现：文件/符号、触发条件、实际后果、违背的契约、证据和建议。
区分确认问题与待验证风险，不把无关重写或风格偏好升级为阻塞。
没有发现也说明审查范围和未验证边界；交付审查结论与待处理项，不签发更广泛产品通过。
```

#### P10 失败、回归或测试耗时异常处理

适合：具备复现与诊断能力的 agent；复杂因果或共享契约问题需要较强推理能力。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选均衡 | Codex | GPT-5.6 Terra | high | 先处理有界复现、日志和构建成本；复杂因果再换 Sol |
| 稳定起点 | Claude Code | Claude Sonnet 5 | high | 区分产品、测试、设施与环境问题 |
| 已有资源备选 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；日志、截图与定向复现可先分析，疑难根因再升级 |
| 文字成本备选 | OpenCode / Zen | DeepSeek V4 Pro | high | 日志与源码根因，已有复现时性价比更可控 |
| 文字工程备选 | OpenCode / Zen | GLM-5.3 | max | 复杂编译/runner/异步故障；避免无边界排查 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 跨模块因果链和修复接续；控制上下文额度 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 源码、环境和图像混合输入的诊断 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 长工具循环与原始证据核对 |
| 小故障省钱 | Kilo Code / OpenRouter | MiniMax M3 | 默认 adaptive | 明确 fixture、配置或脚本故障；复杂契约选更强模型 |

成本重点：先形成最小复现与区分性证据；范围清楚的小故障用低价模型，跨模块未知根因使用更强组合。

```text
你负责使用 $qa-ui-auto 处理随附失败、回归或验证耗时异常。
先保留原始报告，检查源码、case、runner、配置、build 和环境是否匹配。
区分产品退化、测试期望错误、设施故障、依赖缺失以及 stale 证据。

用已有 costs、构建日志和最小区分性检查确定时间花在编译、fixture、启动、
等待/断言还是重复执行；不为测成本先跑全套，也不把测试耗时当产品响应时间。
native 报告失效与 build needed 分开判断，保持增量构建和隔离状态。

按随附修复权限推进：已有明确修复契约时直接修复相关 owner 范围；
确认 bug 且需要正式修复设计时使用 $issue-design，产出可交接因果链、
修复边界、原错误失败→通过和相关正常行为继续通过的断言。
诊断权限不足以修改的部分返回具体修复建议；修复范围冲突列明涉及文件、契约和影响。

失败仍不能归因时，给出已排除假设、最小复现、待证事实和下一项区分性检查。
根因由证据判断，不请用户投票；实质产品取舍才准备候选供 review。
修复后复跑原触发及受影响检查，保留先失败后成功记录，不扩展无关产品需求。
```

#### P11 集成与当前端交付

适合：承担本次集成职责的 agent；需要理解涉及的共享契约。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选均衡 | Codex | GPT-5.6 Terra | high | 常规集成与受影响消费者验证 |
| 稳定起点 | Claude Code | Claude Sonnet 5 | high | 最终组合代码、错误恢复和验证证据核对 |
| 已有资源备选 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；常规组合检查可用，native 仍需本机对应设施 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 实现、图像与证据材料共同接续 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 跨文件组合行为，避免无必要的 1M 配额消耗 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 共享接口、样式与状态的组合检查 |
| IDE 入口 | Cursor Agent | Grok 4.6 | high；Standard | 本地工程与 browser 集成；native 必须具备相应设施 |
| 小包省钱 | Kilo Code / OpenRouter | MiniMax M3 | 默认 adaptive | 契约稳定的小包集成；复杂共享状态换强推理组合 |
| 源码专项 | OpenCode / Zen | GLM-5.3 | max | 组合代码和文字回执；UI 结论仅复用有效双侧复核证据 |

成本重点：优先复用匹配证据与构建，避免因换模型重编；纯文本组合只在视觉证据已经有效时承担相应集成职责。

```text
你负责随附已完成实现工作包的集成与验证，按授权范围执行并使用 $qa-ui-auto。
沿用任务板、设计和文件 owner，先核对各分支/工作区及尚未提交的改动。
按约定集成方式处理实际代码，保留他人成果；未授权的提交、合并或发布不执行。

在最终组合代码上检查共享接口、样式作用域、状态/事件生命周期和连续操作，
复用有效独立检查，对组合才出现的风险补定向验证。消费者回归不能因各包
已有绿色结果而省略；本轮引入的退化在本次修复权限内处理并重新验证，超出
权限的部分交付复现、影响和修复建议，保留未完成的验收项。

代码/测试稳定后检查已有 QA binary 的复用条件；本次职责包含构建时按约定
资源构建，否则记录所需构建输入。具备匹配 binary 后集中执行必要 native 场景。
报告和 binary 身份分别核对，不能把其他分支、旧 runner 或旧前端的通过
冒充当前集成结果。

计划覆盖三端，完成当前端必要真机验证并记录其他端未验证；
完整 build/集成/发布 gate 仅执行本轮契约中属于你的部分，不机械附加。

交付最终代码身份、目标/保留验收、功能/UI/交互结论、失败与未验证项、
实际构建/复用和耗时。证据关联准确任务板与 ID；仅在你就是该卡 owner 时
使用任务工具如实更新并校验，其他卡保留可接续材料，不代改其他 agent 所有权。
```

### 4.2 中断接续与设施维护

这两类工作按实际需要插入任意阶段；处理后继续原阶段的未完成项。

#### P12 中断或换 Agent 后接续

适合：接替原职责的 agent。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 已有资源优先 | Antigravity（agy） | Gemini 3.8 Flash | Medium | 你已有；交接充分的常规接续优先使用现有模型 |
| 已有模型备选 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；文字编码、日志和契约分析，图像判断需多模态入口 |
| 已有模型备选 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有模型接入；沿用 Claude Code 工具循环，模型评测与原生 Claude 分开看 |
| 首选均衡 | Codex | GPT-5.6 Terra | medium | 已有交接包的日常接续；原任务风险较高时提高 effort |
| 已有订阅 | Claude Code | Claude Sonnet 5 | medium | 沿用已有决定完成剩余工作，避免重做盘点 |
| 已有订阅 | Kimi Code | K2.8 Preview（kimi-for-coding） | high | 日常开发接续，按当前文档固定实际模型身份 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | medium | 长约束和已有工具结果接续，控制重复阅读成本 |
| 低成本实现 | Qwen Code / Model Studio | Qwen3.7 Plus | thinking on；默认预算 | 清楚的小包接续；未决架构问题使用 Max 模型 |
| 低成本实现 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 剩余动作与验收已经明确时使用 |
| IDE 入口 | Cursor Agent | Composer 2.5 | 自动/默认；Standard | 继续已有本地编辑与测试，不为切换工具丢失成果 |
| 已有订阅 | GitHub Copilot 本地 Agent / CLI | Kimi K2.7 Code | 默认 | 明确交接后的代码任务，按原验收结束 |

成本重点：按被接续任务的实际风险选模型；本表默认针对契约已明确的工作，复杂 review/设计沿用对应 P 段的组合。

```text
你负责接续随附交接包中的职责和未完成任务。先读取适用 AGENTS、当前阶段 skill、
准确任务板/ID、有效契约和待办，不从头盘点整个编辑器。

核对交接后的源码和工作区变化，区分仍有效结果、历史失败、stale 和待执行项。
需要产品开发时按 $code-workspace-idea-task 的 lifecycle 接续；卡已 done
则不重领，只有新的开发授权和差距才规划后续任务。

优先完成原目标与保留行为中尚未满足的部分；用 $qa-ui-auto 复用有效检查和
匹配构建，只复验受变化影响的项。输入或 owner 冲突写明具体边界与影响，
继续可独立完成的部分，保留他人改动。
继承有效用户决定，不重复申请已授权的 UI 重构，也不把推荐项当用户同意。

交付本次完成内容、剩余真实条件及精简接续信息，不重写整套设计或过程历史。
```

#### P13 维护 Skills 与测试设施

适合：具备工具实现和指令设计能力的 agent；只有实际授权维护时使用。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选均衡 | Codex | GPT-5.6 Terra | high | 指令、runner 与配置问题的聚焦持久修复 |
| 稳定起点 | Claude Code | Claude Sonnet 5 | high | 工具/指令边界与 E2E 验证契约一起处理 |
| 已有资源备选 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；聚焦脚本/设施修复，复杂 runner 重构保留强推理备选 |
| 文字工程备选 | OpenCode / Zen | GLM-5.3 | max | 涉及 runner 生命周期或共享设施的复杂改动 |
| 小改省钱 | Qwen Code / Model Studio | Qwen3.7 Plus | thinking on；默认预算 | 边界清楚的脚本与 skill 文案修复 |
| 已有订阅 | Kimi Code | K2.8 Preview（kimi-for-coding） | high | 明确设施回归与使用说明，控制默认 max 的用量 |
| 小改省钱 | Cline / MiniMax 兼容接入 | MiniMax M3 | 默认 adaptive | 配置、脚本及文案；实质 workflow 重构选择更强组合 |
| 另一工具入口 | Kilo Code / OpenRouter | DeepSeek V4 Pro | high | 文字日志/脚本根因；以 provider 实际参数与费用为准 |
| 隔离设施验证 | OpenHands / OpenRouter | MiniMax M3 | 默认 adaptive | 可在其运行环境完成的脚本/CLI 工作；不外推本机 native 通过 |

成本重点：文案、配置和脚本小修无需旗舰；runner/workflow 重构按风险提高能力，原验收不能降低。

```text
你负责完善随附问题涉及且本次获授权修改的 skills 和测试设施。
使用 $qa-ui-auto，可用时结合 $skill-creator；仅修复随附问题，不启动产品
全量盘点、无关开发或新一轮完整 IDEA 对齐。

区分 agent 没有遵循已有规则、skill 指令缺陷和脚本/配置缺陷。
前者纠正执行；后两者优先做最小持久修复，能由工具解决的重复排查不要变成
冗长人工规程。删除重复或无决策价值的说明，细节按需引用。

脚本变更增加必要行为回归，并重现原触发验证修复。实质 workflow/runner
重构按 skill E2E 规则完成职责内的有界实跑；需要独立验证时，交付真实请求、
原始材料和环境要求供我手工分派，验证输入不附预期结论。若你承担独立验证，
直接按收到的请求实跑并记录原始结果。小幅文案修正不强制重新开发产品功能。

维持断言、隔离、构建复用和来源可信度，不通过放宽门禁制造性能改进。
只改报告/规划工具时用设施测试和真实 CLI 验证，不因 native 报告 stale 重编。

Skill 内只保留可复用规则、必要命令及设施。案例记录、截图、耗时和本次结论
放相关任务文档/QA 报告，保持入口简洁，不建立第二套重复测试或任务状态体系。
交付修复落点、复验结果及明确的使用边界。
```

### 4.3 单 Agent 完整范围入口

需要当前 agent 独立完成整个范围时使用 P0；它覆盖前述工作流，不是额外的第一步或最后一步。

#### P0 当前范围：完成分析、设计、实现与验证

适合：能独立承担分析、设计、实现和验证的 agent。用于当前 agent 的完整范围开发授权。

| 选择 | Coding agent / 接入 | 模型 | Effort / 思考设置 | 能力与成本取舍 |
|---|---|---|---|---|
| 首选性价比 | Antigravity（agy） | Gemini 3.8 Flash | High | 你已有；DeepSWE 长任务成绩与 Astra 接近且成本较低，适合中等范围完整流程 |
| 首选均衡 | Codex | GPT-5.6 Sol | high | 持续分析、实现和验证；能力与成本平衡，复杂共享契约再升 Astra |
| 已有模型省钱 | Codex | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有 provider；文字代码和诊断成本低，视觉步骤交给多模态入口 |
| 已有模型省钱 | Claude Code | DeepSeek V4.1 Flash（`deepseek-flash`；旧 ID 兼容） | high | 你已有入口；沿用 Claude Code 工具循环，不能套用原生 Claude 榜单成绩 |
| 能力/成本 | OpenCode / Zen | Muse Spark 1.3 | high | 你已有；多模态和长指令完整流程，公开 Coding Agent Index 处于中上水平 |
| 低成本实现 | OpenCode / Zen | GLM-5.3 Flash | max | 你已有；DeepSWE 成本极低，适合范围已收敛的完整工作包 |
| 已有订阅 | Kimi Code | K3-256K（k3-256k） | high | 完整小范围开发；只有必要时使用 k3 的更长上下文 |
| 能力/成本 | Qwen Code / Model Studio | Qwen3.8 Max | thinking on；默认预算 | 工程与视觉混合任务，使用相应本地验证设施 |
| IDE 入口 | Cursor Agent | Grok 4.6 | high；Standard | 结合 IDE/browser 持续推进，核对完整 native 执行条件 |
| 多模态备选 | Gemini CLI / Google API | Gemini 3.8 Flash | high | 可控范围的资料、代码与图像工作，直连有当前促销价 |
| 范围清楚省钱 | Claude Code | Claude Sonnet 5 | high | 已有大部分契约的小范围全流程，费用低于 Opus/Fable |
| 疑难升级 | Codex | GPT-6 Astra | high/xhigh | 多阶段未决问题和反复失败；公开 Coding Agent Index 领先，不默认 Ultra 自动分派 |
| 疑难升级 | Claude Code | Claude Fable 5.1 | high | 持续长程推理与验证，高单价仅用于复杂完整任务 |

成本重点：单 agent 完整流程建议先在一个小范围校准。默认优先 agy Gemini High 或 Codex Sol；范围清楚且预算敏感时用 Codex/Claude Code DeepSeek V4.1 Flash High 或 OpenCode GLM-5.3 Flash Max；希望兼顾多模态和返工率时用 agy Gemini High 或 Muse High。Astra/Fable 只留给未决契约、跨模块竞态或多次失败等能抵消额外费用的疑难任务。单 agent 必须自己完成阶段间的记录、回归和交付，不自动创建或指挥其他 agent。

```text
你负责本轮指定范围的 Taomni Code Workspace 与 IntelliJ IDEA code editor
高度一致性改造，使用 $code-workspace-idea-parity 完成分析、设计、实现和验证。

先核对当前代码、有效文档和已有决定，再确定本轮参照与优先工作包。
把“高度一致”落实到可观察场景，分别约定功能结果、UI 目标和交互行为；
不从局部截图或一个用例推断全编辑器一致。

先明确本轮目标和必要契约，再依次推进范围内依赖满足的工作包。将工作压缩为四类：
盘点/参考/方案，实现/修复/集成，功能/UI/回归验收，高风险审查/设施诊断；
按需在每类中使用对应 P 提示词，不为形式完整而拆成十几个独立任务。
通过 $code-workspace-idea-task 每次领取或接续一个有效任务，完成其实现及
必要验证；已有 done 不重领，已充分的设计不重写，不机械执行所有角色流程。

保持一个清楚的待办入口。职责内的设计冲突、代码退化和证据缺口自行处理；
依赖外部输入的部分写明具体缺口、影响和所需材料。普通实现自主决定，
实质产品取舍给具体方案供我 review。自己的复核如实标为自检。

每个工作包完成目标、保留行为与必要当前端验证后，如实记录结果，再推进本轮
范围内后续工作。只在新变化、失败或尚未满足的要求下扩大或重复检查。
报告实际完成范围、功能/UI/交互差异、成本与剩余条件，不以卡片数量代替一致性。
```

## 5. 完成标准与成本判断

“高度一致”应落实到已声明范围的场景及 AC，而非主观相似度。每个工作包分别给出：

| 维度 | 判定依据 |
|---|---|
| 功能 | 真实入口产生预期结果，相关失败/取消/恢复及保留行为正常 |
| UI | 匹配环境下的双侧关键状态比较；几何或视觉容差按场景约定，有测量依据 |
| 交互 | 实际鼠键、焦点、选区、菜单、打开/关闭和恢复序列符合契约 |
| 集成与回归 | 最终组合代码的相关消费者与连续操作已验证，无未解决的本次新增退化 |
| 证据 | 来源/模式/环境可识别，current、历史、stale、skip 和未验证明确分开 |

仅当范围内契约满足，或明确记录已经接受的有限差异，才能声称该范围完成。任何整体结论须覆盖约定的场景目录；缺少双侧观测的项目继续标为待验证。用户接受差异不能被当作省略测试或忽略回归的理由。

成本观察使用已有记录：强 agent 的设计/review 开销、执行开销、构建与测试耗时，以及返工次数/原因。比较相同任务规模和环境，不预设固定节省比例，也不相加嵌套的 run/case/step 耗时。优先消除模糊交接、重复盘点、重复编译及职责冲突；高风险目标和契约判断仍由合适的强 agent 承担。

## 6. 当前技能入口

| Skill | 仓库入口 |
|---|---|
| 统筹、盘点、规划、推进与状态 | [code-workspace-idea-parity](../../.agents/skills/code-workspace-idea-parity/SKILL.md) |
| IDEA 实操与源码参照 | [idea-reference](../../.agents/skills/idea-reference/SKILL.md) |
| UI/交互及新增行为设计 | [feature-design](../../.agents/skills/feature-design/SKILL.md) |
| 已证实错误的修复设计 | [issue-design](../../.agents/skills/issue-design/SKILL.md) |
| 工作包编写、领取与交付 | [code-workspace-idea-task](../../.agents/skills/code-workspace-idea-task/SKILL.md) |
| 全 App 功能、UI、native 验证与成本诊断 | [qa-ui-auto](../../.agents/skills/qa-ui-auto/SKILL.md) |

`qa-test-auto` 请求接续到当前规范名称 `qa-ui-auto`。`skill-creator` 来自 agent 环境，使用时确认可用性，不假设其安装在某台机器的固定路径。示意图/浏览器工具按相关 skill 路由按需使用，不要求所有角色预先安装或加载全部工具。

已有 [skills 实跑验收记录](skill-e2e-project-tree.md) 可作为操作经验与历史证据入口，其中的产品工作包和通过结果不代表本轮已经领取或当前输入自动有效。
