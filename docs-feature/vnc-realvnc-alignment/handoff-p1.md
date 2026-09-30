# VNC RealVNC 对齐 P1 交接

从 [backlog.md](backlog.md) 选择一张 `status=deferred` 且 `p0.planning_required=true` 的卡，完成该卡的设计细化。

## P1 必须完成

1. 核对当前 caller、状态 owner 与最近源码变化（`src-tauri/src/vnc/`、`src/components/vnc/`、`src/lib/vnc.ts`、`SessionEditor.tsx` VNC 页）。
2. 复用 [RealVNC 实机参照](references/realvnc-live-audit-20260930.md)；需要新观察时按 `.agents/skills/vnc-realvnc-task/SKILL.md` 的采集流程补采，只记录本卡缺失的状态。
3. 写出 DEC、AC、V，以及正常/空/加载/失败/取消/恢复路径；功能、交互、鼠标键盘、性能分开写。
4. 性能相关卡写明回放/实测/代理的具体命令与 RealVNC 对照场景。
5. 把任务拆成文件职责、依赖、保留行为；列出单测、native 步骤和（如适用）qa-ui-auto 用例。
6. 设计、参照与测试合同齐全后，把卡改为 `ready` 并将 `p0.planning_required=false`；P1 不改产品代码。

## 固定输入

- 基线 HEAD：`383aa4f2`（P1 开始前重新核对）。
- 参照：RealVNC Viewer 7.15.1 (r18) Windows 独立版；第三方 RFB 3.7 服务器（18+2，1680×1050，认证后 25 s 才返回结果）。
- 共享合同：DEC-VNC-03（同方法测性能）、DEC-VNC-04（权威帧缓冲 + damage）、DEC-VNC-05（不做 RealVNC Server 专属能力）。
- 保留：已保存会话、vault 密码引用、代理/SSH 跳板、detach claim、view-only 与剪贴板方向的前后端双重执行、三端兼容。

## 建议命令

```bash
python .agents/skills/vnc-realvnc-task/scripts/task_board.py \
  --doc docs-feature/vnc-realvnc-alignment/backlog.md validate
python .agents/skills/vnc-realvnc-task/scripts/task_board.py \
  --doc docs-feature/vnc-realvnc-alignment/backlog.md list --status deferred --json
```

P1 完成后开发交给 `vnc-realvnc-task`（P2 一次一张卡），不要因为参照已存在就跳过当前代码与平台证据。
