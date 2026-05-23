# NewMob AI 原生能力 —— 总体方案与 v2 路线

## 文档定位

NewMob 已有四份相邻文档：

| 文档 | 范围 |
|------|------|
| `DESIGN.md` | 整体架构、IPC、终端/SSH/SFTP/Vault 设计 |
| `IMPLEMENTATION_PLAN.md` | 主干功能（终端、会话、SFTP、Vault）阶段化实施 |
| `TERMINAL_APPEARANCE_PLAN.md` / `TERMINAL_EXPERIENCE_PLAN.md` | 终端外观与交互体验 |
| `ipc-improve-plan.md` | Tauri IPC 流式化改进 |
| `voice-input-plan.md` | 语音输入 v1.0 → v1.2（**只读 + 连接类**意图路由，不执行 shell） |

本文档（`ai-native-plan.md`）专门承载 **AI 原生** 这一横向主题，把以下四条原本散落的需求统一起来：

1. **本地轻量 LLM** — 随软件按需安装，覆盖中英文 shell 场景
2. **云端 LLM 服务** — 免费 / 高性价比 Provider 默认预置，开箱即用
3. **语音 → Shell 命令 / 脚本** — 语音输入的"写动作"延伸（`voice-input-plan.md` 中明确推迟到 voice-v2 的部分）
4. **Tab 补全 + Agent harness** — 语音之外的 AI 增强（行内 ghost-text、跨工具编排）

`voice-input-plan.md` 的 v1.0/v1.1/v1.2 三阶段（PTT + 本地 STT + 意图路由）**完全保留、独立推进**，本文档不重写其细节。本文档是它的"v2 大版本 + 横向能力扩展"路线，与之互为引用关系。

---

## 总体架构

ASR 与 LLM 是两个完全独立的能力，分别走两条独立路径：**ASR 必须本地**（音频是高敏感数据，永不出端），**LLM 默认云端**（文本意图是低敏感数据，云端 1s 内回包远好于 CPU 本地 3s+；用户可一键切到纯本地）。

```
┌──────────────────────────────────────────────────────────────────┐
│ Voice input ─────┐                  ┌───── Keyboard input        │
│                  ▼                  ▼                            │
│  Tauri frontend (React / TypeScript)                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ Terminal UI · Voice waveform · Provider config panel ·      │  │
│  │ Command preview/confirm card · Ghost-text overlay ·         │  │
│  │ Agent action cards (dry-run / execute / cancel)             │  │
│  └────────────────────────┬───────────────────────────────────┘  │
├───────────────────────────┼──────────────────────────────────────┤
│  Rust core                ▼                                       │
│  ┌──────────────────┐  ┌────────────────────┐  ┌──────────────┐  │
│  │  asr::* (本地)    │  │  llm::* (本/云)     │  │  tab::*      │  │
│  │  trait Asr        │  │  trait Llm          │  │  reedline    │  │
│  │  ─ SherpaOnnxAsr  │  │  ─ LlamaServerLlm   │  │  硬补全      │  │
│  │  ─ WhisperRsAsr   │  │  ─ OpenAiCompat     │  │  + history   │  │
│  │  ─ VoskAsr        │  │  ─ AnthropicLlm     │  │  + fish hint │  │
│  │  常驻内存 ~200 MB │  │  按需加载，60 s 后卸 │  │              │  │
│  └────────┬──────────┘  └──────────┬─────────┘  └──────┬───────┘  │
│           │ 转写文本               │ chat/tool_calls    │ FIM     │
└───────────┼────────────────────────┼────────────────────┼─────────┘
            │                        │                    │
            ▼                        ▼                    ▼
  ┌──────────────────┐    ┌──────────────────┐  ┌────────────────────┐
  │  In-process ASR  │    │ llama-server     │  │ llama-cpp-2 (in-   │
  │  ─ sherpa-onnx   │    │ sidecar (~10 MB) │  │ process, 共享 ggml)│
  │  ─ whisper-rs    │    │ 127.0.0.1:8080   │  │ /infill FIM        │
  │  (共享 ggml)      │    │ /v1 /infill      │  │ Qwen3-0.6B Q4_K_M  │
  └──────────────────┘    └─────────┬────────┘  └────────────────────┘
                                    │ 或 ▼
                          ┌──────────────────────────┐
                          │  Cloud API (OpenAI 兼容) │
                          │  DeepSeek · GLM-4-Flash · │
                          │  SiliconFlow · Groq ·     │
                          │  Claude · Gemini · ...    │
                          └──────────────────────────┘
```

铁律：

- **ASR 永不联网**。音频字节、PCM 数据、波形帧绝不通过任何 HTTP/WebSocket 出端
- **ASR 与 LLM 必须分离**：ASR Provider 与 LLM Provider 是两套配置、两条数据通路、两份模型库；任一方升级、替换、关闭都不影响另一方
- 终端回滚字节、文件内容、SSH 密钥材料、vault 数据 **永不进入** 任何 AI 上下文
- 一切"写动作"（执行命令、上传/删除文件、创建会话）必须 dry-run + 确认卡，且在审计日志留痕
- 云端 LLM Provider 仅在用户显式开启 + 填好 vault Key 时才工作；状态栏全程黄点提示

---

## 与 `voice-input-plan.md` 的衔接

```
                voice-input-plan.md                 │   ai-native-plan.md
                                                    │
  v1.0  PTT + 浏览器 STT 烟雾 ──┐                   │
  v1.1  本地 STT + LLM 工具调用 ├─ "只读" 路由       │
  v1.2  强确认 + 审计日志       ─┘                   │
                                                    │
  ────────────────────────── 边界 ──────────────────┤
                                                    │
                                                    │  v2.0  ASR Trait + LLM Trait（双解耦） + Provider
                                                    │  v2.1  语音 → Shell 命令 / 脚本生成
                                                    │  v2.2  Tab 补全（reedline + in-process FIM）
                                                    │  v2.3  rig-core Agent + 工具执行
```

- v1.x 完成后，AI 模块（`src-tauri/src/ai/mod.rs`）已经存在，工具调用 schema、Vault key 类型、确认卡组件、审计日志表都就绪
- v2.x 在 v1.x 的基础设施上扩展，不重新发明：
  - **拆分** `voice::*` 中的 STT 部分到独立 `asr::*` 模块；语音录音/PTT/波形保留在 voice
  - **复用** v1.2 的确认卡机制 + 审计日志表（schema 不变，新增 `outcome` 子类型）
  - **拆分 + 扩展** `ai::*`：原 `AiBackend` 一分为二 —— ASR 实现迁 `asr::*`，LLM 部分迁 `llm::*`；`ai::*` 仅保留高层协调（调度 ASR → LLM、工具集、shell 安全）
  - **新增** `tab::*`（reedline + in-process FIM）、`agent::*`（rig-core）

---

## 一、模型与 Runtime 选型矩阵

> **核心原则**：ASR 与 LLM 是两条独立选型链。ASR 必须本地（音频敏感），LLM 默认云端、可切本地（文本意图低敏感、云端响应快）。任一升级不牵动另一方。

### 1.1 本地 LLM（中英文 + Shell 场景）

| 模型 | 参数 | Q4_K_M 体积 | 运行时 RAM | 用途 | 许可 |
|------|------|-------------|-----------|------|------|
| **Qwen3-0.6B** ⭐ | 0.6B | ~400 MB | ~600 MB | Tab 补全（FIM）默认 —— 同体积下质量优于 Qwen2.5-0.5B | Apache-2.0 |
| Qwen2.5-Coder-0.5B-Base | 0.5B | ~400 MB | ~600 MB | Tab 补全备选（FIM 训练更专门） | Apache-2.0 |
| **Qwen2.5-Coder-1.5B-Instruct** ⭐ | 1.5B | ~1.0 GB | ~2 GB | 主力：语音→命令、解释报错；亦可作 FIM 二用 | Apache-2.0 |
| Qwen2.5-Coder-3B-Instruct | 3B | ~2.0 GB | ~3.5 GB | "标准"档，复杂脚本生成 | Apache-2.0 |
| Qwen3-1.7B / 4B | 1.7B / 4B | ~1.1 / 2.4 GB | ~2 / 4 GB | 通用对话备选（含 thinking 模式） | Apache-2.0 |
| Gemma 3-1B / 4B | 1B / 4B | ~0.8 / 2.5 GB | ~1.5 / 4 GB | 多语备选 | Gemma 条款 |

**默认选择**：FIM 用 Qwen3-0.6B（400 MB / RAM 600 MB），chat 用 Qwen2.5-Coder 1.5B（1 GB / RAM 2 GB）。中文 shell 上下文（中文报错、中文目录名、中文注释）Qwen 系明显优于 Llama 3.2 / Phi。

CPU-only 现实：Qwen2.5-Coder 1.5B 在 i5/Ryzen 5 上意图解析 ~1–3 s，已逼近 2 s 端到端预算上限；语音→Shell 默认应走云端（DeepSeek ~400–900 ms），用户偏执隐私时一键切回本地。详见 §1.5。

### 1.2 本地 ASR（中英双语，必须本地）

短命令（1–10 s 音频）的 PTT 场景，**Whisper-tiny 在中文上 CER 约 65–71%（Common Voice / Fleurs），不可用**。下表为实测数据：

| 模型 | 体积 | 运行时 RAM | 中文 CER | 英文 | CPU 5s 推理 | 流式 | 用途 |
|------|------|-----------|---------|------|------------|------|------|
| **sherpa-onnx 流式 Zipformer zh-en small** ⭐ 默认 | **~80 MB** | ~200 MB | ~10–15% | 良 | RTF ~0.14 | ✅ 真流式 | PTT 短命令首选 |
| ggml-tiny multi | ~75 MB | ~270 MB | **~65–71%（不可用）** | 一般 | 800–1500 ms | 窗口式 | ❌ 不再作为默认 |
| Whisper base | ~150 MB | ~390 MB | ~30%（边缘） | 良 | 400–800 ms | 窗口式 | 仅作低端机降级 |
| Whisper small | ~466 MB | ~850 MB | ~12–20% | 优 | 1.5–3 s | 窗口式 | 高质量备选 |
| **SenseVoice-Small** ⭐ zh-pro 档 | ~234 MB | ~500 MB | **~5–8%（超 Whisper-large）** | 良 | ~70–300 ms | 一次性 | 中文重度档默认 |
| Paraformer-zh-small | ~220 MB | ~450 MB | ~6–10% | 弱 | ~100 ms | 一次性 | 纯中文 |
| Vosk-small-cn 0.22 | ~42 MB | ~80 MB | ~25–40%（自由文本） | 同小 | 实时 | ✅ | 仅适合"固定语法命令面板" |
| Moonshine-tiny-zh + tiny-en | ~70 MB | ~150 MB | ~29%（zh）/ — | 优（en） | 5–15× 快于 Whisper-tiny | ✗ | 双模型路径，备选 |

**关键决策**：

- 默认 ASR 从 ggml-tiny multi 切换为 **sherpa-onnx 流式 Zipformer zh-en small**：体积仅大 5 MB，但中文 CER 从不可用变为 ~10–15%，且支持真流式 partial。
- whisper-rs 仍作 feature flag 保留，给用户"高质量小语种"和"原生 ggml 共享 runtime"两条备用路径。
- zh-pro 档保持 SenseVoice-Small（注：部分权重为 CC-NC 限商用，需在 manifest 标注，参考 §十二注 a）。

### 1.3 LLM Runtime 选型

排序（推荐 → 备选）：

1. **llama.cpp `llama-server` sidecar（v2.0 主选）** ⭐
   - 通过 Tauri `bundle.externalBin` 打包 `llama-server` 二进制：CPU-only 版本 **~8–15 MB / 平台**（vs Ollama 的 macOS 127 MB / Linux 1.12 GB）
   - OpenAI 兼容（`/v1/chat/completions`、`/v1/completions`），并提供原生 `/infill` 端点（含 `--fim-qwen-*` 预设）做 FIM
   - 模型管理需自实现：从 HF / ModelScope 下载 GGUF + SHA-256 校验（与 ASR 模型库共用基础设施）

2. **`llama-cpp-2` crate（v2.2 in-process FIM 用）** ⭐
   - 把 llama.cpp 直接静态链接进 Tauri Rust 二进制，省去 sidecar 进程与 HTTP 往返
   - Tab 补全 FIM 延迟敏感（目标 <300 ms 端到端），in-process 比 sidecar HTTP 快 30–80 ms
   - 与 `whisper-rs` / `sherpa-onnx`（如启用 ggml backend）可通过构建脚本共用 system ggml，避免符号冲突
   - 缺点：构建依赖 clang，Windows CI 需配置；API 是 unsafe 的低层接口，外覆 wrapper

3. **Ollama sidecar（已安装则可接入，不再默认捆绑）**
   - 体积过大（macOS 127 MB / Linux 1.12 GB）不适合作为 Tauri sidecar 默认捆绑
   - 但用户本机已装 Ollama 时，可作为 OpenAI 兼容 Provider 的 base_url 之一接入（设置 → AI → 添加 Provider → Ollama 模板，自动探测 `127.0.0.1:11434`）

4. **mistral.rs / candle（纯 Rust，远期备选）**
   - 完全 in-process，无 sidecar，但 GGUF 加载性能弱于 llama.cpp，FIM 需手动构造 prompt
   - 留作 v2.4+ 评估，不进 v2.x 默认路径

**v2.0 锁定 `llama-server` sidecar**；v2.2 Tab 补全切到 `llama-cpp-2` in-process；Ollama 降级为"已安装时可接入"。所有路径走同一 Provider trait（仅 base_url / 进程模型不同），UX 上对用户透明。

### 1.4 云端 LLM Provider 矩阵

全部 **OpenAI-compatible**，Provider 抽象层只需切换 `base_url` + `api_key`：

| Provider | 推荐模型 | 免费 / 价格 | 中文 | 用途 |
|----------|----------|-------------|------|------|
| **DeepSeek** ⭐ | `deepseek-chat` / `deepseek-reasoner` | ~¥1/百万输入，~¥8/百万输出 | 优 | 性价比之王 |
| **GLM** ⭐ | `glm-4-flash` | **完全免费** | 优 | 国内默认免费档 |
| **SiliconFlow（硅基流动）** ⭐ | `Qwen/Qwen2.5-Coder-7B-Instruct` 等 | 大量小模型免费 | 优 | 一 Key 多模型 |
| **Groq** | `llama-3.3-70b-versatile`、`qwen3-32b` | 免费层 RPM 高 | 良 | 极速推理 ~500 tok/s |
| **Cerebras** | `llama-3.3-70b` | 免费层 | 良 | 极速备选 |
| **Google Gemini** | `gemini-2.5-flash-lite` | 每日百万 token 级免费 | 良 | 国际备选 |
| **Mistral Codestral** | `codestral-latest` | 个人/研究免费 | 一般 | Tab 补全云端档 |
| **Claude / OpenAI** | `claude-sonnet` / `gpt-4o-mini` | 按量付费 | 良 | 已有 Key 用户 |
| **OpenRouter** | 路由所有 free 模型 | 一 Key 路由 | 视模型 | 试新模型 |
| **llama-server**（local） | `qwen2.5-coder:1.5b` 等 GGUF | 本地零成本 | 优 | 默认本地档（Ollama 已装时亦可接入） |

**默认预置**（用户开箱可见，无需自己抄 base_url）：`Local (llama-server)` + `DeepSeek` + `GLM-4-Flash` + `SiliconFlow` + `Groq`，外加"自定义 OpenAI 兼容端点"和"Ollama（自动探测）"。

### 1.5 ASR + LLM 配置 UX（双独立 Provider）

ASR 与 LLM 是两块独立面板，分别选模型、分别测试连接、分别看运行状态。配置文件示例：

```jsonc
// ~/.config/newmob/ai.json
{
  // —— ASR：必本地，无 api_key 概念 ——
  "asr": {
    "active": "sherpa-zipformer-zh-en",
    "providers": {
      "sherpa-zipformer-zh-en": { "engine": "sherpa-onnx", "model": "streaming-zipformer-bilingual-zh-en-small" },
      "sensevoice-small":       { "engine": "sherpa-onnx", "model": "sense-voice-small" },
      "whisper-base":           { "engine": "whisper-rs", "model": "ggml-base-q5_1" },
      "vosk-small-cn":          { "engine": "vosk",       "model": "vosk-model-small-cn-0.22" }
    },
    "warm_on_startup": true,    // 应用启动即预热（避免每次 PTT 冷加载 200–400 ms）
    "vad": "silero"             // 静音检测器，PTT 自动停止
  },

  // —— LLM：本/云独立，OpenAI 兼容 Provider 抽象 ——
  "llm": {
    "active": "deepseek",       // 默认云端，开箱即用更快
    "providers": {
      "local":       { "base_url": "http://127.0.0.1:8080/v1",        "api_key": "local",     "model": "qwen2.5-coder-1.5b-q4_k_m", "runtime": "llama-server" },
      "local-fim":   { "base_url": "in-process",                       "api_key": "local",     "model": "qwen3-0.6b-q4_k_m",         "runtime": "llama-cpp-2" },
      "ollama":      { "base_url": "http://127.0.0.1:11434/v1",        "api_key": "ollama",    "model": "qwen2.5-coder:1.5b",        "runtime": "ollama" },
      "deepseek":    { "base_url": "https://api.deepseek.com/v1",     "api_key": "<vault:ai_api_key:deepseek>",    "model": "deepseek-chat" },
      "glm":         { "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "<vault:ai_api_key:glm>",     "model": "glm-4-flash" },
      "siliconflow": { "base_url": "https://api.siliconflow.cn/v1",   "api_key": "<vault:ai_api_key:siliconflow>", "model": "Qwen/Qwen2.5-Coder-7B-Instruct" },
      "groq":        { "base_url": "https://api.groq.com/openai/v1",  "api_key": "<vault:ai_api_key:groq>",        "model": "llama-3.3-70b-versatile" }
    },
    "fallback": { "enabled": true, "primary": "deepseek", "secondary": "local", "timeout_ms": 8000 },
    "task_routing": {
      "voice_intent":    "deepseek",   // v1.1 已有 → 默认走云端，~400–900 ms 优于本地 CPU ~1–3 s
      "voice_to_shell":  "deepseek",   // v2.1 → 同上；CPU-only 用户本地易超 2 s 预算
      "tab_completion":  "local-fim",  // v2.2 → FIM 必须本地（in-process llama-cpp-2，<300 ms）
      "agent_default":   "deepseek"    // v2.3 → 多步 tool calling 本地 1.5B 不稳，云端更可靠
    }
  }
}
```

UI 上每个 Provider 暴露恰好三个控件：**provider 下拉 / api_key 输入 / model_name 输入**。其余字段在 preset 里写死，避免用户在 base_url 上踩坑。

> **隐私一键开关**：设置顶部提供"全本地模式"开关。打开后 `llm.task_routing` 全部强制写为 `local`，并禁用所有云端 Provider 的网络请求（Tauri allowlist 动态收紧）。配合本地模型库下载完成后，整个应用可断网工作。

API Key 通过 vault `kind=ai_api_key:<provider>` 存储，复用 v1.1 已建立的机制。ASR 无 api_key 概念，故不入 vault。

### 1.6 超时回退（云端 8 s → 本地）

注意**方向反转**：默认云端为 primary，本地为 secondary。用户网络异常或 API Key 失效时自动切回本地（前提：本地档位已下载）。

```rust
// src-tauri/src/llm/router.rs（v2.0 新增）
pub async fn complete(req: ChatRequest, cfg: &LlmConfig, task: TaskKind) -> Result<ChatResponse> {
    let primary_id = cfg.task_routing.get(task).unwrap_or(&cfg.active);
    let primary = &cfg.providers[primary_id];

    if cfg.fallback.enabled && primary_id == &cfg.fallback.primary {
        match timeout(Duration::from_millis(cfg.fallback.timeout_ms),
                      providers::call(primary, &req)).await {
            Ok(Ok(out)) => return Ok(out),
            Ok(Err(e))  => tracing::warn!(?e, "primary failed, falling back"),
            Err(_)      => tracing::warn!("primary timeout, falling back"),
        }
        let secondary = &cfg.providers[&cfg.fallback.secondary];
        return providers::call(secondary, &req).await;
    }
    providers::call(primary, &req).await
}
```

前端无感，体感是"网络好云端秒回，断网/超时本地兜底"。Tab 补全任务 **不参与** 超时回退（FIM 已固定走 in-process，本身就是本地）。

### 1.7 ASR / LLM 解耦原则

| 维度 | ASR | LLM |
|------|-----|-----|
| 必本地？ | ✅ 强制（音频不出端） | ❌ 用户选 |
| 默认 | sherpa-onnx Zipformer zh-en | DeepSeek（云） |
| 配置位置 | `ai.json::asr.*` | `ai.json::llm.*` |
| 模型库管理器 | 共用同一 manifest + 下载/校验/卸载逻辑 | 同左 |
| Trait | `trait Asr` | `trait Llm` |
| 进程模型 | 始终 in-process（cpal 音频帧不跨进程） | sidecar (llama-server) 或 in-process (llama-cpp-2) 或 HTTPS（云） |
| 加载策略 | 启动即预热，常驻（小，~200 MB） | 懒加载，60–120 s idle 卸载（大，0.4–4 GB） |
| 数据流 | 音频字节 → 文本 | 文本 → 文本 |
| 升级影响面 | 仅替换 ASR provider，不动 LLM | 仅替换 LLM provider，不动 ASR |
| 失败降级 | 降级到 Vosk-small 或固定语法（≥42 MB 即可） | 云端 → 本地 fallback；或反之 |

实现层强约束：**`asr::*` 模块不允许 `import llm::*`，反之亦然**。两侧只通过纯文本（转写结果 / chat 输出）在 dispatcher 层汇合，由后者负责把转写文本喂给 LLM Provider。这样未来替换任一边都是机械替换，不牵动另一边。

---

## 二、模型档位（按需下载）

档位 = ASR 选择 × LLM 选择。**绝大多数用户的最佳起点是 cloud-only**：80 MB 即可完整使用语音 + AI，云端 Provider 提供文本智能。

| 档位 | ASR | LLM（chat） | LLM（FIM） | 总下载 | 待机 RAM | 推理峰值 RAM | 适用 |
|------|-----|-------------|------------|--------|---------|-------------|------|
| **cloud-only** ⭐ 默认 | sherpa Zipformer 80 MB | 云端 | — | **~80 MB** | ~200 MB | ~250 MB | 全部用户初始体验；Tab 补全用云端 codestral 或不开启 |
| **mini** | sherpa Zipformer 80 MB | 云端 | Qwen3-0.6B 400 MB | ~480 MB | ~600 MB | ~1.1 GB | 想离线 FIM 但仍用云 chat |
| **standard** | SenseVoice-Small 234 MB | Qwen2.5-Coder 1.5B 1 GB | Qwen3-0.6B 400 MB | ~1.6 GB | ~700 MB | ~2.5 GB | M 系 / 16 GB 笔电 / 中文重度 |
| **zh-pro** | SenseVoice-Small 234 MB | Qwen2.5-Coder 3B 2 GB | Qwen3-0.6B 400 MB | ~2.6 GB | ~700 MB | ~4.5 GB | 中文为主、追求离线质量 |
| **air-gapped**（断网工作） | SenseVoice-Small 234 MB | Qwen2.5-Coder 3B 2 GB | Qwen3-0.6B 400 MB | ~2.6 GB | ~700 MB | ~4.5 GB | 同 zh-pro，但 Tauri allowlist 收紧、禁所有云 base_url |

档位切换在 设置 → AI → 模型库 中提供"一键预设"，背后逐项调用模型库的下载/卸载（ASR 与 LLM 共用同一下载基础设施，但 manifest 分开）。

资源管理策略：

- **ASR 模型常驻**（启动即预热）：避免 PTT 释放时 200–400 ms 冷加载，且小模型 RAM 代价低（~200 MB）
- **LLM 模型懒加载**：首次推理时加载，60–120 s idle 后卸载；用户切到云端 LLM 时完全不分配本地 LLM 内存
- **运行时 RAM ≠ 下载体积**：Q4_K_M GGUF 加载后还要分配 KV cache（~1× 模型大小）+ 推理缓冲，故峰值 RAM 约为体积 1.5–2.5 倍
- **CPU-only 现实**：Windows i5/Ryzen5 上跑 Qwen2.5-Coder 1.5B 意图解析 ~1–3 s，已逼近端到端 2 s 预算上限。这就是为什么默认推荐 cloud-only：80 MB ASR 本地保隐私 + 云端 LLM 保速度，是 90% 用户的最佳组合

---

## 三、依赖增量（在 `voice-input-plan.md` 之上）

### 3.1 `src-tauri/Cargo.toml`

```toml
# v1.x 已规划 (来自 voice-input-plan.md)
whisper-rs  = { version = "0.16", optional = true }   # 改为 feature flag，不再默认
reqwest     = { version = "0.12", features = ["rustls-tls", "json", "stream"] }
hound       = "3.5"
byteorder   = "1.5"
rubato      = "0.15"

# —— v2.0 新增：ASR ——
sherpa-onnx = "1.13"   # 默认 ASR runtime，自带 onnxruntime 静态链接
# vosk     = { version = "0.3", optional = true }   # 低端机/固定语法降级用，feature flag

# —— v2.0 新增：LLM 通用 ——
async-trait = "0.1"
thiserror   = "1"          # AI 错误分层
tracing     = "0.1"        # 结构化日志（已在主项目则复用）

# —— v2.2 Tab 补全（in-process FIM）——
llama-cpp-2 = "0.1"        # 静态链接 llama.cpp，FIM 直接 in-process 调用
reedline    = "0.38"

# —— v2.3 Agent harness ——
rig-core    = { version = "0.9", features = ["derive"] }

# —— 工具辅助 ——
dirs        = "5"          # 跨平台 cache 路径
which       = "6"          # 遍历 $PATH 可执行文件
heck        = "0.5"        # 字符串命名风格转换
sha2        = "0.10"       # 模型完整性校验

[features]
default       = ["asr-sherpa"]
asr-sherpa    = []                                  # 默认启用
asr-whisper   = ["dep:whisper-rs"]                  # 用户在设置里切到 Whisper 时启用
asr-vosk      = ["dep:vosk"]
local-llm-fim = ["dep:llama-cpp-2"]                 # v2.2 启用

[profile.release]
opt-level     = 3
lto           = "thin"
codegen-units = 1
strip         = true
```

> `whisper-rs` 与 `llama-cpp-2` 都依赖 ggml。若同时启用，build script 需通过 `WHISPER_USE_SYSTEM_GGML=1` / `LLAMA_USE_SYSTEM_GGML=1` 强制共享同一 ggml 实现，避免符号冲突 + 二进制膨胀（详见 §四 4.6）。

### 3.2 `src-tauri/tauri.conf.json`

```jsonc
{
  "tauri": {
    "bundle": {
      "externalBin": [
        "binaries/llama-server"          // ~10 MB / 平台，CPU-only build
      ],
      "resources": [
        // 不再捆绑任何模型；首次启动按档位下载
      ]
    },
    "allowlist": {
      "process": { "execute": true, "relaunch": true },
      "http":    { "request": true, "scope": [
        // —— LLM Provider 端点 ——
        "https://api.deepseek.com/*",
        "https://api.siliconflow.cn/*",
        "https://api.groq.com/openai/*",
        "https://open.bigmodel.cn/*",
        "https://api.openai.com/*",
        "https://api.anthropic.com/*",
        "https://api.mistral.ai/*",
        "https://generativelanguage.googleapis.com/*",
        // —— 模型仓库（ASR + LLM 共用）——
        "https://huggingface.co/*",
        "https://hf-mirror.com/*",        // 国内镜像
        "https://modelscope.cn/*",
        // —— Ollama（用户已装时探测）——
        "http://127.0.0.1:11434/*"
      ]}
    }
  }
}
```

> "全本地模式"开关打开后，运行时动态把 `http.scope` 收紧到只允许 `127.0.0.1:*`（llama-server 自身）和 `localhost`，其余云端域名拒绝，从而实现真正的 air-gapped 操作。

sidecar 二进制按 `{name}-{target-triple}` 命名后放入 `src-tauri/binaries/`，Tauri 打包时自动包含并签名。`llama-server` 从 [llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases) 选 CPU-only 包提取，CI 脚本中固定版本 + SHA-256 校验。

---

## 四、Voice v2.0 —— ASR Trait + LLM Provider 抽象（双解耦）

**目标**：把 `voice-input-plan.md` v1.1 的 `AiBackend`（Ollama/Claude/OpenAI 三个独立实现）一分为二：
- **`trait Asr`**：本地强制，多 engine 实现（sherpa-onnx 默认 / whisper-rs 备用 / vosk 低端机）
- **`trait Llm`**：本地或云端，OpenAI-compatible 统一 Provider，预置 5 家国内外免费/性价比厂商，支持任务级路由 + 超时回退

**这是 v2.x 一切其他工作的基础**。

### 4.1 用户流程
1. 首次启动 → 设置 → AI 看到默认配置：
   - **ASR**：sherpa Zipformer zh-en（**未下载**，提示一键下载 80 MB）
   - **LLM**：DeepSeek（提示填 API Key 或选 GLM-4-Flash 完全免费）
2. 点击"一键下载语音模型"：80 MB，进度条，~10s 完成
3. 粘贴 DeepSeek API Key 或选 GLM 免费档 → 完成。**总下载 80 MB，立刻可用语音 + AI**
4. 高级用户可在"模型库"切换档位（mini/standard/zh-pro/air-gapped），对应不同 ASR + LLM 组合
5. v1.x 已有的语音意图自动用新 ASR + 新 LLM Provider，零额外配置

### 4.2 新增 / 重构文件

**ASR 侧**（新模块 `src-tauri/src/asr/`，与 `voice/` 平级）：
- `src-tauri/src/asr/mod.rs` —— `trait Asr { async fn transcribe(&self, pcm: &[f32]) -> Result<String>; fn warm(&self) -> bool; async fn unload(&self); }`
- `src-tauri/src/asr/sherpa_onnx.rs` —— 默认实现，wraps `sherpa-onnx` crate
- `src-tauri/src/asr/whisper_rs.rs` —— feature-gated 备用实现
- `src-tauri/src/asr/vosk.rs` —— feature-gated 低端机实现
- `src-tauri/src/asr/manager.rs` —— 启动预热、idle 卸载、模型库下载

**LLM 侧**（新模块 `src-tauri/src/llm/`）：
- `src-tauri/src/llm/mod.rs` —— `trait Llm { async fn chat(req) -> Resp; async fn completion_fim(prefix, suffix) -> String; }`
- `src-tauri/src/llm/openai_compat.rs` —— 通用 OpenAI 兼容实现，覆盖 90% 的云端 Provider
- `src-tauri/src/llm/anthropic.rs` —— Claude 单独实现（Messages API 略不同）
- `src-tauri/src/llm/llama_server.rs` —— 启动 / 健康检查 / 模型 pull 的 sidecar wrapper
- `src-tauri/src/llm/llama_cpp_in_proc.rs` —— v2.2 用，wraps `llama-cpp-2`，给 FIM 走 in-process
- `src-tauri/src/llm/router.rs` —— 任务级路由 + 超时回退（见 §1.6 代码）

**前端**：
- `src/components/settings/AsrPanel.tsx` —— ASR engine + 模型选择 + 模型库下载状态
- `src/components/settings/LlmProvidersPanel.tsx` —— 三字段 Provider 配置 UI + 默认 5 家 preset + "测试连接"
- `src/components/settings/LocalLlmInstaller.tsx` —— llama-server sidecar 状态卡（未下载/下载中/运行中/异常）+ 模型库管理
- `src/components/settings/PrivacyToggle.tsx` —— "全本地模式"一键开关，开启时把 `task_routing` 全部强制写为本地 + 收紧 Tauri http allowlist

### 4.3 修改既有文件
- `src-tauri/src/ai/mod.rs`（v1.1 已建）→ 拆分：原 `AiBackend` 中的 ASR 部分迁到 `asr::*`，LLM 部分迁到 `llm::*`；保留 `ai::*` 作为协调层（调度 ASR → LLM）
- `src-tauri/src/voice/intent_dispatcher.rs` → 改为 `asr::transcribe()` → `llm::router.complete(req, TaskKind::VoiceIntent)`，不再直连具体 backend
- `src-tauri/src/vault/mod.rs` → `kind=ai_api_key:*` 增加 `deepseek | glm | siliconflow | groq | cerebras | gemini | mistral | openrouter` 子类型；ASR 不入 vault
- `src/stores/aiStore.ts`（新）→ ASR 配置 + LLM Provider 配置 + 路由 + 测试结果（两个 sub-store：asrStore、llmStore，避免日后耦合）

### 4.4 ASR/LLM 解耦的代码强约束

```rust
// src-tauri/src/asr/mod.rs
// ⚠️ 这个模块禁止 use crate::llm::* 或 use crate::providers::*
// ASR 永远不应该知道 LLM 的存在，它只产出 String
pub trait Asr: Send + Sync { /* ... */ }

// src-tauri/src/llm/mod.rs
// ⚠️ 这个模块禁止 use crate::asr::*
// LLM 收到的永远是 String（来自 ASR、来自键盘、或来自 stub），不关心来源
pub trait Llm: Send + Sync { /* ... */ }

// src-tauri/src/voice/intent_dispatcher.rs
// 唯一允许同时持有 asr 和 llm 引用的地方
pub async fn dispatch(audio: AudioFrame, ctx: &AppCtx) -> Result<Intent> {
    let text = ctx.asr.transcribe(&audio.pcm).await?;
    let intent = ctx.llm_router.complete(text.into(), TaskKind::VoiceIntent).await?;
    Ok(intent)
}
```

CI 加 lint：`cargo deny` / `clippy` 自定义规则禁止 `asr::*` 与 `llm::*` 互相 use。

### 4.5 资源生命周期

| 阶段 | ASR | LLM |
|------|-----|-----|
| 应用启动 | 立即从磁盘加载到内存（warm_on_startup=true）| 不加载 |
| 用户 PTT 按下 | 已 warm，直接接收音频帧 | 不加载 |
| PTT 释放，转写完成 | 继续 warm | 此刻才加载（若是本地 LLM）|
| 推理完成 | 继续 warm | 启动 60–120 s idle 计时器 |
| idle 超时 | 不卸载（小） | 卸载，释放 RAM |
| 用户切到云端 LLM | 不变 | 永不加载本地 LLM |

实现：tokio task + `Arc<Mutex<Option<Box<dyn Llm>>>>`，idle 超时由后台 task 检查并 set None。

### 4.6 ggml 共享构建

`whisper-rs`（feature-gated）、`sherpa-onnx`（其 ggml backend，可选）、`llama-cpp-2` 三者都可能链接 ggml。如不处理会导致：
- 二进制膨胀 ~15–25 MB（三份 ggml 副本）
- 符号冲突（链接器报错或运行时未定义行为）
- GPU context 互相争用（如启用 Metal/CUDA backend）

解决：build.rs 中设置 `WHISPER_USE_SYSTEM_GGML=1`、`LLAMA_USE_SYSTEM_GGML=1`，并显式提供一份 system ggml（通过 `ggml-sys` 或自构建）。**v2.0 落地前需做 1 天 spike 验证**（见 §十二 验证 e）。

### 4.7 风险 + 缓解
- *llama-server 模型管理需自实现* → 与 ASR 模型库共用同一 manifest schema + 下载/校验/卸载基础设施，开发成本可摊销
- *国内访问 HuggingFace 慢* → 默认 `hf-mirror.com` + ModelScope 双源 + 用户自填镜像
- *Provider preset 价格 / 端点变化* → preset 与 manifest 同源（`ai-providers.manifest.json`），可远程更新
- *某 Provider 返回 OpenAI 不兼容字段（如 `tool_choice`）* → 在 `openai_compat.rs` 里按 host 做小补丁
- *ggml 多版本符号冲突* → 见 §4.6，必须前置 spike
- *llama-server 子进程崩溃影响主程* → tokio watchdog + 自动重启 + 失败 3 次后降级到云端 + 状态栏报错

---

## 五、Voice v2.1 —— 语音 → Shell 命令 / 脚本生成

**目标**：把 `voice-input-plan.md` v1.x 明确推迟的"执行 shell"路径以"强守门"形态打开。整个特性默认关闭，开启时弹一次性的安全说明书。

### 5.1 用户流程
1. 设置 → AI → 实验性 → 启用"语音生成命令"（默认关闭，弹一次性说明）
2. 用户按住 PTT 说"用 ffmpeg 把这个目录下所有 mp4 转成 webm"
3. v1.x 现有的转写 → 意图路由 → AI 识别为新工具 `generate_shell_command`
4. 弹"命令预览卡"（强制 dry-run，不直接执行）：
   ```
   ┌─ AI 生成的命令（未执行）──────────────────────────┐
   │ 当前目录：/home/user/clips                       │
   │                                                  │
   │ for f in *.mp4; do                               │
   │   ffmpeg -i "$f" -c:v libvpx-vm9 "${f%.mp4}.webm"│
   │ done                                             │
   │                                                  │
   │ 解释：遍历当前目录下 .mp4，用 libvpx-vp9 转码…   │
   │                                                  │
   │ 风险等级：⚠ 中（创建新文件，不删除原文件）       │
   │                                                  │
   │ [Enter 执行]  [E 编辑]  [Esc 取消]  [复制到剪贴板]│
   └──────────────────────────────────────────────────┘
   ```
5. 用户必须按 Enter 才执行；执行通过 v1.x 已有的 `write_terminal` 注入到当前活跃终端

### 5.2 工具 Schema 增量

在 v1.1 的 6 个只读工具基础上新增：

```jsonc
{
  "name": "generate_shell_command",
  "description": "用户用自然语言描述了一个想在当前 shell 中执行的命令或脚本。生成实际命令，附带简短解释和风险等级评估。绝不要假定文件名，从用户描述中提取；不确定则使用占位符 <FILENAME>。",
  "input_schema": {
    "type": "object",
    "properties": {
      "command":      { "type": "string", "description": "可执行 shell 文本（单行或 heredoc 多行）" },
      "explanation":  { "type": "string", "description": "1-2 句中文解释" },
      "risk":         { "type": "string", "enum": ["low", "medium", "high"], "description": "low=只读/创建；medium=改动现有文件；high=删除/格式化/sudo" },
      "needs_inputs": { "type": "array", "items": { "type": "string" }, "description": "命令中尚未确定、需用户填入的占位符列表" }
    },
    "required": ["command", "explanation", "risk"]
  }
}
```

### 5.3 安全守门（多层）

1. **黑名单正则（Rust 侧硬编码）** —— 命令文本中包含以下模式直接拒绝执行（仍可显示供用户编辑）：
   - `rm\s+-rf\s+/` / `rm\s+-rf\s+\$\w+` 任意未限定的递归删除
   - `mkfs\.` / `dd\s+.*of=/dev/` / `:>\s*/dev/sd[a-z]`
   - `>\s*/etc/(passwd|shadow|sudoers)`
   - `curl\s+.*\|\s*(bash|sh)` / `wget\s+.*\|\s*(bash|sh)`
   - `chmod\s+-R\s+777\s+/`
2. **风险等级闸门**：
   - `low` → 默认 1.5 s 后自动执行（与 v1.2 的 `switch_tab` 同档）
   - `medium` → 必须按 Enter
   - `high` → 必须按 Enter，且确认卡红色边框 + 二次确认（"我已阅读命令并理解后果"勾选框）
3. **会话标记**：会话设置中可标"该会话禁用 AI 写动作"。被标的会话即使语音生成命令也只显示卡片，按 Enter 也不执行（仅复制到剪贴板）
4. **审计日志**：每次生成都进 `voice_audit` 表，`outcome` 扩展为 `generated | executed | edited | cancelled | blocked_blacklist`，`intent_json` 包含完整命令和风险等级

### 5.4 新增文件
- `src-tauri/src/ai/tools_shell.rs` —— `generate_shell_command` schema + 黑名单正则
- `src-tauri/src/ai/shell_safety.rs` —— 黑名单评估器（独立单测覆盖率要求 100%）
- `src-tauri/src/ai/shell_prompt.rs` —— 生成命令的 system prompt（强调 dry-run 习惯、显式占位符、风险评估）
- `src/components/voice/CommandPreviewCard.tsx` —— 命令预览卡 + 风险标识 + 编辑模式
- `src/lib/voice/commandExecutor.ts` —— 把命令通过 `write_terminal(activeSessionId, base64(command + "\n"))` 注入

### 5.5 修改既有文件
- `src-tauri/src/ai/tools_voice.rs` → 增加 `generate_shell_command` 到工具列表
- `src-tauri/src/voice/audit.rs` → `outcome` 字段加新枚举值
- `src/components/voice/VoiceSettingsSection.tsx` → 增加"实验性 → 语音生成命令"开关 + 黑名单/风险等级说明
- `src/components/sessions/SessionEditor.tsx` → 增加"该会话禁用 AI 写动作"复选框

### 5.6 风险 + 缓解
- *AI 生成误删命令* → 黑名单 + 风险等级 + 强制确认三重防线；high 等级必须显式勾选确认框
- *用户在确认卡上盲目按 Enter* → high 风险卡片有 800 ms"防误触动画"，确认按钮 800 ms 后才可点
- *AI 在中文 ffmpeg / docker 这类长尾场景胡编参数* → 优先走云端大模型（DeepSeek/Qwen-Coder-Plus）；本地 1.5B 失败时自动回退云端
- *命令注入用了 here-doc 但 shell 不支持* → 检测目标终端 shell 类型（v1 已记录 `terminalSessionIds.shellType`），不支持则降级为单行
- *复制到剪贴板的"安全"路径反被滥用* → 复制不在审计日志区分等级，因为粘贴执行的是用户自己的责任行为

---

## 六、Voice v2.2 —— Tab 补全（reedline + LLM ghost-text）

**目标**：在终端体验中加入"灰色 ghost-text + 按 Tab/→ 接受"的现代体感。**默认只开启 reedline 硬补全**（无网络无 AI 也工作）；LLM ghost-text 是叠加层，可单独开关。

### 6.1 双层架构

```
用户敲键
   │
   ▼
[第一层] reedline Completer trait
   - PATH 可执行文件（启动时 which 扫描，10 s TTL）
   - 命令历史（v1.x 已有 Common Commands 数据源）
   - 当前目录文件 / 相对路径
   - SSH known_hosts（连接类命令时）
   →  立刻显示候选下拉（同步，<1 ms）
   │
   └── 暂停 120 ms 且无新键 → 异步触发
            ▼
[第二层] llama-cpp-2 in-process（Qwen3-0.6B FIM Q4_K_M）
   - prefix = 当前命令行 + 最近 5 条 history
   - suffix = 空（行尾）
   - max_tokens = 24, stop = ["\n"]
   - 直接调用 llm::llama_cpp_in_proc，零 HTTP 往返
   →  灰色 ghost-text 铺在光标后
   →  → 接受单词，Tab 接受全部，Esc 拒绝
```

**为什么 FIM 不走 llama-server sidecar？** Tab 补全延迟敏感（目标 <300 ms 端到端），sidecar HTTP 往返会增加 30–80 ms（loopback + JSON 编解码 + tokio 跨进程调度），加上 120 ms debounce 之后预算就紧了。in-process 直接 FFI 调用 llama.cpp，省去整个 HTTP 栈。

### 6.2 集成位置

**关键决策**：v2.2 **不替换 xterm.js**。reedline 集成位置是新增的"AI 命令编辑器"覆盖层（`Ctrl+K` 唤起，类似 VS Code Quick Open），编辑完成后回写到 xterm 当前 prompt 行。这是因为：

- 完全替换 xterm 输入栈风险太大（破坏 TTY 语义、Vim/SSH 内程序行为、shell 自身补全）
- 覆盖层方案保留终端原生体验，AI 增强是附加而非替换
- 后续 v2.4+ 如果稳定，再讨论"原生终端行内 ghost-text"（这要解决 ANSI 注入 + cursor 同步两个硬问题）

### 6.3 新增文件
- `src-tauri/src/tab/mod.rs` —— Tauri 命令 `tab_suggest_local`（reedline 硬补全）+ `tab_suggest_llm`（FIM via llama-cpp-2）
- `src-tauri/src/tab/reedline_engine.rs` —— 实现 `Completer` trait
- `src-tauri/src/tab/path_scanner.rs` —— `which` 扫 PATH，启动时 + 10 s TTL
- `src-tauri/src/tab/fim_engine.rs` —— wraps `llm::llama_cpp_in_proc`，专门 FIM 调用，复用 v2.0 的 ggml 共享 runtime
- `src/components/terminal/CommandEditorOverlay.tsx` —— `Ctrl+K` 唤起的覆盖层；接管按键、显示候选 + ghost-text
- `src/lib/tab/fimClient.ts` —— 调用 `tab_suggest_llm`，带 120 ms debounce + AbortController

### 6.4 修改既有文件
- `src/components/terminal/TerminalView.tsx` → 监听 `Ctrl+K` 唤起覆盖层；覆盖层 commit 时把命令文本注入到 xterm 输入
- `src/components/settings/LlmProvidersPanel.tsx` → "Tab 补全"区块：硬补全开关、LLM ghost-text 开关、模型选择（默认 Qwen3-0.6B）；FIM 路由固定 `local-fim`，不允许走云端（延迟原因）
- `src-tauri/src/lib.rs` → 注册 `tab_*` 命令

### 6.5 性能预算
- 第一层（reedline）：同步触发，候选生成 <1 ms（PATH 缓存命中）
- 第二层（FIM in-process llama-cpp-2 / Qwen3-0.6B Q4_K_M）：120 ms debounce + 50–150 ms 推理；总延迟 <300 ms
- 对照：sidecar HTTP 路径需多 30–80 ms（这就是不走 llama-server 的原因）
- ghost-text 在等待时 **不显示骨架**，结果到达再淡入；避免抖动
- 新键入立即 abort 旧 FIM 请求（llama-cpp-2 cancellation token + tokio AbortHandle）

### 6.6 风险 + 缓解
- *本地 0.6B 偶尔吐空字符串* → 空结果不显示，不打扰用户
- *PATH 扫描在 WSL / Windows 路径分隔符上踩坑* → `which` crate 已处理；额外测试 fixture 覆盖
- *用户 shell 自带补全（fish、zsh 的 zsh-autosuggestions）冲突* → 覆盖层方案不涉及 shell 内置补全，无冲突
- *FIM 模型把"敏感"字符串补出来* → 输入历史按行做过滤，不把含 `password=` `token=` `Bearer ` 的行送给 FIM
- *`llama-cpp-2` 构建依赖 clang* → CI 在三平台预装 clang/LLVM；提供 pre-built `.rlib` 缓存加速 CI；用户本地构建有 fallback 提示
- *FIM 模型未下载时 Ctrl+K 仍可用* → 第一层硬补全独立工作，UI 标注"未启用 AI 补全"

---

## 七、Voice v2.3 —— rig-core Agent harness

**目标**：把"语音意图路由"和"语音生成命令"统一到 Agent 框架下，使能跨工具编排（"找到这台机器最近一次部署失败的日志、把它解释给我"）。**默认走单工具调用模式**（与 v1.x / v2.1 行为兼容）；多工具编排作为 opt-in 高级模式。

### 7.1 工具集（rig `#[tool]`）

```rust
#[tool(description = "列出所有已保存的 SSH 会话")]
fn list_sessions(query: Option<String>) -> Vec<SessionMeta>;

#[tool(description = "切换到指定标签")]
fn switch_tab(query: String) -> Result<()>;

#[tool(description = "在指定会话的终端中执行命令。dry_run=true 时只返回命令文本，不执行。")]
fn run_in_terminal(session_id: String, command: String, dry_run: bool) -> Result<CommandPreview>;

#[tool(description = "读取当前活跃终端最近 N 行输出。仅用户在 'AI 解释报错' 流程中显式触发时可用，绝不主动调用。")]
fn read_terminal_tail(session_id: String, lines: u32, user_invoked: bool) -> Result<String>;

#[tool(description = "在 SFTP 会话中上传本地文件")]
fn sftp_upload(session_id: String, local_path: String, remote_path: String, dry_run: bool) -> Result<()>;

#[tool(description = "搜索命令历史并预填命令面板")]
fn search_history(query: String) -> Result<()>;

#[tool(description = "在新建会话编辑器中预填字段")]
fn open_session_editor(name: Option<String>, host: Option<String>) -> Result<()>;

#[tool(description = "解释一段终端输出（错误信息）")]
fn explain_error(text: String) -> String;

#[tool(description = "把一组刚执行过的命令打包成 Runbook（v0.4.x 联动）")]
fn save_as_runbook(session_id: String, last_n_commands: u32, name: String) -> Result<()>;
```

关键安全设计：
- 所有"写"工具（`run_in_terminal`、`sftp_upload`、`save_as_runbook`）必须支持 `dry_run`，且默认 `dry_run=true`
- 工具结果回到 LLM 之前先经"action card 确认"步骤
- `read_terminal_tail` 必须 `user_invoked=true` 才会执行 —— 防止 Agent 在多步规划里偷偷读终端

### 7.2 用户流程（"解释这条报错"快速动作）
1. 终端最后一条命令报错（exit code != 0），状态栏出现"AI 解释"按钮
2. 用户点击 → 弹出 action card："Agent 想读取终端最后 50 行 [允许 / 拒绝]"
3. 用户允许 → Agent 调用 `read_terminal_tail(user_invoked=true)` → `explain_error(text)` → 流式渲染解释
4. 解释下方提供"建议修复命令"按钮 → 走 v2.1 命令预览卡

### 7.3 新增文件
- `src-tauri/src/agent/mod.rs` —— rig-core Agent 装配 + 工具注册
- `src-tauri/src/agent/tools/*.rs` —— 上述各 tool 的实现，每个独立文件
- `src-tauri/src/agent/safety.rs` —— "写动作必须 dry_run=true 默认 + 用户确认"中间件
- `src/components/agent/ActionCard.tsx` —— 通用 action card 组件（被 v2.1 命令卡复用 + 扩展）
- `src/components/agent/QuickActions.tsx` —— "解释报错 / 改成脚本 / 找历史" 三个固定入口

### 7.4 修改既有文件
- `src-tauri/src/llm/router.rs` → 增加 Agent 任务路径：`router.run_agent(req, TaskKind::AgentDefault)`
- `src-tauri/src/voice/intent_dispatcher.rs` → 把 v1.1 的工具调用迁移到 rig-core Agent（保持向下兼容，工具 schema 不变）
- `src/stores/voiceStore.ts` → `lastIntent` 类型扩展为 `ActionCard[]`（多步编排时的多张卡）

### 7.5 风险 + 缓解
- *Agent 多步规划失控（无限调用工具）* → 单次会话最多 5 步工具调用；超出强制结束 + 错误提示
- *Agent 读终端输出泄漏密码* → `read_terminal_tail` 默认对结果做 `password|token|secret|key=` 行级 redaction
- *本地 1.5B 模型 tool calling 不稳* → Agent 路径默认路由到云端（`agent_default = "deepseek"`）；本地档位仅推单工具模式
- *rig-core API 还在演进* → 锁版本 `0.9`；agent.rs 内做一层薄 wrapper，便于将来切换到其他 harness（smolagents、PydanticAI sidecar）

---

## 八、落地路线（4–6 周）

| 周 | 阶段 | 交付 |
|----|------|------|
| W0 | **spike** | ggml 共享构建验证（whisper-rs + sherpa-onnx + llama-cpp-2 链接同一份 ggml 不冲突）；llama-server 三平台 sidecar 体积、签名、启动可行性确认 |
| W1 | **v2.0a** | Cargo + Tauri sidecar（llama-server）+ ASR Trait + sherpa-onnx 默认实现 + LLM Trait + OpenAI-compat 通用实现 |
| W1–W2 | **v2.0b** | DeepSeek / GLM / SiliconFlow / Groq preset + 双面板 UI（AsrPanel + LlmProvidersPanel）+ 超时回退（云→本地）+ Vault key 类型扩展 |
| W2 | **v2.0c** | v1.1 现有 `AiBackend` 拆分到 `asr::*` + `llm::*`（行为不变，回归测试）+ 全本地模式开关（PrivacyToggle）+ ggml 共享构建落地 |
| W3 | **v2.1a** | `generate_shell_command` 工具 + 命令预览卡 + 黑名单评估器（100% 单测） |
| W3 | **v2.1b** | 风险等级闸门 + high 风险二次确认 + 会话级"禁用 AI 写动作"标记 + 审计日志扩展 |
| W4 | **v2.2a** | reedline 硬补全 + Ctrl+K 覆盖层（无 LLM 也能用） |
| W4 | **v2.2b** | Qwen3-0.6B FIM ghost-text via llama-cpp-2 in-process + 120 ms debounce + 输入历史脱敏 |
| W5 | **v2.3a** | rig-core 装配 + 9 个工具实现 + safety 中间件 + 单步模式（替换 v1.1 实现） |
| W5–W6 | **v2.3b** | 多步编排（opt-in）+ "解释报错" / "改成脚本" 快速动作 + ActionCard 通用化 |
| W6 | **打磨** | zh-pro 档位（SenseVoice）+ 端到端 e2e（qa-ui-auto）+ 文档 |

时间表前置假设：v1.0 / v1.1 / v1.2 已完成（按 `voice-input-plan.md` 推进）。如 v1.x 仍在进行，v2.0a/b 可与 v1.1 并行（ASR/LLM Trait 抽象本身在 v1.1 就用得上）。

---

## 九、与 `roadmap.md` 的对齐

| App 版本 | Voice 阶段 | AI 原生阶段 |
|---------|-----------|-------------|
| v0.3.x  | v1.0 / v1.1 | v2.0 ASR + LLM Trait 抽象（提前到 v0.3.x，v1.1 直接用） |
| v0.4.x  | v1.2 | v2.1 语音→Shell + v2.2 Tab 补全（in-process FIM）|
| v0.5.x  | —    | v2.3 Agent harness + 多步编排 |
| v1.0    | 收口审计 | 默认档位锁定（**cloud-only** 80 MB 入门）+ Runbook 联动 |

---

## 十、不做事项（v2.x 范围内）

继承 `voice-input-plan.md` v1.x 全部 14 条不做事项，并新增：

15. **Agent 自主多轮长任务**（>5 步工具调用、跨会话） —— 留给 v3
16. **本地训练 / 微调** —— 用户层面只有"换权重"，不做端上微调
17. **本地 RAG 知识库** —— 不在 v2 范围；如果以后做，作为独立 `knowledge-plan.md`
18. **替换 xterm.js 输入栈** —— Tab 补全只在覆盖层，不破坏原生终端
19. **GPU 加速默认开启** —— v2 默认 CPU 推理；CUDA / Metal / Vulkan 需用户在设置里手动开
20. **Plugin 市场 / 第三方 tool 插件** —— rig-core tool 列表硬编码在 Rust 侧，避免任意代码注入
21. **ASR 走云端** —— 任何情况下都不允许；Web Speech API（Chrome/Safari 会上传音频到云）也不接入
22. **ASR/LLM 互相 import** —— 编译期 lint 强制隔离；语音 dispatcher 是唯一汇合点

---

## 十一、关键文件一览（v2 增量）

| 文件 | 关联点 |
|------|--------|
| `src-tauri/src/asr/mod.rs`（新） | `trait Asr` + 模型管理 + 启动预热 |
| `src-tauri/src/asr/sherpa_onnx.rs`（新） | 默认 ASR engine（流式 Zipformer / SenseVoice） |
| `src-tauri/src/asr/whisper_rs.rs`（新，feature） | 备用 ASR engine |
| `src-tauri/src/asr/manager.rs`（新） | warm/unload + 模型库下载（与 LLM 共用 manifest） |
| `src-tauri/src/llm/mod.rs`（新） | `trait Llm` + 任务路由 + 超时回退 |
| `src-tauri/src/llm/openai_compat.rs`（新） | 覆盖 90% Provider 的统一实现 |
| `src-tauri/src/llm/anthropic.rs`（新） | Claude Messages API 实现 |
| `src-tauri/src/llm/llama_server.rs`（新） | llama-server sidecar wrapper |
| `src-tauri/src/llm/llama_cpp_in_proc.rs`（新） | v2.2 in-process FIM via `llama-cpp-2` |
| `src-tauri/src/llm/router.rs`（新） | 任务路由 + 超时回退（云→本地） |
| `src-tauri/src/ai/tools_shell.rs`（新） | `generate_shell_command` schema |
| `src-tauri/src/ai/shell_safety.rs`（新） | 黑名单 + 风险等级评估 |
| `src-tauri/src/tab/mod.rs`（新） | reedline 硬补全 + FIM 端点 |
| `src-tauri/src/tab/fim_engine.rs`（新） | 桥接 `llm::llama_cpp_in_proc` |
| `src-tauri/src/agent/mod.rs`（新） | rig-core Agent 装配 |
| `src-tauri/src/agent/tools/*.rs`（新） | 9 个工具的实现 |
| `src-tauri/binaries/`（新目录） | `llama-server-{target-triple}` sidecar（CPU-only ~10 MB） |
| `src/components/voice/CommandPreviewCard.tsx`（新） | 语音→Shell 的预览/确认卡 |
| `src/components/terminal/CommandEditorOverlay.tsx`（新） | Ctrl+K 覆盖层 |
| `src/components/agent/ActionCard.tsx`（新） | Agent 通用动作卡 |
| `src/components/settings/AsrPanel.tsx`（新） | ASR engine + 模型选择 |
| `src/components/settings/LlmProvidersPanel.tsx`（新） | 三字段 LLM Provider 配置 |
| `src/components/settings/LocalLlmInstaller.tsx`（新） | llama-server 状态 + 模型库管理 |
| `src/components/settings/PrivacyToggle.tsx`（新） | "全本地模式"一键开关 |
| `src/stores/aiStore.ts`（新） | 拆为 asrStore + llmStore，避免耦合 |

---

## 十二、验证方式（v2 增量）

### v2.0
- 默认配置下首启动：仅看到"下载语音模型 80 MB"提示 + LLM Provider 选择列表（DeepSeek / GLM / 其他）。下载 ASR + 填 GLM-4-Flash key（免费）→ 立即可用语音 + AI，**总下载 80 MB**
- 切换 LLM 到 `local`（llama-server）：触发模型库下载 Qwen2.5-Coder 1.5B（1 GB）→ 启动 sidecar → 语音意图改走本地，行为一致
- 配置 DeepSeek + 粘贴 key + 点"测试连接" → 200 OK；ASR 面板显示"sherpa-zipformer-zh-en 已就绪，常驻 ~200 MB RAM"
- 把 active 切到 DeepSeek 后断 sidecar → 语音意图仍工作；再断网 → 给出可执行错误并提示开启全本地模式
- 把 fallback 设为 deepseek→local，模拟 DeepSeek 8 s 超时 → 自动走本地 sidecar
- "全本地模式"开关：开启后 Tauri http allowlist 收紧到仅 `127.0.0.1:*`，DeepSeek 调用网络层即被拒绝
- 跑 `cargo test -p newmob_llm provider_compat` —— 同一 prompt 对 5 家 Provider 输出 schema 一致
- **(e) ggml 共享构建 spike**：`cargo build --features asr-whisper,local-llm-fim --release`，验证产物中只有一份 ggml 符号表（`nm` / `dumpbin` 检查），二进制大小相对单 feature 增量 <2 MB
- **解耦 lint**：`cargo clippy -- -W newmob::asr_llm_isolation` 检查 `asr/` 与 `llm/` 之间无 use 引用

### v2.1
- 开启实验性开关，按住 PTT 说"列出当前目录所有大于 100 MB 的文件" → 命令预览卡显示 `find . -size +100M`，风险 low，1.5 s 后自动执行（注入到当前终端）
- 说"删除所有日志文件" → 风险 medium，必须按 Enter
- 说"把根目录全部删了" → AI 应主动评 high；即便没评，黑名单 `rm\s+-rf\s+/` 命中阻止执行，审计 `outcome=blocked_blacklist`
- 在某会话设"禁用 AI 写动作"，再触发命令生成 → 卡片可见但 Enter 仅复制到剪贴板，不注入终端
- `cargo test -p newmob_ai shell_safety::blacklist` —— 100% 覆盖黑名单全部正则

### v2.2
- 断网，按 Ctrl+K 唤起覆盖层，输入 `gi` → 立刻显示 `git`、`gimp` 等候选（reedline 硬补全可用）
- 加载 Qwen3-0.6B FIM 模型，输入 `git che` 暂停 200 ms → 灰色 ghost-text 显示 `ckout main`，按 → 接受到第一个 token
- 输入 `mysql -ppassword=` 历史中存在含敏感字段的行 → 验证该行没被送入 FIM 上下文（log 中 prefix 字段做断言）
- 测延迟：从最后键入到 ghost-text 显示 P95 < 300 ms（本地 0.6B Q4_K_M，in-process）；对照 sidecar HTTP 路径 P95 应高出 30–80 ms

### v2.3
- 终端运行报错命令（如 `git push origin main` 提示需要 force），状态栏出现 "AI 解释" → 点击 → action card "Agent 想读终端最后 50 行" → 允许 → 流式输出解释 + 建议修复命令按钮 → 点按钮触发 v2.1 命令预览卡
- 跑多步编排（opt-in）："找出 prod-web 上 `/var/log/nginx/error.log` 最近 100 行里的 5xx 错误统计" → 工具调用链：`list_sessions(query="prod-web")` → `switch_tab` → `run_in_terminal(dry_run=true, command="...")` → 用户确认 → 执行 → `explain_error`
- `cargo test -p newmob_agent safety::write_tools_default_dry_run` —— 所有写工具默认 `dry_run=true`
- 触发"读终端"工具但 `user_invoked=false` → 中间件拒绝并记审计

---

## 十三、参考资料

- 上游模型 / runtime
  - [Qwen2.5-Coder](https://github.com/QwenLM/Qwen2.5-Coder)（Apache-2.0）
  - [Qwen3](https://github.com/QwenLM/Qwen3)（Apache-2.0）
  - [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（部分权重 CC-NC，需在 manifest 标商用注意事项 — 注 a）
  - [llama.cpp](https://github.com/ggml-org/llama.cpp)（CPU-only release ~8–15 MB / 平台）
  - [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  - [Ollama](https://ollama.com/)（仅作"用户已装时"接入，不再默认捆绑）
- Rust 生态
  - [reedline](https://github.com/nushell/reedline)（Nushell 的核心编辑器，Fish 风格 ghost-text）
  - [rig](https://github.com/0xPlaygrounds/rig) / [swiftide](https://github.com/bosun-ai/swiftide)
  - [sherpa-onnx](https://docs.rs/sherpa-onnx) v1.13+（官方 Rust API，Apache-2.0）
  - [whisper-rs](https://github.com/tazz4843/whisper-rs)（Unlicense，备用 ASR）
  - [llama-cpp-2](https://lib.rs/crates/llama-cpp-2)（in-process llama.cpp 绑定，FIM 用）
- 参考实现
  - [MumbleFlow](https://dev.to/auratech/i-built-a-local-voice-to-text-app-with-rust-tauri-20-whispercpp-and-llamacpp-heres-how-32h5)（Tauri 2 + whisper.cpp + llama.cpp，最贴近的工程参考）
- Provider 参考
  - DeepSeek / SiliconFlow / GLM (Zhipu) / Groq / Cerebras / Mistral / Gemini —— 均提供 OpenAI 兼容端点

注 a：SenseVoice-Small 的部分权重为 CC-BY-NC-4.0（非商用），如需商用请改用 Paraformer-zh-small（Apache-2.0）或 Whisper-small（MIT）。模型 manifest 中按权重标注许可，下载前 UI 提示。

---

_本文档与 `voice-input-plan.md`、`roadmap.md` 互为引用，任何变更需同步检视另两份。_
