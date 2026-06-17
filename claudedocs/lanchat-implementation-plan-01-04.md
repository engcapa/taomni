# LanChat 去中心化内网通讯模块 — 整体实施计划(任务 01–04)

> 灵感取自飞鸽传书的现代化、统一化内网通讯模块。无中心服务器,mDNS 自动发现 + 节点间 P2P 直连。
> 分支:`feat/lanchat`。

## 实施状态(更新于 2026-06-17)

**任务 01–04 + 三项后续待办全部完成并提交**(每阶段验证后单独提交)。

| 范围 | 状态 | 说明 |
|------|------|------|
| 01 核心通讯 + 弹出独立窗 | ✅ 完成 | 发现/身份/1:1+群消息/@提及+通知/Web 桩/独立窗 |
| 02 文件 / 截图传输 | ✅ 完成 | 文件/文件夹/截图/剪贴板图片 + 暂停/继续/取消队列 |
| 03 音视频会议 | ✅ 完成 | 信令 + 1:1 音视频 + 屏幕共享 + mesh 多人 + 设备释放 |
| 04 协作白板 | ✅ 完成 | Yjs CRDT + react-konva + perfect-freehand + 多人光标 |
| F1 白板高频 op 节流 | ✅ 后续完成 | in-progress 元素入 ref + 本地 preview,共享 doc 写节流 ~10/s + pointer-up 终写 |
| F2 截图兜底 | ✅ 后续完成 | 原生 xcap 失败时回退 `getDisplayMedia`→canvas→PNG(`lanchat_send_image_bytes`) |
| F3 四面边缘抽屉 | ✅ 后续完成 | **应用内 CSS 浮层**(贴 Taomni 窗边):四向 dock + peek 收起/自动隐藏/恢复 + 右键/Esc 关 |

**验证**:`pnpm exec tsc -b --noEmit` ✓ / `cargo check`(无 lanchat 错误或新警告)✓ / `cargo test --lib lanchat` 20 项 ✓ / `pnpm build` ✓。F3 已在浏览器预览交互验证(dock→收起→恢复→关闭,无报错)。

**无头环境无法验证(需真机)**:两实例 mDNS/TCP 实时收发、WebRTC 媒体、多端 CRDT 同步;F1 实时绘制流畅度/降频;F2 `getDisplayMedia` 采帧(macOS WKWebView 支持有限,为该兜底的上限)。

**仍可选的更高保真备选**:F3 的 OS 级 always_on_top/skip_taskbar 贴边悬浮窗(需给 `windowing` 增能力 + 多显示器定位,跨平台成本更高)。

---

## 0. 全局约定(贯穿四个任务)

### 0.1 命名隔离(硬约束)
现有 AI 助手已占用 `chat`/`voice`/`asr`/`ai`/`llm`/`agent`(后端)与 `chatStore`/`aiStore`(前端)。新模块一律用:
- 后端模块 `src-tauri/src/lanchat/`;Tauri 命令前缀 `lanchat_*`
- TabKind `lan-chat`;前端 store `lanChatStore`;组件目录 `src/components/lanchat/`
- 事件命名空间 `lanchat://*`;SQLite 独立库 `lanchat.sqlite`(不混入 `taomni.db`)

### 0.2 范围决策(已确认)
- **弹出独立窗口 → 纳入任务 01**(复用现有 `windowing::open_detached_window` + `DetachedSessionWindow` + `detachedSession.ts` + BroadcastChannel)。✅ 已实现。
- **四面边缘抽屉 → 后置专项任务**(会话头按钮在 01 占位/置灰)。✅ 已作为后续完成(F3),采用**应用内 CSS 浮层**形态(见顶部「实施状态」);占位按钮已接通四向 dock 菜单。

### 0.3 架构脊柱(后端持状态,前端只是视图)
- `AppState.lanchat: Arc<LanChatState>` 持有:节点身份、peer 注册表、连接表、`Mutex<Connection>`(lanchat.sqlite)、传输句柄(02)。
- `setup()` 钩子构建 `LanChatState` 并 spawn 发现 + TCP 监听任务(紧邻现有 `autostart_tunnels`/`autostart_servers`)。
- 所有前端事件 **emit 到全部 webview**(主窗 + 独立窗),这是独立窗口几乎零额外后端成本的前提。
- 会话视图做成**可独立挂载、纯事件驱动的自包含组件**:主窗与独立窗都只是订阅 `lanchat://*` 事件 + 发 `lanchat_*` IPC。

### 0.4 新增依赖汇总(其余全部复用现有)
- **01**:后端 `mdns-sd`、`if-addrs`;`tokio-util` 增 `codec` feature;插件 `tauri-plugin-notification`(+前端 `@tauri-apps/plugin-notification`)。已有:tokio(full)/serde/uuid v4/rusqlite 0.40 bundled/sha2/chrono/tracing/thiserror/anyhow/base64。
- **02**:后端 `xcap`(截图);插件 `tauri-plugin-dialog`(+前端 `@tauri-apps/plugin-dialog`)。剪贴板图片复用已有 `arboard`。
- **03**:无新 crate(webview 原生 WebRTC);前端自建 `src/lib/lanRtc.ts`。
- **04**:前端 `react-konva`、`perfect-freehand`、`yjs`、`y-protocols`;后端仅透传二进制帧。

### 0.5 协议契约(01 定义,02/03/04 只扩展 `type`)
- 发现:mDNS 服务 `_taomni-lan._tcp.local.`,TXT 字段 `id/name/avh/sig/st/caps/port/pv`。
- 控制通道:TCP `[u32 BE 长度][UTF-8 JSON]` 帧;信封 `{v,type,id,from,to,ts,payload}`。
- 二进制大块(文件/媒体/白板):同一 length-delimited 帧,`kind=binary` 标识,避免 base64 膨胀。
- 01 实现 `hello/hello-ack/ping/pong/profile-update/avatar-req/avatar-data/text-msg/text-ack/group-announce/group-join/group-leave`;**预留不实现** `file-*`(02)、`call-*`/`signal-*`/`meeting-*`/`media-state`(03)、`wb-*`(04)。

---

## 任务 01 — 核心通讯 + 弹出独立窗口(地基)

**目标**:同网段自动发现、身份/在线状态、1:1 与群组文字消息、本地持久化、@提及+桌面通知、Web 预览桩、会话弹出独立窗口。02/03/04 全部依赖本任务交付的"发现 + 传输 + 界面外壳 + 事件总线"。

### 阶段 1 — 后端脚手架与依赖 [串行,先行]
- 新建 `src-tauri/src/lanchat/{mod,discovery,transport,protocol,store,commands}.rs`。
- `Cargo.toml` 加 `mdns-sd`、`if-addrs`,`tokio-util` 加 `codec`;`lib.rs` 加 `tauri-plugin-notification`。
- `state.rs` 的 `AppState` 增 `lanchat: Arc<LanChatState>`;`lib.rs` 注册 `lanchat_*` 命令 + `setup()` 内 spawn 空的发现/监听任务。
- **验收**:桌面版可编译启动,后台 lanchat 服务任务空跑,现有功能无回归(`pnpm exec tsc -b --noEmit` + `cargo build`)。

### 阶段 2 — 节点身份与持久化
- `store.rs` 初始化 `lanchat.sqlite`(7 表:profile/peers/groups/group_members/conversations/messages + 索引)。
- 首次启动生成稳定 UUID v4 写 `profile`;资料(显示名+头像 BLOB+sha2 指纹+状态签名+手动状态)读写命令。
- **验收**:改资料重启后仍在;头像指纹随内容变化。

### 阶段 3 — mDNS 发现与节点名册
- `discovery.rs`:`if-addrs` 选播址,注册本机服务(TXT 见 0.5),浏览 `_taomni-lan._tcp.local.`;按 `avh` 决定是否 `avatar-req`。
- 在线状态推导:公告存在+心跳新鲜=online,心跳超时=away,撤销/长超时=offline;名册去抖后经 `lanchat://roster` 推前端。
- **验收**:两实例同网段互相出现;一方退出后另一方超时标记离线。

### 阶段 4 — TCP 控制通道
- `transport.rs`:TCP 监听(端口写入 TXT),`hello/hello-ack` 握手;按需拨号并缓存(同一对节点单连接去重);`ping/pong` 保活与断线清理。
- `protocol.rs`:`LengthDelimitedCodec` + serde_json 信封编解码,错误帧丢弃记日志。
- **验收**:两节点建立并复用一条稳定 TCP 连接,断网可感知清理。

### 阶段 5 — 文字消息(一对一)
- 发送:写本地 `messages`(state=sending)→ 发 `text-msg` → 收 `text-ack` 置 delivered;超时置 failed 可重发。
- 接收:落库 → 更新会话 last_msg_at/unread → 推 `lanchat://message`。发送方时间戳+msgId 去重。
- **验收**:1:1 实时到达,有送达态;断开重连失败消息可重发。

### 阶段 6 — 群组/频道
- 本地建群 → `group-announce` 广播;`group-join/leave` 成员变更;群消息向群内在线成员逐一发送(msgId 去重),离线仅本地标记。
- **验收**:建群拉人后,任一成员发言其他在线成员都收到并入库。

### 阶段 7 — 前端模块外壳(可独立挂载)
- `types/index.ts` 加 TabKind `lan-chat` + 类型(Peer/Conversation/LanMessage/LanGroup)。
- `stores/lanChatStore.ts`:profile/roster/conversations/messages(按 convId)/unread/选中会话。
- `MainLayout.tsx` 按现有 `tabs.filter(t=>t.type==="lan-chat")` 模式渲染**常驻挂载**的 `LanChatPanel`(display 切换);`MenuBar.tsx`/`Sidebar.tsx` 加入口(注意 `onNewSession` 箭头函数包裹坑)。
- 组件:`LanChatPanel`/`RosterList`/`ConversationList`/`MessageThread`/`MessageInput`/`ProfileEditor`/`GroupCreateDialog`;视觉全部复用 `--taomni-*` 变量(原型已对齐)。
- 订阅 `lanchat://roster` / `lanchat://message` 更新 store。
- **验收**:标签页可开,名册/会话/消息流可用,桌面版联调可实时收发。

### 阶段 8 — @提及与通知
- 输入框 `@` 成员自动补全,消息体记 mentions 列表;渲染高亮 `@显示名`(被提及更强,复用 `marked`+`dompurify` 消毒)。
- `tauri-plugin-notification`:非当前会话的新消息/被提及发桌面通知(capabilities 授权)。
- 未读统计:每会话未读 + 全局角标(侧边栏 nav badge / tab)。
- **验收**:@ 有补全,被 @ 收到桌面通知与未读角标。

### 阶段 9 — 弹出独立窗口(本任务并入的范围)
- 会话视图自包含化(阶段 7 已按此设计);后端 `lanchat://*` 事件 emit 到全部 webview。
- `windowing/mod.rs` 的 `validate_kind`/`default_size`/`resolved_title` 加 `lan-chat`(`session_id` 用 convId)。
- `detachedSession.ts` + `DetachedSessionWindow.tsx` 路由 `#lan-chat=<convId>` 渲染独立会话;BroadcastChannel 同步选中/未读(`sftpSync.ts` 为先例)。
- 会话头"弹出独立窗口"按钮接 `open_detached_window`;"边缘抽屉"按钮占位/置灰。
- **验收**:点弹出 → 真实 WebviewWindow 显示该会话,主窗/独立窗消息双向实时;关闭窗口干净回收。

### 阶段 10 — IPC 边界与 Web 预览桩
- `lib/ipc.ts` 收敛全部 `lanchat_*` invoke + `listen<T>("lanchat://...")` 出口(单一边界)。
- `stubs/tauri-core.ts` 加 `lanchat_*` 分支:读操作返回 mock 名册/会话/消息,写操作返回"仅桌面版可用"。
- `lib/runtime.ts` 检测运行时,标签页顶部显示"浏览器预览不支持真实发现/直连"提示条。
- **验收**:Web 预览能开标签、见 mock 与提示、不抛未捕获错误;桌面版走真实后端。

**01 阶段并行性**:1→2→(3‖4 部分可并行)→5→6;7 前端外壳可在 3/4 推进时并行起步(先对 mock/事件契约编程);8/9/10 依赖 7。

---

## 任务 02 — 文件 / 截图传输(依赖 01)

**目标**:会话内 P2P 直传文件/图片/截图,带进度/暂停/取消,接收方保存或打开,图片内联预览。UX 对标现有 SFTP 传输队列。

**协议扩展**:`file-offer`/`file-accept`/`file-reject`/`file-chunk`/`file-progress`/`file-pause`/`file-resume`/`file-cancel`/`file-complete`。控制元信息走 JSON 帧,大块走 `kind=binary` 二进制帧,默认 64KB/块。

### 阶段 1 — 后端传输引擎
- `lanchat/transfer.rs`:每传输一个 `Arc<LanTransferHandle>`,**镜像 `filebrowser/transfer.rs` 范式**(`AtomicBool` cancelled/paused + `tokio::sync::Notify` resume + `wait_while_paused()`;`AppState` 内 register/unregister/cancel/pause/resume)。
- 发送:分块读 → 发 `file-chunk` → 每块查暂停/取消 → 进度经 `lanchat://transfer-progress-{id}` 上报。
- 接收:`file-offer` → 前端来件提示 → accept 后落临时文件、按 seq 写、校验大小 → 原子重命名 → `file-complete`。暂停即时发 `lanchat://transfer-paused-{id}`。
- **验收**:大文件完整传输,进度/速度/ETA 正确,暂停继续取消干净生效,落盘大小一致。

### 阶段 2 — 文件夹传输(对齐 SFTP 行为)
- 预走目录树算总字节;逐文件传,`Arc<AtomicU64>` 聚合进度(参考 `sftp_upload_dir`);enqueue 记 `kind:"file"|"dir"` 避免 size==0 误判;跳过符号链接,`mkdir` 幂等。
- **验收**:整个文件夹可传,进度聚合准确,深层目录中途取消及时生效。

### 阶段 3 — 截图与图片
- `xcap` 截屏生成临时图片;`arboard` 读剪贴板图片;拖拽图片文件发送。
- 图片消息在 `MessageThread` 内联缩略(object URL),点击查看大图/保存。
- **验收**:一键截图直发;粘贴/拖拽图片可发;接收端内联预览。

### 阶段 4 — 传输队列 UI
- 新建 `lanTransferStore.ts`(或复用 `transferStore.ts` 范式),按 transferId 跟踪方向/进度/速度/ETA/状态。
- 内网通讯界面加双向传输队列面板(每项暂停/继续/取消/重试/打开目录);消息流以"文件卡片"实时联动;`file-offer` 弹接受/拒绝(可选默认目录)。
- **验收**:队列 UI 与 SFTP 体验一致,控制按钮全可用且状态实时。

### 阶段 5 — IPC 与 Web 桩
- `ipc.ts` 加 `lanchat_send_file`/`lanchat_accept`/`lanchat_pause` 等;`tauri-plugin-dialog` 选保存路径。
- 桩对传输命令返回"浏览器预览不支持";`startTransferTracking` 类逻辑确保监听器先于完成事件注册(参考 SFTP 竞态修复)。
- **验收**:Web 预览点发送得到友好提示不报错;桌面版走真实传输。

---

## 任务 03 — 音视频会议(依赖 01)

**目标**:1:1 语音/视频通话、屏幕共享、群组 mesh 多人会议。媒体局域网 P2P 直连,信令走 01 控制通道,**无服务器、无 STUN/TURN**(`iceServers:[]`,仅 host candidate)。

**信令扩展**:`call-invite`/`call-accept`/`call-reject`/`call-cancel`/`call-end`/`signal-sdp`/`signal-ice`/`meeting-join`/`meeting-leave`/`media-state`。

### 阶段 1 — 信令打通
- 后端 `protocol.rs`+`commands.rs` 转发 `signal-*`,经 `lanchat://signal` 透传前端。
- 前端 `lib/lanRtc.ts`:封装 `RTCPeerConnection` 生命周期、SDP/ICE 收发、轨道管理,`iceServers:[]`。
- A `call-invite` → B `call-accept` → 互换 `signal-sdp`/`signal-ice` 建连。
- **验收**:两节点仅凭 host candidate 完成 ICE 连通并建立 PC。

### 阶段 2 — 一对一音视频
- `getUserMedia` 取麦/摄(分别处理权限拒绝);来电 UI(接听/拒接)、主叫态(呼叫中/忙/无应答);通话窗(本地预览+远端+控制条),`media-state` 同步开关。
- 清理:挂断/拒接/对端断开停所有轨道、关 PC、释放设备。
- **验收**:语音/视频均可接通,控制项生效,挂断后摄像头/麦克风指示灯熄灭(设备已释放)。

### 阶段 3 — 屏幕/窗口共享
- `getDisplayMedia` 选屏/窗,作为新视频轨加入或 `replaceTrack` 切换;对端识别屏幕流并适配布局。
- ⚠️ **macOS WKWebView `getDisplayMedia` 受限**:兜底用 Rust `xcap`(复用 02)采帧 + `canvas.captureStream()` 注入视频轨。处理 macOS 录屏系统授权。
- **验收**:通话中可开始/停止共享,对端实时看到,布局自适应。

### 阶段 4 — 多人会议(mesh)
- 群会议广播 `meeting-join`,与每位在线参与者两两建连(N-1 条 PC);加入/退出动态建/清连接与画面。
- 画面网格自适应人数 + 说话人指示(WebAudio `AnalyserNode` 音量);人数上限提示(mesh ≤ ~8 人)。
- **验收**:3+ 人入会互看互听,有人离开画面正确移除,说话人高亮。

### 阶段 5 — IPC 与 Web 桩 + 设备释放
- `ipc.ts` 加信令/通话命令出口;桩对信令返回"浏览器预览不支持",来电/会议 UI 禁用态;确保挂断/页面关闭彻底释放媒体设备。
- **验收**:Web 预览不报错显示友好提示;桌面版可真实通话与开会。

**03 跨平台风险(重点)**:Windows WebView2 需权限回调放行摄像头/麦/屏;macOS 需 `Info.plist` 声明 `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` + entitlements,屏幕共享走 xcap 兜底;Linux 需确认 WebKitGTK 已启用 WebRTC,Wayland 屏幕采集走 PipeWire/portal。**建议 03 开工前先做一个三端 `getUserMedia`/`getDisplayMedia` 能力探针 spike**,再决定兜底范围。

---

## 任务 04 — 协作白板(依赖 01,可与 03 联动)

**目标**:多人实时协作白板(画笔/形状/文字/便签/橡皮擦),他人绘制与光标实时可见,多人并发不丢不覆盖,断线重连一致。可独立标签或会议中调出。

**同步扩展**:`wb-open`/`wb-invite`/`wb-join`/`wb-leave`/`wb-op`/`wb-cursor`(节流~30ms)/`wb-snapshot-req`/`wb-snapshot`。后端仅透传二进制帧不解析。

### 阶段 1 — 画布与绘图工具
- `components/lanchat/whiteboard/`:`react-konva` 渲染层(图元模型/命中测试/分层),自由画笔用 `perfect-freehand`;工具栏(选择/画笔/直线/矩形/椭圆/箭头/文字/便签/橡皮擦/颜色粗细)。
- **验收**:单机顺畅绘制各类图元,工具与本地撤销/重做可用。

### 阶段 2 — 协同一致性(Yjs)
- 用 **Yjs(`yjs`+`y-protocols`)** 作 CRDT 文档与冲突合并(替代手写 Lamport/LWW);多人光标用 awareness。
- 自建 Yjs Provider:把 document update / awareness 二进制更新经 01 的 length-delimited 二进制帧 P2P 广播;新成员同步复用 Yjs state vector + diff(免自定义快照协议)。
- **验收**:多端同绘不丢不覆盖,新成员加入见完整画面,断线重连各端一致。

### 阶段 3 — 会话集成与多人光标
- 内网通讯界面发起/加入白板(`wb-invite`→`wb-join`);支持独立标签(`lan-chat` 子视图或新白板视图)与会议(03)内调出;广播 `wb-cursor`(节流)显示他人光标+昵称/颜色;`wb-leave` 清理光标。
- **验收**:可邀请加入,实时见他人光标与绘制,独立标签/会议内均可开。

### 阶段 4 — IPC 与 Web 桩
- `ipc.ts` 加白板命令/事件出口;桩对同步命令返回"浏览器预览不支持",Web 预览可本地单机绘制但不联网。
- **验收**:Web 预览开白板有提示不报错;桌面版多人实时协作。

---

## 跨任务:排期、验证、风险

### 推荐排期
```
01 核心+独立窗 ──┬─> 02 文件/截图
   [必须先扎实]    ├─> 03 音视频(开工前先做三端能力探针 spike)
                  └─> 04 白板
```
02/03/04 全部强依赖 01 的协议契约 + 控制通道 + 会话外壳 + 事件总线;01 落地后 02/03/04 之间无相互依赖,可按资源并行。**01 的协议契约(0.5)、命名隔离(0.1)、Web 桩(阶段 10)是地基中的地基,需在阶段 1–4 一次性定好避免返工。**

### 验证策略(每任务收尾)
- 前端:`pnpm exec tsc -b --noEmit`(快)+ `pnpm test` 相关单测(vitest);新逻辑补 `*.test.ts`。
- 后端:`cargo build`;协议编解码、Lamport/去重等纯逻辑加 Rust 单测。
- 联调:发现/收发需**两个实例同网段**真机验证(mDNS+TCP 无法在单实例 mock 完全覆盖)。
- 清理:验证用的临时文件/截图用后即删。

### 风险登记
- **mDNS / 多网卡 / 防火墙**:Linux 多 NIC 选址、企业防火墙拦 mDNS 或 TCP 端口 → `if-addrs` 选址 + 端口写 TXT + 明确的"未发现节点"诊断态。
- **事件多窗 emit**:独立窗口依赖事件 emit 到全部 webview,01 阶段 9 必须验证主窗/独立窗双向。
- **03 跨平台媒体**:macOS `getDisplayMedia` 受限(xcap 兜底)、Linux WebKitGTK WebRTC 可用性、三端权限声明 → 探针 spike 先行。
- **04 二进制帧背压**:Yjs 高频 update + 光标 30ms 节流,需确认 length-delimited 帧不阻塞控制消息(必要时分流)。
- **跨窗 store 一致性**:detached 会话的未读/选中同步靠 BroadcastChannel,参考 `sftpSync.ts` 已知竞态修复。

### 待你确认的少量选择(实现时遇到再定,不阻塞开工)
- `lanTransferStore` 新建 vs 复用 `transferStore` 范式(倾向新建,隔离 SFTP)。
- 白板独立视图:复用 `lan-chat` 子视图 vs 新增独立 TabKind(倾向 `lan-chat` 子视图)。
- 加密:本期仅稳定本地身份标识,端到端加密作后续增强(out of scope)。

### 建议的落地起点
从 **任务 01 阶段 1(后端脚手架 + 依赖 + AppState 接线 + 空服务 spawn)** 开始,这一步零业务逻辑但锁定模块边界与编译基线,风险最低、收益最大。



