# Mobile Voice Input / Speech-to-Text in Shipping Apps — Late 2025 / 2026

**Accessed: 2026-10-08.** Evidence labels used throughout, per the mission:
**(a) officially disclosed** — vendor's own blog / tech report / developer docs · **(b) stated in privacy policy / help docs / app-store listing** · **(c) inferred / third-party speculation — not fact.**
Where no reliable source was found, the entry says **COULD NOT VERIFY** rather than guessing.

## Summary

- **No major Chinese consumer app does on-device dictation as its primary path.** WeChat, Doubao, Feishu, DingTalk, Tencent Meeting, and the big Chinese IMEs' headline voice modes are all cloud, in-house ASR (ByteDance / Tencent / Alibaba / iFlytek families), streaming, with LLM-era second passes (semantic smoothing, summaries, "tidy-up" rewrites). The only Chinese on-device claims found are *fallback* offline voice packs in IMEs (Baidu's listing is explicit; iFlytek's could not be verified from an official page in this run).
- **Global platform owners are the on-device exception** — because they own the silicon/OS: Apple Dictation and Pixel Gboard Advanced / Recorder run on-device models, and they market privacy on exactly that basis. Even they are hybrid in practice (Apple: on-device "in many languages"; Google Advanced: on-device except "Fix it"/detailed edits, which go to servers).
- **Indie/pro dictation splits in two:** Wispr Flow and Typeless are cloud ASR + heavy LLM cleanup (no offline mode); superwhisper is local-first (Whisper / Parakeet / Cohere on-device) with optional cloud ASR and optional cloud *or* local LLM cleanup.
- **Specific vendor attributions the mission asked about — WeChat's engine, Wispr Flow's ASR models, Chinese IME offline engines — are NOT officially disclosed.** Details and flags in §6.
- **Verdict on your plan (§8):** v1 cloud streaming is exactly the industry-dominant pattern and is supported. v2 sherpa-onnx on-device CPU is a credible *fallback/offline tier* (it is the stack indie local tools converge on), but industry practice would **not** make it a pure replacement for cloud: leaders ship hybrid, exploit NPUs when available, and put the differentiation in the post-ASR layer (punctuation, smoothing, LLM cleanup with an "undo to raw" escape hatch).

---

## 1. System & Keyboard level

### Apple iOS Dictation / Siri / Speech framework — (a)+(b), on-device system framework [C/D]
- **Cloud vs device:** On-device in supported configurations. Apple Support (opened, verified): dictation requests are processed on your device in many languages, no internet required; exception — text dictated into a search box may go to the search provider. Unsupported languages/devices historically fell back to Apple servers.
- **Since when:** On-device Siri speech processing arrived in **iOS 15 (2021)**, requiring A12 Bionic (iPhone XS/XR+) and initially covering, among others, Mandarin (China mainland) and Cantonese (Hong Kong) — reported in contemporary coverage summarising Apple's WWDC21 claims (index). Keyboard dictation followed the same on-device model family.
- **Streaming:** Yes — live partial results, keyboard stays open so typing and dictation can be mixed; auto-punctuation in supported languages (Apple Support, verified); stops after ~30 s of silence.
- **Developer framework:** Legacy `SFSpeechRecognizer` offered `requiresOnDeviceRecognition` / on-device support queries and iOS 17+ custom language models. **iOS 26 (WWDC25, session 277) introduced `SpeechAnalyzer` + `SpeechTranscriber`** as its replacement: fully on-device, designed for long-form and distant audio, volatile (partial) + final results, downloadable per-locale assets managed by the OS; Apple says it powers Notes / Voice Memos / Journal transcription (index summaries of Apple's session and docs).
- **Chinese:** Mandarin Simplified/Traditional are first-class dictation languages; Voice Memos transcription (iOS/iPadOS 18+) lists Simplified and Traditional Chinese (Apple Support, index). Code-switching zh↔en in one utterance is not a marketed feature — users pick a keyboard language; this is a real gap vs Chinese IMEs (below).
- **LLM post-processing:** None in classic dictation (rules/models for punctuation and commands: "new line", "delete", emoji by name). Apple Intelligence Writing Tools are a separate, user-invoked layer.

### Google Gboard voice typing — (a)+(b), split personality: basic = cloud, Advanced (Pixel) = on-device [E]
- **Basic Gboard voice typing (all Android):** Historically Google's server ASR, with downloadable offline recognition for some languages in the Google app settings. Engine is Google's own.
- **Advanced voice typing (formerly "Assistant voice typing", Pixel 6+, rebranded "Advanced features" in Gboard 15.x):** On-device. Google Support (opened, verified): the text you speak **stays on your device and isn't sent to Google servers — except "Fix it" and detailed-edit features**, which send the transcript + text field (no audio, stated not stored) to servers. Auto-punctuation, voice editing commands ("clear", "send", emoji by name), type-while-dictating.
- **Model family (a):** Google's 2019 AI Blog described the on-device recogniser as an end-to-end RNN-Transducer, quantised to ~80 MB, character-level streaming output — the lineage behind both Gboard on-device and Recorder (index, via secondary summaries of the blog).
- **Chinese — critical caveat:** Advanced voice typing's supported list in Google's current help is **English, French, German, Italian, Japanese, Spanish only — no Chinese**. A Mandarin user on Pixel therefore falls back to basic (cloud) Gboard voice typing. Do not cite Pixel Advanced as a Mandarin on-device precedent.
- **2026 reports (c):** Third-party coverage of a Pixel "Rambler"-style Gemini cleanup layer (removing fillers before text lands) exists in 2026 tech press found in search; treat as reported, not as a documented architecture.

### Samsung Voice Input / Galaxy AI — (b) partial, (c) for engine details [D/E, weakly evidenced]
- **What is disclosed:** Samsung Keyboard lets the user **choose Samsung Voice Input or Google Voice Typing** as the voice engine (consistently described in Samsung-ecosystem tutorials/how-tos, index). Samsung Voice Input is the offline-capable option after downloading a language pack; Google Voice Typing is the cloud, broader-language option.
- **Galaxy AI Transcribe Assist (Voice Recorder / Phone):** Real-time and recorded-call transcription and summaries under the Galaxy AI brand; Samsung's general Galaxy AI positioning is hybrid on-device + cloud, with an option in settings to restrict processing to on-device for supported features.
- **COULD NOT VERIFY:** No Samsung official page found in this run naming the ASR model/engine, its streaming behaviour, or Chinese-specific behaviour. Any claim that Samsung Voice Input uses a specific third-party engine is (c).

### Microsoft SwiftKey — (b), borrows Google's engine on Android; new own mode undisclosed [B]
- Microsoft Support (index): on Android, SwiftKey voice-to-text **"utilizes Google Voice technology"**; its newer **Multimodal Voice Typing** (default, dictate while keyboard stays visible) can be switched off, in which case SwiftKey **reverts to Google's voice IME**, whose offline/language settings live in the Google app.
- **COULD NOT VERIFY:** Microsoft does **not** name the engine behind Multimodal Voice Typing in the support page. It is commonly *assumed* (c) to be Microsoft's own/Azure Speech — **do not present that as disclosed.**
- **2026 beta (c):** Tech-press testing of a SwiftKey beta "AI voice" mode reported fully offline transcription plus filler-word removal/formatting. Reported only; no Microsoft architecture disclosure found.

### Chinese IMEs

| IME | Backend | Streaming | Offline | Chinese notes | Label |
|---|---|---|---|---|---|
| **iFlytek 讯飞输入法** | iFlytek's own ASR — iFlytek is itself a speech vendor selling cloud streaming ASR (WebSocket) to developers; the IME is its consumer showcase | Voice input shows live results in-product | **COULD NOT VERIFY** an official current page for "offline voice packs" in this run (the feature has been marketed historically; treat as unconfirmed for 2025/26) | Strongest dialect coverage marketing of the group; zh-en mixed input marketed | (a) for in-house ASR generally; offline = unverified |
| **Sogou 搜狗输入法** | Own ASR historically; Sogou was acquired by Tencent (2021), so a migration toward Tencent speech is plausible | Live in-product | No reliable source found | Searches returned almost entirely SEO spam — **no usable official source found in this run** | Engine today = **(c)/unverified** |
| **Baidu 百度输入法** | Baidu's own ASR | Live in-product | **Yes — developer's Google Play listing explicitly markets 离线语音 ("accurate even offline / on weak networks")** | Listing also markets zh-en mixed input without switching, and dialect input without switching | (b) app-store listing |
| **WeChat Keyboard 微信键盘** | Tencent in-house (presumed) | Live in-product | Not marketed | Standalone Tencent keyboard; voice input is a headline feature | **Engine NOT disclosed in any source found — (c).** See §6 |
| **Apple / Google built-in Chinese dictation** | See above | Yes | Apple: yes (supported locales); Google Advanced: **no Chinese at all** | Neither markets zh-en code-switching; language is per-keyboard/per-session — the key UX gap Chinese IMEs exploit | (a)/(b) |

**Pattern:** Chinese IMEs compete on (i) zh-en code-switch without manual switching, (ii) dialects, (iii) weak-network/offline fallback — all as *marketing claims on listings*, with essentially zero published architecture.

---

## 2. Chat & Social apps

### WeChat 微信 — engine (c), cloud (c, strong), LLM tidy-up (b, feature-level)
- **Features (observable product, widely documented in user guides, index):** (1) hold-to-talk voice message → slide to "转文字" to send as text instead; (2) long-press a received voice message → transcribe; (3) standalone 语音输入 in the "+" panel (push-to-talk, language selector: 普通话 / 粤语 / 英语 etc.); (4) tap-to-talk mic in the text box (2025 rollout). A **"整理文字" (tidy text)** action removes fillers/repetitions from the converted text — i.e. an LLM/rules post-edit exists at feature level.
- **Cloud vs device / streaming:** Voice-message conversion is **after-recording** (the finished clip is converted); the standalone voice input shows results as you speak (**streaming-like UX**). No official statement of cloud vs on-device was found. The near-universal third-party assumption — and the only plausible reading of cross-device, server-synced behaviour — is **Tencent cloud**. Label: **(c)**.
- **Whose engine? COULD NOT VERIFY — see §6.** The historical candidate is WeChat Zhiling 微信智聆 (Tencent's in-house WeChat speech team): a Tencent Cloud document for a *different* product (Tencent Tongchuan 腾讯同传) officially states its ASR is provided by WeChat Zhiling with streaming recognition and post-processing including intelligent sentence segmentation and text smoothing — proof Tencent had/ has this in-house stack, **not** proof WeChat chat uses it today vs a Hunyuan-era successor.

### WhatsApp — (a), on-device [D on Android / C on iOS], after-recording
- WhatsApp blog, 21 Nov 2024 (opened, verified): voice-message transcripts are **generated on your device so no one, not even WhatsApp, can hear or read them** — the privacy claim is the product.
- **Mechanics:** Opt-in per user (Settings → Chats → Voice message transcripts), downloadable language pack, long-press → Transcribe. Launch languages were few (English, Portuguese, Spanish, Russian; Hindi additionally reported on Android), expanding through 2025 (index).
- **iOS nuance (b):** WhatsApp's own FAQ says iPhone transcripts require **Siri to be turned on** and use **the device's speech recognition** — i.e. on iOS, WhatsApp in effect delegates to Apple's recogniser, which is why iOS supports many more languages (including Chinese) than Android's initial list.
- **Chinese:** On Android, Chinese was **not** in the launch list; its later addition could not be confirmed from an official list in this run — **flagged**. On iOS it follows Apple's language list.
- No LLM post-processing; verbatim transcript under the voice bubble. Not streaming — it transcribes a received, completed message.

### Telegram — server-side (c, via API evidence), Premium-gated, after-recording
- Voice/video-note transcription is a Telegram Premium feature. Third-party developer documentation (index) shows it is implemented via the MTProto `messages.TranscribeAudio` request — i.e. **Telegram-server-side**, with pending/polling for long messages and rate limits. Telegram does not name an engine/vendor; any Whisper attribution is (c). No official statement found naming the model — **flagged as undisclosed**.

### LINE — COULD NOT VERIFY
- No reliable source for a built-in LINE voice-message transcription or dictation engine was found in this run. In practice LINE users dictate via the system keyboard (→ §1). Do not attribute an ASR backend to LINE.

### iMessage — system dictation only [C]
- No in-app ASR; voice input is Apple Dictation (§1), and audio messages are Apple Voice Memos-style recordings. Any "iMessage transcription" is iOS's system feature, not a Messages-specific engine.

---

## 3. AI Assistant & Dictation apps (most relevant group)

### Doubao 豆包 (ByteDance) — (a) for the model family, (c) for the app wiring; cloud streaming in-house [A, +F for summaries]
- **Seed-ASR (a):** ByteDance Speech's technical report (arXiv:2407.04675) describes Seed-ASR as an **LLM-based ASR** family: Mandarin plus 13 Chinese dialects, strong accent robustness, and explicit use of dialogue context. This is the reference design for "ASR where the language model is inside the recogniser," not a bolt-on.
- **Volcengine productisation (a/b for the API):** The same family is sold as Volcengine streaming ASR (WebSocket, resource `volc.seedasr.sauc.*` for the 2.0 generation), with features third-party integrators document from official docs as **second-pass recognition + semantic smoothing (语义顺滑/DDC)** — the cloud does a fast streaming pass, then a smoothing pass that fixes punctuation/disfluency.
- **Doubao app itself:** Voice input and realtime voice chat are cloud (they require connectivity and behave as streaming services); it is a **strong inference (c), not an official statement found in this run,** that the app's dictation is literally Seed-ASR 2.0 rather than a sibling in-house model. Feishu Miaoji / Doubao meeting notes are described even in third-party roundups as sharing "the Doubao model family."

### ChatGPT app (OpenAI) — (a/b) feature split; current dictation model NOT named [A]
- OpenAI's own Academy/Help material (index) distinguishes: **Dictation** (mic icon — speak, words appear as text to edit before sending), **Voice Mode** (realtime two-way conversation), and **Record mode** (desktop meeting capture). There is a dedicated Voice Dictation FAQ in the Help Center.
- **Whisper?** At the mobile app's 2023 launch OpenAI disclosed Whisper-powered voice input. **OpenAI does not, in current help docs found, name the model behind in-app dictation in 2026.** Its API now recommends newer transcription models (`gpt-transcribe` for files, `gpt-live-transcribe` for realtime; `whisper-1` retained e.g. for word timestamps) per official API docs (index) — so "ChatGPT app = Whisper" is **historical (a) for 2023, (c) for today**. Voice Mode is a separate native-audio realtime model lineage (GPT-4o / GPT-Live class), not an ASR→LLM cascade.

### Claude / Gemini apps — cloud voice conversation; dictation engine undisclosed [A]
- **Claude:** Voice mode (beta from May 2025, mobile first) is a turn-based spoken conversation with Claude models; Anthropic does not name an ASR vendor for the app. Separately, Claude Code's `/voice` dictation is documented (via docs summaries, index) as **streaming audio to Anthropic's servers — not processed locally**, push-to-talk, tuned for coding vocabulary with project/branch names as recognition hints. Claims that Claude's TTS/ASR use a specific third party (e.g. ElevenLabs) come from third-party blogs — **(c), unverified**.
- **Gemini:** The Gemini app's mic is conventional Google speech input; **Gemini Live** is a cloud native-audio model (audio in → understanding + audio out over a streaming connection), i.e. there is no separable "ASR engine" to name. On Android, plain prompt dictation typically routes through Gboard (§1). No separate Gemini-app ASR disclosure exists — **flagged as undisclosed/by-design**.

### Wispr Flow — (a) cloud + fine-tuned Llama cleanup; ASR models NOT disclosed [A+F] ⚠️ key flag
- **Disclosed (a):** Baseten's customer case study (opened, verified) describes Flow's pipeline end-to-end: **speech-recognition models → fine-tuned Llama models for transcript cleanup/formatting**, running as a multi-step chain on Baseten dedicated deployments on AWS, targeting **<700 ms p99 end-to-end**, with the Llama stage generating 100+ tokens in <250 ms. Wispr's own docs are summarised by multiple independent third parties as stating **transcription always occurs in the cloud**; there is **no offline mode**.
- **What the cleanup does (a, product-level):** filler removal, auto-punctuation, list formatting, resolving spoken self-corrections ("…no wait, Tuesday"), per-app tone/style, personal dictionary that learns from corrections, context from the active app/text field.
- **NOT disclosed:** Which ASR model(s) sit in front of the Llama stage. Baseten says only "speech recognition models" (plural). Third-party research notes claim an ensemble including Whisper-family models with per-language routing and possible routing of text to OpenAI/Anthropic/Cerebras — **all (c), unverified; Wispr has never confirmed a specific ASR vendor.** See §6.
- **Risk exhibit (c, single anecdote):** A widely-shared user report describes Flow's cleanup *generating* a full meeting-report template from a short Chinese dictation — the canonical over-editing failure mode of aggressive LLM post-editing.
- Privacy positioning: Privacy Mode = zero retention / no training (contractual), SOC 2 / HIPAA / ISO 27001 — but audio always leaves the device; privacy is by policy, not architecture.

### superwhisper — (a), local-first hybrid [D/E, +F optional] — the closest published analogue to your v2
- Official docs (index, vendor's own docs repo): **Local voice models** — Whisper family (tiny→Large v3 Turbo), **NVIDIA Parakeet v2 (English) / v3 (multilingual)**, and (newer docs) Cohere Transcribe local. **Cloud voice models (Pro)** — Deepgram Nova series, ElevenLabs Scribe, and Superwhisper's own hosted models. Users mix and match per "Mode."
- **LLM post-processing ("Super Mode"):** Rewrites dictation for context (email/message/note/custom prompts) using **cloud LLMs (Claude/GPT/Gemini class) or on-device LLMs via llama.cpp**; vendor explicitly documents a fully-local configuration in which no audio or text leaves the machine, recommended for PHI/sensitive work.
- Mobile: iOS app exists (desktop is the flagship); local models are the offline story. Chinese: follows Whisper/Parakeet-v3 language coverage — serviceable, not zh-specialised.

### Typeless — (b) privacy-level disclosure only; architecture CONFLICTING ⚠️
- Typeless's own site (via secondary mirrors, index) promises: zero cloud data retention, audio processed in real time and never stored in the cloud, dictation history stored on-device, no training on user data; features mirror Wispr's (filler/self-correction removal, per-app tone, 100+ languages, voice editing commands).
- **Conflict:** Some third-party comparisons classify Typeless as **cloud-only, no offline**; some launch coverage described it as **local processing**. Typeless itself, in sources found, does **not** unambiguously state where ASR runs or which engine it uses. **Verdict: ASR vendor and cloud-vs-device = COULD NOT VERIFY.** Treat only the zero-retention promise as (b).

### Chinese dictation tools — mostly COULD NOT VERIFY
- **闪电说 (Shandianshuo):** No reliable source on its ASR backend was found in this run (searches returned unrelated tools). **Engine, cloud/device split: unverified.** Do not attribute it to iFlytek or anyone else without new evidence.
- **智谱 (Zhipu/GLM) app:** Zhipu sells ASR APIs (GLM-ASR family), but **no source found** tying the consumer app's dictation button to a named model. Unverified.
- **通义 (Tongyi) app / 通义听悟:** Tongyi Tingwu is Alibaba's cloud transcription product (real-time + file, diarisation, LLM summaries). Alibaba's ASR lineage is Paraformer / Fun-ASR (Alibaba-published model families; Fun-ASR was announced Aug 2025 for meeting captions/interpretation/minutes per press coverage, index). That Tingwu runs Paraformer/Fun-ASR specifically is **(c) strong inference from Alibaba's own model portfolio**, not a Tingwu architecture disclosure.

### Otter.ai — (a/b), pure cloud proprietary [A]
- Otter Help (opened, verified, updated 2026-04-01): **"entirely cloud-based"**, in-house processing, no human transcribers; speaker identification learned from a few tagged paragraphs. Otter's own/launch materials describe a **proprietary in-house stack** (ASR + diarisation + identification) built because off-the-shelf APIs weren't good enough for multi-speaker conversation. Live streaming transcription in meetings + after-recording file transcription; filler words are *programmatically* ignored (a rules detail, not LLM). Help page frames its engine around English — Otter remains English-first vs the Chinese tools.

### Google Recorder (Pixel) — (a), pure on-device own model [D]
- Real-time transcription **on-device, offline**, from the same RNN-T lineage as Gboard (§1), adapted for long recordings with word-level timestamps for tap-to-play and search (Google blog, via secondary summaries, index). Later Pixels add speaker labels and on-device (Gemini Nano-class) summaries — the summary layer's exact model/placement varies by Pixel generation; treat generation-specific claims as (c) unless checked per device.

### Apple Voice Memos transcription — (a/b), on-device system [D/C]
- iOS/iPadOS 18+ (expanded in 26): live transcription while recording and after, on supported models, in English variants, Spanish, Portuguese, Italian, French, German, Japanese, Korean, **Simplified and Traditional Chinese** (Apple Support, index). It uses Apple's system speech stack (§1, SpeechAnalyzer in iOS 26) — no separate engine, no cloud round-trip in supported configurations, no LLM rewrite (Apple Intelligence summaries of transcripts are a separate Writing Tools action).

---

## 4. Productivity & Meeting apps

**Common pattern: every one of these is cloud on mobile. None was found doing on-device ASR in its mobile client.** Mobile clients capture/stream; transcription, diarisation and LLM minutes happen server-side, where recordings are synced anyway.

| App | Finding | Label |
|---|---|---|
| **Feishu/Lark 飞书妙记** | Realtime + recorded transcription (zh/en/ja + more), speaker ID, chapters, AI minutes/todos, cross-meeting Q&A. A ByteDance cloud service inside the suite; mobile is a capture/playback client. Engine name not published in sources found — Seed/Volcengine family is inference | Cloud (a, product-level); engine (c) |
| **DingTalk 钉钉 (AI听记)** | Realtime transcription, speaker separation, structured minutes, 200+ scenario templates (product coverage, index). Third-party roundups describe it as built on Alibaba Tongyi — plausible given Alibaba ownership | Cloud (b/c); Tongyi attribution (c) |
| **Tencent Meeting 腾讯会议** | Realtime captions/transcription, AI minutes; 2025–26 coverage ties its AI纪要 to Tencent Yuanbao/Hunyuan, and realtime interpretation to Tencent's speech stack. Tencent's official Tongchuan FAQ (a, for that product) credits WeChat Zhiling ASR + Tencent Translate — evidence of the in-house stack available to Meeting, not a Meeting disclosure | Cloud (a product-level); engine (c) |
| **Notion** | Text-field dictation on mobile = system keyboard (§1). Notion's own recorder/AI Meeting Notes transcribe in Notion's cloud; **vendor/engine not disclosed in sources found** | System [C] for dictation; cloud undisclosed for notes — flagged |
| **Microsoft Word / OneNote dictation** | Microsoft Support (index): speech utterances are **sent to Microsoft**, service **does not store** audio or transcript; auto-punctuation; requires Microsoft 365 + internet; rich voice formatting commands. The support page does **not** say "Azure Speech" — Azure is the known platform family, but as a citation the page supports only "Microsoft cloud" | Cloud (b); "Azure" attribution (c)-by-omission |
| **Google Docs voice typing (mobile)** | **There is no built-in voice typing in the mobile Docs app.** Google Docs Help (index): voice typing works in **browsers** (Chrome/Edge/Safari) and "your web browser controls the speech-to-text service." On mobile, users dictate through Gboard/system keyboard instead | Browser/system [C] |
| **Evernote / 印象笔记** | AI Transcribe (index, official): **online only, no real-time transcription**, file-based (≤60 min). Evernote AI FAQ: AI Meeting Notes transcription uses **Evernote's internal models**; summaries may be processed by a third-party AI vendor. Mobile dictation into a note = system keyboard | Cloud batch (b); internal-models (b) |

---

## 5. Creator apps

### CapCut / 剪映 auto captions — feature (b), architecture COULD NOT VERIFY ⚠️
- App listings (index) disclose only: "Auto captions: automate video subtitles with speech recognition." Generation happens **after recording** (on the edited clip), not streaming dictation.
- **No source found stating cloud vs on-device, or naming an engine.** The inference (c) is ByteDance's own ASR family (the same Volcengine/Seed stack sold externally), and caption generation in the international CapCut has historically behaved like a server feature — but in this run that remains **inference, flagged, not fact**.
### TikTok / Douyin captioning — (c)
- Auto-captions are generated at upload/publish time for viewers (a server-side pipeline shape), with on-screen editing by the creator. No official ASR disclosure found. Engine attribution to ByteDance ASR = (c).

---

## 6. Flagged — claims that could NOT be verified (explicit, per mission)

1. **WeChat's ASR engine.** No official WeChat/Tencent page found naming the engine behind chat voice-to-text, standalone voice input, or 微信键盘. "WeChat Zhiling" is supported only as Tencent's historical in-house speech brand (Tencent Cloud material for Tongchuan) — its use in 2025/26 WeChat is **third-party inference**.
2. **Wispr Flow's ASR.** Cloud + fine-tuned-Llama-on-Baseten is disclosed; **the ASR model(s)/vendor(s) are not**. Ensemble/Whisper/OpenAI/Anthropic/Cerebras routing claims are third-party research notes — unverified.
3. **Chinese IME offline ASR.** Only **Baidu's** offline claim is sourced (its own Play listing). **iFlytek offline voice packs**: not confirmed from a current official page in this run. **Sogou's** current engine: no usable source at all (post-Tencent-acquisition status undocumented in sources found). **WeChat Keyboard's** engine/offline: undisclosed.
4. **Typeless architecture.** Own-site privacy promises only; third parties conflict (cloud-only vs local). Vendor unknown.
5. **CapCut/剪映, Telegram, Feishu, DingTalk, Tencent Meeting, Notion (notes), Gemini app, Claude app:** engine/vendor **undisclosed** in every case above; cloud placement is product-evident for the meeting apps, merely inferred for CapCut/Telegram.
6. **SwiftKey Multimodal engine** (Microsoft does not name it; "Azure" is assumption), **Samsung ASR engine** (no official naming found), **ChatGPT app's current dictation model** (Whisper is the 2023 disclosure only), **闪电说 / 智谱 app dictation** (no evidence found), **LINE** (no built-in transcription evidence found), **WhatsApp Android Chinese transcription** (not in launch list; later status unconfirmed officially).

---

## 7. Synthesis — Taxonomy

Counting rule: each app counted **once by its primary dictation path**; **F is an overlay** counted additionally. ~34 apps/features covered.

| Strategy | Definition | Apps (primary) | Count |
|---|---|---|---|
| **A. Pure cloud streaming, in-house ASR** | Vendor's own ASR, streamed to vendor cloud | Doubao, ChatGPT dictation, Claude voice, Gemini Live, Otter, Feishu Miaoji, DingTalk Tingji, Tencent Meeting, WeChat (c), iFlytek IME (online mode), Tongyi Tingwu | **11** |
| **B. Cloud third-party ASR API/SDK** | Someone else's recogniser, via API or borrowed IME | SwiftKey-on-Android (Google Voice), superwhisper cloud modes (Deepgram/ElevenLabs), Typeless (c — if cloud, vendor hidden) | **2–3** |
| **C. Pure on-device system framework** | App just uses OS dictation | iMessage, LINE (de facto), Notion text fields, Google Docs mobile, WhatsApp-on-iOS (Apple recogniser), any app using iOS/Android system dictation | **5+ (pattern, unbounded)** |
| **D. Pure on-device own model** | Vendor ships its own on-device recogniser | Apple Dictation, Apple Voice Memos, Pixel Gboard Advanced, Google Recorder, Samsung Voice Input, WhatsApp-on-Android, superwhisper local mode | **7** |
| **E. Hybrid on-device + cloud** | Both, with fallback/routing between them | Gboard overall (basic cloud ↔ Advanced on-device ↔ cloud "Fix it"), Apple overall (on-device ↔ server for unsupported configs), Samsung Galaxy AI overall, superwhisper (user-mixed), Chinese IMEs with offline packs (Baidu) | **5** |
| **F. ASR + LLM post-editing (overlay)** | LLM/fine-tuned model rewrites ASR output | Wispr Flow (fine-tuned Llama), Typeless, superwhisper Super Mode, WeChat 整理文字， Doubao/Volcengine semantic smoothing, Pixel "Fix it"/reported Gemini cleanup, SwiftKey beta AI voice (reported) | **7 overlay** |

### Dominant patterns
- **(i) Chinese consumer apps: A, overwhelmingly.** Cloud streaming in-house ASR from the parent platform (ByteDance Seed, Tencent, Alibaba, iFlytek, Baidu), competing on zh-en code-switch, dialects, and post-smoothing — never on offline/privacy. On-device appears only as an IME *fallback pack* for weak networks. LLM value sits *around* ASR (minutes, summaries, 整理文字）, and increasingly *inside* it (Seed-ASR is LLM-based; Volcengine markets a smoothing second pass).
- **(ii) Global consumer apps: split by who owns the platform.** Platform owners (Apple, Google-on-Pixel, Samsung) ship D/E and market on-device privacy (WhatsApp's on-device transcripts are the same play by a non-platform owner, executed via downloadable packs on Android and by borrowing Apple's recogniser on iOS). Non-platform global apps (Otter, ChatGPT, Claude, meeting tools) are A. Nobody global markets a downloadable third-party on-device model to consumers except via the OS.
- **(iii) Indie/pro dictation: polarised.** Cloud+LLM maximalists (Wispr, Typeless — F is the product, ASR is a commodity input, no offline) vs local-first configurables (superwhisper — D/E with BYO cloud, model choice as the product). Both agree on one thing: **raw ASR output is not the product; the post-ASR layer is.**

### Key design lessons
- **Latency UX:** Streaming partials everywhere streaming is offered (Apple volatile results, Google character-level RNN-T, Volcengine WebSocket). Wispr is the instructive exception: it is *effectively batch-per-utterance* behind a streaming-feeling UI, because waiting for the full utterance is what lets the LLM resolve self-corrections — and it still budgets <700 ms p99 end-to-end. Endpointing is product-critical: Apple auto-stops on silence; Claude's turn-based voice is criticised precisely for mistaking pauses for end-of-turn.
- **Punctuation/formatting:** Three generations visible: (1) spoken commands ("comma", "new line" — Apple/Google/Microsoft), (2) automatic punctuation inside the ASR (Gboard Advanced, Word, Chinese IMEs), (3) LLM/smoothing pass that also deletes fillers and resolves corrections (Wispr, Seed/DDC, WeChat 整理）. Generation 3 needs generation 2 as its input and an **undo-to-raw** escape hatch — over-editing is its documented failure mode.
- **Offline:** Always shipped as *downloadable language packs + a smaller model*, never as the headline model (WhatsApp, Baidu IME, Samsung, Gboard). Users accept an accuracy step-down offline if the switch is automatic on weak/no network.
- **Privacy positioning:** Two honest architectures exist — *architectural* (Apple/WhatsApp: audio never leaves, verifiable by airplane mode) and *contractual* (Wispr/Typeless/Microsoft Word: audio leaves, zero-retention/no-training promises, SOC 2). Leaders state plainly which one they are; the muddy middle (Typeless's ambiguous claims) attracts exactly the third-party scrutiny seen in §3.
- **Chinese-specific:** zh-en code-switch without a language toggle is a headline feature for every Chinese IME and is *absent* from Apple/Google Advanced (which doesn't even offer Mandarin). Any zh-en product that forces a language choice per utterance is behind the local baseline.

## 8. Implications for your v1-cloud / v2-sherpa-onnx-CPU plan

**Industry practice supports the plan's shape — with three modifications the evidence points to:**

1. **v1 cloud streaming: fully mainstream — differentiate in the second pass, not the ASR.** Every Chinese leader and Wispr do cloud streaming; the competitive layer is Volcengine-style semantic smoothing / Wispr-style cleanup. Build v1 as streaming ASR (partials, auto-punctuation in-model) **plus** a light, *levelled* post-edit (off / light / full) with raw-transcript retention and undo. Don't ship aggressive LLM rewriting as the only mode — the Wispr over-generation anecdote is the cautionary tale, especially for zh-en mixed text.
2. **v2 on-device: ship it as hybrid (E), not as a replacement tier.** No successful product found replaces cloud with on-device outright; they route (offline/weak-network/privacy mode → on-device; otherwise cloud) — cf. Gboard, IMEs' offline packs, superwhisper's per-mode mixing. A sherpa-onnx CPU model (e.g. a streaming Paraformer/Zipformer-class zh-en model or SenseVoice-class model, int8) is exactly the class of stack indie local tools validate on-device, and CPU-only is the *portable* choice — but note the divergence: **Apple/Google/Samsung on-device wins all lean on NPU/Tensor acceleration.** On CPU-only, plan for: model warm-up at app start (cold-start latency is the known sherpa/Whisper-class pitfall), chunk-size tuning (480–720 ms windows trade latency vs accuracy in streaming Paraformer deployments), thermal/battery testing on low-end Android, and a hard accuracy expectation gap vs your cloud model for dialects, far-field, and code-switching. Market it as offline/privacy, not as "same quality, local."
3. **Keep the door open to system frameworks as a third tier (C).** On iOS, SpeechAnalyzer (iOS 26) gives you a free, OS-maintained, on-device recogniser with zh support and zero model download — several tools are already adopting it as their Apple-side local backend while keeping sherpa-onnx for Android/cross-platform consistency. Ignoring it means shipping a worse, bigger local stack on iOS than the OS offers for free. (Android has no equivalent-quality universal framework — which is precisely why sherpa-onnx earns its place there.)

**What industry would do differently from the plan as stated:** (a) not frame v2 as "no GPU/NPU by default" as a principle — frame it as "CPU baseline, accelerator where the runtime offers it," since sherpa-onnx can use NNAPI/CoreML providers opportunistically; (b) not treat LLM cleanup as a v-later extra — for zh-en dictation it is already table stakes in 2025/26 products; (c) publish the privacy architecture (architectural vs contractual) at v1 launch, because dictation competitors are now routinely audited on exactly this by third parties.

---

## Sources (accessed 2026-10-08; index unless marked opened/verified)

- Apple Support — Dictate text on iPhone — **opened/verified** — https://support.apple.com/en-gb/guide/iphone/iph2c0651d2/18.0/ios/18.0
- Apple Support — Voice Memos transcription (iPad guide, iPadOS 18/26, incl. Simplified/Traditional Chinese) — https://support.apple.com/guide/ipad/view-a-transcription-ipad282bee5e/ipados
- Apple WWDC25 §277 SpeechAnalyzer (via summaries) — https://developer.apple.com/videos/play/wwdc2025/277/
- MacRumors — iOS 15 Siri on-device guide (A12+, Mandarin/Cantonese) — https://www.macrumors.com/guide/ios-15-siri
- Google Support — Use advanced voice typing features (Pixel 6+, on-device, Fix-it exception, language list) — **opened/verified** — https://support.google.com/gboard/answer/11197787
- 9to5Google — Gboard Assistant voice typing → "Advanced features" rebrand — https://9to5google.com/2025/04/09/gboard-advanced-voice-typing-pixel/
- Google Docs Help — Type & edit with your voice (browser controls STT) — https://support.google.com/docs/answer/4492226
- WhatsApp Blog — Introducing Voice Message Transcripts, 2024-11-21 — **opened/verified** — https://blog.whatsapp.com/introducing-voice-message-transcripts
- WhatsApp FAQ — Siri required for iPhone transcripts — https://faq.whatsapp.com/2850694498395699/?cms=1
- Baseten — Wispr Flow creates effortless voice dictation with Llama on Baseten — **opened/verified** — https://www.baseten.co/resources/customers/wispr-flow/
- Otter Help — Speech & transcription accuracy FAQ (entirely cloud-based, in-house) — **opened/verified** — https://help.otter.ai/hc/en-us/articles/360048322533-Speech-transcription-accuracy-FAQ
- Microsoft Support — How do I use Voice to Text with Microsoft SwiftKey (Google Voice technology; multimodal; revert to Google IME) — https://support.microsoft.com/en-us/swiftkey-keyboard/how-do-i-use-voice-to-text-with-microsoft-swiftkey-keyboard
- Microsoft Support — Dictate your documents in Word (sent to Microsoft, not stored) — https://support.microsoft.com/en-gb/word/dictate-your-documents-in-word
- ByteDance Speech — Seed-ASR technical report — https://arxiv.org/html/2407.04675v2
- OpenAI Academy — Using voice (Voice Mode vs Dictation) — https://academy.openai.com/public/clubs/work-users-ynjqu/resources/using-voice
- OpenAI API — Transcription guide (gpt-transcribe / gpt-live-transcribe / whisper-1) — https://developers.openai.com/api/docs/guides/transcription
- Superwhisper docs (vendor) — voice models; sensitive-data/fully-local configuration — https://github.com/superultrainc/superwhisper-docs/blob/HEAD/models/voice.mdx and …/security/sensitive-data.mdx
- Evernote — AI Features FAQ (internal models for Meeting Notes transcription) — https://help.evernote.com/hc/en-us/articles/45353174499475-Evernote-s-AI-Features-FAQ ; AI Transcribe tool (online only, no realtime) — https://evernote.com/ai-transcribe-audio-to-text/transform-audio-to-text
- Tencent Cloud — 腾讯同传 FAQ (WeChat Zhiling provides ASR, streaming) — https://main.qcloudimg.com/raw/document/product/pdf/1399_52971_cn.pdf
- WeChat Zhiling background (Tencent speech team deck) — https://ask.qcloudimg.com/draft/1184429/27bjh54d3m.pdf
- Baidu Input Method — Google Play listing (offline voice, zh-en/dialect no-switch claims) — https://play.google.com/store/apps/details?id=com.baidu.input&hl=zh_CN
- Telegram server-side transcription (third-party dev docs, Telethon) — https://github.com/popstas/telegram-download-chat/pull/89
- Typeless privacy claims (vendor site via mirror) and conflicting third-party classification — https://github.com/digvijay208/echo-speech-to-text/blob/HEAD/website/typeless.md ; https://github.com/chloe4ai/sotto
- Wispr Flow third-party architecture research (labelled inference in report) — https://github.com/antoninmarcon-maker/local-flow/blob/HEAD/docs/wispr-flow-architecture.md
