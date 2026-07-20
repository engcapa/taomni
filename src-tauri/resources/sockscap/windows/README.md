# WinDivert binaries for SocksCap (Windows)

Place the official WinDivert redistributable files here:

- `WinDivert.dll`
- `WinDivert64.sys` (or the architecture-matched driver from the release)

Download: https://reqrypt.org/windivert.html  
License: LGPLv3 / GPLv2 — load dynamically from elevated `sockscap-helper` only.

Optional: set `SOCKSCAP_WINDIVERT_DIR` to an alternate directory.

## Capture path

```
App TCP  ──► WinDivert NETWORK (NAT dst → 127.0.0.1:relay)
                ▲
                │ FLOW layer supplies PID / path
                │
sockscap-helper (UAC elevated)
                │
                ▼ lookup_orig(srcPort)
Taomni relay  ──► Policy (GFWList) ──► DIRECT | HTTP | SOCKS5 ──► target
```

## Dev workflow

```powershell
# From repo root — builds helper and copies WinDivert next to target/debug
pwsh scripts/stage-sockscap-windows.ps1

pnpm tauri dev
# SocksCap UI → Start (accept UAC) → Active means elevated helper + WinDivert OK
```

`tauri.conf.json` bundles `resources/sockscap/**/*` into the app resource dir.
Place `WinDivert.dll` + `WinDivert64.sys` here before packaging a Windows installer.

## Hard bypass

Always excluded from capture:

- Taomni main PID and helper PID
- Upstream proxy/SSH host:port
- Relay loopback port
- Configured bypass CIDRs (LAN/private defaults)
