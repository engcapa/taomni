# ASR implementation progress

Implementation branch: `feat/asr-plan-implementation`, starting at `cae171a8`.
The decisions in `asr-implementation-plan.md` remain authoritative. This is an
incremental delivery log, not a declaration that P0–P5 are complete.

## Stage 1 — retain usable provider configuration

The frontend normalizer previously reconstructed ASR using default providers on
both load and save. This discarded a user's model, endpoint, API key/vault
reference and independent proxy. It also prevented newly entered keys from
reaching the existing vault persistence path. Merge saved providers over defaults
and derive local/online mode from the selected provider, matching Rust migration.

Regression checks cover saved credentials/model/proxy, filling providers absent
from older configs, plaintext-to-vault conversion, and aborting persistence when
vault storage fails. Existing model-install and dictation behavior stays covered.

Linux validation:

- Two new store regressions failed on `cae171a8` behavior; both pass after the fix.
- `pnpm exec vitest run src/stores/aiStore.test.ts src/components/settings/AsrPanel.test.tsx src/components/voice/DictationButton.test.tsx`: 28 passed.
- `npx tsc --noEmit`: passed.
- Local default-feature `cargo check`: passed; existing warnings remain.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib asr::`: 12 passed, 2 real-audio tests ignored by their existing explicit opt-in contract.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib voice::`: 4 passed.
- Browser `TC-VOICE-001/002/005`: 3 passed, no failures/skips. The runner used byte-identical ASR case copies in an isolated case directory because global discovery rejects existing screenshot cases before filtering. Evidence: `qa-ui-auto-report/asr/browser/run-20261008-193440-049954784/`. Browser vault/storage mocks do not prove native encryption or real cloud connectivity.
- Global `qa_ui_auto audit --gate`: blocked by existing screenshot case verification definitions (including TC-SHOT-003 and TC-SHOT-030, observations classified as non-asserting). The new ASR case passes schema discovery. These unrelated definitions were not weakened or edited.
- Required CI utility self-tests: 73 executed, 12 selection-test errors caused by the same global TC-SHOT-003 discovery failure; 61 passed. The unfiltered log is retained locally. This is an unresolved integration gate, not an ASR acceptance pass.

No push/release is claimed while the global gates remain blocked. Native desktop
UI, Windows and macOS execution remain unverified in this stage; native product
code is unchanged by the configuration fix.

## Initial P0 prerequisites (historical snapshot)

This workstation is an Intel Core i7-6700K (4 cores / 8 logical CPUs). The repository
contains one attributable Mandarin FLEURS sample and this workstation has pinned
Whisper Base/Small f16 weights. Hugging Face direct connectivity timed out during
this run. No modern CPU machine or additional human audio corpus was supplied.

The required 20 recordings per language, mixed-language/code/noise/silence samples,
modern CPU comparison, candidate q8/SenseVoice and online A/B measurements remain
outstanding. Do not use one-sentence smoke measurements to select defaults or
claim latency/accuracy targets. The user subsequently requested continuation of every feasible implementation stage;
P0 remains a quality acceptance gate, not a claim that later code was benchmark-approved.
P4 implementation remains gated by D7; its conditional design/prototype can be reviewed.

## Stage 2 — P0 benchmark infrastructure and old-CPU smoke

Added a local manifest validator, fixed CER/WER normalization, weighted JSON
aggregates, per-sample failure receipts, input/model/source/binary hashes and an
explicit P0 corpus gate. The native opt-in adapter invokes production AsrManager;
no runtime dependency or automatic network request is added to the application.
Private fixture and local adapter paths are ignored by Git.

Seven Python regressions pass, including wrong hashes/durations, duplicate audio,
nonfinite metrics, missing corpus coverage and failed adapter cleanup. The ignored
Rust probe was built and explicitly run against installed Base and Small f16
weights on the i7-6700K. Results and limitations are in
[asr-bench-results-2026-10-08.md](asr-bench-results-2026-10-08.md).
This does not complete P0 or establish a benchmark-based selection decision.

## Stage 3 — restore existing online WebSocket handshakes

The shared online connector manually constructed an HTTP request without the
WebSocket upgrade headers. A real loopback server reproduced the same missing
`Sec-WebSocket-Key` failure for direct TCP, HTTP CONNECT and SOCKS5 routes.
Use tungstenite's `IntoClientRequest` to generate protocol-required headers and
fresh handshake keys, then add provider authentication. Reject invalid/non-WS
endpoints and malformed headers without including credential text in errors.

All four new regressions failed before the fix. Afterward the native `voice::`
suite passed 8 tests, including actual WebSocket upgrades, PCM-byte delivery and
transcript receipt through all three transport routes. Proxy tests target an
unresolvable origin name and assert proxy-side DNS/CONNECT semantics. These are
native socket fixtures, not cloud-provider or live TLS acceptance.

The user workflow and IPC contract are unchanged; retained TC-VOICE-005 protects
provider settings, while the native socket tests cover the changed boundary that
browser stubs cannot exercise. No new browser control/case is appropriate for the
HTTP upgrade header correction. No new provider protocol, billing behavior or
network fallback was introduced. Live credentials, cloud finalization and desktop
microphone behavior remain outside this evidence.

Final formatting check: changed Rust files pass focused rustfmt checks. The
workspace-wide `cargo fmt -- --check` still reports pre-existing formatting in
unrelated modules (for example `bin/sockscap-helper/capture.rs`); no broad formatting
churn was included. Global QA/CI failures above remain outstanding integration
work. The completed increments are committed locally; P0/P1/P2/P3/P4/P5 as a whole
are not marked complete.

## Stage 4 — explicit streaming finish and cancellation

Streaming finish now waits for backend completion (bounded to 15 seconds), while
cancel drops the backend future/socket and stops capture. Provider configuration,
credentials and proxy are validated before microphone acquisition; local streaming
does not resolve a network proxy. Deepgram sends CloseStream and drains final
responses; Aliyun waits for task-started, uses the documented duplex envelope and
reads payload.output before draining task-finished. Zipformer flushes unchanged
final text and resets empty endpoints; its maximum utterance rule is corrected
from 0.5 to 20 seconds (latency tuning remains subject to P0 measurements).

Partials appear separately and only finals enter the current editable draft.
Cancelled and stale results cannot modify it. Batch capture no longer fills an
unconsumed streaming channel. The composer consumes staged text atomically to avoid duplicate insertion when
React replays mount effects; the event stub also snapshots its subscribers.

Validation: 27 focused DictationButton/Composer tests and 8 native voice tests pass;
TypeScript checks pass. TC-VOICE-006 passes with a 700 ms delayed final and exact draft
preservation on cancel. Live provider finalization and microphone hardware remain
unverified; socket fixture results must not be read as vendor acceptance.

## Stage 5 — local model and routing implementation

Added pinned SenseVoice int8, independent Whisper q8 tiers, Turbo q5 and explicit
f16 replacement. Default Auto local routes five supported languages to SenseVoice
and es/fr/it to Small q8; auto uses the last selected/UI language prior. Existing
selections are preserved. Optional installed Zipformer supplies zh/en partials and
SenseVoice final refinement, with local Zipformer final fallback when SenseVoice
cannot load. Other languages receive bounded silence-delimited finals. These
endpoint defaults are provisional until the full P0 latency/noise gate passes.

Settings expose exact sizes, license, recommended downloads and explicit migration;
Medium f16 is retired from new selection. Browser TC-VOICE-001/002/007 pass (3/3),
31 focused frontend tests pass, and TypeScript checks pass. Native ASR, routing and
voice suites pass on the compiled implementation. Additional retirement regression
and final build are included in the subsequent combined native verification.
SenseVoice has decoded the existing real Mandarin fixture through AsrManager;
expanded 160-recording public corpus measurements are in progress. This is an
implementation milestone, not completion of eight-language acceptance or P0.

## Current delivery and acceptance matrix

The user explicitly requested continued implementation across the plan, then
confirmed that no modern CPU, cloud test accounts or Android device are available
and asked to retain those acceptance gaps while finishing the other work.
Historical counts above describe earlier snapshots; this matrix is current.

| Stage | Delivered implementation/evidence | Remaining acceptance |
|---|---|---|
| P0 | Pinned portable 160-recording FLEURS manifest/fetcher, deterministic noise/silence controls, CPU benchmark adapter, committed 100 SenseVoice + 160 Small q8 result receipts | 20 mixed + 10 code/path human recordings, private recordings, modern CPU, live overseas A/B, calibrated CER/WER and streaming latency thresholds |
| P1 | SenseVoice int8, q8/q5 catalog, explicit verified f16 migration, language-prior routing with native auto-LID within the selected engine, optional Zipformer partials/final refinement, warm refinement reuse, atomic complete Zipformer revisions | Real microphone/WebView, modern CPU, thread/VAD tuning and ≤500 ms endpoint target; no verified domestic mirror |
| P2 | Soniox and Volcengine protocols, four-provider settings/vault/proxies, neutral/managed hotwords, idle disconnect, final drain and explicit cancellation; Gemini experimental | Actual vendor credentials, pricing console verification, live TLS proxy/provider A/B |
| P3 | Off/light/full text cleanup, protected code/path/numeric rejection, raw fallback/notice, cancellation, adjacent final serialization and original undo without overwriting later edits | Chinese semantic quality requires human listening/review; deterministic protected-token checks cannot prove semantic equivalence |
| P4 | Conditional mobile design, interactive simulated prototype and read-only Android sampler | D7 shell decision, Android/iOS implementation and physical-device 10-minute CPU/temperature/battery measurements |
| P5 | Focused frontend/native regression tests, browser cases 001–009, CI utility and QA catalog gates | Windows/macOS and real desktop microphone/WebView acceptance; no push/release requested |

### Online providers and cleanup

Official protocol references and native fixture boundaries are recorded in
[asr-provider-contracts.md](asr-provider-contracts.md). Configuration migrations
preserve saved model/endpoint/key/proxy values. Custom proxy uses the shared
Settings panel and legacy proxy URLs remain readable. Vocabulary cache files
contain opaque IDs only. No billing/pricing behavior is inferred from research.

Cleanup uses the configured text router with full-local filtering, a 15-second
limit and default off. Cancellation before registration is remembered, and queued
finals check session validity before making any text request. Raw transcript
remains selectable in the active draft UI. Uninterrupted adjacent finals undo
together; after manual edits, overwrite is refused and original text remains
available to copy. This is draft-level recovery, not a persistent audio archive.

### Local safety follow-up

Zipformer downloads to a revision directory and only becomes active after all
four files verify and the completion marker is published. A previous active
revision or legacy flat directory remains available while a new revision is
incomplete. Revision markers cannot escape the model root. Safe partial files survive cancellation/restart. The installer copies verified
legacy weights or partial files into the new layout while retaining the original;
final hash validation protects against an incompatible old prefix. A persisted
import marker prevents reseeding the same rejected prefix on subsequent retries. SenseVoice progress includes tokens
in the bundle total. Its warm refinement cache retains one language configuration
and existing sessions hold their own Arc across language changes.

Auto uses the UI/last-language prior to choose the engine family; the recognizer
receives `auto`, allowing its own language identification within supported
languages. There is no separate cross-engine LID service or silent cloud fallback.

### Public evidence and scope

See [asr-bench-results-2026-10-08.md](asr-bench-results-2026-10-08.md) and committed
public JSON receipts. The current strict Cantonese CER differs from the research
expectation, so the default is not presented as quality-calibrated. Thread/VAD
parameters remain provisional. No missing measurement is filled with vendor data,
browser timings, duplicated audio or synthesized human-speech quotas.

Mobile prototype final/undo/cancel was exercised at 390×844; screenshot retained
locally and inspected for clipping. It simulates responses and does not access
microphone/network. The sampler compiles but has not run on a device.

### Final Linux verification

- TypeScript `pnpm exec tsc --noEmit`: passed.
- Focused Vitest (DictationButton, Composer, AsrPanel, aiStore): **50 passed**.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed, including the final legacy partial-copy follow-up
  (`qa-ui-auto-report/asr/installer-migration.log`), with the final retry-marker
  check in `qa-ui-auto-report/asr/retry-check.log`.
- Native `voice::`: **17 passed**; `asr::`: **14 passed, 3 opt-in tests ignored**;
  `ai::config::asr_migration_tests`: **2 passed**. Explicit real-audio adapter runs
  are documented separately and are not counted as ordinary ignored-test passes.
- TC-VOICE-001 through TC-VOICE-009: **9 passed, no failures/skips**, source stable;
  receipt `qa-ui-auto-report/asr/browser/run-20261008-231531-073150865/`.
- Required CI tool self-tests: **73 passed**; `qa_ui_auto audit --gate`: passed.
  The development case contract and explicit nine-case CI selection plan pass.
  The stale screenshot verification indices were corrected in a separate commit;
  executable steps/assertions remained unchanged. No coverage baseline was lowered.
- Benchmark Python regressions: **7 passed**; portable fetcher reuse and all 160
  recording hashes/durations validated. Mobile sampler/fetcher Python compilation
  passed. Changed ASR/voice Rust files passed targeted rustfmt checks.
- Environment: Linux x86_64, i7-6700K, Node 24.18.0, pnpm 10. Node 22 CI parity,
  packaged WebView and hardware microphone recording remain unverified.

Observed quality limitation: both engines returned empty text for silence, but
both hallucinated on deterministic white noise (SenseVoice `그.`, Small q8
`ស្្្្្្`). This is recorded as failed noise robustness, not hidden by a
sentence-specific filter. Turbo q5 decoded both language smoke samples but took
about 63 seconds per sample on this old CPU under concurrent build load; it is
not a low-latency recommendation for this machine. The full latency/quality gate
remains pending even though the implementation regression gates pass.

All newly added Whisper quantized tiers (Base/Small/Medium q8 and Turbo q5)
have actual Chinese and English decode evidence. Medium q8 completed after a
Range-validated retry and whole-file SHA verification. The smoke rows and their
actual frozen-probe provenance are published with the benchmark report.

## Staged commits

- `3641877b`: preserve provider credentials and independent proxies.
- `9235633e`: reproducible local benchmark infrastructure.
- `509a70ba`: correct native WebSocket upgrades through all proxy routes.
- `28e0a08a`: graceful finalization and cancellation isolation.
- `a2ce0304`: SenseVoice and verified quantized model upgrades.
- `73958172`: repair stale QA checkpoint references without changing assertions.
- `db937485`: publish multilingual public corpus and measured evidence.
- `c4984515`: atomic bundles, legacy migration and warm local routing.
- `28cc037a`: Soniox/Volcengine, managed hotwords and reversible text cleanup.
- `d706ef2a`: conditional mobile design, prototype and Android measurement tool.

All commits are local to `feat/asr-plan-implementation`; no push, PR, merge or
release is claimed. P0/P4 and the named quality/hardware checks remain open by
agreement; implementation regression passes do not close those acceptance items.
