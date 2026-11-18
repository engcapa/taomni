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

升级后的重新预检保留 MFA 已提交条目、原源指纹和目标路径，只重新计算未执行的其他项目。已知路径和指纹格式以外的提交条目、重复条目与 staged 状态仍要求恢复。预检和提交共用持久化 journal 写入。纯单元验证重复扫描、剩余候选、完成状态与拒绝覆写异常记录，签名 native 场景额外验证真实 journal 的重复扫描。

## 已提交迁移后的 MFA 数据归属

`76c3f94e9` 在 GUI/headless 启动取得 profile lease 并恢复迁移和还原事务后，从 journal 确定 MFA 数据 owner。唯一且有效的 committed 条目使用签名宿主；没有已提交条目的 profile 仍使用核心连接。异常 journal 使 MFA 拒绝访问。已提交 profile 的模块被停用或卸载时，重新启用或重装后继续读取保留的模块数据。旧根目录中的 `mfa.db` 是迁移前的留存副本。

MFA 命令保留现有 IPC 参数、返回值与 Vault 错误。导出由核心验证主密码，再向该次宿主操作发放单次 grant。重置先排空已准入操作并取得 Vault 独占 lease，再发放重置 grant。主密码停留在核心的零化缓冲区。屏幕、窗口与图像读取仍由核心处理。

备份通过同一 Vault 屏障获取模块数据和 Vault。已提交 profile 恢复包含 `databases/mfa.db` 且没有 MFA 模块数据集的旧归档时，SQLite 恢复事务将该库写入 `plugins/mfa/data/mfa.db`，以同一归档的 Vault 验证。还原会持有数据 lease、建立恢复副本、更新数据 locator 和 profile generation。对包含独立 MFA 模块数据集的归档，模块库存放到对应的模块目标。模块版本与 active 指针由已安装包管理。

GitHub 的 Linux x64、Windows x64、macOS ARM64 各通过 5 项迁移场景、3 项签名安装场景与 2 项网络场景。两项新增场景实际执行生产 MFA 路由、密码导出、重置、禁用/卸载，并通过启动恢复读取旧归档的原始 HOTP；原根数据库与 LanChat 留存字节核对通过。四个平台的签名包长度、SHA-256、测试源码和三端 harness receipt 已复核。升级输入使用原 Vault 和引擎生成的 0.5.x 风格数据。生产 Settings 仍记录 pending，正式旧版安装包写入 MFA 数据和候选安装程序替换继续归入 TASK-012。 [签名升级 #44212837658](https://github.com/engcapa/taomni/actions/runs/44212837658)

## 离线执行入口

候选原生程序的维护入口接收 `<profile> <plugin-archive> <minisig-file>`。原 Vault 密码通过私有 stdin 管道原样传入并在使用后清理。执行方先验签，再取得旧应用模式锁、profile 排他锁、状态锁、Vault 操作锁和 MFA 数据锁。它在锁内重新读源，兼容正常退出时 SQLite 对 WAL 的 checkpoint。错密码时原始数据、启用状态、active 指针和 journal 保持原状。

首次迁移可以在没有 `migration/journal.json` 的情况下开始。落下 committed 条目后，恢复事务把 MFA 标记为已启用，然后清理事务记录。其余模块状态保持。正常启动根据 journal 选择宿主，Settings 的后续预检只显示剩余候选。重复执行会报告已迁移，并保持已提交的 journal、目标库和现有启用选择。

新签名场景在独立进程调用同一维护入口，检查仍有桌面占用时的拒绝、错密码、无 journal 的首次迁移、重复执行，以及实际签名宿主读取原账户和 HOTP。Linux x64、Windows x64、macOS ARM64 各 6 项迁移场景已通过，11 份产物在执行期间收齐。 [离线签名契约 #44229752783](https://github.com/engcapa/taomni/actions/runs/44229752783)

## 设置页交接

检测到可迁移的 `mfa.db` 时，模块商店提供 MFA 包、分离签名和原 Vault 主密码输入。签名和密码在当前应用退出前各验证一次。原生退出流程完成任务清理后授权维护子进程，父进程退出关闭管道写端。子进程核对批准数据、包的签名与确认时的 SHA-256，再获取排他 profile 锁并复用离线执行。完成或失败后启动同一应用，并在 Settings 显示结果。成功状态需要已有已提交迁移归属。主密码不进入命令行、环境变量或持久化记录。

`TC-MODULES-036` 在 browser/native 覆盖拒绝无效签名、清空密码以及原 HOTP 保持。`TC-MODULES-037` 用浏览器的路径选择器验证包与签名字段独立，取消后可看到先前路径。`TC-MODULES-038` 在 macOS 15 Intel 使用真实签名包，从设置页确认后观察原进程正常退出和新进程自动接管，再用原 Vault 密码解锁并检查迁移后的 HOTP 续号。`TC-MODULES-039` 在 Linux Xvfb 验证迁移正式旧版创建的 MFA 账户。 [最终原生复跑 #44249448069](https://github.com/engcapa/taomni/actions/runs/44249448069)

Linux 另以正式 `0.5.10` 和测试用 `0.5.11` deb 通过同一资料目录的原位替换、签名迁移、降级和重装。Windows 与 macOS 的实际候选安装件替换及回滚仍待验收。 [Linux 原位升级证据](taomni-modular-installed-upgrade-verification.md#linux-安装件替换与回滚)
