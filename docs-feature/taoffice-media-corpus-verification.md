# TaOffice Media 公开语料验证

Media 0.3.0 的 Linux x86_64 宿主通过分块 RPC 读取了 35 份公开文件，共 39,212,094 字节。宿主代码来自 `adc72e2760a950bdeb624dbefaf4d8adda751244`，使用 `fd02f9be1` 的打包脚本和 FFmpeg n9.1。测试执行时，宿主通过 `$ORIGIN` 加载同目录的五个共享库。基线宿主 SHA-256 为 `64a092bbd05353df1b8e0669925aa64c0b7b76f26fbe6a8df153e36ef2780fdc`。逐文件记录包含来源、输入与输出 SHA-256、请求区间、视频尺寸、音轨和时长。 [逐文件回执](taoffice-research/media-corpus-ffmpeg-n9.1.csv) · [FFmpeg 样本](https://samples.ffmpeg.org/) · [MDN WebM 样本](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm)

每份输入请求宽度上限 160 px。常规区间为 0.500–3.000 秒，短文件按报告时长裁剪。输出轮流使用 MP4 和 WebM。验收核对偶数宽高、合比例缩放、输入主音轨和主视频轨的存在性、H.264/AAC 或 VP8/Opus 编码，以及相对请求时长最多 0.250 秒的差值。独立的 FFmpeg 6.1.1 使用 `-xerror` 完整解码每份输出。

| 基线结果 | 文件数 | 观察 |
| --- | ---: | --- |
| 通过尺寸、音轨、时长及完整解码 | 28 | MP4 14 份，WebM 14 份 |
| 可解码，短于请求区间 | 2 | `imaadpcm.avi` 导出 2.202 秒，`broken.asf` 导出 2.219188 秒 |
| 宿主报错 | 4 | 缺少解码器、坏帧、区间内缺少视频帧或输入无可转换流 |
| 宿主返回 258 字节，独立解码器读不到流 | 1 | 链式 Ogg 的空音频区间，已复测修复 |

通过样本覆盖 AVI、FLV、ASF/WMV、RM、Matroska、MOV、MP4、3GP/3G2、WebM、WAV 与 FLAC。解码输入包含 H.264、MPEG-4、VP8、VP6、H.263、WMV1、RealVideo、MJPEG 及未压缩视频。双音轨 AVI 和多视频轨 ASF 输出一个主音轨和一个主视频轨。六声道 FLAC 转为 48 kHz 立体声 AAC。逐文件回执保留了输入的轨道数量及输出的通道数。

`imaadpcm.avi` 没有报告总时长，最后一个视频包结束于 2.669334 秒，独立解码器还报告了损坏的数据包。`IFTlhxwwkKE.flv` 的两个视频包位于 0.000 秒和 144.928 秒，因此 0.500–3.000 秒的请求没有视频帧。复测 0.000–3.000 秒得到 160 × 160 的 H.264 视频和 3.000 秒 AAC 音频。`wmv2decerror-short.asf` 在宿主返回参数错误，独立解码器记录了 WMV2 帧内的 DC overflow。超过 32 MiB 一个字节的输入在开始上传时被拒绝。起点晚于 8.008 秒源文件结尾的裁剪也返回错误。 [FLV 样本](https://samples.ffmpeg.org/FLV/IFTlhxwwkKE.flv) · [WMV 样本](https://samples.ffmpeg.org/asf-wmv/wmv2decerror-short.asf)

修复提交 `1b676a9cf7d049ac3eb029c11f2a4870445b0144` 让音频专用裁剪在没有编码数据包时返回错误。修复后宿主 SHA-256 为 `00a44af80c8e890a733bb0cd76907d13a48b4fe4a408ba3e1ad209f5c980d725`。链式 Ogg 和合成 Matroska 音频间隙在 MP4、WebM 都返回无音频样本错误。有效时段的 Matroska 和 WAV 对照样本均以 AAC 或 Opus 解码成功。四个宿主单测通过。 [链式 Ogg 样本](https://samples.ffmpeg.org/ogg/virginradio-three-consecutive-chains.ogg) · [音频裁剪回归](../src-tauri/plugins/taoffice-video/src/transcode/tests.rs)
