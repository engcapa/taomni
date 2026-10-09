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

## 历史验证与失败诊断（下表为当时状态，最终结果见文末）

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

该节保留初次检查记录；后续窄屏遮挡与主题按钮修正、最终结果见文末。

## 2026-10-10 main 合并与最终响应式/恢复验证

- 已合并 `origin/main` 至 `8902897e`，合并提交 `a96b4cf8`；保留截图预览缩放、滚动拼接侧边检测、Windows 运行库打包和 macOS runtime path 修复。
- WS-018 恢复并加强标题栏几何断言：可见主题按钮限定为 `.taomni-control-bar .taomni-theme-cycle`，保留 12px Lucide 图标、26x24px 按钮、主题 light/dark/system 持久化和动作区无水平溢出检查。400px 的 Home/Search/New 留白及拖动柄进一步收紧，未改变字体、颜色或图标风格。
- 修复 Workspace navigator 恢复竞态：hydration 不会把旧 shell 状态写回 Workspace；Panel 的陈旧展开回报不会重开收起导航；Hide 乐观更新当前 Workspace 的 `navigatorCollapsed` 后异步持久化。`MainLayout` + `WorkspaceNavigator` 相关 mounted 单测最终 55/55，Windows WS-016/018 2/2。
- 当前提交 `693327ec` 的三端 browser 最终摘要：[GitHub 38003406768](https://github.com/engcapa/taomni/actions/runs/38003406768)，Linux/macOS 各 9/9，`passed=true`、`report_ok=true`、`gaps=[]`；Windows `workspace-restore-final-browser/windows-browser/run-20261010-071707-441733800/summary.json` 9/9、identity stable。
- 当前提交的 Linux native [GitHub 38003412042](https://github.com/engcapa/taomni/actions/runs/38003412042) Linux 16/16；macOS 同批次曾有 TC-WS-NATIVE-004 输入分片失败，单独重跑 [38005017117](https://github.com/engcapa/taomni/actions/runs/38005017117) 1/1，真实 `ci-summary` passed。Windows native 16 条批次中 TC-WS-NATIVE-006 首两次因 WebView2 `chrome not reachable` 只在 setup 失败，未执行断言；清理残留 driver/process 后隔离重跑 `workspace-native-006-recovery-v2/windows-native/run-20261010-073443-394926100/summary.json` 1/1，identity stable。
- 单元验证：此前完整 Node22/pnpm10 批次 `all-units-git-integrated` 为 523 files / 5296 tests passed；合并后完整批次在高并发环境出现 6 个既有 CodeWorkspace mounted test 的 15s timeout（5291 passed / 6 failed），未修改这些断言。随后 `CodeWorkspaceTab.test.tsx` 单文件 251/251、`MainLayout.test.tsx` + `WorkspaceNavigator.test.tsx` 55/55、工具单测 66/66、Rust 单线程 1645 passed / 0 failed / 19 ignored、typecheck exit 0、audit gate exit 0；超时失败记录保留。

## 2026-10-09 main 合并与 Git 整合增量

- main 已合并至 `5bb68ec4`（合并提交 `57cde15f`）；之后 fetch 确认无新提交。
- 本地 Rust `rust-units-main-oct09-v4.log`：1644 passed、0 failed、19 ignored，exit 0。采用 main 的 Windows sherpa shared 库；补齐官方 MSVC 14.44 OneCore C++ import 库，去掉旧静态 CRT 与 `/FORCE:MULTIPLE` 临时参数。
- 完整 frontend `all-units-merged-oct09`：5286 passed / 1 failed（右键格式化），不得记为完整通过；格式化隔离通过。后续 editor 全文件验证暴露重复 workspace-edit preview；已清理的异步 listen 回调增加 disposed guard，`undo-failures-guarded` 两项通过。最终整合后完整单测 `all-units-git-integrated`：523 files、5296 tests 全部通过，exit 0，保持原超时。
- Git 路由/状态 73 项、目录共享与 document history 20 项定向单测通过；`git-migration-typecheck-v4.log` exit 0。新增目录 hook 将 Files 内增删根目录与 canonical Workspace/Changes 同步。
- Git 切换到另一个文件曾释放最后一个视图并丢失 Undo；document owner 现在为仍打开的文件保留历史，真正关闭后释放。WS-019 实际操作证明 dirty buffer、Undo、同名跨仓库身份与 Git 草稿保留。
- Windows `git-workspace-stable-browser/windows-browser/run-20261009-160155-488453100` 的实际目录见报告根；该批六项 6/6 passed、0 skipped、identity_stable=true（WS-001/018/019，IDE-PARITY-008-01/02、018-01）。此前 `git-dedicated-browser-v7/windows-browser/run-20261009-143816-004314700` 同组六项通过。新增最后一个目录移除检查另行运行，不借前次 PASS。
- GitHub `37879497854` 实际摘要 `passed=false, report_ok=true`：Linux WS-018 使用了 DOM 不支持的 selector，macOS rename input 最小宽度不够；已分别修复 CSS selector、输入最小宽度与换行。窗口收起侧栏隐藏且内容容器填满可用宽度，Windows WS-018 通过；Linux/macOS 当前源码仍待复验。
- 已检查专属 Git 截图：保持原主题与 Lucide 图标，Changes/Log/Branches/Tags/Stash/Settings、仓库 scope、diff、提交栏完整保留，不再挤占 editor 底部。全三端 browser/native 收口继续进行。

## 2026-10-09 三端整合验证与 SFTP 恢复

- 提交 `1e1df5b4` 的三端 browser 整批均为 154/154 passed、0 failed、0 skipped。Windows：`windows-git-integrated-browser-v2/windows-browser/run-20261009-172039-028419400/summary.json`，`identity_stable=true`；Linux/macOS：[GitHub 37908867081](https://github.com/engcapa/taomni/actions/runs/37908867081)，真实 `ci-summary.json` 的 `passed=true`、`report_ok=true`、`gaps=[]`。包括 WS-001…019、布局/交互、IDE Git 与原有共享入口回归。
- [GitHub native 37908873415](https://github.com/engcapa/taomni/actions/runs/37908873415)：macOS 16/16 passed，Linux 15/16 passed。IDE-PARITY-008-03/018-02 两端均通过；Linux WS-NATIVE-005 输入地址失败，保留原始失败截图、DOM 与 focus event 序列于 `gh-run-37908873415-selected/`。
- Linux 005 的地址输入沿用会在 breadcrumb DIV 和 input 之间变化的 selector。失败记录显示第二次点击落到列表状态栏，随后 select-all 选中了页面；用例改用明确的地址编辑按钮，等待真实 input 后输入，与已通过的 008 地址编辑流程一致。保留 SSH 输出、SFTP 与 canonical session 断言。Windows `sftp-address-browser-recovery` 1/1；[GitHub 37916902411](https://github.com/engcapa/taomni/actions/runs/37916902411) Linux/macOS browser/native 各 1/1，`passed=true`、`gaps=[]`。
- Windows native `windows-git-integrated-native-v2` 已成功构建，但未执行用例：tauri-driver 无法绑定 4464；系统 `netsh` 证明 4401–4500 在 TCP 排除范围内。仅调整忽略目录内的本地配置至实测可绑定的 19464/19465，不改系统保留策略；`windows-git-integrated-native-v3/windows-native/run-20261009-181751-228052400` 复用同一验证过的 QA build，16/16 passed、0 failed、0 skipped，`identity_stable=true`。

## 窄屏视觉复核发现与修复

- 逐图复核 `windows-git-integrated-browser-v2` 的 WS-018 发现：400px 窗口下收起导航后，320px 的空白背景盖住画布。原来的 input 几何断言与点击仍通过，因为遮挡层设置了 `pointer-events:none`；不能把这些断言等同于视觉可用。
- 新的 WS-008/018 断言检查收起时外层 sidebar 面板实际宽度为 0。`narrow-overlay-baseline` 的 WS-018 在第 17 步按预期失败，保留截图/DOM/trace。
- 根因是 react-resizable-panels 的 `Panel.style` 作用于内层，外层仍受窄屏 overlay CSS 影响。主 PanelGroup 显式标注 navigator 状态，CSS 在收起时隐藏外层面板；不改变原主题、图标和恢复布局契约。修复后 Windows `narrow-overlay-fixed/windows-browser/run-20261009-183513-123594600` 六项 6/6 passed、identity stable；WS-008/015/016/018、IDE-PARITY-027-01、MAIN-RAIL-01。已逐图确认 400px rename/context 恢复可见，输入约 196px，保存/取消/关闭按钮在视口内。布局/导航 mounted tests 64/64，`workspace-final-typecheck.log` exit 0。三端最终增量验证继续进行。

## 最终 native 整合结果（`d3e22aed`）

- Linux/macOS：[37918956195](https://github.com/engcapa/taomni/actions/runs/37918956195)，各 16/16 passed、0 failed、0 skipped；真实汇总 `passed=true`、`report_ok=true`、`gaps=[]`。
- Windows：`windows-final-native` 首批 10/16 passed，其余 6 条在 fixture setup 因同一个 WebView2 `chrome_debug.log` 文件锁失败，尚未运行产品断言。日志锁随后释放；保留失败批次，使用新隔离目录、同一已验证二进制执行 `windows-final-native-recovery/windows-native/run-20261009-190008-661435300`，16/16 passed、0 skipped、identity stable。未修改测试断言或个人环境来隐藏失败。
- 最终布局 browser 增量：[37918961298](https://github.com/engcapa/taomni/actions/runs/37918961298) Linux/macOS 各 6/6，与 Windows `narrow-overlay-fixed` 的 6/6 对应。已下载并查看三端 400px rename/context 与 dialog 截图。
- macOS 400px 顶部主题文案挤压图标：最后新增纯样式修正，窄窗口保留原 Lucide 图标、tooltip 与主题循环，隐藏按钮内文案，缩小 Home/Search/New 水平间距。WS-018 增加原图标尺寸及实际 light/dark/system 点击持久化检查；该 UI-only 增量按用户要求只做三端 browser，native 证据版本保持上述明确边界。
- 提交 `7457a0a3` 的 Windows focused WS-007/018 首轮通过；GitHub `37932751426` 的实际摘要显示 Linux/macOS 各 1/2（WS-018 的 `:visible`/DOM eval 兼容性失败，workflow 绿色但 `passed=false`），保留失败 artifacts。提交 `4a82ad28` 将 WS-018 改为 runner 合法选择器、真实 theme-cycle 点击及 light/dark/system 持久化断言；GitHub `37962126026` 最终 Linux/macOS 各 2/2 passed、0 skipped、0 gaps，`passed=true`、`report_ok=true`。
- `7457a0a3` 后续的 compact header 检查确认 400px 下主题 Lucide 图标、Home/Search/New、拖动柄、重命名/保存/取消、Context pane 和 dialog 控件均在视口内；`4a82ad28` 只调整测试表达以跨 WebView 运行，不改变产品布局。
