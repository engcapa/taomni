# Notes Workspace dark selection: active-line occlusion

## Symptom and evidence

Selecting several lines in the Notes Workspace leaves the last selected line looking unselected in dark/black app theme; light theme appears normal.

The source identifies a concrete, high-confidence cause, not a missing character in the selection:

- `NotesWorkspaceDocument.tsx` embeds `CodeMirrorHost` with soft wrapping. The compact `NoteEditor` uses native input/textarea fields instead; its link overlay and local Notes palette are a different path.
- `host/useEditorViewLifetime.ts` installs both `highlightActiveLine()` and `drawSelection()`. In installed CodeMirror, the active-line decoration follows every selection's **head**, including nonempty ranges. Selection rectangles are painted **below** the text content.
- `codeViewTheme.ts` fills `.cm-activeLine` with `--taomni-code-active-line-bg`. `src/styles/theme.css` sets it to opaque `#24262b` in dark app theme, versus `rgba(37, 99, 235, 0.07)` in light. The opaque line covers the selection rectangle underneath. Forward selection exposes the defect on the final line; reverse selection moves the occluder to the first line.
- The workspace editor does not receive `notesThemeStyle()`: changing Notes panel-only palettes would not fix this path.

The new mounted regression failed before the fix with the selected head retaining the active-line fill, and passes after the fix. This is state/CSS-cascade evidence. **No local app/browser/native reproduction or pixel verification was performed**, per the user restriction; source analysis does not certify the original user's compositor/font/DPI environment.

## Localized implementation

Only production change: `src/components/editor/workspace/host/appearance.ts`.

Add a state-derived `cm-has-selection` class using `EditorView.editorAttributes`, and make `.cm-activeLine` transparent while **any** selection range is nonempty. The selector outranks both the shared token rule and an explicit editor appearance's rule without `!important`. Removing the range restores the original caret-line fill automatically.

This applies to CodeMirrorHost consumers, including Notes and Code Workspace, because they share the affected active-line/selection layer. It does not change `codeViewTheme`, standalone file editors or Git diff styling. Preserve selection endpoints/text, native selection integration, syntax colors, selection rectangle colors, caret rendering, gutter highlight, wrapping, undo, read-only behavior and retained editor lifetime. No palette, persistence, IPC, dependency or shortcut changes. No DOM polling, React selection state or new QA control.

## Acceptance and executable regression

| Check | Evidence / expected result | Status |
| --- | --- | --- |
| V1 — selection semantics + known occluder | `CodeMirrorHost.selectionHighlight.test.tsx`: real light/dark app tokens; forward/reverse multiline, single-line, Select All; exact anchor/head/text; selected head has transparent fill, caret-only fill restores | 10 tests passed |
| V2 — retained editor behavior | Same test: explicit high-contrast appearance, secondary nonempty range with primary caret, replacement/undo including final selected line, read-only selection. Existing appearance-lifetime, template-selection and Notes palette tests retained | Combined 4 files / 19 tests passed |
| V3 — real UI path and rendered geometry | Existing **TC-NOTES-008**, browser/native, `reset_db`: keep caret/link assertions; Large Preview → Edit, enter four short lines, cycle app light/dark, select first three via keyboard. Assert exact DOM selected text excluding tail, head line identity, transparent active-line fill, final selection rectangle overlap/width; reverse, replace, undo and Select All assert exact results | Schema + reviewed behavior contract passed; runtime unrun |
| V4 — composited appearance | Review `notes-008-selection-{light-forward,dark-forward,dark-reverse,dark-all}.png`: selected text on head/final line must visibly highlight just like earlier lines; forward/reverse screenshots leave tail unselected; Select All includes it | Unrun; screenshots are artifacts, not a pixel verdict |

TC-NOTES-008 checkpoints: light selection **39–43**, collapsed-caret restoration **46–47**, dark selection **54–58**, reverse **62–64**, replacement **67**, undo **69**, Select All **71–72**, runtime errors **74**. macOS uses Command+Up/Down for document navigation and Command+Shift+Right/Up for extension; Windows/Linux use Ctrl+Home/End and Shift+End. These are existing editor bindings, not modified shortcuts. Runner key actions establish renderer/WebView routing, not physical OS key delivery or menu accelerators.

Focused local command (Node 22; no app launch or build):

```sh
PATH=/data/dev/nodejs.backup-20260707-090544/bin:$PATH pnpm exec vitest run src/components/editor/workspace/CodeMirrorHost.selectionHighlight.test.tsx src/components/editor/workspace/CodeMirrorHost.appearanceLifetime.test.tsx src/components/editor/workspace/CodeMirrorHost.template-selection.test.tsx src/lib/notes/notesTheme.test.ts --maxWorkers=2
```

`validate_doc` and `validate_contract(require_review=True)` pass for the changed 74-step case. Unit tests check state/style cascade only: jsdom does not supply meaningful selection rectangles or composited pixels.

## Handoff and boundaries

- Main agent owns hosted execution and QA catalogs. Reuse **TC-NOTES-008**; retain browser/native modes and `reset_db`, add covers `F-WS-1` and `F5.5` alongside `F-TAO-1`. Uses existing `theme-cycle`, Notes preview/edit controls and editor selectors; no new testids/fixtures/verbs/dependency services. Catalog/policy/dependency changes are not part of this agent's edit set.
- Run the case in hosted browser and matching QA native release. Inspect Windows WebView2, Linux WebKitGTK and macOS WKWebView results separately, plus the four screenshots. Structural selection/CSS/geometry assertions alone do not establish visual completion. Retained shared editing workflow: **TC-NOTES-009**; the main agent owns integration/crash-regression gates.
- Manual follow-up: select by pointer in both directions, include a wrapped final selected line and mixed CJK text; verify caret return. Inspect physical Windows 11 display scaling at 100/125/150/200% and native font fallback/IME where relevant. These checks and all three packaged-WebView pixel results remain unverified until matching evidence exists.
- Leave unrelated terminal-routing work untouched; no branch changes, staging, commit, build or local app/browser/native run.
