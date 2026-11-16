param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('host', 'security')]
    [string]$Operation
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($Operation -eq 'host') {
    # Paths are data, never interpolated into a PowerShell program.
    $target = Get-Item -LiteralPath $env:TAOMNI_OBSERVED_MODULE_HOST
    $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
    $zone = $null
    if (Get-Item -LiteralPath $target.FullName -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue) {
        $zone = Get-Content -LiteralPath $target.FullName -Stream 'Zone.Identifier' -Raw
    }
    [ordered]@{
        path = $target.FullName
        zoneIdentifier = $zone
        authenticodeStatus = $signature.Status.ToString()
        statusMessage = $signature.StatusMessage
        signatureType = $signature.SignatureType.ToString()
        signerSubject = $signature.SignerCertificate.Subject
        signerThumbprint = $signature.SignerCertificate.Thumbprint
    } | ConvertTo-Json -Compress
    exit 0
}

# This observes the runner's actual protection configuration. It never changes
# Defender, SmartScreen, execution policy, certificate stores or exclusions.
$defender = [ordered]@{ available = $false }
try {
    $status = Get-MpComputerStatus
    if ($null -eq $status) {
        throw 'Get-MpComputerStatus returned no protection status'
    }
    $defender = [ordered]@{
        available = $true
        amServiceEnabled = $status.AMServiceEnabled
        antivirusEnabled = $status.AntivirusEnabled
        realTimeProtectionEnabled = $status.RealTimeProtectionEnabled
        behaviorMonitorEnabled = $status.BehaviorMonitorEnabled
        ioavProtectionEnabled = $status.IoavProtectionEnabled
        antivirusSignatureVersion = $status.AntivirusSignatureVersion
    }
} catch {
    $defender['error'] = $_.Exception.Message
}
$smartScreen = [ordered]@{}
foreach ($entry in @(
    @{ name = 'machinePolicy'; path = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System'; property = 'EnableSmartScreen' },
    @{ name = 'machineExplorer'; path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer'; property = 'SmartScreenEnabled' },
    @{ name = 'userPolicy'; path = 'HKCU:\SOFTWARE\Policies\Microsoft\Windows\System'; property = 'EnableSmartScreen' }
)) {
    try {
        $value = Get-ItemPropertyValue -LiteralPath $entry.path -Name $entry.property
        $smartScreen[$entry.name] = @{ available = $true; value = $value }
    } catch {
        $smartScreen[$entry.name] = @{ available = $false; error = $_.Exception.Message }
    }
}
[ordered]@{ defender = $defender; smartScreenConfiguration = $smartScreen } | ConvertTo-Json -Depth 6 -Compress
