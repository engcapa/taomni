# WinDivert runtime (Windows Sockscap)

Official **WinDivert 2.2.2** redistributable for transparent capture (plan Phase 5 / ADR-0002).

These files are **bundled into the Taomni installer** (`tauri.conf.json` → `bundle.resources`)
so customers never download WinDivert by hand.

On **Sockscap → Start**, the **main Taomni process stays non-elevated**. It:

1. Binds a localhost control socket
2. UAC-launches **`sockscap-helper.exe`** (only the helper is elevated)
3. Helper installs WinDivert from package resources into System32 if needed
4. Helper runs WinDivert NAT; main process accepts traffic on `127.0.0.1:1080`

Stage the helper after building:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stage-sockscap-helper.ps1
```

## License

WinDivert is dual-licensed **LGPLv3 / GPLv2** (see `LICENSE`). Taomni loads the DLL
dynamically at runtime and does not static-link it into the MIT binary.

## Dev machine reinstall

```powershell
# Repo root (optional; Start also installs from resources)
powershell -ExecutionPolicy Bypass -File scripts/install-windivert-windows.ps1
```

## Runtime files shipped

| File | Role |
|------|------|
| `WinDivert.dll` | User-mode library |
| `WinDivert64.sys` | Signed kernel driver (x64) |
| `LICENSE` / `VERSION` | Redistribution notice |

Sample tools (`*.exe`) are not required at runtime and are gitignored.
