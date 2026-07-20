# Stage sockscap-helper + WinDivert next to the built taomni binary (dev/release).
# Usage (from repo root):
#   pwsh scripts/stage-sockscap-windows.ps1
#   pwsh scripts/stage-sockscap-windows.ps1 -Configuration release

param(
  [ValidateSet("debug", "release")]
  [string]$Configuration = "debug"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root "src-tauri"
$target = Join-Path $tauri "target\$Configuration"
$resWin = Join-Path $tauri "resources\sockscap\windows"

Push-Location $tauri
try {
  Write-Host "Building sockscap-helper ($Configuration)..."
  if ($Configuration -eq "release") {
    cargo build --bin sockscap-helper --release
  } else {
    cargo build --bin sockscap-helper
  }
} finally {
  Pop-Location
}

$helperSrc = Join-Path $target "sockscap-helper.exe"
if (-not (Test-Path $helperSrc)) {
  throw "helper not found at $helperSrc"
}

# Prefer resources/sockscap/windows for WinDivert; copy into target for runtime discovery.
$dll = Join-Path $resWin "WinDivert.dll"
$sys = Join-Path $resWin "WinDivert64.sys"
if (-not (Test-Path $dll)) {
  Write-Warning "WinDivert.dll missing at $dll — download WinDivert 2.2+ into resources/sockscap/windows/"
} else {
  Copy-Item $dll $target -Force
  if (Test-Path $sys) { Copy-Item $sys $target -Force }
  Write-Host "Staged WinDivert into $target"
}

Write-Host "Helper ready: $helperSrc"
Write-Host "Done. Start Taomni and open SocksCap → Start (accept UAC)."
