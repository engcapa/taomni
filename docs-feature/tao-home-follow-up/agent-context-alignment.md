# Tao Home 三模式与本地上下文补强

来源：`../tao-home-design.md` §5.3、§5.6、§9.4、§11；2026-11-16 用户要求。基线 `9d9b99944`。状态：开发中，真机验收待执行。

## 已确认的行为与决定

- DEC-AC01（用户已定）：保留“问 / 做 / 深研”三个内置模式。问负责解释与只读资料获取；做提出可审核动作，逐项确认后执行；深研按计划、采集、交叉核对、报告推进，可以取消。不能把三个开关视为三种 agent 能力验收。
- DEC-AC02（用户已定）：当前商业验证用 Settings 已有的 `opencode-go`、`deepseek-v4.1-flash`、thinking effort `max`，总测试预算上限 50M token；停止 DeepSeek 直连商业请求。保留旧 provider 和历史协议兼容，旧 tao-chat 不随本次重写。
- DEC-AC03（沿用原设计）：理解全部功能和会话类型，以受控检索获取存储资料；不等于发送所有数据。凭据、Vault/MFA 秘密、远端数据行、LAN 他人消息不进入索引。邮件、文件内容、语音默认关闭；工作区文件只允许显式绑定范围。来源关闭、删除、脱敏和注入阻断必须生效。
- DEC-AC04（agent 自决，沿用已有 UI）：复用现有 Search、来源开关、预览/移除 chip 和动作卡；不再新增第四种模式或另一个入口。功能目录为只读能力说明，不把尚无执行器的功能冒充可自动执行的工具。
- DEC-AC05（用户已定，2026-11-16）：AI 回复及结果不按固定措辞或精确文本验收。用例侧重流程、工作流组合和分支，包括成功、拒绝、失败、取消、恢复和跨线程；真实文件、退出状态、动作权限与隔离仍断言可观察结果。保留旧严格用例的历史失败，不改写既有证据。
- DEC-AC06（用户已定，2026-11-16）：做模式覆盖开发、测试、反馈失败、修复、补功能的多轮闭环。复杂编码显式交给现有 CC / Codex / ACP，Tao 保存目标和执行上下文、调度原有线程，并承接可核对的结果；不新增另一套编码执行器或绕开原有权限。

## 基线代码核对

| 能力 | 当前事实 | 缺口 |
|---|---|---|
| 三模式 | controller 切换思考/联网；request 的 system 各一句提示 | 问仍可解析动作；深研计划没有绑定实际执行阶段 |
| 本地搜索 | 原生 SearchPanel 直接调用 `deepseek_app_search`，FTS 覆盖七类资料 | 来源按钮使用单数、索引用复数；`since:14d` 与后端日期格式不一致；FTS 把整句当短语；会话缺协议、端口、用户、分组；Tao 把整个 snapshot 当正文 |
| 提问上下文 | 显式 chips 经 Rust 脱敏限量，绑定 ID 本身不发送内容 | 未自动提供会话/功能能力说明和相关资料候选；800 字符与前端 8000 字符不一致 |
| 其他存储 | SQL 查询、笔记、旧/新对话已有 SELECT 路径 | 书签、文件快照、邮件元数据/正文、语音、memory/skills 缺明确连接器和开关 |
| 工作流 | 五类定义、运行和步骤表已存在 | advance 仅把状态改 completed，无真实步骤结果；不得据此声称工作流执行成功 |
| OpenCode | 全局 LLM 设置已支持 Go、多协议和共享代理 | Home 固定 DeepSeek provider、模型、Files/SSE 协议；没有 provider/effort 的线程隔离 |

## 行为契约与任务

| ID | 行为/改动职责 | 验证 |
|---|---|---|
| AC-CTX01 / TASK-CTX01 | 用统一来源 ID（兼容旧单数查询别名）、日期/相对天数、关键词召回；所有已保存 session 按协议、分组、端口和用户检索；不读取 options 中凭据 | Rust 基于真实表 fixture，检索非最近 session；来源过滤/关闭/删除；中文短词、自然问句、转义、时间 |
| AC-CTX02 / TASK-CTX02 | 独立只读连接器覆盖设计中的主库、notes、local-history、mail 和能力目录；缺表视为空，列/数据库错误显式报告；已脱敏片段和元数据入索引 | 各源 fixture 和开关；不索引整段 snapshot/JSON、Vault 引用、秘密或恶意指令；内容默认关闭 |
| AC-CTX03 / TASK-CTX03 | 每次发送的上下文有来源/ID/时间；最多五条、每条800字符；绑定摘要/检索候选可预览移除；全功能目录说明真实入口与执行限制 | mounted 源名称、预览、排除、异步取消；native 搜索→引用→提问→来源，跨多个 session/功能 |
| AC-MODE01 / TASK-MODE01 | 问只读；做只提出带完整 schema 的动作、等待确认；拒绝不写，失败可恢复，Undo 可用状态来自持久备份 | controller/request units；native 组合：问→做→拒绝→重提→确认→撤销、跨线程 |
| AC-MODE02 / TASK-MODE02 | 深研展示实际计划/进度；联网不可用时说明缺少服务；不能以预填来源或手工 advance 冒充搜索完成；Stop/预算阻断后保留已完成阶段 | workflow 状态机/原生多轮流转，取消/继续/失败分支和报告导出 |
| AC-GO01 / TASK-GO01 | provider/model/effort 随请求和线程持久化，旧数据默认 DeepSeek；复用 Vault/共享代理，无代理显式绕过环境代理；OpenCode 用真实 chat 协议及 usage | Rust body/SSE/终止/协议/代理契约；UI 保存→新线程→流式→Stop/继续/重新生成→冷重启 |
| AC-GO02 / TASK-GO02 | OpenCode 图片用实际图像载荷，文档本地提取；附件 ID 按 provider 隔离、校验变更、支持移除/删除/失败恢复 | native 图片/文档真实选择及问答流程，不让脚本代写模型结果；无 DeepSeek Key 仍完成 |
| AC-DEV01 / TASK-DEV01 | 隔离 Python/TS 工程，模型设计→提议写入→确认→测试→反馈失败→修复→加功能；验证全过程和分支 | native + 真实 Go；实际磁盘与运行状态，不断言回复逐字相同 |
| AC-DEV02 / TASK-DEV02 | 显式预览交接给现有 CC / Codex / ACP，保留原目标、已发送历史、已选资料及执行结果；记录目标线程，结果带回后显式发送 | 三种入口组件队列测试；native ACP 子进程、取消不启动、结果落库与返回 chip；商业 CC/Codex 推理另列未验证 |

所有任务依赖保持旧 `deepseek_app_*` IPC、消息持久化与生命周期，provider 差异放专有模块，不改旧 `Llm` 流式契约。原检索在主库的 FTS 全量快照重建保留为兼容实现；独立增量 `tao_index.db` 和可选向量属于后续边界，未完成时不得标记原设计全部对齐。

## 验证与证据边界

- Windows 当前端：先 focused Vitest/Rust/Python units；稳定后集中 QA release，一次跑相关 native 和全部22项 crash。browser 跑相关 UI 与全部18项 crash。不能用 stub 或直接 API 探测代替 Tao Home native。
- Linux/macOS：提交稳定输入后用 `qa-ui-auto-platforms.yml`，包含适用 crash 与不依赖本地商业 Key 的相关流程；核对 raw receipts 和 source/build 身份。商业 Key 不上传 GitHub。
- 旧商业 TC005/011/013、014–023 用 Go 重跑；需要将 provider 特有 server search/files 断言改为能力感知的同等流程，未提供真实搜索服务时如实记录缺口，不伪造通过。
- 401/403 只有确认是凭据失效才能按用户授权记 credential-invalid；网络/代理/Cloudflare WAF 不属于此例外。
- 2026-11-16 最小协议探测：Go `deepseek-v4.1-flash` 接受 `reasoning_effort:max` 和 thinking，返回200、38 tokens；默认 Python UA 遇 Cloudflare1010，使用 Taomni UA 后正常。不代表已通过 native 或复杂推理验证。

本批实现、实际缺陷、具名用例与持续更新回执见 [开发闭环验证记录](verification-agent-loop-2026-11-16.md)。阶段提交允许保留未执行项，不能将其标为通过。
