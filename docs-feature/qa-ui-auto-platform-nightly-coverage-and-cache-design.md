# QA UI Auto Platforms 第三轮：夜间覆盖分层、Windows 周末门控与构建缓存实验

2026-11-23。基线为 `origin/main@66841d20f`（第一轮实现 + 第二轮方案已合并）。本轮把第二轮方案里的 TASK-01/02/03 收敛成四组可直接验收的改动：夜跑覆盖策略 B、Windows 平台周末夜门控、受信任默认分支 Cargo 依赖复用、vendor 路径依赖缓存实验开关。

术语：**夜标签**指这次定时运行对应的“北京时间晚上”。cron `17 19 * * *`（UTC）对应北京时间次日 03:17；`D` 日 19:17 UTC 的触发对应 D 日晚上的北京夜跑，因此夜标签 = 名义触发时刻的 UTC 日期 `D`。运行延迟（实测 4–7 小时）不影响标签；若运行与名义触发相差超过 36 小时，脚本打印 warning 并按运行开始日回推。

## 1. 已确定的决策

| 决策 | 内容 |
| --- | --- |
| 夜跑覆盖 | 方案 B：native 保留 crash 套件 + 平台限定用例 + 共享用例的 20% 轮换窗口；browser 保持全量 |
| Windows 平台 | 仅周五、周六、周日晚（夜标签周一至周五的北京夜跑分别对应…见 §2.2）运行；其余夜晚整段跳过 Windows（browser、native 与构建） |
| vendor mtime | 允许作为实验开关先跑 A/B，默认关闭 |
| 执行范围 | P0（调度与信号）→ P1（缓存）→ P2/P3（覆盖与并发收敛） |
| 不改动 | PR/impacted/selected 的选择语义、crash 套件强制包含、release 二进制身份与逐文件校验 |

## 2. 夜间覆盖策略

### 2.1 集合定义

对每个 native 执行组合（平台 + Linux desktop profile），在现有 eligibility 过滤之后应用：

1. **始终保留**：带 `crash-regression` 标签的用例；声明了 `native_platforms` 且不是完整三端集合的用例（平台独占或两端限定）；影响范围选中的用例（仅 impacted 范围，夜跑不适用）。
2. **轮换样本**：其余“三端共享”用例按 `sha256("qa-ui-auto-nightly-v1:" + case_id)` 稳定排序，取 `ceil(n × percent / 100)` 大小的连续窗口；窗口序号 = `夜标签 ordinal % ceil(100 / percent)`。默认 `percent=20`，即 5 个夜晚覆盖全部共享用例一次。
3. **依赖闭包**：被保留/抽中的用例递归加入其 `dependencies.yaml` 前驱（仅限本组合 eligible 集合），保持 sharding 的前置顺序与 `validate_partition` 约束。
4. 双屏变体、release 扩散、`RDP unit contracts` 归属等后置逻辑保持不变。

策略只对 `scope=all` 且开启夜间策略的运行生效。`selected`/`impacted`/`smoke` 与 PR 行为完全不变；显式选择永远不会被抽样丢弃。

### 2.2 Windows 平台门控（北京时间）

夜标签与运行开始时间、Windows 是否运行：

| 夜标签（北京晚上） | 定时运行开始（北京） | Windows |
| --- | --- | --- |
| 周五 | 周六 03:17 | 运行 |
| 周六 | 周日 03:17 | 运行 |
| 周日 | 周一 03:17 | 运行 |
| 周一至周四 | 周二至周五 03:17 | 跳过 |

跳过时 `platforms=linux,macos`：Windows 的 browser 分片、native 构建与 native 分片全部不进入计划，因此也不会占用 runner 槽位。`qa-ui-auto-platforms-result` 仍按实际计划校验。

手动派发默认保持三端全量；新增 `nightly_policy=true` 与可选 `night_label=YYYY-MM-DD` 输入用于在白天模拟任意夜晚（计划输出可对比，不必等真实定时）。

### 2.3 记录与可复现

`selection.json` 新增 `nightly` 段：

```json
{
  "night": "2026-11-23",
  "weekday": "MON",
  "windows": false,
  "sample_percent": 20,
  "window": "4/5",
  "always": {"crash": 22, "platform_scoped": 61},
  "sampled": ["TC-..."],
  "deferred": ["TC-..."],
  "entries": {"linux-native": {"eligible": 430, "selected": 134}}
}
```

- `reasons[case]` 追加 `nightly: crash-regression` / `nightly: platform-scoped` / `nightly: sample window 4/5` / `nightly: deferred to a later window`。
- 每晚计划可用 `python -m qa_ui_auto.ci plan` 在本地按同一 `night_label` 复算，不需要 runner。
- 抽样只依赖用例 ID 与夜标签，同一夜晚重跑得到同一集合。

## 3. opt-in 真实 provider 用例

`tao_real_provider` fixture 在缺少 `TAOMNI_QA_*_KEY`/`*_KEY_FILE` 时抛 `FixtureSkip`，而汇总把 skip 计为失败：上一轮夜跑 53 个失败用例中约 48 个来自这条路径。本轮在**计划阶段**处理：

- 新增 `qa_ui_auto/real_provider.py`，与 fixture 共用 provider 表与就绪判断；
- `scope=all` 且 provider 未就绪时，计划把这些用例放入 `opt_in_deferred`（附原因），不进入执行矩阵，也不再产生 skip/失败；
- provider 就绪（设置任意受支持 key）时行为不变；`selected` 显式请求仍会执行并以真实结果报告；
- `summary.md` 输出 deferred 数量与原因，避免“全量通过”掩盖未执行。

## 4. 调度与并发

1. **macOS browser 独立限流**：plan 额外输出 `macos_browser_matrix`，`execute-browser` 只服务 Linux/Windows；新增 `execute-macos-browser`，`max_parallel: 3`。native 分片在 producer 结束后优先拿到槽位，browser 最多占 3 个 macOS 名额。
2. **容量门控**：schedule 触发的 plan job 在规划前运行 `qa_capacity_gate.py`：若存在**更早创建**且仍 active 的同 workflow run，最多等待 20 分钟，超时或 API 失败打印 warning 后继续（fail open）。门控只做错峰提示，不取消任何运行。
3. 不改动既有 `max_parallel: 8` 的 Linux/Windows browser 矩阵与 macOS native 的 4 片上限。

## 5. 缓存

### 5.1 受信任默认分支的 Cargo 依赖归档

现状：`QA_BRANCH_ARTIFACTS` 仅对“分支 HEAD 的手工派发”为真，schedule/PR 不查归档；Cargo 依赖键本身不含源码，因此默认分支成功构建出的 1.7–2.0 GB 归档无法被新分支或次日夜跑复用。

改动：

- `qa-branch-artifact` action 增加 `trusted` 模式：按仓库 ID、head repository、workflow 路径（`qa-ui-auto-platforms.yml`）、`head_branch == 默认分支`、事件 ∈ {schedule, workflow_dispatch, push}、未过期、非当前 run 查找；
- build/contracts 的 Cargo 归档查找顺序：本分支归档 → 受信任默认分支归档 → Actions cache → 冷编；
- Cargo 依赖归档保留期由 1 天提高到 3 天，覆盖次日夜跑与跨周末；
- 来源不可信、过期、损坏或身份不符时继续回退，不阻断构建；
- PR 只读默认分支归档；分支/fork 不能写入默认分支作用域；
- `trusted_cache=false` 派发输入可临时关闭默认分支读取，用于 A/B 与冷编复现。

### 5.2 vendor 路径依赖缓存实验（默认关闭）

`src-tauri/Cargo.toml` 的 `[patch.crates-io]` 引用了 13 个 `src-tauri/vendor/*` path 依赖。现有归档按 `src-tauri/**/Cargo.toml` 把它们的 package 全部视为 local unit 排除，导致暖编仍重编 33–38 个 crate（Windows 构建步骤 13.5 分钟、macOS 16.4 分钟）。

实验开关 `QA_VENDOR_CACHE=1`：

- 归档键加入 `vendor_tree_digest()`（优先 `git ls-tree -r HEAD -- src-tauri/vendor`，无 git 时按文件内容摘要回退），vendor 源码变化必定触发新键；
- vendor 包不再视为 local unit，其 `deps/build/.fingerprint` 进入归档；
- `QA_VENDOR_MTIME_EPOCH`（默认 `1600000000`）在编译前把 vendor 源码 mtime 归一化，使恢复的 fingerprint 在 Cargo 看来仍然新鲜；`ci_cargo_artifact.py normalize` 供 workflow 在 restore 后调用；
- 开关与 epoch 值进入 `build_inputs()`，避免开关切换时错误复用二进制身份。

预期：暖编重编 crate 从 33–38 降到个位数，Windows/macOS 暖编构建步骤有机会从 13–16 分钟降到 3–6 分钟。以 A/B 实测为准，未达标则保持关闭并记录证据。

## 6. 预期收益

| 项目 | 依据 | 预期 |
| --- | --- | --- |
| 夜跑 native 数量 | 计划统计：三端共享 391 / 平台限定 61 | Linux 430→约 120–140，Windows 408→约 90–120，macOS 389→约 70–100（含依赖闭包） |
| Windows 周末门控 | 4/7 个夜晚整段跳过 Windows | 省一次 Windows 构建（冷 43 分钟、暖 17–19 分钟）+ 8 个 Windows 分片槽位 |
| 默认分支依赖复用 | 第二轮回放实测冷→暖 −18:33 | 新分支/次日夜跑每个生产者省 16–20 分钟 |
| vendor 缓存 | 暖编 33–38 crate | 暖编 13–16 → 3–6 分钟（A/B 判定） |
| 综合 | 以上叠加 | 夜跑冷编 ~113 → ~65–75 分钟；暖编/复用后 ~40–50 分钟（估算，待夜跑实测） |

## 7. 验收与 A/B 协议

- **计划等价（本地/CI 均可）**：同一 head 用 `night_label` 连续跑 1 个轮换周期（5 夜），断言每个共享 native 用例恰好出现一次；`selected`/`impacted` 的计划与改动前一致；crash 与平台限定用例每晚都在。
- **Windows 门控**：分别模拟周五/周六/周日与周一至周四的 `night_label`，断言 `platforms` 与矩阵；`scope=selected` 始终保留显式请求的 Windows。
- **opt-in**：无 key 的 `scope=all` 计划 `opt_in_deferred` = 16 个用例 × 平台；设置 key 后恢复；`selected` 不受影响。
- **受信任归档**：在未改 manifest/工具链的新分支上派发 focused native 运行，构建日志出现来自默认分支 run 的 `Restored Cargo ...`，构建时间接近暖编；改名/过期/伪造来源测试回退冷编。
- **vendor A/B**：同一 commit 两个分支：A 关闭（现状），B 开启。B 首轮冷编建立新键，次轮恢复后记录重编 crate 数与构建步骤耗时；A 用同轮暖编对照。验收判据：B 暖编构建步骤 ≤ 6 分钟且二进制身份校验通过；否则回退开关。
- **夜跑实测**：连续两个自然夜跑记录墙钟、各 job 等待、native 执行数与失败/跳过；与上一轮 113:29 对比；任何抽样导致的“未执行”必须出现在 `nightly.deferred` 与 summary 中。

## 8. 首轮实现验证（2026-11-23）

所有验证都在 `perf/qa-nightly-coverage-and-cache` 分支上以 workflow_dispatch 完成，sha 固定在 `f818e1698`/`aacb9a5e8` 的实现上（临时探针提交只改变 Rust 注释，用于强制重编，不影响 cargo 依赖键；探针提交与探针分支已在测量后移除）。

| 验证 | 运行 | 结果 |
| --- | --- | --- |
| 夜间计划（周二夜） | `45118200487` | night `2026-11-24` 周二，`platforms=['linux']`，Windows 跳过；Linux native always 73 + 样本 26 = 100/414，deferred 314；opt-in 17 个组合延期；5 个 native entry（4 片 + 双屏） |
| 汇总展示 | `45118242633` | `summary.md` 出现 Nightly 行与 opt-in deferred 行；99 个 native 用例与计划一致 |
| 容量门控 | 本地对真实 API 运行 | 列出 5 个更早的 active run，超时后 `::warning::` fail-open，写出 `capacity-gate.json` |
| 受信任归档（负向） | `45118200487` | main 尚无当前键归档时打印 `No retained artifact ... on trusted main` 并回退冷编 |
| 受信任归档（正向） | `45131100717` | 无本分支归档时从 main 的 run `45124668225` 取到 `...72f90c23...`；下载 23 秒、解包 45 秒、构建步骤 7:43（36 个 crate），对照冷编 22.6 分钟 |
| vendor 冷编（开关开） | `45118242633` | 构建步骤 22.0 分钟；507 个 vendor 文件 mtime 归一化；归档 1.6 GB（`...f64a0657...`） |
| vendor 暖编（开关开） | `45124662612` | 恢复同分支归档（下载 0.6 + 解包 0.9 分钟）；**重编 crate 3 个**（taomni + sherpa 链）；构建步骤 8.7 分钟 |
| 无 vendor 暖编对照 | `45126363964` | 同样恢复归档；**重编 crate 36 个**；构建步骤 9.7 分钟 |
| 无 vendor 冷编对照 | `45118200487` | 构建步骤 22.6 分钟 |
| 运行时复用回归 | `45123913285`、`45123923909` | 校验后复用运行时，构建 job 约 1 分钟，单用例通过 |

### 8.1 结论与判读

- **夜间策略与 Windows 门控按计划工作**：计划、矩阵、汇总和 deferred 记录都能从 `selection.json` 复算；V1 的失败来自 Maven Central 429（基础设施）与 2 个既有产品断言（`linux-native-shard-2/TC-WS-079`、`linux-native-shard-4/TC-FILE-OPEN-045`），不是策略或缓存改动。
- **vendor 归档机制成立**：开关打开后，暖编重编 crate 从 36 降到 3，说明 vendor 中间产物确实被 Cargo 复用。
- **Linux 上的净收益有限**：本机 Linux 暖编本来就只需 ~10 分钟，恢复 1.6 GB 归档的 1.5 分钟会抵消一部分收益；同条件对照只快约 1 分钟（9.7 → 8.7）。Windows/macOS 的第二轮实测暖编构建步骤为 13.5/16.4 分钟，是这项优化真正的目标平台，需要按同一 A/B 协议补测后再决定是否默认打开。当前保持默认关闭。
- **冷编不受开关影响**：22.6 分钟（关）对 22.0 分钟（开），符合“只影响恢复路径”的预期。
- **同分支归档已可跨 commit 复用**：`45129303833`（新探针提交）仍从同分支早先的 run 取到了 Cargo 依赖归档（键不含源码），说明归档键不含源码是可行的。
- **受信任默认分支路径已端到端验证**：在没有任何本分支归档的 `qa/trusted-cache-probe` 上，`45131100717` 的日志记录 `Found qa-cargo-dependencies-v1-...-72f90c... in trusted workflow run 45124668225 (workflow_dispatch on main)`；没有归档时回退冷编（`45118200487` 的 `No retained artifact ... on trusted main`）。来源校验（默认分支、completed、非当前 run、同一 workflow）在两次运行中都按预期过滤。
- **首个夜跑的预期**：合并当晚 schedule 运行在 main 上仍是冷编（main 尚无当前键归档），但它会发布当前键归档；次日夜间应命中受信任归档并把三端依赖编译变成暖编（实测单平台约省 15 分钟）。

## 9. 回退

- 夜间策略由 workflow env `QA_NIGHTLY_SAMPLE_PERCENT=100` 或 `nightly_policy=false` 关闭；恢复三端全量只需派发时把策略关掉。
- Windows 门控由 `QA_WINDOWS_NIGHTS`（默认 `fri,sat,sun`）控制，设为全周即恢复现状。
- 受信任归档与本分支归档互不影响，查找失败自动回退；删除该 step 即恢复。
- vendor 实验由 `QA_VENDOR_CACHE` 控制，默认关闭；关闭后归档键与当前完全一致。

## 10. 改动清单

- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py`：夜间策略与 opt-in 计划集成、`nightly` 清单字段。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/real_provider.py`：provider 就绪判断（与 fixture 共用）。
- `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/tao_real_provider.py`：复用共享 provider 表。
- `.github/scripts/qa_capacity_gate.py` + 测试：容量门控。
- `.github/actions/qa-branch-artifact/action.yml`：`trusted` 查找模式。
- `.github/workflows/qa-ui-auto-platforms.yml`：夜间策略计算、容量门控、macOS browser 独立矩阵、`vendor_cache`/`nightly_policy` 输入、汇总展示 deferred。
- `.github/workflows/qa-ui-auto-entry.yml`：受信任归档查找、vendor normalize 与开关、保留期。
- `.agents/skills/qa-ui-auto/scripts/ci_cargo_artifact.py`、`native_build.py`、测试：vendor 实验。
- `qa-ui-auto-tests/ci/README.md`：触发方式与策略说明。
