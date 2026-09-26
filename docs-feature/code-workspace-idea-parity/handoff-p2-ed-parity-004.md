# P2 交接：ED-PARITY-004 Keymap 改键冲突、取消与重开

> ## ✅ 当前状态：可领取
>
> 本卡为 `status=ready` + `p0.planning_required=false`，**无开发 owner**，可由 P2 正式 `claim`。
> 唯一任务板：`docs-feature/code-workspace-idea-parity/backlog.md`，ID `ED-PARITY-004`。
>
> **IDEA 参照已部分实测**（`2026.2.3 / IU-262.10968.63`，13 张原件），并据此修正了 DEC-02/03/04。
> 剩余未观测项属**执行期证据**，由 P2 在**隔离 config 实例**上补齐（见参照包 §5/§6），**不阻塞领取**。
>
> **P1 只做规划：本卡所有产品验证均未执行，`ready` 不代表功能/UI/交互已对齐。**
> 不得借用任何历史卡的 owner/状态/证据；不得回退旧板或改选其他卡。

---

## 1. 交接输入（全部按模板填写）

- **任务板与 ID**：`docs-feature/code-workspace-idea-parity/backlog.md`，ID **`ED-PARITY-004`**，
  当前状态 **`ready`** / `p0.planning_required=false`（无开发 owner）。所有 task-board 命令显式带 `--doc`。
- **目标范围与用户结果**：REQ-10 / CW-SET-002。一个已有动作的改键 → 冲突提示 → 取消/应用 → 重开的连续序列。
  用户把动作改到已被占用的组合键上时，**捕获控件内立即出现指名占用者的冲突区**（列出全部冲突、可滚动），
  且**不阻断**录入；取消则草稿原样恢复；确认并 Apply 后该组合键**只有一个主人**；
  Apply 是唯一提交边界，关闭重开读到生效值。
- **目标 IDEA 与参考包**：`IntelliJ IDEA 2026.2.3 / IU-262.10968.63` Ultimate（用户 2026-09-24 接受，
  取代 P0 初固定的 2026.2.2 build；observed 必须标注 2026.2.3）。
  参考包：[references/ed-parity-004-reference.md](references/ed-parity-004-reference.md) — **`partially-observed`**，
  §3 为实测结论，§4 为双侧对照表，§5 为诚实缺口，§6 为剩余补采步骤。
- **设计、DEC、AC/V**：[keymap-rebind-conflict-plan.md](keymap-rebind-conflict-plan.md#ed-parity-004)；
  `DEC-01..DEC-09`、`ED-PARITY-004-A1..A3`、`V1..V5`、`S0..S8`、**完整用例设计在
  [`test-cases` 锚点](keymap-rebind-conflict-plan.md#test-cases)**。
- **必须保留**（改前依据见各项括注）：
  1. 默认 scheme 隐式 fork、Reset/Delete 语义、corrupt 载荷隔离降级 — `workspaceKeymapScheme.ts` + `CodeWorkspaceTab.tsx:15661-15703`。
  2. user-disabled 动作在 Search/Keymap **仍可见**并带 `Disabled in Keymap` — `workspaceActionHostKeymap.test.ts:82`。
  3. 纯物理键匹配（`code` 优先 `key`）、裸 F5/F11/F12/Tab/Space 不可绑定 — `workspaceKeymapScheme.test.ts:42,55`。
  4. `EDITOR_RETAINED_BINDING_ALLOWLIST` 六族保留理由 — `workspaceCodeMirrorKeymap.ts:748-773`。
  5. Shell 已交付 `Control+Shift+N` / `Control+Alt+/` — `CodeWorkspaceTab.tsx:13763,15402`。
  6. `debugEditorChrome.debuggerKeymap` 为独立通路，**不在本卡 owner 内，不得顺带改**。
  7. `KeymapSettingsDialog.test.tsx` 现有 4 例与 `TC-IDE-CW-UI-01` 必须保持通过。
- **文件/模块 owner 与依赖**：
  - 本卡主 owner：`src/components/editor/workspace/KeymapSettingsDialog.tsx`
  - 共享模型：`workspaceKeymapScheme.ts`（新增冲突/位移纯函数）
  - 共享 host：`workspaceActionHost.ts`、`workspaceCodeMirrorKeymap.ts`（DEC-05 三入口冲突语义）
  - 共享消费者：`KeymapCheatSheetDialog.tsx`、`CodeWorkspaceTab.tsx`（接线）
  - 边界不改：`debugEditorChrome.ts`
  - **依赖**：`depends_on=[]`，无跨卡依赖。`[]` 不代表环境已就绪——§1 阻塞项是环境前置。
  - 无 Rust / 无 IPC / 无 provider 变更。
- **用例设计与验证材料**：见 [`test-cases`](keymap-rebind-conflict-plan.md#test-cases) §10。
  AC→V→路径映射摘要：

  | V | AC | 用例 | 状态 |
  |---|---|---|---|
  | V1 | A1.1–A1.4, A1.6 | `TC-IDE-C1-01`（改写）+ `TC-IDE-PARITY-004-01` + `KeymapSettingsDialog.test.tsx`（扩展） | P2 待实现/扩展 |
  | V2 | A1.5 | `TC-IDE-PARITY-004-04`（**native**） | P2 待实现 |
  | V3 | A2.1–A2.4 | `compare_idea.py` 双侧对照 | **阻塞** |
  | V4 | A3.1, A3.2, A3.4, A3.5 | `TC-IDE-PARITY-004-03` + `workspaceKeymapScheme.test.ts`（扩展）+ `workspaceActionHostKeymap.test.ts`（保留） | P2 待实现/扩展 |
  | V5 | A3.3 | `TC-IDE-PARITY-004-03`（`compose_text`）+ native 真实 IME | P2 待实现 |

  全部标 `P2 待实现` 的文件**尚不存在**，不冒充已有测试。**所有产品验证当前均为未执行。**
- **执行环境**：Windows 11 / WebView2（当前端）。browser 用 Vite（`.agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml`）；
  native 需 QA 二进制 `src-tauri/target/qa-ui-auto/debug/taomni.exe` 或经 `native_build.py` 构建。
- **修改权限**：允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；**不提交、不推送**。
- **当前工作区或交接**：分支 `docs/code-workspace-idea-audit-20260913`，HEAD `2b2def51d75f9aee089279039946aa6957b258de`，
  接手 clean。本轮 P1 只新增/修改文档，**无产品代码 diff**。

## 2. P2 提示词模板（**可直接使用**）

```text
你负责完成随附任务板和 ID 的一个 Taomni Code Workspace IDEA 对齐工作包，包括实现、范围内故障修复、集成、自检和必要当前端验证。

本轮只允许领取 docs-feature/code-workspace-idea-parity/backlog.md 中的 ED-PARITY-004 新卡，
并且 p0.planning_required=false、status=ready/implemented、依赖全 done。若交接给你时该卡不是 ready，
返回该状态，不要改选其他卡、不要借用历史卡的证据。所有 task-board 命令显式带上述 --doc。

目标是在本轮范围内通过必要重构与能力完善，使功能、UI 和交互与目标 IDEA 高度一致；沿用总需求的
场景 ID 和验收目标，当前布局不是保留约束，已有正确能力和数据契约必须保留。

【本轮输入】
- 任务板与 ID：docs-feature/code-workspace-idea-parity/backlog.md，ID ED-PARITY-004
- 目标范围与用户结果：REQ-10 / CW-SET-002；一个已有动作的改键 → 冲突提示 → 取消/应用 → 重开连续序列
- 目标 IDEA 与参考包：IntelliJ IDEA 2026.2.3 / IU-262.10968.63 Ultimate（已部分实测，见参照包 §3）；
  docs-feature/code-workspace-idea-parity/references/ed-parity-004-reference.md
- 设计、DEC、AC/V：docs-feature/code-workspace-idea-parity/keymap-rebind-conflict-plan.md#ed-parity-004
  DEC-01..DEC-09、ED-PARITY-004-A1..A3、V1..V5、S0..S8
- 必须保留：默认 scheme 隐式 fork / Reset / Delete / corrupt 降级；user-disabled 仍可见；
  物理键匹配与保留绑定不可绑定；EDITOR_RETAINED_BINDING_ALLOWLIST 六族；
  Shell 的 Control+Shift+N 与 Control+Alt+/；debuggerKeymap 独立通路不动；
  KeymapSettingsDialog.test.tsx 现有 4 例与 TC-IDE-CW-UI-01 保持通过
- 文件/模块 owner 与依赖：KeymapSettingsDialog.tsx（主）；workspaceKeymapScheme.ts、workspaceActionHost.ts、
  workspaceCodeMirrorKeymap.ts（共享）；KeymapCheatSheetDialog.tsx、CodeWorkspaceTab.tsx（消费者）；
  debugEditorChrome.ts（边界不改）；depends_on=[]
- 用例设计与验证材料：docs-feature/code-workspace-idea-parity/keymap-rebind-conflict-plan.md#test-cases
- 执行环境：当前 Windows 宿主（Windows 11 / WebView2）；IDEA 补采需用隔离 config 实例（参照包 §6.1），
  不得再改写用户真实 %APPDATA% profile（2026-09-24 采样已确认全程只 Cancel、未产生任何 keymap*.xml）
- 修改权限：允许本卡产品代码、测试、文档、自有任务状态及必要构建/验证；不提交推送
- 当前工作区或交接：分支 docs/code-workspace-idea-audit-20260913，
  HEAD 2b2def51d75f9aee089279039946aa6957b258de，P1 仅文档改动

先读取适用 AGENTS.md、$code-workspace-idea-task 和 $qa-ui-auto；按需读取 $code-workspace-idea-parity、
$idea-reference 及设计 skill 的有效材料。不要自行委派其他 agent。核对任务、依赖、HEAD、生产代码和
工作区后，按 task lifecycle 领取或接续；不是可领取/可接续状态、依赖未满足或 ID 不准确时不要另造任务，
返回精确缺口。done 卡不得重领。

【测试用例实现与验证】
必读 .agents/skills/qa-ui-auto/references/authoring.md（含 Design To Implementation Handoff）和
efficient-verification.md；改既有行为读 regression-protection.md，写 YAML 前核对 schema 和 verb-catalog.md。
先读取 P1 交付的完整用例设计（keymap-rebind-conflict-plan.md#test-cases），核对每个 AC 的目标及保留行为断言。
优先 browser 实现完整 UI、控件操作、Action 多入口及快捷键覆盖；逐项核对覆盖维度矩阵并补齐
实际受影响的入口/状态/绑定，包含异常恢复和保留行为。操作真实控件、实际按下快捷键并断言用户结果，
不能以 handler 单测、控件触达或一次菜单点击替代入口/快捷键验证。
把选定 UI 工作流落实到 qa-ui-auto-tests/cases/TC-<id>-<slug>.testcase.yaml，复用足够的现有用例；
TC-IDE-C1-01 需改写（其 description 声称 conflict 但步骤从未制造冲突）。
同步 qa-ui-auto-tests/feature-list.md 的 feature/controls；只在 controls 变化时重生成 testid-catalog.md，
批次结束按 authoring.md 做一次 audit --gate。
按最小充分集合执行目标与保留行为检查，核对实际选中及 pass/fail/skip 数、summary/receipt 和证据身份。
运行原件保存 qa-ui-auto-report/（不入库），回填 AC→V→实际 test/case→报告/断言。

你与用户及其他 agent 共用工作区。保留已有改动，只修改本卡 owner 范围；共享接口确需调整时
先核对现状并最小化影响。未经授权不提交、推送、合并或发布。

按目标 IDEA 参考和设计在真实生产入口实施。当前布局、组件、菜单、样式和交互可以重构，不能用当前
错误实现反推验收，也不能把 fixture、experimental 或 mock 冒充生产能力。明确有意改变与必须保留的
行为；检查共享状态唯一 owner、动作路由、异步取消/迟到结果、焦点/快捷键抢占、保存/撤销/恢复。

发现失败、回归或耗时异常时由你在本轮内先归因：保留原始报告，区分产品退化、测试期望错误、设施
故障、依赖缺失和 stale 证据；用最小复现和区分性检查定位，不直接跑全套。授权范围内的本卡回归直接
修复并复验；不得删除步骤、放宽断言、扩大超时或改变期望来制造通过。

快速迭代使用定向单测、挂载或 browser。只有本轮断言确需验证真实应用重启后的 profile 持久化
（TC-IDE-PARITY-004-04）或真实 IME 时才补 native；已有明确 native AC 必须履行。
纯 renderer 可见变化默认用 browser 充分验证，不因“桌面交付”自动要求 native smoke。
确需 native 时，稳定相关代码/测试后检查 QA binary 身份与复用条件，再集中构建或复用并运行必要场景。

涉及可见变化时，用匹配 fixture、操作、窗口、缩放、字体、主题和平台复核 Taomni 与 IDEA 的关键状态；
分别判断功能、UI 和交互，记录已接受差异和仍阻塞目标的差异。执行真实桌面输入前确认目标窗口和焦点，
锁屏时不得自动解锁。

完成本卡目标、保留行为和当前端必要证据后，如实更新自己领取的任务状态并校验记录。Windows、macOS、
Linux 都在兼容范围；本轮完成当前端，其他端标为未验证并给出步骤。若条件不足，不得把部分通过写成 done。

最终交付：任务板路径/ID/最终状态；代码身份和生产效果链；变更文件与有意改变/保留行为；目标 AC 和
回归到测试/报告的映射；实际命令、平台、模式、构建或复用次数及耗时；功能/UI/交互自检结论；失败、
stale、skip、未验证和外部条件；是否提交/推送。不要自动启动 P3 或安排其他 agent。

交付时附总需求矩阵对应的场景 ID（CW-SET-002）、差距是否关闭及依据，供 P0 增量更新；
任务完成不直接换算为整体对齐。
```

## 3. 本轮 P1 已完成 / 未完成

**已完成**：生产源码逐符号复核；D1/D2/D3 三个**已证实**缺陷与 R1/R2 两个**待归因**风险的分离；
DEC-01..09；A1..A3；V1..V5；S0..S8；`test-cases` 完整用例设计（含覆盖维度矩阵与逐例执行说明）；
目标 build 裁决；环境身份与桌面占用状态的真实探测。

**已完成（补采后）**：IDEA 侧六组决定性状态实测 → A1.1/A1.2 的对照锚点已确立，DEC-02/03/04 已按实测修正。

**仍需 P2 补采（执行期证据，不阻塞领取）**：Apply 之后的生效/归属/重开状态、Reset 与删除 scheme 的确切标签、
键帽 chip 精确几何、macOS/Linux、干净 IME 会话——参照包 §5/§6。

**未执行（本轮权限内不应执行）**：任何产品测试、构建、Taomni/browser/native runner、开发领取、实现、
提交/推送。（IDEA 桌面输入已按用户 2026-09-24 授权完成，仅作参照采样，未触碰产品代码。）
