# qa-ui-auto-platform 构建提速设计

## 1. 目标、状态与范围

本设计解决 `QA UI Auto Platforms`（`.github/workflows/qa-ui-auto-platforms.yml`，以下简称 platforms workflow）构建越来越慢的问题，重点是**少量 case 验证**场景：只改一两个 case、只想在单个平台上验证时，当前一次 run 也要 50 分钟以上，其中跑 case 本身只占几分钟；同时降低 PR 与日常全量/回归验证的墙钟时间与 runner 浪费。

- 来源与修订记录：
  - 2026-11-21（基线 `e439e9d20`，origin/main，Merge PR #845）：用户要求调研 workflow 构建变慢的原因并给出更高效的方案，形成初版设计稿。
  - 2026-11-22（对照 `bf7ee6818`，origin/main，Merge PR #859 代码逐项评审修订）：对照现行 workflow、规划/分片/构建/收集脚本、Cargo 配置及 CI 合约单测修正初版误判与方案漏洞，补充本地 profiling 实测。
- 设计状态：**设计定稿（评审修订版，O1–O6 已决议，见 §11），未实施**。本文只写方案，不改 workflow、脚本、case、policy 或文档门禁；实施按 §12 分批推进。
- 范围：
  - Workflow 与 composite action：`.github/workflows/qa-ui-auto-platforms.yml`、`.github/workflows/qa-ui-auto-entry.yml`、`.github/actions/qa-runtime/action.yml`、`.github/actions/qa-download-artifact/action.yml`。
  - `qa_ui_auto` 规划/解析/分片/构建/产物/聚合脚本：`ci.py`、`ci_sharding.py`、`native_build.py`、`ci_native_artifact.py`、`provenance.py`、`ci_collect.py`、`audit.py`、`testcase.py`、`lint.py`、`control_coverage.py`。
  - 关联与契约同步：`.github/scripts/modular_gate_runs.py`（`qa-modular-gates.yml`）、`AGENTS.md`、`qa-ui-auto-tests/ci/crash-regressions.md`，以及 CI 合约单测 `test_crash_regressions.py`、`test_ci_build_pipeline.py`、`test_ci_native_artifact.py`、`test_ci_sharding.py`。
  - 约束：不动 case 语义、不放宽证据契约（selection manifest、runner receipt、binary identity 校验）、不放宽“失败/跳过不能自动改绿”的原则。

## 2. 实测数据

云端数据来源：2026-11-21 GitHub Actions API（workflow `qa-ui-auto-platforms.yml` 的 runs/jobs，UTC 时间）。本地 profiling 数据来源：2026-11-22 在 `bf7ee6818` 上对规划与解析脚本的实测。

### 2.1 Wall time：一次 run 普遍 50–85 分钟

当天拉取的 20 个 run 里，15 个正常跑完的 dispatch / PR run wall time 为 51.9–111.6 分钟，中位约 75 分钟；另有 2 个 4–7 分钟的 run 是早期快速失败，3 个 cancelled，不计入。同一时段另有 5 个 dispatch run 同时处于 `in_progress`/`queued`，互相排队。

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
| Frontend behavior unit regressions（`pnpm exec vitest run` 全量 + 30+ 个 Python/Node 合约单测 + `pnpm check:refactor`） | **25.6 分钟** |
| Build and export the verified native runtime（`ci_native_artifact.py` → `pnpm tauri build --no-bundle`） | **24.3 分钟** |
| Linux native and service dependencies（`ci_linux_setup.sh`） | 0.7 分钟 |
| qa-runtime（pnpm install + pip install，均命中缓存） | 0.3 分钟 |
| Native QA workspace cache（`actions/cache` 恢复 `src-tauri/target/qa-ui-auto`） | 0.0 分钟 |
| 其余（含 rust-cache 恢复 0.1 分钟、`cargo fmt`） | 约 0.9 分钟 |

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

### 2.6 本地 Profiling 补充证据（基于 `bf7ee6818`）

- 仓库规模：`qa-ui-auto-tests/cases/` 共 **845 个** `.testcase.yaml` 用例（`e439e9d20` 时为 835 个），`feature-list.md` 共 **129 个** feature，`src/` 与 `mobile-web/` 下共 **874 个** `*.test.*` 文件（`e439e9d20` 时为 827 个）。`crash-regression` tag 共 **27 个**用例（5 个 browser-only、9 个 native-only、13 个双模式，即 22 个含 native）；带 `release_build_required` fixture 共 **16 个**用例，其中只有 `TC-WS-054` 同时带 `crash-regression`。
- 用例解析耗时：当前 `qa_ui_auto.testcase.discover()` 解析 845 个用例耗时 **15.26 秒**；在保留全部 JSON Schema 与 `behavior_contract` 校验语义的前提下，仅将 `yaml.safe_load` 切换为当前环境已可用的 C 扩展 `yaml.CSafeLoader` 并复用单个 `Draft202012Validator` 实例，耗时即降至 **5.32 秒**（提速约 2.9 倍）。其余阶段单次调用耗时：`source_identity()` **0.65 秒**、`runner_identity()` **0.10 秒**、`load_features()` **1.21 秒**。
- 同进程重复解析：
  - `audit.py::build_audit()`（`audit --gate`）单次运行对全部 845 个用例重复执行了 **7 遍**解析校验（`lint_cases` 1 遍 + `_check_health`/`warn_selector_orphans` 1 遍 + `build_matrix` 2 遍 + `_collect_gaps`/`build_coverage` 1 遍 + `_collect_orphan_gaps` 1 遍 + `_gate` 1 遍），并重复调用 `load_features()` 7+ 次。
  - `test_crash_regressions.py` 单次运行对全部 845 个用例重复执行了 **6 遍**解析（1 次 `discover()` + 5 次 `make_plan()`）。
- 现行 debug 规划行为：本地执行 `make_plan(scope='selected', platforms='linux', modes='native', case_ids='TC-NATIVE-CORE-001', native_release=False)` 耗时 **17.33 秒**，规划产出已经是 `builds=['native-build-linux-x64-debug']`、`entries=['linux-native']`——验证了不并入 `crash-regression` 时，现行规划器对普通单 case 本就默认走 debug 构建。

## 3. 根因分析

| ID | 根因 | 依据 |
| --- | --- | --- |
| R1 | 默认就是全量：dispatch 默认 `platforms=linux,windows,macos`、`modes=browser,native`、`shards=auto`，不手动收窄就编 3 个平台的包 | `qa-ui-auto-platforms.yml` `workflow_dispatch` inputs 默认值 |
| R2 | 强制 crash 套件：PR、`selected`、`impacted` 都会自动并入 `crash-regression` tag（27 个 case，22 个含 native）。只验 1 个 browser 或普通 native case 也会触发三平台 native 构建 | `qa-ui-auto-platforms.yml` `QA_TAGS` 表达式；`test_crash_regressions.py`；`crash-regressions.md` |
| R3 | crash 套件拉起全平台 release 构建：`TC-WS-054` 带 `release_build_required`，`ci_sharding.py::schedule()` 在两处做 release 扩散（entry 内分片扩散 L94–95；同平台+架构跨 entry 扩散 L102–105）。此外 `crash-regressions.md` 明确规定 `TC-MOBILE-013`、`TC-TAO-HOME-002` 等需在 `native/release` 下验证。注：不带 `crash-regression` 且 `native_release=false` 时，普通单 case **现行已走 debug** | `TC-WS-054-*.testcase.yaml`；`ci_sharding.py` L94–95, L102–105；`crash-regressions.md`；§2.6 实测 |
| R4 | 全量前端单测串行挡路：`build-linux` 内 `Frontend behavior unit regressions` 在单 runner 上跑全部 874 个前端测试文件（11–26 分钟，未分片），同时捆绑了 30+ 个 Python/Node 合约单测（多半不在 `tool-contracts` 中）和 `pnpm check:refactor`，全部跑完才开始编译 Rust | `qa-ui-auto-entry.yml` L75–84；`vitest.config.ts`；`src/` 与 `mobile-web/` 测试统计 |
| R5 | **10 GB 缓存配额驱逐 + 源码哈希/环境键抖动**导致新 commit 或跨分支频繁冷编：`qa-ui-auto-entry.yml` 把 `swatinem/rust-cache@v2` 设为 `cache-targets: false`，改用裸 `actions/cache@v4` 缓存未裁剪的整棵 `src-tauri/target/qa-ui-auto`（含 `incremental/`、历史 `.rlib`、两套 `qa-native-v1`/`qa-contracts-v1`、`Cargo.toml` `staticlib`/`cdylib` 重复产物）。3 平台 × 多分支 × 每天 ~20 run 极易打爆 GitHub 仓库 **10 GB 缓存上限**引发全库 LRU 驱逐（Run #2014 恢复耗时 0.0 分钟）；同时 `build_inputs()` 含随内核小版本变化的 `platform.platform()`，且 `provenance.py::source_input()` 把 `src/**/*.test.ts(x)` 也计入 `source_sha256` | `qa-ui-auto-entry.yml` L108–116, L302–324；`native_build.py` L131；`provenance.py` L48–53；`src-tauri/Cargo.toml` L22 |
| R6 | `plan` 耗时 4–6 分钟（重复解析 + 串行扫描 + 全量 git clone）：`testcase.py` 与 `lint.py` 每校验 1 个 YAML 就重读磁盘 schema 并新建 `Draft202012Validator`，且用纯 Python `yaml.safe_load`；`audit.py` 同进程 7 遍解析全量 case 与多次 `load_features()`；`test_crash_regressions.py` 6 遍全量解析；`control_coverage.py` 精确匹配做 O(N×M) 线性扫描；`plan` job 无条件 `fetch-depth: 0` 且未缓存 `pip` | `testcase.py` L58–59；`lint.py` L46–47；`audit.py` L469–511；`test_crash_regressions.py` L31–76；`control_coverage.py` L424–438；`qa-ui-auto-platforms.yml` L238–246 |
| R7 | 并发排队：一天 ~20 次 run 互相排队；macOS 执行限制 `max_parallel: 2`；且 `qa-modular-gates.yml`（`modular_gate_runs.py`）会在同一 `source_ref` 上连续派发 2 个 `qa-ui-auto-platforms.yml` run（`ubuntu-24.04-xvfb` 与 `ubuntu-26.04-wayland`） | 当天 runs 列表；`qa-ui-auto-platforms.yml` L345；`modular_gate_runs.py` L61–82 |
| R8 | 执行端分片无时长门槛：`ci_sharding.py` L65 对 `selected + native` 无条件按 `min(limit, len(units))` 扇出到最多 4 台 VM，即使只有 2–4 个几秒钟的短 case，每片仍要付约 2.5 分钟环境准备成本 | §2.4；`ci_sharding.py` L65 |
| R9 | `qa-ui-auto-entry.yml` build 与 run 互相冗余安装工具，且 Windows 合约测试耦合在 build 路径中：Windows `build` 仍安装 `edgedriver`、`tesseract`（带 3 次重试）、`procdump` 和 WinSDK Debuggers；macOS `build` 仍装 `tesseract`；Windows `run` 仍装 `strawberryperl`；macOS `run` 仍装 `rust-toolchain`；非 `updater` 的 native `run` 仍通过 `qa-runtime` 跑 `pnpm install`（`ci_execute.py` native 模式不启 Vite）；`Windows capture helper contracts` 在 `build` 里运行 `cargo test --bin sockscap-helper` | `qa-ui-auto-entry.yml` L103–172, L198–204, L373–391；`qa-runtime/action.yml`；`ci_execute.py` L178–224 |

## 4. 设计目标与非目标

### 目标

- G1：少量 case 验证（1–3 个 case、单平台、单模式，**仍并入 crash-regression 套件**）的 wall time 从约 75 分钟降到：native 首次约 **22–33 分钟**（需编译 linux release），同源码或只改 case/QA 脚本的二次验证（命中 runtime 复用）约 **10–12 分钟**；browser-only 约 **6–9 分钟**。
- G2：PR 与全量/夜间 run 的 wall time 明显缩短（关键路径不再被 `vitest` 串行、`plan` 重复解析和无谓重编拖慢），且不降低任何门禁覆盖与证据强度。
- G3：每一次提速都有可复核的 run 计时与缓存命中日志作证据，不凭感觉宣布“变快了”。
- G4：quick 路径的降级（单平台、非合入证据）是显式的、机器可读的，且其 check 名称与正式 `qa-ui-auto-platforms-result` 不同，不悄悄削弱 PR/合入门禁语义。

### 非目标与硬性不变量

- 不改 case 语义、skip/gap 契约、selection manifest 与 runner receipt 的证据绑定。
- **保持单平台、单 profile、单构建不变量**：不在同一次 run 中同时为同一平台编译 debug 与 release 两套产物（见 §8.3 废弃记录）。
- 不把 quick 结果作为分支保护 required check：quick run 的汇总 job 名称带 `-quick` 后缀，不会满足 `qa-ui-auto-platforms-result`；quick **不跳过 crash-regression**，但只覆盖选定的单平台，因此仍不构成合入证据。
- 不引入自建 runner 常驻机（不在本设计内决定）。

## 5. 方案总览

分三批落地，P0 完全不改门禁语义即可惠及所有场景（含 PR 与全量）；P1 解决少量 case 快速验证与跨 run 复用；P2 为基于实测数据的深度调优与受控并发。

| 阶段 | 编号 | 改动 | 预期收益 | 风险 |
| --- | --- | --- | --- | --- |
| P0 | D1 | 代码级消除 `plan` 重复解析（`CSafeLoader` + 单例 Validator + `audit.py` 去重 + dict 索引 + `fetch-depth: 1` + `pip` 缓存） | `plan` 4–6 → **≤ 1 分钟**（case-only 改动同样生效） | 低（不跳过任何校验，纯等价加速） |
| P0 | D2 | `Frontend behavior unit regressions` 移出 `build-linux`，变为并行 job `frontend-contracts` 并按 4 分片跑 `vitest` | `build-linux` 减 25.6 分钟；PR 前端测试墙钟 25.6 → **~6–7 分钟** | 需修正 PR 触发条件、补全 Python/Node 合约与日志、更新 `test_ci_build_pipeline.py` |
| P0 | D3 | 清理 `qa-ui-auto-entry.yml` build/run 冗余安装 + R8 给 `selected + native` 加时长分片阈值 | 各平台 build/run 省 1–3 分钟；短 selection 不再虚开 4 台 VM | 需保留 `tauri-driver` 缓存未命中时的 toolchain 兜底；更新 `test_ci_sharding.py` |
| P1 | D4 | 在 `qa-ui-auto-platforms.yml` 增加 `quick` 开关（不新建 workflow）：默认单平台 linux + native、`scope` 自动落到 `selected`；**保留 crash-regression**；汇总 job 名称加 `-quick` 后缀 | 省去另两平台构建（macOS 36 分钟不再在关键路径），首次约 **22–33 分钟**；browser 约 **6–9 分钟** | 默认值需改空以区分“未填”；须同步 `test_crash_regressions.py`、文档与机器字段 |
| P1 | D5 | 10 GB 缓存治理：`rust-cache` 开 `cache-targets: true` 并移除裸全量 `target` 缓存 + 稳定 `build_inputs` 系统标识 + 独立缓存 `sherpa-onnx` | 消除 10 GB 缓存驱逐、稳定增量编译下限 | 需先连续观测 5 次 run 验证命中率与缓存体积 |
| P1 | D6 | 跨 run 轻量 runtime 复用（`source_sha256 + recipe_sha256` 定名、两层导出/校验、剥离 Windows `sockscap-helper`） | 同源码或 **仅改 case YAML/QA 脚本的新 commit** 编译 24 → **1–3 分钟** | 须防跨分支 artifact 投毒，首选分支隔离的 `actions/cache` |
| P2 | D7 | 编译/链接深度优化试点：`lld`/`mold`、`Cargo.toml` `crate-type` 审计、release incremental、`sccache`（配 `CARGO_INCREMENTAL=0`）、8 核 runner 试点 | 进一步压低冷编与增量编译耗时 | 需成本/兼容性 A/B 试点 |
| P2 | D8 | 仅 quick 路径开启的并发组：同 `ref + head + platforms + modes + case_ids` 的 quick dispatch 才互相取消；其他事件与非 quick 用唯一 group（`run_id`），永不被取消 | 减少人工反复重试的排队堆积 | 表达式写错会误取消非 quick run，须单测/`actionlint` 校验 |

> 说明：初版设计中的 **原 D3（同 run 拆 debug+release 双构建）** 与 **原 D7（release 全量挪 nightly）** 经代码评审已否决废弃，原因见 §8.3。

## 6. P0 详细设计（零门禁降级、全场景受益）

### 6.1 P0-D1：`plan` 提速（消除重复解析，不加缓存跳过门禁）

初版曾拟对 `audit --gate` 按目录 tree 哈希加缓存，但最核心的“只改一两个 case”场景必改 `qa-ui-auto-tests/` 目录哈希，导致该缓存命中率为 0；且本地实测表明，真正拖慢 `plan` 的是同进程 7×/6× 重复解析与低效校验器构造。

- `testcase.py` 与 `lint.py` 提速（保持 Schema 与 `behavior_contract` 校验完全等价）：
  - 在模块级（或单次扫描内）读取 `testcase.schema.json` 并缓存单个 `jsonschema.Draft202012Validator` 实例，不再每读一个文件重读 JSON 并重建 Validator。
  - 优先使用 `yaml.CSafeLoader`（当前 CI Python 3.12 + `pyyaml==6.0.2` 环境已验证可用，不存在时回退 `yaml.SafeLoader`）。仅这两项即可把 `discover()` 845 个用例从 **15.26 秒降至 5.32 秒**。
- 消除 `audit.py::build_audit()` 的 7 遍重复解析：
  - 给 `lint_cases()`、`build_coverage()`、`build_matrix()`、`warn_selector_orphans()` 增加可选的预加载参数 `cases=None, features=None`（保持无参外部签名向后兼容）。
  - 在 `build_audit()` 内部只调用 **1 次**解析得到 `cases` 与 `features`，依次传给 `_check_health`、`_collect_gaps`、`_collect_orphan_gaps`、`_gate`；若 `lint_cases` 在解析过程中同时收集已校验对象，甚至可免去紧接着的 `discover()` 二次读盘。
- 消除 `control_coverage.py` 精确匹配的 O(N×M) 线性扫描：
  - 在 `build_coverage()` 中为精确匹配建立 `dict[str, tuple[str, str]]`（遇到重复精确 selector 时保留原排序首命中行为），仅未精确命中时才退回派生前缀扫描。
- 消除 `test_crash_regressions.py` 的 6 遍全量解析：
  - `make_plan()` 支持可选传入预加载的 `cases=None, features=None`（默认 `None` 保持原 CLI/测试兼容），`test_crash_regressions.py` 在 `setUpClass` 阶段共享同一份 `discover()` 与 `load_features()` 结果，不再在 6 个子测试场景中反复解析 845 个 YAML。
- `plan` job Git 与 pip 准备提速：
  - `actions/checkout@v4` 仅在 `scope == 'impacted'`（含未显式传 scope 的 PR，如需 diff；或由 workflow 表达式判断）需要 `fetch-depth: 0`；`smoke` / `selected` / `all` 改为 `fetch-depth: 1`。
  - `plan` 与 `summarize` 的 `actions/setup-python@v5` 增加 `cache: pip`（`cache-dependency-path: .agents/skills/qa-ui-auto/requirements-ci.txt`）。
- **验收**：`plan` job（含 `audit --gate` + `test_crash_regressions` + `make_plan`）在 **case-only 改动** 下从 4–6 分钟降到 **≤ 1 分钟**；`selection.json` 内容（除 `run_id`/`attempt` 外）与改动前逐字节一致。

### 6.2 P0-D2：`vitest` 移出 build 关键路径并分片并行

- 将 `qa-ui-auto-entry.yml` 中 `Frontend behavior unit regressions`（第 75–84 行）从 `build` operation 移出，在 `qa-ui-auto-platforms.yml` 中新增独立并行 job `frontend-contracts`（`runs-on: ubuntu-24.04`，`needs: plan`）。
- **必须修正触发条件（防止误伤 PR 与 quick 击穿）**：
  - 注意 PR 事件下 `inputs.scope` 为空字符串 `''`（在 `plan` 内部才映射为 `QA_SCOPE=selected`），因此绝不能用 `plan` 输出或 `QA_SCOPE != 'selected'` 来判断跳过，否则会漏掉所有 PR 的全量前端单测。
  - 正确触发条件：`github.event_name == 'pull_request' || github.event_name == 'schedule' || (inputs.scope != 'selected' && !inputs.quick)`。注意 PR 事件下 `inputs.quick` 为空，等价 false，PR 不受影响。
  - `selected`（以及 quick）人工验证仅通过 `plan`/`execute` 拿用例反馈，不再被 25 分钟的前端全量单测拖住；PR 与夜间全量则强制执行。
- **Vitest 分片 + 完整保留原有合约与日志**：
  - 将 `frontend-contracts` 拆为 4 个分片或矩阵（如 `shard: [1, 2, 3, 4]`）：
    - 分片 1..4 各自执行 `pnpm exec vitest run --shard=${{ matrix.shard }}/4`（把 874 个文件的 PR 墙钟耗时从 11–26 分钟压到 **~6–7 分钟**，否则一旦编译提速，25 分钟的单 job `frontend-contracts` 会成为新瓶颈）。
    - 分片 1（或单独轻量 `frontend-extra-contracts`）必须完整保留原步骤第 79–83 行的全部非 Vitest 校验：`test_browser_vault_first_run` 等 9 个 Python 单测、`test_native_paced_input.mjs` 等 Node 合约、`test_ci_ssh_features` 等 21 个 Python QA 脚本单测（它们**不在** `tool-contracts` 中）、`pnpm check:refactor`、`scripts/terminal-webgl-backport.test.mjs`，并将日志继续归档为 `qa-build-output/frontend-unit-contracts.log` artifact。
- `build-linux` job 内仅保留 `Rust source formatting contract`（`cargo fmt --manifest-path src-tauri/Cargo.toml -p taomni -- --check`，约 0.1 分钟）。
- `summarize` 的 `needs` 增加 `frontend-contracts`，其失败仍计入 `job_results` 并使汇总失败；但 `execute-*` 不再等待它。
- **同步更新自检测试**：更新 `test_ci_build_pipeline.py` 中强断言“该步骤位于 `qa-ui-auto-entry.yml` 且 `vitest` 不分片/仅执行一次”的契约测试（第 17–29 行），改为验证 `frontend-contracts` 在 platforms 中保留完整 Vitest 全分片union、Python/Node 合约、`pnpm check:refactor` 及日志留存，且被 `summarize` 强依赖。
- **验收**：`build-linux` 耗时立即减去完整 Vitest 耗时（11–26 分钟）；PR 场景 `frontend-contracts` 墙钟 ≤ 8 分钟；任一前端测试失败时，case 结果正常出炉且 `summarize` 正确判红。

### 6.3 P0-D3：清理 `qa-ui-auto-entry.yml` 冗余安装 + 修复 R8 分片浪费

1. **按 `inputs.operation` 精确隔离 build 与 run 工具安装**（消除 R9 跨阶段污染）：
   - Windows build Tools step（L121–172）：
     - `strawberryperl` 仅在 `inputs.operation != 'run'` 安装（run 分片不编译 OpenSSL）；
     - `edgedriver`、`procdump`、Windows SDK Desktop Debuggers（`mstsc`）与 `choco install tesseract`（及 3 次重试）仅在 `inputs.operation == 'run'` 安装（build 不跑 WebDriver、不截屏 OCR、不启 `mstsc`）。
   - macOS build dependencies step（L197–204）：
     - `tesseract` 仅在 `inputs.operation == 'run'` 安装（`krb5` 保留在 `operation != 'run'`，run 是否需要动态库按实际二进制依赖确认，若二进制仅 link Homebrew krb5 rpath/dylib 则保留 minimal `krb5` 或已随 `export()` 打包的 `src-tauri/frameworks/`）。
   - Rust toolchain（L103–104）：
     - 将 `dtolnay/rust-toolchain@stable` 限定为 `matrix.mode == 'native' && inputs.operation != 'run'`。**边界保护**：Linux/Windows 的 `Native adapter`（L215–225）仅在 `tauri-driver` 缓存未命中时才回退运行 `cargo install tauri-driver`，应仅在该分支缺失 `cargo` 时按需准备或改用预编译包/独立缓存，避免为了小概率未命中让每次 `run` 都下载 Rust 工具链。
   - `.github/actions/qa-runtime/action.yml`：
     - 新增可选输入 `install_node_deps`（默认 `true`）；当 `inputs.operation == 'run' && matrix.mode == 'native' && !contains(matrix.capabilities, 'updater')` 时跳过 `pnpm install --frozen-lockfile`（先在实施前复核全量 native case 确认无其他 capability 在 run 阶段调用 `node_modules`）。
2. **修复 R8：`ci_sharding.py` 给 `selected + native` 增加预估时长门槛**：
   - 现状第 65 行在 `scope == 'selected'` 且 `mode == 'native'` 时无条件 `desired = min(limit, len(units))`，导致选 2–4 个各 10 秒的 case 也扇出 4 台 VM（每台付 2.5 分钟环境准备）。
   - 改为按 `durations.json` 预估总耗时做时长感知上限，例如：`desired = min(limit, len(units), max(1, math.ceil(total / 180)))`（仅当总 case 预估超过 3 分钟时才增加分片，兼顾 2.5 分钟固定启动开销）。
   - 同步更新 `test_ci_sharding.py::test_selected_native_fans_out_on_every_platform_without_splitting_dependency`（为测试用例补充相应权重或校验新阈值行为）。
- **验收**：短 selection（总预估 ≤ 180s）只起 1 个 native 分片；build job 不再安装 OCR/WebDriver，run job 不再安装 Perl/不必要工具链，单分片准备时间下降。

## 7. P1 详细设计（少量 case 快速迭代 + 10 GB 缓存治理 + 跨 run 轻量复用）

### 7.1 P1-D4：在 platforms 内增加 `quick` 开关（单平台迭代，不改正式门禁）

不新建 workflow，在 `qa-ui-auto-platforms.yml`（含其 `workflow_call` 输入）增加布尔输入 `quick`（默认 `false`）。quick **不跳过 `crash-regression`**（保持 `QA_TAGS` 现行表达式不变），只收窄平台与模式，其余门禁语义不变。

1. **输入默认值改为可区分“未填”**：现状 `platforms` 默认 `'linux,windows,macos'`、`modes` 默认 `'browser,native'`、`scope` 默认 `'smoke'`，开关打开后无法分辨“没改默认值”与“显式要三平台”。方案：
   - `platforms`、`modes` 的 dispatch 默认改为 `''`；`plan` 步骤中非 quick 回退原默认（`linux,windows,macos` / `browser,native`），quick 回退 `linux` / `native`（用户显式填写则以用户为准）。
   - quick 且提供了 `case_ids`/`features`/`tags` 时，`scope` 自动取 `selected`（避免 `smoke` + 选择器在 `ci.py` L179 报错）；quick 未提供选择器时保持 `smoke`。
   - `shards` 不强制为 1：沿用 `auto`，由 P0-D3 的时长阈值决定（crash 套件使总时长必然超阈值，会合理分片，避免单 VM 串行跑 22 个 native crash 用例）。
2. **构建 profile 的真实行为**：crash 套件含带 `release_build_required` 的 `TC-WS-054`，所选平台的 native 构建仍为 **release**（`ci_sharding.py` 现行 release 扩散保持不变）。quick 的收益来自：单平台（macOS/Windows 构建不再参与）、P0 各项、P1-D5 缓存与 P1-D6 复用，**不来自 debug 构建**。
3. **汇总 job 名称与分支保护**：`summarize` 的 `name` 改为表达式 `qa-ui-auto-platforms-result${{ inputs.quick && '-quick' || '' }}`。dispatch run 的检查会挂在被测 commit 上，若名称相同，绿的 quick（只测单平台）可能被误当作 `qa-ui-auto-platforms-result` required check 通过；加后缀避免这一点。
4. **`publish-issues` 与 artifact 命名**：`publish-issues` 条件追加 `&& !inputs.quick`；`quick` 标记只放在 `qa-summary-quick-<key>`，**不得**放进 `qa-<entry>-<key>`（`ci_collect.py` L11–13 以 `removeprefix('qa-').rsplit('-', 1)[0]` 反推 entry id，改名会使汇总找不到 entry）。
5. **机器可读标记**：`selection.json` 与 `ci-summary.json` 写入 `"quick": true`、`"merge_eligible": false`（单平台覆盖不等于 PR 门禁）；`summary.md` 顶部同步提示。`crash_suite_included` 仍为 true，不再写入降级字段。
6. **文档与测试同步**：更新 `test_crash_regressions.py::test_pr_and_focused_workflow_entries_keep_crash_suite`（断言 quick 仍含 crash-regression、默认 PR 行为不变），并在 `AGENTS.md`（Testing Guidelines）与 `qa-ui-auto-tests/ci/crash-regressions.md`（第 5 行）说明：quick 仅覆盖选定单平台，不能替代三平台 PR 门禁。
- **验收**：1 个 linux native 普通 case 的 quick run 只产生 linux 一套 build 与对应 execute；crash 套件 ID 全部出现在 selection 中；`ci-summary.json` 含 `quick: true`、`merge_eligible: false`；汇总 check 名称带 `-quick`；首次约 22–33 分钟，命中 P1-D6 复用后约 10–12 分钟。

### 7.2 P1-D5：10 GB 缓存治理与构建输入稳定化

1. **先观测再治理（只读统计，连续 5 个 run）**：
   - 在改动缓存前，拉取最近 5 个 run 的 step 日志与 GitHub Actions Cache API（`GET /actions/cache/usage`、`GET /actions/caches`），记录：
     - `Native QA workspace cache`（`qa-native-v1-*`）与 `swatinem/rust-cache` 的 hit/miss 与恢复耗时；
     - 仓库当前总缓存用量是否逼近 10 GB 配额、最老缓存的存活时间（是否数小时内即被 LRU 驱逐）。
2. **双层缓存重构（解除 10 GB 配额打爆）**：
   - **改变现状做法**：现状把 `swatinem/rust-cache@v2` 的 `cache-targets` 设成 `false`，同时又用裸 `actions/cache@v4` 分别缓存 `qa-native-v1` 和 `qa-contracts-v1` 两套完整、不裁剪的 `src-tauri/target/qa-ui-auto`（含巨大 `incremental/` 与旧版 `.rlib`），在跨平台+多分支下极易耗尽 10 GB 限额。
   - **治理方案**：将 `swatinem/rust-cache@v2` 的 `cache-targets` 改为 `true`（由 `rust-cache` 自动清理过期 crate 与无用中间产物，控制单平台缓存体积，并利用其 `shared-key` 跨分支共享 `main` 依赖基线），**移除**裸 `actions/cache@v4` 对整棵 `src-tauri/target/qa-ui-auto` 的全量快照（`qa-native-v1-*` / `qa-contracts-v1-*`）；成品复用改由轻量的 P1-D6 runtime tarball 承担。注：同步评估 `.github/workflows/qa-workspace-performance.yml` 第 85 行对其的引用兼容。
   - 独立缓存 `src-tauri/target/sherpa-onnx-prebuilt`（实测约 157 MB，避免因 Rust cache 失效重复下载/解压）。
3. **稳定 `native_build.py::build_inputs()`**：
   - 将第 131 行 `"platform": platform.platform()`（包含 runner 镜像内核小版本号，镜像微升级即导致 key 抖动）替换为稳定的 OS/架构/基线标识，例如 `f"{platform.system()}-{platform.machine()}"`（Linux 可附带 `/etc/os-release` 的 `VERSION_ID`，如 `22.04`）。
4. **前端构建缓存风险边界**：
   - `tauri.qa.conf.json` 的 `beforeBuildCommand` 为 `pnpm build --mode qa && bash scripts/bundle-krb5-macos.sh stage`。`pnpm build` 除生成 `dist/` 外，还会执行 `pnpm build:mobile` 产出 `src-tauri/resources/mobile-web/`（`src-tauri/build.rs` L246–253 在 release 模式下缺少该目录会直接 **panic**），macOS 还会向 `src-tauri/frameworks/` stage krb5 dylib。
   - 因此不得单独缓存 `dist/` 并跳过 `beforeBuildCommand`；若未来在“同源码重编译”路径缓存前端产物，必须同时覆盖 `dist/`、`src-tauri/resources/mobile-web/` 与 macOS `src-tauri/frameworks/`。

### 7.3 P1-D6：跨运行轻量 runtime 复用（含完整安全与契约设计）

现状 `native_build.build_qa()` 的 `check_build()` 只在同一 runner 磁盘缓存恢复出 `target/qa-ui-auto/<profile>/taomni` 时有效；通过复用仅包含最终二进制、sidecar、资源与 `.qa-identity.json` 的轻量 runtime tarball（不含 `deps/`、`incremental/` 等数 GB 中间文件），不仅**同 commit 二次 dispatch** 可跳过编译，**只修改 `qa-ui-auto-tests/`（case YAML）或 `.agents/skills/qa-ui-auto/`（QA 脚本）的新 commit** 也能直接命中复用。

1. **修正确定性构建键（必须覆盖 `recipe_sha256`）**：
   - `provenance.source_identity(ROOT)` 只覆盖应用源码，**遗漏了** `native_build.py::build_inputs()` 中的 `recipe_sha256`（`.agents/skills/qa-ui-auto/assets/tauri.qa.conf.json` 与 `native_build.py`）和 Linux 构建基线（`ubuntu-22.04`）。
   - 复用键必须为：`runtime-reuse-v1-<platform>-<arch>-<runner_baseline>-<profile>-<source_sha256[:16]>-<recipe_sha256[:16]>`。只改 `tauri.qa.conf.json` 或编译参数必换 key，绝不误用旧二进制。
2. **两层导出/导入契约（不破坏现行 `ci_native_artifact.py` 守卫）**：
   - **现状阻塞**：现行 `ci_native_artifact.install()` 强制校验 `selection_sha256`（含 `run_id`、`attempt`、`selected_ids`、`case_digests`）、`head` 与 `runner_sha256`；且 `test_ci_native_artifact.py::test_wrong_invocation_is_rejected` 专门测试“不同 `run_id` 必须被拒绝”。跨 run 直接喂给 `install()` 会 100% 失败。
   - **两层设计**：
     - **共享层（新增 `export_reusable()` / `install_reusable()`）**：manifest（如 `qa-reusable-runtime.json`）只绑定构建本身的不变量：`schema`、`platform`、`arch`、`runner`、`profile`、`source_sha256`、`recipe_sha256`、`binary`、`files`（路径与 SHA-256 + mode），**不包含** `run_id`、`selection_sha256`、`head`、`runner_sha256`。`install_reusable()` 校验路径白名单、逐文件 SHA-256、以及解包出的 `.qa-identity.json`（`identifier == "com.taomni.app.qa"`、`binary_sha256`、`source_sha256`、`profile`、`build_inputs.recipe_sha256`）完全一致，并保持原始 `.qa-identity.json` 字节不变。
     - **当次 run 绑定层**：`build` job 命中并完成 `install_reusable()` 后，调用现行 `ci_native_artifact.export()` 生成绑定本次 `selection_sha256`、`head`、`run_id` 的 `runtime-<build_id>-<artifact_key>`。所有 `execute-*` 分片继续使用原封不动的 `ci_native_artifact.install()`，现行防串用测试零放宽。
3. **存储方案**：采用 `actions/cache@v4` 存放轻量 runtime tarball（置于 `qa-build-output/reusable-runtime/`，与 `rust-cache` 独立）。GitHub Actions Cache 原生按分支隔离（仅同分支或默认分支 `main` 可恢复，其他 PR 无法反向污染），无需 `permissions: actions: read`，不占用 Artifacts 列表；单平台 runtime tarball 远小于完整 `target/`，对 10 GB 配额压力小。命中后仍须经 `install_reusable()` 的全部校验，缓存本身不被信任。
4. **剥离 Windows build job 中的编译型合约测试**：
   - 现状 `qa-ui-auto-entry.yml` 第 373–391 行 `Windows capture helper contracts` 在 `build` job 尾部执行 `pnpm build:mobile && cargo test --bin sockscap-helper`。
   - 如果 D6 命中复用跳过编译，此时 runner 上的 `src-tauri/target/qa-ui-auto` 为空，这一步会**当场从零重新编译整个 Rust 依赖树**，把 Windows 的复用收益完全抵消！
   - 必须将该步骤（以及第 273–277 行的 `rustc --test atomic_replace.rs` 等合约，或统一将 `sockscap-helper`）从 runtime `build` job 拆出到独立的 `native-contracts` / Windows 合约 job（或仅在未命中复用/PR 时在独立并行 job 运行）。
- **验收**：
  1. 同一 commit 第二次 dispatch 同平台 `build` job 耗时 **≤ 3 分钟**（下载/缓存恢复 + 校验 + 二次导出）；
  2. **仅改 case YAML 或 QA 脚本的新 commit**，在 `head` 变化但 `source_sha256` + `recipe_sha256` 不变时同样命中复用，且 `ci-summary.json` 的 `build_hashes` 与原构建一致；
  3. 改动 `tauri.qa.conf.json` 或 `src/`/`src-tauri/` 任意文件必然换 key 未命中，重新编译。

## 8. P2 详细设计 & 已否决原方案

### 8.1 P2-D7：编译/链接深度优化试点（基于实测数据推进）

在 P1 缓存治理稳定后，针对冷编译与源码变更后的增量编译做单点 A/B 试点（每次取 3 个 run 对照，确认收益再推广）：

- **Linux 链接器与并行**：试点在 Linux QA 构建启用 `lld` 或 `mold` 加速大二进制链接。
- **`Cargo.toml` `crate-type` 审计**：检查 `src-tauri/Cargo.toml` 第 20–22 行的 `crate-type = ["staticlib", "cdylib", "rlib"]`——桌面端可执行文件仅依赖 `rlib`，每次构建额外编译/链接 `staticlib` 与 `cdylib` 既增加耗时又膨胀 `target/` 体积；评估是否仅在真正需要移动端/库产物的构建中按条件启用。
- **Release 增量编译评估**：评估为 `native_build.py --release` 开启 `CARGO_PROFILE_RELEASE_INCREMENTAL=true`（`ci_rust_contracts.sh` 第 18 行已开启）在 `rust-cache` 下的净收益与二进制差异。
- **`sccache` 与更大 runner 试点**：若需试点 `sccache`（`SCCACHE_GHA_ENABLED`），**必须同时设置 `CARGO_INCREMENTAL=0`**（`sccache` 不缓存 incremental 编译单元，否则命中率极低）；8 核 runner 仅先在 Linux build 单点试点 3 个 run 评估投入产出比。
- **`source_input()` 范围评估**：评估 `provenance.py::source_input()`（L48–53）是否需要把 `src/**/*.test.ts(x)` 计入 `source_sha256`（当前改一个前端单元测试也会触发三平台 Rust 重编；需先确认 `pnpm build --mode qa` 的 `tsc -b` 是否通过排除测试文件的 `tsconfig` 做到互不影响，否则测试文件的编译错误仍需触发构建校验）。

### 8.2 P2-D8：仅 quick 路径开启的并发组（保护 `qa-modular-gates.yml`）

- **明确禁止的做法**：不可给 `qa-ui-auto-platforms.yml` 加全局 `concurrency: group: <ref>, cancel-in-progress: true`。`.github/scripts/modular_gate_runs.py`（L61–82）在 `desktop`/`all` suite 下会在同一个 `source_ref` 上连续 dispatch 两个 platforms run（`ubuntu-24.04-xvfb` 三平台与 `ubuntu-26.04-wayland`），按 ref 取消会让第二个 run 杀掉第一个；用户用 `inputs.head` 在同分支验不同 commit 时也会被误杀。
- **采用方案（条件 group）**：在 platforms 的 workflow 级 `concurrency` 中让 group 与取消行为都取决于 quick：
  - `group`：`workflow_dispatch` 且 `inputs.quick` 时为 `qa-ui-auto-quick-<ref>-<head>-<platforms>-<modes>-<case_ids>`，否则为 `qa-ui-auto-${{ github.run_id }}`（每个 run 独占一个 group，永不互相取消）；
  - `cancel-in-progress`：仅 quick 时为 `true`。
  - `qa-modular-gates.yml` 不传 `quick`，行为完全不变；PR 与 `schedule` 同样不受影响。
- 注意 group 字符串长度与特殊字符（`case_ids` 可能很长，必要时取哈希）；实施时用 `actionlint` 与专门单测校验表达式。

### 8.3 已否决/废弃原方案（评审结论留档）

1. **废弃原 P0-D3（同 run 按 case 拆分 debug + release 双构建）**：
   - **对核心场景无收益**：实测（§2.6）表明，不并入 `crash-regression` 的普通单 case 现行已直接走 debug，原设计误把单平台/收窄的收益归到了 D3 头上；而 quick 保留 crash 套件后，所选平台必然仍需一套 release 构建，拆出 debug 构建只会多一份构建。
   - **对 PR / smoke / all 反向变慢且翻倍开销**：只要 selection 含 `TC-WS-054`（PR、`smoke`、`all`、非 quick `selected` 全含），原 D3 会让每平台同跑 **debug + release 两个 build job**（总构建数 3 → **6**）。由于 `execute-*-native` 依赖 `build-*` 完成，debug 分片仍需等最慢的 release 构建结束，关键路径 wall time 一分钟没省；同时算力翻倍、macOS ARM 并发压力翻倍，且多出 3 份多 GB 的 debug 缓存进一步恶化 10 GB 配额驱逐（R5）。
   - **与多处门禁契约冲突**：现行 release 扩散存在 `ci_sharding.py` L94–95 和 L102–105 两处；且 `AGENTS.md`（L53）、`crash-regressions.md`（要求 `TC-MOBILE-013`、`TC-TAO-HOME-002` 等使用 `native/release`）、`test_crash_regressions.py`（L43–53 强断言 22 个 native crash 用例均使用 `release`）均要求整组 crash 套件在 release QA 构建下运行，拆分与现行门禁直接冲突。
2. **废弃原 P2-D7（把 release 全量构建挪到 nightly）**：
   - 现行 `schedule` 触发并未使用 `native_release=true`（`qa-ui-auto-platforms.yml` L261），全量走 release 本来就是靠 `ci_sharding.py` 的扩散拉起的；取消原 D3 后原 D7 即为空操作（若按原 D3 + D7 执行，反而会让 `schedule` 失去全量 release，而 PR 因含 `TC-WS-054` 依然编 release，适得其反）。白天节省 release 编译的正确途径是 P1-D4（quick 单平台）+ P1-D5（缓存治理）+ P1-D6（同源码/case-only 改动复用已验证 release runtime）。

## 9. 预期收益汇总

以典型场景为例（均为基于 §2 基线与局部实测的估算，每列只计入该阶段已落地的项目，最终以 §12 实测对比为准）：

| 环节 | 现状（Run #2014 参考） | P0 后（常规 PR / 3 平台全 crash） | P0+P1 后（quick 首次：1 个 linux native case + crash 套件） | P0+P1 后（quick 命中 D6 复用） |
| --- | --- | --- | --- | --- |
| plan | 4–6 分钟 | **≤ 1 分钟**（P0-D1） | **≤ 1 分钟** | **≤ 1 分钟** |
| 前端单测 | 25.6 分钟（串行在 `build-linux` 内） | **~6–7 分钟**（P0-D2 并行 4 分片，不在关键路径） | 0（quick 不跑） | 0 |
| build-linux | 51.8 分钟（vitest 25.6 + release 24.3） | ~25 分钟（移走 vitest；编译未优化前仍为 release） | **~15–24 分钟**（release 构建 + P0-D3 去冗余 + P1-D5 缓存） | **~1–3 分钟**（P1-D6） |
| 其余平台构建 | 36.2 分钟（macOS） | ~34–36 分钟（P0-D3 去冗余，仍为关键路径） | 0（单平台） | 0 |
| execute | ~6.5 分钟 | ~5–6 分钟 | ~6–8 分钟（crash 套件按阈值分片） | ~6–8 分钟 |
| **Wall time 合计（不含排队）** | **~63 分钟（含排队 75 分钟）** | **~40–43 分钟** | **~22–33 分钟** | **~10–12 分钟** |

- Browser-only quick：无 native 构建，仅 `plan` + browser execute（含 browser 模式的 crash 用例），约 **6–9 分钟**。
- 由于 quick 保留 crash 套件、所选平台仍编 release，首次 quick 不可能达到“≤ 20 分钟”；要接近该值只能依赖 P1-D6 命中复用，或在 P2 试验编译加速（§8.1）。

## 10. 风险与取舍

- **quick 只覆盖单平台，绿灯不等于可合入**：缓解是机器可读标记（`quick: true`、`merge_eligible: false`）、汇总 job 名称带 `-quick` 后缀避免被当作 required check、并在 `AGENTS.md` 与 `crash-regressions.md` 写明“quick 不能替代三平台 PR 门禁”。crash 套件本身不再被降级。
- **selected 跳过全量 vitest 后 PR 仍保持全量**：P0-D2 触发条件显式保证 `pull_request` 和 `schedule` 永远运行 4 分片全量 `frontend-contracts`；`summarize` 失败仍阻断整体通过。
- **跨 run runtime 复用存在键漏算风险**：通过将 `recipe_sha256` 与 runner 基线纳入 key、两层 manifest 强校验 `.qa-identity.json` 与文件 SHA、使用分支隔离的 `actions/cache@v4`、并剥离 Windows `sockscap-helper` 合约编译来消除。
- **条件并发组表达式出错的风险**：group 写错可能让非 quick run 互相取消；以“非 quick 恒用 `run_id`”为兜底，并用 `actionlint` 与单测校验。
- **platforms 输入默认值改空的兼容性**：`qa-modular-gates.yml` 等调用方显式传 `platforms`/`modes`，不受影响；PR/`schedule` 在 `plan` 中回退原默认，行为不变，需单测覆盖。
- **10 GB 缓存重构初期可能触发 1 次冷编**：移除旧的裸全量 `target` 缓存并切换 `rust-cache` `cache-targets: true` 后，首次重建缓存需冷编一次，之后体积减小、不再被频繁驱逐。
- **`audit.py` / `testcase.py` 复用解析对象的等价性**：`CSafeLoader` 与单次加载的只读列表严禁在下游被原地篡改，并在提交前验证改动前后 `selection.json` 与 `audit --gate --json` 输出逐字段一致。

## 11. 决议记录

以下事项已于 2026-11-22 定案；本阶段只完成文档，**不做实施**，实施另行排期。

| ID | 问题 | 决议 | 影响章节 |
| --- | --- | --- | --- |
| O1 | quick 入口形态 | **在 `qa-ui-auto-platforms.yml` 内加 `quick` 开关，不新建 workflow** | §7.1 |
| O2 | 原 D3 / 原 D7 与 quick 是否跳过 crash | **放弃原 D3（同 run 拆 debug+release）与原 D7；quick 不跳过 crash-regression**（因此所选平台仍编 release，收益来自单平台与 P0/P1 其他项） | §7.1、§8.3、§9 |
| O3 | `selected` 是否跳过全量 `frontend-contracts` | **同意跳过**；PR / `schedule` / `all` / `smoke` 保留 4 分片全量，`selected` 与 quick 不运行 | §6.2 |
| O4 | dispatch 并发组 | 因不新建 quick workflow，**改为 platforms 内条件 group**：仅 quick 的 dispatch 按 `ref + head + platforms + modes + case_ids` 互相取消，其余恒用 `run_id` 独占 group，不影响 `qa-modular-gates.yml` | §8.2 |
| O5 | `lld` / `sccache` / 8 核 runner | **同意**：不预先批准，P0 与 P1-D5 完成后按实测再决定 P2 试点 | §8.1 |
| O6 | P1-D6 复用存储载体 | **同意**：采用 `actions/cache@v4`（分支隔离），不使用 GitHub Artifacts | §7.3 |

## 12. 实施计划与验收

分三批，每批独立可回滚；实施前须同步规划受影响合约单测的更新（不采用静默删断言的方式，而是随新架构重绑定守卫契约）。

- **第一批（P0，零门禁变化）**：
  1. **P0-D1（`plan` 去重与提速）**：修改 `testcase.py`、`lint.py`、`audit.py`、`control_coverage.py`、`ci.py`、`test_crash_regressions.py`、`qa-ui-auto-platforms.yml`（`fetch-depth` 与 `pip` 缓存）；本地验证 `audit --gate --json` 与 `selection.json` 出力前后一致，云端 `plan` ≤ 1 分钟。
  2. **P0-D2（`frontend-contracts` 并行化与 Vitest 4 分片）**：修改 `qa-ui-auto-platforms.yml`、`qa-ui-auto-entry.yml` 及自检测试 `test_ci_build_pipeline.py`；运行 1 个 PR / `smoke` 与 1 个 `selected` 验证触发条件、日志留存与汇总判红。
  3. **P0-D3（entry 冗余清理 + R8 分片阈值）**：修改 `qa-ui-auto-entry.yml`、`.github/actions/qa-runtime/action.yml`、`ci_sharding.py` 及 `test_ci_sharding.py`；验证短 selection 只起 1 个分片、`tauri-driver` 冷启动与各平台 build/run 工具完备性。
- **第二批（P1，快速迭代与缓存/复用治理）**：
  1. **P1-D5 前置观测**：连续读取 5 个 run 日志与 GitHub Cache 用量，确认 10 GB 配额驱逐现状后，切换 `rust-cache` `cache-targets: true`、去掉裸全量 `target` 缓存、稳定 `build_inputs()` 平台字符串、独立缓存 `sherpa-onnx-prebuilt`。
  2. **P1-D4（quick 开关）**：修改 `qa-ui-auto-platforms.yml`（输入默认值改空、`quick` 逻辑、汇总 job 名称后缀、`publish-issues` 条件、条件并发组），写入 `quick`/`merge_eligible` 机器字段，同步更新 `test_crash_regressions.py`、`AGENTS.md`、`crash-regressions.md`。验收：1 个 linux native 普通 case 的 quick run 只产生 linux 一套 build、selection 含全部 crash 用例，首次约 22–33 分钟。
  3. **P1-D6（跨 run 轻量 runtime 复用）**：在 `ci_native_artifact.py` 与 `test_ci_native_artifact.py` 落地两层 `export_reusable()`/`install_reusable()`（含 `recipe_sha256`、防投毒校验），剥离 Windows `sockscap-helper` 编译测试出 build 路径。分别用“同 commit 二次跑”和“仅改 1 个 case YAML 的新 commit”验证 `build` ≤ 3 分钟且 `build_hashes` 一致。
- **第三批（P2，按实测决定）**：
  - P2-D7（`lld`/`mold`、`Cargo.toml` `crate-type` 审计、release incremental、`sccache` / 8 核 runner 3 次 run 对照试点、`source_input()` 范围评估）与 P2-D8（quick 条件并发组；若需更早缓解排队，可随 P1-D4 一起落地）。

回滚：每项改动都是 workflow/脚本层的独立提交，`git revert` 即可恢复；两层复用设计保证下游 `execute` 分片与现行 per-run tarball 契约保持兼容，残留缓存/artifact 不会影响回退后的旧 workflow。

## 附录 A：关键文件清单

- `.github/workflows/qa-ui-auto-platforms.yml`：触发、scope 默认、PR/selected/schedule 条件、`QA_TAGS` 强制 crash、plan/build/execute/summarize 的 `needs` 与权限。
- `.github/workflows/qa-ui-auto-entry.yml`：entry job；`Frontend behavior unit regressions`、Windows/macOS/Linux build/run 工具安装、`rust-cache`、裸 `actions/cache`、`Windows capture helper contracts`、runtime 上传。
- `.github/actions/qa-runtime/action.yml` & `.github/actions/qa-download-artifact/action.yml`：通用依赖准备与 artifact 下载重试 action。
- `.github/scripts/modular_gate_runs.py`（`.github/workflows/qa-modular-gates.yml`）：同 `source_ref` 连续双派发 `qa-ui-auto-platforms.yml`，决定 P2-D8 并发组边界。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py`、`ci_sharding.py`、`ci_collect.py`：规划、能力映射、R8 分片扇出、两处 release 扩散、artifacts 还原收集。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/audit.py`、`testcase.py`、`lint.py`、`control_coverage.py`：全量 YAML 解析、Schema Validator 构造、`audit --gate` 7× 重复解析与 O(N×M) 选择器匹配。
- `.agents/skills/qa-ui-auto/scripts/native_build.py`、`ci_native_artifact.py`、`qa_ui_auto/provenance.py`：`build_inputs()` 平台字段、`source_identity()`、`export()`/`install()` 的 invocation 强绑定。
- `.agents/skills/qa-ui-auto/scripts/test_crash_regressions.py`、`test_ci_build_pipeline.py`、`test_ci_native_artifact.py`、`test_ci_sharding.py`：实施 P0/P1 时必须同步评审和更新的 CI 合约自检。
- `src-tauri/Cargo.toml`、`src-tauri/build.rs`、`vitest.config.ts`、`qa-ui-auto-tests/ci/durations.json`、`qa-ui-auto-tests/ci/crash-regressions.md`、`AGENTS.md`。

## 附录 B：证据 runs 与本地基准

- Run #2014（44899963744，2026-11-21 11:37 UTC，dispatch，75.4 分钟，failure）：§2.2–2.4 的 job/step 分解来源。
- Run #2015（44904055836，12:28 UTC，dispatch，59.7 分钟，failure）、#2013（44899423260，11:30 UTC，53.1 分钟）、44897480656（85.8 分钟）、44894455514（111.6 分钟）：§2.1 的 wall time 范围来源（#2015 分支 workflow 与 main 有差异，仅作波动参考）。
- PR runs 44896462720（82.9 分钟）、44896291767（79.8 分钟）：PR 同样付全量构建成本的证据。
- 本地实测（`bf7ee6818`，2026-11-22）：845 用例 `discover()` 15.26s → `CSafeLoader` + 单例 Validator 5.32s；`make_plan(TC-NATIVE-CORE-001)` 17.33s（已自动产出 `native-build-linux-x64-debug`）；`source_identity()` 0.65s；`load_features()` 1.21s。
