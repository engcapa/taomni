# ED-PARITY-002 P1 静态检查记录

2026-09-16；分支 `docs/code-workspace-idea-audit-20260913`；HEAD `149be0e882ef638cae6b1d08984eaa21275966c6`；起始工作区干净。来源 [唯一任务板](../backlog.md) / ED-PARITY-002 / REQ-11 / CW-EDIT-003。

本文件是 P1 文档检查记录，不是 task-board execution evidence，也不是 Taomni 行为 PASS。生产源内容 SHA-256 与 IDEA 原件见 [identity](ed-parity-002-p1-identity.json)。

已实际执行的前置检查：

- `git branch --show-current`、`git rev-parse HEAD`、`git status --short`：上述分支/HEAD，起始无改动。
- `python .agents/skills/code-workspace-idea-task/scripts/task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate`：初次 exit 0，9 tasks。
- 同一显式 `--doc` 的 `list --status deferred --json`：8 张 deferred；ED-PARITY-002 是最高优先级 P0 且无依赖的新卡，metadata 符合 AUDIT-20260913-01 / planning_required=true / REQ-11 / CW-EDIT-003，无 owner。ED-PARITY-001 已 done，未接续。
- `$env:PYTHONPATH = '.agents/skills/qa-ui-auto/scripts'; python -m qa_ui_auto plan --case TC-IDE-C0-01 --case TC-IDE-C0-02 --platform Windows --json`：exit 0；selected 两例；TC-IDE-C0-02 为 browser，TC-IDE-C0-01 的 native gap 为 `native_click requires Linux/X11`。不是产品测试或 dry-run，不产生 PASS。
- 读取当前生产入口/消费者、历史原规格和 metadata；未调用 claim/update 开发命令，未改旧板。
- 用户授权本轮 5 分钟 IDEA 时段；真实采样于 22:02–22:06:43 完成，30 件 IDEA/诊断工件已登记 hash；窗口回到 example.txt，输入已停止。保留一次重复同步未弹窗的 guard-stop，不将它列为成功重采。

最终 author 变化：仅 ED-PARITY-002 从 deferred→ready、planning_required true→false，spec 指向本卡设计；原 document/code-audit/native 保留并增加 unit/typecheck。无 owner/claimed_at/baseline/evidence 字段新增；audit/prior_completion 与其他八卡 metadata 原样保留。

## 最终静态校验（实际执行）

1. 首次 author 后 validate / list --claimable 均 exit 1：本卡设计内附加 `<a id>` 使任务脚本在 DEC 段前截断 spec_section，报告 A1/A2/A3 不在本卡节内。没有删除 AC 或降低要求；移除多余手工子锚点，保留唯一 ed-parity-002 锚点后复验。
2. 最终显式板路径 `validate`：exit 0，9 tasks。`list --claimable --json`：exit 0，唯一项 ED-PARITY-002，ready、owner=null、pending_dependencies=[]、五种 required evidence 与设计一致。此命令仅为完成后的交接检查，没有用于最初选卡。
3. 本次 inline Python 文档校验：10 份变更文档；新增文件全部链接和已有文件新增行中的链接共 68 个，文件存在及 anchor 检查零错误；P2 模板无未填写输入占位。`<run>` 仅是由 P2 实际执行生成的运行目录标识。
4. 与 `git show HEAD:.../backlog.md` 逐对象比较：其余 8 卡 metadata 完全不变；本卡 audit/prior_completion/acceptance/depends_on 原样；无 owner/claimed_at/baseline/evidence/last_attempt。只有用户授权的规划字段和 note/spec 变化。
5. 当前 10 份 production/test 源内容 SHA-256 与 P1 identity 全匹配；30 件 IDEA 原件/诊断 artifact hash 全匹配。忽略目录新增 static-check.json 是文档核对结果，不冒充 IDEA 原件或产品运行结果。
6. `git diff --check`：exit 0。工作区仅 5 份 tracked 规划摘要修改与 5 份新规划文档/JSON，没有产品源/产品测试或旧板改动。本 agent 没有提交。收尾期间外部操作推进 HEAD，见下一项。

7. 最后 HEAD 重读发现外部推进：`149be0e882ef638cae6b1d08984eaa21275966c6` → `2901d541cbbf3a610b1c7873f73391b1529884bb`，分支未变。本 agent 没有执行提交、拉取、合并或 reset。`git diff <start> HEAD --name-only` 为 QA driver/runner/schema 与其他能力 cases；本卡 10 份审查源 hash 再核对全部未变。已读取相关 native_steps/runner/mouse diff；新的输入设施不提供本卡 W1/W2 采集，不改变产品审查结论。
8. 在最终 HEAD 再运行同一 QA 只读 plan：exit 0、选择 2 例，TC-IDE-C0-01 的 Windows `native_click requires Linux/X11` 仍在；旧 native 运行身份不可冒充新 driver/build。设计、metadata note、identity、P2 交接已分别保留起始与最终 HEAD。

这些检查只证明文档结构、链接和身份自洽；不证明 AC runtime 通过。

## 未执行与交付边界

产品测试 0、产品构建 0、Taomni/browser/native runner 启动 0、开发领取 0、提交/推送 0、其他 agent/P2 启动 0。用户原来运行的 Taomni 窗口没有作为测试目标操作；只在选定 IDEA 窗口中输入。

Taomni 所有 AC/V runtime 结果未执行；Windows QA binary/driver readiness 未核，W1/W2 时点采集和本卡 native testcase 尚待 P2 实现；unknown/late recovery 必须取证。IDEA 内部 write-race 与有效 UI profile 未实采，A2 不得据此签精确 matched。无需用户补任务 ID/范围/路径，当前无待回答的产品目标问题；后续全局桌面输入需要新的可用时段。
