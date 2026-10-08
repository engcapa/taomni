# ASR / Speech-to-Text Market Research — Streaming, Local CPU, Mobile (late 2025 / 2026)

**Context:** Cross-platform desktop app (Windows/macOS/Linux, Tauri/Rust), push-to-talk dictation, wants real-time streaming recognition (recognize while recording), plus possible future mobile apps. Primary languages: Mandarin Chinese + English; mixed Chinese-English speech matters.
**Date accessed:** 2026-10-08 for all sources below unless a page date is stated. Prices are volatile in 2025-26 (multiple vendors cut/re-priced during 2026) — re-check the vendor page before contracting. Flags: **[verified live]** = page fetched directly this run; **[index]** = search-index / secondary source only.

## Summary

- **True streaming is now table stakes** for dedicated STT vendors (Deepgram, AssemblyAI, Soniox, Speechmatics, Gladia, ElevenLabs Scribe v2 Realtime, Google, Azure, AWS, and all five China providers). The historic exception — OpenAI's file/Whisper API — is still batch-only, but OpenAI now has separate realtime models (`gpt-realtime-whisper`, and per its current docs `gpt-live-transcribe` / `gpt-transcribe`) that are materially more expensive per minute.
- **Cheapest published global streaming:** Soniox ~$0.12/hr, AssemblyAI Universal-Streaming $0.15/hr, Speechmatics from ~$0.24-0.40/hr, ElevenLabs Scribe v2 Realtime $0.39/hr, AssemblyAI Universal-3.6 Pro $0.45/hr, Deepgram Nova-3 Multilingual promo $0.348/hr (regular $0.552/hr). Hyperscalers (Google $0.96/hr, Azure $1.00/hr, AWS tier-1 ~$1.44/hr) are 3-10× more expensive.
- **Chinese-first online:** China-domestic APIs win on Mandarin accuracy reputation, dialect coverage, latency from inside China, and RMB price. Alibaba Bailian (DashScope) Paraformer/Fun-ASR realtime is the best-documented at roughly ¥0.86-1.19/hr from a secondary price mirror **[flagged, not official]**; Volcengine Doubao Seed-ASR 2.0 is the other leading candidate but its price could **not** be verified. Among global vendors, Soniox, Deepgram Nova-3 Multilingual and AssemblyAI Universal-3.6 Pro explicitly claim single-model code-switching.
- **CPU-only local:** For Chinese+English, the practical winner is **sherpa-onnx** (Apache-2.0, has a Rust API) running either a *true-streaming* bilingual Zipformer/Paraformer, or SenseVoiceSmall in VAD-chunked pseudo-streaming. In a FunASR-published CPU benchmark, SenseVoiceSmall/Paraformer were ~20× real-time at ~8-10% Mandarin CER, vs whisper.cpp large-v3-turbo at ~3× real-time and ~16-23% CER. whisper.cpp remains the easiest embed and best for English/multilingual, but is weak/slow for Mandarin on CPU.
- **Mobile on-device:** Apple Speech (new `SpeechAnalyzer` in iOS/macOS 26) and Android on-device `SpeechRecognizer` are free and give partials, but are platform-specific, inconsistent, and not available to a Tauri app without native bridges. sherpa-onnx is the only option that reuses the *same* models/code across desktop + Android + iOS.

---

## Findings

### 1. Online Streaming ASR APIs

#### 1a. Global providers

**OpenAI — three different things, do not conflate them**
- *Whisper API / file transcription* (`whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and per current docs the recommended `gpt-transcribe`): HTTP file upload, 25 MB limit, **batch — not streaming**. Streaming *output* of a finished file's transcript is not live-audio streaming. Diarization only via `gpt-4o-transcribe-diarize` (file); word timestamps/SRT only via `whisper-1` (file). [verified live] https://developers.openai.com/api/docs/guides/transcription
- *Realtime API transcription sessions* (WebSocket / WebRTC / SIP): live audio in, text deltas out. Historically used `whisper-1` / `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` as the transcription model inside a session; then `gpt-realtime-whisper` (streaming-optimised, lowest-latency partials); current docs recommend `gpt-live-transcribe` for live and note `gpt-transcribe` for committed-turn transcription over WebSocket. No word timestamps or diarization in the realtime delta stream (per secondary analyses). [verified live for model roles; index for delta limitations]
- *Pricing* [index — official pricing page not directly opened this run, **flag**]: `whisper-1` and `gpt-4o-transcribe` $0.006/min, `gpt-4o-mini-transcribe` $0.003/min, `gpt-realtime-whisper` / `gpt-live-transcribe` $0.017/min. Source: https://costgoat.com/pricing/openai-transcription
- Chinese/English: strong general multilingual reputation, good mixed-language handling via prompt/keywords/languages hints (new models accept a *list* of expected languages — relevant for zh+en). No China data residency; API access from mainland China is not officially supported — see Pitfalls.

**Deepgram (Nova-3 / Flux)**
- Protocol: WebSocket streaming, `interim_results` partials + finals, endpointing/`utterance_end_ms`, smart formatting/punctuation included. Latency marketed ~sub-300 ms for streaming.
- Pricing [verified live] https://deepgram.com/pricing : Streaming PAYG — Nova-3 Monolingual promo **$0.0048/min** (regular $0.0077), Nova-3 Multilingual promo **$0.0058/min** (regular $0.0092); Flux English promo $0.0065, Flux Multilingual $0.0078. Batch Nova-3 Mono $0.0043/min. Add-ons (streaming): diarization +$0.0020/min, keyterm prompting (up to ~100 terms) +$0.0013/min, redaction +$0.0020/min. **$200 free credit, no card.** EU endpoint `api.eu.deepgram.com` for EU residency; US default; on-prem/private-cloud on enterprise.
- Chinese: use Nova-3 *Multilingual* (auto language detection, code-switch handling is a headline feature) or Flux Multilingual. English is still Deepgram's strongest suit; Mandarin is supported but is not its benchmark showcase — test with your own zh-en mixed audio.

**AssemblyAI (Universal Streaming)**
- Protocol: WebSocket `wss://streaming.assemblyai.com/v3/ws` (v2 endpoint retired). Partials as turn events; intelligent endpointing (not silence-only). Current flagship per its pricing doc (updated 2026-09-28): **Universal-3.6 Pro Realtime**; cheaper tiers still sold as Universal-Streaming English / Multilingual. [verified live] https://www.assemblyai.com/llms/pricing.md
- Pricing [verified live]: U-3.6 Pro **$0.45/hr**, Universal-Streaming EN and Multilingual **$0.15/hr**. **Billed on session (WebSocket-open) duration, not audio duration** — idle sockets bill. $50 free credits (its blog also cites a large free streaming allowance — treat the pricing doc's $50 as authoritative, **flag discrepancy**). Streaming diarization +$0.12/hr; keyterms included on U-3.6 Pro (≤100 terms). US and EU endpoints, same price.
- Chinese/code-switching: vendor states streaming supports 32 languages including Chinese and Cantonese, all at the same $0.45/hr, with a single unified multilingual model (no language-routing stage), and cites a 307 ms median time-to-final on Pipecat's open benchmark (vendor-cited) [index] https://www.assemblyai.com/blog/real-time-transcription-code-switches-multilingual-speakers — this is directly relevant to mid-sentence zh↔en switching, but note older Universal-Streaming was English-only; verify the exact model value you send.

**Google Cloud Speech-to-Text (Chirp 3, V2)**
- Protocol: gRPC bidirectional `StreamingRecognize` (also REST sync/batch). Interim results with stability scores, punctuation, diarization, speech adaptation (custom vocabulary), auto language detection. Chirp 3 constraints from secondary sources [index]: ~5-minute per-stream limit (client must rotate streams), recognizers are regional resources (US/EU multi-regions for Chirp). https://github.com/canopyide/canopy/issues/2678
- Pricing [verified live] https://cloud.google.com/speech-to-text/pricing : **V2 standard (incl. Chirp) $0.016/min** for first 500k min/mo, tiering down to $0.010 / $0.008 / $0.004; V2 dynamic batch $0.003/min; V1 $0.016/min with data logging, $0.024 without, 60 min/mo free. Note: some 2025 secondary articles quote dynamic batch at $0.004/min — the live official page says $0.003, use that.
- Chinese: Chirp is a strong multilingual model (100+ languages claimed), zh-CN supported; GCP has no mainland-China region — latency/compliance from China is the issue, not the model.

**Microsoft Azure Speech (+ new MAI models)**
- Protocol: Speech SDK (C#/C++/JS/Python etc.) or WebSocket via SDK, continuous recognition with intermediate results; also containers (connected/disconnected) for on-prem — a differentiator none of the pure-API vendors match cheaply. Features: diarization (conversation transcription), continuous language identification, custom speech models, pronunciation assessment — several are **paid add-ons in realtime** (+$0.30/hr/feature in the rendered locale pricing).
- Pricing [index — Azure page renders prices inconsistently by locale] https://azure.microsoft.com/en-ca/pricing/details/speech/ : Standard realtime **$1.00/hr**, batch $0.18/hr, custom realtime $1.20/hr, 5 audio hrs/mo free (F0). New in Oct 2026 [index]: **MAI-Transcribe-2-Streaming** via Azure Foundry / Realtime-compatible WebSocket, $0.54/hr introductory, 60 languages, first words ~320 ms claimed, ranked highly on Artificial Analysis streaming accuracy — promising but brand-new; verify availability in your region. https://www.marktechpost.com/2026/10/02/microsoft-ai-releases-mai-transcribe-2-streaming-1-real-time-speech-to-text-model-on-artificial-analysis/
- Chinese: zh-CN plus regional variants, and there is an **Azure China (21Vianet) cloud** — the only hyperscaler route that is natively operable inside China (separate account/region, enterprise-oriented).

**AWS Transcribe Streaming**
- Protocol: WebSocket or HTTP/2 bidirectional stream, partial results with stabilization, custom vocabulary, vocabulary filtering, channel identification, PII redaction (add-on), custom language models (add-on). SigV4 auth is the main integration friction from a Rust client.
- Pricing [verified live, partial] https://aws.amazon.com/transcribe/pricing/ : 60 min/mo free for 12 months, 1-second billing, diarization/custom vocab/LID included in standard price. The tier table did not render in text view; the page's worked example prices streaming at **$0.01/min at 2M min/mo volume** (and batch $0.006/min at that volume). Tier-1 (first 250k min) $0.024/min is from secondary sources [index, **flag**] https://brasstranscripts.com/blog/aws-transcribe-pricing-per-minute-2025-better-alternative
- Chinese: zh-CN supported (also zh-TW); generally regarded as solid-but-not-leading accuracy; no China region usable without AWS China (separate, Ningxia/Beijing via NWCD).

**ElevenLabs Scribe (v2 / v2 Realtime)**
- Protocol: Realtime WebSocket API (Scribe v2 Realtime), partials with a claimed ~150 ms latency; batch via REST. Keyterm prompting (≤100 terms), entity detection, diarization (up to 32 speakers claimed for the family), auto language detection / mid-conversation switching, EU data residency option.
- Pricing [index] https://devtoollab.com/blog/best-speech-to-text-apis : **Realtime $0.39/hr, batch $0.22/hr** after a 2026 price cut; keyterm +$0.05/hr, entity detection +$0.07/hr. Earlier launch-era reporting quoted $0.48/hr realtime — **flag: prices moved during 2026, re-check elevenlabs.io/pricing**.
- Chinese: 90+ languages claimed and strong FLEURS/Common Voice claims (vendor), including Chinese; a good global candidate to A/B against Deepgram/Soniox on zh-en audio.

**Speechmatics**
- Protocol: WebSocket realtime (`wss://eu.rt.speechmatics.com/v2/` / global endpoint), partials tunable via `max_delay` (0.7-4 s), realtime diarization included in its comparison materials, custom dictionary up to 1,000 words included. Deployment flexibility is its differentiator: cloud, on-prem containers, and on-device.
- Pricing [index] https://www.speechmatics.com/how-we-compare/openai-alternative : realtime **Standard $0.0067/min ($0.402/hr), Enhanced $0.0117/min ($0.702/hr)**; batch Standard $0.0050/min, newer Melia batch from $0.129/hr; free tier 480 min/mo (240 batch + 240 realtime). New Agent STT (Linden engine) launched at $0.30/hr falling to $0.16/hr at volume [index] https://disrupts.disruptsmedia.com/ai-ml/speechmatics-targets-voice-agent-accuracy-gap-agent-stt — **flag: several overlapping price lines, confirm which engine you are buying.**
- Chinese: 55+ languages including Mandarin; strong on accents/multilingual European+Asian mixes; historically less zh-specialised than China vendors.

**Soniox — the price/code-switching disruptor**
- Protocol: WebSocket realtime (`stt-rt-v5` in aggregator catalogues), token-level outputs, endpointing controls, context (terms/translation terms up to ~8k tokens of context), one-way/two-way live translation in the same call.
- Pricing [verified live] https://soniox.com/pricing : token-based, equivalent to **~$0.12/hr realtime, ~$0.10/hr async**; vendor FAQ says diarization, language ID and smart formatting are **bundled, no add-on fees**; regional deployment for data residency.
- Chinese: one unified model for 60+ languages with *seamless mixed-language recognition* as its core claim — architecturally ideal for zh-en code-switching on paper. Smaller vendor than Deepgram/Google: diligence on longevity/SLA is warranted, and its $0.12/hr makes it cheap to trial.

**Gladia (Solaria)**
- Protocol: REST + WebSocket, partials claimed <103 ms, finals ~270 ms (vendor). Solaria-1: 100+ languages, native code-switching, custom vocabulary, diarization. Solaria-3 is optimised for European real-world audio (EN/FR/DE/ES/IT) — less relevant for zh-first use.
- Pricing [index, official site] https://www.gladia.io/product/audio-intelligence : Starter async $0.61/hr, **realtime $0.75/hr**, €50 free credits; Growth realtime reportedly as low as $0.25/hr [index]. EU/US infrastructure, GDPR posture is a selling point.
- Chinese: supported in Solaria-1's 100+ languages, but Gladia's benchmark strength is European languages — not a zh-first pick.

**Rev AI**
- Protocol: WebSocket streaming API exists (plus async), custom vocabulary, forced alignment, language ID; historically batch/async-first and English-accuracy-first (Reverb models, trained on human-verified data).
- Pricing: **could not be verified for streaming this run — flag.** Sources conflict: an API catalogue cites Reverb Turbo from $0.10/hr and 5 hrs free [index] https://github.com/api-evangelist/rev-ai , while older Rev pages quote $0.035/min ($2.10/hr). Do not budget Rev without a fresh quote. Chinese support is not its headline strength; low priority for this app unless English legal/media accuracy is needed.

#### 1b. China providers (all: WebSocket streaming, Mandarin-first, RMB billing, mainland-China data residency by default)

General pattern: all five require a China cloud account (real-name verification; overseas entities may need a China entity or an international-site account with reduced model access), docs/SDKs are primarily in Chinese, and keys are AppID/AppKey/Secret-style rather than a single bearer token. All are easily reachable at low latency from inside mainland China — the inverse of the global vendors (see Pitfalls).

**Alibaba Cloud — Intelligent Speech Interaction (ISI) + Bailian/DashScope (the modern path)**
- Two stacks: (1) classic ISI: realtime ASR over WebSocket (text control messages + binary audio), recording-file recognition over REST, hotwords/self-learning, punctuation/ITN; (2) **Bailian (Model Studio) / DashScope**, now the strategic path: `paraformer-realtime-v2`, `fun-asr-realtime` (Fun-ASR), and `qwen3-asr-flash-realtime` over DashScope WebSocket (`run-task` / binary PCM / `result-generated` partials+finals, word-level timestamps in Paraformer output). Tongyi Tingwu (通义听悟) sits above this as a meeting/transcription *product* API — useful for offline meeting files, not the low-level dictation primitive.
- Pricing: classic ISI list price in international materials ~$1.40/hr [index, weak source, **flag**]. Bailian per-second prices from a secondary price mirror [index, **not official — flag**] https://api.oceanleo.com/v1/models/pricing-doc/bailian/pdf : `paraformer-realtime-v2` **¥0.00024/s (= ¥0.864/hr)**, `fun-asr-realtime` / `qwen3-asr-flash-realtime` **¥0.00033/s (= ¥1.188/hr)**, offline `paraformer-v2` ¥0.00008/s. Even if the mirror is off by a tier, this is an order of magnitude below hyperscaler USD prices. Verify in the Bailian console before budgeting.
- Chinese: Paraformer/Fun-ASR is Alibaba DAMO's own zh-first family (Mandarin + dialects incl. Cantonese/Wu/Min in multi-language variants, plus English/Japanese/Korean in mtl variants) — see §2 for the same models running locally. Hotwords and custom language models supported.

**Volcengine / ByteDance — Doubao Speech (火山引擎豆包语音)**
- Protocol: WebSocket with a **custom binary framing protocol** (4-byte header, gzip-compressed JSON payloads) to `openspeech.bytedance.com` — more Rust implementation work than a plain JSON WebSocket (budget 1-2 hundred lines for framing; open-source Rust/Go references exist in community dictation apps). Modes: `bigmodel_async` (bidirectional streaming, returns only on change — best latency), `bigmodel` (legacy bidirectional), `bigmodel_nostream` (streaming input, one final result — best accuracy, accepts a language parameter). Current model: **Seed-ASR 2.0** (`volc.seedasr.sauc.duration` / `.concurrent`); legacy BigASR 1.0 (`volc.bigasr.*`). Auto-detection covers Mandarin, English and several dialects (Shanghainese, Minnan, Sichuanese, Shaanxi, Cantonese) in nostream mode. Hotwords: tables up to 2,000 terms, weighted. [index] https://github.com/melody0709/voxtype/blob/HEAD/volcengine_asr_guide.md
- Pricing: **could not verify — flag.** Volcengine sells duration-based and concurrency-based resource packages; no public per-hour figure was retrievable this run. Historically Doubao speech has been priced aggressively (the line of business that powers Douyin/Doubao dictation), but do not quote a number without the console.
- Chinese: arguably the strongest *product* pedigree for consumer Mandarin dictation (same stack as Doubao app input) and zh-en mixing; this and Alibaba are the two to benchmark head-to-head.

**Tencent Cloud ASR (实时语音识别)**
- Protocol: WebSocket realtime recognition (signed URL), plus one-sentence recognition (≤60 s, HTTP/WebSocket), recording-file recognition, and a newer large-model engine variant. Partials, punctuation, hotwords (`hotword_id` / temporary hotword lists), speaker separation on file jobs, many dialect engines (Mandarin, Cantonese, plus dialect-accented Mandarin engines).
- Pricing: current RMB list **not verified this run — flag**. Tencent Cloud International's billing PDF [index, dated 2022-07-06] lists realtime at **$1.40/hr** for 0-299 hrs/day tiering down to $0.70/hr at ≥5,000 hrs/day: https://main.qcloudimg.com/raw/document/intl/product/pdf/tencent-cloud_1118_43341_en.pdf . Domestic RMB pricing is structured similarly (per-hour tiers + prepaid packages) but must be re-checked on cloud.tencent.com.
- Chinese: very strong Mandarin + Cantonese/dialect coverage, WeChat-ecosystem pedigree; English adequate. Free quota commonly reported for one-sentence ASR (~5,000 calls/month in community docs — **flag, unverified officially**).

**iFlytek 讯飞 (xfyun)**
- Protocol: two relevant services — **语音听写 IAT** (short-form streaming dictation, WebSocket `wss://iat-api.xfyun.cn/v2/iat`, 40 ms / 1,280-byte frames, dynamic correction for Chinese — partials can revise) and **实时语音转写 RTASR** (long-form realtime transcription, WebSocket, PCM 16 kHz mono, sessions up to 5 hrs, speaker separation in the large-model variant). [index, official global docs] https://global.xfyun.cn/doc/rtasr/rtasr/API.html
- Pricing: **RTASR RMB duration price not verified — flag.** iFlytek's open platform historically sells duration packages for RTASR and per-call packages for IAT; a secondary catalogue quotes short-form ASR at $1.40/1,000 calls on the global platform [index]. Community docs cite ~500 free calls/day for IAT — **flag**.
- Chinese: the traditional Chinese-ASR champion — Mandarin, 20+ dialects, and zh-en mixed dictation are its home turf; also strong on domain customization for government/medical/legal Chinese. English noticeably secondary to its Chinese engines.

**Baidu AI Cloud (百度智能云语音)**
- Protocol: realtime speech recognition over WebSocket (recommended ~160 ms chunks, interim + final results), short-speech recognition over HTTP (≤60 s), long-file and call-analysis products. Language models via `dev_pid` (Mandarin, English, Cantonese, Sichuanese variants).
- Pricing: **not verified — flag.** Baidu bills short speech per call (with large free quotas for certified personal accounts reported in community docs) and realtime by duration/packages; no current official figure was retrievable in English or Chinese search this run.
- Chinese: solid Mandarin (search-ecosystem data), decent dialects; generally considered a step behind Volcengine/Alibaba/iFlytek for dictation accuracy in recent community comparisons — those comparisons are anecdotal, benchmark it yourself if considering Baidu.

---

### 2. Local / Self-Hosted, No GPU (CPU-only)

**Key distinction — true streaming vs pseudo-streaming**
- *True streaming:* the model consumes audio chunk-by-chunk with limited lookahead and emits monotonic partials (streaming Zipformer/Paraformer, Vosk, Moonshine Streaming, streaming Conformer/Transducer). Latency ~150-800 ms, partials rarely rewrite.
- *Pseudo-streaming:* an offline model (Whisper, SenseVoice, Parakeet, FireRedASR) is re-run over a growing window or over VAD-cut segments (Whisper's LocalAgreement policy is the formal version). Simpler, often more accurate per segment, but partials flicker/rewrite, latency is 1-3 s, and CPU cost multiplies if you re-decode naively. For push-to-talk dictation with utterances of a few seconds, well-tuned pseudo-streaming (VAD endpoint → one decode) is often *good enough* and is what most shipped dictation apps actually do.

| Engine / model | Size | CPU speed (documented) | Streaming | zh / zh-en | License | Tauri/Rust embedding |
|---|---|---|---|---|---|---|
| **sherpa-onnx** — streaming Zipformer bilingual zh-en | int8 ~65-250 MB depending on variant | Real-time on 1-2 threads typical for transducer models of this class (exact RTF varies by model — **flag: no single canonical bench**) | **True** (160 ms chunks) | zh+en bilingual model exists specifically | Apache-2.0 | **Best in class:** C API + official **Rust API examples incl. streaming zh-en and microphone streaming** [index] https://github.com/k2-fsa/sherpa-onnx/blob/HEAD/rust-api-examples/README.md |
| **sherpa-onnx** — streaming Paraformer (zh / zh-yue-en trilingual) | ~200-900 MB by variant | Real-time on modern CPU | **True** (~600 ms chunks) | Excellent zh, Cantonese variant | Apache-2.0 (runtime); model license per checkpoint | Same as above |
| **SenseVoice / SenseVoiceSmall** (via sherpa-onnx, FunASR, or GGUF/llama.cpp runtimes) | 234M params; ~449 MB f16, ~228 MB class int8/ONNX | **~20× RT** (8 threads, FunASR bench) | Offline — pseudo via VAD chunks (very fast per chunk, so perceived latency is low) | **Excellent:** zh/yue/en/ja/ko in one model, plus emotion/event tags + ITN in FunASR form | Code MIT; **weights under FunASR Model License v1.1 (non-SPDX) — legal check before bundling** [index] | Via sherpa-onnx Rust API (offline recognizer) — easy; avoid the Python FunASR stack in the app |
| **FunASR + Paraformer-large** (native Python) | 220M params | **~21× RT** (Paraformer, FunASR bench); streaming variant chunk presets 480/600/720 ms | **True** streaming model (`paraformer-zh-streaming`) + FSMN-VAD + CT-Transformer punctuation as separate models | Excellent zh; en weaker than zh | MIT (toolkit) / model license for checkpoints | **Poor natively:** Python + PyTorch sidecar (~GBs). Use the *models* via sherpa-onnx/GGUF instead of the toolkit |
| **whisper.cpp** (ggml) | tiny 75 MB → large-v3 3.1 GB; large-v3-turbo (809M) ~1.6 GB f16, ~0.8 GB q8 | FunASR bench (8 thr): base 9.9×, small 4.6×, **large-v3-turbo 3.2× RT**; other benches show turbo falling to ~1-2× on weaker/older CPUs and <1× for full large-v3 | Offline — pseudo (its stream example uses sliding-window/LocalAgreement-style re-decode) | **Weak spot:** Mandarin CER 16-23% in the FunASR bench vs 8-10% for FunASR models (vendor-side bench — directionally consistent with community experience, exact gap **flagged as vendor-published**) | MIT | **Easiest embed overall:** C/C++ core, `whisper-rs` Rust bindings, Metal/Vulkan/CoreML acceleration paths, tiny footprint, no Python |
| **distil-whisper** (via whisper.cpp / faster-whisper) | distil-large-v3 ~756M, ~0.6-1.5 GB by quant | Faster than large-v3 at similar EN WER | Offline/pseudo | **English-only (distil family)** — disqualifies it as sole zh engine | MIT | Same runtimes as Whisper |
| **faster-whisper** (CTranslate2) | Same Whisper checkpoints, int8 | On an older 6C/12T i7, int8 [index] https://github.com/pbnz/watch-local/issues/34 : tiny 25×, base 15×, small 5.6×, medium 2.0×, **large-v3 0.57× (slower than RT)**; ~4× less memory than HF Whisper on GPU | Offline/pseudo (chunked transcription helpers, no native streaming decoder) | Same Whisper zh weakness as above | MIT | **Python-only** — in Tauri this means a bundled Python/CTranslate2 sidecar; workable, heavy. No Mac GPU path (CPU only on Apple Silicon) |
| **OpenAI Whisper (original, PyTorch)** | 39M-1.55B params | Slowest mainstream option on CPU; large models expect GPU (~10 GB VRAM fp16 class) and still process in 30 s windows | Offline only | As whisper.cpp | MIT | Do not embed — superseded by whisper.cpp/faster-whisper in every deployment dimension |
| **Vosk** (Kaldi) | Small models ~40-50 MB; large zh model ~1.3 GB class | Faster than RT even on Raspberry Pi-class hardware | **True** streaming, zero-latency partials, reconfigurable vocabulary | zh model exists; accuracy is a generation behind neural E2E models | Apache-2.0 | C API + Rust bindings exist; tiny footprint. Only choose for very low-end hardware / wake-word-style use |
| **Moonshine** (Useful Sensors / Moonshine AI) | Tiny 27M (~50-110 MB), Base 61M (~120-245 MB); Streaming Tiny/Small/Medium 34M/123M/245M | Designed for edge: claims 5-15× faster than Whisper equivalents on CPU; streaming latency ~150-250 ms in comparisons [index] | **True** streaming in v2/Streaming family (sliding-window ergodic encoder) | **Critical caveat:** original + streaming models are **English-only under MIT**; multilingual models (incl. a Mandarin variant in the newer family) are under a **non-commercial Community License** — **flag: verify the exact checkpoint's license before shipping zh Moonshine** | MIT (EN) / Community (multilingual) | ONNX/C++ core, sherpa-onnx support, transcribe.cpp ports — embeddable, but zh licensing blocks the obvious use here |
| **NVIDIA Parakeet TDT 0.6B v2/v3 + Canary** | 0.6B; int8 ONNX ~450-670 MB disk, ~2 GB RAM | Parakeet ONNX CPU: ~30× RT claimed for batch in community runtimes; one careful bench: batch 60× / streaming-mode 6× on int8 CPU [index] https://github.com/weblate/myna/blob/HEAD/parakeet-snap/README.md | Offline/TDT chunked (cache-aware streaming variants exist in NeMo, not in the easy ONNX ports) | **No Chinese:** v2 = English only, v3 = 25 *European* languages. Canary (1B) = en/de/es/fr (+translation), also no zh | CC-BY-4.0 (checkpoints — verify per release) | ONNX via sherpa-onnx / parakeet-rs — easy embed, excellent EN engine, **irrelevant as sole engine for zh-en**; NeMo/PyTorch originals are GPU-oriented and heavy |
| **FireRedASR / FireRedASR2** (Xiaohongshu) | AED-L 1.1B params; LLM variant 8.3B (impractical on CPU desktop) | CPU RTF **unverified — flag**; AED is a conformer AED designed for efficiency, sherpa-onnx export exists (`fire-red-asr-large-zh_en`) | Offline | **Best open Mandarin CER on paper:** AED-L 3.18% avg, LLM 3.05% across public Mandarin sets, strong dialects + competitive English [index] https://export.arxiv.org/pdf/2501.14350 | Apache-2.0 | PyTorch original is a sidecar; sherpa-onnx route is the embeddable one. Candidate for a *high-accuracy offline re-decode / final pass*, not first-partial streaming |
| **WhisperKit / Argmax OSS** (Apple Silicon special case) | large-v3-turbo CoreML ~632 MB compressed (0.6-3.1 GB range) | ANE: near-peak utilisation, per-word hypothesis ~0.45 s / confirmed ~1.7 s in evaluations [index] https://github.com/riox432/live-translate/blob/HEAD/docs/research/whisperkit-evaluation.md | Pseudo-streaming done well (LocalAgreement) | Inherits Whisper zh quality (mediocre, see above) | MIT | **Swift-only** — not usable from Tauri/Rust directly except via a Swift sidecar/helper app on macOS; on plain CPU (no ANE) this advantage disappears. Also consider Apple's own SpeechAnalyzer on macOS 26 (see §3) |

**Practical ranking for CPU-only desktop, zh+en dictation (this app):**
1. **sherpa-onnx + streaming bilingual Zipformer** if you need genuine low-latency partials today, in Rust, one codebase for desktop+mobile.
2. **sherpa-onnx + SenseVoiceSmall (VAD-chunked pseudo-streaming)** if push-to-talk utterances are short and final accuracy matters more than word-by-word partials — best zh accuracy/speed/size tradeoff; add a streaming Zipformer for live partials and SenseVoice for the final pass if you want both (a pattern several shipped dictation apps use).
3. **sherpa-onnx + streaming Paraformer** — middle ground: true streaming, zh-first, punctuation model available separately.
4. **whisper.cpp (base/small for live, large-v3-turbo q8 for final)** — if English/multilingual breadth and embed simplicity outrank Mandarin accuracy; expect to notice the zh quality gap.
5. **faster-whisper (small/medium int8)** — only if you are already shipping a Python sidecar.
6. Vosk / Moonshine (EN) / Parakeet (EN/EU) — niche or English-only fallbacks, not zh-en primaries.

### 3. Mobile On-Device ASR

| Option | Streaming partials? | Chinese | Size / cost | Notes |
|---|---|---|---|---|
| **Apple Speech framework — legacy `SFSpeechRecognizer`** | Yes (partial results) | zh-CN/zh-TW among many locales; on-device only where the locale supports `requiresOnDeviceRecognition` — check `supportsOnDeviceRecognition` per locale at runtime | Zero app size (OS models, downloaded by iOS), free, no quota for on-device | Short-utterance oriented historically; server fallback is silent unless you force on-device — force it if you promise privacy. Quality is dictation-grade, not Whisper-large grade. |
| **Apple Speech — new `SpeechAnalyzer` / `SpeechTranscriber` (iOS/macOS 26)** | Yes — volatile (partial) + final results via AsyncSequence | Chinese included in the supported-language lists found [index]; counts conflict (10+ core vs ~30 locales) — enumerate `SpeechTranscriber.supportedLocales` at runtime, **flag** | OS-managed model downloads, free; runs out-of-process (no app memory cap issue), claimed ~2.2× faster than Whisper Large V3 Turbo in secondary write-ups [index] https://github.com/bsreeram08/chowser/blob/HEAD/.agents/skills/swift-SpeechAnalyzer-Framework-Expert/README.md | The best iOS-native path going forward, but iOS 26+ only, Apple-platforms only, and early framework bugs have been reported by integrators. No diarization. |
| **Android `SpeechRecognizer` (Google on-device)** | Yes — `EXTRA_PARTIAL_RESULTS` → `onPartialResults` | zh support depends on the device's downloaded language pack / OEM recognizer; must check `isOnDeviceRecognitionAvailable()` (API 31+) and use `createOnDeviceSpeechRecognizer()` | Zero app size, free | **Highly inconsistent across OEMs:** the default `createSpeechRecognizer()` may go to the network; `EXTRA_PREFER_OFFLINE` can be ignored; endpointing/partial cadence are unspecified [index] https://dev.to/roronoa_/keep-platform-speech-recognition-on-device-on-your-first-mobile-ai-pr-65g . Many Chinese Android phones ship a different (vendor) recognizer or none — do not rely on this as your sole China-Android path. Samsung/Google devices are the reliable subset. |
| **sherpa-onnx on Android/iOS** | Yes — same streaming Zipformer/Paraformer as desktop; offline SenseVoice etc. also packaged for mobile | Same bilingual zh-en models as desktop — **best cross-platform zh story** | Model adds ~50-250 MB (int8 streaming models at the low end); Apache-2.0; official Android (Kotlin/Java) and iOS (Swift) examples, Flutter bindings exist in the ecosystem | Battery: small transducers are phone-friendly (this family was designed for embedded); CPU-only, no NPU acceleration in the standard build. You own model downloads/updates. |
| **whisper.cpp on mobile** | Pseudo-streaming only | Same mediocre zh as desktop | App + model: base ~140 MB, small ~470 MB, turbo ~800 MB+ (quantised) | Works on modern flagships; sustained large-model use heats/throttles phones. Sensible only at tiny/base/small size on mobile, which further hurts zh. |
| **Moonshine on mobile** | Yes (Streaming family) | See §2 licensing caveat — EN MIT, multilingual non-commercial | Tiny ~50 MB class, designed for Raspberry Pi / low-cost phones, very low battery draw | Excellent for English voice commands on cheap hardware; zh blocked by license for a commercial app unless a commercial licence is negotiated (**flag**) |
| **Picovoice Leopard (offline) / Cheetah (streaming)** | Cheetah: yes; Leopard: no | **No Chinese in the public Cheetah language list** found [index, official docs] https://picovoice.ai/docs/cheetah/ (lists EN/FR/DE/IT/PT/ES, with JA/KO appearing in a header list — discrepancy **flagged**); other languages are enterprise-only | Tiny proprietary models, commercial licence; free tier is limited and paid tiers reported from ~$999/mo class pricing (older launch reporting) — **current pricing not verified, flag**; requires an AccessKey (licence check, not fully offline-sovereign) | Official Flutter + React Native SDKs are a genuine plus. RU/Flutter implication: easiest *supported* mobile SDK here — but no zh kills it for this app. |
| **Cloud streaming from mobile (alternative)** | Yes — same §1 APIs | Same as §1 (best zh: Volcengine/Alibaba from China; Soniox/Deepgram globally) | Zero model size; per-minute cost as §4; needs network | Simplest path for a Flutter/RN app: record PCM/Opus, open one WebSocket, render partials — no native ASR code at all. Costs battery for radio, fails offline, and sends audio off-device (privacy/China-cross-border considerations). |

**Flutter / React Native implications:** Neither framework changes ASR quality — the choice is *which native layer you bridge to*. (1) Platform speech (Apple/Android above) via plugins is the least code but the least consistent, and partial-result behaviour differs per platform. (2) sherpa-onnx has maintained mobile bindings and is the only way to ship *identical* zh-en behaviour on Android+iOS (+desktop). (3) Cloud WebSocket is framework-agnostic pure Dart/JS — fastest to build, and the natural v1 if mobile is secondary. For a Tauri/Rust team, a shared Rust core (sherpa-onnx Rust API on desktop; via UniFFI/C-ABI into mobile shells) is architecturally coherent in a way a Swift+Kotlin platform-speech split is not.

### 4. Synthesis

#### 4a. Comparison table — top online streaming APIs (PAYG list prices, accessed 2026-10-08)

| Provider / model | Protocol | Partials | Price (streaming) | $ / 1,000 min | zh-en code-switch | Diarization | Hotwords | Region / China access |
|---|---|---|---|---|---|---|---|---|---|
| Soniox stt-rt | WebSocket | Yes | ~$0.12/hr | **$2.00** | One model, mixed-lang is core claim | Included | Context terms included | Regional deployment offered; US/EU-centric, poor from China |
| AssemblyAI Universal-Streaming Multilingual | WebSocket | Yes (turns) | $0.15/hr (session time) | **$2.50** | Yes (unified model tier) | +$0.12/hr | Included (multilingual tier) | US/EU; poor from China |
| Speechmatics Realtime Standard | WebSocket | Yes (tunable delay) | $0.0067/min | $6.70 | Multilingual packs | Included (per vendor comparison) | 1,000-word dictionary included | EU/global endpoints; on-prem option; poor from China |
| ElevenLabs Scribe v2 Realtime | WebSocket | Yes (~150 ms claimed) | $0.39/hr | $6.50 | Auto-detect + switching | Yes | +$0.05/hr (keyterm) | US/EU residency; poor from China |
| AssemblyAI Universal-3.6 Pro Realtime | WebSocket | Yes (~307 ms median final, vendor/Pipecat) | $0.45/hr (session time) | $7.50 | **Yes — 32 langs, single model** | +$0.12/hr | Included ≤100 | US/EU; poor from China |
| Deepgram Nova-3 Multilingual | WebSocket | Yes (~<300 ms marketed) | $0.0058/min promo / $0.0092 regular | $5.80 / $9.20 | Yes (Multilingual/Flux Multi) | +$0.0020/min | +$0.0013/min (keyterm) | US + EU endpoint; poor from China |
| OpenAI gpt-live-transcribe / gpt-realtime-whisper | WebSocket/WebRTC (Realtime) | Yes (deltas) | $0.017/min [index] | $17.00 | Prompt + language list hints | No (realtime) | Keywords hint | US; **not officially available in China** |
| Google Chirp 3 (STT V2) | gRPC bidi | Yes | $0.016/min | $16.00 | Auto-detect, multi-lang recognizers | Yes | Speech adaptation | US/EU multi-region; no mainland region |
| Azure Speech Standard (+ MAI Streaming $0.54/hr) | SDK / WebSocket | Yes | $1.00/hr | $16.67 | Continuous LID add-on | Add-on +$0.30/hr/feature | Custom Speech | Many regions **incl. Azure China (separate cloud)** |
| AWS Transcribe Streaming | WebSocket / HTTP/2 | Yes (stabilized partials) | ~$0.024/min tier-1 [flag]; $0.01/min at 2M min/mo example | $24.00 / $10.00 at volume | Language ID included | Included | Custom vocab included; CLM add-on | Regional; AWS China separate |
| **Alibaba Bailian Paraformer-realtime-v2** | WebSocket (DashScope) | Yes + word timestamps | ¥0.00024/s [flag, secondary mirror] | **¥14.40 (~$2)** | zh-first, dialects + en in mtl variants | On file/meeting products | Hotwords / custom LM | **China-native (Beijing/Singapore/US nodes)** |
| **Alibaba Bailian Fun-ASR / Qwen3-ASR realtime** | WebSocket (DashScope) | Yes | ¥0.00033/s [flag, secondary mirror] | **¥19.80 (~$2.80)** | zh-first LLM-ASR family | — | Hotwords | China-native |
| **Volcengine Seed-ASR 2.0** | WebSocket (binary protocol) | Yes (`bigmodel_async`) | **Not verified — flag** | — | Auto zh/en/dialects | On file products | ≤2,000 weighted terms/table | **China-native** |
| **Tencent Cloud Realtime ASR** | WebSocket | Yes | $1.40/hr intl PDF (2022) [flag — old] | $23.30 (2022 figure) | zh + dialects, en | File jobs | Hotwords | **China-native** + intl site |
| **iFlytek RTASR / IAT** | WebSocket | Yes (dynamic correction, zh) | **Not verified — flag** | — | zh-first, dialects | RTASR large-model variant | Customisation | **China-native** + Singapore node (global platform) |

#### 4b. Comparison table — top CPU-only local engines

| Engine | Streaming type | zh quality signal | CPU speed signal | Size | License | Rust/Tauri fit | Rank for this app |
|---|---|---|---|---|---|---|---|
| sherpa-onnx streaming Zipformer zh-en | True | Good (purpose-built bilingual) | RT on few threads | ~65-250 MB int8 | Apache-2.0 | Native Rust API | **1 (live partials)** |
| sherpa-onnx SenseVoiceSmall | Pseudo (VAD chunk) | CER ~7.8-8.2 (FunASR bench) | ~20× RT | ~228-449 MB | Model license v1.1 — check | Rust API (offline) | **1 (final accuracy)** |
| sherpa-onnx / FunASR Paraformer streaming | True (~600 ms) | CER ~9.9-10.2 (offline large, same bench) | ~21× RT (offline large) | ~200-900 MB | MIT / model license | Rust via sherpa; Python native is heavy | 2 |
| whisper.cpp large-v3-turbo | Pseudo | CER ~16-23 (same bench) | ~3.2× RT (8 thr) | ~0.8-1.6 GB | MIT | Easiest (whisper-rs) | 3 (EN/multilingual first) |
| faster-whisper small/medium int8 | Pseudo | Same Whisper zh limits | 5.6× / 2.0× on older i7 | ~0.5-1.5 GB | MIT | Python sidecar only | 4 |
| FireRedASR-AED (sherpa export) | Offline | CER 3.18 (paper, Mandarin sets) | Unverified on CPU | ~1.1B params | Apache-2.0 | Via sherpa-onnx | Final-pass candidate |
| Parakeet TDT 0.6B v3 (ONNX) | Chunked | **No Chinese** | ~30-60× RT batch | ~0.45-0.67 GB | CC-BY-4.0 | Easy (ONNX) | EN/EU only |
| Moonshine Streaming | True | EN only (MIT) | Edge-optimised | 50-500 MB | MIT (EN) | ONNX/C++ | EN only |
| Vosk | True | Dated | RT on Pi-class | 50 MB-1.3 GB | Apache-2.0 | C/Rust bindings | Low-end fallback |

#### 4c. Recommendations by scenario

- **(a) Best Chinese-first online streaming:** **Volcengine Seed-ASR 2.0 (`bigmodel_async`) and Alibaba Bailian (`fun-asr-realtime` / `paraformer-realtime-v2`) — benchmark both, pick on your own zh-en recordings.** Volcengine has the consumer-dictation pedigree; Alibaba has the more transparent (if secondary-sourced) pricing, word timestamps, and the unique advantage that *the same Paraformer/Fun-ASR family runs locally via sherpa-onnx* — one vocabulary/hotword strategy online and offline. iFlytek RTASR is the third candidate, especially for dialect-heavy users. Budget the extra Rust work for Volcengine's binary WebSocket framing.
- **(b) Best global / English-first online streaming:** **Deepgram Nova-3 Multilingual** for maturity, latency, docs and predictable per-minute pricing (start on the promo multilingual rate; add diarization/keyterm only if needed); **Soniox** as the aggressive challenger — cheapest by far, code-switching-first design, bundled diarization — trial it in parallel, its per-1,000-min cost ($2) is ~⅓ of Deepgram's. AssemblyAI U-3.6 Pro is the pick if you specifically want its turn/endpointing model and EU endpoint, and can discipline WebSocket session lifetimes.
- **(c) Best privacy/offline CPU desktop:** **sherpa-onnx, dual-model pattern:** streaming bilingual Zipformer for live partials + SenseVoiceSmall for the final transcript on endpoint (VAD). All-Rust, Apache-2.0 runtime, ~300-700 MB total model download, no Python, no per-minute cost, works in China and offline. Resolve the SenseVoiceSmall model-license question before bundling; if it fails legal review, fall back to streaming Paraformer (final) + Zipformer (partials). Ship whisper.cpp large-v3-turbo as an optional download for users whose speech is primarily English/other languages.
- **(d) Best mobile on-device:** **sherpa-onnx again** — the same streaming zh-en model on Android and iOS is the only consistent, China-Android-safe, licence-clean option. Use Apple `SpeechAnalyzer` (iOS 26+) as an optional zero-download iOS accelerator where available, and treat Android platform `SpeechRecognizer` as an opportunistic fallback only, never the primary. If mobile v1 must ship fast, stream to your chosen cloud API (Volcengine/Alibaba for China users, Soniox/Deepgram elsewhere) and add on-device later behind the same transcript UI.

#### 4d. Pitfalls

- **OpenAI Whisper API is NOT true streaming.** `whisper-1` / `gpt-4o-transcribe` file transcription returns results after upload; chunking files and transcribing pieces is pseudo-streaming with seconds of latency and boundary errors. True OpenAI streaming lives in the Realtime API with different models (`gpt-realtime-whisper`, now `gpt-live-transcribe` per current docs), different events (text deltas, no word timestamps/diarization), and a ~2.8× price premium ($0.017 vs $0.006/min). Any design that assumes Whisper-API streaming will need rework.
- **Session-time vs audio-time billing.** AssemblyAI (and Soniox's token model, Deepgram's voice-agent tier) bills WebSocket-open time. A push-to-talk app that keeps a warm socket open all day can bill 10-50× its actual speech minutes. Open per-utterance (with fast reconnect) or aggressively idle-timeout sockets — and conversely, Alibaba/Tencent-style per-audio-second billing punishes silence *inside* an utterance less than it punishes long recordings.
- **China network/access for overseas APIs.** OpenAI does not list mainland China as a supported API country; Google Cloud, Deepgram, AssemblyAI etc. have no mainland points of presence — expect high/variable latency, occasional blocking, and cross-border data-transfer compliance exposure (PIPL) if you stream Chinese users' voice to US/EU endpoints. The symmetric problem: China-vendor accounts typically require real-name / China payment methods and Chinese-language consoles. A dual-region architecture (China vendor inside China, global vendor outside) is the norm for apps with users on both sides.
- **Vendor lock-in is mostly in the *customisation* layer.** Raw WebSocket PCM-in/text-out is portable; hotword formats, diarization schemas, endpointing semantics, prompt/context mechanisms and (for Volcengine) binary framing are not. Keep a provider trait in Rust from day one (this app's Tauri core is the right place), store transcripts in a provider-neutral format, and don't let provider-specific partial-revision semantics leak into the editor UI.
- **Partial-result semantics differ.** Some engines emit monotonic partials (streaming transducers), some revise freely (iFlytek dynamic correction, Whisper LocalAgreement, AssemblyAI turn events are immutable-by-design). Dictation UX (where text is inserted into another app) tolerates revision badly once text is committed — design a commit boundary (only insert *final* segments into the target app; show partials only in your own overlay).
- **Benchmarks are vendor-flavoured.** The FunASR-vs-whisper.cpp CER gap, Deepgram's streaming WER reduction, AssemblyAI's Pipecat ranking, Soniox's price comparisons and ElevenLabs' FLEURS claims are all published by an interested party. They are directionally useful; none substitutes for a 30-minute test set of *your* users' zh-en mixed dictation run through every shortlisted API.
- **Cost at scale (per 1,000 minutes of *speech*, PAYG list, excl. add-ons):** Soniox $2.00 · Alibaba Bailian Paraformer ~¥14.4 (≈$2, flagged source) · AssemblyAI Universal-Streaming $2.50 · Deepgram Nova-3 Multi $5.80 promo ($9.20 regular, +$2.00 diarization) · Speechmatics Standard $6.70 · ElevenLabs Realtime $6.50 · AssemblyAI U-3.6 Pro $7.50 · Google Chirp $16.00 · Azure $16.67 · OpenAI Realtime $17.00 · AWS ~$24 tier-1 (~$10 at 2M-min volume). At dictation scale this is rarely the deciding factor — 1,000 min is ~16.7 hours of actual talking, i.e. weeks of heavy dictation per user — but for meeting-transcription volumes (100× dictation) the Soniox/Alibaba-vs-hyperscaler gap becomes a 5-10× budget line. Local sherpa-onnx is $0 marginal at any scale, paid for in model-download size and CPU/battery.

## Could not verify

- **Volcengine, iFlytek RTASR, and Baidu realtime RMB pricing** — no current official per-hour/duration price was retrievable; only billing *mechanisms* (duration vs concurrency packages; per-call packages) are documented in the sources found. Get console quotes.
- **Tencent Cloud current RMB realtime price** — only a 2022-dated international PDF ($1.40/hr tiered) was found; domestic pricing has likely changed.
- **Alibaba Bailian per-second prices** — from a secondary price-mirror PDF, not Alibaba's own page (which did not render); treat ¥0.00024/s (Paraformer realtime) and ¥0.00033/s (Fun-ASR/Qwen realtime) as indicative, not contractual.
- **OpenAI official per-minute prices** — taken from aggregators that agree with each other ($0.006 whisper-1/gpt-4o-transcribe, $0.003 mini, $0.017 realtime-whisper/live); OpenAI's own pricing page was not directly opened this run.
- **AWS Transcribe tier-1 streaming rate** ($0.024/min) — secondary source; AWS's official page's tier table did not render in text view (its worked example at 2M min/mo = $0.01/min streaming *was* verified live).
- **Azure Speech prices** — the official page rendered prices for one locale ($1/hr realtime) and blanks for others; MAI-Transcribe-2-Streaming $0.54/hr is from launch coverage, marked introductory through end-2026.
- **Rev AI streaming price** — sources conflict by >10× ($0.10/hr catalogue vs $0.035/min legacy page); excluded from cost calculations.
- **Speechmatics current realtime price line** — overlapping Standard/Enhanced per-minute, Melia per-hour, and Agent-STT per-hour figures coexist across its pages; confirm the engine/price pair.
- **Picovoice current pricing and Cheetah Chinese availability** — free-tier limits conflict across sources (5 hrs/mo vs 100 hrs), paid tiers appear enterprise-priced (~$999/mo class, older reporting), and its docs' language lists conflict and do not clearly include Chinese.
- **Moonshine multilingual (Mandarin) licensing** — English models are MIT; multilingual models are described as Community (non-commercial) licensed in secondary sources; the exact Mandarin streaming checkpoint's licence must be checked on its model card before commercial use.
- **SenseVoiceSmall weight licence** — described as FunASR Model Open Source License Agreement v1.1 (non-SPDX, with attribution/conduct clauses) in a secondary audit; read the licence in the model repo before bundling.
- **Apple SpeechAnalyzer language count** — secondary sources say 10+ core languages and ~30 locales in different places; enumerate at runtime.
- Exact CPU RTF for sherpa-onnx streaming Zipformer bilingual and FireRedASR-AED on a named CPU — no canonical published bench found; figures given are class-typical / unverified where flagged.

## Sources

Accessed 2026-10-08. [verified live] = fetched directly this run; [index] = search index / secondary.

**Online — global**
- OpenAI transcription guide — file vs realtime workflows, recommended models, diarization/timestamp routing [verified live] https://developers.openai.com/api/docs/guides/transcription
- OpenAI transcription pricing aggregator [index] https://costgoat.com/pricing/openai-transcription
- Deepgram pricing [verified live] https://deepgram.com/pricing
- AssemblyAI pricing reference (page dated 2026-09-28) [verified live] https://www.assemblyai.com/llms/pricing.md
- AssemblyAI code-switching / Universal-3.6 Pro Realtime blog [index] https://www.assemblyai.com/blog/real-time-transcription-code-switches-multilingual-speakers
- Google Cloud Speech-to-Text pricing [verified live] https://cloud.google.com/speech-to-text/pricing
- Google Chirp 3 streaming constraints (secondary) [index] https://github.com/canopyide/canopy/issues/2678
- Azure Speech pricing [index] https://azure.microsoft.com/en-ca/pricing/details/speech/
- Microsoft MAI-Transcribe-2-Streaming launch + $0.54/hr [index] https://www.marktechpost.com/2026/10/02/microsoft-ai-releases-mai-transcribe-2-streaming-1-real-time-speech-to-text-model-on-artificial-analysis/
- AWS Transcribe pricing [verified live] https://aws.amazon.com/transcribe/pricing/
- AWS Transcribe pricing analysis (tier-1 figure) [index] https://brasstranscripts.com/blog/aws-transcribe-pricing-per-minute-2025-better-alternative
- ElevenLabs Scribe v2 Realtime pricing/latency comparison [index] https://devtoollab.com/blog/best-speech-to-text-apis
- Speechmatics vs OpenAI (pricing, dictionary, deployment) [index] https://www.speechmatics.com/how-we-compare/openai-alternative
- Speechmatics Agent STT launch pricing [index] https://disrupts.disruptsmedia.com/ai-ml/speechmatics-targets-voice-agent-accuracy-gap-agent-stt
- Soniox pricing [verified live] https://soniox.com/pricing
- Soniox universal / mixed-language model launch [index] https://soniox.com/blog/2025-04-25-one-speech-ai-for-the-world
- Gladia product/pricing [index] https://www.gladia.io/product/audio-intelligence
- Gladia Solaria-1 (partials, code-switching) [index] https://www.gladia.io/solaria
- Rev AI API catalogue [index] https://github.com/api-evangelist/rev-ai

**Online — China**
- Alibaba Bailian model price mirror (secondary, flagged) [index] https://api.oceanleo.com/v1/models/pricing-doc/bailian/pdf
- Alibaba DashScope realtime models in a shipped app [index] https://github.com/douglasmooooo/meetingcopilot
- Volcengine Seed-ASR 2.0 integration guide (resource IDs, modes, hotwords) [index] https://github.com/melody0709/voxtype/blob/HEAD/volcengine_asr_guide.md
- Tencent Cloud ASR billing PDF (2022) [index] https://main.qcloudimg.com/raw/document/intl/product/pdf/tencent-cloud_1118_43341_en.pdf
- iFlytek RTASR official global docs [index] https://global.xfyun.cn/doc/rtasr/rtasr/API.html
- Baidu provider implementation notes [index] https://github.com/budecosystem/waav/blob/HEAD/gateway/docs/providers/baidu_ai.md
- Cross-vendor ASR protocol survey incl. Alibaba + Volcengine [index] https://github.com/standard-voice/standard_asr/blob/HEAD/docs/research/1%20大規模%20ASR%20調查%202026-05-09.md

**Local / mobile**
- FunASR llama.cpp CPU benchmark vs whisper.cpp, Chinese [index] https://github.com/qwenaudio/sensevoice/blob/HEAD/runtime/llama.cpp/BENCHMARKS.md
- SenseVoice model table (234M, languages) [index] https://github.com/QwenAudio/SenseVoice/releases
- FunAudioLLM paper table (SenseVoice/Paraformer RTF, params) [index] https://fun-audio-llm.github.io/pdf/FunAudioLLM.pdf
- sherpa-onnx Rust API examples (streaming zh-en, microphone) [index] https://github.com/k2-fsa/sherpa-onnx/blob/HEAD/rust-api-examples/README.md
- faster-whisper CPU int8 measurements [index] https://github.com/pbnz/watch-local/issues/34
- Moonshine model/licence notes [index] https://github.com/brittain9/speech-kit-obsidian-plugin/blob/HEAD/docs/specs/moonshine-model-catalog.md
- Parakeet ONNX (size, RAM, CPU) [index] https://github.com/achetronic/parakeet
- Parakeet CPU int8 batch/streaming bench [index] https://github.com/weblate/myna/blob/HEAD/parakeet-snap/README.md
- FireRedASR paper (AED 1.1B CER 3.18, LLM 8.3B CER 3.05) [index] https://export.arxiv.org/pdf/2501.14350
- Vosk toolkit [index] https://github.com/alphacep/vosk-api/blob/master/python/README.md
- WhisperKit evaluation (CoreML sizes, LocalAgreement latency) [index] https://github.com/riox432/live-translate/blob/HEAD/docs/research/whisperkit-evaluation.md
- Apple SpeechAnalyzer skill notes (iOS/macOS 26, volatile results) [index] https://github.com/bsreeram08/chowser/blob/HEAD/.agents/skills/swift-SpeechAnalyzer-Framework-Expert/README.md
- Android on-device SpeechRecognizer pitfalls [index] https://dev.to/roronoa_/keep-platform-speech-recognition-on-device-on-your-first-mobile-ai-pr-65g
- Picovoice Cheetah docs (platforms, languages) [index] https://picovoice.ai/docs/cheetah/

Working notes: `notes/sources-online.md`, `notes/sources-local-mobile.md`.
