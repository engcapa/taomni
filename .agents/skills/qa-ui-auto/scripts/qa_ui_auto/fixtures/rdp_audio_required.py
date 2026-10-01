"""rdp_audio_required: a host audio output the RDP server can loop back.

RDPSND playback (docs-feature/rdp-server-parity-design.md §4.3) captures what
this computer plays. Hosted runners have no sound hardware, so this fixture
provides a virtual output and makes it the default:

* Linux: a per-session PipeWire graph (pipewire, wireplumber, pipewire-pulse;
  installed by the workflow for the ``audio`` capability) with a null sink
  set as default. pipewire-alsa routes the probe's cpal/ALSA tone into it.
* Windows: the Windows Audio services are started and an audio device is
  required. The fixture never installs drivers; the workflow installs the
  VB-CABLE virtual device for the ``audio`` capability (pinned
  LABSN/sound-ci-helpers), local runs need a real or virtual output. On CI
  runners it also allows desktop apps to use the microphone (privacy
  consent), which recording from the virtual cable requires.
* macOS: a default output device is required (the server captures system
  audio with ScreenCaptureKit, which needs something to render to); the
  workflow installs the Background Music virtual device for ``audio``.

Exports ``QA_AUDIO_BACKEND`` describing what was prepared.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

_PROCESSES: list[subprocess.Popen] = []
_NULL_SINK = "taomni_rdp_null"
_MODULES: list[str] = []


def _export(ctx: Any, name: str, value: str) -> None:
    os.environ[name] = value
    env = getattr(ctx, "env", None)
    if isinstance(env, dict):
        env[name] = value


def _pactl(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["pactl", *args], capture_output=True, text=True, timeout=20)


def _linux(ctx: Any) -> str:
    from . import FixtureSkip

    if not shutil.which("pipewire") or not shutil.which("pactl"):
        raise FixtureSkip("PipeWire (pipewire, wireplumber, pipewire-pulse, pactl) is not installed")
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime or not Path(runtime).is_dir():
        runtime = tempfile.mkdtemp(prefix="taomni-xdg-")
        os.chmod(runtime, 0o700)
        _export(ctx, "XDG_RUNTIME_DIR", runtime)
    if _pactl("info").returncode:
        # Units installed after the user manager started need a reload; a
        # host without a user manager gets the daemons spawned directly.
        units = ("pipewire.socket", "pipewire-pulse.socket", "wireplumber.service")
        started = False
        if shutil.which("systemctl"):
            reload = subprocess.run(["systemctl", "--user", "daemon-reload"],
                                    capture_output=True, timeout=30)
            if reload.returncode == 0:
                start = subprocess.run(["systemctl", "--user", "start", *units],
                                       capture_output=True, timeout=60)
                started = start.returncode == 0
        if not started:
            for daemon in ("pipewire", "wireplumber", "pipewire-pulse"):
                _PROCESSES.append(subprocess.Popen([daemon], stdout=subprocess.DEVNULL,
                                                   stderr=subprocess.DEVNULL))
                time.sleep(0.5)
    deadline = time.time() + 30
    while _pactl("info").returncode:
        if time.time() >= deadline:
            raise FixtureSkip("the PipeWire session daemons did not come up within 30 s")
        time.sleep(0.5)
    previous = _pactl("get-default-sink").stdout.strip()
    if previous and previous != _NULL_SINK:
        _export(ctx, "QA_AUDIO_PREVIOUS_SINK", previous)
    if _NULL_SINK not in _pactl("list", "short", "sinks").stdout:
        loaded = _pactl("load-module", "module-null-sink", f"sink_name={_NULL_SINK}",
                        "sink_properties=device.description=TaomniRdpNull")
        if loaded.returncode:
            raise FixtureSkip(f"could not create the null sink: {loaded.stderr[-300:]}")
        _MODULES.append(loaded.stdout.strip())
    _pactl("set-default-sink", _NULL_SINK)
    return f"pipewire null sink {_NULL_SINK}"


_WINDOWS_AUDIO = r"""
$ErrorActionPreference = 'Stop'
foreach ($name in 'AudioEndpointBuilder', 'Audiosrv') {
  $service = Get-Service -Name $name
  if ($service.StartType -eq 'Disabled') { Set-Service -Name $name -StartupType Manual }
  if ($service.Status -ne 'Running') { Start-Service -Name $name }
}
$devices = @(Get-CimInstance -ClassName Win32_SoundDevice | Where-Object { $_.Status -eq 'OK' })
[pscustomobject]@{ devices = @($devices | ForEach-Object { $_.Name }) } | ConvertTo-Json -Compress
"""


# Recording from an input (VB-CABLE's "CABLE Output") needs the microphone
# privacy consent for desktop apps; hosted runners deny it, so WASAPI fails
# with E_ACCESSDENIED. Only CI runners are changed; the previous values are
# printed so teardown can restore them.
_WINDOWS_MIC_CONSENT = r"""
$ErrorActionPreference = 'Stop'
$keys = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged'
)
$previous = [ordered]@{}
foreach ($key in $keys) {
  if (Test-Path $key) {
    $previous[$key] = (Get-ItemProperty -Path $key -Name Value -ErrorAction SilentlyContinue).Value
  } else {
    New-Item -Path $key -Force | Out-Null
    $previous[$key] = $null
  }
  Set-ItemProperty -Path $key -Name Value -Value 'Allow' -Type String
}
$policy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy'
$forced = (Get-ItemProperty -Path $policy -Name LetAppsAccessMicrophone -ErrorAction SilentlyContinue).LetAppsAccessMicrophone
[pscustomobject]@{ previous = $previous; policy = $forced } | ConvertTo-Json -Compress
"""

_MIC_CONSENT_PREVIOUS: dict[str, Any] = {}


def _windows_microphone_consent() -> str:
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return "microphone consent unchanged (local run)"
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", _WINDOWS_MIC_CONSENT],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode:
        return "microphone consent not granted: " + (result.stderr or result.stdout)[-300:]
    state = json.loads(result.stdout.strip().splitlines()[-1])
    _MIC_CONSENT_PREVIOUS.update(state.get("previous") or {})
    policy = state.get("policy")
    return "microphone consent allowed" + (f" (policy LetAppsAccessMicrophone={policy})" if policy else "")


def _restore_windows_microphone_consent() -> None:
    if not _MIC_CONSENT_PREVIOUS:
        return
    lines = ["$ErrorActionPreference = 'Continue'"]
    for key, value in _MIC_CONSENT_PREVIOUS.items():
        quoted = key.replace("'", "''")
        if value is None:
            lines.append(f"Remove-ItemProperty -Path '{quoted}' -Name Value -ErrorAction SilentlyContinue")
        else:
            lines.append(f"Set-ItemProperty -Path '{quoted}' -Name Value -Value '{str(value).replace(chr(39), chr(39) * 2)}' -Type String")
    subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", "\n".join(lines)],
                   capture_output=True, text=True, timeout=60)
    _MIC_CONSENT_PREVIOUS.clear()


def _windows(ctx: Any) -> str:
    from . import FixtureSkip

    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", _WINDOWS_AUDIO],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode:
        raise FixtureSkip("could not start the Windows Audio services (elevation required?): "
                          + (result.stderr or result.stdout)[-400:])
    devices = json.loads(result.stdout.strip().splitlines()[-1]).get("devices") or []
    if isinstance(devices, str):
        devices = [devices]
    if not devices:
        raise FixtureSkip("no audio output device; CI installs VB-CABLE for the audio capability "
                          "(LABSN/sound-ci-helpers), local runs need a real or virtual output")
    return "windows " + ", ".join(devices) + "; " + _windows_microphone_consent()


def _macos(ctx: Any) -> str:
    from . import FixtureSkip

    result = subprocess.run(["system_profiler", "SPAudioDataType", "-json"],
                            capture_output=True, text=True, timeout=120)
    try:
        groups = json.loads(result.stdout or "{}").get("SPAudioDataType") or []
    except ValueError:
        groups = []
    outputs = [item.get("_name", "?") for group in groups for item in group.get("_items") or []
               if item.get("coreaudio_default_audio_output_device") == "spaudio_yes"]
    if not outputs:
        raise FixtureSkip("no default audio output device; CI installs Background Music for the "
                          "audio capability (LABSN/sound-ci-helpers), local runs need an output")
    return "macos " + ", ".join(outputs)


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    system = platform.system()
    if system == "Linux":
        backend = _linux(ctx)
    elif system == "Windows":
        backend = _windows(ctx)
    elif system == "Darwin":
        backend = _macos(ctx)
    else:
        raise FixtureSkip(f"no host audio provisioning for {system}")
    _export(ctx, "QA_AUDIO_BACKEND", backend)


def teardown(ctx: Any) -> None:
    if platform.system() == "Windows":
        _restore_windows_microphone_consent()
    if platform.system() == "Linux" and shutil.which("pactl"):
        previous = os.environ.pop("QA_AUDIO_PREVIOUS_SINK", "")
        if previous:
            _pactl("set-default-sink", previous)
        while _MODULES:
            _pactl("unload-module", _MODULES.pop())
    while _PROCESSES:
        process = _PROCESSES.pop()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
