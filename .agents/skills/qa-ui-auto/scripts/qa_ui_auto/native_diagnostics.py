"""Collect bounded logs from this run's native processes before profile teardown."""
import os
from pathlib import Path
import platform
import shutil
import subprocess


def collect(case_dir: Path, run_root: Path, *, failed: bool):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    destination = case_dir / "native-diagnostics"
    destination.mkdir(exist_ok=True)
    roots = [run_root / "native-appdata", run_root / "native-appcache", run_root / "native-appconfig"]
    for root in roots:
        for path in root.rglob("*.log"):
            if path.stat().st_size <= 10_000_000:
                target = destination / ("logs-" + root.name) / path.relative_to(root)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
    # macOS dirs::cache_dir ignores the QA app override. Only copy JDTLS
    # workspaces whose ownership marker points inside this exact run.
    if platform.system() != "Windows":
        base = (Path.home() / "Library/Caches/jdtls-ws" if platform.system() == "Darwin"
                else run_root / "native-appcache/jdtls-ws")
        for marker in base.glob("*/.taomni-workspace"):
            workspace = Path(marker.read_text().strip()).resolve()
            if workspace.is_relative_to(run_root.resolve()):
                log = marker.parent / ".metadata/.log"
                if log.is_file():
                    shutil.copyfile(log, destination / f"jdtls-{marker.parent.name}.log")
    if failed and platform.system() == "Windows":
        script = r'''
        Get-Process | Where-Object { $_.Name -match 'taomni|msedge|WerFault' } |
          Select-Object Id,ProcessName,SessionId,MainWindowTitle,MainWindowHandle |
          ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $env:QA_DIAGNOSTICS 'processes.json')
        Add-Type -AssemblyName System.Windows.Forms,System.Drawing
        $bounds=[Windows.Forms.SystemInformation]::VirtualScreen
        $image=New-Object Drawing.Bitmap $bounds.Width,$bounds.Height
        $graphics=[Drawing.Graphics]::FromImage($image)
        $graphics.CopyFromScreen($bounds.Location,[Drawing.Point]::Empty,$bounds.Size)
        $image.Save((Join-Path $env:QA_DIAGNOSTICS 'desktop.png'))
        $graphics.Dispose(); $image.Dispose()
        '''
        subprocess.run(["pwsh.exe", "-NoProfile", "-Command", script],
                       env={**os.environ, "QA_DIAGNOSTICS": str(destination.resolve())},
                       capture_output=True, timeout=20)
