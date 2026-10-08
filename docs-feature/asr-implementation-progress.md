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

## P0 remaining prerequisites

This workstation is an Intel Core i7-6700K (4 cores / 8 logical CPUs). The repository
contains one attributable Mandarin FLEURS sample and this workstation has pinned
Whisper Base/Small f16 weights. Hugging Face direct connectivity timed out during
this run. No modern CPU machine or additional human audio corpus was supplied.

The required 20 recordings per language, mixed-language/code/noise/silence samples,
modern CPU comparison, candidate q8/SenseVoice and online A/B measurements remain
outstanding. Do not use one-sentence smoke measurements to select defaults or
claim latency/accuracy targets. P1 engine decisions remain behind the plan's P0
gate; P4 remains deferred until PC P1/P2 completion as required by D7.

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
This does not complete P0 or authorize bypassing its P1 selection gate.

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
