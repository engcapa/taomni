# Observe the same desktop status segment on both installed MSI versions.
param([Parameter(Mandatory = $true)][int]$OwnerId)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installed_windows_uia_common.ps1') -PhaseTimeoutSeconds 70

$null = Wait-Element {
    if ($null -ne (Find-OwnedWindow)) {
        Find-Control $window $types::Text 'X11:'
    }
} 'status bar X11 indicator' 70

@{ ownerPid = $OwnerId; statusMarker = 'X11:' } | ConvertTo-Json -Compress
