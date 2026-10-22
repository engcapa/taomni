# main 全矩阵截图失败诊断与复测

原始运行：[39725193737](https://github.com/engcapa/taomni/actions/runs/39725193737)，源码 `3b7838be2876d9d3d7633cbf2566199a34f1810d`。
修复分支：`fix/main-native-screenshot-regressions`。

## 原始结果与保留要求

GitHub 的 49 个 job 显示成功，但原始用例汇总是 `passed=false`、`report_ok=true`，没有基础设施错误。
`scope=all` 的工作流只要求报告完整；本次复测使用 `scope=selected`，要求实际用例通过。

| 用例 | 原始环境 | 失败及处理 |
| --- | --- | --- |
| TC-SHOT-N17 | Windows native | 原生 Save 对话框没有保存原始 PNG；修复并复测。 |
| TC-SHOT-N23 | Ubuntu 26.04 / GNOME Wayland / 100%+200% 双输出 | 第二屏 PNG 左半正确棋盘、右半深灰，坏像素比例 50%；检查外部像素 fixture 并复测。 |
| TC-MAIL-PERF-03 | Ubuntu 22.04 VNC、Ubuntu 26.04 Wayland | 两次性能用例失败，按用户要求暂时忽略；不调整断言、预算或结果。 |

下载的两个失败 entry 的 runner receipt 签名有效；共 2,173 个关联文件的大小和 SHA-256 全部匹配，无缺失。
原始材料保存在 ignored 目录 `qa-ui-auto-report/main-39725193737/original/`，原始失败不被后续结果覆盖。

保留 N17 的原生置顶/拖动、缩放、透明度、折叠/恢复、Copy/Save 原始 PNG、收藏和备注持久化、编辑 Done 各分支；
保留 N23 的两块实际输出、混合 DPI、公开显示器 picker 往返、完整 PNG 比较、持久流区域、OS 拖选/剪贴板及主窗口恢复。
不降低任何像素阈值，不跳过这些场景，也不通过直接写目标文件代替 Save。

## 修复候选

### Windows 保存输入同步

原始工件显示：filename edit 首次获得焦点后 141ms 内就发送了完整路径及 Return；
打开截图尚显示 “Working on it...”，失败截图中的路径只到 UUID 中段，自动补全列表仍打开。
旧 helper 只等待一次默认文件名焦点，未读取输入后的值，也未确认 Save 按钮。

现在先要求 QA 进程所属的对话框、filename edit、启用的 Save 按钮稳定 500ms；
使用有节奏的真实 OS 键盘输入，读回**完整目标路径**并等待字段和按钮位置稳定后，再通过 OS 鼠标点击 Save。
字段、所属进程、控件句柄、完整路径和按钮中心均保留在证据中。焦点或字段改变、路径截断会明确失败。
Read-only readiness 策略独立成小模块，补充截断路径、错误控件/进程、禁用按钮、焦点丢失和控件替换的回归测试。

### Wayland 外部绘图 fixture

原始第二屏 compositor geometry、DPR、图像尺寸和正确半边的 tile 尺寸均符合预期。
旧 fixture 只观察顶层窗口尺寸，不观察 DrawingArea 最后实际绘制的 allocation/scale；
首次就绪后停止了定时重绘，size-allocate 回调还捕获了循环中的最后一个 DrawingArea。

候选修复要求 DrawingArea 完整绘制最终逻辑尺寸和 scale，窗口几何稳定 500ms 后才就绪；
分配回调对自己的 widget 重绘，并在整个桌面生命周期保持外部棋盘重绘。
独立生成的 expected PNG 不变，新增“半宽绘制/旧 scale 不能就绪”的负向契约测试。
是否足以解决原始半幅问题，以 GitHub 原生双屏的全图比较结果确认。

## 验证记录

- 本地 Python：`test_multi_display test_screenshot_scenarios test_ci_desktop test_wayland_tools`，61 个测试通过。
- 本地 Python：`test_ci_build_pipeline test_ci_provenance`，6 个测试通过；验证 CI 仍只链接一次 root test binary，并包含新增策略测试。
- 本地 Rust：`cargo test --locked --manifest-path src-tauri/Cargo.toml --lib screenshot::qa::save_dialog_observation -- --nocapture`，2 个通过。
- `pnpm check:refactor`、Rust 格式和 QA catalog gate 通过。
- GitHub 待复测：使用 `.github/workflows/qa-ui-auto-platforms.yml`，三端 native、四种 Linux profile，选择 N17、N20、N23 及截图关闭/恢复相邻用例；原生结果出来后补充运行链接和实际计数。
