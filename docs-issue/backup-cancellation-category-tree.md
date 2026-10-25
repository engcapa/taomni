# 备份取消与分类树

## 问题与交付范围

旧实现只在快照前后检查云任务取消，邮件原件复制、SQLite 快照、ZIP、加密与验证期间无法及时停止。本地自动/手工备份没有独立可观察的任务所有者。core/full 与额外邮件开关同时存在，也让实际范围难以判断。

改为全局、本地目标和云端目标共用分类勾选树。邮件分为列表/设置/缓存、完整原件、已下载附件；子项需要邮件数据库。MFA 继续依赖保险库。服务端证书与密钥也显式列出。手工执行冻结全局分类；自动执行保留目标的继承/覆盖语义。

## 升级与格式

- 不在读取时重写旧配置。core/full 按旧逻辑展开，包括邮件显式排除、LAN chat、证书和 MFA 默认值；旧 full 不隐式加入本地历史。
- 第一次分类编辑保存为现有 custom 范围和完整的布尔选项。旧 custom 的 includeMail=true 且缺少子项时，两种邮件子项默认为 true；父项为 false 时两者均排除。
- 新选项是可选字段，旧 custom 不自动加入证书；旧 core/full 保留证书。目标旧覆盖不会自动转为继承。
- 保留 IPC 名称、scope 字段、备份清单格式和 V1/V2 读取兼容。旧任务缺少 cancelRequested/localPath 时正常加载。

## 所有权与边界

- `snapshot_context.rs` 拥有取消信号、分块读/复制/哈希、可取消锁等待、SQLite progress handler 和节流进度。数据库操作结束时移除 handler。
- `archive_writer.rs` 拥有 ZIP/加密和原子发布；临时输出独立，发布前取消不会覆盖已有备份。
- `mail_snapshot.rs` 拥有账户快照与分类筛选。备份通过 `lock_for_snapshot` 读取已有数据库，不触发会扫描原件的索引升级；正常邮箱访问仍执行延后的初始化。排除原件时只删除暂存数据库里的原件记录，已有相关索引由原有触发器清理；生产邮箱不变。
- `local_jobs.rs` 拥有本地导出和自动任务，复用持久任务日志；密码只存运行期。取消后不会按云任务重试，本地重试通过新建备份重新选择目标/密码。
- `job_lifecycle.rs` 拥有完成/失败/取消和启动恢复转换。取消请求持久化后，重启转为 cancelled，不重新执行。其他任务和未来计划仍可运行。
- `jobs.rs` 保留云目标调度和任务注册；活动任务状态可直接访问，控制目录启动时缓存，取消不等待正在快照的配置数据库锁。

归档原子发布或服务端提交是完成边界；在提交后到达的取消可能得到 completed。已完成归档不会被错误报告为已撤回。取消中的视图关闭不会改变后台所有权，重新打开从日志恢复。

## 验证与执行限制

本地仅运行单元测试及静态类型/边界/用例校验，不启动 browser/native。GitHub 的 `qa-ui-auto-platforms.yml` 执行 browser/native，GitHub 操作通过指定代理并复用 Git for Windows 凭据。

| 断言 | 单元测试 | GitHub 用例 |
| --- | --- | --- |
| 旧 core/full/custom 的范围与邮件排除 | backupSettings、BackupRangeEditor、Rust range | TC-BACKUP-SETTINGS-001/002 |
| 子项混合状态、依赖、目标独立、保存失败/重开 | 面板、settings store | TC-BACKUP-SETTINGS-001/003/004 |
| 取消按钮即时反馈、恢复与失败重试 | RemoteBackupPanel、remoteBackupStub | TC-BACKUP-CANCEL-001 |
| SQLite、复制、压缩、加密、锁、校验取消 | Rust snapshot_tests | TC-BACKUP-CANCEL-002 使用真实系统锁与任务日志 |
| 邮件分类对应真实文件、原件内容与索引 | Rust snapshot_tests | TC-BACKUP-MAIL-001 使用独立 ZIP/SQLite 字节检查 |
| 重启恢复取消请求、不重放、后续备份 | Rust job_lifecycle | TC-BACKUP-CANCEL-002 |
| 旧归档与自动本地备份、云恢复操作保留 | 现有 Rust 兼容/调度测试 | TC-BACKUP-COMPAT-001、TC-BACKUP-001、TC-BACKUP-CLOUD-002/003/004 |

浏览器模型只验证渲染与交互；原生场景使用运行目录下的隔离配置、测试凭据和 loopback 服务。系统锁、归档内容、恢复日志不会用 browser stub 代替。执行结果和 workflow 链接在验证完成后补充。
