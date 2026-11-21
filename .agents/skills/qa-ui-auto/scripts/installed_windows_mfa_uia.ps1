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
        try {
            $diagnostic | Add-Member -NotePropertyName controls -NotePropertyValue (Observe-Controls)
        } catch {
            # The HWND can disappear while handling an application exit.
        }
    }
    [Console]::Error.WriteLine(($diagnostic | ConvertTo-Json -Compress))
    exit 1
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, WindowsBase
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OwnedDesktopClick {
    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int X; public int Y; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);

    public static void Click(IntPtr window, int x, int y) {
        var dpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try {
            SetForegroundWindow(window);
            var point = new Point { X = x, Y = y };
            if (GetAncestor(WindowFromPoint(point), 2) != window)
                throw new InvalidOperationException("The hit point is outside the owned application window");
            if (!SetCursorPos(x, y)) throw new Win32Exception(Marshal.GetLastWin32Error());
            mouse_event(2, 0, 0, 0, UIntPtr.Zero);
            mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        } finally {
            if (dpi != IntPtr.Zero) SetThreadDpiAwarenessContext(dpi);
        }
    }

    public static bool IsForeground(IntPtr window) { return GetForegroundWindow() == window; }
}
'@
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$automation = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]::Descendants
$types = [System.Windows.Automation.ControlType]
$clock = [Diagnostics.Stopwatch]::StartNew()

function Wait-Element([scriptblock]$Find, [string]$Stage) {
    $script:diagnosticStage = $Stage
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
    throw "Timed out waiting for $Stage in the installed Taomni window"
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

function Click-Element($Element) {
    $rect = $Element.Current.BoundingRectangle
    if ($rect.IsEmpty) { throw 'The owned control has no visible rectangle' }
    [OwnedDesktopClick]::Click($windowHandle,
        [int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
}

function Invoke-Button($Root, [string]$Name, [string]$Stage, [switch]$Physical) {
    $button = Wait-Element { Find-Control $Root $types::Button $Name } $Stage
    [object]$pattern = $null
    if (-not $Physical -and $button.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
        return
    }
    Click-Element $button
}

function Set-Value($Element, [string]$Value) {
    [object]$pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $pattern.SetValue($Value)
        return
    }
    Click-Element $Element
    if (-not [OwnedDesktopClick]::IsForeground($windowHandle)) { throw 'The owned text control did not receive foreground focus' }
    [System.Windows.Forms.Clipboard]::SetText($Value)
    try {
        [System.Windows.Forms.SendKeys]::SendWait('^a^v')
    } finally {
        [System.Windows.Forms.Clipboard]::Clear()
    }
}

function Get-VisiblePasswords {
    $condition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new($automation::IsPasswordProperty, $true),
        [System.Windows.Automation.PropertyCondition]::new($automation::IsOffscreenProperty, $false)
    ))
    return $window.FindAll($scope, $condition) | Sort-Object { $_.Current.BoundingRectangle.Y }
}

function Find-Passwords([int]$Count) {
    $fields = @(Get-VisiblePasswords)
    if ($fields.Length -eq $Count) { return ,$fields }
}

function Observe-Controls {
    return [pscustomobject]@{
        visiblePasswordFields = @(Get-VisiblePasswords).Count
        mfaActionVisible = ($null -ne (Find-Control $window $types::Button 'MFA authenticator'))
        addAccountVisible = ($null -ne (Find-Control $window $types::Button 'Add MFA account'))
    }
}

function Read-Code([string]$Expected) {
    [System.Windows.Forms.Clipboard]::Clear()
    Invoke-Button $window "Copy code for $($fixture.issuer)" 'copy-hotp'
    Wait-Element {
        $actual = [System.Windows.Forms.Clipboard]::GetText()
        if ($actual -ceq $Expected) { return $actual }
    } 'read-hotp'
}

$windowHandle = Wait-Element {
    $process = Get-Process -Id $OwnerId
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        $element = $automation::FromHandle($process.MainWindowHandle)
        if ($element.Current.ProcessId -eq $OwnerId) { return $process.MainWindowHandle }
    }
} 'owned-window'
$window = $automation::FromHandle($windowHandle)

if ($Phase -ne 'seed') {
    $fields = Wait-Element { Find-Passwords 1 } 'vault-unlock-field'
    Set-Value $fields[0] $fixture.password
    Invoke-Button $window 'Unlock' 'unlock-vault'
}
if (-not (Find-Control $window $types::Button 'MFA authenticator')) {
    Invoke-Button $window 'Tools' 'open-tools' -Physical
}
Invoke-Button $window 'MFA authenticator' 'open-mfa' -Physical

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
    Invoke-Button $window "Generate the next code for $($fixture.issuer)" 'advance-hotp'
    $codes += Read-Code $(if ($Phase -eq 'seed') { '287082' } else { '359152' })
}
[System.Windows.Forms.Clipboard]::Clear()
[pscustomobject]@{ phase = $Phase; ownerPid = $OwnerId; codes = $codes } | ConvertTo-Json -Compress
