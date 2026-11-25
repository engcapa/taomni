"""Launch the isolated QA WebView and observe its process during restore."""

import json
from pathlib import Path
import subprocess

from native_driver_lifecycle import driver_start_environment
from native_webdriver_transport import WebDriverError


def launch(driver, cwd, stdout_path, stderr_path):
    if not driver.application.is_file():
        raise WebDriverError(f"QA application not found: {driver.application}")
    env = driver_start_environment(driver)
    env["TAOMNI_QA_WEBDRIVER_HOST"] = driver.host
    env["TAOMNI_QA_WEBDRIVER_PORT"] = str(driver.port)
    command = [str(driver.application.resolve())]
    if driver.macos_lldb:
        command = ["lldb", "--batch", "-o", "settings set target.disable-aslr false",
                   "-o", "run", "-k", "thread backtrace all", "-k", "process kill", "--", *command]
    with stdout_path.open("a", encoding="utf-8") as stdout, stderr_path.open("a", encoding="utf-8") as stderr:
        return subprocess.Popen(command, start_new_session=driver.macos_lldb, cwd=cwd, env=env,
                                stdout=stdout, stderr=stderr, text=True)


def identity(pid):
    import psutil

    try:
        proc = psutil.Process(pid)
        if proc.status() == psutil.STATUS_ZOMBIE:
            return None
        return {"pid": pid, "started": proc.create_time(), "executable": str(Path(proc.exe()).resolve())}
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def environment(pid, keys):
    import psutil

    result = psutil.Process(pid).environ()
    return {key: result[key] for key in keys if key in result}


def listener_pid(port):
    import psutil

    pids = {item.pid for item in psutil.net_connections(kind="tcp4")
            if item.status == psutil.CONN_LISTEN and item.laddr == ("127.0.0.1", port)}
    if not pids:
        return None
    if len(pids) != 1 or None in pids:
        raise RuntimeError("QA bridge must have exactly one observable listener process")
    return pids.pop()


def capture_desktop(target, system):
    from PIL import ImageGrab

    target.parent.mkdir(parents=True, exist_ok=True)
    ImageGrab.grab().save(target, format="PNG")
    target.with_suffix(target.suffix + ".metadata.json").write_text(
        json.dumps({"capture_kind": "desktop", "platform": system, "actor": "Pillow.ImageGrab"}),
        encoding="utf-8",
    )
    return str(target)
