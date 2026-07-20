# ADR-0002: Windows capture technology

**Status:** Provisional (global) / Blocked-on-infra (app/PID drivers)
**Plan refs:** §4.1, §8, §16.7-26, §15

## Context

Windows needs two capture modes: global new-connection capture and per-app /
per-PID capture. The plan requires a dual spike comparing the `wsstun` WinDivert
path (SOCKET/FLOW/NETWORK layers correlating PID ↔ 5-tuple, dynamic per-flow
filters, packet reinjection) against a WFP ALE redirect callout, decided by an
ADR on license, signing, performance, reinjection correctness, IPv6, and
EDR/VPN compatibility.

## Decision (provisional)

1. **Global capture:** Wintun/TUN as the baseline (well-understood, permissively
   licensed).
2. **App/PID capture:** Phase 0 dual-spikes WinDivert vs a self-owned WFP
   helper/callout. WinDivert is LGPLv3/GPLv2 dual-licensed and ships a matching
   signed driver; adoption is gated on a license + signing + EDR/VPN + reinjection
   ADR (the repo already vendors a patched `windivert-sys`, so the option is
   real but not free of obligations).
3. Add engine PID + upstream endpoints to the hard-bypass set so capture never
   recurses into its own control traffic (already enforced in `policy::HardBypass`).

## Why Blocked-on-infra

Producing a shippable app/PID backend needs a **signed, distributable kernel
driver** (Wintun/WinDivert or a WFP callout) plus admin-elevated install/uninstall
and EDR/VPN compatibility testing on real Windows hosts. None of that can be
produced or validated in a code-only session. The code seam is ready:
`capture::CaptureAdapter` + `NoopCaptureAdapter`; a Windows adapter implements
`install`/`uninstall`/`is_ready` against the chosen driver.

## Exit criteria (plan §13 Phase 5)

Signed install/upgrade/uninstall + recovery; app/PID/child new-connection
semantics; SOCKET/FLOW ownership race + dynamic 5-tuple filter + reinjection (if
WinDivert); no leftover Wintun/WinDivert/WFP state after restart/crash/update.
