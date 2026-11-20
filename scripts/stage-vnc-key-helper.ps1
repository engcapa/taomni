param(
  [ValidateSet("debug", "release")]
  [string]$Configuration = "debug"
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$root = Split-Path -Parent $PSScriptRoot
$targetDir = if ($env:CARGO_TARGET_DIR) {
  [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR, $root)
} else {
  Join-Path $root "src-tauri/target"
}
$manifest = Join-Path $root "src-tauri/Cargo.toml"
$cargoArgs = @("build", "--manifest-path", $manifest, "--target-dir", $targetDir, "--locked", "-p", "taomni-vnc-key-helper")
if ($Configuration -eq "release") {
  $cargoArgs += "--release"
}
& cargo @cargoArgs

if ($Configuration -eq "release") {
  $staging = Join-Path $root "src-tauri/resources/vnc/windows"
  $binary = Join-Path $targetDir "release/taomni-vnc-key-helper.exe"
  Copy-Item -Force -LiteralPath $binary -Destination $staging
  Get-FileHash -LiteralPath (Join-Path $staging "taomni-vnc-key-helper.exe")
}
