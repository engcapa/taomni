"""Real xterm shared-atlas pixel regression, not a buffer-text oracle."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from .deadline import budget_time as time
from .steps import StepError

SCRIPT = Path(__file__).with_suffix('.js').read_text(encoding='utf-8')
HEADER = 'REF-0123456789 中文字形 ┌─┐'


def expression(action: str, iteration: int = 0) -> str:
    return '(function(action, iteration){\n' + SCRIPT + '\n})(' + json.dumps(action) + ',' + str(iteration) + ')'


def compare_pixels(reference: Path, actual: Path, boxes: list[dict], viewport: dict,
                   folder: Path, label: str) -> list[dict]:
    from PIL import Image, ImageChops, ImageStat

    with Image.open(reference) as original, Image.open(actual) as current:
        if original.size != current.size:
            raise StepError('Terminal viewport changed during pixel comparison')
        scale_x, scale_y = original.width / viewport['width'], original.height / viewport['height']
        metrics = []
        for index, box in enumerate(boxes):
            bounds = (round(box['x'] * scale_x), round(box['y'] * scale_y),
                      round((box['x'] + box['width']) * scale_x),
                      round((box['y'] + box['height']) * scale_y))
            before, after = original.crop(bounds).convert('RGB'), current.crop(bounds).convert('RGB')
            delta = ImageChops.difference(before, after)
            before.save(folder / f'{label}-{index}-expected.png')
            after.save(folder / f'{label}-{index}-actual.png')
            delta.save(folder / f'{label}-{index}-difference.png')
            # Average each 4x4 block: insensitive to a single antialiasing pixel,
            # but rejects misplaced/blank/wrong-colour glyphs (upstream limit 14).
            signature = delta.resize((max(1, delta.width // 4), max(1, delta.height // 4)),
                                     Image.Resampling.BOX)
            maximum = max(channel[1] for channel in signature.getextrema())
            metrics.append({'terminal': index + 1, 'bounds': bounds,
                            'maxBlockChannelDifference': maximum,
                            'meanChannelDifference': ImageStat.Stat(delta).mean,
                            'passed': maximum <= 14})
        return metrics


def run_probe(case_dir: Path, evaluate: Callable, screenshot: Callable, args: Any) -> str:
    if args is not None:
        raise StepError('terminal_rendering_probe takes null')
    folder = Path(case_dir)
    path = folder / 'terminal-rendering.json'
    record: dict = {'passed': False, 'stages': []}
    installed = False

    def call(action: str, iteration: int = 0):
        return evaluate(expression(action, iteration))

    def settled():
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            observed = call('observe')
            if not observed['pending']:
                return observed
            time.sleep(.1)
        raise StepError('Real terminal write/render did not settle')

    try:
        deadline = time.monotonic() + 60
        while not call('ready'):
            if time.monotonic() >= deadline:
                raise StepError('Three native terminal shells did not reach idle readiness')
            time.sleep(.2)
        call('prepare')
        installed = True
        before = settled()
        record['before'] = before
        viewport = evaluate('({width: innerWidth, height: innerHeight})')
        reference = folder / 'terminal-rendering-reference.png'
        screenshot(reference)
        for scenario in ('clear', 'merge'):
            if scenario == 'clear':
                call('clear')
                settled()
            else:
                for iteration in range(12):
                    call('merge', iteration)
                    settled()
            call('repaint-siblings')
            after = settled()
            image = folder / f'terminal-rendering-{scenario}.png'
            screenshot(image)
            pixels = compare_pixels(reference, image, before['cells'], viewport, folder, scenario)
            stage = {'scenario': scenario, 'observation': after, 'pixels': pixels,
                     'passed': after['shared'] and after['sameTerms']
                     and after['sessions'] == before['sessions']
                     and after['headers'] == [HEADER, HEADER]
                     and after['cells'] == before['cells']
                     and (scenario != 'merge' or after['removals'] >= 4)
                     and all(item['passed'] for item in pixels)}
            record['stages'].append(stage)
            path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if not all(stage['passed'] for stage in record['stages']):
            raise StepError('Shared WebGL atlas corrupted sibling glyph pixels while buffer text remained intact; '
                            'see terminal-rendering.json and expected/actual/difference PNGs')
        record['passed'] = True
        return 'Two sibling terminal headers retain real glyph pixels and session identities after atlas clear/merge'
    except BaseException as error:
        record['error'] = str(error)
        raise
    finally:
        if installed:
            try:
                call('cleanup')
            except Exception as error:
                record['cleanupError'] = str(error)
                if record['passed']:
                    record['passed'] = False
                    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
                    raise StepError('Could not restore terminal rendering fixture') from error
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def register_native(verbs: dict) -> None:
    def native(ctx, args):
        return run_probe(ctx.case_dir, lambda expr: ctx.session.execute('return ' + expr),
                         ctx.session.screenshot, args)
    verbs['terminal_rendering_probe'] = native
