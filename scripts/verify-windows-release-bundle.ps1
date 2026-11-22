# Inspect the actual installers, not the build directory (where Cargo already
# puts the DLLs). No installed Taomni or user profile is modified.
param(
  [string]$ReleaseDir = (Join-Path $PSScriptRoot "../src-tauri/target/release"),
  [string]$SevenZip = "7z"
)
$ErrorActionPreference = "Stop"
$ReleaseDir = (Resolve-Path -LiteralPath $ReleaseDir).Path
$dlls = @("sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll")
$sockscapStaging = Join-Path $PSScriptRoot "../src-tauri/resources/sockscap/windows"
$sockscapRuntime = @("sockscap-helper.exe", "WinDivert.dll", "WinDivert64.sys")
if (Test-Path -LiteralPath (Join-Path $sockscapStaging "xray.exe") -PathType Leaf) {
  $sockscapRuntime += "xray.exe"
}
$nsis = @(Get-ChildItem -LiteralPath (Join-Path $ReleaseDir "bundle/nsis") -Filter '*-setup.exe')
$msi = @(Get-ChildItem -LiteralPath (Join-Path $ReleaseDir "bundle/msi") -Filter '*.msi')
if ($nsis.Count -ne 1 -or $msi.Count -ne 1) {
  throw "Expected exactly one NSIS and one MSI installer in $ReleaseDir"
}
$work = Join-Path ([IO.Path]::GetTempPath()) ("taomni-windows-bundle-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $nsisDir = Join-Path $work "nsis"
  & $SevenZip x -y "-o$nsisDir" $nsis[0].FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to extract NSIS installer" }
  # Administrative extraction lays out the MSI payload without installing it
  # or registering it as the user's app. It also resolves WiX's cabinet IDs.
  $msiDir = Join-Path $work "msi"
  $process = Start-Process msiexec.exe -ArgumentList @('/a', "`"$($msi[0].FullName)`"", '/qn', "TARGETDIR=`"$msiDir`"", '/L*v', "`"$(Join-Path $work 'msi.log')`"") -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Get-Content -LiteralPath (Join-Path $work 'msi.log') -Tail 60
    throw "MSI extraction failed: $($process.ExitCode)"
  }
  foreach ($directory in @($nsisDir, $msiDir)) {
    $executables = @(Get-ChildItem -LiteralPath $directory -Recurse -File -Filter taomni.exe)
    if ($executables.Count -ne 1) { throw "Expected one taomni.exe in $directory" }
    $appDir = $executables[0].DirectoryName
    if (Get-ChildItem -LiteralPath $directory -Recurse -File -Filter acp-fake-agent.exe) {
      throw "The Windows installer contains the ACP integration test fixture"
    }
    if (Get-ChildItem -LiteralPath $directory -Recurse -File -Filter taomni-vnc-key-helper.exe) {
      throw "The Windows installer contains the independently shipped VNC key helper"
    }
    $sockscapDir = Join-Path $appDir "resources/sockscap"
    foreach ($platform in @("linux", "macos")) {
      if (Test-Path -LiteralPath (Join-Path $sockscapDir $platform)) {
        throw "Unexpected SocksCap $platform resources in the Windows installer"
      }
    }
    foreach ($name in $sockscapRuntime) {
      $staged = Join-Path $sockscapStaging $name
      $bundled = Join-Path $sockscapDir "windows/$name"
      if (-not (Test-Path -LiteralPath $bundled -PathType Leaf)) {
        throw "Missing SocksCap resource in the Windows installer: $name"
      }
      if ((Get-FileHash -LiteralPath $bundled).Hash -ne (Get-FileHash -LiteralPath $staged).Hash) {
        throw "Bundled SocksCap resource differs from staging: $name"
      }
    }
    foreach ($name in $dlls) {
      if (Get-ChildItem -LiteralPath $directory -Recurse -File -Filter $name) {
        throw "The Windows core installer contains the Local Voice runtime: $name"
      }
    }
    Write-Host "Verified Windows core installer payload: $directory"
  }
} finally {
  # $work is a freshly created, absolute child of the temporary directory.
  Remove-Item -LiteralPath $work -Recurse -Force
}
