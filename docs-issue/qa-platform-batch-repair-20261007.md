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
