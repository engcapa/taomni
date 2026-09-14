# 项目树打开与编辑焦点修复设计

<a id="ed-treeopen-001"></a>

## ED-TREEOPEN-001 / WP-TREE-OPEN-FOCUS-01

2026-09-14 P1，REQ-02 / CW-PROJ-002；[任务板](../claudedocs/code-workspace-idea-parity-backlog-tree-open-focus.md) 为状态唯一来源。本设计只 author，不是实现记录。目标：F0 README 唯一 tab → 树导航到 example → Enter → 正确 editor 可直接输入 → undo → 回树 → 右键/Esc → 选择、焦点、正文恢复。保留 CW-TAB-001、CW-TAB-002、CW-SHELL-002，REQ-04/REQ-11 是数据保护前提；CW-PROJ-003 仅菜单打开/取消消费者。

### 1. 依据与查重

- 接手 HEAD `7bbb7094148e65c389903076cd3b4dec0d04a004`，分支 `docs/code-workspace-idea-audit-20260913`；接手干净，与用户交接 HEAD 无生产差异。[完整身份](../docs-feature/code-workspace-idea-parity/evidence/tree-open-focus-plan-20260914.json)。
- P0 B03–B05 是历史 Taomni 观察：Enter 打开正确文件但留树焦点；历史 IDEA 32-enter-example 为 editor caret/树失焦。本轮没有启动 Taomni，源码缺少 tree→ready view 焦点交接是当前静态事实，不能冒充当前 native 复现。
- 本轮 [REF-TREE-OPEN-FOCUS-LINUX-20260914](../docs-feature/code-workspace-idea-parity/references/project-tree-open-focus-linux-2026.2.2.md) 是实际 IU-262.10315.125 新参照，补足设置、鼠标、Enter 真输入/undo、菜单 Esc、已开文件和 active split。历史 Windows 原件本机缺失，保留历史结论日期。
- 查找任务 metadata 与后续修订：旧 [ED-TREE-001](../claudedocs/code-workspace-idea-parity-backlog-2026-09-tree-e2e.md) done，不重开；[ED-FINDFOCUS-001](../claudedocs/code-workspace-idea-parity-backlog-find-focus.md) implemented，已实现并有 Windows native/IME/clipboard 记录，真实 provider 等缺口不转交本卡；不能依旧文“尚未实施”判断生产状态。
- [tabs-and-multiview](../claudedocs/code-workspace-idea-specs/tabs-and-multiview.md) 的 ED-TABS-001/002/003、ED-MULTIVIEW-002/003 done；后续 [ED-REPAIR-009](../claudedocs/code-workspace-idea-specs/idea-2026-main-repair.md#ed-repair-009) 补 view snapshot，不能只读初版。
- 新 ID `ED-TREEOPEN-001` 和新 case 规划 ID `TC-IDE-TREEOPEN-01` 已查重。依赖 `[]`；不以 REQ-04/11 或 Find done 作为虚假领取条件。既有正确性只选受影响保留基线，未知不是数据 bug。

### 2. 决策与范围

| DEC | 冻结的选择、依据与取舍 |
|---|---|
| DEC-TOF-01 | **用户已选择“首包修订单击合同”**：文件/目录标签单击只选择；文件双击/Enter 正式打开，目录箭头切换展开。对应实测 preview off / 两项 single-click open off。另一个候选“保留旧鼠标合同只修 Enter”无法满足选定 profile，用户未采用。不新建全局 preview 设置，不改其默认值，不将 preview-on 下所有策略纳入目标。 |
| DEC-TOF-02 | 树显式 open 统一 opt-in 焦点请求；加载与焦点授予独立生命周期。不能无条件在 onClick/Enter 或通用 openFile 末尾 focus；不能查询第一个 `.cm-content`。复用 production command-port 注册身份，新增窄 focus-ready 能力或同一 registry 的配套接口，由 P2 收敛实现。 |
| DEC-TOF-03 | 打开目标固定到动作时的 workspace instance + active leaf/view + file；只有该请求仍拥有交互意图、目标完成加载和 view 恢复后才授予焦点。后来导航/菜单/切组/隐藏/销毁取消旧焦点意图。文档加载是否仍可提交单独判断，不能因取消 focus 就留下永久 loading。 |
| DEC-TOF-04 | 菜单恢复限 tree consumer，区分 Esc/cancel、执行 Open、外部点击和销毁。复用菜单键盘/定位基础，不重构全部新建/重命名/删除。必要公共 close reason 是向后兼容可选接口，其他消费者不继承“回树”。 |
| DEC-TOF-05 | 只调整树 row 动作区域、选中/失焦角色和本链焦点主流程；图稿是结构/状态示意。几何以匹配 Linux 参照的局部测量为依据；不同环境先匹配再比较，不全局主题改版、不凭历史 Windows 尺寸硬编码。 |

**有意改变（旧合同的显式修订）**：旧树设计的“目录单击展开、文件单击正式打开”由 DEC-TOF-01 替代；原树 Enter 不负责 editor focus 的验收上限由 A2 替代。正式打开仍是正式 tab；旧卡结论和原日期不改。自动化中以单击为“打开”的步骤必须改为双击/Enter，并保留原先证明的数据结果，不能删掉断言。

**必须保留的可观察结果**：方向键只选择/展开、不新开 tab/改正文；正式/dirty/pinned tab 不被 preview 复用覆盖；Ctrl/Cmd+Enter 分屏；同文档多 view 独立 caret/selection/scroll、共享 undo；dirty close Cancel 零副作用；加载失败可恢复、菜单取消不改正文；已展开后代刷新，文件事务/persistence 兼容；Find 打开/匹配导航/Esc 与迟到焦点隔离。具体 AC/V 在 §6–7，不能以“保持原功能”代替。

排除全量文件事务、Git、运行调试、语义引擎、插件生态、全局主题与全量历史 QA。不引入第二份 editor 文本/undo/store 或持久化 focus token；默认不改 Rust IPC/磁盘格式。

### 3. 生产链与文件责任

| 生产 owner / 当前事实 | 本卡责任与边界 |
|---|---|
| `src/components/editor/workspace/ProjectTree.tsx`，平铺/层级/loose 文件 row 的 onClick 既 select 又 open；onDoubleClick 再 open；目录标签/箭头共按钮；compact 使用 chain.path | 三类 file row 同一动作语义；拆分 label selection 与 disclosure action，双击只提交一次 open 意图；compact/root 保留规范 selection identity。loose row 当前无 onContextMenu，只为本包提供合法 Open/cancel，不凭空启用完整事务。 |
| `FileTreePane.tsx`、`projectTreeNavigation.ts` | 保留 tree body roving/navigation、IME/toolbar/input guard；支持所需 keyboard context entry；只改受影响路由/焦点视觉。 |
| `src/components/editor/CodeWorkspaceTab.tsx`：handleTreeKeyDown→openFile；Ctrl/MetaEnter→splitLayoutLeaf→新 active group→openFile；workspace.tree.open 也直接 openFile | 显式 `requestTreeOpen`（拟议名）是唯一意图 owner。菜单 Open、双击、Enter、分屏入口都经过它；普通打开与已打开早返一致完成焦点。 |
| 同文件 `openFile` 先 flush，再更新 group/openOrder/preview/active，等待 pending close cleanup，再检查 loaded 或 IPC；`isCurrent` 默认 true；root/loose 失败填 error model，canonical key 可能 remap | 为 focus caller 暴露有类型的结果/完成观察，不改变其他 caller 的默认激活/preview 合同。核对每个 await、错误模型、canonical remap、pending close、并发 load。旧 instance 的结果不得写进重绑后的 refs/销毁 store。 |
| `src/lib/editor/workspace.ts` 的 workspaceReadFile / loose read → Tauri invoke → `src-tauri/src/workspace.rs` 的 workspace_read_file / workspace_read_loose_file；lib.rs 注册 | 已有真实文件读取、canonical path、bytes/EOL/BOM/hash/revision 是数据边界；只读追踪，无新增 provider 或文件写入。读失败不是成功；未知写效果不属于只读 open 结果。 |
| `codeWorkspaceStore.ts`、workspaceLayoutPersistence、workspaceTabPolicy、workspaceDocumentTransactionOwner | instance 是唯一 UI/data owner；leaf/view 是实际递归 layout ID；保留 tab policy、pending text flush、transaction lease、共享 history。默认只读，必要改动需落在本卡 AC；禁止持久化一次性 focus generation。 |
| `EditorGroup.tsx` loading 时无 Host，Markdown preview 分支没有 editable Host；常规 Host key=fileKey，viewId=groupId | 将 actual view readiness/preview focus target 接到 shell；不能 loading spinner mount 当 editor ready。只读/preview view 获焦但不强制变编辑模式；普通文本进入可编辑 Host。 |
| `CodeMirrorHost.tsx`：EditorView mount、文档 lease、textIdentity snapshot、延迟 scroll restore；注册 command port {fileKey, token, port}；reveal 还会改 selection/scroll | 新 focus-ready 能力只做 preventScroll 的实际 view.focus 与结果核对，不用 reveal 清 caret。恢复 selection/scroll 完成后才确认 readiness；注册/注销沿用 mount token；旧 unmount 不删除新 port。 |
| `editorSearchPanel.ts`、`lspHyperlink.ts`、Host clipboard owner | Find 当前已有 generation + activeElement/liveness 隔离；modifier 清理延迟 dispatch、防重入；clipboard focusout generation。必须让新 tree focus 自然触发旧 owner 失效，禁止吞 blur/focusout、复用迟到 callback 或回退旧实现。 |
| `ContextMenu.tsx` useContextMenu/MenuSurface | 现有首项焦点、方向键/Enter/Esc、portal、6px viewport clamp/overflow；tree hook 还被 candidate 等菜单复用。只增加必要可选 close reason/consumer context，不把所有菜单 close 都回树。 |
| `useWorkspaceFileActions.ts`、`useWorkspaceTreeData.ts` | toggleRoot 附带 select；refreshTree 合并并刷新全部 expanded descendants，tree cache 有 generation/root guard；保留，避免新 row 拆分绕过这些 owner。 |

测试 owner：上述已存在的同名 tests；`src/components/editor/CodeWorkspaceTab.test.tsx`、`CodeMirrorHost.findFocus.test.tsx`、`editorSearchPanel.test.ts`、`lspHyperlink.test.ts`、tab policy/transaction/snapshot 相关现有定向测试。P2 可新增窄 focus coordinator 及同目录测试，必须从上述 production caller 接入，不能仅导出 helper。

QA owner：现有 `qa-ui-auto-tests/cases/TC-IDE-TREE-01-project-tree-keyboard-native.testcase.yaml` 的受影响 mouse 步骤；**拟新增** `qa-ui-auto-tests/cases/TC-IDE-TREEOPEN-01.testcase.yaml`（ID `TC-IDE-TREEOPEN-01`），必要 controls/covers/feature-list/catalog。新 case 当前不存在、所有执行计划未执行。优先现有 runner 支持，不预设不存在的新 verb。

### 4. 入口动作、视觉与可达性

| 入口 | 选择 / 展开 | tab / focus 结果 |
|---|---|---|
| 文件单击（层级/平铺/loose） | 更新单选；保留 tree focus | 不 open、不改 active tab/preview/body；已开同文件也只回树 |
| 文件双击 | 先选；一次显式 open | `preview:false` 正式打开/提升已有 preview；ready 后去准确 active leaf editor |
| 文件 Enter | 当前 selected file | 与双击同结果；防 composing / input / 菜单 owner 重复处理 |
| Ctrl/Cmd+Enter 文件 | 保留 selection；使用现有 splitLayoutLeaf 结果 | 打开到**返回的新 leaf ID**并仅它获焦；不替换为 IDEA XWin Shift+Enter |
| 目录/root 标签单击 | 仅选择；不展开 | tree focus；tab/body 无变化 |
| 目录/root 箭头 | 选中该节点并切展开；事件不冒泡成 label double toggle | tree focus；不加载文件；节点仍是单个可读 treeitem，不加多余 Tab 停靠 |
| 目录/root 双击、Enter | 切展开一次 | tree focus；无 editor focus 请求。目录 double/Enter 有实测，root 是一致性适配，不宣称已实测全部根特例 |
| Up/Down/Left/Right/Home/End | 沿 navigateProjectTree 既有合同，compact 用规范路径 | 不 open；展开不改正文；新导航使旧未完成 focus 意图失效 |
| 右键 / Shift+F10 或 ContextMenu key | 右键先选目标；键盘使用当前 selected row | menu 获焦，锚点为 pointer/selected row 的可见边缘；不 open 文件 |
| 菜单 Open | 使用菜单打开时冻结的 ref/workspace；存在性再校验 | 关闭 menu 后走同一显式 open；不得 close callback 抢回树 |
| 菜单 Esc | 仅取消当前菜单；子菜单先返回父菜单 | tree session 仍有效时回该 tree body/selected item，蓝色焦点选择；不改正文/tab |
| 菜单外部点击 / workspace 隐藏 / target 销毁 | 关闭并撤销该 session | 保留用户新落点，不强制回树。找不到旧行时只在原树仍活跃且属 Esc 时回 tree container；不切 workspace 找旧行 |

菜单 action 冻结引用避免选择随后改变导致操作错文件；“Open”失败不能落入 rename/delete，未支持项维持原 disabled/不展示策略。顶部工具栏、搜索输入保留原键盘行为，tree role/name/aria-selected/aria-expanded 与视觉同步。长路径 ellipsis + 可获取全路径，选中行 scrollIntoView 只在需要时滚动，不滚动 editor；箭头 hit area 可点击但不改变文本布局。菜单限制在当前 viewport，长菜单可滚动、键盘 active item 可见，子菜单可返回；6px 现值是 Taomni 基础，不冒充 IDEA 精测。

结构/状态图：[可编辑图](../docs-feature/code-workspace-idea-parity/references/tree-open-focus-states.drawio)，[预览](../docs-feature/code-workspace-idea-parity/references/tree-open-focus-states.svg)。它解释 selection/focus 分离和 pending handoff，不定义全局主题。

视觉目标来自新参照 §4：匹配 profile 时树行 30 原始 px、允许 ±1px 项目容差；获焦选中 #2a4371、失焦选中 #33353b、树底 #191a1c 是原件采样，不直接等于跨主题 CSS。保持层级缩进、箭头/图标/标签次序、无选中跳位。当前暗 editor 不必全局改为 Classic Light；用隔离 QA 配置匹配可配置字体/主题做局部比较，不能用全局主题工程扩大本包。无法匹配部分分别记视觉不可比较；**A4 的核心角色/可达性仍须通过**，不得用不可比较免除本包主流程。

### 5. 焦点移交与异步合同

拟议窄协议（名称可由 P2 调整，语义不可省略）：

```ts
type TreeOpenIntent = {
  workspaceInstanceId: string; workspaceEpoch: number;
  groupId: string; requestedFileKey: string;
  interactionEpoch: number; requestId: number;
};
type TreeOpenResult =
  | { kind: "ready"; canonicalFileKey: string; groupId: string }
  | { kind: "failed"; fileKey: string; reason: string }
  | { kind: "cancelled"; reason: "user" | "target-closed" }
  | { kind: "stale"; reason: "workspace" | "superseded" | "view-destroyed" };
// loading 是真实中间状态，不是 ready；只读 read 不生成写事务 unknown/success。
// view port 的 tryFocus(token) 只在匹配 live view 已完成初始恢复时返回 focused。
```

1. **捕获动作**：确认可见 workspace、合法 tree owner、当前选中 ref；先按已有机制 flush pending editor text。普通打开固定当时 active leaf；分屏拿到真实新 leaf 后固定它。增加 monotonic request/interaction epoch，不用 file key 相等替代新一轮身份（A→B→A 不能复活旧请求）。tree select 可与 active editor file 不同。
2. **发起/复用打开**：复用 openFile 的正式打开、tab policy、pendingClosedFiles cleanup 和 IPC。已加载且无 error 的早返必须也解析 canonical key 并等 matching view port，不能只在新读取分支 focus。相同文件在途读取可合并到当前 instance/file load owner，focus intent 仍是独立请求；每个 load 明确完成或失败，不重复迟到覆盖编辑内容。
3. **数据提交资格**：捕获 workspace lifetime/load generation；await 前后校验属于同 instance、目标模型仍归该 load、未被关闭/替代。只允许向该 live instance 提交；组件卸载/workspace 重绑后不写新 refs、不复活已销毁 store。保留 existing `isCurrent` caller 的语义，不能全局放宽其 navigation/restore 取消。若只撤销 focus，仍然合法且需要的读取正常完成；如模型已废弃，明确清理该 loading owner，不影响其他 view 的已加载 shared document。
4. **ready rendezvous**：结果映射 canonical file key，匹配 `(workspace epoch, groupId/viewId, canonicalFileKey, mount token)` 注册。EditorGroup spinner→Host mount→lease/model ready→snapshot selection/scroll 恢复完成后再发 ready；不是一次 setTimeout 猜渲染时间。已有 view 直接核验；后注册也能唤醒尚有效请求；port 替换/旧 cleanup 不能删除新 token。
5. **授予前二次检查**：workspace visible、leaf 存在且仍 active、leaf activeKey 与目标一致、request/interaction epoch 仍最新、当前焦点仍属发起 tree/menu 的交接范围，应用仍有前台资格。用户去其他 input/editor/Find、选择另一树项、切 leaf/tab/workspace、外部窗口 blur、菜单打开、目标关闭/销毁均撤销旧 grant。区分过渡 DOM blur 与真实新交互，不能自己的 Host mount 就误撤销；由有限 transition owner 处理，不能全局阻止 blur。
6. **交接**：一次 `view.focus()`（必要 preventScroll）；不 dispatch 新 selection、不重置 caret/scroll/undo、不借 reveal 跳 1:1。命中已开同文件保留该 leaf snapshot；初次 example 初始 caret 1:1。检查实际 active view 后 consume 请求。不可编辑 view 用该 view 的语义 focus target（Markdown preview 容器可键盘滚动、readonly editor 只读），不得改 Markdown mode 或制造可编辑假象；本包直接输入 AC 以 F0 txt 为准。
7. **失败/取消**：root/loose read 或 canonical remap 失败返回 failed（existing error model 不是 ready）。保留原有错误展示和已存在 buffer/dirty/tab，不强制回旧 tab/删除错误 tab；焦点在仍有效原树，重新 Enter 可以明确重试，不能把带 error 的早返当成功。只有失败 UI 有合法 focus target 时由显式用户导航去它。用户取消/失效均不 focus；若 dirty close Cancel 被触发，既有 view、snapshot、dirty、history 完全不变。
8. **菜单 close**：从 session 捕获 restore target 和 interaction epoch；Esc/cancel 才恢复仍 live 的 tree；Open 标记 consumed 并进入新 request，close 不回树；outside/blur/superseded/dispose 不恢复。公共 callback 新参数可选，保持现有无参调用；submenu Esc 不提前关闭顶层。具体菜单实现可局部 adapter，但不得用全局 key listener 抢 Find Esc。

这些是 Taomni 生命周期适配设计；IDEA 慢加载/错误/切 workspace 的内部实现未采、未用源码代替实测。风险重点是共享 shell/Host 行为被泛化影响、preview 早返、StrictMode teardown 和 snapshot 延迟恢复。修复必须通过真实 caller 的 race 测试，不只测纯 token helper。

### 6. 稳定 AC 与需求映射

所有下列 AC 的产品检查状态均为 **未执行**；P1 参照有效不等于产品通过。

| AC | 对应总目标 | 可观察断言（包含故意改变或保留） | V |
|---|---|---|---|
| ED-TREEOPEN-001-A1 | REQ-02-F/I | F0 README 唯一 tab；三类文件单击只选、目录标签单击不展开；箭头/目录双击/Enter 切展开一次；方向键不 open/body 变；文件双击/Enter 正式打开一次。 | V-TOF-01/03/04 |
| ED-TREEOPEN-001-A2 | REQ-02-F/I | example Enter 后不点击 editor、不注入 focus，真实输入仅进固定目标 view；undo 恢复正文，save 后 71 bytes/hash 恢复；已开再次 Enter 不重复 tab，不重置该 view caret/selection/scroll。 | V-TOF-01/03/04 |
| ED-TREEOPEN-001-A3 | REQ-02-I/R | 延迟 read/Host mount、A→B→A、切 leaf/tab/workspace、隐藏/销毁/外部新输入、关后重开均无迟到焦点劫持/旧实例提交；load failure 可重试且不覆盖原 dirty；不遗留无 owner loading。 | V-TOF-01/03/04 |
| ED-TREEOPEN-001-A4 | REQ-02-V/I | selected 与 focus 独立：tree 蓝选→editor caret + 树失焦选择→回树恢复；菜单锚定正确 row/指针，溢出可滚动、keyboard 可达；Esc 回原树，Open 去目标 view，outside 点击不抢回。匹配环境局部几何/角色与参照比较，差异分类有据。 | V-TOF-01/03/04 |
| ED-TREEOPEN-001-A5 | REQ-02-R/F；CW-TAB-001/002、REQ-04/11 | 连续正式打开保留前 tab；dirty/pinned 正式 tab 不被 preview 覆盖，其他入口 preview policy 不改；Ctrl/Cmd+Enter 新 split leaf 接输入；同文件多 view 独立 caret/selection/scroll、共享编辑/undo，关闭一个 view 不释放另一个。 | V-TOF-02/03/04 |
| ED-TREEOPEN-001-A6 | REQ-02-R；CW-PROJ-003 局部、REQ-11 | dirty close Cancel 零副作用；返回树/菜单 Esc 不改正文/磁盘/dirty；刷新所有已展开后代仍可见；事务取消和持久化恢复保持原行为，焦点 token 不落盘；不扩大文件事务实现。 | V-TOF-02/03/04 |
| ED-TREEOPEN-001-A7 | REQ-02-R；CW-SHELL-002 | Find 打开可输入、Enter/ShiftEnter 导航、Esc 回同 view selection，重复无重入；新树 open、Find queued focus、clipboard focusout 互不复活旧 owner；IME composing 的 Enter 不触发树打开；Windows/macOS/Linux 代码兼容，当前端 native 验证、其他端明确未验证。 | V-TOF-02/03/04/05 |

### 7. 最小充分验证、基线与集成

Required evidence 精确集合：`code-audit`、`unit`、`typecheck`、`browser`（可用真实生产组件挂载验证）、`native`、`idea-comparison`、`qa-lint`。一个 native batch 可同时支持多 AC 和比较，不要求每种各跑一次。没有真实 provider 依赖；Find 旧卡 provider 缺口不继承成新 gate。键盘/IME/name/role/zoom 观察归入本包 native/挂载断言，不机械继承旧卡全部 screen-reader/provider suites。

| V（**均未执行**） | 最小范围 / 改前依据与实施要求 |
|---|---|
| V-TOF-01 定向 red/green | ProjectTree、FileTreePane 的三种 row 与 label/arrow 分离；CodeWorkspaceTab 真实 handleTreeKeyDown→openFile→EditorGroup→Host 的 Enter 直接输入 red。用 deferred read/ready port 建同文件早返、loading/失败重试、canonical remap、pending-close reopen、A→B→A/销毁/切组/切 workspace 的区分测试。验证输入落点和 buffer，不用 mock focus 调用次数冒充。error model 早返也测。 |
| V-TOF-02 保留基线→改后 | 先选现有 CodeWorkspaceTab tests：连续正式打开（旧约1402）、tree menus（5169）、workspace rebound（5717）、split shared undo/last-close（5919/5977/6058）、pending cleanup reopen（6295）、CtrlEnter（6419）、independent caret（11018）、tail snapshot flush/identity（11891/11915）；行号仅定位，按真实 test name 过滤。加 tab policy dirty/pinned/preview/cancel、expanded descendants refresh/persistence 的既有定向子集；Find 真实 shell panel（约1116）及 findFocus/searchPanel/hyperlink/clipboard owner 受影响用例。旧报告不是本次 PASS；记录改前红/未知，鼠标期望仅依 DEC-01 修订，保留数据断言。 |
| V-TOF-03 挂载/可选 browser 迭代 | 选真实 production shell 挂载，覆盖用户主链、active element/view、菜单 Close reason、readonly/Markdown preview 目标、两 view 快照、dirty Cancel 和 Find 来回。若布局/scroll/portal 需要 browser，用现有 browser config + 独立 VFS，核对可见焦点、键盘菜单、长路径/窄 viewport/200% zoom；本包不强制另跑全 browser suite。browser 不证明原生窗口/磁盘/IME/OS shortcut。 |
| V-TOF-04 稳定后当前 Linux native 集中验证 | 按 qa native-testing，先核对可复用 QA binary 的 source/build/config，再必要集中构建。隔离 F0，README source 唯一 tab→docs label/arrow/方向键→example Enter→**无 editor click/focus 注入，直接 OS 输入 x**→undo→save/hash→回树→右键/Esc→再次 Enter/input/undo；单击 README 不开、双击正式开；CtrlEnter split 后右 leaf 输入/共享 undo/独立 caret；切 workspace/leaf 后迟到不抢焦点；dirty Cancel、菜单 Open/outside/keyboard cancel；Find 打开/导航/Esc 和一次真实 composing Enter guard。保存窗口/PID、before/after caret/active view、原图、source/case/runner/receipt、磁盘 bytes/hash。race 用定向测试控制时序，native 观察真实切换无抢焦点，不靠不可重现睡眠宣称证明全部 race。 |
| V-TOF-05 集成静态与三端计划 | 同一最终变更并集 scoped typecheck（包括新增 helper/tests），QA case/catalog audit，设计/metadata/链接校验，review 删除/放宽断言。Windows WebView2 用 CtrlEnter/CtrlZ、macOS WKWebView 用 CmdEnter/CmdZ，重复 V04 核心 input/undo/菜单/分屏/Find/IME，核对本机 keymap/OS 冲突；本轮 P2 当前端足够，另外两端标未验证，不伪称三端已实测。 |

现有 `TC-IDE-TREE-01-project-tree-keyboard-native` 在 Enter 后**显式点击 `.cm-content`** 才输入，不能证明 A2；其旧鼠标步骤也不能直接作为 DEC-01 目标。P2 新 `TC-IDE-TREEOPEN-01` 应记录无补点落点，复用可用 native 控制；现有 case 只改必要 mouse expectation，保持原断言。新 case 注册 F25.5 及真正受影响 covers/controls，不机械扩 catalog。Windows/macOS verb 不可用时用独立手工原始观察，不伪造 runner receipt。

P1 已运行仅 qa **只读 plan/status**：Linux 选中旧 case，native:Linux unverified、status ok=false（没有 qualifying current report）；exit 0 只表示查询成功。没有 Taomni 启动、runner、产品测试或构建。

P2 本卡 owner 对 scoped typecheck、consumer 回归、最终实现集成和必要 QA build/native 负责。仓库全量 build gate 的既有集成卡为 `claudedocs/code-workspace-idea-parity-backlog.md::ED-GATE-003`；不重领、不虚构新的跨卡 done 依赖、不继承历史通过。本行为卡不机械要求 repo build evidence；native 所需 QA binary 仍由本卡实际构建/复用并记录。

### 8. 完成上限与交接

参照关键动作已补采，DEC-TOF-01 用户已确认，生产 owner/错误恢复/最小 AC/V 已确定，无未决关键参照或依赖；允许 author ready。ready 不是产品 PASS。P2 首步重新核对 HEAD/dirty 与精确任务板，按生命周期领取**本卡**后做 V01 red 与 V02 保留基线。

本卡 A1–A7、required evidence 和当前端保留回归全部满足才可 done；已实现但必要 native/对比证据不足用 implemented；真实本卡回归需修复，不能写成缺证据。全局字体/theme 不匹配、其他平台未测、preview-on 未采的边界单独说明，不声称 CW-PROJ-002 整体三维对齐。

尚待用户决定的目标/preview/兼容合同：**无**。执行时动态条件：核对当前工作区、QA binary 与原件可读性；真实桌面输入必须先约独占时段（预计 10–15 分钟，按计划调整），此次授权与独占已结束，不自动继续占用。若锁屏不得自动解锁；避开本机 Ctrl+Shift+A 的其他 app 全局冲突。
