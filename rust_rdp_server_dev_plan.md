# Taomni RDP 服务端开发计划


> *生成时间：2026-05-30 · 基于 ironrdp 0.14 / ironrdp-server 0.10 实查校正，捕获/注入选型参考 RustDesk `libs/scrap`*

---

## 0. 关键结论（先读）

| 维度 | 决策 | 理由 |
|---|---|---|
| 落地形态 | `servers/` 第 10 种服务 `ServerType::Rdp`，进程内纯 Rust（仿 `ssh.rs`，**非** `vnc.rs` 的外部守护进程） | 复用现成 engine/registry/状态事件/auto-stop/DB 持久化，零额外基建 |
| 协议栈 | 给现有 `ironrdp` 0.14 加 `server` + `acceptor` feature（拉入 `ironrdp-server ^0.10`，即 `ironrdp::server`） | **不新增协议 crate**，版本已被 umbrella 锁定 |
| 屏幕捕获 | **直连各平台原生 API**（DXGI / XShm / CGDisplayStream / PipeWire），用干净许可的薄封装 crate；scap/xcap 仅作快速起步与回退 | 参考 RustDesk `libs/scrap` 的成熟做法；scap/xcap 均非成熟组件（scap 0.0.x），不宜作长期主依赖 |
| 输入注入 | `enigo`（X11/Win/macOS）+ Wayland 走 `uinput` / RemoteDesktop portal 双轨 | RustDesk 的 input_service 验证了同一路线（enigo + rdev + uinput/portal） |
| TLS / 证书 | 复用项目已有 `rustls` + 新增 `rcgen` 自签 | 项目已用 rustls（见 `ironrdp-tls`） |
| NLA/CredSSP | 用 `ironrdp-server` 的 `with_hybrid()` + `set_credentials()`，**后期阶段** | 内置即可，先 TLS-only 打通 |

**重要区分：** 本项目 `rdp/` 已存在的是 RDP **客户端**（连出到 Windows 主机、在 canvas 渲染对方桌面，用 `connector`/`session`）。本计划做的是 RDP **服务端**（把*本机*桌面共享给 mstsc 等客户端，用 `server`/`acceptor`）。两者共用 IronRDP 但走相反的一半，代码与状态完全独立，不要混淆。

---

## 0.5 范围与成功标准声明（管理预期）

「全部阶段完成」= 一个**功能完整的自研 RDP 服务端**，定位「内网/受控环境可用」。它**不是** Windows 原生 RDS（`termsrv`）的替代品，也不对标 TeamViewer/AnyDesk 的免配置体验。两条结构性限制贯穿始终：`ironrdp-server` 仍是 0.10 alpha；服务端身份集成的深水区（独立会话、安全桌面、登录屏）**各平台可行性天差地别**，见 §7/§8/§9。

**全平台共性达成（基础能力）：** TLS+NLA 安全连接、实时桌面、键鼠操控、脏区差量、剪贴板互通、完全融入 `servers/` 的 start/stop/状态/持久化。

**能力分级（先看裁决矩阵，细节见后续章节）：**

| 能力 | Windows | Linux X11 | Linux Wayland | macOS |
|---|---|---|---|---|
| 基础：console 镜像 + 操控 | 🟢 好用 | 🟢 好用 | 🟡 GNOME/KDE | 🟡 需双授权 |
| §7 多用户独立会话 | 🔴 客户端 SKU 不可行（EULA） | 🟢 可行（仿 xrdp） | 🟢 可行（每用户无头合成器） | 🔴 不可行（单 GUI 会话） |
| §8 登录屏/锁屏/UAC 捕获 | ⚙️ 重活可行（SYSTEM 服务） | 🟢 虚拟会话天然无此问题 | 🔴 物理 greeter 基本不可行 | 🔴 干净方案不可行 |
| §9 无头（无显示器） | ⛔ 不实现（需 IddCx 驱动，重投入） | 🟢 最干净（Xvfb / headless 合成器） | 🟢 可行（headless 合成器） | ⛔ 不实现（仅假 HDMI dongle） |

> 🟢 可行 · ⚙️ 重活可行（大量平台专属工程） · 🟡 有摩擦 · 🔴 不可行/不干净 · ⛔ 不实现（明确不做）
>
> **一句话定调：Linux 是唯一全绿平台**——「每用户一个无头显示服务器」一个机制同时满足 §7+§8+§9（即 xrdp 模型）。Windows 是「单 console 镜像 + 重投入（SYSTEM 服务）」，**放弃客户端 SKU 的合法多会话、不实现无头**。macOS 最受限：单会话、不实现无头、登录屏几乎无解，**范围收敛到「有人值守、已登录、console 镜像」**。无头支持**仅 Linux 实现**。

---

## 0.6 实现进度（截至 2026-05-30，实查标注）

> 图例：✅ 已完成并验证 · 🟢 已完成（结构性 / `#[cfg]`，未能运行时验证）· 🟡 部分完成 / 脚手架 · ⬜ 未开始 · ⛔ 明确不做（见 §7–§9）
>
> 验证口径：本机为 Linux Mint **X11** 会话（`DISPLAY=:0`），无法交叉编译 Windows/macOS、也无 PipeWire 开发头/Xvfb。故 Linux X11 路径为「编译 + 单测 + 运行时实测」；Windows/macOS 后端仅 `#[cfg]` 结构性代码（`cargo check` 级）；Wayland/无头为脚手架。

| 阶段 | 状态 | 实现要点与差距 |
|---|---|---|
| 阶段 0 脚手架 + 取消桥接 | ✅ | `servers/rdp.rs`；取消桥接用 `event_sender()`+`ServerEvent::Quit`（比计划设想更干净）；`!Send` 的 `run()` 跑在专用 current-thread runtime |
| 阶段 1 真实捕获 | ✅ Linux / 🟢 Win·mac | Linux X11 XShm + 普通 `GetImage` 回退，**运行时实测出帧**；Win(DXGI/WGC)、mac(CGDisplayStream) 仅占位 `bail!`，**未实现** |
| 阶段 2 输入注入 + 坐标 | ✅ Linux / 🟢 Win·mac | enigo(x11rb 后端) + RDP Set-1 扫描码→各平台 keycode 映射（单测覆盖）。**计划修正**：`MouseEvent::Move` 已是屏幕像素,无需 65535 换算 |
| 阶段 3 性能：脏区 + 编码协商 | ✅ Linux X11 / 🟡 其它 | **事件驱动捕获重构（2026-05-30）**：X11 改用 XDamage（`damage`+`xfixes` feature）—— 空闲零回读/零哈希，变化时经 `damage_subtract`+`xfixes_fetch_region` 原子取回精确脏矩形，只回读+编码该区域（参考 RustDesk 模型）。实测（debug 构建，1920×1080）：旧路径每帧固定 ~143ms（95ms 全屏回读 + 49ms 8MB FNV 哈希）⇒ 新路径空闲 0ms、100×40 区域回读 ~0.25ms（约 380× 提升）。60fps 上限、多矩形 >8 时退化为包围盒、无 DAMAGE 时回退原定时全屏轮询。RemoteFX 由库默认协商、rayon 并行编码、库内 `find_different_rects_sub` 再按 64 块裁剪。**差距**：全屏/视频场景仍是全回读（X11 固有）；光标 sprite 未做（见下）；Win/mac/Wayland 仍走全帧轮询 |
| 阶段 4 安全：TLS + NLA | ✅ | rcgen 自签 + `with_tls`/`with_hybrid`(NLA) + 强制凭据 + `0.0.0.0` 告警；**Win11 mstsc 默认 NLA 实测连通** |
| 阶段 5 Wayland 攻坚 | 🟡 脚手架 | 会话检测 + 门户流程文档；输入经 enigo wayland 后端可用。**差距**：无 PipeWire/ashpd 捕获后端（本机无开发头,未集成） |
| 阶段 6 虚拟通道 + 前端 | ✅ / 🟡 音频 | cliprdr **文本**双向桥(arboard) + 前端 RDP 配置卡 + en/zh i18n。**差距**：rdpsnd 音频未实现；剪贴板仅文本（无图片/文件） |
| §7 Linux 多用户独立会话 | 🟡 脚手架 | `session.rs` 能力探测(Xvfb/Xorg/Weston)+ sesman 流程文档。**差距**：无 PAM 网关、无真正 fork 每用户无头后端 |
| §7 Windows/macOS 多会话 | ⛔ | 计划裁定不可行（客户端 SKU EULA / 单 GUI 会话），不做 |
| §8 登录屏/锁屏/UAC | ⬜ | Windows SYSTEM 服务 + 令牌注入 + 桌面切换：**未开始**（投入大,按需再做） |
| §9 无头支持 | 🟡 Linux 脚手架 / ⛔ Win·mac | Linux 与 §7 同机制(探测就绪,网关未做)；Win(IddCx)/mac 计划明确不实现 |
| §10 公网加固 | 🟡 | 已落地：强制 NLA、无凭据拒启/告警、绑定告警(P0/P3 子集)。**差距**：fuzzing CI、fail2ban/限速、MFA、审计录制、真 CA 证书等未做 |

**一句话**：基础阶段 0–6 的 **Linux X11 全链路可用且响应性达标**（连接/桌面/键鼠/剪贴板/TLS+NLA 实测；性能经 XDamage 事件驱动+区域裁剪重构，空闲零开销、增量变化按面积计费，对标 RustDesk/NoMachine 模型并有基准佐证）；Wayland(5)、Linux 进阶会话(7/9)、公网加固(10) 为脚手架/部分；Windows/macOS 捕获注入为结构性代码未运行时验证；§8 与 Win/mac 进阶项未开始或明确不做。

> **遗留增强（按价值排序）**：① 光标 sprite —— X11 `GetImage` 不含硬件光标，应经 `xfixes_get_cursor_image` → `DisplayUpdate::RGBAPointer` 单独下发（客户端本地渲染、不触发位图脏区）；当前因本机无 RDP 客户端无法可视化验证「双光标/行序」风险而暂缓。② 全屏/视频场景的整屏回读优化（DXGI 式硬件脏区在 X11 无对应，可评估 NvFBC/DRI3）。③ Wayland PipeWire 捕获后端。

---

## 1. 落地架构：并入 `servers/`

```
servers/mod.rs        +ServerType::Rdp（枚举 / all() / from_str / as_str）
servers/engine.rs     +ServerType::Rdp => super::rdp::start(ctx, config)
servers/rdp.rs        ← 新增：协议层装配 + 取消桥接（本计划主体）
servers/rdp/          ← 新增子模块：
  ├── display.rs      RdpServerDisplay + RdpServerDisplayUpdates（捕获→脏区→编码）
  ├── input.rs        RdpServerInputHandler（扫描码 / 坐标 → enigo / uinput）
  ├── capture/        平台捕获抽象（#[cfg]）：win.rs(DXGI) / x11.rs(XShm) / wayland.rs(PipeWire) / mac.rs(CGDisplayStream)
  ├── tls.rs          rcgen 自签 + rustls acceptor
  └── auth.rs         凭据校验（config 内的 user/pass，非系统账户）
```

复用而非重造：`ServerCtx`（app/cancel/log）、`set_status`、`server://status|output/<type>` 事件、`spawn_auto_stop`、`save/load_server_config`、`autostart_servers` 全部直接生效。`ServerStarted.pid = None`（进程内，同 ssh）。

**唯一新增的集成难点 —— 取消桥接：** `ironrdp-server::RdpServer::run()` 自带 accept 循环，不感知 `ctx.cancel`。需在 leaf 里用 `tokio::select!` 把 `run()` 与 `cancel.cancelled()` 竞争，或持有 `RdpServerHandle` 走 `ServerEvent` 关停通道。这是 `ssh.rs` 没有的一步，必须在阶段一验证。

---

## 2. 校正后的真实 `ironrdp-server` API（开发基线）

```rust
// 装配（替代两份文档里都不准确的写法）
let server = RdpServer::builder()
    .with_addr(bind_addr)              // SocketAddr
    .with_tls(acceptor)                // 或 .with_hybrid(acceptor, pub_key) / .with_no_security()
    .with_input_handler(RdpInput::new(w, h)?)
    .with_display_handler(RdpDisplay::new(capturer))
    // .with_cliprdr_factory(...) / .with_sound_factory(...) 后期
    .build();
server.set_credentials(Some(Credentials { username, password, domain }));
server.run().await?;                   // ← 用 select! 包住做取消

// 输入：同步方法（非 async！）
impl RdpServerInputHandler for RdpInput {
    fn keyboard(&mut self, event: KeyboardEvent) { /* 扫描码 → enigo */ }
    fn mouse(&mut self, event: MouseEvent)       { /* 65535 网格 → 本地坐标 → enigo */ }
}

// 显示：async-trait
#[async_trait::async_trait]
impl RdpServerDisplay for RdpDisplay {
    async fn size(&mut self) -> DesktopSize { /* 主屏分辨率 */ }
    async fn updates(&mut self) -> anyhow::Result<Box<dyn RdpServerDisplayUpdates>> { /* ... */ }
}

#[async_trait::async_trait]
impl RdpServerDisplayUpdates for Updates {
    async fn next_update(&mut self) -> anyhow::Result<Option<DisplayUpdate>> {
        // 捕获一帧 → 脏区检测 → 无变化返回 Ok(None)
        // 有变化：DisplayUpdate::Bitmap(BitmapUpdate {
        //   x, y, width: NonZeroU16, height: NonZeroU16,
        //   format: PixelFormat::BgrA32, data: bytes.into(),
        //   stride: NonZeroUsize (= width*4) })
    }
}
```

`KeyboardEvent` / `MouseEvent` 的具体 variant 文档未列全，**阶段 0 第一件事是 `cargo doc -p ironrdp-server --open` 锁定枚举定义**，再写映射（别照抄文档里的 `FastPathInputEvent`，那是另一层类型）。

---

## 2.5 捕获 / 注入选型：以 RustDesk 为蓝图（不直接依赖）

> scap（0.0.x）、xcap 均非成熟组件。RustDesk 是生产级 Rust 远程桌面，其自研 `libs/scrap` 久经验证 —— 我们**把它当「该调哪个原生 API、期望什么像素格式」的蓝图，而不是依赖项**（许可证原因，见下）。

### RustDesk 各平台实际做法（实查源码）

| 平台 | RustDesk `scrap` 调用的原生 API | 输出像素格式 |
|---|---|---|
| Windows | **DXGI Desktop Duplication**（`AcquireNextFrame`），失败回退 **GDI** | **BGRA8**（4 B/px） |
| Linux X11 | **XShm / MIT-SHM**（via libxcb，非 `XGetImage`） | BGRA（依显示位深） |
| Linux Wayland | xdg-desktop-portal `ScreenCast` → **PipeWire** → GStreamer `pipewiresrc` | BGRx / RGBx |
| macOS | **CGDisplayStream**（CoreGraphics；未用 ScreenCaptureKit） | BGRA（可选 I420） |

输入注入（在主 app `src/server/`，非 `scrap`）：`enigo`（fork）+ `rdev`。Windows→SendInput，X11→XTest，macOS→CGEvent；**Wayland 双轨**：作为系统服务时走 `/dev/uinput`（evdev + 裸 ioctl），否则走 `org.freedesktop.portal.RemoteDesktop`（`NotifyPointerMotion`/`NotifyKeyboardKeycode`，portal 后端可经 libei）。

### 为什么对我们有利

RustDesk 把 BGRA 喂给 libyuv→VP9（自有协议）；**IronRDP 的 `BitmapUpdate` 恰好要 `PixelFormat::BgrA32`（BGRA）**。捕获层在 BGRA 边界上是**协议无关**的 —— RustDesk 怎么拿到 BGRA，我们就怎么拿，区别只在后端接 IronRDP 而非 VP9 编码器。DXGI 原生提供 dirty rects（`GetFrameDirtyRects`），正中阶段 3 脏区差量下怀。

### 为什么不能直接依赖 RustDesk 代码（硬约束）

1. **未发布**：RustDesk 的 `scrap` **不在 crates.io**；crates.io 上的 `scrap` 是 2018 年原版（quadrupleslap），**不含** DXGI/Wayland/codec。
2. **🔴 许可证红线**：RustDesk 仓库根是 **AGPL-3.0**（`libs/scrap/Cargo.toml` 虽写 MIT，但与仓库 AGPL 存在歧义、且未单独发布）。**Taomni 是 MIT 项目，禁止 vendor AGPL 仓库源码。** 输入注入层在主 app，同为 AGPL。
3. 结论：**只读架构、不抄代码**。

### 我们的实际依赖（干净许可、专门维护）

| 平台/方向 | 首选 crate | 回退 / 备注 |
|---|---|---|
| Windows 捕获 | `windows-capture`（WGC，MIT）或 `windows` crate 直连 DXGI | scap/xcap 起步 |
| X11 捕获 | `x11rb`（XShm，MIT/Apache） | xcap |
| macOS 捕获 | `core-graphics`（CGDisplayStream）/ 评估 `screencapturekit` crate | scap |
| Wayland 捕获 | `ashpd`（portal）+ `pipewire` crate | —— |
| 输入注入 | `enigo`（上游 MIT，0.3） | Wayland：`evdev`/uinput + `ashpd` RemoteDesktop |

用 `trait Capturer` 把这些后端隔离在 `capture/` 下，scap/xcap 作为「先跑起来」的临时实现，逐平台替换为原生后端，不阻塞上层 IronRDP 装配。

---

## 3. 分阶段开发计划（三平台并重）

### 阶段 0 — 脚手架与协议骨架（打通「能连上」） ✅ 已完成
- Cargo：`ironrdp` features 增加 `server`、`acceptor`；新增 `scap`、`xcap`、`enigo`、`rcgen`；`sspi` 暂不加。
- `ServerType::Rdp` 接入枚举三处 + engine dispatch。
- `servers/rdp.rs`：`with_no_security()` + 固定 1920×1080 + 纯色/随机位图 `DisplayUpdate`（照搬官方 example），输入只 log。
- **取消桥接**：`select!(server.run(), cancel)` 验证 stop 能干净退出。
- ✅ 验收：mstsc / FreeRDP 连上，看到刷新的色块；UI 里 start/stop 状态正确翻转。

### 阶段 1 — 真实捕获（三平台 #[cfg] 并行） ✅ Linux X11（实测）/ 🟢 Win·mac（结构性，未实现后端）
- `capture/` 抽象 `trait Capturer { fn next_frame() -> Frame(BGRA, w, h, stride) }`，后端可热替换。
- **起步**：scap（WGC）/ xcap 先在各平台跑通「能出帧」，验证 BGRA→`BitmapUpdate` 链路。
- **目标**：逐平台替换为原生后端（蓝图见 §2.5）—— Windows `windows-capture`/DXGI，X11 `x11rb`+XShm，macOS `core-graphics` CGDisplayStream。
- 接进 `next_update`，先**全屏帧**（不做脏区），BgrA32 直传。注意 BGRA/RGBA 字节序与 stride。
- ✅ 验收：三平台各至少一种环境下，客户端看到真实桌面（允许带宽高、帧率低）。

### 阶段 2 — 输入注入 + 坐标 / DPI ✅ Linux（实测）/ 🟢 Win·mac（结构性）
- enigo 注入键鼠；实现 65535 网格 → 本地坐标换算（Gemini 文档公式正确）：
  `x_local = X_rdp * W_local / 65535`，y 同理。
- **macOS Retina 修正**：SCK 给物理像素，enigo 要逻辑点，需除 `scale_factor`，否则指针大幅偏移（Gemini 文档已指出）。
- 键盘：RDP scancode（set 1）→ enigo `Key`，处理扩展键 / 修饰键。
- ✅ 验收：三平台能远程操作（点击、拖拽、键入、组合键）。

### 阶段 3 — 性能：脏区差量 + 编码协商 ✅ Linux X11 完成（事件驱动+区域裁剪，有基准）
- **X11 事件驱动捕获（已落地）**：弃用「定时全屏轮询 + 8MB FNV 哈希」，改用 **XDamage** —— X 服务器主动告知何时何处变化。`damage_create`(NON_EMPTY) 唤醒 → `damage_subtract` 原子消费进 `xfixes` region → `xfixes_fetch_region` 取回精确脏矩形 → **只 `shm_get_image` 该矩形**。空闲 = 无事件 = 零回读/零哈希/零 CPU。首帧仍发全屏以初始化编码器 framebuffer，之后发裁剪区（库 `find_different_rects_sub` 在该子区按 64 块再 diff，只 RemoteFX 编码变化块）。
- **基准（debug，1920×1080，本机 X11 实测）**：旧每帧固定 ~143ms（95ms 全屏回读 + 49ms 8MB 哈希）⇒ 新空闲 0ms、100×40 区域回读 ~0.25ms。这就是 RustDesk「空闲免费、增量按面积计费」的模型。
- **健壮性**：60fps 上限（连续拖拽/视频）；脏矩形 >8 个退化为包围盒避免多次往返；无 DAMAGE/XFIXES 的服务器（老 Xorg/部分转发连接）自动回退到原定时全屏+哈希路径（`is_event_driven()=false`）。
- 与客户端协商编码：RemoteFX 由库默认协商（`server_codecs_capabilities`），rayon 并行 tile 编码（feature 已启用）。
- 单测：`DamageRect` 并集/裁剪纯函数 + X11 事件驱动运行时端到端测试（首帧全屏、空闲限时返回、区域边界与紧凑 stride 校验）。
- ✅ 验收：静止桌面带宽/CPU 近零（事件驱动空转）；小改动只传小区域；DAMAGE 缺失时优雅回退。

### 阶段 4 — 安全：TLS + NLA ✅ 已完成（mstsc NLA 实测连通）
- `tls.rs`：首启 rcgen 自签证书存 app-data，rustls acceptor；`with_tls` 替换 `with_no_security`。
- `auth.rs` + `set_credentials`：校验 config 内 user/pass（**非系统账户**，与 ssh.rs 同立场）。
- NLA：切 `with_hybrid()` 走 CredSSP；评估是否需要 `sspi`（若内置够用则不加）。
- ⚠️ 安全红线：**默认必须有凭据**；无密码时拒绝启动或显著告警（照 `vnc.rs` 的 `-nopw` 告警先例）。监听 `0.0.0.0` 时在 UI 提示暴露风险。
- ✅ 验收：mstsc 默认安全设置（要求 NLA）可连；弱配置被拒。

### 阶段 5 — Wayland 攻坚（最难，单列） 🟡 脚手架（检测+文档+enigo 输入；无 PipeWire 捕获后端）
- 捕获：`ashpd` 调 `org.freedesktop.portal.ScreenCast` → 拿 PipeWire fd → `pipewire` crate 读流（RustDesk 用 portal+PipeWire+GStreamer，我们可去掉 GStreamer 直读）。验证授权弹窗流程。
- 注入双轨（RustDesk 同款策略）：作为用户会话走 `org.freedesktop.portal.RemoteDesktop`（`NotifyPointerMotion`/`NotifyKeyboardKeycode`，推荐、sandbox 友好）；作为系统服务回退 `/dev/uinput`（`evdev`，需 `input` 组 / root 权限）。portal 后端可经 libei。
- ⚠️ portal 无法查询按键状态，需自行跟踪修饰键状态（RustDesk 的 `ModifierState` 经验）。
- ✅ 验收：GNOME/KDE Wayland 至少一种可看可控，并有清晰的权限缺失提示。

### 阶段 6 — 虚拟通道 & 前端打磨 ✅ 剪贴板(文本)+前端 / 🟡 音频未做
- cliprdr 剪贴板（项目已有 `arboard` + 客户端侧 `cliprdr.rs` 可参考）、可选 rdpsnd 音频。
- 前端：`servers` 面板加 RDP 配置卡（端口默认 3389、bind、user/pass、color depth、viewOnly、是否自签证书），沿用现有 server 配置 UI 模式。
- ✅ 验收：跨机复制粘贴；配置可持久化 + start-on-launch。

---

## 4. 关键风险与攻坚（综合两份文档 + 实查）

| 风险 | 级别 | 说明 / 缓解 |
|---|---|---|
| `scap`/`xcap` 不成熟 | 🟡 中 | **已降级为起步/回退**，不作长期主依赖；`Capturer` trait 隔离，目标态换原生后端（DXGI/XShm/CGDisplayStream，蓝图见 §2.5） |
| 误引入 AGPL 代码 | 🔴 高 | RustDesk 仓库为 AGPL-3.0，**禁止 vendor 其 `scrap`/input 源码**进 MIT 项目；只读架构、用干净许可 crate 自行实现 |
| `ironrdp-server` 0.10 仍 alpha | 🟡 中 | 与 0.14 umbrella 已锁定兼容；trait 可能随版本变，固定版本 + 升级走分支 |
| Wayland 捕获 / 注入沙箱 | 🔴 高 | 单列阶段 5；portal+PipeWire 捕获、portal/uinput 双轨注入；先 GNOME/KDE，headless 走 uinput |
| RDP 扫描码 / 键盘布局映射 | 🟡 中 | scancode → enigo Key 映射易错，需逐键测试扩展键 / IME |
| 取消与 `RdpServer::run()` | 🟡 中 | select! 包裹或 handle 关停；阶段 0 必须验证无僵尸任务 |
| macOS/Wayland 系统授权弹窗 | 🟡 中 | 首启触发，预检 + UI 引导 |
| 安全：误开放公网无认证 | 🔴 高 | 默认 TLS+凭据；`0.0.0.0` 显式告警；参照 vnc 的 nopw 告警 |

---

## 5. Cargo.toml 增量（校正 Claude 文档的 `*` 版本）

```toml
# 在现有 ironrdp 依赖上追加 server/acceptor feature（不新增协议 crate）
ironrdp = { version = "0.14.0", features = [
  "connector", "session", "graphics", "input", "cliprdr", "rdpdr",
  "rdpsnd", "svc", "dvc", "displaycontrol",
  "server", "acceptor",                      # ← 新增
] }

# 捕获：起步态（快速跑通，非长期主依赖）
scap  = "0.0.8"        # 连续帧，先用它出帧
xcap  = "0.9"          # 静态回退

# 输入注入
enigo = "0.3"          # X11/Win/macOS（上游 MIT）

# TLS
rcgen = "0.13"         # 自签证书
# sspi 暂不加：优先用 ironrdp-server with_hybrid 内置 CredSSP；不足再引入
```

目标态（阶段 1 起逐平台替换 scap/xcap 为原生后端，蓝图见 §2.5；全部干净许可，禁止 vendor RustDesk AGPL 源码）：

```toml
[target.'cfg(windows)'.dependencies]
windows-capture = "*"   # WGC，MIT（或用已有 windows crate 直连 DXGI Desktop Duplication）

[target.'cfg(target_os = "linux")'.dependencies]
x11rb   = "*"           # X11 XShm 捕获
ashpd   = "*"           # Wayland portal（ScreenCast / RemoteDesktop）
pipewire = "*"          # Wayland 取流
evdev   = "*"           # Wayland /dev/uinput 注入回退

[target.'cfg(target_os = "macos")'.dependencies]
core-graphics = "*"     # CGDisplayStream；并评估 screencapturekit crate
```

---

## 6. 总体验收标准

- **功能**：三平台原生客户端（mstsc/FreeRDP/移动 RD Client）可连接、看实时桌面、远程操控。
- **安全**：默认 TLS + 凭据；无认证配置被拒或强告警。
- **性能**：静止桌面带宽近零；局域网 1080p 可用帧率。
- **集成**：完全走 `servers/` 既有 start/stop/status/log/auto-stop/持久化，UI 与其余 9 种服务一致。
- **测试**：沿用项目「每个 PDU 编解码带 round-trip 单测」传统；坐标换算、脏区、扫描码映射加单测。

---

## 7. 多用户独立虚拟会话（对标 Windows RDS / xrdp） 🟡 Linux 脚手架 / ⛔ Win·mac 不做

> 目标：每个连入的用户拿到**独立桌面会话**，而非镜像当前 console。这是「基础能力」之外的进阶能力，**仅 Linux 干净可行**。

### Linux — 🟢 可行（标准做法，照抄 xrdp 模型）
- xrdp 架构已验证：`xrdp` 前端（3389）+ `xrdp-sesman`（会话管理器，**PAM 认证**）+ 每用户后端（`Xorg`+`xorgxrdp` 模块，或回退 `Xvnc`）。每个 RDP 连接得到**全新独立**会话，不碰物理 :0。
- 我们的做法：IronRDP 前端替换 `xrdp/libxrdp`；自实现 sesman 角色 —— **PAM 认证 → 按用户 fork 一个后端显示服务器（Xvfb / Xorg-dummy / 或无头 Wayland 合成器，见 §9）→ 捕获该后端 → 桥接输入**。
- ⚠️ 注意：xorgxrdp 路径是 **X11-only**；现代 GNOME 默认 Wayland。要支持 Wayland 目标需走 §9 的无头合成器路径，而非 xorgxrdp。

### Windows — 🔴 客户端 SKU 不可行（EULA + 技术双杀）
- 新建独立交互会话由 Microsoft 私有的 SMSS/LSM/Winlogon/LSASS 机制驱动（私有 ALPC），**无公开 API**让第三方进程「创建一个新交互会话并登录用户 X」。
- 客户端 SKU（Win10/11 Home/Pro）在 `termsrv.dll` 层硬限单交互会话。绕过仅有 **RDP Wrapper** 或 **termsrv 二进制打补丁** —— **违反 EULA**、随累积更新失效、常被杀软报毒。**不做。**
- 合法多会话 = **Windows Server + RDS 角色 + RDS CAL**，且只能作为 RDS 的协议前端，不能自己创建会话。
- **裁决：放弃 Windows 多会话，定位单 console 镜像。**

### macOS — 🔴 不可行
- 仅支持「快速用户切换」，**同一时刻只有一个 GUI 会话占用显示**。无 RDS 式并行独立桌面。
- **裁决：单会话 console 镜像。**

---

## 8. 登录屏 / 锁屏 / UAC 安全桌面捕获（会话隔离） ⬜ 未开始

> 能否在登录界面、锁屏、UAC 提权安全桌面下看到画面并注入输入。

### Windows — ⚙️ 重活可行（RustDesk/TeamViewer 同款 SYSTEM 服务模式）
- **Session 0 隔离**：服务跑在 session 0（SYSTEM），用户桌面在 session 1+，服务**不能直接与用户交互**。
- 标准模式（必须全做）：
  1. 一个 **SYSTEM 权限的 Windows 服务** 作持久网络端点。
  2. `WTSGetActiveConsoleSessionId` 找活跃会话 → 复制令牌 → `CreateProcessAsUser` 把 helper 注入用户会话/桌面。
  3. helper 做 DXGI 捕获，用 `OpenInputDesktop`/`SetThreadDesktop` 跟随桌面切换：Default ↔ Winlogon（登录/锁屏）↔ Secure Desktop（UAC）。
- 🔴 硬约束：**Winlogon/UAC 安全桌面只有 SYSTEM 权限进程能捕获**。不做 SYSTEM 服务则 UAC/锁屏画面黑屏。
- **裁决：可行但代价大** —— 一整套 Windows 专属子系统（服务 + 令牌注入 + 桌面切换跟踪），完全在 IronRDP 之外。列为 Windows 高级阶段。

### Linux — 🟢 虚拟会话天然无此问题 / ⚙️ 物理 greeter 较难
- 走 §7 虚拟会话模型时，**你拥有自己创建的会话**，根本没有「隐藏的锁屏/安全桌面」要对抗 —— 隔离问题被架构消解。
- 捕获**物理 console greeter**（GDM/SDDM :0）：X11 下以 **root** 可行（`x11vnc -auth guess` 类技巧）；**Wayland greeter 基本不可行**（合成器不向外部进程暴露 screencopy）。

### macOS — 🔴 干净方案不可行
- 登录窗口捕获需 root LaunchDaemon + LoginWindow-session LaunchAgent + **第三方拿不到的特殊 entitlements**。Apple 开发者论坛实证：Sonoma/Sequoia 上登录窗口「截屏与输入完全失败」（无用户会话即无 TCC 提示，loginwindow 在受限 Mach bootstrap 命名空间）。
- ⚠️ AnyDesk/TeamViewer 如何做到未公开（疑似私有 entitlements / MDM-PPPC），**不要假设可复制**。
- **裁决：范围收敛到「有人值守、已登录」，不碰登录屏。**

---

## 9. 无头支持（无显示器 / 无显示服务） 🟡 Linux 脚手架 / ⛔ Win·mac 不做

> 没有物理显示器或没有显示服务时如何提供桌面。**仅 Linux 实现**；Windows/macOS 明确不做（见下），无显示器时改用物理假 HDMI dongle 走基础 console 镜像。

### Linux — 🟢 最干净（无头 == 虚拟会话，同一机制）
- X11：`Xvfb`（虚拟帧缓冲）或 `Xorg` + `xf86-video-dummy`（dummy 驱动），在其上起会话再捕获。
- Wayland（wlroots）：`WLR_BACKENDS=headless`（+ `WLR_LIBINPUT_NO_DEVICES=1`）起 sway/cage，经 `wlr-screencopy` 捕获；GNOME/mutter：`mutter --headless --virtual-monitor 1920x1080`；Weston 自带 `headless`/`rdp` 后端。
- ⚠️ GPU 加速无头 Wayland 对驱动敏感（NVIDIA T4 等会失败），软件渲染（llvmpipe）作安全回退。
- **裁决：可行，且与 §7 虚拟会话是同一条路。**

### Windows — ⛔ 不实现
- 技术上**可行但需打包+签名一个 IddCx 虚拟显示驱动**（DXGI 需显示输出可复制；无显示器时 `DuplicateOutput` 无对象可绑，须 IDD 按需插虚拟屏）。
- **决策：不实现。** 理由：驱动签名负担 + 安装易失败 + 渲染异常坑多，重投入不划算。无显示器场景请插**物理假 HDMI dongle** 走基础 console 镜像路径。
- （留档参考方案：RustDesk `RustDeskIddDriver` / amyuni / parsec-vdd；将来确有强需求再评估。）

### macOS — ⛔ 不实现
- 无支持的无头 GUI 模式；WindowServer 需要显示。社区方案仅**假 HDMI dongle**（硬件）、BetterDisplay 或私有 `CGVirtualDisplay`（不稳定、跨版本易碎、未证实可用于服务上下文）。
- **决策：不实现。** 无显示器场景请插物理假 dongle + 已登录用户，走基础 console 镜像。

---

## 10. 公网生产级加固清单（按优先级） 🟡 P0/P3 子集已落地

> 默认部署应是「内网 + 默认 NLA」。若确需公网暴露，至少满足 P0/P1。

- **P0 认证先于资源分配**：强制 NLA/CredSSP，**拒绝 RDP 标准安全与无认证回退**（IronRDP acceptor 支持 `HYBRID`/`HYBRID_EX`，可发 `HYBRID_REQUIRED_BY_SERVER`）。在分配/fork 任何桌面会话前完成 CredSSP —— 这是 **BlueKeep 类（CVE-2019-0708 是 termsrv 预认证 UAF）的核心缓解**。⚠️ IronRDP 服务端 NLA 较年轻（sspi-rs 有 CredSSP 互操作开放问题、acceptor TLS-only 凭据校验曾有 bug），需对 mstsc/FreeRDP/自家客户端广泛实测。
- **P0 内存安全解析面**：Rust 消除 BlueKeep 利用的 UAF/溢出类（注意这是 safe Rust 的属性，非 IronRDP 的官方宣称）。**持续跑 `ironrdp-fuzzing`**（已有 `pdu_decoding`/`channel_processing`/`cliprdr`/`bitmap_stream` 等 target）于 CI，自实现通道补 target。
- **P1 TLS 策略**：仅 TLS 1.2/1.3 + AEAD 套件（rustls 默认即拒绝弱套件，别放宽）。公网用**真 CA 证书**而非自签（自签训练用户点穿警告），自动续期。
- **P1 预认证 DoS 抗性**：认证前不分配会话/大缓冲；限制半开/预认证并发；握手超时；nego 阶段限 PDU 大小。
- **P1 暴力破解防护**：CredSSP 失败的 fail2ban 式 IP 锁定；Linux 直接用 PAM（`pam_faillock`）账户锁定（又一个 PAM-sesman 模型的好处）；按 IP/账户限速 + 指数退避。
- **P2 MFA**：Linux 走 PAM（`pam_google_authenticator`/Duo）；Windows RDP 层 MFA 通常需 CredSSP/AD 或前置网关 —— 不做则记为已知缺口，建议 RD Gateway/VPN/ZTNA 层补。
- **P2 会话生命周期**：空闲超时、最大时长、断开超时（镜像 xrdp `sesman.ini` 的 `IdleTimeLimit`/`DisconnectedTimeLimit`）。
- **P2 审计与录制**：结构化认证审计（who/when/from-IP/result）、会话起止、通道使用；可选会话录制，日志送防篡改汇聚点。
- **P3 暴露面收敛**：绑定具体网卡而非 0.0.0.0；防火墙白名单 3389；**强烈建议前置 VPN/WireGuard/ZTNA** 而非裸暴露。
- **P3 供应链**：固定依赖版本，CI 跑 `cargo audit`/`cargo deny`，签名 Windows IDD 驱动与服务二进制。

---

## 11. 路线图增补（进阶能力的阶段定位） — 进阶项状态见 §0.6

基础能力（§3 阶段 0–6）完成后，进阶能力按平台价值排序，**不强求三平台对齐**：

- **阶段 7（Linux）独立会话 + 无头**：实现 sesman 角色（PAM → fork 无头 X/Wayland 后端 → 捕获）。一步同时拿下 §7+§8+§9，是性价比最高的进阶项。
- **阶段 8（Windows）SYSTEM 服务 + 安全桌面**：服务化 + 令牌注入 + 桌面切换跟踪，解锁锁屏/UAC 捕获。**不含无头**（IddCx 驱动明确不实现，§9）。投入大，仅在确有需求时做。
- **阶段 9 公网加固**：落实 §10 的 P0/P1（如果有公网暴露场景）。
- **macOS**：不投入进阶能力，明确定位「有人值守、已登录、console 镜像」。
