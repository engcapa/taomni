# 全类型恢复矩阵：优先复用，成本高则提示

日期：2026-10-15，v3。关联[主设计](../webview-renderer-crash-recovery-design.md) DEC-06/07/09、AC-01至12、TASK-02/04/05、V-05/09/10。仅完成源码审计，表中动作均为拟议策略，未实现、未做恢复测试。

本表覆盖当前 HEAD a11c227c 的26个 SessionType、21个 TabKind、9个 Tools入口及相关辅助功能。覆盖的含义是每项有处理决定，不要求每项实现无损恢复，也不要求修改所有列出的文件。实现只改共用恢复入口和有实际副作用风险的少数挂载/关闭逻辑。

## 1. 共用规则

| 策略 | 做什么 | 何时直接提示 |
|---|---|---|
| 接回终端 | 使用现有终端ID；后台进程保活；尝试公开xterm能力恢复当前画面、光标、必要模式及最多500行历史 | 检查点缺失、断档、模式未知或开销超限；提示后台仍运行、画面未完整恢复。不暗中创建新shell |
| 客户端重连 | 读取已有配置引用，沿现有连接入口重连；重建目录/列表等只读视图；先避免遗留连接或活跃任务被误关 | 没有凭据/配置、旧操作结果未知或清理旧资源需大改；保持待处理，不无限创建连接 |
| 重建控制界面 | 查询现有原生状态、已保存配置/数据，重新订阅；不重新启动后台服务 | 没有状态查询或只存在前端中间态时明确未知/已丢失，不造通用任务后端 |
| 提示重新打开 | 恢复标签/路径/用途信息，复用现有按钮让用户决定下一步 | 不自动重放动作；提示中区分“界面状态丢失”“连接已断”“后台可能仍在” |
| 安全结束 | 仅对失去控制的采集/输入驱动调用已有停止/取消/落盘入口 | 没有便宜可靠的恢复控制方法，不自动继续录音、滚动鼠标或重启采集 |

恢复不是普通冷启动。恢复路径禁止借组件mount自动执行SQL、邮件发送、宏、安装或AI工具；正常冷启动的既有契约应保持。不能确认完成的操作标为未知，不自动补发；不为本次构建通用 exactly-once/operationId 系统。

轻量清单只存ID、配置引用、选中路径等。密码/私钥/令牌、完整结果集、大文件、位图和完整Tab对象不放入清单。vault仍锁定或授权请求未回答时，沿现有交互重新请求，不自动批准。

## 2. 全部 SessionType（26/26）

定义依据：`src-tauri/src/session/models.rs:27`。路由依据：`src/layouts/MainLayout.tsx`，特别是 `COMMAND_TERMINAL_SESSION_TYPES`（约316行）。相同公共路径只需按实际差异补测试，不能把列表枚举测试说成每种协议均真机通过。

| SessionType | 当前承载及本次策略 | 特有边界 |
|---|---|---|
| SSH | Rust SSH终端；接回终端 | 不重新认证/执行startup；现存SSH已断则提示，不能承诺保活远端连接 |
| Telnet | 外部命令运行于PTY；接回终端 | 不再启动第二个telnet进程 |
| Rlogin | 外部命令运行于PTY；接回终端 | 不因“网络客户端”而重连并重复启动 |
| RDP | 原生RDP客户端；允许重连 | 释放旧输入/帧订阅，沿现有disconnect/connect；不远端注销、不重放按键/剪贴板；无法安全清理则提示 |
| VNC | 原生VNC客户端；允许重连 | 同上，重取当前帧，不保存历史画面；远端桌面是否持续由服务端策略决定 |
| FTP | 当前为命令终端；接回终端 | 不是SFTP文件浏览器；保留原FTP命令进程，未知传输结果不重复上传 |
| SFTP | 原生SFTP句柄+文件浏览器；允许重连 | 正在传输时不能为清理旧页面关闭任务依赖；不能查询就提示任务状态未知，勿自动重启传输 |
| Serial | 串口命令客户端运行于PTY；接回终端 | 不重新抢占串口，不重放设备命令；原程序已结束则提示 |
| LocalShell | PTY/ConPTY；接回终端 | 覆盖bash/zsh/sh、cmd、PowerShell、Git Bash、WSL及自定义shell；进程身份与启动时间不变 |
| File | 本地文件浏览器；重读路径和目录 | 不重放删除/移动/覆盖/粘贴，未保存编辑只恢复既有已保存版本 |
| Browser | 通过openExternalUrl打开系统浏览器 | 外部浏览器不随Taomni renderer死亡；不自动再开页面或重复OAuth/提交 |
| Mosh | 命令终端；接回终端 | 保留原mosh客户端与原会话，不启动第二个客户端 |
| MySQL | database；允许重连 | 不自动重执行查询/写入/COMMIT；事务和会话变量不保证保留 |
| PostgreSQL | database；允许重连 | 同SQL边界；不对任意SELECT作“必然无副作用”假设 |
| PanWeiDB | database；允许重连 | 同SQL边界；原生驱动差异在重连实现中保持 |
| Oracle | database；允许重连 | 同SQL边界；不为恢复新增驱动生命周期重构 |
| SQLServer | database；允许重连 | 同SQL边界 |
| StarRocks | database；允许重连 | 同SQL边界 |
| ClickHouse | database；允许重连 | 原请求可能仍执行，未获结果不能重发 |
| Presto | database；允许重连 | 已启动的远端查询不能因页面重建自动再次提交 |
| Redis | 独立Redis客户端；允许重连 | 重读库/键列表，恢复CLI草稿仅限已保存；不重放Redis命令或订阅副作用 |
| HBaseShell | HBase HTTP REST/Stargate客户端 | 名称含Shell但不是PTY；重连/重读，不重发put/delete等写操作 |
| Proxy | proxy-test标签；恢复配置/页面 | 检测结果可丢失，提示重新测试，不自动重复测速/外网请求 |
| Mail | IMAP/SMTP/POP3及本地缓存 | 允许重连；读已保存草稿；恢复启动先暂停Outbox自动发送并提示核对，不自动补发SMTP |
| S3 | object-storage；S3兼容服务 | 重连并重读bucket/prefix，下载/上传不重启；运行任务不可查则提示 |
| AzureBlob | object-storage；Azure客户端 | 与S3同策略；沿已有凭据与代理配置，不能切换账号或匿名重试 |

SQL共同限制：`database/mod.rs:718` 的 `db_disconnect` 进入 `close_session`，会取消查询和部分转发/连接池；`DbClientTab.tsx:692` 当前mount连接、unmount可能rollback再disconnect。恢复不得直接复制普通关闭逻辑。可以简单识别为空闲且无事务时清理并重连；识别不了就显示需手动处理。这里接受连接/事务状态不恢复，不要求新建事务状态机，也不擅自COMMIT。

文件传输共同限制：`filebrowser/transfer.rs` 的TransferHandle只有取消/暂停状态，完成后unregister删除；进度事件不等于持久状态查询。`objectstorage/session.rs` 的close会cancel。恢复可读取已有查询接口时使用；没有就显示“进度未恢复，请核对目标文件”，保持可能仍在的原生工作，不补建完整任务注册系统。

## 3. 全部 TabKind（21/21）

定义依据：`src/types/index.ts:9`。公共外壳恢复标签顺序/当前选中项；内容按下表。隐藏重型客户端可到用户切换时再连接；后台控制面只读快照，不一起大量拉取数据。

| TabKind | 内容恢复规则 |
|---|---|
| terminal | 复用terminalSessionId；按§2的7种终端承载类型处理；不从缺失状态跌入新建 |
| sftp | 目录/选择路径是轻量状态，连接可重连，传输不重放 |
| rdp | 重连或提示；不重放输入，清理旧捕获状态 |
| vnc | 重连或提示；不复制原生帧/纹理到恢复描述 |
| nettools | 实际渲染TunnelManager；查询现有隧道状态，不start_all |
| sockscap | 查询已有runtime状态，保持helper/捕获/规则/已启动应用 |
| welcome | 读取已保存会话；仅真实冷启动使用原欢迎页恢复行为；不能覆盖故障恢复清单 |
| settings | 重读已持久设置；未应用表单允许丢失，不自动点击保存/重启/安装 |
| placeholder | 恢复标题和占位说明即可，无后台任务 |
| file-browser | 恢复路径后读取目录；未提交操作/编辑提示丢失 |
| database | 重读已有SQL workspace/草稿，连接重连或提示；结果集可以丢失，不执行SQL |
| redis | 重建列表/连接；已提交命令结果未知时不重发 |
| hbase-shell | REST视图重连；不作为终端重放 |
| proxy-test | 配置可恢复，检测结果/图表可丢失，用户重新测试 |
| object-storage | 配置及bucket/prefix可恢复，客户端重连；传输按真实能力处理 |
| lan-chat | 从现有服务/数据库重读会话消息和状态，不重启LAN节点、不重发消息 |
| git | 按repo路径读取status/diff/log；正在执行的写操作无法查则提示，不重复commit/push/reset/continue/abort |
| mail | 缓存/草稿+重连，恢复启动暂停自动Outbox处理 |
| mail-unified | 读取各账号缓存，限制连接并发；每个账号独立失败，不自动再次发送 |
| code-workspace | 重开项目/已保存文件和现有workspace信息；未保存编辑、调试状态恢复昂贵则提示，不重跑任务 |
| mfa | 读取已有加密存储与当前锁状态；不递增HOTP、不复制seed到清单 |

## 4. Tools全部入口（9/9）

依据：`src/components/sidebar/Sidebar.tsx:258` 与 `src/lib/nativeAppMenu.ts:184`，命令由MainLayout分派。`settings`和`toggle-xserver`另在§5覆盖。Tools“网络工具”当前是placeholder，`src-tauri/src/nettools/mod.rs`为空；隧道的TabKind恰好叫nettools，二者不可混淆。

| Tools命令 | 权威状态/源码依据 | 恢复与允许提示 |
|---|---|---|
| servers | `servers/mod.rs` ServerRegistry；已有list_server_statuses、list_server_logs、load_server_configs；`ServersDialog.tsx`、`serversStore.ts`可读取 | 恢复独立控制窗口并查询。SSH/FTP/TFTP/HTTP/Telnet/VNC/NFS/Cron/Iperf/RDP服务器保持原runtime及端口；不重复start/autostart/Cron计划。已有每服务500条日志可重读；RDP待授权不自动批准 |
| tunneling | `tunnel/mod.rs` Registry及list/status；TunnelManager | 隧道/监听端口保留，重新订阅；不重复启动或重放配置。未保存表单允许丢失 |
| sockscap | `state.sockscap`及`sockscap/`系统helper/规则 | 查询现有状态；不disable/enable、boot_repair、重启应用或新提权。恢复cleanup不可停止原进程；确实无法判断状态时提示 |
| git | `git.rs`，repo路径；git_operation_state只描述merge/rebase等仓库状态 | 重读status/diff/log，不声称所有后台Git命令可枚举；命令结果未知则提示核对，不重跑 |
| code-workspace | `codeWorkspaceStore.ts`、`CodeWorkspaceTab.tsx`、原生lsp.rs/dap.rs/sdk/mod.rs | 先重开已保存文件；复用已有server/workspace查询。若重新绑定需重构LSP/DAP生命周期，保留项目视图并提示语言/调试服务需重开；不自动新建第二server/watchers/build |
| mail-unified | 原生mail缓存/IMAP pool；MailClientTab既有草稿 | 按账号读缓存、重连；恢复Outbox暂停核对。未保存草稿最后修改可丢失，不新增实时草稿镜像 |
| lan-chat | `lanchat/commands.rs`、service与SQLite，已有status/peers/conversations/messages等 | 重新读取/订阅，不重启节点、不重发消息；输入草稿丢失可提示。前端媒体通话不能便宜接回就显示中断，不自动开启麦克风/摄像头 |
| mfa | `mfa/`加密存储、vault状态 | 按原锁状态读取；TOTP重新计算，HOTP不推进。失效的扫码/导入表单提示重开，不保存秘密到恢复描述 |
| tools | MainLayout约3723行openPlaceholderTab | 还原占位页即可，无恢复任务或额外网络请求 |

## 5. 非Tab功能、后台工作和辅助窗口

| 功能/入口 | 事实与本次最小恢复策略 | 不做的高成本恢复 / 防重复点 |
|---|---|---|
| 主窗口、通用分离窗口 | `lib.rs`、`windowing/mod.rs`、`DetachedSessionWindow.tsx`；以小型描述保留归属/尺寸；能reload优先reload | 60秒handoff不是永久状态；缺失则提示；不建设全局窗口迁移事务，不把死亡当用户关闭 |
| 独立SFTP窗口 | `filebrowser/mod.rs:541` open_sftp_window是单独builder，`#sftp=`路由 | 同样接入hook/读取描述；不能只改通用windowing漏掉它，连接/传输遵循§2 |
| 本地/远程文件编辑、Code Workspace编辑器 | 使用已经保存的文件与现有workspace/local history；只恢复可定位版本 | 前端未保存内容不新增每秒同步；提示最后未保存修改可能丢失。初始化空buffer不得覆盖原文件 |
| SQL编辑器workspace | 已有防抖保存/flush；读取已提交版本 | crash不执行cleanup，不能保证最后一次编辑；不保存全部查询结果网格 |
| 邮件草稿/Outbox/撤销发送 | `MailClientTab.tsx:3696`草稿防抖约1800ms；约3325行挂载3秒后处理Outbox，之后每30秒 | 恢复暂停Outbox自动处理，展示已保存草稿；发送结果未知需用户核对。撤销倒计时/在编草稿等内存状态不可假称保留；不造SMTP去重系统 |
| AI聊天/CC/Codex/ACP/捕获任务 | `chat/mod.rs`可读持久消息；`chat/run.rs` registry主要为stop handle；state中有进程与pending approvals | 读已有消息/实际可查状态，进程保持；缺流/结果显示未恢复，不自动resubmit turn/tool。不为本次补完整事件日志。终端里运行的Codex走终端策略 |
| LSP/DAP/SDK、构建/运行/测试 | `lsp.rs`、`dap.rs`、`sdk/mod.rs`各自有manager，但不是统一可恢复任务表 | 能查询则绑定；不能则提示原任务可能仍在。不得重启debuggee/再次run/continue，不为恢复大改调试协议 |
| SFTP/对象存储/本地文件传输 | 原生transfers有暂停/取消句柄，部分结果仅事件 | 保持实际任务，已知可查就查询，未知就提示核对；不复制整个传输store或启动相同文件第二次传输 |
| ZMODEM | 部分协议/文件处理在前端，renderer消失后状态丢失 | 显示传输中断/需核对文件，不重放数据来自动续传；未完成文件按已有规则保留 |
| 下载模型/SDK/依赖 | `models/downloader.rs`有Range/校验不等于可列举所有任务 | 使用已有进度/临时文件查询能力；没有就提示，不能重新下载同一对象、发布未校验文件或重构整个下载服务 |
| 应用更新 | `src/lib/updateService.ts`的updateCache/downloadedCache/checkGenerations为前端Map | 重开更新检查界面；下载/安装状态不可查则提示，不自动再install/relaunch。只用已有插件接口，不新增更新后台系统 |
| 备份/计划备份 | `backup/jobs.rs`已有list/start/cancel及原生调度 | 重读原任务，保持定时计划；不再次启动同一备份/恢复，不重复定时器 |
| Notes/浮动笔记 | `notes/commands.rs`、notes DB、NotesDetachedWindow | 重读已保存内容、笔记ID/偏好；未保存尾部允许丢失。不要初始化空内容覆盖旧文，不重复提醒 |
| 截图选择覆盖层 | `screenshot/mod.rs`原生ToolState；watch_session_window的Destroyed会close_session | 使用现有取消/恢复隐藏窗口流程结束失效选择，不自动再次截图；禁止全局销毁重建触发不可控删除 |
| 滚动截图 | `screenshot/mod.rs`已有scroll_status/stop；控制窗Destroyed可请求stop | 停止自动滚动/输入驱动，保留已得到的安全结果，提示重新开始；不追求续接半个滚动过程 |
| 屏幕录制 | current_recording/recording_status存在；原生recording和临时文件可能仍在 | 优先重绑已有控制窗；做不到就用已有停止/落盘能力安全结束并提示保存位置，不默默删除或无限无控制录制 |
| 截图贴图/图板 | `screenshot/pins.rs`及原生图像引用 | 便宜可查询时重开贴图；清单只存引用，不拷贝大bitmap；不恢复昂贵的前端未提交编辑 |
| 语音/听写 | `voice/commands.rs`持有native session/stop入口，前端消费者已丢 | 用已有停止方法结束失控采集，保留已有音频/转录；不自动重新录音、发送聊天或执行转录出的命令 |
| LAN语音视频/远程桌面输入捕获 | 前端媒体状态、native media与OS权限混合 | 能小范围解绑/释放就做；否则显示通话中断，沿已有停止入口收尾，不自动申请摄像头/麦克风 |
| MFA扫码、vault解锁/证书信任、SSH认证提示、RDP服务授权 | native状态/待响应通道可能仍在 | 查现有状态或重新提示；旧请求过期则显示过期，不自动同意、不保存明文密码 |
| X server | `terminal/x11.rs`已有detect/current_display/resolve | 查询现存服务；不toggle或启动第二个X server；平台本来不支持时保持原提示 |
| 宏录制/回放 | `TerminalPanel.tsx`宏内容与录制状态在ref/state | 可以丢失尚未保存的宏并提示；不恢复录制/播放，已送入PTY的命令继续，不补发剩余输入 |
| 多执行/广播输入、终端startup/CWD注入 | MainLayout multiexec、TerminalPanel输入和ready路径 | 恢复时暂停广播/输入续发，不重复startup；保留正常新建终端的CWD/ready逻辑 |
| settings、会话编辑、Quick Connect、导入导出、帮助 | 读取已持久配置、目录与设置；重新注册已有菜单/快捷键一次 | 未提交表单/文件选择/确认框可关闭并提示；不自动导入、导出、覆盖、打开外部链接或安装 |

## 6. 实现选择与验收映射

TASK-02负责公共外壳和小型描述，TASK-04负责terminal，TASK-05只负责矩阵暴露的真实危险入口。推荐先列出实际需要修改的文件；若某类别要求新建完整任务/协议系统，就把该类别落为提示策略，不以“全覆盖”为由扩张范围。

可在现有前端路由旁维护小型 `Record<TabKind, RecoveryPolicy>` / `Record<SessionType, ...>` 或同等穷举映射，防止将来增加类型时被默认重连。不另造插件框架；静态映射只证明分类没有漏项。

V-09按不同生命周期类别选代表场景：原PTY、原生服务/隧道、可安全重连的客户端、没有运行状态查询的页面、独立窗口。V-10验证Outbox/数据库写入/传输/AI权限/宏/采集的“不重复”和正确提示。相同SQL公共组件的8种引擎做静态映射检查，实际新增连接行为涉及各引擎差异才扩真机测试；不为文档列满而跑所有协议。

验收同时报告：实际恢复的能力、选择提示的能力、真实测试的系统/服务、未验证范围。用户允许不恢复并不等于允许误停后台、悄悄丢数据、重复外部动作或虚称三端通过。
