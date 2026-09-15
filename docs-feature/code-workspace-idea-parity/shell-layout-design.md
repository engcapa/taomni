# REQ-03 首包设计 — WP-SHELL-LAYOUT-01

2026-09-14 P1，设计修订 v3（沿用已采纳图稿 v2）。**部分规格已确定，关键参照未齐，不可领取开发。** 唯一任务板为 [shell-layout board](../../claudedocs/code-workspace-idea-parity-backlog-shell-layout.md)，新 ID `ED-SHELLLAYOUT-001`；状态以 metadata 为准。首次 author 曾过早写 ready，收尾已纠正，未发生 claim、owner 或产品实施。分支 `docs/code-workspace-idea-audit-20260913`，HEAD `0694a03f839827402a628f6c7b2ccbb0c997dd0e`，接手干净；[身份](evidence/shell-layout-plan-20260914.json)记录本轮文档 diff 与原始工件。没有确认新产品 bug，不启动 issue-design 修复流程。

## 1. 用户结果和边界

连续场景：F0 workspace → README/source、example 正式打开 → Project/editor/Problems/Run 切换 → 折叠重开/resize → 键盘回当前 editor → 恢复工具窗布局。打开文件集合、正文、selection、dirty、共享 undo 和工具数据保持正确。

主场景 CW-SHELL-001；CW-SET-001 只提供比较所需 theme/font/zoom/density。CW-PROJ-001/004（入口、过滤/刷新）、CW-TAB-001/002（宽度、leaf、snapshot）、CW-SHELL-002（菜单/Find focus）、REQ-10（动作路由）按下述真实消费者纳入。REQ-04/11 是受影响数据保留前提，不要求先全量验证或修改其旧卡。toolbar/menu/status 仅改必要入口和空间影响；不重做全部菜单设置、Git/Run 后端、语言服务、Keymap/Code Style、插件生态或整体 P0。

当前布局可重构。保留的是能力、数据、兼容和用户已确认结果，不是组件树、现有 24% 或双侧栏排版。

## 2. 当前生产证据与查重

下表路径均相对仓库根；`W/`=`src/components/editor/workspace/`，`Tab`=`src/components/editor/CodeWorkspaceTab.tsx`。行号不作为契约。

| 当前 caller / owner | 源码事实及影响 |
|---|---|
| `src/layouts/MainLayout.tsx::openCodeWorkspaceInfo` / `codeWorkspaceTabs.map` | 每个 app tab 常驻 keyed wrapper，display 切换，传 `visible`。关闭 workspace 才真正卸载。不得用工具窗开关替代 workspace tab 生命周期。根菜单通过 `onCommandsChange` 取得工作区动作。 |
| Tab → `W/useWorkspaceActionsController.ts` → `W/workspaceActionHost.ts` | hook 以 state 持有 Host，真实卸载 dispose，StrictMode disposed 后 self-heal；snapshot/menu/keymap 同 owner。Tab 只在 visible 时注册 window key listener；输入框、terminal、surface、CM completion 的快捷键优先级已经分流。 |
| Tab → `PanelGroup` / `FileTreePane` / `ProjectTree` | Project 默认 24%、最小 12%、最大 45%；右 pane 20%/12%/40%；lastProjectPanelSizeRef、lastRightPanelSizeRef 在 shell 内，尺寸 effect 有 rAF cancel；百分比阈值控制 open。这些是实现基线，非目标值。 |
| Tab → `W/panels/BottomDock.tsx` | 唯一生产 JSX caller。13 个工具 tab，全部 keyed mounted，inactive/collapsed 用 hidden；高度可 controlled，但 Tab 目前未传 height/onHeightChange，故读写全局 localStorage `taomni.codeWorkspace.bottomDockHeight.v1`，120..640/default192。 |
| `src/stores/codeWorkspaceStore.ts::CodeWorkspaceInstanceUi` | workspaceInstanceId 隔离 openFiles/lspFiles、tree、open/active tool、editorGroups/layoutTreeV2/layoutRevision。默认 languagePanelOpen=true、bottomDockOpen=true、bottomDockTab=references、rightPaneOpen=false。P0 双侧栏截图不代表当前默认右 pane 展开。 |
| `W/workspaceLayoutPersistence.ts` | v2 snapshot 保存 language/bottom/right flags 和 tabs、递归 editor tree、view-state。现无 Project/right pixel sizes 字段；旧 normalize fallback 的 bottom open/references 必须与新建默认区别处理。 |
| Tab → `W/toolWindowRegistry.ts` → `TabSwitcher` / Search | `syncBottomDockToolWindows` 镜像 real open/hidden；MRU、badge、unavailable 分开。`buildSwitcherSnapshot/commitTabSwitcher/closeFromTabSwitcher` 是共享消费者；重组 rail 不能只修 BottomDock JSX 而漏掉它们。 |
| Tab `requestTreeOpen/tryGrantTreeFocus/registerEditorCommandPort` → `EditorGroup` → `CodeMirrorHost` | 当前已用请求 ID/interaction epoch、group/file/token ready-port 聚合焦点。group/key 不匹配可早返而保留 pending；tab/leaf/workspace 往返竞态在旧卡 unrun，属于本包必须检查风险，不从代码 alone 签发 bug。 |
| Tab 的 Problems/Run/Build/Debug/Terminal/search callbacks | 多处 setBottomDockTab/Open，`workspace.showRunTasks` 只展示 Run；实际运行数据在 shell/hooks/panels/PTY/DAP/provider。布局动作不得 Stop、Clear、关闭 PTY 或重新读取覆盖 dirty。 |
| `W/editorAppearanceProfile.ts` / `editorAppearanceExtension.ts` / Tab treePaneStyle | editor profile 的 font、lineHeight、theme、zoom 与树 font 有独立来源；不能用全局 CSS 覆盖全应用或破坏 profile 迁移。 |

查重：旧 `ED-CHROME-001/002` 是 highlighting/banner，不是 shell 改版；`ED-TABS-001..004`、`ED-MULTIVIEW-*`、`ED-MAIN-009 → ED-REPAIR-009` 维护布局树、共享文档和 snapshot，保留有效合同；均不重开。`ED-TREEOPEN-001` metadata=done，有 Linux native，visual verdict=incomparable；后续双击 select-first 与测试迁移已在 HEAD。`ED-FINDFOCUS-001` metadata=implemented，provider 等未完成仍归原卡；当前 Find 已有 generation/延迟清理，设计中“P1 未实施”为历史。没有同名 shell 卡，故新建本板，不借 done 声称整 REQ-02 或三维匹配。

## 3. 参照条件与目标分类

[REF-SHELL-LAYOUT-LINUX-20260914](references/shell-layout-2026.2.2-linux.md)及[原件清单](evidence/shell-layout-artifacts-20260914.json)是本轮 IDEA 局部观察；Tree 的 187 个历史工件全部 hash 一致，可用于原动作范围。当前 IDEA 安装和 PID 已复核，2026.2.2/IU-262.10315.125。新窗口 1400×1000，窄窗 800×700，DPI/设置来源与未复核项见参照。

- **已见目标差异**：IDEA 在 workspace 内侧的底部工具窗跨 Project/editor 宽度，外侧竖 rail 保持可达；Project 与 editor 的面板边界/标题层级；这些支持重组方向，不证明 Taomni 当前 bug。
- **纯证据缺口**：当前 Taomni 相同状态 native、dirty/restore 前后、Run retained output；本轮零执行，P0 browser/旧 native 不补签 current。
- **输入/采样局限**：第一轮11不是resize、09是bookmark，作为历史失败保留。第二轮r2-04..18补齐Project折叠/重开、底部resize、Run空态及Restore Current Layout；r2-23仍未显示Font页，不当成功。
- **不可比较条件**：第二轮GUI已核theme/UI font/zoom/keymap，editor font页/lineHeight、compact density和有效scale仍不完整；r2-27已无Augment body，Taomni客户区/缩放字体尚未匹配；不能用总窗大小、深浅颜色或结构 validator 推量化 bug/matched。

待冻结测量表：顶栏/工具 rail/标题/tab 高度、Project 和底部默认/最小/最大尺寸、gaps、icon box/选中失焦/禁用角色、菜单边缘策略。每项需 `ref step + client rect + raw px + DPR/zoom + Taomni CSS px + candidate diff + 容差理由`；目前只允许引用参照列出的局部像素，不猜其余 token。实际桌面缩放不会自动成为全平台默认。

## 4. 图稿与决策

[图稿 v2 预览](shell-layout-wireframe.png) / [可编辑 drawio](shell-layout-wireframe.drawio)。图稿展示 S0..S3，标注均为设计说明，非产品 UI 文案；等宽呈现状态，不按原图比例绘制。用户已明确回复“采用图稿 v2 的默认结构”；仅结构获确认，示意尺寸/色值不自动成为规范。当前 drawio CLI 存在，但归还桌面后不启动 GUI 导出；预览由相同节点用 Pillow 离线渲染，非 drawio CLI 导出或实拍，已目视检查。

| DEC | 候选 / 推荐 / 影响 | 状态与依据 |
|---|---|---|
| DEC-SHELL-01 | 重建全局 layout owner / 保留权威 store、提取本包 shell chrome adapter。推荐后者，允许替换渲染组件，不为复用成本冻结 UI；不新增外部依赖。 | agent 自决；现有 store/Host/document 合同唯一要求，关联 A4/A5/A6 |
| DEC-SHELL-02 | 新 workspace 默认 Project 展开、bottom 工具窗收起（图 S0；bottom 的默认 active tab 仅在展开时适用）。推荐 S0，接近新 F0 初态、增加 editor 空间；已有 snapshot 保留 open/tab/ratio，不强制迁移关闭。 | 用户已定（2026-09-14，会话原文“采用图稿 v2 的默认结构”）；A1/A3/A4。保留旧snapshot；不把示意值当实测 |
| DEC-SHELL-03 | restore 只恢复工具窗 chrome / 连 editor split 一起合并。推荐前者，避免影响用户已确认独立 view；编辑器分屏的 Unsplit 保持独立动作。 | agent 自决，用户保护 open files/view 合同；恢复到本包新workspace chrome默认（用户接受S0），不复制IDEA当前自定义布局的Project关闭；精确尺寸仍待定，A4/A6 |
| DEC-SHELL-04 | 把主菜单/所有设置复制一遍 / 只把本场景动作接到现有菜单与 Action Search，tool rail 用现有 registry。推荐后者。 | 用户已定范围，A2/A5/A7；不移除非首包工具入口 |
| DEC-SHELL-05 | global app theme 覆盖 / workspace scoped chrome roles + 沿用 editor profile。推荐 scoped；只在比较 profile 选中时映射本包 roles，旧 theme/profile 原样可读。 | agent 自决保留全应用入口；精确色值/可用字体需 BL-SL-01，A1/A7 |

## 5. 空间与交互合同（确定部分）

空间层级：MainLayout 全应用 tab/导航在比较区外单列；workspace 顶部必要菜单/toolbar；左右 rail 夹内区；内区上半 Project + editor + 按需右 tool pane；下半单个 bottom dock 横跨内区；workspace status。允许隐藏/重排内区 UI，但 editor leaf 树的位置/key 必须稳定，resize/底部开关不能让同一 EditorView 卸载。非活动工具内容继续 mounted 或由稳定上层 data owner 持有，不能迁移后丢 search query、terminal、debug/session 或 run 输出。

宽度/高度用已观测 profile 冻结后的 `projectWidth`、`bottomHeight` 逻辑 px；record last nonzero size。渲染时按可用客户区 clamp，缩窄产生临时 effective size，不把临时压缩覆盖用户 preferred size。几何约束：`availableInnerWidth ≥ effectiveProject + separator + editorMin + effectiveRight`；高度扣除实际 toolbar/status/header。`editorMin/projectMin/bottomMin` 等确切值属于 BL-SL-01，未定之前不得开发猜值。Project 内容独立滚动、tabs 独立 overflow；拟议窄窗更多入口不可吞原动作。不能通过统一 scale down 把控件缩成不可点。

| 事件 | 可见结果与焦点 | 取消 / 迟到 / 错误 |
|---|---|---|
| 激活 Project / Problems / Run | 已关闭先显示；焦点到该工具的合法上次位置/首个可交互控件。selected tool 与 focused tool 分开；离开后 selected 仍可见。采用r2-04..06的三态：hidden→显示并focus；visible但失焦→只focus；visible且本工具持焦→hide。rail对当前已激活工具可hide（r2-09）；显式旧toggle动作语义仍为toggle，激活动作不能混用。 | 空态不触发后端；无有效 tool 给现有 typed unavailable/reason，不回落到无关工具 |
| 点击 editor / 键盘返回 editor | 只调用当前 workspace + group + file 的 matching ready `EditorCommandPort.focus({preventScroll:true})`；不使用 reveal 改 selection。 | 无 editor 时给 editor empty surface 可见焦点；file loading 不重开/重读，待 ready 只允许最新用户 intent |
| menu Esc / tool Esc | menu/popover 先消费并还给 opener；Find 仍保留当前 match selection；Problems/Run普通工具surface的裸Esc返回当前editor且工具保持显示（Problems r2-11..13；Run采用同类适配，非独立实测）；不能让终端/IME按键穿透。 | outside click 不抢焦点；owner 已移走/销毁直接取消，不全局 querySelector 第一个 editor |
| collapse/close | 只隐藏本工具，保留 active tab/query/data；仅当 focus 在将隐藏区域内才还 editor，不抢其他有效 surface。 | 重开不触发 Stop/clear/reload，不关闭 workspace |
| drag | 只修改 workspace chrome geometry；pointerup 提交 preferred size，pointercancel/dispose/visibility change 移除 listener/release capture；keyboard separator 使用等价动作。 | 取消回复 drag 开始几何；workspace 切换使 drag token 永久失效，迟到 up 不写 B 或回到 A 后补写 |
| Restore tool-window layout | 在当前 instance 原子 patch chrome defaults，invalidates 本包 pending geometry/focus；保留 editor tree/tab/document 与工具数据；恢复 focus 到仍有效原 owner/明确 editor 入口。 | 不把 session Restore 与 chrome Reset 混成同动作；持久化失败内存仍可用、提示未保存，不伪造成功 |

拟新增内部 `ShellChromeState`：`version:1, projectWidthPx?, rightWidthPx?, bottomHeightPx?`，open/active 沿用现有字段，无第二 active tool truth。只保存 finite/合法值，读旧 v2 可缺字段并从旧 bottom height 读一次 fallback；不删除旧键、不遍历覆盖所有 workspace，写只写当前 snapshot。新 workspace defaults 与 legacy missing-field fallback 分开测试。shell reset 不改 layoutRevision 的文档/leaf 语义，几何若需 revision 用局部序号。此字段集的尺寸默认需 BL-SL-01 解锁。第二轮Run323px与Problems449px提示IDEA按工具记忆尺寸；改为可选 `bottomHeightByTool?: Partial<Record<BottomDockTab, number>>`，旧bottomHeightPx只为无个体值的fallback，工具切换切至其preferred高度，禁止把临时clamp回写其他工具。

拟新增本包局部 focus intent：`workspaceInstanceId, workspaceLifetime, leafId, canonicalFileKey, mountToken?, interactionEpoch, requestId, origin`。从用户命令冻结，当前 visible + active leaf/key + same mount + 最新 epoch 同时满足才执行；切 app tab/leaf/file、用户点击别处、Find/menu 获焦、关闭、dispose 均永久撤销旧 intent。不能仅比较“现在又是 A”而让 A→B→A 后复活。与 Tree pending epoch 统一失效入口，区分 file load commit 合法性和 focus grant；不能为了取消焦点删掉正常文件读取结果。

新增动作候选 `workspace.activateToolWindow`（typed payload tool id）、`workspace.returnToEditor`、`workspace.restoreToolWindowLayout` 必须由现有 Host 注册；保留 `workspace.toggleProjectTree`、`workspace.showRunTasks` 等旧 ID，adapter 委派同 owner。菜单、rail、toolbar、Switcher 用同注册状态，context 包含真实 target，避免按钮直接 setter 绕过执行结果。disposed Host 的现有失败结果不改枚举；failed/cancelled/stale/unknown-effect 继续各原通道，layout 没有磁盘文本效果，绝不重标为 save success。

<a id="ed-shelllayout-001"></a>
## 6. ED-SHELLLAYOUT-001：AC → TASK → V

所有 AC 属于唯一工作包 TASK-SHELL-01（产品、测试、组合自验责任），没有实际领取人。

| AC | 总需求 | 可观察断言 | 验证 |
|---|---|---|---|
| ED-SHELLLAYOUT-001-A1 | REQ-03-V / CW-SET-001 | 匹配正常与窄窗客户区/profile后，Project/editor/bottom/rail/header 的几何、密度、font、icon、active/selected/blur/disabled 逐项有参考实测与候选差值；没有未接受差异。 | V-SL-03/04/05；前置 BL-SL-01；BL-SL-02已解 |
| ED-SHELLLAYOUT-001-A2 | REQ-03-I | F0 双击/Enter 打开 example → Project → Problems → Run → keyboard editor；Esc 菜单/工具分别按参照，直接 x 只入当前 leaf，一次 undo 恢复71字节。 | V-SL-02/03/04/05；BL-SL-01 |
| ED-SHELLLAYOUT-001-A3 | REQ-03-I/V | Project 和 bottom 两次拖动、各折叠/重开，last size/tab/selection 恢复；窄窗后放大还 preferred size；取消/失焦/卸载无残留 drag，hidden 内容不可键盘误入。 | V-SL-02/03/04/05/06；BL-SL-01 |
| ED-SHELLLAYOUT-001-A4 | REQ-03-R / REQ-04/11 | tool-layout reset 前后 openFiles、正文、dirty、leaf tabs、selection、undo、Run 输出与 Problems 条目不变；旧 v2/新字段/损坏值读写可恢复；workspace session 恢复仍按原入口。 | V-SL-01/02/04；reset 目标 BL-SL-01 |
| ED-SHELLLAYOUT-001-A5 | REQ-03-R / REQ-10 | StrictMode/visible A→B→A、tab/leaf/key→回原、pending tree open/resize/menu/Find 下，仅最新合法 owner 获焦/执行一次；工具 show/hide/resize 不销毁或重新创建 Host/EditorView。 | V-SL-01/02/03/04 |
| ED-SHELLLAYOUT-001-A6 | REQ-03-R / REQ-04/11 | 下表 R1..R7 所有保留断言在真实受影响 caller 继续成立；不以 Tree done、Find implemented 或保存无反例替代验证。 | V-SL-02/03/04 |
| ED-SHELLLAYOUT-001-A7 | REQ-03-R/V / REQ-10 | 所有13个底部工具及 Git/保存/设置/全应用入口仍可经已有 action/更多入口访问；disabled 原因、role/name/focus/200% zoom 可达，非 workspace app CSS/快捷键不受污染。 | V-SL-01/02/03/04/06/07 |

Required evidence 与板一致：`code-audit, unit, typecheck, browser, native, accessibility, idea-comparison, qa-lint`。一轮 native 可同时提供多类断言。功能/视觉/交互分别判，`incomparable` 不满足 A1；缺证据保持未通过，不降低 AC。

## 7. 保留基线与改后断言

| 保留项 | 改前依据（未运行即未知） | 改后可观察检查 |
|---|---|---|
| R1 树输入合同 | 用户确认；Tree 设计 DEC-TOF-01..05、当前 ProjectTree/Tab tests；旧 Linux native 只其版本/动作 | label 单击仅选，文件双击/Enter 正式一次，目录双击/Enter有效展开一次，箭头独立；正常打开后无需 editor 点击即输入；menu Esc 回树，outside 不抢 |
| R2 preview / tabs / 多 view | `workspaceTabPolicy`、shared document owner、CodeWorkspaceTab 的 ED-AUDIT-009 与 split tests | Ctrl/Cmd+Enter 分屏；其他入口 preview 默认不变；两 view 不同选区/scroll，修改双侧同步、一次 shared undo；非最后 view 关闭保留文档；dirty close Cancel 零变化 |
| R3 Find/hover | Find 最新 implementation、Host.findFocus/searchpanel/hyperlink tests | Ctrl/Cmd+F 自动 focus，tree 查询2匹配，导航/Esc保留当前match选区；query/close 不消费 undo；modifier-held blur/keyup 清理；pending focus 不在工具切回后复活。不接管原卡 provider gap |
| R4 保存/撤销/恢复 | Tab saveCommit/style/write-file 编码链；snapshot ED-REPAIR-009；当前运行基线未执行 | 先 dirty 再 resize/collapse/reset，无隐式保存；显式 save 一次、磁盘 hash 与缓冲一致；dirty Cancel 和 undo正确；一秒内编辑/切 tab 后 snapshot 同正文 identity；同长度异内容不得补签 |
| R5 工具数据 | BottomDock 保持 mounted 测试；shell run/debug/terminal hooks，registry callbacks | 已有 Run session/output/filter、Problems 数据在 hide→switch→show 后保留；没有新 run/stop/cancel/provider 请求；late 结果只进原 workspace。F0 空态不足证明有数据 retained，mounted 注入事件 + native 本地任务输出分别观察 |
| R6 owner / workspace | MainLayout 常驻/visible、Host tests；Tree 卡明确 tab/leaf/workspace race unrun | 延迟 open(A) → B → A → ready、切 leaf/file再回、dispose/remount 同key，旧请求无 focus；命令计数1，B正文/工具/geometry 不变；pending clipboard/editor owner 在 focus 出入后不复活 |
| R7 入口/主题兼容 | WorkspaceActionHost snapshot、toolWindowRegistry、FileTreePane、appearance profile tests | 添加目录/loose file取消不变；filter/compact/flat/refresh expanded descendants 结果不变；Git 管理可开可关不操作 repo，Terminal/search/right doc 等原入口可达；旧profile Cancel/Apply及其他app外观不受scope CSS污染 |

## 8. 文件职责与最小验证计划

TASK-SHELL-01 所有产品/测试/集成均由未来领取人负责；P1 不修改它们。主要文件 Tab、BottomDock、codeWorkspaceStore、workspaceLayoutPersistence；拟新增 `W/workspaceShellLayout.ts`/`W/WorkspaceShellChrome.tsx` 可用于有界状态机/渲染（未创建）。必要 `FileTreePane`/toolWindowRegistry/TabSwitcher、local style tokens、appearance profile 适配由同卡负责。MainLayout、Host/controller、EditorGroup/CodeMirrorHost、document owner、IPC 默认审查，只有真实必要改动才扩 scope 并补消费者。无预定 Rust/后端改动。

| V | 最小集合 / 具体路径 | 改前与候选 |
|---|---|---|
| V-SL-01 | 上表 caller + `toolWindowRegistry.ts`、`workspaceLayoutPersistence.ts`、MainLayout、Host、Tree/Find 最新修订；确认 A1..A7 最终接线 | 当前静态已查，P2 按最新 diff 复核；不是行为通过 |
| V-SL-02 | `src/components/editor/CodeWorkspaceTab.test.tsx` 中 ED-TREEOPEN-001、ED-AUDIT-009、project collapse、restore snapshot、ED-REPAIR-009；`W/panels/BottomDock.test.tsx`、`src/stores/codeWorkspaceStore.test.ts`、`W/workspaceLayoutPersistence.test.ts`、`W/useWorkspaceActionsController.test.tsx`、`W/toolWindowRegistry.test.ts`。新增 shell layout 小模块测试归本卡 | 修改前只跑真实保留名称子集。新布局需求不强凑 red；若复现实际回归才建 discriminating red。新增 pending Tree tab/leaf/workspace、pointercancel、mount-count 和 legacy read 合同。当前全部未跑 |
| V-SL-03 | 拟新增 `qa-ui-auto-tests/cases/TC-IDE-SHELLLAYOUT-01.testcase.yaml`（拟 id 同名）/F25.1、F25.3、F25.5及真实 controls，由本卡 author；既有 TC-IDE-FINDFOCUS-01、TC-IDE-C4-02 只按断言复用 | browser config `.agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml`，实际 F0 VFS 与 app 入口；主链一次捕获 geometry/focus/selection/hash/console。不是 native |
| V-SL-04 | 当前 Linux/WebKitGTK，隔离 com.taomni.app.qa + F0；先核匹配 binary，稳定 source/tests 后必要一次 QA build，再同轮主链+dirty save/undo+两workspace+run output retained | 本轮未执行。F0 shell 不依赖 JDT LS；Run 数据可用隔离目录中一次本地只输出标记的 shell task，结果/exit 不扩 Run 后端。若影响 shared snapshot restore，再最小2-view重开；不默认跑24-tab performance |
| V-SL-05 | 补参考§6剩余定值，再与 V3/V4同profile/client、正常/selected/blur/disabled/narrow/menu比较，完整原图与ROI/测量表 | schema/compare_idea.py 支持2026.2.x；真匹配用 --require-match 且审阅实际delta，不把记录校验当测量。当前没有正式 comparison |
| V-SL-06 | 同 V3/V4观察所有本包入口 name/role/state、键盘/焦点、separator 键盘尺寸调整、200%zoom；screen-reader 与 physical IME单列 | native 键盘/输入边界仅 OS 实测；synthetic composing 门控不证明 IME；触及 composition/Host 注册时补当前端真实 IME confirm/cancel |
| V-SL-07 | scoped typecheck union 一次；新case/controls/catalog齐后一次 `PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto audit --gate` | P1未跑，仅后续产品授权。repo build gate 明确引用 `claudedocs/code-workspace-idea-parity-backlog.md::ED-GATE-003`，不重开/不继承旧绿 |

QA 只读 plan 已执行：TC-IDE-TREEOPEN-01-project-tree-open-focus-native、TC-IDE-C4-02、TC-IDE-C4-03 / Linux，3个候选；plan 不是执行。C4-03 是24-tab restore/performance，默认不选入最小完成集合；本包若修改 restore queue/热路径才恢复其预算和匹配测量。Tree native case可复用R1，但不覆盖R6切换竞态；Find卡全部 provider/reader 缺口不是本卡 done 依赖。

三端计划：Linux 当前端用 WebKitGTK/实际 Ctrl+键、窗口/focus、真实字节；Windows WebView2 用同主链及Ctrl/Alt冲突、窗口scale；macOS WKWebView 用Cmd+对应现有绑定、菜单/窗口与同数据序列，手工或可用OS工具，不把Tauri WebDriver写成mac支持。当前端必要验证可满足 P2 本轮交付，另外两端各记未验证；已知代码不兼容必须修复。

## 9. 真实前置与下一步

| 条件 | 阻塞 | 最小解除动作 |
|---|---|---|
| BL-SL-01 剩余参照定值 | 已解除（2026-09-14 22:18） | r3补齐Font页（Source Code Pro 16, lineHeight 1.2, ligatures off）、Project clamp（min 0折叠至rail，max 1308保留37px最小editor sliver）、Bottom clamp（min 49px仅留header，max 849px留顶部toolbar与tab strip）、窄窗800×700 Problems overflow（展开Vulnerable Dependencies/Qodana/Security Analysis，Esc关闭）、菜单Esc及Restore Layout免点击直接输入与undo。定值完全冻结。 |
| BL-SL-02 图稿默认结构反馈 | 已解除 | 用户明确采用图稿v2，DEC-SHELL-02已更新；默认Project开/bottom关，已有配置保持。无需重复询问 |
| BL-SL-03 改前Taomni所缺决定性状态 | 实施前R2/R4/R5/R6基线，不单独假称bug | P2得到开发/运行授权后先定向mounted；layout/Host remount与工具数据实际基线若静态不足，补同源native最小序列。P1无runner权限，当前结果未知，不将整个REQ-11当依赖 |

BL-SL-01与BL-SL-02均已解除；卡可由authoring增量改为ready，进入P2开发队列。回退仅撤本包代码、保留旧v2和新增可选字段；不清用户localStorage/配置、日志、业务项目。所有新增/原失败工件保留，跨机先取原件验证hash。

### v4 已冻结的比较锚点与实测定值

参考§6/§7提供完整实测raw px：正常1400×1000/窄800×700：
- 顶栏toolbar高55；左右rail各55；内区x55..1345；status高47（顶953）。
- editor tab strip高48（y55..103）；Problems/Run header高50。
- Project宽约452（默认开展）；min=0（拖至最左完全折叠入rail）；max=1308（拖至最右，保留约37px最小editor gutter/sliver）。
- Problems高度：默认展开323→449并记忆；个体高度与Run（323）独立；min clamp=49px（正好仅露50px header）；max clamp=849px（向上顶至y=104，正好保留顶栏55+tab strip 48）。
- 窄窗800×700：内区x55..745，Project 455宽，editor 227宽；Problems展开至顶y=350（高303px）；header在x=649, y=377出现下拉chevron，点击展开`Vulnerable Dependencies`、`Qodana`、`Security Analysis`，Esc关闭。
- 焦点与输入：菜单Esc及Restore Layout后，光标均严格停留在当前活动editor，无需鼠标重新聚焦，直接键盘按键即可输入正文，Ctrl+Z可直接撤回。
- 编辑器字体：Source Code Pro 16.0，lineHeight 1.2，ligatures false。

恢复适配的影响：IDEA r2-18恢复当前命名布局，恰好Project和bottom都关闭。本包只提供恢复本包默认工具窗布局，使用用户采纳S0：Project开、bottom关、right关，工具tab/data与editor leaf树保持；不新增命名布局管理。文案用“恢复默认工具窗布局”，避免冒充恢复用户命名布局。legacy session restore仍读取其原配置。这是已确认默认结构和范围内的适配，不是IDEA默认状态的观察结论。
