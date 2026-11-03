"""Ephemeral loopback SSH peer and previous-version session rows; all OSes."""
import json
from pathlib import Path
import shutil
import subprocess
from .session_config import ssh_session


def start(ctx):
    root = Path(__file__).resolve().parents[6]
    script = Path(__file__).with_name('mobile_ssh_peer.cjs')
    stderr = (Path(ctx.case_dir) / 'mobile-ssh-peer.stderr').open('w', encoding='utf-8')
    process = subprocess.Popen([shutil.which('node') or 'node', str(script), str(Path(ctx.case_dir).resolve())],
                               cwd=root, stdout=subprocess.PIPE, stderr=stderr, text=True, encoding='utf-8')
    ctx._mobile_ssh_peer = process
    ctx._mobile_ssh_stderr = stderr
    try:
        from queue import Queue
        from threading import Thread
        ready = Queue()
        Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        config = json.loads(ready.get(timeout=20))
        ctx.values['mobile_auth_receipt'] = str((Path(ctx.case_dir) / 'mobile-connection-auth-receipt.json').resolve())
        ctx.values['mobile_ssh_marker'] = str((Path(ctx.case_dir) / 'mobile-ssh-input-marker.txt').resolve())
        options = {'networkSettings': {'proxyKind': 'none'}, 'x11': False}
        return [
            ssh_session('QA phone password', options, host='127.0.0.1', port=config['port'], user='old-user', auth='Password'),
            ssh_session('QA phone OTP', options, host='127.0.0.1', port=config['port'], user='qa-otp-user', auth='Password'),
            ssh_session('QA phone private key', options, host='127.0.0.1', port=config['port'], user='qa-key-user', auth={'PrivateKey': {'key_path': config['keyPath']}}),
        ]
    except BaseException:
        stop(ctx)
        raise


def stop(ctx):
    process = getattr(ctx, '_mobile_ssh_peer', None)
    if process:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill(); process.wait(timeout=5)
        process.stdout.close()
        ctx._mobile_ssh_peer = None
    stderr = getattr(ctx, '_mobile_ssh_stderr', None)
    if stderr:
        stderr.close(); ctx._mobile_ssh_stderr = None
