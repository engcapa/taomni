# Code Workspace 轻量 IDE 化设计方案

> 目标：在现有 Code Workspace 基础上做功能与交互完善，达到"日常代码开发够用"的 IntelliJ IDEA 级体验（非全量对标）。本文档为设计稿，不含实现代码。
>
> 日期：2026-07-11 · 版本：v2.5（M0 抽取 + 合并门禁，见 §8.1–8.2）· 状态：**实施中**（分支 `feat/code-workspace-ide`；P0 已交付，M0 壳抽取进行中，真机冒烟人工待办）

---

## 1. 现状盘点（As-Is）

| 领域 | 已有能力 | 载体 |
|------|----------|------|
| 工作区模型 | 多根目录（folder/git）+ 松散文件（loose files）、最近工作区 | `CodeWorkspaceTabInfo`，tab 类型 `code-workspace` |
| 文件树 | tree/compact/flat 三种视图、名称过滤、新建/重命名/删除、Git 状态徽标、树字号缩放 | `CodeWorkspaceTab.tsx`（当前约 3.7k 行单文件，文件树视图壳已抽离） |
| 编辑器 | CodeMirror 6：行号、折叠、括号匹配、多光标、历史、词级补全、活动行高亮 | 同上 |
| Markdown | edit/preview/split，Mermaid 渲染 + SVG/PNG 导出 | 同上 |
| LSP | 10 种语言预设 + 自定义命令；didOpen/Change/Save/Close、publishDiagnostics、hover、definition、references；服务探测 | `src-tauri/src/lsp.rs`、`src/lib/editor/lsp.ts` |
| Git | 快照/暂存/提交/日志/diff/分支/标签/stash/merge/rebase/cherry-pick/冲突/远端认证 —— 已相当完整 | `src/lib/git.ts`、`components/git/WorkspaceGitManager` |
| 外观 | code view profile（主题/字号）与设置页共享，编辑区/树独立缩放 | `codeViewProfile.ts` |

**明确缺失（vs 日常 IDE 开发）：**

1. 编辑器内查找/替换（未引入 `@codemirror/search`）
2. 语言智能只有"只读四件套"（诊断/悬停/定义/引用）——无补全、签名帮助、快速文档、重命名、格式化、Code Actions、类/符号查找、调用层级、类型层级、实现跳转、用法高亮、inlay hints
3. 全局内容搜索（Find in Files）——只有文件名过滤
4. 导航体系：Search Everywhere、Go to File/Class/Symbol、Recent Files、前进/后退
5. Problems 汇总面板、Outline/结构视图
6. 编辑区分屏、编辑器 tab 管理（固定/关闭其他/中键关闭）、面包屑
7. 集成终端（终端目前是独立 tab，与工作区无联动）
8. Git 编辑器内呈现：gutter 变更标记、inline blame
9. Run/Tasks（脚本探测与运行）
10. 本地历史（Local History）
11. 树右键菜单、拖拽（文件操作目前依赖工具栏按钮）
12. 仅支持本地文件系统（`workspace.rs` 全部走本地路径）

---

## 2. 目标与范围

### 2.1 产品定位

Code Workspace 是 taomni 内的"轻量 IDE 面"：日常改代码、查代码、提交代码的主战场。重活（调试、重型重构、Profiling）仍交给外部 IDE，taomni 的差异化是**与终端/SSH/SFTP/AI 的一体化**。

### 2.2 范围分级

| 级别 | 内容 |
|------|------|
| **P0（核心补齐）** | 编辑器查找替换；语言智能核心（补全/签名/快速文档/重命名/格式化/Code Action/类与符号查找/实现与类型跳转/文档符号）；Find in Files；Search Everywhere + 导航体系；Problems 面板；Outline；树右键菜单 |
| **P1（体验对齐）** | 编辑区分屏、编辑器 tab 管理、面包屑、集成终端底部面板、调用层级/类型层级、用法高亮、inlay hints、Git gutter/inline blame、Run/Tasks、工作区状态持久化增强 |
| **P2（差异化/加分）** | 本地历史、TODO/书签面板、语义高亮、AI 深度集成（解释/修复/生成 + diff 应用）、远程工作区（SSH 根目录）探索 |

### 2.3 非目标（明确不做）

- **完整调试器（DAP）**：工程量为独立大项目，远期另立设计
- **索引式重构**（move class、change signature 等超出 LSP 能力的重构）
- **插件系统 / 市场**
- **内建构建系统模型**（如 IDEA 的 project model / facets）——只做"任务运行器"级别
- 不替代现有 Git Manager 的完整功能，只做编辑器内的轻量呈现与入口

---

## 3. 交付物与交互原型

本设计阶段交付两件产物：

| 交付物 | 位置 | 说明 |
|--------|------|------|
| 设计文档（本文档） | `claudedocs/code-workspace-ide-design.md` | 功能/技术/交互/计划 |
| **HTML 交互原型** | **`claudedocs/prototype/code-workspace-prototype.html`** | 单文件、零依赖，浏览器直接打开即可交互演示 |

### 3.1 原型覆盖的交互（评审时逐项体验）

1. **总体布局**：左树 / 编辑区 / 右侧 Outline / 底部 dock / 状态栏，三区均可折叠（工具条右侧按钮）
2. **文件树**：展开/折叠、单击预览打开（斜体 tab）、双击固定、右键菜单
3. **编辑器 tab**：切换、关闭、固定 tab 示意、dirty 圆点
4. **面包屑**：路径 + 光标所在符号
5. **Search Everywhere**：双击 `Shift` 或点顶部搜索框，All/Classes/Files/Symbols/Actions/Text 六个分组，实时过滤，Enter 打开
6. **编辑器内查找**：`Ctrl+F` 弹出查找条，实时高亮 + 计数
7. **语言智能演示**（代码中带下划线虚线的标识符为可交互符号）：
   - 悬停 → 快速文档浮层（Quick Documentation）
   - 单击 → 同符号用法高亮（documentHighlight）
   - 右键 → 符号菜单：跳转声明 / 查找用法 / 调用层级 / 类型层级 / 重命名 / 快速文档
   - 重命名 → 内联输入框（Shift+F6 语义）
   - 波浪线行 → 行首灯泡 / `Alt+Enter` → Quick Fix 菜单
8. **底部 dock**：Problems（徽标计数、点击跳转）、Find in Files（结果树、点击定位）、Terminal（占位）、Run（任务列表）、References、Call Hierarchy（Callers⇄Callees 方向切换、懒展开）
9. **Git 呈现**：gutter 变更色条（绿/蓝/红）、inline blame 开关（工具条按钮）
10. **分屏**：工具条按钮切换双栏
11. **导航历史**：工具条 ←/→ 按钮随打开文件记录前进后退
12. **状态栏**：行列、编码、语言 + LSP 状态点、Git 分支，随激活文件联动
13. 右上角 **?** 按钮内置"操作指南"清单

### 3.2 原型的边界（不要拿原型当验收标准）

- 纯前端假数据演示**交互结构与信息架构**，不代表最终视觉规范（最终视觉沿用 taomni 主题体系）
- 不含真实编辑、真实 LSP、真实文件系统；代码区为只读展示
- 键盘交互仅实现演示所需子集（双 Shift、Ctrl+F、Alt+Enter、Esc、Alt+F12）

---

## 4. 总体 UI 布局设计

采用 IDEA 式"工具窗停靠"布局，但保持 taomni 现有 tab 体系不变（Code Workspace 仍是一个顶级 tab）：

```
┌────────────────────────────────────────────────────────────────────┐
│ 顶部：工作区工具条（根管理 · Search Everywhere 入口 · 导航/布局按钮） │
├──────────┬─────────────────────────────────────────────┬───────────┤
│ 左侧工具窗│  编辑区（可水平/垂直分屏）                    │ 右侧工具窗 │
│          │ ┌─────────────────────────────────────────┐ │           │
│ ▸ 项目树  │ │ 编辑器标签栏（可固定/拖拽/中键关闭）        │ │ ▸ Outline │
│          │ ├─────────────────────────────────────────┤ │ ▸ 文档     │
│ (可折叠)  │ │ 面包屑：src > editor > … > 符号路径        │ │ ▸ AI 助手 │
│          │ ├─────────────────────────────────────────┤ │ (可折叠)  │
│          │ │           CodeMirror 编辑器               │ │           │
│          │ │  gutter: 行号/折叠/Git 变更标记/灯泡        │ │           │
│          │ └─────────────────────────────────────────┘ │           │
├──────────┴─────────────────────────────────────────────┴───────────┤
│ 底部工具窗（tab 切换，可折叠）：                                      │
│ [Problems] [Find in Files] [Terminal] [Run] [References]            │
│ [Call Hierarchy] [Type Hierarchy]                                   │
├────────────────────────────────────────────────────────────────────┤
│ 状态栏：光标位置 · 编码/换行符 · 语言/LSP 状态 · Git 分支 · 缩放      │
└────────────────────────────────────────────────────────────────────┘
```

**布局原则：**

1. **三区可折叠**：左/右/底部工具窗都可一键折叠（IDEA 的 stripe 行为简化版：只保留折叠/展开与尺寸拖拽记忆，不做浮动/窗口化）。
2. **底部工具窗是新增结构**：现有 References 面板并入底部 dock；Terminal、Problems、Find in Files、Run、Call/Type Hierarchy 都以底部 tab 呈现。每个 tab 有徽标计数（如 Problems 的错误数）。
3. **右侧工具窗**：Outline（文档符号树）为主；Documentation（固定的快速文档）与 AI 助手为可选 tab。
4. **状态栏**：Code Workspace 激活时向全局状态栏注入分段信息（光标行列、语言与 LSP 状态点、当前文件所属 Git 分支）。点击各分段有对应动作（如点击语言段打开 LSP 服务器选择）。
5. **现有 Git Manager 保持独立**，底部不设 Git tab（待决问题 §10.1），状态栏分支段作为入口。

---

## 5. 功能模块详细设计

### 5.1 编辑器核心增强（P0）

#### 5.1.1 查找 / 替换（编辑器内）

- 引入 `@codemirror/search`，替换默认面板为自绘 UI（与 taomni 主题一致），支持：大小写/整词/正则、替换单个/全部、匹配计数、`F3`/`Shift+F3` 循环。
- 选中文本后按 `Ctrl+F` 自动填充查询词（IDEA 行为）。

#### 5.1.2 编辑命令补齐（纯前端，CodeMirror commands）

`Ctrl+/` 行注释、`Ctrl+Shift+/` 块注释、`Ctrl+D` 复制行（IDEA 语义）、`Ctrl+Y` 删除行、`Alt+Shift+↑/↓` 移动行、`Ctrl+W`/`Ctrl+Shift+W` 扩大/缩小选区（优先 LSP selectionRange，回退 syntaxTree，见 §5.2.13）、`Ctrl+G` 跳转行:列。冲突处理见 §7。

#### 5.1.3 诊断呈现升级

- 引入 `@codemirror/lint` 的 setDiagnostics 通道：波浪线 + gutter 图标 + 右侧 overview ruler 色条（error 红 / warning 黄）。
- 悬停诊断与 hover 信息合并为单浮层（先诊断后文档）。
- 诊断行 gutter 显示灯泡（有可用 Code Action 时），衔接 §5.2.9。

### 5.2 语言智能与代码洞察（P0/P1，本方案核心）

对标 IDEA 日常使用频率最高的语言功能，全部经由 LSP 标准协议实现，**不自建索引**。

#### 5.2.0 设计原则：capability 驱动的功能开关

- LSP server `initialize` 返回的 `ServerCapabilities` 由后端缓存，并随 `LspDocumentStatus` 附带 `capabilities` 摘要（如 `{ completion: true, callHierarchy: false, … }`）下发前端。
- **UI 按能力开关**：server 不支持的功能，菜单项置灰 + tooltip 说明（沿用现有 installHint 机制），绝不静默失败或伪造结果。
- 每个请求带取消语义（编辑/切换文件即作废旧请求），防止过期结果回填。

#### 5.2.1 功能 → LSP 协议映射总表

| IDEA 功能 | 快捷键 | LSP 方法 | UI 载体 | 优先级 |
|-----------|--------|----------|---------|--------|
| 基础补全 | Ctrl+Space / 输入触发 | `textDocument/completion` + `completionItem/resolve` | 编辑器补全浮层 | P0 |
| 参数信息 Parameter Info | Ctrl+P | `textDocument/signatureHelp` | 编辑器浮层 | P0 |
| 快速文档 Quick Documentation | Ctrl+Q / 悬停 | `textDocument/hover`（已有，升级渲染） | 浮层，可固定到右栏 | P0 |
| 跳转声明 | Ctrl+B / Ctrl+Click | `textDocument/definition`（已有） | 跳转 / 多结果 peek | 已有→增强 |
| 跳转类型声明 | Ctrl+Shift+B | `textDocument/typeDefinition` | 跳转 / peek | P0 |
| 跳转实现 | Ctrl+Alt+B | `textDocument/implementation` | 跳转 / peek | P0 |
| 查找类 Go to Class | Ctrl+N | `workspace/symbol`（客户端按 kind 过滤） | Search Everywhere Classes tab | P0 |
| 查找符号 Go to Symbol | Ctrl+Alt+Shift+N | `workspace/symbol` | Search Everywhere Symbols tab | P0 |
| 文件结构弹窗 | Ctrl+F12 | `textDocument/documentSymbol` | 快捷弹窗（可输入过滤） | P0 |
| 结构工具窗 Outline | — | `textDocument/documentSymbol` | 右侧工具窗 | P0 |
| 查找用法 Find Usages | Alt+F7 | `textDocument/references`（已有） | 底部 References（迁移） | 已有 |
| 用法高亮 | 光标停留自动 | `textDocument/documentHighlight` | 编辑器装饰（读/写区分底色） | P1 |
| **调用层级 Call Hierarchy** | Ctrl+Alt+H | `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls` + `outgoingCalls` | 底部面板，方向可切换 | P1 |
| **类型层级 Type Hierarchy** | Ctrl+H | `textDocument/prepareTypeHierarchy` + `typeHierarchy/supertypes` + `subtypes`（LSP 3.17） | 底部面板 | P1 |
| 重命名 | Shift+F6 | `textDocument/prepareRename` + `rename` | 内联输入 + 跨文件预览 | P0 |
| 格式化 | Ctrl+Alt+L | `textDocument/formatting` / `rangeFormatting` | — | P0 |
| 意图动作 / Quick Fix | Alt+Enter | `textDocument/codeAction` + `workspace/executeCommand` | 灯泡菜单 | P0 |
| Inlay Hints（参数名/类型） | 设置开关 | `textDocument/inlayHint`（按视口 range 请求） | 编辑器内嵌只读 widget | P1 |
| 语义高亮 | 自动 | `textDocument/semanticTokens/full` + `delta` | 编辑器装饰 | P2 |
| 智能选区 | Ctrl+W | `textDocument/selectionRange` → syntaxTree 回退 | — | P1 |
| 折叠范围 | — | `textDocument/foldingRange` → 语法回退 | — | P2 |

#### 5.2.2 补全与签名帮助

- 前端用 `@codemirror/autocomplete` 的异步 completion source 接 LSP；LSP 不可用时回退到现有词级补全。
- 补全项渲染：类型图标（method/field/class/keyword…，按 `CompletionItemKind`）+ 主标签 + 右对齐 detail（类型签名）；选中项懒调 `completionItem/resolve` 拉取文档，右侧展开文档浮层。
- 排序遵循 server 的 `sortText`，过滤用 `filterText`；支持 snippet 插入格式（`${1:param}` 占位符 Tab 跳转）。
- **Auto-import**：应用补全项的 `additionalTextEdits`（典型为文件头插入 import）——这是 IDEA 用户感知最强的补全体验之一，必须支持。
- 触发策略：server 声明的 triggerCharacters + `Ctrl+Space` 手动；防抖 + 旧请求取消；`isIncomplete` 时续请求。
- 签名帮助：输入 `(`、`,` 触发（server triggerCharacters），浮层展示当前重载 + 活动参数加粗；`Ctrl+P` 手动唤起；`↑↓` 切换重载。

#### 5.2.3 快速文档（Quick Documentation）

- 现有 hover 升级：markdown 渲染复用 `renderFormatted`（代码块带语法高亮），支持滚动、最大高度限制。
- `Ctrl+Q` 显式弹出（不依赖鼠标悬停），`Esc` 关闭；浮层右上角 **pin 按钮** → 内容固定到右侧工具窗 Documentation tab，随光标符号联动刷新（可锁定）。
- 文档内链接策略：`http(s)` 外链走系统浏览器；`file:` 链接在工作区内打开。

#### 5.2.4 跳转类导航（声明 / 类型声明 / 实现）

- 单结果：直接跳转（进导航历史 §5.3.3）。
- 多结果：**peek 浮层**（编辑器内嵌列表：文件分组 + 目标行预览），`Enter` 跳转、`Ctrl+Enter` 分屏打开、`Esc` 关闭。
- 鼠标手势：`Ctrl+Click` = 跳转声明（下划线 hover 提示）；`Ctrl+Alt+Click` = 跳转实现。
- 结果不在当前打开根内时（如跳进依赖源码/标准库）：以**只读 loose file** 打开并标注"库文件（只读）"横幅。

#### 5.2.5 查找类 / 查找符号（Go to Class / Symbol）

- 数据源 `workspace/symbol`；**Classes tab** 在客户端按 `SymbolKind ∈ {Class, Interface, Struct, Enum, TypeParameter…}` 过滤（各语言映射：Rust trait→Interface、Go struct→Struct 等由 server 决定，客户端不做语言特判）。
- 客户端二次排序：camelCase 缩写匹配（`CWT` → **C**ode**W**orkspace**T**ab）> 前缀 > 子串；同分按路径长度升序。
- server 的 query 语义差异（有的做模糊、有的做前缀）通过客户端 re-rank 抹平。
- 无可用 LSP 时 Classes/Symbols tab 隐藏（不展示空壳）。

#### 5.2.6 调用层级（Call Hierarchy）

- 入口：符号右键菜单 / `Ctrl+Alt+H`；`prepareCallHierarchy` 得到根项后在**底部 Call Hierarchy 面板**展示。
- 方向切换：**Callers（谁调用了它，默认）⇄ Callees（它调用了谁）**，切换时以同一根项重查。
- 树节点：`符号名 · 容器名 — 文件名:行`；懒展开（展开时才请求下一层 incoming/outgoing）；每个节点可"设为新根"。
- 环检测：链路上出现重复符号时节点标 `↻` 且不可再展开；展开深度上限 16 层。
- 双击节点跳转到调用点（incoming 的 `fromRanges` 逐条列出，一次调用多处引用时展开为子行）。

#### 5.2.7 类型层级（Type Hierarchy）

- 入口：类/接口符号右键 / `Ctrl+H`；面板结构同调用层级：**Supertypes ⇄ Subtypes** 方向切换、懒展开、双击跳转。
- 仅在 server 声明 `typeHierarchyProvider` 时展示入口（该能力较新，支持面见 §5.2.12 矩阵）；不做 implementation 结果的"伪子类"降级——宁缺毋假。

#### 5.2.8 用法高亮（documentHighlight）

- 光标停留在标识符上 300ms（idle）后请求 `documentHighlight`，同文件内该符号的读用法/写用法用不同底色标出（IDEA 行为）。
- 无 LSP 时回退为"同词文本高亮"（不区分读写，样式更弱化以示区别）。

#### 5.2.9 重命名 / 格式化 / Code Actions

**重命名（Shift+F6）**：`prepareRename` 校验可行性 → 光标处符号内联输入框；跨文件时弹确认面板（文件 → 行变更清单，可取消）。

**WorkspaceEdit 应用规则**（重命名、Code Action 的 applyEdit、Replace in Files 共用）：

- 已打开且干净的 buffer → 应用到 buffer 并保存；
- 已打开且 dirty 的 buffer → 应用到 buffer，保持 dirty，由用户保存；
- 未打开的文件 → 后端直接改盘（带 hash 预检，文件被外部修改则该文件跳过并报告）；
- 任一文件失败不回滚已成功文件，结果面板明确列出成功/失败清单（LSP 语义下无法保证原子性，如实呈现）。

**格式化（Ctrl+Alt+L）**：整文件/选区；"保存时格式化"为工作区级开关（默认关）。server 无 formatter（如 pyright）时置灰 + 提示外部格式化器方向（P2 规划"外部 formatter 命令"配置，如 ruff/black/prettier）。

**Code Actions（Alt+Enter）**：携带诊断上下文请求；列表按 kind 分组（quickfix 置顶，source.organizeImports 等其后）；执行走 `workspace/executeCommand`，server 回推的 `workspace/applyEdit` 经 Tauri event + oneshot 应答处理（复用 cc_bridge 的 HITL 管道模式）。

#### 5.2.10 Outline 工具窗与文件结构弹窗

- **右侧 Outline**：documentSymbol 层级树，随激活编辑器切换刷新（防抖）；点击跳转；随光标高亮当前所在符号；名称过滤；"按位置/按类型/按名称"排序切换；可选"只显示公开成员"过滤（按 SymbolKind + 命名约定近似，标注为近似过滤）。
- **Ctrl+F12 结构弹窗**：同数据的轻量弹窗形态（IDEA 惯用），输入即过滤、`Enter` 跳转、`Esc` 关闭——高频导航靠弹窗，常驻浏览靠右栏。

#### 5.2.11 Inlay Hints 与语义高亮

- **Inlay hints（P1）**：参数名 hint、类型 hint 两类；请求按**当前视口 range**（滚动防抖后重取），避免大文件全量；渲染为行内只读 widget（样式弱化、不可选中不入剪贴板）；工作区级总开关 + 按语言开关，默认关（保守起步）。
- **语义高亮（P2）**：`semanticTokens/full` + `delta` 增量；与 Lezer 语法高亮叠加：LSP token 优先、Lezer 兜底。明确列为 P2——渲染与增量同步成本高，先验证 P0/P1 的价值。

#### 5.2.12 主流语言服务器矩阵

图例：● 预期支持 ◐ 部分/需较新版本 ○ 不支持或未知。**本表为方向性预估，运行时一律以 server capabilities 探测为准（§5.2.0），UI 按实际能力开关。**

| 语言 | 推荐 server（现有预设） | 补全 | 签名 | 重命名 | 格式化 | CodeAction | 调用层级 | 类型层级 | InlayHint | 语义高亮 |
|------|------------------------|------|------|--------|--------|------------|----------|----------|-----------|----------|
| TS / JS | typescript-language-server | ● | ● | ● | ● | ● | ● | ○ | ● | ● |
| Rust | rust-analyzer | ● | ● | ● | ● | ● | ● | ◐ | ● | ● |
| Python | pyright / basedpyright | ● | ● | ● | ○¹ | ◐ | ● | ○ | ◐ | ◐ |
| Go | gopls | ● | ● | ● | ● | ● | ● | ◐ | ● | ● |
| Java | jdtls | ● | ● | ● | ● | ● | ● | ◐² | ● | ● |
| C / C++ | clangd | ● | ● | ● | ● | ● | ● | ●³ | ● | ● |
| C# | omnisharp / roslyn LS | ● | ● | ● | ● | ● | ◐ | ○ | ◐ | ● |
| Kotlin | kotlin-language-server | ● | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ○ | ◐ |
| Swift | sourcekit-lsp | ● | ● | ◐ | ◐ | ◐ | ◐ | ○ | ○ | ◐ |
| Scala | metals | ● | ● | ● | ● | ● | ○ | ○ | ● | ● |

> ¹ pyright 系不提供格式化，需外部 formatter（P2 配置项）。² jdtls 早期为私有扩展，较新版本支持标准 typeHierarchy。³ clangd ≥ 15。

矩阵的工程含义：**P0 六件套（补全/签名/文档/重命名/跳转/CodeAction）在全部主流 server 可用**，是普适价值；调用/类型层级、inlay hints 在部分语言降级隐藏——这正是 capability 驱动开关（§5.2.0）的设计原因。

#### 5.2.13 智能选区与折叠（收尾项）

- `Ctrl+W/Ctrl+Shift+W`：优先 `selectionRange`（语义准确，尤其宏/模板场景），server 不支持时回退 Lezer syntaxTree 逐层外扩。
- 折叠：现有 Lezer 折叠保留；`foldingRange`（P2）可补足 region 注释、import 块等语言特定折叠。

### 5.3 导航体系（P0）

#### 5.3.1 Search Everywhere（双击 Shift）

单一弹窗，tab 分组：**All / Classes / Files / Symbols / Actions / Text**。

- **Classes / Symbols**：见 §5.2.5；LSP 不可用时隐藏。
- **Files**：文件名模糊匹配（camelCase 缩写匹配），数据源为后端递归文件清单（与 §5.4 索引复用）。
- **Actions**：工作区命令注册表（§6.2），如"格式化""切换树视图""打开终端"。
- **Text**：直接转入 Find in Files 面板并携带查询词。
- 交互：`↑↓` 选择、`Enter` 打开、`Ctrl+Enter` 在分屏另一侧打开；`Tab` 切换分组；记忆最近一次分组。

#### 5.3.2 独立入口

- `Ctrl+N` Go to Class、`Ctrl+Shift+N` Go to File、`Ctrl+Alt+Shift+N` Go to Symbol（直达对应 tab）
- `Ctrl+E` Recent Files 弹窗（含已关闭文件；连按在最近两个文件间切换）
- `Ctrl+G` Go to Line:Column
- `Ctrl+F12` 文件结构弹窗（§5.2.10）

#### 5.3.3 导航历史（前进/后退）

- 工作区级导航栈：记录 (文件, 光标位置)；产生记录的动作：打开文件、各类跳转（声明/实现/引用/搜索结果/行跳转）、大幅光标移动（跨 50+ 行）。
- `Ctrl+Alt+←/→` 后退/前进；栈上限 100，去重相邻同位置项。

### 5.4 全局搜索 Find in Files（P0）

**后端（新增 Rust 模块 `workspace_search`）：**

- 基于 ripgrep 生态 crates：`ignore`（遵循 .gitignore/.ignore，跳过二进制）+ `grep-searcher`/`grep-regex`。
- 命令：`workspace_search_start(roots, query, opts) -> searchId`，结果经 Tauri event 流式推送（批量分片，每批 ≤200 条），`workspace_search_cancel(searchId)` 取消。
- opts：大小写/整词/正则、include glob、exclude glob、是否搜 ignore 文件、单文件匹配上限、总匹配上限（默认 10k，达到即截断并标记）。
- 同一机制顺带提供 `workspace_replace_in_files`：先搜索预览，用户确认后按文件写回（走 §5.2.9 的 WorkspaceEdit 应用规则）。

**前端（底部 Find in Files tab）：**

```
[查询输入 (Aa|W|.*)] [替换输入]  [过滤: include glob | exclude glob]
[范围: 全部根 ▾ | 指定目录…]                       [123 结果 · 45 文件]
─────────────────────────────────────────────────────────────
▾ src/components/editor/CodeWorkspaceTab.tsx (12)
    841:  const setTreeFontSize = useCallback(...    ← 命中行，关键词高亮
▾ src/lib/editor/workspace.ts (3)
    ...
```

- 结果树按文件分组、懒展开；单击预览（编辑器打开为预览 tab，见 §5.6.2），双击固定打开并定位。
- 替换模式下逐条勾选 + 行内 diff 预览（删除线旧词 → 新词）；"全部替换"前给出文件数/命中数确认。
- 从文件树目录右键"在此目录中查找"可预设范围。

### 5.5 Problems 面板（P0）

- 汇总**所有已打开文件**的 LSP 诊断（当前 LSP 架构按打开文档推送诊断，不做全项目后台索引——面板标题注明"打开的文件"，如实呈现边界）。
- 按文件分组，severity 图标 + 消息 + 来源 + 行列；点击跳转；顶部按 severity 过滤。
- 底部 dock tab 徽标显示错误数（红）/警告数（黄）。
- 每条目支持右键：复制消息 / Quick Fix（转 §5.2.9）。

### 5.6 编辑区与标签管理（P1）

#### 5.6.1 分屏

- 支持一次水平或垂直二分（不做任意网格，控制复杂度）；每个分屏是独立 editor group，有自己的 tab 栏与激活文件。
- 入口：tab 右键"右侧分屏打开 / 下方分屏打开"、`Ctrl+Enter`（在 Search Everywhere/树中）、拖拽 tab 到编辑区边缘触发停靠提示。
- 同一文件可在两个 group 打开：**共享同一 buffer**（同一 Text 状态，双视图编辑同步），避免脏数据分叉。
- 关闭 group 内最后一个 tab 时 group 收起，回到单编辑区。

#### 5.6.2 编辑器 Tab 行为

- **预览 tab**：单击树/搜索结果以斜体预览 tab 打开（复用同一个预览位），双击或编辑内容后转正式 tab。
- 固定（pin）：固定 tab 排最前，"关闭其他"不关固定项。
- 中键关闭、`Ctrl+F4` 关闭当前、右键菜单：关闭/关闭其他/关闭右侧/关闭未修改/全部关闭、复制路径（绝对/相对）、在文件树中定位（`Alt+F1`）、在系统资源管理器打开、在终端打开。
- dirty 标记（●）与关闭确认（保存/放弃/取消）；`Ctrl+S` 保存、全部保存入菜单。
- tab 溢出：横向滚动 + 下拉列表按钮（不做多行 tab）。

#### 5.6.3 面包屑

- 编辑器顶部：`根名 > 目录 > … > 文件 [> 符号路径]`；目录段点击弹出同级列表快速切换；符号段来自 documentSymbol 的光标符号链，点击弹出 Outline 快捷列表。

### 5.7 集成终端（P1）

- 底部 dock 的 Terminal tab，内嵌现有 `TerminalPanel`（本地 PTY），**cwd 默认为当前文件所在根目录**。
- 支持多终端实例（左侧竖条列表或下拉切换），"+" 新建时可选根目录。
- 定位：工作区附属终端，不进顶级 tab 栏、不参与会话管理；生命周期随工作区 tab 关闭而销毁（关闭前确认）。
- 联动：文件树/编辑器 tab 右键"在终端中打开"→ 激活底部终端并 cd；Run/Tasks（§5.9）输出复用此处实例。

### 5.8 Git 编辑器内呈现（P1）

- **Gutter 变更标记**：buffer 内容 vs HEAD 版本（`gitBlobPair` 已有能力）做 diff，gutter 渲染 新增(绿条)/修改(蓝条)/删除(红三角)；防抖 500ms 随编辑更新。
- 点击标记弹出内联 diff 浮层：旧文本 + [回滚此块] [复制旧文本] [在 Git 管理器中查看]。
- **Inline blame**（可开关，默认关）：当前行行尾灰字 `author, 3 months ago · commit summary`；按需 `git blame -L <line> --porcelain`，行级缓存，保存后失效。
- 状态栏 Git 段：当前文件所属 repo 分支 + ahead/behind；点击打开 Git 管理器。

### 5.9 Run / Tasks（P1）

**探测（后端命令 `workspace_detect_tasks(root)`）**，按根目录识别：

| 来源 | 任务 |
|------|------|
| package.json | scripts（含包管理器探测：pnpm/yarn/npm，按 lockfile） |
| Cargo.toml | build / test / run / clippy |
| Makefile / justfile | 目标列表 |
| build.gradle(.kts) / pom.xml | 常用生命周期任务（build/test） |
| go.mod | build / test / vet |
| pyproject.toml | scripts（若定义） |

**运行：**

- 底部 Run tab：任务列表（按根分组）+ 运行历史；点击任务 → 集成终端新实例以 PTY 运行（保留颜色与交互），Run tab 显示状态（运行中 / 退出码）。
- `Ctrl+F5` 重跑上一个任务；自定义任务（命令 + cwd，持久化到工作区状态）。
- 不做：运行配置对话框的复杂参数体系、环境变量管理 UI。

### 5.10 文件树交互完善（P0 部分 + P1 部分）

- **右键菜单（P0）**：新建文件/目录、重命名(`Shift+F6`)、删除(`Delete`)、复制/剪切/粘贴、复制路径/相对路径、在系统资源管理器打开、在终端打开、在此目录查找、（git 根下）Git 忽略此文件。
- **拖拽（P1）**：树内拖拽移动（跨根禁止提示）、系统拖入复制导入、拖文件到编辑区打开。
- **键盘导航（P0）**：`↑↓` 移动、`←→` 折叠/展开、`Enter` 打开、`F2`/`Shift+F6` 重命名、输入字母跳转匹配项。
- **自动定位（P1）**："在树中定位当前文件"按钮 + 可选"始终跟随激活编辑器"开关。
- 现有工具栏按钮保留，降级为次要入口。

### 5.11 本地历史 Local History（P2）

- 每次保存/外部覆盖/批量替换前，旧内容快照到 app-data 工作区目录（内容寻址去重 + SQLite 元数据：路径、时间、触发原因、hash）。
- 保留策略：单文件 50 版 / 7 天（可配置），LRU 清理。
- UI：tab 右键"查看本地历史"→ 版本时间线 + 与当前内容 diff（复用 `DiffPane`），支持恢复。
- 价值：IDEA 用户迁移的安全网，且 diff 组件可复用，性价比高。

### 5.12 AI 集成（P2，复用既有 ai/agent 能力）

- 编辑器选区浮动工具条（复用 `SelectionToolbar` 模式）：解释 / 修复诊断 / 生成注释 / 按指令改写。
- 改写类动作产出 diff 预览（复用 DiffPane），确认后应用到 buffer。
- 右侧 AI tab：带当前文件/选区/诊断上下文的会话（复用 chat store）；打通 Claude Code bridge 工作区级会话（工作区根作为 cc cwd）。
- 边界：只定义**入口与上下文注入协议**，不重造 AI 面板。

### 5.13 远程工作区（P2 探索项）

- 动机：taomni 本质是远程工作台，"打开 SSH 主机目录为 Code Workspace"是对标 VS Code Remote 的差异化能力。
- 方向：`workspace.rs` 文件操作抽象为 `WorkspaceFs` trait（local / sftp 两实现）；LSP 远程运行（SSH exec + stdio 转发）复杂度高，首期远程根只提供**编辑/搜索/Git**，LSP 标注不可用。
- 本期约束：新代码不写死本地路径假设（路径处理集中化），为 trait 化留缝。**不在本方案内实施。**

---

## 6. 技术架构设计

### 6.1 前置重构（M0，硬前提）

`CodeWorkspaceTab.tsx` 当前约 3.7k 行，继续堆功能不可维护。重构为：

```
src/components/editor/
  CodeWorkspaceTab.tsx          // 壳：布局 + 面板编排（目标 <400 行）
  workspace/
    FileTreePane.tsx            // 树 + 右键菜单 + 拖拽
    EditorGroup.tsx             // 单个编辑组（tab 栏 + CM 实例 + 面包屑）
    EditorTabs.tsx
    Breadcrumbs.tsx
    CodeMirrorHost.tsx          // CM 封装：compartment 管理、扩展装配
    lsp/
      completionSource.ts       // LSP → CM autocomplete 适配
      signatureHelp.ts
      quickDoc.tsx
      hierarchyModel.ts         // 调用/类型层级共用树模型
    panels/
      BottomDock.tsx            // 底部工具窗容器
      ProblemsPanel.tsx
      FindInFilesPanel.tsx
      TerminalDockPanel.tsx
      RunPanel.tsx
      ReferencesPanel.tsx       // 迁移现有实现
      CallHierarchyPanel.tsx
      TypeHierarchyPanel.tsx
      OutlinePane.tsx           // 右侧
    SearchEverywhere.tsx        // 弹窗
    StructurePopup.tsx          // Ctrl+F12
    statusbarSegments.tsx
src/stores/
  codeWorkspaceStore.ts         // 按 workspaceInstanceId 分片的 zustand store
```

- **状态迁移**：现组件内 ~30 个 useState 迁入 `codeWorkspaceStore`（keyed by instanceId），面板组件各取所需，消除 props 钻透；refs 同步样板代码随之消失。
- **重构验收**：现有 `CodeWorkspaceTab.test.tsx` 全绿 + 手工回归清单（打开/编辑/保存/LSP/Git 徽标/缩放）。M0 不改行为。

### 6.2 命令系统

- 新建工作区命令注册表 `workspaceCommands.ts`：`{ id, title, keybinding?, when?, run(ctx) }`；Search Everywhere 的 Actions tab、右键菜单、快捷键分发共用此表。
- 与现有 `menubar/commands.ts`（AppCommand）对接：工作区激活时把工作区命令桥接进应用菜单动态区。
- 快捷键分发：工作区根节点统一 keydown 捕获（现有缩放监听已是此模式），按 `when` 上下文（editorFocus/treeFocus/terminalFocus）路由。

### 6.3 CodeMirror 扩展映射

| 功能 | 扩展/实现 |
|------|-----------|
| 查找替换 | `@codemirror/search`（自绘 panel） |
| LSP 补全 | `@codemirror/autocomplete` 异步 source + 自绘 option 渲染 |
| 签名帮助 / peek / 快速文档 | `showTooltip` / 内嵌 widget（StateField 管理） |
| 诊断 | `@codemirror/lint` setDiagnostics |
| 用法高亮 | Decoration mark（读/写两种样式） |
| Inlay hints | 行内 widget Decoration（视口 range 请求） |
| 选区扩展 | selectionRange → `@codemirror/language` syntaxTree 回退 |
| Git gutter | 自定义 `gutter()` + StateField（diff 结果） |
| Inline blame | 行尾 widget Decoration |
| 面包屑符号 | documentSymbol + 光标 StateField |
| 分屏共享 buffer | 两个 EditorView 共享文档：主 view 持权威状态，副 view dispatch 转发同步（CM6 官方 split 模式） |
| 语义高亮（P2） | Decoration set 增量更新，LSP token 优先、Lezer 兜底 |

### 6.4 Rust 后端新增命令清单

| 模块 | 命令 | 说明 |
|------|------|------|
| lsp.rs 扩展 | `lsp_completion` / `lsp_completion_resolve` | 补全 + 惰性文档 |
| | `lsp_signature_help` | 签名帮助 |
| | `lsp_type_definition` / `lsp_implementation` | 类型声明 / 实现跳转 |
| | `lsp_document_highlight` | 用法高亮 |
| | `lsp_prepare_rename` / `lsp_rename` | 返回 WorkspaceEdit（按文件分组序列化） |
| | `lsp_formatting` / `lsp_range_formatting` | TextEdit[] |
| | `lsp_code_actions` / `lsp_execute_command` | applyEdit 回推 → Tauri event `lsp:apply-edit` + oneshot 应答（复用 cc_bridge HITL 模式） |
| | `lsp_document_symbols` / `lsp_workspace_symbols` | Outline / Go to Class·Symbol |
| | `lsp_call_hierarchy_prepare` / `_incoming` / `_outgoing` | 调用层级 |
| | `lsp_type_hierarchy_prepare` / `_supertypes` / `_subtypes` | 类型层级 |
| | `lsp_inlay_hints` | 视口 range 请求 |
| | `lsp_selection_range` / `lsp_folding_range` | 智能选区 / 折叠（P1/P2） |
| | `LspDocumentStatus.capabilities` 扩展 | server capabilities 摘要下发（§5.2.0） |
| 新 workspace_search.rs | `workspace_search_start` / `_cancel` | ignore + grep-searcher，事件流式返回 |
| | `workspace_replace_in_files` | 带 hash 预检的批量替换 |
| workspace.rs 扩展 | `workspace_copy_path` / `workspace_move_path` | 树复制/移动 |
| | `workspace_detect_tasks` | 任务探测 |
| 新 local_history.rs | `history_snapshot` / `history_list` / `history_read` / `history_prune` | 本地历史（P2） |
| git.rs 扩展 | `git_blame_lines` | porcelain blame 按行段 |

依赖新增：`ignore`、`grep-searcher`、`grep-regex`（ripgrep 官方 crates，纯 Rust）。

### 6.5 持久化

扩展现有工作区状态（`RecentWorkspace` / workspace state）：

- 打开的编辑器 tab 列表（含 pin 状态、激活项、分屏结构）
- 树展开状态、树视图模式（已有）
- 底部/右侧工具窗：开关状态、尺寸、激活 tab
- Find in Files 搜索历史（最近 20 条）、自定义任务列表、inlay hints 开关
- 导航历史不持久化（会话级）

存储沿用现有模式：UI 偏好走 localStorage，工作区结构走 SQLite。

---

## 7. 快捷键方案（IDEA keymap 为基准）

| 动作 | 快捷键 | 冲突处理 |
|------|--------|----------|
| Search Everywhere | 双击 Shift | 仅工作区 tab 激活时生效 |
| Go to Class | Ctrl+N | 工作区聚焦时截获（app 层"新建连接"类快捷键让位） |
| Go to File | Ctrl+Shift+N | — |
| Go to Symbol | Ctrl+Alt+Shift+N | — |
| Recent Files | Ctrl+E | — |
| 文件结构弹窗 | Ctrl+F12 | — |
| Find in Files | Ctrl+Shift+F | — |
| Replace in Files | Ctrl+Shift+R | — |
| 编辑器内查找/替换 | Ctrl+F / Ctrl+R | Ctrl+R 仅 editorFocus 时截获 |
| 跳转声明 | Ctrl+B / Ctrl+Click | 统一入口 |
| 跳转类型声明 | Ctrl+Shift+B | — |
| 跳转实现 | Ctrl+Alt+B / Ctrl+Alt+Click | — |
| 查找引用 | Alt+F7 | — |
| 调用层级 | Ctrl+Alt+H | — |
| 类型层级 | Ctrl+H | editorFocus 时截获 |
| 快速文档 | Ctrl+Q / 悬停 | Linux 下若与系统冲突提供 F1 别名 |
| 参数信息 | Ctrl+Shift+Space（实现决策：Ctrl+P 已作为 Go to File 的 VS Code 别名） | 触发字符（`(`、`,`）自动弹出 |
| 重命名 | Shift+F6 | 树聚焦=重命名文件；编辑器聚焦=重命名符号 |
| 格式化 | Ctrl+Alt+L | — |
| Quick Fix | Alt+Enter | — |
| 补全 | Ctrl+Space | Windows 输入法冲突 → 备用 Alt+/ |
| 行注释 | Ctrl+/ | — |
| 复制行 | Ctrl+D | editorFocus 时截获 |
| 移动行 | Alt+Shift+↑/↓ | — |
| 扩大/缩小选区 | Ctrl+W / Ctrl+Shift+W | **与"关闭标签"惯例冲突**：editorFocus 归编辑器；关闭 tab 用 Ctrl+F4 |
| 导航后退/前进 | Ctrl+Alt+←/→ | — |
| 保存 | Ctrl+S | 已有 |
| 终端面板开关 | Alt+F12 | — |
| Problems 面板 | Alt+6（IDEA 习惯） | — |
| 在树中定位文件 | Alt+F1 | — |

设计约束：所有快捷键经 §6.2 的 when-context 路由；后续可加"keymap 方案"设置（IDEA/VS Code 两套预设），首期实现 IDEA 单套 + 少量 VS Code 别名（Ctrl+P → Go to File 的提示引导）。

---

## 8. 实施计划（里程碑）

| 里程碑 | 内容 | 规模 | 状态 |
|--------|------|------|------|
| **M0 前置重构** | 组件拆分 + codeWorkspaceStore + 命令系统骨架 + 底部 dock 容器（References 迁入） | M | 🔶 7/7 骨架可用；壳体仍 >400 行，buffer/tree/LSP 待继续迁入 store |
| **M1 编辑器智能·上（P0）** | 查找替换、LSP 补全（含 auto-import）/签名/快速文档/格式化、诊断呈现升级、Problems 面板 | L | ✅ 9/9 |
| **M2 导航与搜索（P0）** | Find in Files（后端搜索模块 + 面板）、Search Everywhere（含 Classes/Symbols）、Go to File/Class/Symbol、Recent Files、导航历史、Outline + 结构弹窗、类型/实现跳转 + peek、重命名、Code Actions、树右键/键盘 | L | ✅ 14/14（拖拽仍为 P1） |
| **M3 布局与终端（P1）** | 分屏、tab 管理/预览 tab、面包屑、集成终端、Run/Tasks | L | ⬜ 0/5，未开始 |
| **M4 语言智能·下 + Git（P1）** | 调用层级、类型层级、用法高亮、inlay hints、智能选区(LSP)、Git gutter、inline blame、状态栏分段、持久化增强 | L | ⬜ 0/10，未开始 |
| **M5 差异化（P2）** | 本地历史、AI 集成入口、语义高亮、TODO/书签（可选）、远程工作区 spike | M–L | ⬜ 0/5，未开始 |

依赖关系：M0 是一切前提；M1/M2 内部可并行（后端 LSP 扩展与搜索模块独立）；M3 依赖 M0 的 dock 容器；M4 的层级面板依赖 M0 dock + M2 的 LSP 请求管道。每个里程碑独立可发布、可验收。

### 8.1 进度明细（勾选清单）

> 更新于 2026-07-11（v2.4），分支 `feat/code-workspace-ide`。P0（M1/M2）已按代码与提交复核收口；M0 仅剩壳拆分/store 技术债。完成度按本节拆分条目计数，已完成项附提交号。

**M0 前置重构 — 🔶 清单项齐，壳体继续瘦身中**

- [x] CodeMirror host 抽取（`CodeMirrorHost.tsx`）— `042d03f`
- [x] 底部 dock 容器 + References 面板迁入 — `09108e2`（`4766f43` 起改为面板常驻挂载）
- [x] `FileTreePane` 展示边界抽取（工具栏、视图/缩放控制、语言服务器面板）+ 组件测试 — `acff8cf`
- [x] `codeWorkspaceStore`（按 `workspaceInstanceId` 分片 UI chrome / openOrder / activeKey / markdownModes）+ `EditorGroup` + `WorkspacePopupsHost` + `codeWorkspaceModel` 纯函数抽取 — `3ddab1b`；**壳体 4674→4113 行**，openFiles/树数据/LSP 会话仍在壳内，M3 分屏前继续迁
- [x] `workspaceCommands.ts` 注册表、when 判定与统一快捷键分发；Search Everywhere 增加 Files / Actions 双入口 + 测试 — `b3c3d35`
- [x] 活跃工作区命令注册桥 + Windows/Linux 应用菜单动态子菜单 + macOS 原生菜单动态子菜单 — `26b2763`
- [x] 命令系统收尾：树右键/工具栏复用 command id，terminalFocus 上下文接入 — `2312ef8`

**M1 编辑器智能·上（P0）— ✅ 9/9**

- [x] 编辑器内查找/替换（`@codemirror/search` 自绘面板）— `d346c37`
- [x] IDEA 编辑命令键位（注释/复制行/删除行/移动行/扩选/跳转行）— `19e23f4`
- [x] Problems 面板基础能力（打开文件范围 + severity 过滤 + 徽标 + 点击跳转/复制消息）— `e0135a3`；Quick Fix 入口随 Code Actions 补齐
- [x] capability 摘要下发（§5.2.0，initialize 握手升级 + `LspDocumentStatus.capabilities`）— `fa8ce88`
- [x] LSP 补全（kind 图标、snippet 转换、auto-import via resolve、触发字符、词级回退）— `fa8ce88`
- [x] 签名帮助（触发字符自动弹出 / Ctrl+Shift+Space，活动参数加粗）— `fa8ce88`
- [x] 快速文档升级（Ctrl+Q / F1 显式弹出 + pin 到右栏 Documentation）— `c4e1435`
- [x] 格式化（`lsp_formatting` / `lsp_range_formatting`，Ctrl+Alt+L）— `e210694`（保存时格式化开关仍可后续加）
- [x] 诊断呈现收尾（gutter 图标、overview ruler 色条、灯泡入口）— `b049952`

**M2 导航与搜索（P0）— ✅ 14/14（拖拽仍为 P1）**

- [x] Find in Files 后端（ignore + grep-searcher 流式搜索、取消、截断）— `65ac601`
- [x] Find in Files 面板（Ctrl+Shift+F、大小写/整词/正则、include/exclude glob）— `4766f43`
- [x] Go to File（双 Shift / Ctrl+Shift+N / Ctrl+P，camelCase 模糊匹配）— `972ad00`；SE 六分组（All/Classes/Files/Symbols/Actions/Text）— `4040d6f`
- [x] 文件树右键菜单基础项（新建/重命名/删除/复制路径/Find in Directory）— `6be92f5`
- [x] Recent Files（Ctrl+E，最近优先、连按推进、上一文件预选）— `f5ae894`
- [x] 导航历史（Ctrl+Alt+←/→ + 头部按钮，100 条上限）— `f5ae894`
- [x] 文件结构弹窗（Ctrl+F12，documentSymbol 层级/扁平双格式）— `5939c76`
- [x] 文件树右键菜单补齐（剪切/复制/粘贴、资源管理器打开；「终端中打开」与 Git ignore 仍可增强）— `1d8fa2f`
- [x] Go to Class / Go to Symbol（`lsp_workspace_symbols` + SE Classes/Symbols）— `4040d6f`
- [x] 类型声明/实现跳转 + 多结果 peek — `e373d0d`
- [x] 重命名（prepareRename + rename + §5.2.9 WorkspaceEdit 应用规则）— `e7873ef`；open-clean 保存路径 — `5d87203`
- [x] Code Actions / Alt+Enter（客户端 WorkspaceEdit 应用；server 回推 applyEdit oneshot 仍可增强）— `b049952` + `5d87203`
- [x] 树键盘导航（↑↓←→/Enter/F2/Delete）；拖拽仍为 P1 — `1d8fa2f`
- [x] 替换（Replace in Files via shared WorkspaceEdit applier）— `e7873ef` + `5d87203`

**M3 布局与终端（P1）— ⬜ 0/5，未开始**

- [ ] 编辑区二分屏（共享 buffer）
- [ ] 编辑器 tab 行为（预览 tab、固定、关闭其他、中键关闭、溢出下拉）
- [ ] 面包屑（路径 + 光标符号链）
- [ ] 集成终端底部面板（复用 TerminalPanel，cwd 联动，多实例）
- [ ] Run/Tasks（`workspace_detect_tasks` + Run 面板 + 终端运行）

**M4 语言智能·下 + Git（P1）— ⬜ 0/10，未开始**

- [ ] 调用层级（Ctrl+Alt+H，Callers⇄Callees，懒展开/环检测）
- [ ] 类型层级（Ctrl+H，Supertypes⇄Subtypes）
- [ ] 用法高亮（documentHighlight，读/写区分）
- [ ] Inlay hints（视口 range 请求，默认关）
- [ ] 智能选区换 LSP selectionRange（syntaxTree 回退已有）
- [ ] 右侧 Outline 常驻工具窗（结构弹窗已有，常驻形态归此）
- [ ] Git gutter 变更标记 + 内联 diff 浮层
- [ ] Inline blame（`git_blame_lines`）
- [ ] 状态栏分段（光标/语言/LSP 状态/分支）
- [ ] 工作区状态持久化增强（打开 tab/分屏/dock 状态/搜索历史）

**M5 差异化（P2）— ⬜ 0/5，未开始**

- [ ] 本地历史（快照存储 + 时间线 diff + 恢复）
- [ ] AI 集成入口（选区工具条 + diff 应用 + 右栏会话）
- [ ] 语义高亮（semanticTokens 增量）
- [ ] TODO / 书签面板（可选）
- [ ] 远程工作区 `WorkspaceFs` trait spike

**横切事项**

- [x] 交互原型交付（`claudedocs/prototype/code-workspace-prototype.html`）
- [x] 签名帮助键位决策：Ctrl+Shift+Space（Ctrl+P 已作 Go to File 别名）— `f4d9c15`
- [x] 代码与自动化复核（2026-07-11 v2.5）：Code Workspace 定向 Vitest **23 文件 / 105 项**通过；`codeWorkspaceStore` 单测通过；LSP/`workspace_search` 定向 Rust 先前已绿
- [x] WorkspaceEdit §5.2.9 三态规则收口（open-clean 应用后保存、open-dirty 保持 dirty、未打开写盘 + hash 预检）— `workspaceEditApply` + `5d87203`
- [x] 合并门禁 8 例 Windows 失败已修复（clipboard URI ×4、pushd ×1、git 根 ×3）— `f6c1f36`
- [ ] **⚠ 真机验证欠账（人工）**：P0 能力仍以单测/构建为主；`pnpm tauri dev` 冒烟留待人工，结果回填本节
- [ ] ⚠ M0 继续瘦身：将 `openFiles` / 树目录状态 / LSP 会话迁入 store；树控制器从壳内 `renderEntries` 抽出；目标壳 <400 行后再开 M3 分屏
- [ ] ⚠ 下列 P0 增强项可选收口（不阻塞 M3）：保存时格式化开关；server 回推 `workspace/applyEdit` oneshot；树「终端中打开」/ Git ignore；树拖拽（P1）

### 8.2 下一步待办（建议顺序）

> P0 已交付；M0 已引入 instance store + EditorGroup/Popups 边界（壳 4674→4113）。**真机冒烟仍为人工待办。** 下一编码优先级：继续 M0 瘦身 → 合入主干 → M3。

1. **（人工）真机冒烟并记缺陷**  
   `pnpm tauri dev` 覆盖 P0 快捷键与面板；不作为自动化门禁。

2. **继续 M0：buffer/tree/LSP 入 store + 树控制器抽取**  
   把 `openFiles` 与目录展开状态迁入 `codeWorkspaceStore`；`renderEntries`/`renderFlatEntries` 抽到 ProjectTree 控制器；目标壳 <400 行。**未完成前不要开 M3 分屏。**

3. **合入主干**  
   8 例门禁 Rust 已绿；确认全量 `cargo test` / CI 后 merge。

4. **（可选）P0 体验补丁**  
   保存时格式化；applyEdit oneshot；树终端/Git ignore。

5. **M3 布局与终端**  
   预览/固定 tab → 面包屑 → 二分屏 → 底部终端 → Run/Tasks。

6. **M4 / M5**  
   层级/inlay/Git gutter/状态栏/持久化；本地历史 / AI / 语义高亮 / 远程。

---

## 9. 风险与权衡

| 风险 | 说明 | 缓解 |
|------|------|------|
| M0 重构回归 | 3.6k 行组件拆迁易碎 | 行为不变原则 + 现有测试全绿 + 回归清单；按面板分多个 PR |
| LSP 服务器差异 | completion/rename/hierarchy 各 server capability 差异大 | §5.2.0 capability 驱动开关；不支持则置灰 + hint；§5.2.12 矩阵仅作方向参考 |
| WorkspaceEdit 非原子 | 跨文件重命名部分失败 | 如实呈现结果清单（§5.2.9），不承诺原子性 |
| 补全性能/竞态 | 高频输入下请求风暴、过期回填 | 防抖 + 请求代际取消；resolve 惰性化；isIncomplete 续查 |
| 快捷键冲突 | IDEA 键位与应用/系统习惯冲突（Ctrl+W/N/P 等） | when-context 路由；冲突项文档化并留别名 |
| 搜索性能 | 超大仓库 Find in Files | 流式分批 + 上限截断 + 可取消；ignore crate 跳过 .gitignore |
| 分屏共享 buffer 复杂度 | 双 view 同步易出编辑竞态 | 限定二分屏；CM6 官方 split 模式；dirty/保存收敛到单 buffer 模型 |
| Inlay hints 抖动 | 编辑时 hint 频繁重排 | 视口 range + 滚动/编辑防抖；默认关，用户主动开启 |
| 底部终端生命周期 | 工作区关闭时 PTY 泄漏 | 随 tab 卸载显式销毁；复用现有 TerminalPanel 清理路径 |
| 范围蔓延 | "像 IDEA"没有边界 | §2.3 非目标清单为评审基线；新增诉求走 P2+ 排队 |

---

## 10. 待决问题（评审时确认）

1. 底部 dock 是否需要 Git tab（vs 只留状态栏入口 + 现有 Git Manager）？
2. 右侧 Outline / Documentation / AI 是否首期合并为单栏多 tab（原型按合并形态演示）？
3. 本地历史保留策略默认值（50 版/7 天）是否合适？
4. 是否首期就提供 VS Code keymap 预设？
5. 远程工作区 spike 是否提前到 M3 之前验证 `WorkspaceFs` trait 设计？
6. Inlay hints 默认开关（方案默认关，rust-analyzer 用户可能期待默认开）？
