# v0.4：Review 核实、采纳与交接状态

- 来源：用户提交的5项设计风险、6项首版取舍建议，并授权对确认的问题按建议改进；另明确要求提供交互原型。
- 基线：`main@3fb5b06d9`，本轮只修改设计文档 / 原型，不实现产品、不提交 / 推送 / 发模型请求。
- 结论：**五项风险全部认可并处理；其中文件行数、依赖共享和部分候选语义调整采纳。**
- 后续状态：工程修正继续有效；用户随后指出v0.4 UI过复杂，已由[用户确认的v0.6会话式重建稿](developer-agent-ux-v0.6.md)替代。本文第3节原型 / 待反馈是历史记录，不再作为当前UI基准。

## 1. 五项风险逐条处理

| 编号 | 核实结论 | v0.4 改进 / 落点 | 验收 / 任务 |
| --- | --- | --- | --- |
| RV-01 表 / 模块过重 | 确认。原稿把完整领域模型过早投成20余表 / 17目录，阻碍纵向闭环 | [scheduler §8.1](scheduler-contract.md)唯一分期表：P0五表，P1A再三表累计8；P1B四表，P2三表。早期journal / 资源owner / 审批 / gate语义映射到typed列 / events / artifacts，不删除可靠性。首片4责任目录 | TASK-OR02 / V-OR02，防重 / 崩溃窗口测试，限制无空表 / 空服务 |
| RV-02 大JSON截断全损 | 确认；有效前缀可以保留，但不能把它当成功或绕过共享发布组 | [pack §5.2/7](packed-inference-and-code-context.md)默认NDJSON item/chunk/end，小记录增量parse；每item单独持久candidate，provider / group门另验。单JSON仅短结果；不支持server-strict-frame明确降级等级 / 拆小，用户严格要求不静默降级 | TASK-OR06 / V-PF01～05：末项截断 / 坏转义 / 任意SSE分块 / 重启，前项hash保存、无自动重发 |
| RV-03 codec文件边界 | 认可风险，**纠正事实：llm/mod.rs实际297行，不是731**；其余openai573 / anthropic433 | [protocol §2.1](llm-protocol-contract.md)：旧golden先行，request / stream / wire_types拆分，facade兼容，再加独立InvocationReceipt。新文件200–400目标、800硬限 | TASK-OR01/05，旧chat / Go回归 + boundaries / size；不把provider.rs的stream:false直接改true冒充完成 |
| RV-04 worktree依赖 / 缓存 | 确认；lockfile相同不足以安全共享node_modules，symlink也不提供只读 | [workspace-bootstrap.md](workspace-bootstrap.md)：Node/ABI/manifest/workspace/config/patches等指纹；pnpm共享store+私有布局为默认，托管只读快照须验证。Cargo target为可写pool，和Heavy在真实命令期原子锁；binary锁内归档 | TASK-OR07 / V-BS01～06：新worktree解析依赖、锁失配 / offline miss / proxy失败、同pool只启动一cargo、取消 / GC |
| RV-05 交接 / UI缺少 | 确认。此前只有架构 / UI文字，不能称已有原型或完整实施包 | 新增[P0/P1A交接](p0-p1a-implementation.md)：TASK-OR01～10、文件owner / 依赖 / AC / V / 真机手册；[可交互HTML](ui-prototype-v0.4.html)和截图；UI DEC-OR11待用户评审 | 后端可独立；TASK-OR09依赖图稿反馈。原型不是产品native行为证据 |

## 2. 六项首版取舍

按本轮“确认问题后采纳”授权收敛，不伪称用户已分别回答所有DEC：

1. **自治**：确认计划 / 模板后自动派发与局部验证；改计划、扩权、目标应用 / 合并人工确认。无界重规划不做；有限修复只有已批准流程且调用预算允许。
2. **后台寿命**：不做独立daemon；Rust AppState运行owner，panel/workspace/renderer生命周期无关；显式退出拦截、停止并保存，重启先对账；P3才驻留。
3. **首批执行器**：P1A独立API三协议 + CC；P1B Codex / PortableHandoff；P2 OpenHands/Aider等。CC是工程起点而非宣称成熟到可直接用；cwd / 取消 / permission / guard必须补合同。
4. **合包**：仅用户勾选 / 已批准模板；设计、静态审阅和总计≤3文本文件的有界patch，后者专项通过才启用。main1/aux0/recovery0，前缀候选保留；用户可确认一次补救，恢复范围依共享约束决定。
5. **Jev**：P2提供shadow / bounded_auto，默认shadow但服务本身须用户开启、授权辅助预算；aux0严格旁路。bounded_auto只在授权候选+硬过滤+校准门内；不会修改计划和权限。
6. **记忆**：模型提炼全为proposed；用户确认或受限schema的程序确定观测才approved。源版本、producer和scope必需；不让程序把模型说法换origin假装确定事实。

DEC-OR01～12与原D-O ID的对应见[主设计 §13](../development-orchestrator-design.md)。具体布局仍待反馈；P2选哪家外部执行器不阻塞P0/P1A。

## 3. 原型交付与真实范围

- 可编辑源码：[ui-prototype-v0.4.html](ui-prototype-v0.4.html)，本地浏览器直接打开，无构建依赖 / CDN / 请求 / 凭据。
- 创建 / 上下文预览：[截图](ui-prototype-v0.4.png)。
- 运行 / 计划 / 候选：[截图](ui-prototype-runs-v0.4.png)，HTML附 `?view=runs` 可直达。
- 恢复授权：HTML `?view=recovery`；退出拦截：`?view=exit`。演示按钮都明确标demo，不实际调用模型、终止进程或应用patch。
- 适用宽度：1440桌面稿与850以下堆叠布局；原型不重画整个Taomni主导航，旁栏为入口关系示意。

**待反馈的具体问题**：是否接受“创建页左任务/资料 + 右执行预算预览，运行页左列表 + 右计划/候选”的双视图？推荐此结构，避免将长上下文预览、运行日志、费用和记忆全部挤入同一屏。若希望在编辑器侧栏完成，需要另调窄面板密度；不影响后台数据契约。

## 4. 设计完成度与验证边界

- 设计状态为**部分可实施**：core / codec / framing / bootstrap工作包边界已列，UI未获得本轮布局反馈。不是等待一个泛泛“全部批准”，而是仅OR09布局定稿需要反馈。
- TASK当前均pending，未领取 / 未实施；没有因用户要求原型而停下review修正。
- 原型已用本机headless Chrome本地渲染，创建 / 运行截图均视觉检查。CDP交互检查通过：正文预览、可选源、执行确认、3成员计划、2候选不跳共享组、补救确认 / 单次按钮、退出拦截；1440及780px无横向溢出。零Runtime exception、零页面HTTP / WebSocket请求（不包含浏览器自身服务）。这些不是产品WebView / 后端 / native行为证据。
- 文档仅做链接、源码行号、围栏 / 空白及source-size检查；没有新增数据库 / codec / Bootstrap实现来跑行为测试，不虚构通过。
- 既有 `pnpm check:refactor` 缺typescript环境问题保留，不能因此报完整产品检查通过。编码阶段必须使用仓库要求的Node22 / pnpm10并补齐所有实施验收。
