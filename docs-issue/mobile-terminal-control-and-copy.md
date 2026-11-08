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

待完成并记录实际运行：匹配当前源码的 QA release、本机完整 browser/native
崩溃专项与受影响用例，以及分支上的 `qa-ui-auto-platforms.yml` GitHub 三平台
browser/native。静态校验和 native dry-run 不作为运行通过证据。实体手机的
iOS/Android 长按菜单、软键盘及系统授权弹窗尚未实测。

## 本机构建环境

原始 QA 编译遇到的依赖错误仅通过环境安装解决，没有为构建错误修改源码、
锁文件或产品配置。本次产品修改对应上述已确认的功能问题。

- Ubuntu 22.04：新增 `libv4l-dev`、`libudev-dev`、`nasm`、`lld` 及其传递依赖。
- 独立安装 Node 22.23.4 / pnpm 10.34.9，保留原全局工具。
- 系统 PipeWire 0.3.48 缺少绑定所需字段，独立安装官方 PipeWire 0.3.80 SDK
  和运行库，通过 pkg-config 与 RUNPATH 选择，不替换系统音频服务。
- 官方 Sherpa ONNX 1.13.8 Linux 静态库经 SHA-256 验证后进入既有构建缓存。
- 自动化需安装当前 Python Playwright 对应的 Chromium。

精确包版本、安装方式、错误日志、原始 debug 产物与身份记录见
`qa-ui-auto-report/_local/qa-build-environment-20261108.md`。构建前执行
`source /home/zhyhang/.local/share/taomni-qa-toolchain/env.sh`，由仓库
`native_build.py --release` 生成 QA release 和原始身份记录。
