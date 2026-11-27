# taoffice 视频插件：系统原生解码 API 路线调研报告

> 调研时间：2026-11-15；对象：Taomni（Tauri 2 + React 19 + Rust，系统 webview）视频插件选型。
> 硬约束：第三方能力须以 Rust/TS 库编译进应用，**不接受 sidecar 进程**；单个插件包 ≤100 MB；许可证须能进 MIT 项目分发。
> 需求：先播放（mp4/webm/mov/mkv/avi/rm 等），再编辑/转码；音频并入同一插件。
> 方法：用 `browser.search` / `browser.open` 实际查证；查不到的写“未核实”，不凭记忆编造。**一次 `browser.open` 官方 MF 格式页返回 429，未能直接打开**，该页内容以搜索结果摘要为准，已在文中注明。
> 本报告只给事实与每条路线的优缺点小结，**不做最终 verdict**。

---

## 0. 先说结论性事实（E 的直接答案）

- **系统原生路线不能完整覆盖 mkv / avi / rm。** Windows MF 对 MKV 是部分支持、对 AVI 是容器可读但编解码依赖系统解码器；macOS AVFoundation 对 MKV/WebM/AVI（DivX/Xvid）/RM 均无原生 demuxer/解码器；Linux 没有统一系统解码方案，WebKitGTK 的播放能力取决于系统 GStreamer 插件是否装全。详见 §E 表格。
- **没有查到一个成熟的、已发布的 Rust 跨平台 crate 能把 MF + VideoToolbox + VA-API 包成统一播放 API。** 查到的都是各项目自研的三后端抽象（如 egui-vid、FilmCraft），或以 FFmpeg/libmpv 为统一后端。见 §D。
- **“系统 webview 直接播”不等于“插件直接播”。** Windows WebView2（Chromium）、macOS WKWebView（WebKit/VideoToolbox）、Linux WebKitGTK（GStreamer）三者的 `<video>` 能力各不相同，且都不覆盖 MKV/AVI/RM 全集；若插件要自己解码，帧还得想办法送进 React/WebView 显示，目前未查到现成的 Rust+Tauri 官方/主流做法，见各节“帧取出与送显”。

---

## A) Windows Media Foundation（MF）

### A1. 能否经 Rust 调用：可以，`windows` crate（windows-rs）有 MF 绑定

- `windows` crate 提供 `Win32_Media_MediaFoundation` 特性（feature），与 `Win32_System_Com`、`Win32_Foundation` 配合使用；示例代码直接 `use windows::Win32::Media::MediaFoundation::*`。来源：https://deepwiki.com/shiguredo/video-device-rs/3.2.1-windows:-media-foundation-backend
- 该实现被描述为“纯 Rust、无 FFI、无 C/C++、不用 bindgen”，因为 MF 是 COM API，`windows-rs` 生成类型安全绑定。来源：同上；另见 https://deepwiki.com/shiguredo/video-device-rs/3.1-cross-platform-design
- 实际项目用法：`windows = { version = "0.62", features = ["Win32_Media_MediaFoundation", …] }`，并用 `IMFSourceReader`、`IMFMediaSource`、`MFEnumDeviceSources` 等做采集/枚举（该例是摄像头采集，不是文件播放，但证明绑定可用）。来源：https://deepwiki.com/shiguredo/video-device-rs/1.1-supported-platforms-and-backends
- **完整性未核实**：未查到 `windows` crate 是否覆盖 MF 全部接口（`IMFMediaEngine`、`IMFSinkWriter`、全部 MFT 等）的逐项清单；只核实了 SourceReader / MediaSource / 设备枚举这条线可用。需要时应以 `docs.rs` 上 `windows` crate 的 `Win32_Media_MediaFoundation` 模块清单为准做二次核对——本次未逐项核对，记为未核实。
- COM 初始化要求：需先初始化 COM，该项目用多线程套间（MTA，`COINIT_MULTITHREADED`），并用 `MFSTARTUP_NOSOCKET` 初始化 MF。来源：https://deepwiki.com/shiguredo/video-device-rs/6.2-windows-considerations
- FilmCraft 的 ADR 也写明：Windows 后端用官方 `windows` crate（MIT OR Apache-2.0），只开所用 Win32 特性。来源：https://github.com/storytold/filmcraft/blob/main/docs/adr/0001-platform-ffi.md

### A2. 支持的容器 / 编码

| 容器/编码 | 核实结果 |
|---|---|
| MP4 / M4V / MOV | 支持。MF 的 MPEG-4 file source 可读 MP4、M4A、M4V、MP4V、MOV、3GP。来源：https://en.wikipedia.org/wiki/Media_Foundation_Transform |
| H.264/AVC | 内置（inbox），Windows 7+ 即有；硬件解码支持。来源：https://deepwiki.com/fafalone/ucSimplePlayer/6.1-media-codec-requirements ；另见 https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation |
| HEVC/H.265 | **不是内置**：需 Microsoft Store 的 HEVC Video Extensions；一处资料称该扩展售价 $0.99，另一处称有免费的“HEVC Video Extensions from Device Manufacturer”版本。两者是否等价、当前 Store 价格未核实。来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation ；https://www.free-codecs.com/guides/how_to_get_the_codecs_downloaded_automatically.htm |
| VP9 | 微软官方 MKV 支持页列出 MKV 内 VP9（`V_VP9` → `MFVideoFormat_VP90`）；但另有资料称 VP9 需 Store 的 VP9 Video Extensions，且 egui-vid 的表称 Win10/11 的 VP9 为“✗/不支持”。**存在冲突，未完全核实**，应以目标 Windows 版本实测 `IMFMediaEngine::CanPlayType` / SourceReader 为准。来源：https://learn.microsoft.com/en-us/windows/win32/medfound/mkv-support ；https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation |
| AV1 | 微软官方 MKV 支持页列出 MKV 内 AV1（`V_AV1` → `MFVideoFormat_AV1`）；另有资料称需 AV1 Video Extensions，且 Win10 需 Build 19041+ 及支持 AV1 解码的 GPU。来源：https://learn.microsoft.com/en-us/windows/win32/medfound/mkv-support ；https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation |
| VP8 | 一处资料称 Win10/11 均不支持；另一处称 Windows 内置支持 VP8。**冲突，未核实。** 来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation ；https://www.tutorialpedia.org/blog/windows-10-error-video-not-decoded/ |
| MKV | **部分支持**。微软官方页明确支持 MKV 内 H.264、HEVC、VP9、AV1 等编码；egui-vid 称“MKV partial，有限，可能需要 FFmpeg”。来源：https://learn.microsoft.com/en-us/windows/win32/medfound/mkv-support ；https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation |
| AVI | 有 AVI File Source（Windows 7 起），可读 AVI；MPEG-4 Part 2（Simple/Advanced Simple Profile）解码器可解 DivX、Xvid、Nero Digital，以及 MJPEG、DV。来源：https://en.wikipedia.org/wiki/Media_Foundation_Transform ；另见 https://www.free-codecs.com/guides/codecs_supported_by_windows_media_player_for_windows_xp.htm（称 AVI 对 DivX/Xvid/DV/Motion JPEG/未压缩视频为 Yes，更老/更怪的编码需 codec pack） |
| WebM | egui-vid 的表称 WebM“✗ 不支持，需要 FFmpeg”。但 VP9 扩展存在的前提下 WebM 容器本身是否可用，未核实。来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation |
| Vorbis / Opus | Vorbis 被明确称为“MF 不支持，需要 FFmpeg”。Opus 未核实。来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation |
| RM / RMVB / RealVideo | **未在 MF 官方支持列表或本次检索到的 MF 资料中找到 RealMedia 支持，未核实/无证据支持。** 应视为系统路线不覆盖。FFmpeg 侧见 §E。 |
| 音频（内置） | MP3、AAC、M4A、FLAC、ALAC、WAV、WMA、3GP、3G2、AMR 被列为 Windows 内置音频支持。来源：https://www.tutorialpedia.org/blog/windows-10-error-video-not-decoded/ |

### A3. 系统自带、体积、许可证

- MF 是 Windows 系统组件（Vista 引入，Win7 起成熟），应用调用它**不需要随包分发解码器，插件体积零成本**（只增加调用代码）。来源：https://en.wikipedia.org/wiki/Media_Foundation_Transform
- `windows` crate 本身许可证为 MIT OR Apache-2.0（以 `windows-composition` 等同源 crate 的 Cargo.toml 标注为准；另有第三方项目第三方法律声明称 windows-rs 为 MIT OR Apache-2.0）。来源：https://docs.rs/crate/windows-composition/latest/source/Cargo.toml ；https://github.com/mg-chao/snow-apps/blob/main/snow_shot/THIRD_PARTY_NOTICES.md
- **系统 API 调用本身有无许可证限制：未核实。** 未查到微软关于“调用 MF 解码 H.264/HEVC 是否另需专利许可”的官方表述；HEVC 的 Store 扩展收费是已核实的间接信号（见 A2）。分发 MIT 项目时，调用系统 API 本身不引入 copyleft 依赖，但编解码专利许可问题应由法务/产品另行确认，记为未核实。
- 另注意：MF 的编码能力与解码能力不对称——Vista 时代 MF 编码仅支持 WMA/WMV，Win7 加入 H.264 Baseline/Main 与 AAC-LC 编码器。转码/编辑若依赖 MF 编码器，可选编码器比解码器更窄。来源：https://en.wikipedia.org/wiki/Media_Foundation_Transform

### A4. 解码帧如何取出并送到 WebView/React 显示；音频解码与播放

- **取帧的标准做法是 SourceReader**：`MFCreateSourceReaderFromURL`（或 `MFCreateSourceReaderFromByteStream`）创建 `IMFSourceReader`，用 `SetCurrentMediaType` 指定输出为未压缩格式（如 NV12、P010、RGB32/BGRA），再循环调用 `IMFSourceReader::ReadSample` 得到 `IMFSample`（含时间戳）。来源：https://learn.microsoft.com/en-us/gaming/gdk/docs/gdk-dev/overviews/mediafoundation-decode?view=gdk-2610 ；https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation
- **硬件解码帧可走 D3D11 纹理**：配置 DXGI 设备管理器后，解码输出可查询 `IMFDXGIBuffer` 得到 D3D11 纹理句柄，实现零拷贝；egui-vid 称其用 D3D11 shared handle 把纹理导入 wgpu/D3D12 渲染管线，但 NV12 常需回退 CPU 拷贝 + YUV→RGB 转换。来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation
- **高层播放做法是 `IMFMediaEngine`**：被描述为“一个对象即完整播放器”，可解析 URL/字节流、选解码器、跑 Media Session、管理时钟；frameserver 模式可把解码帧交给 D3D11 swap chain/纹理。来源：https://vectree.io/pdf/c/media-foundation
- **送到 WebView/React 显示：未核实，无现成做法。** 未查到“MF 解码帧 → Tauri WebView2 `<video>`/`<canvas>`/WebCodecs”的官方或主流 Rust 示例。逻辑上可行的三条路（均属推断，需 spike 验证，不作为已核实事实）：(1) 把帧转 RGB 后经 Tauri command / 自定义协议以图片/视频流形式推给前端（有拷贝与帧率成本）；(2) 用 WebCodecs `VideoDecoder` 在前端解码（但 WebCodecs 仍需前端自己 demux，且不解决 MKV/RM）；(3) 不用 WebView 画视频，改用原生窗口/纹理叠加（与 Tauri webview 架构冲突较大）。**本项是系统路线最大的未验证集成点。**
- **音频解码**：同一 SourceReader 可把音频流输出设为 PCM（16-bit 整数或 32-bit 浮点），`ReadSample` + `IMFSample::ConvertToContiguousBuffer` 取 PCM 数据；微软官方教程即用 SourceReader 解码音频并写 WAV。来源：https://learn.microsoft.com/en-us/windows/win32/medfound/tutorial--decoding-audio
- **音频播放**：解出的 PCM 可交给 XAudio2（`XAudio2Create` 创建引擎，PCM/ADPCM 可直接用；MF 解码后即 PCM）；或走 MF 自己的 Media Session / `IMFMediaEngine` 播放管线。来源：https://learn.microsoft.com/en-gb/windows/uwp/gaming/tutorial--adding-sound ；https://vectree.io/pdf/c/media-foundation
- **WASAPI** 是更底层的 Windows 音频 API（低延迟/独占），XAudio2 之下一般不需要直接用 WASAPI 做普通播放。来源：https://copyprogramming.com/howto/visual-c-or-c-play-sounds（该页对 WASAPI 的定位为专业/低延迟场景）

### A5. 已知局限

- **编解码支持依赖系统与 Store 扩展**：HEVC/VP9/AV1/MPEG-2 需另装 Store 扩展；不同 Windows 版本/构建号支持不同。来源：https://deepwiki.com/fafalone/ucSimplePlayer/6.1-media-codec-requirements ；https://www.tutorialpedia.org/blog/windows-10-error-video-not-decoded/
- **Windows N / KN 版缺 MF 与全部编解码器**：N 版不含 Windows Media Player、Media Foundation、音频编解码（MPEG/WMA/AAC/FLAC/ALAC/AMR/Dolby Digital）与视频编解码（VC-1/MPEG-4/H.264/H.265/H.263），需安装免费的 Media Feature Pack（Win10 1909+ / Win11 在“设置 > 应用 > 可选功能”中添加）才能恢复；未装之前依赖 MF 的功能会失败。来源：https://www.ghacks.net/which-is-better-windows-pro-or-pro-n/ ；https://www.ghacks.net/2015/08/03/media-feature-pack-for-windows-10-n-and-kn-versions/
- **容器支持不等于文件一定能播**：同一容器内编码不同，结果不同；MKV/WebM/Vorbis 等为部分或不支持。来源：见 A2 表格。
- **egui-vid 的 Windows MF 后端自述为“进行中、未在真实硬件上测试”**，需在 NVIDIA/AMD/Intel GPU 上验证。来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation

### A 小结（优缺点）

- 优点：Rust 绑定成熟（`windows` crate，纯 Rust、无 bindgen）；系统自带、零体积、硬件加速（DXVA/D3D11VA）；MP4/MOV/H.264/AAC 主流组合开箱即用；取帧（SourceReader → NV12/D3D11 纹理）与转码（SinkWriter）路径在 API 层面都存在。
- 缺点：MKV 部分、WebM/Vorbis/RM 不覆盖或未核实；HEVC/VP9/AV1 依赖 Store 扩展与 GPU/系统版本；N 版需 Media Feature Pack；帧送进 WebView/React 无现成做法，需自研且有性能风险。

---

## B) macOS VideoToolbox + AVFoundation

### B1. 能否经 Rust 调用：可以，两条线并存

- **`objc2` 系列（生成式绑定）**：`objc2-video-toolbox` 0.3.2（VideoToolbox 框架绑定）、`objc2-av-foundation`（AVFoundation）、`objc2-audio-toolbox`（AudioToolbox）、`objc2-avf-audio`（AVFAudio）均存在；`objc2` 的框架列表页明确列出这四个框架与对应 crate。来源：https://docs.rs/objc2/latest/objc2/topics/about_generated/list/index.html ；https://docs.rs/objc2-av-foundation/latest/objc2_av_foundation/ ；https://lib.rs/os/macos-apis
- `objc2-video-toolbox` 的 docs.rs 源码显示其由 `objc2` 的 header-translator 自动生成，包含 `VTDecompressionSession`、`VTCompressionSession`、`VTDecompressionSessionDecodeFrame` 等。来源：https://docs.rs/crate/objc2-video-toolbox/latest/source/src/generated/VTDecompressionSession.rs ；https://docs.rs/crate/objc2-video-toolbox/latest/source/src/generated/VTCompressionSession.rs
- 下载量信号（非质量证明）：`objc2-video-toolbox` 0.3.2 近期下载 159,263、累计 183,573；`objc2-audio-toolbox` 0.3.2 约 1.7M 近期下载（lib.rs 列表页数据）。来源：https://crates.io/crates/objc2-video-toolbox/range/^0.3.2 ；https://lib.rs/os/macos-apis
- **`videotoolbox` crate（安全封装）**：lib.rs 描述为“Apple VideoToolbox 的安全 Rust 绑定——硬件加速编解码、像素传输/旋转、多遍、HDR 元数据等”，最新 0.21.0（2026-09-24），28 个发布、18 次 breaking，MIT/Apache，状态自述为“experimental”，但已覆盖 doom-fish 栈所用的主要公开 VideoToolbox 接口；要求 macOS 13.0+。来源：https://lib.rs/crates/videotoolbox
- **维护状态**：`objc2` 是持续维护的生成式绑定项目（0.6.4 主 crate、0.3.2 框架 crate）；`videotoolbox` 相对小众（lib.rs 标注用于 11 个 crate），且自述 experimental，选型时应以它是否覆盖 `VTDecompressionSession` 的全部所需能力为准做核对，记为需二次核实。
- 许可证：`objc2` 系列为 Zlib OR Apache-2.0 OR MIT（第三方项目统计中 objc2 相关 crate 标注为 Apache-2.0 OR MIT OR Zlib）；`videotoolbox` 为 MIT/Apache。来源：https://github.com/satoramoto/yahaha/blob/HEAD/docs/plugin-hosting.md ；https://lib.rs/crates/videotoolbox
- FilmCraft ADR 同样写明 macOS 用 `objc2-*` crate（MIT / Apache-2.0 / Zlib），不链接 GPL/LGPL 内容。来源：https://github.com/storytold/filmcraft/blob/main/docs/adr/0001-platform-ffi.md

### B2. 支持的容器 / 编码

| 容器/编码 | 核实结果 |
|---|---|
| MP4 / MOV / M4V | 原生支持。QuickTime/AVFoundation 原生容器为 `.mov`、`.mp4`、`.m4v`。来源：https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ |
| H.264/AVC | 全版本支持，硬件加速。来源：https://github.com/ivg-design/reframer/blob/HEAD/docs/archive/legacy-implementation/IMPLEMENTATION_REPORT.md |
| HEVC/H.265 | macOS 10.13+，硬件加速（Apple Silicon）；8/10-bit、HDR10/Dolby Vision。来源：同上；https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ |
| ProRes | 原生支持，全部 profile（Proxy/422 LT/422/422 HQ/4444/4444 XQ/RAW）；硬件/软件解码。来源：https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ |
| AV1 | macOS 14+；硬件解码仅 M3/M4 芯片，M1/M2 为软件解码；且只在 MP4/MOV 内。来源：https://github.com/ivg-design/reframer/blob/HEAD/docs/archive/legacy-implementation/IMPLEMENTATION_REPORT.md ；https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ |
| VP9 | **VideoToolbox 硬件解码存在争议**：一处称 Apple Silicon 支持 VP9（Profiles 0/2），另一处称 QuickTime/AVFoundation 文件播放拒绝 VP9，需第三方/软件解码。应理解为：VideoToolbox 底层可能有 VP9 解码能力，但 AVFoundation 文件播放路径不接受 VP9/WebM 文件。来源：https://deepwiki.com/egui-vid/egui-vid/4.1-macos:-avfoundation-and-videotoolbox ；https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ |
| MKV | **无原生 demuxer**。AVFoundation 没有 Matroska demuxer，即使内含 H.264 也会因容器无法解析而拒绝；egui-vid 对 MKV/WebM 自动回退 FFmpeg。来源：https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ ；https://deepwiki.com/egui-vid/egui-vid/4.1-macos:-avfoundation-and-videotoolbox |
| WebM | 无原生支持（与 MKV 同理；egui-vid 回退 FFmpeg）。来源：同上 |
| AVI | 无原生支持：AVFoundation 不能解 DivX/Xvid 等 MPEG-4 Part 2 编码；苹果官方帮助页把 `.avi` 列为打不开的例子。来源：https://www.hazenstudio.com/maclc/blog/quicktime-file-not-compatible/ |
| RM / RealVideo | QuickTime 支持表明确把 RealVideo 列为拒绝项；**系统路线不覆盖**。来源：https://www.hazenstudio.com/maclc/blog/quicktime-file-not-compatible/ |
| 音频 | AAC、ALAC、FLAC、AC-3、E-AC-3、LPCM 等原生支持。来源：https://www.hazenstudio.com/maclc/blog/what-is-a-codec/ |

### B3. 系统自带、零体积；解码帧取出方式；音频

- VideoToolbox / AVFoundation / AudioToolbox 均为 macOS 系统框架，**不随包分发，零体积**。来源：B1 许可证段（系统框架不需 vendor）及 Apple 框架性质；具体“零体积”表述为本报告基于系统框架性质的推断，已在多处第三方资料中一致体现（如 egui-vid 称 AVFoundation demux“without external dependencies”）。来源：https://deepwiki.com/egui-vid/egui-vid/4.1-macos:-avfoundation-and-videotoolbox
- **最省事的取帧路径是 `AVAssetReader`**：创建 `AVAsset` → 取视频轨 → 配 `AVAssetReaderTrackOutput`（指定输出像素格式，如 420v / BGRA / Y416）→ `startReading()` → 循环 `copyNextSampleBuffer()`，从 `CMSampleBuffer` 取 `CVImageBuffer`（`CVPixelBuffer`）。`AVAssetReader` 会自动做硬件解码并返回指定格式的解码帧。来源：https://apple-docs.everest.mt/docs/wwdc/wwdc2020-10090/ ；https://readmedium.com/swiftui-working-with-video-using-avfoundation-part-1-read-display-modify-frames-72d6a4d8075e
- **手动控制的路径是 `VTDecompressionSession`**：从 `CMSampleBuffer` 取 `CMFormatDescription` 创建 session，调 `VTDecompressionSessionDecodeFrame`（可异步），回调收到解码后的 `CVImageBuffer`；解码器在独立沙箱进程中运行。来源：https://apple-docs.everest.mt/docs/wwdc/wwdc2020-10090/ ；https://docs.rs/crate/objc2-video-toolbox/latest/source/src/generated/VTDecompressionSession.rs
- **零拷贝**：解码出的 `CVPixelBuffer` 底层常为 `IOSurface`，可经 `CVMetalTextureCache` / IOSurface 直接导入 Metal 纹理而不经 CPU 回读；egui-vid 即用此方式。来源：https://deepwiki.com/egui-vid/egui-vid/4.1-macos:-avfoundation-and-videotoolbox ；https://apple-docs.everest.mt/docs/wwdc/wwdc2020-10090/
- **送到 WebView/React 显示：与 Windows 同理，未核实。** 未查到“`CVPixelBuffer` → Tauri WKWebView `<video>`/`<canvas>`”的现成 Rust 做法；WKWebView 本身用 VideoToolbox 解码 `<video>`，但那是浏览器内播放本地文件/流的路径，不是插件把解码帧喂给前端的路径。需 spike 验证（与 A4 相同风险）。
- **音频（AudioToolbox / AVFAudio）**：`objc2-audio-toolbox` 与 `objc2-avf-audio` 存在；`AVAssetReader` 同样可输出音频轨的 PCM 样本（`AVAssetReader` + 音频 `AVAssetReaderTrackOutput`，或 `AVAssetReaderAudioMixOutput`）。`AVAssetReader`/`AVAssetWriter` 被描述为“低层、帧精确的媒体 I/O 对”，可直接拿到 `CMSampleBuffer` 中的 `CVPixelBuffer` 帧或 PCM 音频。来源：https://docs.rs/objc2/latest/objc2/topics/about_generated/list/index.html ；https://vectree.io/pdf/c/avfoundation
- **音频播放的具体 Rust 路径未核实**：未查到经 Rust 调用 `AVAudioEngine` / AudioToolbox 输出单元播放 PCM 的主流示例；逻辑上可用 `cpal`（其依赖中出现 `objc2-avf-audio`、`objc2-audio-toolbox`）或直接调 AudioToolbox，但未核实。来源：https://docs.rs/crate/cpal/latest/target-redirect/wasm32-unknown-unknown/settings.html（仅证明 cpal 依赖这些 crate，不证明播放路径）

### B4. 已知局限

- 容器白名单窄：MKV、WebM、AVI（DivX/Xvid）、FLV、RM 均不在原生支持内；即使编码本身硬件可解，容器解析失败也会导致整个文件被拒。来源：https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/ ；https://www.hazenstudio.com/maclc/blog/quicktime-file-not-compatible/
- VP9/AV1 有硬件代际门槛：AV1 硬件解码限 M3/M4，VP9 文件播放路径不支持。来源：见 B2 表格。
- 自 macOS 15 起可通过 media extensions（随 app 分发的媒体扩展）在系统级扩展格式，但苹果官方不提供 MKV/AVI/WMV 的扩展。来源：https://www.hazenstudio.com/maclc/blog/quicktime-file-not-compatible/
- VideoToolbox 解码器在沙箱外进程运行，`AVAssetReader`/`VTDecompressionSession` 的输出回调有背压要求（在回调内阻塞会阻塞后续帧输出）。来源：https://apple-docs.everest.mt/docs/wwdc/wwdc2020-10090/

### B 小结（优缺点）

- 优点：Rust 绑定存在且活跃（`objc2` 生成式绑定 + `videotoolbox` 安全封装）；系统自带、零体积；H.264/HEVC/ProRes 硬件加速成熟；`AVAssetReader` 一步到位给解码帧（`CVPixelBuffer` + IOSurface 零拷贝到 Metal）。
- 缺点：容器覆盖最窄——MKV/WebM/AVI/RM 全不覆盖；VP9/AV1 有代际与路径限制；帧送进 WebView/React 同样无现成做法；`videotoolbox` crate 自述 experimental。

---

## C) Linux：VA-API / PipeWire / 系统编解码

### C1. VA-API 是什么；是否需要另装驱动/库

- VA-API（Video Acceleration API）是开源 API，让 VLC、GStreamer 等应用使用 GPU 的硬件视频加速能力；由免费开源库 **libva** 实现，配合硬件专属驱动（通常随 GPU 驱动提供）。来源：https://en.wikipedia.org/wiki/VA-API
- 它本身**只是硬件加速接口**，不是完整的播放/解码方案：只负责解码/编码、子画面混合、渲染等加速入口；容器解析（demux）、音频、同步仍需上层（GStreamer/FFmpeg 等）提供。来源：同上
- 驱动需按 GPU 另装/另配：Intel 用 `intel-media-driver`（iHD，Broadwell+）或老 `i965`；AMD 用 Mesa（`mesa-va-drivers`）；NVIDIA 无原生 VA-API，需社区 `nvidia-vaapi-driver` 转译到 NVDEC。来源：https://linuxdork.com/blog/hardware-video-acceleration-linux-browsers/
- 可用 `vainfo`（`libva-utils`）检查驱动与支持的 profile/entrypoint（`VAEntrypointVLD` 为硬件解码）。来源：同上
- 支持的编码取决于硬件与驱动能力；官方主线列出的加速入口包括 MPEG-2、MPEG-4 ASP/H.263、H.264、HEVC、VC-1/WMV3 等。来源：https://en.wikipedia.org/wiki/VA-API

### C2. Linux 有无统一的系统解码方案：没有；GStreamer 是事实标准

- Linux 没有类似 MF/AVFoundation 的单一系统解码框架。实际承担该角色的是 **GStreamer**（及在其之上的 WebKitGTK、FFmpeg 等）。
- Tauri Linux 用 **WebKitGTK**，WebKitGTK 把音频/视频播放委托给 **GStreamer**。多个 Tauri 项目的 README 一致写明：Linux 视频解码走 WebKitGTK + 系统 GStreamer 插件；缺插件时视频会黑屏/转圈或 WebKitGTK 的 web 进程直接崩溃。来源：https://github.com/Flow-Tube/Flow-Desktop/blob/HEAD/README.md ；https://github.com/OpenSelena/omniget ；https://blog.alextldr.com/posts/rustwave/
- 具体插件分工（Debian/Ubuntu 命名）：`gstreamer1.0-plugins-good`（含音频 sink，缺它 WebKitGTK 可能崩溃）、`gstreamer1.0-plugins-bad` 与 `gstreamer1.0-libav`（提供 H.264/AAC 等解码）。WebM/VP9、Opus、Vorbis、WAV 通常经 `plugins-good` 即可；H.264/MP4、AAC、MP3 需 `libav` 和/或 `plugins-bad`。来源：https://github.com/OpenSelena/omniget ；https://github.com/q-qp-p/openclaw/blob/HEAD/apps/linux/README.md
- 发行版差异是真实风险：Fedora 上 H.264 解码（`gstreamer1-libav`、`gstreamer1-plugins-bad-freeworld`）只在 RPM Fusion 提供，需用户另启用。AppImage 可通过 `bundleMediaFramework` 把 GStreamer 框架与插件打进包；`.deb`/`.rpm` 则把插件声明为依赖。来源：https://github.com/Flow-Tube/Flow-Desktop/blob/HEAD/README.md ；https://github.com/s-stude/claude-code-tauri-v2-skills/blob/HEAD/skills/tauridoc-distribute/SKILL.md
- WebKitGTK 的媒体支持**依赖系统 GStreamer 插件是否装全**，不是 Tauri 自带。来源：同上。

### C3. 能否经 Rust 调用 VA-API 或 GStreamer 系统库；与直接用 `gstreamer-rs` 的区别

- **`gstreamer-rs`**：GStreamer 的 Rust 绑定，MIT/Apache 双许可；绑定多由 `gir` 根据 GStreamer 的 GObject-Introspection 元数据自动生成；构建需系统装 GStreamer ≥1.14 与 `gst-plugins-base` ≥1.14。**GStreamer 本身为 LGPL-2.1**。来源：https://lib.rs/crates/gstreamer ；https://lib.rs/crates/gstreamer-base
- **直接用 `gstreamer-rs` = 调用系统 GStreamer**：建 pipeline（`filesrc → demux → decode → convert → sink`），GStreamer 负责 demux、解码（含经 VA-API 硬件加速）、音频、同步、渲染；Rust 只编排 pipeline 与收帧/收音频。这是 Linux 上最接近“系统原生播放”的做法。
- **直接调 VA-API ≠ 用 `gstreamer-rs`**：VA-API 只给硬件编解码入口，调用者仍需自己做 demux（解析 MP4/MKV/AVI/RM）、码流解析（SPS/PPS、slice 参数、DPB 管理）、帧管理与音频。工作量大一个量级。
- **Rust 的 VA-API 绑定不成熟**：
  - 查到的 `moq-vaapi` 仅做 H.264 编解码（Linux Intel/AMD），且 crates.io 页面自带“⚠️ AI GENERATED”警告，要求使用前审查；它用 bindgen + 内置 libva 头文件，运行时链接系统 `libva`/`libva-drm`。来源：https://fastly-app.crates.io/crates/moq-vaapi
  - 另一条线 `cros-libva`/`cros-codecs` 是 git 依赖的 fork，曾因 libva 1.23 新增字段导致编译失败，后被 `moq-vaapi` 替代。来源：https://github.com/moq-dev/moq/pull/1757
  - FilmCraft 的做法是**手写 FFI**：libva 声明从 MIT 许可的 `va.h` 转录，运行时用 `libloading` 加载 `libva.so.2`/`libva-drm.so.2`，无 libva 时回退软件解码；其 VA-API 后端目前只写明 H.264 与 HEVC 解码。来源：https://github.com/storytold/filmcraft/blob/main/docs/adr/0001-platform-ffi.md
  - **结论**：没有查到像 `windows`/`objc2` 那样成熟、广泛使用的 VA-API 安全封装 crate；直接调 VA-API 意味着手写/维护一套 libva FFI + 码流解析。
- **帧取出与送显**：经 `gstreamer-rs` 可用 `appsink` 取解码帧（CPU 内存）或经 VA-API/DMABUF 取 GPU surface；送进 WebView/React 的现成做法同样未核实（与 A4/B3 相同风险）。**本项未核实。**
- **音频**：GStreamer pipeline 自带音频解码与输出（经 PulseAudio/PipeWire/ALSA sink）；若只用 VA-API，则音频需另找解码器与输出。来源：C2 的 GStreamer pipeline 性质；PipeWire 部分见 C4。

### C4. PipeWire：不是解码器

- PipeWire 是低延迟、基于图的**处理引擎与服务器**，用于接音频/视频设备，替代 ALSA/PulseAudio/JACK 的部分场景；也用于 Wayland 下的屏幕共享/远程桌面门户。来源：https://wiki.gentoo.org/wiki/PipeWire/en
- 它**不提供编解码**：不解析容器、不解 H.264/HEVC/VP9；视频方面只做采集/路由/共享。把它列为“视频解码路线”是概念错误，应只在“音频输出”或“屏幕采集”语境下考虑。
- Rust 绑定情况：本次未检索到成熟的 PipeWire Rust crate 作为视频播放依赖；PipeWire 本身是系统守护进程 + 库，应用需其运行时存在。**记为未核实/不适用。**

### C 小结（优缺点）

- 优点：`gstreamer-rs` 绑定成熟（MIT/Apache），GStreamer pipeline 一步到位给 demux+解码+音频+同步；VA-API 硬件加速在驱动正常时可用；WebKitGTK `<video>` 在插件装全时可直接播。
- 缺点：Linux **无统一系统解码方案**，能力取决于发行版与用户是否装了插件（Fedora/RPM Fusion、N 版式问题在 Linux 以发行版差异形式出现）；VA-API 只是加速入口，Rust 绑定不成熟，需手写 FFI + 码流解析；PipeWire 不是解码器；AppImage 打包 GStreamer 会显著增大体积（见 §E）。

---

## D) 有无跨平台抽象库把三套系统 API 包起来

### D1. 结论：未查到成熟的统一抽象 crate

- 检索到的跨平台做法都是**各项目自研抽象**：egui-vid（Windows MF / macOS AVFoundation+VideoToolbox / Linux 未在本次检索中确认）、FilmCraft（`crates/platform` 一处集中 `unsafe` FFI，Windows 用 `windows` crate、macOS 用 `objc2-*`、Linux 用手写 libva FFI）。这些是**应用内抽象，不是可复用的发布 crate**。来源：https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation ；https://deepwiki.com/egui-vid/egui-vid/4.1-macos:-avfoundation-and-videotoolbox ；https://github.com/storytold/filmcraft/blob/main/docs/adr/0001-platform-ffi.md
- **未核实**：是否存在其他小众统一抽象 crate（如以 MF/VideoToolbox/VA-API 为后端的 Rust 播放库），本次检索未发现，不能断言不存在。

### D2. libmpv：是 C 库、可链接，不是 sidecar；但许可证与体积需说明

- **libmpv 是 mpv 播放器作为库的形式**，不是独立进程；Rust 有 `libmpv`/`mpv` 等绑定 crate（`mpv` crate 自述“libmpv bindings for Rust”，本 crate MIT/Apache-2.0）。来源：https://docs.rs/mpv/0.2.3/mpv/
- **许可证分层**：
  - libmpv 客户端 API 本身按 ISC 许可，以方便与其他许可证互操作；但 **mpv 核心大部分仍是 GPLv2+**，用该 API 的应用是否受 GPL 影响“由律师决定”。来源：同上
  - 另有资料称 mpv/libmpv 为“LGPL-2.1-or-later 或 GPL-2.0-or-later，取决于构建配置”；FFmpeg 为“LGPL-2.1-or-later，某些可选部分为 GPL”。来源：https://www.cuvee.io/licences
  - 存在 LGPL 构建做法：以 `-Dgpl=false` 构建 mpv、FFmpeg 不开 `--enable-gpl`/`--enable-version3`，并检查构建结果确为 LGPL 模式；Ice Commander 即用此方式在 macOS/Linux/Android 自建 libmpv，Windows 用 LGPL 构建的 libmpv。来源：https://www.icecommander.com/licenses
  - **对 MIT 项目的影响**：若以 LGPL 模式动态链接 libmpv/FFmpeg，需履行 LGPL 义务（提供 LGPL 文本、提供对应源码/可再链接方式等）；若误用 GPL 构建，则整个分发物可能被 GPL 约束。**这与“MIT 项目分发”的硬约束直接冲突，需法务确认，不能仅凭“LGPL 可动态链接”就通过。**
- **不是 sidecar**：libmpv 以动态库（`.dll`/`.so`/`.dylib`）形式被应用加载，同一进程内调用；这符合“不接受 sidecar 进程”的字面约束（进程内库 vs 独立进程）。但它仍需随插件分发二进制库文件，体积与分发义务见 §E。
- **Rust 侧**：`libmpv2-sys` 为 libmpv 的原生 FFI sys crate（Debian 打包信息称许可证 LGPL-2.1）。来源：https://www.mail-archive.com/debian-wnpp@lists.debian.org/msg283981.html
- **实际 Tauri 案例**：Miteiru（Tauri + libmpv 视频播放器）称 Windows/macOS 构建会自行获取固定版本的 LGPL libmpv，Linux 用系统 libmpv。来源：https://web.mswott.net/p?url=http%3A%2F%2Fgithub.com%2Fhockyy%2Fmiteiru&__src=http%3A%2F%2Fgithub.com%2Ftopics%2Fmecab&__type=xmlhttprequest

### D3. 其他跨平台方案（与系统 API 的关系）

- **`ffmpeg-next`（`rust-ffmpeg-next`）**：FFmpeg 的安全 Rust 封装；需系统装 FFmpeg 开发库，或用 `build` 特性从源码编译最小 FFmpeg（Linux/macOS 支持，Windows 走 vcpkg）。默认 LGPL v2.1+；开 `build-license-gpl`/`build-license-nonfree` 会变为 GPL/非自由。最小构建包含 FFmpeg 原生解码器（通常 H.264、HEVC、VP9、AAC、MP3），**不含 AV1/dav1d**（除非另有该库）。来源：https://github.com/yeautyye/ez-ffmpeg/blob/HEAD/docs/INSTALL.md ；https://deepwiki.com/kcking/rust-ffmpeg-next/9.1-feature-flags-reference
- **`ffmpeg-next` 与系统 API 的关系**：它是**替代**系统 API 的统一后端，不是封装系统 API；但 FFmpeg 内部可在各平台调用硬件加速（D3D11VA/VA-API/VideoToolbox 等），属于“统一 API + 底层仍用系统加速”的混合体。来源：https://github.com/project-maho/mahord/blob/HEAD/clients/rust/packaging/nsis/README-FFMPEG.md（该页提到 `avcodec` 的 D3D11VA 硬件加速接口）
- **WebCodecs / MediaBunny（仅作补充，未深入）**：WebCodecs 的 `VideoDecoder`/`VideoEncoder` 在浏览器/webview 内把编解码委托给 OS/硬件编码器；Tauri 三端 webview 均有 WebCodecs 支持（Windows WebView2 完整、macOS WKWebView 自 Safari 16.4+、Linux WebKitGTK 需 GStreamer 插件）。但 WebCodecs **不做 demux、不播音频**，仍需另写 demux 与同步。来源：https://github.com/simplearyan/studio-pro/blob/HEAD/docs/video/Cross-Platform-Tauri-MediaBunny-Plan.md
- **未核实**：`media-kit` 等 Flutter/Dart 生态的 libmpv 封装与 Rust 的关系，本次未检索，不作评价。

### D 小结（优缺点）

- 优点：libmpv/ffmpeg-next 提供**一套 API 走遍三平台**，覆盖度远超系统 API；libmpv 还自带播放器语义（demux+解码+同步+渲染+音频），比只给解码器的 FFmpeg 更省应用层代码。
- 缺点：许可证从 MIT/Apache 变为 LGPL（动态链接+义务）或 GPL（误用 GPL 构建时）；体积大（见 §E）；构建/分发复杂度从“调系统 API”变为“每平台编译/打包一套原生库”；libmpv 的 GPL/LGPL 边界需逐构建验证。

---

## E) 对比：系统原生路线 vs 通用库路线（ffmpeg-next）

### E1. 覆盖度对照表（按需求格式：mp4 / webm / mov / mkv / avi / rm）

| 格式 | Windows MF | macOS AVFoundation+VideoToolbox | Linux WebKitGTK+GStreamer（插件装全时） | ffmpeg-next（LGPL 最小构建，见注） |
|---|---|---|---|---|
| mp4（H.264/AAC） | ✅ 内置 | ✅ 原生 | ✅（需 libav/bad） | ✅ |
| mov | ✅ | ✅ 原生 | ✅（qtdemux） | ✅ |
| webm（VP9/Opus） | ⚠️ 部分/冲突：VP9 需扩展，WebM 容器一说不支持；Vorbis 不支持 | ❌ 文件播放不支持 | ✅（plugins-good） | ✅ |
| mkv | ⚠️ 部分：MKV 内 H.264/HEVC/VP9/AV1 有官方支持，但 egui-vid 称有限 | ❌ 无 demuxer | ✅（matroskademux） | ✅ |
| avi（DivX/Xvid） | ⚠️ 容器可读，DivX/Xvid 有 MPEG-4 Part 2 解码器；老/怪编码需 codec pack | ❌ 不支持 | ✅（avidemux + 解码器） | ✅ |
| rm / rmvb（RealVideo/Audio） | ❌ 未找到支持证据 | ❌ 明确拒绝 | ⚠️ 有 `rmdemux`（gst-plugins-ugly）与 RV10–RV40 的 FourCC 定义，但当前发行版是否提供可用的 RealVideo 解码器**未核实** | ✅ FFmpeg 有 `rm` demuxer 与 RealVideo 1–4（rv10/rv20/rv30/rv40）及 Cook/ATRAC3/Sipro 等 RealAudio 解码器 |

- MKV/AVI/RM 的 FFmpeg 证据：FFmpeg 侧 RealMedia 的 demux 与解码见 https://aetherengine.superuser404.de/reference/formats/（该页称其 FFmpeg 构建含 `rm` demuxer、RV10–RV40 与全部 RealAudio）；GStreamer 侧 `rmdemux` 与 RV10–RV40 定义见 https://git.launchpad.net/ubuntu/+source/gst-plugins-ugly1.0/tree/gst/realmedia/rmdemux.h?h=applied/ubuntu/devel&id=e8c61811fbed3c7e58cc93552811add111e1de04 ；MKV/AVI 的 GStreamer demuxer 见 https://code.caric.io/mirrors/gstreamer/raw/commit/03376a208660d0d4d5521f310395bfa1052ba062/docs/random/mimetypes
- **明确回答**：系统原生路线**不能**覆盖 mkv/avi/rm 全集。Windows 能覆盖其中一部分，macOS 几乎全不覆盖，Linux 取决于 GStreamer 插件且 RM  decoder 未核实。若产品要求这三类容器“在三平台都播”，系统路线单独不够，必须补 FFmpeg/libmpv 或类似通用解码器。

### E2. 体积（插件包 ≤100 MB 约束）

- **系统原生路线**：MF/VideoToolbox/GStreamer（系统已装时）均为系统组件，**插件增量体积 ≈ 0 MB**（只含调用代码）。Linux 若需 AppImage 内打 GStreamer 框架与插件，体积会上升；Tauri 文档提到 AppImage 本身 70+ MB，且 `bundleMediaFramework` 用于打包 GStreamer。来源：https://github.com/s-stude/claude-code-tauri-v2-skills/blob/HEAD/skills/tauridoc-distribute/SKILL.md
- **ffmpeg-next / 全量 FFmpeg 构建**：以下数字是**完整 FFmpeg CLI 构建的压缩包大小，不是最小 libavcodec-only 插件的实测大小**，仅作量级参考：
  - Windows x86_64：LGPL static 167.5 MiB、LGPL shared 77.9 MiB；GPL static 192.6 MiB、shared 86.9 MiB。来源：https://newreleases.io/project/github/FFmpeg-Builds/FFmpeg-Builds/release/latest
  - Linux x86_64：LGPL shared 62.9 MiB、GPL static 150.2 MiB。来源：同上
  - Gyan.dev 的 Windows essentials 版：`.7z` 27 MB、`.zip` 88 MB（内容相同，仅压缩率不同）。来源：https://en.pyvideotrans.com/blog/windows-ffmpeg-install-path
  - Arch Linux 的 ffmpeg 包：包大小 15.2 MB、安装后 48.4 MB（该包为发行版裁剪/共享库形式，不等于静态插件体积）。来源：https://archlinux.org/packages/extra/x86_64/ffmpeg/
- **是否 ≤100 MB：未核实。** 最小化构建（只留所需 demuxer/decoder、去字幕/滤镜/编码器、用 shared 动态库）理论上可大幅缩小，但**本次未查到“最小 libavcodec+libavformat 插件实测 MB 数”**，必须以实际裁剪构建实测为准，不能用上述全量数字直接判定通过/不通过。
- **libmpv 体积：未核实。** 未查到 libmpv（含 FFmpeg、libplacebo、dav1d、libass 等）单插件的实测 MB 数；Ice Commander 称其 Codecs 插件含 mpv 0.41.0 + FFmpeg 8.1.2 + libplacebo 等，但未给 MB 数。来源：https://www.icecommander.com/licenses

### E3. 维护成本

| 维度 | 系统原生路线 | ffmpeg-next / libmpv 路线 |
|---|---|---|
| 代码量 | 三套后端（MF / AVFoundation+VideoToolbox / GStreamer 或 VA-API），每套的 demux、解码、帧格式、音频、同步都要分别写；另有 WebView 送显集成待验证 | 一套 API（ffmpeg-next）或一套播放器 API（libmpv），三平台共用；但需处理 FFmpeg/libmpv 的构建与分发 |
| 构建/分发 | 构建简单（系统库链接），但运行时能力不可控（N 版、Store 扩展、发行版插件缺失） | 构建复杂（每平台编译/打包原生库、裁剪配置、LGPL/GPL 边界检查），但运行时能力可控（自带解码器） |
| 运行时不确定性 | 高：同一文件在不同 Windows 版本/版本分支、不同 macOS 芯片、不同 Linux 发行版上表现不同 | 低：同一构建在三平台表现一致（除硬件加速驱动差异外） |
| 许可证合规 | 绑定 crate 为 MIT/Apache/Zlib；系统 API 调用本身的专利许可未核实 | LGPL（动态链接+源码/再链接义务）或 GPL（误用 GPL 组件时）；需逐构建验证 |
| 演进（编辑/转码） | MF 有 SinkWriter、AVFoundation 有 AVAssetWriter、GStreamer 有编码 pipeline，但三套编码器能力各异，需分别实现 | FFmpeg/libavcodec 提供统一编码/转码/滤镜，编辑功能更容易统一实现；但编码器（如 libx264/x265）多为 GPL，需注意 |
| 长期维护 | 跟随 OS 升级（新编码如 AV1 的硬件支持随 OS/芯片而来）；API 相对稳定 | 跟随 FFmpeg/mpV 上游版本（ffmpeg-next 支持 FFmpeg 3.4–8.x，需处理版本检测与 bindgen）；安全更新需及时跟进 |

- ffmpeg-next 的版本与构建要求：需系统 FFmpeg 开发库，支持 FFmpeg 3.4–8.0；`ffmpeg-sys-next` 构建需 C 编译器与 libclang（bindgen）。来源：https://deepwiki.com/zmwangx/rust-ffmpeg/8.1-building-from-source ；https://deepwiki.com/kcking/rust-ffmpeg-next/1.1-getting-started
- ffmpeg-next 的许可证分层：默认 LGPL v2.1+；开 `build-license-gpl` 为 GPL v2+，再开 `build-license-version3` 为 GPL v3+；开 `build-license-nonfree` 则分发受限。来源：https://deepwiki.com/kcking/rust-ffmpeg-next/9.1-feature-flags-reference

### E4. 每条路线的优缺点小结（不做 verdict）

- **系统原生路线**
  - 优点：零体积、硬件加速、绑定 crate 许可证友好（MIT/Apache/Zlib）、主流格式开箱即用。
  - 缺点：覆盖度不足（MKV 部分、WebM/AVI/RM 在 macOS 全缺、Linux 依赖发行版插件）；运行时能力不可控（N 版、Store 扩展、RPM Fusion）；三后端维护成本高；帧送进 WebView/React 无现成做法。
- **ffmpeg-next 路线**
  - 优点：覆盖度最广（MKV/AVI/RM 均有解码器）、一套 API 三平台、编辑/转码能力统一、运行时可控。
  - 缺点：体积是否 ≤100 MB 未核实（需裁剪实测）；许可证变为 LGPL（动态链接+义务）或 GPL（误用时）；构建/分发与安全更新成本高。
- **libmpv 路线**
  - 优点：在 ffmpeg-next 优点之上，还自带播放器语义（同步、渲染、音频、字幕），应用层代码最少；是 C 库、可链接，非 sidecar。
  - 缺点：许可证边界最复杂（mpv 核心 GPLv2+ 与 LGPL 构建并存，需逐构建验证）；体积未核实；同样需每平台打包原生库。

---

## 未核实 / 需 spike 验证的清单

1. `windows` crate 的 MF 绑定是否覆盖插件所需的全部接口（`IMFMediaEngine`、`IMFSinkWriter`、全部 MFT、D3D11 互操作等）——未逐项核对。
2. MF 下 VP9/VP8/WebM 的确切支持情况（检索到冲突表述）。
3. MF 解码帧 → Tauri WebView2 `<video>`/`<canvas>`/WebCodecs 的可行做法与性能——无现成资料。
4. macOS `CVPixelBuffer` → Tauri WKWebView 的可行做法与性能——同上。
5. Linux `gstreamer-rs` `appsink` 取帧 → Tauri WebKitGTK 的可行做法与性能——同上。
6. macOS 经 Rust 的音频播放路径（`AVAudioEngine`/AudioToolbox/`cpal`）——未查到主流示例。
7. 系统 API 调用本身的编解码专利许可问题——未查到官方表述。
8. 最小化 FFmpeg/libmpv 插件的实测体积是否 ≤100 MB——未查到实测数，需裁剪构建实测。
9. Linux 当前发行版是否提供可用的 RealVideo 解码器（GStreamer `rmdemux` 存在，但解码器可用性未核实）。
10. HEVC Store 扩展的当前价格与“免费 Device Manufacturer 版”是否等价——未核实。
11. 是否存在其他小众的统一抽象 crate（MF+VideoToolbox+VA-API）——本次检索未发现，不能断言不存在。

---

## 来源链接（全部）

- https://deepwiki.com/shiguredo/video-device-rs/3.2.1-windows:-media-foundation-backend
- https://deepwiki.com/shiguredo/video-device-rs/1.1-supported-platforms-and-backends
- https://deepwiki.com/shiguredo/video-device-rs/3.1-cross-platform-design
- https://deepwiki.com/shiguredo/video-device-rs/6.2-windows-considerations
- https://github.com/mg-chao/snow-apps/blob/main/snow_shot/THIRD_PARTY_NOTICES.md
- https://learn.microsoft.com/en-us/windows/win32/medfound/mkv-support
- https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/supported-play-type-strings
- https://deepwiki.com/fafalone/ucSimplePlayer/6.1-media-codec-requirements
- https://deepwiki.com/egui-vid/egui-vid/4.3-windows:-media-foundation
- https://www.free-codecs.com/guides/how_to_get_the_codecs_downloaded_automatically.htm
- https://www.tutorialpedia.org/blog/windows-10-error-video-not-decoded/
- https://en.wikipedia.org/wiki/Media_Foundation_Transform
- https://www.free-codecs.com/guides/codecs_supported_by_windows_media_player_for_windows_xp.htm
- https://www.ghacks.net/which-is-better-windows-pro-or-pro-n/
- https://www.ghacks.net/2015/08/03/media-feature-pack-for-windows-10-n-and-kn-versions/
- https://learn.microsoft.com/en-us/gaming/gdk/docs/gdk-dev/overviews/mediafoundation-decode?view=gdk-2610
- https://learn.microsoft.com/en-us/windows/win32/medfound/tutorial--decoding-audio
- https://vectree.io/pdf/c/media-foundation
- https://learn.microsoft.com/en-gb/windows/uwp/gaming/tutorial--adding-sound
- https://copyprogramming.com/howto/visual-c-or-c-play-sounds
- https://lib.rs/crates/videotoolbox
- https://lib.rs/os/macos-apis
- https://docs.rs/crate/objc2-video-toolbox/latest/source/src/generated/VTDecompressionSession.rs
- https://docs.rs/crate/objc2-video-toolbox/latest/source/src/generated/VTCompressionSession.rs
- https://docs.rs/objc2/latest/objc2/topics/about_generated/list/index.html
- https://crates.io/crates/objc2-video-toolbox/range/^0.3.2
- https://docs.rs/objc2-av-foundation/latest/objc2_av_foundation/
- https://docs.rs/crate/objc2-avf-audio/latest
- https://github.com/satoramoto/yahaha/blob/HEAD/docs/plugin-hosting.md
- https://github.com/storytold/filmcraft/blob/main/docs/adr/0001-platform-ffi.md
- https://github.com/ivg-design/reframer/blob/HEAD/docs/archive/legacy-implementation/IMPLEMENTATION_REPORT.md
- https://www.hazenstudio.com/maclc/blog/video-formats-mac-supports/
- https://www.hazenstudio.com/maclc/blog/quicktime-file-not-compatible/
- https://www.hazenstudio.com/maclc/blog/what-is-a-codec/
- https://deepwiki.com/egui-vid/egui-vid/4.1-macos:-avfoundation-and-videotoolbox
- https://apple-docs.everest.mt/docs/wwdc/wwdc2020-10090/
- https://readmedium.com/swiftui-working-with-video-using-avfoundation-part-1-read-display-modify-frames-72d6a4d8075e
- https://vectree.io/pdf/c/avfoundation
- https://docs.rs/crate/cpal/latest/target-redirect/wasm32-unknown-unknown/settings.html
- https://en.wikipedia.org/wiki/VA-API
- https://linuxdork.com/blog/hardware-video-acceleration-linux-browsers/
- https://github.com/Flow-Tube/Flow-Desktop/blob/HEAD/README.md
- https://github.com/OpenSelena/omniget
- https://blog.alextldr.com/posts/rustwave/
- https://github.com/q-qp-p/openclaw/blob/HEAD/apps/linux/README.md
- https://github.com/s-stude/claude-code-tauri-v2-skills/blob/HEAD/skills/tauridoc-distribute/SKILL.md
- https://lib.rs/crates/gstreamer
- https://lib.rs/crates/gstreamer-base
- https://fastly-app.crates.io/crates/moq-vaapi
- https://github.com/moq-dev/moq/pull/1757
- https://wiki.gentoo.org/wiki/PipeWire/en
- https://code.caric.io/mirrors/gstreamer/raw/commit/03376a208660d0d4d5521f310395bfa1052ba062/docs/random/mimetypes
- https://git.launchpad.net/ubuntu/+source/gst-plugins-ugly1.0/tree/gst/realmedia/rmdemux.h?h=applied/ubuntu/devel&id=e8c61811fbed3c7e58cc93552811add111e1de04
- https://docs.rs/mpv/0.2.3/mpv/
- https://www.cuvee.io/licences
- https://www.icecommander.com/licenses
- https://www.mail-archive.com/debian-wnpp@lists.debian.org/msg283981.html
- https://web.mswott.net/p?url=http%3A%2F%2Fgithub.com%2Fhockyy%2Fmiteiru&__src=http%3A%2F%2Fgithub.com%2Ftopics%2Fmecab&__type=xmlhttprequest
- https://github.com/yeautyye/ez-ffmpeg/blob/HEAD/docs/INSTALL.md
- https://deepwiki.com/kcking/rust-ffmpeg-next/9.1-feature-flags-reference
- https://deepwiki.com/kcking/rust-ffmpeg-next/1.1-getting-started
- https://deepwiki.com/zmwangx/rust-ffmpeg/8.1-building-from-source
- https://github.com/project-maho/mahord/blob/HEAD/clients/rust/packaging/nsis/README-FFMPEG.md
- https://github.com/simplearyan/studio-pro/blob/HEAD/docs/video/Cross-Platform-Tauri-MediaBunny-Plan.md
- https://aetherengine.superuser404.de/reference/formats/
- https://newreleases.io/project/github/FFmpeg-Builds/FFmpeg-Builds/release/latest
- https://en.pyvideotrans.com/blog/windows-ffmpeg-install-path
- https://archlinux.org/packages/extra/x86_64/ffmpeg/
- https://docs.rs/crate/windows-composition/latest/source/Cargo.toml
