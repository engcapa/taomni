# RDP Server 与 Windows 远程桌面对齐 详细设计

## 1. 设计摘要与范围

- 类型：现有能力扩展（本地服务器 → RDP Server）
- 文档位置：`docs-feature/rdp-server-parity-design.md`
- 设计状态：可实施（P0 起步；性能预算数值待 P0 基线测量后回填，见 DEC-04）
- 来源：用户 2026-10-01 需求“RDP server 功能与 Windows 远程桌面 server 对齐，三端支持，含 Windows 系统远程桌面分支、复制粘贴、文件传输、声音、工具栏，按 qa-ui-auto 规范写 browser/native 用例，在 GitHub runner 准备 fixture 并循环修复直到功能和性能达标”，以及同日 4 项范围决策（DEC-01~04）
- 调研基线：`main` 23882563（2026-10-01），开发分支 `feat/rdp-server-parity`
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行
- 本轮真机执行端：GitHub hosted runner（Ubuntu 24.04 x64 / Windows Server 2025 x64 / macOS 15 ARM64，经 `qa-ui-auto-platforms.yml`）为主，本地 Windows 11 开发机做构建与 Rust/Vitest 迭代
- 推荐方案：保留现有“镜像控制台桌面”的 IronRDP 进程内服务器，补齐 CLIPRDR 富格式与文件、RDPSND 播放、MS-RDPEAI 麦克风、自动检测（连接质量）、Windows 系统远程桌面分支；Taomni RDP 客户端补齐 mstsc 式全屏连接栏；新增可脚本化的 `rdp-probe` 探针客户端作为三端 CI 的协议级 oracle 和性能测量工具，并在 Windows runner 上以系统 TermService 为性能基线

用户在本机用 mstsc / FreeRDP / Taomni 客户端连接 Taomni RDP Server 时，应得到与连接 Windows 自带远程桌面一致的日常体验：双向复制粘贴文本、富文本、图片和文件，听到被控端声音，客户端麦克风能被被控端应用录到，客户端连接栏能显示连接质量；在 Windows 上，若系统远程桌面已经可用，Taomni 引导用户直接使用系统能力，只有用户明确确认后才启动 Taomni 的服务器。本轮不做被控端浮动会话条、驱动器/打印机/智能卡/USB 重定向、独立会话（锁定控制台）、系统账号认证、Windows 安全桌面（UAC/锁屏）穿透、多显示器拼接与动态分辨率（见 DEC-06~09）。

## 2. 当前实现与功能缺口

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src-tauri/src/servers/rdp.rs` `start`/`build_server` | NLA(CredSSP over TLS) 唯一安全模式；凭据来自 vault；默认绑定 127.0.0.1，绑定 0.0.0.0 需 `allowPublicBind`；单客户端；首个输入触发本机控制授权（30 s）；仅查看模式；macOS 实验 AVC420/客户端尺寸 | 增加 sound factory、AUDIO_INPUT DVC、autodetect、剪贴板策略参数；保持全部现有安全行为 | 源码，确定 |
| `src-tauri/src/servers/rdp/clipboard.rs` | CLIPRDR 仅 `CF_UNICODETEXT` 双向；后台线程轮询 arboard 文本 | 扩展 HTML、图片、文件（FileGroupDescriptorW + FileContents）及方向/级别策略 | 源码，确定 |
| `src-tauri/vendor/ironrdp-server` 0.13（打过补丁） | 已有 CLIPRDR、RDPSND（`with_sound_factory`，未被调用）、DisplayControl、Echo、AInput 桩、EGFX、RTT autodetect（`enable_autodetect`，未被调用）；DVC 集合在 `server.rs` 内固定 | 新增可注入额外 DVC（AUDIO_INPUT）的构建器入口；补 Network Characteristics Result 下发 | 源码，确定 |
| `ironrdp-cliprdr` 0.7 / `ironrdp-rdpsnd` 0.9 / `ironrdp-pdu` 0.9 | 文件内容请求/响应、锁、文件列表均已支持；RDPSND 服务端协商/Wave/音量；autodetect PDU 含带宽测量 | 直接复用 | crate 源码，确定 |
| MS-RDPEAI（AUDIO_INPUT） | IronRDP 与 Taomni 均无实现 | 服务端与探针各自新增 PDU 编解码 | 全仓搜索，确定 |
| `src-tauri/src/servers/rdp/capture/*`、`display.rs`、`input.rs` | 三端采集（X11 SHM+XDamage / Wayland portal / SCK / WGC+GDI）；扫描码+Unicode 键盘、鼠标、横竖滚轮 | 性能调优对象；功能保留 | 源码，确定 |
| `src/components/servers/settings/RdpSettings.tsx`、`src/stores/serversStore.ts` | 采集能力提示、显示器、权限按钮、凭据、仅查看、控制授权、公网绑定 | 增加 Windows 系统远程桌面面板、剪贴板/声音/麦克风设置、启动前确认 | 源码，确定 |
| `src/components/rdp/RdpPanel.tsx` + `floating-toolbar` | 浮动工具栏：重连、缩放、视图切换（全屏）、分离、AI 对话 | 增加 mstsc 式全屏连接栏（固定/自动隐藏、连接质量、标题、Ctrl+Alt+Del、最小化、还原、断开） | 源码，确定 |
| `src-tauri/src/rdp/*`（Taomni RDP 客户端） | 已支持 CLIPRDR 文本/文件、RDPSND 播放、RDPDR；未处理 Network Characteristics Result；无麦克风 | 连接栏所需的连接质量数据；麦克风客户端不在本轮范围 | 源码，确定 |
| QA：`F-Servers-1`、`TC-auto-F-Servers-1`、`TC-111` | 仅窗口外观冒烟；无 RDP server native 用例、无探针、CI 无音频设备 | 新增 fixture、verb、helper、CI 供给与用例 | `qa-ui-auto-tests/`、`ci_*.py`，确定 |
## 3. 验收条件

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-01 | Windows，系统远程桌面已启用且 TermService 正在监听 | 打开 RDP 设置；点击启动 Taomni RDP | 面板显示“系统远程桌面已运行（端口 N，NLA 开/关）”与“建议直接用系统远程桌面”；启动前弹确认，取消则不启动；确认后若端口与系统冲突，自动建议 3390 并在日志说明 | Windows |
| AC-02 | Windows，系统远程桌面未启用，版本支持 | 打开 RDP 设置 | 管理员：显示开启步骤与“打开系统设置”按钮（`ms-settings:remotedesktop`）；非管理员：说明需要管理员；启动 Taomni 前同样需要确认 | Windows |
| AC-03 | Windows 家庭版（不含 RDP 主机） | 打开 RDP 设置并启动 | 说明系统不支持远程桌面主机，无需确认即可使用 Taomni | Windows |
| AC-04 | 用户已确认使用 Taomni，`startOnLaunch=true` | 重启应用 | 自动启动 Taomni RDP；未确认时不自动启动并记录原因 | Windows |
| AC-05 | 非 Windows | 打开 RDP 设置 | 不显示系统远程桌面面板，启动流程与现状一致 | macOS、Linux |
| AC-06 | 客户端已连接，剪贴板方向级别允许 | 任一端复制文本（含 CJK、emoji、4 MB 以内） | 另一端粘贴得到相同文本；超限不传并记录 | 三端 |
| AC-07 | 同上 | 任一端复制 HTML 片段 | 另一端得到 HTML（CF_HTML ↔ 宿主 HTML）及纯文本回退 | 三端 |
| AC-08 | 同上 | 任一端复制图片 | 另一端得到像素一致的图片（CF_DIB/CF_DIBV5 ↔ 宿主图片），尺寸上限内 | 三端 |
| AC-09 | 同上，级别为 all | 客户端复制文件/文件夹（含嵌套与 Unicode 名） | 传输完成后被控端剪贴板为暂存目录中的文件列表，SHA-256 一致；超过总量上限拒绝并记录；断开时清理未完成暂存 | 三端 |
| AC-10 | 同上 | 被控端复制文件/文件夹 | 客户端可获取大小与任意区间内容，SHA-256 一致；仅能读取已公告文件 | 三端 |
| AC-11 | 剪贴板方向级别为 off/text/rich | 复制被禁止的格式 | 该格式不公告、不传输；允许的格式仍可用 | 三端 |
| AC-12 | 声音播放开启，客户端请求 RDPSND | 被控端播放声音 | 客户端收到 PCM，主频与源一致；无客户端或关闭时不采集 | 三端（macOS 需 13+） |
| AC-13 | 麦克风开启，被控端存在可用虚拟输入 | 客户端经 AUDIO_INPUT 发送声音 | 被控端应用从虚拟麦克风录到相同主频；缺设备时拒绝通道并在设置页给出安装指引 | Linux 原生；Windows 需 VB-CABLE 类驱动；macOS 需 BlackHole 类驱动 |
| AC-14 | 客户端支持网络自动检测 | 连接建立及会话期间 | 服务端发送 RTT/带宽测量与 Network Characteristics Result；探针和 mstsc 可得到连接质量 | 三端 |
| AC-15 | Taomni 客户端全屏连接 | 鼠标靠近顶端/快捷键；固定、最小化、还原、断开、Ctrl+Alt+Del | 出现顶部居中连接栏：固定后常驻、未固定 2.5 s 后隐藏；质量指示与 RTT 提示；各按钮生效且键盘可达 | 三端 |
| AC-16 | 同一 Windows runner，同一探针 | 分别连接 TermService 与 Taomni，执行性能场景 | 指标满足 §4.7 预算（相对 TermService 与绝对值）；其他两端满足绝对预算 | 三端 |
| AC-17 | 既有行为 | 启停、NLA/vault、控制授权、仅查看、单客户端、绑定安全、客户端既有工具栏 | 全部保持 | 三端 |
| AC-18 | 设置持久化 | 修改剪贴板/声音/麦克风/系统远程桌面选择并 Apply | 重开窗口后保持；默认值安全 | 三端 |
| AC-19 | 联合：同一 QA 应用内启动 Taomni Server，再用 Taomni 客户端会话连接 127.0.0.1 | 连接、在客户端画布点击宿主目标、全屏、断开 | 客户端显示远端画面；点击经 RDP 注入宿主（目标窗口翻色并写状态文件）；全屏连接栏显示 Taomni Server 下发的连接质量；客户端与服务端共用系统剪贴板时 5 s 内公告次数有界、不形成循环；断开后服务端回到等待状态 | 三端 |
| AC-20 | 客户端 ↔ 参考服务器（Windows runner TermService、Linux runner xrdp） | 连接、全屏 | 画面与输入正常；连接栏与质量指示可用（服务器提供数据时显示等级，否则显示未知） | Windows、Linux |

失败与恢复：音频/麦克风/剪贴板子系统初始化失败只降级该通道并写日志，不得让 RDP 监听失败；客户端断开时取消所有采集、传输与暂存。
## 4. 方案与关键决策

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论及理由 | 状态 | 决策来源 | 关联 |
|---|---|---|---|---|---|
| DEC-01 “工具栏”对齐哪一端 | 两端都做 / 仅被控端浮条 / 仅客户端连接栏 | 仅客户端连接栏：Taomni RDP 客户端做 mstsc 式全屏连接栏；被控端不新增浮条（保留现有控制授权弹窗） | 用户已定 | 2026-10-01 AskUserQuestion | AC-15、TASK-10、V-11/V-12 |
| DEC-02 文件传输范围 | 剪贴板文件 + RDPDR 驱动器 / 仅剪贴板文件 | 仅剪贴板文件双向复制粘贴，不实现服务端 RDPDR | 用户已定 | 同上 | AC-09/10、TASK-06、V-06 |
| DEC-03 声音范围 | 仅播放 / 播放 + 麦克风 | 播放 + 麦克风；麦克风在 Windows/macOS 依赖虚拟声卡驱动，三端体验无法完全一致，需检测与指引 | 用户已定 | 同上 | AC-12/13、TASK-07/08、V-08/V-09 |
| DEC-04 性能达标标准 | Windows TermService 基线 + 三端绝对预算 / 仅绝对预算 | 以 Windows runner 上同一探针测得的 TermService 为基线；三端绝对预算在 P0 首轮基线测量后写入 §4.7，此后超出即不达标，不得回调预算 | 用户已定 | 同上 | AC-16、TASK-03/11、V-13 |
| DEC-05 Windows 系统远程桌面分支 | 自动帮用户开启系统 RDP（需提权、改系统设置） / 只检测+指引+确认 | 只检测、提示与打开系统设置页，不修改系统配置；用户确认使用 Taomni 后记住选择（`systemRdpChoice`），面板可重置 | agent 自决（用户需求原文规定了“检测→提示→确认”流程） | 需求原文；修改系统服务属高风险操作 | AC-01~04、TASK-04 |
| DEC-06 会话模型 | 镜像控制台（现状） / Windows 式独立会话并锁定控制台 | 保留镜像控制台：Windows 客户端 SKU 只能一个交互会话，macOS 无公开 API，Linux 独立会话需 PAM+虚拟 X（`session.rs` 已有规划但非本轮） | agent 自决 | 平台能力 | §1 范围外 |
| DEC-07 认证方式 | 系统账号 / 配置账号（现状） | 保留 vault 中的配置账号：NLA 的 NTLM 校验需服务端掌握口令或哈希，只有 Windows 原生 SSPI 能校验系统账号，三端无法一致 | agent 自决 | CredSSP/NTLM 机制 | AC-17 |
| DEC-08 Windows 安全桌面（UAC、锁屏） | SYSTEM 服务组件 / 不支持 | 本轮不支持并在设置页注明：需要安装常驻 SYSTEM 服务，属单独的高风险特性 | agent 自决 | 用户态采集/注入无法进入 Winlogon 桌面 | §10 |
| DEC-09 多显示器拼接、动态分辨率 | 本轮做 / 延后 | 延后：不在用户列举项内且三端采集改动大；保留现有单显示器选择 | agent 自决 | 范围控制 | §10 |
| DEC-10 剪贴板策略模型 | 单一开关 / 按方向分级 | 按方向分级 `off | text | rich | all`（rich=文本+HTML+图片，all=再加文件），对应 Windows“限制剪贴板传输”组策略的分级思想；默认两方向 `all` 与 Windows 默认一致 | agent 自决 | Windows 组策略 | AC-11、TASK-05 |
| DEC-11 客户端→被控端文件的落地方式 | 延迟渲染（粘贴时才拉取） / 复制时立即拉取到暂存目录后写入宿主剪贴板 | 立即拉取：arboard 不支持三端统一的延迟渲染；有总量上限（默认 2048 MiB，可配置），超限拒绝 | agent 自决 | arboard 3.6 API | AC-09 |
| DEC-12 音频编码 | PCM / ADPCM / Opus | PCM 16-bit 48 kHz 与 44.1 kHz 立体声；所有客户端都支持，局域网带宽可接受；压缩格式后续按性能结果再议 | agent 自决 | MS-RDPEA 兼容性 | AC-12 |
| DEC-13 测试与性能 oracle | FreeRDP CLI / mstsc 自动化 / 自研 `rdp-probe` | 自研 Rust `rdp-probe`（复用已有 ironrdp 依赖）做三端可脚本化 oracle 与测量；mstsc 在 Windows runner 做兼容性冒烟；外部 OS 工具做宿主剪贴板/音频判定，避免同一库自证 | agent 自决 | 可控性、三端一致 | §7、TASK-01/02 |
| DEC-14 测试拓扑 | 仅探针 / 探针 + Taomni 客户端联合 + 参考服务器 | 三层：①探针 ↔ Taomni Server（协议级判定与性能）；②Taomni 客户端 ↔ Taomni Server 联合测试（同一 QA 应用内服务端与会话标签页，覆盖画面、输入、连接栏、连接质量、声音、剪贴板防回环）；③Taomni 客户端 ↔ 参考服务器（Windows runner 的 TermService、Linux runner 的 xrdp），验证客户端连接栏与质量指示对真实服务器有效 | 用户已定（2026-10-01 追加提示：workflow 中准备 rdp server/client 测试 fixture，并联合测试 server 与 client） | 用户消息 | §4.8、§7 V-18~V-21、TASK-02/12 |
| DEC-15 同机回环的剪贴板 | 联合测试关闭剪贴板 / 加防回环判定 | 服务端对“刚写入宿主的内容”按方向记录指纹（文本/HTML/图片哈希、文件描述符列表），客户端回传相同内容时不再落地，从而在客户端与服务端共用系统剪贴板时不形成往返循环；联合用例断言 5 s 内公告次数有界 | agent 自决 | 联合测试必然同机 | AC-19、TASK-05/06、V-19 |
### 4.1 Windows 系统远程桌面分支（TASK-04）

- 后端新增 `servers/rdp/system_rdp.rs`，IPC `probe_system_rdp() -> SystemRdpStatus`（非 Windows 返回 `applicable=false`）与 `open_system_rdp_settings()`。
- 判定来源：`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\fDenyTSConnections`（0=已启用）；`...\WinStations\RDP-Tcp\PortNumber`、`UserAuthentication`（NLA）；`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\EditionID`（`Core*` 家庭版不含 RDP 主机）；SCM 查询 `TermService` 运行状态；本机端口是否被占用；当前进程令牌是否管理员（`IsUserAnAdmin`）。
- `open_system_rdp_settings` 用 ShellExecute 打开 `ms-settings:remotedesktop`，失败回退 `SystemPropertiesRemote.exe`。不修改任何系统配置（DEC-05）。
- 前端：`RdpSettings` 在 Windows 顶部显示“Windows 远程桌面”状态卡；`serversStore.start("rdp")` 在 Windows 上先探测，按 §4.1 状态表要求确认；确认写入 `systemRdpChoice: "taomni"` 后续启动不再询问，状态卡提供“重新选择”。系统 RDP 监听端口与 Taomni 端口相同时，确认对话框把端口改为 3390（可编辑）。
- `autostart_servers`：Windows 上 RDP 配置缺少 `systemRdpChoice=="taomni"` 且系统 RDP 已启用或可启用时跳过自动启动并记日志（AC-04）。

| 系统状态 | 启动时行为 | 状态卡文案要点 |
|---|---|---|
| 已启用且 TermService 运行 | 确认框：“系统远程桌面已在端口 N 运行，建议直接使用（用 Windows 账号登录）。仍要启动 Taomni？” | 已运行、端口、NLA、连接方式 |
| 支持但未启用，管理员 | 确认框：开启步骤 + “打开系统设置” + “使用 Taomni” | 未启用、如何开启 |
| 支持但未启用，非管理员 | 确认框：需要管理员开启；可直接使用 Taomni | 未启用、需管理员 |
| 家庭版 / 探测失败 | 不弹框，直接启动；探测失败写日志 | 不支持系统主机 / 未知 |

### 4.2 剪贴板富格式与文件（TASK-05、TASK-06）

- 格式映射：`CF_UNICODETEXT`(13)↔文本；注册格式 `HTML Format`（CF_HTML 头 + UTF-8 片段）↔arboard HTML（附纯文本回退）；`CF_DIB`(8)/`CF_DIBV5`(17)↔arboard RGBA 图片（BI_RGB 32/24 位与 BI_BITFIELDS，自底向上/自顶向下）；`FileGroupDescriptorW` + `FileContents`↔arboard `file_list`。
- 宿主变化检测：Windows `GetClipboardSequenceNumber`，macOS `NSPasteboard.changeCount`，Linux 轮询文本/HTML/文件列表并对图片做低频哈希；只在变化时向客户端 `SendInitiateCopy` 公告允许的格式。应用客户端数据后记录指纹，避免回声。
- 客户端→被控端文件：收到含 `FileGroupDescriptorW` 的格式列表 → 请求文件列表 → 若客户端支持则加锁 → 逐文件 `SIZE` + 分块 `RANGE`（1 MiB）写入 `<temp>/taomni-rdp-server-clipboard/<pid>/<seq>/`，路径经 `remote_clipboard_safe_path` 同等规则清洗 → 全部完成后 `set().file_list(顶层条目)`；超限或失败清理并记录；断开时清理（DEC-11）。
- 被控端→客户端文件：宿主文件列表变化 → 展开目录为 `FileDescriptor` 列表 → `SendInitiateFileCopy` → 按 `lindex` 响应 `SIZE`/`RANGE`，只读已公告集合内文件。
- 策略：配置 `clipboardServerToClient` / `clipboardClientToServer` ∈ `off|text|rich|all`（DEC-10），`clipboardFileMaxMb`（默认 2048）。
### 4.3 声音播放 RDPSND（TASK-07）

- `servers/rdp/sound.rs` 实现 `SoundServerFactory` / `RdpsndServerHandler`：格式表 PCM 48000/16/2、44100/16/2；`choose_format` 取客户端共同支持的第一个；`start` 启动宿主回环采集线程，转换为协商格式，按约 20 ms 一包经 `ServerEvent::Rdpsnd(Wave)` 发送；`stop`/断开时停止采集。
- 宿主回环采集：Windows 用 cpal WASAPI（在默认输出设备上建输入流即 loopback）；macOS 用 ScreenCaptureKit 音频输出（`capturesAudio=true`，排除自身进程音频，需 macOS 13+ 与屏幕录制权限）；Linux 用 PipeWire 流捕获默认 sink 的 monitor（`stream.capture.sink=true`）。不可用时只记录“声音不可用：原因”，不影响画面。
- 依赖：cpal 由 optional 改为默认特性 `rdp-server-audio` 启用（Linux 依赖 libasound2-dev，CI 已安装）。
- 配置：`audioPlayback`（默认 true）。

### 4.4 麦克风 MS-RDPEAI（TASK-08）

- `servers/rdp/audio_input.rs`：AUDIO_INPUT 动态通道服务端：Version → Formats（PCM 44100/16/2、48000/16/2、16000/16/1）→ Open（FramesPerPacket≈20 ms）→ 接收 `MSG_SNDIN_DATA_INCOMING`/`MSG_SNDIN_DATA`/`FORMATCHANGE`，把 PCM 写入宿主虚拟输入。
- vendored `ironrdp-server`：新增构建器 `with_dvc_factory`，允许在 `DrdynvcServer` 上挂载额外服务端 DVC；无可用宿主输入时不挂载（客户端创建会被拒绝），并在日志写明原因。
- 宿主虚拟输入：Linux 用 PipeWire 创建 `media.class=Audio/Source` 的虚拟源“Taomni RDP Microphone”（无需驱动）；Windows 检测名称含 `CABLE Input`（VB-Audio Virtual Cable）等虚拟线缆的渲染端点并播放进去，应用从对应 `CABLE Output` 录音；macOS 检测 `BlackHole 2ch/16ch` 输出设备并播放进去。设置页显示检测结果与安装指引（VB-CABLE 官网、`brew install blackhole-2ch`）。
- 配置：`microphone`（默认 true）、`microphoneDevice`（空=自动检测）。新增 IPC `probe_rdp_audio() -> {playback, microphone}` 供设置页显示。

### 4.5 自动检测与连接质量（TASK-09）

- 在 `build_server` 调用 vendored `enable_autodetect`；会话中每 2 s 发送 RTT 请求；连接后做一次带宽测量（BW_START/Payload/BW_STOP，限 1 MiB 与 500 ms）；把 baseRTT/averageRTT/bandwidth 用 Network Characteristics Result 下发（vendored 服务端补发送路径）。客户端未声明支持时不发送。
- 日志每 30 s 汇总一次 RTT，`RdpMetrics` 加入 RTT 分布。

### 4.6 Taomni 客户端连接栏（TASK-10）

- 新组件 `src/components/rdp/RdpConnectionBar.tsx`，仅在 RDP 会话处于 OS 全屏（含分离窗口全屏）时渲染，顶部居中：固定（pin）、连接质量（4 格，title 显示 RTT/带宽）、主机标题、Ctrl+Alt+Del、最小化、还原（退出全屏）、断开。
- 未固定时连接后显示 2.5 s 再隐藏；指针进入顶端 4 px 热区或按 `Ctrl+Alt+Home`（mstsc 同键）重新显示；固定状态存 `localStorage`。按钮均为 `<button>`，有 `aria-label` 与 `data-testid`，Tab 可达。
- 连接质量数据：Taomni 客户端在 `build_ironrdp_config` 声明支持 network characteristics autodetect，处理服务端 Network Characteristics Result 与 RTT 请求，向前端发 `quality` 事件；无数据时显示“未知”。
- 窗口模式保留现有浮动工具栏，并加入 Ctrl+Alt+Del 按钮。
### 4.7 性能测量与预算（TASK-03、TASK-11）

测量统一由 `rdp-probe` 在被测机本地回环执行（客户端与服务端同一时钟），宿主侧用 `rdp_target.py`（Tk）提供已知画面：

| 指标 | 场景 | 采样 |
|---|---|---|
| M1 `first_frame_ms` | TCP 连接 → 首个完整画面 | 3 次连接取中位数 |
| M2 `input_to_frame_ms` p50/p95 | 探针在目标方块上点击 → 目标翻色 → 探针解码画面中该像素变化 | 40 次，间隔 250 ms，丢弃前 3 次预热 |
| M3 `animation_fps` | 目标窗口 1280×720 区域 60 Hz 动画，统计含变化的帧 | 10 s |
| M4 `animation_kbps` | 同 M3 的下行字节 | 10 s |
| M5 `idle_cpu_pct` / M6 `animation_cpu_pct` | 已连接静止 / 动画时系统总 CPU（psutil） | 各 10 s |

Windows 基线：CI fixture 创建一次性本地账号，临时启用系统远程桌面并允许客户端指定初始程序，探针以 AlternateShell 启动同一个 `rdp_target.py`，在 TermService 会话上跑同一场景，得到 `TS(Mx)`。

达标规则（DEC-04）：Windows 上 Taomni 需满足 M2.p95 ≤ max(1.25×TS, TS+15 ms)、M3 ≥ 0.8×TS、M4 ≤ 1.5×TS、M5 ≤ TS+3 个百分点；三端绝对预算 `B(Mx)` 在 P0 首轮基线测得后写入下表并标注来源运行号，之后只允许收紧。原始样本、p50/p95 与环境（runner 镜像、CPU、分辨率、构建 profile）随报告保存。

| 指标 | Windows 基线 TS | 绝对预算 B（三端） | 来源 |
|---|---|---|---|
| M1 | 待测 | 待定 | P0 基线运行 |
| M2 p95 | 待测 | 待定 | P0 基线运行 |
| M3 | 待测 | 待定 | P0 基线运行 |
| M4 | 待测 | 待定 | P0 基线运行 |
| M5 | 待测 | 待定 | P0 基线运行 |

首轮记录（2026-10-01）：

- 运行 36803718420 三端探针都只看到未绘制的帧缓冲。根因：`ironrdp-server` 默认特性给 ironrdp-pdu 打开了 `qoi`/`qoiz`，`client_codecs_capabilities` 因而公告 QOIZ，但 ironrdp-session 未启用对应特性、无法解码，服务端选了 QOIZ 后客户端黑屏。产品 Taomni 客户端连 IronRDP 系服务器（含自家服务端）同样受影响。修复：`ironrdp` 依赖启用 `qoi`/`qoiz`；`servers/rdp/loopback_tests.rs` 用真实服务端 + 客户端栈回归 QOIZ 与仅 RemoteFX 两条路径（去掉特性时测试失败，已验证）。探针默认改为仿 mstsc 的编码集（仅 RemoteFX）。
- 同一运行 Linux 另有 X11 捕获停滞：RandR 预检查已排空的 DamageNotify（NON_EMPTY 只报一次）被丢弃。已修复。
- 运行 36809758793（debug 构建）：Linux/macOS 的 NAT-01、PERF-01 通过。RemoteFX 下 M2 p50 约 130–170 ms、M3 7–12 fps，首帧 0.6–1.4 s；QOIZ 首帧 80–230 ms。CI 默认是 debug 构建，这些数值不能作为预算依据；性能用例改为 `release_build_required`（release + 保留 debug 断言以维持 QA 隔离钩子），TermService 基线由 TC-RDPS-PERF-02 采集。
- Windows runner 默认启用并运行系统远程桌面（3389），因此 Windows 上的启动流程先弹出选择；跨平台用例以 `platform_choice` 在 Windows 回答“仍使用 Taomni”，其它平台断言不出现。

### 4.8 测试基础设施（TASK-01、TASK-02）

- `rdp-probe`（拟新增 `src-tauri/src/bin/rdp-probe/`，与应用同一次 `tauri build` 产出到 `target/qa-ui-auto/<profile>/`）：基于 ironrdp connector/session，NLA 认证；子命令 `connect`、`latency`、`throughput`、`clipboard-send`、`clipboard-receive`、`audio-capture`、`mic-send`、`autodetect`、`host-play`、`host-record`；输出 JSON（指标、原始样本、观察到的通道与 PDU），密码只从环境变量读取。
- qa-ui-auto：
  - fixture `rdp_server_required`（新增，CI capability `rdp` + `audio`）：生成一次性 `QA_RDP_PASSWORD`/`QA_VAULT_PASSWORD`；Linux 启动 PipeWire + WirePlumber 与 null sink；Windows 安装 VB-CABLE；macOS 安装 BlackHole 2ch 并设为默认输出；fixture `rdp_baseline_required`（Windows，capability `rdp-baseline`）创建 TermService 基线账号并在结束时删除、恢复注册表。
  - verb `open_route`（browser：base_url+route；native：在已启动的主 WebView 内导航到同源路由），用于在主窗口打开 `?servers=main`。
  - verb `rdp_probe`（native）：可选启动 helper（`rdp_target.py`/音调），运行探针子命令，校验 `expect`（指标上限/下限、观察项），保存原始 JSON 为工件。
  - verb `host_clipboard`（native，三端）：用各端系统工具（PowerShell、osascript、xclip）设置/读取文本、HTML、图片、文件列表，作为独立于产品 arboard 的 oracle。
- `ServerRow` 增加 `data-status`，RDP 设置新增控件均有 `data-testid`；`F-Servers-1` 与新 feature `F-RdpServer-1`、`F9.7` 控件同步。
- 联合测试（DEC-14）：同一 QA 应用先经 `open_route` 在主窗口打开 `?servers=main` 配置并启动 RDP Server，再回到主路由新建 RDP 会话连接 `127.0.0.1:<port>`；verb `rdp_canvas_click` 把宿主桌面坐标换算为客户端画布坐标并用 W3C 指针点击；`rdp_target.py` 把翻色次数写入报告目录下的状态文件，由 `assert_file_contains` 判定输入真实到达宿主窗口。目标窗口固定在桌面左上角 480×320，Taomni 窗口放在其右侧，避免被递归镜像遮挡。

### 4.9 GitHub runner fixture（workflow 供给，TASK-02）

| capability（由 fixture 推导） | Linux（ubuntu-24.04） | Windows（windows-2025） | macOS（macos-15） |
|---|---|---|---|
| `rdp`（`rdp_server_required`） | 生成一次性口令；`python3-tk`、`xclip` 已装 | 生成一次性口令；放行回环防火墙无需改动 | 生成一次性口令；记录 TCC 屏幕录制/辅助功能实测结果 |
| `audio`（`rdp_audio_required`） | apt `pipewire pipewire-pulse pipewire-alsa wireplumber pipewire-bin pulseaudio-utils`；在 job 的 DBus 会话内启动 PipeWire+WirePlumber，创建 null sink 作默认输出 | 静默安装 VB-CABLE（预导入发布者证书），设为默认播放/录音设备 | `brew install blackhole-2ch switchaudio-osx`，重启 coreaudiod，设为默认输出 |
| `rdp-baseline`（`rdp_baseline_required`） | — | 创建一次性本地管理员账号，临时 `fDenyTSConnections=0`、`fInheritInitialProgram=1`，启动 TermService；结束删除账号并恢复注册表 | — |
| `xrdp`（`xrdp_server_required`） | apt `xrdp xorgxrdp`，创建一次性用户，`startwm.sh` 启动 Openbox + `rdp_target.py`，监听随机端口 | — | — |

workflow 改动：`Prepare local service packages` 的条件扩展到上述 capability；`ci_services.py install` 负责安装，`ci_execute.py` 在用例前启动/在 finally 中清理运行期服务；所有口令以 `::add-mask::` 屏蔽，只经环境变量传入用例。
### 接口与共享契约

| 名称（拟新增除注明外） | 调用方 → 实现方 | 输入 | 输出 / 事件 | 兼容规则 |
|---|---|---|---|---|
| `probe_system_rdp` | `RdpSettings`、`serversStore.start` → `servers::rdp::system_rdp` | 无 | `{applicable, supported, edition, enabled, serviceRunning, port, portInUse, nla, isAdmin}` | 非 Windows `applicable=false`；字段缺失按未知处理 |
| `open_system_rdp_settings` | 状态卡/确认框按钮 → 同上 | 无 | `Ok(())` / 错误串 | 仅 Windows |
| `probe_rdp_audio` | `RdpSettings` → `servers::rdp::sound` | 无 | `{playback:{available,backend,reason?}, microphone:{available,device?,guidance?}}` | 三端 |
| RDP 配置新增字段（JSON，`server_configs`） | 前端 → `save_server_config` | `systemRdpChoice?: "taomni"`、`clipboardServerToClient`、`clipboardClientToServer`、`clipboardFileMaxMb`、`audioPlayback`、`microphone`、`microphoneDevice` | 原样持久化（密码仍只存 vault 引用） | 旧配置缺字段时用默认值 |
| `start_local_server`（现有） | 同现状 | 同现状 | 同现状 | 不变；Windows 确认流程在前端完成 |
| `server://rdp/session`（现有事件） | 后端 → 前端 | — | 增加可选 `channels: string[]` | 旧消费者忽略新字段 |
| Taomni 客户端 `quality` 事件（拟新增文本帧） | `src-tauri/src/rdp/session.rs` → `RdpPanel` | — | `{rttMs, bandwidthKbps?, source}` | 旧前端忽略 |
| vendored `RdpServerBuilder::with_dvc_factory` | `servers/rdp.rs` → `vendor/ironrdp-server` | `Box<dyn ServerDvcFactory>` | 每连接构建额外 DVC | 不传时行为不变 |

### 三端兼容与故障边界

- Windows：注册表用已有 `winreg`；SCM/管理员判定在 `windows` crate 增加 `Win32_System_Services`、`Win32_UI_Shell` 特性；剪贴板序号用 `Win32_System_DataExchange`；音频 cpal WASAPI；虚拟麦克风依赖用户安装的虚拟线缆驱动。
- macOS：剪贴板 `NSPasteboard.changeCount`（已有 `objc2-app-kit`）；播放采集复用 SCK 流，需屏幕录制权限且 macOS 13+；麦克风依赖 BlackHole 类驱动；输入仍需辅助功能权限。
- Linux：剪贴板经 arboard（X11/Wayland data-control）；播放与麦克风需要 PipeWire（Ubuntu 22.04+ 默认）；仅 PulseAudio 的系统报告不可用。
- 任一子系统失败只降级该通道；所有新线程在客户端断开或服务器停止时退出；暂存目录在断开、停止和下次启动时清理。
## 5. 改动清单

| 路径 / 模块（拟新增标 *） | 具体变更与保持的约束 | 相关 AC | 任务 |
|---|---|---|---|
| `src-tauri/src/bin/rdp-probe/*`*、`src-tauri/Cargo.toml` | 探针 bin；cpal 默认特性 `rdp-server-audio`；windows crate 特性 | AC-06~16 | TASK-01、07 |
| `src-tauri/src/servers/rdp/system_rdp.rs`*、`servers/mod.rs`、`lib.rs` | 系统远程桌面探测与设置页打开；autostart 判定；命令注册 | AC-01~05 | TASK-04 |
| `src-tauri/src/servers/rdp/clipboard.rs`、`clipboard_formats.rs`* | 富格式、文件双向、策略分级、变化检测、暂存清理 | AC-06~11 | TASK-05、06 |
| `src-tauri/src/servers/rdp/sound.rs`*、`capture/mac/sck.rs`、`audio_loopback/*`* | RDPSND 服务端与三端回环采集 | AC-12 | TASK-07 |
| `src-tauri/src/servers/rdp/audio_input.rs`*、`vendor/ironrdp-server/src/{builder,server}.rs` | AUDIO_INPUT 服务端 DVC、虚拟输入、DVC 注入入口 | AC-13 | TASK-08 |
| `vendor/ironrdp-server/src/{server,autodetect}.rs`、`servers/rdp.rs` | 启用 autodetect、带宽测量、Network Characteristics Result | AC-14 | TASK-09 |
| `src/components/rdp/RdpConnectionBar.tsx`*、`RdpPanel.tsx`、`src-tauri/src/rdp/session.rs` | 连接栏与质量事件；窗口模式 Ctrl+Alt+Del | AC-15 | TASK-10 |
| `src/components/servers/settings/RdpSettings.tsx`、`SystemRdpCard.tsx`*、`ServerRow.tsx`、`src/stores/serversStore.ts`、`src/lib/servers.ts`、`src/lib/i18n/locales/{en,zh-CN}.ts`、`src/stubs/tauri-core.ts` | 设置项、Windows 状态卡与确认、`data-status`、IPC 包装、文案、browser stub | AC-01~05、11~13、18 | TASK-04、05、07、08 |
| `.agents/skills/qa-ui-auto/scripts/**`、`schema/testcase.schema.json`、`references/verb-catalog.md` | fixture、verb、helper、CI 供给 | 全部 | TASK-02 |
| `.github/workflows/qa-ui-auto-platforms.yml`、`qa-ui-auto-tests/ci/{policy,dependencies}.yaml` | `rdp`/`audio`/`rdp-baseline` capability 安装步骤；新用例注册 | 全部 | TASK-02、03 |
| `qa-ui-auto-tests/cases/TC-RDPS-*`*、`TC-RDPC-BAR-*`*、`feature-list.md`、testid 目录 | 用例与控件目录 | 全部 | TASK-03~11 |
## 6. 实现任务与交接

任务看板（循环执行时原位更新状态与证据链接）：

| TASK | 目标 | 依赖 | 状态 |
|---|---|---|---|
| TASK-01 | `rdp-probe` 探针（连接/画面/输入/剪贴板/声音/麦克风/autodetect/宿主播放录音） | — | 已实现：另加 `--codecs`（默认仿 mstsc 仅 RemoteFX）、`--snapshot`、framebuffer 统计、`image-make`、文件列表经锁下载 |
| TASK-02 | qa-ui-auto：fixture、verb、helper、CI 供给 | TASK-01 | 已实现：`system_rdp_running`、`release_build_required`（CI `release` 能力→release QA 构建）、`rdp_baseline_required`；verb `platform_choice`、`host_make_tree`、`host_clipboard same_tree_as` |
| TASK-03 | 基线用例 TC-RDPS-NAT-01、TC-RDPS-PERF-01 首轮三端运行，回填 §4.7 | TASK-01、02 | 进行中：Linux/macOS 首轮通过（debug 构建，数值不作预算）；release 构建与 TermService 基线（PERF-02）运行中 |
| TASK-04 | Windows 系统远程桌面分支 | — | 已实现：UI-01/02 三端 browser 通过；native NAT-06 待 CI |
| TASK-05 | 剪贴板 HTML/图片与方向分级 | TASK-01 | 已实现（单元测试通过）；NAT-02 待 CI |
| TASK-06 | 剪贴板文件双向 | TASK-05 | 已实现（单元测试通过）；NAT-03 待 CI |
| TASK-07 | RDPSND 播放三端 | TASK-01 | 待开始 |
| TASK-08 | AUDIO_INPUT 麦克风三端 | TASK-01、07 | 待开始 |
| TASK-09 | autodetect 与 Network Characteristics Result | TASK-01 | 待开始 |
| TASK-10 | Taomni 客户端连接栏与质量事件 | TASK-09 | 待开始 |
| TASK-11 | 性能调优至预算 | TASK-03 | 待开始 |
| TASK-12 | 集成：三端全量 RDP 用例（含联合与参考服务器 V-18~V-21）+ 保留行为回归，交付报告 | 全部 | 待开始 |

### TASK-01 `rdp-probe`

- 文件：`src-tauri/src/bin/rdp-probe/{main,connect,frames,input,clipboard,audio,audio_input,autodetect,host_audio}.rs`，`Cargo.toml` `[[bin]]`（`test=false`）。
- 实施：参考 `src-tauri/src/rdp/session.rs` `drive_ironrdp_connection` 的 TCP→TLS→CredSSP→`connect_finalize` 流程，`ActiveStage` 驱动帧；解码到 BGRA 帧缓冲；按子命令执行场景；结果 JSON（`schema: taomni.rdp-probe.v1`）。凭据只读环境变量；所有子命令有超时。
- 完成：本地 Windows 对 Taomni server 跑通 `connect`/`latency`；单元测试覆盖 JSON 与 AUDIO_INPUT PDU 编解码（V-07）。

### TASK-02 qa-ui-auto 基础设施

- 文件：`scripts/qa_ui_auto/fixtures/rdp_server_required.py`*、`rdp_baseline_required.py`*、`scripts/qa_ui_auto/rdp/{rdp_target.py,host_clipboard.py,probe.py}`*、`native_steps.py`（`open_route`/`rdp_probe`/`host_clipboard`）、`steps/navigation.py`（browser `open_route`）、`ci.py`（capability 映射）、`ci_services.py`/`ci_desktop.py`（安装与会话内音频服务）、workflow 安装步骤、schema、verb-catalog、单元测试 `test_rdp_fixtures.py`*。
- 完成：`python -m unittest test_ci_selection test_ci_services test_rdp_fixtures` 通过；`--mode native --dry-run` 接受新用例。

### TASK-03 基线与首轮 CI

- 用例：`TC-RDPS-NAT-01-start-connect-display`（三端 native）、`TC-RDPS-PERF-01-performance-budget`（三端 native；Windows 追加 TermService 基线）。
- 完成：首轮三端运行报告（含原始样本）存档，§4.7 回填数值与运行号；能力缺口（如 macOS runner 无屏幕录制授权）以证据记录。

### TASK-04 ~ TASK-10

每项按 §4.1~4.6 实施，并完成对应 V（§7）；新增/修改控件同步 `feature-list.md` 与 testid 目录。共享文件（`RdpSettings.tsx`、`serversStore.ts`、`servers/rdp.rs`、vendored server）由当前执行者顺序修改，不并行。

### TASK-11 性能调优

- 依据 TASK-03 基线定位热点（采集、编码、发送、输入），只做能被 M1~M6 证明的改动；每次改动跑 `TC-RDPS-PERF-01` 三端对比，保留失败样本。

### TASK-12 集成与交付

- 在最终提交上以 `scope=selected` 运行全部 RDP 用例与保留回归（`TC-auto-F-Servers-1`、`TC-111`）三端 browser+native；Rust `cargo test --lib servers::` 与相关 Vitest 通过；更新 §9 实际证据。
## 7. 自动化测试计划

| V ID | AC / 用途 | 层级与文件 / case（* 拟新增） | 前置与操作 | 核心断言 | 执行方式 | 状态 |
|---|---|---|---|---|---|---|
| V-01 | AC-01~04 | Rust `servers::rdp::system_rdp` 单元* | 注册表/服务值组合 | 状态推导、端口冲突建议、autostart 判定 | `cargo test --lib servers::rdp::system_rdp` | 待执行 |
| V-02 | AC-01~05、18 | browser `TC-RDPS-UI-01-windows-system-rdp`* | stub 返回各系统状态 | 状态卡文案、确认/取消、打开系统设置调用、选择持久化 | qa-ui-auto browser 三端 | 待执行 |
| V-03 | AC-01、04 | native Windows `TC-RDPS-NAT-06-windows-system-rdp`* | runner 真实 TermService | 状态卡与真实注册表一致；确认后在不冲突端口启动 | qa-ui-auto native windows | 待执行 |
| V-04 | AC-06~11 | Rust `clipboard_formats` 单元* | CF_HTML/DIB/FILEDESCRIPTORW 样本 | 编解码往返、路径清洗、级别过滤 | `cargo test --lib servers::rdp::clipboard` | 待执行 |
| V-05 | AC-06~08、11 | native `TC-RDPS-NAT-02-clipboard-rich`* | 服务端运行、探针连接 | 文本/HTML/图片双向一致（`host_clipboard` 判定），禁止级别不传 | native 三端 | 待执行 |
| V-06 | AC-09、10 | native `TC-RDPS-NAT-03-clipboard-files`* | 含嵌套与 Unicode 名的样本树 | 双向 SHA-256 一致；超限拒绝 | native 三端 | 待执行 |
| V-07 | AC-12、13 | Rust `sound`/`audio_input` 单元* + 探针单元 | PDU 样本 | 协商、分包、PDU 往返 | `cargo test --lib servers::rdp` / `--bin rdp-probe` | 待执行 |
| V-08 | AC-12 | native `TC-RDPS-NAT-04-audio-playback`* | 宿主播放 1 kHz 音 | 探针收到 PCM 主频 1 kHz±2% 且 RMS 高于阈值 | native 三端 | 待执行 |
| V-09 | AC-13 | native `TC-RDPS-NAT-05-microphone`* | 探针经 AUDIO_INPUT 发 440 Hz | 宿主从虚拟麦克风录到 440 Hz±2% | native 三端 | 待执行 |
| V-10 | AC-14 | native `TC-RDPS-NAT-07-autodetect`* | 探针声明 netchar 支持 | 收到 RTT 请求、带宽测量与 Network Characteristics Result | native 三端 | 待执行 |
| V-11 | AC-15 | browser `TC-RDPC-BAR-01-connection-bar`* | 受控 browser RDP 预览夹具 | 显示/隐藏/固定、各按钮动作与键盘可达 | browser 三端 | 待执行 |
| V-12 | AC-15 | Vitest `RdpConnectionBar.test.tsx`* | 组件挂载 | 计时隐藏、热区、快捷键、质量映射 | `pnpm test src/components/rdp` | 待执行 |
| V-13 | AC-16 | native `TC-RDPS-PERF-01-performance-budget`* | `rdp_target.py`、Windows 基线账号 | M1~M6 满足 §4.7 | native 三端 | 待执行 |
| V-14 | AC-17 | native `TC-RDPS-NAT-01-start-connect-display`* | 设置页配置并启动 | NLA 成功、收到画面、点击生效、授权弹窗、停止后不可连接、错误口令被拒 | native 三端 | 待执行 |
| V-15 | AC-17 保留 | `TC-auto-F-Servers-1`、`TC-111`、`RdpSettings.test.tsx`、`RdpServerApprovalBridge.test.tsx`、`cargo test --lib servers::` | 现有 | 现有断言不变 | browser 三端 + 本地 | 待执行 |
| V-16 | AC-11~13、18 | browser `TC-RDPS-UI-02-rdp-media-clipboard-settings`* | stub `probe_rdp_audio` 各状态 | 设置项显示/持久化、缺驱动指引 | browser 三端 | 待执行 |
| V-17 | AC-17 兼容 | native Windows `TC-RDPS-NAT-08-mstsc-interop`* | `cmdkey` 凭据、证书警告抑制 | mstsc 完成 NLA 并协商 cliprdr/rdpsnd/drdynvc，服务端日志与截图为证 | native windows | 待执行 |

| V-18 | AC-19 | native `TC-RDPJ-01-client-server-loopback`*（联合） | 同一 QA 应用启动 Server，新建会话连 127.0.0.1 | 客户端连接状态与画面；画布点击使宿主目标翻色（状态文件）；断开后服务端仍运行 | native 三端 | 待执行 |
| V-19 | AC-19、DEC-15 | native `TC-RDPJ-02-joint-clipboard-no-echo`*（联合） | 联合连接后宿主写入文本 | 剪贴板内容保持一致且服务端公告计数有界（探针并行旁路观察日志） | native 三端 | 待执行 |
| V-20 | AC-15、AC-19 | native `TC-RDPJ-03-joint-connection-bar`*（联合） | 联合连接后切 OS 全屏 | 连接栏出现、质量等级来自服务端 netchar、固定/还原/断开生效 | native 三端 | 待执行 |
| V-21 | AC-20 | native `TC-RDPC-REF-01-reference-servers`* | Windows TermService / Linux xrdp | 客户端连接、画面、点击、连接栏 | native windows、linux | 待执行 |

限制：browser 夹具只证明渲染与状态逻辑；宿主剪贴板/音频/输入/采集必须用 native；macOS runner 若缺屏幕录制或辅助功能授权，相关 native 断言记为能力缺口并附证据，不算通过。
## 8. 真机验证手册

### 环境与准备

- 被测构建：`native_build.py` 产出的隔离 QA 应用 `com.taomni.app.qa`（`target/qa-ui-auto/debug/taomni[.exe]`），同目录 `rdp-probe[.exe]`；隔离 app-data 由 harness 负责。
- GitHub runner（`qa-ui-auto-platforms.yml`，`scope=selected`、`case_ids=` 本设计用例）：
  - Linux：Xvfb 1920×1080 + Openbox + DBus；fixture 启动 PipeWire/WirePlumber 与 null sink；X11 采集与 XTEST 输入。
  - Windows：交互式会话；fixture 安装 VB-CABLE；基线用例临时启用 TermService 账号，结束删除。
  - macOS：Aqua 会话；fixture 安装 BlackHole 2ch；屏幕录制/辅助功能授权取决于 runner 镜像 TCC，首轮实测并记录。
- 凭据：`QA_RDP_PASSWORD`、`QA_VAULT_PASSWORD` 由 fixture 生成并在日志中屏蔽，不写入报告。
- 本地 Windows 开发机：只运行构建、Rust/Vitest 与不占用用户桌面的探针场景；涉及全局输入/剪贴板的 native 用例在 CI 执行，避免干扰用户会话。

### 各端执行项

| 端 | V | 状态 |
|---|---|---|
| Linux | V-05、06、08、09、10、13、14 | 待执行 |
| Windows | V-03、05、06、08、09、10、13（含 TS 基线）、14、17 | 待执行 |
| macOS | V-05、06、08、09、10、13、14 | 待执行（先确认 TCC 能力） |

## 9. 验收追踪与交付条件

| AC | 方案 | 任务 | 验证 | 实际证据 | 当前缺口 |
|---|---|---|---|---|---|
| AC-01~05 | §4.1 | TASK-04 | V-01、02、03 | 待生成 | 未实现 |
| AC-06~11 | §4.2 | TASK-05、06 | V-04、05、06 | 待生成 | 未实现 |
| AC-12 | §4.3 | TASK-07 | V-07、08 | 待生成 | 未实现 |
| AC-13 | §4.4 | TASK-08 | V-07、09 | 待生成 | 未实现 |
| AC-14 | §4.5 | TASK-09 | V-10 | 待生成 | 未实现 |
| AC-15 | §4.6 | TASK-10 | V-11、12 | 待生成 | 未实现 |
| AC-16 | §4.7 | TASK-03、11 | V-13 | 待生成 | 预算待基线 |
| AC-17 | 全部 | TASK-12 | V-14、15、17 | 待生成 | 待执行 |
| AC-18 | §4.1~4.4 | TASK-04~08 | V-02、16 | 待生成 | 未实现 |
| AC-19 | §4.8、DEC-14/15 | TASK-02、05、10、12 | V-18、19、20 | 待生成 | 未实现 |
| AC-20 | §4.9 | TASK-02、10、12 | V-21 | 待生成 | 未实现 |

交付条件：三端 CI 上本设计全部 V 通过（能力缺口须有证据并单列），保留回归通过，§4.7 预算满足；未在某端执行的项不从其他端推断。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 缓解 / 最小验证 | 阻塞任务 | 解除条件 |
|---|---|---|---|---|
| macOS runner 的屏幕录制/辅助功能授权 | 无授权时 SCK 采集与输入注入失败，macOS native 用例无法证明 | TASK-03 首轮即探测；不可用时记录为能力缺口，保留 browser 与构建证据 | TASK-03 | 首轮运行结果 |
| Windows 虚拟线缆驱动在 runner 静默安装 | 驱动签名提示可能阻塞 | 预先导入发布者证书；失败则麦克风用例在 Windows 记录缺口 | TASK-08 | CI 实测 |
| TermService 基线账号与初始程序策略 | Server 2025 默认策略可能拒绝 AlternateShell | 设置 `fInheritInitialProgram`；不行则改为启动项方式 | TASK-03 | CI 实测 |
| 回环测试的剪贴板同源问题 | 同机客户端与服务端共用系统剪贴板 | 探针不使用系统剪贴板，只走协议；宿主侧用系统工具判定 | — | 设计已规避 |
| 安全桌面、多显示器、动态分辨率 | DEC-08/09 延后 | 设置页注明限制 | 不阻塞 | 后续需求 |
| 回退 | 新功能均为可关闭的通道级能力；配置新增字段向后兼容 | 关闭对应设置或回退提交 | — | — |

现在可开始：TASK-01、TASK-04（互不依赖）；TASK-02 依赖 TASK-01 的 CLI 契约。

