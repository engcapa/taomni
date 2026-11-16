# Home 历史删除与可取消的 Vault 提示

本批继续使用 `feat/tao-home-follow-up`，承接按钮覆盖补充；用户最新反馈优先于原型。新增两项：历史中的 Tao Home / 旧 tao-chat 对话可删除且需确认；未设置密码或未解锁时可取消遮罩并继续使用其他功能。

## 行为与边界

- 历史列表每条 Tao 对话增加独立垃圾桶按钮与 tooltip。确认弹窗显示选中标题；取消按钮或 Escape 都保留记录，Escape 先关闭确认层，再次按才关闭历史。演示模式的确认文案使用匿名标题。
- 删除请求由原始存储所有者处理：Home 使用 `deepseek_app_delete_thread`，旧 tao-chat 使用 `chatStore.deleteThread` / `chat_delete_thread`，不把旧资料迁移到 Home 表。失败保留记录并显示可重试错误；流式回复、执行/撤销进行中不能删除，删除期间不能重新发送或重复删除。
- 按线程串行化自动保存和删除，等待已发出的保存结束后再删除，后续旧快照不能把记录写回。删当前记录后恢复另一个 Home 对话及草稿；删最后一条后建立空白对话；删除其他记录不改变当前草稿。
- 首次未设置 Vault 时 Home 无需主密码；设置弹窗原有取消/Escape 继续保留。启动时的检查遮罩和解锁弹窗允许取消；延迟的检查结果不会重新挡住界面，也不更改用户选择的启动提示模式。
- Tao 流遇到 Vault 锁定后的遮罩增加“暂时跳过”，关闭后在对话内保留解锁入口；已有内容与草稿保留，可操作新建、历史和 Settings。原线程仍处于 `vault_locked`，不绕过凭据保护，不自动重试或续写；显式解锁成功后仍等待用户继续。
- 从已有 Welcome 恢复场景复用测试，实际点击 Tao Home 历史 footer；空/不可用/恢复中时禁用入口，重复恢复复用已有 pane/tab。

持久化所有权抽到 `threadHistoryStorage.ts` / `useThreadHistory.ts`，包含加载、保存订阅、按线程队列、删除、失败恢复及 effect 清理。Controller 与公开 IPC/存储格式保持兼容。没有新增外网请求或下载。

## 用例与验证

| 用例 | 断言 |
|---|---|
| 035，browser/native | 删除按钮、确认、取消、Escape 所有权、删除当前/最后一条后仍可操作 |
| 036，native | 隔离 DB 中非空 Home / 旧 tao-chat，按原始路径删除；重载后两条已删记录不返回，其余正文保留 |
| 037，browser/native | 空 Vault 可用 Home，设置取消/ Escape，初始化/锁定/重载后取消启动解锁，保护功能仍受 gate 限制，再显式解锁 |
| 009，native，扩展 | 真实 HTTP 被锁定中断后，跳过遮罩、切换并返回原线程、继续保留草稿和正文；服务端请求数证明无自动商业式重试 |
| WELCOME-RS-02，browser，更新 | 复用现有文件夹快照，从 Home 历史恢复实际目录；重复操作仅一个 tab |
| WELCOME-RS-N-04，native，更新 | 复用保存的本地 shell，从 Home 历史恢复并定位实际 terminal；重复操作仅一个 tab |

前端 22 个相关测试文件 / 123 项单测通过；补充组件焦点与类型修正后的定向验证另记录。新 fixture 的两项 Python 单测确认只写入当前 QA 隔离目录及原始两类表，并在完成后释放 SQLite 句柄。

第一次 browser 探针中 035 通过，037 在最后搜索检查误用了 `tao-home-search-dialog`；失败截图实际显示正常打开的 Tao 搜索。现复用已有 `tao-home-search-panel` 契约，037 独立复跑通过；保留原失败目录，不更改产品搜索行为。最初 unit 误写匿名英文标题 `Conversation 1`，产品字典为 `Chat 1`，现按真实文案检查；该测试只验证匿名化，不验证模型措辞。

日志与回执均保留在 `qa-ui-auto-report/_local/`。本轮前的 Windows 27/36 和 hosted 批次只证明其对应的旧源码；本批产品改动后必须以新 source/runner/case 与匹配 QA release 重新取证。完整 crash 与 Linux/macOS hosted 最终结果待写入，不以 dry-run 或排队通过替代。

启动检查长时间阻塞后的取消目前用受控延迟的组件单测验证；没有强行延迟真实 native Vault 状态服务，不将此项写作已实测的系统故障。商业 OpenCode 运行仍受已记录的自动审批拒绝限制，不属于本批无商业 Key 的确定性验证。

## 后续回归诊断

Windows 首个匹配构建的新增原生批次为 **6/6**，无跳过：`qa-ui-auto-report/_local/tao-history-native-target-1116/run-20261116-174248-265469800/`。035 确认框截图已检查：标题和不可撤销说明完整，取消/红色删除按钮可见，历史行垃圾桶独立于打开动作。036 确认删除两类非空资料后重载只保留预置正文，037 验证跳过启动解锁后 Home 可操作、MFA 仍受保护，最后显式解锁。此回执早于以下 ribbon 改动，最终验证使用新匹配构建。

旧 hosted 运行 [43831374934](https://github.com/engcapa/taomni/actions/runs/43831374934) 已结束：Linux/macOS browser 各 27/27，Linux native 35/36、macOS native 34/36，最终汇总为失败。027 两平台的实际 ACP peer 已收到原始目标和历史，未收到私有草稿；失败时抽屉却显示默认 OpenCode 的空白对话。008 macOS 在 seed/reload 后未展示预置最近工作区；原失败、截图、peer 回执与紧凑诊断保留，不能当作通过。

检查 ribbon 生命周期发现待执行的悬停 timer 只在组件卸载时取消；抽屉由交接动作打开后组件返回 null，但未卸载，timer 仍可打开默认线程。新增回归先得到 **2 failed / 1 passed**，修复为在抽屉、活动 tab 和停靠状态变化时释放 timer，回调另核对当前抽屉状态。修复后 ribbon、ChatDrawer 与 HandoffControls 共 **3 files / 39 tests** 通过；日志 `tao-ribbon-baseline-1116.log` / `tao-ribbon-fix-1116.log`。这证明竞态已修复；027 的跨平台最终结果仍须新回执确认。

原生 reload 原实现依赖固定两秒等待，旧文档中的 Welcome 仍可误判就绪。将该职责抽到 `native_reload.py`，以当前文档 sentinel 消失、document complete 和新 shell 同时满足作为就绪条件；导航期错误在原 deadline 内重试。两项工具单测验证旧 shell 不会提前成功和超时不报告通过。008 增加 seed 后、reload 后 localStorage 内容断言，以区分持久化丢失与渲染问题；没有降低工作区标题、绑定或引用断言。

复用 WELCOME-RS-02 的历史分类切换场景：目录→最近会话仍保留恢复入口，恢复实际文件夹且重复操作不新增 tab。新 restore browser 已通过；保留 F1.6 语义 aliases 并补实际交互，不降低覆盖基线。

最终 source 的 Windows browser 31 项与 native 41 项（含所有适用 crash）已执行完成，准确回执与评审口径见下节；GitHub Linux/macOS 回执按实际结果继续更新。原生 reload 两项与 history fixture 两项 Python 单测均通过。`pnpm check:refactor` 在本批抽取后通过：855 commands、328 facade exports、39 literal events，944 implementation modules 无逆向依赖或内部循环，4747 files 符合文件大小规则。

## e7e73cc01 当前输入的执行记录

本轮输入身份：source `85c9edbb9fc5da39aa5ab25b843698ea052c1624f3a6724f963188918fbb2404`，runner `5c090ce8646aa0c10010b06f4cdff6ee7a65381d07602d3cc1247c39aae25fed`。Windows QA release 的 binary SHA-256 为 `f9844915f2d7a29d8a7a6b7504b5f9e2bae216221c8c13f7b413389641d964b9`，应用 ID `com.taomni.app.qa`，隔离数据目录。

- Windows browser **31/31**，含完整适用 crash **18/18**；目录 `qa-ui-auto-report/_local/tao-history-full-browser-1116/run-20261116-174731-946306800/`。恢复入口 scoped selector 最终调整后另 **1/1**，目录 `tao-history-restore-browser-r2-1116/run-20261116-175101-245328200/`。两批 source/runner 均稳定。
- Windows native **41/41**，含完整适用 crash **22/22**，无失败或跳过；目录 `qa-ui-auto-report/_local/tao-history-full-native-1116/run-20261116-175434-677299700/`。035～037、009、008、027 及真实 Shell 恢复均通过。全部原始 receipt 签名、逐项产物哈希、source/runner/case/build 身份独立核对通过；记录 `tao-history-full-native-1116/independent-feedback-verification.json`。本批 035 确认框与 037 最终显式解锁截图已检查。
- frontend 22 files / 123 tests、后续焦点/startup 2 files / 12 tests、ribbon/ChatDrawer/handoff 3 files / 39 tests 均通过；批次有重叠，不相加成独立测试总数。Python reload 与历史 fixture 共 4/4；TypeScript、最终 QA release 构建、refactor、development case contract 和最终静态 `audit --gate` 通过。audit 日志 `tao-history-audit-final-r5-1116.log`；原 F1.6 控制覆盖基线保留。
- GitHub [43844045720](https://github.com/engcapa/taomni/actions/runs/43844045720) 在 checkout 阶段把缩写提交号当作分支名而失败，未执行测试。已改为完整 SHA，重新发起 [43844434828](https://github.com/engcapa/taomni/actions/runs/43844434828)，规划成功，Linux/macOS browser/native release 正在执行；显式选定当前 Tao 确定性集、035～037、历史恢复及 Vault 保留用例，并自动合入完整适用 crash。

43836152729 的历史定向批次已独立核对：Linux/macOS browser 各 19/19、native 各 24/24，receipt 签名、逐项产物、历史 Git source/runner/case 均匹配。此结果仅用于该历史批次，不覆盖上述新输入。


Windows 逐条合并最新匹配回执：已评审场景为 **browser 31/31、native 40/40**，包含全部适用 crash；`status --gate` 为 `ok=true`、0 gaps、0 rejected reports，记录 `qa-ui-auto-report/_local/status-tao-history-windows-reviewed-1116.json`。browser 使用 17:47 整批以及 17:51 恢复用例的新回执，单项旧 case hash 不充当当前通过。

额外执行的旧 `TC-auto-F12-1-vault-setup-and-lock` 实际通过，但其 `verification.review: reviewed` 与 `needs-review` tag 冲突。含该旧用例的全量 Windows status 因一项评审元数据缺口未过 gate（没有执行失败，0 rejected reports）；原记录 `status-tao-history-windows-final-1116.json` 保留。**测试待办**：复核该旧用例的状态等待、需求契约与截图，统一评审元数据并以新 case 指纹重新执行。此次新增 037 已覆盖初始化、锁定、取消及再次解锁的真实用户流程；不通过删除旧 tag 将旧结果直接变成当前验收。

## ACP 消息加载竞态回归

43844434828 的 macOS 027 仍未通过：真实 peer 收到正确交接内容，抽屉已选中 ACP provider，但正文为空；不能把子进程收件当成用户流程通过。补充只读 SQLite 诊断并在匹配 Windows QA release 上复跑 027 通过；跨平台诊断运行 [43853464081](https://github.com/engcapa/taomni/actions/runs/43853464081) 固定 `c338784d1`，保留修复前产品输入。

受控延迟的 store 回归复现了独立的消息加载竞态，基线 **4 failed / 1 passed**：旧的空历史读取覆盖已完成的真实流式事件、并发旧读取覆盖新读取、删除后旧读取重新写入缓存，新线程也会触发不必要的空历史查询。`threads.ts` 现在为每条加载保留请求所有权并核对消息数组版本；删除释放所有权，新线程初始化空缓存，正常历史刷新仍保留。修复后 chat store、ChatDrawer 与 HandoffControls 共 **4 files / 80 tests** 通过。该竞态与 hosted 症状相符，最终平台因果判断仍等待 native 复验，不用单测替代真机结果。

027 沿用实际 UI→ACP 子进程→带回 Tao→显式继续流程，补充真实隔离库中 user/assistant 两方持久化断言。只读诊断仅记录角色、长度与 fixture 标记，不记录对话正文、凭据或替换 UI 成功断言。产品源码已变化，先前 e7 批次保留其原有输入身份，不能充当此修复的当前通过证据。
