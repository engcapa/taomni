# WinDivert runtime (Windows Sockscap)

Official **WinDivert 2.2.2** redistributable for transparent capture (plan Phase 5 / ADR-0002).

## License

WinDivert is dual-licensed **LGPLv3 / GPLv2**. See `LICENSE` in this directory after install.
Do not static-link into the MIT Taomni binary without a license review; we load it as a
side-by-side DLL at runtime when the `sockscap-windivert` feature is enabled.

## Install on a Windows host

From an elevated PowerShell (UAC):

```powershell
# Repo root
powershell -ExecutionPolicy Bypass -File scripts/install-windivert-windows.ps1
```

This will:

1. Download `WinDivert-2.2.2-A.zip` from https://reqrypt.org/windivert.html if missing
2. Place `WinDivert.dll` + `WinDivert64.sys` under this folder
3. Copy them into `C:\Windows\System32\`
4. Smoke-test `WinDivertOpen("false", …)` so the signed driver is loaded once

## What you get without WinDivert

Sockscap still starts in **local SOCKS5** mode (`127.0.0.1:1080`) with no driver.
Point browsers/apps at that proxy for global-style routing. Per-app transparent
capture is what needs WinDivert.

## Files (after install)

| File | Role |
|------|------|
| `WinDivert.dll` | User-mode library |
| `WinDivert64.sys` | Signed kernel driver (x64) |
| `WinDivert.lib` / `include/windivert.h` | Optional link/build |
| sample `*.exe` | Vendor samples (optional) |
