# OpenCode Go browser / native 用例交接

关联设计：`docs-feature/opencode-go-provider-design.md` AC-01～14、V-01～10。
**本轮仅运行本地单元测试；本文件以及 TC-AI-005～011 全部为未执行。**
禁止用 YAML lint、dry-run、stub、单测的通过替代 browser/native 运行结果。

## 执行前提、隔离与证据

- 三端原生构建，记录提交、工作树差异、可执行文件 hash、前端 mode、OS/CPU/WebView 版本。
- 使用 qa-ui-auto 的独立配置/DB/report 目录，先检查其实际解析路径；不修改日常配置。
  缓存位于 ai.json 同目录；不得硬编码 Linux 路径套到 Windows/macOS。
- 使用最新源码构建一次，native sequential；不重用身份不匹配的旧二进制。
- 真连 key 只从安全渠道的 `TAOMNI_TEST_OPENCODE_GO_KEY` 获取。测试输入不录屏，
  证据中禁止 key、Bearer、解密值、vault 主密码、代理凭据；配置证据仅显示 vault 引用。
- 本地假网关须提供 `/models`、`/chat/completions`、`/messages`、`/responses`、
  `/models/<id>:generateContent` 与 `:streamGenerateContent?alt=sse`；
  请求记录只保留 URL、模型、UA、会话 hash 和工具名，鉴权仅记头名/是否存在。
  服务监听 loopback 随机端口，断开环境代理；不向假网关发送真实订阅 key。
- 原生 TC-AI-009 的目录固定前提：操作系统级只阻断两个目录主机，保留 loopback；
  隔离缓存为空，内置快照有 kimi-k3。运行前确认未使用 `goFixture` 浏览器桩参数。
  若该环境无法精确阻断主机，按 N-GO-03 手动执行，不能把在线目录变化当 skip/pass。
- 用例之后：关闭测试进程/假网关、删除隔离 DB/cache/config、恢复网络规则及代理，
  清理订阅 key 引用；不得删除用户原有数据。失败也执行清理。
- 证据统一落 `qa-ui-auto-report/opencode-go-provider/`，每个 N-GO ID 独立子目录。
  保存步骤、预期/实际、失败原文、截图、脱敏请求计数、前后配置/DB 摘要与状态。

## Browser 流程（全部未执行）

| ID | 入口 / 前置 | 决定性结果 | AC |
|---|---|---|---|
| TC-AI-005 | 默认 stub；设置 go 行，修改已分类模型协议，保存/恢复；回终端选择 go，新建线程 | 默认模型正确、未分类可见、override 写入与恢复、pin/clear、非 go 隐藏 | 01/07/10 |
| TC-AI-006 | `goFixture=changed`；钉 kimi-k3 后刷新 | 新模型可见；旧钉项置顶标已下线，不自动改选；搜索不改 pin；弃用/训练徽标 | 06/08/10/11 |
| TC-AI-007 | `goFixture=recovery` | 第一次手动刷新错误且保旧；再次刷新成功清错且不改选择 | 09 |
| TC-AI-008 | `goFixture=empty` | 空目录文本框可编辑，保存/reload 回显不丢模型 | 01/09 |
| TC-AI-009 | 原生隔离 SQLite + 离线目录 | IPC 钉住/清空、renderer reload 读回；进程冷启动另按 N-GO-03 | 07 |
| TC-AI-010 | local-only 与 AI 总开关 | 禁刷新、Go 不可选与界面禁用提示；真实网络阻断另按 N-GO-05 | 12 |
| TC-AI-011 | 默认模型从 deepseek 切换到 kimi-k3 | 保存后重开设置仍回显 kimi-k3；不证明原生网关 | 01/10 |
| TC-AI-001 | 保留原 case，不改其原断言 | 抽屉/附件/位置/收起重开保持 | 13 |

准备：使用 qa-ui-auto browser config，确认服务对应当前源码并重置 fixture。
示例命令（**仅供后续执行，本轮没有运行**）：

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run \
  --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml \
  --mode browser --filter TC-AI-005 --require-pass
```

另外手动 browser 检查：用键盘 Tab/Shift+Tab 进入搜索与下拉，Escape 取消下拉、
搜索无结果/清空搜索、长名字和错误换行、380px 抽屉溢出、打开/关闭协议折叠区、
中英切换、仅本地刷新按钮禁用和说明。无新增全局快捷键/Action/撤销功能，
因此不虚构其测试；新条目的外链是 native 边界，见 N-GO-01。
这些手动项未执行；组件单测只支持其中的状态与事件映射。

## Native 用例（逐项未执行）

### N-GO-01：老配置、vault 与连接测试（AC-01/02/13）

初态：7-provider 老 ai.json，保留非默认 task_routing、provider_groups、
fallback、代理、模型、已有 vault refs；无 go/overrides。制作脱敏前态摘要。

1. 启动并打开设置：出现 Go，默认 `deepseek-v4.1-flash`、chat 能力；
   原 7 provider 及路由/分组/回退的摘要逐项相等。
2. 输入 Go key、增加第二个 key；保存后检查 ai.json 仅有 vault 引用，无明文；
   重新打开设置 key/模型/代理均保持。删除一个 key，保存后另一 key 保持。
3. 测试连接：默认模型 chat 端点发 pong，返回成功/延迟。把默认模型依次改为
   messages/responses/google 代表模型后分别测试，确认请求端点也随之变化。
4. 锁 vault 后启动：发送/连接测试显示 `VAULT_LOCKED`，不发送 vault 字符串，
   不无意切换其他 provider；解锁后不重启即可成功。
5. 无效/过期 key、401/403、额度耗尽、超时：呈现错误与可操作 key/订阅说明；
   修正后可重试，日志不含 key。点击 Console 链接确认通过系统浏览器打开正确地址。

证据：前后摘要、vault引用、端点/状态/延迟、解锁前后结果。实际凭据不入证据。
外链、vault 及真实鉴权不能由 browser stub 证明。

### N-GO-02：四协议真连矩阵（AC-03～06/14；V-07）

每组新建/选择 go 线程，代表模型：
chat=`deepseek-v4.1-flash`；messages=`minimax-m3`；
responses=`grok-4.7`；google=`gemini-4-argon-contributor`。

每组依次：
1. 输入一个小型代码问题非流回复 → 成功且 usage 可见；
   下一轮引用上一轮约束 → 历史上下文连续。
2. agent 模式请求一个允许的只读工具 → 有工具调用/回填，再有最终回复；
   多个工具、工具错误结果回填后可继续，无工具支持的模型正确禁用工具。
3. 发送流式消息 → 中文/emoji 不乱码、不重复；Responses completed 带 usage 收尾，
   Google 最后分片带 usage 收尾，发送状态结束。
4. 流式中取消 → 不再追加 token、发送状态释放，下一轮可正常发送。
5. 附件图片（支持该 modality 的模型） → 请求分别使用 data URL 或 inlineData；
   文本+图片+工具历史顺序不乱。模型不支持图片时错误显形，不无声丢附件。
6. 同线程两轮、异线程两轮 → UA 均 `taomni/<version>`，会话头同线程稳定、
   异线程不同，为 32hex 哈希非原始线程 ID。使用假网关记录头完成决定性断言；
   真连只作旁证，不能靠无异常声称头正确。

协议头：chat/responses Bearer；messages x-api-key + anthropic-version；
google x-goog-api-key。任何组失败必须保留原文，不用换模型绕过。
训练徽标另检查两个 muse 条目，不仅 Google。

证据：四组模型/端点/工具/多轮/流式/usage/取消结果矩阵及截图。
真实 key/网关/流式长连接为 native 必要边界。

### N-GO-03：线程隔离、清除与真正重启（AC-07；V-08）

1. 线程 A go 默认 → 钉 kimi-k3；线程 B go 不钉，C 非 go。
   A 下一请求模型 kimi-k3，B 仍配置默认；C 无 Go 选择器及 Go 头。
2. 渲染器 reload → A 回显保持，SQLite llm_model 对应 A；B 为 NULL。
   可先执行 TC-AI-009；它不能替代后面的进程重启。
3. 退出整个应用，确认进程已停止；离线冷启动 → A 钉住仍在，
   B 仍默认；重新发送到假网关确认不仅 UI 回显，实际请求模型也正确。
4. 清除 A pin → 数据库 NULL，下次使用默认；修改全局默认 →
   未钉线程跟随、钉住线程不跟随。新线程仍默认。
5. 切 A provider 离开再切回来 → Go 模型独立于 cc_model；
   原有 CC/Codex pin 不受影响，Go pin 改动不回收桥进程。
6. 两次快速切换、写盘失败 → 错误可见，未保存值不冒充成功；
   恢复可写后重新切换成功。删除线程后不出现孤立模型状态。

证据：SQLite查询摘要/重启身份/四次请求模型和无进程回收旁证。

### N-GO-04：目录全生命周期与故障回退（AC-08/09；V-08）

假目录 fixture 场景用与合并单测相同的规则构造；S2 固定地址由测试环境
受控代理映射/故障注入，不修改产品常量绕过真实代理解析。

1. 无缓存、断网冷启动 → 内置37项+协议仍可用，来源 snapshot；
   手动刷新失败保旧，显示时间/错误；损坏 JSON/缺字段/错 digest 同样回退。
2. 有合法缓存断网冷启动 → 来源 cache，列表/协议/pin保持；
   failed refresh 不覆盖 last-good 文件。
3. 上游 fixture 新增一个未知模型、移除一个已钉模型 →
   刷新加入新模型（chat+未分类），移除未钉旧模型，
   已钉旧模型置顶警告且不替换；在售 deprecated kimi-k2.6不被误删；
   S2独有 deepseek-v4-flash不加入。
4. 内容完全相同 → 内存目录身份不替换、缓存不重复改写、UI 不闪；
   准确区别 fetched_at 状态更新时间与模型 digest 更新。
5. S1失败/S2成功 → 可用ID保持 cache/snapshot；S1成功/S2失败 →
   用旧元数据/快照，不能清空；双失败 → 保 last-good。
6. 启动异步、过6小时后打开设置/选择器、手动、模型不存在错误四触发点；
   并发触发只有一次S1/S2，在途后来者复用结果，不丢错误状态。
7. 恢复网络刷新 → 错误清除/新目录可见；切出设置/关闭抽屉不取消目录任务；
   正在流式的请求仍完成其原模型/协议，新请求看到新目录。

证据：cache SHA/mtime/digest、请求计数、四触发点时序、页面状态。
真实网络、缓存、异步生命周期不可用 browser fixture 替代。

### N-GO-05：全量覆盖与代理（AC-10/12）

1. 在设置协议区分别改一个已分类/未分类/弃用模型到其他协议并保存 →
   后续请求走改后端点；来源 Manual；重启后覆盖仍在；
   每项恢复自动 → 保存后回目录协议。另输入未知字符串配置 → chat+告警、不崩溃。
2. 原有代理三模式逐一：none、manual、session。设置 none 时环境HTTP_PROXY
   指向阻断代理仍应直连；manual/session 的请求目录与推理经指定代理；
   独立 provider 配置不覆盖应用代理。
3. 代理语法无效、代理会话不存在、vault 锁定代理认证、代理连接失败 →
   显示错误，**绝不静默直连**；修正后恢复。
4. full_local 开启 → 聊天 Go 不可选，设置刷新/测试禁用并有原因；
   full_disabled 同样不允许目录/推理网络（入口可能完全隐藏）。
5. 目录请求在途时切full_local/fully_disabled → 请求取消且不发布结果；
   关闭策略后重新打开可刷新。确认本地 provider仍可用、7 provider配置未变。

证据：代理日志/直接出口零请求、策略切换时序、保存前后 override。
browser只能证明按钮状态，不能证明零网络。

### N-GO-06：原文错误、不重试替换、SSE边界（AC-11/13）

1. 假网关使已钉模型返回404 Model not found → UI原文；模型仍pin；
   推理请求仅一次，强制目录刷新至多一次，不改模型重发。
   未知目录模型成功/失败均触发一次刷新，不在客户端拦截。
2. 401/403/429/500、额度错误、超时、断连 → 原文/状态可见；状态释放；
   普通鉴权错误不误触发模型不存在刷新。
3. Responses SSE delta、工具参数delta、未知事件、completed/failed/incomplete，
   分隔符 LF/CRLF、跨字节中文、坏JSON、缺终止事件 →
   仅文本外发，usage正确，错误不伪造End，无panic。
4. Google多分片、functionCall/functionResponse、usageMetadata、STOP/MAX_TOKENS、
   SAFETY/blocked、坏JSON、EOF无完成 → 对应正文/工具/错误，不能静默成功。
5. 原deepseek/anthropic/local分别非流/流式/工具/连接测试，
   fallback和group轮换沿现有用例 → 请求body无新增metadata，行为与基线一致。
   fallback/group不是为Go新增独立路由，每个key variant共享目录。

证据：原始脱敏SSE、请求与刷新计数、最终pin、既有路径前后对照。

## 平台、排除项与结果回填

所有 N-GO 在 Linux/WebKitGTK、Windows/WebView2、macOS/WKWebView 分别记录。
本轮三端全部未执行，缺 key 不是通过；不运行 browser/native 是用户明确指定的边界。
新增模型检视 S1、购买/订阅管理、ASR接入不属本功能，不能纳入本轮声称覆盖。
表格回填格式：`ID | OS/mode/build | pass/fail/unrun | assertion | evidence | limitation`。
YAML contract review=pending：静态有效不等于交互实测；后续先语义复核索引再执行。
