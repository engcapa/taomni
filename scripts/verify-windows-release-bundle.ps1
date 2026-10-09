# Inspect the actual installers, not the build directory (where Cargo already
# puts the DLLs). No installed Taomni or user profile is modified.
param(
  [string]$ReleaseDir = (Join-Path $PSScriptRoot "../src-tauri/target/release"),
  [string]$SevenZip = "7z"
)
$ErrorActionPreference = "Stop"
$ReleaseDir = (Resolve-Path -LiteralPath $ReleaseDir).Path
$dlls = @("sherpa-onnx-c-api.dll", "sherpa-onnx-cxx-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll")
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
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaomniRuntimeLoader {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll")]
  public static extern bool FreeLibrary(IntPtr module);
}
'@
  foreach ($directory in @($nsisDir, $msiDir)) {
    $executables = @(Get-ChildItem -LiteralPath $directory -Recurse -File -Filter taomni.exe)
    if ($executables.Count -ne 1) { throw "Expected one taomni.exe in $directory" }
    $appDir = $executables[0].DirectoryName
    # Tauri patches the main executable's bundle-type marker separately for
    # NSIS/MSI, so its hash legitimately differs between the two installers.
    foreach ($name in $dlls) {
      $bundled = Join-Path $appDir $name
      if (-not (Test-Path -LiteralPath $bundled -PathType Leaf)) {
        throw "Missing runtime file beside taomni.exe: $bundled"
      }
      if ((Get-FileHash -LiteralPath $bundled).Hash -ne (Get-FileHash -LiteralPath (Join-Path $ReleaseDir $name)).Hash) {
        throw "Bundled file differs from build output: $bundled"
      }
    }
    foreach ($name in $dlls) {
      # Resolve dependencies ONLY beside the extracted DLL and in System32.
      # PATH, Cargo output and an existing MSI install must not hide omissions.
      $handle = [TaomniRuntimeLoader]::LoadLibraryEx((Join-Path $appDir $name), [IntPtr]::Zero, 0x900)
      if ($handle -eq [IntPtr]::Zero) {
        throw "Cannot load bundled $name (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
      }
      [void][TaomniRuntimeLoader]::FreeLibrary($handle)
    }
    Write-Host "Verified installer payload and isolated DLL loading: $directory"
  }
} finally {
  # $work is a freshly created, absolute child of the temporary directory.
  Remove-Item -LiteralPath $work -Recurse -Force
}
