# OpenCode Go 本轮开发记录（2026-10-15）

按 `development-tasks.md` 的九个工作包接入：默认配置、四协议目录与传输、
统一分发、线程模型 SQLite/IPC、设置页与聊天选择器、离线 stub、自动化单测
及 browser/native 用例。目录自动过期阈值先按设计建议定为 **6 小时**。
原任务要求的 browser、native、真连与全量构建，本轮依用户明确要求
**只编写用例、不执行**；因此不宣称产品级验收完成。

### 数据来源与限制

调研原始目录不在当前工作区。内置快照按设计附录构造，文件中明确标识
非真实在线快照；离线 fixture 同样标识 synthetic。`--check` 不联网。
以后用真网关或公开元数据正式更新时，使用更新脚本比较 seed 协议冲突，
冲突先人工裁决，不能把猜测覆盖现有协议。没有申请或接触真实订阅凭据。

### 实际验证

- 改前已有 `aiStore` 7 条通过；改后相关前端单测 **49/49**、
  Rust 生产源码的隔离单测 **19/19**、Node 脚本单测 **2/2**；
  `tsc --noEmit` 与快照离线校验通过。
- QA 用例目录 lint/控件覆盖 `audit --gate` 与 7 张新卡的 CI 静态计划检查
  通过；这些命令没有执行用例。
- 完整 Rust crate 测试未跑到源码编译：无关 ASR 依赖的系统 `cmake` /
  64-bit `liblzma` 不满足。隔离 harness **不能替代**配置/路由/Tauri
  整包编译。没有运行 `pnpm build`/`cargo check`、浏览器或原生用例。
- 浏览器/原生用例覆盖设置默认值与协议覆盖、目录搜索/徽标/变化/故障、
  空目录、网络禁用、线程 pin/clear/落盘、四协议请求/多轮工具/流式、
  代理、vault、并发、负向响应、七个旧 provider/fallback/组路由、
  Linux/Windows/macOS 的差异与证据要求；**全部待执行**。
- 详细本地基线和 V-01～V-10 状态位于
  `qa-ui-auto-report/opencode-go-provider/baseline.md`（本地 QA 报告目录
  在 gitignore 中），可移植的执行清单位于
  `qa-ui-auto-tests/native/opencode-go-provider.md`。

### 受限交付边界

真实 Go 鉴权头/订阅可用性、Linux 原生 IPC/离线网络策略、跨平台 WebView、
目录生产快照、全 crate 编译仍需按清单验证，当前**不是通过项**。不会用
浏览器 stub 或纯函数单测替代这些证据。回退可移除 Go 默认 provider/
runtime/UI 与目录/线程字段的使用，保留已有数据库新列不会改变旧列语义；
正式回退应按检查点执行，勿在用户数据上做破坏性 schema 降级。

### Review 修复记录（2026-10-16，Windows）

针对提交 `a507c90176014393251fc78735965de8d1644d93` 的三个问题：

1. Go 新配置和缺省代理改为 `app`；独立 `custom_proxy` 复用 Settings 的
   AppProxyPanel 与共享后端代理格式/解析。`none` 即使保留旧 URL/独立配置也直连，
   旧 Go manual/session 配置继续可用，其他 provider 保持原代理语义。
   应用代理文件损坏、选中的代理不可用、vault 凭据不可解析均明确报错。
   应用代理在构建 AI router 时读取；修改应用代理后重新保存 AI 配置或重启生效。
2. 未知模型的流式目录刷新移至 End/Error/Err 事件 yield 之前，保留 EOF 兜底；
   真实消费方在终止事件立即释放 stream 也会触发刷新，不重发推理或替换 pin。
3. 新增兼容旧实现的 `supports_tools_for(&ChatRequest)`，Go 按请求的有效模型
   查询工具能力；聊天调度、多 key、provider group 同步转发。直接工具调用入口
   对不支持工具的模型不发送工具声明。

本轮只执行单元测试（无 browser/native、集成测试、独立构建或类型检查）：

- `pnpm exec vitest run src/stores/aiStore.test.ts src/components/settings/GoProxyFields.test.tsx src/components/settings/GoProviderFields.test.tsx src/components/settings/AppProxyPanel.test.tsx`：4 文件，18 条通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib llm::`：20 条通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib ai::config::`：6 条通过。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib proxy::tests::`：6 条通过。

Rust 使用完整 crate 的单元测试目标，含 loopback 假网关/代理，不连接真实 Go 服务。
新增工具能力测试首轮 fixture 层级错误导致 1 条失败，修正 fixture 后上述结果全部通过。
Rust 输出已有 unused/dead-code 等警告；本轮没有清理无关警告。

TC-AI-005 扩展代理模式切换、独立设置保存/重载；N-GO-03/05/06 补充线程工具能力、
三种代理及失败边界、终止事件立即释放流的验证步骤。同步 feature 控件与生成的 testid
目录；TC-AI-005 已有 CI policy/dependencies 注册，无新增依赖。所有 browser/native
用例均为 **unrun**，本轮单测结果不代表真实代理环境、订阅网关或三端 UI 已验收。
