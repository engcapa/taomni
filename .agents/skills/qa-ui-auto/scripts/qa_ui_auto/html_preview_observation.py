"""Trusted iframe point input and independent HTML network fixture receipts.

No iframe DOM reads, native commands, product handlers or store mutations. Points
belong to the fixture contract; parent geometry is hit-tested before one actual
pointer dispatch. Missing capabilities are errors, never successful skips.
"""
from __future__ import annotations

import json
import math
import os
import platform
import subprocess
from pathlib import Path
from typing import Any

from .deadline import budget_time as time
from .steps import StepError

STATES = {"blocked", "app", "custom", "none", "invalid", "slow-started", "cancelled", "external-cancelled", "scripts-off"}
TARGETS = {"next", "external", "spoof-invalid", "spoof-valid", "slow", "security"}

GEOMETRY = """(() => {
 const frames=Array.from(document.querySelectorAll('[data-testid="html-frame"]')).filter(el=>el.getBoundingClientRect().width>0);
 if(frames.length!==1)throw new Error('Expected one visible HTML frame');
 const frame=frames[0], r=frame.getBoundingClientRect(), style=getComputedStyle(frame);
 const x=r.left+POINT_X*r.width/frame.offsetWidth, y=r.top+POINT_Y*r.height/frame.offsetHeight;
 const hit=document.elementFromPoint(x,y);
 return {x,y,frame:r.toJSON(),viewport:{width:innerWidth,height:innerHeight},src:frame.getAttribute('src'),sandbox:frame.getAttribute('sandbox'),hit:hit===frame,transform:style.transform};
})()"""

# Passive wrapper only: records calls and forwards the exact original arguments,
# this binding, return value and rejection without modification or replay.
INSTALL = r"""(() => {
 if(window.__QA_HTML_PASSIVE__)return true;
 const state={calls:[],native:!!window.__TAURI_INTERNALS__,source:'passive-forwarding-only',hooks:[]};
 const refs=[];
 const hook=(object,key,inspect)=>{
   if(!object||typeof object[key]!=='function')return false;
   const original=object[key];
   const wrapper=function(...args){inspect(args);return Reflect.apply(original,this,args)};
   try{object[key]=wrapper}catch(_){}
   if(object[key]!==wrapper)return false;
   state.hooks.push(key);refs.push(()=>object[key]===wrapper);return true;
 };
 const parse=args=>{try{const message=typeof args[0]==='string'?JSON.parse(args[0]):args[0];if(message?.cmd==='open_external_url')state.calls.push({command:message.cmd,url:message.payload?.url,time:performance.now()})}catch(_){}};
 const fetchHook=hook(window,'fetch',args=>{const url=String(args[0]?.url||args[0]);if(/(?:ipc:\/\/|https?:\/\/ipc.localhost\/).*open_external_url/.test(url))state.calls.push({command:'open_external_url',transport:'fetch',time:performance.now()})});
 const fallbackHook=hook(window.webkit?.messageHandlers?.ipc,'postMessage',parse)||hook(window.chrome?.webview,'postMessage',parse);
 hook(window,'open',args=>state.calls.push({command:'window.open',url:String(args[0]),time:performance.now()}));
 state.covered=!state.native||(fetchHook&&fallbackHook);
 window.__QA_HTML_PASSIVE__={state,read:()=>({...state,intact:refs.every(check=>check())})};return state.covered;
})()"""
READ = """(() => ({console:Array.from(document.querySelectorAll('[data-testid="html-console"]')).map(el=>el.textContent).join('\\n'),frame:Array.from(document.querySelectorAll('[data-testid="html-frame"]')).map(el=>({src:el.getAttribute('src'),sandbox:el.getAttribute('sandbox')})),dialog:!!document.querySelector('[data-testid="html-external-dialog"]'),passive:window.__QA_HTML_PASSIVE__?.read()||null}))()"""


def validate_click(args: Any) -> dict:
    if not isinstance(args, dict) or set(args) != {"target"} or args.get("target") not in TARGETS:
        raise StepError("html_preview_click: expected registered fixture target")
    return args


def validate_observe(args: Any) -> dict:
    if not isinstance(args, dict) or set(args) != {"state"} or args.get("state") not in STATES:
        raise StepError("assert_html_network: expected registered observation state")
    return args


def manifest(ctx: Any, mode: str) -> dict:
    path = Path(ctx.case_dir) / "html-network-fixture.json"
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schema") != "qa.html-network.v1" or value.get("mode") != mode:
        raise StepError("HTML fixture receipt is missing or mismatched")
    log = Path(value["serverLog"]).resolve()
    if log.parent != Path(ctx.case_dir).resolve():
        raise StepError("HTML observation log is outside current case")
    return value


def evaluate(ctx: Any, expression: str, mode: str):
    return ctx.session.execute("return " + expression + ";") if mode == "native" else ctx.page.evaluate(expression)


def save(ctx: Any, receipt: dict) -> None:
    with (Path(ctx.case_dir) / "html-preview-observations.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(receipt, ensure_ascii=False) + "\n")


def click(ctx: Any, args: Any, mode: str) -> str:
    args = validate_click(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no iframe pointer input"
    fixture = manifest(ctx, mode)
    x, y = fixture["targets"][args["target"]]
    expression = GEOMETRY.replace("POINT_X", str(x)).replace("POINT_Y", str(y))
    receipt = dict(mode=mode, action="iframe-pointer", target=args["target"], dispatched=False)
    try:
        first = evaluate(ctx, expression, mode)
        if not isinstance(first, dict) or not first.get("hit") or first.get("sandbox") != "allow-scripts":
            raise StepError("HTML frame point is occluded or sandbox differs")
        time.sleep(.1)
        second = evaluate(ctx, expression, mode)
        if not second.get("hit") or first.get("src") != second.get("src"):
            raise StepError("HTML frame changed before pointer delivery")
        for key in ("x", "y"):
            if not isinstance(second.get(key), (int, float)) or not math.isfinite(second[key]) or abs(first[key] - second[key]) > 1:
                raise StepError("HTML frame geometry is unstable")
        if not 0 < second["x"] < second["viewport"]["width"] or not 0 < second["y"] < second["viewport"]["height"]:
            raise StepError("HTML fixture target is outside the viewport")
        receipt["geometry"] = second
        if mode == "native" and platform.system() == "Darwin":
            env = os.environ.copy()
            env.update(QA_HTML_APPLICATION=str(Path(ctx.session.application).resolve()),
                       QA_HTML_CLIENT_X=str(second["x"]), QA_HTML_CLIENT_Y=str(second["y"]),
                       QA_HTML_CLIENT_WIDTH=str(second["viewport"]["width"]), QA_HTML_CLIENT_HEIGHT=str(second["viewport"]["height"]))
            result = subprocess.run(["osascript", "-l", "JavaScript", str(Path(__file__).with_name("html_preview_macos.js"))],
                                    env=env, capture_output=True, text=True, timeout=30)
            receipt["helper"] = {"stdout": result.stdout, "stderr": result.stderr, "exit": result.returncode}
            if result.returncode:
                raise StepError("HTML macOS OS pointer unavailable; no synthetic fallback: " + result.stderr.strip())
            receipt["transport"] = "CoreGraphics OS pointer with executable-owned Accessibility WebArea"
            receipt["dispatched"] = True
        elif mode == "native":
            from native_pointer import click_viewport_point
            receipt["transport"] = "one trusted W3C viewport pointer sequence into the native WebView"
            receipt["dispatched"] = True
            click_viewport_point(ctx.session, round(second["x"]), round(second["y"]))
        else:
            receipt["transport"] = "Playwright trusted mouse at parent-observed frame point"
            receipt["dispatched"] = True
            ctx.page.mouse.click(second["x"], second["y"])
        return "HTML fixture pointer dispatched once; testcase postcondition remains authoritative"
    finally:
        save(ctx, receipt)


def read_events(path: str) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line]


def route_matches(events: list[dict], phase: str, expected: str) -> bool:
    requests = [event for event in events if event.get("event") == "request" and event.get("path") == "/" + phase + "/probe.json"]
    origins = [event for event in requests if event.get("route") == "origin"]
    proxies = [event for event in requests if event.get("route") in ("app", "custom")]
    return bool(origins) and all(event.get("forwarded") == expected for event in origins) and (
        not proxies if expected == "direct" else bool(proxies) and all(event["route"] == expected and event.get("absolute") for event in proxies)
    ) and all(not event.get("auth") and not event.get("cookie") for event in requests)


def matched(state: str, events: list[dict], ui: dict, mode: str) -> bool:
    console = ui.get("console", "")
    if state == "blocked":
        return "HTML_QA SETTLED default" in console and "HTML_QA FETCH BLOCKED" in console and not any(event.get("event") == "request" and event.get("path") == "/default/probe.json" for event in events)
    if state in ("app", "custom", "none"):
        if mode != "native":
            raise StepError("Proxy routing cannot be certified by browser stubs")
        phase = "default" if state == "app" else state
        return "HTML_QA SETTLED " + phase in console and route_matches(events, phase, "direct" if state == "none" else state)
    if state == "invalid":
        return "HTML_QA SETTLED invalid" in console and ("HTML_QA FETCH 403 " in console or "HTML_QA FETCH BLOCKED" in console) and not any(event.get("event") == "request" and event.get("path") == "/invalid/probe.json" for event in events)
    if state in ("slow-started", "cancelled"):
        expected = "stream-started" if state == "slow-started" else "cancelled"
        return any(event.get("event") == expected and event.get("route") == "origin" and event.get("path") == "/slow/stream" for event in events)
    if state == "external-cancelled":
        passive = ui.get("passive")
        if not passive or not passive.get("covered") or not passive.get("intact") or (mode == "native" and not passive.get("native")):
            raise StepError("External cancellation requires intact passive transport observers; unavailable is not a pass")
        return not ui.get("dialog") and not (passive or {}).get("calls") and not any("external" in event.get("path", "") for event in events)
    if state == "scripts-off":
        frames = ui.get("frame", [])
        return len(frames) == 1 and frames[0].get("sandbox") == "allow-scripts" and "HTML_QA READY scripts" not in console and not any(event.get("event") == "request" and event.get("path") == "/scripts/probe.json" for event in events)
    return False


def observe(ctx: Any, args: Any, mode: str) -> str:
    args = validate_observe(args)
    if getattr(ctx, "dry_run", False):
        return "dry-run; no HTML boundary observation"
    fixture = manifest(ctx, mode)
    if args["state"] == "blocked":
        evaluate(ctx, INSTALL, mode)
    started, stable_since = time.monotonic(), None
    receipt = dict(mode=mode, state=args["state"], passed=False, samples=[])
    try:
        while time.monotonic() - started < 15:
            events, ui = read_events(fixture["serverLog"]), evaluate(ctx, READ, mode)
            okay = matched(args["state"], events, ui, mode)
            receipt["samples"].append(dict(elapsedMs=(time.monotonic() - started) * 1000, eventCount=len(events), matched=okay))
            if okay:
                stable_since = stable_since if stable_since is not None else time.monotonic()
                if time.monotonic() - stable_since >= 1.1:
                    receipt.update(passed=True, events=events, ui=ui)
                    return f"HTML {args['state']} independent server/UI postcondition held for 1100ms"
            else:
                stable_since = None
            time.sleep(.1)
        receipt.update(events=events, ui=ui)
        raise StepError(f"HTML boundary state {args['state']} did not match independent server/UI observations")
    finally:
        save(ctx, receipt)


def browser_click(ctx, args):
    return click(ctx, args, "browser")


def native_click(ctx, args):
    return click(ctx, args, "native")


def browser_observe(ctx, args):
    return observe(ctx, args, "browser")


def native_observe(ctx, args):
    return observe(ctx, args, "native")
