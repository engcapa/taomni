# Production downloader gates

This small crate imports `src/plugin/download.rs` directly. It exercises the
production request validation, proxy client, streaming transfer, progress,
checksum, publication and background ownership; there is no copied downloader.
It avoids compiling Tauri and unrelated desktop protocol backends.

Local verification is restricted to pure unit tests and compilation:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-download-gates --locked --lib
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-download-gates --locked --no-run
```

All TCP tests carry `#[ignore]`. Run them only via
`.github/workflows/qa-modular-download.yml` on GitHub's Linux, Windows and macOS
runners. The workflow supplies deliberately unusable environment proxies only
to the test step, runs ignored tests serially, and uploads source revision and
original logs for each platform. Do not configure the workstation proxy in CI.

The hosted contracts cover validated resume, an ignored Range restarting from
zero, SHA failures, invalid ranges, unknown total progress, connection errors,
cancel/forget/retry, connection closure on cancellation, background handle drop,
duplicate canonical paths and content, explicit no-proxy, both configured proxy
sources failing closed, encoded responses, the 4 GiB header limit, active reads
exceeding 30 seconds and an idle-read timeout. Pure
units additionally cover hard-link no-clobber publication and panic cleanup.

These gates do **not** establish persistence of tasks across application
restarts, signed catalogue trust, the remote module-store UI, or download UI
restoration and retry/cancel actions. Those require separate production work and
matching browser/native cases. This transport/state change adds no renderer
download entry; `TC-MODULES-003` and `TC-MODULES-006` remain required for the
Settings store and offline-install workflows. TCP gates do not replace
`qa-ui-auto-platforms` or crash regressions.
