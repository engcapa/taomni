# Install WinDivert 2.2.2 runtime for Taomni Sockscap (Windows transparent capture).
# Requires Administrator for first driver load.
# Official package: https://reqrypt.org/windivert.html (LGPLv3/GPLv2)
$ErrorActionPreference = "Stop"
# scripts/ -> repo root
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (-not (Test-Path (Join-Path $Root "src-tauri"))) {
  throw "Cannot locate repo root from $PSScriptRoot"
}
$Dest = Join-Path $Root "src-tauri\resources\windivert"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Zip = Join-Path $env:TEMP "WinDivert-2.2.2-A.zip"
$Url = "https://reqrypt.org/download/WinDivert-2.2.2-A.zip"
if (-not (Test-Path (Join-Path $Dest "WinDivert.dll"))) {
  Write-Host "Downloading $Url ..."
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
  Expand-Archive -Path $Zip -DestinationPath (Join-Path $env:TEMP "WinDivert-extract") -Force
  $x64 = Join-Path $env:TEMP "WinDivert-extract\WinDivert-2.2.2-A\x64"
  Copy-Item -Force (Join-Path $x64 "*") $Dest
  Copy-Item -Force (Join-Path $env:TEMP "WinDivert-extract\WinDivert-2.2.2-A\LICENSE") $Dest -ErrorAction SilentlyContinue
}
# System-wide runtime (probe + load)
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
  Write-Host "Re-launching elevated to install driver files into System32..."
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Wait
  exit $LASTEXITCODE
}
Copy-Item -Force (Join-Path $Dest "WinDivert.dll") "C:\Windows\System32\WinDivert.dll"
Copy-Item -Force (Join-Path $Dest "WinDivert64.sys") "C:\Windows\System32\WinDivert64.sys"
# Load/unload once to register the signed driver
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WDInstall {
  [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl, CharSet=CharSet.Ansi)]
  public static extern IntPtr WinDivertOpen(string filter, int layer, short priority, ulong flags);
  [DllImport("WinDivert.dll", CallingConvention=CallingConvention.Cdecl)]
  public static extern bool WinDivertClose(IntPtr handle);
}
"@
$h = [WDInstall]::WinDivertOpen("false", 0, 0, 0)
if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]::new(-1)) {
  Write-Error "WinDivertOpen failed (err=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())). Secure Boot / EDR may block the driver."
}
[void][WDInstall]::WinDivertClose($h)
Write-Host "WinDivert installed and open smoke test OK."
Write-Host "DLL: C:\Windows\System32\WinDivert.dll"
Write-Host "SYS: C:\Windows\System32\WinDivert64.sys"
Write-Host "App resources: $Dest"
