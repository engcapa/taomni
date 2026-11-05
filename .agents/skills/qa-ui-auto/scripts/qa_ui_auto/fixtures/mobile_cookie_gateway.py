"""Loopback-only authenticated reverse proxy for browser/native phone contracts.

The cookie authenticates this test gateway, never Taomni. Forwarded requests keep
Authorization/Origin but strip Cookie. Only sanitized metadata enters receipts.
"""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
from pathlib import Path
import secrets
import select
import socket
import threading
from urllib.parse import urlsplit

HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
               'te', 'trailer', 'transfer-encoding', 'upgrade'}
COOKIE = 'qa_mobile_gateway'


def route_name(path):
    if path.startswith('/api/v1/terminals/'):
        return '/api/v1/terminals/<id>/stream'
    if path.startswith('/api/v1/sessions/'):
        return '/api/v1/sessions/<id>'
    return path if path in ('/api/v1/pair', '/api/v1/health', '/api/v1/ws-ticket',
                            '/api/v1/events', '/api/v1/sessions') else '/shell'


class CookieGateway:
    def __init__(self, endpoint, *, require_cookie=True, assets=None):
        target = urlsplit(endpoint)
        if target.scheme != 'http' or target.hostname not in ('127.0.0.1', 'localhost') or not target.port:
            raise ValueError('Cookie gateway requires an explicit loopback HTTP backend')
        self.target = target
        self.require_cookie = require_cookie
        self.assets = Path(assets) if assets else None
        self.cookie = secrets.token_hex(24)
        self.records = []
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.sockets = set()
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def reply(self, status, body, headers=()):
                self.send_response(status)
                for key, value in headers:
                    if key.lower() not in HOP_HEADERS | {'content-length', 'set-cookie'}:
                        self.send_header(key, value)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)

            def handle_request(self):
                path = urlsplit(self.path).path
                cookie = SimpleCookie()
                try:
                    cookie.load(self.headers.get('Cookie', ''))
                except Exception:
                    pass
                supplied = cookie.get(COOKIE)
                allowed = supplied is not None and secrets.compare_digest(supplied.value, gateway.cookie)
                record = {'method': self.command, 'route': route_name(path), 'cookie_present': supplied is not None,
                          'bearer_present': self.headers.get('Authorization', '').startswith('Bearer '),
                          'upgrade': self.headers.get('Upgrade', '').lower() == 'websocket'}
                with gateway.lock:
                    gateway.records.append(record)
                # Explicit fixture-only login models the user's preexisting SLB session.
                if path == '/qa-gateway-login':
                    self.send_response(303)
                    self.send_header('Set-Cookie', f'{COOKIE}={gateway.cookie}; Path=/; HttpOnly; SameSite=Lax')
                    self.send_header('Location', '/')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    record['status'] = 303
                    return
                if gateway.require_cookie and not allowed:
                    record['status'] = 401
                    self.close_connection = True
                    self.reply(401, b'{"error":"gateway_auth_required"}', [('Content-Type', 'application/json')])
                    return
                headers = {k: v for k, v in self.headers.items()
                           if k.lower() not in HOP_HEADERS | {'host', 'cookie', 'content-length'}}
                headers['Host'] = gateway.target.netloc
                headers['Connection'] = 'close'
                if record['upgrade']:
                    self.tunnel(headers, record)
                    return
                if gateway.assets and self.command == 'GET' and not path.startswith('/api/'):
                    relative = 'index.html' if path == '/' else path.lstrip('/')
                    asset = (gateway.assets / relative).resolve()
                    if not asset.is_relative_to(gateway.assets.resolve()) or not asset.is_file():
                        record['status'] = 404
                        self.reply(404, b'Not found')
                        return
                    import mimetypes
                    kind = mimetypes.guess_type(asset.name)[0] or 'application/octet-stream'
                    record['status'] = 200
                    self.reply(200, asset.read_bytes(), [('Content-Type', kind)])
                    return
                length = int(self.headers.get('Content-Length', '0'))
                if length > 65536:
                    record['status'] = 413
                    self.reply(413, b'{}')
                    return
                body = self.rfile.read(length) if length else None
                upstream = http.client.HTTPConnection(gateway.target.hostname, gateway.target.port, timeout=15)
                try:
                    upstream.request(self.command, self.path, body=body, headers=headers)
                    response = upstream.getresponse()
                    data = response.read()
                    record['status'] = response.status
                    self.reply(response.status, data, response.getheaders())
                finally:
                    upstream.close()

            def tunnel(self, headers, record):
                headers.update(Connection='Upgrade', Upgrade='websocket')
                upstream = socket.create_connection((gateway.target.hostname, gateway.target.port), timeout=10)
                with gateway.lock:
                    gateway.sockets.update((self.connection, upstream))
                try:
                    # Query contains a one-use WS ticket. Never retain it in records/logs.
                    request = f'{self.command} {self.path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers.items()) + '\r\n'
                    upstream.sendall(request.encode('latin-1'))
                    response = bytearray()
                    while not response.endswith(b'\r\n\r\n') and len(response) < 65536:
                        chunk = upstream.recv(1)
                        if not chunk:
                            raise ConnectionError('Backend closed during WS upgrade')
                        response.extend(chunk)
                    status = int(bytes(response).split(b' ', 2)[1])
                    record['status'] = status
                    self.connection.sendall(response)
                    if status != 101:
                        return
                    self.close_connection = True
                    while not gateway.stop.is_set():
                        readable, _, _ = select.select((self.connection, upstream), (), (), .2)
                        for source in readable:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is self.connection else self.connection).sendall(data)
                finally:
                    with gateway.lock:
                        gateway.sockets.difference_update((self.connection, upstream))
                    upstream.close()

            def safe_handle(self):
                try:
                    self.handle_request()
                except (OSError, ValueError):
                    self.close_connection = True

            do_GET = safe_handle
            do_POST = safe_handle
            do_OPTIONS = safe_handle

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.worker.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        with self.lock:
            active = list(self.sockets)
        for connection in active:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(5)
