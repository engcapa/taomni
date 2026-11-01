"""Phone-open oracle: real REST -> desktop tab -> broker WS -> independent disk.

Only Settings clicks and the public mobile HTTP/WS protocol perform actions.
The terminal registry is read passively to correlate the returned backend key
with a new, local desktop tab; no app handler, IPC, or registry writer is called.
"""
from __future__ import annotations

import base64
from contextlib import suppress
import json
from pathlib import Path
import re
import shlex
from typing import Any
from urllib.parse import quote
from uuid import uuid4

from .deadline import budget_time as time, remaining_timeout
from .mobile_wire import http, Ws
from .steps import StepError
from .terminal_burst_probe import until


ORIGIN = 'https://mobile.qa.invalid'
CHECKBOX = '[data-testid="mobile-settings-open-sessions"]'
SAVED_ID = 'mobile-saved-local'
SAVED_NAME = 'QA saved local shell'
SAVED_ARGS = ['--noprofile', '--norc', '-i']
DESKTOP = r"""
return {
  tabs: [...document.querySelectorAll('[data-testid="tab-item"][data-tab-type="terminal"]')]
    .map(tab => ({tab_id: tab.dataset.tabId, title: tab.dataset.tabTitle,
                  active: tab.dataset.active === 'true'})),
  terminals: [...(window.__taomni_terminal_registry__?.entries?.values() || [])]
    .map(entry => ({tab_id: entry.tabId, key: entry.sessionId,
                   local: entry.localEnvironment || null, ready: !!entry.isReady?.(),
                   text: entry.getBufferText().slice(-8192)}))
};
"""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise StepError('mobile open-session: ' + message)


def sessions(endpoint: str, token: str) -> dict:
    status, _, value = http(endpoint, '/sessions', token, origin=ORIGIN)
    require(status == 200 and isinstance(value, dict), f'GET /sessions returned {status}: {value!r}')
    return value


def terminal_ids(value: dict) -> set[str]:
    return {row['id'] for row in value['sessions'] if row['kind'] == 'terminal'}


def open_request(endpoint: str, token: str, outsider: str, body: dict, record: dict) -> str:
    status, _, value = http(endpoint, '/open-requests', token, body, ORIGIN)
    record.update(body=body, post={'status': status, 'response': value}, polls=[])
    require(status == 200 and value.get('status') == 'pending',
            f'POST /open-requests expected pending, got {status}: {value!r}')
    request_id = value.get('request_id')
    require(isinstance(request_id, str) and bool(request_id), 'pending request has no request_id')
    path = '/open-requests/' + quote(request_id, safe='')
    status, _, denied = http(endpoint, path, outsider, origin=ORIGIN)
    record['other_device_poll'] = {'status': status, 'response': denied}
    require(status == 404 and denied.get('error') == 'open_request_not_found',
            f'another device could poll the request: {status}: {denied!r}')
    deadline = time.monotonic() + remaining_timeout(30)
    while time.monotonic() < deadline:
        status, _, value = http(endpoint, path, token, origin=ORIGIN)
        record['polls'].append({'status': status, 'response': value})
        require(status == 200 and value.get('request_id') == request_id,
                f'owner poll failed or changed request identity: {status}: {value!r}')
        outcome = value.get('status')
        if outcome == 'opened':
            session_id = value.get('session_id')
            require(isinstance(session_id, str) and session_id.startswith('term:') and len(session_id) > 5,
                    f'opened request did not return a term: id: {value!r}')
            return session_id
        require(outcome == 'pending', f'desktop open failed: {value!r}')
        time.sleep(.1)
    raise StepError('mobile open-session: request stayed pending for 30 seconds')


def correlate(ctx: Any, endpoint: str, token: str, session_id: str,
              before: dict, previous_ids: set[str], record: dict) -> dict:
    key = session_id.removeprefix('term:')
    previous_tabs = {tab['tab_id'] for tab in before['tabs']}
    deadline = time.monotonic() + remaining_timeout(15)
    while time.monotonic() < deadline:
        listing = sessions(endpoint, token)
        desktop = ctx.session.execute(DESKTOP)
        record['sessions_after'] = listing
        record['desktop_after'] = desktop
        rows = [row for row in listing['sessions'] if row['id'] == session_id]
        entries = [entry for entry in desktop['terminals'] if entry['key'] == key]
        if len(rows) == 1 and len(entries) == 1:
            row, entry = rows[0], entries[0]
            tabs = [tab for tab in desktop['tabs'] if tab['tab_id'] == entry['tab_id']]
            if (len(tabs) == 1 and row['status'] == 'running' and row['title']
                    and row['title'] not in (key, session_id) and row['title'] == tabs[0]['title']
                    and entry['local'] and entry['ready'] and tabs[0]['active']):
                require(entry['tab_id'] not in previous_tabs, 'request reused an existing desktop tab')
                require(len(desktop['tabs']) == len(previous_tabs) + 1, 'request did not open exactly one tab')
                require(terminal_ids(listing) - previous_ids == {session_id},
                        'returned terminal is not the one new broker instance')
                record.update(session_id=session_id, tab_id=entry['tab_id'], title=row['title'])
                return entry
        time.sleep(.1)
    raise StepError('mobile open-session: new terminal, readable mirrored title, ready local desktop tab '
                    'did not correlate; see sessions_after/desktop_after in receipt')


def marker_command(path: Path, marker: str, output: str) -> str:
    return ("printf '%s\\n' " + shlex.quote(marker) + ' > ' + shlex.quote(str(path))
            + " && printf '%s\\n' " + shlex.quote(output) + '\r')


def output_line(text: str, marker: str) -> bool:
    # Shell integration can put OSC/CSI sequences before stdout. Keep the raw
    # bytes in the receipt, but do not confuse those sequences with line text.
    plain = re.sub(r'\x1b(?:\].*?(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[()][0-2A-Z0-9])',
                   '', text, flags=re.DOTALL)
    return marker in plain.splitlines()


def exercise_pty(ctx: Any, endpoint: str, device: str, token: str,
                 session_id: str, entry: dict, label: str, record: dict) -> None:
    path = (ctx.case_dir / f'mobile-open-{label}-marker.txt').resolve()
    require(not path.exists(), f'independent {label} marker already exists before WS input')
    nonce = uuid4().hex
    marker = f'QA_MOBILE_OPEN_{label.upper()}_{nonce}'
    output = f'QA_MOBILE_EXECUTED_{label.upper()}_{nonce}'
    record['pty'] = {'marker_path': str(path), 'expected_marker': marker,
                     'expected_output_line': output, 'output': ''}
    stream = Ws(endpoint, '/terminals/' + quote(session_id, safe='') + '/stream', token, ORIGIN)
    try:
        stream.receive('replay', timeout=remaining_timeout(10))
        stream.send({'type': 'take-control'})
        deadline = time.monotonic() + remaining_timeout(10)
        while time.monotonic() < deadline:
            frame = stream.receive(timeout=max(.01, deadline - time.monotonic()))
            require(frame['type'] != 'error', f'take-control rejected: {frame!r}')
            if frame['type'] == 'control' and frame['holder'] == 'mobile:' + device:
                record['pty']['control'] = frame
                break
        else:
            raise StepError('mobile open-session: take-control was not granted')
        command = marker_command(path, marker, output)
        stream.send({'type': 'input', 'data_b64': base64.b64encode(command.encode()).decode()})
        deadline = time.monotonic() + remaining_timeout(15)
        while time.monotonic() < deadline:
            frame = stream.receive(timeout=max(.01, deadline - time.monotonic()))
            require(frame['type'] not in ('error', 'control-lost'), f'WS input rejected: {frame!r}')
            if frame['type'] == 'output':
                record['pty']['output'] += base64.b64decode(frame['data_b64']).decode(errors='replace')
                if output_line(record['pty']['output'], output):
                    break
        else:
            raise StepError('mobile open-session: no separate command output line on WS')
        require(path.is_file(), f'WS input did not create independent {label} PTY marker')
        actual = path.read_text(encoding='utf-8')
        record['pty']['actual_marker'] = actual
        require(actual == marker + '\n', f'independent {label} marker bytes differ from sent command')
        # Observe only: do not use registry.writeInput or call an IPC handler.
        until(ctx.session,
              '[...(window.__taomni_terminal_registry__?.entries?.values() || [])].some(entry => '
              'entry.tabId === ' + json.dumps(entry['tab_id'])
              + ' && entry.getBufferText().split(/\\r?\\n/).some(line => line.trim() === '
              + json.dumps(output) + '))', timeout=15)
        record['pty']['desktop_output_line'] = True
    finally:
        with suppress(Exception):
            stream.close()


def run(ctx: Any, endpoint: str, owner: tuple[str, str], other: tuple[str, str]) -> str:
    device, token = owner
    require(device != other[0], 'ownership test requires two independently paired devices')
    receipt: dict[str, Any] = {'passed': False, 'checks': [], 'requests': [], 'phase': 'disabled'}
    receipt_path = ctx.case_dir / 'mobile-open-session-receipt.json'
    try:
        before = ctx.session.execute(DESKTOP)
        initial = sessions(endpoint, token)
        receipt['initial'] = {'desktop': before, 'sessions': initial}
        require(not before['tabs'] and not terminal_ids(initial), 'fresh case already contains a terminal')
        require(initial['capabilities']['open_sessions'] is False, 'opening is not disabled by default')
        saved = [row for row in initial['saved_sessions'] if row['id'] == SAVED_ID]
        require(len(saved) == 1 and saved[0]['session_type'] == 'LocalShell' and saved[0]['name'] == SAVED_NAME,
                'disposable credential-free saved LocalShell is missing')
        for body in ({'kind': 'local'}, {'kind': 'saved', 'saved_session_id': SAVED_ID}):
            status, _, value = http(endpoint, '/open-requests', token, body, ORIGIN)
            receipt.setdefault('disabled_requests', []).append({'body': body, 'status': status, 'response': value})
            require(status == 403 and value.get('error') == 'open_sessions_disabled',
                    f'opening while checkbox is off was not refused: {status}: {value!r}')
        require(not ctx.session.execute(DESKTOP)['tabs'] and not terminal_ids(sessions(endpoint, token)),
                'disabled open request created a terminal')
        receipt['checks'].append('default-off-refuses-local-and-saved-without-creating-tabs')
        receipt['phase'] = 'enable-settings-checkbox'
        ctx.session.click(CHECKBOX)
        until(ctx.session, 'document.querySelector(' + json.dumps(CHECKBOX) + ')?.checked && '
              '!document.querySelector(' + json.dumps(CHECKBOX) + ')?.disabled')
        require(sessions(endpoint, token)['capabilities']['open_sessions'] is True,
                'Settings checkbox did not advertise open_sessions capability')
        receipt['checks'].append('real-settings-checkbox-enables-advertised-capability')
        previous_ids: set[str] = set()
        for label, body in (('local', {'kind': 'local'}),
                            ('saved', {'kind': 'saved', 'saved_session_id': SAVED_ID})):
            receipt['phase'] = label + '-open'
            before = ctx.session.execute(DESKTOP)
            record: dict[str, Any] = {'kind': label}
            receipt['requests'].append(record)
            session_id = open_request(endpoint, token, other[1], body, record)
            entry = correlate(ctx, endpoint, token, session_id, before, previous_ids, record)
            if label == 'saved':
                require(entry['local']['shellName'] == SAVED_NAME and entry['local']['shellArgs'] == SAVED_ARGS,
                        'saved request did not use the selected saved LocalShell configuration')
            receipt['phase'] = label + '-ws-pty'
            exercise_pty(ctx, endpoint, device, token, session_id, entry, label, record)
            previous_ids.add(session_id)
            receipt['checks'].append(label + '-pending-owner-only-opened-readable-title-new-desktop-tab-ws-pty-disk')
        final = sessions(endpoint, token)
        receipt['final_sessions'] = final
        require(terminal_ids(final) == previous_ids and len(previous_ids) == 2,
                'local and saved requests did not retain two independent terminal instances')
        receipt.update(passed=True, phase='completed')
        return ', '.join(receipt['checks'])
    except Exception as error:
        receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
        raise
    finally:
        receipt_path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
