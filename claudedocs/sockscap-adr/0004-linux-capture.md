# ADR-0004: Linux capture technology

**Status:** Provisional
**Plan refs:** §4.1, §8, §13 Phase 7, §15

## Context

The plan reuses `wsstun`'s validated Linux paths: existing processes captured
via cgroup v2 + nftables socket-cgroup match + fwmark policy routing (saving the
original cgroup for restore); managed launches via user/network namespaces.
eBPF `connect` hooks are kept as a later performance/compat alternative, not a
first-implementation prerequisite.

## Decision

1. **App/PID capture:** cgroup v2 + nftables socket-cgroup + fwmark policy
   routing, restoring the original cgroup on exit.
2. **Managed launch:** run the target program in a user/network namespace.
3. **Global:** TUN.
4. **Capability honesty:** when cgroup v2 / nft / iproute2 are missing, do not
   claim PID attach — degrade to global or managed-launch and explain why. This
   is already implemented in `capability::linux_caps` (PID → `Unsupported`,
   app → `Degraded` without cgroup v2) and unit-tested.
5. eBPF is evaluated only if the baseline fails.

## Why Provisional (not fully in code)

The pure capability probe and degradation logic are implemented and tested. A
shippable backend still needs a **minimum-privilege helper** (polkit/CAP_NET_ADMIN
install), nft/route/cgroup manipulation with recovery, and testing against
systemd-resolved / NetworkManager / IPv6 across the target distro matrix — root
privileges and real hosts that a code-only session lacks. The `CaptureAdapter`
seam is ready for a Linux adapter.

## Exit criteria (plan §13 Phase 7)

Global + application group across the supported distros; PID attach degrades by
capability probe when unavailable; no leftover nft/route/cgroup state; AppImage/
deb/rpm capability + uninstall review.
