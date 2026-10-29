# File activation measurements

`TC-WS-064`–`069` use a capture listener on the real file-tree/tab activation.
The in-app animation-frame observer checks the exact visible canonical document,
JSON syntax highlighting where applicable, the 1500ms content/highlight budget,
and **every** frame gap against 150ms until one second after readiness. Plain
text explicitly omits the syntax-token requirement. Native cases retain real
keyboard input, save/reopen and full disk SHA checks. No SDK/LSP auto-discovery
is allowed for these ordinary documents.

When the window is narrow, reveal a clipped outer tab using its real left/right
scroll buttons before starting the activation measurement. Check that scrolling
keeps the active document and retain preparation geometry separately. The
original native `scrollIntoView` preparation in run `40793877197` left notes.txt
clipped behind the scroll-area edge, so no activation occurred. That failure is
retained; it must not be counted as a passing latency sample. `TC-WS-069` also
measures this initial notes.txt return before creating the draft, in addition to
the original ten consecutive switches. No synthetic tab activation is used.

## Browser recording overhead

The original browser recording enabled Playwright DOM snapshots and screencast
frames around locator operations. CPU profiles for run `40792477689` show
`captureSnapshot/visitNode` consuming about 182ms over the txt cold-open window
and 215ms over a file-tab activation window. These are cumulative samples,
not the duration of an individual product task. Native also has slow frames;
recording overhead does not explain away native failures.

Browser cases containing `measure_workspace_file_open` now retain action,
network and console traces with `screenshots=False, snapshots=False`. Failure
screenshots, HTML and the trace file remain available. Other browser cases keep
their original full recording. Each result and file-open report records the
actual trace options and whether recording started; native is unchanged.

All raw failures from the old recording policy remain failures. Compare product
candidates and their baseline using this **same** revised recorder before
attributing a change to the product. Budgets, fixtures, precise document checks,
CPU sampling, all frame samples and the settled observation interval remain
unchanged. Tool-only recording changes are not product acceleration.

The focused comparison uses product `070979bf` (case commit `54021155`) against
the shell-subscription candidate, with `TC-WS-059`, `061`–`069` and the complete
applicable crash suite on GitHub. This comparison is additional to the required
final full suite and four-round native performance comparison against main.
Current product status is tracked in
[the SDK/file startup follow-up](../../docs-feature/workspace-platform-redesign-sdk-startup-followup.md).
