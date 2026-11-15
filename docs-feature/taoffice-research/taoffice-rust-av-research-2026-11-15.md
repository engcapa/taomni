# Taomni taoffice 视频插件：纯 Rust 编解码/音视频库选型调研

调研日期：2026-11-15（北京时间）。方法：browser.search 实际查证；browser.open 因 429 限流失败，未能逐页打开 crates.io/lib.rs 详情页，故凡未打开原文核实的数字均标注来源为搜索结果摘要或“未核实”。不做最终 verdict，只给事实与每条路线优缺点小结。

硬约束对照：不接受 sidecar 进程（凡带 `-sys`、需系统库/预编译二进制的路线都已标出）；单个插件包 ≤100 MB；许可证须能进 MIT 项目分发（MPL-2.0、BSD-2 等弱 copyleft/宽松许可证需法务复核，见各节）。

---

## 1. rav1e（AV1 编码器）与 ravif（AV1 图像编码）

### rav1e
- 语言：纯 Rust（另有手写汇编），Xiph.org / Mozilla 开发；自述“最快最安全的 AV1 编码器”。来源：https://dev.encode.wiki/tools/software-encoders/rav1e
- 许可证：BSD-2-Clause（主许可证；Fedora 打包另列出 ISC/MIT/Apache 等依赖许可证）。来源：https://dev.encode.wiki/tools/software-encoders/rav1e ；https://rpmfind.net/linux/RPM/fedora/devel/rawhide/aarch64/r/rav1e-libs-0.8.1-5.fc46.aarch64.html
- 当前版本 / 最近发布：v0.8.1，2025-06-16；该来源称周度预发布构建已于 2025-09 停止。来源：https://dev.encode.wiki/tools/software-encoders/rav1e
- 下载量 / stars：GitHub stars 4,160（同一来源）；crates.io 下载量本轮未核实。
- 维护状态：仍有提交（该来源称最近提交 2026-08-31），但正式版停留在 2025-06 的 0.8.1，节奏放缓，需警惕。来源：https://dev.encode.wiki/tools/software-encoders/rav1e
- 能力：仅编码（AV1 encode），不解码、不解封装。x86-64 构建需要 NASM 2.14.02+。来源：https://dev.encode.wiki/tools/software-encoders/rav1e
- Tauri/Rust 集成：纯 Rust crate，可直接 `cargo` 编译进 Tauri 的 Rust 后端，无 sidecar、无系统依赖（除汇编工具链）。与 Tauri 本身无特殊耦合。
- 体积：Fedora 的 rav1e-libs 二进制包约 2.1 MB（aarch64）；编进 Tauri 后的实际增量未实测。来源：https://rpmfind.net/linux/RPM/fedora/devel/rawhide/aarch64/r/rav1e-libs-0.8.1-5.fc46.aarch64.html
- API 质量：未核实（本轮未打开 docs.rs）。已知被 GStreamer 的 gst-plugin-rav1e 采用。来源：https://lib.rs/crates/gst-plugin-rav1e
- 小结：优点——纯 Rust、BSD-2、AV1 编码唯一成熟选择；缺点——只管编码不管播放，编码速度慢（以质量换速度），正式版更新慢，对“先做播放”无直接帮助，只在二期转码/导出 AV1 时有用。

### ravif
- 语言：纯 Rust，基于 rav1e + avif-serialize 的 AVIF 静态图像编码库，驱动 `cavif` 工具。来源：https://fastly-app.crates.io/crates/ravif
- 许可证：本轮未核实（crates.io 摘要未给出；勿默认与 rav1e 相同）。
- 当前版本：v0.13.0（lib.rs 图像分类页）；crates.io 页显示“19,062,853 Recent downloads”、37 个已发布版本（该数字的统计口径——累计还是近期——摘要未说明，引用时需谨慎）。来源：https://lib.rs/multimedia/images ；https://fastly-app.crates.io/crates/ravif
- 最近发布日期：未核实。
- 维护状态：未核实（有多个下游引用，如 image crate 用其做 AVIF 编码）。来源：https://deepwiki.com/image-rs/image/3.1-decoding-pipeline
- 能力：仅 AVIF 静态图编码，API 据称只有一个 `encode_rgba()` 调用；不解码、不处理视频。来源：https://fastly-app.crates.io/crates/ravif
- 小结：优点——纯 Rust、API 极简；缺点——与视频播放无关，只对“视频封面/缩略图导出 AVIF”或图片插件有意义，不应计入视频插件核心选型。

---

## 2. dav1d 的 Rust 绑定

### rust-av/dav1d-rs（`dav1d` + `dav1d-sys`）
- 存在性：存在。`dav1d` 是对 C 库 libdav1d 的简单 FFI 绑定 + 安全抽象；`dav1d-sys` 是 FFI 层。来源：https://lib.rs/crates/dav1d ；https://docs.rs/crate/dav1d/0.10.3/source/README.md
- 语言：Rust 绑定 + C 库本体（不是纯 Rust）。构建需系统提供 dav1d（经 system-deps/pkg-config 查找，可用 `SYSTEM_DEPS_DAV1D_*` 环境变量覆盖；Windows 可用 vcpkg 装 dav1d）。来源：https://docs.rs/crate/dav1d/0.10.3/source/README.md
- 许可证：绑定 crate 为 MIT；上游 dav1d 的许可证本轮未核实具体条款（Shiguredo 页只给出上游 COPYING 链接）。来源：https://lib.rs/crates/dav1d ；https://lib.rs/crates/shiguredo_dav1d
- 当前版本 / 最近发布：`dav1d` 0.11.1（2025-11-25），0.11.0（2025-05-28）；`dav1d-sys` 0.8.3（2025-05-28）。来源：https://lib.rs/crates/dav1d ；https://crates.io/api/v1/crates/dav1d-sys/versions
- 下载量：被 54 个 crate 使用（lib.rs）；具体月下载量未核实。来源：https://lib.rs/crates/dav1d
- 维护状态：2025 年仍有发布（0.11.x），但需注意版本上限：绑定要求 dav1d ≥1.3.0，且注明“可能不适用于 >1.5.0”。来源：https://docs.rs/crate/dav1d/0.10.3/source/README.md
- 能力：仅 AV1 解码（业界最快的 AV1 软件解码器之一），不编码、不解封装。需先由解封装器（如 matroska-demuxer / mp4）剥出 AV1 OBU/样本再喂给它。
- Tauri 集成 / 合规风险：⚠️ 与“编译进应用、不接受 sidecar”不冲突（它是链接进来的库，不是独立进程），但它不是纯 Rust：最终分发包必须带上 C 编译的 libdav1d（或要求用户系统自带），三平台交叉编译与 CI 复杂度上升；且它依赖外部 C 库的构建方式（system-deps/vcpkg）与 Tauri 的纯 cargo 构建不完全一致，需额外构建脚本验证。
- 小结：优点——AV1 解码性能与成熟度最好；缺点——非纯 Rust、有 C 依赖与版本上限，Tauri 打包需验证。

### shiguredo_dav1d（Shiguredo 的替代绑定）
- 当前版本：2026.2.0（2026-08-06），另有 2026.1.0（2026-03-31）；日历版本号。许可证 Apache-2.0（绑定层）。来源：https://lib.rs/crates/shiguredo_dav1d
- 特点：默认从 GitHub Releases 下载预编译 dav1d 二进制加速构建，也可用 `source-build` 特性从源码构建；覆盖 8 个平台预编译二进制。来源：https://lib.rs/crates/shiguredo_dav1d
- 使用量：仅被 2 个 crate 使用，生态远小于 rust-av 版。来源：https://lib.rs/crates/shiguredo_dav1d
- 小结：优点——更新、预编译二进制省构建时间；缺点——生态小、默认下载预编译二进制的做法与“源码编译进应用”的供应链要求有冲突（需改用 source-build 并审计），且 Shiguredo 要求先读其 OSS 说明、PR/issue 只在 Discord（日语）讨论，沟通成本高。

---

## 3. openh264（Rust 绑定 `openh264` crate）

- 语言：Rust 安全封装 + Cisco OpenH264 的 C/C++ 源码（`openh264-sys2` 内含上游源码，`build.rs` 用 `cc` 编译）。不是纯 Rust。来源：https://docs.rs/crate/openh264/0.6.2/source/src/lib.rs ；https://docs.rs/crate/openh264/latest/source/README.md
- 许可证：核心库与封装均为 BSD-2-Clause（Cisco / Ralf Biedert）。来源：https://docs.rs/crate/openh264/0.6.2/source/src/lib.rs
- 当前版本 / 最近发布：lib.rs 显示 0.9.9（2026-10-15）；另有漏洞库信息称最新为 0.9.10（截至 2026-11-13）。0.9.x 起改用 Rust 2024 edition。来源：https://lib.rs/crates/openh264 ；http://vulert.com/vuln-db/crates-io-openh264-sys2-183346
- 下载量：331,850/月，被 111 个 crate 使用；`openh264-sys2` 为 238,744/月、88 个 crate。来源：https://lib.rs/crates/openh264 ；https://lib.rs/crates/openh264-sys2
- 维护状态：活跃，2025-09 至 2026-10 连续发布 0.9.0→0.9.9/0.9.10。上游 Cisco OpenH264 v2.7.0 发布于 2026-10-22。来源：https://lib.rs/crates/openh264 ；https://awesomeopen.github.io/awesome-open/records/f952835452592537ac04c71a848c03e1758cd346fb54bde42eaba38aefbed9ab.html
- 能力：H.264 编解码双向。编码仅支持 Baseline / Constrained Baseline profile（据第三方 ADR）；解码在实测项目中 1080p 单帧个位数毫秒。8-bit 4:2:0。来源：https://github.com/hakanserce/rayplay/blob/HEAD/docs/adr/ADR-009.md ；https://github.com/yeqing17/fadb/blob/HEAD/docs/en/protocol-sources.md ；https://crates.io/crates/vidr/0.1.0
- 集成方式：默认 `source` 特性——内含源码、`cargo build` 开箱即用、可交叉编译；另有 `libloading` 特性——运行时加载 Cisco 预编译库。来源：https://docs.rs/crate/openh264/0.6.2/source/src/lib.rs
- Cisco 二进制分发问题（关键）：① 用源码自行编译进应用，Cisco 不承担 MPEG LA 专利费——其 FAQ 原文：“Cisco 只承担其自有二进制模块的许可费；使用源码的产品必须在用户安装时下载 Cisco 二进制”。② 只有下载 Cisco 官方预编译二进制并在安装时获取，才可能被 Cisco 的 MPEG LA 安排覆盖；且该覆盖只及于“那个二进制本身”，不延及源码构建。③ 因此 `source` 特性虽然构建最方便，但专利覆盖最弱；`libloading` + 安装时下载 Cisco 二进制才是合规上更接近 Firefox/Chrome 的做法，但这与“编译进应用、离线分发”的设想冲突，且需在应用内展示 Cisco 归属声明。来源：https://strawlab.org/strand-braid-api-docs/latest/src/openh264_sys2/lib.rs.html ；https://github.com/reactor-team/reactor-webrtc/commit/ddf7ace9a32eb8f3443e3c134a33979cb56213f7 ；https://fastly-app.crates.io/crates/reactor-webrtc
- 体积：未实测编进 Tauri 的增量；Fedora 的 rav1e-libs 类比不适用。OpenH264 本身是中小型 C 库，通常以 MB 计，100 MB 上限内一般无压力，但需实测。
- 小结：优点——H.264 编解码最成熟的 Rust 可用路线、BSD-2、构建方便、生态大；缺点——非纯 Rust；编码仅 Baseline；专利合规是最大风险点（源码构建无 Cisco 覆盖，预编译二进制又需安装时下载），需法务决策，不能只看许可证。

---

## 4. symphonia（纯 Rust 音频解码）

- 语言：纯 Rust，100% 安全 Rust（无 unsafe 代码块，自述），模块化多 crate 工作区。来源：https://lib.rs/crates/symphonia ；https://deepwiki.com/pdeljanov/Symphonia
- 许可证：MPL-2.0（整个项目，包括 MP3/AAC 解码 crate）。MPL-2.0 是文件级弱 copyleft：不加修改地作为依赖使用，一般不对 MIT/Apache 主代码产生传染义务，只有修改 symphonia 自身源文件才触发该文件的共享义务——但这只是第三方调研的解读，进 MIT 项目分发前仍需法务复核。来源：https://lib.rs/crates/symphonia ；https://github.com/mkpoli/phonia/blob/HEAD/docs/research/rust-ecosystem.md
- 当前版本 / 最近发布：0.6.1（2026-08-13）；0.6.0（2026-05-15）。MSRV 1.85。来源：https://lib.rs/crates/symphonia ；https://docs.rs/crate/symphonia/latest
- 下载量：被 938 个 crate 使用；lib.rs 关键词页显示约 2.2M（统计口径未注明）。来源：https://lib.rs/crates/symphonia ；http://lib.rs/keywords/multimedia-encoding
- 维护状态：活跃，2026 年有 0.6.x 发布。
- 支持格式（逐项核实）：
  - MP3：支持，评级 Excellent，支持无缝（gapless），但属非默认特性（`mp3`/`mpa`，`symphonia-bundle-mp3`）。来源：https://lib.rs/crates/symphonia
  - AAC：仅 AAC-LC，评级 Great，非默认特性（`aac`）；HE-AAC/HE-AACv2 需走 C 库 `libfdk-aac` 的适配器，非纯 Rust。来源：https://lib.rs/crates/symphonia ；https://docs.rs/crate/symphonia/latest
  - FLAC：支持，Excellent，默认开启。来源：https://lib.rs/crates/symphonia
  - Vorbis：支持，Excellent，默认开启。来源：https://lib.rs/crates/symphonia
  - Opus：❌ 无原生解码器。`symphonia-codec-opus` 是空占位 crate，状态栏为“-”（未开始/进行中），`all` 特性也不拉取它；只能识别 Opus 流、解析 OpusHead，再交给外部解码器。纯 Rust 替代是 `opuscule`（见 §7），C 路线是 `symphonia-adapter-libopus`（基于 libopus，0.3.x 起对应 symphonia 0.6）。来源：https://deepwiki.com/pdeljanov/Symphonia/3.7-opus-and-wavpack-stubs ；https://lib.rs/crates/symphonia-adapter-libopus ；https://github.com/craft-and-code/FlacCompagnon
  - WAV：支持（PCM，默认开启）。来源：https://lib.rs/crates/symphonia
  - 其他：ALAC、MP1/MP2、ADPCM、WavPack（占位，无解码器）等；容器支持 AIFF、CAF、ISO/MP4、MKV、OGG、WAV。默认只开免版税格式，需用特性开关显式启用 mp3/aac/alac/isomp4 等。来源：https://lib.rs/crates/symphonia ；https://github.com/skroyc/pyatv-rs/blob/HEAD/docs/research/rust-crates.md
  - RM 音频：❌ 不支持。Symphonia 的格式/编解码列表中无 RealMedia/RM、RealAudio（Cook/ATRAC 等）；本轮未找到任何 symphonia 支持 RM 的证据。
- 编码能力：❌ 无。Symphonia 只是解码 + 解封装库，不提供任何音频编码器；转码/导出音频需另找编码器（见 §8 缺口）。
- Tauri 集成：纯 Rust crate，直接编译进 Rust 后端；与 cpal/rodio 配合是标准做法（解码出 PCM → 送音频输出）。
- 体积：各子 crate 按需启用，单个子 crate 源码量级在数百 KB~1.5 MB（如 symphonia-format-isomp4 为 1.5 MB）；全量启用仍远小于 100 MB 上限。来源：https://lib.rs/crates/symphonia-format-isomp4
- 小结：优点——纯 Rust、MPL-2.0 可接受（待法务确认）、覆盖 MP3/AAC-LC/FLAC/Vorbis/WAV 等视频常见伴音、API 为统一的解封装+解码 trait、生态最大；缺点——Opus 无原生解码、RM 全无、零编码能力、MP3/AAC 默认关闭且 AAC 专利池在部分司法辖区仍有效（第三方调研提醒）。

---

## 5. cpal 与 rodio（音频播放）

### cpal
- 语言：纯 Rust 底层跨平台音频 I/O 库。来源：https://LIB.Rs/crates/cpal
- 许可证：Apache-2.0。来源：https://LIB.Rs/crates/cpal
- 当前版本 / 最近发布：0.18.2（2026-08-16）；0.18.1（2026-06）。来源：https://LIB.Rs/crates/cpal ；https://github.com/mkpoli/phonia/blob/HEAD/docs/research/rust-ecosystem.md
- 下载量：被 1,760 个 crate 使用（731 个直接依赖）。来源：https://LIB.Rs/crates/cpal
- 维护状态：活跃。
- 跨平台输出：默认后端——Windows WASAPI（可选 ASIO、JACK）、macOS/iOS CoreAudio、Linux/BSD ALSA（可选 JACK、PipeWire、PulseAudio）、Android AAudio；另有 WASM 后端。来源：https://LIB.Rs/crates/cpal ；https://fastly-app.crates.io/crates/rsaber_hackedcpal
- 能力：只做音频输入/输出流（底层回调），不解码、不混音、不提供播放器语义；与 symphonia 的配合方式是“symphonia 解码成 PCM → cpal 回调写出”，需自行做时钟同步（采样计数器）、声道/采样率转换。来源：https://github.com/mkpoli/phonia/blob/HEAD/docs/research/rust-ecosystem.md
- 小结：优点——标准选择、Apache-2.0、三平台覆盖全；缺点——底层，需自己写播放控制、同步与重采样，工作量大于 rodio。

### rodio
- 语言：Rust 高层播放库；播放经 cpal，解码默认经 symphonia。来源：https://lib.rs/crates/rodio
- 许可证：MIT OR Apache-2.0。来源：https://github.com/mikita-herasiutsin/sim-curve-train-app/blob/HEAD/docs/investigations/2026-10-06-audio-feedback.md
- 当前版本 / 最近发布：docs.rs 版本列表显示 0.23.0（2026-10-11）；lib.rs 摘要显示 0.22.2（2026-03-05），0.22.0（2026-02-20），0.21.1（2025-07-14）。两处版本信息不一致，以 crates.io 为准需再核实，但可确认 2026 年仍在发布。来源：https://docs.rs/crate/rodio/0.18.1 ；https://lib.rs/crates/rodio ；https://github.com/rustaudio/rodio/blob/HEAD/CHANGELOG.md
- 下载量：被 819 个 crate 使用；2025 年的一篇指南称累计 5.3M、近期 844.3K（数据截至 2025-11，已过期，仅供参考）。来源：https://lib.rs/crates/rodio ；https://generalistprogrammer.com/tutorials/rodio-rust-crate-guide
- 维护状态：仍在维护（2026 年有 0.22.x 与 0.23.0 发布记录），“rodio 无人维护”的说法与查证不符。
- 与 symphonia 的配合：默认用 symphonia 解码；提供 Sink/Source、混音、队列、音效等高层抽象；0.22.2 更新日志称“经 `symphonia-adapter-libopus` 增加 Opus 支持”、支持注册第三方 symphonia 解码器。但另有一个 2026-08 的项目记录称 `rodio::Decoder` 使用固定的 symphonia 编解码注册表、其中没有 Opus 解码器，该项目改用 symphonia 读包 + `opuscule` 解码——两处说法有出入，Opus 能否开箱即用需实测验证，不可直接采信任一说法。来源：https://github.com/rustaudio/rodio/blob/HEAD/CHANGELOG.md ；https://github.com/ealtun21/toutui/commit/c342f50cce5560a73e90d6ae3bee1a36e67f91bc
- 局限：默认 100 ms 缓冲与内部阻塞通道/互斥锁，对低延迟实时合成不友好；但对视频播放伴音（可接受百毫秒级缓冲）一般不是问题。MSRV 为滚动策略（至少 6 个月）。来源：https://github.com/mikita-herasiutsin/sim-curve-train-app/blob/HEAD/docs/investigations/2026-10-06-audio-feedback.md ；https://lib.rs/crates/rodio
- 小结：优点——MIT/Apache、维护中、开箱即用的播放器语义（播放/暂停/混音/队列），与 symphonia+cpal 是同一 RustAudio 生态；缺点——高层抽象带来延迟与控制力损失、Opus 支持说法不一需实测、视频音画同步仍需自己以音频时钟为准做同步逻辑。

---

## 6. matroska-demuxer 与 mp4 crate

### matroska-demuxer
- 语言：纯 Rust。来源：https://lib.rs/crates/matroska-demuxer
- 许可证：MIT OR Apache-2.0 OR Zlib（三选一）。来源：https://lib.rs/crates/matroska-demuxer
- 当前版本 / 最近发布：0.8.1（2026-08-07）；0.8.0（2026-06-30）；0.7.0（2025-05-01）。来源：https://lib.rs/crates/matroska-demuxer
- 下载量：被 9 个 crate 使用（生态小）；具体月下载量未核实。来源：https://lib.rs/crates/matroska-demuxer
- 维护状态：2025–2026 年持续发布，活跃。
- 能力：仅解封装（demux），无复用（mux）。可解 MKV 与 WebM（WebM 是 Matroska 的受限子集）；但文档明确“为简便起见，只支持 MKV 与 WebM 共有的元素”。来源：https://lib.rs/crates/matroska-demuxer ；https://docs.rs/crate/matroska-demuxer/0.5.0
- 体积：lib.rs 标注约 1 MB、3.5K 行源码（不含注释）。来源：https://lib.rs/crates/matroska-demuxer
- 小结：优点——纯 Rust、许可证极友好、MKV/WebM 解封装最直接的选择；缺点——只解不复用、生态小（9 个下游）、只覆盖共有元素（高级 Matroska 特性如 ordered chapters、复杂附件等可能缺失），转码导出 MKV 需另找 muxer。

### mp4 crate（`mp4`）
- 语言：Rust，ISO-MP4 读/写库。来源：https://lib.rs/crates/mp4
- 许可证：MIT。来源：https://lib.rs/crates/mp4
- 当前版本 / 最近发布：⚠️ 0.14.0（2023-08-01）——lib.rs 显示最近一次发布已是三年多前，26 个版本中有 13 个 breaking。来源：https://lib.rs/crates/mp4
- 下载量：697,522/月，被 81 个 crate（34 个直接）使用——用量大，但与发布停滞并存。来源：https://lib.rs/crates/mp4
- 维护状态：⚠️ 存疑。下载量高不等于维护活跃；自 2023-08 后未见新版，需在选型时把“无人修 bug/无人适配新 Rust”列为风险，或改用下述替代品。
- 能力：MP4 读 + 写（解封装 + 复用），但 MOV 支持程度本轮未核实（MP4 与 MOV 同属 ISOBMFF 家族，多数实现可兼读 MOV，但该 crate 是否完整支持 MOV 的 freeform/QuickTime 扩展未查证）。
- 体积：约 310 KB、9K 行源码。来源：https://lib.rs/crates/mp4
- 小结：优点——MIT、用量大、读写双向、体积小；缺点——三年未发布是最大风险。

### MP4 方向的替代品（同批查到）
- `shiguredo_mp4`（mp4-rs）：零依赖、Sans-I/O、`no_std`、MP4 盒结构编解码 + 标准 MP4 与 fMP4 的解封装/复用；日历版本号，2026.1.0 修过描述符算术溢出。来源：https://deepwiki.com/shiguredo/mp4-rs
- `mp4-atom`：ISOBMFF atom 编解码，0.16.2（2026-10-06），142,199/月，60 个下游，MIT/Apache，23K 行。来源：https://lib.rs/crates/mp4-atom
- `muxide`：纯 Rust MP4 复用器（只 mux 不 demux），0.5.0（2026-10-19），4,755/月，MIT/Apache，1.5 MB，支持 H.264/HEVC/AV1 + AAC/Opus 已编码帧 → 标准 MP4/fast-start。来源：https://lib.rs/crates/muxide
- `filmcraft-matroska` / `filmcraft-isobmff`（storytold Craft 系）：clean-room 实现，只依赖 std、无 unsafe、可编 wasm；MKV/WebM 解封装 + 最小复用、MP4 解封装/复用。来源：https://crates.io/crates/filmcraft-matroska ；https://docs.rs/filmcraft-matroska/latest/filmcraft_matroska/
- `oximedia-container`：纯 Rust 容器框架，0.2.1（2026-08-12），MP4/MKV/MPEG-TS/OGG 等解封装+复用，但 MP4 只支持 AV1/VP9（无 H.264），且项目较新、成熟度待验证。来源：https://fastly-app.crates.io/crates/oximedia-container/range/^0.2.1

---

## 7. 其他值得补上的纯 Rust 视频相关库

### AV1 解码：rav1d 与 rav1d-safe
- `rav1d`：dav1d 的 Rust 移植版（memorysafety 组织），纯 Rust + 汇编；设计为 libdav1d 的 drop-in 替代，主要暴露 C API。关键限制：上游长期没有 Rust API（issue #1252 规划中）；docs.rs 上的 `rav1d` crate 说明其 Rust API 复制 `dav1d-rs`、可作 drop-in 替代（除 `Error` 改名），但另有 fork 说明称“上游 main 已有 PR #1439 的安全 Rust API、尚无任何发布版包含它”，两者口径不一，需以实际发布的 crate 版本实测为准。版本：rav1d-cli 1.1.0（2025-05-07）、1.0.0（2024-07-19）。来源：https://docs.rs/sqzer-rav1d/0.1.0 ；https://crates.io/crates/sqzer-rav1d ；https://docs.rs/rav1d-cli/latest/dav1d/ ；https://github.com/rerun-io/rerun/issues/7575
- `rav1d-safe`：rav1d 的安全 Rust fork，16 万行手写汇编改写为安全 Rust SIMD，`forbid(unsafe_code)`，0.5.x，提供 `Decoder`（输入为原始 AV1 OBU 数据，需先自行剥容器）、`managed.rs` 的 Rust API；代价是约 1.5x 变慢（4K 图约 1.56x）、需 Rust 1.93+。来源：https://fastly-app.crates.io/crates/rav1d-safe/range/^0.5.3
- `rerun-io/rav1d-rs`：把 dav1d-rs 接到 rav1d 上的 fork，作者自述“有点乱”、内含 rav1d 全量源码拷贝，不建议直接采用。来源：https://github.com/rerun-io/rerun/issues/7575
- 小结：纯 Rust AV1 解码存在，但 API 成熟度与版本状态混乱，是 AV1 路线最大的不确定性；若 AV1 播放是刚需，dav1d（C）仍是稳妥路线，rav1d-safe 是纯 Rust 备选，需做性能实测。

### VP8/VP9：libvpx 绑定为主，纯 Rust 解码刚起步
- `vpx-rs` / `vpx-encode` / `libvpx-native-sys` / `shiguredo_libvpx`：均为 Google libvpx（C 库）的 Rust 绑定，编解码双向；其中 `shiguredo_libvpx` 2025.1.0（2025-09-26，Apache-2.0），`libvpx-native-sys` 5.0.17（2026-08-26，MPL-2.0），`vpx-rs` 只有 3 个不稳定版本、文档覆盖不全。来源：https://docs.rs/vpx-rs/latest/vpx_rs/ ；https://lib.rs/crates/shiguredo_libvpx ；https://lib.rs/crates/libvpx-native-sys
- 纯 Rust VP9：`rusty_vp9`——纯 Rust VP9 解码+编码、无 C/FFI，自述解码与全部 315 个 libvpx 官方一致性向量逐比特一致；但 v0.1.3、仅 1.5K 下载，极早期。来源：http://lib.rs/keywords/multimedia-encoding
- 纯 Rust VP8：`oxideav-vp8` 标注为“孤儿重建脚手架，待 clean-room 重实现”，即尚未可用；`vp9dec` 为从零写的 clean-room VP9 解码器（零依赖 crate）。来源：https://LIB.Rs/multimedia/video?sort=popular
- 小结：WebM 播放（VP8/VP9）若坚持纯 Rust，目前只有极早期的 `rusty_vp9` 可看，VP8 基本无成熟纯 Rust 解码；务实路线是 libvpx 绑定（C）或接受 WebM 初期只播 AV1/Opus 组合。

### H.264 纯 Rust 解码新秀：rusty_h264
- `rusty_h264-decoder`：纯 Rust H.264 解码管线，Constrained Baseline + B-slice + 大部分 High profile，CAVLC 与 CABAC；自述在 openh264 一致性语料 35/35 条流上与 Cisco `h264dec` 逐字节一致、像素级对标 ffmpeg；`#![forbid(unsafe_code)]`、BSD-2、依赖树无 C。输入为 Annex-B、输出 I420。来源：https://fastly-app.crates.io/crates/rusty_h264-decoder
- 局限：自述未完成项包括 CABAC `I_PCM`、High profile 8×8 CABAC 残差、完整 JVT 一致性；且 2026-11 才发布新版、下载量与下游生态本轮未核实，成熟度与性能（自述 720p 单核数据未完整引用）需实测。来源：https://fastly-app.crates.io/crates/rusty_h264-decoder
- 小结：这是“纯 Rust 能否播 H.264”的关键变量——若实测通过，它可替代 openh264 绕开专利与 C 依赖；若不通过，H.264 只能走 openh264（C）或系统硬解。

### 容器：AVI 与 RM
- AVI：`oxideav-avi` 0.0.11，纯 Rust AVI（RIFF）解封装+复用，零 C 依赖，支持 AVI 1.0/OpenDML 2.0、idx1 索引寻址；但版本号 0.0.x、生态极小。`tarang` 也称容器层支持 AVI。来源：https://docs.rs/crate/oxideav-avi/latest ；https://docs.rs/tarang/latest/tarang/
- RM / RealMedia：❌ 本轮未找到任何成熟的纯 Rust RM 解封装 crate，也未找到 RealVideo/RealAudio 的纯 Rust 解码器。OxideAV 的容器列表为 MP4/MKV/WebM/OGG/AVI/FLV，未列 RM；NihAV（Rust 多媒体框架）自述有从 H.263 到 H.265 的解码器且 RealMedia 相关内容存在，但其当前版本、维护状态与 RM 解封装/解码的完整程度本轮未核实，列为待查项，不可直接采信。来源：https://github.com/OxideAV ；https://www.nihav.org/overview.html
- 小结：AVI 有小众纯 Rust 方案可用；RM 是纯 Rust 路线的明确缺口。

### 框架型项目（可作整合参考，不建议直接依赖整包）
- OxideAV：纯 Rust 转码/流媒体框架，约 95 个小 crate，容器 MP4/MKV/WebM/OGG/AVI/FLV，视频编解码覆盖 H.264/H.265/H.266/AV1/VP8/VP9/MPEG-1/2/4 等；但各 crate 版本多为 0.0.x/0.1.x，成熟度与 API 稳定性待逐个验证。来源：https://github.com/OxideAV
- Tarang：以纯 Rust 音频（shravan）+ 纯 Rust 容器 + C FFI 视频编解码（dav1d/openh264/libvpx/rav1e/VA-API）的混合框架，容器支持 MP4/MKV/WebM/OGG/WAV/FLAC/MP3/AVI。来源：https://docs.rs/tarang/latest/tarang/
- OxiMedia：纯 Rust 媒体框架，容器 0.2.1（2026-08-12），但 MP4 仅 AV1/VP9。来源：https://fastly-app.crates.io/crates/oximedia-container/range/^0.2.1

### 音频编码（纯 Rust，属 §8 缺口，附带说明）
- `opuscule`：纯 Rust Opus 解码器，0.2.0，47 个文件实测与 libopus 采样一致；编码能力本轮未核实。来源：https://github.com/ealtun21/toutui/commit/c342f50cce5560a73e90d6ae3bee1a36e67f91bc
- 其余：Symphonia 无编码；AAC/MP3 纯 Rust 编码器本轮未找到成熟选项（`alac-encoder` 0.3.0 停留在 2022-01-10，见第三方调研引用）。来源：https://github.com/skroyc/pyatv-rs/blob/HEAD/docs/research/rust-crates.md

---

## 8. 综合：纯 Rust 路线能不能拼出“够播常用格式”？

### 能拼出的部分（播放优先）
| 目标 | 可用组合 | 状态 |
|---|---|---|
| MP4/MOV 解封装 | `mp4` 0.14.0（三年未发布，风险）或 `shiguredo_mp4` / `mp4-atom` + `muxide`（复用） | 基本可行，需二选一并验证 MOV |
| MKV/WebM 解封装 | `matroska-demuxer` 0.8.1（仅解封装）或 `filmcraft-matroska`（解+最小复用） | 可行 |
| AV1 解码 | `rav1d-safe`（纯 Rust，慢 ~1.5x）或 `dav1d-rs`（C，最快但非纯 Rust） | 纯 Rust 可行但有性能/成熟度代价 |
| AV1 编码（转码用） | `rav1e` 0.8.1 | 可行，慢 |
| H.264 解码 | `rusty_h264`（新、待实测）或 `openh264`（C、成熟但有专利问题） | 纯 Rust 路线系于单一新库，风险高 |
| H.264 编码 | `openh264`（仅 Baseline）或 `rusty_h264-encoder`（待核实） | 纯 Rust 编码未核实 |
| VP9 解码 | `rusty_vp9` 0.1.3（极早期）或 libvpx 绑定（C） | 纯 Rust 基本不可用 |
| VP8 解码 | 无成熟纯 Rust 方案 | 缺口 |
| 音频解码 | symphonia（MP3/AAC-LC/FLAC/Vorbis/WAV）+ `opuscule`（Opus 解码） | 除 Opus 需拼装外基本可行 |
| 音频播放 | cpal（底层）或 rodio（高层） | 可行 |
| AVI 解封装 | `oxideav-avi` 0.0.11 | 小众但存在 |

### 缺口清单
1. **H.264 解码**：纯 Rust 唯一候选是 2026-11 才冒头的 `rusty_h264`，未经大规模验证；退路 openh264 是 C 且有 Cisco 专利覆盖问题。
2. **VP8/VP9 解码**：纯 Rust 只有极早期的 `rusty_vp9`（VP9）与脚手架状态的 `oxideav-vp8`（VP8），WebM 的 VP8/VP9 内容基本播不了。
3. **AVI/RM 解封装与 RM 编解码**：AVI 有小众方案；RM（容器 + RealVideo + RealAudio）在纯 Rust 生态中基本是空白，NihAV 待查但不可直接采信。
4. **音频编码**：Symphonia 零编码；Opus/AAC/MP3 的纯 Rust 编码器无成熟选项，转码/导出音频是二期最大缺口。
5. **视频编码（除 AV1/H.264-Baseline 外）**：VP9/HEVC 等纯 Rust 编码基本缺失。
6. **MP4 库维护断层**：用量最大的 `mp4` crate 三年未发布，需切换到较新的 `shiguredo_mp4`/`mp4-atom` 并自行验证。
7. **Opus 解码需拼装**：symphonia 占位 + `opuscule` 或 libopus 适配器，不是开箱即用；rodio 的 Opus 支持说法不一，需实测。

### 体积
- 单个 crate 源码量级：matroska-demuxer 约 1 MB、mp4 约 310 KB、symphonia 子 crate 数百 KB~1.5 MB、openh264/rav1e 的打包二进制约 2 MB 级（Fedora 包数据，非 Tauri 实测值）。来源：见各节链接。
- 定性判断：只拼“解封装 + 一两种解码 + 音频”时，Rust 增量通常在数 MB 到十余 MB 级，100 MB 单插件上限一般不构成瓶颈；真正的体积与构建风险来自 C 依赖（dav1d/openh264/libvpx 需随包携带或编译）与 rav1e/rav1d 的代码体积，未实测前不要给出精确数字。本轮未做任何实际编译测量，所有体积数字均为上游包体量，非 Tauri 插件增量。

---

## 来源链接（全部）

- https://dev.encode.wiki/tools/software-encoders/rav1e
- https://rpmfind.net/linux/RPM/fedora/devel/rawhide/aarch64/r/rav1e-libs-0.8.1-5.fc46.aarch64.html
- https://fastly-app.crates.io/crates/ravif
- https://lib.rs/multimedia/images
- https://deepwiki.com/image-rs/image/3.1-decoding-pipeline
- https://lib.rs/crates/dav1d
- https://docs.rs/crate/dav1d/0.10.3/source/README.md
- https://crates.io/api/v1/crates/dav1d-sys/versions
- https://lib.rs/crates/shiguredo_dav1d
- https://docs.rs/crate/openh264/0.6.2/source/src/lib.rs
- https://docs.rs/crate/openh264/latest/source/README.md
- https://lib.rs/crates/openh264
- https://lib.rs/crates/openh264-sys2
- http://vulert.com/vuln-db/crates-io-openh264-sys2-183346
- https://awesomeopen.github.io/awesome-open/records/f952835452592537ac04c71a848c03e1758cd346fb54bde42eaba38aefbed9ab.html
- https://github.com/hakanserce/rayplay/blob/HEAD/docs/adr/ADR-009.md
- https://github.com/yeqing17/fadb/blob/HEAD/docs/en/protocol-sources.md
- https://crates.io/crates/vidr/0.1.0
- https://strawlab.org/strand-braid-api-docs/latest/src/openh264_sys2/lib.rs.html
- https://github.com/reactor-team/reactor-webrtc/commit/ddf7ace9a32eb8f3443e3c134a33979cb56213f7
- https://fastly-app.crates.io/crates/reactor-webrtc
- https://lib.rs/crates/symphonia
- https://docs.rs/crate/symphonia/latest
- https://deepwiki.com/pdeljanov/Symphonia
- https://deepwiki.com/pdeljanov/Symphonia/3.7-opus-and-wavpack-stubs
- https://lib.rs/crates/symphonia-adapter-libopus
- https://lib.rs/crates/symphonia-format-isomp4
- http://lib.rs/keywords/multimedia-encoding
- https://github.com/mkpoli/phonia/blob/HEAD/docs/research/rust-ecosystem.md
- https://github.com/skroyc/pyatv-rs/blob/HEAD/docs/research/rust-crates.md
- https://github.com/craft-and-code/FlacCompagnon
- https://LIB.Rs/crates/cpal
- https://fastly-app.crates.io/crates/rsaber_hackedcpal
- https://lib.rs/crates/rodio
- https://docs.rs/crate/rodio/0.18.1
- https://github.com/rustaudio/rodio/blob/HEAD/CHANGELOG.md
- https://generalistprogrammer.com/tutorials/rodio-rust-crate-guide
- https://github.com/mikita-herasiutsin/sim-curve-train-app/blob/HEAD/docs/investigations/2026-10-06-audio-feedback.md
- https://github.com/ealtun21/toutui/commit/c342f50cce5560a73e90d6ae3bee1a36e67f91bc
- https://lib.rs/crates/matroska-demuxer
- https://docs.rs/crate/matroska-demuxer/0.5.0
- https://lib.rs/crates/mp4
- https://lib.rs/crates/mp4-atom
- https://lib.rs/crates/muxide
- https://deepwiki.com/shiguredo/mp4-rs
- https://crates.io/crates/filmcraft-matroska
- https://docs.rs/filmcraft-matroska/latest/filmcraft_matroska/
- https://fastly-app.crates.io/crates/oximedia-container/range/^0.2.1
- https://docs.rs/sqzer-rav1d/0.1.0
- https://crates.io/crates/sqzer-rav1d
- https://docs.rs/rav1d-cli/latest/dav1d/
- https://github.com/rerun-io/rerun/issues/7575
- https://fastly-app.crates.io/crates/rav1d-safe/range/^0.5.3
- https://docs.rs/vpx-rs/latest/vpx_rs/
- https://lib.rs/crates/shiguredo_libvpx
- https://lib.rs/crates/libvpx-native-sys
- https://LIB.Rs/multimedia/video?sort=popular
- https://fastly-app.crates.io/crates/rusty_h264-decoder
- https://docs.rs/crate/oxideav-avi/latest
- https://docs.rs/tarang/latest/tarang/
- https://github.com/OxideAV
- https://www.nihav.org/overview.html
- https://lib.rs/crates/gst-plugin-rav1e

## 未核实项（需后续实测或二次查证）
- browser.open 在本轮因上游 429 限流全部失败，未能打开 crates.io/lib.rs/docs.rs 详情页逐条核对；部分版本号/下载量引自搜索结果摘要。
- rav1e、ravif 的 crates.io 精确下载量与最近发布日期；ravif 许可证。
- dav1d 上游 C 库的许可证具体条款；rodio 0.23.0 是否为 crates.io 最新版及 Opus 开箱即用与否。
- `mp4` crate 的 MOV 支持程度；`rusty_h264` / `rusty_vp9` / `rav1d-safe` 的实测性能与 1080p/4K 解码表现。
- 任何“编进 Tauri 后插件增量体积”数字——本轮无实测。
- NihAV 的 RM 支持现状、当前版本与维护状态。
