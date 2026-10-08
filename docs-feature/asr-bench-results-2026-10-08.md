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

## Pending evidence

- Full P0 corpus (20 distinct recordings per language, 20 mixed, 10 code/path,
  noise and silence). Current coverage is Mandarin 1/20, all other categories 0.
- Modern CPU comparison; this workstation covers only the old-CPU class.
- q8/SenseVoice/Zipformer and online-provider adapters plus matched runs.
- Native streaming first-partial and endpoint latency observations.
- Candidate-model accuracy thresholds, thread/endpoint tuning, overseas A/B and
  domestic mirror evaluation. None is decided by this report.

The corpus gate (`--require-p0-corpus`) correctly rejects the smoke manifest.
Python benchmark regressions: 7 passed; native real-audio probes: Base and Small
completed. Runtime evidence remains local and contains only the existing public
fixture. No private recording or model weight was committed.
