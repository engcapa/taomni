# ED-PARITY-010 壳层与工具窗口 P1 设计

<a id="ed-parity-010"></a>
## 1. 交付合同

- 状态：**P1 可实施，P2 未执行**。仅处理 [任务板 010](backlog.md#ed-parity-010-code-workspace-壳层与工具窗口布局对齐)，没有领取产品实现 owner，也不改旧板 done 卡。
- 当前审计：2026-09-29，HEAD `6763642b`，开始时 worktree 干净；`git diff 06ef13d0 HEAD -- src` 为空，前次源码定位仍有效。本轮修改仅为设计、参照、fixture 和板上规划状态。
- 来源：[P1 交接](handoff-p1.md)、[总体设计](alignment-design.md)、[共享契约](../../claudedocs/code-workspace-idea-specs/shared-contracts.md)、[控件级参照](references/idea-control-audit-20260929.md#shell)、[本轮补采](references/idea-shell-010-20260929.md)。
- 用户授权：“根据 handoff-p1.md 领取 010 任务做执行，当前 IDEA 已经启动，可以直接采集，控制权交给你”。本轮按该 handoff 完成规划，不越过其“P1 不执行产品实现”边界；已有对齐目标内的具体方案由 agent 决定。
- 结果：Project / Commit / Structure 侧窗、独立 editor、左右工具 rail、底部工具窗、主 toolbar 和 workspace status 有明确层次；切换和隐藏不丢文件、dirty、undo、选择、工具数据或进程。
- 三端：Windows/WebView2、macOS/WKWebView、Linux/WebKitGTK；本轮采样端 Linux。P2 当前端 native 是必需，另两端未验证须记录，不自动外推。

本卡负责**工具窗容器和现有内容的真实接入**。011 负责 editor 内部 tab/通知/细粒度表面，012 负责通用弹层，013 负责完整 Keymap UI，014 负责树和导航内容，015 负责 Problems 数据真实性，018 负责 Git/Run 内容的完整 IDEA 对齐。010 不以假 Commit/Git 面板、不可用占位或打开独立 Git 标签代替本卡要求的侧/底容器接入；也不扩展新的 Git 发布动作、插件窗、浮窗、多侧窗堆叠或任意拖放停靠。

## 2. 当前生产链与影响审计

下列路径均相对工程根；行号只作本次 HEAD 定位，符号为接手入口。

| caller / owner | 事实与缺口 | 改动/保留与消费者 |
|---|---|---|
| `src/layouts/MainLayout.tsx:4505` | 按 app tab key 常驻 CodeWorkspaceTab，非活动用 display:none；Git 回调打开独立 Git tab | 保留 workspace 挂载和 visible 语义；应用 Sessions/Tools/Tao 是外围 chrome，不能当 workspace rail；独立 Git tab 仍可显式打开 |
| `src/components/editor/CodeWorkspaceTab.tsx:20465` | toolbar、Project、递归 editor、右侧 Outline/Documentation、BottomDock 全在大组件中 | 提取 shell 呈现和工具激活职责；文档事务 owner、file provider、Run/Terminal owner 留在稳定 workspace 生命周期 |
| 同文件 `handleActivateToolWindow:12477`、`toggleProjectTree:12404` | 部分入口支持“显示但失焦先聚焦”，Alt+1 的 toggle 直接反转；bottom 用全局 document.querySelector，可能选中隐藏 workspace | 全入口归一，查询限定当前 workspace root；focus token 保存实际 leaf，不允许选中其他 workspace 第一个 `.cm-content` |
| 同文件 `handleReturnToEditor:1820` | 首选 active editor command owner，fallback 是全局 `.cm-editor .cm-content` | 改为捕获来源 leaf + workspace token；保持原 view selection/scroll，不重新 openFile |
| 同文件 `handleRestoreToolWindowLayout:12537`；`src/stores/codeWorkspaceStore.ts:55,1085` | shellChromeState v1 保存 project/right 宽度、bottom/per-tool 高度；Restore Default 使用 452px Project，保留文件树以外的数据 | 保留 reset 为独立动作；新增 Hide All 快照恢复不能复用 reset；保留 editorGroups/layoutTreeV2/viewStates |
| `workspace/panels/BottomDock.tsx` | 所有 tab body 常驻并 hidden，支持 pointer/keyboard resize、IME Esc guard、More；标题栏常量 50px | 保留 mount/hidden 和取消清理，换统一 tool header，横向全工具 tab 排列移至 rail/More；隐藏不等于 dispose |
| `workspace/toolWindowRegistry.ts:136` + CodeWorkspaceTab:16042 | registry 是模块级 workspace Map，只有 14 个 bottom windows 被生产调用同步；Project/Structure 没生产 register caller | 扩展为完整工具描述与真实可见状态；Switcher/Recent/Search 继续读取同源、冻结 MRU 列表，unavailable 不进 cycle |
| `workspace/workspaceLayoutPersistence.ts` | layout v1 → v2，校验 tree/group，保留每 leaf 视图和 tabPolicy；损坏字段回退；写入异常目前静默 | 只增 tool layout 子版本；旧字段逐项读取。失败可见可重试，不能破坏文件恢复或把失败记成功 |
| `src/components/statusbar/StatusBar.tsx:339` → `codeWorkspaceStatusStore.ts` | app status 与 editor 状态混排；单 active tab 状态，Actions 包含 EOL/encoding/indent/LSP cancel/Git | 拆出可复用 editor status 呈现，workspace 内按 owner 显示；应用级其他状态照常。避免隐藏 workspace 写入全局状态，保留真实点击效果 |
| `workspace/WorkspaceSdkStatus.tsx`、`workspace/Breadcrumbs.tsx` | SDK/Facts 在 workspace 头部；breadcrumb 在 editor group 内 | 本卡搬 SDK/Facts 到 status，并提供 navigation slot；复用路径 breadcrumb，类/方法数据可用时显示。011 接续内部 surface，不重复创造符号/provider |
| `src/components/git/WorkspaceGitManager.tsx:132` | snapshots/commitMessage/selection/diff generation 在组件内部，渲染 WorkspaceChangesView + WorkspaceCommitLog；现有 multi-root 迟到隔离 | 提取一份可复用 controller，Commit/Log 两个视图共享同一 owner；独立 Git 管理器仍使用同 controller API；不能复制两个 manager 制造互不同步状态 |
| `workspace/panels/TerminalDockPanel.tsx`、Run/Build/Debug 内容 | 有真实 PTY/运行生命周期，与 dock visible 区别开 | shell 只更改呈现与 focus。UI 隐藏不得 cancel task/kill PTY；workspace 真正 dispose 仍走既有 cleanup/recovery |

现有测试是**可复用断言，未在 P1 执行**：`BottomDock.test.tsx` 的常驻/隐藏、resize/pointercancel/IME；`toolWindowRegistry.test.ts` 的 MRU/隔离/unavailable；`workspaceLayoutPersistence.test.ts` 的旧数据/损坏恢复/视图 identity；`codeWorkspaceStore.test.ts` 的 layout；`WorkspaceGitManager.parity008.test.tsx` 的 repo/file 隔离。仅有这些测试文件不能证明当前壳层通过。

## 3. DEC 与相邻卡接口

| DEC | 结论、原因与代价 | 状态/来源 | AC / TASK / V |
|---|---|---|---|
| DEC-010-01 | 使用固定 left/right/bottom 三个区域，一侧一次一个工具，left/right/bottom 可同时显示。延用 react-resizable-panels，不新引入 docking 库；任意拖放/浮窗/侧窗上下堆叠不在 010。 | agent 自决；现有三个区域和本卡空间层级目标；比完整 IDE docking 更小且保留全部现有可见组合 | A1/A3，T1/T2，V1/V3 |
| DEC-010-02 | rail、View→Tool Windows、Action、快捷键共用 activation owner；可见失焦先 focus、再按隐藏。Esc 只返回，Shift+Esc 隐藏 active，Hide All 保存/恢复之前集合。reset 保留为独立动作。 | IDEA-SHELL-010 实测；细化 DEC-ALIGN-11，工具窗 Esc 不自动 hide；通用弹层仍归 012 | A2/A3，T1/T3，V2/V3 |
| DEC-010-03 | 010 提供真实 Commit/Log 适配视图和共享 Git controller；仅复用现有本地 Changes/Commit/Log/Diff 流程；018 接续内容精细样式及 Run/Git 场景，不能使 010 反向依赖 018。 | agent 自决；总体设计要求至少 Commit/Git，现有 manager 可复用。代价为验证独立 Git tab 共享消费者 | A1/A3，T4，V5/V6 |
| DEC-010-04 | 默认 Structure 在左，Documentation 在右；旧用户持久化 outline 在右则原位读取，显式 Restore Default 后采用新默认。导航/SDK/status 本卡提供容器并搬迁当前可用数据，011 负责移除 editor 内重复条和细部。 | agent 自决；避免布局升级偷偷抹掉用户设置；旧 geometry 不是不可改变 UI | A1/A3，T1/T2/T5，V1/V3/V4 |
| DEC-010-05 | 顶部低频 View/Edit 动作集中到 ⋮/View 菜单，Actions/快捷键不删除。Run/Debug 仍在主栏且能力判定来自原 owner；SDK/Facts 迁至 status。Tao 保持应用级入口，不假扮 IDEA AI Chat。 | 已有总体合同；局部 agent 自决 | A1/A4，T2/T5，V4/V7 |
| DEC-010-06 | 010 负责其新增工具动作和绑定，013 后续复用，不双重注册。F12 原 Go to Definition 改为 Last Tool；Ctrl+B 原定义导航保留。现有用户自定义 scheme 不覆写，旧默认整套迁移由 013；010 提供受影响旧 F12 绑定的可选兼容 scheme。 | DEC-ALIGN-07 + 当前代码；建立先后契约，无循环依赖 | A2/A3，T3，V2/V6 |
| DEC-010-07 | 沿 DEC-ALIGN-06 分 A/B profile；本轮补采只证明状态机。原件按实际尺寸/缩放单独保存，P2 同条件对比再判断几何。设计 token 是拟议值，不能冒称实测。 | agent 自决；本轮客户区与旧参照不一致 | A4，T6，V7 |

DEC-ALIGN-08 的 AI 选区工具条不属于本卡，仍待原归属卡处理。此处不要求额外决定。图稿是下述 v1，按现有 IDEA 目标与控制权授权形成，不记为用户逐像素确认。

### 图稿 v1

[可编辑 drawio（两页）](assets/shell-layout-010.drawio) / [正常布局预览](assets/shell-layout-010.png) / [Hide All 预览](assets/shell-layout-010-max.png)。标注 workspace viewport 1400×900，外围 app tabs/status 不在比例图内；用于职责和空间判断，不作为 profile A/B 像素金图。PNG 为独立预览，编辑请用 drawio 源文件（本机导出器嵌入 XML 模式生成损坏 PNG，已改用普通 PNG 并保留源文件）。正常图的 Problems 内容是 owner 插槽，不预定 015 的分类/空态。

## 4. 状态、呈现与输入合同

### 布局与控件

| 区域 | 本卡目标 | 保留/边界 |
|---|---|---|
| 主 toolbar | 项目/根选择、真实 VCS 分支、Current File/运行配置、Run、Debug、⋮、搜索、设置。非 Git 根分支项显示无仓库原因；无 runnable file 时 Run/Debug disabled 有说明 | Add root、Save/Reload、Back/Forward、Build、Refresh、Split、Wrap、Column selection、Inlay、Blame、Tab policy、Zoom 全保留原 Action；低频项进 ⋮ 的 Edit/View/Tools 分组 |
| 左 rail | 上组 Project/Commit/Structure，More 展开全部可用工具；下组 Terminal/Problems/Git/Run/Debug（不足高度进 More）；每按钮 icon + 可截断短标签，完整 accessible name/tooltip 包含当前绑定 | 所有原 14 个 bottom 工具仍可经 More 和 View 菜单访问；禁止只有已打开工具才可发现 |
| 右 rail | Documentation；预留真实工具注册槽 | 不增加虚假的 Notifications/Database/AI Chat。Tao 仍是 Taomni 应用入口；此差异明确接受，非 IDEA 插件内容匹配 |
| 三工具区域 | left 默认 Project，可切 Commit/Structure；right Documentation（legacy outline 可保持）；bottom 原所有工具 + Git；统一 title / provider-owned 子标签 / ⋮ / Hide | ⋮ 最小含 Hide、Focus Editor、Restore Default；菜单容器可复用现有组件，不复制 021 全部右键菜单设计 |
| Editor | 稳定的递归 leaf 容器，关闭工具只让 editor 可用尺寸增加 | 不修改文件 tab policy、preview、CodeMirror undo、编辑内容。空 editor 显示真实当前绑定的 Search Everywhere、Go to File、Recent Files、Navigation Bar，可点击；若绑定被移除显示无快捷键，不伪造默认；既有 drop 入口保留 |
| workspace status | 左导航路径（有符号时类/方法）+ SDK/Facts；右 `line:column (N chars)`、EOL、encoding、indent、read-only；不活跃 workspace 不显示自己的进度 | 选择长度按当前主选择的 Unicode code point 数（不含次选择，明确 Taomni 适配）；EOL/encoding/indent 行为复用原 callback，不由新 shell 直接写文件 |
| 紧凑/zoom | editor 优先；rail More 和 toolbar 菜单接纳溢出；status 次要字段移进明确的详情按钮，行列/当前错误仍可见 | 不截断半个值，不使按钮越过窗口；小视口临时 clamp 尺寸，放大后恢复用户 preferred size，不能持久化 clamp 值覆盖偏好 |

布局实现初值可参考 toolbar 36 CSS px、rail 36–54 CSS px、header 32–36 CSS px、status 24 CSS px，最终按同 profile 实测修订；这些是设计建议。沿现有色彩 token，选中且聚焦/显示但失焦/hover/disabled/focus ring 必须区分；不用全局 CSS 影响 Git/终端/其他应用 tab。

### 工具状态与动作结果

`visibility`（hidden/visible）和 `availability`（ready/unavailable）分开，内容自己的 loading/empty/failed/cancelled 不能挤进布局枚举。已有工具首次打开可延迟初始化；一旦挂载，hide/change-active 不卸载；background 进度继续由原内容 owner 更新，不能 auto-focus 或主动 reopen 用户隐藏的窗。

| 前置 | 用户动作/事件 | 结果与焦点 | 数据、失败和取消 |
|---|---|---|---|
| hidden + available | rail/View/Action/绑定 | 对应 dock 显示该工具，聚焦其上次可用子控件；首次聚焦标题/主要内容 | 捕获来源 editor token；原同 dock 工具 hidden，状态不清空 |
| visible + unfocused | 工具绑定/Action | 仅聚焦，保留内容与尺寸 | 不重复启动 provider/PTY；rail 鼠标点击已显示工具按 toggle hide（需 V2 真实鼠标覆盖） |
| visible + focused | 再按同工具绑定或 rail | hide，回来源 editor | 不改文本/历史；来源已删除时回当前 workspace 活动 leaf |
| focused 工具 | Esc | 保留显示，回来源 editor | 子 popup/menu 先处理 Esc；终端 readline/搜索子弹层先处理局部 Esc，未消费才冒泡；IME composition 不处理 |
| focused 工具 | Shift+Esc / header Hide | 只隐藏所属工具，回 editor | editor 已聚焦时 Shift+Esc 不随意隐藏旁边工具；应用模态优先 |
| 至少一个工具可见 | Ctrl+Shift+F12 | 保存可见集合/active/尺寸快照，全部隐藏，editor 聚焦 | snapshot 仅 layout，不保存文件文本或 process；所有 rail/status 保留 |
| Hide All snapshot 存在 | 再按 Ctrl+Shift+F12 | 恢复原可见集合、active、preferred sizes，editor 保持焦点 | 已 unavailable/disposed 的工具跳过并解释；期间显式打开任一工具清除 snapshot，下一次 Hide All 按当前组合重新捕获 |
| 任意 | F12 | 最后实际获得焦点且 available 的工具显示并聚焦 | 不用仅“最后变 visible”替代 MRU；无 last tool 时 disabled/no-op 并有说明 |
| 任意 | Restore Default（含旧 Shift+F12） | Project open、right/bottom hidden、默认尺寸，回 editor；清除 Hide All snapshot | 保留文件、leaf、dirty、undo、工具内容/会话，不等价重置 workspace |
| resize 中 | pointerup | 提交 preferred size；每工具 bottom 高度独立 | pointercancel/Esc/失焦/卸载终止拖动并回到 drag-start preferred size；迟到事件凭 drag token 拒绝，不继续写其他 workspace |
| unavailable | rail/View/Action | rail 与菜单显示原因，不进入 focus cycle；从旧 visible 变 unavailable 时可保留原因面板 | 不显示假成功/空结果；Configure/Retry 只调用实际内容 owner；loading/failed 仍可聚焦其面板 |
| 持久化失败 | storage quota/denied | 本次内存布局继续可用，提示“布局未保存”及 Retry | 不回滚已编辑文本；重试只写当前 workspace/current generation，不重放旧 snapshot |
| A 切 B / dispose | 迟到 rAF/focus/provider | 取消 A 的 focus request，B 不变 | 不把 failed/cancelled/stale/unknown-effect 记成功；存储/副作用以实际 receipt 为准 |

### 快捷键与路由矩阵

全部使用现有 `workspaceActionRegistry.ts` → `workspaceActionHost.ts` → 当前 workspace action owner；不用新 document keydown 平行系统。

| 动作 | Linux XWin / Windows Default 目标 | macOS 目标（P2 真机核验） | 责任 |
|---|---|---|---|
| Project/Commit/Structure/Git/Problems/Run/Debug | Alt+1/0/7/9/6/4/5 | Meta+1/0/7/9/6/4/5 | 010 注册/接线；Windows/macOS 目标是待验证映射，不写实测通过 |
| Terminal | Alt+F12 | Alt+F12 | 010 保留 |
| Hide active / Return | Shift+Esc / Esc | Shift+Esc / Esc | 010；子弹层消费优先，012 接续通用弹层 |
| Hide/restore all | Ctrl+Shift+F12 | Meta+Shift+F12 | 010 新增 |
| Jump last tool / Restore default | F12 / Shift+F12 | F12 / Shift+F12 | 010；设备 Fn/媒体键按实机记录，不改 OS 键盘配置 |
| Bookmarks | Alt+2 | Meta+2 | 010 接现有 TodosBookmarksPanel 的 bookmarks 模式；不把 TODO 内容当 Commit |

以上逐键覆盖 rail/menu/Action 与真实 key 入口。Key repeat 不连续 toggle；IME composing、AltGr 和第三方 modal 中不抢键。普通输入框保留打字/选择；明确 tool activation chord 可切工具；Terminal 的 Esc/Ctrl+C 留其本地语义，保留 IDEA 明确的工具 chord。inactive workspace 不消费任何键。010 将 F12 改动限定默认/兼容 scheme，用户覆写优先；与 013 共享同一动作 ID，013 后续补录制/冲突/键帽，不重置 010 layout。

## 5. 数据与生命周期接口（拟新增）

沿 `CodeWorkspaceUiState` 为权威状态，registry 只投影真实状态，禁止双方独立修改可见性。旧 `setBottomDockOpen/Tab`、`setRightPaneOpen/Tab`、`setLanguagePanelOpen` 的调用通过 adapter 进入同一次 store transition，渐进迁移全部 caller；过渡字段派生回填，不使用双向 effects 同步。

```ts
// 工具 ID 保留原 bottom ID；补 project/commit/structure/documentation/git。
type ToolDock = "left" | "right" | "bottom";
interface WorkspaceToolLayoutV1 {
  version: 1;
  docks: Record<ToolDock, { visible: boolean; activeId: string | null }>;
  placement: Record<string, ToolDock>; // 校验已注册且允许的 dock
  lastFocusedToolId: string | null;
  // preferred geometry 复用 ShellChromeState；Hide All snapshot 仅内存
}
interface EditorReturnTarget {
  workspaceInstanceId: string;
  leafId: string;
  fileKey: string | null;
  focusEpoch: number;
}
type ToolActivationResult =
  | { status: "applied"; effect: "opened" | "focused" | "hidden" | "restored" }
  | { status: "unavailable"; reason: string }
  | { status: "cancelled" | "stale"; effect: "not-performed" }
  | { status: "failed"; reason: string };
```

- `workspaceToolWindowController.ts`（新）负责 intent → validated transition → scoped focus，封装来源 token，提供 `activate/hideActive/returnToEditor/toggleAll/restoreDefault/focusLast`。不拥有或复制 document buffer，不新增 Rust IPC。
- `WorkspaceShell.tsx` / `ToolWindowRail.tsx` / `ToolWindowFrame.tsx`（新）接受 descriptor/content slot，DOM key 使用 workspace + toolId；同一工具在迁移 legacy dock 时不通过重新挂载创建新内容 owner。隐藏内容 `hidden`/`inert`（含兼容处理），不能留 tab-stop。
- `toolWindowRegistry.ts` 扩展完整 catalogue、available/reason、dock、focus MRU；现有 list API 的消费者继续读快照。Search 全列表与 Switcher cycle 不丢 Project/Structure，也不凭空列可用工具。
- `workspaceLayoutPersistence.ts` 在现有 layout v2 增 `toolLayout?: WorkspaceToolLayoutV1`，保留 `shellChromeState` 与旧字段兼容镜像。**没有 toolLayout** 时逐项从 old flags 导入：Project 按 languagePanelOpen；right outline/documentation 原位；bottom 原 active+open；尺寸用旧 shellChrome，不应用新默认覆盖旧值。**未知版本/损坏子字段** 仅回退该子树，保留原值备份用于诊断；不丢合法 editorGroups/tree/viewStates/tabPolicy。新写入不删除旧 v1 key，旧版回退仍可读 legacy 镜像；新工具在旧版无对应位置时只能降级到原 Project/Problems，文档数据不受影响。
- Hide All 的原布局不持久化临时“全 hidden”覆盖原偏好；窗口重启恢复正常的 pre-hide snapshot，lastFocusedToolId 可持久化但启动不自动抢焦点；frame mount/unmount 不能写入过期 workspace。
- `WorkspaceStatusBar.tsx`（新）从当前 workspace/leaf 派生状态，复用现有 status Actions；全局 `StatusBar` 在 workspace 活跃时移除重复 editor 段，保留其他 app status。`codeWorkspaceStatusStore` 补 selection/readOnly/导航必要字段并更新 equality；不要靠 DOM 抓取文本猜状态。
- Git 提取 `useWorkspaceGitController.ts`（新）持有原 snapshots/diff 请求序号、commit message、roots、selection。`WorkspaceGitManager` 继续组装完整视图；workspace 内一个 controller 同时供 `WorkspaceCommitToolWindow.tsx` / `WorkspaceGitToolWindow.tsx`（新）消费 existing ChangesView/CommitLog。当前 repo 改变使用原 stale guard；hide 不执行 stage/commit/refresh/cancel。错误、用户取消、未知外部写入效应沿原 owner，不压成 empty success。独立 manager 与 workspace 内 manager 可以各自拥有会话，但共享 gitRefresh 正常同步；不能共用跨 workspace 可变 singleton。

## 6. AC（全部必须满足）

| ID | 前置、动作 | 可观察验收与边界 |
|---|---|---|
| **ED-PARITY-010-A1** | 空/有文件 workspace；从 rail、View/More 和 Action 打开工具 | 左右 rail / toolbar / editor / bottom / status 层级正确；侧+底可同时开；Project/Commit/Structure/Terminal/Problems/Git 和全部既有工具有真实入口/内容；active/unfocused/disabled/loading/empty/failed 状态语义清楚；隐藏无底部全量工具标签残留。仅容器及已有内容适配，非全 IDEA 插件/UI 内容匹配 |
| **ED-PARITY-010-A2** | 不同 leaf、tool input、editor、modal/IME、另一个 workspace | §4 全部 chord 和 Action 只作用于正确 owner；同工具先聚焦再隐藏；Esc/Shift+Esc/Hide All/Last Tool/default reset 区别成立；关闭菜单返回 invoker；工具返回原 leaf，丢失 leaf 回本 workspace active，空 editor 回可聚焦空态，绝不落 BODY/别的 workspace |
| **ED-PARITY-010-A3** | dirty 共享文档、多 leaf、自定义大小、Git selection/commit draft、PTY 会话；旧/损坏布局 | hide/切换/resize/restore 后文字、dirty、undo/redo、每 leaf selection/scroll、工具结果/查询/draft/PTY 保留；save 到真实磁盘再 undo/save 恢复 hash；A→B 迟到不污染；旧布局仍恢复、storage 失败可见并恢复、cancel drag 无越界写。独立 Git/app tab/status 共享消费者不退化 |
| **ED-PARITY-010-A4** | 同 profile A/B 代表状态、窄窗/200%、键盘和辅助技术 | 真实几何/层级/密度/色彩角色记录，toolbar/status 无半截值/遮挡，所有动作有可达 overflow；keyboard/name/role/state/focus/zoom 分别验证；当前 Linux Tauri 实测 OS 输入、WebView 布局、PTY/磁盘及 accessibility，Windows/macOS 明确未验证或各自实测。不得用 validator exit 0 冒充 matched |

## 7. 实现工作包与集成归属

这些是同一张 010 内部顺序工作包，不是新增可独立 claim 的卡，不自动授权并发 agent。

| TASK | 文件职责/输入 | 依赖与完成条件 |
|---|---|---|
| T1 状态与迁移 | `codeWorkspaceStore.ts`、`workspaceLayoutPersistence.ts`、`toolWindowRegistry.ts`、新 controller 及 colocated tests；读 §4/5 | 先执行 V0 保留行为基线；迁移 roundtrip/failure/cancel/stale 通过 V3；旧 setter 有统一 adapter，无双状态 owner |
| T2 shell 呈现 | 新 WorkspaceShell/Rail/Frame、BottomDock、CodeWorkspaceTab 布局/resize、局部样式 token | 依赖 T1；稳定 editor/工具挂载，真实 left/right/bottom，V1/V3；不改 CodeMirror 编辑逻辑 |
| T3 Action/焦点 | `workspaceActionRegistry.ts`、host 必需接线、CodeWorkspaceTab callbacks、keymap 默认/兼容声明、空 editor | 依赖 T1/T2；V2 覆盖每个入口；与 013 的交付 API 为 tool action ID + effective bindings，012 可复用 return token 但 010 独立完成工具窗焦点 |
| T4 Git 适配 | `src/components/git/WorkspaceGitManager.tsx`、新 Git controller/两个 tool adapter、必要 ChangesView/CommitLog props，MainLayout 原回调 | 依赖 T1/T2；V5/V6，保留独立 Git tab、multi-root stale/refresh；018 在本接口上扩展内容，不重新创建 owner |
| T5 toolbar/status | CodeWorkspaceTab toolbar、WorkspaceSdkStatus、Breadcrumbs 接入、新 WorkspaceStatusBar、StatusBar、codeWorkspaceStatusStore/equality、最小 MainLayout 接线 | 依赖 T2/T3；所有移走入口按 V4 映射，LSP/Facts 仅搬呈现；与 011 接 navigation/status slot 与高度 token；其他 app tab status 回归 |
| T6 集成与证据 | 本 spec/board、QA cases/catalog/policy/dependencies、新 controls；同一 010 owner 负责共享文件最终集成 | 依赖 T1–T5；V0–V7 受影响并集、一次 scoped typecheck、一次合格 QA build 后 native；diff 复核后按证据更新 board，不把缺失层写 pass |

本批次 repo-wide frontend build/integration gate 由 **ED-PARITY-019** 收口；010 自己拥有全部编辑路径的 scoped typecheck（含新增 Git/status 路径），当前端 native QA build 是执行前提，不需在每个包再做全库构建。Rust/provider 算法不变，无独立 Rust/JDT LS 测试要求；真实 Git/PTY 边界并入 V6。若实际修改 IPC/Rust，T6 必须补对应 focused 检查，不能借当前计划豁免。

<a id="test-cases"></a>
## 8. 完整测试设计与 AC/V 映射

所有下述实现后检查当前均 **unrun**。P1 不编辑可执行 YAML、不登记产品 controls、不发 runner pass。P2 创建/修改 YAML 时同步 `qa-ui-auto-tests/ci/policy.yaml`、`ci/dependencies.yaml`、`feature-list.md` 的 covers/controls、再生成 testid catalog；保留新的 `verification` action/checkpoint/result 断言。

### Fixture、现有设施与控制缺口

- Browser：现有 `reset_db` + app 自带 browser VFS 小工程，不需要 JDT LS。主编辑文本用 [StructuralTarget.java](fixtures/ed-parity-010/StructuralTarget.java)，另一个文件 `README.md` 内容 `workspace B\n`。VFS 初值由 fixture 安装，不通过 eval_readonly 注入正在验证的动作。A/B 是两个独立 workspace instance；read-only fixture 文件不参与写探针。
- Native：复用 `project_tree` fixture（`src/main/example.txt` hash `bbbab91a4e4ea594b1e2207721999dc375ac98c30c5960cfbbf1329a441aa01a`）；Git 另建 report-root 下两个本地 repo A/B，`git init`、测试身份在各 repo 局部配置，各一次初始提交，无 remote；A 的 `same.txt` 从 `alpha\n` 改 `alpha changed\n`，B 保持 `beta\n`。只本地 stage/commit 可用于既有消费者回归，无 push/network。清理限 report fixture 和测试自己启动的 process。
- IDEA comparison：复用本轮隔离工程与上述 Java fixture；Git 内容对齐用旧 align fixture 的原样副本。重新采 profile A/B 的几何时保存实际 UI/code font、字号、行高、window/DPR/keymap，不先把不一致截图判 pass。
- 现有 verbs 可用 `click/dblclick/press/type/drag_to/seed_storage/reload_window/assert_attribute/assert_text_equals/assert_count/assert_file_sha256/eval_readonly/screenshot`；`eval_readonly` 只观察，不能设置 store/focus 或触发动作。浏览器 storage exception/delayed refresh 的注入由 mounted test 完成，不伪造 raw-JS 动作。
- 现有 controls：`code-workspace-tab/tree/tree-file/editor-pane/project-resize-handle/bottom-dock-resize/bottom-dock-body`、`status-bar-workspace-encoding/eol/indentation`、Run/Terminal/Problems 内容 testids。改变位置后保留既有有意义 testid；旧 bottom-tab selectors 按新 rail 显式迁移，不用隐藏别名冒充入口。
- 拟新增并由 T6 登记到 F25.5（Git 部分沿现有 Git feature 归属）：`workspace-tool-rail-left/right`、`workspace-tool-<id>`、`workspace-tool-frame-<id>`、`workspace-tool-hide-<id>`、`workspace-tool-more-<id>`、`workspace-toolbar-more`、`workspace-view-tool-<id>`、`workspace-status-bar`、`workspace-layout-save-error/retry`、`workspace-empty-action-<id>`。普通按钮用 role=button + aria-pressed/expanded/controls；frame 用有名称 region；resize 用 separator/orientation/min/max/now。

### V0 — 改前保留行为基线 / A3 / T1,T6

现有文件：`src/components/editor/workspace/panels/BottomDock.test.tsx`、`toolWindowRegistry.test.ts`、`workspaceLayoutPersistence.test.ts`、`src/stores/codeWorkspaceStore.test.ts`、`src/components/git/WorkspaceGitManager.parity008.test.tsx`。P2 在产品改动前运行这些精确文件，记录 HEAD+worktree、计数及失败；其中必须实际选中 mounted-hidden、MRU isolation、旧数据/每 leaf view identity、multi-repo stale response 等断言。对未覆盖的“dirty A/另一 leaf/隐藏再回来”先补最小基线并运行，不能改完后宣称改前已通过。

已有 UI：`TC-IDE-SHELLLAYOUT-01.testcase.yaml` 主要是 visibility/reset，不能独自证明 dirty/undo；`TC-IDE-CW-LAYOUT-01-resize-and-split-browser.testcase.yaml` 保护 split/resize/More，`TC-064-code-workspace-editor-save-and-style-status.testcase.yaml` 保护移动的状态操作。先核对/复用匹配输入的基线报告；无报告时选这些实际有关步骤运行。旧 reset 操作保留，旧标签列视觉断言按 DEC-010-01/05 更新。目标新增动作的 baseline fail 与保留测试 pass 分别记录。

### V1 — rail/多区域/内容生命周期 / A1,A3 / T2

路径：**修改** `TC-IDE-SHELLLAYOUT-01.testcase.yaml`（保留 ID `TC-IDE-SHELLLAYOUT-01`），browser，covers F25.1/F25.5。初始 fixture A，空 editor、Project open、right/bottom closed。

1. 检查 shell 区域和空态真实绑定；点击 Go to File 提示并 Esc，打开 README，再打开 Java，editor 内容完全等于 fixture。
2. 逐个用 rail、View→Tool Windows、More 打开 Project、Structure、Documentation、Problems、Terminal、Run、Debug、Commit、Git；每次检查实际 frame、selected state、焦点和可用/不可用原因（browser native 功能为 typed unavailable，不可当真实 PTY/Git）。Project+Problems、Structure+Documentation+Run 的组合应可见，不出现第二份 editor/document。
3. 遍历所有原 bottom catalogue 的 More 项（Analysis/Search/Structural/References/Call Hierarchy/Type Hierarchy/TODOs/Build/Tests/Coverage 等），每项到正确 content，不能只点按钮不核结果。
4. Search 输入查询，切 Problems 再回 Search，query/结果保留；hide/show 两轮，dirty 和 editor text 不变。异步内容 loading→failed→retry 的 provider 数据用 mounted mock 精确控制，断言 shell 只展示 owner 内容、不吞失败、不抢焦点。
5. header ⋮→Focus Editor 回原 leaf；重新打开 ⋮ 后 Esc 回原按钮；header Hide 隐藏且 editor 可继续输入/undo。最终还原文本并关闭测试 workspace。

收集：DOM state、focus、每次 content identity/全文、正常/失焦/空/不可用/失败截图；浏览器不认证 Git/PTY/provider。

### V2 — 所有 Action/键路由及负向 / A2,A3 / T3

路径：**拟新增** `qa-ui-auto-tests/cases/TC-IDE-ALIGN-010-KEYS-shell-tool-routing.testcase.yaml`，ID `TC-IDE-ALIGN-010-KEYS-shell-tool-routing`，browser，F25.5；本次规划时 ID 未占用。辅助新 `workspaceToolWindowController.test.ts` + 既有 action host/registry tests。

初始 Java 在两个 leaf 打开；分别留不同 caret/selection，右 leaf 为当前来源；底窗 closed。按 §4 快捷键表逐个工具执行：真实 key 打开→Esc 保持可见→再次 key 聚焦→再次 key 隐藏；每步断言 frame、activeElement/来源 leaf、文本无变。绑定和 menu/Action 各入口均路由同工具，不用直接调用 handler 替代 key。

继续：开 Project+Problems+Documentation → Ctrl+Shift+F12 两次，检查集合、尺寸和 editor leaf；聚焦 Problems → Shift+Esc → F12，检查 last-tool；从 editor 的 Shift+Esc 不误关 Project。显式 Restore Default 和 Shift+F12 各一次，只重置 chrome。无 last tool 时 disabled；空 editor 返回其 focusable 提示容器。焦点回归用单字 z → undo，完整文本恢复。

负向：打开工具后删除来源 leaf，再 Esc 返回本 workspace active；打开 A 工具安排 rAF 后切 B，A 迟到 focus 不落 B；IME composing、key repeat、AltGr、modal 下按键不 toggle；普通输入、Terminal 子输入的 Esc 不被全局抢。mounted tests 控制 deferred callback，browser 用真实 editor/input/modal 和连续按键验证可达路径。默认 F12 不再 definition、Ctrl+B 仍进入现有 definition 流（无 provider 显示已有原因），自定义 F12 覆写和兼容 scheme 按真实 keymap 入口验证。

### V3 — resize/迁移/故障恢复与多 leaf / A3 / T1,T2

路径：**修改** `TC-IDE-CW-LAYOUT-01-resize-and-split-browser.testcase.yaml`；辅助 persistence/store/controller/BottomDock tests；browser。初始双 leaf 同文档，右 leaf dirty（末尾 z）、不同 scroll/selection，Search 保留查询。

1. 拖动 Project、right、bottom 分隔条，键盘 arrow 再 resize，断言 separator 数值和实际矩形变化；切 Run/Problems，高度各自恢复。
2. 进行 pointercancel、Esc、window blur、切 workspace，各断言恢复 drag-start 值并释放捕获；迟到 pointermove 不更新 B。取消协议采用本卡明确适配，不标 IDEA 实测。
3. 窄窗再放大：effective clamp 不覆盖 preferred；隐藏/最大化/默认 reset 后，保留文字、dirty、undo ledger、leaf 数和各 view selection/scroll（只对 reset 允许 chrome 尺寸变化）。undo/redo 各一次核全文。
4. 保存干净后 reload，恢复文件/尺寸/view；不以 reload 证明未保存 dirty 自动保存。dirty 重启恢复沿现有恢复机制，不新增自动丢弃或隐式保存。
5. fixture 安装旧 v1/旧 v2/current toolLayout、损坏 tool 字段/unknown version，各 reload 检查合法文件/leaf 未丢，outline 原位迁移。mounted test 模拟 localStorage 写抛错：可见“布局未保存”，重试成功后 reload 恢复；先 A 失败再切 B，A 的迟到 retry 不写 B；回 A 后显式 Retry 只写 A 的当前布局，不重放过期 snapshot。

### V4 — toolbar/status/空 editor 与共享消费者 / A1,A3,A4 / T5

路径：**拟新增** `TC-IDE-ALIGN-010-CHROME-toolbar-status.testcase.yaml`，同名 ID 去扩展名，browser F25.5；同步修改既有 `TC-064-code-workspace-editor-save-and-style-status.testcase.yaml`、`TC-IDE-CW-UI-01-settings-actions-browser.testcase.yaml`、`TC-IDE-CW-SHELL-01-editor-shell-actions-browser.testcase.yaml` 的移位 selector（保留原结果断言）。

以 fixture Java/README、1 个 readonly 文件、2 个 workspace 开始：

1. 逐一从新 toolbar/⋮/View 触发原 Save/Reload、Back/Forward、Build、Refresh、Split/unsplit/sync-scroll、Wrap、Column selection、Inlay、Blame、Tab policy、Zoom/reset、Git、搜索、设置、运行配置/Run/Debug 入口；使用 existing Action ID，断言实际状态/弹层/disabled 原因。会写文件或启动 process 的 browser 路径只证实 dispatch 和 typed unavailable，真实边界见 V6。
2. 在 Java 选择 5 个字符，status 显示 5 chars；切 leaf 后反映该 leaf，readonly 显示锁。EOL/encoding/indent 使用原 UI，断言 dirty/选择值；打开 encoding 后 Cancel 无修改，native 字节见 V6。
3. 通过 SDK/Facts status 打开原设置/详情，loading/失败消息和 Retry 保留；不得把未知服务状态替成 success。导航路径/符号缺失时只显示可信路径。
4. A→B→普通 app tab→A，状态与动作 owner 都正确，其他 app 状态仍可见；隐藏 A 的迟到状态不能覆盖 B。空 editor 所有提示动作点击/当前绑定一致；移除绑定时提示同步，不执行虚构动作。
5. 1400×900、窄窗 900×650、200% zoom，逐个 toolbar/menu/status 项键盘可达；次要状态进入详情，无半截值、菜单不越界、工具 hide 仍可用。

### V5 — Git 容器接入与独立管理器保留 / A1,A3 / T4

路径：**拟新增** `TC-IDE-ALIGN-010-GIT-tool-context.testcase.yaml`，同名 ID 去扩展名，browser（外部 Git mock/stub 的边界明确）；辅助 `WorkspaceGitManager.parity008.test.tsx`、新 controller tests。真实 Git 合并在 V6，不启动两个 native 构建。

1. mock fixture A/B 同相对文件名、不同 diff，挂载 workspace，Alt+0 进入左 Commit、Alt+9 进入底 Git；两者同时显示，使用同一 root scope/selection/controller。
2. 在 A 写 commit draft、选择变更；看 B 的 Log，再回 A，draft/selection 不丢，不把 B 的内容显示为 A；切工具/hide/show 不重新初始化 snapshot。
3. 延迟 A refresh/diff，切 B 并返回 B 完成结果，随后释放 A；断言当前 B 不被覆盖、不跳 focus。failed 保留原因/Retry；cancel confirmation 不 stage/commit。
4. 从显式 Open Git Manager 打开独立 Git tab；原多仓库 scope、changes/diff 路径仍可用；模拟一处 repo refresh 通知，两消费者各按当前 roots 更新，无重复 commit。unavailable repo 与 empty changes 区分。

结果断言不能 mock 掉新 controller 本身。V6 至少用本地 repo 证明两个容器实际查询同一 repo，并验证取消零写入。

### V6 — 当前端 Tauri OS/磁盘/PTY / A2,A3,A4 / T6

路径：**扩展** `TC-IDE-SHELLLAYOUT-02-shell-layout-native.testcase.yaml`，保持其实际 ID `TC-IDE-SHELLLAYOUT-02-shell-layout-native`；已有 `project_tree` / `reset_db`。新本地双 repo fixture 由 T6 实现/注册；命令不使用未实现 verb。无法自动化的 OS chord/IME 用同构建手工观察另存，不伪装 runner pass。

1. 使用合格 QA 构建与隔离 app-data，通过 recent workspace 打开真实 project_tree；真实 Alt+6→Esc 直接输入 z、save，检查磁盘变化；undo/save 检查原 SHA-256。切工具/Hide All/restore 后重复单字探针，原文/hash 恢复。
2. 第二 leaf 与 A/B workspace，OS 真实键执行 §4 关键 Hide/Last/Return，确认 WebKitGTK focus 和返回 leaf；input composition 期间按 Esc 保持 composition 控件 owner，结束后工具操作正常。记录系统是否拦截，不能由 WebDriver key 成功声称 OS 未拦截。
3. Terminal 开一个测试 shell，输出独立 nonce 行，隐藏→Run→最大化→恢复→Terminal；同一 shell PID/session 和 cwd/输出/输入缓冲保持，再输出第二 nonce，仅各出现一次（排除 echo）。关闭测试 workspace 后只本轮 PTY 正常结束，无 leaked session。该层证明浏览器不能证明的真实进程保留。
4. 双本地 repo 通过 Commit/Git 两容器看真实 changes/log，输入未提交消息并 hide/show 保留；取消已有 commit 确认后 `git status --porcelain`/HEAD/index hash 无变化；显式独立 Git tab 看同 root/diff。无需联网 JDK/JDT LS。
5. 真正重启隔离 QA 应用恢复正常布局与已保存文件；旧布局迁移、视口缩放不丢文件。encoding/EOL 原状态操作至少一条真实磁盘断言，最后 restore fixture hash。read-only 拒绝写仍显示原因，不假 saved。
6. 收集匹配 source/case/runner/build 的 summary+receipt，选中/通过/失败/skip 数、文件 hash、PTY 证据、截图、OS 手工步骤；只清理测试资源。Windows 相同步骤用 PowerShell 测试 shell/WebView2；macOS 用 zsh/WKWebView及实际 Meta 映射。P2 本轮 Linux 必做，另两端记未验证和后续环境。

### V7 — IDEA 功能/交互/视觉、可访问性 / A1,A2,A4 / T6

复用 IDEA 参照 S0/S2/S3/S4/S5/S4r，加旧参照 Commit+Git；P2 在 Taomni 同 fixture/条件执行相同动作。功能对比的是可见组合、状态/文本/保留结果；交互对比 focus、Esc、toggle、Hide All/restore/Last Tool；视觉分别测 toolbar、rails、tool header、editor bounds、status（不拿整 app 外围与 IDEA chrome 直接比）。正常/选中/失焦/disabled/empty 逐项记录，loading/failed 无 IDEA 等价状态时标 Taomni 适配。

A 采用当前用户字体/配色并记录 UI scale；B 在隔离配置的两侧默认值采样，不能改用户全局设置。P1 原图尺寸/scale 未齐时，P2 补对应几何参照再判视觉，不能直接宣称已 matched。评审目标是相同空间层级、动作次序和无截断；具体 px delta 全列出。应用 tabs/Tao、右侧非同名插件窗、已有内容细部归后续卡等接受差异明确标 `different/accepted adaptation`，不能计入 measured match；有未解释的 shell 差异则 A4 不通过。formal compare schema/validator 只校验记录，声称 measured match 的子范围另用 `--require-match` 和人工视觉表支持。

可访问性同一次 browser/native 采集分项记录：纯键盘遍历工具/菜单/resize；name/role/pressed/expanded/state 与真实状态一致；隐藏内容不在 Tab/辅助树；焦点环可见；200% zoom 无控件丢失；Linux Orca 手工检查工具名称、可见/选中状态与错误播报，IME 按 V6。其他端后续 NVDA/VoiceOver，不以 DOM aria 替代 screen reader。本卡不设新的性能基准，无 performance gate。

### 执行入口与最终证据

这些是 P2 计划命令，**本轮未运行**；新增 case/test 必须先由 T6 落地。仓库根 Bash：

```bash
pnpm exec vitest run src/components/editor/workspace/panels/BottomDock.test.tsx src/components/editor/workspace/toolWindowRegistry.test.ts src/components/editor/workspace/workspaceLayoutPersistence.test.ts src/stores/codeWorkspaceStore.test.ts src/components/git/WorkspaceGitManager.parity008.test.tsx
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --filter TC-IDE-SHELLLAYOUT-01
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode browser --filter TC-IDE-ALIGN-010
python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor --path src/components/git --path src/components/statusbar --path src/stores/codeWorkspaceStore.ts --path src/stores/codeWorkspaceStatusStore.ts --path src/layouts/MainLayout.tsx
python .agents/skills/qa-ui-auto/scripts/native_build.py --check
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --mode native --filter TC-IDE-SHELLLAYOUT-02-shell-layout-native
```

typecheck 范围要按最终实际编辑文件补齐，一次检查所有 owned paths；上述目录允许覆盖共同类型消费者，不能临时缩小来躲错误。native build check 需要构建时走现有 background_job/native_build，不直接启用已安装 `/usr/bin/taomni` 冒充本次源码。其他 V 的既有 case 也按表显式选择，不只跑上面示例两个过滤器。

| AC | 主测试/保留测试 | required evidence | 当前结果 |
|---|---|---|---|
| A1 | V1/V4/V5/V7 | code-audit, browser, native, idea-comparison | P1 合同/IDEA 单侧参照已具备，产品 unrun |
| A2 | V2/V6/V7 | unit, browser, native, accessibility, idea-comparison | unrun |
| A3 | V0/V1/V2/V3/V4/V5/V6 | code-audit, unit, typecheck, browser, native | unrun；基线待 P2 执行 |
| A4 | V4/V6/V7 | browser, native, accessibility, idea-comparison | unrun；三端产品未验证 |

required_evidence 共 `code-audit/unit/typecheck/browser/native/accessibility/idea-comparison`，与板一致。单次 V6/V7 可支持多个 kind/AC，不重复构建；真实 PTY/Git 路径已在 native 明确要求，不以 provider 名义重复另一套场景。证据保存 `qa-ui-auto-report/ed-parity-010/<run>/`，保留先失败后通过的完整历史，结束时 T6 回填 AC → V → actual case/assertion → report+receipt，标出尚未执行平台。没有产品实现或 required evidence，不能把 010 记 done。

## 9. P1 审查、交接和回退

设计就绪要求：本卡行为已收敛、IDEA 关键转换可复用、可重建 fixture 与完整 case 计划齐备、任务/文件/依赖清楚。拟新增控件与 fixture 支持是 P2 显式工作，不伪称当前可执行。P1 仅验证 Markdown 链接/anchors、diagram XML/预览、ID 去重、board schema、git diff；不执行产品构建/测试，因为没有产品改动。

回退：新 shell 接线可回退到旧容器，document owner/IPC 未迁移；持久化新字段与 legacy 镜像共存。不能以回退 UI 为名清空 workspace 或删除 layout keys。若 P2 发现真实功能退化，归本卡修复；非相关 provider 旧失败需有基线，且阻断 A3 时仍要解决。

P1 完成后只将 010 从 deferred 改 ready、planning_required=false；不写 owner/claimed_at/baseline/产品 evidence，不改其他卡状态。P2 可从 T1 开始，claim 命令必须指定本板；P2 最终 `done` 需要全部 AC 与证据，平台上限只能声称当前端和已比较的 shell 子范围。

### 本轮实际检查（P1）

- `task_board.py --doc docs-feature/code-workspace-idea-alignment/backlog.md validate`：exit 0，13 张卡 metadata/依赖/spec anchor 合法。
- 同板 `list --claimable`：仅 `ED-PARITY-010` 为 ready；`show ED-PARITY-010` 确认 planning_required=false、无产品 claim 元数据。
- 本轮链接/合同检查（脚本保留于原件目录 `check-planning.py`）：6 份 Markdown、79 个本地链接/锚点通过；仅 010 metadata 改变；4 个 AC 完整；3 个新 case ID 未被占用；fixture SHA-256 与 IDEA 探针撤销后的文件一致；drawio 两页 XML ID 合法。
- 两页普通 PNG 已成功解码并目视检查布局、文字和状态栏，无明显遮挡。最初 `--embed-diagram` 导出生成无效 PNG，未作为交付；最终保留独立 drawio 源文件与普通 PNG。
- `git diff --check`：通过。源码与产品测试未修改，产品 unit/typecheck/browser/native/accessibility/comparison 均未运行；当前 HEAD 仍为 `6763642b`，交付文件留在工作区，未创建 commit。
