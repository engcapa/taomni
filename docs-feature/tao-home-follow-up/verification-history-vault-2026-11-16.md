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

最终 source 的 Windows browser 31 项与 native 41 项（含所有适用 crash）正在执行/准备执行；静态 audit、最终构建和 GitHub Linux/macOS 回执按实际结果继续更新。原生 reload 两项与 history fixture 两项 Python 单测均通过。`pnpm check:refactor` 在本批抽取后通过：855 commands、328 facade exports、39 literal events，944 implementation modules 无逆向依赖或内部循环，4747 files 符合文件大小规则。
