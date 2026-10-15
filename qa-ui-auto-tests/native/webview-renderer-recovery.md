# WebView 有限恢复原生用例

**状态：全部 unrun。用户要求本轮只运行本地单元测试，不执行 browser/native、故障注入、服务实验或性能测量。**
这些是手工/外部原生用例，不伪装成 runner 支持的进程终止或原生对话框 verb。
可执行冷启动回归为 `TC-RECOVERY-006`，已注册 CI；以下 `TC-RECOVERY-Nxx`
是本手册的稳定场景标识，**不是已注册的 YAML case**。

## 公共前置与证据

1. 仅使用 `com.taomni.app.qa` 或独立 OS 测试账号。记录真实 app-data、
   配置/cache/WebView 目录、工作目录、主进程 PID/启动时间/二进制 hash、
   源码 HEAD+未提交 diff、Node/pnpm/Rust、构建 flags、OS/架构/显示协议、
   实际加载引擎库版本/Build ID。核对没有使用个人数据或白屏中的真实实例。
2. Windows不能只覆盖APPDATA；release不能依赖debug-only NEWMOB_DATA_DIR。
   使用既有 native-testing 手册隔离启动。功能 QA release 的 debug_assertions
   与真实性能 release 分开。主进程崩溃/系统重启不属于同一实例恢复。
3. 建立临时工作目录。PTY负载：
   `i=0; while :; do i=$((i+1)); printf 'RECOVERY-TICK-%s\n' "$i"; printf '%s\n' "$i" > recovery-counter; sleep 1; done`
   同时记录PTY PID/进程启动时间；Windows用等价PowerShell循环。
   startup写入独立计数文件一次，不能以终端回显证明执行次数。
4. 准備普通shell、vim/Codex类TUI、空闲shell、已结束shell、
   一项本地后台服务及隧道。SSH仅明确opt-in、独立账号、协议就绪后测试。
5. **终止前**验证renderer PID归属、启动时间和QA主进程父子关系；
   Linux必须核对WebKitWebProcess、Windows必须核对该WebView2 profile对应
   renderer/browser，macOS核对该QA WKWebView的WebContent进程。
   不提供猜测PID或模糊名称批量kill的脚本。手工结束精确归属的测试renderer，
   不能结束Rust主进程；自然JSC GC错误与故障注入分开记录。
6. 原始证据留在 `qa-ui-auto-report/webview-renderer-recovery/<OS>/<case>/`：
   source/build/config身份、操作时间、PID/启动时间前后、计数文件、端口、
   请求日志计数、订阅数/内存原始样本、截图、原生对话框录屏及结果。
   每个断言标pass/fail/unrun，browser/mock/交叉编译均不能替代原生结果。
7. 清理只停止本用例创建的服务、PTY、采集和QA进程，关闭临时连接；
   先取消活动采集，再移除测试目录。保留失败原始证据，不触碰用户实例。

## TC-RECOVERY-N01 — 三平台事件、失败提示及分类（V-03/07，AC01/06/08/09）

前置：公共隔离；main、普通分离、独立SFTP各一窗口；计数shell运行。

1. 在Linux X11、Wayland、Ubuntu22.04/WebKitGTK分别终止确认归属的renderer。
   期待原生提示出现，Rust PID/PTY PID/启动时间不变，计数继续，未自动reload。
2. macOS10.15支持范围内的Intel与ARM分别运行同场景，确认公共Tauri hook。
3. Windows x64/WebView2分别结束renderer与browser进程：
   renderer路径提供手动“重试界面/稍后处理”；browser路径只提示限制，不重建。
   事件顺序renderer→browser与browser→renderer都不能触发第二次重载。
4. 分别制造GPU/frame故障与unresponsive（独立测试工具、记录操作），
   窗口不能因此被当成renderer死亡强制reload。
5. 检查release日志含版本、时间、匿名窗口身份、原因与结果；
   不含命令/SQL/正文/密码。注入日志尺寸到轮转边界，确认最多3×2MiB附近；
   无写权限时主进程仍保活（日志失败不能变成崩溃）。

证据：三端真实事件/对话框及日志、PID/计数；每个缺设备组合单列unrun。
截图/编译不能证明所有OS已通过。结束后按公共清理。

## TC-RECOVERY-N02 — 状态机、超时、旧回调和关闭（V-01/04，AC03/05/06）

1. 重复终止回调仅一个提示；选择“稍后处理”，不reload、不退出，计数继续。
2. 选择“重试界面”：描述先于业务mount读取，15秒内进入有限恢复页面。
   同一窗口60秒内不能循环尝试；这是手动节流，不是已启用的自动恢复。
3. 用隔离测试构建延迟bootstrap超过15秒，期待原生失败提示、后台保留；
   迟到旧ready/update/attach不能使旧renderer有效，也不能覆盖描述。
4. 恢复中再次终止renderer，合并失败并拒绝旧代次；另一个健康窗口不受影响。
5. 主窗口/无边框窗口退出全屏并出现系统标题栏。失败状态下点击系统关闭：
   出现“重试界面/退出应用/保留后台”；recovering/ready及browser退出只提供
   退出/保留选项。保留不关PTY；确认退出须先成功清理网络和收尾录屏。
   健康窗口仍走原前端close契约，不改变标题栏。
6. 主进程重启后旧instanceId、旧terminal ID不能沿用；缺描述和过时描述只提示。
   创建已发出但回执未到时不重做创建，核对该在飞任务继续存在。
7. 最后普通窗口关闭/窗口Destroyed后不得由迟到事件重新加入或弹恢复提示。
   隐藏、最小化、休眠/唤醒和长GC没有死亡事件时不能触发恢复。

证据：操作时间轴/代次、ready/失败日志、原生提示、PID/外部执行次数。
延迟/旧IPC属于测试夹具，不新增生产任意故障注入接口。

## TC-RECOVERY-N03 — 原会话只读接回与结束状态（V-02/03，AC01/02/04/10）

1. 从运行计数shell手动恢复，核对记录的terminal ID与故障前完全相同；
   不自动创建PTY、不写startup、不发送按键、不resize、不SSH重认证。
2. 点击“观察原终端输出（只读）”，看到新的计数行，磁盘计数不断增长。
   确认无输入框，方向键/粘贴/鼠标不能写入PTY；界面明确原画面/模式未恢复。
3. 停止观察、切换其他标签、再观察、关闭恢复视图：仅删除本window/channel
   订阅；原PTY/SSH继续运行，另一个窗口的同session订阅仍收输出。
4. 已结束shell/缺失ID/已断SSH不能被替代新建。系统中存在zombie或idle
   session时不能将“对象仍登记/没有输出”断言为仍在运行。
5. TUI备用屏、UTF8/CSI/OSC/DCS半包、协议查询、OSC52、ZMODEM、下载、
   铃声和resize场景都保持受限/只读，不重放历史逃逸序列或外部副作用。
   不能用纯文本观察证明光标/输入模式/完整画面恢复。
6. 输出2MiB单块、长行、持续输出、静止后再输出：观察窗口最多64K字符，
   原生读取持续，正常scrollback与既有复制/导出/自动化读文本契约不变。

证据：PTYID/PID/启动时间、startup文件次数、输出序列、无写入副作用、
订阅清理；对完整TUI/500行恢复的判定为“未启用”，不是pass。

## TC-RECOVERY-N04 — 正常生命周期回归（V-05，AC02/05/07）

1. 冷启动走Welcome，新建本地/SSH/命令终端，startup执行恰好一次，
   CWD与ready正常；输入产生独立输出行，复制/导出内容及QA读文本不变。
2. detach→另一窗口采用原终端→关闭分离窗口归位→再次detach→关闭标签：
   原ID在交接期间不重复创建；正常关闭最终结束预期资源，不保护错对象。
3. 手动renderer恢复与上述正常关闭交错（顺序分别测试），用户关闭优先。
4. 主窗口与独立SFTP、普通分离terminal/database/RDP/VNC/notes/servers/
   lan-chat分别核对路由和描述；缺已保存配置/过期handoff提示，不恢复凭据。
5. 保留F5/Ctrl+R生产拦截、已有应用退出确认和backup scheduler退出规则。
   正常冷启动Outbox保留旧定时处理；仅恢复启动暂停，不变成永久全局停发。

证据：执行/文件结果与窗口身份，不只函数调用计数。清理临时资源。

## TC-RECOVERY-N05 — 服务、隧道及客户端保持（V-09，AC01/03/11）

1. 启动QA本地服务和隧道，记PID/启动时间/监听端口/可达性。
   SocksCap用无特权或独立QA环境；不更改用户规则或系统网络。
2. 恢复main/分离服务器窗口后，端口及原任务身份保持；
   无start_all、autostart、stop、boot_repair、切换规则重复调用。
3. DB/Redis/HBase/SFTP/S3/AzureBlob/RDP/VNC选择不同生命周期类别代表：
   当前交付均提示旧连接/操作状态未知，不自动disconnect/rollback/重连。
   SFTP/对象存储传输不中止，目标文件结果需独立核对。
4. 隐藏页面激活只展示说明，没有连接风暴；26/21/9完整映射见专题设计。
   8种SQL引擎共同路由不伪装成8种原生协议均已实测。

证据：独立socket/服务日志、PID、任务结果与连接数。仅同类共同路由复用
代表，驱动差异出现时扩相应协议，不连生产服务器。

## TC-RECOVERY-N06 — 不重复副作用与保存状态（V-10，AC02/10/12）

前置：可控本地SMTP/IMAP、SQL和文件目标或独立测试服务。真实联系人禁止。

1. 预置已到期Outbox与SMTP结果未知草稿，故障恢复后等待>两次30秒周期，
   服务发送计数不增加；进入mail与mail-unified均显示暂停/核对。
   重启新QA主进程按原冷启动契约处理（另一个隔离fixture，避免混证据）。
2. SQL写入/运行查询/事务在飞，记录服务日志和结果表；恢复不重发、
   不commit/rollback/disconnect；保存workspace不被空初始值覆盖。
3. 在飞上传/下载/安装/AI turn/tool/权限/宏多执行：核对请求/输出文件/审批
   日志，恢复不新增操作、续发广播或批准权限；已执行结果可未知但提示明确。
4. Git/Code文件、笔记、邮件、SQL已保存草稿故障前落盘并hash；
   恢复不写空值。正常重开/新主进程读取已保存内容。
   未保存编辑缺失要显示限制，不能声称实时草稿保全。
5. 快捷连接只有内存凭据、MFA编辑、settings未提交、Quick Connect、
   图表/展开/选择等临时状态丢失不应触发自动写回或外部动作。

证据：fixture服务真实请求数及磁盘hash；browser只证明提示，不证明此处结果。

## TC-RECOVERY-N07 — 采集与特殊窗口（V-10，AC05/12）

1. QA主窗口开启语音录音/流式ASR，renderer退出后麦克风停止，不自动重录、
   转录、发送或执行命令；已落盘材料保留。并发start回执与退出竞态也覆盖。
2. 原生录屏/滚动截图已进行时，普通窗口恢复不销毁重建覆盖窗、
   不误触Destroyed导致业务资源删除；独立控制窗必须仍能停止并保留文件。
3. 若共享renderer使控制窗也失去控制，验证沿现有原生停止能力收尾；
   无可控停止的分支记fail，不用“有限恢复”掩盖无限采集/滚动。
4. LanChat通话/屏幕/音频采集核对控制或停止路径；不自动重建通话或重发
   文件/消息。固定图、图板、边界覆盖层不适用通用reload替换。

证据：麦克风/屏幕采集状态、输出文件可读性、停止行为和窗口身份。
共享renderer及native AV设备缺失分别unrun。

## TC-RECOVERY-N08 — 输出订阅、预算与队列（V-03/06，AC01/07/10）

1. 同session多个window订阅，终止一个renderer：其旧channel立刻撤销；
   其他窗口订阅不删。输出线程继续，正常输出不增加逐块IPC确认或快照。
2. create/attach正在await时死亡→迟到注册→新ready；旧generation不得插入
   旧channel。恢复观察的unmount先于attach完成，最终只撤销该channel。
3. 先少量循环手动恢复，记录Rust/renderer RSS、订阅/IPC排队变化与样本。
   Tauri send成功不作为消费确认；reload后队列清理必须有真实证据。
   出现持续增长再扩20轮定位；未通过前不启用自动reload。
4. 128/129标签、长标题/超大描述、多个窗口总描述接近1MiB：
   有界描述失败保留旧描述并提示可能缺项；不缓存正文/密码。
   只读观察64K字符上限，不调整正常终端scrollback。
5. 静止终端不新增周期恢复扫描；文本镜像优化状态R0/R1相同。

## TC-RECOVERY-N09 — 真release性能与长时（V-06，AC07）

1. 固定R0=开发前HEAD与未提交diff，R1=仅本恢复改动；相同引擎、
   文本镜像优化状态、编译flags和测量设施，不使用debug_assertions QA
   release来代表生产release。性能测试与功能探针隔离。
2. 1/4/16终端，80×24、160×50、240×80、宽屏；scrollback10000和允许大值；
   静止、纯文本、ANSI、TUI、小包、持续输出至少5轮交错配对。
3. 保存输入p50/p95/p99/最大值、帧分布、吞吐、CPU/RSS（Rust/renderer分开）、
   额外IPC与分配、描述提交次数/字节、恢复耗时。当前没有自动检查点，
   检查点次数应为0，不将独立文本镜像优化收益抵消恢复开销。
4. 可重复退化直接失败并缩小/关闭对应分支；不放宽阈值。
   headless差分测试只证明部分序列化能力，不作UI/GC/性能证据。
5. 短时通过后Linux至少覆盖72小时、建议96小时；其余平台分别报告样本，
   没有样本不能写“GC已修复”“无性能退化”或“三端已通过”。

清理：先停止本case持续负载，再关闭QA窗口，保留原始样本和failed轮次。

## 本轮修正的三端执行矩阵（全部 unrun）

| 平台 | browser | native 原生边界 | 性能 |
|---|---|---|---|
| Windows x64 / WebView2 | TC-RECOVERY-006/008/009，Chromium | N10–N13；renderer/browser分别测；任务栏关闭、Alt+F4、原生按钮 | N09/N14，真实release、ETW/WPR或同等采样 |
| macOS Intel/ARM / WKWebView | TC-RECOVERY-006/008/009，Chromium | N10–N13；traffic-light、退出全屏、沙箱外持久app-data权限 | N09/N14，真实release、Instruments或同等采样 |
| Linux X11/Wayland / WebKitGTK | TC-RECOVERY-006/008/009，Chromium | N10–N13；系统标题栏/WM关闭；GTK及portal权限 | N09/N14，真实release、perf/pidstat或同等采样 |

browser 用例覆盖生产 React 路由但使用 stub，不能证明任何 WebView hook、
文件/网络清理或真实PTY身份。各平台、架构、显示协议分别留证据，不能互相外推。

## TC-RECOVERY-N10 — 原生重试入口及安全退出（review #1/#3）

前置：公共隔离；在专用VM/独立测试机开启测试 SocksCap，记录网络接管前后的
规则、路由、DNS、helper/core PID。不得使用正在工作的真实实例或生产网络。
Linux记录nftables/ip rules，macOS记录PF/Redirector状态，Windows记录helper/
WinDivert和相关进程；使用既有SocksCap验收方法记录原状态，不手工清空系统规则。

1. main 和 detached-terminal 分别进行 renderer 故障。主窗口原本无边框时，
   系统关闭按钮必须在白屏上可见；原全屏窗口须能退出全屏访问标题栏。
2. 选择“稍后处理”，等待任意时长，使用系统关闭按钮再次打开选项；选择
   “保留后台”三次，PTY计数和SocksCap身份不变，无reload/退出/自动查询。
3. 手动重试，以隔离测试构建延迟ready超过15秒。失败后立即重试被60秒节流，
   弹窗指出再次进入方法；关闭提示后满60秒重新使用系统关闭→重试可以成功。
   不得依赖已有renderer、React按钮或后台定时重载。
4. 保持原生对话框打开，销毁/重新创建同label测试窗口或让恢复中再次崩溃。
   旧对话框返回“退出/重试”不得对新窗口生效；迟到15秒timeout不得破坏新ready。
5. 在白屏窗口选择“退出应用”。网络清理完成在退出前，之后录屏收尾等待与
   既有退出备份完成；确认无残留接管规则/路由/DNS/helper/core。仅进程结束不算通过。
6. 用测试环境现有故障注入让 prepare_for_exit 返回清理失败（不在真实机破坏网络）：
   原生显示实际错误，Rust/PTY仍在，未永久停在Closing。修复故障后重新选择退出可成功。
   两个白屏窗口同时退出只能运行一次清理；第二次请求不能跳过清理直接exit。
7. Windows browser进程退出不提供无效重试，仍可保留后台或安全退出。
   健康窗口冷启动/关闭/归位保持原行为。清理测试网络并核对恢复原状态。

证据：原生录屏、操作时间、匿名恢复日志、网络前后快照、PID和备份结果。

## TC-RECOVERY-N11 — 录屏安全收尾、持久文件与并发关闭（review #2）

前置：隔离设备、屏幕采集授权；MP4及GIF各执行；录制测试动画/计数器5秒，
记录开始时间和临时源路径。平台路径分别为各系统的app-local-data/
`recovered-recordings/<UUID>/rec-*.mp4|gif`，以原生提示的实际路径为准。

1. 仅终止 recorder 控制界面的 renderer。采集停止，等待编码完整收尾。
   原生成功提示必须带可查找的完整持久路径；没有成功结果时不得声称保存成功。
2. 按提示读取文件、记录SHA256，使用独立播放器/解码器核对时长、尺寸、帧数及
   测试画面，不用“文件存在/大小非零”替代可播放。没有自动开始新录屏。
3. 关闭失效控制窗口→正常退出QA→重新启动QA触发临时目录清理：文件仍可读取，
   SHA256不变。保存目录不在taomni-screenshot临时树中。
4. 分别覆盖：先Stop后预览崩溃；Stop IPC正在等待编码时崩溃；崩溃后立即关闭
   控制窗口；崩溃后从另一个窗口退出应用。均只收尾一次，不被cancel_all或
   purge_tracked删除，不因重复join/重复停止卡死；退出等待文件操作完成。
5. 明确关闭先于故障接管时允许原关闭/取消优先，提示不能承诺不存在的文件。
6. 让测试app-local-data保存失败（拒绝写权限或受控磁盘配额）：显示真实保存错误
   和仍存在的临时路径；可自行复制；不展示成功，不覆盖已有恢复文件。
   编码/捕获失败时提示“未能确认完整文件”，不发布残缺MP4为成功产物。
7. 正常录屏Stop→预览→保存/关闭、Cancel、时间上限、滚动截图停止分别回归；
   正常帧队列/编码吞吐不因新共享收尾对象增加逐帧锁/分配。
   上次异常录屏仍在复制大文件时，关闭旧控制窗后开始新采集；迟到完成回调不得
   关闭新采集边框或恢复其隐藏窗口，只报告旧文件的保存结果。

证据：原生提示及真实路径、解码结果、hash、清理前后目录、采集停止时间；
只删除本用例生成文件。失败文件/日志保留至诊断完成。

## TC-RECOVERY-N12 — 分离终端与UTF-8元数据（review #4/#5）

1. 创建计数PTY，记录backend session ID/PID。分离到窗口，使logical tab ID、
   route/handoff ID与PTY ID不同；等待handoff超过60秒且被正常清理。
2. 故障恢复分离窗口：恢复描述中为原logical tab ID和PTY ID；“观察原终端输出”
   可用、计数连续。无新shell/SSH认证/startup；savedSessionId不可伪造为route ID。
3. 改为新建的分离终端、带原ID adopted terminal，及没有handoff/runtime的窗口；
   最后一种应提示缺失而非猜测ID。普通detach/关闭归位另按N04回归。
4. 使用支持长名称的标题入口/隔离测试夹具依次设置200中文、128emoji、
   511 ASCII+emoji、组合字符、1MiB超长标题；记录投影的UTF-8长度≤512且无半字符。
   保留另一个标签，随后新开/关闭该标签：最新描述必须继续更新，不能整批被拒绝。
   孤立surrogate由本地单测覆盖（合法UTF-8原生输入无法构造），不伪造原生证据。
5. 128/129标签、非法超长ID、多窗口总描述1MiB边界：不截断身份产生碰撞；
   已存在旧描述不被失败请求清空；超预算对应限制如实展示。

证据：匿名/临时夹具中捕获的元数据、PID/启动时间、计数结果、UTF-8字节数。
不得把真实会话内容或凭据写入release日志。

## TC-RECOVERY-N13 — Tools按需查询与无重复副作用

1. 在隔离实例启动一个本地HTTP服务和本地隧道，记录PID/端口；SocksCap可保持idle。
   恢复窗口并停留10分钟：新增后台状态查询为0，无start/stop/boot repair。
2. 点击“查看 / 刷新后台状态”：只出现list_server_statuses、list_tunnel_statuses、
   sockscap_status各一次；界面显示实际状态；查询中连点不重复提交。
3. 一个manager查询失败时，其他两个结果仍显示；失败明确为未知。手动再次刷新
   可恢复，后台任务身份与端口不变。多个旧状态不能冒充实时持续监控。
4. 超过128隧道只显示前128项并提示截断；切换标签、关闭界面或迟到查询不创建
   连接、不运行任务。其他Session/Tools沿N05/N06矩阵保留限制提示。

## TC-RECOVERY-N14 / B-PERF — 本次修正的性能与资源边界

三端分别执行两个对照：完整恢复对照 R0=`75d78f9d` vs R1=最终候选；修正增量
对照 Rfix0=`4fee990c` vs同一候选。完整对照必须保持终端文本镜像优化一致。
候选用HEAD+完整diff/hash标识。不得以修正增量未退化替代恢复功能的完整对照。

1. browser先用同版本Chromium、相同dev/QA mode与可复现录制字节流比较正常
   renderer开销；所有测量钩子只在测试夹具，两组一致。此项只诊断React/JS成本，
   不能替代native输入、WebView、PTY或生产release；不使用单步runner耗时当产品延迟。
2. native按N09的1/4/16终端与四种尺寸，scrollback10000及配置上限，负载为静止、
   纯文本、ANSI、小包、TUI和高速持续输出。先预热60秒，采样180秒，至少5轮
   A/B交错配对；同设备功耗/缩放/后台负载。另含128标签+长中文/emoji标题。
3. 正常稳定输出60秒：恢复相关IPC、标题读取、正文/全store复制、恢复定时器
   增量必须为0；只有真实元数据变化提交描述。同ID的1000次activity更新不重新
   构造标题，IPC阻塞期间连续结构变化只保留最新待提交项，不能增长排队对象。
4. 真实标题变更一轮最多扫描128项，每个标题仅扫描512 UTF-8字节边界；
   比较512B、64KiB、1MiB标题，投影成本不随输入全长线性增加。不增加全历史读取。
5. 录屏Stop/异常收尾的开销只发生在结束路径；活动录屏的capture/encoder线程帧
   循环无新增恢复锁/拷贝。后台保存使用有界流复制，文件从1MiB到允许的最大值，
   RSS不能随整个文件大小增长；关闭/退出竞态无等待环，失败文件路径可核对。
6. 每轮记录按键到显示p50/p95/p99/最大值、帧分布/长任务、吞吐、Rust/renderer CPU
   与RSS、分配量、额外IPC和字节、描述次数、回收后的订阅数。保留所有原始慢样本。
   任何可重复退化即fail；新增>50ms长任务直接fail，2%/1ms/5%仅测量灵敏度，
   不是可消耗的退化额度。噪声过大补样本，不放宽门槛。
7. 按N09完成Linux72–96h；Windows/macOS分别留长时样本。没有样本标unrun，
   不得宣称GC根因修复、零性能损失或三端验收通过。本轮全项只编写、不执行。
