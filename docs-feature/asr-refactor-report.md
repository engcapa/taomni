# ASR 实现评估与重构决策

评估基线：本次 Whisper 重构之前。交付状态与验证见 [voice-input-delivery.md](voice-input-delivery.md)。本报告的基线缺陷不代表重构后的现状。

## 基线结论

原有 ASR 有界面、配置和 IPC 骨架，但尚未形成可运行的本地识别闭环。不宜用一个百分比将界面存在与识别可用混为一谈。

| 层 | 基线实现 | 缺口 |
| --- | --- | --- |
| 采集 | cpal 采集与重采样 | 默认 feature 未启用；流跨线程的 unsafe Send/Sync 包装；取消/错误恢复不完整 |
| 识别 | sherpa 接口与 manager | 实际 decoder 固定返回错误；没有真实推理依赖 |
| 模型 | 通用下载器、manifest | ASR 权重哈希为零；压缩包未变成 recognizer 可用的模型文件 |
| 设置 | active/providers/warm/VAD 配置 | 显示的选项超出运行时能力，模型准备与切换未形成闭环 |
| 输入 | 标题栏 PTT 与 intent 分发 | Chat 内无直接入口；旧异步结果可能进入错误上下文 |
| 测试 | 浏览器按钮显隐用例 | 无真实 WAV 解码和麦克风端到端证据 |

相关基线模块为 `src-tauri/src/asr/`、`src-tauri/src/voice/`、`src-tauri/resources/models.manifest.json`、`src/components/settings/AsrPanel.tsx`、`src/components/window/PttButton.tsx`。

## 外部参照与选型

编程 agent 使用的推理 LLM 与将语音转成文本的 ASR 是不同组件，不能因为某工具使用 Claude/GPT，就推断其语音输入也使用同一模型。

| 参照 | 值得采用的做法 | 本项目取舍 |
| --- | --- | --- |
| [Kiro CLI](https://github.com/kirodotdev/kiro) 的本地语音实现 | Whisper Rust 接入，模型按需获取，语音活动检测 | 采用本地 Whisper 与按需下载思路；本轮不声称实现其 VAD 或完整流式体验 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [whisper-rs](https://github.com/tazz4843/whisper-rs) | 跨平台 C/C++ 推理、Rust 封装、官方 GGML 权重 | 首个实际接入的推理引擎 |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | 真正的流式 ASR、多模型、端点检测 | 可作为后续低延迟方案；删除本项目未实现的空适配器，避免继续宣称可用 |
| [FunASR](https://github.com/modelscope/FunASR) | 中文识别、热词、标点与语音处理生态 | 后续中文/中英代码词汇基准的候选，不与第一阶段同时维护多个引擎 |
| [Claude Code voice mode](https://code.claude.com/docs/en/voice-mode) | 录音状态可见，转写融入输入框 | 参考交互；不把未公开的底层 ASR 模型当作选型依据 |
| [Codex CLI](https://developers.openai.com/codex/cli/) | 文本草稿、工具执行与用户输入边界 | 本报告没有可确认其内部 ASR 型号的证据，不据此指定语音供应商 |

开源许可证必须以每个实际发布权重及引擎的上游许可证为准。旧 manifest 的许可证标注不能当作 SenseVoice 或其他模型的授权结论。

## 已采用的分发决策

- 默认发行构建包含 cpal + whisper-rs 运行时，不把 148 MB 至 1.5 GB 的权重塞进所有安装包。
- 默认多语言 Base：147,951,465 字节。首次使用明确点击下载，或者导入官方 `ggml-base.bin`。
- 提供多语言 Small（487,601,967 字节）、Medium（1,533,763,059 字节）下载/选择。更大模型不等于一定更适合每台设备，需要结合准确率、内存和时延决定。
- 下载来自 [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main)。文件大小和 SHA-256 固定在 `asr/catalog.rs`；每次冷加载、导入、下载结束都校验。
- 不隐式走第三方镜像，不在启动时联网获取模型，不用云端 ASR 静默兜底。网络受限时使用离线导入。
- 模型权重下载与软件安装包分离；既支持切换更大的模型，也支持随应用目录发布的同模型新权重，显示待更新并显式安装。不同哈希保存到不同目录，不自动追踪上游 latest。
- 离线部署可另行分发经校验的 `.bin`，无需再维护另一套推理路径。

## 本轮重构边界

采集、识别、模型安装、输入消费者分层。引擎只接收 16 kHz 单声道 PCM 并返回文本；不调用 LLM。每次录音有独立 session ID，取消/配置变化/上下文变化丢弃旧结果。模型切换重建 manager，冷加载和识别在阻塞工作线程运行，cpal 流在创建它的专用线程销毁。

统一 DictationButton 支持 Chat、标题栏、LAN 消息输入和终端 AI 改写说明。转写结果只填入可编辑文本，用户显式发送或提交；不直接向终端注入命令，也不改写密码字段。

第一阶段是单击录音、再次单击停止后批量识别，最长 120 秒，CPU 本地推理；x86 使用经运行时检查的 AVX2/FMA/F16C/SSE4.2 基线，ARM 使用其 CPU 后端。尚不包含流式 partial、VAD、热词、模型删除、GPU 加速、全局系统听写快捷键或自动发送。

## 后续优先级

1. 真机验证 Windows/macOS/Linux 的麦克风权限、默认设备、蓝牙设备、取消和 120 秒限时；性能按具体硬件记录。
2. 建立中文、英文、中英混合、路径/代码术语、噪声、静音的固定音频集，记录 CER/WER、耗时及峰值内存；当前中文和英语样本只是可用性检查，不能代表不同口音和噪声条件的完整质量基准。
3. 根据测量结果增加 VAD/端点检测和空闲卸载；先控制无语音幻觉与资源占用，再决定是否需要流式引擎。
4. 下载取消和断点续传已在后续迭代补齐；继续增加模型删除、显式镜像源与企业离线包；所有路径继续使用相同哈希校验。
5. 只有具备同等测试和生命周期契约时，才公开第二个本地引擎或显式云端选项。
