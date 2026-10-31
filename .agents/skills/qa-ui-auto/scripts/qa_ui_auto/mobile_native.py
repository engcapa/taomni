"""External HTTP/WS oracle driven by real desktop settings and real PTY input."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
from .mobile_wire import http, Ws
from .steps import StepError
from .terminal_burst_probe import click, until, PANE

ORIGIN = 'https://mobile.qa.invalid'


def text(ctx, selector):
    return ctx.session.execute('return document.querySelector(' + json.dumps(selector) + ')?.textContent || ""')


def address(ctx):
    status = text(ctx, '[data-testid="mobile-settings-status"]')
    match = re.search(r'http://127\.0\.0\.1:\d+', status)
    if not match:
        raise StepError('Real mobile listener address was not displayed')
    return match.group()


def code(ctx):
    previous = text(ctx, '[data-testid="mobile-settings-code"]')
    click(ctx.session, '[data-testid="mobile-settings-pair"]')
    until(ctx.session, 'document.querySelector(\'[data-testid="mobile-settings-code"]\')?.textContent && '
          'document.querySelector(\'[data-testid="mobile-settings-code"]\').textContent !== ' + json.dumps(previous))
    return text(ctx, '[data-testid="mobile-settings-code"]')


def pair(endpoint, code):
    status, _, value = http(endpoint, '/pair', body={'endpoint_label': 'qa-phone', 'pairing_code': code}, origin=ORIGIN)
    if status != 200:
        raise StepError('Real pairing failed: ' + str(status))
    return value['device_id'], value['token']


def desktop(ctx, terminal_input):
    endpoint = address(ctx)
    checks = []
    sockets = []
    try:
        assert http(endpoint, '/sessions')[0] == 401
        device, token = pair(endpoint, text(ctx, '[data-testid="mobile-settings-code"]'))
        other, token2 = pair(endpoint, code(ctx))
        assert device != other
        status, headers, _ = http(endpoint, '/sessions', token, origin=ORIGIN, method='OPTIONS')
        assert status == 204 and headers.get('access-control-allow-origin', headers.get('Access-Control-Allow-Origin')) == ORIGIN
        assert not any(k.lower() == 'access-control-allow-credentials' for k in headers)
        assert http(endpoint, '/sessions', token, origin='https://evil.qa.invalid')[0] == 403
        checks.append('auth-and-two-level-cors')
        status, _, value = http(endpoint, '/sessions', token, origin=ORIGIN)
        assert status == 200
        saved = value['saved_sessions']
        assert [s['id'] for s in saved] == ['mobile-saved-ssh']
        assert set(saved[0]) == {'id', 'name', 'session_type', 'group_path'}
        assert 'private-mobile' not in json.dumps(value) and 'passwordRef' not in json.dumps(value)
        terminals = [v for v in value['sessions'] if v['kind'] == 'terminal' and v['status'] == 'running']
        assert len(terminals) == 1, terminals
        terminal_id = terminals[0]['id']
        from urllib.parse import quote
        route = '/terminals/' + quote(terminal_id, safe='') + '/stream'
        a, b = Ws(endpoint, route, token, ORIGIN), Ws(endpoint, route, token2, ORIGIN)
        sockets.extend([a, b])
        a.receive('replay'); b.receive('replay')
        a.send({'type': 'resize', 'cols': 250, 'rows': 60})
        assert a.receive('error')['code'] == 'not_holder'
        a.send({'type': 'take-control'})
        while a.receive('control')['holder'] != 'mobile:' + device:
            pass
        b.send({'type': 'take-control'})
        assert b.receive('error')['code'] == 'control_busy'
        b.send({'type': 'input', 'data_b64': base64.b64encode(b'not permitted').decode()})
        assert b.receive('error')['code'] == 'not_holder'
        marker = 'QA_MOBILE_REAL_SHARED_PTY'
        a.send({'type': 'input', 'data_b64': base64.b64encode(('echo ' + marker + '\r').encode()).decode()})
        for ws in (a, b):
            output = ''
            while marker not in output:
                output += base64.b64decode(ws.receive('output')['data_b64']).decode(errors='replace')
        checks.append('two-devices-real-pty-output-and-write-lock')
        # Activate the actual terminal tab, then use the existing native input
        # verb. Neither the IPC command nor terminal registry handlers are called.
        tab = ctx.session.execute('return [...(window.__taomni_terminal_registry__?.entries?.values() || [])][0]?.tabId')
        assert isinstance(tab, str) and tab
        click(ctx.session, '[data-testid="tab-item"][data-tab-id=' + json.dumps(tab) + ']')
        until(ctx.session, '!!document.querySelector(' + json.dumps(PANE) + ')')
        terminal_input(ctx, {'selector': PANE + ' .xterm-helper-textarea', 'text': 'echo QA_DESKTOP_RECLAIMED', 'submit': True,
                             'verify': {'selector': PANE, 'regex': '(?m)^QA_DESKTOP_RECLAIMED\\s*$', 'timeout_sec': 15}})
        a.receive('control-lost')
        a.send({'type': 'input', 'data_b64': base64.b64encode(b'blocked').decode()})
        assert a.receive('error')['code'] == 'not_holder'
        checks.append('actual-desktop-input-reclaims-control')
        # Return to Settings through the same global entry, revoke both devices.
        click(ctx.session, '[data-testid="ribbon-settings"]')
        until(ctx.session, '!!document.querySelector(\'[data-testid="mobile-settings-refresh"]\')')
        click(ctx.session, '[data-testid="mobile-settings-refresh"]')
        until(ctx.session, 'document.querySelectorAll(\'[data-testid="mobile-settings-revoke"]\').length === 2')
        click(ctx.session, '[data-testid="mobile-settings-revoke"]')
        until(ctx.session, 'document.querySelectorAll(\'[data-testid="mobile-settings-revoke"]\').length === 1')
        assert http(endpoint, '/sessions', token)[0] == 401
        # A second device still pairs this Origin, so it remains CORS-readable.
        assert http(endpoint, '/sessions', token, origin=ORIGIN)[0] == 401
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                a.receive(timeout=max(.01, deadline - time.monotonic()))
        except (EOFError, ConnectionError):
            pass
        else:
            raise AssertionError('Revoked device WebSocket remained open')
        click(ctx.session, '[data-testid="mobile-settings-revoke"]')
        checks.append('settings-revocation-closes-existing-websocket')
        click(ctx.session, '[data-testid="mobile-settings-toggle"]')
        until(ctx.session, 'document.querySelector(\'[data-testid="mobile-settings-status"]\')?.textContent.includes("已关闭")')
        try:
            http(endpoint, '/health')
        except OSError:
            pass
        else:
            raise AssertionError('Listener survived service shutdown')
        checks.append('listener-stops-desktop-survives')
        (ctx.case_dir / 'mobile-native-receipt.json').write_text(json.dumps({'checks': checks, 'passed': True}, indent=2), encoding='utf-8')
        return ', '.join(checks)
    finally:
        for ws in sockets:
            ws.close()


def headless(ctx):
    root = (ctx.case_dir / 'headless-profile').resolve()
    root.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    for key in ('DISPLAY', 'WAYLAND_DISPLAY'):
        env.pop(key, None)
    command = [str(Path(ctx.session.application).resolve()), '--headless', '--data-dir', str(root), '--mobile-port', '0']
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    lines = queue.Queue()
    def read():
        for line in process.stdout:
            lines.put(line.strip())
    threading.Thread(target=read, daemon=True).start()
    endpoint = pairing = None
    try:
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline and not (endpoint and pairing):
            try:
                line = lines.get(timeout=.2)
            except queue.Empty:
                if process.poll() is not None:
                    raise StepError('No-display headless exited: ' + process.stderr.read()[-2000:])
                continue
            if line.startswith('Mobile endpoint: '):
                endpoint = line.removeprefix('Mobile endpoint: ')
            if line.startswith('Pairing code (5 minutes): '):
                pairing = line.removeprefix('Pairing code (5 minutes): ')
        assert endpoint and pairing, 'Headless did not start without DISPLAY'
        assert http(endpoint, '/health')[2]['run_mode'] == 'headless'
        _, token = pair(endpoint, pairing)
        value = http(endpoint, '/sessions', token, origin=ORIGIN)[2]
        assert value['sessions'] == []
        assert (root / 'taomni.db').is_file() and (root / 'mobile-devices.json').is_file()
        second = subprocess.run(command, capture_output=True, text=True, env=env, timeout=15)
        assert second.returncode != 0 and 'other Taomni mode' in second.stderr
        ws = Ws(endpoint, '/events', token, ORIGIN)
        try:
            assert ws.receive('hello')['run_mode'] == 'headless'
        finally:
            ws.close()
        import signal
        process.send_signal(signal.SIGHUP)
        rotated = lines.get(timeout=5).removeprefix('Pairing code (5 minutes): ')
        from .mobile_real_web import probe
        web_evidence = probe(endpoint, rotated, ctx.case_dir)
        process.terminate()
        assert process.wait(timeout=15) == 0
        try:
            http(endpoint, '/health')
        except OSError:
            pass
        else:
            raise AssertionError('Headless listener survived process exit')
        (ctx.case_dir / 'headless-receipt.json').write_text(json.dumps({'display': False, 'wayland_display': False, 'run_mode': 'headless',
            'profile_exclusive': True, 'terminal_count': 0, **web_evidence, 'passed': True}, indent=2), encoding='utf-8')
        return 'No-display headless health/pair/events/profile lock/shutdown passed'
    finally:
        if process.poll() is None:
            process.kill(); process.wait(timeout=10)
        process.stdout.close(); process.stderr.close()


def register(verb, terminal_input):
    @verb('mobile_service_probe')
    def run(ctx, args):
        if args == 'desktop':
            return desktop(ctx, terminal_input)
        if args == 'headless':
            return headless(ctx)
        raise StepError('mobile_service_probe requires desktop or headless')
