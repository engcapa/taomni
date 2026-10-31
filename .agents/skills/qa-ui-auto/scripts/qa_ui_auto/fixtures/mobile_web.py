"""Production mobile bundle + deterministic HTTP/WS peer, browser UI only.

The real Rust listener/PTY/headless boundary belongs to TC-MOBILE-002/003 and
Rust mobile:: tests. This fixture does not claim native service evidence.
"""
from __future__ import annotations
import base64
import hashlib
import json
import shutil
import subprocess
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from ..mobile_wire import read_frame, write_frame


def setup(ctx):
    if ctx.cfg['app']['mode'] != 'browser':
        raise RuntimeError('mobile_web is a browser fixture')
    root = Path(__file__).resolve().parents[6]
    build = subprocess.run([shutil.which('pnpm') or 'pnpm', 'build:mobile'], cwd=root, capture_output=True, text=True, timeout=120)
    (Path(ctx.case_dir) / 'mobile-build.log').write_text(build.stdout + build.stderr, encoding='utf-8')
    if build.returncode:
        raise RuntimeError('Mobile bundle build failed; see mobile-build.log')
    assets = root / 'src-tauri/resources/mobile-web'
    receipt = Path(ctx.case_dir) / 'mobile-peer.txt'
    receipt.write_text('', encoding='utf-8')
    clients = []
    lock = threading.RLock()
    state = {'paired': False, 'connection_id': 'fixture-connection', 'holder': 'none', 'seq': 0, 'event_seq': 0, 'task': 'idle'}

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
                return self.reply(200, {'sessions': [terminal, task], 'saved_sessions': [{'id': 'saved', 'name': 'Build host', 'session_type': 'SSH', 'group_path': 'QA'}]})
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
                    send({'type': 'replay', 'lines': ['QA_MOBILE_REPLAY', '$ '], 'last_seq': state['seq']})
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
                        record('PTY ' + text)
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


def teardown(ctx):
    server = getattr(ctx, '_mobile_web_server', None)
    if server:
        server.shutdown()
        server.server_close()
