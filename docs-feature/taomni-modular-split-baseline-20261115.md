# Taomni 模块化拆分 M0 基线（2026-11-15）

本报告记录 TASK-001 的可复现源码、前端构建和 Rust 依赖基线。2026-11-15 起点没有真实安装 artifact，保留当时的缺口；2026-11-17 已追加 GitHub 真实 Linux/Windows/macOS ARM64 发布包采样。后续迁移批次应在相同命令和 runner 上追加增量。

## 采样身份

- 仓库：`engcapa/taomni`
- 分支：`refactor/modules-arch`
- 提交：`e0e68715ea9f43e3c40a7744e759c356e332cbea`
- 核心版本：`package.json` `0.5.9`
- 采样日期：2026-11-15（Asia/Shanghai）

## 可复现命令

```bash
du -sh dist src-tauri/target
find dist -maxdepth 2 -type f -printf '%s %p\n' | sort -nr
cargo tree --manifest-path src-tauri/Cargo.toml --depth 1
find src-tauri/target/release/bundle -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.msi' -o -name '*.dmg' \)
```

## 当前结果

| 项目 | 结果 |
| --- | ---: |
| `dist/` | 49M |
| `src-tauri/target/`（含 debug/release 缓存） | 12G |
| 可发布安装包 | 未生成；需要 GitHub hosted release runner |
| Rust 顶层依赖条目 | 166 行（`cargo tree --depth 1`，含 build-dependencies） |

`dist/` 最大文件为 `assets/App-DIBR3EzW.js`（5,637,370 bytes），其次是 OCR 的 Tesseract wasm/语言包；这些资源在插件迁移前仍随核心前端输出。当前还应重点关注 `katex`、`docxRuntime`、图表 chunk、`screenshot-ocr/`、`resources/mobile-web` 以及 vendored `wry`，后续迁移报告必须单独列出它们的增量。

## 解释与限制

这是一份 M0 起点，不是“核心已瘦身”的证明。`target/` 是本地编译缓存，不能作为发布包大小；`dist/` 也不是 Tauri 安装包，不能替代三端 artifact 采样。TASK-023 的 release workflow 必须在 Linux、Windows、macOS runner 生成真实包，并将包大小、SHA-256、平台和构建提交写入后续基线更新。

## 2026-11-17 真实安装包追加采样

生产来源为 [Release Bundle #43997809941](https://github.com/engcapa/taomni/actions/runs/43997809941)，完整产品源码 `1eec7eca4ede44e9266d927674c4c7ea5f38ffe1`，测试版本 `0.6.0`。空 tag 的 artifact-only 构建未创建 tag 或 Release；版本只用于构建，不改变仓库 `package.json`。本表保留各目标产出后的观察，不等待其它 builder；macOS Intel 尚待产出，不计完成。

| 平台 / 实际文件 | bytes | SHA-256 |
| --- | ---: | --- |
| Linux `Taomni_0.6.0_amd64.deb` | 109723960 | `7a59a7a2f9e37ca5bebe92d756201a26893f942bfa90254c8db6160699068431` |
| Linux `Taomni-0.6.0-1.x86_64.rpm` | 109721189 | `2bc3e18c868524fcdd6a9c1dda62f0987b2b9773de2ba7b551384a8ca6e23305` |
| Linux `Taomni_0.6.0_amd64.AppImage` | 177220088 | `2753b495f687431b8e8d40f88fb12dcb080ddb2b8979b77e2322154f7e5bb2c3` |
| Windows `Taomni_0.6.0_x64-setup.exe` | 71962590 | `b4f157d09153581497c5d1ae716f647b613646e5fc8a24585620521f60704f53` |
| Windows `Taomni_0.6.0_x64_en-US.msi` | 95920128 | `e40bb65abfc9a1081d91d9700b68801267a58361088b0b4c8a12d924201b453c` |
| macOS ARM64 `Taomni_0.6.0_aarch64.dmg` | 98372970 | `5f7178abb8e3e406a3078c559a17f29f8bda08dc9d46fb1582066c4670df079e` |
| macOS ARM64 `Taomni.app.tar.gz` | 100228062 | `7141a9b0b96306ea800eb8f614af7bf3af7eca9d90e8815cae77455a5a7a56f9` |

Linux [采样 #44003740535](https://github.com/engcapa/taomni/actions/runs/44003740535) 使用工具源码 `a6ded7c847aa47d9055213f0e821e385c497ac1b`，消费不可变 artifact `14293785052`。原始结果保存在 `qa-ui-auto-report/github/44003740535/live-samples/modular-bundle-linux-x86_64-43997809941/`：`bundle-baseline.json` 记录各包及 `.sig` 完整大小/哈希，`deb-fields.json`、`deb-executable-header.log`、`rpm-info.log` 和 `linux-payload.json` 保留真实解析/解包结果。deb 内版本 0.6.0、amd64、ELF64 x86-64，19 个 regular files 共 `300466152` bytes，主 executable `248145288` bytes、SHA-256 `943dc505bfe0591227129c73e59530f45b27dfe251c09338fbefe43f3d0c8042`。

Windows [首轮采样 #44004139461](https://github.com/engcapa/taomni/actions/runs/44004139461) 使用同一工具源码，消费不可变 artifact `14293312470`。原始结果保存在对应 `live-samples/modular-bundle-windows-x86_64-43997809941/`。真实 MSI 行政解包确认版本 0.6.0、x86_64 PE，四个 Sherpa/ONNX DLL 从自身目录/System32 隔离加载成功；但 PowerShell Dictionary 聚合使 `regularFileBytes=null`，该 run **不建立完整 Windows 负载基线**，须修复后在 Windows runner 复跑。主 executable SHA-256 为 `d454c4af1b6ac1538aa68d1f47d234facf7863b2d750efa747a247167818e894`。MSI 与 NSIS 的 Authenticode 均为 `NotSigned`，系统信任仍是缺口。

修复版 [Windows 采样 #44005219331](https://github.com/engcapa/taomni/actions/runs/44005219331) 已成功，工具源码 `c387ec1b5ce31ade501c211d70f781c10cc8b535`，仍消费上述同一 artifact / 产品源码。`windows-payload.json` 确认 **22 个 regular files、244526386 bytes**，最大文件为 `taomni.exe`（`172381696` bytes）；四 DLL 隔离加载和所有包/主 executable 哈希均与首轮一致。新的完整性 guard 在 runner 上通过。修复后的原始文件保存在 `qa-ui-auto-report/github/44005219331/live-samples/modular-bundle-windows-x86_64-43997809941/`，首轮 null 字段证据仍保留。Authenticode 仍为 `NotSigned`。

[macOS ARM64 采样 #44007458035](https://github.com/engcapa/taomni/actions/runs/44007458035) 已成功，工具源码同为 `c387ec1b5ce31ade501c211d70f781c10cc8b535`，消费不可变 artifact `14294272883`。实际 DMG app 为 `com.taomni.app` / `0.6.0` / `arm64`，**24 个 regular files、254517950 bytes**；主 executable 为 `197316832` bytes，SHA-256 `d4ce1bb4bcacced895ec04c9743ffd03e60ceba81fa513a9f46c97cb9182c921`。DMG/updater app 的 executable 哈希一致，二者 `codesign --verify --deep --strict` 和 DMG runtime paths 通过。实际证书 `Taomni Local Code Signing`、TeamIdentifier 未设置；加隔离标记后的 `spctl --assess` exit 3、`rejected`，**系统信任不成立**。原始签名、quarantine、Gatekeeper 和负载结果保存在 `qa-ui-auto-report/github/44007458035/live-samples/modular-bundle-darwin-aarch64-43997809941/`，不能将采样 job 成功记为 G1 通过。

包体积是文件本身的 bytes，不是 Actions zip 大小。产品仍含业务实现，不能据此宣称核心瘦身；本批未启动应用或进行真实已安装升级，不建立启动/内存、legacy exporter、系统分发信任或 G1–G11 通过证据。


### macOS Intel 实际包（2026-11-17）

[采样 #44012918046](https://github.com/engcapa/taomni/actions/runs/44012918046) 成功；在 producer Intel artifact 上传后立即单目标 dispatch，不等待其它作业 summary。产品源码 `1eec7eca4ede44e9266d927674c4c7ea5f38ffe1`，工具源码 `35bc698a4eed84a795e6dcaafc23ab44268d51f9`，producer #43997809941，版本 0.6.0。immutable artifact `14296274984`，Actions zip 209251132 bytes，SHA-256 `ca84f2ddfe0119e3b0e8f38fdc53f482196db57d9fc3ebdbcf3a941c3b76b278`。

| 实际文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `Taomni_0.6.0_x64.dmg` | 104470089 | `e169a5148bee57ee65303f95f24d7ab58763e25a211c46062ae878fed86152e5` |
| `Taomni.app.tar.gz` | 105608526 | `46eb17e24ce76f6fa8b778f30063f32821602805b30be67f471404d0dcedc3c6` |

实际 DMG app 为 24 个 regular files / 270375836 bytes；主 executable 209838992 bytes，SHA-256 `961f45298699cd7337b8047e8195245925a3802abfea0da4f72bd427c6322f35`，架构 x86_64。updater app 的 identifier/version/executable hash 与 DMG 一致。DMG/updater `codesign --verify --deep --strict`、runtime paths 和 quarantine readback 通过；`spctl --assess` exit=3 / rejected，`systemTrustEstablished=false`。job 成功不能转为 G1 系统分发信任通过；没有启动应用或验证安装升级。

原始证据：`qa-ui-auto-report/github/44012918046/live-samples/modular-bundle-darwin-x86_64-43997809941/` 中的 `bundle-baseline.json`、`bundle-source.json`、`macos-payload.json` 与 `producer-artifacts.json`；完整 producer/tooling 身份分开保留。
