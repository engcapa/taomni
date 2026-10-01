# VNC-PERF-001 / 002 解码与更新流水线（P1 设计与交付记录）

- 卡片：[backlog VNC-PERF-001 / 002](backlog.md)；总体设计 [§6](alignment-design.md#vnc-perf-001)。
- 参照：[实机参照 §5](references/realvnc-live-audit-20260930.md#measurements)。
- 基线：`383aa4f2`。

<a id="current-facts"></a>
## 1. 基线事实

| 事实 | 位置 |
|---|---|
| `RfbConnection::read_exact` 直接读 `TcpStream`；`read_u8/u16/i32` 与 Hextile 每个子矩形字段都是一次 syscall。 | `rfb.rs` I/O helpers、`RfbStreamReader` |
| `read_hextile` / `read_zrle` 为每个 16×16 / 64×64 tile 分配 `Vec` 并返回 `DecodedRect`，`write_to_fb` 再逐行复制；relay 为每个 tile 再拼一次 12 字节头。 | `encodings.rs`、`rfb.rs::write_to_fb`、`ws.rs` vnc_read |
| 前端单帧最多缓存 4 096 个矩形，超过即丢弃并请求全量刷新；1680×1050 Hextile 全屏为 6 930 个 tile。 | `VncPanel.tsx` `MAX_PENDING_RECTS` |
| 增量请求在前端 ACK 后才发（`VncControl::Ack => request_update(true)`）；帧邮箱被新帧替换时请求全量刷新。 | `ws.rs` 控制循环、`queue.rs::finish_frame` |

<a id="design"></a>
## 2. 设计

### 读缓冲（PERF-001）

`ReadBuffer`（256 KiB）只在 `enter_runtime_mode` 且无 RA2 安全层时启用，握手阶段所有读仍直达 socket，避免子协议字节被提前吞入。剩余需求 ≥ 缓冲容量时直接读入目标（ZRLE 压缩体、Raw 大矩形零额外复制）。缓冲同时累计运行期线上字节，供 SESS-002 使用。

### 整矩形解码与权威帧缓冲（PERF-001）

- 新模块 `framebuffer.rs`：`Framebuffer`（RGBA，受 `DecodeLimits` 约束）、`blit`、重叠安全的 `copy_rect`、`relay_frame(rect)`（直接生成 12 字节头 + 行数据）；`Damage` 合并相接矩形（合并面积 ≤ 1.25×）并在超过 16 个时收成包围盒。
- `decode_raw_into / decode_hextile_into / decode_zrle_into` 写入 `w*h*4` scratch（步长 `w*4`），`RfbConnection` 每个服务器矩形加锁一次 blit；CopyRect 在帧缓冲内移动；DesktopSize 重建帧缓冲并把 damage 设为整屏。
- `ServerMessage::FramebufferUpdate.rects` 变为 damage 矩形（不再携带像素）。

<a id="pipeline"></a>
### 请求流水线与背压（PERF-002）

`ws.rs` 的 `FrameFlow { damage, frontend_ready, last_ack, request_deferred, frames_sent }`：

1. 解码线程送来更新 → damage 并入；若 `frontend_ready` 或距上次 ACK < 1 s，立即 `request_update(true)`，否则记 `request_deferred`。
2. `frontend_ready` 时 `flush_frame`：取出 damage，从帧缓冲读出最新像素作为一帧，置 `frontend_ready=false`。
3. ACK：`frontend_ready=true`，立即 flush 累积 damage；若有延迟请求则补发。
4. Refresh：视为就绪，整屏 damage 立即重绘并向服务器请求全量。
5. 尺寸变化：清空队列中的旧帧与 damage，发 `desktop_size`（critical），就绪置真，由随后的整屏 damage 重绘。

WS 线协议不变，前端无需改动即可获得新行为；`MAX_PENDING_RECTS` 仍作为防御上限。

<a id="tasks"></a>
## 3. 任务

| TASK | 内容 | 文件 |
|---|---|---|
| TASK-PERF-001-01 | 运行期读缓冲、线上字节计数 | `rfb.rs` |
| TASK-PERF-001-02 | 整矩形解码 API 与单测改写 | `encodings.rs` |
| TASK-PERF-001-03 | 权威帧缓冲、damage 合并 | `framebuffer.rs`、`rfb.rs` |
| TASK-PERF-001-04 | 实测/回放基准 | `live_bench.rs` |
| TASK-PERF-002-01 | FrameFlow、flush、ACK/Refresh/DesktopSize 路径 | `ws.rs`、`queue.rs::clear_frames` |

<a id="test-cases"></a>
## 4. 测试

- 单测：`framebuffer::tests`（blit/relay 往返、CopyRect 重叠、damage 合并与上限、包含关系）、`encodings::tests`（Raw alpha、Hextile 步长与跨 tile bg、ZRLE 持久流/大输出）、`rfb::tests::buffered_runtime_reads_decode_many_small_hextile_tiles`、`runtime_mode_clears_the_handshake_read_timeout`（缓冲开关）。
- 回放（V-VNC-01）与实测（V-VNC-02）：命令见 `live_bench.rs` 文件头；录制帧放 `qa-ui-auto-report/vnc-perf/`（含屏幕像素，不入库）。
- native（V-VNC-03）：release 应用连回环代理，观察请求节奏、隐藏暂停与恢复。

<a id="results"></a>
## 5. 结果（2026-09-30，Windows 11，release）

| 指标 | 基线 | 交付后 | RealVNC 7.15.1 |
|---|---|---|---|
| 回放解码 Hextile / ZRLE / Raw（1680×1050，中位数） | 499 / 70 / 24 ms | 22.8 / 55 / 28 ms | 不可单测 |
| 全屏 relay 矩形数 Hextile / ZRLE | 6 930 / 459 | 1 / 1 | — |
| 实测全屏刷新 ZRLE / Hextile / Raw | 570–613 / 785–822 / 634–655 ms（debug 实测） | 485–509 / 565–573 / 614 ms | Hextile 565–574 ms |
| 全屏线上字节 ZRLE / Hextile | 2.78 / 6.48 MB | 同左 | Hextile 6.76 MB |

Raw 回放中位数 28 ms 对 24 ms 在 release 回放的抖动范围内（最佳值 18.6 ms 对 13.7 ms），Raw 只在服务器不支持其他编码时使用；PERF-003 继续跟踪。
