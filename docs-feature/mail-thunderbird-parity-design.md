# 邮件客户端 Thunderbird 对齐差距与开发任务 详细设计

## 1. 设计摘要与范围

- 类型：现有能力扩展 + 可靠性缺陷修复（差距盘点 + 分期开发任务）
- 文档位置：`docs-feature/mail-thunderbird-parity-design.md`
- 设计状态：部分可实施。P0（同步可靠性）已收敛，可直接实施。P1 及以后的卡片已定范围，接手时需先按卡片补齐细节。
- 来源：用户需求“分析 Taomni 邮件客户端与 Thunderbird 的差距，形成可交给其他 agent 开发的任务”，并反馈了已知问题：邮件会话关闭一段时间后，会漏掉一部分邮件。
- 调研基线：`main` @ `6d348256`，工作区干净。调研方式为阅读源码，未运行测试，也未连接真实邮箱。文中的行号以该提交为准。
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行。邮件模块只使用跨平台依赖：`imap` 2.4.1（同步 API）、`lettre` 0.11、`mail-parser` 0.11、`native-tls`、`rusqlite`。
- 本轮真机执行端：Windows（当前开发环境）。macOS、Linux 保留验证计划。
- 推荐方案：
  - P0 重写 IMAP 同步状态模型。以持久化的连续 UID 区间 `[sync_low_uid, sync_high_uid]` 取代 `MAX(uid)`：新邮件从 `sync_high_uid+1` 起全量补齐，历史邮件向下回补。
  - 同时对账已读等标志和服务器端删除。
  - 缓存默认改为完整邮件头索引。前端列表只读本地缓存，不再用 `offset = messages.length` 向服务器翻页。
  - 其余 Thunderbird 能力按 P1–P3 拆成独立卡片。

用户问题：Taomni 的邮件客户端能满足基本收发，但与 Thunderbird 相比，缺少可靠的离线同步，也缺少线程、搜索、身份、服务器草稿与已发送副本、过滤器、通讯录和日历等常用能力。其中“会话关闭一段时间后漏收邮件”属于数据正确性缺陷，优先级最高。

本设计完成后应观察到的结果：
- 任意时长的关闭、断网或中断之后，重开邮件会话都能补齐服务器上的全部邮件，本地与服务器的已读、星标、删除状态一致。
- 其余差距按优先级有可以独立领取的任务卡。

本设计不做以下内容：
- 关闭标签后的后台收信（DEC-01 用户已定不做）
- OpenPGP / S/MIME（DEC-03 暂不做）
- RSS、新闻组、聊天等与 Taomni 定位无关的 Thunderbird 模块

## 2. 当前实现与功能缺口

### 2.1 同步调用链（现状）

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/mail/MailClientTab.tsx:1944-1952`（open effect） | 标签可见且 `sync.onOpen` 为真时调用一次 `syncFolder(selectedFolder, { limit: batchSize })`，最终走 `mail_sync_headers(offset 0)`。`batchSize` 由 `refreshBatchSize` 计算，上限为 `MAIL_REFRESH_BATCH_SIZE = 50`（`:273`、`:596`）。 | 修改：打开时改为 catch-up 同步 | 源码，确定 |
| `MailClientTab.tsx:1957-1976`（interval effect） | 每 `intervalMinutes`（默认 5）触发一次。5/6 的 tick 调 `quietPollSelectedAndInbox`，对选中文件夹和 INBOX 各跑一次 `mail_sync_headers(offset 0, limit 50)`；每第 6 个 tick 调 `syncAllFolders`，即 `mail_sync_all_folders`。定时器只在组件挂载期间存在，标签关闭后不再收信。 | 修改：quiet poll 改走增量 | 源码，确定 |
| `MailClientTab.tsx:2096-2118` `loadMoreMessages` | 滚动到底部时调 `mail_sync_headers(offset = messages.length, limit = pageSize)`。服务器按“最新优先”的偏移翻页，而 `messages.length` 数的是本地列表（缓存中的旧邮件加上新拉到的邮件）。 | 替换：改为本地缓存游标，服务器侧改为向下回补 | 源码，确定 |
| `MailClientTab.tsx:1139-1151` `filteredMessages` | 搜索只在当前已加载的 `messages` 内存数组里做子串过滤 | P1 搜索 | 源码，确定 |
| `src-tauri/src/mail/mod.rs:1511` `mail_sync_headers` → `imap_sync_folder`（`:3506`） | EXAMINE 后调 `imap_page_uids_newest_first(offset, limit)`（`:3425`），只取“最新的第 offset..offset+limit 封”。不读、不写任何同步水位。 | 修改：不再作为增量入口 | 源码，确定 |
| `mod.rs:1615` `mail_sync_all_folders` → `imap_sync_folder_incremental`（`:3552`） | 起点是 `cached_folder_sync_states`（`:5086`）得到的 `COALESCE(MAX(m.uid),0)`，即缓存中最大的 UID，不是持久化水位。`max_uid == 0` 时退化为“最新 N 封”（`:3593`）。 | 替换为区间水位 | 源码，确定 |
| `mod.rs:4496` `cache_sync_result` / `:4517` `cache_sync_all_result` | 同一事务内依次执行：UIDVALIDITY 变化时清空该文件夹 → upsert 文件夹 → upsert 消息 → `prune_mail_cache` → 重建联系人索引 | 修改 | 源码，确定 |
| `mod.rs:5009` `prune_mail_cache` | 按 `date_ts`（优先取 `Date:` 头，缺失才用 INTERNALDATE，见 `:3994`）删除早于 `header_retention_days`（默认 30）的行；再按 UID 只保留 `header_limit_per_folder`（默认 2000）行；正文只保留最近 `body_recent_limit` 封 | 修改：默认完整头索引（DEC-02） | 源码，确定 |
| `mod.rs:4590` `upsert_message` | `flags_json = CASE WHEN excluded.flags_json != '[]' THEN excluded ELSE old END` | 修复：FETCH 返回的 FLAGS 是权威值 | 源码，确定 |
| `mod.rs:895` `MailImapPool` | 每个账户一个复用会话，空闲 180 秒（`IMAP_LIVE_IDLE_TTL`，`:53`）后过期；取出前发 NOOP 探活，传输错误重试一次 | 沿用 | 源码，确定 |

### 2.2 “关闭一段时间后漏收邮件”根因

结论（确定性：高，源码推导，尚未用真实邮箱复现）：连接过期本身不会丢数据，同步状态保存在 SQLite 里。丢邮件来自同步算法：“最新 N 封”的页式同步会把 `MAX(uid)` 推过中间未拉取的 UID，之后的增量同步和“加载更多”都会跳过这段缺口。另有几条路径会让已经在服务器上的邮件在本地不可见，或让状态不一致。

| ID | 触发场景 | 机制（代码依据） | 用户可见结果 |
|---|---|---|---|
| R1 缺口跳跃（主因） | 标签关闭期间到达的新邮件多于 50 封（上限即 `MAIL_REFRESH_BATCH_SIZE`）后重开；或一个轮询周期内到达多于 50 封 | 重开时 `mail_sync_headers(offset 0, limit 50)` 只拉最新 50 封，写入缓存后 `MAX(uid)` 已跳到最新。下一次 `imap_sync_folder_incremental` 从 `MAX(uid)+1` 开始（`mod.rs:3584`），中间那段 UID 永远不会被增量拉到。 | 列表按日期排序，最新 50 封下面直接接上关闭前的旧邮件，中间一段邮件“消失”，且没有任何提示 |
| R2 “加载更多”越过缺口 | R1 发生后滚动到底部 | `loadMoreMessages` 传 `offset = messages.length`（本地数量 = 缓存旧邮件 + 新 50 封），而服务器端偏移是从最新开始数的。本地旧邮件越多，偏移越深，缺口邮件在服务器排序中位于 51..(50+缺口数)，被整段跳过。 | 缺口数小于本地旧邮件数时，缺口邮件滚动也看不到 |
| R3 按 `Date:` 头过期删除 | 邮件的 `Date:` 头早于 30 天（转发的旧邮件、导入、时钟错误的发件方、延迟投递） | `prune_mail_cache` 在同一事务中，把刚写入的这类邮件按 `date_ts < cutoff` 删掉 | 新到的邮件刚同步就被清理，永远不在列表中出现 |
| R4 水位归零后退化 | 文件夹所有缓存行都超过保留期被删（例如一个月没打开），或该文件夹从未缓存过 | `MAX(uid)` 变为 0，`same_uid_validity` 为假，走 `imap_recent_uids_for_limit`，只拉最新 N 封（`mod.rs:3593`） | 退化为 R1 |
| R5 已读状态回退不同步 | 在另一客户端把邮件标为未读（服务器返回空 FLAGS） | `upsert_message` 遇到空 flags 保留旧值（`mod.rs:4612`） | 本地仍显示已读，未读计数与服务器不一致 |
| R6 删除与标志不对账 | 在其他客户端删除、移动或改星标 | 没有 EXPUNGE、VANISHED、CONDSTORE 处理。标志只在“最新 N 封”页内偶然刷新。 | 已删邮件在本地残留，星标和已读状态过期 |
| R7 新邮件提醒被吞 | 正常使用 | quiet poll 用页式同步推高 `MAX(uid)` 但不计数；每第 6 个 tick 的 `mail_sync_all_folders` 才统计 `new_messages` 并调用 `pushMailNew`（`MailClientTab.tsx:1687`），此时看到的新邮件已所剩无几 | 选中文件夹和 INBOX 的新邮件大多没有提醒 |
| R8 同步失败静默 | 某个文件夹 EXAMINE 或 SEARCH 失败 | `mail_sync_all_folders` 只记 `tracing::debug` 后跳过（`mod.rs:1671`） | 用户不知道某个文件夹没有同步 |

R1、R2、R4 共同的根本原因是：“同步到哪里”由缓存内容推断（`MAX(uid)`），而缓存本身是按“最新 N”页和保留策略裁剪过的。P0 的解法是持久化一个不变量：本地缓存恰好包含服务器 `[sync_low_uid, sync_high_uid]` 区间内的全部现存 UID（见 §4.2）。

### 2.3 与 Thunderbird 的能力对比

图例：✅ 已具备，🟡 部分具备，❌ 缺失。“任务”列指向 §6 的卡片，“—”表示本次不做。

| 领域 | Thunderbird 能力 | Taomni 现状（依据） | 差距 | 优先级 / 任务 |
|---|---|---|---|---|
| 同步 | 可靠的增量同步，记录每个文件夹的 UIDNEXT/UIDVALIDITY 与 CONDSTORE | 🟡 以 `MAX(uid)` 推断同步位置，与“最新 N 封”页式同步混用（§2.2） | 漏收邮件（R1–R4），删除和标志不对账（R5、R6） | P0 / TASK-01–05 |
| 同步 | IMAP IDLE 即时推送 | ❌ 只有轮询，默认 5 分钟（`MailClientTab.tsx:1957`） | 新邮件有延迟 | P1 / TASK-12 |
| 同步 | 应用运行期间对所有账户后台检查 | ❌ 定时器随标签卸载而停止 | DEC-01 决定不做，只保证重开时补齐 | — |
| 离线 | 完整的邮件头数据库（msf），可选离线正文 | 🟡 SQLite 缓存，默认 2000 封 / 30 天上限，按 `Date:` 头裁剪（`mod.rs:5009`） | 头索引不完整，影响搜索、线程和对账 | P0 / TASK-01（DEC-02） |
| 账户 | 自动配置（ISPDB、Autodiscover、SRV） | ❌ 手工填写；provider 只有 Custom/Gmail/Outlook（`mod.rs:72`） | 配置门槛高 | P2 / TASK-14 |
| 账户 | OAuth2（Gmail、Microsoft、Yahoo、AOL、Fastmail 等） | 🟡 Gmail/Outlook 支持 loopback + PKCE 与设备码流程（`mod.rs:1348`、`:1422`） | provider 少 | P2 / TASK-14 |
| 账户 | 多身份、别名、每个身份独立签名 | ❌ 每个账户一个身份、一个纯文本签名（`mod.rs:336`） | 无法用别名发信 | P1 / TASK-09 |
| 账户 | POP3 | ❌ | DEC-03 纳入 | P3 / TASK-21 |
| 账户 | 证书例外 | ❌ 使用 `native_tls` 默认校验 | 无法连接自签名证书的服务器 | P2 / TASK-14 |
| 连接 | 代理 | ✅ 每个会话可配代理或跳板机，不走全局代理（`mod.rs:3233`） | — | — |
| 文件夹 | 创建、重命名、删除、清空 | ✅ `mail_create_folder`/`mail_rename_folder`/`mail_delete_folder` 与 `handleEmptyFolder` | — | — |
| 文件夹 | SPECIAL-USE 识别、订阅管理、STATUS 未读计数 | ❌ 靠名称识别（`MailClientTab.tsx:527`）；没有 SUBSCRIBE；未读数用 `UID SEARCH UNSEEN` | 非英文或自定义命名的特殊文件夹识别不准；文件夹多时开销大 | P1 / TASK-10 |
| 文件夹 | 统一文件夹、虚拟文件夹（保存的搜索） | ❌ 每个账户一个标签、一个数据库 | 没有跨账户视图 | P2 / TASK-16 |
| 列表 | 线程视图、按列排序与分组 | ❌ 固定按日期倒序（`sortMessages`，`MailClientTab.tsx:600`）；缓存中不存 `References` | 无法按会话阅读 | P1 / TASK-07 |
| 列表 | 快捷过滤（未读、星标、联系人、标签、附件） | 🟡 只有文本子串过滤（`:1139`） | 缺少组合过滤 | P1 / TASK-08 |
| 列表 | 已读/未读、星标、移动、复制、归档、删除到 Trash、垃圾邮件、多选、右键菜单 | ✅ `handleToggleFlagged`、`handleMoveMessages`、`handleArchiveMessages`、`handleJunkMessages`、`handleDeleteMessages` 等 | 拖拽邮件到文件夹：未发现相关实现（源码中只有写信附件的拖放） | P2 / TASK-22 |
| 列表 | 大列表流畅滚动 | ❌ 列表没有虚拟化（未引入 virtual list 依赖） | 完整邮件头索引下，滚动加载到数万行时 DOM 过重 | P2 / TASK-22 |
| 组织 | 标签（关键字） | ❌ | — | P1 / TASK-11 |
| 组织 | 垃圾邮件：自适应识别与 `$Junk` 关键字 | 🟡 只把邮件移到 Junk 文件夹 | 不与服务器的 Junk 关键字同步 | P1 / TASK-11 |
| 组织 | 消息过滤器 | ❌ | — | P2 / TASK-13 |
| 搜索 | 全局搜索（Gloda 全文索引）与服务器搜索 | ❌ 只在已加载列表中过滤 | 无法搜索正文、搜索历史邮件 | P1 / TASK-08 |
| 阅读 | HTML 清洗、远程内容阻断、查看源码、打印、另存 `.eml`、在新标签或窗口中打开、缩放、页内查找 | ✅ DOMPurify 加 sandbox iframe（`mailHtml.ts`、`MailHtmlReader.tsx`），`handleViewSource`、`handlePrintMessage`、`handleSaveEml` | — | — |
| 阅读 | 大邮件、附件按 MIME 部分获取 | 🟡 正文截断在 `body_max_bytes`；附件每次重新拉取整封邮件 | 大邮件显示不完整，附件下载慢 | P2 / TASK-15 |
| 阅读 | 日历邀请卡片（iMIP） | ❌ 跳过 `text/calendar`（`mod.rs:5544`） | DEC-03 纳入 | P3 / TASK-20 |
| 阅读 | 邮件列表退订（List-Unsubscribe） | ❌ | — | P2 / TASK-18 |
| 撰写 | 富文本、内联图片、附件、拖放、粘贴图片、Markdown 粘贴、表情 | ✅ `RichMailEditor.tsx`，feature F-MAIL-2 | — | — |
| 撰写 | 回复、全部回复、转发，引用原文 | ✅ 前端有实现 | 🟡 发出的邮件不带 `In-Reply-To`/`References`（`MailSendRequest`，`mod.rs:506`），不会串成会话 | P1 / TASK-07 |
| 撰写 | 草稿同步到服务器 Drafts | 🟡 只有本地 SQLite 草稿（自动保存） | 换设备看不到草稿 | P1 / TASK-06 |
| 撰写 | 已发送副本保存到 Sent | ❌ 没有 APPEND | 自建 IMAP 服务器上的 Sent 为空 | P1 / TASK-06 |
| 撰写 | 模板、稍后发送、Outbox、已读回执（MDN）、附件提醒 | ❌ | — | P1 / TASK-09（模板）、P2 / TASK-15（附件提醒）、P2 / TASK-17 |
| 撰写 | 收件人补全 | ✅ 基于自动收集的联系人（`mail_contacts`），feature F-MAIL-1 | 没有正式通讯录 | P3 / TASK-19 |
| 通讯录 | 通讯录、vCard、CardDAV、LDAP | ❌ | DEC-03 纳入 CardDAV；LDAP 暂不做 | P3 / TASK-19 |
| 日历 | CalDAV 日历 | ❌ | DEC-03 纳入，分两期 | P3 / TASK-20 |
| 安全 | OpenPGP、S/MIME | ❌ | DEC-03 暂不做 | — |
| 安全 | 钓鱼链接提示 | ❌ | 可以并入阅读器改进，未单独立卡 | 待定 |
| 通知 | 新邮件系统通知 | 🟡 只有应用内 Tao 提醒（`taoAlertStore.pushMailNew`），且多数新邮件没有提醒（R7）。系统通知已有可复用的做法（`src/lib/lanNotify.ts` 通过 `@tauri-apps/plugin-notification`） | 计数不准；没有系统通知 | P0 修复计数（TASK-04）；系统通知并入 TASK-12 |
| 集成 | `mailto:` 协议、导入导出（mbox、Thunderbird 配置） | 🟡 只能导出单封 `.eml`（`mail_save_raw`） | — | P2 / TASK-18 |
| 差异化（保持） | AI 摘要、AI 回复、提取任务 | ✅ `handleAiAction`（`MailClientTab.tsx:200`、`:2603`），通过 AI Chat 线程实现 | Thunderbird 没有此项，保持并在新功能中复用 | — |
| 快捷键 | 键盘导航（J/K、R、A、F、Delete 等） | ❌ 只有正文缩放快捷键（`:1262`） | 效率低 | P2 / TASK-22 |

## 3. 验收条件

### 3.1 P0 同步可靠性（本设计细化到可实施）

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | 账户已同步过；关闭邮件会话标签；期间 INBOX 新到 120 封（大于 50） | 重新打开该会话 | 列表先显示缓存；补齐进度可见（“正在补齐 x/120”）；完成后 INBOX 缓存与服务器 UID 集合一致，120 封全部在列表中，按日期排序，不重复 | 三端；任意 N，包括 1000 以上 |
| AC-02 | 标签打开，一个轮询间隔内新到的邮件多于单批上限 | 等待 quiet poll | 多批连续拉取直至 `remainingNew = 0`，没有跳过的 UID | 三端 |
| AC-03 | AC-01 的补齐进行到一半 | 断网，或关闭标签后再打开 | 再次同步从断点继续，最终无缺口、无重复；中断期间已写入的邮件保留 | 三端 |
| AC-04 | 在其他客户端删除或移走已缓存区间内的 3 封邮件 | 下一次对账（轮询、手动刷新或重开） | 3 封从本地缓存和列表中移除；未读计数与服务器 `UNSEEN` 一致 | 三端；服务器有无 CONDSTORE/QRESYNC 均适用 |
| AC-05 | 在其他客户端把已读邮件改为未读（FLAGS 为空），给另一封加星 | 下一次对账 | 本地显示未读和星标，文件夹未读数随之更新 | 三端 |
| AC-06 | 新到一封 `Date:` 头为 400 天前的邮件 | 同步 | 该邮件保留在缓存中，在列表里可见、可搜索，不会被保留策略删除 | 三端 |
| AC-07 | 文件夹共有 5000 封；缓存只有最新一页 | 在列表中持续向下滚动 | 先按缓存分页；缓存到底后自动向服务器回补更旧的邮件；滚到底时列表数量等于服务器 `EXISTS` | 三端 |
| AC-08 | 服务器端 UIDVALIDITY 改变（文件夹被重建） | 同步 | 该文件夹缓存和水位重置后重新建立，不残留旧 UID，并在状态区提示“文件夹已重建，重新同步” | 三端 |
| AC-09 | 重开或轮询时补到新的未读邮件（排除首次同步、回补，以及 Sent/Drafts/Trash/Junk） | 同步完成 | `pushMailNew` 以准确计数触发一次；首次同步和旧邮件回补不触发 | 三端 |
| AC-10 | 某个文件夹同步失败（EXAMINE 被拒或超时） | 全文件夹同步 | 其他文件夹继续同步；失败文件夹在树上显示警告，悬停可看到错误；状态区汇总失败数量 | 三端 |
| AC-11 | 从旧版本升级，旧缓存里已经存在 R1 造成的缺口 | 升级后首次打开 | 旧缓存不被清空；首次同步检测并补齐已有缺口（缺口邮件不算“新邮件”提醒）；之后按区间水位增量同步 | 三端；迁移可重复执行 |
| AC-12 | 默认缓存设置；文件夹有 30000 封 | 首次打开账户 | 最新一页先显示；其余邮件头在后台回补并显示进度；切换文件夹或关闭标签会暂停，重开后继续；UI 保持可操作 | 三端；邮件头默认不设上限（DEC-02） |

性能：当前没有基线。V-06 负责测量“1000 封新邮件补齐耗时”和“30000 封首次回补耗时”，对象为本地 Dovecot 与一个真实云邮箱。实现后将结果回填到本文 §9，数据用于后续设定目标，本轮不虚构阈值。

### 3.2 P1–P3 卡片验收

每张卡片的验收写在 §6 对应卡片的“验收”字段，编号 AC-20 及以后，接手时细化。

## 4. 方案与关键决策

### 4.1 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 关闭标签后是否后台收信 | A. 仅在重开或重连时补齐。<br>B. 补齐之外，按账户可选开启后台检查。<br>C. 默认后台常驻并使用 IDLE。 | A。关闭标签后不收信、不通知，重开时保证补齐。不实现后台调度器。标签打开期间可用 IDLE 提高及时性，见 TASK-12。 | 用户已定 | 本会话提问的答复：“仅重开补齐” | AC-01、AC-03；TASK-02、TASK-04 |
| DEC-02 本地缓存 / 离线策略 | A. 完整邮件头，正文按需。<br>B. 保持有限窗口（2000 封 / 30 天）。<br>C. 全量离线（含正文和附件）。 | A。邮件头默认不设上限，作为本地索引，支撑线程、本地搜索和对账。正文沿用 `body_recent_limit` 按需缓存。附件缓存另开卡片（TASK-16）。 | 用户已定 | 本会话提问的答复：“全量邮件头+正文按需” | AC-06、AC-07、AC-12；TASK-01、TASK-02 |
| DEC-03 大块扩展范围 | 候选：OpenPGP/S/MIME、通讯录 CardDAV、日历邀请/CalDAV、POP3 | 纳入：CardDAV 通讯录（TASK-19）、日历邀请与 CalDAV（TASK-20）、POP3（TASK-21）。暂不做：OpenPGP/S/MIME，只在 §2.3 记录差距。 | 用户已定 | 本会话多选答复 | TASK-19、TASK-20、TASK-21 |
| DEC-04 同步状态模型 | A. 持久化连续区间 `[low, high]`，并用集合差补缺。<br>B. 持久化已知 UID 位图。<br>C. 只依赖 CONDSTORE/QRESYNC。 | A。不变量简单，可以直接修复旧缓存里的缺口；B 的存储和维护复杂；C 不是所有服务器都支持（部分企业 Exchange 和国内邮箱不支持）。CONDSTORE 只作为对账加速，见 DEC-05。 | agent 自决 | R1–R4 根因分析；RFC 3501 规定 UID 在同一 UIDVALIDITY 内单调递增 | AC-01–AC-03、AC-11；TASK-01、TASK-02 |
| DEC-05 标志与删除对账 | A. 服务器通告 CONDSTORE 时用 `CHANGEDSINCE`，否则分块 `UID FETCH (FLAGS)`；删除用 `UID SEARCH UID lo:hi` 与缓存求差。<br>B. 直接上 QRESYNC 与 VANISHED。 | A 为基线。QRESYNC 作为 P2 优化（TASK-12）。`imap` 2.4.1 没有原生 CONDSTORE 类型，需要用原始命令并自行解析，TASK-03 先做最小验证。 | agent 自决 | `Cargo.toml:112` `imap = "2.4.1"`；源码中没有 CONDSTORE 处理 | AC-04、AC-05；TASK-03 |
| DEC-06 列表数据源 | A. 前端列表只读本地缓存，服务器调用只负责更新缓存。<br>B. 维持缓存与服务器偏移分页混用。 | A。这样可以消除 R2；在 DEC-02 下缓存本来就是完整索引。 | agent 自决 | `MailClientTab.tsx:2096` 的偏移错位 | AC-07；TASK-04 |
| DEC-07 IMAP 库 | A. 保留同步 `imap` 2.4.1，在 `spawn_blocking` 中运行，扩展能力用原始命令。<br>B. 迁移到 `async-imap`。 | A。迁移会影响连接池、代理转发、OAuth 和重试，风险大。IDLE 在 2.4.1 中有 `Session::idle()` 可用。若 TASK-03 的最小验证证明原始命令不可行，再单独立卡评估 B。 | agent 自决 | `mod.rs:895` 连接池；imap 2.4.1 的 extensions::idle | TASK-03、TASK-12 |
| DEC-08 旧设置迁移 | A. 已保存设置中等于旧默认值的 `headerRetentionDays = 30` 和 `headerLimitPerFolder = 2000` 视为“未改动”，迁移为 0（不限）；非默认值保留。<br>B. 全部保留旧值。 | A。这样符合 DEC-02 的默认意图，又不覆盖用户显式修改过的值。代价：少数有意设为 30/2000 的用户会被放开，可以在设置里改回。 | agent 自决（可逆） | `MainLayout.tsx:559-560` 默认 30/2000，最小值 1 | AC-12；TASK-01、TASK-04 |
| DEC-09 同步测试手段 | A. 纯函数规划器配合脚本化的假 IMAP 流做单元测试，另加由环境变量开启的真实 Dovecot/GreenMail 活体测试。<br>B. 只做活体测试。 | A。缺口场景需要可重复的 UID 布局，单元测试最稳定；活体测试证明与真实服务器互通。 | agent 自决 | 当前没有任何同步算法测试（`mod.rs` tests 从 `:5700` 起） | V-01–V-05 |
| DEC-10 线程视图 UI | Thunderbird 树形线程 vs Gmail 式会话卡片 | 接手 TASK-07 时出原型并提问 | 待用户决策 | 未提出，不影响 P0 | TASK-07（UI 部分） |
| DEC-11 过滤器规则编辑器 UI | 条件/动作表单 vs 类 Sieve 文本 | Thunderbird 式对话框：规则列表 + 编辑对话框，多条件行（字段/运算符/值，全部或任一匹配）、多动作行；邮件右键“从此邮件创建过滤器”预填发件人；收信时执行，也可对文件夹手动执行 | 用户已定 | 2026-09-30 提问答复 | TASK-13 |
| DEC-12 统一收件箱入口 | 独立的“统一邮件”标签 vs 在账户标签内切换 | 独立标签：从邮件菜单或侧边栏打开，按时间合并所有已保存账户的 INBOX/Sent/Drafts/星标，操作经所属账户执行；不影响单账户标签 | 用户已定 | 2026-09-30 提问答复 | TASK-16 |
| DEC-13 CardDAV / vCard 依赖 | 引入 vCard crate vs 自行实现 | 自行实现，不新增依赖：vCard 3/4 与 ICS 行格式相同，复用 calendar.rs 的折行与转义；WebDAV（PROPFIND/REPORT）用现有 reqwest + quick-xml | 用户已定 | 2026-09-30 提问答复 | TASK-19 |
| DEC-14 CalDAV 日历 UI（第二期） | 最小（同步 + 议程）/ 完整日历标签 / 不做 | 最小：CalDAV 账户与同步，接受邀请写入所选日历；邮件标签内提供“议程”列表显示近期事件；不做日/周/月网格；提醒只在标签打开时用桌面通知（DEC-01） | 用户已定 | 2026-09-30 提问答复 | TASK-20 第二期 |
| DEC-15 POP3 实现方式 | 引入 crate vs 自行实现（协议简单） | 自行实现（`mail/pop3.rs`）：协议只需约 10 个命令，TLS 复用 native-tls 与证书固定，APOP 用 md-5 | agent 自决 | TASK-21 实现 | TASK-21 |
### 4.2 P0 同步引擎

#### 不变量

对每个 `(account, folder)`，在 `uid_validity` 不变的前提下，本地 `mail_messages` 恰好包含服务器上 UID 属于 `[sync_low_uid, sync_high_uid]` 的全部现存邮件。有 `sync_complete = 1` 时，区间覆盖到服务器上最小的 UID。

有了这个不变量：
- 新邮件只需查询 `sync_high_uid+1:*`；
- 历史回补只需查询 `1:sync_low_uid-1`；
- 对账只在区间内进行。

`MAX(uid)` 不再作为同步依据。

#### 核心操作：`fill_range(lo, hi)`

适用于新邮件补齐、旧缓存修复和删除对账：

```text
server = UID SEARCH UID lo:hi          // 只返回 UID 数字；hi 可以是 *
server = server.filter(uid >= lo)      // 规避 "n:*" 在 n > 最大 UID 时返回最大 UID 的语义
cached = SELECT uid FROM mail_messages WHERE folder=? AND uid BETWEEN lo AND hi
missing  = server - cached             // 需要拉取邮件头
vanished = cached - server             // 服务器已删除或移走（只在对账模式下删除）
按 UID 降序取 missing 的前 limit 个 → UID FETCH (UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])
remaining = missing.len() - fetched
```

- 可重复执行：中断后再调用，由集合差自动续传（AC-03）。
- 按新到旧拉取：最新邮件最先出现。
- `sync_high_uid` 只有在 `remaining == 0` 时才推进到 `max(server)`。未完成时水位保持不变，下次重新计算集合差。
- 大文件夹的 `UID SEARCH` 结果可能有数万个数字，需要分段查询：每段 10000 个 UID 区间，复用 `imap_page_uids_newest_first` 的窗口思路，避免一次返回超大结果。

#### 模式

| 模式 | 触发 | 范围 | 是否计入新邮件 | 水位更新 |
|---|---|---|---|---|
| `catchup` | 打开会话、quiet poll、手动刷新、全文件夹扫描 | `(sync_high_uid, *]` | 是：新拉到且无 `\Seen` 的邮件计入 `new_unseen`；首次同步不计 | `remaining == 0` 时 `high = max(server)` |
| `repair`（迁移后首次） | `sync_high_uid IS NULL` 且缓存非空（旧版本数据） | `[MIN(cached uid), *]` | 只有 UID 大于旧 `MAX(cached uid)` 的才计入 | 完成后设置 `low = MIN(cached)`、`high = max(server)` |
| `initial` | `sync_high_uid IS NULL` 且缓存为空 | 最新的 `limit` 封 | 否 | `high = max(server)`，`low = min(fetched)` |
| `backfill` | 列表滚动到缓存底部，或后台回补（AC-12） | `[1, sync_low_uid)` 中最大的 `limit` 个 UID | 否 | `low = min(fetched)`；查询结果为空时 `sync_complete = 1` |
| `reconcile` | 每次 catchup 之后对最近窗口执行；全文件夹扫描和手动刷新时对全区间执行 | `[low, high]` | 否 | 删除 `vanished`；刷新 FLAGS（DEC-05） |

`UIDVALIDITY` 变化时（`reset_folder_if_uid_validity_changed`，`mod.rs:4539`），除了现有的删除邮件，还要把 `sync_low_uid`、`sync_high_uid`、`sync_complete`、`highest_modseq` 清空为 NULL 或 0，然后走 `initial`。结果字段 `uidValidityReset = true`（AC-08）。

#### 标志与删除对账（DEC-05）

- FETCH 返回的 FLAGS 是权威值，空列表表示“无标志”，即未读。
  - 修改 `upsert_message`（`mod.rs:4612`）：flags 始终取 `excluded.flags_json`。
  - 过滤掉 `\Recent`。
  - 实现前审计所有 `upsert_message` 调用点，确认每条路径都带有 FETCH FLAGS。若有路径不带 flags（例如正文补写），改为调用不改 flags 的独立 upsert（R5）。
- 服务器通告 `CONDSTORE`（CAPABILITY）时：
  - 用 `EXAMINE folder (CONDSTORE)` 读取 `HIGHESTMODSEQ`，与 `mail_folders.highest_modseq` 比较；
  - 相同则跳过标志对账；
  - 不同则执行 `UID FETCH low:high (FLAGS) (CHANGEDSINCE modseq)`。
- 服务器不支持 CONDSTORE 时：
  - quiet poll 只对缓存中最新的 `FLAG_RECONCILE_WINDOW = 500` 个 UID 分块 `UID FETCH (FLAGS)`；
  - 全文件夹扫描或手动刷新时覆盖全区间，每块 1000 个 UID。
- 删除：用 `UID SEARCH UID low:high` 与缓存求差集，得到 `vanished`，在一个事务内删除。
  - 性能保护：`EXISTS` 与缓存区间计数一致且 `uid_next` 未变时，跳过删除对账。

#### 保留策略（DEC-02、DEC-08）

- `header_retention_days = 0` 或 `header_limit_per_folder = 0` 表示不限，这是新默认值。
- 裁剪只允许从低端进行：先算出新下界 `new_low`，再删除 `uid < new_low` 的行，并令 `sync_low_uid = new_low`、`sync_complete = 0`，保持区间连续。
  - 按数量：保留 UID 最大的 K 封。
  - 按天数：以 `INTERNALDATE`（新增列 `internal_ts`）为准，不再用 `Date:` 头，从而消除 R3。
- `prune_mail_cache` 不再在区间内部挖洞。
- 正文裁剪（`body_recent_limit`）维持现状。

#### 前端编排（`MailClientTab.tsx`）

- 列表：始终由 `mail_list_cached_messages` 分页读取缓存。`loadMoreMessages` 改为：
  - 缓存还有下一页时读下一页；
  - 否则如果文件夹 `syncComplete` 为假，调用 `mail_sync_folder(mode = backfill)` 后再读缓存（DEC-06）；
  - `hasMore = cachedCount > loaded || !syncComplete`。
- 打开会话：
  1. 读缓存（现有逻辑）。
  2. 对选中文件夹循环调用 `catchup`（或 `repair`、`initial`），直到 `remainingNew == 0`；每一步后刷新缓存页并更新进度。
  3. 选中文件夹不是 INBOX 时，对 INBOX 做同样的处理。
  4. `syncComplete` 为假时，启动低优先级的后台 `backfill` 循环（AC-12）。切换文件夹、组件卸载或 `visible = false` 时取消，用序号 ref 使过期结果失效，沿用现有的 `bodyWarmSeqRef` 模式。
- quiet poll：对选中文件夹和 INBOX 执行 `catchup` 并排空，每个 tick 最多 10 步防止长时间占用，剩余留到下一 tick；之后对最近窗口执行 `reconcile`。
- 每第 6 个 tick 和手动刷新：`mail_sync_all_folders`，即对每个文件夹执行 catchup 与全区间 reconcile。
- 新邮件提醒：累计所有 catchup 结果中非特殊文件夹的 `newUnseen`，大于 0 时调用一次 `pushMailNew`（AC-09）。特殊文件夹按现有的 `SpecialFolderKind` 判断（`MailClientTab.tsx:527`）。
- 失败可见：`failedFolders` 写入状态区，并在文件夹树上显示警告图标，`title` 为错误信息（AC-10）。
- 并发：沿用 `syncInFlightRef` 单飞。后台 backfill 在每一步之间检查单飞，给用户触发的同步让路。

### 4.3 接口与共享契约（P0）

| 类型 / 名称（现有或拟新增） | 调用方 → 实现方 | 输入及序列化 | 输出 / 错误 / 事件 | 兼容规则 |
|---|---|---|---|---|
| 拟新增 `mail_sync_folder` | `src/lib/mail.ts` 的 `mailSyncFolder` → `mod.rs` 的 `#[tauri::command]` | `config: MailAccountConfig`、`folder: String`、`mode: "auto" \| "catchup" \| "backfill" \| "reconcile" \| "reconcileFull"`、`limit?: u32`（默认 `sync.max_fetch_per_sync`，上限 2000）、`includeBodies?: bool` | `MailFolderSyncResult`（见下）。`Err(String)` 沿用 `mailClientErrorMessage` 的解析方式。`auto` 在后端按水位状态选择 `initial`、`repair` 或 `catchup`。 | 新增命令，需要在 `lib.rs:873-899` 注册 |
| 修改 `mail_sync_all_folders` | `syncAllFolders` → `mod.rs:1615` | 不变 | `MailSyncAllResult` 新增 `failedFolders: {name, error}[]`、`newUnseenByFolder: Record<string, number>`；保留 `newMessages`，其语义改为“非首次同步的新未读邮件数”。内部对每个文件夹执行 `auto` + `reconcileFull`，每个文件夹一个 `limit` 批次，剩余量在 `folders[].remainingNew` 中返回 | 字段只增不删 |
| 修改 `MailFolder` | 后端 → 前端 `MailFolder`（`src/lib/mail.ts`） | — | 新增可选字段 `syncLowUid`、`syncHighUid`、`syncComplete`、`cachedCount`、`lastError`、`remainingNew` | serde `skip_serializing_if = Option::is_none`，旧前端可忽略 |
| 保留 `mail_sync_headers` | 过渡期内保留 | 不变 | `offset == 0` 时内部改走 `auto` 模式。`offset > 0` 标记为 deprecated，前端不再调用；一个版本后删除 | TC-116（`qa-ui-auto-tests/cases/TC-116-mail-sync-headers-first.testcase.yaml`）需按新流程更新断言 |
| 修改 `mail_list_cached_messages` | `loadCachedMessages` → `mod.rs:1717` | 不变 | 排序维持 `date_ts DESC, uid DESC` | — |

```rust
// 拟新增（mod.rs）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailFolderSyncResult {
    pub account_id: String,
    pub folder: MailFolder,          // 含同步水位字段
    pub mode: String,                // 实际执行的模式：initial / repair / catchup / backfill / reconcile
    pub fetched: usize,
    pub new_unseen: usize,           // 只有 catchup 或 repair 中 UID 大于旧 max 的邮件计入
    pub vanished: usize,
    pub flags_updated: usize,
    pub remaining_new: usize,        // 大于 0 时调用方应继续调用 catchup
    pub sync_complete: bool,
    pub uid_validity_reset: bool,
    pub synced_at: i64,
}
```

### 4.4 存储迁移与故障边界

- 引入 schema 版本：`init_mail_tables`（`mod.rs:1223`）目前只有 `CREATE TABLE IF NOT EXISTS`，没有迁移机制。新增 `migrate_mail_tables(conn)`，以 `PRAGMA user_version` 记录版本。
  - v1 = 现有结构。
  - v2 在 `mail_folders` 上 `ALTER TABLE ADD COLUMN`：`sync_low_uid INTEGER`、`sync_high_uid INTEGER`、`sync_complete INTEGER NOT NULL DEFAULT 0`、`highest_modseq INTEGER`、`last_reconcile_at INTEGER`、`last_error TEXT`。
  - v2 在 `mail_messages` 上新增 `internal_ts INTEGER`。
  - 添加每一列之前先检查 `PRAGMA table_info`，保证迁移可以重复执行。
- 旧数据：迁移本身不删除任何行。新增列为 NULL 时，下次同步自动走 `repair`，修复已有缺口（AC-11）。
- `internal_ts` 为空的旧行，由 `repair` 或 `reconcileFull` 顺带补写，补写前不参与按天数裁剪。
- 回退：旧版本应用读取 v2 数据库时会忽略新列（SQLite 允许），缓存仍可用。
- 回退后再升级：`sync_high_uid` 可能落后，但集合差逻辑能自愈。
- 单次命令的事务边界：一个批次的 upsert、delete 和水位更新放在同一事务中。命令中途失败时，已提交的批次保留，水位只反映已完成的部分（AC-03）。
- 超时：沿用连接池的 NOOP 探活和一次重试。单步命令耗时以批次大小控制，前端循环之间让出事件循环。

### 4.5 三端兼容

P0 只改纯 Rust 同步逻辑、SQLite 和 React，不涉及平台 API 或条件编译。风险点在 TLS 与代理转发，这部分沿用现有 `native-tls` 与 `mail_effective_endpoint`（`mod.rs:3233`）。三端的差异只可能出现在真实服务器的互通性上，与平台无关。P1 以后涉及平台的卡片（系统通知、`mailto:` 协议注册、默认邮件客户端）在各自卡片中单独说明。

## 5. 改动清单（P0）

| 路径 / 模块（标注拟新增） | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src-tauri/src/mail/mod.rs`：`init_mail_tables`，拟新增 `migrate_mail_tables` | 引入 `PRAGMA user_version`，按 §4.4 执行 v2 迁移 | AC-11 | TASK-01 |
| `mod.rs`：`FolderSyncState`、`cached_folder_sync_states`（`:5086`）、`upsert_folder`、`reset_folder_if_uid_validity_changed`（`:4539`） | 状态改为从持久化水位列读取；UIDVALIDITY 重置时同时清空水位 | AC-08、AC-11 | TASK-01 |
| `mod.rs`：`prune_mail_cache`（`:5009`）、`MailCacheSettings` 默认值（`:264`） | 只从低端裁剪并同步 `sync_low_uid`；0 表示不限；按天数改用 `internal_ts` | AC-06、AC-12 | TASK-01 |
| `mod.rs`：`upsert_message`（`:4590`）、`parse_fetch_header`（`:3977`） | FETCH FLAGS 为权威值；写入 `internal_ts`；过滤 `\Recent` | AC-05、AC-06 | TASK-01 |
| `mod.rs`：拟新增 `plan_fill_range`（纯函数）、`imap_fill_range`、`imap_sync_folder_step`、`ActiveImapSession::sync_folder_step`；拟新增命令 `mail_sync_folder`；修改 `mail_sync_all_folders`、`imap_sync_folder_incremental`（被替换）、`mail_sync_headers`（改为转调） | §4.2 各模式；分段 SEARCH；事务内提交 | AC-01–AC-04、AC-07、AC-10、AC-12 | TASK-02 |
| `mod.rs`：拟新增 `imap_capabilities`（缓存在连接池会话上）、`imap_reconcile_flags`、`imap_reconcile_vanished` | CONDSTORE 最小验证与回退；删除对账 | AC-04、AC-05 | TASK-03 |
| `src-tauri/src/lib.rs:873-899` | 注册 `mail_sync_folder` | — | TASK-02 |
| `src/lib/mail.ts` | `mailSyncFolder`、`MailFolderSyncResult` 类型，`MailFolder` 新字段，`MailSyncAllResult.failedFolders` | 全部 | TASK-04 |
| `src/components/mail/MailClientTab.tsx`：open effect（`:1944`）、interval effect（`:1957`）、`quietPollSelectedAndInbox`（`:1597`）、`syncAllFolders`（`:1660`）、`loadMoreMessages`（`:2096`）、`applyQuietPollMessages`（`:625`）、文件夹树渲染 | §4.2 前端编排；进度与失败提示；取消与序号 | AC-01–AC-03、AC-07、AC-09、AC-10、AC-12 | TASK-04 |
| `src/components/session/SessionEditor.tsx:1810-1830`、`src/layouts/MainLayout.tsx:559-560` | 缓存设置允许 0 并显示“不限制”；默认 0；按 DEC-08 迁移旧默认值 | AC-12 | TASK-04 |
| `src/stubs/tauri-core.ts`（邮件 stub 部分） | 为 `mail_sync_folder` 提供可配置 UID 布局的 stub，供 Vitest 和浏览器模式使用 | V-03、V-04 | TASK-04 |
| `src/lib/i18n/locales/{en,zh-CN}` | 补齐进度、回补进度、文件夹同步失败、文件夹已重建等文案 | AC-01、AC-08、AC-10 | TASK-04 |
| 拟新增 `src-tauri/tests/integration/mail_sync.rs`，并在 `main.rs` 中加 `mod` | 活体 IMAP 同步测试，环境变量缺失时跳过并打印原因 | V-05 | TASK-05 |
| `qa-ui-auto-tests/cases/TC-116-mail-sync-headers-first.testcase.yaml`、`feature-list.md` F-MAIL-3 | 更新为 catch-up 流程的断言，并新增“重开补齐”case | V-04 | TASK-05 |

## 6. 实现任务与交接

### 6.1 分期总览

| 阶段 | 任务 | 目标 |
|---|---|---|
| P0 同步可靠性（先做，按顺序） | TASK-01 → TASK-02 → TASK-03 → TASK-04 → TASK-05 | 解决漏收邮件（R1–R8），建立完整邮件头索引 |
| P1 日常收发对齐 | TASK-06 至 TASK-12 | Sent/Drafts 服务器同步、回复线程头与线程视图、搜索、身份与签名、特殊文件夹与删除语义、标签与垃圾邮件、IDLE |
| P2 组织与效率 | TASK-13 至 TASK-18，TASK-22 | 过滤器规则、账户自动配置、附件与大邮件、统一收件箱、发送队列/稍后发送/回执、导入导出与 `mailto:`；列表虚拟化、快捷键与拖拽 |
| P3 扩展（DEC-03） | TASK-19 至 TASK-21 | CardDAV 通讯录、日历邀请与 CalDAV、POP3 |

P1 及以后的卡片彼此基本独立。依赖关系写在各卡片的“依赖”字段里。共享文件 `mod.rs` 和 `MailClientTab.tsx` 体量很大，并行开发时每张卡片应把新逻辑放进新的子模块（例如 `src-tauri/src/mail/sync.rs`、`src/components/mail/MailThreadList.tsx`），减少冲突。TASK-02 首先把同步代码拆到 `src-tauri/src/mail/sync.rs`。

### 6.2 P0 任务

#### TASK-01 同步状态存储、迁移与保留策略

- 职责与文件范围：`src-tauri/src/mail/mod.rs` 中的存储层：`init_mail_tables`、新增 `migrate_mail_tables`、`cached_folder_sync_states`、`upsert_folder`、`upsert_message`、`reset_folder_if_uid_validity_changed`、`prune_mail_cache`、`MailCacheSettings` 默认值、`parse_fetch_header`（`internal_ts`）。
- 输入与必读：本文 §2.2、§4.2 的“不变量”和“保留策略”、§4.4；`mod.rs:1223-1304`、`:4496-4660`、`:5009-5116`。
- 依赖：无。DEC-02、DEC-04、DEC-08 已定。
- 实施内容：
  1. 实现 v2 迁移，可重复执行。当前 `with_mail_db`（`mod.rs:1306`）每次调用都会执行 `init_mail_tables`（`:1313`），迁移必须先读 `PRAGMA user_version`，版本已是最新时立即返回，避免每个 IPC 调用都付出迁移开销。可以考虑把初始化移到 `state.mail_db`（`state.rs:258`）打开连接时执行一次。
  2. `FolderSyncState` 改为 `{ uid_validity, low: Option<u32>, high: Option<u32>, complete: bool, highest_modseq: Option<u64>, cached_min: Option<u32>, cached_max: Option<u32> }`，供 TASK-02 判断 `initial`、`repair` 或 `catchup`。
  3. 新增 `set_folder_sync_watermark(tx, folder, low, high, complete)`。`upsert_folder` 不得覆盖水位列。
  4. `upsert_message`：flags 取权威值（R5），写入 `internal_ts`。审计所有调用点。
  5. `prune_mail_cache` 按 §4.2 重写。`default_header_retention_days` 和 `default_header_limit_per_folder` 改为 0。
  6. UIDVALIDITY 变化时，同时清空水位和 `highest_modseq`。
- 对应验收：AC-05（存储部分）、AC-06、AC-08、AC-11。
- 验证与完成条件：V-01 全部通过；`cargo test --lib mail::` 无回归。
- 并行与集成：TASK-02 依赖本任务的函数签名。可以先提交签名草案，TASK-02 并行编写规划器。

#### TASK-02 区间同步引擎与 `mail_sync_folder` 命令

- 职责与文件范围：新建 `src-tauri/src/mail/sync.rs`，把 `imap_sync_folder*`、`imap_page_uids_newest_first` 和新逻辑迁入；在 `mod.rs` 中新增命令 `mail_sync_folder`，修改 `mail_sync_all_folders` 和 `mail_sync_headers`；在 `lib.rs` 注册。
- 输入与必读：§4.2 的核心操作、模式表和对账部分，§4.3，§4.4 的事务边界；`mod.rs:1505-1704`、`:3420-3610`、`:1070` `with_imap_session`（注意闭包在重试时可能执行两次，必须幂等）。
- 依赖：TASK-01。
- 实施内容：
  1. 纯函数 `plan_fill_range(server_uids, cached_uids, lo, limit) -> FillPlan { fetch_desc, vanished, remaining }`。
  2. 纯函数 `choose_mode(state, mailbox_uid_validity) -> Mode`。
  3. 实现 `initial`、`repair`、`catchup`、`backfill`。`reconcile` 的删除部分可以在本任务完成，标志部分交给 TASK-03。
  4. 分段 `UID SEARCH`（每段 10000 个 UID 区间），并处理 `n:*` 的语义。
  5. `mail_sync_all_folders` 收集 `failedFolders`，不再静默吞掉错误（R8）。
  6. `new_unseen` 按 §4.2 的规则计算（R7）。
  7. `mail_sync_headers` 在 `offset == 0` 时转调 `auto`。
- 对应验收：AC-01–AC-04、AC-07（后端）、AC-08、AC-10、AC-11、AC-12（后端）。
- 验证与完成条件：V-02 全部通过；V-05 在 Dovecot 上通过（记录选中的 case 数和 skip 原因）。
- 并行与集成：与 TASK-03 共享 `sync.rs`。按顺序合并：TASK-02 先合入。

#### TASK-03 标志对账与 CONDSTORE

- 职责与文件范围：`sync.rs` 中的 `imap_capabilities`、`imap_reconcile_flags`。
- 输入与必读：§4.2 的“标志与删除对账”，DEC-05，DEC-07。
- 依赖：TASK-02。
- 实施内容：
  1. 最小验证：在 `imap` 2.4.1 上用 `Session::run_command_and_read_response` 发送 `EXAMINE x (CONDSTORE)` 和 `UID FETCH a:b (FLAGS) (CHANGEDSINCE n)`，手工解析 `HIGHESTMODSEQ` 和带 `MODSEQ` 的 FETCH 响应。在 Dovecot 和 Gmail 上确认可用，结论回填本文 §10。
  2. 不可行时只用回退路径（分块 `UID FETCH (FLAGS)`），不阻塞 P0 交付。
  3. 对账后刷新 `unread` 计数（沿用 `imap_unread_count`）。
- 对应验收：AC-04、AC-05。
- 验证与完成条件：V-02 中的对账用例、V-05 中的标志用例通过。
- 并行与集成：可与 TASK-04 并行，因为前端只依赖 `mail_sync_folder` 的契约。

#### TASK-04 前端同步编排、列表数据源与设置

- 职责与文件范围：`src/lib/mail.ts`；`MailClientTab.tsx` 中列于 §5 的符号；`SessionEditor.tsx` 缓存设置；`MainLayout.tsx` 默认值；stub；i18n。
- 输入与必读：§4.2 的“前端编排”，§4.3，DEC-06，DEC-08；现有测试 `src/components/mail/quietPollMessages.test.ts`、`MailClientTab.test.tsx`。
- 依赖：TASK-02 的契约（可以先按 §4.3 用 stub 开发）。
- 实施内容：
  1. `runCatchupLoop(folder)`：带进度、取消（序号 ref）和单飞让步。
  2. open effect 与 interval effect 改用 catch-up。
  3. `loadMoreMessages` 改为“缓存分页 → backfill”，删除 `offset = messages.length` 的服务器调用。
  4. 后台 backfill 循环（AC-12）。
  5. 新邮件提醒计数（AC-09）。
  6. 文件夹失败标记与状态汇总（AC-10），以及 UIDVALIDITY 重建提示（AC-08）。
  7. 缓存设置支持 0（不限）并迁移旧默认值（DEC-08）。`mailNumberOption` 的最小值改为允许 0。
  8. 更新 `applyQuietPollMessages` 或将其移除，同时迁移相应测试。
- 对应验收：AC-01–AC-03、AC-07、AC-09、AC-10、AC-12（前端部分）。
- 验证与完成条件：V-03、V-04 通过；`pnpm build` 通过。
- 并行与集成：本任务负责 P0 的前后端集成。

#### TASK-05 P0 测试设施、回归与真机验证

- 职责与文件范围：`src-tauri/tests/integration/mail_sync.rs`（拟新增）、`src-tauri/tests/README.md`（补充邮件活体测试前置条件）、`qa-ui-auto-tests` 中邮件相关 case 与 feature-list。
- 输入与必读：§7、§8；`src-tauri/tests/README.md`；`.agents/skills/qa-ui-auto/SKILL.md`。
- 依赖：TASK-02；真机步骤依赖 TASK-04。
- 实施内容：
  1. 活体测试通过环境变量 `TAOMNI_MAIL_TEST_IMAP_HOST`、`_PORT`、`_USER`、`_PASS`、`_SECURITY` 和 `TAOMNI_MAIL_TEST_SMTP_*` 指向隔离的测试邮箱（推荐本地 Dovecot 或 GreenMail 容器）。
  2. 用 IMAP APPEND 直接构造 UID 布局，不依赖 SMTP 投递时序。
  3. 执行 §8 的 Windows 真机步骤，并回填 §9 的证据。
- 对应验收：全部 P0 AC 的证据。
- 验证与完成条件：V-05、V-06、V-07 有实际结果；三端兼容检查记录在案。
- 并行与集成：最终集成责任方。

### 6.3 P1 任务卡（日常收发对齐）

以下卡片已定范围、落点和验收。接手 agent 按本仓库 `feature-design` 流程，把卡片细化为 `docs-feature/mail-<slug>-design.md`，或直接在本节补齐。卡片中出现新的实质取舍（UI 布局、依赖选型）时，应先征询用户。

#### TASK-06 已发送副本与服务器草稿（IMAP APPEND）

- 现状：没有 APPEND。发信后不向 Sent 写副本，完全依赖服务器行为（Gmail、Outlook 会自动保存，多数 IMAP 服务器不会）。草稿只存在本地 `mail_drafts` 表，其中 `remote_draft_folder`/`remote_draft_uid` 两列一直未使用（`mod.rs:1294`）。
- 范围：
  - `build_send_message`（`mod.rs:4235`）生成的 RFC 5322 字节在 SMTP 成功后 APPEND 到 Sent 文件夹，带 `\Seen`。
  - 按服务器类型提供账户设置“保存已发送副本”：Gmail/Outlook 默认关闭，自定义服务器默认开启。
  - 草稿保存时 APPEND 到 Drafts（`\Draft`、`\Seen`），替换时删除旧 UID。本地草稿作为离线缓存保留。
  - 特殊文件夹的定位依赖 TASK-10 的 SPECIAL-USE，落地前沿用前端的名称识别。
- 依赖：TASK-02（APPEND 后通过 catchup 把新 UID 纳入缓存）；TASK-10（可选）。
- 验收：
  - AC-20：自定义 IMAP 账户发信后，Sent 中出现一封内容一致的邮件，其他客户端可见。
  - AC-21：保存草稿后，在其他客户端的 Drafts 中可见；在 Taomni 中重开、编辑、发送后，服务器草稿被删除。
  - AC-22：APPEND 失败不影响“已发送”状态，但提示失败并允许重试。
- 验证：Rust 单元测试（MIME 字节与 APPEND 参数）、活体测试（Dovecot）、真机。

#### TASK-07 回复线程头与会话线程视图

- 现状：
  - `MailSendRequest`（`mod.rs:506`）没有 `In-Reply-To`/`References` 字段，因此回复在收件方和 Thunderbird 中都不会串成会话。
  - 缓存只存 `message_id`，不存 `References`/`In-Reply-To`。
  - 列表没有线程分组。
- 范围：
  - 发送：`MailSendRequest` 增加 `inReplyTo?: String` 和 `references?: String[]`；回复、转发时由前端从 `reply_context_json` 填入。
  - 缓存：`mail_messages` 增加 `in_reply_to`、`references_json`、`thread_id` 列（schema v3）；按 RFC 5256 的 REFERENCES 思路做本地线程计算，并把 Sent 中的回复纳入。
  - UI：列表增加“按会话分组”开关（Thunderbird 的 Threads 视图），支持线程折叠、展开，并显示线程内未读数。
- 依赖：TASK-01（schema 迁移机制）；TASK-02（完整邮件头索引）。
- 验收：
  - AC-23：在 Taomni 中回复一封邮件，Thunderbird 和 Gmail 把它归入原会话。
  - AC-24：开启线程视图后，同一会话的邮件（包括本人在 Sent 中的回复）折叠为一行，展开后按时间排列。
- 待决：线程视图的 UI 形式（Thunderbird 树形 vs Gmail 式卡片）需要原型和用户选择，记为 DEC-10，待用户决策。

#### TASK-08 搜索：服务器搜索 + 本地全文索引

- 现状：只在内存中已加载的 `messages` 上做子串过滤（`MailClientTab.tsx:1139`），只覆盖主题、发件人、摘要和收件人，没有服务器 SEARCH 和正文搜索。
- 范围：
  - 本地：SQLite FTS5 虚表 `mail_messages_fts`（subject、from、to、cc、snippet、body_text），由 upsert 触发器维护，查询范围覆盖整个文件夹或整个账户缓存（依赖 DEC-02 的完整头索引）。
  - 服务器：`UID SEARCH` 支持 `TEXT`/`FROM`/`SUBJECT`/`SINCE`，用于正文未缓存的邮件，结果回补进缓存。
  - Quick Filter 栏：未读、星标、有附件、来自联系人、标签。
- 依赖：TASK-01、TASK-02。需要确认 FTS5 是否已启用，`rusqlite` 的 bundled 特性默认包含 FTS5，实现前核对 `Cargo.toml`。
- 验收：
  - AC-25：在 1 万封邮件的文件夹中按正文关键字搜索，本地已缓存正文的邮件 1 秒内返回（测量目标待 V 基线）。
  - AC-26：正文未缓存时，“在服务器上搜索”能返回结果。
  - AC-27：Quick Filter 的组合条件正确。

#### TASK-09 身份、别名、多签名与模板

- 现状：每个账户只有一个 `display_name`/`reply_to`/`signature`（`MailAccountConfig`，`mod.rs:336`），不能用别名地址发信，也没有模板。
- 范围：
  - 账户下可以有多个身份（名称、地址、Reply-To、签名、默认 Cc/Bcc），写信时选择 From。
  - 回复时自动选中收件地址匹配的身份（Thunderbird 行为）。
  - HTML 签名。
  - 模板：保存为模板，并能从模板新建。
- 依赖：无。与 TASK-06 共享 Drafts/Templates 文件夹的定位。
- 验收：
  - AC-28：用别名身份发信，收件方看到的 From 是该别名。
  - AC-29：回复发往别名的邮件时，默认使用该别名。
  - AC-30：从模板新建时带出主题、正文和附件。

#### TASK-10 服务器能力探测、特殊文件夹、订阅与未读计数

- 现状：
  - 不发 CAPABILITY、NAMESPACE，不读 SPECIAL-USE。LIST 属性以 Debug 字符串形式存储（`mod.rs:3393`）。
  - 特殊文件夹靠名称匹配（`MailClientTab.tsx:527-533`）。
  - 没有 SUBSCRIBE/LSUB，不能隐藏未订阅的文件夹。
  - 未读数对每个文件夹执行 `UID SEARCH UNSEEN`（`:3405`），文件夹多时开销大。
- 范围：
  - 连接后缓存 CAPABILITY，供 TASK-03 和 TASK-12 使用。
  - 用 `LIST (SPECIAL-USE)` 或 LIST 返回的属性识别 `\Sent \Drafts \Trash \Junk \Archive \All \Flagged`，识别不到时回退到名称匹配；账户设置中可以手动指定。
  - 订阅管理对话框。
  - 服务器支持时用 `STATUS (UNSEEN MESSAGES UIDNEXT UIDVALIDITY)` 批量刷新未读数；未选中的文件夹在 `UIDNEXT` 未变时跳过 catchup。
- 依赖：TASK-02。
- 验收：
  - AC-31：中文命名或自定义命名的 Sent/Trash 文件夹能被正确识别。
  - AC-32：取消订阅的文件夹不在树中显示，也不参与同步。
  - AC-33：50 个文件夹的账户，全文件夹扫描的往返次数比基线下降（在 V 中测量）。

#### TASK-11 标签、星标与垃圾邮件

- 现状：
  - 星标使用 `\Flagged`（`MailClientTab.tsx:2795`）。
  - “垃圾邮件”只是移动到 Junk 文件夹（`handleJunkMessages`，`:2856`），不设置 `$Junk`/`$NotJunk` 关键字，也没有识别能力。
  - 没有标签（Thunderbird 的 `$label1`–`$label5` 和自定义关键字）。
- 范围：
  - 标签：本地定义颜色和名称，以 IMAP 关键字写入服务器（按 PERMANENTFLAGS 判断是否支持 `\*`），列表显示色块并可按标签过滤（配合 TASK-08）。
  - 垃圾邮件：移动时同时设置 `$Junk`，取消时设置 `$NotJunk`。首期不做本地贝叶斯识别，只信任服务器的 `$Junk` 和 `X-Spam-*` 头并在列表中标记。本地识别另立卡片，需要用户决策。
- 依赖：TASK-03（标志对账负责把其他客户端改的关键字同步回来）。
- 验收：
  - AC-34：给邮件加标签后，Thunderbird 中显示相同的关键字。
  - AC-35：标记为垃圾邮件后，服务器端该邮件带有 `$Junk`。

#### TASK-12 IDLE 即时收信（仅限标签打开期间）与 QRESYNC

- 现状：只有轮询，默认 5 分钟。
- 范围：
  - 标签可见或打开期间，为 INBOX（以及当前选中文件夹）建立独立的 IDLE 连接。`imap` 2.4.1 提供 `Session::idle()`，需要在独立的阻塞线程中运行，每 29 分钟重发一次。
  - 收到 EXISTS/EXPUNGE/FETCH 后触发一次 catchup 或 reconcile。
  - 服务器不支持 IDLE 或连接失败时回退到轮询。
  - 标签关闭时释放 IDLE 连接（DEC-01：不做后台收信）。
  - 可选：服务器支持 QRESYNC 时，用 VANISHED 代替删除对账。
  - 系统通知：新邮件除了 Tao 提醒外，按账户设置可选发送系统通知，复用 `src/lib/lanNotify.ts` 的权限与发送模式。只在标签打开期间发送（DEC-01）。
- 依赖：TASK-02、TASK-10（CAPABILITY）。
- 验收：
  - AC-36：标签打开时，新邮件在 10 秒内出现在列表中。
  - AC-37：关闭标签后，IDLE 连接在 5 秒内断开（可用 `netstat` 或服务器日志验证）。
  - AC-38：IDLE 断线后自动重连或回退到轮询，不漏邮件（依赖 P0 的 catchup）。
- 三端：纯网络逻辑，无平台差异；需注意各平台休眠唤醒后的 socket 失效，唤醒后依靠 NOOP 探活并重建连接。

### 6.4 P2 任务卡（组织与效率）

#### TASK-13 消息过滤器（规则）

- 范围：
  - 按账户定义规则：条件包括 From、To/Cc、主题、正文、大小、日期、标签、是否有附件；动作包括移动、复制、标记已读或星标、打标签、删除、转发、停止后续规则。
  - 在 catchup 拿到新邮件后执行（“收信时”），也可以对文件夹手动执行。
  - 规则存储在 SQLite 中，并支持导出和导入。
- 依赖：TASK-02（`new_unseen` 的新邮件集合）、TASK-11（标签）。
- 验收：
  - AC-40：来自某发件人的新邮件自动移入指定文件夹。
  - AC-41：手动对文件夹执行规则，结果正确。
  - AC-42：规则执行失败时，邮件留在原处并记录错误。
- 待决：规则编辑器的 UI（DEC-11），需要原型。

#### TASK-14 账户自动配置与连接选项

- 现状：只有 `Custom`、`Gmail`、`Outlook` 三种 provider（`mod.rs:72`）；OAuth 只支持 Gmail 和 Outlook；不能添加证书例外。
- 范围：
  - 输入邮箱地址后自动发现服务器配置，顺序参照 Thunderbird：ISPDB（`autoconfig.thunderbird.net`）→ 域名下的 `autoconfig.<domain>` 与 `/.well-known/autoconfig` → Exchange Autodiscover → RFC 6186 SRV → 常见主机名猜测。
  - 增加更多 OAuth provider（Yahoo、AOL、Fastmail 等，以 ISPDB 中的 OAuth 配置为准）。
  - 自签名证书：首次连接时展示证书指纹，允许为该账户添加例外。需要替换 `native_tls` 的校验回调，三端都要验证。
- 依赖：无。
- 验收：
  - AC-43：输入 Gmail、Outlook、QQ、163 或自建域名邮箱后自动填好服务器配置。
  - AC-44：自签名证书的服务器在确认例外后可以连接，指纹变化时再次提示。
- 安全：自动发现请求会把邮箱域名发给第三方（ISPDB），需要在 UI 中说明，并提供跳过选项。

#### TASK-15 附件与大邮件

- 现状：
  - 正文只拉 `BODY.PEEK[]<0.N>`，N 默认 256 KB，最大 10 MB，大邮件会被截断。
  - 每次下载附件都重新拉取整封邮件（`mail_download_attachment`，`mod.rs:1776`）。
  - `attachment_cache` 设置从未被读取。
  - 发信时不检查 SMTP `SIZE`。
- 范围：
  - 按 `BODYSTRUCTURE` 只拉需要的 MIME 部分（`BODY.PEEK[1.2]`），正文不截断。
  - 附件落盘缓存，按 `attachment_cache` 设置启用。
  - 发信前按 SMTP `SIZE` 提示超限。
  - 附件提醒：正文提到“附件”“attached”却没有附件时提示。
- 依赖：无。
- 验收：
  - AC-45：30 MB 附件的邮件可以完整显示正文并下载附件，内存峰值不超过附件大小的 2 倍（测量）。
  - AC-46：同一附件第二次打开时直接使用缓存。
  - AC-47：超过服务器 SIZE 时，发送前给出提示。

#### TASK-16 统一收件箱与多账户视图

- 现状：每个账户是独立的标签，各自使用独立的数据库（`<app_data>/mail-cache/`），没有跨账户视图。
- 范围：
  - “统一文件夹”：聚合所有已打开或已保存账户的 INBOX、Sent、Drafts 和星标邮件，在各账户数据库上做联合查询，按日期合并。
  - 需要确定统一视图的入口（独立标签还是在某个账户标签内），记为 DEC-12，待用户决策。
- 依赖：TASK-02、TASK-10。
- 验收：AC-48：两个账户的新邮件按时间合并显示在统一收件箱中，操作（已读、移动）作用于正确的账户。

#### TASK-17 发件箱、稍后发送、撤销发送与回执

- 现状：SMTP 同步发送，失败即报错；离线时无法排队；没有稍后发送、撤销发送，也不支持 MDN（`Disposition-Notification-To`）和 DSN。
- 范围：
  - 本地 Outbox 队列，离线或发送失败时入队，恢复后在标签打开期间自动重试（DEC-01：不在后台发送）。
  - 稍后发送（指定时间；标签未打开时顺延到下次打开）。
  - 撤销发送：发送后 N 秒内可撤回，实现为延迟入队。
  - 可选请求已读回执，以及对收到的回执请求做出响应（询问、总是或从不）。
- 依赖：TASK-06（Sent 副本）。
- 验收：
  - AC-49：离线写信点发送后进入 Outbox，联网后自动发出，Sent 有副本。
  - AC-50：撤销窗口内点击撤销，邮件未发出并回到编辑状态。
- 需告知用户的限制：“稍后发送”只在应用运行、标签打开时生效，这是 DEC-01 带来的限制，需在 UI 中说明。

#### TASK-18 导入导出、mailto 与邮件列表

- 范围：
  - 导出：文件夹导出为 mbox，选中邮件导出为 `.eml`（单封已有 `mail_save_raw`）。
  - 导入：从 mbox、`.eml` 或 Thunderbird 配置目录导入到 IMAP 文件夹（通过 APPEND，依赖 TASK-06）。
  - 注册 `mailto:` 协议处理（三端机制不同：Windows 注册表、macOS `LSSetDefaultHandlerForURLScheme`、Linux `.desktop` 的 `MimeType=x-scheme-handler/mailto`），接入 Tauri deep-link 插件，需要核实当前是否已引入。
  - 解析 `List-Unsubscribe` 头（RFC 8058 一键退订），在阅读器中显示“退订”按钮。
- 依赖：TASK-06。
- 验收：
  - AC-51：导出 mbox 后能在 Thunderbird 中导入并看到相同的邮件。
  - AC-52：在系统中点击 `mailto:` 链接时，Taomni 打开写信窗口并填好收件人。
  - AC-53：点击退订后按 RFC 8058 发送 POST。

#### TASK-22 列表效率：虚拟化、键盘快捷键、拖拽到文件夹

- 现状：
  - 列表直接渲染所有已加载的行。
  - 快捷键只有正文缩放（`MailClientTab.tsx:1262`）。
  - 不能把邮件拖到文件夹树上。
- 范围：
  - 消息列表虚拟化：先核对仓库是否已有虚拟列表依赖（其他模块，例如 font picker，已做过“virtualize”，见提交 `e1dcfb45`），优先复用。
  - Thunderbird 风格的快捷键：`J`/`K` 或 `F`/`B` 切换上一封/下一封，`R` 回复，`Shift+R`/`Ctrl+Shift+R` 全部回复，`Ctrl+L` 转发，`Del` 删除，`M` 切换已读，`S` 星标，`A` 归档，`Ctrl+Shift+K` 聚焦搜索。快捷键在输入框和编辑器中不生效，并需要与应用的全局快捷键去重。
  - 把邮件拖到文件夹树时，默认移动，按住 `Ctrl` 为复制。
- 依赖：TASK-04（列表数据源改为缓存）。
- 验收：
  - AC-54：列表加载 3 万行后滚动流畅（测量帧率）。
  - AC-55：在列表焦点下，快捷键执行对应操作，在编辑器内不生效。
  - AC-56：拖拽到文件夹完成移动，按住 Ctrl 时完成复制。

### 6.5 P3 任务卡（DEC-03 纳入的扩展）

#### TASK-19 通讯录与 CardDAV

- 现状：只有收发邮件时自动收集的 `mail_contacts`（计数和自动补全，`mod.rs:1267`），没有可编辑的通讯录、分组、vCard 或 CardDAV。
- 范围：
  - 本地通讯录，支持联系人增删改、分组或邮件列表，vCard 3/4 导入导出。
  - CardDAV：发现（`.well-known/carddav`）、同步（`sync-collection` REPORT，否则回退到 ctag/etag）、双向写回。
  - 写信时的自动补全合并通讯录与收集的联系人。
  - 需要选择 vCard 解析和 WebDAV 客户端依赖，由 agent 核实三端兼容与维护状态后提出候选，记为 DEC-13，待用户决策。
- 依赖：无（与邮件同步独立）。凭据使用 vault，Google 或 Microsoft 通讯录可复用邮件的 OAuth，但需要额外的 scope。
- 验收：
  - AC-60：从 Nextcloud、iCloud 或 Fastmail 的 CardDAV 同步联系人，双向修改一致。
  - AC-61：导入 vCard 后，写信时可以补全这些联系人。

#### TASK-20 日历邀请与 CalDAV

- 现状：`text/calendar` 部分被有意跳过（`mod.rs:5544`），邀请邮件只能当作普通附件处理。
- 范围分为两期：
  - 第一期（iTIP/iMIP 邀请）：
    - 解析 ICS（`METHOD:REQUEST/CANCEL/REPLY`），在阅读器顶部显示邀请卡片（时间、地点、参与者、时区转换）。
    - 接受、暂定或拒绝时，按 RFC 6047 发送 `METHOD:REPLY`，并可导出 `.ics`。
  - 第二期（CalDAV 日历）：
    - 日历账户、事件列表，以及日、周、月视图；
    - 把邀请写入 CalDAV 日历，处理提醒。
    - 第二期是独立的大功能，UI 需要原型，记为 DEC-14，待用户决策。
- 依赖：第一期依赖 TASK-06（回复需要 Sent 副本，可选）。
- 验收：
  - AC-62：Outlook 或 Google 发出的会议邀请显示为卡片，点击接受后组织者收到 ACCEPTED 回复。
  - AC-63：取消的会议显示为已取消。
  - AC-64（第二期）：接受的邀请出现在 CalDAV 日历中。

#### TASK-21 POP3 账户

- 现状：只支持 IMAP（`mod.rs` 中没有 pop3）。
- 范围：
  - POP3 账户（`USER/PASS`、`APOP`，OAuth 使用 XOAUTH2 或 SASL），支持 TLS 和 STLS。
  - 使用 `UIDL` 做去重下载，可选“下载后在服务器上保留 N 天或删除”。
  - 需要新增本地邮箱存储模型：POP3 邮件没有服务器文件夹，本地 Inbox、Sent、Trash 与自建文件夹需要可写存储。建议复用 `mail_messages` 并增加 `source = 'local'` 和本地 UID 分配，原始邮件存为 `.eml` 文件。
  - 发信沿用 SMTP。
  - 需要选择 POP3 客户端依赖或自行实现（协议简单），记为 DEC-15，agent 核实后可以自决。
- 依赖：TASK-01（schema 迁移）。过滤器（TASK-13）对 POP3 同样生效。
- 验收：
  - AC-65：POP3 账户收信，重复收信不产生重复邮件。
  - AC-66：设置“保留 7 天”后，服务器上超过 7 天的邮件被删除。
  - AC-67：本地文件夹可以移动、删除和搜索。

## 7. 自动化测试计划（P0）

| V ID | AC / 用途（目标变化或保留行为） | 层级与文件 / case（标注拟新增） | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-05、AC-06、AC-08、AC-11 / 存储层 | Rust unit，`mod.rs` tests（使用 `Connection::open_in_memory`，参照现有 `:6466` 的写法） | ① 构造 v1 schema 并写入含缺口的行，然后执行迁移；② flags 从 `["\\Seen"]` upsert 为 `[]`；③ 插入 `Date:` 为 400 天前的行后 prune；④ UIDVALIDITY 变化 | ① 迁移可重复执行，行不丢失，水位为 NULL；② flags 为 `[]`；③ 行仍在；④ 行与水位都被清空；按数量裁剪后 `sync_low_uid` 等于保留的最小 UID | `src-tauri/`：`cargo test --lib mail::` | 改前：②③ 在当前代码下会失败（证明 R3、R5）。先写失败用例作为基线 / 待执行 |
| V-02 | AC-01–AC-04、AC-07、AC-08、AC-11、AC-12 / 规划器与模式 | Rust unit，`sync.rs` tests（拟新增）：`plan_fill_range`、`choose_mode` 为纯函数；另加脚本化的 `Read + Write` 假流驱动 `imap::Session`，回放预置的 IMAP 响应 | 服务器 UID 为 {1..500} 加 {800..1000}，缓存为 {1..100, 951..1000}；limit 为 50；逐步执行 | 多步 catchup 后缓存等于服务器集合；`remaining_new` 单调递减到 0；中途丢弃一步（模拟中断）后仍收敛；`n:*` 的边界正确；backfill 最终使 `sync_complete = true`；vanished 被删除；`new_unseen` 不计入 repair 中的缺口邮件 | `src-tauri/`：`cargo test --lib mail::sync::` | 待执行 |
| V-03 | AC-01、AC-02、AC-07、AC-09、AC-10 / 前端编排 | Vitest，`src/components/mail/mailSyncLoop.test.ts`（拟新增，测试抽出的纯编排函数）以及 `MailClientTab.test.tsx` 增补 | mock `mailSyncFolder` 依次返回 `remainingNew` 120→70→20→0；backfill 返回 `syncComplete`；一个文件夹失败 | 循环调用直到 0；进度文案依次更新；`pushMailNew` 只调用一次且计数为 120；切换文件夹后旧循环的结果不写入；列表滚到底时先读缓存后调 backfill；失败文件夹显示警告 | 仓库根：`pnpm test src/components/mail` | 待执行 |
| V-04 | AC-01、AC-07 / 浏览器 UI 回归 | qa-ui-auto：更新 `TC-116-mail-sync-headers-first.testcase.yaml`；拟新增 `TC-xxx-mail-reopen-catchup`（编号实现时去重）；F-MAIL-3 增加 controls，例如 `mail-sync-progress`、`mail-folder-sync-error`（拟新增 testid） | stub 预置“关闭期间新增 120 封”的 UID 布局 | 重开后列表数量与 stub 的服务器数量一致；进度元素出现后消失 | 按 `.agents/skills/qa-ui-auto/SKILL.md` 的 runner；stub 只能证明 UI 编排 | 待执行 |
| V-05 | AC-01–AC-05、AC-08、AC-11 / 真实 IMAP 互通 | Rust integration，`src-tauri/tests/integration/mail_sync.rs`（拟新增，在 `main.rs` 注册 `mod mail_sync;`） | 用 APPEND 向测试邮箱写 200 封，然后同步；再 APPEND 120 封，然后同步；从另一连接删除 3 封、把 1 封改为未读；执行 `UID EXPUNGE`；UIDVALIDITY 重置可在 Dovecot 中删除并重建文件夹来模拟 | 每步之后缓存 UID 集合等于服务器 `UID SEARCH ALL`，flags 一致 | `src-tauri/`：`cargo test --test integration mail_sync -- --nocapture`；需要 `TAOMNI_MAIL_TEST_IMAP_*` 环境变量。缺失时打印 skip 原因，并核对实际执行的用例数 | 待执行 |
| V-06 | AC-12 与性能基线 | 同 V-05，加 `#[ignore]` 性能用例 | 1000 封新邮件 catchup；30000 封首次 backfill | 记录耗时、往返次数、数据库大小，不设阈值 | `cargo test --test integration mail_sync_perf -- --ignored --nocapture` | 待执行，结果回填 §9 |
| V-07 | 保留行为回归 | 现有测试 | — | 发信、草稿、附件、正文渲染、联系人补全、OAuth 相关测试全部通过 | `pnpm test src/components/mail src/lib`；`src-tauri/`：`cargo test --lib mail::` | 改前基线：在 TASK-01 开始前运行一次并记录结果 / 待执行 |

证明范围：V-01 至 V-03 用 mock 或假流，证明算法与编排；V-04 用浏览器 stub，只证明 UI；V-05 和 V-06 证明与真实 IMAP 服务器互通，但不经过 WebView。桌面主流程由 §8 的 V-08 证明。

受影响的消费者：
- `quietPollMessages.test.ts`：`applyQuietPollMessages` 被修改或移除时，迁移其断言。
- TC-116。
- F-MAIL-3 中“正文预热”的行为（`warmRecentBodies`）应保持不变。
- `pushMailNew` 在 Tao 提醒中心的展示。

## 8. 真机验证手册

### 环境与准备

- 测试邮箱，二选一：
  - 本地 Dovecot 或 GreenMail 容器（推荐，便于构造 UIDVALIDITY 变化和大量邮件）；
  - 一个专用的云邮箱测试账号（Gmail 或 Outlook，验证 OAuth 与真实服务器行为）。
  - 凭据只放在环境变量或 vault 中，不写进文档或 case。
- 被测构建：`pnpm tauri dev`（开发）；涉及发布时再用 `pnpm tauri build` 生成的安装包复测。
- 隔离数据：使用独立的 app-data，或在测试前备份 `<app_data>/mail-cache/`，并使用只含测试账户的会话。
- 投递工具：用脚本（APPEND 或 SMTP）批量投递 N 封带序号主题的邮件，例如 `P0-TEST-0001`，便于核对缺失。

### V-08 重开补齐与对账（Windows，本轮执行端）

- 对应验收：AC-01、AC-03、AC-04、AC-05、AC-06、AC-09、AC-11。
- 执行前状态：先用改前版本同步测试账户，关闭标签后投递 120 封，重开，记录缺失的序号，作为改前复现证据，证明 R1。然后升级到改后版本。
- 操作与逐步预期：
  1. 打开会话：显示补齐进度，完成后序号 0001–0120 全部可见（AC-01）。改前版本的缺口在首次同步时被修复（AC-11）。
  2. 关闭标签，再投递 300 封；打开会话，补齐进行中时断开网络，恢复网络后等待同步完成：全部可见，无重复（AC-03）。
  3. 在另一客户端删除 3 封、把 1 封改为未读、给 1 封加星，然后手动刷新：本地一致，未读数与服务器一致（AC-04、AC-05）。
  4. 投递一封 `Date:` 为 400 天前的邮件：可见（AC-06）。
  5. Tao 提醒中心的新邮件计数与投递数一致（AC-09）。
- 证据：
  - 每步的截图；
  - 用脚本执行 `UID SEARCH ALL`，并与 `mail-cache` SQLite 中 `SELECT uid FROM mail_messages WHERE folder='INBOX'` 的差集对比，结果应为空；
  - 应用日志（`tracing`）片段。
  - 产物放在 `qa-ui-auto-report/mail-p0/`。
- 清理：删除测试文件夹或测试邮件，恢复备份的 `mail-cache`。
- 状态：待执行。

### V-09 大文件夹首次同步（Windows）

- 对应验收：AC-12、AC-07、AC-10。
- 步骤：
  1. 准备 30000 封邮件的文件夹，首次打开：最新一页先出现，后台回补进度推进；期间 UI 可以滚动、阅读和切换文件夹。
  2. 关闭标签后重开：回补从断点继续。
  3. 滚到底：数量等于 `EXISTS`。
  4. 让某个文件夹不可访问（在 Dovecot ACL 中移除权限）：其他文件夹正常，该文件夹显示警告。
- 状态：待执行。

### macOS / Linux

在 macOS（WKWebView）和 Linux（WebKitGTK）上按 V-08、V-09 的相同步骤执行，并单独记录结果。P0 没有平台相关代码，重点关注：
- 休眠唤醒后连接池的 NOOP 探活与重连；
- 通过代理或跳板机（`network_settings`）时的补齐。

状态：未验证，留待具备对应设备的环境接续，不阻塞本轮交付。

## 9. 验收追踪与交付条件（P0）

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §4.2 模式与前端编排 | TASK-02、TASK-04 | V-02、V-03、V-04、V-05、V-08（Win） | Rust `mail::sync::`；Vitest `MailClientTab.test.tsx`（AC-01 用例）；TC-MAIL-SYNC-01/02 | 已实现；V-05、V-08/V-09 未执行 |
| AC-02 | §4.2 前端编排 | TASK-04 | V-03 | Vitest 编排用例；TC-116 | 已实现；V-05、V-08/V-09 未执行 |
| AC-03 | §4.2 核心操作、§4.4 | TASK-02、TASK-04 | V-02、V-08 | Rust `mail::sync::`（中断后收敛） | 已实现；V-05、V-08/V-09 未执行 |
| AC-04 | §4.2 对账 | TASK-02、TASK-03 | V-02、V-05、V-08 | Rust `mail::sync::`；TC-MAIL-SYNC-02 | 已实现；V-05、V-08/V-09 未执行 |
| AC-05 | §4.2 对账 | TASK-01、TASK-03 | V-01、V-05、V-08 | Rust `mail::`（flags 覆盖写）；TC-MAIL-SYNC-02 | 已实现；V-05、V-08/V-09 未执行 |
| AC-06 | §4.2 保留策略 | TASK-01 | V-01、V-08 | Rust `mail::`（按 INTERNALDATE 裁剪） | 已实现；V-05、V-08/V-09 未执行 |
| AC-07 | §4.2 前端编排、DEC-06 | TASK-02、TASK-04 | V-02、V-03、V-04、V-09 | Rust `mail::sync::`（backfill）；Vitest（AC-07 用例） | 已实现；V-05、V-08/V-09 未执行 |
| AC-08 | §4.2 模式 | TASK-01、TASK-02 | V-01、V-02、V-05 | Rust `mail::sync::`（UIDVALIDITY 重置） | 已实现；V-05、V-08/V-09 未执行 |
| AC-09 | §4.2 前端编排 | TASK-02、TASK-04 | V-02、V-03、V-08 | Vitest（新邮件提醒计数） | 已实现；V-05、V-08/V-09 未执行 |
| AC-10 | §4.2 前端编排 | TASK-02、TASK-04 | V-03、V-09 | Vitest（AC-10 用例） | 已实现；V-05、V-08/V-09 未执行 |
| AC-11 | §4.4 | TASK-01、TASK-02 | V-01、V-02、V-05、V-08 | Rust `mail::`（v1→v5 迁移） | 已实现；V-05、V-08/V-09 未执行 |
| AC-12 | §4.2 保留策略与前端编排 | TASK-01、TASK-02、TASK-04 | V-02、V-06、V-09 | Rust `mail::sync::`；V-06 未测 | 已实现；V-06 性能基线、V-09 未执行 |

本轮 P0 交付条件：
- V-01 至 V-05、V-07 通过；
- V-05 的实际执行用例数不为 0；
- Windows 上 V-08、V-09 通过；
- 三端代码兼容检查记录在案。

macOS 和 Linux 未执行时标为未验证，不单独阻塞交付。性能基线（V-06）只作记录，不作为门禁。

### 9.1 实现与验证状态（分支 `feat/mail-thunderbird-parity`）

验证层级说明：
- 本机（Windows）只跑单元测试：`src-tauri/` 下 `cargo test --lib mail::`，仓库根 `npx vitest run src/components/mail src/components/session src/lib`。
- 三端 UI 验证在 GitHub Actions `qa-ui-auto-platforms.yml` 上执行，Linux、Windows、macOS × browser、native 共 6 个组合。native 模式连接 `mail_server` fixture 启动的进程内假 IMAP/SMTP/POP3 服务器（`mail_fake_server.py`），证明真实后端与 WebView 链路，但不证明与真实邮件服务商的互通。browser 模式只证明渲染层编排。
- 托管 CI 不运行 `cargo test`，因此 Rust 单元测试（包括证书固定、POP3 协议）只在 Windows 本机执行过；macOS/Linux 上的 native-tls 行为未验证。
- V-05（真实 IMAP 集成测试）、V-06（性能基线）、V-08/V-09（真机手册）均未执行。

| 任务 | 状态 | 自动化证据 | 未完成 / 限制 |
|---|---|---|---|
| TASK-01 至 TASK-05（P0） | 已实现 | Rust `mail::sync::` 与 `mail::`；Vitest；TC-MAIL-SYNC-01/02、TC-114/115/116（CI 三端全绿） | V-05、V-06、V-08、V-09 未执行 |
| TASK-06 Sent 副本与服务器草稿 | 已实现 | Rust（APPEND、草稿替换）；TC-MAIL-SEND-01 | — |
| TASK-07 线程头与会话视图 | 已实现 | Vitest（AC-23/AC-24 用例）；TC-MAIL-THREAD-01 | Thunderbird/Gmail 归并（AC-23）未用真实客户端核对 |
| TASK-08 搜索 | 已实现 | Rust `mail::search::`；Vitest（AC-25/AC-26）；TC-MAIL-SEARCH-01 | AC-25 的 1 秒目标未测量 |
| TASK-09 身份、签名、模板 | 已实现 | Vitest（AC-28/AC-29）；TC-MAIL-TEMPLATE-01 | — |
| TASK-10 特殊文件夹、订阅、STATUS | 已实现 | Rust `mail::folders::`；TC-MAIL-FOLDER-01 | AC-33 往返次数未做基线对比（已实现 CONDSTORE 下 STATUS 未变跳过） |
| TASK-11 标签与垃圾邮件 | 已实现 | Vitest `mailTags.test.ts`；TC-MAIL-TAG-01 | 本地垃圾邮件识别不在范围内 |
| TASK-12 IDLE 与桌面通知 | 已实现 | Rust `mail::idle`（假 IMAP 服务器）；TC-MAIL-IDLE-01（含关闭后 IDLE 连接数为 0） | QRESYNC/VANISHED 未实现（可选项；删除对账沿用 P0 路径） |
| TASK-13 过滤器 | 已实现 | Rust `mail::filters`（条件/动作语义、存储与 UID 水位、服务器 BODY 搜索走假 IMAP）；Vitest `MailFiltersPanel.test.tsx`、`MailClientTab.test.tsx`（AC-40/AC-42）；TC-MAIL-FILTER-01 | 转发以附件形式发出；正文条件只支持包含/不包含（未缓存正文用服务器 SEARCH）；收信过滤只在标签打开期间运行（DEC-01） |
| TASK-14 自动配置与证书例外 | 部分 | Rust `mail::autoconfig`、`mail::certs`（本地 TLS 服务器）；TC-MAIL-AUTOCONF-01 | Exchange Autodiscover、RFC 6186 SRV 未实现；Yahoo/AOL/Fastmail OAuth 需厂商客户端 ID；证书固定仅在 Windows 验证 |
| TASK-15 附件与大邮件 | 已实现 | Rust `mail::parts`（假服务器端到端）；Vitest；TC-MAIL-ATTACH-01 | AC-45 内存峰值未测量 |
| TASK-16 统一收件箱 | 已实现 | Vitest `MailUnifiedTab.test.tsx`（多账户按时间合并、同 UID 跨账户操作路由、单账户失败隔离）；TC-MAIL-UNIFIED-01 | 回复/转发经“Open account”在账户标签内完成；每账户最多合并 200 封；托管用例只有一个假服务器账户，多账户合并仅由 Vitest 覆盖 |
| TASK-17 发件箱、稍后发送、撤销、回执 | 部分 | Vitest（AC-49/AC-50）；TC-MAIL-OUTBOX-01 | 对收到的回执请求自动应答未实现；稍后发送只在标签打开时生效（DEC-01） |
| TASK-18 mbox、mailto、退订 | 部分 | Rust `mail::mbox`（往返）、`mail::lists`（RFC 8058 POST）；TC-MAIL-LIST-01 | AC-52 系统 `mailto:` 注册未实施（需要 deep-link 插件与三端安装注册）；Thunderbird 配置目录导入未实现 |
| TASK-19 通讯录与 CardDAV | 部分 | Rust `mail::vcard`（2.1/3.0/4.0 解析、未建模属性往返保留）、`mail::contacts`（进程内 CardDAV 服务器：发现、上传、拉取、服务器删除、412 冲突以服务器为准、登录失败提示）；Vitest `MailAddressBookPanel.test.tsx`；TC-MAIL-CONTACTS-01（地址簿 → 自动补全，AC-61） | CardDAV 流程只在 Windows 本机测试，未连真实 Nextcloud/iCloud/Fastmail（AC-60 真机未验证）；不走会话代理；Google 需额外 OAuth scope；只同步第一个地址簿；手动 Sync |
| TASK-20 日历邀请与 CalDAV | 已实现（DEC-14 最小方案） | 第一期：Rust `mail::calendar`、Vitest（AC-62/AC-63）、TC-MAIL-INVITE-01。第二期：Rust `mail::caldav`（expand 实例、VALARM、议程时间窗、邀请写入资源）、共用 `mail::webdav` 发现（CardDAV 测试覆盖）；Vitest `MailAgendaPanel.test.tsx`、`mailCalendar.test.ts`、`MailClientTab.test.tsx`（AC-64）；TC-MAIL-AGENDA-01（native 断言假 CalDAV 收到 PARTSTAT=ACCEPTED） | 只读第一个日历；不在应用内新建/编辑事件；提醒只在标签打开时；不走会话代理；未连真实 CalDAV 服务器验证；带 TZID 时间在服务器不支持 expand 时按发件人时区显示 |
| TASK-21 POP3 | 已实现 | Rust `mail::pop3`（假 POP3 服务器，APOP、UIDL 去重、删除策略）；TC-MAIL-POP3-01 | 非 Windows 的 TLS 行为未验证 |
| TASK-22 快捷键、拖拽、列表性能 | 已实现 | Vitest；TC-MAIL-KEYS-01、TC-MAIL-DRAG-01（browser） | 列表使用 `content-visibility` 而非虚拟列表；AC-54 帧率未测量；DRAG-01 只有 browser（native 驱动不支持拖拽） |

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| `imap` 2.4.1 对 CONDSTORE 响应的解析 | `MODSEQ` 响应项可能无法被 `imap-proto` 解析，导致 FETCH 报错 | TASK-03 先做最小验证；失败时只走分块 `FETCH FLAGS` 的回退路径 | TASK-03 的加速部分（不阻塞 P0） | Dovecot 与 Gmail 上的验证结果 |
| 完整邮件头索引的磁盘占用与首次同步耗时 | 10 万封邮件的头约数百 MB（主要是 `to_json`/`cc_json`），首次回补可能需要数分钟 | 回补低优先级、可中断；V-06 测量；设置中保留上限选项 | 不阻塞 | V-06 数据 |
| 大文件夹 `UID SEARCH` 结果很大 | 一次返回数万个 UID | 按 10000 个 UID 区间分段查询 | TASK-02 | V-06 |
| 共享大文件冲突 | `mod.rs` 约 6800 行，`MailClientTab.tsx` 约 7800 行，并行开发冲突多 | TASK-02 先把同步代码拆到 `sync.rs`；各卡片新增子模块 | P1 及以后的卡片应在 TASK-02 合入后开始改后端 | TASK-02 合入 |
| DEC-10 线程视图 UI、DEC-11 规则编辑器 UI、DEC-12 统一收件箱入口、DEC-13 CardDAV 依赖、DEC-14 CalDAV 日历 UI | 需要原型或选型，由用户选择 | 对应卡片接手时先出原型或候选比较，再提问 | TASK-07 的 UI 部分、TASK-13、TASK-16、TASK-19、TASK-20 第二期 | 用户答复 |
| DEC-01 限制了 TASK-17 | 稍后发送和 Outbox 只在标签打开时生效 | 在 UI 中明确说明；如需后台能力，需重新向用户提出 DEC-01 | 不阻塞 | — |

回退：
- 代码回退后，旧版本会忽略 v2 新增列，缓存可以继续使用。
- 数据回退不需要额外操作。若要完全重置，可使用现有的“清除缓存”（`mail_clear_cache`）。
- DEC-08 把设置从旧默认值迁移为 0，代码回退后旧版本会把 0 按其原有逻辑处理：`mailNumberOption` 的最小值为 1，会回落到默认值。需要在 TASK-04 中确认这一回落行为可以接受。

现在可以开始：TASK-01，以及 TASK-02 中的纯函数规划器。TASK-04 可以按 §4.3 的契约先用 stub 开发。P1、P2、P3 的卡片中，与同步无关的部分（TASK-09 身份、TASK-14 自动配置、TASK-19 通讯录、TASK-21 POP3 的存储设计）可以并行启动设计细化；涉及 `sync.rs` 的改动应等 TASK-02 合入后再做。

