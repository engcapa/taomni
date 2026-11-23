# QA UI Auto Platforms 第二轮提速方案

2026-11-23。调研基线为已合并 PR #866 的 `main@a6cf8ecfa`。本方案同时考虑多分支手工验证和每日三端全量。计时和容量均来自本仓库，第三方资料用于比较机制。[已合并实现与 A/B/C 证据](qa-ui-auto-platform-build-speedup-design.md) · [PR #866](https://github.com/engcapa/taomni/pull/866)

## 1. 建议与预期

1. **频繁改代码的新分支，优先复用可信 `main` 的 Cargo 依赖。** 同分支手工验证已经证明暖编有效。冷编切到暖编，一次三端聚焦验证实测从 58:45 到 40:12。当前最大的机会是让首个分支提交也能得到同样的依赖。文档、用例等改动可以进一步复用完整 QA 程序。
2. **三端全量，先按四片观察实际排队，再选择 Windows native 的片数。** Windows 历史四片已接近均衡。六片能及时启跑时，其执行部分有约 15 分钟空间。macOS 的 browser、native、编译和同账户其他运行共享名额。多分支高峰时，要同时考察本轮最终汇总和其他分支的等待时间。
3. **保留每晚三端的浏览器和真实桌面断言，先简化测试准备。** 根据用例实际需要准备服务、工具和只读 fixture，保留独立可写状态。用收集到的每例启动、清理时间决定是否改驱动。纯 UI 跨端轮换是一项独立的覆盖决策。
4. **先用现有 hosted runner。** 在 4 个有效 macOS 槽位的回放里，已合并版本的三端全量约为冷编 **90 分钟**、暖编 **80 分钟**、完整程序命中 **66 分钟**。加入分平台分片、且每个 native 用例平均再省 2 秒，对应约 **76 / 77 / 62 分钟**。这些是指定负载与排队条件下的模型值。历史全量含失败和跳过，改造后全通过的耗时仍需夜跑实测。

## 2. 基线与关键路径

### 全量和聚焦回归

| 样本 | 范围与结论 | 实际墙钟 | Linux / Windows / macOS 构建 job |
| --- | --- | ---: | --- |
| 合并前最近 7 次定时 | 全量，7 次汇总均失败 | 中位 134:34，最长 607:19 | 包含不同提交及 runner 拥塞 |
| [最近历史夜跑](https://github.com/engcapa/taomni/actions/runs/44963652702) | 全量，2,846 次，2,748 通过、49 失败、49 跳过，0 项基础设施错误 | 128:28 | 52:21 / 64:47 / 28:15 |
| [A2 attempt 2](https://github.com/engcapa/taomni/actions/runs/45009569101/attempts/2) | 聚焦，三端冷编，120/120 | 58:45 | 25:25 / 34:17 / 35:30 |
| [B 复测](https://github.com/engcapa/taomni/actions/runs/45033419257) | 聚焦，改产品 Rust 输入，依赖归档命中，120/120 | 40:12 | 9:05 / 17:29 / 18:45 |
| [C 复测](https://github.com/engcapa/taomni/actions/runs/45036127255) | 聚焦，改文档，完整程序命中，120/120 | 25:10 | 1:04 / 1:30 / 0:54 |

墙钟取同一 attempt 的 `run_started_at → updated_at`。历史夜跑所有实际执行的 job 合计约 988 runner 分钟。北京时间 03:17 是 cron 标称时刻。上述 7 次从应触发时刻到 GitHub 创建 run 的延迟4:06:57 至 7:12:30，中位 5:58:28（小时、分钟、秒）。若目标是上班前收到报告，这段延迟值得单独跟踪。截至北京时间 11 月 23 日 07:44，GitHub 列出的最近一次 schedule 仍是上表中合并前的夜跑。[定时记录](https://github.com/engcapa/taomni/actions/workflows/qa-ui-auto-platforms.yml?query=event%3Aschedule) · [最终汇总日志](https://github.com/engcapa/taomni/actions/runs/44963652702/job/137058263384)

在合并后的源码上重新执行 `python -m qa_ui_auto.ci plan --scope all`，得到 **851 个用例、25 个执行分片、3 个 release 构建、2,879 次执行、0 个能力缺口**。Linux 使用默认 Xvfb 桌面，另有一片双屏。上一轮特性分支的 2,864 次只适用于那个提交。

| 平台 | 本次计划 browser / native | 历史全量四个普通 native 分片的用例步骤总和¹ | 最慢执行步骤 / 最慢完整 job | 同为四片时完美均分的执行收益² |
| --- | ---: | ---: | ---: | ---: |
| Linux | 551 / 431 | 160:02 | 43:34 / 48:15 | 3:34 |
| Windows | 551 / 408 | 179:13 | 45:25 / 54:06 | 0:37 |
| macOS | 549 / 389 | 149:33 | 39:47 / 41:54 | 2:24 |

¹ GitHub 的 `Run selected cases` 步骤包括 harness、fixture、执行和清理。Linux 的 1 个双屏用例独占另一个 job。² 用最长执行步骤减四片均值，向上取整。新源码、新用例和失败修复会改变这些值。[历史各 job](https://github.com/engcapa/taomni/actions/runs/44963652702) · [全量规划与适用范围](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py)

- **Windows 与 macOS 同时决定历史夜跑的尾部。** Windows 生产者 64:47，最后一片又等 1:16、跑 54:06。macOS 生产者只用 28:15，最后一片却在产物就绪 53:24 后才开始，实际跑 39:02。历史配置的 macOS native 上限为 2，现在为 4。新配置下 C 的最后一片仍等了 13:40。API 提供开始时刻，不能把所有等待都归因于 GitHub 的总配额。[Windows 最晚分片](https://github.com/engcapa/taomni/actions/runs/44963652702/job/137044817799) · [macOS 最晚分片](https://github.com/engcapa/taomni/actions/runs/44963652702/job/137035594607) · [当前 DAG](../.github/workflows/qa-ui-auto-platforms.yml)
- **上轮已移出的工作不重复计收益。** 旧 Linux 构建串行等待 25:06 的前端回归，旧 Windows 构建内的 capture helper 合约耗时 15:21。现在全量 Vitest 已经四片并行、helper 独立，各 OS 也已经独立释放 native 消费者。当前 C 的最终汇总 job 只用约 21 秒，B 的汇总另等约 5 分钟才拿到 runner。
- **有权重缺口，也有物理并发上限。** 当前规划有 1,572/2,879 个“平台、模式、用例”命中已记录权重，native 仅 512/1,228（42%）。`durations.json` 由 10 月的单次运行生成，未知用例按 native 30 秒、browser 15 秒计算。现有算法已按依赖连通分量从长到短装箱。Windows 四片的历史实测表明，更新权重主要改善波动、帮助选片数，单靠重排很难再省十分钟。[历史权重](../qa-ui-auto-tests/ci/durations.json) · [分片实现](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci_sharding.py)

### 为什么多个分支仍会冷编

| 触发和输入 | 当前可实际恢复的内容 | 预期行为 |
| --- | --- | --- |
| 手工在分支自己的 HEAD 派发 | 同仓库、workflow、分支的 Cargo Artifact 保留 1 天，程序 Artifact 保留 3 天，另可读作用域内匹配的 Actions cache | 完整程序命中就校验后复用。改产品输入、依赖仍匹配就暖编。两个层级均不可用才冷编。 |
| 同仓库新分支，或并行启动多个 worktree | 本分支当时已发布的归档及 GitHub 允许读取的默认分支 cache | 兄弟分支刚完成的 Artifact 当前不参与查找。同时启动和缓存驱逐都会产生重复冷编。 |
| PR、指定另一 head 的 dispatch、每日 schedule | 按触发 ref 可见的 Actions cache。PR 另有基准分支和本 PR 合并 ref 的可见性 | `main` 目前会在满足保存条件时写 cache。短期 branch Artifact 路径只对直接分支 HEAD 派发生效。工作树目录名和提交作者都不参与跨分支授权。 |

两次相邻清单快照合计 10.865 GB 和 12.180 GB，均按十进制字节计。后一份为 32 条，其中 23 条 Rust 合计 **11.129 GB（91.4%）**，分布在 `qa/modular-verify-21752fbb0998` 与 `refactor/modules-arch`。同一个临时分支的两个 macOS Rust 缓存各约 1.77 GB，来自不同架构/配方。此时 `main` 只有 159 MB 的 pnpm。GitHub 默认每仓库 10 GB，受限时按最后访问时间驱逐。仓库实际付费上限及账户并发额度未从管理设置核实。[归档查找](../.github/actions/qa-branch-artifact/action.yml) · [恢复和保存条件](../.github/workflows/qa-ui-auto-entry.yml) · [GitHub cache 作用域和驱逐策略](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)

11 月 22 日 UTC 截至抽样共有 **60 次手工派发，来自 12 个分支**，其中 36 次在同一个活跃开发分支。A2 与 B 的实测差为每次 18:33。对同样的聚焦负载，若把全部派发中 50 个百分点从冷编转为暖编，每次平均等待可少约 9:17。实际能转化的比例需要从分支首次派发的缓存来源统计。[当天的手工运行](https://github.com/engcapa/taomni/actions/workflows/qa-ui-auto-platforms.yml?query=event%3Aworkflow_dispatch+created%3A2026-11-22)

## 3. 手工分支与 nightly 的缓存方案

**首选方案是用受信任的默认分支发布可跨分支读取的依赖。** 先复用 nightly 原有的三个成功构建。在 `qa-branch-artifact` 增加带来源约束的默认分支查找，分支本身的直接派发仍优先读本分支归档。先试 Cargo，完整程序作为第二步。在已有 nightly 上发布只多付打包上传成本。若单独启动三端冷预热，按 A2 的 producer 合计约 95 runner 分钟，B 相对 A2 每次三端暖编合计省约 50 runner 分钟。需要约 2–3 次原本会冷编的新分支运行才能摊回一次额外预热，实际还要看同一键存活多久。

| 数据 | 建议存放与访问 | 空间、代价与适用条件 |
| --- | --- | --- |
| 编译好的第三方依赖 | 可信 `main` 的不可变 Actions Artifact，按 OS/架构/基线/编译器/flags/profile/manifest/lock 查找。同分支短期归档作为补充。PR 只读受信任来源。 | 现有三端共 4.495 GB。B 恢复的下载加解包为 Linux 1:00、Windows 2:31、macOS 1:20。建议对默认分支试 3 天保留，命中接近到期时由可信构建续发。三个暖 producer 相比冷 producer 分别省 16:20 / 16:48 / 16:45。 |
| 完整 QA 程序 | 同一 invocation 用现有 `runtime-*` 给各分片。跨 invocation 只读完整来源、输入与文件校验通过的归档，并绑定当次 selection/attempt。 | 三端可复用程序合计 0.291 GB。只改文档、用例时价值高。改 Rust、React 或内嵌 mobile 后走依赖层。完整程序命中时再把重 pnpm/pip 安装挪到 miss 后，C 的 Windows 通用 setup 0:45，收益上限约一分钟。 |
| 小工具和包下载 | Actions cache 保留命中率和重装代价高的 pnpm、PipeWire、Sherpa、adapter 等。按 workflow、ref、键、字节和最近访问做清单。 | 优先减少重复 Rust 写入。识别已关闭临时验证分支、重复且已被替代的兼容项，再处理对应缓存。不同目标 ABI、features、Rust flags 的条目各自有效。浏览器 Chromium 先对比下载与恢复，再决定是否缓存。 |
| 测试证据 | 完整的 `qa-*` receipt 和引用文件继续作为验收依据。可对独立诊断副本分成功/失败设置保留期，或只在故障上传重复诊断。 | 历史全量有 48 个 Artifact 共 1.722 GB。25 份执行证据 1.403 GB，两个 macOS 分片就占 0.888 GB。13 份额外 native 诊断仅 0.048 GB。按每日一次和现行 14 天，单是执行证据稳态约 19.6 GB。压缩和缩短重复诊断的收益主要体现在存储。 |

归档生成一次实测的 Cargo 打包加上传为 Linux 1:24、Windows 2:23、macOS 1:37。消费者依赖 producer job 结束，所以此成本也要计入首轮墙钟。避免每天为原样依赖上传多个副本。容量按“每个活跃键的归档大小 × 同时存在的版本数”比较。把 Rust 全量从 cache 挪到 Artifact 会改变驱逐范围，仍会产生 GB·小时、传输和 runner 成本。[归档生成样本](https://github.com/engcapa/taomni/actions/runs/45028831881) · [Artifact 实现与压缩级别](https://github.com/actions/upload-artifact) · [Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

**来源与失效。** 默认分支读端核对 repository ID、head repository、workflow 路径、事件、生产 ref、完成发布的生产 job、制品 ID 和过期时间。按默认分支运行查找或分页，避免当前“先取同名最近 30 项再过滤”在多分支下漏掉发布者。Cargo 键已有 runner image、`rustc -vV`、Cargo 与编译环境。跨分支扩展完整程序时，版本化 runtime 配方，把影响 ABI 的 workflow/build flags 和声明的工具链基线也纳入。现有文件散列与实际执行时的完整 source/recipe 验证继续使用。受信任的默认分支只消费同等可信来源，分支或 fork 的写入限于自身作用域。

查找顺序为完整程序、依赖、冷建。对过期、查不到、无法下载的候选继续下一层。对损坏或身份不符的归档在 staging 中拒绝，并记录原因后从干净目标重建或明确报错。依赖命中还要用 Cargo 日志的 `Fresh/Compiling` 或实际重编 crate 数验证。成功读到归档可能仍因 toolchain、image 或 build script 失配而大量重编。[Cargo 归档实现](../.agents/skills/qa-ui-auto/scripts/ci_cargo_artifact.py) · [程序校验与重绑定](../.agents/skills/qa-ui-auto/scripts/ci_native_artifact.py)

### 基础设施备选

| 方案与行业参照 | 本仓库适用条件 | 建议衡量的回报 |
| --- | --- | --- |
| GitHub Actions 增加 cache 额度 | 愿意为超额存储付费且主要问题是驱逐。变更范围小，但仍受 ref 可见性和键碎片化影响。 | 用 GB·小时、首次分支恢复率和避免的冷编分钟与短期 Artifact 对比。 |
| Mozilla sccache 配 S3 兼容对象存储 | 多个 worktree、多个 workflow 的编译输入有重合，粗粒度 Cargo 包经常因少量变化整包 miss。按项目和信任域分前缀，可信 job 写入，其他分支只读，配置生命周期和删除旧版本。 | 记录 `sccache --show-stats`、对象请求、流量、GET 延迟、不可缓存调用、最终链接。调用系统 linker 的 bin、proc-macro 等有明确限制。B 的 macOS Cargo 阶段还有 15:56，此数是整段上限，不能全部归给 sccache。[Rust 支持边界](https://github.com/mozilla/sccache/blob/main/docs/Rust.md) · [S3 后端与只读模式](https://github.com/mozilla/sccache/blob/main/docs/S3.md) |
| 静态归档直接存对象存储 | 平台完整程序、大型固定工具包更新较少，Artifact 保留期或跨运行索引成为主要障碍。可先只外置程序与依赖，无需同时引入编译包装器。 | 按内容地址和 manifest/version 发布，比较地区带宽、上传下载、生命周期和运维。优先解决 4.495 GB 的依赖分发。 |
| Larger Runner 或专用 macOS runner | 当前是公开个人仓库。标准 hosted 计算免费。Larger Runner 需要符合资格的组织方案并有额外费用。专用 Mac 能提供稳定名额，但需维护实际登录的图形会话、OS 镜像、权限与每 job 隔离。 | 若 macOS 有效槽位长期从 4 降到 3，模型中能差 20–28 分钟。先测“等待可用 Mac”与“Mac 在执行”的比例，再决定买名额还是买更快 CPU。持久 SSD 可保留依赖，工作区、窗口、钥匙串、profile 和测试账号须每轮隔离。[GitHub 并发与产品限制](https://docs.github.com/en/actions/reference/limits) · [计费说明](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |

## 4. GitHub 运行时与分片

**采用 CircleCI 的历史时长分片思路，在已有装箱算法上补数据。** 从已校验的各分片 summary 提取 `group_id / case_id / case_digest / platform / desktop / profile / duration / outcome`，同类最近成功样本取中位数，另记长尾。失败、跳过、超时单独保存，防止一次秒退成为下次估值。首次出现可按同类 fixture 估算。记录每组已知权重比例、新旧预测误差和最长实际分片。启用新权重前离线回放旧夜跑。JUnit timings 的思想可复用，项目原有 receipt 足以提供唯一 case 标识。[CircleCI 时间分片](https://circleci.com/docs/guides/optimize/parallelism-faster-jobs/) · [现有耗时分析器](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/costs.py)

- **按 OS 选择片数。** 保留现有显式 `shards=1..8`。为 `auto` 分别评估 Windows 4/6、Linux 4/6、macOS 3/4，Linux 双屏照常独立。当前 Windows 有 406 个依赖分组，按现有权重模拟六片最长约 30:43，历史实耗理想六等分为 29:52。Windows、Linux 原四片的非执行开销中位约 7:00、4:04，多开两片会分别增加约 14、8 runner 分钟作为初估。优先释放较长且已就绪的任务，保留前置依赖顺序。若新增两片迟到 15 分钟，Windows 的墙钟优势可能消失。
- **macOS 同时考虑 browser。** 同一次全量有四片 macOS browser、四片 native 和一个 producer。现有三平台 browser 共用一个 `max-parallel: 8` 矩阵，macOS native 单独限 4。GitHub 公示个人 Free 和 Pro 的标准 macOS 并发上限均为 5，其他工作流也会占用。维护滚动的有效并发和等待分布，离线比较 3/4 片及 browser 提前/错峰。可拆出 macOS browser 单独矩阵来限制其占位，在 producer 与 native 就绪后让部分 browser 填空档，同时观测 browser 是否反成尾部。矩阵顺序只是一项提示。[GitHub 并发限制](https://docs.github.com/en/actions/reference/limits) · [Buildkite 并行构建实践](https://buildkite.com/docs/pipelines/best-practices/parallel-builds)
- **把高成本能力纳入分片代价。** 当前三个 OS 的四个普通 native 分片都请求 Java 和 MySQL。移动 Chromium 在 Linux/Windows/macOS 分别涉及 3/3/2 片，macOS updater 涉及 2 片。对 Java 真实项目、updater、音频、OCR 和 mobile 分别计 setup，装箱时按“新增能力的一次 setup + 用例总时长”比较。将所有重用例集中到一片也可能恶化最长分片。OCR 的 Windows 安装、macOS brew 和数据校验目前覆盖全部 native 执行，只有在 fixture、嵌套 verb 和失败诊断都已枚举后才按能力安装。普通 Linux 桌面和 22.04 生产者的 ABI 各自保留。[执行配置](../.github/workflows/qa-ui-auto-entry.yml) · [QA runtime](../.github/actions/qa-runtime/action.yml)
- **支持手工多分支并行。** 可给“同一 PR 更新后的旧提交”去重。手工派发常在同分支验证不同 case、桌面、平台或 profile，应保留这些运行的独立身份。需要合并重复派发时按 commit、scope、平台、模式、profile、selectors、调用来源匹配。不跨分支取消，也不让定时全量与临时探针互相取消。若实际目标是固定出报告时刻，另测错峰或外部定时器的触达时间，并显式复现 schedule 的 scope、合约和发布语义。
- **分支快速验证的正确性。** `plan` 当前 `inputs.scope == 'impacted' && 0 || 1` 的数字 0 会使表达式回落到 1。已有 `diff_paths()` 需要 base 和 merge-base。启用以 impacted 为主的手工入口前改成字符串深度或显式抓取所需提交，用浅克隆的分叉历史验证。保留 `selected/impacted` 自动并入 crash 用例的逻辑。[规划入口](../.github/workflows/qa-ui-auto-platforms.yml) · [影响范围计算](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py)

### 排队时，Windows 何时适合六片

历史全量 Windows 构建于 00:57:28 UTC 完成，最后一个 native 分片于 01:52:50 完成，**从产物就绪到四片全部结束实测 55:22**，已含分片等待和环境准备。用同一负载回放，六片执行部分每片约 29:52，加最多约 8:41 的环境准备、上传等开销，每片约 38:33。比较的是最后一片结束时刻，多个并行分片的排队时间不能相加。[四片原始 job 时间](https://github.com/engcapa/taomni/actions/runs/44963652702)

| 构建完成后 Windows runner 的供给情形 | 六片全部完成的估算 | 与实测四片相比 |
| --- | ---: | --- |
| 六片立即开工 | 约 39 分钟 | 快约 17 分钟 |
| 最后一片到第 17 分钟才开工 | 约 56 分钟 | 基本持平 |
| 始终只有四台可用于这批分片，两片等第一批完成才开工 | 约 77 分钟 | 慢约 22 分钟 |

此回放假定六片等长。按各片实际的“就绪后等待 + 完整 job 时长”取最大值，可复算不同供给情形。若整批四片和六片开工前都同样等了十分钟，两种方案都会多十分钟。是否扩片取决于额外两片引入的等待，以及 Windows 是否决定三端最终汇总。默认四片，六片作为有余量时的候选。

11 月 23 日合并后的首次定时运行已在北京时间 08:20 启动。08:48 的 Jobs 快照显示，plan 于 08:20:49 完成，macOS browser 三片分别在 08:39:49、08:41:04 和 08:45:23 开工，第四片仍在排队。三平台共用的 browser 矩阵上限和可用 runner 都会影响这段等待。该快照只能证明任务就绪到开工存在延迟，Windows 六片的等待分布还需独立验证。[本轮夜跑](https://github.com/engcapa/taomni/actions/runs/45088139032)

## 5. Native 简化的收益和边界

已有实现使用 `tauri build --no-bundle`、每 OS/架构一次构建、每片一个 `NativeHarness`、每个用例独立创建和关闭 session。Linux/Windows 已复用 driver。浏览器已按 worker 复用 Chromium，每例新建 BrowserContext。macOS 的 QA 应用是 driver 子进程，`reset_db` 前需停止应用，防止 SQLite 打开的文件被删除。当前 native 执行中 1,224/1,228 次有 `reset_db`。把 native 的 worker 数从 1 直接调高，会让共享焦点、菜单、剪贴板和系统对话框相互干扰。[runner 生命周期](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/runner.py) · [状态重置](../.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/reset_db.py) · [Playwright 的隔离模型](https://playwright.dev/docs/browser-contexts)

| 做法 | 第一个适合验证的场景 | 收益与验收边界 |
| --- | --- | --- |
| 简化准备，保持每例真机隔离 | 给成功和失败样本分开核算现有 `fixtures_sec`、`session_setup_sec`、`renderer_reset_sec`、`cleanup_sec`、`fixture_cleanup_sec`。缓存按 digest 校验的只读 JDK/Maven/样例文件，写时复制到每例自己的目录。在可观测的 UI 或服务状态就绪时结束等待。 | 若每次 native 执行净省 2 秒，三端合计省约 41 runner 分钟，四片并发时每个平台约 3.2–3.6 分钟。若每例净省 5 秒，三端合计省约 102 runner 分钟。必须用 phase 数据证明能省到该值。按相反顺序执行用例，注入前例失败，验证 profile、窗口、进程、服务和结果隔离。 |
| 精简固定等待 | 当前计划 native 用例中，纯数值 `wait` 的静态秒数合计为 Linux 583、Windows 402、macOS 401。各平台最长一个分片内约 3:46、2:50、2:39。其中 `TC-BACKUP-001` 两次等待 65 秒观察备份周期和禁用行为。 | 即使所有声明的固定等待都能省掉，按当前装箱也只有上述单片上限。先处理已有稳定 readiness 的等待，保留观察一个周期、崩溃后恢复等时间语义。 |
| 简化开发分支的重复 UI 验证 | 三端各有 154/153/148 个用例同时支持 browser 和 native。筛选“仅 `reset_db` 且非 crash”的双模式行仍有 46/46/43 次。逐条检查断言。例如 `TC-EXPLORER-012` 的侧栏布局适合先用 browser 迭代，真实 WebView 的几何与系统交互分别留证。 | 双模式重叠只是审查清单。Windows WebView2、macOS WKWebView、Linux WebKitGTK 仍会发现不同回归。若允许分层，使用单独 scope 或覆盖策略、报告每晚和每周的确切集合及最长发现延迟，手工 `all` 始终能重现完整集合。这一筛选组只有 14/14/12 行有历史计时。按现有权重，就算全组都适合迁移，四片平均每平台也只省约 4–5 分钟。实际收益要按审核后的子集重算。 |
| 减轻开发专用二进制或分离前端构建 | 先测生产者内的桌面 Vite、mobile bundle、Cargo workspace crate 和最终链接。热编的 Cargo 阶段仍是 5:49 / 13:03 / 15:56。可验证同一 QA mode 生成的静态前端在三端 hash 是否一致，再考虑一次生成、各端嵌入。macOS 的 krb5 staging 和本地链接留在该端。 | 新增公共前端 producer 会引入等待与下载。用“各端原构建耗时减新增依赖路径”核算。单独的轻量 shell 或精简 features 可服务手工迭代，须标记 binary/features、前后端摘要和 fixture 边界。nightly、性能/安装和 release 崩溃保留匹配的真实构建。 |

`TC-WS-054` 验证 release WebView 冷重启与精确磁盘内容，`TC-MOBILE-013` 验证嵌入 mobile 与真实 PTY，`TC-UPDATE-MACOS-001` 验证签名安装包。它们连同 crash 专项、原生菜单/焦点、系统存储、音频、双屏和真实文件副作用，均需在相应真机边界取证。上轮 Windows 换 linker 造成过 `WinError 14001`，盲目增大 codegen units 也曾延长冷编。涉及 Rust 拆 crate 的成本和收益可用匹配构建参数的 `cargo build --timings` 定位到具体 workspace crate 后估算。[崩溃用例契约](../qa-ui-auto-tests/ci/crash-regressions.md) · [QA 原生构建](../.agents/skills/qa-ui-auto/scripts/native_build.py) · [前端构建配方](../.agents/skills/qa-ui-auto/assets/tauri.qa.conf.json) · [Playwright CI 对浏览器缓存的取舍](https://playwright.dev/docs/ci)

## 6. 全量墙钟如何估算

用历史全量各分片的 job 和 step 时长，换入 A2/B/C 的三端 producer 时长。在同一资源条件下比较策略。每个平台从 producer 结束到最后一个 native 分片结束构成一条路径，browser、合约与这三条路径并行，取最后完成者再加汇总。

| 模型，分钟，四舍五入 | 冷编 | Cargo 暖编 | 完整程序命中 |
| --- | ---: | ---: | ---: |
| 当前四片，macOS 有 4 个有效槽位 | 90 | 80 | 66 |
| 只把 Linux/Windows 普通 native 改为六片，macOS 仍为四片 | 79 | 80 | 66 |
| 上一行加上每例 native 净省 2 秒的假设 | 76 | 77 | 62 |
| 当前四片，macOS 只有 3 个有效槽位 | 118 | 101 | 86 |
| 三个槽位时 macOS 改为三片，Linux/Windows 六片 | 100 | 97 | 94 |

**读法。** 四槽情况下，Windows 六片能让冷编全量约省 11 分钟。暖编和程序命中时尾部转到 macOS，继续扩大 Windows 矩阵几乎没有整轮回报。三槽且程序已命中时，macOS 改三片反而约慢 8 分钟。分支缓存把“冷”变“暖”的价值，与 native 提速的价值应在同一行、同一资源条件下比较。在四槽模型里，从当前冷编 90 分钟到改造后暖编且省 2 秒的 77 分钟，综合约省 13 分钟（14%）。同为暖编则是约 3 分钟（4%）。开发者聚焦验证的实测冷暖差为 18:33，约 32%。表中 76 和 77 分钟的细小倒序来自 macOS producer 释放时已在运行的 browser 组合，可视作同一量级。

**复算条件。** Linux/Windows 四片取最长完整 job。六片取四片执行步骤总和除以 6，再加历史最慢分片的非执行开销（各片分别求差再取最大，Linux 4:41，Windows 8:41）。Linux 双屏独占一片，可并行。macOS 把 1 个 producer、4 个 browser job（20:20、25:03、23:59、17:24）和 4 个 native job（41:50、41:54、38:34、39:02）放入指定槽位。producer 先占一槽，其余槽按耗时长者先跑 browser。之后每逢释放，有已就绪 native 时先取最长 native，空闲槽再取 browser。试三片时把 native 执行工作均分后给每片加历史最大非执行开销。计划与最终汇总合计按 2 分钟，其他并行路径在此样本中未超过最后的 OS 路径。

这是有限槽位回放，假定 Linux/Windows 六个分片可及时启动，并为 macOS 留出了表中写的槽位。跨 OS browser 矩阵节流、runner 临时缺额、其他 workflow 和 cron 创建延迟均会使实际结果偏离。历史失败可能提前结束用例，也可能耗尽超时。当前 main 的计划比历史多 33 次执行，表中采用历史负载，未给新增用例伪造耗时。日常排期仍可按冷编 **90–110 分钟**、暖编 **70–90 分钟**、完整程序命中 **55–75 分钟**作为普通容量下的参考。拥塞时预留两小时以上。

## 7. 工作包与验证

| 工作包 | 实施位置与交付物 | 验收与验证 |
| --- | --- | --- |
| TASK-01 建立实测基线 | 在 `qa_ui_auto/ci.py` 汇总旁增加紧凑时序摘要，复用 `costs.py` 与原始 summary。保存 attempt、输入、就绪/开工/完成、各层 cache 来源/大小/阶段耗时、实际槽位、总 runner 分钟、case 分阶段时长和输出字节。 | **AC-01 / V-01** 用最近的自然夜跑回放基线，保留聚焦/全量、失败/超时和取消的身份。以 UTC 时间重建最后完成路径。来自 cron 的延迟单列。 |
| TASK-02 默认分支依赖与存储 | 修改 `qa-ui-auto-entry.yml`、`qa-branch-artifact/action.yml`、`ci_cargo_artifact.py`，复用已有解包与键。维护每层恢复优先级、来源验证、到期策略和正常冷建回退。 | **AC-02 / V-02** 两个新分支从同一 main 分叉，各自改一行 Rust，同时手工派发。核实三端记录的依赖供给 run 都是受信任的 main。另用与 main 产品输入相同的纯文档提交验证完整程序层，再改 lock/flags 验证失效。过期、损坏、并发写入、同名不可信来源分别覆盖。 |
| TASK-03 重算权重、分片、能力安装 | `ci_sharding.py` 使用最近有效样本和每 OS 候选片数。`ci.py`、`ci_execute.py` 与 entry 共用能力及串行约束。显式 shards、双屏、原依赖顺序、release 扩散和 receipt 均有相应测试。 | **AC-03 / V-03** 对同一 head/输入逐一比较 25 片基线与候选的逻辑组、case 多重集、能力需求与二进制身份，每个计划组合中的用例恰好执行一次。测 4/6 片同缓存级别的墙钟、runner 分钟、每片准备及排队，保留退化样本。 |
| TASK-04 原生启动与 fixture | 从耗时最大的 phase 入手，按独立职责修改 fixture、驱动或工具准备。优先少量有具体副作用断言的场景。 | **AC-04 / V-04** 三端选普通 WebView、冷重启/磁盘、故障后清理各一组，运行 A→B 与 B→A 并验证独立 profile、进程和原始证据。最后用匹配的 release 执行三端完整 crash 套件及受影响用例。 |
| TASK-05 集成与收益核算 | `qa-ui-auto-platforms.yml`、`test_ci_build_pipeline.py`、`test_ci_report.py`，覆盖正常 nightly、分支手工和 PR。用真实夜跑对模型回填。 | **AC-05 / V-05** 至少先有一组同 SHA/同选择的比较，再用连续自然夜跑报告样本数、中位和实际范围。最终汇总仍检出失败、跳过、缺件、身份不一致或重复执行。完整功能验收须有全量通过证据。 |

设计阶段完成了合并提交的本地全量规划、依赖分组计算、GitHub job/step 回放及 `python -m unittest test_ci_sharding test_ci_selection test_crash_regressions`（39 项通过）。实施前可用 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts` 在仓库根目录重跑这些命令。实施时再补缓存来源、过期、capability 和计划等价的负向测试。GitHub 对照采用以下口径。

- 每晚优先利用现有 schedule 采数。另做实验时固定 head、profile、inputs、runner image，分别记录冷、暖和完整程序命中。比较两次全量时保留失败用例的真实结果与失败阶段。用未缩减的选择和最终 receipt 验证是否跑全。
- 针对专门的暖编 benchmark，确定没有可用依赖且开始重编时立刻取消。仅见 runtime miss 时继续查依赖层。可用 B 的 build job 作为观察线，排除队列后若 Linux/Windows/macOS 分别超过约 12/23/24 分钟，立即核实已恢复字节与 Cargo 重编范围，确认明显冷编就取消并先修原因。专测程序复用时，任一必需平台确认完整程序未命中即可取消。正常 nightly 或功能验证走完整回退流程。
- 权重、缓存和片数先通过独立开关切换、逐项对照。任一方案使正确性或队列恶化，回到原 planner/缓存路径，保留失败证据。性能未达到估算值时记录实测，按证据决定后续投入。

| 决策 | 推荐状态及依据 |
| --- | --- |
| DEC-01 每晚覆盖 | 基础方案按用户原有的三端全量与工作流功能要求设计。把纯 UI 跨端轮换列为额外选项，须另行选择覆盖频率并列明延迟。关联 AC-03/04/05。 |
| DEC-02 首轮投入 | 工程建议先用标准 hosted、可信 main 的短期 Artifact 和已有 runner 时序。S3/sccache、专用 Mac、增加付费配额按实际缺口排序。关联 AC-01/02。 |
| DEC-03 性能验收 | 沿用用户已明确的“按实测记录”。上述分钟数用于选择试验，功能通过依据原有汇总和真实覆盖。关联 AC-01/05。 |
