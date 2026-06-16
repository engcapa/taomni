# LAN Voice/Video/Screen Meetings(详细拆分)

## What & Why
在内网通讯核心之上增加**实时语音、视频、屏幕共享与多人会议**。所有媒体在局域网内点对点直连,信令(SDP/ICE 交换)走核心任务建立的 P2P 控制通道,**无需中心服务器,也无需 STUN/TURN**(局域网内直接使用 host candidate),实现低延迟高性能的内网会议。

**关键约束:**
- 采用 WebRTC(在 Tauri webview 内运行),信令复用任务 01 的节点间直连通道。
- 多人会议采用 mesh(每对参与者一条连接),面向几人到十几人的小规模内网团队。
- 需处理桌面端摄像头/麦克风/屏幕采集的系统权限。
- **依赖任务 01 完成**(需要控制通道做信令、节点身份、会话外壳)。

## Done looks like
- 可对在线成员发起一对一语音或视频通话,对方收到来电提示并可接听/拒接。
- 通话中可开关麦克风/摄像头、共享屏幕(或某个窗口)。
- 可在群组内发起多人会议,参与者以画面平铺展示,可看到谁在说话。
- 通话延迟低、音视频流畅(局域网直连)。
- 退出/挂断能干净释放摄像头、麦克风与连接。
- Web 预览模式下给出"仅桌面版可用"的友好提示。

## Out of scope
- 文字消息、文件传输、白板(任务 01 / 02 / 04)。
- 会议录制、虚拟背景、美颜等高级媒体处理。
- 跨网段/公网会议与 TURN 中转。
- SFU/选择性转发架构(本期固定 mesh)。

---

## 信令协议扩展(在任务 01 控制通道之上)
新增帧 `type`(信封同核心):
- `call-invite` — payload: `{callId, kind:"audio"|"video", convId, groupId?, from}`
- `call-accept` / `call-reject` / `call-cancel` / `call-end` — payload: `{callId}`
- `signal-sdp` — payload: `{callId, peerId, sdpType:"offer"|"answer", sdp}`
- `signal-ice` — payload: `{callId, peerId, candidate}`
- `meeting-join` / `meeting-leave` — payload: `{meetingId, nodeId}`(群会议成员变更广播)
- `media-state` — payload: `{callId, peerId, mic:bool, cam:bool, screen:bool}`(对端开关状态同步)

RTCPeerConnection 配置 `iceServers: []`(空,仅 host candidate),信令全程经 TCP 控制通道转发。

---

## 组件依赖选型与主要技术方案
- **媒体与连接:直接使用 Tauri webview 内置的浏览器 WebRTC API**(`RTCPeerConnection` / `getUserMedia` / `getDisplayMedia`),不引入第三方 WebRTC 库,保持包体精简、mesh 可控。
- **信令封装:自建轻量 `src/lib/lanRtc.ts`**(不采用 `simple-peer`,以贴合我们的 P2P 控制通道与多人 mesh);`iceServers: []` 仅用 host candidate。
- **说话人检测:Web Audio `AnalyserNode`**(浏览器内置,零依赖)。
- **后端:仅做信令帧转发,无新增媒体 crate**。
- **平台权限与风险(主要技术方案需重点处理):**
  - **Windows(WebView2):** WebRTC/采集支持良好,需在 webview 权限请求回调中放行摄像头/麦克风/屏幕。
  - **macOS(WKWebView):** `getUserMedia` 需在 `Info.plist` 声明 `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` 并配置 entitlements;**`getDisplayMedia` 在 WKWebView 支持受限**,屏幕共享可能需以 Rust 端 `xcap` 采集帧 + `canvas.captureStream()` 注入视频轨作为兜底。
  - **Linux(WebKitGTK):** 需确认所装 WebKitGTK 版本已启用 WebRTC;Wayland 下屏幕采集走 PipeWire/portal。
- **理由:** webview 原生 WebRTC 是局域网低延迟直连最省成本的方案;跨平台差异集中在权限与屏幕采集,已标注 `xcap` 兜底路径(与任务 02 复用同一截图库)。

---

## Steps(细化)

### 阶段 1 — 信令打通
- 1.1 后端新增上述信令帧的转发(`src-tauri/src/lanchat/protocol.rs` + `commands.rs`),把收到的 `signal-*` 经 Tauri 事件 `lanchat://signal` 透传给前端。
- 1.2 前端新建 `src/lib/lanRtc.ts`:封装 RTCPeerConnection 生命周期、SDP/ICE 收发、轨道管理;`iceServers` 留空。
- 1.3 建立通道:A 发 `call-invite` → B `call-accept` → 双方互换 `signal-sdp` / `signal-ice` 建连。
- **验收:** 两节点能在局域网内仅凭 host candidate 完成 ICE 连通并建立 RTCPeerConnection。

### 阶段 2 — 一对一音视频
- 2.1 采集:`getUserMedia` 取麦克风/摄像头(audio / video kind 分别处理),处理权限拒绝。
- 2.2 来电 UI:被叫弹出接听/拒接;主叫显示呼叫中/对方忙/无应答。
- 2.3 通话窗口:本地预览 + 远端画面;控制条(静音、关摄像头、挂断),状态经 `media-state` 同步对端。
- 2.4 清理:挂断/拒接/对端断开时停止所有轨道、关闭 PC、释放设备。
- **验收:** 一对一语音与视频均可接通,控制项生效,挂断后摄像头/麦克风指示灯熄灭(设备已释放)。

### 阶段 3 — 屏幕/窗口共享
- 3.1 采集:`getDisplayMedia`(或 Tauri 端屏幕采集桥接),让用户选屏幕或窗口。
- 3.2 作为新视频轨加入现有连接(或 replaceTrack 切换摄像头↔屏幕);对端识别为屏幕流并适配布局。
- 3.3 处理桌面端屏幕采集系统权限(尤其 macOS 录屏授权)。
- **验收:** 通话中可开始/停止共享屏幕,对端实时看到,布局自适应。

### 阶段 4 — 多人会议(mesh)
- 4.1 发起群会议:广播 `meeting-join`,与每位在线参与者两两建立连接(N-1 条 PC)。
- 4.2 加入/退出:新成员加入时与现有成员互建连接;退出时清理对应连接与画面。
- 4.3 画面平铺布局(网格自适应人数)+ 说话人指示(基于音量/`audioLevel`)。
- 4.4 性能护栏:对人数上限给出提示(mesh 适合 ≤ ~8 人),超出时友好提醒。
- **验收:** 3+ 人可入会、互看互听,有人离开画面正确移除,说话人高亮。

### 阶段 5 — IPC 与 Web 预览桩
- 5.1 `src/lib/ipc.ts` 增加信令/通话相关命令出口。
- 5.2 `src/stubs/tauri-core.ts` 对信令命令返回"浏览器预览不支持"提示;来电/会议 UI 显示禁用态。
- 5.3 确保挂断/页面关闭时彻底释放媒体设备,避免设备占用泄漏。
- **验收:** Web 预览不报错并显示友好提示;桌面版可真实通话与开会。

## Relevant files
- `src/lib/lanRtc.ts`(新增,WebRTC 封装)
- `src/lib/ipc.ts`
- `src/stubs/tauri-core.ts`
- `src/components/lanchat/`(来电、通话窗口、会议网格组件)
- `src/layouts/MainLayout.tsx`
- `src-tauri/src/lanchat/protocol.rs`(信令帧)
- `src-tauri/src/lanchat/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/voice/mod.rs`(权限/采集范式参考)
