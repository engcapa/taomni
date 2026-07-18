# ADR-0001: Third-party forwarding core

**Status:** Provisional (Phase 0 spike required before freeze)
**Plan refs:** §4.2, §13 Phase 0

## Context

FlowEngine needs a userspace IP stack + connector layer to turn captured flows
(from a TUN device or platform packet source) into upstream connections. The
plan evaluates `tun2proxy` (MIT; Linux/macOS/Windows; HTTP/SOCKS5, IPv4/IPv6,
virtual DNS, SOCKS5 UDP) as the candidate core, referencing `wsstun` commit
`8282eb2` as a behavioral baseline.

The gap: tun2proxy's public API is single-upstream-centric and lacks a per-flow
`RouteSelector`, per-profile stats, and application-identity policy — exactly
what Sockscap's PolicyEngine provides.

## Decision (provisional)

1. Keep `EgressConnector` as Sockscap's own boundary (already implemented:
   `Direct`, `Socks5`, `HttpConnect`, `SshJump`). The forwarding core supplies
   the userspace IP stack and per-flow hook; Sockscap owns routing.
2. Phase 0 spike: verify tun2proxy 0.8.x can expose a per-flow route hook +
   lifecycle callback. If a small upstream contribution suffices, pin to an
   audited version. Otherwise reuse only its MIT modules (or `ipstack`) under
   Sockscap's own connectors.
3. Never pass proxy/SSH secrets on a sidecar command line (plan §4.2).
4. Do not statically link any GPL core into the MIT app; every third-party core
   passes a license/SBOM gate first (plan §3.2, §15).

## Consequences / open items

- The connector layer is done and tested; the TUN/packet-source ↔ FlowEngine
  wiring is the remaining integration and lands with the platform adapters.
- Freeze requires: per-flow selector confirmed, IPv4/IPv6 + SOCKS5 UDP +
  virtual-DNS verified on all three platforms, cancellation + traffic callbacks,
  and a license clearance.
