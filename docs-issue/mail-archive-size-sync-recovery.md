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
- GitHub按授权运行 `.github/workflows/qa-ui-auto-platforms.yml`，全部邮件及受影响备份/MFA用例，三OS browser/native；最终证据待执行。既有全仓 contracts 的31项AI/DB未评审缺口不属于本次变更；本次case独立校验，audit静态覆盖门禁通过。

日志目录：`qa-ui-auto-report/mail-archive-recovery/`。不以 dry-run、unit 或上轮 CI 代替本轮三端 native 证据。不在无同条件基线时宣称百分比提速。

## 大文件夹批量删除的现有操作

在目标远端文件夹的邮件列表内点击使其获得焦点，Ctrl+A（macOS Cmd+A）选择当前已经加载的邮件，点击 Delete selected，确认移入 Trash；需要时先用 Load older messages 增加本次加载范围，再全选删除。选择仅覆盖已加载行，不能宣称选中了服务器整个文件夹。数万封整文件夹处理目前优先使用邮箱服务商网页的“选择整个文件夹/全部结果”功能，随后 Taomni Sync 对账。

普通删除会操作远端邮箱并更新本地摘要；按用户选择，完整本地归档仍保留。释放原件磁盘空间需要进入 Local archive、选中原件并使用 Remove local originals 确认清理；不会因此删除远端邮件。此轮未擅自添加或执行整文件夹清空操作。

## 首轮 CI 回归修复

GitHub `39034904707` 的 Linux/macOS browser 原始报告发现 `TC-MAIL-SYNC-01` 重开后只显示 203/453 封、hasMore=false。新增队列 effect 的 cleanup 错误地推进了所有同步循环共享的 generation；开发模式 StrictMode 重放 effect 时，第一条 on-open 追赶被取消，而第二次 setup 因 guard 占用没有启动替代追赶。改为仅清理队列自己拥有的 worker，不取消其他 folder loop。补充 StrictMode 三批追赶 mounted 回归。

当前本地结果：68 个 mounted 测试通过；Linux browser `TC-MAIL-SYNC-01/02`、`TC-MAIL-PERF-01` 三项实际执行通过，保留 receipt 和原始性能样本。133 个 Rust 邮件测试通过，1 个既有外网凭据用例 ignored；14 个 Python 假服务器协议测试通过；前端构建通过。最终三端结果仍需使用修复后的提交重新执行，不引用首轮部分通过作为最终通过。

首轮 Linux native 的新 `TC-MAIL-SYNC-03` 与原生并发性能 `PERF-02` 均通过。新 `STORAGE-03` 已通过全部协议失败/Retry/完整 MIME磁盘oracle，最后打开归档时立即 assert_count 与异步IPC加载竞争，观察为0行，失败快照实际已显示2行。补充等待真实 `[mail-archive-dialog][open]`（产品只在条目加载完成后打开），再保留原有精确2行及附件断言；不增加固定sleep、不降低断言。最终三端重跑包含此用例修正。
