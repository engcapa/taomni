# 邮件原件归档大小兼容与手工同步响应性

分支：`fix/mail-archive-size-recovery`；基线：`c85c4cbf`。

## 现象与证据

用户报告本地归档 `INBOX 0/33932`、`IMAP returned an invalid email size or empty chunk`，Retry 不能恢复；手工 Sync 长时间旋转，有时显示 Connection Lost。全程不访问或修改个人运行实例的数据库、配置、邮件文件，也不重启个人应用。测试使用临时 SQLite、loopback IMAP/SMTP、隔离 QA 应用。

原归档代码把 RFC822.SIZE 当作准确终点，声明大小偏大、偏小或 EOF 返回空块都会失败；旧 partial 恰好达到声明大小时可能提前发布。真实 TCP 回归在旧实现复现同一错误：`rust-red.log`。未抓取个人服务器响应，不能确定其具体偏差方向或故障 UID。

另一个真实 TCP 回归以 1,100 个稀疏十位 UID 和 4 KiB 命令上限，稳定复现 `IMAP UID FETCH FLAGS failed: Connection Lost`（`sync-rust-red.log`）。旧 FLAGS 每批 1,000 UID；headers/bodies 最多 2,000 UID，也可能超过服务器命令长度限制。重连继续发送同一超长命令不能解决。

手工 Sync 原先在全文件夹扫描后，继续等待最多 6 文件夹各 20 个历史批次才结束按钮状态；后台同步持有前端 guard 时，手工操作缺少优先让出机制。后端把整个账号扫描包进一次连接重试，后面的文件夹断连会让已经完成的文件夹重新扫描，所有结果也延迟到最后落库。

## 修复和保留行为

- 归档以 UID、UIDVALIDITY、实际 byte range、literal 与 EOF 验证完整性；RFC822.SIZE 用作进度和身份变化提示。满块继续探测 EOF，声明大小不符的短块再确认 EOF，允许正 offset 的 NIL EOF。拒绝空原件、冲突大小、错误 offset 和多个正文块；兼容旧断点元数据。
- 若崩溃仅留下断点元数据而正文缺失或零字节，忽略旧 size hint 从零重新下载，避免 Retry 因删除不存在的 partial 反复失败。真实磁盘回归同时覆盖两种状态。
- 单封内容不可读时保留明确的文件夹/UID错误并继续其他可读邮件，最后仍报告 failed；不写永久跳过标记，Retry 会重新尝试未完成原件。网络、磁盘和身份错误仍停止并保留安全断点。
- headers、bodies 和 flags 的显式 UID 命令每批最多 250，保证稀疏十位 UID 也低于 4 KiB。保持排序、完整 header 集合、body cache 限额和未读状态。
- 全账号扫描逐文件夹 checkout/retry、落库和释放后台连接；后续失败不丢前面进度，失败文件夹继续明确列出。每个文件夹开始读取最新持久化 watermark。
- 手工 Sync 请求当前后台循环在一步后让出；仍发送该轮已经收到的新邮件提醒，避免提前返回丢提醒（mounted 红→绿回归）。扫描结束即恢复按钮，所有 pending 文件夹轮转执行单批追赶，结束后继续完整对账；不再截断为前六个文件夹。期间可继续打开详情、发邮件及使用其他 session。没有取消真实 IMAP 操作或隐藏网络错误。
- 保留手工完整远端删除/flags对账、后台 gap-free 追赶、分页深度、归档压缩结构、完整附件、暂停/断点、跨实例协调、备份以及显式本地清理后不自动复活原件等现有契约。

## 验证选择

- Rust `mail::`：真实 loopback 协议、临时 SQLite、size 偏差/EOF/断点、不可读正文不阻塞其他原件、稀疏 UID 命令长度，以及所有现有邮件回归。
- mounted：MailArchivePanel Retry IPC/恢复状态；MailClientTab 后台持有 guard 时的手工 Sync、按钮及时结束、后续批次和完整对账；保留文件夹切换、删除/已读、发信等全部既有组件断言。
- `TC-MAIL-STORAGE-03`：三端 native，UI配置到真实 FETCH、失败/重复Retry/恢复、独立 SQLite+gzip+MIME 内容及附件 oracle。browser 无法证明协议与磁盘内容。
- `TC-MAIL-SYNC-03`：三端 native，1,100 稀疏十位UID、无 CONDSTORE服务器、主动断开一次 FETCH、4 KiB命令限制、按钮恢复、完整列表与远端删除/flags；独立服务器计数证明一次断连且没有超长命令。
- `TC-MAIL-PERF-01`：browser 双账号负载增补 Sync 按钮恢复；PERF-02/03保留原生33,913邮件、313正文、真实并发worker、PTY、发信、多账号/多实例等固定预算和原始样本。
- GitHub按授权运行 `.github/workflows/qa-ui-auto-platforms.yml`，全部邮件及受影响备份/MFA用例，三OS browser/native；最终198次执行全部通过，见下文。既有全仓 contracts 的31项AI/DB未评审缺口不属于本次变更；本次case独立校验，audit静态覆盖门禁通过。

日志目录：`qa-ui-auto-report/mail-archive-recovery/`。不以 dry-run、unit 或上轮 CI 代替本轮三端 native 证据。不在无同条件基线时宣称百分比提速。

## 大文件夹批量删除的现有操作

在目标远端文件夹的邮件列表内点击使其获得焦点，Ctrl+A（macOS Cmd+A）选择当前已经加载的邮件，点击 Delete selected，确认移入 Trash；需要时先用 Load older messages 增加本次加载范围，再全选删除。选择仅覆盖已加载行，不能宣称选中了服务器整个文件夹。数万封整文件夹处理目前优先使用邮箱服务商网页的“选择整个文件夹/全部结果”功能，随后 Taomni Sync 对账。

普通删除会操作远端邮箱并更新本地摘要；按用户选择，完整本地归档仍保留。释放原件磁盘空间需要进入 Local archive、选中原件并使用 Remove local originals 确认清理；不会因此删除远端邮件。此轮未擅自添加或执行整文件夹清空操作。

## 首轮 CI 回归修复

GitHub `39034904707` 的 Linux/macOS browser 原始报告发现 `TC-MAIL-SYNC-01` 重开后只显示 203/453 封、hasMore=false。新增队列 effect 的 cleanup 错误地推进了所有同步循环共享的 generation；开发模式 StrictMode 重放 effect 时，第一条 on-open 追赶被取消，而第二次 setup 因 guard 占用没有启动替代追赶。改为仅清理队列自己拥有的 worker，不取消其他 folder loop。补充 StrictMode 三批追赶 mounted 回归。

本地结果：68 个 mounted 测试通过；Linux browser `TC-MAIL-SYNC-01/02`、`TC-MAIL-PERF-01` 三项实际执行通过，保留 receipt 和原始性能样本。133 个 Rust 邮件测试通过，1 个既有外网凭据用例 ignored；最终24个 Python 邮件测试工具回归通过；前端构建通过。三端最终证据使用下文修复后的完整运行，不引用首轮部分通过作为最终通过。

首轮 Linux native 的新 `TC-MAIL-SYNC-03` 与原生并发性能 `PERF-02` 均通过。新 `STORAGE-03` 已通过全部协议失败/Retry/完整 MIME磁盘oracle，最后打开归档时立即 assert_count 与异步IPC加载竞争，观察为0行，失败快照实际已显示2行。补充等待真实 `[mail-archive-dialog][open]`（产品只在条目加载完成后打开），再保留原有精确2行及附件断言；不增加固定sleep、不降低断言。最终三端重跑包含此用例修正。

首轮 macOS native 的 `PERF-03` 显示 primary 已实际 downloading，探针仍无条件点击已经被自动扫描替换的 Resume，导致 element not found（尚未进入 ownership 断言）。探针现允许“已在运行”状态，并在空闲时仍通过真实 Resume 控件启动；只接受该控件消失且 Pause 确认存在的特定竞态，其他 WebDriver 错误继续失败。单一 owner、两个真实连接、跨进程暂停/续传、固定终端预算、迁移/物理清理/不复活断言保持不变，额外记录阶段及自动/手工启动路径。新增4个工具回归；协议性能工具共7项通过。此为测试编排修复，不改变产品或性能门限。

首轮 Windows `SYNC-03` 的故障注入被 full-MIME 归档连接消费，且精确同步提示被迟到的分页 Loaded 提示覆盖。故障现只命中无 CONDSTORE 的 `(UID FLAGS)` 同步请求；真实 fake-server 回归证明原件/HEADER活动不会消费故障。用例等待 Sync 按钮恢复并保留远端数量/未读数对账，增加服务器 oracle 要求确实发生大于200个显式UID的flags批次、恰好一次断连、零超长命令，替代不稳定的瞬时提示文本。未降低产品或延迟断言；24项邮件测试工具回归通过。

## 最终 GitHub 三端验证

最终运行：[39037753579](https://github.com/engcapa/taomni/actions/runs/39037753579)，workflow 为 `.github/workflows/qa-ui-auto-platforms.yml`，测试提交 `04c52892558af1130bd3562cdb4057f3222865f4`。2026-10-17 汇总 job 成功，`passed=true`、`report_ok=true`，failures、gaps、unreviewed、infrastructure_errors 均为空。

选择包含全部36个邮件相关用例及7个相关备份/MFA用例，共43个不同ID；按browser/native适用性，每平台每模式各33项。没有把不适用模式当成跳过或通过。

| 平台 | browser | native |
| --- | --- | --- |
| Linux / WebKitGTK native | 33/33 | 33/33 |
| Windows / WebView2 native | 33/33 | 33/33 |
| macOS / WKWebView native | 33/33 | 33/33 |

总计198次执行全部通过，0失败、0跳过。browser均为对应OS上的Chromium；native使用隔离的 `com.taomni.app.qa`，macOS通过其WKWebView bridge执行，不将browser结果替代native。

本地复核15份原始summary及对应receipt：每份选择与selection manifest逐项一致，exitCode=0、identity_stable=true；receipt列出的所有artifact大小和SHA-256重新计算一致。三端source/runner身份与当前工作区完全相同，native构建source匹配；每OS各分片使用同一个QA binary hash。复核输出：`qa-ui-auto-report/mail-archive-recovery/review-verified.log` 与 `review-39037753579.json`；完整原始报告位于 `run-39037753579/`，也保留于该GitHub运行的artifacts。三端归档恢复截图均人工检查，完整两封原件、正文和附件显示正常。

第二轮 `39036378011` 在三端browser通过后，因后续探针修正已推送而主动取消，避免重复冷编译；取消部分不算通过。最终结论只使用上述同一完整运行，不拼接前两轮结果。此后的提交仅补充本文档，不改变产品、runner或用例输入，无需重复UI执行。

### 大量邮件并发性能证据

`TC-MAIL-PERF-02` 使用33,913封邮件、313正文负载，双email session、真实协议worker及PTY并行；每端记录6个连接、6个服务器线程，观测到Linux最大3个、Windows/macOS最大4个并发FETCH。`TC-MAIL-PERF-03` 另启动同机第二个QA实例，共享同一测试邮件存储，验证单一归档owner、跨实例暂停、从262,144字节精确续传、迁移、物理清理后对象为0，以及再次扫描不复活且摘要保留。

以下是原生自动化从UI操作发出到观测结果的p95，单位ms，含自动化开销；每指标保留全部5个原始样本，没有剔除慢样本。两账号详情列取两者较慢值，分别仍保留在原始JSON中。

| 指标 | Linux | Windows | macOS | 固定预算 |
| --- | ---: | ---: | ---: | ---: |
| 同步负载中邮件详情 | 708.68 | 641.00 | 603.85 | 2500 |
| 同步负载中发信反馈 | 362.97 | 250.00 | 301.80 | 3000 |
| 同步负载中本地终端 | 400.34 | 640.00 | 297.70 | 1500 |
| 第二实例后台归档时终端 | 311.43 | 344.00 | 418.15 | 1500 |

第二实例终端采样期间均有真实后台FETCH和进度，排除了仅在空闲时采样的情况。三端browser的双账号详情/发信样本也均通过既定预算。本次没有同条件旧版本性能基线，不宣称百分比提速或已证明所有场景无性能回归；这些数据证明固定压力场景下响应预算达标，不代表个人邮箱外网耗时。

三端同时通过新增 `STORAGE-03`、`SYNC-03`，以及既有 `SEND-01`（Sent副本）、批量已读/删除、设置文件夹显示、备份及其他全部邮件回归。所有远端删除、清理和故障注入仅作用于QA假服务器及临时存储，未访问或修改个人运行Taomni的数据库、配置、归档文件，未重启个人进程。
