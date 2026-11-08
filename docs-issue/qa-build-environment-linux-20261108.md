# Linux QA 构建与依赖安装记录（2026-11-08）

- 平台：Ubuntu 22.04.5 LTS / x86_64
- 首次无源码修改构建的提交：`1aa763338bc4bdc301ffffbabfab816aeb1aee12`
- 首次构建约束：不修改源码、锁文件或产品构建配置，仅安装环境依赖。后续 mobile 产品变更由用户另外授权，记录在文末及 [实现与验证](mobile-terminal-control-and-copy.md)。
- 原环境：Node.js v24.13.0、pnpm 11.9.0、Rust/Cargo 1.99.0、protoc 33.5、Perl 5.34。
- 缺失依赖：`libv4l-dev`（摄像头/V4L2）、`libudev-dev`（设备检测）、`nasm`（编解码汇编工具）。
- 构建辅助：`lld`（降低大型 Rust 二进制链接开销）。
- 单独安装 Node.js 22 / pnpm 10，保留原全局工具版本。
- 已有关键依赖：GTK3、WebKitGTK 4.1、WebKitWebDriver、libclang 14、ALSA、PipeWire、D-Bus、GBM、Kerberos、完整 Perl、CMake、C/C++ 编译器。

## 环境安装结果

系统依赖安装成功：

```bash
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y libv4l-dev libudev-dev nasm lld
```

实际新增/更新的包（包括传递依赖）：

- `libudev-dev`：`249.11-0ubuntu3.23`（新增）
- `libudev1`：`249.11-0ubuntu3.23`（原版本 `249.11-0ubuntu3.12`）
- `libv4l-dev`：`1.22.1-2build1`（新增）
- `libv4l2rds0`：`1.22.1-2build1`（新增）
- `lld`：`1:14.0-55~exp2`（新增）
- `lld-14`：`1:14.0.0-1ubuntu1.1`（新增）
- `nasm`：`2.15.05-1`（新增）

工具链安装位置：`/home/zhyhang/.local/share/taomni-qa-toolchain`。
Node.js 官方 Linux x64 压缩包已通过对应 SHASUMS256.txt 的 SHA-256 校验。
本次使用 Node.js `v22.23.4`、pnpm `10.34.9`；保留原全局 Node/pnpm。

## 构建方式

```bash
source /home/zhyhang/.local/share/taomni-qa-toolchain/env.sh
pnpm install --frozen-lockfile
python3 .agents/skills/qa-ui-auto/scripts/native_build.py
```

环境脚本设置：`CARGO_BUILD_JOBS=6`、`RUSTFLAGS=-C link-arg=-fuse-ld=lld -C link-arg=-Wl,-rpath,/home/zhyhang/.local/share/taomni-qa-toolchain/pipewire-0.3.80/lib`；`PKG_CONFIG_PATH` 优先指向新版 PipeWire 的 `lib/pkgconfig`。
使用现有 QA overlay：标识 `com.taomni.app.qa`，QA debug profile，前端 `--mode qa`。
Rust 构建保持 `--locked`。目标为 `src-tauri/target/qa-ui-auto/debug/taomni`。
身份记录由仓库构建脚本在成功后生成，不手工构造。

## 过程记录

下列日志和原始产物记录均位于工程 `qa-ui-auto-report/_local/`，属于本机证据，不提交二进制或日志内容。

- `qa-system-dependencies.log`：apt 安装日志。
- `qa-node-toolchain.log`：Node/pnpm 安装及完整性校验。
- `qa-pnpm-install.log`：锁定的前端依赖安装。
- `qa-cargo-fetch.log`：锁定的 Rust 依赖预取。
- `qa-native-build.log`：QA 编译日志。
- `qa-build-source-before.json`：原始提交、工作区状态和关键输入文件 SHA-256。
- `qa-build-packages-before.tsv` / `qa-build-packages-after.tsv`：安装前后系统包快照。

## 首次编译遇到的环境错误

`pipewire 0.9.2` 编译时报 `error[E0609]: no field requested on type &pw_buffer`。
原因：Ubuntu 22.04 的 `libpipewire-0.3-dev` / `libspa-0.2-dev` 为 `0.3.48-1ubuntu3.2`，而当前 Cargo 特性需要 PipeWire >= 0.3.49 的头文件和对应运行库。
处理：从 PipeWire 官方 GitHub 标签 `0.3.80` 源码构建并安装开发头文件、共享运行库及配套模块，安装前缀为 `/home/zhyhang/.local/share/taomni-qa-toolchain/pipewire-0.3.80`。系统仓库候选版本仍是 0.3.48，因此没有通过升级 Jammy 同名包解决。

- 源码地址：`https://codeload.github.com/PipeWire/pipewire/tar.gz/refs/tags/0.3.80`
- 源码压缩包 SHA-256：`0bbaf3d46649ac2217f0bbf68dda7e62f1f2cf6b7f3025e364cf7205d1499ef9`
- 使用环境已有的 Meson 1.7.2、Ninja 1.13.0、C/C++ 编译器。
- 安装日志：`qa-pipewire-install-v2.log`；精确命令另存于对应后台任务状态/启动脚本。
- 构建参数：`--libdir lib --buildtype release -Dauto_features=disabled -Dtests=disabled -Dexamples=disabled -Dsystemd-user-service=disabled -Dpipewire-jack=disabled -Dpipewire-v4l2=disabled -Dsession-managers=[] -Drlimits-install=false`。
- 初次环境库配置尝试禁用 `audioconvert` 时触发上游 Meson 的 `Unknown variable audioconvert_dep`；恢复该库默认组件后安装成功，没有修改其源文件。
- 验证：pkg-config 返回 `libpipewire-0.3=0.3.80`，直接调用本地共享库返回 `0.3.80`，C 编译器检查 `struct pw_buffer.requested` 成功。
- QA 环境通过 pkg-config 选择该 SDK；链接时写入其本机安装路径的 RPATH/RUNPATH，避免运行时误载系统 0.3.48。
- 原有系统 PipeWire 服务和软件包保持安装状态，没有替换音频服务。

重试编译日志：`qa-native-build-v2.log`。

## Sherpa ONNX 原生库

默认 `asr-sherpa` 功能还需要 Sherpa ONNX 1.13.8 的 Linux x64 静态预编译库，包含 ONNX Runtime 等组件。官方压缩包 22,952,328 字节，URL 为 `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-static-lib.tar.bz2`。

GitHub Release API 给出的 SHA-256 为 `e1fdc5b67530e15741ef897fa5ffff297056f3bf0c6d829a27af9225a4c4b5a6`，原始元数据保存为 `sherpa-onnx-v1.13.8-release.json`。
下载较慢，采用分段预取；曾遇到与 Cargo 下载脚本同名临时文件冲突，首次合并校验失败后没有用于构建，后续改用独立暂存目录并要求 SHA-256 和 bzip2 完整性都通过。
最终 SHA-256 与 bzip2 校验均通过（任务退出码 0），已发布到 `src-tauri/target/qa-ui-auto/sherpa-onnx-prebuilt/`，后续 Cargo 构建成功使用。最终校验/缓存发布日志：`qa-sherpa-library-finalize.log`。


## 构建与产物校验

- 编译成功，`qa-native-build-v2` 任务退出码为 0。
- 原生 Rust 构建耗时：9 分 36 秒；包含前端构建的构建脚本记录耗时：678.6 秒。
- 主程序：`/home/zhyhang/code/person/taomni/src-tauri/target/qa-ui-auto/debug/taomni`
- 文件类型：Linux x86_64 ELF / PIE，QA debug profile（保留调试断言和 QA hooks）。
- 应用标识：`com.taomni.app.qa`。
- 身份记录：`taomni.qa-identity.json`，由仓库原生构建脚本成功生成。
- 二进制 SHA-256：`a730309bdc67b011d0b3835ec5139ff1485a3e72675f2230b2b9d4607d096681`。
- `native_build.py --check`：`reusable: true`、`inputs match`，源码、构建配方、工具链和记录环境匹配。
- 环境脚本已固定到成功构建的 pkg-config 搜索路径，重复 source 不再改变该值。
- `ldd`：没有 `not found`；确认加载独立安装的 PipeWire 0.3.80、系统 WebKitGTK 4.1 / JavaScriptCoreGTK 4.1。
- ELF `RUNPATH` 包含 `/home/zhyhang/.local/share/taomni-qa-toolchain/pipewire-0.3.80/lib`，直接运行主程序也会选择该版本。
- 动态库完整解析清单：`qa-build-binary-ldd.txt`。
- `git status --porcelain` 为空；提交和关键输入 SHA-256 与安装前相同；确认无源码、配置或锁文件改动。
- 前端 TypeScript 检查、`check:refactor`、移动端和 QA 前端构建通过。既有 Rust 警告保持原状。

## 原生启动冒烟

已在隔离的 Xvfb 和 D-Bus 会话中实际运行 `TC-NATIVE-CORE-001`，QA 应用启动、本地 PTY 创建和 `echo QA_NATIVE_SHELL_READY` 的实际输出均通过断言。

- 任务配置：`qa-build-native-smoke.config.yaml`。
- 日志：`qa-build-native-smoke.log`。
- 报告目录：`qa-build-native-smoke/`。
- QA 独立 profile 由运行器管理；使用空闲端口 4454/4455 和软件渲染。
- 实际执行：**1 passed / 0 failed / 0 skipped**，12.1 秒，任务退出码 0。
- 原生运行的源码身份与二进制构建记录相同，运行期间源码身份稳定。
- 本地已查看截图，实际终端包含单独一行 `QA_NATIVE_SHELL_READY`，界面正常显示。
- 原生 summary、runner receipt、隔离记录与截图保存在 `qa-build-native-smoke/run-20261108-120126-938109844/`。
- 测试完成后 WebDriver 4454/4455 端口已释放；工作区仍干净。
- 验证范围为本机 Linux QA 启动和本地终端冒烟，没有运行完整产品回归套件。


## 日常使用

在工程根目录运行以下命令，可核对并复用本次 QA 构建：

```bash
source /home/zhyhang/.local/share/taomni-qa-toolchain/env.sh
python3 .agents/skills/qa-ui-auto/scripts/native_build.py --check
```

本机的二进制可直接启动；请保留上述 PipeWire 安装目录，其运行库路径已写入二进制。原生自动化使用仓库 QA 运行器，以获得独立的测试数据目录。

## Mobile 终端后续开发与回归环境

针对用户后续授权的 TUI 接管修复、提示浮层和复制功能，另行构建 QA release。原始 debug 编译的无源码修改记录保持上文原样。

- Python Playwright 1.61.0 缺少匹配的 Chromium 运行文件，已通过 `python3 -m playwright install chromium` 安装，任务退出码 0。
- Chrome for Testing / Headless Shell 149.0.7827.55（Playwright revision 1228）与 FFmpeg revision 1011 安装到用户 Playwright cache。
- 安装日志：`mobile-terminal-playwright.log`；未为浏览器安装错误修改产品源码或构建配置。
- 新 QA release 构建日志：`mobile-terminal-qa-release.log`，仍使用上述隔离工具链与 PipeWire SDK/runtime。

### 新 QA release 产物

- 路径：`src-tauri/target/qa-ui-auto/release/taomni`，应用标识 `com.taomni.app.qa`。
- 编译成功，退出码 0；构建脚本耗时 1341.4 秒。
- SHA-256：`d453540bb7166a992d91321047ae414ec2d210e7187587154d5943bdf622eb3e`。
- 源码身份：`12c6ebb7156c41de8f232dcf1ea22aac20f872459b4f4f98f32448feefe40c7d`，匹配当前实现。
- 仓库构建脚本生成相邻身份记录；`native_build.py --release --check` 返回可复用且 inputs match。
- `ldd` 无缺失库；加载独立 PipeWire 0.3.80 与系统 WebKitGTK 4.1。
- 原生自动化隔离 XDG cache 后，需显式设置 `PLAYWRIGHT_BROWSERS_PATH=/home/zhyhang/.cache/ms-playwright` 复用已安装的 Chromium。GitHub workflow 已有等价配置。


### 完整 native 回归的桌面工具

- 安装 `wmctrl` 1.07-7build1、`xdotool` 1:3.20160805.1-4、`xcompmgr` 1.1.8-1（apt 退出码 0；无新增传递依赖）。
- 安装日志：`mobile-terminal-native-tools.log`。
- 冷重启用例要求正常窗口管理器关闭请求；无 WM 的 Xvfb 下 `wmctrl -lp` 返回 1，不作为产品失败或通过证据。
- 后续完整回归使用独立 Xvfb + D-Bus + 已有 Openbox + 新装 xcompmgr；仅清理本任务创建的桌面进程。
- 运行脚本：`mobile-terminal-native-managed.sh`。不向个人桌面注入窗口管理器，不操作用户运行中的实例。
