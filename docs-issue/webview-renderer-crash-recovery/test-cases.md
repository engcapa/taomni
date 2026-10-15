# 测试设计与实施映射

本文件维护执行计划 TASK-06 的测试交接。**browser/native 全部未执行**；
按本次用户要求仅执行本地单元测试，另做静态类型/目录检查。
运行结果见 [implementation-report.md](implementation-report.md)。

## Review 修正增量（2026-10-15）

| 问题/要求 | 本地单元测试 | browser/native用例（只编写，三端全部unrun） |
|---|---|---|
| #1 网络安全退出、失败/并发/取消 | `app_exit.rs`三个测试 | N10；006保护正常启动，N04保护关闭/归位 |
| #2 录屏所有权和持久文件 | `record.rs::recovery_owns_active_inflight_and_preview_files_through_close_and_exit`、`recovery_file.rs`三个测试及原有编码/解码测试 | N11，MP4/GIF、三端权限和真实文件、关闭/退出/预览竞态 |
| #3 原生重试持续可用、节流与旧回调 | `webview_recovery`对话框/生命周期测试 | N02/N10，三端系统标题栏、Later、15秒超时、60秒重试、旧窗口身份 |
| #4 分离原PTY身份 | `runtimeRecovery.test.ts`两种route、runtime/交接缺失 | TC-RECOVERY-008仅描述消费；N12证明真实投影/TTL/PTY |
| #5 UTF-8预算与标题工作量 | frontend字节/emoji/surrogate/超长/非法ID；Rust描述预算 | TC-RECOVERY-008显示；N12/N14真实提交、其他标签继续更新、长标题成本 |
| Tools低成本读取 | `RecoveryBackgroundStatus.test.tsx`按需/失败/重试/迟到/无轮询 | TC-RECOVERY-009；N13真实查询/无start-stop副作用 |
| 正常前端性能不退化 | runtime元数据合并、1000次同IDactivity不读标题且0额外IPC；工具10分钟无轮询 | N09/N14和B-PERF；整体/增量双基线，三端真实release配对，不能用单测代替性能实测 |

TC-RECOVERY-006/008/009显式声明Windows/macOS/Linux browser；006同时声明三端native。
N10–N14的操作、失败/取消/清理、平台差异、证据和性能门槛完整写在原生手册。
没有原生对话框/进程故障的跨平台runner verb，因此保留为可复现手工用例，不伪造自动化。
本轮单元结果为前端133通过+1既有模式skip、Rust30通过、TypeScript通过。

## 测试范围与策略

目标：原生退出提示、后台保留、轻量描述、恢复握手、只读接回、
副作用隔离、原生采集安全收尾。保留：冷启动Welcome、正常PTY创建/
CWD/startup/输入/复制/导出、detach/归位/关闭、正常Outbox定时发送。

当前交付没有自动reload、500行检查点、可交互TUI恢复、自动客户端重连。
能力/性能未证明的分支按DEC-09提示；不把它们记成实现或验收通过。
恢复shell不挂载正常业务组件，是所有副作用类共享的守卫，不需迁移各业务
IPC/事务/草稿系统。类型级 `Record<TabKind, string>` 穷举21项且未知类型失败关闭。

## 用例索引与AC/V映射

| AC/V | 实际路径与稳定ID | 层/模式与断言 | 当前状态 |
|---|---|---|---|
| AC03/06，V01/04 | `src/lib/runtimeRecovery.test.ts`；Rust `webview_recovery/lifecycle.rs` | 有界描述、instance/版本、重复/迟到/timeout/close、旧generation拒绝 | 本地unit，见结果 |
| AC01/02/05/10，V03/05 | `src/lib/recoveryTerminal.test.ts`；`src/components/recovery/RecoveryWorkspace.test.tsx` | 原ID、显式只读、停止/切换/迟到attach、无业务fallback、StrictMode一次ready | 本地unit |
| AC04/07/10，V02 | `src/lib/terminalRecoveryPrototype.test.ts` | 真headless xterm6+SerializeAddon0.14，完整普通/备用屏/模式/resize/500历史；半包反例 | 本地unit原型，非WebView性能 |
| AC02/12，V10 | `MailClientTab.test.tsx` 的 `automatic Outbox sending` 两个测试 | 真实组件timer从mount前控制；冷启动发送，恢复3100ms/60000ms不发送 | 本地mounted unit |
| AC05，V05 | `src/lib/detachedSession.test.ts`、`src/components/terminal/TerminalPanel.test.tsx` | 已有正常交接、关闭、终端行为 | 本地unit回归，已有skip单列 |
| AC03/10/12，V01/10 | `TC-RECOVERY-001` YAML | 描述选中/顺序、SQL/邮件/传输/AI限制、无Welcome/普通终端mount | browser，unrun |
| AC02/03/10，V01 | `TC-RECOVERY-002` YAML | 缺描述/在飞未知，不新建；空状态UI | browser，unrun |
| AC01/02/04/05，V03/05 | `TC-RECOVERY-003` YAML | 只读接回必须点击，停止/再观察，明确非旧画面、无输入框 | browser，stub输出，unrun |
| AC01/10，V03 | `TC-RECOVERY-004` YAML | 原会话结束/缺失/attach失败，不创建替代shell | browser，unrun |
| AC03/06，V01 | `TC-RECOVERY-005` YAML | 不兼容bootstrap阻断业务，不猜冷启动 | browser，unrun |
| AC03/05，V05 | `TC-RECOVERY-006` YAML | 保留冷启动Welcome；native真实IPC握手另验证 | browser/native，unrun |
| AC10/11，V05/09 | `TC-RECOVERY-007` YAML | 21种TabKind+未知类型；逐标签策略；Tab/Enter真实键盘选择 | browser，unrun |
| AC01/06/08/09，V03/07 | native手册 `TC-RECOVERY-N01` | 三端事件/renderer与browser分类、原生提示/release日志 | native手工，unrun |
| AC03/05/06，V01/04 | `TC-RECOVERY-N02` | 代次/timeout/close/repeated/hidden/sleep/inflight、多窗口 | native手工，unrun |
| AC01/02/04/10，V02/03 | `TC-RECOVERY-N03` | 真PTY/PID/SSH；输入禁用、输出观察、结束/zombie、TUI半包限制 | native手工，unrun |
| AC02/05/07，V05 | `TC-RECOVERY-N04` | 正常startup/CWD/输入/复制/导出/关闭/detach/归位、特殊入口 | native手工，unrun |
| AC01/03/11，V09 | `TC-RECOVERY-N05` | 服务/隧道/端口/PID保持、客户端不误停/重连 | native手工，unrun |
| AC02/10/12，V10 | `TC-RECOVERY-N06` | SMTP/SQL/传输/AI/宏请求计数、saved文件hash、未保存状态限制 | native+本地fixture，unrun |
| AC05/12，V10 | `TC-RECOVERY-N07` | 主语音/native AV停止；录屏/scroll检测仅停止不替换；保留文件 | native设备/窗口，unrun |
| AC01/07/10，V03/06 | `TC-RECOVERY-N08` | 原window/channel撤销、迟到订阅、描述/观察预算、Channel队列 | native手工/外部观测，unrun |
| AC07，V06 | `TC-RECOVERY-N09` | 真releaseR0/R1配对性能、不同负载尺寸、Linux96h | 原生性能，unrun |

YAML均在 `qa-ui-auto-tests/cases/TC-RECOVERY-*.testcase.yaml`，
`covers: F1.10`、fixtures/modes、verification actions/checkpoints/results已声明，
policy/dependencies已注册；控件目录同步。native详细有序步骤、前置、真实
服务要求、各步骤可观察结果、证据和隔离清理在
[原生手册](../../../qa-ui-auto-tests/native/webview-renderer-recovery.md)。
当前runner无安全进程故障注入/系统原生恢复对话框专用verb，
因此手册明确手工/外部层，不新增虚构verb、不skip冒充通过。

## 26/21/9覆盖分类

完整原始定义与特有边界沿用 [recovery-policy-matrix.md](recovery-policy-matrix.md)。
本次实现选择的路径不是矩阵中所有候选重连能力都已实现。

| SessionType（26） | 本次结果 | 必须保留/禁止 |
|---|---|---|
| SSH/Telnet/Rlogin/FTP/Serial/LocalShell/Mosh（7） | 有已知terminalID时允许显式原会话只读观察；其他状态未知提示 | 不新建/认证/重跑startup/串口写入/重传 |
| RDP/VNC（2） | 描述与限制；不自动重连 | 不注销、不重放输入/剪贴板 |
| SFTP（1） | 描述与未知传输说明 | 不关闭原任务/重启传输 |
| File/Browser（2） | 已保存/外部资源不受主动清理，说明未恢复项 | 不打开新浏览器/OAuth/重放文件操作 |
| MySQL/PostgreSQL/PanWeiDB/Oracle/SQLServer/StarRocks/ClickHouse/Presto（8） | 共同database说明 | 不disconnect/rollback/COMMIT/重发任意SQL |
| Redis/HBaseShell/Proxy（3） | 各类型受限说明 | 不将HBase当PTY、不重发写入或测速 |
| Mail（1） | 发件箱暂停并提示，正常冷启动保留 | 不补发SMTP；已保存草稿不写空值 |
| S3/AzureBlob（2） | 未知任务/文件结果说明 | 不取消/重启对象传输 |

TabKind（21）全部在生产策略映射及TC-RECOVERY-007覆盖：
terminal/sftp/rdp/vnc/nettools/sockscap/welcome/settings/placeholder/file-browser/
database/redis/hbase-shell/proxy-test/object-storage/lan-chat/git/mail/mail-unified/
code-workspace/mfa。共同隔离shell不启动普通页面，因此不会触发隐藏连接风暴。
说明可见的browser测试不等于各协议真实服务副作用已验证。

Tools（9）仍沿原矩阵分类：servers/tunneling/sockscap/git/code-workspace/
mail-unified/lan-chat/mfa/tools。后台服务/隧道不start/stop/repair，
前端续发/宏不恢复，占位/games不重挂载；采集按原生控制丢失路径收尾。
各命令精确标识沿源矩阵（不将文档类别名冒充新增命令）。
代表性真效果见N05/N06/N07，全部unrun。

## 交互维度

| 维度 | 覆盖与边界 |
|---|---|
| UI | metadata selected/missing/unknown/attach error/handshake error、恢复范围说明、无输入状态；截图仅证据，不是视觉评审 |
| Controls | 每个恢复标签点击、observe开始/停止/连续操作、切换清理；原生重试/稍后/退出/取消见N01/N02 |
| Actions | 新增恢复操作仅原生dialog与普通button，不新增toolbar/menu/palette；现有退出/窗口交接走N04 |
| Shortcuts | 新shell的Tab/Enter选标签；没有新增快捷键；原生产F5/CtrlR与旧终端shortcut保留见N04，未实测 |
| Lifecycle | cold/recovery、StrictMode、缺描述、stale、timeout、用户close、late attach、结束会话、多window与特殊采集 |
| Performance | 无生产serialize/tail/checkpoint/周期扫描；正常输出无逐块新IPC；这一结构约束不等于实测无退化 |

## 未来执行方式（本轮未调用）

Browser用已核对的 `.agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml`：

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run \
  --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml \
  --mode browser --filter TC-RECOVERY --require-pass
```

需预先启动该config所指本checkout的Vite；本轮不启动/重启服务来执行用例。
native冷启动用本地隔离QA config选择精确ID TC-RECOVERY-006，其他场景按
原生手册执行，不用browser stub填充原生证据。
每次报告与receipt需匹配源码/case/runner/build/config和平台身份；
未来编译通过不等于事件/PID/设备/性能用例通过。
