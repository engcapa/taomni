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

本节覆盖早期探针的状态，以按钮补充批次 `7ca662c53` / `dc1288a4c` 的实际输入为准；旧失败目录保留。

- 原 Agent frontend：19 files / 69 tests 通过，另有绑定显示组件 2 tests。按钮批次追加 MemoryPanel、TaoAiChat、SettingsPanel 与 sectionReveal 共 **4 files / 37 tests** 通过，日志 `qa-ui-auto-report/_local/tao-buttons-memory-units-r2-1116.log`。
- Tao Rust：**33/33** 通过，使用 Windows 无默认 whisper 的既有 unit recipe，日志 `qa-ui-auto-report/_local/tao-buttons-retained-rust-1116.log`。原生取消回归另有 **6/6** capture 测试通过，日志 `qa-ui-auto-report/_local/tao-capture-rust-fix-r2-1116.log`；覆盖正常/失败退出、嵌套子进程取消及 future 被丢弃后的清理。release QA 使用完整默认功能。
- Python Tao 工具：**35/35** 通过，覆盖隔离配置与清理、HTTP 网关、真实 NDJSON ACP 子进程、记忆 fixture 及既有商业工具契约。
- `pnpm check:refactor`、Rust fmt、development case contract 与静态 `audit --gate` 通过。追加 Shell/Home 动作后静态 F1.11 为 **101/111**；其余旧文本 selector 或自定义原生 probe 未归因与实际缺口分别按覆盖矩阵记录，静态比值不等于功能完成率。最终日志 `qa-ui-auto-report/_local/tao-buttons-recovery-audit-final-1116.log`。
- Windows browser 按最新有效回执合并 **27/27** 通过，含完整 **18/18** 适用 crash；原始整批 summary/receipt：`qa-ui-auto-report/_local/tao-agent-browser-1116/run-20261116-162201-641536600/`，扩展后 031 的最终回执为 `qa-ui-auto-report/_local/tao-buttons-browser-launcher-r2-1116/run-20261116-165728-319642900/`。实际截图已核对最新顶栏顺序、居中的四项快捷问答及无 WSL 安装提示。
- 匹配最终源码的 QA release 已构建成功：`src-tauri/target/qa-ui-auto/release/taomni.exe`，日志 `qa-ui-auto-report/_local/tao-buttons-stable-qa-build-1116.log`。构建中源码变化的早期产物被身份检查拒绝，未用作当前证据。
- Windows native 首轮 **34/36**，无跳过，source/build 身份稳定；报告 `qa-ui-auto-report/_local/tao-agent-native-1116/run-20261116-163043-910949100/`。034 在异步载入前立即检查数量得到 0，失败截图随后已出现三条正确资料；补充按条目身份等待，并在删除完成和 reload 数据就绪后再核对数量。MOBILE013 的辅助 Chromium 使用隔离后的 LOCALAPPDATA 寻找安装而失败；复跑进程通过 `PLAYWRIGHT_BROWSERS_PATH` 指定既有安装，不修改产品或个人应用数据。
- 两项失败在 `qa-ui-auto-report/_local/tao-buttons-native-recovery-1116/run-20261116-165309-255688400/` 均通过。扩展 031 曾误用旧 SFTP 路径控件及 Playwright 专用 selector，实际产品已打开正确 Explorer；现使用两种 runner 均支持的按钮 XPath，严格检查活动 Explorer 的真实绝对路径与 Home 选中状态。最终 native 031 在 `qa-ui-auto-report/_local/tao-buttons-native-launcher-r2-1116/run-20261116-165725-568968900/` 通过。
- Windows 最终为 **browser 27/27、native 36/36** 个具名用例的当前有效证据，包含全部适用 crash **18/18、22/22**。独立 `status --gate` 合并上述原始回执，结果 `ok=true`、0 gaps、0 rejected reports；记录 `qa-ui-auto-report/_local/status-tao-buttons-windows-final-1116.json`。这是逐条取最新匹配回执后的验收，不把首轮 34/36 改写为整批一次全绿。
- GitHub [43831374934](https://github.com/engcapa/taomni/actions/runs/43831374934) 使用 `dc1288a4c` 执行 Linux/macOS browser/native release。Linux、macOS browser 均 **27/27**，raw receipt 签名、逐项文件哈希、该批 source/runner/case 与稳定性核对通过；结果位于 `qa-ui-auto-report/_local/hosted-tao-buttons-43831374934/independent-feedback-verification.json`。扩展后的 031 与异步就绪修正后的 034 需要 hosted 定向补跑，旧回执不替代新 case 输入；native 最终为 Linux 35/36、macOS 34/36，027 两平台及 008 macOS 失败；最终 workflow 汇总为失败，后续诊断与修复见 [历史与 Vault 验证](verification-history-vault-2026-11-16.md)。
- 修正后的 031/034 已随 `1deb0075f` 提交并推送，使用 [43836152729](https://github.com/engcapa/taomni/actions/runs/43836152729) 在 Linux/macOS 定向执行 browser/native release，workflow 自动包含适用 crash。复用上一运行已经成功的 native-contracts（相同 Rust、锁文件、工具链配置与 product source），此定向批次设 `run_rdp_unit_contracts=false`，不删除任何选中 UI/native 用例。43836152729 已结束 success；Linux/macOS browser 各 19/19、native 各 24/24，完整适用 crash 均通过。原始 receipt 验签、逐项产物哈希与按历史 `1deb0075f` Git blob 重算的 source/runner/case 指纹核对通过，无遗漏、失败或跳过；独立核对记录 `qa-ui-auto-report/_local/hosted-tao-launcher-43836152729/independent-feedback-verification.json`。该历史 source 不替代当前历史/Vault 改动的验证。

上述旧批次的 browser/source 指纹为 `2fd0845b1048fb308dde828e319cbbd299e5d404edcb4839c5f5a749d99bc02f`。覆盖映射见 [按钮与 Action 补充](button-action-coverage.md)，未执行或条件能力继续保留缺口。

## 按钮补充与本轮发现的回归

复用并扩展 001/002/003/007/009/010，新增 031～034，分别覆盖 launcher 实际目标、审核编辑与真实取消、原生工作区目录选择、非空记忆/技能的取消/保存/导出/删除与 reload 持久化。最新用户反馈删除顶栏设置/外观，末尾顺序为演示、侧栏；设置继续从 Dock More 进入。

032 原生回归发现取消外层 shell 后 Python 后代仍存活，现 Windows 使用 kill-on-close Job Object、Unix 使用独立进程组，取消和 future drop 都清理整个捕获任务。010 发现已打开 Tao 设置后搜索 theme 仍停在旧区域，已复用异步标题定位及用户接管释放。033 早期失败源于误用通用 tab selector，现断言专用 workspace tab、唯一数量与实际 root path，未修改产品打开目录行为。MemoryPanel 的原生 prompt 改为侧栏受控编辑表单；取消/Escape 不保存，保存失败保留草稿，重复请求和卸载后的过期结果受到保护。

## 商业 OpenCode 执行限制

本轮携带临时 Key 文件路径、启动 OpenCode Go native 测试的 detached 命令被自动审批明确拒绝，仅返回 `blocked by policy`，未提供更具体原因。该商业进程未启动，本次未发出商业请求；没有通过改名、复制 Key 或更换启动路径绕过拒绝。此项记为**未执行**，不能按用户对“API Key 失效”的例外记成功。

早期商业探针的 HTTP 403 / Cloudflare error 1010 也未确认凭据失效（`credential_invalid=false`）；WAF、代理/网络和审批拒绝均不属于失效。025/027/028/032 使用 loopback 模型，证明实际 native IPC、文件、检索、子进程与工作流流转，不代表商业推理或 CC/Codex 模型能力。

## 尚未关闭的设计边界

深研真实计划/阶段/预算状态机、独立增量 `tao_index.db`、可选向量索引，以及全部外部执行器/所有存储来源的全量组合验收未完成。现有原生 ACP 交接与 CC/Codex 组件队列测试分别记录边界；不把脚本 peer 当成商业编码 Agent。远程 terminal 执行尚无 adapter 时明确拒绝在本机代执行。以上不妨碍独立验收本批具名工作流，但不能宣称全部原始设计或生产标准已整体达成。
