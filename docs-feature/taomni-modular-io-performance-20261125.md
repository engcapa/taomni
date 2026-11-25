# AC-013 终端 I/O 与模块安装耗时

2026-11-25，Linux x86_64。对 M0 追加采样的真实 DEB 与冻结候选做了 10 轮配对测量。两者的 PTY 输入往返 p95 同为 2 ms，1 MiB 输出吞吐中位数同为 9.52 MiB/s。同一历史签名包的离线安装中位数由 153.5 ms 降至 138 ms。本次 Linux 负载下未发现可重复的吞吐退化。设计没有为这两项单列数值放行线。[最终原始样本](https://github.com/engcapa/taomni/actions/runs/45581787980/artifacts/15007271247)

| 测量 | 每个构建的样本量 | M0 | 0.6.0 候选 |
| --- | ---: | --- | --- |
| PTY 输入到 WebView 收到应答 | 300 | 中位 1 ms，p95 2 ms，范围 0–8 ms | 中位 1 ms，p95 2 ms，范围 0–6 ms |
| 1 MiB PTY 输出到 WebView 收齐 | 120 | 中位 9.52 MiB/s，范围 7.69–11.90 | 中位 9.52 MiB/s，范围 7.04–11.24 |
| MFA 0.1.0 离线签名安装 | 50 | 中位 153.5 ms，p95 174 ms，范围 120–191 ms | 中位 138 ms，p95 146 ms，范围 107–159 ms |

## 身份与边界

- M0 文档在 11 月 15 日记录构建与依赖，11 月 17 日追加四目标原始安装件，当时没有记录这两项运行耗时。本次使用追加采样提交 `1eec7eca4ede44e9266d927674c4c7ea5f38ffe1`，DEB SHA-256 为 `7a59a7a2f9e37ca5bebe92d756201a26893f942bfa90254c8db6160699068431`。这是已有模块离线安装接口的过渡构建。[M0 报告](taomni-modular-split-baseline-20261115.md) · [M0 安装件](https://github.com/engcapa/taomni/actions/runs/43997809941/artifacts/14293785052)
- 候选提交 `5e53df106549b9fa8a49e435120fc820c8e608ca`，DEB SHA-256 为 `a7fb58d6d742d117bc362fcc3d38fd774f3ba560cf31314fe65375859fdbfd5c`。每次重装后核对落盘 executable 与 DEB 中字节。每组使用同一台 Ubuntu 24.04 x86_64 GitHub runner、1920×1080 Xvfb、WebKitGTK、新建隔离目录和同一真实 PTY 脚本。每对交替先运行 M0 或候选。[候选安装件](https://github.com/engcapa/taomni/actions/runs/45556290903/artifacts/14998276328) · [测量任务与 runner](https://github.com/engcapa/taomni/actions/runs/45581787980/job/139093373164)
- 终端输入计时从 renderer 写入开始，经过实际 80×24 本地 PTY、后台子进程应答，至 renderer 收到完整标记。每次启动先预热 5 次。吞吐每次先预热一个 1 MiB 请求，再校验 12 个 1 MiB 固定字节流及尾标。统计范围至 WebView 接收完成，屏幕绘制和远程 SSH 链路在范围之外。0 ms 的输入样本受 WebView 时钟分辨率限制。[探针源码](https://github.com/engcapa/taomni/blob/0e54b05b151f3cd583f2d52d85018641a82b74a3/.agents/skills/qa-ui-auto/scripts/modular_io_probe.js)
- 安装计时从 renderer 调用生产离线安装接口到返回已安装身份与版本，含验签、解包、注册，每次完成后卸载并保留数据。输入为同一官方签名 Linux MFA 0.1.0 包，1,898,135 字节，SHA-256 为 `e0cb552e3d6a8c086fe302ac1df4df631dc4269f5d93379cc1ecb24c650b1c53`。网络下载、十模块首升事务和单体应用升级耗时另行验收。[历史签名工件](https://github.com/engcapa/taomni/actions/runs/44198966336/artifacts/14379924062)

## 重复性与先导结果

最终 10 对中，候选的吞吐中位数有 6 对较低、4 对较高。每对取候选除以基线的中位吞吐，再对 10 个比值取中位数，差异为 −1.22%。按对重采样 10,000 次取得的探索性百分位区间为 −6.24% 至 +3.47%。该范围描述此次同机抖动，不能据此承诺任意平台或负载的等效性。[逐样本回执](https://github.com/engcapa/taomni/actions/runs/45581787980/artifacts/15007271247)

- 第一轮五对的吞吐中位数为 11.76 与 11.63 MiB/s。首发 MFA 0.1.2 在候选完成 25 次，安装中位 119 ms、p95 127 ms。M0 解析器拒绝该包清单新增的 `description` 字段，故该轮只记录候选的绝对安装时间。[第一轮原始数据](https://github.com/engcapa/taomni/actions/runs/45579387527/artifacts/15005362797)
- 改用双方均支持的 MFA 0.1.0 后，第二轮五对的安装中位数为 117 与 102 ms。吞吐中位数为 12.35 与 10.75 MiB/s，候选低 12.9%。最终复验扩至 10 对，标记检测改为仅查看新数据和前一块末尾，免除每次回调重扫全部已收字节的测量开销。这一差距未在复验中重现。各轮独立统计。[第二轮原始数据](https://github.com/engcapa/taomni/actions/runs/45580626871/artifacts/15005339016)
- 首次探针调用未按产品协议对输入做 Base64 编码，退出于输入校验。修正后开始上述计时。[首轮工具诊断](https://github.com/engcapa/taomni/actions/runs/45578851854)
