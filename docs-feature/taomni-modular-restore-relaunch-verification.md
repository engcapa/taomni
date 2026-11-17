# 原生还原确认与自动重启验证

本验证补 TASK-024/025 的真实还原入口，不改变业务 owner 或升级激活门。原有 TC-MODULES-013/014/015 使用生产 staging IPC 加正常冷启动，证明三态数据/Vault/MFA 还原与后续正常重启；它们不证明还原确认按钮自己的自动 relaunch。browser TC-BACKUP-RESTORE-001 只证明 renderer 的确认、密码错误与重复提交状态。

## 场景和断言

| 用例 | 备份和还原时模块状态 | 原生范围 |
|---|---|---|
| TC-MODULES-033 | 运行中 | macOS 直接启动的 QA WKWebView bridge |
| TC-MODULES-034 | 已禁用 | 同上 |
| TC-MODULES-035 | 已卸载，保留数据与 locator | 同上 |

每项从隔离空 profile 开始，经真实 UI 安装当前源码的官方签名 hello、创建 RFC HOTP 和手工本地 v2 备份。独立 oracle 核验准确 job、ZIP、全部文件 hash、模块 SQLite 与配对 Vault/MFA；然后更改真实宿主数据、推进 HOTP、重设主密码，并恢复该场景的生命周期。Settings 从这个本地任务打开原备份，原生确认拒绝旧的当前主密码且不 staging；正确密码之后只点击一次真正的还原确认。

`native_confirm_restore_relaunch` 必须观察到 staged 成功、确认禁用及原进程 exit=0，再核验新 bridge listener 的不同内核 PID/start-time、同一可执行文件和完全相同的 data/config/cache、bridge host/port。只从内核读取这几个环境键，不归档完整环境或命令行。macOS 的 POST /session 仅连接已经运行的 bridge；探针不调用 driver.start、应用 spawn、还原/重启 IPC、DELETE /session 或 native_restart_app，也不重置 fixture 或重写存储。普通点击完成后释放按键的 DELETE /session/{id}/actions 不结束应用会话。

接管后独立检查原模块行、原 active code 指针、推进后的 generation、正确 writer lease、清理后的还原状态，以及新密码被拒绝、原密码解密原账户和 HOTP 755224。原 renderer 和重启后的 renderer 分别断言运行时无错。保存原始进程记录、case receipt 和截图；截图仍需视觉复核。

## 所有权与限制

清理只接管通过验证的新 PID、内核启动时间和可执行路径，发信号前再次核对，PID 复用不授予清理权限。新进程已由旧应用创建并成为孤儿，Python 无法回收其真实退出码；清理记录明确返回退出码不可观察，不伪造 0。原 013/014/015 的正常退出断言不放宽，这三项也不以接管后的手动冷启动冒充第二次正常退出证据。

Linux WebKitWebDriver 和 Windows WebView2 的自动 relaunch 后接管仍待实现；不能用会再次启动应用的 POST /session 替代。LLDB 包装进程也不能当作应用本身的退出码。当前 case 仅声明 macOS，不代表所有 macOS 版本、Intel/ARM64 都已验证，也不证明独立 MFA 宿主迁出、legacy exporter 或单体升级激活完成。

## 执行状态

2026-11-18 再次 fetch/merge main，远程仍为 `677ec4d77`，已包含，无冲突。当前产品源码指纹为 `c35b48e6018a22744215dcd62f63f41f3e60313e810e3ea06be53f1c97f186bf`、runner 指纹为 `10bb03145a467fbea7f9e9ea784d5e226469d9613a95acba250fd7f4974ce8a8`。[macOS 15 Intel #44128351358](https://github.com/engcapa/taomni/actions/runs/44128351358) 绑定 `396b7bb294e0c4ccbc17871ac71eca246d5cfc0d`，已成功结束；完成片即下载，全部 artifact hash/bytes、receipt、case digest 与源码/构建/selection 身份已核验。**44/44**、完整 crash **24/24**，包含 013/014/015 和 033/034/035，后者全部 93/104/112 步通过：

| 用例 | 原 PID → 新 PID | 原退出码 | 恢复后状态 / writer lease |
|---|---|---|---|
| 033 | 27715 → 28133 | 0 | enabled / held |
| 034 | 28195 → 28634 | 0 | disabled / released |
| 035 | 28849 → 29355 | 0 | uninstalled、dataRetained=true / released |

均为单次真实确认、staged/禁重复、旧 HTTP 关闭、精确二进制/隔离环境和新 PID 接管；generation/active、原密码和 HOTP 755224 全部通过。035 的准确 locator `hello.sqlite` 为 **8192 bytes**、SHA `e795d1c7a42109c63d7f6c81663067d1a1fa7346fce2969d889e9f2bd467f95e`，与原已核验档案相等；已查看最新解密后 MFA 截图，原账户和验证码正常。证据在 `qa-ui-auto-report/github/44128351358/live-shards/`。

[macOS 26 ARM64 #44128388069](https://github.com/engcapa/taomni/actions/runs/44128388069) 的 producer 没有执行任何步骤，被 GitHub 以 hosted runner 未获配/ARM64 容量不足取消；无应用用例结果，原始 annotations 保留。Intel 通过不填补 ARM64 或 Linux/Windows 自动接管缺口。

同产品源码、较早 runner 的 [Intel #44124347927](https://github.com/engcapa/taomni/actions/runs/44124347927) 绑定 `daa1fc0bd4ccd22d24247a19f0c75d41e0ed72bf`，已成功结束；4/4 片在执行期间收齐，**44/44**、完整 crash **24/24**，全部 artifact hash/bytes、receipt、case digest 与源码/构建/selection 身份已核验。三态的 93/104/112 步全部通过，原始进程与 OS writer lease 记录如下：

| 用例 | 原 PID → 新 PID | 原退出码 | 恢复后状态 / writer lease |
|---|---|---|---|
| 033 | 8587 → 8856 | 0 | enabled / held |
| 034 | 11493 → 11889 | 0 | disabled / released |
| 035 | 12295 → 12859 | 0 | uninstalled、dataRetained=true / released |

每项均为单次确认、staged/禁重复、关闭旧 HTTP 连接，核对同一二进制/精确隔离环境后接管完成；generation/active、原密码和 HOTP 755224 均通过。035 准确 locator 为 `hello.sqlite`，完整数据库 **8192 bytes**、SHA `e795d1c7a42109c63d7f6c81663067d1a1fa7346fce2969d889e9f2bd467f95e`，与原已核验档案相等。此结果保留原 runner 身份，不能改写为最新 runner 或 ARM64 通过。

首轮 `750f6f417528c25fb813bdd547c36c69239e7079` 的 [Intel #44119238192](https://github.com/engcapa/taomni/actions/runs/44119238192) 虽完成 release QA build，但旧四目标模块包被无关 ARM64 容量阻断，native 未执行；[ARM64 #44119201895](https://github.com/engcapa/taomni/actions/runs/44119201895) 同样未取得 runner。下述旧 Intel 全量与 ARM64 部分证据仍绑定各自原始 SHA。旧 SHA 的单作业 #44110689605 在执行应用用例前结束，不将历史结果转为新源码通过。

本地仅执行工具单元和 schema/behavior contract、catalog/refactor 静态检查。真实应用、进程、文件还原和三态自动 relaunch 全部留 GitHub `qa-ui-auto-platforms`，包含完整 crash-regression，并在运行中下载完成的 shard。

[Intel #44095029967](https://github.com/engcapa/taomni/actions/runs/44095029967)（`0dfdfb159caa31b65ba239fd80917c79acee02e0`）已成功结束，4/4 分片即时下载，34/34、零 skip，包含 033/034/035 的完整 93/104/112 步和完整 native crash-regression。全部 artifact hash/bytes、receipt、身份及 case digest/计数已核验。三态原始记录均为单次确认、staged/禁重复、旧 HTTP 连接关闭、原进程 exit=0 和成功接管同一二进制/隔离环境的新 PID：

| 用例 | 原 PID → 新 PID | 还原生命周期 | writer OS lease |
|---|---|---|---|
| 033 | 10514 → 10982 | enabled | held |
| 034 | 10779 → 11193 | disabled | released |
| 035 | 7877 → 8339 | uninstalled / dataRetained=true | released |

035 原始 `retainedData` 为准确 `hello.sqlite` locator，数据库 8,192 bytes、SHA `e795d1c7a42109c63d7f6c81663067d1a1fa7346fce2969d889e9f2bd467f95e`，完整字节等于原已核验档案；密码回退和 HOTP 755224 均通过。已查看 035 解密后的真实 native MFA 截图，原账户及验证码正常显示。这闭合当前 macOS 15 Intel 的三态确认入口，不代表 Linux/Windows 的自动接管、独立 MFA 宿主或旧单体升级已经交付。

同源码 ARM64 [#44095086934](https://github.com/engcapa/taomni/actions/runs/44095086934) 仅一片实际执行，8/8 通过；其余三片因 GitHub 无法分配 hosted runner 在任何步骤前被取消，不算完整 macOS 15 ARM64 通过。按用户允许临时使用更高 macOS 的要求，workflow 增加官方 `macos-26` ARM64 选项；实际 [#44102464430](https://github.com/engcapa/taomni/actions/runs/44102464430) build identity 为 macOS 26.7.2 ARM64。已即时核验第 2 片 8/9，033 全 93 步通过：单次确认、staged/禁重复、关闭旧连接、原 PID 8432 exit=0、新 PID 9178 接管，generation 更新、enabled/held 及原密码/HOTP 均通过。旧 HTML 导出用例的 native Save chooser 识别失败保留并按用户要求单列为无关失败，不计通过；其余三片长时间未分配 runner。调度同 34 项和完整 crash 集合的[单作业 #44110689605](https://github.com/engcapa/taomni/actions/runs/44110689605) 后已取消旧轮，034/035 的 ARM64 自动 relaunch 仍待完整新结果。更高版本也不代替未执行的 macOS 15 ARM64。

修复后的 [Intel #44077458265](https://github.com/engcapa/taomni/actions/runs/44077458265) 绑定 `481d59afda4791578da03699aecc7c55a4fa9f2a`，4/4 分片均在 summary 前下载：33/34 通过，含 033 的完整 93 步与 034 的完整 104 步。033 原始 `native-restore-relaunch.jsonl` 为 `passed=true`、`stage=complete`、`manual_launch=false`、`previous_connection_closed=true`；staged 后确认禁用，原 PID 9496 exit=0，新 PID 9853，核验同一二进制和精确隔离环境后接管成功。035 的同一接管边界也通过（原 PID 10167 exit=0，新 PID 10552），但随后第 95 步误用要求预先创建 `qa-retained.txt` 的固定文本场景探针，阻挡了真实 SQLite 场景的后续数据/密码断言，035 仍计失败。ARM64 [#44087810304](https://github.com/engcapa/taomni/actions/runs/44087810304) 已被修订批次替代，在 release 构建后取消；没有完整应用用例结果，不计通过。

035 修订为原签名/lifecycle `uninstalled` 检查加 `ui-restored` 的真实 SQLite oracle，保留全部既有业务行、generation、active pointer、writer lease、密码/HOTP 和 relaunch 断言。新增检查要求 `dataRetained=true`、准确 `hello.sqlite` locator、全部路径为普通隔离路径、完整数据库字节等于原已核验档案，以及原档案 hash 不变；不向场景补写文本或更改预期业务数据。单元先复现错误探针及原检查对伪造 locator/字节变化的漏检，再验证完整场景和拒绝分支，相关工具 71/71；workflow 规划阶段也执行这组单元。QA audit、actionlint 与 check:refactor 通过，修订后的原生结果待 GitHub 复验。

[matching UI #44043206496](https://github.com/engcapa/taomni/actions/runs/44043206496) 绑定 `fa17261e4582f84c645bf41658949592767547ec`，selection 为 `f0c687845e4a473da0bcdd72862947d6`。实际计划含 macOS ARM64 native 32 项（包含 033/034/035），browser 三端各 19 项，Linux Xvfb/Wayland 与 Windows native 各 29 项；gaps=[]/unreviewed=[]。已启动即时收证，新增用例尚待 matching runner 结果；不能把静态审查或工具模拟写成原生通过。

2026-11-17：#44043206496 的 macOS 033/034/035 原始失败均停在备份清单断言，尚未执行自动 relaunch。原失败 DOM 有多份真实本地任务；未限定任务的 selector 点击了另一份自动备份。修正 oracle 仅在独立核验准确手工 job、ZIP/全部 hash、原 HOTP counter 和配对 Vault/MFA 后公开该 job ID，三项用例通过对应 `backup-cloud-job[data-job-id]` 打开原任务。保留全部后续密码、staged、exit=0、新 PID/generation 和业务断言；增加工具单元同时检查三项用例的精确 UI 选择。修正后的真实自动重启仍待新 GitHub 结果，原失败不改写为通过。

精确任务选择修正已提交 `56d9a305641f7dc478212d01042e8f5009fe2b11`，[macOS 定向复验 #44050634191](https://github.com/engcapa/taomni/actions/runs/44050634191) 已启动，保留三态普通冷启动与完整 crash-regression；结果继续按完成 shard 收取。

该轮 browser 4 片共 18/18 通过。已完成 native 片中 013/014/034/035 在观察器公布备份 job ID 时抛出 `NativeStepContext.values` 不存在，尚未执行自动 relaunch；同轮 FILE-OPEN-002 另有 ResizeObserver 通知失败，保留原始证据。观察器现通过 native 的 `fixture_context.values` 更新模板变量，browser 继续使用其原 fixture owner；使用实际 `NativeStepContext` 与 browser context 的单元先复现 native 红测，再验证两种上下文均能发布独立核验的任务 ID。密码、真实进程 relaunch、generation 和数据断言保持，修订后须重新在 GitHub 执行。

#44050634191 最终 8/8 shards 均已下载并核验全部 case artifact 的 hash/bytes：browser 18/18；native 21/28，013/014/015/033/034/035 均为上述上下文错误，另有 FILE-OPEN-002 的 ResizeObserver 失败，没有自动重启通过证据。修复提交 `5cbd077c158cbdfcc4480607bcaf142e5c60edad` 已进入 [#44058015738](https://github.com/engcapa/taomni/actions/runs/44058015738)，与文件功能和完整 crash-regression 共用三端 release QA 构建；macOS ARM64 native 明确选择六项还原用例，继续逐完成片收证。

`44058015738` 的 macOS native shard 2 首次进入 033 观察器 preflight，在任何点击之前报 `WebDriverError: None`。下载的 `native-restore-relaunch.jsonl` 明确 `click_attempted=false`、`stage=preflight`；原进程仍存活、console 无错误。根因为 W3C 传输层把合法脚本观察结果中的 `error: null` 当作协议错误。新增经过 NativeSession.execute 的红测精确复现，修复仅对非空字符串 error code 判错；原 HTTP 500/W3C 错误、超时、截断、禁止重放和 owner 清理断言全部保留。传输/还原/重启单元 64/64 与 check:refactor 通过。没有改产品、凭证、预期数据或自动 relaunch 断言；沿用 033–035 复验真实单次点击、staging、原进程正常退出、新监听器身份与同一隔离目录的接管。该纯工具修复无需新增产品 YAML；platforms planner 新增输入与观察器单元步骤，确保 GitHub 也执行这些合同。

`44066113956` 的 ARM64 native 033/034/035 均越过 preflight：每项真实确认只点击一次，独立观察 staged/禁重复、原进程正常 exit=0，以及相同二进制和隔离环境的新进程；其中 033 原 PID 6994、新 PID 7302。三项均失败于 `attach-existing-process`，原持久 HTTP/1.1 连接仍绑定旧进程，重用时被 reset；原始失败、artifact hash/bytes 与 receipt 已全部核验，不能把前面的边界观察当整体还原通过。新增使用真实 NativeSession 的红测复现相同 ConnectionResetError。修复只在已观察 staged 成功及原进程 exit=0 后丢弃旧 HTTP 连接，保留应用/driver 所有权，再以一次 POST /session 接管已核验的新进程；不发送 DELETE /session、不重放点击或失败的接管，也不放宽超时/业务断言。另保留新连接实际失败时立即失败的回归。修复 `481d59afda4791578da03699aecc7c55a4fa9f2a` 的传输/接管/退出单元 73/73、TypeScript 与 check:refactor 已通过；实际三态完整结果待新 GitHub 执行。
