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

```
┌────────────────────────────────────────────────────────────────┐
│ Voice input ─────┐                  ┌───── Keyboard input      │
│                  ▼                  ▼                          │
│  Tauri frontend (React / TypeScript)                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Terminal UI · Voice waveform · Provider config panel ·    │  │
│  │ Command preview/confirm card · Ghost-text overlay ·       │  │
│  │ Agent action cards (dry-run / execute / cancel)           │  │
│  └──────────────────────┬───────────────────────────────────┘  │
├─────────────────────────┼──────────────────────────────────────┤
│  Rust core              ▼                                       │
│  ┌──────────────┐ ┌───────────────┐ ┌──────────────────────┐   │
│  │  reedline    │ │ voice::*      │ │  ai::*               │   │
│  │ Tab 硬补全 + │ │ (whisper-rs / │ │  - Provider trait    │   │
│  │ history +    │ │  sensevoice / │ │    (OpenAI compat)   │   │
│  │ fish hints   │ │  funasr +     │ │  - rig-core Agent    │   │
│  │              │ │  cloud STT)   │ │  - Tool registry     │   │
│  │ + LLM /infill│ │               │ │  - Timeout fallback  │   │
│  └──────┬───────┘ └───────┬───────┘ └──────────┬───────────┘   │
│         │                 │                    │                │
└─────────┼─────────────────┼────────────────────┼────────────────┘
          │ FIM 补全调用    │ 转写文本           │ chat / tool_calls
          ▼                 ▼                    ▼
   ┌──────────────────────────────────┐  ┌──────────────────────┐
   │  Local sidecar (externalBin)     │  │  Cloud API backends  │
   │  ┌────────────────────────────┐  │  │  (OpenAI compatible) │
   │  │ Ollama  127.0.0.1:11434    │  │  │  ┌────────────────┐  │
   │  │  - Qwen2.5-Coder 1.5B      │  │  │  │ DeepSeek       │  │
   │  │  - Qwen2.5-Coder 0.5B FIM  │  │  │  │ SiliconFlow    │  │
   │  └────────────────────────────┘  │  │  │ Groq           │  │
   │  ┌────────────────────────────┐  │  │  │ GLM-4-Flash    │  │
   │  │ whisper-cpp / sherpa-onnx  │  │  │  │ Claude/OpenAI  │  │
   │  └────────────────────────────┘  │  │  └────────────────┘  │
   └──────────────────────────────────┘  └──────────────────────┘
                ▲                                  ▲
                │  本地优先，8 s 超时 → 云端 fallback │
                └──────────────────────────────────┘
```

铁律：

- 终端回滚字节、文件内容、SSH 密钥材料、vault 数据 **永不进入** 任何 AI 上下文
- 一切"写动作"（执行命令、上传/删除文件、创建会话）必须 dry-run + 确认卡，且在审计日志留痕
- 云端 Provider 仅在用户显式开启 + 填好 vault Key 时才工作；状态栏全程黄点提示

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
                                                    │  v2.0  本地 LLM runtime + Provider 抽象
                                                    │  v2.1  语音 → Shell 命令 / 脚本生成
                                                    │  v2.2  Tab 补全（reedline + ghost-text）
                                                    │  v2.3  rig-core Agent + 工具执行
```

- v1.x 完成后，AI 模块（`src-tauri/src/ai/mod.rs`）已经存在，工具调用 schema、Vault key 类型、确认卡组件、审计日志表都就绪
- v2.x 在 v1.x 的基础设施上扩展，不重新发明：
  - **复用** `voice::*`（按 PTT 录音、本地 + 云 STT、模型库）
  - **复用** v1.2 的确认卡机制 + 审计日志表（schema 不变，新增 `outcome` 子类型）
  - **扩展** `ai::*`：Provider trait 增加 OpenAI-compatible 通用实现，工具集从 6 个只读工具扩到含写动作的工具集
  - **新增** `tab::*`（reedline 集成）、`agent::*`（rig-core）

---

## 一、模型与 Runtime 选型矩阵

### 1.1 本地 LLM（中英文 + Shell 场景）

| 模型 | 参数 | Q4_K_M 体积 | 用途 | 许可 |
|------|------|-------------|------|------|
| **Qwen2.5-Coder-1.5B-Instruct** ⭐ | 1.5B | ~1.0 GB | 主力：语音→命令、解释报错 | Apache-2.0 |
| **Qwen2.5-Coder-0.5B-Base** ⭐ | 0.5B | ~400 MB | Tab 补全（FIM 填充） | Apache-2.0 |
| Qwen2.5-Coder-3B-Instruct | 3B | ~2.0 GB | "标准"档，复杂脚本生成 | Apache-2.0 |
| Qwen3-1.7B / 4B | 1.7B / 4B | ~1.1 / 2.4 GB | 通用对话备选（含 thinking 模式） | Apache-2.0 |
| Gemma 3-1B / 4B | 1B / 4B | ~0.8 / 2.5 GB | 多语备选 | Gemma 条款 |

**默认选择**：Qwen2.5-Coder 1.5B（chat）+ 0.5B（FIM）。中文 shell 上下文（中文报错、中文目录名、中文注释）Qwen 系明显优于 Llama 3.2 / Phi。

### 1.2 本地 ASR（中英双语）

`voice-input-plan.md` 已确定：**v1 用 whisper-rs + AudioWorklet PCM 采集**（不引入 cpal，采集留在 webview）。本文档新增的"中文优势档"：

| 模型 | 体积 | 中文 | 英文 | runtime | 备注 |
|------|------|------|------|---------|------|
| ggml-tiny multi（默认捆绑） | ~75 MB | 一般 | 一般 | whisper-rs | v1 默认 |
| Whisper base / small | 150 / 466 MB | 良 / 优 | 良 / 优 | whisper-rs | 按需下载 |
| **SenseVoice-Small** ⭐（zh-pro 档） | ~234 MB | 极佳 | 良好 | sherpa-onnx (`ort`) | 比 Whisper-large 快 ~15×，自动语种识别 |
| Paraformer-zh-small | ~220 MB | 极佳 | 弱 | sherpa-onnx (`ort`) | 纯中文场景 |

### 1.3 本地 LLM Runtime

排序（推荐 → 备选）：

1. **Ollama sidecar（v2 主选）** ⭐
   - 通过 Tauri `bundle.externalBin` 打包 `ollama` 二进制
   - 监听 `127.0.0.1:11434`，OpenAI 兼容 + `/api/generate` 的 `suffix` 字段做 FIM
   - 自带模型管理（`ollama pull qwen2.5-coder:1.5b`），用户可在设置里看进度
   - 缺点：单平台二进制 ~150 MB，但是 sidecar 路径，不进主程序包

2. **llama.cpp `llama-server` sidecar（备选）**
   - 二进制 ~5–10 MB，控制更细，`/infill` 端点专门给 FIM 用
   - 模型管理需自己实现（HF / ModelScope 双源 + SHA-256）

3. **mistral.rs / candle（纯 Rust，远期）**
   - 完全 in-process，无 sidecar，但首启动加载更重

**v2.0 锁定 Ollama**；llama.cpp 留作"高级用户"可选后端（同一 Provider trait，只换 `base_url`）。

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
| **Ollama**（local） | `qwen2.5-coder:1.5b` | 本地零成本 | 优 | 默认本地档 |

**默认预置**（用户开箱可见，无需自己抄 base_url）：`Ollama (local)` + `DeepSeek` + `GLM-4-Flash` + `SiliconFlow` + `Groq`，外加"自定义 OpenAI 兼容端点"。

### 1.5 Provider 配置 UX（极简三字段）

```jsonc
// ~/.config/newmob/ai.json
{
  "active": "local",
  "providers": {
    "local":       { "base_url": "http://127.0.0.1:11434/v1", "api_key": "ollama", "model": "qwen2.5-coder:1.5b" },
    "deepseek":    { "base_url": "https://api.deepseek.com/v1", "api_key": "<vault:ai_api_key:deepseek>", "model": "deepseek-chat" },
    "glm":         { "base_url": "https://open.bigmodel.cn/api/paas/v4", "api_key": "<vault:ai_api_key:glm>", "model": "glm-4-flash" },
    "siliconflow": { "base_url": "https://api.siliconflow.cn/v1", "api_key": "<vault:ai_api_key:siliconflow>", "model": "Qwen/Qwen2.5-Coder-7B-Instruct" },
    "groq":        { "base_url": "https://api.groq.com/openai/v1", "api_key": "<vault:ai_api_key:groq>", "model": "llama-3.3-70b-versatile" }
  },
  "fallback": { "enabled": true, "primary": "local", "secondary": "deepseek", "timeout_ms": 8000 },
  "task_routing": {
    "voice_intent":    "local",        // v1.1 已有
    "voice_to_shell":  "local",        // v2.1
    "tab_completion":  "local",        // v2.2，固定走 0.5B FIM
    "agent_default":   "local"         // v2.3
  }
}
```

UI 上每个 Provider 暴露恰好三个控件：**provider 下拉 / api_key 输入 / model_name 输入**。其余字段在 preset 里写死，避免用户在 base_url 上踩坑。

API Key 通过 vault `kind=ai_api_key:<provider>` 存储，复用 v1.1 已建立的机制。

### 1.6 超时回退（本地 8 s → 云端）

```rust
// src-tauri/src/ai/router.rs（v2.0 新增）
pub async fn complete(req: ChatRequest, cfg: &AiConfig, task: TaskKind) -> Result<ChatResponse> {
    let primary = cfg.task_routing.get(task).unwrap_or(&cfg.active);
    let provider = &cfg.providers[primary];

    if cfg.fallback.enabled && primary == &cfg.fallback.primary {
        match timeout(Duration::from_millis(cfg.fallback.timeout_ms),
                      providers::call(provider, &req)).await {
            Ok(Ok(out)) => return Ok(out),
            Ok(Err(e))  => tracing::warn!(?e, "primary failed, falling back"),
            Err(_)      => tracing::warn!("primary timeout, falling back"),
        }
        let secondary = &cfg.providers[&cfg.fallback.secondary];
        return providers::call(secondary, &req).await;
    }
    providers::call(provider, &req).await
}
```

前端无感，体感是"本地能秒回就秒回，本地卡了云端立刻顶上"。Tab 补全任务 **不参与** 超时回退（补全延迟敏感，云端往返 >150 ms 就不如不出）。

---

## 二、模型档位（按需下载）

| 档位 | LLM | ASR | 总下载量 | 适用 |
|------|-----|-----|---------|------|
| **cloud-only**（最轻） | — | ggml-tiny multi（已捆绑） | 0 增量 | 只用云 API |
| **mini** ⭐ 默认 | Qwen2.5-Coder 1.5B + 0.5B FIM | + Whisper-base | ~1.6 GB | 主流笔电 CPU |
| **standard** | Qwen2.5-Coder 3B + 0.5B FIM | + Whisper-small | ~2.9 GB | M 系 / 独显 |
| **zh-pro** | Qwen2.5-Coder 3B + 0.5B FIM | + SenseVoice-Small | ~2.6 GB | 中文为主 |

档位切换在 设置 → AI → 模型库 中提供"一键预设"，背后逐项调用模型库的下载/卸载。

---

## 三、依赖增量（在 `voice-input-plan.md` 之上）

### 3.1 `src-tauri/Cargo.toml`

```toml
# v1.x 已规划 (来自 voice-input-plan.md)
whisper-rs  = "0.12"
ort         = { version = "2", features = ["load-dynamic"] }
reqwest     = { version = "0.12", features = ["rustls-tls", "json", "stream"] }
hound       = "3.5"
byteorder   = "1.5"
rubato      = "0.15"

# —— v2.0 新增 ——
async-trait = "0.1"
thiserror   = "1"          # AI 错误分层
tracing     = "0.1"        # 结构化日志（已在主项目则复用）

# —— v2.2 Tab 补全 ——
reedline    = "0.38"

# —— v2.3 Agent harness ——
rig-core    = { version = "0.9", features = ["derive"] }

# —— 工具辅助 ——
dirs        = "5"          # 跨平台 cache 路径
which       = "6"          # 遍历 $PATH 可执行文件
heck        = "0.5"        # 字符串命名风格转换
sha2        = "0.10"       # 模型完整性校验

[profile.release]
opt-level     = 3
lto           = "thin"
codegen-units = 1
strip         = true
```

### 3.2 `src-tauri/tauri.conf.json`

```jsonc
{
  "tauri": {
    "bundle": {
      "externalBin": [
        "binaries/ollama",
        "binaries/whisper-cpp"
      ],
      "resources": [
        "models/ggml-tiny-multi.bin"
      ]
    },
    "allowlist": {
      "process": { "execute": true, "relaunch": true },
      "http":    { "request": true, "scope": [
        "https://api.deepseek.com/*",
        "https://api.siliconflow.cn/*",
        "https://api.groq.com/openai/*",
        "https://open.bigmodel.cn/*",
        "https://api.openai.com/*",
        "https://api.anthropic.com/*",
        "https://api.mistral.ai/*",
        "https://generativelanguage.googleapis.com/*",
        "https://huggingface.co/*",
        "https://modelscope.cn/*",
        "https://ollama.com/*"
      ]}
    }
  }
}
```

sidecar 二进制按 `{name}-{target-triple}` 命名后放入 `src-tauri/binaries/`，Tauri 打包时自动包含并签名。

---

## 四、Voice v2.0 —— 本地 LLM runtime + 统一 Provider 抽象

**目标**：把 `voice-input-plan.md` v1.1 的 `AiBackend`（Ollama/Claude/OpenAI 三个独立实现）重构为 OpenAI-compatible 统一 Provider，预置 5 家国内外免费/性价比厂商，支持任务级路由 + 超时回退。**这是 v2.x 一切其他工作的基础**。

### 4.1 用户流程
1. 首次启动 → 设置 → AI 看到默认配置：active = `local (ollama)`，但显示"Ollama 未运行 / 模型未下载"
2. 点击"一键安装本地 AI"：下载 Ollama sidecar 模型 → 启动 → `ollama pull qwen2.5-coder:1.5b`（带进度条）
3. 或者跳过本地，直接配置任一云端 Provider（粘贴 API Key）
4. v1.x 已有的语音意图自动切到新 Provider，零额外配置

### 4.2 新增 / 重构文件
- `src-tauri/src/ai/provider.rs` —— `trait Provider { async fn chat(req) -> Resp; async fn completion_fim(prefix, suffix) -> String; }`
- `src-tauri/src/ai/openai_compat.rs` —— 通用 OpenAI 兼容实现，覆盖 90% 的 Provider
- `src-tauri/src/ai/anthropic.rs` —— Claude 单独实现（Messages API 略不同）
- `src-tauri/src/ai/ollama_sidecar.rs` —— sidecar 启动 / 健康检查 / 模型 pull
- `src-tauri/src/ai/router.rs` —— 任务级路由 + 超时回退（见 §1.6 代码）
- `src/components/settings/AiProvidersPanel.tsx` —— 三字段配置 UI + 默认 5 家 preset + "测试连接"
- `src/components/settings/LocalAiInstaller.tsx` —— Ollama sidecar 状态卡（未安装/安装中/运行中/异常）

### 4.3 修改既有文件
- `src-tauri/src/ai/mod.rs`（v1.1 已建）→ 把原来的 `AiBackend` enum 替换为 `Box<dyn Provider>` + `Router`
- `src-tauri/src/voice/intent_dispatcher.rs` → 通过 `router.complete(req, TaskKind::VoiceIntent)` 调用，不再直连具体 backend
- `src-tauri/src/vault/mod.rs` → `kind=ai_api_key:*` 增加 `deepseek | glm | siliconflow | groq | cerebras | gemini | mistral | openrouter` 子类型
- `src/stores/aiStore.ts`（新）→ providers 配置 + 路由 + 测试结果

### 4.4 风险 + 缓解
- *Ollama sidecar 体积大（~150 MB）* → 不打进默认包；首次开启 AI 时按需下载（与模型一并走"一键安装"）
- *国内访问 Ollama 模型仓库慢* → 镜像源（ModelScope）+ 用户自填 base_url
- *Provider preset 价格 / 端点变化* → preset 与 manifest 同源（`ai-providers.manifest.json`），可远程更新
- *某 Provider 返回 OpenAI 不兼容字段（如 `tool_choice`）* → 在 `openai_compat.rs` 里按 host 做小补丁

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
[第二层] Ollama /api/generate (Qwen2.5-Coder-0.5B FIM)
   - prefix = 当前命令行 + 最近 5 条 history
   - suffix = 空（行尾）
   - max_tokens = 24, stop = ["\n"]
   →  灰色 ghost-text 铺在光标后
   →  → 接受单词，Tab 接受全部，Esc 拒绝
```

### 6.2 集成位置

**关键决策**：v2.2 **不替换 xterm.js**。reedline 集成位置是新增的"AI 命令编辑器"覆盖层（`Ctrl+K` 唤起，类似 VS Code Quick Open），编辑完成后回写到 xterm 当前 prompt 行。这是因为：

- 完全替换 xterm 输入栈风险太大（破坏 TTY 语义、Vim/SSH 内程序行为、shell 自身补全）
- 覆盖层方案保留终端原生体验，AI 增强是附加而非替换
- 后续 v2.4+ 如果稳定，再讨论"原生终端行内 ghost-text"（这要解决 ANSI 注入 + cursor 同步两个硬问题）

### 6.3 新增文件
- `src-tauri/src/tab/mod.rs` —— Tauri 命令 `tab_suggest_local`（reedline 硬补全）+ `tab_suggest_llm`（FIM）
- `src-tauri/src/tab/reedline_engine.rs` —— 实现 `Completer` trait
- `src-tauri/src/tab/path_scanner.rs` —— `which` 扫 PATH，启动时 + 10 s TTL
- `src/components/terminal/CommandEditorOverlay.tsx` —— `Ctrl+K` 唤起的覆盖层；接管按键、显示候选 + ghost-text
- `src/lib/tab/fimClient.ts` —— 调用 `tab_suggest_llm`，带 120 ms debounce + AbortController

### 6.4 修改既有文件
- `src/components/terminal/TerminalView.tsx` → 监听 `Ctrl+K` 唤起覆盖层；覆盖层 commit 时把命令文本注入到 xterm 输入
- `src/components/settings/AiProvidersPanel.tsx` → "Tab 补全"区块：硬补全开关、LLM ghost-text 开关、模型选择（默认 Qwen2.5-Coder-0.5B-Base）
- `src-tauri/src/lib.rs` → 注册 `tab_*` 命令

### 6.5 性能预算
- 第一层（reedline）：同步触发，候选生成 <1 ms（PATH 缓存命中）
- 第二层（FIM LLM）：120 ms debounce + 50–150 ms 推理；总延迟 <300 ms
- ghost-text 在等待时 **不显示骨架**，结果到达再淡入；避免抖动
- 新键入立即 abort 旧 FIM 请求（reqwest CancellationToken）

### 6.6 风险 + 缓解
- *本地 0.5B 偶尔吐空字符串* → 空结果不显示，不打扰用户
- *PATH 扫描在 WSL / Windows 路径分隔符上踩坑* → `which` crate 已处理；额外测试 fixture 覆盖
- *用户 shell 自带补全（fish、zsh 的 zsh-autosuggestions）冲突* → 覆盖层方案不涉及 shell 内置补全，无冲突
- *FIM 模型把"敏感"字符串补出来* → 输入历史按行做过滤，不把含 `password=` `token=` `Bearer ` 的行送给 FIM

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
- `src-tauri/src/ai/router.rs` → 增加 Agent 任务路径：`router.run_agent(req, TaskKind::AgentDefault)`
- `src-tauri/src/voice/intent_dispatcher.rs` → 把 v1.1 的工具调用迁移到 rig-core Agent（保持向下兼容，工具 schema 不变）
- `src/stores/voiceStore.ts` → `lastIntent` 类型扩展为 `ActionCard[]`（多步编排时的多张卡）

### 7.5 风险 + 缓解
- *Agent 多步规划失控（无限调用工具）* → 单次会话最多 5 步工具调用；超出强制结束 + 错误提示
- *Agent 读终端输出泄漏密码* → `read_terminal_tail` 默认对结果做 `password|token|secret|key=` 行级 redaction
- *本地 1.5B 模型 tool calling 不稳* → Agent 路径默认路由到云端（`agent_default = "deepseek"` 推荐）；本地档位仅推单工具模式
- *rig-core API 还在演进* → 锁版本 `0.9`；agent.rs 内做一层薄 wrapper，便于将来切换到其他 harness（smolagents、PydanticAI sidecar）

---

## 八、落地路线（4–6 周）

| 周 | 阶段 | 交付 |
|----|------|------|
| W1 | **v2.0a** | Cargo + Tauri sidecar + Ollama 安装器 + Provider trait + OpenAI-compat 通用实现 |
| W1–W2 | **v2.0b** | DeepSeek / GLM / SiliconFlow / Groq preset + 三字段 UI + 超时回退 + Vault key 类型扩展 |
| W2 | **v2.0c** | v1.1 现有 `AiBackend` 重构到 Provider trait（行为不变，回归测试） |
| W3 | **v2.1a** | `generate_shell_command` 工具 + 命令预览卡 + 黑名单评估器（100% 单测） |
| W3 | **v2.1b** | 风险等级闸门 + high 风险二次确认 + 会话级"禁用 AI 写动作"标记 + 审计日志扩展 |
| W4 | **v2.2a** | reedline 硬补全 + Ctrl+K 覆盖层（无 LLM 也能用） |
| W4 | **v2.2b** | Qwen2.5-Coder-0.5B FIM ghost-text + 120 ms debounce + 输入历史脱敏 |
| W5 | **v2.3a** | rig-core 装配 + 9 个工具实现 + safety 中间件 + 单步模式（替换 v1.1 实现） |
| W5–W6 | **v2.3b** | 多步编排（opt-in）+ "解释报错" / "改成脚本" 快速动作 + ActionCard 通用化 |
| W6 | **打磨** | zh-pro 档位（SenseVoice）+ 端到端 e2e（qa-ui-auto）+ 文档 |

时间表前置假设：v1.0 / v1.1 / v1.2 已完成（按 `voice-input-plan.md` 推进）。如 v1.x 仍在进行，v2.0a/b 可与 v1.1 并行（Provider 抽象本身在 v1.1 就用得上）。

---

## 九、与 `roadmap.md` 的对齐

| App 版本 | Voice 阶段 | AI 原生阶段 |
|---------|-----------|-------------|
| v0.3.x  | v1.0 / v1.1 | v2.0 Provider 抽象（提前到 v0.3.x，v1.1 直接用） |
| v0.4.x  | v1.2 | v2.1 语音→Shell + v2.2 Tab 补全 |
| v0.5.x  | —    | v2.3 Agent harness + 多步编排 |
| v1.0    | 收口审计 | 默认档位锁定（mini）+ Runbook 联动 |

---

## 十、不做事项（v2.x 范围内）

继承 `voice-input-plan.md` v1.x 全部 14 条不做事项，并新增：

15. **Agent 自主多轮长任务**（>5 步工具调用、跨会话） —— 留给 v3
16. **本地训练 / 微调** —— 用户层面只有"换权重"，不做端上微调
17. **本地 RAG 知识库** —— 不在 v2 范围；如果以后做，作为独立 `knowledge-plan.md`
18. **替换 xterm.js 输入栈** —— Tab 补全只在覆盖层，不破坏原生终端
19. **GPU 加速默认开启** —— v2 默认 CPU 推理；CUDA / Metal / Vulkan 需用户在设置里手动开
20. **Plugin 市场 / 第三方 tool 插件** —— rig-core tool 列表硬编码在 Rust 侧，避免任意代码注入

---

## 十一、关键文件一览（v2 增量）

| 文件 | 关联点 |
|------|--------|
| `src-tauri/src/ai/provider.rs`（新） | Provider trait + 任务路由 + 超时回退 |
| `src-tauri/src/ai/openai_compat.rs`（新） | 覆盖 90% Provider 的统一实现 |
| `src-tauri/src/ai/ollama_sidecar.rs`（新） | sidecar 启动 + 模型 pull |
| `src-tauri/src/ai/tools_shell.rs`（新） | `generate_shell_command` schema |
| `src-tauri/src/ai/shell_safety.rs`（新） | 黑名单 + 风险等级评估 |
| `src-tauri/src/tab/mod.rs`（新） | reedline 硬补全 + FIM 端点 |
| `src-tauri/src/agent/mod.rs`（新） | rig-core Agent 装配 |
| `src-tauri/src/agent/tools/*.rs`（新） | 9 个工具的实现 |
| `src-tauri/binaries/`（新目录） | `ollama-{target-triple}` 等 sidecar |
| `src/components/voice/CommandPreviewCard.tsx`（新） | 语音→Shell 的预览/确认卡 |
| `src/components/terminal/CommandEditorOverlay.tsx`（新） | Ctrl+K 覆盖层 |
| `src/components/agent/ActionCard.tsx`（新） | Agent 通用动作卡 |
| `src/components/settings/AiProvidersPanel.tsx`（新） | 三字段 Provider 配置 |
| `src/components/settings/LocalAiInstaller.tsx`（新） | Ollama 一键安装 |
| `src/stores/aiStore.ts`（新） | Provider 配置 + 路由 + 测试结果 |

---

## 十二、验证方式（v2 增量）

### v2.0
- 默认配置下断网启动，Ollama 未安装 → AI 面板显示"未安装"，点击"一键安装"完成 sidecar + 模型下载，语音意图（v1.1 流程）从此走 local
- 配置 DeepSeek + 粘贴 key + 点"测试连接" → 200 OK
- 把 active 切到 DeepSeek 后断 Ollama → 语音意图仍工作；再断网 → 给出可执行错误
- 把 fallback 设为 local→deepseek，本地推理延迟 >8 s（用 stress 模拟）→ 自动走云端
- 跑 `cargo test -p newmob_ai provider_compat` —— 同一 prompt 对 5 家 Provider 输出 schema 一致

### v2.1
- 开启实验性开关，按住 PTT 说"列出当前目录所有大于 100 MB 的文件" → 命令预览卡显示 `find . -size +100M`，风险 low，1.5 s 后自动执行（注入到当前终端）
- 说"删除所有日志文件" → 风险 medium，必须按 Enter
- 说"把根目录全部删了" → AI 应主动评 high；即便没评，黑名单 `rm\s+-rf\s+/` 命中阻止执行，审计 `outcome=blocked_blacklist`
- 在某会话设"禁用 AI 写动作"，再触发命令生成 → 卡片可见但 Enter 仅复制到剪贴板，不注入终端
- `cargo test -p newmob_ai shell_safety::blacklist` —— 100% 覆盖黑名单全部正则

### v2.2
- 断网，按 Ctrl+K 唤起覆盖层，输入 `gi` → 立刻显示 `git`、`gimp` 等候选（reedline 硬补全可用）
- 接通 Ollama 模型，输入 `git che` 暂停 200 ms → 灰色 ghost-text 显示 `ckout main`，按 → 接受到第一个 token
- 输入 `mysql -ppassword=` 历史中存在含敏感字段的行 → 验证该行没被送入 FIM 上下文（log 中 prefix 字段做断言）
- 测延迟：从最后键入到 ghost-text 显示 P95 < 300 ms（本地 0.5B Q4_K_M）

### v2.3
- 终端运行报错命令（如 `git push origin main` 提示需要 force），状态栏出现 "AI 解释" → 点击 → action card "Agent 想读终端最后 50 行" → 允许 → 流式输出解释 + 建议修复命令按钮 → 点按钮触发 v2.1 命令预览卡
- 跑多步编排（opt-in）："找出 prod-web 上 `/var/log/nginx/error.log` 最近 100 行里的 5xx 错误统计" → 工具调用链：`list_sessions(query="prod-web")` → `switch_tab` → `run_in_terminal(dry_run=true, command="...")` → 用户确认 → 执行 → `explain_error`
- `cargo test -p newmob_agent safety::write_tools_default_dry_run` —— 所有写工具默认 `dry_run=true`
- 触发"读终端"工具但 `user_invoked=false` → 中间件拒绝并记审计

---

## 十三、参考资料

- 上游模型 / runtime
  - [Qwen2.5-Coder](https://github.com/QwenLM/Qwen2.5-Coder)（Apache-2.0）
  - [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)（Apache-2.0）
  - [Ollama](https://ollama.com/) / [llama.cpp](https://github.com/ggml-org/llama.cpp)
  - [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- Rust 生态
  - [reedline](https://github.com/nushell/reedline)（Nushell 的核心编辑器，Fish 风格 ghost-text）
  - [rig](https://github.com/0xPlaygrounds/rig) / [swiftide](https://github.com/bosun-ai/swiftide)
  - [whisper-rs](https://github.com/tazz4843/whisper-rs) / [ort](https://github.com/pykeio/ort)
- Provider 参考
  - DeepSeek / SiliconFlow / GLM (Zhipu) / Groq / Cerebras / Mistral / Gemini —— 均提供 OpenAI 兼容端点

---

_本文档与 `voice-input-plan.md`、`roadmap.md` 互为引用，任何变更需同步检视另两份。_
