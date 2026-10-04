# macOS 截图授权检查与无 Developer ID 的签名方案

## 已确认的原因

2026-10-04 在 macOS 14.8.7 上检查 `/Applications/Taomni.app` 0.4.30：

- 应用采用 ad-hoc 临时签名，没有 TeamIdentifier。
- `codesign -d -r- /Applications/Taomni.app` 显示指定要求为 `cdhash H"8fc3a5e22c0da877e02f82767be20ddbc8bd188c"`。
- TCC 日志多次报告 `Failed to match existing code requirement for subject com.taomni.app and service kTCCServiceScreenCapture`。旧授权要求 `dd18fab5d8f5ca549903a83e16ead336a5653e80`，与当前二进制不匹配。

TCC 根据应用身份和代码签名要求识别已授权程序。临时签名没有稳定的签名证书，指定要求退化为二进制哈希；升级替换文件后，旧授权不再匹配。因此问题发生在升级之后，而不是 macOS 要求每次升级前重新授权。只保留相同名称、安装路径或 Bundle ID 无法解决已经观测到的哈希不匹配。

CoreGraphics 的 `CGWindowListCreateImage` 在屏幕录制权限缺失时仍可能返回有效图片，只包含桌面和调用方自己的窗口。原实现将“拿到图片”视为成功：默认入口隐藏自身窗口后只剩桌面，当前窗口入口还能看到自身。这不构成其他应用窗口被隐藏的证据。

## 没有 Developer ID 时的可执行方案

建议长期复用一张自签名的**代码签名证书及其私钥**，使指定要求基于固定签名证书和 `com.taomni.app`，而不是每次变化的 cdhash。Apple 的 [TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) 说明了指定要求、自签名身份和自建 CA 的机制；不同系统子系统仍有各自的接受策略。因此这是一条可验证的方案，不能把文档中的通用代码签名机制当作本机 TCC 跨版本验收已经通过。

本地维护步骤：

1. 打开“钥匙串访问”，使用“证书助理 → 创建证书”，名称例如 `Taomni Local Code Signing`，身份类型选自签名根证书，证书类型选“代码签名”；设置适合维护周期的有效期。只创建一次。
2. 在该证书的信任设置中为代码签名设置适当信任，确认签名身份可用：

   ```sh
   security find-identity -v -p codesigning
   ```

3. 导出包含私钥的加密 `.p12` 并安全备份。后续开发机或 CI 导入同一份身份；不能每次构建重新生成证书。证书同名但重新生成，身份仍会改变。私钥、p12 和密码不提交进仓库。
4. 让 Tauri 对最终应用包使用该身份签名，例如：

   ```sh
   APPLE_SIGNING_IDENTITY='Taomni Local Code Signing' pnpm tauri build \
     --config '{"bundle":{"macOS":{"hardenedRuntime":false}}}'
   ```

   也可在仅用于本地构建的 Tauri 配置覆盖文件中设置 `bundle.macOS.signingIdentity`。CI 使用同一张证书的 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` 和对应 `APPLE_SIGNING_IDENTITY`，由下述工作流预先导入。当前 Tauri CLI 2.11.4 的自动证书导入只解析 Apple 证书名称前缀，不能直接用它导入普通自签名证书。自签名路径不要配置 Apple 公证凭据，也不要把缺少 Developer ID 的构建当作已公证发行包。

5. 核对**最终 `.app`**，而不仅是 `target/release/taomni`：

   ```sh
   codesign --verify --deep --strict --verbose=2 '/path/to/Taomni.app'
   codesign -dv --verbose=4 '/path/to/Taomni.app'
   codesign -d -r- '/path/to/Taomni.app'
   ```

   指定要求应具有固定的证书约束及 `identifier "com.taomni.app"`。如果仍只有 `cdhash H"..."`，或 Identifier 包含每次变化的二进制 UUID，就没有达到目标。证书签名后再修改 Mach-O 加载命令或包内资源会破坏签名，应完成这些修改后签名。

   仓库的 `bundle-krb5-macos.sh fixbin` 在打包之前修改加载路径并临时签名；Tauri 的最终证书签名应发生在这之后。自签名不需要 `APPLE_TEAM_ID`；新的验收脚本根据实际签名模式分别检查固定证书和可选的公证。

6. 首次从临时签名切换为证书签名时，旧 cdhash 授权不会自动迁移。完全退出应用，在“系统设置 → 隐私与安全性 → 屏幕录制”中重新添加当前应用并允许，再重启。
7. 用同一身份签第二个版本，确认 Bundle ID 和指定要求一致；先授权第一个版本，再替换为第二个版本，在应用内检查权限并截图另一应用的内容。这是实际跨升级验收。系统升级、证书更换和系统自身的重新确认策略仍可能要求用户再次确认。

自签名不提供 Apple 公证和 Gatekeeper 的 Developer ID 信任。首次打开和授权仍可能需要用户操作；不必为稳定的代码身份而全局关闭 Gatekeeper 或 SIP。若继续使用临时签名，则无法通过固定 Bundle ID、提前授权或升级脚本可靠保持现有授权；实际可行的退路是检测授权失效并引导用户重新授权。固定签名的采集辅助程序也可隔离主应用升级，但需要独立 IPC、生命周期和授权设计，本次不引入。

## GitHub 发布与自动升级配置

`.github/workflows/release.yml` 已接入固定证书方案，支持 Developer ID 或长期复用的自签名根代码签名证书。正式 tag 发布必须同时配置固定 macOS 证书和 Tauri 升级密钥；缺失或配置不完整时失败，不再静默降级为临时签名。仅在未配置证书、且 `workflow_dispatch` 的 tag 为空时，允许生成临时签名的测试产物。

在 GitHub 仓库的 Settings → Secrets and variables → Actions 配置：

| 名称 | 保存位置 | 值 |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | Secret | 一次创建并备份的、包含私钥的 `.p12` 文件的 base64 内容。每次构建复用同一份。 |
| `APPLE_CERTIFICATE_PASSWORD` | Secret | 导出该 `.p12` 时的密码；允许空密码，但建议导出加密备份。 |
| `APPLE_SIGNING_IDENTITY` | Secret | 证书完整名称，例如 `Taomni Local Code Signing`；Developer ID 则使用其完整 `Developer ID Application: … (…)` 名称。 |
| `MACOS_SIGNING_CERT_SHA1` | Variable | 同一证书的 40 位 SHA-1 指纹，不带冒号或空格。可从 `security find-identity -v -p codesigning` 取得。此指纹用于固定身份，不是二进制 cdhash。 |
| `TAURI_SIGNING_PRIVATE_KEY` | Secret | 原有升级私钥，必须与 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey` 匹配。 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | 原有升级私钥密码；允许空密码。 |

自签名方案只需上述配置，不需要付费 Apple Developer 账号。不要为了本次 macOS 签名变更重新生成 Tauri 升级密钥；旧版本使用内置公钥验证下载，直接换钥匙会使已安装的旧版本无法更新。

如果采用 Developer ID 并需要 Apple 公证，另外同时设置 `APPLE_ID`、`APPLE_PASSWORD`（应用专用密码）和 `APPLE_TEAM_ID` 三个 Secrets。完全不配置这三个值时仍执行固定证书签名，只跳过公证；部分配置会报错。自签名证书应不配置这三个值。

实际流程与检查：

1. `configure-release-signing.mjs` 在临时钥匙串导入 `.p12`，核对证书名称、有效期、指纹和可用私钥。自签名证书只在一次性的 GitHub 托管 runner 中以 `codeSign` 策略配置管理员信任，通过非交互 sudo 避免弹窗；`always()` 清理步骤移除信任和钥匙串。脚本不会把 `.p12` 和其密码写入后续步骤的环境文件。
2. 传给 Tauri 的 `APPLE_SIGNING_IDENTITY` 使用已核对的证书指纹，同时用于 arm64 和 x86_64。加载路径修补、资源打包完成后由 Tauri 签名，再生成 `.app.tar.gz` 和升级 `.sig`；没有在归档生成后重新签名。自签名通过临时配置覆盖将 `bundle.macOS.hardenedRuntime` 设为 `false`：自签名没有 Apple Team ID，默认库验证会阻止加载捆绑的 krb5 动态库。Developer ID 构建启用 hardened runtime；基础配置和正式 Entitlements 不改写。
3. `verify-macos-release-bundle.sh` 对最终 `.app` 和解压后的升级 `.app` 执行严格签名校验，核对固定证书、`com.taomni.app`、对应签名模式的 runtime 配置、稳定的指定要求、相同的主程序及指定要求。公证启用时另查 Gatekeeper 和 stapler。原有 Xray 架构检查和上游 Redirector 原始归档字节检查继续执行。
4. 构建步骤只保存 workflow artifacts，汇总作业要求全部平台完成，且两种 macOS 架构都有 DMG 安装包。它为两个架构生成不同的升级 URL，复制时保留安装包、归档和 `.sig` 的原始字节。`verify-updater-signatures.mjs` 按 Tauri 的 Minisign 格式用内置公钥验证所有升级包及 trusted comment；全部通过后才创建或复用 GitHub release、上传安装包与升级资源，最后上传完整的 `latest.json`。已有 release 的标题和说明保留，新建 release 自动生成说明并按版本判断 prerelease，先保持 draft，所有文件上传成功后才公开，避免空发行版成为最新版本。
5. Node.js / pnpm 固定为仓库要求的 22 / 10。多行升级私钥和密码按 GitHub 环境文件的分隔符格式传递，避免被原有单行写法截断。

tag 为空的测试构建未配置升级私钥时，通过临时配置关闭 `createUpdaterArtifacts`；这些产物用于手工测试，不具备自动升级签名。正式发布不允许使用该分支。

### 仅构建安装包的跨版本授权测试

`workflow_dispatch` 新增 `platforms`（`all` / `macos`）、`macos_arch`（`both` / `x86_64` / `aarch64`）和可选 `test_version`。默认行为仍构建全部平台和架构。构建前的 plan 作业校验选择、tag 和测试版本；带 tag 的正式发布禁止部分构建和测试版本覆盖。

Intel Mac 可使用空 tag、`platforms=macos`、`macos_arch=x86_64`，分别构建 `0.4.31-permission.1` 和 `0.4.31-permission.2`。测试版本通过 Tauri 配置覆盖同时应用到应用包和产物名称，不修改仓库版本。空 tag 始终跳过发行汇总作业，只保存 Actions artifacts；升级私钥和固定 macOS 证书继续使用仓库原有配置。

先安装第一个版本、实际完成系统屏幕录制授权并截图另一个应用，再安装第二个版本。记录两次安装包的版本、证书指纹、指定要求和 cdhash：证书与指定要求应相同，而版本与 cdhash 应不同。只有第二个版本实际截图成功且没有重新授权，才能确认这台机器上的授权保留。

验证范围：Node.js 22 下 55 项脚本测试通过，覆盖签名配置、模拟钥匙串导入/失败与清理、应用与升级归档验收分支、升级清单/签名校验。升级验签包含上游 Minisign 的已知测试向量、正确签名、错误密钥、篡改包和篡改 trusted comment；macOS 验收分支使用模拟系统命令，不等同于真实证书签包。`release-workflow.test.mjs` 读取当前工作流的汇总步骤，用临时升级签名包与模拟 gh 执行已有发行版、新建正式版/prerelease、草稿重跑和失败路径，确认签名校验失败时无 GitHub 调用、资源在清单之前上传、上传失败不公开草稿。工作流通过 actionlint、24 个 Bash run block 的语法检查和 YAML 解析。

本地证据：`qa-ui-auto-report/macos-screenshot-permission/_local/release-signing-tests.log`。尚未使用真实发行证书运行 GitHub 发布，也没有实际安装两个版本来验证跨升级 TCC 授权保留；配置完成后的第一轮发布仍需这些验收。

## 本次修复及验证范围

- 截图打开流程在隐藏任何应用窗口之前检查权限；缺失时在主线程调用 `CGRequestScreenCaptureAccess`，之后重新 preflight，未生效或仍需重启就退出。
- `capture_display` 再检查权限；直接整屏/区域命令和复用该函数的逐帧采集也不能将权限不足的图片视为成功。采集工作线程不会弹授权窗口。
- 按钮沿用应用错误弹窗；应用内快捷键显示同样的弹窗；全局快捷键失败时显示并聚焦应用窗口，将错误交给该窗口的弹窗。
- 错误说明包含系统设置路径、升级后重新添加当前应用、退出重开，以及系统将授权归属于启动终端时的处理。
- `TC-SHOT-N16` 在独立 QA 应用中只注入权限拒绝，检查两个真实 IPC 命令及按钮、当前窗口、全局快捷键处理器。记录实际窗口 hide 调用数、窗口可见性、覆盖层、文件和可关闭的提示；不授予或重置主机权限。
- 保留像素采集场景为 `TC-SHOT-N10`。实际授予 Apple 系统权限、全局快捷键物理输入、自签名跨升级授权及 Windows/Linux 运行结果需要各自的证据，不能从拒绝场景或编译成功推断。

本次不增加新的可交互控件，复用已有 `alert-dialog-message` / `alert-dialog-ok`。新增用例已注册任务范围对应的 CI policy，无新的用例依赖。
