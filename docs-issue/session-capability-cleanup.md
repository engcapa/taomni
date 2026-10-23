# Session configuration capabilities and implementation

Branch: `feat/session-capability-cleanup`.

## Scope and retained contracts

The user explicitly requests implementation of all previously identified missing
capabilities, including GSSAPI, ClickHouse Native, SCP modes, remote desktop
environments, bookmark backgrounds, shortcuts and startup behavior. Remove only
configuration that does not apply to the selected session transport. Preserve
SSH X11, startup commands, forwarding, authentication, connection ownership,
secrets in the vault, and independent per-session networking.

## Delivery stages

1. Centralize capability policy for editor navigation, validation, secrets and
   persistence. Remove local/command/browser network controls and SSH-only
   controls from non-SSH sessions. Collapse duplicate Nagle controls. Preserve
   existing supported proxy routes and unknown extension options.
2. Implement missing SSH/network capabilities: application/independent/direct
   proxy selection, system proxy resolution, OAuth through SSH, compression,
   GSSAPI, remote environments, SCP selection, key generation and expert options.
3. Implement ClickHouse Native and one effective endpoint per protocol.
4. Persist and execute bookmark appearance, shortcuts, auto-connect, new-window
   and reconnect settings with appropriate session capability gates.
5. Extend browser/native cases, hosted fixtures and catalogs. Validate locally
   with focused unit and static checks only. Push detailed English commits;
   execute `.github/workflows/qa-ui-auto-platforms.yml` for Linux, Windows and
   macOS in browser and native modes. Diagnose and fix non-performance failures
   until the complete requested matrix passes. Retain original failed reports.

## Verification boundaries

Browser cases cover protocol switching, conditional controls, save/reopen,
validation, shortcuts and retained workflows. Native cases additionally verify
SQLite persistence, actual transport negotiation, routing, authentication,
filesystem transfer, external processes, window ownership and startup/reconnect.
Hosted fixtures must provision and probe ClickHouse and every added service;
missing service readiness must fail instead of weakening acceptance or skipping.

No browser/native suites run locally (explicit user instruction). Unit tests,
TypeScript/Rust checks, catalog audits and CI planning may run locally. Performance
failures may be reported separately, per user authorization.

## Progress

- Created branch from clean `main`; authenticated GitHub CLI is available.
- Existing implementation and case baselines inspected; runtime baseline not yet
  established. No runtime equivalence is claimed from static inspection.

### Stage 1 evidence

- Focused Vitest: 83 tests passed (session editor and capability sanitation).
- TypeScript build and refactor contracts passed.
- Coverage baseline removes exactly one required control: the duplicate Disable
  Nagle toggle. Its behavior remains asserted through TCP_NODELAY in TC-123 and
  TC-129. No transport assertion was dropped.
- TC-SESSION-CAP-001 covers all editor protocol tiles, SSH/SFTP boundaries and
  save/reopen in both browser and native modes. It requires only reset_db; no
  predecessor dependency is needed. Hosted execution is pending.

### Stage 2 implementation and pending native evidence

- Added application inheritance, independently persisted proxy configuration and
  explicit OS proxy selection. Retained legacy HTTP/SOCKS and jump sessions.
  New sessions default to application inheritance; legacy sessions retain direct
  routing. Explicit direct mode bypasses environment proxies.
- OAuth requests now own their SSH forward and runtime through client teardown.
  SSH compression is propagated to both saved connections and connection probes.
- ClickHouse Native uses the actual TCP driver for authentication, typed queries
  and streaming. Native TLS through a proxy is terminated at the upstream stream
  with the original hostname and OS trust roots, preserving certificate checks.
  Database forward tasks now abort on failed or cancelled connection setup.
- Hosted ClickHouse 25.8.12.129 uses pinned SHA256 packages on Linux/macOS and a
  disposable WSL2 Linux distribution on Windows. Setup authenticates both TCP
  and HTTP, verifies UInt64/NULL values and executes real DDL/DML. Windows WSL2
  startup remains unverified until the hosted run finishes; it is not skipped.
- TC-SESSION-NET-001 covers protocol-specific ports, custom proxy persistence and
  mode transitions in browser/native. TC-SESSION-CH-001 uses the real service in
  native mode for HTTP/Native authentication, bad passwords, unavailable proxy,
  recovery, vault persistence and query results. Browser database commands are
  deliberately unavailable in this project; editor coverage uses browser mode.
- Focused Vitest: 90 passed; ClickHouse Rust value decoding test passed; four
  fixture package/configuration/fail-closed tests passed. Further transport
  contracts and hosted execution are in progress.
