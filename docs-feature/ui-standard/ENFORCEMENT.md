# UI 规范的落点、测试用例集成与执行机制

> 状态：方案 v0.2，落点与严格程度已确认（见 §8），已拆分为任务（见 §9）。配套规范见 [UI-STANDARD.md](UI-STANDARD.md)。
> 目标：让「不同 agent 写出不同风格、同类控件交互不一致、有些控件无法操作」这个问题**无法再通过评审以外的漏洞出现**。

## 1. 结论：规范放哪里

只写文档，agent 不一定会读、读了也不一定遵守。因此采用「**一份权威文档 + 多个触发点 + 自动化把关 + 共享组件落地**」四层结构，每层各司其职，内容不重复。

| 层 | 位置 | 放什么 | 为什么放这里 |
|---|---|---|---|
| ① 权威规范（唯一事实来源） | `docs-feature/ui-standard/UI-STANDARD.md`（建议最终晋升到仓库根 `UI-STANDARD.md`，与 `AGENTS.md`、`DESIGN.md` 并列） | 全部规则、规则 ID、可操作性矩阵、例外登记 | 篇幅大、需要稳定 ID 被引用，不适合塞进 `AGENTS.md` |
| ② 入口触发 | **`AGENTS.md`** 新增一节「UI & Interaction Standard」（约 20 行） | 强制性指令：改 UI 前必须读规范、必须复用共享组件、PR 必须列规则 ID、必须跑 `ui-contract` 用例 | 所有 agent 的必读入口；篇幅短，只放「必须做什么」，不放规则细节 |
| ③ 测试把关 | **`qa-ui-auto`**：`SKILL.md`、`references/authoring.md`、新增 `references/ui-standard-verification.md`、schema、`dev_contract.py`、`ui-contract` 套件 | 每条规则的验证配方、用例模板、用例必须声明 `ui_standard` 规则 ID 的要求 | 用户明确要求：规范必须体现在测试用例里；用例是唯一能阻断合并的执行点 |
| ④ 静态把关 | `scripts/ui-standard-lint.mjs` + 基线文件，接入 `pnpm check:refactor`（`pnpm build` 已包含） | 可机械检查的规则（禁用 `window.confirm`、裸 z-index、未定义令牌、硬编码色…） | 复用现有 `source-file-size.mjs` 的模式；基线只降不升，不会因历史债务阻塞开发 |
| ⑤ 组件落地 | `src/components/ui/`（Modal、Button、Tooltip、Toast、Menu 封装、Field、Tabs、Popover、Banner、EmptyState、Spinner/Progress、Kbd）+ 共享 hooks | 把规则写成代码；每个组件附 README 指向规则 ID，并带挂载单元测试 | **最有效的一层**：规则一次实现、全局生效；agent 复用即合规 |
| ⑥ 设计入口 | `feature-design`、`issue-design` skill 的设计模板；`AGENTS.md` 的 PR 指引（仓库当前没有 PR 模板文件，不新建）；`DESIGN.md` 文档归属一行 | 新增「UI 规范符合性」小节（用到的规则 ID、偏离项） | 在写代码之前就纳入，而不是评审时才发现 |
| ⑦ 对齐类 skill | `code-workspace-idea-parity`、`db-client-parity`、`vnc-realvnc-task` 等 | 一句话声明与 UI-STANDARD 的优先级（见 UI-STANDARD §0.2、§9 EXC-IDEA） | 避免「对标 IDEA/DBeaver」被当作绕过规范的理由 |

**不放的地方**：`replit.md`（项目概述，不承载约束）；`README.md`（面向使用者）。**可选**：若有人使用 Claude Code，加一个只含 `@AGENTS.md` 的 `CLAUDE.md`，保证同一入口。

### 为什么不把全部规则直接写进 `AGENTS.md`

- `AGENTS.md` 每次对话都会被完整加载，规则全文约 800 行，会稀释已有的强约束。
- 规则需要 ID 与「验证配方」，QA、设计文档、PR 都要引用；放在独立文件才能稳定引用。
- 所以 `AGENTS.md` 只做「触发 + 强制动作」。

## 2. `AGENTS.md` 拟增内容（英文，与现有风格一致）

```markdown
## UI & Interaction Standard

All user-facing UI must follow `docs-feature/ui-standard/UI-STANDARD.md` (rule IDs `UI-<AREA>-<NN>`). Read the sections for the control types you touch before writing code.

- Reuse shared components from `src/components/ui/` (Modal, Button, Tooltip, Toast, Menu, Field, Tabs, Popover). Do not hand-roll dialogs (`fixed inset-0`), menus (`role="menu"`), tooltips, toasts, or tab strips. Use `lib/appDialogs` instead of `window.alert/confirm/prompt`.
- Use only `--taomni-*` tokens for color, spacing, radius, z-index and font size. No hex colors, Tailwind palette colors, bare `z-index` numbers, or `text-[Npx]` in components.
- Every control must be fully operable: mouse, keyboard, focus-visible, disabled-with-reason, busy, empty, error, overflow, dark theme, UI font size 10–18, long en/zh text. Use the operability matrix (UI-STANDARD §6) as the checklist; keyboard-only completion of core flows is required (UI-PAT-15).
- Same concept, same behavior everywhere: Esc closes only the topmost transient layer; dialogs trap and restore focus; destructive actions follow UI-DST tiers; all strings go through `useT` (en + zh-CN).
- Every UI change adds or updates a `qa-ui-auto` case that declares `ui_standard: [<rule IDs>]` and walks the operability matrix for the touched archetype. Run the `ui-contract` tagged suite together with `crash-regression` before review. See `.agents/skills/qa-ui-auto/references/ui-standard-verification.md`.
- The PR description lists the rule IDs applied and any deviation (record deviations in UI-STANDARD §9; unregistered deviations are defects). `pnpm check:refactor` includes the UI standard lint; do not make its baseline worse.
```

## 3. 与 `qa-ui-auto` 的集成（用户要求的重点）

### 3.1 要改的文件与改动点

| 文件 | 改动 |
|---|---|
| `.agents/skills/qa-ui-auto/SKILL.md` | ① 「Choose The Work」表增加一行：UI/交互变更 → `ui-standard-verification.md`。② 「Development-Time Case Contract」增加一段 **UI Standard Gate**：UI 变更的用例必须声明 `ui_standard`，并覆盖受影响原型的可操作性矩阵；`ui-contract` 套件与 `crash-regression` 一并在评审前跑 |
| `references/authoring.md` | 「Coverage Dimensions」表新增一行 **UI standard conformance**；「Design To Implementation Handoff」中，每个用例设计必须带一列 `UI rule IDs`；新增「用例模板」小节引用下方 §3.4 |
| `references/ui-standard-verification.md`（新增） | 规则 ID → 验证配方（步骤、可用 verb、期望结果）；每种原型一个 YAML 片段；列出尚缺的 verb |
| `schema/testcase.schema.json` | 新增可选字段 `ui_standard: [UI-XXX-NN]`（pattern `^UI-[A-Z0-9]+-[0-9]{2}[a-z]?$`）；允许标签 `ui-contract` |
| `scripts/qa_ui_auto/dev_contract.py` | 增加「UI 原型特征检测」：变更的组件文件包含 `role="dialog"`、`ContextMenu`、`fixed inset-0`、`<select`、`role="tab"`、`role="tree"`、`onContextMenu`、`useModalShortcuts` 等特征时，要求同一 diff 中存在声明了 `ui_standard` 的用例；缺失输出 warning（与现有 advisory 一致），CI 可升级为 error |
| `scripts/qa_ui_auto/audit.py`（`--gate`） | 校验用例中的 `ui_standard` ID 全部存在于 `UI-STANDARD.md`（解析标题表）；被引用的 ID 覆盖率进入报告 |
| `qa-ui-auto-tests/ci/policy.yaml` / `dependencies.yaml` | 注册 `ui-contract` 标签的用例集；与 `crash-regression` 一样在产品 PR 与聚焦运行中自动选入 |
| `AGENTS.md` Testing Guidelines | 在 `crash-regression` 句后补一句 `ui-contract`（见 §2） |

### 3.2 三层测试金字塔（成本与覆盖的平衡）

直接为 100 多个对话框各写一份完整用例不现实。按下面三层组合，逐步覆盖：

| 层 | 内容 | 谁写 | 覆盖面 |
|---|---|---|---|
| **L1 共享组件单元测试** | 对 `Modal / Menu / Tooltip / Toast / Button / Tabs / Popover / Field` 各写一次挂载测试（Vitest + Testing Library），完整断言该原型在 §6 矩阵上的每一列：Esc、焦点陷阱、焦点返回、点击遮罩策略、忙碌、禁用原因、角色与可访问名、键盘导航 | 建设共享组件时一次写成 | **所有复用共享组件的功能自动合规**，成本最低、收益最高 |
| **L2 一致性清扫（registry 驱动）** | 维护 `qa-ui-auto-tests/fixtures/ui-contract-registry.yaml`：登记每个**遗留/私有**对话框、菜单、树/列表的「打开入口步骤 + 原型 + 关闭方式」。由 `ui_contract_gen.py` 按原型模板生成 `TC-UIC-<原型>-<slug>.testcase.yaml`（标签 `ui-contract, auto-generated`），逐个检查通用条目（打开后角色/名称/焦点位置 → Tab 循环 → Esc 关闭 → 焦点返回 → 遮罩点击策略 → 窄窗口可达 → 深色截图无溢出） | agent 在登记新入口时补一行；生成器产出用例 | 覆盖尚未迁移到共享组件的存量，作为迁移优先级的量化依据；**新增对话框不登记 registry 会被 lint 拦截** |
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
| 通知/进度 | 渠道选择（FBK 渠道表）→ Toast 自动消失/错误常驻、`aria-live`（FBK-01）→ 超过 2s 的操作出现取消并真正停止（FBK-04） | `wait_for`、`assert_attribute`、`assert_text` | — |
| 主题/字号/语言 | 对每个受影响界面：深色主题、界面字号 10 与 18、中文与英文长文案各截一次图并断言无溢出/无重叠（FND-04/06、I18N-02） | `screenshot`、`assert_element_geometry`、`set_viewport` | `set_ui_setting {theme, fontSize, locale}`（通过真实设置入口或受控 QA 开关）、`assert_no_overflow {selector}` |
| 拖放 | 拖动阈值、目标高亮、`Esc` 取消（DND-01/02）→ **等价的非拖放路径**能达成同一结果（DND-05） | `drag_to`、`mouse_path`、`mouse_button`、`press` | — |
| 平台 | macOS：Command 键位、原生菜单；Windows/Linux：自绘控件（UI-PLAT-01、AGENTS.md macOS 一节）。IME 与 OS 键盘投递属原生检查 | 现有 native 验证流程 | — |

### 3.4 用例声明与模板

```yaml
id: TC-EXAMPLE-001
title: 会话编辑对话框符合 UI 规范
covers: [F2.3]                  # 功能归属，沿用现有规则
tags: [ui-contract, p1]
modes: [browser]
ui_standard:                    # 新增：本用例证明的规则 ID
  - UI-DLG-03
  - UI-DLG-04
  - UI-DLG-06
  - UI-DLG-07
  - UI-DLG-10
  - UI-BTN-06
fixtures: [reset_db]
steps:
  # 1 打开 → 2 断言角色/名称 → 3 Tab 循环 → 4 Esc → 5 焦点返回 → …
verification:                   # 沿用现有 requirement/checkpoint 结构，并引用规则 ID
  - id: V1
    requirement: "UI-DLG-04/07 Esc 关闭对话框且焦点回到触发按钮"
    actions: [3, 4]
    checkpoints:
      - step: 5
        expectation: "触发按钮重新持有焦点"
    results: [5]
    review: pending
```

### 3.5 需要补充的 verb 与能力（交由实现阶段 P2，先核对 runner 能力）

`assert_focus_within`、`assert_focus_on`、`assert_selected_rows`、`assert_menu_item_state`、`assert_accessible_name`、`assert_no_overflow`、`set_ui_setting`；以及 L2 生成器 `ui_contract_gen.py`。每新增一个 verb，按 `authoring.md` 要求同步 schema、verb-catalog 与一个代表用例。

### 3.6 完成判定

- 用例通过 ≠ 规范符合：必须同时满足 ① 变更涉及的原型在 §6 矩阵中的 `●` 列均有对应断言（用 `ui_standard` ID 追溯）；② 无「未执行即标通过」；③ 平台边界明确记录（浏览器通过不代表 WKWebView/IME/原生菜单已验证）。
- 「声明了 ID 但没有断言」会被 `contracts --gate` 的既有逻辑（结果必须落在断言步骤上）拦截。

## 4. 静态检查（`scripts/ui-standard-lint.mjs`）

接入 `pnpm check:refactor`；每条规则统计「违规数」，写入 `scripts/ui-standard-baseline.json`（按文件），**只允许减少、不允许增加**；新文件基线为 0。

| 检查 | 规则 |
|---|---|
| L01 | 禁用 `window.alert/confirm/prompt`（UI-DLG-12） |
| L02 | `fixed inset-0` 仅允许出现在 `components/ui/Modal`（UI-DLG-01） |
| L03 | 使用了未在 `theme.css` 定义的 `--taomni-*`（UI-FND-02） |
| L04 | 组件内十六进制色 / Tailwind 调色板色（`bg-red-*`、`text-blue-*` 等）（UI-FND-01） |
| L05 | 裸 z-index 数字（UI-FND-09） |
| L06 | `div/span` 带 `onClick` 但没有 `role` + `tabIndex`（UI-A11Y-01） |
| L07 | `outline-none` 未同时出现 `focus-visible` 样式（UI-FOC-01） |
| L08 | JSX 文本或 placeholder/title/aria-label 含 CJK 字面量（UI-I18N-01） |
| L09 | 新增 `text-[Npx]`（UI-FND-04） |
| L10 | `<button>` 缺少 `type`（UI-BTN-02） |
| L11 | 仅含图标的 `<button>` 缺少 `aria-label`（UI-ICO-05） |
| L12 | emoji 作为图标（UI-ICO-01） |
| L13 | `role="menu"` 出现在 `ContextMenu` 之外（UI-MNU-01） |
| L14 | 新对话框未在 `ui-contract-registry.yaml` 登记（L2 配套） |

## 5. 共享组件建设计划（`src/components/ui/`）

规则能否长期生效，取决于「合规写法比不合规写法更省事」。

| 组件/Hook | 来源 | 说明 |
|---|---|---|
| `Modal` | 抽取 `ConfirmDialog` 与 `useModalShortcuts/Draggable` | 一次实现 DLG-01…DLG-16；`ConfirmDialog` 等改为其薄封装，并修正危险确认焦点（DLG-06） |
| `Button` / `IconButton` / `SplitButton` / `SegmentedControl` | 抽取 `.taomni-btn` | 变体、busy、disabled 原因、Tooltip 联动 |
| `Tooltip` | 新建 | 取代图标按钮的原生 `title` |
| `Toast` + `useToast` | 新建 | UI-FBK-01 |
| `Menu` | 封装 `ContextMenu/MenuSurface` | 加入 role 语义、`Menu` 键/`Shift+F10`、禁用原因 |
| `Popover` / `Combobox` | 新建 | UI-POP、UI-SEL |
| `Field` / `FormRow` / `Checkbox` / `Radio` / `Switch` | 抽取 `.taomni-input/checkbox/radio` | 标签、错误、说明、`aria-*` 自动接线 |
| `Tabs` | 合并 `taomni-tab`/`taomni-section-tab`/私有实现 | 三类标签（TAB-01） |
| `Banner` / `EmptyState` / `Spinner` / `Progress` / `Kbd` | 新建或抽取 | UI-FBK |
| `useFocusReturn` / `useFocusTrap` / `useEscapeLayer`（层栈） / `useRovingFocus` / `useSelectionModel` | 提升 `editor/workspace/useFocusReturn`、新建 | 实现 Esc 阶梯与列表选择模型，树/列表复用 |
| `formatShortcut` / `formatBytes` / `formatDate` | 收敛现有分散实现 | UI-PLAT-01、UI-I18N-03 |

每个组件：README（对应规则 ID）+ 挂载测试（即 L1）+ 示例用例。

## 6. 分阶段推进

| 阶段 | 内容 | 风险 | 产出 |
|---|---|---|---|
| 0 | 评审并确认本规范与落点（本文） | 无 | 定稿的 UI-STANDARD、已确定的落点 |
| 1 基础 | 补齐/迁移设计令牌（danger、overlay、focus-ring、z 层、字号、半径）；字号映射由 `[role=dialog]` 升级为全局；`AGENTS.md` 增节；`qa-ui-auto` 文档与 schema 更新；`ui-standard-lint` 与基线 | 低（以文档与令牌为主，行为不变） | 约束开始生效，存量不增长 |
| 2 共享组件 | `Modal`、`Button`、`Tooltip`、`Toast`、`Menu` 封装、`Field`、`Tabs` + L1 测试；新增 verb | 中（需覆盖已有用例回归） | 新代码可零成本合规 |
| 3 迁移 | 按原型逐批迁移并通过 L2 清扫：①`window.confirm` 清零 ②对话框（约 93 个） ③下拉/复选 ④树/列表/表格 ⑤标签页 ⑥Tao Home 收敛 | 中高（每批跑 `crash-regression` + 受影响功能用例） | 基线逐步下降 |
| 4 收紧 | lint 基线归零后改为硬性失败；`dev_contract` 的 UI 检查由 warning 升级为 error | 低 | 长期稳态 |

建议将阶段 1、2、3 各拆为独立任务（3 内按原型再拆），阶段间用依赖串联，避免多个 agent 同时改同一批文件。

## 7. 现有差距清单（2026-11-17 近似值，供优先级排序）

| 优先级 | 差距 | 规模 | 为何优先 |
|---|---|---|---|
| P0 | `window.confirm/alert/prompt` | 约 19 个文件 | macOS 上功能静默失效，属「不能操作」 |
| P0 | 无 Esc 的对话框 | 约 21 个 | 键盘无法退出 |
| P0 | 可点击 `div/span` 无角色/键盘 | 约 12–14 处 | 键盘与读屏完全无法操作 |
| P0 | 未定义令牌导致悬停/状态失效 | 25 个变量、数百处引用 | 视觉反馈静默丢失 |
| P1 | 对话框自绘（遮罩、z-index、尺寸、焦点各异） | 约 97 个 | 风格与交互不一致的主因 |
| P1 | 危险确认默认焦点在确认按钮 | `ConfirmDialog` 及其派生 | 误触即删除 |
| P1 | 私有菜单实现 | 14 个文件 | 键盘行为与关闭条件不一致 |
| P1 | 图标按钮只有 `title` | 约 1266 处 | 键盘看不到提示 |
| P1 | 字号不随界面字号缩放 | 对话框外大量 `text-[Npx]` | 字号 18 时布局溢出 |
| P2 | 颜色硬编码与 Tailwind 调色板色 | 约 511 + 约 80 处 | 深色主题不一致 |
| P2 | z-index 70+ 取值 | 全局 | 偶发层级遮挡 |
| P2 | 中文字面量绕过 i18n | 94 个文件 | 英文界面出现中文 |
| P2 | Tao Home 独立方言 | `taoHome*.css` | 视觉不统一 |

## 8. 已确认的决策

| 决策 | 结论 |
|---|---|
| 规范位置 | 保持在 `docs-feature/ui-standard/`，不晋升到仓库根；`AGENTS.md`、`DESIGN.md`、skill 均指向该路径 |
| lint 严格程度 | 「只降不升」基线：按文件记录违规数，允许减少、不允许增加，新文件基线为 0；基线归零后才改为硬性失败（阶段 4） |
| 本轮范围 | 只产出文档与任务拆分，不执行任何实施（不改 `AGENTS.md`、`qa-ui-auto`、令牌、lint、组件） |
| 规范语言 | 规范正文中文；`AGENTS.md` 新增节英文（沿用，用户未异议） |
| `CLAUDE.md` 指针 | 未决定，默认不新增；如需要由任务 1 之后单独提出 |
| `dev_contract` 的 UI 检查 | 先 warning，阶段 4 升级为 error（沿用推荐） |

## 9. 任务拆分

实施按下表拆为 10 个任务，依赖关系用于避免多个 agent 同时修改同一批文件。每个任务都必须遵守 `UI-STANDARD.md`，并按 `AGENTS.md` 在评审前运行 `crash-regression` 套件及受影响功能用例。

| # | 任务 | 对应阶段 | 依赖 | 主要改动范围 |
|---|---|---|---|---|
| 1 | 规范治理与 QA 门禁（文档、schema、`dev_contract`、`audit`、`ui-contract` 套件登记） | 1 | 无 | `AGENTS.md`、`DESIGN.md`、`qa-ui-auto` 文档与脚本、设计类 skill |
| 2 | 设计令牌补齐与 UI 规范 lint 基线 | 1 | 无 | `src/styles/`、`scripts/`、`package.json` |
| 3 | QA 新增断言动词与一致性清扫生成器（L2） | 2 | 1 | `qa-ui-auto` 脚本与 schema、registry 夹具 |
| 4 | 共享浮层原语：Modal、焦点/Esc 层栈、Menu 封装、Popover | 2 | 2 | `src/components/ui/`（浮层部分）、`src/hooks/` |
| 5 | 共享控件原语：Button、Tooltip、Toast、Field/复选/单选/Switch、Tabs、Banner 等 | 2 | 2 | `src/components/ui/`（控件部分）、格式化函数 |
| 6 | P0 可操作性修复：原生 confirm/alert/prompt、无 Esc 对话框、可点击 div | 3 | 2 | 约 19 + 21 + 14 个文件，仅做最小修复 |
| 7 | 对话框迁移到共享 Modal（按功能分批） | 3 | 3、4、6 | 对话框组件与对应用例 |
| 8 | 菜单、标签页、下拉、复选框、Tooltip 迁移 | 3 | 5、7 | 各功能模块的菜单/标签/选择类控件 |
| 9 | 树、列表、表格的选择模型与键盘导航统一 | 3 | 8 | Explorer、SFTP、会话树、DB 网格等 |
| 10 | 颜色/字号/z-index/i18n 清扫与收紧 lint | 4 | 9 | 全局样式清扫、Tao Home 收敛、基线归零后硬性失败 |

任务编号对应项目任务板：表中 1–10 依次为 #30–#39。

并行关系：任务 1 与 2 可同时进行；任务 3、4、5、6 在各自依赖满足后可并行（任务 4 与 5 位于 `src/components/ui/` 的不同文件，各自维护导出）；任务 7 起按依赖串行，避免同文件冲突。

已知环境事项：当前沙箱缺少 `node_modules/@tanstack/react-virtual`，浏览器预览会 500，需要 `pnpm install` 后才能做浏览器验证（任务 1 起均可能受影响，执行者先确认）。
