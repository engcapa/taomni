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
│  │  trait Asr        │  │  trait Llm          │  │  ghost-text  │  │
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
                                                    │  v2.2  输入辅助增强（扩展现有 ghost-text + AI 改写）
                                                    │  v2.3  rig-core Agent + 工具执行 + MCP 暴露
                                                    │  v2.4  AI Chat Drawer + 终端 ?? 内联 + 选区
                                                    │  v2.5  Agentic Web Search（SearXNG 默认）
```

- v1.x 完成后，AI 模块（`src-tauri/src/ai/mod.rs`）已经存在，工具调用 schema、Vault key 类型、确认卡组件、审计日志表都就绪
- v2.x 在 v1.x 的基础设施上扩展，不重新发明：
  - **拆分** `voice::*` 中的 STT 部分到独立 `asr::*` 模块；语音录音/PTT/波形保留在 voice
  - **复用** v1.2 的确认卡机制 + 审计日志表（schema 不变，新增 `outcome` 子类型）
  - **拆分 + 扩展** `ai::*`：原 `AiBackend` 一分为二 —— ASR 实现迁 `asr::*`，LLM 部分迁 `llm::*`；`ai::*` 仅保留高层协调（调度 ASR → LLM、工具集、shell 安全）
  - **新增** `tab::*`（PATH/files 数据源 + in-process FIM；扩展现有 ghost-text 渲染层）、`agent::*`（rig-core + rmcp + web search）、`chat::*`（多对话历史 + 终端内联）

---

## 一、模型与 Runtime 选型矩阵

> **核心原则**：ASR 与 LLM 是两条独立选型链。ASR 必须本地（音频敏感），LLM 默认云端、可切本地（文本意图低敏感、云端响应快）。任一升级不牵动另一方。

### 1.1 本地 LLM（中英文 + Shell + 通用对话）

定位转变：从"shell 命令生成专用"扩展为**通用对话能力**——除了语音→Shell 与 FIM，还要承载 v2.4 的 AI Chat Drawer / 终端 `??` 内联对话 / 文本选区 Send-to-AI 等场景。这意味着默认模型不能只看 code 任务，要看 MMLU / CMMLU / IFEval / BFCL（tool-calling）的综合表现。

| 模型 | 参数 | Q4_K_M 体积 | 运行时 RAM | CPU 推理（mid 范围 i5/Ryzen5）| 中文 | Tool-calling | 用途 | 许可 |
|------|------|-------------|-----------|------------------------------|------|--------------|------|------|
| **Qwen3-0.6B-Instruct** ⭐ | 0.6B | ~400 MB | ~600 MB | 35–50 tok/s | 强 | 原生 | Tab 补全 FIM 默认 / 语音意图分类 | Apache-2.0 |
| Qwen2.5-Coder-0.5B-Base | 0.5B | ~400 MB | ~600 MB | 35–50 tok/s | 强 | 弱（仅 FIM 训练）| FIM 备选（更专门） | Apache-2.0 |
| **Qwen3-1.7B-Instruct-2507** ⭐ 默认 chat | 1.7B | ~1.4 GB | ~2 GB | 25–35 tok/s | 强（MMLU 62.6 / MMMLU 63.3 / MGSM 47.5）| 原生 | **默认 chat + shell + 单步 agent**；非 thinking 模式可关延迟 | Apache-2.0 |
| **Qwen3-4B-Instruct-2507** ⭐ Quality | 4B | ~2.4 GB | ~4 GB | 6–12 tok/s | 极强（接近 Qwen2.5-72B）| 原生 | 多步 agent / 复杂中文 chat | Apache-2.0 |
| **MiniCPM3-4B** ⭐ zh-pro 备选 | 4B | ~2.4 GB | ~4 GB | 6–12 tok/s | 极强（CMMLU 73.3 / CEVAL 73.6）| **BFCL v2 76.0**（4B 级最高）| 中文 agent 重度场景 | MiniCPM Model License |
| **Granite 4.0 Micro** | 3B | ~1.8 GB | ~2.3 GB | 12–18 tok/s | 中等（12 语种含中文）| BFCL v3 59.98（同尺寸最高）| 西方/合规场景默认 chat | Apache-2.0（ISO 42001 认证） |
| Qwen2.5-Coder-1.5B-Instruct | 1.5B | ~1.0 GB | ~2 GB | 25–40 tok/s | 强 | 良好 | 旧版本（被 Qwen3-1.7B 取代）| Apache-2.0 |
| Qwen2.5-Coder-3B-Instruct | 3B | ~2.0 GB | ~3.5 GB | 8–15 tok/s | 强 | 良好 | 旧版本（被 Qwen3-4B 取代）| Apache-2.0 |
| Gemma 3-1B / 4B | 1B / 4B | ~0.8 / 2.5 GB | ~1.5 / 4 GB | 30 / 6–12 | 1B 几乎只英文；4B 多语 | 提示式 | 备选（许可为 Gemma Terms）| Gemma Terms |

**默认选择（v2.0 起锁定）**：

| 任务 | 模型 | 选择理由 |
|------|------|---------|
| 默认 chat（含语音→Shell、AI Chat Drawer、`??` 内联）| **Qwen3-1.7B-Instruct-2507** | 比 Qwen2.5-3B 更小（1.4 vs 2.0 GB）但综合分更高；原生 tool-calling；非 thinking 模式可关，延迟无惩罚 |
| Tab 补全 FIM | **Qwen3-0.6B-Instruct** | 同体积下推理质量高于 Qwen2.5-Coder-0.5B；Apache-2.0 |
| Quality 档 | **Qwen3-4B-Instruct-2507** | 接近 Qwen2.5-72B 的综合能力，CPU 上仍可用 |
| zh-pro（中文重度 + 多步 agent）| **MiniCPM3-4B** | 中文 BFCL v2 76.0（4B 级最高）；CMMLU 73.3 |
| 合规场景（ISO/审计） | **Granite 4.0 Micro** | Apache-2.0 + ISO 42001 认证 + 加密签名 |

**淘汰候选（已研究，不进路线）**：Llama 3.2（Chinese 不在官方 8 语言）、Gemma 3-1B（英语为主）、Phi-3.5-mini / Phi-4-mini（CMMLU ~46.9）、SmolLM2 / SmolLM3（英语为主）、DeepSeek-R1-Distill-1.5B（无 tool-calling，喷 `<think>`）、Yi-Coder（仅代码）。

CPU-only 现实：Qwen3-1.7B 在 i5/Ryzen5 上首 token ~300 ms、~25–35 tok/s；意图解析（~50 token JSON）端到端 ~500–1000 ms；语音→Shell 含 ASR 总耗时 ~700–1200 ms。**这一档已能在 2 s 端到端预算内完成**，但 chat 场景中长回答仍可能拉到 5–10 s——故 chat 场景默认仍走云端 LLM，本地仅用于 FIM 与短意图。详见 §1.5。

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
      "command_rewrite": "deepseek",   // v2.2 Ctrl+K 改写 → chat 任务，云端默认
      "chat_drawer":     "deepseek",   // v2.4 → 默认云端；用户在 thread 内可切本地
      "inline_qq":       "deepseek",   // v2.4 终端 `??` → 同上
      "agent_default":   "deepseek",   // v2.3 → 多步 tool calling 本地 1.7B 不稳，云端更可靠
      "web_search":      "auto"        // v2.5 → "auto" 表示走 ProviderCaps 路由；详见 §9.0
                                        //   有原生 → 用原生（OpenAI/Claude/Gemini/Grok/...）
                                        //   无原生 → 用客户端 SearXNG（默认）/Tavily/Serper（BYOK）
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

档位 = ASR 选择 × LLM 选择 × FIM 选择。**绝大多数用户的最佳起点是 cloud-only**（80 MB），它仅在用户首次按 PTT 时才下载 ASR；不开语音、不开 AI 补全的用户安装包零增量。

| 档位 | ASR | LLM（chat） | LLM（FIM） | 总下载 | 待机 RAM | 推理峰值 RAM | 适用 |
|------|-----|-------------|------------|--------|---------|-------------|------|
| **cloud-only** ⭐ 默认 | sherpa Zipformer 80 MB | 云端 | — | **80 MB** | ~200 MB | ~250 MB | 大多数用户首选；FIM 不开（NewMob 现有 inline ghost-text 已可用） |
| **mini** | sherpa Zipformer 80 MB | 云端 | Qwen3-0.6B 400 MB | ~480 MB | ~600 MB | ~1.1 GB | 想离线 FIM 但仍用云端 chat |
| **standard** | SenseVoice-Small 234 MB | Qwen3-1.7B-2507 1.4 GB | Qwen3-0.6B 400 MB | ~2.0 GB | ~700 MB | ~3 GB | M 系 / 16 GB 笔电 / 中文重度 |
| **zh-pro** | SenseVoice-Small 234 MB | MiniCPM3-4B 2.4 GB（中文 agent 重度）| Qwen3-0.6B 400 MB | ~3.0 GB | ~700 MB | ~5 GB | 中文为主、追求多步 agent |
| **quality** | SenseVoice-Small 234 MB | Qwen3-4B-2507 2.4 GB | Qwen3-0.6B 400 MB | ~3.0 GB | ~700 MB | ~5 GB | 平衡英文 / 中文 / 多步 agent |
| **air-gapped** | SenseVoice-Small 234 MB | Qwen3-4B-2507 2.4 GB | Qwen3-0.6B 400 MB | ~3.0 GB | ~700 MB | ~5 GB | 同 quality，但 Tauri allowlist 收紧、禁所有云 base_url |
| **enterprise（西方/合规）** | sherpa Zipformer 80 MB | Granite 4.0 Micro 1.8 GB | Qwen3-0.6B 400 MB | ~2.3 GB | ~700 MB | ~3.3 GB | ISO 42001 / Apache-2.0 严格场景 |

档位切换在 设置 → AI → 模型库 中提供"一键预设"，背后逐项调用模型库的下载/卸载（ASR 与 LLM 共用同一下载基础设施，但 manifest 分开）。

资源管理策略：

- **ASR 模型常驻**（启动即预热）：避免 PTT 释放时 200–400 ms 冷加载，且小模型 RAM 代价低（~200 MB）
- **LLM 模型懒加载**：首次推理时加载，60–120 s idle 后卸载；用户切到云端 LLM 时完全不分配本地 LLM 内存
- **运行时 RAM ≠ 下载体积**：Q4_K_M GGUF 加载后还要分配 KV cache（~1× 模型大小）+ 推理缓冲，故峰值 RAM 约为体积 1.5–2.5 倍
- **CPU-only 现实**：Windows i5/Ryzen5 上跑 Qwen3-1.7B chat 长回答 ~5–10 s，故 chat 默认走云端；本地负责 FIM（≤300 ms）与语音意图（≤1 s）

### 2.1 按需下载触发矩阵

铁律：**安装包不打包任何模型**（既不打 ASR 也不打 LLM 也不打 sidecar 二进制）。安装后 NewMob 恢复"纯终端 + SSH/SFTP/VNC"形态；任何 AI 功能首次启用时才提示下载。

| 用户动作 | 触发的下载 | 大小 | 提示形式 |
|---------|-----------|------|---------|
| 全新安装 NewMob | 0 字节 | 0 MB | — |
| 首次按 PTT（启用语音）| ASR 模型 | 80 MB | 一次性弹窗 + 进度条 |
| 首次启用"语音→Shell"（v2.1）| 不下载（用云端 LLM）| 0 | — |
| 首次启用"AI Chat Drawer"（v2.4）| 不下载（默认云端） | 0 | 提示填 LLM API Key 或选 GLM 免费档 |
| 首次启用"AI Tab 补全"（v2.2）| FIM 模型 + llama-server sidecar | 410 MB | 一次性弹窗 + 进度条 |
| 用户切 LLM 到 local | chat 模型 + sidecar | 1.4 GB / 2.4 GB | 弹窗 + 警告"将占用 ~3 GB 磁盘 / ~3 GB RAM" |
| 切到 zh-pro / quality / air-gapped 档 | 整套缺失模型 | 至缺多少补多少 | 同上 |
| 应用更新启动时发现已开启某能力且 manifest 中模型有新版 | **不自动下载**，仅状态栏提示 | — | 用户点击"立即更新"才开始 |

**反约束**：

- 不静默后台下载任何 GB 级文件（移动网络 / 计费场景必须用户掌控）
- 下载支持中断恢复（Range header）+ SHA-256 校验 + 失败重试上限 3 次
- 多源 fallback 顺序：HuggingFace → hf-mirror.com（国内镜像）→ ModelScope → 用户自填 base_url
- 进度条显示当前源、速度、ETA；用户可随时取消；取消后已下载部分保留以便续传

### 2.2 模型库管理 UX（设置 → AI → 模型库）

```
┌ ASR 模型 ──────────────────────────────┐
│ ✓ sherpa-zipformer-zh-en   80 MB  当前 │
│   sense-voice-small       234 MB        │
│   whisper-base-q5_1       150 MB        │
│   vosk-small-cn-0.22       42 MB        │
│   [下载 SenseVoice ↓]   [删除 Whisper] │
└────────────────────────────────────────┘

┌ LLM 模型 ──────────────────────────────┐
│   qwen3-0.6b-q4_k_m       400 MB  (FIM)│
│ ✓ qwen3-1.7b-2507-q4_k_m  1.4 GB  当前 │
│   qwen3-4b-2507-q4_k_m    2.4 GB        │
│   minicpm3-4b-q4_k_m      2.4 GB        │
│   granite-4.0-micro-q4    1.8 GB        │
│ [一键预设：cloud-only / mini / standard / zh-pro / quality / air-gapped / enterprise] │
└────────────────────────────────────────┘

┌ 二进制 ──────────────────────────────┐
│ ✓ llama-server (b9264 build)  12 MB     │
└────────────────────────────────────────┘

总占用: 1.89 GB · cache 路径: ~/.cache/newmob/models/
[全部删除] 重置为 cloud-only
```

每个模型条目可独立下载 / 卸载 / 校验。一键预设是"原子档位切换"——背后调用具体的逐项动作。

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

# —— v2.2 输入辅助（in-process FIM；不引 reedline，复用现有 ghost-text 渲染层）——
llama-cpp-2 = "0.1"        # 静态链接 llama.cpp，FIM 直接 in-process 调用
# reedline                 # 已删除：NewMob 已有 React 实现的 inline ghost-text + Common Commands Palette，
                           # 不再引入第二条独立的输入辅助管线（避免双线并行）

# —— v2.0 GPU 检测（CPU 必兜底；Vulkan 默认覆盖 90% Windows GPU）——
ash = { version = "0.38", optional = true }    # Vulkan loader，仅用作运行时 GPU 检测
# wgpu                     # 暂不引；ash 已足够做 detect

# —— v2.3 Agent harness ——
rig-core    = { version = "=0.37", features = ["derive"] }   # pin 精确版本（pre-1.0 仍有 breaking）
# rig 备用 fallback：swiftide-agents = "0.x"（仅在 rig 中间件钩子不够时启用）
rmcp        = { version = "1", features = ["server", "client"] }   # 官方 MCP Rust SDK，工具暴露 + 调用

# —— v2.5 Web search 工具 ——
llm_readability = "0.x"    # 页面去广告 / 提取主要文本
fast_html2md    = "0.x"    # HTML → Markdown 流式转换
scraper         = "0.20"   # CSS 选择器（结构化字段抽取时用）
keyring         = "3"      # 跨平台 secret 存储（Web search BYOK 的 API key 存放在 OS keyring）

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

> `rig-core` 仍在 0.x，0.27 → 0.37 间存在 API 变更。在 `src-tauri/src/agent/mod.rs` 内做一层薄 wrapper（约 50–100 行），未来切换 swiftide-agents 或 0.4x 时只动 wrapper。

### 3.2 `src-tauri/tauri.conf.json`

```jsonc
{
  "tauri": {
    "bundle": {
      "externalBin": [
        "binaries/llama-server"          // CPU + Vulkan 二合一单二进制（Windows/Linux ~25 MB；macOS Metal 自动）
                                          // CUDA pack 不打包进 installer，按需下载到 ~/.cache/newmob/sidecar-cuda/
                                          // 详见 §十一 GPU 策略
      ],
      "resources": [
        "resources/models.manifest.json"  // 模型分发清单（~5–10 KB），含三源 URL：ModelScope/gh-proxy/GitHub
                                          // 详见 §十一 模型分发
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

## 六、v2.2 —— 输入辅助增强（扩展现有 ghost-text + AI 改写）

**目标**：在 NewMob 现有终端输入辅助系统上增量加 AI，**不引入 reedline，不替换任何现有逻辑**。

> **现状盘点（不要重复实现）**：NewMob 已经有完整的输入辅助：
> - **Fish 风格 inline ghost-text**：`src/components/terminal/TerminalPanel.tsx:351–373`，自动按键时根据历史前缀匹配显示灰色补全；`Tab` 透传给 shell。
> - **Common Commands Palette**：`src/components/terminal/CommonCommandsPalette.tsx`，`Ctrl+Shift+P` 弹模态面板，融合历史 + 用户自定义 + Windows 预设。
> - **历史 DB**：`src-tauri/src/session/db.rs:31` 的 `command_history` 表，按 `host_key` 分（local / `ssh:host:port:user`），API 见 `src-tauri/src/history.rs`。
> - **设置项**：`src/lib/terminalProfile.ts:32` 的 `inlineSuggestions`、`inlineSuggestionsMax`，UI 在 `TerminalAppearanceSettings.tsx:422`。
> - **PowerShell 例外**：`TerminalPanel.tsx:335` 已对 PowerShell 关闭 ghost-text（避免与 PSReadLine 冲突）。
>
> v2.2 的工作是**在已有的 ghost-text 渲染层上叠加新数据源**，而非引入 reedline 重复造轮子。

### 6.1 三层数据源叠加（在现有 ghost-text 渲染层之上）

```
现有 ghost-text 渲染层（TerminalPanel.tsx 已实现，不动）
   ↑
   ├─ 数据源 1：历史前缀匹配（已实现，host_key 隔离）            ← 0 ms
   ├─ 数据源 2：PATH 可执行文件 + 当前目录文件（v2.2a 新增）       ← <5 ms
   └─ 数据源 3：LLM FIM（v2.2b 新增，opt-in）                   ← 120 ms debounce + 50–150 ms 推理
   
   优先级：1 命中 → 不查 2/3；2 命中 → 不查 3
   PowerShell 例外保持不变（关 ghost-text 整层）
```

数据源 1 已在生产；v2.2 只新增 2 和 3。

### 6.2 数据源 2：PATH + 当前目录文件（仅本地终端）

- 启动时 `which` 扫描 `$PATH`，缓存 10 s TTL
- 当前命令行第一个 token 命中时显示可执行文件名 ghost-text
- 第二个起 token：尝试匹配当前目录文件（仅本地终端有 `cwd` 概念；SSH 会话不做，避免远端 ls）
- 同步执行，<5 ms 完成；不命中即静默回退到数据源 3
- SSH 会话**仅用数据源 1**（历史）+ 数据源 3（FIM），不扫 PATH

### 6.3 数据源 3：LLM FIM（in-process llama-cpp-2，opt-in）

```
prompt 构造：
  prefix = 当前命令行 + 最近 5 条 history（已 redact 敏感字段）
  suffix = ""（行尾）
  max_tokens = 24, stop = ["\n"]
模型：Qwen3-0.6B Q4_K_M（400 MB，仅在用户开启 AI 补全时下载）
延迟预算：debounce 120 ms + 推理 50–150 ms = P95 < 300 ms
```

**为什么 in-process 而非 llama-server sidecar**：HTTP 往返多 30–80 ms（loopback + JSON 编解码 + tokio 跨进程调度），加上 debounce 后预算就紧。`llama-cpp-2` 直接 FFI 调用，零 IPC 开销。

### 6.4 `Ctrl+K` 重新定位为"AI 命令改写"专用入口

**与 `Ctrl+Shift+P`（Common Commands Palette，确定性、无 AI）正交**。

```
当前命令行: kubectl get pods --namespace=prod
按 Ctrl+K → 弹小输入框: "改成查找 status != Running 的"
            → AI 返回: kubectl get pods -n prod | grep -v Running
            → 显示 diff，按 Enter 接受注入到当前行
```

- 不是覆盖层接管整行编辑（避免破坏 xterm 输入栈）
- 不是 Common Commands 替代品（Ctrl+Shift+P 仍是无 AI 的"确定性面板"）
- 是单独的"AI 改写当前命令"小窗，输入 + Enter 后回写当前行

### 6.5 设置项扩展（不破坏现状）

`src/lib/terminalProfile.ts` 现有 `inlineSuggestions` / `inlineSuggestionsMax` 不动；新增：

```ts
// 新增字段
inlineSuggestionsSource: 'history' | 'history+path' | 'history+path+ai';
                        // 默认 'history'（与现状等价）
                        //   'history+path'      → 数据源 1+2（无 LLM、无网络）
                        //   'history+path+ai'   → 数据源 1+2+3（需要下载 FIM 模型）
inlineSuggestionsAiDebounceMs: number;  // 默认 120
aiCommandRewriteShortcut: string;       // 默认 'Ctrl+K'
aiCommandRewriteEnabled: boolean;       // 默认 false
```

### 6.6 新增文件

- `src-tauri/src/tab/mod.rs` —— Tauri 命令 `tab_suggest_path`（PATH/files 扫描）+ `tab_suggest_fim`（FIM via llama-cpp-2）+ `tab_rewrite_command`（Ctrl+K AI 改写）
- `src-tauri/src/tab/path_scanner.rs` —— `which` 扫 `$PATH`，10 s TTL；`std::fs::read_dir` 扫当前目录
- `src-tauri/src/tab/fim_engine.rs` —— wraps `llm::llama_cpp_in_proc`，复用 v2.0 ggml 共享 runtime
- `src/components/terminal/AiRewriteOverlay.tsx` —— `Ctrl+K` 触发的小输入框 + diff 显示
- `src/lib/terminal/aiSuggestionSource.ts` —— 在现有 ghost-text 数据流中加 PATH/FIM 数据源（按优先级 1→2→3 fallback）

### 6.7 修改既有文件

- `src/components/terminal/TerminalPanel.tsx` —— 在现有 ghost-text 计算管线中接入 `aiSuggestionSource`；监听 `Ctrl+K` 唤起 `AiRewriteOverlay`（PowerShell 时隐藏快捷键，与 ghost-text 例外一致）
- `src/lib/terminalProfile.ts` —— 增加上述新字段
- `src/components/terminal/TerminalAppearanceSettings.tsx` —— 增加"输入建议来源"三选一 + AI 改写开关 + 快捷键自定义
- `src-tauri/src/lib.rs` —— 注册 `tab_*` 命令

### 6.8 性能预算（与 §十六 测试方案对齐）

| 数据源 | 触发 | 计算 | 总延迟目标（P95）|
|--------|-----|------|----------------|
| 1 历史 | 同步 | 0 ms（已 cache）| 已达成 |
| 2 PATH/files | 同步 | <5 ms | <10 ms |
| 3 FIM | debounce 120 ms | 50–150 ms 推理 | **<300 ms** |
| Ctrl+K AI 改写 | 用户主动 | 800–2000 ms（chat 任务）| <2 s（云端默认） |

ghost-text 在等待 FIM 时 **不显示骨架**，结果到达再淡入；新键入立即 abort 旧 FIM 请求。

### 6.9 风险 + 缓解

- *与现有 ghost-text 双线并行* → 不并行；新数据源接入同一渲染层、同一 fallback 链
- *本地 0.6B 偶尔吐空字符串* → 空结果不显示
- *PATH 扫描在 WSL / Windows 上踩坑* → `which` crate 已处理；测试 fixture 覆盖
- *FIM 把敏感字符串补出来* → prefix 构造前先调用 `chat::redact`（与 v2.4 共用），含 `password=` `token=` `Bearer ` 的历史行不送 FIM
- *`llama-cpp-2` 构建依赖 clang* → CI 在三平台预装 clang/LLVM；提供 pre-built `.rlib` 缓存加速 CI
- *FIM 模型未下载时 Ctrl+K 仍可用* → AI 改写走云端 LLM Provider（chat task），不依赖本地 FIM 模型；FIM 仅服务 ghost-text 数据源 3
- *PowerShell 例外* → 保持现状，PSReadLine 自身预测足够好，不再叠加 NewMob ghost-text

---

## 七、Voice v2.3 —— rig-core Agent harness + MCP 暴露

**目标**：把"语音意图路由"和"语音生成命令"统一到 Agent 框架下，使能跨工具编排（"找到这台机器最近一次部署失败的日志、把它解释给我"）。**默认走单工具调用模式**（与 v1.x / v2.1 行为兼容）；多工具编排作为 opt-in 高级模式。

### 7.0 库选型决策

经研究对比 9 个 Rust agent harness 候选（rig-core / swiftide / genai / async-openai / RLLM / mistral.rs / goose / rmcp / 手卷 ReAct）+ 是否走 PyO3 Python harness 路径：

| 路径 | 选择 | 理由 |
|------|-----|------|
| **主选 harness** | `rig-core` v0.37（pin 精确版本） | `#[derive(Tool)]` 自动 JSON schema；内置多步 ReAct + max_iterations；Provider 覆盖 OpenAI / Anthropic / DeepSeek / Groq / Gemini / Ollama / OpenAI-compat（涵盖 llama-server）；MIT 许可；月下载 300K |
| **备选 harness** | `swiftide-agents` | rig 中间件钩子（dry-run / 安全检查 / 审计）不够用时切换；它原生提供 `before_tool` / `after_tool` / `before_completion` 生命周期 |
| **MCP 暴露** | `rmcp` v1（官方 SDK） | 把 NewMob 的工具同时暴露为 MCP server，让 Claude Desktop / Goose / Cursor 等也能驱动 NewMob 的会话切换、命令注入。v2.0 内部路径优先，v2.3 加 MCP server 层 |
| **不走 PyO3** | — | PydanticAI / smolagents 优势在 Logfire 等观测栈，与 NewMob 的 5 步 ReAct + 6 工具规模不匹配；+30–60 MB Python 体积、GIL、跨平台签名都太重 |

> rig-core 当前在 0.x，0.27 → 0.37 之间存在 breaking change，故 `Cargo.toml` 中 `rig-core = "=0.37"` 锁版本，并在 `src-tauri/src/agent/mod.rs` 包一层薄 wrapper（约 50–100 行），切换备选时只动 wrapper。

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

// —— v2.5 新增（详见 §九）——
#[tool(description = "在网络上搜索信息。每次调用前会向用户确认搜索关键词与提供方。")]
fn web_search(query: String, freshness: Option<Freshness>, max_results: Option<u32>) -> Vec<SearchHit>;

#[tool(description = "抓取一个 URL 的可读内容（已去广告/导航）。仅允许公网 HTTPS。")]
fn web_fetch(url: String) -> String;
```

关键安全设计：
- 所有"写"工具（`run_in_terminal`、`sftp_upload`、`save_as_runbook`）必须支持 `dry_run`，且默认 `dry_run=true`
- 工具结果回到 LLM 之前先经"action card 确认"步骤
- `read_terminal_tail` 必须 `user_invoked=true` 才会执行 —— 防止 Agent 在多步规划里偷偷读终端
- `web_search` / `web_fetch` 走单独的"网络访问确认"路径，详见 §九 9.4

### 7.2 用户流程（"解释这条报错"快速动作）
1. 终端最后一条命令报错（exit code != 0），状态栏出现"AI 解释"按钮
2. 用户点击 → 弹出 action card："Agent 想读取终端最后 50 行 [允许 / 拒绝]"
3. 用户允许 → Agent 调用 `read_terminal_tail(user_invoked=true)` → `explain_error(text)` → 流式渲染解释（在 v2.4 Chat Drawer 中）
4. 解释下方提供"建议修复命令"按钮 → 走 v2.1 命令预览卡

### 7.3 新增文件
- `src-tauri/src/agent/mod.rs` —— rig-core Agent 装配 + 工具注册 + 薄 wrapper（隔离版本变化）
- `src-tauri/src/agent/tools/*.rs` —— 上述各 tool 的实现，每个独立文件
- `src-tauri/src/agent/safety.rs` —— "写动作必须 dry_run=true 默认 + 用户确认"中间件
- `src-tauri/src/agent/mcp_server.rs` —— rmcp server，把同一组 `#[tool]` 暴露为 stdio/HTTP MCP 端点
- `src/components/agent/ActionCard.tsx` —— 通用 action card 组件（被 v2.1 命令卡复用 + 扩展）
- `src/components/agent/QuickActions.tsx` —— "解释报错 / 改成脚本 / 找历史" 三个固定入口

### 7.4 修改既有文件
- `src-tauri/src/llm/router.rs` → 增加 Agent 任务路径：`router.run_agent(req, TaskKind::AgentDefault)`
- `src-tauri/src/voice/intent_dispatcher.rs` → 把 v1.1 的工具调用迁移到 rig-core Agent（保持向下兼容，工具 schema 不变）
- `src/stores/voiceStore.ts` → `lastIntent` 类型扩展为 `ActionCard[]`（多步编排时的多张卡）

### 7.5 风险 + 缓解
- *Agent 多步规划失控（无限调用工具）* → 单次会话最多 5 步工具调用；超出强制结束 + 错误提示
- *Agent 读终端输出泄漏密码* → `read_terminal_tail` 默认对结果做 `password|token|secret|key=` 行级 redaction
- *本地 1.7B 模型 tool calling 不稳* → Agent 路径默认路由到云端（`agent_default = "deepseek"`）；本地档位仅推单工具模式；可选 MiniCPM3-4B（BFCL v2 76.0）作中文 agent 重度场景
- *rig-core API 仍 pre-1.0* → pin `=0.37`；wrapper 隔离；备用 swiftide-agents 作切换路径
- *MCP server 暴露后被外部应用滥用* → 仅监听 `127.0.0.1`，启动时随机端口 + token 鉴权（用户在设置中复制粘贴 token 给外部 client），默认关闭

---

## 八、v2.4 —— AI Chat Drawer + 终端 `??` 内联对话 + 文本选区 Send-to-AI

**目标**：把 AI 从"语音指令 + 工具调用"扩展为**全形态文本对话能力**——用户可以在 Chat Drawer 中与 AI 自由对话，可以在终端里直接 `??` 唤起内联 AI，可以选中任意终端文本一键送给 AI。同时整合 v2.0–v2.3 已有的工具栈（语音意图、命令预览卡、Agent harness）。

### 8.1 设计目标

- **不抢夺主区域**：右侧抽屉，默认 380 px，可拖拽 280–600 px，可缩起为 50 px 浮动小球
- **不替换终端体验**：所有 AI 入口可一键全关，回到纯终端
- **多入口收敛到同一 ChatStore**：Drawer 主对话、`??` 内联、选区 Send-to-AI、"解释报错"按钮——它们的会话/历史/工具调用记录都进同一时间线
- **复用 v2.1 命令预览卡 + v2.3 Action Card**：Chat Drawer 中工具调用结果直接以卡片渲染，不重新发明组件

### 8.2 五大 AI 入口（合并视图）

```
┌──────────────────────────────────────────┬───────────────────┐
│ TitleBar               [🎤 PTT] [💬 AI] ↗︎ ⓐ                  │
├─────┬────────────────────────────────────┼───────────────────┤
│     │ TabBar                              │                   │
│ 会话│                                     │  AI Chat Drawer   │ ⓑ  右侧 380 px
│ 侧栏│ Terminal                            │  ─ 历史会话列表    │
│     │   $ kubectl get pods                │  ─ 对话区          │
│     │   error: Unable to connect...       │  ─ 输入框          │
│     │   [💡 AI 解释] ⓒ                    │  ─ 工具调用卡       │
│     │                                     │  ─ Web search 提示  │
│     │ ?? 这个错误怎么办  ⓓ 终端内联       │                   │
│     │ ☰ Ctrl+K → AiRewriteOverlay  ⓔ │                   │
│     │                                     │                   │
├─────┴────────────────[选中文本] ────────┴───────────────────┤
│ 选中后：[复制] [Send to AI] [Explain]   ⓕ                     │
└────────────────────────────────────────────────────────────────┘
StatusBar:  ASR ✓  ·  LLM: DeepSeek (云)  ·  AI 写动作: 关
```

| 入口 | 触发 | 行为 |
|------|------|------|
| ⓐ TitleBar 全局快捷区 | 鼠标 / `Ctrl+L` | 开/关 Drawer，状态指示灯 |
| ⓑ AI Chat Drawer（核心新增）| `Ctrl+L` 或 💬 按钮 | 多对话历史 + 流式输出 + 工具卡 |
| ⓒ 终端内联 AI 触发 | 上一条命令 exit code ≠ 0 时显示"💡 AI 解释" | 弹 ActionCard → 注入 stderr → Drawer 流式解释 |
| ⓓ 终端 `??` 内联对话（**v2.4 关键差异化**）| `??` 起首的命令行 | 拦截不发 shell，AI 回复以 ANSI 灰色行内输出 |
| ⓔ Ctrl+K 命令编辑器 | `Ctrl+K` | 见 §六（v2.2）|
| ⓕ 文本选区 toolbar | xterm 选中任意文本 | "Send to AI" / "Explain" / 复制 |

### 8.3 AI Chat Drawer 详细设计

**布局**：右侧抽屉，默认 380 px，CSS Grid 三段（Header / Body / Composer）。

```
┌ AI Chat ─────────────────[× -]┐
│ [+ 新对话] [⏱ 历史] [⚙]       │  Header
├──────────────────────────────┤
│ 用户: 解释这个错误            │
│       (引用了 terminal: 23 行)│  Body：消息列表
│                               │       支持 markdown 流式
│ AI:  这是因为 K8s 集群...     │
│  ┌─ 工具调用 ─────────────┐  │
│  │ 🔍 web_search          │  │
│  │   query: "kubectl..."  │  │
│  │   [允许] [拒绝]        │  │
│  └────────────────────────┘  │
│                               │
│ AI:  根据搜索结果，建议运行： │
│  ┌─ 命令预览 ──────────────┐ │  v2.1 卡复用
│  │ kubectl config use ...  │ │
│  │ 风险: low               │ │
│  │ [Enter 执行] [E 编辑]   │ │
│  └─────────────────────────┘ │
├──────────────────────────────┤
│ ┌──────────────────────────┐ │  Composer
│ │ [📎 附终端] [🔗 附文件]    │ │
│ │ 输入消息... 或 Ctrl+Enter │ │
│ └──────────────────────────┘ │
│ Provider: DeepSeek · 8s 超时   │
└──────────────────────────────┘
```

**关键交互**：
- 多对话（threads），左上"+新对话"按钮；"⏱ 历史"打开会话列表（按时间 / 标题 / 关联终端会话筛选）
- 输入框支持 **`@` 引用语法**：
  - `@terminal:last-50` → 当前终端最后 50 行作为上下文（自动 redact 敏感字段）
  - `@file:./error.log` → 把本地文件内容作为附件
  - `@session:prod-web` → 把指定 SSH 会话的元信息（host、最近命令）作为上下文
- `Ctrl+Enter` 发送；`Esc` 收起；`Cmd/Ctrl+K` 不冲突（Ctrl+K 是 v2.2 编辑器）
- 流式 token 渲染：markdown + 代码块自动加"复制"按钮 + shell 块加"Enter 注入终端"按钮
- 工具调用卡片：Agent 主动调用工具时弹卡，用户允许 / 拒绝 / "本会话内允许"
- 顶部 Provider 标识（颜色区分：本地灰、云端蓝、隐私模式紫）；点击切换 Provider

### 8.4 终端 `??` 内联对话（差异化核心）

**用户故事**：用户在 SSH 会话中遇到错误，不想切走鼠标焦点，直接 `?? 这个错误怎么办` Enter，AI 回答内联在终端里出现。

**设计**：
```
$ kubectl get pods -n prod
error: ...
$ ?? 这个错误怎么办          ← 输入此行 Enter
[AI ⏳ thinking via DeepSeek...]
[AI] 这通常是 kubeconfig 上下文不对。
[AI] 建议运行: kubectl config use-context prod-admin
[AI] [按 Enter 执行 / E 编辑 / Esc 取消]
$ ▌
```

**实现要点**：
- 拦截位置：`src/components/terminal/TerminalView.tsx` 的 `onData` 监听器，检测以 `?? ` 起首的整行（按 Enter 时）
- 拦截后**不**把数据写入 PTY（不进 shell 历史，不进远端 shell）
- AI 回答以 ANSI 灰色背景（`\x1b[48;5;236m`）写到 xterm output buffer
- 命令预览以行内卡片形式渲染（xterm DOM addon 占位 + React 浮层覆盖），按 Enter 后通过 v2.1 `write_terminal` 注入
- **自动禁用条件**（必须）：
  - 终端处于 alt-screen 模式（Vim / SSH 内 less / man / top 等）→ 不拦截
  - shell 在交互式 readline（如 bash 内的 `read` 命令）→ 不拦截（通过 OSC 序列检测）
  - 用户在设置中关闭 `inline_chat_enabled`
- 配置：触发前缀可改（默认 `?? `）；在长 prompt（如 PowerShell）下可设置仅在用户在 prompt 起始位置输入时触发

**技术风险**（重点）：
- xterm.js 与 PTY 数据流的拦截层目前 NewMob 走 `write_terminal(base64)`，需要在前端先做"未发送行缓冲"
- 多终端 / 多 tab 时，每个终端各有自己的 inline 状态机
- ANSI 转义在不同 shell 行为不同（bash vs zsh vs PowerShell vs cmd）
- 故 v2.4 列为"实验性 opt-in"，默认关闭，设置中明确标注"实验性，可能与某些 shell / 程序冲突"

### 8.5 文本选区 Send-to-AI

xterm.js 已有 `selectionChange` 事件。复用 NewMob 现有的右键菜单（`src/components/terminal/`），新增三个动作：

- **Send to AI**：把选中文本作为 `@selection` 引用插入 Chat Drawer 输入框（不直接发送，给用户机会编辑）
- **Explain**：直接发起一个新对话"请解释这段输出"，附 selection 作为上下文，自动发送
- **作为命令编辑**：把选中文本作为 v2.2 Ctrl+K 覆盖层的初始内容（用 AI 改写命令）

**敏感字段 redact**：选区内的 `password=`/`token=`/`Bearer `/`-p<密码>` 等模式自动替换为 `[REDACTED]`，并在 Drawer 中以红色提示用户已脱敏。

### 8.6 ChatStore 数据模型

```typescript
// src/stores/chatStore.ts
interface ChatThread {
  id: string;
  title: string;                  // AI 自动生成或用户改
  createdAt: number;
  updatedAt: number;
  providerId: string;             // 此 thread 用的 LLM provider
  messages: ChatMessage[];
  linkedSessionId?: string;       // 可选关联到某个 SSH 会话
  source: 'drawer' | 'inline' | 'selection' | 'explain-error';
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;                // markdown
  attachments?: Attachment[];     // @terminal / @file / @session 引用快照
  toolCalls?: ToolCallCard[];     // v2.3 ActionCard
  commandPreviews?: CommandPreviewCard[];  // v2.1 卡
  createdAt: number;
  redacted?: boolean;             // 是否做过敏感字段脱敏
}
```

存储：SQLite 新表 `ai_chat_threads` + `ai_chat_messages`，与现有 `voice_audit` 同库。

### 8.7 新增文件

- `src-tauri/src/chat/mod.rs` —— Tauri 命令 `chat_send`（流式）、`chat_list_threads`、`chat_delete_thread`
- `src-tauri/src/chat/store.rs` —— SQLite 持久化（与现有 DB 同 connection 池）
- `src-tauri/src/chat/redact.rs` —— 敏感字段正则脱敏（与 v2.3 的 `read_terminal_tail` 共用）
- `src-tauri/src/chat/inline_intercept.rs` —— `??` 行拦截的后端逻辑（前端做拦截，但 alt-screen 状态、shell 类型探测在后端）
- `src/components/chat/ChatDrawer.tsx` —— 主 Drawer 容器
- `src/components/chat/ChatThreadList.tsx` —— 历史列表
- `src/components/chat/MessageBubble.tsx` —— 单条消息（用户/AI/工具三态）
- `src/components/chat/Composer.tsx` —— 输入框 + `@` 自动补全 + 附件
- `src/components/chat/AttachmentChip.tsx` —— `@terminal` / `@file` 等附件展示
- `src/components/terminal/InlineChatRenderer.tsx` —— 终端内 `??` 回答的浮层渲染
- `src/components/terminal/SelectionToolbar.tsx` —— 文本选区浮动 toolbar
- `src/stores/chatStore.ts` —— 前端状态管理（threads + active thread）

### 8.8 修改既有文件

- `src/components/terminal/TerminalView.tsx` → 拦截 `??` 起首行 + 选区事件 + alt-screen 状态追踪
- `src/layouts/MainLayout.tsx` → 增加右侧 Drawer 槽位（CSS Grid `grid-template-columns: ... 1fr [drawer]`）
- `src/components/window/StatusBar.tsx` → 新增 ASR / LLM / AI 写动作三段状态指示器
- `src/components/settings/AiPanel.tsx` → 增加"Chat Drawer 默认宽度 / `??` 触发开关 / 选区 toolbar 开关"
- `src-tauri/migrations/00X_ai_chat.sql` → 新建表

### 8.9 风险 + 缓解

- *Drawer 抢用户主区域宽度* → 默认 380 px，可缩为 50 px 小球；底部 dock 模式留作 v2.5+ 评估
- *`??` 拦截破坏特殊 shell 行为* → 默认关闭；alt-screen 自动禁用；提供"在此 shell 中暂时禁用"快捷键 `Ctrl+Shift+Q`
- *多 tab / 多 SSH 会话各自独立* → 每个终端一个独立 `inline_state` 实例，Drawer 中按 `linkedSessionId` 过滤显示
- *AI 回答卡死* → 8 s 超时 + 流式取消按钮；超时回退到本地 LLM（如已下载）
- *敏感字段被 AI 看到* → 选区/`?? `/`@terminal` 三个入口共用同一 `redact` 函数；每次发送前显式记录"已脱敏 N 行"日志
- *会话历史无限增长* → 默认保留 30 天；用户可在设置中调整或一键清空；归档到本地 zip 导出

---

## 九、v2.5 —— Agentic 联网搜索（双轨：原生 + 客户端）

**目标**：给 Agent 加上"上网查最新资料"的能力——例如查 kubectl 1.32 的 release notes、查某个错误码在 GitHub Issues 中的讨论、查 OpenSSH 9.x 新语法。**关键决策**：主流商业 LLM Provider 大多已内置 web_search（OpenAI / Claude / Gemini / Grok / Mistral / GLM / Qwen / Perplexity Sonar），NewMob 走"capability-aware 双轨"——优先用 Provider 原生（更隐私、更省钱、更快），客户端 SearXNG/Tavily 作为深度搜索（`deep_search`）补位。

### 9.0 原生 vs 客户端搜索（capability-aware 路由）

研究证实：**原生其实更隐私**（query 只到一个第三方，客户端方案 query 到两个第三方），延迟少 0.5–1.5 s，结果质量也更好（直连 Bing/Google 索引）。但客户端方案是无原生 Provider（DeepSeek / 本地 / Groq / Cerebras）的唯一选择，也是 BYOK 用户偏好。

**Provider 原生能力矩阵**（2025–2026）：

| Provider | 原生 web search | 计费（额外）| 引用机制 | NewMob 处理 |
|----------|----------------|------------|---------|------------|
| **OpenAI** | ✅ `tools:[{type:"web_search"}]` | $10–25/1k 调用 + tokens | `url_citation` 注解 | 原生为主；客户端改名 `deep_search` |
| **Anthropic Claude** | ✅ `web_search_20250305` | ~$10/1k | `cited_text` 区间 | 同上 |
| **Google Gemini** | ✅ `tools:[{google_search:{}}]` | 按 query 计费 | `groundingChunks` + 必须渲染 search pill | 同上 |
| **xAI Grok** | ✅ `search_parameters: {mode, sources}` | ~$5–25/1k | `citations[]` | 同上 |
| **Mistral** | ✅ `web_search`（Agents API）| 按调用 | `sources` | 同上（仅 Agents API 路径） |
| **GLM (Zhipu)** | ✅ `tools:[{type:"web_search"}]` | 按调用 | `web_search` 块 | 同上 |
| **Qwen Dashscope** | ✅ `enable_search: true` | 含在 token 中 | `search_results` | 同上 |
| **Perplexity Sonar** | ✅ **隐式**（每次调用都搜）| 含 token 价 | `citations[]` | **不注册任何搜索工具**，靠模型本身 |
| **DeepSeek** | ❌ | — | — | 仅客户端 `web_search`（SearXNG/Tavily）|
| **Groq / Cerebras / SiliconFlow** | ❌ | — | — | 仅客户端 |
| **本地 llama-server** | ❌ | — | — | 仅客户端 |

**ProviderCaps 抽象**：

```rust
// src-tauri/src/llm/openai_compat.rs
pub struct ProviderCaps {
    pub native_web_search: Option<NativeSearchSpec>,
    pub native_search_implicit: bool,        // Perplexity Sonar = true
    pub citation_format: CitationFmt,        // OpenAiAnnotations | AnthropicCitedText | GeminiGrounding | GrokCitations
}

pub enum NativeSearchSpec {
    OpenAi { tool: &'static str, max_uses: Option<u32> },
    Anthropic { tool_version: &'static str, max_uses: Option<u32> },
    Gemini { dynamic_threshold: Option<f32> },
    GrokSearchParams { mode: &'static str, sources: Vec<&'static str> },
    MistralAgent,            // 切到 Agents API
    GlmTool, QwenEnableFlag, // OpenAI-compat with quirky payload
}
```

**路由规则**（在 rig-core wrapper 中实现）：

| Provider 类型 | 注册的工具 | 用户体验 |
|--------------|----------|---------|
| 有原生 + 用户开启 native | `web_search`（→ 透传到原生）+ `deep_search`（→ NewMob 客户端，仅 BYOK 时启用）| 默认走原生；用户主动 `--deep` 触发深度 |
| Perplexity Sonar | **不注册任何搜索工具** | Provider 自己搜 |
| 无原生（DeepSeek/Groq/本地）| 仅 `web_search`（→ NewMob 客户端 SearXNG）| 走客户端路径 |
| 用户在 §9.4 全关搜索 | 不注册 | Agent 提示"我无法访问网络" |

**配置**：

```jsonc
"llm": {
  "providers": {
    "openai":   { "...": "...", "prefer_native_web_search": true  },
    "claude":   { "...": "...", "prefer_native_web_search": true  },
    "deepseek": { "...": "...", "prefer_native_web_search": false /* 无原生 */ }
  }
},
"web_search": {
  "client_provider":     "searxng",   // searxng | tavily | serper | brave | exa | google_cse
  "client_enabled":      false,       // 默认关；BYOK 用户开启后曝露 deep_search
  "expose_as_deep_search": true       // 当 provider 有原生时，客户端工具改名为 deep_search
}
```

**全本地模式联动**：开关打开后强制 `prefer_native_web_search=false` 全列、`web_search.client_enabled=false`，整个搜索能力消失（与 §1.5 一致）。

**UX 双轨**：

| 维度 | 原生（Provider 内部）| 客户端（NewMob 自调）|
|------|-------------------|-------------------|
| 确认卡 | **不弹**（用户选 Provider 时已默认同意"该 Provider 可联网"）| **必弹**（这是用户的第三方 key）|
| 首次披露 | 第一次触发时一行 toast："OpenAI 可能联网检索" | 见 §9.4 三档确认 |
| Drawer 渲染 | 紧凑 pill：`🔍 搜索 3 条 (via OpenAI)` 可展开看 query + 引用 | 流式 SearchProgressChip + 完整结果列表 |
| 流式事件 | 各家不同事件 → 归一为 `SearchEvent { provider, queries[], results[], elapsed_ms }` | 已统一 |
| 引用 | 各家 citation_format 归一为 `{url, title, snippet, span_in_msg}` | 已统一 |

### 9.1 默认提供方：SearXNG（无 API key、零配置）

研究覆盖 11 家服务商，结论：

- Bing Search API **2025 年 8 月已下线**（被 Azure AI Agent 替代，强绑定 Azure 账户）
- Kagi API 仍是邀请制
- DuckDuckGo Instant Answer 不返回普通 SERP（仅 zero-click）
- 其他商业 API 都需要 key，把 key 嵌入桌面二进制几小时内就会被人提取并刷爆

**默认选 SearXNG**：FOSS（AGPL-3.0），自托管 / 公共实例均可，meta-search 聚合 Google / Bing / Brave / Baidu，对中文 + 英文都有合理覆盖。

| 部署模式 | 优点 | 缺点 | 何时用 |
|---------|------|------|-------|
| **公共实例白名单**（默认）| 零配置即可用 | 公共实例有限速 / 不稳定 / 部分阻断 bot | 普通用户 |
| **自托管 sidecar**（一键）| 速度快 / 稳定 / 无限速 | 需要 Docker 或额外二进制 | 重度用户 / 隐私偏执 |
| **用户自填 SearXNG URL** | 完全自主 | 需用户运维 | 高级用户 |

公共实例白名单以"最近 30 天可用率"动态轮换：默认列表 `searx.be`、`search.inetol.net`、`searxng.world` 等；NewMob 启动时 ping 一遍，挑选可用的。

### 9.2 BYOK 升级（高质量）

| 提供方 | 价格 | 中文质量 | 英文质量 | 何时推荐 |
|--------|------|---------|---------|---------|
| **Serper.dev** | $1/1k（10 results）| 优（Google 索引含 CSDN/掘金/知乎）| 优 | 中文重度用户 |
| **Tavily** | 1k/月免费 → $0.008/req | 良 | 优（自带 LLM-ready snippets）| 英文为主 / agent 友好 |
| **Brave Search** | $5 月信用 ≈ 1k/月免费 → $5/1k | 中等 | 良（独立索引）| 偏好非 Google 索引 |
| **Exa** | $7/1k（Search）| 弱 | 良（神经索引）| 学术 / 长尾英文 |
| **Google Custom Search** | 100/天免费 → $5/1k | 优 | 优 | 已有 Google Cloud 账户的用户 |

UX 上仅在"高级"区暴露 BYOK；默认用户看不到 API key 输入框。

### 9.3 工具实现

```rust
// src-tauri/src/agent/tools/web_search.rs
#[tool(description = "在网络上搜索信息。每次调用前会向用户确认搜索关键词与提供方。")]
async fn web_search(
    query: String,
    freshness: Option<Freshness>,           // last_day | last_week | last_month
    max_results: Option<u32>,               // default 5, max 10
) -> Result<Vec<SearchHit>>;

pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,                     // "searxng:searx.be" / "tavily" / ...
    pub published_at: Option<String>,
}

// Provider trait
#[async_trait]
pub trait SearchProvider: Send + Sync {
    async fn search(&self, q: &str, opts: &SearchOptions) -> Result<Vec<SearchHit>>;
}
// impls: SearXNG, Tavily, Serper, Brave, Exa, Google
```

```rust
// src-tauri/src/agent/tools/web_fetch.rs
#[tool(description = "抓取一个 URL 的可读内容（已去广告/导航）。仅允许公网 HTTPS。")]
async fn web_fetch(url: String) -> Result<String>;
// 实现：
// 1. URL parse + scheme 必须 https
// 2. 域名/IP 解析后拒绝 RFC1918 / loopback / link-local（SSRF 防御）
// 3. reqwest GET，带 User-Agent: "NewMob/x.y (web_fetch)"，10 s 超时
// 4. Content-Type 检查：text/html → llm_readability + fast_html2md → Markdown
//                       application/json → 直接返回（截断 256 KB）
//                       其他二进制 → 拒绝（"不支持的内容类型"）
// 5. 响应体上限 2 MB；超出部分截断 + 标注
// 6. 返回 markdown 文本给 Agent
```

### 9.4 隐私确认 UX（强制）

参考 Cursor / Zed / JetBrains AI 的"按调用确认 + 本会话内记忆 + 设置全局开关"三档模式。**不允许 Agent 静默搜索网络**——每次搜索必须用户看见关键词与提供方。

```
┌─ Agent 想搜索网络 ─────────────────────────────┐
│ 🔍 搜索关键词: kubectl 1.32 release notes      │
│ 📡 提供方: SearXNG @ searx.be                   │
│                                                 │
│ ⚠ 这条搜索词会发送到第三方服务，可能被记录       │
│                                                 │
│ [允许一次] [本会话内允许] [拒绝]                  │
│ ☐ 设为此 thread 默认行为（仍可在设置中关闭）     │
└─────────────────────────────────────────────────┘
```

三档模式：

| 设置 → AI → Web Search | 行为 |
|-----------------------|------|
| **每次确认**（默认）| 每次工具调用都弹卡 |
| **首次确认 + 本 thread 内静默** | 同 thread 后续搜索不再弹卡，新 thread 重置 |
| **总是允许** | 不弹卡，但 Drawer 中仍显示"🔍 搜索: <query>"流式提示 |
| **完全禁用** | Agent 看不到 `web_search` / `web_fetch` 工具 |

正在搜索时 Drawer 中显示 streaming chip："🔍 搜索 'kubectl 1.32 release notes' via searxng… (已 0.8 s)"，可点 X 取消。

### 9.5 新增文件

- `src-tauri/src/agent/tools/web_search.rs` —— `web_search` 工具 + Provider trait
- `src-tauri/src/agent/tools/web_fetch.rs` —— `web_fetch` 工具 + SSRF 防御
- `src-tauri/src/agent/search/searxng.rs` —— SearXNG provider 实现
- `src-tauri/src/agent/search/tavily.rs` —— Tavily provider 实现
- `src-tauri/src/agent/search/serper.rs` —— Serper provider 实现
- `src-tauri/src/agent/search/brave.rs` —— Brave provider 实现
- `src-tauri/src/agent/search/instances.rs` —— SearXNG 公共实例可用性探测 + 轮换
- `src-tauri/src/agent/search/key_storage.rs` —— `keyring` crate 包装，BYOK API key 存 OS keyring（不进 SQLite）
- `src/components/settings/WebSearchPanel.tsx` —— 提供方选择 + BYOK 输入 + 确认模式
- `src/components/agent/WebSearchConfirmCard.tsx` —— 弹出确认卡（复用 ActionCard）
- `src/components/chat/SearchProgressChip.tsx` —— Drawer 中流式搜索状态

### 9.6 修改既有文件

- `src-tauri/src/agent/mod.rs` → 注册 `web_search` 和 `web_fetch` 到工具列表（默认禁用，用户在设置中开启后才向 LLM 暴露）
- `src-tauri/src/agent/safety.rs` → 增加"网络访问类工具的强制确认中间件"
- `src-tauri/src/voice/audit.rs` → 审计日志 `outcome` 增加 `search_allowed | search_denied | search_cancelled`
- `tauri.conf.json` allowlist → 增加 SearXNG 公共实例 + 几家 BYOK 商家域名（用户开启对应 provider 时动态加入）

### 9.7 风险 + 缓解

- *公共 SearXNG 实例 ToS 多数禁止自动化流量* → 默认列表带 User-Agent + 适度限速 + 失败自动切换；UX 中明确提示"建议自托管"，并提供"一键运行 docker run searxng/searxng"按钮
- *搜索查询被第三方记录* → 每次确认 UX 已强制；用户可切到自托管 SearXNG 完全私有；审计日志中**不记录** query 文本本身（仅记录"是否搜索 + 提供方 + 结果数"），避免本地 DB 也成泄漏点
- *BYOK key 从二进制提取* → 不存在；NewMob 不嵌入任何默认 key；BYOK key 走 OS `keyring`（macOS Keychain / Windows Credential Vault / Linux Secret Service），不进 SQLite，不进 NewMob 进程内存超过必要时长
- *`web_fetch` 被滥用作 SSRF / 内网扫描* → 域名解析后强制拒绝 RFC1918 / loopback / link-local；不允许 http://（仅 https）；不允许端口非 443
- *Agent 在多步规划中"搜了又搜"* → 单次 ReAct 调用最多 3 次 `web_search`（在 §7.5 的 5 步上限内进一步细分）
- *国内访问公共 SearXNG 慢 / 被墙* → 国内镜像列表（hf-mirror 风格）+ 用户自填 URL 是默认逃生通道
- *SearXNG 实例返回结果质量参差* → Agent prompt 中告知"如果首次结果不相关，可改写关键词重试 1 次"；超过 1 次重试视为失败

---

## 十、UI 布局变更总览（合并视图）

把分散在 §五 / §六 / §八 / §九 的 UI 入口合并为一张总图，避免它们互相冲突或重复。

### 10.1 三层 z-index 模型

```
z-index 层级（从下到上）：
  100  MainLayout 主区域（终端 / SFTP / VNC）
  200  AI Chat Drawer（右侧抽屉，stacking context）
  300  Ctrl+K AiRewriteOverlay（小输入框 + diff，不接管整行）
  400  ActionCard / 命令预览卡 / Web Search 确认卡（modal-like）
  500  PrivacyToggle "全本地模式"切换确认
  900  Toast / 错误提示
```

任何时刻最多一个 z=400 卡片可见；多卡排队（Agent 多步时）按 FIFO 弹出。

### 10.2 键盘绑定（去重 + 不冲突）

| 快捷键 | 行为 | 上下文 |
|--------|------|--------|
| `Ctrl/Cmd + L` | 开/关 AI Chat Drawer | 全局 |
| `Ctrl/Cmd + K` | 打开命令编辑器覆盖层（v2.2）| 终端聚焦时 |
| `Ctrl/Cmd + Enter` | Drawer 中发送消息 | Composer 聚焦 |
| 长按 `Space`（或自定义）| PTT 录音 | 全局（v1.0 已有）|
| `Esc` | 关闭最上层 overlay/card | 任意 |
| `Ctrl + Shift + Q` | 在当前终端暂时禁用 `??` 拦截 | 终端聚焦 |
| `??` 起首行 + Enter | 终端内联对话（v2.4）| 终端聚焦 + 非 alt-screen |
| 双击 / 拖选 + 浮动 toolbar | 文本选区 Send-to-AI | 终端选中文本 |

**冲突避免**：
- xterm.js 中 `Ctrl+L` 默认是 clear-screen——NewMob 已捕获作 Drawer toggle，clear-screen 用户改为 `Ctrl+Shift+L` 或继续走 `clear` 命令（与现状一致）
- `Ctrl+K` 在 zsh 是 kill-line——同上，覆盖层接管，原 kill-line 仍可通过其他方式触发
- 所有快捷键在设置中可重映射

### 10.3 布局响应式策略

| 窗口宽度 | Drawer 默认行为 | 备注 |
|---------|----------------|------|
| ≥ 1280 px | 默认展开 380 px | 主流桌面 |
| 960–1280 px | 默认收起为 50 px 浮动小球 | 小屏笔电 |
| < 960 px | 关闭 + 提示用户拉大窗口 | 极端小屏 |

Drawer 展开时主区域自动收缩；用户可拖拽分隔条或一键收起。所有 AI 入口（`??` 内联、Ctrl+K、选区 toolbar）在 Drawer 关闭时仍工作（消息暂存 ChatStore，下次开 Drawer 时 surfaces）。

### 10.4 状态栏（StatusBar）AI 段

```
[左侧] 已有的 SSH 连接状态 / 终端模式 等
[中间空白]
[右侧 AI 段] ✓ ASR(sherpa-zh-en, 200MB)  │  LLM: DeepSeek (online, 420ms)  │  AI 写: 关  │  Search: SearXNG  │  10:23
                ↑ 点击 → 模型库面板         ↑ 点击 → Provider 切换           ↑ 点击 → 全局开关  ↑ 点击 → 搜索面板
```

每段都是可点击 affordance，零跳转层级直达对应设置。三色状态：

- 绿点 ✓ 正常
- 黄点 ⚠ 配置不完整 / 可降级（如本地 LLM 未下载，仍可用云端）
- 灰点 ○ 未启用
- 红点 ✗ 错误（如云端 API key 失效）

### 10.5 全关静音模式

设置 → AI → 顶部"完全禁用 AI 功能"开关。打开后：

- TitleBar 隐藏 🎤 / 💬 按钮
- 终端 `??` 不拦截（直接发到 shell）
- Ctrl+K 仍是命令编辑器但仅第一层硬补全（无 LLM）
- 选区 toolbar 不显示 Send to AI
- StatusBar AI 段隐藏
- 模型库下载入口隐藏

NewMob 此时与一个普通 Tauri 终端无区别，零网络请求 / 零模型加载 / 零额外 RAM。这是**回归基础形态**的安全网，不是默认状态。

---

## 十一、模型分发与跨 OS GPU 策略

### 11.1 模型分发：三源 manifest（ModelScope 主 / gh-proxy 兜底 / GitHub canonical）

**核心问题**：GitHub Releases 在中国大陆经常需要代理；研究确认到 2025–2026：fastgit 已停服、原 ghproxy.com 不稳；jsDelivr 不分发 Release 二进制且 50 MB 上限；R2/B2 公共桶在 mainland edge 不稳；Aliyun OSS / Tencent COS 公共桶要 ICP 备案。

**结论**：**ModelScope（modelscope.cn）作 CN 一等公民 + GitHub Releases 作 canonical + gh-proxy.com 作 GitHub 代理兜底**。NewMob 自建一个 ModelScope 模型仓库 `newmob/asr-models` 和 `newmob/llm-models`，由 CI 同步发布到 GitHub Releases 和 ModelScope。

```
NewMob 自己上传到两个 hub：
  1. GitHub Releases (canonical, signed)        ← 海外用户 + CN 用户走代理
  2. ModelScope repo (modelscope.cn/newmob/*)    ← CN 一等公民（无 ICP 要求，免费 LFS）
  
manifest 中每个模型给 3 条 URL（按 probe 顺序）：
  primary:   https://modelscope.cn/api/v1/models/newmob/{repo}/repo?Revision=master&FilePath={file}
  secondary: https://gh-proxy.com/https://github.com/engcapa/newmob-models/releases/download/{tag}/{file}
  tertiary:  https://github.com/engcapa/newmob-models/releases/download/{tag}/{file}
```

为什么不用 HuggingFace 主源：HF 在国内即便经 hf-mirror.com 也是只读 passthrough，不能让 NewMob 上传；ModelScope 由阿里云持有、允许任意账户 `git push` LFS 仓库，社区 30–60 GB 模型证明带宽可用。HF 仅作"海外可达性最强备选"，但不进 NewMob 默认 manifest 顺序。

### 11.2 manifest 结构

`src-tauri/resources/models.manifest.json`（~5–10 KB，**安全打包**）：

```json
{
  "asr_sherpa_zipformer_zh_en_small": {
    "version": "2025-04-01",
    "size_mb": 80,
    "sha256": "abc...",
    "license": "Apache-2.0",
    "urls": [
      "https://modelscope.cn/api/v1/models/newmob/asr-models/repo?Revision=master&FilePath=sherpa-zipformer-zh-en/v1/model.tar",
      "https://gh-proxy.com/https://github.com/engcapa/newmob-models/releases/download/asr-v1/sherpa-zipformer-zh-en.tar",
      "https://github.com/engcapa/newmob-models/releases/download/asr-v1/sherpa-zipformer-zh-en.tar"
    ]
  },
  "llm_qwen3_1_7b_instruct_q4_k_m": {
    "version": "2507",
    "size_mb": 1400,
    "sha256": "def...",
    "license": "Apache-2.0",
    "urls": [ "...", "...", "..." ]
  }
  /* 其他模型 ... */
}
```

应用启动时还可远程拉一次最新 manifest（`https://newmob.app/models.manifest.json`）覆盖本地——这样能在不发版的前提下加 / 改 mirror，无需用户更新应用。

### 11.3 客户端下载逻辑（并发 probe + 断点续传）

```rust
// src-tauri/src/models/downloader.rs（与 ASR / LLM 共用）
async fn download_model(manifest: ModelManifest) -> Result<()> {
    // 1. 并发 HEAD 三条 URL，2s 超时
    let probed = futures::future::join_all(
        manifest.urls.iter().map(|u| async move {
            (u, tokio::time::timeout(Duration::from_secs(2), http_head(u)).await)
        })
    ).await;

    // 2. 选首个 200 OK 的
    let chosen = probed.into_iter()
        .filter_map(|(u, r)| r.ok().and_then(Result::ok)
                                  .filter(|r| r.status() == 200).map(|_| u))
        .next()
        .ok_or(Error::AllMirrorsUnreachable)?;

    // 3. Range 请求支持断点续传；已下载部分 SHA-256 前缀校验
    download_with_resume(chosen, &manifest.sha256, on_progress).await?;

    // 4. 完成后整文件 SHA-256 强校验，失败删除重试（最多 3 次，自动切下一镜像）
    verify_sha256(&local_path, &manifest.sha256)
}
```

### 11.4 用户可控的 Mirror 设置

```
设置 → AI → 模型库 → 下载源
  ◉ 自动（推荐）        ← 默认按 probe 顺序
  ○ ModelScope 优先     ← 国内用户手动锁定
  ○ GitHub 直连         ← 海外用户手动锁定
  ○ 自定义 base URL     ← 企业内网镜像
```

无 OOTB VPN / 内置代理（违反应用商店政策）。

### 11.5 GPU 后端策略：Vulkan 默认 + CUDA pack 可选 + CPU 必兜底

研究真实数据（RTX 3080，Q4_0 7B）：

| 后端 | pp512 | tg128 | 二进制增量 | 运行时依赖 | 平台 |
|------|-------|-------|----------|-----------|------|
| **CPU AVX2** | 基线 | 基线 | 0 | 无 | 全平台（必兜底）|
| **Vulkan** | ~1700 t/s（38% CUDA）| ~62 t/s（**47% CUDA**）| **+3–5 MB** | Vulkan 1.3 ICD（系统驱动自带）| **NV/AMD/Intel 全 GPU** |
| CUDA | ~4500 t/s | ~131 t/s | +120 MB（cuBLAS） | CUDA 12.x DLL（200–400 MB） | NVIDIA Win/Linux 独占 |
| Metal | 接近 CUDA | 接近 CUDA | 0（macOS 自带） | 无 | Apple Silicon 独占 |

**关键发现**：Vulkan 二进制增量仅 3–5 MB，但能覆盖 NV/AMD/Intel **全部** Windows GPU；性能约 CUDA 47%（足够 Q4_K_M 模型流畅推理）；且**比 CUDA 少占 ~5 GB VRAM**（Qwen 类模型上 8 GB 显卡反而能跑 13B）。

**决策：单一 sidecar 二进制三档自动选**：

```
src-tauri/binaries/
  llama-server-{target-triple}      ← 默认打包（~25 MB）
                                       Windows: CPU AVX2 + Vulkan ICD
                                       Linux:   CPU AVX2 + Vulkan ICD
                                       macOS:   CPU + Metal（同一二进制）
```

启动时 `gpu_detect`：

```rust
// src-tauri/src/llm/gpu_detect.rs
pub enum GpuBackend {
    Cpu,                    // 永远可用
    Metal,                  // macOS 自动
    Vulkan(VulkanInfo),     // 检测到 Vulkan 1.3 ICD 即用
    Cuda(CudaInfo),         // 用户主动开启 + 已下载 CUDA pack
}

pub fn detect() -> GpuBackend {
    #[cfg(target_os = "macos")] { return GpuBackend::Metal; }

    if let Some(v) = detect_vulkan_via_ash() {
        if driver_meets_min(&v) {
            return GpuBackend::Vulkan(v);
        }
    }
    GpuBackend::Cpu  // 兜底
}

const NVIDIA_MIN_DRIVER: u32 = 535;     // CUDA 12.0 / Vulkan 1.3 兼容下限
const AMD_MIN_DRIVER:    &str = "24.0"; // Adrenalin 24.x 起 Vulkan coopmat 稳定
```

### 11.6 CUDA pack（可选高性能档）

```
设置 → AI → 高级 → GPU 加速
  ◉ 自动（CPU + Vulkan/Metal）             ← 默认
  ○ 下载 NVIDIA 加速包（120 MB）            ← 仅 NVIDIA 用户主动开启
                                              提示需 CUDA 12.x runtime（用户系统已装）
```

CUDA pack 不打包进 installer：
- 避免分发 200–400 MB 的 CUDA 运行时
- 避免 CUDA 重发布的法律审查
- 用户主动开启时，下载到 `~/.cache/newmob/sidecar-cuda/llama-server-cuda-{triple}`
- 运行时用 `tauri-plugin-shell::Command::new`（不是 sidecar——sidecar 强制 build-time 路径）

### 11.7 sherpa-onnx GPU

ASR 模型（Whisper-small / SenseVoice）在现代 CPU 上 RTF 已 <0.5（5 s 音频 < 200 ms 推理），**默认不开 GPU**。研究指出 ONNX Runtime CUDA EP 加 200+ MB 收益不值。Apple Silicon 上 CoreML EP 免费可开，作为可选项暴露在设置里。

### 11.8 GPU 降级与状态栏提示

| 情况 | 行为 |
|------|------|
| 用户在设置中关 GPU | 立即回 CPU；llama-server 重启走 CPU build flag |
| Vulkan 检测失败 | 静默回 CPU + 状态栏黄点："GPU 不可用，使用 CPU" |
| CUDA pack 已下但驱动版本不够 | 黄点警告 + 自动回退 Vulkan/CPU |
| 卸载 GPU 驱动后下次启动 | 自动回 CPU |
| 笔记本电池模式（Windows） | 可选自动回 CPU（设置） |

### 11.9 风险 + 缓解

- *ModelScope 改变开放策略 / 限速* → manifest 远程可更新；2 个 fallback 镜像（gh-proxy + 直连）兜底
- *gh-proxy.com 不稳定* → 客户端 manifest 中 secondary 列表可写多个代理（gh-proxy / kkgithub），按 probe 顺序
- *Vulkan 驱动 bug 导致黑屏 / 推理错误* → driver 版本检查 + 失败计数 3 次后强制回 CPU + 持久化"此机器禁用 Vulkan"标记
- *Windows Defender / SmartScreen 拦截 CUDA pack* → 签名 + 用户预下载二进制提供 SHA-256
- *用户从 ModelScope 下载得到的文件与 GitHub Release 不一致* → 强 SHA-256 校验，不一致直接删除重下下一镜像

---

## 十二、落地路线（6–8 周）

新增 v2.4（Chat Drawer + 终端内联）和 v2.5（Web Search）后，整体周期从原 4–6 周扩展到 6–8 周。可分两轮上线：先 v2.0–v2.3 + Chat Drawer 静态壳（6 周），再 v2.4 完整 + v2.5（+2 周）。

| 周 | 阶段 | 交付 |
|----|------|------|
| W0 | **spike** | ① ggml 共享构建（whisper-rs + sherpa-onnx + llama-cpp-2 同一 ggml 不冲突）；② llama-server CPU+Vulkan 单二进制三平台体积/签名/启动；③ rig-core 0.37 中间件钩子能力评估；④ **三源 manifest probe POC**（mock ModelScope / gh-proxy / GitHub）；⑤ **Vulkan 检测 via `ash`** 在三平台跑通 |
| W1 | **v2.0a** | Cargo（rig-core 0.37 / rmcp / sherpa-onnx / llama-cpp-2 / keyring / ash）+ Tauri sidecar（llama-server CPU+Vulkan 单二进制）+ ASR Trait + sherpa-onnx 默认实现 + LLM Trait + OpenAI-compat 通用实现 + ProviderCaps 抽象（含 native_web_search 字段） |
| W1–W2 | **v2.0b** | DeepSeek / GLM / SiliconFlow / Groq preset + 双面板 UI（AsrPanel + LlmProvidersPanel）+ 超时回退（云→本地）+ Vault key 类型扩展 + **三源 manifest 下载器（probe + 续传 + SHA-256）** |
| W2 | **v2.0c** | v1.1 现有 `AiBackend` 拆分到 `asr::*` + `llm::*`（行为不变，回归测试）+ 全本地模式开关（PrivacyToggle）+ ggml 共享构建落地 + **GPU detect + CPU 兜底** |
| W2.5 | **v2.4 静态壳（提前）+ MockProvider 框架** | ChatStore + ChatDrawer 容器 + 简单 chat（仅文本，无工具，无 `??`）+ **MockProvider trait 与 axum mock 端点**（让所有后续 e2e 不用真 key）|
| W3 | **v2.1a** | `generate_shell_command` 工具 + 命令预览卡 + 黑名单评估器（100% 单测） |
| W3 | **v2.1b** | 风险等级闸门 + high 风险二次确认 + 会话级"禁用 AI 写动作"标记 + 审计日志扩展 |
| W4 | **v2.2a** | **数据源 2（PATH/files）接入现有 ghost-text** + 设置项三选一（history / +path / +path+ai）；现有 ghost-text 与 Common Commands Palette 行为不动 |
| W4 | **v2.2b** | 数据源 3（Qwen3-0.6B FIM via llama-cpp-2 in-process）+ 120 ms debounce + 输入历史脱敏 + Ctrl+K AI 改写小窗 |
| W5 | **v2.3a** | rig-core 0.37 装配（薄 wrapper）+ 9 个工具实现 + safety 中间件 + 单步模式（替换 v1.1 实现） |
| W5 | **v2.3b** | 多步编排（opt-in）+ "解释报错" / "改成脚本" 快速动作 + ActionCard 通用化 + rmcp server 暴露（默认关闭） |
| W6 | **v2.4 完整 + 烟雾测试套件** | 文本选区 Send-to-AI + `@terminal` / `@file` / `@session` 引用 + 命令预览卡集成进 Drawer + 历史 thread 持久化 + **开箱即用烟雾 + 并行三任务 + FIM/voice/chat 延迟测试** |
| W7 | **v2.4 内联** | 终端 `??` 内联对话（实验性开关）+ alt-screen 检测 + ANSI 行内渲染 + 在 bash/zsh/PowerShell 三 shell 上回归 |
| W7–W8 | **v2.5 双轨搜索** | ProviderCaps 路由（原生 web_search 透传 + 客户端 deep_search）+ SearXNG provider（白名单 + 自托管按钮）+ 隐私确认 UX 双轨（原生不弹卡 / 客户端弹卡）+ BYOK（Tavily/Serper/Brave）|
| W8 | **打磨** | zh-pro / quality / enterprise 档位（SenseVoice / MiniCPM3-4B / Granite）+ **CUDA pack 后台下载流程** + 端到端 e2e（qa-ui-auto）+ 文档 + **性能基线发布** |

时间表前置假设：v1.0 / v1.1 / v1.2 已完成（按 `voice-input-plan.md` 推进）。如 v1.x 仍在进行，v2.0a/b 可与 v1.1 并行（ASR/LLM Trait 抽象本身在 v1.1 就用得上）。

---

## 十三、与 `roadmap.md` 的对齐

| App 版本 | Voice 阶段 | AI 原生阶段 |
|---------|-----------|-------------|
| v0.3.x  | v1.0 / v1.1 | v2.0 ASR + LLM Trait 抽象（提前到 v0.3.x，v1.1 直接用）+ v2.4 静态 Chat Drawer 壳 |
| v0.4.x  | v1.2 | v2.1 语音→Shell + v2.2 Tab 补全（in-process FIM）|
| v0.5.x  | —    | v2.3 Agent harness + 多步编排 + v2.4 完整（Chat Drawer + 选区）+ rmcp server |
| v0.6.x  | —    | v2.4 内联（`??`）+ v2.5 Web Search |
| v1.0    | 收口审计 | 默认档位锁定（**cloud-only** 80 MB 入门）+ Runbook 联动 |

---

## 十四、不做事项（v2.x 范围内）

继承 `voice-input-plan.md` v1.x 全部 14 条不做事项，并新增：

15. **Agent 自主多轮长任务**（>5 步工具调用、跨会话） —— 留给 v3
16. **本地训练 / 微调** —— 用户层面只有"换权重"，不做端上微调
17. **本地 RAG 知识库** —— 不在 v2 范围；如果以后做，作为独立 `knowledge-plan.md`
18. **替换 xterm.js 输入栈** —— AI 输入辅助仅扩展现有 ghost-text 数据源 + Ctrl+K AI 改写小窗，不破坏原生终端
19. **打包 GPU 运行时到 installer** —— Vulkan 用系统 ICD（+3–5 MB 即可）、Metal 系统自带；CUDA pack 按需下载；CPU 永远兜底
20. **Plugin 市场 / 第三方 tool 插件** —— rig-core tool 列表硬编码在 Rust 侧，避免任意代码注入
21. **ASR 走云端** —— 任何情况下都不允许；Web Speech API（Chrome/Safari 会上传音频到云）也不接入
22. **ASR/LLM 互相 import** —— 编译期 lint 强制隔离；语音 dispatcher 是唯一汇合点
23. **嵌入第三方搜索 API key 到二进制** —— 任何情况都不允许；BYOK 走 OS keyring，默认走 SearXNG（无 key）
24. **后台静默下载模型** —— 任何 AI 模型 / sidecar 二进制都必须用户显式确认；进度条可见、可取消、可续传
25. **Chat 历史上传云端** —— 仅本地 SQLite；用户可手动导出 zip；不做"云同步对话"
26. **PyO3 / Python harness** —— 不引入 CPython 依赖；rig-core / swiftide / rmcp 已覆盖需求
27. **Bing Search API**（已于 2025-08 下线，不再适配）
28. **引入 reedline** —— NewMob 已有完整的 inline ghost-text + Common Commands Palette，v2.2 仅扩展数据源；避免双线并行
29. **CI 用真实 LLM API key** —— 一律用 MockProvider；真模型基线仅 nightly 跑且不 gate PR
30. **OOTB 内置 VPN / 代理** —— 违反应用商店政策；中国用户的 GitHub 访问问题靠 manifest 多源 + ModelScope 主源解决

---

## 十五、关键文件一览（v2 增量）

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
| `src-tauri/src/tab/mod.rs`（新） | PATH/files 扫描 + FIM in-process + Ctrl+K AI 改写 |
| `src-tauri/src/tab/fim_engine.rs`（新） | 桥接 `llm::llama_cpp_in_proc` |
| `src-tauri/src/agent/mod.rs`（新） | rig-core Agent 装配 + 薄 wrapper |
| `src-tauri/src/agent/tools/*.rs`（新） | 9 + 2 个工具的实现（含 web_search/web_fetch） |
| `src-tauri/src/agent/mcp_server.rs`（新） | rmcp server，把工具暴露为 MCP 端点 |
| `src-tauri/src/agent/search/*.rs`（新） | SearXNG / Tavily / Serper / Brave provider 实现 + 实例探测 |
| `src-tauri/src/chat/mod.rs`（新） | `chat_send` 流式 / 历史 / 删除 命令 |
| `src-tauri/src/chat/store.rs`（新） | SQLite 持久化 ai_chat_threads / messages |
| `src-tauri/src/chat/redact.rs`（新） | 敏感字段脱敏（共享给 v2.3 read_terminal_tail） |
| `src-tauri/src/chat/inline_intercept.rs`（新） | `??` 拦截后端逻辑 + alt-screen 检测 |
| `src-tauri/migrations/00X_ai_chat.sql`（新） | Chat 表迁移 |
| `src-tauri/binaries/`（新目录） | `llama-server-{target-triple}` sidecar（CPU-only ~10 MB） |
| `src/components/voice/CommandPreviewCard.tsx`（新） | 语音→Shell 的预览/确认卡（v2.4 Drawer 复用） |
| `src/components/terminal/AiRewriteOverlay.tsx`（新） | Ctrl+K AI 改写小输入框 + diff 显示 |
| `src/components/terminal/InlineChatRenderer.tsx`（新） | 终端 `??` 浮层 |
| `src/components/terminal/SelectionToolbar.tsx`（新） | 文本选区 toolbar |
| `src/components/agent/ActionCard.tsx`（新） | Agent 通用动作卡 |
| `src/components/agent/WebSearchConfirmCard.tsx`（新） | Web Search 确认卡（复用 ActionCard） |
| `src/components/chat/ChatDrawer.tsx`（新） | 主 Drawer 容器 |
| `src/components/chat/ChatThreadList.tsx`（新） | 历史列表 |
| `src/components/chat/MessageBubble.tsx`（新） | 单条消息 |
| `src/components/chat/Composer.tsx`（新） | 输入框 + `@` 引用补全 + 附件 |
| `src/components/chat/AttachmentChip.tsx`（新） | 附件展示 |
| `src/components/chat/SearchProgressChip.tsx`（新） | 流式搜索状态 |
| `src/components/settings/AsrPanel.tsx`（新） | ASR engine + 模型选择 |
| `src/components/settings/LlmProvidersPanel.tsx`（新） | 三字段 LLM Provider 配置 |
| `src/components/settings/LocalLlmInstaller.tsx`（新） | llama-server 状态 + 模型库管理 |
| `src/components/settings/PrivacyToggle.tsx`（新） | "全本地模式"一键开关 |
| `src/components/settings/WebSearchPanel.tsx`（新） | 提供方选择 + BYOK + 确认模式 |
| `src/components/settings/AiPanel.tsx`（修改） | 顶部"完全禁用 AI"开关 + Drawer 宽度 / `??` 触发 / 选区 toolbar 开关 |
| `src/components/window/StatusBar.tsx`（修改） | ASR / LLM / AI 写 / Search 四段状态 |
| `src/layouts/MainLayout.tsx`（修改） | 增加右侧 Drawer 槽位（CSS Grid） |
| `src/stores/aiStore.ts`（新） | 拆为 asrStore + llmStore，避免耦合 |
| `src/stores/chatStore.ts`（新） | threads + active thread + streaming 状态 |

---

## 十六、本地化测试方案

> 设计原则：**开箱即用** + **响应时效优先**（FIM、确认卡延迟敏感）+ **并行多任务**（语音 + FIM + chat 同时进行不互相拖累）。**CI 不用真 API key**——MockProvider 兜底；真模型基线仅在 nightly 跑，不 gate PR。

### 16.1 三层测试架构

```
┌─ Layer 1：单元测试（cargo test / vitest） ────────────────┐
│ 黑名单正则 100% 覆盖 / shell_safety 边界 / redact 函数      │
│ chat thread CRUD / tools schema 序列化 / config 解析       │
│ ASR/LLM 解耦 lint（cargo clippy 自定义 rule）               │
│ 跑得快（<10s），每 PR 必跑                                   │
└──────────────────────────────────────────────────────────┘
┌─ Layer 2：MockProvider e2e（核心新增） ───────────────────┐
│ 用 axum / wiremock 起 mock LLM 端点                        │
│ 用 wav 固件 + sherpa-onnx 真模型作 ASR e2e（小 80MB 模型）  │
│ 测：开箱即用、延迟预算、并行多任务                           │
│ 跑得不慢（<60s），CI 必跑                                   │
└──────────────────────────────────────────────────────────┘
┌─ Layer 3：真模型基线（每周/手动） ─────────────────────────┐
│ 自托管 GPU runner + 真 Qwen3-1.7B + 真 Tavily/SearXNG     │
│ 输出图表，>25% 退化报警；不 gate PR                         │
└──────────────────────────────────────────────────────────┘
```

### 16.2 MockProvider trait

```rust
// src-tauri/tests/support/mock_provider.rs
pub struct MockLlmProvider {
    pub ttft_ms: u64,           // 默认 800
    pub inter_token_ms: u64,    // 默认 50
    pub script: Vec<MockEvent>, // 脚本化吐 token / tool_call / 错误
}

pub enum MockEvent {
    Token(String),
    ToolCall { name: String, args: Value },
    NativeWebSearch { queries: Vec<String>, results: Vec<SearchHit> },
    Wait(Duration),
    Error(String),
}

#[async_trait]
impl Llm for MockLlmProvider {
    async fn chat_stream(&self, _: ChatReq) -> BoxStream<'_, ChatChunk> { ... }
}
```

CI 中所有 e2e 都用 `MockLlmProvider`——**真 API key 永不进 CI**。

### 16.3 关键延迟测试用例

| 用例 | 测量点 | 目标 P95 | 工具 |
|------|-------|---------|------|
| FIM ghost-text | 最后一次按键事件 → ghost-text DOM 渲染完成 | **<300 ms** | vitest + `performance.mark` |
| PATH 候选 | 按键 → ghost-text 渲染 | <50 ms | vitest |
| 历史前缀 | 按键 → ghost-text 渲染（已有功能基线）| <10 ms | vitest |
| 语音意图 | PTT release → ActionCard 挂载 | **<1500 ms** | playwright + 注入固件音频 |
| Chat first-token（云）| `chat_send` → 首 token 写入 Drawer | **<1000 ms** | playwright + MockProvider |
| Chat first-token（本地）| 同上 | <3000 ms | playwright + 真 llama-server + 小模型 |
| 工具确认卡 | tool_call 事件 → 卡片可见可交互 | <100 ms | vitest |
| Web search 确认 | LLM tool_call → 确认卡渲染 | <80 ms | vitest |
| Mirror probe | manifest 触发 → 选中 mirror 开始下载 | <2000 ms | mock 三个 axum 服务器 |
| Ctrl+K AI 改写 | 按 Enter → 改写结果出现 | <2000 ms | playwright + MockProvider |

### 16.4 并行任务测试（核心）

NewMob 最坏 case：用户按 PTT 录音，**同时** Tab 补全在算 FIM，**同时** Chat Drawer 在流式输出。三个推理任务争 CPU。

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_concurrent_three_workloads() {
    let app = test_app().await;

    let voice = tokio::spawn(async {
        // 模拟 PTT 5s 音频 → ASR → 意图分发
        let pcm = load_fixture_wav("voice/list_files.wav");
        app.dispatch_voice(pcm).await
    });

    let fim = tokio::spawn(async {
        // 模拟用户每 80 ms 敲一次键，连续 30 次
        for _ in 0..30 {
            app.fim_request("git che").await;
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    });

    let chat = tokio::spawn(async {
        // Drawer 中正在流式回答（mock 50ms/token）
        app.chat_stream("explain k8s").await
    });

    let (v, f, c) = tokio::join!(voice, fim, chat);

    // 断言：每个任务都在自己的预算内完成
    assert!(v.unwrap().elapsed_ms < 1500);
    assert_p95(f.unwrap().latencies, 300);  // FIM 不能被拖慢
    assert!(c.unwrap().ttft_ms < 1500);      // chat 略放宽
}
```

### 16.5 "开箱即用" 烟雾测试（cloud-only 安装态）

```rust
#[tokio::test]
async fn test_cloud_only_smoke() {
    let app = fresh_install().await;          // 模拟全新安装：零模型零配置

    // 1. 应用启动 < 2s
    assert!(app.startup_ms < 2000);

    // 2. 默认看到"下载语音 80MB"提示 + LLM Provider 选择列表
    let panel = app.open_settings_ai().await;
    assert!(panel.shows_asr_download_prompt());
    assert_eq!(panel.llm_providers.len(), 5);

    // 3. 选 GLM-4-Flash + 假 key + 测试连接（mock 200 OK）
    panel.select_provider("glm").set_key("test-key").test_connection().await
        .assert_ok();

    // 4. 模拟下载 80MB ASR 模型（mock CDN）+ 启动后能预热
    app.download_asr().await.assert_ok();
    assert!(app.asr_ready());

    // 5. 模拟一次完整 PTT → 意图（mock LLM 返回 list_sessions）→ 卡片可见
    let ms = app.simulate_ptt("voice/list_files.wav").await;
    assert!(ms < 1500);
}
```

### 16.6 Mock CDN 测试模型分发

```rust
#[tokio::test]
async fn test_three_source_probe() {
    // 起三个 mock server：modelscope (200 慢)、gh-proxy (200 快)、github (404)
    let ms_server  = mock_server_with_delay(Duration::from_millis(800));
    let ghp_server = mock_server_with_delay(Duration::from_millis(150));
    let gh_server  = mock_server_404();

    let manifest = ModelManifest {
        urls: vec![ms_server.url(), ghp_server.url(), gh_server.url()],
        ..
    };

    let chosen = downloader::probe_and_choose(&manifest).await.unwrap();
    assert_eq!(chosen, ghp_server.url());  // 最快返回 200 的赢
}

#[tokio::test]
async fn test_resume_from_partial_download() {
    // 中断下载在 50% → 重启应从 50% 续下，整文件 SHA-256 通过
}
```

### 16.7 GPU 检测测试

```rust
#[test] fn test_gpu_detect_macos_returns_metal() { ... }
#[test] fn test_gpu_detect_no_vulkan_falls_back_to_cpu() { ... }
#[test] fn test_gpu_detect_old_driver_falls_back_to_cpu() {
    // 模拟 NVIDIA driver 530（< 535 下限）→ 应回 CPU + 状态栏黄点
}
```

### 16.8 工具与依赖

| 用途 | 工具 |
|------|------|
| Rust 异步 micro-bench | `criterion` w/ `async_tokio` |
| Rust 虚拟时间断言 | `tokio_test::time::pause()` + `advance()` |
| Rust HTTP mock（云端 LLM）| `wiremock` 或自写 `axum` mock |
| 前端 bench | `vitest --bench` |
| 端到端 UI | playwright（已有 qa-ui-auto） |
| 多步 tool-call 验证 | `promptfoo` 配 MockProvider |
| 性能基线持久化 | `bencher.dev` 或 SQLite + GitHub Pages 图表 |
| 监控字段 | `tracing` span + `performance.mark` 双写 JSONL |

### 16.9 度量字段统一（借用 Anyscale / vLLM 标准）

```rust
pub struct LatencyMetric {
    pub feature: &'static str,           // "fim" | "voice_intent" | "chat" | "mirror_probe"
    pub provider: String,                // "openai" | "local" | "mock" | "modelscope"
    pub ttft_ms: Option<u64>,            // first token
    pub tpot_ms: Option<u64>,            // time per output token
    pub e2e_ms: u64,                     // end-to-end
    pub queue_ms: Option<u64>,           // 等待推理槽位时间
    pub trace_id: String,
}
```

### 16.10 CI 策略（D5 选项 A 落地）

| 阶段 | 跑哪些 | 阈值 | 失败处理 |
|------|--------|------|---------|
| **PR / push** | Layer 1 + Layer 2（MockProvider）| 单测全过 + 延迟 P95 ≤ 150% 基线 | 阻塞合并 |
| **nightly** | Layer 2 + Layer 3 子集（真 sherpa-onnx ASR + 真 Qwen3-0.6B FIM 小模型）| P95 ≤ 110% 7 日中位数 | 创建 issue，**不**阻塞 |
| **手动** | Layer 3 全套（真 chat + 真 web search） | 人工评审 | 报告归档 |

### 16.11 测试目录结构

```
src-tauri/tests/
  integration/
    cloud_only_smoke.rs            # 开箱即用核心
    concurrent_three_workloads.rs  # 并行多任务核心
    fim_latency.rs                 # FIM P95 < 300ms
    voice_intent_latency.rs        # PTT → ActionCard < 1.5s
    asr_llm_isolation.rs           # 编译期 lint：asr/llm 互不 use
    three_source_probe.rs          # 模型分发 mirror probe
    gpu_detect.rs                  # GPU 后端选择 + 降级
  benches/
    chat_stream.rs                 # criterion: chat 流式吞吐
    fim_pipeline.rs                # criterion: FIM 端到端
  fixtures/
    voice/*.wav                    # 各种语音命令固件
    sse/*.txt                      # 各家 Provider 流式响应固件

qa-ui-auto-tests/cases/
  ai-chat-drawer.testcase.yaml     # Drawer 多对话 + 选区 + ?? 内联
  ai-tab-complete.testcase.yaml    # ghost-text 三档数据源
  ai-web-search-native.testcase.yaml    # 原生路径（不弹卡）
  ai-web-search-client.testcase.yaml    # 客户端路径（弹卡）
```

---

## 十七、验证方式（v2 增量）

### v2.0
- 默认配置下首启动：仅看到"下载语音模型 80 MB"提示 + LLM Provider 选择列表（DeepSeek / GLM / 其他）。下载 ASR + 填 GLM-4-Flash key（免费）→ 立即可用语音 + AI，**总下载 80 MB**
- 切换 LLM 到 `local`（llama-server）：触发模型库下载 Qwen3-1.7B-2507（1.4 GB）→ 启动 sidecar → 语音意图改走本地，行为一致
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
- **断网时输入辅助仍工作**：在 PowerShell 之外的本地终端键入 `gi` → 现有 inline ghost-text（历史前缀）+ 数据源 2（PATH 命中 `git`、`gimp`）立即显示候选，无需 LLM
- 加载 Qwen3-0.6B FIM 模型，输入 `git che` 暂停 200 ms → 灰色 ghost-text 显示 `ckout main`，按 → 接受到第一个 token
- 输入 `mysql -ppassword=` 历史中存在含敏感字段的行 → 验证该行没被送入 FIM 上下文（log 中 prefix 字段做断言）
- 测延迟：从最后键入到 ghost-text 显示 P95 < 300 ms（本地 0.6B Q4_K_M，in-process）；对照 sidecar HTTP 路径 P95 应高出 30–80 ms

### v2.3
- 终端运行报错命令（如 `git push origin main` 提示需要 force），状态栏出现 "AI 解释" → 点击 → action card "Agent 想读终端最后 50 行" → 允许 → 流式输出解释 + 建议修复命令按钮 → 点按钮触发 v2.1 命令预览卡
- 跑多步编排（opt-in）："找出 prod-web 上 `/var/log/nginx/error.log` 最近 100 行里的 5xx 错误统计" → 工具调用链：`list_sessions(query="prod-web")` → `switch_tab` → `run_in_terminal(dry_run=true, command="...")` → 用户确认 → 执行 → `explain_error`
- `cargo test -p newmob_agent safety::write_tools_default_dry_run` —— 所有写工具默认 `dry_run=true`
- 触发"读终端"工具但 `user_invoked=false` → 中间件拒绝并记审计
- 启用 rmcp server，从外部 MCP client（Claude Desktop）连接 `127.0.0.1:<rand>` 并调用 `list_sessions` → 返回会话列表；token 错误 → 401

### v2.4
- 按 `Ctrl+L` 打开 Drawer，新建 thread，输入"列出当前 K8s 集群所有 pod" → AI 流式输出，对话进 SQLite
- 在终端选中一段错误，右键 "Send to AI" → Drawer 输入框出现 `@selection: ...`，发送后 AI 解释
- 终端中 `?? 这个错误怎么办` Enter → AI 灰色行内回答 + 命令预览卡 → 按 Enter 注入终端执行
- 进入 Vim（alt-screen），输入 `??...` → 不被拦截（直接写入 Vim 缓冲区）
- 多 thread 切换：thread1 用 DeepSeek、thread2 用本地 Qwen3-1.7B → 各自独立上下文 + 独立计费
- 关闭 Drawer 后再开 → 上次正在生成的消息仍可见（断流恢复 / 已完成内容持久化）
- 设置 → 完全禁用 AI → TitleBar 按钮消失 / `??` 不拦截 / `Ctrl+L` 无响应 / 状态栏 AI 段隐藏

### v2.5
- Drawer 中问"kubectl 1.32 release notes" → AI 弹 Web Search 确认卡（关键词 + 提供方 SearXNG@searx.be）→ 允许一次 → 流式 SearchProgressChip → 5 条结果 → AI 综合回答
- 选"本会话内允许" → 同 thread 后续搜索不再弹卡，新 thread 重置
- 关闭 Web Search → AI 不再看到该工具（提示用户"我无法访问网络，请打开 Web Search"）
- 用户填 Tavily key → keyring 存储 → 下次启动 NewMob 自动恢复（不写 SQLite）
- `web_fetch http://localhost:8080` → SSRF 守门拒绝（"仅允许公网 HTTPS"）
- `web_fetch https://example.com/big.bin` → Content-Type 不支持 → 拒绝
- 公共 SearXNG 实例不可达 → 自动切到下一实例 + 提示"建议自托管"
- 审计 `voice_audit` 表：搜索事件 outcome 为 `search_allowed | search_denied | search_cancelled`，**不记录 query 文本**

---

## 十八、参考资料

- 上游模型 / runtime
  - [Qwen3](https://github.com/QwenLM/Qwen3)（Apache-2.0，2025-04 + 2025-07 update）
  - [Qwen2.5-Coder](https://github.com/QwenLM/Qwen2.5-Coder)（Apache-2.0，旧默认）
  - [MiniCPM3-4B](https://huggingface.co/openbmb/MiniCPM3-4B)（中文重度 zh-pro 备选）
  - [IBM Granite 4.0 Micro](https://huggingface.co/ibm-granite/granite-4.0-micro)（Apache-2.0 + ISO 42001）
  - [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（部分权重 CC-NC，需在 manifest 标商用注意事项 — 注 a）
  - [llama.cpp](https://github.com/ggml-org/llama.cpp)（CPU-only release ~8–15 MB / 平台）
  - [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  - [Ollama](https://ollama.com/)（仅作"用户已装时"接入，不再默认捆绑）
- Rust 生态
  - [rig-core](https://github.com/0xPlaygrounds/rig)（v0.37 主选 agent harness，MIT）
  - [swiftide](https://github.com/bosun-ai/swiftide)（备选 harness）
  - [rmcp](https://github.com/modelcontextprotocol/rust-sdk)（官方 MCP Rust SDK，工具暴露）
  - ~~[reedline](https://github.com/nushell/reedline)~~（已不再使用 —— NewMob 现有 React 实现的 inline ghost-text 已覆盖该能力）
  - [sherpa-onnx](https://docs.rs/sherpa-onnx) v1.13+（官方 Rust API，Apache-2.0）
  - [whisper-rs](https://github.com/tazz4843/whisper-rs)（Unlicense，备用 ASR）
  - [llama-cpp-2](https://lib.rs/crates/llama-cpp-2)（in-process llama.cpp 绑定，FIM 用）
  - [llm_readability](https://crates.io/crates/llm_readability) + [fast_html2md](https://crates.io/crates/fast_html2md)（页面提取）
  - [keyring](https://crates.io/crates/keyring)（跨平台 secret 存储）
- 参考实现
  - [MumbleFlow](https://dev.to/auratech/i-built-a-local-voice-to-text-app-with-rust-tauri-20-whispercpp-and-llamacpp-heres-how-32h5)（Tauri 2 + whisper.cpp + llama.cpp，最贴近的工程参考）
  - [goose](https://block.xyz/inside/block-open-source-introduces-codename-goose)（Block 出品，Rust + MCP-native，参考代码库）
- Web Search Provider 参考
  - [SearXNG](https://github.com/searxng/searxng)（默认，AGPL-3.0，自托管 / 公共实例）
  - DeepSeek / SiliconFlow / GLM (Zhipu) / Groq / Cerebras / Mistral / Gemini —— 均提供 OpenAI 兼容端点
  - Tavily / Serper / Brave / Exa —— BYOK 升级路径

注 a：SenseVoice-Small 的部分权重为 CC-BY-NC-4.0（非商用），如需商用请改用 Paraformer-zh-small（Apache-2.0）或 Whisper-small（MIT）。模型 manifest 中按权重标注许可，下载前 UI 提示。

---

_本文档与 `voice-input-plan.md`、`roadmap.md` 互为引用，任何变更需同步检视另两份。_
