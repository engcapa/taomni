# ED-PARITY-001 P1 静态核对记录

2026-09-15；本记录仅说明规划文档与源码审查，不是产品 evidence JSON，不写入卡片 `evidence`，没有 runtime PASS。

- 任务：`docs-feature/code-workspace-idea-parity/backlog.md::ED-PARITY-001`。
- 来源：AUDIT-20260913-01 / REQ-01 / CW-SEARCH-001、CW-SHELL-002、CW-NAV-002。
- 分支：`docs/code-workspace-idea-audit-20260913`；HEAD：`05156e0f3b5e3e7702fa5092f9c4d41eafdd1c59`；起始工作区 clean。
- 选卡：固定板 validate 9 cards；固定板 list --status deferred --json 9 cards。001/002 是 P0 且无依赖，001 顺序在先；metadata 来源、planning_required、无 owner 与工作区核对符合，未换卡。
- 首段决定：参照缺失时保留 deferred/planning_required=true。用户随后授权两段 IDEA 采样并确认原AC范围，补齐后在同卡author ready/planning_required=false；始终无 owner、claimed_at、baseline、产品evidence。旧板只读，没有新建板或复制旧卡状态。

实际只读命令：

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md list --status deferred --json
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto plan --case TC-IDE-FINDFOCUS-01 --case TC-IDE-C6-05-query-definition-reveal-history-native --platform Linux --json
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto status --case TC-IDE-FINDFOCUS-01 --case TC-IDE-C6-05-query-definition-reveal-history-native --platform Linux --reports qa-ui-auto-report --json
```

plan 识别2 cases，Find仅browser、C6-05仅native；status进程exit0，但`ok=false`，Find unverified，C6-05 stale。stale 原因 runner/source/execution config/native build source changed；旧报告 `qa-ui-auto-report/idea-comparison/ED-AUDIT-012/run-20260909-180803/summary.json`。拒绝的dry-run/legacy报告没有借用为新证据。工具不证明本卡缺少的modifier-click或IME/AT已覆盖。

旧P3 HEAD至当前所查生产链中，panel/hyperlink/query host/TS-Rust LSP文件内容无diff，Host/Group/Tab有451 additions/47 deletions。当前入口、guards、取消、reveal/history与共享消费者审查见[设计§3](../find-provider-accessibility-plan.md#3-生产责任与接口)。参照和fixture身份、原件缺失、实际安装存在性见[reference](../references/ed-parity-001-reference.md)。文件存在或manifest版本只证安装身份。

首段（桌面采样前）文档收尾实际结果，保留当时范围：

| 检查 | 结果与边界 |
|---|---|
| 固定板再次 validate | exit0，9 tasks；只证任务格式/关联合同 |
| `git diff --check` | exit0，无空白错误；另用Python检查4个未跟踪文档无行末空白 |
| Python一次性静态链接检查 | 扫描8个变更/新增Markdown，对相对HEAD新增的51处链接逐项确认目标文件和显式/标题anchor，0错误；没有把历史报告原件不存在包装成新有效链接 |
| Metadata对照HEAD | 其他8卡JSON完全相同；001仍deferred/true，audit原日期/HEAD未动，acceptance与required_evidence未减少，无owner/claimed_at/baseline/evidence |
| 文件边界 | 4个tracked文档修改 + 4个新文档，全部在本工作目录；产品、产品测试、旧板、skills零修改 |
| Fixture静态检查 | 从reference三份代码块计算UTF-8字节数/SHA256与greet偏移；F0长度71、tree偏移8/54断言成立。这不是运行Java或产品测试 |

静态链接检查使用Python读取`git diff --name-only`与`git ls-files --others --exclude-standard`，只检查相对HEAD新增Markdown链接；忽略代码块，对每个目标确认文件存在、显式`<a id>`或Markdown标题slug匹配。Metadata检查按`ide-task` JSON逐卡与`git show HEAD:<board>`比较。未检查被忽略原件为在线可取，也未验证产品行为。

## 桌面授权后的 P1 完成增量

用户两次明确提供独占桌面，并明确“沿用原AC；播报保留未验证边界”。实际输入窗口为12:58:21–13:04:02、13:08:01–13:09:42（Asia/Shanghai），均已归还。F0 Find、两轮Main→Helper定义→Main Back、无选区Ctrl-hover/release及Find切换已取得原件；独立XFixes pointer也已核对。first-hover遮挡、Ctrl+Alt+Left无返回、采样器缺Xlib/`.`/误路径错误、IDE error通知按真实边界保留；没有将这些失败改写为成功。见[新参照](../references/ed-parity-001-reference.md#observed)及[原件清单](ed-parity-001-reference-artifacts.json)。

本机四份新fixture最终hash均与初值一致；F0实际使用旧隔离窗口中相同71字节example，结束hash一致。新参照147项工件含原图/动作JSON、cursor、只读设置、计算与派生审阅图，各自kind与SHA可复核。采样启动隔离IDEA项目并import，不启动Taomni或JDT LS，不运行产品测试/build。IDEA项目实际SDK未证，语义参照只覆盖已经实测的项目内方法查询，不声明编译/外部类库就绪。

最终变更：4份tracked Markdown修改，4份新Markdown和1份原件hash清单JSON；共9份受版本控制范围文档。所有原始截图/临时collector/运行日志留在被忽略的qa-ui-auto-report。卡001仅spec/note/status与planning_required变化；audit原日期/HEAD、AC和六种required_evidence保留，其他8卡不变。

最终静态验证已执行：

- 固定板 `validate`：exit0，9 tasks。
- 固定板 `list --claimable --json`：仅ED-PARITY-001，ready/claimable=true、owner=null、pending_dependencies=[]。该命令仅在P1 author完成后核查交接，不用于初始选卡，没有claim。
- `git diff --check`：exit0；Python另检查新增文件行末空白，通过。
- 相对HEAD新增50处Markdown链接/anchor全部有效；9份文档均在本目录；完整P2提示词0占位符。
- 入库工件清单147项逐文件SHA256匹配；原始/派生/诊断分别标识，未将manifest或截图当Taomni产品证据。
- 其他8卡metadata与HEAD完全相同；001为ready/false，无开发owner/claimed_at/baseline/evidence；audit及AC/required_evidence保持原值。

先前51处链接是桌面采样前的文档版本；最终交接替换了原待解锁表，以上50处为最终版本新增链接集合，不是删除验收要求。

未执行：产品单测、browser/native runner、Taomni启动、真实JDT LS请求、产品构建、IME/AT操作、Taomni比较运行；构建/复用次数0。没有claim、开发实现、implemented/done转换、提交推送、自动P2或子agent。IDEA参照不是产品PASS；[完整P2提示词](../handoff-p2-ed-parity-001.md)已填写并固定本板/ID，等待用户启动下一轮。当前无待用户回答的规划问题，P2按设计核实时刻相关的环境readiness/桌面时段。
