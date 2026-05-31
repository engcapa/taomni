# NewMob RDP 服务端 · 功能清单与任务追踪

> 用途：替代 `rust_rdp_server_dev_plan.md` 做**功能盘点 + 任务追踪**（plan 偏决策/论证，不适合追踪进度）。
> 基线：以源码 `src-tauri/src/servers/rdp/` + 前端 `src/components/servers/settings/RdpSettings.tsx` 为准，对照 plan 实查校正。
> 校正日期：2026-05-31 · 校正环境：Linux Mint **X11**（`DISPLAY=:0`），Win/macOS/Wayland/无头无法运行时验证。

## 状态图例

| 标记 | 含义 |
|---|---|
| ✅ | 已完成，**本机实测**通过 |
| 🟢 | 已完成（仅结构性 `#[cfg]` 代码 / 单测，未运行时验证） |
| 🟡 | 部分完成 / 仅脚手架（检测+文档，无实跑后端） |
| ⬜ | 未开始（或仅有占位 `bail!`） |
| ⛔ | 明确不做（见 plan §7–§9） |

## 一句话现状

基础链路（连接 → 桌面 → 键鼠 → 剪贴板文本 → TLS+NLA）在 **Linux X11 上全链路可用且实测达标**；性能走 XDamage 事件驱动 + 区域裁剪（空闲零开销）。Windows/macOS 捕获后端**实为空壳**（只有 `bail!` 占位，无 `win.rs`/`mac.rs`），输入层有结构性 `#[cfg]` 映射但未运行验证。Wayland、Linux 进阶会话、音频、公网加固为脚手架/未做。

---

# 第一部分 · 功能清单与完成状态

## 1. 服务集成与生命周期 (`rdp.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| `ServerType::Rdp` 接入枚举 | ✅ | `mod.rs` 三处：枚举成员 / `all()` / `from_str` / `as_str`("rdp") |
| engine 分发 | ✅ | `engine.rs:108` → `rdp::start(ctx, config)` |
| 取消桥接（核心难点） | ✅ | `event_sender()` + `ServerEvent::Quit` 干净关停 + `select!` 与 `cancel` 竞争兜底；`!Send` 的 `run()` 跑在专用 current-thread runtime（独立 OS 线程），`spawn_blocking` 把线程 join 桥回 async `JoinHandle` |
| 端口预探测 / 地址解析 | ✅ | 默认 3389；`TcpListener::bind` 预探测使「端口占用/权限」在启动期报错（小 TOCTOU 窗口，同 `iperf.rs`） |
| `0.0.0.0`/`::` 暴露告警 | ✅ | 绑全网卡时记录 WARNING |
| 配置字段解析 | ✅ | `username`/`password`/`domain`/`viewOnly`/`securityMode`/`headlessSession` |
| 复用 servers 基建 | ✅ | `set_status` / `server://` 事件 / `spawn_auto_stop` / 持久化 / autostart 全部直接生效；`pid=None`（进程内，同 ssh） |
| 桌面尺寸 | 🟡 | 客户端上报尺寸由捕获后端探测（X11 真实分辨率）；无后端时回退固定 1920×1080。**未做**客户端 resize/多显示器协商 |

## 2. 安全：TLS + NLA + 凭据 (`tls.rs`, `auth.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| 自签证书生成/缓存 | ✅ | rcgen 自签，存 `<app-data>/rdp-server/{cert,key}.pem`，幂等复用；SAN=localhost+hostname；私钥 `0600` |
| rustls CryptoProvider 安装 | ✅ | 显式装 `ring`（依赖树同时有 ring+aws-lc-rs，否则 `make_acceptor` panic） |
| 三种安全模式 | ✅ | `hybrid`(NLA/CredSSP，默认) / `tls`(无 NLA) / `none`(明文，仅诊断) |
| NLA / CredSSP | ✅ | `with_hybrid(acceptor, pub_key)` + `set_credentials`；**Win11 mstsc 默认 NLA 实测连通** |
| 强制凭据策略 | ✅ | 除 `none` 外缺用户名/密码拒启动；`none` 模式无凭据时大字告警 |
| 单元测试 | ✅ | 自签 cert→`TlsIdentityCtx`→`make_acceptor` 全路径单测；auth 缺失/规范化单测 |

## 3. 屏幕捕获 (`capture/mod.rs`, `capture/x11.rs`, `capture/wayland.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| `Capturer` trait 抽象 | ✅ | `desktop_size` / `capture` / `is_event_driven` / `next_updates`；后端按 `#[cfg]` 热插 |
| X11 抓帧：MIT-SHM | ✅ | 共享内存段 + `shm_get_image`；需 MIT-SHM ≥1.2 |
| X11 抓帧：plain GetImage 回退 | ✅ | SHM 不可用（老 Xorg/转发连接）时逐帧走 X 连接，单测覆盖 |
| X11 事件驱动：XDamage | ✅ | `damage_create(NON_EMPTY)` 唤醒 → `damage_subtract` 原子消费进 xfixes region → `xfixes_fetch_region` 取精确脏矩形 → **只回读该矩形**；空闲零回读/零哈希 |
| X11 区域裁剪 + 健壮性 | ✅ | 首帧全屏播种编码器；>8 矩形退化为包围盒；60fps 上限；无 DAMAGE 自动回退定时全屏轮询 |
| X11 深度/字节序处理 | ✅ | depth24 强制 alpha 不透明；Z_PIXMAP→BgrA32 |
| X11 单测/运行时测 | ✅ | SHM 帧、plain 回退、DAMAGE 首帧全屏+空闲限时、矩形裁剪/并集纯函数 |
| Wayland 捕获 | 🟡 | **仅** session 检测 + 门户流程文档；`try_new` 恒返回 `Err`（无 ashpd/pipewire 后端） |
| Windows 捕获 (DXGI/WGC) | ⬜ | **无 `win.rs`**，仅 `capture/mod.rs` 内 `bail!` 占位 → 回退合成占位帧 |
| macOS 捕获 (CGDisplayStream) | ⬜ | **无 `mac.rs`**，仅 `bail!` 占位 → 回退合成占位帧 |
| 光标 sprite | ⬜ | X11 `GetImage` 不含硬件光标；应经 `xfixes_get_cursor_image`→`DisplayUpdate::RGBAPointer` 单独下发。**未做**（见任务 T-01） |

> 📌 **与 plan 的偏差**：plan §1 架构图列了 `capture/win.rs` `mac.rs`、§5 列了 scap/xcap 起步依赖 —— 实际**都不存在**：直接上 x11rb 原生后端，Win/mac 捕获是空壳。plan §0.6 标 Win/mac 捕获「🟢 结构性」对捕获层属高估（捕获层应为 ⬜，输入层才是真 🟢）。

## 4. 显示下发 (`display.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| `RdpServerDisplay` / `Updates` 实现 | ✅ | `size()` 上报真实分辨率；`updates()` 起捕获流 |
| 捕获线程 + 背压 | ✅ | 专用 OS 线程（后端 `!Send`）；容量 1 的 mpsc 只保最新帧，慢客户端自然背压 |
| 事件驱动下发循环 | ✅ | 转发 XDamage 区域；空 tick 检测客户端断开 |
| 轮询回退下发循环 | ✅ | ~30fps + FNV-1a 去重（无 DAMAGE/合成模式） |
| 帧→`BitmapUpdate` | ✅ | 按区域原点放置，编码器只 diff+RemoteFX 编码变化 tile |
| 合成回退帧 | ✅ | 无捕获后端时循环纯色块，使「失败可见而非致命」 |

## 5. 输入注入 (`input.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| enigo 注入 + view_only 短路 | ✅ Linux | enigo 初始化失败时降级 view-only 并告警一次 |
| 鼠标：移动/三键/侧键/滚轮 | ✅ Linux | `Move` 直接用屏幕像素（plan 65535 换算在 IronRDP 内已做）；侧键 Win/Unix `Back/Forward`，macOS 无此键；垂直/水平/相对滚轮 |
| 键盘：扫描码/Unicode | 🟡 | Pressed/Released(scancode→raw)、Unicode 已做；`Synchronize`（Caps/Num/Scroll 锁定态）**忽略未做** |
| 扫描码映射 Linux | ✅ | evdev+8 主键块 + 扩展键显式表，单测覆盖 |
| 扫描码映射 Windows | 🟢 | scancode 直传 + 0xE0 扩展位，未运行验证 |
| 扫描码映射 macOS | 🟢 | 仅常用键 CGKeyCode 部分映射，未运行验证；**Retina scale_factor 修正未做**（无 mac 捕获暂不阻塞） |

## 6. 剪贴板 (`clipboard.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| CLIPRDR 文本双向 | ✅ | host↔client `CF_UNICODETEXT`：host 轮询线程→`SendInitiateCopy`；client copy→`SendInitiatePaste`→`set_host_text`（arboard） |
| 防回声 | ✅ | 应用 client paste 后记住文本，轮询不回弹 |
| 图片 / 文件传输 | ⬜ | 明确 out of scope（`on_file_contents_*` 空实现） |

## 7. 差量检测 (`diff.rs`)

| 功能 | 状态 | 说明 |
|---|---|---|
| `frame_hash` (FNV-1a) | ✅ | 轮询回退路径去重在用 |
| `changed_tiles` / `TileRect` 瓦片差量 | 🟡 | 已实现 + 单测，但 **`#[allow(dead_code)]` 未接入**（X11 走 XDamage 取脏区，未用瓦片差量）。供无原生脏区后端将来裁剪用，或后续清理 |

## 8. Linux 多用户独立会话 + 无头会话 (`session.rs`) — plan §7/§9

> **结论先行：Linux 多用户/多会话 = ⬜ 未实现（仅能力探测就绪的脚手架）。**
> 当前所有平台**只有「console 镜像」一种模式**——把本机当前已登录的物理桌面(`:0`)共享出去；**多个客户端连入的是同一个桌面**，不是各自独立的会话。plan §7 设想的「每连接一个独立无头桌面」（xrdp 模型）尚未落地。§7（多用户独立会话）与 §9（无头）在 Linux 上是**同一套机制**（PAM → fork 每用户无头显示服务器 → 捕获该 `DISPLAY`），故合并追踪，统一由 T-11 推进。

| 能力 | 状态 | 说明 |
|---|---|---|
| **console 镜像（单共享桌面）** | ✅ Linux X11 | 当前唯一可用模式：共享物理 `:0`，多客户端看到同一桌面、共享同一光标/输入 |
| **多用户独立会话（每连接独立桌面）** | ⬜ | xrdp sesman 模型**未实现**。缺 PAM 认证网关 + 按用户 fork 无头后端 + 会话隔离/回收（见 T-11） |
| **无头会话（无显示器/无显示服务）** | ⬜ | 与上同一机制；后端探测就绪但**无实跑 fork**（见 T-11） |
| 能力探测（前置件，已完成） | ✅ | `probe()` 检测 Xvfb / Xorg(dummy) / weston，`summary()` 输出；纯 PATH 探测不起进程 |
| `headlessSession` 配置接入 | 🟡 | `rdp.rs` 读取该 flag → 打印探测到的能力并**诚实告知「本构建仍镜像 console」**，不假装提供独立会话 |
| Windows / macOS 多用户多会话 | ⛔ | 不做（Windows 客户端 SKU EULA + termsrv 单会话硬限；macOS 单 GUI 会话）。非 Linux `probe()` 恒空 |

> 📌 **一句话**：多用户/多会话目前**没有实现**，只镜像单一 console 桌面。Linux 是唯一可行平台，能力探测脚手架已就绪，真正的 sesman 网关是 **T-11**（性价比最高的进阶项，一步同时拿下 §7 独立会话 + §8 无锁屏隔离问题 + §9 无头）。

## 9. 音频 (rdpsnd)

| 功能 | 状态 | 说明 |
|---|---|---|
| rdpsnd 音频重定向 | ⬜ | 未接 `with_sound_factory`（feature 已启用，无实现） |

## 10. 前端配置 (`RdpSettings.tsx`)

| 功能 | 状态 | 说明 |
|---|---|---|
| RDP 服务配置卡 | ✅ | username / password / domain / securityMode(下拉) / viewOnly |
| 安全提示 | ✅ | `none` 模式不安全告警；其余自签证书提示 |
| i18n | ✅ | en / zh-CN |
| color depth 字段 | ⬜ | plan §6 提及，前端未暴露（后端也未消费） |
| 端口 / bind | ✅ | 走通用 server 配置表单（非 RdpSettings 内） |

## 11. 公网加固 — plan §10

| 功能 | 状态 | 说明 |
|---|---|---|
| P0 强制 NLA / 拒无认证回退 | ✅ | 默认 hybrid；缺凭据拒启 |
| P0 内存安全解析面 | 🟢 | safe Rust 属性；**未持续跑 `ironrdp-fuzzing` CI** |
| P3 绑定告警 | ✅ | `0.0.0.0`/`::` 告警 |
| P1 真 CA 证书 / 自动续期 | ⬜ | 仅自签 |
| P1 预认证 DoS 抗性 / nego 限额 | ⬜ | 未做 |
| P1 暴力破解防护 (fail2ban/限速/退避) | ⬜ | 未做 |
| P2 MFA | ⬜ | 未做 |
| P2 会话生命周期超时 | ⬜ | 空闲/最大时长/断开超时未做 |
| P2 审计 / 会话录制 | ⬜ | 未做 |
| P3 供应链 (cargo audit/deny CI) | ⬜ | 未做 |

---

# 第二部分 · 待办任务清单（任务追踪）

> 优先级：**P1 高价值/低风险** → **P2 平台扩展（投入大）** → **P3 公网/进阶**。
> 勾选即完成。每条含：涉及文件 · 验收口径。

## P1 — 高价值，Linux 现状下即可推进

- [ ] **T-01 光标 sprite（X11）** — *plan §0.6 遗留增强①，价值最高*
  `xfixes_get_cursor_image` → `DisplayUpdate::RGBAPointer` 单独下发，客户端本地渲染，不触发位图脏区。
  · 文件：`capture/x11.rs`、`display.rs`(下发分支)
  · 验收：远程看到硬件光标且无「双光标/拖影」；空闲不因光标移动触发全屏回读。
  · 备注：plan 标注因本机无 RDP 客户端无法可视化验证而暂缓，需一台能跑 mstsc/FreeRDP 的客户端。

- [ ] **T-02 键盘 `Synchronize` 锁定态同步**
  跟踪并对齐 host 的 Caps/Num/Scroll Lock 状态。
  · 文件：`input.rs`(`KeyboardEvent::Synchronize`)
  · 验收：客户端 CapsLock 状态与 host 一致，不出现大小写错乱。

- [ ] **T-03 `changed_tiles` 决策：接入或移除**
  当前瓦片差量是 dead_code。要么接入「无 DAMAGE 回退路径」做捕获侧裁剪，要么删除以消除噪声。
  · 文件：`diff.rs`、`display.rs`(`capture_loop_polling`)
  · 验收：无 `#[allow(dead_code)]` 悬挂；若接入则回退路径也按瓦片裁剪。

- [ ] **T-04 前端 color depth 字段（端到端）**
  前端暴露 + 后端消费（影响带宽/兼容）。
  · 文件：`RdpSettings.tsx`、`rdp.rs`、i18n
  · 验收：可选 16/24/32bpp 并实际生效，持久化。

## P2 — 平台捕获后端扩展（各自独立、投入较大）

- [ ] **T-05 Windows 捕获后端 `capture/win.rs`** — *plan §2.5*
  DXGI Desktop Duplication（`AcquireNextFrame`，原生 dirty rects）失败回退 GDI；输出 BGRA。
  · 文件：新增 `capture/win.rs`、`capture/mod.rs`(windows 分支去 `bail!`)、`Cargo.toml`(`windows`/`windows-capture`)
  · 验收：Windows 上 mstsc 看到真实桌面；利用 `GetFrameDirtyRects` 做脏区。

- [ ] **T-06 macOS 捕获后端 `capture/mac.rs`** — *plan §2.5*
  CGDisplayStream（评估 ScreenCaptureKit）；输出 BGRA。
  · 文件：新增 `capture/mac.rs`、`capture/mod.rs`(macos 分支)、`Cargo.toml`(`core-graphics`)
  · 验收：macOS 上看到真实桌面；**配套 input.rs Retina scale_factor 修正**（物理像素→逻辑点），否则指针偏移。

- [ ] **T-07 Wayland PipeWire 捕获后端** — *plan §5*
  `ashpd` 调 ScreenCast 门户拿 PipeWire fd → `pipewire` crate 读流 → BGRx/RGBx→BGRA。
  · 文件：`capture/wayland.rs`、`Cargo.toml`(`ashpd`+`pipewire`，构建机需 `libpipewire-0.3` 头)
  · 验收：GNOME/KDE Wayland 经授权弹窗后可看；用户拒绝时有清晰提示。

- [ ] **T-08 Wayland 输入修饰键状态跟踪** — *plan §5*
  门户无法查询按键状态，需自行维护 `ModifierState`（配合 T-07）。
  · 文件：`input.rs`
  · 验收：Wayland 下组合键/修饰键不卡死。

- [ ] **T-09 rdpsnd 音频重定向** — *plan §6*
  `with_sound_factory`，host 音频→client。
  · 文件：新增 `rdp/sound.rs`、`rdp.rs`(builder)
  · 验收：客户端听到 host 声音；可开关。

- [ ] **T-10 剪贴板图片/文件** — *plan §6*
  扩展 CLIPRDR 支持 `CF_BITMAP`/`CF_DIB` 及文件传输。
  · 文件：`clipboard.rs`
  · 验收：跨机复制图片/文件成功。

## P2 — Linux 进阶会话（一机制同时拿下 §7+§8+§9）

- [ ] **T-11 Linux sesman 实跑网关** — *plan §7/§9，性价比最高的进阶项*
  PAM 认证 → 按用户 fork 无头后端（Xvfb / Xorg-dummy / headless Weston）→ 捕获该 `DISPLAY` + 桥接输入 → 断开时回收。
  · 文件：`session.rs`(实跑) + 新增 PAM 网关、`rdp.rs`(headlessSession 真实分支)、`Cargo.toml`(`pam`)
  · 验收：每连接得独立桌面会话，不碰物理 `:0`；无头机（无显示器）可用。
  · 备注：探测已就绪（`probe()`），缺 PAM + fork 监督。

## P3 — 公网生产级加固（仅在确有公网暴露场景时做）— plan §10

- [ ] **T-12 P0 fuzzing CI** — 持续跑 `ironrdp-fuzzing`（pdu/channel/cliprdr/bitmap）于 CI，自实现通道补 target。
- [ ] **T-13 P1 真 CA 证书 + 自动续期** — 公网用真证书替自签，自动续期。 · `tls.rs`
- [ ] **T-14 P1 预认证 DoS 抗性** — 认证前不分配会话/大缓冲；限半开并发；握手超时；nego 限 PDU 大小。
- [ ] **T-15 P1 暴力破解防护** — CredSSP 失败 fail2ban 式 IP 锁定 + 按 IP/账户限速 + 指数退避（Linux 可借 PAM `pam_faillock`）。
- [ ] **T-16 P2 会话生命周期** — 空闲超时 / 最大时长 / 断开超时（仿 xrdp `sesman.ini`）。
- [ ] **T-17 P2 MFA** — Linux 走 PAM（TOTP/Duo）；Windows 记为已知缺口（建议 RD Gateway/VPN/ZTNA）。
- [ ] **T-18 P2 审计 + 可选会话录制** — 结构化认证审计(who/when/from-IP/result) + 会话起止/通道使用；日志送防篡改汇聚点。
- [ ] **T-19 P3 供应链** — CI 跑 `cargo audit`/`cargo deny`，固定依赖版本。

## ⛔ 明确不做（记录在案，避免重复评估）— plan §7–§9

- **Windows 多用户独立会话** — 客户端 SKU EULA + termsrv 单会话硬限；合法多会话=Server+RDS+CAL。
- **Windows 无头 (IddCx 虚拟显示驱动)** — 签名负担 + 安装易失败；无显示器请插物理假 HDMI dongle。
- **Windows §8 SYSTEM 服务 / 安全桌面捕获** — 技术可行但投入巨大（服务+令牌注入+桌面切换），仅在确有强需求时再评估（plan 列为高级阶段，当前不做）。
- **macOS 无头** — WindowServer 需显示；社区方案仅假 dongle/私有 API，不稳定。
- **macOS 登录屏/锁屏捕获** — 需第三方拿不到的特殊 entitlements，干净方案不可行。

---

## 附：模块文件索引

| 文件 | 行数 | 职责 |
|---|---|---|
| `rdp.rs` | 333 | 装配 + 取消桥接 + 安全模式 + 启动校验 |
| `rdp/auth.rs` | 77 | 凭据策略（config 内，非系统账户） |
| `rdp/tls.rs` | 147 | rcgen 自签 + rustls acceptor |
| `rdp/display.rs` | 297 | `RdpServerDisplay` + 捕获线程 + 事件/轮询双循环 |
| `rdp/input.rs` | 315 | enigo 键鼠注入 + 扫描码映射(三平台) |
| `rdp/clipboard.rs` | 276 | CLIPRDR 文本双向桥 |
| `rdp/diff.rs` | 175 | frame_hash(在用) + changed_tiles(dead_code) |
| `rdp/session.rs` | 121 | Linux 多用户/无头会话能力探测（脚手架，未实现 fork 网关） |
| `rdp/capture/mod.rs` | 128 | `Capturer` trait + 平台路由 |
| `rdp/capture/x11.rs` | 828 | X11 SHM/GetImage + XDamage 事件驱动 + 区域裁剪 |
| `rdp/capture/wayland.rs` | 56 | Wayland 检测 + 门户流程文档（无后端） |
| 前端 `RdpSettings.tsx` | 65 | RDP 服务配置卡 |
