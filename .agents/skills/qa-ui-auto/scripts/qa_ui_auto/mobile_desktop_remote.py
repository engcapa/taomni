"""Real native desktop screen capture, managed server browser and window input oracle."""
from __future__ import annotations

import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time

from playwright.sync_api import expect, sync_playwright

from . import mobile_wire
from .terminal_burst_probe import until

_HTML = """<!doctype html>
<meta charset="utf-8">
<title>QA Desktop Remote Target</title>
<body style="font-family:sans-serif;padding:24px;background:#102a43;color:#f0f4f8">
<h1>QA Target</h1>
<input id="qa-box" autofocus autocomplete="off" style="font-size:20px;padding:8px;width:320px" />
<pre id="qa-log"></pre>
<script>
  const box = document.getElementById('qa-box');
  const log = document.getElementById('qa-log');
  const post = (path, payload) => fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
    keepalive: true,
  }).catch(() => {});
  const focusBox = () => { try { window.focus(); box.focus(); } catch {} };
  window.addEventListener('focus', focusBox);
  window.addEventListener('load', () => { focusBox(); post('/loaded', {}); });
  box.addEventListener('input', () => {
    log.textContent = box.value;
    post('/event', {type: 'input', value: box.value});
  });
  document.addEventListener('keydown', (e) => {
    post('/event', {type: 'keydown', key: e.key, value: box.value});
  }, true);
</script>
</body>
"""


def _start_target_server():
    lock = threading.Lock()
    state = {'loaded': 0, 'events': []}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            return None

        def do_GET(self):
            raw = _HTML.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            length = int(self.headers.get('Content-Length', '0') or '0')
            body = json.loads(self.rfile.read(length).decode('utf-8')) if length > 0 else {}
            with lock:
                if self.path == '/loaded':
                    state['loaded'] += 1
                elif self.path == '/event':
                    state['events'].append(body)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', '2')
            self.end_headers()
            self.wfile.write(b'{}')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, lock, state


def _wait_state(lock, state, predicate, message, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with lock:
            snapshot = {'loaded': state['loaded'], 'events': list(state['events'])}
        if predicate(snapshot):
            return snapshot
        time.sleep(0.05)
    with lock:
        snapshot = {'loaded': state['loaded'], 'events': list(state['events'])}
    raise AssertionError(f'{message}: {snapshot!r}')


def run(ctx, endpoint, pairing_code):
    report = Path(ctx.case_dir).resolve()
    receipt = {'passed': False, 'checks': [], 'window_count': 0, 'display_count': 0, 'event_count': 0}
    server, lock, state = _start_target_server()
    target_url = f'http://127.0.0.1:{server.server_address[1]}/'
    try:
        status, _, pair_data = mobile_wire.http(
            endpoint, '/pair', None, {'code': pairing_code, 'device_name': 'qa-desktop-probe'}, origin=endpoint,
        )
        assert status == 200 and pair_data and pair_data.get('token'), (status, pair_data)
        token = pair_data['token']

        status, _, sessions = mobile_wire.http(endpoint, '/sessions', token, None, origin=endpoint)
        assert status == 200, (status, sessions)
        caps = (sessions or {}).get('capabilities') or {}
        assert caps.get('desktop_control') is True, caps
        assert caps.get('screen_capture') is False, caps

        status, _, blocked = mobile_wire.http(endpoint, '/desktop/screen', token, None, origin=endpoint)
        assert status == 403 and (blocked or {}).get('error') == 'screen_capture_disabled', (status, blocked)
        receipt['checks'].append('screen-capture-blocked-until-settings-opt-in')

        status, _, opened = mobile_wire.http(endpoint, '/desktop/browser', token, {'url': target_url}, origin=endpoint)
        assert status == 200 and (opened or {}).get('ok') is True, (status, opened)
        assert opened.get('window_id') == 'tauri:mobile-remote-browser', opened
        assert opened.get('screen_capture_enabled') is False, opened
        _wait_state(lock, state, lambda s: s['loaded'] >= 1, 'Remote browser did not load target URL')

        status, _, win_list = mobile_wire.http(endpoint, '/desktop/windows', token, None, origin=endpoint)
        assert status == 200, (status, win_list)
        windows = (win_list or {}).get('windows') or []
        assert any(w.get('id') == 'tauri:mobile-remote-browser' and w.get('kind') == 'tauri_browser' for w in windows), windows
        receipt['window_count'] = len(windows)
        receipt['checks'].append('server-browser-opens-external-tauri-window-and-loads-url')

        ctx.session.click('[data-testid="mobile-settings-screen-capture"]')
        until(
            ctx.session,
            '(() => { const el = document.querySelector(\'[data-testid="mobile-settings-screen-capture"]\'); '
            'return !!el && el.checked && !el.disabled; })()',
        )

        status, _, sessions_after = mobile_wire.http(endpoint, '/sessions', token, None, origin=endpoint)
        assert status == 200 and sessions_after['capabilities']['screen_capture'] is True, sessions_after

        status, _, s1 = mobile_wire.http(endpoint, '/desktop/screen', token, None, origin=endpoint)
        assert status == 200 and s1['mime'] == 'image/png' and s1['width'] > 0 and s1['height'] > 0, (status, s1)
        raw_png = base64.b64decode(s1['image_b64'])
        assert raw_png.startswith(b'\x89PNG\r\n\x1a\n'), 'Captured screen is not valid PNG'
        (report / 'mobile-native-screen-sample.png').write_bytes(raw_png)

        status, _, s2 = mobile_wire.http(endpoint, '/desktop/screen', token, None, origin=endpoint)
        assert status == 200 and s2['captured_at'] >= s1['captured_at'] and len(s2['displays']) >= 1, (status, s2)
        receipt['display_count'] = len(s2['displays'])
        receipt['checks'].append('settings-opt-in-unlocks-live-png-screen-capture-and-refresh')

        win_path = '/desktop/windows/tauri%3Amobile-remote-browser/input'
        status, _, inp1 = mobile_wire.http(endpoint, win_path, token, {'text': 'QA_DESK_77', 'submit': True}, origin=endpoint)
        assert status == 200 and (inp1 or {}).get('ok') is True, (status, inp1)
        _wait_state(
            lock, state,
            lambda s: any('QA_DESK_77' in str(e.get('value', '')) for e in s['events'])
            and any(e.get('type') == 'keydown' and e.get('key') == 'Enter' for e in s['events']),
            'Target server browser window did not receive OS text + Enter',
        )

        status, _, inp2 = mobile_wire.http(
            endpoint, win_path, token, {'text': '', 'key': 'backspace', 'submit': False}, origin=endpoint,
        )
        assert status == 200 and (inp2 or {}).get('ok') is True, (status, inp2)
        snap = _wait_state(
            lock, state,
            lambda s: any(e.get('type') == 'keydown' and e.get('key') == 'Backspace' for e in s['events'])
            and any(e.get('type') == 'input' and str(e.get('value', '')).endswith('QA_DESK_7') for e in s['events']),
            'Target server browser window did not receive Backspace key edit',
        )
        receipt['checks'].append('targeted-window-input-activates-server-browser-and-delivers-keystrokes')

        ctx.session.click('[data-testid="mobile-settings-pair"]')
        until(
            ctx.session,
            '(() => { const el = document.querySelector(\'[data-testid="mobile-settings-code"]\'); '
            'const btn = document.querySelector(\'[data-testid="mobile-settings-pair"]\'); '
            'return !!el && !!btn && !btn.disabled && el.textContent.trim().length > 0 '
            '&& el.textContent.trim() !== ' + json.dumps(pairing_code) + '; })()',
        )
        pw_code = ctx.session.execute(
            'return document.querySelector(\'[data-testid="mobile-settings-code"]\').textContent.trim()'
        )

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, service_workers='block')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            try:
                page.goto(endpoint, wait_until='networkidle')
                page.get_by_test_id('mobile-first-instance').click()
                page.get_by_test_id('mobile-endpoint').fill(endpoint)
                page.get_by_test_id('mobile-label').fill('Desktop remote phone')
                page.get_by_test_id('mobile-pair-code').fill(pw_code)
                page.get_by_test_id('mobile-pair-submit').click()
                expect(page.get_by_test_id('mobile-open-desktop')).to_be_visible(timeout=15000)
                page.get_by_test_id('mobile-open-desktop').click()
                expect(page.get_by_test_id('mobile-desktop-view')).to_be_visible()
                expect(page.get_by_test_id('mobile-screen-image')).to_be_visible(timeout=15000)
                page.wait_for_function(
                    '() => { const img = document.querySelector("[data-testid=\'mobile-screen-image\']"); '
                    'return !!img && img.complete && img.naturalWidth > 0; }'
                )
                page.get_by_test_id('mobile-desktop-refresh').click()
                expect(page.locator('[data-testid="mobile-window-select"] option[value="tauri:mobile-remote-browser"]')).to_have_count(1)
                page.get_by_test_id('mobile-window-select').select_option('tauri:mobile-remote-browser')
                page.get_by_test_id('mobile-window-input').fill('PW_DESK_99')
                page.get_by_test_id('mobile-window-send').click()
                expect(page.get_by_test_id('mobile-window-result')).to_be_visible(timeout=15000)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                assert not errors, errors
                page.screenshot(path=str(report / 'mobile-native-desktop-phone.png'), full_page=True)
            except Exception:
                page.screenshot(
                    path=str(report / 'mobile-native-desktop-failure.png'),
                    full_page=True,
                    mask=[page.get_by_test_id('mobile-pair-code')],
                )
                raise
            finally:
                context.close()
                browser.close()

        snap = _wait_state(
            lock, state,
            lambda s: any('PW_DESK_99' in str(e.get('value', '')) for e in s['events']),
            'Mobile Web window send did not deliver text to server browser',
        )
        receipt['event_count'] = len(snap['events'])
        receipt['checks'].append('real-embedded-mobile-web-desktop-view-renders-screen-and-drives-window-input')
        receipt['passed'] = True
    finally:
        server.shutdown()
        server.server_close()
        (report / 'mobile-desktop-remote-receipt.json').write_text(
            json.dumps(receipt, indent=2) + '\n', encoding='utf-8',
        )
    return ', '.join(receipt['checks'])
