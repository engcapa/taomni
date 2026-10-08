# Reproducible ASR benchmarks

This offline harness is the first P0 increment of
[the implementation plan](../../docs-feature/asr-implementation-plan.md).
It does not select a new default, download models, call a cloud provider, or
claim the required eight-language/two-machine benchmark is complete.

## Corpus

The committed `benchmark-smoke.json` identifies the existing licensed FLEURS
recording, independent reference text, exact hash and duration. Validate it:

```bash
python scripts/asr-bench/bench.py \
  --manifest qa-ui-auto-tests/fixtures/voice/benchmark-smoke.json --validate-only
python -m unittest discover -s scripts/asr-bench -p 'test_*.py'
```

Add `--require-p0-corpus` to reject fewer than 20 **distinct recordings per
language** (zh/yue/en/ja/es/fr/it/ko), 20 mixed-language, 10 code/path, one noise
and one silence recording. The smoke manifest deliberately fails this gate.
Duplicate hashes do not count as additional samples. Every entry requires
`id`, `path` (relative to the manifest or absolute), `sha256`, `language`,
`category`, `reference`, `duration_s`, `source` and `license`. WAV must be
16 kHz mono PCM16 or float32, finite and at most 120 seconds.

Put private/self-recorded samples **outside the repository**. Reports contain
reference/recognized text and logs; keep private reports local, too. The harness
removes temporary PCM after each run and never copies source WAV into reports.
Public corpus expansion must retain upstream attribution/license/revision and
independent transcripts. Do not repeat this smoke recording to fill quotas.

## Production Whisper adapter

Install verified weights through the application's existing explicit installer,
or reuse an already installed pinned cache. The probe uses `AsrManager` directly,
including CPU support checks, SHA-256 verification, greedy decoding and the
production maximum of four threads. No test-only decoder settings are substituted.

Build the ignored native test once; do not put `cargo test` inside a timed adapter:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib asr:: --no-run --message-format=json \
  > /tmp/asr-bench-build.jsonl
```

Read the `executable` from the `compiler-artifact` message for `taomni_lib` with
`profile.test=true`. Create a **local** adapter JSON:

```json
{
  "command": ["/absolute/path/to/taomni_lib-TEST_HASH", "asr::benchmark::decode_fixture", "--ignored", "--exact", "--nocapture"],
  "env": {"TAOMNI_ASR_BENCH_MODEL": "whisper-base"}
}
```

For an isolated cache add `NEWMOB_CACHE_DIR` using the existing QA cache layout;
the default reads the installed app cache without modifying it. Repeat with
`whisper-small` for the other existing installed model. The current production
adapter covers pinned f16 Base/Small/Medium only; future q8/SenseVoice/streaming
adapters must identify actual weights and preserve production settings.

```bash
python scripts/asr-bench/bench.py \
  --manifest qa-ui-auto-tests/fixtures/voice/benchmark-smoke.json \
  --adapter /tmp/asr-base-adapter.json \
  --output qa-ui-auto-report/asr/bench-base-UNIQUE_RUN
```

The output directory must be new. Each sample launches a fresh native process;
startup overhead is reported separately from inference. A failed/timeout adapter
produces a failed row and nonzero exit, not a fabricated empty transcript.

## Measurement contract and interpretation

An adapter is an argv array (no shell) and optional environment map. It receives
`TAOMNI_ASR_BENCH_PCM` (f32 little-endian mono 16 kHz),
`TAOMNI_ASR_BENCH_LANGUAGE`, and `TAOMNI_ASR_BENCH_RESULT`. The last is a new JSON
output path. Required result fields are `text`, `engine`, `quantization`,
`model_sha256`, `threads`, `cold_load_ms`, `inference_ms`. Optional unavailable
metrics remain `null`: `first_partial_ms`, `endpoint_to_final_ms`,
`peak_rss_bytes`. Reject negative/nonfinite timings and unidentified weights.

- Cold load includes production hash verification. Fresh recognizer processes
  do **not** flush the OS file cache; distinguish process-cold from disk-cold.
- Inference excludes load; RTF is inference time / audio duration. Process wall
  time includes test/runtime startup and is retained separately.
- Peak RSS uses Linux `/proc/self/status` `VmHWM` and includes the complete native
  test/runtime process. Other OSes report null until an equivalent is implemented.
- Batch Whisper has no partials or endpoint event; those latencies are null.
- Scoring uses NFKC, casefold and removal of Unicode punctuation, with no
  engine-specific synonym/traditional-character substitutions. CER excludes
  whitespace; WER uses whitespace words and is **not** segmented CJK WER. Use CER
  for CJK comparisons. Empty references have null CER/WER plus an explicit
  `unexpected_text` flag. Raw hypotheses and references remain in JSON.
- JSON aggregates count errors over reference lengths per engine/language/category;
  failed samples remain explicit and do not become zero-error samples.
- Reports retain CPU/platform, source commit + dirty flag + relevant source hashes, manifest/adapter/native
  executable hashes, per-sample input hashes, model/thread/quantization, durations,
  metrics and errors. A binary hash identifies an artifact; rebuild it from the
  intended checkout before benchmarking. A dirty source flag is not provenance
  proof of unrelated prebuilt artifacts.

P0 acceptance additionally needs a modern CPU run, the full corpus, matched
online-provider opt-in runs and q8/SenseVoice candidate runs. This harness does
not infer any of those results from one machine or one sentence. Never choose
P1 defaults or latency/accuracy thresholds from this exploratory smoke alone.
