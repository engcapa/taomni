"""Production mobile bundle + deterministic HTTP/WS peer, browser UI only.

The real Rust listener/PTY/headless boundary belongs to TC-MOBILE-002/003 and
Rust mobile:: tests. This fixture does not claim native service evidence.
"""
from __future__ import annotations
import base64
import hashlib
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from ..mobile_wire import read_frame, write_frame
from .mobile_assets import build_snapshot


def setup(ctx):
    if ctx.cfg['app']['mode'] != 'browser':
        raise RuntimeError('mobile_web is a browser fixture')
    root = Path(__file__).resolve().parents[6]
    ctx._mobile_assets = build_snapshot(root, ctx.case_dir)
    assets = Path(ctx._mobile_assets.name)
    receipt = Path(ctx.case_dir) / 'mobile-peer.txt'
    receipt.write_text('', encoding='utf-8')
    clients = []
    lock = threading.RLock()
    import base64 as _b64
    import struct as _struct
    import time as _time
    import zlib as _zlib
    from urllib.parse import parse_qs as _parse_qs, unquote as _unquote, urlparse as _urlparse

    def png_fixture_b64(width, height, rgb):
        def chunk(tag, data):
            body = tag + data
            return _struct.pack('!I', len(data)) + body + _struct.pack('!I', _zlib.crc32(body) & 0xffffffff)
        row = b'\x00' + bytes(rgb) * width
        ihdr = _struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', _zlib.compress(row * height)) + chunk(b'IEND', b'')
        return _b64.b64encode(png).decode('ascii')

    displays = [
        {'id': 'display-0', 'name': 'Primary Display', 'width': 1920, 'height': 1080, 'primary': True},
        {'id': 'display-1', 'name': 'Secondary Display', 'width': 1280, 'height': 720, 'primary': False},
    ]
    state = {
        'paired': False, 'connection_id': 'fixture-connection', 'holder': 'none',
        'seq': 0, 'event_seq': 0, 'task': 'idle', 'open': 0, 'opens': {}, 'direct': '',
        'screen_allowed': False, 'screen_rev': 0,
        'windows': [
            {
                'id': 'win-editor', 'title': 'Notes - Taomni', 'app_name': 'Notes', 'pid': 101,
                'x': 20, 'y': 20, 'width': 960, 'height': 640, 'minimized': False, 'focused': True, 'kind': 'window',
            },
            {
                'id': 'win-term', 'title': 'Terminal', 'app_name': 'Terminal', 'pid': 102,
                'x': 80, 'y': 80, 'width': 800, 'height': 520, 'minimized': False, 'focused': False, 'kind': 'window',
            },
        ],
    }
    ctx._mobile_web_state = state
    auth_case = ctx.case_id in ('TC-MOBILE-006', 'TC-MOBILE-009')
    cancel_race = threading.Event()

    def record(text):
        with lock, receipt.open('a', encoding='utf-8') as f:
            f.write(text + '\n')

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(assets), **kwargs)

        def log_message(self, *_):
            pass

        def reply(self, status, value):
            raw = json.dumps(value).encode()
            self.send_response(status)
            self.cors()
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def cors(self):
            if self.headers.get('Origin'):
                self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Vary', 'Origin')
            self.send_header('Cache-Control', 'no-store')

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def do_POST(self):
            path = urlsplit(self.path).path
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            if path == '/api/v1/pair':
                if body.get('pairing_code') != 'qa-mobile-code':
                    return self.reply(400, {'error': 'invalid_or_expired_code'})
                state['paired'] = True
                return self.reply(200, {'connection_id': 'fixture-connection', 'device_id': 'qa-phone', 'token': 'qa-mobile-fixture-token'})
            if self.headers.get('Authorization') != 'Bearer qa-mobile-fixture-token':
                return self.reply(401, {'error': 'unauthorized'})
            if path == '/api/v1/ws-ticket':
                return self.reply(200, {'ticket': 'qa-single-use-fixture-ticket'})
            if path == '/api/v1/open-requests':
                record('OPEN ' + body.get('kind', '') + ' ' + str(body.get('saved_session_id') or ''))
                state['open'] += 1
                request_id = f"qa-open-{state['open']}"
                state['opens'][request_id] = {'round': 0 if auth_case and body.get('kind') == 'saved' else 2, 'cancelled': False}
                return self.reply(200, {'request_id': request_id, 'status': 'pending'})
            if path.startswith('/api/v1/open-requests/') and path.endswith('/auth'):
                request_id = path.split('/')[-2]
                opened = state['opens'][request_id]
                round_id = opened['round']
                if opened['cancelled'] or body.get('challenge_id') != f'{request_id}-{round_id}':
                    return self.reply(409, {'error': 'already_resolved'})
                expected = ['phone-user', 'qa-temp-secret'] if round_id == 0 else ['123456']
                if body.get('responses') != expected:
                    return self.reply(400, {'error': 'invalid_auth_response'})
                opened['round'] += 1
                record('AUTH ' + ('login' if round_id == 0 else 'otp'))
                return self.reply(200, {'status': 'accepted'})
            if path.startswith('/api/v1/open-requests/') and path.endswith('/cancel'):
                request_id = path.split('/')[-2]
                state['opens'][request_id]['cancelled'] = True
                record('CANCEL ' + request_id)
                if ctx.case_id == 'TC-MOBILE-009' and request_id == 'qa-open-1':
                    if not cancel_race.wait(10):
                        return self.reply(500, {'error': 'next_request_not_observed'})
                    record('CANCEL_RESPONSE ' + request_id)
                return self.reply(200, {'status': 'cancelled'})
            if path == '/api/v1/desktop/browser':
                url = str(body.get('url', '')).strip()
                if not url.startswith(('http://', 'https://')):
                    return self.reply(400, {'error': 'invalid_browser_url', 'message': 'Invalid URL'})
                title = 'Taomni Browser - ' + url
                for win in state['windows']:
                    win['focused'] = False
                browser_win = next((w for w in state['windows'] if w['id'] == 'tauri:mobile-remote-browser'), None)
                if browser_win is None:
                    browser_win = {
                        'id': 'tauri:mobile-remote-browser', 'title': title, 'app_name': 'Taomni', 'pid': 200,
                        'x': 40, 'y': 40, 'width': 1120, 'height': 760,
                        'minimized': False, 'focused': True, 'kind': 'tauri_browser',
                    }
                    state['windows'].insert(0, browser_win)
                else:
                    browser_win['title'] = title
                    browser_win['focused'] = True
                state['screen_rev'] += 1
                record('BROWSER ' + url)
                return self.reply(200, {
                    'ok': True, 'url': url, 'window_id': browser_win['id'],
                    'title': title, 'screen_capture_enabled': state['screen_allowed'],
                })
            if path.startswith('/api/v1/desktop/windows/') and path.endswith('/input'):
                wid = _unquote(path[len('/api/v1/desktop/windows/'):-len('/input')])
                win = next((w for w in state['windows'] if w['id'] == wid), None)
                if win is None:
                    return self.reply(404, {'error': 'window_not_found', 'message': 'Window not found'})
                text_val = str(body.get('text', ''))
                key_val = str(body.get('key', '') or '')
                submit = bool(body.get('submit', False))
                if not text_val and not key_val and not submit:
                    return self.reply(400, {'error': 'empty_window_input', 'message': 'Empty window input'})
                for item in state['windows']:
                    item['focused'] = item['id'] == wid
                state['screen_rev'] += 1
                record(f"WIN_INPUT id={wid} key={key_val or '-'} submit={1 if submit else 0} text={text_val}")
                return self.reply(200, {'ok': True, 'window_id': wid, 'title': win['title']})
            if path.endswith('/message'):
                record('AGENT ' + body.get('text', ''))
                state['task'] = 'running'
                event('task_status', task_id='thread:qa-task', status='running', summary='mobile turn')
            if path.endswith('/stop'):
                state['task'] = 'idle'
                record('AGENT STOP')
                event('task_status', task_id='thread:qa-task', status='idle', summary='stopped')
            self.reply(200, {'status': state['task']})

        def do_GET(self):
            path = urlsplit(self.path).path
            if self.headers.get('Upgrade', '').lower() == 'websocket':
                return self.websocket(path)
            if not path.startswith('/api/v1/'):
                return super().do_GET()
            if self.headers.get('Authorization') != 'Bearer qa-mobile-fixture-token':
                return self.reply(401, {'error': 'unauthorized'})
            terminal = {'id': 'term:qa-runtime', 'kind': 'terminal', 'title': 'Local shell', 'status': 'running', 'summary': 'QA terminal'}
            task = {'id': 'thread:qa-task', 'kind': 'agent', 'title': 'Review task', 'status': state['task'], 'summary': 'QA agent'}
            if path == '/api/v1/sessions':
                if ctx.case_id == 'TC-MOBILE-019':
                    sessions = [
                        {'id': f'term:{index}', 'kind': 'terminal', 'title': f'Terminal {index:02d}',
                         'status': 'running', 'summary': 'Database maintenance' if index == 17 else f'Summary {index}'}
                        for index in range(20)
                    ] + [task]
                    saved = [
                        {'id': 'build', 'name': 'Build host', 'session_type': 'SSH', 'group_path': 'Production'},
                        {'id': 'lab', 'name': 'Console', 'session_type': 'Serial', 'group_path': 'Hardware/Lab'},
                        {'id': 'local', 'name': 'Local shell', 'session_type': 'Local', 'group_path': None},
                    ] + [{'id': f'extra-{index}', 'name': f'Archive {index:02d}', 'session_type': 'SSH', 'group_path': 'Overflow/Long'} for index in range(17)]
                else:
                    sessions = [terminal, task]
                    saved = [{'id': 'saved', 'name': 'Build host', 'session_type': 'SSH', 'group_path': 'QA'}]
                return self.reply(200, {
                    'sessions': sessions, 'saved_sessions': saved,
                    'capabilities': {
                        'open_sessions': True,
                        'screen_capture': state['screen_allowed'],
                        'desktop_control': True,
                    },
                })
            if path == '/api/v1/desktop/screen':
                if not state['screen_allowed']:
                    return self.reply(403, {'error': 'screen_capture_disabled', 'message': 'Screen capture is disabled'})
                q = _parse_qs(urlsplit(self.path).query)
                did = (q.get('display') or q.get('display_id') or ['display-0'])[0]
                disp = next((d for d in displays if d['id'] == did), None)
                if disp is None:
                    return self.reply(404, {'error': 'display_not_found', 'message': 'Display not found'})
                state['screen_rev'] += 1
                color = ((30 + state['screen_rev'] * 40) % 250, 90 if did == 'display-0' else 170, 180)
                record(f"SCREEN display={did} rev={state['screen_rev']}")
                return self.reply(200, {
                    'mime': 'image/png',
                    'width': 160,
                    'height': 90,
                    'screen_width': disp['width'],
                    'screen_height': disp['height'],
                    'display_id': disp['id'],
                    'display_name': disp['name'],
                    'displays': displays,
                    'captured_at': int(_time.time()),
                    'image_b64': png_fixture_b64(160, 90, color),
                })
            if path == '/api/v1/desktop/windows':
                return self.reply(200, {'windows': state['windows'], 'screen_capture_enabled': state['screen_allowed']})
            if path.startswith('/api/v1/open-requests/'):
                request_id = path.rsplit('/', 1)[1]
                opened = state['opens'][request_id]
                if opened['cancelled']:
                    return self.reply(200, {'request_id': request_id, 'status': 'failed', 'error': 'open_cancelled'})
                if ctx.case_id == 'TC-MOBILE-009' and request_id == 'qa-open-2':
                    cancel_race.set()
                if opened['round'] < 2:
                    round_id = opened['round']
                    prompts = [{'prompt': '用户名', 'echo': True, 'initial': 'developer'}, {'prompt': '密码', 'echo': False}] if round_id == 0 else [{'prompt': '一次性验证码', 'echo': False}]
                    return self.reply(200, {'request_id': request_id, 'status': 'pending', 'auth': {'id': f'{request_id}-{round_id}', 'name': '登录账户' if round_id == 0 else 'SSH 验证码', 'instructions': '仅本次连接使用', 'prompts': prompts}})
                return self.reply(200, {'request_id': request_id, 'status': 'opened', 'session_id': 'term:qa-opened'})
            if path.startswith('/api/v1/sessions/'):
                return self.reply(200, {**task, 'confirmations': []})
            if path.endswith('/changes'):
                return self.reply(200, {'changes': [{'path': 'hello.txt', 'change_kind': 'M', 'diff_available': True}]})
            if path.endswith('/diff'):
                return self.reply(200, {'path': 'hello.txt', 'hunks': ['diff --git a/hello.txt b/hello.txt\n', '@@ -1 +1 @@\n-old\n+QA_MOBILE_CHANGED\n'], 'truncated': False})
            return self.reply(200, {'path': 'hello.txt', 'content': 'QA_MOBILE_CHANGED\n', 'truncated': False})

        def websocket(self, path):
            key = self.headers['Sec-WebSocket-Key']
            accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            self.send_response(101)
            self.send_header('Upgrade', 'websocket')
            self.send_header('Connection', 'Upgrade')
            self.send_header('Sec-WebSocket-Accept', accept)
            self.end_headers()
            is_term = '/terminals/' in path
            def send(value):
                with lock:
                    write_frame(self.wfile, json.dumps(value))
            with lock:
                clients.append((is_term, send))
            try:
                send({'type': 'hello', 'connection_id': 'fixture-connection', 'instance_id': 'qa', 'run_mode': 'desktop', 'event_seq': state['event_seq']})
                if is_term:
                    lines = [f'QA_MOBILE_LOG_{i:03d}' for i in range(120)] + ['QA_MOBILE_REPLAY', '$ ']
                    send({'type': 'replay', 'lines': lines, 'last_seq': state['seq']})
                    send({'type': 'control', 'connection_id': 'fixture-connection', 'holder': state['holder']})
                while True:
                    opcode, payload = read_frame(self.rfile)
                    if opcode == 8:
                        break
                    if opcode != 1:
                        continue
                    value = json.loads(payload)
                    kind = value.get('type')
                    if kind == 'take-control':
                        state['holder'] = 'mobile:qa-phone'
                        send({'type': 'control', 'connection_id': 'fixture-connection', 'holder': state['holder']})
                    elif kind == 'release-control':
                        state['holder'] = 'none'
                        send({'type': 'control', 'connection_id': 'fixture-connection', 'holder': 'none'})
                    elif kind == 'input':
                        text = base64.b64decode(value['data_b64']).decode()
                        # Escaped so control keys stay readable and line-safe in the receipt.
                        record('PTY ' + text.encode('unicode_escape').decode('ascii'))
                        state['direct'] = (state['direct'] + text)[-32:]
                        if state['direct'].endswith('git che\t'):
                            record('DIRECT git che\\t')
                        state['seq'] += 1
                        send({'type': 'output', 'seq': state['seq'], 'data_b64': base64.b64encode(('\r\n' + text).encode()).decode()})
                    elif kind == 'resize':
                        record('RESIZE')
            except (OSError, EOFError):
                pass
            finally:
                with lock:
                    clients.remove((is_term, send))

    def event(kind, **fields):
        with lock:
            state['event_seq'] += 1
            for terminal, send in list(clients):
                if not terminal:
                    send({'type': kind, 'seq': state['event_seq'], **fields})
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ctx._mobile_web_server = server
    ctx.values['mobile_endpoint'] = f'http://127.0.0.1:{server.server_port}'
    ctx.values['mobile_endpoint2'] = f'http://localhost:{server.server_port}'
    ctx.values['mobile_receipt'] = str(receipt.resolve())
    ctx.values['mobile_assets'] = str(assets.resolve())
    if ctx.case_id == 'TC-MOBILE-012':
        ctx.values['mobile_cookie_receipt'] = str((Path(ctx.case_dir) / 'mobile-cookie-gateway-receipt.json').resolve())


def teardown(ctx):
    server = getattr(ctx, '_mobile_web_server', None)
    if server:
        server.shutdown()
        server.server_close()
    snapshot = getattr(ctx, '_mobile_assets', None)
    if snapshot:
        snapshot.cleanup()
