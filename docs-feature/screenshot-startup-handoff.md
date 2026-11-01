# taomni 截图启动优化：实施交接文档

> 面向执行 agent：按本文档开发与验证。基线 main `4d6f5dad8`，main 受 ruleset 保护（bypass 为空），一切改动走分支 + PR。
> 行号为约数（±3 行），函数名是首要锚点，动手前在工作树复核。
> 术语：T_first = overlay 可见、底图已上屏、`phase === "select"`；S_front = selectMs − show 累计时（show 之后到 select 的前端段）；windowMs 数值上等于含 focus 的后端链路结束，不是单纯建窗时刻；N27 的 run0 只是“同进程首开”，不是进程冷启动。

## 1. 问题描述

用户在 taomni 里点击截图按钮或按截图快捷键后，开始截图前有两个症状：

- **延迟**：从触发到可以选区的时间过长，性能不好的机器上约 3 秒。
- **“闪一下”**：开始前像照相机闪一下。

实测基线（run 41271553565，分支 `qa/screenshot-startup-timing`，commit 9230a04b，结论 success；CI 显示器 Linux 1920×1080、Win/mac 1024×768；**CI 跑机不是慢机，以下数值不得冒充慢机数据**）：

| 组合 | selectMs 中位（≈T_first） | hide | capture | window_built | S_front | show 累计 |
|---|---|---|---|---|---|---|
| Linux xvfb | 1737 ms | 673 | 292 | 3 | 764 | 976 |
| Linux X11 | 1774 ms | 673 | 292 | 3 | 803 | 972 |
| Linux Wayland | 2344 ms | 651 | 1146 | 14 | 531 | 1812 |
| macOS | 1489 ms | 294 | 123 | 13 | 973 | 516 |
| Windows | 1037 ms | 267 | 90 | 125 | 534 | 514 |

补充：save_png 在 CI 尺寸下仅 1–20 ms；focus 段 Linux 约 155 ms、macOS 171–352 ms、Windows 约 200 ms；同进程冷热差 ≤115 ms。

## 2. 根因分析

启动链路是全串行的：触发 → 前端 IPC → 后端守卫 → 权限与显示器 → 隐藏并等待 → 截图 → 落盘 → 建窗 → 放置 → show → 聚焦 → 前端成像 → 可选区。

| 根因 | 证据 |
|---|---|
| 全串行链路 | `open_overlay_inner` 依次执行上述环节，前端成像排在 show 之后。本可重叠的成本：前端段 488–1006 ms、Wayland portal 约 830–970 ms（capture 段扣掉 250 ms 排空与枚举后的余量）、Windows 建窗约 125 ms |
| 每次新建 WebviewWindow | 每次调用 `window_builder(...).build()`，`close_session` 对 OVERLAY_LABEL 调用 `close()`。每会话都付一次 WebView 创建、页面加载、JS 求值，成本藏在 S_front 里 |
| 固定等待 | Linux show 前 900 ms（650 hide + 250 排空），非 Linux 250 ms，与机器快慢无关。X11 到 show 的 972 ms 中约 93% 是固定等待 |
| 前端 bundle 全量求值 | overlay 窗口同样走 `main.tsx` 的 `bootstrap()`（先查恢复再 `await import("./App")`），`App.tsx` 静态 import 全部窗口模块；分支前还跑 `useAppTheme`、`useAppStore`、`useScreenshotAppShortcut`、`sweepExpiredHandoffs`。占比待 P0-0b 拆分 |
| 闪烁的顺序与底色 | B1：先隐藏再截图，桌面暴露时长约等于 show 累计（439–1886 ms）。B2a：show 早于 HTML 首绘，显示平台默认色。B2b：overlay 与主窗口共用 `index.html` 主题脚本与 body 背景（浅 `#ffffff`/`#f1f5f9`，深 `#15171c`/`#191a1c`）。B3：`ScreenshotOverlayView.tsx` 根 `#000000` 加 40% dim，底图前一直黑。B4：`<img>` 只在 `state.img` 非空时渲染，无过渡，一帧内由黑跳成截图 |

## 3. 解决方案

约束（任何任务不得违反）：I1 截图中不出现 taomni 自身窗口（当前窗口模式除外）；I2 滚动或录屏中不错误重开 overlay；I3 OPENING 与会话租约的防重入语义不变；I4 多显示器与缩放下选区坐标不变；I5 Wayland portal 授权与会话语义不变（每次新建、`PersistMode::DoNot`、不传 restore token、Drop 时关闭）；I6 关闭 overlay 后应用窗口必须恢复；I7 其它应用前台时快捷键可用。不改 `open_overlay_with_window` 的守卫与租约段，不改 `close_session` 的恢复顺序，不涉及滚动、录屏、OCR、贴图、标注画布。

### P0（不改架构）

| 项 | 改动点 | 收益 |
|---|---|---|
| P0-0 打点 | 已实现，位于分支 `qa/screenshot-startup-timing`（`runtime.rs` 的 ToolState 增加 `startup_started`/`startup_stages`；`open_overlay_inner` 在 start、permission、display、hide、capture、save_png、window_built、cover、show、focus 记录累计 ms；QA 命令 `screenshot_qa_startup_timing`；用例 TC-SHOT-N27）。是否合入 main 单独走 PR，合入前确认 release 下快照只记录、不读取 | 0，测量工具 |
| P0-0b 打点扩展 | 后端补 B_entry（`screenshot_open_overlay` 入口与快捷键回调）、capture 子段（`FrameSource::open` 起止、`grab` 返回、排空结束、Drop 起止）、Wayland portal 子段（create_session、select_devices、select_sources、start 响应、PipeWire 首帧）、B10（`screenshot_read_file` 的 `fs::read` 起止与字节数）、show 墙钟时刻。前端仅 QA 构建补 10 个标记：F_nav（`performance.timeOrigin`）、F_fcp、F_entry（`main.tsx` 第一行）、F_app（`await import("./App")` 之后）、F_mount（`ScreenshotOverlay` 首个 effect）、F_init、F_read、F_onload/F_decode、F_commit、F_paint。分解式 S_front = 各子段之和，误差应在轮询粒度以内 | 0，前置项；解锁 P0-3/P0-5 的定量收益与第 6 项的关闭 |
| P0-1b 透明首帧 | `index.html` 内联主题脚本在 `location.hash === "#screenshot-overlay"` 时不写主题底色，html 与 body 设透明；`open_overlay_inner` 的 builder 加 `.transparent(true)`（仓库已有用法，`pin_window.rs:81`）；`ScreenshotOverlayView` 根背景在 `state.img` 为空时透明，非空时保持 `#000000`，dim 层不变。X11 需合成器提供 ARGB visual，无合成器时退化为现状；macOS 是否需 `macOSPrivateApi`、Windows WebView2 透明行为待核实，不满足时保持不透明，可用开关回退 | 延迟 0；消除 488–1006 ms 时间窗里的纯色帧。show 仍晚于截图，I1 不变；加载阶段点击已被守卫丢弃，透明期间不会提前选区 |
| P0-3 拆包 | `main.tsx` 在 hash 为 `#screenshot-overlay` 时动态 import 只含截图模块的入口（`ScreenshotOverlay`、`AppDialogProvider`、i18n、主题 token），其余情况仍 `import("./App")`。`useScreenshotOverlayState` 读取的 shortcut status 刷新推迟到底图上屏之后；`sweepExpiredHandoffs` 与恢复检查对 overlay 是否必要待核实，不确定的先保留 | 上限 = S_front 中“入口到挂载”子段，数值待 P0-0b |
| P0-5 预取并行 | overlay 入口第一时间（React 与截图模块 import 之前）发起 `fetchOverlayInit` + `screenshot_read_file` + 加载解码，得到 Promise 供 init effect 消费，否则走现有路径；`loadImage` 改为直接 `await image.decode()`；init 失败时的 `captureFull()` 回退语义不变 | ≤ min(JS 求值 + 挂载，init + 读回 + 解码)，待 P0-0b；与 P0-3 作用于同一前端段，收益不可直接相加 |
| P0-1 ready 握手 | `cover_display` 之后等待前端“底图已提交”信号（新增命令 `screenshot_overlay_ready`，按 SESSION_GENERATION 匹配），带超时兜底，然后 show、聚焦；loadError 分支也发 ready；前端在 layout effect 中调用，不依赖 rAF。先以实验开关上线，按第 6 项口径统计 ready 先于 show 到达的比例与超时率，再决定默认开启与超时值，不预设超时值 | 延迟约 0；覆盖 P0-1b 透明不可用的平台；本身就是第 6 项的关闭手段。如隐藏窗口不加载 JS，每次都会多出一个超时，因此第 6 项不成立时保持关闭 |

### P1（结构性改动）

| 项 | 改动点 | 收益与门控 |
|---|---|---|
| P1-3 portal/capturer 打开与 hide 重叠（Wayland 优先） | `FrameSource` 不能跨线程，在同一 blocking 线程里依次执行 open（portal 会话建立与 PipeWire 连接，或 X11 capturer）→ 等待“隐藏完成”信号 → 开始 250 ms 排空并取最新帧；`await_hidden_windows` 返回后发出信号；非 Linux 不改。`FrameSource` 的 Drop 如被 P0-0b 证实同步且耗时，可移到返回图像之后、在后台线程执行，会话仍在本次截图后关闭，不留存、不复用。排空从“隐藏完成”后才开始计时，之前到达的帧全部丢弃；真实桌面弹选择框时其父窗口与最小化窗口的关系待核实 | Wayland ≤约 650 ms，select 有望从 2344 ms 降到约 1700 ms 量级（推算，待验证）；X11 ≤约 20–55 ms。不依赖第 6 项 |
| P1-2 建窗与 hide/截图并行 | OPENING 取得后立即在后台以 `visible(false)` build overlay，截图完成后再写 init、cover、show；前端改为等待 init 事件。`fetchOverlayInit` 失败时回退 `captureFull()` 的路径在后端打开的会话里必须禁用（否则会在应用窗口尚未隐藏时截屏，违反 I1），只保留给 dev/QA 直开场景并显式区分 | 只算建窗：Windows ≤122–126 ms、macOS 冷首次 ≤103 ms、Linux ≤15 ms。如第 6 项成立，前端可在隐藏期间求值挂载，再省 ≤ min(S_front − 成像尾段，hide + capture) |
| P1-1 预热与复用 overlay | overlay 常驻且隐藏，`close_session` 改为重置并隐藏；显式关闭路径完整承接恢复、清理、租约释放，保留 Wayland“先 restore 再撤销焦点 surface”的顺序；前端以 generation 为 key 重新挂载；依赖 P0-1/P0-1b 防止残帧 | 每会话 ≤ S_front − 成像尾段，再加 Windows 建窗约 125 ms。依赖第 6 项 |
| P1-6 Win/mac 排除自身窗口替代隐藏 | 对原本会被隐藏的窗口设置截屏排除（Windows `WDA_EXCLUDEFROMCAPTURE`，macOS sharingType none）；顺序改为设置排除 → 截图 → show overlay → 再隐藏应用窗口；关闭与所有错误路径都要清除排除设置；未验证的 OS 版本回退到隐藏路径 | Windows ≤258–279 ms、macOS ≤268–523 ms，同时消除 B1。前置条件：第 14、15 项关闭（xcap 实际 API 与每 OS 版本像素验证），未关闭前不得启用 |
| P1-4 X11 条件化 hide（暂缓） | x11rb 确认 WM_STATE 或映射状态变化后，再等白名单内的尾部时长；非白名单保持 650 ms。白名单建立条件见验收标准 | ≤ 650 ms − 各桌面验证得到的稳定时长 P95；第 13 项关闭前收益记为 0 |
| P1-7 枚举去重（低优先级） | display lookup 得到的快照经新的带快照入口传给 `FrameSource`，供 `wayland_monitor_capture` 的 single_monitor 判断与 `desktop_origin` 使用；录屏与滚动的旧入口不变 | CI ≤约 10 ms；除非慢机数据证明枚举在慢机上显著变大，否则不做 |

### P2（不做，触发条件）

- P2-1 原生冻结帧 overlay：第 6 项不成立且 P0+P1 后仍不满足延迟目标时再评估；I4 要求两套坐标严格一致。
- P2-2 原始像素或共享内存传图、小图先行：P0-0b 证明读回 + 解码是成像尾段主因时再评估；sx/sy 改为基于 `init.width/height` 计算，全分辨率到位前禁用导出、取色与放大镜。
- P2-3 Wayland 会话复用或 restore token：产品决策，不是默认项；会改变授权语义（I5），指示器可能常亮，只能作为用户在设置中明确开启的选项并在 UI 中告知。
- P2-4 PNG 快速压缩：第 8 项 4K 数据证明净收益为正时再评估；CI 下可省 ≤20 ms 且文件变大会增加读回与解码成本；实施时必须预览与导出分离（保存、收藏、pin 均直接复制原图）。
- P2-5 底图内存直传、延后落盘：等 P0-0b 数据再定；写盘屏障不完整会让 copy/save 失败。
- P2-6 改变 portal 类型、P2-7 portal D-Bus 连接复用（不复用授权）：前者属于产品与安全决策，默认不做；后者只有在 P0-0b 证实每次截图都会新建 D-Bus 连接时才考虑。

## 4. 执行计划

**P0 全部完成的效果（决策依据）**：闪烁基本解决，延迟只解决一部分。P0-1b 消除纯色帧，但 B1 桌面暴露不解决；P0-1b、P0-1、P0-0、P0-0b 本身延迟收益为 0，只有 P0-3 与 P0-5 省时间且上限为 S_front 减去成像尾段、数值待 P0-0b。P0 完成后的延迟下限 = show 累计 + 成像尾段，即使成像尾段为 0（不可能），下限就是 show 累计：X11 972 ms、Wayland 1812 ms。因此 **Wayland 在 P0 之后仍在 1.8 秒以上，P0 实现不了“Linux P50 ≤ 1.0 秒”**。

**P1 决策**：P1 还要做，分批：P1-3 与 P1-6 在 P0 之后立即做；P1-1/P1-2 取决于第 6 项是否关闭；P1-4 暂缓；P1-7 低优先级。

| 阶段 | 任务 | 门控/退出条件 |
|---|---|---|
| 1 | P0-0b → P0-1b → P0-3 → P0-5 | 每项通过第 5 节对应验收后进入下一项；P0-0b 的子段数据是 P0-3/P0-5 定量验收的前提 |
| 2 | 同步用 P0-1 握手（实验开关）关闭第 6 项 | 统计 ready 先于 show 到达的比例与超时率；比例高、超时率低才算关闭，否则 P0-1 保持关闭，P1-1/P1-2 不做 |
| 3 | P1-3（Wayland 优先）+ P1-6（Win/mac） | P1-6 需第 14、15 项先关闭；否则只做 P1-3 |
| 4 | 第 6 项成立时做 P1-1/P1-2；不成立时跳过，直接进入阶段 5 | 跳过时记录原因，不得以“隐藏可预热”作为既定事实继续设计 |
| 5 | 第 13 项关闭时做 P1-4；否则不做 | 白名单建立条件见验收标准 |

## 5. 验收标准

### 5.1 通用验收

- 每项改动：`vite build` 产物检查（如 P0-3 要求 overlay chunk 不含 MainLayout、SFTP、notes、servers 等模块）；`vitest run`（至少 `ScreenshotOverlay.test.tsx`、`overlay/images.test.ts`、`lib/screenshot*.test.*`、`screenshotShortcut.test.tsx`）；原生回归守卫 TC-SHOT-N1、N24、N25、N20 与自动追加的 crash-regression 套件全过（N25 只在 xvfb 与 X11 profile 运行，Wayland 不适用）。
- 只用浏览器 stub 不够：`loadScreenshotUrl` 在非 Tauri 环境走直通分支，不经过真实 IPC 与解码，必须用原生验证。
- dispatch 注意：workflow 对 selected scope 自动追加 crash-regression 标签，其中有 browser-only 用例；modes 只给 native 时 plan 会报“explicit cases unavailable”而失败，dispatch 时 modes 必须给 `browser,native`（N27 本身仍走 native）；Linux profiles 为 `ubuntu-24.04-xvfb,ubuntu-22.04-x11,ubuntu-26.04-wayland`。
- 度量：TC-SHOT-N27（P0-0 + P0-0b）保留为度量用例；每组至少 20 次，报告 P50/P95 并按段拆分；P0-0b 各子段之和与 S_front 偏差 ≤ 检测粒度。

### 5.2 分项验收

- P0-1b：在 show 到 select 之间做 100 ms 级像素采样，不得出现整屏均匀的主题色或纯黑帧；外部高帧率摄像做主观确认；回归 N1/N24/N25/N20；更新 `ScreenshotOverlay.test.tsx` 的根背景断言。闪烁验证不在被测机上用录屏软件测（录屏会与截图链路互相干扰）。
- P0-3/P0-5：P0-0b 子段改进前后各 20 次，对比 P50/P95；P0-5 另需原生 N10 与 overlay copy。
- P1-3：Wayland profile 下 N27 capture 段与 select 改进前后各 20 次；N1 像素验证与 N20 全过；GNOME/KDE 人工记录是否弹框、指示器与时长。
- P1-2：N27 加 P0-0b；N1（I1）、N24（焦点）、N25、N20。
- P1-1：同 P1-2，加 `screenshot_qa_controls`、recorder、scroll 系列（I2）。
- P1-4 白名单建立条件（全部满足才可缩短）：按桌面环境、窗口管理器与版本分别建 profile，保持默认动画设置（xvfb 无合成器动画，不能作为放宽依据）；QA fixture 主窗口显示可识别标记图案，触发隐藏后用独立于被测截图路径的方式 100 ms 级采样屏幕；定义 t_stable 为标记像素完全消失且相邻两次采样帧差低于阈值；每 profile 至少 20 次，取 P95，白名单内尾部等待设为 P95 加至少一个采样间隔；用候选值跑 N1，截图中出现标记像素的次数必须为 0；慢机上重复上述步骤；100 ms 级采样只能支撑以 100 ms 为粒度的下调。

### 5.3 目标（待用户确认，不是承诺）

基线为 run 41271553565，同 profile 同口径，每组至少 20 次后再确认：闪烁在支持透明或握手生效的平台上纯色帧时长为 0 或不超过 1 个采样间隔；Wayland 在 P1-3 后 capture 段 P50 下降 ≥40%（参考上限约 650/1146）；Windows、macOS、X11 在 P0-3 加 P0-5 后 S_front P50 下降比例在拿到 P0-0b 子段后再定，不预设数字；Linux 的 900 ms 固定等待在第 13 项关闭前不纳入下降目标；T_interact − T_first 的 P95 维持现状即可。

### 5.4 慢机与进程冷启动复现口径

- 慢机：同 case（TC-SHOT-N27 加 P0-0b）在慢机上运行，结果单独标注“慢机”，CI 数据不得冒充慢机数据。慢机分真实慢机（最优先）与受限环境（2 vCPU 虚拟机、Linux cpufreq powersave 或 cgroup CPU 配额、Windows 节能模式）两类，分开报告。维度：分辨率 1080p、1440p、4K、5K（macOS）；缩放 100/125/150/200% 与混合 DPI 多屏，主屏与副屏各测；平台 Wayland（GNOME、KDE）、X11（开合成与动画、无合成器）、Win10/11、macOS Intel/Apple Silicon；触发方式按钮、全局快捷键（其它应用前台）、当前窗口模式；窗口状态主窗口可见或已隐藏、分离窗口 0/1/多个；磁盘 HDD 与 SSD。
- 进程冷启动：taomni 进程全新启动，启动前确认无残留 taomni 进程与 WebView 辅助进程（WebView2 浏览器进程、WebKit 子进程）；主窗口就绪后的第一次截图才算一个样本。变体：主窗口就绪后立即触发；就绪后空闲 N 分钟再触发；操作系统冷缓存（只在一次性 VM 内做，Linux 用 drop_caches，macOS 用 purge，Windows 重启后测）。每个样本都要重启进程，每 profile 至少 20 次启动；同时单独记录“进程启动到主窗口就绪”；对照组是同进程第 2 次及以后的打开，差值才是进程冷启动代价。

### 5.5 未决项（21 项中的未关闭部分；其余 13 项已由代码或实测关闭，不再列出）

| 项 | 状态 | 关闭口径 |
|---|---|---|
| 5. 未绘制时的默认底色 | 部分确认 | WebView 在 HTML 首次绘制前的第一帧平台默认色，需原生像素采样确认，不能写成“一定是白” |
| 6. 隐藏窗口是否加载、执行 JS、完成 `image.decode()` | 专项实测，P0-1/P1-1 前提 | P0-1 握手后，在隐藏窗口上观测 ready 是否在 show 前到达、超时率多少；超时兜底退回现状前，不得把“隐藏可预热”写成既定事实；P0-0b 的 F_nav 与 show 对比只作辅助，不构成关闭 |
| 8. PNG 默认与快速压缩在 4K 下的表现 | 专项实测 | 分支内 Rust 基准或 4K 显示器 profile 下，同一张图跑默认 vs Fast 压缩，比编码 ms、解码 ms、文件字节数三项 |
| 10. Wayland portal 行为 | 部分确认 | 现状每次新建会话、`PersistMode::DoNot`、不传 restore token、Drop 时关闭。关闭口径：Wayland profile 下 N27 加人工/原生观测，记录每次是否弹选择框、是否显示屏幕共享指示器、握手耗时三项 |
| 13. 各桌面动画时长，650 ms 能否缩短 | 专项实测 | X11/Wayland profile 下 100 ms 级像素采样，测隐藏窗口映射状态变化到画面稳定的时长，再与 650 ms 对照；未做像素验证前不缩短；执行细则见 5.2 的 P1-4 白名单条件 |
| 14. Windows `hide()` 是否有 DWM 淡出；xcap 在 Win/mac 的实际 API | 专项实测 | 已知 xcap 0.9.6，Windows 侧带 `wgc` feature，macOS 注释指向 CoreGraphics；hide 段 258–279 ms 只说明总时长，不能证明有无淡出。关闭口径：Windows/macOS 原生 QA 观察加像素采样，记录 hide 后画面稳定时长与截屏 API 实际路径 |
| 15. `WDA_EXCLUDEFROMCAPTURE` 与 macOS sharingType 是否生效 | 部分确认（仓库内不存在） | 每个 OS 版本原生像素验证，设排除后截图是否含 taomni 窗口，失败即回退隐藏路径；未验证的版本不得宣称生效 |
| 16. macOS simple fullscreen 菜单栏/Dock 动画，hide 后前台应用切换 | 专项实测 | macOS 原生 QA 采样菜单栏/Dock 出现与消失、前台应用切换时序；N27 的 macOS selectMs 只给总量，不拆动画 |

已关闭的 13 项（供核对，不再展开）：1 慢机分段（CI 数据已回填，慢机绝对值仍按 5.4 复现）、2 WebView 冷启动（外层已回填，引擎内部分解与进程冷启动按 5.4 测）、3 前端入口、4 `webview_environment::configure`、7 Tauri 背景色 API、9 原始 PNG 复制、11 X11 capturer 初始化、12 GTK 主线程排队、17 focus 同步等待、18 X11 隐藏轮询、19 loading 点击守卫、20 日志通道落点、21 前端测试框架。

### 5.6 不做项

不改滚动截图、录屏、OCR、贴图、标注画布的逻辑与语义；不在没有原生像素验证的情况下缩短 650 ms、250 ms 排空与 HIDE_SETTLE；不在截图之前显示 overlay 或任何 taomni 窗口（P0-1b 的透明 show 仍发生在截图之后）；不绕过、不缓存、不常驻 Wayland portal 授权与会话；不改变 pin 窗口不被隐藏的现有行为；不改 OPENING、SessionLease、STARTING_RECORDING 以及滚动、录屏守卫的判定代码；不改快捷键注册机制与默认组合键；不放宽 `ensure_artifact_path` 的路径校验，不改用 asset 协议 URL，保留同源 blob；不优化 `focus_capture_window` 的重试次数与间隔；不在 X11 上单独缩短 250 ms 排空；不把 CI 数据写成慢机结论，不把同进程首开写成进程冷启动，不把 1080p/768p 的 save_png 结论外推到 4K。
