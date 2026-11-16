# TASK-025-C integration boundary

This crate implements the core-owned fixed-key allowlist, manifest grant
validation, operation admission, generation/epoch revocation, in-flight lease
ownership, request budgets/replay rejection, and single-use reset/export grants.
It does **not** authenticate package bytes, install a module, unlock Vault,
launch a host, or provide the bidirectional transport. Only trusted core code
may construct `VerifiedHostGrants` from the registry's verified package and bind
it to the successfully authenticated transport's fresh `HostInstanceId`.

The companion production adapter is `src-tauri/src/vault/plugin_access.rs`.
It reads/decrypts the real fixed Vault row, preserves the legacy key ID and
encoding, validates cached root material against current Vault metadata, and
uses insert for first initialization. Only an admitted `ResetStore` operation
with a consumed reset grant may repair an invalid row. The result is a
`SensitiveServiceFrame`; no generic `Value`, renderer reply, or host Vault
handle appears in this path.

Required changes owned by the root integrator:

```toml
# src-tauri/Cargo.toml workspace members
"crates/taomni-plugin-services",

# src-tauri/Cargo.toml dependencies
taomni-plugin-services = { path = "crates/taomni-plugin-services" }
taomni-profile-locks = { path = "crates/taomni-profile-locks" }
```

```rust
// src-tauri/src/vault/mod.rs
pub mod plugin_access;
```

The root integrator has added these dependencies, regenerated Cargo.lock and
declared the production adapter module. Its four actual-Vault unit tests now
compile and pass against the integrated core. Production dispatcher and
Vault/lifecycle coordination remain required; a declared adapter alone does
not expose the service to a running host.

The root host owner implements TASK-025-D against these files:

- `policy.rs`: `VerifiedHostGrants`, `AuthorizedHost`, `fixed_key_owner`.
- `admission.rs`: outer `OperationPermit` and `borrow_operation`.
- `operation.rs`: borrowed existing OS lease and context validity checks.
- `service_request.rs`: bounded reverse requests and remembered IDs.
- `sensitive_frame.rs`: hold the whole frame through queued/finished/discarded
  writes; `current_bytes` rejects a context invalidated while queued.
- `revoke.rs`: admission closes and epoch increments before revoke RPC;
  acknowledgment or verified process termination plus drained permits are
  required before `finish_revoke` can reach `Locked`.
- `grants.rs`: only core-confirmed reset/password verification issues grants;
  passwords are removed before the host invoke is sent.

Acquire `VaultOperationLease` **before** host/DB/Vault mutexes. Normal operations
hold read, initialization/reset hold write. A reverse request borrows the
outer lease; it never reacquires a read lock behind a waiting snapshot writer.
Do not upgrade an already-held read lease for first initialization. End that
operation and admit a new explicit initialization operation instead.

The transport may check current bytes immediately before a write and then
race with revocation; it must retain the frame through the entire write so
revocation waits until the write is completed/discarded and the host has
acknowledged erasure or been terminated. A returned success after revoke is
invalid even if its worker completed before the epoch changed.

Local in-process checks: API 15/15 and services 11/11 passed; clippy
`--all-targets -- -D warnings` passed in the foundation tree. The integrated
core now also passes all four actual Vault adapter units. No browser/native
or process gate has been run locally; hosted evidence remains pending for
this integration.

Hosted exact commands after integration:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-plugin-api -p taomni-plugin-services --lib --locked
cargo test --manifest-path src-tauri/Cargo.toml -p taomni --lib vault::plugin_access::tests --locked -- --test-threads=1 --nocapture
```

This is a C foundation and adapter delivery. It does not establish production
revocation, shared capture/backup barriers, three-state restore, GUI/headless
coordination, or a migrated MFA host. TASK-025 remains incomplete until C–I
production wiring and corresponding three-platform evidence exist.
