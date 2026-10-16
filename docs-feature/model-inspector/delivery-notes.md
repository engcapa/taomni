# 模型检查本轮交付记录

日期：2026-10-15。范围：`model-inspector-design.md` 与本目录任务文档。
**本轮按用户要求，仅运行本地单元测试；browser/native 用例已编写，不执行。**
未运行 `pnpm build`、`cargo check`、browser/native case、真实订阅检测或跨平台构建。
本次没有新增第三方依赖，没有访问真实 provider key。

## 实现与底座归属

- Go 目录先行但未泛化：S2 抽至 `src-tauri/src/llm/model_catalog.rs`，Go 的 S1
  `/models`/种子/协议与原 Go 缓存继续保留。Go 与 inspector 共享同一 metadata
  服务和 `model-catalog.json`，不是两套 models.dev 拉取/cache。
- 共享底座：UA、严格 proxy/no environment proxy、10s 请求超时、6h TTL、
  在途合并、digest 去噪、磁盘缓存、损坏回快照、失败保 last-good、网络策略取消。
- Inspector 核心：runtime 协议映射、provider 键/域名映射、精确命中/登记别名/
  local 实时/未收录四类来源、云端 current 必有行、子树边界、实时差异不删行，
  local 以真正 loaded IDs 为行集且不可用态与空态分开。
- 命令：`get_provider_models`、`test_llm_model` 注册；原 `test_llm_connection`
  签名、默认请求与返回口径保持。新模型检测严格校验代理/网络策略，60s deadline，
  结果按 provider/model 两层键合并原子写入独立 `model-check-results.json`，
  损坏文件忽略；持久化失败显形。真实 IPC 接线没有整包编译证据。
- 前端：每个配置 provider 有入口（含未来新增 provider）；全列元数据、未知值 `—`、
  current 高亮置顶、错误首行/完整 title、手动刷新、逐行/当前检测、
  全测额度确认/cancel/逐个更新、关闭与 Esc 焦点返回、现有配置/vault 保存链选模型。
  store 持有批量任务，防重入、迟到请求隔离与刷新不覆盖较新检测结果。
- 同步中英文与 stub。补齐前端默认/normalize 的 anthropic 镜像（Rust 默认已有）；
  stub 的原连接测试返回明确合成结果，浏览器层不再用空返回值冒充连接状态。

## 快照与别名

`scripts/update-model-inspector-snapshot.mjs` 从真实公开
`https://models.opencode.ai/api.json` 提取 deepseek、agnes、anthropic、groq、
zhipuai、siliconflow-cn、siliconflow 和 Go 子树；检查键/域名/非空行，记录
生成时间及源 SHA-256。资源为 `src-tauri/resources/model-catalog.snapshot.json`。
SDK 原生条目没有 api 时检查其官方 doc 域名，不填造 api。

当前公开 deepseek 子树中没有 `deepseek-chat`，也没有足以独立确认规范目标的
材料，因此**未登记推测别名**；生产行显示未收录与 `—`。别名解析能力已有，
单测与 browser 别名样本明确是 synthetic，不能当成生产确认依据。
Go 原来的 S3 snapshot/seed 没有在本次替换；其原交付记录中的 synthetic
边界继续有效，真实 Go 离线目录验收仍须另行确认。

## 实际本地验证

改前基线：工作树干净；`aiStore.test.ts` 与 `GoProviderFields.test.tsx`
**9/9** 通过。未执行改前 browser/native，不声称已证明真机零退化。

| 验证 | 实际结果 / 范围 |
|---|---|
| 前端单测 | **29/29**，4 文件：aiStore、GoProviderFields、modelInspectorStore、ModelInspectorPanel；0 fail/skip |
| Rust 隔离单测 | **26/26**，0 fail/ignored/filtered：生产 inspector core、shared catalog、既有 Go 四协议/目录、既有请求兼容和 chat SQLite store |
| Node 脚本单测 | **3/3**，新增快照域名/子树约束与既有 Go 快照协议自测 |
| TypeScript | `pnpm exec tsc --noEmit` 通过 |
| 离线快照 | `node scripts/update-model-inspector-snapshot.mjs --check` 通过 |
| QA 静态 | audit gate、控件生成、9 个新 case 的 schema/步骤契约、policy/dev-contract 及 CI selected plan 通过；不是运行证据 |
| 完整 Rust crate 单测 | 首次依赖编译超时；复用中间输出续跑后 `libspa-sys` 的 bindgen 缺少 `LIBCLANG_PATH`/libclang，exit 101；未到本次 Tauri/AppState/commands 源码检查 |

Rust 隔离命令：

```sh
env -u LD_AUDIT PATH="$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin:$PATH" \
  python scripts/test-opencode-go-unit.py \
  --cargo "$HOME/.rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin/cargo"
```

该脚本引用生产文件，只替代 config 路径并排除无关 desktop/router/GPU 注册；
**不能替代**整个 Rust crate 编译或 AppState、vault/代理/session 真实集成。
完整单测尝试的本地日志：
`/tmp/replit-background-tasks/aa278c75-da92-4450-b699-58b35c5059d1.log`（环境临时文件）。

预览服务已重启，Vite 5000 就绪，新面板模块 HTTP 200。两次首页静态截图在
捕获时均仍为空白，浏览器仅记录连接/React DevTools 信息，没有提供可定位的
本次运行错误；首页使用动态 App bootstrap。此检查**不能确认完整页面渲染或
新面板工作**，没有执行交互或 browser/native case，也不归因为已证明的既有
问题。需要后续真实 UI 验收时单独确认启动与模块加载。

## AC → V → 测试/用例与边界

| AC | 已有本地证据 | 未执行用例 / 剩余边界 |
|---|---|---|
| I01/I02/I03 | precise_alias_unknown_live_difference_and_local_authority；UI/store 单测；真实快照脚本约束 | TC-AI-012/013/019、N-I-01/08；真实 alias target 未确认，生产未收录符合设计 |
| I04 | local 行集核心断言、live_models 假网关读取、UI local unavailable/empty 单测 | TC-AI-016/017/018，N-I-05；真实 llama-server 生命周期未验证 |
| I05 | gateway_success_error_timeout_and_disabled_zero_requests；persistence_merges_corruption_and_network_policy；重复/顺序/保存/stale 单测 | TC-AI-012/014，N-I-02/03/06；真实 key、文件权限、cold restart 未验证 |
| I06 | selection uses real configuration save chain；failed selection 不迁移 highlighter；mounted input 同步 | TC-AI-012/019/020，N-I-06/08；真实 vault/router/聊天 consumer 未验证 |
| I07 | go_agrees_with_catalog_and_override；共享 metadata 的 cache/digest/在途单测；既有 Go 全局部回归 | TC-AI-019，N-I-01/07；真实四协议与共享流量计数未验证 |
| I08 | guarded probe 零请求、metadata 策略切换取消/拒新请求、UI disabled、batch 动态策略 | TC-AI-015，N-I-04；系统级无 cloud traffic 未验证 |
| I09 | 原 aiStore/Go fields 单测、原传输 request/body 单测、原 inputs/edit/save mounted 检查 | TC-AI-012/020 + 既有设置 case，N-I-02/08；原 IPC 真机回归未验证 |

- V-I01：核心与共享目录单测通过；commands 集成编译未验证。
- V-I02：probe/结果文件核心单测通过；真实 vault/IPC、系统策略计数未验证。
- V-I03：前端组件/store 单测通过。
- V-I04：TC-AI-012～020 已写、静态检查通过；**browser/native 未运行**。
- V-I05：无新平台 API、无硬编码用户 config 路径、无新增依赖；tsc 通过。
  生产/整包/三端构建未执行，不标为兼容性验收通过。
- V-I06：Linux/Windows/macOS 全未执行，步骤/隔离/证据/清理见
  `qa-ui-auto-tests/native/model-inspector.md` N-I-01～08。

## 回退

移除 inspector 入口与新命令后原 provider 配置仍兼容；结果文件不属于用户配置，
只删除隔离结果或明确获授权的文件。共享目录由 Go 仍使用，不因撤掉 inspector
把 Go 的底座一并删除；无 DB migration，不进行破坏性 schema 回退。

## 修复轮验证（2026-10-16）

本轮修复了代理严格路由、策略切换取消、未保存草稿检视、解锁恢复，以及 Go 元数据未知值显示。新增/修改 browser 用例 TC-AI-005、012～017、019、020 和 native 用例 TC-AI-021；TC-AI-021 使用隔离 loopback 网关、三路代理和 QA 配置，不含真实凭据。

| 验证 | 结果 |
|---|---|
| Vitest 受影响组件/store | 43/43 passed |
| Rust `ai::model_inspector` | 8/8 passed |
| Rust `llm::opencode_go` | 17/17 passed |
| Rust `ai::config` / `llm::model_catalog` / router capability | 6/6、3/3、1/1 passed |
| TypeScript | `pnpm exec tsc --noEmit` passed（QA build also passed） |
| Browser Windows 11 | TC-AI-005、012～017、019、020：9/9 passed |
| Native Windows 11 | TC-AI-021：1/1 passed；实际 WebView2/EdgeDriver 155、QA app `com.taomni.app.qa`、隔离 HTTP/文件证据 |
| Linux/macOS browser/native | 未执行，仅保留用例 |

Browser/native 报告保存在 `qa-ui-auto-report/model-inspector/`；native 首次因机器 EdgeDriver 152 与 WebView2 155 不匹配而未启动，随后使用匹配的隔离驱动重跑通过。完整 crate 测试未作为本轮门槛；受影响模块与 QA 构建已验证。
