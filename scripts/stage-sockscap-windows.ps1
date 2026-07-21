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

function Stop-SockscapHelper {
  $procs = Get-Process -Name "sockscap-helper" -ErrorAction SilentlyContinue
  if (-not $procs) { return }
  Write-Host "Stopping running sockscap-helper (so WinDivert files can be updated)..."
  $procs | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

function Copy-Safe {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$DestinationDir
  )
  if (-not (Test-Path $Source)) {
    Write-Warning "Skip missing: $Source"
    return $false
  }
  $dest = Join-Path $DestinationDir (Split-Path $Source -Leaf)
  try {
    Copy-Item -LiteralPath $Source -Destination $dest -Force -ErrorAction Stop
    Write-Host "  copied $(Split-Path $Source -Leaf)"
    return $true
  } catch {
    # Driver/sys often stays locked after a previous elevated capture session.
    if (Test-Path $dest) {
      Write-Warning "Could not overwrite $dest (in use). Keeping existing file. $_"
      return $true
    }
    Write-Warning "Failed to copy $Source -> $dest : $_"
    return $false
  }
}

Stop-SockscapHelper

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
  Write-Host "Staging WinDivert into $target ..."
  $okDll = Copy-Safe -Source $dll -DestinationDir $target
  $okSys = $true
  if (Test-Path $sys) {
    $okSys = Copy-Safe -Source $sys -DestinationDir $target
  }
  if ($okDll -and $okSys) {
    Write-Host "WinDivert ready under $target"
  } else {
    Write-Warning "WinDivert staging incomplete; if capture already worked before, existing files may still be fine."
  }
}

Write-Host "Helper ready: $helperSrc"
Write-Host "Done. Start Taomni and open SocksCap -> Start (accept UAC)."
Write-Host "Tip: if .sys copy warns 'in use', Stop SocksCap (or reboot) then re-run this script."
