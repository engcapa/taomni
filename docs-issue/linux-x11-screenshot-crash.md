# Ubuntu 22.04 / X11 截图退出修复与本机验证

本机点击截图或关闭后重开，会触发 Xlib/XCB 断言并终止整个 Taomni。修复将 Linux 显示器信息读取调度到 GTK 主线程，工作线程只使用返回的物理坐标快照；截图、录制和贴图共用此路径。

## 根因证据

本机为 Ubuntu 22.04.5、LXQt + Openbox、X11 `DISPLAY=:40004`，桌面 1920×1080、根窗口深度 32，X server 带 VNC 扩展；GTK 3.24.33、libX11 1.7.5、libXi 1.8、WebKitGTK 2.50.4。

修复前在隔离 QA 应用中真实复现了用户的错误。GDB 栈为 `_XReply → XIQueryPointer → gdk_device_get_position_double → Tao cursor_position`，见 [原始崩溃栈](../qa-ui-auto-report/_local/screenshot-x11/manual-repro-backtrace.log)。仅绕开鼠标查询仍会失败，另一次 GDB 栈落在 `XPending → GTK main loop`，并报告 `xcb_xlib_threads_sequence_lost`，见 [队列失序崩溃栈](../qa-ui-auto-report/_local/screenshot-x11/manual-fixed-exittrace2.log)。

截图通过后台任务调用 `AppHandle::available_monitors()` 和 `primary_monitor()`。Tauri runtime-wry 2.11.4 的这两个 RuntimeHandle 方法直接访问 GDK，未自动调度到主线程；转换 Monitor 时还调用 Linux `gdk_monitor().workarea()`，内部执行 Xlib 请求。它们与 GTK 主线程共享连接，并发调用会破坏回复序列，之后鼠标查询或事件读取成为断言触发点。因此 `XIQueryPointer` 是暴露损坏的位置，单独改鼠标查询不足以修复。

日志中的 AT-SPI bus 警告在修复后成功测试中仍存在，与本次退出无因果证据。用户报告 Ubuntu 24.04 和 Flameshot 正常；后续 GitHub native 测试使用 Ubuntu 24.04，结果见下文。

main 分支的问题在于将 GTK/GDK API 当作任意线程可用的显示器查询。LXQt/Openbox 本机采用 X11，Taomni 的 GTK 窗口线程和截图工作线程因此同时碰到共享 Xlib 连接，截图触发后队列失序并被 Xlib 的断言主动中止。LXQt 的 Qt 桌面组件不改变 Tauri Linux 窗口层使用 GTK 的事实。Flameshot 能正常截图说明本机可以捕获屏幕，它采用的 Qt 调用路径也不经过 Taomni 这段 GDK 后台线程读取。Ubuntu 24.04 未复现，可能与显示协议、桌面/库版本和线程调度不同有关；未取得用户那套 24.04 环境的同条件调用栈，不能将其中某一个差异认定为原因。修复依据是 GTK/GDK 主线程约束与本机真实崩溃证据，不依赖更换桌面或更新系统库。

## 实现

- [capture.rs](../src-tauri/src/screenshot/capture.rs)：Linux 在 `run_on_main_thread` 中完整读取显示器信息，使用通道返回普通 `DisplayInfo` 值；等待超时提供错误上下文。捕获后端的回退仍在调用线程执行。
- [mod.rs](../src-tauri/src/screenshot/mod.rs)：贴图的主显示器缩放读取也使用该快照，等待 GTK 前先释放截图会话锁。
- [TC-SHOT-N3](../qa-ui-auto-tests/cases/TC-SHOT-N3-native-annotate-copy.testcase.yaml)：同一进程中连续两次完成截图、矩形/多行文字标注、系统剪贴板像素检查和窗口恢复。

最终实现保留原来的 Tauri 鼠标查询，不增加 Cargo 依赖。

## 初始修复取证（efda46f9）

全部 native 测试使用本次编译的 `src-tauri/target/qa-ui-auto/debug/taomni`，标识 `com.taomni.app.qa`，数据/config/cache 均隔离。桌面操作按 QA PID 定位窗口，用户的 `/usr/bin/taomni` 老版本未被替换。

源码指纹：`fc9cb0440c20d622b003f816aa78949a57bf9fe1ba2a76107cd6a2040ec602a3`。
二进制 SHA-256：`4348456f690dc6662b95707e455f4c8c944235130d8caa131f76bac138d3be4b`。

| 验证 | 结果与证据 |
| --- | --- |
| Browser：TC-SHOT-001、002、004 | 3/3 通过、零跳过；[报告](../qa-ui-auto-report/screenshot-x11/browser-ready/run-20261005-095315-484425780/summary.md) |
| Native：TC-SHOT-N10、N12、N3 | 3/3 通过；实际捕获像素、当前窗口/默认截图可见性、滚动完成/取消、两次标注复制均通过；[报告](../qa-ui-auto-report/screenshot-x11/native-gtk/run-20261005-100557-398442296/summary.md) |
| Native：TC-SHOT-N4 | 重跑 1/1 通过；保存字节、贴图关闭和 OS 快捷键触发/禁用/恢复全部通过；[报告](../qa-ui-auto-report/screenshot-x11/native-n4-seeded/run-20261005-101114-827156498/summary.md) |
| 当前桌面真实鼠标与 Escape | 同一 QA 进程连续 5 次打开、等待截图提示完成渲染、Escape 关闭、恢复主窗口和进程存活全部通过；[逐次证据](../qa-ui-auto-report/_local/screenshot-x11/os-repeat-final/evidence.json)、[构建身份](../qa-ui-auto-report/screenshot-x11/manual-gtk/build-identity.json) |
| 独立图像检查 | Pillow 对 N10 的 500×428 截图、N12 的 500×1283 长图与原画对应区域逐 RGB 像素比较，完全一致；[检查结果](../qa-ui-auto-report/_local/screenshot-x11/independent-pixel-check.json) |

初次 N4 的默认 `Control+Alt+A` 恢复被正在运行的老版本占用，该失败报告保留。重跑使用本地包装脚本，在标准 `reset_db` 后仅向本轮 QA 配置写入初始 `Control+Alt+F11`；N4 用例和所有断言完全不变，仍测试真实 `Control+Shift+F9` 输入及恢复注册。包装脚本、种子路径和脚本 SHA 保存在重跑报告的 `TC-SHOT-N4/qa-shortcut-fixture.*` 中。

5 次真实鼠标截图通过后，测试清理误用了 `xdotool windowclose`。该命令调用 `XDestroyWindow` 直接销毁窗口，导致 GTK 报 `BadWindow`、退出码 133，见 [清理日志](../qa-ui-auto-report/_local/screenshot-x11/manual-gtk.log)。随后重新启动同一修复二进制，完成一次截图、Escape 恢复主窗口，再用真实 `Alt+F4` 正常退出，退出码为 0；见 [正常关闭证据](../qa-ui-auto-report/_local/screenshot-x11/os-normal-close-cycle/evidence.json) 与 [日志](../qa-ui-auto-report/_local/screenshot-x11/manual-normal-close.log)。此前失败日志保留，正常截图流程和正常窗口关闭均已验证。

`pnpm build` 随 QA 构建通过，改动文件的 rustfmt、`git diff --check`、QA audit gate、用例契约与 Linux CI 选例均通过。全仓 `cargo fmt --check` 因 20 个未改动文件已有格式差异失败；本次两个 Rust 文件均通过，见 [完整格式检查日志](../qa-ui-auto-report/_local/screenshot-x11/final-cargo-fmt.log)。报告与图像是本机保留的产物，未纳入 Git。

## 水印修复构建与实测（733a81f0）

水印面板修复后重新编译隔离 QA 版本，仍使用 `src-tauri/target/qa-ui-auto/debug/taomni`。源码指纹为 `465248cf4d0fb79c59fd1fdfe54beb95d00395ad3107d43cf4b317d316289d37`，runner 指纹为 `657381e986ec8308cb7c387a2a972d174410d8db5d9f40076aa4908aba497b5b`，二进制 SHA-256 为 `bf9c3fc956587b9a8feb43a5dfb29fb6944d557faa78c961d09ef592674b4f3b`。构建含 `pnpm build`，见 [构建日志](../qa-ui-auto-report/_local/screenshot-x11/watermark-native-build.log)。

| 验证 | 结果与证据 |
| --- | --- |
| Browser：TC-SHOT-001、002、004、017、020、023、028、030 | 8/8 通过、零失败跳过；包含窄窗口水印面板及滑条边界；[报告](../qa-ui-auto-report/screenshot-x11/browser-current/run-20261005-110924-031313624/summary.md) |
| Native：TC-SHOT-N3、N10、N12 | 3/3 通过、零失败跳过；N3 在同一进程两次真实截图、标注、剪贴板像素检查，并检查原生水印面板/滑条边界与 Escape 关闭；[报告](../qa-ui-auto-report/screenshot-x11/native-current/run-20261005-111026-243481353/summary.md) |
| 当前桌面真实鼠标与 Escape | 当前 QA 进程 PID 339616 连续 2 次真实鼠标触发、截图提示渲染、Escape 关闭及主窗口恢复全部通过；随后真实 Alt+F4 正常退出，退出码 0；[逐次证据](../qa-ui-auto-report/_local/screenshot-x11/os-repeat-current/evidence.json)、[日志](../qa-ui-auto-report/_local/screenshot-x11/manual-current.log)、[构建身份](../qa-ui-auto-report/screenshot-x11/manual-current/build-identity.json) |
| 独立图像检查 | Pillow 将 N10 的 500×428 截图和 N12 的 500×1283 长图与原画对应区域逐 RGB 像素比较，完全一致；[结果](../qa-ui-auto-report/_local/screenshot-x11/independent-current-pixels.json) |
| 支持检查 | ScreenshotOverlay 单测 20/20、element_geometry 工具单测 6/6；QA audit gate（482 用例）、base 到 HEAD 用例契约、三个改动 Rust 文件格式和 `git diff --check` 通过 |

当前构建、用例/config 指纹、runner receipt 和附件哈希已核对。所有测试使用本次编译的隔离 QA 版本，用户手工启动的老版本保持运行。Wayland 和混合 DPI/多显示器尚未验证。

## 当前构建与实测（a11cdc07）

Windows 对话框时序修复后再次编译同一个隔离 QA 目标。源码指纹为 `7d0c09e876bff33e2880e173f6033094a7827eb9796b7a3934faac3f80a77ac5`，runner 指纹仍为 `657381e986ec8308cb7c387a2a972d174410d8db5d9f40076aa4908aba497b5b`，二进制 SHA-256 为 `b8da8d71113e7070de920996b62678118b1675f9cf74a50ccc72f5cac7a88ccb`。构建含 `pnpm build`，见 [构建日志](../qa-ui-auto-report/_local/screenshot-x11/dialog-native-build.log)。

| 验证 | 结果与证据 |
| --- | --- |
| Browser：TC-SHOT-001、002、004、017、020、023、028、030 | 8/8 通过、零失败跳过；[报告](../qa-ui-auto-report/screenshot-x11/browser-dialog/run-20261005-115619-717247287/summary.md) |
| 原始 LXQt 桌面的 Native：TC-SHOT-N3、N10、N12 | 三项均通过；N3 同进程两次截图/标注/剪贴板检查，N10/N12 实际截图/长图及窗口恢复；同批额外 N17 仅透明度混色失败，保存与收藏通过；[完整 3/4 报告](../qa-ui-auto-report/screenshot-x11/native-dialog/run-20261005-115854-553069112/summary.md) |
| 临时合成器下的 Native：TC-SHOT-N17 | 原用例 1/1 通过，透明度实际像素为 `[227,137,147,255]`，与预期 RGB 完全一致；OS 拖动、64px 折叠/恢复、原 PNG 保存/复制、收藏重开均通过；[报告](../qa-ui-auto-report/screenshot-x11/native-dialog-composited/run-20261005-120506-516729181/summary.md) |
| 独立审核 | 三份报告的源码/用例/config 身份、QA 二进制身份、47 个 receipt 附件哈希通过；N10 500×428 与裁切原画、N12 500×1283 与 512×1536 原画 `(6,6)` 裁切逐 RGB 像素完全一致；[结果](../qa-ui-auto-report/_local/screenshot-x11/local-dialog-verification.json) |

N17 的原始失败和合成器条件都保留，详见安装说明。测试后 QA/Vite/xcompmgr 均已退出，合成器 selection owner 回到 0，用户手工启动的 `/usr/bin/taomni` 保持运行。改动 Rust 文件格式、用例契约和 482 用例 audit gate 通过。

## GitHub 三平台回归

分支 `fix/linux-x11-screenshot-crash` 已推送，使用 `.github/workflows/qa-ui-auto-platforms.yml`、`scope=selected`、`features=F27.1,F27.2`，明确选择 Linux/Windows/macOS 的 browser/native 六组。每组 browser 35 项（包含旧 session 图像入口移除），Linux/Windows native 各 16 项，macOS native 19 项；选例没有 capability gap 或未审用例。

首轮 [run 37255450923](https://github.com/engcapa/taomni/actions/runs/37255450923) 测试提交 `efda46f9cbfd3c56fdc3b49261f642dd5d594cfc`。Linux/Windows native 各 16/16 通过，macOS native 18/19；三个 browser 均为 34/35。工作流为报告收集用途，任务状态成功不能替代逐项通过判断。原始失败报告保存在 `qa-ui-auto-report/hosted-37255450923/artifacts/`。

三端 browser 的同一个失败 `TC-SHOT-017` 来自水印弹层未限制视口边界：1000px 工具栏换行后，水印按钮靠左，原来的 `right:0` 对齐将面板及颜色按钮推出左边缘。修复为固定定位、按实测面板尺寸夹紧视口坐标，并允许透明度滑条收缩。用例在 1000px、实时缩到 520×420 和恢复后检查面板/滑条边界，保留窄窗口截图；N3 同时检查实际原生 WebView 的水印面板、滑条边界和 Escape 关闭。

macOS `TC-SHOT-N7` 的 13 个 GIF 解码帧全部匹配原画/nonce/时间顺序，但首两帧间隔 900ms，未解释的漏采时间 849ms，超过既有 700ms 标准。像素与时间线失败均保留，标准未放宽。

单项 [run 37257920081](https://github.com/engcapa/taomni/actions/runs/37257920081) 使用同一 `efda46f9` 提交，N7 为 1/1 通过。13 帧、2760ms、最长帧间隔 920ms，扣除原画持续不变的时间后未解释间隔为 682ms，最大时间漂移 113ms，逐帧像素零不匹配。此结果未证明首次失败根因已消除：两轮首帧附近均出现较大间隔，完整批次仍需核查。原始报告保存在 `qa-ui-auto-report/hosted-37257920081/`。

第二轮完整 [run 37258337972](https://github.com/engcapa/taomni/actions/runs/37258337972) 测试提交 `733a81f0de61e8658884c76bb411de58d8bb06e2`，共 156 执行项。三端 browser 均为 35/35，Linux native 为 16/16，macOS native 为 19/19，Windows native 为 15/16，合计 155/156、零跳过。macOS N7 本轮 16 帧、2790ms、最长帧间隔 660ms、未解释间隔 601ms、最大漂移 23ms，零不匹配帧，满足原有标准。Pillow 独立解码 Linux/macOS GIF，帧数、时间和所有解码帧与报告附件完全一致，并独立核对原画裁切的逐帧像素误差；见 `qa-ui-auto-report/hosted-37258337972/independent-gif-decode.json`。

六组原始报告的 source/runner/case/config 指纹、QA 二进制身份、230 个 receipt 附件及 1931 个原生输出附件哈希全部通过；独立聚合与 GitHub 聚合一致，严格 `passed=false`，唯一失败为 Windows N17。见 `qa-ui-auto-report/hosted-37258337972/independent-verification.json`。工作流的 success 不表示全部用例通过。

Windows N17 失败发生在原生保存对话框输入。阶段记录中，保存按钮点击后仅固定等待 1.5s，在 8794ms 标记对话框打开、9493ms 发送全局键盘输入，但 [当时桌面图](../qa-ui-auto-report/hosted-37258337972/artifacts/qa-windows-native-f4d9247436f94cf1b252749590f0a70a/screenshot-outputs/windows-8351a522-3ced-4c51-9f30-d240bc51775c-8-pin-save-dialog-open.png) 尚无保存对话框。[失败时桌面图](../qa-ui-auto-report/hosted-37258337972/artifacts/qa-windows-native-f4d9247436f94cf1b252749590f0a70a/screenshot-outputs/windows-8351a522-3ced-4c51-9f30-d240bc51775c-9-pin-save-dialog-failed.png) 对话框已打开，文件名仍是默认 `Taomni-pin`，说明输入送早了；不是文件内容断言错误。

修复 QA 输入时序：[windows_save_dialog.rs](../src-tauri/src/screenshot/qa/windows_save_dialog.rs) 读取实际 Win32 前台窗口及 GUI 线程焦点，等待当前 QA PID 的 `#32770` 对话框和默认文件名 Edit 字段获得焦点（最多 20s）后再输入。成功/失败证据记录 PID、类名、焦点控件、默认文件名和等待时间。仍通过真实 Enigo 键盘输入操作原生对话框、验证指定目标文件与原 PNG 字节完全相同，后续收藏持久化断言保留。Windows 专用模块已在本机使用 `x86_64-pc-windows-gnu` 对实际源码进行编译类型检查；完整原生运行仍需 hosted Windows 复测。

第三轮完整 [run 37262106144](https://github.com/engcapa/taomni/actions/runs/37262106144) 测试提交 `a11cdc07207957c6ffa3e00019a647ba48353a66`，继续选择上述六组 156 执行项。该轮已启动，结果待返回，原始报告下载到 `qa-ui-auto-report/hosted-37262106144/`。

## 实际安装命令

从仓库根目录执行过：

```bash
sudo apt-get install -y xdotool
sudo apt-get install -y libasound2-dev
sudo apt-get install -y meson
python qa-ui-auto-report/_local/screenshot-x11/install-pipewire.py
rustup target add x86_64-pc-windows-gnu
sudo apt-get install -y xcompmgr
```

ALSA 开发包用于编译，xdotool 用于当前 X11 桌面操作。系统 PipeWire 0.3.48 缺少 pipewire-rs 所需的 `pw_buffer.requested`；安装脚本下载 PipeWire 1.0.5 到本地 QA 目录，编译并安装头文件与运行库到 `qa-ui-auto-report/_local/screenshot-x11/pipewire-prefix`。系统 PipeWire 服务和安装目录未替换。源码地址为 `https://codeload.github.com/PipeWire/pipewire/tar.gz/refs/tags/1.0.5`。

Windows Rust 标准库 target 用于在 Linux 本机检查 Windows 对话框查询源码的 API 与类型，不替代真实 Windows native 验证。检查日志为 `qa-ui-auto-report/_local/screenshot-x11/windows-dialog-api-check.log`。

本机 LXQt/Openbox 默认没有 X11 合成器（`_NET_WM_CM_S0` owner 为 0）。扩展的 N17 本机检查中，PNG 保存与收藏均通过，但 50% 透明度的桌面混色断言失败：底图 `[255,255,255,255]`，期待 `[227,137,147]`，捕获到未合成的 `[100,10,20,128]`。该失败报告保存在 `qa-ui-auto-report/screenshot-x11/native-dialog/`。`xcompmgr` 仅用于后续贴图透明度检查，临时执行 `xcompmgr -n`，测试结束关闭；与不依赖合成器的截图崩溃修复分开记录，桌面条件保存在 `qa-ui-auto-report/_local/screenshot-x11/dialog-compositor-conditions.json`。原始未合成环境的 N3/N10/N12 三项均通过。

该脚本内部执行的安装步骤如下：

```bash
meson setup qa-ui-auto-report/_local/screenshot-x11/pipewire-build \
  qa-ui-auto-report/_local/screenshot-x11/pipewire-1.0.5 \
  --prefix="$PWD/qa-ui-auto-report/_local/screenshot-x11/pipewire-prefix" --libdir=lib \
  -Dauto_features=disabled -Dspa-plugins=enabled -Ddbus=disabled \
  -Dsystemd-user-service=disabled -Dflatpak=disabled -Dsession-managers=[] \
  -Dpipewire-jack=disabled -Dpipewire-v4l2=disabled -Dexamples=disabled -Dtests=disabled
ninja -C qa-ui-auto-report/_local/screenshot-x11/pipewire-build -j 6
meson install -C qa-ui-auto-report/_local/screenshot-x11/pipewire-build
```

编译通过 npx 临时使用 Node.js 22 / pnpm 10，命令为：

```bash
TAOMNI_QA_PW="$PWD/qa-ui-auto-report/_local/screenshot-x11/pipewire-prefix"
PKG_CONFIG_PATH="$TAOMNI_QA_PW/lib/pkgconfig" \
LIBRARY_PATH="$TAOMNI_QA_PW/lib" LD_LIBRARY_PATH="$TAOMNI_QA_PW/lib" \
CARGO_BUILD_JOBS=6 CARGO_PROFILE_DEV_DEBUG=1 \
npx --yes --package=node@22 --package=pnpm@10 \
  --call 'python .agents/skills/qa-ui-auto/scripts/native_build.py'
```

本机复测修复版可执行以下命令，继续使用隔离 QA 配置：

```bash
XDG_DATA_HOME="$PWD/qa-ui-auto-report/screenshot-x11/manual-current/native-appdata" \
XDG_CONFIG_HOME="$PWD/qa-ui-auto-report/screenshot-x11/manual-current/native-appconfig" \
XDG_CACHE_HOME="$PWD/qa-ui-auto-report/screenshot-x11/manual-current/native-appcache" \
LD_LIBRARY_PATH="$PWD/qa-ui-auto-report/_local/screenshot-x11/pipewire-prefix/lib" \
./src-tauri/target/qa-ui-auto/debug/taomni
```
