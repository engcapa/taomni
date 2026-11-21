param(
    [Parameter(Mandatory = $true)][int]$OwnerId,
    [Parameter(Mandatory = $true)][ValidateSet('seed', 'before', 'after')][string]$Phase
)

$ErrorActionPreference = 'Stop'
trap {
    $failure = $_.Exception.GetBaseException()
    $diagnostic = [pscustomobject]@{
        exception = $failure.GetType().FullName
        hresult = $failure.HResult
        line = $_.InvocationInfo.ScriptLineNumber
    }
    [Console]::Error.WriteLine(($diagnostic | ConvertTo-Json -Compress))
    exit 1
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$automation = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]::Descendants
$types = [System.Windows.Automation.ControlType]
$clock = [Diagnostics.Stopwatch]::StartNew()

function Wait-Element([scriptblock]$Find, [string]$Description) {
    $end = [Math]::Min($clock.Elapsed.TotalSeconds + 25, 75)
    do {
        try {
            $element = & $Find
            if ($null -ne $element) { return ,$element }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            # React can replace an element while UI Automation resolves it.
        }
        if ((Get-Process -Id $OwnerId).HasExited) { throw 'The installed Taomni process exited' }
        Start-Sleep -Milliseconds 150
    } while ($clock.Elapsed.TotalSeconds -lt $end)
    throw "Timed out waiting for $Description in the installed Taomni window"
}

function Find-Control($Root, $Type, [string]$Name) {
    $condition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new($automation::NameProperty, $Name),
        [System.Windows.Automation.PropertyCondition]::new($automation::ControlTypeProperty, $Type),
        [System.Windows.Automation.PropertyCondition]::new($automation::IsOffscreenProperty, $false)
    ))
    foreach ($item in $Root.FindAll($scope, $condition)) {
        if ($item.Current.IsEnabled) { return $item }
    }
}

function Invoke-Button($Root, [string]$Name) {
    $button = Wait-Element { Find-Control $Root $types::Button $Name } $Name
    [object]$pattern = $null
    if ($button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        return
    }
    $button.SetFocus()
    if (-not $button.Current.HasKeyboardFocus) { throw 'The owned button did not receive keyboard focus' }
    [System.Windows.Forms.SendKeys]::SendWait(' ')
}

function Set-Value($Element, [string]$Value) {
    $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($Value)
}

function Find-Passwords([int]$Count) {
    $condition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new($automation::IsPasswordProperty, $true),
        [System.Windows.Automation.PropertyCondition]::new($automation::IsOffscreenProperty, $false)
    ))
    $fields = @($window.FindAll($scope, $condition) | Sort-Object { $_.Current.BoundingRectangle.Y })
    if ($fields.Length -eq $Count) { return ,$fields }
}

function Read-Code([string]$Expected) {
    [System.Windows.Forms.Clipboard]::Clear()
    Invoke-Button $window "Copy code for $($fixture.issuer)"
    Wait-Element {
        $actual = [System.Windows.Forms.Clipboard]::GetText()
        if ($actual -ceq $Expected) { return $actual }
    } "HOTP clipboard value $Expected"
}

$window = Wait-Element {
    $process = Get-Process -Id $OwnerId
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        $element = $automation::FromHandle($process.MainWindowHandle)
        if ($element.Current.ProcessId -eq $OwnerId) { return $element }
    }
} 'the owned top-level window'

if ($Phase -ne 'seed') {
    $fields = Wait-Element { Find-Passwords 1 } 'the vault unlock field'
    Set-Value $fields[0] $fixture.password
    Invoke-Button $window 'Unlock'
}
Invoke-Button $window 'Tools'
Invoke-Button $window 'MFA authenticator'

$codes = @()
if ($Phase -eq 'seed') {
    $fields = Wait-Element { Find-Passwords 2 } 'the vault password and confirmation fields'
    Set-Value $fields[0] $fixture.password
    Set-Value $fields[1] $fixture.password
    Invoke-Button $window 'Create vault'
    Invoke-Button $window 'Add MFA account'
    $uri = Wait-Element { Find-Control $window $types::Edit 'otpauth link' } 'the otpauth field'
    Set-Value $uri $fixture.uri
    Invoke-Button $window 'Add account'
    $codes += Read-Code '755224'
} else {
    $codes += Read-Code '287082'
}
if ($Phase -ne 'before') {
    Invoke-Button $window "Generate the next code for $($fixture.issuer)"
    $codes += Read-Code $(if ($Phase -eq 'seed') { '287082' } else { '359152' })
}
[System.Windows.Forms.Clipboard]::Clear()
[pscustomobject]@{ phase = $Phase; ownerPid = $OwnerId; codes = $codes } | ConvertTo-Json -Compress
