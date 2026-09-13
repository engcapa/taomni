# Code Workspace IDEA 总需求与评估入口

本入口按用户请求于 2026-09-13 首次建立。目标是功能、视觉与交互高度一致，当前布局不作为保留约束。任务板仍是开发状态唯一来源；本目录不维护 owner/ready/done 流程。

本轮：`audit/plan` 整体 Code Workspace，仅评估及需求文档；不实施产品、测试、任务状态、提交或推送。起始分支 `main`，HEAD `27f99b6116f4f6aae906d324cb84e8359695e17a`，起始工作区干净。

## 有效材料

| 材料 | 作用 |
|---|---|
| [总需求 / overall audit plan](overall-audit-plan-20260913.md) | 目标、45场景分母、需求排序、增量、首包与待决条件 |
| [唯一整体能力矩阵](capability-matrix.md) | 45个稳定场景的功能/视觉/交互独立结论、入口/调用链、证据/当前性、需求/验收与历史任务映射 |
| [当前Taomni基线](references/taomni-baseline-20260913.md) | 先打印的真实UI、21张browser截图、实际步骤、焦点/异常/取消/恢复与缺失状态 |
| [IDEA复用与对照摘要](references/idea-comparison-audit-20260913.md) | 目标IU-262.10315.125、有效旧tree参照、本轮新采样阻塞、双侧局部差异 |
| [fixture目录与平台/语言边界](references/fixture-catalog.md) | F0实采字节；F1–F5未执行的补采规格与条件 |
| [当前生产源码审查](source-audit.md) | 每域caller/owner/IPC/provider与旧线索纠正依据 |
| [证据身份](evidence/provenance-20260913.json) / [源码映射](evidence/source-map-20260913.json) | HEAD、source/runner/case/build/config/mode、原图hash与current/historical/stale/unverified依据 |
| [下一入口P1完整提示词](handoff-p1-find-focus.md) | 首包Find焦点生命周期的可复制交接；未启动下一角色 |

## 本轮结论

45场景 / 11域 / 135个三维格；16场景有本轮局部实际UI记录，29场景仍需按矩阵补采。只有项目树方向/Enter等子动作有可复用双侧依据，完整三维通过0、关闭差距0。没有总体对齐百分比。

新事实：Ctrl+F两次触发CodeMirror更新重入异常（REQ-01）；Enter打开文件后Taomni仍树焦点而IDEA进入editor（REQ-02局部）。21张current浏览器原图不是native证明；历史Windows tree native报告为stale，原因是source/runner/build identity变化。IDEA新交互采样因前台激活失败缺失；旧08:31–08:36参照仅在其原范围复用，不刷新日期。

总需求新增REQ-01..11，重点区分确认browser缺陷、静态引擎缺失、体验差异、纯证据缺口与待归因风险。旧任务done不作为完成依据，旧修复规格保留；没有新建owner/ready/done流程，没有改任务板。

## 历史材料与接续规则

原 [project-tree E2E](skill-e2e-project-tree.md)、[tree参照](references/project-tree-navigation-2026.2.2.md)、[tree任务板](../../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) 仍保留原合同与日期。`claudedocs/code-workspace-idea-2026-*-capability-matrix.md` 是各轮原范围的历史发布/修复汇总，不与本总矩阵竞争开发状态来源；每场景的具体关联板/ID见矩阵。

接续先核对本轮HEAD及source/caller、目标设置、fixture、case/runner/build/mode变化。只重判受影响项；无变化项保留本次2026-09-13日期，不补签新PASS。新增/拆分/合并/移出场景必须记录ID映射及分母变化；用户未明确接受的差异不能关闭。开发卡始终从原任务板读取，新的差距经P1查重/设计/author后才进入开发。

本轮原件位于本机 `qa-ui-auto-report/overall-audit-20260913/`，历史IDEA有效原件位于 `qa-ui-auto-report/project-tree-e2e/idea/`。均被忽略；其他机器须取得精确原件或补采，不能仅凭摘要继承通过。
