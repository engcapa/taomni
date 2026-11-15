# Tao Home 实现与设计、原型核对记录（2026-11-15）

当前实现完成了首页入口和部分界面外壳，具备组件化、模式切换、历史浮层与快捷行，但尚未打通主设计 P0 的基础对话闭环。高保真原型中的主要布局、完整对话交互，以及 P1/P2 能力仍有较大缺口。不能按“原型已还原”或“DeepSeek 全家桶已接入完成”验收。

| 核对维度 | 结论 |
|---|---|
| 基础外壳与组件边界 | 大体符合：welcome 路由、三个模式、宿主槽位、独立 controller、历史入口位置等已落地 |
| 原型视觉与版式 | 部分符合：沿用主题和控件风格；空态构图、绑定栏、宽度、建议、侧栏和菜单明显偏离 |
| 原型交互 | 较低：不少按钮只有展示或局部状态变化，缺少实际处理链路 |
| P0 基础轨道 | 未贯通：请求字段不兼容、回复整批返回、停止无效、没有对话持久化和历史回传 |
| P1 chat-demo 能力 | 主要未实现；搜索、绑定、来源等有局部界面骨架 |
| P2 Agent 能力 | 动作/预算有辅助代码，执行、工作流、记忆与恢复链路未接入 |

这里不提供主观百分比：一个可见按钮、一个通过的组件测试，与一个可用且可恢复的原生流程，不能等权计为“完成”。以下分别列出已符合部分、具体缺口及证据。

审查发现与用户后续追加的目录历史、新对话入口、浮层/绑定、Markdown、Notes Workspace 及 Mermaid 主题/Word 导出要求，已汇总到[后续待办（38 项，全部待办）](tao-home-follow-up/development-tasks.md)。其中用户截图与本报告的发送契约问题合并记录，新增要求不反向冒充原设计既有条目；本报告保持改前核对记录。

**核对基线与方法**

- 代码基线：`6170f095ff3de7e555d43a183446437c29dca6e5`，检查开始时工作树干净。
- 用户指定基线：[主设计 v1.3](tao-home-design.md)、[高保真原型 v0.3](tao-home-prototype.html)。另读取[细化设计 v0.3](tao-home-detailed-design.md)解释已记录的设计演进。
- 原型已将历史入口移至 Composer 下方、按检测显示 WSL、移除 Home 的 LAN 聊天入口。这些与较早主设计不同的地方不计为实现缺陷。
- Windows / Chromium 浏览器走查：1366×768、800×600；检查无 Key、模式、历史、搜索、绑定、演示模式、侧栏、设置入口、刷新。原型查看 S0/S1/S6 及状态菜单、来源侧栏。
- 静态核查：前端 controller/宿主/渲染、Rust 命令、provider 构造与 SSE、配置、存储和相关测试。
- 未调用真实付费 API，未配置真实 Key，未运行桌面打包版、Linux 或 macOS。下面的原生结论区分生产代码证据、离线契约复现与尚未实测项。

**最先需要处理的实现问题**

1. **阻断：前端发送请求无法反序列化为 Rust 请求。**

   `src/components/tao/ai-chat/ports.ts:104` 定义 `threadId`，`backend.ts:14` 将整个 request 原样传给 `invoke`；`src-tauri/src/deepseek_app/types.rs:5` 要求 `thread_id`，没有 `serde(rename_all = "camelCase")`、别名或适配。Tauri 顶层参数命名转换不会替嵌套结构转换字段。

   使用生产 `types.rs` 的离线 Rust 探针已复现：前端形状返回 `missing field thread_id`；只将该字段改成 `thread_id` 的对照请求可正常解析。另一个方向也不一致：Rust 发 `stop_reason`，前端读取 `stopReason`。这是生产类型的直接复现，尚非桌面 IPC 端到端实测。

   对应主设计：§7.1/§7.3、§12 P0。证据：[契约探针](../output/playwright/tao-home-audit/contract-probe/src/main.rs)。

2. **高：新轨道复用了会丢失结构信息的旧 provider，核心能力开关没有落到请求。**

   `src-tauri/src/llm/router/construction.rs:156` 将 `deepseek-messages` 构造成普通 `AnthropicProvider`；`deepseek_app/mod.rs:68` 调旧 `Llm::chat_stream`，再把所有文本包装为一个 text 块。

   `llm/anthropic.rs:130` 的请求体使用 `self.model`，忽略 `model_override`；因此首页切到 Pro 只改变前端状态，实际仍用配置模型。`request.thinking` 没有被读取，`request.web` 只改变 system 文案，没有声明 `deepseek_web_search` / `deepseek_read_url`；`safety_check: { level: "high" }` 和服务端标题也没有发送。

   `llm/anthropic.rs:390` 起只提取 text delta，忽略 thinking/signature、工具结果、引用、真实停止原因和用量；结束事件的 `usage` 固定为 `None`。即使修复问题 1，也仍不能获得设计要求的思考、搜索、引用、标题与准确计费。

   对应主设计：§3.1、§6.3/§6.4、§7.1–§7.3、§11 第 3 条；属于 P0/P1 基础链路问题。

3. **高：前端没有实时收到增量，停止也没有取消网络。**

   `deepseek_app/mod.rs:72` 创建 `Vec<TaoEvent>`，读完整个流后才在第 111 行返回；`backend.ts:14` 等待 invoke 完成后才消费事件。前端虽有流式状态机，实际表现会是等待后整批出现。

   `deepseek_app_stop`（第 115 行）直接返回 `Ok(())`；没有请求句柄、取消令牌或停止网络的实现。前端 AbortSignal 只在发起 invoke 前检查一次。请求途中出错时，`map_err(...)?` 还可能直接丢掉 Rust 已收集但尚未返回的块。

   后端也没有 `continue`、`regenerate` 实现；前端相应方法在端口缺失时直接返回 false。因此“停止后继续”“重新生成”“重试”“提高预算并继续”均未形成可用链路。

   对应主设计：§6.3、§7.3、§15 第 3/16 项。

4. **高：Tao 历史仅存内存，后续提问没有带前文。**

   `controller.ts:37` 每次创建全新的线程字典，宿主只用 `useRef` 保持当前挂载生命周期；`src/stores/taoHome/threads.ts` 只是排序函数，`sending.ts` 只是转调。生产源码未发现 `ds_app_*`、`tao_binding`、工作流表等设计存储定义及调用。

   `deepseek_app/mod.rs:61` 每次只构造一条 system 和当前 user，没有读取或接收历史。`context.rs` 有辅助函数，但没有接入发送链路；其当前组装顺序还是先放所有 user、再放所有 assistant，后续接入前也需修正。

   浏览器复现：历史中新建后显示两条“新 Tao 对话”，刷新页面后仅剩一条默认空对话。模式、绑定、模型也没有按线程保存/恢复，切线程只清空输入和 chip；旧 ChatDrawer 历史未接入这里。

   对应主设计：§6.2/§6.7、§7.2、§8、§10。影响 P0 持久化和多轮对话。

5. **高：绑定和引用目前主要是演示数据。**

   `home/BindingBar.tsx:18` 在生产组件中写死 `SSH · u80`、`WSL · Ubuntu`、`MySQL · u80`、`taomni-ai-devbuddy-1` 等候选，没有使用实际终端、数据库或工作区清单；预览内容固定为“已脱敏摘要”。

   选择绑定会自动增加 chip，与“绑定本身不发送、显式 @ 引用后再发送”的设计不同。Rust 请求结构没有 chips，发送端只遍历 context 中的名称字符串；从 Tao Search 选择的资料正文、文件内容、终端输出和表结构都没有进入模型请求。删掉 chip 也不会清除 context 中的绑定名称。

   对应主设计：§6.2、§5.6.3、§7.2，P1。

6. **高：动作确认后没有执行端口，内部仍会标记完成。**

   `TaoHomeHost.tsx:27` 创建 controller 时未注入 `actionPorts`；`controller.ts:307` 可选调用 `execute` 后，无论是否存在执行器都把动作设为 `completed`。Rust `actions.rs` 的校验辅助函数没有接到命令处理或执行流程；没有 shell 安全复核调用、SQL 执行、文件备份、撤销或结果回灌。

   动作卡也未渲染完成后的结果状态、退出码/耗时/输出。可以认可动作提议解析、卡片、前端校验的局部代码，不能认定“做”模式已可执行。对应主设计 §9、细化设计 §5，属于 P2 未完成项。

7. **高：Ctrl+K 实测会同时打开两个搜索面板。**

   `TaoAiChat.tsx:14` 与 `layouts/main/usePlatformShortcuts.ts:59` 都处理同一组合键。浏览器一次 Control+K 后，DOM 中同时出现 Tao Search 和全局 Command palette，焦点落到后者，盖住 Tao Search。

   Home 一直挂载，Tao 的监听也没有按 active 状态限制。当前测试只断言 Tao Search 存在，没有断言全局面板未打开，所以现有用例仍通过。证据：[两个面板同时打开](../output/playwright/tao-home-audit/current-search-1366.png)。

8. **中：绑定浮层被滚动容器裁剪，鼠标无法选择。**

   在 1366×768 无 Key 首页点击“绑定终端”，再点 `SSH · u80`，Playwright 的真实点击超时，命中日志为 `.tao-home-empty-stage ... intercepts pointer events`。`.tao-home-binding-bar` 设有 `overflow-x:auto`，浮层向上弹出，未像底部历史浮层那样处理裁剪。Tab 两次再 Enter 可以选中，进一步说明不是候选缺失。

   对应细化设计 §3.3。应修复弹层定位/裁剪并补实际指针与键盘选择断言。

9. **中：演示模式未隐藏绑定与上下文名称。**

   开启演示模式后，绑定栏与 Composer chip 仍显示 `SSH · u80`。`BindingBar`、`ContextChipView` 没有读取 demoMode；历史仅隐藏部分名称，工作区路径仍直接渲染。没有 F9 入口。证据：[演示模式仍显示名称](../output/playwright/tao-home-audit/current-demo-binding-1366.png)。对应细化设计 §3.6。

10. **中：设置、快捷键和浏览器降级与约定有差异。**

    “去设置”确实一步打开设置页，但没有定位到新轨道配置；通用 provider 列表直接显示内部 id `deepseek-app`（`LlmProvidersPanel.tsx:122`）。没有 Tao 专用的默认思考/联网、语音、阈值、本地资料、安全中心等 UI；宿主 PROFILE 的默认值也没有读取这些配置。

    有旧 Key 时，NoKeyCard 的两个按钮共用 `handleReuse`，“去设置”也会执行沿用逻辑，保存错误被吞掉（`TaoHomeHost.tsx:65`）。Composer 写死 Ctrl/Meta+Enter，没有读取现有 `chat_send_shortcut`；Windows 顶栏却显示 `⌘K`。Tao 文案硬编码中文，应用英语界面下仍为中文。

    主设计 §7.7 要求浏览器明确提示能力不可用并禁用 Composer。当前只按是否有 Key 禁用，没有运行环境分支；未看到该预览提示。没有伪造 DeepSeek 回复这一点符合要求。

**高保真版式核对**

[同尺寸截图对照：左为原型 S0，右为当前代码 S0](../output/playwright/tao-home-audit/comparison-no-key.png)。两侧均为 1366×768；原型顶部有演示工具条，外壳的纵向坐标不同，因此下表同时给出相对 Home 内容区的位置。原型版本号与虚构业务数据仅作示意，不要求实现照抄。

| 区域 | 原型 / 设计 | 当前实现 | 判断 |
|---|---|---|---|
| 模式切换 | 顶栏问/做/深研 | 同位置，前端默认开关按模式变化 | 相符（前端局部） |
| 绑定栏 | 模式右侧的顶栏 chip | Composer 上方，脱离顶栏 | 不符 |
| 空态布局 | 卡片/Composer/快捷行/建议构成居中整体 | 问候与卡片居中，Composer 始终贴底 | 不符 |
| Composer 尺寸 | 实测 740×100px，上沿相对 Home 高度约 41% | 实测 860×141px，上沿约 75% | 不符 |
| 工具条 | +、能力胶囊、麦克风、圆形上箭头发送 | 基本分组存在；发送图标、形状、边框、间距不同 | 部分 |
| 无 Key 卡片 | 与 Composer 同一列、紧邻上方 | 独立 520px 卡片，与 Composer 相距较大 | 部分 |
| 建议 | Composer/快捷行下方，有上下文副文案；聊天时横向收起 | 4 条固定通用文案，在 Composer 之前；无 Key 时不显示，聊天后整个消失 | 不符 |
| 底部快捷行 | 历史第一、本地终端、条件 WSL、新会话、新工作区、更多 | 顺序和条件 WSL 判断正确；没有 Home LAN 按钮 | 相符 |
| 历史浮层 | 三页签、搜索、日期分组、旧/新线程标识、新建/恢复 | 页签/搜索/新建/恢复存在，缺分组、旧线程和持久化 | 部分 |
| 顶栏更多 | 弹出导入、设置、演示模式、侧栏等菜单 | 直接打开空来源侧栏；“界面设置”也是同一动作 | 不符 |
| 侧栏 | 有真实内容时按需展开，来源/文件/生成物/工作流内容不同 | 所有页签共用“来源与本地资料会显示在这里”占位 | 不符 |
| 页脚 | Home 内品牌/版本小字 | Home 内没有；全局状态栏存在另一个版本文案 | 不符 |
| 颜色与字体 | 使用应用主题令牌 | 使用 `--taomni-*` 及局部语义色 | 相符（静态及浅色观察） |
| 矮窗口 | 保留启动快捷行、隐藏次要文案 | 800×600 快捷行仍可见，副标题隐藏 | 部分；未据此认定完整窄屏/移动端已通过 |
| 演示模式入口 | 更多菜单 / F9，隐藏敏感名称 | 常驻右下按钮，绑定名称未隐藏 | 不符 |

视觉偏差的根源是布局和组件挂载位置，不能仅靠调整颜色、圆角或图标修复。当前 `.tao-home-main` 始终使用“消息区 + 底部 Composer”两行布局，没有对空态建立居中的整体区域。

**原型交互控件是否真正接入**

| 控件/操作 | 当前情况 |
|---|---|
| + → 引用文件 | 只插入“文件引用”chip；没有文件选择、粘贴/拖拽、上传或 `file_id` |
| + → 技能/工作流 | 点击只关闭菜单，没有技能列表或工作流库 |
| 输入 @ | 直接加一条空的“本地资料”chip，没有终端/文件/工作区/数据库/笔记选择菜单 |
| 麦克风 | 无点击处理，没有录制、识别或频谱；回复朗读按钮也没有实现 |
| 能力菜单 | 可改前端思考/联网/模型状态；后端效果见问题 2 |
| 重试/重新生成/继续 | UI 或 controller 方法存在，生产 backend 未提供相应能力 |
| 编辑、分支、交给 CC/Codex | 当前消息操作区缺少这些入口；正文也没有 Markdown/代码/Mermaid/引用渲染，只显示普通文本 |
| 赞同/不赞同 | 新增了按钮，但没有点击处理；也不是原型要求的回复主操作 |
| 来源点击 | 只有普通链接，没有引用角标与侧栏定位；来源 Tab 仍为占位 |
| 用量胶囊 | 没有点击处理，原型的用量/预算浮层不存在 |
| 底部更多 | 邮件走现有命令；数据库发出未被 commandActions 处理的 `database`；“网络工具”走现有占位页；缺本地目录、VNC/RDP 等完整入口 |
| 本地终端 | 接入现有启动回调和 shell 检测；快捷行缺 shell 选择、管理员启动、打开 Home 等旧首页能力 |

证据主要为 `ai-chat/Composer.tsx:33`、`MessageList.tsx:18`、`TopBar.tsx:42`、`SidePanel.tsx:6`、`home/DockRow.tsx:24`、`layouts/main/commandActions.ts:190`。

**按主设计 §15 的 20 项验收核对**

“部分”表示有局部代码/界面，不能作为整项通过；“未贯通”表示已发现链路阻断；“未验证”表示本次证据不足，不能算失败或通过。P2/P3 缺项按规划未完成记录，不混作 P0 阶段新增回归。

| # | 验收项 | 阶段 | 当前判断与依据 |
|---|---|---|---|
| 1 | 打开即 Tao、居中 Composer | P0 | 部分：首页入口已替换；空态 Composer 未居中 |
| 2 | 无 Key 一步到设置、填后可发且不丢草稿 | P0 | 部分：到设置入口通过；配置后原生发送被契约阻断，沿用按钮逻辑有偏差 |
| 3 | 流式问答、thinking、耗时 | P0 | 未贯通：旧 provider 丢 thinking，事件整批返回，没有耗时 |
| 4 | 拒答丢弃思考/正文、保留工具 | P0 | 未贯通：模拟事件可触发拒答卡，真实原因被丢弃，字段名不一致；前端拒答还会清除全部旧块 |
| 5 | 联网步骤、来源、引用角标 | P1 | 未贯通：有部分渲染函数，没有真实工具声明/结果或引用模型 |
| 6 | 自动读链接、追问恢复 | P1 | 未实现：无 read_url 声明、结果/签名回传或历史回传 |
| 7 | PDF/图片问答、复用 file_id | P1 | 未实现：无 Files 命令、上传模块、映射表 |
| 8 | 本地默认、可选 DeepSeek ASR/TTS | P1 | 未实现：首页麦克风空处理，未接 DeepSeek 语音 |
| 9 | ZIP v3 历史导入为新线程 | P1 | 未实现：无导入向导、解析/事务或导出链路 |
| 10 | 准确用量、工具次数、费用估算 | P1 | 部分：有显示和辅助函数，生产 provider 不返回 usage，估算函数未接入 |
| 11 | 可预览/删除的真实上下文绑定 | P1 | 部分：有 chip，但候选写死、预览占位、Rust 忽略 chip，且浮层鼠标不可点 |
| 12 | 确认执行、备份、撤销 | P2 | 部分：动作卡/校验辅助代码存在，无实际执行闭环 |
| 13 | 确认后记忆、可读删导出 | P2 | 未实现 |
| 14 | 旧 tao-chat/CC/Codex/ACP/终端等全部回归 | 全部 | 未验证：本次仅运行 Tao 相关 16 项单测及 1 项外壳 QA |
| 15 | Vault 锁定时阻止明文 Key 保存、弹解锁 | 全部 | 未验证：复用 aiStore 保存门禁；本次未运行原生解锁/保存流程 |
| 16 | 错误可重试、已收块不丢 | 全部 | 部分：有错误卡，生产重试未接，返回前失败可能丢已收块 |
| 17 | 找回 SQL 等本地资料、来源排除、源开关 | P1 | 部分：仅内存线程/最近会话/工作区搜索，无 SQL/命令/笔记连接器、FTS5 或源开关 |
| 18 | 敏感数据 S1–S8 | P1/P2 | 未完成：脱敏规则有扩展，写入脱敏、迁移、锁定取消等关键链路缺失；未做原生全项验收 |
| 19 | 每轮 10M、50%/80%、停后提高预算续跑 | P2 | 部分：有 meter/警告代码；没有累计完整工具循环、预算修改或生产续跑 |
| 20 | 五个内置工作流、跳过/取消、重启续跑 | P2 | 未实现：只有 phase 类型和简单计划渲染，没有注册表/执行器/持久化 |

本地检索目前是 `TaoHomeHost.tsx:41` 的内存 fallback 和 `search/query.ts:24` 的字符串匹配，不是设计的结构化 + FTS5。短词回退与正常分支都调用 `includes`，没有 BM25/trigram。搜索面板显示 ↑/↓/Enter 提示，但没有相应选择处理；“问 Tao”只填标题，没有加入资料正文；大多数本地记录也没有打开原记录入口。

预算方面，`budget.ts:42` 取 `max(既有用量, 当前 input+output)`，不是对同轮多次调用求和；预算状态属于线程，没有在新用户轮次完整重置。配置的工具费用阈值目前只存在于类型/默认值，没有实际确认执行点。

**安全要求的匹配边界**

- 已有正向基础：请求经 Rust、Key 保存复用 Vault 门禁；provider 复用共享代理解析；无代理的 reqwest client 使用 `no_proxy()`，代理解析失败会注册失败 provider，未看到静默直连回退；Rust 脱敏已增加私钥、AWS、GitHub、JWT、连接串等规则。
- `history.rs:27` 仍把 trimmed 原始命令写入历史；`database/history.rs` 仍直接写 `entry.sql_content`。未发现设计要求的写入脱敏标记、旧历史清理迁移。它们是设计已承认的旧缺口，不能因为新增 `redact()` 测试就认定 S1/S8 完成。
- `vault_lock` 会重建 router，能阻止后续使用旧注册项；但 Tao 已发出的请求持有自己的 provider Arc，没有接入取消，也没有把错误映射为 `vault_locked`。不能据此宣称锁定会立即停止在途请求或弹正确遮罩。
- 未发现 Tao 专用的来源片段丢弃、注入拦截、审计、安全中心和出站 allowlist 实现。它们应在对应阶段补齐，不应以 UI 文案替代实现证据。
- 主设计 §11 第 5 条“不使用代理不得绕过系统/环境代理”的文字，与仓库 AGENTS 的“必须绕过隐式系统/环境代理”相反。验收应遵循 AGENTS，并在设计修订中纠正该句，不能据错误句子要求实现启用环境代理。

**本次执行证据与局限**

| 检查 | 结果 | 能证明什么 |
|---|---|---|
| Tao 相关 Vitest，6 个文件 | 16 passed / 0 failed | controller、组件及动作/预算/脱敏/查询的选定单元行为 |
| `TC-TAO-HOME-001`，Windows browser | 1 passed / 0 failed / 0 skipped，source stable | 无 Key 外壳、模式、历史三页签、搜索空态、演示模式开关、无运行时错误 |
| 生产 Rust 类型离线探针 | 已复现 `missing field thread_id` 和 `stop_reason`/`stopReason` 差异 | 实际生产序列化契约不兼容；不替代桌面完整 IPC 测试 |
| 浏览器手动自动化走查 | 已复现双搜索面板、绑定候选鼠标被遮挡、演示名称未隐藏、刷新丢新线程 | 上述 renderer 行为和截图 |
| 原生 DeepSeek/Vault/文件/语音/网络 | 未运行 | 不能认定 API、代理/取消、OS 输入或桌面平台兼容已通过 |
| 全量 crash-regression、完整旧功能回归、完整构建 | 本次未运行 | 本任务为审查，未改产品；不能使用本次局部绿灯作为产品交付验收 |

单测命令：

```powershell
pnpm exec vitest run src/components/tao/ai-chat/controller.test.ts src/components/tao/ai-chat/TaoAiChat.test.tsx src/components/tao/actions.test.ts src/components/tao/budget.test.ts src/components/tao/redact.test.ts src/components/tao/search/query.test.ts
cargo run --manifest-path output/playwright/tao-home-audit/contract-probe/Cargo.toml --offline --quiet
```

QA 证据：[summary](../output/playwright/tao-home-audit/qa/run-20261115-183148-338257100/summary.md)、[完整结果](../output/playwright/tao-home-audit/qa/run-20261115-183148-338257100/summary.json)、[runner receipt](../output/playwright/tao-home-audit/qa/run-20261115-183148-338257100/runner_receipt.json)。运行命令、URL 和日志在 `output/playwright/tao-home-audit/qa-run.log` 及 `qa-browser.yaml`；最终运行使用本次独立启动的 5015 端口。

截图：[原型无 Key](../output/playwright/tao-home-audit/prototype-no-key-1366.png)、[当前无 Key](../output/playwright/tao-home-audit/current-no-key-1366.png)、[原型就绪](../output/playwright/tao-home-audit/prototype-ready-1366.png)、[原型完成态](../output/playwright/tao-home-audit/prototype-complete-1366.png)、[当前历史](../output/playwright/tao-home-audit/current-history-1366.png)、[当前占位侧栏](../output/playwright/tao-home-audit/current-side-panel-1366.png)、[800×600 当前界面](../output/playwright/tao-home-audit/current-no-key-800.png)。这些本地证据位于被忽略的 output 目录，提交报告时如需共享，应另行附上截图/运行产物。

原型控制台仅见 favicon 404；首轮浏览器复用的 5000 服务中途停止，随后设置页出现字体资源连接失败。最终 5015 首页走查和独立 QA 未出现 console error。没有把这些服务/静态资源事件归为 Tao 功能缺陷。

**建议处理顺序**

1. 先补 P0 最小闭环：统一 IPC 类型 → 独立 Messages 块协议/实时事件 → 真实取消与错误保留 → SQLite 历史和上下文回传 → 原生验证。同步确认思考、模型、safety、title 和 usage 确实出现在请求/响应链路。
2. 修复已出现的交互错误：双搜索、浮层裁剪、无执行器却完成、无效重试/继续、演示模式名称、设置按钮分流。
3. 按原型重建空态/对话态的布局差异，再对齐绑定栏、建议、菜单、侧栏与页脚；保留已接好的历史/快捷行/条件 WSL/无 LAN 入口。
4. 按 P1/P2 阶段补真实上下文、FTS5 与安全前置、Files/语音/导入，以及动作执行、工作流和记忆。每项以真实数据及相应原生边界证据验收。

## 最新验证入口（2026-11-16）

[后续验证回执](tao-home-follow-up/verification-2026-11-16.md)：Windows Tao 真机 7/7 通过，包含真实商业 DeepSeek 正常回复、流式取消、多轮持久化、代理模式及用户报告交互。完整 crash-regression 与 Linux/macOS hosted 继续执行；未完成 AC、Word 客户端视觉和 macOS OS 输入边界保持待验证。下述修复前基线与旧阶段状态按日期保留，不能用旧的“未运行”覆盖新具名证据，也不能由局部通过认定全部设计已完成。

## 最新实施与验证回执（2026-11-15）

以上静态审查记录的是修复前基线。当前分支已实施后续任务，并按用户反馈覆盖原型冲突项：

- Tao Home：Messages 请求/事件契约、流式 Channel、取消与线程快照；旧 ChatDrawer 历史摘要合并到 Tao 历史但保持只读回旧入口；最近访问目录恢复并沿用旧默认排序；新 Tao 入口、浮层关闭、绑定重绑清理、搜索 claim、Settings 去重、完整 Tao 中英文文案已接入。
- 用户截图问题：无 WSL distro 时隐藏按钮和安装提示；建议区换行且无横向滚动；右侧面板提供语义 icon、tooltip、resize、collapse/expand 与 X 关闭；绑定按钮接真实资源清单并通过显式引用进入请求；错误卡保留重试入口。
- Markdown/Notes：TOC 默认关闭、split 拖拽、Live 默认只读并显式 Edit 解锁；Notes Workspace 使用 Markdown owner；Mermaid 提供跟随/浅色/深色预览主题；DOCX Mermaid 使用 SVG/高分辨率栅格 fallback。Word 客户端实际放大视觉仍未关闭。

本批静态与自动化证据：13 个 frontend focused test files / 39 tests、Tao Rust focused 17 tests、`tsc -b --force`、`cargo check --lib`、`cargo fmt -- --check`、`pnpm build` 均通过；Rust 全默认 feature 的 Windows 链接仍受仓库既有 whisper/clickhouse MD/MT 冲突影响，因此不宣称全量 Rust 通过。`qa_ui_auto audit --gate` 通过，control catalog 已重新生成。Windows browser 的 TC-TAO-HOME-001/003/006/007、Markdown/Notes 及目录排序证据已保留；SidePanel 最终 resize/icon-only run 为通过。TC-TAO-HOME-002/004/005 与完整 Windows native 需要匹配当前源码的 QA release 回执；Linux/macOS browser/native 需通过 `qa-ui-auto-platforms.yml` hosted run。

高保真原型核对结论仍分为“用户反馈优先的修复”和“原型差异待办”：原型的空态 hero 居中、dock/suggestion 顺序、绑定栏布局、固定 flex side、完整能力菜单/录音覆盖层/页脚等仍有结构差异；SidePanel 可缩放/关闭、明显的新 Tao 入口、WSL 隐藏、Settings 去重和 icon-only 是用户明确要求，按用户要求保留。后续原型对齐不能把未实现的 workflow/录音/附件能力以静态截图或占位文本宣称完成。

## 2026-11-15 后续实现与验证更新

本轮已在 `feat/tao-home-follow-up` 分支实施一组 Tao Home、Markdown 与 Notes 修复。实现范围包括 Tao Home 多语言、可见新建对话入口、最近目录历史及旧排序、浮层关闭、设置/绑定状态、DeepSeek Messages 流式协议与取消、线程消息持久化、多轮上下文、动作/工作流/记忆基础能力；Markdown/Notes 包括 TOC 默认关闭、Live 只读、split 调整、Notes 复用 Markdown 处理、Mermaid 预览主题和 DOCX Mermaid 高清导出。上述能力中，标为“部分完成”的任务仍保留原有未贯通的完整验收条件，不能由局部实现推断为全部完成。

代码与测试证据：`tsc --noEmit`、`pnpm build`、受影响 Vitest（16 个文件/104 个测试）以及 Markdown/Notes focused Vitest（12 个文件/58 个测试）通过；`cargo check --lib`、`cargo fmt -- --check` 通过。完整 Rust 测试二进制在 Windows 链接阶段仍因既有 `whisper`/`clickhouse` MD/MT `LNK2038` 运行库冲突失败，该失败不是新增 Rust 编译错误。

QA 证据应同时检查 source hash、runner receipt、runtime-errors 和真实步骤结果。Windows browser/native 使用匹配当前源码的 QA release binary；Linux/macOS browser/native 通过 `qa-ui-auto-platforms.yml` hosted run。真实商业 DeepSeek/Vault、Word 客户端视觉、macOS AppKit 实际输入仍属于边界验证，未以 browser stub 或 `cargo check` 代替。
