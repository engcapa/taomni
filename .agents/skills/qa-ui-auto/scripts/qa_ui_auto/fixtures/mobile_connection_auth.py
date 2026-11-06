"""Ephemeral loopback SSH peer and previous-version session rows; all OSes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from .session_config import ssh_session


def app_proxy_fixture_path(ctx):
    from native_build import QA_APP_ID
    from .backup_policy import isolated_data_root
    isolated_data_root(ctx)  # validates all native isolation roots before writes
    override = os.environ.get('NEWMOB_CONFIG_DIR')
    # resolved_config_dir uses qa_override_path on Windows/macOS, appending
    # the QA application ID. Linux's XDG config root is used directly.
    config_root = Path(override) / QA_APP_ID if override else Path(os.environ['XDG_CONFIG_HOME'])
    return config_root / 'taomni' / 'proxy.json'


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
        sessions = [
            ssh_session('QA phone password', options, host='127.0.0.1', port=config['port'], user='old-user', auth='Password'),
            ssh_session('QA phone OTP', options, host='127.0.0.1', port=config['port'], user='qa-otp-user', auth='Password'),
            ssh_session('QA phone private key', options, host='127.0.0.1', port=config['port'], user='qa-key-user', auth={'PrivateKey': {'key_path': config['keyPath']}}),
        ]
        for name, auth, user in [('jump OTP', 'Password', 'qa-otp-user'), ('jump private key', 'PrivateKey', 'qa-key-user')]:
            network = {'proxyKind': 'ssh-tunnel', 'jumpHost': '127.0.0.1', 'jumpPort': str(config['port']), 'jumpUser': user,
                       'jumpAuthKind': auth, 'jumpPassword': 'unused-factor', 'jumpKeyPath': config['keyPath']}
            sessions.append(ssh_session('QA phone ' + name, {'networkSettings': network}, host='127.0.0.1', port=config['port'], user='old-user', auth='Password'))
        for name, kind, port in [('HTTP proxy', 'http', config['httpPort']), ('SOCKS proxy', 'socks5', config['socksPort']), ('app proxy', 'app', config['httpPort']), ('custom proxy', 'custom', config['socksPort'])]:
            custom = {'enabled': True, 'mode': 'manual', 'kind': 'socks5', 'host': '127.0.0.1', 'port': port, 'username': 'saved-proxy-user', 'password_ref': 'vault:qa-proxy-locked', 'session_id': ''}
            network = {'proxyKind': kind, 'proxyHost': '127.0.0.1', 'proxyPort': str(port), 'proxyUser': 'saved-proxy-user', 'proxyPass': 'vault:qa-proxy-locked', 'customProxy': custom}
            sessions.append(ssh_session('QA phone ' + name, {'networkSettings': network}, host='127.0.0.1', port=config['port'], user='old-user', auth='Password'))
        proxy_path = app_proxy_fixture_path(ctx)
        proxy_path.parent.mkdir(parents=True, exist_ok=True)
        proxy_path.write_text(json.dumps({'enabled': True, 'mode': 'manual', 'kind': 'http', 'host': '127.0.0.1', 'port': config['httpPort'], 'username': 'saved-proxy-user', 'password_ref': 'vault:qa-proxy-locked', 'session_id': ''}), encoding='utf-8')
        return sessions
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
