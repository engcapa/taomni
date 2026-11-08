"""Real desktop xterm + phone bundle + PTY ownership, never direct input IPC."""
import json
import os
from pathlib import Path
import shlex
import time

from playwright.sync_api import expect, sync_playwright

from .terminal_burst_probe import PANE, until


def read_state(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def wait_state(page, path, predicate):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = read_state(path)
        if predicate(state):
            return state
        page.wait_for_timeout(50)
    raise AssertionError('PTY fixture state did not settle: ' + repr(read_state(path)))


def run(ctx, endpoint, pairing_code, terminal_input):
    report = ctx.case_dir
    receipt = {'passed': False, 'checks': [], 'phone_frames': []}
    result = report.resolve() / 'query-tui-pty.json'
    fixture = Path(__file__).resolve().parents[2] / 'assets' / 'mobile-terminal-query.cjs'
    quote = (lambda value: "'" + str(value).replace("'", "''") + "'") if os.name == 'nt' else lambda value: shlex.quote(str(value))
    command = 'node ' + quote(fixture) + ' ' + quote(result)
    tab = ctx.session.execute('return [...(window.__taomni_terminal_registry__?.entries?.values() || [])][0]?.tabId')
    assert tab, 'A real local terminal must already be open'
    ctx.session.click('[data-testid="tab-item"][data-tab-id=' + json.dumps(tab) + ']')
    until(ctx.session, '!!document.querySelector(' + json.dumps(PANE) + ')')
    terminal_input(ctx, {'selector': PANE + ' .xterm-helper-textarea', 'text': command, 'submit': True})
    started = False
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, service_workers='block')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def observe(ws):
                if '/terminals/' not in ws.url:
                    return
                def record(direction, payload):
                    value = json.loads(payload)
                    # No auth tickets, pairing codes or credentials in evidence.
                    if value['type'] != 'output':
                        receipt['phone_frames'].append({'direction': direction, **value})
                ws.on('framesent', lambda payload: record('sent', payload))
                ws.on('framereceived', lambda payload: record('received', payload))
            page.on('websocket', observe)
            try:
                wait_state(page, result, lambda value: value.get('ready'))
                started = True
                page.goto(endpoint)
                page.get_by_test_id('mobile-first-instance').click()
                page.get_by_test_id('mobile-pair-code').fill(pairing_code)
                page.get_by_test_id('mobile-pair-submit').click()
                expect(page.get_by_test_id('mobile-connection')).to_have_text('已连接', timeout=15000)
                page.locator('[data-testid="mobile-session"][data-session-kind="terminal"]').click()
                expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('只读')
                page.get_by_test_id('mobile-take-control').click()
                expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
                wait_state(page, result, lambda value: value.get('queries') and len(value.get('replies', [])) >= len(value['queries']))
                page.wait_for_timeout(350)
                state = read_state(result)
                assert any(query['reason'] == 'resize' for query in state['queries'])
                assert len(state['replies']) == len(state['queries']), state
                assert state['replies'][-1] == {key: state['queries'][-1][key] for key in ('cols', 'rows')}, state
                assert not any(frame['type'] == 'control-lost' for frame in receipt['phone_frames'])
                expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
                receipt['checks'].append('phone-size-adoption-query-has-one-phone-sized-reply-without-desktop-reclaim')

                page.get_by_test_id('mobile-input-direct').click()
                count = len(state['queries'])
                page.keyboard.press('q')
                wait_state(page, result, lambda value: len(value.get('queries', [])) > count and len(value.get('replies', [])) >= len(value['queries']))
                page.wait_for_timeout(350)
                state = read_state(result)
                assert len(state['replies']) == len(state['queries']), state
                assert state['replies'][-1] == {key: state['queries'][-1][key] for key in ('cols', 'rows')}, state
                expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
                receipt['checks'].append('direct-phone-keystroke-and-later-cursor-query-retain-control')
                page.screenshot(path=str(report / 'mobile-query-controlling.png'), full_page=True)

                terminal_input(ctx, {'selector': PANE + ' .xterm-helper-textarea', 'text': 'd', 'submit': False})
                expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('只读')
                wait_state(page, result, lambda value: 'd' in value.get('keys', []))
                assert any(frame['type'] == 'control-lost' and frame.get('reason') == 'desktop_input' for frame in receipt['phone_frames'])
                # With no phone holder, the desktop must still answer a query.
                state = read_state(result)
                count = len(state['queries'])
                terminal_input(ctx, {'selector': PANE + ' .xterm-helper-textarea', 'text': 'q', 'submit': False})
                wait_state(page, result, lambda value: len(value.get('queries', [])) > count and len(value.get('replies', [])) >= len(value['queries']))
                assert not errors, errors
                receipt.update(passed=True, pty=read_state(result), page_errors=errors)
                receipt['checks'].append('real-desktop-input-reclaims-and-desktop-query-replies-still-work')
                page.screenshot(path=str(report / 'mobile-query-desktop-reclaimed.png'), full_page=True)
            except Exception:
                page.screenshot(path=str(report / 'mobile-query-failure.png'), full_page=True, mask=[page.get_by_test_id('mobile-pair-code')])
                raise
            finally:
                context.close()
                browser.close()
    finally:
        if started:
            terminal_input(ctx, {'selector': PANE + ' .xterm-helper-textarea', 'text': 'z', 'submit': False})
        (report / 'mobile-terminal-query.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    return ', '.join(receipt['checks'])
