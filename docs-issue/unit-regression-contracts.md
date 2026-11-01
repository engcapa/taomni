# 五条基线单测失败的独立修复

本工作基于布局修复提交 `81007547`，分支 `fix/unit-regression-contracts`。不更改 `fix/macos-home-shell-layout` 已验证的产品提交。

## 诊断与修复

- TerminalPanel 两条 SSH cwd 集成测试没有声明桌面运行环境。在当前 jsdom/平台环境中会进入刻意不安装完整 shell hook 的 Windows browser 分支。为这两条桌面集成契约显式设置 Tauri runtime fixture，保留延迟提示符、输入暂存、OSC 7 回报和 readiness 的全部断言。
- VNC Linux 原生剪贴板回退测试只替换 navigator.platform，保留的宿主 userAgent 与之冲突。补全 Linux WebKit userAgent，并在 finally 恢复两个属性，保留真实 clipboard_read_text IPC mock 和文本断言。
- Legacy workspace 恢复测试仍期待丢弃 loose tab，而 `98187117` 已明确修复 loose/外部文件的外层 tab 保留与恢复。更新期望为根文件与 loose 文件各导入一次，同时继续断言 library tab 保留在 editor layout、未知根不导入。
- Project splitter 存在产品宽度冲突：工具区使用保存的像素宽度，editor 却给出独立百分比 defaultSize，合计非 100% 时 panel 库会归一化，改变工具区实际宽度。editor 改为占用工具区以外的剩余空间；右侧关闭状态和 mount-time 默认值稳定性保持不变。真实 panel 库集成测试先等到初始 452px 几何建立，再执行连续 pointermove 与折叠恢复；保留原来的方向、第二次 move、仅 pointerup 持久化、恢复宽度及隐藏 Documentation 断言。

## 验证

原始五条失败在 `4f7a4f13` 独立 checkout 全部复现，原件位于主工程 `qa-ui-auto-report/macos-home/unit-baseline.log`。

修复后全量 Vitest：658/658 文件通过，6165 passed / 1 skipped（原有跳过），零失败。`pnpm check:refactor` 与 QA release 构建通过。相关 Project header browser/native 用例补充恢复后 editor 几何与运行时检查，复用既有 case ID/policy；未新增控制点。

Browser 完整 crash-regression 加 Project header 回归 9/9 通过。Native 同范围 9/10 通过，Project header 新增断言通过；唯一失败仍为 TC-WS-054 的 System Events 原生关窗超时，与主分支本机失败一致。GitHub 结果待补充。产品改动位于 shared WorkspaceShellView；真实面板的连续拖动、像素宽度及零尺寸恢复由 CodeWorkspaceSplitter.integration.test.tsx 覆盖，主程序入口的 Project/编辑器生命周期由 UI cases 与完整 crash-regression 保护。

证据统一保存于主工程 `qa-ui-auto-report/macos-home/unit-*`、`splitter-*`。原布局 QA binary 保持在主工程 target 中，本次额外构建位于独立 worktree 的 target，不覆盖手工验证版本。
