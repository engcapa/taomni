# P1 固定提示词：自动选定一张 P0 新卡并完成规划

无需填写“本轮输入”。复制下面整个代码块即可。P1 只选定并规划一张卡；开发领取、实现和自验交给 P2。原带参数 P1 保留在 [协作提示词](agent-collaboration-prompts.md#p1-规划到可开发)。

```text
你负责 Taomni Code Workspace 与 IntelliJ IDEA 对齐流程的 P1 规划。自动从下述唯一任务板选定一张
P0 新卡，完成这一张卡的参考、设计、AC/V 和 P2 交接。不要要求用户先填范围、任务 ID 或材料路径。

【固定材料与选板约束】
- 总入口：docs-feature/code-workspace-idea-parity/index.md
- 唯一可选任务板：docs-feature/code-workspace-idea-parity/backlog.md
- P0 能力矩阵：docs-feature/code-workspace-idea-parity/capability-matrix.md
- P0 总需求：docs-feature/code-workspace-idea-parity/overall-audit-plan-20260913.md
- 初始规格：docs-feature/code-workspace-idea-parity/task-planning.md；具体以所选卡 spec 为准
- 源码依据：docs-feature/code-workspace-idea-parity/source-audit.md
- fixture 与参考：docs-feature/code-workspace-idea-parity/references/fixture-catalog.md 及所选卡关联的参考包
- P2 模板：docs-feature/code-workspace-idea-parity/agent-collaboration-prompts.md 中“P2 开发并自验”

P0 首次运行已经完成，后续也执行过 P1–P3。沿用已有 P0，不能因为材料有旧日期就重跑首次整体评估。
唯一任务板中的 ED-PARITY-xxx 才是本提示词可选择的卡。claudedocs 下所有旧 backlog，包括
code-workspace-idea-parity-backlog.md、find-focus、tree-open-focus、shell-layout 及各日期板，
一律只读参考，不得选择、领取、接续、改状态或复制旧卡的 owner/ready/implemented/done/evidence。
矩阵、旧交接或 skill 提到旧卡时，只沿链接核对历史合同和已交付范围，不把它变成当前任务来源。
若固定任务板不存在、来源不符或没有 P0 新卡，报告需要 P0 增量产卡；不能由 P1 自建替代板或回退旧板。

【本轮权限】
允许：读取源码和文档；选定一张新卡做规划；完善该卡及其设计、参考、交接、矩阵/index 的关联摘要；
使用 IDEA 获取本包必要参照；使用 QA 的只读 status/plan；执行任务板、链接和文档的静态校验。
禁止：开发领取（task_board.py claim）、产品代码或产品测试修改、运行产品测试、启动 Taomni/browser/
native runner、产品构建、把卡标为 implemented/done、提交/推送，以及自动启动 P2 或其他 agent。
P1 选卡不写开发 owner/claimed_at/baseline，不另设一套规划 owner/status。开发由 P2 正式领取。
如果已有更具体的会话授权，沿用其范围；没有的权限不从历史交接中继承。

【一、先自动选定一张卡】
读取 AGENTS.md，以及：
.agents/skills/code-workspace-idea-parity/SKILL.md
.agents/skills/code-workspace-idea-task/SKILL.md
.agents/skills/code-workspace-idea-task/references/backlog-authoring.md
按需读取 idea-reference、feature-design、issue-design、qa-ui-auto；跨工具 skill 名表示读取相应文件，
不是 shell 命令。不要自行委派其他 agent。

先记录当前分支、HEAD 和工作区改动。明确使用下面两个只读命令，不使用脚本默认板或旧板示例：

python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md list --status deferred --json

读取卡片 metadata，仅选 status=deferred、p0.audit_id=AUDIT-20260913-01、
p0.planning_required=true、ID 为 ED-PARITY-xxx 且有 REQ/CW 来源的卡。
跳过已有其他 agent 正在修改/规划的卡、开发已领取或已实现/已完成的卡。ready 卡已可交 P2，不重复规划。
先按优先级 P0→P1→P2，再按依赖条件可推进程度、板内顺序选第一张；不要让用户手工挑卡。
planning_required 只是是否仍待 P1 细化的标记，不代表开发可领取；P1 不用 list --claimable 选规划卡。

选定后立即在聊天报告实际的完整板路径加 ID、来源 REQ/CW 和本轮用户结果，
并明确“只规划，开发交给 P2”。这些信息由你从卡片读取，用户无需填写。
之后保持同一卡，不因参考采样困难静默换卡。
若没有符合项，报告本板情况：有 ready 卡则给出准确 P2 入口；只有已实现卡则指出待验收；
全无待推进卡则列出供 P0 增量复评的已知材料。不要重开 done、制造新卡或领取旧卡凑任务。

【二、完成这一张卡的 P1 工作】
1. 读取本卡 spec、REQ/CW、已有设计、参考及后续交付证据；按当前生产入口沿 action/store/IPC/provider
   和副作用到用户观察点确认事实。历史修复已生效的部分作为现有基础，不能重复规划原修复。
   缺证据、确认缺陷、体验差异、能力缺失和待归因风险分开；保存原日期，不把旧 PASS 改成当前通过。
2. 把本包收敛为可演示的连续用户场景：前置、fixture、入口、操作、关键 UI/焦点/选区状态、最终结果、
   错误、取消、迟到、保存/撤销与恢复；只查会影响这些结果的消费者，不重做整个编辑器盘点。
3. 先复用匹配 IDEA 参照，缺少的本包状态才补采。版本/build/edition、平台、主题、缩放、字体、
   keymap、fixture 或桌面条件如果已有有效记录就直接核对复用，不要求用户重新填写。
   如果缺少的信息会影响目标或设计，直接向用户提出简短、具体的问题，并说明它影响哪个结论；
   可以询问 IDEA 环境、使用偏好或可操作桌面时段，不要求用户填写整份参数表。
   等待回复时继续不依赖该信息的源码/文档工作；未回复不代表接受差异，关键未知项不得自行编造。
   桌面输入前确认目标窗口、焦点和当前可用时段；历史时段不自动续期，锁屏不得自动解锁。
   环境不可用时写明缺失状态、准确补采步骤和阻塞 AC；源码、设置文件或帮助文档不能冒充真实观察。
4. 完成对应设计。已有规格充分就直接补齐，不重写等价设计。新增能力/交互改版用 feature-design；
   已证实 bug 的修复设计用 issue-design。当前布局可以重构；已有正确功能、数据兼容和保留契约必须明确。
   给出必要布局/密度/颜色角色/溢出/弹层/鼠键/焦点的目标及依据；明显结构变化提供可审阅图稿。
5. 给同一卡写清生产文件/符号责任、共享消费者、接口、异步生命周期、失败/取消/迟到与恢复语义，
   以及本卡自己的 DEC/AC/V。复用旧测试/参考时解释覆盖什么，不借旧卡 AC/状态或已完成 build gate。
   三端兼容都保留，按当前端给最小验证集合及其他平台计划；产品验证在 P1 中仍为未执行。
6. 缺必要目标决定时询问用户；普通实施细节自主收敛。本包太大时收窄到 P0 已指定的首包，
   不静默移除验收或自行新增任务。确需拆新卡/增加范围时交回 P0 增量产卡，保留本卡确定部分。

【三、更新同一卡并交给 P2】
完整 spec、参照、AC/V、保留断言、文件责任和依赖就绪后，按 task authoring 流程将本板同一卡
从 deferred 更新为 ready，将 p0.planning_required 改为 false；不写开发 owner 或虚构执行证据。
required_evidence 与设计一致；不能删除已知失败或必须验证的要求来制造 ready。
未满足前置则保留 deferred 和 planning_required=true，在卡内 note/spec 写具体待补信息；
不得生成声称“可立即领取”的 P2 指令。不用 blocked 冒充规划状态，它属于已领取开发任务的生命周期。
若当前成果已完全覆盖目标且没有真实剩余工作，保留证据并报告供 P0 关闭/调整，不造开发任务。

更新矩阵对应场景和 index 的链接/派生摘要，明确这是 P1 规划完成，不是功能/UI/交互已对齐。
再次 validate 本板，检查本次新增链接、anchor 和 git diff --check；不跑产品测试或构建。

规划成功时，在 docs-feature/code-workspace-idea-parity/ 生成交接文件，文件名为 handoff-p2-
加本次任务 ID 的小写形式再加 .md，名称由你自动确定。交接完整填写原 P2 模板，必须写死
docs-feature/code-workspace-idea-parity/backlog.md 和实际选中的新卡 ID；
以及本轮设计、DEC/AC/V、参考/fixture、目标环境、owner 范围、依赖、保留断言、最小验证和当前 HEAD/diff。
不得让 P2 自行选板、猜 ID 或转去旧 ED-REF-001 等历史卡。

最终交付：本次选定的新卡路径/ID、来源 REQ/CW、规划结果、设计/参考/交接路径、实际文档校验、
未执行项和待回答问题；规划成功时同时返回可直接复制的完整 P2 提示词。
本轮到 P1 结束，不领取开发、不实现、不自动开始 P2。
```
