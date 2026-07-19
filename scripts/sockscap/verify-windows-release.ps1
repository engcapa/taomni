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
    $value = Get-RequiredProperty $Object $Name
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
        Fail-Gate "WINDOWS_MANIFEST_INVALID" "property '$Name' must be a non-empty string"
    }
    return $value
}

function Get-RequiredBoolean {
    param([object]$Object, [string]$Name)
    $value = Get-RequiredProperty $Object $Name
    if ($value -isnot [bool]) {
        Fail-Gate "WINDOWS_MANIFEST_INVALID" "property '$Name' must be a boolean"
    }
    return $value
}

function Assert-PropertyAbsent {
    param([object]$Object, [string]$Name)
    if ($null -ne $Object.PSObject.Properties[$Name]) {
        Fail-Gate "WINDOWS_MANIFEST_INVALID" "deprecated property '$Name' is not allowed"
    }
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

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-CertificateSha256 {
    param([object]$Certificate)
    if ($null -eq $Certificate) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "signer certificate is missing"
    }
    return $Certificate.GetCertHashString(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()
}

function Get-PeMachine {
    param([string]$Path)
    $stream = $null
    $reader = $null
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $reader = [System.IO.BinaryReader]::new($stream)
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) {
            Fail-Gate "WINDOWS_PE_INVALID" "$Path is not a valid PE image"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadUInt32()
        if ([uint64]$peOffset + 6 -gt [uint64]$stream.Length) {
            Fail-Gate "WINDOWS_PE_INVALID" "$Path has an invalid PE header offset"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            Fail-Gate "WINDOWS_PE_INVALID" "$Path has an invalid PE signature"
        }
        return $reader.ReadUInt16()
    } finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        } elseif ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Assert-PeArchitecture {
    param([string]$Path, [string]$ExpectedArchitecture)
    $expectedMachine = switch ($ExpectedArchitecture) {
        "x86_64" { [uint16]0x8664 }
        "aarch64" { [uint16]0xAA64 }
        default {
            Fail-Gate "WINDOWS_ARCHITECTURE_UNSUPPORTED" "unsupported PE architecture '$ExpectedArchitecture'"
        }
    }
    $actualMachine = Get-PeMachine $Path
    if ($actualMachine -ne $expectedMachine) {
        $actualHex = "0x{0:X4}" -f $actualMachine
        $expectedHex = "0x{0:X4}" -f $expectedMachine
        Fail-Gate "WINDOWS_ARCHITECTURE_MISMATCH" "$Path uses PE machine $actualHex; expected $ExpectedArchitecture ($expectedHex)"
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
    param(
        [string]$Path,
        [string]$ExpectedSubject,
        [string]$ExpectedCertificateSha256 = ""
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        Fail-Gate "WINDOWS_SIGNATURE_INVALID" "Authenticode status for $Path is $($signature.Status)"
    }
    if (
        $null -eq $signature.SignerCertificate -or
        -not [string]::Equals(
            $signature.SignerCertificate.Subject,
            $ExpectedSubject,
            [System.StringComparison]::Ordinal
        )
    ) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "unexpected signer for $Path"
    }
    if (
        -not [string]::IsNullOrEmpty($ExpectedCertificateSha256) -and
        (Get-CertificateSha256 $signature.SignerCertificate) -cne $ExpectedCertificateSha256.ToLowerInvariant()
    ) {
        Fail-Gate "WINDOWS_SIGNER_CERTIFICATE_MISMATCH" "unexpected signer certificate for $Path"
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        Fail-Gate "WINDOWS_TIMESTAMP_MISSING" "timestamp signature is missing for $Path"
    }
    Invoke-SignTool @("verify", "/pa", "/all", "/v", $Path)
}

function Assert-UnsignedAuthenticode {
    param([string]$Path)
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if (
        $signature.Status -ne [System.Management.Automation.SignatureStatus]::NotSigned -or
        $null -ne $signature.SignerCertificate
    ) {
        Fail-Gate "WINDOWS_WINDIVERT_DLL_SIGNATURE_INVALID" "$Path must match the explicitly pinned unsigned official WinDivert DLL"
    }
}

function Get-ZipEntry {
    param([object]$Archive, [string]$Name)
    $entries = @($Archive.Entries | Where-Object { $_.FullName -ceq $Name })
    if ($entries.Count -ne 1) {
        Fail-Gate "WINDOWS_PACKAGE_INVALID" "official package must contain exactly one '$Name' entry"
    }
    return $entries[0]
}

function Get-ZipEntrySha256 {
    param([object]$Entry)
    $entryStream = $null
    $sha256 = $null
    try {
        $entryStream = $Entry.Open()
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        $digest = $sha256.ComputeHash($entryStream)
        return ([System.BitConverter]::ToString($digest)).Replace("-", "").ToLowerInvariant()
    } finally {
        if ($null -ne $sha256) {
            $sha256.Dispose()
        }
        if ($null -ne $entryStream) {
            $entryStream.Dispose()
        }
    }
}

function Assert-FileMatchesZipEntry {
    param([string]$Path, [object]$Archive, [string]$EntryName)
    $entry = Get-ZipEntry $Archive $EntryName
    if ((Get-Sha256 $Path) -cne (Get-ZipEntrySha256 $entry)) {
        Fail-Gate "WINDOWS_PACKAGE_MISMATCH" "$Path does not byte-match '$EntryName' in the pinned official package"
    }
}

function Get-ZipEntryText {
    param([object]$Archive, [string]$EntryName)
    $entry = Get-ZipEntry $Archive $EntryName
    $entryStream = $null
    $reader = $null
    try {
        $entryStream = $entry.Open()
        $reader = [System.IO.StreamReader]::new(
            $entryStream,
            [System.Text.Encoding]::UTF8,
            $true
        )
        return $reader.ReadToEnd()
    } finally {
        if ($null -ne $reader) {
            $reader.Dispose()
        } elseif ($null -ne $entryStream) {
            $entryStream.Dispose()
        }
    }
}

function Assert-UserArtifact {
    param(
        [object]$Artifact,
        [string]$ExpectedSubject,
        [string]$ExpectedCertificateSha256,
        [string]$ExpectedArchitecture
    )
    $path = Resolve-ArtifactPath (Get-RequiredString $Artifact "path")
    Assert-Sha256 $path (Get-RequiredString $Artifact "sha256")
    $subject = Get-RequiredString $Artifact "signerSubject"
    if (-not [string]::Equals($subject, $ExpectedSubject, [System.StringComparison]::Ordinal)) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "manifest signer does not match expectedPublisher"
    }
    Assert-PeArchitecture $path $ExpectedArchitecture
    Assert-Authenticode $path $subject $ExpectedCertificateSha256
    return $path
}

function Assert-KernelDriver {
    param(
        [string]$Path,
        [string]$ExpectedHash,
        [string]$ExpectedSubject,
        [string]$ExpectedCertificateSha256,
        [string]$ExpectedArchitecture
    )
    Assert-Sha256 $Path $ExpectedHash
    Assert-PeArchitecture $Path $ExpectedArchitecture
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        Fail-Gate "WINDOWS_SIGNATURE_INVALID" "Authenticode status for $Path is $($signature.Status)"
    }
    if (
        $null -eq $signature.SignerCertificate -or
        -not [string]::Equals(
            $signature.SignerCertificate.Subject,
            $ExpectedSubject,
            [System.StringComparison]::Ordinal
        )
    ) {
        Fail-Gate "WINDOWS_SIGNER_MISMATCH" "unexpected kernel signer for $Path"
    }
    if ((Get-CertificateSha256 $signature.SignerCertificate) -cne $ExpectedCertificateSha256.ToLowerInvariant()) {
        Fail-Gate "WINDOWS_SIGNER_CERTIFICATE_MISMATCH" "unexpected kernel signer certificate for $Path"
    }
    Invoke-SignTool @("verify", "/kp", "/all", "/v", $Path)
}

function Assert-PinnedString {
    param(
        [object]$Actual,
        [object]$Expected,
        [string]$Label,
        [switch]$IgnoreCase
    )
    if ($Actual -isnot [string] -or $Expected -isnot [string]) {
        Fail-Gate "WINDOWS_RELEASE_POLICY_INVALID" "$Label must be a string in both manifest and policy"
    }
    $comparison = if ($IgnoreCase) {
        [System.StringComparison]::OrdinalIgnoreCase
    } else {
        [System.StringComparison]::Ordinal
    }
    if (-not [string]::Equals($Actual, $Expected, $comparison)) {
        Fail-Gate "WINDOWS_RELEASE_POLICY_MISMATCH" "$Label differs from the committed release policy"
    }
}

function Assert-WinDivertContractShape {
    param([object]$Manifest)
    foreach ($name in @("gitCommit", "buildId")) {
        $value = Get-RequiredProperty $Manifest $name
        if ($value -isnot [string]) {
            Fail-Gate "WINDOWS_MANIFEST_INVALID" "property '$name' must be a string"
        }
    }
    $artifacts = Get-RequiredProperty $Manifest "artifacts"
    foreach ($name in @("application", "helper", "wintun", "applicationProvider")) {
        $null = Get-RequiredProperty $artifacts $name
    }
    foreach ($name in @("application", "helper")) {
        $artifact = Get-RequiredProperty $artifacts $name
        foreach ($field in @("path", "sha256", "signerSubject")) {
            $null = Get-RequiredProperty $artifact $field
        }
    }
    $wintun = Get-RequiredProperty $artifacts "wintun"
    foreach ($field in @(
        "path",
        "version",
        "packagePath",
        "packageUrl",
        "packageSha256",
        "licensePath",
        "sha256",
        "licenseSha256",
        "signerSubject"
    )) {
        $null = Get-RequiredProperty $wintun $field
    }
    $providerArtifact = Get-RequiredProperty $artifacts "applicationProvider"
    $kind = Get-RequiredProperty $providerArtifact "kind"
    if ($kind -isnot [string] -or $kind -cne "windivert") {
        Fail-Gate "WINDOWS_PROVIDER_MISMATCH" "artifacts.applicationProvider.kind must be 'windivert'"
    }
    foreach ($name in @(
        "version",
        "variant",
        "packagePath",
        "packageUrl",
        "packageSha256",
        "userModePath",
        "driverPath",
        "licensePath",
        "userModeSha256",
        "driverSha256",
        "licenseSha256",
        "userModeSignatureMode",
        "userModeSignerSubject",
        "driverSignerSubject"
    )) {
        $null = Get-RequiredProperty $providerArtifact $name
    }
    foreach ($name in @(
        "catalogPath",
        "infPath",
        "catalogSha256",
        "infSha256",
        "signerSubject"
    )) {
        Assert-PropertyAbsent $providerArtifact $name
    }
}

function Assert-PinnedReleasePolicy {
    param([object]$Manifest, [object]$Policy)
    $policySchema = Get-RequiredProperty $Policy "schemaVersion"
    if (($policySchema -isnot [int] -and $policySchema -isnot [long]) -or [long]$policySchema -ne 1) {
        Fail-Gate "WINDOWS_RELEASE_POLICY_INVALID" "release policy schemaVersion must be 1"
    }

    $manifestArchitecture = Get-RequiredProperty $Manifest "architecture"
    $policyArchitecture = Get-RequiredProperty $Policy "architecture"
    Assert-PinnedString $manifestArchitecture $policyArchitecture "architecture"
    $manifestProvider = Get-RequiredProperty $Manifest "applicationCaptureProvider"
    $policyProvider = Get-RequiredProperty $Policy "applicationCaptureProvider"
    Assert-PinnedString $manifestProvider $policyProvider "applicationCaptureProvider"

    $policyFirstParty = Get-RequiredProperty $Policy "firstParty"
    $manifestPublisher = Get-RequiredProperty $Manifest "expectedPublisher"
    $policyPublisher = Get-RequiredProperty $policyFirstParty "publisherSubject"
    Assert-PinnedString $manifestPublisher $policyPublisher "expectedPublisher"

    $artifacts = Get-RequiredProperty $Manifest "artifacts"
    $manifestWintun = Get-RequiredProperty $artifacts "wintun"
    $policyWintun = Get-RequiredProperty $Policy "wintun"
    foreach ($field in @("version", "packageUrl")) {
        $actual = Get-RequiredProperty $manifestWintun $field
        $expected = Get-RequiredProperty $policyWintun $field
        Assert-PinnedString $actual $expected "wintun.$field"
    }
    $actual = Get-RequiredProperty $manifestWintun "packageSha256"
    $expected = Get-RequiredProperty $policyWintun "packageSha256"
    Assert-PinnedString -Actual $actual -Expected $expected -Label "wintun.packageSha256" -IgnoreCase
    $actual = Get-RequiredProperty $manifestWintun "sha256"
    $expected = Get-RequiredProperty $policyWintun "userModeSha256"
    Assert-PinnedString -Actual $actual -Expected $expected -Label "wintun.sha256" -IgnoreCase
    $actual = Get-RequiredProperty $manifestWintun "licenseSha256"
    $expected = Get-RequiredProperty $policyWintun "licenseSha256"
    Assert-PinnedString -Actual $actual -Expected $expected -Label "wintun.licenseSha256" -IgnoreCase

    $manifestWinDivert = Get-RequiredProperty $artifacts "applicationProvider"
    $policyWinDivert = Get-RequiredProperty $Policy "windivert"
    foreach ($field in @(
        "version",
        "variant",
        "packageUrl",
        "userModeSignatureMode",
        "userModeSignerSubject",
        "driverSignerSubject"
    )) {
        $actual = Get-RequiredProperty $manifestWinDivert $field
        $expected = Get-RequiredProperty $policyWinDivert $field
        Assert-PinnedString $actual $expected "windivert.$field"
    }
    foreach ($field in @(
        "packageSha256",
        "userModeSha256",
        "driverSha256",
        "licenseSha256"
    )) {
        $actual = Get-RequiredProperty $manifestWinDivert $field
        $expected = Get-RequiredProperty $policyWinDivert $field
        Assert-PinnedString -Actual $actual -Expected $expected -Label "windivert.$field" -IgnoreCase
    }
}

$resolvedManifest = (Resolve-Path -LiteralPath $ManifestPath).Path
$script:ManifestDirectory = Split-Path -Parent $resolvedManifest
$manifest = Get-Content -Raw -LiteralPath $resolvedManifest | ConvertFrom-Json -Depth 64
$policyCandidate = Join-Path $PSScriptRoot "../../src-tauri/platform/sockscap/windows/release-policy.json"
if (-not (Test-Path -LiteralPath $policyCandidate -PathType Leaf)) {
    Fail-Gate "WINDOWS_RELEASE_POLICY_MISSING" "committed Windows release policy is unavailable"
}
$resolvedPolicy = (Resolve-Path -LiteralPath $policyCandidate).Path
$policySha256 = Get-Sha256 $resolvedPolicy
$policy = Get-Content -Raw -LiteralPath $resolvedPolicy | ConvertFrom-Json -Depth 64

$schemaVersion = Get-RequiredProperty $manifest "schemaVersion"
if (($schemaVersion -isnot [int] -and $schemaVersion -isnot [long]) -or [long]$schemaVersion -ne 2) {
    Fail-Gate "WINDOWS_MANIFEST_INVALID" "schemaVersion must be 2"
}
$enabled = Get-RequiredBoolean $manifest "captureReleaseEnabled"
$architecture = Get-RequiredString $manifest "architecture"
if ($architecture -cne "x86_64") {
    Fail-Gate "WINDOWS_ARCHITECTURE_UNSUPPORTED" "the pinned official WinDivert delivery supports only x86_64"
}
$provider = Get-RequiredString $manifest "applicationCaptureProvider"
if ($provider -cne "windivert") {
    Fail-Gate "WINDOWS_PROVIDER_UNSUPPORTED" "applicationCaptureProvider must be 'windivert'"
}
Assert-WinDivertContractShape $manifest
Assert-PinnedReleasePolicy $manifest $policy

if ($LintOnly) {
    $policyFirstParty = Get-RequiredProperty $policy "firstParty"
    [ordered]@{
        gateSchemaVersion = 1
        gateKind = "sockscap_windows_artifact"
        platform = "windows"
        mode = "lint"
        captureReleaseEnabled = $enabled
        applicationCaptureProvider = $provider
        releasePolicySchemaVersion = [long](Get-RequiredProperty $policy "schemaVersion")
        releasePolicySha256 = $policySha256
        firstPartyConfigurationState = (Get-RequiredProperty $policyFirstParty "configurationState")
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
$gitCommit = Get-RequiredString $manifest "gitCommit"
if ($gitCommit -cnotmatch '^[0-9a-fA-F]{40}$') {
    Fail-Gate "WINDOWS_BUILD_IDENTITY_INVALID" "gitCommit must be a full 40-character commit"
}
$buildId = Get-RequiredString $manifest "buildId"
if ($buildId -cnotmatch '^[A-Za-z0-9._-]{1,128}$') {
    Fail-Gate "WINDOWS_BUILD_IDENTITY_INVALID" "buildId contains unsupported characters"
}

$signToolCommand = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
if ($null -eq $signToolCommand) {
    Fail-Gate "WINDOWS_SIGNTOOL_MISSING" "install the current Windows SDK/WDK and put signtool.exe on PATH"
}
$script:SignTool = $signToolCommand.Source
$policyFirstParty = Get-RequiredProperty $policy "firstParty"
$firstPartyConfigurationState = Get-RequiredString $policyFirstParty "configurationState"
if ($firstPartyConfigurationState -cne "configured") {
    Fail-Gate "WINDOWS_FIRST_PARTY_POLICY_UNCONFIGURED" "set the reviewed publisher subject and signer certificate SHA-256 in release-policy.json before release verification"
}
$expectedPublisher = Get-RequiredString $manifest "expectedPublisher"
$expectedPublisherCertificateSha256 = Get-RequiredString $policyFirstParty "signerCertificateSha256"
if (
    $expectedPublisher -ceq "UNCONFIGURED" -or
    $expectedPublisherCertificateSha256 -cnotmatch '^[0-9a-fA-F]{64}$' -or
    $expectedPublisherCertificateSha256 -cmatch '^0{64}$'
) {
    Fail-Gate "WINDOWS_FIRST_PARTY_POLICY_INVALID" "first-party publisher policy is not a releasable identity"
}
$artifacts = Get-RequiredProperty $manifest "artifacts"
$applicationPath = Assert-UserArtifact (Get-RequiredProperty $artifacts "application") $expectedPublisher $expectedPublisherCertificateSha256 $architecture
$helperPath = Assert-UserArtifact (Get-RequiredProperty $artifacts "helper") $expectedPublisher $expectedPublisherCertificateSha256 $architecture

$wintun = Get-RequiredProperty $artifacts "wintun"
$wintunPath = Resolve-ArtifactPath (Get-RequiredString $wintun "path")
Assert-Sha256 $wintunPath (Get-RequiredString $wintun "sha256")
Assert-PeArchitecture $wintunPath $architecture
$wintunSubject = Get-RequiredString $wintun "signerSubject"
$policyWintun = Get-RequiredProperty $policy "wintun"
$wintunSignerCertificateSha256 = Get-RequiredString $policyWintun "signerCertificateSha256"
Assert-Authenticode $wintunPath $wintunSubject $wintunSignerCertificateSha256
$wintunVersion = Get-RequiredString $wintun "version"
if ($wintunVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    Fail-Gate "WINDOWS_WINTUN_VERSION_INVALID" "Wintun version must be an exact three-part release version"
}
$actualWintunVersion = (Get-Item -LiteralPath $wintunPath).VersionInfo.FileVersion
if ([string]::IsNullOrWhiteSpace($actualWintunVersion) -or $actualWintunVersion -notlike "${wintunVersion}*") {
    Fail-Gate "WINDOWS_WINTUN_VERSION_MISMATCH" "Wintun file version is '$actualWintunVersion', expected '$wintunVersion'"
}
$wintunPackageUrl = Get-RequiredString $wintun "packageUrl"
$expectedWintunPackageUrl = "https://www.wintun.net/builds/wintun-$wintunVersion.zip"
if (-not [string]::Equals($wintunPackageUrl, $expectedWintunPackageUrl, [System.StringComparison]::Ordinal)) {
    Fail-Gate "WINDOWS_WINTUN_PACKAGE_URL_INVALID" "Wintun packageUrl must be '$expectedWintunPackageUrl'"
}
$wintunPackagePath = Resolve-ArtifactPath (Get-RequiredString $wintun "packagePath")
$wintunPackageSha256 = Get-RequiredString $wintun "packageSha256"
Assert-Sha256 $wintunPackagePath $wintunPackageSha256
$wintunLicensePath = Resolve-ArtifactPath (Get-RequiredString $wintun "licensePath")
Assert-Sha256 $wintunLicensePath (Get-RequiredString $wintun "licenseSha256")
$wintunArchive = $null
try {
    $wintunArchive = [System.IO.Compression.ZipFile]::OpenRead($wintunPackagePath)
    Assert-FileMatchesZipEntry $wintunPath $wintunArchive "wintun/bin/amd64/wintun.dll"
    Assert-FileMatchesZipEntry $wintunLicensePath $wintunArchive "wintun/LICENSE.txt"
} catch [System.IO.InvalidDataException] {
    Fail-Gate "WINDOWS_WINTUN_PACKAGE_INVALID" "Wintun package is not a valid ZIP archive: $($_.Exception.Message)"
} finally {
    if ($null -ne $wintunArchive) {
        $wintunArchive.Dispose()
    }
}

$providerArtifact = Get-RequiredProperty $artifacts "applicationProvider"
$providerUserPath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "userModePath")
$providerDriverPath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "driverPath")
$winDivertVersion = Get-RequiredString $providerArtifact "version"
if ($winDivertVersion -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)$') {
    Fail-Gate "WINDOWS_WINDIVERT_VERSION_INVALID" "WinDivert version must be an exact three-part release version"
}
$winDivertApiVersion = "$($Matches[1]).$($Matches[2])"
$winDivertVariant = Get-RequiredString $providerArtifact "variant"
if ($winDivertVariant -cnotin @("A", "B", "C")) {
    Fail-Gate "WINDOWS_WINDIVERT_VARIANT_INVALID" "WinDivert variant must be exactly A, B, or C"
}
$winDivertPackageUrl = Get-RequiredString $providerArtifact "packageUrl"
$expectedPackageUrl = "https://reqrypt.org/download/WinDivert-$winDivertVersion-$winDivertVariant.zip"
if (-not [string]::Equals($winDivertPackageUrl, $expectedPackageUrl, [System.StringComparison]::Ordinal)) {
    Fail-Gate "WINDOWS_WINDIVERT_PACKAGE_URL_INVALID" "WinDivert packageUrl must be '$expectedPackageUrl'"
}
$winDivertPackagePath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "packagePath")
$winDivertPackageSha256 = Get-RequiredString $providerArtifact "packageSha256"
Assert-Sha256 $winDivertPackagePath $winDivertPackageSha256
$providerUserSignatureMode = Get-RequiredString $providerArtifact "userModeSignatureMode"
if ($providerUserSignatureMode -cne "unsigned_official") {
    Fail-Gate "WINDOWS_WINDIVERT_DLL_SIGNATURE_MODE_INVALID" "WinDivert userModeSignatureMode must be 'unsigned_official'"
}
$providerUserSubjectValue = Get-RequiredProperty $providerArtifact "userModeSignerSubject"
if ($providerUserSubjectValue -isnot [string] -or $providerUserSubjectValue.Length -ne 0) {
    Fail-Gate "WINDOWS_WINDIVERT_DLL_SIGNER_INVALID" "userModeSignerSubject must be empty when userModeSignatureMode is 'unsigned_official'"
}
$providerDriverSubject = Get-RequiredString $providerArtifact "driverSignerSubject"
$policyWinDivert = Get-RequiredProperty $policy "windivert"
$providerDriverCertificateSha256 = Get-RequiredString $policyWinDivert "driverSignerCertificateSha256"
Assert-Sha256 $providerUserPath (Get-RequiredString $providerArtifact "userModeSha256")
Assert-PeArchitecture $providerUserPath $architecture
Assert-UnsignedAuthenticode $providerUserPath
Assert-KernelDriver `
    $providerDriverPath `
    (Get-RequiredString $providerArtifact "driverSha256") `
    $providerDriverSubject `
    $providerDriverCertificateSha256 `
    $architecture
$driverFileVersion = (Get-Item -LiteralPath $providerDriverPath).VersionInfo.FileVersion
if (
    [string]::IsNullOrWhiteSpace($driverFileVersion) -or
    $driverFileVersion -notmatch "^$([regex]::Escape($winDivertApiVersion))(?:\.|$)"
) {
    Fail-Gate "WINDOWS_WINDIVERT_VERSION_MISMATCH" "WinDivert driver file version is '$driverFileVersion'; expected API version '$winDivertApiVersion' from release '$winDivertVersion'"
}
$licensePath = Resolve-ArtifactPath (Get-RequiredString $providerArtifact "licensePath")
Assert-Sha256 $licensePath (Get-RequiredString $providerArtifact "licenseSha256")
if ((Get-Item -LiteralPath $licensePath).Length -eq 0) {
    Fail-Gate "WINDOWS_LICENSE_MISSING" "WinDivert license file is empty"
}
$archive = $null
try {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($winDivertPackagePath)
    $packageRoot = "WinDivert-$winDivertVersion-$winDivertVariant"
    Assert-FileMatchesZipEntry $providerUserPath $archive "$packageRoot/x64/WinDivert.dll"
    Assert-FileMatchesZipEntry $providerDriverPath $archive "$packageRoot/x64/WinDivert64.sys"
    Assert-FileMatchesZipEntry $licensePath $archive "$packageRoot/LICENSE"
    $packagedVersion = (Get-ZipEntryText $archive "$packageRoot/VERSION").Trim()
    if (-not [string]::Equals($packagedVersion, $winDivertVersion, [System.StringComparison]::Ordinal)) {
        Fail-Gate "WINDOWS_WINDIVERT_VERSION_MISMATCH" "official package VERSION is '$packagedVersion'; expected '$winDivertVersion'"
    }
} catch [System.IO.InvalidDataException] {
    Fail-Gate "WINDOWS_WINDIVERT_PACKAGE_INVALID" "WinDivert package is not a valid ZIP archive: $($_.Exception.Message)"
} finally {
    if ($null -ne $archive) {
        $archive.Dispose()
    }
}

[ordered]@{
    gateSchemaVersion = 1
    gateKind = "sockscap_windows_artifact"
    platform = "windows"
    mode = "release"
    architecture = $architecture
    gitCommit = $gitCommit.ToLowerInvariant()
    buildId = $buildId
    applicationCaptureProvider = $provider
    artifactManifestSha256 = (Get-Sha256 $resolvedManifest)
    releasePolicySchemaVersion = [long](Get-RequiredProperty $policy "schemaVersion")
    releasePolicySha256 = $policySha256
    application = $applicationPath
    applicationSha256 = (Get-Sha256 $applicationPath)
    applicationSignerSubject = $expectedPublisher
    applicationSignerCertificateSha256 = $expectedPublisherCertificateSha256.ToLowerInvariant()
    helper = $helperPath
    helperSha256 = (Get-Sha256 $helperPath)
    helperSignerSubject = $expectedPublisher
    helperSignerCertificateSha256 = $expectedPublisherCertificateSha256.ToLowerInvariant()
    wintun = [ordered]@{
        version = $wintunVersion
        package = $wintunPackagePath
        packageUrl = $wintunPackageUrl
        packageSha256 = $wintunPackageSha256.ToLowerInvariant()
        userMode = $wintunPath
        userModeSha256 = (Get-Sha256 $wintunPath)
        license = $wintunLicensePath
        licenseSha256 = (Get-Sha256 $wintunLicensePath)
        signerSubject = $wintunSubject
        signerCertificateSha256 = $wintunSignerCertificateSha256
    }
    windivert = [ordered]@{
        version = $winDivertVersion
        variant = $winDivertVariant
        package = $winDivertPackagePath
        packageUrl = $winDivertPackageUrl
        packageSha256 = $winDivertPackageSha256.ToLowerInvariant()
        userMode = $providerUserPath
        userModeSha256 = (Get-Sha256 $providerUserPath)
        driver = $providerDriverPath
        driverSha256 = (Get-Sha256 $providerDriverPath)
        license = $licensePath
        licenseSha256 = (Get-Sha256 $licensePath)
        userModeSignatureMode = $providerUserSignatureMode
        userModeSignerSubject = ""
        driverSignerSubject = $providerDriverSubject
        driverSignerCertificateSha256 = $providerDriverCertificateSha256
    }
    result = "PASS"
} | ConvertTo-Json -Compress
