# Workspace-first retained case migration

Navigation entry migration; the current results below come from reviewed execution summaries. Browser passes do not establish native behavior.

## Navigator and editor rail reconciliation (2026-10-08)

The design §2 replaces the per-runtime sidebar policy, and §4.3 makes Hide/restore
an explicit navigator action. Runtime switches therefore retain the current
navigator choice, including local shell and Code Workspace. Explicit changes
persist to the global compatibility key; the old group keys remain readable and
are updated for compatibility. Workspace canvas layout restoration stays scoped
to the selected Workspace. The merge setting, Project pane width, tool actions,
icon/name menu and the Settings action remain functional.

`TC-IDE-PARITY-027-01/02/03` and `TC-MAIN-RAIL-01` now explicitly hide the navigator
before testing rail integration. The terminal return path uses More → open
surface, since Home no longer displays session tabs. Editor selectors distinguish
the visible instance from intentionally mounted background editors. The macOS
header exposes More alongside the native menu, using the existing Lucide icon and
command menu. Reference lifecycle cases target the reference button instead of
text that can also match an option during asynchronous membership persistence.

Windows browser receipt `windows-browser-rail-v3/run-20261008-112856-437429700`:
5 passed, 0 failed, 0 skipped, stable identity. It covers the two browser IDEA rail
cases, main rail, VNC resource lifecycle and Mail IDLE lifecycle, using the local
WSL OpenSSH, portable MySQL and VNC fixtures. Focused unit verification: 99 store,
ChatDrawer and ControlBar tests passed; 3 shell navigator tests passed. Native and
full-suite verification remain pending on this revision.

Hosted run `37717056113` is **not an acceptance pass**: Linux browser 6/9,
Linux native 10/14, macOS browser 6/9, macOS native 9/14 passed. The workflow's
`report_ok` gate validates evidence completeness; its green state does not mean
all cases passed. Inspect `passed`, case totals and failure details on every run.

| Case | Old → new entry | Retained results | Modes | Evidence |
|---|---|---|---|---|
| TC-013 | Initial Work → Sessions | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-036 | Initial Work → Sessions | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-037 | Initial Work → Sessions | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-038 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-041 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-042 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-053 | Initial Work → Sessions | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-054 | Initial Work → Sessions | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-055 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-061 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-062 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore; Welcome tab → More → Welcome | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-102 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-103 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-108 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-110 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser, native | Browser W/L/M: passed (B154); native: not selected (N-scope below) |
| TC-MAIL-AUTOCONF-01 | Initial Work → Sessions | All existing business assertions retained | browser, native | Browser W/L/M: passed (B154); native: not selected (N-scope below) |
| TC-MFA-001 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-002 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-003 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-004 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-005 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-006 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-007 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-008 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-009 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-010 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-011 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-012 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Browser W/L/M: passed (B154) |
| TC-MFA-101 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-102 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-103 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-104 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-105 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-106 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-107 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-MFA-108 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Native: not selected (N-scope below) |
| TC-SESSION-TREE-01 | Initial Work → Sessions; Reload → explicit destination | All existing business assertions retained | browser, native | Browser W/L/M: passed (B154); native: not selected (N-scope below) |
| TC-SESSION-TREE-02 | Initial Work → Sessions; Reload → explicit destination | All existing business assertions retained | browser, native | Browser W/L/M: passed (B154); native: not selected (N-scope below) |

## Current evidence and native boundary (2026-10-09)

B154: source `1e1df5b4`, Windows `qa-ui-auto-report/workspace-first/windows-git-integrated-browser-v2/windows-browser/run-20261009-172039-028419400/summary.json` (154/154, identity stable), Linux/macOS GitHub run [37908867081](https://github.com/engcapa/taomni/actions/runs/37908867081) (154/154 each; actual CI summary passed, no gaps). Later fixes and their focused reruns are recorded in [implementation](workspace-first-navigation-implementation.md).

N-scope: Workspace native 001–011, IDEA 008-03/018-02/027-02/027-03 and MAIN-RAIL-01. Final source `d3e22aed`: Windows `windows-final-native-recovery` and GitHub run `37918956195` pass 16/16 on each OS, without skips. Earlier shared-SFTP and Windows profile-lock failures remain documented in the implementation record. The selected scenarios establish SQLite restart, real PTY, shared SSH/SFTP and SHA-256 roundtrip, VNC, MySQL, Mail IDLE, detached-window return and Git disk/index/ref preservation. The later responsive theme-button CSS and its runner-compatible assertions are verified in three-host browser mode at `4a82ad28` by GitHub run `37962126026` (2/2 per Linux/macOS, Windows focused pass), per the user's UI-only scope.

MFA 101–108, SessionTree native duplicates and other historical native business suites in this table were not selected: their changes only enter Sessions explicitly, while the business implementation and assertions remain intact. MFA 001–012 and the corresponding renderer flows ran in B154; dedicated Workspace native cases cover the changed runtime ownership. These rows are not native passes, and do not claim OS-global hotkey, every provider or RDP host coverage. RDP requires its own real server fixture and is outside this run's named resource selection.
