$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$automation = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$titleCondition = New-Object System.Windows.Automation.PropertyCondition($automation::NameProperty, $env:QA_PICKER_TITLE)
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$dialog = $null
do {
    $windows = $automation::RootElement.FindAll($scope::Children, $titleCondition)
    $owned = @($windows | Where-Object {
        $process = Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue
        $process -and $process.Path -eq $env:QA_PICKER_APPLICATION
    })
    if ($owned.Count -eq 1) { $dialog = $owned[0]; break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $dialog) { throw "No unique folder chooser owned by the QA executable" }
$pidObserved = $dialog.Current.ProcessId
function Button([string] $id) {
    $condition = New-Object System.Windows.Automation.PropertyCondition($automation::AutomationIdProperty, $id)
    $element = $dialog.FindFirst($scope::Descendants, $condition)
    if (-not $element -or -not $element.Current.IsEnabled) { throw "Chooser button $id unavailable" }
    return $element
}
if ($env:QA_PICKER_ACTION -eq "cancel") {
    (Button "2").GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
} else {
    $editCondition = New-Object System.Windows.Automation.PropertyCondition($automation::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
    $edits = @($dialog.FindAll($scope::Descendants, $editCondition) | Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen })
    $edit = $edits | Where-Object { $_.Current.AutomationId -eq "1152" } | Select-Object -First 1
    if (-not $edit) { $edit = $edits | Select-Object -Last 1 }
    if (-not $edit) { throw "Folder location field missing" }
    $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($env:QA_PICKER_PATH)
    if ($value.Current.Value -ne $env:QA_PICKER_PATH) { throw "Folder path was not entered completely" }
    (Button "1").GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 600
    try {
        if (-not $dialog.Current.IsOffscreen) {
            (Button "1").GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        }
    } catch [System.Windows.Automation.ElementNotAvailableException] { }
}
$deadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    try { $closed = $dialog.Current.IsOffscreen } catch [System.Windows.Automation.ElementNotAvailableException] { $closed = $true }
    if ($closed) { break }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
if (-not $closed) { throw "Folder chooser did not close" }
@{transport="Windows UI Automation"; pid=$pidObserved; application=$env:QA_PICKER_APPLICATION} | ConvertTo-Json -Compress
