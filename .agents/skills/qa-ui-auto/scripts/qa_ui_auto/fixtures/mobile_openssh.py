"""Real child-process ownership test; a deterministic ssh executable blocks probe.

This verifies cancellation/registration, not Kerberos interoperability. Only this
isolated QA app inherits PATH; the user's SSH executable remains untouched.
"""
import json
import os
from pathlib import Path
import sys
from .session_config import seed_sessions, ssh_session
from .backup_policy import isolated_data_root


def setup(ctx):
    isolated_data_root(ctx)
    root = Path(ctx.case_dir).resolve()
    folder = root / 'openssh-bin'
    folder.mkdir()
    peer = folder / 'ssh'
    peer.write_text('#!' + sys.executable + '\n' + '''import json,os,pathlib,sys,time
root=pathlib.Path(__file__).resolve().parents[1]
with (root/'openssh-events.jsonl').open('a') as f:
 f.write(json.dumps({'pid':os.getpid(),'launch':'-tt' in sys.argv})+'\\n')
if '-tt' not in sys.argv:
 while not (root/'probe-release').exists():time.sleep(0.05)
''', encoding='utf-8')
    peer.chmod(0o700)
    ctx._mobile_openssh_path = os.environ.get('PATH', '')
    os.environ['PATH'] = str(folder) + os.pathsep + ctx._mobile_openssh_path
    seed_sessions(ctx, [ssh_session('QA cancelled OpenSSH', {'networkSettings': {'proxyKind': 'none'}}, host='127.0.0.1', user='qa-ticket-user', auth='Gssapi')])
    ctx.values['mobile_openssh_receipt'] = str(root / 'mobile-openssh-receipt.json')


def teardown(ctx):
    if hasattr(ctx, '_mobile_openssh_path'):
        os.environ['PATH'] = ctx._mobile_openssh_path
        del ctx._mobile_openssh_path
