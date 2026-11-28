"""Select an independently indexed, public OS path, or report unavailable coverage."""
import json
import os
import platform
import subprocess
from pathlib import Path

from . import explorer_global_search
from .explorer_files import path_attribute_match


def system_index_target() -> tuple[str, Path | None, str]:
    system = platform.system()
    if system == "Linux":
        target = Path("/usr/bin/dpkg-architecture")
        provider = "plocate"
        cmd = ["/usr/bin/plocate", "-0", "-l", "25", "--", str(target)]
    elif system == "Darwin":
        target = None
        provider = "spotlight"
        cmd = ["/usr/bin/mdfind", "-0", "-onlyin", "/System/Applications",
               'kMDItemFSName == "Calculator.app" || kMDItemFSName == "Dictionary.app"']
    elif system == "Windows":
        target = None
        provider = "windowsSearch"
        # Query the index independently of the product's WinRT StorageFolder adapter.
        script = """
        $ErrorActionPreference='Stop'
        [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
        $conn=New-Object -ComObject ADODB.Connection
        try {
          $conn.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
          $rows=$conn.Execute("SELECT TOP 64 System.ItemPathDisplay FROM SystemIndex WHERE System.FileExtension = '.lnk'")
          while (!$rows.EOF) {
            $path=[string]$rows.Fields.Item(0).Value
            if ($path.StartsWith($env:ProgramData + '\\', [StringComparison]::OrdinalIgnoreCase)) {
              [Console]::Write($path); [Console]::Write([char]0)
            }
            $rows.MoveNext()
          }
          $rows.Close()
        } finally { if ($conn.State -eq 1) { $conn.Close() } }
        """
        cmd = [str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
               "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]
    else:
        raise ValueError(f"Unexpected desktop platform {system}")
    try:
        output = subprocess.run(cmd, capture_output=True, timeout=8, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return provider, None, type(exc).__name__
    if output.returncode:
        return provider, None, f"Reference query exited {output.returncode}"
    for raw in output.stdout.decode("utf-8", errors="replace").split("\0"):
        if not raw:
            continue
        path = Path(raw)
        if ((target is None or path == target) and path.is_absolute() and path.exists()
                and not path.is_symlink() and 2 <= len(path.name) <= 96):
            return provider, path, "Public result outside fallback roots"
    return provider, None, "No accessible public control returned by the independent index"


def setup(ctx) -> None:
    explorer_global_search.setup(ctx)
    provider, path, detail = system_index_target()
    if path is not None:
        expected = path_attribute_match(path.as_posix())
        source = f'[data-provider="{provider}"]'
        query = path.name
    else:
        expected = ctx.values["global_file_match"]
        source = "[data-provider]"
        query = ctx.values["global_file"]
    ctx.values.update({
        "index_probe_query": query,
        "index_probe_source": source,
        "index_probe_result": expected,
    })
    receipt = {"provider": provider, "independentIndexHit": path is not None,
               "path": path.as_posix() if path else None, "detail": detail}
    (ctx.case_dir / "index-probe.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
