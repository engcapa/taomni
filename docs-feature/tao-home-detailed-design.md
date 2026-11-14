# Tao Home 细化设计（v0.3）：交互、状态、数据与安全落地

> 状态：设计稿（未实现）。v0.3 修订：① **Tao AI Chat 作为可被宿主嵌入的整体组件**（新增 §6.0，改写 §6.1/§6.3），为日后与 `feat/development-orchestrator` 整合预留边界；② 原首页“启动 / 最近 / 恢复会话”并入聊天输入框下方的**底部快捷行**，**历史**排第一位，WSL 仅在系统检测到时显示，**LAN 聊天入口全部移除**（新增 §3.7）；③ §13 的索引与触发规则拆成 P1-2 开发子任务（§10）。v0.2 修订：D-13/15/16 已批准，D-14 改为“不做连通性测试”，新增 §13 本地资料检索、§14 联网调研依据、§15 界面精简规则、§16 原型 v0.2 说明。承接 `docs-feature/tao-home-design.md`（v1.3，以下称“主设计”）与 `claudedocs/adr-tao-home-deepseek-app.md`。
> 配套高保真原型：`docs-feature/tao-home-prototype.html`（单文件，浏览器直接打开；顶部“状态与界面”菜单可跳转到每个状态，另有“系统有 WSL”开关与“宿主”切换）。
> 本文不重复主设计已决策的内容（§16 决策 1–12 全部继承），只做三件事：**复核（§1）、细化（§2–§9）、给出开发可拆分的验收口径（§10–§11）**。

## 0. 文档边界

| 项 | 内容 |
|---|---|
| 继承（不再讨论） | 双轨并行、`deepseek-app` 轨道、问/做/深研三档、绑定栏、FTS5 为主、8 层安全防御、内置工作流、每轮 10M token 预算、工具次数不限 |
| 本文新增 | ① 对主设计的 10 条复核发现与处理建议；② 首页完整状态机（17 个状态）；③ 逐区域交互规格；④ “做”模式动作协议提案；⑤ 费用与预算的计算与展示口径；⑥ 前后端模块切分与 store 形状；⑦ 可测试验收清单 |
| 决策状态 | D-13～D-16 已由用户答复（见下表），无待决项 |
| 核查方式 | 对照本地代码（`WelcomePanel.tsx`、`chat/redact.rs`、`styles/theme.css`、`styles/platform.css`）与主设计原文；**未**运行 Taomni，**未**实际调用 DeepSeek API（与主设计一致，价格与上下文窗口以官方页面为准） |

---

## 1. 复核发现：主设计里需要修正或补决策的地方

> 原则：发现问题就在这里记，不静默改主设计正文。采纳后由主设计追加修订记录（主设计 §16 的要求）。

| # | 发现 | 证据 | 影响 | 建议处理 |
|---|---|---|---|---|
| F1 | **P1 与 P2 对“写入时脱敏”的排期互相矛盾**。§11.1.4 第 1 层写“P1，必须做；不做不许开本地检索”，但 §12 把本地检索放进 P1、把写入时脱敏放进 P2 | 主设计 §11.1.4 第 1 层 vs §12 P1/P2 条目 | 按 §12 排期会出现“检索先上线、脱敏后上线”，直接违反 §0.3 最后一条与 S1–S3 门禁 | **勘误**：写入时脱敏 + 历史迁移前移到 P1，作为本地检索的前置任务（P1-0）；审计日志与安全中心 UI 仍在 P2，但 P1 先有只读的“脱敏计数”和按源开关 |
| F2 | **主设计称“沿用现有分支模型 `parentId` / `selectedChildId`”，仓库里没有这两个字段** | `grep selectedChildId` 在 `src/`、`src-tauri/src/` 无命中；`ChatMessage` 字段清单（主设计 §2.2）也没有 | 开发会按“已有”估时，实际要新建分支模型 | **勘误**：分支关系放进新表 `ds_app_blocks` 的同级消息表（见 §6.2 `ds_app_messages`），旧表不动；P0 工作量加 0.5 周 |
| F3 | “做”模式依赖本地工具循环，但 Messages API 没有客户端 function calling（ADR 已承认，未决） | ADR §3 负向成本 | “做”模式无法落地，P2 关键路径阻塞 | **【需决策】D-13**：见 §5，推荐“动作提议块”方案 |
| F4 | **工具费阈值 0.5 元与深研并行度 3 的关系没算过**。按主设计的“约 5 元/千次”，0.5 元 ≈ 100 次搜索；深研一轮读链接可能远超这个数 | 主设计 §6.3、§9.4.1 | “只问一次”在开跑后才触发，用户已经付了前半段 | **细化**：深研在计划阶段给出“预计工具费区间”，用户确认计划时一并确认；运行中累计超过确认上界再问一次（§7.2） |
| F5 | **预算提示点只写了 50% / 80%，没有写 token→金额的换算来源** | 主设计 §9.4.1、§6.4 用量行 | 价格会变；写死会误导 | **细化**：价格表做成随应用发版的带日期 JSON（`pricing.json`，含 `as_of`），UI 一律标“估算”，价格缺失时只显示 token（§7.1） |
| F6 | 首页“居中 Composer + 建议 + 最近 + 启动”在 1366×768 的笔记本上放不下 | 主设计 §6.1 的 ASCII 布局 | 启动区被挤到首屏外，老用户找不到入口 | **细化**：给出垂直预算表与折叠规则（§3.2）；启动区永远在首屏可见（至少一行图标条） |
| F7 | **旧 `deepseek` Key 已在 Vault 时，首页仍显示“无 Key”会让老用户困惑** | 主设计 §0.3“无 Key 时 1 步可达设置” | 老用户多一次复制粘贴 | **【需决策】D-14**：检测到已有 `deepseek` Key 时提示“沿用此 Key”，仅复制 Vault 引用（`vault:<id>`），不复制明文。**未验证**两个端点是否接受同一把 Key；按用户决定不做预先测试，首次发送失败时显式提示 |
| F8 | “开发者模式的 Vault 15 分钟闲置自动锁”会在**长深研任务中途**锁定并中断流（主设计第 3 层：锁定即中断流） | 主设计 §11.1.4 第 3 层 | 一次 20 分钟的深研被自动锁杀掉 | **【需决策】D-15**：流式任务运行期间视为“活跃”，闲置计时暂停；仅用户锁屏/手动锁定才中断。推荐采纳 |
| F9 | 建议卡片来自“最近终端最后一条报错”，该内容会在首页明文显示，且可能含凭据 | 主设计 §6.5 | 屏幕共享/截图时泄露 | **细化**：建议文本过同一套 `redact()` 后再显示；增加“演示模式”开关（隐藏建议与最近列表，§3.6） |
| F10 | 旧 `chat_send_shortcut`（Ctrl+Enter）与首页大输入框的默认习惯冲突（ChatGPT 系默认 Enter 发送） | 主设计 §6.3 | 新用户首次回车换行，误以为卡住 | **【需决策】D-16**：沿用用户已有设置；首次进入首页若设置为默认值，Composer 下方显示一次性小字提示当前发送键，可一键切换，不改默认 |

决策项汇总（请在主设计 §16 追加 13–16 行）：

| # | 事项 | 推荐 |
|---|---|---|
| D-13 | “做”模式工具协议 | **已批准**：动作提议块（§5） |
| D-14 | 沿用旧 DeepSeek Key | **已批准（有修改）**：只复制 Vault 引用，**不做上线前连通性测试**（节省 token）；“新旧端点接受同一把 Key”仍是**未验证假设**，失败在**首次真实请求**时显式报错（错误卡写明“Key 可能不适用于新端点”，并给“去设置换 Key”），不静默回落到旧轨道 |
| D-15 | 流式期间暂停 Vault 闲置计时 | **已批准** |
| D-16 | 发送键 | **已批准**：沿用现有设置；首次进入首页显示一次性提示，点“知道了”后不再出现 |

---

## 2. 设计语言与外壳

### 2.1 复用，不新造视觉体系

Tao Home 渲染在 Taomni 现有外壳里（标题栏 / 主 rail / 标签栏 / 状态栏 / 右缘 Tao Ribbon），**不自带一套主题**。颜色全部取 `--taomni-*` 令牌（`src/styles/theme.css` 浅色、`platform.css` / theme 暗色块）：

| 用途 | 令牌 | 浅色 | 暗色 |
|---|---|---|---|
| 页面底 | `--taomni-bg` | `#f8fafc` | `#1e1f22` |
| 外壳底（rail / 标签栏） | `--taomni-chrome-bg` | `#f1f5f9` | `#191a1c` |
| 卡片 / Composer | `--taomni-card-bg` / `--taomni-card-border` | `#ffffff` / `#e2e8f0` | `#26282e` / `#35383f` |
| 强调 | `--taomni-accent` | `#1e40af` | `#6aa6f8` |
| 选中 | `--taomni-selected` / `-border` | `#dbeafe` / `#93c5fd` | `#25354d` / `#4d7ec4` |
| 文本 / 次要文本 | `--taomni-text` / `-muted` | `#0f172a` / `#64748b` | `#e6eaf0` / `#9ca3ad` |

新增语义色（只在 Tao Home 内部用，落到 `taoHome.css`，用 `color-mix()` 基于令牌派生，不新增全局令牌）：`--tao-think`（思考块，accent 8% 混合）、`--tao-warn`（费用/确认，取现有警告色）、`--tao-danger`（L2 以上确认）、`--tao-ok`。

### 2.2 字体与尺寸

沿用 `--taomni-ui-font-size`（默认 13px）。标题 22px/600，Composer 正文 15px，消息正文 14px/1.65，代码取 `--taomni-code-font-family`。圆角：卡片 10px、Composer 16px、chip 999px。动效统一 `--taomni-transition`，并响应 `prefers-reduced-motion`（关闭流式光标闪烁与脉冲，改静态点）。

### 2.3 命名与文案规则（继承主设计 §0.2.1）

产品名 “Tao”，副标题 “Develop Buddy”；界面只写 “DeepSeek · 全家桶”，不出现 `deepseek-app`。同一屏不混用“助手 / 机器人 / Copilot”。费用一律写“估算”。

---

## 3. 首页版式规格

### 3.1 区域划分（自上而下）

| 区域 | 内容 | 空态 | 对话态 |
|---|---|---|---|
| A 顶栏 | 模式切换（问/做/深研）· 绑定栏 · 右侧：用量 / 搜索（Ctrl K）/ 更多。**历史入口不在顶栏**（见 D） | 显示 | 显示，下方附 1px 分隔 |
| B 主舞台 | 空态：问候 + Composer（垂直 38%）；对话态：消息流 | 居中 | 滚动 |
| C 建议行 | 本地计算的建议卡片（最多 4 张） | 3 行布局 | 收为 1 行横向滚动 |
| D 底部快捷行 | **历史** · 本地终端 · WSL（仅检测到时）· 新会话 · 新工作区 · 更多；**无 LAN 聊天**。位于 Composer 正下方（§3.7） | 显示（居中） | **仍显示**（紧凑，靠左），随 Composer 一起吸底 |
| E（并入 D） | 原“最近会话 / 最近工作区 / 恢复上次会话”不再单独占一块，收进 D 的“历史”浮层 | — | — |
| F 右侧栏 | 来源 / 文件 / 生成物 / 工作流 | 隐藏 | 有内容才出现，宽 340px，可收起 |
| G 页脚 | 仅版本号 + 品牌 T | 小字 | 隐藏 |

### 3.2 垂直预算（防止启动区被挤出首屏）

以内容区可用高度 H（1366×768 下约 640px）为基准：

| 区块 | 高度 | 规则 |
|---|---|---|
| 顶栏 | 44px | 固定 |
| 问候 | 64px | H < 600 时隐藏副标题，H < 520 时整块隐藏 |
| Composer（单行） | 96px | 可随输入增高到 220px 后内部滚动 |
| 底部快捷行 | 32px | **永远保留**（空态与对话态都在 Composer 下方），H < 520 时降为纯图标 |
| 建议行 | 76px | H < 600 时只显示 2 张；对话态收为 1 行 |
| 页脚 | 28px | 固定 |

空态下 Composer 的目标位置是“可用高度的 38%”，但不得使上述任何**永远保留**项（含底部快捷行）落到视口外：布局用 CSS Grid `grid-template-rows: auto minmax(0,1fr) auto`，Composer 区用 `align-self: center` + `max-height`，而不是绝对定位。

### 3.3 绑定栏

三个 chip：工作区 / 终端 / 数据库。未绑定为虚线空 chip（“+ 绑定终端”），已绑定为实心 chip（图标 + 名称 + `×`）。点击展开浮层：最近 5 项 + 搜索 + “浏览全部”。浮层键盘可达（↑↓ 选择，Enter 绑定，Esc 关闭）。绑定变化写入线程 `tao_binding`，并在顶栏用 1.5 秒的细微高亮提示“已绑定”。

**隐私提示**：每个 chip 的 tooltip 写明“会发送给模型的内容”，例如终端：“仅在你 @ 引用时发送最近 N 行（已脱敏）”。绑定本身不发送任何内容。

### 3.4 Composer 区

- 上沿：已选上下文 chip 行（`@terminal:last-30`、`@file:a.rs` …），每个 chip 点击可预览将发送的脱敏后文本。
- 主体：多行输入；右下发送键；左下工具条：附件、录音、思考、联网、模型。
- 下沿小字（一行）：发送键提示 · 联网费用提示（仅联网开时）· “本次将发送：正文 + N 条本地资料”（有本地资料时，可点开逐条取消，对应主设计第 7 层）。
- 状态：`idle / composing / uploading / sending / streaming / stopped / error / disabled(no key)`。

**键盘**：Enter/Ctrl+Enter 按设置；`@` 开菜单；`Esc` 清除菜单或停止流；`↑` 在空输入时编辑上一条用户消息（与 chat-demo 编辑一致）。

### 3.5 对话态消息区

块顺序固定为：`thinking → 搜索步骤 → 正文 → 来源卡片 → 动作卡片 → 用量行`。

| 块 | 展示 | 折叠 | 备注 |
|---|---|---|---|
| thinking | “已思考 X 秒”，展开显示原文，弱化色 | 默认折叠；流式中展开并显示光标，结束后 600ms 自动折叠 | 用户手动展开过的不再自动折叠 |
| 搜索步骤 | `正在搜索：query` → `已找到 N 个来源` → `正在阅读：url` | 结束后折叠成一行摘要 | 失败步骤红点，可展开原因 |
| 正文 | Markdown，引用角标 `[1]` 可点，点后右栏定位到来源 | — | KaTeX P0 回落纯文本 |
| 来源卡片 | 标题 / 站点 / 摘要 / 打开 | 超过 3 条折叠 | 外链用系统浏览器打开 |
| 动作卡片 | 见 §5 | — | L1 以上必须停在此处等确认 |
| 用量行 | `输入 X · 输出 Y · 搜索 N · 抓取 M · 约 ¥Z（估算）` | — | 价格表缺失时去掉金额 |

回复操作区（悬停显示，触屏常显）：复制、朗读、重新生成、分支切换 `‹ 2/3 ›`、**交给 CC / Codex 做**（主入口，主设计决策 8）。

### 3.6 演示模式（F9）

设置里的开关，也可在顶栏菜单一键切换：隐藏建议行、历史浮层中的会话 / 工作区名称（显示为“会话 1”）、绑定名称（显示为“终端 1”），Composer 上方的本地资料 chip 只显示类别。默认关。

### 3.7 底部快捷行（原首页快捷操作与历史的新位置）

位置：Composer 与其提示小字的**正下方**，空态与对话态都显示；对话态随 Composer 吸底，不随消息滚走。自左到右：

| 序 | 项 | 行为 | 显示条件 |
|---|---|---|---|
| 1 | **历史**（与其余项之间有细分隔） | 向上展开浮层，三个页签：**Tao 对话**（按日期分组，● DeepSeek · 全家桶 / ○ 旧 tao-chat，同一份线程数据，带“进行中”点）· **最近会话** · **最近工作区**；顶部搜索框随页签切换；底部“＋ 新 Tao 对话”“↺ 恢复上次会话（N 个标签）” | 始终 |
| 2 | 本地终端 | 沿用现有“启动本地终端”（含 shell 选择） | 始终 |
| 3 | WSL | 沿用现有 WSL 启动 | **仅当 WSL 检测就绪且至少有一个发行版**；否则**整项不渲染**（不置灰） |
| 4 | 新会话 | 沿用 `onNewSession` | 始终 |
| 5 | 新工作区 | 沿用 `onOpenNewWorkspace` | 始终 |
| 6 | 更多 | 邮件会话 / 数据库会话 / VNC·RDP / 本地目录（沿用现有 PlatformLaunchCards 的其余项） | 始终 |

要点：

- **WSL 判定沿用现有逻辑**：`useWelcomeShells` 的 `wslStatus === "ready" && wslDistros.length > 0`（`WelcomePanel.tsx` 现有条件），loading / error / unsupported 一律隐藏。
- **历史浮层的数据源沿用现有**：最近会话 / 最近工作区来自 `WelcomePanel` 现有的 `recentSessions` / `recentWorkspaces` 与 `WelcomeHistoryPanel`、`RecentSessionsPanel`、`RecentWorkspacesPanel`；本设计只改承载位置，不新建数据。点击最近会话 / 工作区在对应标签打开，**不进入聊天**。
- **演示模式**：历史浮层中的会话与工作区名称显示为“会话 1 / 工作区 1”，并提示“演示模式：已隐藏名称”。
- **顶栏与左侧 rail 不再放历史按钮**，历史只有一个入口，避免重复。
- **快捷行属于宿主，不属于 TaoAiChat**（§6.0）：它是 Home 宿主通过 `belowComposer` 槽位注入的内容；换成别的宿主（如开发 Agent）时可以不提供。

**LAN 聊天移除**：Home 范围内删除所有 LAN 聊天 UI（原“LAN 聊天”启动按钮、`onOpenLanChat` 属性及其测试 id `welcome-open-lanchat`、相关文案）。已核查：`onOpenLanChat` 在 `TabContentRouter.tsx`、`welcome/types.ts`、`PlatformLaunchCards.tsx`、`WelcomePanel.tsx` 中使用；LAN 聊天另有**首页以外的入口**（`ToolsPanel`、`ControlBar`、`useMainMenuActions`、`commandActions`、`useMainUtilityTabs`、若干 store 与 `components/lanchat/`），**本设计只涉及 Home 入口层**，整体下线范围见 §17 待确认项。

---

## 4. 首页状态机（17 个状态）

原型“状态”菜单与此表一一对应。

| # | 状态 | 触发 | 首页表现 | 出口 |
|---|---|---|---|---|
| S0 | 无 Key | 未配置 Key | Composer 禁用；中央卡片“连接 DeepSeek · 全家桶”，主按钮“去设置”，次按钮“沿用已有 Key”（F7，条件出现） | 保存 Key（或沿用 Vault 引用）→ S1；Key 不适用时在首次发送后转 S9 并给出明确提示 |
| S1 | 空态就绪 | 有 Key，无消息 | 问候 + Composer + 建议 + 启动 + 最近 | 发送 → S2 |
| S2 | 发送中 | 点发送 | 用户消息上屏，Composer 变“停止”，队列提示（同线程串行） | `ds_message_start` → S3/S4/S5 |
| S3 | 思考中 | thinking 块 | 展开 thinking，计时 | 块结束 → S4 或正文 |
| S4 | 搜索/读链接中 | `server_tool_use` | 搜索步骤逐条出现 | 完成 → 正文 |
| S5 | 正文流式 | text delta | 光标 + 引用角标渐入 | `message_stop` → S6 |
| S6 | 完成 | 停止事件 | 用量行、复制/朗读/分支可用，标题更新 | 新一轮 |
| S7 | 已停止/可继续 | 用户停止或到上限 | “继续生成”按钮，保留已收到块 | 继续 → S5 |
| S8 | 拒答 | `stop_reason=refusal` | 丢弃思考与正文，显示拒答卡（“安全校验未通过本次回复”），可改写重试 | 编辑重发 |
| S9 | 错误 | `ds_error` | 错误卡（分类：http/stream/network/interrupted/protocol），保留已收块，“重试” | 重试 → S2 |
| S10 | 等待动作确认 | “做”模式动作提议 | 动作卡高亮，Composer 软禁用（可输入不可发送） | 确认/拒绝/编辑 |
| S11 | 工作流计划待批 | 深研/排查计划生成 | 计划 checklist，三个按钮：开始 / 跳过选中步骤 / 取消 | 开始 → S12 |
| S12 | 工作流运行 | 已批准 | 步骤 checklist 动态更新，右栏“工作流”页 | 完成 / 失败 / 取消 |
| S13 | 预算 50% / 80% | 累计 token | 顶栏用量胶囊变黄/橙，一次性 toast，不打断流 | — |
| S14 | 预算 100% | 达上限 | 停止，摘要卡 + “提高预算继续”（续跑不重跑） | 续跑 → S12/S5 |
| S15 | Vault 已锁 | 手动/锁屏 | 流立即中断，遮罩“Vault 已锁定”，解锁后可从 S7 续 | 解锁 |
| S16 | 离线/代理失败 | 网络层 | 顶栏红点 + 错误卡；**不静默直连** | 修复后重试 |

状态转换约束：同一线程任意时刻只有一个“进行中”状态（S2–S5、S10–S12）；切换线程时进行中的流**继续在后台跑**，顶栏线程列表对应线程显示“进行中”点（沿用 `taoAlertStore.pushAiDone` 桥接，完成后给提醒）。

---

## 5. “做”模式动作协议（D-13 提案）

### 5.1 问题

Messages API 没有客户端 function calling，Tao 需要让模型“提出”要做的事，由 Rust 校验、用户确认、本地执行。

### 5.2 方案对比

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A（推荐）动作提议块** | system 约定模型在正文中输出带围栏的 `tao-action` JSON 块；Rust 解析、**白名单校验 schema**、转成动作卡；用户确认后 Rust 执行，结果以 `tool_result` 文本回灌下一轮 | 不换轨道；对话和动作同一流；实现量小；解析失败直接降级为普通文本 | 依赖模型遵守格式，需对解析失败/越权字段做显式处理；不是协议级保证 |
| B 走 OpenAI 兼容 Chat Completions + tools | “做”模式单独走旧协议 | 协议级 function calling | 两套请求体、两套流事件；与“双轨冻结、新轨道统一”相冲突；服务端搜索/读链接在该协议下不可用（未验证） |

### 5.3 动作块 schema（A 方案）

```json
{
  "id": "act_01",
  "kind": "run_command | run_sql | write_file | write_note | open_tab",
  "level": "L1 | L2",
  "title": "查看磁盘占用最高的目录",
  "target": { "terminal_id": "t-7", "cwd": "/var/log" },
  "payload": { "command": "du -sh * | sort -rh | head" },
  "reason": "日志目录可能是占满磁盘的原因",
  "expects": "read_only"
}
```

校验规则（Rust，失败即丢弃并显示“动作格式无效”，**不尝试修复**）：

1. `kind` 在白名单内；`level` 以 Rust 侧按 `kind` 与 `shell_safety` 结果**重新计算**，模型给的 `level` 仅作参考，不能降级。
2. `target` 必须落在当前绑定内（终端、工作区路径前缀、数据库连接）；越界即拒绝。
3. `run_command`：先过 `src-tauri/src/ai/shell_safety.rs` 复核；命中危险模式升为二次确认。
4. `write_file`：只允许绑定工作区内路径；执行前备份原文件到 `local_history`，卡片提供“撤销”。
5. 每条回复最多渲染 5 个动作卡；超出的折叠为“还有 N 个动作提议”，避免模型刷屏。
6. 动作结果（退出码、截断后的输出）回灌下一轮，输出经 `capture`/`reduce` 截断并先脱敏。

### 5.4 动作卡（UI）

内容：标题 · 级别徽标（L1 琥珀 / L2 红）· 目标（终端名 + cwd）· 完整命令/SQL（可编辑，等宽字体）· 理由 · 三按钮：**执行 / 拒绝 / 编辑后执行**。L2 的“执行”需要按住 0.6 秒或勾选“我已确认命令内容”（二选一，设置里可选；默认勾选框）。执行后卡片变为结果卡：退出码、耗时、折叠输出、“撤销”（仅 L1）。

---

## 6. 组件边界与数据切分

### 6.0 Tao AI Chat：可嵌入的整体组件（面向与 `feat/development-orchestrator` 整合）

**背景（已核查，只读检查了该分支的文档与文件清单，未合并、未运行）**：该分支的 v0.6 设计把“开发 Agent”主界面定为“项目 / 任务侧栏 + 会话与输入框 + 按需右侧检查器”；它把旧聊天的 provider 请求 / 流 / 协议代码抽到 `src-tauri/src/llm/*`，自带 `orchestrationStore` 与独立数据表，并明确“聊天线程是交互视图，不是任务状态机，不把 task_id 塞进 thread_id”。两边都要一个“消息流 + 输入框”的会话界面，所以 Tao 的聊天必须做成**宿主可替换槽位的整体组件**，而不是写死在首页里。**该分支的合并时间与最终接口尚未与其作者对齐；本节是 Tao 侧单方面的边界约束，对接时以双方评审为准。**

**组件定义**：`TaoAiChat` = 消息流 + Composer + 块渲染 + 动作卡 + 预算与用量 + 可选侧栏。它**不知道自己在首页**，也不 import 首页、WelcomePanel、rail、任何 `taoHome` 全局状态。

```text
<TaoAiChat
  controller={chatController}   // 实例，不是全局单例；每个宿主自建
  profile={chatProfile}         // 模式列表 / 默认开关 / 侧栏页签 / 文案
  slots={{ headerLeading, headerTrailing, composerContext,
           belowComposer, sidePanels }} />
```

| 对象 | 职责 | 首页宿主（本设计） | 其他宿主（例：开发 Agent，示意） |
|---|---|---|---|
| `ChatBackend`（端口） | `send / stop / regenerate / continue / branches / listThreads`，产出统一的块事件流 | `DeepSeekAppBackend`（Rust `deepseek_app`） | 可另写适配器（如接编排器的 LLM 调用服务）；**不要求同协议** |
| `ContextPorts`（端口） | 读终端 / 工作区 / 数据库 / 笔记摘要（脱敏后）、`TaoSearch` | 绑定栏三项 + 本地检索 | 项目 / 分支 / 文件引用 |
| `ActionPorts`（端口） | 执行动作提议（Rust 重算级别、限定目标） | 绑定终端 / 工作区 | 由宿主决定可执行范围 |
| `BudgetPort` | token 预算与工具费确认 | 每轮 10M、确认阈值 | 宿主自定 |
| `profile` | 模式标签与默认值、侧栏页签名 | 问 / 做 / 深研；来源 / 文件 / 生成物 / 工作流 | 如 开发 / 规划 / 审阅；上下文 / 变更 / 候选 / 任务（**仅为槽位演示，不代表该分支设计**） |
| 槽位 | `composerContext`=绑定栏、`belowComposer`=底部快捷行、`headerLeading`=宿主导航 | Home 宿主注入 | 开发 Agent 宿主注入项目 / 分支 chip；不提供快捷行 |

边界规则（可用 lint / 目录约束检查）：

1. 组件包 `src/components/tao/ai-chat/` 只对外导出 `index.ts` 中的 `TaoAiChat`、`createChatController`、类型；**宿主不得深引用内部文件**。
2. 组件内**禁止** import：`WelcomePanel`、`welcome/*`、`layouts/*`、`orchestrationStore`、旧 `chatStore`。需要的数据一律走端口注入。
3. 状态**按实例隔离**：`createChatController()` 返回独立 store；同一窗口可同时挂两个 `TaoAiChat`（例如首页一个、开发 Agent 一个）互不污染。线程 `runtime` 仍按 `ThreadId` 分键。
4. 数据表前缀固定为 `ds_app_*` / `tao_*`，**不与编排器的表共用**；Tao 线程与编排任务之间只允许“引用关系”（任务记录 `thread_ref`，线程不记 `task_id`），与编排分支的原则一致。
5. 后端：`deepseek_app` 先独立实现；编排分支的 `llm/*` 传输层合并后，再评估让 `deepseek_app` 复用其请求 / 流解码（**评估项，不是承诺**）。两边都会改动 `src-tauri/src/chat/` 与 `llm/` 附近文件，开工前先 rebase 并列出冲突面。
6. 快捷行、历史浮层、LAN 清理、WSL 检测都属于 **Home 宿主层**，不进组件包。

整合验证（P0-0 的退出条件）：原型“宿主”下拉切到“开发 Agent（示意）”，同一个聊天组件只换绑定栏、模式标签、底部行与侧栏页签，其余行为不变；实现时用一个最小“空宿主”测试页复现同样的检查。

### 6.1 前端模块（只新增，不改 `chatStore`）

```text
src/components/tao/ai-chat/                 ← 整体组件（可嵌入）
  index.ts                  对外唯一出口
  TaoAiChat.tsx             组合层 ≤150 行（接 controller / profile / slots）
  TopBar.tsx                模式 + 用量 + 宿主槽位
  Composer.tsx              包装现有 chat/Composer 壳，注入新轨道能力
  MessageList.tsx / blocks/{Thinking,SearchSteps,Text,Sources,ActionCard,UsageLine}.tsx
  SidePanel.tsx             页签由 profile 决定
  states/{ErrorCard,RefusalCard,BudgetCard,VaultLockedMask}.tsx
  ports.ts                  ChatBackend / ContextPorts / ActionPorts / BudgetPort 类型
  controller/               createChatController：threads / sending / blocks / budget / workflow
src/components/tao/search/                  ← Tao Search 面板，同样只依赖端口
src/components/tao/home/                    ← Home 宿主（只做宿主）
  TaoHomeHost.tsx           组装 TaoAiChat + 槽位
  BindingBar.tsx / BindingPopover.tsx       → composerContext 槽
  DockRow.tsx / HistoryPopover.tsx          → belowComposer 槽（复用 WelcomePanel 子组件与数据）
  SuggestionRow.tsx / NoKeyCard.tsx
```

每个文件 ≤800 行（AGENTS.md 上限），目标 ≤300 行；`DockRow` 直接复用 `WelcomePanel` 的本地终端 / WSL / 新会话 / 新工作区子组件，不复制；**删除 LAN 聊天入口**。

### 6.2 新表（补充 F2：分支）

主设计 §8.2 的 `ds_app_blocks` 保持不变，新增消息级表承载分支与父子关系：

| 表 | 关键列 | 说明 |
|---|---|---|
| `ds_app_messages` | `id`, `thread_id`, `parent_id`, `role`, `selected_child_id`, `ds_request_id`, `model`, `stop_reason`, `created_at` | 分支树；旧 `chat_messages` 不动 |
| `ds_app_blocks` | `id`, `message_id`, `idx`, `type`, `text_redacted`, `meta_json`, `started_at`, `ended_at` | thinking 耗时取起止时间 |
| `ds_app_usage` | `message_id`, `input_tokens`, `output_tokens`, `search_calls`, `fetch_calls`, `est_cost_cny`, `price_as_of` | 金额可空 |
| `tao_workflow_runs` / `_steps` | 见主设计 §9.4.4 | 状态机 |
| `tao_audit` | 见主设计 §11.1.4 第 7 层 | P2 |

线程元数据沿用旧 `chat_threads` 并新增 `tao_binding`（JSON，键由宿主 profile 决定）、`mode`、`thinking_on`、`web_on`、`model` 列；`provider_id='deepseek-app'`。

### 6.3 聊天 controller 状态形状（节选；实例级，由 `createChatController()` 创建）

```ts
interface TaoHomeState {
  activeThreadId: string | null;
  mode: "ask" | "do" | "research";
  context: Record<string, string | undefined>;   // 绑定项由宿主定义：首页为 workspace / terminal / db，其他宿主可为 project / branch
  composer: { text: string; chips: ContextChip[]; attachments: Attachment[];
              thinking: boolean; web: boolean; model: "deepseek-flash" | "deepseek-v4-pro" };
  runtime: Record<ThreadId, { phase: Phase; budget: BudgetMeter; pendingAction?: ActionProposal }>;
  ui: { sidePanel: string | null /* 取自 profile.sidePanels */; demoMode: boolean };
}
type Phase = "idle"|"sending"|"thinking"|"searching"|"streaming"|"stopped"
           |"refusal"|"error"|"awaiting_action"|"plan_pending"|"running_workflow"
           |"budget_halt"|"vault_locked";
```

`runtime` 按线程隔离，保证“后台线程继续跑”不污染当前线程；整个 controller 按实例隔离，保证多个宿主互不污染（§6.0 规则 3）。

---

## 7. 费用与预算口径

### 7.1 价格表

- `pricing.json` 随应用发版：`{ "as_of": "2026-11-14", "models": {...}, "tools": {"search_per_call": ..., "fetch_per_call": ...} }`。数值**以官方定价页为准后填写**；主设计中“约 5 元/千次”仅作占位，不进代码。
- 缺失或 `as_of` 超过 90 天：用量行不显示金额，只显示“金额未估算”。

### 7.2 确认与预算的计算

| 机制 | 口径 | 触发 | 行为 |
|---|---|---|---|
| 工具费确认 | 同一轮内累计**预计**工具费 > 阈值（默认 ¥0.5） | 深研：计划阶段；其它：首次工具调用前 | 弹一次确认，记录“已确认上界 = 预计 × 1.5”；运行中累计实际超过上界才再问一次 |
| Token 预算 | 单轮输入+输出累计，默认 10M | 50% / 80% / 100% | 50%：toast；80%：顶栏变橙并给“现在停止”；100%：停，保存摘要，续跑不重跑 |
| 账号级 | DeepSeek 平台额度 | 服务端报错 | 作为 S9 错误卡展示，原样转述错误类别，不绕过 |

顶栏用量胶囊显示 `本轮 1.2M / 10M · ¥0.xx（估算）`，点开显示分项与“提高预算”。取不到服务端 `usage` 时按文本长度估算并标“估算”。

---

## 8. 本地资料检索的 UI 细化（承接主设计 §5.6 / §11.1）

1. **来源 chip**：每次检索命中，Composer 上方出现 chip：`命令历史 · 3 条`，点开列出被选中的**脱敏后**片段，每条可取消（对应“不要静默发送本地资料”）。
2. **脱敏计数**：回复下方用量行末尾显示 `已脱敏 N 处`，点开只显示类别（“密码 2、token 1”），不显示原值。
3. **按源开关**：设置 → Tao → 本地资料，表格 10 行（主设计 §5.6.4），开关即时生效；关闭时显示“该源索引将在 1 分钟内清除”倒计时。
4. **空结果**：明确写“本地没有找到相关资料”，不让模型凭空编造；回复中引用本地资料时标 `本地` 角标，与 `联网` 角标区分颜色与图标。
5. **门禁提示**：S1–S3 任一项未通过时，设置页该区域显示“本地检索未启用：安全检查未通过（S2）”，开关不可点。

---

## 9. 设置页：Tao 与安全中心（P1 骨架，P2 完整）

| 分区 | 内容 | 阶段 |
|---|---|---|
| 连接 | Key（Vault 引用）、沿用旧 Key（D-14，不测试）、出口 allowlist 只读展示 | P0 |
| 模型与模式 | 默认模型、各模式默认开关、发送键提示、预算（10M）与确认阈值（¥0.5） | P0/P1 |
| 本地资料 | 10 个源的开关、索引大小、一键清除索引 | P1 |
| 脱敏 | 内置规则列表（现有 5 条 + 新增）、自定义正则、历史迁移结果“已清理 N 条” | P1 |
| 语音 | ASR/TTS provider（默认本地 Whisper）、音色 | P1 |
| 安全中心 | Vault 自动锁（15 分钟，D-15 例外）、审计日志查看/导出/清空、“清除全部 Tao 历史”（二次确认） | P2 |

现状事实（已核查）：`chat/redact.rs` 现有 **5 条**正则（password、token/api-key/secret/auth、Bearer、`-p`、`Authorization:`）；主设计新增规则（私钥块、AWS、GitHub、JWT、连接串、X-Api-Key）需逐条补单测。注意现有 `-p\s*\S+` 会误伤普通参数（如 `ls -p`），迁移到写入时脱敏前要先评估误伤率，否则会破坏命令历史可用性。

---

## 10. 开发拆分建议（按 F1/F2 修正后的排期）

| 阶段 | 任务块 | 依赖 | 估时（单人等效，非承诺） |
|---|---|---|---|
| **P0-0** | **组件边界先行**：`ports.ts`、`createChatController`、`TaoAiChat` 空壳与槽位、目录与 import 边界检查、空宿主测试页（§6.0 退出条件）；开工前 rebase 并列出与 `feat/development-orchestrator` 的冲突面 | 无 | 0.5 周 |
| P0-1 | Rust：`deepseek_app/{types,messages,context}` + 事件通道 + 错误分类 | 接口冻结（§6、主设计 §7.3） | 1.0–1.5 周 |
| P0-2 | 前端：`TaoAiChat` 内的状态机 S0–S9、Composer 注入、thinking/正文块 | P0-0、P0-1 事件 schema | 1.5 周 |
| P0-3 | 分支树 + 编辑/重新生成（F2 新增） | P0-2 | 0.5 周 |
| **P0-H** | **Home 宿主**：`TaoHomeHost`、绑定栏、**底部快捷行 + 历史浮层**（§3.7）、WSL 条件显示、**移除 Home 的 LAN 聊天入口及对应测试**、首次发送键提示（D-16）、沿用 Key（D-14） | P0-0 | 1.0 周 |
| P1-0 | **写入时脱敏 + 历史迁移 + 误伤率评估（F1 前移）** | 无，可与 P0 并行 | 0.5–1 周 |
| P1-1 | 搜索/读链接/引用/来源栏、文件、语音、标题、导入导出、用量行 | P0 | 2.5–3 周 |
| **P1-2** | **`@` 绑定上下文 + 本地检索（Tao Search）**，拆分如下 | P1-0 | 合计 2.5–3 周 |
| P2-1 | 动作协议（D-13）+ 动作卡 + 审计 | P1-2 | 2 周 |
| P2-2 | 五个内置工作流 + 计划/步骤 UI + 预算 | P2-1 | 2–3 周 |
| P2-3 | 记忆/SOUL/技能、安全中心、生成物侧栏 | P2-1 | 1.5–2 周 |

### P1-2 子任务（来自 §13 的索引表结构与触发规则）

| 子任务 | 内容 | 依赖 | 完成标准 | 估时 |
|---|---|---|---|---|
| P1-2a **索引库与表结构** | 新建独立 `tao_index.db`：`doc` 主表、`doc_fts`（`fts5`，`trigram`）、`doc_src_ts` 索引；迁移版本号；SQLite ≥ 3.34 运行时自检（不满足则本地检索不可开启并显式提示） | P1-0 | 空库创建 / 升级 / 自检失败三条路径单测；索引文件缺失可自动重建 | 0.3 周 |
| P1-2b **写入点同步** | 各源写入脱敏后 upsert（命令 / SQL 历史、笔记、线程、会话配置、保存的查询）；`UNIQUE(source, ref)` 去重；`use_count` 递增；按源开关关闭时清除该源行并重建 FTS | P1-2a | 开关关闭 1 分钟内无该源结果；同一命令重复执行只更新计数与时间 | 0.5 周 |
| P1-2c **全量重建与迁移** | “重建索引”后台任务（可继续使用、可取消）；从原库全量回灌；备份排除索引文件 | P1-2b | 删除索引后重建，条数与原库一致（E5） | 0.3 周 |
| P1-2d **查询与排序** | 解析 `source: host: since:`；trigram 查询；**不足 3 字符回退 `LIKE`**（先结构化过滤再扫描）；`bm25` + 时间衰减 + `use_count`；片段限额（5 条 / ≤800 字符 / ≤4000 token）；2 字回退时返回“已改用精确匹配”标志 | P1-2a | E1–E3；20–30 条评测集 Top-5 命中率记录入文档（决定是否做向量，§13.4） | 0.5 周 |
| P1-2e **Tao Search 面板** | `src/components/tao/search/`：Ctrl/⌘+K、类别过滤、结果列表 + 预览、键盘操作、加入上下文 / 问 Tao / 打开原记录；只依赖 `ContextPorts.search`，不依赖首页 | P1-2d、P0-0 | 原型 U1–U3 行为一致；窄屏预览收起 | 0.5 周 |
| P1-2f **模型侧触发与确认卡** | 回指词 / `@库` 触发规则（§13.3 第 5 条）；本地先检索 → 确认卡逐条勾选 → 脱敏片段注入；取消勾选的片段不进请求体；回复用绿色“本”角标 | P1-2d、P0-2 | E6；请求体单测断言；无回指词的消息不触发检索 | 0.5 周 |
| P1-2g **设置：本地资料** | 10 源开关、索引大小与条数、重建按钮、门禁提示（S1–S3 未通过则不可开）、关闭倒计时 | P1-2b | 与原型 U10 一致；门禁状态下开关不可点 | 0.3 周 |
| P1-2h **`@` 引用菜单（只读）** | `@terminal / @file / @workspace / @db / @note` 菜单与 chip；预览将发送的脱敏文本 | P0-2 | chip 点击可预览；移除后不进请求体 | 0.3 周 |

向量检索（P2，可选）不在上表：仅当 P1-2d 评测集 Top-5 < 80% 才新开任务（`sqlite-vec` + 本地嵌入 + RRF，§13.4）。

## 11. 验收清单（可直接转测试用例）

**首页与状态**
- [ ] A1 无 Key 打开首页：Composer 禁用，1 次点击进设置；保存 Key 后返回首页，Composer 可用且焦点在输入框
- [ ] A2 1366×768 下启动条与页脚始终在首屏内（§3.2）
- [ ] A3 发送一条消息：S2→S3→S5→S6 依次出现；thinking 结束 600ms 后折叠，手动展开过的不折叠
- [ ] A4 拒答：思考与正文被丢弃，只剩拒答卡；编辑重发可用
- [ ] A5 流中点停止：保留已收块，出现“继续生成”；继续后无重复文本
- [ ] A6 切换线程：后台流继续，完成后收到提醒，回到线程内容完整

**动作与预算**
- [ ] B1 “做”模式产出 `tao-action`：Rust 重新计算 level，模型声明的 `L1` 但命令命中危险模式时升为 L2
- [ ] B2 越权 target（非绑定终端/工作区外路径）被拒绝并显示“动作越界”
- [ ] B3 write_file 后“撤销”恢复原文件内容（哈希一致）
- [ ] B4 深研：计划阶段显示预计工具费区间，确认后运行中未超上界不再询问
- [ ] B5 预算 50%/80%/100% 三档表现正确，100% 后续跑不重跑已完成步骤

**安全与本地资料**
- [ ] C1 写入时脱敏：含 `AKIA…`、`ghp_…`、JWT、连接串的命令不以明文入库，`redacted=1`
- [ ] C2 迁移后设置页显示“已清理 N 条”，不显示内容
- [ ] C3 本地资料 chip 可逐条取消，取消的片段不进请求体（抓包/单测断言请求体）
- [ ] C4 请求日志与审计不含请求体/响应体
- [ ] C5 手动锁定 Vault：流立即中断；流式运行期间闲置计时不触发自动锁（D-15）
- [ ] C6 演示模式开启后首页不出现终端报错建议、真实绑定名

**底部快捷行与组件边界**
- [ ] H1 快捷行在 Composer 正下方，空态与对话态都显示；“历史”为第一项，顶栏与 rail 无历史按钮
- [ ] H2 历史浮层三个页签（Tao 对话 / 最近会话 / 最近工作区）可切换且不关闭浮层；搜索框随页签过滤；点最近会话 / 工作区在对应标签打开、不进入聊天
- [ ] H3 WSL：未就绪、无发行版、加载中、出错、不支持时**均不渲染**；就绪且有发行版才显示（沿用 `wslStatus` 与 `wslDistros`）
- [ ] H4 Home 范围内搜索不到 LAN 聊天按钮、`onOpenLanChat`、`welcome-open-lanchat`
- [ ] H5 演示模式下历史浮层不显示真实会话 / 工作区名称
- [ ] H6 `TaoAiChat` 目录内无对 `WelcomePanel` / `welcome/*` / `layouts/*` / `orchestrationStore` / 旧 `chatStore` 的 import（边界检查通过）
- [ ] H7 同一窗口挂两个宿主实例（首页 + 空宿主测试页）：各自发送、各自预算与线程状态互不影响

**回归**
- [ ] D1 旧 ChatDrawer 的现有用例全部通过；`pnpm check:refactor` 通过；新增文件均 ≤800 行
- [ ] D2 键盘：全程可仅用键盘完成发送/绑定/确认动作；焦点可见；`prefers-reduced-motion` 下无动画闪烁

---

## 13. 本地资料检索：统一的 “Tao Search”（回答“已保存的信息能否被引用和查询”）

**结论**：主设计 §5.6 已有本地检索方案（独立 `tao_index.db`，SQLite FTS5，10 个资料源），但缺三件事：用户可直接使用的**全局搜索入口**、**具体表结构与中文短词处理**、**模型何时触发检索的规则**。本节补齐。推荐方案仍是 **SQLite FTS5 为主，向量为可选增强**，不引入外部检索服务。

### 13.1 两个入口，同一个索引

| 入口 | 谁用 | 行为 | 是否花 token |
|---|---|---|---|
| **Ctrl/⌘+K 搜索面板**（原型 U1–U3） | 用户 | 本机检索，结果列表 + 预览；可“加入上下文”“问 Tao”“打开原记录” | 否 |
| **模型侧检索** | Tao | 用户发送前由本地规则判断是否需要；命中则先出**确认卡**，用户勾选后以脱敏片段随本轮发送（原型 S17） | 仅发送被勾选的片段 |

模型侧检索**不由模型自行调用**：声明联网工具时不能同时声明其它工具（见 §14），且本地资料外发必须经用户确认，所以采用“本地先检索、用户确认、再注入”，而不是 function calling。

### 13.2 索引结构（`tao_index.db`，独立文件，可重建）

```sql
CREATE TABLE doc(
  id INTEGER PRIMARY KEY, source TEXT NOT NULL,      -- cmd|sql|note|thread|session|file|...
  ref TEXT NOT NULL,                                  -- 回指原记录的 ID，用于“打开原记录”
  host TEXT, title TEXT, body_redacted TEXT NOT NULL, -- 只存脱敏后文本
  ts INTEGER NOT NULL, use_count INTEGER DEFAULT 0, redacted_n INTEGER DEFAULT 0,
  UNIQUE(source, ref));
CREATE VIRTUAL TABLE doc_fts USING fts5(title, body_redacted, content='doc', content_rowid='id', tokenize='trigram');
CREATE INDEX doc_src_ts ON doc(source, ts);
```

- 增量更新：各源写入时同步 upsert（命令/SQL 历史在写入点；笔记/线程在保存点）；设置里“重建索引”可从原库全量重建，索引文件丢失不影响数据。
- 备份默认排除该文件（可重建）。关闭某个源：删除该源行并 `INSERT INTO doc_fts(doc_fts) VALUES('rebuild')`，1 分钟内完成。

### 13.3 查询与排序

1. **解析**：支持 `source:cmd host:u80 since:7d` 结构化过滤，其余为关键词。
2. **分词策略**：中文无空格，`unicode61` 不分词，所以用 **`trigram`**（SQLite ≥ 3.34，支持中日韩子串）。**限制**：关键词不足 3 个字符时 trigram 不能命中，此时改用 `LIKE '%词%'`（先按结构化过滤收窄再扫描），界面在底栏显示“已改用精确匹配”（原型 U3）。2 字词量大且慢时再评估 bigram 分词器；P1 不做。
3. **排序**：`bm25()` 为基础分，加时间衰减与 `use_count` 权重，常用且近期的命令靠前（原型里的示例分数公式只演示趋势）。
4. **片段限额**（继承主设计）：每轮最多 5 条，每条 ≤800 字符，总计 ≤4000 token。
5. **触发规则（模型侧）**：用户消息含“上次/之前/历史/那条/我的笔记”等回指词，或消息中带 `@库`，才检索；否则不检索，避免每轮都花 token。

### 13.4 向量检索（P2，可选）

只有当 20–30 条真实问题的评测集 Top-5 命中率低于 80% 时才做：`sqlite-vec` + 本地 llama.cpp 嵌入模型，与 FTS5 结果用 RRF（倒数排名融合）合并。公开资料显示这种“FTS5 + sqlite-vec + RRF”可放进同一个 SQLite 文件，适合几十万切片以内，与本项目数据量匹配。不满足条件就不引入，避免新增依赖与体积。

### 13.5 安全与门禁（沿用 F1 / §8）

- 索引只存**脱敏后**文本；P1-0（写入时脱敏）未完成前，Tao Search 与模型侧检索都不可开启。
- 结果预览显示“已脱敏 N 处”，不显示原值。
- 空结果明确提示“本地没有找到相关资料”，不让模型编造。
- 回复里引用本地资料用绿色 `本` 角标，与联网来源蓝色角标区分。

### 13.6 验收补充

- [ ] E1 搜索 “rsync”：命令历史按使用次数与时间排序，命中词高亮，预览与原记录一致
- [ ] E2 `source:sql since:14 orders` 只返回 14 天内的 SQL 记录
- [ ] E3 搜索 “发布”（2 字）：仍有结果，且底栏提示改用精确匹配
- [ ] E4 关闭“笔记”源 1 分钟内，笔记结果不再出现，索引行清除
- [ ] E5 删除 `tao_index.db` 后重建，条数与原库一致；索引文件不在备份包内
- [ ] E6 “上次的发布流程”触发确认卡；取消勾选的片段不出现在请求体（单测断言请求体）

### 13.7 开发拆分

索引表结构、写入点、查询排序、面板、触发与确认、设置页已拆成 **P1-2a～P1-2h**，见 §10。

---

## 14. 联网调研依据（2026-11-14）

读取了 DeepSeek 官方文档（Web Tools、Build a Chatbot、Models & Pricing、2026-11-13 发布说明）的正文，确认以下与设计相关的事实；其余为搜索结果摘要，标明“未读全文”。

| 事实 | 来源 | 对设计的影响 |
|---|---|---|
| 搜索与读链接是**服务端工具**，客户端不执行；模型自行决定是否联网；`tool_choice` 不能指定它们 | Web Tools | “联网”只提供开关，不提供“强制联网” |
| **声明联网工具时不能同时声明其它工具**；自定义工具会返回 400 | Web Tools / Errors | 证实 D-13：“做”模式只能用动作提议块，不能与联网同轮并用（“做”模式联网默认关，见原型模式默认值） |
| 带联网工具的上一条 assistant 消息**不能被 continue**，必须重发上一请求 | Web Tools / Errors | S7 对联网回复显示“重新生成（将重新计费）”，不显示“继续生成” |
| 启用联网/安全校验/标题后，`temperature`、`top_p` 等由服务端决定 | Build a Chatbot | 设置页不提供采样参数 |
| 计费：搜索按**成功查询**计、读链接按**成功抓取页**计、页内查找免费；以 `usage.server_tool_use` 中 `tool_search / tool_fetch` 为准 | Web Tools / Billing | 用量行直接读 billed 字段，不自己数 |
| 价格（官方页，USD）：搜索 $0.75/千次，抓取 $0.75/千次，文件解析/OCR $0.225/千页；`deepseek-flash` 上下文 1M；**高峰时段（UTC 工作日 01–04、06–10）token 价为非高峰 2 倍** | Models & Pricing | 用量浮层显示“当前高峰/非高峰”（原型 U12）；价格仍走 `pricing.json` 带 `as_of`，不写死；货币以官方页为准（USD），人民币换算若做需标汇率日期 |
| 语音：TTS $0.45/万字符（限时 5 折），ASR $0.116/小时（限时 5 折）；默认仍用本地 Whisper | Models & Pricing | 设置页标价，默认不变 |
| 面向公众的应用必须启用安全校验并自负内容审核、备案与 AI 标识责任 | 发布说明 / Compliance | Tao 是本地个人工具，不属“面向公众提供服务”，但仍建议默认开启 `safety_check`，拒答走 S8 |
| 官方开源 chat-demo 支持导入 DeepSeek 导出的对话历史 | 发布说明 | 原型 U9 导入向导；格式以 ZIP v3 为准（**导出格式细节未读全文，开发前以官方 demo 仓库为准**） |
| SQLite FTS5：`unicode61` 不分中日韩词；`trigram` 可做子串但需 ≥3 字符 | sqlite.org/fts5 及两篇实践文（摘要） | §13.3 分词与回退 |
| FTS5 + sqlite-vec + RRF 可放在同一 SQLite 文件（摘要） | Alex Garcia 博客 | §13.4 |
| Agent 界面模式：计划清单、可折叠的工具调用行、按范围授权（“本次/不再询问”）、风险与确认强度匹配、命令面板常驻（摘要，未读全文） | aidesign.guide、cloudscape、uxpatterns.dev 等 | §15 |

**未验证项**：新旧 DeepSeek 端点是否通用同一把 Key（D-14）；`deepseek-v4-pro` 在联网工具下的行为（官方页写明 web tools 使用 `deepseek-flash`）。

---

## 15. 界面精简规则（简洁、易用、现代）

对照 v0.1 原型，v0.2 做了以下减法与统一：

1. **顶栏只留四样**：模式、绑定、搜索、更多（历史移到底部快捷行第一项）。用量胶囊仅在有消耗后出现；侧栏、演示模式、导入、记忆、设置、快捷键全部收进“更多”。
2. **Composer 工具条只留三样**：`+`（附件 / 引用 / 技能 / 工作流）、能力胶囊（显示“flash · 思考 · 联网”，点开切换），右侧麦克风与发送。原先分散的思考/联网/模型/附件按钮合并。
3. **渐进披露**：思考块、搜索步骤、来源、用量细节都默认折叠；高风险信息（费用、L2 动作、本地资料外发）默认展开并需明确确认。
4. **确认强度匹配风险**：只读查看（L1）一键确认；L2 要勾选“已确认命令内容”；清除全部历史需二次确认。本地检索不花钱不外发，所以不弹确认；外发前才弹。
5. **按范围授权（后续可选）**：动作卡可加“本会话内同类只读命令不再询问”，**仅限 L1 只读**，不适用于写文件、改数据；默认关闭，需在设置打开。本版原型不做，列入 P2 评估。
6. **命令面板常驻**：Ctrl/⌘+K 在任何位置打开；`/` 技能、`@` 引用是输入框内的第二、第三入口，三者互不重复。
7. **一次性提示**：发送键提示在首次进入首页显示，点“知道了”后消失，不改变设置（D-16）。
8. **窄屏**：搜索按钮收为图标，侧栏变覆盖层，底部快捷行可横向滚动，历史浮层限高并可滚动，设置导航改为横向。
9. **一个动作只有一个入口**：历史只在底部快捷行；设置只在“更多”与 rail；LAN 聊天不再出现在 Home。

---

## 16. 原型 v0.3 说明

`docs-feature/tao-home-prototype.html`（单文件，离线可开，模拟数据，无网络请求）。

- 顶部“状态与界面”菜单共 **34 项**：S0–S17、U1–U14（含 U4b / U4c）。
- **v0.3 相对 v0.2 的变化**：
  - **底部快捷行**位于输入框正下方，空态与对话态都在；**历史**为第一项，点开向上的浮层，含 Tao 对话 / 最近会话 / 最近工作区三页签、搜索、新对话、恢复上次会话（U4 / U4b / U4c）。
  - 顶栏与左侧 rail 的历史按钮已删除；原“最近”条与页脚“恢复上次会话”并入历史浮层。
  - **WSL**：顶部“系统有 WSL”开关，取消勾选后快捷行不渲染 WSL（U13）。
  - **LAN 聊天**：按钮与相关界面已全部移除。
  - **宿主切换**：顶部“宿主”下拉切到“开发 Agent（示意）”（或 U14），同一个聊天组件只换绑定栏（项目 / 分支）、模式标签、侧栏页签并隐藏快捷行。这是**槽位演示**，不代表 `feat/development-orchestrator` 的界面设计。
- 保留 v0.2 的全部交互：Tao Search、本地资料确认卡、编辑重发与分支、语音、`+` 菜单、能力菜单、工作流库、导入向导、设置各页、用量浮层。
- 已用无头浏览器遍历全部 34 个状态，并跑了实时问答、本地资料确认、编辑重发、Ctrl+K 搜索、工作流菜单、历史浮层页签切换与选线程、WSL 开关、宿主切换，**无页面错误**。原型只证明版式与交互，不证明 API 行为。

---

## 17. 待确认项

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| Q-1 | LAN 聊天是否**整体下线**：本设计只删 Home 入口；`ToolsPanel`、`ControlBar`、菜单与命令、`components/lanchat/`、三个 store 与后端仍在 | 范围决定：仅清 Home 入口约 0.5 天，整体下线是一次独立的删除任务 | 先做 Home 入口（已含在 P0-H），整体下线另开任务并先确认没有其他依赖 |
| Q-2 | 与 `feat/development-orchestrator` 的对接接口 | §6.0 是 Tao 单方约束；该分支的 `llm/*` 抽取、`MainLayoutView` 与 i18n 改动与本设计的落点相邻 | P0-0 开工前先 rebase 并列冲突面，再与该分支作者核对槽位与端口 |
