# Workspace-first 实施与验证记录

关联：[设计](workspace-first-navigation-design.md)、[用例交接](workspace-first-navigation-testcase-handoff.md)、[既有入口迁移](workspace-first-navigation-retained-matrix.md)。

本文记录实施状态，原设计中的“拟新增/未实现/待执行”是实施前基线，不能作为当前实现或通过状态。最终验收以具体执行报告、源码身份和失败恢复记录为准。

## 已接入的实现

| 范围 | 实现与行为 | 验证入口 |
|---|---|---|
| Workspace 实体 | 独立 catalog、canonical Session 引用、版本与重启恢复；删除引用不删除 Session | `workspaceStore`、`workspace_catalog.rs`；WS-002/003/006、NATIVE-001 |
| 导航与 Surface | Work/Sessions/Tools/Alerts/Settings；应用级顶部操作；Workspace header、Surface strip、scope projection | `WorkspaceNavigator`、`WorkspaceChrome`、`MainLayout`；WS-001/004/007/008/012 |
| Files / IDEA 能力 | 复用已有 Code Workspace renderer、编辑器与工具 rail；保留 editor split、Project pane、设置与 Actions | WS-001/005；IDE-CW-LAYOUT/SHELL/UI、IDE-PARITY-024/027、MAIN-RAIL |
| Workspace Git | 复用完整 WorkspaceGitManager/GitPanel，Changes 与 Git/Commit Actions、快捷键、rail 共用专属页；独立目录探测，Files 关闭后保留；Git 打开文件复用所属编辑器 | [ED-PARITY-028](code-workspace-idea-alignment/ed-parity-028-workspace-git.md)；WS-019、IDE-PARITY-008/018 |
| Preview / Context | 文件读取、缺失文件恢复、上下文 pane 和关闭后的焦点恢复 | WS-009、NATIVE-007 |
| Tao / Mail | Workspace 与 Session scope 下的 thread、草稿、消息历史；Mail 引用与全局 Unified Mail 分离 | WS-010/011/013、NATIVE-006/011 |
| 真实资源生命周期 | PTY、共享 SSH、attached SFTP、文件传输、VNC、MySQL、Mail IDLE；切换 scope 后保留资源，支持选定资源 detach/reattach | NATIVE-002/004/005/008/009/010/011 |
| 弹窗交互 | 拖动与可见 resize handle、键盘调整、视口约束、取消指针操作、焦点循环与返回、Escape/关闭 | WS-015 |
| 导航交互 | 搜索、空结果、pin/unpin、指针和键盘调整宽度、收起/展开、展开及收起状态重载 | WS-016 |

| Surface 菜单隔离 | 当前 Workspace 内排序、关闭其他/全部；关闭后保持当前工作区的有效 Surface 或 Overview | WS-017、TabBar mounted tests |

完整 testcase ID 为 `TC-WS-*` / `TC-WS-NATIVE-*`，文件位于 `qa-ui-auto-tests/cases/`。WS-001…017 与原型用例是 browser 用例；NATIVE-001…011 覆盖设计所需的原生边界，005/011 另有 browser 路径。单纯 UI 的 WS-015/016 不增加冗余 native 用例，三端 browser 都执行。

## 已定位并修正的问题

- Dialog 拖动/缩放后可能越出视口：增加完整矩形约束、窗口缩小时重新约束、指针捕获及结束清理；沿用主题变量和 Lucide 图标。
- Navigator 宽度在重载后回到默认值：从持久化布局恢复展开宽度。
- 收起后重载无法再次展开：实测 WS-016 在恢复 Work 时导航仍隐藏。收起不再用零宽度覆盖展开布局，旧零宽度记录回退到可用默认值。修复后宽度约 487px，两次重载均保留；收起后 canvas 为 1381px。
- Command Center native 用例选择到了关闭按钮：为 Workspace 结果使用稳定标识并登记 control catalog。
- SFTP 路径编辑用例在输入框出现前命中 breadcrumb DIV：等待真实 `input`，保留上传、下载 SHA-256 和远端清理断言。
- 原有 rail 用例隐含“进入 terminal/editor 自动收起”：按新设计显式收起，保留 rail 宽度、菜单、键盘及持久化断言。
- 合并 main 的 ASR 设置面板新增事件监听：补齐 SettingsPanel 单测的 Tauri event mock。
- 合并 main 的手动滚动截图默认值：采用 upstream Windows best-effort 激活逻辑，修复新增 auto-mode 步骤后的验收序号，同时断言初始 manual 选中。

## 执行条件

Windows 使用 `qa-ui-auto-tests/local/run-platforms.py`，沿用 `.github/workflows/qa-ui-auto-platforms.yml` 的 selection、service readiness、case execution 和 receipt 流程。测试使用持久的独立 fixture：WSL OpenSSH/SFTP 22478、loopback MySQL 5526、VNC 5988/control 5989。配置、随机测试凭据和报告保存在忽略目录 `qa-ui-auto-report/workspace-first/`，不使用个人连接凭据。

Windows native 使用隔离的 `com.taomni.app.qa`、独立 data/config/cache 与临时项目。构建和执行使用同一套 portable MSVC / Node 22 / pnpm 10 环境。Linux/macOS browser/native 通过 GitHub workflow 执行。Browser 三端结果不替代对应 WebView 的原生结果。

## 验证进度（持续更新）

| 批次 | 结果 / 限制 |
|---|---|
| Windows `navigator-collapse-fixed-v2/windows-browser/run-20261008-172950-419145400` | 4/4 通过，源码身份稳定：WS-016、SHOT-003/029/030 |
| Rust `rust-workspace-msvc.log` | 合并截图更新前 1621 passed、0 failed、18 ignored；合并后补验证中 |
| 工具单测 `tools-unit-v4.log` | 57 passed，exit 0 |
| Frontend `all-units-workspace-final.log` | 5149 tests 通过，但 20 个 worker 启动失败和 5 个未处理事件错误，exit 1，不能记为全量通过 |
| Frontend `all-units-workspace-final-v2.log` | forks 批次出现 editor/MainLayout 超时，已停止并保留诊断日志；不作为通过证据 |
| Frontend `unit-recovery-threads.log` | 22 files / 184 tests 通过，包括 20 个此前未启动文件、MainLayout、SettingsPanel |
| Frontend `all-units-threads-final.log` | 使用 Vitest threads pool 的完整批次执行中；未调整单项超时或删减断言 |
| GitHub `37754339136` | 实际 native 两端各 1 失败：旧 Command Center selector；workflow 绿色但 `passed=false`，不作为验收通过 |
| GitHub `37757137593` | Linux browser 31/31、native 14/14；macOS browser 31/31、native 13/14，VNC 首帧失败待恢复 |
| GitHub `37757724031` | 扩充至 148 条 browser 回归，Linux/macOS 执行中 |
| Windows `windows-native-merged-v2` | 14/14 通过，源码身份稳定；后续 Surface 菜单改动后将重新验证 |
| Windows `windows-browser-merged-full` | 诊断批次发现旧 Welcome Tab 计数及排序问题；修正中止后重新完整执行 |
| Windows `scoped-actions-fixed` / `surface-menu-focus-units.log` | 首轮 4/4 browser 与 11/11 mounted tests 通过；增加关闭后焦点/画布断言的 browser 回归执行中 |

历史报告在源码变化或执行期间身份不稳定时，只保留诊断用途，不能覆盖后续失败。GitHub 的 `report_ok` 只说明报告完整；必须同时查看 `passed`、每条用例结果、skip/gap 和失败详情。

## 界面检查

已检查 1440px 与 400px 截图：新弹窗沿用原字体、颜色变量与 Lucide 图标；窄弹窗的输入、关闭及 resize handle 保留在视口内。导航展开在窄窗口占据主要区域，收起后完整画布可用。WS-015/016 用真实 pointer/keyboard 操作证明拖动、调整尺寸、焦点和恢复结果。

最终布局复核及证据汇总仍在进行；本记录不声明全部验证已经完成。

## 2026-10-09 main 合并与 Git 整合增量

- main 已合并至 `5bb68ec4`（合并提交 `57cde15f`）；之后 fetch 确认无新提交。
- 本地 Rust `rust-units-main-oct09-v4.log`：1644 passed、0 failed、19 ignored，exit 0。采用 main 的 Windows sherpa shared 库；补齐官方 MSVC 14.44 OneCore C++ import 库，去掉旧静态 CRT 与 `/FORCE:MULTIPLE` 临时参数。
- 完整 frontend `all-units-merged-oct09`：5286 passed / 1 failed（右键格式化），不得记为完整通过；格式化隔离通过。后续 editor 全文件验证暴露重复 workspace-edit preview；已清理的异步 listen 回调增加 disposed guard，`undo-failures-guarded` 两项通过。最终整合后完整单测 `all-units-git-integrated` 正在执行，保持原超时。
- Git 路由/状态 73 项、目录共享与 document history 20 项定向单测通过；`git-migration-typecheck-v4.log` exit 0。新增目录 hook 将 Files 内增删根目录与 canonical Workspace/Changes 同步。
- Git 切换到另一个文件曾释放最后一个视图并丢失 Undo；document owner 现在为仍打开的文件保留历史，真正关闭后释放。WS-019 实际操作证明 dirty buffer、Undo、同名跨仓库身份与 Git 草稿保留。
- Windows `git-workspace-stable-browser/windows-browser/run-20261009-160155-488453100` 的实际目录见报告根；该批六项 6/6 passed、0 skipped、identity_stable=true（WS-001/018/019，IDE-PARITY-008-01/02、018-01）。此前 `git-dedicated-browser-v7/windows-browser/run-20261009-143816-004314700` 同组六项通过。新增最后一个目录移除检查另行运行，不借前次 PASS。
- GitHub `37879497854` 实际摘要 `passed=false, report_ok=true`：Linux WS-018 使用了 DOM 不支持的 selector，macOS rename input 最小宽度不够；已分别修复 CSS selector、输入最小宽度与换行。窗口收起侧栏隐藏且内容容器填满可用宽度，Windows WS-018 通过；Linux/macOS 当前源码仍待复验。
- 已检查专属 Git 截图：保持原主题与 Lucide 图标，Changes/Log/Branches/Tags/Stash/Settings、仓库 scope、diff、提交栏完整保留，不再挤占 editor 底部。全三端 browser/native 收口继续进行。
