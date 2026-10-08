# CPU Latency and CPU Load of Local, Offline ASR Engines on PC (CPU-only) — Late 2025 / 2026
## With a dedicated chapter: Recommended Download Model Size by Language Coverage (8 languages)

**Access date: 2026-10-08.** All web sources below were accessed on this date. Context: a Tauri/Rust desktop app on Windows/macOS/Linux, push-to-talk dictation, embedded local engines, **CPU-only (no GPU)**, unknown user PCs.
**Target languages (added requirement):** primary — English (en), Mandarin (zh), Cantonese (yue); also good support required for Japanese (ja), Spanish (es), French (fr), Italian (it), Korean (ko). **8 languages total.**
**taomni status quo to evaluate:** only Whisper Base 148 MB / Small 488 MB / Medium 1.53 GB on disk, all multilingual, all (as verified below) the f16 ggml files.

**How to read the flags:** **[Vendor]** = published by the engine/model author. **[Independent]** = third-party repo/measurement. **[Unverifiable]** = single low-provenance repo, hardware or method missing, or a number that could not be corroborated. Every latency number states CPU, threads, quantization and audio duration where the source gave them; where a source omitted one of those, that omission is stated explicitly — treat such numbers as directional, not design-grade.

---

# PART A — LATENCY AND CPU LOAD

## A0. Latency metrics — definitions used throughout

| # | Metric | Definition | What dominates it |
|---|---|---|---|
| 1 | Cold-start / model load | Process start (or first use) → recognizer ready, incl. weight mmap/read, graph/session creation, first-inference warm-up/compile | Model bytes, runtime (ONNX session vs ggml), CoreML/ANE compile on Apple |
| 2 | Time to first partial | Speech onset → first non-empty partial shown | Algorithmic chunk size + right-context/lookahead + chunk compute |
| 3 | Partial cadence / chunk time | Interval between partials (≈ chunk size) and the compute time per chunk | Chunk size is architectural; chunk compute must stay ≪ chunk duration |
| 4 | Endpoint-to-final | End of speech (or push-to-talk key release) / VAD endpoint decision → committed final text | **In push-to-talk the key release *is* the endpoint**, so this ≈ flush + final decode. In hands-free mode add the VAD/endpoint trailing-silence wait (0.3–2.4 s) |
| 5 | Whole-utterance time / RTF | Processing time ÷ audio duration, as a function of utterance length | Architecture: non-autoregressive (flat-ish) vs Whisper's fixed 30 s window (step function) |
| 6 | Sustained CPU | % of one core (100% = 1 core) averaged while dictating; burst vs continuous | Streaming engines burn it continuously while the mic is open; offline engines burn it in a burst after release |
| 7 | Memory / bandwidth | Peak RSS; weight bytes that must be streamed through caches per decode | Large f16 models are bandwidth-bound on laptops; quantization helps size/bandwidth more reliably than it helps speed |

Key structural fact that drives almost everything below: **push-to-talk removes the endpointing problem.** Most "ASR latency" horror numbers in the literature are endpoint wait + autoregressive re-decode. With a key, endpoint = 0 ms of waiting, and the only question is metric 5 applied to one utterance.

## A1. sherpa-onnx streaming Zipformer — bilingual zh-en, int8

- **Model:** `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`, transducer (encoder/decoder/joiner), chunk-16 / left-64 or left-128 exports. Download ≈200 MB for the set (fp32 encoder is the bulk; int8 encoder variant exists). **[Independent listing]** https://github.com/niaodian/voicestudio/blob/HEAD/docs/engines/sherpa-onnx-asr.md
- **Chunk / first partial (metric 2/3):** Zipformer chunk-16 at the 50 Hz frame rate = **320 ms algorithmic chunk** (chunk-32 exports = 640 ms); left context 64–128 frames. Source: icefall **[Vendor]** https://github.com/k2-fsa/icefall/pull/1058. First partial therefore cannot appear before ~320 ms of speech plus one chunk of compute; expect ~320–450 ms in practice — **[Unverifiable]** as an end-to-end figure: no source measured time-to-first-partial for the bilingual model on a named desktop CPU.
- **Chunk compute:** One independent streaming benchmark (hardware not stated — **[Unverifiable]**) reported Zipformer CPU int8 RTF 0.0598, median chunk processing 0.46 ms, p95 23.5 ms, int8 27.6% faster than fp32 with <0.5 pt WER change. https://github.com/lucifer5051/aether/blob/HEAD/AETHER5_STREAMING_ASR_BENCHMARK_REPORT.md
- **Whole-file RTF (metric 5):** sherpa-onnx Python decode-files example, bilingual model, **1 thread, greedy, 17.64 s of test wavs, elapsed 3.907 s → RTF 0.221**. CPU not named in the docs output (maintainer machine). Quantization: the `.onnx` (non-int8) files in that example. **[Vendor]** https://k2-fsa.github.io/sherpa/onnx/python/decode-files.html
- **Cold start (metric 1):** Docs examples for other Zipformer models show recognizer creation ≈0.29 s (e.g. a 2026 Bengali streaming model, 1 thread, maintainer Mac, path `/Users/fangjun/...`). **[Vendor]** https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html — bilingual-model-specific load time: **not published [Could not verify]**.
- **Thread scaling:** No controlled 1/2/4-thread table for this model was found **[Could not verify]**. By analogy with SenseVoice on the same runtime (A4 below) expect most gain 1→2 threads, little after 3–4. Do not quote a number for Zipformer specifically.
- **Endpoint-to-final (metric 4):** In streaming file decode the tail needs silence padding so the last chunk becomes "ready": a Wyoming integration measured this from the model — worst case one full chunk, floor 0.66 s of *fed silence* (compute cost small, but the final tokens trail the audio). **[Independent]** https://github.com/ohf-voice/wyoming-faster-whisper/commit/33ff4186abc67bd05bda6662a4078330549d5fab. Plus, if sherpa endpointing decides the final, default rules are rule1 trailing silence 2.4 s / rule2 1.2 s (see A11) — in push-to-talk, bypass them and call `inputFinished()` on key release.
- **CPU / memory (6/7):** At RTF ~0.06–0.22 on 1–2 threads, sustained load while speaking ≈6–22% of one core on a modern CPU (derived from RTF, not directly measured — flag as derived). RSS not published for this model **[Could not verify]**; expect a few hundred MB (200 MB weights + ONNX Runtime arena).

## A2. sherpa-onnx streaming Paraformer (zh / bilingual zh-en)

- **Chunk / first partial:** This is **not** a low-latency streamer in the FunASR formulation. FunASR's own streaming config: `chunk_size = [0, 10, 5]` = **600 ms display granularity + 300 ms of future context**, alternative `[0, 8, 4]` = 480 ms. **[Vendor]** https://github.com/amikey/funasr/blob/HEAD/egs_modelscope/asr/TEMPLATE/README.md. Algorithmic latency floor is therefore ~600–900 ms before compute — roughly 2–3× Zipformer's.
- First-partial measurements conflict: one project states sherpa-onnx streaming Paraformer's first partial matched its own ~1.6 s observation **[Unverifiable, single repo]** https://github.com/suharvest/openvoicestream/commit/80159609b8440335c55cc9d4cbd996bb715dd9e8 ; another small probe (200 ms input chunks, 3 language slices, sherpa-onnx 1.13.6, Swift, CPU not named) saw the first changed partial at 0.8 s, finish 549–568 ms after input end, max chunk compute 26–33 ms, peak RSS ~1.51 GB for the large bilingual model. **[Independent, n=3]** https://github.com/24009643/voice-assistance-agent-ai-pm-/blob/HEAD/evidence/WP-A2-01-PARAFORMER.md
- **Tail truncation hazard:** Stock sherpa-onnx OnlineRecognizer for Paraformer is reported to drop the last 1–3 characters because a full 61-frame chunk is required; a patch (pad final chunk + force CIF fire) fixed it with ~45 ms finalize. **[Independent, Jetson context]** https://github.com/suharvest/reachy-claw/commit/fde9946fa7412fea50ba6ed644d8d0b07e64ec8b — a Tauri integration must test the tail explicitly.
- **Verdict:** For push-to-talk there is no reason to choose streaming Paraformer over SenseVoice (offline) for the final, nor over Zipformer for partials. Its niche is FunASR-ecosystem streaming servers.

## A3. SenseVoiceSmall — via sherpa-onnx (int8) or FunASR (offline, non-autoregressive)

The single most decision-relevant engine in this report for zh/yue/en/ja/ko.

- **Whole-utterance RTF (metric 5) — best independent desktop measurement:** Intel **Core Ultra 7 155H** laptop, sherpa-onnx, **int8**, bundled 4.6–7.2 s samples: inference **81–102 ms** (p95 84–112 ms) → **RTF 0.014–0.016** in all five languages; load 1,181 ms in the main run (2,299 ms in an extended run — method differed, both reported); peak memory **373 MB**; VAD+ASR end-to-end 76–128 ms, <400 MB. Threads: not stated in the repo (sherpa default) — flag. **[Independent]** https://github.com/oaklight/asr-bench
- **Same model, Apple M2, 2 threads, int8:** load ~0.46 s, **RTF 0.017**, RAM delta +740 MB (different measurement basis from the 373 MB above — process delta vs peak; do not average them). **[Independent]** https://github.com/camthink-ai/neomind-extensions/blob/HEAD/extensions/sensevoice-asr/README.md
- **Thread scaling — vendor, embedded ARM (directionally valid for x86):** RK3588, int8, RTF at 1/2/3/4 threads: Cortex-A55 0.436/0.260/0.208/0.175; Cortex-A76 0.099/0.065/0.049/**0.049 (plateau at 3)**. **[Vendor]** https://github.com/k2-fsa/sherpa/blob/HEAD/docs/source/onnx/sense-voice/pretrained.rst
- **Older quad-core x86 floor:** Intel **i5-3570 (2012)**, 7.15 s English utterance, int8 sherpa-onnx: **1 thread RTF 0.226, 2 threads RTF 0.123**. **[Independent]** https://github.com/BrettKinny/dotty-stackchan/pull/140. Extrapolated endpoint-to-final: 5 s utterance ≈0.6 s, 10 s ≈1.2 s on that 2012 CPU at 2 threads; ~0.1 s on a modern laptop. This is the "older PC" anchor for the whole report.
- **Long clips / VAD segmentation (metric 5 vs length):** FunASR's GGUF/CPU head-to-head on 184 Mandarin clips of ~44–60 s, **8 threads, CPU model not named, load excluded**: SenseVoiceSmall Q8 ≈**20× real-time (RTF ≈0.05)**, with FSMN-VAD segmentation `max_single_segment_time=30000`. Crucially, the same doc reports decoding whole long clips *without* VAD materially worsens CER (SenseVoice 9.99% no-VAD vs 8.01% with VAD) — SenseVoice is trained for short segments; **segment at ≤30 s, ideally at VAD pauses**. **[Vendor-adjacent]** https://github.com/qwenaudio/sensevoice/blob/HEAD/runtime/llama.cpp/BENCHMARKS.md
- **Latency by duration (derived from the RTFs above, arithmetic — not new measurements):** at RTF 0.015 (modern laptop, int8): 2 s→~30 ms, 5 s→~75 ms, 10 s→~150 ms, 30 s→~450 ms (if fed as segments). At RTF 0.05 (8-thread GGUF run / weaker CPU): 10 s→0.5 s, 30 s→1.5 s. At i5-3570 2-thread RTF 0.123: 30 s→3.7 s.
- **GPU number — do not transfer to CPU:** The famous "70 ms for 10 s, RTF 0.007" is an **NVIDIA A800 GPU**, batch 1. **[Vendor]** https://fun-audio-llm.github.io/pdf/FunAudioLLM.pdf. CPU figures are 2–20× that RTF depending on CPU/threads, per the rows above.
- **Cold start (1):** 0.46–2.3 s across the three measurements above (M2 / Ultra 155H); a third-party skill doc claims ~3 s first inference on a small hosted box **[Unverifiable]**.
- **CPU / memory (6/7):** Burst-only in push-to-talk use: ~0.1 s of multi-thread work per typical utterance on a modern laptop — negligible fan/battery impact; RSS ~370–390 MB in the cleanest measurement.

## A4. FunASR Paraformer-large — offline and streaming

- **Offline CPU benchmark (the one the mission asked for):** Paraformer-large, **Intel Xeon E5-8269CY @ 2.5 GHz, 1 thread**, AISHELL-1 CER 1.95% in all configs; RTF — Libtorch fp32 0.1026, Libtorch int8 0.0597, **ONNX fp32 0.0778, ONNX int8 0.0446**. AMP/int8 gives ~40% speedup with no CER change in this table. **[Vendor, peer-reviewed paper]** http://arxiv.org/pdf/2305.11013v1 (§4.2, Table 8). Note: 1 thread on a server Xeon — a modern laptop core is faster per-thread; multi-threading lowers RTF further, but no official multi-thread CPU table was found **[Could not verify]**.
- **Same family on the GGUF bench:** Paraformer (zh) Q8 ≈21× real-time (RTF ≈0.048), 8 threads, CPU unnamed, 44–60 s clips, CER 9.89% Q8 / 10.18% fp32 reference. **[Vendor-adjacent]** (URL in A3.)
- **Streaming variant:** see A2 — 600 ms chunk + 300 ms look-ahead is a FunASR design constant.
- **In a Tauri app** the PyTorch FunASR stack (~900 MB model.pt class weight + torch dependency for SenseVoice; Paraformer-large similar order) is a distribution burden vs the 229 MB int8 ONNX of the same-family models via sherpa-onnx. No CPU latency advantage for the PyTorch path was found in any source; one project explicitly migrated away from it for exactly this reason. **[Independent]** https://github.com/brettkinny/dotty-stackchan/issues/135

## A5. whisper.cpp (ggml) — by model size

Architecture reminders that determine latency: fixed **30 s encoder window** (short utterances are padded — a 2 s utterance pays a full-window encode unless VAD/segment trimming is used), autoregressive decoder (cost grows with output tokens), no true streaming (the `whisper-stream` example re-runs a sliding window: `--step 500 --length 5000` in the README example; WhisperStreaming/LocalAgreement-2 style wrappers report **3.3 s latency** on long-form **[Independent]** https://github.com/ufal/whisper_streaming).

- **Vendor CPU table (faster-whisper README, applies to whisper.cpp too):** **Intel i7-12700K, 8 threads, 13 min audio, beam 5, small model, fp32: whisper.cpp 2m05s → RTF 0.160, RAM 1,049 MB**; whisper.cpp+OpenVINO 1m45s → RTF 0.135. **[Vendor]** https://github.com/SYSTRAN/faster-whisper/blob/master/README.md
- **Chinese head-to-head (8 threads, CPU unnamed, 44–60 s clips, load excluded):** whisper.cpp RTF — base ≈0.101 (9.9×), small ≈0.217 (4.6×), large-v3-turbo ≈0.313 (3.2×); Mandarin CER base 31.33 / small 22.12 / turbo 23.15 (vs SenseVoice 8.17). **[Vendor-adjacent — FunASR side ran the bench; treat the *ordering* as reliable, absolute CERs as contested]** https://github.com/qwenaudio/sensevoice/blob/HEAD/runtime/llama.cpp/BENCHMARKS.md
- **Moonshine v2 paper's Whisper numbers (Apple MacBook Pro M3, faster-whisper, end-of-utterance → transcript):** tiny 289 ms, base 553 ms, small 1,940 ms, large-v3 11,286 ms; compute load tiny 8.46%, base 16.19%, small 56.84%, large-v3 330.65% (≈3.3 cores). Utterance length for that table is not stated in the excerpt — flag. **[Vendor — Moonshine's paper, adversarial to Whisper]** https://arxiv.org/pdf/2602.12241
- **30 s padding effect, concrete:** In a 2026 C-runtime comparison, JFK (11 s) is explicitly "padded to the full 30-second encoder window" and whisper.cpp Q8_0 large-v3-turbo took 14–18 s wall on shared cloud Xeon instances (4–8 threads, incl. cold load) — single-run, shared-CPU, **[Independent, weak]** https://github.com/baryhuang/whisper-turbo.c/blob/HEAD/docs/instacloud-int8.md. The lesson stands regardless of the absolute number: short-utterance latency has a **floor of one full window encode + decode**, roughly 0.5–2 s for base/small on a modern desktop CPU, several seconds for turbo/large.
- **Beam vs greedy:** The vendor table above is beam 5. A whisper.cpp discussion run (small, f16, 8 threads, 799 s audio) shows decode/sample dominating total time (decode 437 s of 740 s wall at beam 5). **[Independent]** https://github.com/ggml-org/whisper.cpp/discussions/589. Greedy (beam 1) typically cuts decode cost substantially; no clean same-machine beam1-vs-beam5 whisper.cpp table was found **[Could not verify — must measure in-house]**. For dictation, greedy + temperature fallback is the standard low-latency choice.
- **Thread scaling:** Default upstream cap is 4 threads in many bindings. One Tauri-class project documents capping at 8 because "past 8, whisper.cpp's own scaling flattens while the editor it shares the machine with starts to stutter" **[Independent]** https://github.com/23f3001304/tcursor/blob/HEAD/docs/api/src-tauri/src/asr/whisper.md. On Apple Silicon, giving threads to efficiency cores hurts (barrier waits) — cap at performance-core count there. **[Independent]** https://github.com/konraddallaorg/dimmy/commit/a204a40f5769552406f5e27b065f702789aac198
- **Older quad-core (i7-6700K / i5-8250U class):** **No direct, well-specified whisper.cpp benchmark on either named CPU was found [Could not verify].** Bounding evidence: (a) the i5-3570 SenseVoice anchor (A3) shows 2012-era quads run small NAR models at RTF ~0.12–0.23; Whisper small is ~4–14× SenseVoice's RTF on the same class of hardware in the benches above, implying **small on an old quad is at or above real-time (RTF ~0.5–1.5) — an inference from cross-benchmark ratios, not a measurement**; (b) large-v3-turbo Q8 on JFK took 29.48 s at 4 threads on a Frankfurt cloud instance (CPU model not fully specified) **[Independent, weak]** (instacloud URL above). Do not ship turbo/medium as the *only* option for old PCs.
- **No-AVX2 cliff (metric: instruction sets, see also A11):** Single-trial evidence (CPU unnamed): AVX2 build, 6 threads, 11 s JFK — base.en total 1.57 s (load 0.27 s), turbo total 20.51 s (load 2.61 s); a **portable no-AVX2 build took 14.13 s inference for base.en vs 1.16 s for the AVX2 helper** on the same excerpt. **[Independent, single trial]** https://github.com/andersj05/computercat/blob/HEAD/docs/implementation/whisper/native-evidence.md. A ggml design doc for another project reports a no-SIMD baseline build measured **8–14× slower** on Whisper. **[Independent]** https://github.com/nomercy-entertainment/nomercy-ffmpeg/blob/HEAD/docs/superpowers/specs/2026-09-23-ggml-cpu-hardware-acceleration-design.md. Practical rule: runtime-dispatch builds (GGML_CPU_ALL_VARIANTS) or a hard AVX2 check + fallback tier; a `-march=native` CI build can also *crash* (illegal instruction) on older user CPUs.
- **Quantization (whisper.cpp):** A small study (base model, 10 LibriSpeech files, hardware not specified in the excerpt — **[Unverifiable for design use]**) found average latency fp32/f16-class 10.64 s, q8 9.02 s, q5 11.11 s, q4 10.55 s, WER essentially unchanged — i.e. **on CPU, ggml quantization is a size/memory win, not a guaranteed speed win; q5 can be slower than f16.** https://arxiv.org/pdf/2503.09905. Contrast SenseVoice/Paraformer above, where int8 clearly helped (ONNX/AMP paths).
- **Memory (7):** whisper.cpp README table: tiny disk 75 MiB / RAM ~273 MB; base 142 MiB / ~388 MB; small 466 MiB / ~852 MB; medium 1.5 GiB / ~2.1 GB; large 2.9 GiB / ~3.9 GB (f16 builds). **[Vendor]** https://github.com/vincic/whisper.cpp
- **macOS study (all engines, chart-level):** MacBook Air (M-series), whisper.cpp tiny.en RTF ≈0.012–0.016; the author notes Whisper models degrade on very short buffers and prefer >30 s segments. **[Independent, Medium post]** https://medium.com/@wayenj/quick-findings-on-device-asr-performance-on-macos-34a8bc4847e2

## A6. faster-whisper (CTranslate2, int8)

- **Vendor CPU table (same bench as A5):** i7-12700K, 8 threads, 13 min, small, beam 5 — fp32 2m37s (RTF 0.201, RAM 2,257 MB); **int8 1m42s (RTF 0.131, RAM 1,477 MB)**; int8 batch-8 51 s (RTF 0.065, RAM 3,608 MB — batching helps files, not push-to-talk latency). **[Vendor]** https://github.com/SYSTRAN/faster-whisper/blob/master/README.md
- **Why faster or slower than whisper.cpp:** CTranslate2's int8 kernels + fused ops win when the BLAS is good; the same discussion thread shows backend dominating ISA: for 13 min audio, beam 1 — OpenBLAS AVX2 fp32 3m06s vs AVX-512 2m54s (small gain), **oneMKL AVX2 fp32 1m50s, oneMKL AVX2 int8 1m25s, AVX-512 int8 1m17s** (CPU not named in excerpt). **[Independent]** https://github.com/ggml-org/whisper.cpp/discussions/589. So: faster-whisper ≈ whisper.cpp ±30% on CPU depending on BLAS/threads/batch; it is **not** categorically faster on CPU (its big wins in the README are GPU/batch). For a Rust/Tauri app it also means a Python/CT2 sidecar vs whisper.cpp's native Rust bindings (whisper-rs) — an integration cost, not a latency one.
- **Thread/BLAS effects:** CT2 exposes cpu_threads + inter/intra-op split; oversubscription with the host app's BLAS is a real failure mode. No dictation-specific tuning study found **[Could not verify]**.

## A7. Vosk (Kaldi)

- **What is verifiable:** Official model page lists small models ~40–50 MB per language (e.g. small-cn 42 MB; big cn 1.3 GB) and their error rates (small-cn: 23.54 on SpeechIO-02, 17.15 THCHS; big cn: 13.98 / 7.43). **[Vendor]** https://alphacephei.com/vosk/models. The toolkit advertises streaming with per-language models and Raspberry Pi-class targets. **[Vendor]** https://github.com/alphacep/vosk-api/blob/master/python/README.md
- **Speed:** The macOS comparison above puts Vosk at **RTF ≈0.07** (vs whisper.cpp tiny 0.012–0.016) on an M-series Air — chart-level detail only. **[Independent]**. **No rigorous, CPU-named RTF/latency table for Vosk on desktop or low-end PC was found [Could not verify]** — claims of "several times real-time on one core for small models" circulate (e.g. forum posts) but are **[Unverifiable]**.
- **Structural notes:** True streaming, tiny CPU per chunk, near-zero first-partial by design (frame-synchronous Kaldi decoding) — but accuracy, especially Mandarin and code-switching (separate en and cn models; no single bilingual model), is a generation behind everything else in this report. Role: last-resort tier for very weak hardware / wake-word-style commands, not dictation quality.

## A8. Moonshine (tiny/base; v2 streaming)

- **Vendor paper, Apple MacBook Pro M3, end-of-utterance → transcript:** Moonshine v1 tiny **27 ms**, base **44 ms**; v2 (streaming) tiny 50 ms, small 148 ms, medium 258 ms; compute load v1 tiny 5.91%, base 7.34%. **[Vendor]** https://arxiv.org/pdf/2602.12241. TTFT at 1 s of audio (same paper): v2 tiny 13.5 ms, small 65.1 ms, medium 129.8 ms vs Whisper tiny 44.0, base 107.9, small 401.7, large-v3-turbo 2,185.9 ms.
- **Why it's fast:** variable-length encoder, no 30 s padding. The v1 paper notes Whisper tiny.en had a ~500 ms latency floor on a low-cost ARM part regardless of utterance length, and that users found that unresponsive; Moonshine tiny used ~5× less compute than Whisper tiny.en on a 10 s segment. **[Vendor]** (arXiv 2410.15608, via search excerpt.)
- **Language disqualifier for this mission's primary set:** v1 tiny/base are **English-only**; v2 streaming is English-focused. See Part B for the per-language "Flavors" models — they do not cover es/fr/it/yue and are one model *per* language.

## A9. NVIDIA Parakeet TDT 0.6B — ONNX CPU (sherpa-onnx, offline transducer)

- **Independent desktop measurements (int8, sherpa-onnx):** Intel **Core Ultra 7 155H**: **RTF 0.08 (~12× real-time)**; a short push-to-talk utterance returned in **~0.3 s vs ~2.4 s for whisper.cpp large-v3-turbo (Vulkan GPU) on the same clips** — the win is precisely the absence of the 30 s window. **[Independent]** https://github.com/vocahq/vocalinux/commit/8f4aeca2f10f8f757bb697e593995ed09d272da6
- 16-core desktop CPU (model not named), 3-sample smoke set: int8 **RTF 0.072, load 3.3 s, peak RAM 918 MB**; fp32 RTF 0.121, load 5.8 s, RAM 2,635 MB (and notably better WER on an accented sample: 5.6%→1.9% — int8 accuracy risk is real for Parakeet). **[Independent, n=3]** https://github.com/mdemin729/parlotype/blob/HEAD/docs/decisions/041-parakeet-v3-sherpa-onnx.md
- Server CPU: AMD EPYC 9V74, 8 vCPU, ONNX Runtime intra_op=8, warm, 15/30 s clips: community dynamic-int8 RTF 0.038; a static-QDQ repack RTF 0.018. **[Independent]** https://github.com/gauravvij/parakeet-optimization/blob/HEAD/models/parakeet-tdt-0.6b-v3-onnx-static-qdq-pc/README.md
- **Batch vs streaming:** All CPU numbers above are **offline/batch-mode** (whole utterance at key release). A buffered-streaming Parakeet path exists in recent sherpa-onnx (NeMo buffered transducer, latency presets computed as (chunk+right)×subsampling×frame-stride, e.g. (7+7)×8×10 ms = 1,120 ms for one preset) **[Vendor code review]** https://github.com/k2-fsa/sherpa-onnx/pull/3575 — no CPU latency measurements for streaming mode were found **[Could not verify]**.
- **Languages: English (v2) / 25 European (v3). No Chinese, no Japanese, no Korean.** Full list in Part B. For this mission Parakeet can only ever be the es/fr/it/en specialist.

## A10. FireRedASR-AED

- **CPU latency evidence for FireRedASR-AED (v1 or v2): none found.** The only benchmarks located are GPU: FireRedASR2-AED on AISHELL-1 (10 h) — PyTorch 760 s vs TensorRT 60 s on a single **NVIDIA H20 GPU** **[Vendor-contributed]** https://github.com/fireredteam/fireredasr2s/blob/HEAD/runtime/triton_tensorrt/README.md; the v2 README's example RTF 0.0870 is printed next to `use_gpu=True`. **Any CPU RTF for FireRedASR-AED circulating in secondary posts is [Unverifiable].**
- The different model **FireRedASR2-CTC (int8, sherpa-onnx)** does have CPU numbers: Ultra 7 155H — load 1,509 ms, Chinese inference 681 ms on a ~5.6 s clip → RTF 0.122, i.e. ~7.5× slower than SenseVoice on the same bench; another repo measured ~600 ms decode for 5–7 s clips vs SenseVoice's 60–90 ms. **[Independent]** https://github.com/oaklight/asr-bench ; https://github.com/bendusy/mlx-local-inference/blob/HEAD/references/asr-sherpa-onnx-sensevoice.md. Do not conflate the CTC model with the AED flagship.
- AED is a large encoder-decoder (1B-class) with beam search in its reference config (beam_size=3 in v2 examples) and a PyTorch-only distribution — structurally the wrong shape for CPU push-to-talk today.

## A11. WhisperKit / whisper.cpp CoreML — the Apple exception (ANE, not pure CPU)

- **whisper.cpp + CoreML encoder:** MacBook **M1 Air**, small model — encoder 1,030 ms on CPU (4 threads) vs **174 ms on ANE (~6×, encoder only)**; decoder stays on CPU and benefits from KV cache. **[Independent, project discussion]** https://github.com/ggml-org/whisper.cpp/discussions/548. Also note whisper.cpp's own warning: first run on a device is slow while the ANE compiles the CoreML model; subsequent runs are faster. **[Vendor]** https://github.com/vincic/whisper.cpp
- **WhisperKit (Argmax):** Stateful CoreML decoder cut a large-v3-turbo decoder forward pass from 8.4 ms → 4.6 ms and its energy from 1.5 W → 0.3 W per pass **on M3 ANE**. **[Vendor, ICML 2025 paper]** https://arxiv.org/pdf/2507.10860. Streaming word latencies reported for WhisperKit-class pipelines: hypothesis text ~0.45 s/word mean, confirmed text ~1.7 s/word **[Secondary summary]** https://github.com/cpoepke/claude-talk/blob/HEAD/docs/stt-tts-engine/whisperkit.md.
- **Implication:** On Apple Silicon the "CPU-only" constraint should be re-read as "no discrete GPU": routing the Whisper encoder (or SenseVoice/Parakeet via CoreML EP in sherpa-onnx) to ANE is the single biggest latency lever available, at *lower* battery cost than CPU. It does nothing for Windows/Linux SKUs.

## A12. Cross-cutting factors

**Threads.** Every multi-thread table found shows the same shape: strong 1→2, useful 2→4, flat or harmful beyond ~4 for these model sizes (SenseVoice A76 plateau at 3 threads; whisper.cpp community cap at 8 with UI-stutter rationale; Apple P-core-only rule). Hyperthreading: no ASR-specific controlled study found **[Could not verify]**; the mechanism (SMT siblings share SIMD units — the bottleneck resource for int8/f16 GEMM) implies counting *physical* cores. **Recommended cap: min(4, physical cores); 2 on ≤4-core machines; never logical-core count.** Contention: an offline burst at 4 threads for 100–500 ms is invisible; a streaming engine holding 2 threads for a whole 60 s dictation is not — prefer burst architectures on shared machines.

**Quantization.** ONNX int8 (SenseVoice, Paraformer, Parakeet): consistent 1.4–2.3× speedups and ~2–4× size cuts, CER/WER cost ≈0 to +0.4 pt in the sourced tables (Paraformer 1.95→1.95; FunASR Q8 +0.3–0.36 pt CER; Parakeet int8 had one bad accented outlier, 5.6 vs 1.9% WER fp32, n=3). ggml q8/q5 (Whisper): size win certain, **speed win not** (q5 slower than f16 in one study, A5). CTranslate2 int8: clear win in its own bench (RTF 0.201→0.131). Rule: quantize ONNX models aggressively; for whisper.cpp prefer q8 for size/RAM, do not promise users a speedup.

**Instruction sets.** AVX2 is the real floor for x86 (see the 8–14× no-SIMD cliff, A5). AVX-512/VNNI: small for Whisper-class fp32 (3m06s→2m54s) but useful for int8 (1m50s→1m25s→1m17s across BLAS/ISA changes, A6) — order 10–30%, not multiples. ARM NEON: all Apple/ARM numbers above are NEON(+dotprod) builds; sherpa-onnx and ggml both dispatch at runtime in current releases — ship runtime-dispatch builds, never `-march=native` from CI. CPUs without AVX2 (pre-2013 x86, some VMs masking features) fall to the fallback tier in Part C.

**Utterance length.** NAR/CTC/transducer offline models: cost ≈ linear in duration with a small constant (SenseVoice RTF flat 0.014–0.017 across 4.6–7.2 s; ~0.05 on 44–60 s segmented clips). Whisper: cost is a **step function of 30 s windows** — a 3 s and a 29 s utterance cost nearly the same; a 31 s utterance costs ~2× a 29 s one; pseudo-streaming re-decode makes cost grow super-linearly with buffer length (WhisperStreaming's 3.3 s latency is the price of capping that growth with LocalAgreement). Long-form dictation (60–120 s): segment on VAD pauses into ≤30 s pieces for *every* engine; for SenseVoice segmentation is also an *accuracy* requirement (A3). Warm-up: first inference after load is consistently slower (ONNX arena growth, CoreML compile, ggml buffer allocation) — run one dummy decode at startup; no source quantifies the penalty per engine **[Could not verify — measure in-house]**.

**Decoding settings.** Greedy everywhere for dictation; beam 5 is the Whisper *benchmark* default and roughly doubles decode-side cost vs greedy in the traces found (no clean controlled table — flag). Modified beam search is required for sherpa hotwords — budget ~+30% CPU (one Tauri project's design note estimate, **[Unverifiable]**). Endpointing: sherpa defaults rule1 2.4 s / rule2 1.2 s trailing silence **[Vendor docs]** https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-paraformer/paraformer-models.html; one dictation integration retuned these to 1.0/0.6 s and describes text committing ~0.6 s after speech stops **[Independent]** https://github.com/niaodian/voicestudio/blob/HEAD/docs/engines/sherpa-onnx-asr.md. The endpointer *is* the user-perceived latency in hands-free ASR (the UPL literature's central result: UPL is dominated by endpointer design and token-emission loss) **[Peer-reviewed]** https://arxiv.org/pdf/2104.02207v2. Punctuation/ITN: SenseVoice has ITN built in (flag in the sherpa config; cost not separately measured **[Could not verify]**); FunASR's separate ct-punc model is an extra full pass — **no CPU latency figure found [Could not verify]**; Whisper emits punctuation natively. Budget punctuation as an async post-final step until measured.

**Perceived-latency budgets (dictation UX).** Anchors with provenance: (i) Moonshine's team reports users rejected a ~500 ms floor as unresponsive for live transcription **[Vendor]**; (ii) a cloud dictation incumbent (Wispr Flow) claims <700 ms at p99 end-to-end, relayed second-hand **[Unverifiable]** https://github.com/ilyaskhallouki/hyprsay/blob/HEAD/docs/research/vision/prior-art.md; (iii) conversational-agent research finds UX degrades significantly above ~4 s response latency **[Peer-reviewed-ish preprint]** https://arxiv.org/pdf/2507.22352; (iv) voice-AI SLO guides put STT first-partial p95 <300 ms for sub-second pipelines **[Industry blog, weak]** https://futureagi.com/blog/how-to-measure-voice-ai-latency-2026. **Engineering budget adopted for Part C:** first partial <300 ms feels instant, 300–600 ms acceptable, >1 s slow; endpoint-to-final (push-to-talk) <500 ms instant-feeling, 0.5–1.5 s acceptable, >2 s users re-press the key / lose trust, >4 s broken. These are design budgets synthesized from the anchors above, not a single published standard — label them as such in the design doc.

## A13. Synthesis — per-engine latency table (short dictation, 3–10 s, CPU-only)

| Engine / model | First partial | Endpoint→final (PTT) | RTF (stated config) | Sustained CPU | Peak RAM | Cold load | Source class |
|---|---|---|---|---|---|---|---|
| SenseVoiceSmall int8, sherpa-onnx | n/a (offline; pseudo-partials via VAD segments possible) | **~0.08–0.15 s** modern; ~0.6–1.2 s on i5-3570 | 0.014–0.016 (Ultra 155H); 0.123 (i5-3570, 2 thr) | burst only | ~373 MB | 0.5–2.3 s | Independent |
| Zipformer bilingual int8, streaming | ~320 ms chunk floor (compute incl. ~0.35–0.45 s, unverified) | endpoint rule (0.6–2.4 s) or ~chunk flush on key-up | 0.221 (1 thr, fp32 files, CPU unnamed); 0.06 (unverified bench) | ~6–22% of 1 core while speaking | not published | ~0.3 s class | Vendor + unverified |
| Streaming Paraformer (sherpa/FunASR) | 0.6–0.9 s floor; measured 0.8–1.6 s (conflicting, small-n) | ~0.55 s finish in one probe + tail-truncation risk | chunk compute 7–33 ms | low, continuous | up to ~1.5 GB (large bilingual probe) | not published | Vendor config + independent probes |
| Paraformer-large offline (ONNX int8) | n/a | RTF×duration (≈0.45 s @10 s, 1-thr Xeon) | **0.0446** (Xeon E5-8269CY, 1 thr) | burst | ~1 GB class (PyTorch stack heavier) | not published | Vendor paper |
| whisper.cpp base f16 | pseudo-streaming only (≥1.5–3.3 s wrappers) | ~0.5–1.5 s (window floor; derived) | ~0.10 (8 thr, CPU unnamed, zh clips) | burst, high | ~388 MB | 0.27 s (base.en, one trial) | Mixed |
| whisper.cpp small f16 | same | ~1–3 s (derived) | 0.160 (i7-12700K, 8 thr, beam5); 0.217 (zh bench) | burst, high | ~852 MB | ~0.65 s (one run) | Vendor |
| whisper.cpp large-v3-turbo | same | ~2.4 s in Parakeet comparison (GPU build!); CPU worse | 0.313 (8 thr, zh bench) | burst, very high | ~2–4 GB class | 2.61 s (one trial) | Mixed |
| faster-whisper small int8 (CT2) | n/a (offline) | RTF×duration | 0.131 (i7-12700K, 8 thr, beam5) | burst | 1,477 MB | not published | Vendor |
| Vosk small (per-language) | ~frame-level (by design, unmeasured) | fast (unmeasured) | ~0.07 (M-series Air, chart-level) | very low, continuous | ~100 MB class | fast (unmeasured) | Vendor claims + 1 study |
| Moonshine tiny/base (en only) | v2 TTFT 13.5 ms @1 s audio (M3) | **27/44 ms** (M3, vendor) | load 5.9–7.3% compute | very low | ~200–400 MB class | not published | Vendor |
| Parakeet TDT 0.6B int8 (offline) | n/a (batch); streaming unmeasured | **~0.3 s** short utterance (Ultra 155H) | 0.072–0.08 (desktop int8) | burst | 918 MB (int8) | 3.3 s | Independent |
| FireRedASR-AED | — | — | **no CPU data exists** | — | — | — | — |
| WhisperKit / CoreML (ANE) | hypothesis ~0.45 s/word | encoder 6× faster than CPU path | n/a (not CPU) | ANE ~0.3 W/pass | model-size dependent | + first-run ANE compile | Vendor |

## A14. Rankings

**(a) Lowest first-partial:** 1) Moonshine v2 tiny (13.5 ms TTFT @1 s, M3 — but English only) 2) Zipformer bilingual (~320 ms chunk floor; only true-streaming zh-en option) 3) Vosk (frame-level by design, unmeasured, low accuracy) 4) Streaming Paraformer (600 ms+ floor) 5) any Whisper wrapper (seconds).
**(b) Lowest endpoint-to-final, 3–10 s PTT:** 1) SenseVoiceSmall int8 (~0.1 s modern) 2) Parakeet int8 (~0.3 s; no zh/ja/ko) 3) Paraformer-large ONNX int8 (~0.45 s @10 s on 1 server thread) 4) Moonshine (en only) 5) whisper.cpp base 6) faster-whisper small int8 / whisper.cpp small 7) turbo/large anything.
**(c) Lowest sustained CPU:** 1) Vosk small 2) Moonshine tiny 3) Zipformer streaming (~6–22% of a core) 4) SenseVoice (burst-only ≈ near-zero average in PTT use) — note (c) rewards streaming engines on a per-second basis but PTT-burst engines win on *total* energy per dictation.
**(d) Best on older/low-end PCs:** 1) SenseVoiceSmall int8 at 2 threads (proven RTF 0.123 on a 2012 i5-3570) 2) Zipformer bilingual int8 3) Vosk (if accuracy suffices) 4) whisper.cpp base q8 — everything Whisper-small-and-up is a liability on old quads, and no-AVX2 machines fall off a cliff for ggml builds.

---

# PART B — RECOMMENDED DOWNLOAD MODEL SIZE, BY LANGUAGE COVERAGE (8 LANGUAGES)

Requirement restated: **en + zh (Mandarin) + yue (Cantonese) are primary; ja, es, fr, it, ko must also be good.** "Good" below means: officially supported by that checkpoint (not "the research project supports it"), with an accuracy signal from a named benchmark where one exists.

## B1. Language coverage matrix — one row per candidate, gaps explicit

Legend: ● supported, with sourced accuracy signal · ◐ nominally supported / weak or caveated · ○ **not supported by this checkpoint**.

| Model (one download) | en | zh | yue | ja | es | fr | it | ko | Coverage of the 8 |
|---|---|---|---|---|---|---|---|---|---|
| **Whisper** (any multilingual size: tiny→large-v3, incl. taomni's base/small/medium) | ● | ● | ◐ | ● | ● | ● | ● | ● | **8/8 nominally** — the *only* single-model family covering all 8 |
| SenseVoiceSmall (int8 ONNX, 229 MB) | ● | ● | ● | ● | ○ | ○ | ○ | ● | **5/8 — missing es, fr, it entirely** |
| Streaming Zipformer bilingual zh-en (sherpa) | ● | ● | ○ | ○ | ○ | ○ | ○ | ○ | 2/8 |
| Streaming/offline Paraformer zh (FunASR/sherpa) | ◐ (bilingual variants) | ● | ◐ (trilingual variant incl. Cantonese) | ○ | ○ | ○ | ○ | ○ | ~2–3/8 |
| Parakeet TDT 0.6B v3 (int8) | ● | ○ | ○ | ○ | ● | ● | ● | ○ | **4/8 — the European half; no zh/yue/ja/ko** |
| Parakeet TDT 0.6B v2 | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 1/8 |
| Moonshine tiny/base + v2 (en) | ● | ○ | ○ | ○ | ○ | ○ | ○ | ○ | 1/8 |
| Moonshine "Flavors" tiny (per-language) | (en separate) | ● (zh flavour) | ○ | ● (ja flavour) | ○ | ○ | ○ | ● (ko flavour) | 4/8 **only by downloading 4 separate monolingual models**; no es/fr/it/yue flavours exist in the set |
| Vosk small (per-language) | ● | ● (weak) | ○ | ● | ● | ● | ● | ● | 7/8 only as **7 separate downloads**, no code-switching, weakest accuracy (B3) |
| FireRedASR-AED / -CTC | ● | ● | ◐ (dialects claimed) | ○ | ○ | ○ | ○ | ○ | 2/8 + no CPU case (A10) |
| FunASR Paraformer-large / SenseVoice-Large (research) | ● | ● | ● | ● | ◐ claimed in 50+ research scope | ◐ | ◐ | ● | Not a shippable small checkpoint — do not count |

Primary-source anchors for the gaps:
- **SenseVoiceSmall = exactly 5 languages.** The released checkpoint's own README scopes it to Mandarin, Cantonese, English, Japanese, Korean; the "50+ languages" headline belongs to the SenseVoice research project, not this checkpoint. **[Vendor]** https://github.com/qwenaudio/sensevoice
- **Parakeet v3 = exactly 25 European languages** (bg, hr, cs, da, nl, en, et, fi, fr, de, el, hu, it, lv, lt, mt, pl, pt, ro, sk, sl, es, sv, ru, uk) with automatic language ID. No Asian language is in the list. **[Vendor]** https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- **Whisper's Cantonese caveat (important for taomni's existing files):** pre-large-v3 Whisper has a **single `zh` label**; OpenAI's maintainer notes Cantonese speech was sometimes rendered into standard written Mandarin, and **large-v3 added a separate `yue` code** with better Cantonese accuracy expected. **[Vendor]** https://github.com/openai/whisper/discussions/25 and https://github.com/openai/whisper/discussions/366. taomni's base/small/medium ggml files are the original-generation checkpoints (not large-v3), so their yue behaviour is the ◐ row above: usable, not dedicated.
- Moonshine Flavors: monolingual tiny models released for Arabic, **Chinese, Japanese, Korean**, Ukrainian, Vietnamese — one language per 27M model. **[Vendor]** https://arxiv.org/abs/2509.02523v1

## B2. Accuracy signals per language (sourced; everything else is marked unverified)

Two comparable benchmark families exist. **Do not compare across families** (different test sets/normalization).

**Family 1 — FunAudioLLM paper, Common Voice (CER for zh/yue/ja/ko, WER for en), GPU evaluation, batch/beam per paper [Vendor]:** https://fun-audio-llm.github.io/pdf/FunAudioLLM.pdf (Table 6)

| Lang | SenseVoice-Small | Whisper-Small | Whisper-Large-v3 |
|---|---|---|---|
| zh | **10.78** | 19.60 | 12.55 |
| yue | **7.09** | 38.97 | 10.41 |
| en | 14.71 | 14.85 | **9.39** |
| ja | **11.96** | 19.51 | 10.34 |
| ko | **8.28** | 10.48 | 5.59 |
| es/fr/it | n/a (unsupported) | see Family 2 | see Family 2 |

Reading: at *small* scale SenseVoice crushes Whisper on zh/yue/ja/ko and ties on en; Whisper only catches up at large-v3 scale (6×+ the parameters) — and still loses yue and zh to SenseVoice-Small on this set.

**Family 2 — Whisper small vs medium, reproduced OpenAI greedy results (OWSM paper, Table 3) [Independent reproduction]:** http://arxiv.org/pdf/2309.13876v3

| Lang / set | Whisper Small | Whisper Medium |
|---|---|---|
| es (MLS WER) | 9.1 | **6.1** |
| fr (MLS WER) | 13.6 | **9.7** |
| it (MLS WER) | 21.3 | **15.6** |
| zh (AISHELL-1 CER) | 25.1 | **15.7** |
| ko (KsponSpeech clean / other, CER) | 24.0 / 15.4 | **17.6 / 12.8** |
| ja (ReazonSpeech WER) | 32.5 | **25.3** |
| en (MLS WER) | 9.1 | 10.2 (anomaly in source — small beats medium here) |

Plus, from Part A: Mandarin CER on the FunASR 184-clip set — whisper.cpp **base 31.33 / small 22.12 / large-v3-turbo 23.15 vs SenseVoice Q8 8.17** (contested provenance, ordering reliable). Parakeet v3: multilingual average WER **4.81, equal to Whisper large-v3**, on the Open ASR Leaderboard's de/fr/it/es/pt sets **[Leaderboard via secondary summary]** https://localaimaster.com/blog/best-local-speech-to-text-models.

**Unverified / no signal found:** per-language CER/WER for **Whisper Base** on es/fr/it/ja/ko dictation-style audio (only zh CER 31.33 above and general "base is much worse than small on non-English" consensus); per-language WER for Parakeet v3 *individually* for es/fr/it (only the 5-language average); any accuracy figure for Vosk on es/fr/it/ko dictation beyond its vendor page's zh/en data (small-cn CER-equivalents 23.54 SpeechIO-02 / 17.15 THCHS **[Vendor]** https://alphacephei.com/vosk/models); SenseVoice on accented/code-switched zh-en (no sourced number).

## B3. Exact download sizes — Whisper ggml (verified from the file listing)

**Verified live on 2026-10-08** from https://huggingface.co/ggerganov/whisper.cpp/tree/main (decimal MB/GB as displayed there). These are the canonical `ggerganov/whisper.cpp` files a Tauri app would fetch:

| Model | f16 (default ggml) | q8_0 | q5 (q5_1 small/tiny/base; q5_0 medium/large/turbo) | RAM in use (whisper.cpp README, f16) |
|---|---|---|---|---|
| tiny | 77.7 MB | 43.5 MB | 32.2 MB | ~273 MB |
| base | **148 MB** | 81.8 MB | 59.7 MB | ~388 MB |
| small | **488 MB** | 264 MB | 190 MB | ~852 MB |
| medium | **1.53 GB** | 823 MB | 539 MB | ~2.1 GB |
| large-v3 | 3.1 GB | (no q8 file in listing) | 1.08 GB | ~3.9 GB |
| large-v3-turbo | 1.62 GB | 874 MB | 574 MB | ~2–4 GB class (not in README table) |

Non-Whisper downloads: SenseVoiceSmall int8 ONNX **229 MB** (+ Silero VAD <1 MB); Parakeet v3 int8 sherpa set **~660–670 MB** (multiple sources; one PR's ~465 MB figure is inconsistent with its own file list — use ~670 MB) ; Zipformer bilingual set ~200 MB; streaming Paraformer bilingual ~240 MB. **[Independent listings]** https://github.com/niaodian/voicestudio/blob/HEAD/docs/engines/sherpa-onnx-asr.md ; https://github.com/spyhack225/next-notes/blob/HEAD/docs/PARAKEET-WINDOWS.md

**Key observation for taomni:** its three existing files (148 / 488 MB / 1.53 GB) match the **f16** column byte-for-byte. taomni is currently paying full f16 download and RAM for every tier while getting *no* accuracy benefit over q8 (ggml q8 WER ≈ f16 in the study in A5) and, per A5, no reliable CPU speed penalty either. Simply re-pointing the same three tiers at q8_0 files cuts downloads to 81.8 / 264 / 823 MB (−45%) and roughly halves resident weight memory.

## B4. Recommended tiers (download size × latency × 8-language accuracy)

RTF/final-latency figures are carried from Part A (same configs); final latency is for a 10 s push-to-talk utterance on a modern laptop CPU unless stated.

### Default tier — balance (choose ONE as the shipping default; see B6 for the verdict)
| Candidate | Download | RAM | Final latency @10 s | 8-language verdict |
|---|---|---|---|---|
| **Whisper Small q8_0** (whisper.cpp) | **264 MB** | ~450–600 MB (est. from f16 852 MB minus weight delta; not directly measured — flag) | RTF 0.16–0.22 → **1.6–2.2 s** (beam5/i7-12700K & zh bench; greedy less) | All 8 covered; zh/yue/ja/ko noticeably weak (zh CER 22–25, yue 39 on CV vs SenseVoice 7–11); es/fr/it fair (WER 9/14/21) |
| SenseVoiceSmall int8 **+** Whisper Small q8_0 (combo, B5) | 229 + 264 = **493 MB** | one engine resident at a time (~390 MB SenseVoice / ~600 MB Whisper) | zh/yue/en/ja/ko **~0.15 s**; es/fr/it 1.6–2.2 s | All 8 covered; best-in-class on 5, Whisper-grade on 3 |

### Lightweight tier — low-end / old PCs, small download
| Candidate | Download | RAM | Final latency @10 s | Verdict |
|---|---|---|---|---|
| **SenseVoiceSmall int8 alone** | **229 MB** | ~373 MB | **~0.15 s** modern; ~1.2 s on 2012 quad | Best latency+zh/yue/en/ja/ko per byte in this entire report; **es/fr/it unsupported — must be disclosed in UI**, not silently failed |
| Whisper Base q8_0 | 81.8 MB | ~250 MB class | RTF ~0.10 (8 thr) → ~1.0 s | All 8 nominally, but zh CER ~31 and weak ja/ko — a *coverage* fallback, not a quality tier |
| Whisper Tiny q5_1 | 32.2 MB | ~273 MB (f16 figure) | fastest Whisper | English commands only in practice; non-English accuracy **[Unverified]** but certainly poor — do not market as 8-language |

### High-accuracy tier — high-end PCs, opt-in download
| Candidate | Download | RAM | Final latency @10 s | Verdict |
|---|---|---|---|---|
| **Whisper large-v3-turbo q5_0** | **574 MB** | ~1.5–2 GB class | RTF 0.313 → **~3.1 s** (8 thr, zh bench) | Best single-model 8-language accuracy available at sane size; dedicated `yue` code (large-v3 generation); still loses zh/yue to SenseVoice on Family-1 numbers |
| Whisper Medium q8_0 (= taomni Medium, quantized) | 823 MB | ~1.2 GB class (est.) | RTF ~0.25–0.35 class (derived; no clean CPU table — flag) | Better es/fr/it/zh than Small (Family 2), but **dominated by turbo-q5_0**: bigger download, older generation, no yue code, likely slower — see B6 |
| Parakeet v3 int8 (add-on specialist) | ~670 MB | 918 MB | **~0.3 s** | Only as an es/fr/it/en accelerator alongside a zh engine; never standalone for this language set |
| Whisper large-v3 q5_0 | 1.08 GB | ~2 GB class | >3 s @10 s (derived) | Only if translation task or max accuracy is required; poor latency value |

## B5. Combo方案 (no single small model satisfies "zh+yue strong + other 6 good + small")

The tension is real and structural: SenseVoice's strength comes from *not* spending capacity on European languages; Whisper's coverage comes from spending capacity on 99 languages and needing scale (≥small, ideally turbo) before zh/yue are good; Parakeet is European-only by design. Hence:

**Combo A (recommended combo): SenseVoiceSmall int8 (229 MB) + Whisper Small q8_0 (264 MB) = 493 MB total.**
- Routing: use SenseVoice's built-in language ID + the user's UI language/hint. If detected/selected language ∈ {zh, yue, en, ja, ko} → SenseVoice. If ∈ {es, fr, it} → Whisper Small. If LID is uncertain between the two sets, default to SenseVoice for zh/en-mixed dictation (the primary use case) and surface a one-tap "re-run with Whisper" action.
- Code-switching zh↔en inside one utterance: SenseVoice (it is trained for zh-en mixed input in its 5 languages; Whisper Small's zh is far worse). es/fr/it mixed with zh in one utterance: neither is good — Whisper by default; **[Unverified]** for both, no sourced mixed-language benchmark.
- Cost: two engines to integrate — but both run under sherpa-onnx *or* the FunASR GGUF runtime on one side and whisper-rs on the other; in practice SenseVoice via sherpa-onnx + whisper.cpp covers it with two Rust-friendly runtimes. Memory is fine if only one is resident (load on switch; ~0.5–2 s switch cost from A3/A5 load times).
- Upgrade path inside the combo: replace Whisper Small q8 (264 MB) with **large-v3-turbo q5_0 (574 MB) → total 803 MB** when the user enables "high accuracy" — the es/fr/it leg jumps a full generation and gains the dedicated yue code as a Whisper-side bonus.

**Combo B: SenseVoiceSmall (229 MB) + Parakeet v3 int8 (~670 MB) = ~899 MB.** Best *latency* on 7/8 languages (both engines ≤0.3 s finals) and Parakeet's es/fr/it ≈ large-v3 quality — but **no fallback at all** for anything outside the union, Parakeet's int8 accented-speech outlier (A9), and the largest total. Only sensible if es/fr/it usage is heavy and measured.

**Single-model vs combo:**

| | Single: Whisper Small q8 (264 MB) | Combo A (493 MB) | Combo A+turbo (803 MB) |
|---|---|---|---|
| Download | smallest full-coverage | +229 MB | +539 MB vs single |
| zh/yue quality | weak (CER 22 / WER 39 CV) | **strong (11 / 7)** | strong (+ turbo as backup) |
| ja/ko | weak-moderate | **strong** | strong |
| es/fr/it | fair | fair (same Whisper) | **good (turbo)** |
| Final latency, primary langs | 1.6–2.2 s | **~0.15 s** | ~0.15 s |
| Final latency, es/fr/it | 1.6–2.2 s | 1.6–2.2 s | ~3.1 s |
| Engineering cost | one engine | two engines + LID routing | same + tier logic |
| Failure mode | mediocre everywhere | routing mistakes (mitigated by UI language picker) | same |

## B6. Verdict on taomni's existing three tiers, and the explicit首选推荐

**Are Base 148 MB / Small 488 MB / Medium 1.53 GB (all f16, multilingual) enough for the 8 languages?**
- *Coverage:* yes — Whisper multilingual is the only family here that covers all 8 in one file. No tier is "missing" a language.
- *Base (148 MB):* **Not enough as a dictation default for this language set.** Its only sourced non-English figure is Mandarin CER 31.33 (vs small 22.12, SenseVoice 8.17); with ja/ko/es/fr/it all scaling the same direction, Base is a demo tier. Keep only as the low-end *fallback* — and then as q8 (81.8 MB), not f16.
- *Small (488 MB):* **The only defensible current default** — but it should be the **q8_0 file (264 MB)**, not the f16: same accuracy class, −46% download, less RAM, no reliable speed loss (A5). As shipped today (f16) it is simply overweight.
- *Medium (1.53 GB):* **Poor value as the top tier.** It improves es/fr/it/zh over Small (Family 2: e.g. it WER 21.3→15.6, zh CER 25.1→15.7), but large-v3-turbo q5_0 is **574 MB (⅓ the download)**, a generation newer, has the dedicated `yue` language code that Medium lacks, and has a sourced CPU RTF (0.313). Medium f16 is dominated on every axis except possibly raw en accuracy — replace it.

**Explicit recommendations:**
1. **If only ONE model may be downloaded by default: Whisper Small, q8_0 quantization — `ggml-small-q8_0.bin`, 264 MB** (whisper.cpp). It is the smallest single file that covers all 8 languages at usable (not good) quality, runs at RTF ~0.16–0.22 on a modern CPU, and fits in ~0.5 GB RAM. Accept and document its weakness: zh/yue dictation will visibly lag SenseVoice-class quality.
2. **Preferred shipping configuration (the actual recommendation): default-download Combo A — SenseVoiceSmall int8 (229 MB) + Whisper Small q8_0 (264 MB) = 493 MB total**, i.e. roughly the size of taomni's *current Small f16 alone*, with an order-of-magnitude better latency and accuracy on the three primary languages plus ja/ko, and identical es/fr/it to option 1. The 493 MB buys out the single biggest product risk (Chinese dictation quality/latency) for the price of 229 MB.
3. **Tier reshuffle for taomni's menu:** Lightweight = SenseVoiceSmall int8 alone (229 MB, disclose es/fr/it gap) *or* Whisper Base q8_0 (81.8 MB) on very weak hardware · Default = Combo A (493 MB) · High-accuracy opt-in = swap the Whisper leg to large-v3-turbo q5_0 (total 803 MB) · Remove Medium f16 (1.53 GB) entirely; if a Medium entry must remain for compatibility, point it at medium-q8_0 (823 MB).
4. On Apple Silicon, add the CoreML encoder for whichever Whisper file is chosen (+163 MB for small's encoder zip) — it is an ANE download, not CPU, and is the cheapest latency reduction available (A11).

---

# PART C — CONFIGURATION RECOMMENDATIONS FOR THE TAURI APP

**Default engine/model:** SenseVoiceSmall int8 via sherpa-onnx (Rust crate binding the same C API) as the primary dictation engine for zh/yue/en/ja/ko + Whisper Small q8_0 via whisper-rs as the es/fr/it + general fallback (Combo A, B6). If management insists on a single-engine v1: Whisper Small q8_0 alone, with the zh-quality caveat documented.
**Thread policy:** `min(4, physical_cores)`; default 2 on ≤4-core machines; on Apple Silicon cap at performance-core count; never use logical (SMT) count; expose a settings override. Run inference off the UI thread (dedicated worker / `spawn_blocking`); keep one core headroom for the host app during the burst.
**Chunk/VAD settings (push-to-talk):** Key-down starts capture + (optional) Zipformer partials; **key-up is the endpoint** — call `inputFinished()`, flush the tail chunk (feed ≤0.66–1.0 s silence equivalent if using a streaming engine), decode once with SenseVoice/Whisper on the trimmed buffer. Trim leading/trailing silence with Silero VAD (sherpa built-in) before offline decode — this also defeats Whisper's 30 s padding waste on short utterances. Hands-free mode (if any): Silero `min_silence_duration` 0.3–0.5 s; if sherpa endpoint rules are used, rule2 trailing silence 0.6–0.8 s (not the 1.2/2.4 s defaults); segment long dictation at VAD pauses, max segment 25–30 s.
**Decoding:** Greedy everywhere; temperature fallback for Whisper; hotwords via modified beam search only when the user has a hotword list (accept the CPU cost then); ITN on for SenseVoice; punctuation as-is from SenseVoice/Whisper (no separate punc model in the latency path until measured).
**Fallback tiers by CPU detection (at first run, cached):** Detect AVX2 (x86) / NEON+dotprod (ARM), physical cores, RAM. Tier 1 (AVX2/NEON, ≥4 cores, ≥8 GB): Combo A as above. Tier 2 (AVX2, 2–4 cores or <8 GB): SenseVoice int8 (2 threads) + Whisper Base q8_0. Tier 3 (no AVX2, or 2 cores, or <4 GB): SenseVoice int8 1–2 threads alone (it still ran RTF 0.123–0.226 on a 2012 quad) with es/fr/it shown as unsupported, or Vosk per-language small models if even that fails — plus a plain warning. Never ship a `-march=native` ggml binary; use runtime-dispatch builds.
**Warm-up:** Load the default engine at app start (load 0.5–2.3 s, off the critical path), run one 1 s dummy decode, keep resident; unload the non-active combo leg on <8 GB machines.
**Apple Silicon exception:** Prefer CoreML EP (sherpa-onnx) / CoreML encoder (whisper.cpp) when available; fall back to CPU silently.

**In-house benchmark to run before locking this design (no published bench covers your exact matrix):**
- *Test set:* ≥50 recorded dictations per language × 8 languages, lengths 2/5/10/30/60/120 s, including zh-en code-switch, yue colloquial (written-Cantonese reference, not Mandarin-normalized), quiet/noisy mic, proper nouns/hotwords. Human references; CER for zh/yue/ja/ko, WER for en/es/fr/it.
- *CPUs:* one modern desktop (e.g. i7-12700K/Ryzen 7600 class), one Apple M1/M2, one i5-8250U-class laptop, one i7-6700K-class desktop, one pre-AVX2 or AVX2-masked VM config.
- *Metrics (the A0 seven, per engine×quant×threads 1/2/4):* cold load (median of 5 cold starts), first-partial p50/p95, chunk p95, endpoint-to-final p50/p95 at each duration (key-release referenced, not VAD referenced), RTF vs duration curve, sustained % of one core + total CPU-seconds per dictation, peak RSS, UI frame-drop during decode (Tauri webview jank), fan/battery proxy (package energy via RAPL/powermetrics where available), CER/WER per language, tail-truncation failure count (Paraformer/Zipformer flush), first-inference warm-up penalty.
- *Acceptance gates suggested:* endpoint-to-final p95 <500 ms @10 s on the modern tier for the primary engine; <2 s on the i5-8250U tier; no tier above RTF 1.0 at 2 threads.

## Could not verify (explicit — do not fill these in from intuition)
1. whisper.cpp RTF on a named i7-6700K or i5-8250U (any model) — bounded by inference only (A5).
2. Zipformer bilingual: thread-scaling table, RSS, desktop time-to-first-partial, cold load for that specific model.
3. Vosk: any CPU-named RTF/latency table on desktop/low-end PC; per-language accuracy beyond vendor zh/en data.
4. FireRedASR-AED: *any* CPU latency/RTF figure (only GPU data exists).
5. Parakeet streaming-mode CPU latency (only offline/batch CPU data exists); Parakeet v3 per-language (es/fr/it individually) WER.
6. Whisper Base per-language WER/CER for es/fr/it/ja/ko; beam-1 vs beam-5 controlled whisper.cpp comparison; first-inference warm-up penalty per engine; FunASR ct-punc CPU cost; SenseVoice ITN incremental cost; hyperthreading-specific ASR scaling.
7. RAM for Whisper q8 builds (estimated from weight deltas, not measured) and for Zipformer bilingual.
8. The ~465 MB Parakeet int8 size in one PR (inconsistent with other sources' ~660–670 MB) — 670 MB used, flagged.

## Sources (all accessed 2026-10-08; paraphrased, with flags in-line above)
Key primaries: sherpa-onnx docs https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html · https://k2-fsa.github.io/sherpa/onnx/python/decode-files.html · SenseVoice RTF table https://github.com/k2-fsa/sherpa/blob/HEAD/docs/source/onnx/sense-voice/pretrained.rst · FunASR paper http://arxiv.org/pdf/2305.11013v1 · FunAudioLLM paper https://fun-audio-llm.github.io/pdf/FunAudioLLM.pdf · SenseVoice scope https://github.com/qwenaudio/sensevoice · GGUF head-to-head https://github.com/qwenaudio/sensevoice/blob/HEAD/runtime/llama.cpp/BENCHMARKS.md · Oaklight bench https://github.com/oaklight/asr-bench · faster-whisper https://github.com/SYSTRAN/faster-whisper/blob/master/README.md · whisper.cpp https://github.com/vincic/whisper.cpp · Whisper file sizes (verified live) https://huggingface.co/ggerganov/whisper.cpp/tree/main · Parakeet v3 card https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3 · Moonshine v2 https://arxiv.org/pdf/2602.12241 · Moonshine Flavors https://arxiv.org/abs/2509.02523v1 · WhisperKit https://arxiv.org/pdf/2507.10860 · OWSM reproduction http://arxiv.org/pdf/2309.13876v3 · Vosk models https://alphacephei.com/vosk/models · FireRedASR2 TensorRT https://github.com/fireredteam/fireredasr2s/blob/HEAD/runtime/triton_tensorrt/README.md · UPL https://arxiv.org/pdf/2104.02207v2 · Whisper yue discussions https://github.com/openai/whisper/discussions/25 , https://github.com/openai/whisper/discussions/366. Full per-source notes: `notes/sources.md`, `notes/language-model-size.md`.
