# Taomni 模块化重构交接

## 2026-11-24 续接进展

**公开发行仍是单体 `v0.5.13`。生产发布待同一 `0.6.0` 候选 SHA 收齐四目标实装升级、纯核心与全模块的崩溃回归，以及 G1–G11 回执。** [当前公开版本](https://github.com/engcapa/taomni/releases/tag/v0.5.13)

- Wave 2A 工作流 `#45391530402` 已确认整体成功，18 个分片共通过 150 项。首发 10 个模块中有 6 个已取得 Linux、Windows 和 macOS ARM64 三端双版本生命周期证据。 [Wave 2A 回执](https://github.com/engcapa/taomni/actions/runs/45391530402)
- Wave 2B 已新增 `TC-MODULES-112`–`115`。VNC Client 和 RDP Client 在 Linux、Windows、macOS ARM64 各通过 10/10 阶段，首发已取得三端生命周期证据的模块共 8/10。两个服务端的旧配置触发了首装流程，用例已改为先装入旧版，再接入更新目录。VNC Server 在 Linux 验证 RFB 认证、监听和 `x11vnc` 回收，在 Windows 和 macOS 托管环境核对外部 VNC 服务和系统屏幕共享的指引。原三端复跑因 macOS 排队已取消，分为 Linux/Windows 和 macOS 26 两次运行。 [首轮回执](https://github.com/engcapa/taomni/actions/runs/45399176436) · [Linux/Windows 复跑](https://github.com/engcapa/taomni/actions/runs/45412993964) · [macOS ARM64 复跑](https://github.com/engcapa/taomni/actions/runs/45414324974)
- macOS 基座包已移除旧 SocksCap Redirector 桥接程序。旧会话恢复通过验签后的系统 Provider 清除捕获范围，正常捕获继续使用签名 SocksCap 宿主。Linux、Windows 和 macOS 安装包清点会拒绝对应模块运行部件。 [代码](https://github.com/engcapa/taomni/commit/55cdefc0b) · [原生回归](https://github.com/engcapa/taomni/actions/runs/45401294673)
- Mail `0.1.59` 将协议引擎移出默认基座，旧 SQLite 邮箱、归档对象和备份迁移保留共享存储实现。四目标本地 Cargo 树均排除 `taomni-mail-engine`、`imap`、`imap-proto`、`lettre` 和 `mail-parser`。存储库默认与全特性分别通过 40、70 项单测，独立协议引擎和 Mail 宿主分别通过 23、46 项。基座 Mail 迁移和备份单测各通过 7、3 项，生产前端构建清单的 424 个入口均排除首发模块渲染代码。 [代码](https://github.com/engcapa/taomni/commit/ef895cd1b)
- 候选升级工作流通过 `package_run` 指定同源码发布构建。崩溃回归的 `module_profile=full` 通过 `first_release_run` 获取同一批签名模块。`module_profile=core-only` 通过 `head` 绑定相同源码并验证空模块列表。 [升级工作流](../.github/workflows/qa-modular-upgrade.yml) · [崩溃回归配置](../qa-ui-auto-tests/ci/README.md)

## 2026-11-24 20:34 原交接快照

本阶段已完成 Mail `0.1.57` POP3 附件与 `0.1.58` 引擎/解析迁移、MFA 三态自动还原、SocksCap Linux 启动器/冷启与草稿修复、V-008 只读单模块目录演练、基座 `ironrdp`/`rcgen`/`mail-parser` 依赖裁剪，以及 Wave 1 + Wave 2A 的 6 个首发业务模块三端双版本无重启生命周期验证。 [实施台账](taomni-modular-split-progress.md#接下来的执行顺序)

## 接手位置

- 工作区位于 `/data-share-winsys/code/person/taomni-refactor-modules`。分支 `refactor/modules-arch` 在本次交接文档提交前的最新代码提交为 `168f69fae98092984cd847d4dad05dcd1071d978`（紧随其后的提交仅更新本交接文档）。[重构分支](https://github.com/engcapa/taomni/tree/refactor/modules-arch)
- 远程 `origin/main`（`ec8ef63f1`，PR #878 Maven transfer resilience）已通过 [`9795ce284`](https://github.com/engcapa/taomni/commit/9795ce284) 干净合入，合并时无新增冲突。
- 上一份交接（`6439685e3`）中未提交的两组草稿——Mail `0.1.57` POP3 附件解码与 MFA 三态自动还原——已全部补齐单测与观测器、验证并提交；当前工作区除本交接文档外无未提交代码改动。
- 目标范围仍是台账中的 1–7 项、设计中的 `TASK-001` 至 `TASK-027`、`AC-001` 至 `AC-017`、`V-001` 至 `V-012`，以及 G1–G11 发布回执。LanChat（`TASK-015`）已删除，Mobile 按 DEC-2 在首发中由基座提供。[设计 §10](taomni-modular-split-design.md#10-实施计划p1-内部分批第一版一起发布mail-纳入首发验收集合) · [ADR](../claudedocs/adr-taomni-modular-split.md) · [AGENTS.md](../AGENTS.md)

## 已完成的开发与本阶段进展（6439685e3 → 168f69fae）

### 基座基础能力（6439685e3 及之前已入库）

- 基座已具备模块注册表、签名版本目录、启停与禁用、默认保留数据的卸载、回滚、进程监督、profile/模式租约、Vault 作用域服务、备份协调、三代理模式可断点续传下载器，以及设置内模块商店入口。[架构与验收台账](taomni-modular-split-progress.md#任务状态)
- 首发名单固定为 10 个模块：`ai-voice-local`、`mail`、`mfa`、`rdp-client`、`rdp-server`、`screenshot`、`servers`、`sockscap`、`vnc-client`、`vnc-server`；截图入口/普通截图/滚动截图/共享采集由基座持有，OCR 与录制归 `screenshot`。首次升级夹具已锚定官方 `v0.5.13` 四目标资产与 `0.5.12` 可选旧基线回放。[首装名单](../src-tauri/plugins/legacy-upgrade.json) · [截图归属](taomni-modular-split-design.md#37-截图入口留核心与备份留核心)

### 本阶段已提交并经 GitHub 验证的交付

- **`TC-MAIL-CACHE-02` 修复与 Mail 0.1.57 / 0.1.58 迁移**：[`eebc3527b`](https://github.com/engcapa/taomni/commit/eebc3527b) 修复重复同步与缓存正文状态保留；[`0e2be91bd`](https://github.com/engcapa/taomni/commit/0e2be91bd) 与 [`0ac5d486b`](https://github.com/engcapa/taomni/commit/0ac5d486b) 完成 Mail `0.1.57` POP3 附件在签名宿主内解码与原子保存；[`e58217239`](https://github.com/engcapa/taomni/commit/e58217239) 发布 Mail `0.1.58`，将旧 POP3 路径与 `mail-parser` 迁入签名 Mail 宿主，并在 [G 门 #45337958092](https://github.com/engcapa/taomni/actions/runs/45337958092) 与 [协议/契约 #45337965410](https://github.com/engcapa/taomni/actions/runs/45337965410) 通过验证。
- **签名 MFA 三态自动还原与生命周期收口**：[`de73677fc`](https://github.com/engcapa/taomni/commit/de73677fc) 与 [`4f6e1b2d7`](https://github.com/engcapa/taomni/commit/4f6e1b2d7) 补齐 `TC-MODULES-104/105/106`（运行、禁用、卸载保留三态自动还原，含 SQLite WAL sidecar 与 HOTP 解密校验）；[`fe1974f1f`](https://github.com/engcapa/taomni/commit/fe1974f1f) 修复 `TC-MODULES-103` 会话侧边栏选择步骤。
- **SocksCap Linux 启动器迁出与静默超时/归档性能修复**：[`dbc5e2d4e`](https://github.com/engcapa/taomni/commit/dbc5e2d4e) 将 Linux trace launcher 迁入签名 SocksCap 包；[`854806a3e`](https://github.com/engcapa/taomni/commit/854806a3e) 在宿主静默期保留 `HostUnavailable` 语义；[`3ab722ef2`](https://github.com/engcapa/taomni/commit/3ab722ef2) 改为内存验证已安装包归档并允许 Windows SocksCap 冷启动。三项获 [Platforms #45319002178](https://github.com/engcapa/taomni/actions/runs/45319002178)、[Upgrade Contracts #45309871747](https://github.com/engcapa/taomni/actions/runs/45309871747)、[G1–G11 #45309880849](https://github.com/engcapa/taomni/actions/runs/45309880849) 全绿通过。
- **V-008 只读单模块目录演练**：[`028c8800a`](https://github.com/engcapa/taomni/commit/028c8800a) 与 [`d128b3d57`](https://github.com/engcapa/taomni/commit/d128b3d57) 新增并通过 `release.yml` 执行单模块增量目录合并、签名校验与资产保留演练，[Release Bundle #45314025590](https://github.com/engcapa/taomni/actions/runs/45314025590) `completed/success`。
- **G9 核心依赖首轮裁剪**：[`1b8f1ac8a`](https://github.com/engcapa/taomni/commit/1b8f1ac8a) 移除基座中未使用的 `ironrdp*`、`taomni-rdp-common` 与 `rcgen` 运行时依赖。[`#45358137976`](https://github.com/engcapa/taomni/actions/runs/45358137976)（`suite=core`，`completed/success`，本地归档 `qa-ui-auto-report/github/45358137976/artifacts/modular-core-build-inventory/cargo-tree-*.txt`）在四目标构建清点中确认：`ironrdp=0`、`taomni-rdp-common=0`、`rcgen=0`、`mail-parser=0`；默认基座 Cargo 树仍残留 `taomni-mail-engine=2`、`taomni-sockscap=2`。
- **Wave 1 签名双版本生命周期（`servers`、`sockscap`）**：[`948eccfb0`](https://github.com/engcapa/taomni/commit/948eccfb0) 将 `assert_signed_module_lifecycle`、`qa_catalog` 与 `qa-modular-packages.yml` 抽象为通用双版本签名机制，新增 `TC-MODULES-107`（`servers`）与 `TC-MODULES-108`（`sockscap`）；[`#45357871114`](https://github.com/engcapa/taomni/actions/runs/45357871114) 验证 `TC-MODULES-107` 与 `TC-MODULES-103` 在三端 10/10 阶段全过并暴露出 SocksCap 手动编辑未完成上行配置时的草稿丢失问题；[`899435ec4`](https://github.com/engcapa/taomni/commit/899435ec4) 修复 [`createProfileActions.tsx`](../src-tauri/plugins/sockscap/renderer/panel/createProfileActions.tsx) 后，[Platforms #45365029513](https://github.com/engcapa/taomni/actions/runs/45365029513) 18/18 分片 158/158 用例全过，`TC-MODULES-108` 三端 10/10 阶段通过。
- **Wave 2A 签名双版本生命周期（`screenshot`、`ai-voice-local`、`mail`）**：[`7802d70e3`](https://github.com/engcapa/taomni/commit/7802d70e3) 新增 `TC-MODULES-109/110/111`，补齐无状态定位器、纯宿主可选 `frontendSha256`、`ggml-base.bin` SHA-256 校验与 Mail SQLite/`.imap-owner` 复用（本地单测 61/61、`qa_ui_auto.audit --gate` 0 error、`pnpm check:refactor` exit 0）；[`#45376841330`](https://github.com/engcapa/taomni/actions/runs/45376841330) 与 [`#45383929494`](https://github.com/engcapa/taomni/actions/runs/45383929494) 证明 `TC-MODULES-109` 与 `TC-MODULES-111` 在三端 10/10 阶段通过；随后 [`83a55c772`](https://github.com/engcapa/taomni/commit/83a55c772)、[`439e8d395`](https://github.com/engcapa/taomni/commit/439e8d395)、[`168f69fae`](https://github.com/engcapa/taomni/commit/168f69fae) 依次消除窄视口 floating 抽屉与 Windows CPU Whisper 解码耗时竞争，最终在 [Platforms #45391530402](https://github.com/engcapa/taomni/actions/runs/45391530402) 跑通全部 18/18 分片（150/150 用例全绿，`TC-MODULES-110` 三端 10/10 阶段 `reinstalled` + `passed: True`）。

### 10 首发模块双版本生命周期台账（6/10 完成，4/10 待开发）

| 模块 slug | 当前清单版本/状态 | G7 双版本生命周期用例 | 当前验证状态 |
| --- | --- | --- | --- |
| `mfa` | `0.1.2` / `provisional` | `TC-MODULES-103`（及三态还原 `104–106`） | **已通过**（`linux-x86_64`、`windows-x86_64`、`darwin-aarch64` 10/10 阶段，含 `#45319002178` / `#45357871114`） |
| `servers` | `0.1.3` / `provisional` | `TC-MODULES-107` | **已通过**（三端 10/10 阶段，`#45357871114`） |
| `sockscap` | `0.1.14` / `provisional` | `TC-MODULES-108` | **已通过**（三端 10/10 阶段，`#45365029513` 18/18 分片全绿） |
| `screenshot` | `0.1.4` / `provisional` | `TC-MODULES-109` | **已通过**（三端 10/10 阶段，`#45376841330` / `#45383929494`） |
| `ai-voice-local` | `0.1.0` / `provisional` | `TC-MODULES-110` | **已通过**（三端 10/10 阶段 `168f69fae`，`#45391530402` 18/18 分片 150/150 全绿） |
| `mail` | `0.1.58` / `provisional` | `TC-MODULES-111` | **已通过**（三端 10/10 阶段，`#45376841330` / `#45383929494`） |
| `vnc-client` | `0.1.0` / `provisional` | 待新增（建议 `TC-MODULES-112`） | **待开发（Wave 2B）** |
| `rdp-client` | `0.1.2` / `provisional` | 待新增（建议 `TC-MODULES-113`） | **待开发（Wave 2B）**（已有单版本分离窗口 `TC-MODULES-056`） |
| `rdp-server` | `0.1.2` / `provisional` | 待新增（建议 `TC-MODULES-114`） | **待开发（Wave 2B）** |
| `vnc-server` | `0.1.2` / `provisional` | 待新增（建议 `TC-MODULES-115`） | **待开发（Wave 2B）** |
| （验证基线）`hello-plugin` | `0.1.0` / `provisional` | `TC-MODULES-042` | 已在三端长期通过 |

## GitHub 任务执行与监控状态

- **最新在途运行 [`#45391530402`](https://github.com/engcapa/taomni/actions/runs/45391530402)（`qa-ui-auto-platforms.yml`，`head=168f69fae`）**：
  - 全部 **18/18 个 QA 分片（150/150 用例）均已通过**，`FAILS: []`，原始分片及 `TC-MODULES-110` 三端 `signed-ai-voice-local-lifecycle.jsonl`（含完整 `crash-regression` 与 `TC-MODULES-067`）已下载至 `qa-ui-auto-report/github/45391530402/wave2a-voice-final/`。
  - 按用户 20:32 指令已于 **20:34 立即停止本地监控进程**（`task-3007` 已取消）；停止时刻仅剩 `native-contracts / native-build-linux-x64-release` 作业在 GitHub 端收尾，因此 `#45391530402` 的整体 workflow `status/conclusion` 尚未在本机作最终确认。接手后请先执行下方 `gh run view 45391530402` 核对最终收口。

| 运行 ID | Workflow | 源码 SHA | 状态与结论摘要 | 本地证据路径 |
| --- | --- | --- | --- | --- |
| [`#45391530402`](https://github.com/engcapa/taomni/actions/runs/45391530402) | `qa-ui-auto-platforms.yml` | `168f69fae` | **18/18 QA 分片 150/150 全过**（Wave 2A Voice + 全量 `crash-regression`）；停止监控时 `native-contracts / native-build-linux-x64-release` 仍在收尾 | `qa-ui-auto-report/github/45391530402/wave2a-voice-final/` |
| [`#45383929494`](https://github.com/engcapa/taomni/actions/runs/45383929494) | `qa-ui-auto-platforms.yml` | `83a55c772` | `TC-MODULES-109`（`screenshot`）与 `TC-MODULES-111`（`mail`）三端 10/10 通过；`TC-MODULES-110` 已在 `168f69fae` 修复通过；偶发 `TC-FILE-OPEN-009` macOS 已在 `#45391530402` 通过 | `qa-ui-auto-report/github/45383929494/` |
| [`#45376841330`](https://github.com/engcapa/taomni/actions/runs/45376841330) | `qa-ui-auto-platforms.yml` | `7802d70e3` | `TC-MODULES-109` 与 `TC-MODULES-111` 三端 10/10 通过；偶发 Windows `TC-FILE-OPEN-005` 已在 `#45383929494` 与 `#45391530402` 通过 | `qa-ui-auto-report/github/45376841330/` |
| [`#45365029513`](https://github.com/engcapa/taomni/actions/runs/45365029513) | `qa-ui-auto-platforms.yml` | `899435ec4` | `completed/success`，18/18 分片 158/158 用例全过，`TC-MODULES-108`（`sockscap`）三端 10/10 通过 | `qa-ui-auto-report/github/45365029513/live-monitor/` |
| [`#45357871114`](https://github.com/engcapa/taomni/actions/runs/45357871114) | `qa-ui-auto-platforms.yml` | `948eccfb0` | `TC-MODULES-103`（`mfa`）与 `TC-MODULES-107`（`servers`）三端 10/10 通过 | `qa-ui-auto-report/github/45357871114/live-monitor/` |
| [`#45358137976`](https://github.com/engcapa/taomni/actions/runs/45358137976) | `qa-modular-gates.yml` (`suite=core`) | `948eccfb0` | `completed/success`，验证四目标基座已清除 `ironrdp`/`taomni-rdp-common`/`rcgen`/`mail-parser` | `qa-ui-auto-report/github/45358137976/artifacts/` |
| [`#45337958092`](https://github.com/engcapa/taomni/actions/runs/45337958092) / [`#45337965410`](https://github.com/engcapa/taomni/actions/runs/45337965410) | `qa-modular-gates.yml` / Upgrade Contracts | `e58217239` | `completed/success`，Mail `0.1.58`、协议与四端探针通过 | `qa-ui-auto-report/github/45337958092/` · `45337965410/` |
| [`#45314025590`](https://github.com/engcapa/taomni/actions/runs/45314025590) | `release.yml`（V-008 演练） | `d128b3d57` | `completed/success`，只读单模块增量目录合并、序号递增与资产一致性通过 | `qa-ui-auto-report/github/45314025590/rehearsal-evidence/` |
| [`#45319002178`](https://github.com/engcapa/taomni/actions/runs/45319002178) / [`#45309871747`](https://github.com/engcapa/taomni/actions/runs/45309871747) / [`#45309880849`](https://github.com/engcapa/taomni/actions/runs/45309880849) | Platforms / Contracts / G1–G11 | `3ab722ef2` | 三者均 `completed/success`，覆盖 MFA 三态、归档内存验签与 SocksCap 冷启动 | `qa-ui-auto-report/github/45319002178/` |

### 监控与续传常用命令（含 CI 已知坑点）

```bash
export HTTPS_PROXY=http://10.1.0.80:3228 HTTP_PROXY=http://10.1.0.80:3228
gh run view 45391530402 --json headSha,status,conclusion,jobs
gh run list --branch refactor/modules-arch --limit 10
python .agents/skills/qa-ui-auto/scripts/ci_live_monitor.py \
  --repository engcapa/taomni --run-id 45391530402 \
  --destination qa-ui-auto-report/github/45391530402/live-resumed
```

- **切勿对 `qa-ui-auto-platforms.yml` 执行 `gh run rerun --failed`**：`ci.py` 跨分片收集会因 `run_attempt` 不匹配导致收口失败，需重新派发完整 run。
- **派发 `qa-modular-gates.yml` 必须同时传分支名与完整 40 位 SHA**：`modular_gate_runs.py` 通过 `git/ref/heads/{source_ref}` 解析分支，请固定传 `source_ref=refactor/modules-arch` 与 `head=<40-char-sha>`。
- **并行限额与 macOS runner**：本模块化任务在途 workflow 同时最多保持 3 个；`macos-15` 容量不足时可临时切 `macos_runner=macos-26`，但正式 Intel G1 与 Intel 实装升级仍需对应 Intel runner。

## 达到上生产目标的剩余待办（按执行顺序）

1. **P0 待办 1 — 完成 Wave 2B 剩余 4 个业务模块双版本无重启生命周期（G7）**：
   - 按 `TC-MODULES-107`–`111` 复用架构，为 `vnc-client`、`rdp-client`、`rdp-server`、`vnc-server` 新增签名前后两版本生命周期用例（`TC-MODULES-112`–`115`），验证同一桌面核心 PID 下启停、升级、握手失败恢复、无重启回滚、卸载保留与重装，以及对应独立窗口/服务端监听端口/输入回放与资源回收；同步更新 `feature-list.md`、`testid-catalog.md`、`policy.yaml`、`dependencies.yaml`（视需要），本地跑通 `qa_ui_auto.audit --gate`、`pnpm check:refactor` 及受影响单测后，经 `qa-ui-auto-platforms.yml`（含完整 `crash-regression`）在 Linux/Windows/macOS ARM64 全绿过关。
2. **P0 待办 2 — 清理基座剩余 Mail 与 SocksCap 核心依赖及平台入口（Item 3 & G9）**：
   - 将默认四目标基座 Cargo 树仍残留的 `taomni-mail-engine`（2 处）与 `taomni-sockscap`（2 处）裁剪出基座默认编译图，移除基座内遗留 Mail 旧读写/兼容代码路径以及 SocksCap 在核心包内的 macOS bundle/bridge 残留引用（核查 [`tauri.macos.conf.json`](../src-tauri/tauri.macos.conf.json)、[`verify-macos-release-bundle.sh`](../scripts/verify-macos-release-bundle.sh)、[`bridge.rs`](../src-tauri/src/sockscap/redirector/runtime/bridge.rs)）；确保历史归档/备份还原、系统权限归属与卸载安全不退化。完成后重新派发 `qa-modular-gates.yml`（`suite=core`），在四目标 Cargo 树、Vite 产物、四目标安装包载荷（含 Linux deb/RPM/AppImage）及原生入口清单全部清零验证。
3. **P1 待办 3 — 合入最新 `origin/main`、正式定版与模块清单转 `stable`**：
   - 拉取并合入届时 `origin/main` 的新增提交并处理冲突，保留两边代码修复与测试覆盖；
   - 将基座版本号升级至正式目标版本（如 `0.6.0`），把 10 个首发模块的 `src-tauri/plugins/<slug>/module.json` 从 `"status": "provisional"` 全部切换为 `"stable"`（并同步所需冻结版本号）；
   - 在本地跑完格式、严格类型检查、Rust 单元/集成测试、`qa_ui_auto.audit --gate` 与 `pnpm check:refactor`，推送并**冻结单一正式候选 SHA**。
4. **P0 待办 4 — 在同一正式候选 SHA 上收齐发布包、`0.5.13` 升级、双配置回归与 G1–G11 原始回执**：
   - **(a) 全量发布包预建与签名校验**：用冻结候选 SHA 跑 [`release.yml`](../.github/workflows/release.yml)（空 `tag`、`platforms=all`、`macos_arch=both`、冻结十模块 roster、沿用 `main` 签名配置），产出四目标核心安装件、40 个 `.taomni-plugin`、`.minisig`、`SHA256SUMS`、`modules.json`、updater 验签工件与 `modular-candidate-roster-<run-id>`。
   - **(b) 真实 `v0.5.13 → 0.6.0` 四目标安装与升级验收**：使用同一 SHA 和 `package_run` 派发 [`qa-modular-upgrade.yml`](../.github/workflows/qa-modular-upgrade.yml)（`package_targets=all`，启用 `package_first_release_linux`、`package_first_release_desktop`、`package_relocation_linux`、`package_rdp_perf`，安装基线 `0.5.13`），验收 Linux（deb/RPM/AppImage）、Windows MSI 与 macOS 双架构（ARM64/Intel）实装升级、旧数据迁移（至少覆盖 RDP/VNC、Servers、MFA、SocksCap、Mail）、禁用/卸载保留、新模块选装、回退与再次升级，以及 G1–G6 实装回执。
   - **(c) 双安装配置全量与核心崩溃回归**：同一候选 SHA 以 `module_profile=core-only` 和 `module_profile=full` 各通过 [`qa-ui-auto-platforms.yml`](../.github/workflows/qa-ui-auto-platforms.yml)。两轮传 `tags=crash-regression` 和 `native_release=true`，完整模块配置额外传 `first_release_run`。在正式候选上确认 MFA 界面还原、v1 归档兼容、GUI/headless 互斥，以及安装包体积、启动、内存、终端 I/O、RDP 与安装任务性能预算。
   - **(d) G1–G11 全门绑定归档**：按每次并发 ≤3 个上限通过 [`qa-modular-gates.yml`](../.github/workflows/qa-modular-gates.yml) 收齐其余 `host`/`protocol`/`system`/`signed` 子运行回执，确保发布台账把 G1–G11 逐一绑定到**同一候选源码 SHA、runner 镜像版本、包资产 ID 与 SHA-256、用例/选集摘要与原始工件路径**。
5. **P0 待办 5 — 正式差异发布（待用户确认后执行）**：
   - 全部门禁闭环并获用户确认发布后，按双清单与先上传包与 `.minisig`、最后发布 `modules.json` 与 `latest.json` 的规则，复用已验签 `candidate_run` 工件发布正式 Core Release 与首套模块 Catalog，模块资产绝不打入核心安装包。

## 1–7 项进展与剩余交付

| 项 | 当前已达到 | 上生产还需完成 |
| --- | --- | --- |
| 1 多端回归 | Wave 1 与 Wave 2A 三端全量分片（含 `crash-regression`）在阶段提交全过，最新 `#45391530402` 18/18 分片 150/150 全绿 | 完成 Wave 2B 后，以**同一正式候选 SHA** 分别跑 `module_profile=core-only` 与 `module_profile=full` + `crash-regression`（含 `native_release=true`） |
| 2 Vault、profile 与一致快照 | `TC-MODULES-103/104/105/106` 已全部入库并三端实测通过三态自动还原、WAL 与 HOTP 连续性 | 在同一正式候选上复验 MFA 界面还原、旧 v1 归档、GUI/headless 互斥、强退与进程锁释放 |
| 3 业务归属 | 10 模块可签名打包；Mail `0.1.58` 已迁走 POP3 附件与旧 POP3/`mail-parser`；SocksCap Linux launcher 已迁出 | 清理基座内剩余 Mail 旧兼容路径及 SocksCap macOS bundle/bridge 残留，保护还原与卸载安全 |
| 4 核心依赖闭包（G9） | `#45358137976` 已证实四目标核心彻底清零 `ironrdp`/`taomni-rdp-common`/`rcgen`/`mail-parser` | 清除剩余 `taomni-mail-engine`（2）与 `taomni-sockscap`（2）默认依赖，并在候选 SHA 重跑 `suite=core` 核验四目标与 Linux 三格式载荷 |
| 5 模块生命周期（G7） | 已有 **6/10** 首发业务模块（`mfa`、`servers`、`sockscap`、`screenshot`、`ai-voice-local`、`mail`）完成三端双版本 10/10 阶段实测，另含 `hello-plugin` (`TC-MODULES-042`) | 补齐 Wave 2B 剩余 **4/10** 模块（`vnc-client`、`rdp-client`、`rdp-server`、`vnc-server`）双版本无重启生命周期并在候选 SHA 收齐 |
| 6 首装及精细化升级 | `v0.5.13` 升级夹具已对齐；过往 `0.5.12 → 0.6.0` 四目标演练及 `TC-MODULES-040–047` 已建 | 用**正式候选**从真实 `v0.5.13` 执行四目标升级、五类旧数据迁移、卸载/禁用保留、回退与再升级 |
| 7 正式发布验收 | V-008 只读单模块演练已在 `#45314025590` `completed/success`；候选工件复用契约已就绪 | 定版 `0.6.0` 与清单转 `stable`，在正式候选收齐性能预算与 G1–G11 绑定回执后，再按差量规则正式发布 |

## G1–G11 正式候选状态与待补证据

| 门 | 阶段进展与已有回执 | 同一正式候选 SHA 必须补齐的验收结果 |
| --- | --- | --- |
| G1 macOS 宿主启动 | 已有历史安装及 ARM64/Intel 签名核验路线 | 同一候选的 macOS ARM64 与 Intel 安装包及签名宿主、固定证书、hardened runtime、Gatekeeper 原件与实际启动回执 |
| G2 系统权限 | 已有 `#45150360966` 历史 TCC 权限回执 | 正式候选升级前后 macOS 屏幕录制/辅助功能归属（核心、MFA、RDP Server、截图、Mobile）及 Linux Wayland 实际授权/输入 |
| G3 Windows 防护 | 已有 `#45125000076` 及近期 Native 冷启实测 | 正式候选 MSI Authenticode（接受 unsigned）、下载区标记与 Defender 开启下安装启动签名宿主、可观察 SmartScreen 状态 |
| G4 Linux `noexec` | 已有历史实装迁移/回退记录（[见实装核验](taomni-modular-installed-upgrade-verification.md#linux-安装格式的-noexec-恢复)） | 正式候选 deb、RPM、AppImage 上的宿主拒绝、可执行 profile 搬迁与原数据恢复（含 OS 挂载与清理原件） |
| G5 RDP 性能 | `#45337965410` 等已测得编码探针；约定参考 65 ms、上限 p95 ≤ 130 ms | 同候选 SHA 签名 RDP 实装输入到画面，附首帧 ≤ 500 ms、帧率 ≥ 25.6 fps、带宽 ≤ 4905 kbps 与 40/40 有效样本原始记录 |
| G6 强制退出 | 已有历史强杀释放原件与静默 `HostUnavailable` 修复 | 正式候选实装包三端强杀核心后的宿主/子进程清理及重启后数据恢复回执 |
| G7 无重启生命周期 | **6/10 首发业务模块三端 10/10 阶段已通过**（`103`/`107`/`108`/`109`/`110`/`111`） | 补齐 Wave 2B 4 模块（`vnc-client`/`rdp-client`/`rdp-server`/`vnc-server`），并在候选 SHA 留存 10 模块完整 PID、宿主与数据摘要回执 |
| G8 篡改拒绝 | 已有签名清单、V-008 演练（`#45314025590`）与安装拒载记录 | 正式候选验证目录/签名/包/清单/路径篡改拒绝，附官方公钥验签与资产 SHA-256 一致性 |
| G9 核心闭包 | `#45358137976` 证实 `ironrdp`/`taomni-rdp-common`/`rcgen`/`mail-parser` 已清零 | 清除 `taomni-mail-engine`（2）与 `taomni-sockscap`（2）后，正式候选 `suite=core` 证明四目标全零、Vite/载荷/入口清白 |
| G10 RPC 健壮性 | `#45337965410` 等已归档多轮三端进程契约与协议套件 | 正式候选 SHA 上三端真实宿主的握手、权限、超时、取消、崩溃与重复请求清理回执 |
| G11 租约和入口 | 备份静默（`854806a3e`）、三态互斥与 VNC/SocksCap re-exec 已有阶段验证 | 正式候选核对备份前静默、profile 与 GUI/headless 双向互斥、VNC/SocksCap re-exec 入口与四目标核心可执行清单 |

## 用户要求与操作提示

- 目标是依据设计完成模块化并具备生产发布条件；LanChat 直接删除；Mail 属于独立模块；前后两套发行安装状态和跨进程验证必须在 GitHub runner 执行。[仓库约定](../AGENTS.md#modular-product-development)
- 首次从单体升级时，为已有 profile 自动安装签名目录冻结名单中与当前平台兼容的模块（允许卸载）；后续仅更新已安装模块并保留禁用/卸载选择；新增模块展示名称与说明待用户选择安装；卸载默认保留业务数据，明确确认后才永久删除。[升级设计](taomni-modular-split-design.md#8-数据与迁移) · [历史实装](taomni-modular-installed-upgrade-verification.md)
- 本地仅跑单元、静态、契约与构建检查；Browser/Native 均附带完整 `crash-regression` 与受影响用例，及时分片下载核对 `selection.json`、`build-identity.json`、`ci-outcome.json`、`runner_receipt.json` 和 `summary.json`。无关失败仅在保留原始证据与判定依据下可单列。[QA 工作流](../.github/workflows/qa-ui-auto-platforms.yml) · [崩溃回归规则](../qa-ui-auto-tests/ci/crash-regressions.md)
- Windows 签名与 Apple 公证沿用 `main`（接受 unsigned MSI 与未公证 macOS app），但固定 macOS 签名身份、Gatekeeper、真实 TCC、Windows Defender 与目录/模块/updater 验签均是强制门禁；G5 接受输入到画面 p95 ≤ 130 ms。[签名及性能约定](../AGENTS.md#modular-product-development)
- 远程 `main` 有新提交时须先合入当前分支并解决冲突；涉及修改后注意以 `pnpm check:refactor` 把关 800 行拆分上限与边界检查。

## 发布和新增模块

| 改动 | GitHub 发布方式 |
| --- | --- |
| 仅核心 | [`release.yml`](../.github/workflows/release.yml) 生成四目标核心安装件和 `latest.json`；沿用上一版已验签 `modules.json` 与 `.minisig` 到新的核心 Release，不重编模块包。 |
| 仅一个模块 | [`release-modules.yml`](../.github/workflows/release-modules.yml) 生成指定模块全声明平台的 `.taomni-plugin`、`.minisig`、`SHA256SUMS` 与递增序号后的完整签名目录，上传至模块 Release 并同步目录到最新核心 Release。 |
| 同时修改核心与模块 | `release.yml` 的 `modules` 传改动 slug（首发传全部 10 模块），在同一 draft Release 中先上传全部包与 `.minisig` 再发布 `modules.json` 和 `latest.json`，模块资产绝不嵌入核心安装包。 |

模块源码位于 `src-tauri/plugins/<slug>/`，共享协议与库位于 `src-tauri/crates/`，安装态采用 `<app-data>/plugins/<slug>/versions/<version>/`、`active.json` 和 `data/`；卸载时清理 `runtime/` 派生缓存但保留 `data/` 直至明确删除。[发布设计](taomni-modular-split-design.md#76-核心与模块差异发布规则v17) · [独立目录工具](../scripts/plugin-package/README.md#production-catalog-preparation)
