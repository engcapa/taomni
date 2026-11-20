# Native readonly-copy viewer loads an incomplete attachment

Source: [`de2aae3086d89f6d721941141d9820827a6a535d`](https://github.com/engcapa/taomni/commit/de2aae3086d89f6d721941141d9820827a6a535d).
Runs: <https://github.com/engcapa/taomni/actions/runs/44701935882>,
<https://github.com/engcapa/taomni/actions/runs/44746823551>,
<https://github.com/engcapa/taomni/actions/runs/44790362918>.
Repair branch: `fix/qa-platform-contract-failures` (case fix only; the product
race is still open).

TC-FILE-OPEN-006 fails on **every** native platform (ubuntu-24.04-xvfb,
windows, macos arm64) in three consecutive full runs, while the browser mode
passes. The failing step waits 30s for the readonly viewer content and never
sees it:

```
wait_for: visible condition not met within 30.0s
([data-testid="file-viewer"][data-readonly="true"]
 .cm-content:has-text("Mail attachment read-only fixture."): found=False)
```

## Evidence

The failure HTML captured after the timeout (macOS
`run-20261120-170505-534766000/TC-FILE-OPEN-006/failure-native.html`, Windows
`run-20261120-032639-321625020/TC-FILE-OPEN-006/failure-native.html`) shows the
readonly viewer mounted and the attachment copy downloaded:

```
<section class="fv fv-active" data-testid="file-viewer"
  data-path="…/taomni-viewer-OejWD6/policy.txt" data-kind="text"
  data-readonly="true" data-dirty="false">
  <div class="cm-line">Save locally before editing.</div>
```

The editor contains only the **tail** of the attachment text
(`MAIL_TEXT = "Mail attachment read-only fixture.\nSave locally before
editing.\n"`) — the first line is missing at wait time and present in the same
HTML a moment later (`<div class="cm-line cm-activeLine">Mail attachment
read-only fixture.</div>`). The `viewer-save` button state also flips through
"enabled" during the load window, which is what the original assertion tripped
on before the content wait was added.

`openTemporaryFile` (`src/lib/fileOpenTemp.ts`) awaits the download promise
before `openFile`, so the open-after-download ordering is correct on the
JS side; the incomplete content points at the native download write →
document load handoff (flush/visibility timing between the Rust transfer
completion and the WebView document read).

## Scope

- Browser mode passes on all three platforms — the race is native IO only.
- The case now waits for the fixture content before asserting control states
  (`TC-FILE-OPEN-006` step 68), so the remaining failure is the product race,
  not an assertion-timing artifact.
- Reproduced on all three native platforms in three consecutive runs; not
  runner-specific.

## Next steps

1. Reproduce with the QA app on a Linux/Xvfb host: open the mail attachment
   from `file_open_mail` and poll the temp file size versus the viewer
   document content.
2. Inspect the Rust download completion path for the mail attachment
   (`sftpDownload` with `openAfter`) — confirm the file handle is flushed and
   closed before the completion event reaches the WebView.
3. If the WebView reads the temp file before the flush, either open the viewer
   from a post-flush callback or make the document loader retry/stat the temp
   file until its size matches the transfer total.
