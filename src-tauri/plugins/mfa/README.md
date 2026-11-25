# MFA host prototype

`taomni-plugin-mfa` runs the existing MFA engine through the official SDK and
production core-service transport. This M0 prototype is not installed or used
by the application's MFA facade yet. Its provisional manifest has no frontend
entry or tabs. Signed installation, legacy data handoff, dynamic UI and the
applicable G1–G11 evidence must precede switching the product entry.

The SDK acquires profile/data leases before constructing the store. The host
owns only `plugins/mfa/data/mfa.db`, preserves schema v1/AAD/OTP behavior, and
rejects linked store paths and future schemas. It never opens `taomni.db` or
`vault.db`, receives a master password, or caches a data key across operations.
Every key request uses the fixed `mfa.data-key-v1` ID and the current admitted
operation. Empty initialization requires its own exclusive core permit. Export
and reset accept scoped single-use core grants.

Business commands share a serial store actor. An outer transaction checks
cancellation before its final commit; engine batches use nested savepoints.
Snapshot prepare drains and freezes that actor, and export uses its existing
SQLite connection without calling Vault or initializing an unused database.
Release resumes writes. Startup reopens an existing store so backup works
before the first business command after a host restart.

Unit checks can run locally:

```sh
cargo test --manifest-path src-tauri/Cargo.toml -p taomni-mfa-engine -p taomni-plugin-mfa --lib --locked
node --test scripts/modular-boundaries.test.mjs
```

`.github/workflows/qa-modular-upgrade.yml` owns actual process execution:

- Four release-target builds and dependency boundaries; runner-native units.
- Three-platform `taomni-host-gates` targets `mfa` (5 scenarios) and
  `mfa_snapshot` (2), with `TAOMNI_MFA_PLUGIN_BIN` bound to the built host.
- Linux `vault::plugin_access::mfa_host_tests` (3), using the persisted
  production Vault, real password verification, restart/rekey/lock and repair.

`qa-modular-mfa-install.yml`, called by the upgrade workflow, adds four-target
official signing and three native-architecture installed-registry gates. These
use the production pinned key, install the actual package, invoke scoped
operations, check persisted HOTP/fixed keys through disable/reinstall and
coordinated Vault transitions, reject installed-code tampering, and assert the
host holds/releases its OS data lease. The dedicated core test feature rejects
the ordinary unit signing key. This new gate still requires matching GitHub
execution evidence; adding it is not a passing installation result.

The process tests are ignored by default and only compiled locally. Receipts
remain limited to their selected scenarios. Intel macOS installed execution,
system signing/notarization, whole-app UI routing, installed-monolith upgrade
and the final feasibility gates are separate work.
Until the facade switches, TC-MFA-015 and the retained MFA cases protect the
existing product path; they do not exercise this host.
