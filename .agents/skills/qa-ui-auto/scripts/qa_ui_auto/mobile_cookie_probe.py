"""Phone E2E through an authenticated loopback gateway, never a user's cookie."""
from contextlib import nullcontext
from pathlib import Path
import base64
import json
import os
import shlex
import time

from playwright.sync_api import sync_playwright, expect
from .fixtures.mobile_cookie_gateway import COOKIE, CookieGateway


def marker_command(marker, *, windows=os.name == 'nt'):
    if windows:
        target = str(marker).replace("'", "''")
        script = f"[System.IO.File]::WriteAllText('{target}', 'QA_COOKIE_GATEWAY_PTY')"
        encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
        return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + encoded
    return "printf '%s\\n' QA_COOKIE_GATEWAY_PTY > " + shlex.quote(str(marker))


def probe(endpoint, pairing_code, case_dir, *, assets=None, real_pty=False, executable=None, browser=None):
    report = Path(case_dir)
    receipt = {'passed': False, 'real_pty': real_pty, 'checks': []}
    errors = []
    with CookieGateway(endpoint, assets=assets) as gateway, CookieGateway(endpoint, require_cookie=False, assets=assets) as other:
        with (nullcontext() if browser else sync_playwright()) as pw:
            owned = browser is None
            active_browser = browser or pw.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
            context = None
            try:
                context = active_browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                assert context.request.get(gateway.origin + '/api/v1/health').status == 401
                page.goto(gateway.origin + '/qa-gateway-login')
                expect(page.get_by_test_id('mobile-first-instance')).to_be_visible()
                assert page.evaluate('document.cookie') == '', 'gateway login cookie must be HttpOnly'
                receipt['checks'].append('gateway-login-cookie-required-and-not-readable-by-app')
                page.get_by_test_id('mobile-first-instance').click()
                page.get_by_test_id('mobile-pair-code').fill(pairing_code)
                for kind in ('html', 'empty', 'redirect'):
                    def malformed(route):
                        if kind == 'redirect':
                            route.fulfill(status=302, headers={'Location': gateway.origin + '/qa-gateway-login'})
                        else:
                            route.fulfill(status=200, content_type='text/html' if kind == 'html' else 'application/json',
                                          body='<html>Gateway login required</html>' if kind == 'html' else '{}')
                    page.route('**/api/v1/pair', malformed)
                    page.get_by_test_id('mobile-pair-submit').click()
                    expect(page.get_by_test_id('mobile-pair-error')).to_contain_text('网关登录' if kind == 'redirect' else '有效的 Taomni API')
                    assert ':undefined' not in page.url and '%3Aundefined' not in page.url
                    assert page.evaluate('JSON.parse(localStorage.getItem("taomni.mobile.instances.v1") || "[]").length') == 0
                    page.unroute('**/api/v1/pair', malformed)
                receipt['checks'].append('HTML-incomplete-JSON-and-login-redirect-never-save-or-navigate-pairing')
                page.get_by_test_id('mobile-label').fill('Cookie-gateway QA')
                page.get_by_test_id('mobile-pair-submit').click()
                expect(page.get_by_test_id('mobile-connection')).to_have_text('已连接', timeout=15000)
                expect(page.get_by_test_id('mobile-sessions')).to_be_visible()
                assert ':undefined' not in page.url and '%3Aundefined' not in page.url
                page.screenshot(path=str(report / 'mobile-cookie-sessions.png'), full_page=True)
                receipt['checks'].append('same-origin-cookie-pairing-REST-and-event-WebSocket')
                # Existing cookie alone must never replace Taomni's own Bearer token.
                assert context.request.get(gateway.origin + '/api/v1/sessions').status == 401
                receipt['checks'].append('gateway-cookie-does-not-authorize-Taomni-business-API')
                def bad_list(route):
                    route.fulfill(status=200, content_type='application/json', body='{}')
                page.route('**/api/v1/sessions', bad_list)
                page.get_by_test_id('mobile-refresh').click()
                expect(page.get_by_test_id('mobile-instance-error')).to_contain_text('有效的 Taomni API')
                expect(page.get_by_test_id('mobile-sessions')).to_be_visible()
                page.unroute('**/api/v1/sessions', bad_list)
                page.get_by_test_id('mobile-retry').click()
                expect(page.get_by_test_id('mobile-instance-error')).to_have_count(0)
                receipt['checks'].append('malformed-session-JSON-is-actionable-without-render-crash')
                # Cookie expiration must fail visibly; retained local pairing is not success.
                context.clear_cookies()
                page.get_by_test_id('mobile-refresh').click()
                expect(page.get_by_test_id('mobile-instance-error')).to_contain_text('网关登录')
                assert page.evaluate('JSON.parse(localStorage.getItem("taomni.mobile.instances.v1")).length') == 1
                page.goto(gateway.origin + '/qa-gateway-login')
                page.get_by_test_id('mobile-instance-open').click()
                expect(page.get_by_test_id('mobile-connection')).to_have_text('已连接', timeout=15000)
                expect(page.get_by_test_id('mobile-instance-error')).to_have_count(0)
                receipt['checks'].append('expired-gateway-login-retains-pairing-and-recovers-after-login')
                if real_pty:
                    page.get_by_test_id('mobile-open-local').click()
                    expect(page.get_by_test_id('mobile-terminal-screen')).to_be_visible(timeout=45000)
                    # Desktop's initial fit is authoritative and can reclaim early takeover.
                    page.wait_for_timeout(700)
                    page.get_by_test_id('mobile-take-control').click()
                    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
                    page.get_by_test_id('mobile-terminal-keyboard').click()
                    marker = report.resolve() / 'gateway-real-pty-marker.txt'
                    page.get_by_test_id('mobile-terminal-command').fill(marker_command(marker))
                    page.get_by_test_id('mobile-terminal-command-send').click()
                    deadline = time.monotonic() + 15
                    while (not marker.exists() or marker.read_text().strip() != 'QA_COOKIE_GATEWAY_PTY') and time.monotonic() < deadline:
                        page.wait_for_timeout(100)
                    assert marker.read_text().strip() == 'QA_COOKIE_GATEWAY_PTY'
                    page.screenshot(path=str(report / 'mobile-cookie-real-terminal.png'), full_page=True)
                    page.get_by_test_id('mobile-take-control').click()
                    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('只读')
                    page.get_by_test_id('mobile-terminal-back').click()
                    receipt['checks'].append('authenticated-gateway-WebSocket-executes-real-PTY-marker')
                # Ports are distinct origins but share host-scoped cookies. Another
                # instance must not receive that ambient gateway login cookie.
                context.add_cookies([{'name': COOKIE, 'value': 'qa-other-origin-cookie', 'url': other.origin, 'httpOnly': True, 'sameSite': 'Lax'}])
                page.get_by_test_id('mobile-instances-back').click()
                page.get_by_test_id('mobile-add-instance').click()
                page.get_by_test_id('mobile-endpoint').fill(other.origin)
                page.get_by_test_id('mobile-pair-code').fill('intentionally-invalid-not-a-secret')
                page.get_by_test_id('mobile-pair-submit').click()
                expect(page.get_by_test_id('mobile-pair-error')).to_contain_text('配对码')
                crossed = [r for r in other.records if r['route'] == '/api/v1/pair' and r['method'] == 'POST']
                assert crossed and all(not r['cookie_present'] and not r['bearer_present'] for r in crossed)
                receipt['checks'].append('cross-origin-instance-never-receives-browser-cookie')
                pairs = [r for r in gateway.records if r['route'] == '/api/v1/pair' and r['method'] == 'POST']
                assert pairs and all(r['cookie_present'] for r in pairs)
                tickets = [r for r in gateway.records if r['route'] == '/api/v1/ws-ticket' and r.get('status') == 200]
                assert tickets and all(r['cookie_present'] and r['bearer_present'] for r in tickets)
                assert any(r['upgrade'] and r.get('status') == 101 and r['cookie_present'] for r in gateway.records)
                assert not errors, errors
                page.screenshot(path=str(report / 'mobile-cookie-gateway.png'), full_page=True)
                receipt.update(passed=True, page_errors=errors, gateway_requests=gateway.records, cross_origin_requests=other.records)
            except Exception as error:
                receipt['failure_type'] = type(error).__name__
                if context and context.pages:
                    failed_page = context.pages[-1]
                    failed_page.screenshot(path=str(report / 'mobile-cookie-failure.png'), full_page=True,
                                           mask=[failed_page.get_by_test_id('mobile-pair-code')])
                raise
            finally:
                if context:
                    context.close()
                if owned:
                    active_browser.close()
                receipt.update(page_errors=errors, gateway_requests=gateway.records, cross_origin_requests=other.records)
                (report / 'mobile-cookie-gateway-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return receipt
