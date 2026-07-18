# ADR-0003: macOS capture technology

**Status:** Blocked-on-infra
**Plan refs:** §4.1, §8, §13 Phase 6, §15

## Context

macOS capture uses a `NETransparentProxyProvider` system extension that decides,
per flow, whether to handle or pass through based on the source app's audit
token, code-signing identity and parent-process chain. The plan requires a
versioned JSON-lines control protocol with caller authentication, heartbeat,
atomic config versioning and recovery state (not merely "the Unix socket exists").

## Decision

1. Ship a Network Extension **system extension** (Xcode target + Rust/Swift
   bridge) that reads `sourceAppAuditToken`, proxies selected apps and returns
   `direct` for the rest.
2. Harden the control protocol: caller authentication, heartbeat, atomic config
   version, explicit recovery state.
3. The provider bypasses its own and the app's upstream traffic.

## Why Blocked-on-infra

Requires an Apple **Network Extension entitlement**, a Developer ID, an Xcode
system-extension target, notarization, and user/admin approval of the extension
on a real macOS machine (Intel + Apple Silicon). These are external,
account-gated, hardware-gated steps that cannot be performed in a code-only
session. The `CaptureAdapter` seam is ready for a macOS adapter that speaks the
provider control protocol.

## Exit criteria (plan §13 Phase 6)

Entitlement obtained; minimal extension captures TCP/UDP and reads the audit
token; selected apps proxied, unselected direct; clean degradation when the user
denies approval; uninstall/upgrade leaves no config behind; Intel + Apple Silicon
builds.
