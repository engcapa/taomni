# Git 克隆工作区导入 — 验证记录（2026-11-21）

- 分支：`feat/workspace-git-clone`
- 最终产品代码提交：`ab32060bb`（其后 `e6bf2b8bb` 仅修改设计文档）
- 设计：[design.md](design.md)
- 线框图：[git-clone-wireframe.png](git-clone-wireframe.png)
- 结论：功能在上表平台/模式及 Windows 本机完成验证；托管 workflow 仅剩一个与本功能无关的既有 native 失败（`TC-FILE-OPEN-006`，见下文）。

## 1. 实现结果

- 新增 Workspaces 的克隆导入入口：标签条 `+` 菜单、工作区切换器菜单、Home 的 Clone 卡片。
- 导入界面支持 URL、工作区名、**可编辑上层目录（默认 `~/taomni-workspaces`）**、分支、`user.name`、`user.email`、`http.proxy`、`https.proxy`、token、token 用户名。
- 默认值来自 Git 全局配置、`init.defaultBranch`/`main`、Taomni Application Proxy（去敏展示，后端解析凭据）及 vault 中已保存 token。
- 代理支持 Application / Custom / No proxy；No proxy 显式绕过隐式环境代理。
- 真实 Git 克隆：进度解析（阶段/百分比/对象计数）、取消、失败/取消清理、错误详情、重试；关闭对话框不取消任务，重新打开恢复进度。
- 成功后创建并激活工作区、登记最近工作区、展开项目树；仓库本地写入身份与代理配置；token 只保存到 vault 并配置 `taomni-auth.origin.tokenRef`。
- 安全：不接受 URL 内嵌凭据；token 不写 Git config、不回填明文；代理密码不进入 renderer；只删除本次创建的目标目录，已存在空目录保留并明确提示残留。

## 2. 单元与静态检查

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 功能专项 Vitest | `pnpm exec vitest run src/lib/gitClone.test.ts src/stores/__tests__/gitCloneStore.test.ts src/components/workspace/__tests__/WorkspaceGitCloneModal.test.tsx` | 18/18 passed |
| 全量 Vitest | `pnpm test` | 7317 passed，1 skipped；1 个无关用例 `StructuralSearch.parity009` 在满载下失败、单独重跑 11/11 passed |
| Rust clone 单测 | `cargo test --lib --no-default-features --features "hbase-kerberos,rdp-server-audio,voice-capture,asr-sherpa" git::clone` | 12/12 passed |
| TypeScript / 边界 | `pnpm exec tsc -b`、`pnpm check:refactor` | passed |
| QA 目录/契约 | `python -m qa_ui_auto.audit --gate`、`dev_contract.py --base origin/main --head HEAD` | passed；3 个 QA 用例已登记 |

说明：本机 `cargo test --lib` 使用默认 features 时存在既有的 MSVC CRT 链接冲突（`clickhouse-rs` vs `whisper-rs-sys`），与本次代码无关；clone 测试使用不影响该模块的 feature 组合执行。`cargo check --lib` 默认 features 通过。

## 3. Windows 本机 QA

| 用例 | 模式 | 结果 |
| --- | --- | --- |
| `TC-WS-GIT-CLONE-01-defaults-proxy-and-clone-browser` | browser | passed |
| `TC-WS-GIT-CLONE-02-background-close-cancel-retry-browser` | browser | passed |
| `TC-WS-GIT-CLONE-03-native-real-clone-config-and-tree` | native（debug QA binary，最终源码重建） | passed |

Native 用例实际验证：本地 Git 仓库克隆、`develop` 分支、`.git/HEAD`、`.git/config` 中的 `user.name`/`user.email`/`http(s).proxy`、`branch-only.txt` 与 `src/main.ts` 磁盘字节、发布后的工作区与项目树。

## 4. crash-regression 回归

| 环境 | 结果 | 说明 |
| --- | --- | --- |
| Windows browser | 17 passed / 1 skipped | skip 为 `TC-FILE-OPEN-008`：本机未配置 `ssh_posix` 连接 |
| Windows native（release QA binary） | 19 passed / 2 failed / 1 skipped | `TC-FILE-OPEN-006` 为既有 native readonly-copy 产品竞态（见 §6）；`TC-MOBILE-013` 为本机隔离 native appcache 缺少 Playwright chromium 可执行文件；skip 为 SSH 配置 |
| Linux native（hosted） | 22 passed / 1 failed | 仅 `TC-FILE-OPEN-006` 既有失败 |
| macOS native（hosted） | 22 passed / 1 failed | 仅 `TC-FILE-OPEN-006` 既有失败 |
| Linux/macOS browser（hosted） | 全部 passed | 20/20 每平台 |

## 5. GitHub 托管执行

运行：[44887064434](https://github.com/engcapa/taomni/actions/runs/44887064434)，`scope=selected`，`platforms=linux,macos`，`modes=browser,native`，选择 3 条功能用例；workflow 按约定自动并入 crash-regression 集合。

- `plan`、`build-linux`、`build-macos`、全部 4 个 browser shard、全部 8 个 native shard、`native-contracts` 均 success。
- 功能用例结果：
  - Linux browser：`TC-WS-GIT-CLONE-01`、`02` passed
  - macOS browser：`TC-WS-GIT-CLONE-01`、`02` passed
  - Linux native（Xvfb）：`TC-WS-GIT-CLONE-03` passed
  - macOS native（arm64）：`TC-WS-GIT-CLONE-03` passed
- 聚合 `ci-summary.json`：`report_ok=true`，`infrastructure_errors=[]`；`failures` 仅 `TC-FILE-OPEN-006` 在 `linux-native-shard-4` 与 `macos-native-shard-4` 的两次记录。
- workflow 最终 `failure` 由该既有无关用例导致；本次新增/修改用例无失败。

产物已按 shard 完成即下载到 `qa-ui-auto-report/_local/hosted-44887064434/`（本地忽略目录），包含各 shard `summary.json`、runtime-errors、截屏与 receipt。

## 6. 已知无关失败与边界

1. **`TC-FILE-OPEN-006`**：既有的 native readonly-copy 加载竞态，已在 [2026-11-20-native-readonly-copy-load-race.md](../../docs-issue/2026-11-20-native-readonly-copy-load-race.md) 记录；本次 Windows/Linux/macOS native 均复现同一断言失败，浏览器通过，与 Git clone 改动无调用关系。
2. **`TC-MOBILE-013`（仅本机）**：本机隔离 native appcache 未安装 Playwright chromium headless shell，属于本地工具缺件；托管 native 用例不受影响。
3. **Windows hosted**：按用户要求 Windows 使用本机 browser/native 验证，托管矩阵未包含 Windows。
4. Git clone 不支持断点续传（Git 协议没有可靠的 clone 续传语义）；取消/失败时本次创建目录被清理，已存在空目录保留并提示残留位置。这是设计中的明确边界，不是未实现项。
5. `git_clone_defaults` 在对话框打开时读取一次默认值；设置变更后重新打开对话框不会强制刷新已缓存的默认值。

## 7. 复现命令摘要

```powershell
$env:PYTHONPATH = ".agents/skills/qa-ui-auto/scripts"
pnpm exec vitest run src/lib/gitClone.test.ts src/stores/__tests__/gitCloneStore.test.ts src/components/workspace/__tests__/WorkspaceGitCloneModal.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml --lib --no-default-features --features "hbase-kerberos,rdp-server-audio,voice-capture,asr-sherpa" git::clone

python -m qa_ui_auto run --mode browser --config qa-ui-auto-report/_local/config-browser.yaml `
  --filter TC-WS-GIT-CLONE-01-defaults-proxy-and-clone-browser,TC-WS-GIT-CLONE-02-background-close-cancel-retry-browser --require-pass
python -m qa_ui_auto run --mode native --config qa-ui-auto-report/_local/config-native-git-clone.yaml `
  --filter TC-WS-GIT-CLONE-03-native-real-clone-config-and-tree --require-pass
```
