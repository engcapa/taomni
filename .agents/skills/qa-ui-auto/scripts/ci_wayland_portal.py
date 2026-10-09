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


def owned_portal(pid: int, runtime: str, proc: Path = Path("/proc")) -> bool:
    try:
        process = proc / str(pid)
        return ((process / "exe").resolve(strict=True).name == "xdg-desktop-portal-gnome"
                and (b"XDG_RUNTIME_DIR=" + runtime.encode())
                in (process / "environ").read_bytes().split(b"\0"))
    except OSError:
        return False


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
    previous = None
    while True:
        try:
            desktop = Atspi.get_desktop(0)
            for index in range(desktop.get_child_count()):
                app = desktop.get_child_at_index(index)
                if not owned_portal(app.get_process_id(), runtime):
                    continue
                nodes = list(descendants(app))
                records = [{"name": n.get_name(), "role": n.get_role_name(),
                            "showing": n.get_state_set().contains(Atspi.StateType.SHOWING),
                            "enabled": n.get_state_set().contains(Atspi.StateType.ENABLED)} for n in nodes]
                if not any(r["showing"] and r["name"] in {"Remote Desktop", "Screen Share", "Share Screen"}
                           for r in records):
                    continue
                actions = []
                # With one monitor GNOME selects it automatically. Handle the
                # unselected preview too, using its accessible toggle action.
                for node, record in zip(nodes, records):
                    if not record["showing"] or not record["enabled"]:
                        continue
                    state = node.get_state_set()
                    if (record["role"] in {"toggle button", "check box", "switch"}
                            and not state.contains(Atspi.StateType.CHECKED)
                            and "remember" not in record["name"].lower()):
                        action = node.get_action_iface()
                        if action and action.get_n_actions() and action.do_action(0):
                            actions.append({"name": record["name"], "action": "select"})
                    if record["name"].replace("_", "") in {"Share", "Allow"} and record["role"] in {"push button", "button"}:
                        action = node.get_action_iface()
                        if action and action.get_n_actions() and action.do_action(0):
                            actions.append({"name": record["name"], "action": "consent"})
                observation = {"pid": app.get_process_id(), "tree": records, "actions": actions}
                signature = json.dumps(observation, sort_keys=True)
                if signature != previous:
                    previous = signature
                    with args.log.open("a", encoding="utf-8") as stream:
                        stream.write(json.dumps({"time": time.time(), **observation}) + "\n")
        except Exception as error:
            with args.log.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps({"time": time.time(), "error": str(error)}) + "\n")
        time.sleep(0.25)


if __name__ == "__main__":
    main()
