"""Non-sensitive saved-session rows for real mobile service projection checks."""
from pathlib import Path
from .session_config import seed_sessions, ssh_session


def setup(ctx):
    sessions = [ssh_session('mobile-saved-ssh', {'passwordRef': 'vault:qa-sensitive-reference'}, host='private-mobile-host.invalid', user='private-mobile-user')]
    for kind in ('RDP', 'MySQL', 'VNC'):
        sessions.append({**ssh_session('mobile-hidden-' + kind, {}), 'session_type': kind})
    if ctx.case_id == 'TC-MOBILE-005':
        from ..mobile_open_session import SAVED_ID, SAVED_NAME, SAVED_ARGS
        import json
        sessions.append({
            'id': SAVED_ID, 'name': SAVED_NAME, 'session_type': 'LocalShell', 'group_path': 'QA',
            'host': '', 'port': 0, 'username': None, 'auth_method': 'None',
            'options_json': json.dumps({'localShellPath': '/bin/bash', 'localShellArgs': SAVED_ARGS}),
            'created_at': 1, 'updated_at': 1, 'last_connected_at': None, 'sort_order': 0,
        })
        for name, filename in (
            ('mobile_open_receipt', 'mobile-open-session-receipt.json'),
            ('mobile_open_local_marker', 'mobile-open-local-marker.txt'),
            ('mobile_open_saved_marker', 'mobile-open-saved-marker.txt'),
        ):
            ctx.values[name] = str((Path(ctx.case_dir) / filename).resolve())
    seed_sessions(ctx, sessions)
    ctx.values["mobile_native_receipt"] = str((Path(ctx.case_dir) / "mobile-native-receipt.json").resolve())
    ctx.values["mobile_headless_receipt"] = str((Path(ctx.case_dir) / "headless-receipt.json").resolve())
