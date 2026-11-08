# Mobile Web 终端接管、提示与复制

## 问题与证据

手机点击“接管输入”后，普通 shell 正常，已经运行 Codex TUI 的会话立即回到只读。
在旧 QA 二进制和独立 profile 中复现：手机接管但不 resize 时正常；普通 shell
resize 正常；会在 resize 时发 `ESC[6n` 的真实 PTY 程序触发
`control-lost / desktop_input`，桌面有 CPR `onData`，没有任何 `onKey`。

根因链路：手机接管后自动发送自身尺寸 → TUI 因窗口变化查询光标 → 桌面和手机
xterm 都解析同一份 PTY 输出 → 桌面 xterm 的自动 CPR 经过普通输入路径 →
`write_terminal` 将其当成桌面用户输入并撤销手机控制。匹配用户正在使用的
[Codex 0.167.0 源码](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/tui.rs#L1551)
也会在 screen size 变化后读取光标位置。

旧版本复现记录：
`qa-ui-auto-report/_local/mobile-tui-control-baseline/diagnosis.json`。
诊断使用无网络的测试 TUI，没有操作用户现存会话或发起 Codex 云端请求。

## 实现

- 桌面通过 xterm 公开 parser API 观察终端查询，给同一解析轮次产生的输入添加
  `terminal-response` 来源。继续调用 xterm 原处理器，不按回包字节猜测来源：CPR
  可能和带修饰键的 F3 完全相同，真实按键、Esc、方向键和粘贴仍属于用户输入。
- 自动回包不进入 IME、宏录制、命令跟踪或 MultiExec 广播。Rust 在现有单会话
  gate 内检查控制者：手机持有时丢弃桌面的重复/过时回答，手机负责回应；无手机
  控制者时桌面正常回应。真实桌面输入和 resize 仍保留抢回与尺寸恢复行为。
- `write_terminal` 的来源参数可选，省略仍按用户输入处理；现有调用方兼容。
- 上下常驻黄字合并为终端内浮层，6 秒自动消失，可立即关闭。状态旁的 ⓘ 重新
  显示最近提示和操作说明；浮层不占终端布局高度。
- 新增“更多 → 复制内容”，只读和控制中均可打开。优先提取已有 xterm 选区，
  否则提取当前缓冲区及保留的历史输出；去掉 ANSI 和人工折行，保留 Unicode、
  实际空格。全屏 TUI 仅能复制当前替代缓冲区保留的内容。
- 复制面板显示打开时的只读快照，可长按选择部分文字、复制所选或复制全部；
  收到新输出不会改动快照。关闭和 Escape 返回“更多”按钮。浏览器剪贴板失败时
  尝试传统复制；仍失败则保留可选文本，明确提示使用系统复制，不误报成功。

## 验证对应

| 项目 | 可执行验证 | 边界 |
| --- | --- | --- |
| 查询来源和真实输入区分 | `src/lib/terminal/terminalInputSource.test.ts` | 真正的 headless xterm parser、分段查询、相同字节的 F3/粘贴、释放监听 |
| 快照与剪贴板失败 | `mobile-web/src/TerminalCopy.test.tsx` | 真 xterm 缓冲区、历史、Unicode、软折行空格、宽字符、选区、拒绝授权 |
| 失控、提示、只读复制与焦点 | `mobile-web/src/TerminalView.test.tsx` 及既有 terminal/mobile 测试 | 挂载与既有输入回归 |
| 提示与复制入口 | `TC-MOBILE-017` | 真实 mobile bundle、390×844/844×390、浏览器剪贴板实读、peer 无输入副作用 |
| 原生 TUI 接管 | `TC-MOBILE-018` | 真实 QA listener/desktop xterm/内嵌 mobile bundle/PTY；独立磁盘回答数量与尺寸、真实桌面输入抢回 |
| 既有工作流 | `TC-MOBILE-001`、`TC-MOBILE-002` 与完整 `crash-regression` | 原有输入、尺寸、控制、服务生命周期和共享终端使用方 |

原生用例使用无网络的 Node raw TUI，在 PTY resize 时发出光标查询；每个查询必须
恰好收到一份符合手机几何尺寸的回答。此后手机再次输入仍保持控制；桌面输入要
立即抢回，且桌面查询回答仍能到达 PTY。由普通 UI 输入启动测试程序，不直接
调用输入 IPC，也不改动用户配置。

## 已执行验证与证据

产品提交：`6ae7d93ba4f88436d11e7b7283e9340b776db711`，分支
`fix/mobile-terminal-control-and-copy`。后续 `8feef0c33` 只调整 Windows
剪贴板比较：系统会将 LF 转为 CRLF，断言仅规范化这些换行对，其他文字、
空格和选区内容仍精确匹配，并继续读取真实剪贴板。原始失败报告保留。

- 本机 focused Vitest：20 文件、178 passed、1 条既有 skipped；Python mobile
  runner contracts：7 passed。
- GitHub Linux producer 的完整 Vitest：697 文件、6361 passed、1 skipped。
  TypeScript、Rust 格式、`pnpm check:refactor`、QA catalog gate、development
  case contract 与 `git diff --check` 通过。
- 本机 `TC-MOBILE-017`：1 passed、0 failed、0 skipped，源码/runner 身份稳定，
  receipt 签名和 summary 摘要匹配。实际查看手机复制面板与提示截图。
  当前报告：`qa-ui-auto-report/_local/mobile-terminal-browser/run-20261108-181505-147107241/`。
- 本机 `TC-MOBILE-018` 首次真实执行：1 passed、0 failed、0 skipped，使用下述
  QA release；5 次查询收到 5 次回答，手机保持控制，真实桌面输入仍抢回并恢复
  桌面尺寸。报告：`qa-ui-auto-report/_local/mobile-terminal-native/run-20261108-180126-558944756/`。
  当前 runner 下的独立桌面批次再次通过，报告见下文；`TC-MOBILE-017/018` 的
  Linux `status --gate` 为 0 unmet、0 rejected。
- 本机完整 browser crash-regression 加 `TC-MOBILE-001`：10 passed、0 failed、
  0 skipped，加上述 `TC-MOBILE-017` 共 11 passed。源码/runner 身份均匹配当前
  实现，receipt 签名和 summary 摘要验证通过。批次报告：
  `qa-ui-auto-report/_local/mobile-terminal-browser-regression-current/run-20261108-181756-077021206/`。
- 本机独立 Openbox native 完整批次：12 条、7 passed、5 failed、0 skipped，
  源码/runner 身份稳定且匹配当前实现，QA release 身份与 receipt 校验通过。
  `TC-MOBILE-002/013/018` 与 `TC-WS-038/052/056/057` 通过；
  `TC-WS-039/045/051/053/054` 均在 WebDriver `screenshot` 步骤超时，
  之前的操作断言通过，后续步骤未运行。Openbox 已解决正常 WM 冷重启要求；
  独立系统截图可读取应用画面，但不替代这些失败用例的执行结果。
  **完整 native crash-regression 尚未通过，仍阻止整体验收。**
  当前 Linux `crash-regression status --gate` 为 5 unmet、0 rejected，退出码 1。
  报告：`qa-ui-auto-report/_local/mobile-terminal-native-managed/run-20261108-181629-128945246/`。
- 为区分渲染环境问题，另用 `WEBKIT_DISABLE_COMPOSITING_MODE=1`、
  `GDK_BACKEND=x11`、软件渲染定点重跑 `TC-WS-039`：仍在同一第 142 步
  `screenshot` 超时，1 failed、0 skipped；该环境调整没有解决问题。
  报告：`qa-ui-auto-report/_local/mobile-terminal-native-software-snapshot/run-20261108-183422-652037774/`。
  本机 WebKitGTK/WebDriver 为 `2.50.4-0ubuntu0.22.04.1`。
- 先前无窗口管理器的 native 批次包含截图/启动超时及 `wmctrl -lp` 失败；该批次
  运行中 browser helper 也发生修改，`identity_stable=false`，不作为有效通过证据。
  原报告保留于 `qa-ui-auto-report/_local/mobile-terminal-native-regression/`。

GitHub 按用户要求使用
[qa-ui-auto-platforms.yml](../.github/workflows/qa-ui-auto-platforms.yml)，选择受影响
mobile 用例和完整 `crash-regression`，开启 QA release，禁用 issue 发布：

| 执行 | Browser 实际报告 | Native 状态 |
| --- | --- | --- |
| [首次三平台运行](https://github.com/engcapa/taomni/actions/runs/42469141773) | Linux 11/11，macOS 11/11；Windows 10 passed、1 failed（上述 CRLF 断言） | 三平台官方 protoc 23.4 下载均重试 3 次后 HTTP 504，构建未开始，用例未执行 |
| [Windows/macOS 重试](https://github.com/engcapa/taomni/actions/runs/42471022027) | Windows 11/11，macOS 11/11，0 failed、0 skipped，receipt 与当前源码/runner 匹配 | 两平台再次各重试 3 次后 HTTP 504，native 用例未执行；CI aggregate 为 failed |

重试前在本机验证了完整选择计划；Windows/macOS 组合不选择仅支持 Linux 的
`TC-MOBILE-002`；该用例在本机 Linux 执行，首次 GitHub 运行因 native 准备失败
未执行。前两次重试的模式或平台选择被 planner 拒绝，没有执行用例，也不计入
测试结果。

Linux browser 的 11/11 来自首次提交，产品源码身份与当前相同；Windows CRLF
测试 helper 修订后尚未在 GitHub 重跑 Linux browser，不能将其当作当前 runner
的 Linux receipt。本机当前 runner 的完整 browser 结果见上文。GitHub native
准备失败是独立的验证缺口，尚不能声称三平台 native 通过或整体 QA 完成。

必须核对原始 summary 和 receipt，不能把绿色 job 状态当作全部用例通过。
GitHub 原始 zip、解压报告与准备日志保存在 `qa-ui-auto-report/_local/mobile-terminal-github/`
及相邻 `mobile-terminal-github-*.log`。下载失败没有通过修改产品或构建源码规避，
也没有跳过原始校验或伪造构建身份。

实体手机的 iOS/Android 长按菜单、软键盘及系统授权弹窗尚未实测；Chromium
运行在不同宿主系统不能替代其原生 WebView 或手机 OS 证据。静态校验与 dry-run
不作为用例运行通过证据。

## 可用 QA release

- 二进制：`src-tauri/target/qa-ui-auto/release/taomni`，QA 标识 `com.taomni.app.qa`。
- SHA-256：`d453540bb7166a992d91321047ae414ec2d210e7187587154d5943bdf622eb3e`。
- 源码身份：`12c6ebb7156c41de8f232dcf1ea22aac20f872459b4f4f98f32448feefe40c7d`。
- 构建成功，脚本记录 1341.4 秒；相邻原始 `taomni.qa-identity.json` 由构建脚本
  生成。`native_build.py --release --check` 确认 inputs match，`ldd` 无缺失库。
- 原有 `debug/taomni` 保留旧实现；本次移动端复测使用上述 release 路径。

## 本机构建环境

原始 QA 编译遇到的依赖错误仅通过环境安装解决，没有为构建错误修改源码、
锁文件或产品配置。本次产品修改对应上述已确认的功能问题。

- Ubuntu 22.04：新增 `libv4l-dev`、`libudev-dev`、`nasm`、`lld` 及其传递依赖。
- 独立安装 Node 22.23.4 / pnpm 10.34.9，保留原全局工具。
- 系统 PipeWire 0.3.48 缺少绑定所需字段，独立安装官方 PipeWire 0.3.80 SDK
  和运行库，通过 pkg-config 与 RUNPATH 选择，不替换系统音频服务。
- 官方 Sherpa ONNX 1.13.8 Linux 静态库经 SHA-256 验证后进入既有构建缓存。
- 自动化需安装当前 Python Playwright 对应的 Chromium。
- 完整 native 回归新增 `wmctrl` 1.07-7build1、`xdotool` 1:3.20160805.1-4、
  `xcompmgr` 1.1.8-1，使用已有 Openbox；在任务独立 Xvfb/D-Bus 中运行。
- 自动化隔离 XDG cache 后显式设置
  `PLAYWRIGHT_BROWSERS_PATH=/home/zhyhang/.cache/ms-playwright`，复用已安装浏览器。

精确包版本、安装方式、错误日志位置、原始 debug 产物与身份记录见
[构建与依赖安装记录](qa-build-environment-linux-20261108.md)。本机原始记录另存于
`qa-ui-auto-report/_local/qa-build-environment-20261108.md`。构建前执行
`source /home/zhyhang/.local/share/taomni-qa-toolchain/env.sh`，由仓库
`native_build.py --release` 生成 QA release 和原始身份记录。
