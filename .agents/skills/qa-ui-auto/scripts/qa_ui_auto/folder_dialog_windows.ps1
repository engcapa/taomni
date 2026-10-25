$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class QaFolderDialog {
    public delegate bool Enumerate(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr owner, Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SetWindowText(IntPtr window, string text);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    public static string Text(IntPtr window) {
        var value = new StringBuilder(32768); GetWindowText(window, value, value.Capacity); return value.ToString();
    }
    public static string Class(IntPtr window) {
        var value = new StringBuilder(256); GetClassName(window, value, value.Capacity); return value.ToString();
    }
    public static int Process(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return (int)pid; }
    public static IntPtr[] Windows(IntPtr owner) {
        var found = new List<IntPtr>();
        Enumerate collect = (window, data) => { found.Add(window); return true; };
        if (owner == IntPtr.Zero) EnumWindows(collect, IntPtr.Zero); else EnumChildWindows(owner, collect, IntPtr.Zero);
        return found.ToArray();
    }
}
"@
$applicationPath = [System.IO.Path]::GetFullPath($env:QA_PICKER_APPLICATION)
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = [IntPtr]::Zero
do {
    # UIA can expose only the Explorer child of Common Item Dialog. Resolve
    # the actual top-level #32770 HWND before looking up its native controls.
    $owned = @([QaFolderDialog]::Windows([IntPtr]::Zero) | Where-Object {
        if (-not [QaFolderDialog]::IsWindowVisible($_) -or [QaFolderDialog]::Class($_) -ne "#32770") { return $false }
        $owner = Get-Process -Id ([QaFolderDialog]::Process($_)) -ErrorAction SilentlyContinue
        $owner -and $owner.Path -and [System.IO.Path]::GetFullPath($owner.Path) -eq $applicationPath -and
            [QaFolderDialog]::Text($_) -eq $env:QA_PICKER_TITLE
    })
    if ($owned.Count -eq 1) { $dialog = $owned[0]; break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if ($dialog -eq [IntPtr]::Zero) { throw "No unique Common Item Dialog owned by the QA executable" }
$pidObserved = [QaFolderDialog]::Process($dialog)
function Chooser-Open {
    [QaFolderDialog]::IsWindow($dialog) -and [QaFolderDialog]::IsWindowVisible($dialog)
}
function Control([int] $id, [string] $class) {
    $found = @([QaFolderDialog]::Windows($dialog) | Where-Object {
        [QaFolderDialog]::GetDlgCtrlID($_) -eq $id -and [QaFolderDialog]::Class($_) -eq $class -and
            [QaFolderDialog]::IsWindowVisible($_)
    })
    if ($found.Count -ne 1) {
        $details = ([QaFolderDialog]::Windows($dialog) | ForEach-Object {
            "id=$([QaFolderDialog]::GetDlgCtrlID($_)),class=$([QaFolderDialog]::Class($_)),text=$([QaFolderDialog]::Text($_))"
        }) -join '; '
        throw "Chooser control $id/$class is not unique: $details"
    }
    return $found[0]
}
function Invoke-Control([int] $id) {
    $button = Control $id "Button"
    if (-not [QaFolderDialog]::IsWindowEnabled($button)) { return $false }
    # BM_CLICK operates the real native button. Post once, then observe the
    # dialog: no keyboard fallback can leak Enter into the app's Add modal.
    if (-not [QaFolderDialog]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw "Chooser button $id could not receive BM_CLICK"
    }
    [Console]::Error.WriteLine("Chooser button {0}: {1}", $id, [QaFolderDialog]::Text($button))
    return $true
}
[Console]::Error.WriteLine("Owned chooser HWND={0}, pid={1}, title={2}", $dialog, $pidObserved, [QaFolderDialog]::Text($dialog))
if ($env:QA_PICKER_ACTION -eq "cancel") {
    if (-not (Invoke-Control 2)) { throw "Chooser Cancel is disabled" }
} else {
    # 1152 is Common Item Dialog's filename/folder field. Never type into the
    # last UIA Edit: that is the Search box on Windows 2025.
    $edit = Control 1152 "Edit"
    if (-not [QaFolderDialog]::SetWindowText($edit, $env:QA_PICKER_PATH) -or
        [QaFolderDialog]::Text($edit) -ne $env:QA_PICKER_PATH) { throw "Folder path was not entered completely" }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $invoked = $false
    do {
        if (-not (Chooser-Open)) { throw "Chooser closed before accepting the path" }
        $invoked = Invoke-Control 1
        if ($invoked) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $invoked) { throw "Chooser Open is disabled" }
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ((Chooser-Open) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
if (Chooser-Open) { throw "Folder chooser did not close" }
@{transport="Windows Common Item Dialog controls"; window=$dialog.ToInt64(); pid=$pidObserved; application=$env:QA_PICKER_APPLICATION} | ConvertTo-Json -Compress
