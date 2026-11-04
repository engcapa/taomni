"""Native listener + real OpenSSH probe process cancellation, no Kerberos stub pass."""
import json
import os
from pathlib import Path
import time
from .mobile_native import pair, code, text, ORIGIN
from .mobile_wire import http
from .mobile_open_session import require
from .terminal_burst_probe import until


def run(ctx, endpoint):
    root = Path(ctx.case_dir)
    receipt = {'passed': False, 'checks': []}
    events = root / 'openssh-events.jsonl'
    def records():
        return [json.loads(line) for line in events.read_text().splitlines()] if events.exists() else []
    def wait(check, label):
        deadline = time.monotonic() + 15
        while not check():
            if time.monotonic() > deadline: raise AssertionError(label)
            time.sleep(0.05)
    try:
        for reason in ['cancel', 'revoke', 'stop']:
            device, token = pair(endpoint, code(ctx))
            before = http(endpoint, '/sessions', token, origin=ORIGIN)[2]['sessions']
            previous = len(records())
            status, _, opened = http(endpoint, '/open-requests', token, {'kind': 'saved', 'saved_session_id': 'QA cancelled OpenSSH'}, ORIGIN)
            require(status == 202 or status == 200, 'OpenSSH request not accepted')
            wait(lambda: len(records()) > previous, 'real OpenSSH probe did not start')
            process = records()[-1]
            require(not process['launch'], 'PTY launched before probe completion')
            ctx.session.click('[data-testid="ribbon-settings"]')
            ctx.session.fill('[data-testid="settings-search-input"]', 'mobile')
            if reason == 'cancel':
                require(http(endpoint, '/open-requests/' + opened['request_id'] + '/cancel', token, {}, ORIGIN)[0] == 200, 'cancel rejected')
            elif reason == 'revoke':
                ctx.session.click('[data-testid="mobile-settings-revoke"]')
            else:
                ctx.session.click('[data-testid="mobile-settings-toggle"]')
                until(ctx.session, 'document.querySelector(\'[data-testid="mobile-settings-status"]\')?.textContent.includes("Disabled")')
            def dead():
                try: os.kill(process['pid'], 0)
                except ProcessLookupError: return True
                return False
            wait(dead, 'cancelled OpenSSH probe remained alive')
            (root / 'probe-release').write_text('late success')
            time.sleep(0.3)
            require(not any(event['launch'] for event in records()), 'cancelled request launched a late terminal')
            (root / 'probe-release').unlink()
            ctx.session.click('[data-testid="ribbon-settings"]')
            ctx.session.fill('[data-testid="settings-search-input"]', 'mobile')
            if reason == 'stop':
                ctx.session.click('[data-testid="mobile-settings-toggle"]')
                until(ctx.session, 'document.querySelector(\'[data-testid="mobile-settings-status"]\')?.textContent.includes("Running")')
                from .mobile_native import address
                endpoint = address(ctx)
            _, observer = pair(endpoint, code(ctx))
            after = http(endpoint, '/sessions', observer, origin=ORIGIN)[2]['sessions']
            require(len(after) == len(before), 'cancelled OpenSSH terminal registered in native broker')
            # Remove devices through settings, keeping the next revoke unambiguous.
            while ctx.session.count('[data-testid="mobile-settings-revoke"]'):
                ctx.session.click('[data-testid="mobile-settings-revoke"]')
            receipt['checks'].append(reason + '-kills-probe-no-late-pty-or-broker-registration')
        receipt['passed'] = True
        return ', '.join(receipt['checks'])
    finally:
        receipt['processes'] = records()
        (root / 'mobile-openssh-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
