"""Accept real GNOME portal dialogs in the disposable CI desktop through AT-SPI.

The product still creates its own portal session and receives real PipeWire
frames. Only dialogs owned by this runtime's GNOME portal process are touched.
Every observed dialog and action is retained; no permission database is seeded.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time


def owned_process(pid: int, runtime: str, executable: str, proc: Path = Path("/proc")) -> bool:
    try:
        process = proc / str(pid)
        return ((process / "exe").resolve(strict=True).name == executable
                and (b"XDG_RUNTIME_DIR=" + runtime.encode())
                in (process / "environ").read_bytes().split(b"\0"))
    except OSError:
        return False


def owned_portal(pid: int, runtime: str, proc: Path = Path("/proc")) -> bool:
    return owned_process(pid, runtime, "xdg-desktop-portal-gnome", proc)


def consent_kind(executable: str, records: list[dict]) -> str | None:
    names = {r["name"] for r in records if r["showing"]}
    if executable == "xdg-desktop-portal-gnome" and names.intersection({
            "Remote Desktop", "Screen Share", "Share Screen", "Screenshot"}):
        return "portal"
    # Non-interactive Screenshot first asks org.gnome.Shell's AccessDialog.
    # This is a Shell modal actor, absent from MetaWindow's toplevel list.
    if executable == "gnome-shell" and names.intersection({
            "Allow Apps to Take Screenshots?", "Allow to Take a Screenshot?",
            "Allow Taomni to Take Screenshots?", "Allow Taomni to Take a Screenshot?",
            "Allow Taomni QA to Take Screenshots?", "Allow Taomni QA to Take a Screenshot?",
            "Allow com.taomni.app.qa to Take Screenshots?",
            "Allow com.taomni.app.qa to Take a Screenshot?"}):
        return "screenshot-access"
    return None


def descendants(node, depth=0):
    if depth > 15:
        return
    yield node
    for index in range(min(node.get_child_count(), 200)):
        child = node.get_child_at_index(index)
        if child is not None:
            yield from descendants(child, depth + 1)


def main():
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--ready", type=Path, required=True)
    args = parser.parse_args()
    runtime = os.environ["XDG_RUNTIME_DIR"]
    Atspi.init()
    Atspi.set_timeout(1000, 1000)
    args.ready.write_text(json.dumps({"transport": "AT-SPI", "runtime": runtime}))
    previous = {}
    while True:
        try:
            desktop = Atspi.get_desktop(0)
            for index in range(desktop.get_child_count()):
                app = desktop.get_child_at_index(index)
                if app is None:
                    continue
                pid = app.get_process_id()
                executable = next((name for name in ("xdg-desktop-portal-gnome", "gnome-shell")
                                   if owned_process(pid, runtime, name)), None)
                if executable is None:
                    continue
                nodes = list(descendants(app))
                records = [{"name": n.get_name(), "role": n.get_role_name(),
                            "showing": n.get_state_set().contains(Atspi.StateType.SHOWING),
                            "enabled": n.get_state_set().contains(Atspi.StateType.ENABLED)} for n in nodes]
                kind = consent_kind(executable, records)
                actions = []
                # With one monitor GNOME selects it automatically. Handle the
                # unselected preview too, using its accessible toggle action.
                for node, record in zip(nodes, records):
                    if kind is None or not record["showing"] or not record["enabled"]:
                        continue
                    state = node.get_state_set()
                    if (kind == "portal" and record["role"] in {"toggle button", "check box", "switch"}
                            and not state.contains(Atspi.StateType.CHECKED)
                            and "remember" not in record["name"].lower()):
                        action = node.get_action_iface()
                        if action and action.get_n_actions() and action.do_action(0):
                            actions.append({"name": record["name"], "action": "select"})
                    labels = {"Allow"} if kind == "screenshot-access" else {"Share", "Allow"}
                    if record["name"].replace("_", "") in labels and record["role"] in {"push button", "button"}:
                        action = node.get_action_iface()
                        if action and action.get_n_actions() and action.do_action(0):
                            actions.append({"name": record["name"], "action": "consent"})
                observation = {"pid": pid, "executable": executable, "kind": kind,
                               "tree": records, "actions": actions}
                signature = json.dumps(observation, sort_keys=True)
                if signature != previous.get(pid):
                    previous[pid] = signature
                    with args.log.open("a", encoding="utf-8") as stream:
                        stream.write(json.dumps({"time": time.time(), **observation}) + "\n")
        except Exception as error:
            with args.log.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps({"time": time.time(), "error": str(error)}) + "\n")
        time.sleep(0.25)


if __name__ == "__main__":
    main()
