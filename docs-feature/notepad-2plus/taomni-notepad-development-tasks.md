# Taomni Notepad 工作台 开发任务板

日期：2026-11-21（修订 2：纳入用户对 DEC-01～04 的答复，新增 NP-25/NP-26）。状态：**设计完成，尚未开始任何开发；所有任务为“待开始”，所有 V-* 为“待执行”**

- 设计依据：[taomni-notepad-detailed-design.md](taomni-notepad-detailed-design.md)（以下称“设计”；每个任务的完整交接说明在设计 §6，验收在 §3，测试在 §7，真机手册在 §8）
- 原型：[taomni-notepad-prototype.html](taomni-notepad-prototype.html)（设计产物，不是实现，不证明任何验收）
- 功能决策来源：[taomni-notepad-decisions.md](taomni-notepad-decisions.md)（89 支持 / 43 不支持 / 1 待定）
- 任务 ID 稳定：`TASK-NP-xx`；`AC-*`、`V-*`、`DEC-*` 与设计一致。
- 优先级沿用决策表 P0/P1/P2（任务优先级取其所含功能的最高者）；与“阻断/高/中”类缺陷等级无关。
- 实施前必须重新核对源码：设计 §2 来自 2026-11-21 的只读调研。

## 1. 决策状态

用户已答复 DEC-01～DEC-04；本次修订把答复与两项新要求并入设计。

| DEC | 问题 | 结论 | 状态 | 影响的任务 |
|---|---|---|---|---|
| DEC-01 | 宿主架构 | **A：每个文件一个应用标签**；宿主放在 file explorer（另一分支开发）；`NotepadEditor` 经 `NotepadHost` 接口接入，不新增 TabKind | 用户已定 | NP-15、NP-01、NP-16/17 |
| DEC-02 | 面板停靠 | **限定型**（右/底/浮动），F-70 缩范围已接受 | 用户已定 | NP-17 |
| DEC-03 | 移至回收站 | **实现**（F-03 转为支持，共 90 项功能） | 用户已定 | NP-04、S-6 |
| DEC-04 | 书签是否统一 | **先保持两套** | 用户已定 | NP-14 |
| DEC-19 | 宿主接口 | 复用 `file-viewer` 标签 + `NotepadHost`；含一条对“宿主放到 file explorer 上”的假设 | agent 自决 | NP-15 |
| DEC-20 | viewer 文本编辑迁移 | 旧 `TextEditor` 迁移到 Notepad 后移除；Markdown/图片/HTML 不动 | 用户已定（方向）+ agent 自决（细节） | NP-25 |
| DEC-21 | 打开方式选择器 | 系统默认 / Code editor / Notepad / TaOffice（开发中，禁用） | 用户已定（选项）+ agent 自决（注册表） | NP-26 |
| DEC-22 | 一文件一标签下的 F-55～F-60、F-64 降级 | 推荐接受降级 | **待用户确认**（不阻塞开工） | NP-15 |

DEC-22 未确认前：不得把“降级后的范围”写成“用户已确认”；NP-15 只实现宿主已提供之外必要的部分（标签内分屏、窗口菜单、文档列表）。


## 2. 任务板

状态取值：待开始 / 进行中 / 已实现待验证 / 已验证 / 阻塞。当前全部“待开始”。

| 任务 | 目标 | 优先级 | 覆盖功能 | AC | V | 依赖 | 阻塞决策 | 状态 |
|---|---|---|---|---|---|---|---|---|
| TASK-NP-00 | 技术 spike S-1～S-6（S-1：`documentStore` 容纳未命名文档；S-2：标签内两视图共享状态），产出结论文档 | P0 | — | AC-01 AC-13 AC-16 AC-33 AC-36 | V-39 | 无 | — | 待开始 |
| TASK-NP-01 | `untitled:` 文档键与 `notepadStore`（Notepad 专有状态；不持有文档内容、标签顺序） | P0 | 基础设施 | AC-01 AC-33 | V-01 V-02 | NP-00（S-1） | — | 待开始 |
| TASK-NP-02 | 共享文本变换纯函数 | P0 | F-29～F-33 | AC-20 AC-21 AC-22 | V-03～V-06 | 无 | — | 待开始 |
| TASK-NP-03 | 命令注册表、键位、基础编辑接线 | P0 | F-17 F-18 F-21 | AC-17 AC-45 | V-07 V-08 | NP-01 NP-02 | — | 待开始 |
| TASK-NP-04 | 文件生命周期（新建/打开/保存/另存/副本/全部保存/重命名/关闭系列/回收站） | P0 | F-01 F-02 F-03 | AC-01 AC-02 AC-03 | V-09 V-10 | NP-01（关闭系列用 NP-15 的 `NotepadHost`，可先用桩） | — | 待开始 |
| TASK-NP-05 | 最近文件 | P0 | F-04 | AC-04 | V-11 | NP-04 | — | 待开始 |
| TASK-NP-06 | 编码识别/重解释/转换与 EOL | P0 | F-10 F-11 F-12 | AC-10 AC-11 AC-12 | V-12 V-13 | NP-01 | — | 待开始 |
| TASK-NP-07 | 外部变更、重载、只读 | P0 | F-09 F-35 | AC-09 AC-23 | V-14 V-15 | NP-01 NP-04 | — | 待开始 |
| TASK-NP-08 | 会话与启动恢复 | P0 | F-05 F-06 | AC-05 AC-06 | V-16 V-17 | NP-01 NP-04 NP-05 | — | 待开始 |
| TASK-NP-09 | 自动备份、保存时备份、草稿迁移 | P0 | F-07 F-08 | AC-07 AC-08 | V-18 V-19 V-41 | NP-01 NP-04 | — | 待开始 |
| TASK-NP-10 | 剪贴板历史、特殊粘贴、选区与多光标、拖动文本 | P1 | F-19 F-20 F-22 F-28 F-34 | AC-18 AC-19 | V-20 | NP-02 NP-03 | — | 待开始 |
| TASK-NP-11 | 插入日期、INS/OVR、虚拟空格、矩形选择、列编辑器 | P1 | F-23 F-24 F-25 F-26 F-27 | AC-19 AC-20 | V-21 | NP-03 | — | 待开始 |
| TASK-NP-12 | 查找替换核心、增量、正则、历史、转到 | P0 | F-37 F-38 F-43 F-44 F-46 F-47 F-48 F-49 F-54 | AC-25 AC-26 AC-30 | V-22 V-23 | NP-02 NP-03 | — | 待开始 |
| TASK-NP-13 | 跨文件、全部查找、所有文档替换、结果面板、Mark、令牌样式 | P0 | F-39 F-40 F-41 F-42 F-45 F-52 | AC-27 AC-28 AC-29 | V-24 V-25 | NP-12 | — | 待开始 |
| TASK-NP-14 | 书签与变更历史 | P1 | F-36 F-50 F-51 F-53 | AC-24 AC-31 | V-26 | NP-12 | — | 待开始 |
| TASK-NP-15 | 宿主适配与标签内分屏：`NotepadHost`、`viewerTabHost`、同路径去重、标题/已修改回写、窗口菜单与文档列表、分屏/克隆/旋转/同步滚动 | P0 | F-55 F-56 F-57 F-58 F-59 F-60 F-64（范围见 DEC-22） | AC-32 AC-33 AC-36 | V-30 V-31 V-46 | NP-00（S-1 S-2） NP-01 | DEC-22 待确认（不阻塞） | 待开始 |
| TASK-NP-16 | 视图设置：全屏/Post-It/专注、行号/标尺、换行/缩放、符号、主题/栏、摘要 | P0 | F-61 F-62 F-65 F-66 F-67 F-68 F-69 | AC-34 AC-35 AC-37 | V-32 | NP-03 NP-15 | — | 待开始 |
| TASK-NP-17 | 文档地图与面板停靠 | P1 | F-63 F-70 | AC-36 | V-33 | NP-00（S-3） NP-15 | — | 待开始 |
| TASK-NP-18 | 链接与文本工具箱 | P2 | F-71～F-78 | AC-38 AC-39 | V-34 | NP-02 NP-03 | — | 待开始 |
| TASK-NP-19 | 宏：录制/回放/保存/管理/安全 | P1 | F-79～F-83 | AC-40 AC-41 AC-42 | V-27～V-29 | NP-03 | — | 待开始 |
| TASK-NP-20 | 文件对比 | P1 | F-84 | AC-43 | V-35 | NP-01 | — | 待开始 |
| TASK-NP-21 | 打印、打印设置、打印到 PDF | P1 | F-85 F-86 F-87 | AC-44 | V-36 | NP-03 | — | 待开始 |
| TASK-NP-22 | 首选项、快捷键映射器、新建默认值 | P1 | F-88 F-89 F-90 | AC-45 | V-37 | NP-03 NP-19 | — | 待开始 |
| TASK-NP-23 | 拖放、外部打开、提权保存、大文件降级 | P1 | F-13 F-14 F-15 F-16 | AC-13～AC-16 | V-40 | NP-00（S-4 S-5） NP-04 NP-06 | — | 待开始 |
| TASK-NP-24 | 集成、回归、崩溃回归、qa-ui-auto 用例、三端构建与真机 | P0 | 全部 | AC-46 AC-47 及全部 | V-38 V-41 V-42 V-43～V-45 | 全部前序（含 NP-25 NP-26） | — | 待开始 |
| TASK-NP-25 | viewer 文本编辑迁移到 Notepad：`ViewerShell` 文本分支改挂 `NotepadEditor`，删除 `TextEditor`，草稿迁移，更新既有测试 | P0 | 用户新增要求（DEC-20） | AC-48 AC-46 | V-47 V-48 V-37 V-41 V-51 | NP-15 NP-04 NP-06 NP-07 NP-09 NP-23 NP-26 | — | 待开始 |
| TASK-NP-26 | 打开方式选择器：`FileHandler` 增 notepad/taoffice、注册表、Explorer 菜单与设置、TaOffice 占位（开发中） | P0 | 用户新增要求（DEC-21） | AC-49 | V-49 V-50 V-51 | 注册表/设置可立即开始；Notepad 选项接 NP-15；TaOffice 契约待另一团队 | — | 待开始 |

## 3. 建议波次（依赖允许的并行）

| 波次 | 可开始的任务 | 前置 |
|---|---|---|
| 0 | NP-00（六个 spike 可并行）、NP-02 | 无 |
| 1 | NP-01；NP-26 的注册表/设置/菜单部分（先与 file explorer 分支对齐） | S-1 结论 |
| 2 | NP-03、NP-04、NP-06、NP-20 | NP-01（NP-03 还需 NP-02） |
| 3 | NP-05、NP-07、NP-09、NP-10、NP-11、NP-12、NP-15、NP-18、NP-19、NP-21 | NP-03/NP-04；NP-15 还需 S-2 |
| 4 | NP-08、NP-13、NP-14、NP-16、NP-17、NP-22、NP-23 | NP-05/NP-12/NP-15/NP-19/S-3/S-4/S-5 |
| 5 | NP-25（切换点：Notepad 对旧编辑器功能对等后） | NP-15/04/06/07/09/23/26 |
| 6 | NP-24 | 全部 |


共享文件协调：`notepadStore.ts` 仅 NP-01 改；`src/lib/notepad/commands/` 的注册入口由 NP-03 先合入后其他任务只追加；`src-tauri/src/commands/viewer.rs` 若超过 800 行，新增 IPC 一律放到 `commands/notepad.rs`；`src/stubs/commands/*` 每个 IPC 任务各自补齐自己的 stub。 `fileOpenMenu.tsx`、`FileOpenSettings.tsx`、`ExplorerCommandBar.tsx`、`openFile/index.ts` 与 file explorer 分支并行改动：NP-26 开工前先对齐，新接口放 `src/lib/openFile/handlers.ts`；`ViewerShell.tsx` 只由 NP-15（接线）与 NP-25（切换）依次修改。

## 4. 每个任务的通用完成条件

1. 对应 AC 在真实应用或其明确指定的测试层上满足；原型和 browser stub 不能单独证明真实文件系统、提权、回收站、打印行为。
2. 对应 V-* 已执行并把命令、结果和产物路径回填到设计 §9；未执行保持“待执行”。
3. 新增文件 ≤ 800 行；跑过 `pnpm check:refactor`。
4. 触及命令/IPC/持久化的任务跑崩溃回归（V-41）。
5. 新增 IPC 同步 `src/stubs/commands/` 与 `src/stubs/tauri-core.ts`。
6. 43 项“不支持”功能没有任何 UI 入口（V-38）。
7. 三端条件编译检查通过；当前端（Linux）真机验证由 NP-24 汇总，Windows / macOS 未执行的保持“未验证”。

## 5. 与设计、原型的一致性约束

- 任何任务若改变设计 §3 的 AC、§4.1 的决策或 §4.5 的接口，必须先更新设计并保留 ID 和变更原因。
- 原型 v3 按 DEC-01=A、DEC-02=限定型、DEC-03=实现绘制；DEC-22 尚待确认，原型按推荐画出。v1/v2（专属工作台标签）已被替代，不得继续当作有效图稿。
- 标记（Mark）是否随会话保存、正则方言差异清单、`Ctrl+Tab` 在 WebView 的可用性是实施中必须关闭的评审项（设计 §10）。
