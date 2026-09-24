# ED-PARITY-004 Keymap 改键冲突、取消与重开 — P1 设计

<a id="ed-parity-004"></a>

来源：[REQ-10](overall-audit-plan-20260913.md#req-10) / [CW-SET-002](capability-matrix.md#cw-set-002)。本卡是唯一任务板 [backlog.md](backlog.md) 的 `ED-PARITY-004`，`p0.audit_id=AUDIT-20260913-01`，初录于 2026-09-15。

规划基线：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `2b2def51d75f9aee089279039946aa6957b258de`，接手时工作区 clean。
目标参照：**IDEA `2026.2.3 / IU-262.10968.63` Ultimate**（用户 2026-09-24 接受；隔离 config 采样方案见 runbook §4.0）。
本轮只做 P1 规划。**未运行任何产品测试、构建、Taomni/browser/native runner；未领取、未实现、未改产品代码。**

## 0. 本轮状态与未满足前置

| 项 | 状态 |
|---|---|
| 生产源码复核 | 完成（沿 action→store→IPC/provider→用户观察点） |
| 缺口分类 | 完成（缺陷 / 体验差异 / 能力缺失 / 待归因风险分列） |
| DEC / A1..A3 / V1..V5 / S0..S8 | 完成（本文件） |
| 完整用例设计 `test-cases` | 完成（本文件） |
| IDEA 真实参照采样 | **部分完成**（2026-09-24 18:07–18:11，13 张原件；决定性状态已观测） |
| 目标板状态 | `ready` + `p0.planning_required=false` |

**IDEA 采样结果（`IU-262.10968.63`，用户 2026-09-24 授权在运行实例上补采）：**
已完成 Keymap 页布局、动作行绑定呈现、行右键菜单、**快捷键录制器与 `Ctrl+F` 冲突提示**、录制器 Cancel、Settings Cancel 六组观察。
采样全程**只 Cancel、从未 OK/Apply**，采样前后 `%APPDATA%\JetBrains\IntelliJIdea2026.2` 均**无 `keymap*.xml`**，
**用户真实 keymap 未被改写**，IDEA 已回到采样前基线态。原件见[参照包](references/ed-parity-004-reference.md) §2。

**据此修正的设计决定：** 实测证明真实 IDEA 的冲突形态**不是**"提交后弹模态 + 重新指派/取消"，
而是**录制器内就地实时警告 + `Already assigned to:` + 全部冲突（含菜单路径、可滚动）+ `OK` 不阻断**。
DEC-02/03/04 已按此修正——若不采，本次规划会锁定一个与目标不符的 UI 形态。

**剩余未观测（不阻塞设计，属执行期证据）：** Apply 之后的生效/归属/重开状态、Reset 与删除 scheme 的确切标签、
键帽 chip 的精确几何、macOS/Linux、干净 IME 会话。补采步骤见参照包 §5/§6，
由 P2 在**隔离 config 实例**上补齐（避免再次触碰用户 profile）。

**目标 build：** 用户 2026-09-24 明确接受 **IDEA `2026.2.3 / IU-262.10968.63`** 作为本包参照
（取代 P0 初固定 build `IU-262.10315.125 (2026.2.2)`）。**所有 observed 一律标注 2026.2.3，不冒充 2026.2.2，
也不反向改钉其他卡的 build。**

## 1. 当前生产事实（HEAD `2b2def51` 逐符号核对）

状态 owner：`workspaceKeymapScheme.ts` 的 `KeymapSchemeV3`（localStorage，按 app profile）+ `WorkspaceActionHost` 的 `keymapScheme`。
无 Rust 侧、无 IPC、无 provider 参与本链路——这是纯 renderer + 持久化链路，这决定了 V1/V4/V5 的 browser 归属。

### 1.1 模型与持久化

- `KeymapSchemeV3` = `base`（`idea-windows-linux` | `idea-macos` | `null`）+ 用户增量 `bindings`（actionId → `Shortcut[]`）+
  `disabledActionIds`。物理键身份是 `KeyboardEvent.code` + 修饰位，`key` 仅作显示。
- 存储键 `taomni.codeWorkspace.keymap.v3:index` 与 `:active`（`KEYMAP_SCHEMES_INDEX_KEY` / `KEYMAP_ACTIVE_SCHEME_KEY`）。
- `readKeymapSchemes()` 解析失败时把原始载荷隔离到 `:corrupt-backup` 并置 `recoveredFromCorrupt=true`，**降级到默认绑定而不是抛错**。
- `setActionBindings` 传空数组时删除该 actionId 的条目（回到 base 继承）。

### 1.2 分发

- `WorkspaceActionHost.setKeymapScheme()`：换 scheme 会 `cancelPendingChord("scheme changed")` 并 `generation += 1`，
  这同时使所有在途 `PreparedActionEvaluation` 变为 `stale-owner`（已有 `executePrepared` 守卫）。**这是本卡的迟到/恢复语义基础。**
- `effectiveShortcuts()`：用户绑定优先，缺失时回落到 action 定义自带默认（`source` 为 `user` / `base`）。
- `prepareBinding()`：候选按 `availability === "available"` 排名；**两个及以上可用候选命中同一 stroke → `resolution: "conflict"`，不做数组序胜者**。
- 三个派发入口对 `conflict` 的消费行为**不一致**（见 §2 DEC-05）。

### 1.3 设置界面 `KeymapSettingsDialog.tsx`

- 720px × `max-h-[80vh]`，`data-testid="workspace-keymap-settings-dialog"`。
- 头部：scheme `<select data-testid="keymap-scheme-select">`、`Copy`、`Rename`、`Reset`、`Delete`、
  `data-testid="keymap-settings-close"`（X）。
- 行：`data-testid="keymap-row-<id>"`，快捷键胶囊 `keymap-replace-<id>-<index>`（点击=原地重录）、
  `keymap-add-<id>`（捕获）、删除 `×`、启用复选框 `Action <title> enabled`。
- 冲突**唯一**呈现：胶囊内 `<span aria-label="conflict">⚠</span>` + `title="Also used by: …"`。
- 捕获：window 捕获阶段 `keydown` 监听。Esc 取消捕获、Backspace 退一格、Enter 提交、纯修饰键忽略、
  `isReservedStroke`（裸 F5/F11/F12/Tab/Space）直接丢弃且**无任何提示**、最多 2 段。
- **无底部动作栏：没有 Apply、没有 Cancel、没有草稿。**

### 1.4 共享消费者

- `CodeWorkspaceTab.tsx:21192` 把 `actionsController.snapshot` 同时喂给 Keymap 设置与 Cheat Sheet（`21179`）。
- `KeymapCheatSheetDialog.tsx` 全文**零 conflict 处理**（grep 无命中）：它是「当前绑定了什么」的主展示面，引入冲突后不会给出任何标记。
- `CodeWorkspaceTab.tsx:15695 applyKeymapScheme` → upsert 到 `keymapSchemes`，必要时改 `activeKeymapSchemeId`
  → `useEffect` 写 localStorage + `host.setKeymapScheme(...)`。
- `debugEditorChrome.ts:149 debuggerKeymap` 是**独立的 CodeMirror keymap 通路**，不经过 `WorkspaceActionHost` 的 scheme。边界保留，非本卡 owner。
- `SqlEditorPanel.tsx` 也有 keymap 相关引用（`workspaceEditorCommands` 通路），属跨模块消费者，需保留断言。

## 2. 差距分类（互不混同）

### 2.1 已证实产品缺陷（可复现，非「缺证据」）

**D1 — 冲突在设置界面不可见，但派发层会拒绝。**
`KeymapSettingsDialog.effectiveForAction`（`KeymapSettingsDialog.tsx:64-88`）以**原始显示字符串**为 map key 建冲突表。
而显示串由 `WorkspaceActionHost.effectiveKeybindingDisplay()` 生成，用户录制绑定保留原始 `event.key`（如 `"f"`），
定义默认经 `parseDefinitionKeybindings()` 走 `parsed.key.toUpperCase()`（如 `"F"`）。于是：

| 动作 | 来源 | 生成的显示串 | 派发归一化后的 stroke |
|---|---|---|---|
| `editor.find` | base 默认 `Ctrl+f` | `Ctrl+F` | `{code:"KeyF", ctrl:true}` |
| `editor.replace`（用户录到 Ctrl+F） | user 绑定 | `Ctrl+f` | `{code:"KeyF", ctrl:true}` |

两串在 dialog 里是**不同 key** → `conflictsWith` 为空 → **不显示 ⚠**；
派发侧 `normalize()` 丢弃 `key` 并统一到 `code` → 两者相等 → `resolution:"conflict"`。
**结果：用户看不到任何警告，Ctrl+F 变成死键。** 这正是 CW-SET-002 与 P0「未实测改键与冲突」指向的核心序列。

**D2 — 没有 Cancel，改键即时落盘且不可撤销。**
`commitStrokes` / 删除 `×` / 启用复选框 / `Reset` 全部直接调用 `onApplyScheme(...)`（`KeymapSettingsDialog.tsx:107-126, 349-354, 395-398, 245`），
立即写入 localStorage 并作用于 live host。Esc 只能取消**尚未 Enter 的捕获**。用户一旦确认就**没有任何回退出口**。
同族的 `WorkspaceEditorAppearanceSettingsDialog`（`applyDraft` + `workspace-editor-appearance-cancel` + `-apply`）与
Editor Intelligence 设置已经建立了 draft→Apply/Cancel 契约（`TC-IDE-CW-UI-01` 正在断言它），**Keymap 是该家族里唯一没有的**。

**D3 — 冲突派发静默吞键，且三个入口行为不一致。**

| 入口 | `resolution === "conflict"` 时 | 用户可感知结果 |
|---|---|---|
| `dispatchKeydown`（window，`workspaceActionHost.ts:1015`） | `return null`，**不消费** | 事件继续冒泡，可能被浏览器/其他 handler 解释成别的操作 |
| `dispatchKeydownV2`（`:1096`） | `{kind:"rejected", reason:"conflict"}`，**不消费** | 同上，且调用方拿到一个无 UI 的拒绝 |
| `createCodeMirrorActionKeymap`（`workspaceCodeMirrorKeymap.ts:150-154`） | 候选在 editor allowlist 内 → `preventDefault()` + `return true` | **按键被吞掉，什么都没发生** |

三处都没有任何用户可见提示。同一份 scheme 数据在三个入口得到三种冲突语义。

### 2.2 体验差异（IDEA 2026.2.3 已实测确认）

- **冲突呈现形态**：IDEA 实测为**录制器内就地实时警告区**（`Already assigned to:` + ⚠，列出**全部**冲突动作
  **并带菜单路径**、可滚动），且 **`OK` 不阻断**。Taomni 现在只有 hover `title` + 一个 ⚠ 字形，
  且因 D1 的大小写分叉**在关键场景根本不显示**。
- **Apply/Cancel**：IDEA 实测底栏为 **OK / Cancel / Apply**，且**无改动时 `Apply` 禁用**；取消录制器或取消 Settings 都不产生持久化。
  Taomni **完全没有**（D2）。
- **绑定呈现**：IDEA 把组合键渲染成**多个独立键帽 chip 并右对齐**，多绑定用 `or` 连接，无绑定时留空；
  Taomni 是**单个 monospace 胶囊紧贴标题**，无绑定时显示 `no shortcut`。
- **编辑入口**：IDEA 用**行右键菜单**（Add Keyboard / Add Mouse / Add Abbreviation / Remove），
  且**默认绑定的 `Remove` 禁用**——只能覆盖不能就地删除；Taomni 任意胶囊可点 `×` 删除。
- **两段 chord**：IDEA 是 `Second stroke` **独立字段**；Taomni 是单捕获内最多 2 段。
- scheme 下拉：IDEA 显示**真实方案名 `Windows`**；Taomni 的 `IDEA defaults (default)` **只是标签**（P0 已记录）。

### 2.3 能力缺失

- 无「查找冲突并解绑」入口；用户只能靠 ⚠ 提示猜。
- 无批量查找/导出/导入 keymap（超出本卡边界，见 §7）。
- `isReservedStroke` 丢弃时无提示（列为 §5 保留断言，不在本卡扩大）。

### 2.4 待归因风险（**不得写成已复现缺陷**）

- **R1：** 冲突被解除后，先前在途的 `PreparedActionEvaluation` 是否真的安全丢弃。代码路径上 `setKeymapScheme` 递增 `generation`、
  `executePrepared` 校验 `hostGeneration` 并返回 `failed/stale-owner`，**静态看是安全的**；但「Apply 恰在动作执行中发生」从未被实测。
  按 [regression-protection](../../.agents/skills/qa-ui-auto/references/regression-protection.md)，
  这属于**待运行归因风险**，P2 必须先跑基线反例再决定是否新增修复。
- **R2：** 隐式 fork（`ensureMutableScheme`）在「默认 scheme + 草稿模型」下是否会遗留孤儿 scheme。若 P2 选择保留隐式 fork，需在 V4 断言不产生孤儿。

## 3. 决定（DEC）

- **DEC-01 范围**：本包只覆盖「一个已有动作的改键 → 冲突提示 → 取消/应用 → 重开」连续序列。
  不同时改版 Code Style、EditorConfig、auto-import、appearance（CW-SET-003 / CW-SET-001 仍属矩阵）。
- **DEC-02 冲突策略（用户裁决 + IDEA 2026.2.3 实测修正）**：**允许指派 + 就地实时冲突警告**。

  > **实测修正（2026-09-24，`IU-262.10968.63`）**：本轮设计初稿按"提交后弹模态 + `[重新指派]`/`[取消]`"两按钮设想，
  > 真实 IDEA **不弹独立模态**。冲突提示是**快捷键录制器内部的就地（inline）实时警告区**：
  > 文案 **`Already assigned to:`** + ⚠ 图标，随按键即时更新，**逐条列出全部冲突动作并带菜单路径**
  > （实测 `Ctrl+F` → `Speed Search in Other`、`Find... in Plugins | Markdown`，列表**可滚动**），
  > 且 **`OK` 始终可用——建议性警告，不阻断**。原样照搬"模态 + 重新指派按钮"会与目标不符，故按实测修正。

  落地形态：Taomni 的捕获控件内**常驻一个冲突区**（不是新弹窗），满足：
  1. 冲突按**派发同一套物理 stroke 身份**计算（见 DEC-06），必须覆盖 D1 的 `Ctrl+F`/`Ctrl+f` 分叉；
  2. 列出**全部**冲突动作（非仅首个），每条带**动作标题 + id**（Taomni 无菜单路径层级，用 id 承担定位职责）；
  3. 冲突项**可滚动**而非截断；
  4. **不阻断录入**——确认后照常写入（对齐 IDEA 的 advisory 语义）。
- **DEC-03 唯一提交边界 = Apply**：Keymap 设置改为**草稿模型**，与同族 appearance/intelligence 对话框一致，
  并与 IDEA 实测的 **OK / Cancel / Apply** 底栏一致（IDEA 实测：无改动时 **`Apply` 禁用**）。
  所有编辑（改键、删除快捷键、启用/禁用、Reset）只改本地草稿；**只有 Apply/OK 才写 localStorage 并作用于 live host**；
  Cancel / Esc / 遮罩点击 / X 全部等价于「丢弃草稿」，live 有效绑定与存储字节**逐字节不变**。
- **DEC-04 确认后原占用者必须失去该 chord（消除死键）**：IDEA **没有**"重新指派"按钮——`OK` 直接通过，
  原占用者**直接失去该 chord**。Taomni 对齐同一**结果语义**：确认并 Apply 后，
  从占用者的绑定集合中移除该 stroke，使其可见地变为 `no shortcut`；
  该 chord 的可用候选**恰好为 1**，派发必须真的执行目标动作。这是对 D1/D3 的根因修复，而不是加一个提示。
- **DEC-05 统一冲突派发语义**：`conflict` 在三个入口必须**一致地不执行目标动作、且不静默吞键**。
  目标：冲突态在有可用 UI 承载时通过 `KeyDispatchResult`/rejected 分支交给上层呈现；
  editor allowlist 内的 `preventDefault()+return true` 保留（避免死键被 CodeMirror 解释成别的编辑），但**必须伴随一个可观察的拒绝信号**，
  而不是当前的静默丢弃。三个入口的差异要在测试中断言，不允许"顺手统一"后不测。
- **DEC-06 冲突计算下沉到模型层**：新增纯函数（`workspaceKeymapScheme.ts`）
  `findStrokeConflicts(scheme, baseBindings)` 与 `displaceStroke(scheme, actionId, stroke)`，
  匹配身份复用与派发**同一套归一化**（`code` + 修饰位，丢弃 `key`），可用性过滤复用
  `getSnapshot` 已有的 `bindingIdentity`/`parseKeybinding` 归一化。
  **`KeymapSettingsDialog` 不再自建字符串冲突表**，`WorkspaceActionHost.getBindingDiagnostics()` 仍是 host 侧权威出口。
  这一条同时消除 D1 的根因。
- **DEC-07 保留草稿家族视觉契约**：沿用 `w-[min(700px,calc(100vw-32px))]`–`720px` 量级、
  `max-h-[80vh]`、`--taomni-code-*` 颜色角色、`h-10` 头部与 2px 分隔、`text-[11px]`/`text-xs` 密度行、
  焦点环沿用 `--taomni-code-accent`。底部动作栏与 `WorkspaceEditorAppearanceSettingsDialog` 同构（右对齐、Cancel 在 Apply 左）。
  720px 宽 + 动作列表已足够容纳捕获内冲突区所列的动作全名与 id；窄窗沿用 `max-w-[calc(100vw-32px)]` 收缩，不新增断点。
- **DEC-08 保留的既有能力（UI 重构授权不覆盖）**：默认 scheme 隐式 fork、Reset/Delete 语义、
  corrupt 隔离降级、user-disabled 在 Search/Keymap 仍可见、纯代码匹配（`code` 优先 `key`）、
  裸 F5/F11/F12/Tab/Space 不可绑定、`EDITOR_RETAINED_BINDING_ALLOWLIST` 六族理由、
  `debugEditorChrome.debuggerKeymap` 独立通路、Shell 已交付的 `Control+Shift+N` / `Control+Alt+/`。
- **DEC-09 不做全仓 build gate**：本卡是 renderer + 持久化改动，scoped typecheck 即可；
  完整仓构建/集成由本板专属集成卡承担（沿用 ED-PARITY-001/002/003 的处理方式）。

## 4. 目标用户结果

用户在 Keymap 设置里把一个动作改到一个已被占用的组合键上时：**先看到指名占用者的冲突提示并可取消**；
确认并 Apply 后**该组合键只有一个主人**；不确认就不会有任何生效变化。
只有点了 Apply，改动才落地并立刻可被真实按键派发；关掉对话框再打开读到的就是生效值。
不 Apply 就关闭，live 行为与存储字节与打开前完全一致。

## 5. 验收（AC）

### ED-PARITY-004-A1 — 冲突可见、Cancel 零改变、Apply 后真实派发、重开可读

1. 对一条已被占用的 chord 完成录制后，**捕获控件内常驻的冲突区立即出现**（对齐 IDEA 的 inline 实时警告，
   而非新弹模态）：⚠ 标记 + **`Already assigned to:`** 语义 + **逐条列出全部**占用该 chord 的动作
   （每条带动作标题 + id），冲突项**可滚动而非截断**。冲突判定基于物理 stroke 归一化，
   **必须能覆盖 D1 的「`Ctrl+F` vs `Ctrl+f`」大小写分叉**。
2. 冲突**不阻断录入**（对齐 IDEA：此时确认仍可提交）。选择取消后：冲突区清空、草稿恢复到捕获前的绑定、
   `onApplyScheme` 未被调用、live host scheme 引用未变、localStorage 字节未变。
   按新 chord 派发仍命中**原占用者**。
3. 确认并 Apply 后：该 chord 的可用候选**恰好为 1**，真实按键派发执行**目标动作**；
   原占用者在该行**可见地变为 `no shortcut`**，且不再由该 chord 触发。
4. Apply 是唯一提交边界：Apply 之前任何编辑都不改变 live 派发与持久化；Apply 之后新 chord 生效、旧 chord 不再命中该动作。
5. 关闭并重开设置对话框，读到的是 Apply 后的**有效**配置（含用户 scheme 名、原占用者失去该 chord 后的归属）。
6. 保留：未产生冲突的普通改键、删除快捷键、启用/禁用动作、Reset、Delete 的用户可观察结果不退化。

### ED-PARITY-004-A2 — 同 fixture 的 IDEA/Taomni 功能、视觉、交互分别有结论与准确证据身份

1. S2/S3/S4a/S4b/S5/S8 每一段在双侧都有**功能**结论，且各自带准确证据身份（build、窗口、run 目录、截图文件名）。
2. **视觉**：Keymap 页与捕获内冲突区/底栏动作的布局、密度、溢出/截断、颜色角色分别有结论；像素/字体/缩放不具备可比性时明确记为不可比较。
3. **交互**：焦点顺序、捕获流程（修饰键等待 / Backspace 退格 / Enter 确认 / Esc 取消）、冲突区的键盘与鼠标出口、
   遮罩点击与 Esc 的丢弃语义分别有结论。
4. 任一侧未采样、不可比或 runner 不支持时**显式标记缺口**；`matched` 的签发不得超过证据。
   **本轮该 AC 未满足（IDEA 侧未采样），不得声称通过。**

### ED-PARITY-004-A3 — 默认 scheme/迁移、Ctrl/Cmd 与 IME 边界、多 workspace owner、Shell 已交付快捷键

1. 默认 scheme（`activeSchemeId === null`）下首次编辑仍能通过隐式 fork 得到可写用户 scheme；
   Reset 把当前 scheme 还原为 base 继承，Delete 移除用户 scheme 并回到默认；corrupt 载荷仍被隔离且仍降级到可用默认。
2. Ctrl 与 Meta 保持物理区分：同一字母的 `Ctrl+X` 与 `Meta+X` 是两个不同 stroke（Windows/Linux），
   macOS base 为 `idea-macos`。本端（Windows/WebView2）须有执行性断言；macOS/Linux 记为未验证并给出步骤。
3. IME 合成期间（`isComposing` / `key === "Process"`）与 AltGr 期间：
   **既不能派发动作，也不能被录制成绑定**；合成字符必须正常落入编辑器。
4. 多 workspace owner：scheme 按 **app profile**（非 workspace 路径）存储，两个工作区标签**共享**同一 scheme——
   这是既有契约，保留且可观察；设置对话框读的是**当前实例**的 snapshot，写的是**全局** scheme，这一不对称必须显式断言，不得静默改变。
5. 保留：`Control+Shift+N`（Search Everywhere）与 `Control+Alt+/`（Cheat Sheet）继续可用；
   `debugEditorChrome.debuggerKeymap` 独立通路不变；裸 F5/F11/F12/Tab/Space 仍不可绑定；
   `EDITOR_RETAINED_BINDING_ALLOWLIST` 六族保留理由不变。

## 6. 验证（V）

| V | 覆盖 | 层次 | 说明 |
|---|---|---|---|
| V1 | A1.1–A1.4, A1.6 | unit + browser | 草稿隔离、捕获内冲突区、确认后消除死键、Apply 提交边界；纯 renderer，browser 充分 |
| V2 | A1.5 | browser（同会话重开）+ native（应用重启） | 重启读取需要真实 profile 生命周期，browser 不能证明 |
| V3 | A2.1–A2.4 | idea-comparison | 双侧对照；**本轮未执行**（IDEA 侧已部分采样） |
| V4 | A3.1, A3.2, A3.4, A3.5 | unit + browser | fork/Reset/Delete/corrupt、Ctrl vs Meta、共享 owner、Shell 快捷键、保留绑定 |
| V5 | A3.3 | browser（合成 composition）+ native（真实 IME） | 合成可 browser；真实 IME 必须 native 或记为未验证 |

## 7. 明确的范围外

Scheme 导入/导出、批量查找冲突、跨平台 scheme 同步、mouse shortcut 重录、Cheat Sheet 自身的 UI 改版、
Code Style / EditorConfig / auto-import（CW-SET-003 / CW-SET-001）、Shell 布局密度（CW-SET-001 归 REQ-03）。
这些留在矩阵，由 P0 增量产卡；本卡不静默扩大也不静默删除验收。

## 8. 文件与符号责任

| 文件 | 本卡责任 | 性质 |
|---|---|---|
| `src/components/editor/workspace/workspaceKeymapScheme.ts` | 新增 `findStrokeConflicts` / `displaceStroke` / stroke 归一化导出；不改存储键与 `KeymapSchemeV3` 形状 | 共享模型 |
| `src/components/editor/workspace/KeymapSettingsDialog.tsx` | 草稿状态、底部 OK/Cancel/Apply 动作栏、捕获内冲突区、冲突计算改用模型层 | 本卡主 owner |
| `src/components/editor/workspace/workspaceActionHost.ts` | `getBindingDiagnostics` 与派发归一化共用同一身份函数；DEC-05 的三入口冲突语义统一与可观察信号 | 共享 host |
| `src/components/editor/workspace/workspaceCodeMirrorKeymap.ts` | DEC-05 中 editor allowlist 冲突分支的拒绝信号 | 共享 host |
| `src/components/editor/workspace/KeymapCheatSheetDialog.tsx` | 消费同一 `snapshot`；冲突归属在主展示面可见（最小改动） | 共享消费者 |
| `src/components/editor/CodeWorkspaceTab.tsx` | `applyKeymapScheme` 的提交语义与 `onSchemesChange` 草稿回调接线 | 接线 |
| `src/components/editor/workspace/debugEditorChrome.ts` | **不改**；仅作为边界保留断言 | 边界 |

无 Rust、无 IPC、无 provider 变更。

### 8.1 共享消费者与保留断言

`KeymapCheatSheetDialog` 与 `workspaceKeymapRuntime`（inventory 断言）、`SqlEditorPanel`（`workspaceEditorCommands` 通路）、
`EditorGroup` 多视图与 `CodeMirrorHost` 的 allowlist 过滤，都会因绑定身份归一化而受影响——DEC-06 改的是**身份函数**，
因此这些消费者必须保留各自现有的执行性断言（`workspaceKeymapRuntime.test.ts` 的 4 条 inventory 用例、
`workspaceActionHostKeymap.test.ts` 的 5 条 scheme 用例）作为回归，不得在归一化重构中失效或被删除。

## 9. 连续场景 S0–S8

Fixture：**[F0](references/fixture-catalog.md)**（项目树与无 provider 的纯文本工作区，四个种子文件与 SHA-256 已在目录中固定）。
选 `editor.replace`（Replace in File，base 默认 `Ctrl+R`）为主角——TC-IDE-C1-01 已在用它，可复用准备；
冲突占用者选 `editor.find`（Find in File，base 默认 `Ctrl+F`），两者都在 editor allowlist 内，死键在编辑器里**可观察**。

| S | 步骤 | 决定性可观察结果 |
|---|---|---|
| S0 | 打开 Code Workspace → 添加目录 → 双击打开文件 → `Control+Shift+N` → Actions 页 → 搜 `Keymap Settings` → 打开 | 设置对话框可见；`editor.replace` 行显示 `Ctrl+R` |
| S1 | scheme 下拉保持 `IDEA defaults (default)`，点 `Copy` | 新用户 scheme 成为 active；**此时不产生任何绑定变更** |
| S2 | filter 输入 `Replace in File` → 点 `+ Add` → 按 `Alt+Shift+R` → `Enter` | 草稿行显示 `Alt+Shift+R`；**live 派发仍是 `Ctrl+R`**（草稿隔离） |
| S3 | 点 `Apply` | scheme 落盘；`Alt+Shift+R` 真的执行 Replace；`Ctrl+R` 不再命中 Replace；重开对话框读到 `Alt+Shift+R` |
| S4a | 再次对 `editor.replace` 录 `Ctrl+F` → `Enter` → 冲突区指名 `Find in File`；关闭后草稿回到 `Alt+Shift+R`；按 `Ctrl+F` 仍执行 **Find**；localStorage 字节不变 |
| S4b | 重新录 `Ctrl+F` → `Enter` → 确认 → `Apply` | `editor.replace` 独占 `Ctrl+F`；`editor.find` 行可见 `no shortcut`；`Ctrl+F` 执行 **Replace** |
| S5 | 改键后不 Apply，直接 `Esc` / 点遮罩 / 点 X | 对话框关闭；live 有效绑定与存储字节与打开前一致 |
| S6 | 保留回归：`Control+Shift+N`、`Control+Alt+/`、`Ctrl+Z`；`Ctrl+F` 现执行 Replace（**这是 S4b 的预期，不是回归**） | 三条 Shell/编辑快捷键仍可用；Undo 正常 |
| S7 | 焦点在 `keymap-action-filter` 输入框时按 `Ctrl+F` | 输入框得到字符 `f`（filter 生效），**不派发动作**；Cheat Sheet 搜索框同理 |
| S8 | `Reset` → `Apply` → 确认回到 base；再 `Delete` 用户 scheme | `editor.replace` 回到 `Ctrl+R`、`editor.find` 回到 `Ctrl+F`；删除后下拉回到 `IDEA defaults (default)` 且仍可改键 |

## 10. 测试用例设计

<a id="test-cases"></a>

> 本节是 P1 交付的**完整用例设计**。P1 不写 `qa-ui-auto-tests/cases/`、不跑测试。
> 下列标注 `P2 待实现` 的文件是**尚不存在的计划产物**，不是已有测试。
> 所有产品验证在本轮均为 **未执行**。

### 10.1 复用与新增总览

| 路径 | 状态 | 覆盖 | 说明 |
|---|---|---|---|
| `src/components/editor/workspace/KeymapSettingsDialog.test.tsx` | **已有，P2 扩展** | V1/V4 | 现有 4 例（两段式捕获、Backspace、Esc、原地替换）**必须保持通过**，是 DEC-08 的改前依据 |
| `src/components/editor/workspace/workspaceKeymapScheme.test.ts` | **已有，P2 扩展** | V1 | 新增冲突/位移纯函数用例 |
| `src/components/editor/workspace/workspaceActionHostKeymap.test.ts` | **已有，P2 保留** | V1/V4 | 5 条 scheme 用例作为 DEC-06 归一化重构的回归闸 |
| `src/components/editor/workspace/workspaceKeymapRuntime.test.ts` | **已有，P2 保留** | A3.5 | 4 条 inventory + `dispatchKeydownV2` 门禁（IME/dead-key/AltGr/冲突） |
| `qa-ui-auto-tests/cases/TC-IDE-C1-01-keymap-scheme-edit-and-conflict.testcase.yaml` | **已有，P2 改写** | S0/S1/S2/S3 | 现步骤只到「录制 + 关闭」；**其 `description` 声称 conflict 但步骤从未制造冲突**，需改为草稿/Apply 契约并修正描述 |
| `qa-ui-auto-tests/cases/TC-IDE-PARITY-004-01-keymap-rebind-apply-dispatch-browser.testcase.yaml` | **P2 待实现** | S2/S3/S5 | A1.4/A1.5 的 Apply 提交边界与重开读取 |
| `qa-ui-auto-tests/cases/TC-IDE-PARITY-004-02-keymap-conflict-reassign-cancel-browser.testcase.yaml` | **P2 待实现** | S4a/S4b | A1.1–A1.3，冲突区指名 + 取消/确认两出口 |
| `qa-ui-auto-tests/cases/TC-IDE-PARITY-004-03-keymap-reset-delete-input-protection-browser.testcase.yaml` | **P2 待实现** | S6/S7/S8 | A3.4/A3.5 + A1.6 保留行为 |
| `qa-ui-auto-tests/cases/TC-IDE-PARITY-004-04-keymap-persistence-across-app-restart-native.testcase.yaml` | **P2 待实现** | A1.5 | V2 native：真实重启后读取生效配置 |
| `qa-ui-auto-tests/cases/TC-IDE-CW-UI-01-settings-actions-browser.testcase.yaml` | **已有，P2 保留** | A3.5 | 同一 feature 家族（F25.5）的既有回归闸，不得因 Keymap 改版失效 |

### 10.2 覆盖维度矩阵

`AC/V | 维度 | 控件/Action/绑定 + 上下文 | 操作/预期 | case/test | 模式与 native 理由 | 结果/缺口`

#### UI

| AC/V | 维度 | 控件/Action/绑定 | 操作 / 预期 | case/test | 模式 | 结果 |
|---|---|---|---|---|---|---|
| A1.5 V1 | UI 布局/溢出 | `workspace-keymap-settings-dialog` 720px `max-h-80vh` | 打开；动作行标题/id/冲突徽标不互相遮挡 | TC-IDE-C1-01（改写） | browser | 未执行 |
| A1.1 V1 | UI 状态 | 冲突徽标 + 行内 `Also used by` | 制造冲突后**行内出现可见冲突标记**（不再仅 hover） | TC-IDE-PARITY-004-02 | browser | 未执行 |
| A1.1 V1 | UI 状态 | 捕获内冲突区（inline，非模态） | 出现；`Already assigned to:` 语义；列出全部占用动作标题+id；可滚动 | TC-IDE-PARITY-004-02 | browser | 未执行 |
| A1.4 V1 | UI 控件启用/禁用 | 底部 `Cancel` / `Apply` | 无草稿变更时 Apply 禁用；Cancel 恒可用 | TC-IDE-PARITY-004-01 | browser | 未执行 |
| A3.1 V4 | UI 空态/降级 | corrupt 横幅、`No matching actions.`、空 shortcut `no shortcut` | corrupt 横幅可见；filter 无命中显示空态；被夺走 chord 的行显示 `no shortcut` | unit（KeymapSettingsDialog.test.tsx）+ TC-IDE-PARITY-004-02 | browser | 未执行 |
| A2.2 V3 | 视觉 | Keymap 页 + 捕获内冲突区 + 底栏 | 双侧布局/密度/截断/颜色角色分别结论 | idea-comparison | IDEA 侧已采样 | **Taomni 侧未执行** |

#### Controls and interaction

| AC/V | 维度 | 控件 | 操作 / 预期 | case/test | 模式 | 结果 |
|---|---|---|---|---|---|---|
| S0 V1 | 入口 | `keymap-scheme-select` / `Copy` / `Rename` / `Reset` / `Delete` / `keymap-settings-close` | 逐个实际操作；断言打开/关闭/选中/焦点转移 | TC-IDE-C1-01（改写）、TC-IDE-PARITY-004-03 | browser | 未执行 |
| A1.1 V1 | 录入 | `keymap-add-<id>`、`keymap-replace-<id>-<index>`、`×`、启用复选框 | add 新增、replace 原地替换（索引语义）、`×` 删除、复选框禁用 | 既有 4 例 + TC-IDE-PARITY-004-02 | browser | 未执行 |
| A1.1 V1 | 校验/拒绝 | `isReservedStroke` | 录 F5/F11/F12/Tab/Space **不产生绑定** | unit（既有第 55 行）+ TC-IDE-PARITY-004-03 | browser | 未执行 |
| A3.3 V5 | 校验/拒绝 | 捕获期间 IME 合成 | 合成中的按键**不被录入** | unit + TC-IDE-PARITY-004-03（`compose_text`） | browser | 未执行 |
| S8 V4 | 恢复 | `Reset` / `Delete` | Reset→Apply 回 base；Delete 后回到默认且仍可编辑 | TC-IDE-PARITY-004-03 | browser | 未执行 |
| A1.2 V1 | 取消 | 捕获内 `Esc` / 底栏 Cancel / 遮罩点击 / `X` | 四条取消路径各自恢复草稿且零写入 | TC-IDE-PARITY-004-02 | browser | 未执行 |

#### Actions

| AC/V | 维度 | Action 入口 | 操作 / 预期 | case/test | 模式 | 结果 |
|---|---|---|---|---|---|---|
| S0 V1 | Actions 入口 | `workspace.keymapSettings` | 经 Search Everywhere **Actions 页**搜出并执行；不经菜单点击 | TC-IDE-C1-01（改写） | browser | 未执行 |
| A1.1 V1 | Action 派发 | `editor.replace`（新 chord） | Apply 后真实按键**执行 Replace** | TC-IDE-PARITY-004-01 | browser | 未执行 |
| A1.1 V1 | Action 派发 | `editor.find`（被夺 chord） | 确认并 Apply 后该 chord **不再**执行 Find | TC-IDE-PARITY-004-02 | browser | 未执行 |
| A1.4 V1 | Action 派发 | 旧 chord `Ctrl+R` | Apply 后不再命中 Replace | TC-IDE-PARITY-004-01 | browser | 未执行 |
| A3.4 V4 | Action 可用性 | user-disabled 动作 | 禁用后在 Search/Keymap **仍可见**且带 `Disabled in Keymap` | 既有 workspaceActionHostKeymap.test.ts:82 + unit | browser | 未执行 |
| A3.5 V4 | Action 入口 | `Control+Shift+N`、`Control+Alt+/` | 改键后仍可用 | TC-IDE-PARITY-004-03 | browser | 未执行 |
| S7 V4 | Action 上下文 | 焦点在 filter / Cheat Sheet 搜索框 | `Ctrl+F` 输入字符，**不派发** | TC-IDE-PARITY-004-03 | browser | 未执行 |

#### Shortcuts

| AC/V | 维度 | 绑定 | 操作 / 预期 | case/test | 模式 | 结果 |
|---|---|---|---|---|---|---|
| A1.3 V1 | 快捷键 冲突路由 | `Ctrl+F` 双占用 | 确认并 Apply 后可用候选**恰好 1**（`eval_readonly` 读 diagnostics 或断言真实效果） | TC-IDE-PARITY-004-02 | browser | 未执行 |
| A1.1 V1 | 快捷键 修饰 | `Alt+Shift+R` | 真实按下（含 Shift+Alt 组合）执行 Replace | TC-IDE-PARITY-004-01 | browser | 未执行 |
| A3.2 V4 | 快捷键 Ctrl/Meta 区分 | `Ctrl+X` vs `Meta+X` | 两者是不同 stroke；改其中一个不影响另一个 | unit（workspaceKeymapScheme.test.ts:42 扩展） | browser | 未执行 |
| A3.3 V5 | 快捷键 IME/AltGr 保护 | 合成中 / AltGr | 不派发、不录入、字符正常落入 | unit + `compose_text`；**真实 IME 另需 native** | browser（合成）/ native（真实 IME） | 未执行 |
| S7 V4 | 快捷键 输入框保护 | filter/搜索框内 `Ctrl+F` | 输入字符，不派发 | TC-IDE-PARITY-004-03 | browser | 未执行 |
| A1.1 V1 | 快捷键 重复触发 | 改键后连按新 chord 两次 | 动作各执行一次，无重复派发 | TC-IDE-PARITY-004-01 | browser | 未执行 |
| A3.5 V4 | 快捷键 保留绑定 | 裸 F5/F11/F12/Tab/Space | 仍不可绑定 | 既有 workspaceKeymapScheme.test.ts:55 + unit | browser | 未执行 |

#### Lifecycle and regression

| AC/V | 维度 | 场景 | 操作 / 预期 | case/test | 模式 | 结果 |
|---|---|---|---|---|---|---|
| S3 V1 | 连续操作 | 打开→改键→Apply→关闭→重开 | 重开读到生效配置 | TC-IDE-PARITY-004-01 | browser | 未执行 |
| S5 V1 | 取消/恢复 | 改键→不 Apply→四条关闭路径 | live 与存储不变 | TC-IDE-PARITY-004-01 | browser | 未执行 |
| A1.5 V2 | 重启恢复 | Apply→**重启应用**→重开 | 读到生效配置 | TC-IDE-PARITY-004-04 | **native**：应用 profile 生命周期与真实 localStorage 落盘，browser 无法证明重启后读取 | 未执行 |
| A3.1 V4 | 失败/降级 | corrupt 载荷 | 隔离 + 横幅 + 默认可用 | unit（既有第 78 行） | browser | 未执行 |
| A3.4 V4 | 共享消费者 | 两工作区标签 | 共享同一 scheme；对话框读实例 snapshot、写全局 scheme | unit + TC-IDE-PARITY-004-01 | browser | 未执行 |
| A3.5 V4 | 共享消费者 | Cheat Sheet | 同一 snapshot；冲突归属可见 | TC-IDE-PARITY-004-01 + 既有 TC-IDE-CW-UI-01 | browser | 未执行 |
| §2.4 R1 | 迟到/在途 | Apply 恰在动作执行中 | `stale-owner` 被拒绝、无半应用 | **P2 需先跑基线反例** | 视归因而定 | **待运行归因** |
| A3.5 V4 | 边界保留 | `debugEditorChrome.debuggerKeymap` | 独立通路不变 | 既有 debugEditorChrome.test.ts | browser | 未执行 |
| A2.1–3 V3 | 双侧比较 | S2/S3/S4a/S4b/S5/S8 | 功能/视觉/交互分别结论 + 证据身份 | idea-comparison | IDEA 侧已部分采样 | **Taomni 侧未执行** |

### 10.3 逐例执行说明

**TC-IDE-C1-01-keymap-scheme-edit-and-conflict（已有，P2 改写）**
- 保留 S0 全部入口步骤（welcome → tools → Code Workspace → 加目录 → 双击文件 → `Control+Shift+N` → Actions → Keymap Settings）。
- 修正 `description`：当前文本声称 conflict，但步骤从未制造冲突。改为如实描述「scheme 选择 + Copy + 草稿录制」。
- 尾部改为：录 `Alt+Shift+R` → `Enter` → 断言 `keymap-replace-editor.replace-0` 可见 → **点 `Apply`**（新控件）→ 断言对话框 detach。
- 层次/平台：browser；不引入 native 理由。
- 证据：`qa-ui-auto-report/ed-parity-004/run-*/TC-IDE-C1-01/summary.json` + receipt。

**TC-IDE-PARITY-004-01-keymap-rebind-apply-dispatch-browser（P2 待实现）**
- 准备：同 C1-01 的 S0–S1。
- S2：`keymap-add-editor.replace` → `press: Alt+Shift+R` → `press: Enter` → 断言草稿行可见新 swatch。
  **决定性断言：此刻 `Ctrl+R` 仍执行 Replace**（草稿未 Apply）。用 `press` + 编辑器可见结果判定，不用控件存在代替。
- S3：点 `keymap-settings-apply` → 对话框 detach → 焦点回编辑器 → `press: Alt+Shift+R` → Replace 面板打开 → `Esc` 关掉。
- S3b：`press: Control+R` → **断言 Replace 面板不再打开**（旧 chord 已解绑）。
- S3c：重开设置 → filter `Replace in File` → 断言 swatch 文本为 `Alt+Shift+R`（A1.5）。
- S5：在草稿状态下分别用 `Esc`、遮罩点击、`keymap-settings-close` 关闭 → 断言 live 仍按 S3 生效。
- 重复触发：连按两次 `Alt+Shift+R`，断言 Replace 只被触发一次（`assert_count` 或面板不重复堆叠）。
- covers：`F25.5`（已有 feature，无需新建）；controls 需新增 `keymap-settings-apply`。
- 清理：`reset_db` + localStorage 隔离（沿用 `fixtures: [reset_db]`，Keymap 为 per-profile localStorage，需在 fixture 中显式隔离或每 worker 新 context）。

**TC-IDE-PARITY-004-02-keymap-conflict-reassign-cancel-browser（P2 待实现）**
- 准备：先执行 01 的 S0–S3（`editor.replace` 已在 `Alt+Shift+R`）。
- S4a：`keymap-add-editor.replace` → `press: Control+F` → `press: Enter` → 断言冲突区可见且**包含 `Find in File`**。
  决定性断言：此时 `press: Control+F` 在编辑器里**不做任何事也不报错**（D3 的当前症状，修复后应指向 Reassign 前的原占用者）。
  → 点 `[取消]` → 对话框关闭 → 断言 `editor.replace` swatch 仍是 `Alt+Shift+R`。
- S4a 恢复断言：`press: Control+F` → **Find 面板打开**（证明取消零改变）。
- S4b：重新录 `Control+F` → `Enter` → 确认 → `Apply`。
  决定性断言：filter `Find in File` → 该行显示 `no shortcut`；`press: Control+F` → **Replace 面板打开、Find 不打开**。
- D1 定向断言：制造冲突后，`editor.find` 与 `editor.replace` 行的冲突标记**同时**出现（覆盖 `Ctrl+F` vs `Ctrl+f` 大小写分叉）。
- 层次：browser。冲突判定、徽标、两出口、派发结果全部是 renderer + DOM 可判定。

**TC-IDE-PARITY-004-03-keymap-reset-delete-input-protection-browser（P2 待实现）**
- S7：`fill`/`type` 让 filter 聚焦 → `press: Control+F` → 断言 filter 值含 `f` 且 Replace 面板**未**打开。
  Cheat Sheet（`Control+Alt+/`）搜索框同样断言。
- S6：`Control+Shift+N` 仍打开 Search Everywhere；`Control+Alt+/` 仍开 Cheat Sheet；`Control+Z` 仍撤销。
- S8：`Reset` → `Apply` → filter 断言 `editor.replace` 回 `Ctrl+R`、`editor.find` 回 `Ctrl+F`，且 `press: Control+R` 重新执行 Replace。
  再 `Copy` → `Delete` → 断言下拉回到 `IDEA defaults (default)`，且此时 `+ Add` 仍可编辑（隐式 fork 未回归）。
- 保留：录 F5 → `Enter` → 断言**没有**新增 swatch（`assert_count` 不变）。
- 层次：browser。

**TC-IDE-PARITY-004-04-keymap-persistence-across-app-restart-native（P2 待实现）**
- 唯一 native 理由：**browser 不能证明真实 app profile 的 localStorage 跨进程重启存活**；这同时覆盖 Tauri WebView2 的 storage origin 与隔离 profile。
- 步骤：原生 Apply 改键 → 关闭应用 → 以同一隔离 profile 重启 → 重开设置 → 断言读到生效绑定 → `press` 新 chord 断言派发。
- `fixtures`：需 QA 隔离 profile（沿用 `com.taomni.app.qa` 隔离 APPDATA/LOCALAPPDATA 约定）。
- `native_platforms: [Windows]`（当前端）；macOS/Linux 记 unverified。

### 10.4 单元/组件用例（P2 写）

**`KeymapSettingsDialog.test.tsx`（扩展，保留现有 4 例）**
- 草稿隔离：改键后 `onApplyScheme` **未**被调用；点 Apply 后才被调用一次。
- 捕获内冲突区：录已占用 chord → Enter → 区出现并列出占用动作（含全部、可滚动）；取消/确认两个出口存在。
- 冲突取消：恢复捕获前草稿；`onApplyScheme` 调用数为 0。
- 确认后 Apply：`editor.find` 的 `bindings["editor.find"]` 不含该 stroke。
- Esc/遮罩/X：三条关闭路径都不调用 `onApplyScheme`。
- IME 合成：`fireEvent.keyDown` 带 `isComposing: true` → 不被录入。
- **前置反例（对应 D2/D3）：** 在 baseline 上先写一条会失败的用例——「Apply 前不产生 live 变更」与「确认后无死键」——确认它们在改前**确实失败**，再实现。这是 regression-protection 要求的「能暴露原错误的失败测试」。

**`workspaceKeymapScheme.test.ts`（扩展）**
- `findStrokeConflicts` 对 `Ctrl+F` vs `Ctrl+f` **判定为冲突**（D1 的定向回归）。
- `findStrokeConflicts` 忽略裸 F5/F11/F12/Tab/Space。
- `displaceStroke` 移除占用者该 stroke 且不动其余绑定。
- Ctrl/Meta 区分（同字母不同修饰为不同 stroke）。
- 保留既有 5 例。

**`workspaceActionHostKeymap.test.ts`（保留 + 扩展）**
- 保留既有 5 例不动。
- 新增：确认 Apply 后 `prepareBinding` 对该 chord 返回 `resolution:"single"` 且 `candidates.length === 1`（A1.3 的核心断言）。
- 新增：DEC-05 三入口在 `conflict` 下的消费/拒绝信号一致（针对 D3）。

### 10.5 证据种类与完成上限

- `required_evidence`（board metadata，本卡不变）：`code-audit`、`unit`、`typecheck`、`browser`、`native`、`idea-comparison`。
- 本卡 scoped typecheck（DEC-09）：
  `python .agents/skills/code-workspace-idea-task/scripts/typecheck_scope.py --path src/components/editor/workspace/KeymapSettingsDialog.tsx --path src/components/editor/workspace/workspaceKeymapScheme.ts --path src/components/editor/workspace/workspaceActionHost.ts --path src/components/editor/workspace/workspaceCodeMirrorKeymap.ts --path src/components/editor/workspace/KeymapCheatSheetDialog.tsx --path src/components/editor/CodeWorkspaceTab.tsx`
- **完成上限（不得越级声称）**：仅 L2 —— Windows 11 / WebView2、纯文本 F0 fixture、单一改键序列。
  不含 macOS/Linux native、真实 IME、像素级视觉对齐、scheme 导入导出、mouse shortcut 重录。
- 能力天花板表述：即使本卡 `done`，也**只关闭 CW-SET-002 的「改键/冲突/取消/应用/重开」首包**，
  不等于 CW-SET-002 整场景或 REQ-10 全域三维对齐。

## 11. 三端计划

| 平台 | 最小验证集合 | 状态 |
|---|---|---|
| Windows 11 / WebView2（本端） | TC-IDE-C1-01（改写）+ 三个 browser 新例 + TC-IDE-PARITY-004-04 native + scoped typecheck + 相关单测 | **未执行** |
| Linux / WebKitGTK | 同 browser 三例改 `Mod+X` 语义并核对 base scheme；native 需 X11 输入 | 未验证 |
| macOS / WKWebView | base 应为 `idea-macos`（`Meta` 而非 `Ctrl`），DEC-02/A3.2 的 Ctrl-vs-Meta 断言在 mac 上语义相反；native 需 WKWebView bridge | 未验证 |

`workspaceKeymapScheme` 按物理 `code` 匹配、`guessBase()` 按 `navigator.platform` 选 base，三端共用同一模型——
这是兼容性依据，但**不替代**逐端执行证据。

## 12. 参考

- IDEA 参照包（**`partially-observed`**）：[references/ed-parity-004-reference.md](references/ed-parity-004-reference.md)
- P2 交接：[handoff-p2-ed-parity-004.md](handoff-p2-ed-parity-004.md)
- 原始目标：[task-planning.md#ed-parity-004](task-planning.md#ed-parity-004)
- P0 需求：[overall-audit-plan-20260913.md#req-10](overall-audit-plan-20260913.md#req-10)
- 场景矩阵：[capability-matrix.md#cw-set-002](capability-matrix.md#cw-set-002)
- 历史只读来源：[shell-layout-2026.2.2-linux.md](references/shell-layout-2026.2.2-linux.md)（`r2-19/20/21`，仅证明 Settings/Keymap 入口存在）

---

## 13. P2 回填：AC → V → 实际测试 → 报告/断言

> 执行平台 **Windows 11 / WebView2**，模式 browser + native。
> 证据原件在 `qa-ui-auto-report/ed-parity-004/`（不入库）。
> 状态：`done`（当前端完成；macOS/Linux 记为未验证）。

### 13.1 实际用例与执行结果

| 用例 | 模式 | 覆盖 | 结果 | 报告 |
|---|---|---|---|---|
| `TC-IDE-C1-01`（改写） | browser | S0/S1、草稿录制、Apply 提交边界 | ✅ 16.5s | `ed-parity-004/final/run-20260924-225702-962488200` |
| `TC-IDE-PARITY-004-01` | browser | S2/S3/S3b/S3c/S5、A1.4/A1.5 | ✅ 23.7s | 同上 |
| `TC-IDE-PARITY-004-02` | browser | S4a/S4b、A1.1–A1.3 | ✅ 21.9s | 同上 |
| `TC-IDE-PARITY-004-03` | browser | S6/S7/S8、A1.6/A3.3/A3.4/A3.5 | ✅ 17.9s | 同上 |
| `TC-IDE-PARITY-004-04` | native | A1.5 V2：真实 webview 上下文重启后持久化 | ✅ 14.9s | `ed-parity-004/native/run-20260924-225629-154181200` |
| `TC-IDE-CW-UI-01-settings-actions-browser` | browser | 同 feature 家族保留回归闸（DEC-08） | ✅ 28.8s，93/93 步 | 同上 |

单测：`KeymapSettingsDialog.test.tsx`（4 保留例改写为 Apply 边界 + 10 例新增）、
`workspaceKeymapScheme.test.ts`（6 保留例 + 7 例新增）、
`workspaceActionHostKeymap.test.ts`（5 保留例 + 3 例新增），
连同 `workspaceKeymapRuntime.test.ts`、`KeymapCheatSheetDialog.test.tsx`、`workspaceActionHost.test.ts`、
`debugEditorChrome.test.ts` 合计 **59/59 通过**；`src/components/editor/workspace/` 全量 **2299/2300**，
唯一失败为**改前已存在**的 `CodeMirrorHost.completion-undo.test.tsx`（已用 stash 隔离生产改动复证）。
scoped typecheck（DEC-09 七个 owner 路径 + 三个测试文件）**0 错误 / 0 范围外错误**。

### 13.2 AC → V → 测试 → 报告

| AC | V | 关键断言（实际执行） | 结果 |
|---|---|---|---|
| A1.1 冲突可见 | V1 | 录制 `Ctrl+f` 后 `keymap-capture-conflicts` 出现且含 `Already assigned to:`、指名 `editor.find`（标题+id）；OK 在冲突态仍可用 | ✅ 004-02 R1（step 49–54） |
| A1.2 Cancel 零改变 | V1 | 取消录制后冲突区清空、草稿仍为 `Alt+Shift+R`、Apply 仍禁用、关闭后 `Ctrl+F` 仍执行 Find | ✅ 004-02 R2（step 55–64）、004-01 R4 |
| A1.3 确认后无死键 | V1 | 确认+Apply 后 `editor.find` 失去 `Ctrl+F`、冲突徽标清零、`Ctrl+F` 真实执行 Replace；单测断言 `prepareBinding` 返回 `single` 且候选恰好 1 | ✅ 004-02 R3/R4（step 79–91）、`workspaceActionHostKeymap.test.ts` |
| A1.4 Apply 唯一提交 | V1 | Apply 前存储无新 chord 且旧 chord 仍生效；Apply 后存储含新 chord 物理结构、新 chord 生效、旧 chord 不再命中 | ✅ 004-01 R1/R2（step 26–68） |
| A1.5 重开可读 | V1+V2 | 同会话重开读到 `Alt+Shift+R`；**native** 销毁并重建真实 webview 上下文后仍读到并生效 | ✅ 004-01 R3、004-04 R2/R3 |
| A1.6 保留行为 | V1 | Reset→Apply 回 `Ctrl+R` 并真实执行；Delete 后下拉回默认且仍可改键 | ✅ 004-03 R5/R6 |
| A2 双侧对照 | V3 | 记录 `docs-feature/.../references/ed-parity-004-comparison.json`，`compare_idea.py` exit 0，9 件原件 sha256 全部 verified | ⚠️ 结论 `unverified`（见 §13.4） |
| A3.1 fork/Reset/Delete/corrupt | V4 | Reset/Delete/默认回退实测；corrupt 隔离与空数组覆盖往返由 `workspaceKeymapScheme.test.ts` 覆盖 | ✅ 004-03 R5/R6 + 单测 |
| A3.2 Ctrl vs Meta | V4 | 单测断言 `ctrl+KeyX` 与 `meta+KeyX` 是不同 identity；`Alt+Shift+R` / `Ctrl+F` 实机派发 | ✅ `workspaceKeymapScheme.test.ts` + 004-01/02 |
| A3.3 IME/AltGr | V5 | 合成期间录制器捕获 0 stroke；`isComposing`/`Process`/`Dead`/AltGr 一律不录入 | ✅ 004-03 R3（step 55–62）+ 单测 |
| A3.4 user-disabled 仍可见 | V4 | 取消勾选后该行仍显示并带 `Disabled in Keymap` | ✅ 004-03 R4（step 65–66） |
| A3.5 保留绑定与 Shell 快捷键 | V4 | `Control+Shift+N`/`Control+Alt+/`/`Ctrl+Z` 可用；裸 F5 不可绑定；`debugEditorChrome.test.ts` 不变 | ✅ 004-03 R1/R3 + `debugEditorChrome.test.ts` |

### 13.3 本轮相对 P1 设计的两处事实修正

1. **A1.3 的字面预期「原占用者可见地变为 `no shortcut`」在本 fixture 不成立**：
   `editor.find` 的 base 绑定是 `Ctrl+F` **与** `Meta+F` 两条。DEC-04 撤销的是**被争夺的那一个 stroke**，
   因此重新指派后该行显示 `Meta+F` 而不是空。`Ctrl+F` 确实从该行消失、全局冲突徽标清零、
   真实按键 `Ctrl+F` 只执行 Replace——A1.3 的实质目标（该 chord 可用候选恰好为 1）完全达成。
   `004-02` 断言的是「`Ctrl+F` 不在该行 + `Meta+F` 仍在」，并显式记录该修正。
2. **DEC-03 的 Apply 不关闭对话框**：真实 IDEA 2026.2.3 的 Settings 在 Apply 后保持打开、仅 OK 关闭
   （参照包 §3.1/§3.5）。P1 写的「点 Apply → 对话框 detach」与目标不符，本轮按实测修正为
   「Apply 保持打开、OK 关闭」。

### 13.4 诚实的缺口

| 缺口 | 状态 | 依据 / 后续 |
|---|---|---|
| IDEA 侧 Apply/OK 之后的状态 | **未观测** | 2026-09-24 采样全程只 Cancel，从未写过 `keymap*.xml`；参照包 §5/§6.1 给出隔离实例补采步骤 |
| IDEA 侧 Copy / Reset / Delete 标签 | **未观测** | 同上；故对照记录只能签 `unverified`，不得签 `matched` |
| 键帽 chip 精确几何 / DPI | **不可比较** | 参照包 §5；像素级对齐不在本卡完成上限内 |
| macOS / Linux | **未验证** | 本轮仅 Windows 11 / WebView2。模型层按物理 `code` 匹配、`guessBase()` 按 `navigator.platform` 选 base，三端共用同一实现，但需在 macOS (`idea-macos`, Meta 语义) 与 Linux/WebKitGTK 上重跑 004-01..04 的 native 版本 |
| 真实 IME 引擎会话 | **未验证** | browser 合成事件不能替代真实 IME；参照包 §5 已登记 |
| 既有 `CodeMirrorHost.completion-undo.test.tsx` 失败 | **改前已存在** | 已用 `git stash` 隔离本卡生产改动复证同样失败；不在本卡范围，未修复 |
| Search Everywhere 冻结评估可能 stale | **既有、非本卡引入** | 工程目录摄食期间动作目录重注册会使面板内的冻结评估变成 `stale-owner`，第 4 次打开对话框在长用例中偶发失效；`TC-IDE-PARITY-004-03` 已改为不依赖第 4 次打开。该问题属 action 目录/快照生命周期，未在本卡扩大范围 |
