# P1 剩余任务统一设计：Git 多仓库上下文与 Java Structural Search

<a id="p1-remaining"></a>

## 范围与状态

本设计只覆盖唯一任务板 `docs-feature/code-workspace-idea-parity/backlog.md` 中尚未完成 P1 细化的 `ED-PARITY-008`（REQ-07 / CW-GIT-001、CW-GIT-003）和 `ED-PARITY-009`（REQ-09 / CW-SEARCH-003）。二者仍由各自卡保存状态、ID、AC 和 P2 证据；本文件把它们编成一个可连续开发的 P2 工作包。已有 ready/done 卡不回开、不借用其证据。

源码基线：HEAD `a9e37c2e9a91b2c4b58eb91e45cc05796b85f5e3`；本轮无产品源码/测试修改。IDEA 参照见 [reference](references/ed-parity-008-009-reference.md)，原始采样在被忽略的 `qa-ui-auto-report/idea-reference/p1-remaining/run-20260927/`。

<a id="ed-parity-008"></a>
## ED-PARITY-008：两个本地仓库间切换 Git diff 上下文

现有 `useWorkspaceGitSnapshots.ts` 以 `repoRoot` 作为缓存、in-flight 和刷新序列键，`WorkspaceGitManager.tsx` 维护 `selectedRepoRoot`、`repoScope`、change key 和 `gitBlobPair`；`src/lib/git.ts` 与 `src-tauri/src/git.rs` 提供快照/对象读取。目标是 F3 两仓库：打开 Changes，显示 repo-a/repo-b 状态；选择 repo-a 文件进入 HEAD→WORKTREE diff；切换 repo-b 后路径、内容、状态和标题全来自 repo-b；返回编辑器保持 dirty/selection。取消、关闭和迟到响应不得 Git 写入或污染新 root。

- **ED-PARITY-008-A1**：F3 manifest 的 HEAD/index/worktree 与状态/diff 完全对应；切换 root 后列表、标题、路径和字节一致。
- **ED-PARITY-008-A2**：同 fixture 的 IDEA/Taomni 功能、交互、视觉分别记录，无 matched 推断。
- **ED-PARITY-008-A3**：取消/关闭零 Git 写入；编辑器状态保持；旧 generation 响应丢弃。

<a id="ed-parity-009"></a>
## ED-PARITY-009：Java Structural Search 首个结构匹配场景

`companionCapabilities.ts` 目前只有 typed `StructuralQuery`、校验和空 `SSR_SUPPORTED_LANGUAGES`，没有入口、AST backend、结果模型或 UI。首包固定 Java pattern `System.out.println($arg$);`：无 modifier 命中 3 处，Text=42 命中 1 处，Text=999 命中 0 处；必须排除注释、字符串、print/err 反例。先限 file/module/workspace 等价 In Project 范围；Replace、Full Line、Script/Reference/Type 和其他语言留后续卡。

- **ED-PARITY-009-A1**：AST 结果位置/captures 准确，过滤结果准确；backend 不可用返回 typed unavailable。
- **ED-PARITY-009-A2**：结果树展开、导航、高亮、取消/关闭和空态均有 IDEA/Taomni 分侧证据。
- **ED-PARITY-009-A3**：普通项目搜索、Find、编辑器内容和字节不变；取消释放 parser/request 资源。

## DEC、任务和依赖

- **DEC-008-01（agent 自决）**：selected root、request generation、cache 和 diff pair 全部用 repoRoot 身份键化，先隔离迟到响应再扩展 UI。
- **DEC-008-02（agent 自决）**：首包只读 diff/上下文切换；stage、commit、merge/rebase、push 不纳入实现。
- **DEC-009-01（agent 自决）**：采用 parser/backend 抽象和 Java adapter；backend 未就绪显示 typed unavailable，禁止 regex fallback。
- **DEC-009-02（IDEA 采样依据）**：保留 Java 模板、modifier、结果树和精确 Text=42 过滤目标。

一个 P2 交接按两张卡分段：`TASK-008` 负责 `useWorkspaceGitSnapshots.ts`、`WorkspaceGitManager.tsx`、`WorkspaceChangesView.tsx`、`DiffViewer.tsx` 及 Git caller；`TASK-009` 负责 parser adapter、query/result/unavailable contract、入口、结果树、范围和 modifier；`TASK-INTEGRATE` 负责 CodeWorkspaceTab 路由、共享消费者回归、目录维护和最终组合验证。008 不改 SSR contract，009 不改 Git manager，集成任务最后处理共享路由。

## 完整测试用例设计 <a id="test-cases"></a>

| V | 卡/模式 | 操作与断言 |
|---|---|---|
| V-008-01 | 008/browser | F3 两 repo；打开 Changes，依次选择 repo-a 与 repo-b 文件。断言分组、branch、path、HEAD/WORKTREE 文本及 1/2→2/2 对应。 |
| V-008-02 | 008/browser+native | 预置 caret/selection，打开 diff 后 Esc/关闭。断言 dirty/selection/caret/text 保持；native 独立读取 Git hash/write set。 |
| V-008-03 | 008/unit+native | 连续刷新 A→B，注入迟到 A response，取消/关闭。断言 B 最终可见、A 丢弃、Git 零写入。 |
| V-009-01 | 009/browser | Java fixture 输入 pattern，In Project Find。断言 3 个精确位置，高亮并排除注释/string/print/err。 |
| V-009-02 | 009/browser | `$arg$` Text=42 再 999。断言分别 1 与 0，零命中为空态而非 unavailable。 |
| V-009-03 | 009/browser+native | Esc/关闭及 unavailable/error/slow response。断言编辑器/字节不变，native 记录 typed error 和资源释放。 |
| V-009-04 | 两卡/browser | local Find、regex project search、editor selection 回归，断言共享入口和焦点不串。 |

P2 将用例落盘为拟新增 `qa-ui-auto-tests/cases/TC-IDE-PARITY-008-01..03-*.testcase.yaml`、`TC-IDE-PARITY-009-01..03-*.testcase.yaml`（先查重），维护 `feature-list.md` covers/controls。native 步骤必须写清 browser 无法证明的磁盘、真实 IPC/provider 和资源边界。

## 平台、证据与完成边界

三端均做代码兼容审查；当前端按环境识别执行真实 Tauri native，Windows WebView2、macOS WKWebView、Linux WebKitGTK 分别记录，缺设备只保留未验证。快速迭代用 Vitest/browser；稳定后一次 scoped typecheck、Rust focused tests 和当前端 native；最后写 IDEA comparison record。008 required evidence 为 code-audit/unit/typecheck/browser/native/idea-comparison；009 另含 provider/rust。P1 没有运行产品测试、构建或 Taomni runner。

规划完成只表示设计、fixture、IDEA 参照和 AC/V 已就绪，不表示实现或 matched。P2 必须把 owner/claim/evidence/status 回填各自原卡，统一交接只编排顺序。
