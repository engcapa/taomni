# 有限恢复实施与 review 修正报告

2026-10-15。本轮按 review 的 5 个问题修正产品代码，仅执行本机单元测试和静态检查。
Windows/macOS/Linux 的 browser/native 用例已补充，全部 **unrun**；未启动测试应用、
浏览器 runner、故障注入、真实服务或性能负载，未操作历史白屏 Taomni 实例。

## 本轮基线与范围

- 修正基线：`4fee990c`，分支 `docs/terminal-performance-and-renderer-recovery`。
  最终候选为该 HEAD 加本轮工作区 diff。恢复功能整体的性能基线仍为 `75d78f9d`。
- 本机：Linux x86_64；Node 24.18.0、pnpm 10.30.0、rustc 1.98.0。
  CI 使用 Node 22，本轮没有以本机版本替代 CI/三平台运行证据。
- 保留 DEC-08/09：前端性能优先、小范围有限恢复，复杂或不安全的状态明确提示。
  独立终端文本镜像优化没有改动；不以该优化抵消 recovery 开销。

## 5 个 review 问题的修正

| 问题 | 结果及错误/并发处理 |
|---|---|
| #1 原生退出跳过 SocksCap 清理 | 原生恢复选项复用 `exit_app`。应用级 ExitGate 串行化退出：prepare_for_exit → 等待异常录屏收尾 → Closing → app.exit；既有退出备份继续生效。清理失败显示实际错误，应用保持存活，gate释放允许重试。取消的异步退出不永久占用gate。 |
| #2 录屏返回路径丢失、临时文件误删 | 控制界面死亡时先在截图owner锁内接管录屏并移出临时清理名单；Stop、在飞编码、预览共用一个收尾结果。完成后有界流复制到 app-local-data/recovered-recordings/UUID，flush后发布，原生提示实际路径。关闭控制窗/退出不会删成功文件；失败给出实际错误和可用临时路径，不承诺成功。正常帧循环未修改。 |
| #3 稍后处理/节流后没有重试入口 | 异常时退出全屏、启用系统标题栏。系统关闭按钮始终可重新打开原生选项：失败可重试/退出/保留，恢复中或ready可退出/保留；Windows browser死亡继续限制重试。60秒节流提示准确说明再进入方式，无定时自动重试。窗口身份+generation令牌拒绝已销毁/替换窗口的旧对话框和timeout。 |
| #4 分离终端丢失原ID | 元数据读取健康窗口中的实际logical tab及terminalRuntimeByTab，复用原PTY ID；不把route/handoff ID当作session/config ID，不读取过期凭据或复制snapshot。缺失真实身份时保留未知提示。 |
| #5 中文/emoji标题使整批描述失败 | 前后端统一512 UTF-8字节标题预算；按code point有界扫描，替换孤立surrogate，不切半emoji。不截断身份产生碰撞，非法ID不会阻止其他标签更新。同ID的activity变化提前跳过，标题不随输出量重复构造。 |

附带完成两个直接相关的生产缺口：修正 Linux WebKit 的 `WebViewExt` 导入，使完整
crate 能编译；恢复界面按用户点击查询现有 Servers/隧道/SocksCap 状态，三个查询
相互独立，单项错误可重试，不启动/停止/修复服务、不自动查询、不加轮询。
该组件仅在恢复分支加载，状态视图每类最多128项，超过显示上限明确提示。

## 恢复能力和设计取舍

已交付三端原生退出hook、小型标签描述与启动握手、原window输出撤销、显式只读
接回原PTY后续输出、全21种TabKind的限制说明、Outbox与重复副作用隔离、失控
语音/native AV停止、录屏安全收尾，以及简单后台工具的按需只读查询。
26个session/21个TabKind/9个Tools映射仍以 recovery-policy-matrix.md 为准。

自动reload继续关闭，等待原生reload/Channel队列实证。Windows browser进程死亡
只提示。当前不实现终端检查点/500行历史重放或可交互TUI：Serialize原型的
CSI/OSC/DCS/UTF-8半包反例尚不能低成本安全解决；观察仅为最多64K字符的后续
输出，不冒充画面/光标/输入模式恢复。不自动新建PTY、SSH认证、发送startup。

数据库/邮件/文件传输等中间结果不明时保留限制，不自动重连或重挂载可能带副作用
的业务组件；已保存内容不被空状态覆盖，但不声称所有草稿已在恢复页重新读出。
Servers/隧道/SocksCap有现成只读接口，故提供显式读取；更昂贵的控制面迁移、
任务注册/事件重放、逐字符草稿镜像继续排除。符合用户允许高成本恢复降级提示的取舍。

## 本轮实际验证

前端：

```bash
pnpm exec vitest run \
  src/lib/runtimeRecovery.test.ts src/lib/recoveryTerminal.test.ts \
  src/components/recovery/RecoveryWorkspace.test.tsx \
  src/components/recovery/RecoveryBackgroundStatus.test.tsx \
  src/lib/recoveryPolicy.test.ts src/lib/detachedSession.test.ts \
  src/components/detached/DetachedSessionWindow.test.tsx \
  src/components/terminal/TerminalPanel.test.tsx
pnpm exec tsc --noEmit
```

8文件 **133 passed，1 skipped**。skip为已有终端文本镜像构建模式条件，不是新增
规避。TypeScript通过。新增测试包含Unicode边界/孤立surrogate/超长标题、分离
路由与原ID不同、缺交接、1000次activity不读标题/不增加IPC、待提交IPC只合并
最新元数据、工具查询去重/部分失败/手动重试/离开页面/10分钟无自动轮询。
本地计数不变量不等于真实UI时延或吞吐测量。

Rust：

```bash
HTTP_PROXY=http://10.1.0.80:3228 HTTPS_PROXY=http://10.1.0.80:3228 \
  cargo test --manifest-path src-tauri/Cargo.toml --lib --locked --offline -- \
  webview_recovery:: app_exit:: screenshot::record::tests:: screenshot::recovery_file::
```

完整默认feature的Linux crate编译、链接成功；定向 **30 passed，0 failed/ignored**。
包含退出顺序/失败/并发/取消、旧窗口令牌、节流再进入、原生按钮返回映射、UTF-8
描述预算、真实临时文件复制/失败不覆盖/临时目录删除后保留、异步收尾等待、
Stop/active/preview接管竞态，以及原有GIF/MP4编码解码单测。没有采集真实桌面或
启动Tauri应用。初次编译发现原实现 `webkit2gtk::prelude` 不存在，修复后通过；
日志保留失败记录。cargo offline不阻止build.rs下载，所需依赖通过指定代理取得。

静态检查：

- F1.10 audit gate通过，18/18控件有用例触达；catalog同步。
- 9个恢复YAML的schema和reviewed行为契约检查通过，0 gaps。
- TC-RECOVERY-006/008/009选定CI plan生成三端browser/native六个lane，未运行。
- 工作区diff调用dev_contract.evaluate通过，产品变更、QA case及单测同时可见；
  CLI只比较committed refs，本轮没有用HEAD对HEAD伪造变更验证。
- 新增/修改恢复模块和record.rs的定向rustfmt检查通过，其他大文件只格式化改动区。
  全仓cargo fmt --check仍报告基线文件格式差异（如VNC、voice、integration），
  不为此重排整个仓库。git diff --check通过。

本轮证据：`qa-ui-auto-report/recovery-fixes/`（忽略、不提交），主要为
`unit-final.log`、`typescript-final.log`、`rust-verified.log`、`rustfmt.log`、
`dev-contract.md`、`case-contracts.txt`。以前报告的135项、纯状态机5项及依赖下载阻塞属于旧轮次，
不叠加到本轮计数，也不再视为本轮完整crate的阻塞。

## 三端与性能用例交接

更新TC-RECOVERY-006三端冷启动回归，新增008分离恢复/Unicode显示和009工具
只读查询；policy/dependencies/feature-list/catalog同步。原生手册增加N10–N14，
覆盖三端安全退出/网络清理、持续可用重试、录屏真实文件与并发、分离ID/UTF-8
投影、Tools及性能。细节见 [测试映射](test-cases.md) 和
[原生用例](../../../qa-ui-auto-tests/native/webview-renderer-recovery.md)。

全部9个browser YAML和14个原生手工场景均未执行（006也声明native）。
原生手工场景不冒充runner支持的kill/dialog verb。性能分别比较恢复整体基线和
本次修正基线，包含真实release、1/4/16终端、长标题/128标签、输入与帧尾延迟、
吞吐/CPU/RSS/IPC/分配、录屏流式保存与72–96h长时。任何可重复退化都失败，
不放宽门槛、不用文本镜像优化抵消。当前没有三端实测、性能未退化或GC根因已修复的声明。
