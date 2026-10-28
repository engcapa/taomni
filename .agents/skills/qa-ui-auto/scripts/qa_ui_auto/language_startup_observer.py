"""Forwarding-only observation of the real browser/native invoke boundary.

Installing this observer never resolves, holds, rejects or replaces a provider.
It records timing/identity only; source contents and result bodies are excluded.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .deadline import budget_time as time
from .steps import StepError

SCRIPT = Path(__file__).with_suffix('.js').read_text(encoding='utf-8')
COMMANDS = {
    'sdk_get_registry', 'sdk_analyze_workspace', 'sdk_resolve_workspace',
    'lsp_detect_servers', 'lsp_discover_java_bundles', 'lsp_open_document',
    'lsp_document_status', 'lsp_change_document', 'lsp_save_document', 'lsp_close_document',
}


def install_browser(ctx: Any) -> None:
    result = ctx.page.evaluate(
        "async () => { const {CommandRegistry} = await import('/src/stubs/commands/registry.ts');"
        "return (" + SCRIPT + ")(CommandRegistry.prototype); }"
    )
    if result != {'installed': True, 'forwarding': True}:
        raise StepError(f'Language startup observer did not install: {result!r}')


def install_native(ctx: Any) -> str:
    result = ctx.session.execute('return (' + SCRIPT + ')(window.__TAURI_INTERNALS__);')
    if result != {'installed': True, 'forwarding': True}:
        raise StepError(f'Language startup observer did not install: {result!r}')
    return 'Installed forwarding-only native language startup observer'


def validate_expectations(args: Any) -> tuple[dict, float]:
    if not isinstance(args, dict) or not isinstance(args.get('commands'), dict) or not args['commands']:
        raise StepError('assert_language_startup: nonempty commands mapping is required')
    for command, bounds in args['commands'].items():
        if command not in COMMANDS or not isinstance(bounds, dict) or not bounds:
            raise StepError(f'assert_language_startup: invalid command/bounds: {command!r}')
        for bound, value in bounds.items():
            if bound not in {'min', 'max', 'equal', 'pending', 'fulfilled', 'rejected'}:
                raise StepError(f'assert_language_startup: unknown bound {bound!r}')
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise StepError('assert_language_startup: counts must be nonnegative integers')
    quiet = float(args.get('quiet_ms', 0)) / 1000
    if not 0 <= quiet <= 2:
        raise StepError('assert_language_startup: quiet_ms must be between 0 and 2000')
    return args['commands'], quiet


def mismatches(state: Any, expected: dict) -> list[str]:
    if not isinstance(state, dict) or not isinstance(state.get('events'), list):
        raise StepError('Language startup forwarding observer is unavailable')
    errors = []
    for command, bounds in expected.items():
        events = [event for event in state['events'] if event['command'] == command]
        counts = {status: sum(event['status'] == status for event in events)
                  for status in ('pending', 'fulfilled', 'rejected')}
        for bound, value in bounds.items():
            actual = counts[bound] if bound in counts else len(events)
            ok = actual >= value if bound == 'min' else actual <= value if bound == 'max' else actual == value
            if not ok:
                errors.append(f'{command}.{bound}: got {actual}, expected {value}')
    return errors


def assert_observation(ctx: Any, args: Any, read: Callable[[], Any]) -> str:
    expected, quiet = validate_expectations(args)
    deadline = time.monotonic() + 10
    stable_since = None
    state = None
    errors = []
    try:
        while time.monotonic() < deadline:
            state = read()
            errors = mismatches(state, expected)
            now = time.monotonic()
            if errors:
                stable_since = None
            else:
                if stable_since is None:
                    stable_since = now
                if now - stable_since >= quiet:
                    return 'Language startup invocation counts verified'
            time.sleep(.05)
        raise StepError('assert_language_startup: ' + '; '.join(errors or ['quiet interval not reached']))
    finally:
        index = len(list(ctx.case_dir.glob('language-startup-observation-*.json'))) + 1
        artifact = ctx.case_dir / f'language-startup-observation-{index:02}.json'
        artifact.write_text(json.dumps({'expected': expected, 'quietMs': quiet * 1000,
                                       'state': state, 'mismatches': errors}, indent=2) + '\n', encoding='utf-8')


def assert_browser(ctx: Any, args: Any) -> None:
    assert_observation(ctx, args, lambda: ctx.page.evaluate('window.__taomniQaLanguageStartup?.observe()'))


def assert_native(ctx: Any, args: Any) -> str:
    return assert_observation(ctx, args, lambda: ctx.session.execute(
        'return window.__taomniQaLanguageStartup?.observe() ?? null;'))
