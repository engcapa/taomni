# RDP Server 内容自适应编码与互通用例 详细设计

## 1. 设计摘要与范围

- 类型：现有能力扩展（`docs-feature/rdp-server-parity-design.md` 的 TASK-11 性能调优，以及 TASK-12 中的 V-17、V-21）
- 文档位置：`docs-feature/rdp-server-parity/encoder-adaptive-design.md`；离线实验在同目录 `encoder-experiment/`
- 设计状态：开发及 CI 验证中（DEC-01~DEC-07 均已有结论；用户已要求 DEC-07 按推荐方案执行）
- 来源：用户 2026-10-01 指令“按你的测试和分析，生成一份下一步可供 agent 做开发的详细设计和任务书”；上游设计 `docs-feature/rdp-server-parity-design.md` §4.7、§6 TASK-11/12、§7 V-13/V-17/V-21
- 调研基线：分支 `feat/rdp-server-parity`，提交 `e1af63eb`（已合并 `origin/main` 3b66d7b3）；CI 运行 36835206663、36841872978、36864121715、36871090675 的产物；离线实验 `encoder-experiment/`（本设计 §4.1 的 EXP-*）。本地环境 Windows 11 x64，不能执行 macOS/Linux 原生代码
- 平台与运行方式：Windows、macOS、Linux 三端 Tauri 桌面应用，代码必须兼容三端构建与运行
- 本轮真机执行端：当前开发机为 Windows（只做本地编译、单元与回环测试）；三端原生验证全部在 GitHub Actions `qa-ui-auto-platforms.yml` 的三端 runner 上执行
- 推荐方案：在 vendored `ironrdp-server` 的编码路径上加两件事。
  - **RDP 批量压缩（bulk compression）**：客户端在 Client Info 中声明 `INFO_COMPRESSION` 时，按客户端声明的级别（DEC-06）压缩快速路径更新，每个连接一个压缩器。
  - **按矩形内容选择编码**：每个合并后的脏矩形先编成 RDP6 planar 位图，用一次性压缩器估算压缩效果。压缩效果好（UI 类内容）就发位图；效果差（照片类内容）就再编一次 RemoteFX，取较小的发送（§4.2）。

  不声明批量压缩的客户端（以及协商出 QOIZ/QOI 的 IronRDP 系客户端），行为与现在逐字节一致。

**问题与目标。** 三端 TC-RDPS-PERF-01 的 M4（动画下行带宽）约 11 Mbps，预算是 4905 kbps（Windows TermService 实测 3270 kbps 的 1.5 倍，见上游 §4.7）。macOS 另有 M3 约 19.6 fps、未达到 25.6 fps，M2 p95 也一直贴着 65 ms 上限。离线实验表明：
- 现有 RemoteFX 固定量化本身就超预算 62%；
- 加大量化会让文字明显变糊；
- 只换成 planar 位图反而更大或仍超预算；
- 只有“位图 + 批量压缩”能在 mstsc 兼容的前提下把 UI 类画面降到预算以内，而且余量很大。

Taomni 目前从不做批量压缩。TermService 对 PERF-01 发的是位图更新，但当时探针没有声明压缩，所以它是否也会用批量压缩，要由 V-E10 确认。做完后，UI 类画面（文字、窗口、滚动条）的带宽要降到预算以内，照片/视频类画面不能比现在差，所有现有功能用例保持通过。

**本次范围。**（1）编码器改造：TASK-E1~E5。（2）补写 V-17 mstsc 互通、V-21 参考服务器两个用例：TASK-E6、TASK-E7。

**不做。** EGFX/AVC420 通道改造（macOS 已有实验路径，见 DEC-05）；RemoteFX progressive；RDPDR 驱动器重定向；连续带宽测量；改变客户端（`src-tauri/src/rdp/`）的编码选择。客户端在 TASK-E4 中声明批量压缩；参考服务器验收另修复了精确证书 pin 与原始错误保留，见 §8.2。

## 2. 实施前基线与功能缺口

下表记录调研基线 `e1af63eb`；实施后的状态、测试与运行号见 §6、§8.2、§9。客户端编码列表的实际默认值已在开工 unit 中核实。

| 位置与符号 | 当前行为 / 契约 | 本次影响 | 依据与确定性 |
|---|---|---|---|
| `src-tauri/vendor/ironrdp-server/src/server.rs` 约 1562–1664 行（`update_codecs` 循环 → `UpdateEncoder::new`） | 按客户端 Bitmap Codecs 能力选择**唯一**编码器：QOIZ > QOI > RemoteFX > NSCodec > None；没有 SurfaceCommands 能力时用 `BitmapHandler`（planar） | 改为可同时持有 planar 与 RemoteFX，由新的选择器按矩形决定 | 源码 |
| `vendor/ironrdp-server/src/encoder/mod.rs` `UpdateEncoder::bitmap_diffs`（约 240 行）、`EncoderIter::next` | 先用 `find_different_rects_sub::<4>` 找 64×64 脏块并合并成矩形，超过 `max_request_size` 的再切分，然后**逐矩形**调用 `BitmapUpdater::handle` | 选择器在这一层逐矩形工作；diff 与切分逻辑不变 | 源码 |
| `encoder/mod.rs` `RemoteFxHandler`（约 546 行）+ `encoder/rfx.rs` `RfxEncoder::encode` | RemoteFX image mode，`Quant::default()`（`6,6,6,6,7,7,8,8,8,9`），每个矩形重发 Sync/Context/Channels（仅首帧）与 FrameBegin/Region/TileSet/FrameEnd | 保留为照片类内容的编码；量化不改（DEC-03） | 源码 + EXP-05 |
| `encoder/mod.rs` `BitmapHandler` + `encoder/bitmap.rs` `BitmapEncoder::encode` | RDP6 planar（`BitmapStreamEncoder`，RLE 开），每块不超过 64 KiB 原始数据，输出 `UpdateCode::Bitmap` | 复用为 UI 类内容的编码；目前只在客户端没有 SurfaceCommands 时才会走到 | 源码 + EXP-02 |
| `encoder/fast_path.rs` `UpdateFragmenter::encode_fastpath`（约 90 行） | 每个快速路径分片 ≤16374 字节，`compression_flags: None`、`compression_type: None`，从不压缩 | 加入可选的批量压缩器 | 源码 |
| `ironrdp-acceptor 0.10.0` `connection.rs` 约 680–723 行 | 解析 Client Info PDU（含 `ClientInfoFlags::COMPRESSION` 和 `compression_type`），只把 TLS 模式下的凭据存进 `AcceptorResult`；压缩声明被丢弃 | 需要把客户端的压缩声明带到 `UpdateEncoder`（TASK-E1） | 源码；`ironrdp-acceptor` 不在 `[patch.crates-io]` 中 |
| `ironrdp-bulk 0.1.1` `BulkCompressor` | 提供 MPPC（RDP4/5）、NCRUSH（RDP6）、XCRUSH（RDP6.1）压缩与解压；`compress` 对 ≤50 或 ≥16384 字节直接跳过；压缩后变大时返回未压缩并置 FLUSHED | 服务端直接复用 | 源码 + EXP-03 往返校验 |
| `ironrdp-session 0.11.0` `fast_path.rs` 约 100–130 行、`active_stage.rs` 约 79 行 | `compression_type` 为 `Some` 时建 `BulkCompressor` 并解压带 COMPRESSED/FLUSHED 标志的快速路径更新 | Taomni 客户端与探针能解压，只是目前都传 `None` | 源码 |
| `src-tauri/src/rdp/session.rs` `build_ironrdp_config`（基线 `compression_type: None`）、`client_bitmap_codecs()` | Taomni 客户端未声明批量压缩；`client_codecs_capabilities(["remotefx"])` 也按默认声明 QOI/QOIZ，不能把该参数误读为只公告 RemoteFX | TASK-E4 改为声明 RDP6.1；保留编码能力列表 | 源码 + 开工前回环 unit |
| `src-tauri/src/bin/rdp-probe/session.rs` `connector_config`（`compression_type: None` 约 313 行）、`MSTSC_LIKE_CODECS = "remotefx,qoi:off,qoiz:off"` | 探针不声明批量压缩，所以 CI 测不到压缩路径 | TASK-E4 加 `--compression` 选项，默认按 mstsc 声明 RDP6.1 | 源码 |
| `src-tauri/src/servers/rdp/loopback_tests.rs` `round_trip`、`client_config`（基线 `compression_type: None`） | 真实服务端 + ironrdp 客户端栈的回环像素校验，原有 QOIZ 与仅 RemoteFX 两个用例均通过 | 增加压缩 / 自适应用例（TASK-E3） | 原 QOIZ 断言符合客户端实际默认能力，未改该列表或旧断言 |
| `src-tauri/src/bin/rdp-probe/rfx_stats.rs` | 报告 RemoteFX 量化与 tile、各快速路径更新类型的次数与字节、位图更新的 bpp/压缩方式；遇到批量压缩的更新只计数、不解析 | TASK-E4 加压缩前后字节与压缩比 | 源码 |
| `qa-ui-auto-tests/cases/TC-RDPS-PERF-01-performance-budget.testcase.yaml` 第 27–29 步 | 按 §4.7 预算断言 M1≤500 ms、M2 p95≤65 ms、M3≥25.6 fps、M4≤4905 kbps；三端当前都因 M4 失败 | 验收口径不变 | CI 运行 36864121715 |

**调用链与数据归属。** 采集线程（`servers/rdp/display.rs`）把整帧或裁剪后的脏区作为 `DisplayUpdate::Bitmap` 交给 ironrdp-server。`run_connection_with` 在能力交换后构建每连接的 `UpdateEncoder`，`dispatch_display_update`（约 1160 行）对每个更新调用 `encoder.update(update)` 得到 `EncoderIter`，再把每个 `UpdateFragmenter` 分片写到 TLS 流。编码器状态（上一帧 framebuffer、RemoteFX 首帧头）属于该连接；断开、重连和尺寸变化（Deactivation-Reactivation）时，编码器随连接重建或 `set_desktop_size`。批量压缩器的历史必须与这条流严格同步，所以应放在同一个每连接对象里，并在同样的时机重置（DEC-04）。

**TermService 对照（运行 36841872978，PERF-02）。** TermService 收到探针的 RemoteFX 能力后仍发位图更新：10 s 内 318 次，平均 11.4 KB，M4 为 3270 kbps。探针当时没有声明批量压缩，所以这些位图更新没有经过批量压缩；位图本身的 bpp 与压缩方式当时还没有统计（探针的 `bitmaps` 分项是之后才加的，见 TASK-E4 的 V-E10）。也就是说，TermService 在**没有**批量压缩时也只用 3.3 Mbps，而 Taomni 的 RemoteFX 用了 11.5 Mbps。推断两者差距有两个来源：一是编码选择（位图对少色块更省）；二是 TermService 只发真正变化的区域，而 Taomni 按 64×64 网格合并。后者是推断，由 V-E10 的统计确认。

**实施后的 TermService 数据（运行 36957070003，V-E10）。** 探针声明 RDP6.1 后，10 s 的下行带宽为 43.130 kbps，实际画面为 31.895 fps；320 个 bulk 压缩更新，解压错误 0，压缩前后为 3624079/52069 字节。位图分项为 `16bpp-compressed`，21029 个矩形，平均 4096 像素、154 字节/矩形。该对照确认参考服务器也使用 bulk；已发布的 AC-E01 绝对预算仍以原基线 3270 kbps 导出的 4905 kbps 验收，未放宽或重新定义预算。

## 3. 验收条件

上游 AC 编号沿用 `rdp-server-parity-design.md`（AC-16 性能、AC-17 兼容、AC-20 参考服务器）；本设计新增的验收以 `AC-E*` 编号，并注明对应的上游 AC。

| ID | 场景与前置条件 | 用户动作或触发 | 必须观察到的结果 | 适用平台 / 边界 |
|---|---|---|---|---|
| AC-E01（AC-16） | release QA 构建；探针按 mstsc 方式声明 RemoteFX 与 RDP6.1 批量压缩；宿主运行 PERF-01 的 640×360 动画 | 跑 TC-RDPS-PERF-01 | M1≤500 ms、M2 p95≤65 ms、M3≥25.6 fps、M4≤4905 kbps 全部通过（预算来自上游 §4.7，不得放宽） | 三端；预算只可收紧 |
| AC-E02（AC-16） | 同上，但宿主内容是照片/视频类（噪声平移渐变或真实图片窗口） | 跑新增的 PERF-03 照片场景 | M4 不高于同一构建关闭自适应时 RemoteFX 的测量值（不能因为改造让照片类变差） | 三端 |
| AC-E03（AC-17） | 客户端只声明 RemoteFX、**不**声明批量压缩（探针 `--compression none`） | 连接并收画面 | 服务端选择的编码与改造前一致（只有 RemoteFX surface bits，没有批量压缩标志），NAT-01 断言全部通过 | 三端 |
| AC-E04（AC-17） | 客户端声明 RDP5（MPPC-64K）而非 RDP6.1 | 连接并收画面 | 服务端改用 MPPC-64K；客户端解压后的画面与宿主像素一致（无损部分逐像素相等） | 回环测试 + 探针，三端编译 |
| AC-E05（正确性） | 自适应路径开启；连续多帧变化，中途触发尺寸变化（Deactivation-Reactivation）与断线重连 | 回环测试驱动 | 每一帧解码结果与服务端 framebuffer 对应区域一致：位图部分逐像素相等，RemoteFX 部分每通道误差 ≤24；重激活与重连后压缩历史从零开始，不出现花屏、不报解压错误 | 回环测试（Windows 本地 + CI 三端单元测试） |
| AC-E06（AC-17） | Windows runner；系统 mstsc.exe 连接 Taomni RDP Server | 跑新增的 TC-RDPS-NAT-08 | mstsc 完成 NLA、协商 cliprdr/rdpsnd/drdynvc；服务端日志记录所用编码与是否启用批量压缩；mstsc 窗口截图中能看到宿主的已知图案 | Windows |
| AC-E07（AC-20） | Windows runner 的 TermService（PERF-02 已有的基线账号） | Taomni 客户端打开到 TermService 的 RDP 会话 | 客户端连接成功、画布显示远端画面、全屏连接栏出现；质量指示在 TermService 提供数据时显示等级，否则显示“未测量” | Windows |
| AC-E08（AC-20） | Linux runner 的 xrdp | Taomni 客户端连接 xrdp | 同 AC-E07 | Linux；受 DEC-07 影响 |
| AC-E09（可观测性） | 任一连接 | 运行 30 s | 服务端日志每 5 s 的 “RDP latency:” 行附带编码分布（planar/RemoteFX 矩形数）与批量压缩比；探针报告 `rfx` 段新增压缩前后字节 | 三端 |

性能测量边界与上游 §4.7 相同：被测机本地回环，探针与服务端同机同钟，M4 按探针收到的 TLS 明文字节计（批量压缩后的 PDU 字节），10 s 窗口。

## 4. 方案与关键决策

### 4.1 离线实验结论（EXP-*）

实验代码在 `docs-feature/rdp-server-parity/encoder-experiment/`，运行方式见 §7 V-E01。它复现 PERF-01 的画面：1024×768 桌面，(40,80) 处 640×360 窗口，26 px 宽的白条每帧右移 4 px，左上角 32×32 灰阶标记循环 16 级。实验按服务端的真实步骤处理：64×64 脏块比较，再像 `find_different_rects` 那样合并矩形，最后逐矩形编码。每帧有 66 个脏块，带宽按实测的 32 fps 折算。所有批量压缩结果都用解压往返校验过（`bulk_send` 断言字节相等）。

| 实验 | 方案 | B/帧 | kbps | 占预算 | 无损 | 结论 |
|---|---|---|---|---|---|---|
| EXP-01 A | RemoteFX 默认量化，逐 64×64 块（现状） | 31,120 | 7,967 | 162% | 否 | 与 CI 实测同一量级（CI 11.5 Mbps，含 Linux 的多次部分更新） |
| EXP-01 B | RemoteFX，逐合并矩形 | 27,220 | 6,968 | 142% | 否 | 合并矩形只省 13% |
| EXP-02 C | planar，逐 64×64 块 | 66,547 | 17,036 | 347% | 是 | 小块破坏了 planar 的行间增量，最差 |
| EXP-02 D | planar，逐合并矩形 | 24,906 | 6,376 | 130% | 是 | 仍超预算 |
| EXP-03 E | planar 合并矩形 + MPPC-64K（RDP5） | 314 | 80 | 2% | 是 | 达标，有百倍余量 |
| EXP-03 F | planar 合并矩形 + XCRUSH（RDP6.1） | 292 | 75 | 2% | 是 | 达标；比 RDP5 略好 |
| EXP-04 G | zstd(1) 逐块（QOIZ 类） | 12,427 | 3,181 | 65% | 是 | 达标，但只有 IronRDP 系客户端能解，mstsc 不支持 |
| 照片场景 | RemoteFX / planar / planar+XCRUSH | — | 48,171 / 191,397 / 187,824 | — | — | 照片类内容上 planar+批量压缩是 RemoteFX 的 3.9 倍，**不能**无条件替换 |

EXP-05（RemoteFX 量化与画质，单个条纹块的亮度 PSNR）：默认 352 B/块、45.8 dB；+1 307 B、39.7 dB；+2 255 B、34.1 dB；+3 217 B、28.7 dB；+4 166 B、23.4 dB。量化 +2 只省 24%，却已降到 34 dB，文字边缘会出现明显振铃，所以排除“加大量化”。

单帧核对：planar 编码后每帧约 24.9 KB，分 2 个快速路径分片；XCRUSH 压缩后为 303–425 B。这是因为条纹画面与历史窗口高度重复。

**结论。** 能在 mstsc 兼容前提下达到预算的只有“位图 + 批量压缩”。照片类内容必须保留 RemoteFX。因此按矩形选择编码，选择依据是实际压缩后的字节数，而不是颜色数之类的启发式（EXP-02 的 ≤16 色、≤256 色启发式试过，效果与不选一样）。

V-E01 已在仓库执行并通过。原型条件（16352 字节分片、模拟位图头在尾部）的 E/F 仍为 314/292 B/frame，与历史值完全一致；生产条件使用 16374 字节分片与头部，E/F 为 323/312 B/frame。下表是初版 EXP-06 的首分片估算结果（Windows 本地 release unit，所有 bulk 结果均完成解压往返；耗时只代表此离线场景）。当前 EXP-06 与生产实现均采用四段均匀分离的 256 字节、共 1 KiB 采样；最新结果另列于本节末尾。

| 场景 | EXP-01 A（现状） | EXP-01 B（合并 RemoteFX） | EXP-06 H（自适应） | H 编码耗时 |
|---|---|---|---|---|
| 合成 UI | 31120 B/frame，7967 kbps | 27220 B/frame，6968 kbps | 312 B/frame，80 kbps | 6.51 ms/frame（A 4.36 ms） |
| 照片 | 192069 B/frame，49170 kbps | 188169 B/frame，48171 kbps | 188169 B/frame，48171 kbps | 40.34 ms/frame（A 26.65 ms） |

证据为 `qa-ui-auto-report/_local/encoder-experiment-sampled.log`。照片带宽已保持 RemoteFX 基线；额外 planar 编码的 CPU 成本仍需 PERF-03 的 native 帧率比证明不造成实际退化。

实施后的 `cargo test --release --features production-vendor -- --nocapture` 另核对当前 vendor 与 raw/RLE planar 候选（`encoder-production-experiment.log`，1 passed）。UI 的 H 仍为 312 B/frame、照片 H 仍为 188169 B/frame；修复 XCRUSH 历史后，照片的纯 planar+XCRUSH 为 464355 B/frame（118875 kbps），不能沿用旧 registry 的 187824 kbps 作为当前实现数据。实际并行编码器的 CPU-only unit 在同一组合成帧上测得：旧路径约 4.492 ms/frame 编码，自适应约 11.907 ms 加 5.069 ms bulk；优化后为 3.809/5.083 ms 编码、0.023/0.026 ms 分片，二者均为 315117 wire B/frame。该离线成本用于定位 CPU 开销，native 帧率仍由 §8.2 的 CI 报告验收。

当前采样与 vendor 的最终离线复测（`encoder-round7-experiment.log`，原型和 production-vendor 各 1 passed）：生产 UI H=312 B/frame / 80 kbps，5.04 ms/frame（RemoteFX A 4.68 ms）；照片 H=188169 B/frame / 48171 kbps，22.53 ms/frame（A 20.85 ms）。原型 E/F 仍为 314/292 B/frame，历史复现偏差 0%；全部压缩分片逐字节解压校验。生产编码器自身另有 cropped/uncropped CPU unit：裁剪照片旧/新 encode 为 6.347/7.027 ms，bulk 为 0.030/0.033 ms，双方 wire 均为 188168 B/frame（`encoder-round7-photo-sample.log`）。这些 CPU-only 耗时不替代 M5/M6 系统 CPU 测量或 native 性能验收。

### 决策记录

| DEC ID / 问题 | 可行选项、影响与代价 | 结论及理由 | 状态 | 决策来源 | 关联 |
|---|---|---|---|---|---|
| DEC-01 用什么降带宽 | ① 加大 RemoteFX 量化：省 ≤35%，画质降到 28–34 dB，不达标；② 换 planar：反而更大或仍超 30%；③ zstd/QOIZ：达标但 mstsc 不能解；④ planar + 批量压缩：UI 类降到 2%，mstsc/FreeRDP/ironrdp 都支持；⑤ EGFX/AVC420：照片类最省，但需要硬件编码与 EGFX 通道，三端实现差异大 | 选 ④，并保留 RemoteFX 作为照片类回退（见 DEC-02）；⑤ 作为后续方向，不在本次范围 | agent 自决 | 用户 2026-10-01 授权“先在本地写离线对比实验，选出能达到预算的方案，再接入服务端”；EXP-01~05 | AC-E01/E02、TASK-E1/E2 |
| DEC-02 位图与 RemoteFX 怎么选 | ① 固定颜色数阈值：实验中与不选效果一样，容易误判；② 每个矩形两种都编、取小：CPU 约增加 1 倍（EXP 中 RemoteFX 约 3 ms/帧、planar+XCRUSH 约 3.3 ms/帧，640×360）；③ 先编 planar，用一次性压缩器估算压缩后大小，只有估算 > 原始 planar 的 25% 时才再编 RemoteFX 比较 | 选 ③：UI 类画面压缩比远低于 25%，只编一次位图；照片类压缩几乎无效，才会多编一次 RemoteFX。阈值是常量 `PLANAR_BULK_GIVE_UP_RATIO = 0.25`，TASK-E2 用 V-E01 复跑确认 | agent 自决 | EXP-03（UI 类压缩比约 1.2%）、照片场景（约 98%） | AC-E01/E02、TASK-E2 |
| DEC-03 量化表 | 维持默认 / 加大 / 按内容动态 | 维持 `Quant::default()`：照片类本来就走 RemoteFX，加大量化只会损失画质 | agent 自决 | EXP-05 | AC-E02 |
| DEC-04 批量压缩器的位置与生命周期 | ① 放在 `UpdateFragmenter`（每个更新新建）：历史无法跨更新，失去压缩效果；② 放在每连接的 `UpdateEncoder`，按分片顺序压缩；③ 全局共享：多连接时历史错乱 | 选 ②：与写入顺序完全一致；重激活（`set_desktop_size`）和重连时重置，并对下一个分片置 `PACKET_FLUSHED`，告诉客户端清空历史 | agent 自决 | MS-RDPBCGR 3.1.8.3（发送方与接收方历史同步）；`ironrdp-session` 按顺序解压 | AC-E05、TASK-E1 |
| DEC-05 是否同时推进 EGFX/AVC420 | 推进：macOS 已有 VideoToolbox 实验路径，Windows/Linux 要另找编码器；不推进：本次只做 ④ | 不推进；在 §10 记为后续方向 | agent 自决 | 用户本次只要求“能达到预算的方案”；④ 已有百倍余量 | — |
| DEC-06 压缩级别选择 | 客户端声明什么就用什么，或固定一种 | 按客户端 Client Info 的 `compression_type` 用其声明的最高级别：RDP6.1 → XCRUSH，RDP6 → NCRUSH，K64 → MPPC-64K，K8 → MPPC-8K；未置 `INFO_COMPRESSION` 则不压缩 | agent 自决 | MS-RDPBCGR 2.2.1.11.1.1；`ironrdp-bulk` 四种都支持 | AC-E03/E04、TASK-E1 |
| DEC-07 V-21 是否在 Linux runner 安装 xrdp | ① 安装 `xrdp xorgxrdp`，建一次性用户，Openbox + `rdp_target.py`：CI 时间增加约 2–3 min，需要 sudo 改系统服务；② 只做 Windows TermService 部分，xrdp 记为能力缺口 | 推荐 ①（上游 §4.9 已按此规划了 `xrdp_server_required` capability，`ci.py` 已映射）；不影响编码器任务 | 已批准：CI 可用 sudo 安装并启动 xrdp | 上游设计 §4.9；`.agents/skills/qa-ui-auto/scripts/qa_ui_auto/ci.py` 第 116–117 行已有 `xrdp_server_required → xrdp` | AC-E08、TASK-E7 |

DEC-07 已由用户批准：GitHub Linux runner 可用 sudo 安装并启动 xrdp，TASK-E7 同时验收 Windows TermService 与 Linux xrdp。

### 4.2 编码路径（TASK-E1、TASK-E2）

改造后每个合并脏矩形的处理：

```text
EncoderIter::next(rect)
  └─ AdaptiveHandler::handle(rect)            // 新；替代原来的“唯一 BitmapUpdater”
       ├─ 客户端未声明批量压缩，或协商出的编码不是 RemoteFX（QOIZ/QOI/NSCodec/无 SurfaceCommands）
       │    → 原 BitmapUpdater 路径（行为与改造前逐字节一致，AC-E03）
       └─ 声明了批量压缩，且协商出 RemoteFX
            planar   = BitmapEncoder::candidate(rect)               // RLE 完整编码；raw 先取精确长度/采样
            estimate = scratch_mppc64k(planar_strips).len()         // 一次性压缩器，用完即弃
            if estimate <= planar.len() * PLANAR_BULK_GIVE_UP_RATIO // DEC-02，0.25
                 → 必要时构造完整 planar，然后发送
            else
                 rfx = RfxEncoder::encode(rect)                     // UpdateCode::SurfaceCommands
                 rfx.len() < estimate ? 发 rfx : 构造并发送 planar
       // planar 分片写出前经过连接的批量压缩器（§4.3），且只经过一次
       // 已压缩的 RemoteFX 直接发送；不推进发送端或接收端 bulk 历史
```

要点：

- **只有真正发出去的字节进入连接的压缩历史。** 连接的 `BulkCompressor` 每调用一次 `compress` 就推进历史，客户端则只会看到发出去的数据。如果拿连接压缩器去“试压”一个最终没发的矩形，双方历史就会错位，后面的画面会解错。所以判断只用 `scratch_mppc64k`：一个当次新建、用完即弃的 MPPC-64K 压缩器，≤1024 字节直接试压；更大的候选在完整 planar 范围取四段均匀分离的 256 字节数据，再按比例估算整个矩形，不带跨帧历史。第五轮先采用四段共 4 KiB 的采样；第六轮照片仍未达帧率比后，将采样上限降至 1 KiB。平坦前缀与噪声主体的专门 unit 保护误判边界。V-E01 的完整自适应耗时与原 RemoteFX 分开记录；实际输入延迟与帧率以 CI native PERF-01/03 为准。
- **位图更新的约束。** bulk 路径的 `TS_CD_HEADER.cbScanWidth` 为每行字节数 `width * 4`，因此任意 32bpp 像素宽度都对齐；只有该值超出 u16 时回退 RemoteFX。奇数宽 XDamage 与保留父 stride 的裁剪由逐像素 unit 覆盖。非 bulk 路径保持原头部字节。
- **照片的 CPU 成本。** 第三轮 CI 的实际画面帧率证明完整 planar RLE 与 RemoteFX 重复编码、再尝试 bulk，会拖慢照片。在矩形全范围采样 256 个邻域，超过一半有重复色或一致的垂直增量时使用 RLE，否则使用标准 raw planar。raw 候选现直接从像素读取与完整编码完全相同的四段采样，并计算精确长度，只有选中 planar 时才生成全部 R/G/B 平面；RLE 候选仍完整编码。八种像素布局、父 stride、部分尾行及跨 bitmap 分块的 unit 校验长度、采样字节和估算结果完全一致。采样只选择 planar 内部表示，不直接决定最终 wire codec；选择阈值未改。大小估算只分配独立 MPPC 上下文，候选输出缓冲按 bulk 的 4 B/pixel 与头部预留，避免原 8 B/pixel 清零。选中 RemoteFX 时直接发送，因为照片 unit 中额外 bulk 5.07 ms/frame 没有节省字节；未压缩更新不进入两端历史，四种级别的混发测试验证这一点。
- **两种更新混发。** 同一帧里可能有的矩形是位图更新（`UpdateCode::Bitmap`），有的是 surface bits。mstsc、FreeRDP 和 ironrdp-session 都能处理混发，各自直接绘制到同一个 framebuffer；TASK-E3 的回环测试要覆盖混发的帧。
- **RemoteFX 首帧头。** `RemoteFxHandler` 在第一次编码时附带 Sync/Context/Channels（`desktop_size.take()`）。自适应路径下，第一个矩形可能是位图，所以这个“首帧”标志必须挂在 RemoteFX 编码器自己身上，不能按“第一个更新”判断。现有实现已经是挂在 `RemoteFxHandler` 上的，保持不变即可。

### 4.3 批量压缩（TASK-E1）

- **协商。** `ironrdp-acceptor` 0.10 已解析 Client Info PDU，但没有把 `ClientInfoFlags::COMPRESSION` 和 `compression_type` 放进 `AcceptorResult`。新增 vendored crate `src-tauri/vendor/ironrdp-acceptor`（从 crates.io 0.10.0 原样复制），在 `AcceptorResult` 加字段 `client_compression: Option<CompressionType>`，在 `SecureSettingsExchange` 分支里：标志置位时为 `Some(client_info.client_info.compression_type)`，否则为 `None`。然后在 `src-tauri/Cargo.toml` 的 `[patch.crates-io]` 增加 `ironrdp-acceptor = { path = "vendor/ironrdp-acceptor" }`。这条分支在 HYBRID（NLA）模式下同样会执行：凭据走 CredSSP，但 Client Info PDU 照常发送，压缩声明照常有效。
- **服务端开关。** `RdpServerBuilder::with_bulk_compression(enabled: bool)`，默认 `false`，保持 crate 原有行为；Taomni 在 `servers/rdp.rs` 的 `build_server` 中打开。另有环境变量 `TAOMNI_RDP_BULK_COMPRESSION=0` 作为现场排障开关，不加 UI。
- **发送。** `UpdateFragmenter::encode_fastpath` 在拿到分片数据后，若连接有压缩器：调用 `compress(chunk)`。
  - 返回带 `PACKET_COMPRESSED` 时：写 `compression_flags = flags & 0xE0`（COMPRESSED / AT_FRONT / FLUSHED）、`compression_type = flags & 0x0F`，数据用 `compressed_data(size)`。
  - 未压缩但带 FLUSHED 时：仍写 compression 字段并发原数据。
  - 两者都不带时：`compression_flags: None`。

  ≤50 字节或 ≥16384 字节的分片由 `BulkCompressor` 自动跳过。分片上限通常为 16374 字节；MPPC-8K 则为 8191 字节，避免超过其历史窗口。
- **快速路径压缩共用同一连接的历史**，包括指针（`rgba_pointer` 等）。自适应选择的 RemoteFX 已编码为照片数据，使用不推进 bulk 历史的 raw fast-path；位图与指针仍在顺序发送时尝试 bulk。写入顺序必须与压缩顺序一致，所以压缩在 `EncoderIter::encode_fragment` 写入前完成，不放到并行的编码线程里。四级 raw/压缩交替 unit 逐包解压证明历史保持一致。
- **重置。** `UpdateEncoder::set_desktop_size`（重激活）和新连接都新建压缩器；新压缩器的第一个压缩分片按 MS-RDPBCGR 置 `PACKET_FLUSHED（AT_FRONT 仅使用各压缩器按实际历史产生的值，NCRUSH 首包不可强置 AT_FRONT）`，由连接包装器明确发送 FLUSHED；XCRUSH 内层 MPPC 同时发送 FLUSHED。四级连续分片与重置 unit 已覆盖。

### 数据流、状态与生命周期

| 状态 | 所有者 | 创建 | 销毁 / 重置 |
|---|---|---|---|
| `BulkCompressor`（每连接，可为空） | `UpdateEncoder::bulk: Option<BulkEncoder>`；包装器持有 compressor、协商级别与首次 FLUSHED 状态 | `run_connection_with` 构建编码器时，按 `AcceptorResult.client_compression` 与 builder 开关 | 连接结束随编码器 drop；重激活时 reset；故障后本连接保持禁用 |
| 自适应统计（planar/RemoteFX 矩形数、压缩前后字节） | 服务端共享 `Arc<EncoderStats>` 原子计数器，供每连接编码器写入 | builder 构建时传入 | 服务端停止后销毁；通过 `with_encoder_stats_handle` 暴露给 Taomni 的 `RdpMetrics`，日志为当前服务端的累计统计 |
| 上一帧 framebuffer | `UpdateEncoder`（现有） | 现有 | 现有 |

### 接口与共享契约

| 名称 | 调用方 → 实现方 | 输入 | 输出 / 错误 | 兼容规则 |
|---|---|---|---|---|
| `AcceptorResult::client_compression`（vendored acceptor） | `ironrdp-server::server` → acceptor | Client Info 的 flags 与 `compression_type` | `Option<ironrdp_pdu::rdp::client_info::CompressionType>` | 新增字段；acceptor 的其他调用者只有 ironrdp-server |
| `RdpServerBuilder::with_bulk_compression(bool)` | `servers/rdp.rs` `build_server` → vendored server | `bool`，默认 false | — | 不调用时行为不变 |
| `RdpServerBuilder::with_encoder_stats_handle(Arc<EncoderStats>)` | 同上 | 共享计数器 | `planar_rects`、`rfx_rects`、`bytes_before_bulk`、`bytes_after_bulk`（`AtomicU64`） | 不调用时不统计 |
| 服务端日志 “RDP latency:” 行（现有，扩展） | `servers/rdp/metrics.rs` `report_if_due` | `EncoderStats` 快照 | 追加 ` encode=planar:N/rfx:M bulk=XX%` | 现有字段与顺序不变，只在行尾追加；NAT-07 断言的 `network-rtt=` 不受影响 |
| 探针 `--compression none\|k8\|k64\|rdp6\|rdp61` | qa case → `rdp-probe` | 默认 `rdp61`（与 mstsc 一致） | 报告 `negotiated.compression`、`rfx.bulk.{compressed_updates, bytes_before, bytes_after}` | 现有 case 不传时改用默认 `rdp61`；AC-E03 用 `none` |
| Taomni 客户端 `build_ironrdp_config` `compression_type`（现有字段） | `rdp/session.rs` | 改为 `Some(CompressionType::Rdp61)` | ironrdp-session 建解压器 | 对不支持压缩的服务端无影响（服务端可以不压缩） |

### 三端兼容与故障边界

- `ironrdp-bulk`、`ironrdp-graphics` 都是纯 Rust，没有平台条件编译。改动只在 vendored crate 与 `servers/rdp.rs`，三端同一份代码。
- macOS 的实验 EGFX/AVC420 路径（`servers/rdp/gfx.rs`，需环境变量 `TAOMNI_RDP_EXPERIMENTAL_AVC420=1`）不经过 `UpdateEncoder`，不受影响；该路径开启时，位图路径只用于回退。
- **故障边界。** 压缩器返回 `Err` 时，记录警告，以 raw 数据发送本次分片并置 FLUSHED，让客户端丢弃历史；本连接之后关闭 bulk，自适应编码退回原 RemoteFX，后续分片无 compression 字段。Resize 不重新启用故障压缩器，新连接才重新协商。vendor 故障注入 unit 与真实 ironrdp 客户端逐帧校验保护恢复路径。
- 不涉及持久化与配置迁移。

## 5. 改动清单

| 路径 / 模块（拟新增标 *） | 具体变更与保持的约束 | 相关 AC | 任务 |
|---|---|---|---|
| `src-tauri/vendor/ironrdp-acceptor/`* | 从 crates.io `ironrdp-acceptor 0.10.0` 原样复制；`AcceptorResult` 加 `client_compression`；`SecureSettingsExchange` 分支在 HYBRID 与 TLS 两种模式下都填写；其余代码不改。在 crate 根放 `VENDORED.md`，写明来源版本与改动点，方便以后升级时对照 | AC-E03/E04 | TASK-E1 |
| `src-tauri/Cargo.toml` `[patch.crates-io]` | 加 `ironrdp-acceptor`、`ironrdp-bulk` 的 vendor path；`Cargo.lock` 随之更新 | — | TASK-E1 |
| `src-tauri/vendor/ironrdp-bulk/` | XCRUSH 内层 MPPC FLUSHED 的收发历史修复；提供只分配 MPPC 的大小估算接口；保留来源与改动说明 | AC-E04/E05 | TASK-E1、TASK-E2 |
| `vendor/ironrdp-server/Cargo.toml` | 加依赖 `ironrdp-bulk = "=0.1.1"`（已在 lockfile 中，由 ironrdp-session 引入） | — | TASK-E1 |
| `vendor/ironrdp-server/src/builder.rs`、`server.rs` | `with_bulk_compression`、`with_encoder_stats_handle`；`RdpServerOptions` 加对应字段；`run_connection_with` 构建 `UpdateEncoder` 时传入 `client_compression` 与开关 | AC-E01/E03/E09 | TASK-E1 |
| `vendor/ironrdp-server/src/encoder/fast_path.rs`、`bulk.rs` | `UpdateFragmenter::next` 接受 `Option<&mut BulkEncoder>`，按 §4.3 写压缩字段；wrapper 管理首次 FLUSHED、四级映射、K8 分片限制与故障禁用；没有压缩器时逐字节与改造前相同 | AC-E01/E03/E05 | TASK-E1 |
| `vendor/ironrdp-server/src/encoder/mod.rs`、`bitmap.rs` | `UpdateEncoder` 加 `bulk: Option<BulkEncoder>`、共享统计；新增 `AdaptiveHandler`、raw/RLE planar 候选及 §4.2 的选择逻辑；resize 重置；奇数宽裁剪按每行字节填写 scan width；仅实际发出的 RemoteFX 推进自身帧状态 | AC-E01/E02/E05 | TASK-E1、TASK-E2 |
| `vendor/ironrdp-server/src/server.rs` `dispatch_display_update` 约 1160–1188 行 | `fragmenter.next(buffer)` 改为带压缩器的版本；写入顺序不变 | AC-E05 | TASK-E1 |
| `src-tauri/src/servers/rdp.rs` `build_server` 约 825–872 行 | `.with_bulk_compression(env TAOMNI_RDP_BULK_COMPRESSION != "0")`、`.with_encoder_stats_handle(...)`；启动日志写一行“RDP display encoding: adaptive planar+bulk / RemoteFX” | AC-E09 | TASK-E2 |
| `src-tauri/src/servers/rdp/metrics.rs` `report_if_due` | “RDP latency:” 行尾追加 `encode=planar:N/rfx:M bulk=XX%` | AC-E09 | TASK-E2 |
| `src-tauri/src/servers/rdp/loopback_tests.rs`、`bulk_loopback_tests.rs` | 保留两个原回环测试；新增四级压缩、无压缩字节兼容、混发、奇数宽裁剪、重激活与重连正确性用例 | AC-E03~E05 | TASK-E3 |
| `src-tauri/src/bin/rdp-probe/session.rs` | `ConnectOptions` 加 `compression`（默认 `rdp61`）；`connector_config` 写入；报告 `negotiated.compression` | AC-E01/E03 | TASK-E4 |
| `src-tauri/src/bin/rdp-probe/rfx_stats.rs`、`session.rs` `pump` | `pump` 在 `active_stage.process` 之前把原始快速路径 PDU 交给 `RfxStats::inspect_fast_path`（现有，约 558 行）。这里拿到的是**压缩后**的数据。`RfxStats` 自己持有一个同级别的 `BulkCompressor` 作为解压器，按 PDU 顺序解压，解压后的数据再走现有的 surface bits / 位图解析。这个解压器与 ironrdp-session 内部那个相互独立，两者看到同一条流、历史一致。报告新增 `bulk.{compressed_updates, bytes_on_wire, bytes_decompressed}` | AC-E09 | TASK-E4 |
| `src-tauri/src/rdp/session.rs` `build_ironrdp_config` 约 2524 行 | `compression_type: Some(CompressionType::Rdp61)` | AC-E07/E08 | TASK-E4 |
| `src-tauri/src/rdp/tls.rs`、`ws.rs` | 用户确认的精确证书 pin 豁免链/主机名匹配，保持 TLS 签名验证；晚到输入不覆盖原始连接错误；对应纯 unit | AC-E07/E08 | TASK-E7 |
| `src-tauri/src/servers/rdp/display.rs`、`capture/mac/sck.rs` | macOS 浅队列持久 ScreenCaptureKit、静态 idle 不退出、自定速源不重复休眠、按 Complete 状态过滤无变化帧；真实 CoreMedia 与 mailbox unit | AC-E01、保留行为 | TASK-E5 |
| `qa-ui-auto-tests/cases/TC-RDPS-PERF-01-performance-budget.testcase.yaml` | 不改断言；在描述里注明探针按 mstsc 方式声明批量压缩 | AC-E01 | TASK-E5 |
| `qa-ui-auto-tests/cases/TC-RDPS-PERF-03-photo-content.testcase.yaml`* | 照片类内容的 M4 不回退（AC-E02）；需要 `rdp_target.py` 新增 `--mode photo` | AC-E02 | TASK-E5 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/rdp_helpers/rdp_target.py` | 新增同算法 photo；固定时钟调度真实绘制与逐秒源遥测；照片两次测量从匹配的初始场景启动 | AC-E01/E02 | TASK-E5 |
| `qa-ui-auto-tests/cases/TC-RDPS-NAT-08-mstsc-interop.testcase.yaml`* | V-17，见 §6 TASK-E6 | AC-E06 | TASK-E6 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/rdp_steps.py`、`rdp_helpers/mstsc.py` | `host_mstsc` 使用 Win32 交互桌面与 owned handles；hosted loopback 文件授权临时恢复；诊断用 PrintWindow，最终图案校验将 owned 窗口放到宿主目标右侧并读取可见 compositor 区域，按窗口和桌面边界裁剪；失败同样清理进程、cmdkey 和授权，保留 owned PID crash 证据 | AC-E06 | TASK-E6 |
| `qa-ui-auto-tests/cases/TC-RDPC-REF-01-termservice.testcase.yaml`*、`TC-RDPC-REF-02-xrdp.testcase.yaml`* | V-21，见 §6 TASK-E7 | AC-E07/E08 | TASK-E7 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/rdp_steps.py`（新 verb `host_copy_file`）、`rdp_steps.py` `PATH_ARGS` 加 `baseline-report` | 把基线目录里的状态文件复制进用例目录；探针基线报告路径在报告根目录内解析 | AC-E02/E07 | TASK-E4、TASK-E7 |
| `.agents/skills/qa-ui-auto/scripts/qa_ui_auto/fixtures/xrdp_server_required.py`*、`fixtures/__init__.py`、`schema/testcase.schema.json` | xrdp fixture（受 DEC-07 影响） | AC-E08 | TASK-E7 |
| `fixtures/rdp_baseline_required.py`、`test_rdp_encoder_tools.py`、`test_native_fixture_cleanup.py` | TermService 首次目标就绪与脱敏启动日志；xrdp 配置、一次性账号与服务恢复；失败/部分 setup 后的 cleanup unit | AC-E06/E07/E08 | TASK-E6、TASK-E7 |
| `.github/workflows/qa-ui-auto-platforms.yml`、`scripts/ci_services.py` | `xrdp` capability 的 apt 安装（受 DEC-07 影响） | AC-E08 | TASK-E7 |
| `qa-ui-auto-tests/ci/policy.yaml`、`qa-ui-auto-tests/feature-list.md`、`.agents/skills/qa-ui-auto/references/verb-catalog.md` | 登记新 case 与 verb；用 `python -m qa_ui_auto.gen_testid_catalog` 重新生成目录 | — | TASK-E5~E7 |
| `docs-feature/rdp-server-parity-design.md` | TASK-11/12、V-13/V-17/V-21、§4.7、§9 回填 | — | TASK-E8 |

## 6. 实现任务与交接

任务顺序：E1 → E2 → E3（E3 的测试骨架可与 E1 并行写）→ E4 → E5 → CI 循环；E6、E7 只依赖现有功能，可与 E1~E5 并行；E8 最后。每个任务完成时在本节对应任务下追加“完成记录”（提交、命令、结果）。

**共同规则（所有任务）**

- 只在分支 `feat/rdp-server-parity` 上工作。
- 不对整个项目跑 `cargo fmt`，只对改过的文件跑 `rustfmt --edition 2024 <文件>`。
- 凭据只走环境变量。
- 在本机访问 GitHub 时使用开发者提供的代理（见本机环境说明），代理地址不写入任何提交的文件。
- 不在开发者本机桌面上驱动 OS 输入或改写剪贴板；需要这类操作的验证放在 CI 里做。

### TASK-E1 批量压缩协商与发送

- 职责与文件范围：`src-tauri/vendor/ironrdp-acceptor/`（新）、`src-tauri/Cargo.toml` patch 表、`vendor/ironrdp-server/{Cargo.toml,src/builder.rs,src/server.rs,src/encoder/mod.rs,src/encoder/fast_path.rs}`
- 输入与必读：本设计 §4.3、数据流表、接口表；`ironrdp-bulk 0.1.1` 的 `bulk.rs`（`compress` 跳过规则、`compressed_data`）、`lib.rs`（flags 常量）、`xcrush/mod.rs` 约 560–660 行（返回值与 FLUSHED 语义）；`ironrdp-session 0.11.0` `fast_path.rs` 约 100–130 行（客户端如何解读标志）；MS-RDPBCGR 2.2.9.1.2.1（`TS_FP_UPDATE` 的 compression 字段）、3.1.8（批量压缩）
- 依赖：无
- 实施内容：
  1. 复制 `ironrdp-acceptor 0.10.0` 到 `src-tauri/vendor/ironrdp-acceptor/`，保留其 `Cargo.toml`。`AcceptorResult` 加 `pub client_compression: Option<CompressionType>`，在 `SecureSettingsExchange` 分支解析：`client_info.client_info.flags.contains(ClientInfoFlags::COMPRESSION)` 时取 `compression_type`。写 `VENDORED.md`。在 `src-tauri/Cargo.toml` `[patch.crates-io]` 加一行，`cargo metadata` 确认 patch 生效（`ironrdp-acceptor` 的 `source` 变为 path）。
  2. `ironrdp-server` 加 `ironrdp-bulk` 依赖。`RdpServerOptions`/builder 加 `bulk_compression: bool`（默认 false）与 `encoder_stats: Option<Arc<EncoderStats>>`。`EncoderStats` 是新的 pub 结构，含四个 `AtomicU64`。
  3. `run_connection_with`：`bulk_compression && result.client_compression.is_some()` 时为编码器建 `BulkCompressor`，类型按 DEC-06 映射：`K8→Rdp4`、`K64→Rdp5`、`Rdp6→Rdp6`、`Rdp61→Rdp61`。
  4. `UpdateFragmenter` 改为在 `next` 时接受 `Option<&mut BulkCompressor>`，按 §4.3 写字段。`dispatch_display_update` 传入编码器的压缩器。由于 `EncoderIter` 持有 `&mut UpdateEncoder`，压缩器要么通过 `encoder_iter` 暴露一个 `bulk_mut()`，要么让 `next` 返回已压缩好的分片序列（二选一，以借用检查能通过、且写入顺序不变为准）。
  5. `set_desktop_size` 和压缩出错时重建压缩器（§4.3 故障边界）；压缩出错时本连接改为不压缩，并记 `warn!`。
- 对应验收：AC-E03、AC-E04、AC-E05（压缩部分）
- 验证与完成条件：V-E02（vendored crate 单元测试）、V-E03、V-E04 通过；`cargo test --lib servers::` 与改造前一样全部通过（改造前 238 passed / 7 ignored，提交 e1af63eb，2026-10-01 本地 Windows）；三端编译通过（V-E11）
- 并行与集成：与 TASK-E3 的测试骨架并行；`server.rs` 与 TASK-E2 共享，E1 先合入

- 状态：done
- 完成记录：提交 `7c88ebf6` 实现 Client Info 协商、每连接 BulkEncoder、四级分片与生命周期；`69ddd766` 修复 XCRUSH FLUSHED 序列与奇数宽。V-E02~E06 的本地 unit、四级 wire/pixel 回环与三端 release unit 已通过；最终统一运行和构建身份见 §8.2。

### TASK-E2 内容自适应选择

- 职责与文件范围：`vendor/ironrdp-server/src/encoder/mod.rs`（`AdaptiveHandler`）、`src-tauri/src/servers/rdp.rs`、`src-tauri/src/servers/rdp/metrics.rs`
- 输入与必读：§4.1、§4.2、DEC-02/03；`encoder/bitmap.rs`（基线有宽度限制，新 bulk 路径按字节写 scan width）；`encoder/rfx.rs`
- 依赖：TASK-E1
- 实施内容：
  1. `UpdateEncoder::new` 中，当协商出 RemoteFX、且连接有批量压缩器时，构建 `BitmapUpdater::Adaptive(AdaptiveHandler { bitmap: BitmapHandler, rfx: RemoteFxHandler })`；其他情况保持原有选择，不改动。
  2. `AdaptiveHandler::handle` 按 §4.2 的伪代码实现。`PLANAR_BULK_GIVE_UP_RATIO = 0.25`；支持任意宽度，仅每行字节数超出 u16 时走 RemoteFX。每次选择后更新 `EncoderStats`。照片开销优化与 raw/bulk 混发规则见 §4.2。
  3. `servers/rdp.rs`：builder 上 `.with_bulk_compression(...)`、`.with_encoder_stats_handle(...)`，并加启动日志；`metrics.rs` 在 “RDP latency:” 行尾追加编码分布与压缩比。
  4. 在离线实验中按最终实现补一个 EXP-06 行（scratch MPPC 估算 + 选择），运行 V-E01，把数字和耗时回填到 §4.1、§4.2。
- 对应验收：AC-E01、AC-E02、AC-E09
- 验证与完成条件：V-E01（离线：UI 场景 ≤4905 kbps，照片场景不高于 EXP-01 A）、V-E05、V-E06、V-E07 通过
- 并行与集成：依赖 E1 的接口；与 E4 的探针改动互不重叠

- 状态：done
- 完成记录：提交 `7c88ebf6` 实现内容选择、单开关回退与统计；`1da27389`、`102a6e00`、`77471a5d` 限制估算成本并优化 raw/RLE planar。当前四段 256 B 采样；V-E01 原型数值偏差 0%，production-vendor 往返与照片带宽通过，最新数字在 §4.1；V-E05~E07 通过。真实三端 UI/照片性能由 E5 验收。

### TASK-E3 回环正确性测试

- 职责与文件范围：`src-tauri/src/servers/rdp/loopback_tests.rs`
- 输入与必读：现有 `round_trip`、`decode_desktop`、`start_server`、`pattern()`；§3 AC-E03~E05
- 依赖：可先写骨架；断言部分依赖 TASK-E1/E2
- 实施内容：
  1. 开工前先单独跑 `cargo test --lib servers::rdp::loopback_tests`，记录现有两个用例的结果。实际已确认二者均通过：默认能力仍包含 QOIZ，原设计对参数列表的解读有误，不需要修正客户端列表或旧断言。
  2. `client_config(codecs, compression)`；新增用例：
     - `mstsc_like_client_without_compression_gets_remotefx_unchanged`（AC-E03）：断言收到的更新全是 surface bits，没有 compression 标志；
     - `bulk_compressed_planar_round_trip_is_lossless`（AC-E05，RDP6.1）：静态 UI 图案，位图部分逐像素相等；
     - `mppc_64k_client_round_trip`（AC-E04）；
     - `mixed_planar_and_remotefx_frames_decode`：服务端显示源依次推送 UI 图案帧与噪声帧，逐帧校验（位图区域误差 0，RemoteFX 区域每通道 ≤24）；
     - `reactivation_resets_compression_history`：中途推送 `DisplayUpdate::Resize`，客户端走完重激活后继续逐帧校验。
  3. 测试显示源需要能按顺序推送多帧。在现有测试显示源基础上加一个帧序列，不改生产代码的显示接口。
- 对应验收：AC-E03、AC-E04、AC-E05
- 验证与完成条件：V-E03~V-E06 通过；去掉批量压缩器的历史重置（人为制造缺陷）时，`reactivation_resets_compression_history` 必须失败，证明测试有效。缺陷验证完撤销，并在完成记录写明做过
- 并行与集成：与 E1/E2 共用 `loopback_tests.rs`，由本任务独占该文件

- 状态：done
- 完成记录：开工旧回环两个 unit 均通过，QOIZ 旧断言保留；新增 `bulk_loopback_tests.rs` 覆盖不声明压缩、MPPC-64K、无损 bitmap、混发、奇数宽、重连与尺寸重激活。两次删除 reset/首次 FLUSHED 的缺陷注入实际失败，恢复并重编后通过（§8.2）。三端 release unit 执行，不在本机运行 browser/native。

### TASK-E4 探针与客户端声明批量压缩

- 职责与文件范围：`src-tauri/src/bin/rdp-probe/{session.rs,rfx_stats.rs,main.rs}`、`src-tauri/src/rdp/session.rs`
- 输入与必读：接口表中的探针 `--compression` 与客户端 `compression_type`；`rfx_stats.rs` 现有解析
- 依赖：无（可在 E1 前完成；服务端不压缩时，探针也能正常工作）
- 实施内容：
  1. `ConnectOptions.compression`，解析 `none|k8|k64|rdp6|rdp61`，默认 `rdp61`；`connector_config` 写入 `compression_type`；报告 `negotiated.compression`。`main.rs` 帮助文本补充该选项。
  2. `RfxStats` 加可选解压器（按 `negotiated.compression` 建），对带 COMPRESSED/FLUSHED 的快速路径更新先解压再解析，统计 `bulk.*`。
  3. Taomni 客户端 `compression_type: Some(CompressionType::Rdp61)`。
  4. 探针单元测试：用 `ironrdp-bulk` 压缩一个合成的位图更新 PDU，交给 `RfxStats` 解压，再与现有 `records_bitmap_update_depth_and_compression` 的断言对照。
  5. `throughput` 场景加 `--baseline-report <path>`：读入另一份 throughput 报告，输出 `vs_baseline.{kbps_ratio, fps_ratio}`（供 TASK-E5 的 PERF-03 使用）。该路径是被测机报告目录下的文件；qa-ui-auto 的 `PATH_ARGS`（`rdp_steps.py` 约 194 行）需加入 `baseline-report`，让它在报告根目录内解析。
- 对应验收：AC-E01、AC-E03、AC-E07、AC-E09
- 验证与完成条件：V-E08、V-E09 通过；对 TermService 跑 PERF-02 时，探针报告 TermService 是否压缩以及压缩比（V-E10）
- 并行与集成：独立

- 状态：done
- 完成记录：提交 `7c88ebf6` 实现探针五种 compression 参数、四级解压/字节统计、实际 marker 帧率与 baseline-report；产品客户端声明 RDP6.1。探针 15 个 unit、session 配置 unit 均通过；V-E10 TermService 的真实压缩证据与最终复测见 §8.2。

### TASK-E5 CI 性能验收与照片场景

- 状态：in_progress（以当前输入的三端 CI 最终证据关闭）

- 职责与文件范围：`rdp_target.py`（`photo` 模式）、`TC-RDPS-PERF-01` 描述、`TC-RDPS-PERF-03-photo-content`（新）、`ci/policy.yaml`、`feature-list.md`
- 依赖：TASK-E1~E4 合入
- 实施内容：
  1. `rdp_target.py --mode photo`：与实验 `photo_desktop` 同一算法（xorshift 噪声 + 平移渐变），每帧更新，并带 `animate` 模式的帧标记。
  2. PERF-03：步骤同 PERF-01 的吞吐部分，但目标窗口用 `photo` 模式。同一个服务端上，探针跑两次：先 `compression: none`（服务端此时不能压缩，按 §4.2 走改造前的纯 RemoteFX 路径，作为基线），再用默认 `rdp61`（自适应路径）。断言第二次的 `kbps` ≤ 第一次的 `kbps × 1.05`（AC-E02）。不改服务端环境变量：qa-ui-auto 的原生被测应用在 `NativeHarness.__enter__` 启动时一次性继承环境（`.agents/skills/qa-ui-auto/scripts/tauri_webdriver.py` 约 1100–1121 行），不支持按用例注入。`assert_json_file` 不能跨文件比较，所以由探针在第二次运行时读入第一次的报告：新增 `--baseline-report <path>` 参数，报告字段 `vs_baseline.kbps_ratio`；用例断言 `vs_baseline.kbps_ratio max 1.05`。
  3. 推送并在三端跑 `qa-ui-auto-platforms.yml`，用例集为全部 RDP 用例（见 V-E12）；失败就修复，再跑，直到 PERF-01 三端全过且其余用例不退化。
- 对应验收：AC-E01、AC-E02
- 验证与完成条件：V-E12 三端结果（逐用例读 `summary.md`；workflow 结论是 success 不代表用例通过）
- 并行与集成：本任务负责编码器部分的整体集成与 CI 循环

### TASK-E6 mstsc 互通用例（V-17）

- 状态：in_progress（以当前输入的三端 CI 最终证据关闭）

- 职责与文件范围：`TC-RDPS-NAT-08-mstsc-interop.testcase.yaml`（新）、`rdp_steps.py` 新 verb `host_mstsc`、`schema/testcase.schema.json`、`verb-catalog.md`、`ci/policy.yaml`、`feature-list.md`
- 输入与必读：上游 V-17（“`cmdkey` 凭据、证书警告抑制；mstsc 完成 NLA 并协商 cliprdr/rdpsnd/drdynvc，服务端日志与截图为证”）；现有 `TC-RDPS-NAT-06-windows-system-rdp-taomni`（Windows 启动与 `platform_choice`）；`rdp_steps.py` 中的 `host_helper`、`host_screenshot`
- 依赖：无（只依赖现有服务端功能；E1~E2 合入后再跑一次，确认 mstsc 在批量压缩开启时正常）
- 实施内容：
  1. `host_mstsc`：`{action: start|stop, port, user, password_env, width?, height?, timeout_sec?}`，仅 Windows，其他平台报 `StepError`。
     - `start` 时：
       - 用 `cmdkey /generic:TERMSRV/127.0.0.1 /user:<user> /pass:<env 值>` 存凭据（密码只从环境变量取，不写日志）；
       - 写 `.rdp` 文件到用例目录，内容包含：`full address:s:127.0.0.1:<port>`、`username:s:<user>`、`authentication level:i:0`（自签证书不弹警告）、`prompt for credentials:i:0`、`desktopwidth/height`、`audiomode:i:0`（本机播放，协商 rdpsnd）、`redirectclipboard:i:1`、`screen mode id:i:1`（窗口模式）；
       - `subprocess.Popen(["mstsc.exe", rdp_path])`，记录 PID。
     - `stop` 时 `taskkill /PID <pid> /T /F`，并执行 `cmdkey /delete:TERMSRV/127.0.0.1`。两者都要在用例清理时执行（`_register_cleanup`），保证失败也会清理。
     - 截图沿用 `host_screenshot`。
  2. 用例 NAT-08（Windows 专用）：
     - 打开 Local servers，配置并启动 Taomni RDP（`platform_choice` 选 Taomni，建凭据库）；
     - `host_helper` 启动 flip 目标；
     - `host_mstsc start`；
     - `assert_text server-log` 依次出现 `RDP client connection from 127.0.0.1`、`clipboard channel ready`、`RDP audio: streaming`；
     - `wait` 5 s 后 `screenshot`（作为 mstsc 窗口画面证据）；
     - `host_mstsc stop`；
     - `assert_text server-log` 出现 `disconnected after`；
     - 停止服务端。
  3. 服务端日志要能看到“mstsc 用了什么编码”：TASK-E2 的 `encode=` 字段落地后，NAT-08 增加 `assert_pattern server-log` 断言 `encode=planar:[1-9]`（mstsc 声明 RDP6.1 时应走 planar+批量压缩）。E2 未合入前先不加这一步，并在用例描述里注明。
- 对应验收：AC-E06
- 验证与完成条件：V-E13 在 Windows runner 通过。如果 mstsc 在无人值守的 runner 上弹出交互对话框（例如证书或凭据提示），把对话框截图作为证据记入失败，并改用 `.rdp` 选项 `enablecredsspsupport:i:1`、`negotiate security layer:i:1` 等组合排查；不要用 UI 自动化去点对话框
- 并行与集成：独立；与 E7 共享 `rdp_steps.py`，各自只追加新 verb

### TASK-E7 Taomni 客户端连参考服务器（V-21）

- 状态：in_progress（以当前输入的三端 CI 最终证据关闭）

- 职责与文件范围：`TC-RDPC-REF-01-termservice.testcase.yaml`（新）、`rdp_steps.py` 新 verb `host_copy_file`（schema 与 verb-catalog 同步登记）、`TC-RDPC-REF-02-xrdp.testcase.yaml`（新，受 DEC-07 影响）、`fixtures/xrdp_server_required.py`（新，受 DEC-07 影响）、`ci_services.py` 与 workflow 的 xrdp 安装（受 DEC-07 影响）
- 输入与必读：上游 V-21；现有 `TC-RDPJ-01-client-server-loopback`（客户端会话创建、认证、证书确认、连接栏步骤可直接复用）；`fixtures/rdp_baseline_required.py`（TermService 账号 `QA_RDP_BASELINE_USER1`、密码 `QA_RDP_BASELINE_PASSWORD`、端口 `QA_RDP_BASELINE_PORT`）
- 依赖：REF-01 无依赖；REF-02 等 DEC-07
- 实施内容：
  1. REF-01（Windows）：fixtures `reset_db`、`rdp_baseline_required`、`release_build_required`。
     - 新建 RDP 会话，主机 127.0.0.1，端口 `${env.QA_RDP_BASELINE_PORT}`，用户 `${env.QA_RDP_BASELINE_USER1}`；
     - 双击连接，`auth-password` 填 `${env.QA_RDP_BASELINE_PASSWORD}`，确认证书；
     - 断言 `rdp-status` 含 Connected；
     - `host_copy_file` 把基线目录的 `flip-state.json` 复制进用例目录，再用 `assert_json_file` 断言 `ready: true`（基线目标在会话内运行，由 fixture 的 Run 项启动；为什么要复制见下方“注意”）；
     - `rdp_canvas_click` 点目标，再复制一次 `flip-state.json` 并断言 `flips` ≥1。目标坐标是 TermService 会话内的 (280,240)；会话分辨率由客户端请求，用例在会话编辑器里固定为 1280×720；
     - 切全屏 → 连接栏可见 → `rdp-bar-quality` 存在（TermService 若下发 Network Characteristics Result 则 `data-level` ≠ 0，否则为 0，两者都接受，但要把实际值记进证据）；
     - 还原，断开。
     - 注意：`assert_json_file` 只接受报告根目录内的路径（`rdp_steps.py` `_within_report`，约 54 行）。而基线状态文件在 `C:\Users\Public\taomni-rdp-baseline`（`rdp_baseline_required.py` 第 39 行 `WORK_DIR`）。这个目录是有意选的：TermService 会话里的一次性账号需要能写入它，fixture 在 CI 上还用 `icacls` 给 Everyone 授了修改权限。所以**不要**移动 `WORK_DIR`。做法是：fixture 在 setup 时导出 `QA_RDP_BASELINE_DIR`（现有）；新增 verb `host_copy_file {from_env_dir, name, to}`，把 `WORK_DIR` 下的指定文件复制进用例目录，再用 `assert_json_file` 断言。该 verb 只允许 `from_env_dir` 取自以 `QA_RDP_` 开头的环境变量，`name` 不允许路径分隔符。
  2. REF-02（Linux，DEC-07 批准后）：
     - `xrdp_server_required` fixture：`apt-get install -y xrdp xorgxrdp openbox`（workflow 中按 `xrdp` capability 执行，fixture 只做检查与配置）；
     - 建一次性用户（`useradd -m`，随机口令写入 `QA_XRDP_PASSWORD`）；
     - 写 `~/.xsession` 启动 `openbox-session` 与 `rdp_target.py --mode flip`；
     - xrdp 监听随机端口（`/etc/xrdp/xrdp.ini` 的 `port=`）；
     - teardown 停服务、删用户、恢复配置。
     - 用例步骤同 REF-01，端口和用户换成 xrdp 的。
- 对应验收：AC-E07、AC-E08
- 验证与完成条件：V-E14（Windows）、V-E15（Linux，DEC-07 后）
- 并行与集成：独立

### TASK-E8 上游设计回填与交付

- 状态：in_progress（以当前输入的三端 CI 最终证据关闭）

- 职责与文件范围：`docs-feature/rdp-server-parity-design.md`、本设计 §4.1/§4.2/§9、记忆文件（agent 本地）
- 依赖：E1~E7；DEC-07 已批准，xrdp 实测纳入完成条件
- 实施内容：
  - 上游 TASK-11、TASK-12、V-13、V-17、V-21、§4.7 首轮记录、§9 AC-16/17/20 写入实际运行号与结论；
  - 本设计 §9 填实际证据；
  - 更新本设计“设计状态”。
- 验证与完成条件：上游与本设计中没有残留“待执行”的已执行项；每条结论都对应可以追溯的运行号

## 7. 自动化测试计划

命令约定：Rust 命令在 `src-tauri/` 目录下执行，qa-ui-auto 命令在仓库根目录执行；shell 为 Git Bash。不要整体跑 `cargo test`（会编译所有集成测试，非常慢），按下列过滤条件执行。

| V ID | AC / 用途 | 层级与文件 / case（* 为拟新增） | 前置数据与操作 | 核心断言 | 命令与依赖 | 改前依据 / 改后结果 |
|---|---|---|---|---|---|---|
| V-E01 | AC-E01/E02 方案选择 | 离线实验 `docs-feature/rdp-server-parity/encoder-experiment` | 合成 PERF-01 条纹场景与照片场景 | UI 场景 F（planar+XCRUSH）≤4905 kbps；EXP-06 自适应在 UI 场景 ≤4905 kbps，照片场景 ≤ EXP-01 A；所有 bulk 分片往返字节相等 | 在实验目录 `cargo test --release -- --nocapture`；另跑 `cargo test --release --features production-vendor -- --nocapture` | 通过：首次整理版偏差失败已保留，恢复原型条件后全部历史值在 ±2% 内；E/F 314/292，生产 E/F 323/312 B/frame；实际 vendor 1 passed，见 §4.1、开发记录 |
| V-E02 | AC-E04/E05 协商 | Rust unit：`vendor/ironrdp-acceptor/src/connection.rs` `client_info_compression_survives_tls_hybrid_and_reactivation` | Client Info 带/不带 COMPRESSION，TLS/HYBRID 与重激活 | `AcceptorResult.client_compression` 为声明值或 None；未声明时不压缩 | `cargo test -p ironrdp-acceptor --lib`；`cargo test --lib servers::rdp::` | 通过：本地 acceptor 1 passed；CI 第四轮三端该 unit 通过；最终三端记录见 §8.2 |
| V-E03 | AC-E03 保留行为 | Rust：`bulk_loopback_tests.rs` `mstsc_like_client_without_compression_gets_remotefx_unchanged` | 客户端 `compression_type: None`，RemoteFX only | 只收到 surface bits；没有任何快速路径更新带 compression 标志；像素在容差 24 内；开关开启/关闭时 wire bytes 相等 | `cargo test --lib servers::rdp::bulk_loopback_tests` | 改前原 RemoteFX 回环已通过；实施后本地 Windows RDP unit 249 passed，含此用例；三端最终结果见 §8.2 |
| V-E04 | AC-E04 | Rust：`bulk_loopback_tests.rs` `mppc_64k_client_round_trip` | `compression_type: Some(K64)` | 解码画面无损部分逐像素相等；服务端统计显示用的是 RDP5 | 同上 | 本地 Windows unit 通过；三端最终结果见 §8.2 |
| V-E05 | AC-E05 | Rust：`bulk_loopback_tests.rs` 中 planar 无损、planar/RemoteFX 混发与奇数宽裁剪测试；vendor 四级 raw/压缩交替测试 | RDP6.1；UI ×3、噪声 ×2、UI ×2；跨尺寸、parent stride | planar 每像素误差 0、RemoteFX 每通道 ≤24；两种编码均出现；raw RFX 不改变 bulk 历史 | 同上；`cargo test --release -p ironrdp-bulk -p ironrdp-server --lib` | 通过：本地 RDP 249 passed / 7 live ignored，bulk 137 / server 22 passed；1 CPU-only unit ignored 已手动执行 |
| V-E06 | AC-E05 | Rust：`bulk_loopback_tests.rs` `reactivation_resets_compression_history`、vendor `desktop_resize_flushes_history_even_when_reusing_the_encoder` | 多帧后 Resize，完成重激活继续推帧；另一用例直接复用 encoder resize | 重激活后首个压缩分片带 FLUSHED、后续逐像素正确；缺陷注入实际失败 | 同上 | 通过：复用 encoder 去 reset、真实网络去首次 FLUSHED 两次缺陷注入均失败；恢复并实际重编后通过，见 §8.2 |
| V-E07 | AC-E09 | Rust unit：`servers/rdp/metrics.rs` 的纯格式化测试 | EncoderStats 填已知计数 | 后缀 ` encode=planar:3/rfx:1 bulk=12%`，原字段顺序不变 | `cargo test --lib servers::rdp::metrics` | 通过：包含在本地 `servers::` 93 passed、RDP 249 passed；原生日志与实际统计见 §8.2 |
| V-E08 | AC-E01/E03 探针 | `src/bin/rdp-probe/` 压缩参数、四级解压统计、独立 AT_FRONT 与吞吐比较 unit | 合成 PDU 与固定报告 | 解压字节等于原始长度；比较实际 marker.observed_fps；独立控制包推进接收历史 | `cargo test --bin rdp-probe` | 通过：改前 10 passed，实施后 15 passed；CI 三端也执行本项，见 §8.2 |
| V-E09 | AC-E07 客户端 | `rdp/session.rs` `connector_uses_client_side_cursor_rendering` 扩展压缩配置断言 | 默认 RdpOptions | IronRDP config 的 compression_type 为 Some(Rdp61)；原客户端自绘光标断言保留 | `cargo test --lib rdp::session::tests` | 通过：本地 RDP 249 passed 包含配置 unit；CI 三端 session unit 通过记录见 §8.2 |
| V-E10 | 对照数据 | native Windows：`TC-RDPS-PERF-02-windows-termservice-baseline` | 探针默认声明 RDP6.1 | 记录 TermService bulk、位图 bpp/压缩方式/矩形像素，不重设预算 | qa-ui-auto-platforms，Windows native | 已执行：运行 36957070003，43.130 kbps、31.895 实际 fps、bulk 解压错误 0；§2 已回填，最终复测见 §8.2 |
| V-E11 | 三端编译 | 本地 Windows `cargo test --lib servers::`；GitHub 三端 release unit 与独立 QA 构建 | 不在本地运行非 unit/native 检查 | 无编译错误，QA identity 与源码一致 | qa-ui-auto-platforms 的三端 RDP unit 与 native build | 本地当前 93 passed；第四轮三端编译通过；最终源码构建证据见 §8.2 |
| V-E12 | AC-E01/E02/E03 + 全部保留行为 | native 三端：全部 RDP 用例 `TC-RDPS-NAT-01..07/09`、`TC-RDPS-PERF-01/02/03*`、`TC-RDPS-UI-01..03`、`TC-RDPJ-01/02`、`TC-RDPS-NAT-08*`、`TC-RDPC-REF-01*` | 见下方命令 | PERF-01 三端通过；PERF-03 的 `vs_baseline.kbps_ratio ≤ 1.05`；其余用例与运行 36864121715、36871090675 的结果相比没有新增失败 | `gh workflow run qa-ui-auto-platforms.yml --ref feat/rdp-server-parity -f scope=selected -f platforms=linux,windows,macos -f modes=browser,native -f case_ids=<上述 ID 逗号分隔>`；下载产物后读每个平台的 `run-*/summary.md` | 改前：功能用例三端全过，PERF-01 三端因 M4 失败（运行 36864121715）/ 待执行 |
| V-E13 | AC-E06 | native Windows：`TC-RDPS-NAT-08-mstsc-interop`* | runner 自带 mstsc.exe | 服务端日志出现连接、cliprdr 就绪、音频推流、断开；截图存档；E2 合入后另断言 `encode=planar:[1-9]` | 同 V-E12 | 待执行 |
| V-E14 | AC-E07 | native Windows：`TC-RDPC-REF-01-termservice`* | `rdp_baseline_required` | 客户端已连接；点击使会话内目标 `flips ≥ 1`；全屏连接栏可见；记录 `rdp-bar-quality` 的 `data-level` | 同 V-E12 | 待执行 |
| V-E15 | AC-E08 | native Linux：`TC-RDPC-REF-02-xrdp`* | `xrdp_server_required`（DEC-07） | 同 V-E14 | 同 V-E12 | DEC-07 已批准，待 CI 实测 |

受影响的保留行为与消费者：
- `UpdateEncoder` 被所有 RDP 连接共用，所以 V-E12 必须跑全部 RDP 用例，而不只跑 PERF。
- 客户端 `compression_type` 的改动影响 Taomni 连接所有 RDP 服务器（包括 Windows、xrdp 和第三方），V-E14/E15 覆盖其中两类。
- 快速路径分片器还承载指针更新：NAT-01 与 RDPJ-01 中的指针 / 光标行为（客户端自绘光标）需要保持。

没有 browser 层的新用例：本次只改 Rust 编码与压缩，浏览器 stub 没有 RDP 服务端，现有 UI-01~03 只作为回归跑。

## 8. 真机验证手册

### 环境与准备

| 平台 | 环境 | 被测构建 | 真实依赖 | 执行方式 |
|---|---|---|---|---|
| Windows | GitHub `windows-2025` x64，WebView2 | qa-ui-auto 的 QA 构建；性能用例用 release QA 构建（`release_build_required`） | 系统 TermService（PERF-02、REF-01）、mstsc.exe（NAT-08）、VB-CABLE（音频用例） | `qa-ui-auto-platforms.yml`，见 V-E12 命令 |
| macOS | GitHub `macos-15` ARM64，WKWebView | 同上 | Screen Recording 权限（runner 已授予）、Background Music | 同上 |
| Linux | GitHub `ubuntu-24.04` x64，webkit2gtk，X11 | 同上 | PipeWire（音频）、xrdp（REF-02，DEC-07） | 同上 |
| 本地 Windows 开发机 | Windows 11 x64 | `cargo test`（debug） | 无 | 只跑 V-E02~V-E09、V-E11；**不**在开发者桌面上运行会注入输入或改写剪贴板的原生用例 |

就绪检查与产物：
- 每轮 CI 结束后，下载各平台 native 产物到 `qa-ui-auto-report/_local/run-<id>/`。在本机下载时走开发者提供的代理，代理地址不写入提交。
- 先看 `summary.md` 的通过 / 失败表，再看失败用例目录中的 `server-log.txt`（PERF-01 的 `save_text` 步骤）、`*.json` 探针报告和截图。
- workflow 结论为 success 不代表用例通过，必须逐用例确认。

### V-E12 三端 RDP 全量回归与性能验收

- 对应验收：AC-E01、AC-E02、AC-E03 及全部保留行为
- 执行前状态：TASK-E1~E5 已合入并推送；`cargo test --lib servers::` 与 `cargo test --bin rdp-probe` 本地通过
- 操作与逐步预期：
  1. 触发 workflow（V-E12 命令）。
  2. 三端 PERF-01 第 27–29 步全部通过。报告 `perf-throughput.json` 中 `rfx.bulk.compressed_updates > 0`、`kbps ≤ 4905`；服务端日志 `server-log.txt` 的 “RDP latency:” 行出现 `encode=planar:`。
  3. PERF-03 两次吞吐都完成，第二次的 `vs_baseline.kbps_ratio ≤ 1.05`。
  4. 其余 RDP 用例与运行 36864121715、36871090675 一样全部通过。
- 故障与恢复：
  - 某端出现客户端 “bulk decompression failed” 断开：先看回环测试 V-E05/E06 能否复现；不能复现时，把该端失败用例的探针日志与服务端日志作为证据，排查分片顺序与重置时机。
  - M4 仍超预算：看 `rfx.bitmaps` 与 `encode=` 分布，判断是不是 RemoteFX 回退比例过高（选择器阈值问题），还是 planar 矩形太碎（合并问题）。
- 证据：运行号、三端 `summary.md`、PERF-01/03 的探针 JSON、`server-log.txt`
- 清理：CI runner 用完即弃；本地只保留 `qa-ui-auto-report/_local/`（已在 gitignore 中）
- 状态：待执行

### V-E13 mstsc 互通（Windows）

- 对应验收：AC-E06
- 操作与逐步预期：NAT-08 启动 Taomni RDP 服务，`host_mstsc start`。服务端日志依次出现连接、`clipboard channel ready`、`RDP audio: streaming`；截图中 mstsc 窗口显示宿主桌面与 flip 目标；`host_mstsc stop` 后日志出现 `disconnected after`。
- 故障与恢复：mstsc 弹出凭据或证书对话框时，截图记为失败证据，按 TASK-E6 的 `.rdp` 选项排查，不用 UI 点击绕过
- 证据：截图、`server-log`、`.rdp` 文件（不含口令）
- 清理：`taskkill` mstsc，`cmdkey /delete:TERMSRV/127.0.0.1`
- 状态：待执行

### V-E14 / V-E15 参考服务器

- 对应验收：AC-E07（Windows TermService）、AC-E08（Linux xrdp）
- 操作与逐步预期：Taomni 客户端新建会话连接参考服务器 → 认证 → 确认证书 → 已连接 → 点击使会话内 flip 目标翻色 → 全屏连接栏出现 → 还原 → 断开
- 证据：截图、`rdp-bar-quality` 的 `data-level` 实际值、复制进用例目录的 `flip-state.json`
- 清理：fixture teardown（基线账号、Run 项；xrdp 用户与服务）
- 状态：V-E14 待执行；V-E15 DEC-07 已批准，待 CI 实测

## 开发记录（2026-10-02，CI 运行号待回填）

- V-E01 已在仓库用 `cargo test --release -- --nocapture` 执行。初次整理版 E/F 与旧值偏差超过 2%，保留失败报告；找到原型后确认两项差异：原型分片为 16352 字节，且模拟的 26 字节位图头位于数据尾部，整理版为生产 16374 字节分片与头部。实验现同时验证原型条件与生产条件；原型 E/F 为 314/292 B/frame，全部旧策略满足 ±2%。生产 E/F 为 323/312 B/frame，自适应 UI 312 B/frame（80 kbps）；照片自适应 188169 B/frame（48171 kbps），与合并矩形 RemoteFX 相同，低于现状逐 tile 的 49170 kbps。
- 估算压缩器独立于发送历史。根据离线 CPU 开销启用 §10 建议的首约 16 KB 采样；照片仍选 RemoteFX。离线性能只证明算法选择，三端 M1–M4 与照片帧率仍等待真实 CI。
- 原有 QOIZ 断言测试改前通过：`client_codecs_capabilities(["remotefx"])` 仍按默认包含 QOI/QOIZ；不需要改变客户端编码能力列表。
- bulk 单元测试 135 passed；acceptor 协商 unit 1 passed；探针 14 passed；前端 RDP unit 58 passed；QA 工具 unit 60 passed。网络回环最终结果与 CI 证据待补。
- 重置缺陷注入：仅移除 `UpdateEncoder::set_desktop_size` 的 `bulk.reset()`，`desktop_resize_flushes_history_even_when_reusing_the_encoder` 实际失败（第 3 包缺少 FLUSHED）；恢复代码后重新执行。真实网络重激活另有独立用例，避免只靠创建新 encoder 掩盖未重置缺陷。
- 新增 TC-RDPS-PERF-03、TC-RDPS-NAT-08、TC-RDPC-REF-01/02，以及 hosted 三平台 unit contracts；未在本机运行 browser/native 自动化。
- 本地日志均在未提交的 `qa-ui-auto-report/_local/encoder-*.log`。CI 最终证据必须包含运行号、实际 summary、像素/探针 JSON 与服务器日志，不能以 workflow success 代替逐用例通过。

### 8.2 GitHub CI 循环记录

- 第一轮运行 [36949925667](https://github.com/engcapa/taomni/actions/runs/36949925667)，源码 `7c88ebf6`：三平台 browser 均为 4 passed / 0 failed / 0 skipped，已读取 summary、receipt 与 ci-outcome。Linux native 的 acceptor/bulk/server unit 为 1/135/17 passed；根库测试链接失败，错误为 `unable to find library -lgbm`，未开始 native cases。补齐 workflow 的 `libgbm-dev`，并将 RDP unit 输出保存为产物中的 `rdp-unit.log`。macOS 同样通过 vendor 的 153 tests，根库 RDP unit 94 passed / 1 failed：`reconnect_creates_a_fresh_bulk_history` 在服务端尚未结束上一连接时立即重连，被单连接接入策略拒绝。测试改为等待 `ConnectionHandler::on_disconnected` 的事件后重连，保留对新压缩历史的断言。Windows native 待真实报告后回填。
- CI 等待期间审查发现两个参考服务器 case 残留对未创建的 `qa-rdp-loopback` 会话的等待，已移除并校正验收编号；xrdp 用例明确关闭 NLA，使用其支持的 TLS/Client Info 自动登录。探针补处理独立 `AT_FRONT` 控制包，回归验证后续 MPPC back-reference 使用已回绕的历史；探针 unit 15 passed（`encoder-probe-history.log`）。
- 后续全量回归增加上游 V-15 的真实 ID `TC-auto-F-Servers-1-servers-dialog`，与原来的 20 个 RDP case 一起选择。
- 第二轮 [36951702144](https://github.com/engcapa/taomni/actions/runs/36951702144)，源码 `d5dc6aa9`：QA 工具 unit 通过；Linux-only 选单包含 4 个仅 Windows 可执行的显式 ID，plan 如实拒绝，未执行 cases。后续按三平台联合选单运行全部 21 个 ID。
- 第三轮 [36952621902](https://github.com/engcapa/taomni/actions/runs/36952621902)，源码 `af8092a2`：三平台 browser 均为 5 passed / 0 failed / 0 skipped。Linux native 为 9 passed / 3 failed / 0 skipped：PERF-01 为 9043.94 kbps，M1/M2/M3 为 61 ms / 32.65 ms / 59.28 fps，大量矩形回退 RemoteFX；PERF-03 使用更新 PDU 数比较帧率导致假失败，实际不同画面帧率比为 40.897/42.793=0.9557；REF-02 的原始连接错误被晚到控制消息的 `ctrl channel closed` 覆盖。以上失败产物原样保留，修复后必须重跑，不能改写成通过。
- Linux 带宽修复：`TS_CD_HEADER.cbScanWidth` 应为每行字节数。bulk 位图路径现填写 `width * 4`，支持任意宽度脏区，避免因非 4 倍数宽度强制回退 RemoteFX。旧非 bulk 路径保持原头部。新增 1/2/3/253/254/255/256 宽、131 高、父 stride 裁剪的逐像素 unit，以及真实 TCP/TLS 回环的 253/255 宽脏区完整帧像素与字节预算断言；vendor 19 passed，根库 RDP 247 passed / 7 live-service ignored。
- 修正 PERF-03 为比较 `marker.observed_fps`（实际不同画面），仍要求比值 ≥0.95、带宽比 ≤1.05。mstsc `.rdp` 使用单 CRLF 与绝对路径；退出前保存窗口诊断。xrdp 在清理前保存服务、Xorg、会话日志；产品保留原始会话错误而不让晚到输入覆盖它。QA 工具对应 unit 13 passed。互通和原生预算仍待下一轮实际报告。
- 第三轮 macOS native 为 10 passed / 1 failed / 0 skipped；PERF-01 的 bulk 压缩数为 0、M3=19.06 fps、M4=6692.34 kbps。PERF-03 原断言表面通过，但实际不同画面帧率比为 14.093/18.159=0.7761，按修正后的口径不能验收。XCRUSH 序列 unit 已复现“不可压缩数据触发 MPPC FLUSHED 后，下一包 COMPRESSED+FLUSHED 被误丢弃，并持续重置”的缺陷；改前失败日志 `encoder-xcrush-flush-before-2.log`，修复后 bulk 136 / server 19 tests 全过。另有 WebSocket unit 验证晚到 refresh/resize 不会覆盖原始 TLS 错误（12 passed / 1 live-service ignored）。这些本地日志位于 ignored 的 `qa-ui-auto-report/_local/`；三端原生性能必须重测。
- 第四轮 [36957070003](https://github.com/engcapa/taomni/actions/runs/36957070003)，源码 `69ddd766`：三端 browser 各 5 passed / 0 failed / 0 skipped；native 为 Linux 10/2/0、Windows 12/3/0、macOS 9/2/0。PERF-01 在 Linux、Windows 全部通过（172.585/476.354 kbps，实际画面 54.782/32.467 fps）；macOS 带宽 306.519 kbps 已达标，但实际画面 19.115 fps 未达 25.6。照片的实际帧率比分别为 Linux 0.829128、Windows 0.703827、macOS 0.786720，不能验收。照片 CPU 优化改为只分配 MPPC 估算上下文、一次遍历生成 raw planar 候选、仅按裁剪尺寸分配输出缓冲，并让已压缩的 RemoteFX 走不推进 bulk 历史的 raw fast-path；四级混发历史与逐像素 unit 均通过，真实性能待下一轮复测。
- 第四轮互通失败原样保留：Linux xrdp 的实际错误为 rustls `NotValidForNameContext`，精确 pin 策略已用改前失败 / 改后通过的纯 unit 补齐；Windows TermService 为 `BadSignature`，补明确 provider 与 TLS 握手阶段诊断，保持签名验证。mstsc 未完成任何通道握手，补可见启动状态、窗口位置与进程/截图错误诊断，仍需真实 CI 证明。
- native runner 此前未执行声明的 fixture teardown，现成功 setup 的 fixture 在关闭 session 后逆序恢复，部分 setup / step / cleanup 失败保留原始错误并继续清理；全 mocked Python unit 通过。下一轮需核对 xrdp 服务、基线账号和音频恢复。
- V-E06 网络缺陷注入：临时将 `BulkEncoder::new` 的 `flush_next` 设为 false，真实 `reactivation_resets_compression_history` 在尺寸重激活后无法取得正确画面而超时失败（`encoder-network-injection.log`）；恢复首次 FLUSHED 信号并更新源文件时间戳使 Cargo 实际重编后，1 passed（`encoder-network-restored-fresh.log`）。另新增断言逐个记录的重激活后首个压缩分片必须带 FLUSHED；先前复用 encoder 的 reset 删除实验仍单独保留。
- 第五轮 [36962712369](https://github.com/engcapa/taomni/actions/runs/36962712369)，源码 `1da27389`：三端 browser 各 5 passed / 0 failed / 0 skipped。Linux native 为 12/0/0，Windows 为 12/3/0，macOS 为 9/2/0（passed/failed/skipped）。Linux PERF-01 为 M1 99 ms、M2 p95 46.333 ms、实际画面 55.471 fps、176.771 kbps，1665 个 bulk 压缩更新且解压错误 0；照片 baseline/adaptive 为 31.774/30.887 fps，帧率比 0.972089、带宽比 0.947461。Windows PERF-01 为 48 ms / 50.768 ms / 32.219 fps / 477.725 kbps，照片帧率比 0.939341 未达 0.95，另有 TermService 链验证 BadSignature 与 mstsc 无可见窗口失败。macOS 为 40 ms / 66.992 ms / 19.341 fps / 300.563 kbps，M2/M3 未达标，照片帧率比 0.778725 未达标。Linux xrdp REF-02 的独立目标记录 flips=1，客户端中心像素从黑变白，全屏 quality_level=0（未测量），fixture teardown 无错误。已核对三端全部 selection、源码/runner/case/build identity 和 receipt 中全部原始文件哈希；失败未改写为通过。
- 第五轮修复：真实 TermService 公共证书的离线 RSA 校验通过；构造同名但错误公钥的系统 anchor 后，精确 pin 的 Rust unit 改前报 BadSignature，改后通过。只在 exact pin、有效期正常、issuer=subject、算法一致且独立自签名验证通过时处理此链错误；损坏签名仍拒绝，TLS 握手签名仍验证。mstsc 改为 Win32 `CreateProcessW` 显式指定 `winsta0\\default`（Python STARTUPINFO 不传 lpDesktop），按 owned pid 枚举可见窗口，并保存 ClientActiveXCore 事件；不点击凭据/证书对话框。macOS ScreenCaptureKit 的 30 Hz 与目标/UI 独立节奏采样存在丢变化窗口，采集上限改为 60 Hz、继续浅队列合并；M2/M3 必须真实 CI 重测。照片采用 §4.2 的四段 4 KiB 估算与按行 planar 写入，EXP-06 的 UI 312 B/frame、照片 188169 B/frame 均未增加；下一轮仍按原帧率/带宽断言验收。
- 第五轮证据检查补齐截图边界：REF-01/02 的 `rdp_canvas_assert` 在独立像素断言成功后保存真实客户端 WebView PNG，与像素/质量 JSON 同名；截图失败不能算通过。mstsc 改用 `PrintWindow` 捕获客户端窗口，避免桌面截屏把置顶宿主目标误算成客户端解码；此改动必须在下一轮 Windows 实测。动画目标新增源帧率遥测，只观察、不修改动画 cadence 或性能预算。对应全 mocked QA 工具 unit 18 passed；workflow 同款 QA 工具 unit 合计 68 passed。尚未把第五轮缺少截图的参考用例结果作为最终视觉验收。
- 第六轮 [36969228597](https://github.com/engcapa/taomni/actions/runs/36969228597)，源码 `102a6e00`：三端 browser 各 5/0/0；native 为 Linux 11/1/0、macOS 9/2/0、Windows 13/2/0。Linux PERF-01 为 119 ms / 41.186 ms / 54.299 fps / 170.269 kbps，照片帧率比 0.921272 未达 0.95。macOS PERF-01 为 40 ms / 68.181 ms / 24.778 fps / 397.291 kbps，M2/M3 未达标；照片帧率比 0.665826 未达标。Windows PERF-01 为 52 ms / 40.697 ms / 33.783 fps / 501.721 kbps，照片帧率比 0.922609 未达标。全部 receipt 的文件哈希与 selection、源码、runner、case、QA 构建身份匹配，失败报告保留。
- 第六轮 Linux xrdp REF-02 已取得 `reference-before/after/fullscreen.png`：目视检查前后黑白翻色与已连接客户端画面、全屏连接栏一致；独立像素断言、目标 flips 和 quality_level=0 与截图对应。第五轮的无截图记录仅作为历史，不代替本轮视觉证据。
- 第六轮修复：真实照片的相关 RGB 平面与带桌面边缘、父 stride 的裁剪加入 CPU-only profiler，分别记录 planar、估算、完整候选与原 RemoteFX 耗时。raw planar 改用便于向量化的固定布局通道循环；采样缩至四段共 1 KiB；MPPC 估算输出只分配输入长度，fresh context 不重复清零。两套离线实验仍各 1 passed，自适应 UI 312 B/frame、照片 188169 B/frame。无压缩 RemoteFX 的旧 reserve/retry 与 bitmap 的旧行数/分配保留，仅自适应路径优化。
- 第六轮 Windows TermService REF-01 通过：独立目标 flips=1，客户端前后黑白像素与真实 WebView PNG 对应；已目视检查全屏连接栏截图，quality_level=0 如实记录为未测量。mstsc NAT-08 仍失败：owned pid=10904，SessionId=2，MainWindowHandle=0，服务端未收到 TCP/RDP 连接，不能将宿主目标的截图算成客户端解码。新增 hosted-only 的 mstsc 启动诊断，在 Rust 构建前保存 TCP 发起结果、全部 owned windows 与线程等待状态，并提前上传原始工件。
- 第七轮 Linux/macOS 运行 [36975299885](https://github.com/engcapa/taomni/actions/runs/36975299885)，源码 `77471a5d`：browser 各 5/0/0；Linux native 11/1/0，PERF-01 为 144 ms / 40.003 ms / 53.596 实际 fps / 169.236 kbps，NAT-01 的 none 与 k64 原生断言通过，照片帧率比 0.936125、带宽比 0.859500，帧率仍未达标。全部已取得报告的原始文件哈希和 identities 匹配。macOS 在新 SDK unit 的三个 `CMTime::new` 调用处报 E0133，未开始 native cases；补 unsafe 构造后以 `f3cf6478` 重跑 [36977624600](https://github.com/engcapa/taomni/actions/runs/36977624600)。Linux CPU-only profiler 的裁剪照片旧/新路径为 7.500/7.775 ms/frame，只作定位证据，不替代 native 帧率。
- mstsc 定位运行 [36978455317](https://github.com/engcapa/taomni/actions/runs/36978455317) 的启动工件已下载并目视检查：两种启动 API 均未发起 TCP，owned 610×183 对话框实际是 Windows 的“Opening Remote Desktop Connection”首次 RDP 文件确认。定位完成后主动取消该单卡构建，不把它记为互通通过。标准 Win32 启动保留；fixture 仅在 GitHub 一次性账号临时写入 `HKCU\Software\Microsoft\Terminal Server Client\RdpLaunchConsentAccepted=1`，在成功、失败和停止异常后恢复先前值或删除本次新建的值。不改开发者账号，不自动点击凭据或证书对话框。21 个全 mocked 工具 unit 通过，原生效果仍须新 CI 证明。
- PERF-03 的两次测量此前从连续动画的不同帧开始，平移渐变会使亮度裁剪与噪声相位不同。用例现对 none 与 rdp61 分别从初始帧重新启动同一算法、同一几何的目标，保留独立 `photo-baseline-state.json` / `photo-adaptive-state.json` 源遥测和解码快照。仍使用同一 release 服务端、10 秒测量，保留实际帧率比 ≥0.95、带宽比 ≤1.05；新增明确的 rdp61 声明断言，旧失败证据原样保留。
- 第六轮 macOS 采集每秒约 56 次，而 UI 动画源约 29 fps；照片源平均约 18.4 fps。SDK 的 `SCStreamFrameInfoStatus` 附件表明 idle 样本也可以保留图像缓冲；旧代码只判断缓冲存在。现按状态过滤非 Complete 样本，并补充真实 CoreVideo/CoreMedia unit，检查带图像缓冲的 Idle/Blank/Suspended/Started/Stopped 均不重发画面。该平台 unit 和 M2/M3/照片帧率必须下一轮实际 CI 验证。

- 第八轮 [36981210337](https://github.com/engcapa/taomni/actions/runs/36981210337)，源码 `e974f9c1`：三端 browser 各 5/0/0，已核对当前输入 identity 与全部 receipt 文件哈希；native 尚在执行。提前上传的 mstsc 启动证据显示 initial 为首次 RDP 文件确认，fixture 则已进入未知发布者资源授权提示，两者 TCP 均为 false；第一处设置已生效，但不能据此判定互通通过。根据 Microsoft [RedirectionWarningDialogVersion 文档](https://github.com/MicrosoftDocs/win32/blob/e103fa4e8810bd8d42c4777e17081e24dbe62dbd/desktop-src/TermServ/imsrdpextendedsettings-property.md) 和 [WindowsProtocolTestSuites 的无人值守设置](https://github.com/microsoft/WindowsProtocolTestSuites/blob/29ddb4238a5443b7499e82934c90cc898861c5e7/TestSuites/RDP/Client/Setup/Scripts/Set-RdpFileSigning.ps1)，CI fixture 临时采用版本 1 的资源授权提示，并只预授权 loopback 的 LocalDevices。三处注册表 value/type 均保存、逆序恢复，部分 setup 失败也恢复；本机不修改。mocked 工具 unit 22 passed，实际 TCP、通道握手与像素证明仍须后续 CI。
- 第七轮单平台补测完成：Windows [36977367532](https://github.com/engcapa/taomni/actions/runs/36977367532)（`8e2d1857`）browser 5/0/0、native 11/4/0；UI 57 ms / 70.806 ms p95 / 33.021 实际 fps / 487.961 kbps，照片帧率比 0.939945、带宽比 0.958465。mstsc 仍受首次文件提示阻挡；REF-01 已显示真实参考桌面，但 90 s 内没有目标状态，之后 PERF-02 的目标等待成功。REF-01 的首次 profile 目标就绪等待调整为 180 s，覆盖已记录的 105–127 s shell 启动，并保留 Run 启动日志与目标原始状态。macOS [36977624600](https://github.com/engcapa/taomni/actions/runs/36977624600)（`f3cf6478`）browser 5/0/0、native 9/2/0；UI 77 ms / 58.684 ms p95 / 23.996 实际 fps / 404.898 kbps，旧连续照片场景帧率比 0.662578。acceptor/bulk/server 为 1/137/23 passed，CPU-only unit 另跑通过，根库 RDP 277 passed / 7 live ignored，探针 15 passed；真实 CoreMedia Idle/Blank 状态 unit 通过。两端全部原始 receipt 与 identity 已核对；这些不同 runner/case 输入的历史结果用于定位，当前验收仍须复测。
- Windows 单卡启动诊断 [36982670416](https://github.com/engcapa/taomni/actions/runs/36982670416)（`abb50fb4`）已取得 initial TCP=false / fixture TCP=true；owned 窗口截图显示诊断监听器关闭后的预期连接错误。这证明 hosted loopback 预授权有效，完整 NAT-08 的协议与像素验收继续执行。
- 第八轮 native 最终原始报告核验完成：Linux 12/0/0，Windows 14/1/0（仅旧 mstsc 资源提示），macOS 9/2/0。macOS UI 为 70 ms / 58.011 ms p95 / 24.387 实际 fps / 393.728 kbps，M3 未达标；照片 baseline/adaptive 为 19.893/20.568 fps，帧率比 1.033912、带宽比 1.041303，匹配初始场景后的照片验收通过。另一失败为 J-02 无 host→client 文本公告，原始主机内容和六秒稳定性断言均通过，继续在当前 CI 验证。全部 receipt 文件哈希和选单 identity 已验证，不用 workflow success 隐藏失败。
- UI 源调度定位：macOS capture/forward 约 56 fps，而探针 marker 只前进约 25 fps；宿主 Tk 动画在绘制后再等待固定 16 ms，累计绘制与事件循环耗时。目标现在显式完成 Tk redraw，按单调时钟的 60 Hz deadline 调度；超过 deadline 时跳过时钟 tick，marker 只计真实绘制，不推算丢帧。新增逐秒 `animation_samples`，保留实际源速率供分析。24 个全 mocked 工具 unit 通过；M1~M4 和照片比值门槛未改，修正后的三端实测仍须后续 CI。
- mstsc 单卡 [36982670416](https://github.com/engcapa/taomni/actions/runs/36982670416) 的 debug QA 原始报告为 0/1/0，receipt、选单和 debug 构建身份均核验。NLA 与 cliprdr/rdpsnd/drdynvc 已通过，`encode=planar:9/rfx:1 bulk=48%`；唯一失败在 PrintWindow 图案校验（magenta=0/cyan=127）。截图是已连接的桌面与条纹动画，连接前创建的图案被本机回环 mstsc 窗口遮挡；用例改为在通道握手后创建并抬起目标。仍只从 owned mstsc 窗口检查两种已知颜色，不能用整个宿主桌面代替客户端画面。

- 第九轮 [36984196978](https://github.com/engcapa/taomni/actions/runs/36984196978)，源码 `6c873255`：三端 browser 各 5/0/0；native 为 Linux 12/0/0、macOS 10/1/0、Windows 13/2/0。UI 四项分别为 Linux 138 ms / 40.321 ms p95 / 54.393 实际 fps / 171.184 kbps，macOS 74 ms / 63.259 ms / 24.170 fps / 387.504 kbps，Windows 29 ms / 42.864 ms / 33.809 fps / 504.603 kbps。三端照片帧率比为 0.993598 / 0.970170 / 0.998166，带宽比为 0.985822 / 0.966403 / 0.992410，均通过；bulk 解压错误为 0。Linux xrdp、Windows TermService 与 macOS J-02 通过。macOS 唯一失败仍为 M3；Windows mstsc 已完成 NLA 与通道协商，但连接后进程退出 `0xC0000005`，原因尚未确定；PERF-02 的真实画面为“已登录用户过多 / 选择要断开的用户”，并非测量动画。全部选单、源码/runner/case/build 身份与 receipt 原始文件哈希已核验，两个 Windows 失败保留。
- TermService 会话限制修复：仅 hosted Windows runner 临时设置并恢复 `fSingleSessionPerUser` 的值和类型；PERF-02 在吞吐账号登录前显式释放本 fixture 创建的延迟测量账号，并轮询确认 slot 消失。新 verb `host_rdp_logoff` 拒绝工作站、继承账号和 runneradmin，失败不写成功证据。部分 PowerShell setup 失败也先登记已创建账号，teardown 只处理本 fixture 拥有的会话；清理失败保留原始 setup 错误并另写 stderr。31 个全 mocked 工具/清理 unit 通过。实际参考性能与所有互通断言须由后续 CI 重测，预算和照片比值门槛均未调整。

- 第十轮 [36986942288](https://github.com/engcapa/taomni/actions/runs/36986942288)，源码 `1afafcb6`：Linux native 12/0/0，UI 128 ms / 43.297 ms p95 / 55.998 实际 fps / 176.558 kbps，照片帧率/带宽比 0.984834 / 0.955343；Windows native 14/1/0，UI 44 ms / 35.979 ms p95 / 32.870 fps / 441.399 kbps，照片比 0.985306 / 0.987450，TermService 通过。Windows 唯一失败为 owned mstsc 进程再次退出 `0xC0000005`：本次 NLA、剪贴板、音频、drdynvc 全通过，像素截图前进程已退出，不能算互通通过。三端 browser 各 5/0/0；macOS native 尚待报告。已核验上述原始 receipt 与身份。
- 为 mstsc 的重复 crash 增加 hosted-only 的 Windows Application Error（按 owned PID 筛选）与 WER minidump；runner 有 CDB 时另保存异常调用栈。DumpFolder/Type/Count 的原值与类型均恢复，工作站不修改。33 个 mocked 工具/清理 unit 通过；诊断不改变 NAT-08 的协议、像素或性能断言，真实原因仍由下一次 CI 工件确定。

- 第十轮 macOS 完成：native 11/0/0，UI 62 ms / 57.607 ms p95 / 38.354 实际 fps / 598.640 kbps；照片 baseline/adaptive 31.748/31.197 fps，比值 0.982638，带宽比 0.990042，bulk 解压错误 0。修正真实 draw deadline 后，M3 与其余性能门槛均通过；整轮仅 Windows mstsc 失败。完整三端原始 receipt 与身份已核验。
- mstsc 诊断运行 [36991919276](https://github.com/engcapa/taomni/actions/runs/36991919276) 在 planner unit 失败：四个旧 mocked 测试未 mock 新 WER 上下文，Linux 的 `GITHUB_ACTIONS=true` 导致导入 winreg；没有执行产品用例。补齐 mock 后同 hosted 环境的 33 个工具/清理 unit 通过，再推送重跑。该失败原始日志保留。

- 第十一轮 [36988038403](https://github.com/engcapa/taomni/actions/runs/36988038403)，源码 `874cd15e`：三端 browser 各 5/0/0，Linux native 12/0/0、macOS 11/0/0、Windows 13/2/0。UI 四项均通过；Windows 照片 baseline/adaptive 实际帧率 15.691/27.282、带宽比 1.652665，未通过；mstsc 进程未退出，但 PrintWindow 图像几乎全黑，两种颜色均为 0。两项失败均保留，不能作为验收通过。
- 第十二轮 [36989986976](https://github.com/engcapa/taomni/actions/runs/36989986976)，源码 `351cbe48`：三端 browser 各 5/0/0；Linux native 11/1/0、macOS 11/0/0、Windows 14/1/0。UI 分别为 Linux 116 ms / 35.779 ms p95 / 54.854 实际 fps / 173.613 kbps，macOS 106 ms / 58.067 ms / 33.588 fps / 515.892 kbps，Windows 50 ms / 49.760 ms / 33.077 fps / 443.193 kbps。照片帧率/带宽比依次为 0.918293/0.922676、0.993767/0.986528、0.978430/0.962941；Linux 帧率失败。Windows 唯一失败仍是 PrintWindow 两种图案颜色均为 0，协议、音频和 TermService 通过。全部原始 receipt 哈希与源码/runner/case/build 身份已核验。
- 照片候选延迟构造的本地 release unit：vendor 24 passed / 1 CPU-only ignored（另行执行通过），lazy sample 与完整候选逐字节一致。CPU-only profiler 的独立采样为 0.067/0.079 ms/frame，完整 planar 加估算为 0.445/0.481 ms/frame；旧/自适应完整编码在无裁剪为 3.656/3.671 ms、裁剪为 3.637/3.414 ms。该定位数据不替代三端实际帧率验收。mstsc 图案截图改为 owned PID 窗口的可见 compositor crop，强制 x≥680，与宿主图案/动画不重叠，并裁剪到桌面边界；两种颜色各至少 200 pixels 的门槛保持，33 个 mocked 工具 unit 通过。两项改动仍须新 CI 验证。

## 9. 验收追踪与交付条件

| AC | 方案位置 | 开发任务 | 验证项与平台 | 所需证据 | 当前缺口 |
|---|---|---|---|---|---|
| AC-E01 | §4.1、§4.2、§4.3 | E1、E2、E4、E5 | V-E01、V-E12（三端） | PERF-01 三端通过的运行号 | 未实现 |
| AC-E02 | §4.2、DEC-02 | E2、E5 | V-E01、V-E12（PERF-03 三端） | `vs_baseline.kbps_ratio` | 未实现 |
| AC-E03 | §4.2、DEC-06 | E1、E3 | V-E03、V-E12 | 回环测试结果、NAT-01 三端 | 未实现 |
| AC-E04 | §4.3、DEC-06 | E1、E3 | V-E02、V-E04 | 回环测试结果 | 未实现 |
| AC-E05 | §4.3、DEC-04 | E1、E3 | V-E05、V-E06 | 回环测试结果 + 缺陷注入记录 | 未实现 |
| AC-E06 | TASK-E6 | E6 | V-E13（Windows） | 截图 + 日志 | 未实现 |
| AC-E07 | TASK-E7 | E7 | V-E14（Windows） | 截图 + `flip-state.json` | 未实现 |
| AC-E08 | TASK-E7、DEC-07 | E7 | V-E15（Linux） | 同上 | DEC-07 已批准，待 CI 实测 |
| AC-E09 | 接口表 | E2、E4 | V-E07、V-E08、V-E12 | 日志行与探针字段 | 未实现 |

交付条件：
- V-E01~V-E14 通过；
- V-E15 按 DEC-07 的结论完成，或以“用户未批准”的能力缺口单列；
- 上游 AC-16（性能）以三端 PERF-01 通过为证据关闭；
- 其余 RDP 用例三端没有新增失败。

只在一端通过的结果不推断为其他端通过。

## 10. 风险、未决项与回退

| 项目 | 影响与依据 | 建议 / 缓解 / 最小验证 | 阻塞的具体任务 | 解除条件 |
|---|---|---|---|---|
| 实测带宽与离线估算差距大 | 离线实验是合成画面；CI 上 Linux 的部分更新频率（约 110 次/s）高于实验的 32 帧/s，压缩历史效果可能不同 | TASK-E5 第一轮 CI 后先看 `bulk` 压缩比与 `encode=` 分布，再调整 `PLANAR_BULK_GIVE_UP_RATIO` 或合并策略；预算本身不放宽 | 不阻塞开工 | 三端 PERF-01 通过 |
| 压缩历史不同步导致花屏 | 一旦服务端多压缩或漏发一个分片，客户端后续画面全错 | §4.2 规定只有发出的字节进入历史；V-E05/E06 逐帧校验，并要求做缺陷注入；出错时本连接关闭压缩并发 FLUSHED | E1、E3 | V-E05/E06 通过 |
| CPU 开销 | 每个 UI 类矩形多一次 scratch MPPC 压缩（估计 1–2 ms/帧，640×360）；照片类再多一次 RemoteFX 编码 | TASK-E2 在 V-E01 中测量并回填；若某端 M2 p95 因此恶化，可把 scratch 估算改为只压 planar 的前 16 KB | E2 | V-E01 耗时与 V-E12 M2 结果 |
| vendored acceptor 维护成本 | 新增一个打了补丁的 crate，升级 ironrdp 时要重新合并 | `VENDORED.md` 写明改动只有一处字段与一处赋值；同时可向上游提 PR（不阻塞） | 不阻塞 | — |
| 原设计怀疑 QOIZ 断言与能力列表不一致 | 开工单独执行原回环 unit，确认通过；`client_codecs_capabilities(["remotefx"])` 默认也包含 QOI/QOIZ | 保留客户端列表与原断言；专有编码另有 INFO_COMPRESSION 条件下逐字节兼容 unit | E3 | 已解除 |
| xrdp 安装（DEC-07） | 需要在 runner 上用 sudo 安装并启动系统服务 | 用户于 2026-10-02 要求按建议执行；已实现 Linux hosted runner 的安装与可恢复 fixture | E7 的 REF-02 | 已解除；仍需 V-E15 实测 |
| EGFX/AVC420 后续方向 | 照片 / 视频类内容的最优解是视频编码；本次只保证不比现在差 | 记录为后续工作；macOS 已有实验路径 `servers/rdp/gfx.rs` | 不阻塞 | — |

**回退。** 批量压缩与自适应选择都由 `with_bulk_compression` 一个开关控制。现场排障可设环境变量 `TAOMNI_RDP_BULK_COMPRESSION=0`，回到改造前的行为（AC-E03 保证逐字节一致）。代码回退就是撤销 TASK-E1/E2 的提交，并移除 `[patch.crates-io]` 中的 `ironrdp-acceptor` 一行。不涉及数据或配置迁移。

**现在可以开始的任务：** TASK-E1、TASK-E3（先跑现有用例并写测试骨架）、TASK-E4、TASK-E6、TASK-E7 的 REF-01 部分。**必须等待的任务：** TASK-E2（等 E1）、TASK-E5（等 E1~E4）、TASK-E7 的 REF-02（等 DEC-07）、TASK-E8（最后）。

