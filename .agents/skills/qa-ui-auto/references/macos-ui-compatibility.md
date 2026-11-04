# macOS UI, Menus And Shortcuts

Read this when authoring macOS cases or changing menus, shortcuts, shared chrome
or window lifecycle. Apply the affected rows; a renderer-only change does not
require every OS check. Executable YAML and manual OS checks have separate
results. Newly authored cases are unrun until matching execution evidence exists.

## Source And Runtime Contract

Check current production code before deciding expected behavior:

- `src/layouts/main/useMainLayoutState.ts`: `nativeMenu` requires both Tauri and
  macOS. A browser on a Mac still exposes `app-main-menu`.
- `src/lib/nativeAppMenu.ts`, `nativeAppMenuInstaller.ts` and `nativeAppMenuSpec.ts`:
  AppKit application, Terminal, Sessions, Edit, View, Tools, Window and Help
  entries; predefined system items and live command/checkmark ownership.
- `src-tauri/src/lib.rs`: the main macOS window enables decorations, Overlay
  title-bar style and hidden title. The base JSON's `decorations: false` alone
  does not describe the macOS runtime window.
- `src/layouts/main/MainLayoutView.tsx`, `src/styles/platform.css` and
  `src/components/tabbar/ControlBar.tsx`: native macOS reserves a single 28 CSS px
  title-bar strip outside the workbench, hides the renderer menu, custom window
  buttons and resize handles. Mac browser preview hides the custom window
  buttons too, but has no native title-bar strip.
- `src/layouts/main/usePlatformShortcuts.ts`, `useMainMenuBridge.ts`,
  `src/hooks/useModalShortcuts.ts` and the active editor/terminal keymap: routing
  depends on focus and command ownership, not just modifier replacement.

| Surface | Mac browser preview | macOS QA desktop | Required observation |
|---|---|---|---|
| Application menu | Renderer `app-main-menu` | Global AppKit menu; renderer entry absent | Menu entry -> visible result at the right layer |
| Window controls | Custom min/max/close absent | Native traffic lights; custom controls absent | OS screenshot and actual native operation for traffic lights |
| Top clearance | No native title-bar strip | One reserved strip above rail/workbench | WKWebView geometry plus OS frame review |
| Shortcut | Browser renderer key event | WKWebView key event, AppKit accelerator or OS-reserved chord | Name the transport and verify the actual recipient |
| Screenshot | Page/viewport | WebView contents | Separate OS capture for menu bar, frame and traffic lights |

Do not emulate `navigator.platform`/a user agent and report it as macOS runtime
coverage. An emulation can support branch logic only. Do not click a missing
renderer menu, add it back for a test, or call a store/handler to replace AppKit.

## Coverage Matrix

| Behavior | Executable cases | Remaining native/visual boundary |
|---|---|---|
| Global menu entry routing, Settings reuse, cancel/reopen, About | `TC-MAC-001` (native, macOS) | Actual menu-bar tracking, dismiss/focus and displayed accelerators: MAC-OS-01 |
| Enabled/checkmarked menu state, dirty Save, last-tab Close, reload | `TC-WS-080` (native, macOS) | OS shortcut dispatch and native Edit responder: MAC-OS-02/03 |
| Native title-bar strip, no duplicate controls, rail/toolbar/modal bounds through modes and themes | `TC-MAC-002` (native, macOS) | Traffic lights, dragging, resize/fullscreen and frame appearance: MAC-OS-04/05/06 |
| Mac preview menu and explicit Cmd/Control routing, editable input protection | `TC-MAC-003` (browser, macOS) | Native shortcuts, terminal signals, IME and physical focus: MAC-OS-02/03/07 |
| Home card/footer and sidebar-dependent toolbar clearance | `TC-WS-083` (browser/native) | Real traffic-light overlap and display scaling: MAC-OS-06 |
| Windows/Linux custom title bar | `TC-100` (browser, Windows/Linux) | This case deliberately excludes macOS; use the Mac cases above |

The `MAC-OS-*` checks are specified in
[the macOS native runbook](../../../../qa-ui-auto-tests/native/runbooks/macos-ui-compatibility.md).
They are manual/OS procedures, not YAML verbs or automatically passing cases.

`native_menu` uses the current menu specification only to locate a command;
flags and activation use actual AppKit NSMenu objects. Assert the resulting UI,
document or filesystem state too. Prefer `action` IDs over translated labels or
fixed numeric paths. Predefined Edit/Window items require their real responder
and OS checks; querying a custom command cannot establish them. Never retry an
activation after uncertain delivery. `native_about`/`native_menu` need no updater
fixture. `TC-MAC-001/002/003` need no SSH, database or Java provider.

## Shortcut Test Contract

Use familiar macOS semantics for standard commands. The table is an acceptance
target, not a claim that every current binding is implemented:

| Scope/action | Expected macOS chord | Key assertion |
|---|---|---|
| Cut / Copy / Paste / Select All | Cmd+X / C / V / A | Correct focused control/selection and OS clipboard contents |
| Undo / Redo | Cmd+Z / Cmd+Shift+Z | One reversible edit per invocation; redo restores exact text |
| Save / Find | Cmd+S / Cmd+F | Save only the current writable document; Find belongs to the focused surface |
| Settings / Quit | Cmd+, / Cmd+Q | One Settings tab; Quit uses exit/unsaved-work policy |
| Close document/tab | Cmd+W | Close the intended active item, preserve siblings; dirty work follows save/cancel policy |
| Hide / Hide Others / Minimize | Cmd+H / Cmd+Option+H / Cmd+M | OS handles the intended application/window; app commands do not steal the chord |
| Enter/exit fullscreen | Control+Cmd+F where supported by the window | Real fullscreen/Space transition and restored usable content |
| Text navigation/deletion | Option+Left/Right, Cmd+Left/Right, Option+Backspace | Native word/line editing; do not steal these for unrelated shell actions |
| Cancel/default action | Escape / Return | Cancel or confirm the current dialog; an IME candidate receives the key first |
| Terminal signals | Control+C / D / Z, etc. | Reach the PTY when appropriate; Cmd+C remains copy for a selection |

App/editor-specific chords (for example Cmd+B, Cmd+K or an IDEA keymap) retain
their documented context. Do not impose another editor's scheme on terminal
input, or classify a system-reserved collision as intended because it exists.
Check collisions with Spotlight, input-source switching and Mission Control on
the actual host. Hardware-dependent keys (Fn/function keys, Insert/Delete and
compact keyboards) need a reachable menu/button alternative when applicable.

For every changed shortcut, record:

- Action ID, exact macOS chord, Windows/Linux chord if shared, and the expected
  tooltip/menu/keymap label. macOS labels use Command/Option/Control/Shift or
  `⌘`/`⌥`/`⌃`/`⇧` consistently; raw `Meta` is runner syntax, not product copy.
- Initial document/tab/selection, focused element, editable/terminal/modal/IME
  context, enabled/read-only state and the actual input transport.
- Real key action and decisive result: correct target/content, sibling survival,
  no duplicate toggle/save/close, default prevention only when owned, and focus
  after cancel/reopen. Exercise a distinct Control chord when it could be
  confused with Command; do not send potentially destructive chords globally.
- Menu activation and shortcut delivery as separate actions. A successful menu
  callback cannot prove its accelerator; one Settings tab cannot alone prove
  one dispatch, since Settings already deduplicates tabs. For duplicate-dispatch
  assertions use a reversible toggle, two distinct tabs or independent effects.
- Repeat/keyup and composition guards when touched. A synthetic composition
  event or WKWebView `press` does not prove the macOS input-method candidate UI.

In YAML, `Mod+b` means an intentional Cmd/Ctrl equivalent; `Meta+b` is explicit
Command, `Control+b` is Control and `Alt` is Option. Use
`press: {key: ..., macos_key: ..., selector: ...}` for intentional platform
differences, not as an undocumented fallback. A selector sets DOM focus only.
The Mac bridge synthesizes WebView key events and does not implement every
browser default (notably Tab traversal); do not certify native Edit or Full
Keyboard Access from it. Use the real OS procedure for those assertions.

If a standard command or guard is missing, keep its acceptance target, record
the concrete source/runtime gap and remaining action. Do not mark it N/A,
silently substitute a different chord or broaden this testing task into product
changes. For example, `close-active` currently has no accelerator in
`nativeAppMenu.ts`; the existing menu case does not establish Cmd+W support.

## Selection And Evidence

Run from the repository root with the existing isolated QA build/config. Check
the selected `app.native_binary`; build/reuse through `native_build.py` as in
[native-testing.md](native-testing.md). These focused cases do not need the
Java-specific `run-native-macos.sh` bootstrap.

```bash
export PYTHONPATH=.agents/skills/qa-ui-auto/scripts
python -m qa_ui_auto.ci plan --scope selected --platforms macos --modes browser,native \
  --case-ids TC-MAC-001,TC-MAC-002,TC-MAC-003,TC-WS-080,TC-WS-083
python -m qa_ui_auto run --mode browser \
  --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.browser.yaml \
  --filter TC-MAC-003 --require-pass
python -m qa_ui_auto run --mode native \
  --config .agents/skills/qa-ui-auto/assets/qa-ui-auto.config.macos.yaml \
  --filter TC-MAC-001,TC-MAC-002,TC-WS-080,TC-WS-083 --require-pass
```

Start Vite/builds/long suites detached as in SKILL.md. Browser mode needs the
current checkout's server; native needs a matching QA binary and free bridge
port. On another OS, validate schema/contracts and the macOS CI selection;
record execution as unrun instead of forcing a supported-platform result.

Retain report/receipt/build identity, NSMenu observations, element geometry and
screenshots. For OS checks also record macOS build, CPU architecture, keyboard
layout/IME, system and app appearance, window state, screen scale/resolution,
notch/external display and OS capture. Cover current and oldest supported
macOS/WKWebView targets and supported architectures when claiming compatibility;
the hosted `macos-15` ARM64 entry alone does not cover Intel or every OS version.
Theme cycling does not prove system-theme live switching. DOM clearance does
not measure traffic-light rectangles. State each missing boundary explicitly.
