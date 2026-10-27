"""Prepared native benchmark; run only after functional gates are complete.

Inputs: CHECKOUT LABEL. Current runner is intentionally shared between revisions;
source and original QA binary identity are still checked against each checkout.
"""

from pathlib import Path
import datetime, hashlib, json, os, shlex, shutil, signal, subprocess, sys, time, traceback
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkout", type=Path, required=True)
parser.add_argument("--out", type=Path, required=True)
parser.add_argument("--label", required=True)
args = parser.parse_args()
checkout = args.checkout.resolve()
label = args.label
out = args.out.resolve()
root = out / label
root.mkdir(parents=True, exist_ok=False)
os.chdir(checkout)
from workspace_perf import common
from tauri_webdriver import NativeHarness
from native_build import verify_identity
from qa_ui_auto.native_steps import NativeStepContext, VERBS

binary = checkout / "src-tauri/target/qa-ui-auto/release/taomni"
identity = verify_identity(binary)
cfg = {
    "app": {
        "base_url": "tauri://localhost",
        "mode": "native",
        "native_binary": str(binary),
    },
    "webdriver": {
        "host": "127.0.0.1",
        "port": 4994,
        "native_port": 4995,
        "native_driver": "/usr/bin/WebKitWebDriver",
        "tauri_driver": shutil.which("tauri-driver"),
        "startup_timeout": 45,
    },
    "worker": {"parallel": 1},
}
assert cfg["webdriver"]["tauri_driver"], "Native adapter must be installed"

result = {
    "label": label,
    "checkout": str(checkout),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
    "binaryIdentity": identity,
    "started": datetime.datetime.now().isoformat(),
    "metrics": {},
    "events": [],
    "sourceStable": False,
    "harnessSha256": {
        Path(f).name: hashlib.sha256(Path(f).read_bytes()).hexdigest()
        for f in Path(__file__).resolve().parent.glob("*.py")
    },
}
from qa_ui_auto.provenance import source_identity

start_source = source_identity(checkout)
assert (
    identity["source_sha256"] == start_source
), "Binary was built from a different source"
assert (
    identity["build_inputs"]["profile"] == "release"
), "Matched release profiles required"
result["measurementSource"] = start_source

q = common.q
until = common.until
timed = common.timed
save = lambda: common.retain(root / "result.json", result)


def event(text):
    result["events"].append({"at": time.monotonic(), "message": text})
    save()
    print(label, text, flush=True)


def click(s, selector):
    return s.execute("document.querySelector(" + q(selector) + ").click();return true;")


def ctx_for(s, folder):
    return NativeStepContext(s, folder, cfg)


def screenshots(s, name):
    s.screenshot(root / (name + ".png"))


def echo(s, ctx, name, count=10):
    samples = []
    for i in range(count):
        marker = f"WS_PERF_{name}_{i}_{time.time_ns()}"
        start = time.monotonic()
        VERBS["terminal_input"](
            ctx,
            {
                "selector": '[data-testid="terminal-pane"][data-terminal-active="true"] .xterm-helper-textarea',
                "text": "echo " + marker,
                "submit": True,
            },
        )
        until(
            s,
            "(document.querySelector('[data-testid=\"terminal-pane\"][data-terminal-active=\"true\"]')?.getAttribute('data-terminal-text')||'').split(/\\r?\\n/).some(line=>line.trim()==="
            + q(marker)
            + ")",
        )
        samples.append((time.monotonic() - start) * 1000)
    result["metrics"][name] = {
        "samplesMs": samples,
        **common.stats(samples),
        "clock": "host monotonic; includes WebDriver input and QA mirrored-text observation",
    }
    save()


def sessions():
    folder = root / "sessions"
    folder.mkdir()
    known = []
    try:
        with NativeHarness(cfg, folder) as harness:
            s = harness.create_session()
            ctx = ctx_for(s, folder)
            try:
                VERBS["vault_first_run"](ctx, "qa-isolated-workspace-performance")
                s.execute(
                    "document.querySelector('[data-testid=\"side-tab-sessions\"]')?.click();return true;"
                )
                until(
                    s,
                    "!!document.querySelector('[data-testid=\"new-local-terminal\"]')",
                )
                create = []
                for i in range(24):
                    sample = timed(
                        s,
                        "document.querySelector('[data-testid=\"new-local-terminal\"]').click()",
                        f'document.querySelectorAll(\'[data-testid="terminal-pane"]\').length==={i+1} && !!document.querySelector(\'[data-testid="terminal-pane"][data-terminal-active="true"][data-terminal-ready="true"]\')',
                        45,
                    )
                    create.append(sample)
                    result["metrics"]["sessionCreate"] = {"samples": create}
                    save()
                    if i == 0:
                        echo(s, ctx, "echoAt1")
                result["environment"] = s.execute(
                    'return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,userAgent:navigator.userAgent,terminalRect:document.querySelector(\'[data-testid="terminal-pane"][data-terminal-active="true"]\')?.getBoundingClientRect().toJSON()};'
                )
                event("24 real PTY sessions ready")
                result["metrics"]["idle24"] = common.resource_sample(binary)
                tabs = s.execute(
                    "return [...document.querySelectorAll('[data-testid=\"tab-item\"][data-tab-type=\"terminal\"]')].map(el=>el.getAttribute('data-tab-id'));"
                )
                assert len(tabs) == 24, tabs
                switches = []
                for i, tab_id in enumerate(tabs + list(reversed(tabs))):
                    selector = '[data-testid="tab-item"][data-tab-id=' + q(tab_id) + "]"
                    switches.append(
                        timed(
                            s,
                            "document.querySelector(" + q(selector) + ").click()",
                            "document.querySelector("
                            + q(selector)
                            + ")?.getAttribute('data-active')==='true' && !!document.querySelector('[data-testid=\"terminal-pane\"][data-terminal-active=\"true\"][data-terminal-ready=\"true\"]')",
                        )
                    )
                result["metrics"]["sessionSwitch"] = {"samples": switches}
                save()
                echo(s, ctx, "echoAt24")
                producer = folder / "producer.py"
                receipt = folder / "producer.json"
                marker = "WS_PERF_OUTPUT_FINISHED"
                producer.write_text(
                    "import json,os,time\nfrom pathlib import Path\nstart=time.perf_counter_ns()\nchunk=b'P'*511+b'\\n'\nfor i in range(4096):\n view=memoryview(chunk)\n while view:\n  n=os.write(1,view);view=view[n:]\nend=time.perf_counter_ns()\nPath("
                    + repr(str(receipt))
                    + ").write_text(json.dumps({'bytes':2097152,'elapsedMs':(end-start)/1e6}))\nos.write(1,b'\\r\\n"
                    + marker
                    + "\\r\\n')\n"
                )
                started = time.monotonic()
                VERBS["terminal_input"](
                    ctx,
                    {
                        "selector": '[data-testid="terminal-pane"][data-terminal-active="true"] .xterm-helper-textarea',
                        "text": "python3 " + shlex.quote(str(producer)),
                        "submit": True,
                    },
                )
                until(
                    s,
                    "(document.querySelector('[data-testid=\"terminal-pane\"][data-terminal-active=\"true\"]')?.getAttribute('data-terminal-text')||'').split(/\\r?\\n/).some(line=>line.trim()==="
                    + q(marker)
                    + ")",
                    180,
                )
                result["metrics"]["output2MiB"] = {
                    "observedElapsedMs": (time.monotonic() - started) * 1000,
                    "producer": json.loads(receipt.read_text()),
                    "limit": "QA full-history mirror is included; not production mirror=false throughput",
                }
                known = common.owned_processes(binary)
                result["metrics"]["beforeCloseProcesses"] = known
                save()
                screenshots(s, "sessions24")
                for count in range(24, 0, -1):
                    s.execute(
                        '[...document.querySelectorAll(\'[data-testid="tab-item"][data-tab-type="terminal"] [data-testid="tab-close"]\')].at(-1).click();return true;'
                    )
                    until(
                        s,
                        f'document.querySelectorAll(\'[data-testid="tab-item"][data-tab-type="terminal"]\').length==={count-1}',
                    )
                time.sleep(3)
                result["metrics"]["afterTabsClose"] = common.resource_sample(binary)
                save()
                event("session lifecycle observations retained")
            except BaseException:
                try:
                    screenshots(s, "failure")
                except Exception:
                    pass
                raise
            finally:
                known = list(
                    {
                        (p["pid"], p["startTicks"]): p
                        for p in known + common.owned_processes(binary)
                    }.values()
                )
                s.close()
        time.sleep(1)
        table = common.process_table()
        result["metrics"]["afterSessionExitProcesses"] = [
            p
            for p in known
            if p["pid"] in table and table[p["pid"]]["startTicks"] == p["startTicks"]
        ]
    finally:
        result["metrics"]["cleanupOwnedProcesses"] = common.cleanup_owned(known)
        save()


try:
    sessions()
    from workspace_perf import explorer

    result["metrics"]["explorer"] = explorer.run(
        binary=binary,
        cfg=cfg,
        root=root,
        NativeHarness=NativeHarness,
        NativeStepContext=NativeStepContext,
        VERBS=VERBS,
        common=common,
        event=event,
    )
    result["passed"] = True
except BaseException as exc:
    result["passed"] = False
    result["error"] = str(exc)
    result["traceback"] = traceback.format_exc()
    raise
finally:
    result["finished"] = datetime.datetime.now().isoformat()
    result["sourceStable"] = start_source == source_identity(checkout)
    save()
