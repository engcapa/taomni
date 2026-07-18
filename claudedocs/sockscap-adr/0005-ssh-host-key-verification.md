# ADR-0005: SSH host-key verification

**Status:** Decided — implemented
**Plan refs:** §4.3-8, §16.5-19, §15 (release-blocker), §13 Phase 2

## Context

`terminal/ssh.rs::check_server_key` previously returned `Ok(true)`
unconditionally (a `// TODO`), accepting any server key. The plan flags this as
a **release blocker** for SSH-jump egress: without host-key verification the
jump is trivially MITM-able.

## Decision (implemented)

1. Add an optional `HostKeyCheck` verifier hook to the shared `SshHandler`
   (`terminal/ssh.rs`). When `None` (terminal / tunnel) behavior is unchanged —
   no regression to those paths, whose interactive host-key UX is tracked
   separately. When `Some` (Sockscap egress) the verifier decides and a rejected
   key aborts the handshake.
2. `connect_ssh_egress` reuses the real transport/config/auth stack with the
   verifier injected and opens no PTY.
3. `sockscap::known_hosts::HostKeyStore` is a Sockscap-owned, trust-on-first-use
   store (separate from `~/.ssh/known_hosts`). `verify()` returns:
   - **Verified** — key matches → accept.
   - **Changed** — host known, key differs → MITM alarm, block, require explicit
     human re-confirmation.
   - **Unknown** — new host → first-use confirmation required.
4. `ssh_pool::StoreHostKeyVerifier` bridges the hook to the store and records the
   verdict so the pool raises `UserActionRequired` (never a silent upstream
   switch).

## Status

Implemented and unit-tested (`known_hosts` 6 tests, `ssh_pool` verdict tests).
This satisfies the SSH-egress host-key release gate at the Sockscap layer. A
follow-up (out of scope here) should adopt the same verification for the
interactive terminal/tunnel SSH paths before their own release.
