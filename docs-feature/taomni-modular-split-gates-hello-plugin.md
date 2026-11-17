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

## TASK-002 binary transport experiment

`taomni-plugin-stream` now implements bounded one-use `BinaryRef` transfer over
native loopback WebSockets. The registered upgrade `protocol_only=true` entry
runs six pure unit tests and all ten ignored real socket/process scenarios on
each desktop OS, retaining source identity, the nonempty selection and raw
logs in `modular-protocol-*`. Local work only runs pure tests and compiles the
native harness. See the [transport contract](../src-tauri/crates/taomni-plugin-stream/README.md).

The actual child receives and independently hashes empty, multichunk and full-HD
payloads through its private descriptor pipe. The other scenarios establish
wrong-token/Origin refusal without consuming an offer, stalled handshake
recovery, one-use replay refusal, cancellation/deadline listener cleanup,
connected socket closure, checksum/size/message/truncation refusal and owner
drop cleanup. There is no new product UI entry in this batch; the existing
module UI cases and complete crash suite remain under hosted verification.

These are transport foundation contracts, not G5 performance acceptance or
complete G10 service ownership. Production capture/admission must still retain
and cancel each offer, cap live resources and avoid exposing descriptors after
revocation. Continuous RDP flow control and a matched real `rdp-probe` baseline
with raw frame/latency/throughput samples remain open. Passing the library's
small payload checks cannot close those gates.

## Linux G4 execution experiment

Source `6497fb47e95bcfa32639b0fc09c4b9a754a57fe4`, hosted upgrade run
[#43936364643](https://github.com/engcapa/taomni/actions/runs/43936364643),
`modular-host-ubuntu-24.04/execution-receipt.json`: both actual scenarios
passed. The receipt records the real ext4 bind mount's `noexec` flag, kernel
`EACCES`, both host hashes, the executable alternative and confirmed mount
cleanup. The same MFA executable produced HOTP `755224` through the production
process adapter and SDK. Matching UI run
[#43936173592](https://github.com/engcapa/taomni/actions/runs/43936173592)
passed all 50 steps of `TC-MODULES-024` on both Xvfb and Wayland, including
signed installation, visible refusal, independent unchanged-data/active/hash
observations, mount removal, and real read/write recovery. This closes the
mount/adapter and isolated UI recovery experiments only; deb/rpm/AppImage
installation and relocation of the supported profile remain unverified.

## macOS G1 experiment and release boundary

The registered `QA Modular Upgrade Contracts` workflow exposes
`system_execution_only=true` and calls `QA Modular Plugin Host Gates` for a
macOS Intel experiment with the
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

Hosted run [#43941271749](https://github.com/engcapa/taomni/actions/runs/43941271749),
source `04ad3d8361c6cdadad1f22d3e2f9e0d499f51095`, passed both actual
scenarios on macOS 15.7.9 Intel. Its receipt records ad-hoc signatures with
runtime flags `0x10002`, read-back quarantine values, unchanged executable
hashes, and `spctl` exit **3 / rejected** for the app and both hosts.
`allSelectedPassed=true` therefore means both process scenarios passed,
including real MFA HOTP `755224`; it does not mean Gatekeeper trusted them.
The receipt identifies the core as `production-process-adapter-experiment`.
It does not establish that the
complete Tauri release bundle, fixed certificate, Gatekeeper distribution trust
or TCC ownership works. The current release configuration deliberately disables
hardened runtime for a self-signed certificate because bundled Kerberos dylibs
lack an Apple Team ID (`scripts/configure-release-signing.mjs`); that difference
must be resolved and tested on the actual release bundle before closing G1.
The experiment neither imports a private key nor changes system trust/TCC.

## Windows G3 execution experiment

The same registered `system_execution_only=true` entry now also runs a
Windows experiment. It builds the actual production process adapter harness
and hello/MFA executables, copies them into a run-owned directory under real
`LOCALAPPDATA`, and writes and independently reads back an Internet-zone
`Zone.Identifier` ADS on each host. PowerShell records each executable's
actual Authenticode status and the runner's Defender/SmartScreen configuration
before and after execution. Missing protection APIs or registry values remain
explicitly unavailable; the experiment never changes protection settings.

Both actual Rust scenarios must pass: hello handshake/ping and confirmed exit,
and MFA initialization/add/HOTP `755224` and confirmed exit through the real
SDK. The evidence checks that executable hashes and download marks remain
unchanged. Failure and timeout logs and the unsuccessful receipt are retained.
The artifact is `modular-system-execution-windows`.

This is an unsigned process experiment with a synthetic Internet-zone ADS,
not a browser download, full installed release, Authenticode trust or a
SmartScreen reputation measurement. Those boundaries stay `unverified` in
the receipt even when both scenarios pass. No new product UI is introduced;
the retained UI coverage is TC-MODULES-007/016/022 plus the complete crash
suite. Local tool unit tests mock every process; real Windows execution is
restricted to disposable GitHub runners; source-specific results follow below.

Hosted run [#43978651360](https://github.com/engcapa/taomni/actions/runs/43978651360),
source `237e35f5f31db0aa392c8a92fea820d2e6b8ca30`, passed both Windows
scenarios on Windows build `10.0.26100` AMD64. All three executables were
actually `NotSigned`; both hosts retained the exact Internet-zone ADS and
original hash after execution. The runner reported Defender's service and
antivirus enabled, but real-time, behavior and IOAV protection **disabled**
both before and after; the three observed SmartScreen registry values were
unavailable. This is therefore not evidence of execution under active
real-time protection or SmartScreen policy. No protection setting was changed.
The same source's two macOS Intel scenarios also passed with ad-hoc hardened
runtime and read-back quarantine; `spctl` again returned **3 / rejected**.

Both completed artifacts were downloaded during execution into
`qa-ui-auto-report/github/43978651360/live-contracts/`. G1/G3 distribution and
full release-package boundaries remain open.
