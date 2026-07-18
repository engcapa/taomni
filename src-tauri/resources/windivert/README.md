# WinDivert runtime (Windows Sockscap)

Official **WinDivert 2.2.2** redistributable for transparent capture (plan Phase 5 / ADR-0002).

These files are **bundled into the Taomni installer** (`tauri.conf.json` → `bundle.resources`)
so customers never download WinDivert by hand. On first **Sockscap → Start**, the app:

1. Locates `windivert/WinDivert.dll` + `WinDivert64.sys` from the package resources
2. Prompts **UAC** if needed and copies them into `C:\Windows\System32\`
3. Smoke-opens the driver, then starts global / app / process transparent capture

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
