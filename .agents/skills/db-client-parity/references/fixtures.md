# 真实 fixture 与 DBeaver 环境

`live-db` 证据和两款客户端的参照必须连同一类真实服务。凭据只通过配置或环境变量传递，不写入文档、证据 JSON、截图标注或提交；证据里记录配置键名和引擎版本，不记录密码。

## MySQL

| 场景 | 来源 | 用法 |
|---|---|---|
| 本机开发 | `qa-ui-auto-tests/qa-ui-auto.config.yaml`（gitignored）的 `database` / `mysql` 块，指向共享测试 MySQL | qa-ui-auto case 声明 `mysql_required` 即读取；Rust/手工验证读同一配置；DBeaver 用同一 host/port/user/database 建连接 |
| 本机容器 | 同一配置中 `fixtures.start_local_mysql: true`（见 qa-ui-auto SKILL 的 Local SSH and MySQL services） | 需要 Docker；本机当前没有 Docker 时不可用 |
| GitHub 托管 | `.github/workflows/qa-ui-auto-platforms.yml` 的 `mysql` capability → `.agents/skills/qa-ui-auto/scripts/ci_services.py` | Linux 用 `qa-ui-auto-tests/ci/services.yaml` 固定 digest 的容器；macOS Homebrew `mysql@8.4`；Windows MySQL 8.4 ZIP。启动后做 `SELECT 1` 与 DML 往返探针，密码来自 `TAOMNI_TEST_MYSQL_PASSWORD` |

本机共享测试库的实际服务端是 **MariaDB 12.1.2**（2026-09-30 用 DbVisualizer 连接确认），CI 为 MySQL 8.4。二者方言与驱动行为可能不同，证据里写实际服务端版本，不统称 MySQL。

共享测试库规则：每次运行使用独立对象名（如 `dbv_<卡号>_<run>` 前缀的表/schema），结束时清理本次对象；不修改、不删除他人对象；不执行影响整库的操作（`DROP DATABASE`、全局变量、用户权限）。需要这类操作的场景只在容器或 CI 一次性实例中运行。

## 其他 SQL 引擎

PostgreSQL、Oracle、SQL Server、ClickHouse、Presto/Trino、StarRocks、PanWeiDB 目前没有 CI 或本机 fixture。卡的 `scope` 包含这些引擎时：

- 先由 P0 建设施卡（`DB-GATE-*`）：在 `ci_services.py` 增加 capability、在 `services.yaml` 固定镜像 digest、增加就绪探针和 case 字段，作为功能卡依赖；或
- 使用用户提供的服务器（记录由用户提供、版本、可复现条件）。
- 都没有时该引擎的 `live-db` 记入 `unrun`，结论上限为“未验证”。

## HBase

- 现有 Rust 真集群测试以 `HBASE_LIVE_TEST=1` 开启，`HBASE_ZK` 指定 ZooKeeper（默认 `127.0.0.1:2181`），用 `cargo test --lib hbase -- --test-threads=1`（在 `src-tauri/`）。
- CI 和本机都没有 HBase 自动 fixture。P0 首次运行时产设施卡：Linux 托管 runner 起 standalone HBase 容器（固定 digest、ZK 端口映射、`status`/建表探针），并让 HBase case 声明对应 capability。设施卡完成前，HBase 功能卡的 `live-db` 依赖用户提供的集群。
- Thrift2/Lindorm 后端只能用用户提供的 endpoint；没有时记为未验证。
- DBeaver 侧的 Phoenix 驱动需要服务端安装 Phoenix；fixture 不含 Phoenix 时，HBase 参照只取 PRO NoSQL 编辑器的交互模式（见 [domains](domains.md#hbase-域-hb)）。

## 客户端安装与启动

DbVisualizer：

- Windows 开发机的安装位置为 `C:\software\DbVisualizer\dbvis.exe`（Pro 25.1.3，环境变量 `DBVIS_HOME` 优先）。安装文件依据见 [reference-capture](reference-capture.md#三种依据按成本从低到高)。
- 用户日常使用的实例常驻运行。用户已授权在该实例中做交互实测，前提是：只在新开的 SQL Commander 标签和对象视图标签中操作，不在用户已有标签中输入，不保存、不关闭它们；结束后恢复窗口原状态。实例中已保留测试连接 `taomni-qa-mysql (parity test)`（指向共享测试库），复用它，不要重复建连接。
- 许可证状态以窗口标题或 About 为准。新 userdir 可能需要重新激活，激活由用户完成。

DBeaver：

- 查找顺序：环境变量 `DBEAVER_CE_HOME` / `DBEAVER_PRO_HOME`，然后 Windows 开发机 `C:\software\dbeaver-ce-<版本>\dbeaver.exe`、`C:\software\dbeaver-pro-<版本>\dbvr.exe`（均为 ZIP 解压、自带 JRE）。PRO 26.x 的产品名为 `dbvr-pro`（官方 `dbeaver.com/files/dbvr-pro-latest-<os>-<ext>`），配置文件为 `dbvr.ini`。macOS/Linux 用官方包，路径记入参考包。
- 已实测：CE 26.2.1 首次启动先出现 Product Configuration 向导（直接 Apply 默认值）；MariaDB 驱动经 `dbeaver.ini` 中的代理自动下载。默认窗口太小，结果集底栏显示不全，采集前先调用 `desktop_ui.ps1 -Action move` 调整窗口大小。
- 每次采集用隔离工作区：`dbeaver.exe`（或 `dbvr.exe`）`-data <qa-ui-auto-report/client-reference/_workspace/<run>>`，不使用用户默认工作区。
- PRO 需要许可证或试用激活，由用户本人完成；agent 不代填账号、许可证或付款信息。未激活时只采集可用部分，其余记为未观测。
- 驱动下载需要外网时，按本机代理设置（用户提供；不要把内网代理地址写入入库文档）配置 DBeaver 的网络代理偏好，或以 `-vmargs -Dhttps.proxyHost=... -Dhttps.proxyPort=...` 启动。记录驱动名称与版本。
- 参考包记录 DBeaver 版本来自 Help → About 或安装目录 `.eclipseproduct`，不从目录名推断。
