# Taomni 模块化拆分 M0 基线（2026-11-15）

本报告记录 TASK-001 的可复现源码、前端构建和 Rust 依赖基线。当前工作区没有可发布的 Windows/macOS/Linux 安装 artifact，因此安装包体积栏明确标为待 hosted release build；后续每个迁移批次应在相同命令和 runner 上追加增量。

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

