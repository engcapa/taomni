# LAN File & Screenshot Transfer(详细拆分)

## What & Why
在内网通讯核心之上增加**点对点文件与截图传输**。用户可在会话中直接把文件/图片/截图发给在线成员或群组,带进度、暂停、取消,体验对标"飞鸽传书"的快速局域网传文件并更现代。文件走节点间直连,不经任何服务器,充分利用局域网带宽。

**关键约束:**
- 复用核心任务(任务 01)建立的 P2P 直连控制通道与成员发现。
- 传输的进度/暂停/取消 UX 参考现有 SFTP 传输队列实现(`transferStore.ts` + `filebrowser/transfer.rs`),保持交互一致。
- **依赖任务 01 完成**(需要控制通道、节点身份、会话外壳与事件总线)。

## Done looks like
- 在与某成员或群组的会话里,可通过按钮、拖拽或粘贴发送文件与图片。
- 可一键截图并直接发送。
- 发送方与接收方都能看到传输进度、速度、预计剩余时间,并可暂停/继续/取消。
- 接收方收到文件后可保存到本地或直接打开;图片在消息流中内联预览。
- 传输大文件时界面保持流畅,断开/取消能干净地终止。
- Web 预览模式下给出"仅桌面版可用"的友好提示。

## Out of scope
- 文字消息、群组、在线状态(任务 01 已交付)。
- 音视频/屏幕共享、白板(任务 03 / 04)。
- 跨网段/公网中转传输、断点续传跨会话恢复(可作后续增强)。

---

## 协议扩展(在任务 01 控制通道之上)
新增帧 `type`(信封同核心):
- `file-offer` — payload: `{transferId, name, size, mime, kind:"file"|"dir", convId, groupId?}`
- `file-accept` / `file-reject` — payload: `{transferId, savePath?}`
- `file-chunk` — payload: `{transferId, seq, data(base64)}`(或独立二进制帧通道,见 1.2)
- `file-progress` — 可选回执(接收端已落盘字节),用于双向进度校正
- `file-pause` / `file-resume` / `file-cancel` — payload: `{transferId}`
- `file-complete` — payload: `{transferId, ok, error?}`

控制元信息走 JSON 帧;**大块数据建议走独立的二进制分块**(参考核心帧的长度前缀,新增 `kind=binary` 标识),避免 base64 膨胀。分块大小默认 64KB,可按 RTT 调整。

---

## Steps(细化)

### 阶段 1 — 后端传输引擎
- 1.1 新建 `src-tauri/src/lanchat/transfer.rs`:每个传输一个 `Arc<LanTransferHandle>`,含 `AtomicBool`(取消)+ `AtomicBool`(暂停)+ `tokio::Notify`(恢复唤醒),镜像 `filebrowser/transfer.rs` 的范式。
- 1.2 发送端:分块读取文件 → 经控制通道发 `file-chunk`(或二进制帧)→ 每块检查暂停/取消 → 进度通过 Tauri 事件 `lanchat://transfer-progress-{id}` 上报。
- 1.3 接收端:收到 `file-offer` 后向前端发来件提示 → accept 后落盘到临时文件、按 seq 写入、校验总大小 → 完成后原子重命名 → 发 `file-complete`。
- 1.4 暂停/继续/取消:控制帧驱动两端状态,暂停时立即发 `lanchat://transfer-paused-{id}` 让 UI 即时翻牌。
- 1.5 多文件:逐个排队;单条 offer 一文件,队列层串/并行可配置(默认串行,避免抢带宽)。
- **验收:** 大文件可在两节点间完整传输,进度/速度/ETA 正确,暂停继续取消都干净生效,落盘文件大小一致。

### 阶段 2 — 文件夹传输(可选增强,与任务 01 行为对齐)
- 2.1 预走目录树计算总字节;逐文件传输,共享 `Arc<AtomicU64>` 聚合进度(参考 SFTP `sftp_upload_dir` 思路)。
- 2.2 在 enqueue 时记录 `kind:"file"|"dir"`,重试路由到正确命令(避免 size==0 误判)。
- 2.3 跳过符号链接与特殊文件;`mkdir` 幂等。
- **验收:** 整个文件夹可传输,进度聚合准确,取消可在深层目录中途及时生效。

### 阶段 3 — 截图与图片
- 3.1 接入桌面端截图捕获(Tauri 命令调用系统截图或内置抓屏),生成临时图片文件。
- 3.2 支持从剪贴板粘贴图片、拖拽图片文件发送。
- 3.3 图片消息在 `MessageThread` 内联缩略图预览,点击查看大图/保存。
- **验收:** 一键截图直接发送;粘贴/拖拽图片可发;接收端内联预览。

### 阶段 4 — 传输队列 UI
- 4.1 新建/扩展前端传输状态(可新建 `lanTransferStore.ts` 或复用范式),按 transferId 跟踪方向/进度/速度/ETA/状态。
- 4.2 在内网通讯界面加传输队列面板(双向列表 + 每项暂停/继续/取消/重试/打开所在目录)。
- 4.3 会话消息流中以"文件卡片"展示传输项,状态实时联动。
- 4.4 来件提示:接收 `file-offer` 时弹出接受/拒绝(可选默认保存目录)。
- **验收:** 队列 UI 与 SFTP 体验一致,所有控制按钮可用且状态实时。

### 阶段 5 — IPC 与 Web 预览桩
- 5.1 在 `src/lib/ipc.ts` 增加 `lanchat_send_file` / `lanchat_accept` / `lanchat_pause` 等命令出口。
- 5.2 `src/stubs/tauri-core.ts` 对所有传输命令返回明确的"浏览器预览不支持"错误;UI 显示友好提示。
- 5.3 `startTransferTracking` 类逻辑确保监听器注册先于任何同步完成事件(参考 SFTP 已知竞态修复)。
- **验收:** Web 预览点击发送文件得到友好提示,不报未捕获错误;桌面版走真实传输。

## Relevant files
- `src-tauri/src/lanchat/transfer.rs`(新增)
- `src-tauri/src/lanchat/protocol.rs`(扩展帧类型)
- `src-tauri/src/lanchat/commands.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/filebrowser/transfer.rs`(范式参考)
- `src/stores/transferStore.ts`(范式参考)
- `src/stores/lanTransferStore.ts`(可选新增)
- `src/components/lanchat/`(传输队列与文件卡片组件)
- `src/lib/ipc.ts`
- `src/stubs/tauri-core.ts`
