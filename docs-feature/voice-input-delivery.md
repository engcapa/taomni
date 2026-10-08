# 本地语音输入交付与验证

## 使用方式

默认桌面构建已启用 `voice-capture` 和 `asr-whisper`。首次点击麦克风进入语音设置，点击 Base 下载（约 148 MB），或导入对应官方 `ggml-base.bin`。下载/导入完成后关闭设置，再次点击麦克风开始录音；再次点击停止并识别。语言可自动检测或指定中文等。

可在 Chat 输入框、标题栏当前 Chat 草稿入口、局域网消息输入框、终端 AI 改写说明框使用。Small（约 488 MB）和 Medium（约 1.53 GB）安装完成后点击“使用此模型”，无需重启。每个入口都只产生可编辑草稿，不自动发送或执行。

Esc/取消、切换目标上下文、窗口失焦、关闭入口、AI 总开关关闭、模型或语言变化都会取消本次语音。Chat 发送现有草稿后，尚未返回的转写不会写入下一条消息。单次录音上限 120 秒。全局只允许一个录音/识别 session。

## 分发与资源

- 权重首次显式下载，不捆绑到安装包；来自 Hugging Face 官方 whisper.cpp 权重仓库，MIT 许可证。下载仅获取权重，不上传音频。
- 支持离线导入，不接受任意模型格式；文件大小及 SHA-256 必须匹配内置 Base/Small/Medium 目录。不要导入 `.en`、量化版或 `.gguf` 代替这里的多语言 `.bin`。
- 文件位于系统缓存目录下 `taomni/models/whisper-{size}/{sha256}/ggml-{size}.bin`。缓存被系统清理后需要重新下载/导入。
- 模型按需加载，连续听写复用已加载模型。更换模型/语言或关闭 AI 会释放旧 manager；正在退出的任务完成后才释放其引用。尚无空闲定时卸载。
- 音频只存内存，不保存录音文件；文本进入原有草稿/聊天持久化流程，发送后遵循所选聊天提供商的既有行为。ASR 本身始终本地运行。
- CPU 构建关闭 `GGML_NATIVE`，避免继承编译机的 AVX512 等专属能力；x86 使用标准 AVX2/FMA/F16C/SSE4.2 档，启动识别前检测，不满足时明确报告不支持。ARM 使用其 CPU 后端。本轮无 GPU、VAD 或实时逐字输出。
- 下载可选择应用级代理（默认）、独立配置或 No proxy；独立配置复用 Settings UI，详见 [下载代理](voice-download-proxy.md)。
- 下载支持取消与断点续传；取消/网络失败保留 `.part`，再次下载自动请求 Range，不支持 Range 时从头下载，最终通过 SHA-256 后才成为可用模型。各模型提供可复制及浏览器打开的固定版本地址；尚无模型删除 UI。详见 [下载进度与续传](voice-download-progress.md)。


## 中文与模型数据更新

Base/Small/Medium 都是多语言权重，不是 `.en` 英语专用版；全部支持中文，因此切换语言不重复下载。中文短句建议显式选择“中文”，准确率不足再安装并选择 Small/Medium。更大模型的中文质量和速度仍需你的设备实测。

模型目录随应用版本发布，设置中的“检查版本与完整性”比较当前应用支持的权重哈希并校验已下载文件，不联网搜索上游任意新模型。应用目录升级而权重哈希未变时无需重新下载；哈希变化且存在旧缓存时显示“有新版模型数据”。用户显式点击更新或导入之后，大小/哈希校验通过才发布到新版本目录，原版本继续保留。下载中断或校验失败不删除旧版；新应用仍要求安装它支持的版本后才能识别，不会未经兼容性验证自动加载旧权重。降低应用版本时旧数据仍可复用。当前不自动清理旧目录，也不提供模型版本降级 UI。

下载 URL 固定到 Hugging Face 仓库修订 `5359861c739e955e79d9a303bcbc70fb988958b1`，避免跟随可变的 `main`；目录版本为 `2026-10-whisper-1`。维护者更新步骤见 [模型目录维护](asr-model-catalog.md)。

## 自动化验证

本轮实测结果记录于文末。浏览器 fixture 通过 `?voiceFixture=1` 显式开启，只位于 `src/stubs/`；正式桌面不会调用。它不代表真实麦克风、网络下载、文件选择器或推理能力。

前端定向命令（使用 `pnpm exec` 直接传过滤文件）：

```bash
pnpm exec vitest run src/components/voice/DictationButton.test.tsx src/components/voice/VoiceConsumers.test.tsx src/components/settings/AsrPanel.test.tsx src/components/chat/Composer.test.tsx src/components/lanchat/LanChatConversationUi.test.tsx src/components/window/TitleBarTrayControls.test.tsx src/stores/aiStore.test.ts
pnpm build
```

浏览器用例 `TC-VOICE-001` 覆盖显式安装、升级、语言持久化、标题栏/Chat 草稿回填及取消；`TC-VOICE-002` 覆盖中文选择与模型版本更新，`TC-auto-F-AI-2-3` 保留总开关显隐回归。LAN 与终端改写通过挂载真实消费者组件的测试验证，外部网络发送/终端执行不是语音测试的前提。

```bash
PYTHONPATH=.agents/skills/qa-ui-auto/scripts python -m qa_ui_auto run --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml --mode browser --filter TC-VOICE-001,TC-VOICE-002,TC-auto-F-AI-2-3 --require-pass
cargo test --manifest-path src-tauri/Cargo.toml --lib asr::
cargo test --manifest-path src-tauri/Cargo.toml --lib voice::
cargo test --manifest-path src-tauri/Cargo.toml --lib asr_migration_tests
```

真实音频测试使用 [Google FLEURS 中文样本](../qa-ui-auto-tests/fixtures/voice/README.md)（10.38 秒，已随测试代码附带）和官方 [JFK WAV](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav)，以多语言 Base 分别固定中文/英语解码：中文对照独立的标准文本“这并不是告别。这是一个篇章的结束，也是新篇章的开始。”，去除标点并归一该句繁简差异后要求字符错误率不超过 25%，英语断言包含 `ask not` 和 `country`；另测识别前取消、识别中取消及取消后的连续识别恢复。测试不是 CER/WER 基准，不证明任意中文、口音、噪声环境或麦克风质量。为避免修改用户缓存，使用独立目录：

```bash
python scripts/voice-fixture.py --root /tmp/taomni-voice-fixture
NEWMOB_CACHE_DIR=/tmp/taomni-voice-fixture TAOMNI_VOICE_PCM=/tmp/taomni-voice-fixture/jfk.f32 TAOMNI_VOICE_ZH_PCM=/tmp/taomni-voice-fixture/zh.f32 cargo test --manifest-path src-tauri/Cargo.toml --lib base_decodes -- --ignored --nocapture --test-threads=1
```

脚本会显式下载约 148 MB；已有正确文件复用，下载后校验官方目录的哈希。`NEWMOB_CACHE_DIR` 仅调试构建生效。Windows 使用 PowerShell 设置对应环境变量；原生构建需 CMake、C/C++ 工具链和 libclang，Linux 还需 ALSA 开发包以及 README 中的 Tauri 依赖。

## 交给真机的检查

本机无法真人录音，以下均需在其他机器确认，不能用 fixture 的通过代替：

1. 新安装第一次点击语音只显示设置，不静默下载；下载或离线导入 Base 后可录音。网络中断后可重试，错误文件显示校验错误。
2. Chat 输入已有文字并选中一段，录一段中文和一段中英混合语音；停止后确认插入/替换位置、原草稿和附件保留，没有自动发送。
3. 录音中 Esc、取消、切换 Chat 会话、关闭窗口/弹层、切换应用；确认麦克风指示结束，旧结果不进入新会话。识别中发送现有草稿也不应收到迟到文本。
4. 拒绝权限、无设备、拔出设备后错误可见，再授权/接入设备可重试；确认 macOS 麦克风用途提示、Windows 隐私设置、Linux 默认输入设备。
5. 录音超过 120 秒自动停止并识别；无语音不会无限录音。轻微噪声仍可能引起 Whisper 幻觉，结果必须人工确认。
6. 切换 Small/Medium 和语言立即生效；低内存设备先使用 Base，记录录音时长、停止到文本出现的时间、CPU/峰值内存。
7. 标题栏、LAN 消息输入、终端 AI 改写说明分别测试：仅填入文本；LAN 不自动发送，终端不自动生成/执行命令。
8. 离线断网且模型已安装时识别可用；关闭 AI 总开关后所有语音入口消失。确认 Windows/macOS/Linux 的各自安装包，不外推当前 Linux 测试结果。

## 本轮结果（2026-10-07，Linux x86_64）

- Node 22.23.3 / pnpm 10.30.0：TypeScript 检查与 Vite 生产构建通过。
- 前端定向验证共 7 个文件、48 个不同测试通过。首次批次有 1 个设置文案断言因追加“已选择”后缀失败；修正匹配方式后该文件 2 个测试复跑通过，其余 46 个测试沿用同批通过结果。
- 后端最终代码：ASR/配置/版本路径 5 个测试、采集重采样/会话取消 2 个测试通过；额外 2 个真实音频测试通过，包含识别前取消、识别中取消、取消后的再次识别。
- 中文 Base 原始输出：`這並不是告別這是一個偏章的結束也是新偏章的開始`。对独立 FLEURS 标注归一繁简/标点后 CER 为 0.087（2/23，两处“篇”误为“偏”）；单次测试耗时 13.08 秒，包含准备/冷加载。输出可能为繁体，不保证简体转换。
- 英文 Base 原始输出：`And so my fellow Americans, ask not what your country can do for you, ask what you can do for your country.`；单次测试耗时 11.93 秒，包含准备/冷加载。硬件为 Intel i7-6700K；运行时机器还有其他负载，这些不是受控性能基准，也不代表更大模型的速度。
- 浏览器 3 个用例全部通过、无跳过：`TC-VOICE-001`、`TC-VOICE-002`、`TC-auto-F-AI-2-3`。报告：`qa-ui-auto-report/browser/run-20261007-193331-864299406/`；已检查模型设置、中文选择及草稿截图。该次 UI 结果之后只改动原生识别回调/版本路径/音频测试与文档，未改动渲染器产品代码。
- QA 静态审计与选定用例 CI 计划通过。所有本次改动的 Rust 文件 rustfmt 检查通过，`git diff --check` 通过。仓库全量 rustfmt 仍有本次之外的既有格式差异，没有为此批量改写其它模块。
- 默认后端构建由上述最终 `cargo test --lib` 验证；无默认 feature 的 `cargo check --lib --no-default-features` 曾通过，但早于最后的模型更新/回调调整，不将它计为最终代码的验证。

原始日志归档于忽略目录 `qa-ui-auto-report/voice-delivery/`，包括首轮前端失败及修复后结果。模型文件没有加入 Git。

本轮修复了 whisper-rs 0.16 安全 abort helper 的回调 userdata 布局问题：使用稳定的 `Arc<AtomicBool>` 地址和原生回调，保持引用活到同步推理结束，并用取消后重新识别覆盖恢复行为；升级 whisper-rs 时应复核此兼容处理。

最终复核还统一了安装、库存和推理的版本目录入口；真实解码复跑移开了旧路径权重，避免旧缓存掩盖版本路径错误。

真实麦克风、系统权限/设备切换、原生文件选择器、安装包 WebView 和 Windows/macOS 原生运行尚未验证。Small/Medium 的下载选型流程有自动化覆盖，但尚无其真实解码质量/速度数据。请按上面的真机清单完成这些边界验收。
