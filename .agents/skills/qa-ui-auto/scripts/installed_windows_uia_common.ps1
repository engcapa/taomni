# UI Automation for the window of one installed executable on the Windows runner.
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

$windowHandle = Wait-Element {
    $process = Get-Process -Id $OwnerId
    if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
        $element = $automation::FromHandle($process.MainWindowHandle)
        if ($element.Current.ProcessId -eq $OwnerId) { return $process.MainWindowHandle }
    }
} 'owned-window'
$window = $automation::FromHandle($windowHandle)

