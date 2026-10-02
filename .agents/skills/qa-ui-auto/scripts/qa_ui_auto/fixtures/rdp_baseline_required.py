"""rdp_baseline_required: Windows TermService as the RDP performance reference.

DEC-04 (docs-feature/rdp-server-parity-design.md) measures the system Remote
Desktop with the same rdp-probe scenarios as Taomni's server. TermService
starts a separate session per user instead of mirroring the console, so the
visual target must run inside that session: the probe passes it as the
client-requested initial program (alternate shell).

Setup (Windows, elevated runner):
* system Remote Desktop enabled, TermService running, client initial program
  allowed (``fInheritInitialProgram=1`` on RDP-Tcp);
* two disposable local accounts in Remote Desktop Users — one session hosts a
  ``flip`` target (latency), the other an ``animate`` target (throughput);
* a world-writable work directory holding a copy of the Tk target and a
  launcher registered in the machine Run key: Server 2025 starts Explorer
  despite the initial program (run 36821068478), and Explorer then starts
  the account's target; the first sign-in animation is turned off for the
  run. Cases wait for the target's state file (``rdp-probe --wait-ready``).

Exports ``QA_RDP_BASELINE_PORT``, ``QA_RDP_BASELINE_USER1/2``,
``QA_RDP_BASELINE_PASSWORD`` (masked), ``QA_RDP_BASELINE_DIR`` and the two
initial-program command lines ``QA_RDP_BASELINE_FLIP_SHELL`` /
``QA_RDP_BASELINE_ANIMATE_SHELL``. Teardown logs the accounts off and deletes
only the accounts this fixture created.
"""

from __future__ import annotations

import os
import platform
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

USERS = ("qa-rdp-base1", "qa-rdp-base2")
WORK_DIR = Path(os.environ.get("PUBLIC", r"C:\Users\Public")) / "taomni-rdp-baseline"
_CREATED: list[str] = []


def _ps(script: str, *, check: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, text=True, timeout=180)
    if check and result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-600:])
    return result


def _export(ctx: Any, name: str, value: str) -> None:
    os.environ[name] = value
    env = getattr(ctx, "env", None)
    if isinstance(env, dict):
        env[name] = value

_HOST_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$ts = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
Set-ItemProperty -Path $ts -Name fDenyTSConnections -Value 0
Set-ItemProperty -Path "$ts\WinStations\RDP-Tcp" -Name fInheritInitialProgram -Value 1
$service = Get-Service -Name TermService
if ($service.StartType -eq 'Disabled') { Set-Service -Name TermService -StartupType Manual }
if ($service.Status -ne 'Running') { Start-Service -Name TermService }
$secure = ConvertTo-SecureString $env:QA_BASELINE_PW -AsPlainText -Force
foreach ($name in $env:QA_BASELINE_USERS.Split(',')) {
  if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $name -Password $secure
  } else {
    New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
    Write-Output "created:$name"
  }
  # S-1-5-32-555 = Remote Desktop Users, independent of the display language.
  Add-LocalGroupMember -SID 'S-1-5-32-555' -Member $name -ErrorAction SilentlyContinue
}
Write-Output ("port:" + (Get-ItemProperty -Path "$ts\WinStations\RDP-Tcp" -Name PortNumber).PortNumber)
# Server 2025 may ignore the client's initial program and start Explorer;
# Explorer then runs the target from the machine Run key (see _LAUNCHER).
$run = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
Set-ItemProperty -Path $run -Name TaomniRdpBaselineTarget -Value $env:QA_BASELINE_RUN
# Proves Explorer processed the Run key even if Python could not start.
Set-ItemProperty -Path $run -Name TaomniRdpBaselineMarker -Value $env:QA_BASELINE_MARKER
# A fresh profile's first sign-in animation delays the shell by tens of seconds.
$system = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$previous = (Get-ItemProperty -Path $system -Name EnableFirstLogonAnimation -ErrorAction SilentlyContinue).EnableFirstLogonAnimation
Write-Output ("animation:" + $(if ($null -eq $previous) { 'unset' } else { $previous }))
Set-ItemProperty -Path $system -Name EnableFirstLogonAnimation -Value 0 -Type DWord
"""

# Started by Explorer (machine Run key) in every baseline session; picks the
# target by account so each session hosts the scenario it measures. Without
# an account match it exits, so the runner's own logons are untouched.
_LAUNCHER = r'''
import os, runpy, sys, time, traceback
from pathlib import Path
here = Path(__file__).resolve().parent
user = os.environ.get("USERNAME", "").lower()
targets = {"qa-rdp-base1": ("flip", "480x320+40+80"), "qa-rdp-base2": ("animate", "640x360+40+80")}
mode = targets.get(user)
if mode:
    log = here / f"{user}-launch.log"
    with log.open("a", encoding="utf-8") as out:
        out.write(f"{time.strftime('%H:%M:%S')} start {mode[0]} pid={os.getpid()} python={sys.executable}\n")
    try:
        sys.argv = [str(here / "rdp_target.py"), "--state", str(here / f"{mode[0]}-state.json"),
                    "--mode", mode[0], "--pattern", "--geometry", mode[1], "--lifetime-sec", "1800"]
        runpy.run_path(str(here / "rdp_target.py"), run_name="__main__")
    except BaseException:
        with log.open("a", encoding="utf-8") as out:
            out.write(traceback.format_exc())
        raise
'''
_ANIMATION: list[str] = []


def _shell(python: Path, mode: str, geometry: str) -> str:
    command = (f'"{python}" "{WORK_DIR / "rdp_target.py"}" --state "{WORK_DIR / f"{mode}-state.json"}" '
               f"--mode {mode} --geometry {geometry} --lifetime-sec 1800")
    # MS-RDPBCGR caps the alternate shell at 256 UTF-16 code units.
    if len(command) >= 256:
        raise RuntimeError(f"initial program command exceeds 255 characters: {command}")
    return command


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    if platform.system() != "Windows":
        raise FixtureSkip("the TermService baseline exists only on Windows")
    password = os.environ.get("QA_RDP_BASELINE_PASSWORD") or ("Qa1_" + secrets.token_hex(12))
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::add-mask::{password}", flush=True)

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(Path(__file__).resolve().parents[1] / "rdp_helpers" / "rdp_target.py", WORK_DIR / "rdp_target.py")
    (WORK_DIR / "launch_target.pyw").write_text(_LAUNCHER, encoding="utf-8")
    for stale in [*WORK_DIR.glob("*-state.json"), *WORK_DIR.glob("*.log")]:
        stale.unlink(missing_ok=True)
    # Everyone (S-1-1-0) may write the target state from the baseline sessions.
    subprocess.run(["icacls", str(WORK_DIR), "/grant", "*S-1-1-0:(OI)(CI)M"],
                   capture_output=True, text=True, timeout=60, check=True)
    executable = Path(sys.executable)
    windowed = executable.with_name("pythonw.exe")
    python = windowed if windowed.is_file() else executable

    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", _HOST_SCRIPT],
        capture_output=True, text=True, timeout=180,
        env={**os.environ, "QA_BASELINE_PW": password, "QA_BASELINE_USERS": ",".join(USERS),
             "QA_BASELINE_RUN": f'"{python}" "{WORK_DIR / "launch_target.pyw"}"',
             "QA_BASELINE_MARKER": f'cmd.exe /c echo %USERNAME% %TIME%>>"{WORK_DIR / "run-key.log"}"'},
    )
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # The baseline accounts run the runner's Python; make sure plain
        # Users may read and execute it (CI only, never on a workstation).
        subprocess.run(["icacls", str(python.parent), "/grant", "*S-1-5-32-545:(OI)(CI)RX", "/T", "/C", "/Q"],
                       capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise FixtureSkip("could not prepare the TermService baseline (elevation required?): "
                          + (result.stderr or result.stdout)[-500:])
    lines = result.stdout.split()
    _CREATED.extend(line.split(":", 1)[1] for line in lines if line.startswith("created:"))
    _ANIMATION.extend(line.split(":", 1)[1] for line in lines if line.startswith("animation:"))
    port = next((line.split(":", 1)[1] for line in lines if line.startswith("port:")), "3389")

    _export(ctx, "QA_RDP_BASELINE_PORT", port)
    _export(ctx, "QA_RDP_BASELINE_USER1", USERS[0])
    _export(ctx, "QA_RDP_BASELINE_USER2", USERS[1])
    _export(ctx, "QA_RDP_BASELINE_PASSWORD", password)
    _export(ctx, "QA_RDP_BASELINE_DIR", str(WORK_DIR))
    _export(ctx, "QA_RDP_BASELINE_FLIP_SHELL", _shell(python, "flip", "480x320+40+80"))
    _export(ctx, "QA_RDP_BASELINE_ANIMATE_SHELL", _shell(python, "animate", "640x360+40+80"))


def teardown(ctx: Any) -> None:
    if platform.system() != "Windows":
        return
    # Explorer can delay Run entries after a fresh account's desktop is already
    # visible. Keep the session's own startup/state files before logging it off.
    try:
        diagnostics = Path(ctx.case_dir) / "termservice-target"
        diagnostics.mkdir(exist_ok=True)
        password = os.environ.get("QA_RDP_BASELINE_PASSWORD", "")
        for source in [*WORK_DIR.glob("*.log"), *WORK_DIR.glob("*-state.json")]:
            content = source.read_text(encoding="utf-8", errors="replace")
            if password:
                content = content.replace(password, "[redacted]")
            (diagnostics / source.name).write_text(content, encoding="utf-8")
    except Exception as error:
        try:
            (Path(ctx.case_dir) / "termservice-target-error.txt").write_text(str(error), encoding="utf-8")
        except OSError:
            pass  # Even an unavailable report directory must not prevent cleanup.
    # Public certificates only, never private keys. Preserve the actual
    # reference server certificate so TLS failures can be reproduced by unit
    # verification after downloading CI evidence.
    try:
        result = _ps(r"""
Get-ChildItem 'Cert:\LocalMachine\Remote Desktop' | ForEach-Object {
  [pscustomobject]@{ Thumbprint=$_.Thumbprint; Subject=$_.Subject; Issuer=$_.Issuer;
    SignatureAlgorithm=$_.SignatureAlgorithm.Value; PublicKeyAlgorithm=$_.PublicKey.Oid.Value;
    CertificateDer=[Convert]::ToBase64String($_.RawData) }
} | ConvertTo-Json
""", check=False)
        (Path(ctx.case_dir) / "termservice-certificates.json").write_text(result.stdout, encoding="utf-8")
        if result.stderr:
            (Path(ctx.case_dir) / "termservice-certificates-error.txt").write_text(result.stderr, encoding="utf-8")
    except Exception:
        pass  # Diagnostics must not prevent owned account/host-state cleanup.
    names = ",".join(USERS)
    _ps(r"""
$names = $env:QA_BASELINE_USERS.Split(',')
foreach ($line in (quser 2>$null | Select-Object -Skip 1)) {
  $parts = $line.Trim().TrimStart('>') -split '\s+'
  if ($names -contains $parts[0]) {
    $id = $parts | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
    if ($id) { logoff $id }
  }
}
""".replace("$env:QA_BASELINE_USERS", f"'{names}'"), check=False)
    while _CREATED:
        _ps(f"Remove-LocalUser -Name '{_CREATED.pop()}'", check=False)
    for value in ("TaomniRdpBaselineTarget", "TaomniRdpBaselineMarker"):
        _ps(r"Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' "
            f"-Name {value} -ErrorAction SilentlyContinue", check=False)
    system = r"HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
    while _ANIMATION:
        previous = _ANIMATION.pop()
        if previous == "unset":
            _ps(f"Remove-ItemProperty -Path '{system}' -Name EnableFirstLogonAnimation "
                "-ErrorAction SilentlyContinue", check=False)
        elif previous.isdigit():
            _ps(f"Set-ItemProperty -Path '{system}' -Name EnableFirstLogonAnimation "
                f"-Value {previous} -Type DWord", check=False)
