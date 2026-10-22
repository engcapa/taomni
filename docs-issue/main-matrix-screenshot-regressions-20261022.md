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

## 修复

### Windows 保存输入同步

原始工件显示：filename edit 首次获得焦点后 141ms 内就发送了完整路径及 Return；
打开截图尚显示 “Working on it...”，失败截图中的路径只到 UUID 中段，自动补全列表仍打开。
旧 helper 只等待一次默认文件名焦点，未读取输入后的值，也未确认 Save 按钮。

现在先要求 QA 进程所属的对话框、filename edit、启用的 Save 按钮稳定 500ms；
使用有节奏的真实 OS 键盘输入，读回**完整目标路径**并等待字段和按钮位置稳定后，再通过 OS 鼠标点击 Save。
字段、所属进程、控件句柄、完整路径和按钮中心均保留在证据中。焦点或字段改变、路径截断会明确失败。
Read-only readiness 策略独立成小模块，补充截断路径、错误控件/进程、禁用按钮、焦点丢失和控件替换的回归测试。

GitHub Windows N17 复测：对话框等待 1,438ms 后就绪，输入阶段工件读回完整目标路径，实际 Save 后 `originalSaved=true`。
同一原生场景的 `savedOriginal`、`clipboardOriginal`、`pinReplacement`、`newPin`、`copyOnly`、`favoriteNoteSaved`、`reopenedOriginalPixels` 均为 true。

### Wayland 外部绘图 fixture

原始第二屏 compositor geometry、DPR、图像尺寸和正确半边的 tile 尺寸均符合预期。
旧 fixture 只观察顶层窗口尺寸，不观察 DrawingArea 最后实际绘制的 allocation/scale；
首次就绪后停止了定时重绘，size-allocate 回调还捕获了循环中的最后一个 DrawingArea。

修复要求 DrawingArea 完整绘制最终逻辑尺寸和 scale，窗口几何稳定 500ms 后才就绪；
分配回调对自己的 widget 重绘，并在整个桌面生命周期保持外部棋盘重绘。
独立生成的 expected PNG 不变，新增“半宽绘制/旧 scale 不能就绪”的负向契约测试。
GitHub 四种 Linux 配置的 N23 均通过。Wayland 原生工件确认第二屏完整绘制 1280×720 logical / scale=2；
6 次全屏比较、2 次区域比较、2 次剪贴板裁剪比较的 `badPixelFraction`、`meanError`、`worstTileError` 全部为 0。
已实际查看 2560×1440 第二屏 PNG，全幅棋盘完整，没有原始运行的半幅深灰。

## 验证记录

- 本地 Python：`test_multi_display test_screenshot_scenarios test_ci_desktop test_wayland_tools`，61 个测试通过。
- 本地 Python：`test_ci_build_pipeline test_ci_provenance`，6 个测试通过；验证 CI 仍只链接一次 root test binary，并包含新增策略测试。
- 本地 Rust：新增保存策略的 2 个测试通过后，运行 `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib screenshot::qa:: -- --nocapture`，14 个通过（包含前述 2 个）。
- `pnpm check:refactor`、Rust 格式和 QA catalog gate 通过。
- GitHub 复测：[39740455196](https://github.com/engcapa/taomni/actions/runs/39740455196)，使用 `.github/workflows/qa-ui-auto-platforms.yml`，`scope=selected`，源码 `05cb4fc6be77306734055257e8eb5fee7157553a`。
  三端 native、四种 Linux profile，明确选择 `TC-SHOT-N17,TC-SHOT-N20,TC-SHOT-N23,TC-SHOT-N24,TC-SHOT-N25`。
  原始两个非性能失败均通过；24 次实际执行全部通过，没有 failed/skipped case。
  VNC N17 所在 entry 的 Linux 依赖安装超时，未进入用例执行，因此该运行整体是 failure，不能写成 25/25 通过。
- 超时日志：[VNC 安装 job](https://github.com/engcapa/taomni/actions/runs/39740455196/job/119701512629) 显示 `azure.archive.ubuntu.com` 下载 LXQt 推荐主题包很慢：
  30.8 MB 的 oxygen-icon-theme 用时约 4 分 48 秒，随后下载 21.7 MB papirus-icon-theme 时触发安装步骤的 35 分钟上限。没有应用启动或测试报告。
- VNC N17 独立补跑：[39746904934](https://github.com/engcapa/taomni/actions/runs/39746904934)，相同完整提交 SHA、相同源码/runner 身份和断言，仅选择 Ubuntu 22.04 VNC native 的 N17；实际执行 1 passed、0 failed、0 skipped，workflow success，汇总 `passed=true`、`report_ok=true`、`infrastructure_errors=[]`。
  两次运行的报告分别保留在 ignored 目录 `qa-ui-auto-report/main-39725193737/github-a/`、`github-b/`，不覆盖第一次的基础设施失败，也不合成一次虚假的全绿汇总。
- GitHub 截图后端契约：104 passed、0 failed、6 个既有 ignored；Windows helper：26 passed、0 failed。
- RDP 实现与此次修改无交集，复用原始全矩阵运行的 RDP unit 证据，`run_rdp_unit_contracts=false`；截图后端和新增保存策略仍实际执行。
- 初次触发 [39740187514](https://github.com/engcapa/taomni/actions/runs/39740187514) 因输入短 SHA 被 checkout 作为分支/标签处理而失败，没有执行用例。正式复测改用完整 SHA；不混用该次或原始失败运行的通过结果。

## 最终覆盖与证据核验

计划中的 25 次原生验证均有实际通过证据：主批次 24 次、独立补跑 1 次。主批次保留原始 failure 状态；下表列出两次运行共同完成的覆盖。
本次复测聚焦 N17、N20、N23、N24、N25，全部采用 release QA 程序和 `com.taomni.app.qa` 隔离标识。

| 原生环境 | 已验证通过 | 证据运行 |
| --- | ---: | --- |
| Ubuntu 24.04 / Xvfb / Openbox | 5 | 主批次 |
| Ubuntu 22.04 / X11 / LXQt + Openbox | 5 | 主批次 |
| Ubuntu 22.04 / VNC / LXQt + Openbox | 5 | 主批次 4 + 补跑 N17 1 |
| Ubuntu 26.04 / Wayland / GNOME，含 100%+200% 双输出 | 4 | 主批次 |
| Windows x64 | 3 | 主批次 |
| macOS 15 arm64 | 3 | 主批次 |
| 合计 | 25 | 24 + 1，实际执行的用例无 failed/skipped |

N17 在六种环境均通过，N23 在四种 Linux 配置均通过；N25 按既有适用范围只在 X11 环境执行。
两个运行的完整提交 SHA 和 source/runner 身份相同，每个实际 case 的摘要匹配各自 selection，补跑 N17 的 case 摘要也与主批次未执行的目标一致。

- Source SHA-256：`c80e9a004ea978ac86a592fdaa96cfbbd0a56634c8ecd899ac00b021c3a031cd`。
- Runner SHA-256：`96f0d67c68b8db504bb980c75a9508bbe9e7414d5f48c73f01139da024d03583`。
- 25 份 runner receipt 的签名、执行身份、native build identity、case 清单/摘要和平台身份均核验通过。
- 主批次 244 个、补跑 10 个 receipt 关联文件的大小/哈希均匹配；两次运行的 172 个截图输出文件也逐一通过 inventory 大小/哈希检查。
- 核验材料：`github-a/delivery-verification.json`、`github-b/delivery-verification.json`、两目录中的 `screenshot-output-verification.json`；独立覆盖索引为 `regression-coverage-verification.json`，均在 `qa-ui-auto-report/main-39725193737/`。
  覆盖索引保留每个通过 case 所属的原始 run/entry，不生成或替换执行汇总。

后续文档提交仅补充本文，未修改已验证的源码、runner 或 case；上述内容指纹保持不变。邮件性能用例的两次原始失败仍按用户要求暂时忽略。
