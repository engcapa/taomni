# OpenCode Go 本轮开发记录（2026-10-15）

后续模型检查开发已将 Go 的 S2 models.dev 拉取/cache/digest 抽为唯一共享
`llm/model_catalog.rs`；S1、种子、协议与 Go 自有行集缓存继续保留。
详见 `../model-inspector/delivery-notes.md`。此对齐不把原未执行的真机项改为通过。

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
