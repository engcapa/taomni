#!/usr/bin/env bash
set -euo pipefail

# These tests do not need a desktop and must not delay publishing the app.
if [[ "${QA_RDP_CONTRACTS:-false}" != true && "${QA_DUAL_CONTRACTS:-false}" != true && "${QA_ORCH_CONTRACTS:-false}" != true ]]; then
  echo 'No native Rust contracts selected.'
  exit 0
fi
pnpm build --mode qa
cd src-tauri
profile=()
if [[ "${QA_RELEASE:-false}" == true ]]; then
  profile=(--release)
  export CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS=true
  export CARGO_PROFILE_RELEASE_INCREMENTAL=true
fi
filters=(lsp::tests::workspace_watch_lifetime commands::workspace_reads::tests
  workspace::tests::text_and_encoding workspace::tests::encoding_matrix)
if [[ "${QA_RDP_CONTRACTS:-false}" == true ]]; then
  cargo test --locked "${profile[@]}" -p ironrdp-acceptor -p ironrdp-bulk -p ironrdp-server -p ironrdp-session --lib
  cargo test --locked "${profile[@]}" -p ironrdp-server --lib profile_photo_encoder_costs -- --ignored --nocapture
  filters+=(rdp::)
fi
if [[ "${QA_DUAL_CONTRACTS:-false}" == true ]]; then
  # Keep startup handoff/generation, clipboard and resident safety units in the
  # same root binary as geometry. Narrow surface filters miss these regressions.
  filters+=(capture:: screenshot:: mfa::)
fi
if [[ "${QA_ORCH_CONTRACTS:-false}" == true ]]; then
  filters+=(orchestration:: llm::invocation go_compatibility_tests)
fi
# libtest accepts multiple OR filters. Compile/link the root test binary once.
cargo test --locked "${profile[@]}" --lib -- "${filters[@]}"
if [[ "${QA_ORCH_CONTRACTS:-false}" == true ]]; then
  # Real same-group descendant cancellation/leader-exit effects are hosted-only.
  # Reuse the already-linked root binary; never execute these in local unit runs.
  cargo test --locked "${profile[@]}" --lib hosted_lifecycle_ -- --ignored --nocapture
fi
if [[ "${QA_RDP_CONTRACTS:-false}" == true ]]; then
  cargo test --locked "${profile[@]}" --bin rdp-probe
fi
