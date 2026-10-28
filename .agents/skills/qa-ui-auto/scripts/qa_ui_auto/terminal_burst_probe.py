"""Real PTY burst output and passive Tauri channel ordering evidence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shlex
import sys
from typing import Any, Callable

from .deadline import budget_time as time
from .steps import StepError

PANE = '[data-testid="terminal-pane"][data-terminal-active="true"]'
INPUT = PANE + ' .xterm-helper-textarea'
TRACE_INSTALL = r"""
const callbacks = window.__TAURI_INTERNALS__?.callbacks;
if (!(callbacks instanceof Map)) throw Error('Tauri callback observation is unavailable');
if (window.__QA_TERMINAL_BURST__) throw Error('A burst observer is already installed');
const state = {channels: {}, errors: [], restorers: []};
for (const [id, original] of callbacks) {
  const wrapper = function (raw) {
    if (raw && Number.isInteger(raw.index) && raw.message instanceof ArrayBuffer) {
      const channel = state.channels[id] ??= [];
      channel.push({index: raw.index, text: new TextDecoder().decode(raw.message)});
    }
    try { return Reflect.apply(original, this, [raw]); }
    catch (error) {
      state.errors.push({id, index: raw?.index, message: String(error), stack: error?.stack});
      throw error;
    }
  };
  callbacks.set(id, wrapper);
  state.restorers.push(() => { if (callbacks.get(id) === wrapper) callbacks.set(id, original); });
}
state.cleanup = () => { for (const restore of state.restorers) restore(); };
window.__QA_TERMINAL_BURST__ = state;
return state.restorers.length;
"""
TRACE_COLLECT = r"""
const state = window.__QA_TERMINAL_BURST__;
if (!state) throw Error('Burst observer is missing');
state.cleanup();
delete window.__QA_TERMINAL_BURST__;
return {channels: state.channels, errors: state.errors,
 console: window.__QA_UI_AUTO_CONSOLE__ ?? [],
 terminals: [...(window.__taomni_terminal_registry__?.entries?.values() ?? [])].map(entry => {
   const text=entry.getBufferText();
   return {tabId: entry.tabId, sessionId: entry.sessionId, chars: text.length, tail: text.slice(-2048)};
 })};
"""


def until(session: Any, expression: str, timeout: float = 30) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = session.execute('return ' + expression)
        if result:
            return result
        time.sleep(.05)
    raise StepError('terminal burst observation timeout: ' + expression)


def line_present(marker: str) -> str:
    return ('(document.querySelector(' + json.dumps(PANE)
            + ")?.getAttribute('data-terminal-text') || '').split(/\\r?\\n/).some(line => line.trim() === "
            + json.dumps(marker) + ')')


def click(session: Any, selector: str, *, last: bool = False) -> None:
    target = ('[...document.querySelectorAll(' + json.dumps(selector) + ')].at(-1)'
              if last else 'document.querySelector(' + json.dumps(selector) + ')')
    session.execute(
        'const target=' + target + ';if(!target)throw Error("Missing burst control");'
        'target.scrollIntoView({block:"nearest",inline:"nearest"});'
        # Tab close icons are SVG, whose WebKit interface has no .click().
        'target.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,'
        'composed:true,view:window,detail:1,button:0}));return true;'
    )


def ready() -> str:
    return (f'document.querySelectorAll(\'{PANE}\').length === 1 && '
            f'!!document.querySelector(\'{PANE}[data-terminal-ready="true"]\')')


def producer_source(receipt: Path, begin: str, end: str) -> str:
    return (
        'import json, os, time\nfrom pathlib import Path\n'
        'def write(data):\n'
        ' view=memoryview(data)\n'
        ' while view:\n'
        '  count=os.write(1,view); view=view[count:]\n'
        f'write({(begin + chr(10)).encode()!r})\n'
        'start=time.perf_counter_ns()\nchunk=b"P"*511+b"\\n"\n'
        'for index in range(4096): write(chunk)\n'
        'elapsed=(time.perf_counter_ns()-start)/1e6\n'
        f'Path({str(receipt)!r}).write_text(json.dumps({{"bytes":2097152,"elapsedMs":elapsed}}))\n'
        f'write({(end + chr(10)).encode()!r})\n'
    )


def channel_summary(trace: dict) -> dict:
    result = {}
    for channel_id, rows in trace['channels'].items():
        indices = sorted(row['index'] for row in rows)
        result[channel_id] = {
            'messages': len(rows), 'bytes': sum(len(row['text'].encode()) for row in rows),
            'firstIndex': indices[0], 'lastIndex': indices[-1],
            'duplicates': len(indices) - len(set(indices)),
            'missing': sorted(set(range(indices[0], indices[-1] + 1)) - set(indices)),
        }
    return result


def review_trace(trace: dict, begin: str, end: str) -> dict:
    """Every byte between producer markers must survive native IPC ordering."""
    if trace['errors']:
        raise StepError('Terminal channel callback raised: ' + str(trace['errors']))
    matches = []
    for channel_id, rows in trace['channels'].items():
        rows = sorted(rows, key=lambda row: row['index'])
        text = ''.join(row['text'] for row in rows).replace('\r', '')
        if begin + '\n' not in text or end + '\n' not in text:
            continue
        if text.count(begin + '\n') != 1 or text.count(end + '\n') != 1:
            raise StepError('Native terminal producer markers were duplicated')
        indices = [row['index'] for row in rows]
        if indices != list(range(indices[0], indices[-1] + 1)):
            raise StepError('Native terminal channel lost or duplicated indices: ' + channel_id)
        body = text.split(begin + '\n', 1)[1].split(end + '\n', 1)[0]
        expected = ('P' * 511 + '\n') * 4096
        actual_hash = hashlib.sha256(body.encode()).hexdigest()
        wanted = hashlib.sha256(expected.encode()).hexdigest()
        if actual_hash != wanted:
            raise StepError(f'Native PTY bytes differ: {actual_hash} != {wanted}')
        matches.append({'channel': channel_id, 'messages': len(rows), 'firstIndex': indices[0],
                        'lastIndex': indices[-1], 'bytes': len(body), 'sha256': actual_hash})
    if len(matches) != 1:
        raise StepError('Expected exactly one complete producer stream, got ' + str(len(matches)))
    return matches[0]


def run(ctx: Any, args: Any, send_input: Callable) -> str:
    # This byte-for-byte oracle currently targets the real POSIX PTY stream;
    # ConPTY screen updates need a separate semantic oracle, not ANSI stripping.
    if sys.platform not in {'linux', 'darwin'}:
        raise StepError('native_terminal_burst currently requires a POSIX PTY')
    if args != {'sessions': 24, 'repeats': 3, 'timeout_sec': 180}:
        raise StepError('native_terminal_burst requires the complete 24-session, 3x2MiB workload')
    session = ctx.session
    record: dict = {'sessions': 24, 'repeats': [], 'passed': False}
    path = Path(ctx.case_dir) / 'native-terminal-burst.json'
    installed = False

    def save():
        path.write_text(json.dumps(record, indent=2) + '\n')

    def send(text: str):
        send_input(ctx, {'selector': INPUT, 'text': text, 'submit': True})

    def echo(label: str):
        for index in range(10):
            marker = f'qa-burst-{label}-{index}'
            send('echo ' + marker)
            until(session, line_present(marker))

    try:
        click(session, '[data-testid="side-tab-sessions"]')
        until(session, "document.querySelectorAll('[data-testid=\"terminal-pane\"]').length === 0")
        for index in range(24):
            click(session, '[data-testid="new-local-terminal"]')
            until(session, f"document.querySelectorAll('[data-testid=\"terminal-pane\"]').length === {index+1} && " + ready(), 45)
            if index == 0:
                echo('one')
        tabs = session.execute("return [...document.querySelectorAll('[data-testid=\"tab-item\"][data-tab-type=\"terminal\"]')].map(el => el.getAttribute('data-tab-id'))")
        if len(tabs) != 24:
            raise StepError('Expected 24 real terminal tabs')
        for tab_id in tabs + list(reversed(tabs)):
            selector = '[data-testid="tab-item"][data-tab-id=' + json.dumps(tab_id) + ']'
            click(session, selector)
            until(session, 'document.querySelector(' + json.dumps(selector) + ")?.getAttribute('data-active') === 'true' && " + ready())
        echo('many')
        for index in range(3):
            begin, end = f'qa-burst-begin-{index}', f'qa-burst-done-{index}'
            receipt = Path(ctx.case_dir) / f'producer-{index}.json'
            producer = Path(ctx.case_dir) / f'producer-{index}.py'
            producer.write_text(producer_source(receipt, begin, end))
            session.execute(TRACE_INSTALL)
            installed = True
            started = time.monotonic()
            repetition: dict = {'index': index, 'passed': False}
            record['repeats'].append(repetition)
            send(shlex.quote(sys.executable) + ' ' + shlex.quote(str(producer)))
            try:
                until(session, line_present(end), 180)
                repetition['outputObservedMs'] = (time.monotonic()-started)*1000
                echo('after-' + str(index))
            finally:
                original = sys.exception()
                try:
                    trace = session.execute(TRACE_COLLECT)
                    installed = False
                    (Path(ctx.case_dir) / f'burst-{index}-raw.json').write_text(json.dumps(trace) + '\n')
                    repetition['channels'] = channel_summary(trace)
                    repetition['callbackErrors'] = trace['errors']
                    repetition['console'] = trace['console']
                    repetition['terminals'] = trace['terminals']
                    if receipt.exists():
                        repetition['producer'] = json.loads(receipt.read_text())
                except BaseException as diagnostic:
                    repetition['observationError'] = str(diagnostic)
                    if original is None:
                        raise
                finally:
                    save()
            producer_record = json.loads(receipt.read_text())
            if producer_record['bytes'] != 2097152:
                raise StepError('Producer workload is incomplete')
            stream = review_trace(trace, begin, end)
            repetition.update(passed=True, stream=stream)
            save()
        for count in range(24, 0, -1):
            click(session, '[data-testid="tab-item"][data-tab-type="terminal"] [data-testid="tab-close"]', last=True)
            until(session, f"document.querySelectorAll('[data-testid=\"terminal-pane\"]').length === {count-1}")
        until(session, 'window.__taomni_terminal_registry__?.entries?.size === 0')
        record['allTabsClosed'] = True
        record['passed'] = True
        return '24 real PTYs, 3x2MiB exact output, ordered IPC and subsequent commands passed'
    except BaseException as error:
        record['error'] = str(error)
        raise
    finally:
        if installed:
            try:
                trace = session.execute(TRACE_COLLECT)
                (Path(ctx.case_dir) / 'burst-interrupted-raw.json').write_text(json.dumps(trace) + '\n')
            except Exception as cleanup:
                record['observationCleanupError'] = str(cleanup)
        save()
