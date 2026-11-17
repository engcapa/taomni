# 原生还原确认与自动重启验证

本验证补 TASK-024/025 的真实还原入口，不改变业务 owner 或升级激活门。原有 TC-MODULES-013/014/015 使用生产 staging IPC 加正常冷启动，证明三态数据/Vault/MFA 还原与后续正常重启；它们不证明还原确认按钮自己的自动 relaunch。browser TC-BACKUP-RESTORE-001 只证明 renderer 的确认、密码错误与重复提交状态。

## 场景和断言

| 用例 | 备份和还原时模块状态 | 原生范围 |
|---|---|---|
| TC-MODULES-033 | 运行中 | macOS 直接启动的 QA WKWebView bridge |
| TC-MODULES-034 | 已禁用 | 同上 |
| TC-MODULES-035 | 已卸载，保留数据与 locator | 同上 |

每项从隔离空 profile 开始，经真实 UI 安装当前源码的官方签名 hello、创建 RFC HOTP 和手工本地 v2 备份。独立 oracle 核验准确 job、ZIP、全部文件 hash、模块 SQLite 与配对 Vault/MFA；然后更改真实宿主数据、推进 HOTP、重设主密码，并恢复该场景的生命周期。Settings 从这个本地任务打开原备份，原生确认拒绝旧的当前主密码且不 staging；正确密码之后只点击一次真正的还原确认。

`native_confirm_restore_relaunch` 必须观察到 staged 成功、确认禁用及原进程 exit=0，再核验新 bridge listener 的不同内核 PID/start-time、同一可执行文件和完全相同的 data/config/cache、bridge host/port。只从内核读取这几个环境键，不归档完整环境或命令行。macOS 的 POST /session 仅连接已经运行的 bridge；探针不调用 driver.start、应用 spawn、还原/重启 IPC、DELETE 或 native_restart_app，也不重置 fixture 或重写存储。

接管后独立检查原模块行、原 active code 指针、推进后的 generation、正确 writer lease、清理后的还原状态，以及新密码被拒绝、原密码解密原账户和 HOTP 755224。原 renderer 和重启后的 renderer 分别断言运行时无错。保存原始进程记录、case receipt 和截图；截图仍需视觉复核。

## 所有权与限制

清理只接管通过验证的新 PID、内核启动时间和可执行路径，发信号前再次核对，PID 复用不授予清理权限。新进程已由旧应用创建并成为孤儿，Python 无法回收其真实退出码；清理记录明确返回退出码不可观察，不伪造 0。原 013/014/015 的正常退出断言不放宽，这三项也不以接管后的手动冷启动冒充第二次正常退出证据。

Linux WebKitWebDriver 和 Windows WebView2 的自动 relaunch 后接管仍待实现；不能用会再次启动应用的 POST /session 替代。LLDB 包装进程也不能当作应用本身的退出码。当前 case 仅声明 macOS，不代表所有 macOS 版本、Intel/ARM64 都已验证，也不证明独立 MFA 宿主迁出、legacy exporter 或单体升级激活完成。

## 执行状态

本地仅执行工具单元和 schema/behavior contract、catalog/refactor 静态检查。真实应用、进程、文件还原和三态自动 relaunch 全部留 GitHub `qa-ui-auto-platforms`，包含完整 crash-regression，并在运行中下载完成的 shard。

[matching UI #44043206496](https://github.com/engcapa/taomni/actions/runs/44043206496) 绑定 `fa17261e4582f84c645bf41658949592767547ec`，selection 为 `f0c687845e4a473da0bcdd72862947d6`。实际计划含 macOS ARM64 native 32 项（包含 033/034/035），browser 三端各 19 项，Linux Xvfb/Wayland 与 Windows native 各 29 项；gaps=[]/unreviewed=[]。已启动即时收证，新增用例尚待 matching runner 结果；不能把静态审查或工具模拟写成原生通过。

2026-11-17：#44043206496 的 macOS 033/034/035 原始失败均停在备份清单断言，尚未执行自动 relaunch。原失败 DOM 有多份真实本地任务；未限定任务的 selector 点击了另一份自动备份。修正 oracle 仅在独立核验准确手工 job、ZIP/全部 hash、原 HOTP counter 和配对 Vault/MFA 后公开该 job ID，三项用例通过对应 `backup-cloud-job[data-job-id]` 打开原任务。保留全部后续密码、staged、exit=0、新 PID/generation 和业务断言；增加工具单元同时检查三项用例的精确 UI 选择。修正后的真实自动重启仍待新 GitHub 结果，原失败不改写为通过。

精确任务选择修正已提交 `56d9a305641f7dc478212d01042e8f5009fe2b11`，[macOS 定向复验 #44050634191](https://github.com/engcapa/taomni/actions/runs/44050634191) 已启动，保留三态普通冷启动与完整 crash-regression；结果继续按完成 shard 收取。

该轮 browser 4 片共 18/18 通过。已完成 native 片中 013/014/034/035 在观察器公布备份 job ID 时抛出 `NativeStepContext.values` 不存在，尚未执行自动 relaunch；同轮 FILE-OPEN-002 另有 ResizeObserver 通知失败，保留原始证据。观察器现通过 native 的 `fixture_context.values` 更新模板变量，browser 继续使用其原 fixture owner；使用实际 `NativeStepContext` 与 browser context 的单元先复现 native 红测，再验证两种上下文均能发布独立核验的任务 ID。密码、真实进程 relaunch、generation 和数据断言保持，修订后须重新在 GitHub 执行。

#44050634191 最终 8/8 shards 均已下载并核验全部 case artifact 的 hash/bytes：browser 18/18；native 21/28，013/014/015/033/034/035 均为上述上下文错误，另有 FILE-OPEN-002 的 ResizeObserver 失败，没有自动重启通过证据。修复提交 `5cbd077c158cbdfcc4480607bcaf142e5c60edad` 已进入 [#44058015738](https://github.com/engcapa/taomni/actions/runs/44058015738)，与文件功能和完整 crash-regression 共用三端 release QA 构建；macOS ARM64 native 明确选择六项还原用例，继续逐完成片收证。
