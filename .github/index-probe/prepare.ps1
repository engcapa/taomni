$ErrorActionPreference = 'Stop'
$report = Join-Path $env:GITHUB_WORKSPACE "probe-results"
New-Item -ItemType Directory -Force $report | Out-Null
Start-Transcript -LiteralPath "$report/windows-search.log"
function Snapshot([string]$stage) {
  $feature = Get-WindowsFeature Search-Service
  $service = Get-CimInstance Win32_Service -Filter "Name='WSearch'" -ErrorAction SilentlyContinue
  [ordered]@{stage=$stage; image=$env:ImageVersion; feature=$feature.InstallState.ToString(); status=$service.State; startMode=$service.StartMode} |
    ConvertTo-Json | Set-Content "$report/service-$stage.json"
  Get-Content "$report/service-$stage.json"
}
try {
  Snapshot 'before'
  if (!(Get-WindowsFeature Search-Service).Installed) {
    $install = Install-WindowsFeature Search-Service
    $install | Format-List Success,RestartNeeded,ExitCode,FeatureResult
    if (!$install.Success) { throw "Windows Search role installation failed" }
  }
  if ((Get-Service WSearch).Status -ne 'Running') {
    Set-Service -Name WSearch -StartupType Manual
    Start-Service -Name WSearch
    (Get-Service WSearch).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
  }
  Snapshot 'running'
  $name = "TaomniIndexProbe" + (New-Guid).ToString("N").Substring(0,12) + ".lnk"
  $path = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $name
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $shortcut.TargetPath = "$env:WINDIR\System32\notepad.exe"
  $shortcut.Save()
  $deadline = [DateTime]::UtcNow.AddMinutes(4)
  $hit = $false
  do {
    $conn = New-Object -ComObject ADODB.Connection
    try {
      $conn.ConnectionTimeout = 3
      $conn.CommandTimeout = 3
      $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
      $rows = $conn.Execute("SELECT TOP 2 System.ItemPathDisplay FROM SystemIndex WHERE System.FileName = '$name'")
      if (!$rows.EOF) { $hit = $rows.Fields.Item(0).Value -eq $path }
      $rows.Close()
      if ($hit) { break }
    } catch { Write-Host ("Independent OLE DB probe: "+$_.Exception.Message) }
    finally { if ($conn.State -eq 1) { $conn.Close() } }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  [ordered]@{name=$name; path=$path; independentlyIndexed=$hit} | ConvertTo-Json | Set-Content "$report/control.json"
  Get-Content "$report/control.json"
  if (!$hit) { throw "Reference Windows Search did not return the unique public shortcut" }
} finally { Stop-Transcript }
