# ADR 2026-11-14: Tao Home — 融合 DeepSeek chat-demo，把首页改造成个人 AI Agent（Tao）

## Status

Accepted（设计稿，非实现记录；完整设计见 `docs-feature/tao-home-design.md` v1.3，2026-11-14）。

---

## 1. Context

Taomni 是本地优先的 AI 原生远程工作台（Tauri 2 桌面应用），首页现在是一个启动器（终端 / 会话 / 邮件 / 历史入口），AI 能力在抽屉里的 tao-chat（`ChatDrawer` + `chat_stream` / `chat_send`，OpenAI 兼容协议调 `deepseek-chat`）。2026-11-13 DeepSeek 发布全家桶应用 API 并开源 chat-demo：浏览器直连 API 即可复刻 DeepSeek App 体验，核心是 Anthropic 兼容 Messages API + 服务端工具（搜索、读链接）+ Files API + ASR/TTS。

目标：把 chat-demo 的能力融进 Taomni，在首页实现 chat 功能，但首页不是纯聊天，而是一个名为 Tao（Develop Buddy）的个人 AI Agent；DeepSeek 全家桶 API 作为第一个 VIP。参考 Hermes / WorkBuddy / Muse / Grok / OpenAI 助手。

## 2. Decision

### 2.1 双轨并行，现有 tao-chat 与 API 调用形式冻结

- 现有 tao-chat（ChatDrawer、chatStore、`chat_stream` / `chat_send`、OpenAI 兼容 `deepseek-chat`）**不动**，新轨道 provider id 为 `deepseek-app`，走 Anthropic 兼容 Messages API + 服务端工具。
- 请求走 Rust 后端（Key 进 Vault，不走前端 fetch）；首页改造成 Tao Home（居中 Composer + 问 / 做 / 深研三档 + 工作区 / 终端 / 数据库绑定 + 建议 + 紧凑启动区）。

### 2.2 默认模型与费用确认

- 默认模型 `deepseek-flash`，深研时用户可手动切 `deepseek-v4-pro`。
- 单轮工具费超 0.5 元先确认（可配，0 表示每次都确认）；同一轮内累计工具费过线时只问一次，确认是确认、不是上限。

### 2.3 本地资料检索：混合检索，FTS5 为主、向量为配菜

- Tao 可检索 Taomni 本地保存的资料：会话配置、命令历史、SQL 历史与保存的查询、文件快照、笔记、聊天线程、常用工具、习惯画像（聚合计数）。
- 独立索引库 `tao_index.db`（SQLite FTS5，脱敏后文本 + 元数据）；P1 只做结构化过滤 + FTS5（trigram，复用邮件搜索先例）；P2 是否加向量由 20–30 条真实问题的评测集决定，FTS5 的 Top-5 命中率 ≥80% 就不加；若加，用同一库 + sqlite-vec，embedding 走本地 `llama.cpp` sidecar，全程离线。不用独立向量库、不调云端 embedding。
- 邮件正文、文件快照内容、语音转写默认不进索引；检索结果是数据不是指令，注入模式丢弃并审计。

### 2.4 敏感数据安全（全文最重要的一节）

- 现状缺口（已核查代码）：主 SQLite 是明文（rusqlite，无 SQLCipher），只有 Vault 条目加密；`history_append` 存原始命令（仅 trim），脱敏只发生在 LLM 发送时（`chat/redact.rs`，仅 5 条正则）。
- 分层防御：写入时脱敏（扩展模式 + 用户自定义规则 + 一次性迁移）、列级 / 新表只存脱敏文本、Vault 管 Key（默认 15 分钟闲置自动锁）、出口 allowlist（默认只放 `api.deepseek.com`）、索引时与发送时双重脱敏、注入防御、审计日志 `tao_audit` + 设置页“安全中心”。S1–S3 任一项不通过，本地检索不上线。

### 2.5 多轮处理：内置工作流，不让用户配置；工具调用次数不限

- 工作流要做、要能多轮处理，但内置：Rust 侧注册表，随应用发版；P2 先内置深研、代码 review、SQL 排查、故障排查、文件整理五个模板；运行时用户可确认 / 跳过 / 取消步骤，不能改模板、不能存自己的工作流。不做可视化 DAG 编排器。
- 工具调用次数不限；每轮总 token 预算默认 10M（输入 + 输出累计），50% / 80% 提示，到预算停下并可提高预算续跑；账号级预算是最后一道。较松是故意的，LLM 账户本身有预算控制。

### 2.6 其它已决策项（见设计文档 §16）

历史导入只导非图片附件元数据；语音默认仍本地 Whisper；块存储用新表 `ds_app_blocks`，旧 `ChatMessage.content` 仍存纯文本；KaTeX 的 P0 纯文本回落，P1 再评估；“交给 CC / Codex 做”主入口在每条回复下方按钮；竞品名单澄清 muse = Meta Muse（v1.0 误加的 Anthropic Claude 参考行已删除）。

## 3. Consequences

- **正向**：首页从启动器变成 Agent 入口，问 / 做 / 深研三档覆盖从问答到多步任务；旧轨道零回归风险；本地检索与安全设计先行，避免“能翻本地资料但先泄密”。
- **负向 / 成本**：新轨道是一套独立实现（`deepseek_app/` Rust 模块 + `taoHome` 前端 store + `ds_app_blocks` 等表），P0–P2 约 9–13 周（单人全职等效，估算非承诺）；Messages API 没有客户端 function calling，“做”模式的本地工具循环需另行决策（走 OpenAI 兼容 Chat Completions 加 tools，或模型输出结构化动作提议再由 Rust 执行）。
- **未验证**：本文是设计稿，未在本地运行 Taomni / chat-demo，未实际调用 DeepSeek Messages / Files / ASR / TTS；chat-demo 的工具价格与 deepseek-flash 上下文说法以官方定价页为准。

## 4. References

- 设计文档：`docs-feature/tao-home-design.md`（v1.3，2026-11-14）
- 调研报告：`deepseek-chat-demo-research-2026-11-14.md`（未入仓，见原作者工作区）
- 上游：`deepseek-ai/chat-demo`（`v0.1.1`，HEAD `5d5dd75`）；DeepSeek API Docs 更新日志 2026-11-13
