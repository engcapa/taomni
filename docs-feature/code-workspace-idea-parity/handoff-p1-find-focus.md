# 下一入口：P1 规划到可开发

将下列完整提示词交给下一位执行者即可。本轮没有启动P1，也没有新任务卡；代码块是下一轮授权范围建议，实际以使用者发送时的指令为准。

```text
你负责把随附 Taomni Code Workspace 范围一次规划到“可领取开发”的状态，不实施产品改动。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI和交互与目标IDEA高度一致；沿用总需求的场景ID和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 工程：D:/code/person/taomni。
- 范围：REQ-01 / CW-SEARCH-001、CW-SHELL-002，拟议 WP-FIND-FOCUS-01：F0 example.txt 正文获焦 → Ctrl+F → 查找tree → 匹配导航 → Esc → 回到同一编辑上下文。CW-NAV-002的modifier-hover与CW-TAB-002的多view是受影响保留消费者。不重做整体P0盘点。
- 目标IDEA：Ultimate 2026.2.2，IU-262.10315.125；安装 D:/Software/idea-2026.2.2.win。旧REF-TREE-2026-09-13只可复用F0项目树子动作，不能代替查找参照。
- 起点材料：docs-feature/code-workspace-idea-parity/index.md、overall-audit-plan-20260913.md、capability-matrix.md、source-audit.md；同目录 references/taomni-baseline-20260913.md、references/idea-comparison-audit-20260913.md、references/fixture-catalog.md、evidence/provenance-20260913.json。
- 当前基线：main / HEAD 27f99b6116f4f6aae906d324cb84e8359695e17a；P0起始工作区干净，随后新增评估文档未提交。接手须记录实际HEAD/diff并保留这些成果。
- 已知反例：2026-09-13本轮browser B08、B18，两次正文获焦后Ctrl+F报 Calls to EditorView.update are not allowed while an update is in progress。堆栈 WorkspaceSearchPanel.mount → lspHyperlink.onBlur → clearMod → view.dispatch。Find面板仍显示，tree查询仍有2 matches；没有正文丢失或native退化证据。
- 原始证据：qa-ui-auto-report/overall-audit-20260913/browser/08-editor-find.png、09-find-results.png、18-find-repro.png、console.log、actions.json及snapshots/；同run artifact-manifest.json。它们被Git忽略，其他机器须取得原件或明确缺口。
- 生产入口候选：src/components/editor/workspace/editorSearchPanel.ts、lspHyperlink.ts、CodeMirrorHost.tsx；只有caller证明必要才扩CodeWorkspaceTab.tsx、公共popup或ActionHost。不要通过吞异常、禁用modifier-hover、移除自动focus或削减原验收规避问题。
- 已有关联：claudedocs/code-workspace-idea-parity-backlog.md 的 ED-FIND-001/002与 claudedocs/code-workspace-idea-specs/search-and-navigation.md 是查找规则的历史来源；没有本次重入修复的可领取ID。还应核对其他focus/hover相关卡和后续修订，不重开done。新board path+ID由P1查重后author，当前未创建。
- 必须保留：保存/撤销/取消/恢复与数据兼容；Find打开可输入，Esc返回正确view/caret/selection；query与匹配规则；Ctrl/Cmd-hover定义导航及modifier释放；只读/IME/多workspace、多pane owner；本包不得削弱共享文档undo或未保存内容保护。
- 参考环境：Windows；Taomni当前证据是Chromium153 / Vite development / React StrictMode / stubs，1400×992 CSS px、DPR1、英文、浅色Follow system、UI Inter12/18、代码CSS13/19.5。没有native证据。IDEA旧参照New UI深色、1400×992、DPI96；完整UI scale、字体、keymap及Project鼠标设置未核实。
- Fixture：F0四文件由 .agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/project_tree.py 的SEED_FILES重建；browser /preview/fixture；本机隔离副本 qa-ui-auto-report/overall-audit-20260913/fixture；hash见fixture catalog。不要把IDEA .idea/元节点计入四文件hash。
- 环境缺口：P0 IDEA启动fixture成功但SetForegroundWindow失败，foreground仍属Explorer，因此未发送桌面键盘/鼠标输入；诊断图不算参照。需要可控交互桌面/可取得目标focus的时段，先重新探针，不自动解锁。src-tauri/target/qa-ui-auto/debug/taomni.exe缺失；P0未构建。本轮计划阶段不默认构建native。
- 已知决定与排除：完整无限插件生态排除；不静默缩小目标语言/平台。没有用户接受的新差异；旧tree局部豁免不扩大到Search。仅细化本连续场景，不换编辑器内核，不实现无关Smart/SSR/Git/Debug。
- 修改权限：允许相关评估/需求/修复设计文档和任务板authoring、可用桌面的最小IDEA采样；不改产品或测试、不领取任务、不改旧任务状态、不提交推送。不启动Taomni/browser/native runner，不运行产品测试/构建；已有反例先复用，若必须新增区分性产品检查须列出具体理由和缺口，不伪造结果。
- 交付位置：继续写回同一capability-matrix.md和overall-audit-plan-20260913.md中的受影响条目；修复设计默认 docs-issue/code-workspace-find-focus-reentrancy-design.md（拟议新文件），参考摘要复用本目录references/，原件保存qa-ui-auto-report/下。

先读取适用AGENTS.md和相关skills。使用 $code-workspace-idea-parity audit/plan；按需使用 $idea-reference 获取真实参照、$issue-design design 形成已有错误行为的修复设计、$qa-ui-auto 判断证据和最小验证选择，并使用 $code-workspace-idea-task 的authoring流程建立或更新工作包。只有新增能力或另立UI重构目标时使用 $feature-design。跨工具的$skill-name表示读取 .agents/skills/<skill-name>/SKILL.md，不是shell命令。不要自行委派其他agent。

记录HEAD、分支和已有工作区改动，保留他人成果。任务板是开发状态唯一来源；索引和设计只保存派生结论及链接。先查已有有效任务、规格、参考和证据，不按日期最新、done数量或文件标题推断状态，不重领或重开done卡来制造工作。

本阶段默认只做源码/文档审查、IDEA参考和qa-ui-auto只读status/plan；不启动Taomni、browser runner或native runner，不运行产品测试和构建。只有检查会实质改变规划结论且本轮输入明确授权时才执行；这里未新增产品检查授权。缺少证据不能被写成已经执行的结果。

只核对选定场景及受影响消费者，从生产入口沿action/store/IPC/provider/副作用到用户观察点确认现状。复用总需求矩阵的稳定ID、三维结论和差异类型。源码存在、任务done、功能测试均不能替代双侧UI/交互比较。

参考不完整时不要停在“建议补采”：在授权且桌面可用时，只采本工作包缺少的Ctrl+F、query输入、Enter/Shift+Enter、Esc及repeat关键状态；记录实际鼠键序列、foreground、caret/selection、原始图和metadata。核对目标窗口、焦点、主题、缩放、字体、keymap和fixture；锁屏不得自动解锁，输入交错或焦点漂移的记录作废。桌面不可用时继续源码和材料工作，明确最小补采步骤、观察点、环境及阻塞AC，不以帮助文档或源码冒充UI观测。

基于参考形成可实施修复设计，区分目标行为与当前异常。写清面板锚点/布局、focus、caret/selection、modifier、加载/失败、取消和迟到结果/销毁时序。尺寸和容差来自匹配环境；没有观测的视觉目标保留待采。结构或主流程明显变化时按相关skill提供可审阅图稿或原型。实质产品取舍列候选、推荐和影响，普通细节自主收敛。

最后author一个小而可演示工作包：准确任务板路径和ID、用户结果、REQ-01-F/I/V/R对应的稳定AC/V、保留行为断言、生产owner/共享消费者、依赖/接口、错误/取消/迟到结果/恢复语义、三端要求与最小充分验证。现有反例原图/日志和旧结论依据保留。没有解决的参照/依赖不能伪造ready；不得领取任务或改产品，不把计划检查写成已执行。

最终交付可直接给P2的接续包：
- 范围、HEAD、相关工作区变化；生产入口和当前差异；
- IDEA参考/原件准确路径、适用环境与缺口；
- 修复设计、DEC/AC/V、必须保留行为；
- 准确board path、首个可推进ID、依赖及owner；不具备条件则明确阻塞AC；
- P2文件范围、第一步、最小验证集合；使用 docs-feature/code-workspace-idea-parity/agent-collaboration-prompts.md 的P2完整提示词填好已知材料，在聊天返回完整可复制代码块；
- 仍需外部提供的条件明确列出，不让人工重组公共前提。

不要自动启动P2、提交、推送或发布。
```
