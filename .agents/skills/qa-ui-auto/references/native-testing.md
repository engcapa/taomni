# Native Testing, Isolation And Performance

## Build Once, Run Selected Cases

During development, first use focused logic/mounted/browser checks. Compile after
related source and test edits stabilize, then batch the necessary native cases
on that input. A native-only defect may warrant an earlier minimal probe.
See [efficient-verification.md](efficient-verification.md) for selection and cost.

Before setup, inspect the selected config's `app.native_binary` and driver path:
an explicit legacy config overrides the harness's isolated QA default. Use the
verified QA binary and a WebView-compatible driver in a task config; do not rebuild
because a config points at the wrong executable. Check ports before launch.

Desktop launch may show a window. Global OS input/IME tests also share the user's
keyboard, pointer and focus: when the user is active on that desktop, agree a
compact window for those steps or use a separate desktop/machine. WebDriver input
and headless browser tests have different focus boundaries; do not claim background
OS automation merely because a window is minimized. On detected focus/input
interference, retain the failure and rerun only affected steps when the desktop is available.

Windows lock is a separate condition from background execution. Headless browser
checks normally remain usable; native WebDriver input/screenshots depend on the
WebView/driver and must not be assumed lock-compatible. Record lock state and
check a required observation if it changes. IDEA/global mouse/keyboard/IME sampling
needs an interactive desktop. Never unlock or alter lock policy automatically;
continue independent checks and reuse valid pre-lock evidence when inputs match.

Before building, `python .agents/skills/qa-ui-auto/scripts/native_build.py --check`
reports reusable (exit 0), build needed (1), or check error (2), without compiling
or launching. It names changed input categories and prior recorded build time;
prior duration is not time spent again on a cache hit. Normal build invocation
still rechecks. Group cases by required frontend/profile, avoid routine `--force`
and preserve the incremental target. Do not compile separately for each case.

For a new/changed native case, first run its selected `--mode native --dry-run`
to reject unsupported verbs/platforms before compiling. Runner, fixture or YAML
fixes usually reuse the same binary; source fixes require a matching build.
If retained behavior fails, preserve the run and distinguish an app defect from
a fixture/assertion assumption before editing either. For example, multi-character
W3C typing need not share one undo transaction: use one edit for an undo smoke,
or explicitly test the intended grouping when grouping is the requirement.

Use a separately built QA application even for manual native exploration.
`assets/tauri.qa.conf.json` overrides the identifier to `com.taomni.app.qa` and
product name to `Taomni QA`. Keep production Tauri configuration unchanged.
Environment overrides or renamed executables cannot change a compiled ID.

From the repository root (with the module path set as in SKILL.md):

```bash
python .agents/skills/qa-ui-auto/scripts/native_build.py
python -m qa_ui_auto run --mode native --filter TC-NATIVE-CORE-001
```

The helper builds with the QA overlay in `src-tauri/target/qa-ui-auto` and writes
`<binary>.qa-identity.json` with the ID and binary SHA-256 only after success.
The harness checks this record before starting the driver or fixtures; missing
records, production IDs and changed binaries are rejected. Never hand-author a
record for an existing production binary. This is build provenance to prevent
accidental profile reuse, not a signature against malicious substitutions.

The default binary is `src-tauri/target/qa-ui-auto/debug/taomni` (`taomni.exe` on
Windows). For release-profile measurements, build with `native_build.py --release`
and set `app.native_binary` in a dedicated config to the resulting release binary.
Keep its identity record adjacent. The helper reuses builds when source, recipe,
platform, compiler, Node and recorded environment match; `--force` rebuilds.
The harness rejects a mismatching recorded source fingerprint. Legacy records
without source fingerprints cannot establish current-source execution coverage.

The Rust debug profile still bundles React's production frontend by default.
For `tauri dev` lifecycle regressions, set `NODE_ENV=development` when invoking
`native_build.py`; the build identity records this input and prevents reuse
across React modes. This exercises development StrictMode with real native
services, but does not test the Vite dev server or HMR transport. Record that
distinction and verify the expected frontend mode in the selected scenario.

The harness redirects Linux XDG data/config/cache or Windows AppData/LocalAppData
to this run, then restores its environment on exit. `reset_db` only clears QA
application state inside verified run roots. Native runs are sequential. The
driver must be started by this run to inherit isolation; an existing listener is
rejected. Configure free WebDriver and native-driver ports for independent jobs.

An independent ID does not isolate arbitrary files, hardcoded shared credential
service names, clipboard, global shortcuts or SSH targets. Use disposable
workspaces/accounts, inspect affected storage paths, preserve/restore supported
host state and disclose non-restorable effects. Never use personal projects or
credentials as mutation fixtures, redirect HOME, or erase a profile as a shortcut.

## Three Target Platforms

| Target | Native execution | Compatibility evidence |
|---|---|---|
| Linux | `tauri-driver`, `WebKitWebDriver`, an X11 desktop or Xvfb; X11-specific verbs need real dependencies | GTK/WebKitGTK, Ctrl shortcuts, case-sensitive paths/permissions, clipboard and IME |
| Windows | `tauri-driver` plus matching `msedgedriver.exe`/WebView2; set `webdriver.native_driver` if needed | Ctrl/Alt shortcuts, drive/UNC paths, locking/permissions, clipboard/dialogs, WebView2 |
| macOS | Tauri WebDriver unsupported; use available OS UI automation or recorded manual QA-app runs on macOS | Cmd/Meta shortcuts, WKWebView, IME, case sensitivity, permissions, clipboard/dialogs/window controls |

Linux/Xvfb exercises Tauri/WebKitGTK but cannot prove physical input, GPU,
compositor, IME or performance behavior for another desktop/device. For macOS
packaged/manual runs, verify `CFBundleIdentifier` and QA-owned data/config/cache/
keychain namespaces; use a disposable OS account for workflows sharing resources
outside them. Do not install over production. Browser WebKit is supplementary
renderer evidence, not a native WKWebView/IPC test.

Choose representative native workflows for each affected OS. When a host or
dependency is unavailable, retain available evidence and label missing targets
unverified with the remaining action. Optional `native_platforms: [Linux, Windows]`
restricts a case; it does not prove either platform was tested. Known Linux-only
verbs are rejected before native launch on unsupported targets.

## Performance Must Not Regress

Choose metrics for the changed behavior: startup/readiness, input response,
editor actions, terminal throughput, file/list/search latency, transfer throughput,
memory/CPU, long tasks or leaked processes. Reuse scenarios and budgets; an
unrelated documentation edit does not need a full application performance suite.

Record baseline/candidate revisions, OS/hardware/WebView versions, build profile,
dataset, warmup and sample count. Compare with matching conditions and repeated
samples; separate cold/warm runs and account for known variance. Keep raw samples,
p50/p95 and relevant resource measurements. Unexplained slow samples remain
evidence. Missing baselines/measurements are unverified; establish a baseline
before claiming no regression.

`native_editor_performance` records keydown-to-CodeMirror-DOM-mutation samples
and gates a supplied p95 guardrail. This renderer metric is not full OS-to-screen
latency. `keys` accepts a single-char array or a plain string; `capture_text:
false` skips the per-key textContent probe for multi-megabyte documents, and
`label` writes per-invocation `native-editor-performance-<label>.json` artifacts
so repeated measurement groups accumulate. Compare the labeled artifacts
before/after as well as checking the guardrail. `assert_native_process_delta`
detects Linux process leaks.

`scripts/perf_baseline.py --base-url URL` remains a Chromium editor diagnostic.
It retains all measured samples, records explicit warmup separately and fails
over budget. `--baseline PATH --noise-ms N` additionally compares matching
conditions against unfiltered baseline samples. Without a baseline, regression
comparison remains unverified. It cannot prove native performance.

Functional success and performance success are separate. Reproducible slowdown
beyond measured noise fails the requirement even within an absolute budget.
Fix and rerun the affected scenario; never reset budgets/baselines to conceal it.
Keep collection focused and avoid permanent production hot-path instrumentation.
