# Workspace Shell 实施任务

设计：[详细设计](./workspace-shell-ux-redesign-design.md) · [用例](./workspace-shell-ux-redesign-test-cases.md)。

领取者：Codex。基线：`5fb098474f072f4e0c7e99407ab0d072b7d49c53`，分支 `feat/ui-layout-refactor`。
用户已授权实现、本地单元测试、推送及 `qa-ui-auto-platforms` browser/native 循环验证。
状态：`todo` → `in_progress` → `verification` → `done`；只有最终输入对应的实际验证满足验收后才标记 done。

| 任务 | 状态 | 依赖 | 交付 / 验证证据 |
|---|---|---|---|
| TASK-01 契约与纯模型 | in_progress | 无 | 已领取；类型、身份、尺寸策略、Shell store |
| TASK-02 壳层布局集成 | in_progress | 01 | Rail / Navigator / MainLayout / ControlBar |
| TASK-03 标签与 action 路由 | in_progress | 01,04 | lane、总览、快速切换、快捷键 |
| TASK-04 实例与关闭事务 | in_progress | 01 | stable surface、close coordinator、DB adapter |
| TASK-05 SFTP 与任务 ownership | in_progress | 01,04 | view/job lease、后台、promotion |
| TASK-06 Workspace / Git | in_progress | 01,04 | Project、tools、Git Host |
| TASK-07 Tao / 通知 | in_progress | 01,04,05 | Hub、目标解析、成功后确认 |
| TASK-08 Home / 恢复 | in_progress | 01,03,10 | 三主动作、最近项、组合恢复 |
| TASK-09 原生窗口 | in_progress | 04,05,06,07 | Git、detach 事务、回停靠 |
| TASK-10 持久化与回退 | in_progress | 01,04,07 | v2 migration、恢复 identity |
| TASK-11 用例与自动化支持 | in_progress | 随相关实现 | 已领取；62 用例及受影响回归、catalog/policy |
| TASK-12 集成与验收 | in_progress | 02–11 | 单元测试、三平台 browser/native、结果分析与修复 |

## 本轮实施进度

TASK-01～10 已领取并集成初版，正在补齐异常路径和保留行为；TASK-11 正在实现可执行 YAML 与 runner 支持。尚无任务满足完整验收，未标记 done。已完成首轮 GitHub 三平台验证并保留失败证据；当前补齐第二批用例与修复。

## 验证记录

设计阶段只有静态文档检查通过，产品与运行时改前基线尚未执行。
实现阶段复用现有 Welcome / TabBar / ControlBar / sidebar / Tao / detach 的回归测试；新增纯逻辑覆盖尺寸降级、迁移损坏、实例幂等、关闭失败。
最终远程验证检查 selection、逐 case pass/fail/skip、receipt 与源码身份，不以 workflow 总体绿色代替用例通过。

### 首批集成输入（30 个可执行用例）

- 26 browser + 4 native 已登记到 CI policy；用例语义已按实际动作与结果审查。首批范围只覆盖 YAML 中明确列出的分支，62 条设计用例尚未完整实现。
- 本地：129 项 Shell/Main/Welcome/SessionEditor 单测、239 项 Code Workspace 回归、Notes 实际编辑器保留回归与 9 项 runner 契约通过。ChatDrawer 回归 31 项通过。
- SFTP 低高度、Notes 唯一编辑器、100 标签首轮失败已修复并重跑通过；证据在 `qa-ui-auto-report/workspace-shell/browser/run-20261004-041532-176837200`。源码后续变更后，以后续运行确认最终身份。
- 全仓 `cargo fmt --check` 存在既有未格式化文件；本次两个 Rust 文件已用 rustfmt 处理。没有把旧文件格式差异计为本次 Rust 检查通过。
- 首次 native 编译完成，但构建期间输入变化被 provenance 拒绝，不能用于 native 通过证据；待稳定输入重建。

### GitHub 首轮与第二批修复（2026-10-04）

- 首轮：[run 37152585554](https://github.com/engcapa/taomni/actions/runs/37152585554)。精确 selection 为 26 browser + 4 native；Linux browser 26/0，Windows/macOS browser 各 25/1；Linux native 2/2，Windows/macOS native 各 1/3（pass/fail），均无 skip。原始 summary、receipt、selection 与 ci-summary 位于 `qa-ui-auto-report/workspace-shell/github/run-37152585554/`。workflow job 绿色不代表所有 case 通过。
- B30 在 resize 后等待实际断点状态再断言；N02 使用原生 CSS 选择器与真实 xterm 输入框。原生子窗口复用 QA WebView 数据目录，解决 Windows handoff 与窗口发现失败。macOS URL 查询改用原生窗口 API，并在选中窗口后等待应用 ready。
- 修复 Workspace 恢复时隐藏 Separator 被参与布局排序所导致的 `Panel constraints not found for index 3`；隐藏 tool area 的 handle 随可见性卸载，业务 Panel 实例保持。B04 本地真实 reload/restore 路径通过。
- 第二批新增 B04/B14/B15/B20/B21/B22，总计 32 browser + 4 native 可执行；B14 覆盖五个 dirty 关闭入口的取消与 undo 保留，B15 覆盖实际编码写入失败及重试。B15 首轮注入旧写入命令造成无效故障，已改为 `workspace_write_file_encoded`，本地执行通过；失败运行保留。
- Windows 匹配 build-3 的 N02/N05/N06/N08 四条 native 通过，证据 `qa-ui-auto-report/workspace-shell/native/run-20261004-050917-404019100/`。后续源码已修改，需要 build-4 和新运行；上述证据只证明其记录的输入。
- 当前 focused Extract 回归 14 项通过，runner 窗口/尺寸契约 11 项通过。完整 CodeWorkspace/Terminal 上轮 311 项通过、3 项失败：splitter 预期已更新并通过，两个 Extract 失败在 focused 整组重跑通过；后续完整收尾仍需稳定输入检查。
- 未执行的范围仍包括：12 条 browser、14 条 native 设计用例及已登记用例的未实现分支、OS/IME/读屏手工边界、匹配性能基线。不能以当前 36 条 YAML 代替 62 条设计场景，TASK-01～12 保持 in_progress。
- 第二批收尾：QA build-4、TypeScript/前端构建成功；Windows N02/N05/N06/N08 全部通过，源码身份稳定，报告 `qa-ui-auto-report/workspace-shell/native/run-20261004-052341-161431600/`。Shell/Main/Welcome 聚焦单测 91 项通过；case/catalog audit gate 通过（静态检查，仍列出未触达控件）。检查 N05/N06 截图：1280×800 下标题与状态栏无遮挡，Git 底 Host 与正文可读；不代表所有视觉/读屏/DPI分支通过。
