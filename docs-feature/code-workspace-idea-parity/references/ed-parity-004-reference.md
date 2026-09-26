# ED-PARITY-004 IDEA 参照与补采 runbook

<a id="ed-parity-004-reference"></a>

**status: `partially-observed`** — 2026-09-24 18:07–18:11 完成一次真实桌面采样，**关键决策状态已观测**；
「Apply 之后」的一组状态未观测（需真实写入 keymap，见 §5）。本文件不含任何推测或伪造观察。

## 1. 目标与版本裁决

| 项 | 值 | 来源 |
|---|---|---|
| 产品 | IntelliJ IDEA Ultimate | `product-info.json` `productCode=IU` |
| 版本 | **2026.2.3** | `product-info.json` `version` |
| build | **IU-262.10968.63** | `product-info.json` `buildNumber` |
| 安装根 | `C:\Software\ideaIU-2026.2.3.win` | 进程可执行文件路径 |
| 配置目录 | `%APPDATA%\JetBrains\IntelliJIdea2026.2` | `dataDirectoryName` |
| 采样宿主 | Windows 11 (win32)，1870×982 虚拟屏幕 | `SystemInformation.VirtualScreen` |
| 采样工程 | `demo-sms`（`C:\Users\yuhan\demo-sms`），**与本场景无关**，仅作 IDE 宿主 |
| 主题 / UI | 深色（New UI，2026.2 布局） | 原图目视 |
| 当前 keymap | **`Windows`**（下拉显示值，真实方案名） | 原图 |
| 自定义 keymap | **无**——采样前后 `%APPDATA%\...\IntelliJIdea2026.2` 下**不存在任何 `keymap*.xml`** | 目录枚举 |

**版本裁决（用户 2026-09-24 明确接受）：** 以 `2026.2.3 / IU-262.10968.63` 为本包目标参照。
P0 初固定的是 `IU-262.10315.125 (2026.2.2)`；二者同属 2026.2 线，本包 observed 一律标注 2026.2.3，
**不冒充 2026.2.2，也不反向改钉其他卡的 build**。

## 2. 采样过程与工件

原始截图（被忽略、不入库）：`qa-ui-auto-report/idea-reference/ed-parity-004/20260924/`

| 原件 | 内容 |
|---|---|
| `00-before.png` | 采样前桌面（前台为终端，IDEA 未置前） |
| `01-idea-foreground.png` | 置前后 IDEA 基线态 |
| `02-settings-opened.png` | Settings 打开（`loading…`；底部已见 OK/Cancel/Apply） |
| `03-settings-loaded.png` | Settings 加载完成（Deployment 页；**Apply 禁用**） |
| `04-keymap-page.png` | **Keymap 页完整布局** |
| `05-search-replace.png` | ⚠ **作废**：输入污染，见 §2.1 |
| `06-search-replace-clean.png` | 搜索 `Replace` 的动作树与绑定 |
| `07-row-hover.png` | 行 hover（未显出内联控件） |
| `08-row-contextmenu.png` | **行右键菜单** |
| `09-shortcut-recorder-open.png` | **快捷键录制子对话框**（初值 `Ctrl+R`） |
| `10-conflict-ctrl-f.png` | **★ 冲突提示（本包决定性观察）** |
| `11-recorder-cancelled.png` | 录制器 Cancel 后（`Ctrl R` 保持、**Apply 仍禁用**） |
| `12-settings-cancelled.png` | Settings Cancel 后回到基线；**无 `keymap.xml` 落盘** |

### 2.1 输入污染与作废步骤（按 capture.md 丢弃）

`05-search-replace.png` 记录搜索框被输入成 `Replace¾File`——**空格在当前中文输入法/布局下被合成成 `¾`**，
并弹出候选窗（"1 File / 2 Filed / 3 Files…"），面板显示 `Nothing to show`。

判定：该 `Nothing to show` **是本轮输入污染的产物，不是 IDEA 行为**，已丢弃，不作为任何结论依据。
处置：`Esc` 关闭候选窗 → `Ctrl+A` + `Delete` 清空 → 改用**无空格**查询 `Replace` 重采（`06`），结果有效。

**采样纪律（写入 runbook 供后续复用）：** 在中文 IME 激活的宿主上，`SendKeys` 注入空格会产生 `¾` 等错误字符
并拉起候选窗；**查询一律避免空格**，输入后必须截图确认字符正确再采下一步。

另记录一次焦点干扰：`02` 采样瞬间有第三方 `HP System Information` OS 窗口抢前台（HP 服务 `hub-service-hp-ide`），
自行关闭后 `Settings – demo-sms` 成为前台并已逐步复核焦点，未污染后续观察。

### 2.2 采样手法与副作用控制

- 输入：`keybd_event` 真实扫描码（Ctrl+Alt+S / Ctrl+F）；点击：`SetCursorPos` + `mouse_event`（含右键）。
- 每次注入前把目标窗口置前并截图复核（`SetForegroundWindow` + `GetForegroundWindow` 比对句柄）。
- **未使用隔离 config**：用户已有运行实例且明确要求补采，故在运行实例上采样。
- **副作用控制**：全程**只 Cancel、从未点击 OK 或 Apply**。采样前后 `%APPDATA%\JetBrains\IntelliJIdea2026.2`
  均**无 `keymap*.xml`**，即**用户真实 keymap 未被改写**，IDEA 已回到 `01` 的原始基线态。

## 3. 真实观察（`observed`）

> 以下均为 `IU-262.10968.63` / Windows / keymap `Windows` / 深色主题下的实际截图所见。

### 3.1 Keymap 页布局（`04`）

- 页面标题 **Keymap**。
- 方案下拉显示 **`Windows`**；其右侧有**齿轮图标**（方案管理入口）。
- 链接 `Get more keymaps in Settings | Plugins`。
- 动作树工具条：展开/折叠图标 + 铅笔图标；右侧为动作搜索框与一个**人形图标**（"仅显示适用项"过滤）。
- 动作树按组分类（实测可见）：`Editor Actions`、`Main Menu`、`Tool Windows`、`External Tools`、
  `External Build Systems`、`Version Control Systems`、`Remote External Tools`、`Debugger Actions`、
  `Database`、`Macros`、`Intentions`、`Quick Lists`、`Plugins`、`Other`。
- **底部动作栏：`OK` | `Cancel` | `Apply`**，左下角 `?` 帮助。
  **未修改状态下 `Apply` 为禁用（灰）**（`03`/`04`/`11` 均可证）。
- 结论：IDEA Keymap 页**存在 OK/Cancel/Apply 草稿提交语义**，与 Taomni Keymap（无 Apply/Cancel）不同。

### 3.2 动作行与绑定呈现（`06`/`07`）

搜索 `Replace` 实测：

| 动作（含路径） | 绑定呈现 |
|---|---|
| Choose Lookup Item Replace | `Tab` |
| **Replace...** in `Main Menu \| Edit \| Find` | **`Ctrl` `R`** |
| Find Next / Move to Next Occurrence | `F3` **or** `Ctrl` `L` |
| Find Previous / Move to Previous Occurrence | `Shift` `F3` **or** `Ctrl` `Shift` `L` |
| Replace in Files... | `Ctrl` `Shift` `R` |
| Replace Structurally... | *（无绑定）* |
| Introduce Constant... | `Ctrl` `Alt` `C` |
| Introduce Functional Parameter... | `Ctrl` `Alt` `Shift` `P` |

**关键视觉/交互事实：**

1. **IDEA 把一个组合键渲染成多个独立键帽 chip**（`Ctrl` 与 `R` 分开），`Ctrl`+`Shift`+`R` 为三个 chip。
   Taomni `KeymapSettingsDialog` 渲染成**单个 monospace 胶囊 `Ctrl+R`**，紧贴标题右侧。**这是明确的呈现差异。**
2. 绑定 chip **右对齐**于行内，与动作名之间留大段空白；Taomni 的胶囊紧随标题。
3. 同一动作可有**多个**绑定，用 `or` 连接（`F3 or Ctrl L`）；Taomni 以多个并列胶囊表示，无 `or` 语义分隔。
4. 无绑定时**留空**，不显示占位文案；Taomni 显示 `no shortcut`。
5. 行 hover 未出现内联编辑控件（`07`）；编辑入口是**右键菜单**。

### 3.3 行右键菜单（`08`）

对 `Replace...`（`Ctrl+R`）右键，菜单项依次为：

- **Add Keyboard Shortcut**
- **Add Mouse Shortcut**
- **Add Abbreviation**
- （分隔线）
- **Remove Ctrl+R** — **呈禁用/灰态**

结论：
- IDEA 的快捷键编辑入口是**右键菜单**，提供**键盘 / 鼠标 / 缩写**三类新增。
  Taomni 只有键盘 `+ Add`，**无 mouse 重录、无 abbreviation 概念**。
- **默认绑定不可就地删除**（`Remove` 禁用）——要改默认只能新增覆盖。
  这与 Taomni 可对任意胶囊点 `×` 直接删除不同。

### 3.4 ★ 快捷键录制器与冲突提示（`09`/`10`）—— 决定性观察

`Add Keyboard Shortcut` 打开一个**子对话框** `Keyboard Shortcut`：

- 标题下一行给出**动作全路径**：`Replace... in Main Menu | Edit | Find`。
- **第一段**输入框（聚焦态，蓝色描边）+ 右侧 `+` 按钮。
- **`Second stroke:`** 复选框 + 输入框 + `+` 按钮
  → **两段式 chord 是一等公民，两个独立字段**（对应 Taomni 的单字段两段捕获）。
- 下方警告区：⚠ 图标 + 文字 **`Already assigned to:`**，随按键**实时更新**。

**按下 `Ctrl+F` 后的实际冲突内容（`10`）：**

```
⚠ Already assigned to:
    Speed Search in Other
    Find... in Plugins | Markdown
    …（列表可滚动，右侧有滚动条，尚有未显示项）
```

**由此确定的冲突语义（本包核心）：**

| 问题 | 实测答案 |
|---|---|
| 是否弹冲突对话框？ | **不弹独立模态框**。冲突提示是**录制器内部的就地（inline）实时警告区** |
| 确切文案 | **`Already assigned to:`**（英文，附 ⚠ 图标） |
| 是否指名占用者？ | **是，且逐条列出全部冲突动作**，带**菜单路径**（`in Other`、`in Plugins \| Markdown`） |
| 冲突多于 2 个怎么办？ | **可滚动列表**，全部列出 |
| 阻断还是放行？ | **放行**——`OK` 始终**可用**。这是**建议性（advisory）警告，不是阻断** |
| 有"重新指派"按钮吗？ | **没有**。`OK` 直接通过；原占用者**直接失去该 chord** |
| 出口 | 录制器自带 **`OK` | `Cancel`**，左下 `?` |

**结论：用户本轮裁决的「IDEA 式：允许 + 立即冲突提示」被实测证实**，但**形态需修正**——
真实形态是**录制器内就地实时警告 + 允许通过**，而非"提交后弹模态 + 重新指派/取消两按钮"。
见设计 [DEC-02](../keymap-rebind-conflict-plan.md)。

### 3.5 取消语义（`11`/`12`）

- **录制器 `Cancel`**：子对话框关闭，`Replace...` 行**仍为 `Ctrl` `R`**，Settings 底部 **`Apply` 仍禁用**
  → 录制器取消**完全不产生待提交变更**。
- **Settings `Cancel`**：整个对话框关闭，回到 `01` 的基线态；**未生成 `keymap.xml`**，无任何持久化。
  → 未 Apply 的改动**不落盘**。

## 4. 与 Taomni 的对照结论（功能层）

| 维度 | IDEA 2026.2.3（实测） | Taomni 当前（源码复核，HEAD `2b2def51`） | 结论 |
|---|---|---|---|
| 提交语义 | OK / Cancel / **Apply**，Apply 未改动时禁用 | **无 Apply/Cancel**，改键即时写 localStorage 并作用于 live host | **差异（D2 已证实）** |
| 冲突检测 | 录制器内就地实时、基于派发同一身份 | 设置页按**显示字符串**建表，`Ctrl+F`/`Ctrl+f` 分叉 → 徽标不出现 | **差异（D1 已证实）** |
| 冲突信息 | 列出**全部**冲突动作 + 菜单路径，可滚动 | ⚠ 字形 + `title="Also used by: …"` hover | **差异（信息量）** |
| 冲突是否阻断 | 否，`OK` 始终可用 | 落盘成功但**运行时静默拒绝**，产生死键 | **差异（D3 已证实，最严重）** |
| 冲突后归属 | 原占用者直接失去该 chord | 两个动作同时持有，派发层 `resolution:"conflict"` 全拒 | **差异（死键）** |
| 两段 chord | `Second stroke` 独立字段 | 单捕获内最多 2 段 + Backspace 退格 | 近似，**Taomni 无独立第二段字段** |
| 默认绑定删除 | `Remove` 禁用，只能覆盖 | 任意胶囊可点 `×` 删除 | **差异** |
| 鼠标/缩写 | Add Mouse Shortcut / Add Abbreviation | 无 | **能力缺失**（本卡范围外） |
| 绑定呈现 | 多个键帽 chip、右对齐、`or` 连接 | 单 monospace 胶囊、紧邻标题 | **视觉/交互差异（A2.2）** |
| 方案名 | 真实方案名 `Windows` | 固定标签 `IDEA defaults (default)` | **差异（P0 已记录，标签≠真实方案）** |

## 5. 明确未观测项（诚实缺口）

| 观察 | 为何未采 | 影响 | 补采步骤 |
|---|---|---|---|
| **Apply 之后的生效状态** | Apply 会**真实写入用户 keymap**；本轮以"只 Cancel"原则保护用户配置 | A1.3 / A1.4 的 IDEA 侧结果锚点 | 在**隔离 config** 实例上按 `§6.1` 启动后执行：录 `Ctrl+F`→`OK`→Settings `Apply`→观察行归属→重开读回→`§6.2` 还原 |
| **重新指派后原占用者的行显示** | 同上（同一次 Apply 的后续状态） | A1.3 | 同上 |
| **Apply 后重开读回** | 同上 | A1.5 | 同上 |
| **Reset / 删除 scheme 的真实标签与可删性** | 需进入齿轮方案管理并执行破坏性操作 | A1.6 保留断言 | 同上，齿轮菜单内采样 |
| **键帽 chip 的精确几何/间距/DPI** | 当前为缩放后截图，未取客户区/DPR 精确值 | A2.2 像素级（**本包不要求**） | 记客户区矩形 + DPR 后重采 |
| macOS / Linux 平台修饰键与 base scheme | 当前端为 Windows | A3.2 | 另端采样 |
| 真实 IME 合成下的录制行为 | 本轮 IME 反而造成污染（§2.1），未获得干净样本 | A3.3 | 干净 IME 会话下重采 |

**这些缺口不阻塞设计**——DEC-02/03/04/05/06 的目标形态已由 §3 实测确定；
剩余项属**执行期证据**，由 P2 的 `idea-comparison` 环节在隔离实例上补齐。

## 6. 补采剩余项的步骤（隔离实例，勿在用户 profile 上做）

### 6.1 隔离启动

```powershell
& 'C:\Software\ideaIU-2026.2.3.win\bin\idea64.exe' `
  '-Didea.config.path=C:\code\person\taomni\qa-ui-auto-report\idea-reference\ed-parity-004\idea-config' `
  '-Didea.system.path=C:\code\person\taomni\qa-ui-auto-report\idea-reference\ed-parity-004\idea-system' `
  '-Didea.log.path=C:\code\person\taomni\qa-ui-auto-report\idea-reference\ed-parity-004\idea-log'
```

### 6.2 剩余序列与还原

1. Settings → Keymap，记录方案下拉初值（隔离实例应仍为 `Windows`）。
2. 右键 `Replace...` → `Add Keyboard Shortcut` → 按 `Ctrl+F` → 记 `Already assigned to:` 完整列表（可滚动，**逐条记录**）。
3. 点 `OK` → 观察动作行新绑定呈现（是否多 chip、是否 `or`）。
4. 点 Settings **`Apply`** → 记 Apply 后禁用态。
5. **关闭并重开 Settings → Keymap** → 记录读回值（A1.5）。
6. 齿轮菜单 → 记录 `Reset` / 删除 scheme 的确切标签与默认方案可否删除。
7. **还原**：删除自建 scheme 或 `Reset` 后 `Apply`，确认 `%APPDATA%` 对应隔离目录下 `keymap.xml` 被清除或回到空增量。

## 7. 可复用范围

- §1 版本与 profile、§3 的全部 `observed` 可被本包及同 build 的其他卡复用。
- §2.1 的 IME 污染经验、§2.2 的副作用控制手法应写入任何后续 IDEA 桌面采样的纪律。
- [shell-layout-2026.2.2-linux.md](shell-layout-2026.2.2-linux.md) 的 `r2-19/r2-20/r2-21` 只证明 Settings/Keymap 入口存在，
  build 为 2026.2.2，**不覆盖**本包任何观察，也不可与本包混用 build 声明。

## 8. 相关

- 设计：[keymap-rebind-conflict-plan.md](../keymap-rebind-conflict-plan.md)
- 需求：[REQ-10](../overall-audit-plan-20260913.md#req-10) / 场景：[CW-SET-002](../capability-matrix.md#cw-set-002)
- 交接：[handoff-p2-ed-parity-004.md](../handoff-p2-ed-parity-004.md)
