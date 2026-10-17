# 邮件存储文件夹名称与批量删除可用性修复

## 现象与原因

手工测试基于完整邮件存储版本，原始基线为 `19919e29`。

1. 存储设置把缓存的 `MailFolder` 映射为 `name`，丢弃 `displayName`，直接展示 IMAP modified UTF-7 标识；邮箱树原有的解码逻辑没有复用。切换账号时，旧候选还可能在新查询失败后残留。
2. 工具栏的 Delete selected 比右键菜单及 Delete 快捷键多一个全局 `markingRead` 禁用条件。因此大文件夹 All read/Selected read 未完成时，选中计数非零但删除按钮不可用。文件夹已读完成还会无条件清空后续选择。

## 修改与保留契约

- 将已有文件夹标签解码提为共享 helper，优先使用服务端缓存 displayName；缺失或仍等于 wire name 时解码回退。设置复选框显示名称，持久化和策略匹配仍使用精确服务器键，避免中文显示破坏 include/exclude 匹配。手工输入继续使用精确服务器名；勾选时过滤空行。
- 候选查询只读取当前账号本地缓存，设置页不偷偷连接邮箱。首次连接且未同步时无候选，提示连接同步或手工填写。曾同步的账号离线仍可选择缓存文件夹；当前选择即使暂不在缓存中也保留。账号切换、POP3 切换及迟到回复都隔离。
- 删除按钮保留空选择与其他删除/修改操作的 busy 防重入，仅移除不必要的已读互斥条件。IMAP 交互仍由后端账号连接锁串行，文件夹已读以 250 UID 批次释放锁，删除可在批次之间执行。未增加危险的并行连接写入。
- 文件夹已读完成不再清空用户当前选择；删除仍只移除成功批次对应的选择，失败保留待重试邮件。Trash、永久删除确认和取消保持原有行为。

- 增补并发回归确认：已读操作发出的旧缓存快照可能在删除完成后晚到并恢复已删行。按文件夹记录成功移除版本，丢弃移除之前启动的旧查询；不丢弃其他文件夹的新查询。

## 回归与边界

- 新增五个初始定向回归在原始源码上全部失败；修复后 MailClientTab、MailStorageSettings、mailFolders 连同 SessionEditor 共 125 项通过。另记录并修复 UI 用例暴露的空行问题。
- 扩展 `TC-MAIL-STORAGE-01/02`：连接前无候选、缓存中文文件夹、原始键保存/重开、include/exclude 切换。browser 证明渲染，native 证明真实 IMAP LIST 解码与会话配置持久化。
- 扩展 `TC-MAIL-BULK-01`：一次受控 20 秒已读响应，断言已读仍 busy 时 Delete 已启用，真实点击后核对原有/新增邮件计数、Trash 及未读状态。该延迟是夹具故障注入，不是放宽性能预算。原有取消永久删除与确认清理断言全部保留。
- Linux browser 两个受影响用例通过，原始报告保留于 `qa-ui-auto-report/mail-ui-fix/browser/`。第一个运行暴露的空行失败也保留，未覆盖。
- GitHub 三端 browser/native 全邮件及备份相关验证已完成，最终结果见下文。未将旧版本的 192/192 当作本次证据。

全部执行只使用 browser 隔离上下文与独立 QA profile `com.taomni.app.qa`，不改个人运行进程、配置、邮件目录或 SQLite。

## 三端 CI 发现的备份策略竞争

`39024887673` 的三端 browser 为 99/99，Linux native 中邮件用例通过，但 `TC-BACKUP-001` 第 14 步每日策略落盘断言失败。此前选择 weekly 的磁盘断言已通过，而两个下拉操作只间隔约 3ms；不能据 job success 忽略该失败。

`backupStore.updatePolicy` 直到异步写入和回读完成才更新受控输入，多个更新也未串行，历史刷新还会覆盖编辑中的策略。新增两项定向回归均在修复前失败。改为即时显示最新编辑、串行保存、只采纳最后一次编辑的回读，历史刷新等当前写入完成并丢弃编辑之前的快照；失败恢复磁盘策略，后续保存仍可继续。增加失败/恢复回归，且 `TC-BACKUP-001` 保留原有全部磁盘和定时备份断言，额外检查选择值立即显示。没有延长等待或放宽通过条件。

## 最终验证与交付

分支 `fix/mail-folder-labels-bulk-delete`，产品、用例及 runner 最终提交 `b0c2ed022be220dda3e23fbebf32231aa8ee2e65`。本节为其后的纯文档更新，不修改已验证输入。

| 提交 | 内容 |
| --- | --- |
| `76e3e4e6` | 共享文件夹名称解码、账号候选隔离、已读期间允许删除与保留选择；同步 browser/native 用例及延迟夹具 |
| `d8d1b94c` | 按文件夹移除版本拒绝删除成功前发出的迟到缓存快照，防止已删行重现 |
| `b0c2ed02` | 备份策略即时显示、串行保存和旧结果隔离，增加快速编辑及失败恢复回归 |

本地聚焦 Vitest 合计 **147 passed**：MailClientTab、MailStorageSettings、mailFolders、SessionEditor 共 125 项；backupStore 和 BackupSettingsPanel 共 22 项。Node 22 / pnpm 10 的 `pnpm build`、QA `audit --gate`、受影响用例 CI 计划、开发用例契约和 `git diff --check` 通过。本次没有 Rust 产品改动。初始邮件回归、迟到快照和备份竞争的失败日志均保留，未用后续通过覆盖。

最终 GitHub 运行：[39026477367](https://github.com/engcapa/taomni/actions/runs/39026477367)，工作流 `.github/workflows/qa-ui-auto-platforms.yml`。选择全部邮件、备份及受影响 MFA 用例，共 41 个精确 ID；按各用例声明模式组合为 192 次执行。工作流与聚合 job 均为 success，`passed=true`、`report_ok=true`。

| 平台 | Browser | Native | 失败 / 跳过 |
| --- | --- | --- | --- |
| Linux | 33/33 | 31/31 | 0 / 0 |
| Windows | 33/33 | 31/31 | 0 / 0 |
| macOS | 33/33 | 31/31 | 0 / 0 |

总计 **192 passed / 0 failed / 0 skipped**，0 能力缺口、0 未评审用例、0 基础设施错误。15 份原始 summary 均匹配 receipt、exitCode=0、identity_stable=true、dry_run=false；选择集与实际执行 ID 一致。同一平台四个原生分片使用相同二进制，三个平台源码及 runner 指纹一致。原生应用身份均为 `com.taomni.app.qa`，配置、数据与缓存位于 runner 的隔离 QA 报告目录，未修改个人运行实例或 SQLite。

复核截图和即时断言：Linux/Windows 原生及 browser 的存储候选显示“台北”，精确服务器键保持 `&U,BTFw-`；macOS 原生存储截图未滚到该区域，因此不将该图当作中文候选的视觉证明，功能结果由相同用例中的标签、原始键与重新打开后的断言证明。三端原生均在已读仍 busy 时通过 Delete enabled 断言、真实点击及独立服务器 Trash=3、INBOX=30 校验；不单凭截图按钮颜色认定启用状态。三端 `TC-MAIL-SEND-01` 与 `TC-BACKUP-001` 全部通过，包括 Sent 副本提示、默认目录完整归档、快速切换备份周期与真实磁盘结果。

原生性能 p95（毫秒，每项 5 个原始样本，含自动化开销）：

| 平台 | 读信账号 1 | 读信账号 2 | 发送 | 空闲 PTY | 负载 PTY | 另一实例 PTY |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Linux | 675.18 | 546.08 | 363.90 | 326.78 | 404.20 | 427.98 |
| Windows | 500.00 | 656.00 | 234.00 | 359.00 | 437.00 | 281.00 |
| macOS | 716.98 | 519.18 | 250.98 | 282.02 | 402.97 | 280.98 |
| 固定预算 | 2,500 | 2,500 | 3,000 | 1,500 | 1,500 | 1,500 |

三端大量邮件场景均验证 33,913 封索引、313 封较大正文及两个邮箱账号，最多 4 个并行 FETCH、6 个服务连接及 6 个服务工作线程，五次发送恰好接收五封。双实例均保存 262,144 字节一致前缀、跨进程暂停并恢复，恢复后的真实 FETCH 与终端采样重叠且有进展；迁移前后均保留 3 个原件，清理及再次扫描后原件为 0，摘要仍为 INBOX=3、Archive=2。没有降低性能预算，亦不以这些本地模拟服务绝对时间声称公网延迟或相对加速倍数。实际备份 apply/restart 后的离线读取仍由前序 Rust 恢复测试支持，本轮 native UI 仅验证至恢复检查页面。

证据目录 `qa-ui-auto-report/mail-hosted/run-39026477367/`，聚合 `aggregate/ci-summary.json`，复核 `review-39026477367.log/json`；GitHub artifact 后缀 `fba14bc5917c476b8057b1522b0ed6c3`。源指纹 `b5ce27bd31a628318452ec1e281f09d03eaafcd80d02c73218f4cea1973d48f3`，runner 指纹 `975aacda422777a92d8032e396c43323a19dbce377a75197abc0a4b83e32318b`。二进制 SHA-256：

- Linux：`bb5173f9a0f2e5ae5695a6ca3796a8211ad8d0cf536aaf21a6524f6360e0757d`
- Windows：`ec39454ae4030294132eab9e80a940e4fc33539662cebd157ed2196a14ce9e6c`
- macOS：`c579676a778cf2a01e1945bc73285723176624c2bda68601561d7037545154d9`

前序同步响应性、批量动作及完整存储的实现依据分别见 [响应性修复](mail-sync-responsiveness-fix.md)、[文件夹动作与存储分析](mail-folder-actions-and-storage.md) 和 [完整存储设计](../docs-feature/mail-complete-storage-design.md)；本轮完整回归同时覆盖这些既有行为。
