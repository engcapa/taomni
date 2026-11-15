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
