"""Non-sensitive saved-session rows for real mobile service projection checks."""
from pathlib import Path
from .session_config import seed_sessions, ssh_session


def setup(ctx):
    sessions = [ssh_session('mobile-saved-ssh', {'passwordRef': 'vault:qa-sensitive-reference'}, host='private-mobile-host.invalid', user='private-mobile-user')]
    for kind in ('RDP', 'MySQL', 'VNC'):
        sessions.append({**ssh_session('mobile-hidden-' + kind, {}), 'session_type': kind})
    seed_sessions(ctx, sessions)
    ctx.values["mobile_native_receipt"] = str((Path(ctx.case_dir) / "mobile-native-receipt.json").resolve())
    ctx.values["mobile_headless_receipt"] = str((Path(ctx.case_dir) / "headless-receipt.json").resolve())
