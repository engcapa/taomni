# Hosted host lifecycle gates

This crate compiles `src/plugin/host.rs` directly using `#[path]`. It adds no
Tauri dependency and does not copy the production implementation.

Local development runs unit tests only:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-host-gates --lib --locked
```

The ignored integration tests start real processes. Execute them only on the
GitHub Windows, macOS and Linux runners. Build the actual hello plugin first,
set `TAOMNI_HELLO_PLUGIN_BIN` to its absolute executable path, then run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-host-gates \
  --test lifecycle --test cleanup --locked -- --ignored --test-threads=1
```

The lifecycle suite proves idle heartbeats, request correlation, cancellation,
timeouts, heartbeat failure, bounded restart, no command replay, explicit stop,
and independence from the lifetime of the thread that called spawn.

The cleanup fixture starts the real hello plugin and an additional child and
grandchild without a shell. It proves that killing the disposable core process
also terminates that process tree. Windows uses a job object; Linux combines
`PDEATHSIG` and an ownership-pipe guardian; macOS uses a guardian watching the
original core process with kqueue. The guardians stay inside the host process
group, keeping its group ID reserved until cleanup.

These gates do not establish platform code-signing trust, macOS TCC ownership,
Linux noexec behavior, frame throughput, plugin frontend loading, or profile /
backup coordination. Those remain separate G1–G11 acceptance evidence.

`--test services` adds six GitHub-only scenarios using the production core pump
and the real `taomni-plugin-sdk` fixture binary: reverse services longer than the
normal invoke timeout with live heartbeats, cancellation during key wait,
fresh identities after replacement, operation deadline enforcement, revoke /
new epoch handling, and rejection of generic renderer context injection. Its
controlled backend proves transport behavior. The root crate's two ignored
`vault::plugin_access::host_tests` gates separately link the actual Vault and
exercise old-key continuity, lock errors and explicit empty-store creation.
Neither suite proves an installed/signed MFA package or real legacy upgrade.
