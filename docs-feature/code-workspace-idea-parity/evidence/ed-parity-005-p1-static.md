# ED-PARITY-005 P1 静态记录

**最终状态：P1规划完成，ready/planning_required=false，无开发owner；所有产品验证未执行。** 下文保留首次部分采样与条件性交接的历史，最终检查以末节为准。

日期：2026-09-25。唯一板 `docs-feature/code-workspace-idea-parity/backlog.md`；来源 REQ-05 / CW-LANG-001、CW-LANG-002。

基线：分支 `docs/code-workspace-idea-audit-20260913`；HEAD `8e232d2a3d479c72d325032e5d0c870785039e18`；开始时 `git status --short` 空。历史忽略目录中的IDEA残件另见[参考核对](../references/ed-parity-005-reference.md)，不算本轮采样。没有开发owner/claimed_at/baseline/evidence字段新增。

## 选卡与源码结论

- 实际执行固定路径 `task_board.py --doc docs-feature/code-workspace-idea-parity/backlog.md validate`：OK，9 cards。
- 实际执行同路径 `list --status deferred --json`：005/006/007/008为P1且无板内pending依赖，009为P2；005排首。复核metadata的audit_id、planning_required、REQ/CW及无人领取，选定005后未换卡。
- 当前生产scope/严格文档同步/单dispatch接受及后续保存补全修复已存在，原历史修复不重复安排。D1 resolve原item回退是静态合同缺陷，R1/R2为待归因风险；没有运行复现、没有当前产品PASS。
- [设计](../java-basic-completion-plan.md#ed-parity-005)含独立DEC-01..08、A1..A3、V1..V6及完整[test-cases](../java-basic-completion-plan.md#test-cases)。拟新增case、fixture、controls、单测和nativefault支持均归P2，P1没有修改可执行测试。

## 静态检查及边界

- author后再次运行上述固定板validate：OK，9 cards。
- `git diff --check`：退出0；Git仅提示部分Markdown下次写入可能由LF转CRLF，不是空白检查错误。
- 逐卡比较HEAD与工作区metadata：除005外其余8卡完全一致；005仍deferred/planning_required=true，未写owner/claimed_at/baseline/evidence。
- 新增链接/anchor及路径映射按本次新增Markdown和已跟踪文件diff新增行检查；最终结果见下方补录。规划中的test/case路径按“拟新增”处理，不冒充已存在。

本轮改动限定：backlog.md、capability-matrix.md的CW-LANG-001/002派生摘要、index.md、task-planning.md、references/fixture-catalog.md；新增java-basic-completion-plan.md、references/ed-parity-005-reference.md、本记录及handoff-p2-ed-parity-005.md。没有产品代码、产品测试、测试目录、旧claudedocs任务板或skill脚本改动。没有产品测试、构建、Taomni/browser/native runner、开发领取、提交/推送或agent委派。

## 首时段断点（历史，已由下方第二时段解除）

G1已获用户答复（IDEA2026.2.3）；十分钟真实IDEA采样完成部分G2，完整snippet导航/字体/缩放/边缘参照仍未齐，保持deferred；已按用户后续要求保存[完整条件性P2提示词](../handoff-p2-ed-parity-005.md)，明确前置未解除、禁止领取；不是可立即启动的P2指令。

接续仍是本卡P1：版本决定已处理；旧桌面时段已结束，新输入前需确认新时段，按[准确补采步骤](../references/ed-parity-005-reference.md#capture-gaps)补真实候选/接受/Undo/snippet/UI状态后定稿。完成规划门槛才更新ready并填原P2模板。本轮已采状态见参照observed节；不继承已结束的桌面时段。

### 本轮后续实采与静态补录

用户答复后在10:46:45–10:56:45 +08:00时段内操作隔离IDEA；原件53项及manifest/steps存放忽略目录 `qa-ui-auto-report/idea-reference/ed-parity-005/run-20260925-024645/`。有效类型import/Undo及部分方法接受已记录；IME污染、OS快捷键冲突、设置未定位的样本排除。没有Taomni/provider产品执行。只关闭本轮fixture窗口，未关闭demo-sms。

新增/变更Markdown链接检查首次37项，0错误；五个拟新增YAML ID均未占用，AC与test-cases anchor存在。最终复核继续执行固定板validate、链接/anchor与diff空白检查；静态成功不等于规划ready。

最终新增/变更Markdown本地链接及anchor：38项，0错误；其余8卡metadata未改变，005仍deferred且无开发领取字段。

### 交接落盘复核

已保存完整原P2模板的条件性提示词；9份规划Markdown改动，无产品或可执行测试改动。固定板validate为OK（9 tasks）；显式deferred列表确认005仍不可领取。新增/变更链接及anchor共45项，零错误；其余8卡metadata与HEAD一致；005无开发领取/evidence字段。git diff --check退出0。历史JDT LS trace的append重载只含label/detail、resolve与acceptance为null，不能补足当前snippet精确目标；G2仍待补采。

## 第二时段与最终交接

用户再次授权11:17:01–11:27:01 +08:00桌面时段，必要参照已补采，原件与hash manifest位于 `qa-ui-auto-report/idea-reference/ed-parity-005/run-20260925-031701/`。实际Editor Font/主题/缩放、词中Enter/Tab/双击、方法与inline区别、live template导航和窄窗边缘均已记录。排除错误root文件样本和失焦/过期守卫拒绝的步骤；没有把截图名或模板Undo假设写成PASS。过期后未再发送键鼠，仅关闭自有fixture HWND并核对消失。没有Taomni/provider产品执行。

用户明确选择“保留 provider snippet，明确记录差异”；DEC-08定稿，G1/G2解除。新增DEC-09/D2来自同一Basic Completion词中范围：Rust只保留insert、客户端无intent；明确completion专属可选双range、冻结session intent及共享formatting/rename保护，V2完整覆盖，未改产品代码。

同卡按backlog authoring直接更新ready/planning_required=false（不使用开发claim/update），其他8卡保持HEAD metadata。完成[完整P2提示词](../handoff-p2-ed-parity-005.md)；只有规划就绪，绝非实现/done或功能/UI/交互已对齐。无待用户回答的目标问题；真实provider、双侧比较和三端执行证据由P2按AC完成。

最终静态复核：新增/变更本地链接及anchor共51项，零错误；其他8卡metadata不变；仅9份规划Markdown；5个拟新增case ID未占用，未创建可执行测试；原P2模板“测试用例实现与验证”及后续正文完整保留。固定板validate为OK（9 tasks）；git diff --check退出0。
