# QA UI Auto Platforms 构建提速与托管实测

## 1. 范围与修订

`qa-ui-auto-platforms.yml` 在 PR、定时运行、手工派发与可复用调用中共用规划、构建、执行和汇总。本文记录这些路径的耗时、缓存条件及通过证据。默认三平台为 Linux、Windows、macOS，模式为 browser 和 native。原有单平台专用开关、检查名后缀和顶层自动取消规则已移除。

- 2026-11-21 以 `e439e9d20` 调研慢构建，2026-11-22 在 `bf7ee6818` 复核规划、分片和本地 profiling。
- PR #862（`888a0297e`）交付规划去重、Vitest 分片、按平台释放执行任务和两层 runtime 归档。
- `perf/qa-platform-full-speedup` 在该基线上继续优化三平台正式运行，保留独立 QA 标识、release 配置、用例选择与逐文件哈希校验。第 4 节记录实施，第 5 节记录同一组 crash 用例的托管测量。

## 2. 初版实测数据

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

## 3. 初版基线的根因分析

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

## 4. 当前工作流

### 4.1 规划、检查与并发

- `plan` 运行目录审计和 crash 用例选择合约。Schema 校验器复用，审计复用已解析的用例和功能列表，精确 selector 建索引。仅需 Git 历史的规划使用深克隆。PR 和聚焦运行把 crash 套件纳入选择，夜间 `scope=all` 执行完整目录。
- PR、夜间和非 `selected` 范围并行执行四个完整 Vitest 分片。分片 1 运行桌面 TypeScript、源码边界和原有 Python/Node 合约。`selected` 且含 native 的手工运行并行执行同样的 TypeScript 和源码边界检查。失败传递至 `qa-ui-auto-platforms-result`。
- 浏览器分片与 native 构建同时开始。每个平台的 native 分片只等待自己的构建，使用同一个 QA release 可执行文件。macOS 最多同时调度 4 片，实际开跑时间由账户可用的 hosted runner 决定。
- Windows capture helper 独立成 workspace crate，26 项合约在独立任务运行。Linux 合约合并同一个根测试二进制的过滤条件。执行端继续验证本轮 selection、case 摘要、源码、原始 QA binary identity、各文件与实际 receipt。失败、跳过、缺失或身份不匹配的计划用例会使汇总失败。

### 4.2 编译、依赖和传输

- 桌面 Rust 库生成 `rlib`。QA 保留 release 优化和诊断断言。QA 的前端构建仍生成桌面资源和内嵌 mobile bundle，macOS 仍 stage krb5。完整类型检查在并行任务执行。
- Linux 区分编译库和桌面运行包，22.04 构建维持 glibc 基线与 PipeWire 1.0.9。Windows 使用 MSVC 链接器嵌入 ComCtl32 v6 manifest。依赖安装允许 `ssh2` 使用 JavaScript 后备实现。
- Rust 依赖缓存按平台、profile、编译环境和依赖输入区分。Linux 合约与生产 runtime 的 job 使用同一组依赖，`save-if` 让合约只恢复，由成功构建的生产者写入。失败或取消的冷编无法占用不可覆盖的缓存键。Windows helper 的小依赖树使用单独的键。
- Sherpa 缓存保存 `src-tauri/target/qa-ui-auto/sherpa-onnx-prebuilt`。命中后清理该 crate 的 dev/release 指纹，让 Cargo 离线重跑其构建脚本并恢复链接库和运行时 DLL。未命中时移除残留的空目录再正常提取。移动端 native 分片单独缓存匹配 Playwright 版本的 Chromium。
- runtime 归档使用 gzip 级别 1。共享归档绑定平台、架构、runner 基线、profile、完整 source/recipe SHA-256、QA 标识、二进制和每个文件的 SHA-256。命中后先验证，再按当前 head、run/attempt 和 selection 重建当次归档。各执行分片照常验证当次身份并运行用例。

### 4.3 频繁改代码、并行 worktree 与夜间运行

| 条件 | 各平台的实际工作 |
| --- | --- |
| 应用、构建配方及平台输入相同，有完整 runtime | 校验归档并重新绑定本轮 selection，跳过编译。仅改文档、用例或独立前端单测通常属于这一类。 |
| 改动桌面或 mobile 的产品源码，依赖缓存可用 | 重新构建受影响的 crate 和内嵌前端并链接。Cargo 复用仍有效的第三方依赖。Run B 用只改一行 Rust 注释的确定性输入验证。 |
| runtime 与兼容的 Rust 依赖缓存都不可用 | 从头编译。Sherpa、pnpm 或 pip 仍可单独命中。首次运行、编译环境变化、分支隔离、容量驱逐都会影响这个结果。 |
| 多个 worktree 先推送并按分支手工派发 | 缓存属于工作流的派发 ref。每个分支可恢复自己或默认分支的匹配缓存，不能读取兄弟分支的专属缓存。首次派发是否热编取决于默认分支缓存的键和可用性。 |
| 多个 worktree 提交不同 PR | runner 各自独立，缓存按 GitHub ref 可见范围恢复。同一 PR 后续推送可读取本 PR 或基准/默认分支的匹配缓存；同时启动的兄弟 PR 各自构建尚未发布的缓存。 |
| 每日定时任务 | 从默认分支生成全量计划。上一轮已验证的 runtime 可直接复用，合入产品改动后通常先尝试恢复依赖。成功写到默认分支的依赖缓存可供后续 PR 读取。 |

`source_sha256` 覆盖实际工作树的源码、依赖锁、资源和构建输入，并排除共置的前端单测。修改一个 Rust/React 产品文件会使三平台的 runtime 键失效。不同 worktree 的本地 `target/` 与云端缓存相互独立。当前运行是否命中，须分别查看三个生产者的恢复、编译和校验日志。[GitHub 缓存可见范围](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache)

## 5. 托管验收

计时取 GitHub Actions API 的 UTC 时间。墙钟从该 attempt 的 `run_started_at` 到 `updated_at`，包含等待 runner 的时间。job 用自己的开始和完成时间。不同任务可并行，耗时不可相加。A2、B 和 C 均使用 `scope=selected`、`tags=crash-regression`、三端、browser 与 native。每端分别计划 18 次 browser 和 22 次 native，共 120 次。

| Run | 结论 | 墙钟 | plan | build Linux / Windows / macOS | native-contracts Linux / Windows | Windows browser 1 / 2 |
| --- | --- | ---: | ---: | --- | --- | --- |
| #2014 `44899963744`，早期 dispatch | 失败 | 75:25 | 3:57 | 51:46 / — / 36:15 | 15:30 / — | — |
| `44896462720`，早期三端 PR | 失败 | 82:55 | 3:09 | 52:24 / 60:40 / 34:49 | 26:15 / 构建内 | — |
| `44998975532`，PR #862 | 通过 | 51:53 | 0:41 | 17:29 / 27:11 / 36:57 | 24:29 / 33:01 | 9:53 / 7:55 |
| A `45005261996`，首次试验 | 取消 | 51:10 | 0:39 | 26:58 / 32:49 / 40:17 | 26:24 / 4:54 | 5:42 / 5:37 |
| A2 `45009569101`，attempt 2，Rust 冷编 | 通过 | 58:45 | 0:41 | 25:25 / 34:17 / 35:30 | 25:34 / 2:25 | 5:44 / 7:39 |
| B `45015104902`，一行 Rust 注释，实际冷编 | 通过 | 56:31 | 0:40 | 25:22 / 40:09 / 32:28 | 23:53 / 3:04 | 8:57 / 7:00 |
| C 首次 `45021757976`，仅文档改动 | 取消 | 31:23 | 0:38 | 25:35 / 27:50 / 取消 | 20:19 / 2:57 | 9:32 / 7:11 |

- **A2**。第一次运行在 7:19 时取消。删除本分支由取消任务写入的 739,943,652 字节半成品缓存后，在同一提交 `25713d41f` 重跑所有 job。三端 Rust 生产者均冷编；Linux 和 macOS 恢复了 Sherpa，Windows 重新下载并成功写入。Linux 构建保存 1,254,467,486 字节 Rust 依赖，Linux contracts 日志为 `save-if: false`。Windows helper 的 26 项 Rust 测试通过，Windows native 四片均成功，第 4 片成功发布 Chromium 缓存。18 个执行分片及汇总全部通过。仓库缓存用量接口在 A2 结束后报告 12,317,326,792 字节。[A2 第 2 次运行](https://github.com/engcapa/taomni/actions/runs/45009569101/attempts/2)
- **关键路径**。相对 PR #862，A2 的 Linux 和 Windows 冷构建各慢 7:56、7:06，macOS 快 1:27，Windows 合约快 30:36。macOS 构建结束后，四个分片从 10:42:06 到 10:58:17 UTC 陆续执行，每片实际用时 4:09–4:34。配置允许并发 4 片，当次 runner 分配未形成单波次。总墙钟较 PR #862 长 6:52。[PR #862 基线](https://github.com/engcapa/taomni/actions/runs/44998975532)
- **B**。临时提交 `528cc9cdc` 相对 `b979ed0a2` 仅在 `src-tauri/src/lib.rs` 增加一行注释。源码摘要由 `6261fa3cb03a8406` 变为 `64e99b0ffa4eca09`，配方摘要仍以 `0de7ea9e8a1dcd24` 开头。三个生产者和 Linux 合约均打印 `No cache found.`，Sherpa 也全部未命中。Windows 第 4 片重新安装并保存 Chromium，耗时 9:47。并行前端检查 1:27 通过，120/120 次执行通过，零跳过、零基础设施错误。该样本验证了缓存被驱逐时的重建和执行，暖编耗时仍缺样本。同期缓存清单显示多个 worktree 分支合计超过 10 GB。[B](https://github.com/engcapa/taomni/actions/runs/45015104902)
- **C 首次**。源码和构建配方摘要与 A2 完全相同。Linux、Windows 查找的程序归档键均已在 A2 成功写入，这次查找未命中并重新编译。确认冷编后取消当次运行。缓存用量接口随后报告 11,467,212,071 字节。[C 首次](https://github.com/engcapa/taomni/actions/runs/45021757976)
- **同分支缓存修复**。直接在分支 HEAD 手工派发时，编译成功后保留 1 天的 Cargo 依赖归档和 3 天的完整程序归档。按同仓库、同一派发分支及同一 workflow 查找，独立于 Actions cache 配额。Cargo 键包含 runner、工具链、profile、Cargo manifests、锁文件和编译环境。完整程序沿用源码、配方和逐文件校验。普通运行出现 miss 时继续构建，暖编验证可在 miss 步骤出现时取消。
- **全量范围**。本分支默认 `scope=all` 本地规划出 847 个不同用例、25 个执行分片、2,864 次执行及零能力缺口。最近可比的历史夜间全量墙钟为 128:28，汇总失败，Linux / Windows / macOS 的 build 分别为 52:21 / 64:47 / 28:15。A2/B/C 的墙钟只代表聚焦回归。本轮未测量新分支全量墙钟。[历史三端全量](https://github.com/engcapa/taomni/actions/runs/44963652702)

## 6. 缓存容量

验收期间，缓存清单的 38 个条目合计 12.053 GB。相近时间查询用量接口返回 10.413 GB 和 26 个条目。两次读取之间有并行运行持续写入和触发驱逐。GitHub 默认包含每仓库 10 GB 的 Actions cache 配额，满额后按最近访问时间腾出空间。此仓库的配额设置接口返回 HTTP 402，以上数字是实际用量采样。[GitHub 缓存配额和驱逐策略](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#usage-limits-and-eviction-policy)

| 缓存类别 | 条目 | GB |
| --- | ---: | ---: |
| Platforms Rust 依赖 | 4 | 5.112 |
| 其他工作流的 Rust | 14 | 4.954 |
| Windows helper Rust | 1 | 0.275 |
| pnpm | 6 | 0.964 |
| pip | 8 | 0.485 |
| 完整 QA 程序 | 3 | 0.258 |
| 其他 | 2 | 0.003 |

Rust 合计 10.341 GB，占约 86%。`refactor/modules-arch` 的独立分支缓存占 9.656 GB，同一 Windows runner 下两份依赖缓存分别为 1.418 GB 和 1.417 GB。两者依赖指纹不同。每个平台、编译环境和 GitHub ref 都能产生独立缓存，多个并行分支和临时验证 ref 会累加体积。

- **优先减 Rust 重复写入**。在各工作流内统一同一依赖图的缓存键，让成功构建负责写入。同一分支保留仍在使用的依赖版本。Windows helper 的独立缓存约 275 MB，可以对比只保留 registry 或关闭此缓存后的实际合约耗时。pnpm 和 pip 合计 1.449 GB，可在确认重复后再细化。
- **Actions Artifact**。与 Actions cache 配额分开。适合短期保留同分支的编译依赖和 QA 程序，可通过保留天数约束占用。归档上传、提取和存储仍有开销。[GitHub Actions 存储计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- **对象存储与自托管 runner**。S3 兼容存储配合 `sccache` 可跨分支共享编译结果，并设置生命周期。对象存储需要凭据、访问边界和容量管理。持久 SSD 的自托管 runner 可保留本机 Cargo 目录，维护成本取决于三端 runner 数量。[sccache S3 后端](https://github.com/mozilla/sccache/blob/main/docs/S3.md)

## 7. 试验取舍与待办

- Run A 同时启用 `codegen-units=64` 和 Windows `lld-link`。与 PR #862 对照，Cargo 的 Linux / Windows 编译从 13:21 / 23:28 变为 22:44 / 28:36，Windows 四片原生启动报 `WinError 14001`。A2 使用默认 codegen units 和 MSVC 的 manifest 嵌入链路。Linux 恢复与保存分离，build/contracts 只安装编译所需的 apt 包与 lld。Run A 的 Windows / Linux 双归档导出从 38 / 37 秒降至 14 / 12 秒。[Run A](https://github.com/engcapa/taomni/actions/runs/45005261996)
- 本仓库归个人账户所有，评估时 8 核 Larger Runner 需要组织方案。GHA 后端的 `sccache` 会与依赖和 runtime 争用仓库缓存配额。降低 release `opt-level` 会改变 `qa-workspace-performance.yml` 的性能对照环境。本轮沿用标准 hosted runner、完整 release 优化及裁剪过的 Rust 依赖缓存。
- **待办**。评估默认分支的依赖缓存预热，以两个新分支手工派发验证首次构建命中率。另行实测三端 `all` 的端到端墙钟、排队与最长分片，再据此决定是否调整分片。这两项在本轮完成后单独评估。
