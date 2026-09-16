# Code Workspace 工作流：Coding Agent、模型与成本选型

核查日期：**2026-09-13**。配合 [按工作流排列的提示词](agent-collaboration-prompts.md) 使用；各 P 段已经列出可选的工具、模型、effort 和适用边界，供用户手工选择。

本次检索覆盖 Codex、Claude Code、OpenCode、Cursor、Antigravity（agy）、Gemini CLI、GitHub Copilot、Cline、Kilo Code、Qwen Code、Kimi Code、OpenHands、Aider 和 Muse Code。以下区分官方已公布的能力/设置/价格与本项目的选型判断：**推荐顺序是基于任务要求和公开资料的起点，没有在 Taomni 上对这些组合做横向实跑，也不代表实测质量排名。**

**用户已确认可用资源：**

- agy（Google Antigravity）+ Gemini 3.8 Flash；
- OpenCode + Muse Spark 1.3、DeepSeek V4.1 Flash、GLM-5.3 Flash；
- Codex + GPT-6 Astra、GPT-5.6 Sol/Terra/Luna；
- Claude Code + DeepSeek V4.1 Flash。

因此提示词中的“已有资源优先”优先从上述入口选择。已有入口不等于无限额度；尚未核对套餐、余额、并发和实际 provider 路由。Claude Code 与 OpenCode 使用同一 DeepSeek V4.1 Flash 时，模型能力参考可以共用，但工具 harness、上下文拼接、编辑方式和费用仍需分别校准。

DeepSeek 官方当前模型 ID 是 `deepseek-flash`，对应 **DeepSeek-V4.1-Flash**；旧的 `deepseek-v4-flash` 名称会被兼容路由到 V4.1-Flash 并按 Flash 价格计费。OpenCode 文档仍可能显示旧名称，配置时应以实际 provider 的模型目录和账单为准。Claude Code 的 DeepSeek 官方接入示例使用 `ANTHROPIC_MODEL=deepseek-flash[1m]`，并允许设置 `CLAUDE_CODE_EFFORT_LEVEL`；这不表示 Claude Code 原生 Claude 模型的评测成绩可以套用到 DeepSeek 组合。

## 1. 先选择能执行任务的工具

Coding agent 是执行工具；模型决定主要推理能力；provider 决定接入、价格和部分参数支持。同一个模型放进不同工具，不保证同样的工具调用、截图输入、上下文管理或验收结果。下表的接入方式已经查阅相应产品文档，但不代表当前账号都已开通。

| Coding agent | 本轮值得考虑的模型/入口 | 适合的工作与成本条件 | 资料 |
|---|---|---|---|
| Codex 本地 App / CLI / IDE | GPT-5.6 Luna、Terra、Sol；GPT-6 Astra；用户已有的 DeepSeek V4.1 Flash provider 接入 | Luna 做明确执行，Terra 做日常开发，Sol/Astra 做复杂分析；DeepSeek Flash 做低成本文字执行和诊断。区分 ChatGPT 配额、第三方 provider 与 API 计费 | [模型](https://developers.openai.com/codex/models/)、[配额](https://developers.openai.com/codex/pricing/)、[DeepSeek 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/) |
| Claude Code | Haiku 4.5、Sonnet 5、Opus 5、Fable 5.1 | Sonnet 是开发/设计常用起点；Opus/Fable 用于复杂契约或根因。订阅及 usage credits 与 API 账单分开核算 | [模型与 effort](https://code.claude.com/docs/en/model-config)、[API 价格](https://platform.claude.com/docs/en/about-claude/pricing) |
| OpenCode + Zen / 自选 provider | Muse Spark 1.3、Grok 4.6、Grok Build 0.1、GLM-5.3 Flash、DeepSeek V4.1 Flash、MiniMax M3 等 | 方便比较多个模型家族；Zen 公布具体模型 ID 和按量价格。API 网关是 provider，不是另一种 agent | [Zen](https://opencode.ai/docs/zen/)、[模型设置](https://opencode.ai/docs/models/) |
| Cursor Agent | Composer 2.5、Grok 4.6、Muse Spark 1.3，以及 Claude/GPT/Gemini | 已有 Cursor 订阅时值得优先使用相应额度池；IDE 与 browser 结合方便 UI 工作。Composer/Grok 要注意默认 Fast 的额外费用 | [模型与计费](https://cursor.com/docs/models-and-pricing)、[Composer](https://cursor.com/docs/models/cursor-composer-2-5) |
| Google Antigravity（agy） | **Gemini 3.8 Flash，用户已有**；另可选 Gemini 3.1 Pro 等 | 编辑器、browser、终端与 artifacts 结合，适合参考、UI 与常规开发。优先利用现有基础额度，超额按 Antigravity 自身 credits 规则 | [模型和档位](https://antigravity.google/docs/models)、[Agent 工具](https://antigravity.google/docs/agent)、[额度](https://antigravity.google/docs/plans) |
| Gemini CLI | Gemini 3.8 Flash；Gemini 3.1 Pro Preview | 多模态资料、截图理解、参考采集、设计和定向执行。下文按 Google API key 手动选模型；OAuth 账号不保证同样目录 | [模型选择](https://geminicli.com/docs/cli/model/)、[配置](https://geminicli.com/docs/reference/configuration/) |
| GitHub Copilot Agent / CLI | MAI-Code-1.1-Flash、Kimi K2.7 Code，以及 GPT/Claude/Gemini/Grok | 已在 VS Code/GitHub 中工作的备选；本地 Agent/CLI 更适合本仓库。云端 PR agent 不能自动取得本机 IDEA/native 桌面 | [可用模型](https://docs.github.com/en/copilot/reference/ai-models/supported-models)、[价格](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) |
| Cline | MiniMax M3、DeepSeek V4.1 Flash，或其他 provider 的模型 | 适合愿意自行选择 provider 的 IDE/CLI 用户。M3 走兼容 API 或更新后的模型目录；Cline 的 MiniMax 教程仍主要举 M2.x，不能照抄旧上下文上限 | [接入](https://docs.cline.bot/getting-started/authorizing-with-cline)、[MiniMax](https://docs.cline.bot/provider-config/minimax)、[DeepSeek](https://docs.cline.bot/provider-config/deepseek) |
| Kilo Code | OpenRouter 上的 MiniMax M3、DeepSeek V4 Pro 等 | Code/Architect/Debug 模式适合明确职责；支持多 provider，报价以实际路由为准，不把 Zen 价格当 Kilo 的账单 | [工具](https://kilo.ai/docs/getting-started)、[provider](https://kilo.ai/docs/ai-providers)、[OpenRouter](https://kilo.ai/docs/ai-providers/openrouter) |
| Qwen Code | Model Studio 的 Qwen3.8 Max、Qwen3.7 Plus、Qwen3.8 Flash；也支持第三方 provider | 中文材料、代码分析及按契约实现的备选；Max 处理复杂任务，Plus/Flash 降低日常费用。采用实际 thinking 参数，不强行套用 GPT 档位 | [工具](https://qwenlm.github.io/qwen-code-docs/en/users/overview/)、[配置](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)、[模型](https://www.alibabacloud.com/help/en/model-studio/models) |
| Kimi Code CLI / VS Code | K3、K3-256K、K2.8 Preview；K2.7 Code HighSpeed | 有会员时是长期开发的备选；普通工作优先 K3-256K 或 K2.8。K3 1M 消耗约两倍配额，HighSpeed 消耗三倍配额，不能当省钱档 | [模型与配额关系](https://www.kimi.com/code/docs/en/kimi-code/models.html)、[入口](https://www.kimi.com/code/docs/en/) |
| OpenHands | MiniMax M3，或按其 Agent SDK / LiteLLM 接入其他模型 | 适合隔离环境里的代码、脚本、browser 工作；需要运行环境成本。可作为 P6/P13 的有界执行备选，本机 native 验证仍需相应环境 | [官方模型建议与接入](https://docs.openhands.dev/openhands/usage/llms/llms) |
| Aider | 通过其支持的 provider 选择代码编辑模型 | 适合限定文件的结对编辑；官方“最佳模型”页面仍列旧版本，未据此推断最新组合的可靠性。完整 skills/native 工作流本轮不优先选它 | [模型接入及限制](https://aider.chat/docs/llms.html) |
| Muse Code | Muse Spark 1.3 | Meta 官方 coding agent；发布资料侧重 macOS/Linux 安装与多 agent 工作。当前 Windows、手工分派场景优先 OpenCode/ Cursor 接入相同模型 | [官方发布](https://research.meta.ai/blog/introducing-muse-spark-1-3) |

本仓库的 `$skill-name` 写法不是所有工具的通用语法。换工具时，把它理解为读取并遵循仓库 `.agents/skills/<skill-name>/SKILL.md`，确认该工具能读取 AGENTS、执行命令、编辑文件及接收所需图像。P3/P4/P8 涉及图像判断时，需要图像输入真正到达模型；GLM-5.3 等纯文本模型只适合其中的文字/源码部分。

## 2. Effort 的实际含义与可用档位

下列 `low/medium/high/xhigh/max` 是各自产品的原生设置，**不同模型的同名档位不等价**。`默认` 表示使用已核实的模型默认行为或当前工具未公开离散档位；不表示模型没有推理能力。`thinking on` / `adaptive` 是思考模式，不伪装成 effort 等级。

| 模型 / 接入 | 已核实的控制 | 本工作流的建议 | 来源 |
|---|---|---|---|
| Codex：Luna / Terra / Sol / Astra；DeepSeek V4.1 Flash provider | GPT 模型选择器提供 reasoning effort；DeepSeek API 原生为 `none/low/high/max`（medium/xhigh 映射 high，ultra 映射 max），第三方 Codex 接入以 provider 支持为准 | GPT 明确任务先 low/medium、复杂分析 high；DeepSeek Flash 文字执行 high，简单汇总 low。Ultra 会自动使用子 agent，不适合本次手工分派约定 | [Codex Models](https://developers.openai.com/codex/models/)、[配置](https://developers.openai.com/codex/config-reference/)、[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/) |
| Claude Code：Sonnet 5 / Opus 5 / Fable 5.1 | `low/medium/high/xhigh/max`；Haiku 4.5 不支持 effort | Sonnet 日常开发 medium、高风险 high；Opus/Fable high 起步。`ultracode` 另带动态工作流编排，不作为本表默认 | [Claude Code](https://code.claude.com/docs/en/model-config#adjust-effort-level)、[模型规则](https://platform.claude.com/docs/en/build-with-claude/effort) |
| Muse Spark 1.3 Standard | `minimal/low/medium/high/xhigh/max`，不支持 `none` | 文本汇总 low，执行 medium，设计/分析 high，复杂复核 xhigh | [Meta reasoning](https://dev.meta.ai/docs/reasoning.md)、[OpenCode 元数据](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/muse-spark-1.3.toml) |
| Grok 4.6 | `low/medium/high/xhigh`，默认 high | 执行 medium，复杂分析 high；不填写 max | [xAI](https://docs.x.ai/developers/models/grok-4.6)、[Cursor](https://cursor.com/docs/models/grok-4-6) |
| Grok Build 0.1 | 官方模型页列有 reasoning，但未给出可调 effort 档位 | 填“默认”，用于已明确的编码任务；不照搬 Grok 4.6 参数 | [xAI](https://docs.x.ai/developers/models/grok-build-0.1) |
| Gemini 3.8 Flash | `thinkingLevel: low/medium/high`；不支持 minimal | 图像采样/执行 medium，设计/复核 high | [Google 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) |
| Antigravity + Gemini 3.8 Flash | 产品模型选择器提供 Low / Medium / High 思考档，本表使用这些档位 | Low 汇总，Medium 常规实现/验证，High 设计/复核。Agent 工作模式与模型 thinking 档位分开设置 | [产品档位](https://antigravity.google/docs/models)、[3.8 Flash 发布](https://antigravity.google/blog/gemini-3-8-flash-in-google-antigravity) |
| Gemini 3.1 Pro Preview | 支持 thinking；Gemini CLI 的该模型配置使用 `thinkingLevel: HIGH` | 作为多模态复杂分析的 high 备选，保留 Preview 标识 | [模型](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)、[CLI 配置](https://geminicli.com/docs/reference/configuration/) |
| DeepSeek V4.1 Flash（API `deepseek-flash`；旧名兼容） | thinking 默认开启；`none/low/high/max`，其中 medium/xhigh 映射 high、ultra 映射 max | 状态汇总 low，定向执行 high；Claude Code 与 OpenCode 均须核对实际 provider 参数 | [模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Claude Code 接入](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code) |
| DeepSeek V4 Pro（Zen） | 目录声明 thinking 开关及 `high/max` | 默认建议 high；不把直连 API 的全部映射承诺给 Zen | [Zen 元数据](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/deepseek-v4-pro.toml) |
| GLM-5.3（Zen） | `low/high/max`；始终开启 reasoning，默认 max，纯文本输入 | 复杂编码/契约用 max，文字分析可 high；不直接判断截图 | [5.3 官方](https://docs.z.ai/guides/llm/glm-5.3)、[Zen 目录](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/glm-5.3.toml) |
| GLM-5.3 Flash（Zen） | `low/high/max`；模型支持图像、视频和文件，不能与纯文本 5.3 混为一谈 | 定向执行 high；图像设计/复核可用 max，先校准具体场景。实际 provider 也须传递图像 | [Flash 官方](https://docs.z.ai/guides/vlm/glm-5.3-flash)、[Zen 目录](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/glm-5.3-flash.toml) |
| MiniMax M3 | `thinking.type: adaptive/disabled`，默认开启；未公布离散 effort | 填“默认 adaptive”，不写 high/max。`reasoning_split` 只是输出格式开关 | [MiniMax API](https://platform.minimax.io/docs/api-reference/text-openai-api) |
| Qwen3.8 Max / Qwen3.7 Plus / Qwen3.8 Flash | `enable_thinking` 开关，`thinking_budget` 控制预算；默认开启 thinking | 代码/设计用 thinking on + 默认预算；纯汇总可 off。不把 Qwen Code 的通用 /effort 名称当这些模型已验证的原生档位 | [Model Studio](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)、[Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) |
| Kimi Code K3 / K3-256K / K2.8 Preview | `low/high/max`；K3 默认 high，K2.8 默认 max | 日常建议显式 high；medium 映射 high，xhigh 映射 max。关闭 thinking 会路由到 K2.8 Preview，不能视为 K3 的低档 | [Kimi Code](https://www.kimi.com/code/docs/en/kimi-code/models.html) |
| Kimi K3（OpenCode Zen） | 目录只声明 `max` | 与 Kimi Code 会员入口区别对待，不填 Zen 未声明的 high | [Zen 元数据](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/kimi-k3.toml) |
| Kimi K2.7 Code（Zen / Copilot） | Zen 未声明离散 effort；Copilot 未将它列为可配置 reasoning 的模型 | 填“默认”；不要与 Kimi Code 的 K2.8 Preview 动态 ID 混用 | [Zen 元数据](https://github.com/anomalyco/models.dev/blob/dev/providers/opencode/models/kimi-k2.7-code.toml)、[Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models) |
| Cursor Composer 2.5 | 产品描述自动校准 effort，未公开用户可选的 low/high 档位；Standard/Fast 是速度档 | 填“自动/默认 + Standard”，不要把 Fast 写成高 effort | [Cursor](https://cursor.com/docs/models/cursor-composer-2-5) |
| Copilot MAI-Code-1.1-Flash | 官方将其列为轻量模型，未列为可配置 reasoning 的模型 | 填“默认”，用于只读汇总或明确的小任务 | [支持范围](https://docs.github.com/en/copilot/reference/ai-models/supported-models)、[定位](https://docs.github.com/en/copilot/reference/ai-models/model-comparison) |

在工具里选择实际模型和档位，不能只在提示词中写“使用 high”就认为设置生效。OpenCode 的 variant 是 provider-specific；升级模型目录后仍缺少某档时，使用 provider 文档支持的参数，不能只创建一个叫 high 的空 variant。

## 3. 独立评测证据（截至 2026-09-13）

以下结果来自公开评测的指定版本和 harness，用来校准能力方向；它们不是 Taomni 的横向实跑，也不是各 agent 产品的保证。相同模型在不同 agent、工具提示词、网络和额度下可能有不同结果。

| 来源/版本 | 测试范围与设置 | 对本选型有用的观察 |
|---|---|---|
| [Artificial Analysis Coding Agent Index v1.5](https://artificialanalysis.ai/agents/coding-agents) | DeepSWE v1.1（113）、Terminal-Bench 4.0（66）、SWE-Atlas-QnA（124）三项等权；每任务 3 次 pass@1；评测的是具体 agent+模型+effort | Codex + Astra (max) **61.6**，Muse Code + Muse Spark 1.3 (max) **54.3**，OpenCode + GLM-5.3 (max) **53.6**，Antigravity SDK + Gemini 3.8 Flash (high) **41.9**。成本是 API token 成本，不含订阅、监督和本机环境。 |
| [Artificial Analysis 方法与版本](https://artificialanalysis.ai/methodology/coding-agents-benchmarking) | 当前 v1.5；Composite 只是三项平均，版本历史明确从 Terminal-Bench 2.1 升至 4.0、DeepSWE 1.0 升至 1.1；结果保留 per-benchmark breakdown | 不能把总分当 UI 视觉分或单一编码成功率；应按 repository Q&A、patch、terminal 工作类型解读。 |
| [DeepSWE v1.1](https://deepswe.datacurve.ai/blog/deepswe-v1-1) | 113 个任务、91 个仓库、5 种语言；固定 mini-swe-agent；提交 diff 在隔离 verifier 容器评分；误差为 4 次整套运行的 95% run-to-run 区间 | Astra xhigh **74% ±3%/$6.52**；Gemini 3.8 Flash high **74% ±1%/$2.36**；Sol max **73% ±3%/$6.46**；GLM-5.3 Flash max **63% ±4%/$0.24**；Luna max **67% ±4%/$0.61**。四舍五入后的并列不证明能力相同；低价需结合失败类型和本地回归判断。 |
| [Terminal-Bench 4.0](https://www.tbench.ai/) | 66 个 terminal、ML、科学、运维、安全等任务；公开 leaderboard 记录 agent、模型、effort、accuracy 和置信区间 | GPT-6 Astra max **58.2% ±2.8%**（Codex，330 trials）；这是 terminal 能力证据，不能单独代表 IDE/UI 体验。 |
| [SWE-Bench Pro Public](https://scale.com/leaderboard/swe_bench_pro_public) | 731 个抗污染公开任务，要求 fail-to-pass 且无回归；与 Verified 的高分不可直接比较 | 说明真实工业代码的长任务难度显著高于常见 Verified 分数；旧页面中的模型和版本不能替代本轮 V4.1/3.8 结果。 |

**如何用于当前工作流：** P2/P5/P9 的复杂契约、长链根因优先 Astra/Sol；P4/P8 的截图和 browser 证据优先 agy Gemini 3.8 Flash High 或 Muse Spark 1.3 High；P6/P7/P10/P11 的已收敛工作包优先 agy Gemini Medium、GLM-5.3 Flash Max、Luna 或 DeepSeek V4.1 Flash High。Claude Code + DeepSeek V4.1 Flash 及 Codex + DeepSeek V4.1 Flash 是你已有入口中的低成本候选，但没有对应的独立榜单组合分数，不能引用 Claude Code + Opus/Sonnet 或 Codex + V4 Pro 的分数代替。未来模型使用 `+` 版本（例如 DeepSeek-V4.1-Flash+）时，先记录真实 model ID、provider、effort 和账单，再把旧版本评测标为参考，不能自动继承旧分数。

## 4. 可比较的费用基线

单位为 **USD / 100 万 token**，采用核查日、所注明 provider 的普通速度/短上下文价格。相同模型的不同渠道单独列出。未包含税费、充值费、工具费、缓存写入/存储、长上下文加价和本机/云端构建成本。

“示例费用”只计算 **100K 非缓存输入 + 20K 计费输出**：`0.1 × 输入单价 + 0.02 × 输出单价`。这是统一 token 用量下的比较，**不是一个工作包的费用预测**；真实输出可能包含更多思考 token，不同 tokenizer 也会改变用量。

| 模型 | 报价渠道 | 输入 | 缓存读 | 输出 | 示例费用 | 来源 |
|---|---|---:|---:|---:|---:|---|
| DeepSeek V4.1 Flash（`deepseek-flash`） | DeepSeek API；OpenCode/Claude Code 兼容接入 | 0.15 | 依缓存规则 | 0.60 | 0.0270 | [Zen](https://opencode.ai/docs/zen/) |
| Qwen3.8 Flash | Model Studio International | 0.15 | 依缓存规则 | 0.47 | 0.0244 | [Alibaba](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
| GLM-5.3 Flash | OpenCode Zen | 0.15 | 0.03 | 0.50 | 0.0250 | [Zen](https://opencode.ai/docs/zen/) |
| GPT-5.6 Luna | OpenAI API | 0.20 | 0.02 | 1.20 | 0.0440 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| MAI-Code-1.1-Flash | GitHub Copilot | 0.20 | 0.02 | 1.20 | 0.0440 | [GitHub](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) |
| MiniMax M3 | OpenCode Zen | 0.30 | 0.06 | 1.20 | 0.0540 | [Zen](https://opencode.ai/docs/zen/) |
| MiniMax M3 | OpenRouter 的 Minimax endpoint，声明支持 tools | 0.30 | 0.06 | 1.20 | 0.0540 | [实时 endpoints](https://openrouter.ai/api/v1/models/minimax/minimax-m3/endpoints) |
| Qwen3.7 Plus | Model Studio International 标价，≤256K | 0.40 | 依缓存规则 | 1.60 | 0.0720 | [Alibaba](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
| Qwen3.7 Plus | OpenCode Zen | 0.40 | 0.04 | 1.60 | 0.0720 | [Zen](https://opencode.ai/docs/zen/) |
| Cursor Composer 2.5 | Cursor Standard | 0.50 | 0.20 | 2.50 | 0.1000 | [Cursor](https://cursor.com/docs/models-and-pricing) |
| Grok Build 0.1 | xAI / Zen | 1.00 | 0.20 | 2.00 | 0.1400 | [xAI](https://docs.x.ai/developers/models/grok-build-0.1)、[Zen](https://opencode.ai/docs/zen/) |
| Gemini 3.8 Flash | Google API 促销价 | 0.75 | 0.075 | 3.75 | 0.1500 | [Google](https://ai.google.dev/gemini-api/docs/pricing) |
| Gemini 3.8 Flash | OpenCode Zen | 1.50 | 0.15 | 7.50 | 0.3000 | [Zen](https://opencode.ai/docs/zen/) |
| Kimi K2.7 Code | Zen / Copilot | 0.95 | 0.19 | 4.00 | 0.1750 | [Zen](https://opencode.ai/docs/zen/)、[GitHub](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) |
| Claude Haiku 4.5 | Anthropic API | 1.00 | 0.10 | 5.00 | 0.2000 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Muse Spark 1.3 Standard | OpenCode Zen / Cursor | 1.25 | 0.15 | 4.25 | 0.2100 | [Zen](https://opencode.ai/docs/zen/)、[Cursor](https://cursor.com/docs/models/muse-spark-1-3) |
| GLM-5.3 | OpenCode Zen | 1.40 | 0.26 | 4.40 | 0.2280 | [Zen](https://opencode.ai/docs/zen/) |
| DeepSeek V4 Pro | OpenCode Zen 价格页 | 1.74 | 0.145 | 3.48 | 0.2436 | [Zen](https://opencode.ai/docs/zen/) |
| Qwen3.8 Max | Model Studio International | 2.00 | 依缓存规则 | 6.00 | 0.3200 | [Alibaba](https://www.alibabacloud.com/help/en/model-studio/model-pricing) |
| Grok 4.6 | xAI / Zen / Cursor Standard，≤200K | 2.00 | 0.50 | 6.00 | 0.3200 | [xAI](https://docs.x.ai/developers/models/grok-4.6)、[Cursor](https://cursor.com/docs/models/grok-4-6) |
| Claude Sonnet 5 | Anthropic API | 2.00 | 0.20 | 10.00 | 0.4000 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| GPT-5.6 Sol | OpenCode Zen 促销价 | 2.00 | 0.20 | 10.00 | 0.4000 | [Zen](https://opencode.ai/docs/zen/) |
| GPT-5.6 Terra | OpenAI API | 2.00 | 0.20 | 12.00 | 0.4400 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| Gemini 3.1 Pro Preview | Google API，≤200K | 2.00 | 0.20 | 12.00 | 0.4400 | [Google](https://ai.google.dev/gemini-api/docs/pricing) |
| Kimi K3 | OpenCode Zen / Copilot，非 Kimi Code 会员报价 | 3.00 | 0.30 | 15.00 | 0.6000 | [Zen](https://opencode.ai/docs/zen/)、[GitHub](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) |
| GPT-5.6 Sol | OpenAI API Standard 当前表价 | 4.00 | 0.40 | 20.00 | 0.8000 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| Claude Opus 5 | Anthropic API | 5.00 | 0.50 | 25.00 | 1.0000 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| GPT-6 Astra | OpenAI API | 10.00 | 1.00 | 50.00 | 2.0000 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| Claude Fable 5.1 | Anthropic API | 10.00 | 0.25 | 50.00 | 2.0000 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |

费用解释与更新条件：

- **订阅按现有权益判断。** Codex/Claude Code/Cursor/Copilot/Kimi Code 的剩余额度可能改变优先顺序；以上 API 单价不能换算成“每个 agent 的月费”或无限任务数。Kimi Code 的 `k3-256k`、`k3`、`kimi-for-coding` 按会员配额，不套用 Zen Kimi K3 的 token 单价。
- **agy 按已持有资源优先。** 官方确认 Gemini 3.8 Flash 在 Antigravity 可用，基础额度依套餐与任务工作量；Pro/Ultra 可按 AI Credit Overages 设置使用额外 credits。Google API 价只供参考，不直接当作 Antigravity 任务账单，也不因改用 Gemini CLI 自动继承 agy 额度。见 [官方计划](https://antigravity.google/docs/plans)。
- **促销按渠道和日期分别记录。** Zen 的 Sol 半价写明至 2026-09-18；OpenAI 当前价格页另注明其 Sol 促销至少持续到 2026-11-21，不能再对表价自行打五折。Google Gemini 3.8 Flash 直连促销至 2026-12-31，之后输入/输出为 $1.50/$7.50；Zen 本次页面已经是 $1.50/$7.50。Sonnet 5 的 $2/$10 已成为标准价格。
- **资料冲突不混成一个数字。** DeepSeek V4 Pro 的 Zen 页面写输出 $3.48，models.dev 文件写 $3.84；本表采用 Zen 价格页，实际消费前以其账单页为准。Gemini 3.8 Flash 的 Cursor 页面写 $0.75/$3.50，Google 直连写 $0.75/$3.75；不同接入单独核算。
- **速度不是 effort。** Cursor Composer 2.5 Standard 为 $0.50/$2.50，Fast 为 $3/$15；Grok 4.6 Standard 为 $2/$6，Fast 为 $4/$12。构建/测试等待占主要时间时，Fast/HighSpeed 通常不能减少对应等待时间。
- **长上下文和重试会改变总账。** GPT 新模型越过 272K、Grok 越过 200K、部分 Qwen/Gemini 越过各自门槛有加价；缓存写入、命中率、来回换模型/effort 以及返工都要算。Kimi Code 文档明确切换 effort 会失去现有缓存收益。
- **免费版单列。** Zen 的 `muse-spark-1.3-contributor-free` 是限时 Contributor 路线，允许使用 prompts/completions 训练，且 Meta Contributor 不支持 max；不是 Standard 的永久免费替代。本表各提示词默认指 Standard。Google 免费层同样有额度与数据使用差异。
- **其他路线不借用表价。** Cline/Kilo/OpenHands 经 OpenRouter 或厂商直连时，采用该 endpoint 的实际报价；这里的 Zen M3/DeepSeek/GLM 价格只作为同模型参考。OpenHands 云环境、Copilot 云端 review 等可能另有运行费用。
- **同一网关内也核对工具支持。** 本次 OpenRouter M3 endpoints 中，部分更便宜路线未声明 `tools`；Minimax endpoint 明确支持 tools，报价为 $0.30/$1.20。Kilo/OpenHands 可选这类支持工具的路线，不把目录最低价直接当可用 coding agent 的成本。DeepSeek V4 Pro 的 OpenRouter 也有独立 [endpoint 与价格表](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro/endpoints)。

## 5. 如何把推荐设置到当前 Agent

这些是用户手工配置示例，不在本次会话执行、不修改仓库或个人工具配置。选定一个组合后，再发送对应 P 段。

| 工具 | 设置方式 | 注意点 |
|---|---|---|
| Codex | `/model` 选择模型和 effort；CLI 例如 `codex -m gpt-5.6-terra -c 'model_reasoning_effort="medium"'` | 使用本地会话。云端聊天不保证能手动选到同一模型 |
| Claude Code | 例如 `claude --model claude-sonnet-5 --effort medium`；或 `/model`、`/effort` | Sonnet 5 至少 v2.1.197，Opus 5 至少 v2.1.219，Fable 5.1 至少 v2.1.257。固定完整 ID 避免 alias 因 provider 指向旧版本 |
| OpenCode Zen | `/models` 选 `opencode/muse-spark-1.3` 等，再选实际 variant；非交互入口支持 `--variant` | [CLI 参数](https://opencode.ai/docs/cli/)。`opencode models opencode --refresh --verbose` 可核对目录与费用元数据；无需先发付费任务 |
| Cursor | 模型选择器选精确模型和原生 effort；Composer/Grok 成本优先时选 Standard | 旧计划的 Max Mode 可能指上下文与计费，不能等同于模型 `max` effort |
| Antigravity（agy） | 在输入框下模型选择器选择 Gemini 3.8 Flash，再选择 Low / Medium / High | 当前用户回合执行中切换，通常要到下一回合才生效；模型、工具模式和额度都以 agy 界面为准 |
| Gemini CLI | 手动选模型；在 `modelConfigs.customAliases` / `customOverrides` 的 `generateContentConfig.thinkingConfig.thinkingLevel` 设置 `MEDIUM` 或 `HIGH` | 使用 API key 时核对模型 ID，如 `gemini-3.8-flash`；`/model` 示例目录较旧，不能从旧 Auto 名称推断当前模型 |
| Qwen Code | `/model` 选 Model Studio 的精确 ID；provider 的 `generationConfig.extra_body` 设置 `enable_thinking`，需要时另设 `thinking_budget` | 通用 `/effort` 会映射/截断到 provider 能力；本表优先写已核实的原生 thinking 设置 |
| Kimi Code | `/model` 选 `k3-256k` / `k3` / `kimi-for-coding`，设置其支持的 low/high/max | `kimi-for-coding` 当前对应 K2.8 Preview，是动态 ID；记录任务实际模型版本。第三方工具按 [官方映射](https://www.kimi.com/code/docs/en/kimi-code/models.html) 设置 |
| Cline / Kilo / OpenHands | 先选 provider，再填该 provider 的精确模型 ID 和支持的思考参数 | M3：厂商直连 ID `MiniMax-M3`，Zen ID `minimax-m3`，OpenRouter ID `minimax/minimax-m3`；不要跨 provider 照抄 ID |
| Copilot | 本地 Agent/CLI 的模型选择器选精确模型；只有客户端列出可配置 reasoning 时才设置 | MAI-Code-1.1-Flash、Kimi K2.7 Code 在本表使用默认档，不凭空添加 high |

## 6. 能力和成本的取舍方法

### 单一 agent 完整范围的推荐

当用户希望一个 agent 连续完成盘点、设计、实现和验证时，建议按下表从已有资源开始。单 agent 需要在同一会话中保留交接记录，并在每个合并工作包后执行必要回归；下列公开评测只用于起点，不能替代 Taomni 本地校准。

| 优先级 | 组合 | 适用条件 | 选择理由与成本控制 |
|---|---|---|---|
| 1 | agy + Gemini 3.8 Flash High | 中等范围、需要截图/browser、多模态输入 | 你已有入口；DeepSWE v1.1 High 为 74% ±1%/$2.36（mini-swe-agent），适合能力与成本平衡；超出额度按 agy 规则核算 |
| 2 | Codex + GPT-5.6 Sol High | 代码契约、IPC、状态和实现风险中高 | Codex 原生工具链稳定，Sol 比 Astra 便宜；复杂任务只把相关工作提高到 xhigh |
| 3 | OpenCode + Muse Spark 1.3 High | 需要多模态和较长连续上下文，已有 OpenCode | 你已有；公开 Coding Agent Index 的 Muse Code 组合为 54.3（max）；通常从 high 开始，难题再 xhigh |
| 4 | Codex + DeepSeek V4.1 Flash High | 预算敏感、视觉判断可拆出或已有截图结论 | 你已有 provider；官方 Flash 价格低，模型可执行工具调用；不能把 Codex+Astra 或 DeepSeek V4 Pro 评测分数套过来 |
| 5 | Claude Code + DeepSeek V4.1 Flash High | 偏好 Claude Code 的终端工具循环 | 你已有入口；与 Codex/OpenCode 的同模型参考共享，但 harness、上下文和返工率独立测量 |
| 6 | OpenCode + GLM-5.3 Flash Max | 工作包已明确、需要多模态、预算优先 | 你已有；DeepSWE v1.1 为 63% ±4%/$0.24；复杂或开放式范围先用更强组合校准 |
| 7 | Codex + GPT-6 Astra High/XHigh | 跨模块未决契约、竞态、连续失败 | Artificial Analysis Coding Agent Index 61.6、Terminal-Bench 4.0 领先；高单价只用于预期能减少返工的完整范围 |

若任务包含真实 IDEA 操作，组合还必须具备本机桌面和对应 skill；模型本身不能替代 native 证据。若使用未来版本（例如 DeepSeek-V4.1-Flash+、Gemini 3.8 Flash+），先记录真实 ID、provider、effort、日期和账单，再与当前版本并列校准；版本名变化不自动继承旧评测或成本。

1. **P1/P7 等明确执行从低成本开始。** 优先 Luna、DeepSeek V4.1 Flash、Qwen Flash/Plus、MiniMax M3、MAI Flash；其中纯文本模型只负责命令/回执/文字，不承担直接视觉判断。
2. **P2/P4/P5/P8/P9 用足够强的模型。** Muse Spark 1.3、Sol、Sonnet 5、Qwen3.8 Max、Grok 4.6、K3 是可比较的起点；GLM/DeepSeek 的文字分析适合源码和契约，图像比较选多模态组合。
3. **P6/P10/P11/P12/P13 看任务是否已收敛。** 小工作包优先 Terra/Sonnet medium、M3、Qwen Plus、K2.8；跨模块状态/IPC/异步竞态再提高 effort 或选择 Sol/Opus/GLM-5.3 等复杂任务选项。
4. **高价模型用在能够减少返工的环节。** Astra/Fable 不作为截图采样、状态汇总、固定用例执行的常驻默认；有多重未决契约、长程根因或反复失败时再考虑。
5. **用真实小包校准，不为选型另建大测试流程。** 记录完成验收所用 token/账单、返工、耗时与遗留缺口。发现漏约束、错误工具调用或不能完成验收时，用户根据交付材料手工换档/换模型；当前 agent 继续遵守原范围和验收契约。

## 7. 尚未证明的部分

已核查公开文档、价格页和公开模型目录，未登录或改动用户的任何 coding agent 账户，未发起付费模型调用。各组合在此 Windows 环境中的模型权限、图像工具、skills 加载和 Tauri/IDEA native 执行能力仍需按实际入口确认。推荐表的低成本/强能力描述是选择依据；最终交付仍由任务证据决定。
