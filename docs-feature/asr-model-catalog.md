# ASR 模型目录与更新协议

## 当前交互与验收边界（2026-10-08）

Whisper 与 Zipformer 共用设置页模型卡片、下载/续传/更新/重新安装按钮、使用模型、链接操作及任务进度面板。任务快照和事件按 revision 去重，关闭再打开恢复下载状态；取消后显示保留断点，重试使用原安装命令。两者均在代理配置未保存或已有下载时禁用新的下载。Whisper 保留 `.bin` 导入，Zipformer 暂无目录导入入口。

本轮 Linux 验证：`AsrPanel.test.tsx` 10 项通过；浏览器 `TC-VOICE-002/003/004` 通过；Rust `asr::models::tests` 9 项通过，覆盖共享下载底层的真实本地 HTTP/CONNECT/SOCKS、取消、Range 续传和完整性。浏览器使用明确的 fixture，不代表桌面窗口或线上模型升级验收。

仍待完成：两者的版本来源均为编译时目录，“检查版本与完整性”尚未查询线上最新版本。Zipformer 的“更新”标记目前也可能将部分文件/损坏误判为旧版本；新安装写入钉版 revision 子目录，四文件全部验证后才发布 `.revision` 标记并切换；下载失败时旧平铺目录保持可用。旧版已验证文件与安全 `.part` 会复制到新目录复用；最终仍验证完整哈希。这些不能视为已支持动态线上升级。

## 两种“升级”

- 用户选择更大模型：Base → Small → Medium；每个模型独立安装，不因为切换中文/英文再复制一份相同权重。
- 同一模型的数据更新：维护者验证上游新权重后随应用发布新目录；运行时比较 SHA-256 标识，提示显式更新。当前没有远程目录刷新或自动追踪 upstream `main`。

这个边界使离线部署也有确定的版本，并防止远程元数据把不兼容权重自动推送到用户机器。

## 目录字段和磁盘布局

`src-tauri/src/asr/catalog.rs` 定义目录版本、上游仓库不可变修订、模型 ID、文件名、精确字节数及 SHA-256。SHA-256 是权重版本的真实标识，界面显示前 12 位；目录版本变更而 SHA 不变不会重复下载。

文件路径：`<cache>/taomni/models/<model-id>/<sha256>/<filename>`。安装先写同目录 `.part`，限制大小并校验，再发布最终文件。取消或网络错误保留 `.part` 用于 Range 续传，SHA-256 校验失败清理损坏文件；新的目录不覆盖任何历史版本。重新安装当前版本时保留仍然有效的文件，只替换损坏文件。

`voice_models` 返回廉价库存及版本差异；`voice_check_models` 在阻塞线程进行完整校验，返回 missing/unverified/verified/corrupt 状态与 update_available。识别引擎每次冷加载也校验，不能仅凭库存显示或目录名信任文件。安装与完整性检查串行，避免对正在写入的文件作出错误判定。

旧版未分版本的 `.bin` 被标记为需要更新，用户可以选择离线导入复用文件。旧版 sherpa 配置迁移为 Base，但不自动下载；旧权重不误当成 Whisper 权重。

## 发布新目录

1. 从官方仓库确认多语言模型、许可证、上游 revision，核对大小和 SHA-256；明确与 whisper-rs/whisper.cpp 格式兼容。不要将 `.en`、GGUF 或量化权重混入同一条目。
2. 更新 catalog 常量；若 Base 变化，同步 `scripts/voice-fixture.py` 的 URL/哈希。新增模型必须同时更新 Rust/TS 配置迁移、设置列表/stub 及对应测试。
3. 至少使用固定中文、英文样本进行真实解码；记录准确性和时延。不能把旧模型通过当作新权重证据。更换引擎版本也需要重新验收。
4. 验证旧版本目录存在时提示更新、显式检查不会下载、坏文件拒绝、下载失败旧版本保留、更新后可冷加载、离线导入和旧应用回退可复用历史目录。
5. 随应用发布目录与变更说明，写明语言、大小、硬件需求和可能的内存/性能变化。运行时不自动清理历史权重；用户可在应用退出后自行清理不需要的缓存版本。

后续若需要独立于应用更新模型目录，先增加受信目录签名/固定分发源、引擎兼容版本范围、目录回退与离线目录导入；不能简单将下载 URL 指向可变 latest。

## Quantized and SenseVoice catalog (2026-10-asr-2)

Quantization is an independent entry with its own filename, exact bytes and hash.
Existing f16 entries remain readable for explicit migration; Medium f16 is hidden
from new model selection unless already installed/selected. The replacement action
downloads the matching q8 tier, verifies it, saves the new selection, then removes
old f16 artifacts. Failure or cancellation before publication retains the old file.
Medium q8 is a migration target only; Turbo q5 is the recommended high quality tier.

Whisper upstream remains revision `5359861c739e955e79d9a303bcbc70fb988958b1`:

| Entry | Bytes | SHA-256 |
|---|---:|---|
| Base q8_0 | 81,768,585 | `c577b9a86e7e048a0b7eada054f4dd79a56bbfa911fbdacf900ac5b567cbb7d9` |
| Small q8_0 | 264,464,607 | `49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f` |
| Medium q8_0 (migration) | 823,369,779 | `42a1ffcbe4167d224232443396968db4d02d4e8e87e213d3ee2e03095dea6502` |
| Turbo q5_0 | 574,041,195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |

SenseVoice source: `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`
at revision `2365baeacb507f821a0c8120fcee3d484dba7a07` (Hugging Face).
Weights: 239,233,841 bytes, SHA-256
`c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`.
Tokens: 315,894 bytes, SHA-256
`f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc`.
The official API's LFS metadata and downloaded token hash were checked through the
configured application proxy. Runtime verifies both before loading the recognizer.
The token file is published in the weight's content-addressed directory before
weights become visible; interrupted installation cannot report an incomplete
bundle ready. Offline import requires tokens.txt beside model.int8.onnx.

The exact recommended total is **504,014,342 bytes (480.7 MiB)**, including tokens.
The design's 493 MB was an estimate mixing size conventions. SenseVoice uses the
accepted FunASR Model License v1.1 and is downloaded on demand, never bundled.
It supports zh/yue/en/ja/ko; Small q8 adds es/fr/it (and existing de support).
Small/Base map Cantonese to Whisper's legacy zh token; SenseVoice/Turbo are the
paths with distinct yue support. CPU greedy decoding remains capped at 4 threads.

Domestic mirror evaluation: no independently verified redistribution permission,
stability history and matching pinned artifacts were established. No mirror is
advertised or selected. The official source works through the application proxy;
future mirror enablement must satisfy D10 and must remain an explicit user choice.
