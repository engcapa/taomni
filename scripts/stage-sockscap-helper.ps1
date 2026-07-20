# Build sockscap-helper and stage it for Tauri externalBin (Windows).
# Tauri expects: src-tauri/binaries/sockscap-helper-<target-triple>.exe
#
# Usage:
#   .\scripts\stage-sockscap-helper.ps1            # debug (local dev)
#   .\scripts\stage-sockscap-helper.ps1 -Release   # release (packaging / CI)
param(
  [switch]$Release
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Tauri = Join-Path $Root "src-tauri"

$triple = (rustc -vV | Select-String "host:").ToString().Split()[-1]
if (-not $triple.Contains("windows")) {
  Write-Host "Skipping sockscap-helper stage on non-Windows host ($triple)."
  exit 0
}

$binDir = Join-Path $Tauri "binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$dest = Join-Path $binDir "sockscap-helper-$triple.exe"

# Ensure a placeholder exists so tauri-build does not fail mid-compile
# before this script overwrites it with a real binary.
if (-not (Test-Path $dest)) {
  Set-Content -Path $dest -Value "placeholder" -Encoding ascii
}

$profile = if ($Release) { "release" } else { "debug" }
$cargoArgs = @("build", "--bin", "sockscap-helper")
if ($Release) {
  $cargoArgs += "--release"
}

Push-Location $Tauri
try {
  Write-Host "Building sockscap-helper ($profile) for $triple ..."
  & cargo @cargoArgs
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build --bin sockscap-helper failed with exit code $LASTEXITCODE"
  }

  $src = Join-Path $Tauri "target\$profile\sockscap-helper.exe"
  if (-not (Test-Path $src)) {
    throw "sockscap-helper.exe not found at $src after build"
  }

  Copy-Item -Force $src $dest
  $bytes = (Get-Item $dest).Length
  if ($bytes -lt 1024) {
    throw "Staged helper looks like a placeholder ($bytes bytes): $dest"
  }
  Write-Host "Staged $dest ($bytes bytes, $profile)"
} finally {
  Pop-Location
}
