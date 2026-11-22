param(
    [Parameter(Mandatory = $true)][int]$OwnerId,
    [Parameter(Mandatory = $true)][ValidateSet('seed', 'before', 'after')][string]$Phase
)

$ErrorActionPreference = 'Stop'
$script:diagnosticStage = 'initialization'
trap {
    $failure = $_.Exception.GetBaseException()
    $diagnostic = [pscustomobject]@{
        exception = $failure.GetType().FullName
        hresult = $failure.HResult
        line = $_.InvocationInfo.ScriptLineNumber
        stage = $script:diagnosticStage
    }
    if ($null -ne $window) {
        $diagnostic | Add-Member -NotePropertyName windowHandle -NotePropertyValue ($windowHandle.ToInt64())
        try {
            $diagnostic | Add-Member -NotePropertyName controls -NotePropertyValue (Observe-Controls)
        } catch {
            # The HWND can disappear while handling an application exit.
        }
    }
    [Console]::Error.WriteLine(($diagnostic | ConvertTo-Json -Compress))
    exit 1
}
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
. (Join-Path $PSScriptRoot "installed_windows_uia_common.ps1")

function Find-ToolsMfa {
    # The rail's floating MFA toggle has the same accessible name. Match the
    # Tools list row by its position and alignment with the adjacent list row.
    $networkTools = Find-Control $window $types::Button 'Network tools'
    if ($null -eq $networkTools) { return }
    $neighbor = $networkTools.Current.BoundingRectangle
    Find-Control $window $types::Button 'MFA authenticator' {
        param($candidate)
        $row = $candidate.Current.BoundingRectangle
        return (-not $row.IsEmpty -and -not $neighbor.IsEmpty -and
            [Math]::Abs($row.Left - $neighbor.Left) -lt 2 -and
            [Math]::Abs($row.Right - $neighbor.Right) -lt 2 -and
            [Math]::Abs($row.Bottom - $neighbor.Top) -lt 2)
    }
}

function Find-ToolsRail {
    $anchors = @('File Explorer', 'Sessions' | ForEach-Object {
        $control = Find-Control $window $types::Button $_
        if ($null -ne $control) { $control.Current.BoundingRectangle }
    })
    Find-Control $window $types::Button 'Tools' {
        param($candidate)
        $row = $candidate.Current.BoundingRectangle
        foreach ($anchor in $anchors) {
            if (-not $row.IsEmpty -and -not $anchor.IsEmpty -and
                [Math]::Abs($row.Left - $anchor.Left) -lt 2 -and
                [Math]::Abs($row.Right - $anchor.Right) -lt 2 -and
                $row.Top -ge $anchor.Bottom -and $row.Top -lt $anchor.Bottom + 12) {
                return $true
            }
        }
        return $false
    }
}

function Observe-Controls {
    return [pscustomobject]@{
        visiblePasswordFields = @(Get-VisiblePasswords).Count
        mfaActionVisible = ($null -ne (Find-ToolsMfa))
        addAccountVisible = ($null -ne (Find-Control $window $types::Button 'Add MFA account'))
    }
}

function Read-Code([string]$Expected) {
    [System.Windows.Forms.Clipboard]::Clear()
    $button = Wait-Element { Find-Control $window $types::Button "Copy code for $($fixture.issuer)" } 'copy-hotp'
    Click-Element $button
    $retry = [Diagnostics.Stopwatch]::StartNew()
    Wait-Element {
        try {
            $actual = [System.Windows.Forms.Clipboard]::GetText()
        } catch [System.Runtime.InteropServices.ExternalException] {
            return
        }
        if ($actual -ceq $Expected) { return $actual }
        if ($retry.Elapsed.TotalSeconds -ge 1) {
            $current = Find-Control $window $types::Button "Copy code for $($fixture.issuer)"
            if ($null -ne $current) { Click-Element $current }
            $retry.Restart()
        }
    } 'read-hotp'
}

if ($Phase -ne 'seed') {
    $fields = Wait-Element { Find-Passwords 1 } 'vault-unlock-field'
    Set-Value $fields[0] $fixture.password
    Invoke-Button $window 'Unlock' 'unlock-vault' -Physical
    $null = Wait-Element { if (@(Get-VisiblePasswords).Count -eq 0) { return $true } } 'unlock-vault'
}
if ($null -eq (Find-ToolsMfa)) {
    Click-Element (Wait-Element { Find-ToolsRail } 'open-tools')
}
Click-Element (Wait-Element { Find-ToolsMfa } 'open-mfa')

$codes = @()
if ($Phase -eq 'seed') {
    $fields = Wait-Element { Find-Passwords 2 } 'vault-setup-fields'
    Set-Value $fields[0] $fixture.password
    Set-Value $fields[1] $fixture.password
    Invoke-Button $window 'Create vault' 'create-vault'
    Invoke-Button $window 'Add MFA account' 'open-add-account'
    $uri = Wait-Element { Find-Control $window $types::Edit 'otpauth link' } 'otpauth-field'
    Set-Value $uri $fixture.uri
    Invoke-Button $window 'Add account' 'save-account'
    $codes += Read-Code '755224'
} else {
    $codes += Read-Code '287082'
}
if ($Phase -ne 'before') {
    Invoke-Button $window "Generate the next code for $($fixture.issuer)" 'advance-hotp' -Physical
    $codes += Read-Code $(if ($Phase -eq 'seed') { '287082' } else { '359152' })
}
[System.Windows.Forms.Clipboard]::Clear()
[pscustomobject]@{ phase = $Phase; ownerPid = $OwnerId; codes = $codes } | ConvertTo-Json -Compress
