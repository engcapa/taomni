# 开发编排：Worktree 环境准备与构建缓存契约

- 状态：v0.4 review 修订；这是 Bootstrap Recipe 设计，不是已实现安装器。
- 关联：[主设计](../development-orchestrator-design.md)、[资源 / schema](scheduler-contract.md)、[实施包](p0-p1a-implementation.md)。
- 目标：linked-worktree 不再因缺 node_modules 直接跑失败；也不为每个 attempt 盲建几十 GB target，或让 Cargo 文件锁被误报成模型卡死。

## 1. 环境准备是显式阶段

`reserved → preparing_workspace → waiting_environment_resources → bootstrapping → ready → executing`，均为 attempt preparing 的可查询子阶段。UI 显示缺依赖、排队池和执行命令，不把等待缓存锁算成 agent 无进展。

Bootstrap 独立于网络 / UI 生命周期，有取消、deadline、日志和资源所有者；**完成 worktree add 不等于环境 ready**。API 纯文档任务无需 worktree，不能为所有 API 任务强制安装前后端依赖。

```text
BootstrapRecipe {
  id, revision, trust_ref,
  prerequisites, toolchain_bindings,
  dependency_fingerprint_inputs,
  dependency_strategy: local_materialize | managed_readonly_snapshot | private_copy,
  install_steps: [{ executable, argv, cwd, network_policy_ref, lifecycle_script_policy }],
  build_pool_ref?, output_roots, runtime_cache_roots,
  disk_budget, cleanup_policy
}

BootstrapReceipt {
  attempt_id, recipe_revision, source_snapshot,
  tool_versions, dependency_fingerprint, dependency_mode,
  commands_and_exits[], effective_proxy_policy,
  build_pool_key?, disk_usage, validation_results, status
}
```

所有命令 / 网络 / lifecycle scripts 由已授权 recipe 决定，仓库和模型只能提议。缺 package manager 不自动下载执行 installer；未知就 waiting_input / blocked。

## 2. 依赖复用：lockfile 是必要条件，不是充分条件

fingerprint 至少包含：OS / arch、Node / pnpm / Rust / compiler ABI、相关 manifests、workspace 配置、lockfile、`.npmrc` / Cargo config 的非秘密摘要、patches / local path dependencies、feature / target / profile、recipe revision。凭据不得进入 hash 输入日志。

- **默认 pnpm 路线**：共享包管理器受控 content-addressed store，每 worktree 单独 `node_modules` 布局；匹配 fingerprint 时离线 / frozen materialize，不重复下载。pnpm 的 store 链接不等于把整个 node_modules 链给另一 checkout。
- 不受限工具可能写依赖文件并污染硬链接 store：此时 materialize 必须采用受支持的 copy / 安全写时复制策略，或真正只读挂载共享内容；不能仅因每工作区有独立目录就宣称依赖不可污染。profile 不可强制时默认私有copy，复用下载缓存但不共享可写inode。
- `node_modules` 内常有 workspace symlink、postinstall / native build 产物和工具缓存；绝对 / 相对链接可能回指用户 checkout。因此**不默认 symlink 用户主目录的 node_modules**，即便 lockfile 相同。
- 可选托管只读依赖快照仅在 fingerprint 一致、路径 / symlink 闭包验证、不会写包目录且实际可实施只读挂载 / 权限时启用。读失败或工具需写就明确用私有布局 / copy，不能悄悄把共享树改 writable。
- Windows junction / symlink、Unix symlink 本身不提供写保护；没有可信隔离能力的 profile 不能称为 managed-readonly。cache 的 tsbuildinfo、Vitest / Vite、coverage、test results 都重定向到 attempt 私有目录。
- manifests / lock / workspace 本地包 / patches 发生变化或脚本产物不兼容：指纹失效，申请 install pool 后新建布局。安装成功并校验后才发布依赖快照；不修改全局基线和其他 attempt。
- pnpm store 自身并发安全不意味着自定义 lifecycle scripts 安全。相同 managed snapshot 的构建 / 发布加独占 bootstrap 锁；不同私有布局仍遵守网络 / 安装并发上限。

`pnpm install --offline --frozen-lockfile` 可作为可信 recipe 的步骤；离线 miss 显示明确缺包。联网 fallback 必须已授权且过应用 / feature / none 三代理严格规则，不自动直连；脚本默认不执行，确需 native rebuild 按用户批准步骤开启并记录。

## 3. Cargo 共享缓存与 Heavy build 绑定

区分三种东西：

1. 下载缓存：受控 `CARGO_HOME` 的 registry / git cache，可复用但不暴露用户全部 credential。
2. 编译缓存：可选 `sccache` 等能力，没有就不自动装；命中与否不决定测试 PASS。
3. `CARGO_TARGET_DIR`：**可写构建现场，必须有真实的互斥资源键**，不是“安全只读缓存”。

首版采用每 repo / toolchain / target / profile 的 managed build pool，显式注入 `CARGO_TARGET_DIR`；同一个 target dir 的所有 cargo build / test / clippy / bootstrap build 取得独占 `build_pool:<canonical-path>`。同 key 只有一个真实构建命令，等待显示 waiting_build_pool，不先启动 cargo 再堵在其锁上。

- 重型命令原子取得 Heavy build slot + build-pool slot + 需要的 native 环境；拿不到不启动。短 Git 锁不跨 install / cargo / 模型生成持有，避免锁次序反转。
- owner 只为**真实命令执行期间**持有 build pool，不在 agent 整个推理期间占用。未证明子进程树停止时不释放，lease 过期不意味着可重入。
- 两个 worktree 仍可以并行编辑 / 推理，但共享 target 的 cargo 阶段串行。确需并行则用户预设两个独立 pool，先检查磁盘配额；不能每个新 attempt 自动复制完整 target。
- 共享 pool key 不同也要遵守 machine heavy slot、文件系统 / toolchain 兼容；Cargo 会自行判断增量兼容，不声称跨路径都能命中。
- 收集测试结果、binary / report hashes 必须在持有 pool 时完成并复制到 immutable ArtifactStore，再释放；否则后续构建可能覆盖前项 binary。native QA 使用与 candidate tree 对应的固定二进制，不能直接引用可能被覆盖的 pool 路径。
- 外部进程绕开调度持有 Cargo 锁时，后台观察并显示 external_cache_lock，有限等待 / 提示；不能无声杀外部 cargo，也不把它误报 agent 超时。总 wall-clock 不得无限延长。

## 4. 防止 CLI / 脚本绕过缓存槽

Heavy build 只有所有相关命令经过 supervisor 才能真正强制。首版 CC adapter 的 Bash / build 工具由许可 hook / 受控命令通道接管，识别到构建先原子取 pool；不允许 provider 内部 shell 在同一 target 随意启动第二个 cargo。

若某 CLI 无法可靠拦截原生命令，则 **不允许其使用共享可写 target**：改为私有受配额 pool 或限制为只提交 patch / 构建由 builtin 执行。声明 isolation / resource-enforcement 能力，不能只在 prompt 写“请勿并行构建”。

一般 shell 也可嵌套调用 cargo；无法证明拦截时以上限制仍生效。环境变量必须由 supervisor 注入并检查；不依赖用户 shell 恰好已 export。

## 5. 磁盘、取消、恢复与清理

- worktree、依赖快照和 build pool 分别记录 ownership marker、指纹、真实大小 / 预留和引用。低磁盘在启动前阻止，运行中超预算停止受控工作并保留候选，不清理用户数据来“修复”。
- 取消停止 install / build 子进程树，未验证布局标 incomplete；重启先对账，不因目录存在就当 dependencies ready。
- GC 只清理无活动引用、无未知进程、已确认属于 Taomni 的 idle pool / 依赖快照；最后使用时间只是排序，不证明可删。删前核验 marker / canonical 路径，拒绝越界 / symlink 攻击。
- 不自动删除用户 `node_modules` / target、系统缓存、未提交 worktree 或未知文件夹；停止 / 崩溃的现场保留规则与 TaskAttempt 一致。
- P0/P1A BootstrapReceipt 作为 typed artifact、状态 / claim 在 attempts，intent 在 events；不为本功能额外建环境数据库。

## 6. 验收与最小真实 fixture

| ID | 场景 | 必须证明 |
| --- | --- | --- |
| V-BS01 | 新 worktree 没有 node_modules，已有 store | 显式 materialize / ready，tsc / Vitest 真实解析依赖；不访问用户 checkout 链接 |
| V-BS02 | 相同 lock，不同 Node ABI / .npmrc / patches / workspace local pkg | fingerprint 不兼容则不共享，不用 lock-only 命中 |
| V-BS03 | 锁文件变化、offline miss、代理失败、脚本未授权 | waiting / 明确失败，无隐式联网 / 直连 / lifecycle scripts |
| V-BS04 | 两个 attempt 同时请求同一 Cargo target | 仅一个 cargo 真启动，另一 waiting_build_pool；和 Heavy slot 无死锁 |
| V-BS05 | 构建取消 / 宿主崩溃 / 外部 cargo 锁 | 受控进程停止或 unknown；不误释放 / 误杀；ready 不继承 incomplete |
| V-BS06 | pool 后续构建覆盖、磁盘低、GC 有活动引用 | 前项 immutable binary / report 保留，GC 不删活动 / 用户目录 |

三端测试包含 Windows junction / ACL / Job Object 与 Unix symlink / process-group 的真实效果；browser stub 只演示状态。pnpm fixture 使用本地文件依赖 / 受控 store，Cargo fixture 使用无外网依赖的小 crate，可先离线验证行为，不为 Bootstrap 验收安装全部产品依赖。
