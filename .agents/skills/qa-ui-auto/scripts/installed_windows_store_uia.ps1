param(
    [Parameter(Mandatory = $true)][int]$OwnerId,
    [Parameter(Mandatory = $true)][ValidateSet('open-store', 'roster', 'remove-mail', 'confirm-close')][string]$Phase
)

$ErrorActionPreference = 'Stop'
$script:diagnosticStage = 'initialization'
trap {
    $failure = $_
    $observed = @()
    if ($null -ne $window) {
        foreach ($label in @('Search modules', 'No matching modules in this catalog.',
                             'This version is installed', 'Install', 'Uninstall', 'Mail')) {
            try {
                $items = @(Named $window $label)
                $kinds = @($items | ForEach-Object { $_.Current.ControlType.ProgrammaticName } | Sort-Object -Unique)
                $observed += [pscustomobject]@{ label = $label; count = $items.Count; types = $kinds }
            } catch {}
        }
    }
    [Console]::Error.WriteLine(([pscustomobject]@{
        stage = $script:diagnosticStage
        line = $failure.InvocationInfo.ScriptLineNumber
        exception = $failure.Exception.GetBaseException().GetType().Name
        module = $script:checkingModule
        windowHandle = if ($windowHandle) { $windowHandle.ToInt64() } else { 0 }
        observed = $observed
    } | ConvertTo-Json -Depth 3 -Compress))
    exit 1
}
$fixture = [Console]::In.ReadToEnd() | ConvertFrom-Json
$phaseTimeout = if ($Phase -eq 'open-store') { 300 } else { 75 }
. (Join-Path $PSScriptRoot 'installed_windows_uia_common.ps1') -PhaseTimeoutSeconds $phaseTimeout

function Named($Root, [string]$Name) {
    $condition = [System.Windows.Automation.PropertyCondition]::new($automation::NameProperty, $Name)
    return $Root.FindAll($scope, $condition)
}

function Search-Field {
    foreach ($item in (Named $window 'Search modules')) {
        [object]$value = $null
        if (-not $item.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) { continue }
        if ($item.Current.IsEnabled -and -not $value.Current.IsReadOnly) { return $item }
    }
}

function Scoped-Control([string]$Label, [string]$ControlName, $Type, [string[]]$Exclude) {
    # The managed UIA client doesn't expose Chromium's ARIA role property.
    # Find the nearest group with this label and exactly one matching control.
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    foreach ($item in (Named $window $Label)) {
        $parent = $walker.GetParent($item)
        while ($null -ne $parent -and $parent -ne $window -and $parent.Current.ControlType -ne $types::Document) {
            $controls = @(Named $parent $ControlName | Where-Object {
                $_.Current.ControlType -eq $Type -and $_.Current.IsEnabled })
            if ($controls.Count -gt 1) { break }
            if ($controls.Count -eq 1) {
                $neighbor = $Exclude | Where-Object { @(Named $parent $_).Count -gt 0 } | Select-Object -First 1
                if ($null -eq $neighbor) { return $controls[0] }
                break
            }
            $parent = $walker.GetParent($parent)
        }
    }
}

function Card-Control([string]$ModuleName, [string]$ControlName, $Type) {
    $others = @($fixture.modules | ForEach-Object { $_.name } | Where-Object { $_ -ne $ModuleName })
    return Scoped-Control $ModuleName $ControlName $Type $others
}

function Invoke-Owned($Control) {
    [object]$pattern = $null
    if ($Control.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke()
    } else {
        if ($Control.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) {
            $pattern.ScrollIntoView()
        }
        Click-Element $Control
    }
}

function Dialog-Button([string]$Message, [string]$Button) {
    return Scoped-Control $Message $Button $types::Button @()
}

$result = [ordered]@{ ownerPid = $OwnerId; phase = $Phase }
switch ($Phase) {
    'open-store' {
        # A cold reopen loads the installed business modules before showing the
        # Vault dialog. Re-resolve the window in case its initial HWND changes.
        $passwords = Wait-Element {
            $handle = (Get-Process -Id $OwnerId).MainWindowHandle
            if ($handle -eq [IntPtr]::Zero) { return }
            $current = $automation::FromHandle($handle)
            if ($current.Current.ProcessId -ne $OwnerId) { return }
            $script:windowHandle = $handle
            $script:window = $current
            Find-Passwords 1
        } 'vault-unlock-field' 225
        $result.unlockControlWaitMs = $clock.ElapsedMilliseconds
        Set-Value $passwords[0] $fixture.password
        Invoke-Button $window 'Unlock' 'unlock-vault' -Physical
        $null = Wait-Element { if (@(Get-VisiblePasswords).Count -eq 0) { return $true } } 'unlock-vault'
        Invoke-Button $window 'Settings' 'settings'
        $search = Wait-Element {
            $window.FindFirst($scope, [System.Windows.Automation.PropertyCondition]::new(
                $automation::AutomationIdProperty, 'settings-search-input'))
        } 'settings-search'
        Set-Value $search 'module store'
        if ($fixture.catalogSource) {
            $toggle = Wait-Element { Find-Control $window $types::Button 'Official catalog mirror' } 'catalog-source'
            Invoke-Owned $toggle
            $source = Wait-Element { Find-Control $window $types::Edit 'Official catalog mirror' } 'catalog-input'
            Set-Value $source $fixture.catalogSource
            Invoke-Button $window 'Check for modules' 'catalog-refresh'
        }
    }
    'roster' {
        $names = @()
        # Selecting the catalog mirror can leave the search field scrolled above
        # the viewport. Its UIA ValuePattern still accepts normal input.
        $search = Wait-Element { Search-Field } 'market-search'
        foreach ($entry in $fixture.modules) {
            $script:checkingModule = $entry.id
            # WebView2 can flatten an article's static text into its document.
            # Clear the previous result before checking this signed catalog entry.
            Set-Value $search ('absent-fixture-' + $entry.id)
            $empty = 'No matching modules in this catalog.'
            $null = Wait-Element { Named $window $empty } 'market-empty'
            Set-Value $search $entry.query
            $null = Wait-Element {
                if (@(Named $window $empty).Count -eq 0) { return $true }
            } 'market-result'
            if ($entry.removed) {
                $null = Wait-Element {
                    foreach ($label in @('Download module', 'Review and install')) {
                        $action = Named $window $label | Where-Object { $_.Current.ControlType -eq $types::Button }
                        if ($null -ne $action) { return $action }
                    }
                } 'removed-market-action'
                $null = Wait-Element { Card-Control $entry.name 'Install' $types::Button } 'removed-mail-install'
                if (@(Named $window 'This version is installed').Count -gt 0) {
                    throw 'Removed Mail is still current'
                }
            } else {
                $null = Wait-Element { Named $window 'This version is installed' } 'current-module'
                $names += $entry.id
            }
        }
        $result.currentModules = @($names | Sort-Object)
    }
    'remove-mail' {
        $uninstall = Wait-Element { Card-Control 'Mail' 'Uninstall' $types::Button } 'mail-uninstall'
        Invoke-Owned $uninstall
        $message = 'Uninstall Mail? Module data will be retained unless you select delete module data.'
        $confirm = Wait-Element { Dialog-Button $message 'Uninstall' } 'confirm-uninstall'
        Invoke-Owned $confirm
        $null = Wait-Element { Card-Control 'Mail' 'Install' $types::Button } 'uninstalled-mail'
        $result.confirmation = $message
    }
    'confirm-close' {
        if (-not (Get-Process -Id $OwnerId).CloseMainWindow()) { throw 'Owned window did not receive Close' }
        $message = 'There is 1 open tab. Exit Taomni and close it?'
        $confirm = Wait-Element { Dialog-Button $message 'Exit' } 'confirm-exit'
        # Click only in the owned window. The provider can disappear as soon as it exits.
        Click-Element $confirm
        $result.confirmation = $message
    }
}
$result | ConvertTo-Json -Compress
