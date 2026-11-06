"""Real phone UI -> native listener -> desktop SSH/PTY, on all three OSes.

The loopback SSH peer implements deterministic shell output, independently
records decrypted input and owns encrypted client keys. It is not a claim of
an external SSH host or physical phone/IME validation.
"""
import json
from pathlib import Path
import sqlite3
import time
from contextlib import closing, suppress
from types import SimpleNamespace
from playwright.sync_api import sync_playwright, expect
from .mobile_wire import http
from .mobile_native import code, pair, ORIGIN
from .mobile_open_session import DESKTOP, require
from .fixtures.backup_policy import isolated_data_root
from .terminal_burst_probe import until


def run(ctx, endpoint, pairing_code):
    receipt = {'passed': False, 'checks': [], 'requests': [], 'control_events': [], 'phase': 'pair'}
    errors = []
    root = Path(ctx.case_dir)
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                context = browser.new_context(viewport={'width': 390, 'height': 844})
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                def observe_socket(socket):
                    def received(payload):
                        frame = json.loads(payload)
                        if frame.get('type') in ('control', 'control-lost'):
                            receipt['control_events'].append({'phase': receipt['phase'], **frame})
                    socket.on('framereceived', received)
                page.on('websocket', observe_socket)
                page.goto(endpoint, wait_until='networkidle')
                page.get_by_test_id('mobile-first-instance').click()
                page.get_by_test_id('mobile-endpoint').fill(endpoint)
                page.get_by_test_id('mobile-label').fill('Native auth instance')
                page.get_by_test_id('mobile-pair-code').fill(pairing_code)
                page.get_by_test_id('mobile-pair-submit').click()
                expect(page.get_by_test_id('mobile-open-local')).to_be_visible()
                owner = page.evaluate('JSON.parse(localStorage.getItem("taomni.mobile.instances.v1"))[0]')
                _, outsider = pair(endpoint, code(ctx))
                token = owner['token']
                receipt['checks'].append('public-phone-pairing-real-listener')

                def open_saved(name):
                    receipt['phase'] = name
                    with page.expect_response(lambda r: r.url == endpoint + '/api/v1/open-requests' and r.request.method == 'POST') as started:
                        page.get_by_test_id('mobile-saved-session').filter(has_text=name).get_by_test_id('mobile-saved-open').click()
                    value = started.value.json()
                    require(value.get('status') == 'pending', 'saved request was not pending')
                    record = {'name': name, 'request_id': value['request_id'], 'rounds': []}
                    receipt['requests'].append(record)
                    return record

                def pending(record):
                    status, _, value = http(endpoint, '/open-requests/' + record['request_id'], token, origin=ORIGIN)
                    require(status == 200, 'owner cannot read native open progress')
                    return value

                def form(record):
                    expect(page.get_by_test_id('mobile-connection-auth')).to_be_visible(timeout=30000)
                    challenge = pending(record)['auth']
                    record['rounds'].append({'id': challenge['id'], 'name': challenge['name'], 'count': len(challenge['prompts'])})
                    return challenge

                def connected(record):
                    expect(page.get_by_test_id('mobile-terminal-screen')).to_be_visible(timeout=45000)
                    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('只读')
                    result = pending(record)
                    require(result['status'] == 'opened' and result['session_id'].startswith('term:'), 'native SSH did not resolve to a broker terminal')
                    record['result'] = result
                    until(ctx.session, '!document.querySelector(\'[data-testid="mfa-prompt"]\')', timeout=10)
                    until(ctx.session, '[...(window.__taomni_terminal_registry__?.entries?.values() || [])].some(e => e.sessionId === '
                          + json.dumps(result['session_id'][5:]) + ' && e.isReady?.())', timeout=15)
                    # Connection readiness precedes forced desktop fits at 80
                    # and 300 ms. Those legitimately reclaim phone control.
                    # Wait for the desktop layout/readiness to settle before
                    # taking control once; never retry the takeover action.
                    deadline, stable_since, previous = time.monotonic() + 15, None, None
                    while time.monotonic() < deadline:
                        state = ctx.session.execute('return { ready: [...(window.__taomni_terminal_registry__?.entries?.values() || [])].some(e => e.sessionId === '
                            + json.dumps(result['session_id'][5:]) + ' && e.isReady?.()), layout: [...document.querySelectorAll(\'[data-testid="terminal-pane"]\')].map(e => { const r=e.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; }) };')
                        now = time.monotonic()
                        if state.get('ready') and state == previous:
                            if stable_since is not None and now - stable_since >= 0.6:
                                break
                        else:
                            stable_since = now if state.get('ready') else None
                        previous = state
                        time.sleep(0.05)
                    else:
                        raise AssertionError('desktop terminal layout/readiness did not settle before phone takeover')
                    page.get_by_test_id('mobile-take-control').click()
                    expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
                    if not page.get_by_test_id('mobile-compact-keyboard').is_visible():
                        page.get_by_test_id('mobile-input-compact').click()
                    expect(page.get_by_test_id('mobile-compact-keyboard')).to_be_visible()
                    page.get_by_test_id('mobile-terminal-keyboard').click()
                    page.get_by_test_id('mobile-terminal-command').fill('echo QA_NATIVE_SSH_PING')
                    page.get_by_test_id('mobile-terminal-command-send').click()
                    until(ctx.session, '[...(window.__taomni_terminal_registry__?.entries?.values() || [])].some(e => e.sessionId === '
                          + json.dumps(result['session_id'][5:]) + ' && e.getBufferText().includes("QA_NATIVE_SSH_PONG"))', timeout=15)
                    record['native_ssh_output'] = True
                    page.get_by_test_id('mobile-terminal-back').click()

                # Account can be changed on the phone, without updating the saved row.
                record = open_saved('QA phone password')
                challenge = form(record)
                denied = http(endpoint, '/open-requests/' + record['request_id'] + '/auth', outsider,
                              {'challenge_id': challenge['id'], 'responses': ['intruder', 'invalid']}, ORIGIN)
                require(denied[0] == 404, 'another paired device answered this native login')
                record['outsider_reply_status'] = denied[0]
                page.get_by_test_id('mobile-auth-answer-0').fill('qa-phone-user')
                page.get_by_test_id('mobile-auth-answer-1').fill('qa-temp-secret')
                page.screenshot(path=str(root / 'mobile-native-login.png'), full_page=True)
                page.get_by_test_id('mobile-auth-submit').click()
                connected(record)
                receipt['checks'].append('phone-account-password-native-ssh-channel-independent-output')

                # Password fallback -> native SSH keyboard-interactive OTP.
                record = open_saved('QA phone OTP')
                form(record)
                page.get_by_test_id('mobile-auth-answer-1').fill('unused-first-factor')
                page.get_by_test_id('mobile-auth-submit').click()
                expect(page.get_by_test_id('mobile-connection-auth')).to_contain_text('SSH OTP', timeout=30000)
                form(record)
                page.get_by_test_id('mobile-auth-answer-0').fill('123456')
                page.get_by_test_id('mobile-auth-submit').click()
                connected(record)
                require(len(record['rounds']) == 2 and record['rounds'][0]['id'] != record['rounds'][1]['id'], 'OTP reused the first auth round')
                receipt['checks'].append('native-ssh-multiple-rounds-phone-otp-one-shot')

                # Encrypted private key is decrypted by native russh, not a browser stub.
                record = open_saved('QA phone private key')
                expect(page.get_by_test_id('mobile-connection-auth')).to_contain_text('Unlock SSH private key', timeout=30000)
                form(record)
                page.get_by_test_id('mobile-auth-answer-0').fill('qa-key-passphrase')
                page.get_by_test_id('mobile-auth-submit').click()
                connected(record)
                receipt['checks'].append('native-encrypted-private-key-phone-passphrase')

                # Jump authentication must share this request's phone responder,
                # then authenticate the target over a real direct-tcpip channel.
                for name, title, answer in [('jump OTP', 'SSH OTP', '123456'), ('jump private key', 'Unlock SSH private key', 'qa-key-passphrase')]:
                    record = open_saved('QA phone ' + name)
                    form(record)
                    page.get_by_test_id('mobile-auth-answer-0').fill('qa-phone-user')
                    page.get_by_test_id('mobile-auth-answer-1').fill('qa-temp-secret')
                    page.get_by_test_id('mobile-auth-submit').click()
                    expect(page.get_by_test_id('mobile-connection-auth')).to_contain_text('Jump host', timeout=30000)
                    expect(page.get_by_test_id('mobile-connection-auth')).to_contain_text(title)
                    form(record)
                    page.get_by_test_id('mobile-auth-answer-0').fill(answer)
                    page.get_by_test_id('mobile-auth-submit').click()
                    connected(record)
                    receipt['checks'].append('native-' + name.replace(' ', '-') + '-then-target-ssh')

                # Lock through the public desktop UI. Proxy refs are unresolved
                # until the phone supplies one-shot credentials for this attempt.
                ctx.session.click('[data-testid="ribbon-settings"]')
                ctx.session.fill('[data-testid="settings-search-input"]', 'vault')
                until(ctx.session, '!!document.querySelector(\'[data-testid="vault-init-button"], [data-testid="vault-lock-button"]\')')
                if ctx.session.count('[data-testid="vault-init-button"]'):
                    ctx.session.click('[data-testid="vault-init-button"]')
                    ctx.session.find('[data-testid="vault-setup-dialog"]')
                    ctx.session.fill('[data-testid="vault-setup-pw1"]', 'qa-mobile-auth-master')
                    ctx.session.fill('[data-testid="vault-setup-pw2"]', 'qa-mobile-auth-master')
                    ctx.session.click('[data-testid="vault-setup-confirm"]')
                    ctx.session.wait_absent('[data-testid="vault-setup-dialog"]')
                until(ctx.session, 'document.querySelector(\'[data-testid="vault-state-badge"]\')?.textContent === "unlocked"')
                ctx.session.click('[data-testid="vault-lock-button"]')
                until(ctx.session, 'document.querySelector(\'[data-testid="vault-state-badge"]\')?.textContent === "locked"')
                for name in ['HTTP proxy', 'SOCKS proxy', 'app proxy', 'custom proxy']:
                    record = open_saved('QA phone ' + name)
                    form(record)
                    page.get_by_test_id('mobile-auth-answer-0').fill('qa-phone-user')
                    page.get_by_test_id('mobile-auth-answer-1').fill('qa-temp-secret')
                    page.get_by_test_id('mobile-auth-submit').click()
                    expect(page.get_by_test_id('mobile-connection-auth')).to_contain_text('代理', timeout=30000)
                    form(record)
                    page.get_by_test_id('mobile-auth-answer-0').fill('qa-proxy-user')
                    page.get_by_test_id('mobile-auth-answer-1').fill('qa-proxy-secret')
                    page.get_by_test_id('mobile-auth-submit').click()
                    connected(record)
                    receipt['checks'].append('locked-vault-one-shot-' + name.replace(' ', '-'))

                # Cancel before a tab is created; late replies cannot create one.
                before = ctx.session.execute(DESKTOP)
                record = open_saved('QA phone password')
                challenge = form(record)
                page.get_by_test_id('mobile-auth-cancel').click()
                expect(page.get_by_test_id('mobile-open-status')).to_have_count(0)
                late = http(endpoint, '/open-requests/' + record['request_id'] + '/auth', token,
                            {'challenge_id': challenge['id'], 'responses': ['qa-phone-user', 'late-answer']}, ORIGIN)
                require(late[0] == 409, 'late native auth answer was accepted after cancellation')
                require(len(ctx.session.execute(DESKTOP)['tabs']) == len(before['tabs']), 'cancelled preflight created a desktop tab')
                receipt['checks'].append('cancel-before-connect-rejects-late-answer-no-new-tab')

                # Cancellation while russh is already waiting on its shared
                # desktop/phone OTP responder must settle both views too.
                record = open_saved('QA phone OTP')
                form(record)
                page.get_by_test_id('mobile-auth-answer-1').fill('unused-first-factor')
                page.get_by_test_id('mobile-auth-submit').click()
                expect(page.get_by_test_id('mobile-connection-auth')).to_contain_text('SSH OTP', timeout=30000)
                challenge = form(record)
                page.get_by_test_id('mobile-auth-cancel').click()
                expect(page.get_by_test_id('mobile-open-status')).to_have_count(0)
                late = http(endpoint, '/open-requests/' + record['request_id'] + '/auth', token,
                            {'challenge_id': challenge['id'], 'responses': ['123456']}, ORIGIN)
                require(late[0] == 409, 'cancelled in-flight OTP accepted a late answer')
                until(ctx.session, '!document.querySelector(\'[data-testid="mfa-prompt"]\')', timeout=10)
                require(pending(record)['status'] == 'failed', 'cancelled SSH attempt remained pending')
                receipt['checks'].append('cancel-native-otp-settles-desktop-and-phone-rejects-stale-answer')

                # Password failure ends the same request; the next open still works.
                record = open_saved('QA phone password')
                form(record)
                page.get_by_test_id('mobile-auth-answer-0').fill('wrong-account')
                page.get_by_test_id('mobile-auth-answer-1').fill('wrong-password')
                page.get_by_test_id('mobile-auth-submit').click()
                expect(page.get_by_test_id('mobile-open-status')).to_contain_text('失败', timeout=45000)
                expect(page.get_by_test_id('mobile-connection-auth')).to_have_count(0)
                receipt['checks'].append('rejected-ssh-account-surfaces-failure-without-pending-auth')

                # Existing local-open path runs an actual platform shell and emits
                # a separate stdout line in the native terminal registry.
                page.get_by_test_id('mobile-open-local').click()
                expect(page.get_by_test_id('mobile-terminal-screen')).to_be_visible(timeout=45000)
                page.get_by_test_id('mobile-take-control').click()
                expect(page.get_by_test_id('mobile-terminal-status')).to_contain_text('控制中')
                if not page.get_by_test_id('mobile-terminal-command').is_visible():
                    page.get_by_test_id('mobile-terminal-keyboard').click()
                page.get_by_test_id('mobile-terminal-command').fill('echo QA_NATIVE_LOCAL_STDOUT')
                page.get_by_test_id('mobile-terminal-command-send').click()
                until(ctx.session, '[...(window.__taomni_terminal_registry__?.entries?.values() || [])].some(e => e.localEnvironment && e.getBufferText().split(/\\r?\\n/).some(l => l.trim() === "QA_NATIVE_LOCAL_STDOUT"))', timeout=20)
                receipt['checks'].append('new-local-terminal-real-platform-pty-stdout-after-auth-failure')
                page.screenshot(path=str(root / 'mobile-native-local.png'), full_page=True)
                storage = page.evaluate('JSON.stringify(localStorage)')
                require(all(secret not in storage for secret in ('qa-temp-secret', '123456', 'qa-key-passphrase', 'qa-proxy-secret')), 'phone persisted credentials')
                require(not errors, 'phone runtime errors: ' + repr(errors))
                context.close()
            finally:
                browser.close()
        profile = isolated_data_root(SimpleNamespace(cfg=ctx.cfg, report_root=root.parent))
        with closing(sqlite3.connect((profile / 'taomni.db').as_uri() + '?mode=ro', uri=True)) as db:
            original = db.execute('SELECT username, options_json FROM sessions WHERE id=?', ('QA phone password',)).fetchone()
            require(original[0] == 'old-user' and 'qa-temp-secret' not in original[1], 'phone auth changed persisted account credentials')
            persisted = str(db.execute('SELECT username, options_json FROM sessions').fetchall())
            require(all(secret not in persisted for secret in ('qa-temp-secret', 'qa-proxy-secret', 'qa-key-passphrase', '123456')), 'phone authentication persisted a secret in a saved session')
        peer = [json.loads(line) for line in (root / 'mobile-ssh-peer.jsonl').read_text(encoding='utf-8').splitlines()]
        require(sum(event['event'] == 'shell-input' for event in peer) == 9, 'independent SSH peer did not receive each of the nine native input streams exactly once')
        require(sum(event['event'] == 'jump-channel' for event in peer) == 2, 'jump authentication did not open both real channels')
        require(sum(event['event'] == 'proxy-authenticated' for event in peer) == 4, 'proxy credentials did not authenticate all four real routes')
        receipt.update(passed=True, phase='completed', peer_events=peer, phone_errors=errors)
        return ', '.join(receipt['checks'])
    except BaseException as error:
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
        with suppress(Exception):
            receipt['desktop_at_failure'] = ctx.session.execute(DESKTOP)
        raise
    finally:
        (root / 'mobile-connection-auth-receipt.json').write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
