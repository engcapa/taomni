# QA run 41200627829 investigation

Original run: https://github.com/engcapa/taomni/actions/runs/41200627829

Source: `aaa05717fe03bfa1984dd12cac122fedd97f627c`. The job result alone misses case failures: the raw aggregate records 18 failed executions, plus 65 missing macOS native results caused by preparation failure. Performance failures are outside this repair at the user’s request.

| Entry | Case | Original failure | Scope |
| --- | --- | --- | --- |
| linux-ubuntu-22.04-x11-native-shard-3 | TC-WS-075 | File activation frame 8 blocked beyond 165ms (150ms + 10% tolerance): 172 | Ignored performance |
| linux-ubuntu-22.04-vnc-native-shard-1 | TC-MFA-106 | assert_text failed: '[data-testid="mfa-screen-status"]' did not contain 'No QR code found on screen'; last text='The QR code is not an MFA QR code.' | Investigate and rerun |
| linux-ubuntu-22.04-vnc-native-shard-1 | TC-WS-048 | assert_disabled: [data-testid="workspace-tab-scroll-right"] is enabled | Investigate and rerun |
| linux-ubuntu-26.04-wayland-native-shard-2 | TC-WS-022 | native_folder_dialog: Linux OS chooser automation requires X11 | Investigate and rerun |
| linux-ubuntu-26.04-wayland-native-shard-2 | TC-WS-030 | native_folder_dialog: Linux OS chooser automation requires X11 | Investigate and rerun |
| linux-ubuntu-26.04-wayland-native-shard-3 | TC-WS-026 | native_folder_dialog: Linux OS chooser automation requires X11 | Investigate and rerun |
| linux-ubuntu-26.04-wayland-native-shard-3 | TC-WS-065 | File activation frame 11 blocked beyond 165ms (150ms + 10% tolerance): 169 | Ignored performance |
| linux-ubuntu-26.04-wayland-native-shard-4 | TC-WS-042 | native_folder_dialog: Linux OS chooser automation requires X11 | Investigate and rerun |
| linux-ubuntu-26.04-wayland-native-shard-4 | TC-WS-066 | File activation frame 12 blocked beyond 165ms (150ms + 10% tolerance): 191.99999999999818 | Ignored performance |
| linux-ubuntu-26.04-wayland-native-shard-4 | TC-WS-070 | File activation frame 11 blocked beyond 165ms (150ms + 10% tolerance): 170.00000000000182 | Ignored performance |
| linux-ubuntu-26.04-wayland-native-shard-4 | TC-WS-074 | File activation frame 10 blocked beyond 165ms (150ms + 10% tolerance): 173.0000000000009 | Ignored performance |
| linux-ubuntu-26.04-wayland-native-shard-4 | TC-WS-079 | File activation frame 12 blocked beyond 165ms (150ms + 10% tolerance): 174.9999999999991 | Ignored performance |
| windows-native-shard-3 | TC-RDPC-REF-01-termservice | host_copy_file: flip-state.json: flips max 1 failed (actual 2); flip-state.json: color equals '#ffffff' failed (actual '#000000') | Investigate and rerun |
| macos-browser-shard-1 | TC-WS-017 | [data-testid="workspace-file-editor"] .cm-content text does not contain 'platform workspace root' | Investigate and rerun |
| macos-browser-shard-2 | TC-IDE-PARITY-026-05 | eval_readonly: expression returned falsy: False | Investigate and rerun |
| macos-browser-shard-3 | TC-IDE-FINDFOCUS-01 | [data-testid="code-workspace-editor"] .cm-content .cm-line: expected exactly 3, got 0 | Investigate and rerun |
| macos-browser-shard-3 | TC-WS-064 | File activation frame 2 blocked beyond 165ms (150ms + 10% tolerance): 234.80000000004657 | Ignored performance |
| macos-browser-shard-3 | TC-WS-069 | File activation frame 1 blocked beyond 165ms (150ms + 10% tolerance): 423.5 | Ignored performance |

## Evidence and repair

- macOS native shard 1 stopped before cases: Maven cached an HTTP 429 plugin download failure. The retry classifier accepted “status code” but missed Maven’s “HTTP Status” spelling. Accept both spellings, retain failed attempts, force remote resolution on retries, and keep permanent repository/compiler errors fatal.
- TC-WS-022/026/030/042: the folder chooser runner unconditionally required X11. Add real keyboard input through the existing job-owned Mutter session, verify the QA executable and dialog title before input, and wait for closure. No chooser result is mocked and no XWayland fallback is used.
- TC-WS-048 step 78: the retained HTML already has the right scroll arrow disabled. Wait for the restored layout edge for at most 1.5 seconds before asserting the same state.
- TC-IDE-PARITY-026-05 step 16: retained HTML has the expected exact toolbar order. Allow its asynchronous publication to settle for at most 1.5 seconds; keep every position assertion.
- TC-IDE-FINDFOCUS-01 step 206: immediate count observed zero lines while retained HTML has all three expected lines. Wait for CodeMirror content after undo, then retain exact count and text assertions.
- TC-WS-017 step 32: trace shows replacement text X followed by an undo restoring only the suffix of the original document. Select-all replacement can involve multiple browser input transactions. Use one insertion without deleting a selection for this persistence/history continuity case, and assert every original line exactly after undo.
- TC-MFA-106 and TC-RDPC-REF-01-termservice: the original assertions passed unchanged on rerun. Original MFA negative scan reported a non-MFA QR; original RDP target recorded two ButtonPress events 233 ms apart at the same remote point, with the second observed after local fullscreen activation. These intermittent failures were not reproduced and their underlying causes are not established. No product fix is claimed for these two cases.

## Validation

- `python -m unittest test_ci_maven_warmup test_folder_dialog test_folder_dialog_wayland`: 27 passed; expanded Wayland/startup/focus selection: 55 passed.
- `python -m qa_ui_auto.audit --gate`: passed.
- `pnpm check:refactor`: passed.
- Hosted native reruns use release profile to match the original runtime inputs; selected scope also includes the crash-regression suite.
- macOS native preparation recovery will rerun 60 original missing non-performance cases (five explicitly performance-tagged cases excluded).

Only QA tooling and executable cases are changed; no application source, IPC, persistence, UI behavior, native networking, or release packaging is changed. Retained cases exercise the same product behavior; no new product feature case is needed. All requested non-performance failed cases now have passing rerun evidence below.

## Focused reruns

The first four single-mode dispatches failed at planning: the workflow automatically adds all crash-regression cases, including cases exclusive to the other mode. No case executed in those attempts. The subsequent dispatches select both browser and native, preserving the full required crash suite.

| Run | Scope | Browser result | Native result |
| --- | --- | --- | --- |
| https://github.com/engcapa/taomni/actions/runs/41217285994 | macOS, 60 missing non-performance cases plus three browser regressions and crash suite | 29/29 passed | 69/69 passed; aggregate passed |
| https://github.com/engcapa/taomni/actions/runs/41217284630 | Linux VNC + Wayland, six target cases and crash suite | 9/9 passed | 15/15 VNC and 15/15 Wayland passed; aggregate passed |
| https://github.com/engcapa/taomni/actions/runs/41217285040 | Windows RDP reference and crash suite | 8/8 passed | 10/10 passed; aggregate passed |

Local Linux Chromium focused run: all four modified browser cases passed (`run-20261031-235320-050549389`). It supplements the hosted platform results.

macOS aggregate: `passed=true`, `report_ok=true`, no failures, gaps, or missing results. All 60 originally missing non-performance native IDs are included in its passing receipts. This confirms successful Java/Maven preparation as well as the three original browser regressions.

Windows aggregate: `passed=true`, `report_ok=true`, no failures. TC-RDPC-REF-01-termservice passed unchanged, including its exact one-click/white-target checks before and after fullscreen. The original extra ButtonPress was not reproduced; its underlying cause is not established, and no product or input-runner fix is claimed for it.

Linux aggregate: `passed=true`, `report_ok=true`, 9 browser + 15 VNC native + 15 Wayland native passed, no failures or missing results. Every original functional failure was rerun on its failing platform/profile. All four Wayland folder chooser cases retain `native-folder-dialogs.jsonl` with actual `Mutter OS keyboard`, QA process ownership and successful choose/cancel observations. TC-MFA-106 passed unchanged on both VNC and Wayland; the original non-MFA-QR negative-scan result was not reproduced and no product decoder fix is claimed.

All three final workflows succeeded: **155/155 executions passed**, with zero failed/skipped executions. These runs test repair commit `c1424d00`; the final follow-up only wires the already-passing Wayland unit module into the existing CI contract list and records evidence. Final `pnpm check:refactor` and `git diff --check` also passed. The original eight performance failures and five performance-tagged missing macOS cases remain excluded, not converted to passes.
