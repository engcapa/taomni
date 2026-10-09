# Windows input reentrancy regression

Requires Windows, Python 3.11+ and the Rust/MSVC toolchain. Run from the repository
root. No RDP server, account, visible window or global keyboard input is needed.

```powershell
# Test the Tao version selected by the application's Cargo.lock.
python scripts/windows-input-reentrancy/run.py --report-dir qa-ui-auto-report/input-current

# Reproduce the deadlock in v0.4.34 / pre-fix main. Expected runner exit: 1.
python scripts/windows-input-reentrancy/run.py --tao-version 0.35.3 --report-dir qa-ui-auto-report/input-old
```

The runner builds a separate, minimal Tao executable. Its hidden window receives
each of `WM_KEYDOWN`, `WM_KEYUP`, `WM_SYSKEYDOWN`, `WM_SYSKEYUP` combined with a
pending cross-thread `WM_SETFOCUS` or `WM_KILLFOCUS`. The subclass only arranges
the timing: `GetQueueStatus` does not dispatch the pending focus message. Tao's
own keyboard handler dispatches it while calling `PeekMessageW`. On Tao 0.35.3
this reenters the handler while its non-reentrant keyboard/layout lock is held.

Each process must observe a nested focus message, complete the outer key handler
and answer a subsequent `WM_NULL` responsiveness probe. A bounded watchdog exits
deadlocked processes. No reentry is an error, never a pass. The worker allows the
outer handler time to return after the nested synchronous send completes.

`result.json` retains all eight outcomes, selected Tao version, explicit baseline
override, OS and hashes of the source, executable and dependency locks. Each
child returns 0 on success, 2 for unresponsiveness/incomplete input, 3 when the
required interleaving was not exercised. The runner returns 1 for any failed case;
an external process timeout is recorded as 124.

This establishes the Win32/Tao deadlock regression. It does not perform a real
RDP authentication/session switch, test the packaged WebView, or establish IME,
GPU, Linux or macOS behavior. Pair it with the isolated native application's
`TC-NATIVE-CORE-001` startup/PTY/input smoke and the RDP procedure documented in
`docs-issue/windows-rdp-main-window-freeze.md`.
