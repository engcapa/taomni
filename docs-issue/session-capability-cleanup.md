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

## Stage 3 implementation checkpoint (2026-10-23)

- Bookmark values now persist and drive startup/shortcut connections, terminal raster backgrounds,
  custom text icons, SSH retry policy and supported detached windows. Handoffs carry only the
  bookmark fields needed for presentation, and a reattached tab is not detached again.
- SSH expert algorithm preferences validate against russh, key generation creates protected
  Ed25519 files without replacing existing keys, and encrypted private keys prompt through the
  existing authentication challenge UI. SSH Agent signs through the OS agent.
- GSSAPI uses a GSSAPI-enabled OpenSSH client and the OS ticket cache, with password/public-key
  fallback disabled. Terminal and SFTP child/route ownership ends with their runtime. Windows
  requires a GSSAPI-enabled client on PATH; the hosted fixture provisions Cygwin OpenSSH.
- SCP modes use the actual SCP transfer protocol with shell metadata (Python 3 required remotely),
  32 KiB compatibility / 256 KiB fast blocks, explicit progress and cancellation, and partial files
  published only after completion. Further resume and failure-path verification remains open.
- ClickHouse inline INSERT VALUES is rewritten using the SQL AST into INSERT SELECT, which the
  Native query protocol can execute without waiting for a separate binary insert exchange.
- Added hosted native cases for Kerberos terminal/SFTP, OS agent and generated keys, expert
  negotiation, both SCP modes and bookmark file loading. The new runner-owned Kerberos fixture
  performs a real KDC ticket exchange and SSH command probe; no synthetic pass is accepted.
- Local validation: 233 focused frontend tests; 4 SFTP protocol/unit checks; 1 Native INSERT
  normalization check; 2 remote metadata subprocess checks. TypeScript and refactoring contracts
  pass. Browser/native execution remains exclusively in GitHub; this checkpoint is not acceptance.
- Stage 2 run 39976065183: execution steps returned success because complete failure reports are
  intentionally aggregated later. The aggregate revealed TC-SESSION-CH-001 fixture failures on
  all three platforms: ci_execute omitted ClickHouse from its service-start capability guard.
  macOS additionally hit artifact upload timeouts and a rerun identity mismatch. This is failed
  evidence, not a protocol pass. Fix the capability guard for ClickHouse and new SSH fixtures,
  then run a fresh invocation so every receipt shares one selection/run identity.

## Stage 4 follow-ups

- Strip stale mail, database, RDP, VNC, object-storage, local-shell and serial option keys
  on protocol changes, including their credential references. Keep unknown extension data.
- Preserve saved session identity when a terminal is reattached, keep the background in both
  windows, and allow SSH reconnect after adoption. Add real multi-window browser/native
  acceptance; extend the QA-only macOS W3C adapter to enumerate/switch actual WebViews.
- Stage 3 browser receipts on macOS/Windows exposed a hidden session-sidebar button after
  startup automatically selected the file sidebar. Update the case to activate Sessions before
  New Session, retaining all startup/shortcut/input-protection assertions.
- Add real disconnect/reconnect to generated-key acceptance and retain certificate identities
  when authenticating through SSH agent. Remove obsolete import/runtime placeholder text.

## Hosted fixture and window corrections

- Run 39984004315 reached real SSH/Kerberos setup on Linux but OpenSSH rejected
  the hosted runner's locked Unix account before GSSAPI. Enable Linux PAM account
  checks without enabling password or keyboard-interactive authentication.
- Run 39985713565 browser receipts passed TC-127, TC-128, BOOK-001, CAP-001 and
  NET-001 on Linux/macOS. BOOK-003 incorrectly required native local PTY APIs
  in browser preview. Keep its real local-terminal/window/adoption assertions
  native-only on all three OSes; TC-128 retains browser new-window persistence
  coverage. Assert computed shell output to distinguish execution from echo.

- Hosted macOS probes now prove Kerberos, agent and generated-key authentication.
  GSS/KEY UI cases left the result modal open and addressed a non-focusable
  terminal wrapper; close each result dialog and type into xterm's textarea.
- Windows setup diagnosed Cygwin's extensionless PE kadmin.local executable.
  Preserve full SSH probe diagnostics and report missing executable names.
- ClickHouse did not open its TCP listener; background pool starvation with
  64 global threads is the current hypothesis, pending new service logs. Bound each background pool and provide 256 global
  slots; retain information-level service logs for the next hosted run.

## SCP interrupted-download recovery

- Download partial identities bind destination, endpoint, user and remote path.
  OS-held file locks reject concurrent writes and recover after process exit;
  partials cannot follow symlinks or Windows reparse points.
- Verify the existing prefix against the remote file before resuming a suffix
  over SCP framing. Restart stale partials with visible feedback. Check SHA256
  of the complete download before atomic publication, preserving the previous
  destination on failures/cancellation. Background transfer ownership remains
  in the existing native transfer manager, independent of the queue view.
- Explain remote Python/scp prerequisites. Display connecting/verifying and
  resumed/restarted feedback; retain that evidence after the queue reopens.
- Native SCP cases seed interrupted/stale files on the runner, assert complete
  SHA256 bytes and visible recovery outcomes. TC-127 retains browser coverage
  of mode switching and the prerequisite explanation.
- Local checks: 64 existing frontend tests and one queue restoration test;
  three Rust SCP boundary tests; 23 Python helper/service tests. Hosted evidence
  for the new recovery behavior is pending.

## Remote desktop transport acceptance

- Add TC-SESSION-X11-001 on all native platforms: persist a custom desktop
  command, connect through product SSH/X11, launch real xclock and independently
  observe its named window using xwininfo. No fixture starts that client.
- Provision native X11 tools on Linux, XQuartz/Xvfb on macOS and Cygwin Xvfb on
  Windows. Keep Linux on the invocation's existing display; other desktop clients
  use a private authenticated X server. Hosted execution remains pending.
- This acceptance proves custom remote graphical commands and X11 transport.
  Named desktop startup mappings have unit coverage; complete GNOME/KDE/Xfce
  desktop-session compatibility is not yet established by this case.

## Hosted verification checkpoint

- Run 40036370220 (ce00536b) browser: 5/5 cases passed on each OS. macOS native:
  all 9 selected cases passed, including real ClickHouse HTTP/Native DDL/DML,
  GSSAPI terminal/SFTP, generated key/agent/expert auth/reconnect, background image,
  detach/reattach and both SCP modes. This predates SCP resume and X11 additions.
- Windows CAP/NET passed; protocol fixture failed at Microsoft ssh-add because
  Cygwin's POSIX group ACL entries are rejected. Create an owner-only native key
  copy for the Windows agent while retaining the Cygwin key for SSH services.
- Add native SCP lifecycle coverage with a real bandwidth-limited scp command
  and a separate large file: pause, close/reopen the file browser, resume, cancel,
  retry, assert nonzero resumed bytes and exact published SHA256.

- Linux GSSAPI probe diagnostics identified unexpected cross-realm requests for
  the runner cloud DNS search domain. Disable MIT short-host qualification and
  map the actual runner hostnames to the disposable realm, with matching host
  principals. Preserve normal hostname verification; do not disable GSSAPI.

- Add TC-SESSION-KEY-002 for product-generated encrypted keys, cleared generator
  passphrase state, actionable connection-test guidance, masked runtime unlock
  prompt and a real authenticated command. Authorize only the generated public
  key; disposable passphrase is masked in CI and never stored in case YAML.

## Hosted failure recovery (40039000974 / 40039391994)

- Linux now passes real GSSAPI, generated-key/agent, bookmarks/windows and all
  three SCP cases. macOS passes encrypted generated-key unlock (KEY-002).
- SCP cancellation previously exposed Retry before worker shutdown and reused
  its native transfer identity. A delayed cancellation completion could clobber
  the retry row/listeners. Await the worker event, replace the row with a fresh
  attempt ID, and wait for actual bytes before cancelling in SCP-003. Retain
  partial verification and exact destination hash assertions.
- X11 acceptance incorrectly waited for an idle shell after exec replaced it
  with a graphical client. Wait for the terminal view then directly verify the
  independently observed real X window; graphical execution remains unverified
  until the corrected hosted case passes.
- Linux wrong-password acceptance exposed clickhouse-rs panicking on EOF during
  Hello, leaving IPC unresolved. Contain driver unwinds inside each owned query
  operation and report an actionable error. Exercise repeated early disconnects
  using a local TCP unit fixture; hosted authentication recovery remains required.
- Await SSH auth-event subscription before starting native authentication; if
  subscription fails, report connection failure. Closing during registration
  disposes the listener and never starts a new backend. Mounted tests cover all
  three outcomes; KEY-002 supplies real encrypted-key boundary coverage.
- Windows run 40039391994 passed agent ACL setup but sshd refused the generated
  host key's inherited 0640 mode. Explicitly chmod Cygwin keys to 0600 and run
  sshd configuration/host-key validation before starting the service. This is
  fixture setup failure, not executed Windows authentication evidence.
- Reject Native INSERT payload syntax that requires a separate binary upload
  before sending the SQL. Inline VALUES and INSERT SELECT remain supported;
  FORMAT imports report actionable HTTP guidance. CH-001 now checks prompt
  rejection, successful subsequent SELECT and unchanged row count.
- Narrow stale-option deletion to explicitly owned protocol keys. Prefix-based
  deletion could discard unknown importer/plugin settings such as
  dbeaverCredentials. A focused persistence unit regression covers unknown keys;
  retained CAP-001 and NET-001 continue covering configuration save/reopen on
  browser/native. No new UI or executable entry is introduced by this correction.
- Run 40040881435 at 09ad2278: Linux and macOS each passed all 13 selected native
  cases, including real X11 windows, ClickHouse bad-password recovery, encrypted
  keys and SCP pause/cancel/retry. This predates the FORMAT and extension-key
  corrections; latest complete matrix is run 40042252443 at 7042a3b8.
- Add GSS-002 to remove only the disposable fixture's ticket cache for the case,
  assert actionable authentication failure, then restore the cache on teardown.
  No shared credentials or product state are modified by this negative fixture.
- Windows run 40041216988 proves real GSSAPI, agent/generated-key authentication,
  encrypted key unlock and X11 windows. SCP fixture scripts and text samples were
  written with platform CRLF translation: the shell wrapper failed to execute
  and sample byte hashes differed. Write runner-owned POSIX scripts/configs and
  deterministic text samples with explicit LF on every OS; retain failed runs.
