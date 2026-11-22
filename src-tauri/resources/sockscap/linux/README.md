# SocksCap Linux runtime

The Linux capture backend uses `nftables` OUTPUT NAT plus cgroup v2 process
matching. Redirected TCP connections enter Taomni's loopback relay, which reads
the original destination through `SO_ORIGINAL_DST` and applies the normal
SocksCap rule and upstream policy.

## Runtime requirements

- A Linux kernel with nftables and cgroup v2 enabled.
- The `nft` executable (the DEB/RPM bundle declares an `nftables` dependency).
- Permission to create and move cgroups under `/sys/fs/cgroup`, and
  `CAP_NET_ADMIN` to install the temporary nftables table. A regular desktop
  session normally needs an administrator-approved, narrowly scoped launcher
  or a delegated cgroup from its service manager.

The application deliberately does **not** grant the full GUI process broad
Linux capabilities during installation. Operators should provision the least
privilege mechanism appropriate for their desktop policy rather than applying
`CAP_SYS_ADMIN` to Taomni wholesale.

## Lifecycle and recovery

While active, SocksCap owns only its marked `inet taomni_sockscap` nftables
table and creates cgroups named `taomni-sockscap-<pid>`. Stop removes the table
before the relay and restores moved processes to their original cgroups.
Normal application exit and updater relaunch run the same teardown before the
process terminates; if cleanup fails, the transition is blocked so the user can
retry or run **Recover network**.

**Recover network** removes a residual table after an unclean shutdown only
when its ownership marker is present, and only deletes empty generated cgroups;
it never moves an unrelated live process. Desktop sessions request sudo
authorization when that recovery needs `CAP_NET_ADMIN` or cgroup permissions.

## Xray upstreams

The signed SocksCap module ships the pinned Xray executable and its MPL-2.0
license. The module host verifies and starts Xray for Shadowsocks, Trojan,
VMess, VLESS and WireGuard. The packaged executable and its digests are
defined in `src-tauri/plugins/sockscap/resources/xray/release.json`.
The standalone `scripts/fetch-xray.ps1` stages a fixture for the Rust integration
suite.
