# ASR 后续开发方案（指导 Agent 执行）

- 状态：已定版。2026-10-08 用户先确认 D1–D10 全部按推荐值定案，随后修订其中两项：D3 改为升级一键替换 q8，D4 改为火山与 Soniox 并行接入；其余八项维持推荐定案。按本方案分阶段实施
- 基线：`main` @ `71e71f4f`（v0.4.34，PR #684、#685 合入后；#685 统一了 Whisper/Zipformer 的下载控制与版本/下载元数据展示，Zipformer 模型源改为公开仓库常量，本方案的现状盘点在此基础上仍然成立，实施 P1 前以最新 `models.rs` 为准复核一遍）
- 本文档所在分支：`docs/asr-research-plan`（仅文档，不含代码改动）
- 证据来源（同目录，均为调研原件，引用数据以原件为准）：
  - `asr-research-01-market-and-providers.md`：在线流式厂商、无 GPU 本地引擎、移动端总调研（2026-10-08）
  - `asr-research-02-mobile-apps-voice-input.md`：约 34 个手机 App 语音录入方案实况
  - `asr-research-03-pc-cpu-latency-and-model-size.md`：PC 纯 CPU 延迟深析 + 8 语种模型大小推荐
- 既有文档关系：`asr-model-catalog.md`（模型目录/更新协议）、`asr-refactor-report.md`（重构评估）、`voice-input-delivery.md`（本地语音交付与验证）继续有效；本方案与之冲突时，以用户对第 8 节的决策为准，并回写受影响文档。

实施进度与实际门禁结果见 [asr-implementation-progress.md](asr-implementation-progress.md)；本机初始基准见 [asr-bench-results-2026-10-08.md](asr-bench-results-2026-10-08.md)，P0 尚未完成。

## 1. 目标与非目标

### 目标

1. 本地听写做到「边录边出字（partial）+ 说完快速定稿（final）」，中文（普通话、粤语）与英文为一级语种，日、西、法、意、韩为二级语种，均须可用。
2. 默认下载体积受控：默认组合总下载 ≤ 500 MB 量级；单个默认模型 ≤ 300 MB。
3. 在线流式补齐国内第二供应商，形成国内/海外双通道，且供应商可替换、不锁定。
4. 移动端路线明确：云端流式先行，端侧 sherpa-onnx CPU 版随后，默认不开 GPU/NPU 加速（用户已决策，2026-10-08）。
5. 所有选型结论必须有自建基准数据支撑，不再引用厂商自报数据做最终裁决。

### 非目标

- 不做会议级长时转写/说话人分离产品化（D9 已定：维持短听写定位）。
- 不把权重打进安装包；继续按需下载、哈希钉版（沿用 `asr-model-catalog.md` 协议）。
- 不引入 Python 运行时（FunASR/faster-whisper 的 Python 栈只作对照基准，不进产品）。
- 不做静默云端兜底：本地失败就是失败并明确报错（沿用现有原则）。

## 2. 现状盘点（基线代码事实）

| 路径 | 实现 | 关键文件 | 备注 |
| --- | --- | --- | --- |
| 本地批量 | whisper-rs / whisper.cpp，CPU-only，停止后整段识别，最长 120 秒，无 VAD、无流式 | `src-tauri/src/asr/manager.rs`、`catalog.rs` | 目录只有 Base/Small/Medium 三档，均为 **f16**（148 / 488 / 1533 MB），钉版 revision `5359861c…`，目录版本 `2026-10-whisper-1` |
| 本地流式 | sherpa-onnx 流式 Zipformer 中英双语（2023-02-20，int8），真流式 partial + 端点检测，默认 feature 开启 | `src-tauri/src/voice/streaming.rs` 的 `run_local`、`src-tauri/src/asr/models.rs` 的 sherpa 安装器 | 线程上限 4、greedy 解码；模型只覆盖中/英 |
| 在线流式 | 与本地共用 `TranscriptEvent` 中立契约（`interim`/`final`、约 100 ms 的 16 kHz PCM 分片） | `streaming.rs` 的 `run_online` 及三个 `run_*` | 仅 3 家：阿里 DashScope `paraformer-realtime-v2`、Deepgram `nova-3`、Gemini Live 转写；密钥入 vault；代理走应用/自定义/无三模式 |
| 采集与会话 | cpal 采集、单 session、取消/上下文切换丢弃旧结果，结果只填草稿不自动发送 | `src-tauri/src/voice/capture.rs`、`commands.rs` | `commands.rs` 按 `asr.active` 分发：`sherpa-zipformer-zh-en` → 本地流式，其余在线 ID → `run_online`，Whisper 走批量 |
| 配置与 UI | `AsrConfig.providers` + 设置面板 + 前端默认值 | `src-tauri/src/ai/config.rs`、`src/components/settings/AsrPanel.tsx`、`src/stores/aiStore.ts` | 本地/在线以 `mode` 区分；新增引擎必须同步 Rust 默认值、TS 默认值、stub 与面板选项（已有测试约束） |

## 3. 调研得出的硬结论（实施依据）

1. **延迟**：SenseVoiceSmall int8 经 sherpa-onnx 的独立实测（Core Ultra 7 155H）为 4.6–7.2 秒音频推理 81–102 ms（RTF 0.014–0.016），加载约 1.2 秒、峰值内存约 373 MB；同基准下 Whisper base/small/turbo 中文 CER 为 31.3 / 22.1 / 23.2，SenseVoice 约 8.2。Zipformer 流式分块下限 320 ms。详见原件 03。
2. **语种覆盖**：一模型覆盖全部 8 语种的只有 Whisper 系列。SenseVoice 为 5 语种（中/粤/英/日/韩），无西/法/意；Zipformer 双语只有中/英；Parakeet v3 有西/法/意/英，无中/日/韩。且 large-v3 起才有独立粤语码，老版 Whisper 只有一个 `zh` 标签，粤语易被写成普通话书面语。
3. **模型体积**（ggml 实查字节）：Whisper Small q8_0 为 264 MB、Base q8_0 为 81.8 MB、large-v3-turbo q5_0 为 574 MB；现状三档 f16 是同质量下最贵的下载与内存形态。
4. **在线格局**：国内云端自研流式是主流（豆包 Seed-ASR、阿里 Paraformer/Fun-ASR）；全球侧 Deepgram 成熟、Soniox 低价且主打中英混说。OpenAI 文件版 Whisper API 不是流式；Realtime 版约 $0.017/分钟且国内不可用。AssemblyAI 按会话时长计费，与 PTT 场景冲突。价格与未核实项见原件 01。
5. **手机 App 实况**：约 34 个样本中云端自研占主流，端侧作主路径的基本只有平台厂商（Apple、Google，且其端侧靠 NPU/Tensor 芯片）；独立听写应用的差异化在第二遍 LLM 清理（Wispr Flow），但其过度改写中文是反面教材。详见原件 02。
6. **手机端 CPU 可行性**：短时 PTT 听写下流式 Zipformer 单核负载可控（公开 RTF 约 0.06–0.38）；发热/掉电风险主要来自连续长时转写与常驻监听，本产品两者都不做。

## 4. 目标架构

保持并扩展现有中立契约，不推倒重来：

```text
采集 (cpal, 16kHz mono, ~100ms 分片, 单 session, 可取消)
  └─ 路由层（新增，按 asr.active + 语种 + 在线/离线/隐私模式选择后端）
       ├─ 本地流式：Zipformer（partial） ── 端点触发 ──> SenseVoiceSmall（final 重解）
       ├─ 本地批量：Whisper（q8/q5 目录，西/法/意及长句兜底）
       ├─ 在线流式：阿里 Paraformer / 火山 Seed-ASR（国内）；Deepgram / Soniox（海外）
       └─（移动端）云端流式 / sherpa-onnx CPU / iOS SpeechAnalyzer（系统层）
  └─ 后处理（可选，分级）：标点/ITN（引擎自带优先）→ LLM 清理（关/轻/全，原文可撤销）
  └─ 投递：只写可编辑草稿，final 才提交目标输入框（沿用现有语义）
```

设计约束（后续 Agent 必须遵守）：

- 新增后端必须实现同一 `TranscriptEvent` 契约（`session_id`、`text`、`final_text`、`processing_ms`、`provider`），不得把供应商私有字段（热词格式、端点语义、二进制帧）泄漏到 UI 层；火山二进制帧只存在于其 `run_volcengine` 内部。
- 模型安装统一走现有安装器模式：钉版 revision + 精确字节数 + SHA-256、`.part` 续传、三代理模式（应用/独立/无，遵循仓库 `AGENTS.md` 的网络条款）、进度/取消/校验失败不覆盖旧版。目录变更同步更新 `asr-model-catalog.md`。
- 配置新增字段必须同时改：Rust `AsrConfig` 默认值与迁移、TS `DEFAULT_CONFIG`、stub、设置面板及对应测试（参考现有 `ai/config.rs` 中 ASR 默认值断言测试）。
- 不得为通过测试而降低断言；真实音频测试沿用 `#[ignore]` + 环境变量 PCM 的既有模式（见 `manager.rs` 的 `base_decodes_*`）。

## 5. 分阶段实施计划

### P0 基准先行（阻塞项，先于一切引擎裁决）

目的：用自己的数据裁决引擎与档位，终结「厂商数据打架」。

任务：
1. 建固定音频集（放 `qa-ui-auto-tests/fixtures/voice/` 并扩展）：8 语种各 ≥ 20 句（普通话、粤语、英文、日、西、法、意、韩），另加中英混说 ≥ 20 句、代码术语/文件路径 ≥ 10 句、噪声与静音样本。优先用 FLEURS / Common Voice 等可分发子集；用户自录样本只存本地不进仓库（见 D8）。
2. 基准脚本（扩展 `scripts/voice-fixture.py` 或新增 `scripts/asr-bench/`）：对同一音频集跑现有三路 + SenseVoiceSmall + Whisper q8 各档，输出 CER/WER、首 partial 延迟、端点→final 延迟、RTF、峰值内存、冷加载时间；至少覆盖一台现代 CPU 与一台老 CPU（如 i7-6700K 级别）。
3. 把结果写回本目录新增 `asr-bench-results-<日期>.md`，作为 P1 选型的裁决记录。

验收：音频集与脚本可复跑；报告中每个数字注明 CPU/线程/量化/音频时长；P1 的默认档位决策能引用该报告行号。

### P1 本地引擎与目录改造（PC，核心阶段）

任务：
1. 接入 SenseVoiceSmall（sherpa-onnx 离线 recognizer，与现有 `asr-sherpa` feature 同一运行时）：新增模型条目（int8，约 229 MB）、安装/校验/状态查询，复用 sherpa 安装器的进度事件模式。
2. 双路定稿：Zipformer 继续出 partial；端点（现有 endpoint 规则）触发 SenseVoice 对本句音频重解出 final 并替换。SenseVoice 不可用时回退 Zipformer 自身 final（不得回退云端）。
3. 语种路由：`zh/yue/en/ja/ko` 走 SenseVoice；`es/fr/it` 走 Whisper；`auto` 时先以界面语言/上次语种为先验，LID 只作纠偏。粤语在 SenseVoice 路径按 `yue` 处理，避免 Whisper 老版 `zh` 单标签问题。
4. Whisper 目录量化改造：新增 Small q8_0（264 MB）为默认 Whisper 档；新增 large-v3-turbo q5_0（574 MB）为高精度可选档（自带粤语码）；Medium f16 下架。存量 f16 按 D3 定案做**升级一键替换**：应用升级后检测到旧 f16 文件时提示一键替换，流程为下载对应 q8 版本 → SHA-256 校验通过 → 删除旧 f16 文件；下载失败、取消或校验不通过时保留旧 f16 不删除，且旧版在替换完成前仍可用。`catalog.rs` 需支持量化条目（现有文档「不要把量化权重混入同一条目」的规则要同步修订为「量化独立条目、独立哈希」）。
5. 线程策略：PC 端维持上限 4 线程但以 P0 数据复核（线程数、内存带宽拐点）；解码维持 greedy；VAD/端点参数（Zipformer rule1/2/3、SenseVoice 分段）以「端点→final 总延迟 ≤ 500 ms 为目标、静音误触发可控」调参并记录。

涉及文件：`src-tauri/src/asr/{catalog,manager,models}.rs`、`src-tauri/src/voice/{streaming,commands,capture}.rs`、`src-tauri/src/ai/config.rs`、`src/components/settings/AsrPanel.tsx`、`src/stores/aiStore.ts`、`src/stubs/`、对应 `*.test.*` 与 `qa-ui-auto-tests/cases/TC-VOICE-*` 扩展（含 policy 同步，见第 7 节）。

验收：8 语种真实音频测试通过（CER/WER 阈值以 P0 报告定）；听写全程断网可用；模型切换/取消/迟到结果丢弃等既有语义不回归（TC-VOICE-001/002 继续通过）。

### P2 在线供应商补齐

任务：
1. 新增火山引擎 Seed-ASR 2.0（`bigmodel_async` 模式）：实现其二进制 WebSocket 帧协议（4 字节头 + gzip JSON），热词表 ≤ 2000 词映射；接入前先在控制台核实其现行计费（原件 01 中其价格未核实，不得按传闻实现计费相关逻辑）。
2. Soniox 接入（同一契约，与火山并行，D4 定案）：作为海外低价通道，与 Deepgram 在 P0 音频集上做中英混说 A/B，结论写回裁决记录后再定海外默认。
3. 热词通道打通：配置层新增供应商中立的热词列表（代码术语/人名/路径），分别映射 Deepgram keyterm、阿里热词、火山热词表；本地 SenseVoice/Zipformer 的热词能力以 P0 实测为准，不承诺未验证能力。
4. 会话计费防护：所有在线后端按「一次听写一条连接、空闲即断」实现，禁止常驻热连接；若未来接按会话计费的供应商（如 AssemblyAI）必须先过评审。
5. Gemini Live 按 D5 定案降为实验项：保留代码，默认供应商列表中隐藏。

验收：国内（阿里/火山）、海外（Deepgram/Soniox）各两家可在设置中切换且行为一致；代理三模式与 vault 密钥路径与现有三家一致；断网/密钥缺失错误码语义与现有 `ASR_*` 前缀一致。

### P3 后处理（LLM 清理，默认关）

任务：转写后可选 LLM 清理（去口头禅、补标点、断句），分关/轻/全三档，全档必须保留「撤销回原文」；默认档位按 D6。清理只处理文本、不得改变代码/路径/数字（加回归样本）；清理失败回退原文并提示。

验收：中文听写样本上清理不改变语义（人工抽检 + 固定样本断言）；原文永远可达。

### P4 移动端（设计 + 原型，PC 稳定后启动）

路线（用户已定 CPU 默认）：v1 云端流式（国内阿里/火山、海外 Deepgram/Soniox，复用同一契约）；v2 端侧 sherpa-onnx（Zipformer 流式 + SenseVoice 定稿，线程 1–2，模型按需下载），定位为混合路由的一档（离线/弱网/隐私），不是云端替代；iOS 额外评估 iOS 26 SpeechAnalyzer 系统层（免费、端侧、自带标点），Android 不依赖系统 SpeechRecognizer（厂商差异过大，仅兜底）。

注意：当前仓库是桌面 Tauri 应用，移动端外壳（Tauri mobile / 独立壳）属于新工程范围，启动前需 D7 决策。本阶段先交付设计文档与一台低端安卓机的 CPU/温度/掉电实测（连续 10 分钟听写三项指标）。

### P5 质量与发布

- 每个阶段合入前执行第 7 节全部门禁；QA 新增用例同步 `qa-ui-auto-tests/ci/policy.yaml`。
- 模型目录每次变更按 `asr-model-catalog.md` 的发布清单执行（官方源核对、真机解码、更新说明写明语言/大小/硬件需求变化）。

## 6. 模型与供应商定稿（已确认，2026-10-08）

| 角色 | 定稿 | 下载大小 | 覆盖 |
| --- | --- | --- | --- |
| 默认组合 A（推荐） | SenseVoiceSmall int8 + Whisper Small q8_0 | 229 + 264 = **493 MB** | SenseVoice 管中/粤/英/日/韩，Whisper 管西/法/意 |
| 只下一个模型时 | Whisper Small q8_0 | 264 MB | 8 语种全覆盖、质量可用 |
| 轻量档 | SenseVoiceSmall int8 单独 | 229 MB | 缺西/法/意，须在 UI 明示 |
| 高精度可选档 | 组合 A 中 Whisper 换 large-v3-turbo q5_0 | 229 + 574 = 803 MB | 西/法/意与粤语更好 |
| 流式 partial | Zipformer 双语 int8（现有） | 以现有安装器目录为准 | 中/英 |
| 下架 | Whisper Medium f16（1.53 GB） | — | 被 turbo q5_0 以 1/3 体积支配 |
| 在线国内 | 阿里 Paraformer（现有）+ 火山 Seed-ASR 2.0（P2 新增） | — | 中/粤/方言/英 |
| 在线海外 | Deepgram Nova-3（现有）+ Soniox（P2，与火山并行接入） | — | 英为主、中英混说 |

## 7. 验证与推送门禁（仓库既有规则，后续 Agent 必须执行）

1. TypeScript：`npx tsc --noEmit`；Rust：本地 `cargo check` 通过（缺系统依赖先装，不得以「靠 CI 验证」跳过）。
2. 单元测试：相关 `cargo test --lib asr::`、`cargo test --lib voice::` 与前端定向 Vitest；CI 工具自测 `python -m unittest test_ci_selection test_ci_report test_ci_execute test_ci_desktop test_ci_provenance test_ci_services test_dev_contract`（仓库根目录）。
3. QA 用例：新增/修改 case 后跑 `python -m qa_ui_auto audit --gate`，并同步 `qa-ui-auto-tests/ci/policy.yaml`，否则 plan 阶段报 catalog 不一致。
4. 提交遵循仓库 Conventional Commits（如 `feat(asr): …`、`docs(asr): …`）；推送前本地编译 + 测试全过（用户既定规则）。

## 8. 用户决策（已定案，2026-10-08）

2026-10-08 用户确认 D1–D10 全部按推荐值定案，同日修订 D3、D4 两项（以本表定案列为准）。后续 Agent 按定案执行；如需变更任一项，必须由用户重新明确，不得自行推翻后宣称已定。

| 编号 | 决策 | 定案 | 影响阶段 |
| --- | --- | --- | --- |
| D1 | 默认下载策略 | **组合 A**：SenseVoiceSmall int8（229 MB）+ Whisper Small q8_0（264 MB）= 493 MB 为默认组合；单模型场景用 Whisper Small q8_0 | P1 |
| D2 | SenseVoice 权重许可证 | **接受** FunASR Model License v1.1，分发方式限定为：应用不打包权重，仅按需从官方源下载，并在设置页标注许可证 | P1 |
| D3 | Whisper 存量 f16 迁移 | **升级一键替换 q8**（用户 2026-10-08 修订，覆盖原推荐定案）：升级后检测到旧 f16 时提示一键替换，下载对应 q8 并校验通过后删除旧 f16；失败/取消/校验不通过则保留旧文件，替换完成前旧版仍可用 | P1 |
| D4 | 在线新增顺序 | **火山 Seed-ASR 与 Soniox 并行接入**（用户 2026-10-08 修订，覆盖原推荐定案） | P2 |
| D5 | Gemini Live 去留 | **降为实验项**：保留代码，默认供应商列表中隐藏 | P2 |
| D6 | LLM 清理默认档 | **默认关**，用户手动开启（关/轻/全三档保留） | P3 |
| D7 | 移动端启动时机与形态 | **PC 的 P1/P2 完成后再立项**，移动端形态届时另行设计 | P4 |
| D8 | 基准音频来源 | **混合**：公开数据集（FLEURS/Common Voice）+ 用户自录样本；自录样本仅本地使用、不进仓库 | P0 |
| D9 | 长听写/会议场景 | **维持 PTT 短听写定位**（现 120 秒上限），不做长时转写/会议场景 | 范围 |
| D10 | 国内模型下载源 | **P1 内评估增加国内镜像源**：须同哈希校验、用户显式选择、不静默切换；评估前先核实镜像合法性与稳定性 | P1 |

## 9. 风险与未核实项（实施时不得当作已定事实）

- 火山、讯飞、腾讯、百度的实时 ASR 现行人民币价格未核实（原件 01）；阿里百炼价格来自二手镜像。接入计费相关功能前必须在控制台复核。
- FireRedASR 无任何 CPU 基准，不能列入默认路线，仅可作 P0 对照组。
- 流式 Paraformer 首字延迟的公开数据互相矛盾（0.8–1.6 秒），以 P0 实测为准。
- 微信、Wispr Flow 等应用的具体 ASR 引擎多为未披露/推测（原件 02 已逐项标注），不得引用为选型依据。
- SenseVoice 在西/法/意上无能力，不要用「SenseVoice 多语言」宣传覆盖 8 语种。
