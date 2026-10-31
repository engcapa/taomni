#!/usr/bin/env bash
set -euo pipefail

# These tests do not need a desktop and must not delay publishing the app.
if [[ "${QA_RDP_CONTRACTS:-false}" != true && "${QA_DUAL_CONTRACTS:-false}" != true && "${QA_MOBILE_CONTRACTS:-false}" != true ]]; then
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
  filters+=(capture:: screenshot::surfaces:: screenshot::qa::save_dialog_observation::)
fi
if [[ "${QA_MOBILE_CONTRACTS:-false}" == true ]]; then
  filters+=(mobile::)
fi
# libtest accepts multiple OR filters. Compile/link the root test binary once.
cargo test --locked "${profile[@]}" --lib -- "${filters[@]}"
if [[ "${QA_RDP_CONTRACTS:-false}" == true ]]; then
  cargo test --locked "${profile[@]}" --bin rdp-probe
fi
