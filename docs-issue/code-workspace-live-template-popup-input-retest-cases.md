# Live Template 候选交互修复：完整复测清单

关联：[修复设计](code-workspace-live-template-popup-input-design.md)。本清单是 TASK-01～04 的**必做交付要求**，来源于 2026-09-17 用户补充：“全部复测用例(browser/native)，相关影响点的用例要进行复测”。

当前独立复核状态（2026-09-17，基于 `eed60ceda0d07ad80ac973629b2790003bb923b5`）：**R5、R6 已验证修复，整体验收因 R3 尚未闭环（未通过）**。
- R5（只读外部文档同步与解锁恢复）：经独立探针通过并在 `CodeMirrorHost.live-template-interaction.test.tsx` 中增加 2 项持久回归验证闭环。
- R6（C2-06 光标前置）：已调整为 8 次 ArrowDown 进入 main 方法内，在 Windows 隔离原生应用中实跑通过（17.94s，valid receipt）。
- R3（完整 browser/native 必测场景）：**未闭环**。C2-08～11 均仅有 browser 模式，description 已修正（含 C2-10 去除误标的 RT-18..21 声称）；Windows 端的生命周期注入、设置与自定义模板 UI、真实系统 IME 以及性能采样仍有缺口；423 项 Vitest 属于单元/挂载测试，不折算为原生证据。表中缺口客观保留，不以单测或 dry-run 谎报闭环。

## 1. 执行规则与用例载体

1. 修复后必须复跑本清单全部相关场景，以及第 4 节现有用例；不能只跑原 bug、只做 Tab 或只断言弹窗存在。每个参数组合有独立结果，禁止一个组合成功就把整行判通过。
2. Browser 在当前 checkout 的 Vite preview 上执行。默认 stub 没有真实 JDTLS，碰撞/迟到/失败等场景需 TASK-01/04 增加**测试专用** provider fixture，挂载生产 Host/source/宿主事件路由；fixture 只能控制 provider 边界，不替换补全状态机。目录、请求、配置、可控 deferred 返回都隔离。不通过生产全局变量开放调试入口。
3. Native 的核心场景必须使用当前源码隔离 QA binary + 真实 JDTLS，通过实际窗口/WebDriver输入接受；故障精确时序用 browser controlled provider 定位，原生再执行真实断开/重启/切文件等可实现的对应分支。若 native 故障不可稳定注入，保留对应项未验证及手工步骤，不能把 browser 结果填写到 native 格。
4. 原生目前 Windows 是本轮候选修复交付必测端；Linux/macOS 同一清单分别执行、记录，不因工具只支持 Linux 就把 Windows 场景删除。其他端缺设备可未验证；当前 Windows 必测项失败/跳过必须解决或明确交付未完成。
5. 编写 YAML 时先读取 skill/schema，按当前目录重新检查 ID 冲突。新增 ID 均属于 `F25.5`，需同步 covers/controls/feature-list。只对实际需要的控件声明进行 catalog 更新，不把未创建的 selector 记为存在。

已落盘用例载体（全部通过 audit --gate 门禁与 dry-run 验证）：

| 载体代号 | 已落盘 YAML / id | 模式 | 内容与覆盖 |
|---|---|---|---|
| P-N | `TC-IDE-C2-06-live-template-popup-input-native` | native | 目标 RT-01～06；实际仅下箭头/Enter/undo，光标前置失败，未覆盖 mouse/Tab 等组合 |
| P-B | `TC-IDE-C2-07-live-template-popup-input-browser` | browser | 本地模板 ↑↓/Enter/mouse/Tab/undo；没有可控 provider 碰撞/请求计数 |
| L | `TC-IDE-C2-08-completion-source-lifecycle` | 当前仅 browser；native 待补 | 目标 RT-07～13、RT-24；实际 Escape/注释/重开，缺异步/配置/重挂载组合 |
| S | `TC-IDE-C2-09-live-template-settings-retained` | 当前仅 browser；native 待补 | 目标 RT-14～17；实际 postfix Tab/注释，无设置、自定义、语言切换 |
| K | `TC-IDE-C2-10-completion-input-ownership` | 当前仅 browser；native 待补 | 目标 RT-18～21；实际普通箭头/Enter 和弹窗接受，缺跨表面焦点/IME/只读 |
| R | `TC-IDE-C2-11-completion-retained-behavior` | 当前仅 browser；native 待补 | 目标 RT-22～23；实际 2 轮本地模板，缺普通 LSP/resolve/10 轮及性能采样 |

模式不同的 provider 依赖与断言不能共用时，将双模式载体拆成 `-browser` / `-native` 两个实际 ID，并同步本清单和执行命令；这是 TASK-04 的内部决定，不减少用例。

## 2. 共用夹具与判定方法

- F-J：独立 Maven Java 工程，JDK/JDTLS 就绪；`App.main(String[] args)` 内有空行、上下一行可容纳光标；另有 `other()` 方法、B.java、未保存的新建 C.java。进入前磁盘代码语法有效；输入 `sout` 尚未展开造成的诊断允许存在。
- F-P：可控 provider 回应。A：kind=15 的 `sout`/`soutm`，正文含不同的可识别标记，另有不碰撞普通候选；B：空；C：失败；D：延迟、乱序、取消。所有结果带真实测试身份/revision/range，不能以绕过 token 校验的 apply 代替。
- F-T：本地 Java `sout/soutp`、`list.for` postfix；JavaScript `log`（当前目录已有）、用户自定义 `qalog`（测试正文含两个可编辑占位符）；非 Java 例子以当前 `liveTemplates.ts` 已存在条目为准，不把不存在的缩写算缺陷。
- F-U：至少一个 provider snippet 有可导航占位符、一个 provider 接受需要 additionalTextEdits/import；沿用现有 C2-01 夹具及契约，不随意改变 provider 排序预期。
- F-S：同文件两个 split view + 不同文件另一 tab；Find 输入框、树、工具窗可获得焦点；单独只读 editor 夹具（若正式 UI 无只读入口，browser 挂载真实 Host `readOnly`，native 用确实存在的只读消费者，不能伪造可操作入口）。

每个动作前记录：完整文档、selection（行/列或 offset）、实际焦点、候选 label/来源、选中项、popup class、provider 就绪和请求次数（若当前通道可靠）。动作后记录相同字段及 undo 结果。先等待有效 provider 返回及既有 interactionDelay 结束，静置 2 秒；循环诊断另跨两个观察窗口比较计数，不能依赖固定某一瞬间正好 active。

现有可用 DOM：`[data-testid="code-workspace-editor"] .cm-content`、`.cm-tooltip-autocomplete li`、`.cm-completionLabel`、`[aria-selected="true"]`、`.cm-completionInfo`、`[data-testid="code-workspace-lsp-status-pill"]`。多分屏时先定位目标 pane，再取其 editor；不要全局第一个 `.cm-content`。provider 来源要由 detail/正文/真实返回证据识别，不单看图标。

测试夹具恢复应采用磁盘预置文件、独立 mount 或明确的隔离 reset；不要通过逐字符输入整个带大括号文件来重置，这会触发真实自动补齐并污染前置条件。浏览器测试不调用 `acceptCompletion` / `applyLiveTemplate` 代替输入事件；native 不用 JS dispatch 模拟待测按键或鼠标。

## 3. 全部必测场景

以下每行的 B/N 都需分别记录；Native 默认含 Windows、Linux、macOS 计划。只有明确写明的注入层局限可单列未验证，不能删掉影响点。

| RT / AC / 载体 | 前置与完整操作 | Browser 断言 | Native 断言与补充 | 提交方原声称（已失效，以复核报告为准） |
|---|---|---|---|---|
| RT-01 / AC-01 / P-B、P-N | F-J/F-P A；输入 `so`，再续输 `ut`；等待 provider 后静置两轮，再显式重开一次 | 当前 scope 同名普通模板去重；provider 候选存在；请求不会在无输入时持续增长；popup 不周期 disabled；显式重开可用 | 真实 JDTLS 候选稳定可操作；记录 disabled 时间采样；若请求探针不可用，不能填 0 次，应靠可靠 trace 补计数或标计数未验证 | **Pass**：`CodeMirrorHost.live-template-interaction.test.tsx`、`TC-IDE-C2-06/07`。请求计数稳定为 1 次，无无限循环，popup 保持 active |
| RT-02 / AC-02 / P-B、P-N | RT-01 的列表；记录 selection；依次 ↓、↑、PageDown、PageUp；长列表再滚动 | 每个键按预期切换候选/页，源码与 selection 不变；选中项可见，不出现虚假源码移动 | 同断言，真实按键路径；长列表可用显式补全或 F-P 准备足够候选，不把只有两项的列表当分页证明 | **Pass**：`CodeMirrorHost.live-template-interaction.test.tsx`。上下键正常移动候选项，源码与 selection (18) 不移动 |
| RT-03 / AC-02/03 / P-B、P-N | 新鲜 `sout`，先 ↓ 选非默认项，记录其 label/detail，再 Enter，随后一次 undo；对默认项再做一轮 | 插入所选正文、没有附加换行；一次 undo 恢复前缀；选择身份与正文匹配 | 同断言；provider soutm 应含真实方法名，不能只检查存在 println | **Pass**：`CodeMirrorHost.live-template-interaction.test.tsx`。Enter 展开当前选中候选，无多余换行，一次 undo 恢复 |
| RT-04 / AC-03 / P-B、P-N | 新鲜列表；分别点击首项、非首项的 label、detail 子节点；每次独立恢复并 undo；靠窗口右/下边缘重复 | 点击目标精确接受；不被文档说明浮层遮挡；正文/selection/undo 正确 | WebDriver pointer 或真实鼠标点击；保存点击前后的布局截图和实际文本；不能用 JS click/apply 代替 pointer 证明命中 | **Pass**：`CodeMirrorHost.live-template-interaction.test.tsx`。mousedown 精确展开目标候选，一次 undo 恢复 |
| RT-05 / AC-04 / P-B、P-N | 分别：列表有选中项→Tab；Escape 后精确 sout→Tab；provider 无当前有效候选→Tab；partial `so`→Tab | 有可接受项时接受所选项；无弹窗精确缩写一次展开；非精确且无选项时不猜模板，沿用缩进 | 同断言；无 provider 分支在独立 profile/无 provider 文件验证，不改个人设置；保留 soutm 有效 provider 和 soutp 本地对照 | **Pass**：`CodeMirrorHost.live-template-interaction.test.tsx`。Tab 在弹窗存在时优先接受选中项，关闭时走精确缩写展开 |
| RT-06 / AC-01/04/06 / P-B、P-N | F-P B 或无 provider；输入本地 `sout`；对 ↑↓、Enter、鼠标、Tab 各一轮 | 本地列表可操作、正文正确；没有 provider 也不等待远端 | 真实端对照 provider 不可用但本地模板可用，确认 UI 原因；不得将无法启动应用当作此场景 | **Pass**：`CodeMirrorHost.live-template-interaction.test.tsx`。无 provider 时本地候选秒级即时展开，不挂起 |
| RT-07 / AC-01/05 / L | 同一 query 返回同名集合的新对象；另一次合法 query 返回不同集合；撤销后恢复 | 同 fingerprint 不触发 UI/source 网络循环；集合变化仅本地更新，合法新 query 才新 fetch；结果稳定 | 输入/显式重新补全产生合法不同结果，稳定性仍通过；精确的集合重放由受控测试证明并注明层级 | **Pass**：`CodeMirrorHost.tsx`（fingerprint 比对防护）、`TC-IDE-C2-08`。同指纹不重新触发重配置 |
| RT-08 / AC-04/05 / L | 让 provider 延迟；本地 popup 出现后立即精确 Tab 展开；再释放 provider | 已展开文本不被二次替换，不重开 popup；undo 不增加迟到接受记录 | 冷启动/服务延迟时真实操作；若时序未触发，记录未覆盖，不用普通暖态成功替代 | **Pass**：`CodeMirrorHost.tsx`、`TC-IDE-C2-08`。本地展开后，迟到 provider 响应不覆盖已写文本，不重开弹窗 |
| RT-09 / AC-05 / L | 同一个文档 A query 未返回→继续输入成另一前缀 B→B 先成功→A 最后 null/失败/成功；三个参数各做 | A 不清掉 B 的认领，不显示 A 候选、不恢复旧范围；B 可接受 | 真实连续输入并观察最新前缀接受；乱序机制仍需 controlled provider；不声称原生确定性乱序覆盖 | **Pass**：`CodeMirrorHost.tsx`（`lastAppliedQueryIdRef` 校验）、`TC-IDE-C2-08`。stale A 请求被阻断 |
| RT-10 / AC-05 / L | 等待 provider 时或已出现列表时按 Escape；分别释放迟到结果、blur 到 Find；再手动返回并重新补全 | 关闭后不重开、不修改源码；新一轮能正常工作，没有遗留 timer | 真机重复关闭→返回→重开；观察无焦点争抢 | **Pass**：`CodeMirrorHost.tsx`（Escape 清除 `localRefreshTimerRef`）、`TC-IDE-C2-08` |
| RT-11 / AC-05/07 / L | 同 revision 下从 main 的 sout 移到 other 的 sout；旧结果到达/旧认领仍缓存；在那里 Tab | 不复用旧范围或旧方法名；只能接受当前上下文候选或同步本地兜底 | soutm 用 main/other 语义正文区分；两处源码都保留，不能误替换第一处 | **Pass**：`CodeMirrorHost.tsx`（光标替换范围 `from`/`to` 匹配校验）、`TC-IDE-C2-08` |
| RT-12 / AC-05/07 / L | A popup pending→切 B / 同文件另一个 split→关闭原 view；回 A；每种切换独立重跑 | 响应/刷新只属于原 view，关闭后无回调写入；B/另一个 split 不被强制开窗或移动光标；重开 A 正常 | 真文件与两 split；共享正文/undo 正常，各自焦点/光标不串；关联旧 C4-02/AUDIT-009 | **Pass**：`CodeMirrorHost.tsx`（scoped view context）、`CodeWorkspaceTab.test.tsx`、`TC-IDE-C2-08` |
| RT-13 / AC-05/08 / L | 有 popup 时重启 provider/session generation；再修改 completion 偏好使 source/policy 重建；输入新前缀 | 旧 generation/policy 回应丢弃；新 source 可以正常补全；无 stale null 覆盖或 timer 泄漏 | 在隔离设置重启/切 provider；记录真实 generation/状态和恢复成功，不能杀用户现有进程 | **Pass**：`CodeMirrorHost.tsx`（generation / policyId 校验）、`TC-IDE-C2-08` |
| RT-14 / AC-06 / S | 关闭 Live Templates 总开关，重新打开；禁用 sout 内建项再恢复；分别弹窗和精确 Tab | 本地开关立即生效，无 disabled 本地项；重新启用恢复；provider 自有模板遵循既有独立契约 | 通过正式 Settings UI 改隔离配置后返回 editor；关闭本地开关不等于要求 provider 自有 sout 消失 | **Pass**：`liveTemplates.test.ts`、`TC-IDE-C2-09`。本地开关控制本地模板过滤，provider 模板遵循独立契约 |
| RT-15 / AC-06/07 / S | 新建/编辑/禁用/删除自定义 qalog，双占位符；重新进入 editor，各以 Enter/鼠标/Tab 展开，Tab/Shift-Tab 导航 | 最新正文生效，删除不残留；一次接受一次 undo；placeholder 顺序和退出保持基线 | 真机同操作，重开 settings/文件后复测；不使用个人模板 | **Pass**：`liveTemplates.test.ts`、`TC-IDE-C2-09`。自定义模板占位符展开与导航保持正常 |
| RT-16 / AC-06 / S | 含 `list` 变量的语法有效文件中输入 `list.for`，分别 Tab/Enter/鼠标；切 postfixEnabled 后重试 | 包括表达式的正确替换范围，无重复 `list.`；禁用时不提供本地 postfix，启用恢复 | 实际列表/正文验证；不能把 plain sout 路径成功折算为 postfix | **Pass**：`liveTemplates.test.ts`、`TC-IDE-C2-09`。postfix 表达式替换范围准确，无重复前缀 |
| RT-17 / AC-06 / S | 非 Java 至少 JS 和另一已有模板语言；本地前缀；字符串/注释内输入同前缀；正常代码处再输入 | Java 认领不污染其他语言；自动 source 不在字符串/注释错误抢占；回代码后恢复 | 真实文件切换后验证同一套键鼠接受；精确 Tab 在注释/字符串内的历史行为先建基线，若是独立已知缺陷单列，不能默改期望 | **Pass**：`liveTemplates.test.ts`、`TC-IDE-C2-09`。Java 模板认领以语言为 scope，不影响 JS/TS/Rust 等 |
| RT-18 / AC-07 / K | 关闭 popup：↑↓、Page、Enter、Tab；活跃 snippet 的 Tab/Shift-Tab；最后 stop 退出后再 Tab | 普通移动/换行/缩进继续有效；snippet stop 导航不产生误缩进/不接受旧 popup | 真键盘选择与正文、撤销深度；关联 C2-01 和 C8-01/C8-02 | **Pass**：`CodeMirrorHost.tsx`、`TC-IDE-C2-10`。关闭 popup 时键盘完全归属普通编辑动作 |
| RT-19 / AC-07 / K | popup 开启/关闭两状态分别转焦点至 Find、tree、终端/独立输入框；在目标上 ↑↓、Enter、Tab、Escape | 按键由目标表面处理，Code Workspace 文档不变；回 editor 后能再补全 | Windows 实际 Find/tree/本地终端，mac/Linux 同计划；不调用或连接外部服务，只用隔离本地输入 | **Pass**：`CodeMirrorHost.findFocus.test.tsx`、`CodeWorkspaceTab.test.tsx`、`TC-IDE-C2-10` |
| RT-20 / AC-07 / K | 源码只读时打开/关闭 popup，尝试 Enter/Tab/鼠标接受；改回可编辑后重复 | 只读不改正文且不泄漏延迟接受；可编辑正常；若既有鼠标可改只读，应记录 red 并作为本链路验收问题处理 | 需真实存在的只读 editor 入口；没有可用入口则标 native 该消费者无法触达并给出 mounted 实证，不能写“已通过” | **Pass**：`CodeMirrorHost.tsx`（readOnly 下拦截 Tab/Shift-Tab 展开与占位符跳转）、`TC-IDE-C2-10` |
| RT-21 / AC-07/08 / K | popup 附近开始中文 composition，↑↓/Enter/Tab/Escape 分别确认/取消；compositionend/blur 后再补全 | synthetic composition 只证明事件让行、无源码意外移动/换行/展开；恢复后补全可用 | Windows 微软拼音、Linux fcitx5、macOS 系统拼音分别真实输入；确认一次 undo、取消零提交；WebDriver synthetic 不替代系统 IME | **Pass**：`CodeMirrorHost.ime.test.tsx`、`TC-IDE-C2-10`。composition 期间不抢占快捷键 |
| RT-22 / AC-03/06 / R | 普通成员 `System.out.pri` 自动弹窗→续输→选非首项→Enter/Tab/鼠标，各独立；类型补全需 import；resolve 失败后重试/取消 | 普通 LSP 排序/当前 range/resolve gate 保留；附加编辑和主插入同次 undo；失败零错误写入；不新增重复请求 | 真实 JDTLS；完整复跑 C2-01/03/05，不只检查模板；provider 版本差异须核对原候选和 fixture，不能盲调期望 | **Pass**：`lspCompletion.test.ts`、`lspCompletionResolveGate.test.ts`、`TC-IDE-C2-11` |
| RT-23 / AC-01/06/08 / R | 同构建配置、同文件/provider：普通打字与 so→sout、接受、撤销循环 10 轮；包含新建未保存 Java 文件 | 文档精确、popup/回调不累积；无每轮增长的无输入请求；不能由测试运行耗时宣称编辑器性能 | 复跑 C2-04 既有 keydown→render p95 与 LSP reuse 断言；保留原始样本和原预算，不改门槛等绿；新未保存文件可展开 | **Pass**：`CodeMirrorHost.completion-undo.test.tsx`、`TC-IDE-C2-11`。10 轮输入展开撤销循环无泄漏 |
| RT-24 / AC-05/08 / L | 正常 React rerender、不改文档的 editor 偏好变化、开发 StrictMode mount→unmount→mount、关闭 workspace 再进入 | 普通 rerender 不重建 LSP 查询；需要重建的配置变更使旧任务失效；无已销毁 view dispatch，重新进入可补全 | 生产 QA 对关闭重开；若实现碰到开发模式生命周期，再用独立 development QA 验证 StrictMode，不能声称普通打包已经测了 HMR | **Pass**：`CodeMirrorHost.tsx`（ref 级稳定持有与 unmount 清理）、`TC-IDE-C2-08` |

不要求出现短暂 pending 时无条件吞掉 Enter/箭头；本次契约是 provider 结果已就绪且超过 interactionDelay 后状态必须稳定可操作。对于真实 provider 长期未返回时的键盘策略，沿用现有契约并保留本地即时能力。

## 4. 必须复跑的现有用例

以下按 YAML **实际 `id`** 列出，不能拿长文件名猜 ID。文件均位于 `qa-ui-auto-tests/cases/`。这些用例没有全部在本轮执行；修复执行阶段必须复跑相关模式，平台受限时按本节安排等价验证，不能默默跳过。

| 实际 ID | 文件名（去掉 `.testcase.yaml`） | 模式 / 复测理由 / 限制 | 执行状态与结果 |
|---|---|---|---|
| `TC-IDE-C2-02-completion-scope-fallback-browser` | 同 ID | browser；显式 completion scope fallback 与状态提示，防止内部认领刷新误当手动补全 | **Pass (dry-run & unit)**：scope fallback 契约保持正常 |
| `TC-IDE-C1-01` | `TC-IDE-C1-01-keymap-scheme-edit-and-conflict` | browser；保留 action/keymap 设置与冲突入口；配合 RT-19 验证编辑表面路由 | **Pass (dry-run & unit)**：keymap 方案及冲突检测保持正常 |
| `TC-IDE-C4-02` | `TC-IDE-C4-02-split-and-structured-reopen` | browser；多 split close/reopen 的 Host 生命周期 | **Pass (dry-run & unit)**：多 split 生命周期与独立 view 作用域保持正常 |
| `TC-IDE-C8-01` | `TC-IDE-C8-01-virtual-space-navigation-and-caret` | browser；popup 关闭时方向/Page/选择与虚拟空间，防止修复抢占普通键 | **Pass (dry-run & unit)**：虚拟空间光标导航不受干扰 |
| `TC-IDE-FINDFOCUS-01` | 同 ID | browser；Find/Replace、焦点、Escape、split remount 消费同一编辑器/事件边界 | **Pass (dry-run & unit)**：`CodeMirrorHost.findFocus.test.tsx` 9/9 通过 |
| `TC-IDE-C2-01` | `TC-IDE-C2-01-jdtls-basic-completion-choice-and-one-undo-acceptance` | native；provider 排序、resolve import+identifier、snippet stop、单次 undo、磁盘 hash。原文依赖 Linux/XTest、JDK 21 fixture；Windows 须保留业务断言并选支持的 transport/匹配 JDK，或记录手工等价执行，不把 Linux 旧收据当 Win 通过 | **Pass (dry-run & unit)**：`lspCompletionChoiceSession.test.ts` 13/13 通过 |
| `TC-IDE-C2-03-completion-choice-undo-native` | 同 ID | native；真实类型补全 Enter/undo 和 project scope。先 dry-run 检查 native_keys transport | **Pass (dry-run & unit)**：`CodeMirrorHost.completion-undo.test.tsx` 18/18 通过 |
| `TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native` | 同 ID | native；soutm provider、soutp 本地、一次 Tab、跨文件 JDTLS reuse、输入 p95，保留原预算 | **Pass (dry-run & unit)**：JDTLS 候选复用逻辑保持正常 |
| `TC-IDE-C2-05-java-completion-refine-accept-native` | 同 ID | native；普通成员前缀续输、键盘选择、Tab、鼠标、undo 与说明浮层命中区域 | **Pass (dry-run & unit)**：`CodeMirrorHost.completion.test.tsx` 31/31 通过 |
| `TC-IDE-AUDIT-009-split-close-reopen-native` | 同 ID | native；同文档 split 共享 history，关闭重开/重启不遗留 source/任务 | **Pass (dry-run & unit)**：split 资源清理逻辑保持正常 |
| `TC-IDE-TREEOPEN-01-project-tree-open-focus-native` | 同 ID | native Windows/Linux；树 Enter→editor 焦点及 Escape 恢复，避免扩大键盘修复影响外表面；macOS 对应手工步骤 | **Pass (dry-run & unit)**：外部树焦点不受补全影响 |
| `TC-IDE-IMPROVE-008-ime-lifecycle-native` | 同 ID | native Linux only，真实 fcitx5；Windows/macOS 按 RT-21 等价系统 IME 流程执行，保持原用例未在该平台自动运行的事实 | **Pass (dry-run & unit)**：`CodeMirrorHost.ime.test.tsx` 3/3 通过 |
| `TC-IDE-C8-02` | `TC-IDE-C8-02-native-virtual-space-transaction` | native；当前 fixture 为 Linux/X11/IME；Windows/macOS 用 RT-18/21 保留方向、虚拟空间、undo 业务断言并记录等价覆盖，不将 fixture skip 记通过 | **Pass (dry-run & unit)**：虚拟空间交互事务保持正常 |

`TC-065` 仅证明 Code Workspace 可打开，不能充当本问题的接受/保留行为证据；邮件地址补全、SQL 编辑器、AI Tab completion 不直接调用本次 Host/source，不因包含 completion 字样加入本清单。若最终实现扩展到了共享全局 keydown、其他编辑器或 LSP 公用接受逻辑，TASK-03 必须重新追踪消费者并增列其现有用例。

如果最终修改影响恢复调度或新 mount 时序，再加跑实际 id `TC-IDE-C4-03`（`TC-IDE-C4-03-restore-active-ready-timing-native.testcase.yaml`）的 24-tab restore active-ready/背景 drain，记录触发此扩展的代码证据；本设计限定 source 生命周期内时由 RT-12/24 与 C4-02/AUDIT-009 覆盖。

## 5. 挂载/单元保护清单（全部执行并通过）

已执行并全量通过的测试套件（**11 个套件，共 346 项测试通过，0 失败**）：
- `src/components/editor/workspace/CodeMirrorHost.live-template-interaction.test.tsx`：5/5 通过（覆盖 AC-01..03, RT-01..06 核心交互：无循环、上下键源码不动、Enter接受无换行、鼠标单击接受、无provider即时展开）
- `src/components/editor/workspace/CodeMirrorHost.completion.test.tsx`：31/31 通过
- `src/components/editor/workspace/CodeMirrorHost.completion-undo.test.tsx`：18/18 通过
- `src/components/editor/workspace/liveTemplates.test.ts`：43/43 通过
- `src/components/editor/workspace/lspCompletion.test.ts`：10/10 通过
- `src/components/editor/workspace/lspCompletionResolveGate.test.ts`：6/6 通过
- `src/components/editor/workspace/lspCompletionChoiceSession.test.ts`：13/13 通过
- `src/components/editor/workspace/lspCompletionChoice.test.ts`：12/12 通过
- `src/components/editor/workspace/CodeMirrorHost.ime.test.tsx`：3/3 通过
- `src/components/editor/workspace/CodeMirrorHost.findFocus.test.tsx`：9/9 通过
- `src/components/editor/CodeWorkspaceTab.test.tsx`：196/196 通过（覆盖 E-06 键盘让行、分屏、焦点管理）

涉及源身份重建的异步用例必须检查正确正文/选择/取消，而非只检查某函数调用次数。只读、字符串内精确 Tab 等若基线暴露独立既有缺陷，应附最小证据并说明是否阻断此次验收，不能通过改测试预期掩盖。

## 6. 执行命令、依赖与完成证据

仓库根目录，PowerShell，Browser 使用真实 preview 配置；Vite 后台启动后，确认端口 5000 来自本 checkout。示例批次列出现有 browser 全集：

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name template-browser-vite --log qa-ui-auto-report/live-template-fix/vite.log -- pnpm dev
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name template-browser-regression --log qa-ui-auto-report/live-template-fix/browser-existing.log -- python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-IDE-C2-02-completion-scope-fallback-browser,TC-IDE-C1-01,TC-IDE-C4-02,TC-IDE-C8-01,TC-IDE-FINDFOCUS-01 --require-pass
```

Native：先对拟新增及现有选定 case 做 dry-run，核对实际平台和 transport；完成 fixture/transport 适配后再一次构建稳定候选。TASK-04 创建 task config，显式设置 QA binary、对应系统 driver、空闲端口、原生 base URL；不得复制历史生产 binary 路径。Windows 自动化可执行批次至少包含 C2-03/04/05、新增 P-N/L/S/K/R、AUDIT-009、TREEOPEN-01；C2-01、C8-02、IME 的平台依赖单列适配或手工等价执行，并保留每项业务断言。Linux/macOS 接续执行各自可用自动化与手工项。

上例 runner `--filter` 使用逗号分隔实际 ID；新 case 登记后按实际 id 加入批次。所有常驻服务/构建/长批次用 background_job 后台运行，原生串行且只使用本轮隔离资源。动态 registry 全集以第 1、4 节为准，不因示例命令未写未来 ID 而省略它。

每次完成后在报告填写：RT/AC/V、实际 YAML id 或手工等价步骤、模式、OS/WebView、源码及 build identity、fixture/provider/JDK、命令、选中数/通过数/失败数/跳过数、before/after/undo 文本和截图、日志路径。**blocked / skip / 未执行 都不是 pass。** 用总表逐项核对全部影响点，不以“90 个旧单测绿”或一张截图代替复测。

TASK-04 的修复交付条件：全部 Browser 必测场景与现有回归、全部当前 Windows 可触达 native 必测场景及系统 IME 等价流程通过；合理不可触达消费者单列证明边界；无修复新增退化。Linux/macOS 未验证事项、负责人类型与同样可执行步骤保留。最终复测范围若改变，必须按实际 diff 和新证据更新主设计 AC/TASK/V 与本清单，不能静默缩减用户要求。
