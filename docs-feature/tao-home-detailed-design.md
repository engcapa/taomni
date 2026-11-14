# Tao Home 细化设计（v0.1）：交互、状态、数据与安全落地

> 状态：设计稿（未实现）。承接 `docs-feature/tao-home-design.md`（v1.3，以下称“主设计”）与 `claudedocs/adr-tao-home-deepseek-app.md`。
> 配套高保真原型：`docs-feature/tao-home-prototype.html`（单文件，浏览器直接打开；顶部“状态”菜单可跳转到每个状态）。
> 本文不重复主设计已决策的内容（§16 决策 1–12 全部继承），只做三件事：**复核（§1）、细化（§2–§9）、给出开发可拆分的验收口径（§10–§11）**。

## 0. 文档边界

| 项 | 内容 |
|---|---|
| 继承（不再讨论） | 双轨并行、`deepseek-app` 轨道、问/做/深研三档、绑定栏、FTS5 为主、8 层安全防御、内置工作流、每轮 10M token 预算、工具次数不限 |
| 本文新增 | ① 对主设计的 10 条复核发现与处理建议；② 首页完整状态机（17 个状态）；③ 逐区域交互规格；④ “做”模式动作协议提案；⑤ 费用与预算的计算与展示口径；⑥ 前后端模块切分与 store 形状；⑦ 可测试验收清单 |
| 需用户决策的新增项 | 仅 §1 中标 **【需决策】** 的 4 项（D-13～D-16），其余为复核勘误或可直接执行的细化 |
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
| F7 | **旧 `deepseek` Key 已在 Vault 时，首页仍显示“无 Key”会让老用户困惑** | 主设计 §0.3“无 Key 时 1 步可达设置” | 老用户多一次复制粘贴 | **【需决策】D-14**：检测到已有 `deepseek` Key 时提示“沿用此 Key”，仅复制 Vault 引用（`vault:<id>`），不复制明文。**未验证**两个端点是否接受同一把 Key，需先用测试连接确认 |
| F8 | “开发者模式的 Vault 15 分钟闲置自动锁”会在**长深研任务中途**锁定并中断流（主设计第 3 层：锁定即中断流） | 主设计 §11.1.4 第 3 层 | 一次 20 分钟的深研被自动锁杀掉 | **【需决策】D-15**：流式任务运行期间视为“活跃”，闲置计时暂停；仅用户锁屏/手动锁定才中断。推荐采纳 |
| F9 | 建议卡片来自“最近终端最后一条报错”，该内容会在首页明文显示，且可能含凭据 | 主设计 §6.5 | 屏幕共享/截图时泄露 | **细化**：建议文本过同一套 `redact()` 后再显示；增加“演示模式”开关（隐藏建议与最近列表，§3.6） |
| F10 | 旧 `chat_send_shortcut`（Ctrl+Enter）与首页大输入框的默认习惯冲突（ChatGPT 系默认 Enter 发送） | 主设计 §6.3 | 新用户首次回车换行，误以为卡住 | **【需决策】D-16**：沿用用户已有设置；首次进入首页若设置为默认值，Composer 下方显示一次性小字提示当前发送键，可一键切换，不改默认 |

决策项汇总（请在主设计 §16 追加 13–16 行）：

| # | 事项 | 推荐 |
|---|---|---|
| D-13 | “做”模式工具协议 | 动作提议块（§5） |
| D-14 | 沿用旧 DeepSeek Key | 采纳，先验证同 Key 可用 |
| D-15 | 流式期间暂停 Vault 闲置计时 | 采纳 |
| D-16 | 发送键 | 沿用现有设置 + 一次性提示 |

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
| A 顶栏 | 模式切换（问/做/深研）· 绑定栏 · 右侧：线程标题 / 用量 / 设置 | 显示 | 显示，下方附 1px 分隔 |
| B 主舞台 | 空态：问候 + Composer（垂直 38%）；对话态：消息流 | 居中 | 滚动 |
| C 建议行 | 本地计算的建议卡片（最多 4 张） | 3 行布局 | 收为 1 行横向滚动 |
| D 启动条 | 本地终端 / WSL / 新会话 / LAN 聊天 / 新工作区 / 更多 | 紧凑图标条 | 隐藏（rail 可达） |
| E 最近 | 最近 5 个会话/工作区（横向 chip） | 显示 | 隐藏 |
| F 右侧栏 | 来源 / 文件 / 生成物 / 工作流 | 隐藏 | 有内容才出现，宽 340px，可收起 |
| G 页脚 | 版本 + 品牌 T + 恢复上次会话（有才显示） | 小字 | 隐藏 |

### 3.2 垂直预算（防止启动区被挤出首屏）

以内容区可用高度 H（1366×768 下约 640px）为基准：

| 区块 | 高度 | 规则 |
|---|---|---|
| 顶栏 | 44px | 固定 |
| 问候 | 64px | H < 600 时隐藏副标题，H < 520 时整块隐藏 |
| Composer（单行） | 96px | 可随输入增高到 220px 后内部滚动 |
| 建议行 | 76px | H < 600 时只显示 2 张 |
| 启动条 | 72px | **永远保留**，H < 520 时降为纯图标 |
| 最近 | 56px | H < 600 时隐藏，进 rail |
| 页脚 | 28px | 固定 |

空态下 Composer 的目标位置是“可用高度的 38%”，但不得使上述任何**永远保留**项落到视口外：布局用 CSS Grid `grid-template-rows: auto minmax(0,1fr) auto`，Composer 区用 `align-self: center` + `max-height`，而不是绝对定位。

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

设置里的开关，也可在顶栏菜单一键切换：隐藏建议行、最近列表、绑定名称（显示为“终端 1”），Composer 上方的本地资料 chip 只显示类别。默认关。

---

## 4. 首页状态机（17 个状态）

原型“状态”菜单与此表一一对应。

| # | 状态 | 触发 | 首页表现 | 出口 |
|---|---|---|---|---|
| S0 | 无 Key | 未配置 Key | Composer 禁用；中央卡片“连接 DeepSeek · 全家桶”，主按钮“去设置”，次按钮“沿用已有 Key”（F7，条件出现） | 保存 Key 并通过测试连接 → S1 |
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

## 6. 数据与前后端切分

### 6.1 前端模块（只新增，不改 `chatStore`）

```text
src/components/tao/home/
  TaoHomePanel.tsx          组合层 ≤150 行
  TaoTopBar.tsx             模式 + 绑定 + 用量
  BindingBar.tsx / BindingPopover.tsx
  TaoComposer.tsx           包装现有 chat/Composer 壳，注入新轨道能力
  MessageList.tsx / blocks/{Thinking,SearchSteps,Text,Sources,ActionCard,UsageLine}.tsx
  SidePanel.tsx             来源 / 文件 / 生成物 / 工作流
  SuggestionRow.tsx / LaunchStrip.tsx / RecentStrip.tsx
  states/{NoKeyCard,ErrorCard,RefusalCard,BudgetCard,VaultLockedMask}.tsx
src/stores/taoHome/
  threads.ts  sending.ts  blocks.ts  budget.ts  binding.ts  suggestions.ts  workflow.ts
```

每个文件 ≤800 行（AGENTS.md 上限），目标 ≤300 行；`LaunchStrip` / `RecentStrip` 直接复用 `WelcomePanel` 子组件，不复制。

### 6.2 新表（补充 F2：分支）

主设计 §8.2 的 `ds_app_blocks` 保持不变，新增消息级表承载分支与父子关系：

| 表 | 关键列 | 说明 |
|---|---|---|
| `ds_app_messages` | `id`, `thread_id`, `parent_id`, `role`, `selected_child_id`, `ds_request_id`, `model`, `stop_reason`, `created_at` | 分支树；旧 `chat_messages` 不动 |
| `ds_app_blocks` | `id`, `message_id`, `idx`, `type`, `text_redacted`, `meta_json`, `started_at`, `ended_at` | thinking 耗时取起止时间 |
| `ds_app_usage` | `message_id`, `input_tokens`, `output_tokens`, `search_calls`, `fetch_calls`, `est_cost_cny`, `price_as_of` | 金额可空 |
| `tao_workflow_runs` / `_steps` | 见主设计 §9.4.4 | 状态机 |
| `tao_audit` | 见主设计 §11.1.4 第 7 层 | P2 |

线程元数据沿用旧 `chat_threads` 并新增 `tao_binding`（JSON）、`mode`、`thinking_on`、`web_on`、`model` 列；`provider_id='deepseek-app'`。

### 6.3 `taoHome` store 形状（节选）

```ts
interface TaoHomeState {
  activeThreadId: string | null;
  mode: "ask" | "do" | "research";
  binding: { workspaceId?: string; terminalId?: string; dbConnectionId?: string };
  composer: { text: string; chips: ContextChip[]; attachments: Attachment[];
              thinking: boolean; web: boolean; model: "deepseek-flash" | "deepseek-v4-pro" };
  runtime: Record<ThreadId, { phase: Phase; budget: BudgetMeter; pendingAction?: ActionProposal }>;
  ui: { sidePanel: "sources" | "files" | "artifacts" | "workflow" | null; demoMode: boolean };
}
type Phase = "idle"|"sending"|"thinking"|"searching"|"streaming"|"stopped"
           |"refusal"|"error"|"awaiting_action"|"plan_pending"|"running_workflow"
           |"budget_halt"|"vault_locked";
```

`runtime` 按线程隔离，保证“后台线程继续跑”不污染当前线程。

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
| 连接 | Key（Vault 引用）、测试连接、沿用旧 Key（D-14）、出口 allowlist 只读展示 | P0 |
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
| P0-1 | Rust：`deepseek_app/{types,messages,context}` + 事件通道 + 错误分类 | 接口冻结（§6、主设计 §7.3） | 1.0–1.5 周 |
| P0-2 | 前端：`TaoHomePanel` 骨架、状态机 S0–S9、Composer 注入、thinking/正文块 | P0-1 事件 schema | 1.5 周 |
| P0-3 | 分支树 + 编辑/重新生成（F2 新增） | P0-2 | 0.5 周 |
| P1-0 | **写入时脱敏 + 历史迁移 + 误伤率评估（F1 前移）** | 无，可与 P0 并行 | 0.5–1 周 |
| P1-1 | 搜索/读链接/引用/来源栏、文件、语音、标题、导入导出、用量行 | P0 | 2.5–3 周 |
| P1-2 | `@` 绑定上下文（只读）+ 本地检索 FTS5 + 来源 chip + 脱敏计数 | P1-0 | 1.5–2 周 |
| P2-1 | 动作协议（D-13）+ 动作卡 + 审计 | P1-2 | 2 周 |
| P2-2 | 五个内置工作流 + 计划/步骤 UI + 预算 | P2-1 | 2–3 周 |
| P2-3 | 记忆/SOUL/技能、安全中心、生成物侧栏 | P2-1 | 1.5–2 周 |

---

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

**回归**
- [ ] D1 旧 ChatDrawer 的现有用例全部通过；`pnpm check:refactor` 通过；新增文件均 ≤800 行
- [ ] D2 键盘：全程可仅用键盘完成发送/绑定/确认动作；焦点可见；`prefers-reduced-motion` 下无动画闪烁

---

## 12. 原型说明

`docs-feature/tao-home-prototype.html` 是 Taomni 外壳内的 Tao Home 高保真交互原型（纯 HTML/CSS/JS，无外部依赖，离线可开）：

- 外壳：标题栏、主 rail、标签栏（Home 标签）、状态栏、右缘 Tao Ribbon；浅色/暗色切换，颜色取自 Taomni 令牌。
- 交互：模式切换、绑定浮层、建议填入、`@` 菜单、思考/联网/模型开关、模拟流式回复（thinking→搜索→引用→用量）、动作确认卡（做）、深研计划与步骤、右栏来源/文件/生成物/工作流、预算胶囊、设置与安全中心、演示模式。
- “状态”菜单可直接跳到 S0–S16 中的典型状态用于评审；所有数据为**模拟数据**，不发任何网络请求。
- 原型只证明版式与交互，不证明 API 行为；DeepSeek 协议相关细节仍以主设计与官方文档为准。
