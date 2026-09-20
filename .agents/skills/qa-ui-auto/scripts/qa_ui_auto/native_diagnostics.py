"""Collect bounded logs from this run's native processes before profile teardown."""
import os
from pathlib import Path
import platform
import shutil
import subprocess
import json


def windows_startup_probe(binary: Path, report: Path):
    """Distinguish executable startup failures from WebView2 driver handshakes."""
    from native_build import verify_identity
    from tauri_webdriver import native_isolation_env

    verify_identity(binary)
    root = report / "startup-probe"
    root.mkdir(parents=True, exist_ok=True)
    environment = native_isolation_env(root)
    for directory in environment.values():
        Path(directory).mkdir(parents=True, exist_ok=True)
    with (root / "app.log").open("w", encoding="utf-8") as log:
        process = subprocess.Popen([str(binary)], stdout=log, stderr=subprocess.STDOUT,
                                   env={**os.environ, **environment, "RUST_BACKTRACE": "1"})
        try:
            try:
                exit_code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                exit_code = None
            collect(root, root, failed=True)
            (root / "startup.json").write_text(json.dumps({"pid": process.pid, "exit_code": exit_code,
                "alive_after_10s": exit_code is None}), encoding="utf-8")
            if exit_code is not None:
                raise RuntimeError(f"QA executable exited before driver startup ({exit_code}); see startup-probe/app.log")
        finally:
            if process.poll() is None:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=20)
                process.wait(timeout=10)


def collect(case_dir: Path, run_root: Path, *, failed: bool):
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return
    destination = case_dir / "native-diagnostics"
    destination.mkdir(exist_ok=True)
    roots = [run_root / "native-appdata", run_root / "native-appcache", run_root / "native-appconfig"]
    for root in roots:
        for path in root.rglob("*.log"):
            if any(part.lower() in {"webview", "ebwebview"} for part in path.relative_to(root).parts):
                continue  # WebView LevelDB .log files are profile data, not diagnostic text.
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
            if workspace.is_relative_to(case_dir.resolve()):
                log = marker.parent / ".metadata/.log"
                if log.is_file() and log.stat().st_size <= 10_000_000:
                    shutil.copyfile(log, destination / f"jdtls-{marker.parent.name}.log")
    if failed and platform.system() == "Windows":
        script = r'''
        Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'taomni|msedge|WerFault' } |
          Select-Object ProcessId,Name,SessionId,CommandLine,ExecutablePath |
          ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $env:QA_DIAGNOSTICS 'processes.json')
        $profile = Join-Path $env:NEWMOB_DATA_DIR 'com.taomni.app.qa\webview'
        if (Test-Path $profile) {
          Get-ChildItem -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue |
            Select-Object FullName,PSIsContainer,Length |
            ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $env:QA_DIAGNOSTICS 'webview-profile-tree.json')
        }
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
