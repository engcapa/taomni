# 移动端短听写：条件性设计与原型

状态：条件性草案。来源为 [实施计划](asr-implementation-plan.md) P4、D7。
PC 的 P1/P2 已有实现和本地测试，八语种质量、真实云服务与跨设备验收仍未关闭；
本稿不宣布移动工程已立项。当前代码基线 `a2ce0304` 加本分支后续 PC 修改。
当前环境为 Linux x86_64，无 adb/安卓设备；不填写虚构 CPU、温度或掉电数据。

## 决策与边界

| ID | 决策 | 状态与依据 |
|---|---|---|
| DEC-M1 | v1 云端短听写，阿里/火山、Deepgram/Soniox；v2 CPU 本地 1–2 线程 | 用户已定，P4；禁止常驻连接和 GPU 默认开启 |
| DEC-M2 | PC P1/P2 验收稳定后启动移动工程 | 用户已定 D7；本稿仅设计/模拟交互 |
| DEC-M3 | 建议 Tauri mobile 共享 Rust provider、模型安装与 TS 草稿语义；独立原生壳为备选 | 待用户决策。前者复用最多但须验证移动音频及构建依赖；后者原生输入集成更直接但维护双套界面 |
| DEC-M4 | 首版应用内语音草稿页，系统键盘扩展另行评审 | 条件性建议；跨应用键盘会改变权限、分发与生命周期，未隐含授权 |

可运行原型：[移动语音草稿](asr-mobile/prototype.html)。360–440px 主视图，支持
开始/停止、900ms 延迟定稿、取消、切换通道、模拟断网、编辑与撤销清理。
它不调用麦克风、识别供应商或原生桥；只能验证状态和交互，不能证明移动性能。
本次复用 PC 的“结果仅入草稿、默认不清理、原文可达”约束；图稿反馈未收集。

## 契约与所有权

- 复用 `voice/streaming.rs::TranscriptEvent`，保留 session_id、text、final_text、processing_ms、provider；平台私有帧不进入界面。
- 移动外壳的音频适配器替代桌面 `voice/capture.rs` 的 cpal；输出 16kHz mono f32、有界约 100ms 分片，最长 120 秒。
- SessionService 持有音频、连接、取消令牌及 final completion；页面仅订阅。录音开始前检查权限和凭据；后台/锁屏/来电时停止采集并关闭连接，不静默恢复。
- 网络失败保留已确认草稿，未确认 partial 不入目标。finish 等确认，最多 15 秒；cancel 立即中断并隔离迟到事件。
- app/custom/none 代理、独立持久化配置、凭据入 Keychain/Keystore；移动系统不支持的代理方式明确报错，不能直连兜底。
- 清理只发送文本给已配置 LLM，off/light/full 默认 off；full-local 过滤云端。原文和草稿撤销收据在会话内保留，不回写用户后续编辑。
- 模型下载由后台任务服务管理；系统允许继续执行时下载不随页面销毁。系统暂停则持久化 .part 和状态，下次前台恢复经 Range 校验续传。只有显式取消才终止任务；App 强杀不能承诺持续下载。
- v2 SenseVoice 仅 zh/yue/en/ja/ko；西/法/意先用云端，不暗示端侧完整八语种。无网时给可操作错误。移动 Whisper 是否提供，必须由体积/内存/温度实测后另作决定。
- iOS 26 SpeechAnalyzer 单独适配评估，核实设备/系统/语种与系统资源下载；低于 iOS 26 使用已选云端。Android SpeechRecognizer 仅显式兜底，不依赖厂商一致性。

## 工作包与验收

| TASK | 文件/职责 | 依赖 | AC / V |
|---|---|---|---|
| M1 | 移动壳骨架、capability 与平台音频适配（拟新增 `mobile/` 或 Tauri mobile 配置） | DEC-M2/M3/M4 | AC-M1 / V-M1 |
| M2 | 复用 PC provider/session，移动 vault 与代理适配 | M1 | AC-M2 / V-M2 |
| M3 | 端侧模型/线程配置、平台下载调度 | M1 与 PC 质量基准 | AC-M3 / V-M3 |
| M4 | 安卓采样器、原始收据、10 分钟三项报告 | 实体低端机 | AC-M4 / V-M4 |

- AC-M1：拒绝录音权限后不建立连接；授权后短听写只填草稿。转后台、锁屏、来电、切换输入均不投递迟到结果。
- AC-M2：四家云端连接行为一致；none 绕过环境代理，custom 失败不直连；静音 5 秒关闭音频会话。用服务器连接日志证明无常驻连接。
- AC-M3：1/2 线程 CPU 模式分别测量，模型按需下载/取消/重启续传及错哈希不覆盖旧模型；无 GPU/NPU 初始化。
- AC-M4：同一低端安卓机做空闲基线、云端和本地各连续 10 分钟短听写循环（每段≤120秒），报告进程 CPU、热传感器温度、电池电量/charge counter 原始序列；不得把桌面或浏览器数字代填。

## 验证方案

V-M1：用原型在 390×844 和横屏验证取消、900ms final、编辑后拒绝覆盖及恢复原文；作为模拟证据。
V-M2：Android 和 iOS 分别真实录音；断网、代理认证失败、无密钥、锁屏后采集与 socket 释放；与同样 PCM 的桌面四供应商转写比较。iOS/Android 均未实测。
V-M3：1/2 线程各跑相同固定语料，记设备 SoC/RAM/OS、量化哈希、冷加载/RTF/端点 final P50/P95 和噪声误触发；无性能结论先验。
V-M4：运行 `python scripts/asr-mobile/measure_android.py --serial SERIAL --package PACKAGE --output REPORT.json`。
采样脚本只读 adb，不修改电量或设备电源状态。先静置 10 分钟取得空闲基线，再在固定屏幕亮度、网络、充电断开、相近初温条件下执行识别循环；每次收集 600 秒。至少重复三轮，轮间冷却，报告充电状态及缺失指标。

桌面共享代码仍须 Windows/WebView2、macOS/WKWebView、Linux/WebKitGTK 构建及录音回归；本轮 Linux Rust/socket 和浏览器证据不能证明其余平台。

## 当前证据与缺口

已有：可运行模拟原型、只读安卓采样脚本、PC 中立事件/四供应商协议实现。
待执行：移动壳决策、平台构建、实体录音、iOS SpeechAnalyzer API 集成验证、低端安卓三项 10 分钟数据。
这些条件解除前，P4 为“设计/模拟原型已交付、实测未完成”，不能标记移动功能完成。
