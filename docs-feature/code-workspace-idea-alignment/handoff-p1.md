# IDEA Code Editor 对齐续办 P1 交接

从 [backlog.md](backlog.md) 选择一张 `status=deferred` 且 `p0.planning_required=true` 的卡，完成该卡的设计细化；不要领取旧 parity 板的 done 卡。

## P1 必须完成

1. 核对当前 caller、状态 owner、共享消费者和最近源码变化。
2. 复用 [IDEA 实机参照](references/idea-live-audit-20260928.md)，只补该卡缺失的状态；需要新桌面操作时使用隔离 fixture。
3. 写出 DEC、AC、V 和正常/空/加载/失败/取消/恢复路径，分别列功能、交互、快捷键、视觉。
4. 把任务拆成明确文件职责、依赖、保留行为和集成责任，补 `qa-ui-auto-tests/cases/TC-*.testcase.yaml` 计划或链接已有完整用例。
5. 确认当前端 native、browser、unit/typecheck/provider/IDEA comparison 的最小充分组合，并记录 Windows/macOS/Linux 边界。
6. 只有设计、fixture、参照和测试合同齐全时，才把同一卡改为 `ready` 并将 `p0.planning_required=false`；P1 不执行产品实现。

## 固定输入

- Taomni 复核 HEAD：`06ef13d0`（首轮 `ade7da19`）；P1 开始前重新核对。
- IDEA：Ultimate 2026.2.2 / IU-262.10315.125，XWin keymap。
- 实机参照：[references/idea-live-audit-20260928.md](references/idea-live-audit-20260928.md)、[references/idea-control-audit-20260929.md](references/idea-control-audit-20260929.md)（控件级，优先使用）。
- 共享合同：DEC-ALIGN-06（视觉 profile）、DEC-ALIGN-07（keymap 以 IDEA 为准）、DEC-ALIGN-11（Esc 焦点归还）适用于所有卡；DEC-ALIGN-08 待用户确认。
- 目标：功能、交互、快捷键、UI 分开判断；validator 通过不等于 matched。
- 保留：保存、dirty、undo、cancel、recovery、workspace owner、三端兼容。

## 建议命令

```bash
python .agents/skills/code-workspace-idea-task/scripts/task_board.py \
  --doc docs-feature/code-workspace-idea-alignment/backlog.md validate
python .agents/skills/code-workspace-idea-task/scripts/task_board.py \
  --doc docs-feature/code-workspace-idea-alignment/backlog.md list --status deferred --json
```

P1 设计完成后，开发交给 `code-workspace-idea-task`，验证交给 `qa-ui-auto`；不要因为本机 IDEA 参照存在就跳过 Taomni 当前实现和平台证据。
