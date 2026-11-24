# QA UI Auto：Maven 传输限流（429）的基础设施韧性

2026-11-24。触发样本：[schedule run 45325474289](https://github.com/engcapa/taomni/actions/runs/45325474289) 的 `linux-native-shard-4` 出现两个基础设施错误：

- `RuntimeError: Java 25 fixture build failed (/usr/bin/mvn -q -DskipTests package): ... maven-resources-plugin:pom:3.5.0 ... HTTP Status: 429`
- `TimeoutExpired: Command '['/usr/bin/mvn', '-q', 'dependency:go-offline', 'package']' timed out after 299.99s`

两者都发生在 Java 预热阶段，不是产品用例或夜间策略的问题：GitHub 托管 runner 共享 Maven Central 的出口，多个 java 分片同时在线下载插件/依赖时被限流；限流后 Maven 还会缓存失败解析，下一次构建直接复用失败结果。整轮因此缺少 22 个用例的结果，`report_ok=False`。

## 改动

1. `ci_maven_warmup.py`
   - 统一的传输失败分类：`Could not transfer/resolve/download ...` 且状态为 408/429/5xx、连接重置、读超时、DNS/拒绝连接、`service unavailable` 时才重试。
   - 重试预算从固定 300 秒改为可配置的 600 秒（`QA_MAVEN_WARMUP_BUDGET`），单次尝试上限 240 秒（`QA_MAVEN_ATTEMPT_TIMEOUT`）；**超时也按瞬时失败重试**，不再第一次超时即放弃。
   - 退避 5s → 15s，共 3 次尝试；每次重试加 `-U` 绕过 Maven 的失败解析缓存；每个尝试保留独立日志。
   - 所有 Maven 命令自动附加 Wagon + Resolver 的 HTTP 重试选项（`retryHandler.count=5`、间隔 2s/上限 10s）。
2. `java25_projects._run_build`
   - Java 25 在线构建（`mvn package`、`gradle build`）同样按瞬时传输失败重试，带退避与有界预算；Maven 命令重试时加 `-U`。
   - 编译错误、401/404 等永久失败仍立即抛出；失败信息保留尝试次数与超时标记。
   - 预热阶段（`ci_toolchains.warm_projects`）使用 480 秒预算，用例内 fixture 使用 300 秒预算，避免挤占 600 秒的用例超时。
3. `qa-ui-auto-entry.yml`：java 能力的 job 统一导出 `MAVEN_OPTS`，给所有 Maven JVM 提供 transporter 级重试。
4. 测试：`test_ci_maven_warmup.py`、新增 `test_java25_build_retry.py` 覆盖真实 429 文本、暂时性 vs 永久性分类、超时重试、预算耗尽、`-U` 只加在 Maven 重试、Gradle 不加 Maven 选项；`test_ci_build_pipeline.py` 锁定 `MAVEN_OPTS`。

## 为什么先不加 `~/.m2/repository` 缓存

仓库 Actions cache 当前 **9.92 GB / 10 GB**，其中 Rust 依赖缓存 7.97 GB，正是上一轮提速的关键。为 Maven 增加 0.2–0.6 GB 缓存会触发按最近访问时间的驱逐，可能把 Rust 缓存挤掉，导致更贵的冷编。因此本轮只做不占配额的重试/退避；若后续清理缓存或提升配额，可再加 `actions/cache` 的 `~/.m2/repository`（键建议含 `toolchains.yaml` 与 fixture pom 哈希）。

## 验证

- 单元：`PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m unittest test_ci_maven_warmup test_java25_build_retry test_ci_build_pipeline`。
- 真实 429 文本已作为分类用例锁定；失败路径只打印并重试瞬时错误，永久错误第一次即失败。
- 下一次夜跑中检查 `linux-native-shard-4` 不再出现 `maven-resources-plugin ... 429` 与 `dependency:go-offline timed out`；若仍出现，日志会保留每次尝试与最终预算耗尽信息。
