# CC → Agent 编排中心:演进计划

**状态**: 实现中 — Phase 0 ✅ / Phase 1+2 ✅(端到端打通)/ Phase 3–5 ☐ 待办
**日期**: 2026-06-21(进度更新同日)
**目标**: 把当前"沙箱聊天 provider"式的 Claude Code(CC)集成,演进为 Taomni 的 agent 中心调度编排中心。终态为多 agent 调度中心(C),本轮交付 A 全量 + B 最小版。

**关联代码**:
- `src-tauri/src/agent/cc_bridge/`(process.rs / commands.rs / config.rs / tools_mcp.rs / permissions_mcp.rs)
- `src-tauri/src/agent/mcp_server.rs`、`src-tauri/src/agent/safety.rs`
- `src-tauri/src/chat/mod.rs`、`src/stores/chatStore.ts`、`src/components/chat/MessageBubble.tsx`、`src/components/agent/ActionCard.tsx`

---

## 〇、进度总览(截至 2026-06-21)

| 阶段 | 状态 | 交付 / 位置 |
|---|---|---|
| **Phase 0** 止血 + 地基 | ✅ 已完成(在 main) | `safety.rs` 工具名映射、`process.rs` 空闲超时 + kill/respawn、CC 分支接 `terminal_context` |
| **Phase 1+2** 有状态工具 + HITL | ✅ 已完成,**端到端打通** | rmcp in-app MCP 服务器 `cc_bridge/mcp_http.rs`(8 个有状态工具)+ `permission_prompt` HITL + 挂起 oneshot 回填 + per-thread token/会话作用域。基础提交 `44f7169`/`ed51c67`(已并入 main);本轮 `5305df2`/`1c78791` 修好 HITL 全链路(见下方「本轮修复」) |
| **Phase 3** cwd + 模型 + 渲染保真 | ☐ 待办 | `--add-dir`、per-thread 模型/思考预算、结构化工具卡 |
| **Phase 4** 编排者 B 最小版 | ☐ 待办 | `dispatch_subtask` |
| **Phase 5** 调度中心 C | ☐ 待办(仅设计文档) | — |

**本轮修复(`5305df2` + `1c78791`,使 HITL 真正可用):**
- `permission_prompt` 读 CC 的 `input` 字段(原只认 `tool_input` → 退化成 `null`,卡片崩溃 + 回 CC `updatedInput:null`)。
- 工具名 `mcp__taomni__<tool>` 归一化后再评级,写动作才会弹卡。
- emit 用 camelCase `callId/threadId`(tauri emit 不转大小写)。
- 从 token scope 回填 `session_id`;`run_in_terminal` 经终端 registry 命中正确后端会话;接通 `read_terminal_tail` 让 CC 读真实远端回显。
- 监听器异步注册加 `disposed` 守卫(修命令双发);ActionCard 改不透明底(修与聊天文本重叠)。

**实现与原计划的偏差(已确认,影响后续):**
- rmcp 服务器落在**新文件** `cc_bridge/mcp_http.rs`,而非重写 `agent/mcp_server.rs`。旧的自定义 JSON-RPC `mcp_server.rs` 与 stdio `--mcp-server` 分支已于本轮全部删除(见下「清理债」✅),活动路径只剩 `mcp_http.rs`。
- 实际暴露 **8** 个有状态工具(`list_sessions`/`search_history`/`read_terminal_tail`/`run_in_terminal`/`switch_tab`/`open_session_editor`/`sftp_upload`/`save_as_runbook`),非原文「11 个」。

**讨论结论(2026-06-21,影响 Phase 3 取舍,尚未落地):**
- CC 不喂环境信息也基本能给对命令或靠「跑→`read_terminal_tail` 读回显→调整」闭环自纠 → **「环境事实卡」降级为可选优化,不做**。
- 闭环修不掉的两点才值得做:① **执行目标消歧**(CC 偶尔误用本地 Bash 而非远端 `run_in_terminal`,信号不报错、闭环收敛不了);② **只读命令确认降噪**(每条 `run_in_terminal` 都弹卡,调整循环里点击摩擦大)。
- `--add-dir` 只对**本地工作区线程**有意义;远端 SSH 线程文件操作走 `run_in_terminal`/`sftp`,`--add-dir` 基本 N/A。CC 子进程当前未设 `current_dir`(继承 Taomni 工作目录,无意义)。

---

## 一、现状与认知修正

### 1.1 现状本质
当前桥接 = 把 CC 当成跑在沙箱里的聊天 provider:
- 每个 chat thread 一个 `claude` 子进程,参数固定(`process.rs:53-65` + `chat/mod.rs:471-482`)。
- 前端 `chatStore.ts:278` 只 invoke `chat_stream`;provider=`claude-code` 走 CC 分支(`chat/mod.rs:403`)。`cc_send_message`/`cc_stream_message`(支持 `--add-dir` 的更好通路)前端零调用,睡眠态。
- 回给 CC 的 Taomni 工具只有 4 个无状态工具(`tools_mcp.rs:143`):explain_error / web_search / web_fetch / redact_text。
- CC 看不到 SSH 终端 / SFTP / 会话 / DB,没有真实工作目录,跑完一轮等下一条消息。

### 1.2 关键认知修正(直接影响工作量)
- **C1 传输**:`mcp_server.rs` 是自定义、单请求/连接的 HTTP JSON-RPC,不是 CC 能直连的合规 MCP 传输(Streamable-HTTP/SSE,含 initialize 握手、会话 id、SSE 推送)。`rmcp` 当前不在依赖树。→ 还隔着一个真正的 MCP 传输实现。
- **C2 执行模型**:原生有状态工具大多是"发 Tauri 事件让前端执行 + 无同步返回"(`run_in_terminal` 返回哨兵 `EXECUTE:<cmd>`;`read_terminal_tail` 内容由前端经 args 传入)。CC 要同步 `tool_result` → 需"挂起调用 + oneshot 回填",先例为 `ssh_auth_responders`(MFA)。
- **C3 HITL**:现有 `[TOOL_CALL]` / ActionCard 对 CC 是装饰,点 allow 走 `agent_execute_tool`(原生路径,`MessageBubble.tsx:161`),与 CC 自身执行双重执行。真 HITL 须在后端 `permission_prompt` 拦截、阻塞、回传 allow/deny。ActionCard 已支持 allow/allow-session/deny,正好映射分级。
- **C4 cwd**:cwd 只在前端(OSC 7),后端 `ActiveTerminal` 不存 cwd。workspace 必须由前端传入。

### 1.3 现存安全 / 健壮性洞(本轮一并修)
- `safety.rs:7-34` 只拦 `run_in_terminal` / `read_terminal_tail`;CC 的 `Bash` 落到 `_ => Ok(())`,shell 黑名单对 CC 失效;deny-list 只挡文件读路径,不挡 `cat ~/.ssh/id_rsa` 这类命令。
- `process.rs:303` 超时分支只 `return Err`,不 kill / 不 respawn → 进程毒化,下一轮可能读到残留输出。
- CC 分支丢弃 `terminal_context`(只发 `clean_content`,`chat/mod.rs:511`);前端其实已发该字段。
- `mcp_server.rs` 广告 11 工具,`call_tool` 实接 3 个,其余返回 `Unknown tool`(`tools/mod.rs:99`)。

---

## 二、已锁定决策

| 决策 | 选择 | 含义 |
|---|---|---|
| **D1 传输** | 一步到位 T1(rmcp 直连) | 引入 `rmcp`,in-app 服务器做成合规 MCP-HTTP 端点,CC `.mcp.json` 直连;接受验证有状态工具价值的时间推后到 rmcp 集成完成 |
| **D2 执行模型** | 混合 | 只读类直连 AppState/DB 同步返回;副作用类经前端 + oneshot 回填(人天然在回路) |
| **D3 分级** | 自动推断 + 可手动覆盖 | thread 绑定推断默认信任级(本地目录=宽松 / 远端 SSH=严格);用户可在 thread 上手动覆盖 |
| **D4 范围** | A 全量 + B 最小版 | A 全量(直接操作 + HITL + cwd/模型保真)+ B 最小版(CC 可并行拉起子执行);C 只出设计文档 |

---

## 三、分阶段计划(每阶段一个 review gate)

### Phase 0 — 止血 + 地基(低风险,独立于 rmcp,先发) — ✅ 已完成(在 main)

**0.1 `agent/safety.rs` — 补 CC 工具名映射**
- `check_tool_call` 增分支:`Bash` → 取 `command` 跑 `shell_safety::check_blacklist`;`Read/Edit/Write/NotebookEdit` → 取路径对 `sensitive_deny_dirs()` 校验(挡命令绕过)。保留现有 `run_in_terminal`/`read_terminal_tail`。
- 扩 `is_write_tool` / `requires_confirmation` 覆盖 CC 写工具(`Bash`/`Write`/`Edit`),使分级与标注正确。
- 加单测:`Bash rm -rf /` 被拦;`Read ~/.ssh/id_rsa` 被拦。

**0.2 `agent/cc_bridge/process.rs` — 修超时毒化**
- 超时分支(~303 行)改为 kill + `needs_respawn` + `record_failure`(对齐 `!terminal_seen` 路径)。
- "逐行 120s"改为空闲超时可配(默认放宽,如 600s);因有 `--include-partial-messages`,真有活动会刷新空闲,长构建不再误杀。

**0.3 `chat/mod.rs` — CC 分支接 `terminal_context`**
- 把 redact 后的 `req.terminal_context` 拼入发给 CC 的首条消息(对齐非 CC 路径 611 行)。

→ ✅ **Review gate 0**(已通过,在 main):`cargo test` 通过 + 冒烟。

### Phase 1 + 2(捆绑)— 有状态工具 + HITL 分级 — ✅ 已完成,端到端打通

> 捆绑原因:Phase 1 让 CC 能碰真实 SSH,不带 Phase 2 的确认就是"无确认在生产机跑任意命令"的危险中间态。

**1.1 `Cargo.toml`** — 加 `rmcp`(server + streamable-http),定版本。**先做传输 spike**:验证 CC 的 `.mcp.json` `type:"http"` 能连通我们的 rmcp 服务器(T1 头号风险;不通则当场回到 review 重议 D1)。

**1.2 `agent/mcp_server.rs` — 重写为 rmcp 服务器**
- Streamable-HTTP,绑 `127.0.0.1:random` + Bearer。
- 捕获 `AppHandle` + `AppState`(`mcp_server_start` 作为 tauri command 注入,存进服务器结构)。
- 接全部 11 个工具(去门面):
  - 只读(`list_sessions`/`search_history`/`read_terminal_tail`)→ 直连 `AppState.db` / 活终端缓冲同步返回(统一用 `AppState.db`,不再开第二连接)。
  - 副作用(`run_in_terminal`/`sftp_upload`/`switch_tab`/`open_session_editor`/`save_as_runbook`)→ 发 `agent-*` 事件 + 注册挂起 oneshot,阻塞等前端回填。

**1.3 `state.rs` + 新命令 — 挂起调用注册表**
- 新增 `cc_pending_tool_calls: Arc<Mutex<HashMap<String, oneshot::Sender<ToolOutcome>>>>`(仿 `ssh_auth_responders`)。
- 新增 tauri 命令 `cc_resolve_tool_call(call_id, result)`,前端执行完副作用后回填。

**1.4 权限 + 分级(Phase 2)**
- `permission_prompt` 也由 in-app 服务器提供(持 AppHandle + 挂起表)。
- 分级策略表:thread 绑定自动推断(本地目录 / 远端 SSH);可手动覆盖,存 thread。
- 前端复用 `ActionCard`,新增 `cc_resolve_permission(call_id, decision)` 接通阻塞确认;废弃 CC 的装饰性 `[TOOL_CALL]` 双重执行路径(`MessageBubble.tsx` 不再对 CC 卡片调 `agent_execute_tool`)。

**1.5 线程 / 会话作用域(安全底线)**
- token 与 CC 进程(per-thread)一一绑定;服务器维护 `token → {thread_id, allowed_session_id}`。
- 工具调用里的 `session_id` 必须落在该 token 作用域内,跨 thread/会话直接拒。

**1.6 接线**
- `cc_bridge/config.rs::write_temp_mcp_config` → `.mcp.json` 改 `type:"http"` 指 in-app 服务器 + Authorization 头。
- `chat/mod.rs` CC spawn 前确保 in-app 服务器在跑、取 addr+token 注入 config;加 `--strict-mcp-config`(防用户 `~/.claude` MCP 绕过 permission_prompt;review 确认是否影响 skills/CLAUDE.md 加载)。
- `lib.rs` 注册 `cc_resolve_tool_call`/`cc_resolve_permission`;`main.rs` 的 stdio `--mcp-server` 分支可废弃。

→ ✅ **Review gate 1+2**(已通过):CC 在绑定会话真实跑命令、危险动作停下等人点、跨会话被拒。**全链路已在 GUI 验证**(绑定 SSH 会话执行 `uname -a`,确认卡 → 允许 → 远端执行 → `read_terminal_tail` 读回真实输出)。

### Phase 3 — 真实 cwd + 模型 / 渲染保真 — ☐ 待办
- ☐ live `chat_stream` 接 `--add-dir`(搬 `commands.rs` 逻辑),cwd 由前端 OSC-7 传入(扩 `chat_stream` 请求字段)。**注**:仅对本地工作区线程有意义;远端 SSH 线程 N/A。还需先给 CC 子进程显式设 `current_dir`(现继承 Taomni 工作目录,无意义)。
- ☐ per-thread 模型(opus/sonnet/haiku)+ thinking 预算,在 provider 切换处暴露。
- ☐ CC 的 `tool_use/tool_result` 渲染为结构化卡片;从 result 事件捞 token/cost/usage。
- ☐(新增候选,讨论结论)**执行目标消歧**:让 CC 在绑定会话时优先 `run_in_terminal`(远端)而非内置 Bash(本地)——system-prompt 一句消歧,或 Strict 线程 deny 本地 Bash。小而高价值。
- ☐(新增候选,讨论结论)**只读命令确认降噪**:区分只读/改动命令,只读免逐条弹卡(或引导 allow-session),降低「跑→读→调整」循环的点击摩擦。
- ❌(讨论结论)**环境事实卡** —— 不做:`read_terminal_tail` 反馈闭环已覆盖,纯优化、低优先。

→ ☐ Review gate 3。

### Phase 4 — 编排者 B 最小版 — ☐ 待办
- ☐ 给 CC 增最小编排工具 `dispatch_subtask`(并行拉起子 CC 进程或原生 agent run),结果聚合回主 CC。
- ☐ 复用挂起表 + 进程注册表;并发上限可配。
- ☐ 任务列表在 UI 简单可见(不做完整计划面板)。

→ ☐ Review gate 4。

### Phase 5 — 多 agent 调度中心 C(本轮只出设计文档) — ☐ 待办
- ☐ 跨 thread/跨机调度、agent 注册表、任务队列、调度器 → 设计先行,实现待 A+B 稳定。

---

## 待办清单(汇总)

**清理债(承接 Phase 1+2 偏差):**
- ✅ 废弃旧的自定义 JSON-RPC `agent/mcp_server.rs` + `lib.rs` 的 `mcp_server_start/stop/status` 注册 + stdio `--mcp-server` 分支（`main.rs` dispatch、`cc_bridge/permissions_mcp.rs`、`cc_bridge/tools_mcp.rs`）。三处均已删除，构建通过、cc_bridge 33 测试全绿；活动路径只剩 `cc_bridge/mcp_http.rs`（Streamable-HTTP）。

**Phase 3(cwd + 模型 + 渲染):**
- ☐ CC 子进程显式 `current_dir` + 本地工作区线程接 `--add-dir`
- ☐ per-thread 模型 + thinking 预算
- ☐ `tool_use/tool_result` 结构化卡片 + result 事件的 token/cost/usage
- ☐ 执行目标消歧(优先 `run_in_terminal`)*(讨论新增,低成本高价值)*
- ☐ 只读命令确认降噪 *(讨论新增)*

**Phase 4(编排 B 最小版):**
- ☐ `dispatch_subtask` + 并发上限 + UI 任务列表

**Phase 5(调度中心 C):**
- ☐ 设计文档(跨 thread/跨机调度、agent 注册表、任务队列、调度器)

---

## 四、跨阶段约束
- **测试**:rmcp 服务器(initialize / tools.list / tools.call + 401 无 token + 跨会话拒)、挂起 oneshot 超时回收;前端 `npm test`(vitest);有状态工具配 env 门控的真实 SSH 集成测试(仿 network-proxy 实测约定)。
- **构建**:Rust `cargo test`(注意默认 `hbase-kerberos` feature);前端 `tsc -b && vite build`。
- **一致性债**:`agent/commands.rs:13-25` 的 `build_registry` 用第二个私有 DB 连接,接 in-app 服务器时统一走 `AppState.db`。
- **风险 Top 1**:rmcp ↔ CC 的 MCP-HTTP 传输兼容 —— ✅ 已验证(spike 通过,CC 2.1.185 `type:"http"` + Bearer 连通在跑)。

---

## 五、Review 节奏
1. 决策 D1–D4 已锁定(见第二节)。
2. ✅ Phase 0 + Phase 1+2 已交付并通过 gate(HITL 全链路 GUI 验证通过)。
3. ⏭️ 下一步:Phase 3(建议先做低成本的「执行目标消歧」;`--add-dir`/cwd 仅本地工作区线程需要)。
4. 每阶段 review gate 通过后才进下一阶段。
