# 大邮箱同步期间的响应性修复

日期：2026-10-16。范围：IMAP 邮件同步、正文预取/阅读、SMTP 发送反馈，以及邮件缓存占用公共异步工作线程的问题。

## 现场与原因

用户报告 History 10948/33913、Bodies 14/313 长时间推进缓慢，阅读邮件和本地/SSH 终端也变慢，SMTP 实际发送后界面仍等待。

对运行实例仅做进程观察和 SQLite `mode=ro` 查询；未修改其数据库、配置或其他本地存储，未重启或替换运行实例。测试使用内存库、临时库或专用 QA 配置，SMTP/IMAP 测试仅连接 loopback 模拟服务。

发现的机制：

1. 每次同步的正文清理对所有未缓存正文的邮件也执行 UPDATE，触发 FTS 删除/插入。历史越多，每一批重复写入越多。
2. 每批历史同步扫描整个账号重建联系人；打开写信窗口也全量重建，并且原来没有事务，导致每个地址单独提交。
3. 同步写库、缓存读库及数据库锁等待直接在 Tokio 工作线程运行，影响同时使用这些线程的终端 I/O 和代理转发。
4. 同一账号的历史同步、全文件夹扫描、正文预取和交互操作共享 IMAP 锁；全文件夹扫描可能长时间占锁。
5. SMTP 成功后仍同步等待 IMAP APPEND 和联系人入库；局部缓存错误甚至能把已经接受的发送变成前端失败/重试。
6. 预取正文复用了交互加载函数，将无须显示的 HTML/CID 数据传给 WebView，并更新阅读器与内存缓存。

## 修改后的行为

- 仅清理实际有正文的记录，保持正文保留上限及全文索引正确性。
- 正常 initial/backfill/catchup 只收集新增邮件的联系人；重放、删除、UIDVALIDITY 重建和头部裁剪仍重建以保证计数。重建先聚合地址，以单次事务提交。
- 同步应用、正文缓存、列表、草稿、联系人查询/重建迁入 `spawn_blocking`；锁等待也在该线程池执行。
- IMAP 池按账号区分交互与后台两个连接，各自拥有互斥锁、协议流和会话代理；池的全局 map 锁不包围网络 LOGOUT。IDLE 保持原有专用连接。
- `mail_prefetch_message_body` 只预热原生磁盘缓存，不向 WebView 传正文。直接阅读使用交互连接，不等待同 UID 的后台预取 Promise。
- SMTP 接受即返回成功，关闭写信窗口；副本与联系人由后端继续处理。`mail-sent-copy` 事件单独显示副本结果，副本失败不会触发 SMTP 重试；APPEND 不自动重试，以避免响应丢失时重复存副本。

保持：无缺口同步/续传水位、UIDVALIDITY 重建、保留策略、全文搜索、草稿、线程回复头、附件 MIME、账号网络配置与失败语义。没有更改邮箱网络路由设置。

## 测量与验证

在只读取得的生产缓存**内存快照**上，针对同一 INBOX 和 200 封正文保留上限，分别执行原清理 SQL 与新增过滤条件的 SQL，每次均回滚，3 次原始结果：

| 版本 | 耗时（ms） | 每次匹配行 | 每次 SQLite total_changes（含触发器） |
| --- | --- | --- | --- |
| 原逻辑 | 841.52 / 869.74 / 832.62 | 15960 | 139660 |
| 修复过滤条件 | 10.64 / 9.51 / 9.07 | 0 | 0 |

这是特定清理 SQL 的同数据比较，不代表整次邮箱同步或真实网络加速倍数。

- `cargo test --manifest-path src-tauri/Cargo.toml -j 2 --lib mail:: -- --test-threads=2`：111 通过；原有真实 Outlook 用例 1 项 ignored，需要个人凭据，未执行。
- 新增 `mail::responsiveness_tests`：真实 loopback IMAP 下后台占锁时读取正文、单线程 Tokio 的数据库锁等待/定时器、4000 封头部的正文裁剪/FTS、增量联系人和批次重放、loopback SMTP 接受后副本失败且只发送一次。
- `pnpm exec vitest run src/components/mail/MailClientTab.test.tsx src/lib/mailSync.test.ts src/lib/mailOutbox.test.ts`：67 通过。
- `pnpm exec tsc -b --pretty false`：通过。
- TC-116 扩展为“刷新→阅读→回复→发送”，Linux browser：1 通过、0 失败、0 跳过。模拟边界的挂载测试另行覆盖后台预取阻塞、草稿清理阻塞和异步副本错误。
- QA audit、TC-116 CI 规划及工作区开发契约检查通过。
- 修改的 Rust 邮件模块 `rustfmt --check` 和 `git diff --check` 通过。仓库 `cargo fmt --check` 存在大量原有格式差异，未对无关模块做全仓格式化。

Linux 原生 QA：使用 `pnpm tauri build --debug --no-bundle --config .agents/skills/qa-ui-auto/assets/tauri.qa.conf.json --ignore-version-mismatches -- --locked` 构建，完整 frontend build 和原生构建成功。复用工程增量 target，构建输出仍为独立 QA 标识；测试启动后再次验证 `getIdentifier() == com.taomni.app.qa`。源码哈希记录在 `source-identity.json`。

原生探针在专用 `native-profile-20261016-223343` 目录种入 40,948 条模拟邮件头，INBOX 为 10,948/33,913，使用真实 WebKitGTK、Tauri IPC、SQLite、TCP IMAP/SMTP 和本地 bash PTY。服务器故意阻塞历史 FETCH，分别读取三封未缓存正文并发送一封测试邮件；同时重建联系人，检查 PTY 输出。随后释放 FETCH，完成 50 封补历史；Sent APPEND 返回模拟配额错误。

| 原生断言 | 实测结果 |
| --- | --- |
| 历史 FETCH 未返回时，正文仍可读取 | 102 / 102 / 116 ms，三个 UID/正文均正确 |
| FETCH 未返回、APPEND 另行等待时，SMTP 立即反馈接受 | 44 ms，SMTP 接受次数为 1 |
| 同时索引 40,948 条邮件时，本地终端仍输出 | 10 / 8 / 10 / 5 / 7 / 8 / 4 / 13 ms |
| 同一 QA 实例的空闲终端样本 | 6 / 8 / 2 / 1 / 1 / 1 / 7 / 3 ms |
| 全量联系人重建 | 496 ms，22 个聚合地址，未阻塞上述终端命令 |
| 同步解除阻塞后继续 | fetched = 50 |
| 副本失败反馈与发送次数 | 收到 `mail-sent-copy` 的 OVERQUOTA 错误，SMTP 仍只接受一次 |

终端指标是 JS 发起 IPC 到真实 PTY 输出 Channel 返回的时间，不是物理按键到屏幕延迟。原生结果是本地模拟服务的响应性证明，不是个人邮箱服务器的速度基准，也未对旧版完整应用做同条件比较。保留原始样本和两次探针调试记录：首次因 QA 数据目录定位错误退出；第二次发现空闲/并发终端标记复用，因此终端数据作废，改为不同标记并清空接收缓冲后重跑得到上表最终样本。产品源码无需为探针重跑而修改。

运行日志、源码哈希、原生探针 `native_probe.py`、`native-results.json` 和浏览器截图位于 `qa-ui-auto-report/mail-responsiveness/`。原生 QA 构建使用独立 `com.taomni.app.qa` overlay；当前用户安装的 `/usr/bin/taomni` 保持运行。

## 边界

没有测量个人邮箱服务器的端到端完成时间，没有 Windows/macOS 执行证据。新增连接仍受服务器连接数和网络延迟约束。

副本任务独立于标签页/写信窗口，仍为进程内 best effort：进程在 SMTP 成功后退出，未完成的副本不会跨启动恢复。该结果不影响已被 SMTP 接受的邮件，不应因此重发。
