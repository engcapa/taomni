# Ubuntu 22.04 / X11 截图退出修复与本机验证

本机点击截图或关闭后重开，会触发 Xlib/XCB 断言并终止整个 Taomni。修复将 Linux 显示器信息读取调度到 GTK 主线程，工作线程只使用返回的物理坐标快照；截图、录制和贴图共用此路径。

## 根因证据

本机为 Ubuntu 22.04.5、X11 `DISPLAY=:40004`，桌面 1920×1080、根窗口深度 32，X server 带 VNC 扩展；GTK 3.24.33、libX11 1.7.5、libXi 1.8、WebKitGTK 2.50.4。

修复前在隔离 QA 应用中真实复现了用户的错误。GDB 栈为 `_XReply → XIQueryPointer → gdk_device_get_position_double → Tao cursor_position`，见 [原始崩溃栈](../qa-ui-auto-report/_local/screenshot-x11/manual-repro-backtrace.log)。仅绕开鼠标查询仍会失败，另一次 GDB 栈落在 `XPending → GTK main loop`，并报告 `xcb_xlib_threads_sequence_lost`，见 [队列失序崩溃栈](../qa-ui-auto-report/_local/screenshot-x11/manual-fixed-exittrace2.log)。

截图通过后台任务调用 `AppHandle::available_monitors()` 和 `primary_monitor()`。Tauri runtime-wry 2.11.4 的这两个 RuntimeHandle 方法直接访问 GDK，未自动调度到主线程；转换 Monitor 时还调用 Linux `gdk_monitor().workarea()`，内部执行 Xlib 请求。它们与 GTK 主线程共享连接，并发调用会破坏回复序列，之后鼠标查询或事件读取成为断言触发点。因此 `XIQueryPointer` 是暴露损坏的位置，单独改鼠标查询不足以修复。

日志中的 AT-SPI bus 警告在修复后成功测试中仍存在，与本次退出无因果证据。用户报告 Ubuntu 24.04 和 Flameshot 正常；后续 GitHub native 测试使用 Ubuntu 24.04，结果见下文。

## 实现

- [capture.rs](../src-tauri/src/screenshot/capture.rs)：Linux 在 `run_on_main_thread` 中完整读取显示器信息，使用通道返回普通 `DisplayInfo` 值；等待超时提供错误上下文。捕获后端的回退仍在调用线程执行。
- [mod.rs](../src-tauri/src/screenshot/mod.rs)：贴图的主显示器缩放读取也使用该快照，等待 GTK 前先释放截图会话锁。
- [TC-SHOT-N3](../qa-ui-auto-tests/cases/TC-SHOT-N3-native-annotate-copy.testcase.yaml)：同一进程中连续两次完成截图、矩形/多行文字标注、系统剪贴板像素检查和窗口恢复。

最终实现保留原来的 Tauri 鼠标查询，不增加 Cargo 依赖。

## 当前构建与实测

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

`pnpm build` 随 QA 构建通过，改动文件的 rustfmt、`git diff --check`、QA audit gate、用例契约与 Linux CI 选例均通过。全仓 `cargo fmt --check` 因 20 个未改动文件已有格式差异失败；本次两个 Rust 文件均通过，见 [完整格式检查日志](../qa-ui-auto-report/_local/screenshot-x11/final-cargo-fmt.log)。Wayland 和混合 DPI/多显示器尚未验证。报告与图像是本机保留的产物，未纳入 Git。

## GitHub 三平台回归

分支 `fix/linux-x11-screenshot-crash` 已推送，使用 `.github/workflows/qa-ui-auto-platforms.yml`、`scope=selected`、`features=F27.1,F27.2`，明确选择 Linux/Windows/macOS 的 browser/native 六组。每组 browser 35 项（包含旧 session 图像入口移除），Linux/Windows native 各 16 项，macOS native 19 项；选例没有 capability gap 或未审用例。

首轮 [run 37255450923](https://github.com/engcapa/taomni/actions/runs/37255450923) 测试提交 `efda46f9cbfd3c56fdc3b49261f642dd5d594cfc`。Linux/Windows native 各 16/16 通过，macOS native 18/19；三个 browser 均为 34/35。工作流为报告收集用途，任务状态成功不能替代逐项通过判断。原始失败报告保存在 `qa-ui-auto-report/hosted-37255450923/artifacts/`。

三端 browser 的同一个失败 `TC-SHOT-017` 来自水印弹层未限制视口边界：1000px 工具栏换行后，水印按钮靠左，原来的 `right:0` 对齐将面板及颜色按钮推出左边缘。修复为固定定位、按实测面板尺寸夹紧视口坐标，并允许透明度滑条收缩。用例在 1000px、实时缩到 520×420 和恢复后检查面板/滑条边界，保留窄窗口截图；N3 同时检查实际原生 WebView 的水印面板、滑条边界和 Escape 关闭。

macOS `TC-SHOT-N7` 的 13 个 GIF 解码帧全部匹配原画/nonce/时间顺序，但首两帧间隔 900ms，未解释的漏采时间 849ms，超过既有 700ms 标准。像素与时间线失败均保留，标准未放宽；单独复跑同一提交定位是否稳定复现。

## 实际安装命令

从仓库根目录执行过：

```bash
sudo apt-get install -y xdotool
sudo apt-get install -y libasound2-dev
sudo apt-get install -y meson
python qa-ui-auto-report/_local/screenshot-x11/install-pipewire.py
```

ALSA 开发包用于编译，xdotool 用于当前 X11 桌面操作。系统 PipeWire 0.3.48 缺少 pipewire-rs 所需的 `pw_buffer.requested`；安装脚本下载 PipeWire 1.0.5 到本地 QA 目录，编译并安装头文件与运行库到 `qa-ui-auto-report/_local/screenshot-x11/pipewire-prefix`。系统 PipeWire 服务和安装目录未替换。源码地址为 `https://codeload.github.com/PipeWire/pipewire/tar.gz/refs/tags/1.0.5`。

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
XDG_DATA_HOME="$PWD/qa-ui-auto-report/screenshot-x11/manual-gtk/native-appdata" \
XDG_CONFIG_HOME="$PWD/qa-ui-auto-report/screenshot-x11/manual-gtk/native-appconfig" \
XDG_CACHE_HOME="$PWD/qa-ui-auto-report/screenshot-x11/manual-gtk/native-appcache" \
LD_LIBRARY_PATH="$PWD/qa-ui-auto-report/_local/screenshot-x11/pipewire-prefix/lib" \
./src-tauri/target/qa-ui-auto/debug/taomni
```
