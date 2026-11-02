# taomni 截图启动优化：实施交接文档

> 面向执行 agent：按本文档开发与验证。基线 main `4d6f5dad8`，main 受 ruleset 保护（bypass 为空），一切改动走分支 + PR。
> 行号为约数（±3 行），函数名是首要锚点，动手前在工作树复核。
> 术语：T_first = overlay 可见、底图已上屏、`phase === "select"`；S_front = selectMs − show 累计时（show 之后到 select 的前端段）；windowMs 数值上等于含 focus 的后端链路结束，不是单纯建窗时刻；N27 的 run0 只是“同进程首开”，不是进程冷启动。

## 当前验收优先级（用户 2026-11-02 明确调整）

目标是按钮或快捷键触发后尽快看到底图并开始选区，避免显著延迟；**不要求完全消除短暂闪烁**。不为零闪帧添加固定等待，不把原生采样工具自身的 100ms 覆盖门槛当作产品性能完成前提。旧严格闪帧场景与原始失败证据保留作诊断，不能追改为通过。N28 保留窗口隔离、像素与恢复的强制验收；性能以 N27 的触发到可选区、分段 P50/P95 及 P1-1 原生复用结果为准。I1–I7、安全隐藏/排空与 Wayland 授权语义不变；三端、Linux 四 profile、截图＋crash 后全量验证的范围不变。

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

## 6. 实施状态（分支 `feat/screenshot-startup-optimization`）

本节记录代码现状；验证结果以 GitHub `qa-ui-auto-platforms` 的 run 为准，见 6.4。

### 6.1 已实现

| 项 | 实现位置 | 说明 |
|---|---|---|
| P0-0 / P0-0b 打点 | `screenshot/startup_timing.rs`（独立 mutex，可在 capture 线程打点）；`servers/rdp/capture/stage_trace.rs`（线程内观察者，portal 与 PipeWire 子段）；前端 `overlay/startupTiming.ts`（仅 `--mode qa` 构建写 `window.__TAOMNI_OVERLAY_TIMING__`） | 后端：entry（命令/快捷键，`entryLeadMs`）、permission、display、hide、capture_open_start/end、capture_hidden_signal、capture_grab、capture_drain_end、capture_drop_start/end、portal_create_session/select_devices/select_sources/start/pipewire_remote、pipewire_first_frame、capture、save_png、window_built、window_joined、cover、ready/ready_timeout、show（含 `showWallMs`）、hide_after_show、focus、read_file_start/end（含字节数）。前端：nav、fcp、entry、app、mount、init、read、decode、commit、paint。release 只记录与写日志，不读回 |
| P0-1b 透明首帧 | `index.html`（label 为 `screenshot-overlay` 且 hash 恰为 `#screenshot-overlay` 时不写主题底色并加 `screenshot-overlay-surface`）；`styles/base.css`；`overlay_open.rs` builder `.transparent(true)`；`ScreenshotOverlayView` 根背景在无底图时透明 | 贴图编辑器改用 `#screenshot-overlay-document`，透明关闭时用 `#screenshot-overlay-opaque`，两者保持主题底色。macOS 依赖已开启的 `macOSPrivateApi` |
| P0-3 拆包 | `main.tsx` 首个应用模块 `screenshotOverlayBoot.ts`；`screenshotOverlayRoot.tsx`；`lib/webviewGuards.ts`（右键菜单、刷新键、文件拖入导航三项守卫从 App 抽出，主窗口与 overlay 共用） | 原生 overlay 窗口跳过恢复握手（overlay 从不注册 renderer recovery）与 `App`。overlay 静态依赖除主入口共享部分外约 0.5 MB（主要是 i18n 词典），App 约 6.8 MB；`screenshotOverlayRoot.test.ts` 断言不静态到达 App、layouts、filebrowser、notes、servers、terminal、editor、appStore。`sweepExpiredHandoffs` 属于 SFTP 凭据交接，overlay 不需要 |
| P0-5 预取并行 | `overlay/prefetch.ts`、`overlay/images.ts` | boot 模块在 React 与 overlay UI 求值前发起 init、读回与解码；`loadImage` 直接 `await image.decode()`；shortcut status 刷新推迟到底图提交后 |
| P0-1 ready 握手 | `overlay_handoff.rs`（`screenshot_overlay_ready`，按 SESSION_GENERATION 匹配）；`OverlayInit.generation`；前端 layout effect | 六组 hosted 原生各 40/40 ready 早于 show、0 超时，候选改为默认启用；仍带 1500ms 失败兜底，不添加固定等帧。loadError 也发 ready（payload 已知时）。这是提交/解码证据，不声称隐藏 WebView 已在屏幕绘制 |
| P1-2 建窗并行 | `overlay_open.rs` | 权限通过后立即在 blocking 线程 build 隐藏窗口，与 hide/截图并行；`screenshot_overlay_init` 在有进行中的 open 时等待 payload；后端 open 进行中 `screenshot_capture_full` 拒绝执行；原生 overlay 窗口内不再回退 `captureFull()`，仅浏览器/dev 直开保留 |
| P1-3 Linux 重叠 | `capture/overlap.rs` | 同一 blocking 线程：open（portal 会话 + PipeWire，或 X11 capturer）→ 等带时间戳的隐藏完成信号 → 排空至少 250 ms，拒绝信号前或缺失时间戳的帧。无新帧则先完整 Drop 原 source，再串行新建安全重试；取消传到 portal consent 和首帧等待，worker 清理结束后才释放租约。会话不留存不复用，`PersistMode::DoNot` 不变。PipeWire captured_at 现为 callback 接收时间，非 producer PTS，此限制需 native 标记像素验收 |
| P1-1 预热复用 | `overlay_resident.rs`、`ScreenshotSessionHost.tsx`、启动后 `prewarm` | 主窗口建立后预热隐藏空 WebView，不申请截图权限、不打开 portal、不占租约；每 generation 完整 remount/unmount，事件订阅后快照消除首次触发竞态。关闭时保持原恢复顺序，仅窗口步骤替换成 hide + renderer reset；录屏移交、贴图文档保留销毁逻辑。N30 原生证明 identity、清空、文件清理、原生 CloseRequested 和租约释放 |
| P1-6 排除自身窗口 | `capture_exclusion.rs` | Windows 已验证 build 26100 / 26300 白名单，未验证版本走隐藏；macOS 15 新 run 的首张生产图含整个 marker，尽管 direct control 通过，因此禁用 macOS 排除并回退原 hide，不加等待掩盖失败。顺序与所有 RAII 恢复保留 |
| 回退开关 | `startup_profile.rs` | `TAOMNI_SCREENSHOT_STARTUP=legacy` 恢复串行路径；`-early-window`、`-handshake`、`-transparent`、`-overlap`、`-exclusion`、`ready-timeout=<ms>` 单项控制 |

### 6.2 未做与原因

- P1-1 已实现，`75d226e5` 的 hosted 第四轮已通过六组 native N30、全部截图／crash、四组 Linux 双屏（Wayland 含混合 DPI）、滚动与录屏回归。后续测试工具修正与格式收尾仍以最终 `scope=all` 结果确认，不把编译或 mounted 测试等同于 native 验收。
- P1-4 X11 条件化 hide：第 13 项未关闭，650 ms 不变。
- P1-7 枚举去重：低优先级，未做。
- 650 ms、250 ms 排空、HIDE_SETTLE、`focus_capture_window` 重试均未改。

### 6.3 用例

| 用例 | 变化 | 覆盖 |
|---|---|---|
| TC-SHOT-N27 | 修改：三组各 20 次打开（串行建窗握手／并行候选／常驻复用），后端子段 + 渲染标记 + 分组 P50/P95 + 握手比例；复用保持原 navigation/entry epochs，不能伪造第二次导航；关闭需确认隐藏、空 renderer、无 payload/lease/hidden ledger、主窗口恢复，`timeout_sec: 600` | P0-0b、P0-3/P0-5 定量、第 6 项 |
| TC-SHOT-N28 | 强制 `startup-isolation`：主窗口 marker 对照、排除生效与撤销（仅支持白名单）、5 次生产打开 0 marker 像素、会话隐藏及关闭恢复。用户 2026-11-02 明确性能优先后，严格 `startup-flash` 从阻塞验收移为保留的诊断，函数及旧失败原件不变，不冒充通过 | I1、I6、P1-2、P1-3、P1-6、P0-1b、P0-1 |
| TC-SHOT-N30 | 原生复用三代同一 WebView、递增 generation、清空旧选择/标注、每代新图、IPC/原生关闭、真实文件清理与租约释放，主窗口恢复；迟到复制不能关闭新 generation 的 mounted 回归 | P1-1、I2/I3/I6 |
| TC-SHOT-040 | 新增 browser 延迟 init：透明 loading、不提前选择、decode/ready 后选择、Cancel 与重开清空选区；026/027 保留旧参数断言并加入 ready IPC 顺序 | P0-1b、ready、重开生命周期 |
| 单元测试 | `ScreenshotOverlayStartup.test.tsx`、`screenshotOverlayRoot.test.ts`、`screenshotOverlayBoot.test.ts`、`images.test.ts`、Rust `startup_timing`/`startup_profile`/`overlay_handoff`/`stage_trace` | 透明根背景、ready 一次且带 generation、预取消费、失败会话不截屏、入口不含主应用、decode 直连 |

### 6.4 验证记录

2026-11-01 本机 Windows 11（Node 22.22.2 / pnpm 10.30.1）：

- 前端全套：662 文件通过，6180 测试通过，1 原有跳过（`qa-ui-auto-report/tmp/screenshot-unit-full-node22.log`）。后续修改原生与 QA 工具，不把旧证据冒充最终所有源码证据。
- 截图 browser 首轮 39/41；026/027 因 ready IPC 新顺序失败，保留原参数检查后两项复跑通过；随后完整截图 browser 41/41 通过（`run-20261101-222152-935490800`）。新增 040 加载/重开通过；StrictMode 重放预取重复读回先红后绿；共享 WebView guards 4 项通过。
- 原生 debug QA 候选构建成功（含完整 `pnpm build --mode qa` 与 refactor 检查）。N27/N28 已实际运行，WGC 读取显示器被本机执行环境拒绝：`You do not have permission to capture the given monitor. (0x80070005)`；两个 native case **失败，不计通过**，保留 run `run-20261101-221939-942182400`。
- Python 新 sampler/broker 11 项与 scenario runner 8 项通过；Windows 不支持无权限 symlink 的既有工具单测不计通过；Linux-only 代码必须由 runner 编译/原生检查。
- GitHub 第一轮：[`41315939146`](https://github.com/engcapa/taomni/actions/runs/41315939146)，候选 `40469cb5`，三平台 browser/native + Linux 全四 profile + 自动追加 crash；browser 三端各 49/49 通过，N27 六组 native 各 40 次通过、ready 全部早于 show、0 超时。整体失败（7 项）：Linux 三个 X11 profile 的 N28 采到黑帧且间隔超标，Wayland N28 间隔超标、N16 Manual→Auto 未产生新帧；Windows N28 品红检测误计桌面图标；macOS N28 单次独立 CoreGraphics 读取耗时约 554ms。原始失败与 receipt 保留，不能因 job 成功就当 case 通过。全量尚未执行，任务未完成。

2026-11-02 本机 Windows 11 后续：

- WGC 自动化拒绝的根因已通过进程 TokenIntegrityLevel 对照确认：位于 Low 完整性报告树的 EdgeDriver 及其 QA 子进程为 Low（4096），普通启动与用户应用为 Medium（8192）。相同已验证驱动字节复制到正常工具目录后，driver/QA 都为 Medium，N10 原生逐像素误差为 0。未通过调整隐私策略解决。后续按用户明确要求，仅报告目录补当前用户访问权并改为可继承 Medium；项目父目录未改。runner 新增只读完整性守卫，禁止再把该条件误报为隐私权限问题。
- 修复后 `run-20261102-064551-401425600`：N10、N27 通过，N28 隔离通过但采样失败，N29 初版通过但 2ms 耗时不能证明实际占用。没有把这些证据写成全通过。
- 独立采样器改为 numpy 分析、20ms 目标间隔，numpy 在开始采样前加载；Windows Python 3.12 的 15.6ms `monotonic_ns` 与粗粒度 UTC 改用 QPC `perf_counter_ns` 和 `GetSystemTimePreciseAsFileTime`，保留真实读取区间和原 100ms/10ms 阈值。N28 `run-20261102-065848-786432700` 通过：66 帧、show 后 34 帧、无均匀帧，最大保守间隔 74.80ms，clockStable true。不外推其它 OS。
- N29 加入真实 message-only window 持有者、占用对照读及生产 typed busy retry 计数，修复 NULL 持有者无法证明竞争的问题。`run-20261102-073733-500825200` 通过：occupiedControl true、同一请求 busyRetries 3、257ms、decoded RGBA 全相等。用户原始首次 Done 弹窗文字未保存，只证明此竞争回归，不宣称精确复现原始错误。
- 为避免创建第二个 `<img>` 重新进入未绘制状态，view 复用已经 decode 的 Image 节点；identity、resize、StrictMode 卸载测试通过。Linux 黑帧修复仍需新的 native runner 像素证据。
- Rust 聚焦 122/122 通过；runner/采样相关 Python 55/55 通过；refactor contracts / boundaries / size 与 QA audit gate 通过。完整 frontend 最新 662 文件通过、1 文件失败（6181 测试通过、1 失败、1 原有跳过）：无关编辑器 `editorPerformance.test.tsx` reconfigure 次数 2≠1；单文件 10/10 复跑通过。原完整失败保留，不计成完整全绿。
- 第二轮 [`41363657648`](https://github.com/engcapa/taomni/actions/runs/41363657648)，`ad358be9`：334/340 通过、6 项 N28 失败；无基础设施错误、原始 receipt 完整。Wayland N16 及其它功能通过。五端 N28 为严格闪帧/采样门槛失败；macOS N28 为第一个生产 open 含整个品红 marker（direct exclusion 对照通过不能代表生产正确），故 macOS 排除路径禁用回退 hide。严格闪帧门槛随后按用户明示移出阻塞验收，旧 run 仍为失败，不重标。
- 本机 N30 `run-20261102-084806-096469900`通过三代同 WebView/租约/关闭清理；全组 Windows debug 后续 25 项中 22 通过，N12 `defaultHidesWindows` 读取竞态、N17 系统剪贴板被覆盖、N4 原始默认 chord 被已安装用户应用占用恢复失败，原件 `run-20261102-084905-454774400` 保留。N12 改为有界观察原生隐藏；不改变用户应用/全局默认快捷键，不将 N17/N4 硬写通过。
- 本机 debug 三组各 20 次 `run-20261102-083215-548672500`：firstMs P50/P95 为串行握手 1255/1322ms、并行 899/950ms、复用 821/910ms；focus 后轮询 selectMs P50 为 1443/1093/1026ms，不能把 focus 后轮询时刻等同纯渲染或真实第一像素。这台 debug 的 PNG 编码约 650–800ms，是剩余大头；不据此改编码或外推 release/4K。
- 完整前端曾 6184 通过、2 失败、1 原有 skip（664 文件）。两个编辑器失败证实为测试与 deferred mount/grammar 两帧加载竞态，分别等待真实 Java language compartment 与两个 EditorView 挂载，不删内容、undo 或次数断言；修复后完整 `screenshot-resident-units-stable.log`：664 文件、6187 测试全部通过，1 原有 skip。截图聚焦 56 项与类型检查通过。
- 本机 browser 截图／crash 在仍改动的 Vite HMR 期间重跑失败（032/033/036 与 workspace 导航等），不标通过；一轮 QA build 检测到编译中 inputs 改变而拒绝身份记录，保留 exit 2。随后冻结源码批次再构建/运行，不伪造 source stable。
- 冻结候选 `1a5be417`：本机 screenshot browser `run-20261102-090908-152209500` 41/41，crash browser `run-20261102-091052-706960600` 8/8，均 identity_stable true、有匹配 receipt。原生 `run-20261102-091146-524231000` N30 证明首次触发也复用预热空窗口、三代一致 identity、陈旧 generation close 不影响新会话、所有租约/文件清理通过；N12/N17 仍失败，N4 恢复正确 prior registered=false 状态后通过。
- N12 进一步定位为公开菜单调用尚处 focus 完成前就被 QA 关闭/重开，后者由未改的 OPENING guard 正确忽略。QA 等待 OPENING 释放后，`run-20261102-092535-808500700` N12/N17 2/2 通过，随后 `run-20261102-092752-615715900` N12/N17/N30/N4 4/4 通过、identity_stable true。N17 添加失败时 clipboard sequence/owner PID/format 只读记录；后续未复现，不能宣称定位了覆盖方。
- Hosted 第三轮 [`41370911143`](https://github.com/engcapa/taomni/actions/runs/41370911143) 对应 `1a5be417`，338/346 通过、8 失败，无基础设施错误。三项 N12 是公开入口完成前重开竞态，五项 N28 是 RAII `eval` 把函数体的顶层 `return true` 当脚本执行，WebKit 报 `SyntaxError: Return statements are only valid inside functions.`；分别由 `44cac55b`、`75d226e5` 修正。六组 native N30 与 Linux 四组双屏通过。原失败报告／receipt 保留，不重标。
- 本机最终 debug 截图 `run-20261102-094540-834368200`：25/25 通过，0 失败／跳过，identity_stable true、receipt 完整。随后匹配 release 的 crash `run-20261102-095510-433910300`：8/9 通过，WS-054 在 native 冷重启时被 runner 的 TCP 表检查中断；原失败保留。真实受控 IPv4/IPv6 socket 证明本机 `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)` 会给可接受连接的监听端点返回非 LISTEN state，不能据此抛错。runner 保留所有返回的目标端点为占用，仍须实际端点消失才能重启，不修改应用逻辑、不终止无关进程；新增真实监听／关闭与异常 state 占用契约。相关 Python 36 项通过、1 Linux-only 跳过；Rust fmt 与 refactor 检查通过。
- Hosted 第四轮 [`41373708966`](https://github.com/engcapa/taomni/actions/runs/41373708966) 对应 `75d226e5`：**346/346 通过，0 失败／跳过**，workflow success、report_ok true；三端 browser 各 49/49，Windows／macOS native 各 34/34，Linux xvfb／X11／VNC 各 32/32、Wayland 31/31，四组 Linux 双屏各 1/1。31/31 执行 entry 收齐；独立复核 receipt 签名、所有绑定文件哈希、source／runner／case／selection、QA ID、同 producer 二进制哈希、release 与 desktop profile 均匹配。N25 是 X11-only，Wayland 不适用不是跳过。N27 六组各 60 次 ready 早于 show、0 超时；N28 所有生产图 0 marker 像素并恢复；N30 六组预热空窗、三代复用／清理／租约与陈旧关闭隔离通过。

第四轮 N27 release（每列每组 20 次；单位 ms，P50/P95）：

| 组合 | 串行握手 firstMs | 并行 firstMs | 常驻复用 firstMs | 常驻复用 selectMs |
|---|---|---|---|---|
| Windows 2025 | 636/672 | 337/357 | 125/142 | 331/348 |
| macOS 15 ARM64 | 475/537 | 331/348 | 297/322 | 466/496 |
| Ubuntu 24.04 xvfb | 1219/1234 | 986/990 | 972/978 | 1131/1141 |
| Ubuntu 22.04 X11 | 1180/1203 | 985/999 | 983/988 | 1141/1150 |
| Ubuntu 22.04 VNC | 1193/1204 | 986/993 | 981/985 | 1140/1149 |
| Ubuntu 26.04 Wayland | 1285/1308 | 1285/1297 | 1262/1286 | 1419/1444 |

`firstMs=max(show, renderer commit)` 不是独立原生第一像素测量，`selectMs` 是后端 focus 完成后才读取的可选区轮询。三组均包含新的前端入口，不能称为原始 main 与最终版本的严格匹配对照；也不是慢机、进程冷启动或 4K 数据。Windows/macOS 收益明显，Linux 仍受未改的 650ms 隐藏、250ms 排空及每次 Wayland 新授权／首帧约束，不宣称全平台“瞬时”。P1-4 门槛未满足，650ms 不缩短。最终格式与工具修正后本机 `run-20261102-102243-508566600` release 截图＋crash 34/34、browser `run-20261102-102919-110636400` 49/49 通过，均 identity_stable true、receipt 完整；全量结果未满足约定范围前任务不标完成。

### 6.5 全量与所有权收尾（2026-11-02）

- 首次 `scope=all` [`41377822416`](https://github.com/engcapa/taomni/actions/runs/41377822416)，`295b27b8`，三端／Linux 四 profile，计划 3175 次、40 entries：实际 2797 通过、22 失败，Windows 一组 browser 和四组 native 在 Cygwin 准备阶段未执行，不能写成全量通过。多数失败是无关编辑器响应预算；用户再次明确其它功能性能类失败可先忽略，原始 summary／receipt 和严格失败不变。非性能失败（MFA 无二维码反馈、Java 默认 import 折叠、mail 对话框点击）单独复核，未用该豁免掩盖。终端 burst 的失败段原始 IPC 流完整、无缺索引，2MiB SHA-256 与期望完全一致，但 UI done marker 观察超时，不能称为渲染完整性通过。
- 基础设施：Cygwin 原 hash 对应官方 2.937，但 rolling `setup-x86_64.exe` 已换版；改为官方版本化 URL，保留原 SHA-256。通过 detached signature 与官方 GPG 指纹 `56405CF6FCC81574682A5D561A698DE9E2E56300` 独立验签；每次在全新空目录下载，校验失败仍拒绝执行。Linux tool-contract 中模拟 Windows 重启的 test double 需创建新的 owned `driver.proc` 并断言新 PID 的只读完整性检查；生产隔离守卫与原 taskkill 树断言不变。
- 复用审查补充：未消费的冷首次 prefetch 必须按 host generation 校验，旧 decoded URL／迟到读取在 idle 后释放，旧失败不能污染下一代；host 透传 typed generation，payload owner 每挂载绑定它。退役 Save／选择外部编辑器在发出 native dialog 前检查存活性。原生 CloseRequested 异步清理与 IPC close 用同一 generation 原子 claim，只有胜者执行原恢复／清理顺序；迟到 native cleanup 不得关闭新代，不修改 OPENING、SessionLease 或录屏／滚动守卫。
- 新增 before-fix 回归实际失败（旧 prefetch 返回 generation 7 而非 8、旧 Save 打开 dialog），修复后 frontend 聚焦 48/48；Rust 聚焦 125/125（含两个并发 close claim 回归）通过，N30 补真实 native stale-cleanup 断言。`pnpm check:refactor`／Rust fmt／strict TypeScript 通过。完整前端 `screenshot-generation-units.log`：665 文件、6194 测试通过，1 原有 skip；匹配 release、最终截图＋crash 和全量重跑仍需收齐，不以旧源码通过替代。
- 用户随后明确当前通过远程桌面连接，所有后续测试只在 GitHub runner 执行；本机自建 Vite 服务已停止，用户安装的 Taomni／远程桌面设置未改。此前 release `run-20261102-152005-341276300` 30/34、复核 `run-20261102-153133-047167200` 1/4，失败保留：系统剪贴板只读序列证实生产复制后位图已出现，约 190ms 后 `rdpclip.exe` 接管并清空，未杀该进程或修改远程桌面策略；N29 real contention 3 次 typed retry、253ms、RGBA 相等，N30 三代 staleNativeCloseIgnored true。WS-054 单次冷恢复面板计数失败后原断言复跑通过，不能将首轮覆盖成通过。
- 未改候选功能复核 [`41404757126`](https://github.com/engcapa/taomni/actions/runs/41404757126)：40/41、report_ok true、无基础设施错误。MFA N106、Java 默认 import 折叠、Linux 联系人补全与完整 crash 均通过；唯一重复失败为 macOS native mail Close dialog 被裁切，仍为功能阻塞。限定修正 composer max-height/width 为所属内容区 100%，保留原 native close/reopen/contact 断言并补 viewport geometry，禁止用强制点击穿透。
- 第二轮全量 [`41405599909`](https://github.com/engcapa/taomni/actions/runs/41405599909)，`db3eb049`：Windows browser 461/461，Linux browser 460/461（1 项无关帧预算），macOS browser 453/459（5 项无关帧预算，1 项 Markdown Split preview Find）。工具／原生 contracts 已通过，native 仍收集中，不能把已完成 shard 当完整通过。Markdown 故障图为 preview 已可见但 No active editor；预览 Find 不应依赖尚未注册的 deferred source command port。保持统一 keymap/dispatcher，仅由已挂载且实际聚焦的预览补足 readiness，并以 runner 单元／原 native case 验证。未改源码复核 run `41410499910` 中 browser 原失败再次复现；native WS-081 通过，但 WS-054 titlebar hit-test 失败，原件均保留。
- 最新 affected runner `41411423338`：Linux producer 的新预览 readiness 回归本身通过，但第二个原用例被第一例留下的 DOM 污染（multiple preview）；显式 afterEach(cleanup) 修正，未删原断言。Windows 全量另发现 `ci_x11_session` 还引用已删除的共享 setup 路径；SSH/X11 统一调用每次独立下载、校验、执行、清理的 owner。完整性守卫误纳入系统 sandbox 进程，改为实际 native driver 角色且创建时间不早于真实父进程，防 parent PID 回收；Low adapter 与无法读取仍失败。三项均添加 runner contracts，未在用户远程桌面执行本机测试。
- 第二轮全量最终：2961 通过、141 失败、0 跳过，73 项 Windows shard-4 因 X11 setup 路径缺失未执行，report_ok false；141 中 123 为 Windows driver 身份误判、11 为无关帧预算，另有 7 个功能失败：WS-030 native restart HTTP500、MFA106 no-QR、VNC N23 按标题找 unmapped X11 overlay、WS-054 冷恢复布局、WS-071 目录调用数、WS-081 preview Find、macOS mail close。原件与 strict workflow failure 保留，不改成绩。
- `223417f0` affected run `41412967370` 的 Linux producer 前端 127/127、refactor 通过，Linux/macOS browser 各 51/51；已完成 Linux native shard 和 macOS native mail／preview／截图均通过，Windows 尚待收齐。冷恢复布局另证实 layout-only 请求可在磁盘恢复 pending 时被旧 captured host 覆盖，完成/失败收尾改读 live host，新增受控 pending regression；WS-054 原四面板/内容/hash 不删。N23 X11 geometry 改实际 GDK XID，不按窗口标题查询 unmap 期间的表面；尺寸/像素/DPR 断言不变。MFA 仅 isolated hosted QA 留存实际送入 decoder 的 TQF luma 与长度/协议分类日志，不记录 decoded secret，不改生产扫描／权限／反馈语义，用于定位全量才出现的非 OTP 结果。
- `41412967370` 收齐后为 379/381，report_ok true、无基础设施错误；Windows native 39/39，三端 browser 各51/51。剩余 xvfb N23 标题 lookup 已改 XID；macOS N30 首次 fs read 从357到1881ms（1524ms），导致1500ms握手兜底，ready在show后72ms到达。保留该截图性能失败，不加固定等待、不放宽timeout/ready断言，N30追加原始stage/renderer证据便于复核。
- 用户 2026-11-02 明确继续处理截图及已经出现的邮件、Markdown、工作区、MFA问题，范围锁定，不继续纳入新功能；全部测试仅runner。`7d66cb5b` 全量run `41418266772` 的Linux producer被新增Rust fmt检查挡住（MFA取证函数签名换行），采用runner精确diff修正；未把缺失Linux执行写成通过。
- 按用户要求获取并合并远程 `main`（`a58434059d3f0d6e6d44b492e12ea72a5a6e4dbf`）。邮件 composer 完整采用上游 `min-h-0 max-w-full max-h-full` 及面板内边界／两次实际关闭／阅读内容／运行时回归，不保留重复的 viewport-only 用例变体；同时引入上游 iframe 自有 ResizeObserver 生命周期与真实文档到达后的默认 import 折叠修复。Cygwin 使用上游 2.941 URL/hash，保留本分支 SSH/X11 每次独立临时目录下载与校验 owner，并同步合并后的契约测试。上游这批提交未更改 Markdown preview Find、冷恢复 layout 请求或 MFA 扫屏，故不据此宣称这些问题已解决。截图路径和 I1–I7 相关文件合并中无上游改动，原本分支安全约束保留。合并源码须重新运行 runner 上的 fmt/refactor、相关单元、全部截图＋crash 及全量矩阵；旧 SHA 的通过不当作合并后证据。本机未运行测试。
