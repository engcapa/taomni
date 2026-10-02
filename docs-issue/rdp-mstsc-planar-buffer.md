# mstsc planar 解码崩溃及后续 QA 数据库锁定

对应 `.github/workflows/qa-ui-auto-platforms.yml`、`AC-E06 / V-E13` 和保留用例
`TC-RDPS-NAT-08-mstsc-interop`、`TC-RDPS-NAT-03-clipboard-files`、
`TC-RDPS-PERF-01-performance-budget`、`TC-RDPS-PERF-03-photo-content`。

## 改前证据

- Windows run [37010864637](https://github.com/engcapa/taomni/actions/runs/37010864637)，
  源码 `ba884490`：NAT-08 的 owned mstsc PID 7588 在
  `mstscax!DecodeRLEBytes+0x1ba` 写入 PageHeap guard page，异常 `0xC0000005`。
  解码矩形为 64×255，颜色平面长度 `0x3fc0`；第二平面起点
  `0x241fd0702c0`，在 `0x241fd074000` 越界。
- 对应 Microsoft symbol server 的 `mstscax.dll/8993743E8b7000`：
  `CTSCoreGraphics::ProcessBitmapRect` 首次分配两块 `0x7d00`（32,000）字节缓冲。
  dump 中临时缓冲起点为 `0x241fd06c300`，与越界地址相差正好 32,000 字节；
  传给 planar 解码器的容量却是 `0x40000`。混合 RemoteFX/Bitmap 会话不能用
  u16 的最大值作为安全解压尺寸。完整压缩数据不在 mini dump 中；此前独立
  FreeRDP 解码通过不能证明 mstsc 的缓冲区行为。
- 随后的两个 PERF 用例在 **setup/reset_db** 报 `WinError 32`：
  `local-history/history.db` 仍由 Taomni PID 6964 打开。
  NAT-08 清理耗时 7.375 秒；收集 mstsc 崩溃信息消耗了提前创建的 5 秒
  WebDriver deadline，导致关闭请求尚未发送就超时。Linux `/proc` 清理路径
  无法收回 Windows 进程。

## 修复与保留行为

- BitmapEncoder 按每矩形 **解压后不超过 32,000 字节** 分块，raw planar 的
  惰性采样使用同一分块规则。保留父 stride、最后一行、坐标、压缩头能力、
  RLE/raw 选择及 bulk 历史。超过单行上限的自适应更新沿现有路径使用 RemoteFX。
  这是 mstsc 兼容性限制，不是将 32,000 字节声明为协议通用上限。
- `NativeSession.close()` 独立获得 5 秒关闭预算；即使 POST 没返回 session ID，
  仍关闭传输并调用 owner 清理。Windows 在下一个 fixture reset 前终止本次
  driver 拥有的进程树，随后重启 driver；不按进程名称清理。关闭错误记入报告，
  保留原用例失败；不会把清理失败报为通过。
- 复用并补充 NAT-08 的大矩形描述；继续检查真实 mstsc 已解码颜色、音频、
  clipboard/drdynvc 及断开。PERF 的延迟、帧率、带宽预算不变。

## 验证记录

- 新增尺寸回归在改前输出 64×255 时失败，改后通过。覆盖 RLE/raw、压缩头有无、
  父 stride 裁剪、跨块像素和坐标，以及 8K 宽度的 RemoteFX 回退。
- Windows vendor server unit：28 passed / 0 failed / 1 ignored（CPU profiler）。
- 独立 FreeRDP 解码：1,600 个 bulk 包、144 张位图 / 736 个矩形，字节和 RGB
  全部一致；不作为真实 mstsc 互通验收。
- 关闭预算和半启动会话的回归均先失败后通过。Windows 原生进程探针验证：
  owned 子进程独占的测试文件可以在清理后删除，无关进程仍存活。
- workflow 同款 Python 工具检查：123 tests，121 passed / 2 平台条件 skip。
- 修正后的三平台实际 native、mstsc 和性能结果待回填；旧 macOS/Linux 通过记录
  不作为本次源码的验证结果。
