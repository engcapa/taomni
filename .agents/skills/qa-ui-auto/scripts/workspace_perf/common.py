"""Shared, passive timing and owned-process observations for the redesign comparison."""

from pathlib import Path
import json, math, os, signal, sys, time


def close_session(session, diagnostics):
    original = sys.exception()
    try:
        session.close()
    except BaseException as cleanup:
        diagnostics["sessionCleanupError"] = {
            "type": type(cleanup).__name__, "message": str(cleanup),
            "originalError": str(original) if original is not None else None,
        }
        if original is None:
            raise


def q(value):
    return json.dumps(value)


def click_action(selector, *, last=False):
    # SVGElement has no HTMLElement.click() in WebKit. Use the same bubbling
    # DOM event for both revisions and both element types; this remains a
    # renderer timing probe, not trusted OS pointer input.
    target = (
        "[...document.querySelectorAll(" + q(selector) + ")].at(-1)"
        if last else "document.querySelector(" + q(selector) + ")"
    )
    return (
        "(()=>{const target=" + target + ";"
        "if(!target)throw new Error(" + q("Missing performance control: " + selector) + ");"
        "target.dispatchEvent(new MouseEvent('click',"
        "{bubbles:true,cancelable:true,composed:true,view:window,detail:1,button:0}));})()"
    )


def click(session, selector, *, last=False):
    return session.execute(click_action(selector, last=last) + ";return true;")


def until(session, expression, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = session.execute("return (" + expression + ");")
        if last:
            return last
        time.sleep(0.02)
    raise TimeoutError(
        f"Observation timeout after {timeout}s: {expression}; last={last!r}"
    )


def timed(session, action, predicate, timeout=30):
    # The host polling interval does not enter the timing sample. Both revisions
    # use the same DOM event dispatch, condition observation and two animation frames.
    session.execute(
        """
 const state={started:performance.now(),done:false,conditionAt:null,elapsedMs:null};
 window.__WS_REDESIGN_PERF__=state;
 let observer=null,interval=null,finished=false;
 const check=()=>{
   if(finished||!("""
        + predicate
        + """))return;
   finished=true;state.conditionAt=performance.now()-state.started;
   observer?.disconnect();clearInterval(interval);
   requestAnimationFrame(()=>requestAnimationFrame(()=>{
     state.elapsedMs=performance.now()-state.started;state.done=true;
   }));
 };
 observer=new MutationObserver(check);
 observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
 interval=setInterval(check,10);
 """
        + action
        + """;check();return true;
 """
    )
    until(session, "window.__WS_REDESIGN_PERF__?.done", timeout)
    return session.execute("return window.__WS_REDESIGN_PERF__;")


def process_table():
    result = {}
    for path in Path("/proc").glob("[0-9]*"):
        try:
            fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
            status = (path / "status").read_text()
            rec = {
                "pid": int(path.name),
                "ppid": int(fields[1]),
                "startTicks": int(fields[19]),
                "cpuTicks": int(fields[11]) + int(fields[12]),
                "command": (path / "comm").read_text().strip(),
                "exe": str((path / "exe").resolve()),
            }
            result[rec["pid"]] = rec
        except (OSError, ValueError, IndexError):
            continue
    return result


def owned_processes(binary):
    table = process_table()
    parents = [p["pid"] for p in table.values() if p["exe"] == str(binary.resolve())]
    for pid in parents:
        parents.extend(
            p["pid"]
            for p in table.values()
            if p["ppid"] == pid and p["pid"] not in parents
        )
    result = [table[p] for p in parents]
    for rec in result:
        try:
            rollup = Path("/proc") / str(rec["pid"]) / "smaps_rollup"
            rec["pssKiB"] = int(
                next(
                    line.split()[1]
                    for line in rollup.read_text().splitlines()
                    if line.startswith("Pss:")
                )
            )
        except (OSError, StopIteration):
            rec["pssKiB"] = None
    return result


def resource_sample(binary, seconds=5):
    before = owned_processes(binary)
    started = time.monotonic()
    time.sleep(seconds)
    after = owned_processes(binary)
    elapsed = time.monotonic() - started
    assert after and all(
        p["pssKiB"] is not None for p in after
    ), "Complete run-owned PSS observations required"
    previous = {(p["pid"], p["startTicks"]): p["cpuTicks"] for p in before}
    delta = sum(
        max(0, p["cpuTicks"] - previous.get((p["pid"], p["startTicks"]), p["cpuTicks"]))
        for p in after
    )
    return {
        "seconds": elapsed,
        "cpuCoreFraction": delta / os.sysconf("SC_CLK_TCK") / elapsed,
        "pssMiB": sum(p["pssKiB"] or 0 for p in after) / 1024,
        "processes": after,
    }


def retain(path, record):
    path.write_text(json.dumps(record, indent=2) + "\n")


def stats(samples):
    vals = sorted(samples)
    return (
        {
            "n": len(vals),
            "p50": vals[max(0, math.ceil(len(vals) * 0.5) - 1)],
            "p95": vals[max(0, math.ceil(len(vals) * 0.95) - 1)],
            "max": max(vals),
        }
        if vals
        else {"n": 0}
    )


def cleanup_owned(known):
    # Only pids observed as descendants of this exact isolated application can be
    # cleaned, and their kernel start ticks must still match after parent exit.
    table = process_table()
    remaining = [
        p
        for p in known
        if p["pid"] in table and p["startTicks"] == table[p["pid"]]["startTicks"]
    ]
    for p in reversed(remaining):
        try:
            os.kill(p["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass
    time.sleep(0.5)
    table = process_table()
    for p in reversed(remaining):
        if p["pid"] in table and table[p["pid"]]["startTicks"] == p["startTicks"]:
            try:
                os.kill(p["pid"], signal.SIGKILL)
            except ProcessLookupError:
                pass
    return remaining
