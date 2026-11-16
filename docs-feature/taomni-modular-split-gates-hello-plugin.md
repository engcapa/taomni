# M0 hello-plugin host gate evidence

This document records the deterministic fixture for TASK-013. It is a
protocol and lifecycle fixture, not evidence that every platform security gate
has passed. The real signed release binary must still be exercised on the
matching GitHub runners before any production plugin is released.

## Fixture contract

- Source: `src-tauri/plugins/hello-plugin/`
- Host binary: `taomni-hello-plugin`
- API/protocol: `taomni-plugin-api` API version 1, protocol version 1
- Control channel: newline-delimited JSON-RPC over stdin/stdout
- Token: `TAOMNI_PLUGIN_TOKEN`, required before startup
- Commands: handshake, enable, disable, ping, deterministic crash, deterministic hang

## Current evidence

| Gate behavior | Evidence | Status |
| --- | --- | --- |
| Handshake API/protocol/token validation | hello-plugin unit tests | Pass |
| Enable/disable lifecycle state | hello-plugin unit tests | Pass |
| Command rejected before handshake | hello-plugin unit tests | Pass |
| Crash outcome and exit contract | hello-plugin unit tests | Pass |
| Timeout outcome and bounded hang fixture | hello-plugin unit tests | Pass |
| Real host process launch and stdio exchange | `cargo test --manifest-path src-tauri/plugins/hello-plugin/Cargo.toml --locked` (`process_handshakes_and_changes_enable_state`) | Pass |
| macOS signing/TCC, Windows trust, Linux noexec, Job Object/PDEATHSIG, loopback WS and profile coordination | hosted native experiments | Pending |

The fixture deliberately does not claim G1–G11 completion. TASK-013 remains
open until the signed artifact and platform-specific host experiments produce
runner receipts for the applicable gates.

## Linux G4 execution experiment

Source `6497fb47e95bcfa32639b0fc09c4b9a754a57fe4`, hosted upgrade run
[#43936364643](https://github.com/engcapa/taomni/actions/runs/43936364643),
`modular-host-ubuntu-24.04/execution-receipt.json`: both actual scenarios
passed. The receipt records the real ext4 bind mount's `noexec` flag, kernel
`EACCES`, both host hashes, the executable alternative and confirmed mount
cleanup. The same MFA executable produced HOTP `755224` through the production
process adapter and SDK. This closes the mount/adapter experiment only;
deb/rpm/AppImage installation and relocation of the supported profile remain
unverified. `TC-MODULES-024` adds the production UI/data recovery path and still
needs its matching hosted case result.

## macOS G1 experiment and release boundary

`QA Modular Plugin Host Gates` now includes a macOS Intel experiment with the
actual production process adapter, hello executable and real MFA SDK host.
The experiment signs its test app and both hosts ad-hoc with hardened runtime
enabled, verifies the signatures and runtime flags, sets and reads back the
hosts' download quarantine attributes, records every `spctl` assessment, and
then requires both actual handshake/business scenarios to pass. It checks that
execution did not change the signed bytes. Failed builds/process deadlines
retain diagnostics and a receipt that cannot claim success.

This is a process-only M0 experiment, with no product UI change; its two ignored
Rust scenarios are the executable acceptance checks. Existing production UI
paths remain covered by TC-MODULES-007/016/022 and the complete crash suite.
Only GitHub executes the native experiment; local Python tests mock every
process and verify evidence/selection/error handling.

The experiment is **pending hosted execution**, and its receipt identifies the
core as `production-process-adapter-experiment`. It does not establish that the
complete Tauri release bundle, fixed certificate, Gatekeeper distribution trust
or TCC ownership works. The current release configuration deliberately disables
hardened runtime for a self-signed certificate because bundled Kerberos dylibs
lack an Apple Team ID (`scripts/configure-release-signing.mjs`); that difference
must be resolved and tested on the actual release bundle before closing G1.
The experiment neither imports a private key nor changes system trust/TCC.
