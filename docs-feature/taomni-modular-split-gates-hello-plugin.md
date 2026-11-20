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

## G5 frame transport measurement

The registered `protocol_only=true` run measures two BGRA workloads on the
same runner and release profile. Each route sends 30 warmup frames followed
by 150 measured frames at 640×360/60 Hz and 1920×1080/30 Hz. Both routes use a
single slot for the latest frame. For the host route, a child receives a
private descriptor on stdin and authenticates on loopback using the native
binary handshake. It reconstructs each full frame, checks the bytes and
acknowledges the sequence before the sender takes the latest pending frame.

The `modular-rdp-frames-*` artifact contains raw publication and delivery
timestamps, replacement counts, delivered fps and p95 latency. The host
timing includes the acknowledgement. This test uses fixed pixels and runs
only in the Rust test harness. The end-to-end gate also requires the actual
RDP capture and encoder path to meet the `rdp-probe` budgets with the host
transport in place. `TC-RDPS-PERF-01-performance-budget` records the current
in-process product baseline.

The RDP probe is a QA-only workspace package in `src-tauri/crates/taomni-rdp-probe/`.
Its standalone release build takes the original RDP client dependencies and
can measure an already installed application. `native_build.py` stages the
probe beside the matching QA executable for platform workflow cases.

The installed Linux deb from `c660c6bb6` passed the native performance case.
First graphics took 81 ms, input-to-frame p95 was 30.40 ms across all 40 samples,
and the probe displayed 55.38 animation frames per second at 390.17 kbps.
[Installed measurement](https://github.com/engcapa/taomni/actions/runs/44421453756)

The hosted protocol workflow can also run the Linux X11 comparison with
`protocol_only=true` and `rdp_pipeline=true`. The same release harness drives
the product X11 capture, input, bitmap preparation and IronRDP encoder both
in one process and with the encoder in a child process. The child takes one
bitmap at a time over the authenticated loopback WebSocket. The comparison
uses the connection and throughput assertions from the existing native case
and retains the probe reports and encoder process receipts. For G5, the
user-approved p95 allowance doubles the case's 65 ms reference to 130 ms.
The comparison and installed release checks capture the applied limit. X11
uses a fixed desktop size for these trials. The normal packaged app still
uses its in-process RDP path. The real module lifecycle, Wayland and the
Windows and macOS capture paths remain separate G5 work.

The first real X11 comparison passed on source 8296a705da89b8bc4098bde235805c2eddf28630.
All six trials passed. The child encoder received one full 8,294,400-byte bitmap
for connect, 44 bitmaps with 43 damage regions for latency, and 666 bitmaps
with 664 damage regions for throughput. The evidence retains the exact reviewed
case digest, release harness hash, probe hash, process IDs and transport byte
counts. [Linux X11 comparison #44432198468](https://github.com/engcapa/taomni/actions/runs/44432198468)

GitHub tested source `fd123747c26d8ad8f7f9f44211e4b7658a30fd97`. Each route
delivered 150 of 150 measured frames for both workloads. The harness requests
millisecond timer resolution for its Windows process, and all reports include
the actual publication times. The earlier run captured Windows below its
configured rate on both routes. [Recheck #44411459433](https://github.com/engcapa/taomni/actions/runs/44411459433) · [Initial run #44410472315](https://github.com/engcapa/taomni/actions/runs/44410472315)

| Runner | Frame size and target | In-process fps / p95 ms | Host fps / p95 ms |
| --- | --- | --- | --- |
| Ubuntu 24.04 x64 | 640×360 at 60 Hz | 60.00 / 0.108 | 59.99 / 0.734 |
| Ubuntu 24.04 x64 | 1920×1080 at 30 Hz | 29.99 / 0.844 | 30.00 / 3.385 |
| Windows x64 | 640×360 at 60 Hz | 60.01 / 0.067 | 60.02 / 0.467 |
| Windows x64 | 1920×1080 at 30 Hz | 29.99 / 0.566 | 30.00 / 3.507 |
| macOS 15 ARM64 | 640×360 at 60 Hz | 59.95 / 0.134 | 59.83 / 1.067 |
| macOS 15 ARM64 | 1920×1080 at 30 Hz | 30.02 / 1.535 | 29.99 / 5.025 |

## `capture.still` service integration (2026-11-17, verification pending)

The additive v1 service is `core/capture.still`, advertised as `capture.still`
only when the verified manifest grants `capture.screen`. Its empty request
rejects host-selected windows, displays and capture policies. A trusted core
facade must additionally attach the invoking `WebviewWindow` to one admitted
operation with `invoke_scoped_capture`; the generic renderer plugin API cannot
construct that grant. A permission without that grant returns PermissionDenied.

`WindowStillCapture` uses the existing core hide/permission/restore owner. It
reserves luma and encoded buffers from the single core transfer pool before
capture. Bounded native paths preflight geometry; the existing unlimited entry
retains its old policy. Native OS/RGBA decoder scratch is separate from these
transport reservations. The wire remains the existing TQF1 luma layout, bounded
to 64 MiB and checked for overflow, truncation, trailing bytes and bad geometry.

The descriptor frame is zeroizing and retains its own operation reference. Its
offer transfers to the authenticated ServiceSession before the writer flushes;
dropping the descriptor must not cancel a receiver that is starting. Finished
handles are pruned, at most eight remain, and session drop aborts unclaimed
streams. Actual network tasks keep their request/OS lease until resource cleanup.
SDK cancellation and its original operation deadline also cover receiving and
verifying bytes, independently of the business worker/read-pump lifetime.

New pure units cover permission/origin rejection, replay, descriptor context,
media type and cancellation. Four ignored-by-default `taomni-host-gates` tests
exercise a real SDK child, the production pump/dispatcher, exact multi-display
bytes, missing grant, deadline/drain and session-drop socket reclamation on
GitHub. Their controlled pixels do not establish native capture or TCC behavior.
Three additional ignored SDK socket tests hold a real WebSocket after its first
TQF1 prefix: explicit operation cancellation and the original absolute deadline
must close the actual client connection, independently observed by the peer;
a hash-valid, normally closed but malformed TQF1 container must never reach
business code. These tests are only compiled locally and executed on GitHub.
The additional WebSocket dependency is test-only; production dependencies and
runtime code remain those of `21d768144da0d8835d262705571bf8fddc59929c`.
TC-MFA-007 and TC-MFA-106 retain the browser boundary and actual core screen scan;
the latter's macOS permission gap stays explicit. This service adds no UI entry,
so there is no new YAML flow that can truthfully invoke it before MFA migration.
The retained cases plus complete browser/native crash-regression must run for
the new source, while the new native gate verifies its private service path.

Production MFA has not switched to a host. Synchronous OS capture cannot be
preempted: cancellation keeps its lease until capture returns and the window is
restored, then discards late bytes. Physical capture through an installed MFA
host, source-specific TCC, G5 throughput and the other G1–G11 gates remain open.

For source `21d768144da0d8835d262705571bf8fddc59929c`, hosted
[protocol run #44009531599](https://github.com/engcapa/taomni/actions/runs/44009531599)
passed on Linux X64, Windows X64 and macOS ARM64. Each platform passed all four
SDK child capture tests and the original 18 resource/transport scenarios.
The API (25), services (42), stream (14) and SDK (21 on Unix / 19 on Windows)
pure units also passed; Linux selection passed 25. All four artifacts were
downloaded during execution and their exact source SHA checked. The same
source's [host run #44009587460](https://github.com/engcapa/taomni/actions/runs/44009587460)
passed all 36 process/lifecycle scenarios per platform, with all three raw
artifacts downloaded during execution. Raw evidence is under
`qa-ui-auto-report/github/<run>/live-contracts/`. These results precede the
three additional SDK socket tests, which still need their own matching run.

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
observations, mount removal, and real read/write recovery. That batch covered
the host adapter and the isolated QA app.

The released-package build passed profile relocation using its deb, RPM and
AppImage. The runner verified the noexec error, HOTP advance from the new
profile, original file hashes and mount cleanup for each format. It installed
the RPM on Ubuntu and launched the AppImage in extract-and-run mode.
[Installation record](taomni-modular-installed-upgrade-verification.md#linux-安装格式的-noexec-恢复) · [GitHub verification](https://github.com/engcapa/taomni/actions/runs/44405163808)

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
