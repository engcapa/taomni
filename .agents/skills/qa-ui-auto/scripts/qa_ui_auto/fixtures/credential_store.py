"""Unlock only a hosted disposable Secret Service, never a developer's keyring."""
import os
import platform
import secrets
import subprocess
from typing import Any


def setup(ctx: Any) -> None:
    if ((ctx.cfg.get("app") or {}).get("mode") != "native"
            or platform.system() != "Linux"
            or os.environ.get("GITHUB_ACTIONS") != "true"):
        return
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise RuntimeError("Native credential fixture requires the hosted private D-Bus session")
    # Desktop sessions may already have activated a locked daemon before the
    # native harness installed its run-owned XDG roots. Replace that service
    # on this disposable bus so unlock and the application use the same store.
    from pathlib import Path
    from tauri_webdriver import native_isolation_env
    expected = native_isolation_env(Path(ctx.report_root))
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Credential fixture requires run-owned native storage")
    subprocess.run(["gnome-keyring-daemon", "--replace", "--unlock", "--components=secrets"],
                   input="qa-disposable-backup-keyring\n", text=True,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20)
    # A successful daemon exit does not prove that the default collection is
    # writable/unlocked. Exercise the real service before launching the app.
    token = secrets.token_hex(16)
    probe = ["secret-tool"]
    kwargs = dict(text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20)
    try:
        subprocess.run(probe + ["store", "--label=Taomni QA readiness", "qa-readiness", token],
                       input=token, **kwargs)
        actual = subprocess.run(probe + ["lookup", "qa-readiness", token], **kwargs)
        if actual.stdout.strip() != token:
            raise RuntimeError("Hosted Secret Service credential roundtrip differs")
    finally:
        subprocess.run(probe + ["clear", "qa-readiness", token], **kwargs)
