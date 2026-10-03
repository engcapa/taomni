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

TASK-01～10 已领取并集成初版，正在补齐异常路径和保留行为；TASK-11 正在实现可执行 YAML 与 runner 支持。尚无任务满足完整验收，未标记 done。基础 browser 首轮失败证据保存在 `qa-ui-auto-report/workspace-shell/browser/`，先修复并重跑；GitHub 验证尚未执行。

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
