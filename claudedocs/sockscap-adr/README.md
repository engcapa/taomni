# Sockscap Architecture Decision Records

Phase 0 of the Sockscap plan (`../sockscap-cross-platform-design-plan.md` §13)
requires an ADR set that fixes the capture technology, third-party
versions/licenses, minimum system versions and packaging **before** large-scale
UI work. This directory holds those ADRs.

## Status legend

- **Decided** — the decision is fixed for the current implementation.
- **Provisional** — direction chosen; a Phase 0 spike on real hardware must
  confirm license/signing/performance/compat before it is frozen.
- **Blocked-on-infra** — cannot be completed in a code-only environment; needs
  signed drivers, Apple entitlements, or multi-platform hardware.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-forwarding-core.md) | Third-party forwarding core (tun2proxy vs custom) | Provisional |
| [0002](0002-windows-capture.md) | Windows capture (WinDivert vs WFP ALE) | Provisional / Blocked-on-infra |
| [0003](0003-macos-capture.md) | macOS capture (NETransparentProxyProvider) | Blocked-on-infra |
| [0004](0004-linux-capture.md) | Linux capture (cgroup v2 + nftables + fwmark) | Provisional |
| [0005](0005-ssh-host-key-verification.md) | SSH host-key verification | Decided (implemented) |

## What is implemented in code today

Phases 1–4 are implemented and tested (`src-tauri/src/sockscap`, `src/…`):
the pure policy/rules core, egress connectors, SSH channel pool with host-key
verification, attribution, FlowEngine, persistence, capability probe, the
orchestrator state machine, the full Tauri IPC surface, and the standalone
window UI. The **live capture plane** (Phases 5–7) is behind the
`CaptureAdapter` trait with a `NoopCaptureAdapter`; real backends are
Blocked-on-infra as noted in each ADR. See the design plan §13 for the phase
breakdown and Definition of Done.
