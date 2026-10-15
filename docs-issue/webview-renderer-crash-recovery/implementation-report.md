# 有限恢复实施报告

日期：2026-10-15。**已交付受限实现，不宣称执行计划的原生/性能验收全部完成。**
用户授权开发并限定：本地单元测试；browser/native仅编写、不执行。
未接触历史白屏实例，未启动测试原生应用、故障注入、SSH/其他服务实验或性能负载，
未重启项目workflow，未执行browser/native runner或截图检查。

## 1. 实际源码基线

- R0源码：`75d78f9d7e47f215e3c0726aff65cc4ebd46e79c`，开始时`git status --short`为空。
  这是本次开发基线，不是旧诊断release，也不是设计原记录的`a11c227c`。
- 单测环境：Linux x86_64 / kernel6.18.56、Node20.20.0、pnpm10.26.1、
  rustc1.88.0。未采集真实加载WebView库、native build flags、PID/配置目录或
  二进制hash，因为本轮不启动/故障注入native实例。
- 未取得R0/R1原生性能原始样本，因此**不能写“无性能退化”**；
  后续对照必须保持终端文本镜像优化状态一致。独立文本优化feat未在此开发。

## 2. 已实现

| 工作包 | 实际交付 |
|---|---|
| TASK01 | Linux web-process-terminated、macOS公共Tauri hook、Windows ProcessFailed接线；GPU/frame/unresponsive不当作renderer死亡；main/普通分离/SFTP入口注册；主循环排队；原生提示、手动重试节流、15秒ready超时、失败/close代次状态机；release专用匿名低频轮转日志 |
| TASK02 | 启动业务组件前IPC握手；主进程instanceId/窗口上下文/版本/revision；只提交标签id/kind/title/已保存配置引用/已知terminalID；128标签、字段长度和全窗口1MiB描述预算；无正文/凭据/全store快照、无恢复定时器 |
| TASK03 | dev-only官方SerializeAddon0.14.0、MIT、headless xterm6.0.0能力原型。完整普通屏/500历史、备用屏/公开mode、80×24/160×50/240×80/400×80、resize差分；CSI/OSC/DCS/UTF8半包反例成立。无打包WebView成本证据，不进入生产快照 |
| TASK04 | 输出订阅带真实调用window归属；死亡撤销该window旧Channel，不删PTY/SSH；异步create/attach的旧generation不再注册；恢复UI可显式复用attach观察原ID后续输出；清理仅自己的window/channel，晚到attach也清理；无write/resize/startup/认证；观察最多64K字符，非VT屏幕 |
| TASK05 | 独立恢复shell不mount普通业务组件，防数据库rollback/disconnect、对象存储close、自动connect/Outbox/宏/AI/下载等重复动作；21种TabKind及未知类型说明；Mail普通组件也有恢复Outbox守卫，冷启动保留旧契约；语音/native AV失去控制时停止，inflight start带窗口代次核对；录屏/scroll控制窗口只detect-and-stop，沿已有收尾保留文件，不通用reload/销毁覆盖层 |
| TASK06 | 定向本地unit与静态检查；7个可执行QA YAML、CI策略/依赖/feature/control目录；9个详细native手工/外部场景；AC/V与26/21/9分类映射 |

正常close/detach/归位沿既有入口，恢复不是关闭资源的原因。
死renderer下关闭窗口由原生确认“退出应用/保留后台”；确认为应用退出，
取消继续后台。原生退出仍沿既有backup scheduler，不另造后台任务管理器。

## 3. 明确未启用/降级

1. **没有默认自动reload**。执行计划要求先证明原生reload/Channel队列清理及
   平台行为，本轮无此证据。检测后先原生提示；用户可手动重试有限界面。
   Windows browser进程退出仅提示，不侵入Tauri内部重建。
2. **无生产终端检查点、有界字节重放或可交互TUI恢复**。
   部分完整状态能序列化，不等于任意半包/前置过滤/外部副作用可隔离；
   原型明确存在反例，且没有真实WebView成本测量。生产保持只读/受限，
   不注入Ctrl+L、不伪装纯文本为完整画面、不修改正常scrollback。
3. **未自动重连任何恢复客户端，也不自动重挂载业务控制页**。
   当前恢复shell显示标签/选中项/对应限制；保存的草稿与文件不被空值覆盖，
   但未声称在恢复shell中已重新读出所有业务内容。
   服务/隧道/SQL/传输/AI原生任务没有为恢复而stop/restart。
4. 描述可能落后、缺失或超预算；在飞创建不重新创建。记录对象存在、
   attach成功、静止无输出不能证明真实PID仍运行。结束/缺失会话不自动替代。
5. native音视频没有廉价per-renderer归属查询，主窗口死亡时选择安全停止现有
   native媒体会话；这是隐私与失控采集的保守取舍，不声称通话无损恢复。
   独立录屏/scroll控制窗仍活着时沿原控制；其renderer退出则请求安全停止。
6. 不恢复非持久表单/文件编辑/宏续发/未保存草稿，不升级引擎/框架、
   禁JIT或周期重启；不新增通用任务表、全操作幂等或事件重放系统。

这些限制可在UI/原生提示中看到；不是“全部恢复通过”。

## 4. 本次实际检查

### 本地前端unit/mounted与保留行为回归

```bash
pnpm exec vitest run \
  src/lib/runtimeRecovery.test.ts src/lib/recoveryTerminal.test.ts \
  src/components/recovery/RecoveryWorkspace.test.tsx \
  src/lib/terminalRecoveryPrototype.test.ts src/lib/recoveryPolicy.test.ts \
  src/lib/detachedSession.test.ts src/components/terminal/TerminalPanel.test.tsx
pnpm exec vitest run src/components/mail/MailClientTab.test.tsx \
  -t 'automatic Outbox sending|Outbox and sends|keeps a message in the Outbox'
pnpm exec tsc -b --pretty false --noEmit
```

- 7个测试文件：**131 passed，1 skipped**。skip是既有TerminalPanel文本镜像
  按构建模式的条件测试，没有为本任务新增skip。
- Mail定向：**4 passed**；其余44项因`-t`未选中，不是44个环境skip。
- 合计本次定向有效执行 **135 passed**。TypeScript检查通过。
- 原型是Node/headless单元测试，不是browser或native用例执行，也不是性能证据。
- 开始时照旧文档使用`pnpm test -- <文件>`，本环境将额外`--`传给Vitest，
  意外开始了非定向unit集合并超时；期间观察到其他模块失败，未做基线归因，
  **不把该次运行描述为全套通过或既有缺陷**。之后改用以上精确命令，
  未通过重跑/过滤宣称完整suite通过。

### Rust与原生边界

```bash
rustc --edition=2021 --test src-tauri/src/webview_recovery/lifecycle.rs \
  -o /tmp/recovery-lifecycle-tests
/tmp/recovery-lifecycle-tests
cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline webview_recovery
```

- 独立编译**实际生产状态机源文件**：**5 passed**，包括重复/节流、close优先、
  旧代次ready/timeout拒绝及死亡后的旧订阅拒绝。
- 整个Rust crate单测：**blocked**，离线依赖缺少`ironrdp-nscodec`，
  尚未进入编译。adapter/IPC/采集模块及新增4个描述验证Rust单测
  **未取得完整crate编译/执行证据**，不以5个纯状态机测试替代它们。
- 修改的恢复adapter/语音/screenshot/LanChat已做Rust语法解析，
  不等于Rust类型检查、链接或任何三平台编译通过。

### QA静态交付检查

- 7个新增YAML schema及verification索引检查通过。
- 官方`contracts --gate`定向检查：7/7 reviewed，0 gaps；仅代表行为映射结构通过。
- 生成后的testid目录check一致；F1.10定向`audit --gate`通过：
  **16/16控件均有用例触达，无本feature actionable gap**。
  全仓仍有1个无归属selector，非本feature，不将其当作本次运行缺陷或修复。
- selected CI plan识别7个ID及browser/native模式，未启动执行。
- 这些检查只证明目录/契约结构，不提供运行pass。
- `git diff --check`通过。

## 5. Browser/native交接

详见[test-cases.md](test-cases.md)与
[原生手册](../../../qa-ui-auto-tests/native/webview-renderer-recovery.md)。

7个YAML全部unrun（TC-RECOVERY-006同时声明browser/native）；
9个原生手工场景全部unrun，包含原生事件/对话框、三端、后台PID/端口、
结束/zombie、Windows browser退出、共享renderer、队列、采集、真实请求计数、
正常detach/关闭、日志轮转及真实release性能/96h。
无浏览器、原生故障或“自然GC已修复”的声明。恢复只减少持续白屏风险，
不修复尚未归因的JSC内部堆损坏。
