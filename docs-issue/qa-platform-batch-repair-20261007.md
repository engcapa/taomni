# QA platform repair batch — 2026-10-07

Branch: `fix/qa-platform-recording-validation-20261007`.
Baseline: Actions run `37590248109`, commit `332efd2c`.

The workflow conclusion was successful but case artifacts were not all green:
Linux browser 345/345; Windows browser 345/345; Wayland native 135/135;
Linux default native 181/185; Ubuntu 22.04 X11 178/185; Ubuntu 22.04 VNC
174/185; macOS browser 341/343; macOS native 157/159; Windows native 167/169.
The case summaries and matching source receipts remain authoritative.

## Findings and repairs

| Failures | Evidence and change | Required native confirmation |
| --- | --- | --- |
| Windows TC-119 / TC-145 | Git Bash prompt was above blank xterm viewport rows. Inspect rows ending at the cursor; use the short cwd probe and keep readiness held across startup and probe completion. | Windows SSH startup and attached SFTP, with Linux regression |
| Linux N7 / N8 / N11 | Pixel comparisons passed, main restoration did not. The QA fixture hid main outside the capture ledger. Use production hide/restore tracking before fixture sampling; retain the real tool-close assertion. | Three X11 desktops and affected fixture scenarios |
| X11/VNC N20 | XCB aborted with an Xlib threading assertion during Tile. Snapshot monitor/work-area data on the UI thread; remove the ineffective fixed delay between pins. | N20 on X11, VNC, Wayland, Windows and macOS |
| Linux C0-01 / 010-04 / 019-01 / mail keys / TC-143 | DOM activeElement was correct while document.hasFocus was false. Before input, activate both the owned native window and the WebDriver context; preserve focus assertions. | Three Linux X11 desktops and supported Wayland cases |
| Debugger 025-02 | Key trace contains the correct ArrowUp, but popup used the previous line. A deferred React render could overwrite the synchronous caret ref. Make selection callbacks its sole writer. | Linux debugger with real DAP provider |
| macOS TC-003 | Later reopen raced asynchronous save completion. Wait for editor detachment after saving before selecting and editing again. | macOS save/reopen |
| macOS MFA-003 | New TOTP interval arrived before the UI clock tick, displaying 31. Bound elapsed time to the code's validFrom timestamp; retain the 1–30 assertion. | Browser acceptance and focused interval-boundary unit checks |
| macOS browser F6-5 | Startup crash, with 910 ERR_NETWORK_CHANGED entries and failed App.tsx import. Retry only observed transient startup network failures before testcase interaction, bounded to three attempts; retain retry logs. | Browser startup/auth-dismiss |
| macOS RDPJ-02 | Negotiation reports only IronRDP “custom error”. Preserve the source chain and classify typed transient transport causes for the existing bounded reconnect path. Protocol/auth errors still fail. The exact original transport cause was not retained, so this requires targeted confirmation. | macOS joint clipboard, Windows reference and Linux joint regression |
| VNC RDPC-REF-02 | xrdp session inherited the runner's XDG paths; target log was discarded. Isolate the disposable account's XDG directories, use distro Python with installed python3-tk, and preserve target.log. | xrdp native pixel/input oracle |

No assertions are removed or widened. No unsupported Wayland capture/portal case
is presented as passing. Read `docs-feature/screenshot-enhancement-testcase-handoff.md`:
the final nine-entry sweep includes its supported browser/native cases; the
repair stage selects the fixture lifecycle and pin boundaries changed here.

## Windows cost and workflow

The baseline Windows selected-case step took 6,470 seconds. Its native build log
records 34m43s of release compilation. The case run took 4,203 seconds, of which
1,055 seconds were session initialization across 169 independent cases. Linux
case initialization totalled 329 seconds across 185 cases. Windows build tools
and driver setup took 20 seconds; mstsc preflight took 24 seconds.

Keep release profiles, optimization, isolation and sequential native execution.
The planner now assigns platform-independent RDP Rust contracts to one selected
Linux native entry (also works without the default profile). Windows SDK debugger,
heap verifier and mstsc preflight run only when selected cases use `host_mstsc`.
Retain workspace caches and group relevant RDP reference regressions with the
repair batch so those entries reuse the existing release profile. These changes
reduce redundant work; no measured end-to-end speedup is claimed yet.

## Execution order

1. Local focused unit checks, browser acceptance, Rust compile/unit checks and
   case audit. Preserve failed runs and source identities.
2. Dispatch four selected-case groups: Linux native (four desktop profiles),
   Windows native, macOS native, macOS browser. Only repaired cases and direct
   regressions are included. Inspect all actual case summaries.
3. Repair any remaining failures together, validate locally and repeat only the
   affected selected groups.
4. After all selected groups pass, dispatch `scope=all`, all three platforms,
   browser/native, all four Linux profiles: nine entries. Report supported
   pass/fail/skip counts and capability gaps separately. Repeat repairs as needed.

## Local evidence before targeted dispatch

- TypeScript build check and Rust library check passed.
- Terminal startup/cwd regression passes with realistic trailing blank rows and
  readiness held until probe completion.
- MFA formatting/interval-boundary tests passed.
- Workspace command integration test covering diagnostic navigation and debug
  action availability passed (one selected test).
- Rust negotiation transport-cause test, authentication exclusion test, and seven
  pin arrangement geometry/note unit tests passed.
- 109 of 110 initial Python checks passed; the one failing test expected no
  WebView activation. Updated it to check window activation without clicking the
  target, then 26 input/navigation checks passed. The new representative Linux
  RDP contract selection and mstsc capability checks also passed.
- Static case audit passed.
- Browser TC-MFA-003 and TC-auto-F6-5 passed with stable execution identity in
  `qa-ui-auto-report/batch-repair-browser-final/run-20261007-192428-631768018`.
- Native platform confirmation remains pending; this workstation has no built
  isolated QA executable or Xvfb. Hosted targeted runs provide those boundaries.

## Main integration and final targeted selection

Fetched and merged `origin/main` at `41871480` in merge commit `ab3dcf23`.
Git merged without conflicts. The merged pin menu moves arrangement into the
All Pins tab; updated N20's native scenario to select that tab through the UI.
Kept fixture-ledger cleanup scoped to the X11 fixture hide path.

Post-merge TypeScript check passed. All 18 pin/favorite/table-detail mounted
unit tests passed. Browser MFA-003, F6-5, SHOT-035, SHOT-036 and SHOT-037 all
passed on stable inputs in
`qa-ui-auto-report/batch-repair-merged-browser/run-20261007-193415-527685465`.
The selection planner accepts seven execution entries: 25 cases on each of the
three X11/VNC desktops, eight on Wayland, seven on Windows native, five on macOS
native, and five on macOS browser. Wayland includes the xrdp client fixture
(remote Xorg desktop), not a Wayland screen-sharing/portal claim.


## First targeted results at 74b5e7ed

Actual stable case receipts: default Linux 25/25, Wayland 8/8, Windows native
7/7, macOS browser 5/5, macOS native 4/5; Ubuntu 22.04 X11 and VNC each 20/25.
Runs: Linux 37615798377, Windows 37615802651, macOS native 37615806747,
macOS browser 37615811202. Workflow success remains advisory.

Both Ubuntu 22.04 profiles have identical remaining failures: C0-01,
010-04, 019-01, N1 and N10. LXQt launched xscreensaver during the long build;
its animated pixels appear in both capture failures and document.hasFocus
stays false in the focus failures. Disable its autostart and power manager
in the owned disposable desktop before launch, plus X11 idle blanking.
No existing user desktop is unlocked or changed.

C0-01 also exposed a real delayed watcher echo: after a clean ISO-8859-1 save,
read-back of unchanged bytes uses windows-1252 and overwrites the chosen policy.
Compare disk hashes and refresh only file metadata for identical bytes, retaining
encoding, dirty buffer and save errors. The existing C0-01 receipt/retry path
protects this behavior without changing its assertions. The mounted encoding
save test reproduces the label replacement before the fix and passes after it;
three adjacent encoding/watcher/conflict tests also pass.

macOS N20 saves notes and tiles both originals correctly, then the process
vanishes while closing the second pin. No native crash report was retained and
all subsequent bridge requests were refused. Cause remains unverified: collect
an opt-in LLDB all-thread trace on this isolated QA process in a selected macOS
run before making a speculative product change. Debugger use is recorded in the
config and excluded from performance conclusions; remove the temporary workflow
opt-in before normal validation/full measurement. No new full sweep yet.


## Follow-up diagnostics and local checks

Committed the desktop/watcher fix as `1fe14139`. TypeScript, the static audit,
26 desktop checks, 64 transport/supervisor checks, two debugger ownership checks,
and 12 mounted watcher/encoding/external-change regressions pass. Browser
TC-IDE-C0-02 passes with stable identity in
`qa-ui-auto-report/encoding-watcher-browser/run-20261007-204317-231804102`.

The first macOS-only diagnostic (`37622669515`, `31a15ca5`) was cancelled in
build, before any cases: the new diagnostic forced release compilation but
its two-case selection chose a debug cache key. Its retained build log shows
866 compiled crates. Fixed the cache selector in `39d915b0` and dispatched
`37625238005` for N17/N20 only. GitHub records the prior release workspace
cache accessed at 2026-10-07 13:08:06 UTC. Results remain pending.

Add a default-off `native_release` dispatch/call/CLI option. It changes only
the selected native entries' build capability, leaving cases, browser entries,
default profile selection and production release builds intact. The planner
therefore supplies the same profile to execution and cache keys. Use it for
remaining targeted runs to reuse full-run release caches without adding
unrelated RDP/performance cases. Twenty selection/supervisor/workflow checks
pass. Remove the temporary workflow LLDB opt-in before full measurement.

The first batch's Windows build took 22m31s; its seven cases took 229.1s,
including 35.2s of session setup. For TC-143, TC-145 and N20, setup was about
5.6s on Windows versus 1.6s on default Linux. These are different OS hosts and
small selections, not an end-to-end performance improvement claim. Keep
per-case isolation, prioritize matching builds and exact case selection.


The cached diagnostic completed but both cases were **unrun**, failing session
setup with port 4444 still occupied. LLDB's debugserver can place its inferior
in a different process group, so terminating the launcher's group left the QA
app stopped and listening. Fix cleanup to snapshot only the launcher's owned
descendants and kill leaf-first before the debugger, including the restart
path; defer the throwaway diagnostic preflight until after the first fixture
reset. A real POSIX subprocess test proves a child in a separate process group
releases its listening port; sibling-process exclusion and debugger restart
are also tested. Four debugger tests and 19 isolation tests pass. The original
macOS N20 close failure still requires its native trace; no product close change
has been made on speculation. The matching QA build is available for reuse.
