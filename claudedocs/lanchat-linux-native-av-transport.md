# LanChat Linux 原生 A/V 传输方案(绕过 WebRTC)

> 状态:计划 / 待评审。本文承接 LanChat 任务 03(WebRTC 音视频会议),专门解决 **Linux WebKitGTK 不提供 `RTCPeerConnection`** 导致语音/视频/屏幕共享在 Linux 上完全不可用的问题。

## 1. 背景与根因(已确认)

- Linux 下 Tauri webview 是 WebKitGTK。在 Ubuntu 24.04 / Linux Mint、`libwebkit2gtk-4.1` 2.52.3 上确认:`RTCPeerConnection` / `webkitRTCPeerConnection` 恒为 `undefined`,**无法暴露**。
- 已穷尽验证(不要再重复排查):`enable-webrtc=true` 已设置并读回确认为真;reload 无效;无主控 `WebKitFeature` 开关(仅有 `MediaStreamTrackProcessing`/`RTCEncodedStreamsQuirk` 等子特性);独立 PyGObject WebKit2 4.1 测试在 load 前置位仍 `rtc:"undefined"`。结论是 **WebKitGTK 构建层不暴露 WebRTC DOM**,非本项目代码或时序问题。详见 memory `webkitgtk-linux-webrtc-unavailable` 与诊断分支 `fix/lanchat-linux-webrtc-diagnostics`(`src-tauri/src/lib.rs` 读回日志)。
- `getUserMedia` / media-stream 在 Linux 可用(麦克风真实可采);Windows(WebView2)、macOS(WKWebView)WebRTC 正常。
- 现有 A/V(`src/lib/lanRtc.ts` + `src/stores/lanCallStore.ts`,见 `lanchat-av-meeting-03.md`)**完全依赖 webview WebRTC**,因此 Linux 上 1:1/会议/屏幕共享均不可用。

## 2. 目标与范围

**目标**:在 Linux(及任何缺 `RTCPeerConnection` 的 webview)上,用 **Rust 原生采集 / 编码 / 传输 / 解码 + webview 直渲染**,提供与现有 UI 基本一致的局域网语音、屏幕共享、视频通话与多人会议。

**范围内**
- `MediaSession` 抽象:运行时按是否存在 `RTCPeerConnection` 选择 `WebRtcSession`(Win/mac,复用任务 03)或 `NativeSession`(Linux,新增)。
- Linux 优先;媒体面复用现有 mTLS TCP mesh(`lanchat/transport.rs`);渲染复用 RDP/VNC 的 "loopback WS + `<canvas>` + AudioWorklet" 范式。

**范围外(本期)**
- Windows/macOS 原生屏幕/摄像头采集(这两端继续用 WebRTC)。
- 会议录制、虚拟背景、美颜;SFU;跨网段 / TURN。
- 用原生栈全面替换 WebRTC(本期保留双栈)。

## 3. 架构总览

**双栈 + 运行时选择**(对 store/UI 暴露统一接口):

```
lanCallStore
  └─ MediaSession (interface)
       ├─ WebRtcSession   现 lanRtc.ts 适配;Win / macOS
       └─ NativeSession   新增;Linux / 无 RTCPeerConnection
```

`NativeSession` 每路对端的数据流:

```
本端:  cpal mic / nokhwa cam / X11 capturer
   → 编码(Opus 音频 / H.264 视频)
   → LanChat mTLS TCP mesh(新增 TAG_MEDIA 帧 + 独立 drop-oldest 队列)
对端:  收媒体帧 → Rust 解码
   → 每通话一条 loopback WS(参考 rdp/ws.rs)
   → webview:视频画 <canvas>;音频走 AudioWorklet 播放
```

**为何不在 webview 反向合成 `MediaStream`**:`CallOverlay.tsx` 依赖真实 `MediaStream`(`srcObject`、Web Audio `createMediaStreamSource` 说话人检测、`track.enabled` 静音、`track.stop()` 清理)。在缺 `RTCPeerConnection` 的 WebKitGTK 上,用 `MediaStreamTrackGenerator` 反向造流风险高(WebCodecs / Insertable Streams 支持未知)。而 "Rust 解码 → `<canvas>` / AudioWorklet" 是 RDP/VNC 已在 WebKitGTK 上验证可行的路径(`rdp/ws.rs`、`vnc/ws.rs`、`rdp/session.rs` 的 RDPSND→AudioWorklet)。因此 `NativeSession` 走**直渲染**,UI 增加 "原生渲染模式"。

## 4. 关键技术选型与新增依赖

| 组件 | 选型 | 现状 | 平台 | 风险 |
|---|---|---|---|---|
| 音频采集 | `cpal` | 已是 `voice-capture` 依赖(`voice/capture.rs`),但现为 16k/mono/PTT 仅供 ASR,需新写连续/48k/可选设备采集 | 三平台 | 低 |
| 音频编码 | Opus(`audiopus` 或 `magnum-opus`) | **无,需新增** | 三平台 | 低 |
| 回声消除/降噪 | `webrtc-audio-processing`(或 speexdsp) | **无,需新增** | 三平台 | **高:原生采集+外放必自激啸叫,WebRTC 本免费提供 AEC/NS/AGC** |
| 音频播放 | webview AudioWorklet(复用 `rdp/session.rs` RDPSND 路径) | 范式已存在 | 三平台 | 低 |
| 视频编码 | H.264 `openh264`(BSD,无系统依赖) | **无,需新增** | 三平台 | 中:软编 CPU |
| 摄像头采集 | `nokhwa`(Linux v4l2) | **无,需新增** | Linux 先做 | 中 |
| 屏幕采集 | 复用 RDP server X11 capturer(`servers/rdp/capture/x11.rs`,BGRA + XDamage 脏矩形,≤60fps) | 已存在 | **仅 Linux/X11**(Wayland/Win/mac 未实现) | 中 |
| webview 投递 | loopback WS(`rdp/ws.rs`/`vnc/ws.rs` 范式,二进制 tag 帧 + 文本控制) | 范式已存在 | 三平台 | 低 |

绝对缺失(全需新增):opus、openh264/x264、nokhwa、AEC、任何抖动缓冲/RTP。当前无 ffmpeg/gstreamer。

## 5. 传输层扩展(`src-tauri/src/lanchat/`)

复用 mTLS TCP mesh(`transport.rs` / `protocol.rs`,一对端一条 TLS 连接,节点 id = 证书指纹),新增媒体面:

- **`protocol.rs`**:新增 wire tag `TAG_MEDIA = 0x02`(现有 `TAG_CONTROL=0x00` JSON / `TAG_PIECE=0x01` 文件二进制);新增 `Frame::Media { session, stream, kind, seq, ts, data }` 变体 + `frame_media(...)` 构造 + `decode_frame` 分支。`PROTOCOL_VERSION` 3 → 4(握手按 pv 拒绝旧端,`transport.rs:463`)。
- **媒体控制帧**(JSON,走 control 队列,经现有 `lanchat://signal` 中继):`nmedia-offer` / `nmedia-answer`(协商 codec、采样率、分辨率/帧率、streamId、初始 mic/cam/screen)、`nmedia-stop`。呼叫语义仍沿用 `call-invite/accept/...`(store 已处理)。
- **`transport.rs`**:`ConnHandle`(`:56`)增加第三条**有界 drop-oldest** 队列 `media_tx`,与文件 `data_tx`(bounded cap 8,阻塞式背压)隔离,避免文件传输与实时媒体互相 HOL;write 任务 `select!`(`:560`)新增 media 分支(优先级 control > media > file-data,media 用 drop-oldest 而非阻塞);新增 `send_media(state, peer, bytes)` 仿 `send_data`(`:161`)。入站读循环 `decode_frame` 匹配(`:611`)新增 `Frame::Media` 分支 → 路由到媒体会话。`MAX_FRAME_LEN=4MiB` 限制单帧,大帧需切片。
- **`mod.rs`**:`state` 增 `media_sessions: RwLock<HashMap<callId, Arc<MediaSession>>>`(仿 `swarms`,`:106`);`events` 可不新增(媒体数据走 loopback WS,不走 Tauri event)。
- **`commands.rs` + `lib.rs`**:新增 `nmedia_start/stop`、`nmedia_toggle_mic/cam/screen`、`nmedia_ws_port`(取本通话 loopback 端口)等命令,仿 `lanchat_send_signal`(`commands.rs:287`)并在 `lib.rs` 注册。

**传输实时性注意**:实时媒体走 TCP 有 HOL 阻塞风险。v1 用 "独立 drop-oldest 媒体队列 + `set_nodelay`(已开,`:408`)",局域网低丢包下可接受;后续可评估每对端 UDP 或 QUIC(`quinn`)多路复用以降 HOL —— 列为未来优化,不阻塞 v1。

## 6. 前端集成(`src/`)

- **`src/lib/mediaSession.ts`(新增接口)**:对齐 store 实际调用的子集 —— 构造 `(callId, myId, cb)`;方法 `setLocalStream`、`setVideoTrack`、`connect`、`handleSignal`、`closePeer`、`close`;回调 `onRemoteStream(peerId, …)` / `onPeerClosed(peerId)`(`onPeerState` 可选、当前未用)。
- **`WebRtcSession`**:现 `lanRtc.ts` 重命名/适配为该接口实现(Win/mac,行为不变)。
- **`src/lib/nativeSession.ts`(新增)**:不创建 `RTCPeerConnection`;经 ipc 命令驱动 Rust 采集/编码/发送;打开本通话 loopback WS 接收远端解码帧,按 streamId/peerId 路由到 `<canvas>` / AudioWorklet;**不产出 `MediaStream`**,对 UI 暴露 canvas 渲染目标 + 音频电平。
- **`src/stores/lanCallStore.ts`**:`session: MediaSession`;`createMediaSession()` 按 `typeof RTCPeerConnection === 'function'` 选实现;`getUserMedia`/`getDisplayMedia` 仅 WebRTC 路径用,Native 路径改调 Rust 采集命令;`toggleMic/Cam/Screen`、`hangup` 分流到对应实现。
- **`src/components/lanchat/CallOverlay.tsx`**:新增原生渲染模式 —— 远端 tile 用 `<canvas>`(WS 帧)替代 `srcObject`;说话人检测改用 Rust 上报电平或 worklet 分析;mic/cam/screen 切换 → Rust 命令;卸载清理 → 停止 Rust 采集 + 关 WS。
- **`src/lib/runtime.ts`**:新增 `RTCPeerConnection` 能力探测,供 store 选栈与 UI 文案使用。

## 7. 信令(复用 `lanchat://signal` 中继)

- 呼叫/振铃复用 `call-invite/accept/reject/cancel/end`(store 已处理,后端纯中继 `transport.rs:689`)。
- 媒体协商用新帧 `nmedia-offer/answer` 替代 `signal-sdp/ice`:payload 含 codec(opus/h264)、采样率、分辨率/帧率、streamId、mic/cam/screen 初态。
- `media-state`(开关同步)保持不变。
- `NativeSession.handleSignal` 消费 `nmedia-*`,据此让 Rust 建立/调整该对端媒体流。

## 8. 分阶段实施(先做能力 spike,价值优先、风险前置)

**阶段 0 — 能力 spike(决定可行性与最终路径,务必先做)**
- S0.1 渲染范式 spike:Linux webview 用 loopback WS 把 Rust 生成的测试视频帧画到 `<canvas>` + AudioWorklet 播放 Rust 生成的 PCM,测延迟/流畅(RDP/VNC 已证可行,低风险)。
- S0.2 WebCodecs / MediaStreamTrackGenerator 探测:确认 WebKitGTK 2.52 是否支持(若支持,可考虑 "发编码帧→webview 解码" 简化路径;若否,坚持 Rust 解码直渲染)。
- S0.3 编解码/AEC spike:`openh264` + `opus` + `cpal`(含 output)三平台编译、包体、延迟评估;`webrtc-audio-processing` AEC 可用性。
- **验收**:产出 "直渲染 vs WebCodecs" 最终选择 + 依赖与包体增量数据 + AEC 结论。

**阶段 1 — `MediaSession` 抽象 + 双栈选择(零功能回归)**
- 抽接口,现 WebRTC 行为重构其后;store 运行时选栈;Win/mac 行为不变。
- **验收**:Win/mac 通话/会议与现状一致;Linux 选中 `NativeSession`(占位,尚不通)。

**阶段 2 — 原生语音 1:1(最高价值、最低成本,作为 MVP)**
- Rust:`cpal` 连续采集 → AEC/NS → Opus 编码 → mesh `TAG_MEDIA` 发送;收端 Opus 解码 → loopback WS → AudioWorklet 播放。
- 前端:`NativeSession` 音频路径 + `CallOverlay` 音频渲染;mic 切换。
- **验收**:两台 Linux 局域网 1:1 语音可通,延迟可接受、无明显回声,挂断释放设备。

**阶段 3 — 屏幕共享 1:1**
- Rust:复用 X11 capturer(BGRA + 脏矩形)→ H.264 编码 → mesh;收端解码 → WS → `<canvas>`。
- 前端:screen toggle → Rust 命令;远端 canvas 自适应布局。
- **验收**:通话中开/停屏幕共享,对端实时显示。

**阶段 4 — 摄像头视频 1:1**
- Rust:`nokhwa`(v4l2)采集 → H.264 → mesh;收端解码 → WS → canvas;时间戳做 AV sync。
- 前端:cam toggle;本地预览(本地 canvas,或仅本地预览仍用 getUserMedia)。
- **验收**:1:1 视频可通,音视频基本同步。

**阶段 5 — 多人会议(mesh)**
- 每对端一路媒体(发送侧 O(N) 编码/带宽);收端多 canvas 平铺 + 说话人高亮(电平上报)。
- 性能护栏:Linux mesh 建议 ≤ ~4–6 人(原生软编 CPU 高于 WebRTC 硬件加速,需实测设上限)。
- **验收**:3+ 人 Linux 会议互看互听,离开正确移除。

**阶段 6 — 收尾**
- Web 预览/桩;能力探测文案;设备释放与泄漏检查;跨栈互通决策落地(见风险 #1)。

## 9. 风险与待决项

1. **跨栈互通(最关键决策,建议先定)**:`NativeSession`(原生 H.264/Opus over mesh)与 `WebRtcSession`(WebRTC/SRTP)**互不兼容**。若 Linux 用户要和 Windows/macOS 用户通话,二选一:
   - (a) **有 Linux 参与即全员降级 NativeSession** —— 需 Win/mac 也实现原生采集(屏幕/摄像头),工作量 ~10×,但体验统一;
   - (b) **原生栈仅 Linux↔Linux** —— Win/mac↔Linux 通话不可用(给明确提示)。
   本计划默认 (b)(Linux-first、范围可控),(a) 作为后续可选。**请确认。**
2. **TCP HOL**:实时媒体走 TCP 抖动风险;v1 用独立 drop-oldest 队列缓解,必要时上 QUIC/UDP。
3. **AEC/降噪**:原生栈缺 WebRTC 自带的 AEC/NS/AGC,语音质量风险高,**必须**引入 `webrtc-audio-processing` 等。
4. **编码 CPU / 包体**:`openh264` 软编多路 720p CPU 压力大;包体增量(opus + openh264 + nokhwa + aec);无硬件加速时 mesh 人数受限。
5. **平台缺口**:Win/mac 原生屏幕/摄像头采集未实现(本期靠 WebRTC,不阻塞 Linux-first);Wayland 屏幕采集未实现(仅 X11)。
6. **安全**:loopback WS 仅绑 `127.0.0.1`(参考 `rdp/ws.rs`);媒体帧走现有 mTLS,无需额外加密。
7. **维护成本**:双栈长期维护;原生栈相当于自建小型媒体引擎,持续投入,需评估投入产出。

## 10. 涉及文件

- **后端**:`lanchat/protocol.rs`、`transport.rs`、`mod.rs`、`commands.rs`;新增 `lanchat/media/*`(采集/编码/会话/loopback ws);复用 `servers/rdp/capture/*`;参考 `voice/capture.rs`;`lib.rs`;`Cargo.toml`(新增 `audiopus`/`openh264`/`nokhwa`/`webrtc-audio-processing`,新增可选 feature 如 `native-av`)。
- **前端**:`src/lib/mediaSession.ts`(接口)、`lanRtc.ts`(→ `WebRtcSession`)、新增 `nativeSession.ts`;`lanCallStore.ts`;`components/lanchat/CallOverlay.tsx`;`lib/ipc.ts`;`lib/runtime.ts`;`src/stubs/`。
- **CI**:启用相关 feature 的 Linux 构建依赖(v4l2、openh264 等);`.github/workflows/release.yml`。

## 11. 关联

- 根因与诊断:memory `webkitgtk-linux-webrtc-unavailable`;分支 `fix/lanchat-linux-webrtc-diagnostics`(`src-tauri/src/lib.rs` 读回日志)。
- 原 WebRTC 方案:`lanchat-av-meeting-03.md`(Win/mac 仍沿用)。
- **截图(独立、不依赖 WebRTC,可立即做)**:LanChat 截图发送走 LAN TCP 控制通道,只需在发布构建启用 `screen-capture`(xcap)feature 即可在 X11 下工作(无需 portal);`getDisplayMedia` 在无 ScreenCast portal 的 X11 失败。详见根因 memory。
