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
