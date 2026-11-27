# Taomni taoffice 视频插件选型调研：WebCodecs + Mediabunny vs ffmpeg.wasm

调研日期：2026-11-15（北京时间）｜调研方式：browser.search / browser.open 实际查证，未查到的写“未核实”
约束背景：Tauri 2 + React 19 + Rust，系统 webview（非打包 Chromium）；第三方能力须用 Rust/TS 库编译进应用，不接受 sidecar；单插件包 ≤100 MB；许可证须能进 MIT 项目分发；先播放（mp4/webm/mov/mkv/avi/rm 等），再编辑/转码；音频并入同一插件。

> 本报告只给事实与每条路线的优缺点小结，不做最终 verdict。

---

## A) WebCodecs + Mediabunny

### A1. Mediabunny 是什么、作者、许可证、版本、下载量、Stars、维护状态

- **是什么**：纯 TypeScript 编写的浏览器内媒体工具库，用于直接在浏览器中读取、写入和转换媒体文件（MP4、WebM、MP3、HLS 等），自述“像 FFmpeg，但为 web 而建”。零依赖、高度可 tree-shaking。来源：https://mediabunny.dev/guide/introduction
- **前身**：作者此前两个库 `mp4-muxer` 与 `webm-muxer` 的统一演进；官方引言明确写“Mediabunny is the evolution of my previous libraries, mp4-muxer and webm-muxer”。来源：https://mediabunny.dev/guide/introduction
- **作者**：Vanilagy（GitHub 组织/账号 `Vanilagy/mediabunny`）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；另见 GitHub 星标页多处显示 `Vanilagy / mediabunny`（如 https://github.com/shaneosullivan?tab=stars&type=sponsorable）
- **许可证：MPL-2.0**。官方 README / 官网均写“released under the MPL-2.0 … free to use for any purpose, including closed-source commercial use”。来源：https://mediabunny.dev/guide/introduction ；https://npm.io/package/mediabunny
- **MPL-2.0 对 MIT 项目的含义**：MPL-2.0 是文件级弱 copyleft（file-level copyleft），不是项目级 GPL：修改过的 MPL 文件须继续以 MPL-2.0 分发源码；新写的文件可用任意许可证；整个 Larger Work 可用自选条款（含 MIT/闭源）分发，只要对 Covered Software 履行 MPL 义务。来源：https://licensing.wyattau.com/osi-licenses/ ；https://deepwiki.com/opendataloader-project/opendataloader-bench/8.3-license-compatibility 。**注意：这不是法律意见；分发前仍建议法务/合规复核。**
- **当前版本：1.66.0，最近发布 2026-11-13**。npm.io 首次检索时显示 `1.66.0 • Published 22h ago`；GitHits 显示 `v1.66.0 Nov 13, 2026, MPL-2.0`。来源：https://npm.io/package/mediabunny ；https://index.githits.dev/packages/npm/mediabunny/
- **维护状态：活跃**。Snyk 称“positive version release cadence with at least one new version released in the past 3 months”，最后更新约 20 小时前；1.62.0（2026-10-20）修复了解析器恶意输入挂起与内存/CPU 滥用问题。来源：https://security.snyk.io/package/npm/mediabunny ；https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **GitHub Stars：约 7.3k**（2026-10-20/22 快照：7,358 / 7,361；2026-11-15 当日精确数未核实）。来源：https://github.com/shaneosullivan?tab=stars&type=sponsorable
- **npm 下载量：各聚合口径严重不一致，未核实统一数字**——Snyk 称每周 1,792,967 次下载（https://security.snyk.io/package/npm/mediabunny）；GitHits 称每月 24.9M 次（https://index.githits.dev/packages/npm/mediabunny/）；另一聚合站 npminsights 的旧快照（218 天前抓取）显示量级远低。**不要直接引用其中任一数字作为官方口径；如需准确数，应以 npm 官方 registry 下载 API 为准，本次未拉取该 API。**

### A2. 能做什么：容器、编码、转码/复用

- **容器（官方“Supported formats & codecs”页，双向读+写）**：ISOBMFF（.mp4/.m4v/.m4a…）、QuickTime（.mov）、分段 MP4 CMAF（.m4s）、Matroska（.mkv）、WebM（.webm）、Ogg（.ogg）、MP3（.mp3）、WAVE（.wav）、ADTS（.aac）、FLAC（.flac）、MPEG-TS（.ts）、HLS（.m3u8）。来源：https://mediabunny.dev/guide/supported-formats-and-codecs
- **视频编码（核心列表）**：`avc` H.264、`hevc` H.265、`vp8`、`vp9`、`av1`、`prores`（Apple ProRes，脚注 1，须扩展包/自定义解码器，见下）。来源：https://mediabunny.dev/guide/supported-formats-and-codecs
- **音频编码**：`aac`、`opus`、`mp3`、`vorbis`、`flac`、`ac3`、`eac3`、`dts`、`truehd`，以及全套 PCM（`pcm-u8/s8/s16/s24/s32/f32/f64` 及大端变体、`ulaw`、`alaw`）；PCM 编解码器内置、始终可用。字幕：`webvtt`（写为主）。来源：https://mediabunny.dev/guide/supported-formats-and-codecs
- **功能**：读元数据、抽取媒体数据、创建新文件、转换文件、硬件加速编解码（经 WebCodecs）、多音视频/字幕轨、懒加载/按需读取、输入输出流式、任意文件大小、压缩/缩放/旋转/裁剪/重采样/裁剪时间、元数据标签读写、transmuxing 与 transcoding、微秒级精度、高效 seek、流水线+背压。来源：https://mediabunny.dev/guide/introduction
- **转换 API**：`Conversion` 抽象，支持 transmuxing、transcoding、缩放、旋转、裁剪、重采样、裁剪时间等；内部用 Canvas 做视频处理、用自定义实现做音频重采样/混音。来源：https://mediabunny.dev/guide/introduction ；https://npm.io/package/mediabunny
- **编解码可用性不由库保证**：官方原话——WebCodecs 提供的编解码器“availability … depends on the browser and thus cannot be guaranteed by this library”；提供 `canEncode` / `canDecode` / `getFirstEncodableVideoCodec` 等探测函数，也支持注册自定义编解码器来 polyfill。来源：https://mediabunny.dev/guide/supported-formats-and-codecs ；https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **扩展包（WASM，弥补 WebCodecs 缺口）**：ProRes 解码器（`@mediabunny/prores`）、AC-3/E-AC-3 与 DTS 编解码（`@mediabunny/ac3` 等）、AAC 编码器（`@mediabunny/aac-encoder`，基于 libavcodec 的 WASM）、MP3 编码器（`@mediabunny/mp3-encoder`，基于 LAME）、FLAC 编码器（基于 libFLAC）。Voyager 实测：注册这些扩展后 ProRes/AC-3 任务在各浏览器均成功；但**没有官方 HEVC 扩展**，无 HEVC 解码器的浏览器上的 HEVC 文件须走其他路线。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；https://index.githits.dev/packages/npm/@mediabunny/aac-encoder/ ；https://index.githits.dev/packages/npm/@mediabunny/mp3-encoder/
- **扩展包许可证注意**：各扩展包 npm 页标注 MPL-2.0，但其底层分别是 FFmpeg libavcodec / LAME / libFLAC 的 WASM 构建；其中 MP3 编码器被第三方许可证页注明“embeds a WebAssembly build of LAME 3.100, … licensed under the LGPL”。如要用扩展包，须逐包核对底层许可证，不能只看 MPL-2.0 标注。来源：https://www.filesnug.online/licenses/

### A3. AVI / FLV / WMV / RM 是否支持——明确回答：核心库不支持

- **容器层面不支持**：官方支持容器列表（A2）中**没有 AVI、FLV、WMV/ASF、RM/RMVB**。来源：https://mediabunny.dev/guide/supported-formats-and-codecs
- **编码层面不支持**：官方视频编码列表只有 avc/hevc/vp8/vp9/av1/prores，**没有 DivX/Xvid、WMV/VC-1、RealVideo、Sorenson 等**；音频列表也没有 RealAudio（Cook）/WMA。来源：https://mediabunny.dev/guide/supported-formats-and-codecs
- **第三方“能播 AVI/WMV/FLV/RM”的产品不是纯 Mediabunny**：例如 useotools 的转换器页面写明现代格式（MP4/MOV/MKV/WebM/TS/3GP）由 Mediabunny 处理，而“Older files … AVI, WMV, FLV, MPG and VOB, 3GP and RealMedia are decoded by FFmpeg's libraries running inside the page”，RM/RMVB 明确是“decodes RealVideo with ffmpeg's libraries compiled to WebAssembly”。即 AVI/FLV/WMV/RM 能力来自**另外叠加的 FFmpeg WASM 解码**，不是 Mediabunny 核心。来源：https://useotools.com/video-converter ；https://useotools.com/rmvb-to-mp4
- **对 taoffice 需求的直接结论（事实层面）**：若只用 Mediabunny 核心，`mp4/webm/mov/mkv` 四类可覆盖，`avi/rm`（及 flv/wmv）**不能**直接打开，须另有解码兜底。

### A4. WebCodecs 本身的浏览器/webview 支持

通用基线（第三方综述，非 MDN 官方页直接引用）：
- Chrome 94+、Edge 94+、Opera 80+、Firefox 130+（桌面）、Samsung Internet 17+ 全量支持；Safari 26.0+ 全量，Safari 16.4–18.7 仅视频接口（VideoDecoder/VideoEncoder/VideoFrame/EncodedVideoChunk，无 AudioDecoder/AudioEncoder/ImageDecoder）。来源：https://www.testmuai.com/learning-hub/webcodecs-browser-support/
- WebCodecs 只在安全上下文（HTTPS 或 localhost）暴露；须逐接口探测，不能只测 `VideoDecoder` 就认定音频可用。来源：https://www.testmuai.com/learning-hub/webcodecs-browser-support/

#### Windows — WebView2（Chromium）：✅ 全量支持
- Tauri Windows 用 Edge WebView2（Chromium），WebCodecs 全量支持，硬件加速编码可用（NVENC / Intel QuickSync / AMF，经 Chromium）。来源：https://github.com/simplearyan/studio-pro/blob/HEAD/docs/video/Cross-Platform-Tauri-MediaBunny-Plan.md
- Betaflight 的 Tauri 矩阵同样把 Tauri Windows 列为 Full。来源：https://github.com/betaflight/betaflight-configurator/issues/5396

#### macOS — WKWebView（WebKit）：✅ 有条件支持，取决于系统 Safari 版本
- WKWebView 的 WebCodecs 跟随系统 Safari：Safari 16.4+（macOS Ventura+）有视频接口；16.4–18.7 无音频接口；26.0+ 才全量。来源：https://www.testmuai.com/learning-hub/webcodecs-browser-support/ ；https://github.com/simplearyan/studio-pro/blob/HEAD/docs/video/Cross-Platform-Tauri-MediaBunny-Plan.md
- 编码侧 WKWebView 只有 H.264/MP4 一路可靠（Safari 的 MediaRecorder/WebCodecs 组合限制），WebM/VP8/VP9 输出不可用。来源：https://github.com/betaflight/betaflight-configurator/issues/5396

#### Linux — WebKitGTK：⚠️ 最关键的不确定点，分版本、分发行版

查到的时间线（多源交叉，但存在表述差异，见下）：

1. **视频编解码 2.42 起**：GStreamer Conference 2023 演讲（WebKit 开发者 Philippe Normand）写明“(H.264, H.265, AV1, VP8, VP9) video encoding/decoding: shipping in 2.42”；音频“(AAC, mp3, opus, vorbis, fLaC, alaw, ulaw, LPCM) audio encoding/decoding: landed in main, will ship in 2.44”。来源：https://indico.freedesktop.org/event/5/contributions/170/attachments/107/165/WebCodecs%20in%20WebKit%2C%20with%20GStreamer%21.pdf
2. **2.44 才正式启用**：WebKit 开发者博客写“Since version 2.44, WebKitGTK and WPEWebKit ship with a WebCodecs backend”；WebKit GLib 稳定分支页 2.44 条目列有 `https://commits.webkit.org/274475@main - [GLib] Enable WebCodecs`。来源：https://base-art.net/Articles/from-webkitgstreamer-to-rust-av-a-journey-on-our-stacks-layers/ ；https://github.com/WebKit/WebKit/wiki/GLib-Stable-Branches
3. **是否默认开启 / 是否依赖发行版构建，未核实到官方定论**：Betaflight issue 的对抗评审明确把“WebKitGTK 2.42+ ✅”降级为 **UNKNOWN — must be measured**，理由是“WebCodecs in WebKitGTK is GStreamer-backed and has been behind build/feature flags; whether it is on depends on the *distro's* webkit2gtk build”，且无软件兜底——缺 GStreamer 插件（`gst-plugins-bad` / `openh264` / VA-API）时 `isConfigSupported()` 直接返回 false。来源：https://github.com/betaflight/betaflight-configurator/issues/5396
4. 另一份 Tauri + MediaBunny 规划文档同样定性 Linux WebKitGTK 为“Lagging / often disabled or partial”、“Unreliable — needs a WASM coder or ffmpeg sidecar fallback”。来源：https://github.com/simplearyan/studio-pro/blob/HEAD/docs/video/Cross-Platform-Tauri-MediaBunny-Plan.md
5. 还有实测向证据：Melt 项目记录在 WebKitGTK 2.54.1 上 H.264 WebCodecs 探测与 DMA-BUF 渲染器有关，禁用渲染器会导致探测 abort web process。来源：https://github.com/polimero-app/melt

**综合表述（供选型参考）**：名义上视频 2.42、完整后端 2.44 起，但 Tauri Linux 的实际可用性取决于用户机器上的 WebKitGTK 版本**和**发行版构建选项/GStreamer 插件是否齐全，不能像 Windows/macOS 那样默认可用；须在真实 Tauri 打包产物 + 目标发行版上实测 `VideoEncoder`/`VideoDecoder` 探测与实际编解码。**“是否默认开启”这一问，未找到 WebKitGTK 官方文档的明确一句话，本项记为未核实。**

### A5. 集成方式、体积、渲染路径

- **集成方式：纯 TS/JS，无 Rust、无 sidecar、无 WASM（核心库）**。官方：“implemented from scratch in pure TypeScript with zero dependencies”；核心是每种容器的 muxer/demuxer + WebCodecs 封装。来源：https://mediabunny.dev/guide/introduction ；https://npm.io/package/mediabunny
- **体积**：
  - 官方主页旧口径（2025-06，Ryzen 7600X + RTX 4070 机器上的宣传数）：读全部格式 30 kB、全部功能 69.6 kB；另有第三方文章称 tree-shaken 后约 5 kB（仅取 MP4/WebM muxer 的极小子集时）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；https://www.xugj520.cn/en/archives/browser-media-toolkit-mp4-webm.html
  - **独立实测（Voyager，2026-10-20，v1.61.6，esbuild）**：仅转换所需导入 560 kB minified / **143 kB gzip**；仅读取全部格式 85 kB gzip、仅 MP4 40 kB gzip；全部导入 181 kB gzip；扩展包按需加载（AAC 编码器 254 kB gzip、AC-3 297 kB、ProRes 50 kB）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
  - **结论**：无论取哪一口径，核心库体积都远低于 100 MB 插件包上限；“5 kB”只适用于极小子集，不能作为整插件预算。
- **解码后渲染（播放）**：
  - 底层通用路径：`VideoDecoder → VideoFrame → canvas`（`ctx.drawImage(frame, …)`；VideoFrame 也是 WebGL `texImage2D` 与 WebGPU `importExternalTexture` 的源）。来源：https://www.zachsimms.com/typescript/web-apis/webcodecs/
  - Mediabunny 高层封装：`CanvasSink`（内部拥有 VideoDecoder，产出可直接 `drawImage` 的 `WrappedCanvas`，带 canvas 池与关键帧/GOP 管理）；`VideoSampleSink`（供 WebGL/WebGPU 取原始帧）；音频用 `AudioBufferSink` 解码后经 Web Audio API 调度。来源：https://github.com/bevyl-ai/rerender/blob/HEAD/docs/remotion-media-spec.md ；https://deepwiki.com/Vanilagy/mediabunny/9.5-example-applications
  - **Mediabunny 没有内置 `<video>` 播放器**：官方 advanced media-player 示例是从零自建播放器，不用 `<video>`/`<audio>` 元素，以 `AudioContext.currentTime` 为音视频主时钟、`requestAnimationFrame` 推进视频帧。来源：https://deepwiki.com/Vanilagy/mediabunny/9.5-example-applications ；https://github.com/proj-airi/recorder-minecraft/blob/HEAD/docs/research/dashboard-resource-browser-media-preview.md
  - 实际含义：播放器 UI、seek/音画同步、倍速等须自研（或基于示例改），不能像 `<video src>` 那样零成本获得；但这也带来帧精确 seek/缩略图等编辑器友好能力。
- **与 Tauri 的结合点**：前端 npm 引入即可；本地文件须经 Tauri 读文件 → 传给 `BlobSource`/`Input`（或 `UrlSource`）；保存走 Tauri 文件写出而非浏览器下载锚点（Betaflight issue 提醒：仅探测编码器不够，还须验证保存路径，WKWebView/WebKitGTK 下 `downloadViaAnchor` 可能无 handler）。来源：https://github.com/betaflight/betaflight-configurator/issues/5396

### A6. 局限：是否只能解浏览器原生支持的编码

- **是，核心如此**。官方：编解码器可用性取决于浏览器、库无法保证；Voyager 实测：在 Chromium/Firefox 测试构建中无 HEVC 解码器时，HEVC 电话视频会被静默转成无视频 MP4（`conversion.isValid` 仍为 true，丢弃轨道只列在 `discardedTracks` 中，原因 `undecodable_source_codec`）；Firefox 构建无 AAC 编码器时，须重编码音频的转码会产出无声视频。来源：https://mediabunny.dev/guide/supported-formats-and-codecs ；https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **可部分弥补**：注册 WASM 扩展包（ProRes、AC-3/DTS、AAC/MP3/FLAC 编码器）或自定义编解码器；但无官方 HEVC 扩展，HEVC 缺口无法用官方扩展补。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **冷门编码**：DivX/Xvid、WMV/VC-1、RealVideo/RealAudio、MPEG-2、Sorenson 等均不在 WebCodecs/Mediabunny 编码表内，核心路线无法解。来源：https://mediabunny.dev/guide/supported-formats-and-codecs
- **输出一致性**：同一转码任务在不同浏览器产出字节不同；ffmpeg.wasm 则跨浏览器哈希一致。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm

### A 路线优缺点小结（事实层面）

优点：
- 纯 TS、零依赖、无 sidecar，符合“Rust/TS 库编译进应用”硬约束；体积 40–181 kB gzip 量级，远低于 100 MB 上限。
- 硬件加速编解码（有 WebCodecs 时），实测转码比 ffmpeg.wasm 单线程快约 10 倍（Chrome，Voyager：0.89 s vs 9.20 s，10 s 1080p→720p）。
- MPL-2.0，文件级弱 copyleft，可进 MIT/闭源 Larger Work（须履行 MPL 文件义务）。
- 活跃维护（1.66.0，2026-11-13），容器覆盖 mp4/mov/mkv/webm/ts/HLS 等主流格式，API 类型化，带探测与自定义编解码器扩展点。

缺点：
- 编解码能力完全受制于所在 webview：Linux WebKitGTK 是最大不确定点（版本+发行版构建+GStreamer 插件三重依赖）；macOS 16.4–18.7 无音频 WebCodecs。
- 核心不支持 AVI/FLV/WMV/RM 容器与 DivX/Xvid/WMV/RealVideo 等编码；HEVC 无官方 WASM 兜底；无 HEVC/AAC 能力的浏览器上会静默丢轨道（须自查 `discardedTracks`）。
- 无内置播放器，播放器/音画同步须自研；输出字节跨浏览器不一致。

---

## B) ffmpeg.wasm

### B1. 当前版本、最近发布、维护状态、Stars、下载量

- **是什么**：FFmpeg 用 Emscripten 编译成的纯 WebAssembly/JavaScript 移植版，在浏览器内录制、转换与流式处理音视频；把文件写入内存虚拟文件系统（MEMFS），在 Web Worker 里用 `exec()` 跑 FFmpeg 命令行参数，再读回结果。来源：https://github.com/ffmpegwasm/ffmpeg.wasm ；https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **包结构（两件套，易混淆）**：`@ffmpeg/ffmpeg` 是 JS 包装器（wrapper）；`@ffmpeg/core` / `@ffmpeg/core-mt` 是 WASM 核心。来源：https://github.com/ffmpegwasm/ffmpeg.wasm
- **当前版本：wrapper `@ffmpeg/ffmpeg` 0.12.15；core / core-mt 0.12.10；core 基于 FFmpeg 5.1.4**。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；https://socket.dev/npm/package/@ffmpeg/ffmpeg/overview/0.12.15
- **最近发布：2025-01**（0.12.15 / core 0.12.10 发布于 2025 年 1 月；Socket 标注“Package last updated on 07 Jan 2025”）。Voyager（2026-10-20 核查）称“last release was in January 2025 and the last commit to main in September 2025”。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；https://socket.dev/npm/package/@ffmpeg/ffmpeg/overview/0.12.15
- **维护状态：低活跃/接近停滞**。自 2025-01 后无新 release；主分支最后提交 2025-09；FFmpeg 本体停留在 5.1.4（2022 年分支），而同期原生 FFmpeg 已到 9.x（Voyager 测试用 FFmpeg 9.0.2 制作用例）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **GitHub Stars：约 17.9k**（`ffmpegwasm/ffmpeg.wasm`，GitHub 页快照 17,934；另有 17,898/17,918 等相近快照）。来源：https://github.com/ffmpegwasm/ffmpeg.wasm
- **npm 下载量：口径不一致，未核实统一数字**——PkgPulse 称约 300k/周（https://www.pkgpulse.com/guides/fluent-ffmpeg-vs-ffmpeg-wasm-vs-node-video-lib-video-2026）；另一文章称 153k/周、16.6k stars（https://copyprogramming.com/howto/javascript-ffmpeg-npm-to-create-video-npm ——该文 stars 数已过时，仅作口径对照）；Socket 页的 Weekly downloads 字段显示为 0（疑似该聚合数据缺失）。**以 npm 官方 registry 为准，本次未拉取。**

### B2. 许可证——关键风险点

- **分开看**：wrapper `@ffmpeg/ffmpeg` 是 **MIT**；core `@ffmpeg/core` 是 **GPL-2.0-or-later**（因为构建时启用了 x264 与 x265，即 `--enable-gpl`）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；https://ryusei.io/en/article/browser-video-webcodecs
- **官方 FAQ 原话**：core 是从 FFmpeg C 代码转译的 WASM，“still following the same licenses as FFmpeg and its external libraries”；wrapper 是 MIT 小代码库。来源：https://github.com/ffmpegwasm/ffmpeg.wasm （README FAQ，见该页搜索结果引文）
- **对 MIT 项目分发的影响（事实陈述，非法律意见）**：
  - 把 npm 发布的 GPL core 原样分发进 Taomni 插件并交付给用户设备，即构成 GPL 代码的分发，须履行 GPL 义务（提供对应源码等），与“MIT 项目”期望的宽松分发冲突；Ryusei 的文章明确写“Running ffmpeg on the server carries no GPL distribution obligation; serving wasm to the browser does”。来源：https://ryusei.io/en/article/browser-video-webcodecs
  - **可行的减负路径（有代价）**：自行构建不含 x264/x265、不启用 `--enable-gpl` 的 core，可避开 GPL 部分（Voyager 注明），但该 core 只能做探测/音频等有限任务，“is a different tool, not a smaller copy”；且自建 core 须自行维护 Emscripten/FFmpeg 构建链。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **另注意**：FFmpeg 本体默认 LGPL-2.1+，但一旦启用 `--enable-gpl` + libx264 即整体变 GPL——这是上游 FFmpeg 的许可规则，不是 ffmpeg.wasm 独有。来源：https://ryusei.io/en/article/browser-video-webcodecs

### B3. 体积、线程（SharedArrayBuffer / COOP-COEP）、Tauri webview 可行性

- **体积**：
  - 单线程 core `ffmpeg-core.wasm`：32,232,419 字节（约 31 MB 未压缩），**10.2 MB gzip / 7.3 MB Brotli**（Voyager 实测，unpkg）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
  - 多线程 core-mt 约 31–32 MB（未压缩）；另有文章称 MT 构建传输约 30 MB gzip、内存中展开约 80 MB。来源：https://tarkarn.com/blog/ffmpeg-wasm-browser-guide ；https://www.clearrec.app/blog/ffmpeg-wasm-complete-guide-2026
  - **对照 100 MB 插件包上限**：单 core 本身（31 MB 未压缩）名义上能塞进 100 MB，但加上 wrapper、JS 胶水与插件其余部分后余量收窄；若同时打包单线程+多线程两个 core，或再叠加其他 WASM，则须实算。加载时另有解析/JIT 成本，实测本机加载初始化 42–128 ms，真实网络下下载占主导。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **线程与 COOP/COEP**：
  - 多线程 core（`@ffmpeg/core-mt`）依赖 WASM pthreads + `SharedArrayBuffer`；`SharedArrayBuffer` 须跨域隔离，即页面须带 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`（或 `credentialless`）响应头，否则 `window.crossOriginIsolated === false`，多线程构建拒绝初始化，只能回落单线程。来源：https://bytefork.tools/blog/ffmpeg-wasm-browser-video-2026/ ；https://github.com/josiahsiegel/claude-plugin-marketplace/blob/HEAD/plugins/ffmpeg-platforms/skills/ffmpeg-webassembly-workers/SKILL.md
  - COEP `require-corp` 的副作用：所有跨域子资源（图片、字体、第三方脚本）须显式 CORP/CORS 许可，否则被挡。来源：https://bytefork.tools/blog/ffmpeg-wasm-browser-video-2026/
  - 官方 FAQ 称多线程版“unstable”、“might not work for many cases”。来源：https://renderio.dev/blogs/ffmpeg-wasm-guide
- **在 Tauri 系统 webview 里是否可行——证据冲突，须实测**：
  - **有利证据**：FastLED issue 称 Tauri 三端 SAB + pthreads 支持为 WebView2 ✅、WKWebView ✅（Safari 15.2+）、WebKitGTK ✅（2.36+），并称“Cross-origin isolation (COOP/COEP) is already in place in the Tauri webview”。来源：https://github.com/fastled/fastled/issues/2452
  - **不利证据**：Web Playground 的 Tauri v2 实测记录称 Tauri 用 `tauri://` 自定义 scheme 承载内容，而“WebKitGTK does not enable cross-origin isolation on custom schemes, leading to `SharedArrayBuffer`-dependent probes correctly reporting as unsupported”；且 Tauri 的 HeaderConfig 有固定 allowlist，COOP/COEP/CORP 头须在 `tauri.conf.json` 中重声明。来源：https://deepwiki.com/uist1idrju3i/web-playground/9.4-native-desktop-shells-(electron-tauri-wails)
  - 另一 Tauri 项目（Formula）的提交记录同样提醒：打包后的 Tauri 用 asset/custom protocol，若不发出这些头，`crossOriginIsolated` 为 false，Pyodide/SharedArrayBuffer 依赖方会回落或失败；且 COEP 下 `asset:` 子资源非同源，须补 CORP。来源：https://github.com/wilson-anysphere/formula/commit/25179721978fa368333214f6ad42403ee2b816d9
  - **综合**：Tauri 侧 COOP/COEP *可以配置*（`tauri.conf.json` 的 security headers / 自定义协议头），但能否在三端 webview（尤其 Linux WebKitGTK 的自定义 scheme）上真正拿到 `crossOriginIsolated === true`，**查到的证据互相矛盾，未核实**。单线程 core 不需要 COOP/COEP，可作为保底，但性能见 B4。
  - 另有通用约束：WASM 须以 `application/wasm` MIME 提供；Tauri asset 协议按扩展名给 MIME，一般满足。来源：https://github.com/omiq/rgc-basic/blob/HEAD/docs/tauri-desktop-launcher-spec.md

### B4. 性能：比原生慢多少（可查到的数据）

不同来源、不同任务，数字不同，须按条件引用，不可只取一个数：

| 来源 / 条件 | 结果 |
|---|---|
| ffmpeg.wasm 官方 benchmark（1 MB WebM→MP4，8 核 i5，Chrome 116，v0.12.3，第三方研究复述） | 原生 5.2 s；单线程 WASM 128.8 s（**约 25×**）；多线程 core-mt 60.4 s（**约 11.6×**）。官方文档原话“won't perform as good as FFmpeg as it is not fully optimized”。来源：https://github.com/ankit4479/audio-converter/blob/HEAD/docs/browser-offline-compute-research.md |
| Voyager 实测（2026-10-20，M5 Max，10 s 1080p→720p H.264，`libx264 veryfast`） | Mediabunny 0.89 s；ffmpeg.wasm 单线程 9.20 s（约 10×）；多线程 2.32 s（约 2.6×于 Mediabunny，仍慢于原生硬件路径）；WebKit 测试构建中多线程 ffmpeg.wasm 反而快于 Mediabunny（2.33 s vs 3.96 s）。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm |
| Ryusei 实测（20 s 720p H.264+AAC，8.2 MB） | ffmpeg.wasm 单线程 `veryfast` 20.1 s vs WebCodecs 0.82 s；`medium` 预设 10 分钟后放弃。来源：https://ryusei.io/en/article/browser-video-webcodecs |
| Zro7 实测（Chrome，0.12.10 单线程） | HD 视频需 300–700 MB 堆内存，**比原生慢 4–10×**；多线程后某任务 34 s→12 s（M3 Max）。来源：https://www.zro7.com/blog/ffmpeg-wasm-cpu-ram-benchmark/ |
| Bytefork / Render.io 等综述 | 约 3–10×、5–15×、10–50×（按编码器而异，AV1 最差）；共识是无硬件加速（NVENC/VideoToolbox/QuickSync 均不可用）、纯 CPU、WASM SIMD 不及原生手写 SIMD。来源：https://bytefork.tools/blog/ffmpeg-wasm-browser-video-2026/ ；https://renderio.dev/blogs/ffmpeg-wasm-guide |

- **慢的原因（多源一致）**：WASM 无 GPU 硬件编码、不能用原生手写 x86 SIMD、JS/WASM 边界开销、多线程 Worker 调度开销。来源：https://bytefork.tools/blog/ffmpeg-wasm-browser-video-2026/ ；https://renderio.dev/blogs/ffmpeg-wasm-guide

### B5. 为什么不适合做主路径、适合做什么

**不适合做主路径的理由（事实汇总）**：
1. **体积**：core 约 31 MB 未压缩（10.2 MB gzip），是 Mediabunny 转换构建（143 kB gzip）的约 70 倍；插件包预算 100 MB 下余量紧张。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
2. **性能**：转码普遍比原生慢一个数量级（见 B4），长视频/4K/HEVC/VP9/AV1 下等待时间以分钟计；官方 FAQ 也承认多线程版不稳定。来源：https://renderio.dev/blogs/ffmpeg-wasm-guide ；https://bytefork.tools/blog/ffmpeg-wasm-browser-video-2026/
3. **线程**：多线程依赖 SharedArrayBuffer + COOP/COEP，在 Tauri 自定义 scheme（尤其 Linux WebKitGTK）上能否拿到跨域隔离，证据冲突、未核实；拿不到则回落单线程、再慢数倍。来源：https://deepwiki.com/uist1idrju3i/web-playground/9.4-native-desktop-shells-(electron-tauri-wails) ；https://github.com/fastled/fastled/issues/2452
4. **内存/文件上限**：默认 MEMFS 须把整个输入+输出文件放进 WASM 线性内存；WASM 32 位堆实际约 2 GB 上限，超大文件 `writeFile` 即失败，1.5 GB 文件编码中也可能 OOM；实测 HD 任务堆内存 300–700 MB。WORKERFS 可挂载 File 对象免全量拷贝、但强制单线程；OPFS/WASMFS 须自建 core。来源：https://renderio.dev/blogs/ffmpeg-wasm-guide ；https://www.zro7.com/blog/ffmpeg-wasm-cpu-ram-benchmark/ ；https://dev.to/doublecitizen/ffmpegwasm-in-production-deadlocks-a-2-gb-ceiling-and-a-codec-that-lies-to-users-1lj8
5. **许可证**：发布的 core 是 GPL-2.0-or-later（x264/x265），分发进 MIT 项目有 GPL 合规负担；自建 LGPL core 可减负但功能与维护成本另计。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm ；https://ryusei.io/en/article/browser-video-webcodecs
6. **维护**：自 2025-01 无新 release，core 停留在 FFmpeg 5.1.4。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm

**适合做什么（多源共识）**：
- **偶尔转码/冷门格式兜底**：当输入是浏览器/WebCodecs 不能处理的容器/编码（AVI、FLV、WMV、RM/RMVB、MPEG-2、RealVideo 等）或需要 FFmpeg 滤镜、需要跨浏览器完全一致的输出时，用 ffmpeg.wasm 兜底；Voyager 的建议是“Mediabunny first, ffmpeg.wasm loaded only for the files it rejects”，且懒加载 core。来源：https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- **小文件、轻操作**：50 MB 以下的简单操作（音频转换、裁剪、缩略图提取）性能可接受；大文件/批量/长视频不适合。来源：https://renderio.dev/blogs/ffmpeg-wasm-guide

### B6. 在 Tauri 系统 webview 里跑 ffmpeg.wasm 的已知障碍（汇总）

- COOP/COEP 头须在 Tauri 配置中显式声明，且自定义 scheme 下跨域隔离在 WebKitGTK 上可能不生效（见 B3 冲突证据）。来源：https://deepwiki.com/uist1idrju3i/web-playground/9.4-native-desktop-shells-(electron-tauri-wails) ；https://github.com/wilson-anysphere/formula/commit/25179721978fa368333214f6ad42403ee2b816d9
- COEP `require-corp` 会挡住非同源子资源，Tauri 生产应用常从 `asset:` 加载图片/字体，须补 CORP 或改同源。来源：https://github.com/wilson-anysphere/formula/commit/25179721978fa368333214f6ad42403ee2b816d9
- Web Worker 须与宿主页面同源；从 CDN 加载 core 的做法在跨域隔离下受限，须自托管 core 并用 `toBlobURL` 等方式加载。来源：https://tarkarn.com/blog/ffmpeg-wasm-browser-guide
- 2 GB 内存上限与 MEMFS 全量载入（见 B5-4）。来源：https://renderio.dev/blogs/ffmpeg-wasm-guide
- **未找到** Tauri 官方文档中针对 ffmpeg.wasm 的专门说明；上述障碍均来自第三方项目实测/记录，须在目标三端打包产物上验证。本项记为“无官方定论，第三方证据如上”。

### B 路线优缺点小结（事实层面）

优点：
- 编解码自带、不依赖浏览器/webview：容器与编码覆盖最广（AVI/FLV/WMV/RM 及冷门编码均可解），是唯一能不依赖系统解码器覆盖 taoffice 全部目标格式的浏览器内路线。
- 输出跨浏览器一致（同一 core+命令哈希一致）；FFmpeg 命令行/滤镜生态完整；API 是成熟的 FFmpeg 语义。
- Stars 约 17.9k、生态文章与示例多；单线程 core 不需要 COOP/COEP 即可跑。

缺点：
- 发布的 core 是 GPL-2.0-or-later，进 MIT 项目分发有合规负担；自建 LGPL core 须自维构建链且功能缩水。
- 体积大（core 约 31 MB 未压缩，10.2 MB gzip），占 100 MB 插件预算近三分之一。
- 慢：实测转码比原生慢约 4–25 倍（按任务与线程配置而异），无硬件加速；多线程须 SharedArrayBuffer+COOP/COEP，在 Tauri（尤其 Linux WebKitGTK 自定义 scheme）上能否生效证据冲突、未核实。
- 内存：MEMFS 全量载入，WASM 堆约 2 GB 上限，大文件易 OOM；维护停滞（2025-01 后无 release，FFmpeg 5.1.4）。

---

## 对照总表（事实摘要）

| 维度 | WebCodecs + Mediabunny | ffmpeg.wasm |
|---|---|---|
| 形态 | 纯 TS、零依赖、无 WASM（核心）、无 Rust、无 sidecar | FFmpeg 5.1.4 的 Emscripten/WASM 移植 + JS wrapper，Web Worker 内跑 |
| 最新版 | Mediabunny 1.66.0（2026-11-13） | wrapper 0.12.15 / core 0.12.10（2025-01） |
| Stars | 约 7.3k（2026-10 快照） | 约 17.9k |
| 许可证 | MPL-2.0（文件级弱 copyleft，可进 MIT Larger Work） | wrapper MIT / **core GPL-2.0-or-later**（x264/x265） |
| 体积 | 转换构建 143 kB gzip（v1.61.6 实测）；读仅 40–85 kB | core 32,232,419 B，10.2 MB gzip / 7.3 MB Brotli |
| 容器 | mp4/mov/mkv/webm/ogg/mp3/wav/aac/flac/ts/HLS；**无 avi/flv/wmv/rm** | 几乎全（avi/flv/wmv/rm 等均可） |
| 编码 | avc/hevc/vp8/vp9/av1/prores；取决于浏览器，HEVC 无官方扩展 | 自带软件编解码（libx264/x265/vpx/LAME/Opus 等），不依赖浏览器 |
| 速度 | 硬件加速时快（Chrome 10 s 1080p→720p 约 0.89 s） | 单线程约 9.2 s 同任务；官方 bench 约 25×慢于原生 |
| 线程 | 不需要 COOP/COEP | 多线程须 SAB + COOP/COEP；Tauri 下能否生效证据冲突 |
| 内存 | 流式、任意文件大小（官方称） | MEMFS 全量载入，约 2 GB 堆上限 |
| 播放 | 须自研播放器（CanvasSink + Web Audio，AudioContext 为时钟） | 本身不是播放器；解码后仍须渲染/播放路径 |
| 最大风险 | **Linux WebKitGTK 的 WebCodecs 可用性**（版本+发行版+GStreamer 三重依赖，未实测） | **GPL core 分发 + 体积/性能/线程三重成本 + 维护停滞** |

---

## 未核实 / 须实测的事项

1. Mediabunny 与 @ffmpeg/ffmpeg 各自的 npm 官方周下载量（聚合站口径冲突，本次未拉取 npm registry API）。
2. Mediabunny GitHub Stars 在 2026-11-15 当日的精确数（仅有 2026-10 快照约 7.3k）。
3. WebKitGTK 的 WebCodecs 是否默认开启（查到“2.42 视频 / 2.44 完整后端+启用提交”，但无官方一句话定论默认开启与否；且发行版构建差异大）。
4. Tauri 打包产物三端实测：`VideoEncoder`/`VideoDecoder` 探测、GStreamer 插件缺失时的表现、`crossOriginIsolated` 与 SharedArrayBuffer（ffmpeg.wasm 多线程）在 `tauri://`/asset 协议下是否生效。
5. Tauri 官方文档有无针对 ffmpeg.wasm / COOP-COEP 的专门说明（本次未找到）。
6. Mediabunny 各 WASM 扩展包（aac/ac3/prores/mp3/flac-encoder）的底层许可证逐包核对（仅核对到 mp3-encoder 内嵌 LAME/LGPL 的第三方记录）。

---

## 来源链接（全部）

- https://mediabunny.dev/guide/introduction
- https://mediabunny.dev/guide/supported-formats-and-codecs
- https://mediabunny.dev/codec-registry/overview
- https://npm.io/package/mediabunny
- https://security.snyk.io/package/npm/mediabunny
- https://index.githits.dev/packages/npm/mediabunny/
- https://index.githits.dev/packages/npm/@mediabunny/aac-encoder/
- https://index.githits.dev/packages/npm/@mediabunny/mp3-encoder/
- https://github.com/shaneosullivan?tab=stars&type=sponsorable
- https://voyager.so/blog/mediabunny-vs-ffmpeg-wasm
- https://www.testmuai.com/learning-hub/webcodecs-browser-support/
- https://github.com/simplearyan/studio-pro/blob/HEAD/docs/video/Cross-Platform-Tauri-MediaBunny-Plan.md
- https://github.com/betaflight/betaflight-configurator/issues/5396
- https://github.com/polimero-app/melt
- https://indico.freedesktop.org/event/5/contributions/170/attachments/107/165/WebCodecs%20in%20WebKit%2C%20with%20GStreamer%21.pdf
- https://base-art.net/Articles/from-webkitgstreamer-to-rust-av-a-journey-on-our-stacks-layers/
- https://github.com/WebKit/WebKit/wiki/GLib-Stable-Branches
- https://www.zachsimms.com/typescript/web-apis/webcodecs/
- https://github.com/bevyl-ai/rerender/blob/HEAD/docs/remotion-media-spec.md
- https://deepwiki.com/Vanilagy/mediabunny/9.5-example-applications
- https://github.com/proj-airi/recorder-minecraft/blob/HEAD/docs/research/dashboard-resource-browser-media-preview.md
- https://www.xugj520.cn/en/archives/browser-media-toolkit-mp4-webm.html
- https://www.filesnug.online/licenses/
- https://licensing.wyattau.com/osi-licenses/
- https://deepwiki.com/opendataloader-project/opendataloader-bench/8.3-license-compatibility
- https://useotools.com/video-converter
- https://useotools.com/video-to-mp3
- https://useotools.com/rmvb-to-mp4
- https://github.com/ffmpegwasm/ffmpeg.wasm
- https://socket.dev/npm/package/@ffmpeg/ffmpeg/overview/0.12.15
- https://ryusei.io/en/article/browser-video-webcodecs
- https://renderio.dev/blogs/ffmpeg-wasm-guide
- https://bytefork.tools/blog/ffmpeg-wasm-browser-video-2026/
- https://www.zro7.com/blog/ffmpeg-wasm-cpu-ram-benchmark/
- https://www.pkgpulse.com/guides/fluent-ffmpeg-vs-ffmpeg-wasm-vs-node-video-lib-video-2026
- https://copyprogramming.com/howto/javascript-ffmpeg-npm-to-create-video-npm
- https://github.com/ankit4479/audio-converter/blob/HEAD/docs/browser-offline-compute-research.md
- https://tarkarn.com/blog/ffmpeg-wasm-browser-guide
- https://www.clearrec.app/blog/ffmpeg-wasm-complete-guide-2026
- https://dev.to/doublecitizen/ffmpegwasm-in-production-deadlocks-a-2-gb-ceiling-and-a-codec-that-lies-to-users-1lj8
- https://deepwiki.com/uist1idrju3i/web-playground/9.4-native-desktop-shells-(electron-tauri-wails)
- https://github.com/fastled/fastled/issues/2452
- https://github.com/wilson-anysphere/formula/commit/25179721978fa368333214f6ad42403ee2b816d9
- https://github.com/omiq/rgc-basic/blob/HEAD/docs/tauri-desktop-launcher-spec.md
- https://github.com/josiahsiegel/claude-plugin-marketplace/blob/HEAD/plugins/ffmpeg-platforms/skills/ffmpeg-webassembly-workers/SKILL.md
