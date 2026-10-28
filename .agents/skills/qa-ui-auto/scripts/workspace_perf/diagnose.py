"""Diagnose idle WebKit work in an original, functionally verified QA runtime.

CSS interventions are diagnostic only. They never establish performance acceptance
or replace the complete four-round comparison and its unchanged budgets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from workspace_perf import common
from workspace_perf.hosted import download_one, gh, linux_release_entry, validate_gate
from qa_ui_auto.provenance import source_identity


FRAME = '.taomni-main-canvas-frame'
PAINT_CORNERS = (
    FRAME + '{overflow:visible!important;position:relative!important}'
    + FRAME + '::after{content:"";position:absolute;inset:-1px;z-index:40;pointer-events:none;'
    'background:'
    'radial-gradient(circle at bottom right,transparent 8px,var(--taomni-chrome-border) 8px 9px,var(--taomni-chrome-bg) 9px) top left,'
    'radial-gradient(circle at bottom left,transparent 8px,var(--taomni-chrome-border) 8px 9px,var(--taomni-chrome-bg) 9px) top right,'
    'radial-gradient(circle at top right,transparent 8px,var(--taomni-chrome-border) 8px 9px,var(--taomni-chrome-bg) 9px) bottom left,'
    'radial-gradient(circle at top left,transparent 8px,var(--taomni-chrome-border) 8px 9px,var(--taomni-chrome-bg) 9px) bottom right;'
    'background-size:9px 9px;background-repeat:no-repeat;}'
)
VARIANTS = [
    ('no-css-animation', '*{animation:none!important;transition:none!important}'),
    ('square-frame', FRAME + '{border-radius:0!important;box-shadow:none!important}'),
    ('visible-frame-overflow', FRAME + '{overflow:visible!important}'),
    ('contained-frame', FRAME + '{contain:layout paint!important}'),
    ('composited-frame', FRAME + '{transform:translateZ(0)!important;isolation:isolate!important}'),
    ('clip-frame-overflow', FRAME + '{overflow:clip!important}'),
    ('no-frame-shadow', FRAME + '{box-shadow:none!important}'),
    ('square-frame-with-shadow', FRAME + '{border-radius:0!important}'),
    ('rounded-clip-path', FRAME + '{overflow:visible!important;clip-path:inset(0 round 9px)!important}'),
    ('rounded-clip-path-layer', FRAME + '{overflow:visible!important;clip-path:inset(0 round 9px)!important;transform:translateZ(0)!important}'),
    ('paint-corners', PAINT_CORNERS),
]


def phases():
    yield 'original-0', ''
    for index, (label, css) in enumerate(VARIANTS, 1):
        yield label, css
        yield 'original-' + str(index), ''


def resource_delta(before, after, seconds, ticks_per_second):
    previous = {(row['pid'], row['startTicks']): row['cpuTicks'] for row in before}
    ticks = sum(max(0, row['cpuTicks'] - previous.get(
        (row['pid'], row['startTicks']), row['cpuTicks'])) for row in after)
    assert seconds > 0 and ticks_per_second > 0 and after
    assert all(row['pssKiB'] is not None for row in after)
    return {'seconds': seconds, 'ticksPerSecond': ticks_per_second, 'cpuDeltaTicks': ticks,
            'cpuCoreFraction': ticks / ticks_per_second / seconds,
            'pssMiB': sum(row['pssKiB'] for row in after) / 1024,
            'before': before, 'after': after}


def prepare(args):
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    repository = os.environ['GITHUB_REPOSITORY']
    run = json.loads(gh('api', f'repos/{repository}/actions/runs/{args.functional_run}'))
    artifacts = json.loads(gh('api', f'repos/{repository}/actions/runs/{args.functional_run}/artifacts?per_page=100'))['artifacts']
    download_one(args.functional_run, artifacts, 'qa-selection-', out / 'selection')
    download_one(args.functional_run, artifacts, 'qa-summary-', out / 'summary')
    selection = json.loads((out / 'selection/selection.json').read_text())
    summary = json.loads((out / 'summary/ci-summary.json').read_text())
    validate_gate(run, selection, summary, selection['head'], selection['identity'])
    assert source_identity(Path.cwd()) == selection['identity']['source_sha256'], 'Diagnostic product source differs'
    entry = linux_release_entry(selection)
    download_one(args.functional_run, artifacts, 'runtime-' + entry['build_id'] + '-', out / 'runtime')
    checkout = Path(os.environ['RUNNER_TEMP']) / 'workspace-diagnostic-original'
    subprocess.run(['git', 'worktree', 'add', '--detach', str(checkout), selection['head']], check=True)
    # Import the original installer's original ROOT and runner. Do not authorize
    # a different diagnostic checkout by rewriting its selection or identity.
    install = (
        'import json,sys;from pathlib import Path;from ci_native_artifact import install;'
        'selection=json.loads(Path(sys.argv[1]).read_text());'
        'entry=next(row for row in selection["entries"] if row["id"]==sys.argv[3]);'
        'install(Path(sys.argv[2]),selection,entry)'
    )
    subprocess.run([sys.executable, '-c', install, str(out / 'selection/selection.json'),
                    str(out / 'runtime/runtime.tar.gz'), entry['id']], cwd=checkout,
                   env=dict(os.environ, PYTHONPATH=str(checkout / '.agents/skills/qa-ui-auto/scripts')),
                   check=True)
    common.retain(out / 'plan.json', {
        'checkout': str(checkout), 'functionalRun': args.functional_run,
        'originalHead': selection['head'], 'originalIdentity': selection['identity'],
        'diagnosticHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'diagnosticSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'purpose': 'Causal idle-rendering diagnosis only; no acceptance or revised budgets',
    })


COUNTERS = r"""
const original=window.requestAnimationFrame;
const state={requested:0,completed:0,callbackMs:0,stacks:{},mutations:0};
window.__WS_IDLE_DIAGNOSTIC__=state;
window.requestAnimationFrame=function(callback){
 state.requested++;
 if(state.requested<=20||state.requested%100===0){
  const stack=new Error().stack?.slice(0,2500)||'unknown';
  if(Object.keys(state.stacks).length<32||state.stacks[stack])state.stacks[stack]=(state.stacks[stack]||0)+1;
 }
 return original.call(this,function(timestamp){
  state.completed++;const start=performance.now();
  try{return Reflect.apply(callback,this,[timestamp]);}
  finally{state.callbackMs+=performance.now()-start;}
 });
};
const observer=new MutationObserver(rows=>{state.mutations+=rows.length});
observer.observe(document.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});
state.cleanup=()=>{observer.disconnect();window.requestAnimationFrame=original;};
return true;
"""
SNAPSHOT = r"""
const s=window.__WS_IDLE_DIAGNOSTIC__;
return {time:performance.now(),requested:s.requested,completed:s.completed,callbackMs:s.callbackMs,
 mutations:s.mutations,stacks:s.stacks,resizeTrace:window.__QA_UI_AUTO_RESIZE_TRACE__||null,
 frame:document.querySelector('.taomni-main-canvas-frame')?.getBoundingClientRect().toJSON(),
 terminals:document.querySelectorAll('[data-testid="terminal-pane"]').length,
 activeTerminals:document.querySelectorAll('[data-testid="terminal-pane"][data-terminal-active="true"]').length};
"""


def measure(args):
    # Restart Python with the original runtime's runner on PYTHONPATH. The
    # diagnostic script stays external to that immutable product checkout.
    plan = json.loads((args.out / 'plan.json').read_text())
    checkout = Path(plan['checkout'])
    if Path.cwd() != checkout:
        subprocess.run([sys.executable, str(Path(__file__).resolve()), 'measure', '--out', str(args.out)],
                       cwd=checkout, env=dict(os.environ, PYTHONPATH=str(checkout / '.agents/skills/qa-ui-auto/scripts')),
                       check=True)
        return
    from native_build import verify_identity
    from tauri_webdriver import NativeHarness
    from ci_desktop import Desktop
    from qa_ui_auto.native_steps import NativeStepContext, VERBS

    binary = checkout / 'src-tauri/target/qa-ui-auto/release/taomni'
    identity = verify_identity(binary)
    start_source = source_identity(checkout)
    assert start_source == plan['originalIdentity']['source_sha256'] == identity['source_sha256']
    assert identity['identifier'] == 'com.taomni.app.qa' and identity['profile'] == 'release'
    root = args.out / 'diagnostic'
    root.mkdir()
    cfg = {'app': {'mode': 'native', 'base_url': 'tauri://localhost', 'native_binary': str(binary)},
           'webdriver': {'host': '127.0.0.1', 'port': 4994, 'native_port': 4995,
                         'native_driver': '/usr/bin/WebKitWebDriver', 'tauri_driver': shutil.which('tauri-driver'),
                         'startup_timeout': 45}, 'worker': {'parallel': 1}}
    result = {'plan': plan, 'binaryIdentity': identity, 'phases': [], 'completed': False}
    save = lambda: common.retain(root / 'result.json', result)
    try:
        with Desktop(args.out / 'desktop', [], 'ubuntu-22.04-x11'):
            with NativeHarness(cfg, root) as harness:
                session = harness.create_session()
                ctx = NativeStepContext(session, root, cfg)
                try:
                    VERBS['vault_first_run'](ctx, 'qa-isolated-idle-diagnostic')
                    session.execute("localStorage.setItem('taomni.qa.resizeTrace.v1','1');return true;")
                    VERBS['reload_window'](ctx, None)
                    session.find('[data-testid="side-tab-sessions"]', timeout=30)
                    common.click(session, '[data-testid="side-tab-sessions"]')
                    for index in range(24):
                        common.click(session, '[data-testid="new-local-terminal"]')
                        common.until(session, f'document.querySelectorAll(\'[data-testid="terminal-pane"]\').length==={index+1} && !!document.querySelector(\'[data-testid="terminal-pane"][data-terminal-active="true"][data-terminal-ready="true"]\')', 45)
                    session.execute(COUNTERS)
                    for label, css in phases():
                        session.execute('let el=document.getElementById("ws-idle-diagnostic-style");'
                                        'if(!el){el=document.createElement("style");el.id="ws-idle-diagnostic-style";document.head.append(el);}'
                                        'el.textContent=' + json.dumps(css) + ';return true;')
                        time.sleep(1)
                        before_js = session.execute(SNAPSHOT)
                        before = common.owned_processes(binary)
                        started = time.monotonic()
                        time.sleep(5)
                        after = common.owned_processes(binary)
                        elapsed = time.monotonic() - started
                        after_js = session.execute(SNAPSHOT)
                        assert before_js['terminals'] == after_js['terminals'] == 24
                        assert before_js['activeTerminals'] == after_js['activeTerminals'] == 1
                        row = {'label': label, 'css': css, 'resources': resource_delta(
                            before, after, elapsed, os.sysconf('SC_CLK_TCK')),
                            'before': before_js, 'after': after_js}
                        result['phases'].append(row)
                        save()
                        session.screenshot(root / (label + '.png'))
                        print(json.dumps({'phase': label, 'cpu': row['resources']['cpuCoreFraction'],
                                          'raf': after_js['requested']-before_js['requested'],
                                          'mutations': after_js['mutations']-before_js['mutations']}).strip(), flush=True)
                    session.execute('window.__WS_IDLE_DIAGNOSTIC__.cleanup();document.getElementById("ws-idle-diagnostic-style")?.remove();return true;')
                    for count in range(24, 0, -1):
                        common.click(session, '[data-testid="tab-item"][data-tab-type="terminal"] [data-testid="tab-close"]', last=True)
                        common.until(session, f'document.querySelectorAll(\'[data-testid="tab-item"][data-tab-type="terminal"]\').length==={count-1}')
                    VERBS['assert_no_runtime_errors'](ctx, None)
                    result['completed'] = True
                except BaseException:
                    try:
                        session.screenshot(root / 'failure.png')
                    except Exception as diagnostic:
                        result['screenshotError'] = str(diagnostic)
                    raise
                finally:
                    common.close_session(session, result)
    except BaseException as error:
        result['error'] = str(error)
        raise
    finally:
        result['sourceStable'] = start_source == source_identity(checkout)
        save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['prepare', 'measure'])
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--functional-run')
    args = parser.parse_args()
    args.out = args.out.resolve()
    if args.operation == 'prepare':
        assert args.functional_run and args.functional_run.isdigit()
        prepare(args)
    else:
        measure(args)


if __name__ == '__main__':
    main()
