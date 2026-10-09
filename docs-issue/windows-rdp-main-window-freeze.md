# Win11 远程登录后 Taomni 主窗口冻结

## 场景与原因

用户场景：Win11 本地桌面已启动 Taomni，另一台机器通过 Windows 远程桌面
登录这台 Win11 后，Taomni 主窗口永久失去响应。不是 Taomni 内部的 RDP 客户端连接。

v0.4.34 和修复前 main（`1ab12564`）的 `src-tauri/Cargo.lock` 均使用
Tauri 2.11.5 / tauri-runtime-wry 2.11.4 / Tao 0.35.3 / Wry 0.55.1。
Tao 0.35.3 的 Windows 输入处理存在与这个场景吻合的重入死锁：

1. 键盘处理持有 `KEY_EVENT_BUILDERS` / `LAYOUT_CACHE` 的非重入锁。
2. 持锁期间调用 `PeekMessageW` 查看后续键盘消息。
3. `PeekMessageW` 也会同步派发其他线程发来的消息，包括会话切换期间的焦点消息。
4. `WM_SETFOCUS` / `WM_KILLFOCUS` 重入窗口处理，再次申请已持有的锁，阻塞 UI 线程。
   因此窗口既不能响应输入，也不能继续处理普通 Windows 消息。

代码证据位于 Tao 0.35.3 的 `src/platform_impl/windows/event_loop.rs`、
`keyboard.rs` 和 `keyboard_layout.rs`。Tao 0.37.1 的输入实现通过
`PendingEventQueue` 处理消息重入，避免在上述锁的作用域内派发重入消息。

上游依据：

- [tao#1194：RDP 后窗口无响应](https://github.com/tauri-apps/tao/issues/1194)
- [tao#1215：早期重入锁修复讨论](https://github.com/tauri-apps/tao/pull/1215)
- [tao#1349：维护者建议升级 Tauri 2.12，用户确认解决](https://github.com/tauri-apps/tao/issues/1349)

本机测试确实复现了旧版 Tao 的同类 Win32 死锁，并验证新版消除了它；没有采集
用户最初冻结进程的线程转储，也没有把合成消息测试视为一次真实的跨机器 RDP 登录。

## 修复

- Rust Tauri 最低版本提升到 2.12.0，tauri-build 提升到 2.7.1；锁文件选择
  tauri-runtime-wry 2.12.1、Tao 0.37.1、Wry 0.57.0。
- JavaScript API 与 CLI 同步到 2.12.1，避免桌面构建的 minor 版本不匹配。
- 本地 `tauri-utils` 升级为 2.10.1，继续通过 `[patch.crates-io]` 生效。
  保留原来的非法 Unicode 颜色输入保护及回归测试。与发布的 2.10.1 源码逐文件
  比较后，仅 `src/config.rs` 的这项补丁和新增的 `VENDORED.md` 不同。
- 截图快捷键插件继续使用现有的 2.3.2。没有引入应用层焦点重试或 GPU 配置变化。

这是窗口运行时的实现修复，用户操作流程、前端控件和 IPC 契约不变。
保留原生用例 `TC-NATIVE-CORE-001` 检查启动、WebView 输入、真实 IPC 和本地 PTY；
死锁的特殊消息交错由独立 Win32 回归探针覆盖，不新增无法自动执行真实 RDP 登录的
YAML 用例。真实登录的验收步骤见下文。

## 自动回归与证据

环境：Windows 11 Pro，build 26300，x64；Node 22.23.3、pnpm 10.34.6；
WebView2 和 EdgeDriver 均为 154.0.4258.62。证据日期：2026-10-09。

回归入口：[scripts/windows-input-reentrancy/README.md](../scripts/windows-input-reentrancy/README.md)。
探针只操作自己的隐藏窗口，通过跨线程发送焦点消息，使 Tao 的键盘消息处理真实重入。
必须同时观察到重入、外层按键处理完成和后续 `WM_NULL` 响应，才能判为通过。
没有重入、超时或输入未完成均失败，死锁进程由有界看门狗退出。
该探针已接入 `.github/workflows/qa-native.yml` 的 Windows job，随每日/手动
Native QA Smoke 执行，结果保留在该 job 的报告 artifact 中。

| 键盘消息 | 焦点消息 | Tao 0.35.3 | Tao 0.37.1 |
| --- | --- | --- | --- |
| WM_KEYDOWN | WM_SETFOCUS / WM_KILLFOCUS | 2/2 死锁 | 2/2 通过 |
| WM_KEYUP | WM_SETFOCUS / WM_KILLFOCUS | 2/2 死锁 | 2/2 通过 |
| WM_SYSKEYDOWN | WM_SETFOCUS / WM_KILLFOCUS | 2/2 死锁 | 2/2 通过 |
| WM_SYSKEYUP | WM_SETFOCUS / WM_KILLFOCUS | 2/2 死锁 | 2/2 通过 |

旧版每个进程均记录 `nested_focus=1`、`key_completed=false`、`responsive=false`，
退出码 2；新版每个进程均记录 `nested_focus=1`、`key_completed=true`、
`focus_delivered=true`、`responsive=true`，退出码 0。
两组使用相同探针源码，SHA-256 为
`bec752f175eb6ac0ce54e7ee0bed5684f8ea267c15bbee61eecda8f280e57491`。

本地未提交原始证据：

- `qa-ui-auto-report/rdp-freeze/baseline-final/result.json`：明确指定历史版本的失败基线。
- `qa-ui-auto-report/rdp-freeze/candidate-final/result.json`：从生产锁文件选择版本的通过结果。
- `qa-ui-auto-report/rdp-freeze/color-unit.log`：正常颜色解析和非法 Unicode 回归 2/2 通过。
  测试使用 `utils-unit/` 下逐字节复制的 vendored crate；原目录不是 Cargo workspace
  member，不能直接运行其 dev-dependencies 单测，未因此改变应用 workspace。

初次 `cargo check --locked` 通过。main 的 sherpa-onnx 预编译库需要静态 CRT，
默认参数会与动态 C++ CRT 产生 LNK2005 / LNK1169。这是已在仓库
`.github/workflows/windows-no-bundle.yml` 中记录的构建问题。
仅使用该 workflow 的 `RUSTFLAGS=-C target-feature=+crt-static` 仍失败：
Whisper 的 CMake Release 配置使用 `/MD`，覆盖了静态 CRT 选择。
本次 QA 构建保留全部默认功能，使用以下进程局部参数：

```powershell
$env:RUSTFLAGS = '-C target-feature=+crt-static'
$env:CMAKE_C_FLAGS_RELEASE = '/MT /O2 /Ob2 /DNDEBUG'
$env:CMAKE_CXX_FLAGS_RELEASE = '/MT /O2 /Ob2 /DNDEBUG'
python .agents/skills/qa-ui-auto/scripts/native_build.py
```

两个 CMake 参数已加入 QA helper 的构建身份，防止参数不同却错误复用旧二进制。
先前失败日志保留为 `native-build.log`、`native-build-static.log`；最终构建日志为
`native-build-crt.log`。没有改变生产的 feature 默认值或系统环境变量。

最终完整应用构建与原生操作结果：

- 独立 `com.taomni.app.qa` debug 构建成功（包含 TypeScript 检查和 QA 模式的生产前端构建），
  全部默认 Cargo features 保留。最终一次增量构建耗时 88.4 秒。
  `src-tauri/target/qa-ui-auto/debug/taomni.exe.qa-identity.json` 由构建 helper 生成，
  二进制 SHA-256 为 `dd4aae5d0b96065a79c232229e8e1dc648244b90d31e16c01b78db69b0a04d55`，
  源码身份为 `311ff2e3c400940b33b844a0b78e363d7df3e4a8b713d281552715eb0db62064`。
- `TC-NATIVE-CORE-001` 真实 Windows native 执行通过，0 失败/跳过，报告位于
  `qa-ui-auto-report/rdp-freeze/native/run-20261009-064436-002325800/`。
  启动、密码库初始化、点击打开本地终端、输入命令并收到独立一行的
  `QA_NATIVE_SHELL_READY` 均通过，已查看实际 WebView 截图。
- 额外的主窗口操作检查通过，脚本为 `qa-ui-auto-report/rdp-freeze/window-smoke.py`，
  证据为 `window-smoke-final/result.json`、`window-smoke-final/window-smoke.png`。
  两次通过 UI 点击最大化/还原/最小化，再用 Win32 恢复测试所属的窗口；
  每次验证真实窗口状态、原始几何位置和 `WM_NULL` 响应。
  调整窗口大小后继续执行终端命令，6 个不同标记都产生真实输出，最早的输出仍在。
  已查看最终截图，控件和终端内容正常。第一次脚本错误把 Tao 的消息目标窗口也计入
  主窗口数量，记录保留在 `window-smoke/result.json`；改为匹配已验证 QA 子进程的
  `Taomni` 主窗口后重跑通过，未修改产品或放宽窗口状态/终端断言。
- QA `audit --gate`、case/policy 契约检查与选定 case 的 CI plan 通过；
  `python -m unittest test_native_build_check -v` 的 3 个构建复用检查通过。

这里的窗口恢复使用 Win32，文本/控件输入使用 WebDriver，不是物理键盘或真实输入法证据。
窗口操作测得的响应只是存活检查，没有据此声称完整输入延迟或跨版本性能不退化。

`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 报告 35 个既有文件的格式差异，
与本次修改文件无交集；输出保留在 `fmt.log`。新增探针的 `rustfmt --edition 2024 --check`
通过。没有重排无关文件或 upstream vendor 源码。

## 跨机器 RDP 验收步骤

此项尚未执行。独立原生探针不覆盖认证、GPU/显示设备切换、真实输入法或完整 WTS 会话切换。

1. 在 Win11 的本地桌面启动修复后的 Taomni；测试时使用独立 QA 构建和测试数据目录。
   打开一个本地终端，输入一条带唯一标记的 `echo`，保留窗口和会话。
2. 从另一台机器使用 Windows 远程桌面登录这个相同 Windows 用户会话。
3. 在原 Taomni 窗口点击标签、打开菜单，输入另一条 `echo` 并检查真实输出；
   确认旧终端内容和会话仍存在，窗口可移动、最大化、还原。
4. 测试英文输入及已配置的中文输入法；断开 RDP，回到本地桌面，再次验证输入。
5. 连续进行两次远程连接/断开并重复上述操作，记录版本、Win11/WebView2 版本、
   输入法、连接前后画面和是否出现无响应。若再冻结，保留进程转储以区分其他路径。

Linux/macOS 原生行为及跨平台性能比较未验证，不从本次 Win11 结果外推。
