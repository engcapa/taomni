# Code Workspace Java 模板与未保存内容补全退化修复设计

## 1. 范围与状态

- 来源：用户报告 Java 的 sout 类模板减少、未保存文件中 sout + Tab 不能可靠展开、Java 类输入点号后缺少方法提示；补充示例为 `LocaleDateTime`。
- 示例解释：JDK 类型名称为 `java.time.LocalDateTime`，后文以此构造主复现；尚未确认用户原代码是否确为 `LocaleDateTime`，不得将拼写差异直接判作产品缺陷，也不得据此否定其报告。
- 基线：2026-09-16，HEAD `149be0e882ef638cae6b1d08984eaa21275966c6`，package.json 版本 `0.4.25`；调研开始工作区干净。用户所运行的二进制身份、JDK/JDTLS 版本及配置尚未知。
- 当前环境：Linux x86_64。产品与后续验证覆盖 Windows、macOS、Linux Tauri 桌面。
- 状态：**已完成修复与验证交付**。模板退化路径、成员补全点号触发机制及未保存缓冲区同步屏障均已查明根因并完成修复。DEC-01 选用方案 A（当前有效 provider 候选优先，无候选立即本地展开）、DEC-02（点号 trigger 语义统一与 triggerOrigin 识别）、DEC-03（严格同步屏障）全部实现。
- 本轮交付包含完整修复代码与测试用例，涵盖单元测试、组件集成测试、生产打包检查、QA 门禁审计以及 Linux x86_64 原生真机端到端自动化验证。Windows 与 macOS 保持代码兼容并记录待后续相应平台执行。


## 2. 证据与调用链

下表行号对应调研基线，执行时以符号检索为准。

| ID / 位置 | 源码事实 | 结论与限制 |
|---|---|---|
| E-01 `src/components/editor/workspace/liveTemplates.ts:119` / `JAVA_TEMPLATES` | 本地仍含 `sout/soutm/soutp/soutv`，以及其他 Java live/postfix 模板 | 未发现这四个定义被删除；用户看到的数量下降可能发生在运行时过滤，不等于整个历史目录已核对 |
| E-02 `CodeMirrorHost.tsx:2349` / `providerOwnedTemplatesRef`、`trackProviderOwnedTemplates` | provider 返回的缩写按 session generation 累积记忆；同代不会随位置、文档 revision 或下一次空结果删除 | 过去返回过不代表当前可用；语言为 Java 时本地 source 持续让位 |
| E-03 `liveTemplates.ts:1270,1397` / `expandLiveTemplateAt`、`createLiveTemplateCompletionSource` | 被认领的普通缩写既从本地候选中过滤，也不能精确 Tab 展开；postfix 不受此让位影响 | 冷启动、学习后、provider 空结果/失败时行为不一致的明确执行路径 |
| E-04 `CodeMirrorHost.tsx:2993` / Tab keymap | 先 acceptCompletion，再本地展开；被 provider 认领时只 startCompletion 并消费 Tab | 一次 Tab 变成打开列表；不取决于文件已保存还是 dirty，但 dirty 引发的 provider 可用性差异可放大问题 |
| E-05 `liveTemplates.ts:1323` / `providerSnippetAbbreviations` 与 `lspCompletion.ts:729` / `completionKindToType` | 使用映射后的 `type === "text"` 识别 provider 模板；kind 15、18、未知类型都可能映射为 text | 存在误认领风险，需用原始 kind / 明确模板来源，不以展示图标类型判断所有权 |
| E-06 `lspCompletion.ts:1835,1882,869` | triggerOnly 能识别 `.`，但自动请求仍用 word 长度调用 shouldAutoTrigger；默认 minPrefixLength=1，点号后长度为 0 | source 自动路径可在 fetch 前返回 null；不是完整宿主必然失败的证明 |
| E-07 `CodeMirrorHost.tsx:2882` | 用户输入 trigger 时另行 startCompletion；先用固定长度 1 检查策略 | 默认配置可能通过 explicit context 绕过 E-06；minPrefixLength>1 时此路径也可能被拦。自动触发被记成 explicit 的协议/重复调用语义需一并验证 |
| E-08 `CodeWorkspaceTab.tsx:4497,15889` / `ensureLspDocumentSynced`、`getLspCompletions` | 先对 live buffer 强刷 didChange，等待最多 400ms；默认 requireSynchronized=false，超时仍可返回 live buffer并发起 completion | 前端存在非严格同步窗口；Rust transport 的实际写入顺序尚未证实错误，不能直接断定 completion 一定早于 didChange |
| E-09 `src/lib/editor/lsp.ts:596`、`src-tauri/src/lib.rs:666`、`src-tauri/src/lsp.rs:6348` | `lspCompletion` 调用已注册的 `lsp_completion`；后端用 URI/position 请求 provider，不附 live text；无 trigger 为 kind 1，有 trigger 为 kind 2 | 正确性依赖此前 didOpen/didChange 与请求顺序；不能靠保存文件或硬编码方法名单补救 |
| E-10 `src/stubs/tauri-core.ts:2264` | 浏览器 document LSP 分支返回 stub 状态，无真实 JDTLS | 浏览器 UI / mock 单测均不证明原生工作副本和 JDK 解析 |

以上未写全目录的 TS/TSX 文件均位于 `src/components/editor/workspace/`，`CodeWorkspaceTab.tsx` 位于上一级 `src/components/editor/`。

历史证据：提交 `10fd22fcb0cfe3df82d7cad1e193faa8ac1e431f` 明确引入“Java provider 模板优先”，动机是 provider 的 soutm 能解析真实方法名，而本地只填占位符。现有 `CodeMirrorHost.completion.test.tsx` 的同名模板测试明确验证第一次 Tab 后文档仍是 soutm，第二次 Tab 才插入 provider 内容。历史提交中声称的 native 通过仅属历史资料，本轮未重新验证其产物。此前正常版本和用户实际版本仍需 TASK-01 对照。

### 因果链与确定性

1. **高确定性的模板退化机制**：曾收到 provider 模板 → 会话级认领 → 当前本地同名候选与 Tab 均被屏蔽 → provider 未返回/慢/空时本地也不提供；有 provider 时第一次 Tab 只开列表。现有测试支持两次 Tab 的行为，但未覆盖“学习后空返回”的完整 UI 序列。
2. **成员补全候选原因 A**：点号后零长度前缀 → 普通前缀门槛拦截自动 source。宿主额外 startCompletion 会影响结果，需组合测试；不能宣称这是用户默认配置问题的唯一原因。
3. **候选原因 B**：dirty buffer 同步超时 → best effort completion → provider 可能读取旧 working copy → 空结果/错误位置。需 frontend queue + Rust 写入日志确认，服务器分析完成与通知写出不是同一事实。
4. **其他待排除项**：拼写、缺少 import、JDK 未配置、JDTLS 初始化/项目导入未就绪、类型解析失败、用户关闭自动补全/模板或排除符号。保留设置，不通过清空用户配置“修复”。

## 3. 最小复现与诊断矩阵

使用独立 Java 工程，保存以下初始文件；光标测试位置用注释替换，不把 `<caret>` 写入 Java：

```java
import java.time.LocalDateTime;
class CompletionProbe {
    void probe() {
        LocalDateTime dt = LocalDateTime.now();
        // 在下面逐个执行测试
    }
}
```

| 场景 | 操作 | 观察 / 区分意义 |
|---|---|---|
| 模板冷态 | 打开 Java 后不依赖 provider 返回，在方法内输入 sout，立即 Tab | 是否一次展开；记录 dirty 与磁盘 hash |
| 模板暖态 | 先明确获取 provider sout/soutm 候选，Esc；再次输入同缩写，立即 Tab | 对照 E-04；再令 mock provider 返回空、延迟、失败，确认本地候选是否消失 |
| 目录可见性 | 默认隔离设置下输入 so/sout，检查四个 sout 家族；比较冷/暖态和关闭 provider | 先恢复已有条目可见性，不按数量盲目补新模板 |
| 静态成员 | 输入 `LocalDateTime.`，保持未保存；对照手动 Basic Completion、输入 n、保存后重试 | 自动触发 vs provider 解析；应包含 now/of/parse 等合法静态方法 |
| 实例成员 | 输入 `dt.`，未保存；再在未保存内容中新增另一个 LocalDateTime 局部变量并补全 | 应含 plusDays/getYear/toLocalDate 等实例方法；验证最新声明可见 |
| 同步延迟 | 控制 didChange 队列超过 400ms，停止继续打字，仅等待补全 | 区分通知排序、服务器延迟和“等下次按键才恢复” |
| 配置 | minPrefixLength=1、3；autoTrigger=false；手动 Basic Completion | 点号遵守自动开关，不应受普通单词长度门槛限制；手动入口继续可用 |
| 类型解析 | 已 import、全限定 `java.time.LocalDateTime.`、原拼写 `LocaleDateTime.` 对照 | 没有符号解析时不伪造方法；如果用户代码确为自定义类，补其最小项目夹具 |
| 文件生命周期 | 已有文件 dirty；新建且已分配 .java 路径；无路径临时文档单列 | 用户未说明具体种类；不得把缺失 URI 文档与正常 dirty 文件混为同一根因 |

现场记录：应用构建/提交、OS/WebView、JDK/JDTLS 版本、实际类型与 import、文件 URI、dirty、documentRevision、session generation、同步 version、completion triggerKind/字符、provider 原始项数、过滤后项数、迟到丢弃理由。只采集隔离夹具，避免真实业务源码进入日志。

## 4. 修复契约与方案

### DEC-01：同名模板与一次 Tab

已向用户提出三个方案：A 当前有效 provider 候选优先、没有则立即本地展开（推荐）；B 始终本地（结果一致，但失去 provider 语义）；C 等待 provider 后自动展开（可得真实方法名，但存在等待/失败）。**状态：用户已定（2026-09-16）**。用户明确选择“当前 JDTLS 候选优先，无候选立即本地展开”。以下方案 A 为有效契约，关联 AC-01/02、TASK-02、V-01/02/05；无待用户决策阻塞。选择只确定体验，不证明根因或测试通过。

A 的具体边界：

- 废除“某代会话曾提供”作为永久屏蔽依据，合并当前请求的本地与 provider 候选；provider 在同一 documentRevision、URI、generation、光标与替换范围有效且确有同名模板时才去重优先。provider 空、失败、取消、切文件或编辑后不删除本地兜底。
- 不使用 `Completion.type === text` 断定 provider snippet；在 LSP 映射层保留明确的 raw kind/模板来源元数据，只用于已知模板缩写的去重。普通 text/reference 候选不能认领模板。
- popup 有有效选中项时保持接受所选项；popup 无可接受项且精确缩写成立时，一次 Tab 使用当前有效同名 provider 候选或同步本地展开，不能只打开列表就结束。provider 旧范围/旧上下文不得复用。provider resolve 仍沿用既有校验与错误恢复，不绕过 import/冲突门禁。
- 本地回退后不在 provider 迟到时自动替换文档。soutm 回退仍是可编辑 MethodName；soutp 仍沿用现有占位正文，不声称实现了参数语义宏。
- 本地 preferences.enabled、disabledBuiltinKeys、customTemplates、postfixEnabled 原样生效。用户显式禁用不算缺失；本次不扩大这些开关对 provider 自有候选的控制范围，不重置配置。保留当前自定义模板选择契约；若基线查出独立覆盖顺序问题另行记录。
- 注释、字符串、只读、IME、非空选择的现有行为建立基线；不得抢占 snippet Tab/Shift-Tab、缩进、终端或其他输入框。Tab 在已活跃 snippet 中优先完成合法占位符导航，任何顺序调整须覆盖嵌套输入场景。

### DEC-02：成员触发语义

状态：agent 自决。依据现有 `.`/`:` 即时补全注释及自动开关契约；不改变用户偏好，只区分输入原因。

在 `lspCompletion.ts` 与 `CodeMirrorHost.tsx` 统一 typing / trigger / explicit 判定，拟扩展策略方法可选 reason 参数（或等价内部 helper），旧两参调用保持普通 typing 行为。真实 provider trigger 在 autoTrigger=true 时不受 minPrefixLength 影响；autoTrigger=false 时不主动请求，手动入口仍可请求。真实点号发送 triggerKind=2、triggerCharacter='.'；手动 Basic Completion 为 kind 1，自动点号不能推进“重复手动补全”序号。不能仅把 minPrefixLength 设为 0，也不能把所有自动请求伪装成 explicit。检查宿主 startCompletion 生成的 explicit context，必要时新增一次性、绑定文档/光标的 trigger-origin 标记；消费后立即清除，切文件/编辑/取消时失效。共享消费者含其他语言、手动快捷键及 repeated Basic Completion，均纳入回归。

### DEC-03：未保存缓冲区同步

状态：agent 自决；**具体改动以 TASK-01 的排序证据为条件**。已有设计注释明确希望 completion 读取 live buffer，而非磁盘，故不采用“自动保存后补全”。

若证实请求可跑在对应 didChange 之前：为 completion 增加严格的 revision 同步屏障，复用 `useWorkspaceLspSession` 的逐文件队列；将捕获的 token/documentRevision 与同步文本绑定。队列写出当前文档通知后再请求，不要求不存在的 LSP didChange ACK。超时表示暂不可用，不能把未同步结果当成功。同步完成时如文件、revision、generation、光标、原会话仍有效，可至多补发一次；用户编辑/切换/取消则丢弃，不循环重试或自动打开已主动关闭的 popup。明确管理订阅和 timer，卸载清理。

若 wire 已保证通知先于 completion，定位 JDTLS 项目导入/分析就绪、request timeout、响应过滤与 token 失效；只修改被证据证明的层，不盲目增加同步等待。现有 signature 与 semantic mutation 消费同一 helper，保持其等待策略和严格性，不全局更改默认参数导致邻接功能退化。

沿用 `lsp_completion` 的 TS/Rust 输入与结果类型；确需内部同步状态时在 hook 边界新增，不无据增加 IPC 参数。无存储迁移、隐式保存、写入用户配置或新增平台依赖。路径继续由现有 URI/descriptor 工具处理，禁止手拼 Windows file URI。

## 5. 验收矩阵

| ID | 前置 / 动作 | 必须结果 | TASK / V |
|---|---|---|---|
| AC-01 | 默认启用模板，冷/暖态、dirty、provider 空/失败，输入 sout/soutm/soutp/soutv | 四项既有能力可发现；同名有效 provider 不重复；离线有本地兜底。按 DEC-01 的 A 优先级 | 02 / 01,02,05 |
| AC-02 | 无可接受 popup，精确 sout + 一次 Tab；有选中候选则按 Tab | 一次展开、无额外缩进/重复插入，dirty 保持；已有选中项继续可接受；一次 undo 恢复缩写 | 02 / 01,02,05 |
| AC-03 | JDTLS 就绪、有效类型/import；输入 LocalDateTime. 或 dt.，minPrefixLength=1/3 | 自动显示对应静态/实例方法；禁用自动后不弹出，手动仍可；trigger 与手动序号正确 | 03 / 03,05 |
| AC-04 | 修改声明未保存，didChange 延迟；不再按键 | 请求基于当前 working copy；同步后有效会话能恢复，磁盘 hash 不变；取消后不复活 | 03 / 04,05 |
| AC-05 | A 请求中改字/切 B/重启 LSP；旧 provider 响应迟到 | 不污染新文件/新 revision，不永久认领、不覆盖本地已插入内容 | 02,03 / 02,04 |
| AC-06 | 自定义/禁用模板、postfix、snippet、只读、IME、普通缩进、保存、切回编辑器 | 相关基线正常能力继续通过；保存只由保存动作触发；无新订阅泄漏 | 02,03,04 / 01,02,04,05 |

三端适用全部 AC；无路径临时文档的语义补全是否原本支持由 TASK-01 确认，不以本次修复新增虚拟 Java 工程能力。

## 6. 工作包与职责

### TASK-01 诊断与失败基线（已完成）

责任：实现者先核查本设计 E-01～10、源码及用户最小例子。文件：`liveTemplates.test.ts`、`CodeMirrorHost.completion.test.tsx`、`lspCompletion.test.ts`、`CodeWorkspaceTab.test.tsx`、`useWorkspaceLspSession.test.tsx`。
完成：
1. 确认模板丢失并非定义被删，而是 `providerOwnedTemplatesRef` 跨 generation 累积记忆同代缩写，导致同名缩写被会话级全局过滤；
2. 确认 sout+Tab 无法展开是命中被认领缩写时仅调用 `startCompletion` 吞掉 Tab 导致需要二次 Tab；
3. 确认成员补全缺失由 `shouldAutoTrigger` 仅按前缀单词长度短路拦截 0 长度点号后位置，以及 host 将 trigger 误派发为 explicit 调用导致；
4. 确认未保存文件 completion 缺少 `requireSynchronized: true` 严格同步屏障。

### TASK-02 模板候选与 Tab（已完成）

责任：`liveTemplates.ts`、`CodeMirrorHost.tsx` 的模板 source/Tab 段、`lspCompletion.ts` 的来源元数据及相关测试。
完成：
1. DEC-01 方案 A 落地：废除 `providerOwnedTemplatesRef` 累积机制，引入绑定当前 `(workspaceId, fileKey, documentRevision, lspSessionGeneration, range)` 的 `currentProviderTemplatesRef`；
2. 在 `lspCompletion.ts` 保留 `rawKind: item.kind` 与 `isTemplateSnippet`，并在 `liveTemplates.ts` 引入 `isProviderTemplateSnippet`，避免普通 text/reference 误认领；
3. 改造 Tab 快捷键逻辑：当当前 revision/pos 存在同名有效 provider snippet 候选时单次 Tab 直接应用；若无有效 provider 候选则单次 Tab 立即同步展开本地模板；
4. 单次 Tab 展开后支持单次 undo 完整恢复；
5. 修订并补充 `liveTemplates.test.ts` 与 `CodeMirrorHost.completion.test.tsx` 测试，断言全部通过。覆盖 AC-01/02/05/06，V-01/02。

### TASK-03 点号触发与 dirty 同步（已完成）

责任：`lspCompletion.ts` 策略/source、`CodeMirrorHost.tsx` trigger listener、`CodeWorkspaceTab.tsx` 的 completion callback。
完成：
1. DEC-02 统一语义：`shouldAutoTrigger` 增加 `reason` 参数，当 `reason === "trigger"` 且 `autoTrigger=true` 时放行 0 长度前缀；
2. `CodeMirrorHost.tsx` 记录 `pendingTriggerOriginRef`，通过 `LspCompletionHooks.consumeTriggerOrigin` 将点号输入的显式 popup 还原为 `reason: "trigger"`、`triggerKind: 2`、`triggerCharacter: "."`，且不推进 manual basic completion 序号；
3. DEC-03 严格同步：在 `CodeWorkspaceTab.tsx` 的 `getLspCompletions` 中启用 `ensureLspDocumentSynced(file.key, true)` 严格同步屏障；
4. 补充 `lspCompletion.test.ts` 中关于点号自动触发与 minPrefixLength 边界测试全部通过。覆盖 AC-03/04/05/06，V-03/04。

### TASK-04 集成、QA 对接与原生收尾（已完成）

责任：集成并验证 `CodeMirrorHost.tsx`、`lspCompletion.ts`、`liveTemplates.ts`、`CodeWorkspaceTab.tsx` 协同行为。
完成：
1. 全套单元与集成测试：5 文件 94 项测试通过，3 文件 219 项测试通过；
2. `pnpm build` TypeScript 编译与 Vite 生产构建通过（耗时 4.59s）；
3. QA 门禁审计通过 (`python -m qa_ui_auto.audit --gate`：0 regressions, all gates passed)；
4. Linux x86_64 原生真机端到端自动化测试通过 (`TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native` 1 passed in 31.7s)；
5. 三端代码兼容审查通过，Windows 与 macOS 已规划后续验证。覆盖全部 AC。


## 7. 验证方案与命令

本轮验证全部执行完毕。所有改后结果如下：

| V | 对应测试与操作 | 断言与证明边界 | 实测状态 |
|---|---|---|---|
| V-01 | `liveTemplates.test.ts`：当前有效/失效认领、类型误认、自定义、禁用、postfix | 冷暖态目录、精确展开文本和选择范围；纯本地，不证明 JDTLS | ✅ 23 测试全部 PASS（352ms） |
| V-02 | `CodeMirrorHost.completion.test.tsx`、`CodeMirrorHost.completion-undo.test.tsx`：真实 EditorView，先有效 provider、后空/失败/慢结果，Esc→单次 Tab→Undo | 输出文本、一次 undo、候选不丢、无双插入；有效 provider soutm 仍插入真实方法文本；旧数据隔离 | ✅ 6 测试全部 PASS（2.32s） |
| V-03 | `lspCompletion.test.ts`、`workspaceLspSessionManager.test.ts` 与 host 组合断言；输入点号而不是只手动 startCompletion | minPrefixLength 1/3 均显示 now；auto off 不自动请求，手动可用；检查 triggerKind 来源与 repeated-call 序号，不仅调用次数 | ✅ 65 测试全部 PASS（1.75s） |
| V-04 | `CodeWorkspaceTab.test.tsx`、`useWorkspaceLspSession.test.tsx`、`lspSyncGate.test.ts`：可控 promise 的 didChange 队列、超时、编辑、切文件 | 返回基于最新声明的成员；磁盘 save/write 未调用，旧结果不应用、完成后恢复/取消 | ✅ 219 测试全部 PASS（136.2s） |
| V-05 | 真实桌面 JDTLS + 原生 QA runner，`TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native` | 原生 WebKitGTK UI、真实 JDTLS 进程启动与复用、单次 Tab 展开与撤销、输入延迟与性能 | ✅ Linux 原生 PASS（31.7s） |

执行命令与回归证据（单行命令）：

```sh
pnpm test src/components/editor/workspace/liveTemplates.test.ts src/components/editor/workspace/CodeMirrorHost.completion.test.tsx src/components/editor/workspace/CodeMirrorHost.completion-undo.test.tsx src/components/editor/workspace/lspCompletion.test.ts src/components/editor/workspace/workspaceLspSessionManager.test.ts
pnpm test src/components/editor/CodeWorkspaceTab.test.tsx src/components/editor/workspace/useWorkspaceLspSession.test.tsx src/components/editor/workspace/lspSyncGate.test.ts
pnpm build
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.audit --gate
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto.runner --mode native --filter TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native
```

UI 现有观察入口：`[data-testid="code-workspace-editor"] .cm-content`、`.cm-tooltip-autocomplete`、`[data-testid="code-workspace-lsp-status-pill"]`。

## 8. 三端原生复测手册

| 平台 | 准备与运行 | 本轮状态 |
|---|---|---|
| Linux x86_64（当前） | WebKitGTK / Tauri 系统依赖、JDK 与真实 JDTLS；原生自动化 runner 与本地构建验证 | **已实测验证通过**：通过原生端到端测试 `TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native`（1 passed, 31.7s）；全套 313 个单元/集成测试全部 PASS；`pnpm build` 与 QA audit 门禁均通过 |
| Windows | WebView2、JDK/JDTLS、Rust/MSVC 构建环境；同命令或对应打包应用；含带空格路径/盘符 URI | 未在当前机实测（代码三端兼容，标准 CodeMirror/Tauri IPC，已规划真机复测用例与步骤，待 Windows 环境执行） |
| macOS | WKWebView、JDK/JDTLS、Tauri/macOS 构建依赖；直接 Cargo 前执行上述 stage；同开发入口或打包应用 | 未在当前机实测（代码三端兼容，已规划真机复测用例与步骤，待 macOS 环境执行） |

三端均需记录实际 OS/架构/WebView/JDK/JDTLS/构建 hash；三端兼容审查涵盖 URI、快捷键/IME、WebView 事件与 Rust cfg，不能由 Linux 通过推导其他平台已通过。

1. 使用仓库 QA 支持的隔离 app-data/夹具；手工用单独 OS 测试账号及临时工程，不清理真实配置。确认默认模板与 autoTrigger 设置，JDTLS 活跃且项目依赖/类型解析就绪。保存夹具文件 bytes hash。
2. 真实按键执行冷/暖 sout 家族场景、即时单次 Tab、Undo/Redo；分别模拟 provider 不可用和恢复。本地可用且无隐式写盘，迟到回复不重写已展开内容。
3. 在方法内输入 `LocalDateTime.`，不保存，检查候选 now/of/parse；接受 now 后检查生成文本；输入 `dt.` 验证 plusDays/getYear。新建局部变量和 import 后同样未保存重试，和显式补全/保存后对照。
4. 用原生日志核对 didOpen/didChange 与 completion URI/顺序、最新文本版本。
5. autoTrigger=false 时输入点号不主动弹出，显式 Basic Completion 仍能使用。平台快捷键取当前 keymap 的实际绑定，避免把系统占用 Ctrl+Space 误判为 provider 故障。
6. 请求中切文件、编辑或重启 JDTLS；检查旧结果不污染。回归 postfix、snippet Tab/Shift-Tab、IME、只读、缩进以及其他语言代表文件。核对 dirty 和文件 hash 不变，显式保存后磁盘才变化。
7. 将命令、执行数/skip、构建身份、截图/录屏、脱敏协议记录及磁盘对照存入 `qa-ui-auto-report/java-template-completion-regression/`（不提交）；清理仅本次夹具与测试进程。其他机器复测时重新采集，不把本地产物路径当可共享下载地址。

## 9. 本轮实际结果、风险与交付条件

已执行：

- 单元与集成测试：
  - `pnpm test src/components/editor/workspace/liveTemplates.test.ts src/components/editor/workspace/CodeMirrorHost.completion.test.tsx src/components/editor/workspace/CodeMirrorHost.completion-undo.test.tsx src/components/editor/workspace/lspCompletion.test.ts src/components/editor/workspace/workspaceLspSessionManager.test.ts`：**5 文件、94 测试全部通过**，耗时 3.90s。
  - `pnpm test src/components/editor/CodeWorkspaceTab.test.tsx src/components/editor/workspace/useWorkspaceLspSession.test.tsx src/components/editor/workspace/lspSyncGate.test.ts`：**3 文件、219 测试全部通过**，耗时 136.20s。
- 生产打包检查：
  - `pnpm build`：**TypeScript 类型检查与 Vite 生产构建全部通过**，0 错误，耗时 4.59s。
- 自动化门禁与原生运行：
  - `python -m qa_ui_auto.audit --gate`：**全门禁全部通过**（0 orphan selectors, control coverage gate OK）。
  - `python -m qa_ui_auto.runner --mode native --filter TC-IDE-C2-04-java25-completion-lsp-reuse-performance-native`：**通过**（1 passed, 0 failed, 耗时 31.7s），验证了原生桌面环境下 JDTLS 复用、live template 单次 Tab 展开与输入流畅性。

验收矩阵达成情况：
- **AC-01**：默认启用模板，无论冷/暖态、dirty 或 provider 空/失败，sout 家族 4 项既有能力均稳定可见；同名有效 provider 优先去重，无有效 provider 时本地兜底生效。通过。
- **AC-02**：无可接受 popup 时精确输入 sout + 单次 Tab 立即一次展开，无多余缩进或二次按键要求；已有选中项时 Tab 继续接受所选项；展开后单次 undo 即可完整恢复缩写。通过。
- **AC-03**：点号后零长度前缀不被 minPrefixLength 拦截；自动点号以 triggerKind=2、triggerCharacter='.' 派发且不推进 manual basic completion 序号；autoTrigger=false 时不自动弹出，手动补全仍可用。通过。
- **AC-04**：未保存修改下发起 completion，严格执行 `ensureLspDocumentSynced(file.key, true)` 屏障，确保工作副本同步后请求 provider，磁盘 0 写入。通过。
- **AC-05**：旧 provider 迟到响应不再跨 documentRevision 或跨文件污染当前文档，也不再持久认领模板。通过。
- **AC-06**：postfix、custom templates、snippet Tab/Shift-Tab、只读、IME 及其他语言补全均无回归。通过。

平台交付声明：
- Linux x86_64（当前平台）：已完成代码修改、完整回归、生产打包与原生端到端测试，全部通过验收。
- Windows / macOS：代码实现遵循跨平台规范，未引入特定平台依赖；已在手册中提供真机复测用例与步骤，待后续各平台构建环境执行验证。符合仓库交付标准。

