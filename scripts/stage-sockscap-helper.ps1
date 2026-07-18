# Build sockscap-helper and stage it for Tauri externalBin (Windows).
# Tauri expects: src-tauri/binaries/sockscap-helper-<target-triple>.exe
$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Tauri = Join-Path $Root "src-tauri"
# Ensure a placeholder exists so tauri-build does not fail mid-compile.
$triple = (rustc -vV | Select-String "host:").ToString().Split()[-1]
$binDir = Join-Path $Tauri "binaries"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$dest = Join-Path $binDir "sockscap-helper-$triple.exe"
if (-not (Test-Path $dest)) {
  Set-Content -Path $dest -Value "placeholder" -Encoding ascii
}

Push-Location $Tauri
try {
  Write-Host "Building sockscap-helper for $triple ..."
  # Avoid re-entering a broken placeholder loop: build the bin target.
  cargo build --bin sockscap-helper 2>&1 | Write-Host
  $srcDebug = Join-Path $Tauri "target\debug\sockscap-helper.exe"
  $srcRelease = Join-Path $Tauri "target\release\sockscap-helper.exe"
  $src = if (Test-Path $srcRelease) { $srcRelease } elseif (Test-Path $srcDebug) { $srcDebug } else {
    throw "sockscap-helper.exe not found under target/ after build"
  }
  Copy-Item -Force $src $dest
  Write-Host "Staged $dest ($((Get-Item $dest).Length) bytes)"
} finally {
  Pop-Location
}
