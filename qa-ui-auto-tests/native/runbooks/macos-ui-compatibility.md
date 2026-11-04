# macOS System Menu, Keyboard And Window Checks

Use the isolated `com.taomni.app.qa` build, matching source/build identity and
report-owned profile/workspaces described in
[native-testing.md](../../../.agents/skills/qa-ui-auto/references/native-testing.md).
Select checks through the
[coverage matrix](../../../.agents/skills/qa-ui-auto/references/macos-ui-compatibility.md).
These are OS/manual procedures; no result is implied by their presence here.

## Setup And Evidence

Use a dedicated interactive desktop/account when OS input, clipboard or Hide
Others would affect another person's work. Preserve initial clipboard contents
when safely restorable; use a disposable text clipboard for Edit checks. Never
change Accessibility, Screen Recording or keyboard policies automatically.
Record a missing capability as blocked/unverified, with its failed observation.

Record source/case/runner/build identities, bundle ID, macOS version/build,
ARM/Intel, keyboard/input source, app/system appearance, display resolution and
scale, window state and any external/notched display. Start with a normal
1280x800 window, no dialogs, no sessions or unrelated app activity. Create two
disposable documents with distinct text for save/close/routing checks. Use only
report-owned files and a local disposable terminal, never a live remote session.

For each check retain ordered actions, expected/actual results, pass/fail/unrun,
before/during/after screenshots or recording, and relevant file/clipboard/window
observations. Capture the entire OS window/menu bar when testing chrome; a
WebDriver screenshot contains only the WebView. Review the pixels for clipping,
readability and actual traffic-light overlap; retaining a PNG alone is no verdict.

## MAC-OS-01 — System Menu Tracking And Ownership

1. From Home, click the real macOS menu bar. Check the application menu,
   Terminal, Sessions, Edit, View, Tools, Window and Help entries against the
   installed `nativeAppMenu.ts` specification; also check Services and native
   Hide/Minimize/Zoom entries. Do not look for the desktop `app-main-menu`.
2. Open About from both application and Help menus. Each opens one readable
   dialog; Escape closes it and the prior surface accepts input again. Open a
   menu and dismiss with Escape and by clicking elsewhere: neither dispatches
   the highlighted command or leaves a menu overlay intercepting content.
3. Use Tools -> Settings twice: one Settings tab is reused. Open New Session,
   type a disposable name, cancel, reopen and cancel again: no session is saved.
4. Open two documents, switch focus, dirty one and inspect its contributed Save
   enabled state. Use the actual menu to save; independently read the correct
   file, require the other file to remain unchanged and the dirty mark to clear.
   Close one document via the menu; only that document disappears. Close the
   last one: Close becomes disabled and stale workspace actions disappear.
5. Toggle Quick Connect with the real View menu, inspect its checkmark and UI,
   switch modes and reload. Confirm the menu follows current state and remains
   callable after structural updates. Repeat decisive entries in Chinese and
   English to check truncation, accelerator labels and live callback ownership.

## MAC-OS-02 — Standard Shortcuts And Accelerator Dispatch

Perform these with real physical keys or OS input addressed to the verified QA
PID. `press` and `native_menu` do not establish this check. Inspect the displayed
menu chord and use the same chord from the applicable focused surface.

1. Cmd+, opens Settings and reuses it on the next invocation. Use an independent
   reversible action (Quick Connect or another affected toggle) when asserting
   single dispatch; Settings deduplication alone cannot detect two callbacks.
2. With two disposable documents, edit the active one and press Cmd+S once.
   Require its exact bytes on disk, no sibling modification and no browser Save
   Page dialog. If command counts matter, retain an independent write/event
   observation; final saved contents alone do not establish one callback.
3. Cmd+W closes the intended current document/tab and preserves its sibling.
   Repeat with unsaved work: Cancel preserves exact text and active ownership;
   Save/Discard follows the documented policy. Empty/no-close contexts must not
   close an unrelated item. Record missing bindings as failures/gaps. The
   current `close-active` menu spec has no accelerator; menu activation is not
   evidence that this conventional chord exists.
4. Cmd+F opens Find in the focused editor/terminal, not another pane. Escape
   dismisses it and returns typing to that same surface. Exercise the affected
   app-specific Cmd shortcut once and across key repeat/up; a toggle must not
   dispatch through both AppKit and a WebView listener.
5. Cmd+H hides only the QA app, Cmd+Option+H hides others only on the dedicated
   desktop, and Cmd+M minimizes the intended window. Restore through Dock/Window
   menu. Existing content, focus and menu actions remain usable.
6. Test Cmd+Q last: cancel an exit with unsaved/active work and require content
   and native processes to survive; then complete the app's documented cleanup
   and exit. Do not accept a disconnected WebDriver as proof of clean exit.

## MAC-OS-03 — Native Editing, Focus And Terminal Control

1. In an ordinary session-name input with known text, use the real Edit menu and
   separately Cmd+A/C/X/V. Require the expected selection/text and OS clipboard
   contents. Cmd+Z undoes one cut/paste; Cmd+Shift+Z redoes it exactly. Do not use
   Ctrl+Y as the default macOS Redo expectation.
2. Repeat affected bindings in a multiline input and the CodeMirror editor.
   With focus in a search/dialog field, editing must target that field; a
   read-only/disabled surface must not mutate, save or close a background tab.
   Option+arrows and Cmd+arrows retain word/line movement; Option+Backspace
   deletes a word where supported. A shell shortcut must not consume these.
3. In a disposable local PTY, run a harmless long-lived command, then Control+C:
   it interrupts that process, rather than copying or invoking an app command.
   With selected terminal output, Cmd+C copies that selection. Cmd+V pastes the
   disposable text once. Check other affected Control signals against the PTY;
   do not remap all Control chords to Command.
4. Press Cmd+B in ordinary text input: the app's sidebar toggle must yield to
   the input's editing semantics. Invoke the same app chord in its supported
   non-editing context and require one toggle. Explicitly distinguish Control+B
   from Command+B and inspect the actual labels for affected commands.

## MAC-OS-04 — Native Controls And Window Lifecycle

1. Confirm one set of native traffic lights and no renderer min/max/close or
   resize overlays. Click top-left navigation and toolbar actions near the
   title-bar boundary: neither the native controls nor a transparent drag area
   steals the click. Test an empty title-bar drag and an interactive toolbar
   click separately; require real OS displacement only for the drag.
2. Click yellow, restore from Dock/Window menu and verify the same content and
   active pane. Exercise Window -> Minimize separately from Cmd+M.
3. Test green control/Window -> Zoom, then the system fullscreen entry/exit
   (Control+Cmd+F where supported). Respect OS/version/Option-click differences
   between Zoom, tiling and fullscreen; do not treat them as Windows maximize.
   Verify the actual OS state/Space, then usable controls/content after restore.
4. On a separate fresh QA run, click red with dirty work: cancellation preserves
   content; completion follows the app's documented close/exit policy. Current
   `useApplicationExit.ts` routes main-window close through app exit; do not
   assert that red always leaves the process running. Keep the desired macOS
   close-versus-Quit policy explicit if that behavior is being changed.
5. If a detached terminal/SFTP/document window is in scope, give main and child
   distinct content. Activate each, use its menu/edit shortcut, minimize/close
   the child and require the intended owner to change while the other survives.

## MAC-OS-05 — Resize, Fullscreen And Restoration

From normal size, resize using a real edge to 800x600 (the current main-window
minimum), then enlarge. Repeat the affected Home/Sessions/Workspaces view with
left/right panels expanded/collapsed and its dialog/menu open. Check all decisive
buttons remain reachable, dialogs scroll within bounds, menus are not clipped
by rounded frames, and content does not sit under traffic lights. Enter/exit
fullscreen with these states retained; no doubled/leftover top inset or stale
hit targets may remain. Resize/restore again and use a real content action.

`set_viewport` is browser-only and cannot resize the native macOS window.
WKWebView rectangle assertions support this check but do not establish OS resize
or fullscreen. Keep the actual dimensions/state and paired OS captures.

## MAC-OS-06 — macOS Appearance And Display Compatibility

Review normal/fullscreen and restored states in app light/dark/system themes.
While following System, change the dedicated account's OS appearance and verify
the app updates without relaunch; restore it afterwards. Inspect menu text,
inactive/active title bars, traffic lights, separators, rounded corners and
focus rings for readability and overlap. OS frame colors need not match CSS.

Repeat the affected states at Retina scale and a supported non-Retina/external
display when available, including moving between displays with different scale.
Record CSS versus physical pixels; never multiply a fixed 28 CSS px inset by
devicePixelRatio in a DOM assertion. Check a notched display's fullscreen/menu
safe area when relevant. Use representative oldest/current supported OS and
ARM/Intel environments for release claims; list missing variants as untested.

## MAC-OS-07 — Keyboard Navigation And IME

Record Full Keyboard Access state. On the dedicated desktop, use physical Tab
and Shift+Tab through an affected dialog's controls, requiring visible focus and
correct order, then Return/Escape and focus restoration. Do not change the
system setting to hide a failure. The current bridge's synthetic Tab cannot
establish native traversal.

With macOS Chinese Pinyin, compose text in an input, CodeMirror and the affected
terminal. Return commits the candidate; the first Escape cancels candidates
without closing the dialog; a subsequent Escape cancels the dialog as intended.
Affected shell/IDE shortcuts must not fire during composition. Check Cmd/Control
routing again after composition ends; candidate duplication or dropped text is
a failure. Record input-source/Spotlight/Mission Control conflicts and a
reachable alternative for any hardware-specific shortcut.
