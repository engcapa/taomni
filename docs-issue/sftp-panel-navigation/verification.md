# SFTP panel navigation

The detached SFTP view had no restore action or SFTP reattach handler. Its new
top-right **Restore to side panel** action returns the popup's current remote and
local directories to the original SSH tab, closes the popup's independent SFTP
channel/window, and preserves the original SSH terminal. If the source SSH tab
has already closed, restoration opens a standalone SFTP tab.

The SSH actions menu always includes SFTP with either Sessions width. The left
rail no longer contains a competing entry. A draggable 38 × 32 pixel button opens
the hidden panel and disappears while it is visible. Its normalized position is
persisted and clamped after resize. The panel's former close control now uses a
hide icon and accessible hide label.

## Behavioral coverage

| Behavior | Evidence |
| --- | --- |
| Expanded/collapsed actions menu, no rail entry, compact floating geometry, drag without activation, persistence, keyboard activation, hide icon, live SSH | `TC-SFTP-ENTRY-001`, browser and native |
| Two detach/restore cycles, distinct real local/remote marker listings, popup closes, source terminal remains unique and executes commands | `TC-043`, browser and native |
| Existing attached SFTP toggle and panel visibility | `TC-145`, browser and native |
| Workspace rail preference isolation with the new intentional menu placement | `TC-IDE-PARITY-027-02`, browser |
| Retained SFTP navigation, controls and terminal behavior | `TC-008`, `TC-011`, `TC-012`, `TC-029`, `TC-PATH-SFTP-01` in their applicable modes |
| Floating pointer cancellation, resize, reattach fallback/routing and connection initialization | Focused Vitest cases and existing layout/store/detached-session tests |

`TC-043` uses fixture-owned local directories instead of asserting POSIX `/` on
Windows. Both directory listings are checked before detach, inside the popup and
after restoration. Native window selection permits a read-only observation to
retry within a 60-second budget after an initial popup DOM probe times out on
WKWebView. Probe errors are retained in `native-window-context.jsonl`;
window creation, directory contents and input actions are still asserted. A
focused tool contract verifies that observation recovery does not replay clicks.

## Execution

All tests run on GitHub using `qa-ui-auto-platforms.yml`; no local tests are run
for this task. Local GitHub access uses `http://10.1.0.80:3228` as requested.
Native runs use isolated `com.taomni.app.qa` release binaries with matching build
inputs. The workflow adds the complete crash-regression selection: eight browser
and nine native cases per platform, in addition to applicable feature cases.

Final verification run:
[41513278763](https://github.com/engcapa/taomni/actions/runs/41513278763), attempt 1,
on `e25d8bfa`.

- Source fingerprint: `e4408edf9362bc4192788ae56e253534378430c4a4fcd041a4ff0ad45ce25505`.
- Runner fingerprint: `3c550f5c48c0e02aef9b7236313438f179519966591e095cd4e49eda001a1f47`.
- 90 frontend tests, 13 focused QA tool tests, TypeScript, `check:refactor`, and
  case/control catalog gates pass.
- Downloaded evidence is retained under
  `qa-ui-auto-report/sftp-panel/run-41513278763/`, including summaries, execution
  receipts, native build identities and screenshots.

| Platform | Browser | Native |
| --- | --- | --- |
| Linux | 17/17 pass | 16/16 pass |
| Windows | 17/17 pass | 16/16 pass |
| macOS | 17/17 pass | Runner unavailable; see below |

Completed reports total 51 browser and 32 native passes, with no skipped cases
and stable source/runner identities. Native build fingerprints match the tested
source and use the QA application ID. Linux and Windows native screenshots were
reviewed for the compact dragged control and the restored side panel with both
directory markers and live original terminal. Their complete native crash suites
pass, as do all three browser crash suites.

## Platform limitations

GitHub cancelled both macOS native shards before acquiring a runner. Check-run
annotations explicitly report **The job was not acquired by Runner of type
hosted even after multiple attempts** and macOS ARM64 capacity constraints. This
is an infrastructure cancellation and does not establish native feature passes.
The overall workflow is therefore not green despite all executed cases passing.

The prior same-source run
[41503162384](https://github.com/engcapa/taomni/actions/runs/41503162384) passed all
nine macOS native crash cases, but `TC-043` stopped at the first popup DOM probe
with **WebView JavaScript evaluation timed out**, before clicking Restore. Its
native failure screenshot shows the real popup, Restore action and both expected
directory markers; runtime console evidence is empty and the process remains
alive. That result motivated the bounded observation recovery described above.
The revised macOS native restore scenario remains unverified because the final
run could not acquire a runner; renderer/browser passes do not fill this gap.
