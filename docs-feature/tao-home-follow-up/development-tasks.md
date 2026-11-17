# Tao Home、Markdown 与 Notes 后续待办

日期：2026-11-15。状态：**本轮已实现并验证一组 P0/P1 修复；其余任务按下方状态继续跟踪**。本文件汇总[实现核对报告](../tao-home-implementation-audit-2026-11-15.md)的发现与用户追加要求，作为后续排期、开发和验收入口。

2026-11-16 完成度复核：**39 个原任务尚未全部按完整 AC 关闭**。早期未勾选状态与后续追加回执存在不同步，逐项实现/验收状态见[当前完成度复核](completion-audit-2026-11-16.md)。最新 macOS native 补跑 [43886401191](https://github.com/engcapa/taomni/actions/runs/43886401191) 已 **32/32** 通过，覆盖原缺失全部 21 项及完整 22 项 native crash，签名/产物/当前输入独立核对通过；旧 F12 评审元数据与其余设计/商业验收待办仍保留。

2026-11-16 最新批次：`e57779493` 的 Windows browser/native **30/30 / 36/36**、Linux browser/native **30/30 / 33/33**、macOS browser/native **31/31 / 35/35** 均通过，零失败、零跳过，含各平台全部适用 crash-regression（browser **18/18**、native **22/22**）和 Windows 八次真实商业 DeepSeek 请求。完整 frontend **7011 passed / 1 条件跳过 / 0 failed**，120 项 native Rust 契约通过。最新身份、原始回执及边界见[当前源码验证批次](verification-2026-11-16.md#e57779493-当前源码的最终验证批次)；此前失败与修复过程保留在同文件较早章节。Word 16 已确认代表流程图与两条公式的实际排版、100%/200% 清晰。以下较早表格中的“native 待验证”以最新具名断言为准，完整 AC 未由局部通过自动关闭。

基线：[主设计 v1.3](../tao-home-design.md)、[细化设计 v0.3](../tao-home-detailed-design.md)、[高保真原型 v0.3](../tao-home-prototype.html)；代码核查基线为 `6170f095ff3de7e555d43a183446437c29dca6e5`。源码位置是本次定位线索，实施前需复核最新代码。

优先级使用“阻断 / 高 / 中”；P0/P1/P2 是原设计交付阶段，二者不能混用。标为“设计缺项”的任务表示尚未实现原规划，不一概视为本次改版新增回归。用户新增要求按本文件执行；原设计、原型中尚未包含的部分应在对应任务实施时同步更新。

## 1. 用户反馈与待办对应

| 来源 | 用户要求或观察 | 待办 |
|---|---|---|
| 本轮追加 | 保留当前历史，同时恢复旧 Home 最近访问目录；沿用原默认排序 | TH-005 |
| 用户截图及描述 | 默认 DeepSeek provider，发送“你好”后提示缺少 `thread_id` | TH-001；错误归类、重复错误卡和重试归 TH-003 |
| 本轮追加 | 新 Tao 对话入口不明显，藏在历史深处 | TH-006 |
| 本轮追加 | 部分浮层选择后不消失，只能再点原按钮关闭 | TH-008 |
| 本轮追加 | 对话框中的绑定按钮没有生效 | TH-007、TH-008 |
| 本轮追加 | Markdown 导出时，头部目录选项默认不勾选 | MD-001 |
| 本轮追加 | Markdown split 左右可调整大小 | MD-002 |
| 本轮追加 | Markdown live 默认只读，点击“编辑”后才能修改 | MD-003 |
| 后续追加 | Notes Workspace 中 Markdown 消息的展示、编辑、逻辑与 UI 和 Markdown 文件统一；小型 tao-chat 先保持原样 | MD-004 |
| 后续追加 | Mermaid 在深色主题下部分图框、连线、文字看不清；考虑仅切换 Live 展示主题的快捷入口 | MD-005 |
| 后续追加 | Word 导出的 Mermaid 整体偏小、放大模糊；用户观察 PDF 等其它导出正常 | MD-006 |
| 开发中追加 | Tao Home 完整支持多语言，跟随应用语言设置，切换时保留线程与草稿 | TH-012（明确列为本批交付要求） |

[用户原始截图](evidence/user-feedback-2026-11-15.png)为用户反馈证据，并非本轮执行的桌面测试。截图可确认发送“你好”后出现 `invalid args request for command deepseek_app_send: missing field thread_id`，同一次失败还显示两处错误/重试 UI；“默认 DeepSeek”的配置情况来自用户描述。契约根因另有源码与离线探针支持，见核对报告。浮层关闭问题的具体控件范围仍需实施时逐个复现，不能从单张截图推定所有浮层都有相同根因。

本文件采用稳定任务 ID；每个任务的 `AC-*` 是完成条件，`V-*` 对应第 5 节验证组。实现状态以本轮代码、单元测试和 QA 运行回执为准；未覆盖的完整验收仍保留为待办。

## 2A. 2026-11-15 本轮实现状态

| 范围 | 状态 | 证据/限制 |
|---|---|---|
| TH-001/002/003 | **部分完成** | DeepSeek Messages DTO、SSE 分片、实时 Tauri Channel、取消、错误分类和 loopback fixture 已接入；真实商业 DeepSeek、Vault 和网络故障仍需原生验证。 |
| TH-004 | **部分完成** | 线程/消息/模式配置、多轮上下文、continue/regenerate、branch 已持久化；旧 Tao history 与所有迁移场景仍需继续验收。 |
| TH-005/006/008/010/011/012 | **已实现** | 最近目录页签复用旧排序、可见新建入口、浮层外部点击/Escape、搜索快捷键独占、设置导航、多语言及浏览器降级均有 focused unit/QA case。 |
| TH-007/015/016/017/018/020/021/023/026/027 | **部分完成** | 真实资源、文件/引用、消息操作、文件/语音、导入导出、来源开关、完整 workflow UI 等仍有未贯通路径；已实现的后端能力需继续接 UI 和原生证据。 |
| TH-025/028/029/030/031/032 | **部分完成** | action runner、undo、memory/SOUL/skill、workflow checkpoint、archive/search 已有实现；安全中心、完整权限/审计和 UI 验收仍未关闭。 |
| MD-001/002/003 | **已实现** | TOC 默认关闭、split 拖拽/键盘调整/复位、Live 默认只读并由 Edit 解锁；Vitest 与 `TC-FILE-OPEN-013` 覆盖。 |
| MD-004 | **已实现** | Notes Workspace 复用 Markdown owner、编辑/预览/保存和冲突处理；小 Tao chat 保持原展示逻辑。 |
| MD-005/006 | **已实现（需客户端边界验证）** | Mermaid auto/light/dark 独立主题；DOCX 使用 SVG/300DPI PNG fallback 并有质量 oracle。Word 客户端视觉仍需桌面验收。 |

本轮实际验证：`tsc --noEmit`、`pnpm build`、受影响 Vitest（16 files/104 tests）和 Markdown/Notes focused Vitest（12 files/58 tests）通过；`cargo check --lib` 与 `cargo fmt -- --check` 通过。完整 Rust 测试在 Windows 链接阶段受既有 `whisper`/`clickhouse` MD/MT `LNK2038` 冲突阻断，不能记为 Rust 全量通过。Windows browser/native 及 Linux/macOS hosted 结果记录在第 5 节和实现核对报告中。

## 2. Tao 基础闭环与用户直接遇到的问题

### TH-001 · 修复 DeepSeek 发送 IPC 契约

- [ ] **待办｜阻断｜已确认缺陷｜P0**。统一嵌套 request 和响应事件的序列化命名，覆盖 `threadId/thread_id`、`stopReason/stop_reason` 及完整 DTO。
- 依据：核对报告问题 1、用户截图；`ai-chat/ports.ts:104`、`ai-chat/backend.ts:14`、`src-tauri/src/deepseek_app/types.rs:5`（前端路径均在 `src/components/tao/` 下）。
- `AC-TH-001`：使用默认首页 DeepSeek 轨道发送“你好”，真实桌面 IPC 能反序列化并进入请求；正常结束、停止、拒答的原因均可被前端识别。不再出现该缺字段错误，也不通过改走旧轨道掩盖问题。
- 验证：V-01 的生产 DTO 往返与原生 IPC；成功回复还依赖 TH-002/003。浏览器 stub 或只改一个字段的探针不能单独关闭本任务。

### TH-002 · 打通 Messages 协议和能力开关

- [ ] **待办｜高｜设计缺项与接入缺陷｜P0/P1**。建立保留结构信息的新轨道适配，落实逐请求模型、thinking、联网工具、`safety_check`、服务端标题和完整事件。
- 依据：核对报告问题 2；`llm/router/construction.rs:156`、`llm/anthropic.rs:130/:390`、`deepseek_app/mod.rs:68`（Rust 路径在 `src-tauri/src/` 下）。目前模型覆盖被忽略，联网仅为 system 提示，解析仅留文本。
- `AC-TH-002`：请求中的实际模型/开关随 UI 改变；text、thinking/signature、tool、citation、usage 和真实 stop reason 不丢失；新轨道符合主设计 §3.1/§7，旧 OpenAI/Anthropic/本地/CC/Codex/ACP 轨道保持原契约。
- 验证：V-01，捕获测试服务请求与分片响应，再完成真实 provider 原生验证；依赖 TH-001。

### TH-003 · 真实流式、取消、错误恢复与重试

- [ ] **待办｜高｜已确认缺陷与设计缺项｜P0**。取消 Rust 收集完成后才返回的假流式；接入独立请求所有权、真实网络取消、继续/重新生成/重试端口。
- 依据：核对报告问题 3、§15 第 4/16 项及用户截图；`deepseek_app/mod.rs:72/:111/:115`、`ai-chat/backend.ts`、`ai-chat/controller.ts`。当前 stop 为 no-op，异常可能丢掉已收但未返回的块；截图把参数错误归为“网络不可用”并显示两组重试。
- `AC-TH-003`：首块到达即可显示；按设计口径实际计量/显示思考及响应耗时，停止/失败也正确终结计时；停止后网络活动实际终止；中途失败保留已收内容和可恢复状态。区分参数、鉴权、网络/代理、Vault、拒答等错误，一次失败有明确且不重复的主恢复入口；只有确实收到内容才声称“内容已保留”。重试/继续/再生成实际发起对应请求且不重复落消息；拒答仅处理本轮相关思考/正文，按设计保留工具块及先前轮次。
- 验证：V-01/V-05；TH-001/002 后集成，覆盖慢流、断流、取消竞争、切线程/离开页面后返回和重试去重。

### TH-004 · 对话持久化、多轮上下文与旧历史共存

- [ ] **待办｜高｜已确认缺陷与设计缺项｜P0/P1**。新 Tao 线程、消息块、分支及线程级模式/模型/绑定需持久化，恢复后仍可继续真实多轮对话。
- 依据：核对报告问题 4；`ai-chat/controller.ts:37`、`home/TaoHomeHost.tsx`、`src/stores/taoHome/threads.ts`、`deepseek_app/mod.rs:61`、`deepseek_app/context.rs`。当前刷新丢新线程，请求只有 system + 当前 user；未接入的 helper 还会把 user/assistant 分组错序。
- `AC-TH-004`：刷新/重启后线程与内容不丢，按线程恢复状态；按对话顺序组装历史，遵守思考/签名/读链接/文件回传规则。历史按设计分组、标识新旧轨道和进行中状态；旧 tao-chat 记录共存，点击仍走原打开路径，不强迁移或改写旧线程。
- 验证：V-01/V-03；真实 SQLite reopen、多轮请求断言、切线程隔离与旧 ChatDrawer 回归；依赖 TH-001/002。

### TH-005 · 恢复最近访问目录并保留原默认排序

- [ ] **待办｜高｜用户明确追加的兼容要求｜P0-H**。Tao“历史”保留 Tao 对话、最近会话、最近工作区，并接回旧 Home 的“最近访问目录/本地目录”。复用原数据与刷新链路，不另建一份历史。
- 依据：旧 `src/components/welcome/WelcomeHistoryPanel.tsx:32`、`LocalDirectoriesPanel.tsx:25`、`src/hooks/useWelcomeDirectories.ts:22`；当前 `home/HistoryPopover.tsx:7` 仅有三个页签。目录权威排序见 `src-tauri/src/terminal/local_directories/listing.rs:259`。
- `AC-TH-005a`：目录按原 comparator 保序：有 `last_used_at_ms` 的按时间降序；其后无时间但有 `legacy_rank` 的升序；再其后有 `default_rank` 的升序；其余按 `identity_key` 字节序。同时间/排名用 `identity_key` 稳定排序。有真实使用时间的默认目录也参与时间排序，不固定置顶；沿用最多 24 个非默认目录及默认目录保留策略，不在前端改按名称重排。
- `AC-TH-005b`：旧记录、未知时间、不可用状态和默认目录均保留；筛选只过滤不改变相对顺序。最近会话沿用 `last_connected_at ?? 0` 降序（原默认 `last-desc`），最近工作区沿用 `lastOpenedAt` 降序；保留原有排序选项及默认值，不凭空新增排序偏好持久化/迁移。排序依据见 `welcome/useWelcomeHistory.ts:19/:71`、`welcome/sessionModel.ts:39`。
- `AC-TH-005c`：点击仍按目录 cwd 和已选 shell 打开本地终端，WSL 沿用 `--cd`；同目录 pending 防重复。只有原生启动成功/确认的 live cwd 才推进使用时间；点击、排队、失败和浏览器不支持均不写假时间。保留 revision 刷新、隐藏后补刷新、过期响应丢弃、失败保留上次成功列表、重试和不可用目录重检语义。
- 验证：V-02/V-03；复用 `useWelcomeDirectories.test.tsx`、`local_directories/tests.rs`、`components/tests/welcomePanel/layout2.cases.tsx`、`welcome_recents_resume.rs`。将 `TC-WELCOME-RS-01-directory-order` 的旧 Home 入口更新为 Tao，并用同一组种子比较旧/新顺序；所选 shell 启动能力与 TH-024 联验。

### TH-006 · 让“新 Tao 对话”可直接发现

- [ ] **待办｜高｜用户明确追加的体验要求｜P0-H**。在空态和对话态提供可见、直接可操作的“新 Tao 对话”入口，不能只有进入历史后才能找到。
- 依据：用户反馈；`home/HistoryPopover.tsx` 当前仅在历史浮层 footer 提供创建；`home/DockRow.tsx` 的“新会话”是连接/终端会话操作。
- `AC-TH-006`：无需打开历史即可一次触发创建 Tao 对话；文案/可访问名称与“新会话”明确区分。创建后聚焦输入框，旧线程仍可找回，不覆盖其内容、运行状态和绑定；草稿与在途请求按 controller 所有权处理，不因入口变化丢失。
- 验证：V-02/V-03；同时检查空态、已有对话、小窗口及键盘可达性；持久恢复依赖 TH-004。实现时同步原型入口，不把该新增要求误称为旧原型已定义行为。

### TH-007 · 绑定真实工作区、终端、数据库与引用内容

- [ ] **待办｜高｜用户反馈、已确认缺陷与设计缺项｜P1**。绑定候选从真实资源清单读取，绑定、显式引用、预览、删除与请求上下文贯通。
- 依据：核对报告问题 5、用户“绑定按钮没生效”；`home/BindingBar.tsx:18` 写死示例资源与“已脱敏摘要”，Rust DTO 忽略 chips，`@` 只加空 chip。
- `AC-TH-007`：各绑定按钮可用鼠标选择真实资源；绑定本身不自动发送内容，显式 `@` 后才选择范围并预览脱敏后的真实正文。文件/终端最近输出/schema/本地资料按权限和限额进入实际请求；移除引用后请求不再包含该片段，解绑清理相关引用，线程间互不污染。无资源/资源已关闭/读取失败有明确状态，生产代码不回退演示候选。
- 验证：V-02/V-05；真实资源与后端请求断言，结合 TH-004/008/023/028 的持久化、浮层、检索与安全前置。

### TH-008 · 修复浮层裁剪、选择和关闭行为

- [ ] **待办｜高｜用户反馈与已确认局部缺陷｜P0-H/P1**。逐个核查绑定选择器、Composer“+”与能力菜单、上下文预览、历史、Dock 更多、顶栏菜单，修复遮挡与不能自然关闭的问题。
- 依据：核对报告问题 8；`.tao-home-binding-bar` 的 `overflow-x:auto` 裁剪向上浮层，实测鼠标被空态区拦截；`ai-chat/Composer.tsx`、`home/BindingBar.tsx` 多处仅靠 trigger 切换局部状态。用户报告范围不能全归因于裁剪。
- `AC-TH-008`：选择单次动作/候选后执行并关闭对应浮层；多选/连续开关若需保持打开，应有清晰关闭方式。所有临时浮层支持外部点击、Escape、再次点击 trigger；打开另一浮层不留下遮挡层。关闭后焦点回触发按钮或选中目标对应输入区；正文编辑/IME 不被抢占。真实鼠标点击不被裁剪/透明层拦截，小窗口和滚动后定位正常。
- 验证：V-02；每个入口分别断言“动作生效 + 浮层正确消失/保留 + 焦点”，不能只测 DOM 存在或用键盘绕过鼠标缺陷。

### TH-009 · 禁止没有执行器却显示动作完成

- [ ] **待办｜高｜已确认缺陷｜P2 能力的当前保护**。动作端口未注入或执行失败时不能标记成功；未具备真实执行能力时明确禁用/说明。
- 依据：核对报告问题 6；`home/TaoHomeHost.tsx:27` 未注入 `actionPorts`，`ai-chat/controller.ts:307` 可选调用后仍改为 `completed`。
- `AC-TH-009`：无 executor、reject、异常、取消均有各自真实状态；只有执行器返回成功证据才显示成功，并展示结果。此保护可先于完整 TH-025 落地，不能以占位“完成”替代 P2 执行。
- 验证：V-02，端口缺失/失败/成功行为测试；真实副作用在 TH-025 的 V-05 验证。

### TH-010 · 解决 Tao 搜索与全局命令面板快捷键重复派发

- [ ] **待办｜高｜已复现缺陷｜P0-H**。按 Home active 状态、焦点和快捷键所有权处理 Tao Search，避免挂载即全局拦截。
- 依据：核对报告问题 7；`ai-chat/TaoAiChat.tsx:14` 和 `src/layouts/main/usePlatformShortcuts.ts:59` 同时处理 Ctrl+K。
- `AC-TH-010`：Home 有效上下文中 Windows/Linux Ctrl+K、macOS Cmd+K 只打开一次 Tao Search；离开 Home 时由对应页面/全局命令所有者处理，不出现两个面板。关闭回原焦点；IME、可编辑区和禁用上下文行为明确；若有原生菜单 accelerator，不能与前端重复派发。
- 验证：V-02/V-05；断言目标面板出现且另一面板未打开，覆盖 Home 常驻但不可见、编辑焦点与 macOS 原生菜单路径。

### TH-011 · 接通 Tao 设置、Key 操作与模式默认配置

- [ ] **待办｜高｜已确认缺陷与设计缺项｜P0/P1**。“去设置”与“沿用旧 Key”必须分流；设置定位到 Tao/DeepSeek 新轨道，接入已设计的默认项。
- 依据：核对报告问题 10；`home/TaoHomeHost.tsx:65` 在有旧 Key 时两个按钮共用 reuse，保存异常吞掉；`LlmProvidersPanel.tsx:122` 显示内部 id，宿主 PROFILE 默认值写死。
- `AC-TH-011`：去设置只导航定位，沿用只在显式选择后执行；Vault 锁定/保存失败正确呈现，不丢草稿。provider 使用产品名称；模式、模型、思考/联网、语音、阈值、本地资料/安全中心配置按设计阶段接通，线程覆盖与全局默认优先级明确且可恢复。遵守细化设计 D-14，不擅加自动连通性测试。
- 验证：V-02/V-03/V-05；复用设置保存与 Vault 路径回归；依赖配置持久化及各能力任务。
- 2026-11-16 视觉补测：Home 两个设置入口在 1366×768/800×600 截图中仅保留一个 Settings tab，重复标题问题已覆盖；深链到 Tao 设置时，节标题/首行仍会被粘性搜索栏遮住。后续补定位偏移和标题可见性断言，证据为 `output/playwright/tao-feedback-1116/tao-settings-1366.png`，不降低原验收要求。

### TH-012 · 发送键、平台文案、国际化与浏览器降级

- [ ] **待办｜中｜已确认缺陷与设计缺项｜P0/P1**。遵守 `chat_send_shortcut`，修正 Windows 显示 `⌘K`、硬编码中文和缺失的浏览器不可用说明。
- 依据：核对报告问题 10；`ai-chat/Composer.tsx` 写死 Ctrl/Meta+Enter，`TopBar.tsx` 固定提示；主设计 §7.7。
- `AC-TH-012`：发送的实际按键、当前设置和可见提示一致；macOS 使用正确 Command 表达，终端 Control 信号不被改写。沿用已有默认设置并提供设计约定的一次性发送键提示。Tao Home 完整支持应用现有语言：模式、输入提示、菜单、历史、绑定、设置、搜索、建议、空态/错误/恢复/动作、tooltip/aria 与快捷键文案均随语言切换，不残留硬编码产品文案；用户内容与技术标识不强制翻译。语言切换不重建 controller 或丢失线程、草稿、引用和在途状态。浏览器明确说明新轨道哪些原生能力不可用，并按约定禁用发送等入口；不伪造成功回复。
- 验证：V-02/V-05；输入框换行、发送、IME、焦点、菜单冲突逐项验证，浏览器与原生分别验收，不由一种环境截图推定另一种通过。

## 3. 原型还原与尚未完成的设计能力

### TH-013 · 对齐空态、对话态布局、建议与 Home 页脚

- [ ] **待办｜中｜视觉/交互偏差｜P0-H**。按原型重组空态整体居中与对话态吸底，绑定栏归顶栏模式右侧，恢复上下文建议与品牌/版本位置。
- 依据：核对报告“高保真版式核对”；同 1366×768 原型 Composer 约 740×100，当前约 860×141 且空态始终贴底；建议为固定通用文案且聊天后消失。
- `AC-TH-013`：与原型相应 S0/S1/S6 状态对照，检查相对内容区构图、Composer/无 Key 卡片/快捷行/建议的顺序与宽度；聊天时建议紧凑保留且随真实上下文变化。Home 页脚使用真实版本，不复制原型虚构值。1366×768、800×600、常用窄窗与浅/深色下主要入口可达，无溢出遮挡。
- 验证：V-02；保留细化设计 v0.3 的历史首位、条件 WSL、无 Home LAN、宿主槽位/独立 controller，不把这些已批准演进改回旧主设计。

### TH-014 · 区分顶栏菜单、界面设置与侧栏内容

- [ ] **待办｜中｜设计缺项与无效入口｜P0/P1/P2**。顶栏更多提供原型菜单；界面设置进入对应设置；侧栏按真实来源/文件/生成物/工作流展示。
- 依据：`ai-chat/TopBar.tsx:42` 的更多与界面设置目前都打开同一侧栏，`SidePanel.tsx:6` 的各 Tab 为相同占位。
- `AC-TH-014`：各入口具有其标注的操作结果，内容不同且可定位；仅在需要/用户主动打开时展开侧栏。未接通能力显示诚实的不可用状态，不能点击后静默关闭或打开无关占位。导入、演示、设置等菜单项分别接入对应任务。
- 验证：V-02；绑定 TH-017/018/020/026/027 的真实数据，不以切换 Tab 样式当成功。

### TH-015 · 演示模式覆盖敏感名称与路径

- [ ] **待办｜中｜已确认缺陷与设计缺项｜P0-H/P1**。统一历史、绑定、Composer 引用、建议等视图的演示隐私规则，补菜单/F9 入口。
- 依据：核对报告问题 9；当前绑定/chip 保留 `SSH · u80`，工作区历史仍显示路径，未实现 F9。
- `AC-TH-015`：开启后真实名称、路径及相关可见 tooltip/预览不外露，按设计显示类别/编号；关闭后恢复，底层数据不被改写。TH-005 新增目录也纳入演示规则；入口及快捷键状态同步。
- 验证：V-02/V-05；截图与 DOM 可见文案检查，覆盖搜索/历史/绑定/目录及当前端 F9 实际输入边界。

### TH-016 · 回复渲染与消息操作

- [ ] **待办｜中｜设计缺项与无效控件｜P0/P1**。接入 Markdown、代码块、Mermaid、引用等渲染，以及编辑/再生成/分支/交给 CC 或 Codex 的设计入口。
- 依据：核对报告交互矩阵；`ai-chat/MessageList.tsx:18` 主要显示纯文本，当前赞同/不赞同按钮无处理。
- `AC-TH-016`：真实消息块可按类型呈现、复制并导航引用；用户编辑产生正确后续分支，不破坏原记录；交给外部 agent 走现有桥接并有结果/失败反馈。现有可见按钮必须有效，未定义的空按钮移除或明确禁用；再生成复用 TH-003，分支持久化复用 TH-004。
- 验证：V-02/V-03/V-05；恶意/不完整 Markdown、流式块更新与原 agent 桥接保留回归，不另造与现有文档渲染冲突的全局实现。

### TH-017 · 联网步骤、来源、引用和读链接恢复

- [ ] **待办｜高｜设计缺项｜P1**。在 TH-002 协议之上打通真实 `deepseek_web_search` / `deepseek_read_url`、来源模型及交互。
- 依据：核对报告主设计验收 5/6；目前仅提示联网，来源为普通链接，缺引用角标与侧栏定位。
- `AC-TH-017`：显示实际搜索/读链接步骤与结果；引用角标可定位真实来源；自动读用户链接按设计工作。追问/停止后继续正确保留允许回传的读链接结果及有效签名，不把所有历史工具块或历史思考无差别回传。
- 验证：V-01/V-02/V-05；依赖 TH-002/003/004/014，网络费用统计关联 TH-021/022。

### TH-018 · 文件选择、上传、状态恢复与复用

- [ ] **待办｜中｜设计缺项｜P1**。把“引用文件”从空 chip 接为选择/粘贴/拖拽、上传、问答及文件管理的真实流程。
- 依据：核对报告主设计验收 7；`ai-chat/Composer.tsx:33` 只插“文件引用”，未发现 Files 命令、映射表及 `file_id` 流程。
- `AC-TH-018`：PDF/图片按设计上传并进入真实请求，显示进度/错误并支持取消；同一文件可复用 `file_id`，可删除/移除引用。切页面或关闭面板不丢任务，重开恢复状态，后台所有权不依赖组件挂载；上传、下载按各自协议实现可靠恢复，不虚构服务端不支持的断点续传。
- 验证：V-02/V-03/V-05；文件对话框、真实文件和网络、取消/失败/重开等原生边界必验。
- 2026-11-16 扩测补充：新增 TC014/020/021 真实商业 native 图片/附件/代码/PDF 用例；实测发现失败后有效上传仍显示旧错误，已补单元复现并修复。文件选择器补齐后端支持的文本、代码和 Office 类型。当前执行与未覆盖边界见 [本轮原生扩测](native-expansion-2026-11-16.md)，不因局部通过关闭整项 AC。

### TH-019 · 麦克风、ASR、TTS 与朗读

- [ ] **待办｜中｜设计缺项｜P1**。复用本地语音底座，接通原设计可选 DeepSeek ASR/TTS。
- 依据：核对报告验收 8；麦克风没有 handler，回复朗读入口缺失。
- `AC-TH-019`：默认本地 ASR，provider 与音色配置有效；录音、识别、取消、结果回填、朗读/停止均有真实状态；权限/设备/网络错误可理解。遵守音频格式与时长限制，下载模型时复用现有可靠下载机制，不另建随弹窗关闭即消失的任务。
- 验证：V-02/V-05；OS 麦克风/音频输出及原生 provider 边界，旧语音消费者保持原行为。

### TH-020 · DeepSeek ZIP v3 导入与导出

- [ ] **待办｜中｜设计缺项｜P1**。补导入向导、解析校验、事务和导出，不复用“替换全部历史”的破坏性语义。
- 依据：核对报告验收 9；主设计 §8.3，顶栏导入入口尚未接入。
- `AC-TH-020`：合法 ZIP v3 只导入为新 Tao 线程，不覆盖旧记录；重复/损坏/不支持版本可处理，失败不留下半套数据；导出后可按约定再读入，文件/引用/来源等受支持字段不静默丢失。
- 验证：V-03/V-05；依赖 TH-004/014，真实文件与 SQLite 事务测试。

### TH-021 · 用量、工具次数与费用明细

- [ ] **待办｜中｜设计缺项｜P1**。展示生产响应真实 usage，接入价格估算与可打开的用量明细浮层。
- 依据：核对报告验收 10；provider usage 为 None、胶囊无点击、费用 helper 未接入。
- `AC-TH-021`：输入/输出/cache/工具次数按协议准确记录，明细和汇总一致；估算标明口径及价格来源，未知值不编造为零；点击胶囊打开真实用量/预算内容。
- 验证：V-01/V-02/V-03；依赖 TH-002/004/017，累计口径与 TH-022 统一。

### TH-022 · 每轮预算累计、费用确认与提高后续跑

- [ ] **待办｜高｜已确认算法缺陷与设计缺项｜P2**。按同一用户轮次累计完整工具循环，落实默认 10M、50%/80%/100% 以及费用确认。
- 依据：`src/components/tao/budget.ts:42` 当前取 max，未求和；新一轮未完整重置，工具费用阈值无实际确认执行点。
- `AC-TH-022`：一次调用的重复事件不重复计量，不同调用相加；新用户轮次重新计预算。阈值提示、停止与摘要保存真实生效；提高预算后从保存点继续而不重跑已完成步骤。按细化设计 §7.2 的费用上界与再次确认规则执行，用户取消后不得继续产生调用。
- 验证：V-01/V-02/V-03/V-05；依赖 TH-003/004/021，工具循环与恢复断言不能只测 meter 样式。

### TH-023 · 本地检索索引、来源开关与结果使用

- [ ] **待办｜高｜设计缺项｜P1**。实现设计规定的结构化 + FTS5 检索，并打通选资料、预览、问 Tao 与打开原记录。
- 依据：核对报告验收 17；`home/TaoHomeHost.tsx:41`、`search/query.ts:24` 为内存 includes，缺 SQL/命令/笔记等连接器；↑/↓/Enter 提示无实际选择，“问 Tao”只填标题。
- `AC-TH-023`：覆盖设计规定数据源、去重/同步删除/增量更新、过滤与排序、短词回退；来源开关关闭后按设计清理，结果不再出现。键盘选择有效；引用的是经确认的真实脱敏片段，可排除并打开原记录，不静默发送标题以外的资料。保留细化设计 §13 的条数/字符/token 限额与评测要求。
- 验证：V-01/V-02/V-03/V-05；TH-028/030 的 P1 安全前置完成后方可向模型开放本地资料。

### TH-024 · 补齐底部更多与旧本地终端启动能力

- [ ] **待办｜中｜设计缺项与兼容缺口｜P0-H/P1**。接回本地目录、VNC/RDP 等原设计入口，修复数据库命令；保留原本地终端 shell 选择、管理员启动、打开 Home 等能力。
- 依据：核对报告交互矩阵；`home/DockRow.tsx:24` 的 database command 未被 `layouts/main/commandActions.ts:190` 处理，网络工具仍为原占位。
- `AC-TH-024`：每个可点击入口打开对应真实功能；未提供能力明确禁用/说明。本地终端启动参数与旧 Home 保持，WSL 按检测显示；不重新加入已删除的 Home LAN 聊天按钮。目录历史由 TH-005 统一提供，不复制数据。
- 验证：V-02/V-05；真实 shell/cwd/提权、数据库与远程桌面入口，保留原终端和工作区启动回归。

### TH-025 · “做”模式真实执行、确认、结果与撤销

- [ ] **待办｜高｜设计缺项｜P2**。注入真实 actionPorts，复用原 agent/终端/数据库/文件能力，接入 Rust 校验与安全复核。
- 依据：核对报告问题 6、验收 12；`deepseek_app/actions.rs` 校验辅助函数未接入，缺 shell/SQL/写文件、备份、撤销与结果回灌。
- `AC-TH-025`：按设计分级确认后才执行；危险 shell/SQL 经后端校验，目标、参数与确认内容一致。结果卡显示真实退出码/耗时/输出，并回灌模型；支持的写操作有备份/撤销，失败、取消、重复点击不伪造成功或重复副作用。
- 验证：V-01/V-02/V-03/V-05；依赖 TH-009/022/029/030，原生副作用、恢复和撤销必须实测。

### TH-026 · 工作流注册、执行和重启恢复

- [ ] **待办｜中｜设计缺项｜P2**。接通五个内置工作流、技能/工作流库入口、runner、检查点与持久恢复。
- 依据：核对报告验收 20；当前只有 phase 类型和简单计划渲染，“技能/工作流”仅关菜单。
- `AC-TH-026`：计划可审查并执行，按设计跳过/取消；步骤状态、生成物与日志可查。重启后从有效检查点恢复，不重放已完成的有副作用步骤；不以消息里的一段计划文字当作工作流完成。
- 验证：V-02/V-03/V-05；依赖 TH-004/014/022/025。

### TH-027 · 显式记忆、SOUL 与技能管理

- [ ] **待办｜中｜设计缺项｜P2**。补记忆建议/确认、身份编辑、技能管理与对应侧栏/设置入口。
- 依据：核对报告验收 13 与主设计 §5.4；当前未接实现。
- `AC-TH-027`：只有用户确认才写跨线程记忆；记忆/身份/技能可读、可改、可删、可导出，下一次请求按约定生效。数据本地存储，不直接覆盖用户 home 下其它工具的 SOUL 文件；删除与导出覆盖关联索引。
- 验证：V-01/V-02/V-03/V-05；依赖 TH-004/014/023 和安全任务。

### TH-028 · 写入脱敏、旧历史迁移与误伤保护

- [ ] **待办｜高｜原设计承认的既有安全债务｜P1 前置**。把已有脱敏 helper 接入命令/SQL 等写入与旧记录迁移，建立可核对的清理结果。
- 依据：核对报告安全边界；`src-tauri/src/history.rs:27` 仍写原始命令，`database/history.rs` 仍写 `entry.sql_content`。扩展 redact 测试不等于这些路径已保护。
- `AC-TH-028`：新写入与历史迁移分别有真实磁盘证据，脱敏标记/计数可查；私钥、凭据、连接串等按规则处理。按细化设计评估 `-p` 等正常参数误伤，迁移可恢复且不损坏历史可用性；索引只使用脱敏后资料。
- 验证：V-03/V-05；命令/SQL 既有执行历史保留回归、SQLite reopen 与迁移中断恢复；是 TH-023 的前置，不作为 Home 改版新引入泄漏误报。

### TH-029 · Vault 锁定立即中止在途 Tao 请求

- [ ] **待办｜高｜设计缺项｜全部阶段**。将锁定与活动请求、provider 持有期及前端状态联动，补解锁与保存门禁的原生证据。
- 依据：核对报告安全边界；`vault_lock` 仅重建 router，在途请求仍持旧 provider Arc，未接取消或 `vault_locked` 映射。
- `AC-TH-029`：锁定后在途活动实际停止，后续请求不得继续用旧 Key；显示正确锁定状态/解锁入口，不归类网络故障。解锁恢复遵守用户操作，不自动重复有费用/副作用请求；锁定时不能落明文 Key。
- 验证：V-03/V-05；依赖 TH-003/011，慢流中锁定、自动锁定例外、保存/重启全链路。
- 2026-11-16 续作：已复现并修复 `vault_locked → message_stop → idle` 覆盖及流前 Vault IPC 误归类；补充显式解锁 gate、取消/失败/焦点/线程隔离、无自动重试与无内容时重新生成。新增 10 项单元回归连同原 10 项通过；`TC-TAO-HOME-009` 在匹配 QA release 上 **1/1 passed**，真实服务端取消和显式解锁已验证，详见[后续回执](verification-2026-11-16.md)。自动锁定、保存/重启等完整 AC 未由该单场景关闭。

### TH-030 · 本地资料与动作的分阶段安全门禁

- [ ] **待办｜高｜设计缺项｜P1 前置/P2 完整**。按主设计 S1–S8/细化设计补来源开关、片段排除、注入处理、出站限制与审计/安全中心，不用提示文案代替执行。
- 依据：核对报告验收 18 与安全边界；未发现 Tao 专用片段丢弃、注入拦截、审计、安全中心或 egress allowlist 实现。
- `AC-TH-030`：向模型发送前用户可审查/排除来源；不可信资料不升级为指令；出站和动作受实际后端边界约束。P1 先完成设计规定的检索安全前置和最小状态/开关；P2 完整审计、安全中心及相关读删导出按设计验收，日志本身不泄露 Key/原始秘密。
- 验证：V-01/V-02/V-03/V-05；分别回填 S1–S8 证据，不把“已有正则”认作整项通过。

### TH-031 · 勘误无代理约定并验证新网络路径

- [ ] **待办｜中｜设计文字冲突与保留契约｜跨阶段**。修正主设计 §11 第 5 条与仓库 AGENTS 相反的无代理文字；新增 provider/Files/语音等路径复用共享解析。
- 依据：核对报告安全边界。已见共享 reqwest `no_proxy()` 和配置代理失败显形的正向基础，不能因此判现有代理实现错误。
- `AC-TH-031`：设置明确支持应用代理（默认）、独立持久化功能代理、不使用代理；独立配置不覆盖应用设置。无代理绕过隐式系统/环境代理，已配置代理失败不能静默直连。涉及下载时按 AGENTS 覆盖状态/进度、后台恢复、取消、Range 校验、重试/续传、校验与完成文件原子发布等要求；不把下载要求机械套为不支持该协议的上传断点功能。
- 验证：V-05；文档勘误可先行，新路径稳定后集中验证各代理模式与实际网络，不单凭 browser stub。

### TH-032 · 集成验收与保留功能回归

- [ ] **待办｜高｜交付验证缺口｜跨阶段**。按实际交付批次关闭相关 AC，并补既有功能与完整 crash-regression 的证据。
- 依据：核对报告验收 14/15、验证局限；此前 16 项 Vitest 与一项 `TC-TAO-HOME-001` 只覆盖局部外壳，完整旧功能/原生流程/crash suite 未执行。
- `AC-TH-032`：每个完成任务有针对自身行为的证据；旧 tao-chat/CC/Codex/ACP、终端/工作区/目录、设置/Vault，以及本批共享 Markdown/Notes 消费者按影响回归。新功能、UI 重构/组件升级按 AGENTS 跑完整 `crash-regression` browser/native（native 必须匹配 QA release 二进制）并附结果；缺失/失败不标完成。
- 验证：V-06。进行三端兼容审查，本批交付时补当前 Windows 原生实际证据；macOS/Linux 未跑部分明确列为未验证，不能把浏览器菜单/键盘证据当 AppKit 菜单或 OS 输入通过。

## 4. Markdown 与 Notes 待办

### MD-001 · 导出“目录”默认不勾选

- [ ] **待办｜中｜用户明确要求的默认值调整**。修改共享导出选项默认值，保留手动开启目录能力。
- 依据：`src/components/viewer/markdown/exportModel.ts:18` 为 `toc:true`；`MarkdownExportMenu.tsx:14/:103` 读取默认值/勾选；`exportModel.ts:44` 将生成的目录插到正文顶部。
- `AC-MD-001`：首次打开/无已保存偏好时“目录”未勾选；默认 HTML/PNG/DOCX/PDF/打印/复制渲染内容不额外加目录。用户显式勾选后照常生成且标题跳转可用；不删除源文档自带目录，也不改写“Markdown + 图片文件夹”导出的源文本。此要求是改默认值，不强制重置用户主动保存的非默认选择。
- 验证：V-04；更新 `markdownExport.test.ts:28/:43` 中默认带目录的旧断言，保留显式开启/关闭覆盖，真实产物见原生用例。

### MD-002 · Split 左右分栏可调整大小

- [ ] **待办｜中｜用户明确追加的交互要求**。为 Markdown split 源码/预览提供可操作分隔条，沿用工程已有分栏机制优先。
- 依据：`MarkdownEditor.tsx:105` 两 pane、`markdown.css:19` 固定 `flex:1;width:50%`；Workspace 的 `src/components/editor/workspace/EditorGroup.tsx:463` 同样固定 `grid-cols-2`。
- `AC-MD-002`：文件查看器 Markdown split 与 Code Workspace Markdown split 都可拖动调节左右宽度，有合理最小宽度和键盘可达操作；缩放窗口、切模式、大纲显隐后两侧仍可用。拖动不改正文、不丢选区、Undo、编辑器实例或预览；如需持久化比例，使用共享偏好机制而不写入文档内容。Notes 对应统一后的分栏入口纳入 MD-004。
- 验证：V-04；真实指针拖动与尺寸断言，覆盖两个现有文件入口及整合后的 Notes，不以 CSS 数值单测替代交互。

### MD-003 · Live 默认浏览，显式编辑后才可写

- [ ] **待办｜高｜用户明确要求的交互调整**。区分文档硬只读与 Live 浏览状态；打开文档/进入 Live 默认只读，点击“编辑”后进入可写状态。
- 依据：`MarkdownEditor.tsx:24` 默认 live；`:49/:88/:107` 只依据文件 `current.readOnly`，`src/components/viewer/EditorSurface.tsx:67/:98` 普通文件直接可编辑；现 toolbar 没有独立编辑入口。
- `AC-MD-003`：默认 Live 可选文、复制、浏览链接/大纲，文本输入、格式、表格、任务勾选、图片粘贴/拖入等所有写入口均不能修改内容。点击“编辑”才启用；进入/退出编辑本身不标 dirty。文件本身只读/截断等限制仍优先，不能被该按钮绕过；source/split 保留原编辑与保存语义，切模式不丢内容和 Undo。离开后重新进入 Live 恢复默认浏览状态。
- 验证：V-04；更新 `MarkdownEditor.test.tsx:49/:69` 中默认直接输入的路径，复用 `markdownWidgets.test.ts:92`；用真实输入验证默认不改变正文，覆盖所有 widget/命令/粘贴入口。有效只读状态局部传递，不能机械更改全局 EditorSurface 的其它消费者。

### MD-004 · Notes Workspace 与 Markdown 文件统一展示、编辑与 UI

- [ ] **待办｜高｜用户明确追加的统一要求**。Notes 消息按 Markdown 文档，在 Notes Workspace 中复用 Markdown 文件的展示、编辑处理和 UI；小型 tao-chat 的消息展示先保持原样。
- 依据：`src/components/notes/NotesWorkspaceDocument.tsx:75/:110` 自建工具栏、CodeMirrorHost 和 split/preview；与 `viewer/markdown/MarkdownEditor.tsx` 的格式、Live、导出和分栏 UI 分离。`:35` 的 `${noteId}.md` 是语言识别用合成路径，正文/修改/保存实际由 `notesContentStore` 按 `noteId` 管理（`:33/:48`），不是磁盘文件。
- `AC-MD-004a`：相同 Markdown 在文件入口与 Notes Workspace 的公共展示/编辑 UI、模式、工具栏、分栏、只读/编辑、渲染和适用导出行为一致，MD-001～003 及 MD-005/006 从共享实现获得。提取可注入 document/change/save/asset 能力的公共内核；文件/Notes 各自保留来源、保存与权限适配，不复制两套逻辑。不直接把未解耦的 ViewerShell/MarkdownEditor 挂到 Note 并误用磁盘 store，也不把合成路径用于图片落盘。
- `AC-MD-004b`：Notes 身份仍为稳定 `noteId`，更名不创建新文档；保存仍走 `notes_save_content` 的正文/标题与 expected baseline，不覆盖整条 Note。保留两入口共享草稿、串行保存期间继续输入、外部冲突、未保存恢复、独立浮窗草稿；Notes 任务属性/状态/标签/步骤/来源、冲突/重试/复制草稿等专属外壳保留。模式切换不重建实例丢选区/Undo，保存快捷键与原生菜单只派发一次。
- `AC-MD-004c`：小型 tao-chat 的 `chat/drawer/View.tsx:475` → `NotesPanel` → `NoteEditor` → `NoteTextField` 保持现有展示/编辑 UI。“放大”仍在 Notes 保存成功后打开同一 Note Workspace；返回 Tao 仍选中原 Note，双方内容同步继续有效。此次统一不扩展到小型聊天消息渲染。
- 验证：V-04/V-03/V-05；相同 fixture 对照文件与 Notes 的公共 UI/渲染/Live/分栏/导出；覆盖真实 Notes 保存、并发编辑冲突、属性保留、重启恢复、小型 Tao 截图与放大/返回。扩展既有 `TC-NOTES-009/010/011/012` 和 `TC-FILE-OPEN-004/007`；共享组件消费者回归，不以新组件名或相似截图证明已统一代码。

### MD-005 · Mermaid 深色可读性与独立预览主题

- [ ] **待办｜高｜用户反馈与已确认的主题链路缺口**。修复图框、连线/箭头、标签/文字与预览背景的主题不匹配，补不影响应用外壳的预览外观入口。
- 依据：共享 `src/components/editor/workspace/model/mermaid.ts:17` 首次初始化固定 `theme:"default"`，随后复用已初始化实例，无有效预览主题输入；`src/components/viewer/markdown/markdownRender.ts:77` 使用该实例，而 `markdown.css:77` 的图面背景取随应用变化的 `--code-bg`。Live widget 的 `liveMarkdown.ts:15` 比较及 `MarkdownEditor.tsx:130` / Workspace `MarkdownPreview.tsx:109` 的重绘依赖均缺少主题维度。因此可确认默认亮色图形与深背景混配、切主题不重绘的实现缺口；用户具体图中各元素的视觉失败程度尚未原样复现，显式 `style/classDef` 还需单独核查。
- **建议方案（供实现细化，不冒充用户已选定布局）**：默认“跟随应用”，Mermaid 和预览画布共同使用有效主题；在 Markdown 预览工具栏提供可直接操作的“预览外观：跟随 / 浅色 / 深色”。覆盖 Live 与 split/preview 的展示区域，应用外壳、源码编辑区和 Markdown 原文保持原有主题/内容；Notes Workspace 经 MD-004 共享该实现，小型 tao-chat 保持原样。优先修正自动适配，独立切换作为用户选择及兼容显式配色图的便捷入口，不将整个应用切亮作为使用前提。
- `AC-MD-005a`：默认主题、从亮切深/深切亮、强制预览浅色/深色和多文档并存时，背景、节点、子图、边框、连线、箭头、标签、图例均可辨识。代表性普通文字与背景对比度至少 4.5:1，必要图形边界/连线至少 3:1；显式配色图在尊重源码的前提下提供可用预览选择，不静默改写其配色源码。验收含 flowchart、sequence、class/ER、子图、中文长标签及 `style/classDef` 样例，不能只看一个默认流程图。
- `AC-MD-005b`：有效主题进入渲染身份和 Live widget 复用条件；若引入 SVG 缓存，也纳入其缓存键。切主题实际重绘，不留下旧图，多个实例渲染不因 Mermaid 全局初始化互相串色，过期结果不得覆盖新主题。外观切换不标 dirty，不丢选区/Undo，不重置阅读位置；仅修改展示，不影响 MD-003 的读写权限。导出沿导出选项的明确主题生成图与背景，结果不依赖操作时 Mermaid 全局恰好处于哪种主题。
- 验证：V-04/V-05；在 `TC-FILE-OPEN-004/007` 及共享后的 Notes/Workspace 入口补实际 SVG、计算颜色/对比度、主题切换与截图断言。既有用例已有浅深截图和 SVG 尺寸检查，但它们不能单独证明全部图形的对比度。先用最小图复现代码链路，再补用户问题图；本轮未运行新的浏览器/桌面视觉复现。渲染修复可先于 Notes 统一实施，之后联验 MD-004。

### MD-006 · Word 导出 Mermaid 的版面尺寸与放大清晰度

- [ ] **待办｜高｜用户反馈与已确认的栅格化/尺寸链路风险**。分别处理“在 Word 中整体过小”和“放大后模糊”，不能只增加图片显示宽度或只改 DPI 元数据。
- 依据：`src/components/viewer/markdown/exportDocx.ts:9` 用 `Image.naturalWidth/naturalHeight` 获取尺寸，未依据 SVG `viewBox`、百分比宽高或目标纸张版面解析；`:12` 直接用相同像素尺寸的 canvas 生成 PNG，无高分辨率采样；`:18` 用 `min(1,600/width)` 约束 Word 显示尺寸，固定 600 与纸张/方向/边距无关；`:32` 序列化 SVG 后经该路径在 `:34` 仅嵌入 PNG。可确认矢量被栅格化和像素/版面计算耦合；具体问题图是否还受 SVG 自然尺寸、留白/长宽比或 Word 客户端缩放影响需复现。PDF/HTML 保留 SVG 的路径不同；“其它格式正常”目前是用户观察，不记录成本轮实测结论。
- **建议方向**：分开 SVG 内容几何尺寸、Word 排版尺寸和位图采样像素。按纸张/方向/边距计算可用区域并保持长宽比，排查多余留白导致的主体偏小；对兼容目标验证后优先保留矢量（需要时带兼容回退），否则由原始 SVG 按最终物理显示尺寸生成足够清晰的 PNG，常规目标为约 300 DPI，采用明确像素/内存上限。不得把已有低分辨率 PNG 再放大充当高分辨率图。
- `AC-MD-006a`：相同图的主体在 DOCX 中按合理内容宽度展示，长/宽/竖图保持比例、不裁切、不溢出，不因 `width="100%"`、viewBox-only 或 CSS max-width 得到错误的小图；A4/Letter、横竖方向及不同边距下按实际版面布局，不使用一个固定尺寸兜底所有情况。调整 Word 显示大小时，媒体分辨率与有效 DPI 仍满足质量目标。
- `AC-MD-006b`：在目标 Word 客户端 100%/200% 查看时，节点文字、细边框、连线/箭头清楚且与同源 PDF 对照无明显额外劣化；若使用位图，DOCX 解包后的真实像素量与 `wp:extent`/图片变换尺寸可计算证明采样质量，而非仅修改 DPI 标记。若使用 SVG，应验证实际矢量引用和兼容回退内容。超大图达到资源上限时明确反馈，不静默输出模糊图或导致崩溃。
- 验证：V-04/V-05；补真实 Mermaid 的小图、复杂大图、长中文标签、百分比/viewBox 尺寸与深浅配色 fixture；检查 DOCX ZIP/XML/media、图片像素/比例/有效 DPI、实际 Word 排版和 100%/200% 截图，同源 PDF/HTML/PNG 作为保留回归。扩展 `exportDocx.test.ts`、`TC-FILE-OPEN-007` 和 `markdown_export_observation.py` 的质量断言；“ZIP 可打开/存在图片/宽度达到 200px”不足以关闭任务。本轮未打开用户 DOCX 或 Word 原样复现。依赖 MD-005 的确定主题输出，Notes 经 MD-004 共享同一导出修复。

本轮确认记录：源码核查之外，执行 `pnpm exec vitest run src/components/viewer/markdown/exportDocx.test.ts`，结果 **1 文件 / 1 测试通过**。该 fixture 只有文字、表格、页眉页脚和 ZIP 检查，无图片/Mermaid，不能作为 MD-006 的尺寸/清晰度通过证据。`markdownExport.test.ts` 的 Mermaid 还受 `src/test/setup.ts` 全局 mock 影响。DOCX 有效 DPI 应通过关联实际媒体与 DrawingML 显示尺寸计算：`媒体像素宽 ÷ (wp:extent.cx ÷ 914400)`；当前未缩小显示的 1 倍 PNG 路径通常约 96 DPI，大图压缩显示后可能更高，不能把所有图一概记录为 96 DPI。具体 SVG 解码尺寸和 Word 视觉复现仍待执行。

### MD-007 · Word 公式不得重复导出

- [ ] **部分完成｜中｜Word 客户端实测新发现**。在 MD-006 的 Word 16.0（build 16.0.20527）验证中，Mermaid 已清晰，但 `$x^2$`、`$$\frac{1}{2}$$` 分别输出了 MathML、TeX annotation、视觉 HTML 三份文字。原始错误产物与修复验证路径见 [11-16 回执](verification-2026-11-16.md)。
- `AC-MD-007`：普通分数、上下标和根式导出为单份可编辑 Office Math，保留相邻正文和原文；不把隐藏 TeX/辅助 HTML 重复写入 Word。不支持的矩阵/重音等结构明确保留一次完整 TeX，不能悄悄压平成丢失结构的文字。本批不声称已支持全部 MathML 类型的 Word 排版。
- 实现：`docxMath.ts` 在共享 Word 转换入口消费 KaTeX 语义树；仍保持 docx 懒加载，Notes/文件复用同一实现。验证：真实 DOCX ZIP 单元覆盖分数、脚标/根式、矩阵回退及 DOM 不变；browser FILE004 增加实际 Word 下载，native FILE007 增加独立 OOXML 数量/结构/文字检查。`c460283a3` Windows browser 28/28、native 34/34 通过；Word 16 确认两条可编辑公式，100%/200% 实际排版图单次、清晰。Linux/macOS native 待本轮 workflow 回执，详见 [11-16 回执](verification-2026-11-16.md)。

## 5. 验证计划与完成口径

以下均为实施阶段待执行，不表示本轮已跑，也不要求每个小任务机械执行全套昂贵检查。按依赖成批稳定后集中做对应原生边界与交付检查。

| ID | 计划与必要证据 |
|---|---|
| V-01 | 协议/状态：生产 DTO 序列化往返、HTTP 请求捕获、分片/工具/拒答/usage fixtures、真实取消与多轮顺序；原生 IPC 和真实 provider 的具名检查。stub、离线探针分别记录边界。 |
| V-02 | 浏览器 UI：实际点击/键盘、焦点、外部关闭、可见结果、正确入口、空态/对话态、两种主题、1366×768/800×600/窄窗截图。扩展 `TC-TAO-HOME-001` 或拆分相关场景，同步 QA case/policy/dependencies/control catalog。 |
| V-03 | 持久与生命周期：真实 SQLite/文件 reopen、升级迁移、线程/笔记隔离、错误保留、revision/stale guards、重启恢复；明确 browser 刷新不等于桌面重启。 |
| V-04 | Markdown/Notes：扩展组件/行为测试与 [TC-FILE-OPEN-004](../../qa-ui-auto-tests/cases/TC-FILE-OPEN-004-markdown-live-paste-export.testcase.yaml)（browser）、[TC-FILE-OPEN-007](../../qa-ui-auto-tests/cases/TC-FILE-OPEN-007-native-markdown-artifacts.testcase.yaml)；补 Notes Workspace/Code Workspace 入口。默认 TOC、显式 TOC、真实拖动、Live 浏览与全部写入口、source/split 保留能力、保存/Undo/只读及小 tao-chat 不变均有结果断言。Mermaid 验证主题/背景与实际对比度、多实例切换、DOCX 媒体像素/排版尺寸/有效 DPI 及 Word 放大效果，不能只检查图片存在。原生实际文件导出/打印/保存不能由 stub 代替。 |
| V-05 | 原生边界：隔离 QA 数据与凭据，验证网络/代理/取消/Vault/文件对话框/磁盘/语音/进程/SQL/撤销等受影响部分。按 AGENTS 的 macOS 规范另列精确 chord、上下文、菜单 accelerator、焦点和可见结果；浏览器 renderer 菜单、桥接 press 不证明 AppKit 或 OS 按键送达。 |
| V-06 | 批次收尾：适用的定向 Vitest/Rust/feature QA，`pnpm build`（含 refactor 检查）、适用后端检查，以及 AGENTS 要求的完整 crash-regression browser/native 与受影响旧功能回归。native 用匹配 QA release 二进制；记录 source/build/case/config 身份、pass/fail/skip、平台和证据。 |

任务标完成必须同时满足其 `AC-*`、保留行为和对应执行证据，记录修改文件、检查命令/结果、平台、未验证边界；不能凭 UI 按钮存在、测试计划、静态查找或已有局部通过结果关闭任务。开发时遵循文件职责与 800 行边界要求，改公共组件必须追踪共享消费者，不能为复用而破坏原生异步所有权、取消或保存契约。

建议排期：TH-001～004 先打通最小闭环；TH-005～012 与 MD-001～006 可按依赖并行，MD-005/006 可先修共享 Mermaid/Word 路径再与 MD-004 联验；TH-013～024 依次补原型/P1 能力，TH-028/030 的 P1 安全前置先于本地资料出站；TH-025～027 完成 P2。TH-009 的诚实执行状态保护、TH-031 文档勘误可以先行。TH-032 跟随每批交付，不留到所有规划完成后才验证。

## 6. 核对报告覆盖索引

| 核对报告条目 | 对应待办 |
|---|---|
| 最先问题 1～4 | TH-001～004 |
| 最先问题 5/8（绑定/裁剪） | TH-007/008；用户反馈合并记录 |
| 最先问题 6/7/9/10 | TH-009/025、TH-010、TH-015、TH-011/012 |
| 版式矩阵 | TH-004/013/014/015/024；新增入口要求 TH-005/006 |
| 交互矩阵：附件/@/技能/工作流/语音 | TH-007/018/019/026/027 |
| 交互矩阵：重试/继续/消息操作/来源/用量/更多/终端 | TH-003/016/017/021/022/024 |
| 主设计 §15 验收 1/2/3/4 | TH-013、TH-001/011、TH-002/003、TH-002/003 |
| 主设计 §15 验收 5/6/7/8/9/10/11 | TH-017、TH-017/004、TH-018、TH-019、TH-020、TH-021、TH-007/008 |
| 主设计 §15 验收 12/13/14/15/16 | TH-009/025、TH-027、TH-032、TH-011/029、TH-003 |
| 主设计 §15 验收 17/18/19/20 | TH-023、TH-028～030、TH-022、TH-026 |
| 安全边界与代理文档冲突 | TH-028～031 |
| 未执行的原生/旧功能/crash 回归 | TH-032 与 V-01～06，保持待执行 |
| 后续 Mermaid 深色可读性、独立预览外观与 Word 小图/模糊反馈 | MD-005/006；属于用户追加，不冒充原 Home 审查实测 |

本轮检查包括源码确认、上述一项既有 DOCX 单测、任务完整性/编号/本地链接校验；没有修复产品，也没有把该单测当作 Mermaid 视觉或 Word 实际产物验收通过。

## 7. 2026-11-15 实施批次最新回执

本次开发分支为 `feat/tao-home-follow-up`。用户反馈优先于原型冲突项，已落地并加入回归覆盖的范围如下：

| 范围 | 当前状态 | 证据 |
|---|---|---|
| TH-005 | 已实现代码，原生持久化待最终环境回执 | Tao history 合并旧 ChatDrawer 摘要；最近目录继续复用旧 comparator；legacy 行只读并回到旧 ChatDrawer，不写入 Tao 表 |
| TH-006/008/010/011/012 | 已实现并有 focused/browser 覆盖 | 可见新 Tao 对话、外部点击/Escape、搜索按键 claim、Settings tab 去重、Tao 中英文文案；TC-TAO-HOME-001/003/007/008 |
| TH-007 | 已实现核心交互，真实资源边界仍需 native | workspace/terminal/database 资源选择、显式引用、解绑和重绑清理旧 chip；TC-TAO-HOME-003/008 |
| TH-001/002/003/004 | 已实现协议/流式/取消/线程存储核心，商业服务和 Vault 边界待 native | Messages DTO camelCase/alias、Channel 分片、停止、continue/regenerate、SQLite snapshot/context；TC-TAO-HOME-002/004/005 |
| MD-001～006 | 共享实现已落地，Word 客户端视觉仍未宣称通过 | TOC 默认关闭、split 拖拽、Live 只读→编辑、Notes Markdown owner、Mermaid 独立预览主题、DOCX 高清采样；TC-FILE-OPEN-004/013、TC-NOTES-008/009/012/014、focused Vitest |
| WSL/SidePanel | 已实现；最新截图交互验证见下节 | WSL 无 distro 时无按钮/安装提示；最新反馈用顶部单图标直接开关替代原 X/收缩按钮，拖拽须同步改变聊天区；TC-TAO-HOME-006/007/012 |

最新本地验证：13 个 frontend focused test files / 39 tests 通过；Tao Rust focused suite（关闭 whisper 默认 feature 以绕过既有 Windows MD/MT 链接冲突）17 tests 通过；`cargo check --lib`、`cargo fmt -- --check`、`tsc -b --force`、`pnpm build` 通过；`qa_ui_auto audit --gate` 通过（global shallow 与基线相同）。Windows browser 受影响批次除一次旧 Vite 服务失效造成的重跑外均通过，TC-TAO-HOME-007 最新 run 通过；TC-TAO-HOME-003/008 在稳定 Vite 上的最终回执和 native 回执写入本节后再关闭。

完整 AC 仍按原表保留“部分/待办”口径：真实商业 DeepSeek、Vault/代理故障、Word 客户端 100%/200% 视觉、macOS AppKit 菜单以及 Linux/macOS hosted browser/native 尚未以回执关闭。临时 DeepSeek key 只从 `C:\tmp\ds-key-tmp.txt` 读取，fixture 在 teardown 删除隔离 `ai.json`；401/403 或明确过期只记 `credential-invalid` 成功并保留脱敏原因，其他错误仍失败。

## 8. 2026-11-16 追加截图与真实服务验证

本节记录后续用户反馈，覆盖早期侧栏“折叠条 + X 关闭”的交互预期。

- TH-009/014：快捷问答在聊天列内居中，四项保持单行；空间不足时文案省略，tooltip 保留全文，不能隐藏后两项或引入横向滚动条。侧栏使用实际并排布局，拖拽同步缩放聊天列；原更多按钮改为侧栏图标，点击直接打开、再次点击完全收起，并记住上次页签及宽度。移除面板内部重复的收缩/关闭行；记忆与技能使用不同语义图标。设置、外观、演示模式保留可见独立入口。
- 保留行为：聊天内容、未发送草稿和既有 provider 调用不被侧栏开关改变；八个原面板入口、导入导出、演示模式/F9、两种 Settings 导航继续可达。关闭恢复完整聊天宽度；拖拽取消/失焦/关闭后释放监听，键盘调整及窗口缩小时保留可用聊天宽度。
- TH-001/003/004/016：商业 DeepSeek 测试由 TC005 扩展至 TC011/013；合计一次整批最多八次真实请求，使用用户临时 Key，遵守总预算 1M tokens。TC011 验证真实多轮、草稿多语言、重新生成、新建隔离、流式侧栏布局和 Stop；TC013 验证实际 Markdown、native 分支上下文及原会话/分支历史和草稿。不可用 loopback 服务替代这些商业场景。
- 已执行：最新 Windows browser **30/30**（完整适用 crash 18 项），匹配 QA release 的商业 native TC011/013 **2/2**（七次真实请求）通过，分别为 `scenarios-complete` / `documents-complete`，未命中失效 Key 分支。旧截图中发现回复未滚入视口，已增加 feed 跟随与读者向上浏览保护；新回执独立检查 Stop 卡片、Markdown 回复和历史尾部实际可见。完整 Windows native 36 项及最新 Linux/macOS hosted 整批继续执行，详见验证记录。

macOS FILE013 已定位为 QA bridge 未模拟应用请求的 pointer capture，拖拽离开 7px separator 后事件落到预览区，ratio 保持 50。补充 bridge 捕获路由及取消/异常恢复单元，保留原几何断言；真实 hosted WKWebView 通过前不关闭该缺口。原型全面视觉对齐继续排在本批反馈和待办之后。

提交：`89a0ed2e2` 为 QA pointer capture，`801a4132c` 为本批 Home 布局、feed 跟随及商业回归扩展。代码已推送，Linux/macOS 使用 [43789929072](https://github.com/engcapa/taomni/actions/runs/43789929072) 的 browser/native release 测试；商业 Key 仅在 Windows 本机读取执行。上一源码 `38623c5f3` 的 Linux native 为 31/32，其中 TH003 在平滑滚动中提前检查标题；本批增强等待为“标题完整进入设置视口且避开搜索栏”，没有降低最终几何要求。

TH-032 保留回归补充：`801a4132c` 的 Linux/macOS browser 已分别 30/30、31/31 通过；Windows native 为 35/36，FILE007 原生选择器的路径输入不完整仍须复跑。旧 macOS FILE011 另确认文件链接打开后的多次延迟激活会覆盖用户已切回终端的选择，新增两项 unit 均先复现失败，再删除延迟抢焦点；相关 34 unit tests 通过。FILE011 增强“切回后超过 3 秒仍活动”的真实 native 断言，新的匹配构建与最终整批执行前不关闭此项。

焦点修复提交为 `ed351a7c9`：Windows browser 已重跑 **30/30**，新的匹配 QA release 构建和静态 audit 通过，后续 native 回执以[验证记录](verification-2026-11-16.md)为准。当前源码的 Linux/macOS 工作流为 [43791999859](https://github.com/engcapa/taomni/actions/runs/43791999859)。

Windows 保存对话框的全局模拟送键丢字已用原生控件逐字输入及读回确认修正；最后 FILE007/011 native probe **2/2**、30 项对话框工具单元和 refactor 检查通过，实际四种导出及取消结果均保留原要求。完整 Windows browser/native 与新 runner 的 hosted 回执继续执行，不将 probe 结果等同于完整 TH-032 验收。具体失败保留、输入边界及匹配构建身份见[验证记录](verification-2026-11-16.md)。

`704f7aa79` 最终 Windows browser **30/30**、native **36/36**（全部 18/22 适用 crash）；商业 DeepSeek 三项、八次真实请求正常完成，没有走失效 Key 分支。Linux/macOS browser **30/30 / 31/31** 的 raw/receipt/产物身份校验通过。后续 macOS 设置定位回归补异步布局保护和用户接管，新增 8 项单元；完整 Settings/Workspace 单元 286 项、导航单元 3 项通过，新 source 的原生/hosted 结果以[验证记录](verification-2026-11-16.md)为准，不提前关闭 TH-011/032 或全部原型 AC。

`e57779493`（含设置异步布局保护）的 Windows browser **30/30**、匹配 QA release 的 native **36/36**，独立回执校验无拒绝，完整适用 crash **18/18 / 22/22** 均通过。新批商业 DeepSeek TC005/011/013 共八次真实 native 请求正常完成，无 Key 失效分支；Stop、Markdown 和恢复历史尾部均实际可见。GitHub [43796588906](https://github.com/engcapa/taomni/actions/runs/43796588906) 已成功结束：Linux browser/native **30/30 / 33/33**、macOS browser/native **31/31 / 35/35**，全部原始回执独立验签及逐项产物校验通过，各平台完整选择无遗漏/重复、全部 18/22 适用 crash 通过。FILE011/013 与 TH003 的原生保留回归均通过；完整 frontend **7011 passed / 1 条件跳过 / 0 failed**、Linux native Rust 契约 **120/120**。详见[当前源码验证批次](verification-2026-11-16.md#e57779493-当前源码的最终验证批次)；本批反馈和具名回归已验证，未覆盖的完整 AC 与全面原型对齐继续保留待办。

## 9. 2026-11-16 Agent 开发闭环与上下文批次

用户确认做模式支持“开发 → 测试 → 失败反馈 → 修复 → 补功能”，复杂编码复用 CC / Codex / ACP。范围与任务契约见 [三模式与本地上下文补强](agent-context-alignment.md)，实际结果持续记录于 [开发闭环验证记录](verification-agent-loop-2026-11-16.md)。

- 已实现逐项确认、完整文件预览、真实执行结果回传、线程隔离、拒绝/失败/取消/Undo 反馈及原生授权；待确认期间阻断新的发送与重复执行。原生探针发现的 Windows 相对路径和既有文件 canonical 尾分隔符问题已有复现单测与修复，等待匹配构建复验。
- 已实现三种编码 Agent 的预览交接、原有队列调度和显式结果带回；三入口组件测试通过，原生 ACP 使用实际子进程确定性 peer，不冒充商业 CC/Codex 推理验收。
- 新增 TC-TAO-HOME-024～030：商业/loopback 开发闭环、provider/模式选项、原生 ACP 交接、真实笔记/工作区上下文和商业持久化应用工程。旧商业用例转为配置的 OpenCode Go / deepseek-v4.1-flash / max，Key 仅在 Windows 本机隔离读取，不上传 hosted。
- 当前 frontend 69 tests、补充绑定组件2 tests、Rust33、Python33 和 refactor/静态 gate 通过；最新 Windows browser26/26（18项 crash）通过。完整 native、商业流程与 Linux/macOS hosted 仍须以本批实际回执验收；旧源码通过不关闭新批次。
- 深研真实阶段状态机、独立增量索引、全量来源/执行器组合和全面原型视觉对齐继续保留待办，不能以模式切换或普通 Research 多轮对话通过关闭。

## 10. 2026-11-16 Home 按钮与 Action 补充

用户要求已有覆盖复用、只补缺失的 browser/native 场景。具体入口、保留用例、预期结果和原生边界见 [按钮覆盖矩阵](button-action-coverage.md)，最新执行与失败保留见 [开发闭环验证](verification-agent-loop-2026-11-16.md)。扩展 001/002/003/007/009/010，新增 031～034；原生目录选择、非空记忆/技能的编辑/取消/导出/删除、动作审核编辑与实际子进程取消均按 UI 和实际副作用验收。

顶栏以最新反馈为准：删除设置、外观按钮，末尾顺序为演示、侧栏；设置保留 Dock More 入口。本批用例发现并修复整棵子进程树取消、设置搜索旧区域定位和原生记忆 prompt 不适合侧栏编辑的问题。最新源码、匹配二进制与各平台回执必须对应后才计通过；商业 OpenCode 启动遭自动审批拒绝仍为未执行，不能记作凭据失效或用 loopback 通过替代。深研阶段执行、真实语音、管理员提升和完整原型验收继续按前文保留待办。

## 11. 2026-11-16 历史删除与 Vault 遮罩取消

用户新增两项反馈已随 `e7e73cc01` 实现：History 每条 Tao 对话提供删除按钮及确认弹窗；启动 Vault 检查、解锁和 Tao 锁定遮罩均可取消，保留受保护操作的显式解锁要求。Home 与旧 tao-chat 分别走原存储删除；串行化自动保存和删除，防重载复活。

新增 035/036/037，扩展 009，并复用原有文件夹/本地 Shell 恢复用例从 History 入口验证。Windows browser 31/31、native 41/41 已执行通过（完整 crash 18/18、22/22）；其中额外旧 Vault 用例保留一项评审元数据待办，已评审用例的 status gate 通过。GitHub Linux/macOS 当前源码回执持续更新于 [历史与 Vault 验证](verification-history-vault-2026-11-16.md)。本节完成实现记录，最终各平台验收以该记录的实际状态为准。

后续 `3fa9de750` 修复 ACP 交接的旧历史覆盖新回复竞态，`2d8d0ff5b` 修正原生步骤的只读持久化诊断。最终匹配输入的 Windows 本机与 Linux GitHub browser 均 **31/31**、native 均 **41/41** 通过；完整适用 crash 均通过，两平台已评审范围合并 status gate 为 0 gaps / 0 rejected。修复前失败批次继续保留。GitHub 主批次 [43858855264](https://github.com/engcapa/taomni/actions/runs/43858855264) 只选择 Linux/macOS；两次补跑仅选择 macOS。macOS browser 缺失分片在 [43864993650](https://github.com/engcapa/taomni/actions/runs/43864993650) 补跑 **23/23** 并通过签名/产物/输入核验，合并覆盖 **31/31** 及全部 browser crash。

macOS native 当前 **20/41**，027/036/037 已执行通过，完整适用 native crash 为 **11/22**。剩余 21 项在 [43869363473](https://github.com/engcapa/taomni/actions/runs/43869363473) 单分片 native release 补跑中选择 32 项（含自动 crash）；producer 构建/上传成功，但执行 job 再次因 ARM runner 容量限制而未执行并被取消，workflow 最终 failure。**阻塞待办：补齐 21 项 macOS native 执行和完整原生 crash 验收**；具体 ID 见[当前验收范围与阻塞](verification-history-vault-2026-11-16.md#平台分工与当前验收阻塞)。三平台已评审范围 status gate 为 `ok=false`、20 个 macOS native 缺口、0 rejected；另保留旧 F12 的评审元数据及未执行待办。没有将构建成功或 runner 取消记作通过。

## 12. 2026-11-16 完成度复核与 macOS 补跑收敛

上节末尾为再次补跑前的历史状态。用户随后要求再次触发的 [43886401191](https://github.com/engcapa/taomni/actions/runs/43886401191) 已完成 **32/32 native**，0 failed / 0 skipped，包含原缺失全部 21 项和完整 22 项 crash。回执签名、687 个产物、selection/case/source/runner/config/build 身份均已独立核对。原定 macOS 41 项执行缺口已补齐，旧 F12 本次实际通过，评审元数据冲突仍待复核；没有重写先前 gate 或伪造新的三平台合并 gate。

本批用户反馈的实现及具名回归已具备证据，但整个 follow-up 尚未完成。深研真实状态机/工作流执行、持久预算与费用确认、独立增量检索及本地记录打开、完整审计/安全中心、商业 Go native、真实语音/管理员条件能力及完整原型和 Markdown/Word 验收矩阵仍须推进。39 项逐项状态、源码依据与各文件的历史口径见[完成度复核](completion-audit-2026-11-16.md)。

## 13. 2026-11-17 导出、draw.io、历史与共享 AI 设置

最新产品 `dc6de5f80` 已完成本批受影响回归：单测 **60 文件 / 273 项**，browser 三平台各 **46/46**，匹配 QA release native 为 Linux **54/54**、Windows **54/54**（主批加补跑）、macOS **52/52**，全部包含完整适用 **18/22 项 crash-regression**。原始失败、输入身份与独立产物核验保留在 [R16 验证记录](verification-md-history-agent-2026-11-17.md#r16-wrapped-export-notice-and-fast-reply-history)。此前各节的“待执行”按其当时版本阅读。

本批交付包括独立可搜索 PDF 及性能优化、Word 图形清晰度、导出菜单/目录记忆/预览主题文案、Mermaid 查看与旋转/复制、可编辑 draw.io 互通、Home 历史/附件分支修复，以及合并 AI 配置和受支持普通聊天 provider。指定 OpenCode 模型/max 的简单、多轮、图片/文档和 Python/TypeScript 实际开发闭环已有商业 QA release 证据；具体版本、九轮执行和 16/15 项最终测试见同一验证记录，不由 loopback 回归替代。

原始 39 项复核仍分为 **13 项具名范围已交付、11 项部分实现、15 项整体验收未齐**；本批新增功能不重复计入原表。未完成的实际执行器、预算/费用接线、增量检索/本地导航、审计、长任务恢复，以及 Word 客户端和少数平台条件验收，见 [当前范围与统计口径](completion-audit-2026-11-16.md#当前范围与统计口径)。本节不批量勾选尚未满足完整 AC 的原任务。
