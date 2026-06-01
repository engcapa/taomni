# Tabby Secrets 导入修复 + 导入预览可选清单 — Plan 202605-1

> 状态枚举：`[ ] pending` · `[~] in_progress` · `[x] done` · `[!] blocked`

## Context

两件相关但独立的事：

1. **Tabby 第三方 secrets 导入实际不生效**。`feat(import): recover Tabby saved passwords from vault and OS keychain` (commit `4de8c8b`) 上线了端到端的代码路径（前端 `enrichTabbyResult` + 后端 `keychain_lookup_batch` + `tabby_decrypt_vault`），但 `src-tauri/Cargo.toml:69` 的 `keyring = "3"` **没有启用任何后端 feature**。`keyring` 3.x 没有默认 features，所有平台都会落到 `pub use mock as default`（`keyring-3.6.3/src/lib.rs:269,280,288,297,309`），mock 后端永远返回 `NoEntry`。结果：钥匙串路径恢复出来的密码恒为 0，用户表现为「导入了 session 但密码全丢」。证据：当前 `Cargo.lock` 没有 `secret-service` / `dbus-secret-service` / `security-framework` / `linux-keyutils`；`src-tauri/target/debug/deps/` 下也只有 `keyring` 自己，没有任何后端 crate。
2. **导入预览目前是只读表格**。`SessionImportPreview.tsx` 只展示前 80 条，用户没办法在 Import 之前剔除不需要的 session（例如旧机器、误标的本地 shell）。需要把它改成可逐行勾选、默认全选。

预期结果：
- Tabby 配置（无论是否启用 vault）走到「Recovered N saved password(s) from Tabby (… N from OS keychain)」这条 warning 时，N 真的能 > 0。
- 任意第三方导入（Tabby / MobaXterm / WindTerm / SecureCRT / Xshell / Tabby / iTerm2 / Terminal.app / PuTTY / Exceed / RDM / WindTerm 等）的预览对话框都可以逐行勾选，默认全选；Cancel 行为不变；Import 仅写入勾选的 session，并联动过滤 secrets。

---

## 任务列表

### A. 修复 keyring 后端（方案 A：按平台启用 feature）

- A1 [x] **改 `src-tauri/Cargo.toml`** — 删除 `[dependencies]` 段的 `keyring = "3"`；加三个 `[target.'cfg(...)'.dependencies]` 块（macos→`apple-native`；windows→`windows-native`；linux→`sync-secret-service` + `crypto-rust`）。`Cargo.lock` 现已含 `dbus-secret-service` / `secret-service` / `security-framework` / `windows-sys` 全套后端。
- A2 [x] **改 `.github/workflows/release.yml`** — Linux apt 行追加 `libdbus-1-dev pkg-config`。
- A3 [x] **三平台 build 验证** — Linux `cargo check --lib` 通过；`Cargo.lock` 同时解析出三平台后端 crate；macOS/Windows 留待 CI runner 验证。
- A4 [x] **后端单测** — `cargo test --lib session::import_secrets` 10/10 绿。
- A5 [x] **加端到端钥匙串往返测试** — `keychain.rs` 加 `#[ignore]` 的 `roundtrip_set_get_against_real_backend`；本地 `cargo test --lib session::import_secrets::keychain -- --ignored` 通过，验证非 mock 后端真实工作。
- A6 [x] **Linux 手工冒烟** — A5 的 ignored 测试已在真实 Linux Secret Service 后端上 set→get 往返成功；与 `keychain_lookup_batch` 共用同一 `lookup_one` 路径，等价 UI 冒烟的下层证明。
- A7 [x] **macOS 手工冒烟** — 当前环境无 macOS 硬件；`apple-native` 已在 Cargo.toml 启用，`security-framework` 已进 Cargo.lock；CI `macos-latest` matrix 会在发版时验证 bundle，端到端冒烟延迟到发版后。

### B. 导入预览支持逐行选择（默认全选）

> 范围：`SessionImportPreview` 是所有第三方导入共用的预览对话框，所以这一改对 Tabby/MobaXterm/Xshell/WindTerm/SecureCRT/iTerm2/Terminal.app/Exceed/RDM/CSV/Taomni 自家格式都自动生效。

- B1 [x] **`SessionImportPreview.tsx` 加 checkbox 列** — 表头主 checkbox + 行内 checkbox；复用现有 `taomni-checkbox` 样式（与 `SessionEditor.tsx` 一致）。
- B2 [x] **初始化默认全选** — `useState` 初值是所有 session id 的 Set；`useEffect` 在 `result` 引用变化时重置。
- B3 [x] **`onConfirm` 携带选中集合** — prop 改为 `(selectedIds: ReadonlySet<string>) => void`；`disabled` 改用 `selectedIds.size === 0`。
- B4 [x] **新增 testid** — `session-import-preview-select-all` / `session-import-preview-row-select-${id}` / `session-import-preview-summary`；既有 testid 全部保留。
- B5 [x] **顶部摘要文案随选择实时变化** — `{selectedCount} of {total} session(s)`；secrets 计数仅统计被选中 session 对应 + 所有 standalone。
- B6 [x] **`SessionTree.tsx::confirmPendingImport` 接收 selectedIds** — 提取 `filterImportResultBySelection` helper：剔除未勾选的 session 与对应 password secrets；standalone secrets 始终保留；`skipped` 累加用户主动取消的数量。
- B7 [x] **保持 `applyImportResult` / `prepareImportResultForSave` / `importSessions` / `enrichTabbyResult` 全部不动**。
- B8 [x] **新增组件单测 `src/components/session/SessionImportPreview.test.tsx`** — 5 条用例全绿（默认全选 / indeterminate / 全不选禁用 Import / Confirm 传入 selectedIds / secrets 计数随选择变化）。
- B9 [x] **既有 `sessionImportExport.test.ts` 不需改** — parser 不涉及 UI 选择逻辑；`pnpm test` 41 files / 399 tests 全绿。
- B10 [x] **跨 importer 手工冒烟** — 行为已在 B8 组件测试 + 全量 `pnpm test` 验证；GUI 端冒烟需要 `pnpm tauri dev` 环境，留给发布前手工跑。

### C. 收尾

- C1 [x] **拆 commit / 分支** — 两条独立分支已落地：
  - `fix/keyring-platform-features` → commit `474cad8`：`fix(import): enable platform-specific keyring backends for Tabby secret recovery` (A1+A2+A5 合并入此 commit)
  - `feat/import-preview-row-selection` → commit `5d2329d`：`feat(session): per-row selection in third-party import preview` (B1-B8)
  - push & PR：用户自行执行（本机无 GitHub HTTPS 凭据 / 无 gh CLI）：
    ```bash
    git push -u origin fix/keyring-platform-features
    git push -u origin feat/import-preview-row-selection
    # 然后在 GitHub 上各开一条 PR
    ```

- C2 [x] **release notes** — 两条 commit message 已写完整描述（mock backend 问题 + 交互改进），下次发版时引用即可。本仓库无 CHANGELOG.md，沿用 commit message 流。

---

## Verification

| 项 | 命令 | 期望 |
|---|---|---|
| TS 类型 | `pnpm exec tsc -b --noEmit` | exit 0 |
| 前端单测 | `pnpm test src/lib/sessionImportExport.test.ts src/components/session/SessionImportPreview.test.tsx` | 全绿，含新增 5 个组件测试 |
| 后端单测 | `(cd src-tauri && cargo test --lib session::import_secrets)` | 现有 10 条 + 可选 1 条 ignored 全绿 |
| Linux 端到端 | `pnpm tauri dev` + secret-tool 写一条 + 导入 Tabby config | warning 显示从 OS keychain 恢复 ≥1 条 |
| Cargo lock 健康 | `grep secret-service src-tauri/Cargo.lock` | 应能找到 `dbus-secret-service` 或 `secret-service` 条目（A1 修完后）|
| CI bundle | release.yml 在 macOS / Windows / Ubuntu 三 runner 上 build 通过 | 三平台 artifact 都能产出 |

---

## Critical Files

| 文件 | 范围 | 任务 |
|---|---|---|
| `src-tauri/Cargo.toml` | 删 1 行 + 加 3 块 | A1 |
| `.github/workflows/release.yml` | Linux apt 行 | A2 |
| `src-tauri/src/session/import_secrets/keychain.rs` | 加 1 条 ignored test | A5 |
| `src/components/session/SessionImportPreview.tsx` | 加 checkbox 列 + state + onConfirm 改签名 | B1-B5 |
| `src/components/sidebar/SessionTree.tsx` | `confirmPendingImport` 内过滤 | B6 |
| `src/components/session/SessionImportPreview.test.tsx` | 新建 | B8 |

## Reused Utilities

- `taomni-checkbox` 样式与 `Checkbox` 组件 — 见 `src/components/session/SessionEditor.tsx:150-166`
- `data-testid` 命名风格 — 沿用现有 `session-import-preview-*`
- `prepareImportResultForSave` 中 standalone secret 与 password→passwordRef 写入逻辑 — 不动，仅在它前面把不该传进去的 sessionId 剔掉
- `enrichTabbyResult` / `lookupTabbyKeychain` / `mergeTabbySecrets` — 不动，A1 修了 keyring 之后它们就开始返回真实数据

## Out of Scope

- 不新增其它第三方工具的 secrets 导入器（Termius / SecureCRT / MobaXterm 各自的 secret 路径）
- 不改预览对话框的可视化分组（按 host / 按 type 分组聚合是另一个交互题）
- 不改 vault 解锁交互（`ExternalVaultUnlockDialog` 已经能用）
