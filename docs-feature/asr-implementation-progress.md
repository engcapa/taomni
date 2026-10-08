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
