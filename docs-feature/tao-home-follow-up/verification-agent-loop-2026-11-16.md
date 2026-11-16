# Tao Agent 开发闭环与上下文验证（2026-11-16）

用户确认“开发 → 测试 → 失败反馈 → 修复 → 补功能”和复杂任务交接给现有 CC / Codex / ACP。本批基于 `9d9b99944`，沿用 `feat/tao-home-follow-up`；原 main 合并 `1d8f1bcdc` 不重复执行。用户反馈优先于原型，完整原型视觉对齐仍是后续批次。

## 本批实现

- Home 可使用 Settings 中的 OpenCode Go，模型 `deepseek-v4.1-flash`、thinking `max`；provider、模型和 effort 随线程与请求持久化。保持原 DeepSeek Messages IPC 和旧 tao-chat 兼容。
- 问只读；做生成最多五项可审核动作，显示文件内容，待确认期间阻断新的发送/继续/再生成。实际结果、拒绝、失败、取消和 Undo 进入下一轮；每次提议有独立执行 ID，模型复用 ID 不复用旧结果。异步结果写回原线程，重启不自动重复未完成动作。
- 后端从持久请求验证 Do 模式与绑定范围，实际执行磁盘/进程操作；模型自报工作区不能代替用户绑定。取消按原线程转发。下一轮执行反馈以持久执行结果为准，不能由前端伪造。
- 交接先预览目标、历史、显式资料与执行结果，排除未发送草稿、隐藏思考和凭据；确认后复用原 CC / Codex / ACP 队列。持久记录目标线程，可将完成结果带回为可预览、可移除 chip，显式发送后才继续 Tao。
- 原生本地检索补充来源别名、相对日期、会话协议/分组/端口/用户、SQL 保存查询/书签、可见对话、笔记、记忆/技能、快照及功能目录；文件内容、邮件和语音默认关闭。绑定文件只读工具与所有写入路径均限制范围。
- OpenCode 图片承载实际图像，代码/PDF 文档本地提取；附件 ID、变更校验、删除/复用按 provider 隔离。模型工具支持本地检索、功能说明、绑定文件列举/读取；联网搜索使用配置的服务，未配置不伪造来源。

## 用例与证据口径

| 用例 | 真实边界 |
|---|---|
| TC-TAO-HOME-024 | 商业模型生成 Python 工程，逐项批准写入；真实测试成功、故意回归失败、依据结果修复、扩展功能、再测 |
| TC-TAO-HOME-025 | 同一执行闭环，脚本化 loopback Go 网关；实际原生文件与进程，供 Linux/macOS hosted 重复执行，不能冒充商业推理 |
| TC-TAO-HOME-026 | browser/native Provider、模型、max、三模式、Escape 与切回原 provider |
| TC-TAO-HOME-027 | Tao → 现有 ACP bridge → 真实子进程请求/回复落库 → 返回 chip → 显式续聊；ACP peer 为确定性测试程序，不代表商业 CC/Codex 推理 |
| TC-TAO-HOME-028 / 029 | 分别通过 loopback / 商业 Go：Notes UI 保存并重开笔记，原生检索脱敏并显式引用；真实绑定文件和功能目录工具结果；本地深研续聊 |
| TC-TAO-HOME-030 | 商业模型实现 JSON 持久化任务应用、argparse CLI、README 和至少六个测试场景；故意回归、失败修复、优先级扩展、旧数据兼容与再测 |
| 原 TC005/011/013–023 | 用 Go 复跑简单/多轮、图片/文档、代码/Mermaid、选择项、拒绝/批准/Undo、Stop/继续、重启、附件恢复、归档与并发线程 |

按照用户要求，模型措辞、图片数字/颜色和文档算术仅记录观察，不按精确答案判定；文件边界、磁盘内容、真实测试数量/退出码、权限、取消与线程隔离仍作结果断言。原生工程测试不能以“Ran 0 tests”通过。OpenCode 隔离配置未启用外部搜索服务，用例记录不可用分支；真实成功搜索另需服务配置。

临时商业 Key 只通过 `TAOMNI_QA_OPENCODE_KEY_FILE=C:/tmp/open-key-tmp.txt` 读入隔离配置，teardown 删除该配置，Key 不进入命令参数、提交或 GitHub。预算累计上限 50M token，不以耗尽预算为目标。只有已确认的凭据失效可按用户授权记 `credential-invalid` 成功，并明确后续阶段未验证；代理、WAF 和网络失败均失败。

## 已定位问题与保留失败

1. `tao-agent-native-probe-1116`：loopback fixture 缺少 ASR、fallback 和 task_routing 必填字段，原生配置回退默认值。补齐配置，并增加 fixture/Key 文件与清理测试。
2. `tao-agent-native-probe2-1116`：Windows 相对文件路径被后端重复盘符规范化后误拒绝。新增单测先复现失败，再修复原始 root 拼接。
3. `tao-agent-native-pathfix-1116`：覆盖已有文件时，canonical 文件路径拼接空 suffix 产生尾部分隔符，丢失备份并在实际替换后校验失败。新增重复替换/精确备份/预期哈希单测复现并修复。文件以独立临时句柄写入、flush 后发布；Undo 使用本次发布的内容哈希，后续外部修改不能进入可撤销哈希。
4. 同一失败暴露用例只等“提议卡消失”即继续，可能早于异步结果。现逐项等待真实结果并检查 Completed/exit 0；执行测试还要求真实测试数量及退出状态。
5. 实际长工作区路径挤出 Home 顶栏；绑定名称现省略并保留完整 tooltip，宽窄窗口保留顶栏布局，新增几何断言。

失败目录均保留；早期截图/回执不作为后续源码的通过证据。

## 当前阶段回执

- Tao frontend：19 files / 69 tests 通过；绑定显示更新后单独复跑相关组件，1 file / 2 tests 通过。
- Tao Rust：33 passed，使用 Windows 无默认 whisper 的既有 unit recipe；日志 `qa-ui-auto-report/_local/tao-agent-rust-stable-1116.log`。release QA 使用完整默认功能。
- Python 工具：33 passed，覆盖 live Go Key 文件、隔离清理、真实 HTTP 网关和真实 NDJSON ACP 子进程，以及旧商业流程工具契约。
- Refactor：契约、依赖边界与 800 行检查通过（4738 files）；Rust fmt 继续按当前源码核验。
- Windows native 探针：027 和 028 已通过；025 保留失败，等待修复后的匹配 release 复跑。
- Windows browser 最新稳定输入 **26/26** 通过（含全部18项适用 crash），`identity_stable=true`；原始 summary/receipt 位于 `qa-ui-auto-report/_local/tao-agent-browser-1116/run-20261116-153018-180544500/`。
- 当前 QA release 正在重建；商业 native、完整 Windows native crash 及 Linux/macOS hosted 均待本批实际回执，不能据本节标为完成。

## 尚未关闭的设计边界

深研真实计划/阶段/预算状态机、独立增量 `tao_index.db`、可选向量索引，以及全部外部执行器/所有存储来源的全量组合验收未完成。现有原生 ACP 交接与 CC/Codex 组件队列测试分别记录边界；不把脚本 peer 当成商业编码 Agent。远程 terminal 执行尚无 adapter 时明确拒绝在本机代执行。以上不妨碍独立验收本批具名工作流，但不能宣称全部原始设计或生产标准已整体达成。
