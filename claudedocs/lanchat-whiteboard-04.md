# LAN Collaborative Whiteboard(详细拆分)

## What & Why
在内网通讯核心之上增加**多人协作白板**,供局域网团队实时一起画图、标注、头脑风暴。画板操作通过核心任务建立的 P2P 通道在参与者之间同步,无需服务器,低延迟。可独立打开,也可在会议中作为协作画布使用。

**关键约束:**
- 绘制操作的同步走任务 01 的节点间直连通道(操作广播 / CRDT 思路),保证多人并发编辑时的一致性。
- **依赖任务 01 完成**(需要控制通道、节点身份、会话外壳);与任务 03(会议)可联动但不强依赖。

## Done looks like
- 可对某成员或群组发起一块共享白板,受邀者加入后看到同一画面。
- 多人可同时绘制:画笔、形状、文字、橡皮擦等基础工具。
- 他人的绘制实时出现,并能看到对方光标位置。
- 多人同时编辑不会互相覆盖丢失,断线重连后画面能恢复一致。
- 白板可独立标签页打开,也可在会议中调出。
- Web 预览模式下给出"仅桌面版可用"的友好提示。

## Out of scope
- 文字消息、文件传输、音视频会议(任务 01 / 02 / 03)。
- 白板导出为图片/PDF、无限历史版本回放等高级功能(可作后续增强)。
- 跨网段/公网协作。

---

## 同步协议与一致性模型(在任务 01 控制通道之上)
新增帧 `type`(信封同核心):
- `wb-open` / `wb-invite` — payload: `{boardId, name, convId, groupId?}`
- `wb-join` / `wb-leave` — payload: `{boardId, nodeId}`
- `wb-op` — payload: `{boardId, op}`,`op` 为单条绘制操作
- `wb-cursor` — payload: `{boardId, nodeId, x, y}`(高频,可节流 ~30ms)
- `wb-snapshot-req` / `wb-snapshot` — 新加入者拉取当前完整状态(全量元素列表)

### 操作模型(CRDT-friendly)
- 每个图元有全局唯一 id:`<nodeId>:<lamport>`,带 Lamport 时钟保证全序。
- 操作类型:`add`(新增元素)、`update`(改属性,如移动/改色)、`delete`(墓碑标记)、`clear`。
- 元素为不可变追加 + LWW(last-writer-wins,以 Lamport 时钟比较)解决并发冲突;删除用墓碑,避免"删除被重加"。
- 新成员加入:请求 `wb-snapshot` 得到当前有效元素全集,之后只接增量 `wb-op`。
- 断线重连:带上本地最大 Lamport,缺口由对端补发或直接重取快照。

---

## 组件依赖选型与主要技术方案
- **渲染:`react-konva`(Konva,新增)** — 图元模型、命中测试、分层与拖拽;自由画笔用 **`perfect-freehand`(新增)** 生成自然笔迹路径。
- **协同一致性:Yjs(`yjs` + `y-protocols`,新增)** — 作为 CRDT 文档与冲突合并,替代手写 Lamport/LWW,更健壮、社区成熟;多人光标用 y-protocols 的 awareness。
- **同步传输:自建 Yjs Provider** — 把 Yjs 的二进制更新(document update / awareness)经核心的 length-delimited 二进制帧在 P2P 通道广播;后端只透传不解析。
- **新成员同步:复用 Yjs 的 state vector + diff** — 天然支持快照/增量,免去自定义 snapshot 协议细节(上文手写快照协议在采用 Yjs 后由其内置机制承担)。
- **后端:仅透传白板二进制帧,无新增 crate**。
- **备选(更轻量):** 若不引入 Yjs,可保留"Lamport + LWW + 墓碑"手写模型,但需自行处理并发合并与重连对账,工作量与风险更高。
- **理由:** Yjs 是去中心化协同的事实标准,可直接复用我们的 P2P 通道做传输,显著降低一致性实现风险;Konva + perfect-freehand 兼顾绘制能力与可控性。

---

## Steps(细化)

### 阶段 1 — 白板画布与绘图工具
- 1.1 新建 `src/components/lanchat/whiteboard/`:Canvas 渲染层(canvas 2D 或轻量库),工具栏。
- 1.2 基础工具:画笔(自由曲线)、直线/矩形/椭圆、文字、橡皮擦、选择/移动、颜色与粗细。
- 1.3 本地状态模型:有序图元列表 + Lamport 时钟,渲染与命中测试流畅(大量图元时分层/脏矩形优化)。
- **验收:** 单机即可顺畅绘制各种图元,工具与撤销/重做(本地)可用。

### 阶段 2 — 操作同步与一致性
- 2.1 本地操作生成 `op` → 经控制通道广播 `wb-op` 给所有参与者。
- 2.2 接收远端 `op` → 按 Lamport/LWW 合并入本地模型 → 重渲染。
- 2.3 快照机制:新加入者发 `wb-snapshot-req`,由任一在场者回 `wb-snapshot`。
- 2.4 并发与重连:墓碑删除 + Lamport 全序;重连后对账补缺。
- **验收:** 多端同时绘制不丢操作、不互相覆盖;新成员加入看到完整画面;断线重连后各端一致。

### 阶段 3 — 会话集成与多人光标
- 3.1 在内网通讯界面发起/加入白板:`wb-invite` → 受邀者 `wb-join`。
- 3.2 支持独立标签页打开(TabKind 复用 `lan-chat` 子视图或新增白板视图),也支持在会议(任务 03)中作为面板调出。
- 3.3 多人光标:广播 `wb-cursor`(节流),显示他人光标与昵称/颜色。
- 3.4 参与者列表与离开清理(`wb-leave` 移除其光标)。
- **验收:** 可邀请并加入白板,实时看到他人光标与绘制;可独立标签或会议内打开。

### 阶段 4 — IPC 与 Web 预览桩
- 4.1 `src/lib/ipc.ts` 增加白板相关命令/事件出口。
- 4.2 `src/stubs/tauri-core.ts` 对白板同步命令返回"浏览器预览不支持"提示;Web 预览可本地单机绘制但不联网。
- **验收:** Web 预览打开白板有友好提示且不报错;桌面版可多人实时协作。

## Relevant files
- `src/types/index.ts`
- `src/stores/appStore.ts`
- `src/stores/lanChatStore.ts`(白板会话状态)
- `src/layouts/MainLayout.tsx`
- `src/components/lanchat/whiteboard/`(新增)
- `src/lib/ipc.ts`
- `src/stubs/tauri-core.ts`
- `src-tauri/src/lanchat/protocol.rs`(白板帧 + Lamport/快照)
- `src-tauri/src/lanchat/commands.rs`
- `src-tauri/src/lib.rs`
