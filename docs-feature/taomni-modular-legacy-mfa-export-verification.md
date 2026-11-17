# 旧版 MFA 一致导出 owner 与验证

本批推进 TASK-012 / AC-017 / V-012 的加密数据导出边界。`plugin_migration_execute` 仍只记录安全 pending；未连接可信安装/激活事务，也不把本批作为完整旧单体升级验收。

## 实现边界

生产实现位于 `src-tauri/src/plugin/migration_export/`，与只读预检共用 `migration_source.rs` / `migration_paths.rs`。`PreparedMfaExport::prepare` 只接受核心持有的 `ProfileRoot`、原预检和独立生命周期的 `SnapshotControl`，自己获取同一 profile 的全部维护锁，不接受 renderer 源/目标路径或外部传来的不明 lease。

维护期间依次持有旧 `.mobile-mode.lock` 的排他 `LegacyUpgradeLease`、新版 `ProfileRestoreLease`、state、Vault 写屏障和 MFA 数据 writer lease。旧版桌面只知道模式锁，单独拿新版 profile 锁不足以保护升级；当前 GUI/headless 和存活宿主则由新版 profile/data/key 锁保护。因此该 API 要在 store 打开前或完整关闭后使用，不能从持有自身 shared lease 的运行中 IPC 直接调用。

MFA 与 Vault 的主文件和非空 WAL 均绑定原预检指纹；开始、SQLite snapshot 后和交付前复核。固定 key 仅查询存在性，不解锁 Vault、读取/导出值或生成替代 key。源的缺失与读取失败明确区分；key-only 输入只生成元数据，不创建 `mfa.db` 或把迁移标记 committed。源散列每 64 KiB 检查取消/deadline。

`taomni-sqlite-snapshot::snapshot_existing` 生成独立 SQLite 快照，包含已提交 WAL，保留原 schema、密文、nonce、key_check、counter、metadata 和偏好；不调用 engine 的 `open_db/init_db` 改旧库。固定源/sidecar 和 staging 父目录拒绝 symlink/Windows reparse，Unix 拒绝 hard link。staging 位于 profile 内随机的 `migration/exports/mfa-*/`，由 RAII owner 删除；receipt 无 key、账户或密文列内容。交付前再次核对 receipt、整个快照的 hash/size，以及只有预期文件且没有 SQLite sidecar。原工作库、代码 versions、active、pending journal 和历史 LanChat 字节均不由该 API 修改。

receipt 的最终数据目标为 `plugins/mfa/data/mfa.db`，不归 `versions/<version>`。导出 owner 自身不提供公开持久化/激活方法；后续可信 coordinator 必须保持 owner、复核源和快照、经同一受限 key 服务验证解密，并完成原子数据 generation/active/journal 事务。进程崩溃遗留 staging 的识别清理、断点恢复、真实旧安装替换和回滚仍是 TASK-012 待办；不能把临时导出成功视为这些步骤完成。

## 断言与验证层

| 契约 | 断言与执行层 |
|---|---|
| 数据完整性 | hosted 真实 SQLite/WAL：仅复制 main 的 oracle 为 0 个账户，生产导出含 1 个；全部业务行、schema/user_version、密文/nonce/key_check、metadata/偏好相等，原 key 解出 RFC HOTP 755224 |
| 一致性 | 未提交 counter/note 不进入快照；MFA 或 Vault 在预检后或真正 snapshot progress 回调中变化均拒绝；正确新预检可重试 |
| 取消/失败 | snapshot 验证前和临时快照发布后取消均清理临时数据、释放全部 lease；deadline、损坏库和源消失不初始化源或替换既有工作产物 |
| 交付复核 | 篡改导出、receipt、空 WAL 或任一源均拒绝交付；drop 后 staging 不存在 |
| 路径/所有权 | 旧模式、当前 profile、Vault、MFA writer、state 各自占用均拒绝；跨 profile 预检拒绝；Unix 主文件/sidecar/父目录链接与 hard link、Windows junction 均实际验证 |
| 跨进程 | 真实子进程按旧模式持 shared lease 时，单独的新版 restore 锁不排斥它，升级模式锁明确 busy；kill/wait 后 OS 释放锁，新 profile 锁仍独立生效 |
| key-only | 真实 Vault 固定项存在且 MFA 库不存在，保留原 Vault 字节，不建源/模块库，不泄露值 |
| 保留行为 | 原预检、候选归属、pending 幂等和 WAL 指纹测试原样保留，并在同一生产源码 harness 执行 |

无新 renderer/IPC 入口；生产 pending 行为保持，因此没有新增无法触发 exporter 的 browser/YAML 假入口。继续保留 browser TC-MODULES-026/029/031 和 native 025/027/028/030/032，检查实际升级推荐、真实 0.5.9 输入、pending、WAL、候选正常重启及源数据保持。多端 UI 使用 `qa-ui-auto-platforms`，仍包含完整 `crash-regression`；exporter 的真实文件/锁副作用由独立原生 Rust gate 证明，不由 browser stub 推导。

## 当前执行状态

本地纯内存单元 **8/8**（来源约束 5、散列/WAL/取消 3）通过；生产 exporter 与全部真实文件场景已编译，未在本地执行真实场景。核心完整 `--lib --no-run` 编译及最终静态检查另录；不把编译计作 native 通过。

`.github/workflows/qa-modular-legacy-export.yml` 复用生产源码路径，在 Linux x64、Windows x64、macOS 15 Intel 执行全部原迁移单元、12/11/12 个真实导出场景和单独的真实进程模式锁场景，保存源 SHA、Rust/OS/架构、实际测试 binary hash、准确 selection、原始日志和 receipt。该 workflow 由已注册的 `qa-modular-upgrade.yml` 默认完整调用及 `host_only=true` 调用，无需先合并新 workflow 到 main。ARM64 本批尚未新增结果，不外推。

当前 GitHub 执行待调度，尚不报告真实导出或新版 UI 通过。每个完成 artifact/shard 都在运行期间下载审查；失败保留并按实际来源修复。
