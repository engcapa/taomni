# 0.4.35 安装包与升级包启动失败排查

日期：2026-10-09。检查对象：GitHub `engcapa/taomni` 的 `v0.4.35` 已发布文件。

## 结论与范围

确认两个打包问题：Windows NSIS 缺少 Sherpa/ONNX DLL；macOS Intel 的 Mach-O 加载路径残留 Homebrew bottle 占位符。两者均可影响新安装和升级后的启动，不能仅靠升级签名验证发现。

已下载下表全部九个包，SHA-256 与问题中提供的值一致。七个升级包均使用 `latest.json` 中的签名和项目公钥完成 Minisign 验证。DMG 不作为 Tauri 自动升级载荷，其 updater 签名不适用。精简的文件哈希及依赖证据见 [JSON](release-0.4.35-runtime-dependencies.evidence.json)。

| 已发布文件 | 升级通道/用途 | 实际检查结论 |
| --- | --- | --- |
| `Taomni_0.4.35_x64-setup.exe` | Windows NSIS / 默认 Windows 后备通道 | **有问题**：主程序导入 `sherpa-onnx-c-api.dll`，但包内四个 Sherpa/ONNX DLL 全部缺失。解包后原生启动返回 `0xC0000135`（STATUS_DLL_NOT_FOUND）。 |
| `Taomni_0.4.35_x64_en-US.msi` | Windows MSI | 文件表包含全部四个 DLL，解释了直接安装 MSI 正常。正确选择 MSI 通道不会遇到 NSIS 的遗漏。 |
| `Taomni_0.4.35_aarch64.app.tar.gz` | macOS ARM64 自动升级 | 无 Sherpa/ONNX 动态依赖；主程序及五个 Kerberos dylib 无残留 Homebrew 路径。 |
| `Taomni_0.4.35_aarch64.dmg` | macOS ARM64 手动安装 | 主程序与同架构升级归档 SHA-256 完全相同，未发现上述依赖问题。 |
| `Taomni_0.4.35_x86_64.app.tar.gz` | macOS Intel 自动升级（也包括 Rosetta 运行 Intel 包） | **有独立问题**：主程序及 Kerberos dylib 共 10 处未重定位的 Homebrew 占位路径。 |
| `Taomni_0.4.35_x64.dmg` | macOS Intel 手动安装 | 主程序与 Intel 升级归档完全相同，包含同一错误加载路径；换装同版本 Intel DMG 不能解决。 |
| `Taomni_0.4.35_amd64.AppImage` | Linux AppImage | 实际 ELF 的 DT_NEEDED 不包含 Sherpa/ONNX 动态库；无本次 Windows DLL 遗漏或 macOS 路径问题。 |
| `Taomni_0.4.35_amd64.deb` | Linux DEB | 同上；保留 DEB 升级目标。 |
| `Taomni-0.4.35-1.x86_64.rpm` | Linux RPM | 同上；保留 RPM 升级目标。 |

对应的 `.sig` 是签名，不是可安装文件；签名有效只能证明载荷未被篡改，不能证明其依赖齐全。

这里的“未发现”限定于本次依赖与打包问题。Windows 上完成了原生复现及安装器测试；没有在 macOS/Linux 桌面环境执行完整的旧版本→新版本升级、重启和业务验证。

## Windows 根因与修复

`src-tauri/Cargo.toml` 在 Windows 上为解决 MSVC 静态 CRT 冲突，将 `sherpa-onnx` 配置为 `default-features = false, features = ["shared"]`；其他平台仍为静态链接。

`sherpa-onnx-sys` 将运行库复制到 Cargo 输出目录。Tauri 的 MSI 打包器会扫描该目录的 `*.dll`；NSIS 只加入配置资源、特定运行库和外部二进制，不自动收集这些 DLL。原先的 `bundle.resources` 只有 SocksCap 资源。因此构建成功、MSI 成功，都不能保证 NSIS 完整。

已在 `src-tauri/nsis/hooks.nsh` 的 POSTINSTALL 中显式安装以下文件到 `$INSTDIR`，即主程序同目录：

- `sherpa-onnx-c-api.dll`
- `sherpa-onnx-cxx-api.dll`
- `onnxruntime.dll`
- `onnxruntime_providers_shared.dll`

文件源从 Tauri 提供的实际主程序路径推导，兼容自定义 target 目录、`--target`、debug/release 和带空格路径。默认发布构建缺少任意 DLL 即编译失败。POSTUNINSTALL 清除这四个自有文件，保留其他文件；复制发生在 Tauri 停止应用之后。

新增 `scripts/verify-windows-release-bundle.ps1`：在临时目录中解开实际 NSIS 和 MSI，检查 DLL 与构建输出哈希一致，再使用 `LoadLibraryEx` 加载 DLL 及其传递依赖。搜索范围只包含载荷目录和 System32，避免 PATH、Cargo 输出或本机已有 MSI 掩盖遗漏。MSI 用 `/a` 管理提取，不注册为本机安装。发布工作流在上传构建产物之前执行此检查。

## macOS Intel 根因与修复

Intel Kerberos bottle 由 `install-krb5-macos-x86_64.sh` 直接解包，包含以下形式的 Mach-O 路径：

```text
@@HOMEBREW_PREFIX@@/opt/krb5/lib/libgssapi_krb5.2.2.dylib
@@HOMEBREW_CELLAR@@/krb5/1.22.2/lib/libkrb5.3.3.dylib
```

原 `bundle-krb5-macos.sh` 只改写以 `/` 开头的绝对路径，因此漏掉这些占位路径。库文件虽然在 `Contents/Frameworks` 内，dyld 却不会自动把错误路径替换成该目录。发布包的主程序有 1 处，库间依赖有 9 处残留。

修复将五种已知 Kerberos 库名的引用统一改成 `@rpath/<库名>`，覆盖标准 Homebrew 路径和 PREFIX/CELLAR 占位符，操作仍发生在最终应用签名及升级归档生成之前。`otool` 失败会终止打包。

新增 `scripts/verify-macos-runtime-paths.sh` 并接入已有发布校验：分别检查主 `.app` 和解开的升级 `.app`，要求 Frameworks rpath 存在、非系统依赖定位到实际附带的库，并拒绝未打包的外部路径或占位路径。主程序与附带 dylib 都被检查。

## 升级包选择

当前 `updateStore` 对 Windows/Linux 的单候选平台传 `undefined`，保留 Tauri 2.11 的安装类型识别。`latest.json` 包含独立的 `-nsis`、`-msi`、`-deb`、`-rpm`、`-appimage` 键；macOS 两种架构使用各自 `.app.tar.gz`。无需改成所有 Windows 都升级 MSI，或所有 Linux 都升级 AppImage。

没有可识别安装类型的旧客户端仍可能使用通用后备键：Windows 对应 NSIS，Linux 对应 AppImage。因此“曾经用 MSI 安装”本身不能证明旧客户端此次下载的就是 MSI。

## 验证记录

- Node 22.23.3 / pnpm 10.34.6。
- `node --test scripts/windows-runtime-bundle.test.mjs scripts/compose-updater-manifest.test.mjs scripts/verify-updater-signatures.test.mjs`：26 项通过；Windows 的 NSIS 测试未跳过，包含真实编译、新安装、覆盖旧 DLL、卸载保留用户文件、缺失 DLL 拒绝打包。
- `node --test scripts/macos-runtime-paths.test.mjs scripts/verify-macos-release-bundle.test.mjs`：18 项通过。使用 Git Bash 和可控的 macOS 工具替身验证脚本分支，包括两种占位符、绝对路径、缺库、缺 rpath、签名/归档检查；不等同于 macOS 原生签名和启动实测。
- `pnpm test src/stores/updateStore.test.ts src/lib/updateService.test.ts`：28 项通过，保留单候选平台的安装类型自动识别与升级状态流。
- 使用本机已有原生二进制，在独立 Cargo target 目录重新生成 NSIS/MSI 测试包；两者均通过实际解包、DLL 哈希和 Windows 原生加载校验。测试包省略无关 SocksCap 资源，不作为完整产品发布物。
- 对已发布的原始 NSIS/MSI 运行新增检查，按预期拒绝旧 NSIS：`Missing runtime file beside taomni.exe: .../sherpa-onnx-c-api.dll`。
- 原始 NSIS 主程序在独立目录启动返回 `0xC0000135`；未进入应用初始化。
- 九个发布包的哈希及七个升级包的 Minisign 验证通过；ELF、PE、Mach-O 依赖来自实际发布包，使用 7-Zip、tar 和 LIEF 读取。
- 一次 pnpm 命令因多传 `--` 意外启动全量 Vitest，观察到 VNC/Terminal 的无关失败后停止，改为上述明确的文件参数；没有宣称全量测试通过。
- `git diff --check` 通过。

## 发布与用户恢复

代码修复尚未发布。应使用高于 0.4.35 的版本重新构建、签名并通过新增检查，让已安装 0.4.35 的客户端也能检测到更新。不能在签名后手改安装包或 `.app`。

已无法启动的 Windows 用户可以使用已验证的 0.4.35 MSI 恢复。macOS Intel 用户需要修复后的 Intel 包，或先回退到可用版本；Apple Silicon 可选用本次检查未发现上述问题的 ARM64 原生包。发布前仍需在对应系统执行真实旧版本升级、重启和核心功能冒烟测试。
