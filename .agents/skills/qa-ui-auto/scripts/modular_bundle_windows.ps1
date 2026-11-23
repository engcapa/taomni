# Inspect a real MSI administrative payload; do not register an installed app.
param(
  [Parameter(Mandatory = $true)][string]$Directory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$Version
)
$ErrorActionPreference = 'Stop'
$Directory = (Resolve-Path -LiteralPath $Directory).Path
$OutputDirectory = (New-Item -ItemType Directory -Force -Path $OutputDirectory).FullName
$installers = @(Get-ChildItem -LiteralPath $Directory -File | Where-Object { $_.Name -match '\.(msi|exe)$' })
$signatures = @($installers | ForEach-Object {
  $signature = Get-AuthenticodeSignature -LiteralPath $_.FullName
  [ordered]@{
    file = $_.Name
    status = $signature.Status.ToString()
    statusMessage = $signature.StatusMessage
    signerThumbprint = if ($signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }
  }
})
$signatures | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'authenticode.json') -Encoding utf8
$msi = @(Get-ChildItem -LiteralPath $Directory -File -Filter '*.msi')
if ($msi.Count -ne 1) { throw 'Expected exactly one real MSI package' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('taomni-package-probe-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $log = Join-Path $OutputDirectory 'msi-extraction.log'
  $process = Start-Process msiexec.exe -ArgumentList @('/a', "`"$($msi[0].FullName)`"", '/qn', "TARGETDIR=`"$work`"", '/L*v', "`"$log`"") -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    $process.WaitForExit()
    throw 'MSI administrative extraction exceeded its two-minute budget'
  }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "MSI administrative extraction failed: $($process.ExitCode)" }
  $executables = @(Get-ChildItem -LiteralPath $work -Recurse -File -Filter 'taomni.exe')
  if ($executables.Count -ne 1) { throw 'Expected one taomni.exe in the actual MSI payload' }
  $app = $executables[0]
  if ($app.VersionInfo.ProductVersion -ne $Version) {
    throw "MSI executable product version differs: $($app.VersionInfo.ProductVersion), expected $Version"
  }
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($app.FullName))
  try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Missing DOS executable header' }
    $reader.BaseStream.Position = 0x3c
    $offset = $reader.ReadInt32()
    $reader.BaseStream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
      throw 'Expected a real x64 PE executable in the MSI'
    }
  } finally {
    $reader.Dispose()
  }
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaomniPackageRuntimeLoader {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll")]
  public static extern bool FreeLibrary(IntPtr module);
}
'@
  $runtimeFiles = @('sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll')

  # Previously released monolithic MSI samples may still own these libraries.
  $present = @($runtimeFiles | Where-Object { Test-Path -LiteralPath (Join-Path $app.DirectoryName $_) -PathType Leaf })
  if ($present.Count -ne 0 -and $present.Count -ne $runtimeFiles.Count) {
    throw 'The MSI contains an incomplete legacy Local Voice runtime'
  }
  foreach ($name in $present) {
    $path = Join-Path $app.DirectoryName $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing packaged runtime: $name" }
    # Exclude PATH/Cargo caches: dependencies must resolve beside the extracted
    # runtime DLL or in System32, as in the existing release producer gate.
    $handle = [TaomniPackageRuntimeLoader]::LoadLibraryEx($path, [IntPtr]::Zero, 0x900)
    if ($handle -eq [IntPtr]::Zero) {
      throw "Cannot load packaged $name (Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))"
    }
    [void][TaomniPackageRuntimeLoader]::FreeLibrary($handle)
  }
  $treeJson = & python (Join-Path $PSScriptRoot 'modular_bundle_inventory.py') sample-tree --root $app.DirectoryName
  if ($LASTEXITCODE -ne 0) { throw 'Could not inventory the extracted MSI payload' }
  $tree = $treeJson | ConvertFrom-Json -AsHashtable
  $argumentJson = & python (Join-Path $PSScriptRoot 'modular_bundle_inventory.py') retired-module-arguments --executable $app.FullName
  if ($LASTEXITCODE -ne 0) { throw 'Could not scan the MSI executable for retired module arguments' }
  $result = [ordered]@{
    scope = 'msi-administrative-payload'
    executableSha256 = (Get-FileHash -LiteralPath $app.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    retiredModuleArguments = ($argumentJson | ConvertFrom-Json -AsHashtable)
    productVersion = $app.VersionInfo.ProductVersion
    architecture = 'x86_64'
    isolatedRuntimeLoads = $present
    applicationLaunched = $false
    installedUpgradeEstablished = $false
    systemTrustEstablished = $false
  }
  foreach ($key in $tree.Keys) { $result[$key] = $tree[$key] }
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'windows-payload.json') -Encoding utf8
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force
}
