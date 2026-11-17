# 升级前的只读 MFA 密钥自检

对应主设计 TASK-012 和 Vault 服务方案 §9.3。`keys::verify_existing_key` 是后续可信升级 coordinator 的纯 engine helper，当前不接 renderer/IPC、不改变生产 pending、不授予密钥访问或安装激活权限。

## 行为和所有权

调用方必须持有原 profile/Vault 世代的受限准入，提供稳定的独立 SQLite 快照、已有 `KeyProvider` 和取消/deadline 检查。helper 只调用 `load`，既不调用初始化/修复方法，也不保留返回的零化密钥。受限 Vault 服务、完整 grant 生命周期与升级事务仍由后续 coordinator 接线；任意实现 `KeyProvider` 不是可信安装证明。

旧 `prepare_key` 在没有 key-check 的旧库上会创建该记录，不能用于不允许改变字节的导出交付验证。新 helper 验证已有 key-check，并逐条解密全部账户，流式释放明文，不只验证首条，也不因为 key-check 正确而忽略后续损坏的账户。无 key-check 的合法旧库保持原样；仅无账户、无 key-check 且无 key 才返回 Unused。有密文或 key-check 而缺 key 时拒绝，错 key、错误 nonce/AAD 或损坏密文均拒绝，不生成替代 key。结果只有账户数量与 key-check 是否存在，不含 key、账户标识、secret 或 OTP。

取消/deadline 在密钥读取前后和逐行解密期间检查，原错误直接返回。调用方仍须保护快照稳定性，并在交付前调用 `PreparedMfaExport::verify` 绑定源、产物和 receipt；helper 的结果不是可持久化的授权令牌。

## 验证

本地只执行内存 SQLite 单元：新增 8 项与原有 13 项共 21/21。覆盖已绑定/无 key-check 的只读库、未用过的空库、缺 key/错 key、首条正常而后续损坏、损坏 key-check/nonce/AAD、取 key 前取消、逐行取消，以及取 key 期间取消必须先于任何数据库读取。query-only 与 `total_changes` 断言禁止写入；初始化/修复方法一旦被调用则测试立即失败。

新增 GitHub-only 原生场景 `key_verification_keeps_bound_and_unbound_exports_identical_on_success_failure_and_cancel`：通过实际生产 exporter 得到有/无 key-check 的真实文件，以 SQLite read-only 模式打开，验证成功、缺 key、错 key和取消后文件字节、receipt、全部源都不变，drop 后 staging 清理。这里使用已知 fixture 的只读 provider；不能据此宣称真实受限 Vault 服务交接或已安装 0.5.x 的 MFA 数据升级通过。

现有 exporter gate 扩为 Linux/Windows/Mac Intel 13/12/13 个真实场景，另跑 engine 的全部 21 项单元及各 1 个真实跨进程旧模式锁场景；保留原迁移测试。真实场景本地仅编译，不执行，GitHub 结果待补。

本地另通过 engine 生产库 clippy、两个受影响 crate 的 rustfmt、workflow actionlint、Node 22/pnpm 10 的 `check:refactor` 与 diff 空白检查。额外的全 workspace rustfmt 检查被未修改的 vendor 格式差异阻断，engine all-targets 严格 clippy 被原有 `tests/operations.rs` 两处 `cloned_ref_to_slice_refs` 阻断；保留原失败日志，未改无关源码或放宽 lint。

没有新的用户流程，不能从 UI 触发未接线的 helper，因此不增加假 browser 入口。保留 browser 026/029/031、native 025/027/028/030/032 以及完整 crash-regression；各轮证据按实际 source/case/runner/build 归属保存，不把旧 SHA 的 UI 通过改写为本 helper 已接线。

## Vault 读取接线

`PreparedMfaExport::verify_key` 在已有排他维护 lease 下绑定事先记录的 Vault 主文件与 WAL 指纹。它在只读事务内验证原主密码、读取唯一的 `mfa.data-key-v1`，将零化密钥交给同一次调用中的 engine 校验。密码保留原始字节，兼容首尾包括空格的原主密码。固定项解码器与现有 Vault 服务共用，口令验证也由现有 MFA 导出口令路径复用。返回值只包含数据库校验结果或 key-only 标记，调用前后会重新检查源文件和 staging。已有 key-only Vault 继续保留，空库可在没有密钥时返回 Unused，已有密文缺少密钥时失败。

验证包括 4 项纯内存单元，以及 4 项 GitHub 专用场景。后者通过生产 Vault schema/密码验证/解码器和真实加密文件执行正确及错误口令、缺失及损坏密钥、已有/无 key-check、key-only、取消和 Vault WAL 变化后的重试，检查源与 staging 字节、HOTP、维护锁及清理。它们使用合成旧数据。下一步在受信任的升级事务中消费此结果，发布数据和 active 状态并加入崩溃恢复，最后用正式旧版安装程序验证升级。

## 可信的离线提交与启动恢复

离线提交消费同一 profile 维护锁保护的已准备导出与经过生产验签的 MFA 包。它验证原 Vault 密钥和全部加密记录，复核包的 MFA 数据与固定密钥声明，将包写入非活动的版本目录。提交仅面向没有既有模块数据目录、活动版本或回滚版本的初次迁移。发现冲突或等待还原时保留旧资料并返回明确错误。

`migration/mfa-transaction.json` 先持久化。升级数据写入独立暂存目录，事务持有独占 profile 状态锁发布新 generation，再将完整目录移到 `plugins/mfa/data`，切换 active，最后在现有迁移 journal 提交条目。GUI 和 headless 在打开业务库前处理未清理的事务。提交点前发生崩溃时回滚 active、已验证归属和指纹的新数据、临时导出，保留已发布的 generation。提交点后的恢复复核已经发布的数据、版本包和 generation，再清理事务。原目录下的 MFA、Vault 和 LanChat 始终保留。

`qa-modular-upgrade.yml` 的 `signed_mfa_only=true` 复用生产公钥并执行三个真实签名包场景。它们验证迁移后实际宿主可读原账号和 HOTP、在 active 切换后从独立进程突然退出并走正常启动恢复、错误口令与已有目标保留。该批使用合成的 0.5.x 风格数据。实际升级入口仍需接入维护请求与应用退出流程，切换 MFA 生产 facade，再从已安装 0.5.x 完整验证。
