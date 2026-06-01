# Taomni 语音输入 —— 分阶段实施计划

## 背景

用户希望在 Taomni 中讨论 AI 原生功能，并以语音输入作为第一个具体落地的特性：按住快捷键说一句话，App 完成相应操作（连接已保存会话、切换标签、文件浏览器导航、搜索历史、打开会话编辑器等）。

本计划针对该范围给出一份可执行的三阶段方案。已与用户确认的关键决策：

- **触发方式：** 仅按住即说（push-to-talk, PTT），v1 不做唤醒词、不做常驻 VAD、不做常开麦克风。
- **本地 STT：** 英文用 Whisper（`whisper-rs` 集成），中文用 FunASR / SenseVoice（ONNX 推理），由用户在设置中选择当前活跃模型，或由检测语言自动切换。
- **默认捆绑：** 安装包内置 ggml-tiny 多语言（约 75 MB），首启即可用；其余 Whisper 多语言/英文专用、FunASR/SenseVoice 中文模型按需下载或本地导入。
- **云端 STT 提供商：** OpenAI Whisper API、Deepgram、Azure Speech / 阿里云 / 腾讯云 / 火山引擎（国内中文优势厂商），以及 Google Cloud STT。可在设置里逐项开关并填入 vault 中的 API Key。
- **模型来源：** 默认走项目托管的 manifest（指向 Hugging Face / 各厂商官方原始 URL，附 SHA-256 校验），同时允许用户自填 URL 或导入本地 `.bin / .onnx` 文件 —— 兼顾普通用户和企业内网/离线环境。
- **意图解析：** 走 LLM 工具调用（Claude / Ollama / OpenAI），转写文本由前端送到 `src-tauri/src/ai/mod.rs` 派发给当前选定的后端；离线或 AI 不可用时退回正则语法解析器。
- **v1 动作范围：** 只读 + 连接类动作 —— `connect_session`、`switch_tab`、`navigate_file_browser`、`search_history`、`open_session_editor`。**不在 v1 直接执行 shell 命令**，留给后续带强确认/Runbook 守门的 voice-v2。

本计划替换之前两大主题的概览路线图（已迁移到工作树中的 `D:/code/person/taomni/roadmap.md`）。

---

## 跨阶段共同约定

### 默认 PTT 快捷键
- **Windows / Linux：** `Ctrl+Shift+Space`（按住）
- **macOS：** `Cmd+Shift+Space`（按住）

理由：空格键握感舒适；Shift 修饰用于规避 macOS Spotlight (`Cmd+Space`)、Linux/Windows 输入法切换 (`Ctrl+Space`)，以及 `MainLayout.tsx:271` 中已被 `Ctrl+Shift+M` 占用的紧凑模式。从 v1.0 起允许设置中重绑，存储为 `KeyboardEvent.code` 序列以兼容非拉丁键盘。麦克风按钮始终是无快捷键时的备选。

### 默认捆绑模型与按需下载
- **随包内置：** `ggml-tiny.bin`（多语言量化版，约 75 MB）。开箱即可同时识别中英文短指令。
- **按需下载（点选/复制即可获得）：**
  - Whisper 多语言：`base`（约 142 MB）、`small`（约 466 MB）、`medium`（约 1.5 GB）
  - Whisper 英文专用：`tiny.en`、`base.en`、`small.en`（更小、英文 WER 更低）
  - 中文优化：`SenseVoice-small`（ONNX，约 234 MB，中文 + 情感/事件标签，速度极快）、`Paraformer-zh-small`（FunASR ONNX，约 220 MB，中文 ASR 精度高）
- **加载策略：** 单一活跃模型；首次 PTT 触发时懒加载，60 s 空闲后释放（约 200~500 MB RSS 视模型而定）。设置里允许用户绑定"中文/英文/自动"到不同模型，自动模式由 Whisper 探测前两秒语言后路由。

### 云端 STT 提供商支持矩阵

| 提供商 | 适配语言 | 触发条件 | 特点 |
|--------|----------|----------|------|
| OpenAI Whisper API (`whisper-1` / `gpt-4o-transcribe`) | 中英文皆可 | 用户在 vault 中存有 `kind=stt_api_key:openai` 条目并启用 | 通用度高，按分钟计费 |
| Deepgram | 主打英文流式 | `kind=stt_api_key:deepgram` | 低延迟流式，企业常用 |
| Azure Speech | 中英文皆可 | `kind=stt_api_key:azure` + region | 中文识别效果好 |
| 阿里云语音 | 中文为主 | `kind=stt_api_key:aliyun` | 国内可用区延迟低 |
| 腾讯云语音 | 中文为主 | `kind=stt_api_key:tencent` | 国内合规场景 |
| 火山引擎语音 | 中文为主 | `kind=stt_api_key:volc` | 国内合规场景 |
| Google Cloud STT | 中英文皆可 | `kind=stt_api_key:google_stt`（service account JSON） | 配置较复杂 |

每个提供商在设置中都是独立开关；不会因为开了其中一个就把所有通信都路由到它。状态栏在任一云端 STT 启用时常显黄点提示。

### 模型仓库设计（manifest + 用户自填两路并存）

仓库文件 `voice-models.manifest.json` 由项目维护并随发布版本更新，结构示例：

```jsonc
{
  "schema": 1,
  "models": [
    {
      "id": "whisper-base-multi-q5_1",
      "engine": "whisper",
      "language": "multi",
      "size_bytes": 148914272,
      "sha256": "…",
      "urls": [
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin"
      ]
    },
    {
      "id": "sensevoice-small-onnx",
      "engine": "sensevoice",
      "language": "zh",
      "size_bytes": 245678910,
      "sha256": "…",
      "urls": [
        "https://huggingface.co/FunAudioLLM/SenseVoiceSmall/resolve/main/model.onnx"
      ]
    },
    {
      "id": "paraformer-zh-small-onnx",
      "engine": "funasr",
      "language": "zh",
      "size_bytes": 218765432,
      "sha256": "…",
      "urls": [
        "https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14/resolve/main/model.onnx"
      ]
    }
  ]
}
```

- 默认 App 启动后从 GitHub Releases 上的固定 URL 拉取这份 manifest（带 ETag 缓存）。
- "高级"模式可填写自定义 `urls`、自定义 `sha256`，或直接 **从本地 `.bin / .onnx` 导入**（拷到 `app_data/voice/models/<id>/`，写一条带 `source=local` 的元数据）。
- 下载经过 SHA-256 校验 + 原子重命名。中途失败可断点续传。
- manifest 仓库地址本身在设置里可改（企业内网可指向自己的镜像）。

### 数据流：本地 vs 离开设备

```
                    ┌─────────────────────────────┐
                    │       用户的麦克风          │
                    │      （PTT 键被按住）      │
                    └──────────────┬──────────────┘
                                   │ 16 kHz 单声道 PCM
                                   ▼
        ┌────────────────────────────────────────────────┐
        │  前端：AudioWorklet（webview 内）              │
        │  音频不落盘，仅在内存里                        │
        └──────────────┬─────────────────────────────────┘
                       │ 原始音频帧（base64）
                       ▼
        ┌────────────────────────────────────────────────┐
        │  Rust 后端 src-tauri/src/voice                  │
        │                                                │
        │  v1.0：Web Speech API（浏览器）                │
        │        语音通过 webview 的 STT 提供商离开设备  │
        │        （Chrome → Google STT），仅作为预览版本│
        │        且需用户在弹窗里明确同意                │
        │                                                │
        │  v1.1 本地：whisper-rs / sensevoice-rs / FunASR│
        │        ONNX —— 字节不出进程，转写文本仅在内存  │
        │                                                │
        │  v1.1 云端：用户在设置中显式开启某厂商后才会  │
        │        把音频送出；状态栏全程显示黄点          │
        └──────────────┬─────────────────────────────────┘
                       │ 转写文本（UTF-8）
                       ▼
        ┌────────────────────────────────────────────────┐
        │  意图解析                                       │
        │                                                │
        │  v1.0：正则语法（本地，无网络）                │
        │                                                │
        │  v1.1：LLM 工具调用                             │
        │    本地：Ollama                                 │
        │    云端：Claude / OpenAI —— 仅发送 转写文本 +  │
        │      会话名列表 + 已开标签标题 + 当前 cwd      │
        │      绝不发送 终端回滚、文件内容、密钥、vault  │
        └──────────────┬─────────────────────────────────┘
                       │ {tool, args}
                       ▼
        ┌────────────────────────────────────────────────┐
        │  动作派发器（前端，本地）                       │
        │  connect_session / switch_tab / navigate / ... │
        └────────────────────────────────────────────────┘
```

跨阶段铁律：终端输出字节、文件内容、vault 数据、SSH 密钥材料 **永远不会** 被任何语音路径读取，无论本地还是云端。

### 复用既有基础设施（不重造轮子）
- `write_terminal(sessionId, base64Data)` —— `src-tauri/src/terminal/mod.rs:243`（v1.0–v1.2 不用，留给 voice-v2）
- `create_ssh_terminal(...)` / `create_local_terminal(...)` —— `src-tauri/src/terminal/mod.rs`
- `list_sessions()` / `get_session(id)` —— `src-tauri/src/session/mod.rs`
- `useAppStore.activeTabId` 和标签数组 —— `src/stores/appStore.ts`
- `terminalSessionIds` ref —— `src/layouts/MainLayout.tsx:151`（提升为 voiceStore 字段，便于派发器读取）
- `QuickConnect.onConnectInput()` 和 `handleConnectSession()` —— `src/layouts/MainLayout.tsx:783`
- `CommonCommandsPalette.onPick()` 加新 `initialQuery?` 入参 —— `src/components/terminal/CommonCommandsPalette.tsx:21`
- Tauri `Channel<...>` 流式模式 —— `src-tauri/src/terminal/mod.rs:13,18`（用于回传部分转写）
- `createInputEchoSuppressor()` —— `src/lib/terminalOutputFilter.ts:177`（v1.0–v1.2 不用，voice-v2 执行 shell 命令时再启用）

---

## Voice v1.0 —— PTT + 浏览器 STT 烟雾测试

**目标：** 用最短路径验证"按键说话 → 完成动作"的体感，再为本地 STT 与 LLM 工具调用买单。整体放在 preview 开关后，默认关闭。

### 用户流程
1. 设置 → AI → 语音（preview）：用户开启开关，接受"使用浏览器在线 STT"的免责说明。
2. 用户按住 `Ctrl+Shift+Space`（或点击 QuickConnect 栏的麦克风按钮）。
3. 右下角浮窗出现：呼吸态麦克风、实时部分转写、"聆听中…"。
4. 用户说"连接 prod-web-01"。
5. 松开。Web Speech API 返回最终转写文本。
6. 正则语法返回 `{tool: "connect_session", args: {query: "prod-web-01"}}`。
7. 在 `useSessionStore.sessions` 上做模糊匹配——最佳匹配 `prod-web-01`（分数 >0.6） → 调用现有 `handleConnectSession()`。0.4–0.6 → 弹出确认窗。<0.4 → 浮窗提示"未匹配到 'prod-web-01'"。

### 意图类型（v1.0 内部，仅给正则语法用）
```ts
type Intent =
  | { tool: "connect_session";       args: { query: string } }
  | { tool: "switch_tab";            args: { query: string } }
  | { tool: "navigate_file_browser"; args: { path: string } }
  | { tool: "search_history";        args: { query: string } }
  | { tool: "open_session_editor";   args: { name?: string } }
  | { tool: "noop";                  args: { reason: "unparsed" | "ambiguous"; transcript: string } };
```

正则规则（按顺序匹配，命中即停）：
- 中：`^(连接|连上|打开|登录|登入)\s*(?:到\s*)?(.+)$` / 英：`^(connect|open|ssh)\s+(?:to\s+)?(.+)$` → `connect_session`
- 中：`^切换(?:到)?(?:标签|tab)?\s*(.+)$` / 英：`^(?:switch|go)\s+(?:to\s+)?(?:tab\s+)?(.+)$` → `switch_tab`
- 中：`^(?:进入|前往|cd|去)\s*(.+)$` / 英：`^(?:cd|navigate|go to)\s+(.+)$` → `navigate_file_browser`（仅当活跃标签是 SFTP / 本地文件浏览器）
- 中：`^(?:历史|找命令|搜命令)\s*(.+)$` / 英：`^(?:history|find command|search history)\s+(.+)$` → `search_history`
- 中：`^(?:新建|新建会话|创建会话|编辑会话)(?:\s*(.+))?$` / 英：`^(?:new session|create session|edit session)(?:\s+(.+))?$` → `open_session_editor`
- 否则 → `noop`

### 新增文件
- `src/lib/voice/audioCapture.ts` —— `getUserMedia` + Web Speech API 封装；产出 `{partial, final}` 事件；停止时清理音轨。
- `src/lib/voice/grammar.ts` —— 纯 TS 正则解析器，输出 `Intent`。
- `src/lib/voice/intentDispatcher.ts` —— 给定 `Intent` + 各 store 快照，调用对应回调；返回 `{ok, message}`。
- `src/lib/voice/match.ts` —— 模糊匹配（分词后做 Sørensen-Dice，约 50 行，无外部依赖）。
- `src/components/voice/VoiceMicButton.tsx` —— 麦克风按钮 + 聆听态发光环。
- `src/components/voice/VoiceToast.tsx` —— 右下角浮窗：闲置/聆听/处理/结果四态。
- `src/components/voice/VoiceSettingsSection.tsx` —— 设置页 UI 片段；默认关闭的总开关、快捷键重绑、浏览器 STT 免责说明。
- `src/stores/voiceStore.ts` —— Zustand：`{enabled, hotkey, status, partialTranscript, lastIntent, lastResult, terminalSessionIds}`，把 MainLayout 的 ref 提到 store 里供派发器读。
- `src/lib/voice/voice.test.ts` —— vitest 单测，覆盖语法 + 模糊匹配（含中英混合用例）。

### 修改既有文件
- `src/layouts/MainLayout.tsx` —— 注册全局键盘监听（capture 阶段 keydown / keyup）；用 voiceStore setter 替换 `terminalSessionIds.current` 的写入；在 QuickConnect 行挂载 `VoiceMicButton`，在 StatusBar 附近挂载 `VoiceToast`；通过 store 把 `handleConnectSession`、`handleQuickConnect`、`setActiveTab`、`openSettingsTab` 暴露给派发器。
- `src/components/quickconnect/QuickConnect.tsx` —— 在 `qc-refresh` 与末尾之间渲染 `<VoiceMicButton>`，按 `voiceStore.enabled` 显示。
- `src/components/settings/SettingsPanel.tsx` —— 注册 `VoiceSettingsSection`。
- `src/components/terminal/CommonCommandsPalette.tsx` —— 接受 `initialQuery?: string` prop，便于 `search_history` 预填。
- `src/stores/appStore.ts` —— 新增 `voicePreview: boolean`（持久化到 localStorage，参考 `compactMode`），`voiceCommandPaletteQuery: string`。

### 依赖
- npm：无（`MediaRecorder`、`SpeechRecognition`、`getUserMedia` 已存在于 WebView2 / WKWebView / WebKitGTK）。
- Rust：无。

### 隐私 / 安全
- 浏览器 STT 意味着音频会经 webview 的 STT 服务商（Chrome → Google STT）离开设备。在开启对话框中显式说明；只有用户至少接受过一次免责说明，`start()` 才会被调用。
- 录音指示常驻可见：麦克风按钮上的红点 + 浮窗。不存在任何静默录音路径。
- Linux 注意：WebKitGTK 不实现 Web Speech API —— 启动时特性检测，Linux 下隐藏开关并以 tooltip 提示"v1.1 通过本地 STT 提供"。
- v1.0 不持久化转写；`lastIntent` 仅存内存。

### 风险 + 缓解
- *Web Speech API 不可用 / 被禁用* → 启动时特性检测；置灰开关并用 tooltip 给出原因。
- *和 SSH 内程序的快捷键冲突* → 全局键盘监听 `addEventListener("keydown", ..., {capture:true})`，仅在修饰键集合完全相同时触发；松键不挑焦点。
- *从语音到动作 >2 s 显得卡顿* → 全程展示部分转写；松键瞬间立即切换到"思考中"。
- *Webview MediaRecorder 被企业策略拦截* → 捕获 `NotAllowedError`，提示"浏览器拒绝麦克风权限"并提供重试。
- *macOS TCC 麦克风权限弹窗* → 首次运行会弹窗；在设置侧栏给出说明。

### v1.0 不做（推迟到 v1.1）
- 本地 STT、Ollama / Claude 工具调用、中文优化模型。
- 链式意图（"打开 prod-web-01 然后切到 logs 标签"）。
- 持久化新建会话（仅打开会话编辑器）。

---

## Voice v1.1 —— 本地 STT（中英双语）+ LLM 工具调用

**目标：** 真正的可发布版本。默认 100% 本地；云端逐项可配置开启。

### 用户流程
1. 用户按住 PTT。`AudioWorkletNode` 以 16 kHz 单声道 PCM 采集（要原始帧，不要 Opus）。
2. 帧通过 `Channel<ArrayBuffer>` 流向 Rust（与终端输出 channel 方向相反）。后端在 `voice::session` 缓冲。
3. 松键（或松键后 800 ms 静音）后，后端把缓冲交给当前活跃引擎（Whisper / SenseVoice / FunASR / 云端某家）。录制过程中部分转写每 50 ms 通过正向 `Channel<String>` 回传给浮窗。
4. 最终转写 → `ai::resolve_voice_intent(transcript, context)`。上下文包含：会话名 + 主机 + 分组、已开标签的标题与类型、活跃标签的 cwd、当前操作系统。**不含** 终端回滚、文件内容、vault 数据。
5. AI 返回严格 JSON 工具调用。前端 `intentDispatcher` 复用 v1.0 的派发回调。

### 引擎选择策略
- 设置里两条独立配置：`stt.zh`（中文模型）、`stt.en`（英文模型），各自可指向"内置 / 已下载的某模型 / 自填本地路径 / 某云端提供商"。
- 第三个开关 `stt.auto_route`：开启后，前 600 ms 音频先送 Whisper-tiny 做语种检测，再路由到对应引擎。关闭则使用全局默认引擎。
- 一次最多有 1 个活跃推理上下文；切换语言时旧引擎在 60 s 后释放内存。

### LLM 工具 Schema（Anthropic / Ollama 工具调用格式）
```jsonc
[
  {
    "name": "connect_session",
    "description": "通过名称、主机、或 user@host 打开一个已保存的会话。当用户说『连接』『打开』或念出某台服务器名时使用。",
    "input_schema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    }
  },
  {
    "name": "switch_tab",
    "description": "切换到一个匹配查询的已打开标签。",
    "input_schema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    }
  },
  {
    "name": "navigate_file_browser",
    "description": "在活跃的 SFTP 或本地文件浏览器中切换目录。仅当当前活跃标签类型为 sftp 或 file-browser 时合法。",
    "input_schema": {
      "type": "object",
      "properties": { "path": { "type": "string" } },
      "required": ["path"]
    }
  },
  {
    "name": "search_history",
    "description": "用该查询预填打开 Common Commands 命令面板。",
    "input_schema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"]
    }
  },
  {
    "name": "open_session_editor",
    "description": "打开新建会话对话框，由用户手动完成创建。当意图是『新建』『创建』但参数不完整时使用。",
    "input_schema": {
      "type": "object",
      "properties": { "name": { "type": "string" } }
    }
  },
  {
    "name": "no_action",
    "description": "当转写不可理解、与本工具集无关、或请求超出工具列表时使用。",
    "input_schema": {
      "type": "object",
      "properties": { "reason": { "type": "string" } },
      "required": ["reason"]
    }
  }
]
```

System prompt（放在 `src-tauri/src/ai/voice_prompt.rs`，中英双语版本各一份，按转写语种选择）：

> 你是一个名为 Taomni 的终端应用的语音命令路由。用户刚说了一句简短指令，你必须从可用工具中调用恰好一个，绝不输出散文。如果不确定，调用 `no_action` 并简要写明原因。可用上下文包括：已打开的标签、保存的会话、当前标签类型、当前标签的 cwd。绝不要凭空臆造会话名 —— 当查询不能合理映射到真实会话时，调用 `no_action`。

### 新增文件 / 模块
- `src-tauri/src/voice/mod.rs` —— Tauri 命令 `voice_start`、`voice_push_pcm`、`voice_stop`、`voice_status`、`voice_set_active_model`、`voice_list_models`。在 `AppState` 中持有 `Mutex<Option<VoiceSession>>`。
- `src-tauri/src/voice/whisper.rs` —— `whisper-rs` 集成；懒加载；模型文件位于 `app_data/voice/models/<id>/`。
- `src-tauri/src/voice/sensevoice.rs` —— SenseVoice ONNX 推理，走 `ort`（onnxruntime-rs）；输入 16 kHz PCM，输出文本 + 语言/情感标签（情感标签留作 v1.2+ 使用）。
- `src-tauri/src/voice/funasr.rs` —— Paraformer / sherpa-onnx 推理（同样基于 `ort`），针对中文优化。
- `src-tauri/src/voice/cloud/` —— 云端提供商目录：
  - `openai.rs`（Whisper API）
  - `deepgram.rs`
  - `azure.rs`
  - `aliyun.rs` / `tencent.rs` / `volc.rs`（国内三家）
  - `google.rs`
  - 共享 trait `SttBackend { async fn transcribe(pcm) -> Result<Transcript>; }`，用既有 `reqwest` 调用。
- `src-tauri/src/voice/manifest.rs` —— `voice-models.manifest.json` 拉取 + ETag 缓存 + 校验。
- `src-tauri/src/voice/downloader.rs` —— SHA-256 校验 + 原子重命名 + 断点续传（`Range` 头）。
- `src-tauri/src/voice/audio.rs` —— 纯 Rust 重采样 / 归一化；以合成正弦波做集成测试。
- `src-tauri/src/voice/lang_detect.rs` —— 加载 Whisper-tiny 做前 600 ms 语种检测。
- `src-tauri/src/ai/mod.rs` —— 若 v0.3.x 还没创建则在此创建；定义 `AiBackend`（Ollama、Claude、OpenAI），暴露 `resolve_voice_intent(transcript, context) -> ToolCall`。语音工具调用是它的第一位消费者。
- `src-tauri/src/ai/tools_voice.rs` —— 上述 JSON-Schema 工具定义，多后端共享。
- `src/lib/voice/audioWorklet.ts` + `audioWorklet.worklet.ts` —— 用 AudioWorklet 替换 MediaRecorder，输出原始 16 kHz PCM。
- `src/lib/voice/sttClient.ts` —— 封装新增 Tauri 命令；通过 `Channel<string>` 订阅部分转写。
- `src/components/voice/VoiceModelLibrary.tsx` —— 模型库 UI：列出 manifest 中的模型 + 已下载的本地模型 + "添加自定义 URL" + "导入本地文件"。
- `src/components/voice/VoiceModelDownloader.tsx` —— 下载进度条；可暂停 / 取消 / 续传。
- `src/components/voice/VoiceConfirmation.tsx` —— 歧义匹配的确认浮层（v1.1 仅在歧义时弹出；v1.2 默认每动作必弹）。
- 测试：`src-tauri/src/voice/tests/golden_pcm/*.wav` —— 6 段中英文短音频（"connect to prod web one"、"连接 prod 主机"、"切到日志标签" 等），Rust 集成测试断言转写在编辑距离阈值内。

### 修改既有文件
- `src-tauri/Cargo.toml` —— 加入下列依赖。
- `src-tauri/src/lib.rs` —— 在 `invoke_handler!` 注册全部 `voice::*` 与 `ai::*` 命令。
- `src-tauri/src/state.rs` —— 增加 `voice: Mutex<Option<VoiceSession>>` 与 `ai: Arc<AiBackends>` 字段。
- `src-tauri/src/vault/mod.rs` —— 接受新的 vault `kind`：`stt_api_key:openai|deepgram|azure|aliyun|tencent|volc|google_stt`、`ai_api_key:claude|openai`。`kind` 是自由字符串，无需迁移。
- `src/lib/ipc.ts` —— 绑定 voice 命令。
- `src/stores/voiceStore.ts` —— 增加 `models: Record<id, ModelMeta>`、`activeStt: { zh: id, en: id, autoRoute: bool }`、`activeIntent: "ollama"|"claude"|"openai"`、模型下载进度。
- `src/lib/voice/grammar.ts` —— 作为 `intentBackend === "off"` 或 AI 调用失败的兜底；通过设置项"AI 不可用时使用语法解析器"启用。
- `src/components/voice/VoiceSettingsSection.tsx` —— 增加：模型库入口、活跃模型选择（中/英分开）、自动路由开关、云端 STT 提供商列表（每家独立开关 + Vault Key 选择 + 测试按钮）、意图后端选择、"测试 STT"、"测试意图"。

### 依赖
- Rust：
  - `whisper-rs = "0.12"`（引入 whisper.cpp，固定版本）
  - `ort = { version = "2", features = ["load-dynamic"] }`（onnxruntime 绑定，用于 SenseVoice / FunASR）
  - `reqwest = { version = "0.12", features = ["rustls-tls", "json", "stream"] }`（已规划用于云同步，语音复用）
  - `hound = "3.5"`（WAV 测试 fixture）
  - `byteorder = "1.5"`（PCM / float 转换）
  - `rubato = "0.15"`（备选重采样；如 `audio.rs` 自实现性能不够再上）
  - **不引入 `cpal`：** 采集留在 webview，PCM 经 IPC 传到 Rust。
- 构建依赖：whisper-rs 需 C++ 工具链（CI 上 Windows MSVC、macOS clang、Linux `build-essential` 已是 Tauri 前置）；onnxruntime 需要在打包时随包带上 `onnxruntime.dll/.dylib/.so` —— 通过 `tauri.conf.json` 的 `bundle.resources` 实现。
- npm：无。

### 隐私 / 安全
- 音频字节绝不写盘。`voice_stop` 在引擎完成后立刻清空缓冲。
- 云端 STT 仅在用户同时（a）打开对应提供商开关 *并* （b）填好 vault API Key 时才会工作。状态栏在任一云端 STT 启用时常显黄点。
- LLM 上下文由 `src-tauri/src/voice/intent_context.rs` 按白名单生成；用一份金标准结构体在测试里 diff 防止意外把回滚 / vault 字段塞进去。
- 提供商 API Key 仅以 vault 条目存储（`kind=stt_api_key:*` / `ai_api_key:*`）；从不写入磁盘明文。
- 路径与会话名是用户自己挑出来的产物，可以发给云端 LLM；终端回滚永远不发。
- 每次云端调用都写一行审计：`(timestamp, backend, payload_kind, payload_bytes)`。设置 → 语音 → 活动里可见；payload 本身不入库。

### 风险 + 缓解
- *whisper-rs 在 Windows MSVC 构建时偶发链接问题* → CI 跑独立的 lib-only 烟雾任务；固定 whisper.cpp commit；保留"通过 `bundle.resources` 携带预编译 CLI 二进制 + shell 调用"的兜底路径。
- *onnxruntime 版本与 SenseVoice / FunASR 模型不匹配* → manifest 中每个 ONNX 模型声明 `min_ort_version`；不满足时禁用并提示。
- *模型下载在企业代理后失败* → 尊重 `HTTPS_PROXY`；提供"导入本地模型文件…"按钮。
- *manifest URL 单点失败 / 上游模型下架* → manifest 的 `urls` 字段允许多镜像；用户可在设置里替换 manifest 仓库地址。
- *LLM 编造会话名* → 派发器再次用客户端模糊匹配验证 LLM 给的 `query`；分数 <0.6 走确认窗，绝不自动连接。
- *Ollama 未运行* → 给出可执行错误（"启动 Ollama 或在设置中切换后端"）；如用户开了兜底就回退到正则语法。
- *Whisper / SenseVoice 在 200 ms 短片段上输出空文本* → 录制最短 600 ms；按 PTT 后再前移 200 ms 作为预滚冲。
- *macOS 沙箱 + 携带二进制* → 经 `tauri.conf.json::bundle.resources` 打入；通过 `app_handle.path().resource_dir()` 解析；签名时一并签。
- *国内 STT 厂商 SDK 通常是闭源 SDK 而非简单 HTTP* → v1.1 仅集成它们的 RESTful 端点（阿里云 NLS REST、腾讯云一句话 REST、火山引擎 ASR REST）；闭源 WebSocket / SDK 留给后续。

### v1.1 不做（推迟到 v1.2）
- 总是常驻的转写气泡（v1.0 / v1.1 仍是右下角浮窗；常驻气泡作为 v1.2 的可视升级）。
- 每个动作都强制确认（v1.1 只在歧义时弹）。
- 语音命令审计日志 UI（v1.1 已在埋点；UI 留给 v1.2）。

---

## Voice v1.2 —— 强确认 + 视觉反馈打磨

**目标：** 让语音在日常工作流中可信 —— 每次动作都可预览、每条命令都可追溯、绝不会"误触发"。

### 用户流程
1. 按住 PTT。底部居中转写气泡（新）替代右下角浮窗 —— 更大、实时部分词、麦克风电平条。
2. 松开。气泡变成确认卡："连接 prod-web-01？[Enter] / 取消 [Esc]"。
3. 两种时序模式（按工具可配）：立即确认（必须按 Enter）或 1.5 s 自动触发（除非取消）。v1.2 默认：`connect_session` 与 `open_session_editor` 立即确认；`switch_tab`、`search_history`、`navigate_file_browser` 自动触发。
4. 动作执行；气泡缩成结果芯片（"已连接到 prod-web-01"），4 s 自动消散。
5. 设置 → 语音 → 历史：可滚动审计日志（时间、转写、意图 JSON、目标、结果、所用 STT/意图后端）。

### 新增文件
- `src/components/voice/VoiceTranscriptBubble.tsx` —— 替代 `VoiceToast`；麦克风电平由 AudioWorklet RMS 驱动；状态机 `idle | listening | thinking | confirming | acting | done | error`。
- `src/components/voice/VoiceAuditLog.tsx` —— 设置标签页，按后端 / 结果筛选；导出 JSON。
- `src-tauri/src/voice/audit.rs` —— 仅追加的 sqlite 表 `voice_audit`；1000 条轮转。
- `src/lib/voice/confirmation.ts` —— 工具级"确认 vs 自动触发"策略；用户覆盖存在 voiceStore。

### 修改既有文件
- `src-tauri/src/session/db.rs` —— 迁移：
  ```sql
  CREATE TABLE IF NOT EXISTS voice_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    transcript TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    resolved_target TEXT,
    outcome TEXT NOT NULL,            -- 'fired' | 'cancelled' | 'no_match' | 'error'
    stt_backend TEXT NOT NULL,
    intent_backend TEXT NOT NULL
  );
  ```
- `src-tauri/src/lib.rs` —— 注册 `voice_audit_list`、`voice_audit_clear`。
- `src/components/voice/VoiceSettingsSection.tsx` —— 增加 审计日志 标签 + 工具级确认矩阵。
- `src/lib/voice/intentDispatcher.ts` —— 所有派发都走 `requestConfirmation()`；resolve 触发，reject 记 `cancelled` 并展示结果芯片。
- `src/layouts/MainLayout.tsx` —— `VoiceToast` 替换为 `VoiceTranscriptBubble`。

### 依赖
- npm：无。Rust：无。（审计日志复用现有 `rusqlite`。）

### 隐私 / 安全
- 审计日志仅本地，存于 `taomni.db`。"清除语音数据"按钮可清除。重启后保留 —— 这是用户对语音行为的问责面板。
- 审计日志尊重 v0.3.x 路线图中的"绝不发往云端 AI"标记：当被审计的意图涉及该会话时，无论默认配置如何，`intent_backend` 都记为 `local`。
- 工具级确认可以被放宽，但绝不允许全局绕过 —— 一旦放宽，会话剩余时间内转写气泡上方常驻一条黄色警告横幅。

### 风险 + 缓解
- *用户嫌确认烦* → 工具级配置；只读型工具默认自动触发；具破坏性形态的工具（v1 暂无，但框架先就位）保持必须确认。
- *审计日志撑大数据库* → 1000 条轮转；`(ts DESC)` 索引。
- *气泡遮挡终端（演示场景）* → 聆听中按 Esc 中止并隐藏；稳定 1 s 后转写不透明度自动降到 60%。

---

## v1.0–v1.2 范围内的明确不做事项

1. **执行 Shell 命令。** 任何语音路径都不会向 `write_terminal` 写字节。留给 voice-v2 配合 sudo 式守门 + Runbook 联动。
2. **直接落库新建会话。** v1.0–v1.2 只能 *打开编辑器*，无法把新会话写入数据库。避免误存凭据。
3. **唤醒词 / 常开聆听。** 仅 PTT。
4. **VAD 触发。** 仅用于裁剪已录制音频末尾的静音，不用作触发器。
5. **多轮对话。** 每次 PTT 都是全新单轮意图，不向 LLM 携带对话历史。
6. **TTS / 语音回复。** 反馈一律视觉。
7. **多语言默认。** 默认中英双语；其他语言（日、韩、欧洲语种）走"按需下载多语言模型"路径，不是默认配置。
8. **语音控制标题栏 / 窗口控件 / 菜单。** 设置、退出、窗口操作仍然只接受键盘鼠标。
9. **实时回滚摘要。** 这属于 `roadmap.md` v0.3.x 的 AI 面板范围，语音不向 LLM 推流终端输出。
10. **把语音流接入 Runbook 录制器。** 留给 v0.4.x 的 Runbook。
11. **移动端 / Web 版本。** 仅 Tauri 桌面。
12. **会话级语音配置。** v1 全局单一配置（一个快捷键、一对中英文模型）。
13. **说话人分离 / 声纹认证。** 不做基于说话人的安全声明。
14. **离线 LLM 权重内置。** 想本地意图解析就要装 Ollama；不在二进制内打 llama 权重。

---

## 关键文件一览

| 文件 | 关联点 |
|------|--------|
| `src/layouts/MainLayout.tsx` | 全局快捷键监听；挂载麦克风按钮和浮窗；把 `terminalSessionIds` ref 提升到 voiceStore；通过 store 暴露派发回调 |
| `src-tauri/src/lib.rs` | 注册 `voice_*` 与 `ai_*` Tauri 命令 |
| `src-tauri/src/terminal/mod.rs` | `Channel<InvokeResponseBody>` 模式参考（`mod.rs:13,18`），用于回传部分转写 |
| `src-tauri/Cargo.toml` | v1.1 引入 `whisper-rs`、`ort`、`reqwest`、`hound`、`byteorder` |
| `src/components/quickconnect/QuickConnect.tsx` | 麦克风按钮宿主位置 |
| `src/components/terminal/CommonCommandsPalette.tsx` | 接受 `initialQuery?` 入参以支持 `search_history`（`CommonCommandsPalette.tsx:21`） |
| `src/stores/voiceStore.ts`（新） | 语音状态唯一来源 + 绑定的派发回调 |
| `src-tauri/src/ai/mod.rs`（v1.1 新增） | 后端派发器；语音工具调用是首位消费者 |
| `src-tauri/src/voice/manifest.rs`（v1.1 新增） | 模型 manifest 拉取 + 校验 |

---

## 验证方式

### v1.0
- 在 设置 → AI → 语音 中开启，接受免责说明。
- 按住 `Ctrl+Shift+Space`，说出一个已存在会话的名字。浮窗显示部分转写。松开后该会话以现有连接路径打开。
- 同时开两个终端，说"切换到 终端 一"，验证活跃标签变化。
- 在本地文件浏览器标签下说"进入 /var/log"，验证 cwd 改变。
- 说一句乱码音频，验证浮窗给出"未匹配"且无动作。
- Linux 环境下：开关被隐藏，附"v1.1 通过本地 STT 提供"tooltip。

### v1.1
- 断开外网。按 PTT 说英文"connect prod web one"和中文"连接 prod 一号"两次，分别验证 Whisper 与 SenseVoice/FunASR 各自完成本地转写，并且 Ollama（运行中）返回工具调用。
- 进入 模型库，下载 `whisper-base-multi`、`sensevoice-small`、`paraformer-zh-small`，验证 SHA-256 校验通过、断点续传正常、可"导入本地文件"。
- 自填一个无效 URL，验证错误提示。
- 在设置中开启 Whisper API 与 vault 中的密钥，验证状态栏黄点出现，"测试 STT"按钮完成往返。
- 开启阿里云 / 腾讯云 / 火山引擎 / Azure / Google STT 的某一家，分别用一段中文音频验证转写。
- 跑意图上下文白名单单测：`cargo test -p taomni_voice intent_context_allowlist` —— 断言生成的 JSON 与金标准只含允许字段。
- 选定云端 STT 后中途断网，验证降级到错误提示并（如用户允许）回落到本地 / 语法解析器。

### v1.2
- 触发 `connect_session`，验证确认卡必须按 Enter，按 Esc 取消。
- 触发 `switch_tab`，验证 1.5 s 内无操作即自动触发。
- 在 设置 → 语音 → 历史 中可见最近一次"已触发"和"已取消"的条目，后端字段标注正确。
- 在某会话上设置"绝不发往云端 AI"，再用语音意图命中该会话，验证审计日志的 `intent_backend` 记为 `local`。
