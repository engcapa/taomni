# LAN Messenger Core(详细拆分)

## What & Why
为 Taomni 新增一个**去中心化内网通讯模块**(灵感来自"飞鸽传书",但更现代、统一、简化、高性能)。
本任务交付该模块的**核心可用版本**:同网段自动发现在线用户、展示身份与在线状态、收发文字消息(一对一与群组/频道)、本地保存历史、@提及与桌面通知。这是整个内网通讯功能的地基,后续的文件传输、音视频会议、协作白板都建立在它提供的"发现 + 传输 + 界面外壳"之上。

**关键架构约束:**
- 通讯模型为**去中心化 P2P**:无中心服务器,基于 mDNS/DNS-SD(局域网服务发现) + 节点间直连 TCP。
- 模块命名必须与**现有 AI 助手的 `chat` 模块/store/组件区分开**(现有 `chat`、`voice`、`tabvoice`、`asr`、`ai`、`llm` 全部属于 AI 助手)。新模块统一命名:后端 `lanchat`、TabKind `lan-chat`、前端 store `lanChatStore`、组件目录 `src/components/lanchat/`,避免任何符号冲突。
- 桌面版(Tauri)为最终发布目标;Web 预览模式下发现/直连不可用,需提供友好的"浏览器预览不支持"提示,并可用本地 mock 数据供界面可视化。

## Done looks like
- 在菜单栏/侧边栏点击"内网通讯",打开一个新的模块标签页。
- 首次进入时填写个人资料(显示名 + 头像 + 状态签名),资料本地保存并可随时修改。
- 同一局域网内运行 Taomni 的其他用户会自动出现在"在线成员"列表中,显示其显示名、头像、状态签名、在线/离开/离线状态;成员上下线实时更新。
- 可对任意在线成员发起一对一私聊,实时收发文字消息。
- 可创建/加入命名群组(频道),群内成员可群发文字消息。
- 历史消息本地持久化,重开应用后会话与历史仍在。
- 消息中 `@某人` 会高亮,收到提及或新消息时弹出桌面通知并显示未读角标。
- Web 预览模式下打开该标签页时给出清晰的"仅桌面版可用"提示,界面仍可用 mock 数据查看。

## Out of scope
- 文件/截图传输(任务 02)。
- 语音/视频/屏幕共享/会议(任务 03)。
- 协作白板(任务 04)。
- 跨网段/公网通讯、端到端加密的完整密钥体系(本期仅需稳定的本地身份标识,加密可作为后续增强)。

---

## 协议与数据模型(贯穿全任务的契约)

### 节点服务发现(mDNS / DNS-SD)
- 服务类型:`_taomni-lan._tcp.local.`
- 实例名:`<displayName>@<shortUuid>`
- TXT 记录字段:
  - `id` — 节点稳定 UUID(v4,首次启动生成并持久化)
  - `name` — 显示名
  - `avh` — 头像指纹(头像内容 hash 前 16 hex,用于判定是否需要拉取头像)
  - `sig` — 状态签名(截断到 ~60 字符)
  - `st` — 状态枚举:`online` / `away` / `busy`
  - `caps` — 能力位字符串(如 `text,file,av,wb`,供后续任务按位启用)
  - `port` — 本节点 TCP 控制通道监听端口
  - `pv` — 协议版本号(整数,向后兼容判断)

### 节点间控制通道(TCP,长度前缀 JSON 帧)
- 帧格式:`[u32 BE 长度][UTF-8 JSON]`
- 信封:
  ```json
  {
    "v": 1, "type": "<frameType>", "id": "<msgId uuid>",
    "from": "<nodeId>", "to": "<nodeId|groupId|null>",
    "ts": 1730000000000, "payload": { }
  }
  ```
- 本任务用到的 `type`:
  - `hello` / `hello-ack` — 连接握手,交换节点资料与协议版本
  - `ping` / `pong` — 心跳保活
  - `profile-update` — 资料变更广播(name/avatar/sig/status)
  - `avatar-req` / `avatar-data` — 按指纹拉取头像二进制(base64 分片)
  - `text-msg` — 文字消息(payload: `{convId, groupId?, text, mentions:[nodeId]}`)
  - `text-ack` — 送达回执(payload: `{ackOf: msgId}`)
  - `group-announce` — 群组元信息广播(payload: `{groupId, name, members:[nodeId]}`)
  - `group-join` / `group-leave` — 群成员变更
- 预留(后续任务复用,本任务只定义不实现):`file-*`、`signal-*`(A/V)、`wb-*`(白板)。

### 本地持久化(rusqlite,已是依赖)
- 库文件:应用数据目录下 `lanchat.sqlite`
- 表:
  - `profile(id PK, name, avatar BLOB, avatar_hash, signature, status, updated_at)` — 仅本机一行
  - `peers(id PK, name, avatar_hash, signature, last_seen, status)` — 已知节点缓存
  - `groups(id PK, name, created_at)`
  - `group_members(group_id, node_id, PRIMARY KEY(group_id,node_id))`
  - `conversations(id PK, kind TEXT['direct'|'group'], peer_or_group_id, last_msg_at, unread INT)`
  - `messages(id PK, conv_id, sender_id, body, mentions TEXT, created_at, state TEXT['sending'|'sent'|'delivered'|'failed'])`
- 索引:`messages(conv_id, created_at)`、`conversations(last_msg_at)`

---

## Steps(细化)

### 阶段 1 — 后端模块脚手架与依赖
- 1.1 新建 `src-tauri/src/lanchat/`(`mod.rs` + 子模块 `discovery.rs`、`transport.rs`、`protocol.rs`、`store.rs`、`commands.rs`)。
- 1.2 在 `src-tauri/Cargo.toml` 加入:mDNS 库(`mdns-sd`)、`uuid`、`local-ip-address`(枚举本机网卡 IP);`tokio`/`serde`/`rusqlite` 已有。
- 1.3 在 `src-tauri/src/state.rs` 的 `AppState` 增加 `lanchat: Arc<LanChatState>`(持有节点身份、peer 注册表、连接表、sqlite 句柄)。
- 1.4 在 `src-tauri/src/lib.rs` 注册 lanchat 的 Tauri 命令与启动钩子(应用启动时拉起发现/监听任务)。
- **验收:** 桌面版可编译启动,后台启动一个空的 lanchat 服务任务,不影响现有功能。

### 阶段 2 — 节点身份与持久化
- 2.1 首次启动生成稳定 UUID 并写入 `profile` 表;后续读取复用。
- 2.2 资料结构(显示名 + 头像 + 状态签名 + 手动状态),提供读取/更新命令;头像存 BLOB 并计算 hash 指纹。
- 2.3 资料变更时:更新 sqlite → 重发 mDNS TXT → 向已连接节点广播 `profile-update`。
- **验收:** 改资料后重启应用资料仍在;指纹随头像内容变化。

### 阶段 3 — mDNS 发现与节点名册
- 3.1 注册本机服务(TXT 见上),监听网卡变化时刷新。
- 3.2 浏览 `_taomni-lan._tcp.local.`,解析 TXT 入 peer 注册表;按 `avh` 决定是否触发 `avatar-req`。
- 3.3 在线状态推导:mDNS 公告存在 + 心跳新鲜 = online;心跳超时 = away;服务撤销/长超时 = offline。
- 3.4 名册变更去抖后通过 Tauri 事件 `lanchat://roster` 推送前端。
- **验收:** 两台/两实例同网段互相出现在名册;一方退出后另一方在超时后标记离线。

### 阶段 4 — TCP 控制通道
- 4.1 启动 TCP 监听(端口写入 TXT 的 `port`);接受连接后做 `hello`/`hello-ack` 握手。
- 4.2 按需拨号:首次给某节点发消息时建立连接并缓存,去重(同一对节点单连接)。
- 4.3 实现 `protocol.rs` 的帧编解码(长度前缀 + serde_json),错误帧丢弃并记日志。
- 4.4 `ping`/`pong` 保活与断线清理。
- **验收:** 两节点间可建立并复用一条稳定 TCP 连接,断网后能感知并清理。

### 阶段 5 — 文字消息(一对一)
- 5.1 发送:写本地 `messages`(state=sending)→ 经 TCP 发 `text-msg` → 收到 `text-ack` 置 delivered;超时置 failed 可重发。
- 5.2 接收:落库 → 更新会话 last_msg_at/unread → 推前端事件 `lanchat://message`。
- 5.3 消息排序用发送方时间戳 + msgId 去重(防重复投递)。
- **验收:** 一对一消息实时到达,有送达态;断开重连后失败消息可重发。

### 阶段 6 — 群组/频道
- 6.1 群组模型:创建本地群 → `group-announce` 广播给成员;加入/退出发 `group-join`/`group-leave`。
- 6.2 群消息网状扩散:向群内所有已知在线成员逐一发送(去重靠 msgId)。
- 6.3 成员名单经发现/广播同步;成员离线时消息仅本地标记(本期不做离线补投)。
- **验收:** 建群并拉人后,任一成员发言其他在线成员都能收到并入库。

### 阶段 7 — 前端模块外壳
- 7.1 `src/types/index.ts` 增加 TabKind `lan-chat` 及相关类型(Peer、Conversation、LanMessage、LanGroup)。
- 7.2 新建 `src/stores/lanChatStore.ts`(zustand):profile、roster、conversations、messages(按 convId)、unread、当前选中会话。
- 7.3 `src/layouts/MainLayout.tsx` 渲染 `lan-chat` 标签;`MenuBar.tsx`/`Sidebar.tsx` 增加入口(注意 `onNewSession` 包裹箭头函数的已知坑)。
- 7.4 组件 `src/components/lanchat/`:`LanChatPanel`(外壳)、`RosterList`、`ConversationList`、`MessageThread`、`MessageInput`、`ProfileEditor`、`GroupCreateDialog`。
- 7.5 订阅 `lanchat://roster` / `lanchat://message` 事件更新 store。
- **验收:** 标签页可打开,展示名册/会话/消息流,可发消息并实时看到对方回复(桌面版联调)。

### 阶段 8 — @提及与通知
- 8.1 输入框 `@` 触发成员自动补全;消息体记录 mentions 节点列表。
- 8.2 渲染时高亮 `@显示名`;被提及高亮更强。
- 8.3 接入 Tauri 通知插件:非当前会话的新消息/被提及时发桌面通知。
- 8.4 未读统计:每会话未读数 + 全局角标(用于侧边栏/标签)。
- **验收:** 输入 @ 有补全,被 @ 时收到桌面通知与未读角标。

### 阶段 9 — IPC 边界与 Web 预览桩
- 9.1 在 `src/lib/ipc.ts` 收敛 lanchat 全部 `invoke("lanchat_*", …)` 调用(单一出口,桌面/Web 对齐)。
- 9.2 `src/stubs/tauri-core.ts` 为 lanchat 命令提供桩:返回 mock 名册/会话/消息供界面可视化,写操作返回"仅桌面版可用"。
- 9.3 `src/lib/runtime.ts` 检测运行时,前端据此在标签页顶部显示"浏览器预览不支持真实发现/直连"的提示条。
- **验收:** Web 预览能打开标签页、看到 mock 数据与提示;桌面版走真实后端。

## Relevant files
- `src/types/index.ts`
- `src/stores/appStore.ts`
- `src/stores/lanChatStore.ts`(新增)
- `src/layouts/MainLayout.tsx`
- `src/components/menubar/MenuBar.tsx`
- `src/components/sidebar/Sidebar.tsx`
- `src/components/lanchat/`(新增目录)
- `src/lib/ipc.ts`
- `src/lib/runtime.ts`
- `src/stubs/tauri-core.ts`
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/lanchat/`(新增:mod/discovery/transport/protocol/store/commands)
