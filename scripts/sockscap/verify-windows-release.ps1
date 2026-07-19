#requires -Version 7.2

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ManifestPath,

    [switch]$LintOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Fail-Gate {
    param([string]$Code, [string]$Message)
    throw "${Code}: ${Message}"
}

function Get-RequiredProperty {
    param([object]$Object, [string]$Name)
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        Fail-Gate "WINDOWS_MANIFEST_INVALID" "missing property '$Name'"
    }
    return $property.Value
}

function Get-RequiredString {
    param([object]$Object, [string]$Name)
    $value = [string](Get-RequiredProperty $Object $Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        Fail-Gate "WINDOWS_MANIFEST_INVALID" "property '$Name' must be non-empty"
    }
    return $value
}

function Resolve-ArtifactPath {
    param([string]$Value)
    if ([System.IO.Path]::IsPathRooted($Value)) {
        $candidate = $Value
    } else {
        $candidate = Join-Path $script:ManifestDirectory $Value
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Fail-Gate "WINDOWS_ARTIFACT_MISSING" "artifact is missing: $candidate"
    }
    return (Resolve-Path -LiteralPath $candidate).Path
}

function Assert-Sha256 {
    param([string]$Path, [string]$Expected)
    if ($Expected -notmatch '^[0-9a-fA-F]{64}$') {
        Fail-Gate "WINDOWS_HASH_PIN_INVALID" "SHA-256 pin is invalid for $Path"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($actual -ne $Expected.ToLowerInvariant()) {
        Fail-Gate "WINDOWS_HASH_MISMATCH" "SHA-256 mismatch for $Path"
    }
}

function Invoke-SignTool {
    param([string[]]$Arguments)
    & $script:SignTool @Arguments | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) {
        Fail-Gate "WINDOWS_SIGNATURE_INVALID" "signtool failed: $($Arguments -join ' ')"
    }
}

function Assert-Authenticode {
    param([string]$Path, [string]$ExpectedSubject)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        Fail-Gate "WINDOWS_SIGNATURE_INVALID" "Authenticode status for $Path is $($signature.Status)"
    }
    if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -ne $ExpectedSubject) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "unexpected signer for $Path"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        Fail-Gate "WINDOWS_TIMESTAMP_MISSING" "timestamp signature is missing for $Path"
    }
    Invoke-SignTool @("verify", "/pa", "/all", "/v", $Path)
}

function Assert-UserArtifact {
    param([object]$Artifact, [string]$ExpectedSubject)
    $path = Resolve-ArtifactPath (Get-RequiredString $Artifact "path")
    Assert-Sha256 $path (Get-RequiredString $Artifact "sha256")
    $subject = Get-RequiredString $Artifact "signerSubject"
    if ($subject -ne $ExpectedSubject) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "manifest signer does not match expectedPublisher"
    }
    Assert-Authenticode $path $subject
    return $path
}

function Assert-KernelDriver {
    param([string]$Path, [string]$ExpectedHash)
    Assert-Sha256 $Path $ExpectedHash
    Invoke-SignTool @("verify", "/kp", "/all", "/v", $Path)
}

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$script:ManifestDirectory = Split-Path -Parent $resolvedManifest
$manifest = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json -Depth 64

if ([int](Get-RequiredProperty $manifest "schemaVersion") -ne 1) {
    Fail-Gate "WINDOWS_MANIFEST_INVALID" "schemaVersion must be 1"
}
$enabled = [bool](Get-RequiredProperty $manifest "captureReleaseEnabled")
$architecture = [string](Get-RequiredProperty $manifest "architecture")
if ($architecture -notin @("x86_64", "aarch64")) {
    Fail-Gate "WINDOWS_MANIFEST_INVALID" "architecture must be x86_64 or aarch64"
}
$provider = [string](Get-RequiredProperty $manifest "applicationCaptureProvider")
if ($provider -notin @("unselected", "windivert", "wfp")) {
    Fail-Gate "WINDOWS_MANIFEST_INVALID" "unknown applicationCaptureProvider '$provider'"
}

if ($LintOnly) {
    [ordered]@{
        platform = "windows"
        mode = "lint"
        captureReleaseEnabled = $enabled
        applicationCaptureProvider = $provider
        result = "PASS"
    } | ConvertTo-Json -Compress
    exit 0
}

if ($env:OS -ne "Windows_NT") {
    Fail-Gate "WINDOWS_HOST_REQUIRED" "release signature verification must run on Windows"
}
if (-not $enabled) {
    Fail-Gate "WINDOWS_CAPTURE_RELEASE_DISABLED" "captureReleaseEnabled is false"
}
if ($provider -eq "unselected") {
    Fail-Gate "WINDOWS_PROVIDER_UNSELECTED" "WinDivert versus WFP ADR is still open"
}

$signToolCommand = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
if ($null -eq $signToolCommand) {
    Fail-Gate "WINDOWS_SIGNTOOL_MISSING" "install the current Windows SDK/WDK and put signtool.exe on PATH"
}
$script:SignTool = $signToolCommand.Source
$expectedPublisher = Get-RequiredString $manifest "expectedPublisher"
$artifacts = Get-RequiredProperty $manifest "artifacts"
$applicationPath = Assert-UserArtifact (Get-RequiredProperty $artifacts "application") $expectedPublisher
$helperPath = Assert-UserArtifact (Get-RequiredProperty $artifacts "helper") $expectedPublisher

$wintun = Get-RequiredProperty $artifacts "wintun"
$wintunPath = Resolve-ArtifactPath (Get-RequiredString $wintun "path")
Assert-Sha256 $wintunPath (Get-RequiredString $wintun "sha256")
$wintunSubject = Get-RequiredString $wintun "signerSubject"
Assert-Authenticode $wintunPath $wintunSubject
$wintunVersion = Get-RequiredString $wintun "version"
$actualWintunVersion = (Get-Item -LiteralPath $wintunPath).VersionInfo.FileVersion
if ([string]::IsNullOrWhiteSpace($actualWintunVersion) -or $actualWintunVersion -notlike "${wintunVersion}*") {
    Fail-Gate "WINDOWS_WINTUN_VERSION_MISMATCH" "Wintun file version is '$actualWintunVersion', expected '$wintunVersion'"
}

$providerArtifact = Get-RequiredProperty $artifacts "applicationProvider"
if ((Get-RequiredString $providerArtifact "kind") -ne $provider) {
    Fail-Gate "WINDOWS_PROVIDER_MISMATCH" "provider kind disagrees with applicationCaptureProvider"
}
$providerUserPath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "userModePath")
$providerDriverPath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "driverPath")
$providerSubject = Get-RequiredString $providerArtifact "signerSubject"
Assert-Sha256 $providerUserPath (Get-RequiredString $providerArtifact "userModeSha256")
Assert-Authenticode $providerUserPath $providerSubject
Assert-KernelDriver $providerDriverPath (Get-RequiredString $providerArtifact "driverSha256")

if ($provider -eq "windivert") {
    $licensePath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "licensePath")
    if ((Get-Item -LiteralPath $licensePath).Length -eq 0) {
        Fail-Gate "WINDOWS_LICENSE_MISSING" "WinDivert license file is empty"
    }
} else {
    if ($providerSubject -ne $expectedPublisher) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "first-party WFP artifacts must use expectedPublisher"
    }
    $catalogPath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "catalogPath")
    $infPath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "infPath")
    Assert-Sha256 $catalogPath (Get-RequiredString $providerArtifact "catalogSha256")
    Assert-Sha256 $infPath (Get-RequiredString $providerArtifact "infSha256")
    Invoke-SignTool @("verify", "/kp", "/all", "/v", $catalogPath)
    Invoke-SignTool @("verify", "/kp", "/v", "/c", $catalogPath, $infPath)
}

[ordered]@{
    platform = "windows"
    architecture = $architecture
    applicationCaptureProvider = $provider
    application = $applicationPath
    helper = $helperPath
    wintun = $wintunPath
    result = "PASS"
} | ConvertTo-Json -Compress
