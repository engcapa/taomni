# ED-PARITY-007 P1 静态记录（2026-09-27）

基线分支 `docs/code-workspace-idea-audit-20260913`，HEAD `b3591ae10cd9425e92bf844d7a928c8373ad653c`；接手工作区干净。唯一卡 `docs-feature/code-workspace-idea-parity/backlog.md::ED-PARITY-007`，来源 `AUDIT-20260913-01 / REQ-06 / CW-REFACTOR-002`。没有开发 claim、owner、claimed_at 或 baseline 字段写入，没有启动其他 agent。

文档成果：[设计](../java-extract-method-plan.md#ed-parity-007)、[测试用例设计及待补预期](../java-extract-method-plan.md#test-cases)、[参照与补采](../references/ed-parity-007-reference.md#capture-steps)。**规划未就绪**，保留 deferred/planning_required=true；BL-01/02/03 的准确条件见[ready 阻塞](../java-extract-method-plan.md#readiness)。不生成可立即领取的 P2 指令，不伪造产品 evidence。

## 补采前已执行（历史阶段记录）

| 检查 | 实际结果 |
|---|---|
| 读取 AGENTS、指定 parity/task/backlog-authoring、QA authoring/efficient-verification/regression-protection/verb-catalog | 已读取；另按场景读取 idea-reference、feature-design 及其对应引用 |
| 指定唯一板 `task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate`（开始） | `OK: 9 tasks` |
| 同板 `list --status deferred --json`（开始） | 007 P1、008 P1、009 P2；均无板内 pending dependencies；核 metadata 均有本轮 audit 来源，按板内顺序选 007 |
| 分支/HEAD/工作区 | 上述 HEAD，初态干净；未借历史 owner/status 领取 |
| 只读 production caller/IPC/副作用检查 | Extract Action→session→codeAction/resolve→refactor plan→canonical apply/preview→save/history/recovery；共享 quickfix/generate/organize imports、Rename、Action shell 入口已列入设计 |
| IDEA 安装/进程、JDK 配置、provider jar 只读检查 | IDEA IU-262.10315.125，PID 29264；SDK21 目录存在；本机 JDT LS 1.61.0.202607142124；不代表服务运行或 GUI观察 |
| JDT LS source 阅读 | 下载 `v1.61.0` 两个 Java 源文件到忽略目录，核对默认 edit 与 advanced client command 分支；没有执行 provider |
| 隔离 IDEA 输入离线准备 | 参考 generator 写入报告目录，记录 Java/pom hash 和 `[6:8,7:32)` range；未启动/编译/运行工程，不是产品 fixture 验证 |
| 新 testcase/test 路径查重 | 新 ID `TC-IDE-PARITY-007-01/02/03/04/05/07` 无已有匹配，均标 P2 待实现；未写可执行 YAML/tests/catalog |
| 收尾任务板、链接/anchor、metadata 保留和 diff 检查 | 见本文件下方收尾结果；静态通过不代表 P1目标已齐或产品通过 |

本轮中间检索曾使用 PowerShell 不支持的 brace/path glob，按显式文件或 `rg --files` 修正；历史 006 原件与安装路径读取确认为本机不存在，已记录缺口，未从缺失文件推导通过。

## 补采前未执行与权限边界（历史阶段记录）

产品测试、browser/native runner、Taomni启动、产品构建、真实 JDT LS probe、IDEA GUI输入均 **0**；无提交、推送、P2/其他 agent 启动。所有产品 AC/V 保持 unrun，Windows/macOS/Linux 产品行为均未在本轮验证。IDEA 新桌面时段已询问但未收到答复，未自动激活窗口或解锁。

仅 docs-feature 下本卡文档/关联摘要纳入 diff；忽略目录中的源码副本与离线参考 fixture 不入库。原卡 2026-09-15 audit 日期/HEAD保留，历史 PASS/失败和其他卡 metadata 不改。

## 补采前收尾结果（历史阶段记录）

- 收尾指定板 `validate`：最终 `OK: 9 tasks`。第一次因 validator 只读取本卡 anchor 到下一个显式 anchor 的区间，未在该区间找到 A1/A2/A3 而失败；已在本卡入口补验收索引，完整 AC 仍链接原验收节，未削弱验收；修正后重跑通过。
- `python qa-ui-auto-report/idea-reference/ed-parity-007/check_planning_docs.py`：exit 0，检查 75 个本轮新增文档/新增段落的本地链接与 anchor，0 错误；新 testcase IDs 无重名；原 8 张其他卡 metadata 逐对象等于 HEAD；007 原 audit 不变，且仍 deferred/planning_required=true，无 owner/claimed_at/baseline/evidence。
- 静态脚本确认 tracked diff 全在 `docs-feature/code-workspace-idea-parity/`；没有产品代码或测试修改。报告根中的参考输入与下载源码不入库。
- `git diff --check`：通过，无 whitespace 错误。Git 的 LF→CRLF 工作区提示不是内容/链接错误，没有更改仓库 Git 配置。
- 最终改动为 5 个既有文档（backlog、task-planning、capability-matrix、index、fixture-catalog）和 3 个新增文档（本记录、设计、参考包）；HEAD 未改变。没有 ready/PASS/implemented/done 写入，P2 提示词尚未生成。

校验只证明文档结构与任务板约束；命名/预览目标仍缺真实参照，不能从上述 exit 0 推导规划就绪或产品对齐。

## 2026-09-27 用户授权后补采与当前结论

以上“无时段/GUI 0/缺主链参照”保留为补采前历史，不是当前事实。用户随后明确“沿用本机 IDEA Ultimate 2026.2.2，可独占桌面 10 分钟补采”。实际操作 11:33:41–11:42:16 +08:00（8 分 35 秒）；已归还桌面，只关闭 disposable project。当前目标 IU-262.10315.125，client 1384×984、DPI96、JDK21；原用户 IDEA 工程未关闭。无后续桌面输入。

实采结果：[参考状态和原件索引](../references/ed-parity-007-reference.md#capture-steps)、[原始生成字节](../references/ed-parity-007-reference.md#post-image)。首次 inline 默认 getTotal，可输入 calculateTotal；第二次 Ctrl+Alt+M 更多选项只有 Signature Preview，无独立 diff Preview。非法名禁用 Refactor；重名冲突可取消；inline 双 Esc 恢复原 selection。IDEA 实际运行输出 13:1、exit 0；一次 Undo/Redo 分别恢复 B0/post，显式保存后 hash 证实。空选区在第8行末尾可推断语句，不能写为一律拒绝。

静态校验 `run-20260927-113341/manifest.json` 中 **117** 个已列工件的 SHA-256 全部相符；另核七个 Java snapshot 的 B0/post hash。About 原图含授权个人信息只保留本地，不发布；00-open 不作为有效参照、40-context 不作为菜单证据。参数控件操作、输入 undo/Tab、鼠标 Cancel、破碎选区与窄窗仍未采，不伪造观察。

补充源码核对表明：JDT advanced refactor 可返回 `java.action.rename` 的新文本位置，但默认 edit 不提供 methodName；当前 `renameSymbolAtCursor` 是独立同步/构建/预览/历史流程，document owner 没有 pending Extract 的 begin/commit/abort。直接拼接两次普通事务无法满足本卡取消零效果和一次 Undo。

因此已交付[DEC-02 可编辑图稿](../java-extract-method-options.drawio)及[预览](../java-extract-method-options.png)，展示 A 默认名+完整文件预览与 B 保持 inline 目标，并在聊天询问真实目标取舍。图稿为流程候选，不是产品截图；未启动 draw.io 或浏览器，PNG 从同一节点用 Pillow 生成并查看可读性。此处按照 feature-design 的偏离参照/范围取舍要求询问，未要求用户再填任务 ID/范围/参数表。

**当前规划仍未就绪**：BL-01 已解除；BL-02 是 DEC-02 目标取舍；BL-03 是采用 inline 时的语义命名/临时事务完整合同与必要 P0 范围核定。剩余参考 G1 随目标补采。没有默认接受差异，没有立即领取 P2 提示词，没有自动接续其他卡。完整确定部分用例仍在设计 `test-cases`，未定预期明确列为缺口。

产品测试、Taomni/browser/native runner、产品构建、JDT LS probe 仍全部 **0**。IDEA Run 是用户授权的隔离参照，不是产品测试。无产品或可执行测试修改，无 claim/owner/claimed_at/baseline/implemented/done/evidence，无提交推送或其他 agent/P2 启动。

本次补采后的收尾静态结果：指定唯一板 validate 为 `OK: 9 tasks`；同板 `list --status deferred --json` 确认 007/008/009 仍 deferred，007 claimable=false、owner=null。文档脚本 exit 0，核对 **106** 个新增本地链接/anchor、0 错误，原 8 张其他卡 metadata 等于 HEAD，007 原 audit 不变；6 个拟新增 testcase ID 无重名。`git diff --check` 通过；HEAD 仍为上述 b3591ae，分支不变。当前 5 个既有文档与 5 个新增文档/图稿均位于本专题目录；没有产品代码/测试改动。新增 markdown 的空白与 drawio XML 结构另行静态检查，不运行产品测试。


## 2026-09-27 后续：预先生成 P2 提示词

用户新增要求：“将handoff给p2的提示词也生成（不要限制idea版本，可以是2026系列即可），保存到相应的文件中。”已据原 P2 完整模板生成 [handoff-p2-ed-parity-007.md](../handoff-p2-ed-parity-007.md#p2-prompt)，写死板路径/ID、来源、HEAD/diff、文件责任、DEC/AC/V、测试映射、QA目录维护/运行/回填及三端边界。此前“未生成交接”是前一阶段记录，现由本节更新。

DEC-01 当前目标为 IDEA 2026 系列，不锁 patch/build；已有采样身份与日期保留。版本放宽不推断为接受 DEC-02 方案 A，不续期桌面时段。卡仍 deferred/planning_required=true，没有 claim 或 owner；交接明确前置未满足时只读检查，不自动实施。当前轮仅修改文档，没有产品测试/构建/桌面输入/开发/P2启动或提交推送。

本次实际静态校验：唯一板 validate `OK: 9 tasks`；含新交接的链接/anchor 检查 120 项、0 错误；其他 8 卡 metadata 及 007 原 audit 保持不变，6 个拟新增 case ID 仍未落盘；`git diff --check` 通过。交接沿用完整 P2 模板正文并填写输入，新增前置、路径映射和设施责任；检查无未填的模板输入项。仅文档变更，HEAD 未变。
