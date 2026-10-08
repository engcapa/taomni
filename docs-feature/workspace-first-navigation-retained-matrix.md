# Workspace-first retained case migration

Navigation-only migration; execution status remains pending until the matching run is reviewed.

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
| TC-013 | Initial Work → Sessions | All existing business assertions retained | browser | Pending rerun |
| TC-036 | Initial Work → Sessions | All existing business assertions retained | browser | Pending rerun |
| TC-037 | Initial Work → Sessions | All existing business assertions retained | browser | Pending rerun |
| TC-038 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-041 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-042 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-053 | Initial Work → Sessions | All existing business assertions retained | browser | Pending rerun |
| TC-054 | Initial Work → Sessions | All existing business assertions retained | browser | Pending rerun |
| TC-055 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-061 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-062 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore; Welcome tab → More → Welcome | All existing business assertions retained | browser | Pending rerun |
| TC-102 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-103 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-108 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-110 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser, native | Pending rerun |
| TC-MAIL-AUTOCONF-01 | Initial Work → Sessions | All existing business assertions retained | browser, native | Pending rerun |
| TC-MFA-001 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-002 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-003 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-004 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-005 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-006 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-007 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-008 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-009 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-010 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-011 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-012 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | browser | Pending rerun |
| TC-MFA-101 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-102 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-103 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-104 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-105 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-106 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-107 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-MFA-108 | Initial Work → Sessions; Welcome default → Sessions → Recent sessions and restore | All existing business assertions retained | native | Pending rerun |
| TC-SESSION-TREE-01 | Initial Work → Sessions; Reload → explicit destination | All existing business assertions retained | browser, native | Pending rerun |
| TC-SESSION-TREE-02 | Initial Work → Sessions; Reload → explicit destination | All existing business assertions retained | browser, native | Pending rerun |
