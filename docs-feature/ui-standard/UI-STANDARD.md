# Taomni UI 与交互统一规范（UI-STANDARD）

> 状态：v0.2（2026-11-20）。落点（本目录）与 lint 基线策略已确认，实施已拆分为任务，规则随任务逐步生效。落地与执行机制见同目录 [ENFORCEMENT.md](ENFORCEMENT.md)。
> 适用对象：所有为 Taomni 编写或修改前端 UI 的人和 agent。规则有稳定 ID，PR、设计文档、QA 用例都按 ID 引用。

## 0. 如何使用本规范

**0.1 规则级别与 ID**

- 规则 ID 形如 `UI-DLG-03`：`UI-<领域>-<序号>`。ID 一经发布不复用、不改义；废止时标记 `(废止)`。
- **MUST**：必须遵守，违反即缺陷；**SHOULD**：默认遵守，偏离需在 PR 说明理由；**MAY**：可选。
- 「验证」列：`U` 共享组件的挂载单元测试；`B` 浏览器 QA 用例；`L` 静态 lint；`N` 原生/人工；`R` 代码评审。

**0.2 适用顺序（冲突时由上到下）**

1. 平台与安全约束（`AGENTS.md`：macOS 快捷键、外部网络与下载、文件大小边界）。
2. 本规范。
3. 具体功能的设计文档。设计文档只能在「例外登记」（§9）中声明偏离，不能静默偏离。
4. 个人或某个 agent 的习惯写法。

**0.3 三条总原则**

1. **复用优先**：能用共享组件就不手写；手写必须符合同一规则。共享组件目录为 `src/components/ui/`（建设计划见 ENFORCEMENT §5），在其落地前以本文「现有实现」列指向的现有组件为准。
2. **每个控件必须完整可操作**：鼠标、键盘、焦点、禁用、忙碌、空、错误、溢出、深色主题、字号 10–18、中英文长文案，缺一视为未完成（见 §6 可操作性矩阵）。
3. **同一概念在所有模块只有一种长相和一种行为**：确认框、右键菜单、重命名、搜索框、复制反馈，不因模块或作者而异。

## 1. 现状基线（2026-11-17 静态扫描，近似值）

| 观察 | 数据 | 对应规则 |
|---|---|---|
| 设计令牌体系完整（`--taomni-*`，浅/深色），但有 25 个被引用却未定义的变量，如 `--taomni-hover-bg`(40 处)、`--taomni-error`(21)、`--taomni-danger`(9)；无 fallback 时悬停/状态样式静默失效 | `theme.css` | UI-FND-02 |
| 组件内硬编码十六进制色约 511 处；`bg-red-500`(59)、`bg-blue-500`(15) 等 Tailwind 调色板色替代语义色 | 组件 tsx | UI-FND-01 |
| 字号 `text-[10/11/12px]` 共约 2450 处；仅 `[role=dialog]`、SFTP、Git 面板有 `!important` 映射使其跟随「界面字号」（10–18），其他区域不随之缩放 | `chrome.css` | UI-FND-04 |
| z-index 出现 70+ 个不同取值（0 到 10001）；右键菜单 9999、确认框 950，层级关系靠运气 | 全局 | UI-FND-09 |
| 自绘遮罩弹窗约 97 个（`fixed inset-0`），遮罩透明度有 30/40/45/50/60 与 `backdrop-blur` 多种；约 21 个弹窗没有 Esc 关闭；约 32 个遮罩弹层没有 `role="dialog"` | 全局 | UI-DLG-* |
| 仍在使用 `window.confirm/alert/prompt`：约 19 个文件（macOS WKWebView 会忽略，功能静默失效） | settings/lanchat/mail/session | UI-DLG-12 |
| 唯一的图标 Tooltip 方案是原生 `title`，约 1266 处；键盘焦点下不显示，也无法显示快捷键 | 全局 | UI-TIP-* |
| 约 260 个裸 `<button>` 未走 `taomni-btn`；主按钮样式三套并存（`taomni-accent`、`data-primary`、`taomni-btn-primary`），危险按钮多为 `bg-red-*` | 全局 | UI-BTN-* |
| 可点击 `div/span` 无角色无键盘处理约 12 处；`role="button"` 12 处中仅 1 处有 `tabIndex`；`role="switch"`、`role="grid"`、`role="tooltip"` 为 0 | 全局 | UI-A11Y-* |
| `outline-none` 约 98 处，不少没有替代焦点样式 | 全局 | UI-FOC-* |
| 94 个组件文件含中文字面量，绕过 i18n | 全局 | UI-I18N-* |
| 同一组件多种实现：Tab 栏（`taomni-tab`、`taomni-section-tab`、`tao-home-*`、各模块私有）、下拉菜单（`ContextMenu` 与 role=menu 的私有实现）、复选框（`taomni-checkbox` 48 处 vs 裸 `type="checkbox"` 197 处） | 全局 | UI-TAB / UI-MNU / UI-CHK |
| Tao Home 自带一套方言：独立 `--tao-*` 变量、圆角 5–16px、字号写死 px | `taoHome*.css` | §9 EXC-TAO |

**现有实现可复用（规范以其为基线）**：`.taomni-btn` / `.taomni-input` / `.taomni-checkbox` / `.taomni-radio` / `.taomni-pill` / `.taomni-tab` / `.taomni-tree-row` / `.taomni-scroll-y`；`ContextMenu` + `MenuSurface`（112 个文件使用，已含方向键、子菜单、焦点返回、视口钳制）；`ConfirmDialog` / `TextInputDialog` / `ChoiceDialog` / `AlertDialog` 与 `lib/appDialogs`（Promise 式 API）；`useFocusReturn`、`useModalShortcuts`、`useModalDraggable*`；`react-resizable-panels` v4；`lucide-react`；`useT` i18n。

## 2. 设计基础（Foundations）

### 2.1 颜色与主题

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FND-01 | MUST | 组件中颜色只能来自 `--taomni-*` 语义变量。禁止新增十六进制、`rgb()`、Tailwind 调色板色（`bg-red-500`、`text-blue-600`、`text-emerald-500` 等）。状态色用语义令牌：`danger / warning / success / info`（各含 `-bg`、`-border`、`-text`、`-icon`）。例外仅限 §9 登记的表面和语法高亮/终端调色板 | L |
| UI-FND-02 | MUST | 使用的每个 `var(--taomni-*)` 必须在 `theme.css` 中定义（浅色与深色都定义）。禁止依赖未定义变量静默回落。现存未定义变量迁移：`hover-bg`/`bg-hover` → `hover`；`border` → `divider`；`error` → `danger`；其余补定义 | L |
| UI-FND-03 | MUST | 新主题或自定义主题必须覆盖全部语义令牌；组件不得判断主题名（`data-app-theme`）来分支样式，只能靠令牌差异 | R |
| UI-FND-03a | MUST | 对比度：正文/图标对其背景 ≥ 4.5:1，控件边界与状态指示 ≥ 3:1；浅色和深色都要满足。不得仅用颜色表达状态，必须同时有图标、文字或形状 | B/N |
| UI-FND-03b | MUST | 强调色（`--taomni-accent`）只用于：主操作、选中态、焦点、链接、进度。不得用于装饰性大面积填充 | R |

必须新增的令牌（ENFORCEMENT §5 阶段 1 落地）：`--taomni-danger(-bg/-border/-text)`、`--taomni-info(...)`、`--taomni-overlay`（遮罩：浅 `rgba(0,0,0,.40)`、深 `rgba(0,0,0,.55)`）、`--taomni-focus-ring`、`--taomni-radius-sm/md/lg`、`--taomni-z-*`、`--taomni-fs-*`、`--taomni-control-h-sm/md`。

### 2.2 字体与文字

界面字号 `--taomni-ui-font-size` 默认 12px，用户可在 10–18 间调整。**所有布局必须在 10 与 18 两个端点下不溢出、不重叠。**

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FND-04 | MUST | 字号只用相对令牌：`--taomni-fs-caption`(−2)、`-small`(−1)、`-body`(0)、`-title`(+2)、`-heading`(+4)。新代码禁止 `text-[Npx]`；现有的 `[role=dialog]` 映射上升为全局映射 | L |
| UI-FND-05 | MUST | 字体族：界面用 `--taomni-ui-font-family`；代码、路径、主机名、命令、哈希、端口等「机器文本」用 `taomni-mono`。数字列用 `tabular-nums` | R |
| UI-FND-06 | MUST | 文本溢出：单行用 `truncate`（`min-w-0` 链完整），并在悬停和键盘焦点时可查看全文（Tooltip）；路径用中间省略；多行最多 N 行加 `line-clamp` 并提供展开。禁止出现被裁切且无法查看全文的文字 | B |
| UI-FND-07 | MUST | 错误信息、路径、日志、命令输出必须可选中、可复制；界面装饰文字（标签、按钮、标签页）`user-select: none` | B |
| UI-FND-07a | SHOULD | 标题层级：对话框标题 `-title` 半粗；区块标题 `-body` 半粗；说明与次要文字 `-small` + `--taomni-text-muted`。一个界面不超过 3 个字号层级 | R |

### 2.3 间距、密度与尺寸

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FND-08 | MUST | 间距使用 4px 栅格：2 / 4 / 6 / 8 / 12 / 16 / 24（Tailwind `0.5/1/1.5/2/3/4/6`）。同一表单行内元素间距 8，区块间距 16，对话框内边距 16 | R |
| UI-FND-08a | MUST | 控件高度只有两档：**sm = max(22px, 1em+6px)**（输入框、紧凑按钮、树/列表行）与 **md = max(26px, 1em+8px)**（默认按钮、对话框底栏）。工具栏图标按钮 24×24 点击区、标签页高 24、状态栏高 24。**同一行出现输入框与按钮时必须同档**；用 `max(px, 1em+k)` 写法保证随字号放大 | B |
| UI-FND-08b | MUST | 可点击目标的命中区域 ≥ 24×24 CSS px（图标本身可以更小，用内边距补足） | B |
| UI-FND-08c | MUST | 圆角只有四档：2（输入框、复选框）、3（按钮）、4（菜单、气泡、对话框、卡片、标签页顶部）、9999（胶囊、徽标、单选）。≥6 的圆角属于例外表面（§9） | L/R |

### 2.4 层级、阴影、动效

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FND-09 | MUST | z-index 只能使用令牌，自下而上：`content 0–99` < `sticky/rail 100` < `docked-overlay 500` < `popover 900` < `modal 1000` < `menu-over-modal 1100` < `tooltip 1150` < `toast 1200` < `blocking-gate 1300` < `drag-ghost 1400`。禁止裸数字（含 `z-[9999]`）。同层多个以 DOM 顺序区分，不用递增数字 | L |
| UI-FND-10 | MUST | 阴影只用 `--taomni-shadow-sm/md/lg`：卡片 sm、菜单/气泡 md、对话框 lg。禁止自定义 `box-shadow` | L |
| UI-FND-11 | MUST | 动效 ≤ 220ms，仅用于状态过渡（颜色、透明度、位移 ≤ 8px）；禁止悬停位移/缩放用于密集控件（`taomni-card-hover` 仅限首页启动卡片）；必须尊重 `prefers-reduced-motion`；`transition: all` 改为枚举属性 | R |
| UI-FND-12 | SHOULD | 加载动画统一用共享 Spinner；闪烁（`taomni-blink`）只用于光标 | R |

### 2.5 图标与插画

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-ICO-01 | MUST | 图标只用 `lucide-react`；禁止 emoji 当图标（如 `🗑 清空`）、禁止内联 SVG 手绘同义图标 | L |
| UI-ICO-02 | MUST | 尺寸：`w-3`(12) 仅用于徽标/行内；**`w-3.5`(14) 为默认**（按钮、行、工具栏）；`w-4`(16) 用于主导航与对话框标题；`w-5`(20) 用于空状态。禁止其他尺寸，禁止同一工具栏混用 | L/R |
| UI-ICO-03 | MUST | 同一概念全应用同一图标：关闭 `X`，新增 `Plus`，删除 `Trash2`，编辑 `Pencil`，搜索 `Search`，刷新 `RefreshCw`，设置 `Settings`，复制 `Copy`→成功 `Check`，更多 `MoreHorizontal`，展开/折叠 `ChevronRight/Down`，信息 `Info`，警告 `AlertTriangle`，错误 `AlertCircle`，成功 `CheckCircle2`，外链 `ExternalLink` | R |
| UI-ICO-04 | MUST | 图标颜色继承文字色（`currentColor`）；状态图标使用语义色；图标与文字间距 6 | R |
| UI-ICO-05 | MUST | 纯图标控件必须有 `aria-label` 与 Tooltip（UI-TIP-02）；图标+文字按钮不得再加 `aria-label` 覆盖文字 | L/B |

### 2.6 国际化与平台

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-I18N-01 | MUST | 所有用户可见字符串（含 placeholder、tooltip、`aria-label`、错误、校验信息、空状态、对话框按钮）走 `useT` 并同时提供 en 与 zh-CN；禁止在组件内写中文或英文字面量；禁止拼接翻译片段，用带参数的整句 | L |
| UI-I18N-02 | MUST | 文案按拉丁文本放大 40% 设计容器宽度；按钮不换行，用最小宽度 + 内边距，不用固定宽度 | B |
| UI-I18N-03 | MUST | 日期、数字、文件大小、相对时间经共享格式化函数，按应用语言输出；文件大小统一一个进制与单位写法 | R |
| UI-I18N-04 | MUST | `data-testid` 不本地化，使用稳定 kebab-case：`<feature>-<element>`；对话框内按钮后缀 `-confirm / -cancel / -close`（延续 `confirm-dialog-confirm`） | L/R |
| UI-PLAT-01 | MUST | 快捷键展示经唯一格式化函数：Windows/Linux `Ctrl+S`，macOS `⌘S`；不得手写字符串。遵循 `AGENTS.md` 的 macOS 约定 | U/R |
| UI-PLAT-02 | MUST | 不使用 `window.alert/confirm/prompt`（见 UI-DLG-12）；不假设自定义窗口控件（macOS 用原生红绿灯与应用菜单） | L/N |

## 3. 控件规范

每个控件给出：现有实现、必备状态与行为、键盘、禁止项。「状态」默认包含 default / hover / active(pressed) / focus-visible / disabled，其他按需列出。

### 3.1 按钮（Button）

现有实现：`.taomni-btn`（`data-primary="true"` 为主按钮）。

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-BTN-01 | MUST | 只有五种变体：**default**（次要）、**primary**（`data-primary`，每个视图/对话框最多一个）、**danger**（`data-danger`，破坏性）、**ghost/toolbar**（无边框，悬停出底色）、**link**（行内链接式）。禁止在组件里重新拼 `bg-[var(--taomni-accent)] text-white` 或 `bg-red-*` | L |
| UI-BTN-02 | MUST | 所有 `<button>` 必须写 `type`（默认 `button`，提交才 `submit`）；可点击的非按钮元素必须改成 `<button>`（UI-A11Y-01） | L |
| UI-BTN-03 | MUST | 状态：hover 变底色；active 加深；`:focus-visible` 显示焦点环（UI-FOC-01）；**disabled 必须保持可见并说明原因**（Tooltip 或旁边提示一行），不得无声置灰 | B |
| UI-BTN-04 | MUST | 异步操作按钮进入 **busy**：显示 Spinner、`aria-busy="true"`、禁用重复点击，文字保持；完成后恢复；失败后在就近位置显示错误 | B |
| UI-BTN-05 | MUST | 文案：动词开头，写明对象（「删除 3 个会话」「连接」「保存」），禁止孤立的「确定」；需要进一步输入的操作加省略号（「重命名…」「导入…」） | R |
| UI-BTN-06 | MUST | 按钮组顺序：次要/辅助在左，**取消在主按钮左侧，主按钮最右**（所有平台一致）。「应用」介于取消与确定之间 | B |
| UI-BTN-07 | SHOULD | 图标按钮（工具栏）：24×24、14px 图标、ghost 变体；开关型使用 `aria-pressed` 并有选中底色；一组相关按钮之间不加边框，组间用 `taomni-divider-v` | R |
| UI-BTN-08 | MUST | **分裂按钮**（主动作 + 下拉）：主区域执行默认动作，箭头区打开菜单；两区各有独立焦点和提示 | B |
| UI-BTN-09 | MUST | **分段控件/互斥按钮组**（`tao-home-mode-segment` 之类）：必须有 `role="radiogroup"`/`radio` 或 `tablist`，方向键切换，选中态用 `aria-checked`/`aria-selected` | B |

### 3.2 文本输入（Input / Textarea / Search / Password / Number / Path）

现有实现：`.taomni-input`；搜索与密码保留原生清除/显示控件的策略（`base.css` 注释）继续有效。

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-INP-01 | MUST | 每个输入有可见标签或 `aria-label`；placeholder 只做示例，不能替代标签 | B |
| UI-INP-02 | MUST | 状态：default/hover/focus（边框 accent + 焦点环）/disabled（可见原因）/readonly（可选中可复制，非置灰）/invalid（danger 边框 + 就近错误文案，`aria-invalid` + `aria-describedby`） | B |
| UI-INP-03 | MUST | 搜索框：`type="search"`，使用平台原生清除，不自绘叠加；`Esc` 先清空内容，内容为空再交给上层（关闭搜索面板）；输入防抖 150ms；无结果显示空状态而不是空白 | B |
| UI-INP-04 | MUST | 密码：`type="password"`，使用平台原生显示控件；已保存密码以占位提示「已保存」而不是回填明文；不进日志 | B |
| UI-INP-05 | MUST | 数字：限定 `min/max/step`，越界时钳制并提示；允许空值的明确表达；滚轮不得在未聚焦时改值 | B |
| UI-INP-06 | MUST | **IME**：处理 Enter/Esc/方向键前必须检查 `event.isComposing` 或 `keyCode === 229`，输入法组词期间不得提交、关闭或移动选择 | B/N |
| UI-INP-07 | MUST | Enter：单行输入提交所在表单/触发默认动作；多行输入换行，`Ctrl/Cmd+Enter` 提交；Esc：取消编辑或交给上层关闭 | B |
| UI-INP-08 | MUST | 路径输入：文本框 + 「浏览…」按钮（原生选择器）；支持粘贴与拖入；异步校验存在性且带过期结果保护；展示用 `taomni-mono` | B |
| UI-INP-09 | SHOULD | 聚焦时全选的场景仅限重命名；普通输入聚焦保持光标位置。非凭据字段 `autoComplete="off"`、`spellCheck=false`（代码/主机/路径） | R |
| UI-INP-10 | MUST | 键盘组合键录入框（快捷键设置）：聚焦即录入，`Esc` 取消、`Backspace` 清除，显示冲突提示 | B |

### 3.3 选择类（Select / Combobox / Multi-select / Tag input）

现有实现：带箭头样式的原生 `select.taomni-input`（`<select>` 约 202 处）。

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-SEL-01 | MUST | 选项 ≤ 12 且无搜索/图标/分组需求：用原生 `select.taomni-input`。否则用共享 Combobox（`role="combobox"` + `listbox`/`option`，`aria-expanded`、`aria-activedescendant`） | R |
| UI-SEL-02 | MUST | Combobox 键盘：`↓/↑` 移动并打开、`Enter` 选择、`Esc` 关闭并保留原值、输入过滤、`Home/End`、Tab 离开时提交当前选项或还原（全应用一致取「还原」） | B |
| UI-SEL-03 | MUST | 列表项最小行高同 sm；当前项有勾选标记；禁用项可见并带原因；无结果显示「无匹配」行；长列表虚拟化时保持 `aria-setsize/posinset` | B |
| UI-SEL-04 | MUST | 多选与标签输入：每个标签可用 Backspace 删除、有删除按钮和 `aria-label`；允许粘贴分隔文本批量添加；去重并提示 | B |
| UI-SEL-05 | MUST | 下拉面板用共享 Popover：宽度 ≥ 触发器、视口内翻转、滚动/窗口缩放时重算或关闭，层级用 `popover` 令牌 | B |

### 3.4 复选、单选、开关

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-CHK-01 | MUST | 一律使用 `.taomni-checkbox` / `.taomni-radio`（或其共享封装），不使用裸 `type="checkbox"`（现存 197 处逐步迁移）；点击标签文本也切换；命中区域 ≥ 24px | L/B |
| UI-CHK-02 | MUST | 复选框支持 `indeterminate`（树/列表父级勾选），Space 切换，聚焦显示焦点环 | B |
| UI-CHK-03 | MUST | **立即生效**的开/关设置用 Switch（`role="switch"` + `aria-checked`）；**提交后才生效**的布尔值用复选框。同一页面不得混用两种语义 | R |
| UI-CHK-04 | MUST | 单选组：`role="radiogroup"`，方向键在组内移动并选中，Tab 只进入当前选中项；选项互斥时不得用复选框模拟 | B |
| UI-CHK-05 | MUST | 禁用项必须说明原因；依赖关系（勾选 A 才可用 B）要在 B 旁边写明 | B |

### 3.5 其他输入控件

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-OTH-01 | MUST | 滑块/步进：有可见当前值，`←/→`步进、`Shift` 十倍、`Home/End`；`role="slider"`，同时提供数值输入 | B |
| UI-OTH-02 | MUST | 取色、日期时间：使用平台原生控件或共享封装；值变化即时预览并可取消；键盘可达 | B |
| UI-OTH-03 | MUST | 文件/目录选择：只通过原生对话框（Tauri `plugin-dialog`）；浏览器预览模式给出明确降级提示，不得静默无反应 | B/N |
| UI-OTH-04 | MUST | 链接：`<a>` 或 link 变体按钮；外链先过共享打开函数；悬停状态栏/Tooltip 显示目标；键盘 Enter 可打开 | B |
| UI-OTH-05 | MUST | 键盘提示 `kbd`：统一用共享 `Kbd` 组件，样式固定 | R |

### 3.6 标签页（Tabs）

现有实现：`.taomni-tab`（文档标签）、`.taomni-section-tab`（分区标签）；其他私有实现需迁移。

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-TAB-01 | MUST | 分三类且只用这三类：**分区标签**（页面内切换面板，`role=tablist/tab/tabpanel`、`aria-selected`、`aria-controls`）、**文档标签**（可关闭、可拖动、可含脏标）、**纵向导航轨**（`primaryNavigationRail` 风格，图标 + Tooltip） | R |
| UI-TAB-02 | MUST | 键盘：`←/→`（纵向为 `↑/↓`）移动焦点并激活，`Home/End`；Tab 键只进入当前标签；文档标签 `Ctrl/Cmd+W` 关闭当前、`Ctrl+Tab` 循环（若应用已定义，则在右键菜单显示） | B |
| UI-TAB-03 | MUST | 文档标签：中键关闭；关闭按钮在活动标签恒显、其他标签悬停显示；脏标（圆点）在悬停时变为关闭按钮；有未保存内容关闭时先确认（UI-DST-*）；溢出时出现滚动箭头 + 「全部标签」下拉；拖动重排显示 accent 插入线（沿用 `data-drop-side`）；拖出窗口可分离，且有菜单等价操作 | B |
| UI-TAB-04 | MUST | 标签右键菜单固定顺序：关闭 / 关闭其他 / 关闭右侧 / 关闭全部 → 复制/重命名/固定 → 在新窗口打开 → 复制路径/在文件管理器中显示。不适用的项隐藏，暂不可用的项禁用并说明原因 | B |
| UI-TAB-05 | MUST | 关闭活动标签后的激活目标在所有标签栏一致（以现有 `TabBar` 行为为基线核对后写入本条）；关闭最后一个标签显示空状态而不是空白 | B |
| UI-TAB-06 | MUST | 标签标题单行省略 + Tooltip 全称；最小宽度保证可点击；标题随内容变化时不引起整条标签栏抖动 | B |

### 3.7 树、列表、表格

现有实现：`.taomni-tree-row`、`role="tree"`（10 个文件）、`@tanstack/react-virtual`、DB 结果网格、SFTP/文件浏览器、Explorer。

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-LST-01 | MUST | **选择模型统一**：单击选中（替换）；`Ctrl/Cmd+单击` 切换；`Shift+单击` 范围；`Ctrl/Cmd+A` 全选；`Esc` 清除选择；单选列表禁用多选手势 | B |
| UI-LST-02 | MUST | **激活**：双击或 `Enter` 打开/执行；`Space` 在多选列表切换勾选；`F2` 重命名；`Delete`（macOS `⌘⌫`）删除（走 UI-DST 等级）；`Ctrl/Cmd+C/X/V` 复制剪切粘贴（有此能力时） | B |
| UI-LST-03 | MUST | **键盘导航**：`↑/↓` 移动，`Home/End`、`PageUp/PageDown`；树：`→` 展开（已展开则进入首子项）、`←` 折叠（已折叠则回父项）、`*` 展开全部子级（可选）；键入字符进行前缀跳转；整个组件用 **roving tabindex**（Tab 只停一次） | B |
| UI-LST-04 | MUST | **右键**：在未选中项上右键先选中该项再弹菜单；在已选集合内右键保持多选并作用于整个集合；空白处右键弹「容器菜单」（新建/刷新/粘贴）；`Menu` 键与 `Shift+F10` 在焦点行位置打开 | B |
| UI-LST-05 | MUST | **视觉状态**：hover、selected（`--taomni-selected`）、focused（焦点环，与选中区分）、选中但组件失焦（弱化底色）、拖放目标、禁用、加载中（行内 Spinner）、错误（行内文案 + 重试）。选中态不能只靠颜色 | B |
| UI-LST-06 | MUST | **状态保持**：刷新/重新加载后按稳定 id 恢复选择、展开与滚动位置；新建项自动选中、滚动到可见，需要命名则直接进入重命名；删除后选中相邻项；切换标签再回来保留滚动位置 | B |
| UI-LST-07 | MUST | **空/加载/错误**：首次加载骨架或 Spinner（延迟 150ms 出现）、空状态（图标 + 一句说明 + 主操作）、搜索无结果（说明 + 「清除筛选」）、失败（原因 + 重试） | B |
| UI-LST-08 | MUST | **表格/网格**：表头固定；点击列头排序（升→降→无，`aria-sort`）；列宽可拖动、双击自适应；列可见性/顺序提供菜单；单元格选择可用方向键、`Shift+方向` 扩展；`Ctrl/Cmd+C` 复制（TSV，可选含表头）；可编辑单元格：`Enter/F2` 进入编辑，`Enter` 提交，`Esc` 取消，`Tab` 提交并移到下一格，失焦时有效则提交、无效则保持编辑并提示 | B |
| UI-LST-09 | MUST | 行高固定且随字号缩放（sm 档）；虚拟列表保持键盘焦点项始终在视口内；大于 1000 行必须虚拟化 | B |
| UI-LST-10 | MUST | 列表内的行内操作按钮（悬停出现）必须同样可由键盘到达（行聚焦时可见），或有菜单/快捷键等价操作 | B |
| UI-LST-11 | MUST | **内联重命名**：`F2` 或选中后再次点击进入；进入时全选文件名主体（不含扩展名）；`Enter` 提交；`Esc` 取消；失焦提交（名称非法时保持编辑并显示就近错误，不弹对话框）；提交中禁用输入；重名给出明确提示 | B |

### 3.8 菜单

现有实现：`ContextMenu` / `MenuSurface`（唯一允许的菜单实现；菜单栏与「更多」下拉也复用它）。

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-MNU-01 | MUST | 所有弹出菜单（右键、下拉、分裂按钮、更多）使用 `MenuSurface`。禁止新增私有 `role="menu"` 实现；现存 14 个文件迁移。语义：`role="menu"`、`menuitem`、`menuitemcheckbox`、`menuitemradio`，子菜单 `aria-haspopup` | U/L |
| UI-MNU-02 | MUST | 键盘：`↑/↓` 移动（循环）、`Home/End`、`→` 打开子菜单、`←` 返回、`Enter/Space` 执行、`Esc` 关闭**一层**、字符前缀跳转、`Tab` 关闭菜单；打开时焦点进入菜单，关闭后返回触发元素 | U |
| UI-MNU-03 | MUST | 关闭条件：执行命令、`Esc`、点击外部、窗口失焦、窗口缩放、滚动容器滚动；同一时刻只开一个菜单；打开新菜单自动关闭旧菜单 | U |
| UI-MNU-04 | MUST | 菜单项：图标列对齐，快捷键右对齐（经 UI-PLAT-01 格式化），勾选/单选标记，子菜单箭头；**不适用于目标的项隐藏，暂时不可用的项禁用并给出原因**；危险项置底，以分隔线隔开并用 `danger` 色；需要进一步输入的项以省略号结尾 | U/B |
| UI-MNU-05 | MUST | 位置：贴近触发点/元素，视口内钳制与翻转，超高时内部滚动；子菜单优先右侧，不足时左侧 | U |
| UI-MNU-06 | MUST | 菜单项排序约定：主要动作 → 编辑（剪切/复制/粘贴）→ 视图/排序 → 管理（重命名/移动）→ 危险动作。同类对象在所有模块排序一致 | R |
| UI-MNU-07 | MUST | 顶部菜单栏：`Alt`（macOS 使用原生菜单）激活；已打开某个菜单时悬停切换；`←/→` 在菜单间切换 | B/N |
| UI-MNU-08 | MUST | 菜单中的每个动作必须在代码层级有唯一命令入口，菜单、工具栏、命令面板、快捷键调用同一个函数（避免行为分叉） | R |

### 3.9 弹出层（Popover / Dropdown panel / 命令面板）

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-POP-01 | MUST | Popover 使用共享组件：锚点定位、翻转、`Esc` 关闭并返回焦点、点击外部关闭、触发器 `aria-expanded` / `aria-haspopup`；内部有表单时才捕获焦点 | U/B |
| UI-POP-02 | MUST | 命令面板/快速切换（如 `GlobalCommandModal`、`TabSwitcher`）：置顶 12vh、`↑/↓` 选择、`Enter` 执行、`Esc` 关闭、输入即过滤、允许点击遮罩关闭（轻关闭） | B |
| UI-POP-03 | MUST | 气泡与菜单不得被父级 `overflow:hidden` 裁切：通过 Portal 渲染到 `body`，层级用令牌 | B |
| UI-POP-04 | MUST | 气泡内容超过 480×60vh 时内部滚动，不得撑破视口 | B |

### 3.10 对话框（Dialog / Modal）

现有实现：`ConfirmDialog`、`TextInputDialog`、`ChoiceDialog`、`AlertDialog` 与 `lib/appDialogs`；业务对话框约 93 个，写法各异。

**类型与尺寸**

| 类型 | 用途 | 宽度 | 例 |
|---|---|---|---|
| Alert | 仅告知，一个「知道了」 | 420 | `alertAppDialog` |
| Confirm / Choice | 确认或二选一 | 420 | `confirmAppDialog`、`choice` |
| Prompt | 单个输入 | 420 | `promptAppDialog` |
| Form | 创建/编辑表单 | 560 | 会话编辑、隧道编辑 |
| List/Detail | 列表 + 详情、设置子页 | 760 | 备份恢复、Keymap |
| Complex | 向导、多面板编辑器 | 960 | 导入向导、对比 |
| Fullscreen | 工作区级覆盖 | 视口 − 32 | 截图编辑 |
| Gate | 阻断型（保险库解锁、崩溃恢复） | 420–560 | StartupVaultUnlockGate |

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-DLG-01 | MUST | 一律使用共享 `Modal`（建设目标）；在其落地前，新增对话框必须包装于统一结构，不得自写遮罩与 z-index。遮罩 `--taomni-overlay`，禁止其他透明度与 `backdrop-blur`；弹窗层使用 `modal` 令牌 | U/L |
| UI-DLG-02 | MUST | 结构：Header（标题，可选关闭 X）→ Body（可滚动，p-16）→ Footer（右对齐，gap 8，主按钮最右）。**Footer 和 Header 固定，只有 Body 滚动**；`max-height: calc(100vh − 32px)`、`max-width: calc(100vw − 32px)` | B |
| UI-DLG-03 | MUST | 语义：容器 `role="dialog"`（Alert 用 `alertdialog`）、`aria-modal="true"`、`aria-labelledby` 指向标题、`aria-describedby` 指向说明；根节点 `data-testid="<id>"`，按钮 `-confirm/-cancel/-close` | L/B |
| UI-DLG-04 | MUST | **Esc**：始终关闭最上层对话框（等价取消），无需焦点在对话框内；组词期间的 Esc 不处理；忙碌且不可中断时 Esc 被禁用并有可见说明；嵌套时只关闭最上层 | U/B |
| UI-DLG-05 | MUST | **Enter**：焦点在文本输入 → 提交默认动作；焦点在按钮 → 触发该按钮；焦点在多行输入 → 换行（`Ctrl/Cmd+Enter` 提交）；破坏性对话框的 Enter 默认落在**取消** | U/B |
| UI-DLG-06 | MUST | **初始焦点**：有输入 → 第一个必填/有错的输入；Confirm → 主按钮；**破坏性 Confirm → 取消按钮**（现有 `ConfirmDialog` 焦点落在确认按钮，属待修差距） | U |
| UI-DLG-07 | MUST | **焦点陷阱与返回**：Tab/Shift+Tab 在对话框内循环；背景内容 `inert`；关闭后焦点返回打开前的元素（元素已消失则回到所属容器）；`useFocusReturn` 上升为共享 hook | U |
| UI-DLG-08 | MUST | **点击遮罩**：「轻关闭」类（命令面板、信息提示、只读详情）关闭；其余（表单、有未保存修改、忙碌、阻断型）**不关闭**。必须同一目标上 mousedown 与 mouseup 才算点击遮罩（避免从输入框内拖选到外面松手误关） | U/B |
| UI-DLG-09 | MUST | **提交**：校验失败不关闭，焦点移到第一个错误并在顶部显示摘要（`role="alert"`）；提交中主按钮 busy、表单禁用、取消保持可用（若可中断）；成功后关闭；失败后保持打开并显示原因与重试 | B |
| UI-DLG-10 | MUST | **脏数据保护**：有未保存修改时，取消/Esc/X 先询问「放弃修改？」；无修改直接关闭 | B |
| UI-DLG-11 | MUST | **堆叠**：最多两层（对话框 + 一个确认/选择器）；第三层必须改成同一对话框内的步骤或面板；每层独立焦点陷阱与 Esc | B |
| UI-DLG-12 | MUST | 禁止 `window.alert/confirm/prompt`（macOS WKWebView 静默忽略）；使用 `confirmAppDialog / promptAppDialog / alertAppDialog / choice`；多窗口时对话框渲染在发起窗口 | L/B |
| UI-DLG-13 | SHOULD | 仅 Complex/List 类允许拖动标题栏（`useModalDraggable`）与调整大小；位置与尺寸不跨会话持久化，除非是设置类对话框 | R |
| UI-DLG-14 | MUST | 标题与按钮文案：标题是名词短语或「动作 + 对象」，不带句号；按钮是动词（UI-BTN-05）；关闭 X 的 `aria-label` 为「关闭」 | R |
| UI-DLG-15 | MUST | 窗口缩小到应用最小尺寸时，对话框仍完整可达（Body 内滚动），不出现底部按钮被挤出屏幕 | B |
| UI-DLG-16 | MUST | **向导**：顶部步骤指示、`上一步 / 下一步 / 完成`、逐步校验、`Esc` 取消（有输入则确认）、不可跳过未通过校验的步骤；最后一步按钮改名为具体动作（「导入」） | B |

### 3.11 提示（Tooltip）

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-TIP-01 | MUST | 使用共享 `Tooltip`（建设目标）：悬停 500ms 后出现，移动到相邻目标时 0 延迟；离开、按下、`Esc`、失焦立即消失；键盘焦点（`:focus-visible`）同样显示 | U |
| UI-TIP-02 | MUST | 纯图标控件必须有 Tooltip：名称 + 快捷键（`保存 (Ctrl+S)`）；禁用控件的 Tooltip 说明不可用原因 | B |
| UI-TIP-03 | MUST | 内容是纯文本，≤ 320px 宽，不含可交互元素（需要交互用 Popover）；`role="tooltip"` + 触发器 `aria-describedby` | U |
| UI-TIP-04 | SHOULD | 被截断的文字使用同一 Tooltip 显示全文；原生 `title` 属性仅作为现存代码的过渡，新代码不得对图标按钮使用 | L |

### 3.12 反馈：通知、横幅、进度、空状态

**渠道选择表（必须按表选择，不得自创）**

| 场景 | 渠道 |
|---|---|
| 操作成功，用户已能在界面看到结果 | 就地反馈（如复制按钮变为 `Check` 约 1.5s），不弹窗不提示 |
| 操作成功，结果不可见（后台完成、在其他窗口） | Toast（信息/成功） |
| 后台任务（下载、备份、导入、同步） | 状态栏任务指示 + 面板进度（下载遵循 `AGENTS.md`：状态、字节、百分比、可取消、可恢复） |
| 字段输入错误 | 字段内联错误 |
| 面板/页面级可恢复错误 | 内联 Banner（持久、含重试） |
| 无界面承载的操作失败 | Toast（错误，不自动消失，可复制详情） |
| 需要用户决策 | Dialog |
| 破坏性/不可逆 | Confirm（UI-DST） |
| 系统级阻断（保险库锁定、崩溃恢复） | Gate |

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FBK-01 | MUST | **Toast**（共享组件，建设目标）：右下角，最多同时 3 条，其余排队；信息/成功 4s 自动消失、悬停暂停；**错误不自动消失**；最多一个行内操作（撤销/重试）；`role="status"`（错误 `role="alert"`）；可键盘到达并可 `Esc` 清除 | U/B |
| UI-FBK-02 | MUST | **Banner**：用 `warning/success/danger/info` 令牌；图标 + 文字 + 可选操作 + 可选关闭；持久 Banner 不得被动画顶掉布局后无法回到原位置 | B |
| UI-FBK-03 | MUST | **错误文案**三要素：发生了什么、原因（如果知道）、用户下一步能做什么；含「复制详情」；不得只显示原始异常或错误码 | R |
| UI-FBK-04 | MUST | **进度**：已知总量用确定进度条（`role="progressbar"`、`aria-valuenow`）；未知用不确定动画；超过 2s 的操作必须提供取消；取消后立即反映状态并停止后台工作 | B |
| UI-FBK-05 | MUST | **加载**：150ms 内完成的操作不显示加载；一旦显示至少保持 300ms 避免闪烁；整页加载用骨架，局部用 Spinner | B |
| UI-FBK-06 | MUST | **空状态**：图标 + 一句说明 + 主操作；筛选无结果区分于真正为空；无权限和离线各有独立文案 | B |
| UI-FBK-07 | MUST | 不重复提示：同一事件只用一个渠道；同类 Toast 合并计数；已经在 Banner/字段中展示的错误不再弹 Toast | B |
| UI-FBK-08 | MUST | **复制反馈**：所有「复制」按钮统一为图标切换 `Copy → Check` 约 1.5s 并更新 `aria-label`/`aria-live`；失败显示错误 | B |
| UI-FBK-09 | MUST | **状态点**（连接/在线/错误）：颜色 + 形状或文字双重编码，有 Tooltip 说明具体状态 | B |

### 3.13 表单与设置

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FRM-01 | MUST | 布局：对话框内标签在上；设置页采用左侧固定宽度标签列（120–160px）+ 右侧控件；标签点击聚焦控件；必填加「*」并设 `aria-required`；帮助文字在控件下方用 `-small` + muted | R |
| UI-FRM-02 | MUST | 校验时机：失焦与提交时校验，**不在用户输入过程中阻断**；错误显示在字段下方（图标 + 文案 + `aria-describedby`）；提交时焦点移到第一个错误 | B |
| UI-FRM-03 | MUST | 提交按钮：不因「未填完」而无声禁用；仅在「没有任何修改」或「必填为空」时禁用，并在旁边说明原因；其余情况允许点击并显示校验结果 | B |
| UI-FRM-04 | MUST | **生效模型**：一个界面要么「即时生效」要么「点保存/应用后生效」，且视觉明确（即时生效不放保存按钮；显式生效显示「未保存的修改」标记并拦截离开）。禁止同一页面混用 | R/B |
| UI-FRM-05 | MUST | 设置项必须可「恢复默认」；改动过的项有标记；设置页提供搜索（沿用 `settingsSearch`）并在无结果时给出空状态 | B |
| UI-FRM-06 | MUST | **测试连接**模式：按钮 `测试连接`（`Alt+T` 保持）→ 就地显示进度 → 结果在按钮旁内联显示成功/失败与原因，不弹阻断对话框；测试中允许取消 | B |
| UI-FRM-07 | MUST | 敏感字段：不回填明文，不写入日志、导出与截图；显示/隐藏使用平台原生 | B/R |
| UI-FRM-08 | MUST | 依赖字段（选 A 才出现 B）：隐藏时保留值但不参与提交；禁用时说明原因；不得因切换导致已填内容丢失而无提示 | B |

### 3.14 面板、侧栏、分隔条、工具栏、状态栏

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-PNL-01 | MUST | 面板头：左侧标题（可含计数），右侧操作按钮（ghost、24×24），最右为「更多」菜单与「折叠/关闭」；头部高度同标签页；头部操作可键盘到达 | B |
| UI-PNL-02 | MUST | 分隔条使用 `react-resizable-panels` v4：可见 1px、命中区 ≥ 6px；悬停/拖动 accent 高亮；光标 `col/row-resize`；双击恢复默认；**键盘可调整**（方向键）；设置最小宽度防止被拖没；布局经 `defaultLayout` + `onLayoutChanged` 持久化 | B |
| UI-PNL-03 | MUST | 折叠/展开：有可见按钮和快捷键/菜单等价项；折叠后保留重新展开的入口（rail 图标）；状态持久化 | B |
| UI-PNL-04 | MUST | 工具栏：分组以分隔线隔开；空间不足时末尾出现「»」溢出菜单，**绝不裁切无法到达的按钮**；窄窗口下优先保留关键动作；溢出菜单内项目保持顺序与禁用状态 | B |
| UI-PNL-05 | MUST | 状态栏：高度 24；段落可点击时必须是按钮（Tooltip + 打开气泡/菜单）；不可点击的段落不得有手型光标；信息按优先级截断而不是换行 | B |
| UI-PNL-06 | MUST | 面包屑/路径栏：每段可点击、中间省略、`Ctrl/Cmd+L` 或点击空白进入编辑（路径栏）；`Esc` 退出编辑；目录加载失败就地提示 | B |
| UI-PNL-07 | MUST | 滚动：只有一个主滚动容器沿同一轴；表头/工具栏 sticky；使用 `taomni-scroll-y` 的统一滚动条；横向溢出时有明确滚动条；`overscroll` 不泄漏到外层 | B |
| UI-PNL-08 | MUST | 工作区/标签/面板切换保留各自滚动位置、选择与未提交输入 | B |

### 3.15 拖放（Drag & Drop）

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-DND-01 | MUST | 拖动阈值 4px；拖动中显示拖影、`grabbing` 光标；放置目标高亮（插入线 2px accent 或目标描边）；不可放置显示 `not-allowed` | B |
| UI-DND-02 | MUST | `Esc` 取消拖动并还原；拖到容器边缘 24px 内自动滚动；拖动期间不弹出右键菜单与 Tooltip | B |
| UI-DND-03 | MUST | 复制/移动语义：默认移动；`Ctrl`（macOS `Option`）复制并改变光标；跨窗口/跨会话（SFTP）拖放必须显示传输任务 | B |
| UI-DND-04 | MUST | 外部文件拖入：进入时整块目标显示「释放以…」提示；不接受的类型明确拒绝并说明 | B |
| UI-DND-05 | MUST | **每个拖放操作必须有非拖放的等价路径**（菜单/快捷键，如「移动到…」「剪切/粘贴」「上移/下移」）——这是「有些地方无法操作」的主要根因之一 | B |

### 3.16 嵌入式富内容表面

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-SRF-01 | MUST | 终端/编辑器/RDP/VNC/Markdown/Diff/白板：外围 chrome（标签、工具栏、状态栏、右键菜单、查找栏）遵守本规范；内部内容按各自规则，差异登记 §9 | R |
| UI-SRF-02 | MUST | 查找栏统一：`Ctrl/Cmd+F` 打开，`Enter/Shift+Enter` 下一个/上一个，`Esc` 关闭并回到内容焦点，显示命中计数与「无结果」 | B |
| UI-SRF-03 | MUST | 键盘捕获型表面（终端、远程桌面）：必须有**可见的捕获状态**和**逃生方式**；应用级快捷键在其聚焦时的归属明确（`Mod` 组合归应用，其余归表面） | B/N |
| UI-SRF-04 | MUST | 表面的加载/连接中/断开/错误覆盖层统一：状态说明 + 重试/重连 + 详情；覆盖层不得吞掉工具栏事件 | B |
| UI-SRF-05 | MUST | 右键菜单：表面内容区的菜单与列表菜单同一实现与顺序（复制/粘贴/全选/查找…），选中文本时才启用「复制」 | B |

### 3.17 窗口级

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-WIN-01 | MUST | 分离窗口继承主题、界面字号、语言、快捷键；对话框宿主在每个窗口各一份并在发起窗口渲染 | B |
| UI-WIN-02 | MUST | 有未保存内容时关闭窗口走同一脏数据保护（UI-DLG-10）；关闭路径与菜单「退出/关闭」一致 | B/N |
| UI-WIN-03 | MUST | 设定最小窗口尺寸，在最小尺寸下所有界面可达（UI-DLG-15、UI-PNL-04）；自定义标题栏有拖动区、双击最大化、不遮挡内容 | B/N |
| UI-WIN-04 | MUST | 原生叠加窗口（截图、贴图、录屏条）按 §9 EXC-NATIVE 管理，但仍须满足 `Esc` 取消与键盘逃生 | N |

## 4. 可访问性与键盘（贯穿所有控件）

### 4.1 角色与语义映射

| 控件 | 必须使用 |
|---|---|
| 按钮 | `<button type>`；开关型 `aria-pressed`；忙碌 `aria-busy` |
| 链接 | `<a href>` |
| 文本输入 | `<input>/<textarea>` + 标签；`aria-invalid`、`aria-describedby` |
| 复选/单选/开关 | 原生 input 或对应 role；开关 `role="switch"` + `aria-checked` |
| 下拉 | 原生 `select` 或 `combobox` + `listbox`/`option` |
| 菜单 | `menu` / `menuitem` / `menuitemcheckbox` / `menuitemradio` |
| 标签页 | `tablist` / `tab` / `tabpanel` |
| 树 | `tree` / `treeitem`（`aria-expanded`、`aria-level`、`aria-selected`） |
| 表格 | 只读 `table`；可交互 `grid`（`aria-sort`、`aria-selected`） |
| 对话框 | `dialog` / `alertdialog` + `aria-modal` |
| 提示 | `tooltip` + `aria-describedby` |
| 通知 | `status`（错误 `alert`） |
| 进度 | `progressbar` + `aria-valuenow/min/max` |

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-A11Y-01 | MUST | 禁止给 `div/span` 加 `onClick` 充当按钮；确需自定义，必须同时具备 `role`、`tabIndex={0}`、`Enter/Space` 处理与焦点样式 | L |
| UI-A11Y-02 | MUST | 每个可交互元素有可访问名称；图标按钮用 `aria-label`；名称使用 i18n | L/B |
| UI-A11Y-03 | MUST | 实时区域：toast/状态变化用 `aria-live`；加载状态用 `aria-busy` | B |
| UI-A11Y-04 | MUST | 不使用 `tabIndex > 0`；Tab 顺序等于视觉顺序；复合控件内部用 roving tabindex | B |

### 4.2 焦点

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-FOC-01 | MUST | 所有可聚焦元素具有清晰的 `:focus-visible` 焦点环（`--taomni-focus-ring`，2px，对比 ≥ 3:1）。使用 `outline-none` 必须同时提供等价的 focus-visible 样式；鼠标点击不显示焦点环，键盘导航显示 | L/B |
| UI-FOC-02 | MUST | 焦点管理：弹出层关闭后返回触发元素；对象被删除后焦点移到相邻项；新建后焦点到新对象或其命名输入；异步完成**不得抢走**用户已移走的焦点 | B |
| UI-FOC-03 | MUST | 无键盘陷阱：除终端/编辑器/远程桌面外，`Tab` 总能离开任何组件；上述表面必须提供逃生方式（UI-SRF-03） | B |
| UI-FOC-04 | MUST | 区域间焦点切换：主要区域（标签栏、侧栏、内容、底部面板、状态栏）各有可达的进入方式（快捷键或 `F6` 类约定），并在各自文档中登记 | B/N |

### 4.3 快捷键

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-KEY-01 | MUST | **Esc 阶梯**：每次 `Esc` 只关闭最上层的瞬态元素，顺序为：Tooltip → 菜单/气泡 → 内联编辑 → 对话框 → 面板内搜索 → 清除选择。不得一次关闭多层，也不得被下层抢先处理 | U/B |
| UI-KEY-02 | MUST | 标准动作使用标准键：保存 `Mod+S`、关闭标签 `Mod+W`、查找 `Mod+F`、替换 `Mod+H`（编辑器内与 IDEA 对齐的键位属 §9 EXC-IDEA）、撤销 `Mod+Z`、重做 Win/Linux `Ctrl+Y`/`Ctrl+Shift+Z`、macOS `⌘⇧Z`、设置 macOS `⌘,`、退出 macOS `⌘Q`。终端的 `Ctrl` 信号与应用 `Mod` 保持区分 | N |
| UI-KEY-03 | MUST | 每个快捷键都有可见的 UI 入口（菜单项、工具栏按钮或命令面板条目）；每个 UI 入口若有快捷键则显示在菜单/Tooltip 中；快捷键冲突由统一注册表检测 | R/B |
| UI-KEY-04 | MUST | 可编辑元素内的单字符/无修饰键快捷键一律失效（输入框、文本域、编辑器、`contenteditable`）；`Alt+字母` 在 macOS 会输入字符，不得用作全局键 | B |
| UI-KEY-05 | MUST | 变更快捷键时，按 `AGENTS.md` 的 macOS 约定登记：动作、各平台键位、焦点/上下文、菜单加速键、可见结果；检查原生菜单与前端重复触发、系统保留键、IME 与禁用上下文 | N |
| UI-KEY-06 | MUST | `Enter/Space` 激活焦点所在控件；`Enter` 在按钮上激活按钮而不是触发表单默认动作 | B |

## 5. 交互模式（Pattern）

跨控件的流程必须按下列模式实现，不得每个模块各行其是。

| ID | 模式 | 规则要点 | 验证 |
|---|---|---|---|
| UI-PAT-01 | 新建 | 入口（工具栏 +、菜单、空状态按钮、右键「新建…」）同一命令；列表型对象先创建后进入重命名，表单型对象打开 Form 对话框；成功后选中并滚动到新对象 | B |
| UI-PAT-02 | 重命名 | 见 UI-LST-11；名称校验与重名提示统一文案 | B |
| UI-PAT-03 | 删除 | 见 §7 破坏性操作分级；删除后焦点与选择按 UI-FOC-02 | B |
| UI-PAT-04 | 复制/粘贴/移动 | 剪贴板语义与拖放等价（UI-DND-05）；跨容器移动显示目标；冲突弹出「替换/跳过/保留两者」选择并支持「应用到全部」 | B |
| UI-PAT-05 | 搜索/过滤 | 搜索框 UI-INP-03；匹配高亮；结果计数；`Enter` 打开首个/当前项；`↑/↓` 在结果间移动不丢失输入焦点；筛选状态可见且可一键清除 | B |
| UI-PAT-06 | 主从视图 | 选中即更新详情，不弹窗；详情未保存时切换选择需确认；无选中显示空状态 | B |
| UI-PAT-07 | 导入/导出 | 向导式（UI-DLG-16）：选择来源 → 预览/冲突 → 执行（进度、可取消）→ 结果摘要（成功/失败/跳过数、可复制详情）；导出先选范围与位置 | B |
| UI-PAT-08 | 连接生命周期 | 状态机：未连接 → 连接中（可取消）→ 已连接 → 断开/失败（原因 + 重连）；状态点遵循 UI-FBK-09；凭据提示（AuthPrompt/MFA）为对话框，支持 `Esc` 取消连接 | B |
| UI-PAT-09 | 后台任务 | 任务有统一入口（状态栏指示 + 任务面板）；关闭视图不取消任务，重新打开恢复状态；可取消、可重试；完成通知遵循 UI-FBK 渠道表 | B |
| UI-PAT-10 | 撤销/重做 | 可撤销的操作优先撤销（Toast「撤销」）而非确认框；撤销栈范围在界面中明确 | B |
| UI-PAT-11 | 批量操作 | 多选后操作栏/菜单显示选中数量；破坏性批量操作按 §7 T2；部分失败要汇总并可重试失败项 | B |
| UI-PAT-12 | 设置应用 | 见 UI-FRM-04/05；变更需要重启时明确提示并提供「立即重启」 | B |
| UI-PAT-13 | 首次使用/空 | 空状态给出主操作与一步说明；示例数据不得与真实数据混淆 | B |
| UI-PAT-14 | 离线/权限/不支持 | 平台不支持的功能：入口可见但禁用并说明（或隐藏并在设置中说明），**不得点击后无反应**；浏览器预览降级给出提示 | B |
| UI-PAT-15 | 键盘独立完成 | 每个核心流程（新建、编辑、保存、删除、搜索、切换）必须仅用键盘即可完成，QA 用例至少覆盖一次纯键盘路径 | B |

## 6. 可操作性矩阵（Operability Matrix）

**这是防止「做出来但不能操作」的核心检查表。** 改动或新增某类控件时，按其原型逐列自查；QA 用例按同一矩阵设计（见 ENFORCEMENT §3）。

`●` 必须具备，`○` 适用时具备，`—` 不适用。

| 原型 | 鼠标主操作 | 右键/菜单 | 双击 | 键盘激活 | 键盘导航 | Esc | 焦点可见 | 焦点返回 | 禁用+原因 | Busy | 空 | 错误 | 溢出/窄窗 | 深色 | 字号10/18 | 长文案 | macOS | 可访问名 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 按钮/图标按钮 | ● | ○ | — | ● | ● | — | ● | ○ | ● | ● | — | ○ | ● | ● | ● | ● | ● | ● |
| 文本输入 | ● | ○ | ○ | ● | ● | ● | ● | — | ● | ○ | — | ● | ● | ● | ● | ● | ● | ● |
| 下拉/组合框 | ● | — | — | ● | ● | ● | ● | ● | ● | ○ | ● | ○ | ● | ● | ● | ● | ● | ● |
| 复选/单选/开关 | ● | — | — | ● | ● | — | ● | — | ● | — | — | — | ● | ● | ● | ● | ● | ● |
| 标签页 | ● | ● | ○ | ● | ● | — | ● | ● | ○ | — | ● | — | ● | ● | ● | ● | ● | ● |
| 树/列表 | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 表格/网格 | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 菜单 | ● | — | — | ● | ● | ● | ● | ● | ● | — | ○ | — | ● | ● | ● | ● | ● | ● |
| Popover | ● | — | — | ● | ○ | ● | ● | ● | — | ○ | ○ | ○ | ● | ● | ● | ● | ● | ● |
| 对话框 | ● | — | — | ● | ● | ● | ● | ● | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ● |
| Tooltip | ● | — | — | ● | — | ● | — | — | ● | — | — | — | ● | ● | ● | ● | — | ● |
| 工具栏 | ● | ○ | — | ● | ● | — | ● | — | ● | ● | — | — | ● | ● | ● | ● | ● | ● |
| 分隔条/面板 | ● | — | ● | ● | ● | — | ● | — | — | — | ● | — | ● | ● | ● | — | ● | ● |
| 拖放 | ● | ● | — | ● | ● | ● | ● | — | ● | ○ | — | ● | ● | ● | ● | — | ● | ● |
| 嵌入式表面 | ● | ● | ○ | ● | ○ | ● | ● | ● | ○ | ● | ● | ● | ● | ● | ● | ○ | ● | ● |

## 7. 破坏性与不可逆操作

| ID | 级别 | 规则 | 验证 |
|---|---|---|---|
| UI-DST-01 | MUST | 分级：**T0** 可撤销（移入回收站、可 Undo）→ 不确认，用 Toast「撤销」；**T1** 单个对象、难以恢复 → Confirm 对话框；**T2** 批量或永久 → Confirm，标题与按钮写明数量，列出前 N 项；**T3** 影响全局数据（清空全部、重置保险库）→ 输入对象名称确认 | B |
| UI-DST-02 | MUST | 危险 Confirm：按钮使用 danger 变体、文案写出动作与对象、默认焦点在取消、Enter 不执行删除 | U/B |
| UI-DST-03 | MUST | 创建与编辑类操作不加确认；「不再提示」选项仅限 T1 且可在设置中恢复 | R |
| UI-DST-04 | MUST | 外部影响（远程服务器上的删除、发送邮件、AI 写入）必须在确认文案中明确「远程/外部」；AI/agent 的破坏性动作遵循 `DESIGN.md` 安全不变量 | B |
| UI-DST-05 | MUST | 有未保存修改、进行中的任务、运行中的会话时关闭，必须提示并说明后果；选项明确（保存 / 不保存 / 取消） | B |

## 8. 完成定义（Definition of Done）

提交 UI 相关变更前，作者（人或 agent）必须自查并在 PR 中列出：

- [ ] 使用了共享组件，或说明为什么没有；没有新增私有的对话框、菜单、Tooltip、Toast 实现。
- [ ] 变更涉及的每一类控件，已按 §6 矩阵逐列检查，并列出所依据的规则 ID（如 `UI-DLG-04/06/07`）。
- [ ] 键盘独立可完成流程（UI-PAT-15）；Esc 阶梯正确；焦点可见且返回。
- [ ] 浅色/深色、界面字号 10 与 18、最小窗口、长文案（含中文与英文）已检查。
- [ ] 所有文案在 en 与 zh-CN 中；`data-testid` 稳定。
- [ ] 对应的 QA 用例已新增或更新，并声明 `ui_standard` 规则 ID（ENFORCEMENT §3）；`ui-contract` 套件通过。
- [ ] 静态检查通过（`pnpm check:refactor` 含 UI 规范检查，不得使基线变差）。
- [ ] 偏离规则之处已在 §9 登记或在 PR 中给出理由。

## 9. 例外登记（Exceptions）

偏离必须登记，写明范围、偏离内容、原因与回收计划；未登记的偏离视为缺陷。

| ID | 范围 | 偏离 | 原因 / 回收 |
|---|---|---|---|
| EXC-IDEA | Code Workspace（IDEA 对齐能力） | 键位与交互遵循 IntelliJ IDEA（如 `Alt+Enter`、代码补全、重构对话框流程），可与 UI-KEY-02 的通用键位不同 | 产品目标即 IDEA 对齐；依据 `docs-feature/code-workspace-idea-*` 与 parity skill。**但**对话框、菜单、焦点、禁用原因、Esc 阶梯、可访问性仍然适用 |
| EXC-TAO | Tao Home / Tao AI Chat（`taoHome*.css`） | 圆角 5–16px、独立 `--tao-*` 变量、写死 px 字号、会话式大输入框 | 过渡期保留；回收：令牌并入 `--taomni-*`，圆角收敛到四档（输入框容器可 8px），字号改相对令牌 |
| EXC-NATIVE | 截图、贴图、录屏条等原生叠加窗口 | 透明窗口、固定尺寸、自带工具条 | 原生约束；仍须满足 Esc、焦点、可访问名 |
| EXC-REMOTE | RDP/VNC 画布、终端 | 画布内键鼠由远端/PTY 接管 | 遵循 UI-SRF-03 的捕获状态与逃生方式 |
| EXC-SYNTAX | 语法高亮、终端 ANSI 调色板、图表系列色 | 允许使用固定色值 | 内容色而非界面色；仍须深浅主题可读 |

## 10. 变更与版本

- 新增规则：追加 ID，更新 §6 矩阵与 ENFORCEMENT 的验证配方；同一 PR 修改 QA 校验的规则注册表。
- 修改规则语义：保留 ID，在条目末尾追加 `（v0.x 修订：…）`，并列出需要重新验证的用例。
- 废止规则：保留 ID 并标记 `(废止)`。
