"""External network failures against the production phone bundle, no app-state writes."""
from pathlib import Path
import json
from playwright.sync_api import expect as playwright_expect
from .deadline import BudgetedPage


class Expected:
    """Use real Locator assertions while preserving the runner's case budget."""
    def __init__(self, locator, timeout):
        self.locator = locator
        self.timeout = timeout

    def __getattr__(self, name):
        def check(*args, **kwargs):
            locator = self.locator
            timeout = self.timeout
            if isinstance(locator, BudgetedPage):
                timeout = min(timeout, locator._deadline.remaining() * 1000)
                locator = locator._target
            return getattr(playwright_expect(locator), name)(*args, timeout=timeout, **kwargs)
        return check


def expect(locator, timeout=5000):
    return Expected(locator, timeout)


def reconnect(page, case_dir):
    """Start on the paired session list; retain output across a real WS outage."""
    sockets = []

    def observe(ws):
        upstream = ws.connect_to_server()
        sockets.append((ws, upstream))

    page.route_web_socket('**/api/v1/**', observe)
    # The instance event socket predates the probe; reload this public route so
    # both independent streams pass through the external network interceptor.
    page.reload(wait_until='domcontentloaded')
    page.locator('[data-testid="mobile-session"][data-session-kind="terminal"]').click()
    expect(page.get_by_test_id('mobile-control-warning')).to_contain_text('输入可能打断')
    page.wait_for_function("document.querySelector('.xterm-accessibility-tree')?.textContent.includes('QA_MOBILE_REPLAY')")
    # Use the public fullscreen control so the independent instance event
    # reconnect button is reachable; never force-click through the overlay.
    if page.evaluate("document.documentElement.classList.contains('terminal-fullscreen')"):
        page.get_by_test_id('mobile-terminal-more').click()
        page.get_by_test_id('mobile-terminal-fullscreen').click()
    tickets = []

    def unavailable(route):
        tickets.append(route.request.url)
        route.fulfill(status=503, content_type='application/json', body='{"error":"connection_failed"}')

    page.route('**/api/v1/ws-ticket', unavailable)
    assert len(sockets) == 2, 'independent event and terminal sockets were not intercepted'
    for ws, upstream in list(sockets):
        ws.close(code=1011, reason='QA network interruption')
        upstream.close()
    expect(page.get_by_test_id('mobile-terminal-retry'), timeout=70000).to_be_visible()
    expect(page.get_by_test_id('mobile-events-retry')).to_be_visible()
    expect(page.get_by_test_id('mobile-sessions-updated')).to_contain_text('可能已过期')
    assert len(tickets) == 10, f'Expected five retries per stream, got {len(tickets)}'
    assert page.locator('.xterm-accessibility-tree').inner_text().find('QA_MOBILE_REPLAY') >= 0
    count = len(tickets)
    page.wait_for_timeout(1200)
    assert len(tickets) == count, 'automatic retries continued after budget exhausted'
    page.unroute('**/api/v1/ws-ticket', unavailable)
    page.get_by_test_id('mobile-events-retry').click()
    expect(page.get_by_test_id('mobile-connection')).to_have_text('已连接')
    page.get_by_test_id('mobile-terminal-retry').click()
    expect(page.get_by_test_id('mobile-terminal-retry')).to_have_count(0)
    expect(page.get_by_test_id('mobile-take-control')).to_be_enabled()
    assert 'after_seq=' in sockets[-1][0].url, 'manual retry did not resume the existing sequence'
    page.get_by_test_id('mobile-take-control').click()
    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
    page.screenshot(path=str(Path(case_dir) / 'mobile-network-recovered.png'))
    page.get_by_test_id('mobile-terminal-back').click()
    return {'bounded_retries_per_stream': count // 2, 'streams': 2, 'output_retained': True, 'manual_recovery': True}


def freshness(page, case_dir):
    """Only task details succeed while changes and an already-open file fail."""
    page.locator('[data-testid="mobile-session"][data-session-kind="agent"]').click()
    page.get_by_test_id('mobile-file-open').click()
    expect(page.get_by_test_id('mobile-file-content')).to_contain_text('QA_MOBILE_CHANGED')
    before = {name: page.get_by_test_id(name).inner_text() for name in ('mobile-changes-updated', 'mobile-file-updated')}
    assert all('—' not in value for value in before.values()), before

    def unavailable(route):
        route.fulfill(status=503, content_type='application/json', body='{"error":"connection_failed"}')

    page.route('**/api/v1/tasks/**', unavailable)
    page.get_by_test_id('mobile-agent-continue').click()
    page.get_by_test_id('mobile-agent-send').click()
    expect(page.get_by_test_id('mobile-task-status')).to_contain_text('运行中')
    expect(page.get_by_test_id('mobile-changes-error')).to_be_visible()
    expect(page.get_by_test_id('mobile-file-error')).to_be_visible()
    for name, value in before.items():
        expect(page.get_by_test_id(name)).to_contain_text(value + ' · 可能已过期')
    expect(page.get_by_test_id('mobile-task-updated')).not_to_contain_text('可能已过期')
    expect(page.get_by_test_id('mobile-file-content')).to_contain_text('QA_MOBILE_CHANGED')
    page.screenshot(path=str(Path(case_dir) / 'mobile-independent-stale-data.png'))
    page.unroute('**/api/v1/tasks/**', unavailable)
    page.get_by_test_id('mobile-changes-refresh').click()
    page.get_by_test_id('mobile-file-refresh').click()
    expect(page.get_by_test_id('mobile-changes-error')).to_have_count(0)
    expect(page.get_by_test_id('mobile-file-error')).to_have_count(0)
    expect(page.get_by_test_id('mobile-changes-updated')).not_to_contain_text('可能已过期')
    expect(page.get_by_test_id('mobile-file-updated')).not_to_contain_text('可能已过期')
    page.get_by_test_id('mobile-task-stop').click()
    expect(page.get_by_test_id('mobile-task-status')).to_contain_text('空闲')
    page.route('**/api/v1/sessions/thread*', unavailable)
    page.get_by_test_id('mobile-agent-continue').click()
    page.get_by_test_id('mobile-agent-send').click()
    expect(page.get_by_test_id('mobile-task-retry')).to_be_visible()
    page.get_by_test_id('mobile-agent-input').fill('retained while status unknown')
    expect(page.get_by_test_id('mobile-agent-send')).to_be_disabled()
    page.unroute('**/api/v1/sessions/thread*', unavailable)
    page.get_by_test_id('mobile-task-retry').click()
    expect(page.get_by_test_id('mobile-task-status')).to_contain_text('运行中')
    expect(page.get_by_test_id('mobile-task-retry')).to_have_count(0)
    expect(page.get_by_test_id('mobile-agent-input')).to_have_value('retained while status unknown')
    expect(page.get_by_test_id('mobile-agent-send')).to_be_disabled()
    return {'independent_success_times': True, 'stale_file_retained': True, 'refresh_recovered': True, 'status_failure_blocks_send': True}


def run(page, case_dir):
    receipt = {'reconnect': reconnect(page, case_dir), 'freshness': freshness(page, case_dir), 'passed': True}
    (Path(case_dir) / 'mobile-recovery.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
