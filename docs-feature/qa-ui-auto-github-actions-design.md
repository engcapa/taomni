# qa-ui-auto 三平台 GitHub Actions 设计

## 1. 目标、状态与已定范围

本设计让同一套 `qa-ui-auto` YAML 在 Linux x64、Windows x64、macOS ARM64 上分别执行 browser/native，并支持手动触发、其他 workflow 调用、夜间执行，以及按代码修改或显式范围选例。复用现有 runner、隔离 QA app 和执行证据，不另建一套通过判定。

- 来源：2026-09-20 用户要求重新设计 workflow 和 SSH/MySQL/JDTLS 基础设施；随后明确“三端仅手动或夜间运行，PR 保持轻量”，并要求 flow 触发、按代码修改指定范围；最终要求新增独立 workflow，原有流程仅参考，暂不影响 PR 合并与 release，以报告或 issues 追踪问题。
- 基线：`6e292fd3cfb638deffc3805a447fea11275fc01f`；调研时工作区干净；当前工作机 Linux x86_64。
- 本轮产物是详细设计，文中拟新增文件、参数、workflow 和测试尚未实现，不代表已经通过三端 CI。
- 设计状态：可进入实现；采用各端 runner 本地服务，不要求专用主机。三端图形会话、Linux fcitx5 及 Windows/macOS SSH 最小环境探针是先行任务。所有 hosted jobs 必须完全无人值守，包括服务安装、图形准备、权限预检、测试与清理；第 7 节定义自动化必跑范围与 hosted 覆盖缺口，不以人工授权作为执行或验收环节。
- 三端指上述三个 OS/架构组合，不包含 Linux ARM64、Windows ARM64、macOS Intel 的额外矩阵。
- native 使用 `com.taomni.app.qa` debug 构建及内嵌生产前端；不等同于发行安装包签名/升级测试。

### 决策

| ID | 决定 / 选项与影响 | 状态与来源 | 关联 |
|---|---|---|---|
| DEC-01 | 新建独立 workflow；手动、夜间和 workflow_call 触发；不编辑原有 PR/release/e2e/native workflow，不新增 branch protection required check。已有流程可能仍按原配置运行 | 用户已定：两次补充；后一次“不影响原有流程”覆盖先前原位瘦身建议 | AC-01 / TASK-04 / V-04 |
| DEC-02 | 各平台 hosted runner 本地安装服务：Linux Docker、Windows OpenSSH/MySQL、macOS OpenSSH/MySQL；JDTLS 始终本机。独立 Ubuntu runner + 私网作为未来选项，Codespaces 不作默认服务主机 | 用户明确无专用 Linux 主机、偏好本机；agent 根据最少外部依赖收敛 | AC-04 / TASK-02 / V-02 |
| DEC-03 | flow 触发以 `workflow_call` 可复用工作流实现；调用方可在已有流程的 `needs` 后调用；不默认增加 `workflow_run` 链式触发 | agent 自决：满足已有 flow 调用且避免重复调度和错误 checkout | AC-01 / TASK-04 / V-04 |
| DEC-05 | 默认 Actions Summary + artifacts；可选同步去重 GitHub issues。新 QA 可失败但不作为 PR 合并或 release 前置条件 | 用户已定“不影响 PR/release”；报告优先和 issues 默认关闭为 agent 自决 | AC-07/08 / TASK-05 / V-05 |
| DEC-04 | 选择结果先生成不可变 manifest，再准备依赖；必跑集合使用 `--require-pass`。平台不适用、hosted 不可用能力、未评审证据分别记录，不能在运行后随意排除失败 | agent 自决：沿用 skill 的证据和 skip 契约 | AC-02、03、08 / TASK-01、05 / V-01、05 |
| DEC-06 | native 必须有可用图形会话；Linux 提供 Xvfb + WM + DBus + 按需 fcitx5；macOS 使用自身 WKWebView snapshot。全部 hosted jobs 无人值守，不能依赖人工授权；不能自动完成的系统能力报告覆盖缺口 | 用户明确 GitHub macOS runner 无人值守；修订原“交互验收”补位方案，源码依据不变 | AC-10/11/12 / TASK-06 / V-07/08/09 |

## 2. 当前事实与必须解决的缺口

| 依据 | 当前事实 | 设计处理 |
|---|---|---|
| `.github/workflows/e2e.yml` | PR Linux smoke；push main 跑 Linux/Windows browser；手动可增加 macOS；未强制 selected 全部 pass | 原文件不修改；新 workflow 独立实现六组合 |
| `.github/workflows/qa-native.yml` | 定时/手动只跑 Linux、Windows 的 `TC-NATIVE-CORE-001` | 原文件不修改；新 workflow 使用独立名称、concurrency group 和错开的夜间时间；未来停用旧入口另行决定 |
| 2026-09-19 [native Actions](https://github.com/engcapa/taomni/actions/runs/35468773305) | Linux 1 pass；Windows 构建成功但 setup 超时；status 输出有 charmap 编码错误 | 保留 Linux 基线；分别修复 Windows setup 和 UTF-8，不通过加大 case timeout 掩盖原因 |
| 2026-09-18 [browser Actions](https://github.com/engcapa/taomni/actions/runs/35353829438) | Linux 124 pass / 2 fail / 42 skip；Windows audit 输出编码失败 | 全集执行不能按历史绿色 smoke 认定通过；缺依赖与产品失败分开处理 |
| `scripts/tauri_webdriver.py: TauriDriverProcess.start`（本节脚本相对 `.agents/skills/qa-ui-auto/`） | macOS 启动内置 bridge，但 readiness 同时等待 host port 与 native port；Rust `src-tauri/src/qa_driver.rs::start` 只绑定前者 | Darwin 检查单一 bridge `/status`；Linux/Windows 等待中间层和底层驱动；补回归 |
| `src-tauri/src/qa_driver.rs::screen_capture`、`scripts/qa_ui_auto/native_steps.py` | macOS 截图依赖桌面 screencapture；Linux 输入要求 WM/XTest，IME 要求 wbpy，clipboard owner 要求当前 Python/Tk | 第 7.1～7.5 节新增完整图形栈及权限方案；这些前提不能用 driver 安装成功代替 |
| `scripts/qa_ui_auto/service_fixtures.py` | 已有 Docker SSH/MySQL，固定容器名；显式 opt-in；MySQL 有真实 SQL 探针 | 复用配置/探针契约；CI 服务增加租约与唯一 namespace，不能删除另一个 job 的固定名称容器 |
| `scripts/qa_ui_auto/fixtures/jdtls_required.py` | 目前只检查 PATH 上有 `java` | 不足以证明 JDTLS 可执行或 provider 初始化；分离 JDK/JDTLS/bundle 能力探针 |
| `src/stubs/tauri-core.ts` | browser LSP/Java 路径是 stub / unavailable 契约 | browser 安装 Java 不会变成真实 provider 测试 |
| `scripts/qa_ui_auto/verification.py::plan` | 已支持 feature/covers/diff；共享、未映射代码保守扩选；普通 renderer 修改可能不推荐双模式 case 的 native | 复用映射和保守规则；CI 六组合在选定 case 集合后依据实际 modes 展开，不直接执行推荐命令当完整 CI 计划 |
| 当前 YAML 只读盘点 | 231 个 case，174 声明 browser、67 声明 native，存在双模式；42 个 SSH、14 个 SFTP、3 个 MySQL、15 个 jdtls_required，另有 Java 25 和 java-test fixture | 数字是该提交的声明数量，不是通过数；实现按运行时目录生成，不硬编码数量 |

另外两处需要纳入选例和环境契约：

1. `TC-auto-F-DB-1-query-tab-rename-native-restore` 明确依赖先执行 rename case，且共享该 invocation 的 QA 状态。不能单独选择 restore 或拆到另一台 runner。
2. `java25_projects.py` 使用 `mvn -o`、`gradle --offline`，并存在 `/data/dev/jdk-25` 本地路径探测。冷 CI 不具备其缓存；必须先在线预热匹配样例和插件，再执行离线断言，使用显式 JDK 配置，修复 Windows `.cmd/.bat` 启动和 Gradle 发现。

## 3. 验收条件

| ID | 可观察行为 |
|---|---|
| AC-01 | 手动、夜间、workflow_call 共用执行内核；默认六组合；可只选某平台/模式；新 workflow 不监听 PR/push，原有流程不变；不设置为合并/release 门禁 |
| AC-02 | 指定 case/feature/tag 或 base/head 后，构建前展示具体 case、每个选择原因、差异、依赖与排除项；未知 ID、坏 ref、空的显式选择报错 |
| AC-03 | 改动一个映射文件选择关联 case；共享/未映射运行时代码保守扩选；删除和重命名不漏选；只选 restore 自动带上前置 case，并保持同 invocation 与顺序 |
| AC-04 | Linux/Windows/macOS 上被选中的 SSH/SFTP、MySQL case 都有本机可认证的真实服务；Unix 远端专用断言在 manifest 明确区分；不同 job/worker 的可变数据互不影响；服务缺失时失败，不能跳过变绿 |
| AC-05 | Java provider case 获取匹配架构的 JDK/JDTLS；需要时准备 JDK 25、Maven、Gradle、Java debug/test 完整依赖；冷缓存也能运行；真实 provider 初始化和语义结果可验证 |
| AC-06 | 三端原生 QA 二进制具有有效身份记录；Linux WebKitGTK、Windows WebView2、macOS WKWebView 成功启动并执行本地 shell/UI/IPC case；macOS 不安装或启动 tauri-driver |
| AC-07 | 六组合均上传本次选择、环境、结果、receipt 和失败证据；失败/超时/取消清理所拥有资源；可选去重 issue 追踪；缓存不包含 vault、可变 DB、SSH 凭据或个人数据 |
| AC-08 | 最终固定名称 check 在任一必需 job 失败、缺报告、selected skip、receipt 不匹配时失败；平台不支持不记 pass；结果可追溯至请求的 head、工具代码和 case 版本 |
| AC-09 | 保留本地 CLI、Docker opt-in、browser 新 context、native 串行、QA 隔离、旧构建拒绝和历史失败留存；CI 变化不要求开发者配置远端服务 |
| AC-10 | native 每个 job 在执行 case 前证明 display/session/窗口可见、聚焦及截图能力；无 display、Session 0、锁屏或不可连接 WindowServer 时给出明确环境失败，不等待整套 case 超时 |
| AC-11 | Linux 的 IME case 经 XTest → fcitx5/wbpy → GTK/WebKitGTK 真实输入；证明提交、取消、undo 与焦点结果；断开 DBus、缺 engine 或 GTK IM module 时预检失败，不能用 synthetic composition 替代 |
| AC-12 | macOS 明确区分 WebView 内操作、系统输入、桌面捕获和权限弹窗；基础 native 不依赖人工授予屏幕录制；系统权限缺失不假装通过，报告 actor、权限状态和 hosted 限制；从准备到结束不等待人工确认 |

## 4. Workflow 划分与调用契约

### 4.1 文件职责（均为目标设计）

重测试矩阵的 label 固定为 `ubuntu-24.04`、`windows-2025`、`macos-15`，分别展开 browser/native。`plan` 在编译前上传选例结果；`execute` 使用 `fail-fast: false`；`summarize` 总运行；`publish-issues` 按输入独立运行。concurrency key 包含新 workflow 名、事件/调用标识与 ref；不复用原有 E2E/native group，不让两条手动不同范围的诊断互相取消。

| 文件 | 职责 |
|---|---|
| `.github/workflows/qa-ui-auto-platforms.yml`（新增） | `workflow_dispatch`、`schedule` 和 `workflow_call` 三入口；validate/plan → 六组合 execute → always summarize → 可选 issue sync。夜间 UTC `17 19 * * *`，对应北京时间次日 03:17，避开现有 native schedule |
| `.github/workflows/e2e.yml`（只读参考） | 不编辑其 triggers、jobs 或检查名称，PR 合并要求保持原样 |
| `.github/workflows/qa-native.yml`、`release.yml`（只读参考） | 不删除、不改触发或依赖；新 workflow 不作为 release 的 needs |
| `.github/actions/qa-runtime/action.yml`（新增） | Node/pnpm/Python 和按平台配置的 native toolchain；不在这里决定范围、不掩盖失败 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py`（新增） | 验证输入、生成 manifest、环境预检、消费本机 matrix entry、编排后台任务、汇总已有 runner 证据 |
| `qa-ui-auto-tests/ci/{policy,dependencies,toolchains}.yaml`（新增） | CI 可执行性、case 依赖链、工具版本和 hash；不得复制 feature/covers 真源 |

`workflow_call` 由调用方通过 job `uses: ./.github/workflows/qa-ui-auto-platforms.yml` 调用，或用仓库路径加固定 ref。调用方设置 `needs` 决定它在原流程中的位置。被调用流程验证 `head`，执行 jobs 全部 checkout 同一个解析后的 SHA。默认不使用 `workflow_run`，也不自动触发发布。

### 4.2 输入（dispatch 与 call 同名同语义）

| 输入 | 类型 / 默认 | 契约 |
|---|---|---|
| `scope` | choice/string，`smoke` | `smoke`、`all`、`impacted`、`selected`；夜间强制 `all` |
| `head` | string，空 | 空为该事件 `github.sha`；解析为 commit SHA 后固定；所有 job 使用解析值 |
| `base` | string，空 | `impacted` 必填；由 caller 传入 PR base SHA 或业务基线；不悄悄用 HEAD~1 |
| `platforms` | CSV string，`linux,windows,macos` | trim/去重；只接受枚举，避免把不可信字符串当 runner label |
| `modes` | CSV string，`browser,native` | 同上 |
| `case_ids` | CSV string，空 | 精确 ID，不是正则；未知值失败 |
| `features` | CSV string，空 | 精确 feature ID，通过 feature-list/covers 映射 |
| `tags` | CSV string，空 | 多 tag 是并集；未知 tag 失败 |
| `publish_issues` | boolean，`false` | 有失败时按规则创建/更新 issue；夜间读取仓库变量 `QA_UI_AUTO_PUBLISH_ISSUES`，未配置即 false |

选择语义必须固定：

- `selected`：`case_ids ∪ features 命中的 case ∪ tags 命中的 case`，然后补前置依赖；三个输入全部空则失败。
- `impacted`：差异推荐集 **并上**上述显式集合，再补依赖。显式参数用于补选，不能悄悄缩小保守影响面。想明确限制范围时使用 `selected`，报告标注“限定范围，不证明全部影响”。
- `smoke` / `all`：拒绝额外 selectors，避免用户误认为它们会过滤；smoke 来自已审核的 CI 核心集合；all 是所有受该 mode/platform 支持的 CI case。
- 一个 case 在不适用的组合列入 `not_applicable`；显式请求的 case 若在所有所选组合都不可运行则报错，而不是成功执行零项。
- `all` 若存在尚未声明归属的 case，则 planning 失败；不能只靠旧 allowlist 永久漏掉新 case。

未来调用示例（目标 workflow 实现后才可使用）：

```yaml
jobs:
  qa:
    uses: ./.github/workflows/qa-ui-auto-platforms.yml
    with:
      scope: impacted
      base: ${{ github.event.pull_request.base.sha }}
      head: ${{ github.event.pull_request.head.sha }}
      platforms: linux,windows,macos
      modes: browser,native
      publish_issues: false
    # 不需要外部测试机 secrets；默认 GITHUB_TOKEN 只读。
```

上例展示 caller 接口，不建议直接加进默认 PR 重流程。原有 PR 保持现状。新 workflow 使用只读 GITHUB_TOKEN 执行被测代码；issue 写权限只授予独立的结果发布 job，不暴露给测试进程。issues 仅在受信任的仓库调用中启用；不使用 `pull_request_target` checkout PR 代码后注入写凭据。调用已有 release 流程的示例仅说明可复用接口，本次不把它加进 release。

## 5. 差异选例、能力和执行计划

### 5.1 确定的 diff

planner 使用 `fetch-depth: 0`，校验 `base^{commit}` / `head^{commit}`；参数经 argv 传给 git，禁止拼入 shell。记录 base、head、merge-base 和计算方式。`impacted` 固定比较 `merge-base(base, head)..head`；需要比较两个精确快照的后续能力另设契约，不混用 two-dot/three-dot 自动 fallback。基线无法解析就失败。

使用 `git diff --name-status -z -M`，保留删除路径与 rename 的两端。通过现有 feature `files`、case `covers`、变更 YAML 本身选例。需要处理已删除的 feature 映射时读取 base 版本目录参与影响归属；已删除 case 只报告移除，不伪造执行。

- 已映射的模块修改：选择相关 feature/case，扩展已有共享消费者映射。
- `src/lib/`、`src/stores/`、`src/hooks/`、`src-tauri/`、runner、schema、公共配置/锁文件等共享修改：先保守扩到 CI 兼容全集。以后细化映射必须有回归证据。
- 未映射的运行时代码：同样保守扩选，并在报告中列出未映射路径。
- skill prose、普通文档：不启动产品矩阵；执行相应轻量静态检查。测试工具 `.py`、workflow、CI policy 不是普通文档，必须触发自身验证及相关执行路径。
- 文档-only 导致空矩阵是明确 `no_relevant_changes`，最终报告显示 0 执行及原因，不能显示“六平台测试通过”。显式选择空集始终失败。

### 5.2 计划与依赖

新增 `selection.json`（`qa-ui-auto.ci-selection.v1`），包含：请求参数、workflow/tooling SHA、tested head SHA、base/merge-base、changed paths、catalog/runner hash、每个平台/mode 的 `selected_ids`、`ordered_groups`、选中原因、必需 capabilities、not-applicable/hosted-unavailable/unreviewed 清单。

矩阵只携带 `entry_id`、固定 runner label、平台、架构、mode；长 case 列表作为 artifact 文件传递，避免 Windows 命令行长度限制和 Actions output 大小限制。增加 runner `--selection PATH --selection-entry ID` 接口，复用 `TestCase` 和原 runner 执行，禁止与 `--filter/--tag` 混用。文件中的 repo 路径、case ID、顺序、hash 在每个 job 开始时重新校验。

`dependencies.yaml` 初始登记 rename → rename-restore。planner 自动补依赖，检查 DAG 无环，形成不可拆分、有序的 group；native 同一个 invocation 共用该 group 的 QA profile。group 之间仍按现有 reset_db/生命周期隔离。未知依赖、跨 mode 不兼容、前置 case 被排除都失败。以后 case 不能通过名称排序暗含依赖。

capability 映射从 fixtures 与必要的语义补充生成，例如：

| 来源 | 所需能力 |
|---|---|
| `ssh_required` / `sftp_required` | `ssh-auth-shell` / `sftp-rw`，使用同一隔离服务 |
| `mysql_required` | `mysql-query` |
| native `jdtls_required` | `jdk21+`、`jdtls-provider` |
| `java25_projects` | `jdk25`、`maven`、`gradle-java25`、已预热构建依赖；需要 provider 的 case 再加 JDTLS |
| `java_test_bundle` | 完整 Java test bundles；需要调试的用例加 debug bundle |
| `linux_x11_required` 或 Linux-only verbs | `x11-input` 等，其他平台明确不适用 |
| 任意 native case | `native-display`、`native-window`；截图另外声明 `webview-snapshot` 或 `desktop-capture` |
| `native_ime_keys` | Linux `x11-input`、`session-dbus`、`gtk-fcitx5`、所需 engine（当前为 `wbpy`） |
| 系统输入/授权/系统 dialog 专属断言 | 精确的 `os-input`、`accessibility`、`screen-recording`、`system-dialog` 等；不得从普通 WebDriver verb 推导已经覆盖 |

case 的 fixtures 不总是完整需求真源：调试 case 可能通过后续 UI 设置使用 bundle，必须审核实际步骤补足能力。`TC-IDE-C6-02` 目前断言 browser `No LSP`，应移除误导性的 `jdtls_required`（保留原 unavailable 断言），而不是安装 JDTLS 后宣称真实语义查询通过。

`policy.yaml` 只记录 capability 补充、已知 OS 限制、hosted 能力限制和核心集合；不放“失败就排除”的条目。hosted-unavailable 排除需明确不能在 hosted runner 证明的边界与依据；不安排等待人工的执行步骤。`needs-review`/`legacy-imported` 可以实际执行，但报告不得宣称已经获得审核后的产品覆盖。完成评审与执行通过是两个状态。

## 6. 基础设施准备与生命周期

### 6.1 公共协议

每个执行 job 从计划计算依赖，按照 `allocate → start → protocol-check → seed → ready → run → collect → destroy` 工作。启动与协议探针失败直接使该 job 失败；不降级为 stub，不把服务未准备转换成可接受 skip。

服务适配器输出 `ServiceLease`：`namespace`、SSH/MySQL 地址端口、env 引用名、可变数据根、创建/过期时间、资源 ID、cleanup handle。凭据只在 job 环境和受限临时文件中，artifact 保存脱敏 capability/version/health/lease 摘要；不上传完整环境变量、密码配置或密钥。

namespace 至少包含 repository、run_id、run_attempt、matrix entry；browser 并行的可变服务测试再包含 worker/case。第一版可把所有 SSH/SFTP/MySQL case 分到 `workers=1` 的服务批次，renderer-only 批次并行；在拥有每 worker 独立用户/目录/数据库且有并发验证后再扩并发。不同批次仍上传多个原生 runner report，不合成伪造的 summary。

SSH/SFTP 探针必须完成密码认证、非交互 exec 输出随机 nonce、PTY shell echo、SFTP 上传/下载/比较/删除；TCP/banner 只作启动等待。Unix 服务的种子远端目录使用 `/tmp/qa-ui-auto/<namespace>/temp`；Windows 使用测试账号 home 下的独立 `temp` 目录，路径由实际 SFTP/shell 探针分别记录。各端都创建有不同名称/大小的文件，满足 `TC-012` 的路径断言和 `TC-027` 排序样本。更推荐后续用 fixture 值替代含糊硬编码 `temp`，不降低行为断言。

MySQL 探针从**测试 runner 访问的最终地址**用测试用户执行 `SELECT 1`、`SELECT DATABASE()` 及一次隔离表写读删。数据库配置同时填 `database` 与兼容 `mysql` 段；默认数据库 `test`，保证 information_schema 可读，满足当前 qualified-name case。端口默认 SSH 2222、MySQL 3306；若占用可分配空闲端口并写入配置，不能杀掉未知监听进程。

### 6.2 首选：各平台 runner 本机服务

服务仅绑定 `127.0.0.1`。安装/账号创建仅允许在 GitHub-hosted 的一次性 VM 中执行，脚本检查 `GITHUB_ACTIONS=true` 与 runner 环境；本地开发仍走现有 opt-in Docker 或用户配置，不自动修改开发者机器账号、服务和注册表。

| 平台 | SSH/SFTP 准备 | MySQL 准备 |
|---|---|---|
| Linux | 复用现有 Docker SSH fixture；固定 image digest，唯一容器名，独立用户/目录；补认证/PTY/SFTP 探针 | Docker `mysql:8.4` 固定 digest，容器独立 volume；从 host 最终端口验证 SQL |
| Windows x64 | 安装/复用 Microsoft OpenSSH Server 二进制，在本次 RUNNER_TEMP 创建专用 sshd_config、host keys 和日志；创建随机临时本地非管理员账号，允许密码认证，配置独立端口；启动过程由当前 hosted runner 管理员权限完成 | 下载固定 MySQL 8.4 Windows x64 ZIP 并校验 hash；在 RUNNER_TEMP 初始化独立 datadir，以前台 `mysqld --defaults-file=... --console` 后台托管，不覆盖系统 MySQL |
| macOS ARM64 | 使用系统或 Homebrew OpenSSH，在本次临时目录生成配置/host keys；创建临时测试账号并设置独立 home；验证 Apple sshd/PAM/Remote Login 权限，如系统版本受限则先验证 Homebrew OpenSSH 路径；不依赖用户交互授权 | 安装 Homebrew `mysql@8.4`，记录/校验实际版本与 ARM 架构；在 RUNNER_TEMP 初始化 datadir 并直接启动 mysqld，不使用全局 brew services 数据目录 |

每次随机生成测试密码，在输出前 `::add-mask::`；密码通过受限文件、stdin 或 env 传给安装工具，不写入 workflow 明文，不需要仓库 SSH/MySQL secret。MySQL 初始化临时 root 仅用于创建 test 用户、test 数据库和种子数据；应用用受限 test 用户访问。

OpenSSH 配置禁 root 登录，只允许专用账号；Windows 文件 ACL 必须同时满足 sshd host key/config 与测试 home 的访问要求。安装探针在 native 编译之前运行，避免编译几十分钟后才发现 PAM/账号/服务不可用。服务准备失败即保留错误和日志，不标已支持。

**SSH 远端平台是独立维度。** Linux runner 的本机 sshd 是 Linux 远端，Windows 是 Windows 远端，macOS 是 macOS 远端；不能把后两者宣称为“连接 Linux server”覆盖。标准登录、shell echo、SFTP 文件往返应在三端都有代表用例；`/proc`、Linux 性能监控、Unix 权限、Linux shell 工具链等用例按真实 remote capability 分组。

Windows 首选产品实际支持的远端 shell；若选 Git Bash 作为 PTY shell，在一次性 VM 上设置 OpenSSH DefaultShell 并记录原值/恢复，不把 PowerShell 输出模拟成 bash。SFTP 路径与 shell `pwd` 路径分别通过实际探针获得，例如 Win32 SFTP 的 `C:/...` 与 Git Bash 的 `/c/...`；fixture 提供 `remote_test_dir`、`remote_shell_test_dir`，case 验证规范化后的同一真实目录，不能机械比较两个语法不同的字符串。不得建立一个仅返回固定 echo/ls 输出的假 SSH server。

`policy.yaml` 增加 `remote_capabilities`：标准 SSH/SFTP/PTY 与 Linux-only remote assertions 分开。三端必跑核心集合至少各有一条真实 SSH 登录/命令、一条 SFTP 写读、一条 MySQL query；不能因为全量 case 依赖 Linux 远端而把某端所有服务测试排空。Linux 专属场景在其他本地 provider 上标记 capability gap，并在最终报告展示；若要求在 Windows/macOS 客户端测试同一 Linux 远端，需启用 6.3 的扩展方案。

并发隔离第一版按 job 使用一套服务、service batch 串行；需要同时运行多个 service batch 时必须扩展 namespace/账号/database，不能仅增加 workers。正常结束删除当前 namespace 的用户/keys/datadir；VM 异常终止后 GitHub 的临时 VM 销毁作为兜底，不触碰同机其他服务。

### 6.3 独立 GitHub runner / Codespaces 的可选扩展

一台独立 Ubuntu Actions runner 可以运行 Docker 服务，但另一个 Windows/macOS runner 不能访问它的 localhost，job 之间也没有自动共享的私网。跨 job 服务必须增加临时私网（例如具备 job ACL 的 overlay）或受控隧道入口；这不是多写一个 `needs` 就能解决。

若以后采用该方案：一个短 plan job 之后并行启动 service 与 consumers；service 发出按 run/attempt 关联的 ready 状态，consumers 完成后服务退出。不能让 consumers `needs` 一个常驻 service job，否则它们只能在服务已经退出后开始。服务需独立租约、限时退出、取消回收和不含秘密的状态协调；私网授权需要额外凭据或受限 workload identity。

Codespaces 是可独立启动的开发 VM，可通过其 SSH/端口机制承载服务，但需要 Codespaces 创建/连接权限、可用配额与计费、生命周期清理；私有 forwarded ports 不等同于可直接连接的原生 MySQL/SSH TCP endpoint。它比本机 fixture 增加了依赖，本轮不采用，也不要求用户准备它。

### 6.4 JDK / JDTLS / Maven / Gradle / bundles：始终在被测 runner 本地

Java provider 必须读取本机隔离工作区并由真实 Taomni 启动，不能把服务放远端后声称验证了本地 JDTLS。

1. `actions/setup-java` 安装固定 Temurin JDK 21；选中 Java 25 case 时另装 JDK 25。区分 tooling JDK 与项目 JDK，显式导出路径并在 receipt 记录，不修改 HOME。
2. 用 `toolchains.yaml` 固定 JDTLS distribution URL、版本、SHA-256、支持的 JDK，以及 OS/arch 配置目录。下载后校验 launcher jar、plugins、`config_linux`/Windows/macOS 对应内容；选择分发包真实提供的 ARM64 配置，不能猜目录名或误用 x64 fragment。
3. 设置 `JDTLS_HOME`，将可执行 wrapper 加入 PATH。Windows 与 `src-tauri/src/lsp.rs::build_jdtls_java_command` 的 `config_win`、`JDTLS_HOME` 契约一致；macOS/Linux 使用生产 launcher；测试不得另造 provider 替代实际链路。
4. 安装固定 Maven/Gradle；Gradle 版本明确支持所选 Java 25。先对与 fixture 等价的隔离样例在线构建预热，再执行 `java25_projects` 的 offline 构建。cache miss 必须也成功；不能把预置开发机缓存当 CI 前提。
5. 下载固定版 Java debug/test 扩展分发并校验 hash。保留 `server/` 全部必需依赖，而不是只拷一个 plugin jar。通过 `QA_JAVA_TEST_BUNDLE`、`QA_JAVA_DEBUG_BUNDLE` 和现有 UI 设置链路注入，不依赖 runner 安装 VS Code。
6. 预检 `java -version`、`javac -version`、`mvn --version`、`gradle --version` 与架构；实际 provider 验收由 native app 打开复制的 Maven 项目，等待初始化完成，验证一条真实诊断/补全/执行结果。仅 `java` 在 PATH 或进程存活不算 ready。
7. 缓存只存只读分发和依赖下载缓存；key 包含 OS、arch、工具版本、hash、样例依赖描述。JDTLS `-data` 索引、测试项目输出、QA profile 不跨 job 共享。

## 7. 六组合执行环境

| 组合 | runner / 依赖 | 执行与边界 |
|---|---|---|
| Linux browser | `ubuntu-24.04` x64；Node 22、pnpm 10、Python 3.12、Playwright Chromium with-deps | 本 checkout Vite 5000；renderer 批次并行；真实 SSH/SFTP 经 Vite bridge；不是 native 证据 |
| Windows browser | `windows-2025` x64；相同前端工具、Chromium | UTF-8；Windows 后台启动使用已有 background_job；服务连接本机 OpenSSH/MySQL endpoint |
| macOS browser | `macos-15` ARM64；原生 ARM 工具与 Chromium | 校验 runner.arch/实际进程架构；Cmd/Meta 与平台 UI 声明按 case 执行 |
| Linux native | `ubuntu-24.04` x64；Rust >=1.94、protoc、完整 Perl、Tauri GTK/WebKitGTK deps、WebKitWebDriver、tauri-driver；第 7.2 节完整图形/IME 栈 | 真实 fcitx5/X11 输入可以验证；物理键盘、Wayland、GPU/桌面性能不从 Xvfb 推导 |
| Windows native | `windows-2025` x64；MSVC、protoc、Strawberry Perl、WebView2、匹配 msedgedriver、tauri-driver | 完整交互桌面/WebView2 session 探针；记录 runtime/driver 版本和启动日志；native 串行 |
| macOS native | `macos-15` ARM64；Rust、protoc、Xcode tools、Homebrew MIT krb5 | 设置 LIBGSSAPI_IMPL/PREFIX、PKG_CONFIG_PATH；按现有 bundle hook stage krb5；QA debug WKWebView bridge；无需 tauri-driver |

native 的平台准备复用 `.github/workflows/release.yml` 已验证的依赖，保留 QA 构建路径和 config overlay。由 `native_build.py` 一次构建/复用本 job 的产物，原 identity/source 校验继续强制。macOS 不执行发行签名、公证、Intel 交叉构建；本需求不需要那些发布副作用。

所有 job 设置 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`PYTHONUNBUFFERED=1`；脚本文件读写显式 UTF-8。browser 配置使用 `http://127.0.0.1:5000` 并设置 `DEV_PROXY_ALLOW_PRIVATE=1`；启动后确认该 Vite 服务来自本 checkout。native 沿用 harness 的 open 语义，不启动多余 Vite。

Vite、服务、构建、case 批次通过现有 `background_job.py start/status/wait/stop` 管理，状态文件存本次 report 根；后台命令退出码必须返回 job。Windows runner 实测 WMI detach、PATH/env 继承和 stop 行为。Linux `xvfb-run` 的生命周期包住 native 测试进程；不把 Xvfb 单独启动后丢失 DISPLAY。

矩阵 `fail-fast: false`，一个平台失败继续保留其他平台证据。初始超时建议 browser 60 分钟、native 180 分钟，按 `costs` 实测收敛；它们是防挂死上限，不是性能承诺。native 不并行；browser worker 按 CPU/内存限额设置，服务批次初始 1。

### 7.1 必须存在的图形会话与两级预检

headless Chromium 不需要系统桌面；Tauri native 需要。Linux 的 `DISPLAY` 是 X server 地址；Windows/macOS 不设置伪造 `DISPLAY`，需要分别验证用户交互桌面与 Aqua/WindowServer。

每个 native job 增加两级检查：

1. **编译前环境检查**：当前 OS/arch、用户/session、可用图形连接、桌面尺寸、所需依赖和非交互权限状态；启动轻量的临时窗口证明 session 可以显示窗口。已知环境缺失先失败，避免昂贵构建后才发现。
2. **构建后的实际 QA app 检查**：通过本 job 的真实启动方式启动匹配 identity 的 QA app；验证窗口存在/可见、WebView ready、输入及截图。临时 helper 的权限与成功不能替代 app 本身的权限。probe 使用独立 QA profile，停止后正式 case 使用新 profile，不能污染待测初始状态。

窗口基准：Linux Xvfb 屏幕 `1920x1080x24`；三端 QA 窗口目标 `1280x800`，记录实际内外尺寸、DPI/scale、字体、显示器数量。Windows/macOS 先查询可用桌面尺寸，不假设某个分辨率设置命令一定成功；低于 case 必需尺寸时显式失败。准备等价字体与中文字体，避免中文方块字被误判为输入失败。WebView viewport 的尺寸不等于系统桌面尺寸。

新增脱敏 `desktop-readiness.json`，记录 observed session/desktop、display/WM/DBus、窗口句柄/PID、截图来源、输入 transport、能力探针结果和失败原因；不保存整份进程环境。`display-ready`、`ime-ready`、`permission-ready` 是独立状态，不因第一项成功自动推导后两项。

### 7.2 Linux：Xvfb + 窗口管理器 + DBus + fcitx5

原文仅列出 Xvfb 不足以运行已有输入用例。`native_steps.py::_activate_x11_application` 使用 `_NET_CLIENT_LIST_STACKING`、`_NET_ACTIVE_WINDOW` 和 `wmctrl`，需要支持 EWMH 的窗口管理器；`native_ime_keys` 要求实际可用的 fcitx5 engine；剪贴板 owner 还使用当前 Python 的 `tkinter`。

目标 Ubuntu 24.04 依赖组（具体包版本写入 toolchains/环境 receipt）：

- display：`xvfb`、`xauth`、`x11-utils`（xprop/xdpyinfo）、`x11-xserver-utils`、`openbox`、`wmctrl`、`xdotool`、`libx11-6`、`libxtst6`。
- bus/clipboard：`dbus`/`dbus-x11`、`xclip`、`python3-tk`；必须用 **实际 setup-python 解释器**执行 `import tkinter` 并创建 Tk 窗口，apt 装包不保证另一套 Python 的 `_tkinter` 可用。
- IME：`fcitx5`、`fcitx5-frontend-gtk3`、`fcitx5-chinese-addons`/`fcitx5-table`，按该发行版提供 `wbpy` 的实际包补齐 table 数据；不能把仅有 `fcitx5-remote` 命令视为 wbpy 已安装。
- 字体/locale：`fonts-noto-cjk`、可用 UTF-8 locale；默认 `LANG=C.UTF-8`，记录实际语言设置与包版本。

拟新增 `scripts/ci_desktop.py` 和 Linux session wrapper，生命周期固定为：

1. 为 job 创建 mode 0700 的桌面配置/runtime 临时根，单独的 fcitx5 profile 含 `keyboard-us` 与 `wbpy`，固定词库版本；不复用个人词库或学习状态。不改 HOME。
2. 由一个常驻 supervisor 建立 `dbus-run-session` 和 `xvfb-run -a -s '-screen 0 1920x1080x24 -nolisten tcp'` 的共同进程环境；窗口管理器、fcitx5、driver、QA app、截图与测试必须继承同一 `DISPLAY`、`XAUTHORITY`、`DBUS_SESSION_BUS_ADDRESS`、`XDG_RUNTIME_DIR`。
3. 在这个 session 内启动 Openbox；等待 `xdpyinfo` 成功、WM 的 EWMH 标识出现，验证 XTEST extension 和窗口激活。单有 Xvfb PID 不算 ready。
4. 在 app/driver 启动**之前**设置 `GDK_BACKEND=x11`、`GTK_IM_MODULE=fcitx`、`QT_IM_MODULE=fcitx`、`XMODIFIERS=@im=fcitx`。GTK3 fcitx module 要实际可加载；Qt 变量只服务可能用到的 Qt 组件，不替代 GTK 配置。
5. 在 session bus 上启动 fcitx5，使用 job 专属配置；desktop daemon 的 XDG 配置目录与 native harness 的 per-case app profile 分开，`reset_db` 不能删除运行中的 daemon 配置。保存配置来源，防止 app 的隔离重定向使双方落入不同 bus/runtime。
6. 等待 fcitx bus 服务及 `fcitx5-remote` 可响应；焦点进入探针输入框后选择 `wbpy`、激活，并验证 `fcitx5-remote -n` 为 `wbpy`、状态为 `2`。输入框存在前的状态 `0` 不能单独证明 daemon 坏了。
7. 在真实 QA editor 做端到端 IME 探针：XTest 输入拼音 → 出现 composition → Space 提交 CJK → 一次 undo 撤销；另一次 Escape 取消不落字。优先复用 `TC-IDE-IMPROVE-008-ime-lifecycle-native` 的断言；候选词库/顺序与 case 所用 `wbpy` 固定。不得换为 Playwright fill、clipboard paste 或手工 dispatch composition 让它通过。
8. 正式执行时保持 supervisor/session 存活；整批结束依次停止 app/driver、clipboard owners、fcitx5、WM、Xvfb/bus，清理所拥有的 profile。绝不能在另一个 workflow step 单独 `dbus-run-session` 启动 fcitx，再期待测试使用旧 bus。

后台任务使用现有 background_job 启动上述 **整个 supervisor**，supervisor 内管理其子进程并等待，不能让 fcitx/Xvfb 脱离后 session wrapper 提前退出。构建可在图形 session 外完成；所有 GUI/输入测试在 session 内运行。

改进 `linux_x11_required.py`：现有“环境变量与三个 executable 存在”只能作第一层检查；按所选 verbs 查询 readiness receipt 并做必要活性检查。`native_ime_keys` 必须要求 IME ready；普通 native WebDriver case 无需启动 fcitx5。外部 clipboard 断言要通过实际 Python/Tk owner 完成 grant/deny/恢复，`xclip` 成功本身不能替代该实现。

记录 `native-ime-observation.json`、engine/profile hash、active window、GTK/WebKit 版本和 CJK 结果。这里证明真实 **虚拟 X11 桌面上的 fcitx5 链路**，不证明 Wayland 输入、实体键盘/触摸设备或物理屏幕时延。

### 7.3 Windows：交互 session、焦点与 UAC 边界

native 必须运行在已登录的交互 session，而不是仅有后台 Windows 服务的 Session 0。预检记录 runner、后台 wrapper、tauri-driver、msedgedriver 和 QA app 的 session ID；检查交互 window station/desktop（通常 `WinSta0\\Default`）、输入桌面可访问性，并用实际 app 窗口证明可见与可聚焦。服务已启动、TCP 端口已开或进程存在不能替代这一步。

现有 background_job 的 WMI detach 路径要在 hosted Windows 实测子进程 session/env。若 WMI 将 GUI 启到非交互 session，新增 CI 专用启动分支：在 GitHub step 的当前交互 session 内由 supervisor 持有 GUI 子进程并等待；复用状态/日志协议，不改变本地 agent 的 WMI 默认行为。不得用 service 安装成功推导桌面会话可用。

构建、OpenSSH/MySQL 准备与运行 app 的权限分开。安装需要管理员的步骤可使用 hosted runner 已有权限，正式 QA app 尽量保持正常用户级行为。UAC secure desktop、系统授权窗口和锁屏测试不属于普通 WebView 自动化；不把关闭 UAC、自动解锁或修改锁屏策略作为修复。无法访问输入桌面时 30 秒级预检返回 `interactive-desktop-unavailable`，而非等 case 总超时。

`native_keys transport=webdriver` 只证明相应 WebView 路径；系统 IME（微软拼音/TSF）与全局快捷键需独立 OS input adapter 和输入法可用性探针。当前 Linux-only IME verb 不可改平台声明就拿去 Windows 跑；未实现部分列 capability gap，保持三端普通 native 核心执行。

### 7.4 macOS：Aqua 会话、截图与权限矩阵

macOS 需要 WindowServer/Aqua 登录会话。记录 console user/uid、`gui/<uid>` launchd domain、显示器列表与实际窗口可见性。使用当前 GUI 用户启动 QA app；若 step 处于错误 bootstrap domain，在确认同一个 console user 后通过受控 `launchctl asuser`/GUI 启动方式接入，不能假定 root/sudo 自动获得图形会话或 TCC 权限。无有效 GUI/display 时返回 `aqua-session-unavailable`。`caffeinate` 仅可用于防本 job 空闲睡眠，不用于解锁。

源码确认：`src-tauri/src/qa_driver.rs` 的 click/keys/action 是 WKWebView 内脚本事件；`screen_capture()` 则运行 `/usr/sbin/screencapture -x` 捕获桌面。前者不能点击系统授权窗口，后者可能受 Screen Recording 权限或 display 限制；两者不能混成一个“macOS driver 支持”结论。

| 场景 | 需要的能力 / 权限 | hosted 默认方案 | 不能宣称的覆盖 |
|---|---|---|---|
| QA 窗口、WKWebView DOM、普通 Tauri IPC | GUI session；业务涉及的具体系统能力另判 | 内置 bridge + 当前 QA app；不主动申请 AX/屏幕录制作为通用前提 | 真实 OS 键鼠、系统 IME、系统弹窗 |
| WebView 内容截图 | 自身 WKWebView snapshot | **拟修改 bridge screenshot**：主线程调用 WKWebView snapshot API，返回 PNG/base64，记录 `capture_kind=webview` 与尺寸；这不依赖全桌面录制权限 | 标题栏、系统菜单、输入法候选窗、权限弹窗、桌面 |
| 全桌面/跨应用/输入法候选窗截图 | display + Screen Recording 等与 API/系统版本有关的许可 | 显式 `desktop-capture` 能力；在实际捕获 actor 中查询并实拍验证；不作为普通 WebView screenshot 的静默 fallback | 缺权限时不能用 WebView 截图充当桌面证据 |
| OS 键鼠、AX 元素、系统菜单/文件 dialog | 依据操作与工具涉及 Accessibility、Input Monitoring、Automation 等 | 精确记录工具/actor；当前 bridge 不提供，仅已验证可无人值守的 adapter/权限组合可入选；其余为 hosted-unavailable | dispatchEvent/字符串填充不证明真实输入 |
| 麦克风、摄像头、受保护目录、系统屏幕共享、Keychain 提示、辅助进程提权 | 各自许可/entitlement/系统状态，不是一个通用 TCC 开关 | 按 case 单独声明；权限拒绝的产品行为可测，但必须真实到达该状态 | CI 没有弹窗不等于权限已授予；QA 权限也不等于 production app 权限 |

WKWebView snapshot 是新的实现任务，不能在本次设计阶段声称已经替换。需要保留原桌面捕获为明确命名的可选证据能力，并迁移依赖完整桌面的 case；`screenshot` 的 receipt 增加截图范围，不让修改后图片含义悄悄变化。snapshot 失败/空白/错误尺寸仍失败。当前 build 流程保持 `--no-bundle` 核心测试；权限敏感验收若需稳定 bundle identity，另准备真正的 `com.taomni.app.qa` `.app`、固定签名来源与启动路径，不能将裸二进制的权限推导给 `.app`。

### 7.5 macOS 完全无人值守契约与权限受限时的处理

**GitHub-hosted runner 没有人工值守。不得把远程登录、点击“允许”、等待人解锁或人工进入系统设置作为本 workflow 的步骤或验收兜底。** 前一版提出的交互 runbook 不能满足这项 CI 需求，已从实施任务与 CI 验收中撤除。

按能力分为三类：

| 分类 | 准入条件 | 调度与结果 |
|---|---|---|
| `hosted-webview` | 真实 GUI/QA app/WKWebView 可用；场景不依赖系统交互授权 | 三端 native 基础必跑；窗口/IPC/本机服务/文件操作在各自真实链路执行，截图使用自身 WebView snapshot |
| `hosted-system` | 精确到 runner image、工具/actor、API 的全自动准备和预检已实际验证；不要求人工 grant | 对选中的 case 强制运行；镜像更新或权限回归导致预检失败时 job 失败，不能自动排除 |
| `hosted-unavailable` | 现有 hosted 环境/adapter 无法自动完成必要授权或目标操作，或没有证据支持无人值守运行 | 在规划时列出 case、缺少的能力、依据和影响；不计 pass、不计作“产品不适用”，不作为等待人工的 job |

`scope=all` 仍表示完整 **CI 可执行集合**，必须同时输出全目录的 hosted-unavailable 清单和覆盖缺口数。新增 case 无归属时 planning 失败；不能靠 catch timeout 才把失败分类为 unavailable。显式 `selected` 请求 unavailable case 时，planning 返回非零并解释限制；不悄悄缩小用户指定范围。夜间报告可显示“CI 可执行范围通过，仍有 N 项能力缺口”，不能显示“所有 native 场景通过”。

具体执行规则：

1. 在适用且无弹窗的系统 API 上做状态预检，例如 AX 的非提示查询、屏幕捕获 preflight。查询在实际 actor/宿主上下文内完成；shell/helper 被授权不代表 QA app 被授权。API 无可靠查询时记录 `unknown`，不能因此判 ready；仅对已知不会请求授权的操作做限时探针。
2. 基础 native 不主动请求 AX/Screen Recording。自身 WKWebView snapshot 不替代桌面捕获用例，也不证明系统授权。共享文件使用 RUNNER_TEMP 下的隔离工作区；不能为了绕过被测的受保护目录行为，把那个 case 悄悄改为普通文件测试。
3. 系统捕获/输入若 runner image 恰好预授权，只有实际 actor 与目标操作成功的证据才可使该能力进入 hosted-system；不能假设 GitHub 预授予任意应用权限，或把前一镜像的结论无限期复用。
4. 已选必跑用例意外弹出权限框：在单次预检/启动预算内终止并记录 `blocked-permission`，默认 30 秒、上限 60 秒；对话框无法可靠识别时保留 `setup-timeout/permission-unknown`，不臆测原因。保留当前步骤、actor、可取得的日志/截图，清理所有所属进程，继续其他独立组合；该 scope 失败。
5. 不依赖 `sudo`、管理员账号、`tccutil reset` 自动 grant；不通过改 TCC.db/关闭 SIP 制造授权。AppleScript/System Events 点击权限窗口也可能先需要权限，不能作为免配置方案。
6. 必须验证权限拒绝行为的 case，只有能够无人值守创建/观察真实拒绝状态时才属于 hosted-system；否则列能力缺口。mock 拒绝可保留为单测，但不能提升为 native 权限证据。
7. report/可选 issue 保存能力指纹、OS/image/arch、head、app/automation actor、权限状态、失败阶段和原始证据链接，用于后续修复自动化或调整支持范围；不生成“等待本次 runner 人工授权”的待办。权限阻断不得被截图的二次失败覆盖。

服务准备也受同一约束：macOS 本地 SSH 若依赖人工打开 Remote Login，所选 provider 即不满足设计，必须先验证可自动配置的服务路径；不能在实现文档里保留“进入系统设置开启”让用户补位。无法找到可用路径时，SSH 对应组合的验收未完成并报告原因，不能仅以 MySQL/本地 PTY 通过宣布全部基础设施完成。

本期承诺实现并验收的是可无人值守的六组合与明确的能力边界。若要求在 stock GitHub-hosted macOS 上同时覆盖**所有**系统权限授予流程、系统 IME、全局输入，则目前没有得到验证的通用方案，本设计不能承诺该目标已经可行。未来更换为受管/预授权环境是另一个明确的范围决定，不是本次 workflow 的隐含依赖。

## 8. 结果、门禁与失败处理

每个 entry 的 artifact 名带 `run_id-attempt-platform-arch-mode`，上传：selection、脱敏环境/工具版本、service/desktop/IME/permission readiness、原 `run-*/summary.json`、`runner_receipt.json`、native build identity、带 capture kind 的截图/trace、driver/provider/Vite/WM/fcitx 日志和 cleanup 状态。证据 `keep-runs 0`，CI artifact 常规保留 14 天，失败可保留 30 天。

`summarize` 使用 `if: always()`、依赖 plan 与执行矩阵，即使某项失败也收集。固定 check 名 `qa-ui-auto-platforms-result`，仅表示该独立 workflow 的结果，不设置为 PR required check，不让 release 依赖它。验证：

1. 每个预期 entry 都有当前 attempt 报告，或明确的环境/构建失败记录；缺失不当作 skip/pass。
2. 原 summary/receipt 匹配，head/case/runner/build/config 身份有效，实际 IDs 与计划一致，依赖顺序成立；不能改写已签出的 summary 以添加 CI 元信息。
3. 所有 required selected case `failed=0`、`skipped=0`；`--require-pass` 退出码保留。环境失败、setup timeout 与断言失败分列。
4. `not_applicable`、hosted-unavailable gap、未评审 case 单独展示；通过一个平台不能覆盖另一个平台，也不能拿旧 attempt 掩盖本次失败。
5. 不直接用全目录 `status --gate` 评价仅选定范围；复用 scope-aware verification/receipt 校验。由于异机 artifact 内有原始绝对路径，汇总按 artifact 根解析已有相对证据路径，不改内容或伪造本机身份。

CI 汇总文件仅是 workflow 的完整性/状态摘要，不是第二套产品 pass 结果。新 workflow 自己运行的静态 audit/helper checks 另列结果，不借用原 PR workflow 的绿色状态。

cleanup 总在上传前后有明确次序：先收集必要进程日志，再停止 app/driver/JDTLS/Vite/本轮服务；释放 clipboard/IME 状态后按序停止 fcitx、WM、Xvfb/bus，最后销毁服务租约。正常测试失败不能因 cleanup 成功改绿；cleanup 失败单独记录为基础设施失败；本机 provider 由临时 VM 销毁兜底。取消不依赖 `always()` 一定完成，hosted 临时 VM 回收兜底；以后增加远端 provider 时另加租期兜底。

### 8.1 报告优先与可选 issue 追踪

默认每次生成 Actions Job Summary 表格：平台/架构/mode、选择数、pass/fail/skip、构建/环境失败、remote capability gaps、display/IME/permission 状态、hosted-unavailable 缺口、未评审覆盖、主要错误和 artifact 链接。另输出 `ci-summary.json` 和 `failures.md`，方便后续 agent 下载原始证据定位。Summary 不直接塞入未经截断/脱敏的测试 stdout。

`publish_issues=false` 时不申请 issues 写权限、不创建 issue。打开时，在独立 job 中使用受信任的发布脚本和只包含预期字段的摘要，job 级 `issues: write`；测试 job 仍为只读 token。发布 job 不执行被测 head 的任意脚本，不把测试日志当 shell 或模板代码。

issue 按 `qa-ui-auto:<platform>:<mode>:<case-id或infra-stage>:<error-class>` 指纹去重，标题例如 `[QA][Windows/native] TC-NATIVE-CORE-001 setup timeout`；正文包括首次/最近出现、head SHA、run/attempt URL、实际失败步骤、脱敏错误摘要、artifact 链接。使用隐藏 marker 保存稳定 key；查找 open issue 后更新其“最近失败”区块，避免同一个失败每晚建新 issue或刷多条评论。发布并发使用独立串行 concurrency group 防止同时创建重复项。

本轮默认不自动关闭 issue。一次 selected 运行通过不能证明该平台/依赖的所有历史失败已消失；可在**同一平台、模式、case 实际执行通过**时记录恢复证据，保留人工关闭。被排除、未选中、skip、缺报告都不能记为修复。issues API 权限不足时报告 issue sync 失败并保留 artifacts，不覆盖原测试结果；不因此改变 PR/release 状态。

V-05 增加测试：同一失败两次只产生一个 issue 更新；不同平台分别追踪；错误摘要注入文本不能执行；未选中 case 不关 issue；API 失败仍能取得原报告。设计阶段不直接向仓库发送 issue。

## 9. 实现任务与文件责任

所有下列路径为拟新增或拟修改；未表示已经执行。表中 `scripts/` 指 `.agents/skills/qa-ui-auto/scripts/`，`ci/` 指 `qa-ui-auto-tests/ci/`。任务拆分不授权启动子 agent。

| TASK | 职责与主要文件 | 依赖 / 完成条件 |
|---|---|---|
| TASK-01 选例契约 | `qa_ui_auto/ci.py`、`verification.py`/feature 映射复用、runner selection 接口、`ci/policy.yaml`、`ci/dependencies.yaml`；所有 case 有可执行性归属，处理 rename/restore group、CLI 长参数、零矩阵 | 可先开始；AC-02/03/08；V-01 |
| TASK-02 服务 provider | 新增 `scripts/ci_services.py`、服务部署/健康检查脚本与 runbook；扩展现有 service_fixtures 的 namespace 接口但保留本地默认行为；env/config、种子数据、临时账号/服务、失败清理 | 已选本机 provider；先做三端服务最小探针；AC-04/07/09；V-02 |
| TASK-03 Java 与 native 环境 | 新增 `scripts/ci_toolchains.py` 和 `ci/toolchains.yaml`；修复 jdtls probe、java25 fixture；修改 `tauri_webdriver.py` 的 Darwin readiness；Windows setup 探针和 UTF-8；维护必要回归测试 | 可先开始；工具版本须做三端最小下载/启动验证；AC-05/06/09；V-03/06 |
| TASK-04 workflow 整合 | 新独立 workflow、runtime composite action；inputs→manifest→matrix、workflow_call、nightly、缓存、artifact、cleanup；不修改三个已有 workflow | 接口依赖 TASK-01/02/03/06；AC-01/07；V-04 |
| TASK-05 汇总与集成交付 | CI summarize、最小治理/迁移说明、skill CI 引用；检查 receipt 与 expected entries；调度六组合、定位既有失败，不删失败 case 换绿 | 依赖 TASK-01～04、06；AC-08/09 及整体 AC；V-05/06/07/08/09；回填实际 Actions 链接、counts、遗漏能力 |
| TASK-06 图形会话、IME 与权限 | 新增 `scripts/ci_desktop.py`、Linux session supervisor/fcitx profile；增强 `fixtures/linux_x11_required.py` 活性检查；Windows 交互 session 探针及必要的 CI launcher 分支；`src-tauri/src/qa_driver.rs` 增加自身 WKWebView snapshot，保留明确命名的桌面捕获；截图范围 metadata、无人值守权限预检、prompt 超时处理和 hosted-unavailable 策略 | 先执行三端轻量 session 探针；与 TASK-03 协调 driver 文件，不重复构建；AC-10/11/12；V-07/08/09；禁止以权限/输入模拟冒充系统验证 |

现有 Linux browser 两个已知失败应在三端集成前先定向复现：`TC-IDE-C0-02` 保存状态、`TC-auto-F-Servers-1-servers-dialog`。Windows native setup timeout 同样是验收阻断，不能仅标“平台未验证”。对独立既有产品缺陷记录修复任务；本次改动新增的回归由对应 TASK 负责。

## 10. 验证计划与交接命令

以下全部是实现后的待执行计划；本轮只读源码、目录和上轮 Actions 日志属于调查证据。

| V | 输入 / 操作与断言 | 覆盖 |
|---|---|---|
| V-01 选例单测 | 拟新增 `scripts/test_ci_selection.py`：selected 并集、impacted 补选、坏 ID/ref、文档-only、rename/delete、共享/未映射扩选、前置 DAG/环、跨平台零选择、manifest 修改和 hash 不符；新 case 无 policy 归属失败 | AC-02/03/08 |
| V-02 服务集成 | 三端从最终 endpoint 完成 SSH nonce + PTY、SFTP 字节往返、MySQL DML；同时开两个 namespace 证明互不删除/串数据；认证错、端口冲突、服务中断失败；正常取消清理与临时 VM 回收 | AC-04/07/09 |
| V-03 Java 与启动探针 | 冷缓存安装；工具版本/arch；JDTLS 真正初始化并返回语义结果；Java25 Maven/Gradle 在线预热后离线构建；debug/test bundle UI 路径；mock socket 回归证明 Darwin 单端口、其他 OS 双端口 | AC-05/06/09 |
| V-04 workflow 结构/触发 | actionlint + YAML/输入契约检查；手动 smoke、手动 selected、手动 impacted；测试 caller job 等待上游后调用；新 workflow 不监听 PR/push；已有三个 workflow 字节不变；计划空矩阵可解释 | AC-01/02/07 |
| V-05 汇总故障注入 | 缺一个 artifact、selected skip、过期 receipt、head 错、构建失败、取消、路径迁移；最终 check 必须失败且指出组合；平台不适用不能算 pass；成功集合与真实 case IDs 一致 | AC-07/08/09 |
| V-06 六组合实际运行 | 先核心，再 SSH/SFTP/MySQL/Java 能力代表，再 all；每个 native job 构建一次后批量跑；保存每个平台实际 head/build/runtime/receipt；不凭模拟平台单测宣布 macOS/Windows 已通过 | hosted 无人值守范围 AC；不可用能力必须列缺口 |
| V-07 三端 display 与启动 | 拟新增 `scripts/test_ci_desktop.py` 检查 supervisor 生命周期、环境继承、分阶段失败分类；真实 runner 验证 Linux EWMH/焦点、Windows runner/driver/app 同交互 session、macOS Aqua/WindowServer/app；断开 display/错误 session 时早失败；截图确含 app 内容 | AC-06/10，目标变化及既有 native 启动回归 |
| V-08 Linux IME/clipboard | 同一 Xvfb/WM/DBus 下执行 `TC-IDE-IMPROVE-008-ime-lifecycle-native`、`TC-IDE-C8-02-native-virtual-space-transaction`、`TC-IDE-C3-02-native-clipboard-permission-and-multicaret`；检查 CJK、取消不落字、undo 次数与剪贴板拒绝/恢复。再分别缺 engine、停止 fcitx、断开 session bus，必须报环境失败而非绿色 skip | AC-11，使用现有真实用例，不能仅测安装脚本 |
| V-09 macOS 截图与权限 | 对未授予 Screen Recording 的新测试身份，基础 WKWebView snapshot 仍有正确内容/尺寸；桌面捕获缺许可时明确 blocked，不能换截图范围后 pass。验证 actor 身份记录与 prompt timeout；全流程无人确认。显式选择 unavailable case 时 planning 失败；必跑权限回归时执行失败且不改写计划；只能被人工授予的能力保持覆盖缺口 | AC-12，snapshot 拟新增 QA bridge 定向测试及真机检查 |

可复用的现有检查（仓库根，Bash；Windows 用 PowerShell 设置同名环境变量）：

```bash
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
python -m unittest test_background_job test_native_isolation test_tauri_webdriver
python -m qa_ui_auto.audit --gate
python -m qa_ui_auto run --mode native --filter TC-NATIVE-CORE-001 --dry-run \
  --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.example.yaml
```

上述 dry-run 只验证当前主机的语法/verb，不编译、不证明真机。拟新增测试使用 `python -m unittest test_ci_selection` 等，文件落地后才可执行。长构建/实际 suite 按 skill 通过 background_job 启动。

三端实际验收顺序和结果要求：

1. Linux：先 V-07；`TC-NATIVE-CORE-001` 验证真实本地 PTY；`TC-012/TC-027` 服务/UI；MySQL qualified-name 与 rename/restore group；一条 JDTLS 语义 case 和 Java 执行 case；完整 IME/clipboard 范围执行 V-08。browser 对应范围分别执行并标注桥接边界。
2. Windows：先 V-07，再同样的跨平台集合；特别证明 WebView2 session 成功、UTF-8 artifact 可读、Java launcher/Gradle batch 调用、OpenSSH/SFTP 路径和进程清理。Linux-only verb 在 manifest 标注不适用，但 Windows 系统 IME 的对应行为记录为未覆盖能力，不能标产品不适用。
3. macOS ARM64：先 V-07/V-09 hosted 部分；校验 arch、WKWebView `/status`、真实 QA app UI、WebView 内 Cmd/Meta、MySQL/SSH 与 Java provider；不从 release ARM 构建成功推导 native case 通过。系统输入/权限按第 7.5 节无人值守准入或列 hosted 覆盖缺口，不把 bridge 的事件当真实 OS 输入。

本设计交付无需重新构建产品；实现交付至少完成当前 Linux 所需验证并明确其他端状态。由于本项目的目标正是三端 CI，只有最终六组合在实际 GitHub runner 留下有效执行证据，才能报告“三端 workflow 已验收”；其他平台未跑仍是该整体目标的未完成项。

## 11. 追踪、迁移与未决项

| AC | 方案章节 | TASK | V | 当前状态 |
|---|---|---|---|---|
| AC-01 | 4、7 | 04 | 04、06 | 已设计，待实现 |
| AC-02/03 | 4、5 | 01 | 01、04 | 已设计，待实现 |
| AC-04 | 6.1～6.3 | 02 | 02、06 | 采用本机 provider，三端服务探针待执行 |
| AC-05 | 6.4 | 03 | 03、06 | 已设计，具体工具锁需安装验证 |
| AC-06 | 2、7 | 03 | 03、06 | 已定位 macOS readiness 缺口；Windows setup 原因待探针 |
| AC-07/08 | 8 | 04、05 | 04、05、06 | 已设计，待实现 |
| AC-09 | 5～8 | 01～05 | 01～06 | 需保留既有测试并回填回归证据 |
| AC-10 | 7.1～7.4 | 06、04 | 07、06 | 明确三端 GUI 前提，真实 hosted session 探针待执行 |
| AC-11 | 7.2 | 06 | 08 | 完整 fcitx5/GTK/XTest 方案已补，真实 CI 待执行 |
| AC-12 | 7.4～7.5、8 | 06、05 | 09 | snapshot 待实现；权限 preflight/超时待验证，必须人工 grant 的能力不纳入无人值守准入 |

独立上线时先以手动入口验证新 workflow，再验证自身 nightly 与 caller。原有 `e2e.yml`、`qa-native.yml`、`release.yml` 保持不变，因此旧夜间任务可能仍运行；本次用独立 concurrency group 避免相互取消。以后是否合并/停用旧 workflow 是另一项调整，本次不做。

新 workflow 不监听 `pull_request`/`push`/`release`，不修改 branch protection，不写入 release 的 needs。它的失败应该真实显示为红色，以便发现问题，但不作为合并/发布门禁。如果调用方未来选择把它串入某业务 flow，该调用方自己决定失败处理；不能一边声称阻断调用链、一边又声称不影响 release。

回退只撤销新增 workflow/工具及本轮创建资源；报告保留。当前无待用户确认的实质决策，TASK-01 和 TASK-03 可开始，TASK-02/06 先完成三端本机服务与图形会话探针再深化脚本。整个三端 CI 功能仍待实现与执行，本设计不将安装、授权或 display 假设记为已验证；仅 hosted 自动化通过不等于三端所有系统权限/IME 已通过。
