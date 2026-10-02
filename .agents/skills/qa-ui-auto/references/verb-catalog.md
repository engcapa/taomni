# qa-ui-auto verb catalog

Step verbs available in `*.testcase.yaml`. Browser implementations live in `scripts/qa_ui_auto/steps/`; native dispatch lives in `native_steps.py`. Schema acceptance does not imply native support. Before a new native build, run the selected case with `--mode native --dry-run` to check supported verbs. Dry-run does not prove execution or every argument's semantics.

> Read this when authoring or modifying testcases. Verbs not listed here are not allowed; the schema validator will reject them.

Format reminder: every step is a **single-key map**. Two valid forms:

```yaml
- click: '[data-testid="qc-submit"]'                  # short form when only the selector matters
- click:                                              # rich form
    selector: '[data-testid="qc-submit"]'
    modifiers: [Control]
```

Placeholders: `${cfg.x.y}` resolves from `qa-ui-auto.config.yaml`; `${env.X}` from environment.

## Navigation & timing

| Verb | Args | Notes |
|------|------|-------|
| `open` | string URL **or** `{url}` | Navigates and waits for `domcontentloaded`. Auto-runs at step 0 if first step isn't `open`/`goto`. |
| `goto` | same as `open` | Alias. |
| `wait` | seconds (number or `"3s"`) | Hard sleep; use sparingly. |
| `wait_for` | selector string **or** `{selector, timeout_sec?, state?}` | `state` ∈ `attached/detached/visible/hidden`, default `visible`. |
| `screenshot` | filename string **or** `{path, selector?, full_page?}` | Saved under `qa-ui-auto-report/<run>/<TC-id>/`. |

## Mouse

| Verb | Args | Notes |
|------|------|-------|
| `click` | selector string **or** `{selector, modifiers?, position?, force?}` | `modifiers` ⊆ `Alt/Control/Meta/Shift`. |
| `dblclick` | same as click | |
| `middle_click` | selector string | Browser/native: real middle-button input; verifies tab auxiliary-click routing when paired with a close result assertion. |
| `right_click` | same as click | Native supports selector only (W3C right button); rich click options are browser-only and fail explicitly. Use before `assert_menu_items`; `click_menu` supports an exact visible label in native mode. |
| `hover` | selector | |
| `drag_to` | `{from, to}` | Both selectors. |
| `terminal_drag_selection` | `{selector, direction?: forward\|reverse, modifiers?}` | Browser/native, three platforms. The selector identifies the terminal pane; its active search highlight locates a first-column output marker. Drags between 4 CSS px before the highlight's left edge and 2 px inside its right edge; optional Control+Shift exercises block selection. Native W3C input uses the interactive xterm root as element origin, since the highlight ignores pointer events. macOS dispatches packaged WebView events and does not prove OS mouse input. Records geometry in `terminal-selection-drags.json` and releases input sources on failure. Pair with exact selected-text assertions; the action itself does not establish selection correctness. |
| `native_click` | `{selector}` | Native Linux/X11 only. Activates the exact test executable window and sends W3C pointer actions through its packaged WebKitGTK session; testcase assertions own the postcondition. |
| `native_pointer_drag` | `{selector, from:{line,column}, to:{line,column}, modifiers?}` | Native Linux/X11 only. Resolves CodeMirror line/column positions through read-only DOM geometry, then sends a real modifier-aware W3C pointer drag to the packaged WebKitGTK session. The verb records geometry/transport only; testcase assertions own selection and edit postconditions. |
| `native_set_writable` | `{path, writable}` | Native Linux only. Toggles owner-write permission for a path inside the current retained report root and records mode metadata; used for deterministic real-write failure/recovery evidence. |
| `host_write_file` | `{path, text}` | Writes real UTF-8 bytes (LF-preserving) to an existing path inside the current retained report root and records before/after SHA-256 metadata. Simulates a genuine external editor/process mutation while the app holds stale state; testcase assertions own the app-reaction postconditions via the file-assertion verbs. |
| `native_clipboard_owner` | `{action, text?}` | Native Linux/X11 only. Drives an out-of-process X11 CLIPBOARD selection owner. `grant` takes the selection with `text` (postcondition verified by an external read); `deny` replaces it with an owner that advertises standard text targets but rejects their conversion, causing an immediate real OS read failure; `suspend` retains the timeout-based unresponsive-owner fault; `resume` restores the last granted text; `release` terminates it. Teardown always kills the owner and records that the host selection was replaced - it is deliberately not republished, because an X11 selection needs a live owner and faking a restore would leak a process. |

## Keyboard

| Verb | Args | Notes |
|------|------|-------|
| `fill` | `{selector, value}` | Replaces field content. Native Linux password fields require exact value retention. If WebDriver string input changes shifted characters, the driver pastes through the OS clipboard, verifies the field and restores the prior clipboard text. |
| `type` | string or `{selector, text}` | Types into the current focus, or focuses `selector` immediately before typing. Prefer `fill` for ordinary inputs. |
| `send_keys` | string or `{selector, text}` | Same as `type`. |
| `terminal_input` | `{selector, text, submit?}` | Dispatches standards-based text input to xterm's helper textarea, then optionally submits with a separate Enter key. A text-free Shift key cycle first resets xterm’s stale keypress suppression state. This exercises xterm `onData`, the product input path, and the real PTY while avoiding hidden-textarea key synthesis differences in Windows Chromium/WebView2. It is renderer/WebView automation, not physical OS keyboard evidence. Wait for `data-terminal-ready="true"` first. `verify` (`{selector, regex, timeout_sec?=10, attempts?=2}`) polls that selector's text / `data-terminal-text` after each dispatch and re-sends the whole input while it does not match — Windows OpenSSH/ConPTY intermittently drops part of a pty write, a retry interrupts the failed probe with Control+C and clears the unfinished shell line with Control+U before re-sending it. Recovery applies only between verified attempts; it does not change a first attempt or an unverified draft. The testcase's own assertion still owns the outcome. |
| `compose_text` | `{selector, text, during_key?}` | Browser-only composition lifecycle; optionally dispatches one composing key before committing text. Never substitutes for native IME evidence. |
| `set_viewport` | `{width, height}` | Browser-only: resize the current Playwright viewport to inspect responsive UI and popup clipping. |
| `native_keys` | `{selector, keys, transport?, focus_target?, focus_prechecked?, ready_selector?, ready_timeout_sec?, ready_stable_sec?, require_keydown_prevented?}` | Requires the selector to own focus. `focus_target: true` first focuses it through WebDriver and then verifies ownership; use this when a platform click does not reliably transfer DOM focus. Default `transport: x11` injects XTest keys through Linux/X11 and identifies the Taomni window. `transport: webdriver` uses W3C actions in the platform WebView (Windows/Linux), not OS-level input. `ready_selector` is polled after input setup and immediately before delivery; `ready_stable_sec` additionally requires the same element and markup to remain stable. `require_keydown_prevented` observes each keydown after event dispatch and proves it was consumed. `focus_prechecked: true` is limited to a testcase that asserted focus immediately before a driver fault; it omits WebDriver probes/event collection and records that limitation. `focus_target` and `focus_prechecked` are mutually exclusive. Testcase assertions own the postcondition. |
| `native_ime_keys` | `{selector, expected_engine, keys}` | Native Linux/X11 only. Injects physical XTest keys through the named configured fcitx5 engine and records an observation artifact; testcase assertions must verify the committed result. |
| `native_editor_performance` | `{selector, keys, max_p95_ms, capture_text?, label?}` | Native packaged app only. Injects at least five ASCII keys through W3C WebDriver actions and records keydown-to-CodeMirror-DOM-mutation latency. `keys` accepts a single-char array or a plain string typed character-by-character. `capture_text` (default true) also records per-key rendered text; set it false for multi-megabyte documents so the O(N) textContent probe does not inflate the measured latency. `label` names the per-invocation artifact `native-editor-performance-<label>.json` so repeated measurement groups accumulate instead of overwriting. The artifact also records the next animation frame as a diagnostic, but does not gate on it because a frame requested from CodeMirror's mutation observer is one frame later than the paint containing that mutation. Fails when p95 exceeds the supplied guardrail. |
| `blur` | selector | Removes focus from a control by calling `HTMLElement.blur()`, dispatching the real blur/focusout events. Use it to commit a blur-committed field (clamped number inputs, rename/name fields) because a synthesized Tab does not move focus on the macOS in-process bridge (and WebKit keeps focus when a non-focusable preview is clicked). Assert the committed value afterwards. |
| `press` | key string **or** `{key, selector?}` | E.g. `Enter`, `Control+Shift+F`. `Mod+X` maps to `Meta+X` on macOS (where CodeMirror maps Mod to Cmd) and `Control+X` elsewhere, so one chord drives the platform-native editing primitive on all three OSes. Keep exact `Control+…` for bindings the product matches literally (e.g. `Control+Shift+N`). A selector focuses without clicking/activating in either mode. Native uses DOM focus then W3C key actions, not physical OS focus evidence. For activation, add a separate `click`. |
| `select_option` | `{selector, label?, value?}` | At least one of label/value. |
| `upload_file` | `{selector, path}` | Hooks into a file input. |

## Assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_visible` | selector | Up to 15s wait. |
| `assert_not_visible` | selector | Up to 15s wait for hidden. |
| `assert_text` | `{selector, contains, timeout_sec?}` | Polls `text_content` and `data-terminal-text` (xterm canvas fallback). |
| `assert_text_equals` | `{selector, equals, timeout_sec?}` | Browser/native: requires exactly one DOM match and exact `textContent`, preserving whitespace. No substring or terminal-buffer fallback. |
| `assert_items` | `{selector, equals: [string, ...], attribute?, timeout_sec?}` | Browser/native: exact ordered list of all matching DOM textContent values (or named attributes). Checks missing, extra, duplicate, reordered and changed items. For editor contents select `.cm-line` and include empty trailing lines; for virtualized documents use disk assertions for full content. |
| `assert_pattern` | `{selector, regex, timeout_sec?}` | Browser and native; polls Python regex against element text (terminal buffer fallback for `terminal-pane`). Use anchored output assertions to distinguish shell output from command echo, and await shell readiness before typing. |
| `assert_count` | `{selector, min?/max?/equal?}` | Browser/native. Pick at least one bound; checks current count, including hidden matches. Wait for readiness separately. |
| `assert_url` | URL substring | |
| `assert_menu_items` | `[label, label, ...]` | Browser/native. After `right_click`; checks each label visible inside `[data-testid="context-menu"]` using substring matching. |

## App-specific helpers (use these instead of inlining selector chains)

| Verb | Args | Notes |
|------|------|-------|
| `quick_connect` | `{url}` (must match `(ssh\|sftp)://user@host[:port]`) | Fills + submits the QuickConnect bar. |
| `auth` | password string **or** `{password}` | Waits for `[data-testid="auth-prompt"]` then submits. Empty password → step error. |
| `attach_sftp` | (none / `{}`) | Toggles attached SFTP from current SSH terminal. |
| `set_remote_path` | path string | Sets the SFTP remote path input + presses Enter. |
| `seed_clipboard` | text string | Writes text to OS clipboard via the page (controlled write — not eval_readonly). |
| `seed_dialog` | `{prompt: str|[str], confirm: bool}` | Pre-arms `window.prompt` and `window.confirm` responses. Used before SFTP "new file/folder/rename" flows. `prompt` may be a list to feed sequential calls. |
| `open_session` | `{name, double_click?}` | Clicks/dblclicks `[data-testid="session-tree-item"][data-session-name="<name>"]`. |
| `click_menu` | label string **or** `{label}` | Click context-menu item by visible text. |
| `set_check` | `{selector, checked}` | Idempotently set a checkbox (only clicks if state mismatches). |
| `send_text_via_label` | `{label_contains, checked}` | Set a label-wrapped checkbox by the label's text content. |
| `reload` | (none) | Reloads the page (`domcontentloaded` wait). |

## State assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_localstorage` | `{key, exists?/contains?/equals?}` | Read & assert localStorage[key]. Pass at least one of exists/contains/equals. |
| `assert_attribute` | `{selector, name, equals}` | Read element attribute and assert exact match. E.g. `type=password`. |
| `assert_disabled` | selector | Pass when element is disabled. |
| `assert_enabled` | selector | Pass when element is enabled. |

## Native filesystem assertions

| Verb | Args | Notes |
|------|------|-------|
| `assert_file_contains` | `{path, contains, timeout_sec?}` | Native-only host re-read asserting decoded UTF-8 text contains a marker. |
| `assert_file_exists` | path string **or** `{path, timeout_sec?}` | Native-only host filesystem existence check. |
| `assert_file_receipt` | `{path, selector, encoding, bom, eol, expected_text, require_history?, timeout_sec?}` | Native-only: independently reads and hashes host bytes, validates encoding/BOM/EOL, then reconciles the result with the production receipt observation. |
| `assert_file_sha256` | `{path, equals, timeout_sec?}` | Native-only: independently reads host bytes and requires an exact lowercase SHA-256 digest. |
| `assert_native_process_delta` | `{pattern, baseline, max_delta, timeout_sec?}` | Native Linux only. Counts `/proc/*/cmdline` entries containing `pattern`, writes `native-process-observation.json`, and requires the count increase from `baseline` to remain within `0..max_delta`. |
| `assert_system_clipboard` | `{equals \| contains \| readable, timeout_sec?}` | Native Linux/X11 only: reads the real CLIPBOARD selection from a separate process, never from the app's DOM or in-process state. The only step that can prove a copy actually crossed the OS boundary. An unresponsive owner is reported as unreadable, never as an empty string. Exactly one assertion key. |

## ED-PARITY-005 controlled browser provider

These verbs operate only on the isolated `/preview/parity005` browser fixture.
They control mock response timing or failure at the Tauri browser bridge; the
case still uses actual editor input and completion actions. They cannot prove
real JDT LS, Rust IPC or disk effects.

| Verb | Args | Notes |
|------|------|-------|
| `parity005_set_mode` | `normal \| empty \| empty-placeholder \| fetch-hold \| resolve-hold \| resolve-null \| resolve-error \| resolve-timeout \| resolve-overlap \| resolve-invalid` | Selects the next controlled response. `empty-placeholder` uses `StringBuilder(${1:})$0`; `normal` restores success. |
| `parity005_set_facts` | `ready \| loading \| degraded \| failed \| stale` | Browser fixture only: changes the isolated workspace facts generation/status; completion is still invoked through the editor. |
| `parity005_wait_pending` | `fetch \| resolve` | Waits for a real pending request from the renderer. |
| `parity005_release` | `fetch \| resolve` | Releases held responses; fails if none is pending. |
| `parity005_trace` | `{fetch?, resolve?, pending?}` | Asserts exact request counts and saves the read-only event trace in the case report. |

## macOS updater release regression

Native macOS only, with `macos_updater`. Downloads SHA256-pinned, authentically signed
v0.4.29 ARM/Intel assets, runs the production release manifest generator, and serves
loopback HTTP to the real updater. Only the disposable report-owned app is replaced.

| Verb | Arguments | Behavior |
|---|---|---|
| `updater_fixture_mode` | `broken \| correct \| slow` | Switches the fixture manifest, not application state. `broken` pairs ARM signature with Intel URL; `correct` retains generated per-arch URLs; `slow` holds first/second streams at 20%/60%. |
| `updater_release` | `1 \| 2` | Releases one held real HTTP download; does not synthesize IPC progress. |
| `assert_updater_installed` | `aarch64 \| x86_64` | Independently reads installed executable SHA256, `lipo` architecture and Info.plist version against the authentic archive; retains installed-*.json. |
| `assert_updater_unchanged` | `null` | Requires the disposable executable to retain its pre-case bytes after rejection/cancellation. |
| `assert_updater_progress` | `{min, max, seconds?, old_transfer_done?}` | Samples native dialog phase/aria progress, requires monotonic percentages within the bounds, retains raw samples. When `old_transfer_done`, the cancelled HTTP stream must have finished and the app must be unchanged. |

These cases do not establish production relaunch, Rosetta execution or Gatekeeper.
Cancellation discards late plugin bytes; it does not claim unsupported transport abortion.

## ED-PARITY-008 / ED-PARITY-009 controlled browser fixtures

Browser-only. `parity008_git` serves two fixture repositories through the stub
`invoke`; `parity009_ssr` enables a Lezer-AST Structural Search backend over the
VFS. They control timing/mode and read a trace; actions still use the product
UI. They prove neither real Git bytes, Tauri IPC nor the tree-sitter backend.

| Verb | Args | Notes |
|------|------|-------|
| `parity008_hold` | repo root string \| `null` | Holds later `git_blob_pair` reads for that repository (`null` clears). |
| `parity008_release` | `null` | Releases held diff reads; fails when none is pending. |
| `parity008_trace` | `{writes?, pending?, pending_min?, last_pair_repo?}` | Asserts refused Git write count, exact/minimum held reads (dev StrictMode may issue a guarded duplicate read) and the last diff read's repo; saves the trace. |
| `parity009_set_mode` | `normal \| hold \| unavailable \| error` | Next Structural Search response mode; `unavailable` also flips the capability probe. |
| `parity009_release` | `null` | Releases a held search; fails when none is held. |
| `parity009_trace` | `{active?, runs?, last_status?, last_count?}` | Asserts active requests, completed runs and the last typed status/count; saves the trace. |

## ED-PARITY-007 controlled browser provider

These verbs drive only the isolated `/preview/parity007` Java fixture. The
Extract Method transaction, candidate session, Rename chain, workspace edit and
history stay on the production paths; the verbs change provider timing/failure
and read a trace. They cannot prove JDT LS, host disk or WebView behaviour.

| Verb | Args | Notes |
|------|------|-------|
| `parity007_set_mode` | `normal \| multi-candidate \| none \| empty-supported \| disabled \| command-only \| malformed \| timeout \| changed \| error \| resolve-error \| symbols-error \| symbols-ambiguous \| rename-error \| multi-file \| write-failure` | Selects the next controlled response/fault. |
| `parity007_hold` | `request \| resolve \| symbols-before \| symbols-after \| prepare-rename \| rename` | Holds the next matching provider response once. |
| `parity007_wait_pending` | same phases | Waits for a real pending held response. |
| `parity007_release` | same phases | Releases one pending response; fails when none is pending. |
| `parity007_trace` | `{requests?, resolves?, symbols?, prepares?, renames?, pending?}` | Asserts exact IPC counts and saves the read-only event trace in the case report. |

## ED-PARITY-007 isolated native program oracle

| Verb | Args | Notes |
|------|------|-------|
| `parity007_java_oracle` | `{scenario: e1 \| e3, expected, source, label?, artifact?}` | Compiles the current real host source (plus the fixed E1 `ExtractOracle`) with the configured JDK into a fresh report-root classes directory, runs it, normalises line endings and requires exact stdout with exit 0. It records the commands, JDK versions, source hash, exit codes and raw output, and never edits the document. |

## ED-PARITY-005 isolated native provider boundary

| Verb | Args | Notes |
|------|------|-------|
| `parity005_native_trace` | `{phase: fetch \| resolve, label_contains?, detail_contains?, kind?, require_import?, require_snippet?, expect_raw_range?: {line, start, insert_end, replace_end}, artifact?, timeout_sec?}` | Requires a new matching QA observation since the previous call for the same phase/label/detail, checks original insert/replace ranges when requested, and saves the raw item/result. It does not issue requests or edit the document. |
| `parity005_native_fault` | `normal \| null \| error` | Isolated QA app only: after a real provider resolve request, replaces its Rust transport result with a controlled null or error. The production app rejects the control command. |

## Save-race time-point gate (isolated QA build only)

These verbs control `window.__taomniQaSaveGate`, installed only by the isolated
QA bundle (`pnpm build --mode qa`, used by the `com.taomni.app.qa` binary; the
normal build compiles the install branch away). They never fabricate acks or
hashes: the production byte writer, its real ack and the real watched-files
notify all run; only an explicit delivery point is held while the runner types
into the live editor. Against a production binary the gate is absent and the
verbs fail loudly.

| Verb | Args | Notes |
|------|------|-------|
| `save_race_arm` | `{stage, filePath?, workspaceId?, fileKey?, transactionId?, timeoutMs?}` | One-shot arm for the next matching save transaction. `stage` ∈ `prepare` (after the history await, before the byte writer), `ack` (the real writer was invoked; its real ack is withheld), `watcher` (real ack delivered and the real watched-files notify invoked; merge not yet run), `fault` (withhold one REAL successful write response as a recorded QA transport fault so the production unknown-effect read-back path runs). Optional identity fields narrow the match; omitted fields match any value. |
| `save_race_wait_entered` | `{stage, timeout_sec?}` | Blocks until the armed stage is genuinely entered (enter time and live revision are recorded in-page). Fails on timeout with the last gate status. |
| `save_race_release` | `{reason?}` or null | Releases the held delivery point; the production transaction continues. Fails when nothing is held. |
| `save_race_trace` | `{artifact?, expect_contains?, expect_events?, require_ack_hashes?, require_settled_kind?}` | Fetches the in-page timeline and writes it under the case directory (default `save-race-trace.json`). `expect_contains` checks an ordered subsequence, `expect_events` an exact sequence; `require_ack_hashes` proves `ack-delivered` carries the real native `writtenHash`; `require_settled_kind` asserts the last `commit-settled` production result kind. |

## RDP server / client (docs-feature/rdp-server-parity-design.md)

Native verbs live in `scripts/qa_ui_auto/rdp_steps.py`. Connection defaults come from the `rdp_server_required` fixture (`QA_RDP_PORT`, `QA_RDP_USER`, `QA_RDP_PASSWORD`, `QA_RDP_BAD_PASSWORD`, `QA_VAULT_PASSWORD`). `rdp-probe` is the QA-only client binary produced next to the QA app by `native_build.py`; it never receives a password on its command line.

| Verb | Args | Notes |
|------|------|-------|
| `open_route` | route string **or** `{route}` (starts with `?`, `/` or `#`) | Browser: navigates to `app.base_url` + route. Native: same-origin navigation of the packaged main WebView (e.g. `?servers=main` renders the Local servers component tree in the main window) and re-installs the console hook. |
| `host_helper` | `{action: start\|stop, name?, mode?: flip\|animate\|photo, pattern?: boolean, geometry?: WxH+X+Y, state?, timeout_sec?}` | Native only. Starts/stops the borderless host Tk target at exact desktop pixels. `flip` inverts black/white and records input; `animate` scrolls bars; `photo` uses deterministic noisy gradients. `pattern` adds known magenta/cyan markers. Waits for readiness; owned processes stop at teardown. |
| `rdp_probe` | `{scenario, args?, artifact?, expect?, expect_exit?=0, background?, timeout_sec?}` | Native only. Runs `rdp-probe <scenario>` against `127.0.0.1:$QA_RDP_PORT` with `--password-env QA_RDP_PASSWORD` (override any option through `args`; `true` becomes a bare flag). Saves `<artifact>.json` (+ `.log`) in the case dir, requires the exit code and checks `expect`: dotted JSON paths → literal (equals) or `{equals\|min\|max\|exists\|contains\|excludes\|length_min}` (`excludes`: the value's text, JSON for non-strings, does not contain it; absent passes). `background: name` returns immediately; collect with `rdp_probe_wait`. |
| `rdp_probe_wait` | `{name, expect?, expect_exit?, timeout_sec?}` | Waits for a background probe and applies the same report checks. |
| `host_clipboard` | `{action: set\|assert\|clear\|quiet, kind: text\|html\|image\|files, ...}` | Native only, three platforms. Independent OS oracle (PowerShell/.NET on Windows, AppKit via JXA on macOS, xclip on Linux/X11) — never the product's arboard. `set` takes `text`, `html` (+`text` fallback), `png` or `paths` (inside the report root); `assert` takes `equals`/`contains` (text/html), `png_equals` (RGB pixel digest via `rdp-probe image-digest`) or `names` (file list). `quiet` watches the clipboard for `seconds` (default 5) and fails above `max_changes` (default 0) changes — Windows sequence number, macOS change count, X11 XFixes owner changes — to catch echo loops. Records `host-clipboard-observations.json`. | `kind: files` also accepts `same_tree_as: <report-root tree>`: the clipboard entry with that name must contain identical relative paths and bytes.
| `host_make_tree` | `{root, files: {relative path: text}}` | Native only. Creates a new sample tree (UTF-8 files, nested directories, Unicode names) inside the case directory and writes `<root>-tree.json` with the SHA-256 of every entry. Used as the source and oracle of clipboard file transfers. |
| `platform_choice` | `{platforms: [Linux\|Windows\|macOS], dialog, click, timeout_sec?=30, absent_sec?=3}` | Native only. For a prompt that exists only on some platforms (e.g. the Windows system Remote Desktop choice): on the listed platforms the `dialog` must appear and `click` answers it; elsewhere it must stay absent for `absent_sec`. Both branches assert. |
| `assert_json_file` | `{path, expect, timeout_sec?}` | Native only. Polls a JSON file inside the report root (e.g. the helper state) with the `rdp_probe` expectation syntax. |
| `save_text` | `{selector, path}` | Native only, diagnostics. Writes the element's text (e.g. `server-log`) to a file inside the report root so passing runs keep it too; asserts nothing. |
| `rdp_canvas_click` | `{x, y, selector?='[data-testid="rdp-canvas"]'}` | Native only. Maps a remote desktop coordinate to the Taomni RDP client canvas (CSS scale from its bounding box and intrinsic size) and clicks with W3C pointer actions; used by joint client↔server cases. |
| `rdp_canvas_assert` | `{points: [{x,y,rgb,tolerance?=24}], selector?, artifact?, timeout_sec?}` | Native only. Polls actual decoded canvas pixels at remote desktop coordinates. Saves pixels, dimensions and the observed full-screen quality level to JSON. Maximum color tolerance is 24. |
| `host_copy_file` | `{from_env_dir, name, to, expect?, timeout_sec?}` | Native only. Copies a single fixture file from a set `QA_RDP_*` directory into the report root; rejects traversal and polls independent JSON expectations when provided. Used for reference-session state files. |
| `host_mstsc` | `{action: start\|capture\|stop, port?, user?, password_env?, width?, height?, snapshot?, expect_pattern?}` | Windows native only. Starts one owned mstsc process with disposable loopback credentials, captures its window and optionally checks known magenta/cyan remote markers, then stops the process and deletes credentials. Failure teardown performs the same cleanup. Passwords never enter the retained .rdp file. |

`rdp_probe throughput` accepts `compression: none|k8|k64|rdp6|rdp61` and
`baseline-report` (resolved inside the report root). Reports include bulk wire
and decoded byte counts; `vs_baseline.kbps_ratio` and `fps_ratio` compare with
the retained reference measurement. `xrdp_server_required` is restricted to
Linux GitHub hosted native cases; CI installs packages, and the fixture owns
and restores its user, loopback listener and service configuration (DEC-07).

## MFA authenticator fixtures

Images live in `qa-ui-auto-tests/synthetic-fixtures/mfa/` (regenerate with its
`generate.mjs`; `manifest.json` lists each QR payload and expected codes).
Relative paths resolve from the repository root.

| Verb | Args | Notes |
|------|------|-------|
| `seed_clipboard_image` | `{path}` or `{selector}` | Browser-only. Writes a PNG fixture, or a screenshot of one rendered element (saved as `clipboard-image-step<N>.png`), to Chromium's clipboard as `image/png` and reads it back. Lets a case scan an exported QR with the app's own import path. Not the OS clipboard. |
| `browser_fake_camera` | `{mode: qr \| none \| denied, image?}` | Browser-only. Replaces `navigator.mediaDevices` before the camera pane opens: `qr` streams `image` from a canvas, `none` reports no camera, `denied` rejects with `NotAllowedError`. `window.__taomniQaCamera.{created,live}` lets `eval_readonly` prove the tracks were stopped. Not camera hardware or permission evidence. |
| `assert_totp_code` | `{selector, secret, period?=30, digits?=6, algorithm?=SHA1, attribute?=data-code, timeout_sec?=10}` | Browser/native. Exactly one match; polls until its attribute equals an independent Python RFC 6238 code for the current step (or the previous step within 5 s of a rollover). |
| `native_clipboard_image` | `{path}` | Native Linux/X11 only. An external `xclip` process owns CLIPBOARD as `image/png`; a separate TARGETS read confirms it. The app must read it through arboard. The host selection is replaced and the owner is killed after the case. |
| `native_show_image_window` | `{path, x?, y?}` or `{action: close}` | Native Linux/X11 and Windows. Shows a topmost Tk window with the PNG so a real screen capture contains the QR; records geometry in `native-image-window.json`; closed automatically after the case. |

## Last-resort escape hatch

| Verb | Args | Notes |
|------|------|-------|
| `eval_readonly` | `{expression, expect_truthy?, contains?, timeout_sec?}` | Evaluates a read-only JS expression once by default; optional `timeout_sec` polls the same condition until it passes or the bounded timeout expires. Browser/native share the assertion and polling rules. Schema **rejects** assignments, function declarations, `await`, `new`, `.click(`, `.setAttribute(`, `.dispatchEvent(`, `.innerHTML=`, `document.write`. Use for things like reading `localStorage` to verify persistence. Max 400 chars. |

## What you should NOT do

- ❌ Inline JS (`page.locator(...).click()`-style strings) — there is no `eval` verb.
- ❌ Multi-key step entries (`{click: ..., screenshot: ...}` is invalid).
- ❌ Selectors based on Tailwind classes like `.text-\\[11px\\]` — they break on a font tweak. Add a `data-testid` to the source instead.
- ❌ Hard-coded passwords. Use `${env.QA_SSH_PASSWORD}` (set externally).
- ❌ Skipping `fixtures: [reset_db]` for any case that mutates persistent state.
