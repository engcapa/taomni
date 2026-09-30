# Drive a running desktop DB client (default DbVisualizer) for reference capture. Windows only;
# run under Windows PowerShell 5.1 (WinRT OCR):
#   powershell.exe -NoProfile -File .agents/skills/db-client-parity/scripts/desktop_ui.ps1 -Action activate
#   ... -Action shot -Out <dir>/<step> [-L -T -W -H] [-Scale 3]   # screen region -> .png + .ocr.txt (screen coords)
#   ... -Action click|rclick|dclick -X <x> -Y <y>
#   ... -Action keys -Keys "^{ENTER}"                              # SendKeys syntax; letters/control keys only
#   ... -Action move -L 0 -T 0 -W 1920 -H 1040                     # resize/move the main window
#   ... -Action type -Text "<text>"                                # clipboard paste (Ctrl+A, Ctrl+V), clipboard restored
# Every input verifies that the foreground window belongs to the target process and aborts otherwise.
# Screenshots can contain user data: keep them under gitignored qa-ui-auto-report/.
param([ValidateSet('activate','shot','click','rclick','dclick','keys','type','state','title','move')][string]$Action,
      [string]$Out, [int]$X, [int]$Y, [string]$Keys, [string]$Text, [int]$WaitMs = 700,
      [int]$L = 0, [int]$T = 0, [int]$W = 0, [int]$H = 0, [int]$Scale = 2, [string]$ProcessName = 'dbvis')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System; using System.Runtime.InteropServices;
public class U {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
 [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, IntPtr e);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
 public struct RECT { public int L, T, R, B; }
 // Largest visible titled top-level window of the process (MainWindowHandle can point at a tooltip).
 public static IntPtr MainOf(uint pid) {
  IntPtr best = IntPtr.Zero; long area = -1;
  EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
   if (p == pid && IsWindowVisible(h)) { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512);
    RECT r; GetWindowRect(h, out r); long a = (long)(r.R - r.L) * (r.B - r.T);
    if (sb.Length > 0 && a > area) { area = a; best = h; } } return true; }, IntPtr.Zero);
  return best; }
 public static string TitleOf(IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
"@
$proc = Get-Process -Name $ProcessName | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$main = [U]::MainOf([uint32]$proc.Id); if ($main -eq [IntPtr]::Zero) { $main = $proc.MainWindowHandle }
function FgPid { $p = 0; [U]::GetWindowThreadProcessId([U]::GetForegroundWindow(), [ref]$p) | Out-Null; $p }
function Ensure {
  if ((FgPid) -ne $proc.Id) { throw "Foreground window is not $ProcessName (pid $(FgPid)); input aborted" }
}
function Ocr([string]$png) {
  $src = [System.Drawing.Bitmap]::FromFile($png); $s = $Scale
  $big = New-Object System.Drawing.Bitmap ($src.Width * $s), ($src.Height * $s)
  $g = [System.Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'HighQualityBicubic'
  $g.DrawImage($src, 0, 0, $big.Width, $big.Height); $g.Dispose(); $src.Dispose()
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("ocr-" + [guid]::NewGuid() + ".png"); $big.Save($tmp); $big.Dispose()
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
  $res = Await ($eng.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $rows = foreach ($l in $res.Lines) { $b = @($l.Words)[0].BoundingRect; [pscustomobject]@{ X = [int]($b.X / $s) + $script:ox; Y = [int]($b.Y / $s) + $script:oy; Text = $l.Text } }
  $stream.Dispose(); Remove-Item $tmp -ErrorAction SilentlyContinue
  $rows | Sort-Object { [int]($_.Y / 6) }, X | ForEach-Object { "{0,5} {1,5}  {2}" -f $_.X, $_.Y, $_.Text }
}
switch ($Action) {
  'activate' {
    if ([U]::IsIconic($main)) { [U]::ShowWindow($main, 9) | Out-Null }
    [U]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [U]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [U]::SetForegroundWindow($main) | Out-Null; Start-Sleep -Milliseconds $WaitMs
    "foreground-is-target=$((FgPid) -eq $proc.Id)"
  }
  'title' { [U]::TitleOf($main) }
  'move' { [U]::ShowWindow($main, 9) | Out-Null; [U]::SetWindowPos($main, [IntPtr]::Zero, $L, $T, $W, $H, 0x0044) | Out-Null; Start-Sleep -Milliseconds $WaitMs; $r = New-Object U+RECT; [U]::GetWindowRect($main, [ref]$r) | Out-Null; "rect=$($r.L),$($r.T),$($r.R),$($r.B)" }
  'state' { $r = New-Object U+RECT; [U]::GetWindowRect($main, [ref]$r) | Out-Null; "rect=$($r.L),$($r.T),$($r.R),$($r.B) fg-target=$((FgPid) -eq $proc.Id) title=$([U]::TitleOf($main))" }
  'shot' {
    $r = New-Object U+RECT; [U]::GetWindowRect($main, [ref]$r) | Out-Null
    if ($W -eq 0) { $L = $r.L; $T = $r.T; $W = $r.R - $r.L; $H = $r.B - $r.T }
    $script:ox = $L; $script:oy = $T
    $bmp = New-Object System.Drawing.Bitmap $W, $H; $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($L, $T, 0, 0, $bmp.Size); $g.Dispose()
    New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null; $bmp.Save("$Out.png"); $bmp.Dispose()
    $lines = Ocr "$Out.png"; $lines | Set-Content -Encoding UTF8 "$Out.ocr.txt"; $lines
  }
  { $_ -in 'click','rclick','dclick' } {
    Ensure; [U]::SetCursorPos($X, $Y) | Out-Null; Start-Sleep -Milliseconds 120
    $down = 0x2; $up = 0x4; if ($Action -eq 'rclick') { $down = 0x8; $up = 0x10 }
    $n = 1; if ($Action -eq 'dclick') { $n = 2 }
    for ($i = 0; $i -lt $n; $i++) { [U]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero); [U]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60 }
    Start-Sleep -Milliseconds $WaitMs; "clicked $Action $X,$Y"
  }
  'keys' { Ensure; [System.Windows.Forms.SendKeys]::SendWait($Keys); Start-Sleep -Milliseconds $WaitMs; "sent keys" }
  'type' { Ensure; $saved = Get-Clipboard -Raw; Set-Clipboard -Value $Text; [System.Windows.Forms.SendKeys]::SendWait('^a^v'); Start-Sleep -Milliseconds 300; if ($saved) { Set-Clipboard -Value $saved }; Start-Sleep -Milliseconds $WaitMs; "pasted $($Text.Length) chars (field replaced)" }
}
