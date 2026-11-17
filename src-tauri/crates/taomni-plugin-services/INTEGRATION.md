# TASK-025-C/D integration boundary

This crate implements the core-owned fixed-key allowlist, manifest grant
validation, operation admission, generation/epoch revocation, in-flight lease
ownership, request budgets/replay rejection, and single-use reset/export grants.
It does **not** authenticate package bytes, install a module, unlock Vault,
launch a host, or unlock the application's service admission. Only trusted core code
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
- `issued_operations.rs`: production admission allocates a reserved, checked
  operation ID atomically, retaining only live permits. Explicit-ID compatibility
  APIs and local core permits cannot re-admit any issued or future reserved ID.
- `core_operation.rs`: in-process `CoreOperationPermit` shares the drain and
  lease barrier while legacy MFA still lives in core. It has no host identity
  or wire context and cannot authorize reverse service requests.
- `operation.rs`: borrowed existing OS lease and context validity checks.
- `service_request.rs`: bounded reverse requests and remembered IDs.
- `session.rs`: handshake-selected monotonic request watermarks remember every
  older sequence without growing with transport lifetime. Unnegotiated v1 peers
  retain their original bounded ledger and duplicate/capacity rejection.
- `sensitive_frame.rs`: hold the whole frame through queued/finished/discarded
  writes; `current_bytes` rejects a context invalidated while queued.
- `revoke.rs`: admission closes and epoch increments before revoke RPC;
  acknowledgment or verified process termination plus drained permits are
  required before `finish_revoke` can reach `Locked`.
- `grants.rs`: only core-confirmed reset/password verification issues grants;
  passwords are removed before the host invoke is sent.

The production transport retains its authenticated identity after dropping a
crashed `ServiceSession`. Only successful kernel confirmation of its complete
process tree calls `record_host_terminated`; sending kill, dropping transport,
or cancellation is insufficient. Identity clones share that receipt, so a
retired operation cannot leave a revoke acknowledgment that is impossible to
obtain. In-flight operations and sensitive frames still have to release their
leases before drain succeeds. Confirmation is retryable for the same current
revocation; stale epoch/generation acknowledgments remain invalid. Registry
cleanup must retain the runtime on failure rather than remove it before stop.

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
core now also passes all four actual Vault adapter units. These foundations,
three-platform process leases and the Linux real Vault units passed in hosted
run 43781962402 at source 038b539a4. No browser/native or process gate ran locally.

Hosted exact commands after integration:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-plugin-api -p taomni-plugin-services --lib --locked
cargo test --manifest-path src-tauri/Cargo.toml -p taomni --lib vault::plugin_access::tests --locked -- --test-threads=1 --nocapture
```

The D transport batch adds `CoreServiceDispatcher`, `ServiceSession`, explicit
core-owned `admit_until` deadlines, `HostProcess::start_with_services` and
`invoke_with_operation`, plus the independent `taomni-plugin-sdk` reader and
business worker. `Vault` implements `CoreServiceBackend` directly. The writer
queues the original sensitive frame and retains its permit until flush/drop.
Core API 16 + services 19 + SDK 7 + host 14 pure units pass. Six SDK stdio and
two actual Vault/SDK process scenarios are wired into the hosted workflow;
their new-source execution is still pending.

Production registry/bootstrap now configures the factory from a freshly
verified manifest. The core-only scoped entry acquires its outer OS lease
before the host mutex and maps renderer cancellation to its scoped wire ID.
Core-owned profile generation persists under a stable state lock and changes
before restore/rollback. Dispatcher shutdown joins outside host/Vault locks.
Admission still starts closed: actual Vault init/unlock/lock/rekey coordination
and the real MFA caller remain to be connected; the factory alone does not
make data-key operations available to renderer calls. The renderer's generic
invoke path cannot construct operation permits or select reset/export grants.
Do not infer runtime availability from the backend trait implementation.

This delivery does not yet establish production
revocation, shared capture/backup barriers, three-state restore, GUI/headless
coordination, or a migrated MFA host. TASK-025 remains incomplete until C–I
production wiring and corresponding three-platform evidence exist.

Source 4a67992d6 passed hosted run 43787463856: three platforms each ran six
SDK stdio scenarios and Linux ran two actual Vault/SDK scenarios. A later batch
adds explicit lifecycle revoke deadlines and confirmed tree termination, with
eight hosted SDK scenarios and the persisted-generation native restart case;
that later source needs its own matching execution evidence.
