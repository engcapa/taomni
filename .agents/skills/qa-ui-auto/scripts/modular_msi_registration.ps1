param([Parameter(Mandatory = $true)][string]$Package)
$ErrorActionPreference = 'Stop'
$Package = (Resolve-Path -LiteralPath $Package).Path
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($Package, 0))
$properties = [ordered]@{}
foreach ($name in @('ProductCode', 'ProductVersion', 'UpgradeCode')) {
  $sql = 'SELECT `Value` FROM `Property` WHERE `Property`=' + "'$name'"
  $view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @($sql))
  [void]$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
  $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
  $value = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1))
  $properties[$name] = [string]$value
  [void]$view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
}
$properties['InstalledState'] = [int]$installer.GetType().InvokeMember(
  'ProductState', 'GetProperty', $null, $installer, @($properties['ProductCode']))
$properties | ConvertTo-Json -Compress
