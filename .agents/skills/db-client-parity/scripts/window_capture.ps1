# Capture a running client window without taking focus, then OCR it (Windows only).
#
#   powershell.exe -NoProfile -File .agents/skills/db-client-parity/scripts/window_capture.ps1 `
#     -ProcessName dbvis -Out qa-ui-auto-report/dbvis-reference/run-<date>/01-main
#
# Restores a minimized window with SW_SHOWNOACTIVATE, captures it with PrintWindow
# (PW_RENDERFULLCONTENT), puts it back into its original minimized state, and writes
# <Out>.png plus <Out>.ocr.txt ("x y text" lines, 2x upscaled Windows.Media.Ocr).
# Sends no input. Output may contain user data: keep it under gitignored qa-ui-auto-report/.
param([Parameter(Mandatory)][string]$ProcessName, [Parameter(Mandatory)][string]$Out, [int]$Scale = 2, [int]$WaitMs = 4000)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CaptureWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process -Name $ProcessName | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "No window for process $ProcessName" }
$handle = $proc.MainWindowHandle
$wasMinimized = [CaptureWin]::IsIconic($handle)
if ($wasMinimized) { [CaptureWin]::ShowWindow($handle, 4) | Out-Null; Start-Sleep -Milliseconds $WaitMs }
try {
  $rect = New-Object CaptureWin+RECT; [CaptureWin]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $bitmap = New-Object System.Drawing.Bitmap ($rect.R - $rect.L), ($rect.B - $rect.T)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $hdc = $graphics.GetHdc()
  [CaptureWin]::PrintWindow($handle, $hdc, 2) | Out-Null
  $graphics.ReleaseHdc($hdc); $graphics.Dispose()
  New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
  $bitmap.Save("$Out.png")
} finally {
  if ($wasMinimized) { [CaptureWin]::ShowWindow($handle, 7) | Out-Null }
}

$big = New-Object System.Drawing.Bitmap ($bitmap.Width * $Scale), ($bitmap.Height * $Scale)
$g = [System.Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($bitmap, 0, 0, $big.Width, $big.Height); $g.Dispose(); $bitmap.Dispose()
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("ocr-" + [guid]::NewGuid() + ".png"); $big.Save($tmp); $big.Dispose()

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($operation, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation)); $task.Wait(-1) | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
$result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
$rows = foreach ($line in $result.Lines) {
  $box = @($line.Words)[0].BoundingRect
  [pscustomobject]@{ X = [int]($box.X / $Scale); Y = [int]($box.Y / $Scale); Text = $line.Text }
}
$stream.Dispose(); Remove-Item $tmp -ErrorAction SilentlyContinue
$rows | Sort-Object { [int]($_.Y / 6) }, X | ForEach-Object { "{0,5} {1,5}  {2}" -f $_.X, $_.Y, $_.Text } |
  Set-Content -Encoding UTF8 "$Out.ocr.txt"
"captured $Out.png ($($rect.R - $rect.L)x$($rect.B - $rect.T)), restored minimized=$wasMinimized"
