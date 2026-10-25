# 备份取消与分类树

## 问题与交付范围

旧实现只在快照前后检查云任务取消，邮件原件复制、SQLite 快照、ZIP、加密与验证期间无法及时停止。本地自动/手工备份没有独立可观察的任务所有者。备份打开邮箱数据库还可能触发原件索引升级，额外扫描全部原件。core/full 与额外邮件开关同时存在，也让实际范围难以判断。

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

浏览器模型只验证渲染与交互；原生场景使用运行目录下的隔离配置、测试凭据和 loopback 服务。系统锁、归档内容、恢复日志不会用 browser stub 代替。

## 本地验证记录

产品改动提交 `ba8e8c8eae6401cbc01242587ac2682df9707c99`：

- Rust：`cargo test --offline --manifest-path src-tauri/Cargo.toml --lib --release -- backup:: mail::coordination:: mfa::tests::`，89 通过、0 失败、0 忽略。
- 前端：`pnpm exec vitest run` 定向执行 BackupRangeEditor、backupSettings、BackupSettingsPanel、RemoteBackupPanel、backupSettingsStore、backupStore、remoteBackupStub 七个测试文件，46 通过。
- 测试夹具：`python -m unittest test_backup_cloud`，5 通过。
- `tsc -b --pretty false`、`pnpm check:refactor`、`git diff --check`、QA `audit --gate`、CI selected 规划和 development case contract 均通过；Rust 已格式化。
- 本地未执行 browser/native，用例执行与 QA 应用构建均在 GitHub 完成。

`c97878d6` 仅修正原生邮件用例的操作：混合父项通过“先全选、再清空”排除所有邮件，保留实际归档断言。该版本的用例已通过静态 selected 规划，原始执行与补跑结果在下面分别记录。

## GitHub 执行记录

2026-10-25，`qa-ui-auto-platforms.yml` [首轮执行 40177824693](https://github.com/engcapa/taomni/actions/runs/40177824693)，选择三平台、browser/native、单分片、17 个显式 case ID，`publish_issues=false`。实际选择每平台 8 条 browser、10 条 native；CLOUD-002 在两种模式执行。

browser 三平台均为 8 通过、0 失败、0 跳过。已核对全部执行回执签名及附件哈希，`dry_run=false`、`identity_stable=true`，源码和 runner 指纹与当前工作区一致：

- source SHA-256：`8a092cb40c890b309d2b331a45200c3033d74e19fae331819ec82edf957f7f2f`
- runner SHA-256：`5ded272fe2cb7f2551c016849d75d84847085e9ce61b5a8342bc7cc74f69d458`

已查看 SETTINGS-004 的英文浅色/中文深色与不同宽度截图，以及 CANCEL-001 的已取消任务截图，分类子项、依赖提示、任务状态和后续操作清晰可读。

首轮 Linux native 为 9 通过、1 失败、0 跳过。CANCEL-002 的真实系统锁与独立观察日志确认本地/上传任务均为 `requested=true:artifact=false`，已持久化的启动取消未重放，释放锁后的新备份产生有效归档，恢复预览正常。已查看其原生截图。

唯一失败为 MAIL-001 第 31 步，原始用例对混合父项直接执行 `set_check(false)` 未产生点击，因此第四份归档仍包含缓存和附件。前三份归档的数据库/原件/附件/原件引用行数分别为 `1/0/0/0`、`1/1/0/1`、`1/0/1/0`，与选择完全一致。保留首轮失败证据；修正版补跑完整验证全部五种组合。

首轮 macOS native 为 8 通过、2 失败、0 跳过。MAIL-001 同上；CANCEL-002 在本地取消成功后的第 21 步等待英文 `Saved`，实际界面为中文 `已保存`，尚未继续执行其云任务部分。`80c809d6` 为这两条用例增加真实设置界面的英文选择及 `html.lang=en` 断言，消除对前一条用例语言状态的依赖，保持所有取消与归档断言。

首轮 Windows native 为 9 通过、1 失败、0 跳过，唯一失败同样是 MAIL-001 的混合父项操作。首轮 aggregate 无基础设施错误，因四次用例失败而按 selected gate 正确标为失败。

[补跑 40180352254](https://github.com/engcapa/taomni/actions/runs/40180352254) 使用 `80c809d677cb2e731c4e2bcc444c0d5bc6f22c3b`，选择三平台 native 的 CANCEL-002、MAIL-001，产品与 runner 指纹不变。三平台均 2/2 通过；workflow 为 success，aggregate 的 `passed=true`、`report_ok=true`，无失败、跳过、基础设施错误或能力缺口。两条修正版用例的 CI selected 规划和完整 QA `audit --gate` 均通过。

按当前 source/runner/case 指纹及各组合的最新执行合并，当前选定范围如下；原始版本的六条旧 case 记录保留为被替代证据，不覆盖当前结果：

| 平台 | browser | native | 失败 / 跳过 / 缺失 |
| --- | --- | --- | --- |
| Linux | 8/8 | 10/10 | 0 / 0 / 0 |
| Windows | 8/8 | 10/10 | 0 / 0 / 0 |
| macOS | 8/8 | 10/10 | 0 / 0 / 0 |

共 54 次当前有效执行。已校验 9 份回执签名与 521 个附件哈希，并逐条比较当前 YAML 指纹；所有报告均为实际执行、输入稳定。两轮每个平台的 QA 应用二进制哈希相同，复用了经过验证的构建：

- Linux x64 debug：`09e541c26ff85a5c93b02941c0f695f80a07ea3cf061eedb9e464da8152412c9`。Ubuntu 22.04 构建，在 Ubuntu 24.04 Xvfb/Openbox/WebKitGTK 执行。
- Windows x64 debug：`9e27b0f7f0df6a9707e63d65089fd8a64d1158e380b2b9d4d326012b84ea6971`。Windows 2025 / WebView2。
- macOS ARM64 debug：`e8fd40324111e4a3a54c0321b095feb0e6cb4c0e60b44c6ebb25ebab79073b23`。macOS 15 / WKWebView 原生 bridge。

三平台均使用 `com.taomni.app.qa` 与隔离目录。补跑的独立观察日志均确认取消意图持久化、取消后无发布归档、后续备份有效。邮件五种组合的数据库/原件/附件/原件引用行数依次为 `1/0/0/0`、`1/1/0/1`、`1/0/1/0`、`0/0/0/0`、`1/1/1/1`，原件解压字节与附件字节均匹配夹具，已有索引表另做一致性检查。已查看 Linux/Windows 原生取消截图与 macOS 原生邮件截图。

原始产物保留在 `qa-ui-auto-report/github/backup-40177824693/` 和 `qa-ui-auto-report/github/backup-40180352254/`；以上链接提供 GitHub 原始报告。最终提交前再次执行 `pnpm check:refactor`：768 个命令、328 个 facade exports、39 个事件契约、依赖边界及 3940 个文件大小检查均通过。
