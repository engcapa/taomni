---
name: Native WebDriver readiness
description: Linux tauri-driver/WebKitWebDriver startup and input-cleanup behavior in qa-ui-auto native runs
---

The native harness must wait for both the tauri-driver intermediary port and the
underlying WebKitWebDriver port before creating the first WebDriver session.
tauri-driver can bind its own endpoint first, so checking only that endpoint
creates a startup race and produces a misleading `RemoteDisconnected` or
`Connection refused` setup failure.

**Why:** On Linux, the first native run reached the application only after the
driver race was removed. WebKitWebDriver can also reset the connection while
handling the best-effort `DELETE /actions` cleanup after an Enter key action,
even though the preceding W3C action completed and the next assertion can
continue.

**How to apply:** Keep native runs sequential and wait for both configured
ports. Preserve failures from the actual `POST /actions`; only suppress
transport errors from cleanup requests that release already-explicitly-released
input sources.