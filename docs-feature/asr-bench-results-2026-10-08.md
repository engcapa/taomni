# ASR exploratory baseline — 2026-10-08

Status: **P0 incomplete; not a P1 selection decision**. This run establishes that
the benchmark harness can drive production CPU-only Whisper and retain honest
measurements. One Mandarin recording on one old CPU cannot establish eight-language
quality, model ranking, p95 latency or the default combination.

## Setup

- CPU: Intel Core i7-6700K @ 4.00 GHz, 4 cores / 8 logical CPUs.
- Host: Linux 6.14.0-37-generic, x86_64, glibc 2.39.
- Runtime: production whisper-rs 0.16, CPU only, greedy decoding, 4 threads.
- Sample: Google FLEURS `cmn_hans_cn`, test ID 1906, 10.38 seconds, 16 kHz mono.
- Ground truth: 这并不是告别。这是一个篇章的结束，也是新篇章的开始。
- Exact source/audio hash/license: `qa-ui-auto-tests/fixtures/voice/benchmark-smoke.json` and sibling README.
- Each row is one fresh recognizer process; model verification is included in cold
  load. The OS file cache was not flushed. No repeat distribution is claimed.
- CER normalization: NFKC + casefold, Unicode punctuation removed, whitespace
  excluded. No simplified/traditional conversion. WER uses whitespace and is not
  a useful segmented Chinese WER; retained below for transparency.
- Peak memory is the native test process high-water RSS, including runtime overhead.

## Measured results

| Model | Quantization | Threads | Audio s | CER | WER | Cold load ms | Decode ms | RTF | Peak RSS MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Whisper base | f16 | 4 | 10.38 | 0.3913 | 1.0000 | 4329.1 | 2108.9 | 0.2032 | 399.3 |
| Whisper small | f16 | 4 | 10.38 | 0.4783 | 1.0000 | 14328.3 | 7467.7 | 0.7194 | 838.2 |

First-partial and endpoint→final latency are **unavailable**, because these are
batch Whisper runs. They are null in raw results, not zero latency.

## Raw outputs and provenance

- base: `這並不是告別這是一個偏章的結束也是新偏章的開始`
  - Weight SHA-256: `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`
  - Raw report: `qa-ui-auto-report/asr/bench-base-final-20261008/results.json`
- small: `這並不是告別,這是一個偏張的結束,也是新偏張的開始。`
  - Weight SHA-256: `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`
  - Raw report: `qa-ui-auto-report/asr/bench-small-final-20261008/results.json`

Native probe SHA-256: `e4c972767196d1cf196d5a1efba86f4721c05ef38e25ebb201e7d63c5ea520df`.
The JSON receipts also retain manifest/adapter/source-file hashes and the source
commit with its dirty flag. Build command: `cargo test --manifest-path
src-tauri/Cargo.toml --lib asr:: --no-run --message-format=json`.
Reproduction commands and adapter contract: `scripts/asr-bench/README.md`.

Both outputs use traditional characters while the reference uses simplified
characters, and misrecognize 篇章. This strict score intentionally includes those
differences. The existing Chinese regression uses a narrower sentence-specific
traditional-character mapping; its threshold is not comparable to this score.
Do not claim Small is generally worse based on this single sentence.

## Initial smoke evidence gaps (superseded in part below)

- Full P0 corpus (20 distinct recordings per language, 20 mixed, 10 code/path,
  noise and silence). At the initial smoke run, coverage was Mandarin 1/20; expanded coverage is below.
- Modern CPU comparison; this workstation covers only the old-CPU class.
- q8/SenseVoice/Zipformer and online-provider adapters plus matched runs.
- Native streaming first-partial and endpoint latency observations.
- Candidate-model accuracy thresholds, thread/endpoint tuning, overseas A/B and
  domestic mirror evaluation. None is decided by this report.

The corpus gate (`--require-p0-corpus`) correctly rejects the smoke manifest.
Python benchmark regressions: 7 passed; native real-audio probes: Base and Small
completed. Runtime evidence remains local and contains only the existing public
fixture. No private recording or model weight was committed.

## Expanded pinned corpus measurements

The public subset now contains **160 distinct recordings**, 20 for each of eight
languages. SenseVoice was run on its five supported languages (100 recordings);
Small q8 was run on all 160. All 260 adapter invocations succeeded. This is
decoding evidence, not a calibrated accuracy pass. Raw public transcripts and
per-sample timings are committed in [asr-bench-evidence](asr-bench-evidence/).

All rows below: i7-6700K, Linux, CPU only, greedy, **4 threads**. Durations are
the total input seconds in each 20-recording group; load/decode are arithmetic
means and RSS is the maximum process high-water mark. SenseVoice uses int8,
Whisper Small uses q8_0. Process-cold loading includes hashing; OS caches were
not flushed. Concurrent build/test load makes timing exploratory.

| Engine | Language | Samples | Audio s | CER % | WER % | Load ms | Decode ms | Peak MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| SenseVoice int8 | zh | 20 | 214.54 | 7.65 | 87.18 | 10144.0 | 539.7 | 406.1 |
| SenseVoice int8 | yue | 20 | 204.96 | 35.56 | 100.00 | 9861.7 | 477.0 | 395.8 |
| SenseVoice int8 | en | 20 | 188.60 | 3.81 | 7.09 | 10551.0 | 459.8 | 400.1 |
| SenseVoice int8 | ja | 20 | 252.42 | 6.73 | 275.00 | 10869.3 | 690.1 | 406.3 |
| SenseVoice int8 | ko | 20 | 243.90 | 8.75 | 34.15 | 11224.5 | 735.3 | 418.6 |
| Small q8_0 | zh | 20 | 214.54 | 19.19 | 97.44 | 10398.8 | 9662.8 | 626.3 |
| Small q8_0 | yue | 20 | 204.96 | 14.91 | 95.83 | 10275.6 | 8786.1 | 625.7 |
| Small q8_0 | en | 20 | 188.60 | 3.33 | 7.78 | 9259.8 | 7111.6 | 625.6 |
| Small q8_0 | ja | 20 | 252.42 | 11.16 | 120.00 | 8006.9 | 5858.8 | 626.4 |
| Small q8_0 | es | 20 | 228.12 | 1.56 | 5.23 | 7963.6 | 5669.3 | 626.9 |
| Small q8_0 | fr | 20 | 238.68 | 5.46 | 13.92 | 8006.7 | 5976.5 | 627.6 |
| Small q8_0 | it | 20 | 275.16 | 2.48 | 9.78 | 7938.4 | 5868.7 | 626.6 |
| Small q8_0 | ko | 20 | 243.90 | 4.94 | 21.13 | 7951.2 | 5739.6 | 626.5 |

Source: Google FLEURS, CC-BY-4.0, revision
`70bb2e84b976b7e960aa89f1c648e09c59f894dd`. The portable manifest
[`benchmark-fleurs.json`](../qa-ui-auto-tests/fixtures/voice/benchmark-fleurs.json)
retains independent references, exact hashes, filenames and attribution.
Use `scripts/asr-bench/fetch_fleurs.py --output LOCAL_DIR --no-proxy` (or an
explicit `--proxy URL`) to materialize it; verified files are reused on retries.

The q8 run used the frozen P1 native probe `/tmp/taomni-asr-p1-benchmark`.
Each JSON retains its actual executable/source/weight hashes; subsequent PC
changes do not retrospectively become benchmarked. CJK whitespace WER is not
a segmented word metric and must not drive selection. Strict CER includes
traditional/simplified differences, particularly relevant to Cantonese.

Evidence supports keeping Small q8 available for es/fr/it and shows SenseVoice
substantially faster here; it does **not** establish the ≤500 ms endpoint target.
There is no streaming endpoint in this batch probe. Cantonese CER and Korean
accuracy warrant manual review before claiming the default route meets quality
acceptance. D1 routing remains the user-approved implementation, with no automatic
replacement based on these exploratory results.

Remaining P0 evidence: mixed speech ≥20, code/path ≥10, user recordings, modern
CPU, full q8 tier comparisons, streaming latency/noise tuning and live cloud A/B.
No numeric quality gate has been reverse-engineered from the results.

## Additional model and non-speech smoke checks

The same frozen P1 probe also decoded one Mandarin and one English recording
through Base q8, Medium q8 and Turbo q5. These two-recording rows establish format/runtime
compatibility only; they are not full-corpus model rankings. All use this same
i7-6700K, four CPU threads, and the pinned catalog hashes.

| Model | Language | Audio s | CER | Decode ms |
|---|---|---:|---:|---:|
| whisper-base-q8 | zh | 10.38 | 0.3913 | 3208.2 |
| whisper-base-q8 | en | 10.56 | 0.0123 | 7438.0 |
| whisper-turbo-q5 | zh | 10.38 | 0.0000 | 63132.4 |
| whisper-turbo-q5 | en | 10.56 | 0.0123 | 62634.5 |
| Medium q8_0 | zh | 10.38 | 0.3043 | 22026.6 |
| Medium q8_0 | en | 10.56 | 0.0123 | 22811.3 |

The committed three-second silence and deterministic low-amplitude white-noise
controls are test signals (CC0), not substitutes for human speech. Raw outputs
are in `sense-controls.json` and `q8-controls.json`; any nonempty noise result is
explicitly counted as unexpected text. They do not establish real-world noise
robustness or calibrated endpoint behavior.


Non-speech observation: both engines returned empty output on silence. On noise,
SenseVoice returned `그.` and Small q8 returned `ស្្្្្្`; both are correctly
flagged `unexpected_text: true`. Noise robustness has **not** passed. Do not
replace these observations with a hand-tuned string filter. Real microphone
noise, VAD calibration and human speech preservation remain required.

Medium q8 migration weights also passed both language smoke decodes after a
resumed download validated the exact catalog SHA-256. All new q8/q5 tiers now
have real format/runtime smoke evidence; only Small q8 has the complete
160-recording run. These later smoke runs reuse the frozen P1 executable; source
hashes captured at invocation identify the workspace, not a newly rebuilt binary.
