param(
  [string]$Token,
  [int]$Port,
  [string]$ReadyFile,
  [string]$WinDivertDir
)

$exe = "C:\code\person\taomni\src-tauri\target\debug\sockscap-helper.exe"
$args = @("--token", $Token, "--port", $Port.ToString(), "--ready-file", $ReadyFile, "--windivert-dir", $WinDivertDir)

Write-Host "Triggering Windows UAC for sockscap-helper.exe..."
try {
  Start-Process -FilePath $exe -ArgumentList $args -Verb RunAs -ErrorAction Stop
  Write-Host "UAC prompt triggered successfully."
} catch {
  Write-Warning "UAC elevation exception: $_"
}
