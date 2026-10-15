# Model inspector browser/native 用例交接

设计：`docs-feature/model-inspector-design.md` AC-I01～I09 / V-I01～I06。
**本轮只运行本地单元测试。下列 browser/native 用例均未执行，三端均未验证。**
目录 audit、schema、CI 静态计划或 jsdom 单测不代表浏览器/原生验收通过。

## 隔离、前提与清理

- 为 Linux、Windows、macOS 各建立独立 config/DB/report，确认实际解析后的
  `ai.json` 目录，不改用户日常配置。记录源码/worktree、构建 hash、frontend mode、
  OS/CPU/WebView。使用匹配源码的原生构建，不重用未绑定身份的旧 binary。
- 缓存文件与 `ai.json` 同目录：`model-catalog.json`、
  `opencode-go-catalog.json`、`model-check-results.json`。配置证据只保留 model、
  runtime、vault 引用和代理模式，不保存密钥、解密值、鉴权头内容、代理凭据。
- 真连使用专门测试账号，key 经现有 vault UI 保存；录入时不录屏。不在
  YAML、日志、命令行或报告中写实际 key。OpenCode Go 需有效订阅。
- 假网关仅 loopback 随机端口、合成 key；提供 `/models`、`/chat/completions`、
  `/messages`、`/responses`、Google 端点；切换 success/401/503/timeout/malformed/
  empty，记录模型、方法、路径、UA、脱敏请求计数，鉴权只记录是否存在。
  先用真实 HTTP 请求检查就绪，端口能连不是模型已加载。
- TC-AI-018 需运行且已加载 chat 模型的 llama-server。对实际 `base_url/models`
  验证 `data` 中至少有一个非空 id，并确认最小 chat 请求成功。没有服务按
  setup failure 记录，不 skip，不把 browser fixture URL 用在 native config。
- 测试后无论成功/失败都恢复被改 key/代理/网络规则、停止自建假网关、
  移除隔离文件；只清理测试目录，绝不删除用户原有结果/配置。
- 每个 N-I ID 的证据写入 `qa-ui-auto-report/model-inspector/<platform>/<id>/`：
  有序步骤/预期/实际、截图、脱敏 HTTP 计数、前后文件摘要、失败原文、执行状态。

## Browser 选集（全未运行）

| case | AC / V | 决定性断言与边界 |
|---|---|---|
| TC-AI-012 | I01/I02/I03/I05/I06/I09 / V-I03/I04 | 来源四态（跨 local）、精确顺序、未知值、实时差异保留、当前/逐行检测、首行及完整错误、选择回写、既有连接测试/保存。全部 synthetic stub。|
| TC-AI-013 | I01/I02 / V-I04 | 手动刷新失败保 exact last-good 行，重试清错不改选择。|
| TC-AI-014 | I05 / V-I04 | 打开无自动 check、batch 消耗提示、cancel 无结果变更、逐行混合结果、reload 读取 stub 持久化。真实请求数由 N-I-06 补验。|
| TC-AI-015 | I08 / V-I04 | full_local cloud 只读/检测刷新禁用且注明；local 可检测。没有真实无流量证据。|
| TC-AI-016 | I04 / V-I04 | local 不可用态与空目录分开，保留原因，无虚构模型。|
| TC-AI-017 | I04 / V-I04 | 真正空行集说明，检测动作禁用。|
| TC-AI-019 | I01/I06/I07 / V-I04 | 大行集全部可选，末行选择置顶，Go override 协议一致且 inspector 不可编辑协议。实际性能不由 DOM count 证明。|
| TC-AI-020 | I09 / V-I04 | 关闭检视后改原 key/model 输入、原连接测试/保存、合成 key 替换为 vault stub 引用；重开 current 一致。|

执行时设置 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts`，使用 skill 的 browser
config（URL 指向被测当前 checkout）。命令示例：
`python -m qa_ui_auto run --mode browser --filter TC-AI-012 --config <browser-config> --require-pass`。
其余精确 ID 同法；不要误把 native config 的 URL 或真网关用于 stub。

## Native 详细用例（manual 部分为 runner 暂不能建立的观察，不发明 verb）

### N-I-01 唯一目录底座 / 子树 / 快照（AC-I02/I07，V-I01/I06）

前提：受控公开 models.dev 流量、清空隔离两类 cache，记录原文件 hash。
步骤：
1. 打开 deepseek、anthropic、agnes、glm、groq、siliconflow（cn 与 com base
   各一轮）检查模型行来自对应子树；foreign 子树 id 不混入，只允许未收录 current。
2. 再开 Go 目录与 inspector，比较每个 id、name、protocol、protocol_source、
   context/output、cost、status。Go 行集仍按其网关过滤；单源失败不得混入 metadata-only id。
3. 在 TTL 内开另一 provider，记录 models.dev 网络请求数和 cache 文件变化：
   共用同一模型元数据 cache；不出现 inspector 专属第二套 api.json 拉取。
4. 同时触发多个检视刷新与 Go 刷新：无重复在途 metadata 请求，失败时保 last-good；
   同 digest 不改变数据语义；Go 的协议/模型默认值不变。
5. 断网冷启动：有合法缓存优先缓存；损坏/字段缺失/digest 错误回快照，
   仍可开 cloud 表。快照模型来源可追踪；深度未知项为 `—`。
6. deepseek-chat 不在当前目录且没有已验证别名登记时，必须显示未收录。
   未来登记必须有 target id、核对日期与独立 API/docs 证据，禁止靠名称相似。

期望证据：脱敏 metadata 请求计数、两个功能比较表、cache hash/来源、断网截图；
alias 行的真实验收在有登记证据前不可声称通过（synthetic 单测不算）。

### N-I-02 真实逐模型检测 / 错误（AC-I05/I09，V-I02/I06）

前提：有效 anthropic key 入 vault，另有 loopback 假网关。
步骤：
1. 先开 inspector：仅元数据读取与必要 `/models`，**零聊天测试**，旧结果只展示。
2. anthropic 某模型点检测：一次 messages 请求，显示 ✓/耗时/时间，文件落盘。
3. 在隔离配置将该 key 改为合成错误 key：同模型检测一次，显示 ✗ 与原文首行，
   悬停可见完整错误。不得自动切模型/协议/重试；恢复有效 vault key。
4. 假网关 success、401 多行原文、503、迟迟不响应分别检测：
   成功有 latency；失败保首行/完整错误；超时在 deadline 后停止挂起并记录 timeout。
   用空 model 调 IPC 应拒绝；未知 provider 拒绝；错误不在日志/结果中泄露 key。
5. vault locked 时检测：显形 vault 错误且零网关 chat；unlock 后可正常重测。
6. 每 provider 原「测试连接」用 current model，成功/错误口径与原行为相同，
   原按钮不生成 inspector 检测文件，也不修改 provider model。

期望证据：请求路径/model、chat 次数、结果文件键（provider + model 二层，避免碰撞）、
原文与首行截图、超时耗时、vault 状态；不保存实际 key。

### N-I-03 落盘 / 重启 / 损坏 / 多键 / 写失败（AC-I05，V-I02/I06）

1. 两个 provider、各两个模型分别完成检测；每完成一行文件合并保留全部旧键。
2. 关 inspector 再开：读取旧结果、零 chat；完全退出进程再启动重复，仍有结果。
3. 截断隔离结果文件或去掉 required 字段：开 inspector 不阻断、无结果；点一次
   检测后合法文件重建，不修改 ai.json 或另一个有效 config 文件。
4. 同时检测不同 provider：结果不互相覆盖；单行重复点击最多一个在途 chat。
5. 结果目录只读：检测完成但持久化失败必须显形（不得声称已持久化成功），恢复权限
   后重测可写；保存/model 选择失败不能把高亮移到未保存模型。

文件 IO、host 权限和进程 cold restart 是 native 必测边界，browser localStorage
不能替代。文件操作仅在隔离目录；恢复权限后清理。

### N-I-04 网络策略与代理（AC-I08，V-I02/I06）

1. 开 full_local：cloud inspector 只读 cache/snapshot、检测和刷新/选择禁用并
   注明；直接调用 test IPC 也拒绝。计数证明零 cloud `/models` / metadata / chat。
2. local 仍可获取真实 loaded models、检测；完全禁用 AI 则任何新检测拒绝。
3. 请求在途切策略：记录在途/后续边界，切换后新 cloud 请求不得启动；Go 原有
   refresh cancellation 保留。检查禁用期间点击/重开不能发新流量。
4. proxy none：设置可观察的环境代理，仍直达假网关而不走该代理；
   manual/session 各用可观察代理确认目录和检测按配置路由；不改应用其它代理。
5. 无效 URL、空 manual、缺失/不可解析 session 均显形，不直连兜底。
   恢复正常代理后可刷新/检测，last-good 未丢。

证据：隔离网关/代理计数、错误截图/文件摘要；UI disabled 不等于零网络证明。

### N-I-05 local 生命周期（AC-I04，V-I01/I06；TC-AI-018）

1. llama-server 未启动：开 local 显示「本地服务未运行」+ 具体原因，不以无说明
   空表替代；不创建配置里尚未 loaded 的模型行。
2. 启动并加载模型，真实 GET /models 验证就绪，再刷新：行集恰为真实 loaded
   IDs、来源 live、protocol chat、未知 context/cost `—`。执行 TC-AI-018。
3. 假网关 `/models` 200/data=[]：空态说明，不是 unavailable；缺 data/坏 JSON/
   无 id/401/timeout 则不可用态。停止后再开，随后恢复并刷新可继续工作。
4. 若 loaded ID 不同于 configured model，check-current 禁用；检测 loaded 行
   发送该真实 ID，不擅自修改 current。显式选择后正常保存/highlight。

### N-I-06 batch / 并发 / 关闭恢复（AC-I05/I06，V-I03/I06）

1. 打开无自动 chat；点击「检测全部」显示逐个真实请求/额度提示，cancel 零 chat。
2. 确认后 server 控制每个响应 success/fail，验证顺序、一行完成即更新并落盘，
   不等全批结束才统一显示；连续重复 batch/单行点击无重复请求。
3. batch 中关闭 inspector 再开、切 provider：任务由 store 持有，旧 provider
   响应不污染新 provider；刷新先开始、检测后完成，迟到列表不抹掉较新结果。
4. batch 中切 full_local：之后 cloud 行不再发送请求，busy 最终清除。
   批量无另行“中途取消”控件（设计未要求），不要把关闭当取消。
5. 设为当前 model 保存失败/vault locked 显形，配置和高亮不动；恢复后重试成功。
   其它字段/api_keys/proxy/capabilities/groups/task routing 保持原语义，
   既有 fallback/聊天默认 consumer 使用新配置值，线程 pin 不被覆盖。

### N-I-07 Go 协议一致性（AC-I07，V-I01/I06）

1. 保存 Go protocol override 后同时开协议区和 inspector，逐行比较协议/来源；
   inspector 仅只读协议，不提供第二个 override 写入口。
2. chat/messages/responses/google 各选一行检测，网关看到对应 endpoint/auth/model，
   结果分别落盘；未知模型按 Go 已有规则，不自动换模型/改协议。
3. 刷新目录热替换、Go streaming 中再开 inspector，已有流能正常完成，
   元数据 fetch/cache 仍只有共享底座。保留 Go TC-AI-005～011 的约束。

### N-I-08 交互/三端/保留行为（AC-I01/I06/I09，V-I03/I05/I06）

Linux/Windows/macOS 每端相同步骤：
1. 所有 7 个既有 provider、Go，以及新增配置 provider 均开 inspector；
   行级 input、key、能力、proxy、测试连接和原 save 未丢失。
2. 表头全列、价格单位/零价格与 `—` 分开，中英语言各一轮；100%/高 DPI/
   窄设置页/57+真实 SiliconFlow 模型，横纵滚动到最后一行点击选择，
   按实际观察记录渲染/交互响应，不用 DOM 数量代替性能。
3. 当前行高亮置顶，已弃用中性显示、实时不存在行变灰但保留、来源四态不混淆。
   原错误首行截断与 title 完整值均可观察。
4. 键盘 Tab 操作入口/refresh/check/confirm/cancel/select/close，Esc 关闭
   inspector 并焦点回入口，不关闭外层设置/抢其它快捷键；无新 Action/快捷键
   注册（只使用面板 Esc），其它窗口输入路由保持。
5. 正常选择保存：设置 input 同步、关闭重开/重启仍为选中值、聊天无 thread pin
   时取新 default；原改 key/改 model/test/save 与 vault lock/retry 行为保留。

原生命令：`python -m qa_ui_auto run --mode native --filter TC-AI-018 --config <native-config> --require-pass`。
N-I-01～08 manual 逐步执行并记录 pass/fail/unrun；失败保留证据，不能替换为 skip。
未执行的 Windows/macOS 不得因为源码无平台 API 就标为通过。
