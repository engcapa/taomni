"""system_rdp_running: Windows Remote Desktop host enabled and listening.

The Windows branch of Taomni's RDP server (docs-feature/rdp-server-parity-design.md
§4.1) must recommend a running system Remote Desktop and start Taomni only
after an explicit choice. This fixture makes that host state deterministic on
the runner: Remote Desktop connections allowed (``fDenyTSConnections=0``) and
``TermService`` running. It is idempotent and leaves an already-enabled host
untouched.

Exports ``QA_SYSTEM_RDP_PORT`` (the configured RDP-Tcp port).

A no-op on Linux and macOS, so cross-platform cases can declare it and
answer the Windows-only prompt with ``platform_choice``. A Windows host that
cannot provide the state (no elevation, no Remote Desktop host) raises
FixtureSkip with the reason.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
from typing import Any

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$ts = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
$deny = (Get-ItemProperty -Path $ts -Name fDenyTSConnections).fDenyTSConnections
$service = Get-Service -Name TermService
$changed = $false
if ($deny -ne 0) { Set-ItemProperty -Path $ts -Name fDenyTSConnections -Value 0; $changed = $true }
if ($service.Status -ne 'Running') {
  if ($service.StartType -eq 'Disabled') { Set-Service -Name TermService -StartupType Manual }
  Start-Service -Name TermService
  $changed = $true
}
$service = Get-Service -Name TermService
$port = (Get-ItemProperty -Path "$ts\WinStations\RDP-Tcp" -Name PortNumber).PortNumber
[pscustomobject]@{ status = "$($service.Status)"; port = $port; changed = $changed } | ConvertTo-Json -Compress
"""


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    if platform.system() != "Windows":
        return
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", _SCRIPT],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode:
        raise FixtureSkip(
            "could not enable the system Remote Desktop host (elevation required?): "
            + (result.stderr or result.stdout)[-400:]
        )
    state = json.loads(result.stdout.strip().splitlines()[-1])
    if state.get("status") != "Running":
        raise FixtureSkip(f"TermService is not running: {state}")
    port = str(state.get("port") or 3389)
    os.environ["QA_SYSTEM_RDP_PORT"] = port
    env = getattr(ctx, "env", None)
    if isinstance(env, dict):
        env["QA_SYSTEM_RDP_PORT"] = port
    values = getattr(ctx, "values", None)
    if isinstance(values, dict):
        values["system_rdp"] = state
