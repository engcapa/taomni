"""Real reverse-proxy cookie enforcement and forwarding isolation contracts."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from .fixtures.mobile_cookie_gateway import COOKIE, CookieGateway, route_name


class CookieGatewayTest(unittest.TestCase):
    def test_cookie_is_gateway_only_and_never_replaces_backend_bearer(self):
        observed = []
        class Backend(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self):
                observed.append({'cookie': self.headers.get('Cookie'), 'bearer': self.headers.get('Authorization')})
                raw = b'{}'
                self.send_response(200 if self.headers.get('Authorization') == 'Bearer qa-token' else 401)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Backend)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with CookieGateway(f'http://127.0.0.1:{server.server_port}') as gateway:
                def get(path, headers=None):
                    connection = http.client.HTTPConnection('127.0.0.1', gateway.server.server_port, timeout=5)
                    connection.request('GET', path, headers=headers or {})
                    response = connection.getresponse()
                    value = response.status, dict(response.getheaders()), response.read()
                    connection.close()
                    return value
                self.assertEqual(get('/api/v1/sessions')[0], 401)
                self.assertEqual(observed, [])
                status, headers, _ = get('/qa-gateway-login')
                self.assertEqual(status, 303)
                self.assertIn('HttpOnly', headers['Set-Cookie'])
                cookie = headers['Set-Cookie'].split(';')[0]
                self.assertEqual(get('/api/v1/sessions', {'Cookie': cookie})[0], 401)
                self.assertEqual(get('/api/v1/sessions', {'Cookie': cookie, 'Authorization': 'Bearer qa-token'})[0], 200)
                self.assertEqual(observed, [{'cookie': None, 'bearer': None}, {'cookie': None, 'bearer': 'Bearer qa-token'}])
                self.assertNotIn(gateway.cookie, json.dumps(gateway.records))
                self.assertNotIn('qa-token', json.dumps(gateway.records))
                self.assertEqual(get('/api/v1/health', {'Cookie': COOKIE + '=expired'})[0], 401)
        finally:
            server.shutdown()
            server.server_close()

    def test_shell_override_cannot_escape_assets_and_receipt_omits_ids_and_tickets(self):
        with tempfile.TemporaryDirectory() as folder:
            assets = Path(folder)
            (assets / 'index.html').write_text('<html>phone</html>')
            with CookieGateway('http://127.0.0.1:1', require_cookie=False, assets=assets) as gateway:
                connection = http.client.HTTPConnection('127.0.0.1', gateway.server.server_port, timeout=5)
                connection.request('GET', '/')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b'phone', response.read())
                connection.close()
        self.assertEqual(route_name('/api/v1/terminals/private-id/stream'), '/api/v1/terminals/<id>/stream')
        self.assertEqual(route_name('/api/v1/sessions/private-id'), '/api/v1/sessions/<id>')

    def test_refuses_non_loopback_or_implicit_backend_ports(self):
        for address in ('https://example.test:443', 'http://127.0.0.1', 'http://10.1.1.1:8787'):
            with self.assertRaises(ValueError):
                CookieGateway(address)
