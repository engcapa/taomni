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
  $files = @(Get-ChildItem -LiteralPath $app.DirectoryName -Recurse -File | ForEach-Object {
    [ordered]@{ path = [IO.Path]::GetRelativePath($app.DirectoryName, $_.FullName); bytes = $_.Length }
  })
  $result = [ordered]@{
    scope = 'msi-administrative-payload'
    executableSha256 = (Get-FileHash -LiteralPath $app.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    productVersion = $app.VersionInfo.ProductVersion
    architecture = 'x86_64'
    regularFiles = $files.Count
    regularFileBytes = ($files | Measure-Object -Property bytes -Sum).Sum
    largestFiles = @($files | Sort-Object -Property bytes -Descending | Select-Object -First 25)
    applicationLaunched = $false
    installedUpgradeEstablished = $false
    systemTrustEstablished = $false
  }
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'windows-payload.json') -Encoding utf8
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force
}
