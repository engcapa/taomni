# Structural Search P2 修复：编辑器快照与文件错误

来源：`docs-feature/code-workspace-idea-parity/branch-review-008-009-20260927.md` 的当前分支 S5/S6。基线 `efcfbc919db0da7ad568e5d2a377a6d6353c4e99`；修复在同分支工作区完成。

## 行为与边界

- Find 执行时读取所有已加载、无加载错误的 workspace Java 编辑器快照，包括非活动缓冲及空文本；通过 `buffers` 传给 AST 后端，不执行保存。
- 后端以 rootId + 相对路径选择缓冲，优先于磁盘；按 workspace/module/file 范围过滤。已打开但磁盘上不存在或被 ignore 的 Java 文件也可参与所选范围。拒绝未知 root、重复路径和路径越界。
- 磁盘读取失败、非 UTF-8、文件超过 2 MiB、parser 未完成均返回带路径的 typed error，不返回部分结果或“成功无命中”。读取采用 2 MiB + 1 的有界 read，包含 Current File 与缓冲大小检查。
- 已在编辑器成功解码的文件可用内存文本搜索；未打开的 UTF-16 文件明确报编码错误。用户可打开该文件，或保存 UTF-8 副本后重新搜索。
- 保留模板 3/1/0、结果导航、Text/Invert、取消及释放、Find/regex 搜索。此处是单次查询输入快照，未新增结果随编辑实时更新能力。

## 回归与证据

改前 native 复现保留于 `qa-ui-auto-report/branch-review/current-probes/results.json`：dirty 999 被按磁盘 42 命中，UTF-16 被作为 ok + 0 scanned + empty。

| 验收 | 回归 |
|---|---|
| active/inactive/空缓冲覆盖磁盘，范围正确、无保存 | Rust `editor_snapshots_override_disk_and_include_inactive_files_without_writes`、`editor_buffers_respect_module_root_and_reject_path_escape`；session/stub tests；TC-IDE-PARITY-009-05/06 |
| 编码失败不能变成空结果，可恢复搜索、磁盘不变 | Rust `unsupported_encoding_is_a_typed_error_in_every_scope_and_buffer_can_recover`；UI 错误/retry 单测；TC-IDE-PARITY-009-06 |
| 大文件、读失败显式错误 | Rust `oversized_files_fail_explicitly_in_both_disk_and_buffer_searches`、`missing_or_unreadable_source_is_not_an_empty_search` |
| 原有 3/1/0、取消释放、共享搜索与导航 | 原有 009-01/02/03/04、CodeWorkspaceTab 和 session tests |

新增 YAML 已登记 CI policy；两条用例均自带 fixture，没有额外 case 顺序依赖。复用 F25.5/F25.6 与现有 controls，无生产 testid 变更。

## 验证结果：done（本轮两个 P2）

- Vitest：3 文件 228/228，通过 session、browser adapter 与 CodeWorkspaceTab 保留行为；`qa-ui-auto-report/parity009-p2-fix/unit.log`。
- Rust：`cargo test --manifest-path src-tauri/Cargo.toml --lib structural_search`，16/16；`qa-ui-auto-report/parity009-p2-fix/rust.log`。
- TypeScript：`tsc -b --pretty false` 通过；独立 QA native 构建成功。
- Browser：009-01/02/04/05 共 4/4；`qa-ui-auto-report/parity009-p2-fix/browser/run-20260927-204248-049764700/summary.json`。005 的 action input selector 收敛为已登记 selector 后，最终版本单独重跑通过：`browser-final/run-20260927-204444-637353400/summary.json`。
- Windows native/WebView2：009-03/06 共 2/2；`qa-ui-auto-report/parity009-p2-fix/native/run-20260927-204625-576901200/summary.json` 与同目录 `runner_receipt.json`。006 实际覆盖 active dirty 的 42→0/999→1、切到 Other.java 后 file→0/module→1、命中导航恢复 dirty 文本、workspace 对 Legacy.java UTF-16 的显式错误、切回 module 重试成功、两个磁盘 SHA-256 不变。003 保留真实 3/1/0、invalid-pattern、运行中 Esc 和 activeRequests=0。
- `audit --gate`、新 case 的 CI plan、对当前工作区 diff 执行的 development contract 均通过；静态目录没有 orphan。原有 Git prev-file control 缺口仍属此前评审事项。
- 标准 browser/native 运行 `identity_stable=true`，source SHA-256 `b8710a804b3b8866e7fc298b3fbafed15d840b85dffdda31e1331f815351b064`；native binary `74d4d9560fd7251a5bea16c2f600ea77f3a696146832e92833cc821b83576d48`，identifier `com.taomni.app.qa`，数据/config/cache 隔离。

Windows 为当前验收平台；Linux/macOS native 保留未运行。代码使用标准 Rust 文件/路径 API 和现有 Tauri IPC，无新增平台专用依赖。本轮 done 仅指 S5/S6 修复，不把此前 IDEA 双侧证据缺口或整个分支的生产放行结论自动升级。
