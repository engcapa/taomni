# qa-ui-auto-platform 构建提速设计

## 1. 目标、状态与范围

本设计解决 `QA UI Auto Platforms`（`.github/workflows/qa-ui-auto-platforms.yml`，以下简称 platforms workflow）构建越来越慢的问题，重点是**少量 case 验证**场景：只改一两个 case、只想在单个平台上验证时，当前一次 run 也要 50 分钟以上，其中跑 case 本身只占几分钟。

- 来源：2026-11-21 用户要求调研 workflow 构建变慢的原因并给出更高效的方案，尤其少量 case 验证场景；随后要求先写设计文档、存 `docs-feature/`、建新分支提交推送，**不执行实现**。
- 基线：`e439e9d20`（origin/main，2026-11-21 12:46 CST，Merge PR #845）；调研时本地检出 main @ e439e9d20，已跟踪文件干净。
- 设计状态：**设计稿，待评审，未实施**。本文只写方案，不改 workflow、脚本、case 或 policy；实施按 §12 分阶段，另行排期。
- 范围：platforms workflow + 其调用的 `qa-ui-auto-entry.yml` + `qa-ui-auto` 规划/分片/构建脚本。不动 case 语义、不动证据契约（selection manifest、runner receipt、binary identity 校验）、不放宽“失败不能自动改绿”的原则。

## 2. 实测数据

数据来源：2026-11-21 当天 GitHub Actions API（workflow `qa-ui-auto-platforms.yml` 的 runs/jobs，UTC 时间）。

### 2.1 Wall time：一次 run 普遍 50–85 分钟

当天拉取的 20 个 run 里，15 个正常跑完的 dispatch / PR run wall time 为 51.9–111.6 分钟，中位约 75 分钟；另有 2 个 4–7 分钟的 run 是早期快速失败，3 个 cancelled，不计入。同一时段另有 5 个 dispatch run 同时处于 in_progress/queued，互相排队。

| Run | 事件 | Wall time | 结论 |
| --- | --- | --- | --- |
| 44899963744（#2014） | workflow_dispatch | 75.4 分钟 | failure（case 失败，非 infra 超时） |
| 44904055836（#2015） | workflow_dispatch | 59.7 分钟 | failure |
| 44899423260（#2013） | workflow_dispatch | 53.1 分钟 | failure |
| 44897480656 | workflow_dispatch | 85.8 分钟 | failure |
| 44894455514 | workflow_dispatch | 111.6 分钟 | failure |
| 44896462720 | pull_request（Feat/sidebar file explorer） | 82.9 分钟 | failure |
| 44896291767 | pull_request（Feat/workspace git clone） | 79.8 分钟 | failure |

### 2.2 Run #2014 的 job 分解：构建是关键路径，跑 case 不是

| Job | 耗时 | 结论 |
| --- | --- | --- |
| plan | 4.0 分钟 | success |
| build-linux / native-build-linux-x64-release | **51.8 分钟** | success |
| build-macos / native-build-macos-arm64-release | 36.2 分钟 | success |
| native-contracts / native-build-linux-x64-release | 15.5 分钟 | success（与构建并行） |
| execute-browser 各分片 | 1.9–6.9 分钟 | success |
| execute-linux-native 各分片（4 个） | 5.6–6.5 分钟 | success |
| execute-macos-native 各分片（4 个） | 4.7–5.2 分钟 | success |
| qa-ui-auto-platforms-result（summarize） | 0.4 分钟 | failure（汇总 case 失败） |
| tool-contracts、sftp-contracts、development-case-contract | 跳过 | 本次 scope 为 selected |

关键路径 ≈ plan（4）+ 最慢的 build（51.8）+ execute（约 6.5）+ summarize ≈ 63 分钟，再加排队即 75 分钟。

### 2.3 build-linux 51.8 分钟的 step 分解

| Step | 耗时 |
| --- | --- |
| Frontend behavior unit regressions（`pnpm exec vitest run` 全量 + 若干 Python 单测 + `pnpm check:refactor`） | **25.6 分钟** |
| Build and export the verified native runtime（`ci_native_artifact.py` → `pnpm tauri build --no-bundle`） | **24.3 分钟** |
| Linux native and service dependencies（`ci_linux_setup.sh`） | 0.7 分钟 |
| qa-runtime（pnpm install + pip install，均命中缓存） | 0.3 分钟 |
| Native QA workspace cache（`actions/cache` 恢复 `src-tauri/target/qa-ui-auto`） | 0.0 分钟 |
| 其余（含 rust-cache 恢复 0.1 分钟、cargo fmt） | 约 0.9 分钟 |

### 2.4 execute 分片的 step 分解（linux-native-shard-1）

| Step | 耗时 |
| --- | --- |
| qa-runtime | 0.4 分钟 |
| Linux native and service dependencies | 1.2 分钟 |
| Native adapter（tauri-driver，缓存命中） | 0.3 分钟 |
| Prepare local service packages | 0.0 分钟 |
| Download this invocation's verified native runtime | 0.1 分钟 |
| Run selected cases（Linux Xvfb desktop，`ci_execute.py`） | **3.1 分钟** |
| 其余（含上传 artifacts） | 约 0.5 分钟 |

结论：**跑 case 本身只要约 3 分钟；单分片约 2.5 分钟环境准备；其余 60 多分钟全是 plan + 构建 + 排队**。browser 模式更轻：execute-browser 分片 1.9–6.9 分钟，且不需要 native 构建。

### 2.5 波动说明

另一 run 的 build-linux 为 23.4 分钟（vitest 11.2 + 编译 9.5），与 #2014 的 51.8 分钟相差一倍以上。vitest 与编译耗时都不稳定，缓存命中情况不一（见 R5）。另：该 run 的 dispatch 分支 workflow 与 main 有差异（job 列表含 modular 相关 job），其 job 级数字仅作波动参考，不作基线。

## 3. 根因分析

| ID | 根因 | 依据 |
| --- | --- | --- |
| R1 | 默认就是全量：dispatch 默认 `platforms=linux,windows,macos`、`modes=browser,native`、`shards=auto`，不手动收窄就编 3 个平台的包 | `qa-ui-auto-platforms.yml` workflow_dispatch inputs 默认值 |
| R2 | 强制 crash 套件：selected / impacted / PR 都会自动并入 `crash-regression` tag，共 27 个 case，其中 22 个是 native 模式（13 个 browser+native、9 个 native-only）。只想验 1 个 browser case 也会触发三平台 native 构建 | `qa-ui-auto-platforms.yml` plan 步骤的 `QA_TAGS` 表达式；`qa-ui-auto-tests/cases/*.yaml` 统计；`qa-ui-auto-tests/ci/crash-regressions.md` |
| R3 | 强制 release 构建：crash 套件里的 TC-WS-054 带 `release_build_required` fixture；`ci_sharding.schedule()` 会把 release 扩散到同一平台+架构的全部 entry，于是整个 run 三个平台全是 release 构建，比 debug 慢得多 | `qa-ui-auto-tests/cases/TC-WS-054-release-layout-restart-and-save.testcase.yaml`；`.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci_sharding.py` 的 release 扩散逻辑；全仓共 16 个 case 带该 fixture |
| R4 | 全量前端单测串行挡路：build job 里 `pnpm exec vitest run` 跑全部 827 个测试文件（11–26 分钟），跑完才开始编译，两个大头串在同一 job 内 | `.github/workflows/qa-ui-auto-entry.yml` 的 Frontend behavior unit regressions 步骤（仅 Linux build job 跑）；`src/` 下 `*.test.ts(x)` 共 827 个文件 |
| R5 | 每次新 commit 都重编：构建复用只认源码哈希，commit 一变即失效；`actions/cache` 恢复 `src-tauri/target/qa-ui-auto` 那一步只花 0.0–0.7 分钟，对数 GB 的 target 目录来说基本等于没命中；增量编译每次仍要 9.5–24.3 分钟 | `native_build.py::build_qa/check_build`、`build_inputs`（含 `platform.platform()`，runner 镜像差异即可使 inputs 变化）；#2014 step 计时 |
| R6 | plan 本身 4–6 分钟：`audit --gate` 约 2 分钟（全量 835 个 case 的 catalog 校验）+ crash 回归契约约 1.5 分钟；本地单 case `make_plan` 也要约 68 秒 | #2014 plan step 计时；`qa_ui_auto/ci.py::make_plan` 全量 `discover()` + 全量依赖 DAG 校验 |
| R7 | 并发排队：一天内 20 次 run，每次约 20 个 job；多个 dispatch run 同时 in_progress/queued，互相排队；macOS entry 还限 `max-parallel: 2` | 当天 runs 列表；`qa-ui-auto-platforms.yml` execute-macos-native 的 `max_parallel: 2` |
| R8 | 执行端分片固定成本：每个 native 分片约 2.5 分钟环境准备（qa-runtime、Linux 依赖、tauri-driver、服务、下载 runtime）；`shards=auto` 时少量 case 也会扇出到最多 4 个分片，runner-minutes 放大 | §2.4；`ci_sharding.py`：selected + native 时 `desired = min(limit, len(units))`，短 selection 也会扇出 |

## 4. 设计目标与非目标

### 目标

- G1：少量 case 验证（1–3 个 case、单平台、单模式）的 wall time 从约 75 分钟降到约 20 分钟以内；browser-only 验证约 10–15 分钟。
- G2：全量 / PR / 夜间 run 的 wall time 明显缩短，但不降低其覆盖与证据强度。
- G3：每一次提速都有可复核的 run 计时作证据，不凭感觉宣布“变快了”。
- G4：quick 路径的降级是显式的、可标注的，不悄悄削弱门禁语义。

### 非目标

- 不改 case 语义、skip/gap 契约、selection manifest 与 runner receipt 的证据绑定。
- 不把 platforms workflow 的 required check 改成 quick 结果（分支保护仍以现有 check 为准，见 O1）。
- 不引入自建 runner 常驻机（P2 只列为选项，不在本设计内决定）。
- 不重写 `qa_ui_auto` 规划器；只在 workflow 与分片/构建的接合处做最小改动。

## 5. 方案总览

| 阶段 | 改动 | 预期收益（少量验证场景） | 风险 |
| --- | --- | --- | --- |
| P0-D1 | quick 预设：一键收窄 + 可选跳过 crash 套件 | 75 → 约 20 分钟 | 门禁语义变化，需显式标注（O1） |
| P0-D2 | vitest 移出 build 关键路径，改为并行 job | 关键路径减 11–26 分钟 | 汇总 job 的 needs 关系要重排 |
| P0-D3 | release 构建拆分：只有 release-required case 走 release | 三个平台改 debug 构建，各省数分钟至十余分钟 | TC-WS-054 等 case 的覆盖安排要单列（O2） |
| P1-D4 | 跨运行 runtime 复用（按源码哈希定名） | 同 commit 反复 dispatch 时每平台省 9.5–24.3 分钟 | artifact 保留期与存储；provenance 绑定不能放松 |
| P1-D5 | 缓存治理 + sccache + 更大 runner | 编译时间收窄波动、下限降低 | 费用；缓存体积与驱逐 |
| P1-D6 | plan 提速（audit 增量/缓存） | plan 4–6 → 约 1–2 分钟 | audit 是安全门，不能跳过校验 |
| P2-D7 | release 全量构建挪到 nightly | PR/dispatch 不再付 release 成本 | 夜间失败的发现延迟 |
| P2-D8 | dispatch 并发组 | 多 run 排队时后者取消前者或串行 | 误删正在跑的有效 run，需按 ref 分组 |

## 6. P0 详细设计

### 6.1 D1：quick 预设

- 在 `qa-ui-auto-platforms.yml` 的 workflow_dispatch 增加 `quick` 布尔输入（默认 false），或新增 `scope=quick`。选中时 plan 步骤强制收窄：`platforms` 与 `modes` 以用户输入为准且默认单平台（linux）+ 用户指定的模式；`shards=1`；`native_release=false`。
- quick 默认**不并入** `crash-regression` tag（改动 `QA_TAGS` 表达式：仅当非 quick 时追加）。quick run 的 summary 与 artifact 名字带 `quick` 标记；`summarize` 步骤在 summary.md 顶部写明“quick run：未含 crash 套件，不作为合入门槛”。
- quick 不得作为分支保护 required check；`publish-issues` 在 quick 下强制关闭。
- 验收：1 个 linux native case 的 dispatch run，wall time ≤ 20 分钟；summary 含 quick 标记。

### 6.2 D2：vitest 移出 build 关键路径

- 把 `qa-ui-auto-entry.yml` 里 `Frontend behavior unit regressions` 步骤（全量 vitest + Python 单测 + `pnpm check:refactor`）从 build operation 移到 platforms workflow 的一个独立并行 job（例如 `frontend-contracts`，Linux 单 runner，与 build-* 并行，只在有 native 构建或 scope 非 selected 时跑——沿用现有 tool-contracts 的 scope 条件，避免 selected 小 run 重复付费；取舍见 O3）。
- build job 只保留 `cargo fmt --check`（0.1 分钟）作为前置门。
- `summarize` 的 needs 增加 `frontend-contracts`，其失败仍计入汇总失败；但 execute 不再等它。
- 验收：build-linux job 耗时下降约一个 vitest 的量（11–26 分钟）；vitest 失败时 execute 已跑出的 case 结果仍保留，summarize 正确判失败。

### 6.3 D3：release 构建拆分

- 改 `ci_sharding.py` 的 release 扩散规则：release profile 只跟随确实带 `release_build_required` 的 entry，不再扩散到同一平台的全部 entry；`builds` 矩阵按（平台，架构，profile）拆分，debug 与 release 各一个 build。
- plan 层面：当 selection 里只有 TC-WS-054 等少数 release case 时，这些 case 单独走 release build + release entry，其余 case 走 debug build。`ci_native_artifact.py` 的 identity 校验已按 profile 区分，无需放松。
- 若某平台的 release entry 只有一个 case，仍允许 `shards=1`；不为 release 单独加分片。
- 验收：不含 release case 的 selected run，三平台 build id 均为 `-debug`；含 TC-WS-054 的 run，debug 与 release build 并存且各自的 binary identity 校验通过。

## 7. P1 详细设计

### 7.1 D4：跨运行 runtime 复用

现状：`native_build.build_qa()` 已有 `check_build()` 复用判断（源码、recipe、工具链、环境一致则直接复用），但复用只在**同一 runner 的 actions/cache 恢复命中**时才成立；新 commit 必然重编，同 commit 反复 dispatch 也常因缓存未命中而重编（R5）。

- Build 产物改用确定性 artifact 名：`runtime-<platform>-<arch>-<profile>-<source_sha256 前 16 位>`（`source_sha256` 即 `provenance.source_identity()`，它只覆盖 `src/`、`src-tauri/` 等应用源码，**不含** `qa-ui-auto-tests/` 与 QA 脚本，所以只改 case YAML 时源码哈希不变）。
- build job 开始时先用 `actions/download-artifact`（或 `gh api` HEAD）查该确定性 artifact 是否存在：存在则下载、走 `ci_native_artifact.install()` 的全部校验（manifest、文件 SHA、binary identity、selection 绑定），校验通过即跳过编译；不存在才编译，编译后除现有 per-run artifact 外再上传一份确定性 artifact（保留期 7 天，与现有 runtime artifact 的 3 天区分）。
- 复用命中时 build job 的 `Build and export` 步骤应降为约 1 分钟（下载 + 校验）；未命中时行为与现状完全一致。
- 存储上限：3 平台 × 2 profile × 每天若干 commit，artifact 总量需监控；保留期到后由 GitHub 自动清理；不得把确定性 artifact 当作绕过源码变化的手段——`install()` 的 `identity.source_sha256` 校验是强制项，改源码必换哈希。
- 验收：同一 commit 第二次 dispatch 同平台 build job ≤ 3 分钟（含下载校验），且 `ci-summary.json` 的 build hash 与第一次一致。

### 7.2 D5：缓存治理与构建加速

- 先核查再动手：连续 5 个 run，记录 `Native QA workspace cache` 与 `swatinem/rust-cache` 的命中/未命中（step 日志里有 cache hit 标记）与恢复耗时，确认 R5 是“未命中”还是“命中但增量仍慢”。若是前者，优先修 key：`build_inputs` 里的 `platform.platform()` 会随 runner 镜像内核变化，应改为只取 OS/架构/工具链版本，排除内核小版本。
- 备选：build job 接 sccache（`SCCACHE_GHA_ENABLED` + `actions/cache` 存 sccache 缓存），Rust 增量编译跨 run 复用；或 build job 换 8 核 runner（仅 build job，不扩大全 run）。两者都先在单个平台试点，用 3 个 run 的 build 耗时对比决定是否推广。
- 前端构建：`pnpm tauri build` 每次都会跑 `pnpm build`（vite）；核查 `dist/` 是否可随源码哈希缓存，命中时跳过 vite 构建（需保证 `tauri.conf.json` 的 `beforeBuildCommand` 仍被满足，跳过只能发生在复用路径，不得改生产构建命令）。

### 7.3 D6：plan 提速

- `audit --gate`（约 2 分钟）是安全门，**不能跳过**；提速方向是减少重复工作：`make_plan` 里全量 `discover()` + 全量依赖 DAG 校验只在 `qa-ui-auto-tests/`、`qa-ui-auto-tests/ci/`、`.agents/skills/qa-ui-auto/` 变化时全量跑，否则允许用上一次同 commit 的 catalog 校验结果缓存（key = 上述目录的 git tree 哈希）。改动只影响 plan job 内部，不影响 selection 内容。
- `test_crash_regressions`（约 1.5 分钟）只在 crash 套件实际被选中时跑；quick 且跳过 crash 时跳过。
- 验收：plan job 在 case-only 改动时 ≤ 2 分钟；selection.json 内容与改动前逐字节一致（除 run_id/attempt 外）。

## 8. P2 详细设计

### 8.1 D7：release 全量构建挪到 nightly

- schedule（`17 19 * * *`，scope=all）保留 release 全量；PR 与 dispatch 默认只编 debug，除非 selection 含 release-required case（D3 已覆盖该分支）。
- 夜间失败仍走现有 `publish-issues` 去重 issue 通道；白天 dispatch 不再为 release 付费。

### 8.2 D8：dispatch 并发组

- 给 workflow_dispatch 的 run 加 `concurrency: group: qa-ui-auto-dispatch-<ref>，cancel-in-progress: true`，仅 dispatch 生效，PR/schedule 不受影响。后一次 dispatch 取消同一 ref 上正在跑的前一次，避免一天 20 个 run 互相排队。
- 风险：用户可能有意并行跑两个不同 selection 的 run；分组键按 ref 而非全局，且取消只发生在同一 ref 上，可接受（见 O4）。

## 9. 预期收益汇总

以“1 个 linux native case、quick 预设”为例（均为估算，以实施后实测为准）：

| 环节 | 现状 | P0 后 | P0+P1（同 commit 第二次跑）后 |
| --- | --- | --- | --- |
| plan | 4–6 分钟 | 约 2 分钟（D6） | 约 2 分钟 |
| build-linux | 51.8 分钟（vitest 25.6 + 编译 24.3） | 约 10–15 分钟（D2 移走 vitest；D3 改 debug） | 约 1–3 分钟（D4 命中复用） |
| 其余平台构建 | 36.2 分钟（macOS）等 | 0（D1 单平台） | 0 |
| execute | 约 6.5 分钟 | 约 6.5 分钟 | 约 6.5 分钟 |
| 排队 | 不定（多 run 并行时） | 减少（D8） | 减少 |
| **Wall time 合计** | **约 75 分钟** | **约 20 分钟** | **约 12 分钟** |

Browser-only 验证现状已约 10–15 分钟（plan + execute-browser），D1 后不变，主要是少付 native 构建的钱。

## 10. 风险与取舍

- quick 跳过 crash 套件会漏掉回归信号：缓解是显式标注 + 不进 required check + 正式 PR 仍全量；quick 只用于“先看我的 case 通不通”的迭代。
- debug 构建测不出 release 才有的问题（如 TC-WS-054 的性能预算）：缓解是 D3 只把 release case 拆出来单跑，不是不测；夜间全量仍是 release。
- 确定性 artifact 复用若校验放松，等于用旧二进制测新源码：缓解是复用 `install()` 的全部校验，不新增任何绕过路径；命中条件只认源码哈希，不认 commit message 或分支名。
- vitest 并行化后，失败反馈变慢（以前 build 失败即停，现在 execute 可能已跑完）：缓解是 summarize 仍判失败；vitest 失败不再阻塞“先看到 case 结果”这一 quick 诉求，符合 D1 的定位。
- 更大 runner 与 sccache 都有费用/存储成本：先试点、拿 3 个 run 的数字再决定，不直接全量上。

## 11. 待裁决事项

| ID | 问题 | 推荐 | 需谁定 |
| --- | --- | --- | --- |
| O1 | quick 是否允许跳过 crash 套件？若不允许，D1 的收益只剩单平台，约 75 → 45 分钟 | 允许跳过，但显式标注 + 不进 required check | 用户 |
| O2 | TC-WS-054 等 release case 在 quick 下是单跑 release、还是随 quick 一起跳过？ | quick 下单跑 release（D3），保证 crash 专项的 release 覆盖不断 | 用户 |
| O3 | vitest 移出 build 后，selected 小 run 是否还要跑全量 vitest（并行 job）？ | selected 下跳过全量 vitest，改由 PR/夜间跑；build job 只留 cargo fmt | 用户 |
| O4 | dispatch 并发组是否开 cancel-in-progress？ | 开，但只按 ref 分组 | 用户 |
| O5 | 更大 runner / sccache 是否接受额外费用？ | 先在 Linux build 单点试点 3 个 run 再定 | 用户 |
| O6 | 确定性 artifact 的保留期（建议 7 天）与命名是否接受？ | 接受 7 天；命名含源码哈希前缀 | 用户 |

## 12. 实施计划与验收

分三批，每批独立可回滚（只改 workflow/脚本，不改 case）：

- 第一批（P0）：D1 quick 预设 → D2 vitest 并行 → D3 release 拆分。每项落地后各跑 2 个 dispatch run（1 个 linux native 单 case + 1 个三平台 smoke），记录 wall time 与各 job 耗时，对照 §2 基线；任一项回退都不影响其他两项。
- 第二批（P1）：先做 D5 的缓存命中率核查（只读日志，不改代码），再按核查结果做 D4 复用与 D5 加速；D6 plan 提速最后做。每项验收标准见各节。
- 第三批（P2）：D7 + D8，观察一周夜间与 dispatch 排队情况。

回滚：每项改动都是 workflow/脚本层的独立提交，`git revert` 即可；确定性 artifact 即使残留也不会被旧 workflow 使用（旧 workflow 只认 per-run 名）。

## 附录 A：关键文件清单

- `.github/workflows/qa-ui-auto-platforms.yml`：触发、scope 默认、QA_TAGS 强制 crash、plan/build/execute/summarize 的 needs 关系。
- `.github/workflows/qa-ui-auto-entry.yml`：entry job；Frontend behavior unit regressions、Native QA workspace cache、Build and export the verified native runtime 各步骤。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py`：`make_plan()`（全量 discover、policy catalog 校验、依赖 DAG、capabilities 里的 release 判定）。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci_sharding.py`：`schedule()`（shards=auto 的扇出、release 向同平台扩散、build 矩阵生成）。
- `.agents/skills/qa-ui-auto/scripts/native_build.py`：`build_qa()` / `check_build()` / `build_inputs()`（复用判断、inputs 含 `platform.platform()`）。
- `.agents/skills/qa-ui-auto/scripts/ci_native_artifact.py`：`export()` / `install()`（runtime tarball 的 manifest 与 identity 绑定）。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/provenance.py`：`source_identity()`（只覆盖应用源码，不含 case YAML 与 QA 脚本）、`runner_identity()`。
- `qa-ui-auto-tests/ci/policy.yaml`：835 个 case 的 catalog；smoke 29 个。
- `qa-ui-auto-tests/ci/durations.json`：分片权重（baseline_run 38133668943）；单 native case 多为 3–30 秒，个别 135–250 秒。
- `qa-ui-auto-tests/ci/crash-regressions.md`：crash 专项的覆盖要求与“失败/未执行/旧二进制都不能算通过”的规则。

## 附录 B：证据 runs

- Run #2014（44899963744，2026-11-21 11:37 UTC，dispatch，75.4 分钟，failure）：§2.2–2.4 的 job/step 分解来源。
- Run #2015（44904055836，12:28 UTC，dispatch，59.7 分钟，failure）、#2013（44899423260，11:30 UTC，53.1 分钟）、44897480656（85.8 分钟）、44894455514（111.6 分钟）：§2.1 的 wall time 范围来源。#2015 的 dispatch 分支 workflow 与 main 有差异，其 job 级数字仅作波动参考。
- PR runs 44896462720（82.9 分钟）、44896291767（79.8 分钟）：PR 同样付全量构建成本的证据。
