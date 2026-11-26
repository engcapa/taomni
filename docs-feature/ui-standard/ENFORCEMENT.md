# UI 规范的落点、测试用例集成与执行机制

> 状态：方案 v0.4，2026-11-25 复核 `70c62ebb7`。§7 记录代码差距，§8 记录产品决策，§9–§10 对应实施任务和验收。§11 按实际页面核对快捷键、右键菜单、常用控件、主题与页面缩放。[配套规范](UI-STANDARD.md)
> 目标是让同类控件有一致的操作结果，并能从规则查到真实入口、断言和执行证据。

桌面静态检查已进入阶段 4。所有已实现的 lint 检查以空基线执行，开发用例门禁要求桌面渲染器的改动带有声明并映射 `ui_standard` 的用例。下文的基线递减与 advisory 描述记录阶段 1–3 的迁移策略。

## 1. 结论：规范放哪里

只写文档，agent 不一定会读、读了也不一定遵守。规范集中维护在本目录，入口、组件、QA 与静态检查各自引用同一组规则 ID。

| 层 | 位置 | 放什么 | 为什么放这里 |
|---|---|---|---|
| ① 权威规范（唯一事实来源） | `docs-feature/ui-standard/UI-STANDARD.md`（按 §8 固定于本目录） | 全部规则、规则 ID、可操作性矩阵、例外登记 | 篇幅大、需要稳定 ID 被引用，不适合塞进 `AGENTS.md` |
| ② 入口触发 | **`AGENTS.md`** 新增一节「UI & Interaction Standard」（约 20 行） | 强制性指令：改 UI 前必须读规范、必须复用共享组件、PR 必须列规则 ID、必须跑 `ui-contract` 用例 | 所有 agent 的必读入口；篇幅短，只放「必须做什么」，不放规则细节 |
| ③ 测试把关 | **`qa-ui-auto`**：`SKILL.md`、`references/authoring.md`、新增 `references/ui-standard-verification.md`、schema、`dev_contract.py`、`ui-contract` 套件 | 每条规则的验证配方、用例模板、用例必须声明 `ui_standard` 规则 ID 的要求 | 用户明确要求：规范必须体现在测试用例里；用例把规则对应到可观察行为，CI 按实际选集和结果判定 |
| ④ 静态把关 | `scripts/ui-standard-lint.mjs` + 基线文件，接入 `pnpm check:refactor`（`pnpm build` 已包含） | 可机械检查的规则（禁用 `window.confirm`、裸 z-index、未定义令牌、硬编码色…） | 复用现有 `source-file-size.mjs` 的模式；基线只降不升，不会因历史债务阻塞开发 |
| ⑤ 组件落地 | `src/components/ui/`（Modal、Button、Tooltip、Toast、Menu 封装、Field、Tabs、Popover、Banner、EmptyState、Spinner/Progress、Kbd）+ 共享 hooks | 把规则写成代码；每个组件附 README 指向规则 ID，并带挂载单元测试 | **最有效的一层**：规则一次实现、全局生效；agent 复用即合规 |
| ⑥ 设计入口 | `feature-design`、`issue-design` skill 的设计模板；`AGENTS.md` 的 PR 指引（仓库当前没有 PR 模板文件，不新建）；`DESIGN.md` 文档归属一行 | 新增「UI 规范符合性」小节（用到的规则 ID、偏离项） | 在写代码之前就纳入，而不是评审时才发现 |
| ⑦ 对齐类 skill | `code-workspace-idea-parity`、`db-client-parity`、`vnc-realvnc-task` 等 | 一句话声明与 UI-STANDARD 的优先级（见 UI-STANDARD §0.2、§9 EXC-IDEA） | 避免「对标 IDEA/DBeaver」被当作绕过规范的理由 |

**不放的地方**：`replit.md`（项目概述，不承载约束）；`README.md`（面向使用者）。**可选**：若有人使用 Claude Code，加一个只含 `@AGENTS.md` 的 `CLAUDE.md`，保证同一入口。

### 为什么不把全部规则直接写进 `AGENTS.md`

- `AGENTS.md` 每次对话都会被完整加载，规范篇幅较长，会稀释已有的强约束。
- 规则需要 ID 与「验证配方」，QA、设计文档、PR 都要引用；放在独立文件才能稳定引用。
- 所以 `AGENTS.md` 只做「触发 + 强制动作」。

## 2. `AGENTS.md` 拟增内容（英文，与现有风格一致）

```markdown
## UI & Interaction Standard

User-facing UI follows `docs-feature/ui-standard/UI-STANDARD.md`. Identify the control types, applicable rule IDs and registered exceptions before changing behavior.

- Reuse the current owners and published shared components. Use `lib/appDialogs` for application dialogs. As each primitive lands in `src/components/ui/`, migrate callers with their focus, cancellation and recovery behavior.
- Use semantic theme tokens for application chrome. Preserve runtime settings, content palettes and the component-specific sizing boundaries in the standard.
- Verify the required cells of the operability matrix for the affected controls. Include keyboard completion, IME, the owning window, and the visible result of disabled, busy and error states where applicable.
- Document the rule IDs and their observable outcomes in the design, case and PR. Until task #30 lands, cite them in the existing requirement text. After #30, declare the structured IDs and run the registered ui-contract cases with the affected cases and the crash-regression suite required by AGENTS.md.
- Run the current refactor checks. Task #31 adds the per-file UI lint baseline. Register exceptions in UI-STANDARD §9.
```

## 3. 与 `qa-ui-auto` 的集成

### 3.1 要改的文件与改动点

| 文件 | 改动 |
|---|---|
| `.agents/skills/qa-ui-auto/SKILL.md` | ① 「Choose The Work」表增加一行：UI/交互变更 → `ui-standard-verification.md`。② 「Development-Time Case Contract」增加一段 **UI Standard Gate**：UI 变更的用例必须声明 `ui_standard`，并覆盖受影响原型的可操作性矩阵；`ui-contract` 套件与 `crash-regression` 一并在评审前跑 |
| `references/authoring.md` | 「Coverage Dimensions」表新增一行 **UI standard conformance**；「Design To Implementation Handoff」中，每个用例设计必须带一列 `UI rule IDs`；新增「用例模板」小节引用下方 §3.4 |
| `references/ui-standard-verification.md`（新增） | 规则 ID → 验证配方（步骤、可用 verb、期望结果）；每种原型一个 YAML 片段；列出尚缺的 verb |
| `schema/testcase.schema.json` | 在用例顶层和 `verification.requirements[]` 新增可选的 `ui_standard`，非空、去重、完整匹配 `^UI-[A-Z0-9]+-[0-9]{2}[a-z]?$`。保留旧用例格式。现有 tags 已接受字符串 |
| `scripts/qa_ui_auto/dev_contract.py` | 增加「UI 原型特征检测」：变更的组件文件包含 `role="dialog"`、`ContextMenu`、`fixed inset-0`、`<select`、`role="tab"`、`role="tree"`、`onContextMenu`、`useModalShortcuts` 等特征时，要求同一 diff 中存在声明了 `ui_standard` 的用例；缺失输出 warning（与现有 advisory 一致），按 §8 在阶段 4 升级为 error |
| `scripts/qa_ui_auto/audit.py`（`--gate`） | 从规范表格首列读取完整 ID，检查声明、逐条映射与重复 ID。统计声明、带结果断言、实际通过三种数值，实际通过取自执行报告 |
| `scripts/qa_ui_auto/testcase.py`、`behavior_contract.py` | `load_case`/TestCase 保留顶层字段，逐条 requirement 在校验及 `execution_contract` 中带上规则 ID，关联原始结果步骤 |
| `qa-ui-auto-tests/cases/`、`ci/policy.yaml`、`ci/dependencies.yaml` | 标签写在 case。每个 ID 登记 policy，需要依赖才补 dependencies。§3.4 中的例子使用真实入口 |
| `.github/workflows/qa-ui-auto-platforms.yml`、`scripts/qa_ui_auto/ci.py` | 在产品 PR 与 selected/impacted 的现有选集上并入 ui-contract。检查每个平台/mode 的 selection 与 receipt，沿用汇总末步的 `passed` 检查。nightly 的 native 轮转、平台排期独立，在报告中区分本次选入和延期 |
| `AGENTS.md` Testing Guidelines | 在 `crash-regression` 句后补一句 `ui-contract`（见 §2） |

### 3.2 三层测试金字塔（成本与覆盖的平衡）

直接为 100 多个对话框各写一份完整用例不现实。按下面三层组合，逐步覆盖：

| 层 | 内容 | 谁写 | 覆盖面 |
|---|---|---|---|
| **L1 共享组件单元测试** | 对 `Modal / Menu / Tooltip / Toast / Button / Tabs / Popover / Field` 各写一次挂载测试（Vitest + Testing Library），验证共享组件拥有的 DOM 行为：Esc、焦点陷阱、焦点返回、点击遮罩策略、忙碌、禁用原因、角色与可访问名、键盘导航 | 建设共享组件时一次写成 | 证明该原语自身的行为。业务事件顺序、真实焦点、布局与系统副作用分别在真实入口验证 |
| **L2 一致性清扫（registry 驱动）** | 维护 `qa-ui-auto-tests/fixtures/ui-contract-registry.yaml`：登记每个**遗留/私有**对话框、菜单、树/列表的「打开入口步骤 + 原型 + 关闭方式」。由 `ui_contract_gen.py` 按原型模板生成 `TC-UIC-<原型>-<slug>.testcase.yaml`（标签 `ui-contract, auto-generated`），逐个检查通用条目（打开后角色/名称/焦点位置 → Tab 循环 → Esc 关闭 → 焦点返回 → 遮罩点击策略 → 窄窗口可达 → 深色截图无溢出） | agent 在登记新入口时补一行；生成器产出用例 | 覆盖尚未迁移到共享组件的存量，作为迁移优先级的量化依据；新出现的私有入口须登记或迁移。正常复用共享组件的业务入口由 L3 覆盖 |
| **L3 功能用例** | 每个变更的功能用例声明 `ui_standard: [...]`，并在 `verification` 里为「纯键盘路径、禁用原因、错误态、脏数据保护」等业务相关条目映射到规则 ID | 功能作者 | 业务流程与规范的交叉点（L1/L2 覆盖不到的业务语义） |

> L2 的生成器需要先确认 runner 对 `eval_readonly`、`press`、`assert_element_geometry` 的组合足以表达上述断言；缺失的 verb 见 §3.5，由 P2 补齐，不得用 skip 冒充通过。

### 3.3 每种原型的验证配方（写入 `ui-standard-verification.md` 的核心内容）

| 原型 | 必测步骤与断言（对应规则） | 现有 verb | 需新增 |
|---|---|---|---|
| 对话框 | 从真实入口打开 → `role=dialog`、`aria-modal`、有名称（DLG-03）→ 焦点在对话框内且位置符合 DLG-06 → `Tab`×N 不离开、`Shift+Tab` 循环（DLG-07）→ 组词期间 Esc 不关（INP-06）→ `Esc` 关闭并**焦点返回触发元素**（DLG-04/07）→ 再打开点遮罩：按类型关闭或不关（DLG-08）→ 底栏按钮顺序（BTN-06，用几何断言）→ 提交失败：不关闭、错误可见、焦点到首个错误（DLG-09）→ 脏数据 Esc 先确认（DLG-10）→ 最小窗口按钮可达（DLG-15） | `press`、`click`、`assert_visible`、`assert_attribute`、`assert_element_geometry`、`set_viewport`、`fill` | `assert_focus_within`、`assert_focus_on`（现可用 `eval_readonly` 读取 `document.activeElement` 作为过渡） |
| 菜单 | 右键/按钮打开 → `role=menu` → `↓↑`循环、`Home/End`、`→`子菜单、`←`返回（MNU-02）→ `Esc` 只关一层 → 点外部关闭 → 打开另一个菜单旧菜单关闭（MNU-03）→ 禁用项可见且有原因（MNU-04）→ 菜单项与快捷键标签一致（PLAT-01）→ 关闭后焦点返回 | `right_click`、`assert_menu_items`、`click_menu`、`press` | `assert_menu_item_state`（disabled/checked/shortcut） |
| 树/列表/网格 | 单击/Ctrl/Shift 选择（LST-01）→ 方向键、Home/End、前缀跳转、`→/←`展开折叠（LST-03）→ `Enter`/双击激活（LST-02）→ 右键在未选中项先选中（LST-04）→ `F2` 重命名：Enter 提交/Esc 取消/失焦提交（LST-11）→ 刷新后选择/展开/滚动保持（LST-06）→ 空/加载/错误三种态（LST-07）→ 纯键盘完成「新建→重命名→删除」（PAT-15） | `click`（modifiers）、`press`、`dblclick`、`right_click`、`assert_count`、`assert_attribute` | `assert_selected_rows`（读取 `aria-selected`） |
| 表单 | 每个输入有标签（INP-01）→ 失焦出现校验、不阻断输入（FRM-02）→ 提交聚焦到首个错误（FRM-02）→ Enter 提交、多行 `Mod+Enter`（INP-07）→ 禁用原因可见（BTN-03）→ 忙碌态不可重复提交（BTN-04）→ IME 组词期间 Enter 不提交（INP-06） | `fill`、`type`、`compose_text`、`press`、`assert_disabled`、`assert_enabled` | — |
| 标签页 | `←/→/Home/End`（TAB-02）→ 中键关闭、悬停出现关闭按钮、脏标（TAB-03）→ 右键菜单顺序（TAB-04）→ 溢出出现滚动与「全部标签」→ 拖动重排与菜单等价项（DND-05） | `middle_click`、`drag_to`、`press`、`right_click` | — |
| Tooltip / 图标按钮 | 悬停 500ms 出现、`Esc`/移开消失、键盘聚焦出现（TIP-01）→ 有 `aria-label`（ICO-05）→ 禁用时说明原因 | `hover`、`press`、`assert_visible`、`assert_not_visible` | `assert_accessible_name` |
| 通知/进度 | 渠道选择（FBK 渠道表）→ Toast 自动消失/错误常驻、`aria-live`（FBK-01）→ 可中断阶段取消后验证后端已停止；不可中断阶段验证提示与最终结果（FBK-04） | `wait_for`、`assert_attribute`、`assert_text` | — |
| 主题/字号/语言 | 在 Settings 切浅色、深色、跟随系统，改变系统外观及界面字体/字号。读取页面及弹层实际渲染的文字、选区、背景与控件几何。字号 10/18 和中英文长文案下检查溢出、遮挡与可达性。逐状态对比度和多窗口流程见 §11（UI-FND-03a/03c、UI-FND-13/14） | `eval_readonly`、`screenshot`、`assert_element_geometry`、`switch_window` | 按 #32 补可复用的合成色与溢出断言 |
| 拖放 | 拖动阈值、目标高亮、`Esc` 取消（DND-01/02）→ **等价的非拖放路径**能达成同一结果（DND-05） | `drag_to`、`mouse_path`、`mouse_button`、`press` | — |
| 平台 | macOS：Command 键位、原生菜单；Windows/Linux：自绘控件（UI-PLAT-01、AGENTS.md macOS 一节）。IME 与 OS 键盘投递属原生检查 | 现有 native 验证流程 | — |

### 3.4 用例结构与规则追溯

下面是 #30 的验收样例，采用现有 `TC-EXPLORER-012` 的入口和选择器。落地时向原用例添加映射，保留原有模式、标签和切回 Sessions 的断言。示例只演示 UI-PNL-03 的 Explorer 场景，`ui_standard` 两处是计划新增字段。

```yaml
id: TC-EXPLORER-012
title: Explorer 只保留导航轨和文件标签
covers: [F-EXPLORER-1]
tags: [ui-contract, explorer]
fixtures: [reset_db]
modes: [browser, native]
ui_standard: [UI-PNL-03]
steps:
  - open: ${cfg.app.base_url}
  - wait_for: '[data-testid="sidebar-rail"]'
  - vault_first_run: qa-explorer-rail-only
  - click: '[data-testid="side-tab-explorer"]'
  - wait_for: '[data-testid="explorer-platform-view"]'
  - assert_count: {selector: '[data-testid="main-sidebar-resize-handle"]', equal: 0}
  - assert_count: {selector: '[data-testid="expanded-sidebar-panel"]', equal: 0}
  - assert_visible: '[data-testid="sidebar-rail"]'
  - assert_count: {selector: '[data-testid="explorer-workspace-tab"]', min: 1}
verification:
  review: pending
  requirements:
    - id: R1
      ui_standard: [UI-PNL-03]
      requirement: 打开 Explorer 后只保留应用导航轨和 Explorer 文件标签。
      actions: [4]
      checkpoints:
        - {step: 6, expectation: 主侧栏分隔条已卸载。}
        - {step: 7, expectation: 主侧栏面板已卸载。}
        - {step: 8, expectation: 导航轨仍可见。}
        - {step: 9, expectation: 文件标签可用。}
      results: [6, 7, 8, 9]
  visual:
    - {check: 窄窗口能读到活动标签, method: manual, reason: 需在字号端点检查实际布局。}
  native:
    - {check: 原生窗口装饰, method: not-applicable, reason: 此断言只检查渲染层导航结构。}
```

### 3.5 复用 runner 能力

`press`、`assert_attribute`、`assert_element_geometry`、`eval_readonly`、`switch_window` 已存在。先用这些动词断言实际活动元素、菜单项属性、弹层位置和真实窗口。Playwright 的 `set_viewport`、`compose_text` 只覆盖浏览器。WKWebView 的按键、AppKit 菜单激活、物理键盘与系统输入法分别取证。

#32 先用一个遗留弹窗跑通 L2，再按确有重复的观察补焦点、无障碍名称和溢出断言。验证可访问名称要计算实际名称，单查 `aria-label` 会漏掉可见文字或 `aria-labelledby`。字号和主题优先经过真实设置入口。新增 verb 同步 schema、browser/native 实现或明确模式限制、verb-catalog 和代表用例。

### 3.6 完成判定

基线提交的 schema 拒绝未知字段，`testcase.py` 也需显式传递顶层数据。现有 `behavior_contract.validate_contract` 检查步骤序号、断言类型与结果先后。#30 另验每个用例声明恰等于其 requirements 声明的规则并集，出现未知 ID、孤立声明、结果指向点击或截图的用例均应报错。对真实步骤与规则含义的匹配仍需评审。

运行时按 `(case, requirement, 规则 ID, 平台, mode)` 关联步骤结果、head、case/runner 身份和 native 构建。矩阵的必测项可以由 L1、L2、L3 的匹配结果共同举证。计划、静态审计、dry-run、跳过和只有截图的条目各自记录状态。覆盖整个控制类型的结论须有相应状态与平台的实测记录。

## 4. 静态检查（`scripts/ui-standard-lint.mjs`）

接入 `pnpm check:refactor`；每条规则统计「违规数」，写入 `scripts/ui-standard-baseline.json`（按文件），**只允许减少、不允许增加**；新文件基线为 0。

| 检查 | 规则 |
|---|---|
| L01 | 禁用 `window.alert/confirm/prompt`（UI-DLG-12） |
| L02 | 对话框的遮罩和层级复用 Modal（UI-DLG-01）。`fixed inset-0` 只生成候选，需结合角色、调用点及已登记表面识别真正的对话框。全屏截图画布有独立职责 |
| L03 | 检查全局语义令牌的来源、主题和实际可解析性。允许经核实的根节点运行时赋值、局部 CSS 变量及有效 fallback，后者须符合令牌用途（UI-FND-02） |
| L04 | 组件内十六进制色 / Tailwind 调色板色（`bg-red-*`、`text-blue-*` 等）（UI-FND-01） |
| L05 | 裸 z-index 数字（UI-FND-09） |
| L06 | 检查模拟独立按钮的 div/span 的角色、焦点及键盘激活。对于 listbox/option 或 tree/treeitem，核对父控件的焦点与键盘处理（UI-A11Y-01、UI-LST-03） |
| L07 | `outline-none` 未同时出现 `focus-visible` 样式（UI-FOC-01） |
| L08 | JSX 文本或 placeholder/title/aria-label 含 CJK 字面量（UI-I18N-01） |
| L09 | 新增 `text-[Npx]`（UI-FND-04） |
| L10 | `<button>` 缺少 `type`（UI-BTN-02） |
| L11 | 仅含图标的 `<button>` 缺少 `aria-label`（UI-ICO-05） |
| L12 | emoji 作为图标（UI-ICO-01） |
| L13 | 检测新增私有命令菜单。允许共享 Menu 实现、AppKit 的菜单入口及 combobox 的 listbox/option 各自的语义（UI-MNU-01、UI-SEL-01） |
| L14 | #32 提供 registry 后核对私有入口登记（L2）。此前只报告候选并先运行 L01–L13 的已实现部分 |

JSX `style` 对象的固定颜色和整数层级分别按 `L04-inline`、`L05-inline` 统计。它们和类名检查独立比较，覆盖基座、核心及模块渲染器。检查字面值和条件表达式的两个取值分支，运行时的用户颜色及引用主题变量的兼容回退保留原有作用域。审核动态样式和绘制内容时仍按 UI-STANDARD §9 确认具体表面。

首版按“文件 × 规则”记录，新增文件起点为零。对照目标分支和合并结果，下降后随修复提交同步更新，人工提高基线、跨文件或跨规则抵扣均作为差异报告。识别 JSX 元素、按钮可访问名和类名用语法树及明确的组件/样式来源。动态类、第三方内容、语法色、原生叠加窗口单列复核。用截图画布、ThemedSelect、继承 focus-visible 样式的共享类作误报样例，用真实私有对话框和缺名图标按钮作应报样例。

## 5. 共享组件建设计划（`src/components/ui/`）

规则能否长期生效，取决于「合规写法比不合规写法更省事」。

| 组件/Hook | 来源 | 说明 |
|---|---|---|
| `Modal` | 抽取 `ConfirmDialog` 与 `useModalShortcuts/Draggable` | 一次实现共享层的焦点、Esc、Portal 和模态布局；`ConfirmDialog` 等改为其薄封装，并修正危险确认焦点（DLG-06） |
| `Button` / `IconButton` / `SplitButton` / `SegmentedControl` | 抽取 `.taomni-btn` | 变体、busy、disabled 原因、Tooltip 联动 |
| `Tooltip` | 新建 | 取代图标按钮的原生 `title` |
| `Toast` + `useToast` | 新建 | UI-FBK-01 |
| `Menu` | 封装 `ContextMenu/MenuSurface` | 补齐 role 语义、Menu 键/Shift+F10、禁用原因，保留已有的子菜单键盘返回、Portal 和焦点恢复 |
| `Popover` / `Combobox` | 提取通用定位，复用 `ThemedSelect` 及其挂载测试 | 命令菜单和选择列表保留各自角色、活动项和提交/还原语义。搜索式 Combobox 另补输入过滤 |
| `Field` / `FormRow` / `Checkbox` / `Radio` / `Switch` | 抽取 `.taomni-input/checkbox/radio` | 标签、错误、说明、`aria-*` 自动接线 |
| `Tabs` | 合并 `taomni-tab`/`taomni-section-tab`/私有实现 | 三类标签（TAB-01） |
| `Banner` / `EmptyState` / `Spinner` / `Progress` / `Kbd` | 新建或抽取 | UI-FBK |
| `useFocusReturn` / `useFocusTrap` / `useEscapeLayer`（层栈） / `useRovingFocus` / `useSelectionModel` | 提升 `editor/workspace/useFocusReturn`、新建 | 实现 Esc 阶梯与列表选择模型，树/列表复用 |
| `formatShortcut` / `formatBytes` / `formatDate` | 收敛现有分散实现 | UI-PLAT-01、UI-I18N-03 |
| 页面命令与缩放 | 复用现有工作区命令路由、Notepad 键位表、内容缩放处理和窗口菜单 | #33 确定活动目标及一次投递，#34 对接三个共享缩放命令与当前键位显示，#37 迁移业务入口。目标、基准和窗口生命周期见 §11 |

每个组件：README（对应规则 ID）+ 挂载测试（即 L1）+ 示例用例。

## 6. 分阶段推进

| 阶段 | 内容 | 风险 | 产出 |
|---|---|---|---|
| 0 | 评审并确认本规范与落点（本文） | 无 | 定稿的 UI-STANDARD、已确定的落点 |
| 1 基础 | 补齐/迁移设计令牌（danger、overlay、focus-ring、z 层、字号、半径）；界面字号迁移到界面容器，避开编辑器内容与远程画布；`AGENTS.md` 增节；`qa-ui-auto` 文档与 schema 更新；`ui-standard-lint` 与基线 | 低（以文档与令牌为主，行为不变） | 约束开始生效，存量不增长 |
| 2 共享组件 | `Modal`、`Button`、`Tooltip`、`Toast`、`Menu` 封装、`Field`、`Tabs` + L1 测试；新增 verb | 中（需覆盖已有用例回归） | 新代码可零成本合规 |
| 3 迁移 | 按原型逐批迁移并通过 L2 清扫：①`window.confirm` 清零 ②经登记确认的对话框 ③菜单/标签/下拉/复选 ④树/列表/表格 ⑤Tao Home 收敛 | 中高（每批跑 `crash-regression` + 受影响功能用例） | 基线逐步下降 |
| 4 收紧 | lint 基线归零后改为硬性失败；`dev_contract` 的 UI 检查由 warning 升级为 error | 低 | 长期稳态 |

建议将阶段 1、2、3 各拆为独立任务（3 内按原型再拆），阶段间用依赖串联，避免多个 agent 同时改同一批文件。

## 7. 合并后评审记录

| 优先级 | 代码与证据（基线 `70c62ebb7`） | 实施影响 |
|---|---|---|
| P0 | `ConfirmDialog`、`ChoiceDialog` 初始聚焦 confirm/primary，非按钮上的 Enter 调用相应回调。`ExplorerDialogs` 在 Shift+Delete 或回收站失败时聚焦永久删除。TC-EXPLORER-010 还断言旧焦点 | #33、#35 修正危险默认动作，再迁移消费者。原生断言须检查原文件、回收站与撤销后的字节。见 DEC-01 |
| P0 | `src-tauri/src/windowing/thread_delivery.rs` 的 `forget_window_routes` 清除线程与终端路由。`agent/cc_bridge/approval_replay.rs` 按原窗口标签重放。现有 869-03 验证的是关窗**之后的新请求**，且平台声明为 Linux/Windows | 窗口生命周期任务 TASK-WIN-01 实现 DEC-02，分开验证仍待处理的旧请求、重载重放和后续新请求。普通 UI 的 focus hook 没有任务所有权 |
| P0 | 17 个文件的 34 处浏览器弹窗仍在生产调用链。会话树导入错误、HTML 查看器的联网许可、邮件正文外发许可有不同的返回值和副作用 | #35 按调用者选择内联错误、提示或应用确认。验证拒绝/取消及目标已切换时的分支，避免重复提交 |
| P1 | `ContextMenu.tsx` 和 `ThemedSelect.tsx` 已有键盘/Portal 实现，`useModalShortcuts.ts` 监听 window。Dialog 上的父监听、Portal 内选项、IME 可能竞争同一键 | #33 用嵌套真实入口验证一次 Esc 只关闭子层，第二次返回发起控件，组词不触发取消 |
| P1 | `ExplorerFileList` 的容器持有 DOM 焦点，虚拟行以 path 选择。列表/详情/图标按 24/28/96px 估算，框选也使用此值。DB `grid/useGridEditing.ts` 将行 edits 保留到后续提交 | #38 保留虚拟列表选区、滚动及 DB 暂存语义，编辑单元格和实际执行数据库写入分别验证 |
| P1 | `useMainLayoutState`、`explorerStore`、`tabsSlice` 分别负责侧栏策略和两类标签关闭。`useOverviewPreview` 延迟 700 ms 才放大卡片。`notepad/actions/coreCommands.ts` 的粘贴命令和 `notepad/persistence/recoveryDraft.ts` 跨越系统剪贴板、磁盘边界 | #36–#38 避免重建已移除的面板、把大预览做成 Tooltip、丢失正文或选区。用 §10 的保留行为验证 |
| P2 | 颜色、字号、层级和翻译分散。`src/App.tsx` 与分离窗口写入字号，`explorerLabels.ts` 和局部 CSS 使用双语文案与视图别名。Notepad 已使用编辑器选区令牌 | #31、#39 按调用者迁移。具体数量和筛选口径见 UI-STANDARD §1。仅凭匹配次数无法判断焦点、菜单语义或已渲染的对比度 |
| P1 | 终端、Markdown 的 `contentZoomShortcut` 只认 Ctrl，终端菜单直接写 `Ctrl+0`。HTML 预览处理无修饰的 `+/-/0` 并排除 Ctrl、Meta。Notepad 注册 `Mod+=/-/0`，执行时写入共用的 `zoomDelta`。DB 可见页在 window 捕获阶段消费 Ctrl 缩放并写入共用字号存储，邮件监听 Ctrl 或 Meta | #33、#34、#37 对齐实际投递者、作用域、平台提示与恢复基准。工作区书签 0、分屏和 AppKit 的窗口最大化分别取证（AC-07、AC-12） |
| P1 | Explorer 的文件和空白区已有两套目标菜单，但删除项固定显示 `Del`，`ExplorerShell` 在 macOS 也处理 ⌘⌫。Notepad 菜单按有效键位生成，其“替换”默认 `Mod+H` 在 macOS 解析为 ⌘H，与 AppKit 隐藏应用重合 | #33、#37 沿用已有的对象菜单和命令目录，统一有效键位展示与系统保留键处理。AC-07 核对 macOS 真实投递，AC-08 核对目标路径与选区 |
| P1 | 会话编辑器的主按钮采用 `.taomni-btn[data-primary="true"]`，前景固定为白色，渐变来自主题令牌。Linux 浏览器中深色主题的渐变两端均达不到正文 4.5∶1。截图专用入口 `src/screenshotOverlayRoot.tsx` 在挂载时读一次界面字体/字号，分离会话的失效交接提示还含固定深色。 | #31 修正成对颜色与窗口外观来源，#34、#39 复核实际按钮、错误态及字号的实时传播（AC-09 至 AC-11） |

## 8. 已确认的决策

| 决策 | 结论 |
|---|---|
| 规范位置 | 保持在 `docs-feature/ui-standard/`，不晋升到仓库根；`AGENTS.md`、`DESIGN.md`、skill 均指向该路径 |
| lint 严格程度 | 「只降不升」基线：按文件记录违规数，允许减少、不允许增加，新文件基线为 0；基线归零后才改为硬性失败（阶段 4） |
| 本轮范围 | v0.2 产出规范与任务拆分，v0.3 核对合并后实现并确认 DEC-01/02，v0.4 增补逐页面一致性与验收。产品变更由 §9 的任务交付 |
| 规范语言 | 规范正文中文；`AGENTS.md` 新增节英文（沿用，用户未异议） |
| `CLAUDE.md` 指针 | 未决定，默认不新增；如需要由任务 1 之后单独提出 |
| `dev_contract` 的 UI 检查 | 先 warning，阶段 4 升级为 error（沿用推荐） |

### v0.3 产品决策（2026-11-25，用户已定）

| ID | 实际分歧与选择 | 生效范围与依据 |
|---|---|---|
| DEC-01 | **A，Shift+Delete 默认取消。** 用户选择避免紧接的 Enter 永久删除。B 保留旧的两键永久删除，已舍弃 | 在普通 Del 的方式选择中仍可选回收站或永久删除。Shift+Delete 和回收站失败后须由用户主动激活永久删除。更新 [Explorer 设计](../file-explorer/tab-strip-overview-delete-design.md) 的 AC-05，实施时同步改原焦点断言。对应 AC-01 / V-01 |
| DEC-02 | **A，主窗口接续原审批。** 用户选择任务延续，主窗口显示来源并等待原决定。B 会拒绝原请求、要求重新发起，已舍弃 | 分离窗口已有未决审批，主动并回时任务继续。任务已终止、请求已解决或超时按原生命周期撤除。见 TASK-WIN-01、AC-02 / V-02 |

[两种方案的桌面交互对照图（已选 A）](interaction-decisions.drawio.png)

### v0.4 适用范围（2026-11-25，用户已定）

**DEC-03**　本轮覆盖桌面全部界面，包括主窗口、分离窗口、浮层和独立启动入口。可连接多台桌面实例的 Taomni Remote 手机网页另行设计。下文的 Settings 外观和页面缩放均以桌面为范围。

## 9. 任务拆分

实施按下表拆为 10 个任务，依赖关系用于避免多个 agent 同时修改同一批文件。产品任务按 `AGENTS.md` 在评审前运行完整 `crash-regression` 及受影响用例。治理、schema 或工具本身的工作按其实际影响验证。

| # | 任务 | 对应阶段 | 依赖 | 主要改动范围 |
|---|---|---|---|---|
| 1 | 规范治理与 QA 门禁（文档、schema、`dev_contract`、`audit`、`ui-contract` 套件登记） | 1 | 无 | `AGENTS.md`、`DESIGN.md`、QA/设计 skill、runner/CI。按 §11 将真实页面、命令与适用状态对应到结果 |
| 2 | 设计令牌、Settings 外观来源与 UI 规范 lint 基线 | 1 | 无 | `src/styles/`、应用与独立窗口入口、`scripts/`、`package.json`。优先修复主按钮的前景与渐变搭配 |
| 3 | QA 新增断言动词与一致性清扫生成器（L2） | 2 | 1 | `qa-ui-auto` 脚本与 schema、registry 夹具。登记路由与右键目标，补可重复使用的状态、对比度、尺寸和命令结果检查 |
| 4 | 共享浮层、焦点/Esc 层栈、Menu 与 Popover，明确窗口与页面的命令归属 | 2 | 2 | 现有命令路由、窗口菜单、`src/components/ui/` 浮层及 `src/hooks/`。保留 Promise 对话框与文本编辑行为 |
| 5 | 共享控件、快捷键显示及页面缩放 | 2 | 2 | Button、Tooltip、Toast、Field、Tabs、Banner 等共享控件在两个模块对照。以有效绑定格式化提示，为普通页和有焦点的内容面提供共用缩放入口 |
| 6 | P0 可操作性修复：原生 confirm/alert/prompt、无 Esc 对话框、可点击 div | 3 | 2 | 17 个显式浏览器弹窗调用文件，以及按真实入口核实的 Esc、危险焦点与键盘缺陷 |
| 7 | 对话框迁移到共享 Modal（按功能分批） | 3 | 3、4、6 | 对话框组件与对应用例 |
| 8 | 菜单、标签、下拉、复选、Tooltip 迁移，接入共享命令与缩放 | 3 | 4、5、7 | 逐页迁移菜单、键位和原内容缩放监听，覆盖编辑器、查看器、会话、分离窗口与普通页 |
| 9 | 树、列表、表格的选择模型与键盘导航统一 | 3 | 8 | Explorer、SFTP、会话树、DB 网格等。双入口验证空白/单选/多选/只读及缩放后的虚拟行定位 |
| 10 | 颜色/字号/z-index/i18n 清扫与收紧 lint | 4 | 9 | 全局样式和 Tao Home 收敛。关闭 §11 逐页的外观、对比度与尺寸差距，基线归零后收紧 lint |

表中 1–10 对应原项目任务板 #30–#39。此次设计另列 **TASK-WIN-01（审批随运行任务并回）**，可从既有 Tauri 路由独立实施，交付条件见 AC-02 / V-02。该编号仅用于本文交接。

并行关系：任务 1 与 2 可同时进行；任务 3、4、5、6 在各自依赖满足后可并行（任务 4 与 5 位于 `src/components/ui/` 的不同文件，各自维护导出）；任务 7 起按依赖串行，避免同文件冲突。

下游可从任务 1（#30）和 2（#31）开始。合并版本在 `package.json` 锁定 `@tanstack/react-virtual` 3.13.12，本次检出能解析该依赖。启动各自的浏览器或原生用例时按实际依赖状态准备环境。

## 10. 重点验收与实施边界

下表是产品任务的验收设计。每批迁移需保留真实入口、异步操作和副作用断言。表中提到的用例可按仓库内的 YAML 文件查找，执行时采用文件中的完整 `id`。

| 验收 | 负责的任务 | 可观察结果与验证入口 |
|---|---|---|
| AC-01 / V-01　删除前的默认焦点 | #35 修 Explorer，#33 确立 Confirm/Choice 契约，#36 验证迁移 | 普通 Del、菜单、工具栏均先打开方式选择。Shift+Delete 后直接按 Enter 关闭，所选文件仍在；重新打开，主动选中危险按钮执行才删除。回收站部分失败只列出失败项，默认聚焦取消，成功项仍可撤销。更新 `ExplorerShell.actions.test.tsx`、`useExplorerOperations.test.tsx` 及 TC-EXPLORER-010 的旧焦点断言。与 TC-EXPLORER-003 一起在隔离目录对比原文件、回收站与恢复内容 |
| AC-02 / V-02　待决审批随任务并回 | TASK-WIN-01 | 两个窗口打开同一运行任务，在分离窗口看到审批后直接并回。主窗口只显示一张含来源的原卡片。分别验证允许与拒绝、连续点击、重复到达、并回时请求已结束。检查后端收到同一请求的一次最终决定；超时、已撤销或已处理后重开窗口也不会复现。保留现有 869-01/02/03，另增 `TC-AI-869-04-pending-owner-reattach-native`（拟建）及 CC/ACP 各自的身份与竞态测试 |
| AC-03 / V-03　键盘与弹层 | #33、#34、#36、#37 | 对话框中打开 ThemedSelect 或子菜单，按 Esc 只收起子层；Tab/Shift+Tab 循环包含所属 Portal，第二次 Esc 返回触发控件，新的已获焦对话框不会被前一层抢焦。IME 组词时 Enter/Esc 不触发提交或关闭。保留 appDialogs 的 FIFO、prompt 取消返回 null、空串提交、Alert 错误文本可选可复制及外点保持。先跑 ContextMenu、ThemedSelect、appDialogs 挂载测试，再从真实表单进入 |
| AC-04 / V-04　导航、标签与虚拟列表 | #36–#38 | Explorer 只显示导航轨，切回 Sessions 能恢复其侧栏。过滤和关闭标签后保留预期活动对象。Overview 快速划过不放大，停留后显示预览。用 TC-EXPLORER-004/006/011/012、TC-WS-099/100 验证真实入口。补字号 10/18 下同一文件的键盘定位、可访问活动项、框选及滚动。DB 结果网格内提交一格后，数据库写入仍由既有提交入口负责，保留 TC-DB-EDIT-001 的实际 SQL 与结果断言 |
| AC-05 / V-05　富文本、终端与原生平台 | #31、#37–#39 | Notepad 的焦点和非焦点选区在浅深色下可辨。菜单/快捷键粘贴只向当前编辑器插入一次，保留草稿后重开可恢复原文。覆盖 TC-NP-008/104/105、TC-FILE-OPEN-047。远程桌面保留本地菜单键与显式发送到对端的区别，复用 TC-153。macOS 分别检查 WKWebView 焦点链、AppKit 菜单动作和 OS 实际键位/IME，保留 TC-MAC-001/002/003 |
| AC-06 / V-06　可执行的 QA 与 lint | #30–#32、#39 | 旧用例仍可加载；有效 ID 的场景进入 selection 和逐步骤 receipt；未知 ID、缺映射、无结果的声明分别有失败样例。用 §4 的应报与误报样例验证每文件基线只降不升。CI 的“Require all planned cases to pass”检查所选用例结果，验证一个缺失或失败的必测样例确实影响结果 |

AC-07 至 AC-12 将五项跨页面要求落实到页面清单、实际操作和证据。[逐页覆盖与跨模块验收](#11-逐页覆盖与跨模块验收)

**审批交接契约。** 现有入口分别为 Rust 的 `windowing/thread_delivery.rs`、`agent/cc_bridge/approval_replay.rs`、`chat/acp/events.rs` 和前端 `CcAgentBridge.tsx`。交接只更新未决请求的呈现窗口，继续使用原线程、回调和到期时间。CC 用 callId 定位，ACP 保留 threadId、permissionOwnerId、callId 与服务端给出的可选决定。卡片显示可读的来源会话/窗口和操作摘要。后端先核实仍待决及旧 owner 再交接，主窗口按原身份去重，重复并回或迟到的旧窗口决定不能触发第二次执行。关闭应用、停止线程、无主窗口可接收时，沿用各提供方的取消/超时收尾。普通 appDialogs 的 Promise 队列留在发起 WebView。

**原生验证。** V-01 使用带可恢复测试文件的隔离目录和匹配源码的 QA 构建。V-02 在隔离的主窗口和分离窗口验证真实 Tauri 路由，同时保留第三个无关窗口，检查它收不到针对主窗口的接续审批。分别记录 Windows/WebView2、Linux/WebKitGTK、macOS/WKWebView 的结果。869-03 现有自动化只声明 Linux/Windows，macOS 的并回入口需用可交付真实事件的原生操作或人工记录。真实按键、系统剪贴板和磁盘结果分别留证。[macOS 验证指南](../../qa-ui-auto-tests/native/runbooks/macos-ui-compatibility.md)

### v0.3 评审的实测记录

2026-11-25，Linux，产品源码 `70c62ebb7`。Vitest 共 8 个文件、97 项通过，覆盖 appDialogs、ContextMenu、ThemedSelect、Explorer Shell 的交互/动作、Explorer 操作、CC 审批桥和 Notepad 选区。Explorer 动作测试中仍有一项明确断言 Shift+Delete 聚焦永久删除，这项通过记录的是迁移前行为。

浏览器 QA 运行 `run-20261125-111414-571478955`，TC-EXPLORER-012、TC-WS-100 和 TC-AI-869-01-approval-window-routing-browser 全部通过，0 跳过。记录位于本地 `qa-ui-auto-report/ui-standard-v03/`，包含 summary 和 runner receipt。本次验证范围为已有实现的浏览器与组件行为。DEC-01 / DEC-02 对应的新行为及 Windows、macOS、Linux 原生验收留给产品实现批次。

## 11. 逐页覆盖与跨模块验收

### 11.1 从真实入口登记

基线有 23 种应用标签、12 种 Workspace 标签和 6 个主导航模式。主导航、Workspace 内嵌页面、分离窗和直接启动的窗口各有自己的入口。清单按共享内容归组，同组内每个实际入口各自记录结果。[应用标签](../../src/types/index.ts) · [Workspace 标签](../../src/stores/workspacePlatformStore.ts) · [主导航模式](../../src/stores/app/types.ts) · [主界面](../../src/layouts/main/MainLayoutView.tsx) · [标签内容](../../src/layouts/main/TabContentRouter.tsx) · [Workspace 内容](../../src/components/workspace/WorkspaceMainPanel.tsx) · [窗口路由](../../src/App.tsx) · [独立启动入口](../../src/main.tsx)

| 桌面页面与入口 | 快捷键、右键应作用的对象 | 对照控件、Settings 外观与缩放目标 |
|---|---|---|
| Home / `welcome`（含 Tao AI Chat）、Sessions、Tools、Agents、Overview、`placeholder`/不可用页 | 最近项目、会话/文件夹、工具条目、标签卡、消息及可复制的错误详情。空会话树可以新建，输入框保留编辑和组词 | 卡片、搜索、列表、菜单、空态/错态跟随应用。普通页缩放整个页内布局，Overview 弹层按它的宿主验收 |
| Settings / `settings`、会话编辑器、Vault 解锁 | Settings 搜索和结果、字体选择器、表单输入与对话框。核对显示键位、保存/取消、文本编辑菜单及 Tab 回焦 | 比较按钮、字段行、复选、开关和底栏。Settings 页面本身也能缩放，字体/字号设置控件的值只由显式修改设置改变 |
| 工具与管理页 `nettools`、`sockscap`、`proxy-test`、`servers`、`mfa`，含悬浮 MFA | 规则、连接、账户行、测试结果和输入目标。按可用操作分别检查项目、空白区和只读输出 | 表单、状态、按钮、表格按应用外观，页面整体缩放。悬浮面板检查焦点、文字尺寸与展开后的页面 |
| Explorer / `file-browser`、`sftp`、`object-storage`，Workspace 的 `explorer`、`sftp` | 本地/远端面板、树、文件/目录行、标签、空白、多选、只读目录。菜单和键盘处理相同目标，写操作核对路径与确认 | 工具栏、路径框、列表与选择高亮，整体缩放后核对虚拟行、滚动、框选和菜单锚点。保留 DEC-01 |
| Workspaces / `code-workspace`，Workspace 的 `file`、`code` | 编辑标签、项目树、编辑器选区、结果/工具窗口、分屏。核对有效 IDEA 键位、书签 0 和焦点所有者 | 树、编辑器、工具条分别读取应用或代码视图的相应设置。内容取得焦点时缩放该树或编辑内容 |
| `file-viewer`，Workspace 的 `viewer` | 文本/Notepad、Markdown 编辑与预览、HTML 预览及其 iframe、图像/SVG。分别核对文本选区、只读、编辑/源码模式和画布动作 | 宿主菜单和标签跟随应用。缩放活动编辑区、预览或图像。作者 HTML 和原图保留内容颜色。图像“实际大小”“适应窗口”有各自语义 |
| `database`、`redis`、`hbase-shell`、`git`，Workspace 的 `database`、`git` 和各协议的 `session` | SQL 编辑器、结果行/单元格/列头、对象树、CLI、提交/文件列表与 Diff。区分暂存编辑、只读及实际提交 | 树、表格、工具栏、菜单与对话框按角色对照。缩放焦点内容或活动页。切到相邻会话后检查历史、字号及未提交内容 |
| `terminal`、`rdp`、`vnc`，含 Workspace 同名标签及终端分屏 | 终端选区、PTY、画布及本地工具条。分别验证捕获、释放、键盘打开本地菜单和显式发送远端键 | 终端正文采用有效会话外观。RDP/VNC 保留远端画面，宿主页面/控件仍跟随应用并可从共享菜单缩放。范围见 EXC-REMOTE |
| `mail`、`mail-unified`、`lan-chat`、Notes，包括 Workspace 的 `note` | 邮件夹/消息/笔记列表、单选与多选、阅读正文、编辑和草稿。选区菜单与输入框分别验，切页后核对同一草稿 | 列表、按钮、菜单跟随应用，显式邮件/编辑器配置只影响相应内容。检查阅读或编辑焦点、普通列表页与未聚焦的邻页 |
| 分离的 SFTP、终端、数据库、RDP、VNC、LAN Chat、Notes，及窗口内的 Portal、菜单和对话框 | 原页和分离页打开同类对象，命令只投递到前台窗口。菜单关闭回到来源，待决审批并回按 DEC-02 | 同时比较两窗及其弹层，随后打开第三窗核对初值。每个有内容的分离窗都可用统一键位及共享菜单执行缩放 |
| 截图选区、贴图/贴图板/工具窗、滚动截图条、录屏条/边界、恢复工作区与启动错误页 | 检查可交互宿主的键盘入口、可选正文及错误详情。无输入边框按 EXC-NATIVE 登记。恢复页独立于正常主布局启动 | 自绘工具、提示、按钮及恢复页读取可用的 Settings 外观。设置读取失败时验证可读的默认值。恢复页面普通缩放，像素表面分别核对画面坐标和宿主控件 |

每条记录列出页面/窗口、焦点或菜单目标、命令及有效键位、控件变体、主题/选中状态、缩放目标、用例与平台结果。新增页面或同一标签下新增的独立内容模式随入口登记。对确无对象动作的静态区域记录原因，有可选正文时保留复制。历史用例可用作起点，未测状态保留待验标记。

快捷键盘点从原生菜单加速键、渲染层菜单、命令目录与用户覆盖，以及各页面的 keydown、CodeMirror 和终端处理器双向核对。查出仅在菜单显示、仅有监听、或同一焦点下被两处认领的键位。右键从树、页签、编辑器、网格和容器的实际目标向菜单核对，同一目标在键盘打开后仍应定位到活动对象。[Explorer 菜单](../../src/components/explorer/explorerContextMenus.tsx) · [Notepad 菜单](../../src/components/notepad/NotepadContextMenu.tsx) · [结果网格](../../src/components/database/QueryResultGrid.tsx)

### 11.2 验收步骤

| 验收、规则与任务 | 从产品入口执行 | 通过条件 |
|---|---|---|
| AC-07 / V-07 快捷键　UI-KEY-02/03/05/07、UI-PLAT-01。#30、#33、#37 | 按 §4.3 的动作族逐页登记实际命令。对有该能力的入口分别走物理键、菜单、命令面板。修改/解除一个可配置键位，复查菜单、Tooltip 和实际派发。切换编辑框、模态、隐藏页、分屏和窗口，再试 IME 与 AltGr | 显示匹配此平台的有效键位，一次触发一次可观察动作。文本和组词保留，未获焦的模型无变化。抽查工作区重开标签与主窗口新建终端共用的键位、macOS 的 ⌘H 与 ⌘W，以及 PTY 的 Ctrl+C。AppKit 菜单动作、操作系统实际按键单独记录 |
| AC-08 / V-08 右键　UI-MNU-04/06/08/09/10、UI-LST-04。#32、#33、#37、#38 | 对 §11.1 的目标分别用右键、macOS Control+点按、聚焦后 Menu/Shift+F10 或可聚焦的共享菜单打开。同一列表依次测空白、未选行、已选行和多选集合。另测列头、单元格、标签、可写/只读正文和原生输入 | 断言对象 ID/完整选择集、分组顺序、有效键位、可用/禁用原因、执行后的内容和焦点。多选集合内右键保留集合，集合外作用于点击项，空白命令作用于容器。文本选区保留，复制准确。Esc 逐层关闭，危险项复用同一确认 |
| AC-09 / V-09 常用控件　UI-CTL-01、UI-FND-08a/08b。#34、#36–#38 | 例如从 Sessions 打开“新建会话”，再从 Settings 打开 Codex 配置，对照同变体的主按钮、次按钮和字段。树行/菜单在 Explorer 与 SFTP 对照。核对默认/紧凑密度、字号 10/18 与窄窗 | 比较实际高度、命中区、同排基线、图文间距和底栏顺序。Tab 顺序、焦点、Enter/Space 对应控件原生语义，重复点击忙碌提交只产生一次结果，禁用原因和失败后输入均可见。按控件适用状态记录 |
| AC-10 / V-10 主题可读性　UI-FND-03a/03c。#31、#32、#39 | Light、Dark 及 Follow system 的两种解析结果下测同一控件。覆盖普通、悬停、按下、选中、选中再悬停、选中后失焦、禁用、键盘焦点与查找命中。至少包含主按钮、树/列表、菜单勾项、标签、网格、编辑器选区 | 读取实际文字/图标和下方背景，叠加透明度至不透明底色。渐变取文字/图标覆盖范围内的最低对比度，另记录端点。正文/图标 ≥4.5∶1、边界/状态指示 ≥3∶1。切换焦点或查找后仍可区分当前项、选区、命中和文字 |
| AC-11 / V-11 Settings 外观　UI-FND-13/14。#31、#37、#39 | 同时打开 Settings、另一个业务页、一个后台标签和分离窗。从真实设置切换 Light → Dark → Follow system，让系统明暗各变一次。切换字体、字号 10/18、恢复默认，在子窗打开菜单/对话框，再新开窗口、重启 | 核对各页面可见文字的实际字体、字号、背景与几何，已有浮层也随设置更新。显式明暗忽略系统切换，跟随模式实时响应。后台页再显示、新窗口初值和重启结果正确。对选了专用配置的编辑器/终端分别检查内容及宿主 |
| AC-12 / V-12 独立页面缩放　UI-ZOOM-01/02/03。#33、#34、#37–#39 | 从非默认 Settings 字号开始，在 Settings、Explorer、Notepad、终端等中交替操作，再按 §11.1 补齐各页。在同一窗口的两个标签/分屏、一个分离窗，分别用平台主修饰键加 `+`/`=`、`-`、`0` 与共享菜单放大、缩小、恢复。缩放中途改变 Settings 字号，复测恢复 | 每次只改变活动页或焦点内容面的实际文字/控件尺寸或图像比例。连续变化单调，到边界稳定，切回保留，恢复回现在的 Settings/内容基准。验证其他页与设置值、选区、滚动锚点、输入及窄窗可达性。菜单项带当前绑定，普通页共用入口。验证书签 0 有/无、远端捕获/释放、原生像素例外 |

**命令接入。** 主窗口已有工作区与 shell 的快捷键仲裁、Notepad 有命令目录和可配置键位。将“放大、缩小、恢复”接到同一组命令，复用当前活动页面及内容面的能力。弹出菜单前保存逻辑目标，关闭/失效后重新确认目标仍存在。普通页面由页面容器缩放内容和页内控件，有专用内容面的页面只应用一次对应变换。收到一次事件只由认领的入口消费，同时处理 WebView 默认缩放。AppKit「窗口 > 缩放」仍表示最大化。终端、DB、邮件等的局部监听在接入时一并迁移。[工作区仲裁](../../src/components/editor/workspace/shellShortcutRouter.ts) · [Notepad 键位](../../src/lib/notepad/commands/keymap.ts) · [AppKit 菜单](../../src/lib/nativeAppMenu.ts)

**设置与页面状态。** 窗口入口读取已保存的主题、界面字体与字号，订阅设置和系统主题变化，关闭时解除订阅。Portal 在所属窗口解析同一基准，虚拟列表按实际尺寸重新测量。每页临时缩放附在页面实例上，分屏有内容焦点时附在相应窗格。切回该实例复用偏移，关闭后释放，显式保存的编辑器或会话偏好继续作为内容基准。DB 现有共用字号和 Notepad 共用增量需要迁移，测试须同时打开两个实例。[主题订阅](../../src/lib/appTheme.ts) · [字体与字号同步](../../src/stores/appStore.ts) · [DB 字号](../../src/components/database/useDbSessionFontSize.ts) · [Notepad 状态](../../src/stores/notepadStore.ts)

### 11.3 本次核对的证据与待验范围

- Linux 浏览器，2026-11-25，产品提交 `70c62ebb7`。Sessions → 新建会话，读取已启用、未悬停的 `session-save` 按钮的计算样式。前景为白色。浅色渐变 `#3b82f6 → #1e40af` 两端分别为 **3.68∶1 / 8.72∶1**，深色渐变 `#8bbcff → #6aa6f8` 两端为 **1.96∶1 / 2.49∶1**。深色整段低于 4.5∶1。#31 从主按钮的前景/底色搭配修起，以 AC-10 复测文字位置和各交互状态。[会话按钮](../../src/components/session/editor/SessionEditorView.tsx) · [共用按钮样式](../../src/styles/components.css)
- 同提交的 Linux Chromium 基线 `run-20261125-113325-721348745` 通过 5 项，0 失败、0 跳过。TC-015 覆盖主题模式与持久化，TC-WS-034 覆盖 Workspace 编辑器的 Settings 外观，TC-WS-010 覆盖业务菜单，TC-NP-004 通过查看菜单放大并从状态栏恢复，TC-NP-008 覆盖 Notepad 活动/失焦选区的明暗主题。逐步结果、截图及 runner receipt 位于本地 `qa-ui-auto-report/ui-standard-v04/`。
- 6 个 Vitest 文件、54 项通过，涉及 shell 快捷键仲裁、工作区平台键位、DB 可见/隐藏时的字号键、HTML 预览、原生菜单定义及 Notepad 选区的合成对比度。对照更多既有场景可用 TC-007/019（终端）、TC-010（SFTP）、TC-013（会话树）、TC-MAIL-KEYS-01（邮件）、TC-153（VNC）及 TC-MAC-001/002/003。既有用例使用各自声明的平台和入口。[选区对比度断言](../../src/lib/notepad/cm6/notepadSelectionTheme.test.ts)
- §11.1 各页的完整动作与状态，以及 Windows、Linux、macOS 原生窗口的实际投递、系统辅助点按、IME、剪贴板、跨窗外观和缩放仍待产品批次验证。每项记录具体平台、窗口、操作和可观察结果，沿用 §10 的原生验证流程。
