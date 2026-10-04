# Workspace Shell v2：browser / native 用例设计

> 配套设计：[详细设计 v2](./workspace-shell-ux-redesign-design.md)。基线 `5fb098474f072f4e0c7e99407ab0d072b7d49c53`，2026-10-03。
>
> 设计规格与实际实施记录分开保存。以下 B/N 场景是完整验收规格；已实现 YAML 和实际执行范围见 [实施任务记录](./workspace-shell-ux-redesign-tasks.md#验证记录)，未落实的步骤仍为待实现/待执行。
>
> 规范：[qa-ui-auto authoring](../.agents/skills/qa-ui-auto/references/authoring.md#design-to-implementation-handoff)、[verb catalog](../.agents/skills/qa-ui-auto/references/verb-catalog.md)、[native testing](../.agents/skills/qa-ui-auto/references/native-testing.md)。
>
> 初稿为 44 条 browser + 18 条 native，稳定 ID 为 `TC-SHELL-B01…B44` / `TC-SHELL-N01…N18`；保留范围现补充 B45、N19～N22。当前已登记 45 browser + 17 native Shell YAML；N01/N13/N14 的自动化部分复用既有用例，N11 与 N17 的必要边界仍单列。数量与 schema/contract 通过不代表完整规格已验收，实际范围以 YAML requirements 和当前平台报告为准。

导航：[browser 用例](#browser-cases) · [native 用例](#native-cases) · [运行与交接](#execution-handoff)。单条用例有稳定 `#v-b01` / `#v-n01` 形式的锚点，YAML checklist 可直接引用。

<a id="test-cases"></a>

## 1. 用例共同契约

以下共同字段与每条用例共同组成完整执行规格。下游不能仅把用例标题或命令当作 case。

- **映射**：每条稳定 V-Bxx / V-Nxx 对应原验证族 V-01～07、具体 AC、责任 TASK。所有新目标及受影响保留行为都要执行；“保留”不表示本轮已测过。
- **层级/平台**：B 类是生产 React renderer + browser stub，`modes: [browser]`，Chromium 在 Windows/macOS/Linux；不能证明 Tauri/OS/真实服务。N 类是隔离 QA Tauri，`modes: [native]`，每条写明真实边界、自动化与手工部分；当前 Windows，其它两端按同一断言接续。WebKit 浏览器也不等于 WKWebView/WebKitGTK。
- **隔离**：新 browser context + reset_db；语言/主题/旧 prefs 为 fixture 初始化，不读取个人配置。每个可变场景重置自身数据，case 不依赖另一 case 的副作用；native 只使用 com.taomni.app.qa 和 run-root 下的 disposable 数据。
- **开始**：按 CMD-B / CMD-N 的配置进入实际应用，完成 vault_first_run（需要时），等待真实 readiness；不以固定 wait 或“元素刚出现”代替 ready。
- **操作**：通过 UI 控件/实际按键触发；不会直接调 Shell store setter、内部 handler 或用 eval_readonly 写状态。fixture 只提供外部边界输入（文件、持久化样本、IPC/service 回复）。
- **断言**：每步箭头右侧是决定性 checkpoint；最终还验证完整结果集合及保留状态。精确集合用 assert_items/assert_text_equals，终端执行用单独锚定输出行；截图须附几何/可见性检查和视觉结论。
- **selector**：下列短 testid 均表示精确 `[data-testid="…"]`；新控件见主设计 §11。限定 data-tab-id/panel-id/owner-id；不得使用 DOM 索引冒充业务身份。新增控件标为计划，不声称已存在。
- **verb**：常规 open/wait_for/click/dblclick/right_click/middle_click/fill/press/drag_to/compose_text/set_viewport/assert_* 均已核对当前 catalog；set_viewport/compose_text 是 browser-only。缺口明确交 TASK-11，不能发明一个看似现成的命令。
- **基线**：所有 case 的实际改前执行为“待执行”；源码与旧用例只证明调查依据。主设计 §11.1 给旧 case 候选，下列每条列进一步依据。基线失败保存证据并判定原因，不能自动归为既有缺陷。
- **产物**：`qa-ui-auto-report/workspace-shell/<mode>/<run>/<TC-id>/` 下保留结果、screenshots、DOM/geometry、必要 IPC/service/磁盘观察；native 带 binary hash/QA identity。记录 source dirty diff、case/runner/config hash、OS/WebView、时间、selection/pass/fail/skip/unrun。原始产物不提交；文档回填路径与结论。
- **清理**：browser 关闭独立 context，停止本 case fixture/解除 held replies；native 先取消/完成本 case jobs，关闭本次 QA 子窗口和进程，停 fixture、恢复原剪贴板/窗口设置（涉及时）。删除范围必须解析并确认在 run-root；不使用 production profile，不改变 HOME。
- **完成**：P2/TASK-11 为每个 YAML 登记 policy、covers、fixtures、modes 和 verification；requirements 的 actions/checkpoints/results 指向 1-based 决定性步骤，semantic review 前为 pending。visual/native checklist 分别记录；手工未执行不能靠 YAML pass 抹掉。所有相关 retained cases 同批更新。
- **命令**：每条 B 默认 CMD-B，N 自动部分 CMD-N，N 手工部分 MN-1；填入该条精确 TC ID。命令在 YAML/fixture/控件实现后才可用。本轮只核对 --help，不运行产品或拟新增用例。

初始超时预算：普通 browser case 120秒；B39性能样本600秒；native本地流程300秒；N03/04/12～15/17/18的协议/窗口组合900秒。实现后按真实步骤与既有阶段预算收敛，不能通过加timeout掩盖明确性能退化；prepare-ready仍是产品10秒边界。手工OS流程记录实际耗时，不用自动YAML等待个人操作。

### 1.1 固定数据与 fixture

| 数据 | 内容、准备、可观察身份 | fixture / 支持状态 |
|---|---|---|
| D0 空环境 | 无保存 session/recents，仅 welcome；1440×900、中文、dark、无 overlay、AI 默认设置 | 现有 reset_db；UI 设置语言/主题，必要 prefs 用现有 seed_storage |
| D1 多类型 | 共 12 个主 tab（含 Home）：SSH A=qa-alpha、SSH B=qa-beta、W1/W2=同目录不同 workspaceInstanceId、独立 Git G、MySQL D、Mail M、VNC V、独立 SFTP S、Settings U、Proxy P。host alpha.invalid/beta.invalid，路径 /work/甲 与 /work/乙；有 160 字符标题。通过 UI 按 A→D→M→W1 建立确定 MRU | 拟新增 shell_browser_catalog；仅 browser，在会话/文件/IPC 边界提供数据，用真实 opener 打开，不直接写 appStore.tabs |
| D-ALL 类型全集 | 21 种 TabKind 各一项加未知 future-view 恢复记录；未知数据只能通过恢复解码边界进入 fallback。Home 去重 | shell_browser_catalog 的 all-types 样本；TASK-01/11 增补安全 decoder 与 fixture，不把未知当合法协议启动 |
| D2 编辑/业务状态 | W1 的 README.md 初始三行：alpha / beta / gamma（LF，末尾换行），另有只读文件、150 行文件；Git A/B 不同分支和改动；DB 草稿 select 42；mail draft 标题 SHELL-DRAFT；term 输出 QA-A | browser catalog；native 复用 project_tree/git_diff_repo，必要新增 shell_native_files；真实目录均在 report root |
| D3 提醒 | note overdue、chat done、mail_new(count=2)、transfer_done、transfer_failed 共 5 条待处理；关联 D1；固定 fireAt，历史 305 条可搜索项 | browser catalog + 拟新增 shell_backend_scenario；native 由真实 Notes/邮件/transfer 产生，AI 可用本地兼容测试 endpoint（生成结果不用于证明模型质量） |
| D4 迁移 | taomni.sidebarCollapsed=false，sidebarCollapsedByGroup.v1 的 terminal=true、code-workspace=false；旧 Tao JSON 为 position=left、pinned=true、width=380、floatingOpacity=.8、ribbonOffsetRatio=.3；无 v2。另备字段损坏、截断 JSON、version=999、超限尺寸、storage 写失败 | 现有 seed_storage/reload_window；storage fault 需拟新增受控 browser fixture，不能用 eval_readonly 写 |
| D5 传输 | 16 MiB 固定内容文件和 SHA-256；loopback SSH/SFTP 专用目录含中文/空格名；测试服务限速使任务可暂停；A/B 独立目录 | 现有 ssh_required/sftp_required + 拟新增 shell_native_files；仅用户授权的本地 disposable 服务，环境变量 QA_SSH_PASSWORD |
| D6 外部故障 | hold/release/fail 下一次指定 owner 的 attach/Git read/restore/open-window；每个 operationId 可观察；重复/旧 ready 消息；禁止直接制造“Shell 已成功”状态 | 拟新增 browser-only shell_backend_scenario，TASK-11 实现于 stub/fixture 边界，并同步 schema/verb-catalog |
| D7 原生依赖 | project_tree/git_diff_repo；MySQL 隔离 schema shell_<run>；mail_server 的真实 loopback IMAP/SMTP；脚本化 VNC；必要时 disposable RDP | 现有 fixture 已在 REGISTRY；服务版本/就绪结果写证据，不能把端口可连接当 SQL/IMAP 已成功 |

`shell_browser_catalog`、`shell_native_files` 和 `shell_backend_scenario` 均是规划支持。新 fixture 在 `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/` 实现，注册 REGISTRY 和 schema；新 verb 的 browser/native 支持明确枚举，不用 skip 蒙混。场景参数是有限 enum + ownerKey/operationId，不能接受任意 JavaScript。现有 parity008 hold/release 可满足 Git 部分时优先复用。

### 1.2 runner 能力边界

| 证明点 | 已有能力 | 缺口及交付 |
|---|---|---|
| DOM 操作/选择/布局 | press、drag_to、assert_attribute/items/element_geometry、eval_readonly 只读短表达式 | 新 testid/语义由产品任务提供；越界/遮挡可只读 rect 比较，不能仅截图 |
| 持久化样本与页面重载 | seed_storage、reload_window、assert_localstorage | reload 不等于退出进程重启；真实重启按 MN-1，不写虚构 restart_app verb |
| 真实磁盘结果 | native assert_file_contains/sha256/receipt、host_write_file（run-root 内） | 远端 hash 由 fixture/独立 SSH 命令读取；独立观察，不信 UI 完成 toast |
| 原生窗口几何 | native_window_drag 仅 Linux/X11 | Windows/macOS 用 OS 手工步骤和外部矩形记录；不可把 browser drag_to 记作 OS 移窗 |
| 跨窗口 WebDriver | 当前 catalog 无通用 switch_window / app_restart | N04/05/07/18 使用具体手工步骤；若 TASK-11 增能力须 schema+runner+catalog+实际样例，不先写假 verb |
| IME/系统快捷键 | Linux native_ime_keys；native_keys x11 是 Linux；webdriver transport 是 renderer 输入 | Windows/macOS 实际 IME/OS 留手工；compose_text 仅 browser 组合事件 |
| 真实剪贴板 | assert_system_clipboard 目前 Linux/X11 | Windows/macOS 独立应用粘贴并保存输出；测试后还原 host 文本 |
| 样式/可用性/性能 | geometry、截图；原生 editor metric 有限 | 人工看截图/读屏与真实输入单列；generic Shell 性能 collector 只观察，保留原始样本，不造产品轮询 API |

## 2. 覆盖矩阵与最小执行批次

不计算虚假的“覆盖率 100%”。下表是计划覆盖，实际完成率只由 reviewed requirements 的当前执行证据计算；一个 fixture 场景尚未实现就是缺口。

| AC | browser V | native V（补足的边界） |
|---|---|---|
| AC-01 | B01、B02 | N02、N11（PTY / picker） |
| AC-02 | B06～B13、B39、B40 | N10（系统键路由） |
| AC-03 | B16～B19 | N03、N04（真实 SFTP/job/window） |
| AC-04 | B20、B21 | N05、N06（Git/disk/editor） |
| AC-05 | B23～B25、B41 | N07、N16（WebView/Notes/window） |
| AC-06 | B26 | N03、N07、N13（真实通知来源与跳转） |
| AC-07 | B29、B33、B44 | N01、N16（窗口/DPI/traffic lights） |
| AC-08 | B23、B30、B31、B44 | N16（实际 WebView/缩放） |
| AC-09 | B14、B15、B18、B37 | N03、N04、N05、N12、N15、N18 |
| AC-10 | B34、B35、B42 | N08、N18（真正重启/恢复） |
| AC-11 | B10、B11、B23、B31、B32 | N09、N10、N16 |
| AC-12 | B06 | 不新增协议 native；分类为纯 renderer，代表协议实际运行由 N02～N06/12～N14 保护 |
| AC-13 | B16～B25、B37～B39 | N02～N07、N12、N14、N17 |
| AC-14 | B05、B22、B40、B43 | N06、N11 |
| AC-15 | B02～B04、B42 | N02、N08、N11 |
| AC-16 | B11、B31、B32、B38 | N09、N10、N14 |
| AC-17 | B14、B15、B33、B37、B40 | N02、N12、N15 |
| AC-18 | B19、B21、B28、B36 | N04、N05、N07、N14、N18 |
| AC-19 | B17、B20、B25～B27 | 外部真实错误由 N03/12/13 补足；不重复 native 验每个 renderer 错误文案 |
| AC-20 | B08、B39、B44 | N17（匹配条件下的输入/资源结果） |

维度：UI/视觉 B01/08/29/30/44+N16；控件/交互 B01～44；Action 每个可见入口 B14/33/40/43；实际快捷键 B10/11/31/32+N10；生命周期/失败/取消/迟到/恢复 B04/15/17/18/20/24～28/34～38/42+对应 N；三端 native 不从 browser 推导。

迭代按所属 TASK 运行相关 B 和必要单元；组合稳定后选目标与保留的并集，最终此批完整验收覆盖所有 44 B。Native 18 项中的自动/手工断言在当前 Windows 集中完成；按必要依赖分为基础窗口/本地文件、SSH/Git、mail/MySQL/remote 三组，一次匹配 build 可共用。各 case fixtures 独立，因此本批默认不增加 CI case→case 依赖；复用确有前置产物的旧用例时才补 dependencies.yaml。

<a id="browser-cases"></a>

## 3. Browser 详细用例

每条都继承 §1；`modes: [browser]`、CMD-B、三宿主 OS 的 Chromium、status=待实现/待执行。用例使用本节写出的真实生产入口，不能只挂载 demo.html。

<a id="v-b01"></a>

### V-B01 / TC-SHELL-B01 — 唯一 Home 与首屏主要入口

- **归属**：AC-01、AC-07；V-05、V-06；TASK-02/08；covers: [F1.2、F1.6]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B01-home-entry.testcase.yaml`。
- **前置 / fixtures**：[reset_db]。D0；无 recents、无 restore。基线 TC-001 / WelcomePanel 源码；首屏目标为有意变化。
- **控件 / 支持**：welcome-panel、welcome-new-session、welcome-open-local-terminal；新增 shell-rail-home、shell-home-open-workspace。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 启动 → Rail 与顶部各有一个 Home 入口，但仅一个 welcome 业务实例；三个主动作按规定顺序，1440×900 无需滚动可点击。
2. 经真实入口打开一个本地终端，再依次点击 Rail Home、顶部 Home，各重复两次 → tab 总数不增长，始终激活同一 welcome；终端内容保留。
3. 对 Home 中键、右键关闭、总览 Delete → 关闭能力禁用且有说明；没有 dirty dialog，也不调用退出。
4. 无最近数据时点击会话/工作区/邮件页 → 各自空态有真实创建入口；页签选中/tabpanel 关联正确；截图检查主动作无遮挡。

**证据与收尾**：记录完整 tab-id 集合、三动作 rect、Home 可访问名称和首屏截图；清理继承 §1。 执行 CMD-B；状态：待执行。

<a id="v-b02"></a>

### V-B02 / TC-SHELL-B02 — 三主动作的成功、失败、取消与重复点击

- **归属**：AC-01、AC-15；V-05；TASK-08；covers: [F1.6]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B02-home-launch-outcomes.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D0 + D6；提供 Shell success/fail、picker cancel/path、SessionEditor 保存失败三种外部回复。保留 LocalLaunchOutcome / SessionOpenOutcome。
- **控件 / 支持**：welcome-new-session、session-editor、session-save、welcome-shell-select、welcome-open-local-terminal；新增 shell-home-launch-status/open-workspace。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 新建连接填入 qa-draft，取消再打开 → 回 Home，不新增连接；本轮表单 draft 保留。再保存失败 → 表单仍在，显示错误，修正重试成功仅新增一条保存记录。
2. 打开工作区并在 picker 取消 → tab、recent、active 工作面不变；选有效 D2 路径 → 一次打开并进入 Build；缺失路径 → 给重新定位/移除入口，修正后可打开。
3. 选择本地 Shell 并在 pending 连点两次启动 → 只一个启动请求/一个 tab；只有 started 后更新最近成功；failed 显示原因且可选其它 Shell 重试。
4. 模拟 cancelled → 不显示成功计数；从其它入口再打开成功会话，返回 Home → 列表更新但原活动 tab 未被抢占。

**证据与收尾**：保存每分支的 tab/recent 完整集合与 launch/保存外部回复；新故障支持 D6 由 TASK-11 实现，不能仅以 tab 存在断言成功。 执行 CMD-B；状态：待执行。

<a id="v-b03"></a>

### V-B03 / TC-SHELL-B03 — 最近会话、工作区、邮件和目录历史保留

- **归属**：AC-01、AC-14、AC-15；V-05；TASK-08；covers: [F1.6]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B03-home-recents.testcase.yaml`。
- **前置 / fixtures**：[reset_db、welcome_recents、shell_browser_catalog]。D1/D2；最近项含同名不同 host、中文路径、旧目录 unavailable、一账户 Mail；固定最近使用时间。旧 Welcome recent/目录用例为基线。
- **控件 / 支持**：welcome-recent-filter/type-filter/sort、welcome-recent-session-row、welcome-history-tab-workspaces；新增 shell-home-recent-tab/mail/more。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 依次以名称、主机、类型、分组检索会话，清筛选并切排序 → assert_items 检查准确结果与顺序，同名项不能混淆。
2. 多选两条后“打开所选”，再“打开筛选结果” → 每个目标按 opener 语义进入/激活，清选择不关闭 tab；右键编辑/定位仍指向正确 session。
3. 切工作区，过滤中文路径，移除一条并取消清空全部 → 仅目标 recent 被移除，目录与已开 workspace 保留；重复打开已存活实例不复制。
4. 切邮件最近项打开账户 → Communicate 主 tab；回 Home 展开目录区，从可用目录启动 Shell；unavailable 项禁用并显示原因，重试后恢复可用。
5. 从更多入口打开本地目录、LAN Chat、Settings、Help → 每项到原业务入口，Home 状态和筛选仍可恢复。

**证据与收尾**：三个列表完整内容/顺序、目标 identity、目录失败/恢复截图；native picker/真实 cwd 由 N02/N11 补足。 执行 CMD-B；状态：待执行。

<a id="v-b04"></a>

### V-B04 / TC-SHELL-B04 — 恢复工作集的部分失败、取消、认证与重试

- **归属**：AC-10、AC-15、AC-19；V-05；TASK-08/10；covers: [F1.6]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B04-home-restore-mixed.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。恢复样本含：A 已打开、B 需认证、W1 有效、W2 路径缺失、D 配置类型已变；D6 控制认证/ready 回复。useWelcomeSessionResume 为保留基线；会话来自原RunSnapshotRecord，W1/W2来自本批新增Shell restoreSources，不把workspace塞入旧SnapshotEntry。
- **控件 / 支持**：welcome-restore-last-session/status/cancel/retry/clear、auth-prompt；新增恢复项明确 entry-id 状态。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 点击恢复并再次点击 → 一个 operation，A 被定位无重复；按序产生独立 entry 结果；等待认证显示 awaiting-auth，不把 tab-created 算 ready。
2. 认证中取消恢复，随后放行旧认证成功 → 未开始项不打开，旧回复不污染新 operation；已成功项保持可用，不自动关掉。
3. 修复 W2 路径，对失败/取消项点重试 → 只重试这些 entry；计数按 ready/partial/failed/cancelled 分列，A/W1 不重复。
4. 再次触发失败并切到 Home 外 tab → 恢复行后台更新，不抢 active tab；清记录先取消后确认 → 取消保留记录，确认仅清快照，不关闭当前工作。

**证据与收尾**：每 entry 的最终 outcome 与总数相等，旧 operation 忽略记录；相同快照/源码的旧基线待执行，D6 hold/release 支持待补。 执行 CMD-B；状态：待执行。

<a id="v-b05"></a>

### V-B05 / TC-SHELL-B05 — Rail 选择与 Navigator 的折叠恢复

- **归属**：AC-07、AC-11、AC-14；V-06；TASK-02；covers: [F1.2、F1.9]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B05-rail-navigator.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1，active=W1；Sessions 树选 A 并展开分组，Workspaces 项目树选 README。旧 TC-MAIN-RAIL-01 为保留结果依据。
- **控件 / 支持**：新增 shell-rail-*、shell-navigator/page/toggle；session-tree、session-search、main-sidebar-resize-handle。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 点击 Sessions → 展开对应 Navigator，W1 保持 active；点击相同 Rail 再次收起再打开 → 树选中、展开、search 保留。
2. 点 Workspaces 的项目/最近/工具页再回 Sessions → 两套列表各自状态不串；切页不创建 workspace；Project 只有一个可交互实例。
3. 点 Tao 后关闭 → Navigator 原 area/宽度保持；Settings 打开两次 → 一个 Utility settings tab，Home 可返回。
4. 仅键盘 Enter/Space 逐个激活 Rail；从 menu 切 Navigator → selected/expanded 和实际可见一致；按钮完整 aria 名，不依赖 hover。

**证据与收尾**：前后 activeId、tab 集合、Navigator selected node 和尺寸；视觉审查保留全高 grip 与常驻入口间距。 执行 CMD-B；状态：待执行。

<a id="v-b06"></a>

### V-B06 / TC-SHELL-B06 — 全部 TabKind、未知恢复项与展示隔离

- **归属**：AC-02、AC-12；V-01、V-02；TASK-01/03；covers: [F1.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B06-type-lane-mapping.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D-ALL；21 已知 + unknown future-view，使用会话/恢复解码边界，不能直接 setState。当前 TabKind union 为静态基线。
- **控件 / 支持**：新增 shell-lane-option、shell-tab-card；tab-item 的 data-tab-type/lane、UnavailablePanel 对应可读 region。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 逐一通过真实 opener/restore 打开类型集合 → 按主设计 §4.1 精确检查每个默认 lane，Home 仅一个，Standalone SFTP 在 Connect、Git/DB 在 Build。
2. 检索未来类型的标题 → Utility 中可见明确“暂不支持”详情；激活不崩溃，close 删除该项且其它类型仍可用。
3. 将一条数据库显示分组改为 Utility → 业务仍是原引擎与原 connection；恢复默认回 Build。
4. 同名 W1/W2 检查 workspaceInstanceId 不同，Chat/panel owner 不被名称去重；总览计数=所有主 tab 数，不含 SFTP/Git Host。

**证据与收尾**：完整 type→lane→tabId→owner 映射和准确总数；unknown fixture decoder 是新增支持，单元表穷举补足但不能替代 UI 路径。 执行 CMD-B；状态：待执行。

<a id="v-b07"></a>

### V-B07 / TC-SHELL-B07 — 空 lane、MRU、活动关闭回退与后台提醒

- **归属**：AC-02、AC-12；V-02；TASK-03；covers: [F1.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B07-lane-mru-empty.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1 通过 A→D→M→W1 建立 MRU；Utility 项先显式关闭，留下空组；数据标题不可用于 MRU key。
- **控件 / 支持**：新增 shell-lane-select/option/empty、shell-tab-card；tab-item。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 切 Communicate → 选最近 M；切 Build → 选最近 W1；仅在总览选 Connect filter → 实际 active 仍 W1。
2. 切空 Utility → 明确空态与工具入口，不增加 placeholder tab；点工具创建有效 tab 后清空 laneSelection 并进入该项。
3. 关闭 Build 活动 W1 → 同组 W2 或 G/D 中 MRU 最近项；逐步关完 Build → 全局 MRU 存活项；最后只剩 Home → 激活 Home。
4. 在 A 后台生成输出/错误 → badge 更新但不抢 active；关闭非活动 B 不改变当前；重开一个 tab 清旧临时 filter 且立即可见。

**证据与收尾**：每步精确 activeId / MRU 序列 / tabs 集合；保留 addTab 清过滤语义，动作关闭都经 coordinator。 执行 CMD-B；状态：待执行。

<a id="v-b08"></a>

### V-B08 / TC-SHELL-B08 — 6/7/30 标签、固定、长标题与溢出

- **归属**：AC-02、AC-07、AC-20；V-02、V-06；TASK-03；covers: [F1.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B08-tab-strip-overflow.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。同 lane 先 6 后 7 后 30 个 tab，含长中文/emoji/相同显示名；新开成功后 active 是最后一项。
- **控件 / 支持**：tab-bar、tab-item、tab-title；新增 shell-overview-trigger、pin/menu。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 从第 6 开到第 7 项 → 新 active 可见、计数更新，但总览不自动弹出、不抢输入焦点；非活动项可从总览全部找到。
2. 在 30 项中滚动条并打开中间项 → active 始终可定位，左右邻项规则明确；强制窄宽不出现整页横向滚动。
3. 固定两项 → 本 lane 固定区顺序稳定，关闭图标隐藏；默认 close all 排除固定与 Home，明确数量后才操作。
4. 右键显式关闭固定项并取消风险确认 → 项仍固定；取消固定再移动 → 普通顺序正确。长标题省略但 tooltip/aria 可得全名。

**证据与收尾**：条内 visible 数量、全量 card 集合、active rect 与 clamp；三种规模截图做文字裁切评审。 执行 CMD-B；状态：待执行。

<a id="v-b09"></a>

### V-B09 / TC-SHELL-B09 — 总览组合检索、筛选、排序与预览降级

- **归属**：AC-02、AC-12；V-02；TASK-03；covers: [F1.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B09-overview-search-filter-sort.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1 加连接中/error/busy/unread/none，各 owner 的 preview 有值与缺失；A/D/M/W1 的 MRU 已建立。旧 tabFilter/OpenTabsMenu 为保留依据。
- **控件 / 支持**：新增 shell-tab-search/lane-filter/attention-filter/sort/clear/current/card。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 从所有标签进入 → 空 query/全部/MRU，当前项可见；分别输入名称、类型中英别名、host、中文路径、分组、邮箱 → assert_items 精确匹配；大小写、首尾空白、NFC 和双关键词 AND 分别验证。
2. 叠加 lane + attention + 原 group/multi → chip 全可清除且是交集；被排除当前项只出现定位提示，不混入不匹配卡片；点定位当前清相关 filter。
3. 切 name/type/MRU sort → 完整顺序与稳定 tie-break 一致；卡片数据刷新不使已聚焦项跳到别处。
4. 清空后检索不存在词 → 三个空态动作可实际清筛选/回 Home/新建；preview 缺失用稳定摘要，打开总览不会为取 preview 额外连接或执行查询。

**证据与收尾**：各输入的精确目标序列、preview/error 文本与外部请求记录；不使用 contains 证明整表过滤正确。 执行 CMD-B；状态：待执行。

<a id="v-b10"></a>

### V-B10 / TC-SHELL-B10 — 总览网格键盘、卡片动作和焦点恢复

- **归属**：AC-02、AC-11；V-02、V-06；TASK-03；covers: [F1.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B10-overview-keyboard-focus.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1；按容器宽分别得到 3/2/1 列；opener 为 overview trigger，已记录原 active/focus。
- **控件 / 支持**：新增 shell-overview、shell-tab-search/card/close/pin/more；tab-close。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 打开 → 焦点搜索框，Tab 进入卡片；各宽度依次方向键/Home/End → 移动按实际列数，不激活未确认 tab。
2. Enter 激活 → 总览关闭，唯一目标 active；重新打开，点击卡片 close/pin/menu → 不顺带激活卡片或关闭总览；删除后的焦点有下一/上一/搜索框确定落点。
3. 卡片焦点 Delete → 走保护；query 输入中 Delete 只删文字；IME composing Enter 不切 tab。
4. 通过 Esc、关闭按钮、遮罩分别退出 → 原 active 不变且焦点回 opener；opener 已被布局移除时回当前 tab/工作面，隐藏卡片不能继续获焦。

**证据与收尾**：逐步 activeElement 可读观察、aria-selected/active-descendant、最终 tab 集合；compose_text 只说明 browser 组合事件。 执行 CMD-B；状态：待执行。

<a id="v-b11"></a>

### V-B11 / TC-SHELL-B11 — 快速切换、冻结 MRU 与 keymap 重绑定

- **归属**：AC-02、AC-11、AC-16；V-02、V-06；TASK-03；covers: [F1.5、F25.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B11-quick-switch-keymap.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1；Shell chrome 焦点；另准备 Terminal/Code/Mail 的原 key claim。组合按键的 browser 无法收到时该 OS 断言留 N10，不用合成 handler 冒充。
- **控件 / 支持**：新增 shell-quick-*、shell-keymap-*；原 terminal-pane、code-workspace-editor。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 点快切与在 Shell 焦点按 Mod+K → 都是同一 combobox/listbox；query+ArrowDown+Enter 精确激活一次；Esc 回原焦点。
2. 按住 Control，连续 Tab/Shift+Tab → 使用打开时 MRU 快照不会两个 tab 来回；释放提交，Esc 取消；macOS 默认显示 Control+Tab，不显示 Cmd+Tab。
3. 从快切转总览 → 只一个 focus trap，query 保留；检索空结果动作可用。
4. 进入 Shell keymap 记录新组合，遇已占用组合显示作用域并取消 → 旧映射不变；选择无冲突组合保存/reload → 仅新绑定执行，旧绑定回业务处理；编辑器/terminal claimed-disabled 不穿透。

**证据与收尾**：完整 MRU/动作结果、键位持久化值、焦点和冲突对话框；原 Ctrl+K AI 与 Ctrl+Shift+T 回归另由 B32 覆盖。 执行 CMD-B；状态：待执行。

<a id="v-b12"></a>

### V-B12 / TC-SHELL-B12 — 重命名、复制 cwd/profile 与错误取消

- **归属**：AC-02、AC-13；V-02；TASK-03；covers: [F1.5]；目标与保留行为均按下列动作验收。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B12-tab-rename-duplicate.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。A 自动 cwd title，B 手动名；W1 已有本次未保存编辑；terminalInitialCwd/profile stub 返回已知值。TabBar/appStore duplicate 为保留。
- **控件 / 支持**：tab-title-input、tab-context-menu（复用 context-menu）；新增 shell-tab-card-more。 使用 §1 已有常规 verbs；新增 fixture/控件尚待实施。

1. 双击/右键重命名进入输入；Esc → 原 title 不变；Enter 合法名 → strip/overview 同步；空名回原值并提示，不能产生不可辨识空标题。
2. 复制自动 title 的 A → 新 id、同 cwd/profile，名称按既有后缀规则；随后 A cwd 改变 → 自动名更新，B 的手动名不被覆盖。
3. 从总览菜单复制 W1 → 新 workspaceInstanceId，不共享 undo/选择；同路径 owner Git 仍隔离。
4. Home rename/duplicate 禁用；目标在菜单打开后被关闭再执行 → 提示目标不存在，不复制新的 active tab。

**证据与收尾**：旧/新 tab identities、title/cwd/profile 全值与 workspace 内容；copy 实际 PTY 继承另由 N02 证明。 执行 CMD-B；状态：待执行。

<a id="v-b13"></a>

### V-B13 / TC-SHELL-B13 — 拖拽、菜单/键盘排序与移动分组

- **归属**：AC-02、AC-11；V-02；TASK-03；covers: [F1.5]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B13-tab-order-lane-move.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1，Connect A/B/S；固定 B；当前 A；旧 TC-108 和 tab drag 用例为保留基线。
- **控件 / 支持**：tab-item、原移动菜单；新增 shell-tab-card-more、shell-lane-option。 使用 §1 的真实操作与断言；新增项待实施。

1. 在 strip 拖 A 到 S 后，随后通过右键前移/后移/首/尾各执行一次 → 完整顺序正确，Home 不可越过，固定区与普通区边界遵循设计。
2. 在总览把 A 移至 Build → 原连接/owner不变、active仍 A，lane更新；恢复默认后回 Connect。
3. 拖动中按 Esc / pointercancel / 放到无效目标 → 原顺序/lane/pin不变，ghost与鼠标捕获释放。
4. 键盘通过菜单完成同样移动；达到首/尾边界时动作禁用并有原因；过滤列表中排序按实际 tab identities 合入，不误交换被过滤隐藏项。

**证据与收尾**：每步全量 tab-id 顺序和业务标识，drag 前后截图；不以 ghost 出现作为排序成功。 执行 CMD-B；状态：待执行。

<a id="v-b14"></a>

### V-B14 / TC-SHELL-B14 — 所有关闭入口的取消与正常提交

- **归属**：AC-09、AC-11、AC-17；V-03；TASK-03/04；covers: [F1.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B14-close-entry-parity.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D2 W1 dirty，另有 A/D、固定 B；每个入口恢复相同前置；原 TabBar 所有 close 调用方枚举为基线。
- **控件 / 支持**：tab-close、context-menu、shell-tab-card-close、shell-close-*、原 close-active 菜单；新增均按主设计 §11。 使用 §1 的真实操作与断言；新增项待实施。

1. 分别用 tab X、中键、右键 Close、总览 close、卡片 Delete、应用 close-active 关闭 W1 → 各自展示同一份风险；点取消 → tab、完整文本、选中和 undo 均保持。
2. 每入口再执行 save-and-close → await flush 后才移除且只一次；外部 stub 返回保存失败 → 不移除，错误可重试。
3. 菜单 Close others / all → 默认保留 Home/固定 B，确认计数等于目标集合；取消不移除任何目标，显式 include pinned 后才可关闭 B。
4. 确认框打开期间再次点击关闭/实际快捷键 → 只一个对话框/transaction；普通输入 Delete 不触发关闭。

**证据与收尾**：按入口记录 target集合/最终文本/flush结果与tab集合；新 unified close不能只用 spy次数代替用户结果。 执行 CMD-B；状态：待执行。

<a id="v-b15"></a>

### V-B15 / TC-SHELL-B15 — 关闭预检、迟到修改、批量部分失败

- **归属**：AC-09、AC-13、AC-17；V-03；TASK-04；covers: [F1.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B15-close-failure-race.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。W1 dirty、D 有未提交事务、A 有任务；D6 使第二项 flush 拒绝/让新 revision 在确认后出现。业务原 close路径只作为静态依据。
- **控件 / 支持**：shell-close-risk/save/discard/commit/rollback/background/cancel-job/cancel/error；context-menu。 使用 §1 的真实操作与断言；新增项待实施。

1. 批量关闭预检时在 D 选择取消 → 未执行commit/rollback/cancelJob，任何 tab 不删除；W1 文本/事务/进度不变。
2. 选择保存 W1 与 rollback D，挂起 W1 flush；此时新增 W1 编辑 → 旧确认不足，重新展示新revision；取消后文本完整。
3. 允许第一项提交，第二项真实边界拒绝 → 明确已关闭/未关闭数量；失败项与后续项保留，不伪称整组回滚；修复后只重试剩余项。
4. 后台任务交接失败 → 原 owner保留；重试交接成功再删除；迟到旧 operation成功不得二次删除新 tab。

**证据与收尾**：保存前后revision/完整内容、事务结果、lease交接观察和UI清单；D6仅故障外部回复，coordinator是真实产品实现。 执行 CMD-B；状态：待执行。

<a id="v-b16"></a>

### V-B16 / TC-SHELL-B16 — SFTP 右 Host、隐藏与文件浏览保留

- **归属**：AC-03、AC-13；V-03；TASK-05；covers: [F7.4、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B16-sftp-host-retained.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1 A已连接；stub远端含空格/中文名、多文件；A输出QA-A。TC-145/TC-008～012为基线，browser只证renderer。
- **控件 / 支持**：attached-sftp-toggle、sftp-browser、sftp-remote-list、已有orientation/sync/queue controls；shell-host-hide。 使用 §1 的真实操作与断言；新增项待实施。

1. 从 A 文件入口连续打开两次 → 一个右Host/一个logicalPanel，顶部主tab数不变；Files/Transfers可切，列表来自A。
2. 选目录、排序、多选、切双窗格方向/显示隐藏文件，再隐藏 → 主工作面扩展；重开 → 路径/scroll/selection/方向/队列保持。
3. 隐藏期间给A输出新marker，再返回终端输入 → renderer输入及输出仍有效；连接外部调用未因隐藏重新attach。
4. 改变终端cwd → SFTP不自动cd；显式同步才更新路径；“在这里打开终端”使用选中路径。关闭文件视图再重开仍走原业务规则。

**证据与收尾**：前后path/selection/输出及attach请求记录；真实SSH/传输副作用由N03。 执行 CMD-B；状态：待执行。

<a id="v-b17"></a>

### V-B17 / TC-SHELL-B17 — SFTP 多 owner、认证错误与迟到响应

- **归属**：AC-03、AC-13、AC-19；V-03；TASK-05；covers: [F7.4、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B17-sftp-owner-race.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。A/B不同host和目录；D6挂起A attach/list，让B成功；错误/auth cancel均由外部边界产生。
- **控件 / 支持**：shell-host-owner/retry、sftp path/list、auth-prompt。 使用 §1 的真实操作与断言；新增项待实施。

1. 打开A文件并hold列表，切B打开文件 → B header/list都属B；放行A回复 → 只更新A缓存，不改B列表/焦点。
2. 回A → 原目录就绪；模拟断线后retry → panelId不变，重复retry只一个进行中的操作。
3. 让B认证失败并取消 → 面板保留错误/重试，A仍可用；再次正确认证恢复B，不新增重复主tab。
4. A初始化过程中关闭A再放行成功 → 原generation失效，资源被清理/转交，没有幽灵Host或串到B。

**证据与收尾**：A/B完整路径列表、owner identity、错误/retry状态和外部连接记录；新hold/release能力D6须先实施。 执行 CMD-B；状态：待执行。

<a id="v-b18"></a>

### V-B18 / TC-SHELL-B18 — 后台传输与 owner/面板关闭选择

- **归属**：AC-03、AC-06、AC-09、AC-13；V-03；TASK-04/05/07；covers: [F7.4、F-SHELL-1、F-TAO-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B18-sftp-job-close.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D5的browser等价payload/progress，由stub job事件推进；A和B各一个任务且jobId不同。
- **控件 / 支持**：transfer queue pause/resume/cancel、shell-close-background/cancel-job/cancel、tao-alert-jump。 使用 §1 的真实操作与断言；新增项待实施。

1. A传输到30%时hide/开Tao/切B → A任务继续更新且不重复，B任务不受影响；header X隐藏不弹破坏性确认。
2. 关闭A主tab先取消 → A与job保留；再选继续后台 → lease交接确认后A消失，状态栏/Tao仍有准确job入口。
3. 点击完成通知 → Transfers展示同job终态后ack；同终态事件重复两次只一条通知；progress不反复新增未读。
4. 关闭B选取消传输并关闭，hold取消回复 → tab不提前删除；确认终态后删除B，A已完成记录仍在。

**证据与收尾**：两job的有序状态/取消目标/通知集合；明确browser不证明远端字节完整性，N03负责hash。 执行 CMD-B；状态：待执行。

<a id="v-b19"></a>

### V-B19 / TC-SHELL-B19 — 面板提升主标签与回停靠

- **归属**：AC-03、AC-09、AC-13、AC-18；V-03；TASK-04/05/06；covers: [F1.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B19-panel-promote-dock.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。A文件Host已有scroll/selection/job；Git W1有commit草稿；记录panelId与业务connection/controller身份。
- **控件 / 支持**：shell-panel-promote/reattach、shell-host、tab-item、shell-close-*。 使用 §1 的真实操作与断言；新增项待实施。

1. 从SFTP menu选在标签打开 → 一个Connect主tab引用原panelId，原右Host让位；内容/进度不重置，不新增物理连接。
2. 重复promote → 只激活已有主tab；回到面板 → 该临时主tab移除，A/原位置及焦点恢复，仍同实例。
3. 提升后关闭原A → SFTP主tab及其job保留；关闭提升tab选择返回停靠时owner缺失 → 提供恢复owner入口，不绑定B。
4. Git执行同样往返并保留完整commit草稿/diff scroll；移动失败 → 原位置保持可用且错误可重试。

**证据与收尾**：panel/controller身份、可见实例计数、业务内容全值；D6只注入move目标失败，不直接把location改成结果。 执行 CMD-B；状态：待执行。

<a id="v-b20"></a>

### V-B20 / TC-SHELL-B20 — Git 默认底部、无仓库与多根异步隔离

- **归属**：AC-04、AC-13、AC-19；V-03；TASK-06；covers: [F25.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B20-git-owner-roots.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。W1/W2同路径不同instance；W1有repo A/B两root；另一个无.git目录。Git manager现有测试/同步函数为基线。
- **控件 / 支持**：工作区原Git入口、shell-host-owner/retry、Git root/status/empty action。 使用 §1 的真实操作与断言；新增项待实施。

1. 从W1点击Git → 底Host，Changes默认；owner显示W1，根列表准确，顶部不增加Git主tab。
2. hold A diff读取，切W1 root B再切W2 → 放行A后当前B/W2的diff/selection不改变；回W1 A才可见对应结果。
3. 无仓库打开Git → 明确empty及初始化/选择目录；取消初始化不产生.git；确认后成功刷新；失败保留empty+原因+重试。
4. 移除原root/关闭W1 → 旧generation回复不重开Host；独立Git G不被联动关闭。

**证据与收尾**：按owner/root的完整status/diff标识、no-repo操作结果；browser git init仅stub，N05检查真实.git。 执行 CMD-B；状态：待执行。

<a id="v-b21"></a>

### V-B21 / TC-SHELL-B21 — Git 子页、草稿、主标签与操作结果

- **归属**：AC-04、AC-09、AC-13、AC-18；V-03；TASK-06；covers: [F25.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B21-git-context-actions.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D2 repo A有3条改动、2分支、2提交；Git commit输入SHELL-COMMIT；旧WorkspaceGitManager为保留依据。
- **控件 / 支持**：Git Changes/History/Branches、原stage/diff/branch controls、shell-panel-promote/close。 使用 §1 的真实操作与断言；新增项待实施。

1. 在Changes选择修改并滚动diff，输入commit草稿；切History/Branches再回来 → 同一repo，完整输入与selection/scroll保持。
2. 执行现有stage/unstage与分支查询 → UI和stub业务结果一致；不支持的动作明确禁用，不能只弹完成toast。
3. 隐藏→开Tao→换主tab→回W1→promote→dock → 草稿/diff保持，只有一个Git controller。
4. Close Git时先取消草稿风险 → 草稿保留；明确丢弃再关闭 → 释放此view，其它workspace Git不变。

**证据与收尾**：完整draft、变更集合、owner/repo；Git真实字节和窗口链路见N05。 执行 CMD-B；状态：待执行。

<a id="v-b22"></a>

### V-B22 / TC-SHELL-B22 — Project/Problems/Terminal 与合并 Rail

- **归属**：AC-11、AC-13、AC-14、AC-16；V-03、V-06；TASK-02/06；covers: [F1.2、F25.5]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B22-workspace-tool-hosts.testcase.yaml`。
- **前置 / fixtures**：[reset_db、project_tree、shell_browser_catalog]。D2 W1打开文件并有单次编辑；mergeToolWindowRail true/false各独立子场景；旧TC-IDE-SHELLLAYOUT-01/02是保留基线。
- **控件 / 支持**：code-workspace-tree/editor-pane/bottom-dock-*、原tool-window controls；shell-navigator/shell-host。 使用 §1 的真实操作与断言；新增项待实施。

1. merge=true，通过Rail/原workspace action分别打开Project/Problems/Terminal → 一个对应Host/树，按钮与实际显示一致；内部重复stripe不存在。
2. 树选文件→进入编辑器→输入一个字符→开Problems/Terminal→Esc回编辑器 → 完整文本/selection不变，undo只撤销该字符。
3. Shift+F12隐藏工具窗，再恢复 → 原选中与尺寸恢复；不隐藏全局Tao，不修改另一个workspace。
4. 改merge=false → 内部rail接管原工具入口，Global Rail仍在；Project只有一个可交互视图，展开/rename草稿/树滚动保留；改回true仍一致。
5. 通过编辑器 fill 一次替换为完整三行（最后一行 host-tab-edit）→ 打开 Terminal，再通过 Host 标签切换 Problems/Terminal → 三行文本完整保留；一次 Undo 恢复编辑前的完整三行，仍只有一个 editor/Project。此处明确使用单次输入事务，逐字符 type 的撤销分组不作为该条验收的前提。

**证据与收尾**：树/编辑器实例与完整内容、焦点/快捷键结果；实际disk与provider边界由N06。 执行 CMD-B；状态：待执行。

<a id="v-b23"></a>

### V-B23 / TC-SHELL-B23 — Host 尺寸、固定、换边和隐藏焦点

- **归属**：AC-05、AC-08、AC-11、AC-13；V-03、V-06；TASK-02/04；covers: [F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B23-host-resize-placement.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。W1底Git+A右Files均有保存的用户宽高；通过切owner验证pin不锁owner，read-only几何观察。
- **控件 / 支持**：shell-host-resize/pin/hide/more/owner；separator aria。 使用 §1 的真实操作与断言；新增项待实施。

1. 拖右Host到低于280/超过max → clamp正确；底Host对应220/max；pointercancel/Esc撤销本次拖动，storage不存取消值。
2. 键盘Arrow步进8、Shift步进32、Home/End到边界 → aria-valuenow与rect一致，live region不每像素刷屏。
3. pin/unpin、right/bottom互换 → 内容/scroll保持；缩小导致overlay不覆写pin/尺寸；回宽恢复用户原值。
4. pin A后切B → A不会留着冒充B；隐藏Host后Tab遍历不进入隐藏控件；再次打开焦点落标题/首控件，已在别处输入时迟到ready不抢焦点。

**证据与收尾**：geometry JSON、持久化前后值、activeElement序列；resize强制业务重mount为失败。 执行 CMD-B；状态：待执行。

<a id="v-b24"></a>

### V-B24 / TC-SHELL-B24 — Tao 同边仲裁与当前 owner 恢复

- **归属**：AC-05、AC-13；V-04；TASK-04/07；covers: [F-TAO-1、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B24-tao-host-arbitration.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。A右Files requestedOpen=true；W1底Git；Tao默认right，D1。原ChatDrawer与主布局为静态基线。
- **控件 / 支持**：shell-rail-tao、顶部Tao入口、ai-chat-drawer-hide、shell-panel-toggle、shell-host。 使用 §1 的真实操作与断言；新增项待实施。

1. 打开右Tao → 右Files suppressed但requestedOpen/size/pin保持；关闭 → A的Files恢复原大小/内容；无两个窄栏同时占右边。
2. Tao开时切B再关闭 → 按B自己的面板记录恢复；若B无面板则为空，不恢复A Files；关闭A后同样不复活幽灵面板。
3. 开Tao后显式打开A Files → Tao隐藏、Files可操作；重复快速toggle20次最终状态等于最后动作，无两个Hub实例。
4. W1底Git和右Tao同时开 → 都可读；把Tao移到底边 → Git被抑制，关闭Tao后恢复；窄屏只一个主体覆盖层。

**证据与收尾**：每次有效visible/suppressed/owner状态与rect、内容快照；不以隐藏DOM存在就断言可见。 执行 CMD-B；状态：待执行。

<a id="v-b25"></a>

### V-B25 / TC-SHELL-B25 — Chat 绑定、流式生成和 Notes 草稿生命周期

- **归属**：AC-05、AC-13、AC-19；V-04；TASK-07；covers: [F-TAO-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B25-tao-context-lifecycle.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1，A/W1各chatTabId；D6流式回复可hold；Notes有未完成编辑。ChatDrawer keep-alive为保留依据。
- **控件 / 支持**：tao-hub-tab-*、ai-chat-drawer-hide、shell-tao-context、note-editor、真实Chat输入/发送。 使用 §1 的真实操作与断言；新增项待实施。

1. A里发送一次本地fixture回复并hold，切W1 → follow-active标明W1；A流式结果继续归A，W1不出现A消息。
2. 固定A thread后换tab → 绑定仍明确显示A；取消固定后跟随当前；回复完成通知揭示正确thread。
3. 在Notes输入标题/正文，切Notifications→hide→reopen→Notes → 全文和scroll保持；新建Notes不因重开重复。
4. Hub加载一部分失败 → 已可用tab保持操作，Retry只重试失败部分；初始化结束不得抢正在别处输入的焦点。

**证据与收尾**：每thread完整消息集合、绑定badge、Notes全文、外部生成次数；不接真实付费provider，本用例不证明服务质量。 执行 CMD-B；状态：待执行。

<a id="v-b26"></a>

### V-B26 / TC-SHELL-B26 — 四类通知、成功后确认与历史去重

- **归属**：AC-06、AC-19；V-04；TASK-07；covers: [F-TAO-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B26-notification-routing.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D3共5条，mail行count=2但Tao badge=5；准备活owner、已关闭可恢复owner、缺失owner各场景。旧TC-NOTES-007只作为历史控件基线。
- **控件 / 支持**：tao-alert-inbox-item/jump/ack/history-*；新增shell-alert-error/retry。 使用 §1 的真实操作与断言；新增项待实施。

1. 按chat/note/mail/transfer完成/transfer失败分别点击 → 正确thread/note/account/job可见后才ack这一条；mail unread不因打开账户清零、note不自动完成。
2. 目标关闭可恢复 → 经restore/认证成功才ack；认证取消、owner缺失或服务失败 → 保留该提醒与badge，明确恢复/重试；修复后跳转成功仅清对应条。
3. 重复同job终态/旧generation事件 → 无重复待处理/历史；新的job独立计数；传输progress不新增未读。
4. 手动ack→历史出现，空search不显示历史；检索精确已确认项，切30/300严格截断；清历史取消保持，确认只清历史、不清当前pending。
5. 以fixture服务事件产生101条不同提醒 → 视觉99+、aria准确101；依次确认到99/1/0 → 数字与隐藏边界正确，同id重复事件不增加总数。

**证据与收尾**：每动作前后pending/history完整ID集合、目标ready与ack顺序、mail unread和note状态；新增transfer来源是待实施。 执行 CMD-B；状态：待执行。

<a id="v-b27"></a>

### V-B27 / TC-SHELL-B27 — AI 关闭与局部失败时的独立能力

- **归属**：AC-05、AC-19；V-04；TASK-07；covers: [F-TAO-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B27-tao-ai-disabled-errors.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。Notes和pending通知存在；AI master关闭；Notes读取失败和通知poll失败可分别注入。旧MainLayout aiFullyDisabled gating是有意改变点。
- **控件 / 支持**：AI master设置、shell-rail-tao、tao-hub-tab-*、shell-tao-error/retry。 使用 §1 的真实操作与断言；新增项待实施。

1. 关闭AI后从Rail和顶部各打开Tao → Hub仍可访问，Chat显示禁用说明/设置入口；Notes/Notifications正常，不能整Hub消失。
2. 通过设置启用AI → Chat可用且Notes草稿/通知不重置；provider缺失时显示配置入口，不是假加载完成。
3. 只让Notes读取失败 → Notifications仍可处理；Retry成功恢复Notes；只让通知poll失败 → 草稿/Chat可用，旧提醒保留并标错误。
4. 错误中hide→重开→切owner → 不无限重复网络请求、不跳到错误owner；错误文字有role alert且可键盘重试。

**证据与收尾**：三tab可用性、草稿与pending集合、独立失败/恢复记录；无需native重复所有文案分支。 执行 CMD-B；状态：待执行。

<a id="v-b28"></a>

### V-B28 / TC-SHELL-B28 — Notes 浮层/弹出入口和返回的一致性

- **归属**：AC-05、AC-18；V-04；TASK-07/09；covers: [F-TAO-1、F-Detach-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B28-notes-browser-detach.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。Notes已创建SHELL-NOTE并编辑；browser沿原浮层或可控popup路径，不把它声称OS窗口。旧TC-NOTES-004为基线。
- **控件 / 支持**：notes-floating-toggle、floating-notes-panel/dock、note-editor-title；shell-detached-*。 使用 §1 的真实操作与断言；新增项待实施。

1. 默认从Tao进入Notes → 没有自动浮层；显式弹出 → 单个浮层/子页，原处显示已弹出，内容完整。
2. 再次弹出 → 聚焦同实例；回停靠 → 只有Hub的一个可交互Notes视图，编辑与主题不丢失。
3. D6使创建失败/blocked → 原Notes仍可编辑、提示可重试，短期handoff已清；不显示假detached。
4. dirty草稿的关闭先取消再确认保存 → 取消保持；保存完成后位置更新；完整Hub在标签/原生窗口的未支持入口不出现。

**证据与收尾**：Notes全文、可见实例数、失败handoff状态；真实Notes DB和原生always-on-top/窗口见N07。 执行 CMD-B；状态：待执行。

<a id="v-b29"></a>

### V-B29 / TC-SHELL-B29 — 主题、语言、名称显示与文本边界

- **归属**：AC-07、AC-08、AC-14；V-06；TASK-02/11；covers: [F1.2、F1.3、F-I18n-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B29-theme-language.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1；light/dark/system、中文/英文；长host/path、emoji；原TC-MAIN-RAIL-02保留语言/名称偏好结果。
- **控件 / 支持**：theme-cycle、language-switcher/option-*、sidebar-rail-menu-show-names；新Shell控件。 使用 §1 的真实操作与断言；新增项待实施。

1. 通过更多中的外观入口切light/dark/system → Shell/Host/Hub/Menu/Overview均使用同主题，无旧硬编码暗背景；保存后reload生效。
2. 切中文/英文 → 可见标签、tooltip、aria-name、空/error/disabled reason同步，没有raw i18n key或只翻译标题。
3. 开/关工具名称显示，拖Rail宽度后切workspace/reload → 原偏好保持且空间求解适配，不生成第二stripe。
4. 在1440与800宽、两语言各开总览/菜单 → 控件不遮窗口按钮，长文本可省略但详情可读；reduced-motion下焦点与结果不依赖动画结束。

**证据与收尾**：四个代表组合截图+geometry/对比度人工结果；system主题使用runner环境模拟记录，不能冒充OS高对比实测。 执行 CMD-B；状态：待执行。

<a id="v-b30"></a>

### V-B30 / TC-SHELL-B30 — 所有宽度边界、低高度与覆盖层恢复

- **归属**：AC-07、AC-08；V-06；TASK-02/04；covers: [F1.2、F1.3、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B30-responsive-breakpoints.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。W1+底Git、A右Files、Navigator248/Tao360用户偏好；按序viewport=1440/1200/1199/960/959/720/719/640/560/559/400/320，height900后600/480。
- **控件 / 支持**：set_viewport已有browser-only；shell-root/navigator/host、ai-chat-drawer、shell-overview-trigger。 使用 §1 的真实操作与断言；新增项待实施。

1. 逐个宽度进入且打开Navigator/Host/Tao → 与主设计断点一致，主工作面不被负宽度挤没，系统按钮/总览/面板/Tao可达；小于560标题为两行共84，系统区保持第一行，body高度据实重算。
2. 在临界值同时开占空间区域 → 先临时折Navigator，再侧Host overlay；底部高度不足时overlay；同边最多一个Host且只一个主覆盖层。
3. 959/719/400/320宽依次打开导航/总览/Host/Tao，Tab/Shift+Tab/Esc → 每层可退出并恢复焦点，背景不漏输入，关闭按钮不被滚出；覆盖层可小于280但不遮Rail，单列卡片不强制280造成溢出。
4. 返回1440×900 → 原248/330/280/360用户偏好恢复，临时clamp未持久化；没有整体横向滚动或不可点的固定入口。

**证据与收尾**：各阈值rect/visible/overflowX与四个关键截图；CSS viewport测试不代替真实200%缩放，后者N16。 执行 CMD-B；状态：待执行。

<a id="v-b31"></a>

### V-B31 / TC-SHELL-B31 — 无障碍语义、焦点路径与组合输入

- **归属**：AC-08、AC-11、AC-16；V-06；TASK-02/03/04；covers: [F1.2、F1.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B31-a11y-focus-composition.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1，Shell在宽/窄各一场景；搜索/rename/Notes中输入中文组合；所有overlay opener可识别。
- **控件 / 支持**：Rail nav、tablist/tab/tabpanel、dialog、combobox/listbox、separator；compose_text/press/read-only DOM已有。 使用 §1 的真实操作与断言；新增项待实施。

1. 从Home仅用Tab/Shift+Tab走Rail、标签、面板、Tao、更多 → 焦点可见、顺序合理，隐藏surface不能获焦；tab选中与panel labelledby关联唯一。
2. 开Quick/Overview/Close modal → 背景inert，Tab循环；弹出子菜单后Esc只关子菜单，第二Esc关对话层，原工作面不被额外隐藏。
3. 搜索/rename/Notes使用compose_text并在composing期间送Enter/Escape/Delete → 不误激活/关闭/删tab，compositionend后提交结果正确。
4. 用键盘调整separator和移动tab → 与pointer结果一致，有aria值/完成提示；连接error/busy/unread均有文本名，不只颜色。

**证据与收尾**：accessibility结构、activeElement序列和精确输入值；真实screenreader/IME列N10/N16，browser组合事件不是实机IME。 执行 CMD-B；状态：待执行。

<a id="v-b32"></a>

### V-B32 / TC-SHELL-B32 — 终端、编辑器、邮件和 remote 的按键所有权

- **归属**：AC-11、AC-14、AC-16；V-06；TASK-03/06；covers: [F1.5、F25.5]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B32-shortcut-owner-regression.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。A终端支持AI rewrite；W1有关闭编辑tab可reopen；Mail搜索，VNC焦点；焦点在输入区、modal、chrome分别检查。
- **控件 / 支持**：terminal-pane、code-workspace-editor、原AI rewrite/TabSwitcher/mail search；shell-quick-dialog。 使用 §1 的真实操作与断言；新增项待实施。

1. 终端焦点Ctrl+K → 原AI改写或终端自身处理，Shell快切不弹；read-only/alternate screen的claimed-disabled路径不落到Shell；Shell chrome Mod+K才开快切。
2. W1里Ctrl/Cmd+Shift+T → reopen editor一次、不创建local terminal；Control+Tab→原editor switcher，Cmd+1在macOS工作区→Project，Shell不抢。
3. Mail中的已绑定搜索组合和普通input编辑组合 → 保留原动作/文本，Shell不吞；VNC/RDP remote capture宣告占用时Shell不切tab。
4. modal打开后重按上述组合、Esc退出后再按 → modal保护优先，关闭后路由恢复；多次开关/StrictMode初始化不产生两次业务效果。

**证据与收尾**：按focus context记录实际目标结果和输入全文；OS保留键与真实remote交付N10/N14。 执行 CMD-B；状态：待执行。

<a id="v-b33"></a>

### V-B33 / TC-SHELL-B33 — 标题栏能力、更多菜单与旧 Action 入口

- **归属**：AC-07、AC-14、AC-17；V-06；TASK-02/03；covers: [F1.3、F1.8、F1.9]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B33-toolbar-capability-menus.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1；分别active Home、SSH、local terminal、VNC、workspace、Mail；原ControlBar/AppCommand/TabActionSlot为基线。
- **控件 / 支持**：app-main-menu、context-menu-item-*、tab-action-slot、tab-split-view/multiexec-toggle；新shell-context-menu/global-menu。 使用 §1 的真实操作与断言；新增项待实施。

1. 各active type打开上下文更多 → Files/Git/detach/split等按capability显示或明确禁用；不显示上一tab遗留action。
2. 分别从原App menu与新更多进入new-terminal/new-session/new-sftp/code-workspace/git/settings → 同业务目标/参数，错误状态可见；unsupported detach不假成功。
3. 外观/语言/更新移入全局更多后实际点击 → 原功能可用；capture/PTT按支持条件保留入口和权限反馈。
4. 打开A menu后切B再点该菜单旧目标动作 → 检查A仍存在后操作A或明确失效，不默默操作B；window controls前有分隔且不会拖动触发menu。

**证据与收尾**：每context完整菜单项/disabled理由、实际业务目标，截图对比标题分组；系统min/max/close结果只N01。 执行 CMD-B；状态：待执行。

<a id="v-b34"></a>

### V-B34 / TC-SHELL-B34 — 旧偏好到 v2 的一次迁移与单写者

- **归属**：AC-10；V-01、V-06；TASK-10；covers: [F1.2、F-TAO-1、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B34-layout-legacy-migration.testcase.yaml`。
- **前置 / fixtures**：[reset_db]。D4，通过seed_storage写旧key后reload；另有已有合法v2且旧key不同的一组。sidebarRailPolicy/chatStore旧格式为事实基线。
- **控件 / 支持**：seed_storage/reload_window/assert_localstorage；shell-navigator、ai-chat-drawer、layout warning。 使用 §1 的真实操作与断言；新增项待实施。

1. 无v2启动 → Connect collapsed=true，Build=false，其它取other=false；Navigator由旧百分比一次换算并clamp；Tao left/pinned/380/.8精确保留。
2. 拖新尺寸/换edge并reload → 从v2读取新值；修改旧key再reload不反向覆盖v2；旧key仍存在可供回退。
3. 调用兼容旧入口改变Tao/侧栏 → 唯一写入者更新新状态，无来回跳尺寸或storage事件循环。
4. 未知/缺失旧字段 → 相应默认，现有session/Notes内容不变；对同migration连续初始化（含StrictMode）只得到相同语义布局。

**证据与收尾**：解析后的完整v2对象、原key/业务记录保留、视图值与storage一致；本例不证明进程重启，见N08。 执行 CMD-B；状态：待执行。

<a id="v-b35"></a>

### V-B35 / TC-SHELL-B35 — 损坏、超限、未知版本和写失败

- **归属**：AC-10；V-01、V-06；TASK-10；covers: [F1.2、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B35-layout-corruption-reset.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D4 malformed JSON / wrong type / NaN等非法字段 /极值尺寸 / version999；D6 storage写失败；已有保存session/Note/工作集。
- **控件 / 支持**：shell-layout-warning/reset/fallback-home；seed_storage/reload_window、已有confirm-dialog。 使用 §1 的真实操作与断言；新增项待实施。

1. 分别加载损坏/非法尺寸 → 安全默认或字段clamp，窗口仍可操作且不删业务记录；错误不导致startup循环。
2. 加载version999 → 使用内存默认，原raw数据不覆盖；允许显式reset；连续resize不把不认识的数据静默写成v2。
3. storage写失败后拖布局 → 内存立即生效、一次非阻塞warning；恢复可写后下一次明确修改保存成功；不刷无限toast。
4. 点reset先取消再确认 → 取消原布局保留；确认只重置壳层，sessions/Notes/工作集精确不变；fallback可回Home打开既有业务。

**证据与收尾**：所有raw/解析后prefs及业务集合hash、错误恢复截图；storage fault只能controlled fixture，不用eval_readonly mutation。 执行 CMD-B；状态：待执行。

<a id="v-b36"></a>

### V-B36 / TC-SHELL-B36 — 弹出准备、ready、失败、超时与旧消息

- **归属**：AC-09、AC-13、AC-18；V-03；TASK-04/09；covers: [F-SHELL-1、F-Detach-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B36-detach-transaction-browser.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。Git/SFTP可移动panel；D6控制window open/ready/close，记录operationId/generation；这些是browser transport边界stub。
- **控件 / 支持**：shell-panel-detach/reattach、shell-detached-placeholder/focus/error；已有源业务controls。 使用 §1 的真实操作与断言；新增项待实施。

1. 点击detach后hold ready → 源仍可操作或显示明确pending且不销毁，只有一个准备operation；连续点击不再开第二目标。
2. ready成功 → 源变占位，聚焦现有窗口入口可执行；重复ready/reattach同ID只提交一次。
3. 分别让create失败、ready超10秒、目标加载失败 → 回源原位置/内容，错误可retry，handoff按约定清理；不能把open promise成功当业务ready。
4. 准备中关闭owner/改root后释放旧ready → 拒绝旧generation并清目标；回停靠时目标slot未ready不可先关源窗口，失败保留可用view。

**证据与收尾**：UI时序与transport envelope、精确窗口逻辑数量；真实OS window/连接由N04/05/07/18。 执行 CMD-B；状态：待执行。

<a id="v-b37"></a>

### V-B37 / TC-SHELL-B37 — 分屏与多执行的目标集合、输入锁和关闭

- **归属**：AC-09、AC-13、AC-17；V-03；TASK-02/04；covers: [F1.3、F1.5]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B37-split-multiexec.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。A/B/C三终端stub，有不同输出和C输入锁；原TC-102/110及MainLayout split逻辑为保留基线。
- **控件 / 支持**：terminal-split-toolbar/pane/resize-handle、tab-multiexec-toggle、多执行选择控件、shell-context-menu。 使用 §1 的真实操作与断言；新增项待实施。

1. 从新上下文菜单开split并调整布局 → 三pane目标与原terminal IDs一致，调整divider不变tab顺序；活动pane高亮明确。
2. 多执行选A/B/C并锁C，输入nonce → 只A/B收到一次，C零次；隐藏Tao/Host后再输入仍相同，不能广播给后台DB/Mail。
3. 关split再开，切Build后回Connect → 原选择/输入锁按既有语义保留，后台终端不断线；focus仍落实际活动pane。
4. 关闭B先取消再提交 → cancel不改变split，commit后目标集合/锁集合移除B，A/C保持；有job时所有入口走同一风险检查。

**证据与收尾**：每pane独立输出/目标完整集合、divider rect与关闭后状态；真实PTY进程与输出由N02/N15。 执行 CMD-B；状态：待执行。

<a id="v-b38"></a>

### V-B38 / TC-SHELL-B38 — 异类主工作面的编辑和长任务保留

- **归属**：AC-13、AC-16、AC-17；V-03；TASK-02/04/12；covers: [F1.2、F1.5]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B38-shared-surface-retention.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D-ALL/D2：DB查询中、Mail草稿、Redis选择、HBase文本、object-storage队列、LANChat输入、VNC/RDP画面尺寸、Code单次编辑。只改外层宿主。
- **控件 / 支持**：各业务原控件与tab-item、shell-lane-select/overview；只读具体状态观察，不mirror整store。 使用 §1 的真实操作与断言；新增项待实施。

1. 每种可变surface输入唯一marker/选择一项/开始支持的长任务；依次跨lane切换20次并插入Tao/Overview开关 → 返回各surface后完整文本/selection/job进度保持。
2. Code执行undo后redo，DB草稿切query后返回，Mail重开草稿 → 历史与业务状态正确，不因壳层移动成为新实例。
3. 在inactive surface送迟到回包 → 不改变current tab或其选择；remote隐藏期间不发送0×0 resize，恢复可见才fit一次有效尺寸。
4. 关闭一个不同类型tab → 其余surface的连接/草稿/队列保持；未知fallback也不使root error boundary卸载全部工作面。

**证据与收尾**：按类型的前后完整marker/状态表与边界调用记录；不对未受影响协议做全功能测试；代表真实运行由N02～N06/12～N14。 执行 CMD-B；状态：待执行。

<a id="v-b39"></a>

### V-B39 / TC-SHELL-B39 — 100 标签检索、连续操作与性能观察

- **归属**：AC-02、AC-13、AC-20；V-02、V-06；TASK-03/12；covers: [F1.5、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B39-large-tab-churn.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。UI创建100个主tab含同名/长名/20个busy；固定seed和MRU顺序；独立基线/候选相同硬件Chromium。无已执行性能基线。
- **控件 / 支持**：shell-tab-search/card/sort、shell-quick-*；只读performance/DOM观察由TASK-11 collector实现或runner外收集。 使用 §1 的真实操作与断言；新增项待实施。

1. 打开总览输入只命中第100项的词并Enter → 正确active，计数和排序全集无丢失/重复；虚拟化时键盘可跨全部结果。
2. 5次预热后30次记录打开可交互/输入过滤结果/切tab可见完成时间 → 保留全部raw样本与p50/p95，不能用case总耗时替代。
3. 20次切lane、开关Host/Tao、关闭重开总览 → 结果全集仍正确，焦点不失踪；外部连接和listener观察无持续增长。
4. 与两次相同条件基线噪声比较 → 已确认新增慢化须处理；没有基线只报未验证，不生成“性能通过”。

**证据与收尾**：dataset/source/profile、raw timing、长任务与内存趋势、功能结果集；native热路径与进程资源另N17。 执行 CMD-B；状态：待执行。

<a id="v-b40"></a>

### V-B40 / TC-SHELL-B40 — 每个暴露入口连接同一 Action 结果

- **归属**：AC-02、AC-11、AC-14、AC-17；V-02、V-06；TASK-03/11；covers: [F1.5、F1.8、F1.9、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B40-action-entry-matrix.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1；按主设计§5.1逐个action建立入口清单。此用例验证接线，各业务深分支复用对应B，不跳过不同入口。
- **控件 / 支持**：Rail/toolbar/context-menu/视图菜单/command registration；新shell action controls。 使用 §1 的真实操作与断言；新增项待实施。

1. Home、Navigator、Quick/Overview、Tao：分别点击所有已暴露入口 → 同目标surface和状态变化；Command入口必须从真实搜索/action菜单执行，不直接调用dispatcher。
2. panel open/hide/pin/move/promote/detach/close：从toolbar、Host menu与workspace action各执行 → owner/结果一致；不可用context显示同disabled reason。
3. tab close/rename/duplicate/move/pin：从strip menu和Overview menu分别操作 → 对同tab生效；菜单旧target被删除后错误可理解且不作用于新active。
4. layout reset先取消、全局settings/theme/import入口分别操作 → 对应契约可见；记录实际无暴露入口为N/A并说明代码依据，不虚构全局命令面板。

**证据与收尾**：actionId×入口×context×结果的完整表；B14覆盖关闭深分支，此case不能只比较handler调用次数。 执行 CMD-B；状态：待执行。

<a id="v-b41"></a>

### V-B41 / TC-SHELL-B41 — Tao 四边停靠、固定、透明度与旧入口

- **归属**：AC-05、AC-10、AC-13；V-04；TASK-07/10；covers: [F-TAO-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B41-tao-legacy-edge-preferences.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D4 legacyleft+pin+.8；右Files、底Git、Navigator均有状态。旧TC-NOTES-005/006为保留能力依据。
- **控件 / 支持**：ai-chat-drawer-position/pin/opacity/hide、旧Ribbon入口；新布局menu。 使用 §1 的真实操作与断言；新增项待实施。

1. 从旧Ribbon和新Rail分别打开 → 同Hub，记录的left edge/pin/opacity生效；旧入口不创建第二个drawer。
2. 逐次选left/right/top/bottom并pin/unpin → 抑制对应Navigator/Host，另一edge内容不受影响；顶部不盖标题栏、底部不盖status。
3. 调整宽/高/透明度及旧Ribbon在edge的位置→hide→reload→reopen → 合法偏好和ribbonOffsetRatio保留；透明度只作用Hub，不使关闭按钮失去可读性。
4. 窄屏临时overlay后回宽 → 原edge/pin/尺寸恢复；Notifications本次选中保持但重启默认只恢复last chat/notes。

**证据与收尾**：四edge rect/视觉截图、prefs与原输入内容；native定位/DPI由N16，实际Notes浮窗N07。 执行 CMD-B；状态：待执行。

<a id="v-b42"></a>

### V-B42 / TC-SHELL-B42 — 恢复 identity、同路径实例与失效 owner

- **归属**：AC-10、AC-15；V-01、V-05；TASK-08/10；covers: [F1.6、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B42-restore-identities-orphans.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。W1/W2同路径各自不同instance和panel prefs；A保存session后来被删除；上次Git detached intent；D6恢复ready可乱序。
- **控件 / 支持**：welcome-restore-*、shell-host-owner、shell-recent-panel、shell-detached-placeholder、shell-layout-warning。 使用 §1 的真实操作与断言；新增项待实施。

1. 保存布局/reload页面 → 初始Home，不凭旧backendSessionId假装连接；显式恢复，W2先ready/W1后ready → panel/lastActive绑定正确entry identity。
2. W1右Git/W2底Git各自prefs与选中独立，laneOverride/pin/order不会按相同path合并。
3. 缺失A owner的最近面板 → 显示选择/重新打开连接；用户取消无新tab，成功选目标后才新绑定；不能自动绑定同名B。
4. 旧detached记录 → 可恢复意图/重新弹出按钮；未认证前没有窗口；未知owner/layout部分失败不阻止其余恢复成功。

**证据与收尾**：恢复前后restoreRef→新tabId/instance映射及实际窗口逻辑数；真正进程重启和磁盘留N08。 执行 CMD-B；状态：待执行。

<a id="v-b43"></a>

### V-B43 / TC-SHELL-B43 — 会话树、工具页与快速连接回归

- **归属**：AC-14、AC-15；V-06；TASK-02/08；covers: [F1.2、F1.8、F1.9]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B43-navigator-retained-workflows.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。保存session含目录、SSH/SFTP/DB/Mail；旧TC-013/036/039/054/055和ToolsPanel是受影响消费者。
- **控件 / 支持**：session-tree/search/new、qc-input/submit、context-menu-item-*、原sidebar工具入口；新Navigator工具页。 使用 §1 的真实操作与断言；新增项待实施。

1. 通过Sessions建目录、移动session、搜索、复制、右键编辑 → 保存数据/树路径正确；切Navigator后返回展开/selection不丢。
2. 从应用菜单导入一个小JSON样本并导出 → 导入预览/重复选择/取消语义保留，结果sessions一致；模拟文件选择只限browser，真实pickerN11。
3. 从视图开启QuickConnect，空输入提交→验证提示；有效SSH stub连接→真实opener生成Connect tab；Home返回和history不丢。
4. 经Workspaces工具页和原应用工具菜单逐项打开服务器、隧道、SocksCap、MFA、网络工具 → 可达原业务页/对话框，disabled平台能力有原因；不因去掉Tools rail按钮失去入口。

**证据与收尾**：保存session树/导出数据、每工具路由结果；不扩展工具内部未改业务的整套测试。 执行 CMD-B；状态：待执行。

<a id="v-b44"></a>

### V-B44 / TC-SHELL-B44 — 遮挡、拖动命中、菜单层级与焦点隔离

- **归属**：AC-07、AC-08、AC-11、AC-20；V-06；TASK-02/04；covers: [F1.2、F1.3、F-SHELL-1]；目标与保留结果见步骤。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-B44-layering-hit-regions.testcase.yaml`。
- **前置 / fixtures**：[reset_db、shell_browser_catalog]。D1；宽屏/959/719与低高；系统平台布局用现有platform stub，模拟mac仅测CSS不称原生交通灯。
- **控件 / 支持**：window-drag-handle、window-controls、shell-overview、context-menu、shell-close-dialog、shell-host。 使用 §1 的真实操作与断言；新增项待实施。

1. 逐一click标题动作/drag tab/resize divider → 不触发window drag；只读rect证明grip不跨交互元素，按钮最小hit target满足设计。
2. Host→菜单→Overview→关闭确认按允许入口叠层 → 最顶层可操作，下面不接收输入；确认取消返回原层与正确focus。
3. 大内容滚动Host/Overview → header/关闭仍可见；滚轮不把整个窗口内容推出；没有卡片盖住系统按钮或状态栏。
4. 切宽/主题/语言后重复 → geometry/stacking/inert保持；截图逐项判定遮挡、截断、对比度，不把截图生成记成视觉pass。

**证据与收尾**：rect/hit-test/activeElement与已审截图，原生窗口drag/traffic lights/high DPI仍由N01/N16。 执行 CMD-B；状态：待执行。


<a id="native-cases"></a>

## 4. Native 详细用例

共同 `modes: [native]`、验证族 V-07、CMD-N / MN-1、Windows/WebView2、macOS/WKWebView、Linux/WebKitGTK。每条同时列自动化能证明的部分与必须手工/外部观察的部分；没有通用跨窗口/重启 verb 时，不写一个只检查主窗口就“全通过”的 YAML。用例总结果要求其全部必要检查完成。

真实服务必须是本轮 disposable fixtures，禁止使用个人服务器/收件箱/项目。SSH/SFTP 配置用 QA_SSH_PASSWORD；MySQL 用 TAOMNI_TEST_MYSQL_PASSWORD 和必要 root 变量；VNC 用 QA_VNC_PASSWORD。AI/邮件测试只与本地测试 endpoint 交互。本轮没有启动或调用这些服务。

<a id="v-n01"></a>

### V-N01 / TC-SHELL-N01 — 真实窗口拖动、缩放、系统按钮与退出取消

- **归属 / 用途**：AC-07、AC-11、AC-17；V-07；TASK-02/12；covers: [F1.3]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N01-window-controls-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db]。隔离QA主窗口1280×800，打开一个有输出的local terminal。记录外部OS矩形和window label；旧TC-100只证明控件存在，TC-MAIN-RAIL-03仅Linux拖动。
- **native 必要性**：Browser不能证明OS窗口移动/最大化/最小化/真正关闭。
- **模式与支持**：主窗DOM可用click/press；Linux/X11已有native_window_drag。Windows/macOS用MN-1手工+OS外部rect，macOS使用真实交通灯；不伪造native_platforms全自动支持。

1. 在窗口grip上/中/下各拖24×18逻辑px → 外部OS读数出现对应位移且大小不变；随后点Rail/标签 → 控件可用。macOS同时验证标题安全区。
2. 通过真实最大化/还原、最小化/任务栏或Dock恢复 → 状态正确，terminal marker保留，resize不覆盖标题/关闭按钮。
3. 点OS关闭 → 应用退出确认可见；取消 → 同一QA进程/PTY继续可输入；菜单退出的取消有相同结果。
4. 确认退出 → 只本次QA进程/子窗口关闭；记录退出码/资源清理；恢复测试前窗口位置与大小。

**证据 / 清理**：OS前后rect、屏幕录制、进程/PTY marker、退出结果；所有三端分别记录，Linux Xvfb不替代物理桌面。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n02"></a>

### V-N02 / TC-SHELL-N02 — PTY、cwd 复制与分屏切换持续可用

- **归属 / 用途**：AC-01、AC-13、AC-15、AC-17；V-07；TASK-03/08/12；covers: [F1.6、F1.5、F2.1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N02-pty-keepalive-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、workspace_root]。独立QA目录（含空格/中文）和平台默认shell；无SSH。既有TC-NATIVE-CORE-001、TC-WELCOME-RS-N-04为待执行基线。
- **native 必要性**：Tab出现与stub输出不能证明真实ConPTY/PTY进程存在、cwd继承或未重连。
- **模式与支持**：terminal_input/press/assert_pattern在三端WebView可用；外部PID观察由MN-1，terminal_input不是物理键盘证据。

1. Home选默认shell启动 → 等data-terminal-ready，再执行echo QA_NATIVE_SHELL_READY，断言独立整行输出；保存本shell PID/实际cwd。
2. cd到fixture目录、输入未提交片段；hide Host/Tao、跨lane20次返回 → 片段仍在；提交唯一nonce后断言单独输出，原PID/cwd不变。
3. 复制该terminal → 新PTY PID、相同cwd/profile；手动重命名后原shell再cd → 手动名保留。WSL/管理员仅在该平台实际支持时另记录条件分支，不能在其它端假显示。
4. split A/B多执行仅选A，发送marker → A有输出B无；关闭复制tab → 仅其PID退出，原A继续输出；最后清理本次shells。

**证据 / 清理**：每步PID/cwd/整行marker、命令文本和预期副作用；不把输入命令自身的echo或prompt当执行证明。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n03"></a>

### V-N03 / TC-SHELL-N03 — 真实传输隐藏、后台交接、取消与 hash

- **归属 / 用途**：AC-03、AC-06、AC-09、AC-13；V-07；TASK-05/07/12；covers: [F7.4、F-SHELL-1、F-TAO-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N03-sftp-transfer-background-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、ssh_required、sftp_required、shell_native_files]。D5 loopback sshd已过SSH banner与登录验证、SFTP可列专用目录；文件16MiB，fixture网络限速256KiB/s（拟新增支持，由TASK-11落实）以观察活动状态。禁止测试个人目标。
- **native 必要性**：必须证明真实SFTP字节、backend lease与owner关闭后的工作连续性，browser只能模拟progress。
- **模式与支持**：quick_connect/auth/terminal_input及已有文件UI可自动；远端SHA-256独立SSH/容器读取并存receipt；若上传picker不能自动，按MN-1真实选fixture文件。

1. 连接A上传文件，确认远端临时大小在增长；暂停 → 多次外部观测大小稳定；resume → 继续增长；隐藏Files再开Tao/切B → 上传继续。
2. 关闭A选择取消关闭 → A仍可用；再次选继续后台 → A删除后job仍增长，通知/状态栏可进入正确Transfers，不误指向B。
3. 等完成 → 独立远端sha256sum与本地Get-FileHash/Python hashlib相等；点击通知确实揭示该job后ack。
4. 以另一文件在B传输中选取消并关闭 → 等取消终态，远端无完整成功文件（残留按原产品策略标明），UI不能记completed；A完成文件保持不变。
5. 测试结束只删除fixture专用目录/文件并关闭QA连接，检查无遗留活动transfer；保留hash与取消残留的观察。

**证据 / 清理**：真实远端字节/大小时间序列/hash、暂停/恢复/取消以及owner/job identity；限速支持缺失应补fixture或记录阻塞，不跳成pass。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n04"></a>

### V-N04 / TC-SHELL-N04 — SFTP 原生弹出独立通道与任务关闭保护

- **归属 / 用途**：AC-03、AC-09、AC-18；V-07；TASK-05/09/12；covers: [F7.4、F-Detach-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N04-sftp-window-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、ssh_required、sftp_required、shell_native_files]。A已连、Files有路径/选择；D5专用目录；原TC-043断言不足，需本例真实窗口和通道。
- **native 必要性**：必须证明新OS窗口、独立backend session、任务没有因view/窗口关闭而丢失。
- **模式与支持**：跨窗口/OS X用MN-1；main DOM自动部分只检查占位/ready。当前无switch_window verb；TASK-11若实现必须另验。

1. 点弹出 → 先看到源pending，子窗口实际ready后源占位；用OS窗口列表确认唯一label。重复点 → 聚焦原窗口，不新建第二。
2. 子窗口更换目录/上传fixture，与原channel已有job并存 → 新browser channel identity不同；原任务仍增长，终端输入不阻塞。
3. 活动上传时OS X/回停靠 → 按策略隐藏而非销毁仍有job的window；从主窗口任务入口能重新聚焦；完成后远端hash正确、返回路径/选择。
4. 无任务时回停靠 → 主view ready后子窗口关闭，只一个可交互Files；owner仍有效，无重复attach/detach把新channel释放。
5. 真实关闭准备中的子窗口造成加载中断 → 源恢复原位置可重试，handoff清理；全部QA窗口/连接结束后无遗留。

**证据 / 清理**：窗口label/OS数量与ready时序、两channel/server记录、字节hash与焦点；DOM伪窗口截图不能代替。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n05"></a>

### V-N05 / TC-SHELL-N05 — Git 多根、磁盘效果、提升与原生回停靠

- **归属 / 用途**：AC-04、AC-09、AC-13、AC-18；V-07；TASK-06/09/12；covers: [F25.5、F-SHELL-1、F-Detach-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N05-git-disk-window-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、git_diff_repo、shell_native_files]。两个fixture Git repo，分支名不同，修改短文件；使用fixture局部user配置，不改global Git。有空白目录验证初始化。
- **native 必要性**：Git状态/diff、真实.git与原生Git窗口是browser不能建立的结果。
- **模式与支持**：本地文件assert_file_sha256/contains、UI操作已有；独立git -C status/diff观察，跨窗口MN-1。Git kind/route是本批待新增。

1. Home打开repo A的Code Workspace，Git默认底部 → UI变更列表与独立git status --porcelain一致；切root B → 不显示A的文件；返回A保留diff/草稿。
2. 选stage/unstage一个fixture文件 → 独立git diff --cached准确变化；取消初始化空目录时无.git，确认初始化后独立git rev-parse成功。
3. promote→dock→detach，编辑commit草稿并滚动diff → 相同逻辑Git视图，原生子窗口ready后唯一可见；OS X回停靠后草稿/scroll仍在。
4. 准备弹出期间关闭目标子窗口/移走fixture根 → 原view显示可恢复错误，不自动新建/提交仓库；恢复路径后可重试。
5. 关闭全部本例view，保留git状态/文件hash证据后清理两个fixture仓库。

**证据 / 清理**：独立Git命令输出、文件hash、窗口数量/消息与draft全文；不执行真实远端push。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n06"></a>

### V-N06 / TC-SHELL-N06 — 项目树重宿主后的真实保存、撤销与焦点

- **归属 / 用途**：AC-04、AC-11、AC-13、AC-14；V-07；TASK-06/12；covers: [F25.5]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N06-workspace-save-undo-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、project_tree]。真实QA项目，用现有project_tree README/example.txt；记录原始文件hash；无需Java/JDTLS，证明的是编辑器与文件/宿主。基线TC-IDE-SHELLLAYOUT-02。
- **native 必要性**：需真实filesystem保存/undo和当前平台WebView的重宿主焦点；browser不会证明磁盘内容。
- **模式与支持**：press/Mod+s/z、assert_file_sha256/receipt已有；系统输入焦点若WebDriver不等价则在N10补，不借本例推断物理输入。

1. 真实树选文件Enter打开，输入单个z，开/关Project、Problems、Terminal以及mergeRail → 文本和光标保持、只有一个editor/tree。
2. Esc从Host回editor，Mod+s → 磁盘出现正确字符；Mod+z再save → 文件SHA-256恢复最初值；redo/save → 精确新hash。
3. 两workspace同路径不同instance各选择不同文件/编辑草稿 → 快切与Git切owner不互相覆盖undo/选中。
4. 保存失败使用fixture权限/不可写路径的真实OS机制，关闭tab点save → 保持tab/dirty/错误；恢复权限后save并关闭成功。
5. 最后恢复fixture文件原hash，确认无额外watcher/childprocess持有目录。

**证据 / 清理**：文件receipt/hash、文本/undo步骤、权限错误实况；平台不支持chmod时用本平台临时ACL/只读卷，恢复ACL后清理。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n07"></a>

### V-N07 / TC-SHELL-N07 — Notes 原生浮窗、落盘与 Hub 重新合流

- **归属 / 用途**：AC-05、AC-06、AC-13、AC-18；V-07；TASK-07/09/12；covers: [F-TAO-1、F-Detach-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N07-notes-window-storage-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db]。只在QA profile创建SHELL-NOTE-<run>，无个人Notes；记录隔离DB路径；原notesWindowSync与FloatingNotesPanel为基线。
- **native 必要性**：真实Notes存储、原生置顶/关闭/回停靠与跨窗口同步不能从browser浮层推导。
- **模式与支持**：Notes UI和backend读取可自动；OS窗口、always-on-top、跨窗编辑按MN-1；不把bridge缓存值当window manager置顶证据。

1. Tao Notes创建含中文标题/两段正文、设近期待办 → 真实保存成功；退出重开该Notes视图仍是相同noteId/全文。
2. 显式弹出 → OS新窗口且唯一label；置顶行为用另一窗口遮挡尝试或window manager状态验证；主Hub显示已弹出入口。
3. 子窗口编辑→回停靠/OS X → 新文本落盘并在主Hub可见；重复dock消息不重复Note，隐藏不自动完成待办。
4. 到期通知→点击 → 正确Note可见才ack；保存失败/权限拒绝时关闭保留错误/草稿，恢复后重试。
5. 删本例Note并确认QA数据库无重复记录，关闭其窗口；不修改系统个人便签或主profile。

**证据 / 清理**：DB只读观察或真实重开结果、noteId/全文、OS窗口/置顶证据、通知状态；权限故障只在本轮QA数据。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n08"></a>

### V-N08 / TC-SHELL-N08 — 真实退出重启后的布局、owner 与迁移

- **归属 / 用途**：AC-10、AC-15；V-07；TASK-08/10/12；covers: [F1.6、F-SHELL-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N08-restart-layout-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、project_tree、shell_native_files]。D4 legacy prefs与W1/W2两恢复entry；同一隔离QA数据目录跨两次启动保持，第二次不能reset_db。先记录原profile不在目标范围。
- **native 必要性**：reload_window不证明应用进程退出后的storage、工作集和新backend identity恢复。
- **模式与支持**：当前无app_restart verb；CMD-N初始化+MN-1两次QA启动，或TASK-11实现保留run-root的受验证重启支持。不得重启时重置数据。

1. 从legacy启动迁移；调整Navigator/Host/Tao、pin/laneOverride，保存工作集；部分panel记录detached意图；等待偏好flush。
2. 正常退出，外部确认QA PID结束；用同QA binary/同isolation目录重启 → 先Home、合法偏好恢复，旧handle不被当活窗口。
3. 显式恢复工作集，分别确认新tab/backend identities → W1/W2仍隔离，尺寸/排序准确；失效路径一项failed，成功项不重复；retry只补失败项。
4. 备份本例prefs后使其截断/未知version重启 → 安全默认/保留raw，session和Notes不丢；恢复备份再次启动正常。
5. 关闭QA，保留前后data-root/identity/文件hash；清理只限本次run-root。

**证据 / 清理**：两次真实PID/启动日志、prefs前后raw、restoreRef映射、业务数据对比；页面reload结果不充当本例通过。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n09"></a>

### V-N09 / TC-SHELL-N09 — 复制信息与编辑器粘贴的真实系统剪贴板

- **归属 / 用途**：AC-02、AC-11、AC-16；V-07；TASK-03/12；covers: [F1.5、F25.5]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N09-clipboard-native.testcase.yaml`；不支持自动化的步骤以本条作为精确手工 runbook，YAML 的 native checklist 链接此条。
- **前置 / fixtures**：[reset_db、project_tree]。本地Shell/fixture session显示host/user/cwd；host clipboard原文本先备份到本次run-root（不写报告正文），测试后还原。
- **native 必要性**：浏览器navigator.clipboard或DOM文本不能证明OS剪贴板跨进程可读/拒绝处理。
- **模式与支持**：Linux/X11 assert_system_clipboard/native_clipboard_owner；Windows/macOS独立文本编辑器粘贴/本机API外部读，不造跨平台现成verb。

1. 从tab右键复制连接信息，再从Overview同入口复制 → 独立进程读取到相同已脱敏字段、host/path正确，不含password/key/token。
2. 系统剪贴板拒绝/不可用时再复制 → 明确失败且原tab/focus可恢复；解除拒绝重试成功。
3. Code里复制单段marker→开/关Host/Overview→回editor粘贴 → 只粘贴一次、undo可撤回，Shell不吞Mod+C/V。
4. 清空测试编辑内容、恢复原剪贴板文本并验证；若OS无法还原原非文本格式明确记录边界，使用专用桌面避免污染个人数据。

**证据 / 清理**：独立进程读数的脱敏结果、拒绝/恢复、编辑结果与还原记录；不记录备份的私人剪贴板内容。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n10"></a>

### V-N10 / TC-SHELL-N10 — 系统快捷键、真实 IME 与焦点返回

- **归属 / 用途**：AC-02、AC-11、AC-16；V-07；TASK-03/12；covers: [F1.5、F25.5]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N10-os-keyboard-ime-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、project_tree]。交互式专用桌面；Windows拼音、macOS拼音、Linux fcitx5已就绪，记录engine与键盘布局。打开terminal、Code、Mail及Shell search。
- **native 必要性**：OS拦截、physical focus、IME候选不是browser compose_text/WebDriver press可证明的。
- **模式与支持**：Linux已有native_ime_keys/x11 native_keys；Windows/macOS按MN-1实际键入，录制候选与焦点；webdriver transport只补renderer，不替代物理输入。

1. 物理Ctrl/Cmd+K在chrome→快切；terminal Ctrl+K→原行为，Code已绑定chord→原action；Control+Tab在shell/Code分别触发各自switcher，检查无二次分发。
2. macOS实际Cmd+Tab切系统应用后返回 → 系统切换正常，Taomni不偷偷改active tab；Windows Alt+Tab/Linux桌面切应用也不丢已输入内容。
3. 分别在总览搜索、rename、Notes输入中文/日文，候选中Enter/Esc→只提交/取消候选，不关闭Shell层或tab；完成后Enter才执行既定动作。
4. 开Host/Overview/确认层再Esc返回 → 物理光标/键入落正确原控件；重复键/长按不得双开连接；record disabled上下文仍保护。

**证据 / 清理**：屏幕录制、输入前后完整文本、engine/OS/keymap/focus结果；只在约定桌面时间或独立机器操作，不抢个人输入。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n11"></a>

### V-N11 / TC-SHELL-N11 — 真实目录/文件对话框、取消、权限与路径

- **归属 / 用途**：AC-01、AC-14、AC-15；V-07；TASK-08/12；covers: [F1.6、F1.8]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N11-dialogs-paths-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、shell_native_files]。run-root下中文/空格目录、合法Git目录、待删除目录及不可访问目录；Windows额外测试可用的fixture UNC路径，无UNC fixture时记录该分支待执行。
- **native 必要性**：OS picker、原生路径/权限/外部打开不能被browser dialog stub证明。
- **模式与支持**：主页面UI自动；真实系统picker/权限提示手工MN-1。native seed_storage可用于其他case跳过picker，本例必须实际选。

1. Home打开工作区→真实picker取消 → 无新tab/recent；再次选择中文/空格fixture路径 → 正确workspace与tree，实际文件内容可读。
2. 从Home最近打开已移除目录/不可访问目录 → 原因准确，不打开同名其它目录；重新定位成功只更新该entry，取消定位保留原记录。
3. 从目录历史启动Shell → 实际cwd等于选择路径；从更多入口打开本地目录 → OS窗口对应fixture目录而非开发者home。
4. session导入选择小fixture JSON，先取消后确认预览；export到fixture文件 → 独立读取准确内容且不带非约定秘密；错误路径失败可重试。

**证据 / 清理**：真实dialog录制、最终路径/磁盘文件/cwd、取消前后recent集合；恢复fixture权限再清理，不修改系统访问策略。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n12"></a>

### V-N12 / TC-SHELL-N12 — 数据库草稿、运行中查询和事务关闭保护

- **归属 / 用途**：AC-09、AC-13、AC-17；V-07；TASK-04/12；covers: [F1.5、F-SHELL-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N12-database-close-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、mysql_required]。本地MySQL 8.4专用schema shell_<run>，表t(id,value)，独立client能SELECT 1；记录基线数据库close/tx用例。无生产库。
- **native 必要性**：真实事务提交/回滚、connection与query取消/flush不能由stub结果证明。
- **模式与支持**：UI/query编辑与现有DB verbs；独立MySQL client查询验证；配置来自env。需TASK-04接业务事务risk adapter，不复写SQL引擎。

1. 手动事务更新t但不提交，输入未执行SQL草稿；切lane/Tao/Host20次 → 连接仍同一业务会话，草稿完整，独立client仍看旧已提交值。
2. 从tab X/Overview/close-all各取消关闭 → transaction与草稿保留；选rollback-and-close → 外部client看到原值，tab移除；另一次commit-and-close → 外部client看到新值。
3. 启动可控慢查询再关闭 → 用户选择取消查询后等待实际终态才关闭；不能让旧query回包写到另一DB tab。
4. 使flush/网络临时失败后save-and-close → tab保留错误与重试；服务恢复后重试成功，只关闭指定DB；清理schema。

**证据 / 清理**：独立client读值、query/session日志、准确草稿与close状态；skip/SELECT1失败不记通过。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n13"></a>

### V-N13 / TC-SHELL-N13 — 真实邮件未读、草稿与 Tao 跳转

- **归属 / 用途**：AC-06、AC-13、AC-19；V-07；TASK-07/12；covers: [F-TAO-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N13-mail-notification-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、mail_server]。现有mail_server起本机真实IMAP/SMTP，seed INBOX；使用fixture.mail_quick_connect，不连接/发送到外部邮箱。配置mode必须native。
- **native 必要性**：真实IMAP同步、unread变化、草稿持久化与native事件跳转不能由browser mail model证明。
- **模式与支持**：现有mail_server_*和邮件UI自动；服务暂停/恢复由fixture，新增的Tao jump/ack接口随产品实现。

1. 通过真实邮件连接打开账户，服务投递两封唯一主题 → Mail未读/对应Tao mail提醒出现；backend确实拉到fixture消息。
2. 编写SHELL-DRAFT但不发送，切lane/打开Tao → 草稿保留；点击通知只定位账户/inbox → ack该提醒，未读仍由真实阅读行为决定。
3. 读取其中一封 → 服务端/账户未读按原语义减少，不能把两封都标读；关闭owner后再投递并从通知恢复 → 重新打开正确账户。
4. 短暂停IMAP后点击通知 → 有失败/重试且pending保留；恢复服务后跳转成功才ack；重开草稿验证全文。

**证据 / 清理**：本地server消息UID/unread与QA backend日志、草稿全文/通知顺序；清理fixture及QA草稿，不实际发邮件。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n14"></a>

### V-N14 / TC-SHELL-N14 — RDP/VNC 视口、焦点与既有脱离回归

- **归属 / 用途**：AC-13、AC-16、AC-18；V-07；TASK-02/09/12；covers: [F1.2、F-Detach-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N14-remote-viewport-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、vnc_required；RDP子场景使用rdp_server_required或xrdp_server_required]。脚本化本地VNC有输入event日志/画面尺寸，RDP用现有平台支持的disposable fixture；两协议分别记录，不互相替代。
- **native 必要性**：真实remote输入通道、backend viewport/断线和原生detachment不能由DOM mock证明。
- **模式与支持**：VNC fixture控制/日志与主窗UI可自动；跨窗与OS焦点MN-1。RDP fixture不支持的平台使用受控真实环境接续，不能静默skip成全通过。

1. 连接remote并在fixture输入框写nonce → 远端观察一次准确输入；开Overview后输入检索词 → 只在本地搜索，remote日志没有泄漏。
2. 开/关右Host/Tao和缩放窗口 → 远端画面正确fit，隐藏期间无0×0 resize；返回remote原连接和光标状态仍有效。
3. 从原detach入口弹出并回停靠 → 保持各协议现有adopt/claim/重连语义，画面和输入可恢复；重复点击不双窗口/双连接。
4. 准备期间真实关闭子窗口或中断fixture连接 → 明确错误/重连入口，主Shell仍可导航；恢复后输入再次准确；清理fixture。

**证据 / 清理**：协议event/连接日志、画面与viewport尺寸、OS窗口数；不得把同一连接未变化当所有协议的统一期望。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n15"></a>

### V-N15 / TC-SHELL-N15 — 多窗口、传输与事务中的真正退出

- **归属 / 用途**：AC-09、AC-17、AC-18；V-07；TASK-04/09/12；covers: [F1.3、F-SHELL-1、F-Detach-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N15-application-exit-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、ssh_required、sftp_required、mysql_required、shell_native_files]。一个PTY、一个Git/Notes子窗口、一个限速SFTP job、一个未提交测试事务；依赖组合只为验证应用退出协调，不给每模块重复全套服务。
- **native 必要性**：退出必须真实等待清理、关闭所有QA窗口/进程和资源；browser不能证明进程仍在或终止。
- **模式与支持**：主窗确认自动+OS关闭/外部process观察MN-1；复用真实业务cancel/rollback，不加入假stopEverything QA action。

1. 点系统关闭再取消 → 所有QA窗口/PTY/job/transaction继续可用，焦点回原控件；菜单Exit重复同结果。
2. 再次退出选择取消任务/rollback，故意使一个清理步骤网络失败 → 应用仍在、显示具体失败与重试/取消，不假退出成功。
3. 恢复服务后重试 → 等任务取消/事务rollback真实完成，再所有QA窗口与进程结束；外部client确认数据未commit，remote文件未报完成。
4. 核对生产Taomni/其它应用未被关闭；本次server/client进程无遗留；保留失败首轮证据及恢复结果。

**证据 / 清理**：退出时序、系统PID/window清单、真实SQL/transfer结果；没有允许进程退出后仍继续后台job的选项。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n16"></a>

### V-N16 / TC-SHELL-N16 — 三类 WebView 的实际缩放、命中和读屏

- **归属 / 用途**：AC-05、AC-07、AC-08、AC-11；V-07；TASK-02/12；covers: [F1.2、F1.3、F-SHELL-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N16-webview-dpi-accessibility-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、project_tree]。QA应用默认/最小窗口，100/125/150/200%缩放或各平台实际支持档；操作在专用桌面，记录physical/logical/CSS尺寸。
- **native 必要性**：真实WebView字体/DPI、macOS traffic lights、OS控件命中/读屏与browser截图不同。
- **模式与支持**：DOM几何可自动；OS缩放、native菜单、读屏Narrator/VoiceOver/Orca按MN-1。平台不存在某档记录实际档位，不推断其它端。

1. 每个可用缩放档将窗口置于默认/最小800×600 → 标题按钮/全局Rail/总览/面板/Tao可点击；CSS断点以实际innerWidth判定，不强改原生minWidth。
2. 开Navigator/Host/Tao/总览以及长标题/英文 → 检查原生frame/safe-area/菜单与正文无覆盖；macOS交通灯区域安全，自绘控制不重复。
3. 使用读屏走Rail、lane、tabs、Host子tabs、通知、close dialog → 名称/选中/状态/焦点顺序可理解；错误/busy不只颜色；隐藏view不被读到。
4. 跨DPI显示器拖动（环境有时）/缩回100% → 合法尺寸、清晰focus ring、原布局偏好保持；恢复测试前OS缩放/窗口位置。

**证据 / 清理**：native截图+外部屏幕几何、CSS rect、读屏步骤与观察；截图生成不等于视觉或无障碍通过。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n17"></a>

### V-N17 / TC-SHELL-N17 — 匹配负载下的原生响应与资源回收

- **归属 / 用途**：AC-13、AC-20；V-07；TASK-12；covers: [F1.2、F1.5、F-SHELL-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N17-native-performance-lifecycle.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、project_tree、git_diff_repo]。同机baseline/candidate、相同QA profile/WebView与12 tab实际本地负载；100 tab检索负载独立标识，避免开100外部连接；原始性能基线待执行。
- **native 必要性**：原生WebView、PTY输入和OS进程/内存生命周期不能由browser case耗时证明。
- **模式与支持**：现有native_editor_performance只测keydown→editor DOM；Linux assert_native_process_delta仅Linux；其它端外部进程计数/采样。Shell开层指标由只读collector或录屏采样。

1. 各版本相同数据预热5次，采30次Quick/Overview打开、切tab可见、Host显示；记录所有raw与p50/p95，baseline重复一轮估计噪声。
2. 在editor/PTY有输入时开关Host/Tao并往返lane20次 → 内容/undo/output正确；按原预算测受影响输入，不把DOM指标称真实key-to-screen。
3. 重复promote/dock/close/reopen20次 → 活跃业务实例/窗口/进程数回预期，内存/订阅无持续增长；采稳定后的OS观察，保留慢样本。
4. 候选超原预算或相对基线新增稳定退化 → 失败并归因修复；baseline缺失→性能未验证，不抬阈值/换样本；清理后无QA遗留进程。

**证据 / 清理**：硬件/OS/WebView/profile/dataset、全部samples/噪声/进程图与功能结果；性能与功能分别结论。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。

<a id="v-n18"></a>

### V-N18 / TC-SHELL-N18 — 主/子窗口中断与真实恢复竞争

- **归属 / 用途**：AC-09、AC-10、AC-18；V-07；TASK-09/10/12；covers: [F-SHELL-1、F-Detach-1]；目标 + 受影响保留边界。
- **拟新增文件**：`qa-ui-auto-tests/cases/TC-SHELL-N18-window-interruption-recovery-native.testcase.yaml`；手工边界链接本条，YAML 单独通过不代替完整 V。
- **前置 / fixtures**：[reset_db、git_diff_repo、shell_native_files]。Git/Notes/SFTP可恢复描述，QA进程/窗口label已外部确认；只故障本轮QA。必要真实SFTP分支另加ssh_required/sftp_required。
- **native 必要性**：window close-request、主窗消失、启动恢复和消息丢失/重复的真实时序不能仅由browser transport stub证明。
- **模式与支持**：MN-1跨窗口/关闭/进程故障；精确ready时序可用QA debug观测但不能伪造ready成功。没有通用自动能力时按本条手工，不跳过。

1. 弹出准备时立刻关闭真实子窗口 → source保留可操作、operation结束为失败；重试只一个新窗口，旧window消息不覆盖。
2. 子窗口dirty时请求回停靠，同时关闭原owner → 主窗重新校验owner/风险；不能丢草稿或把数据移给同名其它owner；取消后数据仍可取回。
3. 主窗口正常关闭被风险阻止时取消 → 子窗口继续；专用QA故障运行中终止已确认的QA主进程并重新启动（单独记录crash恢复）→ 不冒用旧handle、没有幽灵detached状态；持久化成功的数据可恢复，未持久化项按明示策略保留恢复提示。
4. 新主窗口读取recent/detached intent，显式恢复有效owner后再弹出/回停靠 → operation/generation更新，重复message不双建；清理旧handoff遵循TTL，不残留认证数据。
5. 关闭本轮所有QA进程和fixture；报告正常退出与crash两组不同结果，不声称任意内存草稿具备新增crash持久化能力。

**证据 / 清理**：窗口/进程及message时间线、重启data-root、实际保存内容与恢复提示；只允许终止已验证为本次QA的PID，不按名称批量kill。 继承 §1 清理；CMD-N + 必要 MN-1。Windows / macOS / Linux：均待执行。


<a id="execution-handoff"></a>

<a id="v-n21"></a>

### V-N21 / TC-SHELL-N21 — 多仓库 Git 提交及仓库隔离

- **归属**：AC-04、AC-13；V-07；TASK-06/11/12；covers: [F25.5、F26.2、F-SHELL-1]。
- **实际文件**：[N21 YAML](../qa-ui-auto-tests/cases/TC-SHELL-N21-git-actions-native.testcase.yaml)。Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView，`modes: [native]`；使用实际 Git IPC 与独立只读 Git 进程，browser Git stub 不建立这些磁盘结果。
- **前置**：`reset_db`、`git_diff_repo`；primary 仓库固定 main、两次基线提交，short.txt 已暂存、long-lines.txt 未暂存；aux 是独立干净仓库及固定 HEAD。两仓库均在 run-root，Git user 配置只写 fixture 仓库。打开包含这两个 root 的真实工作区，选择 flat Changes。
- **控件与动作**：实际 WorkspaceGitManager 的 `workspace-change-row`、diff Stage/Unstage、Commit 面板、Commit target branch、确认/取消、Log 和 Discard。不能对单 root 使用这些多仓库控件。

1. 打开 Git Host，选择 primary short.txt：Unstage 后 index 等于基线全文；Stage 后 index 等于预设 staged 全文；HEAD 不变，完整 porcelain 集合精确匹配。每次同时验证 aux 的 HEAD、全部分支和空 status。
2. 输入含中文的多行提交草稿，选择新分支 shell-qa 并打开提交确认后取消：primary 全部分支仍只有 main，HEAD/index/status 不变，提交草稿完整；aux 完全不变。
3. 只勾选 short.txt，再确认提交到 shell-qa：primary 当前分支及全部分支精确匹配，HEAD/index short.txt 等于 staged 全文，long-lines.txt 和未追踪 manifest 仍保留；aux 未产生任何分支或提交。
4. Log 最新提交只含 short.txt。Discard long-lines.txt 先取消，保持精确状态；再确认，只移除该文件的修改，保留已提交 short.txt 与未追踪 manifest。

**证据与清理**：reviewed requirements、原生 UI 截图、独立 Git oracle、fixture 最终状态与 receipt hashes；截图另写视觉结论。runner 结束 QA 进程并清理 fixture，不执行远端 push。第五轮旧输入因 single/multi 控件不匹配而失败；本次实际双 root 版本尚待三端远程复验。

<a id="v-n22"></a>

### V-N22 / TC-SHELL-N22 — 单仓库 Git 与取消建分支

- **归属**：AC-04、AC-13；V-07；TASK-06/11/12；covers: [F25.5、F26.2、F-SHELL-1]。
- **实际文件**：[N22 YAML](../qa-ui-auto-tests/cases/TC-SHELL-N22-single-git-actions-native.testcase.yaml)，60 步、五条 reviewed requirements。Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView，`modes: [native]`，240 秒原预算。
- **前置**：`reset_db`、`git_diff_repo`；与 N21 相同的 primary 基线文件及精确 HEAD/index 内容，工作区只含一个 root，flat Changes。必须看到 `git-change-row` 且 `workspace-change-row` 数量为零，以证明走真实单仓库 GitPanel。
- **控件与支持**：GitPanel 的 Changes/Branches/Log，`git-branches-view` New、实际 TextInputDialog Cancel/Confirm、diff Stage/Unstage、`git-commit-submit`、Discard。`git_assert_state.branches` 由独立 Git 进程读取全部 local refs，再做精确集合比较；不只检查当前分支。

1. Git 默认在底部 Host；Unstage short.txt 验证完整 index 回到基线且 HEAD 不变；再 Stage 验证完整 index staged 内容和精确 status。
2. 输入完整多行中文提交草稿，Branches → New → 输入 shell-single-qa → Cancel：全部分支仍只有 main，HEAD、index、status 不变；回 Changes，草稿逐字相同。
3. 再次 New → Confirm：只新增 shell-single-qa 并 checkout，全部分支精确为 main 与 shell-single-qa，HEAD 与 index 不变，草稿仍完整。
4. Changes 只勾 short.txt 并通过单仓库直接 Commit：该 UI 没有多仓库的提交确认层。独立 Git 验证当前分支、完整 HEAD/index 文件及最新提交标题；余下 status 精确为 long-lines.txt 修改与未追踪 manifest。Log 最新提交仅有一个 short.txt。
5. Discard long-lines.txt：Cancel 保留精确状态；Confirm 后该行消失，独立 status 只剩未追踪 manifest，已提交 short.txt 保留。

**证据与清理**：原生截图、reviewed requirement checkpoints、独立 Git oracle 与 artifact hashes；截图不能自动充当视觉结论。只操作 run-root 仓库并由 runner 清理。静态契约/单测通过不等于本例运行通过；首次三端执行仍待 GitHub。

## 5. 实施后的运行命令与三端手册

当前批次按用户要求，本地只完成单元测试与静态检查，browser/native 在 GitHub 的 `qa-ui-auto-platforms.yml` 执行。下列本地 CMD-B/CMD-N 保留为维护和手工边界的操作手册，不是本批次已运行或计划启动的本地回归。CI 的精确范围、SHA 与报告以 [实施任务](./workspace-shell-ux-redesign-tasks.md) 最新记录为准。

### CMD-B：browser

以下从仓库根目录、PowerShell 执行；只在本设计的 YAML/fixtures/控件已落地后使用。先核实 localhost:5000 的 Vite 确实服务当前 checkout；已有健康服务可复用。后台 helper 避免驻留进程阻塞工具会话。

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"

python .agents/skills/qa-ui-auto/scripts/background_job.py start --name shell-vite --log qa-ui-auto-report/workspace-shell/vite.log -- pnpm dev
python .agents/skills/qa-ui-auto/scripts/background_job.py status --state qa-ui-auto-report/workspace-shell/vite.log.job.json --tail 20

# 迭代示例：精确选中本次实现的两条，不执行不存在/未登记的占位 case。
python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter TC-SHELL-B01,TC-SHELL-B02 --require-pass --report-dir qa-ui-auto-report/workspace-shell/browser --keep-runs 0

# 整批稳定后：先确认这 44 个 ID 均已实现/登记，旧 case 复用后的 ID 要同步本映射。
$qaShellBrowserIds = ((1..44 | ForEach-Object { "TC-SHELL-B{0:D2}" -f $_ }) -join ",")
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name shell-browser --log qa-ui-auto-report/workspace-shell/browser.log -- python -m qa_ui_auto run --mode browser --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --filter $qaShellBrowserIds --workers 4 --require-pass --report-dir qa-ui-auto-report/workspace-shell/browser --keep-runs 0
python .agents/skills/qa-ui-auto/scripts/background_job.py status --state qa-ui-auto-report/workspace-shell/browser.log.job.json --tail 30
```

workers 按实际 CPU/内存调整；不是改变断言或重新跑全 App 的理由。每个 case 全新上下文；D6 故障接口只在该 context 的 stub 边界。首次失败保存产物后先定位，不全量盲目重试。

### CMD-N：native 自动化部分

从 example config 复制一个**本地未提交**配置，按所选依赖填写：

- `app.mode: native`；`app.native_binary` 指向真实 QA build，例如 Windows `src-tauri/target/qa-ui-auto/debug/taomni.exe`，相邻 identity 必须匹配。不要指向 production executable 或重命名生产二进制。
- Windows 设置匹配 WebView2 的 msedgedriver（必要时 webdriver.native_driver）；Linux 具备 tauri-driver/WebKitWebDriver/X11；macOS 使用 QA 的 WKWebView bridge。
- runner 的 `--mode native` 会把模式传给 fixtures；browser base_url 不能作为原生执行证据。native open 步骤由原生 harness 在已启动的 QA WebView 内处理，不连接另一个 browser 作为替身。
- 只启用所选 SSH/MySQL/mail/VNC/RDP fixture；密码来自环境变量。example 中有历史“不会启动Docker”的旧注释，实际启用策略按 skill 与当前 fixture 实现，不能以注释推断没有服务。
- 4444/4445 等 driver 端口空闲，由本轮启动driver以继承隔离；existing listener 不复用。配置文件拟命名 `qa-ui-auto-tests/qa-ui-auto.config.shell-native.local.yaml`，实现者检查 gitignore，绝不提交 credentials。

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"

# 先检查新 native 用例的实际 verbs/platform，dry-run 不生成通过证据。
python -m qa_ui_auto run --mode native --config qa-ui-auto-tests/qa-ui-auto.config.shell-native.local.yaml --filter TC-SHELL-N02,TC-SHELL-N06 --dry-run

# check 不编译：0 可复用，1 需要构建，2 检查错误。
python .agents/skills/qa-ui-auto/scripts/native_build.py --check

# 仅当需要：源码/测试稳定后构建一次，然后复用匹配输入。
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name shell-native-build --log qa-ui-auto-report/workspace-shell/native-build.log -- python .agents/skills/qa-ui-auto/scripts/native_build.py
python .agents/skills/qa-ui-auto/scripts/background_job.py status --state qa-ui-auto-report/workspace-shell/native-build.log.job.json --tail 30

# 构建状态确认为成功、identity 匹配后再运行；不要在构建未完时接续。
python .agents/skills/qa-ui-auto/scripts/background_job.py start --name shell-native --log qa-ui-auto-report/workspace-shell/native.log -- python -m qa_ui_auto run --mode native --config qa-ui-auto-tests/qa-ui-auto.config.shell-native.local.yaml --filter TC-SHELL-N02,TC-SHELL-N06 --require-pass --report-dir qa-ui-auto-report/workspace-shell/native --keep-runs 0
python .agents/skills/qa-ui-auto/scripts/background_job.py status --state qa-ui-auto-report/workspace-shell/native.log.job.json --tail 30
```

实际批次把 filter 改成该批已支持的精确 IDs；所有 N 中要求的手工结果另行关联，未自动化不等于允许省略。native 串行、独占；正常不 cargo clean、不每条 case 编译，不对同输入先重复 pnpm build 再 native build。必要逻辑检查可用 `pnpm exec vitest run <实际文件> -t '<已实现测试名>'`；占位文本不能直接执行。Rust 仅对实改 windowing/filebrowser 生命周期选实际存在测试名，完成三端条件编译审查。

### MN-1：手工/外部 native 边界

1. 用 native_build 的真实 QA binary/identity；保存 build/source/config 身份。使用 runner 已创建的隔离会话，或在下列目录边界内手工启动同 QA app。Windows/macOS debug app 使用 `NEWMOB_DATA_DIR/NEWMOB_CONFIG_DIR/NEWMOB_CACHE_DIR`；Linux 用本轮 XDG data/config/cache。不能只改 APPDATA，也不能改 HOME。
2. 创建 `qa-ui-auto-report/workspace-shell/native/manual-<run-id>/` 并记录其解析后的绝对路径；子 data/config/cache/projects 均位于此根。保存 PID/window label，只操作本例创建的窗口。N08 重启复用同一组目录，第二次不跑 reset_db。
3. 键盘/鼠标/IME/window manager 步骤使用独立桌面/机器，或与使用者约定操作时段。若检测到锁屏或焦点被其它应用夺走，保存受影响证据并停止该步；不能以最小化窗口宣称后台物理输入正确。
4. 按具体 V-Nxx 的有序步骤操作；每个箭头后的结果写 pass/fail/unrun，含独立OS窗口矩形/进程/文件hash/SQL/协议结果。Windows可用系统窗口列表和外部采集，macOS查看真实应用窗口/交通灯，Linux区分X11/Wayland；不要只读Tauri缓存证明window manager。
5. 保存 `manual-results.md`：每步预期、观察、时间、platform/WebView、截图/视频/命令输出相对路径；明确WebDriver、物理输入、外部服务三类证据来源。不是把“手工完成”写进自动生成manifest充当自动通过。
6. 正常/失败退出都执行本case清理；临时ACL/只读设置先恢复，host clipboard恢复，fixture服务停止，确认仅本轮QA进程已退出。递归删除前确认路径在manual run-root；保留需交接的原始产物，清理不会覆盖第一轮失败。

### 目录与 CI 契约

所有 YAML 实现完成的同一变更：

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"

# controls 发生变化才重新生成；完成本批目录修改后执行一次。
python -m qa_ui_auto.gen_testid_catalog
python -m qa_ui_auto.audit --gate

# 精确选择，验证 policy/mode/fixture/dependency 可被 planner 解析。
python -m qa_ui_auto.ci plan --scope selected --case-ids TC-SHELL-B01,TC-SHELL-N02 --platforms windows --modes browser,native --output qa-ui-auto-report/workspace-shell/selection.json

# 在实际开发分支按正确 base/head 检查；当前仅文档交接不运行产品门禁。
python .agents/skills/qa-ui-auto/scripts/qa_ui_auto/dev_contract.py --base origin/main --head HEAD
```

contracts CLI 只有 `--cases` 没有 `--filter`；单条语义审阅直接读 YAML，批次契约检查传真实 cases 目录。不得编造 `contracts --filter`。run 的 verification 结构报告仍需核对 actions/checkpoints/results 的语义，不以schema通过替代。scope selected 的 case-ids 必须匹配 YAML 的id而不是文件名。

## 6. 交接登记与当前结果

<a id="current-execution"></a>

| 产物 / 范围 | 当前结果 | 实施完成时回填 |
|---|---|---|
| Browser 详细规格与补充 | 45 条 Shell YAML（B01～B45）已登记；249 ID 完整运行中三端分别 190/0、190/0、189/1，B18 修正已精准三端通过。最终 250 ID 输入待统一运行 | reviewed contract、report/checkpoint、target/retained 结果；旧通过不覆盖后续修改 |
| Native 详细规格与补充 | 17 条 Shell YAML 已登记，另有 N01/N13/N14 的既有用例复用；完整运行 Linux 67/0、Windows 61/0、macOS 59/1，RDP fixture 正在复验。N11/N17 及额外 OS 分支仍为独立手册 | binary identity、真实副作用、清理证据及下表列出的未自动化边界 |
| fixture / verb / control 增补 | SFTP 受控真实服务、SQL/进程/剪贴板独立 oracle、文件 chooser/download、几何与导航支持已实现；schema/catalog/policy 同批维护 | 静态与 runner 单测只能证明契约，运行效果由 GitHub case 建立 |
| 改前基线 | 静态基线及历史运行保留；没有完整、匹配原始设计基线的三端全量结果 | 不把实现中途通过追记为改前通过；具体历史输入见任务记录 |
| 视觉与可访问性 | browser 几何/命中和 native WebView 两尺寸已有自动化断言；历史部分画面已检查 | 当前 SHA 画面、读屏、OS DPI/跨屏与系统控件仍按平台单列 |
| 性能 | 指标、负载、样本和比较方法已定；没有实测结论 | 原始baseline/candidate、噪声、p50/p95与资源，不宣称理论提速 |
| 产品构建/协议服务 | 历史两轮 GitHub 和 Windows QA 构建证据保留；当前重构输入需 GitHub 重新构建 | selection、实际执行数、服务就绪、receipt 与源码/二进制身份 |

责任任务均在主设计 TASK-01～12；其中 TASK-11 将本稿转成规范 YAML 并维护目录，TASK-12 汇总三平台实际结果和真实缺口。下表链接当前可执行自动化，不把整个设计条目的每个分支都视为已覆盖。

| V / 规格 | 实际 case | 自动化边界 / 尚未建立的证据 |
|---|---|---|
| V-B01～B44 | `qa-ui-auto-tests/cases/TC-SHELL-Bxx-*.testcase.yaml`，ID 与设计一致 | 按每个 YAML 的 reviewed requirements 验收；B04 已覆盖 workspace 部分成功、迟到结果、取消和重试，混合会话认证/类型变化的额外组合仍以真实分支证据为准 |
| V-N01 | [TC-MAIN-RAIL-03](../qa-ui-auto-tests/cases/TC-MAIN-RAIL-03-linux-native-window-drag.testcase.yaml)、N15 | Linux 实际 OS 拖动、应用退出；Windows/macOS 系统移动、最小化/最大化、交通灯及故障退出尚未由这些 case 证明 |
| V-N02～N08 | `TC-SHELL-N02…N08` | 真实进程/SFTP/Git/工作区/Notes/磁盘/窗口与重启恢复；只覆盖 YAML 中的有序分支 |
| V-N09 | [剪贴板](../qa-ui-auto-tests/cases/TC-SHELL-N09-clipboard-native.testcase.yaml)、既有 IDE-C3-02 | 三端 OS 文本读取、标签栏/总览内容精确相同、paste 一次与 undo；写入拒绝及非文本剪贴板恢复仍有明确缺口 |
| V-N10 | [Linux 真 IME](../qa-ui-auto-tests/cases/TC-SHELL-N10-ime-linux-native.testcase.yaml)、既有 IDE-IMPROVE-008 | Linux X11/fcitx5 候选 commit/cancel；Windows/macOS 实际 IME 与系统应用切换尚未执行 |
| V-N11 | 本文 MN-1 及 V-N11 完整步骤；B43 chooser/download 只提供 browser 部分 | 真实 OS picker 取消/权限拒绝、UNC/只读路径、失败后恢复尚未执行，不能由 browser chooser 代替 |
| V-N12 | [数据库关闭](../qa-ui-auto-tests/cases/TC-SHELL-N12-database-close-native.testcase.yaml)及既有 DB-TX/EXEC | 真 MySQL commit/rollback、取消执行/关闭和独立 SQL 结果；故障组合仅在有明确对应步骤时算覆盖 |
| V-N13 | [MAIL-IDLE](../qa-ui-auto-tests/cases/TC-MAIL-IDLE-01-push-while-open.testcase.yaml)、MAIL-UNIFIED | 独立 mail fixture 推送、Tao 跳转和实际 unread；完整草稿/断线/恢复规格仍未全部覆盖 |
| V-N14 | [VNC 151](../qa-ui-auto-tests/cases/TC-151-vnc-fixture-session-input-and-desktop-resize.testcase.yaml)、156、158、[RDP loopback](../qa-ui-auto-tests/cases/TC-RDPJ-01-client-server-loopback.testcase.yaml) | 真协议/input/viewport/clipboard；不代表所有 detach 故障、竞争和所有 OS 输入组合通过 |
| V-N15 | [退出](../qa-ui-auto-tests/cases/TC-SHELL-N15-application-exit-native.testcase.yaml) | Notes 子窗口、paused SFTP、MySQL 事务和实际进程退出；清理网络拒绝/重试的额外分支尚未建立运行证据 |
| V-N16 | [原生 WebView 布局](../qa-ui-auto-tests/cases/TC-SHELL-N16-webview-layout-native.testcase.yaml) | 1440×900/800×600 客户区的几何、命中、Project/Tao 内容；OS DPI、跨屏、交通灯、读屏仍需独立执行 |
| V-N17 | 本文 V-N17 性能测量步骤 | 匹配硬件/WebView/profile 的 baseline/candidate、原始样本和资源数据未完成；不声称性能无退化 |
| V-N18 | [窗口中断恢复](../qa-ui-auto-tests/cases/TC-SHELL-N18-window-interruption-recovery-native.testcase.yaml) | 真实子窗口生命周期与 Notes 草稿恢复；权限/系统窗口故障的其余组合不由单一路径替代 |
| B25 / B45 / N19（AI 强制保留范围） | [browser context/Stop](../qa-ui-auto-tests/cases/TC-SHELL-B25-tao-context-lifecycle.testcase.yaml)、[browser stream/history](../qa-ui-auto-tests/cases/TC-SHELL-B45-ai-stream-history.testcase.yaml)、[native stream/history](../qa-ui-auto-tests/cases/TC-SHELL-N19-ai-stream-history-native.testcase.yaml) | Home 无绑定会话发起对话；发送、隐藏完成通知、精确 thread 跳转、未发送多行草稿、历史重载。B25 通过声明的 IPC hold 验证 Stop 与排队发送只完成一次。N19 另有真实 OpenAI loopback 协议/Rust stream/SQLite、503、部分 SSE 后 Stop、排队恢复和真实 QA 进程重启；独立 provider receipt 要求 5 次 stream 请求均带生产 tools、3 次正常完成、1 次真实连接取消，重启只保留完整回答且不重发。browser 的 stream 是明示 IPC preview。新增分支在 run 37194738007 的 browser 三端通过，native 三端均在 step 40 的相对 receipt 路径检查失败；实际 SSE/Stop 已执行，恢复及重启检查仍待修复输入复验。第五轮冻结的上一输入仍为 4 次请求 |
| N20（LAN 轻量范围） | [native LAN entry](../qa-ui-auto-tests/cases/TC-SHELL-N20-lan-entry-native.testcase.yaml)、B38 的 browser 草稿保留分支 | 原生 read-only history、拒绝开启、Home/quick-switch 回同一 owner；不声称真实 peer/multicast 收发。待 GitHub 三端实测 |
| 截图强制保留范围 | `TC-SHOT-001…027` 与 `TC-SHOT-N1…N13` | 全部加入当前远程选择；native 使用实际捕获、OCR、clipboard、置顶、快捷键、scroll/recording 场景，依各 YAML 和 platform contract 验收。browser stub 与 native 结果分别记录；新远程输入尚未执行 |
| 原生 Git 保留操作 | [N21 多仓库](../qa-ui-auto-tests/cases/TC-SHELL-N21-git-actions-native.testcase.yaml)、[N22 单仓库](../qa-ui-auto-tests/cases/TC-SHELL-N22-single-git-actions-native.testcase.yaml) | 实际 stage/unstage、取消提交/建分支、选定文件提交、Log 文件集、discard 取消/确认；独立 Git 进程核对全部分支、精确 porcelain 集合与 HEAD/index 全文，aux 仓库保持不变。三端待本次输入远程运行；N05 的窗口与草稿验收继续保留 |

用户已授权实现、单测、推送及 GitHub browser/native 验证；当前任务状态与结果持续更新在 [实施任务](./workspace-shell-ux-redesign-tasks.md)。本稿的设计步骤保持完整，自动化数量、静态检查和单测通过均不代表全部三端桌面及人工边界已验收。

SSH 启动回归补充：TC-155 与 TC-IDE-PARITY-027-02 在真实认证、原 ready 预算之后，读取实际终端 buffer 并要求隐藏 prompt hook 未泄露。原 132/69 个动作与检查、模式、覆盖归属和 240/180 秒总预算均保留，只各增加一个结果检查；完整首列输出/系统 clipboard 和 Files 单实例/终端可见性的原验收继续执行。对应挂载单测使用 2/24/50 行 xterm buffer，而不是把屏幕预分配行数等同于实际输出行数。

### DB browser 补充范围

逐模块核对发现旧 242 ID 选择未包含下面 7 条 DB browser 用例。它们保留原 SQL/事务状态/Query Library 断言和预算，入口改为 Home → Sessions Navigator；每条分别审阅打开连接与业务结果两项要求。两条旧 auto 用例已按实际动作和结果重写 requirement/checkpoint，去掉旧 needs-review 标记。此处的 reviewed 只代表用例语义审阅，运行结果仍待 GitHub。

| 用例 | 当前 renderer 验收 | paired native 边界 |
|---|---|---|
| TC-DB-EXEC-001-execution-log-browser | 第一条失败后 Stop；FAILED / NOT RUN 精确数量与汇总；SQL/Log 在 Home 和 Overview 往返后保留且只一个 editor | 同名 native 用例验证真实执行及结果集 |
| TC-DB-EXEC-002-error-choice-browser | Skip 第一条、Stop 第二条；statement 编号与 2 FAILED / 1 NOT RUN | 同名 native 用例验证真实多语句执行选择 |
| TC-DB-EXEC-003-dangerous-confirm-browser | DROP Cancel 零执行、确认后产生一个失败日志 | 同名 native 用例验证确认与实际数据库效果 |
| TC-DB-EXEC-004-explain-browser | DDL Explain 显示原因且无执行日志 | 同名 native 用例验证真实 Explain 结果 |
| TC-DB-TX-001-manual-commit-browser | 离线 Auto 禁用，Commit/pending 控件缺席 | 同名 native 用例验证真实 manual commit / rollback |
| TC-auto-F-DB-1-query-tab-rename | 双击 rename 保存完整名称；菜单 rename 的 Escape 取消 | query-tab-rename-native / native-restore 验证 SQLite 和重启 |
| TC-auto-F-DB-1-sql-session-scaffold | Query Library namespace/archive/search、唯一名称和完整 SELECT 42 内容保存 | N12/N15 与 native query-workspace 边界；本例不声称真实数据库连接 |

最终范围增至 249 个 ID，预计 browser 三端各 190，native Linux / Windows / macOS 为 67 / 61 / 60，共 758 次；以最终固定输入的 selection 与逐 case 报告核实。原 242 ID 文件和历史报告保留，不用新范围改写历史结果。

七条 DB browser 在固定输入 `d39a285b983ad384bbc7e569ccdbb8b172132ae3` 的 [run 37215235654](https://github.com/engcapa/taomni/actions/runs/37215235654) 三端各 7 pass / 0 fail / 0 skip；selection/source/runner/case/receipt/config 与 ZIP hashes 一致。此结果只证明上述离线 renderer 验收，真实 SQL、事务、SQLite 和重启仍由最终输入的 native case 验证。

N15 路径输入补充：在 Enter 之前用 `assert_value` 要求路径框精确等于隔离 fixture 的完整本地目录。它补充既有上传 growing/pause、退出取消、MySQL rollback 与进程退出检查；原 126 个动作和结果均保留，总预算仍为 600 秒。原生输入器复用已存在的 verified focus，避免 WebKit 重新点击 blur-commit 输入框使 Ctrl+A 落到整页。当前修复的单测通过不代替三端原生复验。

独立进程 oracle 补充：Windows 使用 Toolhelp32 和 QueryFullProcessImageNameW 读取 OS 进程树与完整 executable，Linux/macOS 继续使用独立 OS 枚举。running 必须在本轮 driver 后代树中找到唯一 QA executable 并记录 PID；exited 必须确认该进程消失，原 PID 的 executable 暂时不可读不记退出。N15 在 [run 37216273760](https://github.com/engcapa/taomni/actions/runs/37216273760) 的 Linux/macOS 127 步已通过；Windows 原 CIM 枚举超时的失败报告保留，新 oracle 待 GitHub 复验。预算未改变。

Windows N15 的新 oracle 已在固定输入 `dadb395d374a49524bc652bea351b987ae91fe86` 的 [run 37217880429](https://github.com/engcapa/taomni/actions/runs/37217880429) 127 步全部通过，报告身份、native build 和原始 ZIP hashes 匹配。随后同输入的六端 249 ID 运行中，Linux browser 190/0/0、macOS browser 189/1/0；macOS B18 原定位命中了隐藏 alpha view，现对 alpha/beta 的 list/file/download 操作分别限定真实 Host owner。95 步、150 秒和全部业务结果保持，修正输入待 GitHub 复验。

B18 已在固定输入 `62b668c50ce09ba7e39f2b7cd624bf6b95007ff8` 的 [run 37221675568](https://github.com/engcapa/taomni/actions/runs/37221675568) 三端 browser 全部通过，95 步完整执行，身份与 ZIP hashes 匹配。完整 run 37218987069 的 Linux native 67 条通过、macOS native 59 通过/1 失败；macOS 的 TC-RDPJ-01 宿主 flip 目标出现 Python 本地网络权限弹窗。flip fixture 改为独立 AppKit 小窗口，真实 RDP 输入及外部 JSON 结果、59 步和所有预算保持；其它平台和 animation/photo 源不变。工具单测通过后，仍需 GitHub 原生精准复验和最终同输入全量运行。

完整 run 37218987069 的 Windows native 61 条也已通过，六份原始证据身份均匹配。本轮改动共享 host_helper 的 macOS flip 源，最终并集追加既有 [TC-RDPS-NAT-01](../qa-ui-auto-tests/cases/TC-RDPS-NAT-01-start-connect-display.testcase.yaml) 的三端 native：独立 RDP client 的两组 codec/framebuffer、10 次真实点击和像素变化、错误密码与停止后拒绝连接。原 28 步、420 秒及所有阈值保持，不作为 Shell 原生性能基线。最终选择为 250 ID / 761 次，列表 `qa-ui-auto-report/_local/shell-ci-case-ids-final-307.txt`，仍需统一输入实际运行；旧 249 ID 报告不改写。
