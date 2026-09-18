# Code Workspace Java 保存后自动完成消失 修复设计

> 状态：已修复并通过真机回归。根因是两层 provider 行为叠加：
> 1. jdtls 收到 `textDocument/didSave` 后对该文档的 `textDocument/completion` 返回空列表，直到下一次 `textDocument/didChange` 才恢复；Taomni 保存流程在 didSave 后把缓冲标记为“已同步”，导致下次补全不再补发 didChange。
> 2. **（线上抓包确诊）** 保存流程还会向 jdtls 发送 `workspace/didChangeWatchedFiles`，而 jdtls 对“已打开文档”的磁盘变更会从磁盘重读该文件，**覆盖保存后用户继续输入的内存编辑**；因此保存后的首次补全可能按旧文档内容作答（真机表现为 `s1.` 弹出 `Length*` 这类无关类型，而非 String 成员）。
>
> 修复：Java（jdtls）文档保存时不发 `didSave`；Rust 侧对“会话已打开文档”的 watched-file 通知不再下发（自写盘不再伪装成外部变更）。真机回归 `TC-REPRO-SAVE-02` 全周期通过。

## 1. 设计摘要与范围

- 问题类型：功能缺陷（Java 补全打开时正常，`Ctrl+S` 保存后成员补全消失或变成无关列表，仅剩 Live Templates；如 `s1.` 不再提示方法、`System.` 不再提示 `out`）
- 文档位置：`docs-issue/code-workspace-java-completion-no-suggestions-design.md`
- 设计状态：已实施并验证（真机 QA 全周期通过；临时诊断用例与线上抓包证据已归档）
- 来源：用户报告 + 截图（`PersisG2Application.java`，`s1.` 弹窗只含 Live Templates），并指出“刚打开可以提示，Ctrl+S 保存来回几次就不行了”
- 调研基线：分支 `docs/code-workspace-idea-audit-20260913`，提交 `a125fcec`
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端
- 本轮真机执行端：Windows 11（协议探针 + LSP 线上日志代理抓包 + 打包 QA 应用回归）。macOS/Linux 未执行，保留计划、记未验证
- 推荐（最终）方案：
  1. **不向 jdtls 发 `didSave`**（`useWorkspaceLspSession.saveDocument` 对 Java preset 走跳过分支）：jdtls 的 didSave 空补全态与保存后旧文档作答都源自 didSave 及其后续补偿；保存仍写盘、仍发增量 didChange，provider 的构建/诊断由既有 didChange 与磁盘事实驱动。
  2. **Rust `notify_watched_file_sessions` 过滤“该会话已打开（opened_documents）的文档”**：客户端自己的写盘不再以 watched-file 事件回灌给 provider，避免 jdtls 从磁盘重读并覆盖内存编辑。

用户期望：保存后继续能在 Java 文件里得到成员补全。实际：保存后成员补全消失或变成无关类型列表，只剩本地 Live Templates。

## 2. 当前实现与问题依据

### 关键调用链（保存 → 补全）

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src/components/editor/workspace/useWorkspaceLspSession.ts` `saveDocument` | 保存前 flush didChange；`lspSaveDocument`（发 `textDocument/didSave`）；成功后曾把文档标记“已同步”并补发恢复 didChange | **缺陷面 1**：didSave 触发 jdtls 空补全态；恢复 didChange 又与用户后续输入竞争 | 源码事实 + 协议探针 |
| `CodeWorkspaceTab.tsx` 保存提交路径（`commitOpenBufferPreparedSave`） | 落盘成功后发 `lspWorkspaceDidChangeWatchedFiles(type=2)`；Rust watcher 也会对自写盘产生 Remove/Create 回声（被抑制窗口去重） | **缺陷面 2**：jdtls 把该事件当作磁盘变更，重读打开中的文档并覆盖内存编辑 | 源码事实 + 线上抓包（客户端发送序列） |
| `src-tauri/src/lsp.rs` `notify_watched_file_sessions` | 向 workspace 内所有 Ready 会话转发 watched-file 事件（不区分该会话是否已打开该文档） | **修复落点 2**：已打开文档由 didOpen/didChange 拥有内容，watched-file 事件不应再下发 | 源码事实 |
| `codeWorkspaceModel.ts` `isDocumentSynced` / `isLspFeatureReady` | 共享放行判定；`syncedTextRef` 是“provider 是否已持有该文本”的镜像 | 修复后 Java 分支保持“已同步”，下次补全走快路径 | 源码事实 |
| `CodeWorkspaceTab.tsx` `ensureLspDocumentSynced` / `getLspCompletions` | 未同步则补发 didChange 并等待队列；completion 直接转发 provider | 不再需要“保存后强制重同步” | 源码事实 |
| Eclipse JDT LS（外部） | (1) didSave 后该文档补全为空，直到下次 didChange；(2) 对打开文档的 watched-file 变更会从磁盘重读并覆盖内存编辑 | **根因所在（provider 行为）** | **协议探针 + LSP 线上抓包 + 精确回放双通道确诊（见下）** |

### 复现与根因（已确诊）

- 复现环境：Windows 11；jdtls `%LOCALAPPDATA%\jdtls`（equinox launcher `1.7.200`）；JDK 25；真实 Maven 工程副本 `persis-g2-copy`（源 `D:/code/ads/persis-g2/persis-g2-server`），探针文件 `TaomniProbeSaveTmp.java`。
- 复现频率：**稳定复现**（QA 用例 `TC-REPRO-SAVE-02` 第 3 周期连续多轮失败）。
- 确诊证据（一）协议探针（Node 直连 jdtls）：
  1. baseline：`s1.` → 61 项成员。
  2. `didSave`（带/不带 text）后立即补全：`s1.` → 0 项。
  3. 随后 no-op `didChange`：`s1.` → 61 项（恢复）。
- 确诊证据（二）**LSP 线上日志代理抓包**（proxy 记录客户端/服务端双向报文与顺序，并对客户端 didChange 维护影子文档）：
  1. 失败周期报文序列（客户端发送完全正确）：`didChange(5:2→5:11,+3)`（文本 `s1.`，影子文档同步更新正确）→ 10ms 后 `textDocument/completion` @5:5 → 服务端按**旧文本**（`\t\tlength();`）答复 3 个 `Length*` 类型（`LengthCounterBase/LengthCounter/Length`），jdtls 自身 `.metadata/.log` 无该变更的 reconcile 记录。
  2. 成功周期与失败周期的差别仅在文档内容是否可区分（旧文本在 `s1.` 处的成员答复与旧文档恰好同形）。
- 确诊证据（三）**精确回放与二分定位**（把抓取到的客户端报文按原顺序原间隔回放到全新 jdtls）：
  1. `full` 全量回放 → 复现服务端旧文档答复（n=3）。
  2. `no-extras`（仅保留文档同步与补全）→ 全部正常（n=61）。
  3. `no-watched`（仅去掉 `workspace/didChangeWatchedFiles`）→ **全部正常（n=61）**。
  4. `no-resolve`（对照组，保留 watched-files）→ 失败复现（n=3）。
  → 结论：`workspace/didChangeWatchedFiles`（客户端自写盘通知）是覆盖内存编辑的直接触发器；jdtls 据此从磁盘重读打开中的文档。
- 因果链（已验证）：`Ctrl+S` → 写盘成功 → 保存流程发 watched-file 通知（Rust watcher 亦产生回声，经抑制窗口去重）→ jdtls 重读打开中的文档（磁盘版本）→ 用户保存后继续输入的 didChange 被覆盖 → 保存后首次 `textDocument/completion` 按旧文档作答 → 弹窗出现无关类型/空列表，本地 Live Templates 兜底显示 → 用户看到“只剩模板/不相关列表”。
- 根因状态：**已验证**。触发方是 provider（jdtls）对 didSave 与自写盘 watched-file 的反应；前端可控修复点是“不发 didSave + 不下发已打开文档的 watched-file 通知”。
- 回归要求：修复前——第 3 周期（脏保存+连续 Ctrl+S 后立即补全）失败；修复后——三周期均出现 `li.cm-completion-type-method` 成员行。

## 3. 修复验收与保持的行为

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | jdtls active，Java 文件已打开 | 打开后立即键入 `s1.` / `System.` | 弹出成员补全（`length()`/`out`）（保持行为） | 三端 |
| AC-02 | 同上 | 保存（Ctrl+S）后（不再编辑）键入 `s1.` / `System.` | 仍弹出成员补全，不只剩 Live Templates（修复目标） | 三端（Win 已真机） |
| AC-03 | 连续多次 编辑+保存 循环（含脏保存+纯保存连续） | 每轮保存后触发补全 | 每轮均能得到 LSP 成员候选 | 三端（Win 已真机） |
| AC-04 | 保存流程 | 保存后 provider 状态 | 不向 jdtls 发送 `textDocument/didSave`；保存文本仍以 didChange 同步 | 三端 |
| AC-05 | 保存后无任何缓冲变化（纯 Ctrl+S） | 触发补全 | LSP 源被正常查询并返回候选（走已同步快路径，无额外 didChange 往返） | 三端 |
| AC-06 | 任意 provider 已打开的文档 | 客户端自写盘（保存等） | 不向该 provider 下发该文档的 watched-file 通知（内容由 didChange 拥有）；未打开文件/外部变更仍正常下发 | 三端 |

保持的正常行为：补全排序（§ED-COMP-002）、接受/一步撤销（§8.17.2）、resolve gate、live template 让位、保存的磁盘字节正确性与保存事务语义、其他语言 provider 的 didSave/watched-file 行为必须继续通过既有测试。

## 4. 修复方案与关键决策

将修改对应到根因：jdtls 对 didSave 与自写盘 watched-file 的两种反应都会破坏保存后的补全；修复是**不再向 jdtls 提供这两类“客户端自写”信号**，同时保持内容同步（didChange）与磁盘事实。

1. `useWorkspaceLspSession.ts` `saveDocument`：Java preset（`lspPresetIdForPath(...)==="java"`）走“跳过 didSave”分支——先保证 buffer 已 flush 同步（顺带让 provider 在构建时看到最新内容），随后仅更新 LSP 文件状态（`syncing=false`、`syncedText=text`、清错）并 `scheduleDiagnostics`，不调用 `lspSaveDocument`、不清 `syncedTextRef`、不补发恢复 didChange。非 Java provider 保持原 didSave + 恢复逻辑不变。
2. `src-tauri/src/lsp.rs` `notify_watched_file_sessions`：对每个 Ready 会话过滤掉其 `opened_documents` 覆盖的路径后再下发；过滤后为空则跳过该会话。这样客户端自写盘（前端显式通知与 Rust watcher 回声两条路径）都不会让 provider 重读打开中的文档；未打开文件、真正的跨文件外部变更仍照常通知。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论或待决推荐及理由 | 状态 | 决策来源 | 关联 AC / TASK / V |
|---|---|---|---|---|---|
| DEC-01 修复落点：didSave 后如何保证补全？ | (A) didSave 后清 `syncedTextRef` 让下次请求先 didChange；(B) didSave 后立即补发 no-op didChange；(C) getLspCompletions 层每次强制 didChange | 初版选 (B)（已实施）。后续抓包证明 didSave 本身即可触发服务质量问题（空补全 + 与恢复 didChange 竞争），**最终改为不向 jdtls 发 didSave**，见 DEC-03 | 已被 DEC-03 取代 | 协议探针 + 抓包 | 历史 AC-04/05；被 AC-04 取代 |
| DEC-02 是否同时修其他 didSave 消费者？ | (A) 仅统一放行判定；(B) 特判 | 初版按 (A) 处理；最终因不再发 didSave，问题整体消失 | 已随 DEC-03 收敛 | 源码 | 历史 |
| DEC-03 是否向 jdtls 发送 `textDocument/didSave`？ | (A) 继续发送 + 保存后恢复策略；(B) **不发送**，磁盘事实与构建由 didChange/保存流程驱动 | 选 **(B)**：用户确认。抓包证明 didSave 是空补全态与后续竞争的根源；保存写盘、保存事务、诊断调度均不变，provider 仍通过 didChange 获得文本 | 已实施 | 用户决策（本轮） | AC-02/03/04 |
| DEC-04 自写盘的 watched-file 通知如何处理？ | (A) 保持现状（通知 + 抑制回声）；(B) **不下发“会话已打开文档”的通知**；(C) 取消全部 watched-file 通知 | 选 **(B)**：精确回放二分证明该通知是内存编辑被覆盖的直接触发器；保留未打开文件/外部变更通知，语义更正确（已打开文档内容由 didOpen/didChange 拥有） | 已实施 | 抓包 + 回放二分（本轮） | AC-06；AC-02/03 |

### 数据流、状态与生命周期

- 权威：jdtls 持有的文档文本与其“可补全/可构建”内部状态（provider）。前端 `syncedTextRef` 是“jdtls 是否已持有当前 buffer 文本”的镜像；`versionRef` 单调递增。
- 修复后 Java 保存：flush（如需）→ 标记已同步 → 结束。不产生 didSave 与恢复 didChange；后续编辑照常走 debounce didChange。
- watched-file：前端保存路径仍调用 `lsp_workspace_did_change_watched_files`（用于标记本地事件抑制窗口），Rust 在会话级过滤已打开文档后不再下发。
- 并发：保存与 didChange 仍走 `syncQueuesRef` 串行队列，保持消息顺序。

### 接口与共享契约

- 无 IPC 契约变更（`lsp_save_document` 保留给其他 provider；`lsp_workspace_did_change_watched_files` 语义细化为“标记 + 对未打开文档下发”）。
- `isDocumentSynced`/`ensureLspDocumentSynced` 为共享放行判定；Java 分支保持已同步，hover/signature/diagnostics 行为不变。

### 三端兼容与相关存储、故障边界

- 修复位于前端会话层与 Rust 会话层（跨端共享），无平台分支、无 `cfg`、无存储迁移。
- provider 侧（jdtls）行为在三端一致（同一 Eclipse JDT LS 协议）；Windows 已抓包/回放/真机确认；macOS/Linux 预期同源，保留真机接续。
- browser（`pnpm dev`）无真实 jdtls，仅能验证调用序列；原生验证承担 provider 行为证明。

## 5. 改动清单

| 路径 / 模块 | 具体变更与保持的约束 | 相关 AC | 所属任务 |
|---|---|---|---|
| `src/components/editor/workspace/useWorkspaceLspSession.ts`（`saveDocument`） | Java preset 跳过 `lspSaveDocument`（不发 didSave）与恢复 didChange；保持 flush、`syncedText=text`、`documentActiveRef`、`scheduleDiagnostics`；非 Java 路径不变 | AC-02/03/04/05 | TASK-R1 |
| `src-tauri/src/lsp.rs`（`notify_watched_file_sessions`） | 过滤会话 `opened_documents` 覆盖的变更；为空则跳过该会话；保持未打开文档与外部变更通知 | AC-06 | TASK-R1 |
| `src/components/editor/CodeWorkspaceTab.test.tsx`（P0-J1 新增用例） | 断言：Java 保存不调用 `lspSaveDocument`、不新增 recovery didChange、保存后补全走快路径 | AC-04/05 | TASK-V |
| `src/components/editor/workspace/useWorkspaceLspSession.test.tsx`（新增用例） | 断言：Java buffer 保存跳过 didSave 且保持已同步；保留既有非 Java“恢复 didChange”用例 | AC-04/05 | TASK-V |
| `qa-ui-auto-tests/cases/TC-REPRO-SAVE-01-*`（已提交，回归） | 保存循环后 `名.` 仍出现 LSP method 行 | AC-02/03 | TASK-V |
| `qa-ui-auto-tests/scopes/diag-save-completion/TC-REPRO-SAVE-02-*`（诊断用例，已固化） | 真实 Maven 工程副本三周期（编辑+保存、纯保存、脏保存+连续保存）后均出成员行；截图存档 | AC-02/03 | TASK-V |

> 不改：`lspCompletion` 映射/接受链、排序/undo、保存落盘字节、其他 provider 的 didSave 语义。

## 6. 实现任务与交接

### TASK-R1 保存信号修复（已完成）
- 职责与文件范围：`useWorkspaceLspSession.ts` 的 `saveDocument`；`src-tauri/src/lsp.rs` 的 `notify_watched_file_sessions`。
- 实施内容：见 §5。保持消息顺序（flush→didChange）、保存状态与诊断调度不变。
- 对应验收：AC-02/03/04/05/06。
- 验证与完成条件：V-01（单元/mounted）、V-02（真机三周期）、V-03（抓包与回放证据）。

### TASK-V 回归与真机（已完成本轮）
- 职责：新增/固化测试；跑相邻回归（补全相邻用例、保存字节正确性）、真机；记录 macOS/Linux 未验证并留接续。
- 完成条件：AC-01~06 的 V 通过；无补全/保存相邻退化。

## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 / case | 前置数据与操作 | 核心断言 | 命令、工作目录与前置依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-01 | AC-04/05 / 保存不打扰 provider | Vitest mounted（`CodeWorkspaceTab.test.tsx` P0-J1；`useWorkspaceLspSession.test.tsx`） | 打开 active Java 文件，补全一次；保存；再补全 | Java 保存不调用 `lspSaveDocument`、sync 队列不新增 didChange；保存后补全直接调用 `lspCompletion` | `pnpm test src/components/editor/CodeWorkspaceTab.test.tsx`、`pnpm test src/components/editor/workspace/useWorkspaceLspSession.test.tsx`（repo 根，jsdom） | 改后：通过（197/197、21/21） |
| V-02 | AC-02/03 / 真机保存循环 | native `TC-REPRO-SAVE-02-java-completion-realproject-diag`（真实 Maven 工程副本，三周期原子按键） | 基线 `s1.` 出成员 → 周期1（编辑+保存+重选+`s1.`）→ 周期2（纯保存+`s1.`）→ 周期3（脏保存+连续两次保存+`s1.`） | 每周期 `.cm-tooltip-autocomplete li.cm-completion-type-method` 出现；截图存档 | `python -m qa_ui_auto run --mode native --cases qa-ui-auto-tests/scopes/diag-save-completion --filter TC-REPRO-SAVE-02…` | **改前=失败**（step 23，第 3 周期；`items=3` 无关类型）；**改后=通过**（最终代码 run-20260917-205457-428784400；含 cycle3 截图方法行） |
| V-03 | 根因/回归 / provider 行为 | 协议探针 + LSP 线上日志代理抓包 + 精确回放二分（脚本，已归档于会话；抓包与回放脚本位于临时工作区） | 复刻客户端报文；回放变体（full / no-extras / no-watched / no-resolve） | `full` 复现旧文档答复；`no-watched` 全部恢复；jdtls `.metadata/.log` 无对应 reconcile | 抓包：LSP 代理（node）；回放：`replay-app-stream.mjs`；需 jdtls + JDK25 + 工程副本 | **改前=确诊**：watched-file 通知是直接触发器；**改后=前端不再发送**（Java 保存路径与已打开文档过滤） |

失败→通过与保持→通过：修复前的失败在于 provider 被客户端自写信号（didSave / watched-file）扰动（真机与抓包可见）；修复后断言点为“Java 保存不发 didSave、不为已打开文档下发 watched-file、保存后补全走快路径”（V-01）与“真机三周期仍出成员候选”（V-02）。相邻保持：补全排序/接受/undo、保存落盘字节、其他 provider 行为——既有测试通过（CodeWorkspaceTab 197/197、workspace 会话 21/21、CodeMirrorHost 补全 5/5、splitter 集成通过）。

## 8. 真机验证手册

### 环境与准备
- Windows：打包 QA 应用 `com.taomni.app.qa`；隔离 app-data；真实 jdtls + JDK≥21；`msedgedriver.exe` 需匹配 WebView2 运行时。命令：Git Bash / PowerShell，repo 根，`PYTHONPATH=.agents/skills/qa-ui-auto/scripts`。抓包/回放需 Node + 工程副本。
- macOS/Linux：未执行；保留计划（同源 jdtls，预期一致），记未验证。

### V-03 抓包与回放（已执行，确诊）
- 抓包：LSP 代理记录 `app->srv` / `srv->app` 报文（方法、id、版本、变更范围、影子文档第 5 行、补全结果摘要）。失败周期可见：客户端 `didChange` 正确更新影子文档后，服务端仍按旧文本答复。
- 回放：`replay-app-stream.mjs` 按原位序/间隔重放客户端报文；`no-watched` 与 `no-resolve` 对照证明 `workspace/didChangeWatchedFiles` 是触发器。
- 状态：已执行（Windows）。

### V-02 真机保存循环（已通过）
- 操作：QA 应用打开工程副本，`s1.` 基线出成员 → 三周期编辑/保存组合后 `s1.` 再补全。
- 结果：三周期均出现成员行；截图 `baseline-s1-members.png`、`cycle1-s1-members.png`、`cycle2-pure-save-s1-members.png`、`cycle3-double-save-s1-members.png`（run-20260917-205457-428784400）。
- 状态：已通过（修复后，Windows）。QA 审计门禁 `python -m qa_ui_auto.audit --gate`：OK（无相对基线回退）。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 / 实际证据链接 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01 | §2 现有链 | TASK-V | V-02(Win 真机) | 基线截图与成员行（run-20260917-194613-805970700） | 无 |
| AC-02/03 | DEC-03/04 | TASK-R1/V | V-02(Win 真机) | 三周期通过 + 截图；`[CX]` 轨迹中保存后 `items=61` | 无 |
| AC-04/05 | DEC-03/04 | TASK-R1/V | V-01 | `pnpm test` 断言通过（197/197、21/21） | 无 |
| AC-06 | DEC-04 | TASK-R1/V | V-03 抓包 + 回放二分 | `no-watched` 恢复、`no-resolve` 复现 | 无 |

三端：Windows 已抓包/回放/真机确认；修复为跨端共享代码，无平台分支。macOS/Linux 未执行，保留未验证与接续（同源 jdtls）。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| 不再发 didSave 是否影响构建/诊断 | 依据：jdtls 的构建由 didChange 与文件事实驱动；本修复保留 didChange 同步与保存后的诊断调度 | 真机回归中诊断/构建正常（project facts、诊断调度步骤通过）；如需可再补一条“保存后诊断仍更新”的 native 断言 | TASK-V | 已随真机回归观察通过 |
| watched-file 过滤是否影响真实外部变更 | 依据：只过滤“该会话已打开文档”，未打开文件与跨文件外部变更照常通知 | 既有 Rust 测试与前端保存测试通过；后续可补“外部修改打开文件”用例 | TASK-V | 既有回归通过 |
| jdtls 版本差异 | 上述行为在当前 JDT LS 观测到；旧/新版本行为或不同 | 修复只削去客户端自写信号，不依赖具体版本 | — | — |
| 其他 provider 的 didSave/watched-file 语义 | 依据：仅 Java preset 跳过 didSave；watched-file 过滤按“已打开文档”规则（provider 无关） | 既有测试覆盖 TS/其他路径；如需按 provider 特判可再收敛 | TASK-V | 既有回归通过 |
| macOS/Linux 未验证 | 其他端未执行 | 保留接续，缺设备不阻塞本轮交付（按 AGENTS 记录未验证） | — | 具备设备后复跑 |

本轮已完成：TASK-R1（修复）与 TASK-V（V-01/V-02/V-03）。
