# 实现与验证记录

分支：`feat/unified-backup-feishu`。日期：2026-10-11。以下验证在功能提交前完成；尚未发布。

当前交付：原生连接与飞书备份实现、中英文 UI 及 Windows 主流程已验证；未宣称全部验收完成，剩余边界见文末。

已替换旧手填密钥/loopback 草案：Taomni 原生只读复用已有 CLI 应用凭据，无可复用应用时浏览器注册；完整备份 scopes 设备授权后保存自己的 token。没有外部 CLI、Go helper、npm 或管理员密钥输入依赖。连接与目标分离，多个目标可复用已保存连接，密码与三代理仍按目标独立配置。

后台会话持久化安全快照，页面重开按 revision 恢复，取消停止 HTTP/轮询；应用注册结果先保存再授权。跨进程应用初始化/connection 文件锁避免并发注册/刷新；刷新前写入 refreshInFlight，进程中断或结果不确定时阻止重放，明确连接失败不删除凭据。普通文件仅当前下载，网页历史回退后创建新下载任务与缓存世代，保留暂停上传状态。

| 验证 | 实际结果/边界 |
|---|---|
| `pnpm test -- src/components/settings/RemoteBackupPanel.test.tsx src/components/settings/BackupSettingsPanel.test.tsx src/stores/backupStore.test.ts src/lib/i18n/index.test.ts` | 27 项通过：目标代理保存、授权事件/重开/取消、网页回退后的新下载、本地备份回归，以及授权等待/错误/已生成操作反馈随语言切换 |
| `pnpm exec tsc -b` | 通过；隔离 QA 构建另执行生产前端构建 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib backup:: --no-default-features --features voice-capture` | 最新输入 34 项通过：实际 reqwest 设备授权 HTTP、环境代理绕过与错误代理不回退、取消与 Range 续传、Windows DPAPI、AES-GCM fixture、SQLite 恢复，以及系统凭据库初始化/长令牌保存/世代更新/失败保留旧值；日志 native-unit-tests-current.log |
| `TC-BACKUP-CLOUD-001` | Windows 原生 38 步通过，两个目标的独立代理、保存/重开及真实语言菜单切换中英文；报告 qa-ui-auto-report/run-20261011-160909-632974700；已审阅中英文截图。只验证这些断言，不代替云端授权/上传验收 |
| Windows 完整 default-features QA 构建 | 通过，独立标识 com.taomni.app.qa，包含生产前端；日志 native-build-localized.log |
| 原生真实个人账户链路 | 已完成应用凭据读取、完整 scopes 设备授权与系统存储；隔离 SQLite v1/v2/v3 的三次加密上传保持相同 file_token；API 当前下载 SHA-256 与 v3 一致，解密后 provenance 正确。证据 native-personal-v2/state.json 与原生截图；用户在官方网页恢复第一版后，新下载 SHA-256 与首次上传一致；该项已通过 |
| 原生恢复/大文件分片 | 已重启恢复历史归档并核实 SQL 值为 v1、控制配置哈希未变；两次约 25.2 MB 加密归档分片上传保持同 token，当前下载哈希一致并成功解密；日志 native-followup.log 包含 local_restart_restore_passed/large_upload_download_passed；第二实例设备授权未在 240 秒内完成，脚本超时关闭原生会话，跨设备恢复仍未执行，不计为通过 |
| 原 CLI 登录回归 | Taomni 授权后只读执行 CLI drive.files.list（user）；exit 0/code 0，仅输出汇总，不输出文件内容/凭据。不保证所有 CLI 功能或长期令牌刷新均已验证 |
| QA catalog/audit/selected CI plan | 静态 gate 通过，三端计划有效；该 case 只覆盖目标设置与语言切换，不能据静态 gate 宣称全部连接/传输 AC 通过 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 全仓失败，包含未修改的 sockscap-helper 等既有格式差异；本次修改 Rust 文件按 rustfmt 单独格式化与检查 |

恢复回归发现并修复 Windows 回滚副本同步问题：`FlushFileBuffers` 需要可写句柄，改为写入打开副本再 sync_all。现有明文/加密/MFA 恢复测试已通过，并将忽略的 Result 改为 unwrap，使恢复失败能直接暴露真实错误。

原生验证还发现两项系统存储问题并修复：直接使用 keyring_core::Entry 未初始化默认 store，已改用工程已有 keyring v1 wrapper；完整 OAuth JSON 超过 Windows 单条凭据容量，已用不可变有界分块和原子索引发布，仍全部放系统凭据库。旧失败证据保留在 run-20261011-155014-461290800 与 native-personal/，不以失败流程宣称授权完成。

新增 UI 已接入现有 en/zh-CN 字典；主提示、授权阶段、传输阶段、目标设置、代理、反馈及恢复来源说明全部本地化。消息存储词条而非已翻译文本，因此已有授权与保存反馈也随语言切换。后端原始脱敏错误仅放可展开技术详情。用户目标/设备名称不翻译。

日志及官方源码证据在忽略目录 `output/feishu-backup-api-research/`。第三方 MIT 许可随 `resources/licenses/lark-cli-MIT.txt` 打包；仅参考备份所需逻辑。

首轮验证遗留的真实服务边界：无应用真实注册、长期/并发刷新服务端行为、跨设备恢复。企业真实账号按用户要求暂不测试。后续加固已补齐 CLI 来源 Secret 轮换重读和注册恢复入口，详细结果见下文。

首轮发布评估（提交 2923d265）：Windows 个人账户主流程可用于小范围 Beta，尚未达到正式生产发布条件。该轮发现的重试、授权恢复、暂停竞态和缓存治理问题在下方加固记录中跟踪；正式安装包、真实断网/取消/重启续传等服务边界仍不能仅凭自动化子集宣称完成。

## Final implementation update (2026-10-11)

The five production-readiness items are implemented in this branch: persisted transient retries with cancellation, registration recovery and secret rotation handling, bounded request retries with token refresh, history-restore locking, and cache retention with explicit unfinished-task discard. Cloud backup uses the existing local backup schedule; the destination multi-select controls cloud destinations only and does not alter the established local SQLite backup policy.

Cloud source identity is persisted beside the canonical SQLite database path. Multiple Taomni windows on one machine that open the same database share the same device/control directory and a cross-process worker lock. A second process skips automatic dispatch while an owner is active; manual cloud changes report that another window owns the task. After ownership is released, the next scheduler pass rereads the shared journals and rechecks whether the period is due. A different database path receives a separate source identity. Credentials remain in the operating system credential store.

The cloud cache defaults to a 2 GiB limit and seven-day retention for completed artifacts. Failed, cancelled, retry-waiting, and resumable artifacts remain until an explicit discard; local backup retention and its configured backup directory are unchanged.

Added browser/native coverage: `TC-BACKUP-CLOUD-002` covers cancellation, discard, cache cleanup, registration recovery, and bilingual UI; `TC-BACKUP-CLOUD-003` covers loopback HTTP refresh, transient scheduling, encrypted upload/download verification, and revoked authorization. The native fixture is account-free and never claims real Feishu evidence. Windows native and browser evidence is local; Linux, macOS, and enterprise accounts require hosted or manual validation.

Current release position: suitable for a controlled Windows beta after the selected native/browser checks pass. Formal production release still requires the hosted platform matrix, packaging checks, and a real-account smoke test on each supported Feishu deployment. The existing local SQLite backup policy remains production behavior and is covered independently by `TC-BACKUP-001`.

### Current focused evidence

- Rust backup suite: 47 passed (`reliability-rust-v9.log`), including real subprocess lock exclusion/crash release and canonical database path identity.
- Windows native: `TC-BACKUP-CLOUD-001/002/003` all passed, zero skips; report `qa-ui-auto-report/backup-reliability-native/run-20261011-172835-238106700`. The retry case waited 116 seconds for the background scheduler and completed without a manual retry.
- Browser recovery controls: 34 steps passed; bilingual recovery and authorization-error screenshots reviewed. TypeScript build and focused component tests passed.
- QA catalog gate passed; CI selector unit tests: 17 passed.
- Hosted run uses only the selected cloud cases. The separate local-policy regression covers automatic scheduling with an empty cloud/manual destination selection; real-account tests remain outside GitHub.

- Local-policy regression: Windows native `TC-BACKUP-001` passed with an empty destination selection, including daily/weekly persistence, no duplicate before the next period, two-copy rotation, manual backup, and disabled-policy suppression. Report: `qa-ui-auto-report/backup-reliability-native/run-20261011-174751-848592900`.

### Readable cloud folders and source labels

The accepted layout is `taomni-backups-v1/<device name> [<full device UUID>]/<destination name> [<full target UUID>]/current.taobak`. New sources default to the system computer name; existing configured names are preserved. Names are public in the user's cloud drive, as disclosed in the bilingual UI. The next upload renames the existing folders in place, including legacy UUID-only folders, preserving folder and file tokens. Paused destinations remain paused. Stable IDs, not display labels, determine source ownership. Duplicate folder identities fail explicitly.

Restore rows and device filters now show readable device names and short identity suffixes, plus the destination name. Existing UUID-only branches remain discoverable. The nonstandard SQLite filename control layout also retains the exact managed cache root name, so the same quota applies to every database source.

- Rust backup suite: 48 passed (`naming-rust-v2.log`), including default-name persistence, canonical source isolation, and legacy/readable folder identity parsing.
- Browser `TC-BACKUP-CLOUD-002/005`: passed, zero skips; `qa-ui-auto-report/browser/run-20261011-180826-327944900`. Device-filter screenshot reviewed.
- `TC-BACKUP-CLOUD-004` adds native legacy migration and repeated rename/upload checks against the loopback API fixture. Live Feishu testing remains separate from this deterministic case.

- Windows native `TC-BACKUP-CLOUD-003/004` passed (`run-20261011-181315-282091400`), including the actual background retry and two uploads retaining the same token after migration/rename. Following the credential-thread fix, `TC-BACKUP-CLOUD-001/004` passed (`run-20261011-182053-655463500`).
- Real personal Feishu naming test passed (`native-personal-v2/naming-smoke.json`): two sequential name changes and encrypted uploads retained the original file token; fresh downloads matched each upload SHA-256 and decrypted provenance. The isolated test destination is paused again. This confirms real PATCH permissions with the already requested scopes; it is not an enterprise-account test.

### Hosted Linux failure and correction

Run `38129523449` at `4ab83b84` produced real passing native results on Windows and macOS (three cases each). Linux's three native cases failed: the Secret Service backend attempted to start its blocking Tokio runtime inside an async worker and subsequently poisoned its mutex. A green per-platform supervisor job meant only that a report was produced, not that its cases passed.

Backup credential transactions now run on a plain scoped thread when called from a Tokio context. A focused regression reproducing the nested-runtime boundary and the Windows system-store roundtrip both pass (`store-rust.log`). The hosted credential fixture now also applies to the settings-only case, ensuring an unlocked disposable Linux Secret Service before the first save. Selected workflow runs additionally require the aggregated `passed` flag, while other workflow scopes preserve their report-oriented contract. Linux rerun results must be checked before treating this correction as platform acceptance.
