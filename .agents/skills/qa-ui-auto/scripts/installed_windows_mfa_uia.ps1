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

function Find-Control($Root, $Type, [string]$Name, [scriptblock]$Accept = { $true }) {
    $condition = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]@(
        [System.Windows.Automation.PropertyCondition]::new($automation::NameProperty, $Name),
        [System.Windows.Automation.PropertyCondition]::new($automation::ControlTypeProperty, $Type),
        [System.Windows.Automation.PropertyCondition]::new($automation::IsOffscreenProperty, $false)
    ))
    foreach ($item in $Root.FindAll($scope, $condition)) {
        if ($item.Current.IsEnabled -and (& $Accept $item)) { return $item }
    }
}

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
    $sessions = Find-Control $window $types::Button 'Sessions'
    if ($null -eq $sessions) { return }
    $anchor = $sessions.Current.BoundingRectangle
    Find-Control $window $types::Button 'Tools' {
        param($candidate)
        $row = $candidate.Current.BoundingRectangle
        return (-not $row.IsEmpty -and -not $anchor.IsEmpty -and
            [Math]::Abs($row.Left - $anchor.Left) -lt 2 -and
            [Math]::Abs($row.Right - $anchor.Right) -lt 2 -and
            $row.Top -ge $anchor.Bottom -and $row.Top -lt $anchor.Bottom + 12)
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
